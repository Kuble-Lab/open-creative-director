'use strict';

// Storage overview page (public/storage.html, data: GET api/storage, delete: POST api/storage/delete).
// All values from the server are written as text, never as HTML.
(() => {
  const PAGE = 100;
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  // 1536 -> "1.5 KB" in the number format of the language. Binary steps, as the disk tools of the server count.
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

  // The files the filters leave, in the chosen order. `sessions` (Map id -> session) gives owner and title.
  function visibleFiles(files, sessions, { type = '', owner = null, sort = 'size', search = '' } = {}) {
    const needle = String(search || '').trim().toLowerCase();
    const list = files.filter((file) => {
      if (type && file.type !== type) return false;
      const session = sessions.get(file.sessionId) || {};
      if (owner !== null && (session.owner || '') !== owner) return false;
      if (!needle) return true;
      return [file.name, file.file, file.prompt, session.title, session.owner].some((text) => String(text || '').toLowerCase().includes(needle));
    });
    const compare = {
      size: (a, b) => b.size - a.size,
      new: (a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)),
      old: (a, b) => String(a.modifiedAt).localeCompare(String(b.modifiedAt)),
      name: (a, b) => String(a.name).localeCompare(String(b.name))
    }[sort] || ((a, b) => b.size - a.size);
    return list.sort((a, b) => compare(a, b) || String(a.file).localeCompare(String(b.file)));
  }

  const keyOf = (file) => `${file.sessionId}/${file.file}`;

  if (typeof module === 'object' && module.exports) {
    module.exports = { formatBytes, visibleFiles, keyOf };
    return;
  }

  const el = (id) => document.getElementById(id);
  const T = (key, vars) => window.t(`storage.${key}`, vars);
  const lang = () => window.getLang();
  const bytes = (value) => formatBytes(value, lang());
  const number = (value) => new Intl.NumberFormat(lang()).format(value);
  const stamp = (value) => {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    return new Intl.DateTimeFormat(lang(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(time);
  };

  let report = null;
  let sessions = new Map();
  let request = null;
  let shown = PAGE;
  let pendingDelete = [];
  const selected = new Map();

  function node(tag, content, className) {
    const item = document.createElement(tag);
    if (content !== undefined && content !== null) item.textContent = content;
    if (className) item.className = className;
    return item;
  }

  function setStatus(text, error = false) {
    el('status').className = error ? 'mon-status error' : 'mon-status';
    el('status').textContent = text || '';
  }

  const fileCount = (count) => (count === 1 ? T('fileCountOne') : T('fileCount', { count: number(count) }));

  function metric(label, value, hint) {
    const item = node('div', '', 'mon-metric');
    item.append(node('dt', label), node('dd', value));
    if (hint) item.append(node('small', hint, 'mon-muted'));
    return item;
  }

  function sessionLabel(session) {
    if (!session) return '';
    if (session.kind === 'orphan') return T('orphan');
    return session.title || T('untitled');
  }

  function renderDisk() {
    const box = el('disk');
    box.replaceChildren();
    const disk = report.disk;
    box.hidden = !disk;
    if (!disk) return;
    const usedShare = Math.min(100, Math.max(0, (disk.used / disk.total) * 100));
    const appShare = Math.min(usedShare, Math.max(0, (report.totals.bytes / disk.total) * 100));
    box.append(node('h2', T('disk')));
    const bar = node('div', '', 'st-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', T('diskLabel', { free: bytes(disk.free), total: bytes(disk.total) }));
    const used = node('span', '', 'st-bar-used');
    used.style.width = `${usedShare}%`;
    const app = node('span', '', 'st-bar-app');
    app.style.width = `${appShare}%`;
    bar.append(used, app);
    box.append(bar);
    const legend = node('p', '', 'mon-muted st-legend');
    legend.append(
      node('span', T('diskFree', { free: bytes(disk.free), total: bytes(disk.total) }), 'st-free'),
      node('span', T(report.scope === 'all' ? 'diskAppAll' : 'diskAppMine', { size: bytes(report.totals.bytes) }), 'st-key-app'),
      node('span', T('diskOther', { size: bytes(Math.max(0, disk.used - report.totals.bytes)) }), 'st-key-used')
    );
    box.append(legend);
    if (disk.free / disk.total < 0.1) box.append(node('p', T('diskLow'), 'st-warn'));
  }

  function renderMetrics() {
    const totals = report.totals;
    const list = el('metrics');
    list.replaceChildren(
      metric(T(report.scope === 'all' ? 'totalAll' : 'totalMine'), bytes(totals.bytes), fileCount(totals.files)),
      metric(T('typeVideo'), bytes(totals.byType.video.bytes), fileCount(totals.byType.video.files)),
      metric(T('typeImage'), bytes(totals.byType.image.bytes), fileCount(totals.byType.image.files)),
      metric(T('typeAudio'), bytes(totals.byType.audio.bytes), fileCount(totals.byType.audio.files)),
      metric(T('typeRest'), bytes(totals.byType.document.bytes + totals.byType.other.bytes + totals.otherBytes), '')
    );
  }

  function renderOwners() {
    const box = el('owners');
    box.replaceChildren();
    const field = el('ownerField');
    const select = el('owner');
    const show = report.scope === 'all' && report.accounts && report.owners.length > 0;
    field.hidden = !show;
    if (!show) {
      select.replaceChildren();
      return;
    }
    const before = select.value;
    select.replaceChildren(new Option(T('ownerAll'), '*'));
    for (const entry of report.owners) select.append(new Option(`${entry.owner || T('noOwner')} (${bytes(entry.bytes)})`, entry.owner || ''));
    select.value = [...select.options].some((option) => option.value === before) ? before : '*';

    box.append(node('h2', T('perPerson')));
    const wrap = node('div', '', 'mon-table-wrap');
    const table = node('table');
    const head = node('tr');
    head.append(node('th', T('owner')), node('th', T('size'), 'number'), node('th', T('filesHead'), 'number'));
    table.append(head);
    for (const entry of report.owners) {
      const row = node('tr');
      row.append(node('td', entry.owner || T('noOwner')), node('td', bytes(entry.bytes), 'number'), node('td', number(entry.files), 'number'));
      table.append(row);
    }
    wrap.append(table);
    box.append(wrap);
  }

  function filters() {
    const owner = el('ownerField').hidden || el('owner').value === '*' ? null : el('owner').value;
    return { type: el('type').value, owner, sort: el('sort').value, search: el('search').value };
  }

  function updateSelection() {
    const count = selected.size;
    let total = 0;
    for (const file of selected.values()) total += file.size;
    el('selection').textContent = count ? T('selected', { count: number(count), size: bytes(total) }) : '';
    el('deleteSelected').disabled = !count;
  }

  function preview(file) {
    const box = node('div', '', 'st-thumb');
    if (file.type === 'image') {
      const image = node('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = file.url.replace(/^\//, '');
      box.append(image);
    } else {
      box.append(node('span', T(`badge.${file.type}`), 'st-badge'));
    }
    return box;
  }

  function renderFiles() {
    const list = visibleFiles(report.files, sessions, filters());
    const box = el('files');
    box.replaceChildren();
    let listBytes = 0;
    for (const file of list) listBytes += file.size;
    el('listTitle').textContent = T('filesTitle', { count: number(list.length), size: bytes(listBytes) });
    if (!list.length) {
      box.append(node('p', T('none'), 'mon-muted'));
      el('more').hidden = true;
      return;
    }
    const showOwner = report.scope === 'all' && report.accounts;
    const wrap = node('div', '', 'mon-table-wrap');
    const table = node('table', '', 'st-table');
    const head = node('tr');
    head.append(node('th', ''), node('th', ''), node('th', T('file')), node('th', T('where')));
    if (showOwner) head.append(node('th', T('owner')));
    head.append(node('th', T('date')), node('th', T('size'), 'number'), node('th', ''));
    table.append(head);
    for (const file of list.slice(0, shown)) {
      const session = sessions.get(file.sessionId);
      const row = node('tr');
      const check = node('input');
      check.type = 'checkbox';
      check.checked = selected.has(keyOf(file));
      check.disabled = file.pending === true;
      check.setAttribute('aria-label', T('select', { name: file.name }));
      check.addEventListener('change', () => {
        if (check.checked) selected.set(keyOf(file), file);
        else selected.delete(keyOf(file));
        updateSelection();
      });
      const pick = node('td');
      pick.append(check);
      const thumb = node('td');
      thumb.append(preview(file));
      const name = node('td', '', 'st-name');
      const link = node('a', file.name);
      link.href = file.url.replace(/^\//, '');
      link.target = '_blank';
      link.rel = 'noopener';
      name.append(link);
      if (file.prompt) name.append(node('small', file.prompt, 'mon-muted st-prompt'));
      const where = node('td', '', 'st-where');
      if (session && session.kind === 'chat') {
        const open = node('a', sessionLabel(session));
        open.href = `./#s=${encodeURIComponent(session.id)}`;
        where.append(open);
      } else {
        where.append(node('span', sessionLabel(session)));
      }
      row.append(pick, thumb, name, where);
      if (showOwner) row.append(node('td', (session && session.owner) || T('noOwner')));
      row.append(node('td', stamp(file.modifiedAt)), node('td', bytes(file.size), 'number'));
      const actions = node('td', '', 'st-actions');
      const download = node('a', T('download'), 'st-button');
      download.href = file.url.replace(/^\//, '');
      download.setAttribute('download', file.name);
      const remove = node('button', T('delete'), 'st-danger');
      remove.type = 'button';
      remove.disabled = file.pending === true;
      remove.addEventListener('click', () => askDelete([file]));
      actions.append(download, remove);
      row.append(actions);
      table.append(row);
    }
    wrap.append(table);
    box.append(wrap);
    el('more').hidden = list.length <= shown;
  }

  function render() {
    renderDisk();
    renderMetrics();
    renderOwners();
    renderFiles();
    updateSelection();
    el('report').hidden = false;
  }

  function askDelete(files) {
    if (!files.length) return;
    pendingDelete = files;
    let total = 0;
    for (const file of files) total += file.size;
    el('confirmTitle').textContent = files.length === 1 ? T('confirmOne') : T('confirmMany', { count: number(files.length) });
    el('confirmText').textContent = T('confirmSize', { size: bytes(total) });
    const list = el('confirmList');
    list.replaceChildren();
    for (const file of files.slice(0, 8)) list.append(node('li', `${file.name} (${bytes(file.size)}) · ${sessionLabel(sessions.get(file.sessionId))}`));
    if (files.length > 8) list.append(node('li', T('confirmMore', { count: number(files.length - 8) })));
    el('confirm').showModal();
  }

  async function runDelete(files) {
    setStatus(T('deleting'));
    try {
      const response = await fetch('api/storage/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files.map((file) => ({ sessionId: file.sessionId, file: file.file })) })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || T('deleteError'));
      for (const item of body.deleted) selected.delete(`${item.sessionId}/${item.file}`);
      await load({ quiet: true });
      const done = T('deleted', { count: number(body.deleted.length), size: bytes(body.freedBytes) });
      if (body.failed.length) setStatus(`${done} ${T('failed', { count: number(body.failed.length), reason: body.failed[0].error })}`, true);
      else setStatus(done);
    } catch (err) {
      setStatus(err.message || T('deleteError'), true);
    }
  }

  async function load({ quiet = false } = {}) {
    if (request) request.abort();
    const current = new AbortController();
    request = current;
    if (!quiet) setStatus(T('loading'));
    try {
      const scope = el('scope').value === 'all' ? '?scope=all' : '';
      const response = await fetch(`api/storage${scope}`, { signal: current.signal, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || T('loadError'));
      report = body;
      sessions = new Map(body.sessions.map((session) => [session.id, session]));
      const known = new Set(body.files.map(keyOf));
      for (const key of [...selected.keys()]) if (!known.has(key)) selected.delete(key);
      el('scopeField').hidden = !(body.canSeeAll && body.accounts);
      if (!quiet) setStatus('');
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(err.message || T('loadError'), true);
    } finally {
      if (request === current) request = null;
    }
  }

  el('filters').addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  el('scope').addEventListener('change', () => {
    selected.clear();
    shown = PAGE;
    load();
  });
  for (const id of ['type', 'owner', 'sort']) {
    el(id).addEventListener('change', () => {
      shown = PAGE;
      if (report) renderFiles();
    });
  }
  el('search').addEventListener('input', () => {
    shown = PAGE;
    if (report) renderFiles();
  });
  el('more').addEventListener('click', () => {
    shown += PAGE;
    renderFiles();
  });
  el('deleteSelected').addEventListener('click', () => askDelete([...selected.values()]));
  el('confirm').addEventListener('close', () => {
    const files = pendingDelete;
    pendingDelete = [];
    if (el('confirm').returnValue === 'ok' && files.length) runDelete(files);
  });

  for (const button of document.querySelectorAll('#langSwitch button')) {
    button.addEventListener('click', () => window.setLang(button.dataset.lang));
  }
  window.onLangChange = () => {
    document.title = T('title');
    if (report) render();
  };
  document.title = T('title');
  load();
})();
