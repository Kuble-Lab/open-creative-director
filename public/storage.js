'use strict';

// Storage overview page (public/storage.html, data: GET api/storage, delete: POST api/storage/delete).
// All values from the server are written as text, never as HTML.
(() => {
  const PAGE = 100;
  const SESSION_PAGE = 10;
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
  function visibleFiles(files, sessions, { type = '', owner = null, sort = 'size', search = '', place = '' } = {}) {
    const needle = String(search || '').trim().toLowerCase();
    const list = files.filter((file) => {
      if (type && file.type !== type) return false;
      if (place && (place === 'archive') !== (file.archived === true)) return false;
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

  // The chats and workflows that take room on the server or in the archive, the largest first.
  function sessionRows(list) {
    return list
      .filter((session) => session.files > 0 || session.archivedFiles > 0)
      .sort((a, b) => b.bytes + (b.archivedBytes || 0) - (a.bytes + (a.archivedBytes || 0)) || String(a.id).localeCompare(String(b.id)));
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { formatBytes, visibleFiles, keyOf, sessionRows };
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
  let shownSessions = SESSION_PAGE;
  let pendingDelete = [];
  let poll = null;
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

  const archiveOn = () => Boolean(report && report.archive && report.archive.canUse && report.archive.connected);
  // Fetching back is open to everybody who may use the chat or workflow.
  const restoreOn = () => Boolean(report && report.archive && report.archive.connected);

  function renderArchive() {
    const box = el('archive');
    box.replaceChildren();
    const info = report.archive || {};
    box.hidden = !(info.available && info.canUse);
    el('placeField').hidden = !(info.available && (info.connected || report.totals.archivedFiles > 0));
    el('archiveSelected').hidden = !archiveOn();
    if (box.hidden) return;
    box.append(node('h2', T('archiveTitle')));
    if (!info.connected) {
      box.append(node('p', T('archiveOff'), 'mon-muted'));
      const connect = node('button', T('connect'));
      connect.type = 'button';
      connect.addEventListener('click', openConnect);
      box.append(connect);
      return;
    }
    const line = node('p', '', 'mon-muted st-legend');
    line.append(node('span', T('archiveAccount', { account: info.account || 'Dropbox' }), 'st-free'));
    line.append(node('span', T('archiveUsed', { size: bytes(report.totals.archivedBytes), count: number(report.totals.archivedFiles) })));
    if (info.space) line.append(node('span', T('archiveFree', { free: bytes(info.space.free), total: bytes(info.space.total) })));
    box.append(line, node('p', T('archiveHint'), 'mon-muted'));
    const disconnect = node('button', T('disconnect'));
    disconnect.type = 'button';
    disconnect.addEventListener('click', async () => {
      await send('api/storage/archive/connect', 'DELETE');
      load();
    });
    box.append(disconnect);
    if (info.auto) box.append(autoForm(info.auto));
  }

  // The automatic archive: large old videos go by themselves (POST api/storage/archive/auto).
  function autoForm(auto) {
    const form = node('form', '', 'st-auto');
    form.append(node('h3', T('autoTitle')));
    const enabled = node('input');
    enabled.type = 'checkbox';
    enabled.checked = auto.enabled === true;
    const toggle = node('label', '', 'st-auto-toggle');
    toggle.append(enabled, node('span', T('autoEnabled')));
    const field = (label, value) => {
      const input = node('input');
      input.type = 'number';
      input.min = '1';
      input.step = '1';
      input.required = true;
      input.value = String(value);
      const wrap = node('label', '', 'mon-field');
      wrap.append(node('span', label), input);
      return { wrap, input };
    };
    const size = field(T('autoMinMb'), auto.minMb);
    const age = field(T('autoMinDays'), auto.minDays);
    const save = node('button', T('autoSave'));
    save.type = 'submit';
    const row = node('div', '', 'st-auto-row');
    row.append(size.wrap, age.wrap, save);
    const last = auto.lastRunAt ? T('autoLast', { time: stamp(auto.lastRunAt), count: number(auto.lastQueued || 0) }) : T('autoNever');
    form.append(toggle, row, node('p', last, 'mon-muted'));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await send('api/storage/archive/auto', 'POST', { enabled: enabled.checked, minMb: Number(size.input.value), minDays: Number(age.input.value) });
        await load({ quiet: true });
        setStatus(T('autoSaved'));
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    return form;
  }

  // Whole chats and workflows: what they take on the server and in the archive, and the way there and back in one step.
  function renderSessions() {
    const box = el('sessions');
    box.replaceChildren();
    const info = report.archive || {};
    const rows = sessionRows(report.sessions);
    box.hidden = !(info.available && (info.connected || report.totals.archivedFiles > 0)) || !rows.length;
    if (box.hidden) return;
    box.append(node('h2', T('sessionsTitle')), node('p', T('sessionsHint'), 'mon-muted'));
    const showOwner = report.scope === 'all' && report.accounts;
    const wrap = node('div', '', 'mon-table-wrap');
    const table = node('table', '', 'st-table');
    const head = node('tr');
    head.append(node('th', T('where')), node('th', ''));
    if (showOwner) head.append(node('th', T('owner')));
    head.append(node('th', T('onServer'), 'number'), node('th', T('inArchiveHead'), 'number'), node('th', ''));
    table.append(head);
    const busy = new Set(report.files.filter((file) => file.job && file.job !== 'error').map((file) => file.sessionId));
    for (const session of rows.slice(0, shownSessions)) {
      const row = node('tr');
      row.append(node('td', sessionLabel(session), 'st-where'), node('td', T(`kind.${['chat', 'workflow', 'orphan'].includes(session.kind) ? session.kind : 'chat'}`), 'mon-muted'));
      if (showOwner) row.append(node('td', session.owner || T('noOwner')));
      row.append(
        node('td', `${bytes(session.bytes)} · ${fileCount(session.files)}`, 'number'),
        node('td', session.archivedFiles ? `${bytes(session.archivedBytes)} · ${fileCount(session.archivedFiles)}` : '', 'number')
      );
      const actions = node('td', '', 'st-actions');
      if (archiveOn() && session.archivable > 0) {
        const toArchive = node('button', T('wholeToArchive'));
        toArchive.type = 'button';
        toArchive.disabled = busy.has(session.id);
        toArchive.addEventListener('click', () => moveWhole('archive', session));
        actions.append(toArchive);
      }
      if (restoreOn() && session.archivedFiles > 0) {
        const restore = node('button', T('wholeRestore'));
        restore.type = 'button';
        restore.disabled = busy.has(session.id);
        restore.addEventListener('click', () => moveWhole('restore', session));
        actions.append(restore);
      }
      row.append(actions);
      table.append(row);
    }
    wrap.append(table);
    box.append(wrap);
    if (rows.length > shownSessions) {
      const more = node('button', T('sessionsMore'));
      more.type = 'button';
      more.addEventListener('click', () => {
        shownSessions += SESSION_PAGE * 3;
        renderSessions();
      });
      const holder = node('div', '', 'st-more');
      holder.append(more);
      box.append(holder);
    }
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
    return { type: el('type').value, owner, sort: el('sort').value, search: el('search').value, place: el('placeField').hidden ? '' : el('place').value };
  }

  function updateSelection() {
    const count = selected.size;
    let total = 0;
    for (const file of selected.values()) total += file.size;
    el('selection').textContent = count ? T('selected', { count: number(count), size: bytes(total) }) : '';
    el('deleteSelected').disabled = !count;
    el('archiveSelected').disabled = ![...selected.values()].some((file) => !file.archived && file.assetId);
  }

  function preview(file) {
    const box = node('div', '', 'st-thumb');
    if (file.type === 'image' && file.url) {
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
      const working = Boolean(file.job) && file.job !== 'error';
      const check = node('input');
      check.type = 'checkbox';
      check.checked = selected.has(keyOf(file));
      check.disabled = file.pending === true || working;
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
      if (file.archived) {
        name.append(node('span', file.name));
      } else {
        const link = node('a', file.name);
        link.href = file.url.replace(/^\//, '');
        link.target = '_blank';
        link.rel = 'noopener';
        name.append(link);
      }
      if (file.job) {
        const share = file.jobProgress ? ` ${file.jobProgress} %` : '';
        name.append(node('small', file.job === 'error' ? T('jobError', { reason: file.jobError || '' }) : `${T(`job.${file.job}`)}${share}`, file.job === 'error' ? 'st-warn st-state' : 'st-state'));
      } else if (file.archived) {
        name.append(node('small', T('inArchive'), 'st-state'));
      }
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
      if (file.archived) {
        if (restoreOn()) {
          const restore = node('button', T('restore'));
          restore.type = 'button';
          restore.disabled = working;
          restore.addEventListener('click', () => move('restore', [file]));
          actions.append(restore);
        }
      } else {
        const download = node('a', T('download'), 'st-button');
        download.href = file.url.replace(/^\//, '');
        download.setAttribute('download', file.name);
        actions.append(download);
        if (archiveOn() && file.assetId && !file.pending) {
          const toArchive = node('button', T('toArchive'));
          toArchive.type = 'button';
          toArchive.disabled = working;
          toArchive.addEventListener('click', () => move('archive', [file]));
          actions.append(toArchive);
        }
      }
      const remove = node('button', T('delete'), 'st-danger');
      remove.type = 'button';
      remove.disabled = file.pending === true || working || (file.archived && !archiveOn());
      remove.addEventListener('click', () => askDelete([file]));
      actions.append(remove);
      row.append(actions);
      table.append(row);
    }
    wrap.append(table);
    box.append(wrap);
    el('more').hidden = list.length <= shown;
  }

  function render() {
    renderDisk();
    renderArchive();
    renderMetrics();
    renderOwners();
    renderSessions();
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

  async function send(url, method, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || T('loadError'));
    return data;
  }

  // Starts the way into the archive ('archive') or back ('restore'); the work runs on the server, the list shows the state.
  async function move(kind, files) {
    try {
      const body = await send(`api/storage/${kind}`, 'POST', { files: files.map((file) => ({ sessionId: file.sessionId, file: file.file })) });
      for (const item of body.queued) selected.delete(`${item.sessionId}/${item.file}`);
      await load({ quiet: true });
      const started = T(kind === 'archive' ? 'archiveStarted' : 'restoreStarted', { count: number(body.queued.length) });
      if (body.failed.length) setStatus(`${started} ${T('failed', { count: number(body.failed.length), reason: body.failed[0].error })}`, true);
      else setStatus(started);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function moveWhole(kind, session) {
    try {
      const body = await send(`api/storage/${kind}`, 'POST', { sessions: [session.id] });
      await load({ quiet: true });
      const started = T(kind === 'archive' ? 'archiveStarted' : 'restoreStarted', { count: number(body.queued.length) });
      if (body.failed.length) setStatus(`${started} ${T('failed', { count: number(body.failed.length), reason: body.failed[0].error })}`, true);
      else setStatus(started);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function openConnect() {
    el('appKey').value = '';
    el('connectCode').value = '';
    el('connectStatus').textContent = '';
    el('connect').showModal();
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
      // While the archive works the list is read again every few seconds.
      clearTimeout(poll);
      if (body.files.some((file) => file.job && file.job !== 'error')) poll = setTimeout(() => load({ quiet: true }), 3000);
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
  el('archiveSelected').addEventListener('click', () => move('archive', [...selected.values()].filter((file) => !file.archived && file.assetId)));
  el('connectOpen').addEventListener('click', async () => {
    try {
      const { url } = await send('api/storage/archive/connect', 'POST', { appKey: el('appKey').value });
      el('connectStatus').textContent = '';
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      el('connectStatus').textContent = err.message;
    }
  });
  el('connectFinish').addEventListener('click', async () => {
    try {
      await send('api/storage/archive/connect/finish', 'POST', { code: el('connectCode').value });
      el('connect').close('done');
      load();
    } catch (err) {
      el('connectStatus').textContent = err.message;
    }
  });
  for (const id of ['type', 'owner', 'sort', 'place']) {
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
