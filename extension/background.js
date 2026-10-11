// Commissioning Logbook — background service worker.
// Owns the database (chrome.storage.local) and serialises every write.
import * as core from './core.js';

const DB_KEY = 'db';
const SCRIPT_ID = 'logbook-content';

// ---------------------------------------------------------------- database

let queue = Promise.resolve();

async function loadDb() {
  const { [DB_KEY]: db } = await chrome.storage.local.get(DB_KEY);
  return db || core.emptyDb();
}

/** Run fn(db) with exclusive access; saves afterwards. Returns fn's result. */
function withDb(fn) {
  const run = queue.then(async () => {
    const db = await loadDb();
    const result = await fn(db);
    await chrome.storage.local.set({ [DB_KEY]: db });
    return result;
  });
  queue = run.catch(err => console.error('[logbook]', err));
  return run;
}

// ---------------------------------------------------------------- side panel presence

const panelPorts = new Set();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
});
const sidebarOpen = () => panelPorts.size > 0;

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------- content-script registration

async function syncContentScripts() {
  const db = await loadDb();
  const allowed = [];
  for (const pattern of db.settings.sites) {
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) allowed.push(pattern);
    } catch { /* invalid pattern */ }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (allowed.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID, js: ['content.js'], matches: allowed, runAt: 'document_idle', allFrames: true,
      persistAcrossSessions: true,
    }]);
  }
  return allowed;
}

async function injectIntoOpenTabs(patterns) {
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({ url: patterns });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const allowed = await syncContentScripts();
  await injectIntoOpenTabs(allowed);
});
chrome.runtime.onStartup.addListener(syncContentScripts);

// ---------------------------------------------------------------- live tab state (unsaved edits)

async function setLive(tabId, patch) {
  const { live = {} } = await chrome.storage.session.get('live');
  live[tabId] = { ...(live[tabId] || {}), ...patch };
  await chrome.storage.session.set({ live });
}
chrome.tabs.onRemoved.addListener(async tabId => {
  const { live = {} } = await chrome.storage.session.get('live');
  delete live[tabId];
  await chrome.storage.session.set({ live });
});

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, err => reply({ error: String(err) }));
  return true;
});

async function handle(msg, sender) {
  const now = Date.now();
  const tabId = sender.tab?.id;

  // From the content script
  if (msg.type === 'snapshot' || msg.type === 'submit' || msg.type === 'dirty') {
    const db = await loadDb();
    const sid = core.shuttleIdFromUrl(msg.url, db.settings.idRegex);
    if (!sid) return {};
    if (msg.type === 'dirty') {
      if (tabId != null && sender.frameId === 0) await setLive(tabId, { sid, url: msg.url, dirty: msg.dirty });
      return {};
    }
    if (msg.type === 'submit') {
      return withDb(d => ({ created: core.onSubmit(d, { sid, url: msg.url, baseline: msg.baseline, values: msg.values, labels: msg.labels, sidebarOpen: sidebarOpen(), now }).length }));
    }
    if (tabId != null && sender.frameId === 0) await setLive(tabId, { sid, url: msg.url, dirty: [], lastRead: now });
    return withDb(d => {
      const r = core.onSnapshot(d, { sid, url: msg.url, fields: msg.fields, editedKeys: msg.editedKeys, sidebarOpen: sidebarOpen(), now });
      return { outside: r.outside.length, confirmed: r.confirmed.length };
    });
  }

  // From the side panel
  switch (msg.cmd) {
    case 'createChangeset': return withDb(d => core.createChangeset(d, msg.description, now).id);
    case 'updateChangeset': return withDb(d => core.updateChangeset(d, msg.id, msg.fields, now));
    case 'useChangeset': return withDb(d => core.touchChangeset(d, msg.id, now));
    case 'closeChangeset': return withDb(d => core.closeChangeset(d, msg.id, msg.outcome, now));
    case 'reopenChangeset': return withDb(d => core.reopenChangeset(d, msg.id, now));
    case 'deleteChangeset': return withDb(d => core.deleteChangesetIfEmpty(d, msg.id));
    case 'moveChange': return withDb(d => core.moveChange(d, msg.changeId, msg.target, now)?.id);
    case 'setLabel': return withDb(d => core.setLabelOverride(d, msg.key, msg.label));
    case 'ignoreField': return withDb(d => core.ignoreField(d, msg.key));
    case 'unignoreField': return withDb(d => core.unignoreField(d, msg.key));
    case 'setIdRegex': return withDb(d => { d.settings.idRegex = msg.value || ''; });
    case 'addSite': {
      await withDb(d => { if (!d.settings.sites.includes(msg.pattern)) d.settings.sites.push(msg.pattern); });
      const allowed = await syncContentScripts();
      await injectIntoOpenTabs([msg.pattern].filter(p => allowed.includes(p)));
      return { ok: allowed.includes(msg.pattern) };
    }
    case 'removeSite': {
      await withDb(d => { d.settings.sites = d.settings.sites.filter(p => p !== msg.pattern); });
      await syncContentScripts();
      return { ok: true };
    }
    case 'reread': {
      try { return await chrome.tabs.sendMessage(msg.tabId, { type: 'reread' }, { frameId: 0 }); }
      catch { return { error: 'This page is not being watched, or it has no parameter fields.' }; }
    }
    case 'importDb': return withDb(d => { Object.assign(d, msg.db); });
    case 'resetDb': {
      const settings = (await loadDb()).settings;
      return withDb(d => { Object.keys(d).forEach(k => delete d[k]); Object.assign(d, core.emptyDb(), { settings }); });
    }
  }
  return {};
}
