'use strict';

// Chat entry point: events, shared shell and initialization after app-*.js.

/* ---------- events ---------- */

el.newSession.addEventListener('click', () => {
  if (!state.streaming) createSession().catch((err) => setStatus(err.message));
});

el.newFolder.addEventListener('click', () => openNewFolderInput());
el.newFolderInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    createFolderFromSidebar();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeNewFolderInput();
    el.newFolder.focus();
  }
});
el.newFolderInput.addEventListener('blur', () => {
  if (!el.newFolderInput.disabled) closeNewFolderInput();
});

el.sessionSearch.addEventListener('input', () => {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    state.sessionQuery = el.sessionSearch.value.trim();
    loadSessions().catch((err) => setStatus(err.message));
  }, SEARCH_DEBOUNCE_MS);
});

el.contextBtn.addEventListener('click', () => openContextModal());
el.contextClose.addEventListener('click', () => closeContextModal());
el.brandingsBtn.addEventListener('click', () => {
  closeMobileSidebar();
  openBrandingsModal();
});
el.brandingsClose.addEventListener('click', () => closeBrandingsModal());
el.brandingImportButton.addEventListener('click', () => {
  if (!state.brandingImporting) el.brandingImportFile.click();
});
el.brandingImportFile.addEventListener('change', () => {
  const file = el.brandingImportFile.files?.[0] || null;
  el.brandingImportFile.value = '';
  importBrandingFile(file);
});
el.settingsTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-settings-tab]');
  if (tab) selectSettingsTab(tab.dataset.settingsTab);
});
el.settingsTabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const tabs = [...el.settingsTabs.querySelectorAll('[data-settings-tab]')].filter((tab) => !tab.classList.contains('hidden'));
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  selectSettingsTab(next.dataset.settingsTab);
  next.focus();
});
el.settingsClose.addEventListener('click', () => closeSettingsModal());
el.higgsfieldRateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveHiggsfieldRate();
});
el.videoAskToggle.addEventListener('change', () => saveVideoAskToggle());
el.adminForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addAdmin();
});
el.userForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addUser();
});
el.shareBtn.addEventListener('click', () => {
  if (state.detail?.session && !el.shareBtn.disabled) openShareForSession(state.detail.session);
});
el.currentProjectName.addEventListener('click', revealCurrentProject);
el.sessionTitle.addEventListener('click', startHeaderRename);
el.sessionTitle.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    startHeaderRename();
  }
});
// The header adapts to its own width, not the window's: fewer labels first, then icons only.
if (typeof ResizeObserver === 'function' && el.topbar) {
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    el.topbar.classList.toggle('is-narrow', width < 1040);
    el.topbar.classList.toggle('is-compact', width < 820);
  }).observe(el.topbar);
}
el.mobileMenuBtn.addEventListener('click', () => setMobileSidebarOpen(!state.mobileSidebarOpen));
el.sidebarBackdrop.addEventListener('click', () => closeMobileSidebar());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) verifyCurrentSession();
});
window.addEventListener('focus', () => verifyCurrentSession());
el.renderNodeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addRenderNode();
});
el.magnificConnect.addEventListener('click', () => connectMagnific());
el.magnificDisconnect.addEventListener('click', () => disconnectMagnific());
el.higgsfieldConnect.addEventListener('click', () => connectHiggsfield());
el.higgsfieldDisconnect.addEventListener('click', () => disconnectHiggsfield());
el.chatgptImport.addEventListener('click', () => importChatGPT());
el.chatgptDisconnect.addEventListener('click', () => disconnectChatGPT());
el.folderProfileClose.addEventListener('click', () => closeFolderProfileModal());
el.folderProfileNameButton.addEventListener('click', startProfileRename);
el.folderProfileNameInput.addEventListener('blur', () => renameProfileFolder());
el.folderProfileNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    el.folderProfileNameInput.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelProfileRename();
    el.folderProfileNameButton.focus();
  }
});
el.folderProfileDelete.addEventListener('click', () => deleteProfileFolder());
el.folderProfileSave.addEventListener('click', () => saveFolderProfile());
el.folderProfileGuidelines.addEventListener('input', updateProfileCounter);
el.costsBtn.addEventListener('click', () => openCostsModal());
el.costsClose.addEventListener('click', () => closeCostsModal());
el.promptPresetClose.addEventListener('click', () => closePromptPresetModal());
el.promptPresetCancel.addEventListener('click', () => closePromptPresetModal());
el.promptPresetForm.addEventListener('submit', (event) => {
  event.preventDefault();
  savePromptPreset();
});

el.contextModal.addEventListener('click', (event) => {
  if (event.target === el.contextModal) closeContextModal();
});

el.brandingsModal.addEventListener('click', (event) => {
  if (event.target === el.brandingsModal) closeBrandingsModal();
});

el.folderProfileModal.addEventListener('click', (event) => {
  if (event.target === el.folderProfileModal) closeFolderProfileModal();
});

el.costsModal.addEventListener('click', (event) => {
  if (event.target === el.costsModal) closeCostsModal();
});

el.settingsModal.addEventListener('click', (event) => {
  if (event.target === el.settingsModal) closeSettingsModal();
});

el.promptPresetModal.addEventListener('click', (event) => {
  if (event.target === el.promptPresetModal) closePromptPresetModal();
});

el.contextSearch.addEventListener('input', () => {
  if (state.contextTimer) clearTimeout(state.contextTimer);
  state.contextTimer = setTimeout(() => {
    state.contextTimer = null;
    runContextSearch();
  }, SEARCH_DEBOUNCE_MS);
});

el.folderProfileBrainSearch.addEventListener('input', () => {
  if (state.profileBrainTimer) clearTimeout(state.profileBrainTimer);
  state.profileBrainTimer = setTimeout(() => {
    state.profileBrainTimer = null;
    runProfileBrainSearch();
  }, SEARCH_DEBOUNCE_MS);
});

el.contextBrandingSelect.addEventListener('change', () => {
  const id = el.contextBrandingSelect.value;
  el.contextBrandingSelect.value = '';
  if (id) attachBrandingToSession(id).catch((err) => setStatus(err.message));
});

el.folderProfileBrandingSelect.addEventListener('change', () => {
  const id = el.folderProfileBrandingSelect.value;
  if (!id) return;
  if (state.profileBrandingIds.length >= 2) {
    showProfileError(t('branding.maxProject'));
    return;
  }
  if (!state.profileBrandingIds.includes(id)) state.profileBrandingIds.push(id);
  showProfileError('');
  renderProfileBrandings();
});

el.attachBtn.addEventListener('click', () => el.fileInput.click());

el.toolsMenuBtn.addEventListener('click', () => {
  setToolsMenuOpen(el.toolsMenu.classList.contains('hidden'));
});

el.promptMenuBtn.addEventListener('click', () => {
  setPromptMenuOpen(el.promptMenu.classList.contains('hidden'));
});

el.fileInput.addEventListener('change', async () => {
  const files = Array.from(el.fileInput.files || []);
  el.fileInput.value = '';
  await addImageFiles(files);
});

el.contextFileUploadBtn.addEventListener('click', () => el.contextFileInput.click());
el.contextFileInput.addEventListener('change', async () => {
  const files = Array.from(el.contextFileInput.files || []);
  el.contextFileInput.value = '';
  try {
    await uploadContextFileList(files);
  } catch (err) {
    setStatus(err.message);
  }
});

el.folderProfileFileUploadBtn.addEventListener('click', () => el.folderProfileFileInput.click());
el.folderProfileFileInput.addEventListener('change', async () => {
  const files = Array.from(el.folderProfileFileInput.files || []);
  el.folderProfileFileInput.value = '';
  try {
    await uploadFolderContextFileList(files);
  } catch (err) {
    showProfileError(err.message);
  }
});

el.roleModalClose.addEventListener('click', closeRoleModal);
el.roleGenerate.addEventListener('click', generateRole);
el.roleDefaultTemplate.addEventListener('click', loadDefaultRoleTemplate);
el.roleEditCancel.addEventListener('click', () => {
  resetRoleForm();
  el.roleName.focus();
});
el.roleSave.addEventListener('click', () => saveRole());
el.roleSaveCopy.addEventListener('click', () => saveRole({ asNew: true }));
el.roleModal.addEventListener('click', (event) => {
  if (event.target === el.roleModal) closeRoleModal();
});

el.main.addEventListener('dragenter', (event) => {
  if (state.streaming || !draggedImages(event.dataTransfer)) return;
  event.preventDefault();
  imageDragDepth += 1;
  el.dropOverlay.classList.remove('hidden');
});

el.main.addEventListener('dragover', (event) => {
  if (state.streaming || !draggedImages(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

el.main.addEventListener('dragleave', () => {
  if (imageDragDepth === 0) return;
  imageDragDepth -= 1;
  if (imageDragDepth === 0) el.dropOverlay.classList.add('hidden');
});

el.main.addEventListener('drop', async (event) => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) event.preventDefault();
  hideDropOverlay();
  await addImageFiles(files);
});

document.addEventListener('dragend', hideDropOverlay);
document.addEventListener('drop', hideDropOverlay);
document.addEventListener('click', (event) => {
  if (!event.target.closest('.session-actions')) closeSessionMenus();
  if (!event.target.closest('.tools-picker')) setToolsMenuOpen(false);
  if (!event.target.closest('.prompt-picker')) setPromptMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.mobileSidebarOpen) {
    event.preventDefault();
    closeMobileSidebar();
  }
  if (event.key === 'Escape') closeEscapableModals();
  if (event.key === 'Escape' && !el.toolsMenu.classList.contains('hidden')) {
    event.preventDefault();
    setToolsMenuOpen(false);
    el.toolsMenuBtn.focus();
  }
  if (event.key === 'Escape' && !el.promptMenu.classList.contains('hidden')) {
    event.preventDefault();
    setPromptMenuOpen(false);
    el.promptMenuBtn.focus();
  }
  if (event.key === 'Escape' && !el.promptPresetModal.classList.contains('hidden')) {
    event.preventDefault();
    closePromptPresetModal();
  }
  if (event.key === 'Escape') closeRoleModal();
});

el.input.addEventListener('paste', async (event) => {
  const files = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  await addImageFiles(files);
});

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

el.input.addEventListener('input', autosizeInput);

el.sendBtn.addEventListener('click', () => send());


function renderModelInfo() {
  if (!state.config) return;
  el.modelInfo.textContent = `${t('tools.imageModel', { name: state.config.imageModel })}\n${t('tools.videoModel', { name: state.config.videoModel })}`;
  el.modelInfo.style.whiteSpace = 'pre-line';
}

window.onLangChange = () => {
  resetPromptPresetDelete();
  renderPromptMenu();
  renderToolsMenu();
  if (state.sessionSwitch) state.sessionSwitch.refresh();
  renderSessions();
  if (!state.streaming) renderDetail();
  renderCosts(state.costs);
  renderAccount();
  renderSessionHeader();
  renderContextBadge();
  renderMobileSidebarState();
  selectSettingsTab(currentSettingsTab());
  renderUsers();
  if (state.usersPaste) state.usersPaste.retranslate();
  OCTeams.rerender();
  OCMcp.rerender();
  OCRenderAgents.rerender();
  OCCloudRender.rerender();
  renderModelInfo();
  renderAttachments();
  renderJobStatusBar();
  if (state.streaming) renderStreamHeartbeat();
  if (state.renderNodeState) renderRenderNodeStatus(state.renderNodeState);
  if (statusTranslation) {
    setStatusI18n(statusTranslation.key, statusTranslation.vars, statusTranslation.options);
  }
  resetSettingsDelete();
  resetAdminDelete();
  resetUserDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  resetChatGPTDisconnect();
  const settingsValues = new Map(
    [...el.settingsList.querySelectorAll('input')].map((input) => [input.id, input.value])
  );
  renderSettings();
  renderAdmins();
  renderRenderNodes();
  renderHiggsfieldStatus();
  renderMagnificStatus();
  renderChatGPTStatus();
  renderPromptPresetFormMode();
  for (const [id, value] of settingsValues) {
    const input = document.getElementById(id);
    if (input) input.value = value;
  }
  renderRoleFormMode();
  if (state.defaultRoleOverwritePending) el.roleDefaultTemplate.textContent = t('roles.reallyOverwrite');
  if (!el.roleModal.classList.contains('hidden')) renderRoleList();
  if (!el.brandingsModal.classList.contains('hidden')) renderBrandingsManager();
  if (!el.contextModal.classList.contains('hidden')) {
    renderContextBrandings();
    renderContextFiles();
    renderAttachedContext();
    runContextSearch();
  }
  if (!el.folderProfileModal.classList.contains('hidden')) {
    renderProfileAttachedBrains();
    renderProfileBrainResults(state.profileBrainResults);
    renderProfileContextFiles();
    renderProfileBrandings();
    renderProfileCast();
    renderProjectMemory();
    updateProfileCounter();
    const folder = state.profileFolder;
    const sessionCount = folderInfo(folder)?.sessionCount || 0;
    el.folderProfileDelete.title = sessionCount > 0 ? t('profile.moveChatsFirst') : t('profile.deleteNamed', { name: folder });
  }
};

/* ---------- side menu as a drawer, shared menu ---------- */

function mobileSidebarFocusTarget() {
  return [el.newSession, el.newFolder, el.sessionSearch].find((node) => node && !node.disabled && node.offsetParent !== null) || el.sidebar;
}

// Under 820 px the side menu is a drawer: hamburger, backdrop, Escape, focus guidance, closes after navigation.
function renderMobileSidebarState() {
  const mobile = Boolean(sidebarDrawerMedia.matches);
  const open = mobile && state.mobileSidebarOpen;
  el.mobileMenuBtn.classList.toggle('hidden', !mobile);
  el.mobileMenuBtn.classList.toggle('is-open', open);
  el.mobileMenuBtn.setAttribute('aria-expanded', String(open));
  el.mobileMenuBtn.setAttribute('aria-label', t(open ? 'topbar.menuClose' : 'topbar.menuOpen'));
  el.sidebar.classList.toggle('is-open', open);
  el.sidebarBackdrop.classList.toggle('hidden', !open);
  document.body.classList.toggle('sidebar-drawer-open', open);
  el.sidebar.inert = mobile && !open;
  if (mobile) el.sidebar.setAttribute('aria-hidden', String(!open));
  else el.sidebar.removeAttribute('aria-hidden');
}

function setMobileSidebarOpen(open, { restoreFocus = true } = {}) {
  const wasOpen = state.mobileSidebarOpen;
  state.mobileSidebarOpen = Boolean(open && sidebarDrawerMedia.matches);
  if (state.mobileSidebarOpen) OCShell.closeAll();
  renderMobileSidebarState();
  if (state.mobileSidebarOpen) {
    requestAnimationFrame(() => mobileSidebarFocusTarget().focus({ preventScroll: true }));
  } else if (wasOpen && restoreFocus && sidebarDrawerMedia.matches) {
    el.mobileMenuBtn.focus({ preventScroll: true });
  }
}

function closeMobileSidebar(options) {
  if (state.mobileSidebarOpen) setMobileSidebarOpen(false, options);
}

function syncMobileSidebarViewport() {
  if (!sidebarDrawerMedia.matches) state.mobileSidebarOpen = false;
  renderMobileSidebarState();
  OCShell.refresh();
}

// Escape closes the open dialog (the sharing dialog handles its own).
function closeEscapableModals(event) {
  if (event && event.defaultPrevented) return;
  const pairs = [
    [el.costsModal, closeCostsModal],
    [el.settingsModal, closeSettingsModal],
    [el.contextModal, closeContextModal],
    [el.brandingsModal, closeBrandingsModal],
    [el.folderProfileModal, closeFolderProfileModal]
  ];
  for (const [modal, close] of pairs) if (!modal.classList.contains('hidden')) close();
}

if (typeof sidebarDrawerMedia.addEventListener === 'function') sidebarDrawerMedia.addEventListener('change', syncMobileSidebarViewport);

// The menu behind the avatar is shared with the node view (public/shell.js). Under 820 px the header keeps burger,
// mode switch and avatar; context and sharing move into the menu.
const accountMenuView = OCShell.accountMenu({ variant: 'chat' });
el.accountHost.replaceChildren(accountMenuView.element);
OCShell.register({
  openCosts: () => openCostsModal(),
  openSettings: () => openSettingsModal(),
  settingsAvailable: () => state.settingsAvailable,
  costsText: () => state.costsAmountText
});
OCMcp.attach();
OCRenderAgents.attach();
OCTeams.attach({ openSettingsTab: (tab) => openSettingsModal(tab), settingsAvailable: () => state.settingsAvailable });
OCAccess.onChange(() => renderBudgetBanner());
OCShell.addSection('workspace', () => {
  if (!sidebarDrawerMedia.matches || !state.currentId) return [];
  const session = state.detail?.session;
  const total = state.contextBrains.length + state.contextFiles.length + effectiveBrandingIds().length;
  const items = [{ id: 'context', label: t('topbar.context'), value: total ? String(total) : '', onSelect: () => openContextModal() }];
  const canShare = OCAccess.isActive() && session?.canShare === true;
  if (canShare) items.push({ id: 'share', label: el.shareBtnLabel.textContent || t('sharing.button'), onSelect: () => openShareForSession(session) });
  return items;
});
syncMobileSidebarViewport();

/* ---------- init ---------- */

async function init() {
  loadPromptPresets();
  try {
    state.config = await api('/api/config');
  } catch (err) {
    setStatusI18n('send.serverUnavailable', { error: err.message });
    return;
  }

  await OCAccess.ready;
  renderAccount();
  mountSessionGrouping();
  // The login could not be confirmed: the banner explains it and offers a reload (public/access-client.js, which
  // reloads by itself once the login is confirmed). Nothing else is loaded, so no request fails on top of it.
  if (OCAccess.me().loginUnconfirmed) return;
  renderPromptMenu();
  renderToolsMenu();
  await loadSettingsAccess();

  el.keyBanner.classList.toggle('hidden', Boolean(state.config.hasKey));
  let savedBrain = '';
  try {
    savedBrain = localStorage.getItem(BRAIN_STORAGE_KEY) || '';
  } catch (_) {
    /* Standardmodell verwenden. */
  }
  const brainModels = offeredBrainModels();
  const initialBrain = brainModels.includes(savedBrain) ? savedBrain : state.config.defaultBrain;
  selectBrain(initialBrain, { remember: false });
  renderModelInfo();
  renderContextBadge();
  renderCosts(null);
  refreshCosts().catch((err) => setStatusI18n('costs.loadError', { error: err.message }));
  scheduleRenderNodePolling(0);

  try {
    await Promise.all([loadSessions(), loadBrandings(), loadRoles()]);
    const deepLinkId = sessionIdFromHash();
    if (deepLinkId) {
      try {
        await openSession(deepLinkId);
      } catch (err) {
        if (err.status !== 400 && err.status !== 404) throw err;
        if (state.sessions.length) await openSession(state.sessions[0].id);
        else await createSession();
        setStatusI18n('sessions.notFound');
      }
    } else if (state.sessions.length) {
      await openSession(state.sessions[0].id);
    } else {
      await createSession();
    }
  } catch (err) {
    setStatus(err.message);
  }
  el.input.focus();
}

window.addEventListener('hashchange', async () => {
  const id = sessionIdFromHash();
  if (!id || id === state.currentId) return;
  if (state.streaming) {
    setSessionHash(state.currentId);
    setStatusI18n('sessions.wait');
    return;
  }
  try {
    await openSession(id);
  } catch (err) {
    setSessionHash(state.currentId);
    if (err.status === 400 || err.status === 404) setStatusI18n('sessions.notFound');
    else setStatus(err.message);
  }
});

init();
