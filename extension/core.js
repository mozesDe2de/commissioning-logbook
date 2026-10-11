// Commissioning Logbook — pure logic, no browser APIs (so it can be unit-tested in Node).
// The database is one plain object kept in chrome.storage.local by background.js.

export const DEFAULT_REASON = 'why are we doing this change ?';
export const OUTSIDE_REASON = 'Changed outside this browser — why?';

// Change statuses
export const ST = {
  SAVED: 'saved',             // submitted to the shuttle, waiting for the page to read it back
  CONFIRMED: 'confirmed',     // read back after reload: the shuttle shows the new value
  NOT_APPLIED: 'not_applied', // read back: shuttle still shows the old value (rejected, or waits for restart)
  ADJUSTED: 'adjusted',       // read back: shuttle shows a different value (clamped / rounded)
  DETECTED: 'detected',       // changed outside this browser, found on a later page load
  SUPERSEDED: 'superseded',   // replaced by a newer save of the same field before it was confirmed
};
const OPEN_STATUSES = [ST.SAVED, ST.NOT_APPLIED];

// Outside-change guard: when one page load differs from what was stored for this shuttle on at
// least this many fields, and on at least this share of the comparable fields, it is more likely
// that the engineer is at another customer/site with the same addresses than that someone changed
// that much outside the browser. The logbook then asks instead of logging.
export const SUSPECT_MIN_FIELDS = 3;
export const SUSPECT_SHARE = 0.5;

export const DB_VERSION = 2;
export const UNASSIGNED_NAME = 'Unassigned (pilot)';

export function emptyDb() {
  return {
    version: DB_VERSION,
    seqs: {},
    settings: { sites: ['http://localhost/*', 'http://127.0.0.1/*'], idRegex: '', currentCustSite: null },
    custSites: {},   // id -> { id, name, createdAt }   ("customer / site": shuttle addresses repeat per site)
    changesets: {},
    changes: {},
    shuttles: {},
    labelOverrides: {},
    ignored: {},
  };
}

function nextId(db, prefix) {
  // separate counters so changesets read as #1, #2, ... regardless of how many changes exist
  db.seqs = db.seqs || {};
  db.seqs[prefix] = (db.seqs[prefix] || 0) + 1;
  return prefix === 'cs' ? `#${db.seqs[prefix]}` : `${prefix}${db.seqs[prefix]}`;
}

// ---------------------------------------------------------------- customer / site

export function createCustSite(db, name, now) {
  const n = (name || '').trim();
  if (!n) return null;
  const existing = Object.values(db.custSites).find(c => c.name.toLowerCase() === n.toLowerCase());
  if (existing) return existing;
  const id = nextId(db, 'site');
  db.custSites[id] = { id, name: n, createdAt: now };
  return db.custSites[id];
}

export function renameCustSite(db, id, name) {
  const n = (name || '').trim();
  if (db.custSites[id] && n) db.custSites[id].name = n;
}

export function selectCustSite(db, id) {
  db.settings.currentCustSite = db.custSites[id] ? id : null;
}

export const currentCustSite = db => (db.settings && db.custSites && db.custSites[db.settings.currentCustSite]) || null;
export const custSiteName = (db, id) => (db.custSites && db.custSites[id] && db.custSites[id].name) || '';

/** Shuttles are stored per customer/site: the same address is a different shuttle at the next site. */
export const shuttleKey = (custSite, sid) => `${custSite}|${sid}`;

/** Bring an older logbook (or backup) up to the current structure. Safe to call on any db. */
export function migrate(db, now = Date.now()) {
  if (!db || typeof db !== 'object') return emptyDb();
  db.version = db.version || 1;
  db.settings = db.settings || {};
  if (db.settings.currentCustSite === undefined) db.settings.currentCustSite = null;
  db.custSites = db.custSites || {};
  db.changesets = db.changesets || {};
  db.changes = db.changes || {};
  db.shuttles = db.shuttles || {};
  db.labelOverrides = db.labelOverrides || {};
  db.ignored = db.ignored || {};
  if (db.version < 2) {
    const hasData = Object.keys(db.changes).length || Object.keys(db.changesets).length || Object.keys(db.shuttles).length;
    if (hasData) {
      // Everything recorded before customer/sites existed goes to one site the engineer can rename.
      const site = createCustSite(db, UNASSIGNED_NAME, now);
      for (const c of Object.values(db.changes)) c.custSite = c.custSite || site.id;
      for (const c of Object.values(db.changesets)) c.custSite = c.custSite || site.id;
      const shuttles = {};
      for (const [sid, sh] of Object.entries(db.shuttles)) shuttles[sid.includes('|') ? sid : shuttleKey(site.id, sid)] = sh;
      db.shuttles = shuttles;
    }
    db.version = 2;
  }
  return db;
}

// ---------------------------------------------------------------- values

export function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const sa = String(a).trim(), sb = String(b).trim();
  if (sa === sb) return true;
  const na = Number(sa.replace(',', '.')), nb = Number(sb.replace(',', '.'));
  if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  return false;
}

// ---------------------------------------------------------------- shuttle id

export function shuttleIdFromUrl(url, idRegex) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (idRegex) {
    try {
      const m = new RegExp(idRegex, 'i').exec(url);
      if (m) return m[1] || m[0];
    } catch { /* invalid regex: fall through to defaults */ }
  }
  const path = /\/shuttles?\/([^/?#]+)/i.exec(u.pathname);
  if (path) return decodeURIComponent(path[1]);
  for (const k of ['shuttle', 'shuttleId', 'shuttle_id', 'sid', 'id']) {
    const v = u.searchParams.get(k);
    if (v) return v;
  }
  return u.host; // one shuttle per address, e.g. http://10.20.1.15 (unique only within a customer/site)
}

// ---------------------------------------------------------------- labels

export function displayLabel(db, key, detected) {
  return (db.labelOverrides && db.labelOverrides[key]) || detected || key;
}

export function setLabelOverride(db, key, label) {
  const l = (label || '').trim();
  if (l) db.labelOverrides[key] = l;
  else delete db.labelOverrides[key];
}

// ---------------------------------------------------------------- changesets

export function createChangeset(db, description, now, extra = {}) {
  const id = nextId(db, 'cs');
  db.changesets[id] = {
    id,
    description: (description || '').trim() || DEFAULT_REASON,
    status: 'active',
    outcome: null,
    note: '',
    createdAt: now,
    lastEditedAt: now,
    closedAt: null,
    ...extra,
  };
  return db.changesets[id];
}

/** Active changesets, optionally only those of one customer/site. */
export function activeChangesets(db, custSite) {
  return Object.values(db.changesets)
    .filter(c => c.status === 'active' && (custSite === undefined || c.custSite === custSite))
    .sort((a, b) => (b.lastEditedAt - a.lastEditedAt) || (b.createdAt - a.createdAt));
}

/** The changeset that receives new browser changes. Implements the agreed rules:
 *  sidebar closed, or no active changeset  -> a new changeset with the default reason
 *  otherwise                               -> the most recently edited active changeset */
export function targetChangeset(db, custSite, sidebarOpen, now) {
  // Auto-created "outside" changesets only become eligible once the engineer has edited them.
  // Only changesets of the current customer/site are candidates.
  const active = activeChangesets(db, custSite).filter(c => c.lastEditedAt > 0);
  if (!sidebarOpen || active.length === 0) return createChangeset(db, DEFAULT_REASON, now, { auto: true, custSite });
  return active[0];
}

/** Which changeset would receive the next browser change while the sidebar is open (null = a new one). */
export function currentTarget(db, custSite) {
  return activeChangesets(db, custSite).find(c => c.lastEditedAt > 0) || null;
}

export function touchChangeset(db, id, now) {
  const cs = db.changesets[id];
  if (cs) cs.lastEditedAt = now;
}

export function updateChangeset(db, id, fields, now) {
  const cs = db.changesets[id];
  if (!cs) return;
  if (fields.description !== undefined) cs.description = fields.description.trim() || DEFAULT_REASON;
  if (fields.note !== undefined) cs.note = fields.note;
  cs.lastEditedAt = now;
}

export function closeChangeset(db, id, outcome, now) {
  const cs = db.changesets[id];
  if (!cs) return;
  cs.status = 'closed';
  cs.outcome = outcome;
  cs.closedAt = now;
}

export function reopenChangeset(db, id, now) {
  const cs = db.changesets[id];
  if (!cs) return;
  cs.status = 'active';
  cs.outcome = null;
  cs.closedAt = null;
  cs.lastEditedAt = now;
}

export function changesOf(db, csId) {
  return Object.values(db.changes).filter(c => c.changesetId === csId).sort((a, b) => a.at - b.at);
}

export function deleteChangesetIfEmpty(db, id) {
  if (changesOf(db, id).length === 0) { delete db.changesets[id]; return true; }
  return false;
}

/** Move a change to another changeset ('new' creates one). Auto-created changesets left
 *  empty and still without a reason are removed, so moving does not leave litter behind. */
export function moveChange(db, changeId, targetId, now) {
  const ch = db.changes[changeId];
  if (!ch) return null;
  const from = ch.changesetId;
  let target = targetId === 'new' ? createChangeset(db, DEFAULT_REASON, now, { custSite: ch.custSite }) : db.changesets[targetId];
  if (!target || target.custSite !== ch.custSite) return null; // never move a change to another customer/site
  ch.changesetId = target.id;
  target.lastEditedAt = now;
  const src = db.changesets[from];
  if (src && src.id !== target.id && (src.description === DEFAULT_REASON || src.description === OUTSIDE_REASON)) {
    deleteChangesetIfEmpty(db, src.id);
  }
  return target;
}

// ---------------------------------------------------------------- changes

function addChange(db, c) {
  const id = nextId(db, 'ch');
  db.changes[id] = { id, actual: null, confirmedAt: null, ...c };
  return db.changes[id];
}

function openChangeFor(db, custSite, sid, key) {
  return Object.values(db.changes)
    .filter(c => c.custSite === custSite && c.shuttleId === sid && c.field === key && OPEN_STATUSES.includes(c.status))
    .sort((a, b) => b.at - a.at)[0] || null;
}

function shuttle(db, custSite, sid) {
  const k = shuttleKey(custSite, sid);
  if (!db.shuttles[k]) db.shuttles[k] = { fields: {}, firstSeen: null, lastSeen: null };
  return db.shuttles[k];
}

/** The engineer pressed Save (form submit). `baseline` = values when the page loaded,
 *  `values` = values at submit. Every difference becomes a change with status 'saved'. */
export function onSubmit(db, { custSite, sid, url, baseline, values, labels, sidebarOpen, now }) {
  const diffs = Object.keys(values).filter(k =>
    !db.ignored[k] && k in baseline && !valuesEqual(values[k], baseline[k]));
  if (!diffs.length) return [];
  const cs = targetChangeset(db, custSite, sidebarOpen, now);
  const created = [];
  for (const k of diffs) {
    const prev = openChangeFor(db, custSite, sid, k);
    if (prev) prev.status = ST.SUPERSEDED;
    created.push(addChange(db, {
      changesetId: cs.id, custSite, shuttleId: sid, field: k, label: labels[k] || k,
      from: baseline[k], to: values[k], status: ST.SAVED, source: 'browser', url, at: now,
    }));
  }
  return created;
}

/** A page with parameter fields was (re)loaded or re-read. Confirms saved changes and detects
 *  differences against the last known values. `editedKeys` are fields the engineer edited on the
 *  page without a detected form submit (pages that save with JavaScript): diffs on those count
 *  as browser changes, not as outside changes.
 *  If many fields differ at once (see SUSPECT_*), nothing is recorded and `result.suspect` is set,
 *  unless `force` is true (the engineer confirmed it really is the same customer/site). */
export function onSnapshot(db, { custSite, sid, url, fields, editedKeys = [], sidebarOpen, now, force = false }) {
  const result = { confirmed: [], notApplied: [], adjusted: [], browser: [], outside: [], suspect: null };
  const known0 = (db.shuttles[shuttleKey(custSite, sid)] || { fields: {} }).fields;

  if (!force) {
    let compared = 0, differing = 0;
    for (const [k, f] of Object.entries(fields)) {
      if (db.ignored[k] || !known0[k] || editedKeys.includes(k) || openChangeFor(db, custSite, sid, k)) continue;
      compared++;
      if (!valuesEqual(known0[k].value, f.value)) differing++;
    }
    if (differing >= SUSPECT_MIN_FIELDS && differing >= SUSPECT_SHARE * compared) {
      result.suspect = { differing, compared };
      return result; // record nothing: the stored values stay as they were
    }
  }

  const sh = shuttle(db, custSite, sid);
  sh.firstSeen = sh.firstSeen || now;
  sh.lastSeen = now;
  const browserDiffs = [], outsideDiffs = [];

  for (const [k, f] of Object.entries(fields)) {
    if (db.ignored[k]) continue;
    const known = sh.fields[k];
    const open = openChangeFor(db, custSite, sid, k);
    if (open) {
      if (valuesEqual(f.value, open.to)) {
        open.status = ST.CONFIRMED; open.actual = f.value; open.confirmedAt = now;
        result.confirmed.push(open);
      } else if (valuesEqual(f.value, open.from)) {
        if (open.status !== ST.NOT_APPLIED) result.notApplied.push(open);
        open.status = ST.NOT_APPLIED; open.actual = f.value;
      } else {
        open.status = ST.ADJUSTED; open.actual = f.value; open.confirmedAt = now;
        result.adjusted.push(open);
      }
    } else if (known && !valuesEqual(known.value, f.value)) {
      (editedKeys.includes(k) ? browserDiffs : outsideDiffs).push([k, known.value, f]);
    }
    sh.fields[k] = { value: f.value, label: f.label || k, lastSeen: now };
  }

  if (browserDiffs.length) {
    const cs = targetChangeset(db, custSite, sidebarOpen, now);
    for (const [k, from, f] of browserDiffs) {
      result.browser.push(addChange(db, {
        changesetId: cs.id, custSite, shuttleId: sid, field: k, label: f.label || k, from, to: f.value,
        actual: f.value, status: ST.CONFIRMED, confirmedAt: now, source: 'browser', url, at: now,
      }));
    }
  }
  if (outsideDiffs.length) {
    // Outside changes get their own changeset so they never land silently in the engineer's
    // current work. lastEditedAt 0 keeps it from becoming the target for new browser changes.
    const cs = createChangeset(db, OUTSIDE_REASON, now, { auto: true, source: 'outside', lastEditedAt: 0, custSite });
    for (const [k, from, f] of outsideDiffs) {
      result.outside.push(addChange(db, {
        changesetId: cs.id, custSite, shuttleId: sid, field: k, label: f.label || k, from, to: f.value,
        actual: f.value, status: ST.DETECTED, confirmedAt: now, source: 'outside', url, at: now,
      }));
    }
  }
  return result;
}

/** Stop tracking a field (e.g. a counter that changes on every load). Its outside detections go too. */
export function ignoreField(db, key) {
  db.ignored[key] = true;
  for (const c of Object.values(db.changes)) {
    if (c.field === key && c.status === ST.DETECTED) {
      const cs = c.changesetId;
      delete db.changes[c.id];
      if (db.changesets[cs] && db.changesets[cs].source === 'outside') deleteChangesetIfEmpty(db, cs);
    }
  }
}

export function unignoreField(db, key) { delete db.ignored[key]; }

// ---------------------------------------------------------------- export

// Semicolon + UTF-8 BOM: opens correctly in Excel with Belgian/Dutch regional settings.
function csv(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

export function isoLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function csvAllChanges(db) {
  const rows = [['customer_site', 'changeset_id', 'reason', 'changeset_status', 'outcome', 'outcome_note', 'shuttle', 'parameter',
    'field_key', 'from', 'to', 'value_on_shuttle', 'change_status', 'source', 'changed_at', 'read_back_at', 'url']];
  const list = Object.values(db.changes).sort((a, b) => a.at - b.at);
  for (const c of list) {
    const cs = db.changesets[c.changesetId] || {};
    rows.push([custSiteName(db, c.custSite), cs.id, cs.description, cs.status, cs.outcome || '', cs.note || '', c.shuttleId,
      displayLabel(db, c.field, c.label), c.field, c.from, c.to, c.actual ?? '', c.status, c.source,
      isoLocal(c.at), isoLocal(c.confirmedAt), c.url]);
  }
  return csv(rows);
}

/** Final values of changesets closed as "solved": one row per customer/site + shuttle + parameter,
 *  ready to paste into the central sheet. */
export function csvFinalValues(db) {
  const rows = [['customer_site', 'changeset_id', 'reason', 'outcome_note', 'closed_at', 'shuttle', 'parameter', 'field_key',
    'value_before', 'final_value']];
  const solved = Object.values(db.changesets).filter(c => c.status === 'closed' && c.outcome === 'solved')
    .sort((a, b) => a.closedAt - b.closedAt);
  for (const cs of solved) {
    const byKey = new Map();
    for (const c of changesOf(db, cs.id)) {
      if (c.status === ST.SUPERSEDED) continue;
      const k = `${c.custSite}\u0000${c.shuttleId}\u0000${c.field}`;
      const e = byKey.get(k);
      if (!e) byKey.set(k, { first: c, last: c }); else e.last = c;
    }
    for (const { first, last } of byKey.values()) {
      rows.push([custSiteName(db, last.custSite), cs.id, cs.description, cs.note || '', isoLocal(cs.closedAt), last.shuttleId,
        displayLabel(db, last.field, last.label), last.field, first.from, last.actual ?? last.to]);
    }
  }
  return csv(rows);
}
