// Commissioning Logbook — content script.
// Strictly read-only towards the page: it reads field values and listens to events.
// It never changes a value, never submits, never blocks or delays the page's own actions.
(() => {
  if (window.__commissioningLogbook) return;
  window.__commissioningLogbook = true;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
  const SAVE_WORDS = /\b(save|apply|write|send|commit|opslaan|toepassen|bewaren|schrijven|enregistrer|appliquer|speichern|übernehmen)\b/i;

  let baseline = {};   // key -> value at page load (or after the last re-read)
  let labels = {};     // key -> detected label

  // -------------------------------------------------------------- reading fields

  function keyOf(el) { return el.name || el.id || ''; }

  function tracked(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
    if (el instanceof HTMLInputElement && SKIP_TYPES.has((el.type || '').toLowerCase())) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.closest('[data-logbook-ignore]')) return false;
    return !!keyOf(el);
  }

  function valueOf(el, scope) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked ? 'on' : 'off';
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const root = scope || el.form || document;
      const checked = [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)].find(r => r.checked);
      return checked ? checked.value : '';
    }
    if (el instanceof HTMLSelectElement && el.multiple) return [...el.selectedOptions].map(o => o.value).join('|');
    return el.value;
  }

  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/[:*]\s*$/, '').trim().slice(0, 80);

  function textWithout(node, el) {
    // text of a container, minus the control itself and option lists
    const c = node.cloneNode(true);
    c.querySelectorAll('input,select,textarea,option,button,script,style').forEach(n => n.remove());
    return clean(c.textContent);
  }

  function labelOf(el) {
    // 1. <label for> or a wrapping <label>
    if (el.labels && el.labels.length) {
      const t = textWithout(el.labels[0], el);
      if (t) return t;
    }
    // 2. ARIA
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    // 3. table row: the header cell, or the first cell that does not hold the control
    const tr = el.closest('tr');
    if (tr) {
      const cell = tr.querySelector('th') || [...tr.cells].find(td => !td.contains(el));
      if (cell) { const t = textWithout(cell, el); if (t) return t; }
    }
    // 4. the nearest preceding sibling text, walking up a few levels
    let node = el;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const t = textWithout(sib, el);
        if (t) return t;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    // 5. hints on the control itself
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '') || keyOf(el);
  }

  function collect(scope) {
    const values = {}, lbls = {};
    const root = scope || document;
    for (const el of root.querySelectorAll('input,select,textarea')) {
      if (!tracked(el)) continue;
      const k = keyOf(el);
      if (k in values) continue;
      values[k] = valueOf(el, scope);
      lbls[k] = labelOf(el);
    }
    return { values, labels: lbls };
  }

  // -------------------------------------------------------------- messaging

  function send(msg) {
    try { chrome.runtime.sendMessage({ ...msg, url: location.href }).catch(() => {}); } catch { /* extension reloaded */ }
  }

  function edited() {
    const now = collect().values;
    return Object.keys(now).filter(k => k in baseline && now[k] !== baseline[k]);
  }

  function snapshot(reason, editedKeys = []) {
    const { values, labels: l } = collect();
    if (!Object.keys(values).length) return; // not a parameter page
    baseline = values;
    labels = l;
    const fields = {};
    for (const k of Object.keys(values)) fields[k] = { value: values[k], label: l[k] };
    send({ type: 'snapshot', reason, fields, editedKeys });
    reportDirty();
  }

  let dirtyTimer = null;
  function reportDirty() {
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
      const { values, labels: l } = collect();
      const dirty = Object.keys(values)
        .filter(k => k in baseline && values[k] !== baseline[k])
        .map(k => ({ key: k, label: l[k], from: baseline[k], to: values[k] }));
      send({ type: 'dirty', dirty });
    }, 150);
  }

  // -------------------------------------------------------------- events (observe only)

  document.addEventListener('input', e => { if (tracked(e.target)) reportDirty(); }, true);
  document.addEventListener('change', e => { if (tracked(e.target)) reportDirty(); }, true);

  // Regular form posts: record what was submitted. The read-back happens on the next page load.
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const { values, labels: l } = collect(form);
    if (!Object.keys(values).length) return;
    const base = {};
    for (const k of Object.keys(values)) if (k in baseline) base[k] = baseline[k];
    send({ type: 'submit', baseline: base, values, labels: l });
    // If the page handles the form with JavaScript and does not navigate, re-read it after a moment.
    setTimeout(() => snapshot('after-submit'), 1500);
  }, true);

  // Pages that save with JavaScript (no form post): after a "Save"-like button, re-read the page.
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('button,[role=button],input[type=button]');
    if (!btn || btn.closest('form') && (btn.type || 'submit') === 'submit') return;
    const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
    if (!SAVE_WORDS.test(text)) return;
    const keys = edited();
    if (!keys.length) return;
    setTimeout(() => snapshot('after-save-click', keys), 1500);
  }, true);

  // Back/forward cache: the page did not reload, re-read it.
  window.addEventListener('pageshow', e => { if (e.persisted) snapshot('pageshow'); });

  // The sidebar's "Re-read page" button.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'reread') { snapshot('manual', edited()); reply({ ok: true }); }
  });

  // Initial read. Give scripted pages a moment to fill their fields.
  const start = () => setTimeout(() => snapshot('load'), 300);
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
})();
