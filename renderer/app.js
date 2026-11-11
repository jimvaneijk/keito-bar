/* Keito Bar — renderer. Plain JS, no framework. All API calls go through window.keito (preload). */
'use strict';

const keitoBridge = window.keito;
const findElement = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------- dates

const padZero = (number) => String(number).padStart(2, '0');
const toIsoDate = (date) => `${date.getFullYear()}-${padZero(date.getMonth() + 1)}-${padZero(date.getDate())}`;
const parseIsoDate = (isoDate) => {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day);
};
const addDays = (isoDate, days) => {
    const date = parseIsoDate(isoDate);
    date.setDate(date.getDate() + days);
    return toIsoDate(date);
};
const todayIsoDate = () => toIsoDate(new Date());
const mondayOf = (isoDate) => {
    const date = parseIsoDate(isoDate);
    const weekdayIndex = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - weekdayIndex);
    return toIsoDate(date);
};
function isoWeek(isoDate) {
    const date = parseIsoDate(isoDate);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const jan4 = new Date(date.getFullYear(), 0, 4);
    return 1 + Math.round(((date - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}
const dayFormatter = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const weekdayFormatter = new Intl.DateTimeFormat('nl-NL', { weekday: 'short' });
const monthFormatter = new Intl.DateTimeFormat('nl-NL', { month: 'short' });
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- hours

function formatHours(hours) {
    if (state.prefs.timeFormat === 'decimal') return Math.max(0, hours).toFixed(2);
    const mins = Math.max(0, Math.round(hours * 60));
    return `${Math.floor(mins / 60)}:${padZero(mins % 60)}`;
}

/** "1:30", "1.5", "1,5", "90m", "1h30", "1h 30m", "45" (≤ 10 = hours, else minutes?) — keep it predictable: bare number = hours. */
function parseDuration(input) {
    const normalized = String(input || '')
        .trim()
        .toLowerCase()
        .replace(',', '.')
        .replace(/\s+/g, '');
    if (!normalized) return null;
    let match;
    if ((match = normalized.match(/^(\d+):(\d{1,2})$/))) return +match[1] + +match[2] / 60;
    if ((match = normalized.match(/^:(\d{1,2})$/))) return +match[1] / 60;
    if ((match = normalized.match(/^(\d+(?:\.\d+)?)(?:h|u|uur)(?:(\d+)m?(?:in)?)?$/)))
        return +match[1] + (match[2] ? +match[2] / 60 : 0);
    if ((match = normalized.match(/^(\d+)(?:m|min)$/))) return +match[1] / 60;
    if ((match = normalized.match(/^\d+(?:\.\d+)?$/))) return +normalized;
    return NaN;
}

// Running timers carry liveStartMs/liveBaseHours from the main process (see annotateRunning).
const liveHours = (entry) => {
    if (!entry.isRunning) return entry.hours;
    if (entry.liveStartMs) return entry.liveBaseHours + Math.max(0, Date.now() - entry.liveStartMs) / 3.6e6;
    return entry.hours + (Date.now() - state.fetchedAt) / 3.6e6;
};

// ---------------------------------------------------------------- state

const state = {
    me: null,
    prefs: { timeFormat: 'hm' },
    projects: [],
    projectsById: new Map(),
    projectsLoadedAt: 0,
    tasks: new Map(), // projectId -> tasks[]
    weekStart: mondayOf(todayIsoDate()),
    selected: todayIsoDate(),
    weeks: new Map(), // weekStart -> { entries, fetchedAt }
    entries: [],
    fetchedAt: Date.now(),
    loadingWeek: false,
    view: 'loading',
    form: null,
    lastSeenToday: todayIsoDate(),
    busy: false,
    jira: { configured: false },
    jiraCache: new Map(), // default-list key -> { at, items }
};

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
const JIRA_KEY_RE_G = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

// ---------------------------------------------------------------- helpers

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );
}

let toastTimer;
function toast(message, kind = 'info') {
    const element = findElement('#toast');
    element.textContent = message;
    element.className = `toast ${kind}`;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (element.hidden = true), kind === 'error' ? 6000 : 2500);
}

async function run(promise, { quiet = false } = {}) {
    const result = await promise;
    if (!result.ok) {
        if (result.error.kind === 'auth' && state.view !== 'setup') {
            toast(result.error.message, 'error');
        } else if (!quiet) {
            toast(result.error.message, 'error');
        }
        throw Object.assign(new Error(result.error.message), { kind: result.error.kind, handled: true });
    }
    return result.data;
}

function show(view) {
    state.view = view;
    for (const name of ['main', 'settings', 'setup', 'loading']) findElement(`#view-${name}`).hidden = name !== view;
    if (view !== 'main') findElement('#view-form').hidden = true;
}

// ---------------------------------------------------------------- data

async function loadProjects(force = false) {
    if (!force && state.projects.length && Date.now() - state.projectsLoadedAt < 30 * 60e3) return;
    const list = await run(keitoBridge.projects(), { quiet: state.projects.length > 0 });
    list.sort(
        (left, right) =>
            (left.clientName || '~').localeCompare(right.clientName || '~', 'nl') ||
            left.name.localeCompare(right.name, 'nl'),
    );
    state.projects = list;
    state.projectsById = new Map(list.map((project) => [project.id, project]));
    state.projectsLoadedAt = Date.now();
}

async function loadTasks(projectId) {
    if (state.tasks.has(projectId)) return state.tasks.get(projectId);
    const list = await run(keitoBridge.tasks(projectId));
    state.tasks.set(projectId, list);
    return list;
}

let latestWeekRequest = 0;
async function loadWeek({ silent = false } = {}) {
    const key = state.weekStart;
    const cached = state.weeks.get(key);
    if (cached) {
        state.entries = cached.entries;
        state.fetchedAt = cached.fetchedAt;
    } else {
        state.entries = [];
    }
    state.loadingWeek = !cached;
    render();

    const requestId = ++latestWeekRequest;
    try {
        const data = await run(keitoBridge.entries({ from: key, to: addDays(key, 6) }), { quiet: silent && !!cached });
        state.weeks.set(key, data);
        if (requestId !== latestWeekRequest || key !== state.weekStart) return; // user moved on
        state.entries = data.entries;
        state.fetchedAt = data.fetchedAt;
    } catch {
        /* toast already shown */
    } finally {
        if (requestId === latestWeekRequest) {
            state.loadingWeek = false;
            render();
        }
    }
}

function invalidateWeeks() {
    state.weeks.clear();
}

// ---------------------------------------------------------------- navigation

function selectDay(date) {
    state.selected = date;
    const weekStart = mondayOf(date);
    if (weekStart !== state.weekStart) {
        state.weekStart = weekStart;
        loadWeek({ silent: true });
    } else render();
}

// ---------------------------------------------------------------- rendering

const ICON_PLAY =
    '<svg viewBox="0 0 12 12"><path d="M3 1.8v8.4c0 .4.4.6.7.4l6.6-4.2a.5.5 0 0 0 0-.8L3.7 1.4c-.3-.2-.7 0-.7.4Z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2"/></svg>';
const ICON_LOCK =
    '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

function entriesOn(date) {
    return state.entries
        .filter((entry) => entry.spentDate === date)
        .sort((left, right) => (left.createdAt || '').localeCompare(right.createdAt || ''));
}
const sum = (list) => list.reduce((total, entry) => total + liveHours(entry), 0);

function render() {
    if (state.view !== 'main') return;
    const today = todayIsoDate();
    const week = state.weekStart;

    // Header
    const end = addDays(week, 6);
    const firstDay = parseIsoDate(week),
        lastDay = parseIsoDate(end);
    findElement('#week-title').textContent = `Week ${isoWeek(week)}`;
    findElement('#week-range').textContent =
        firstDay.getMonth() === lastDay.getMonth()
            ? `${firstDay.getDate()} – ${lastDay.getDate()} ${monthFormatter.format(lastDay)} ${lastDay.getFullYear()}`
            : `${firstDay.getDate()} ${monthFormatter.format(firstDay)} – ${lastDay.getDate()} ${monthFormatter.format(lastDay)}`;
    findElement('#btn-today').classList.toggle('is-hidden', state.selected === today);

    // Week strip
    let html = '';
    for (let index = 0; index < 7; index++) {
        const date = addDays(week, index);
        const list = entriesOn(date);
        const total = sum(list);
        const classNames = [
            'day',
            date === state.selected && 'selected',
            date === today && 'today',
            index >= 5 && 'weekend',
        ]
            .filter(Boolean)
            .join(' ');
        const hoursLabel = state.loadingWeek ? '' : total > 0 ? formatHours(total) : '–';
        html += `<button class="${classNames}" data-day="${date}" title="${capitalize(dayFormatter.format(parseIsoDate(date)))} (${index + 1})">
      ${list.some((entry) => entry.isRunning) ? '<span class="run-dot"></span>' : ''}
      <span class="day-name">${weekdayFormatter.format(parseIsoDate(date)).replace('.', '')}</span>
      <span class="day-num">${parseIsoDate(date).getDate()}</span>
      <span class="day-hours ${total > 0 ? '' : 'empty'}" ${list.some((entry) => entry.isRunning) ? 'data-live-day="' + date + '"' : ''}>${hoursLabel}</span>
    </button>`;
    }
    findElement('#week').innerHTML = html;

    // Day header
    const dayList = entriesOn(state.selected);
    findElement('#day-title').textContent =
        state.selected === today
            ? `Vandaag · ${dayFormatter.format(parseIsoDate(state.selected)).split(' ').slice(1).join(' ')}`
            : capitalize(dayFormatter.format(parseIsoDate(state.selected)));
    findElement('#day-total').textContent = state.loadingWeek ? '' : formatHours(sum(dayList));
    findElement('#week-total').textContent = state.loadingWeek ? '' : `week ${formatHours(sum(state.entries))}`;

    // Entries
    const entriesList = findElement('#entries');
    if (state.loadingWeek) {
        entriesList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    } else if (!dayList.length) {
        const isToday = state.selected === today;
        entriesList.innerHTML = `<div class="empty-state">
      <strong>${isToday ? 'Nog niets geschreven vandaag' : 'Geen uren op deze dag'}</strong>
      <span>Druk op <kbd>N</kbd> om ${isToday ? 'een timer te starten' : 'uren toe te voegen'}.</span>
    </div>`;
    } else {
        entriesList.innerHTML = dayList.map((entry) => entryHtml(entry, today)).join('');
    }

    findElement('#new-label').textContent =
        state.selected === today
            ? 'Nieuwe registratie'
            : `Uren toevoegen op ${weekdayFormatter.format(parseIsoDate(state.selected)).replace('.', '')} ${parseIsoDate(state.selected).getDate()}`;

    // Menubar shows today's total when no timer runs
    if (mondayOf(today) === state.weekStart && !state.loadingWeek)
        keitoBridge.setTodayTotal(
            entriesOn(today)
                .filter((entry) => !entry.isRunning)
                .reduce((total, entry) => total + entry.hours, 0),
        );
}

function entryHtml(entry, today) {
    const knownProject = state.projectsById.get(entry.projectId);
    const project = entry.projectName || knownProject?.name || 'Onbekend project';
    const client = entry.clientName || knownProject?.clientName || '';
    const task =
        entry.taskName ||
        state.tasks.get(entry.projectId)?.find((candidateTask) => candidateTask.id === entry.taskId)?.name ||
        '';
    const canTimer = !entry.locked && (entry.isRunning || entry.spentDate === today);
    const timerControl = entry.locked
        ? `<span class="lock" title="${escapeHtml(entry.lockedReason)}">${ICON_LOCK}</span>`
        : canTimer
          ? `<button class="timer-btn ${entry.isRunning ? 'stop' : ''}" data-timer="${escapeHtml(entry.id)}" title="${entry.isRunning ? 'Stop timer (S)' : 'Hervat timer'}" aria-label="${entry.isRunning ? 'Stop timer' : 'Start timer'}">${entry.isRunning ? ICON_STOP : ICON_PLAY}</button>`
          : '<span class="timer-btn placeholder"></span>';
    const span = entry.startedTime && entry.endedTime ? ` · ${entry.startedTime}–${entry.endedTime}` : '';
    return `<div class="entry ${entry.isRunning ? 'running' : ''} ${entry.locked ? 'locked' : ''}" data-entry="${escapeHtml(entry.id)}" role="listitem" title="${entry.locked ? escapeHtml(entry.lockedReason) : 'Klik om te bewerken'}">
    <div class="entry-main">
      <div class="entry-project"><b>${escapeHtml(project)}</b>${client ? `<span class="entry-client">${escapeHtml(client)}</span>` : ''}</div>
      <div class="entry-meta"><span class="task">${escapeHtml(task)}</span>${entry.notes ? ` · ${notesHtml(entry.notes)}` : ''}${span}</div>
    </div>
    <div class="entry-time" ${entry.isRunning ? `data-live="${escapeHtml(entry.id)}"` : ''}>${formatHours(liveHours(entry))}</div>
    ${timerControl}
  </div>`;
}

/** Notes with Jira keys turned into clickable tags (only when Jira is linked). */
function notesHtml(notes) {
    const safe = escapeHtml(notes);
    if (!state.jira.configured) return safe;
    return safe.replace(JIRA_KEY_RE_G, '<span class="jira-tag" data-jira="$1" title="Open $1 in Jira">$1</span>');
}

// Live ticking of running timers without full re-render.
setInterval(() => {
    if (state.view !== 'main') return;
    const runningEntry = state.entries.find((entry) => entry.isRunning);
    if (!runningEntry) return;
    document.querySelectorAll('[data-live]').forEach((element) => {
        const entry = state.entries.find((candidate) => candidate.id === element.dataset.live);
        if (entry) element.textContent = formatHours(liveHours(entry));
    });
    document
        .querySelectorAll('[data-live-day]')
        .forEach((element) => (element.textContent = formatHours(sum(entriesOn(element.dataset.liveDay)))));
    if (runningEntry.spentDate === state.selected)
        findElement('#day-total').textContent = formatHours(sum(entriesOn(state.selected)));
    findElement('#week-total').textContent = `week ${formatHours(sum(state.entries))}`;
}, 1000);

// ---------------------------------------------------------------- timer actions

async function toggleTimer(id) {
    if (state.busy) return;
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    state.busy = true;
    try {
        if (entry.isRunning) await run(keitoBridge.stop(id));
        else await run(keitoBridge.restart(id));
        invalidateWeeks();
        await loadWeek({ silent: true });
    } catch {
        /* toast shown */
    } finally {
        state.busy = false;
    }
}

function stopRunning() {
    const runningEntry = state.entries.find((entry) => entry.isRunning);
    if (runningEntry) toggleTimer(runningEntry.id);
}

// ---------------------------------------------------------------- form

async function openForm(entry, prefill = {}) {
    const date = entry ? entry.spentDate : state.selected;
    const project = entry ? state.projectsById.get(entry.projectId) : null;
    state.form = {
        id: entry?.id || null,
        date,
        isRunning: !!entry?.isRunning,
        projectId: entry?.projectId || null,
        taskId: entry?.taskId || null,
        query: '',
        active: 0,
        confirmDelete: false,
    };
    findElement('#view-form').hidden = false;
    findElement('#form-title').textContent = entry
        ? 'Bewerken'
        : date === todayIsoDate()
          ? 'Nieuwe registratie'
          : 'Uren toevoegen';
    findElement('#form-date').textContent = capitalize(
        dayFormatter.format(parseIsoDate(date)).split(' ').slice(0, 2).join(' '),
    );
    findElement('#f-project').value = entry
        ? projectLabel(project || { name: entry.projectName, clientName: entry.clientName })
        : '';
    findElement('#f-notes').value = entry?.notes || '';
    findElement('#f-duration').value = entry && !entry.isRunning ? formatHours(entry.hours) : '';
    findElement('#f-duration').disabled = !!entry?.isRunning;
    if (prefill.hours) findElement('#f-duration').value = formatHours(prefill.hours);
    if (prefill.notes) findElement('#f-notes').value = prefill.notes;
    findElement('#notes-required').hidden = !state.me?.requireNotes;
    findElement('#btn-delete').hidden = !entry;
    findElement('#btn-delete').classList.remove('confirm');
    findElement('#btn-delete').textContent = 'Verwijderen';
    setTaskOptions([], null, true);
    updateSubmitLabel();
    closeCombo();
    closeJira();
    findElement('#jira-field').hidden = !state.jira.configured;
    findElement('#f-jira').value = '';
    // Existing note "KEY-1 · summary — own text": ticket goes to the chip, own text to the textarea.
    const ticketMatch =
        state.jira.configured && entry?.notes?.match(/^([A-Z][A-Z0-9_]+-\d+)(?:\s*·\s*(.*?))?(?:\s+—\s+([\s\S]*))?$/);
    if (ticketMatch) {
        setJiraIssue({ key: ticketMatch[1], summary: ticketMatch[2] || '', projectKey: ticketMatch[1].split('-')[0] });
        findElement('#f-notes').value = ticketMatch[3] || '';
    } else {
        setJiraIssue(null);
    }

    if (entry) {
        if (entry.projectId) await chooseProject(entry.projectId, entry.taskId, { focusNext: false });
        findElement('#f-notes').focus();
    } else {
        findElement('#f-project').focus();
        openCombo();
    }
    loadProjects()
        .then(() => {
            if (!findElement('#combo-list').hidden) renderCombo();
        })
        .catch(() => {});
}

function closeForm() {
    state.form = null;
    findElement('#view-form').hidden = true;
    closeCombo();
    closeJira();
}

// ---------------------------------------------------------------- jira picker

const jiraPrefix = (issue) => (issue.summary ? `${issue.key} · ${issue.summary}` : issue.key);

/** Link a ticket to the form. Saved notes become "KEY · summary — your notes". */
function setJiraIssue(issue) {
    const form = state.form;
    if (!form) return;
    form.jira = issue;
    findElement('#jira-chip').hidden = !issue;
    findElement('#jira-combo').hidden = !!issue;
    if (issue) {
        findElement('#jira-chip .jira-key').textContent = issue.key;
        findElement('#jira-chip .jira-sum').textContent = issue.summary || '';
    }
    findElement('#f-notes').placeholder = issue ? 'Optioneel: wat heb je gedaan?' : 'Waar werk je aan?';

    // Jira project ↔ Keito project: pick the Keito project you used last time for this Jira project.
    if (issue && !form.projectId) {
        const mapped = safeGet(`jira2keito:${issue.projectKey || issue.key.split('-')[0]}`);
        if (mapped && state.projectsById.has(mapped)) chooseProject(mapped, null, { focusNext: false });
    }
}

let jiraTimer = null;
let latestJiraRequest = 0;
async function searchJira() {
    const form = state.form;
    if (!form || !state.jira.configured) return;
    const query = findElement('#f-jira').value.trim();
    const projectKey = form.projectId ? safeGet(`keito2jira:${form.projectId}`) : null;
    const cacheKey = `default:${projectKey || ''}`;
    const list = findElement('#jira-list');
    list.hidden = false;
    findElement('#f-jira').setAttribute('aria-expanded', 'true');

    if (!query && state.jiraCache.has(cacheKey) && Date.now() - state.jiraCache.get(cacheKey).at < 120e3) {
        form.jiraItems = state.jiraCache.get(cacheKey).items;
        form.jiraActive = 0;
        renderJira(query);
        return;
    }
    if (!form.jiraItems?.length) list.innerHTML = '<div class="combo-empty">Zoeken in Jira…</div>';
    const requestId = ++latestJiraRequest;
    const result = await keitoBridge.jiraSearch(query, projectKey);
    if (requestId !== latestJiraRequest || state.form !== form) return;
    if (!result.ok) {
        list.innerHTML = `<div class="combo-empty">${escapeHtml(result.error.message)}</div>`;
        form.jiraItems = [];
        return;
    }
    form.jiraItems = result.data;
    form.jiraActive = 0;
    if (!query) state.jiraCache.set(cacheKey, { at: Date.now(), items: result.data });
    renderJira(query);
}

function renderJira(query) {
    const form = state.form;
    const list = findElement('#jira-list');
    if (!form || list.hidden) return;
    const items = form.jiraItems || [];
    if (!items.length) {
        list.innerHTML = `<div class="combo-empty">${query ? 'Geen tickets gevonden.' : 'Geen open tickets op jouw naam.'}</div>`;
        return;
    }
    list.innerHTML =
        (query ? '' : '<div class="combo-group">Open tickets</div>') +
        items
            .map(
                (issue, index) => `
    <div class="combo-item jira-item ${index === form.jiraActive ? 'active' : ''}" role="option" data-jidx="${index}">
      <span class="jkey">${escapeHtml(issue.key)}</span><span class="jsum">${highlight(issue.summary, query)}</span>${issue.status ? `<span class="jstat">${escapeHtml(issue.status)}</span>` : ''}
    </div>`,
            )
            .join('');
    list.querySelector('.jira-item.active')?.scrollIntoView({ block: 'nearest' });
}

function pickJira(index) {
    const issue = state.form?.jiraItems?.[index];
    if (!issue) return;
    setJiraIssue(issue);
    closeJira();
    findElement('#f-notes').focus();
    const notesInput = findElement('#f-notes');
    notesInput.setSelectionRange(notesInput.value.length, notesInput.value.length);
}

function closeJira() {
    findElement('#jira-list').hidden = true;
    findElement('#f-jira').setAttribute('aria-expanded', 'false');
}

function focusJira() {
    if (!state.form || !state.jira.configured) return;
    if (state.form.jira) setJiraIssue(null);
    findElement('#f-jira').focus();
}

function projectLabel(project) {
    if (!project) return '';
    return project.clientName ? `${project.name} — ${project.clientName}` : project.name;
}

function setTaskOptions(tasks, selectedId, disabled = false) {
    const taskSelect = findElement('#f-task');
    if (disabled || !tasks.length) {
        taskSelect.innerHTML = `<option>${disabled ? 'Kies eerst een project' : 'Geen taken in dit project'}</option>`;
        taskSelect.disabled = true;
        return;
    }
    taskSelect.innerHTML = tasks
        .map(
            (task) =>
                `<option value="${escapeHtml(task.id)}" ${task.id === selectedId ? 'selected' : ''}>${escapeHtml(task.name)}</option>`,
        )
        .join('');
    taskSelect.disabled = false;
    if (!tasks.some((task) => task.id === selectedId)) taskSelect.value = tasks[0].id;
}

async function chooseProject(projectId, taskId = null, { focusNext = true } = {}) {
    if (!state.form) return;
    state.form.projectId = projectId;
    const project = state.projectsById.get(projectId);
    if (project) findElement('#f-project').value = projectLabel(project);
    closeCombo();
    const taskSelect = findElement('#f-task');
    taskSelect.innerHTML = '<option>Taken laden…</option>';
    taskSelect.disabled = true;
    try {
        const tasks = await loadTasks(projectId);
        if (!state.form || state.form.projectId !== projectId) return;
        // Remember the last task used per project — handy, and no "recent projects" noise.
        const remembered = taskId || safeGet(`lastTask:${projectId}`);
        setTaskOptions(tasks, remembered);
        if (focusNext) findElement('#f-notes').focus();
    } catch {
        setTaskOptions([], null);
    }
}

function safeGet(storageKey) {
    try {
        return localStorage.getItem(storageKey);
    } catch {
        return null;
    }
}
function safeSet(storageKey, value) {
    try {
        localStorage.setItem(storageKey, value);
    } catch {
        /* ignore */
    }
}

function updateSubmitLabel() {
    const form = state.form;
    if (!form) return;
    const submitButton = findElement('#btn-submit');
    const durationInput = findElement('#f-duration').value.trim();
    const isToday = form.date === todayIsoDate();
    const startsTimer = !form.id && isToday && !durationInput;
    submitButton.innerHTML = `${form.id ? 'Opslaan' : startsTimer ? 'Start timer' : 'Opslaan'} <kbd>⌘↵</kbd>`;
    submitButton.classList.toggle('run', startsTimer);
    const parsed = parseDuration(durationInput);
    const hint = findElement('#duration-hint');
    if (form.isRunning) hint.textContent = 'Timer loopt — stop hem om de duur aan te passen.';
    else if (durationInput && Number.isNaN(parsed)) hint.textContent = 'Gebruik 1:30, 1.5, 90m of 1h30.';
    else if (durationInput && parsed !== null) hint.textContent = `= ${formatHours(parsed)} uur`;
    else if (!form.id && isToday) hint.textContent = 'Laat leeg om een timer te starten.';
    else hint.textContent = '1:30 · 1.5 · 90m · 1h30';
}

async function submitForm() {
    const form = state.form;
    if (!form || state.busy) return;
    const taskSel = findElement('#f-task');
    const notes = findElement('#f-notes').value.trim();
    const durRaw = findElement('#f-duration').value.trim();
    const hours = parseDuration(durRaw);

    if (!form.projectId) {
        toast('Kies een project.', 'error');
        findElement('#f-project').focus();
        openCombo();
        return;
    }
    if (taskSel.disabled || !taskSel.value) {
        toast('Kies een taak.', 'error');
        return;
    }
    if (state.me?.requireNotes && !notes && !form.jira) {
        toast('Notities zijn verplicht in jullie Keito.', 'error');
        findElement('#f-notes').focus();
        return;
    }
    if (durRaw && (Number.isNaN(hours) || hours < 0 || hours > 24)) {
        toast('Ongeldige duur.', 'error');
        findElement('#f-duration').focus();
        return;
    }

    const isToday = form.date === todayIsoDate();
    let finalNotes = notes;
    let externalRef;
    if (form.jira) {
        finalNotes = finalNotes ? `${jiraPrefix(form.jira)} — ${finalNotes}` : jiraPrefix(form.jira);
        const jiraProjectKey = form.jira.projectKey || form.jira.key.split('-')[0];
        safeSet(`jira2keito:${jiraProjectKey}`, form.projectId);
        safeSet(`keito2jira:${form.projectId}`, jiraProjectKey);
        if (form.jira.url) {
            externalRef = {
                id: form.jira.id || form.jira.key,
                permalink: form.jira.url,
                service: new URL(form.jira.url).host,
                service_name: 'Jira',
                group_id: jiraProjectKey,
                display_name: form.jira.key,
            };
        }
    }
    const base = { project_id: form.projectId, task_id: taskSel.value, notes: finalNotes };
    safeSet(`lastTask:${form.projectId}`, taskSel.value);

    state.busy = true;
    findElement('#btn-submit').disabled = true;
    try {
        if (form.id) {
            const body = { ...base };
            if (!form.isRunning && hours !== null) body.hours = round(hours);
            await run(keitoBridge.update(form.id, body));
            toast('Opgeslagen');
        } else if (hours === null) {
            if (!isToday) {
                toast('Vul een duur in voor een andere dag dan vandaag.', 'error');
                findElement('#f-duration').focus();
                return;
            }
            await run(
                keitoBridge.create({
                    ...base,
                    spent_date: form.date,
                    is_running: true,
                    replace_running: true,
                    ...(externalRef && { external_reference: externalRef }),
                }),
            );
            toast('Timer gestart');
        } else {
            await run(
                keitoBridge.create({
                    ...base,
                    spent_date: form.date,
                    hours: round(hours),
                    ...(externalRef && { external_reference: externalRef }),
                }),
            );
            toast('Toegevoegd');
        }
        closeForm();
        invalidateWeeks();
        await loadWeek({ silent: true });
    } catch {
        /* toast shown */
    } finally {
        state.busy = false;
        findElement('#btn-submit').disabled = false;
    }
}

const round = (hours) => Math.round(hours * 10000) / 10000;

async function deleteEntry() {
    const form = state.form;
    if (!form?.id) return;
    const deleteButton = findElement('#btn-delete');
    if (!form.confirmDelete) {
        form.confirmDelete = true;
        deleteButton.classList.add('confirm');
        deleteButton.textContent = 'Zeker weten?';
        setTimeout(() => {
            if (state.form === form) {
                form.confirmDelete = false;
                deleteButton.classList.remove('confirm');
                deleteButton.textContent = 'Verwijderen';
            }
        }, 3000);
        return;
    }
    try {
        await run(keitoBridge.remove(form.id));
        toast('Verwijderd');
        closeForm();
        invalidateWeeks();
        await loadWeek({ silent: true });
    } catch {
        /* toast shown */
    }
}

// ---------------------------------------------------------------- project combobox

function filteredProjects() {
    const query = findElement('#f-project').value.trim().toLowerCase();
    const current = state.form?.projectId && projectLabel(state.projectsById.get(state.form.projectId)).toLowerCase();
    if (!query || query === current) return state.projects;
    const terms = query.split(/\s+/);
    return state.projects.filter((project) => {
        const haystack = `${project.name} ${project.clientName || ''} ${project.code || ''}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}

function highlight(text, query) {
    const escaped = escapeHtml(text);
    if (!query) return escaped;
    const terms = query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!terms.length) return escaped;
    return escaped.replace(new RegExp(`(${terms.map(escapeHtml).join('|')})`, 'gi'), '<mark>$1</mark>');
}

function renderCombo() {
    const list = findElement('#combo-list');
    const items = filteredProjects();
    if (!state.form) return;
    state.form.items = items;
    if (state.form.active >= items.length) state.form.active = Math.max(0, items.length - 1);
    if (!state.projects.length) {
        list.innerHTML = '<div class="combo-empty">Projecten laden…</div>';
        return;
    }
    if (!items.length) {
        list.innerHTML = '<div class="combo-empty">Geen project gevonden.</div>';
        return;
    }
    const query =
        state.form.projectId &&
        findElement('#f-project').value === projectLabel(state.projectsById.get(state.form.projectId))
            ? ''
            : findElement('#f-project').value;
    let html = '';
    let lastClient = null;
    items.forEach((project, index) => {
        const client = project.clientName || 'Zonder klant';
        if (client !== lastClient) {
            html += `<div class="combo-group">${highlight(client, query)}</div>`;
            lastClient = client;
        }
        html += `<div class="combo-item ${index === state.form.active ? 'active' : ''}" role="option" data-idx="${index}">
      <span>${highlight(project.name, query)}</span>${project.code ? `<span class="code">${highlight(project.code, query)}</span>` : ''}</div>`;
    });
    list.innerHTML = html;
    list.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openCombo() {
    if (!state.form) return;
    findElement('#combo-list').hidden = false;
    findElement('#f-project').setAttribute('aria-expanded', 'true');
    const index = state.form.projectId ? state.projects.findIndex((project) => project.id === state.form.projectId) : 0;
    state.form.active = Math.max(0, index);
    renderCombo();
}
function closeCombo() {
    findElement('#combo-list').hidden = true;
    findElement('#f-project').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- settings

async function openSettings() {
    show('settings');
    const prefs = await run(keitoBridge.prefsGet()).catch(() => null);
    if (prefs) Object.assign(state.prefs, prefs);
    const me = state.me || {};
    findElement('#s-avatar').textContent = (me.name || '?')
        .split(' ')
        .map((word) => word[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
    findElement('#s-name').textContent = me.name || '';
    findElement('#s-company').textContent = [me.companyName, me.email].filter(Boolean).join(' · ');
    findElement('#s-shortcut').textContent = (state.prefs.shortcut || '')
        .replace('CommandOrControl', '⌘')
        .replace('Shift', '⇧')
        .replace(/\+/g, '');
    findElement('#s-storage').textContent = state.prefs.encrypted
        ? 'API keys staan versleuteld opgeslagen (macOS-sleutelhanger).'
        : '';
    syncPrefControls();
    renderJiraSettings();
}

function renderJiraSettings() {
    const jira = state.jira;
    findElement('#j-state').textContent = jira.configured ? 'Gekoppeld' : 'Niet gekoppeld';
    findElement('#j-connected').hidden = !jira.configured;
    findElement('#jira-form').hidden = jira.configured;
    if (jira.configured)
        findElement('#j-who').textContent = [jira.name, jira.site?.replace(/^https:\/\//, '')]
            .filter(Boolean)
            .join(' · ');
    else {
        if (!findElement('#j-site').value && jira.site)
            findElement('#j-site').value = jira.site.replace(/^https:\/\//, '');
        if (!findElement('#j-email').value) findElement('#j-email').value = jira.email || state.me?.email || '';
    }
}

findElement('#jira-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = findElement('#j-submit');
    submitButton.disabled = true;
    submitButton.textContent = 'Koppelen…';
    const result = await keitoBridge.jiraSave({
        site: findElement('#j-site').value,
        email: findElement('#j-email').value,
        token: findElement('#j-token').value,
    });
    submitButton.disabled = false;
    submitButton.textContent = 'Koppelen';
    if (!result.ok) {
        toast(result.error.message, 'error');
        return;
    }
    findElement('#j-token').value = '';
    state.jira = result.data;
    state.jiraCache.clear();
    toast(`Jira gekoppeld${state.jira.name ? ` als ${state.jira.name}` : ''}`);
    renderJiraSettings();
});

// ---------------------------------------------------------------- accent colour

const ACCENTS = [
    { name: 'Oranje', hex: null }, // default (slightly brighter in dark mode)
    { name: 'Roze', hex: '#e0457b' },
    { name: 'Paars', hex: '#7c5cf0' },
    { name: 'Blauw', hex: '#2f6fed' },
    { name: 'Teal', hex: '#0f9488' },
    { name: 'Groen', hex: '#3f9b3a' },
    { name: 'Goud', hex: '#d9a21b' },
    { name: 'Grafiet', hex: '#4a4f5c' },
];
const DEFAULT_ACCENT = '#f0662a';

/** White or near-black text, whichever reads better on the accent (WCAG relative luminance). */
function inkFor(hex) {
    const [red, green, blue] = [1, 3, 5]
        .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const onWhite = 1.05 / (luminance + 0.05);
    const onDark = (luminance + 0.05) / 0.061;
    // Prefer white text (looks best on buttons) as long as it is readable.
    return onWhite >= 2.6 || onWhite >= onDark ? '#ffffff' : '#1b1c20';
}

function applyAccent(hex) {
    const root = document.documentElement.style;
    if (!hex) {
        root.removeProperty('--accent');
        root.removeProperty('--accent-ink');
        return;
    }
    root.setProperty('--accent', hex);
    root.setProperty('--accent-ink', inkFor(hex));
}

function renderSwatches() {
    const current = state.prefs.accent || null;
    const isPreset = ACCENTS.some((accent) => accent.hex === current);
    findElement('#swatches').innerHTML =
        ACCENTS.map(
            (accent) => `
    <button class="swatch ${accent.hex === current ? 'on' : ''}" data-c="${accent.hex || DEFAULT_ACCENT}"
      data-accent="${accent.hex || ''}" role="radio" aria-checked="${accent.hex === current}" title="${accent.name}" aria-label="${accent.name}"></button>`,
        ).join('') +
        `
    <label class="swatch custom ${!isPreset ? 'on' : ''}" data-c="${!isPreset ? current : DEFAULT_ACCENT}" title="Eigen kleur">
      <input type="color" id="accent-custom" value="${!isPreset ? current : DEFAULT_ACCENT}" aria-label="Eigen kleur" />
    </label>`;
    // CSP forbids inline style attributes; CSSOM is fine.
    document
        .querySelectorAll('.swatch[data-c]')
        .forEach((element) => element.style.setProperty('--c', element.dataset.c));
}

function setAccent(hex, { live = false } = {}) {
    state.prefs.accent = hex;
    applyAccent(hex);
    if (live) {
        // Dragging in the colour picker: don't rebuild the swatches (that would close the picker).
        document
            .querySelectorAll('.swatch')
            .forEach((element) => element.classList.toggle('on', element.classList.contains('custom')));
        document.querySelector('.swatch.custom')?.style.setProperty('--c', hex);
    } else {
        renderSwatches();
    }
    clearTimeout(setAccent.t);
    setAccent.t = setTimeout(() => keitoBridge.prefsSet({ accent: hex }).catch(() => {}), 250); // colour picker fires a lot
}

function syncPrefControls() {
    renderSwatches();
    document
        .querySelectorAll('[data-pref="timeFormat"]')
        .forEach((button) => button.classList.toggle('on', button.dataset.val === state.prefs.timeFormat));
    document
        .querySelectorAll('input[type="checkbox"][data-pref]')
        .forEach((input) => (input.checked = !!state.prefs[input.dataset.pref]));
    document.querySelectorAll('input[type="time"][data-pref]').forEach((input) => {
        if (document.activeElement !== input) input.value = state.prefs[input.dataset.pref] || '';
    });
    document
        .querySelectorAll('[data-dep]')
        .forEach((row) => row.classList.toggle('off', !state.prefs[row.dataset.dep]));
    const workdays = state.prefs.workdays || [1, 2, 3, 4, 5];
    document
        .querySelectorAll('[data-wd]')
        .forEach((button) => button.classList.toggle('on', workdays.includes(+button.dataset.wd)));
    document
        .querySelectorAll('select[data-pref]')
        .forEach((selectElement) => (selectElement.value = String(state.prefs[selectElement.dataset.pref] ?? '')));
    const minutes = findElement('select[data-pref="idleMinutes"]');
    if (minutes) minutes.disabled = !state.prefs.idleEnabled;
}

async function setPref(patch) {
    Object.assign(state.prefs, patch);
    syncPrefControls();
    await run(keitoBridge.prefsSet(patch)).catch(() => {});
}

// ---------------------------------------------------------------- boot / auth

async function boot() {
    show('loading');
    const prefs = await keitoBridge.prefsGet();
    if (prefs.ok) Object.assign(state.prefs, prefs.data);
    applyAccent(state.prefs.accent);
    const result = await keitoBridge.authStatus();
    if (!result.ok) {
        show('setup');
        toast(result.error.message, 'error');
        return;
    }
    if (!result.data.connected) {
        show('setup');
        findElement('#setup-token').focus();
        return;
    }
    state.me = result.data.me;
    const jiraResult = await keitoBridge.jiraStatus();
    if (jiraResult.ok) state.jira = jiraResult.data;
    enterMain();
    const idle = await keitoBridge.idleGet();
    if (idle.ok && idle.data) showIdle(idle.data);
    const nudge = await keitoBridge.nudgeGet();
    if (nudge.ok && nudge.data) showNudge(nudge.data);
}

function enterMain() {
    show('main');
    state.selected = todayIsoDate();
    state.weekStart = mondayOf(state.selected);
    state.lastSeenToday = state.selected;
    loadWeek();
    loadProjects()
        .then(render)
        .catch(() => {});
}

findElement('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = findElement('#setup-submit');
    submitButton.disabled = true;
    submitButton.textContent = 'Verbinden…';
    const result = await keitoBridge.authSave({
        token: findElement('#setup-token').value,
        accountId: findElement('#setup-account').value,
    });
    submitButton.disabled = false;
    submitButton.textContent = 'Verbinden';
    if (!result.ok) {
        toast(result.error.message, 'error');
        return;
    }
    findElement('#setup-token').value = '';
    state.me = result.data.me;
    toast(`Verbonden als ${state.me.name}`);
    enterMain();
});

// ---------------------------------------------------------------- events

document.addEventListener('click', (event) => {
    const target = event.target;
    const timer = target.closest('[data-timer]');
    if (timer) {
        event.stopPropagation();
        toggleTimer(timer.dataset.timer);
        return;
    }
    const tag = target.closest('[data-jira]');
    if (tag) {
        keitoBridge.jiraOpen(tag.dataset.jira);
        return;
    }
    const jItem = target.closest('.jira-item');
    if (jItem) {
        pickJira(+jItem.dataset.jidx);
        return;
    }
    if (!target.closest('#jira-combo')) closeJira();
    const day = target.closest('[data-day]');
    if (day) {
        selectDay(day.dataset.day);
        return;
    }
    const item = target.closest('.combo-item');
    if (item && state.form) {
        chooseProject(state.form.items[+item.dataset.idx].id);
        return;
    }
    const entry = target.closest('[data-entry]');
    if (entry && state.view === 'main') {
        const clickedEntry = state.entries.find((candidate) => candidate.id === entry.dataset.entry);
        if (clickedEntry && !clickedEntry.locked) openForm(clickedEntry);
        else if (clickedEntry) toast(clickedEntry.lockedReason || 'Deze registratie is vergrendeld.');
        return;
    }
    const wdBtn = target.closest('button[data-wd]');
    if (wdBtn) {
        const weekday = +wdBtn.dataset.wd;
        const current = new Set(state.prefs.workdays || [1, 2, 3, 4, 5]);
        current.has(weekday) ? current.delete(weekday) : current.add(weekday);
        setPref({ workdays: [...current].sort() });
        return;
    }
    const swatch = target.closest('button[data-accent]');
    if (swatch) {
        setAccent(swatch.dataset.accent || null);
        return;
    }
    const pref = target.closest('button[data-pref]');
    if (pref) {
        setPref({ [pref.dataset.pref]: pref.dataset.val });
        return;
    }
    if (!target.closest('.combo')) closeCombo();

    const action = target.closest('[data-act]')?.dataset.act;
    switch (action) {
        case 'prev-week':
            selectDay(addDays(state.selected, -7));
            break;
        case 'next-week':
            selectDay(addDays(state.selected, 7));
            break;
        case 'today':
            selectDay(todayIsoDate());
            break;
        case 'new':
            openForm(null);
            break;
        case 'cancel-form':
            closeForm();
            break;
        case 'delete':
            deleteEntry();
            break;
        case 'settings':
            openSettings();
            break;
        case 'back':
            show('main');
            render();
            break;
        case 'open-web':
            keitoBridge.openWeb();
            break;
        case 'open-web-settings':
            keitoBridge.openWeb('/settings');
            break;
        case 'quit':
            keitoBridge.quit();
            break;
        case 'jira-open':
            if (state.form?.jira) keitoBridge.jiraOpen(state.form.jira.key);
            break;
        case 'jira-unlink':
            setJiraIssue(null);
            findElement('#f-jira').focus();
            break;
        case 'jira-token-page':
            keitoBridge.jiraTokenPage();
            break;
        case 'update-check':
            checkUpdates();
            break;
        case 'update-install':
            keitoBridge.updateInstall();
            break;
        case 'test-nudge': {
            const type = target.closest('[data-act]').dataset.type;
            run(keitoBridge.nudgeTest(type)).catch(() => {});
            break;
        }
        case 'jira-logout':
            keitoBridge.jiraClear().then((result) => {
                if (result.ok) state.jira = result.data;
                state.jiraCache.clear();
                renderJiraSettings();
            });
            break;
        case 'logout':
            keitoBridge.authClear().then(() => {
                state.me = null;
                state.weeks.clear();
                state.entries = [];
                state.projects = [];
                state.tasks.clear();
                show('setup');
            });
            break;
    }
});

document.addEventListener('input', (event) => {
    if (event.target.id === 'accent-custom') setAccent(event.target.value.toLowerCase(), { live: true });
});

document.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-pref]');
    if (input && input.type === 'checkbox') setPref({ [input.dataset.pref]: input.checked });
    else if (input && input.type === 'time' && /^\d{2}:\d{2}$/.test(input.value))
        setPref({ [input.dataset.pref]: input.value });
    const selectElement = event.target.closest('select[data-pref]');
    if (selectElement) setPref({ [selectElement.dataset.pref]: Number(selectElement.value) });
});

findElement('#entry-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm();
});
findElement('#f-duration').addEventListener('input', updateSubmitLabel);
findElement('#f-duration').addEventListener('blur', () => {
    const hours = parseDuration(findElement('#f-duration').value);
    if (hours !== null && !Number.isNaN(hours)) findElement('#f-duration').value = formatHours(hours);
    updateSubmitLabel();
});
findElement('#f-project').addEventListener('focus', () => {
    closeJira();
    findElement('#f-project').select();
    openCombo();
});
findElement('#f-project').addEventListener('input', () => {
    if (state.form) state.form.active = 0;
    openCombo();
    renderCombo();
});
findElement('#f-project').addEventListener('keydown', (event) => {
    const form = state.form;
    if (!form) return;
    const open = !findElement('#combo-list').hidden;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) {
            openCombo();
            return;
        }
        const count = (form.items || []).length;
        if (!count) return;
        form.active = (form.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderCombo();
    } else if (event.key === 'Enter' && open && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const project = form.items?.[form.active];
        if (project) chooseProject(project.id);
    } else if (event.key === 'Tab' && open) {
        const project = form.items?.[form.active];
        if (project && findElement('#f-project').value.trim() && project.id !== form.projectId) {
            event.preventDefault();
            chooseProject(project.id);
        } else closeCombo();
    }
});
findElement('#combo-list').addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in input
findElement('#combo-list').addEventListener('mousemove', (event) => {
    const item = event.target.closest('.combo-item');
    if (item && state.form && state.form.active !== +item.dataset.idx) {
        state.form.active = +item.dataset.idx;
        document
            .querySelectorAll('.combo-item')
            .forEach((element) => element.classList.toggle('active', element === item));
    }
});

findElement('#f-jira').addEventListener('focus', () => {
    closeCombo();
    searchJira();
});
findElement('#f-jira').addEventListener('input', () => {
    clearTimeout(jiraTimer);
    jiraTimer = setTimeout(searchJira, 250);
});
findElement('#f-jira').addEventListener('keydown', (event) => {
    const form = state.form;
    if (!form) return;
    const open = !findElement('#jira-list').hidden;
    const count = (form.jiraItems || []).length;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
        event.preventDefault();
        if (!open) {
            searchJira();
            return;
        }
        form.jiraActive = ((form.jiraActive || 0) + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderJira(findElement('#f-jira').value.trim());
    } else if (event.key === 'Enter' && open && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (count) pickJira(form.jiraActive || 0);
    } else if (event.key === 'Tab') {
        closeJira();
    }
});
findElement('#jira-list').addEventListener('mousedown', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
    const inField = event.target.matches('input, textarea, select');

    if (state.nudge && !state.idle) {
        if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
            const nudgeAction = state.nudge.actions?.[+event.key - 1];
            if (nudgeAction) {
                event.preventDefault();
                resolveNudge(nudgeAction.id);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            keitoBridge.hide();
        }
        return;
    }

    if (state.idle) {
        if (/^[1-4]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            resolveIdle(['remove-continue', 'remove-stop', 'reassign', 'keep'][+event.key - 1]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            keitoBridge.hide(); // question stays open until answered
        }
        return;
    }

    if (state.form && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        focusJira();
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        if (state.form && !findElement('#jira-list').hidden) {
            closeJira();
            return;
        }
        if (state.form && !findElement('#combo-list').hidden && state.form.projectId) {
            closeCombo();
            return;
        }
        if (state.form) {
            closeForm();
            return;
        }
        if (state.view === 'settings') {
            show('main');
            render();
            return;
        }
        keitoBridge.hide();
        return;
    }
    if (state.form && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitForm();
        return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        if (state.me) openSettings();
        return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        invalidateWeeks();
        loadWeek();
        return;
    }

    if (inField || state.form || state.view !== 'main' || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectDay(addDays(state.selected, event.shiftKey ? -7 : -1));
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectDay(addDays(state.selected, event.shiftKey ? 7 : 1));
    } else if (/^[1-7]$/.test(event.key)) selectDay(addDays(state.weekStart, +event.key - 1));
    else if (event.key.toLowerCase() === 't') selectDay(todayIsoDate());
    else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openForm(null);
    } else if (event.key.toLowerCase() === 's') stopRunning();
});

// ---------------------------------------------------------------- idle time

function formatAwayDuration(hours) {
    const mins = Math.max(1, Math.round(hours * 60));
    if (mins < 60) return `${mins} min`;
    const wholeHours = Math.floor(mins / 60),
        restMinutes = mins % 60;
    return restMinutes ? `${wholeHours} u ${restMinutes} min` : `${wholeHours} uur`;
}
const formatClock = (timestamp) => {
    const date = new Date(timestamp);
    return `${padZero(date.getHours())}:${padZero(date.getMinutes())}`;
};

function showIdle(pending) {
    if (!pending || !state.me) return;
    state.idle = pending;
    closeCombo();
    closeJira();
    findElement('#idle-dur').textContent = formatAwayDuration(pending.hours);
    document
        .querySelectorAll('.idle-dur')
        .forEach((element) => (element.textContent = formatAwayDuration(pending.hours)));
    findElement('#idle-range').textContent = `${formatClock(pending.from)} – ${formatClock(pending.to)}`;
    const proj = state.projectsById.get(state.entries.find((entry) => entry.id === pending.entryId)?.projectId);
    findElement('#idle-project').textContent = pending.projectName || proj?.name || 'Lopende timer';
    findElement('#idle-task').textContent = [pending.clientName || proj?.clientName, pending.taskName]
        .filter(Boolean)
        .join(' · ');
    document.querySelectorAll('[data-idle]').forEach((button) => (button.disabled = false));
    findElement('#view-idle').hidden = false;
}

function hideIdle() {
    state.idle = null;
    findElement('#view-idle').hidden = true;
}

async function resolveIdle(action) {
    const pending = state.idle;
    if (!pending || state.busy) return;
    state.busy = true;
    document.querySelectorAll('[data-idle]').forEach((button) => (button.disabled = true));
    const result = await keitoBridge.idleResolve(action);
    state.busy = false;
    hideIdle();
    invalidateWeeks();
    if (!result.ok) {
        toast(result.error.message, 'error');
        await loadWeek({ silent: true });
        return;
    }
    const away = formatAwayDuration(pending.hours);
    if (action === 'keep') toast('Timer loopt gewoon door');
    else if (action === 'remove-stop') toast(`${away} eraf gehaald, timer gestopt`);
    else if (action === 'remove-continue') toast(`${away} eraf gehaald`);
    if (state.view !== 'main') {
        show('main');
    }
    state.selected = todayIsoDate();
    state.weekStart = mondayOf(state.selected);
    await loadWeek({ silent: true });
    if (action === 'reassign') {
        openForm(null, { hours: pending.hours });
        findElement('#duration-hint').textContent =
            `Idle-tijd ${formatClock(pending.from)}–${formatClock(pending.to)}. Kies waar je mee bezig was.`;
    }
}

document.addEventListener(
    'click',
    (event) => {
        const button = event.target.closest('[data-idle]');
        if (button) {
            event.stopPropagation();
            resolveIdle(button.dataset.idle);
        }
    },
    true,
);

keitoBridge.on('idle', (pending) => showIdle(pending));

// ---------------------------------------------------------------- day reminders

const ICON_PLAYCIRCLE =
    '<svg viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke="none"/></svg>';
const ICON_HOURGLASS =
    '<svg viewBox="0 0 24 24" stroke-width="2"><path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/></svg>';

function greeting(name) {
    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond';
    return name ? `${salutation}, ${name}` : salutation;
}

function showNudge(nudge) {
    if (!nudge || !state.me) return;
    const actions = [];
    if (nudge.type === 'start') {
        const project = nudge.suggest && state.projectsById.get(nudge.suggest.projectId);
        if (nudge.suggest && (project || !state.projects.length)) {
            const label = [nudge.suggest.projectName || project?.name, nudge.suggest.taskName]
                .filter(Boolean)
                .join(' · ');
            actions.push({ id: 'suggest', label: `Start ${label}`, primary: true });
        }
        actions.push({ id: 'new', label: 'Andere timer starten…', primary: !actions.length });
        actions.push({ id: 'snooze', label: 'Herinner me over 15 min' });
        actions.push({ id: 'dismiss', label: 'Vandaag niet meer vragen' });
        findElement('#nudge-mark').innerHTML = ICON_PLAYCIRCLE;
        findElement('#nudge-title').textContent = greeting(nudge.firstName);
        findElement('#nudge-text').textContent =
            nudge.total > 0
                ? `Er loopt nu geen timer (vandaag al ${formatHours(nudge.total)} geschreven).`
                : 'Je werkdag is begonnen, maar er loopt nog geen timer.';
        findElement('#nudge-progress').hidden = true;
    } else {
        const left = Math.max(0, nudge.minHours - nudge.total);
        actions.push({ id: 'fill', label: `Uren aanvullen (nog ${formatHours(left)})`, primary: true });
        actions.push({ id: 'review', label: 'Bekijk mijn dag' });
        actions.push({ id: 'snooze', label: 'Herinner me over 15 min' });
        actions.push({ id: 'dismiss', label: 'Klopt zo' });
        findElement('#nudge-mark').innerHTML = ICON_HOURGLASS;
        findElement('#nudge-title').textContent = `Je staat op ${formatHours(nudge.total)} vandaag`;
        findElement('#nudge-text').textContent =
            `Nog ${formatHours(left)} tot ${formatHours(nudge.minHours)}.${nudge.running ? ' Je timer loopt nog.' : ''} Even je uren nalopen?`;
        findElement('#nudge-progress').hidden = false;
        findElement('#nudge-fill').style.width = `${Math.min(100, (nudge.total / nudge.minHours) * 100)}%`;
        findElement('#nudge-have').textContent = formatHours(nudge.total);
        findElement('#nudge-goal').textContent = formatHours(nudge.minHours);
    }
    state.nudge = { ...nudge, actions };
    findElement('#nudge-actions').innerHTML = actions
        .map(
            (nudgeAction, index) =>
                `<button class="${nudgeAction.primary ? 'primary-btn' : 'ghost-btn'}" data-nudge="${nudgeAction.id}"><span class="label">${escapeHtml(nudgeAction.label)}</span> <kbd>${index + 1}</kbd></button>`,
        )
        .join('');
    closeCombo();
    closeJira();
    findElement('#view-nudge').hidden = false;
}

function hideNudge() {
    state.nudge = null;
    findElement('#view-nudge').hidden = true;
}

async function resolveNudge(id) {
    const nudge = state.nudge;
    if (!nudge || state.busy) return;
    hideNudge();
    // Main only needs to know: snooze, or answered.
    await keitoBridge.nudgeResolve(id === 'snooze' ? 'snooze' : id === 'dismiss' ? 'dismiss' : 'act');
    if (id === 'snooze') {
        toast('Ik herinner je over 15 minuten');
        keitoBridge.hide();
        return;
    }
    if (id === 'dismiss') {
        if (nudge.type === 'start') keitoBridge.hide();
        return;
    }

    if (state.view !== 'main') show('main');
    state.selected = todayIsoDate();
    state.weekStart = mondayOf(state.selected);
    invalidateWeeks();
    await loadWeek({ silent: true });

    if (id === 'suggest' && nudge.suggest) {
        state.busy = true;
        try {
            await run(
                keitoBridge.create({
                    project_id: nudge.suggest.projectId,
                    task_id: nudge.suggest.taskId,
                    spent_date: todayIsoDate(),
                    notes: '',
                    is_running: true,
                    replace_running: true,
                }),
            );
            toast(`Timer gestart: ${nudge.suggest.projectName || 'project'}`);
            invalidateWeeks();
            await loadWeek({ silent: true });
        } catch {
            /* toast shown */
        } finally {
            state.busy = false;
        }
    } else if (id === 'new') {
        openForm(null);
    } else if (id === 'fill') {
        const left = Math.max(0, nudge.minHours - nudge.total);
        await openForm(null, { hours: left });
        findElement('#duration-hint').textContent =
            `Ingevuld: wat er nog ontbreekt tot ${formatHours(nudge.minHours)}. Pas gerust aan.`;
    }
}

document.addEventListener(
    'click',
    (event) => {
        const button = event.target.closest('[data-nudge]');
        if (button) {
            event.stopPropagation();
            resolveNudge(button.dataset.nudge);
        }
    },
    true,
);

keitoBridge.on('nudge', (nudge) => showNudge(nudge));

// ---------------------------------------------------------------- updates

function renderUpdate(updateInfo) {
    if (!updateInfo) return;
    state.update = updateInfo;
    findElement('#update-banner').hidden = updateInfo.state !== 'ready';
    findElement('#update-version').textContent = updateInfo.version || '';
    findElement('#s-version').textContent = updateInfo.current ? `v${updateInfo.current}` : '';
    const updateButton = findElement('#btn-update');
    const label =
        {
            checking: 'Controleren…',
            downloading: `Versie ${updateInfo.version} downloaden…`,
            ready: `Versie ${updateInfo.version} klaar`,
            none: 'Je hebt de nieuwste versie',
            error: updateInfo.error || 'Controleren mislukte',
            unavailable: 'Updates werken alleen in de geïnstalleerde app',
        }[updateInfo.state] || '';
    findElement('#s-update').textContent = label;
    updateButton.textContent = updateInfo.state === 'ready' ? 'Herstart nu' : 'Controleer op updates';
    updateButton.dataset.act = updateInfo.state === 'ready' ? 'update-install' : 'update-check';
    updateButton.hidden =
        updateInfo.state === 'checking' || updateInfo.state === 'downloading' || updateInfo.state === 'unavailable';
}

async function checkUpdates() {
    renderUpdate({ ...(state.update || {}), state: 'checking' });
    const result = await keitoBridge.updateCheck();
    if (result.ok) renderUpdate(result.data);
}

keitoBridge.on('update', (updateInfo) => renderUpdate(updateInfo));
keitoBridge.updateStatus().then((result) => result.ok && renderUpdate(result.data));

// Window re-opened from the menubar: refresh, and follow "today" across midnight.
keitoBridge.on('window:shown', () => {
    if (!state.me) return;
    if (!state.idle)
        keitoBridge.idleGet().then((result) => {
            if (result.ok && result.data) showIdle(result.data);
        });
    if (!state.nudge)
        keitoBridge.nudgeGet().then((result) => {
            if (result.ok && result.data) showNudge(result.data);
        });
    const today = todayIsoDate();
    if (state.lastSeenToday !== today) {
        if (state.selected === state.lastSeenToday) {
            state.selected = today;
            state.weekStart = mondayOf(today);
        }
        state.lastSeenToday = today;
    }
    if (state.view === 'main' && !state.form) {
        invalidateWeeks();
        loadWeek({ silent: true });
        loadProjects().catch(() => {});
    }
});
keitoBridge.on('data:changed', () => {
    invalidateWeeks();
    if (state.me) loadWeek({ silent: true });
});
keitoBridge.on('nav', (where) => {
    if (where === 'settings' && state.me) {
        closeForm();
        openSettings();
    }
});

// If the main process is blocked (usually a macOS keychain prompt after an update), say so.
setTimeout(() => {
    if (state.view === 'loading') findElement('#loading-hint').hidden = false;
}, 4000);

boot();
