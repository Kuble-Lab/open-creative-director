'use strict';

// Job polling, attachments, lightbox and streaming, moved from app.js. Loaded in index.html order.

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
      // a job of the own computers (WP46) waits in the queue until a computer or a render node takes it
      node.textContent = job.renderNodeId === 'render-queue' && !job.nodeName ? t('jobs.nodeWaiting') : t('jobs.node', { name: job.nodeName || job.nodeId || job.renderNodeId });
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
  if (event.type === 'notice') {
    const text = chatNoticeText(event);
    if (!text) return;
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    node.appendChild(chip(text, false, false));
    appendLiveNode(node);
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
  if (event.type === 'workflow_run' && event.run) {
    finishChips();
    live.textEl = null;
    const node = document.createElement('div');
    node.className = 'msg tool';
    node.appendChild(chip(t(`tools.workflow.${event.run.status}`), false, false));
    node.appendChild(workflowRunCard(event.run));
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
    grid.appendChild(jobCard({
      assetId: event.assetId,
      status: 'pending',
      kind: event.kind || 'video',
      model: event.model,
      modelName: event.modelName,
      estimateUsd: event.estimateUsd,
      estimateMinUsd: event.estimateMinUsd,
      billing: event.billing
    }));
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
        modelName: event.modelName || null,
        estimateUsd: event.estimateUsd ?? null,
        estimateMinUsd: event.estimateMinUsd ?? null,
        billing: event.billing || null,
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
    const message = rule || providerRuleMessage(event.code) || chatErrorMessage(event.code) || event.message;
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
    const language = window.getLang?.();
    const res = await fetch(rel(`/api/sessions/${state.currentId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiLang: ['de', 'en', 'es'].includes(language) ? language : 'en', text: messageText, brainModel: state.brainModel, attachments, renderMode, brandingWizard })
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

