'use strict';

const el = {
  sidebar: document.querySelector('.sidebar'),
  sidebarBackdrop: document.getElementById('sidebarBackdrop'),
  mobileMenuBtn: document.getElementById('mobileMenuBtn'),
  topbar: document.querySelector('.topbar'),
  currentProjectName: document.getElementById('currentProjectName'),
  sessionList: document.getElementById('sessionList'),
  sessionSearch: document.getElementById('sessionSearch'),
  newSession: document.getElementById('newSession'),
  sidebarCreate: document.getElementById('sidebarCreate'),
  newFolder: document.getElementById('newFolder'),
  newFolderInput: document.getElementById('newFolderInput'),
  modelInfo: document.getElementById('modelInfo'),
  brandingsBtn: document.getElementById('brandingsBtn'),
  settingsTabs: document.querySelector('.settings-tabs'),
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
  chatgptStatusDot: document.getElementById('chatgptStatusDot'),
  chatgptStatusText: document.getElementById('chatgptStatusText'),
  chatgptImport: document.getElementById('chatgptImport'),
  chatgptDisconnect: document.getElementById('chatgptDisconnect'),
  renderNodeStatus: document.getElementById('renderNodeStatus'),
  renderNodeText: document.getElementById('renderNodeText'),
  sessionTitle: document.getElementById('sessionTitle'),
  sessionOwner: document.getElementById('sessionOwner'),
  shareBtn: document.getElementById('shareBtn'),
  shareBtnLabel: document.getElementById('shareBtnLabel'),
  accountHost: document.getElementById('accountMenu'),
  usersSection: document.getElementById('usersSection'),
  usersList: document.getElementById('usersList'),
  userForm: document.getElementById('userForm'),
  userEmail: document.getElementById('userEmail'),
  userAdd: document.getElementById('userAdd'),
  settingsMonitoringLink: document.getElementById('settingsMonitoringLink'),
  folderProfilePanel: document.getElementById('folderProfilePanel'),
  folderProfileReadOnly: document.getElementById('folderProfileReadOnly'),
  keyBanner: document.getElementById('keyBanner'),
  budgetBanner: document.getElementById('budgetBanner'),
  usersPasteSlot: document.getElementById('usersPasteSlot'),
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
  jobStatusBar: document.getElementById('jobStatusBar'),
  videoModelHint: document.getElementById('videoModelHint'),
  videoAskToggle: document.getElementById('videoAskToggle'),
  jobStatusList: document.getElementById('jobStatusList'),
  statusLine: document.getElementById('statusLine'),
  statusText: document.getElementById('statusText'),
  costsBtn: document.getElementById('costsBtn'),
  costsModal: document.getElementById('costsModal'),
  costsClose: document.getElementById('costsClose'),
  costsBody: document.getElementById('costsBody'),
  contextBtn: document.getElementById('contextBtn'),
  contextBadge: document.getElementById('contextBadge'),
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
  'moonshotai/kimi-k3': { shortName: 'Kimi K3', hintKey: 'model.kimi' },
  'chatgpt/gpt-5.6-sol': { shortName: 'GPT 5.6 Sol (Abo)', hintKey: 'model.chatgptSubscription' },
  'chatgpt/gpt-5.6-terra': { shortName: 'GPT 5.6 Terra (Abo)', hintKey: 'model.chatgptSubscription' },
  'chatgpt/gpt-5.6-luna': { shortName: 'GPT 5.6 Luna (Abo)', hintKey: 'model.chatgptSubscription' }
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
  folderSessionsRequested: new Set(),
  collapsedFolders: loadCollapsedFolders(),
  mobileSidebarOpen: false,
  settingsAvailable: false,
  costsAmountText: '$0.00',
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
  preferences: { askVideoModel: true },
  pendingSettingsDeleteName: null,
  settingsDeleteTimer: null,
  admins: [],
  pendingAdminDeleteEmail: null,
  adminDeleteTimer: null,
  users: [],
  pendingUserDeleteEmail: null,
  userDeleteTimer: null,
  renderNodes: [],
  pendingRenderNodeDeleteId: null,
  renderNodeDeleteTimer: null,
  higgsfield: { connected: false, refreshExpiresAt: null, pending: false },
  higgsfieldPollTimer: null,
  higgsfieldPollExpiresAt: 0,
  higgsfieldDisconnectPending: false,
  higgsfieldDisconnectTimer: null,
  chatgpt: { connected: false, plan: null, expiresAt: null, models: [] },
  chatgptDisconnectPending: false,
  chatgptDisconnectTimer: null,
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
const JOB_POLL_MS = 5000;
const sidebarDrawerMedia = typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 820px)')
  : { matches: false, addEventListener() {} };

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

  // Custom presets are shared with everybody; with user management only admins change them.
  if (preset.custom === true && OCAccess.canAdminister()) {
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
  if (!OCAccess.canAdminister()) return;
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
  for (const model of offeredBrainModels()) {
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
  if (OCAccess.canAdminister()) {
    el.toolsMenu.appendChild(toolsMenuOption({
      name: t('tools.newRole'),
      icon: '✨',
      role: 'menuitem',
      onClick: () => {
        setToolsMenuOpen(false);
        openRoleModal();
      }
    }));
  }

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
  // Creating and changing brandings is admin-only in the user management (the tools refuse everybody else).
  if (OCAccess.canAdminister()) {
    el.toolsMenu.appendChild(toolsMenuOption({
      name: t('tools.brandingInterview'),
      icon: '🎨',
      active: state.brandingWizard,
      role: 'menuitemcheckbox',
      disabled: state.streaming,
      onClick: () => setBrandingWizard(!state.brandingWizard)
    }));
  }
  updateToolsButton();
}

function selectBrain(model, { remember = true } = {}) {
  if (!offeredBrainModels().includes(model)) return;
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

// A dropped connection reads as a sentence, not as the browser's "Failed to fetch".
function networkError() {
  const error = new Error(t('common.networkError'));
  error.code = 'NETWORK';
  return error;
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(rel(path), {
      headers: { 'Content-Type': 'application/json' },
      ...(options || {})
    });
  } catch (_) {
    throw networkError();
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let payload = null;
    try {
      payload = await res.json();
      if (payload.error) message = payload.error;
    } catch (_) {
      /* ignore */
    }
    const error = new Error(message);
    error.status = res.status;
    if (payload && typeof payload === 'object') {
      error.code = payload.code;
      error.body = payload;
    }
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
  if (value === 0) return '$0.00';
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
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
let streamHeartbeatTimer = null;
let streamHeartbeatStartedAt = 0;
let streamHeartbeatPhase = 'thinking';
let streamHeartbeatTool = '';
let jobElapsedTimer = null;

function setStatus(text, { busy = false, preserveTranslation = false, immediate = false } = {}) {
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
  if (immediate) {
    el.statusText.textContent = nextText;
    el.statusLine.classList.remove('changing');
    return;
  }
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

function formatElapsedClock(since) {
  const parsed = typeof since === 'number' ? since : Date.parse(String(since || ''));
  const start = Number.isFinite(parsed) ? parsed : Date.now();
  const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
}

function streamToolLabel(toolName) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'render_motion_graphics') return t('send.phaseMotion');
  if (name.includes('higgsfield')) return t('send.phaseHiggsfield');
  if (name.includes('video')) return t('send.phaseVideo');
  if (name.includes('image') || name.includes('branding')) return t('send.phaseImage');
  if (name.includes('speech') || name.includes('voice')) return t('send.phaseAudio');
  return t('send.phaseTool');
}

function renderStreamHeartbeat() {
  if (!state.streaming || !streamHeartbeatStartedAt) return;
  const elapsed = formatElapsedClock(streamHeartbeatStartedAt);
  const text = streamHeartbeatPhase === 'tool'
    ? t('send.toolRunning', { tool: streamToolLabel(streamHeartbeatTool), elapsed })
    : t('send.thinkingElapsed', { elapsed });
  setStatus(text, { busy: true, preserveTranslation: true, immediate: true });
}

function setStreamPhase(phase, toolName = '') {
  streamHeartbeatPhase = phase === 'tool' ? 'tool' : 'thinking';
  streamHeartbeatTool = toolName;
  renderStreamHeartbeat();
}

function startStreamHeartbeat() {
  if (streamHeartbeatTimer) clearInterval(streamHeartbeatTimer);
  statusTranslation = null;
  streamHeartbeatStartedAt = Date.now();
  streamHeartbeatPhase = 'thinking';
  streamHeartbeatTool = '';
  renderStreamHeartbeat();
  streamHeartbeatTimer = setInterval(renderStreamHeartbeat, 1000);
}

function stopStreamHeartbeat() {
  if (streamHeartbeatTimer) clearInterval(streamHeartbeatTimer);
  streamHeartbeatTimer = null;
  streamHeartbeatStartedAt = 0;
  streamHeartbeatPhase = 'thinking';
  streamHeartbeatTool = '';
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
  // The model that made a video (from the job or the ledger entry).
  const model = asset.kind === 'video' ? String(asset.model || '').trim() : '';
  if (model) {
    const modelEl = document.createElement('span');
    modelEl.className = 'asset-model';
    modelEl.textContent = t('assets.model', { model: videoModelShortName(model) });
    modelEl.title = model;
    meta.appendChild(modelEl);
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
  const statusDetail = failed ? job.error || t('jobs.unknownError') : t('jobs.duration');
  const jobModel = job.kind === 'video' || !job.kind ? String(job.model || '').trim() : '';
  small.textContent = jobModel ? `${statusDetail} · ${t('assets.model', { model: videoModelShortName(jobModel) })}` : statusDetail;
  if (jobModel) small.title = jobModel;
  body.appendChild(small);
  card.appendChild(body);
  return card;
}

/* ---------- Video model picker (card of the Director, lib/video-models.js) ---------- */

// "bytedance/seedance-2.5" -> "seedance-2.5": the slug without the provider, for the small model label.
function videoModelShortName(model) {
  const text = String(model || '');
  const slash = text.indexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

function videoModelMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

function videoModelPriceLabel(price) {
  if (!price) return t('videoModel.priceUnknown');
  const min = videoModelMoney(price.minTotal);
  const max = videoModelMoney(price.maxTotal);
  const amount = Math.abs(price.maxTotal - price.minTotal) > 0.005 ? `${min}–${max}` : min;
  return t('videoModel.priceEstimate', { amount, seconds: price.durationSeconds });
}

function videoModelProfileText(profileKey, field) {
  const key = `videoModel.profile.${profileKey || 'generic'}.${field}`;
  return i18nHas(key) ? t(key) : t(`videoModel.profile.generic.${field}`);
}

function videoModelBlockText(option) {
  const block = option.blocked;
  if (!block) return '';
  if (block.reason === 'exhausted') return t('videoModel.blockedExhausted');
  return t('videoModel.blockedBudget', { estimate: videoModelMoney(block.needUsd), remaining: videoModelMoney(block.remainingUsd) });
}

// The error a failed start left on the card, in the interface language where it is a known rule.
function videoModelErrorText(choice) {
  if (!choice.lastError) return '';
  const rule = choice.lastErrorCode ? OCAccess.accountRuleMessage({ code: choice.lastErrorCode }) : null;
  return t('videoModel.startFailed', { error: rule || choice.lastError });
}

async function afterVideoModelChange() {
  await Promise.all([refreshDetail(), loadSessions(), refreshCosts().catch(() => {})]);
  if (OCAccess.me().restricted) OCAccess.refreshMe().catch(() => {});
}

async function submitVideoModelChoice(choice, option, card) {
  if (state.streaming || choice.status !== 'pending' || !state.currentId || card.dataset.busy === '1') return;
  card.dataset.busy = '1';
  const buttons = [...card.querySelectorAll('button')];
  const status = card.querySelector('.vmc-status');
  const remember = card.querySelector('.vmc-remember input')?.checked === true;
  for (const button of buttons) button.disabled = true;
  status.textContent = t('videoModel.starting');
  status.classList.remove('error');
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/video-model-requests/${encodeURIComponent(choice.id)}`, {
      method: 'POST',
      body: JSON.stringify({ model: option.id, remember })
    });
    await afterVideoModelChange();
  } catch (error) {
    // The card may be out of date (budget changed, started elsewhere): show the reason, then read the chat again.
    const rule = OCAccess.accountRuleMessage(error);
    if (rule) OCAccess.refreshMe().catch(() => {});
    status.textContent = t('videoModel.startFailed', { error: rule || error.message });
    status.classList.add('error');
    delete card.dataset.busy;
    for (const button of buttons) button.disabled = false;
    refreshDetail().catch(() => {});
  }
}

async function cancelVideoModelChoice(choice, card) {
  if (state.streaming || choice.status !== 'pending' || !state.currentId || card.dataset.busy === '1') return;
  card.dataset.busy = '1';
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/video-model-requests/${encodeURIComponent(choice.id)}/cancel`, { method: 'POST', body: '{}' });
    await refreshDetail();
  } catch (error) {
    const status = card.querySelector('.vmc-status');
    status.textContent = error.message;
    status.classList.add('error');
    delete card.dataset.busy;
    for (const button of card.querySelectorAll('button')) button.disabled = false;
  }
}

function videoModelOptionButton(choice, option, card, locked) {
  const button = document.createElement('button');
  button.type = 'button';
  const blocked = Boolean(option.blocked);
  button.className = `vmc-option${option.recommended ? ' recommended' : ''}${blocked ? ' blocked' : ''}`;
  button.dataset.videoModel = option.id;
  button.disabled = locked || blocked;
  if (locked && state.streaming) button.title = t('videoModel.waitStream');

  const top = document.createElement('span');
  top.className = 'vmc-option-top';
  top.appendChild(textNode('strong', 'vmc-option-name', option.name));
  if (option.recommended) top.appendChild(textNode('span', 'vmc-badge', t('videoModel.recommended')));
  button.appendChild(top);
  button.appendChild(textNode('span', 'vmc-price', videoModelPriceLabel(option.price)));
  button.appendChild(textNode('span', 'vmc-summary', videoModelProfileText(option.profileKey, 'summary')));
  const tradeoffs = document.createElement('span');
  tradeoffs.className = 'vmc-tradeoffs';
  tradeoffs.appendChild(textNode('span', 'vmc-pro', videoModelProfileText(option.profileKey, 'pro')));
  tradeoffs.appendChild(textNode('span', 'vmc-con', videoModelProfileText(option.profileKey, 'con')));
  button.appendChild(tradeoffs);
  if (blocked) button.appendChild(textNode('span', 'vmc-blocked', videoModelBlockText(option)));
  button.addEventListener('click', () => submitVideoModelChoice(choice, option, card));
  return button;
}

function videoModelChoiceCard(choice) {
  const status = choice.status || 'pending';
  const card = document.createElement('section');
  card.className = `video-model-choice ${status}`;
  card.dataset.requestId = choice.id;
  card.setAttribute('aria-label', t('videoModel.title'));

  const head = document.createElement('div');
  head.className = 'vmc-head';
  const titleKey = status === 'submitted' ? 'videoModel.selectedTitle' : status === 'cancelled' ? 'videoModel.cancelledTitle' : 'videoModel.title';
  head.appendChild(textNode('strong', 'vmc-title', t(titleKey)));
  card.appendChild(head);

  const requirements = choice.requirements || {};
  if (status === 'pending' || status === 'processing') {
    head.appendChild(textNode('p', 'vmc-lead', t('videoModel.lead')));
  }
  if (choice.prompt) card.appendChild(textNode('p', 'vmc-prompt', choice.prompt));
  if (status === 'pending' || status === 'processing') {
    const mode = requirements.mode === 'image_to_video' ? t('videoModel.modeImage') : t('videoModel.modeText');
    const first = (choice.options || [])[0];
    card.appendChild(textNode('p', 'vmc-job', t('videoModel.jobLine', {
      seconds: requirements.duration,
      resolution: first?.resolution || requirements.resolution || '720p',
      mode
    })));
    if (choice.budget) card.appendChild(textNode('p', 'vmc-budget', t('videoModel.budgetLine', { remaining: videoModelMoney(choice.budget.remainingUsd) || '$0.00' })));
    if (choice.preferenceNote) {
      const key = choice.preferenceNote.reason === 'budget' ? 'videoModel.prefBudget' : 'videoModel.prefIncompatible';
      card.appendChild(textNode('p', 'vmc-note', t(key, { model: choice.preferenceNote.name })));
    }
    const options = document.createElement('div');
    options.className = 'vmc-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', t('videoModel.listLabel'));
    const locked = status !== 'pending' || state.streaming;
    for (const option of choice.options || []) options.appendChild(videoModelOptionButton(choice, option, card, locked));
    card.appendChild(options);
    card.appendChild(textNode('p', 'vmc-fine', t('videoModel.priceNote')));

    const foot = document.createElement('div');
    foot.className = 'vmc-foot';
    const remember = document.createElement('label');
    remember.className = 'vmc-remember';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = locked;
    remember.append(checkbox, textNode('span', '', t('videoModel.remember')));
    remember.title = t('videoModel.rememberHint');
    foot.appendChild(remember);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'vmc-cancel';
    cancel.textContent = t('videoModel.cancel');
    cancel.disabled = locked;
    cancel.addEventListener('click', () => cancelVideoModelChoice(choice, card));
    foot.appendChild(cancel);
    card.appendChild(foot);
  } else if (status === 'submitted') {
    const price = choice.selectedEstimate ? ` · ${videoModelPriceLabel(choice.selectedEstimate)}` : '';
    card.appendChild(textNode('p', 'vmc-result', `${t('videoModel.selected', { model: choice.selectedName || choice.selectedModel || '' })}${price}`));
    if (choice.remember) card.appendChild(textNode('p', 'vmc-note', t('videoModel.selectedRemembered')));
  } else if (status === 'cancelled') {
    card.appendChild(textNode('p', 'vmc-result', t('videoModel.cancelled')));
  }

  const line = document.createElement('div');
  line.className = 'vmc-status';
  line.setAttribute('role', 'status');
  if (choice.lastError && status === 'pending') {
    line.textContent = videoModelErrorText(choice);
    line.classList.add('error');
  } else if (status === 'processing') {
    line.textContent = t('videoModel.starting');
  }
  card.appendChild(line);
  return card;
}

// Above the input: the model this person remembered for the chat, with a way back to the question. Not shown while the
// admin switch is off (the next video then uses the default model, whatever was remembered).
function renderVideoModelHint() {
  const asking = state.config?.askVideoModel !== false;
  const preference = state.currentId && asking ? state.detail?.session?.videoModelPreference : null;
  el.videoModelHint.classList.toggle('hidden', !preference);
  el.videoModelHint.replaceChildren();
  if (!preference) return;
  el.videoModelHint.appendChild(textNode('span', 'video-model-hint-text', t('videoModel.hint', { model: preference.name || preference.model })));
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'video-model-hint-change';
  change.textContent = t('videoModel.hintChange');
  change.title = t('videoModel.hintChangeTitle');
  change.addEventListener('click', async () => {
    change.disabled = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(state.currentId)}/video-model-preference`, { method: 'DELETE' });
      if (state.detail?.session) state.detail.session.videoModelPreference = null;
      renderVideoModelHint();
      setStatus(t('videoModel.hintReset'));
    } catch (error) {
      change.disabled = false;
      setStatus(t('videoModel.resetFailed', { error: error.message }));
    }
  });
  el.videoModelHint.appendChild(change);
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
  if (message.name === 'generate_video' && message.videoModelChoice?.status === 'pending') return t('tools.videoChoosing');
  if (message.name === 'generate_video' && (message.videoModelChoice?.status || message.videoModelChoiceStatus) === 'cancelled') return t('videoModel.cancelledTitle');
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
const VIDEO_ATTACHMENT_EXTENSION = /\.(mp4|webm|mov|m4v)$/i;
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

function attachmentPreviewNode({ name, dataUrl, url, lightbox = false, assetId = '', kind = '' } = {}) {
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

  // A video that is stored in the chat (sent from the node view or uploaded) shows like the videos of tool results:
  // player with the first frame, controls and the asset id. Videos that are only attached to the composer stay chips.
  if (url && (kind === 'video' || VIDEO_ATTACHMENT_EXTENSION.test(cleanUrl || fileName))) {
    return videoCard({ id: assetId || fileName, url });
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

/* ---------- results sent from the node view ---------- */

// Messages sent with "Send to chat" carry `origin` (workflow, node, ports, texts). Older messages hold the same
// information as plain German text; originOf() reads both so the chat shows one card instead of the raw note.
const LEGACY_ORIGIN_PATTERN = /^\[Workflow «([\s\S]+?)»\] Ergebnis «([\s\S]+?)» aus der Node-Ansicht uebernommen\.(?:\nGespeichert als Asset ([^\n]*)\.)?(?:\nText:\n([\s\S]*))?$/;

function originOf(message) {
  const origin = message.origin;
  if (origin && typeof origin === 'object' && origin.kind === 'workflow') {
    return {
      workflowId: typeof origin.workflowId === 'string' ? origin.workflowId : '',
      workflowName: String(origin.workflowName || ''),
      nodeLabel: String(origin.nodeLabel || ''),
      nodeType: String(origin.nodeType || ''),
      ports: Array.isArray(origin.ports) ? origin.ports : [],
      texts: Array.isArray(origin.texts) ? origin.texts : [],
      canOpen: origin.canOpen === true
    };
  }
  const match = LEGACY_ORIGIN_PATTERN.exec(textFromContent(message.content));
  if (!match) return null;
  return {
    workflowId: '',
    workflowName: match[1],
    nodeLabel: match[2],
    nodeType: '',
    ports: [],
    texts: match[4] ? [{ port: '', text: match[4] }] : [],
    canOpen: false
  };
}

function i18nHas(key) {
  const dictionaries = window.I18N || {};
  return Boolean(dictionaries[getLang()]?.[key] ?? dictionaries.de?.[key]);
}

function humanizePortId(id) {
  const text = String(id || '').replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function originPortLabel(portId) {
  const key = `nodes.port.${portId}`;
  return i18nHas(key) ? t(key) : humanizePortId(portId);
}

// Hover help of a port, same lookup order as the node view (node type, port id, port type); '' when there is none.
function originPortHelp(origin, port) {
  if (!port || !port.id) return '';
  const base = ['image', 'video', 'audio', 'number', 'text'].includes(port.type) ? port.type : 'any';
  const keys = [
    origin.nodeType && `nodes.portdesc.${origin.nodeType}.${port.id}.out`,
    origin.nodeType && `nodes.portdesc.${origin.nodeType}.${port.id}`,
    `nodes.portdesc.${port.id}.out`,
    `nodes.portdesc.${port.id}`,
    `nodes.portdesc.type.${base}.out`
  ].filter(Boolean);
  const key = keys.find(i18nHas);
  return key ? t(key) : '';
}

function originCardNode(message, assetMap) {
  const origin = originOf(message);
  if (!origin) return null;
  const { wrap, bubble } = messageShell('user');
  bubble.classList.add('origin-card');

  const head = document.createElement('div');
  head.className = 'origin-head';
  const title = document.createElement('span');
  title.className = 'origin-title';
  title.textContent = t('origin.head', { workflow: origin.workflowName || '…' });
  head.appendChild(title);
  if (origin.nodeLabel) {
    const node = document.createElement('span');
    node.className = 'origin-node';
    node.textContent = `· ${origin.nodeLabel}`;
    head.appendChild(node);
  }
  if (origin.workflowId && origin.canOpen) {
    const link = document.createElement('a');
    link.className = 'origin-open';
    link.href = `#w=${encodeURIComponent(origin.workflowId)}`;
    link.textContent = t('origin.open');
    link.title = t('origin.openTitle');
    head.appendChild(link);
  }
  bubble.appendChild(head);

  const ids = Array.isArray(message.uploadIds) ? message.uploadIds.filter((id) => typeof id === 'string') : [];
  const grid = document.createElement('div');
  grid.className = 'asset-grid origin-media';
  for (const id of ids) {
    const asset = assetMap.get(id);
    if (asset) grid.appendChild(mediaCard(asset));
  }
  if (grid.children.length) bubble.appendChild(grid);

  const portsById = new Map(origin.ports.map((port) => [port && port.id, port]));
  for (const part of origin.texts) {
    const text = String(part && part.text || '');
    if (!text) continue;
    const details = document.createElement('details');
    details.className = 'origin-text';
    const summary = document.createElement('summary');
    const port = part.port ? portsById.get(part.port) || { id: part.port } : null;
    summary.textContent = port ? t('origin.textSummary', { port: originPortLabel(port.id) }) : t('origin.textSummaryPlain');
    const help = port ? originPortHelp(origin, port) : '';
    if (help) summary.title = help;
    const body = document.createElement('div');
    body.className = 'origin-text-body';
    body.textContent = text;
    details.append(summary, body);
    bubble.appendChild(details);
  }

  const note = document.createElement('div');
  note.className = 'origin-note';
  note.textContent = ids.length ? t('origin.noteAssets', { ids: ids.join(', ') }) : t('origin.noteText');
  bubble.appendChild(note);
  return wrap;
}

function renderDetail() {
  const detail = state.detail;
  el.messages.innerHTML = '';
  renderJobStatusBar();
  renderVideoModelHint();
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
      const originCard = originCardNode(message, assetMap);
      if (originCard) {
        el.messages.appendChild(originCard);
        continue;
      }
      const { wrap, bubble } = messageShell('user');
      if (Array.isArray(message.uploadIds) && message.uploadIds.length) {
        const row = document.createElement('div');
        row.className = 'upload-row';
        for (const id of message.uploadIds) {
          const asset = assetMap.get(id);
          if (!asset) continue;
          const originalName = /^Upload:\s*(.+)$/.exec(String(asset.prompt || ''))?.[1];
          row.appendChild(attachmentPreviewNode({ name: originalName || asset.file, url: asset.url, lightbox: true, assetId: asset.id, kind: asset.kind }));
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
      if (message.videoModelChoice) wrap.appendChild(videoModelChoiceCard(message.videoModelChoice));

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
            model: job.model || asset?.model || null,
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
  state.costsAmountText = formatSummaryCost(data.mine ? data.mine.currentMonth : data.currentMonth);
  OCShell.refresh();
  el.costsBody.replaceChildren();

  if (data.scope) {
    const scope = document.createElement('p');
    scope.className = 'settings-hint costs-scope';
    scope.textContent = t(data.scope === 'own' ? 'costs.scopeOwn' : 'costs.scopeAll');
    el.costsBody.appendChild(scope);
  }

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
  // Every paid action changes what a participant has left: the menu and the banner follow.
  if (OCAccess.me().restricted) OCAccess.refreshMe().catch(() => {});
}

function openCostsModal() {
  el.costsModal.classList.remove('hidden');
  el.costsClose.focus();
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

function resetChatGPTDisconnect() {
  if (state.chatgptDisconnectTimer) clearTimeout(state.chatgptDisconnectTimer);
  state.chatgptDisconnectTimer = null;
  state.chatgptDisconnectPending = false;
  el.chatgptDisconnect.textContent = t('chatgpt.disconnect');
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

function formatChatGPTExpiry(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLang(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function renderChatGPTStatus() {
  const status = state.chatgpt || {};
  const connected = Boolean(status.connected);
  el.chatgptStatusDot.classList.toggle('connected', connected);
  if (connected) {
    const connection = status.plan
      ? t('chatgpt.connectedAs', { plan: status.plan })
      : t('chatgpt.connected');
    const expiry = formatChatGPTExpiry(status.expiresAt);
    el.chatgptStatusText.textContent = [
      connection,
      expiry ? t('chatgpt.validUntil', { date: expiry }) : ''
    ].filter(Boolean).join(' · ');
  } else {
    el.chatgptStatusText.textContent = t('chatgpt.disconnected');
  }
  el.chatgptImport.classList.toggle('hidden', connected);
  el.chatgptDisconnect.classList.toggle('hidden', !connected);
  el.chatgptImport.disabled = false;
}

async function importChatGPT() {
  resetChatGPTDisconnect();
  el.chatgptImport.disabled = true;
  showSettingsFeedback('');
  try {
    state.chatgpt = await api('/api/chatgpt/import', { method: 'POST', body: '{}' });
    renderChatGPTStatus();
    await refreshRuntimeConfigStatus();
    showSettingsFeedback(t('chatgpt.importedFeedback'));
  } catch (err) {
    showSettingsFeedback(t('chatgpt.importFailed', { error: err.message }), { error: true });
  } finally {
    el.chatgptImport.disabled = false;
  }
}

async function disconnectChatGPT() {
  if (!state.chatgptDisconnectPending) {
    resetChatGPTDisconnect();
    state.chatgptDisconnectPending = true;
    el.chatgptDisconnect.textContent = t('chatgpt.reallyDisconnect');
    state.chatgptDisconnectTimer = setTimeout(resetChatGPTDisconnect, 3000);
    return;
  }
  el.chatgptDisconnect.disabled = true;
  showSettingsFeedback('');
  try {
    state.chatgpt = await api('/api/chatgpt/disconnect', { method: 'POST', body: '{}' });
    resetChatGPTDisconnect();
    renderChatGPTStatus();
    await refreshRuntimeConfigStatus();
    showSettingsFeedback(t('chatgpt.disconnectedFeedback'));
  } catch (err) {
    showSettingsFeedback(t('chatgpt.disconnectFailed', { error: err.message }), { error: true });
  } finally {
    el.chatgptDisconnect.disabled = false;
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
  if (!offeredBrainModels().includes(state.brainModel)) {
    selectBrain(state.config.defaultBrain, { remember: false });
  } else {
    renderToolsMenu();
  }
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

// "Ask for the video model before every video": a plain switch next to the keys (saved like the other settings).
function renderVideoAskToggle() {
  el.videoAskToggle.checked = state.preferences.askVideoModel !== false;
}

async function saveVideoAskToggle() {
  const wanted = el.videoAskToggle.checked;
  el.videoAskToggle.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api('/api/settings/preferences', {
      method: 'PUT',
      body: JSON.stringify({ name: 'askVideoModel', value: wanted })
    });
    state.preferences = { ...state.preferences, ...(data.preferences || {}) };
    showSettingsFeedback(t('settings.videoAskSaved'));
    refreshRuntimeConfigStatus().then(() => renderVideoModelHint()).catch(() => {});
  } catch (err) {
    el.videoAskToggle.checked = !wanted;
    showSettingsFeedback(t('settings.videoAskFailed', { error: err.message }), { error: true });
  } finally {
    el.videoAskToggle.disabled = false;
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
    const [settingsData, adminsData, renderNodesData, higgsfieldData, chatgptData] = await Promise.all([
      api('/api/settings'),
      api('/api/admins'),
      api('/api/rendernodes'),
      api('/api/higgsfield/status'),
      api('/api/chatgpt/status')
    ]);
    state.settings = Array.isArray(settingsData.keys) ? settingsData.keys : [];
    state.preferences = { askVideoModel: true, ...(settingsData.preferences || {}) };
    state.admins = Array.isArray(adminsData.admins) ? adminsData.admins : [];
    state.renderNodes = Array.isArray(renderNodesData.nodes) ? renderNodesData.nodes : [];
    state.higgsfield = higgsfieldData;
    state.chatgpt = chatgptData;
    state.settingsAvailable = true;
    OCShell.refresh();
    renderSettings();
    renderVideoAskToggle();
    renderAdmins();
    loadUsers();
    // Teams (trainings with a budget): only with user management, only for admins.
    if (OCAccess.isActive() && OCAccess.me().isAdmin) OCTeams.mount(document.getElementById('settingsTeamsSlot'));
    renderRenderNodes();
    renderHiggsfieldStatus();
    renderChatGPTStatus();
    return true;
  } catch (_) {
    state.settings = [];
    state.admins = [];
    state.renderNodes = [];
    state.higgsfield = { connected: false, refreshExpiresAt: null, pending: false };
    state.chatgpt = { connected: false, plan: null, expiresAt: null, models: [] };
    state.settingsAvailable = false;
    OCShell.refresh();
    el.settingsModal.classList.add('hidden');
    return false;
  }
}

async function openSettingsModal(tab) {
  resetSettingsDelete();
  resetAdminDelete();
  resetUserDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  resetChatGPTDisconnect();
  showSettingsFeedback('');
  renderSettings();
  renderAdmins();
  renderRenderNodes();
  renderHiggsfieldStatus();
  renderChatGPTStatus();
  el.settingsModal.classList.remove('hidden');
  selectSettingsTab(typeof tab === 'string' ? tab : currentSettingsTab());
  el.settingsClose.focus();
  const available = await loadSettingsAccess();
  if (available) {
    selectSettingsTab(typeof tab === 'string' ? tab : currentSettingsTab());
    OCTeams.load();
  }
}

// The settings are three groups (services, people, rendering). A group without a visible section has no tab.
function settingsGroups() {
  return [...el.settingsModal.querySelectorAll('[data-settings-group]')];
}

function settingsGroupHasContent(group) {
  return [...group.children].some((child) => !child.classList.contains('hidden') && !(child.classList.contains('settings-slot') && !child.children.length));
}

function currentSettingsTab() {
  return el.settingsModal.querySelector('.settings-tab.active')?.dataset.settingsTab || 'services';
}

function selectSettingsTab(name) {
  const tabs = [...el.settingsModal.querySelectorAll('[data-settings-tab]')];
  const available = new Set(settingsGroups().filter(settingsGroupHasContent).map((group) => group.dataset.settingsGroup));
  const target = available.has(name) ? name : [...available][0] || 'services';
  for (const tab of tabs) {
    const on = tab.dataset.settingsTab === target;
    tab.classList.toggle('hidden', !available.has(tab.dataset.settingsTab));
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const group of settingsGroups()) group.classList.toggle('hidden', group.dataset.settingsGroup !== target);
  el.settingsTabs.classList.toggle('hidden', available.size < 2);
}

function closeSettingsModal() {
  resetSettingsDelete();
  resetAdminDelete();
  resetUserDelete();
  resetRenderNodeDelete();
  resetHiggsfieldDisconnect();
  resetChatGPTDisconnect();
  showSettingsFeedback('');
  el.settingsModal.classList.add('hidden');
}

/* ---------- user management (only with AUTH_WHOAMI_URL; see public/access-client.js) ---------- */

const SHARING_FIELDS = ['owner', 'ownerIsAdmin', 'unowned', 'mine', 'shareMode', 'sharedCount', 'sharedWith', 'canManage', 'canShare'];

function sessionMetaFromDetail(session) {
  const meta = {
    id: session.id,
    title: session.title,
    folder: session.folder || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
  for (const key of SHARING_FIELDS) if (key in session) meta[key] = session[key];
  return meta;
}

// Breadcrumb "Project / chat title", owner chip (somebody else's chat only) and share status of the open chat.
function renderSessionHeader() {
  const session = state.currentId ? state.detail?.session : null;
  updateCurrentLocation();
  const chip = session ? OCAccess.ownerChip(session) : null;
  el.sessionOwner.replaceChildren();
  if (chip) el.sessionOwner.appendChild(chip);
  el.sessionOwner.classList.toggle('hidden', !chip);
  updateShareButton();
}

function updateCurrentLocation() {
  const session = state.currentId ? state.detail?.session || null : null;
  el.currentProjectName.textContent = session?.folder || t('location.noProject');
  el.currentProjectName.classList.toggle('muted', !session?.folder);
  if (el.sessionTitle.isConnected) el.sessionTitle.textContent = session ? session.title || t('sessions.new') : t('location.noChat');
  // A click on the title renames the chat, for whoever may manage it.
  const canRename = Boolean(session) && session.canManage !== false;
  el.sessionTitle.classList.toggle('renamable', canRename);
  if (canRename) el.sessionTitle.setAttribute('tabindex', '0');
  else el.sessionTitle.removeAttribute('tabindex');
  el.sessionTitle.setAttribute('role', canRename ? 'button' : 'text');
  const owner = session?.mine === false && session.owner ? t('sharing.ownedBy', { name: session.owner }) : '';
  el.sessionTitle.title = [canRename ? t('sessions.rename') : '', owner].filter(Boolean).join(' · ');
}

// Same inline rename as in the side menu, on the title in the header.
function startHeaderRename() {
  const session = state.detail?.session;
  if (!session || session.canManage === false || !el.sessionTitle.isConnected || state.streaming) return;
  const current = session.title || t('sessions.new');
  const input = document.createElement('input');
  input.className = 'location-rename-input';
  input.type = 'text';
  input.maxLength = 120;
  input.value = current;
  input.setAttribute('aria-label', t('sessions.rename'));
  el.sessionTitle.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const nextTitle = input.value.trim();
    input.replaceWith(el.sessionTitle);
    if (save && nextTitle && nextTitle !== current) {
      const meta = state.sessions.find((item) => item.id === session.id) || { id: session.id, title: session.title };
      try {
        await patchSessionMeta(meta, { title: nextTitle });
      } catch (err) {
        setStatusI18n('sessions.renameFailed', { error: err.message });
      }
    } else if (save && !nextTitle) {
      setStatusI18n('sessions.titleEmpty');
    }
    updateCurrentLocation();
    el.sessionTitle.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// The project in the breadcrumb leads to it in the side menu.
function revealCurrentProject() {
  const folder = state.detail?.session?.folder || '';
  if (folder && state.collapsedFolders.delete(folder)) {
    saveCollapsedFolders();
    renderSessions();
  }
  if (sidebarDrawerMedia.matches) setMobileSidebarOpen(true);
  requestAnimationFrame(() => {
    const target = folder
      ? [...el.sessionList.querySelectorAll('.session-folder-name')].find((node) => node.textContent === folder)
      : el.sessionList.querySelector('.session-item.active');
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
  });
}

// "Geteilt" is a status with a green dot; in somebody else's chat it reads "Geteilt mit dir". Whoever may not
// manage the sharing sees the status without a button.
function updateShareButton() {
  const session = state.currentId ? state.detail?.session : null;
  const active = OCAccess.isActive() && Boolean(session);
  const canShare = active && session.canShare === true;
  const shared = active && !session.unowned && session.shareMode !== 'private';
  el.shareBtn.classList.toggle('hidden', !(canShare || shared));
  if (!(canShare || shared)) return;
  const label = !shared ? t('sharing.button') : session.mine === false && !canShare ? t('sharing.buttonSharedWithYou') : t('sharing.buttonShared');
  el.shareBtn.classList.toggle('btn-share-active', shared);
  el.shareBtn.disabled = !canShare;
  el.shareBtnLabel.textContent = label;
  el.shareBtn.setAttribute('aria-label', label);
  el.shareBtn.title = canShare ? `${t('sharing.buttonTitle')} · ${OCAccess.stateText(session)}` : `${label} · ${OCAccess.stateText(session)}`;
  OCShell.refresh();
}

function applySessionSharing(id, fields) {
  const meta = state.sessions.find((session) => session.id === id);
  if (meta) Object.assign(meta, fields);
  if (state.currentId === id && state.detail?.session) Object.assign(state.detail.session, fields);
  renderSessions();
  renderSessionHeader();
  setStatusI18n('sharing.saved');
}

async function openShareForSession(entry) {
  try {
    await OCAccess.openShareModal({
      kind: 'session',
      id: entry.id,
      entry,
      onSaved: (fields) => applySessionSharing(entry.id, fields),
      onGone: () => handleSessionGone(entry.id)
    });
  } catch (err) {
    setStatus(err.userMessage || err.message);
  }
}

// A chat the person may no longer open (the owner took the sharing back, or it is gone): leave it quietly.
async function handleSessionGone(id) {
  const wasOpen = state.currentId === id;
  if (wasOpen) {
    state.currentId = null;
    state.detail = null;
    setSessionHash(null);
    scheduleJobPolling();
  }
  await loadSessions().catch(() => {});
  if (wasOpen) {
    try {
      if (state.sessions.length) await openSession(state.sessions[0].id);
      else await createSession();
    } catch (err) {
      setStatus(err.message);
    }
  }
  setStatusI18n('sessions.lostAccess');
}

// The sharing can be taken back at any time; a cheap read when the window comes back tells whether the open chat is still ours.
async function verifyCurrentSession() {
  if (!OCAccess.isActive() || !state.currentId || state.streaming) return;
  const id = state.currentId;
  try {
    await api(`/api/sessions/${id}/jobs`);
  } catch (err) {
    if (err.status === 404 && state.currentId === id) await handleSessionGone(id);
  }
}

// Role dependent parts of the interface. The menu itself (avatar, costs, settings, help, language, sign-out) is
// public/shell.js, shared with the node view.
function renderAccount() {
  const me = OCAccess.me();
  document.body.classList.toggle('user-management', me.active);
  document.body.classList.toggle('no-admin', me.active && !me.isAdmin);
  // With user management the cost button moves into the menu (it shows the person's own costs).
  el.costsBtn.classList.toggle('hidden', me.active);
  el.usersSection.classList.toggle('hidden', !(me.active && me.isAdmin));
  el.settingsMonitoringLink.classList.toggle('hidden', !me.isSuperAdmin);
  renderRestrictedView(me);
  renderBudgetBanner();
  OCAccess.renderLoginBanner();
  OCShell.refresh();
}

// Participants and guests: no entry into what the server refuses them (brandings, GTS, ChatGPT subscription models,
// custom templates). The server still enforces it; this only keeps them out of dead ends. Admins and internal
// people see everything as before.
function renderRestrictedView(me) {
  const restricted = Boolean(me.active && me.restricted);
  document.body.classList.toggle('restricted-view', restricted);
  el.brandingsBtn.classList.toggle('hidden', restricted);
  for (const list of [el.contextBrandings, el.folderProfileBrandings]) list.closest('.modal-section')?.classList.toggle('hidden', restricted);
  const contextTitle = el.contextModal.querySelector('.modal-head h2');
  if (contextTitle) {
    const key = restricted ? 'context.titleRestricted' : 'context.title';
    contextTitle.setAttribute('data-i18n', key);
    contextTitle.textContent = t(key);
  }
  el.contextGtsSection.classList.toggle('hidden', !gtsEnabled());
  el.folderProfileGtsSection.classList.toggle('hidden', !gtsEnabled());
}

// The models the chat may offer: no ChatGPT subscription models for participants and guests (the server filters
// /api/config as well).
function offeredBrainModels() {
  const restricted = Boolean(OCAccess.me().active && OCAccess.me().restricted);
  return (state.config?.brainModels || []).filter((model) => !(restricted && String(model).startsWith('chatgpt/')));
}

// Participants and guests: a line above the chat says when the budget is used up or running low. Chats and results
// stay readable; only paid actions are locked (the server enforces it, this only explains).
function renderBudgetBanner() {
  const me = OCAccess.me();
  const lines = me.restricted && me.budget ? OCAccess.budgetLines(me.budget) : null;
  let message = '';
  if (lines) {
    if (me.role === 'guest') message = t('budget.bannerGuest');
    else if (lines.exhausted) message = t('budget.banner');
    else if (lines.low) message = t('budget.bannerLow', { remaining: OCAccess.formatUsd(lines.remaining) });
  }
  el.budgetBanner.textContent = message;
  el.budgetBanner.classList.toggle('hidden', !message);
  el.budgetBanner.classList.toggle('is-low', Boolean(lines && !lines.exhausted && me.role !== 'guest'));
}

// The team list in the settings: automatic entries with first and last seen, entries added by admins removable.
function resetUserDelete() {
  if (state.userDeleteTimer) clearTimeout(state.userDeleteTimer);
  state.userDeleteTimer = null;
  state.pendingUserDeleteEmail = null;
  for (const button of el.usersList.querySelectorAll('[data-user-delete]')) button.textContent = t('common.delete');
}

function renderUsers() {
  el.usersList.replaceChildren();
  if (!state.users.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = t('users.empty');
    el.usersList.appendChild(empty);
    return;
  }
  for (const user of state.users) {
    const row = document.createElement('div');
    row.className = 'admin-row user-row';
    const copy = document.createElement('div');
    copy.className = 'user-row-copy';
    const email = document.createElement('span');
    email.className = 'admin-email';
    email.textContent = user.email;
    email.title = user.email;
    const meta = document.createElement('span');
    meta.className = 'user-row-meta';
    meta.textContent = user.lastSeen
      ? [user.firstSeen ? t('users.firstSeen', { date: formatDate(user.firstSeen) }) : '', t('users.lastSeen', { date: formatDate(user.lastSeen) })].filter(Boolean).join(' · ')
      : t('users.neverSeen');
    copy.append(email, meta);
    row.appendChild(copy);

    const sources = Array.isArray(user.sources) ? user.sources : [];
    const badge = document.createElement('span');
    badge.className = 'admin-source-badge';
    if (user.role === 'admin') badge.textContent = sources.includes('superadmin') ? t('account.roleSuperadmin') : t('sharing.admin');
    else badge.textContent = sources.includes('settings') ? t('users.sourceSettings') : t('users.sourceSeen');
    row.appendChild(badge);
    if (user.removable) {
      const remove = managerAction(t('common.delete'), () => deleteUser(user.email, remove), { danger: true });
      remove.dataset.userDelete = user.email;
      row.appendChild(remove);
    }
    el.usersList.appendChild(row);
  }
}

// Several addresses at once (Excel column, mail recipients ...): the same paste box as for the teams.
function mountUsersPaste() {
  if (state.usersPaste) return;
  state.usersPaste = OCTeams.userPaste({
    existing: () => state.users.map((user) => user.email),
    add: (emails) => api('/api/users', { method: 'POST', body: JSON.stringify({ emails }) }),
    onResult: (answer) => {
      if (!answer || !Array.isArray(answer.users)) return;
      state.users = answer.users;
      resetUserDelete();
      renderUsers();
    }
  });
  el.usersPasteSlot.replaceChildren(state.usersPaste.element);
}

async function loadUsers() {
  if (!OCAccess.isActive() || !OCAccess.me().isAdmin) return;
  try {
    const data = await api('/api/users');
    state.users = Array.isArray(data.users) ? data.users : [];
    mountUsersPaste();
    renderUsers();
  } catch (err) {
    showSettingsFeedback(t('users.loadFailed', { error: err.message }), { error: true });
  }
}

async function addUser() {
  el.userAdd.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api('/api/users', { method: 'POST', body: JSON.stringify({ email: el.userEmail.value }) });
    state.users = Array.isArray(data.users) ? data.users : [];
    el.userForm.reset();
    resetUserDelete();
    renderUsers();
    showSettingsFeedback(t('users.added'));
    el.userEmail.focus();
  } catch (err) {
    showSettingsFeedback(t('users.addFailed', { error: err.message }), { error: true });
  } finally {
    el.userAdd.disabled = false;
  }
}

async function deleteUser(email, button) {
  if (state.pendingUserDeleteEmail !== email) {
    resetUserDelete();
    state.pendingUserDeleteEmail = email;
    button.textContent = t('common.reallyDelete');
    state.userDeleteTimer = setTimeout(resetUserDelete, 3000);
    return;
  }
  button.disabled = true;
  showSettingsFeedback('');
  try {
    const data = await api(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
    state.users = Array.isArray(data.users) ? data.users : [];
    resetUserDelete();
    renderUsers();
    showSettingsFeedback(t('users.deleted'));
  } catch (err) {
    button.disabled = false;
    showSettingsFeedback(t('users.deleteFailed', { error: err.message }), { error: true });
  }
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
  // User management: somebody else's chat shows the owner (full address in the tooltip), a shared chat its badge.
  const foreignOwner = OCAccess.ownerName(meta);
  if (foreignOwner) {
    const owner = document.createElement('span');
    owner.className = 'session-item-owner';
    owner.textContent = foreignOwner.text;
    owner.title = foreignOwner.title;
    date.appendChild(owner);
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
    if (OCAccess.canAdminister()) {
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
    }
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
  el.brandingsClose.focus();
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

function activeJobs() {
  return (state.detail?.jobs || []).filter(
    (job) => job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled'
  );
}

function jobTypeLabel(job) {
  if (job.source === 'higgsfield' || job.provider === 'higgsfield') return t('jobs.typeHiggsfield');
  if (job.source === 'rendernode') return t('jobs.typeRender');
  return t('jobs.typeVideo');
}

function jobStatusLabel(job) {
  return ['running', 'in_progress', 'processing'].includes(String(job.status || '').toLowerCase())
    ? t('jobs.statusRunning')
    : t('jobs.statusWaiting');
}

function renderJobStatusBar() {
  const jobs = activeJobs();
  el.jobStatusBar.classList.toggle('hidden', jobs.length === 0);
  el.jobStatusList.replaceChildren();
  if (!jobs.length) {
    if (jobElapsedTimer) clearInterval(jobElapsedTimer);
    jobElapsedTimer = null;
    return;
  }

  for (const job of jobs) {
    const item = document.createElement('div');
    item.className = 'job-status-item';

    const id = document.createElement('strong');
    id.className = 'job-status-id';
    id.textContent = job.assetId;

    const type = document.createElement('span');
    type.className = 'job-status-type';
    type.textContent = jobTypeLabel(job);

    const status = document.createElement('span');
    status.className = 'job-status-state';
    status.textContent = jobStatusLabel(job);

    const elapsed = document.createElement('time');
    elapsed.className = 'job-status-elapsed';
    elapsed.dataset.startedAt = job.startedAt || job.createdAt || job.submittedAt || '';
    elapsed.textContent = formatElapsedClock(elapsed.dataset.startedAt);

    item.append(id, type, status, elapsed);
    if (job.source === 'rendernode' && (job.nodeName || job.nodeId || job.renderNodeId)) {
      const node = document.createElement('span');
      node.className = 'job-status-node';
      node.textContent = t('jobs.node', { name: job.nodeName || job.nodeId || job.renderNodeId });
      item.appendChild(node);
    }
    el.jobStatusList.appendChild(item);
  }

  if (!jobElapsedTimer) jobElapsedTimer = setInterval(updateJobElapsedTimes, 1000);
}

function updateJobElapsedTimes() {
  for (const elapsed of el.jobStatusList.querySelectorAll('.job-status-elapsed')) {
    elapsed.textContent = formatElapsedClock(elapsed.dataset.startedAt);
  }
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
      else {
        state.detail.jobs = data.jobs || [];
        renderJobStatusBar();
      }
      if (!(data.jobs || []).some((j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled')) {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
      }
    } catch (err) {
      // With user management the chat can vanish for this person; anything else is transient.
      if (err.status === 404 && OCAccess.isActive()) handleSessionGone(state.currentId);
    }
  }, JOB_POLL_MS);
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
  if (event.type === 'status') {
    setStreamPhase(event.phase, event.toolName);
    return;
  }
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
    setStreamPhase('tool', event.tool);
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
  if (event.type === 'video_model_choice' && event.choice) {
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    node.appendChild(chip(t('tools.videoChoosing'), false, false));
    node.appendChild(videoModelChoiceCard(event.choice));
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
    grid.appendChild(jobCard({ assetId: event.assetId, status: 'pending', kind: event.kind || 'video', model: event.model }));
    node.appendChild(grid);
    appendLiveNode(node);
    if (state.detail) {
      const liveJob = {
        jobId: event.jobId,
        assetId: event.assetId,
        prompt: event.prompt,
        status: event.status || 'pending',
        source: event.source || null,
        provider: event.provider || null,
        kind: event.kind || 'video',
        model: event.model || null,
        createdAt: event.createdAt || new Date().toISOString(),
        startedAt: event.startedAt || null,
        renderNodeId: event.renderNodeId || null,
        nodeId: event.nodeId || event.renderNodeId || null,
        nodeName: event.nodeName || null
      };
      const index = (state.detail.jobs || []).findIndex((job) => job.jobId === liveJob.jobId);
      if (index >= 0) state.detail.jobs[index] = liveJob;
      else state.detail.jobs.push(liveJob);
      renderJobStatusBar();
      scheduleJobPolling();
    }
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
    // Budget and role rules arrive with a code: say it in the interface language.
    const rule = event.code ? OCAccess.accountRuleMessage(event) : null;
    if (rule) OCAccess.refreshMe().catch(() => {});
    const message = rule || event.message;
    const node = document.createElement('div');
    node.className = 'msg tool';
    node.appendChild(chip(message || t('common.error'), false, true));
    appendLiveNode(node);
    if (message) setStatus(message);
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
  startStreamHeartbeat();

  try {
    const res = await fetch(rel(`/api/sessions/${state.currentId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: messageText, brainModel: state.brainModel, attachments, renderMode, brandingWizard })
    });
    if (!res.ok || !res.body) {
      let message = `HTTP ${res.status}`;
      let payload = null;
      try {
        payload = await res.json();
        if (payload.error) message = payload.error;
      } catch (_) {
        /* ignore */
      }
      const failure = new Error(message);
      failure.status = res.status;
      failure.code = payload && payload.code;
      failure.body = payload;
      throw failure;
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
            stopStreamHeartbeat();
            setStatus('');
          } else {
            handleEvent(parsed);
          }
        }
      }
    }
  } catch (err) {
    // A locked paid action (budget used up, feature not available) reads as a sentence in the interface language.
    const rule = OCAccess.accountRuleMessage(err);
    if (rule) OCAccess.refreshMe().catch(() => {});
    handleEvent({ type: 'error', message: rule || (err instanceof TypeError ? t('common.networkError') : err.message || t('send.connectionFailed')) });
  } finally {
    finishChips();
    state.streaming = false;
    stopStreamHeartbeat();
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
