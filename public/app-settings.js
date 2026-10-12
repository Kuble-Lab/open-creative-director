'use strict';

// Service settings, render nodes and user management, moved from app.js. Loaded in index.html order.

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

// Optional texts of a key: a readable name (settings.label.<NAME>) and a hint (settings.help.<NAME>). A key without them shows its
// name only, as before.
function settingsKeyText(kind, name) {
  const id = `settings.${kind}.${name}`;
  const text = t(id);
  return text && text !== id ? text : '';
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
    const readableName = settingsKeyText('label', key.name);
    const label = document.createElement('label');
    label.className = `settings-key-name${readableName ? ' is-readable' : ''}`;
    label.htmlFor = inputId;
    label.textContent = readableName || key.name;
    copy.appendChild(label);
    const status = document.createElement('div');
    status.className = `settings-key-status${key.source === 'settings' ? ' is-set' : ''}`;
    // a key with a readable name shows its technical name (the one of .env) next to the status
    status.textContent = readableName ? `${key.name} · ${settingsStatusText(key)}` : settingsStatusText(key);
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
    const help = settingsKeyText('help', key.name);
    if (help) {
      const note = document.createElement('p');
      note.className = 'settings-hint settings-key-help';
      note.textContent = help;
      row.appendChild(note);
    }
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
    state.renderAgents = Array.isArray(data.agents) ? data.agents : [];
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
    state.renderAgents = Array.isArray(data.agents) ? data.agents : [];
    resetRenderNodeDelete();
    renderRenderNodes();
    showSettingsFeedback(t('renderNodes.deleted'));
    scheduleRenderNodePolling(0);
  } catch (err) {
    showSettingsFeedback(t('renderNodes.deleteFailed', { error: err.message }), { error: true });
    setRenderNodeRowBusy(row, false);
  }
}

// The own computers of all people (WP46, public/render-agents-ui.js): shown and removable by admins under the render nodes.
function renderRenderAgentsAdmin() {
  OCRenderAgents.renderAdminList(document.getElementById('renderAgentsAdminList'), state.renderAgents, {
    onChanged: async (message, options) => {
      showSettingsFeedback(message, options);
      try {
        const data = await api('/api/rendernodes');
        state.renderNodes = Array.isArray(data.nodes) ? data.nodes : [];
        state.renderAgents = Array.isArray(data.agents) ? data.agents : [];
        renderRenderNodes();
      } catch (_) {
        /* the list stays as it was */
      }
    }
  });
}

function renderRenderNodes() {
  renderRenderAgentsAdmin();
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
    state.renderAgents = Array.isArray(data.agents) ? data.agents : [];
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
    state.renderAgents = Array.isArray(renderNodesData.agents) ? renderNodesData.agents : [];
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
    // render servers in the cloud (WP54, public/cloud-render-ui.js): settings and status for admins
    OCCloudRender.mount(document.getElementById('cloudRenderSlot'), { onFeedback: showSettingsFeedback });
    renderHiggsfieldStatus();
    renderChatGPTStatus();
    return true;
  } catch (_) {
    state.settings = [];
    state.admins = [];
    state.renderNodes = [];
    state.renderAgents = [];
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
  updateSessionCopies(id, fields);
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
    scheduleWorkflowRunPolling();
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

// The language models for the assistant of the node view: the list, the names and the default of the chat (the same
// models the person may choose for a chat; read when the panel needs them, the configuration may not be loaded yet).
window.OCBrain = {
  choices: () => ({
    models: offeredBrainModels(),
    defaultModel: String(state.config?.defaultBrain || ''),
    labelOf: (model) => brainLabel(model).shortName
  })
};

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

