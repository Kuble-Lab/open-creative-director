'use strict';

const el = {
  sessionList: document.getElementById('sessionList'),
  sessionSearch: document.getElementById('sessionSearch'),
  newSession: document.getElementById('newSession'),
  sidebarCreate: document.getElementById('sidebarCreate'),
  newFolder: document.getElementById('newFolder'),
  newFolderInput: document.getElementById('newFolderInput'),
  langSwitch: document.getElementById('langSwitch'),
  modelInfo: document.getElementById('modelInfo'),
  brandingsBtn: document.getElementById('brandingsBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  settingsClose: document.getElementById('settingsClose'),
  settingsList: document.getElementById('settingsList'),
  settingsFeedback: document.getElementById('settingsFeedback'),
  adminsList: document.getElementById('adminsList'),
  adminForm: document.getElementById('adminForm'),
  adminEmail: document.getElementById('adminEmail'),
  adminAdd: document.getElementById('adminAdd'),
  renderNodesList: document.getElementById('renderNodesList'),
  renderNodeForm: document.getElementById('renderNodeForm'),
  renderNodeName: document.getElementById('renderNodeName'),
  renderNodeUrl: document.getElementById('renderNodeUrl'),
  renderNodeToken: document.getElementById('renderNodeToken'),
  renderNodeAdd: document.getElementById('renderNodeAdd'),
  higgsfieldStatusDot: document.getElementById('higgsfieldStatusDot'),
  higgsfieldStatusText: document.getElementById('higgsfieldStatusText'),
  higgsfieldVerification: document.getElementById('higgsfieldVerification'),
  higgsfieldVerificationLink: document.getElementById('higgsfieldVerificationLink'),
  higgsfieldConnect: document.getElementById('higgsfieldConnect'),
  higgsfieldDisconnect: document.getElementById('higgsfieldDisconnect'),
  renderNodeStatus: document.getElementById('renderNodeStatus'),
  renderNodeText: document.getElementById('renderNodeText'),
  sessionTitle: document.getElementById('sessionTitle'),
  keyBanner: document.getElementById('keyBanner'),
  main: document.querySelector('.main'),
  messages: document.getElementById('messages'),
  dropOverlay: document.getElementById('dropOverlay'),
  attachStrip: document.getElementById('attachStrip'),
  attachBtn: document.getElementById('attachBtn'),
  toolsMenuBtn: document.getElementById('toolsMenuBtn'),
  toolsActiveBadge: document.getElementById('toolsActiveBadge'),
  toolsMenu: document.getElementById('toolsMenu'),
  promptMenuBtn: document.getElementById('promptMenuBtn'),
  promptMenu: document.getElementById('promptMenu'),
  promptPresetModal: document.getElementById('promptPresetModal'),
  promptPresetTitle: document.getElementById('promptPresetTitle'),
  promptPresetClose: document.getElementById('promptPresetClose'),
  promptPresetForm: document.getElementById('promptPresetForm'),
  promptPresetName: document.getElementById('promptPresetName'),
  promptPresetGroup: document.getElementById('promptPresetGroup'),
  promptPresetGroups: document.getElementById('promptPresetGroups'),
  promptPresetDescription: document.getElementById('promptPresetDescription'),
  promptPresetText: document.getElementById('promptPresetText'),
  promptPresetFeedback: document.getElementById('promptPresetFeedback'),
  promptPresetCancel: document.getElementById('promptPresetCancel'),
  promptPresetSave: document.getElementById('promptPresetSave'),
  fileInput: document.getElementById('fileInput'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
  statusLine: document.getElementById('statusLine'),
  statusText: document.getElementById('statusText'),
  costsBtn: document.getElementById('costsBtn'),
  costsModal: document.getElementById('costsModal'),
  costsClose: document.getElementById('costsClose'),
  costsBody: document.getElementById('costsBody'),
  contextBtn: document.getElementById('contextBtn'),
  contextBadge: document.getElementById('contextBadge'),
  brandingContextBadge: document.getElementById('brandingContextBadge'),
  contextModal: document.getElementById('contextModal'),
  contextClose: document.getElementById('contextClose'),
  contextSearch: document.getElementById('contextSearch'),
  contextAttached: document.getElementById('contextAttached'),
  contextResults: document.getElementById('contextResults'),
  contextGtsSection: document.getElementById('contextGtsSection'),
  contextFiles: document.getElementById('contextFiles'),
  contextFileUploadBtn: document.getElementById('contextFileUploadBtn'),
  contextFileInput: document.getElementById('contextFileInput'),
  contextFileHint: document.getElementById('contextFileHint'),
  contextBrandings: document.getElementById('contextBrandings'),
  contextBrandingSelect: document.getElementById('contextBrandingSelect'),
  contextBrandingHint: document.getElementById('contextBrandingHint'),
  folderProfileModal: document.getElementById('folderProfileModal'),
  folderProfileTitle: document.getElementById('folderProfileTitle'),
  folderProfileNameButton: document.getElementById('folderProfileNameButton'),
  folderProfileNameText: document.getElementById('folderProfileNameText'),
  folderProfileNameInput: document.getElementById('folderProfileNameInput'),
  folderProfileClose: document.getElementById('folderProfileClose'),
  folderProfileGuidelines: document.getElementById('folderProfileGuidelines'),
  folderProfileCounter: document.getElementById('folderProfileCounter'),
  folderProfileMemory: document.getElementById('folderProfileMemory'),
  folderProfileGtsSection: document.getElementById('folderProfileGtsSection'),
  folderProfileAttachedBrains: document.getElementById('folderProfileAttachedBrains'),
  folderProfileBrainSearch: document.getElementById('folderProfileBrainSearch'),
  folderProfileBrainResults: document.getElementById('folderProfileBrainResults'),
  folderProfileBrainLimit: document.getElementById('folderProfileBrainLimit'),
  folderProfileFiles: document.getElementById('folderProfileFiles'),
  folderProfileFileUploadBtn: document.getElementById('folderProfileFileUploadBtn'),
  folderProfileFileInput: document.getElementById('folderProfileFileInput'),
  folderProfileFileHint: document.getElementById('folderProfileFileHint'),
  folderProfileBrandings: document.getElementById('folderProfileBrandings'),
  folderProfileBrandingSelect: document.getElementById('folderProfileBrandingSelect'),
  folderProfileBrandingHint: document.getElementById('folderProfileBrandingHint'),
  folderProfileCast: document.getElementById('folderProfileCast'),
  folderProfileError: document.getElementById('folderProfileError'),
  folderProfileDeleteHint: document.getElementById('folderProfileDeleteHint'),
  folderProfileDelete: document.getElementById('folderProfileDelete'),
  folderProfileSave: document.getElementById('folderProfileSave'),
  brandingsModal: document.getElementById('brandingsModal'),
  brandingsClose: document.getElementById('brandingsClose'),
  brandingsList: document.getElementById('brandingsList'),
  brandingImportName: document.getElementById('brandingImportName'),
  brandingImportButton: document.getElementById('brandingImportButton'),
  brandingImportFile: document.getElementById('brandingImportFile'),
  brandingImportFeedback: document.getElementById('brandingImportFeedback'),
  roleModal: document.getElementById('roleModal'),
  roleModalClose: document.getElementById('roleModalClose'),
  roleList: document.getElementById('roleList'),
  roleFormTitle: document.getElementById('roleFormTitle'),
  roleEditCancel: document.getElementById('roleEditCancel'),
  roleName: document.getElementById('roleName'),
  roleBrief: document.getElementById('roleBrief'),
  roleEmoji: document.getElementById('roleEmoji'),
  roleDescription: document.getElementById('roleDescription'),
  rolePrompt: document.getElementById('rolePrompt'),
  roleGenerate: document.getElementById('roleGenerate'),
  roleDefaultTemplate: document.getElementById('roleDefaultTemplate'),
  roleDefaultStatus: document.getElementById('roleDefaultStatus'),
  roleSave: document.getElementById('roleSave'),
  roleSaveCopy: document.getElementById('roleSaveCopy'),
  roleModalError: document.getElementById('roleModalError'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightboxImg')
};

const FOLDERS_COLLAPSED_KEY = 'vcd-folders-collapsed';
const PRESET_GROUPS_STORAGE_KEY = 'vcd-preset-groups';
const BRAIN_STORAGE_KEY = 'vcd-brain';
const BRAIN_LABELS = {
  'openai/gpt-5.6-sol': { shortName: '5.6 Sol', hintKey: 'model.codexStandard' },
  'openai/gpt-5.6-sol-pro': { shortName: '5.6 Sol Pro', hintKey: 'model.codexStronger' },
  'openai/gpt-5.6-terra': { shortName: '5.6 Terra', hintKey: 'model.codex' },
  'openai/gpt-5.6-terra-pro': { shortName: '5.6 Terra Pro', hintKey: 'model.codex' },
  'openai/gpt-5.6-luna': { shortName: '5.6 Luna', hintKey: 'model.codex' },
  'openai/gpt-5.6-luna-pro': { shortName: '5.6 Luna Pro', hintKey: 'model.codex' },
  'anthropic/claude-fable-5': {
    shortName: 'Claude Fable 5',
    hintKey: 'model.fable'
  },
  'moonshotai/kimi-k3': { shortName: 'Kimi K3', hintKey: 'model.kimi' }
};

function loadCollapsedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDERS_COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((folder) => typeof folder === 'string') : []);
  } catch (_) {
    return new Set();
  }
}

function loadOpenPresetGroups() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRESET_GROUPS_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((group) => typeof group === 'string') : []);
  } catch (_) {
    return new Set();
  }
}

const state = {
  config: null,
  sessions: [],
  folders: [],
  sessionQuery: '',
  sessionTotal: 0,
  sessionLoadedCount: 0,
  sessionHasMore: false,
  collapsedFolders: loadCollapsedFolders(),
  searchTimer: null,
  currentId: null,
  detail: null,
  attachments: [],
  contextBrains: [],
  contextFiles: [],
  contextTimer: null,
  brandings: [],
  roles: [],
  editingRoleId: null,
  pendingRoleId: null,
  pendingRoleDeleteId: null,
  defaultRoleOverwritePending: false,
  defaultRoleOverwriteTimer: null,
  currentFolderProfile: null,
  profileBrains: [],
  profileBrainResults: [],
  profileBrainTimer: null,
  profileBrandingIds: [],
  profileContextFiles: [],
  profileCast: [],
  profileMemory: [],
  pendingProjectMemoryDeleteId: null,
  projectMemoryDeleteTimer: null,
  pendingBrandingDeleteId: null,
  brandingImporting: false,
  highlightedBrandingId: null,
  folderProfiles: new Map(),
  profileFolder: null,
  streaming: false,
  jobTimer: null,
  renderNodeTimer: null,
  renderNodeState: null,
  renderNodeAvailable: false,
  renderMode: false,
  brandingWizard: false,
  brainModel: '',
  liveRenderNodeJob: false,
  costs: null,
  settings: [],
  pendingSettingsDeleteName: null,
  settingsDeleteTimer: null,
  admins: [],
  pendingAdminDeleteEmail: null,
  adminDeleteTimer: null,
  renderNodes: [],
  pendingRenderNodeDeleteId: null,
  renderNodeDeleteTimer: null,
  higgsfield: { connected: false, refreshExpiresAt: null, pending: false },
  higgsfieldPollTimer: null,
  higgsfieldPollExpiresAt: 0,
  higgsfieldDisconnectPending: false,
  higgsfieldDisconnectTimer: null,
  promptPresets: [],
  openPromptGroups: loadOpenPresetGroups(),
  editingPromptPresetId: null,
  pendingPromptPresetDeleteId: null,
  promptPresetDeleteTimer: null,
  live: null
};

const SESSION_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const RENDER_NODE_IDLE_POLL_MS = 30000;
const RENDER_NODE_ACTIVE_POLL_MS = 10000;

/* ---------- helpers ---------- */

// Relative Pfade, damit die App auch unter einem Subpfad (z.B. /supercomputer/) laeuft.
function rel(path) {
  return String(path).replace(/^\/+/, '');
}

function brainLabel(model) {
  if (BRAIN_LABELS[model]) {
    const label = BRAIN_LABELS[model];
    return { shortName: label.shortName, hint: t(label.hintKey) };
  }
  return { shortName: String(model || '').split('/').pop() || String(model || ''), hint: '' };
}

function setToolsMenuOpen(open) {
  const isOpen = Boolean(open);
  if (isOpen) setPromptMenuOpen(false);
  el.toolsMenu.classList.toggle('hidden', !isOpen);
  el.toolsMenuBtn.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) renderToolsMenu();
}

function setPromptMenuOpen(open) {
  const isOpen = Boolean(open) && state.promptPresets.length > 0;
  if (isOpen) setToolsMenuOpen(false);
  el.promptMenu.classList.toggle('hidden', !isOpen);
  el.promptMenuBtn.setAttribute('aria-expanded', String(isOpen));
}

function toolsMenuHeading(label) {
  const heading = document.createElement('div');
  heading.className = 'composer-menu-heading';
  heading.textContent = label;
  return heading;
}

function toolsMenuOption({ name, hint = '', active = false, icon = '', role = 'menuitemradio', onClick, disabled = false }) {
  const option = document.createElement('button');
  option.type = 'button';
  option.className = `composer-menu-option tools-menu-option${active ? ' active' : ''}`;
  option.setAttribute('role', role);
  if (role === 'menuitemradio' || role === 'menuitemcheckbox') option.setAttribute('aria-checked', String(active));
  option.disabled = disabled;

  const marker = document.createElement('span');
  marker.className = 'tools-menu-marker';
  marker.textContent = active ? '✓' : icon;
  marker.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.className = 'composer-menu-copy';
  const title = document.createElement('span');
  title.className = 'composer-menu-name';
  title.textContent = name;
  copy.appendChild(title);
  if (hint) {
    const small = document.createElement('span');
    small.className = 'composer-menu-hint';
    small.textContent = hint;
    copy.appendChild(small);
  }
  option.append(marker, copy);
  option.addEventListener('click', onClick);
  return option;
}

function saveOpenPromptGroups() {
  try {
    localStorage.setItem(PRESET_GROUPS_STORAGE_KEY, JSON.stringify([...state.openPromptGroups]));
  } catch (_) {
    /* Das Menue funktioniert auch ohne localStorage. */
  }
}

function resetPromptPresetDelete() {
  if (state.promptPresetDeleteTimer) clearTimeout(state.promptPresetDeleteTimer);
  state.promptPresetDeleteTimer = null;
  state.pendingPromptPresetDeleteId = null;
  for (const button of el.promptMenu.querySelectorAll('[data-prompt-preset-delete]')) {
    button.textContent = '🗑';
    button.classList.remove('pending');
    button.title = t('prompt.customDelete');
    button.setAttribute('aria-label', t('prompt.customDelete'));
  }
}

function promptMenuOption(preset) {
  const row = document.createElement('div');
  row.className = 'prompt-menu-row';
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'composer-menu-option prompt-menu-option';
  option.setAttribute('role', 'menuitem');

  const copy = document.createElement('span');
  copy.className = 'composer-menu-copy';
  const title = document.createElement('span');
  title.className = 'composer-menu-name';
  title.textContent = preset.title;
  copy.appendChild(title);
  if (preset.description) {
    const description = document.createElement('span');
    description.className = 'composer-menu-hint';
    description.textContent = preset.description;
    copy.appendChild(description);
  }
  option.appendChild(copy);
  option.addEventListener('click', () => insertPromptPreset(preset.prompt));
  row.appendChild(option);

  if (preset.custom === true) {
    const actions = document.createElement('span');
    actions.className = 'prompt-menu-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'prompt-menu-icon-action';
    edit.textContent = '✎';
    edit.title = t('prompt.customEdit');
    edit.setAttribute('aria-label', t('prompt.customEditNamed', { name: preset.title }));
    edit.addEventListener('click', () => openPromptPresetModal(preset));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'prompt-menu-icon-action danger';
    remove.textContent = '🗑';
    remove.title = t('prompt.customDelete');
    remove.setAttribute('aria-label', t('prompt.customDeleteNamed', { name: preset.title }));
    remove.dataset.promptPresetDelete = preset.id;
    remove.addEventListener('click', () => deletePromptPreset(preset, remove));
    actions.append(edit, remove);
    row.appendChild(actions);
  }
  return row;
}

function renderPromptMenu() {
  el.promptMenu.replaceChildren();
  const groups = new Map();
  for (const preset of state.promptPresets) {
    if (!groups.has(preset.group)) groups.set(preset.group, []);
    groups.get(preset.group).push(preset);
  }
  let groupIndex = 0;
  for (const [group, presets] of groups) {
    const section = document.createElement('div');
    const isOpen = state.openPromptGroups.has(group);
    section.className = `prompt-menu-group${isOpen ? '' : ' collapsed'}`;
    const contentId = `promptGroupContent${groupIndex}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'prompt-menu-group-toggle';
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-controls', contentId);
    const chevron = document.createElement('span');
    chevron.className = 'prompt-menu-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = isOpen ? '▾' : '▸';
    const groupKey = `prompt.group.${group}`;
    const label = Object.prototype.hasOwnProperty.call(I18N.de, groupKey) ? t(groupKey) : group;
    toggle.append(chevron, document.createTextNode(label));
    const content = document.createElement('div');
    content.id = contentId;
    content.className = 'prompt-menu-group-content';
    for (const preset of presets) content.appendChild(promptMenuOption(preset));
    toggle.addEventListener('click', () => {
      const open = section.classList.contains('collapsed');
      section.classList.toggle('collapsed', !open);
      toggle.setAttribute('aria-expanded', String(open));
      chevron.textContent = open ? '▾' : '▸';
      if (open) state.openPromptGroups.add(group);
      else state.openPromptGroups.delete(group);
      saveOpenPromptGroups();
    });
    section.append(toggle, content);
    el.promptMenu.appendChild(section);
    groupIndex += 1;
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'prompt-menu-add';
  add.textContent = t('prompt.customAdd');
  add.addEventListener('click', () => openPromptPresetModal());
  el.promptMenu.appendChild(add);
}

function showPromptPresetFeedback(message, { error = false } = {}) {
  el.promptPresetFeedback.textContent = message;
  el.promptPresetFeedback.classList.toggle('hidden', !message);
  el.promptPresetFeedback.classList.toggle('error', error);
}

function populatePromptPresetGroups() {
  const groups = [...new Set(state.promptPresets.map((preset) => preset.group))];
  el.promptPresetGroups.replaceChildren();
  for (const group of groups) {
    const option = document.createElement('option');
    option.value = group;
    el.promptPresetGroups.appendChild(option);
  }
}

function renderPromptPresetFormMode() {
  const editing = Boolean(state.editingPromptPresetId);
  el.promptPresetTitle.textContent = t(editing ? 'prompt.customEditTitle' : 'prompt.customNew');
  el.promptPresetSave.textContent = t(editing ? 'common.update' : 'common.save');
}

function openPromptPresetModal(preset = null) {
  resetPromptPresetDelete();
  setPromptMenuOpen(false);
  state.editingPromptPresetId = preset?.custom === true ? preset.id : null;
  populatePromptPresetGroups();
  el.promptPresetForm.reset();
  el.promptPresetName.value = preset?.title || '';
  el.promptPresetGroup.value = preset?.group || '';
  el.promptPresetDescription.value = preset?.description || '';
  el.promptPresetText.value = preset?.prompt || '';
  showPromptPresetFeedback('');
  renderPromptPresetFormMode();
  el.promptPresetModal.classList.remove('hidden');
  el.promptPresetName.focus();
}

function closePromptPresetModal() {
  state.editingPromptPresetId = null;
  showPromptPresetFeedback('');
  el.promptPresetModal.classList.add('hidden');
}

async function savePromptPreset() {
  const editingId = state.editingPromptPresetId;
  const body = {
    title: el.promptPresetName.value,
    group: el.promptPresetGroup.value,
    description: el.promptPresetDescription.value,
    prompt: el.promptPresetText.value
  };
  el.promptPresetSave.disabled = true;
  showPromptPresetFeedback('');
  try {
    const data = await api(editingId ? `/api/prompt-presets/custom/${editingId}` : '/api/prompt-presets/custom', {
      method: editingId ? 'PUT' : 'POST',
      body: JSON.stringify(body)
    });
    state.promptPresets = Array.isArray(data.presets) ? data.presets : state.promptPresets;
    state.openPromptGroups.add(body.group.trim());
    saveOpenPromptGroups();
    renderPromptMenu();
    closePromptPresetModal();
    setStatusI18n(editingId ? 'prompt.customUpdated' : 'prompt.customSaved');
  } catch (err) {
    showPromptPresetFeedback(t('prompt.customSaveFailed', { error: err.message }), { error: true });
  } finally {
    el.promptPresetSave.disabled = false;
  }
}

async function deletePromptPreset(preset, button) {
  if (state.pendingPromptPresetDeleteId !== preset.id) {
    resetPromptPresetDelete();
    state.pendingPromptPresetDeleteId = preset.id;
    button.textContent = t('common.reallyDelete');
    button.classList.add('pending');
    state.promptPresetDeleteTimer = setTimeout(resetPromptPresetDelete, 3000);
    return;
  }
  button.disabled = true;
  try {
    const data = await api(`/api/prompt-presets/custom/${preset.id}`, { method: 'DELETE' });
    state.promptPresets = Array.isArray(data.presets) ? data.presets : [];
    resetPromptPresetDelete();
    renderPromptMenu();
    setStatusI18n('prompt.customDeleted');
  } catch (err) {
    button.disabled = false;
    setStatusI18n('prompt.customDeleteFailed', { error: err.message });
  }
}

function autosizeInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
}

function insertPromptPreset(prompt) {
  const existing = el.input.value;
  const separator = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const insertStart = existing.length + separator.length;
  el.input.value = `${existing}${separator}${prompt}`;
  setPromptMenuOpen(false);
  autosizeInput();
  el.input.focus();

  const placeholder = prompt.match(/\[[^\]]+\]/);
  if (placeholder && Number.isInteger(placeholder.index)) {
    const start = insertStart + placeholder.index;
    el.input.setSelectionRange(start, start + placeholder[0].length);
  }
}

async function loadPromptPresets() {
  try {
    const presets = await api('/api/prompt-presets');
    if (!Array.isArray(presets) || !presets.length) throw new Error('No prompt templates available');
    state.promptPresets = presets;
    renderPromptMenu();
  } catch (_) {
    state.promptPresets = [];
    setPromptMenuOpen(false);
    el.promptMenuBtn.closest('.prompt-picker')?.classList.add('hidden');
  }
}

function activeRoleId() {
  return state.detail?.session?.role || state.pendingRoleId || null;
}

function activeRole() {
  return state.roles.find((role) => role.id === activeRoleId()) || null;
}

function updateToolsButton() {
  const role = activeRole();
  const active = state.renderMode || state.brandingWizard || Boolean(role);
  el.toolsActiveBadge.classList.toggle('hidden', !active);
  const states = [t('tools.modelState', { name: brainLabel(state.brainModel).shortName })];
  if (role) states.push(t('tools.roleState', { name: role.name }));
  if (state.renderMode) states.push(t('tools.hyperframesActive'));
  if (state.brandingWizard) states.push(t('tools.brandingActive'));
  const tooltip = states.length ? `${t('composer.tools')} - ${states.join(', ')}` : t('composer.tools');
  el.toolsMenuBtn.title = tooltip;
  el.toolsMenuBtn.setAttribute('aria-label', tooltip);
}

function renderToolsMenu() {
  el.toolsMenu.innerHTML = '';
  el.toolsMenu.appendChild(toolsMenuHeading(t('tools.model')));
  for (const model of state.config?.brainModels || []) {
    const label = brainLabel(model);
    el.toolsMenu.appendChild(toolsMenuOption({
      name: label.shortName,
      hint: label.hint,
      active: model === state.brainModel,
      onClick: () => selectBrain(model)
    }));
  }

  el.toolsMenu.appendChild(toolsMenuHeading(t('tools.role')));
  el.toolsMenu.appendChild(toolsMenuOption({
    name: t('tools.defaultRole'),
    active: !activeRole(),
    onClick: () => selectRole(null)
  }));
  for (const role of state.roles) {
    el.toolsMenu.appendChild(toolsMenuOption({
      name: `${role.emoji ? `${role.emoji} ` : ''}${role.name}`,
      hint: role.description || '',
      active: role.id === activeRoleId(),
      onClick: () => selectRole(role.id)
    }));
  }
  el.toolsMenu.appendChild(toolsMenuOption({
    name: t('tools.newRole'),
    icon: '✨',
    role: 'menuitem',
    onClick: () => {
      setToolsMenuOpen(false);
      openRoleModal();
    }
  }));

  el.toolsMenu.appendChild(toolsMenuHeading(t('tools.actions')));
  if (state.renderNodeAvailable) {
    el.toolsMenu.appendChild(toolsMenuOption({
      name: t('tools.hyperframesNext'),
      icon: '⚡',
      active: state.renderMode,
      role: 'menuitemcheckbox',
      disabled: state.streaming,
      onClick: () => setRenderMode(!state.renderMode)
    }));
  }
  el.toolsMenu.appendChild(toolsMenuOption({
    name: t('tools.brandingInterview'),
    icon: '🎨',
    active: state.brandingWizard,
    role: 'menuitemcheckbox',
    disabled: state.streaming,
    onClick: () => setBrandingWizard(!state.brandingWizard)
  }));
  updateToolsButton();
}

function selectBrain(model, { remember = true } = {}) {
  if (!(state.config?.brainModels || []).includes(model)) return;
  state.brainModel = model;
  if (remember) {
    try {
      localStorage.setItem(BRAIN_STORAGE_KEY, model);
    } catch (_) {
      /* Auswahl bleibt fuer diese Sitzung aktiv. */
    }
  }
  renderToolsMenu();
}

async function selectRole(roleId) {
  if (state.streaming) return;
  if (roleId && !state.roles.some((role) => role.id === roleId)) return;
  if (!state.currentId || !state.detail?.session) {
    state.pendingRoleId = roleId;
    renderToolsMenu();
    return;
  }
  try {
    const data = await api(`/api/sessions/${state.currentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: roleId })
    });
    Object.assign(state.detail.session, data.session);
    const meta = state.sessions.find((session) => session.id === state.currentId);
    if (meta) Object.assign(meta, data.session);
    renderToolsMenu();
  } catch (err) {
    setStatusI18n('tools.roleSetFailed', { error: err.message });
  }
}

async function api(path, options) {
  const res = await fetch(rel(path), {
    headers: { 'Content-Type': 'application/json' },
    ...(options || {})
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch (_) {
      /* ignore */
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inlineFormat(text) {
  const codes = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

// Minimal markdown: paragraphs, line breaks, bold, italic, inline code, lists, headings.
function renderMarkdown(raw) {
  const lines = escapeHtml(String(raw || '')).split(/\n/);
  const html = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inlineFormat(para.join('<br>'))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(numbered[1]);
    } else if (heading) {
      flushPara();
      flushList();
      html.push(`<p><strong>${inlineFormat(heading[1])}</strong></p>`);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html.join('');
}

function formatCost(cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return '';
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatSummaryCost(cost) {
  const value = typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
  if (value === 0) return '$ 0.00';
  if (value < 0.01) return '< $0.01';
  return `$ ${value.toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function scrollDown() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

let statusChangeId = 0;
let statusChangeTimer = null;
let statusTranslation = null;

function setStatus(text, { busy = false, preserveTranslation = false } = {}) {
  if (!preserveTranslation) statusTranslation = null;
  const nextText = String(text || '');
  const changeId = ++statusChangeId;
  if (statusChangeTimer) {
    clearTimeout(statusChangeTimer);
    statusChangeTimer = null;
  }

  el.statusLine.classList.toggle('busy', Boolean(nextText && busy));
  if (!nextText) {
    el.statusLine.classList.remove('visible', 'changing');
    el.statusText.textContent = '';
    return;
  }

  el.statusLine.classList.add('visible');
  if (!el.statusText.textContent || el.statusText.textContent === nextText) {
    el.statusText.textContent = nextText;
    el.statusLine.classList.remove('changing');
    return;
  }

  el.statusLine.classList.add('changing');
  statusChangeTimer = setTimeout(() => {
    if (changeId !== statusChangeId) return;
    el.statusText.textContent = nextText;
    el.statusLine.classList.remove('changing');
    statusChangeTimer = null;
  }, 110);
}

function setStatusI18n(key, vars = {}, options = {}) {
  statusTranslation = { key, vars, options };
  const resolvedVars = Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [name, typeof value === 'function' ? value() : value])
  );
  setStatus(t(key, resolvedVars), { ...options, preserveTranslation: true });
}

/* ---------- element builders ---------- */

function imageCard(asset) {
  const card = document.createElement('div');
  card.className = 'asset-card';
  const img = document.createElement('img');
  img.src = rel(asset.url);
  img.alt = asset.prompt || asset.id;
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(rel(asset.url)));
  card.appendChild(img);
  card.appendChild(assetMeta(asset));
  return card;
}

function videoCard(asset) {
  const card = document.createElement('div');
  card.className = 'asset-card';
  const video = document.createElement('video');
  video.src = rel(asset.url);
  video.controls = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'metadata';
  card.appendChild(video);
  card.appendChild(assetMeta(asset));
  return card;
}

function audioCard(asset) {
  const card = document.createElement('div');
  card.className = 'asset-card';
  const audio = document.createElement('audio');
  audio.src = rel(asset.url);
  audio.controls = true;
  audio.preload = 'none';
  audio.title = asset.prompt || asset.id;
  card.appendChild(audio);
  card.appendChild(assetMeta(asset));
  return card;
}

function mediaCard(asset) {
  if (asset.kind === 'video') return videoCard(asset);
  if (asset.kind === 'audio') return audioCard(asset);
  return imageCard(asset);
}

function assetMeta(asset) {
  const meta = document.createElement('div');
  meta.className = 'asset-meta';
  const id = document.createElement('span');
  id.className = 'asset-id';
  id.textContent = asset.id;
  meta.appendChild(id);
  const cost = formatCost(asset.cost);
  if (cost) {
    const costEl = document.createElement('span');
    costEl.className = 'asset-cost';
    costEl.textContent = cost;
    meta.appendChild(costEl);
  }
  return meta;
}

function jobCard(job) {
  const card = document.createElement('div');
  const failed = job.status === 'failed' || job.status === 'cancelled';
  card.className = `job-card${failed ? ' failed' : ''}`;
  if (!failed) {
    const spin = document.createElement('div');
    spin.className = 'spinner';
    card.appendChild(spin);
  }
  const body = document.createElement('div');
  body.className = 'job-card-text';
  body.textContent = failed ? t('jobs.failed', { id: job.assetId }) : t('jobs.running', { id: job.assetId });
  const small = document.createElement('small');
  small.textContent = failed ? job.error || t('jobs.unknownError') : t('jobs.duration');
  body.appendChild(small);
  card.appendChild(body);
  return card;
}

function chip(label, spinning, isError) {
  const wrap = document.createElement('div');
  wrap.className = `chip${isError ? ' error' : ''}`;
  if (spinning) {
    const spin = document.createElement('div');
    spin.className = 'spinner';
    wrap.appendChild(spin);
  }
  const text = document.createElement('span');
  text.textContent = label;
  wrap.appendChild(text);
  return wrap;
}

function messageShell(role) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'role';
    label.textContent = t('messages.assistantLabel');
    wrap.appendChild(label);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.appendChild(bubble);
  return { wrap, bubble };
}

/* ---------- rendering ---------- */

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }
  return '';
}

function toolLabel(message) {
  if (message.name === 'generate_image') return t('tools.imageGenerated');
  if (message.name === 'edit_image') return t('tools.imageEdited');
  if (message.name === 'generate_video') return t('tools.videoStarted');
  if (message.name === 'higgsfield_generate_image') return t('tools.higgsfieldImageStarted');
  if (message.name === 'higgsfield_generate_video') return t('tools.higgsfieldVideoStarted');
  if (message.name === 'higgsfield_models') return t('tools.higgsfieldModelsLoaded');
  if (message.name === 'higgsfield_check_balance') return t('tools.higgsfieldBalanceLoaded');
  if (message.name === 'generate_speech') return t('tools.speechGenerated');
  if (message.name === 'list_voices') return t('tools.voicesLoaded');
  if (message.name === 'render_motion_graphics') return t('tools.motionRendered');
  return t('tools.actionDone');
}

const IMAGE_ATTACHMENT_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const AUDIO_ATTACHMENT_EXTENSION = /\.(mp3|wav|m4a|aac)$/i;
const FONT_ATTACHMENT_EXTENSION = /\.(ttf|otf|woff2?)$/i;

function attachmentFileName({ name, url } = {}) {
  if (String(name || '').trim()) return String(name).trim();
  const path = String(url || '').split(/[?#]/, 1)[0];
  const encodedName = path.split('/').filter(Boolean).pop() || '';
  if (!encodedName) return t('files.generic');
  try {
    return decodeURIComponent(encodedName);
  } catch (_) {
    return encodedName;
  }
}

function shortenedFileName(name, maxLength = 18) {
  const characters = [...String(name || t('files.generic'))];
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join('')}…` : characters.join('');
}

function attachmentPreviewNode({ name, dataUrl, url, lightbox = false } = {}) {
  const fileName = attachmentFileName({ name, url });
  const cleanUrl = String(url || '').split(/[?#]/, 1)[0];
  const isImage = String(dataUrl || '').startsWith('data:image/') || IMAGE_ATTACHMENT_EXTENSION.test(cleanUrl);
  const isAudio = String(dataUrl || '').startsWith('data:audio/') || AUDIO_ATTACHMENT_EXTENSION.test(cleanUrl || fileName);
  const source = dataUrl || (url ? rel(url) : '');

  if (isImage && source) {
    const img = document.createElement('img');
    img.src = source;
    img.alt = fileName;
    if (lightbox) img.addEventListener('click', () => openLightbox(source));
    return img;
  }

  if (isAudio && url && source) {
    const audio = document.createElement('audio');
    audio.className = 'upload-audio';
    audio.controls = true;
    audio.preload = 'none';
    audio.src = source;
    audio.title = fileName;
    return audio;
  }

  const label = document.createElement('span');
  label.className = 'thumb-file';
  const icon = isAudio ? '🎵' : FONT_ATTACHMENT_EXTENSION.test(fileName) ? '🔤' : '📄';
  label.textContent = `${icon} ${shortenedFileName(fileName)}`;
  label.title = fileName;
  return label;
}

function renderDetail() {
  const detail = state.detail;
  el.messages.innerHTML = '';
  if (!detail) return;

  const assetMap = new Map((detail.assets || []).map((a) => [a.id, a]));
  const jobMap = new Map((detail.jobs || []).map((j) => [j.assetId, j]));
  const visible = (detail.session.messages || []).filter((m) => !m.hidden);

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('h2');
    title.textContent = t('empty.title');
    const body = document.createElement('p');
    body.textContent = t('empty.body');
    empty.append(title, body);
    el.messages.appendChild(empty);
    return;
  }

  for (const message of visible) {
    if (message.role === 'user') {
      const { wrap, bubble } = messageShell('user');
      if (Array.isArray(message.uploadIds) && message.uploadIds.length) {
        const row = document.createElement('div');
        row.className = 'upload-row';
        for (const id of message.uploadIds) {
          const asset = assetMap.get(id);
          if (!asset) continue;
          const originalName = /^Upload:\s*(.+)$/.exec(String(asset.prompt || ''))?.[1];
          row.appendChild(attachmentPreviewNode({ name: originalName || asset.file, url: asset.url, lightbox: true }));
        }
        wrap.insertBefore(row, bubble);
      }
      const text = textFromContent(message.content)
        .split('\n')
        .filter((line) => !/^Hochgeladene\S* .*gespeichert als Asset /.test(line))
        .join('\n');
      bubble.innerHTML = renderMarkdown(text);
      el.messages.appendChild(wrap);
      continue;
    }

    if (message.role === 'assistant') {
      const text = textFromContent(message.content);
      if (!text.trim()) continue;
      const { wrap, bubble } = messageShell('assistant');
      bubble.innerHTML = renderMarkdown(text);
      el.messages.appendChild(wrap);
      continue;
    }

    if (message.role === 'tool') {
      const wrap = document.createElement('div');
      wrap.className = 'msg tool';
      const failed = /^Fehler bei /.test(String(message.content || ''));
      wrap.appendChild(chip(failed ? String(message.content).slice(0, 200) : toolLabel(message), false, failed));

      const grid = document.createElement('div');
      grid.className = 'asset-grid';
      for (const ref of message.assets || []) {
        const asset = assetMap.get(ref.id) || ref;
        grid.appendChild(mediaCard(asset));
      }
      if (message.job) {
        const job = jobMap.get(message.job.assetId);
        const asset = assetMap.get(message.job.assetId);
        if (job && job.status === 'completed' && job.url) {
          grid.appendChild(mediaCard({
            id: job.assetId,
            kind: job.kind || asset?.kind || 'video',
            url: rel(job.url),
            cost: job.cost ?? asset?.cost ?? null,
            prompt: job.prompt
          }));
          for (const resultAssetId of job.resultAssetIds || []) {
            if (resultAssetId === job.assetId) continue;
            const resultAsset = assetMap.get(resultAssetId);
            if (resultAsset) grid.appendChild(mediaCard(resultAsset));
          }
        } else if (job) {
          grid.appendChild(jobCard(job));
        }
      }
      if (grid.children.length) wrap.appendChild(grid);
      el.messages.appendChild(wrap);
    }
  }
  scrollDown();
}

/* ---------- Kosten ---------- */

const COST_TYPE_KEYS = {
  image: 'costs.images',
  video: 'costs.videos',
  motion: 'costs.motion',
  brain: 'costs.brain',
  higgsfield: 'costs.higgsfield'
};

function monthLabel(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) return String(month || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function costOverviewItem(label, value) {
  const item = document.createElement('div');
  item.className = 'cost-overview-item';
  item.appendChild(textNode('div', 'cost-overview-label', label));
  item.appendChild(textNode('div', 'cost-overview-value', formatSummaryCost(value)));
  return item;
}

function costTable(title, columns, rows) {
  const section = document.createElement('section');
  section.className = 'cost-section';
  section.appendChild(textNode('h3', 'cost-section-title', title));

  if (!rows.length) {
    section.appendChild(textNode('div', 'cost-empty', t('costs.noData')));
    return section;
  }

  const wrap = document.createElement('div');
  wrap.className = 'cost-table-wrap';
  const table = document.createElement('table');
  table.className = 'cost-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) headRow.appendChild(textNode('th', '', column));
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    for (const value of values) row.appendChild(textNode('td', '', value));
    body.appendChild(row);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

function renderCosts(summary) {
  const data = summary || {
    total: 0,
    currentMonth: 0,
    currentWeek: 0,
    byMonth: [],
    byUser: [],
    byType: [],
    bySession: []
  };
  el.costsBtn.textContent = formatSummaryCost(data.currentMonth);
  el.costsBody.replaceChildren();

  const overview = document.createElement('div');
  overview.className = 'cost-overview';
  overview.appendChild(costOverviewItem(t('costs.currentMonth'), data.currentMonth));
  overview.appendChild(costOverviewItem(t('costs.currentWeek'), data.currentWeek));
  overview.appendChild(costOverviewItem(t('costs.total'), data.total));
  el.costsBody.appendChild(overview);

  el.costsBody.appendChild(
    costTable(t('costs.byMonth'), [t('costs.month'), t('costs.cost')], (data.byMonth || []).map((row) => [monthLabel(row.month), formatSummaryCost(row.total)]))
  );
  el.costsBody.appendChild(
    costTable(t('costs.byUser'), [t('costs.user'), t('costs.cost')], (data.byUser || []).map((row) => [row.user, formatSummaryCost(row.total)]))
  );
  el.costsBody.appendChild(
    costTable(
      t('costs.byType'),
      [t('costs.type'), t('costs.count'), t('costs.cost')],
      (data.byType || []).map((row) => [COST_TYPE_KEYS[row.type] ? t(COST_TYPE_KEYS[row.type]) : row.type, String(row.count), formatSummaryCost(row.total)])
    )
  );
  el.costsBody.appendChild(
    costTable(
      t('costs.topSessions'),
      [t('costs.session'), 'ID', t('costs.cost')],
      (data.bySession || []).map((row) => [row.title || t('costs.untitled'), row.sessionId, formatSummaryCost(row.total)])
    )
  );
}

async function refreshCosts() {
  const summary = await api('/api/costs/summary');
  state.costs = summary;
  renderCosts(summary);
}

function openCostsModal() {
  el.costsModal.classList.remove('hidden');
  renderCosts(state.costs);
  refreshCosts().catch((err) => setStatusI18n('costs.loadError', { error: err.message }));
}

function closeCostsModal() {
  el.costsModal.classList.add('hidden');
}

/* ---------- Einstellungen ---------- */

function showSettingsFeedback(message, { error = false } = {}) {
  el.settingsFeedback.textContent = message || '';
  el.settingsFeedback.classList.toggle('hidden', !message);
  el.settingsFeedback.classList.toggle('error', Boolean(message && error));
}

function resetSettingsDelete() {
  if (state.settingsDeleteTimer) clearTimeout(state.settingsDeleteTimer);
  state.settingsDeleteTimer = null;
  state.pendingSettingsDeleteName = null;
  for (const button of el.settingsList.querySelectorAll('[data-settings-delete]')) {
    button.textContent = t('common.delete');
  }
}

function resetRenderNodeDelete() {
  if (state.renderNodeDeleteTimer) clearTimeout(state.renderNodeDeleteTimer);
  state.renderNodeDeleteTimer = null;
  state.pendingRenderNodeDeleteId = null;
  for (const button of el.renderNodesList.querySelectorAll('[data-render-node-delete]')) {
    button.textContent = t('common.delete');
  }
}

function resetHiggsfieldDisconnect() {
  if (state.higgsfieldDisconnectTimer) clearTimeout(state.higgsfieldDisconnectTimer);
  state.higgsfieldDisconnectTimer = null;
  state.higgsfieldDisconnectPending = false;
  el.higgsfieldDisconnect.textContent = t('higgsfield.disconnect');
}

function stopHiggsfieldPolling() {
  if (state.higgsfieldPollTimer) clearTimeout(state.higgsfieldPollTimer);
  state.higgsfieldPollTimer = null;
  state.higgsfieldPollExpiresAt = 0;
}

function renderHiggsfieldStatus() {
  const status = state.higgsfield || {};
  const connected = Boolean(status.connected);
  el.higgsfieldStatusDot.classList.toggle('connected', connected);
  if (connected) {
    const credits = Number.isFinite(Number(status.balance?.credits))
      ? t('higgsfield.credits', { credits: status.balance.credits })
      : '';
    const plan = status.balance?.plan ? t('higgsfield.plan', { plan: status.balance.plan }) : '';
    el.higgsfieldStatusText.textContent = [t('higgsfield.connected'), credits, plan].filter(Boolean).join(' · ');
  } else if (status.pending) {
    el.higgsfieldStatusText.textContent = t('higgsfield.pending');
  } else {
    el.higgsfieldStatusText.textContent = t('higgsfield.disconnected');
  }
  el.higgsfieldConnect.classList.toggle('hidden', connected);
  el.higgsfieldDisconnect.classList.toggle('hidden', !connected);
  el.higgsfieldConnect.disabled = false;
  if (connected) el.higgsfieldVerification.classList.add('hidden');
}

async function refreshHiggsfieldStatus() {
  const status = await api('/api/higgsfield/status');
  state.higgsfield = status;
  renderHiggsfieldStatus();
  if (status.connected) {
    stopHiggsfieldPolling();
    showSettingsFeedback(t('higgsfield.connectedFeedback'));
  }
  return status;
}

function scheduleHiggsfieldPolling(delay = 3000) {
  if (state.higgsfieldPollTimer) clearTimeout(state.higgsfieldPollTimer);
  state.higgsfieldPollTimer = setTimeout(async () => {
    state.higgsfieldPollTimer = null;
    if (Date.now() >= state.higgsfieldPollExpiresAt) {
      state.higgsfield = { ...state.higgsfield, pending: false };
      renderHiggsfieldStatus();
      showSettingsFeedback(t('higgsfield.connectExpired'), { error: true });
      stopHiggsfieldPolling();
      return;
    }
    try {
      const status = await refreshHiggsfieldStatus();
      if (!status.connected && (status.pending || Date.now() < state.higgsfieldPollExpiresAt)) scheduleHiggsfieldPolling(3000);
    } catch (_) {
      scheduleHiggsfieldPolling(3000);
    }
  }, delay);
}

async function connectHiggsfield() {
  resetHiggsfieldDisconnect();
  el.higgsfieldConnect.disabled = true;
  showSettingsFeedback('');
  try {
    const result = await api('/api/higgsfield/connect', { method: 'POST', body: '{}' });
    el.higgsfieldVerificationLink.href = result.verificationUri;
    el.higgsfieldVerification.classList.remove('hidden');
    state.higgsfield = { ...state.higgsfield, connected: false, pending: true };
    state.higgsfieldPollExpiresAt = Date.now() + Math.min(15 * 60 * 1000, Math.max(1, Number(result.expiresIn) || 900) * 1000);
    renderHiggsfieldStatus();
    scheduleHiggsfieldPolling(3000);
  } catch (err) {
    state.higgsfield = { ...state.higgsfield, pending: false };
    renderHiggsfieldStatus();
    showSettingsFeedback(t('higgsfield.connectFailed', { error: err.message }), { error: true });
  }
}

async function disconnectHiggsfield() {
  if (!state.higgsfieldDisconnectPending) {
    resetHiggsfieldDisconnect();
    state.higgsfieldDisconnectPending = true;
    el.higgsfieldDisconnect.textContent = t('higgsfield.reallyDisconnect');
    state.higgsfieldDisconnectTimer = setTimeout(resetHiggsfieldDisconnect, 3000);
    return;
  }
  el.higgsfieldDisconnect.disabled = true;
  showSettingsFeedback('');
  try {
    state.higgsfield = await api('/api/higgsfield/auth', { method: 'DELETE' });
    stopHiggsfieldPolling();
    resetHiggsfieldDisconnect();
    el.higgsfieldVerification.classList.add('hidden');
    renderHiggsfieldStatus();
    showSettingsFeedback(t('higgsfield.disconnectedFeedback'));
  } catch (err) {
    showSettingsFeedback(t('higgsfield.disconnectFailed', { error: err.message }), { error: true });
  } finally {
    el.higgsfieldDisconnect.disabled = false;
  }
}

function settingsStatusText(key) {
  if (key.source === 'settings') return t('settings.set', { masked: key.masked });
  if (key.source === 'env') return t('settings.fromEnv', { masked: key.masked });
  return t('settings.notSet');
}

function setSettingsBusy(row, busy) {
  for (const control of row.querySelectorAll('input, button')) control.disabled = busy;
}

async function refreshRuntimeConfigStatus() {
  const config = await api('/api/config');
  state.config = { ...state.config, ...config };
  el.keyBanner.classList.toggle('hidden', Boolean(state.config.hasKey));
  el.contextGtsSection.classList.toggle('hidden', !gtsEnabled());
  el.folderProfileGtsSection.classList.toggle('hidden', !gtsEnabled());
  scheduleRenderNodePolling(0);
}

async function saveSetting(name, value, row, input) {
  if (!value.trim()) {
    showSettingsFeedback(t('settings.enterValue'), { error: true });
    input.focus();
    return;
  }
  setSettingsBusy(row, true);
  showSettingsFeedback('');
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ name, value })
    });
    state.settings = Array.isArray(data.keys) ? data.keys : [];
    input.value = '';
    resetSettingsDelete();
    renderSettings();
    showSettingsFeedback(t('settings.saved', { name }));
    refreshRuntimeConfigStatus().catch(() => {});
  } catch (err) {
    showSettingsFeedback(t('settings.saveFailed', { error: err.message }), { error: true });
    setSettingsBusy(row, false);
  }
}

async function deleteSetting(name, row) {
  setSettingsBusy(row, true);
  showSettingsFeedback('');
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ name, value: '' })
    });
    state.settings = Array.isArray(data.keys) ? data.keys : [];
    resetSettingsDelete();
    renderSettings();
    showSettingsFeedback(t('settings.deleted', { name }));
    refreshRuntimeConfigStatus().catch(() => {});
  } catch (err) {
    showSettingsFeedback(t('settings.deleteFailed', { error: err.message }), { error: true });
    setSettingsBusy(row, false);
  }
}

function renderSettings() {
  el.settingsList.innerHTML = '';
  for (const key of state.settings) {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const copy = document.createElement('div');
    copy.className = 'settings-key-copy';
    const inputId = `settingsInput-${key.name}`;
    const label = document.createElement('label');
    label.className = 'settings-key-name';
    label.htmlFor = inputId;
    label.textContent = key.name;
    copy.appendChild(label);
    const status = document.createElement('div');
    status.className = `settings-key-status${key.source === 'settings' ? ' is-set' : ''}`;
    status.textContent = settingsStatusText(key);
    copy.appendChild(status);
    row.appendChild(copy);

    const input = document.createElement('input');
    input.id = inputId;
    input.className = 'settings-input';
    input.type = 'password';
    input.maxLength = 500;
    input.placeholder = t('settings.newValue');
    input.autocomplete = 'new-password';
    row.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const save = managerAction(t('common.save'), () => saveSetting(key.name, input.value, row, input));
    actions.appendChild(save);
    if (key.source === 'settings') {
      const remove = managerAction(t('common.delete'), () => {
        if (state.pendingSettingsDeleteName !== key.name) {
          resetSettingsDelete();
          state.pendingSettingsDeleteName = key.name;
          remove.textContent = t('common.reallyDelete');
          state.settingsDeleteTimer = setTimeout(resetSettingsDelete, 3000);
          return;
        }
        deleteSetting(key.name, row);
      }, { danger: true });
      remove.dataset.settingsDelete = key.name;
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    el.settingsList.appendChild(row);
  }
}

function resetAdminDelete() {
  if (state.adminDeleteTimer) clearTimeout(state.adminDeleteTimer);
  state.adminDeleteTimer = null;
  state.pendingAdminDeleteEmail = null;
  for (const button of el.adminsList.querySelectorAll('[data-admin-delete]')) {
    button.textContent = t('common.delete');
  }
}

function renderAdmins() {
  el.adminsList.replaceChildren();
  for (const admin of state.admins) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const email = document.createElement('span');
    email.className = 'admin-email';
    email.textContent = admin.email;
    row.appendChild(email);
    if (admin.source === 'env') {
      const badge = document.createElement('span');
      badge.className = 'admin-source-badge';
      badge.textContent = t('admins.fromEnv');
      row.appendChild(badge);
    } else {
      const remove = managerAction(t('common.delete'), () => deleteAdmin(admin.email, remove), { danger: true });
      remove.dataset.adminDelete = admin.email;
      row.appendChild(remove);
    }
    el.adminsList.appendChild(row);
  }
}

async function addAdmin() {
  el.adminAdd.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api('/api/admins', {
      method: 'POST',
      body: JSON.stringify({ email: el.adminEmail.value })
    });
    state.admins = Array.isArray(data.admins) ? data.admins : [];
    el.adminForm.reset();
    resetAdminDelete();
    renderAdmins();
    showSettingsFeedback(t('admins.added'));
    el.adminEmail.focus();
  } catch (err) {
    showSettingsFeedback(t('admins.addFailed', { error: err.message }), { error: true });
  } finally {
    el.adminAdd.disabled = false;
  }
}

async function deleteAdmin(email, button) {
  if (state.pendingAdminDeleteEmail !== email) {
    resetAdminDelete();
    state.pendingAdminDeleteEmail = email;
    button.textContent = t('common.reallyDelete');
    state.adminDeleteTimer = setTimeout(resetAdminDelete, 3000);
    return;
  }
  button.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api(`/api/admins/${encodeURIComponent(email)}`, { method: 'DELETE' });
    state.admins = Array.isArray(data.admins) ? data.admins : [];
    resetAdminDelete();
    renderAdmins();
    showSettingsFeedback(t('admins.deleted'));
  } catch (err) {
    button.disabled = false;
    showSettingsFeedback(t('admins.deleteFailed', { error: err.message }), { error: true });
  }
}

function renderNodeManagerStatus(node) {
  if (!node.enabled) return t('renderNodes.statusDisabled');
  if (node.online && (node.running || Number(node.queue) > 0)) return t('renderNodes.statusRendering');
  if (node.online) return t('renderNodes.statusOnline');
  return t('renderNodes.statusOffline');
}

function setRenderNodeRowBusy(row, busy) {
  for (const control of row.querySelectorAll('input, button')) control.disabled = busy;
}

async function updateRenderNode(id, patch, row) {
  setRenderNodeRowBusy(row, true);
  showSettingsFeedback('');
  try {
    const data = await api(`/api/rendernodes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
    state.renderNodes = Array.isArray(data.nodes) ? data.nodes : [];
    resetRenderNodeDelete();
    renderRenderNodes();
    showSettingsFeedback(t('renderNodes.updated'));
    scheduleRenderNodePolling(0);
  } catch (err) {
    showSettingsFeedback(t('renderNodes.updateFailed', { error: err.message }), { error: true });
    setRenderNodeRowBusy(row, false);
    renderRenderNodes();
  }
}

async function deleteRenderNode(id, row) {
  setRenderNodeRowBusy(row, true);
  showSettingsFeedback('');
  try {
    const data = await api(`/api/rendernodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.renderNodes = Array.isArray(data.nodes) ? data.nodes : [];
    resetRenderNodeDelete();
    renderRenderNodes();
    showSettingsFeedback(t('renderNodes.deleted'));
    scheduleRenderNodePolling(0);
  } catch (err) {
    showSettingsFeedback(t('renderNodes.deleteFailed', { error: err.message }), { error: true });
    setRenderNodeRowBusy(row, false);
  }
}

function renderRenderNodes() {
  el.renderNodesList.replaceChildren();
  if (state.renderNodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'render-nodes-empty';
    empty.textContent = t('renderNodes.empty');
    el.renderNodesList.appendChild(empty);
    return;
  }

  for (const node of state.renderNodes) {
    const row = document.createElement('div');
    row.className = 'render-node-manager-row';

    const statusDot = document.createElement('span');
    statusDot.className = 'render-node-manager-dot';
    if (node.enabled && node.online) statusDot.classList.add(node.running || Number(node.queue) > 0 ? 'rendering' : 'online');
    statusDot.title = renderNodeManagerStatus(node);
    row.appendChild(statusDot);

    const copy = document.createElement('div');
    copy.className = 'render-node-manager-copy';
    const name = document.createElement('div');
    name.className = 'render-node-manager-name';
    name.textContent = node.name;
    copy.appendChild(name);
    const url = document.createElement('div');
    url.className = 'render-node-manager-url';
    url.textContent = node.url;
    url.title = node.url;
    copy.appendChild(url);
    const meta = document.createElement('div');
    meta.className = 'render-node-manager-meta';
    const token = t('renderNodes.tokenMasked', { masked: node.token || t('settings.notSet') });
    meta.textContent = `${renderNodeManagerStatus(node)} · ${token}${node.implicit ? ` · ${t('renderNodes.implicit')}` : ''}`;
    copy.appendChild(meta);
    row.appendChild(copy);

    const toggle = document.createElement('label');
    toggle.className = 'render-node-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(node.enabled);
    checkbox.disabled = Boolean(node.implicit);
    checkbox.setAttribute('aria-label', t('renderNodes.toggleAria', { name: node.name }));
    checkbox.addEventListener('change', () => updateRenderNode(node.id, { enabled: checkbox.checked }, row));
    toggle.appendChild(checkbox);
    const toggleText = document.createElement('span');
    toggleText.textContent = node.enabled ? t('renderNodes.enabled') : t('renderNodes.disabled');
    toggle.appendChild(toggleText);
    row.appendChild(toggle);

    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    if (!node.implicit) {
      const remove = managerAction(t('common.delete'), () => {
        if (state.pendingRenderNodeDeleteId !== node.id) {
          resetRenderNodeDelete();
          state.pendingRenderNodeDeleteId = node.id;
          remove.textContent = t('common.reallyDelete');
          state.renderNodeDeleteTimer = setTimeout(resetRenderNodeDelete, 3000);
          return;
        }
        deleteRenderNode(node.id, row);
      }, { danger: true });
      remove.dataset.renderNodeDelete = node.id;
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    el.renderNodesList.appendChild(row);
  }
}

async function addRenderNode() {
  const body = {
    name: el.renderNodeName.value,
    url: el.renderNodeUrl.value,
    token: el.renderNodeToken.value
  };
  el.renderNodeAdd.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api('/api/rendernodes', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    state.renderNodes = Array.isArray(data.nodes) ? data.nodes : [];
    el.renderNodeForm.reset();
    resetRenderNodeDelete();
    renderRenderNodes();
    showSettingsFeedback(t('renderNodes.added'));
    scheduleRenderNodePolling(0);
    el.renderNodeName.focus();
  } catch (err) {
    showSettingsFeedback(t('renderNodes.addFailed', { error: err.message }), { error: true });
  } finally {
    el.renderNodeAdd.disabled = false;
  }
}

async function loadSettingsAccess() {
  try {
    const [settingsData, adminsData, renderNodesData, higgsfieldData] = await Promise.all([
      api('/api/settings'),
      api('/api/admins'),
      api('/api/rendernodes'),
      api('/api/higgsfield/status')
    ]);
    state.settings = Array.isArray(settingsData.keys) ? settingsData.keys : [];
    state.admins = Array.isArray(adminsData.admins) ? adminsData.admins : [];
    state.renderNodes = Array.isArray(renderNodesData.nodes) ? renderNodesData.nodes : [];
    state.higgsfield = higgsfieldData;
    el.settingsBtn.classList.remove('hidden');
    renderSettings();
    renderAdmins();
    renderRenderNodes();
    renderHiggsfieldStatus();
    return true;
  } catch (_) {
    state.settings = [];
    state.admins = [];
    state.renderNodes = [];
    state.higgsfield = { connected: false, refreshExpiresAt: null, pending: false };
    el.settingsBtn.classList.add('hidden');
    el.settingsModal.classList.add('hidden');
    return false;
  }
}

async function openSettingsModal() {
  resetSettingsDelete();
  resetAdminDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  showSettingsFeedback('');
  renderSettings();
  renderAdmins();
  renderRenderNodes();
  renderHiggsfieldStatus();
  el.settingsModal.classList.remove('hidden');
  const available = await loadSettingsAccess();
  if (available) el.settingsList.querySelector('input')?.focus();
}

function closeSettingsModal() {
  resetSettingsDelete();
  resetAdminDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  showSettingsFeedback('');
  el.settingsModal.classList.add('hidden');
}

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

function existingFolders() {
  return [...new Set([...state.folders.map((folder) => folder.name), ...state.sessions.map(sessionFolder).filter(Boolean)])].sort((a, b) =>
    a.localeCompare(b, 'de-CH', { sensitivity: 'base' })
  );
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
  if (state.currentId === meta.id && state.detail?.session) {
    Object.assign(state.detail.session, data.session);
    el.sessionTitle.textContent = state.detail.session.title || '';
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

function createSessionItem(meta) {
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
  item.appendChild(actions);

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

  item.addEventListener('click', () => {
    if (state.streaming || meta.id === state.currentId) return;
    openSession(meta.id);
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
    openFolderProfileModal(folder).catch((err) => setStatus(err.message));
  });
  header.appendChild(profile);

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

function renderSessions() {
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
    more.textContent = t('sessions.loadMore');
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        await loadMoreSessions();
      } catch (err) {
        setStatus(err.message);
        more.disabled = false;
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
  return `/api/sessions?${parts.join('&')}`;
}

async function loadSessions() {
  const [data] = await Promise.all([api(sessionsPath(0)), loadFolders()]);
  state.sessions = data.sessions || [];
  state.sessionTotal = data.total || 0;
  state.sessionLoadedCount = state.sessions.length;
  state.sessionHasMore = Boolean(data.hasMore);
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

async function createSession(folder = null) {
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
    state.sessions.unshift({
      id,
      title: detail.session.title,
      folder: detail.session.folder || null,
      createdAt: detail.session.createdAt,
      updatedAt: detail.session.updatedAt
    });
  }
  setSessionHash(id);
  el.sessionTitle.textContent = state.detail.session.title || '';
  renderSessions();
  renderDetail();
  renderToolsMenu();
  scheduleJobPolling();
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
  el.sessionTitle.textContent = state.detail.session.title || '';
  renderDetail();
  renderContextBadge();
  renderToolsMenu();
  await loadCurrentFolderProfile().catch((err) => setStatus(err.message));
  scheduleJobPolling();
  state.liveRenderNodeJob = false;
  scheduleRenderNodePolling(0);
}

/* ---------- Brandings ---------- */

function brandingById(id) {
  return state.brandings.find((branding) => branding.id === id) || null;
}

function sessionBrandingIds() {
  return Array.isArray(state.detail?.session?.brandings) ? state.detail.session.brandings.slice(0, 2) : [];
}

function projectBrandingIds() {
  return Array.isArray(state.currentFolderProfile?.brandings) ? state.currentFolderProfile.brandings.slice(0, 2) : [];
}

function effectiveBrandingIds() {
  const ids = [];
  for (const id of [...sessionBrandingIds(), ...projectBrandingIds()]) {
    if (!ids.includes(id)) ids.push(id);
    if (ids.length === 2) break;
  }
  return ids.filter((id) => brandingById(id));
}

function brandingDots(colors) {
  const dots = document.createElement('span');
  dots.className = 'branding-dots';
  for (const color of (Array.isArray(colors) ? colors : []).slice(0, 8)) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) continue;
    const dot = document.createElement('span');
    dot.className = 'branding-color-dot';
    dot.style.backgroundColor = color;
    dot.title = color.toUpperCase();
    dots.appendChild(dot);
  }
  return dots;
}

function attachedBrandingRow(branding, { inherited = false, onRemove = null } = {}) {
  const row = document.createElement('div');
  row.className = 'branding-attachment';

  const body = document.createElement('div');
  body.className = 'branding-attachment-body';
  const name = document.createElement('div');
  name.className = 'branding-attachment-name';
  name.textContent = branding.name;
  body.appendChild(name);
  body.appendChild(brandingDots(branding.colors));
  row.appendChild(body);

  if (inherited) {
    const source = document.createElement('span');
    source.className = 'branding-source';
    source.textContent = t('branding.viaProject');
    row.appendChild(source);
  } else if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'branding-remove';
    remove.textContent = '×';
    remove.title = t('branding.remove');
    remove.setAttribute('aria-label', `${branding.name}: ${t('common.remove')}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await onRemove();
      } catch (err) {
        setStatus(err.message);
        remove.disabled = false;
      }
    });
    row.appendChild(remove);
  }
  return row;
}

function fillBrandingSelect(select, excludedIds, placeholder) {
  select.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  const excluded = new Set(excludedIds);
  for (const branding of state.brandings) {
    if (excluded.has(branding.id)) continue;
    const option = document.createElement('option');
    option.value = branding.id;
    option.textContent = branding.name;
    select.appendChild(option);
  }
  select.value = '';
}

function renderContextBrandings() {
  el.contextBrandings.innerHTML = '';
  const sessionIds = sessionBrandingIds();
  const projectIds = projectBrandingIds().filter((id) => !sessionIds.includes(id));
  let shown = 0;
  for (const id of sessionIds) {
    const branding = brandingById(id) || { id, name: t('branding.missing'), colors: [] };
    shown += 1;
    el.contextBrandings.appendChild(attachedBrandingRow(branding, { onRemove: () => detachBrandingFromSession(id) }));
  }
  for (const id of projectIds) {
    const branding = brandingById(id) || { id, name: t('branding.missing'), colors: [] };
    shown += 1;
    el.contextBrandings.appendChild(attachedBrandingRow(branding, { inherited: true }));
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('branding.noneAttached');
    el.contextBrandings.appendChild(empty);
  }

  fillBrandingSelect(el.contextBrandingSelect, [...sessionIds, ...projectIds], t('context.attachBranding'));
  const available = el.contextBrandingSelect.options.length > 1;
  el.contextBrandingSelect.disabled = !state.currentId || sessionIds.length >= 2 || !available;
  if (sessionIds.length >= 2) {
    el.contextBrandingHint.textContent = t('branding.maxChat');
  } else if (!state.brandings.length) {
    el.contextBrandingHint.textContent = t('branding.none');
  } else {
    el.contextBrandingHint.textContent = projectIds.length ? t('branding.projectInherited') : '';
  }
}

function renderProfileBrandings() {
  el.folderProfileBrandings.innerHTML = '';
  for (const id of state.profileBrandingIds) {
    const branding = brandingById(id) || { id, name: t('branding.missing'), colors: [] };
    el.folderProfileBrandings.appendChild(
      attachedBrandingRow(branding, {
        onRemove: async () => {
          state.profileBrandingIds = state.profileBrandingIds.filter((brandingId) => brandingId !== id);
          renderProfileBrandings();
        }
      })
    );
  }
  if (!el.folderProfileBrandings.children.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('branding.noneAttached');
    el.folderProfileBrandings.appendChild(empty);
  }
  fillBrandingSelect(el.folderProfileBrandingSelect, state.profileBrandingIds, t('context.attachBranding'));
  const available = el.folderProfileBrandingSelect.options.length > 1;
  el.folderProfileBrandingSelect.disabled = state.profileBrandingIds.length >= 2 || !available;
  el.folderProfileBrandingHint.textContent = state.profileBrandingIds.length >= 2
    ? t('branding.maxProject')
    : t('branding.projectInheritance');
}

function profileHasContent(profile) {
  return Boolean(
    profile?.guidelines || profile?.contextBrains?.length || profile?.brandings?.length ||
    profile?.contextFiles?.length || profile?.cast?.length || profile?.memory?.length
  );
}

async function deleteProfileCastMember(member) {
  if (!window.confirm(t('cast.deleteConfirm', { name: member.name }))) return;
  const folder = state.profileFolder;
  try {
    await api(`/api/cast/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    state.profileCast = state.profileCast.filter((entry) => entry.id !== member.id);
    const stored = state.folderProfiles.get(folder);
    const nextProfile = stored && typeof stored === 'object'
      ? { ...stored, cast: state.profileCast.map((entry) => entry.id) }
      : null;
    const effectiveProfile = profileHasContent(nextProfile) ? nextProfile : null;
    state.folderProfiles.set(folder, effectiveProfile);
    const info = folderInfo(folder);
    if (info) info.hasProfile = Boolean(effectiveProfile);
    if (state.detail?.session?.folder === folder) state.currentFolderProfile = effectiveProfile;
    renderProfileCast();
    renderSessions();
    setStatusI18n('cast.deleted', { name: member.name });
  } catch (err) {
    showProfileError(err.message);
  }
}

function renderProfileCast() {
  el.folderProfileCast.replaceChildren();
  for (const member of state.profileCast) {
    const row = document.createElement('div');
    row.className = 'cast-item';
    const body = document.createElement('div');
    body.className = 'cast-item-body';
    const name = document.createElement('div');
    name.className = 'cast-item-name';
    name.textContent = member.name;
    const soul = document.createElement('div');
    soul.className = 'cast-item-soul';
    soul.textContent = member.soul || t('cast.noSoul');
    const meta = document.createElement('div');
    meta.className = 'cast-item-meta';
    meta.textContent = t('cast.meta', { n: Array.isArray(member.images) ? member.images.length : 0, voice: member.voice ? '✓' : '—' });
    body.append(name, soul, meta);
    const remove = document.createElement('button');
    remove.className = 'cast-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = t('cast.delete', { name: member.name });
    remove.setAttribute('aria-label', t('cast.delete', { name: member.name }));
    remove.addEventListener('click', () => deleteProfileCastMember(member));
    row.append(body, remove);
    el.folderProfileCast.appendChild(row);
  }
  if (!state.profileCast.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('cast.none');
    el.folderProfileCast.appendChild(empty);
  }
}

function resetProjectMemoryDelete() {
  if (state.projectMemoryDeleteTimer) clearTimeout(state.projectMemoryDeleteTimer);
  state.projectMemoryDeleteTimer = null;
  state.pendingProjectMemoryDeleteId = null;
  for (const button of el.folderProfileMemory.querySelectorAll('[data-project-memory-delete]')) {
    button.textContent = t('common.delete');
  }
}

function shortProjectMemoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const locale = { de: 'de-CH', en: 'en-GB', es: 'es-ES' }[getLang()] || 'de-CH';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

async function deleteProjectMemory(id, row) {
  const folder = state.profileFolder;
  if (!folder) return;
  for (const button of row.querySelectorAll('button')) button.disabled = true;
  showProfileError('');
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const profile = data.profile || null;
    state.profileMemory = Array.isArray(profile?.memory) ? profile.memory : [];
    state.folderProfiles.set(folder, profile);
    const info = folderInfo(folder);
    if (info) info.hasProfile = Boolean(profile);
    if (state.detail?.session?.folder === folder) state.currentFolderProfile = profile;
    renderProjectMemory();
    renderSessions();
    setStatusI18n('profile.memoryDeleted');
  } catch (err) {
    showProfileError(err.message);
    for (const button of row.querySelectorAll('button')) button.disabled = false;
  }
}

function renderProjectMemory() {
  resetProjectMemoryDelete();
  el.folderProfileMemory.replaceChildren();
  if (!state.profileMemory.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('profile.memoryEmpty');
    el.folderProfileMemory.appendChild(empty);
    return;
  }
  for (const entry of state.profileMemory) {
    const row = document.createElement('div');
    row.className = 'project-memory-item';
    const body = document.createElement('div');
    body.className = 'project-memory-body';
    const note = document.createElement('div');
    note.className = 'project-memory-note';
    note.textContent = entry.note;
    const date = document.createElement('div');
    date.className = 'project-memory-date';
    date.textContent = shortProjectMemoryDate(entry.createdAt);
    body.append(note, date);
    const remove = managerAction(t('common.delete'), () => {
      if (state.pendingProjectMemoryDeleteId !== entry.id) {
        resetProjectMemoryDelete();
        state.pendingProjectMemoryDeleteId = entry.id;
        remove.textContent = t('common.reallyDelete');
        state.projectMemoryDeleteTimer = setTimeout(resetProjectMemoryDelete, 3000);
        return;
      }
      deleteProjectMemory(entry.id, row);
    }, { danger: true });
    remove.dataset.projectMemoryDelete = entry.id;
    remove.setAttribute('aria-label', t('profile.memoryDelete', { note: entry.note }));
    row.append(body, remove);
    el.folderProfileMemory.appendChild(row);
  }
}

async function loadBrandings() {
  const data = await api('/api/brandings');
  state.brandings = Array.isArray(data.brandings) ? data.brandings : [];
  renderContextBadge();
  if (!el.contextModal.classList.contains('hidden')) renderContextBrandings();
  if (!el.folderProfileModal.classList.contains('hidden')) renderProfileBrandings();
  if (!el.brandingsModal.classList.contains('hidden')) renderBrandingsManager();
}

async function loadCurrentFolderProfile() {
  const folder = state.detail?.session?.folder;
  if (!folder) {
    state.currentFolderProfile = null;
  } else {
    const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile`);
    state.currentFolderProfile = data.profile || null;
  }
  renderContextBadge();
  if (!el.contextModal.classList.contains('hidden')) renderContextBrandings();
}

async function updateCurrentSessionBrandings(ids) {
  if (!state.currentId || !state.detail?.session) throw new Error(t('branding.noChat'));
  if (ids.length > 2) throw new Error(t('branding.maxChat'));
  const data = await api(`/api/sessions/${state.currentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ brandings: ids })
  });
  Object.assign(state.detail.session, data.session);
  const meta = state.sessions.find((session) => session.id === state.currentId);
  if (meta) Object.assign(meta, data.session);
  renderContextBadge();
  renderContextBrandings();
  if (!el.brandingsModal.classList.contains('hidden')) renderBrandingsManager();
}

async function attachBrandingToSession(id) {
  const ids = sessionBrandingIds();
  if (!state.currentId) throw new Error(t('branding.openChat'));
  if (ids.includes(id) || projectBrandingIds().includes(id)) {
    setStatusI18n('branding.alreadyActive');
    return;
  }
  if (ids.length >= 2) {
    setStatusI18n('branding.maxChat');
    return;
  }
  await updateCurrentSessionBrandings([...ids, id]);
  setStatusI18n('branding.chatAttached');
}

async function detachBrandingFromSession(id) {
  await updateCurrentSessionBrandings(sessionBrandingIds().filter((brandingId) => brandingId !== id));
  setStatusI18n('branding.chatRemoved');
}

function managerAction(label, onClick, { danger = false, disabled = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `branding-manager-action${danger ? ' danger' : ''}`;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function showBrandingImportFeedback(message, { error = false } = {}) {
  el.brandingImportFeedback.textContent = message || '';
  el.brandingImportFeedback.classList.toggle('hidden', !message);
  el.brandingImportFeedback.classList.toggle('error', Boolean(message && error));
}

function setBrandingImporting(importing) {
  state.brandingImporting = Boolean(importing);
  el.brandingImportButton.disabled = state.brandingImporting;
  el.brandingImportName.disabled = state.brandingImporting;
  el.brandingImportButton.textContent = state.brandingImporting
    ? t('branding.importing')
    : t('branding.importButton');
}

function brandingImportReportText(report) {
  const key = report.guidelines
    ? 'branding.importReportWithGuidelines'
    : 'branding.importReportWithoutGuidelines';
  let message = t(key, {
    colors: report.colors || 0,
    fonts: report.fonts || 0,
    logos: report.logos || 0,
    imagery: report.imagery || 0,
    skipped: report.skipped || 0
  });
  if (report.guidelinesTruncated) message += ` ${t('branding.importGuidelinesTruncated')}`;
  if (report.svgRasterFailures) {
    message += ` ${t('branding.importRasterWarning', { count: report.svgRasterFailures })}`;
  }
  return message;
}

async function importBrandingFile(file) {
  if (!file || state.brandingImporting) return;
  if (!/\.zip$/i.test(file.name || '') && file.type !== 'application/zip') {
    showBrandingImportFeedback(t('branding.importZipOnly'), { error: true });
    return;
  }
  if (file.size > 80 * 1024 * 1024) {
    showBrandingImportFeedback(t('branding.importTooLarge'), { error: true });
    return;
  }

  setBrandingImporting(true);
  showBrandingImportFeedback(t('branding.importing'));
  try {
    const requestedName = el.brandingImportName.value.trim();
    const query = requestedName ? `?name=${encodeURIComponent(requestedName)}` : '';
    const response = await fetch(rel(`api/brandings/import${query}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-File-Name': encodeURIComponent(file.name || 'design-system.zip')
      },
      body: file
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* Der HTTP-Status liefert unten weiterhin eine brauchbare Meldung. */
    }
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);

    state.highlightedBrandingId = data.brandingId;
    el.brandingImportName.value = '';
    showBrandingImportFeedback(brandingImportReportText(data.report || {}));
    await loadBrandings();
    requestAnimationFrame(() => {
      const card = el.brandingsList.querySelector(`[data-branding-id="${CSS.escape(data.brandingId)}"]`);
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  } catch (err) {
    showBrandingImportFeedback(err.message, { error: true });
  } finally {
    setBrandingImporting(false);
  }
}

function renderBrandingsManager() {
  el.brandingsList.innerHTML = '';
  if (!state.brandings.length) {
    const empty = document.createElement('div');
    empty.className = 'branding-manager-empty';
    empty.textContent = t('branding.emptyManager');
    el.brandingsList.appendChild(empty);
    return;
  }

  const activeSessionIds = sessionBrandingIds();
  const projectIds = projectBrandingIds();
  const effectiveIds = effectiveBrandingIds();
  for (const branding of state.brandings) {
    const card = document.createElement('article');
    card.className = 'branding-card';
    card.dataset.brandingId = branding.id;
    if (branding.id === state.highlightedBrandingId) {
      card.classList.add('imported');
      card.setAttribute('aria-current', 'true');
    }
    const head = document.createElement('div');
    head.className = 'branding-card-head';
    const copy = document.createElement('div');
    copy.className = 'branding-card-copy';
    const name = document.createElement('h3');
    name.textContent = branding.name;
    copy.appendChild(name);
    if (branding.description) {
      const description = document.createElement('p');
      description.textContent = branding.description;
      copy.appendChild(description);
    }
    head.appendChild(copy);
    head.appendChild(brandingDots(branding.colors));
    card.appendChild(head);

    const date = document.createElement('div');
    date.className = 'branding-card-date';
    date.textContent = t('branding.updated', { date: formatDate(branding.updatedAt) });
    card.appendChild(date);

    const actions = document.createElement('div');
    actions.className = 'branding-card-actions';
    const download = document.createElement('a');
    download.className = 'branding-manager-action';
    download.href = rel(`api/brandings/${encodeURIComponent(branding.id)}/export`);
    download.download = '';
    download.textContent = t('branding.exportZip');
    actions.appendChild(download);

    const attached = activeSessionIds.includes(branding.id);
    const inProject = projectIds.includes(branding.id);
    const inherited = inProject && effectiveIds.includes(branding.id);
    actions.appendChild(
      managerAction(attached ? t('branding.attachedChat') : inherited ? t('branding.activeProject') : inProject ? t('branding.storedProject') : t('branding.attachChat'), () => {
        attachBrandingToSession(branding.id).catch((err) => setStatus(err.message));
      }, { disabled: !state.currentId || attached || inProject || state.streaming })
    );

    const confirming = state.pendingBrandingDeleteId === branding.id;
    actions.appendChild(
      managerAction(confirming ? t('common.reallyDelete') : t('common.delete'), () => {
        if (!confirming) {
          state.pendingBrandingDeleteId = branding.id;
          renderBrandingsManager();
          return;
        }
        deleteBranding(branding.id).catch((err) => setStatus(err.message));
      }, { danger: true })
    );
    card.appendChild(actions);
    el.brandingsList.appendChild(card);
  }
}

async function deleteBranding(id) {
  await api(`/api/brandings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.pendingBrandingDeleteId = null;
  if (sessionBrandingIds().includes(id)) {
    await updateCurrentSessionBrandings(sessionBrandingIds().filter((brandingId) => brandingId !== id));
  }
  if (state.detail?.session?.folder && projectBrandingIds().includes(id)) {
    const folder = state.detail.session.folder;
    const data = await api(`/api/folders/${encodeURIComponent(folder)}/profile`, {
      method: 'PUT',
      body: JSON.stringify({
        guidelines: state.currentFolderProfile?.guidelines || '',
        contextBrains: state.currentFolderProfile?.contextBrains || [],
        brandings: projectBrandingIds().filter((brandingId) => brandingId !== id)
      })
    });
    state.currentFolderProfile = data.profile || null;
    state.folderProfiles.set(folder, data.profile || null);
  }
  await loadBrandings();
  setStatusI18n('branding.deleted');
}

async function openBrandingsModal() {
  state.pendingBrandingDeleteId = null;
  state.highlightedBrandingId = null;
  setBrandingImporting(false);
  showBrandingImportFeedback('');
  el.brandingsModal.classList.remove('hidden');
  el.brandingsList.innerHTML = '';
  el.brandingsList.appendChild(textNode('div', 'branding-manager-empty', t('branding.loading')));
  try {
    await loadBrandings();
  } catch (err) {
    el.brandingsList.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'branding-manager-empty error';
    error.textContent = err.message;
    el.brandingsList.appendChild(error);
  }
}

function closeBrandingsModal() {
  state.pendingBrandingDeleteId = null;
  state.highlightedBrandingId = null;
  el.brandingImportFile.value = '';
  el.brandingsModal.classList.add('hidden');
}

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
  return Boolean(state.config?.gts?.enabled);
}

function renderContextBadge() {
  const contextCount = state.contextBrains.length + state.contextFiles.length;
  const brandingCount = effectiveBrandingIds().length;
  el.contextBtn.classList.toggle('hidden', !state.currentId);
  el.contextBadge.classList.toggle('hidden', contextCount === 0);
  el.contextBadge.textContent = String(contextCount);
  el.brandingContextBadge.classList.toggle('hidden', brandingCount === 0);
  el.brandingContextBadge.textContent = `🎨 ${brandingCount}`;
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

async function uploadContextFile(name, text) {
  if (!state.currentId) await createSession();
  const data = await api(`/api/sessions/${state.currentId}/context-files`, {
    method: 'POST',
    body: JSON.stringify({ name, text })
  });
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
  await uploadTextContextFileList(files, state.contextFiles, uploadContextFile, 'context.scopeChat');
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
  el.folderProfileModal.classList.remove('hidden');
  el.folderProfileGuidelines.focus();
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

/* ---------- job polling ---------- */

function hasActiveRenderNodeJob() {
  if (state.liveRenderNodeJob) return true;
  return (state.detail?.jobs || []).some(
    (job) => job.source === 'rendernode' && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled'
  );
}

function setRenderMode(active) {
  state.renderMode = Boolean(active && state.renderNodeAvailable);
  renderToolsMenu();
}

function setBrandingWizard(active) {
  state.brandingWizard = Boolean(active);
  renderToolsMenu();
}

function renderRenderNodeStatus(status) {
  state.renderNodeState = status || null;
  state.renderNodeAvailable = Boolean(status?.enabled && status?.online);
  if (!state.renderNodeAvailable) setRenderMode(false);
  else renderToolsMenu();
  el.renderNodeStatus.classList.remove('online', 'rendering');
  if (!status?.enabled) {
    el.renderNodeStatus.classList.add('hidden');
    el.renderNodeText.textContent = '';
    el.renderNodeStatus.removeAttribute('title');
    return;
  }
  el.renderNodeStatus.classList.remove('hidden');
  const nodes = Array.isArray(status.nodes) ? status.nodes : [];
  if (nodes.length > 1) {
    const onlineCount = nodes.filter((node) => node.online).length;
    el.renderNodeText.textContent = t('render.multiOnline', { online: onlineCount, total: nodes.length });
    el.renderNodeStatus.title = nodes
      .map((node) => `${node.name}: ${renderNodeManagerStatus({ ...node, enabled: true })}`)
      .join('\n');
    if (status.online && (status.running || Number(status.queue) > 0)) {
      el.renderNodeStatus.classList.add('rendering');
    } else if (status.online) {
      el.renderNodeStatus.classList.add('online');
    }
    return;
  }
  el.renderNodeStatus.removeAttribute('title');
  if (status.online && (status.running || Number(status.queue) > 0)) {
    el.renderNodeStatus.classList.add('rendering');
    el.renderNodeText.textContent = t('render.rendering');
  } else if (status.online) {
    el.renderNodeStatus.classList.add('online');
    el.renderNodeText.textContent = t('render.online');
  } else {
    el.renderNodeText.textContent = t('render.offline');
  }
}

function scheduleRenderNodePolling(delay) {
  if (state.renderNodeTimer) clearTimeout(state.renderNodeTimer);
  state.renderNodeTimer = setTimeout(async () => {
    state.renderNodeTimer = null;
    try {
      renderRenderNodeStatus(await api('/api/rendernode/status'));
    } catch (_) {
      if (!el.renderNodeStatus.classList.contains('hidden')) {
        renderRenderNodeStatus({ enabled: true, online: false, running: false, queue: 0 });
      }
    } finally {
      scheduleRenderNodePolling(hasActiveRenderNodeJob() ? RENDER_NODE_ACTIVE_POLL_MS : RENDER_NODE_IDLE_POLL_MS);
    }
  }, delay);
}

function hasOpenJobs() {
  return (state.detail?.jobs || []).some((job) => job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled');
}

function scheduleJobPolling() {
  if (state.jobTimer) {
    clearInterval(state.jobTimer);
    state.jobTimer = null;
  }
  if (!hasOpenJobs()) return;
  state.jobTimer = setInterval(async () => {
    if (!state.currentId || state.streaming) return;
    try {
      const data = await api(`/api/sessions/${state.currentId}/jobs`);
      const before = JSON.stringify((state.detail.jobs || []).map((j) => [j.jobId, j.status]));
      const after = JSON.stringify((data.jobs || []).map((j) => [j.jobId, j.status]));
      if (before !== after) await refreshDetail();
      else if (!(data.jobs || []).some((j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled')) {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
      }
    } catch (_) {
      /* transient */
    }
  }, 10000);
}

/* ---------- attachments ---------- */

function renderAttachments() {
  el.attachStrip.replaceChildren();
  el.attachStrip.classList.toggle('hidden', state.attachments.length === 0);
  state.attachments.forEach((att, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const preview = attachmentPreviewNode(att);
    thumb.classList.toggle('thumb-file-preview', preview.classList.contains('thumb-file'));
    thumb.appendChild(preview);
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = t('common.remove');
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    thumb.appendChild(remove);
    el.attachStrip.appendChild(thumb);
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error(t('context.fileReadError', { name: file.name })));
    reader.readAsDataURL(file);
  });
}

const CONTEXT_FILE_EXTENSIONS = /\.(md|txt|markdown)$/i;
const UPLOAD_EXTENSIONS = /\.(png|jpe?g|webp|gif|mp3|wav|m4a|aac|mp4|webm|ttf|otf|woff2?|md|txt|markdown)$/i;

function isContextFile(name) {
  return CONTEXT_FILE_EXTENSIONS.test(String(name || ''));
}

function isSupportedUpload(type, name) {
  const mime = String(type || '').toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('font/')) return true;
  return UPLOAD_EXTENSIONS.test(String(name || ''));
}

async function addImageFiles(files) {
  if (state.streaming) return;
  const candidates = Array.from(files || []);
  const accepted = candidates.filter((file) => isSupportedUpload(file.type, file.name));
  const skipped = candidates.length - accepted.length;

  for (const file of accepted) {
    try {
      if (isContextFile(file.name)) {
        state.attachments.push({ name: file.name, text: await readTextFile(file), contextFile: true });
      } else {
        state.attachments.push(await readFile(file));
      }
    } catch (err) {
      setStatus(err.message);
    }
  }
  renderAttachments();

  if (skipped > 0) {
    setStatusI18n(skipped === 1 ? 'uploads.skippedOne' : 'uploads.skippedMany', { n: skipped });
  }
}

let imageDragDepth = 0;

function draggedImages(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  if (items.length) {
    // Beim Dragover fehlt bei manchen Dateitypen (z.B. Fonts) der Mimetype - dann durchlassen,
    // die endgueltige Filterung passiert beim Drop in addImageFiles.
    return items.some((item) => item.kind === 'file' && (!item.type || isSupportedUpload(item.type, '')));
  }
  return Array.from(dataTransfer?.files || []).some((file) => isSupportedUpload(file.type, file.name));
}

function hideDropOverlay() {
  imageDragDepth = 0;
  el.dropOverlay.classList.add('hidden');
}

/* ---------- lightbox ---------- */

function openLightbox(url) {
  el.lightboxImg.src = url;
  el.lightbox.classList.remove('hidden');
}

el.lightbox.addEventListener('click', () => {
  el.lightbox.classList.add('hidden');
  el.lightboxImg.src = '';
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    el.lightbox.classList.add('hidden');
    el.lightboxImg.src = '';
    closeContextModal();
    closeCostsModal();
  }
});

/* ---------- streaming send ---------- */

function liveContext() {
  if (!state.live) state.live = { textEl: null, buffer: '', chips: [] };
  return state.live;
}

function finishChips() {
  for (const node of liveContext().chips) {
    const spin = node.querySelector('.spinner');
    if (spin) spin.remove();
  }
  liveContext().chips = [];
}

function appendLiveNode(node) {
  el.messages.appendChild(node);
  scrollDown();
}

function handleEvent(event) {
  const live = liveContext();
  if (event.type === 'text_delta') {
    if (!live.textEl) {
      const { wrap, bubble } = messageShell('assistant');
      appendLiveNode(wrap);
      live.textEl = bubble;
      live.buffer = '';
    }
    live.buffer += event.delta;
    live.textEl.innerHTML = renderMarkdown(live.buffer);
    scrollDown();
    return;
  }
  if (event.type === 'tool_start') {
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    const c = chip(event.label || t('common.working'), true, false);
    node.appendChild(c);
    appendLiveNode(node);
    live.chips.push(c);
    if (event.label) setStatus(event.label, { busy: true });
    else setStatusI18n('common.working', {}, { busy: true });
    return;
  }
  if (event.type === 'asset') {
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    const grid = document.createElement('div');
    grid.className = 'asset-grid';
    grid.appendChild(mediaCard(event.asset));
    node.appendChild(grid);
    appendLiveNode(node);
    return;
  }
  if (event.type === 'video_job' || event.type === 'generation_job') {
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    const grid = document.createElement('div');
    grid.className = 'asset-grid';
    grid.appendChild(jobCard({ assetId: event.assetId, status: 'pending' }));
    node.appendChild(grid);
    appendLiveNode(node);
    if (event.source === 'rendernode') {
      state.liveRenderNodeJob = true;
      scheduleRenderNodePolling(0);
    }
    return;
  }
  if (event.type === 'error') {
    finishChips();
    live.textEl = null;
    if (event.fatal !== false) state.fatal = true;
    const node = document.createElement('div');
    node.className = 'msg tool';
    node.appendChild(chip(event.message || t('common.error'), false, true));
    appendLiveNode(node);
    if (event.message) setStatus(event.message);
    else setStatusI18n('common.error');
  }
}

async function send() {
  if (state.streaming) return;
  const text = el.input.value.trim();
  if (!text && state.attachments.length === 0) return;
  if (!state.currentId) await createSession();

  const pendingAttachments = state.attachments.slice();
  const contextAttachments = pendingAttachments.filter((attachment) => attachment.contextFile);
  const attachments = pendingAttachments.filter((attachment) => !attachment.contextFile);
  const contextNotes = [];
  try {
    for (const attachment of contextAttachments) {
      await uploadContextFile(attachment.name, attachment.text);
      contextNotes.push(`[Kontextdatei angehaengt: ${attachment.name}]`);
    }
  } catch (err) {
    setStatusI18n('context.fileAttachFailed', { error: err.message });
    return;
  }
  const messageText = [text, ...contextNotes].filter(Boolean).join('\n');
  const renderMode = state.renderMode && state.renderNodeAvailable;
  const brandingWizard = state.brandingWizard;
  state.attachments = [];
  setRenderMode(false);
  setBrandingWizard(false);
  renderAttachments();
  el.input.value = '';
  el.input.style.height = 'auto';

  const emptyState = el.messages.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const { wrap, bubble } = messageShell('user');
  if (attachments.length) {
    const row = document.createElement('div');
    row.className = 'upload-row';
    for (const att of attachments) {
      row.appendChild(attachmentPreviewNode(att));
    }
    wrap.insertBefore(row, bubble);
  }
  bubble.innerHTML = renderMarkdown(messageText);
  appendLiveNode(wrap);

  state.streaming = true;
  state.live = null;
  state.fatal = false;
  el.sendBtn.disabled = true;
  el.attachBtn.disabled = true;
  el.toolsMenuBtn.disabled = true;
  renderToolsMenu();
  el.input.disabled = true;
  setStatusI18n('send.thinking', {}, { busy: true });

  try {
    const res = await fetch(rel(`/api/sessions/${state.currentId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: messageText, brainModel: state.brainModel, attachments, renderMode, brandingWizard })
    });
    if (!res.ok || !res.body) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch (_) {
        /* ignore */
      }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let parsed;
          try {
            parsed = JSON.parse(line.slice(5).trim());
          } catch (_) {
            continue;
          }
          if (parsed.type === 'done') {
            finished = true;
            setStatus('');
          } else {
            handleEvent(parsed);
          }
        }
      }
    }
  } catch (err) {
    handleEvent({ type: 'error', message: err.message || t('send.connectionFailed') });
  } finally {
    finishChips();
    state.streaming = false;
    state.live = null;
    el.sendBtn.disabled = false;
    el.attachBtn.disabled = false;
    el.toolsMenuBtn.disabled = false;
    renderToolsMenu();
    el.input.disabled = false;
    setStatus('');
    el.input.focus();
    try {
      await loadSessions();
      // On a fatal error the live view holds the only trace of the failed turn.
      if (!state.fatal) await refreshDetail();
    } catch (_) {
      /* keep the live view */
    }
    await refreshCosts().catch(() => {});
  }
}

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
el.brandingsBtn.addEventListener('click', () => openBrandingsModal());
el.brandingsClose.addEventListener('click', () => closeBrandingsModal());
el.brandingImportButton.addEventListener('click', () => {
  if (!state.brandingImporting) el.brandingImportFile.click();
});
el.brandingImportFile.addEventListener('change', () => {
  const file = el.brandingImportFile.files?.[0] || null;
  el.brandingImportFile.value = '';
  importBrandingFile(file);
});
el.settingsBtn.addEventListener('click', () => openSettingsModal());
el.settingsClose.addEventListener('click', () => closeSettingsModal());
el.adminForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addAdmin();
});
el.renderNodeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addRenderNode();
});
el.higgsfieldConnect.addEventListener('click', () => connectHiggsfield());
el.higgsfieldDisconnect.addEventListener('click', () => disconnectHiggsfield());
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

el.langSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('[data-lang]');
  if (button) setLang(button.dataset.lang);
});

function renderModelInfo() {
  if (!state.config) return;
  el.modelInfo.textContent = `${t('tools.imageModel', { name: state.config.imageModel })}\n${t('tools.videoModel', { name: state.config.videoModel })}`;
  el.modelInfo.style.whiteSpace = 'pre-line';
}

window.onLangChange = () => {
  resetPromptPresetDelete();
  renderPromptMenu();
  renderToolsMenu();
  renderSessions();
  if (!state.streaming) renderDetail();
  renderCosts(state.costs);
  renderModelInfo();
  renderAttachments();
  if (state.renderNodeState) renderRenderNodeStatus(state.renderNodeState);
  if (statusTranslation) {
    setStatusI18n(statusTranslation.key, statusTranslation.vars, statusTranslation.options);
  }
  resetSettingsDelete();
  resetAdminDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  const settingsValues = new Map(
    [...el.settingsList.querySelectorAll('input')].map((input) => [input.id, input.value])
  );
  renderSettings();
  renderAdmins();
  renderRenderNodes();
  renderHiggsfieldStatus();
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

/* ---------- init ---------- */

async function init() {
  loadPromptPresets();
  try {
    state.config = await api('/api/config');
  } catch (err) {
    setStatusI18n('send.serverUnavailable', { error: err.message });
    return;
  }

  await loadSettingsAccess();

  el.keyBanner.classList.toggle('hidden', Boolean(state.config.hasKey));
  let savedBrain = '';
  try {
    savedBrain = localStorage.getItem(BRAIN_STORAGE_KEY) || '';
  } catch (_) {
    /* Standardmodell verwenden. */
  }
  const brainModels = state.config.brainModels || [];
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
