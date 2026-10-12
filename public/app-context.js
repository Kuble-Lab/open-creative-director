'use strict';

// Roles, context and production profiles, moved from app.js. Loaded in index.html order.

/* ---------- Rollen ---------- */

function showRoleError(message) {
  el.roleModalError.textContent = message || '';
  el.roleModalError.classList.toggle('hidden', !message);
}

function showDefaultRoleStatus(message, { error = false } = {}) {
  el.roleDefaultStatus.textContent = message || '';
  el.roleDefaultStatus.classList.toggle('hidden', !message);
  el.roleDefaultStatus.classList.toggle('error', Boolean(message && error));
}

function resetDefaultRoleOverwrite() {
  if (state.defaultRoleOverwriteTimer) clearTimeout(state.defaultRoleOverwriteTimer);
  state.defaultRoleOverwriteTimer = null;
  state.defaultRoleOverwritePending = false;
  el.roleDefaultTemplate.textContent = t('roles.defaultTemplate');
}

function renderRoleFormMode() {
  const role = state.roles.find((item) => item.id === state.editingRoleId) || null;
  const editing = Boolean(role);
  el.roleFormTitle.textContent = editing ? t('roles.editTitle', { name: role.name }) : t('roles.new');
  el.roleEditCancel.classList.toggle('hidden', !editing);
  el.roleSave.textContent = editing ? t('common.update') : t('common.save');
  el.roleSaveCopy.classList.toggle('hidden', !editing);
}

function resetRoleForm() {
  resetDefaultRoleOverwrite();
  state.editingRoleId = null;
  el.roleName.value = '';
  el.roleBrief.value = '';
  el.roleEmoji.value = '';
  el.roleDescription.value = '';
  el.rolePrompt.value = '';
  renderRoleFormMode();
  showRoleError('');
  showDefaultRoleStatus('');
}

function editRole(role) {
  resetDefaultRoleOverwrite();
  state.editingRoleId = role.id;
  state.pendingRoleDeleteId = null;
  el.roleName.value = role.name || '';
  el.roleBrief.value = role.brief || '';
  el.roleEmoji.value = role.emoji || '';
  el.roleDescription.value = role.description || '';
  el.rolePrompt.value = role.prompt || '';
  renderRoleFormMode();
  renderRoleList();
  showRoleError('');
  showDefaultRoleStatus('');
  el.roleName.focus();
}

function renderRoleList() {
  el.roleList.innerHTML = '';
  if (!state.roles.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('roles.none');
    el.roleList.appendChild(empty);
    return;
  }
  for (const role of state.roles) {
    const row = document.createElement('div');
    row.className = 'role-list-item';
    const copy = document.createElement('div');
    copy.className = 'role-list-copy';
    const name = document.createElement('div');
    name.className = 'role-list-name';
    name.textContent = `${role.emoji ? `${role.emoji} ` : ''}${role.name}`;
    copy.appendChild(name);
    if (role.description) {
      const description = document.createElement('div');
      description.className = 'role-list-description';
      description.textContent = role.description;
      copy.appendChild(description);
    }
    row.appendChild(copy);
    const actions = document.createElement('div');
    actions.className = 'role-list-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'branding-manager-action';
    edit.textContent = t('common.edit');
    edit.addEventListener('click', () => editRole(role));
    actions.appendChild(edit);
    const confirming = state.pendingRoleDeleteId === role.id;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'branding-manager-action danger';
    remove.textContent = confirming ? t('common.reallyDelete') : t('common.delete');
    remove.addEventListener('click', async () => {
      if (!confirming) {
        state.pendingRoleDeleteId = role.id;
        renderRoleList();
        return;
      }
      remove.disabled = true;
      try {
        await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: 'DELETE' });
        if (activeRoleId() === role.id && state.currentId) {
          const data = await api(`/api/sessions/${state.currentId}`, {
            method: 'PATCH',
            body: JSON.stringify({ role: null })
          });
          Object.assign(state.detail.session, data.session);
        }
        if (state.editingRoleId === role.id) resetRoleForm();
        state.pendingRoleDeleteId = null;
        await loadRoles();
        setStatusI18n('roles.deleted');
      } catch (err) {
        showRoleError(err.message);
        remove.disabled = false;
      }
    });
    actions.appendChild(remove);
    row.appendChild(actions);
    el.roleList.appendChild(row);
  }
}

async function loadRoles() {
  const data = await api('/api/roles');
  state.roles = Array.isArray(data.roles) ? data.roles : [];
  if (state.editingRoleId && !state.roles.some((role) => role.id === state.editingRoleId)) resetRoleForm();
  else renderRoleFormMode();
  renderToolsMenu();
  if (!el.roleModal.classList.contains('hidden')) renderRoleList();
}

async function openRoleModal() {
  state.pendingRoleDeleteId = null;
  el.roleModal.classList.remove('hidden');
  resetRoleForm();
  renderRoleList();
  try {
    await loadRoles();
  } catch (err) {
    showRoleError(err.message);
  }
  el.roleName.focus();
}

function closeRoleModal() {
  state.pendingRoleDeleteId = null;
  resetDefaultRoleOverwrite();
  el.roleModal.classList.add('hidden');
}

function setRoleFormBusy(busy) {
  el.roleGenerate.disabled = busy;
  el.roleDefaultTemplate.disabled = busy;
  el.roleSave.disabled = busy;
  el.roleSaveCopy.disabled = busy;
  el.roleEditCancel.disabled = busy;
}

async function loadDefaultRoleTemplate() {
  if (el.rolePrompt.value.length > 0 && !state.defaultRoleOverwritePending) {
    state.defaultRoleOverwritePending = true;
    el.roleDefaultTemplate.textContent = t('roles.reallyOverwrite');
    state.defaultRoleOverwriteTimer = setTimeout(resetDefaultRoleOverwrite, 3000);
    return;
  }

  resetDefaultRoleOverwrite();
  setRoleFormBusy(true);
  el.roleDefaultTemplate.textContent = t('common.loading');
  showRoleError('');
  showDefaultRoleStatus(t('roles.defaultLoading'));
  try {
    const template = await api('/api/roles/default');
    if (typeof template.prompt !== 'string' || !template.prompt.trim()) {
      throw new Error(t('roles.defaultEmpty'));
    }
    el.rolePrompt.value = template.prompt;
    showDefaultRoleStatus(t('roles.defaultLoaded'));
  } catch (err) {
    showDefaultRoleStatus(t('roles.defaultLoadFailed', { error: err.message }), { error: true });
  } finally {
    setRoleFormBusy(false);
    resetDefaultRoleOverwrite();
  }
}

async function generateRole() {
  const name = el.roleName.value.trim();
  const brief = el.roleBrief.value.trim();
  if (!name || !brief) {
    showRoleError(t('roles.generateRequired'));
    return;
  }
  setRoleFormBusy(true);
  el.roleGenerate.textContent = t('roles.generating');
  showRoleError('');
  try {
    const suggestion = await api('/api/roles/generate', {
      method: 'POST',
      body: JSON.stringify({ name, brief })
    });
    el.roleEmoji.value = suggestion.emoji || '';
    el.roleDescription.value = suggestion.description || '';
    el.rolePrompt.value = suggestion.prompt || '';
  } catch (err) {
    showRoleError(err.message);
  } finally {
    setRoleFormBusy(false);
    el.roleGenerate.textContent = t('roles.generate');
  }
}

async function saveRole({ asNew = false } = {}) {
  const payload = {
    name: el.roleName.value.trim(),
    brief: el.roleBrief.value.trim(),
    emoji: el.roleEmoji.value.trim(),
    description: el.roleDescription.value.trim(),
    prompt: el.rolePrompt.value.trim()
  };
  if (!payload.name || !payload.prompt) {
    showRoleError(t('roles.saveRequired'));
    return;
  }
  const editingRoleId = state.editingRoleId;
  const updating = Boolean(editingRoleId && !asNew);
  setRoleFormBusy(true);
  showRoleError('');
  try {
    const path = updating ? `/api/roles/${encodeURIComponent(editingRoleId)}` : '/api/roles';
    const data = await api(path, { method: updating ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    await loadRoles();
    if (!updating) await selectRole(data.role.id);
    resetRoleForm();
    setStatusI18n(updating ? 'roles.updated' : 'roles.savedActive');
  } catch (err) {
    showRoleError(err.message);
  } finally {
    setRoleFormBusy(false);
  }
}

/* ---------- GTS-Kontext ---------- */

function gtsEnabled() {
  return Boolean(state.config?.gts?.enabled) && !(OCAccess.me().active && OCAccess.me().restricted);
}

function renderContextBadge() {
  const contextCount = state.contextBrains.length + state.contextFiles.length;
  const brandingCount = effectiveBrandingIds().length;
  // One counter for everything in the context; the tooltip says what it is made of.
  const total = contextCount + brandingCount;
  el.contextBtn.classList.toggle('hidden', !state.currentId);
  el.contextBadge.classList.toggle('hidden', total === 0);
  el.contextBadge.textContent = String(total);
  const parts = [
    contextCount ? t(contextCount === 1 ? 'topbar.contextSourcesOne' : 'topbar.contextSourcesMany', { count: contextCount }) : '',
    brandingCount ? t(brandingCount === 1 ? 'topbar.contextBrandingsOne' : 'topbar.contextBrandingsMany', { count: brandingCount }) : ''
  ].filter(Boolean);
  el.contextBtn.title = total === 0 ? t('topbar.contextTitle') : `${t('topbar.context')}: ${parts.join(', ')}`;
  el.contextBtn.setAttribute('aria-label', el.contextBtn.title);
  OCShell.refresh();
}

function renderContextFileList({ files, container, uploadButton, hint, emptyText, normalHint, fullHint, canUpload, onRemove }) {
  container.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
  }
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'context-item';
    const body = document.createElement('div');
    body.className = 'context-item-body';
    const name = document.createElement('div');
    name.className = 'context-item-title';
    name.textContent = file.name || file.id;
    const meta = document.createElement('div');
    meta.className = 'context-item-meta';
    meta.textContent = t('context.fileChars', { n: Number(file.chars || 0).toLocaleString('de-CH') });
    body.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'context-action';
    remove.textContent = '×';
    remove.title = t('common.remove');
    remove.setAttribute('aria-label', `${file.name || t('files.generic')}: ${t('common.remove')}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await onRemove(file);
      } catch (err) {
        setStatus(err.message);
        remove.disabled = false;
      }
    });
    row.append(body, remove);
    container.appendChild(row);
  }
  const full = files.length >= 5;
  uploadButton.disabled = full || !canUpload;
  hint.textContent = full ? fullHint : normalHint;
}

function renderContextFiles() {
  renderContextFileList({
    files: state.contextFiles,
    container: el.contextFiles,
    uploadButton: el.contextFileUploadBtn,
    hint: el.contextFileHint,
    emptyText: t('context.noChatFile'),
    normalHint: t('context.chatFileHint'),
    fullHint: t('context.chatFilesFull'),
    canUpload: Boolean(state.currentId),
    onRemove: async (file) => {
      const data = await api(`/api/sessions/${state.currentId}/context-files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      state.contextFiles = data.contextFiles || [];
      if (state.detail?.session) state.detail.session.contextFiles = state.contextFiles.slice();
      renderContextFiles();
      renderContextBadge();
    }
  });
}

function applyProfileContextFiles(folder, contextFiles) {
  state.profileContextFiles = Array.isArray(contextFiles) ? contextFiles : [];
  const stored = state.folderProfiles.get(folder);
  const profile = stored && typeof stored === 'object' ? { ...stored, contextFiles: state.profileContextFiles.slice() } : {
    guidelines: '',
    contextBrains: [],
    brandings: [],
    cast: [],
    contextFiles: state.profileContextFiles.slice(),
    memory: state.profileMemory.slice()
  };
  const hasProfile = profileHasContent(profile);
  state.folderProfiles.set(folder, hasProfile ? profile : null);
  const info = folderInfo(folder);
  if (info) info.hasProfile = hasProfile;
  if (state.detail?.session?.folder === folder) state.currentFolderProfile = hasProfile ? profile : null;
}

function renderProfileContextFiles() {
  renderContextFileList({
    files: state.profileContextFiles,
    container: el.folderProfileFiles,
    uploadButton: el.folderProfileFileUploadBtn,
    hint: el.folderProfileFileHint,
    emptyText: t('context.noProjectFile'),
    normalHint: t('context.projectFileHint'),
    fullHint: t('context.projectFilesFull'),
    canUpload: Boolean(state.profileFolder),
    onRemove: async (file) => {
      const folder = state.profileFolder;
      if (!folder) return;
      const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile/context-files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      applyProfileContextFiles(folder, data.contextFiles || []);
      renderProfileContextFiles();
      renderSessions();
    }
  });
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('context.fileReadError', { name: file.name })));
    reader.readAsText(file);
  });
}

async function uploadContextFile(name, text, targetId = null) {
  if (!state.currentId && !targetId) await createSession();
  // The chat can change while a file is on its way: the file belongs to the chat it was picked in.
  const id = targetId || state.currentId;
  const data = await api(`/api/sessions/${id}/context-files`, {
    method: 'POST',
    body: JSON.stringify({ name, text })
  });
  if (state.currentId !== id) return data.file;
  state.contextFiles = data.contextFiles || [];
  if (state.detail?.session) state.detail.session.contextFiles = state.contextFiles.slice();
  renderContextFiles();
  renderContextBadge();
  return data.file;
}

async function uploadTextContextFileList(files, currentFiles, uploadOne, scopeKey) {
  const accepted = Array.from(files || []).filter((file) => /\.(md|txt|markdown)$/i.test(file.name));
  const available = Math.max(0, 5 - currentFiles.length);
  const selected = accepted.slice(0, available);
  for (const file of selected) {
    const text = await readTextFile(file);
    await uploadOne(file.name, text);
  }
  if (selected.length) {
    setStatusI18n('context.filesAttached', {
      n: selected.length,
      suffix: () => selected.length === 1 ? '' : getLang() === 'de' ? 'en' : getLang() === 'en' ? 's' : '',
      scope: () => t(scopeKey)
    });
  }
  if (accepted.length > available) setStatusI18n('context.filesMax', { scope: () => t(scopeKey) });
}

async function uploadContextFileList(files) {
  if (!state.currentId) await createSession();
  const id = state.currentId;
  await uploadTextContextFileList(files, state.contextFiles, (name, text) => uploadContextFile(name, text, id), 'context.scopeChat');
}

async function uploadFolderContextFile(name, text) {
  const folder = state.profileFolder;
  if (!folder) throw new Error(t('context.noProjectProfile'));
  const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile/context-files`, {
    method: 'POST',
    body: JSON.stringify({ name, text })
  });
  applyProfileContextFiles(folder, data.contextFiles || []);
  renderProfileContextFiles();
  renderSessions();
  return data.file;
}

async function uploadFolderContextFileList(files) {
  await uploadTextContextFileList(files, state.profileContextFiles, uploadFolderContextFile, 'context.scopeProject');
}

// Zeile fuer angehaengtes Brain bzw. Suchtreffer - immer per createElement/textContent.
function contextRow(brain, actionLabel, onAction, { disabled = false, onError = setStatus } = {}) {
  const row = document.createElement('div');
  row.className = 'context-item';

  const body = document.createElement('div');
  body.className = 'context-item-body';
  const title = document.createElement('div');
  title.className = 'context-item-title';
  title.textContent = brain.title || brain.id;
  body.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'context-item-meta';
  meta.textContent = brain.category ? `${brain.category} · ${brain.id}` : brain.id;
  body.appendChild(meta);
  row.appendChild(body);

  const action = document.createElement('button');
  action.className = 'context-action';
  action.textContent = actionLabel;
  action.title = actionLabel === '×' ? t('common.remove') : t('common.attach');
  action.disabled = disabled;
  action.addEventListener('click', async () => {
    if (action.disabled) return;
    action.disabled = true;
    try {
      await onAction();
    } catch (err) {
      onError(err.message);
      action.disabled = false;
    }
  });
  row.appendChild(action);
  return row;
}

function renderAttachedContext() {
  el.contextAttached.innerHTML = '';
  if (!state.contextBrains.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('context.noContext');
    el.contextAttached.appendChild(empty);
    return;
  }
  for (const brain of state.contextBrains) {
    el.contextAttached.appendChild(contextRow(brain, '×', () => detachBrain(brain.id)));
  }
}

function renderContextResults(matches, note) {
  el.contextResults.innerHTML = '';
  if (note) {
    const info = document.createElement('div');
    info.className = 'context-empty';
    info.textContent = note;
    el.contextResults.appendChild(info);
    return;
  }
  for (const match of matches) {
    const attached = state.contextBrains.some((b) => b.id === match.id);
    el.contextResults.appendChild(
      contextRow(match, attached ? t('common.attached') : t('common.attach'), async () => {
        if (attached) return;
        await attachBrain(match.id);
      })
    );
  }
}

async function loadContext() {
  state.contextFiles = Array.isArray(state.detail?.session?.contextFiles) ? state.detail.session.contextFiles : [];
  renderContextFiles();
  if (!state.currentId || !gtsEnabled()) {
    state.contextBrains = [];
    renderContextBadge();
    return;
  }
  const data = await api(`/api/sessions/${state.currentId}/context`);
  state.contextBrains = data.contextBrains || [];
  renderContextBadge();
  if (!el.contextModal.classList.contains('hidden')) renderAttachedContext();
}

async function attachBrain(brainId) {
  const data = await api(`/api/sessions/${state.currentId}/context`, {
    method: 'POST',
    body: JSON.stringify({ brainId })
  });
  state.contextBrains = data.contextBrains || [];
  renderContextBadge();
  renderAttachedContext();
  runContextSearch();
}

async function detachBrain(brainId) {
  const data = await api(`/api/sessions/${state.currentId}/context/${encodeURIComponent(brainId)}`, { method: 'DELETE' });
  state.contextBrains = data.contextBrains || [];
  renderContextBadge();
  renderAttachedContext();
  runContextSearch();
}

async function runContextSearch() {
  const query = el.contextSearch.value.trim();
  if (!query) {
    renderContextResults([], t('context.searchPrompt'));
    return;
  }
  try {
    const data = await api(`/api/gts/search?q=${encodeURIComponent(query)}`);
    const matches = data.matches || [];
    renderContextResults(matches, matches.length ? '' : t('context.noBrainsFound'));
  } catch (err) {
    renderContextResults([], err.message);
  }
}

function openContextModal() {
  el.contextModal.classList.remove('hidden');
  el.contextGtsSection.classList.toggle('hidden', !gtsEnabled());
  renderContextBrandings();
  renderContextFiles();
  renderAttachedContext();
  if (gtsEnabled()) {
    runContextSearch();
    el.contextSearch.focus();
  } else {
    el.contextBrandingSelect.focus();
  }
}

function closeContextModal() {
  el.contextModal.classList.add('hidden');
}

/* ---------- Produktions-Profile ---------- */

function profileBrainIds() {
  return state.profileBrains.map((brain) => brain.id);
}

function normaliseProfileBrains(values) {
  const brains = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = typeof value === 'string' ? value.trim() : typeof value?.id === 'string' ? value.id.trim() : '';
    if (!id || brains.some((brain) => brain.id === id)) continue;
    const title = typeof value?.title === 'string' && value.title.trim() ? value.title.trim() : id;
    const brain = { id, title };
    if (typeof value?.category === 'string' && value.category.trim()) brain.category = value.category.trim();
    brains.push(brain);
    if (brains.length === 5) break;
  }
  return brains;
}

function renderProfileAttachedBrains() {
  el.folderProfileAttachedBrains.innerHTML = '';
  if (!state.profileBrains.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('context.noBrain');
    el.folderProfileAttachedBrains.appendChild(empty);
  } else {
    for (const brain of state.profileBrains) {
      el.folderProfileAttachedBrains.appendChild(
        contextRow(
          brain,
          '×',
          () => {
            state.profileBrains = state.profileBrains.filter((entry) => entry.id !== brain.id);
            renderProfileAttachedBrains();
            renderProfileBrainResults(state.profileBrainResults);
          },
          { onError: showProfileError }
        )
      );
    }
  }
  el.folderProfileBrainLimit.classList.toggle('hidden', state.profileBrains.length < 5);
}

function renderProfileBrainResults(matches = [], note = '') {
  state.profileBrainResults = Array.isArray(matches) ? matches : [];
  el.folderProfileBrainResults.innerHTML = '';
  if (note) {
    const info = document.createElement('div');
    info.className = 'context-empty';
    info.textContent = note;
    el.folderProfileBrainResults.appendChild(info);
    return;
  }
  for (const match of state.profileBrainResults) {
    const attached = state.profileBrains.some((brain) => brain.id === match.id);
    const full = state.profileBrains.length >= 5;
    el.folderProfileBrainResults.appendChild(
      contextRow(
        match,
        attached ? t('common.attached') : t('common.attach'),
        () => {
          if (attached || state.profileBrains.length >= 5) return;
          state.profileBrains.push({
            id: match.id,
            title: match.title || match.id,
            ...(match.category ? { category: match.category } : {})
          });
          renderProfileAttachedBrains();
          renderProfileBrainResults(state.profileBrainResults);
        },
        { disabled: attached || full, onError: showProfileError }
      )
    );
  }
}

async function runProfileBrainSearch() {
  const folder = state.profileFolder;
  const query = el.folderProfileBrainSearch.value.trim();
  if (!folder || !gtsEnabled()) return;
  if (!query) {
    renderProfileBrainResults([], t('context.searchPrompt'));
    return;
  }
  try {
    const data = await api(`/api/gts/search?q=${encodeURIComponent(query)}`);
    if (state.profileFolder !== folder || el.folderProfileBrainSearch.value.trim() !== query) return;
    const matches = data.matches || [];
    renderProfileBrainResults(matches, matches.length ? '' : t('context.noBrainsFound'));
  } catch (err) {
    if (state.profileFolder === folder) renderProfileBrainResults([], err.message);
  }
}

function setProfileNameEditing(editing) {
  el.folderProfileNameButton.classList.toggle('hidden', editing);
  el.folderProfileNameInput.classList.toggle('hidden', !editing);
}

function startProfileRename() {
  if (!state.profileFolder || el.folderProfileNameInput.disabled) return;
  showProfileError('');
  el.folderProfileNameInput.value = state.profileFolder;
  setProfileNameEditing(true);
  el.folderProfileNameInput.focus();
  el.folderProfileNameInput.select();
}

function cancelProfileRename() {
  el.folderProfileNameInput.dataset.cancelRename = 'true';
  el.folderProfileNameInput.value = state.profileFolder || '';
  setProfileNameEditing(false);
}

async function renameProfileFolder() {
  if (el.folderProfileNameInput.dataset.cancelRename === 'true') {
    delete el.folderProfileNameInput.dataset.cancelRename;
    return;
  }
  const oldFolder = state.profileFolder;
  if (!oldFolder || el.folderProfileNameInput.disabled) return;
  const newName = el.folderProfileNameInput.value.trim();
  if (!newName) {
    showProfileError(t('profile.nameEmpty'));
    el.folderProfileNameInput.focus();
    return;
  }
  if (newName === oldFolder) {
    setProfileNameEditing(false);
    return;
  }

  el.folderProfileNameInput.disabled = true;
  el.folderProfileSave.disabled = true;
  el.folderProfileDelete.disabled = true;
  showProfileError('');
  let renameError = null;
  try {
    const data = await api(`/api/folders/${encodeURIComponent(oldFolder)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName })
    });
    const renamed = data.name;
    const storedProfile = state.folderProfiles.get(oldFolder);
    state.folderProfiles.delete(oldFolder);
    state.folderProfiles.set(renamed, storedProfile || null);
    if (state.collapsedFolders.delete(oldFolder)) {
      state.collapsedFolders.add(renamed);
      saveCollapsedFolders();
    }
    if (state.detail?.session?.folder === oldFolder) state.detail.session.folder = renamed;
    for (const session of state.sessions) {
      if (session.folder === oldFolder) session.folder = renamed;
    }
    const modalStillOpen = !el.folderProfileModal.classList.contains('hidden') && state.profileFolder === oldFolder;
    if (modalStillOpen) {
      state.profileFolder = renamed;
      el.folderProfileNameText.textContent = renamed;
      el.folderProfileNameInput.value = renamed;
      el.folderProfileDelete.title = t('profile.deleteNamed', { name: renamed });
      setProfileNameEditing(false);
    }
    try {
      await loadSessions();
      setStatusI18n('profile.renamed', { oldName: oldFolder, newName: renamed });
    } catch (err) {
      setStatusI18n('profile.renamedSidebarError', { error: err.message });
    }
  } catch (err) {
    renameError = err;
    showProfileError(err.message);
  } finally {
    el.folderProfileNameInput.disabled = false;
    el.folderProfileSave.disabled = false;
    const sessionCount = folderInfo(state.profileFolder)?.sessionCount || 0;
    el.folderProfileDelete.disabled = !state.profileFolder || sessionCount > 0;
  }
  if (renameError && !el.folderProfileModal.classList.contains('hidden') && state.profileFolder === oldFolder) {
    el.folderProfileNameInput.focus();
    el.folderProfileNameInput.select();
  }
}

function updateProfileCounter() {
  el.folderProfileCounter.textContent = t('profile.counterValue', {
    n: [...el.folderProfileGuidelines.value].length,
    max: 30000
  });
}

function showProfileError(message = '') {
  el.folderProfileError.textContent = message;
  el.folderProfileError.classList.toggle('hidden', !message);
}

async function openFolderProfileModal(folder) {
  const [data, castData] = await Promise.all([
    api(`/api/folders/${encodeURIComponent(folder)}/profile`),
    api(`/api/folders/${encodeURIComponent(folder)}/cast`),
    loadBrandings()
  ]);
  const profile = data.profile || null;
  const sessionCount = folderInfo(folder)?.sessionCount || 0;
  state.profileFolder = folder;
  state.folderProfiles.set(folder, profile);
  el.folderProfileNameText.textContent = folder;
  el.folderProfileNameInput.value = folder;
  setProfileNameEditing(false);
  el.folderProfileGuidelines.value = profile?.guidelines || '';
  state.profileMemory = Array.isArray(profile?.memory) ? profile.memory : [];
  renderProjectMemory();
  state.profileBrains = normaliseProfileBrains(profile?.contextBrains);
  state.profileBrainResults = [];
  el.folderProfileBrainSearch.value = '';
  el.folderProfileGtsSection.classList.toggle('hidden', !gtsEnabled());
  renderProfileAttachedBrains();
  renderProfileBrainResults([], t('context.searchPrompt'));
  state.profileContextFiles = Array.isArray(profile?.contextFiles) ? profile.contextFiles.slice(0, 5) : [];
  renderProfileContextFiles();
  state.profileBrandingIds = Array.isArray(profile?.brandings) ? profile.brandings.slice(0, 2) : [];
  renderProfileBrandings();
  state.profileCast = Array.isArray(castData.members) ? castData.members : [];
  renderProfileCast();
  showProfileError('');
  el.folderProfileDelete.disabled = sessionCount > 0;
  el.folderProfileDelete.title = sessionCount > 0 ? t('profile.moveChatsFirst') : t('profile.deleteNamed', { name: folder });
  el.folderProfileDeleteHint.classList.toggle('hidden', sessionCount === 0);
  updateProfileCounter();
  // The project profile is admin territory with user management: everybody else reads it.
  const profileReadOnly = !OCAccess.canAdminister();
  el.folderProfilePanel.classList.toggle('profile-readonly', profileReadOnly);
  el.folderProfileReadOnly.classList.toggle('hidden', !profileReadOnly);
  el.folderProfileGuidelines.readOnly = profileReadOnly;
  el.folderProfileModal.classList.remove('hidden');
  if (!profileReadOnly) el.folderProfileGuidelines.focus();
  else el.folderProfileClose.focus();
  renderSessions();
}

function closeFolderProfileModal() {
  el.folderProfileModal.classList.add('hidden');
  state.profileFolder = null;
  state.profileBrains = [];
  state.profileBrainResults = [];
  if (state.profileBrainTimer) clearTimeout(state.profileBrainTimer);
  state.profileBrainTimer = null;
  state.profileBrandingIds = [];
  state.profileContextFiles = [];
  state.profileCast = [];
  state.profileMemory = [];
  resetProjectMemoryDelete();
  setProfileNameEditing(false);
  showProfileError('');
}

async function deleteProfileFolder() {
  const folder = state.profileFolder;
  if (!folder || el.folderProfileDelete.disabled || !el.folderProfileNameInput.classList.contains('hidden')) return;
  if (!window.confirm(t('profile.deleteNamed', { name: folder }))) return;
  el.folderProfileDelete.disabled = true;
  showProfileError('');
  try {
    await api(`/api/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' });
    closeFolderProfileModal();
    await loadSessions();
    setStatusI18n('profile.deleted', { name: folder });
  } catch (err) {
    showProfileError(err.message);
    await loadFolders().catch(() => {});
    const sessionCount = folderInfo(folder)?.sessionCount || 0;
    el.folderProfileDelete.disabled = sessionCount > 0;
    el.folderProfileDeleteHint.classList.toggle('hidden', sessionCount === 0);
  }
}

async function saveFolderProfile() {
  const folder = state.profileFolder;
  if (!folder || !el.folderProfileNameInput.classList.contains('hidden')) return;
  const guidelines = el.folderProfileGuidelines.value.trim();
  const contextBrains = profileBrainIds();
  const brandings = state.profileBrandingIds.slice(0, 2);
  el.folderProfileSave.disabled = true;
  showProfileError('');
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ guidelines, contextBrains, brandings })
    });
    state.profileContextFiles = Array.isArray(data.profile?.contextFiles) ? data.profile.contextFiles.slice(0, 5) : [];
    state.folderProfiles.set(folder, data.profile || null);
    if (state.detail?.session?.folder === folder) {
      state.currentFolderProfile = data.profile || null;
      renderContextBadge();
    }
    const info = folderInfo(folder);
    if (info) info.hasProfile = Boolean(data.profile);
    closeFolderProfileModal();
    renderSessions();
    setStatusI18n(data.profile ? 'profile.saved' : 'profile.removed');
  } catch (err) {
    showProfileError(err.message);
  } finally {
    el.folderProfileSave.disabled = false;
  }
}

