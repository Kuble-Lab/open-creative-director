'use strict';

// The note where a picture, video or sound of a chat or workflow does not load because its file was moved into the archive
// (lib/storage-overview.js): "In the archive" with a button that fetches it back, and one for everything else of the same
// chat or workflow. Works on every page that loads it: it listens for media that fail to load, asks the server whether the
// file is in the archive (GET api/storage/archived) and puts the note in place of the element. Nothing is built into the
// views themselves; a view that renders again gets its note again from the remembered answer.
// All values from the server are written as text, never as HTML.
(() => {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  const ASSET_PATH = /(?:^|\/)assets\/([A-Za-z0-9_-]+)\/([^?#]+)$/;
  const NEGATIVE_MS = 60 * 1000;
  const POLL_MS = 3000;
  const COMPACT_BELOW = 150;

  // "/sub/assets/<session>/a/b%20c.mp4?x=1" -> { sessionId, file: "a/b c.mp4" }, null for anything else.
  function assetRef(url, base) {
    let pathname = '';
    try {
      pathname = new URL(String(url || ''), base || 'http://local/').pathname;
    } catch (_) {
      return null;
    }
    const match = ASSET_PATH.exec(pathname);
    if (!match) return null;
    try {
      const file = match[2].split('/').map(decodeURIComponent).join('/');
      if (!file || file.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
      return { sessionId: match[1], file };
    } catch (_) {
      return null;
    }
  }

  function formatBytes(value, lang = 'de') {
    let amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) amount = 0;
    let unit = 0;
    while (amount >= 1024 && unit < UNITS.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || amount >= 100 ? 0 : 1;
    return `${new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)} ${UNITS[unit]}`;
  }

  // What the note says for an answer of the server: { text: key, vars, restore: bool, all: bool, working: bool }.
  function noteModel(state) {
    if (!state || (!state.archived && !state.job)) return null;
    if (state.job === 'error') return { text: 'archived.error', vars: { reason: state.jobError || '' }, restore: Boolean(state.canRestore), all: false, working: false };
    if (state.job) return { text: state.jobProgress ? 'archived.workingShare' : 'archived.working', vars: { share: state.jobProgress || 0 }, restore: false, all: false, working: true };
    if (!state.canRestore) return { text: 'archived.offline', vars: {}, restore: false, all: false, working: false };
    return { text: 'archived.note', vars: {}, restore: true, all: Boolean(state.others && state.others.files > 0), working: false };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { assetRef, formatBytes, noteModel };
    return;
  }

  const T = (key, vars) => (typeof window.t === 'function' ? window.t(key, vars) : key);
  const lang = () => (typeof window.getLang === 'function' ? window.getLang() : 'de');
  const keyOf = (ref) => `${ref.sessionId}/${ref.file}`;
  // key -> { ref, state, at, request, timer, elements: Set }
  const known = new Map();

  async function ask(ref) {
    const response = await fetch(`api/storage/archived?sessionId=${encodeURIComponent(ref.sessionId)}&file=${encodeURIComponent(ref.file)}`, { cache: 'no-store' });
    if (!response.ok) return { archived: false };
    return response.json();
  }

  function mediaOf(target) {
    if (!target || !target.tagName) return null;
    if (target.tagName === 'SOURCE') return target.parentElement && /^(VIDEO|AUDIO)$/.test(target.parentElement.tagName) ? target.parentElement : null;
    return /^(IMG|VIDEO|AUDIO)$/.test(target.tagName) ? target : null;
  }

  function urlOf(element, target) {
    if (target && target.tagName === 'SOURCE') return target.getAttribute('src');
    return element.currentSrc || element.getAttribute('src') || (element.querySelector && element.querySelector('source') ? element.querySelector('source').getAttribute('src') : '');
  }

  function removeNote(element) {
    const note = element.nextElementSibling;
    if (note && note.classList.contains('archived-note')) note.remove();
    element.classList.remove('is-archived-media');
  }

  function button(label, onClick) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return item;
  }

  function render(entry) {
    const model = noteModel(entry.state);
    for (const element of [...entry.elements]) {
      if (!element.isConnected) {
        entry.elements.delete(element);
        continue;
      }
      if (!model) {
        removeNote(element);
        continue;
      }
      const compact = !element.classList.contains('is-archived-media') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().width < COMPACT_BELOW;
      let note = element.nextElementSibling;
      if (!note || !note.classList.contains('archived-note')) {
        note = document.createElement('div');
        note.className = compact ? 'archived-note is-compact' : 'archived-note';
        note.setAttribute('role', 'status');
        element.after(note);
      }
      element.classList.add('is-archived-media');
      const small = note.classList.contains('is-compact');
      const size = entry.state.size ? formatBytes(entry.state.size, lang()) : '';
      const text = document.createElement('span');
      text.className = 'archived-note-text';
      text.textContent = small ? T('archived.short') : `${T(model.text, model.vars)}${size && !model.working ? ` (${size})` : ''}`;
      note.title = small ? `${T(model.text, model.vars)}${size ? ` (${size})` : ''}` : '';
      note.replaceChildren(text);
      if (model.restore) note.append(button(T('archived.restore'), () => restore(entry, false)));
      if (model.all && !small) {
        const others = entry.state.others;
        note.append(button(T('archived.restoreAll', { count: others.files + 1, size: formatBytes(others.bytes + (entry.state.size || 0), lang()) }), () => restore(entry, true)));
      }
    }
  }

  function reload(element) {
    removeNote(element);
    const stamp = `r=${Date.now()}`;
    const fresh = (url) => (url ? `${url.split('#')[0]}${url.includes('?') ? '&' : '?'}${stamp}` : url);
    if (element.tagName === 'IMG') {
      element.src = fresh(element.getAttribute('src'));
      return;
    }
    for (const source of element.querySelectorAll('source')) source.setAttribute('src', fresh(source.getAttribute('src')));
    if (element.getAttribute('src')) element.setAttribute('src', fresh(element.getAttribute('src')));
    element.load();
  }

  async function refresh(entry) {
    clearTimeout(entry.timer);
    try {
      entry.state = await ask(entry.ref);
    } catch (_) {
      entry.state = { archived: false };
    }
    entry.at = Date.now();
    const working = Boolean(entry.state.job) && entry.state.job !== 'error';
    if (!entry.state.archived && !entry.state.job && entry.wasArchived) {
      // back on the server: show it again
      entry.wasArchived = false;
      for (const element of entry.elements) if (element.isConnected) reload(element);
      entry.elements.clear();
      return;
    }
    if (entry.state.archived) entry.wasArchived = true;
    render(entry);
    if (working) entry.timer = setTimeout(() => refresh(entry), POLL_MS);
  }

  async function restore(entry, whole) {
    const body = whole ? { sessions: [entry.ref.sessionId] } : { files: [entry.ref] };
    try {
      const response = await fetch('api/storage/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) entry.state = { ...entry.state, job: 'error', jobError: data.error || '' };
      else if (data.failed && data.failed.some((item) => item.file === entry.ref.file)) entry.state = { ...entry.state, job: 'error', jobError: data.failed.find((item) => item.file === entry.ref.file).error };
      else {
        // the other notes of the same chat or workflow follow
        if (whole) for (const other of known.values()) if (other !== entry && other.ref.sessionId === entry.ref.sessionId) refresh(other);
        return refresh(entry);
      }
    } catch (err) {
      entry.state = { ...entry.state, job: 'error', jobError: err.message };
    }
    render(entry);
    return null;
  }

  function onError(event) {
    const element = mediaOf(event.target);
    if (!element) return;
    const ref = assetRef(urlOf(element, event.target), document.baseURI);
    if (!ref) return;
    const key = keyOf(ref);
    let entry = known.get(key);
    if (!entry) {
      entry = { ref, state: null, at: 0, timer: null, wasArchived: false, elements: new Set() };
      known.set(key, entry);
    }
    entry.elements.add(element);
    const settled = entry.state && !entry.state.archived && !entry.state.job;
    if (entry.state && (!settled || Date.now() - entry.at < NEGATIVE_MS)) {
      render(entry);
      return;
    }
    if (entry.request) return;
    entry.request = refresh(entry).finally(() => {
      entry.request = null;
    });
  }

  window.addEventListener('error', onError, true);
})();
