'use strict';

// Brandings, cast, project memory and speaker voices, moved from app.js. Loaded in index.html order.

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

    if (OCAccess.canAdminister()) card.appendChild(brandingSpeakerBlock(branding));

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

// The speaker voice of a branding (WP38f): the list of the ElevenLabs voices with a play button, "no voice" and a short note on own voices.
// The list is loaded once per opening of the window (GET /api/nodes/options/elevenlabs-voices); saving is PATCH /api/brandings/:id.
const brandingVoices = { state: 'idle', options: [], status: 0 };

async function loadBrandingVoices() {
  if (brandingVoices.state === 'loading') return;
  brandingVoices.state = 'loading';
  try {
    const data = await api('/api/nodes/options/elevenlabs-voices');
    brandingVoices.options = (Array.isArray(data.options) ? data.options : []).map((option) => ({ ...option, value: String(option.value), label: String(option.label ?? option.value) }));
    brandingVoices.state = 'ready';
    brandingVoices.status = 0;
  } catch (err) {
    brandingVoices.options = [];
    brandingVoices.state = 'error';
    brandingVoices.status = err.status || 0;
  }
  if (!el.brandingsModal.classList.contains('hidden')) renderBrandingsManager();
}

async function saveBrandingSpeaker(branding, voiceId) {
  const option = brandingVoices.options.find((entry) => entry.value === voiceId);
  const speaker = voiceId ? { voiceId, name: option ? option.label : branding.speaker?.name || '' } : null;
  await api(`/api/brandings/${encodeURIComponent(branding.id)}`, { method: 'PATCH', body: JSON.stringify({ speaker }) });
  await loadBrandings();
  setStatusI18n(voiceId ? 'branding.speaker.saved' : 'branding.speaker.removed');
}

function brandingSpeakerBlock(branding) {
  const block = document.createElement('div');
  block.className = 'branding-speaker';
  const label = document.createElement('label');
  label.className = 'branding-speaker-label';
  label.textContent = t('branding.speaker.label');
  block.appendChild(label);
  const row = document.createElement('div');
  row.className = 'nv-voice-pick';
  const select = document.createElement('select');
  select.className = 'settings-input branding-speaker-select';
  select.setAttribute('aria-label', t('branding.speaker.label'));
  const none = document.createElement('option');
  none.value = '';
  none.textContent = brandingVoices.state === 'loading' || brandingVoices.state === 'idle' ? t('nodes.voice.loading') : t('branding.speaker.none');
  select.appendChild(none);
  const voices = window.OCDVoicePreview;
  const current = branding.speaker?.voiceId || '';
  for (const option of brandingVoices.options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = voices ? voices.optionText(option) : option.label;
    if (voices) item.title = voices.detailOf(option);
    select.appendChild(item);
  }
  // a voice that is not in the list (any more, or the list did not load) stays visible
  if (current && !brandingVoices.options.some((option) => option.value === current)) {
    const item = document.createElement('option');
    item.value = current;
    item.textContent = branding.speaker?.name || current;
    select.appendChild(item);
  }
  select.value = current;
  select.disabled = brandingVoices.state !== 'ready' && !current;
  row.appendChild(select);
  if (voices) {
    const play = voices.button({
      voice: () => {
        const value = select.value;
        return {
          value: value || '__none__',
          state: brandingVoices.state === 'ready' || brandingVoices.state === 'error' ? brandingVoices.state : 'loading',
          noKey: brandingVoices.status === 503,
          option: brandingVoices.options.find((option) => option.value === value) || null
        };
      },
      model: () => ''
    });
    select.addEventListener('change', () => play.refresh());
    row.appendChild(play.el);
  }
  select.addEventListener('change', () => {
    select.disabled = true;
    saveBrandingSpeaker(branding, select.value).catch((err) => {
      setStatus(err.message);
      renderBrandingsManager();
    });
  });
  block.appendChild(row);
  const hint = document.createElement('p');
  hint.className = 'branding-speaker-hint';
  hint.textContent = brandingVoices.state === 'error'
    ? t(brandingVoices.status === 503 ? 'nodes.voice.noKey' : 'nodes.voice.listFailed')
    : t('branding.speaker.hint');
  block.appendChild(hint);
  return block;
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
  if (OCAccess.canAdminister() && brandingVoices.state !== 'ready') loadBrandingVoices().catch(() => {});
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
  window.OCDVoicePreview?.stop();
  state.pendingBrandingDeleteId = null;
  state.highlightedBrandingId = null;
  el.brandingImportFile.value = '';
  el.brandingsModal.classList.add('hidden');
}

