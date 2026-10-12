'use strict';

// Shared state, prompt presets and helpers, moved from app.js. Loaded in index.html order.

const el = {
  sidebar: document.querySelector('.sidebar'),
  sidebarBackdrop: document.getElementById('sidebarBackdrop'),
  mobileMenuBtn: document.getElementById('mobileMenuBtn'),
  topbar: document.querySelector('.topbar'),
  currentProjectName: document.getElementById('currentProjectName'),
  sessionList: document.getElementById('sessionList'),
  sessionSearch: document.getElementById('sessionSearch'),
  sessionGrouping: document.getElementById('sessionGrouping'),
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
  'openai/gpt-6.1-sol': { shortName: '6.1 Sol', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-sol': { shortName: '5.6 Sol', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-sol-pro': { shortName: '5.6 Sol Pro', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-terra': { shortName: '5.6 Terra', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-terra-pro': { shortName: '5.6 Terra Pro', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-luna': { shortName: '5.6 Luna', hintKey: 'model.openrouter' },
  'openai/gpt-5.6-luna-pro': { shortName: '5.6 Luna Pro', hintKey: 'model.openrouter' },
  'anthropic/claude-fable-5': {
    shortName: 'Claude Fable 5',
    hintKey: 'model.fable'
  },
  'moonshotai/kimi-k3': { shortName: 'Kimi K3', hintKey: 'model.kimi' },
  'chatgpt/gpt-6.1-sol': { shortName: 'GPT 6.1 Sol (Abo)', hintKey: 'model.chatgptSubscription' },
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
  // Team view of the chat list (admins only, public/team-groups.js): the groups and, per group, the chats loaded so far.
  teamView: { groups: null, loading: false, error: null, pages: null },
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
  workflowRunTimer: null,
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
  renderAgents: [],
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

