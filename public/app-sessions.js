'use strict';

// Chat sessions, projects and team groups, moved from app.js. Loaded in index.html order.

/* ---------- sessions ---------- */

function sessionIdFromHash() {
  const value = new URLSearchParams(location.hash.replace(/^#/, '')).get('s');
  return value ? value.trim() : '';
}

function setSessionHash(id) {
  const hash = id ? `#s=${encodeURIComponent(id)}` : '';
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function saveCollapsedFolders() {
  try {
    localStorage.setItem(FOLDERS_COLLAPSED_KEY, JSON.stringify([...state.collapsedFolders]));
  } catch (_) {
    /* Die Sidebar funktioniert auch ohne localStorage. */
  }
}

function sessionFolder(meta) {
  return typeof meta.folder === 'string' && meta.folder.trim() ? meta.folder.trim() : null;
}

// Projects are ordered like chats: whatever was worked on last comes first. A project without chats has no date and
// waits at the end, alphabetically, until its first chat lifts it up. (Exposed for the test of the ordering.)
function folderActivity(name) {
  const fromFolder = String(folderInfo(name)?.lastActivity || '');
  const fromLoaded = state.sessions
    .filter((session) => sessionFolder(session) === name)
    .reduce((latest, session) => {
      const changed = String(session.updatedAt || session.createdAt || '');
      return changed > latest ? changed : latest;
    }, '');
  return fromLoaded > fromFolder ? fromLoaded : fromFolder;
}

function existingFolders() {
  const names = [...new Set([...state.folders.map((folder) => folder.name), ...state.sessions.map(sessionFolder).filter(Boolean)])];
  return names.sort((a, b) => {
    const left = folderActivity(a);
    const right = folderActivity(b);
    if (left && right && left !== right) return right.localeCompare(left);
    if (left !== right) return left ? -1 : 1;
    return a.localeCompare(b, 'de-CH', { sensitivity: 'base' });
  });
}

function folderInfo(name) {
  return state.folders.find((folder) => folder.name === name) || null;
}

function closeSessionMenus(except = null) {
  for (const actions of el.sessionList.querySelectorAll('.session-actions.open')) {
    if (actions === except) continue;
    actions.classList.remove('open');
    actions.querySelectorAll('.session-folder-popover').forEach((popover) => popover.remove());
    actions.querySelector('.session-menu')?.classList.remove('hidden');
  }
}

async function patchSessionMeta(meta, changes) {
  const data = await api(`/api/sessions/${meta.id}`, {
    method: 'PATCH',
    body: JSON.stringify(changes)
  });
  Object.assign(meta, data.session);
  updateSessionCopies(meta.id, data.session);
  if (state.currentId === meta.id && state.detail?.session) {
    Object.assign(state.detail.session, data.session);
    renderSessionHeader();
    if (Object.prototype.hasOwnProperty.call(changes, 'folder')) {
      await loadCurrentFolderProfile().catch((err) => setStatus(err.message));
    }
  }
  await loadFolders();
  renderSessions();
}

function startSessionRename(meta, item, title) {
  closeSessionMenus();
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.type = 'text';
  input.maxLength = 120;
  input.value = meta.title || t('sessions.new');
  input.setAttribute('aria-label', t('sessions.rename'));
  title.replaceWith(input);

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const nextTitle = input.value.trim();
    if (!save || nextTitle === (meta.title || t('sessions.new'))) {
      renderSessions();
      return;
    }
    if (!nextTitle) {
      setStatusI18n('sessions.titleEmpty');
      renderSessions();
      return;
    }
    try {
      await patchSessionMeta(meta, { title: nextTitle });
    } catch (err) {
      setStatusI18n('sessions.renameFailed', { error: err.message });
      renderSessions();
    }
  };

  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  item.classList.add('editing');
  input.focus();
  input.select();
}

function addFolderOption(popover, label, onSelect, { selected = false, danger = false } = {}) {
  const option = document.createElement('button');
  option.type = 'button';
  option.className = `session-menu-action${danger ? ' danger' : ''}`;
  option.textContent = selected ? `✓ ${label}` : label;
  option.disabled = selected;
  option.addEventListener('click', (event) => {
    event.stopPropagation();
    onSelect();
  });
  popover.appendChild(option);
}

function openFolderPopover(meta, actions, menu) {
  menu.classList.add('hidden');
  const popover = document.createElement('div');
  popover.className = 'session-menu session-folder-popover';
  popover.setAttribute('role', 'menu');

  const heading = document.createElement('div');
  heading.className = 'session-menu-heading';
  heading.textContent = t('sessions.moveToProject');
  popover.appendChild(heading);

  const currentFolder = sessionFolder(meta);
  for (const folder of existingFolders()) {
    addFolderOption(
      popover,
      folder,
      () => patchSessionMeta(meta, { folder }).catch((err) => setStatusI18n('sessions.projectChangeFailed', { error: err.message })),
      { selected: folder === currentFolder }
    );
  }

  const newFolder = document.createElement('button');
  newFolder.type = 'button';
  newFolder.className = 'session-menu-action';
  newFolder.textContent = t('sessions.newProject');
  newFolder.addEventListener('click', (event) => {
    event.stopPropagation();
    newFolder.remove();
    const input = document.createElement('input');
    input.className = 'session-folder-input';
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = t('sidebar.projectName');
    input.setAttribute('aria-label', t('sidebar.newProjectTitle'));
    popover.appendChild(input);
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      const folder = input.value.trim();
      if (!folder) {
        renderSessions();
        return;
      }
      try {
        await patchSessionMeta(meta, { folder });
      } catch (err) {
        setStatusI18n('sessions.projectCreateFailed', { error: err.message });
        renderSessions();
      }
    };
    input.addEventListener('click', (inputEvent) => inputEvent.stopPropagation());
    input.addEventListener('keydown', (inputEvent) => {
      inputEvent.stopPropagation();
      if (inputEvent.key === 'Enter') {
        inputEvent.preventDefault();
        input.blur();
      } else if (inputEvent.key === 'Escape') {
        inputEvent.preventDefault();
        finished = true;
        renderSessions();
      }
    });
    input.addEventListener('blur', finish);
    input.focus();
  });
  popover.appendChild(newFolder);

  if (currentFolder) {
    addFolderOption(
      popover,
      t('sessions.removeFromProject'),
      () => patchSessionMeta(meta, { folder: null }).catch((err) => setStatusI18n('sessions.projectRemoveFailed', { error: err.message })),
      { danger: true }
    );
  }

  actions.appendChild(popover);
}

// teamGroup: the item sits in a group of the team view; it then always names its owner (own chats included).
function createSessionItem(meta, { teamGroup = false } = {}) {
  const item = document.createElement('div');
  item.className = `session-item${meta.id === state.currentId ? ' active' : ''}`;

  const body = document.createElement('div');
  body.className = 'session-item-body';
  const title = document.createElement('div');
  title.className = 'session-item-title';
  title.textContent = meta.title || t('sessions.new');
  body.appendChild(title);
  if (meta.snippet) {
    const snippet = document.createElement('div');
    snippet.className = 'session-item-snippet';
    snippet.textContent = meta.snippet;
    body.appendChild(snippet);
  }
  const date = document.createElement('div');
  date.className = 'session-item-date';
  date.textContent = formatDate(meta.updatedAt);
  // User management: somebody else's chat shows the owner (full address in the tooltip), a shared chat its badge.
  const foreignOwner = teamGroup ? teamGroupOwner(meta) : OCAccess.ownerName(meta);
  if (foreignOwner) {
    const owner = document.createElement('span');
    owner.className = 'session-item-owner';
    owner.textContent = foreignOwner.text;
    owner.title = foreignOwner.title;
    date.appendChild(owner);
  }
  // A hit of the search in the team view names its team.
  if (!teamGroup && OCTeamGroups.available() && Object.prototype.hasOwnProperty.call(meta, 'team')) {
    const teamName = OCTeamGroups.label(meta.team ? { name: meta.team.name, id: meta.team.id } : { internal: true });
    const team = document.createElement('span');
    team.className = 'session-team-flag';
    team.textContent = teamName;
    team.title = t('teamGroups.teamTitle', { name: teamName });
    date.appendChild(team);
  }
  const sharedBadge = OCAccess.badge(meta);
  if (sharedBadge) {
    const flag = document.createElement('span');
    flag.className = 'session-shared-flag';
    flag.textContent = sharedBadge.label;
    flag.title = sharedBadge.title;
    date.appendChild(flag);
  }
  body.appendChild(date);
  item.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'session-actions';
  actions.addEventListener('click', (event) => event.stopPropagation());

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'session-actions-trigger';
  menuButton.textContent = '⋯';
  menuButton.title = t('sessions.actions');
  menuButton.setAttribute('aria-label', t('sessions.actions'));

  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.setAttribute('role', 'menu');

  const canManage = meta.canManage !== false;
  const canShare = OCAccess.isActive() && meta.canShare === true;
  if (canManage) {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'session-menu-action';
    rename.textContent = t('sessions.renameAction');
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      startSessionRename(meta, item, title);
    });
    menu.appendChild(rename);

    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'session-menu-action';
    move.textContent = t('sessions.moveAction');
    move.addEventListener('click', (event) => {
      event.stopPropagation();
      openFolderPopover(meta, actions, menu);
    });
    menu.appendChild(move);
  }
  if (canShare) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'session-menu-action';
    share.textContent = t('sharing.buttonTitle');
    share.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSessionMenus();
      openShareForSession(meta);
    });
    menu.appendChild(share);
  }

  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (actions.classList.contains('open')) {
      closeSessionMenus();
      return;
    }
    closeSessionMenus();
    actions.classList.add('open');
  });
  actions.appendChild(menuButton);
  actions.appendChild(menu);
  if (menu.children.length) item.appendChild(actions);

  if (canManage) {
    const del = document.createElement('button');
    del.className = 'session-del';
    del.textContent = '×';
    del.title = t('sessions.delete');
    del.setAttribute('aria-label', t('sessions.delete'));
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (state.streaming) return;
      if (!window.confirm(t('sessions.deleteConfirm'))) return;
      await api(`/api/sessions/${meta.id}`, { method: 'DELETE' });
      await loadSessions();
      if (state.currentId === meta.id) {
        state.currentId = null;
        state.detail = null;
        setSessionHash(null);
        if (state.sessions.length) await openSession(state.sessions[0].id);
        else await createSession();
      }
    });
    item.appendChild(del);
  }

  const open = () => {
    if (state.streaming) return;
    closeMobileSidebar();
    if (meta.id === state.currentId) return;
    openSession(meta.id);
  };
  item.addEventListener('click', open);
  // Without this a chat could only be opened with the mouse while its delete button was reachable by keyboard.
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('keydown', (event) => {
    if (event.target !== item) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
  return item;
}

function appendFolderGroup(folder, sessions) {
  const group = document.createElement('section');
  group.className = 'session-folder';
  const collapsed = state.collapsedFolders.has(folder);

  const header = document.createElement('div');
  header.className = 'session-folder-header';
  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.setAttribute('aria-expanded', String(!collapsed));
  header.dataset.focusKey = `folder:${folder}`;
  header.innerHTML = `<span class="session-folder-chevron" aria-hidden="true">${collapsed ? '›' : '⌄'}</span>`;
  const name = document.createElement('span');
  name.className = 'session-folder-name';
  name.textContent = folder;
  header.appendChild(name);
  const count = document.createElement('span');
  count.className = 'session-folder-count';
  count.textContent = String(folderInfo(folder)?.sessionCount ?? sessions.length);
  header.appendChild(count);

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'session-folder-action';
  add.textContent = '+';
  add.title = t('sessions.newInProject', { name: folder });
  add.setAttribute('aria-label', t('sessions.newInProject', { name: folder }));
  add.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.streaming) createSession(folder).catch((err) => setStatus(err.message));
  });
  header.appendChild(add);

  const profile = document.createElement('button');
  profile.type = 'button';
  profile.className = `session-folder-action${state.folderProfiles.get(folder) ? ' has-profile' : ''}`;
  profile.textContent = '⚙';
  profile.title = t('sessions.editProfile');
  profile.setAttribute('aria-label', t('sessions.editProfileFor', { name: folder }));
  profile.addEventListener('click', (event) => {
    event.stopPropagation();
    closeMobileSidebar();
    openFolderProfileModal(folder).catch((err) => setStatus(err.message));
  });
  header.appendChild(profile);

  // The list pages through the 20 most recent chats while the badge counts all of them: an open project fetches the
  // chats the pages have not reached yet, so "1 Chat" never sits above an empty list.
  const chatCount = folderInfo(folder)?.sessionCount ?? sessions.length;
  if (!collapsed && !state.sessionQuery && sessions.length < chatCount) {
    loadFolderSessions(folder).catch((err) => setStatus(err.message));
  }

  const toggleFolder = () => {
    if (collapsed) state.collapsedFolders.delete(folder);
    else state.collapsedFolders.add(folder);
    saveCollapsedFolders();
    renderSessions();
  };
  header.addEventListener('click', toggleFolder);
  header.addEventListener('keydown', (event) => {
    if (event.target !== header) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleFolder();
  });
  group.appendChild(header);

  if (!collapsed) {
    const items = document.createElement('div');
    items.className = 'session-folder-items';
    for (const meta of sessions) items.appendChild(createSessionItem(meta));
    group.appendChild(items);
  }
  el.sessionList.appendChild(group);
}

// The list is built anew after every change; the keyboard focus (a group head, "load more") is put back afterwards.
function renderSessions() {
  syncSidebarTitle();
  OCTeamGroups.preserveFocus(el.sessionList, buildSessionList);
}

function buildSessionList() {
  el.sessionList.innerHTML = '';

  if (state.sessions.length === 0 && state.sessionQuery) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = t('sessions.noneFound');
    el.sessionList.appendChild(empty);
    return;
  }

  if (state.sessionQuery) {
    for (const meta of state.sessions) el.sessionList.appendChild(createSessionItem(meta));
  } else if (teamsViewActive()) {
    renderTeamGroups();
    return;
  } else {
    for (const folder of existingFolders()) {
      appendFolderGroup(folder, state.sessions.filter((meta) => sessionFolder(meta) === folder));
    }
    for (const meta of state.sessions.filter((session) => !sessionFolder(session))) {
      el.sessionList.appendChild(createSessionItem(meta));
    }
  }

  if (state.sessionHasMore) {
    const more = document.createElement('button');
    more.className = 'session-more';
    more.dataset.focusKey = 'more';
    more.textContent = t('sessions.loadMore');
    // aria-disabled instead of disabled: a disabled button would drop the keyboard focus while the page loads.
    more.addEventListener('click', async () => {
      if (more.getAttribute('aria-disabled') === 'true') return;
      more.setAttribute('aria-disabled', 'true');
      try {
        await loadMoreSessions();
      } catch (err) {
        setStatus(err.message);
        more.removeAttribute('aria-disabled');
      }
    });
    el.sessionList.appendChild(more);
  }
}

function clearSessionSearch() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  state.sessionQuery = '';
  el.sessionSearch.value = '';
}

function sessionsPath(offset) {
  const parts = [`limit=${SESSION_PAGE_SIZE}`, `offset=${encodeURIComponent(offset)}`];
  if (state.sessionQuery) parts.push(`q=${encodeURIComponent(state.sessionQuery)}`);
  if (state.sessionQuery && teamsViewActive()) parts.push('teams=1'); // every hit names its team
  return `/api/sessions?${parts.join('&')}`;
}

async function loadSessions() {
  const teams = teamsViewActive() && !state.sessionQuery;
  const [data] = await Promise.all([api(sessionsPath(0)), loadFolders(), teams ? loadTeamGroups() : null]);
  state.folderSessionsRequested.clear();
  state.sessions = data.sessions || [];
  state.sessionTotal = data.total || 0;
  state.sessionLoadedCount = state.sessions.length;
  state.sessionHasMore = Boolean(data.hasMore);
  renderSessions();
}

async function loadFolderSessions(folder) {
  if (state.folderSessionsRequested.has(folder)) return;
  state.folderSessionsRequested.add(folder);
  const data = await api(`/api/sessions?limit=100&offset=0&folder=${encodeURIComponent(folder)}`);
  const knownIds = new Set(state.sessions.map((session) => session.id));
  const missing = (data.sessions || []).filter((session) => !knownIds.has(session.id));
  if (!missing.length) return;
  state.sessions = state.sessions.concat(missing).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  renderSessions();
}

async function loadMoreSessions() {
  const data = await api(sessionsPath(state.sessionLoadedCount));
  const knownIds = new Set(state.sessions.map((session) => session.id));
  state.sessions = state.sessions.concat((data.sessions || []).filter((session) => !knownIds.has(session.id)));
  state.sessionTotal = data.total || 0;
  state.sessionLoadedCount += (data.sessions || []).length;
  state.sessionHasMore = Boolean(data.hasMore);
  renderSessions();
}

/* ---------- team view (admins) ---------- */

// The list can be grouped by team instead of by project. Only admins of the user management have it
// (public/team-groups.js); everybody else, and the local mode, keep the project view without any change.
function teamsViewActive() {
  return OCTeamGroups.mode('chats') === 'teams';
}

// The chats of the groups, page by page. An answer to a request that started before the heads were read again is
// dropped and read anew (OCTeamGroups.createGroupPages), so a group never keeps a deleted chat or an old order.
function teamPages() {
  if (!state.teamView.pages) {
    state.teamView.pages = OCTeamGroups.createGroupPages({
      pageSize: SESSION_PAGE_SIZE,
      fetchPage: (id, { offset, limit }) => api(`/api/sessions?team=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}`),
      onChange: scheduleTeamRender
    });
  }
  return state.teamView.pages;
}

// Many groups answer at once; one rebuild of the list serves them all.
const scheduleTeamRender = OCTeamGroups.coalesce(() => {
  if (teamsViewActive()) renderSessions();
}, 40);

// The title above the list: "Projects", or a neutral "Chats" while the list is grouped by team.
function syncSidebarTitle() {
  const title = document.querySelector('.sidebar-head .brand-text');
  if (!title) return;
  const key = OCTeamGroups.sidebarTitleKey('chats');
  if (title.dataset.i18n === key) return;
  title.dataset.i18n = key;
  title.textContent = t(key);
}

// The heads (name, number of chats, people) of all groups, complete however the chats page. The chats of every open
// group are read again by the next render (loaded = false); what is shown stays until they arrive.
async function loadTeamGroups() {
  const view = state.teamView;
  view.loading = true;
  view.error = null;
  try {
    const data = await api('/api/sessions/team-groups');
    view.groups = Array.isArray(data.groups) ? data.groups : [];
    teamPages().invalidate(view.groups.map((group) => group.id));
  } catch (err) {
    view.error = err.message;
  } finally {
    view.loading = false;
  }
}

function loadTeamGroupChats(group, options) {
  return teamPages().load(group.id, options);
}

// The owner of a chat in a group, own chats included; entries from before the user management have none.
function teamGroupOwner(meta) {
  const owner = OCTeamGroups.ownerLabel(meta.owner);
  return owner || { text: t('teamGroups.noOwner'), title: t('teamGroups.noOwner') };
}

// Every copy of a chat the lists hold (the plain list and the groups), so that a rename shows everywhere.
function updateSessionCopies(id, fields) {
  const copies = [...state.sessions];
  for (const entry of teamPages().all()) copies.push(...entry.sessions);
  for (const meta of copies) if (meta.id === id) Object.assign(meta, fields);
}

function appendTeamGroup(group) {
  const open = OCTeamGroups.isOpen('chats', group);
  const section = document.createElement('section');
  section.className = `session-folder team-group${group.archived ? ' is-archived' : ''}`;

  const header = document.createElement('div');
  header.className = 'session-folder-header team-group-header';
  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.setAttribute('aria-expanded', String(open));
  header.dataset.teamId = group.id;
  header.dataset.focusKey = `team:${group.id}`;
  const chevron = document.createElement('span');
  chevron.className = 'session-folder-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = open ? '⌄' : '›';
  const text = document.createElement('span');
  text.className = 'team-group-text';
  const nameLine = document.createElement('span');
  nameLine.className = 'team-group-nameline';
  const name = document.createElement('span');
  name.className = 'session-folder-name';
  name.textContent = OCTeamGroups.label(group);
  name.title = OCTeamGroups.label(group);
  nameLine.appendChild(name);
  if (group.archived) {
    const flag = document.createElement('span');
    flag.className = 'team-group-flag';
    flag.textContent = t('teamGroups.archived');
    nameLine.appendChild(flag);
  }
  const meta = document.createElement('span');
  meta.className = 'team-group-meta';
  meta.textContent = OCTeamGroups.counts(group, 'chats');
  text.append(nameLine, meta);
  header.append(chevron, text);
  const toggle = () => {
    OCTeamGroups.setOpen('chats', group.id, !open);
    renderSessions();
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (event) => {
    if (event.target !== header) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  });
  section.appendChild(header);

  if (open) {
    const entry = teamPages().entry(group.id);
    // Starts the read before the rows are built, so the group shows "loading" instead of "empty". The answer renders again.
    if (!entry.loaded && !entry.loading) loadTeamGroupChats(group).catch((err) => setStatus(err.message));
    const items = document.createElement('div');
    items.className = 'session-folder-items';
    for (const session of entry.sessions) items.appendChild(createSessionItem(session, { teamGroup: true }));
    if (entry.error) {
      const failed = document.createElement('div');
      failed.className = 'session-empty';
      failed.textContent = t('teamGroups.loadFailed', { error: entry.error });
      items.appendChild(failed);
    } else if (entry.loading && !entry.sessions.length) {
      const loading = document.createElement('div');
      loading.className = 'session-empty';
      loading.textContent = t('teamGroups.loading');
      items.appendChild(loading);
    }
    if (entry.loaded && entry.sessions.length < entry.total) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'session-more';
      more.dataset.focusKey = `more:${group.id}`;
      more.dataset.focusFallback = `team:${group.id}`; // the last page was loaded: the button is gone, the head takes the focus
      more.textContent = t('teamGroups.loadMore');
      if (entry.loading) more.setAttribute('aria-disabled', 'true');
      more.addEventListener('click', () => {
        if (more.getAttribute('aria-disabled') === 'true') return;
        more.setAttribute('aria-disabled', 'true');
        loadTeamGroupChats(group, { more: true }).catch((err) => setStatus(err.message));
      });
      items.appendChild(more);
    }
    section.appendChild(items);
  }
  el.sessionList.appendChild(section);
}

function renderTeamGroups() {
  const view = state.teamView;
  const note = (text, { retry = false } = {}) => {
    const box = document.createElement('div');
    box.className = 'session-empty';
    box.textContent = text;
    if (retry) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'session-more';
      again.textContent = t('nodes.common.retry');
      again.addEventListener('click', () => loadTeamGroups().then(renderSessions));
      box.appendChild(again);
    }
    el.sessionList.appendChild(box);
  };
  if (view.error) return note(t('teamGroups.loadFailed', { error: view.error }), { retry: true });
  if (!view.groups) return note(t('teamGroups.loading'));
  if (!view.groups.length) return note(t('teamGroups.empty'));
  for (const group of view.groups) appendTeamGroup(group);
}

// The switch "Projects | Teams" above the list; hidden unless the person is an admin of the user management.
function mountSessionGrouping() {
  if (state.sessionSwitch || !OCTeamGroups.available()) return;
  state.sessionSwitch = OCTeamGroups.switcher({
    view: 'chats',
    onChange: () => {
      closeSessionMenus();
      loadSessions().catch((err) => setStatus(err.message));
    }
  });
  el.sessionGrouping.replaceChildren(state.sessionSwitch.element);
  el.sessionGrouping.classList.remove('hidden');
}

async function createSession(folder = null) {
  closeMobileSidebar();
  const role = state.pendingRoleId;
  const body = {};
  if (folder) body.folder = folder;
  if (role) body.role = role;
  const data = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  state.pendingRoleId = null;
  // Eine leere Session passt zu keiner Suche - sonst waere sie offen, aber unsichtbar.
  clearSessionSearch();
  await loadSessions();
  await openSession(data.session.id);
}

async function loadFolders() {
  const data = await api('/api/folders');
  state.folders = Array.isArray(data.folders) ? data.folders : [];
  state.folderProfiles = new Map(
    state.folders.map((folder) => [
      folder.name,
      folder.hasProfile ? state.folderProfiles.get(folder.name) || true : null
    ])
  );
}

function closeNewFolderInput() {
  el.newFolderInput.value = '';
  el.newFolderInput.disabled = false;
  el.newFolderInput.classList.add('hidden');
  for (const button of el.sidebarCreate.querySelectorAll('.sidebar-create-button')) {
    button.classList.remove('hidden');
  }
}

function openNewFolderInput() {
  for (const button of el.sidebarCreate.querySelectorAll('.sidebar-create-button')) {
    button.classList.add('hidden');
  }
  el.newFolderInput.classList.remove('hidden');
  el.newFolderInput.focus();
}

async function createFolderFromSidebar() {
  const name = el.newFolderInput.value.trim();
  if (!name || el.newFolderInput.disabled) return;
  el.newFolderInput.disabled = true;
  try {
    await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    clearSessionSearch();
    closeNewFolderInput();
    await loadFolders();
    renderSessions();
    setStatusI18n('sessions.projectCreated', { name });
  } catch (err) {
    el.newFolderInput.disabled = false;
    setStatus(err.message);
    el.newFolderInput.focus();
    el.newFolderInput.select();
  }
}

async function openSession(id) {
  const detail = await api(`/api/sessions/${id}`);
  state.currentId = id;
  state.detail = detail;
  state.contextFiles = Array.isArray(detail.session.contextFiles) ? detail.session.contextFiles : [];
  state.currentFolderProfile = null;
  if (!state.sessions.some((session) => session.id === id)) {
    state.sessions.unshift(sessionMetaFromDetail(detail.session));
  }
  setSessionHash(id);
  renderSessionHeader();
  renderSessions();
  renderDetail();
  renderToolsMenu();
  scheduleJobPolling();
  scheduleWorkflowRunPolling();
  state.liveRenderNodeJob = false;
  scheduleRenderNodePolling(0);
  await Promise.all([
    loadContext().catch((err) => setStatus(err.message)),
    loadCurrentFolderProfile().catch((err) => setStatus(err.message))
  ]);
}

async function refreshDetail() {
  if (!state.currentId) return;
  state.detail = await api(`/api/sessions/${state.currentId}`);
  state.contextFiles = Array.isArray(state.detail.session.contextFiles) ? state.detail.session.contextFiles : [];
  renderSessionHeader();
  renderDetail();
  renderContextBadge();
  renderToolsMenu();
  await loadCurrentFolderProfile().catch((err) => setStatus(err.message));
  scheduleJobPolling();
  scheduleWorkflowRunPolling();
  state.liveRenderNodeJob = false;
  scheduleRenderNodePolling(0);
}

