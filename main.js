const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    ipcMain,
    nativeImage,
    screen,
    safeStorage,
    shell,
    globalShortcut,
    nativeTheme,
    powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { KeitoApi, KeitoError, WEB_URL } = require('./src/keito-api');
const { JiraApi, JiraError, normalizeSite } = require('./src/jira-api');

// electron-updater is optional in development (npm start works without it).
let autoUpdater = null;
try {
    ({ autoUpdater } = require('electron-updater'));
} catch {
    /* not installed */
}

const WIN_W = 400;
const WIN_H = 620;
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+K';
const isMac = process.platform === 'darwin';
const IDLE_CHOICES = [5, 10, 15, 20, 30, 60];
const MIN_HOURS_CHOICES = [4, 5, 6, 7, 7.5, 8];
const SNOOZE_MS = 15 * 60e3;

let tray = null;
let win = null;
let api = null;
let me = null;
let running = null; // { entry, fetchedAt }
let trayTicker = null;
let runningPoll = null;
let idlePoll = null;
let reminderPoll = null;

// ---------------------------------------------------------------- config

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
        return {};
    }
}
function writeConfig(config) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function prefs() {
    const config = readConfig();
    return {
        timeFormat: config.timeFormat || 'hm',
        trayShowsToday: config.trayShowsToday !== false,
        accent: config.accent || null,
        idleEnabled: config.idleEnabled !== false,
        idleMinutes: IDLE_CHOICES.includes(config.idleMinutes) ? config.idleMinutes : 10,
        remindStart: config.remindStart !== false,
        remindStartTime: validTime(config.remindStartTime) ? config.remindStartTime : '09:15',
        remindEnd: config.remindEnd !== false,
        remindEndTime: validTime(config.remindEndTime) ? config.remindEndTime : '16:45',
        remindMinHours: MIN_HOURS_CHOICES.includes(config.remindMinHours) ? config.remindMinHours : 6,
        workdays: Array.isArray(config.workdays)
            ? config.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
            : [1, 2, 3, 4, 5],
    };
}
function validTime(time) {
    return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function loadCredentials() {
    const envToken = process.env.KEITO_API_KEY;
    const envAccount = process.env.KEITO_ACCOUNT_ID;
    if (envToken && envAccount) return { token: envToken.trim(), accountId: envAccount.trim() };
    const config = readConfig();
    if (!config.token || !config.accountId) return null;
    try {
        const token = config.tokenEncrypted
            ? safeStorage.decryptString(Buffer.from(config.token, 'base64'))
            : config.token;
        return { token, accountId: config.accountId };
    } catch {
        return null;
    }
}

function saveCredentials(token, accountId) {
    const config = readConfig();
    if (safeStorage.isEncryptionAvailable()) {
        config.token = safeStorage.encryptString(token).toString('base64');
        config.tokenEncrypted = true;
    } else {
        config.token = token;
        config.tokenEncrypted = false;
    }
    config.accountId = accountId;
    writeConfig(config);
}

function clearCredentials() {
    const config = readConfig();
    delete config.token;
    delete config.tokenEncrypted;
    delete config.accountId;
    writeConfig(config);
    api = null;
    me = null;
    running = null;
    updateTray();
}

// ---------------------------------------------------------------- jira

let jira = null;
let jiraMe = null;

const encrypt = (plainText) =>
    safeStorage.isEncryptionAvailable()
        ? { value: safeStorage.encryptString(plainText).toString('base64'), encrypted: true }
        : { value: plainText, encrypted: false };
const decrypt = (stored, encrypted) => (encrypted ? safeStorage.decryptString(Buffer.from(stored, 'base64')) : stored);

function loadJira() {
    const jiraConfig = readConfig().jira;
    if (!jiraConfig?.site || !jiraConfig?.email || !jiraConfig?.token) return null;
    try {
        return new JiraApi({
            site: jiraConfig.site,
            email: jiraConfig.email,
            token: decrypt(jiraConfig.token, jiraConfig.tokenEncrypted),
        });
    } catch {
        return null;
    }
}

function jiraStatus() {
    const jiraConfig = readConfig().jira;
    return { configured: !!jira, site: jiraConfig?.site, email: jiraConfig?.email, name: jiraMe?.name };
}

async function connect(creds) {
    const client = new KeitoApi(creds);
    const identity = await client.me();
    api = client;
    me = identity;
    return identity;
}

// ---------------------------------------------------------------- tray

function formatHours(hours) {
    if (prefs().timeFormat === 'decimal') return hours.toFixed(2);
    const mins = Math.max(0, Math.round(hours * 60));
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

// ---- Live duration of a running timer
//
// Keito's `hours` on a running entry does not track the running segment live (it was seen to
// return the time before the timer started), so we count from `timer_started_at` instead:
//   live = base + (now - timerStartedAt)
// Whether `hours` already includes the running segment is learned from two fetches of the same
// segment, and remembered. Until then we assume it does not (matches what we observed).

const seenRunning = new Map(); // entryId -> { startMs, hours, at, liveStartMs, liveBaseHours }
let hoursIncludeRunning; // true | false | undefined — loaded from config once the app is ready

function learnHoursModel(value) {
    if (hoursIncludeRunning === value) return;
    hoursIncludeRunning = value;
    const config = readConfig();
    config.hoursIncludeRunning = value;
    writeConfig(config);
}

/** Adds liveStartMs + liveBaseHours to a running entry so everyone can compute the live duration. */
function annotateRunning(entry, fetchedAt) {
    if (!entry || !entry.isRunning) return entry;
    const prev = seenRunning.get(entry.id);
    const startMs = entry.timerStartedAt ? Date.parse(entry.timerStartedAt) : NaN;

    if (!Number.isFinite(startMs) || startMs > fetchedAt + 120e3) {
        // No usable start time: keep counting from when we first saw this run.
        if (prev && Math.abs(prev.hours - entry.hours) < 1 / 120)
            Object.assign(entry, { liveStartMs: prev.liveStartMs, liveBaseHours: prev.liveBaseHours });
        else Object.assign(entry, { liveStartMs: fetchedAt, liveBaseHours: entry.hours });
        seenRunning.set(entry.id, {
            startMs: NaN,
            hours: entry.hours,
            at: fetchedAt,
            liveStartMs: entry.liveStartMs,
            liveBaseHours: entry.liveBaseHours,
        });
        return entry;
    }

    const segment = Math.max(0, (fetchedAt - startMs) / 3.6e6);
    if (entry.hours < segment - 1 / 60) learnHoursModel(false); // can't include it if it's smaller
    if (prev && prev.startMs === startMs && fetchedAt - prev.at > 90e3) {
        const elapsedHours = (fetchedAt - prev.at) / 3.6e6;
        const hoursDelta = entry.hours - prev.hours;
        if (hoursDelta > elapsedHours * 0.5) learnHoursModel(true);
        else if (Math.abs(hoursDelta) < 1 / 120) learnHoursModel(false);
    }
    const base = hoursIncludeRunning === true ? Math.max(0, entry.hours - segment) : entry.hours;
    Object.assign(entry, { liveStartMs: startMs, liveBaseHours: base });
    seenRunning.set(entry.id, {
        startMs,
        hours: entry.hours,
        at: fetchedAt,
        liveStartMs: startMs,
        liveBaseHours: base,
    });
    return entry;
}

function liveHours(runningState) {
    const entry = runningState.entry;
    if (entry.liveStartMs) return entry.liveBaseHours + Math.max(0, Date.now() - entry.liveStartMs) / 3.6e6;
    return entry.hours + (Date.now() - runningState.fetchedAt) / 3.6e6;
}

let todayTotal = null; // hours of today's stopped entries, pushed by the renderer

function icon(isRunning) {
    const image = nativeImage.createFromPath(
        path.join(__dirname, 'assets', isRunning ? 'trayRunningTemplate.png' : 'trayTemplate.png'),
    );
    image.setTemplateImage(true);
    return image;
}

function updateTray() {
    if (!tray) return;
    const isRunning = !!running;
    tray.setImage(icon(isRunning));
    let title = '';
    if (isRunning) title = ` ${formatHours(liveHours(running))}`;
    else if (todayTotal !== null && prefs().trayShowsToday && api) title = ` ${formatHours(todayTotal)}`;
    if (isMac) tray.setTitle(title, { fontType: 'monospacedDigit' });
    const project = running?.entry.projectName;
    tray.setToolTip(
        idlePending
            ? 'Keito · je was even weg — klik om de idle-tijd te verwerken'
            : isRunning
              ? `Keito · ${project || 'timer loopt'} · ${formatHours(liveHours(running))}`
              : 'Keito',
    );
}

async function refreshRunning() {
    if (!api || !me) return;
    try {
        const list = await api.running(me.userId);
        const at = Date.now();
        running = list[0] ? { entry: annotateRunning(list[0], at), fetchedAt: at } : null;
    } catch {
        // Keep the last known state when offline.
    }
    updateTray();
}

function setRunningFromEntries(entries, fetchedAt) {
    const runningEntry = entries.find((entry) => entry.isRunning);
    if (runningEntry) running = { entry: runningEntry, fetchedAt };
    updateTray();
}

function buildContextMenu() {
    return Menu.buildFromTemplate([
        { label: 'Open Keito Bar', accelerator: TOGGLE_SHORTCUT, click: () => showWindow() },
        { label: 'Open Keito in browser', click: () => shell.openExternal(WEB_URL) },
        { type: 'separator' },
        ...(running
            ? [
                  {
                      label: 'Stop timer',
                      click: async () => {
                          try {
                              await api.stop(running.entry.id);
                          } catch {}
                          await refreshRunning();
                          send('data:changed');
                      },
                  },
              ]
            : []),
        ...(update.state === 'ready'
            ? [
                  {
                      label: `Herstart om bij te werken naar ${update.version}`,
                      click: () => autoUpdater.quitAndInstall(false, true),
                  },
              ]
            : []),
        {
            label: 'Instellingen…',
            click: () => {
                showWindow();
                send('nav', 'settings');
            },
        },
        { type: 'separator' },
        { label: 'Stoppen', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]);
}

// ---------------------------------------------------------------- idle detection
//
// While a timer runs we watch the system idle time (no mouse/keyboard), screen lock and sleep.
// When the user comes back after at least `idleMinutes`, the popover opens with the choice to
// remove that time, book it elsewhere, or keep it — like Harvest.

let awaySince = null; // ms timestamp the user went away
let idlePending = null; // { entryId, projectName, taskName, from, to, hours }

function markAway(at) {
    if (!running || !prefs().idleEnabled) return;
    awaySince = awaySince ? Math.min(awaySince, at) : at;
}

function checkIdle() {
    if (!running || !prefs().idleEnabled) {
        awaySince = null;
        return;
    }
    const idleSec = powerMonitor.getSystemIdleTime();
    const thresholdSec = prefs().idleMinutes * 60;
    if (idleSec >= thresholdSec) {
        markAway(Date.now() - idleSec * 1000);
    } else if (awaySince && idleSec < 20 && powerMonitor.getSystemIdleState(1) !== 'locked') {
        const from = awaySince;
        awaySince = null;
        userReturned(from, Date.now() - idleSec * 1000);
    }
}

async function userReturned(from, to) {
    if (idlePending) return; // one question at a time
    if ((to - from) / 60000 < prefs().idleMinutes) return;
    await refreshRunning();
    if (!running) return; // timer was stopped elsewhere meanwhile
    const started = running.entry.timerStartedAt ? Date.parse(running.entry.timerStartedAt) : NaN;
    if (Number.isFinite(started) && started > from) from = started; // timer started while away
    const hours = Math.min((to - from) / 3.6e6, liveHours(running));
    if (hours * 60 < prefs().idleMinutes) return;
    idlePending = {
        entryId: running.entry.id,
        projectName: running.entry.projectName,
        clientName: running.entry.clientName,
        taskName: running.entry.taskName,
        from,
        to,
        hours,
    };
    updateTray();
    showWindow();
    send('idle', idlePending);
}

async function resolveIdle(action) {
    const pending = idlePending;
    if (!pending) return { action: 'none' };
    const client = requireApi();
    if (action === 'keep') {
        idlePending = null;
        updateTray();
        return { action };
    }
    if (!['remove-continue', 'remove-stop', 'reassign'].includes(action))
        throw new KeitoError('validation', 'Onbekende keuze.');

    // Stop to freeze the hours, take the idle time off, restart if we keep going.
    const stopped = await client.stop(pending.entryId);
    const keepGoing = action !== 'remove-stop';
    let updateError = null;
    try {
        const hours = Math.max(0, Math.round((stopped.hours - pending.hours) * 10000) / 10000);
        await client.update(pending.entryId, { hours });
    } catch (error) {
        updateError = error;
    } finally {
        if (keepGoing) await client.restart(pending.entryId).catch(() => {});
    }
    idlePending = null;
    running = null;
    await refreshRunning();
    if (updateError)
        throw new KeitoError(
            updateError.kind || 'unknown',
            `Idle-tijd kon niet worden afgehaald: ${updateError.message}`,
        );
    return { action, hours: pending.hours, from: pending.from, to: pending.to };
}

// ---------------------------------------------------------------- day reminders
//
// Start: on a workday after `remindStartTime`, no timer running → offer to start one.
// End:   after `remindEndTime`, today's total below `remindMinHours` → offer to fill in hours.
// Both wait until you're actually at the computer, show once a day, and can be snoozed 15 min.

let nudgePending = null; // { type: 'start'|'end', ... }

const padZero = (number) => String(number).padStart(2, '0');
function toLocalIsoDate(date = new Date()) {
    return `${date.getFullYear()}-${padZero(date.getMonth() + 1)}-${padZero(date.getDate())}`;
}
const minutesOf = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
};

function reminderState() {
    const state = readConfig().reminderState;
    return state && state.date === toLocalIsoDate() ? state : { date: toLocalIsoDate() };
}
function saveReminderState(state) {
    const config = readConfig();
    config.reminderState = state;
    writeConfig(config);
}

async function todaysEntries() {
    const today = toLocalIsoDate();
    const entries = await api.entries({ userId: me.userId, from: today, to: today });
    const at = Date.now();
    entries.forEach((entry) => annotateRunning(entry, at));
    return entries;
}
const totalOf = (entries) =>
    entries.reduce(
        (total, entry) => total + (entry.isRunning ? liveHours({ entry: entry, fetchedAt: Date.now() }) : entry.hours),
        0,
    );

async function lastUsedEntry() {
    const from = new Date();
    from.setDate(from.getDate() - 14);
    const list = await api.entries({ userId: me.userId, from: toLocalIsoDate(from), to: toLocalIsoDate() });
    list.sort((left, right) =>
        (right.spentDate + (right.createdAt || '')).localeCompare(left.spentDate + (left.createdAt || '')),
    );
    const entry = list.find((candidate) => candidate.projectId && candidate.taskId);
    return entry
        ? {
              projectId: entry.projectId,
              taskId: entry.taskId,
              projectName: entry.projectName,
              clientName: entry.clientName,
              taskName: entry.taskName,
          }
        : null;
}

let checkingReminders = false;
async function checkReminders() {
    if (!api || !me || nudgePending || idlePending || checkingReminders) return;
    const preferences = prefs();
    const now = new Date();
    if (!preferences.workdays.includes(now.getDay())) return;
    if (!preferences.remindStart && !preferences.remindEnd) return;
    // Only when you're at the computer: not locked, input in the last 90 s.
    if (powerMonitor.getSystemIdleState(90) !== 'active') return;

    const mins = now.getHours() * 60 + now.getMinutes();
    const state = reminderState();
    const snoozed = (key) => state[key] && state[key] > Date.now();
    checkingReminders = true;
    try {
        if (
            preferences.remindEnd &&
            !state.endDone &&
            mins >= minutesOf(preferences.remindEndTime) &&
            !snoozed('endSnooze')
        ) {
            const entries = await todaysEntries();
            const total = totalOf(entries);
            state.endDone = true;
            saveReminderState(state);
            if (total < preferences.remindMinHours - 1 / 120) {
                openNudge({
                    type: 'end',
                    total,
                    minHours: preferences.remindMinHours,
                    running: entries.some((entry) => entry.isRunning),
                });
            }
            return;
        }
        if (
            preferences.remindStart &&
            !state.startDone &&
            mins >= minutesOf(preferences.remindStartTime) &&
            (!preferences.remindEnd || mins < minutesOf(preferences.remindEndTime)) &&
            !snoozed('startSnooze')
        ) {
            await refreshRunning();
            state.startDone = true;
            saveReminderState(state);
            if (running) return; // already tracking — nothing to say
            const entries = await todaysEntries();
            openNudge({ type: 'start', total: totalOf(entries), suggest: await lastUsedEntry().catch(() => null) });
        }
    } catch {
        // offline etc. — try again on the next tick
    } finally {
        checkingReminders = false;
    }
}

function openNudge(nudge) {
    nudgePending = { ...nudge, firstName: (me?.name || '').split(' ')[0] };
    showWindow();
    send('nudge', nudgePending);
}

function resolveNudge(action) {
    const nudge = nudgePending;
    if (!nudge) return null;
    nudgePending = null;
    const state = reminderState();
    const key = nudge.type === 'start' ? 'start' : 'end';
    if (action === 'snooze') {
        state[`${key}Done`] = false;
        state[`${key}Snooze`] = Date.now() + SNOOZE_MS;
    } else {
        state[`${key}Answered`] = true;
    }
    saveReminderState(state);
    return true;
}

// ---------------------------------------------------------------- auto-update
//
// Release builds (npm run release) are signed + notarized and published to GitHub Releases.
// The app checks at startup and every 4 hours, downloads in the background and installs
// on the next restart (or right away via "Herstart om bij te werken").

const update = { state: 'idle', version: null, error: null }; // idle|checking|downloading|ready|none|error|unavailable

function updaterAvailable() {
    return !!autoUpdater && app.isPackaged;
}

function setUpdate(patch) {
    Object.assign(update, patch);
    send('update', { ...update, current: app.getVersion() });
}

function setupUpdater() {
    if (!updaterAvailable()) {
        update.state = 'unavailable';
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => setUpdate({ state: 'downloading', version: info.version }));
    autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
    autoUpdater.on('update-downloaded', (info) => setUpdate({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (error) => setUpdate({ state: 'error', error: friendlyUpdateError(error) }));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(check, 15_000);
    setInterval(check, 4 * 3600_000);
}

function friendlyUpdateError(error) {
    const message = String(error?.message || error || '');
    if (/code signature|signature.*valid|not signed|SecCode/i.test(message)) {
        return 'Deze versie kan zichzelf niet bijwerken (niet gesigneerd). Installeer één keer de nieuwste DMG handmatig.';
    }
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|net::/i.test(message)) return 'Geen verbinding om op updates te controleren.';
    if (/404/.test(message)) return 'Nog geen release gevonden op GitHub.';
    return 'Controleren op updates mislukte.';
}

// ---------------------------------------------------------------- window

function createWindow() {
    win = new BrowserWindow({
        width: WIN_W,
        height: WIN_H,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        ...(isMac
            ? { vibrancy: 'popover', visualEffectState: 'active', transparent: true, backgroundColor: '#00000000' }
            : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f24' : '#f6f6f7' }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('blur', () => {
        if (!win.webContents.isDevToolsOpened()) win.hide();
    });
    // Links open in the default browser, never inside the popover.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function positionWindow() {
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const workArea = display.workArea;
    let windowX = Math.round(trayBounds.x + trayBounds.width / 2 - WIN_W / 2);
    let windowY;
    if (trayBounds.y < workArea.y + workArea.height / 2)
        windowY = Math.round(trayBounds.y + trayBounds.height + 4); // menubar on top (macOS)
    else windowY = Math.round(trayBounds.y - WIN_H - 4); // taskbar at the bottom (Windows)
    windowX = Math.min(Math.max(windowX, workArea.x + 8), workArea.x + workArea.width - WIN_W - 8);
    windowY = Math.min(Math.max(windowY, workArea.y), workArea.y + workArea.height - WIN_H);
    win.setPosition(windowX, windowY, false);
}

function showWindow() {
    if (!win) return;
    positionWindow();
    win.show();
    win.focus();
    send('window:shown');
}

function toggleWindow() {
    if (win.isVisible()) win.hide();
    else showWindow();
}

function send(channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- IPC

function wrap(handler) {
    return async (_event, ...args) => {
        try {
            return { ok: true, data: await handler(...args) };
        } catch (error) {
            const kind = error instanceof KeitoError || error instanceof JiraError ? error.kind : 'unknown';
            return { ok: false, error: { kind, message: error.message || 'Er ging iets mis.' } };
        }
    };
}

function requireApi() {
    if (!api || !me) throw new KeitoError('auth', 'Nog niet verbonden met Keito.');
    return api;
}

function registerIpc() {
    ipcMain.handle(
        'auth:status',
        wrap(async () => {
            if (me) return { connected: true, me };
            const creds = loadCredentials();
            if (!creds) return { connected: false };
            const identity = await connect(creds);
            refreshRunning();
            return { connected: true, me: identity };
        }),
    );

    ipcMain.handle(
        'auth:save',
        wrap(async ({ token, accountId }) => {
            token = String(token || '').trim();
            accountId = String(accountId || '').trim();
            if (!token.startsWith('kto_')) throw new KeitoError('validation', 'Een Keito API key begint met kto_.');
            if (!accountId || /[\s/?#]/.test(accountId))
                throw new KeitoError('validation', 'Vul een geldige Company ID in.');
            const identity = await connect({ token, accountId });
            saveCredentials(token, accountId);
            refreshRunning();
            return { connected: true, me: identity };
        }),
    );

    ipcMain.handle(
        'auth:clear',
        wrap(async () => {
            clearCredentials();
            return true;
        }),
    );

    ipcMain.handle(
        'prefs:get',
        wrap(async () => ({
            ...prefs(),
            launchAtLogin: app.getLoginItemSettings().openAtLogin,
            shortcut: TOGGLE_SHORTCUT,
            encrypted: readConfig().tokenEncrypted === true,
        })),
    );

    ipcMain.handle(
        'prefs:set',
        wrap(async (patch) => {
            const config = readConfig();
            if (patch.timeFormat) config.timeFormat = patch.timeFormat === 'decimal' ? 'decimal' : 'hm';
            if (typeof patch.trayShowsToday === 'boolean') config.trayShowsToday = patch.trayShowsToday;
            if (typeof patch.idleEnabled === 'boolean') config.idleEnabled = patch.idleEnabled;
            if (IDLE_CHOICES.includes(Number(patch.idleMinutes))) config.idleMinutes = Number(patch.idleMinutes);
            for (const key of ['remindStart', 'remindEnd'])
                if (typeof patch[key] === 'boolean') config[key] = patch[key];
            for (const key of ['remindStartTime', 'remindEndTime']) if (validTime(patch[key])) config[key] = patch[key];
            if (MIN_HOURS_CHOICES.includes(Number(patch.remindMinHours)))
                config.remindMinHours = Number(patch.remindMinHours);
            if (Array.isArray(patch.workdays))
                config.workdays = [...new Set(patch.workdays.map(Number))].filter((day) => day >= 0 && day <= 6).sort();
            if (
                ['remindStart', 'remindEnd', 'remindStartTime', 'remindEndTime', 'remindMinHours', 'workdays'].some(
                    (key) => key in patch,
                )
            ) {
                // Changing the schedule re-arms today's reminders that haven't been answered yet.
                const state = config.reminderState;
                if (state && state.date === toLocalIsoDate()) {
                    if (!state.startAnswered) delete state.startDone;
                    if (!state.endAnswered) delete state.endDone;
                }
            }
            if (patch.accent === null) delete config.accent;
            else if (typeof patch.accent === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accent))
                config.accent = patch.accent.toLowerCase();
            writeConfig(config);
            if (typeof patch.launchAtLogin === 'boolean')
                app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
            updateTray();
            return prefs();
        }),
    );

    ipcMain.handle(
        'projects:list',
        wrap(async () => requireApi().projects()),
    );
    ipcMain.handle(
        'tasks:list',
        wrap(async (projectId) => requireApi().tasks(projectId)),
    );

    ipcMain.handle(
        'entries:list',
        wrap(async ({ from, to }) => {
            const entries = await requireApi().entries({ userId: me.userId, from, to });
            const fetchedAt = Date.now();
            entries.forEach((entry) => annotateRunning(entry, fetchedAt));
            setRunningFromEntries(entries, fetchedAt);
            return { entries, fetchedAt };
        }),
    );

    ipcMain.handle(
        'entry:create',
        wrap(async (body) => {
            let entry;
            try {
                entry = await requireApi().create(body);
            } catch (error) {
                // If Keito rejects the Jira link, still save the hours (the ticket key is in the notes anyway).
                if (!(body.external_reference && error instanceof KeitoError && error.kind === 'validation'))
                    throw error;
                const { external_reference, ...rest } = body;
                entry = await requireApi().create(rest);
            }
            await refreshRunning();
            return entry;
        }),
    );
    ipcMain.handle(
        'entry:update',
        wrap(async ({ id, body }) => {
            const entry = await requireApi().update(id, body);
            await refreshRunning();
            return entry;
        }),
    );
    ipcMain.handle(
        'entry:stop',
        wrap(async (id) => {
            const entry = await requireApi().stop(id);
            running = null;
            await refreshRunning();
            return entry;
        }),
    );
    ipcMain.handle(
        'entry:restart',
        wrap(async (id) => {
            const entry = await requireApi().restart(id);
            await refreshRunning();
            return entry;
        }),
    );
    ipcMain.handle(
        'entry:delete',
        wrap(async (id) => {
            await requireApi().remove(id);
            await refreshRunning();
            return true;
        }),
    );

    // ---- Jira
    ipcMain.handle(
        'jira:status',
        wrap(async () => jiraStatus()),
    );

    ipcMain.handle(
        'jira:save',
        wrap(async ({ site, email, token }) => {
            site = normalizeSite(site);
            email = String(email || '').trim();
            token = String(token || '').trim();
            if (!email.includes('@'))
                throw new JiraError('validation', 'Vul het e-mailadres van je Atlassian-account in.');
            if (!token) throw new JiraError('validation', 'Vul een Jira API token in.');
            const client = new JiraApi({ site, email, token });
            jiraMe = await client.myself();
            jira = client;
            const encryptedToken = encrypt(token);
            const config = readConfig();
            config.jira = { site, email, token: encryptedToken.value, tokenEncrypted: encryptedToken.encrypted };
            writeConfig(config);
            return jiraStatus();
        }),
    );

    ipcMain.handle(
        'jira:clear',
        wrap(async () => {
            const config = readConfig();
            delete config.jira;
            writeConfig(config);
            jira = null;
            jiraMe = null;
            return jiraStatus();
        }),
    );

    ipcMain.handle(
        'jira:search',
        wrap(async ({ query, projectKey }) => {
            if (!jira) throw new JiraError('auth', 'Jira is nog niet gekoppeld (Instellingen).');
            return jira.search(query, { projectKey });
        }),
    );

    ipcMain.on('jira:tokens', () => shell.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens'));

    ipcMain.on('jira:open', (_event, key) => {
        if (jira && typeof key === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/i.test(key))
            shell.openExternal(jira.issueUrl(key));
    });

    // ---- Updates
    ipcMain.handle(
        'update:status',
        wrap(async () => ({ ...update, current: app.getVersion() })),
    );
    ipcMain.handle(
        'update:check',
        wrap(async () => {
            if (!updaterAvailable()) return { ...update, current: app.getVersion() };
            setUpdate({ state: 'checking', error: null });
            await autoUpdater
                .checkForUpdates()
                .catch((error) => setUpdate({ state: 'error', error: friendlyUpdateError(error) }));
            return { ...update, current: app.getVersion() };
        }),
    );
    ipcMain.on('update:install', () => {
        if (updaterAvailable() && update.state === 'ready') setImmediate(() => autoUpdater.quitAndInstall(false, true));
    });

    // ---- Day reminders
    ipcMain.handle(
        'nudge:get',
        wrap(async () => nudgePending),
    );
    ipcMain.handle(
        'nudge:resolve',
        wrap(async (action) => resolveNudge(action)),
    );
    ipcMain.handle(
        'nudge:test',
        wrap(async (type) => {
            // "Probeer" button in settings: show the reminder now, regardless of time/state.
            requireApi();
            const entries = await todaysEntries();
            const total = totalOf(entries);
            if (type === 'end')
                openNudge({
                    type: 'end',
                    total,
                    minHours: prefs().remindMinHours,
                    running: entries.some((entry) => entry.isRunning),
                    test: true,
                });
            else openNudge({ type: 'start', total, suggest: await lastUsedEntry().catch(() => null), test: true });
            return true;
        }),
    );

    // ---- Idle
    ipcMain.handle(
        'idle:get',
        wrap(async () => idlePending),
    );
    ipcMain.handle(
        'idle:resolve',
        wrap(async (action) => resolveIdle(action)),
    );

    ipcMain.on('tray:today', (_event, hours) => {
        todayTotal = typeof hours === 'number' && Number.isFinite(hours) ? hours : null;
        updateTray();
    });
    ipcMain.on('window:hide', () => win?.hide());
    ipcMain.on('open:web', (_event, subPath) =>
        shell.openExternal(WEB_URL + (typeof subPath === 'string' && subPath.startsWith('/') ? subPath : '')),
    );
    ipcMain.on('app:quit', () => app.quit());
}

// ---------------------------------------------------------------- lifecycle

// The UI is Dutch: use Dutch formats everywhere (24-hour time inputs, dates), also on an English macOS.
app.commandLine.appendSwitch('lang', 'nl-NL');

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());

    app.whenReady().then(() => {
        if (isMac) app.dock.hide();
        registerIpc();
        jira = loadJira();
        setupUpdater();
        hoursIncludeRunning = readConfig().hoursIncludeRunning;
        createWindow();

        tray = new Tray(icon(false));
        tray.setIgnoreDoubleClickEvents(true);
        tray.on('click', toggleWindow);
        tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
        updateTray();

        globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow);

        trayTicker = setInterval(updateTray, 15_000);
        runningPoll = setInterval(refreshRunning, 120_000); // pick up timers started elsewhere (web, Raycast)
        idlePoll = setInterval(checkIdle, 10_000);
        reminderPoll = setInterval(checkReminders, 30_000);
        setTimeout(checkReminders, 20_000);
        powerMonitor.on('unlock-screen', () => setTimeout(checkReminders, 5000));
        for (const eventName of ['suspend', 'lock-screen']) powerMonitor.on(eventName, () => markAway(Date.now()));
        for (const eventName of ['resume', 'unlock-screen'])
            powerMonitor.on(eventName, () => setTimeout(checkIdle, 1500));

        const creds = loadCredentials();
        if (creds)
            connect(creds)
                .then(refreshRunning)
                .catch(() => {});
        else setTimeout(showWindow, 400); // first run: open straight into setup
    });

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        clearInterval(trayTicker);
        clearInterval(runningPoll);
        clearInterval(idlePoll);
        clearInterval(reminderPoll);
    });
    app.on('window-all-closed', (event) => event.preventDefault());
}
