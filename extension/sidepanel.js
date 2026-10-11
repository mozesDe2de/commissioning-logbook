// Commissioning Logbook — side panel UI.
import * as core from './core.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let db = core.emptyDb();
let live = {};
let tab = null;          // active tab { id, url }
let editingLabel = null; // change id whose label is being renamed
const openNotes = new Set();

const STATUS = {
  saved: ['saved, waiting for read-back', 'Saved on the page; the logbook confirms it when the page shows the value after reload.'],
  confirmed: ['confirmed', 'The shuttle page shows the new value after reload.'],
  not_applied: ['not applied (yet)', 'After reload the shuttle still shows the old value: it was rejected, or it waits for a restart.'],
  adjusted: ['shuttle adjusted it', 'After reload the shuttle shows a different value than entered (clamped or rounded).'],
  detected: ['changed outside browser', 'Found on a page load: this value changed without being saved from this browser.'],
  superseded: ['replaced', 'Saved again before this value was confirmed.'],
};

// ------------------------------------------------------------------ plumbing

function send(msg) { return chrome.runtime.sendMessage(msg); }

function connect() {
  const port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onDisconnect.addListener(() => setTimeout(connect, 500)); // service worker restarted
}
connect();

function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

const pad = n => String(n).padStart(2, '0');
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts), today = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

function patternToRegex(p) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(p);
  if (!m) return null;
  const [, scheme, host, path] = m;
  const s = scheme === '*' ? 'https?' : scheme;
  const h = host === '*' ? '[^/]+' : host.startsWith('*.') ? `([^/]+\\.)?${host.slice(2).replace(/\./g, '\\.')}` : host.replace(/\./g, '\\.');
  const pa = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${s}://${h}(:\\d+)?${pa}$`);
}
const watched = url => db.settings.sites.some(p => patternToRegex(p)?.test(url));

// ------------------------------------------------------------------ data

async function refresh() {
  const [{ db: d }, { live: l = {} }] = await Promise.all([chrome.storage.local.get('db'), chrome.storage.session.get('live')]);
  db = d ? core.migrate(d) : core.emptyDb();
  live = l;
  render();
}

async function refreshTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = t ? { id: t.id, url: t.url || '' } : null;
  render();
}

chrome.storage.onChanged.addListener(refresh);
chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info) => { if (tab && id === tab.id && (info.url || info.status === 'complete')) refreshTab(); });

// ------------------------------------------------------------------ render

let rendering = false;
function render() {
  rendering = true;
  try { renderInner(); } finally { rendering = false; }
}

function renderInner() {
  // keep focus and caret in whatever the engineer is typing in
  const a = document.activeElement;
  const keep = a && a.dataset && a.dataset.fk ? { fk: a.dataset.fk, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;

  renderCustSite();
  renderPageStatus();
  renderSuspect();
  renderUnsaved();
  renderSets();
  renderSettings();

  if (keep) {
    const el = document.querySelector(`[data-fk="${keep.fk}"]`);
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch { /* select */ } }
  }
}

function renderPageStatus() {
  const box = $('#pageStatus');
  if (!tab || !/^https?:/.test(tab.url)) { box.innerHTML = '<span class="dot"></span> No web page in this tab'; return; }
  const sid = core.shuttleIdFromUrl(tab.url, db.settings.idRegex);
  const l = live[tab.id];
  if (watched(tab.url)) {
    const read = !core.currentCustSite(db) ? '<strong>not recording: choose a customer / site</strong>'
      : l && l.url === tab.url && l.suspect ? '<strong>not recorded yet, see below</strong>'
      : l && l.url === tab.url && l.lastRead ? `read ${when(l.lastRead)}` : 'no parameter fields read yet';
    box.innerHTML = `<span class="dot on"></span><span>Shuttle <span class="sid">${esc(sid)}</span></span>
      <span>· ${read}</span> <button class="linkish" id="rereadBtn">Re-read page</button>`;
    $('#rereadBtn').onclick = async () => {
      const r = await send({ cmd: 'reread', tabId: tab.id });
      toast(r && r.error ? r.error : 'Page re-read');
    };
  } else {
    const origin = (() => { try { const u = new URL(tab.url); return `${u.protocol}//${u.hostname}/*`; } catch { return ''; } })();
    box.innerHTML = `<span class="dot"></span><span>This site is not watched.</span>
      <button class="linkish" id="watchBtn">Watch ${esc(origin.replace('/*', ''))}</button>`;
    $('#watchBtn').onclick = () => watchSite(origin);
  }
}

function watchSite(pattern) {
  // permissions.request must run directly in the click handler
  chrome.permissions.request({ origins: [pattern] }, async granted => {
    if (!granted) { toast('Permission not granted; the site is not watched.'); return; }
    await send({ cmd: 'addSite', pattern });
    toast('Watching ' + pattern.replace('/*', '') + '. Reload the shuttle page to start.');
    refreshTab();
  });
}

function renderCustSite() {
  const cur = core.currentCustSite(db);
  const list = Object.values(db.custSites).sort((a, b) => a.name.localeCompare(b.name));
  const sel = $('#custSiteSelect');
  if (document.activeElement !== sel) {
    sel.innerHTML = (cur ? '' : '<option value="">— choose —</option>')
      + list.map(c => `<option value="${esc(c.id)}" ${cur && c.id === cur.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  sel.hidden = !list.length;
  $('#custSiteRenameBtn').hidden = !cur;
  $('#custSiteBar').classList.toggle('missing', !cur);
  $('#custSiteHint').textContent = cur ? ''
    : list.length ? 'Choose where you are working. Shuttle addresses repeat at every customer, so nothing is recorded until you do.'
    : 'Create the customer / site you are working at, e.g. "Customer X – Ghent DC". Shuttle addresses repeat at every customer, so nothing is recorded until you do.';
}

function renderSuspect() {
  const box = $('#suspect');
  const l = tab && live[tab.id];
  const s = l && l.url === tab.url && l.suspect;
  if (!s || s.custSite !== db.settings.currentCustSite) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<p><strong>Different customer / site?</strong> ${s.differing} of ${s.compared} fields on this page differ from what was
    recorded for shuttle <code>${esc(l.sid)}</code> at <strong>${esc(core.custSiteName(db, s.custSite))}</strong>. Nothing was recorded.</p>
    <div class="row"><button class="btn small" id="suspectSwitch">Switch customer / site</button>
    <button class="btn small ghost" id="suspectAccept" title="Log every difference as changed outside this browser">Same site: log as outside changes</button></div>`;
  $('#suspectSwitch').onclick = () => { const sel = $('#custSiteSelect'); sel.hidden ? $('#custSiteNewBtn').click() : sel.focus(); };
  $('#suspectAccept').onclick = async () => {
    const r = await send({ cmd: 'acceptSnapshot', tabId: tab.id });
    toast(r && r.error ? r.error : `Logged ${r.outside} outside change(s)`);
  };
}

function renderUnsaved() {
  const box = $('#unsaved');
  const l = tab && live[tab.id];
  const dirty = l && l.url === tab.url ? l.dirty || [] : [];
  if (!dirty.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<strong>Not saved to the shuttle yet</strong>
    <ul>${dirty.map(d => `<li><span>${esc(core.displayLabel(db, d.key, d.label))}</span>
    <code>${esc(d.from)} → ${esc(d.to)}</code></li>`).join('')}</ul>`;
}

function changeRow(c, csList, readOnly) {
  const [stText, stTip] = STATUS[c.status] || [c.status, ''];
  const label = core.displayLabel(db, c.field, c.label);
  const showActual = c.actual != null && !core.valuesEqual(c.actual, c.to) && c.status !== 'detected';
  const moveOpts = csList.filter(x => x.id !== c.changesetId)
    .map(x => `<option value="${x.id}">${esc(x.id)} · ${esc(short(x.description))}</option>`).join('');
  const labelPart = editingLabel === c.id
    ? `<div class="labeledit"><input type="text" data-fk="lbl-${c.id}" value="${esc(label)}" aria-label="Parameter name">
       <button class="btn small" data-act="saveLabel" data-id="${c.id}">Save</button>
       <button class="btn small ghost" data-act="resetLabel" data-id="${c.id}" title="Use the detected name again">Reset</button></div>`
    : `<span class="ch-label">${readOnly ? esc(label) : `<button class="linkish" style="text-decoration:none;color:inherit" data-act="editLabel" data-id="${c.id}" title="Wrong name? Click to rename this parameter">${esc(label)}</button>`}<span class="key">${esc(c.field !== label ? c.field : '')}</span></span>`;
  return `<li class="ch ${c.status}">
    <div class="ch-top">${labelPart}<span class="st ${c.status}" title="${esc(stTip)}">${stText}</span></div>
    <div class="ch-vals">${esc(c.from)}<span class="arrow">→</span>${esc(c.to)}${showActual ? ` <span class="actual">(shuttle shows ${esc(c.actual)})</span>` : ''}</div>
    <div class="ch-sub"><span>${esc(c.shuttleId)} · ${when(c.at)}</span>
    ${readOnly ? '' : `<span class="ch-actions">
      ${c.status === 'detected' ? `<button class="linkish" data-act="ignore" data-key="${esc(c.field)}" title="Stop tracking this field, e.g. a counter that changes on its own">Ignore field</button>` : ''}
      <select data-act="move" data-id="${c.id}" aria-label="Move this change to another changeset">
        <option value="">Move to…</option>${moveOpts}<option value="new">New changeset</option></select></span>`}
    </div></li>`;
}

const short = s => (s.length > 40 ? s.slice(0, 38) + '…' : s);

function card(cs, { target, readOnly, csList }) {
  const changes = core.changesOf(db, cs.id);
  const shuttles = [...new Set(changes.map(c => c.shuttleId))].join(', ');
  const needs = cs.description === core.DEFAULT_REASON || cs.description === core.OUTSIDE_REASON;
  const badges = [
    target ? '<span class="badge target">Receives new changes</span>' : '',
    cs.source === 'outside' ? '<span class="badge outside">Outside browser</span>' : '',
    needs && !readOnly ? '<span class="badge needs">Needs a reason</span>' : '',
    cs.outcome ? `<span class="outcome ${cs.outcome}">${cs.outcome === 'solved' ? 'Solved' : 'Not solved'}</span>` : '',
  ].join(' ');
  const head = readOnly
    ? `<div class="reason" style="cursor:default">${esc(cs.description)}</div>${cs.note ? `<div class="hint">${esc(cs.note)}</div>` : ''}`
    : `<textarea class="reason ${needs ? 'default' : ''}" rows="1" data-fk="desc-${cs.id}" data-act="desc" data-id="${cs.id}"
        aria-label="Reason for this changeset">${esc(cs.description)}</textarea>
       ${openNotes.has(cs.id) || cs.note ? `<textarea class="note" rows="2" data-fk="note-${cs.id}" data-act="note" data-id="${cs.id}"
        placeholder="Result / observations (optional)">${esc(cs.note || '')}</textarea>` : ''}`;
  const foot = readOnly
    ? `<span class="hint">Closed ${when(cs.closedAt)}</span><span class="spacer"></span>
       <button class="btn small ghost" data-act="reopen" data-id="${cs.id}">Reopen</button>`
    : `<span class="links">${target ? '' : `<button class="linkish" data-act="use" data-id="${cs.id}" title="Send the next saved changes to this changeset">Use for new changes</button>`}
       ${openNotes.has(cs.id) || cs.note ? '' : `<button class="linkish" data-act="addNote" data-id="${cs.id}">Add result note</button>`}</span>
       <span class="closegrp">${changes.length
         ? `<span class="closelbl">Close:</span>
            <button class="btn small" data-act="close" data-outcome="solved" data-id="${cs.id}" title="The problem is solved; these become final values">Solved</button>
            <button class="btn small ghost" data-act="close" data-outcome="not_solved" data-id="${cs.id}">Not solved</button>`
         : `<button class="btn small ghost" data-act="delete" data-id="${cs.id}">Delete</button>`}</span>`;
  return `<article class="cs ${target ? 'target' : ''} ${readOnly ? 'isclosed' : ''}">
    <div class="cs-head"><div class="cs-meta"><span>${esc(cs.id)} · ${when(cs.createdAt)}${shuttles ? ' · ' + esc(shuttles) : ''}</span><span>${badges}</span></div>${head}</div>
    ${changes.length ? `<ul class="changes">${changes.map(c => changeRow(c, csList, readOnly)).join('')}</ul>`
      : `<div class="hint" style="padding:0 10px 8px">No changes yet. Saved parameter changes land here while this changeset receives new changes.</div>`}
    <div class="cs-foot">${foot}</div></article>`;
}

function renderSets() {
  const cur = core.currentCustSite(db);
  const site = cur ? cur.id : null;
  $('#newSetBtn').hidden = !cur;
  const active = cur ? core.activeChangesets(db, site) : [];
  const target = cur ? core.currentTarget(db, site) : null;
  const elsewhere = Object.values(db.changesets).filter(c => c.status === 'active' && c.custSite !== site).length;
  const other = elsewhere ? `<div class="hint">${elsewhere} active changeset(s) at other customers / sites.</div>` : '';
  $('#activeSets').innerHTML = !cur
    ? `<div class="empty">Choose a customer / site above to see its changesets.</div>${other}`
    : (active.length
      ? active.map(cs => card(cs, { target: target && cs.id === target.id, readOnly: false, csList: active })).join('')
      : `<div class="empty">No active changesets at ${esc(cur.name)}. Create one first, or just change parameters: the first save creates one with the question <em>${esc(core.DEFAULT_REASON)}</em></div>`) + other;
  const closed = Object.values(db.changesets).filter(c => c.status === 'closed' && c.custSite === site).sort((a, b) => b.closedAt - a.closedAt);
  $('#closedCount').textContent = closed.length ? `(${closed.length})` : '';
  $('#closedSets').innerHTML = closed.map(cs => card(cs, { target: false, readOnly: true, csList: [] })).join('')
    || '<div class="empty">Nothing closed yet.</div>';
  autosize();
}

function renderSettings() {
  $('#siteList').innerHTML = db.settings.sites.map(p =>
    `<li><span>${esc(p)}</span><button class="linkish" data-act="removeSite" data-pattern="${esc(p)}">Remove</button></li>`).join('')
    || '<li>None</li>';
  const ri = $('#regexInput');
  if (document.activeElement !== ri) ri.value = db.settings.idRegex || '';
  const ign = Object.keys(db.ignored || {});
  $('#ignoredList').innerHTML = ign.length
    ? ign.map(k => `<li><span>${esc(core.displayLabel(db, k))}</span><button class="linkish" data-act="unignore" data-key="${esc(k)}">Track again</button></li>`).join('')
    : '<li>None</li>';
}

function autosize() {
  document.querySelectorAll('textarea.reason').forEach(t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; });
}

// ------------------------------------------------------------------ events

const descTimers = {};
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.act === 'desc' || el.dataset.act === 'note') {
    if (el.dataset.act === 'desc') { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; }
    clearTimeout(descTimers[el.dataset.fk]);
    descTimers[el.dataset.fk] = setTimeout(() => saveText(el), 700);
  }
});
function saveText(el) {
  const cs = db.changesets[el.dataset.id];
  if (!cs) return;
  const isDesc = el.dataset.act === 'desc';
  const current = isDesc ? cs.description : (cs.note || '');
  if (el.value === current || (isDesc && !el.value.trim() && current === core.DEFAULT_REASON)) return; // nothing changed
  const fields = isDesc ? { description: el.value } : { note: el.value };
  return send({ cmd: 'updateChangeset', id: el.dataset.id, fields });
}
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el.dataset.act === 'desc' && (el.value === core.DEFAULT_REASON || el.value === core.OUTSIDE_REASON)) el.select();
});
document.addEventListener('focusout', e => {
  const el = e.target;
  if (rendering) return; // focus lost because the panel re-rendered, not because the engineer left the field
  if (el.dataset.act === 'desc' || el.dataset.act === 'note') { clearTimeout(descTimers[el.dataset.fk]); saveText(el); }
});
document.addEventListener('keydown', e => {
  const el = e.target;
  if (el.dataset.act === 'desc' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
  if (el.dataset.fk && el.dataset.fk.startsWith('lbl-')) {
    if (e.key === 'Enter') { e.preventDefault(); saveLabel(el.dataset.fk.slice(4), el.value); }
    if (e.key === 'Escape') { editingLabel = null; render(); }
  }
});

async function saveLabel(changeId, value) {
  const c = db.changes[changeId];
  editingLabel = null;
  if (c) await send({ cmd: 'setLabel', key: c.field, label: value === c.label ? '' : value });
  render();
}

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.act === 'move' && el.value) {
    await send({ cmd: 'moveChange', changeId: el.dataset.id, target: el.value });
    toast(el.value === 'new' ? 'Moved to a new changeset' : 'Change moved');
  }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
  const { act, id } = el.dataset;
  switch (act) {
    case 'use': await send({ cmd: 'useChangeset', id }); break;
    case 'close': await send({ cmd: 'closeChangeset', id, outcome: el.dataset.outcome }); toast('Changeset closed'); break;
    case 'reopen': await send({ cmd: 'reopenChangeset', id }); break;
    case 'delete': await send({ cmd: 'deleteChangeset', id }); break;
    case 'addNote': openNotes.add(id); render(); document.querySelector(`[data-fk="note-${id}"]`)?.focus(); break;
    case 'editLabel': editingLabel = id; render(); document.querySelector(`[data-fk="lbl-${id}"]`)?.select(); break;
    case 'saveLabel': saveLabel(id, document.querySelector(`[data-fk="lbl-${id}"]`).value); break;
    case 'resetLabel': saveLabel(id, db.changes[id]?.label || ''); break;
    case 'ignore': await send({ cmd: 'ignoreField', key: el.dataset.key }); toast('Field ignored. Undo under Settings.'); break;
    case 'unignore': await send({ cmd: 'unignoreField', key: el.dataset.key }); break;
    case 'removeSite': await send({ cmd: 'removeSite', pattern: el.dataset.pattern }); break;
  }
});

// customer / site
let siteFormMode = 'new';
function openSiteForm(mode) {
  siteFormMode = mode;
  const cur = core.currentCustSite(db);
  $('#custSiteForm').hidden = false;
  $('#custSiteSubmit').textContent = mode === 'rename' ? 'Rename' : 'Create';
  $('#custSiteInput').value = mode === 'rename' && cur ? cur.name : '';
  $('#custSiteInput').focus();
  $('#custSiteInput').select();
}
$('#custSiteNewBtn').onclick = () => openSiteForm('new');
$('#custSiteRenameBtn').onclick = () => openSiteForm('rename');
$('#custSiteCancel').onclick = () => { $('#custSiteForm').hidden = true; };
$('#custSiteForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#custSiteInput').value.trim();
  if (!name) return;
  if (siteFormMode === 'rename') await send({ cmd: 'renameCustSite', id: db.settings.currentCustSite, name });
  else { await send({ cmd: 'createCustSite', name, tabId: tab && tab.id }); toast(`Working at ${name}`); }
  $('#custSiteForm').hidden = true;
};
$('#custSiteSelect').onchange = async e => {
  if (!e.target.value) return;
  await send({ cmd: 'selectCustSite', id: e.target.value, tabId: tab && tab.id });
  toast(`Working at ${core.custSiteName(db, e.target.value)}`);
  e.target.blur();
};

$('#newSetBtn').onclick = () => { $('#newSetForm').hidden = false; $('#newSetText').focus(); };
$('#newSetCancel').onclick = () => { $('#newSetForm').hidden = true; $('#newSetText').value = ''; };
$('#newSetText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#newSetForm').requestSubmit(); }
});
$('#newSetForm').onsubmit = async e => {
  e.preventDefault();
  await send({ cmd: 'createChangeset', description: $('#newSetText').value });
  $('#newSetText').value = ''; $('#newSetForm').hidden = true;
};

$('#siteForm').onsubmit = e => {
  e.preventDefault();
  let v = $('#siteInput').value.trim();
  if (!v) return;
  if (!/^(\*|https?):\/\//.test(v)) v = 'http://' + v;
  try {
    if (!/\/\*$/.test(v)) { const u = new URL(v.replace('://*', '://wildcard')); v = `${u.protocol}//${u.hostname.replace('wildcard', '*')}/*`; }
  } catch { toast('That does not look like an address.'); return; }
  $('#siteInput').value = '';
  watchSite(v);
};

$('#regexForm').onsubmit = async e => {
  e.preventDefault();
  const v = $('#regexInput').value.trim();
  if (v) { try { new RegExp(v); } catch { toast('Not a valid regular expression.'); return; } }
  await send({ cmd: 'setIdRegex', value: v });
  toast(v ? 'Shuttle ID pattern saved' : 'Using the default shuttle ID rules');
};

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };

$('#exportAll').onclick = () => download(`logbook-changes-${stamp()}.csv`, core.csvAllChanges(db), 'text/csv;charset=utf-8');
$('#exportFinal').onclick = () => {
  const solved = Object.values(db.changesets).some(c => c.outcome === 'solved');
  if (!solved) { toast('No changesets closed as solved yet.'); return; }
  download(`logbook-final-values-${stamp()}.csv`, core.csvFinalValues(db), 'text/csv;charset=utf-8');
};
$('#backupBtn').onclick = () => download(`logbook-backup-${stamp()}.json`, JSON.stringify(db, null, 2), 'application/json');
$('#restoreInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !data.changesets || !data.changes) throw new Error();
    if (!confirm('Replace the current logbook with this backup?')) return;
    await send({ cmd: 'importDb', db: data });
    toast('Backup restored');
  } catch { toast('That file is not a logbook backup.'); }
  e.target.value = '';
};
$('#resetBtn').onclick = async () => {
  if (!confirm('Delete all changesets and changes? Export a backup first if you need them.')) return;
  await send({ cmd: 'resetDb' });
  toast('Logbook cleared');
};

refresh();
refreshTab();
