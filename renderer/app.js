/* Keito Bar — renderer. Plain JS, no framework. All API calls go through window.keito (preload). */
'use strict';

const K = window.keito;
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const mondayOf = (s) => { const d = parseYmd(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return ymd(d); };
function isoWeek(s) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}
const fmtDay = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDayShort = new Intl.DateTimeFormat('nl-NL', { weekday: 'short' });
const fmtMonth = new Intl.DateTimeFormat('nl-NL', { month: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- hours

function fmtH(hours) {
  if (S.prefs.timeFormat === 'decimal') return (Math.max(0, hours)).toFixed(2);
  const mins = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(mins / 60)}:${pad(mins % 60)}`;
}

/** "1:30", "1.5", "1,5", "90m", "1h30", "1h 30m", "45" (≤ 10 = hours, else minutes?) — keep it predictable: bare number = hours. */
function parseDuration(input) {
  const s = String(input || '').trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] + +m[2] / 60;
  if ((m = s.match(/^:(\d{1,2})$/))) return +m[1] / 60;
  if ((m = s.match(/^(\d+(?:\.\d+)?)(?:h|u|uur)(?:(\d+)m?(?:in)?)?$/))) return +m[1] + (m[2] ? +m[2] / 60 : 0);
  if ((m = s.match(/^(\d+)(?:m|min)$/))) return +m[1] / 60;
  if ((m = s.match(/^\d+(?:\.\d+)?$/))) return +s;
  return NaN;
}

// Running timers carry liveStartMs/liveBaseHours from the main process (see annotateRunning).
const liveHours = (e) => {
  if (!e.isRunning) return e.hours;
  if (e.liveStartMs) return e.liveBaseHours + Math.max(0, Date.now() - e.liveStartMs) / 3.6e6;
  return e.hours + (Date.now() - S.fetchedAt) / 3.6e6;
};

// ---------------------------------------------------------------- state

const S = {
  me: null,
  prefs: { timeFormat: 'hm' },
  projects: [],
  projectsById: new Map(),
  projectsLoadedAt: 0,
  tasks: new Map(), // projectId -> tasks[]
  weekStart: mondayOf(todayStr()),
  selected: todayStr(),
  weeks: new Map(), // weekStart -> { entries, fetchedAt }
  entries: [],
  fetchedAt: Date.now(),
  loadingWeek: false,
  view: 'loading',
  form: null,
  lastSeenToday: todayStr(),
  busy: false,
  jira: { configured: false },
  jiraCache: new Map(), // default-list key -> { at, items }
};

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
const JIRA_KEY_RE_G = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 2500);
}

async function run(promise, { quiet = false } = {}) {
  const res = await promise;
  if (!res.ok) {
    if (res.error.kind === 'auth' && S.view !== 'setup') {
      toast(res.error.message, 'error');
    } else if (!quiet) {
      toast(res.error.message, 'error');
    }
    throw Object.assign(new Error(res.error.message), { kind: res.error.kind, handled: true });
  }
  return res.data;
}

function show(view) {
  S.view = view;
  for (const v of ['main', 'settings', 'setup', 'loading']) $(`#view-${v}`).hidden = v !== view;
  if (view !== 'main') $('#view-form').hidden = true;
}

// ---------------------------------------------------------------- data

async function loadProjects(force = false) {
  if (!force && S.projects.length && Date.now() - S.projectsLoadedAt < 30 * 60e3) return;
  const list = await run(K.projects(), { quiet: S.projects.length > 0 });
  list.sort((a, b) =>
    (a.clientName || '~').localeCompare(b.clientName || '~', 'nl') || a.name.localeCompare(b.name, 'nl'));
  S.projects = list;
  S.projectsById = new Map(list.map((p) => [p.id, p]));
  S.projectsLoadedAt = Date.now();
}

async function loadTasks(projectId) {
  if (S.tasks.has(projectId)) return S.tasks.get(projectId);
  const list = await run(K.tasks(projectId));
  S.tasks.set(projectId, list);
  return list;
}

let weekReq = 0;
async function loadWeek({ silent = false } = {}) {
  const key = S.weekStart;
  const cached = S.weeks.get(key);
  if (cached) { S.entries = cached.entries; S.fetchedAt = cached.fetchedAt; }
  else { S.entries = []; }
  S.loadingWeek = !cached;
  render();

  const req = ++weekReq;
  try {
    const data = await run(K.entries({ from: key, to: addDays(key, 6) }), { quiet: silent && !!cached });
    S.weeks.set(key, data);
    if (req !== weekReq || key !== S.weekStart) return; // user moved on
    S.entries = data.entries;
    S.fetchedAt = data.fetchedAt;
  } catch {
    /* toast already shown */
  } finally {
    if (req === weekReq) { S.loadingWeek = false; render(); }
  }
}

function invalidateWeeks() { S.weeks.clear(); }

// ---------------------------------------------------------------- navigation

function selectDay(date) {
  S.selected = date;
  const wk = mondayOf(date);
  if (wk !== S.weekStart) { S.weekStart = wk; loadWeek({ silent: true }); }
  else render();
}

// ---------------------------------------------------------------- rendering

const ICON_PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.8v8.4c0 .4.4.6.7.4l6.6-4.2a.5.5 0 0 0 0-.8L3.7 1.4c-.3-.2-.7 0-.7.4Z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

function entriesOn(date) {
  return S.entries
    .filter((e) => e.spentDate === date)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
const sum = (list) => list.reduce((t, e) => t + liveHours(e), 0);

function render() {
  if (S.view !== 'main') return;
  const today = todayStr();
  const week = S.weekStart;

  // Header
  const end = addDays(week, 6);
  const a = parseYmd(week), b = parseYmd(end);
  $('#week-title').textContent = `Week ${isoWeek(week)}`;
  $('#week-range').textContent = a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${b.getDate()} ${fmtMonth.format(b)} ${b.getFullYear()}`
    : `${a.getDate()} ${fmtMonth.format(a)} – ${b.getDate()} ${fmtMonth.format(b)}`;
  $('#btn-today').classList.toggle('is-hidden', S.selected === today);

  // Week strip
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(week, i);
    const list = entriesOn(d);
    const total = sum(list);
    const cls = ['day', d === S.selected && 'selected', d === today && 'today', i >= 5 && 'weekend'].filter(Boolean).join(' ');
    const hrs = S.loadingWeek ? '' : total > 0 ? fmtH(total) : '–';
    html += `<button class="${cls}" data-day="${d}" title="${cap(fmtDay.format(parseYmd(d)))} (${i + 1})">
      ${list.some((e) => e.isRunning) ? '<span class="run-dot"></span>' : ''}
      <span class="day-name">${fmtDayShort.format(parseYmd(d)).replace('.', '')}</span>
      <span class="day-num">${parseYmd(d).getDate()}</span>
      <span class="day-hours ${total > 0 ? '' : 'empty'}" ${list.some((e) => e.isRunning) ? 'data-live-day="' + d + '"' : ''}>${hrs}</span>
    </button>`;
  }
  $('#week').innerHTML = html;

  // Day header
  const dayList = entriesOn(S.selected);
  $('#day-title').textContent = S.selected === today ? `Vandaag · ${fmtDay.format(parseYmd(S.selected)).split(' ').slice(1).join(' ')}` : cap(fmtDay.format(parseYmd(S.selected)));
  $('#day-total').textContent = S.loadingWeek ? '' : fmtH(sum(dayList));
  $('#week-total').textContent = S.loadingWeek ? '' : `week ${fmtH(sum(S.entries))}`;

  // Entries
  const box = $('#entries');
  if (S.loadingWeek) {
    box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  } else if (!dayList.length) {
    const isToday = S.selected === today;
    box.innerHTML = `<div class="empty-state">
      <strong>${isToday ? 'Nog niets geschreven vandaag' : 'Geen uren op deze dag'}</strong>
      <span>Druk op <kbd>N</kbd> om ${isToday ? 'een timer te starten' : 'uren toe te voegen'}.</span>
    </div>`;
  } else {
    box.innerHTML = dayList.map((e) => entryHtml(e, today)).join('');
  }

  $('#new-label').textContent = S.selected === today ? 'Nieuwe registratie' : `Uren toevoegen op ${fmtDayShort.format(parseYmd(S.selected)).replace('.', '')} ${parseYmd(S.selected).getDate()}`;

  // Menubar shows today's total when no timer runs
  if (mondayOf(today) === S.weekStart && !S.loadingWeek) K.setTodayTotal(entriesOn(today).filter((e) => !e.isRunning).reduce((t, e) => t + e.hours, 0));
}

function entryHtml(e, today) {
  const p = S.projectsById.get(e.projectId);
  const project = e.projectName || p?.name || 'Onbekend project';
  const client = e.clientName || p?.clientName || '';
  const task = e.taskName || S.tasks.get(e.projectId)?.find((t) => t.id === e.taskId)?.name || '';
  const canTimer = !e.locked && (e.isRunning || e.spentDate === today);
  const btn = e.locked
    ? `<span class="lock" title="${esc(e.lockedReason)}">${ICON_LOCK}</span>`
    : canTimer
      ? `<button class="timer-btn ${e.isRunning ? 'stop' : ''}" data-timer="${esc(e.id)}" title="${e.isRunning ? 'Stop timer (S)' : 'Hervat timer'}" aria-label="${e.isRunning ? 'Stop timer' : 'Start timer'}">${e.isRunning ? ICON_STOP : ICON_PLAY}</button>`
      : '<span class="timer-btn placeholder"></span>';
  const span = e.startedTime && e.endedTime ? ` · ${e.startedTime}–${e.endedTime}` : '';
  return `<div class="entry ${e.isRunning ? 'running' : ''} ${e.locked ? 'locked' : ''}" data-entry="${esc(e.id)}" role="listitem" title="${e.locked ? esc(e.lockedReason) : 'Klik om te bewerken'}">
    <div class="entry-main">
      <div class="entry-project"><b>${esc(project)}</b>${client ? `<span class="entry-client">${esc(client)}</span>` : ''}</div>
      <div class="entry-meta"><span class="task">${esc(task)}</span>${e.notes ? ` · ${notesHtml(e.notes)}` : ''}${span}</div>
    </div>
    <div class="entry-time" ${e.isRunning ? `data-live="${esc(e.id)}"` : ''}>${fmtH(liveHours(e))}</div>
    ${btn}
  </div>`;
}

/** Notes with Jira keys turned into clickable tags (only when Jira is linked). */
function notesHtml(notes) {
  const safe = esc(notes);
  if (!S.jira.configured) return safe;
  return safe.replace(JIRA_KEY_RE_G, '<span class="jira-tag" data-jira="$1" title="Open $1 in Jira">$1</span>');
}

// Live ticking of running timers without full re-render.
setInterval(() => {
  if (S.view !== 'main') return;
  const runningEntry = S.entries.find((e) => e.isRunning);
  if (!runningEntry) return;
  document.querySelectorAll('[data-live]').forEach((el) => {
    const e = S.entries.find((x) => x.id === el.dataset.live);
    if (e) el.textContent = fmtH(liveHours(e));
  });
  document.querySelectorAll('[data-live-day]').forEach((el) => (el.textContent = fmtH(sum(entriesOn(el.dataset.liveDay)))));
  if (runningEntry.spentDate === S.selected) $('#day-total').textContent = fmtH(sum(entriesOn(S.selected)));
  $('#week-total').textContent = `week ${fmtH(sum(S.entries))}`;
}, 1000);

// ---------------------------------------------------------------- timer actions

async function toggleTimer(id) {
  if (S.busy) return;
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  S.busy = true;
  try {
    if (e.isRunning) await run(K.stop(id));
    else await run(K.restart(id));
    invalidateWeeks();
    await loadWeek({ silent: true });
  } catch { /* toast shown */ } finally { S.busy = false; }
}

function stopRunning() {
  const r = S.entries.find((e) => e.isRunning);
  if (r) toggleTimer(r.id);
}

// ---------------------------------------------------------------- form

async function openForm(entry, prefill = {}) {
  const date = entry ? entry.spentDate : S.selected;
  const p = entry ? S.projectsById.get(entry.projectId) : null;
  S.form = {
    id: entry?.id || null,
    date,
    isRunning: !!entry?.isRunning,
    projectId: entry?.projectId || null,
    taskId: entry?.taskId || null,
    query: '',
    active: 0,
    confirmDelete: false,
  };
  $('#view-form').hidden = false;
  $('#form-title').textContent = entry ? 'Bewerken' : date === todayStr() ? 'Nieuwe registratie' : 'Uren toevoegen';
  $('#form-date').textContent = cap(fmtDay.format(parseYmd(date)).split(' ').slice(0, 2).join(' '));
  $('#f-project').value = entry ? projectLabel(p || { name: entry.projectName, clientName: entry.clientName }) : '';
  $('#f-notes').value = entry?.notes || '';
  $('#f-duration').value = entry && !entry.isRunning ? fmtH(entry.hours) : '';
  $('#f-duration').disabled = !!entry?.isRunning;
  if (prefill.hours) $('#f-duration').value = fmtH(prefill.hours);
  if (prefill.notes) $('#f-notes').value = prefill.notes;
  $('#notes-required').hidden = !S.me?.requireNotes;
  $('#btn-delete').hidden = !entry;
  $('#btn-delete').classList.remove('confirm');
  $('#btn-delete').textContent = 'Verwijderen';
  setTaskOptions([], null, true);
  updateSubmitLabel();
  closeCombo();
  closeJira();
  $('#jira-field').hidden = !S.jira.configured;
  $('#f-jira').value = '';
  // Existing note "KEY-1 · summary — own text": ticket goes to the chip, own text to the textarea.
  const m = S.jira.configured && entry?.notes?.match(/^([A-Z][A-Z0-9_]+-\d+)(?:\s*·\s*(.*?))?(?:\s+—\s+([\s\S]*))?$/);
  if (m) {
    setJiraIssue({ key: m[1], summary: m[2] || '', projectKey: m[1].split('-')[0] });
    $('#f-notes').value = m[3] || '';
  } else {
    setJiraIssue(null);
  }

  if (entry) {
    if (entry.projectId) await chooseProject(entry.projectId, entry.taskId, { focusNext: false });
    $('#f-notes').focus();
  } else {
    $('#f-project').focus();
    openCombo();
  }
  loadProjects().then(() => { if (!$('#combo-list').hidden) renderCombo(); }).catch(() => {});
}

function closeForm() {
  S.form = null;
  $('#view-form').hidden = true;
  closeCombo();
  closeJira();
}

// ---------------------------------------------------------------- jira picker

const jiraPrefix = (issue) => (issue.summary ? `${issue.key} · ${issue.summary}` : issue.key);

/** Link a ticket to the form. Saved notes become "KEY · summary — your notes". */
function setJiraIssue(issue) {
  const f = S.form;
  if (!f) return;
  f.jira = issue;
  $('#jira-chip').hidden = !issue;
  $('#jira-combo').hidden = !!issue;
  if (issue) {
    $('#jira-chip .jira-key').textContent = issue.key;
    $('#jira-chip .jira-sum').textContent = issue.summary || '';
  }
  $('#f-notes').placeholder = issue ? 'Optioneel: wat heb je gedaan?' : 'Waar werk je aan?';

  // Jira project ↔ Keito project: pick the Keito project you used last time for this Jira project.
  if (issue && !f.projectId) {
    const mapped = safeGet(`jira2keito:${issue.projectKey || issue.key.split('-')[0]}`);
    if (mapped && S.projectsById.has(mapped)) chooseProject(mapped, null, { focusNext: false });
  }
}

let jiraTimer = null;
let jiraReq = 0;
async function searchJira() {
  const f = S.form;
  if (!f || !S.jira.configured) return;
  const q = $('#f-jira').value.trim();
  const projectKey = f.projectId ? safeGet(`keito2jira:${f.projectId}`) : null;
  const cacheKey = `default:${projectKey || ''}`;
  const list = $('#jira-list');
  list.hidden = false;
  $('#f-jira').setAttribute('aria-expanded', 'true');

  if (!q && S.jiraCache.has(cacheKey) && Date.now() - S.jiraCache.get(cacheKey).at < 120e3) {
    f.jiraItems = S.jiraCache.get(cacheKey).items;
    f.jiraActive = 0;
    renderJira(q);
    return;
  }
  if (!f.jiraItems?.length) list.innerHTML = '<div class="combo-empty">Zoeken in Jira…</div>';
  const req = ++jiraReq;
  const res = await K.jiraSearch(q, projectKey);
  if (req !== jiraReq || S.form !== f) return;
  if (!res.ok) { list.innerHTML = `<div class="combo-empty">${esc(res.error.message)}</div>`; f.jiraItems = []; return; }
  f.jiraItems = res.data;
  f.jiraActive = 0;
  if (!q) S.jiraCache.set(cacheKey, { at: Date.now(), items: res.data });
  renderJira(q);
}

function renderJira(q) {
  const f = S.form;
  const list = $('#jira-list');
  if (!f || list.hidden) return;
  const items = f.jiraItems || [];
  if (!items.length) {
    list.innerHTML = `<div class="combo-empty">${q ? 'Geen tickets gevonden.' : 'Geen open tickets op jouw naam.'}</div>`;
    return;
  }
  list.innerHTML = (q ? '' : '<div class="combo-group">Open tickets</div>') + items.map((it, i) => `
    <div class="combo-item jira-item ${i === f.jiraActive ? 'active' : ''}" role="option" data-jidx="${i}">
      <span class="jkey">${esc(it.key)}</span><span class="jsum">${highlight(it.summary, q)}</span>${it.status ? `<span class="jstat">${esc(it.status)}</span>` : ''}
    </div>`).join('');
  list.querySelector('.jira-item.active')?.scrollIntoView({ block: 'nearest' });
}

function pickJira(idx) {
  const it = S.form?.jiraItems?.[idx];
  if (!it) return;
  setJiraIssue(it);
  closeJira();
  $('#f-notes').focus();
  const n = $('#f-notes');
  n.setSelectionRange(n.value.length, n.value.length);
}

function closeJira() {
  $('#jira-list').hidden = true;
  $('#f-jira').setAttribute('aria-expanded', 'false');
}

function focusJira() {
  if (!S.form || !S.jira.configured) return;
  if (S.form.jira) setJiraIssue(null);
  $('#f-jira').focus();
}

function projectLabel(p) {
  if (!p) return '';
  return p.clientName ? `${p.name} — ${p.clientName}` : p.name;
}

function setTaskOptions(tasks, selectedId, disabled = false) {
  const sel = $('#f-task');
  if (disabled || !tasks.length) {
    sel.innerHTML = `<option>${disabled ? 'Kies eerst een project' : 'Geen taken in dit project'}</option>`;
    sel.disabled = true;
    return;
  }
  sel.innerHTML = tasks.map((t) => `<option value="${esc(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  sel.disabled = false;
  if (!tasks.some((t) => t.id === selectedId)) sel.value = tasks[0].id;
}

async function chooseProject(projectId, taskId = null, { focusNext = true } = {}) {
  if (!S.form) return;
  S.form.projectId = projectId;
  const p = S.projectsById.get(projectId);
  if (p) $('#f-project').value = projectLabel(p);
  closeCombo();
  const sel = $('#f-task');
  sel.innerHTML = '<option>Taken laden…</option>';
  sel.disabled = true;
  try {
    const tasks = await loadTasks(projectId);
    if (!S.form || S.form.projectId !== projectId) return;
    // Remember the last task used per project — handy, and no "recent projects" noise.
    const remembered = taskId || safeGet(`lastTask:${projectId}`);
    setTaskOptions(tasks, remembered);
    if (focusNext) $('#f-notes').focus();
  } catch {
    setTaskOptions([], null);
  }
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

function updateSubmitLabel() {
  const f = S.form;
  if (!f) return;
  const btn = $('#btn-submit');
  const dur = $('#f-duration').value.trim();
  const isToday = f.date === todayStr();
  const startsTimer = !f.id && isToday && !dur;
  btn.innerHTML = `${f.id ? 'Opslaan' : startsTimer ? 'Start timer' : 'Opslaan'} <kbd>⌘↵</kbd>`;
  btn.classList.toggle('run', startsTimer);
  const parsed = parseDuration(dur);
  const hint = $('#duration-hint');
  if (f.isRunning) hint.textContent = 'Timer loopt — stop hem om de duur aan te passen.';
  else if (dur && Number.isNaN(parsed)) hint.textContent = 'Gebruik 1:30, 1.5, 90m of 1h30.';
  else if (dur && parsed !== null) hint.textContent = `= ${fmtH(parsed)} uur`;
  else if (!f.id && isToday) hint.textContent = 'Laat leeg om een timer te starten.';
  else hint.textContent = '1:30 · 1.5 · 90m · 1h30';
}

async function submitForm() {
  const f = S.form;
  if (!f || S.busy) return;
  const taskSel = $('#f-task');
  const notes = $('#f-notes').value.trim();
  const durRaw = $('#f-duration').value.trim();
  const hours = parseDuration(durRaw);

  if (!f.projectId) { toast('Kies een project.', 'error'); $('#f-project').focus(); openCombo(); return; }
  if (taskSel.disabled || !taskSel.value) { toast('Kies een taak.', 'error'); return; }
  if (S.me?.requireNotes && !notes && !f.jira) { toast('Notities zijn verplicht in jullie Keito.', 'error'); $('#f-notes').focus(); return; }
  if (durRaw && (Number.isNaN(hours) || hours < 0 || hours > 24)) { toast('Ongeldige duur.', 'error'); $('#f-duration').focus(); return; }

  const isToday = f.date === todayStr();
  let finalNotes = notes;
  let externalRef;
  if (f.jira) {
    finalNotes = finalNotes ? `${jiraPrefix(f.jira)} — ${finalNotes}` : jiraPrefix(f.jira);
    const jp = f.jira.projectKey || f.jira.key.split('-')[0];
    safeSet(`jira2keito:${jp}`, f.projectId);
    safeSet(`keito2jira:${f.projectId}`, jp);
    if (f.jira.url) {
      externalRef = {
        id: f.jira.id || f.jira.key,
        permalink: f.jira.url,
        service: new URL(f.jira.url).host,
        service_name: 'Jira',
        group_id: jp,
        display_name: f.jira.key,
      };
    }
  }
  const base = { project_id: f.projectId, task_id: taskSel.value, notes: finalNotes };
  safeSet(`lastTask:${f.projectId}`, taskSel.value);

  S.busy = true;
  $('#btn-submit').disabled = true;
  try {
    if (f.id) {
      const body = { ...base };
      if (!f.isRunning && hours !== null) body.hours = round(hours);
      await run(K.update(f.id, body));
      toast('Opgeslagen');
    } else if (hours === null) {
      if (!isToday) { toast('Vul een duur in voor een andere dag dan vandaag.', 'error'); $('#f-duration').focus(); return; }
      await run(K.create({ ...base, spent_date: f.date, is_running: true, replace_running: true, ...(externalRef && { external_reference: externalRef }) }));
      toast('Timer gestart');
    } else {
      await run(K.create({ ...base, spent_date: f.date, hours: round(hours), ...(externalRef && { external_reference: externalRef }) }));
      toast('Toegevoegd');
    }
    closeForm();
    invalidateWeeks();
    await loadWeek({ silent: true });
  } catch { /* toast shown */ } finally {
    S.busy = false;
    $('#btn-submit').disabled = false;
  }
}

const round = (h) => Math.round(h * 10000) / 10000;

async function deleteEntry() {
  const f = S.form;
  if (!f?.id) return;
  const btn = $('#btn-delete');
  if (!f.confirmDelete) {
    f.confirmDelete = true;
    btn.classList.add('confirm');
    btn.textContent = 'Zeker weten?';
    setTimeout(() => { if (S.form === f) { f.confirmDelete = false; btn.classList.remove('confirm'); btn.textContent = 'Verwijderen'; } }, 3000);
    return;
  }
  try {
    await run(K.remove(f.id));
    toast('Verwijderd');
    closeForm();
    invalidateWeeks();
    await loadWeek({ silent: true });
  } catch { /* toast shown */ }
}

// ---------------------------------------------------------------- project combobox

function filteredProjects() {
  const q = $('#f-project').value.trim().toLowerCase();
  const current = S.form?.projectId && projectLabel(S.projectsById.get(S.form.projectId)).toLowerCase();
  if (!q || q === current) return S.projects;
  const terms = q.split(/\s+/);
  return S.projects.filter((p) => {
    const hay = `${p.name} ${p.clientName || ''} ${p.code || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function highlight(text, q) {
  const s = esc(text);
  if (!q) return s;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return s;
  return s.replace(new RegExp(`(${terms.map(esc).join('|')})`, 'gi'), '<mark>$1</mark>');
}

function renderCombo() {
  const list = $('#combo-list');
  const items = filteredProjects();
  if (!S.form) return;
  S.form.items = items;
  if (S.form.active >= items.length) S.form.active = Math.max(0, items.length - 1);
  if (!S.projects.length) { list.innerHTML = '<div class="combo-empty">Projecten laden…</div>'; return; }
  if (!items.length) { list.innerHTML = '<div class="combo-empty">Geen project gevonden.</div>'; return; }
  const q = S.form.projectId && $('#f-project').value === projectLabel(S.projectsById.get(S.form.projectId)) ? '' : $('#f-project').value;
  let html = '';
  let lastClient = null;
  items.forEach((p, i) => {
    const client = p.clientName || 'Zonder klant';
    if (client !== lastClient) { html += `<div class="combo-group">${highlight(client, q)}</div>`; lastClient = client; }
    html += `<div class="combo-item ${i === S.form.active ? 'active' : ''}" role="option" data-idx="${i}">
      <span>${highlight(p.name, q)}</span>${p.code ? `<span class="code">${highlight(p.code, q)}</span>` : ''}</div>`;
  });
  list.innerHTML = html;
  list.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openCombo() {
  if (!S.form) return;
  $('#combo-list').hidden = false;
  $('#f-project').setAttribute('aria-expanded', 'true');
  const idx = S.form.projectId ? S.projects.findIndex((p) => p.id === S.form.projectId) : 0;
  S.form.active = Math.max(0, idx);
  renderCombo();
}
function closeCombo() {
  $('#combo-list').hidden = true;
  $('#f-project').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- settings

async function openSettings() {
  show('settings');
  const prefs = await run(K.prefsGet()).catch(() => null);
  if (prefs) Object.assign(S.prefs, prefs);
  const me = S.me || {};
  $('#s-avatar').textContent = (me.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  $('#s-name').textContent = me.name || '';
  $('#s-company').textContent = [me.companyName, me.email].filter(Boolean).join(' · ');
  $('#s-shortcut').textContent = (S.prefs.shortcut || '').replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace(/\+/g, '');
  $('#s-storage').textContent = S.prefs.encrypted ? 'API keys staan versleuteld opgeslagen (macOS-sleutelhanger).' : '';
  syncPrefControls();
  renderJiraSettings();
}

function renderJiraSettings() {
  const j = S.jira;
  $('#j-state').textContent = j.configured ? 'Gekoppeld' : 'Niet gekoppeld';
  $('#j-connected').hidden = !j.configured;
  $('#jira-form').hidden = j.configured;
  if (j.configured) $('#j-who').textContent = [j.name, j.site?.replace(/^https:\/\//, '')].filter(Boolean).join(' · ');
  else {
    if (!$('#j-site').value && j.site) $('#j-site').value = j.site.replace(/^https:\/\//, '');
    if (!$('#j-email').value) $('#j-email').value = j.email || S.me?.email || '';
  }
}

$('#jira-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#j-submit');
  btn.disabled = true;
  btn.textContent = 'Koppelen…';
  const res = await K.jiraSave({ site: $('#j-site').value, email: $('#j-email').value, token: $('#j-token').value });
  btn.disabled = false;
  btn.textContent = 'Koppelen';
  if (!res.ok) { toast(res.error.message, 'error'); return; }
  $('#j-token').value = '';
  S.jira = res.data;
  S.jiraCache.clear();
  toast(`Jira gekoppeld${S.jira.name ? ` als ${S.jira.name}` : ''}`);
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
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const onWhite = 1.05 / (L + 0.05);
  const onDark = (L + 0.05) / 0.061;
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
  const current = S.prefs.accent || null;
  const isPreset = ACCENTS.some((a) => a.hex === current);
  $('#swatches').innerHTML = ACCENTS.map((a) => `
    <button class="swatch ${a.hex === current ? 'on' : ''}" data-c="${a.hex || DEFAULT_ACCENT}"
      data-accent="${a.hex || ''}" role="radio" aria-checked="${a.hex === current}" title="${a.name}" aria-label="${a.name}"></button>`).join('') + `
    <label class="swatch custom ${!isPreset ? 'on' : ''}" data-c="${!isPreset ? current : DEFAULT_ACCENT}" title="Eigen kleur">
      <input type="color" id="accent-custom" value="${!isPreset ? current : DEFAULT_ACCENT}" aria-label="Eigen kleur" />
    </label>`;
  // CSP forbids inline style attributes; CSSOM is fine.
  document.querySelectorAll('.swatch[data-c]').forEach((el) => el.style.setProperty('--c', el.dataset.c));
}

function setAccent(hex, { live = false } = {}) {
  S.prefs.accent = hex;
  applyAccent(hex);
  if (live) {
    // Dragging in the colour picker: don't rebuild the swatches (that would close the picker).
    document.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('on', el.classList.contains('custom')));
    document.querySelector('.swatch.custom')?.style.setProperty('--c', hex);
  } else {
    renderSwatches();
  }
  clearTimeout(setAccent.t);
  setAccent.t = setTimeout(() => K.prefsSet({ accent: hex }).catch(() => {}), 250); // colour picker fires a lot
}

function syncPrefControls() {
  renderSwatches();
  document.querySelectorAll('[data-pref="timeFormat"]').forEach((b) => b.classList.toggle('on', b.dataset.val === S.prefs.timeFormat));
  document.querySelectorAll('input[type="checkbox"][data-pref]').forEach((i) => (i.checked = !!S.prefs[i.dataset.pref]));
  document.querySelectorAll('input[type="time"][data-pref]').forEach((i) => { if (document.activeElement !== i) i.value = S.prefs[i.dataset.pref] || ''; });
  document.querySelectorAll('[data-dep]').forEach((row) => row.classList.toggle('off', !S.prefs[row.dataset.dep]));
  const wd = S.prefs.workdays || [1, 2, 3, 4, 5];
  document.querySelectorAll('[data-wd]').forEach((b) => b.classList.toggle('on', wd.includes(+b.dataset.wd)));
  document.querySelectorAll('select[data-pref]').forEach((sel) => (sel.value = String(S.prefs[sel.dataset.pref] ?? '')));
  const minutes = $('select[data-pref="idleMinutes"]');
  if (minutes) minutes.disabled = !S.prefs.idleEnabled;
}

async function setPref(patch) {
  Object.assign(S.prefs, patch);
  syncPrefControls();
  await run(K.prefsSet(patch)).catch(() => {});
}

// ---------------------------------------------------------------- boot / auth

async function boot() {
  show('loading');
  const prefs = await K.prefsGet();
  if (prefs.ok) Object.assign(S.prefs, prefs.data);
  applyAccent(S.prefs.accent);
  const res = await K.authStatus();
  if (!res.ok) {
    show('setup');
    toast(res.error.message, 'error');
    return;
  }
  if (!res.data.connected) { show('setup'); $('#setup-token').focus(); return; }
  S.me = res.data.me;
  const j = await K.jiraStatus();
  if (j.ok) S.jira = j.data;
  enterMain();
  const idle = await K.idleGet();
  if (idle.ok && idle.data) showIdle(idle.data);
  const nudge = await K.nudgeGet();
  if (nudge.ok && nudge.data) showNudge(nudge.data);
}

function enterMain() {
  show('main');
  S.selected = todayStr();
  S.weekStart = mondayOf(S.selected);
  S.lastSeenToday = S.selected;
  loadWeek();
  loadProjects().then(render).catch(() => {});
}

$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#setup-submit');
  btn.disabled = true;
  btn.textContent = 'Verbinden…';
  const res = await K.authSave({ token: $('#setup-token').value, accountId: $('#setup-account').value });
  btn.disabled = false;
  btn.textContent = 'Verbinden';
  if (!res.ok) { toast(res.error.message, 'error'); return; }
  $('#setup-token').value = '';
  S.me = res.data.me;
  toast(`Verbonden als ${S.me.name}`);
  enterMain();
});

// ---------------------------------------------------------------- events

document.addEventListener('click', (ev) => {
  const t = ev.target;
  const timer = t.closest('[data-timer]');
  if (timer) { ev.stopPropagation(); toggleTimer(timer.dataset.timer); return; }
  const tag = t.closest('[data-jira]');
  if (tag) { K.jiraOpen(tag.dataset.jira); return; }
  const jItem = t.closest('.jira-item');
  if (jItem) { pickJira(+jItem.dataset.jidx); return; }
  if (!t.closest('#jira-combo')) closeJira();
  const day = t.closest('[data-day]');
  if (day) { selectDay(day.dataset.day); return; }
  const item = t.closest('.combo-item');
  if (item && S.form) { chooseProject(S.form.items[+item.dataset.idx].id); return; }
  const entry = t.closest('[data-entry]');
  if (entry && S.view === 'main') {
    const e = S.entries.find((x) => x.id === entry.dataset.entry);
    if (e && !e.locked) openForm(e);
    else if (e) toast(e.lockedReason || 'Deze registratie is vergrendeld.');
    return;
  }
  const wdBtn = t.closest('button[data-wd]');
  if (wdBtn) {
    const d = +wdBtn.dataset.wd;
    const cur = new Set(S.prefs.workdays || [1, 2, 3, 4, 5]);
    cur.has(d) ? cur.delete(d) : cur.add(d);
    setPref({ workdays: [...cur].sort() });
    return;
  }
  const sw = t.closest('button[data-accent]');
  if (sw) { setAccent(sw.dataset.accent || null); return; }
  const pref = t.closest('button[data-pref]');
  if (pref) { setPref({ [pref.dataset.pref]: pref.dataset.val }); return; }
  if (!t.closest('.combo')) closeCombo();

  const act = t.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'prev-week': selectDay(addDays(S.selected, -7)); break;
    case 'next-week': selectDay(addDays(S.selected, 7)); break;
    case 'today': selectDay(todayStr()); break;
    case 'new': openForm(null); break;
    case 'cancel-form': closeForm(); break;
    case 'delete': deleteEntry(); break;
    case 'settings': openSettings(); break;
    case 'back': show('main'); render(); break;
    case 'open-web': K.openWeb(); break;
    case 'open-web-settings': K.openWeb('/settings'); break;
    case 'quit': K.quit(); break;
    case 'jira-open': if (S.form?.jira) K.jiraOpen(S.form.jira.key); break;
    case 'jira-unlink': setJiraIssue(null); $('#f-jira').focus(); break;
    case 'jira-token-page': K.jiraTokenPage(); break;
    case 'update-check': checkUpdates(); break;
    case 'update-install': K.updateInstall(); break;
    case 'test-nudge': {
      const type = t.closest('[data-act]').dataset.type;
      run(K.nudgeTest(type)).catch(() => {});
      break;
    }
    case 'jira-logout':
      K.jiraClear().then((r) => { if (r.ok) S.jira = r.data; S.jiraCache.clear(); renderJiraSettings(); });
      break;
    case 'logout':
      K.authClear().then(() => { S.me = null; S.weeks.clear(); S.entries = []; S.projects = []; S.tasks.clear(); show('setup'); });
      break;
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'accent-custom') setAccent(ev.target.value.toLowerCase(), { live: true });
});

document.addEventListener('change', (ev) => {
  const i = ev.target.closest('input[data-pref]');
  if (i && i.type === 'checkbox') setPref({ [i.dataset.pref]: i.checked });
  else if (i && i.type === 'time' && /^\d{2}:\d{2}$/.test(i.value)) setPref({ [i.dataset.pref]: i.value });
  const sel = ev.target.closest('select[data-pref]');
  if (sel) setPref({ [sel.dataset.pref]: Number(sel.value) });
});

$('#entry-form').addEventListener('submit', (ev) => { ev.preventDefault(); submitForm(); });
$('#f-duration').addEventListener('input', updateSubmitLabel);
$('#f-duration').addEventListener('blur', () => {
  const v = parseDuration($('#f-duration').value);
  if (v !== null && !Number.isNaN(v)) $('#f-duration').value = fmtH(v);
  updateSubmitLabel();
});
$('#f-project').addEventListener('focus', () => { closeJira(); $('#f-project').select(); openCombo(); });
$('#f-project').addEventListener('input', () => { if (S.form) S.form.active = 0; openCombo(); renderCombo(); });
$('#f-project').addEventListener('keydown', (ev) => {
  const f = S.form;
  if (!f) return;
  const open = !$('#combo-list').hidden;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!open) { openCombo(); return; }
    const n = (f.items || []).length;
    if (!n) return;
    f.active = (f.active + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderCombo();
  } else if (ev.key === 'Enter' && open && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault();
    const p = f.items?.[f.active];
    if (p) chooseProject(p.id);
  } else if (ev.key === 'Tab' && open) {
    const p = f.items?.[f.active];
    if (p && $('#f-project').value.trim() && p.id !== f.projectId) { ev.preventDefault(); chooseProject(p.id); }
    else closeCombo();
  }
});
$('#combo-list').addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in input
$('#combo-list').addEventListener('mousemove', (ev) => {
  const item = ev.target.closest('.combo-item');
  if (item && S.form && S.form.active !== +item.dataset.idx) {
    S.form.active = +item.dataset.idx;
    document.querySelectorAll('.combo-item').forEach((el) => el.classList.toggle('active', el === item));
  }
});

$('#f-jira').addEventListener('focus', () => { closeCombo(); searchJira(); });
$('#f-jira').addEventListener('input', () => {
  clearTimeout(jiraTimer);
  jiraTimer = setTimeout(searchJira, 250);
});
$('#f-jira').addEventListener('keydown', (ev) => {
  const f = S.form;
  if (!f) return;
  const open = !$('#jira-list').hidden;
  const n = (f.jiraItems || []).length;
  if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && n) {
    ev.preventDefault();
    if (!open) { searchJira(); return; }
    f.jiraActive = ((f.jiraActive || 0) + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderJira($('#f-jira').value.trim());
  } else if (ev.key === 'Enter' && open && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault();
    if (n) pickJira(f.jiraActive || 0);
  } else if (ev.key === 'Tab') {
    closeJira();
  }
});
$('#jira-list').addEventListener('mousedown', (ev) => ev.preventDefault());

document.addEventListener('keydown', (ev) => {
  const inField = ev.target.matches('input, textarea, select');

  if (S.nudge && !S.idle) {
    if (/^[1-9]$/.test(ev.key) && !ev.metaKey && !ev.ctrlKey) {
      const a = S.nudge.actions?.[+ev.key - 1];
      if (a) { ev.preventDefault(); resolveNudge(a.id); }
    } else if (ev.key === 'Escape') { ev.preventDefault(); K.hide(); }
    return;
  }

  if (S.idle) {
    if (/^[1-4]$/.test(ev.key) && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      resolveIdle(['remove-continue', 'remove-stop', 'reassign', 'keep'][+ev.key - 1]);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      K.hide(); // question stays open until answered
    }
    return;
  }

  if (S.form && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'j') { ev.preventDefault(); focusJira(); return; }

  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (S.form && !$('#jira-list').hidden) { closeJira(); return; }
    if (S.form && !$('#combo-list').hidden && S.form.projectId) { closeCombo(); return; }
    if (S.form) { closeForm(); return; }
    if (S.view === 'settings') { show('main'); render(); return; }
    K.hide();
    return;
  }
  if (S.form && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submitForm(); return; }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === ',') { ev.preventDefault(); if (S.me) openSettings(); return; }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'r') { ev.preventDefault(); invalidateWeeks(); loadWeek(); return; }

  if (inField || S.form || S.view !== 'main' || ev.metaKey || ev.ctrlKey || ev.altKey) return;

  if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectDay(addDays(S.selected, ev.shiftKey ? -7 : -1)); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); selectDay(addDays(S.selected, ev.shiftKey ? 7 : 1)); }
  else if (/^[1-7]$/.test(ev.key)) selectDay(addDays(S.weekStart, +ev.key - 1));
  else if (ev.key.toLowerCase() === 't') selectDay(todayStr());
  else if (ev.key.toLowerCase() === 'n') { ev.preventDefault(); openForm(null); }
  else if (ev.key.toLowerCase() === 's') stopRunning();
});

// ---------------------------------------------------------------- idle time

function fmtAway(hours) {
  const mins = Math.max(1, Math.round(hours * 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} u ${m} min` : `${h} uur`;
}
const clockOf = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function showIdle(p) {
  if (!p || !S.me) return;
  S.idle = p;
  closeCombo(); closeJira();
  $('#idle-dur').textContent = fmtAway(p.hours);
  document.querySelectorAll('.idle-dur').forEach((el) => (el.textContent = fmtAway(p.hours)));
  $('#idle-range').textContent = `${clockOf(p.from)} – ${clockOf(p.to)}`;
  const proj = S.projectsById.get(S.entries.find((e) => e.id === p.entryId)?.projectId);
  $('#idle-project').textContent = p.projectName || proj?.name || 'Lopende timer';
  $('#idle-task').textContent = [p.clientName || proj?.clientName, p.taskName].filter(Boolean).join(' · ');
  document.querySelectorAll('[data-idle]').forEach((b) => (b.disabled = false));
  $('#view-idle').hidden = false;
}

function hideIdle() {
  S.idle = null;
  $('#view-idle').hidden = true;
}

async function resolveIdle(action) {
  const p = S.idle;
  if (!p || S.busy) return;
  S.busy = true;
  document.querySelectorAll('[data-idle]').forEach((b) => (b.disabled = true));
  const res = await K.idleResolve(action);
  S.busy = false;
  hideIdle();
  invalidateWeeks();
  if (!res.ok) { toast(res.error.message, 'error'); await loadWeek({ silent: true }); return; }
  const away = fmtAway(p.hours);
  if (action === 'keep') toast('Timer loopt gewoon door');
  else if (action === 'remove-stop') toast(`${away} eraf gehaald, timer gestopt`);
  else if (action === 'remove-continue') toast(`${away} eraf gehaald`);
  if (S.view !== 'main') { show('main'); }
  S.selected = todayStr();
  S.weekStart = mondayOf(S.selected);
  await loadWeek({ silent: true });
  if (action === 'reassign') {
    openForm(null, { hours: p.hours });
    $('#duration-hint').textContent = `Idle-tijd ${clockOf(p.from)}–${clockOf(p.to)}. Kies waar je mee bezig was.`;
  }
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-idle]');
  if (b) { ev.stopPropagation(); resolveIdle(b.dataset.idle); }
}, true);

K.on('idle', (p) => showIdle(p));

// ---------------------------------------------------------------- day reminders

const ICON_PLAYCIRCLE = '<svg viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke="none"/></svg>';
const ICON_HOURGLASS = '<svg viewBox="0 0 24 24" stroke-width="2"><path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/></svg>';

function greeting(name) {
  const h = new Date().getHours();
  const g = h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
  return name ? `${g}, ${name}` : g;
}

function showNudge(n) {
  if (!n || !S.me) return;
  const actions = [];
  if (n.type === 'start') {
    const p = n.suggest && S.projectsById.get(n.suggest.projectId);
    if (n.suggest && (p || !S.projects.length)) {
      const label = [n.suggest.projectName || p?.name, n.suggest.taskName].filter(Boolean).join(' · ');
      actions.push({ id: 'suggest', label: `Start ${label}`, primary: true });
    }
    actions.push({ id: 'new', label: 'Andere timer starten…', primary: !actions.length });
    actions.push({ id: 'snooze', label: 'Herinner me over 15 min' });
    actions.push({ id: 'dismiss', label: 'Vandaag niet meer vragen' });
    $('#nudge-mark').innerHTML = ICON_PLAYCIRCLE;
    $('#nudge-title').textContent = greeting(n.firstName);
    $('#nudge-text').textContent = n.total > 0
      ? `Er loopt nu geen timer (vandaag al ${fmtH(n.total)} geschreven).`
      : 'Je werkdag is begonnen, maar er loopt nog geen timer.';
    $('#nudge-progress').hidden = true;
  } else {
    const left = Math.max(0, n.minHours - n.total);
    actions.push({ id: 'fill', label: `Uren aanvullen (nog ${fmtH(left)})`, primary: true });
    actions.push({ id: 'review', label: 'Bekijk mijn dag' });
    actions.push({ id: 'snooze', label: 'Herinner me over 15 min' });
    actions.push({ id: 'dismiss', label: 'Klopt zo' });
    $('#nudge-mark').innerHTML = ICON_HOURGLASS;
    $('#nudge-title').textContent = `Je staat op ${fmtH(n.total)} vandaag`;
    $('#nudge-text').textContent = `Nog ${fmtH(left)} tot ${fmtH(n.minHours)}.${n.running ? ' Je timer loopt nog.' : ''} Even je uren nalopen?`;
    $('#nudge-progress').hidden = false;
    $('#nudge-fill').style.width = `${Math.min(100, (n.total / n.minHours) * 100)}%`;
    $('#nudge-have').textContent = fmtH(n.total);
    $('#nudge-goal').textContent = fmtH(n.minHours);
  }
  S.nudge = { ...n, actions };
  $('#nudge-actions').innerHTML = actions.map((a, i) =>
    `<button class="${a.primary ? 'primary-btn' : 'ghost-btn'}" data-nudge="${a.id}"><span class="label">${esc(a.label)}</span> <kbd>${i + 1}</kbd></button>`).join('');
  closeCombo(); closeJira();
  $('#view-nudge').hidden = false;
}

function hideNudge() {
  S.nudge = null;
  $('#view-nudge').hidden = true;
}

async function resolveNudge(id) {
  const n = S.nudge;
  if (!n || S.busy) return;
  hideNudge();
  // Main only needs to know: snooze, or answered.
  await K.nudgeResolve(id === 'snooze' ? 'snooze' : id === 'dismiss' ? 'dismiss' : 'act');
  if (id === 'snooze') { toast('Ik herinner je over 15 minuten'); K.hide(); return; }
  if (id === 'dismiss') { if (n.type === 'start') K.hide(); return; }

  if (S.view !== 'main') show('main');
  S.selected = todayStr();
  S.weekStart = mondayOf(S.selected);
  invalidateWeeks();
  await loadWeek({ silent: true });

  if (id === 'suggest' && n.suggest) {
    S.busy = true;
    try {
      await run(K.create({
        project_id: n.suggest.projectId, task_id: n.suggest.taskId, spent_date: todayStr(),
        notes: '', is_running: true, replace_running: true,
      }));
      toast(`Timer gestart: ${n.suggest.projectName || 'project'}`);
      invalidateWeeks();
      await loadWeek({ silent: true });
    } catch { /* toast shown */ } finally { S.busy = false; }
  } else if (id === 'new') {
    openForm(null);
  } else if (id === 'fill') {
    const left = Math.max(0, n.minHours - n.total);
    await openForm(null, { hours: left });
    $('#duration-hint').textContent = `Ingevuld: wat er nog ontbreekt tot ${fmtH(n.minHours)}. Pas gerust aan.`;
  }
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-nudge]');
  if (b) { ev.stopPropagation(); resolveNudge(b.dataset.nudge); }
}, true);

K.on('nudge', (n) => showNudge(n));

// ---------------------------------------------------------------- updates

function renderUpdate(u) {
  if (!u) return;
  S.update = u;
  $('#update-banner').hidden = u.state !== 'ready';
  $('#update-version').textContent = u.version || '';
  $('#s-version').textContent = u.current ? `v${u.current}` : '';
  const btn = $('#btn-update');
  const label = {
    checking: 'Controleren…',
    downloading: `Versie ${u.version} downloaden…`,
    ready: `Versie ${u.version} klaar`,
    none: 'Je hebt de nieuwste versie',
    error: u.error || 'Controleren mislukte',
    unavailable: 'Updates werken alleen in de geïnstalleerde app',
  }[u.state] || '';
  $('#s-update').textContent = label;
  btn.textContent = u.state === 'ready' ? 'Herstart nu' : 'Controleer op updates';
  btn.dataset.act = u.state === 'ready' ? 'update-install' : 'update-check';
  btn.hidden = u.state === 'checking' || u.state === 'downloading' || u.state === 'unavailable';
}

async function checkUpdates() {
  renderUpdate({ ...(S.update || {}), state: 'checking' });
  const r = await K.updateCheck();
  if (r.ok) renderUpdate(r.data);
}

K.on('update', (u) => renderUpdate(u));
K.updateStatus().then((r) => r.ok && renderUpdate(r.data));

// Window re-opened from the menubar: refresh, and follow "today" across midnight.
K.on('window:shown', () => {
  if (!S.me) return;
  if (!S.idle) K.idleGet().then((r) => { if (r.ok && r.data) showIdle(r.data); });
  if (!S.nudge) K.nudgeGet().then((r) => { if (r.ok && r.data) showNudge(r.data); });
  const today = todayStr();
  if (S.lastSeenToday !== today) {
    if (S.selected === S.lastSeenToday) { S.selected = today; S.weekStart = mondayOf(today); }
    S.lastSeenToday = today;
  }
  if (S.view === 'main' && !S.form) {
    invalidateWeeks();
    loadWeek({ silent: true });
    loadProjects().catch(() => {});
  }
});
K.on('data:changed', () => { invalidateWeeks(); if (S.me) loadWeek({ silent: true }); });
K.on('nav', (where) => { if (where === 'settings' && S.me) { closeForm(); openSettings(); } });

boot();
