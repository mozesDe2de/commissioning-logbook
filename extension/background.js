// Commissioning Logbook — background service worker.
// Owns the database (chrome.storage.local) and serialises every write.
import * as core from './core.js';

const DB_KEY = 'db';
const SCRIPT_ID = 'logbook-content';

// ---------------------------------------------------------------- database

let queue = Promise.resolve();

async function loadDb() {
  const { [DB_KEY]: db } = await chrome.storage.local.get(DB_KEY);
  return db ? core.migrate(db) : core.emptyDb();
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

// ---------------------------------------------------------------- snapshots

/** Record a page read. A suspicious read (many fields differ from what was stored for this
 *  shuttle at this customer/site) is parked in the tab's live state until the engineer decides. */
async function runSnapshot(tabId, top, snap, force, now) {
  const r = await withDb(d => core.onSnapshot(d, { ...snap, sidebarOpen: sidebarOpen(), now, force }));
  if (top) {
    await setLive(tabId, r.suspect
      ? { sid: snap.sid, url: snap.url, noSite: false, suspect: { ...r.suspect, custSite: snap.custSite, snap }, lastRead: now }
      : { sid: snap.sid, url: snap.url, noSite: false, suspect: null, dirty: [], lastRead: now });
  }
  return { outside: r.outside.length, confirmed: r.confirmed.length, suspect: !!r.suspect };
}

/** The tab's parked read, or null. Only valid while the customer/site and the page are unchanged. */
async function parkedSnapshot(tabId) {
  const { live = {} } = await chrome.storage.session.get('live');
  const l = live[tabId];
  return l && l.suspect ? l.suspect : null;
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, err => reply({ error: String(err) }));
  return true;
});

async function rereadTab(tabId) {
  await setLive(tabId, { suspect: null, noSite: false });
  try { return await chrome.tabs.sendMessage(tabId, { type: 'reread' }, { frameId: 0 }); }
  catch { return { error: 'This page is not being watched, or it has no parameter fields.' }; }
}

async function handle(msg, sender) {
  const now = Date.now();
  const tabId = sender.tab?.id;

  // From the content script
  if (msg.type === 'snapshot' || msg.type === 'submit' || msg.type === 'dirty') {
    const db = await loadDb();
    const sid = core.shuttleIdFromUrl(msg.url, db.settings.idRegex);
    if (!sid) return {};
    const top = tabId != null && sender.frameId === 0;
    if (msg.type === 'dirty') {
      if (top) await setLive(tabId, { sid, url: msg.url, dirty: msg.dirty });
      return {};
    }
    // Addresses repeat at every customer, so nothing is recorded until a customer/site is chosen.
    const custSite = db.settings.currentCustSite;
    if (!core.currentCustSite(db)) {
      if (top) await setLive(tabId, { sid, url: msg.url, noSite: true, ...(msg.type === 'snapshot' ? { dirty: [] } : {}) });
      return { noSite: true };
    }
    if (msg.type === 'submit') {
      return withDb(d => ({ created: core.onSubmit(d, { custSite, sid, url: msg.url, baseline: msg.baseline, values: msg.values, labels: msg.labels, sidebarOpen: sidebarOpen(), now }).length }));
    }
    return runSnapshot(tabId, top, { custSite, sid, url: msg.url, fields: msg.fields, editedKeys: msg.editedKeys }, false, now);
  }

  // From the side panel
  switch (msg.cmd) {
    case 'createChangeset': return withDb(d => core.currentCustSite(d)
      ? core.createChangeset(d, msg.description, now, { custSite: d.settings.currentCustSite }).id : null);
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
    case 'createCustSite': {
      const id = await withDb(d => { const c = core.createCustSite(d, msg.name, now); if (c) core.selectCustSite(d, c.id); return c && c.id; });
      if (id && msg.tabId != null) await rereadTab(msg.tabId);
      return id;
    }
    case 'selectCustSite': {
      await withDb(d => core.selectCustSite(d, msg.id));
      if (msg.tabId != null) await rereadTab(msg.tabId);
      return { ok: true };
    }
    case 'renameCustSite': return withDb(d => core.renameCustSite(d, msg.id, msg.name));
    case 'acceptSnapshot': {
      // The engineer confirmed: same customer/site, the differences really are outside changes.
      const p = await parkedSnapshot(msg.tabId);
      const db = await loadDb();
      if (!p || p.custSite !== db.settings.currentCustSite) return { error: 'Nothing to log; re-read the page.' };
      return runSnapshot(msg.tabId, true, p.snap, true, now);
    }
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
    case 'reread': return rereadTab(msg.tabId);
    case 'importDb': return withDb(d => { Object.keys(d).forEach(k => delete d[k]); Object.assign(d, core.migrate(msg.db, now)); });
    case 'resetDb': {
      const { settings, custSites, seqs } = await loadDb();
      // Keep the settings and the customer/site list; site ids stay unique because the counters are kept.
      return withDb(d => { Object.keys(d).forEach(k => delete d[k]); Object.assign(d, core.emptyDb(), { settings, custSites, seqs: { site: (seqs || {}).site || 0 } }); });
    }
  }
  return {};
}
