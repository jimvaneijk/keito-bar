const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('keito', {
  authStatus: () => call('auth:status'),
  authSave: (creds) => call('auth:save', creds),
  authClear: () => call('auth:clear'),
  prefsGet: () => call('prefs:get'),
  prefsSet: (patch) => call('prefs:set', patch),
  projects: () => call('projects:list'),
  tasks: (projectId) => call('tasks:list', projectId),
  entries: (range) => call('entries:list', range),
  create: (body) => call('entry:create', body),
  update: (id, body) => call('entry:update', { id, body }),
  stop: (id) => call('entry:stop', id),
  restart: (id) => call('entry:restart', id),
  remove: (id) => call('entry:delete', id),
  jiraStatus: () => call('jira:status'),
  jiraSave: (creds) => call('jira:save', creds),
  jiraClear: () => call('jira:clear'),
  jiraSearch: (query, projectKey) => call('jira:search', { query, projectKey }),
  jiraOpen: (key) => ipcRenderer.send('jira:open', key),
  jiraTokenPage: () => ipcRenderer.send('jira:tokens'),
  idleGet: () => call('idle:get'),
  idleResolve: (action) => call('idle:resolve', action),
  nudgeGet: () => call('nudge:get'),
  nudgeResolve: (action) => call('nudge:resolve', action),
  nudgeTest: (type) => call('nudge:test', type),
  updateStatus: () => call('update:status'),
  updateCheck: () => call('update:check'),
  updateInstall: () => ipcRenderer.send('update:install'),
  setTodayTotal: (hours) => ipcRenderer.send('tray:today', hours),
  hide: () => ipcRenderer.send('window:hide'),
  openWeb: (sub) => ipcRenderer.send('open:web', sub),
  quit: () => ipcRenderer.send('app:quit'),
  on: (channel, fn) => {
    if (!['window:shown', 'data:changed', 'nav', 'idle', 'nudge', 'update'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
