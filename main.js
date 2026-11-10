const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage, shell, globalShortcut, nativeTheme, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { KeitoApi, KeitoError, WEB_URL } = require('./src/keito-api');
const { JiraApi, JiraError, normalizeSite } = require('./src/jira-api');

// electron-updater is optional in development (npm start works without it).
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* not installed */ }

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
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function prefs() {
  const c = readConfig();
  return {
    timeFormat: c.timeFormat || 'hm',
    trayShowsToday: c.trayShowsToday !== false,
    accent: c.accent || null,
    idleEnabled: c.idleEnabled !== false,
    idleMinutes: IDLE_CHOICES.includes(c.idleMinutes) ? c.idleMinutes : 10,
    remindStart: c.remindStart !== false,
    remindStartTime: validTime(c.remindStartTime) ? c.remindStartTime : '09:15',
    remindEnd: c.remindEnd !== false,
    remindEndTime: validTime(c.remindEndTime) ? c.remindEndTime : '16:45',
    remindMinHours: MIN_HOURS_CHOICES.includes(c.remindMinHours) ? c.remindMinHours : 6,
    workdays: Array.isArray(c.workdays) ? c.workdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [1, 2, 3, 4, 5],
  };
}
function validTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

function loadCredentials() {
  const envToken = process.env.KEITO_API_KEY;
  const envAccount = process.env.KEITO_ACCOUNT_ID;
  if (envToken && envAccount) return { token: envToken.trim(), accountId: envAccount.trim() };
  const c = readConfig();
  if (!c.token || !c.accountId) return null;
  try {
    const token = c.tokenEncrypted ? safeStorage.decryptString(Buffer.from(c.token, 'base64')) : c.token;
    return { token, accountId: c.accountId };
  } catch {
    return null;
  }
}

function saveCredentials(token, accountId) {
  const c = readConfig();
  if (safeStorage.isEncryptionAvailable()) {
    c.token = safeStorage.encryptString(token).toString('base64');
    c.tokenEncrypted = true;
  } else {
    c.token = token;
    c.tokenEncrypted = false;
  }
  c.accountId = accountId;
  writeConfig(c);
}

function clearCredentials() {
  const c = readConfig();
  delete c.token; delete c.tokenEncrypted; delete c.accountId;
  writeConfig(c);
  api = null; me = null; running = null;
  updateTray();
}

// ---------------------------------------------------------------- jira

let jira = null;
let jiraMe = null;

const encrypt = (s) => (safeStorage.isEncryptionAvailable()
  ? { value: safeStorage.encryptString(s).toString('base64'), encrypted: true }
  : { value: s, encrypted: false });
const decrypt = (v, encrypted) => (encrypted ? safeStorage.decryptString(Buffer.from(v, 'base64')) : v);

function loadJira() {
  const j = readConfig().jira;
  if (!j?.site || !j?.email || !j?.token) return null;
  try {
    return new JiraApi({ site: j.site, email: j.email, token: decrypt(j.token, j.tokenEncrypted) });
  } catch {
    return null;
  }
}

function jiraStatus() {
  const j = readConfig().jira;
  return { configured: !!jira, site: j?.site, email: j?.email, name: jiraMe?.name };
}

async function connect(creds) {
  const client = new KeitoApi(creds);
  const identity = await client.me();
  api = client;
  me = identity;
  return identity;
}

// ---------------------------------------------------------------- tray

function fmt(hours) {
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
  const c = readConfig(); c.hoursIncludeRunning = value; writeConfig(c);
}

/** Adds liveStartMs + liveBaseHours to a running entry so everyone can compute the live duration. */
function annotateRunning(e, fetchedAt) {
  if (!e || !e.isRunning) return e;
  const prev = seenRunning.get(e.id);
  const startMs = e.timerStartedAt ? Date.parse(e.timerStartedAt) : NaN;

  if (!Number.isFinite(startMs) || startMs > fetchedAt + 120e3) {
    // No usable start time: keep counting from when we first saw this run.
    if (prev && Math.abs(prev.hours - e.hours) < 1 / 120) Object.assign(e, { liveStartMs: prev.liveStartMs, liveBaseHours: prev.liveBaseHours });
    else Object.assign(e, { liveStartMs: fetchedAt, liveBaseHours: e.hours });
    seenRunning.set(e.id, { startMs: NaN, hours: e.hours, at: fetchedAt, liveStartMs: e.liveStartMs, liveBaseHours: e.liveBaseHours });
    return e;
  }

  const segment = Math.max(0, (fetchedAt - startMs) / 3.6e6);
  if (e.hours < segment - 1 / 60) learnHoursModel(false); // can't include it if it's smaller
  if (prev && prev.startMs === startMs && fetchedAt - prev.at > 90e3) {
    const dt = (fetchedAt - prev.at) / 3.6e6;
    const dH = e.hours - prev.hours;
    if (dH > dt * 0.5) learnHoursModel(true);
    else if (Math.abs(dH) < 1 / 120) learnHoursModel(false);
  }
  const base = hoursIncludeRunning === true ? Math.max(0, e.hours - segment) : e.hours;
  Object.assign(e, { liveStartMs: startMs, liveBaseHours: base });
  seenRunning.set(e.id, { startMs, hours: e.hours, at: fetchedAt, liveStartMs: startMs, liveBaseHours: base });
  return e;
}

function liveHours(r) {
  const e = r.entry;
  if (e.liveStartMs) return e.liveBaseHours + Math.max(0, Date.now() - e.liveStartMs) / 3.6e6;
  return e.hours + (Date.now() - r.fetchedAt) / 3.6e6;
}

let todayTotal = null; // hours of today's stopped entries, pushed by the renderer

function icon(isRunning) {
  const img = nativeImage.createFromPath(
    path.join(__dirname, 'assets', isRunning ? 'trayRunningTemplate.png' : 'trayTemplate.png'),
  );
  img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const isRunning = !!running;
  tray.setImage(icon(isRunning));
  let title = '';
  if (isRunning) title = ` ${fmt(liveHours(running))}`;
  else if (todayTotal !== null && prefs().trayShowsToday && api) title = ` ${fmt(todayTotal)}`;
  if (isMac) tray.setTitle(title, { fontType: 'monospacedDigit' });
  const project = running?.entry.projectName;
  tray.setToolTip(idlePending
    ? 'Keito · je was even weg — klik om de idle-tijd te verwerken'
    : isRunning ? `Keito · ${project || 'timer loopt'} · ${fmt(liveHours(running))}` : 'Keito');
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
  const r = entries.find((e) => e.isRunning);
  if (r) running = { entry: r, fetchedAt };
  updateTray();
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Keito Bar', accelerator: TOGGLE_SHORTCUT, click: () => showWindow() },
    { label: 'Open Keito in browser', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    ...(running
      ? [{ label: 'Stop timer', click: async () => { try { await api.stop(running.entry.id); } catch {} await refreshRunning(); send('data:changed'); } }]
      : []),
    ...(update.state === 'ready'
      ? [{ label: `Herstart om bij te werken naar ${update.version}`, click: () => autoUpdater.quitAndInstall(false, true) }]
      : []),
    { label: 'Instellingen…', click: () => { showWindow(); send('nav', 'settings'); } },
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
  if (!running || !prefs().idleEnabled) { awaySince = null; return; }
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
  const p = idlePending;
  if (!p) return { action: 'none' };
  const client = requireApi();
  if (action === 'keep') { idlePending = null; updateTray(); return { action }; }
  if (!['remove-continue', 'remove-stop', 'reassign'].includes(action)) throw new KeitoError('validation', 'Onbekende keuze.');

  // Stop to freeze the hours, take the idle time off, restart if we keep going.
  const stopped = await client.stop(p.entryId);
  const keepGoing = action !== 'remove-stop';
  let updateError = null;
  try {
    const hours = Math.max(0, Math.round((stopped.hours - p.hours) * 10000) / 10000);
    await client.update(p.entryId, { hours });
  } catch (err) {
    updateError = err;
  } finally {
    if (keepGoing) await client.restart(p.entryId).catch(() => {});
  }
  idlePending = null;
  running = null;
  await refreshRunning();
  if (updateError) throw new KeitoError(updateError.kind || 'unknown', `Idle-tijd kon niet worden afgehaald: ${updateError.message}`);
  return { action, hours: p.hours, from: p.from, to: p.to };
}

// ---------------------------------------------------------------- day reminders
//
// Start: on a workday after `remindStartTime`, no timer running → offer to start one.
// End:   after `remindEndTime`, today's total below `remindMinHours` → offer to fill in hours.
// Both wait until you're actually at the computer, show once a day, and can be snoozed 15 min.

let nudgePending = null; // { type: 'start'|'end', ... }

const pad2 = (n) => String(n).padStart(2, '0');
function localYmd(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
const minutesOf = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function reminderState() {
  const st = readConfig().reminderState;
  return st && st.date === localYmd() ? st : { date: localYmd() };
}
function saveReminderState(st) { const c = readConfig(); c.reminderState = st; writeConfig(c); }

async function todaysEntries() {
  const today = localYmd();
  const entries = await api.entries({ userId: me.userId, from: today, to: today });
  const at = Date.now();
  entries.forEach((e) => annotateRunning(e, at));
  return entries;
}
const totalOf = (entries) => entries.reduce((t, e) => t + (e.isRunning ? liveHours({ entry: e, fetchedAt: Date.now() }) : e.hours), 0);

async function lastUsedEntry() {
  const from = new Date(); from.setDate(from.getDate() - 14);
  const list = await api.entries({ userId: me.userId, from: localYmd(from), to: localYmd() });
  list.sort((a, b) => (b.spentDate + (b.createdAt || '')).localeCompare(a.spentDate + (a.createdAt || '')));
  const e = list.find((x) => x.projectId && x.taskId);
  return e ? { projectId: e.projectId, taskId: e.taskId, projectName: e.projectName, clientName: e.clientName, taskName: e.taskName } : null;
}

let checkingReminders = false;
async function checkReminders() {
  if (!api || !me || nudgePending || idlePending || checkingReminders) return;
  const p = prefs();
  const now = new Date();
  if (!p.workdays.includes(now.getDay())) return;
  if (!p.remindStart && !p.remindEnd) return;
  // Only when you're at the computer: not locked, input in the last 90 s.
  if (powerMonitor.getSystemIdleState(90) !== 'active') return;

  const mins = now.getHours() * 60 + now.getMinutes();
  const st = reminderState();
  const snoozed = (k) => st[k] && st[k] > Date.now();
  checkingReminders = true;
  try {
    if (p.remindEnd && !st.endDone && mins >= minutesOf(p.remindEndTime) && !snoozed('endSnooze')) {
      const entries = await todaysEntries();
      const total = totalOf(entries);
      st.endDone = true;
      saveReminderState(st);
      if (total < p.remindMinHours - 1 / 120) {
        openNudge({ type: 'end', total, minHours: p.remindMinHours, running: entries.some((e) => e.isRunning) });
      }
      return;
    }
    if (p.remindStart && !st.startDone && mins >= minutesOf(p.remindStartTime)
        && (!p.remindEnd || mins < minutesOf(p.remindEndTime)) && !snoozed('startSnooze')) {
      await refreshRunning();
      st.startDone = true;
      saveReminderState(st);
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

function openNudge(n) {
  nudgePending = { ...n, firstName: (me?.name || '').split(' ')[0] };
  showWindow();
  send('nudge', nudgePending);
}

function resolveNudge(action) {
  const n = nudgePending;
  if (!n) return null;
  nudgePending = null;
  const st = reminderState();
  const key = n.type === 'start' ? 'start' : 'end';
  if (action === 'snooze') {
    st[`${key}Done`] = false;
    st[`${key}Snooze`] = Date.now() + SNOOZE_MS;
  } else {
    st[`${key}Answered`] = true;
  }
  saveReminderState(st);
  return true;
}

// ---------------------------------------------------------------- auto-update
//
// Release builds (npm run release) are signed + notarized and published to GitHub Releases.
// The app checks at startup and every 4 hours, downloads in the background and installs
// on the next restart (or right away via "Herstart om bij te werken").

const update = { state: 'idle', version: null, error: null }; // idle|checking|downloading|ready|none|error|unavailable

function updaterAvailable() { return !!autoUpdater && app.isPackaged; }

function setUpdate(patch) {
  Object.assign(update, patch);
  send('update', { ...update, current: app.getVersion() });
}

function setupUpdater() {
  if (!updaterAvailable()) { update.state = 'unavailable'; return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setUpdate({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
  autoUpdater.on('update-downloaded', (info) => setUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => setUpdate({ state: 'error', error: friendlyUpdateError(err) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000);
  setInterval(check, 4 * 3600_000);
}

function friendlyUpdateError(err) {
  const m = String(err?.message || err || '');
  if (/code signature|signature.*valid|not signed|SecCode/i.test(m)) {
    return 'Deze versie kan zichzelf niet bijwerken (niet gesigneerd). Installeer één keer de nieuwste DMG handmatig.';
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|net::/i.test(m)) return 'Geen verbinding om op updates te controleren.';
  if (/404/.test(m)) return 'Nog geen release gevonden op GitHub.';
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
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function positionWindow() {
  const tb = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const wa = display.workArea;
  let x = Math.round(tb.x + tb.width / 2 - WIN_W / 2);
  let y;
  if (tb.y < wa.y + wa.height / 2) y = Math.round(tb.y + tb.height + 4); // menubar on top (macOS)
  else y = Math.round(tb.y - WIN_H - 4); // taskbar at the bottom (Windows)
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - WIN_W - 8);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - WIN_H);
  win.setPosition(x, y, false);
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

function wrap(fn) {
  return async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const kind = err instanceof KeitoError || err instanceof JiraError ? err.kind : 'unknown';
      return { ok: false, error: { kind, message: err.message || 'Er ging iets mis.' } };
    }
  };
}

function requireApi() {
  if (!api || !me) throw new KeitoError('auth', 'Nog niet verbonden met Keito.');
  return api;
}

function registerIpc() {
  ipcMain.handle('auth:status', wrap(async () => {
    if (me) return { connected: true, me };
    const creds = loadCredentials();
    if (!creds) return { connected: false };
    const identity = await connect(creds);
    refreshRunning();
    return { connected: true, me: identity };
  }));

  ipcMain.handle('auth:save', wrap(async ({ token, accountId }) => {
    token = String(token || '').trim();
    accountId = String(accountId || '').trim();
    if (!token.startsWith('kto_')) throw new KeitoError('validation', 'Een Keito API key begint met kto_.');
    if (!accountId || /[\s/?#]/.test(accountId)) throw new KeitoError('validation', 'Vul een geldige Company ID in.');
    const identity = await connect({ token, accountId });
    saveCredentials(token, accountId);
    refreshRunning();
    return { connected: true, me: identity };
  }));

  ipcMain.handle('auth:clear', wrap(async () => { clearCredentials(); return true; }));

  ipcMain.handle('prefs:get', wrap(async () => ({
    ...prefs(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    shortcut: TOGGLE_SHORTCUT,
    encrypted: readConfig().tokenEncrypted === true,
  })));

  ipcMain.handle('prefs:set', wrap(async (patch) => {
    const c = readConfig();
    if (patch.timeFormat) c.timeFormat = patch.timeFormat === 'decimal' ? 'decimal' : 'hm';
    if (typeof patch.trayShowsToday === 'boolean') c.trayShowsToday = patch.trayShowsToday;
    if (typeof patch.idleEnabled === 'boolean') c.idleEnabled = patch.idleEnabled;
    if (IDLE_CHOICES.includes(Number(patch.idleMinutes))) c.idleMinutes = Number(patch.idleMinutes);
    for (const k of ['remindStart', 'remindEnd']) if (typeof patch[k] === 'boolean') c[k] = patch[k];
    for (const k of ['remindStartTime', 'remindEndTime']) if (validTime(patch[k])) c[k] = patch[k];
    if (MIN_HOURS_CHOICES.includes(Number(patch.remindMinHours))) c.remindMinHours = Number(patch.remindMinHours);
    if (Array.isArray(patch.workdays)) c.workdays = [...new Set(patch.workdays.map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (['remindStart', 'remindEnd', 'remindStartTime', 'remindEndTime', 'remindMinHours', 'workdays'].some((k) => k in patch)) {
      // Changing the schedule re-arms today's reminders that haven't been answered yet.
      const st = c.reminderState;
      if (st && st.date === localYmd()) { if (!st.startAnswered) delete st.startDone; if (!st.endAnswered) delete st.endDone; }
    }
    if (patch.accent === null) delete c.accent;
    else if (typeof patch.accent === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accent)) c.accent = patch.accent.toLowerCase();
    writeConfig(c);
    if (typeof patch.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    updateTray();
    return prefs();
  }));

  ipcMain.handle('projects:list', wrap(async () => requireApi().projects()));
  ipcMain.handle('tasks:list', wrap(async (projectId) => requireApi().tasks(projectId)));

  ipcMain.handle('entries:list', wrap(async ({ from, to }) => {
    const entries = await requireApi().entries({ userId: me.userId, from, to });
    const fetchedAt = Date.now();
    entries.forEach((e) => annotateRunning(e, fetchedAt));
    setRunningFromEntries(entries, fetchedAt);
    return { entries, fetchedAt };
  }));

  ipcMain.handle('entry:create', wrap(async (body) => {
    let entry;
    try {
      entry = await requireApi().create(body);
    } catch (err) {
      // If Keito rejects the Jira link, still save the hours (the ticket key is in the notes anyway).
      if (!(body.external_reference && err instanceof KeitoError && err.kind === 'validation')) throw err;
      const { external_reference, ...rest } = body;
      entry = await requireApi().create(rest);
    }
    await refreshRunning();
    return entry;
  }));
  ipcMain.handle('entry:update', wrap(async ({ id, body }) => {
    const entry = await requireApi().update(id, body);
    await refreshRunning();
    return entry;
  }));
  ipcMain.handle('entry:stop', wrap(async (id) => {
    const entry = await requireApi().stop(id);
    running = null;
    await refreshRunning();
    return entry;
  }));
  ipcMain.handle('entry:restart', wrap(async (id) => {
    const entry = await requireApi().restart(id);
    await refreshRunning();
    return entry;
  }));
  ipcMain.handle('entry:delete', wrap(async (id) => {
    await requireApi().remove(id);
    await refreshRunning();
    return true;
  }));

  // ---- Jira
  ipcMain.handle('jira:status', wrap(async () => jiraStatus()));

  ipcMain.handle('jira:save', wrap(async ({ site, email, token }) => {
    site = normalizeSite(site);
    email = String(email || '').trim();
    token = String(token || '').trim();
    if (!email.includes('@')) throw new JiraError('validation', 'Vul het e-mailadres van je Atlassian-account in.');
    if (!token) throw new JiraError('validation', 'Vul een Jira API token in.');
    const client = new JiraApi({ site, email, token });
    jiraMe = await client.myself();
    jira = client;
    const enc = encrypt(token);
    const c = readConfig();
    c.jira = { site, email, token: enc.value, tokenEncrypted: enc.encrypted };
    writeConfig(c);
    return jiraStatus();
  }));

  ipcMain.handle('jira:clear', wrap(async () => {
    const c = readConfig();
    delete c.jira;
    writeConfig(c);
    jira = null; jiraMe = null;
    return jiraStatus();
  }));

  ipcMain.handle('jira:search', wrap(async ({ query, projectKey }) => {
    if (!jira) throw new JiraError('auth', 'Jira is nog niet gekoppeld (Instellingen).');
    return jira.search(query, { projectKey });
  }));

  ipcMain.on('jira:tokens', () => shell.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens'));

  ipcMain.on('jira:open', (_e, key) => {
    if (jira && typeof key === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/i.test(key)) shell.openExternal(jira.issueUrl(key));
  });

  // ---- Updates
  ipcMain.handle('update:status', wrap(async () => ({ ...update, current: app.getVersion() })));
  ipcMain.handle('update:check', wrap(async () => {
    if (!updaterAvailable()) return { ...update, current: app.getVersion() };
    setUpdate({ state: 'checking', error: null });
    await autoUpdater.checkForUpdates().catch((err) => setUpdate({ state: 'error', error: friendlyUpdateError(err) }));
    return { ...update, current: app.getVersion() };
  }));
  ipcMain.on('update:install', () => {
    if (updaterAvailable() && update.state === 'ready') setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });

  // ---- Day reminders
  ipcMain.handle('nudge:get', wrap(async () => nudgePending));
  ipcMain.handle('nudge:resolve', wrap(async (action) => resolveNudge(action)));
  ipcMain.handle('nudge:test', wrap(async (type) => {
    // "Probeer" button in settings: show the reminder now, regardless of time/state.
    requireApi();
    const entries = await todaysEntries();
    const total = totalOf(entries);
    if (type === 'end') openNudge({ type: 'end', total, minHours: prefs().remindMinHours, running: entries.some((e) => e.isRunning), test: true });
    else openNudge({ type: 'start', total, suggest: await lastUsedEntry().catch(() => null), test: true });
    return true;
  }));

  // ---- Idle
  ipcMain.handle('idle:get', wrap(async () => idlePending));
  ipcMain.handle('idle:resolve', wrap(async (action) => resolveIdle(action)));

  ipcMain.on('tray:today', (_e, hours) => {
    todayTotal = typeof hours === 'number' && Number.isFinite(hours) ? hours : null;
    updateTray();
  });
  ipcMain.on('window:hide', () => win?.hide());
  ipcMain.on('open:web', (_e, sub) => shell.openExternal(WEB_URL + (typeof sub === 'string' && sub.startsWith('/') ? sub : '')));
  ipcMain.on('app:quit', () => app.quit());
}

// ---------------------------------------------------------------- lifecycle

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
    for (const ev of ['suspend', 'lock-screen']) powerMonitor.on(ev, () => markAway(Date.now()));
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(checkIdle, 1500));

    const creds = loadCredentials();
    if (creds) connect(creds).then(refreshRunning).catch(() => {});
    else setTimeout(showWindow, 400); // first run: open straight into setup
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearInterval(trayTicker);
    clearInterval(runningPoll);
    clearInterval(idlePoll);
    clearInterval(reminderPoll);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
