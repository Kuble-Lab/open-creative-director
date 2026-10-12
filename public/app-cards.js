'use strict';

// Media, video model and workflow run cards, moved from app.js. Loaded in index.html order.

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

// The price line of a result: the real cost in USD, "Higgsfield credits" for Higgsfield (it bills in credits, not USD), and
// nothing for free local results (cost 0) or when no cost is known. No "$0.00" is ever shown as a cost.
// A cost that is only an estimate (fal list price, ElevenLabs flat rate per character) gets the same "about" as the
// estimate of a running video, so the line never passes an estimate off as the price the provider charged.
function assetPriceLabel(asset) {
  if (asset.billing === 'credits') return t('assets.credits');
  if (typeof asset.cost !== 'number' || !(asset.cost > 0)) return '';
  return asset.costEstimated === true ? t('jobs.estimate', { amount: formatCost(asset.cost) }) : formatCost(asset.cost);
}

// The model line: the readable name from the server; the full model id as the hover text. Providers' ids and names are
// foreign data, so everything goes in as text.
function assetModelNode(asset, className) {
  const name = String(asset.modelName || '').trim();
  if (!name) return null;
  const node = document.createElement('span');
  node.className = className;
  node.textContent = name;
  const id = String(asset.model || '').trim();
  node.title = id ? t('assets.model', { model: id }) : name;
  return node;
}

// One calm line under a result: "vid-002 · $0.84 · Kling v3.0". The same for images, video and audio.
function assetMeta(asset) {
  const meta = document.createElement('div');
  meta.className = 'asset-meta';
  const id = document.createElement('span');
  id.className = 'asset-id';
  id.textContent = asset.id;
  meta.appendChild(id);
  const price = assetPriceLabel(asset);
  if (price) {
    const costEl = document.createElement('span');
    costEl.className = 'asset-cost';
    costEl.textContent = price;
    meta.appendChild(costEl);
  }
  const modelEl = assetModelNode(asset, 'asset-model');
  if (modelEl) meta.appendChild(modelEl);
  return meta;
}

// The estimate of a running job, from the model card: "about $0.84" or "about $0.62–$0.84".
function jobEstimateLabel(job) {
  // null (no estimate) must not turn into 0: Number(null) is 0.
  const max = typeof job.estimateUsd === 'number' ? job.estimateUsd : NaN;
  if (!Number.isFinite(max) || max < 0) return '';
  const min = typeof job.estimateMinUsd === 'number' ? job.estimateMinUsd : NaN;
  const amount = Number.isFinite(min) && min >= 0 && max - min > 0.005 ? `${videoModelMoney(min)}–${videoModelMoney(max)}` : videoModelMoney(max);
  return t('jobs.estimate', { amount });
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
  const modelName = String(job.modelName || '').trim();
  if (failed) {
    // A known cause (the provider refused the image after the start) is said in the interface language.
    const detail = providerRuleMessage(job.errorCode) || job.error || t('jobs.unknownError');
    small.textContent = modelName ? `${detail} · ${modelName}` : detail;
  } else {
    // "Kling v3.0 · about $0.84 · usually takes 2–5 minutes"; Higgsfield shows its credits instead of a USD estimate.
    const parts = [];
    if (modelName) parts.push(modelName);
    const price = job.billing === 'credits' ? t('assets.credits') : jobEstimateLabel(job);
    if (price) parts.push(price);
    parts.push(t(parts.length ? 'jobs.durationInline' : 'jobs.duration'));
    small.textContent = parts.join(' · ');
  }
  const modelId = String(job.model || '').trim();
  if (modelId) small.title = t('assets.model', { model: modelId });
  body.appendChild(small);
  card.appendChild(body);
  return card;
}

/* ---------- Video model picker (card of the Director, lib/video-models.js) ---------- */

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

// A refusal of the video provider (VIDEO_REAL_PERSON: the image may show a real person; VIDEO_MODEL_REFUSED: that provider
// already refused this request) as a sentence in the interface language; null for any other code. The server sends the
// German sentence as a fallback in the same answer.
function providerRuleMessage(code) {
  const key = `videoModel.error.${code}`;
  return code && i18nHas(key) ? t(key) : null;
}

// A known failure of the chat itself (CHATGPT_UNAVAILABLE: the subscription is down and OpenRouter cannot take over) as a
// sentence in the interface language; null for any other code.
function chatErrorMessage(code) {
  const key = `chat.error.${code}`;
  return code && i18nHas(key) ? t(key) : null;
}

// A short notice of the server during an answer (a chip, no error): CHATGPT_REPLACED, BRAIN_MODEL_REPLACED.
function chatNoticeText(notice) {
  const key = `chat.notice.${notice.code}`;
  if (notice.code && i18nHas(key)) return t(key, { name: brainLabel(notice.model).shortName });
  return notice.message || '';
}

// The error a failed start left on the card, in the interface language where it is a known rule.
function videoModelErrorText(choice) {
  if (!choice.lastError) return '';
  const refusal = providerRuleMessage(choice.lastErrorCode);
  if (refusal) return refusal;
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
    const refusal = providerRuleMessage(error.code);
    status.textContent = refusal || t('videoModel.startFailed', { error: rule || error.message });
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
  // The provider of this model refused the image of the request: the model is closed for this request. The others are
  // highlighted as the way on.
  const refused = Boolean(option.refused);
  const suggested = !refused && !blocked && (choice.refusedProviders || []).length > 0;
  button.className = `vmc-option${option.recommended ? ' recommended' : ''}${blocked ? ' blocked' : ''}${refused ? ' refused' : ''}${suggested ? ' suggested' : ''}`;
  button.dataset.videoModel = option.id;
  button.disabled = locked || blocked || refused;
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
  if (refused) button.appendChild(textNode('span', 'vmc-blocked', t('videoModel.refusedOption')));
  else if (blocked) button.appendChild(textNode('span', 'vmc-blocked', videoModelBlockText(option)));
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
    if ((choice.refusedProviders || []).length) {
      // After a refusal: say what happened to the choice and what is left, with an idea when nothing is.
      card.appendChild(textNode('p', 'vmc-note', t(choice.noAlternative ? 'videoModel.noAlternative' : choice.noAffordable ? 'videoModel.noAffordable' : 'videoModel.refusedLead')));
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

/* ---------- Workflow runs (card of the Director, lib/workflow-runs.js) ---------- */

const WORKFLOW_RUN_POLL_MS = 4000;

function workflowRunDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? t('workflowRun.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('workflowRun.seconds', { seconds });
}

function workflowRunCredits(value) {
  return typeof value === 'number' && value > 0 ? t('workflowRun.credits', { credits: Number.isInteger(value) ? value : value.toFixed(1) }) : '';
}

// The total of the run as one phrase; an unknown price is never shown as 0.
function workflowRunTotal(run) {
  const totals = run.totals || {};
  const credits = workflowRunCredits(totals.credits);
  if (!run.paid) return t('workflowRun.totalFree');
  const usd = videoModelMoney(totals.usd);
  if (totals.unknownNodes > 0) {
    const known = totals.usd > 0 ? t('workflowRun.totalPartial', { amount: usd }) : t('workflowRun.totalUnknown');
    return credits ? `${known} + ${credits}` : known;
  }
  if (totals.usd > 0) return credits ? `${t('workflowRun.totalEstimate', { amount: usd })} + ${credits}` : t('workflowRun.totalEstimate', { amount: usd });
  return credits || t('workflowRun.totalUnknown');
}

function workflowRunStartLabel(run) {
  if (!run.paid) return t('workflowRun.start');
  const totals = run.totals || {};
  if (totals.unknownNodes > 0) return totals.usd > 0 ? t('workflowRun.startPartial', { amount: videoModelMoney(totals.usd) }) : t('workflowRun.startUnknown');
  if (totals.usd > 0) return t('workflowRun.startPrice', { amount: videoModelMoney(totals.usd) });
  const credits = workflowRunCredits(totals.credits);
  return credits ? t('workflowRun.startPrice', { amount: credits }) : t('workflowRun.startUnknown');
}

function workflowRunStepPrice(step) {
  if (typeof step.usd === 'number') return t('workflowRun.totalEstimate', { amount: videoModelMoney(step.usd) });
  if (typeof step.credits === 'number') return workflowRunCredits(step.credits);
  return t('workflowRun.priceUnknown');
}

function workflowRunErrorText(run) {
  if (!run.lastError) return '';
  const key = `workflowRun.error.${run.lastErrorCode}`;
  if (run.lastErrorCode && i18nHas(key)) return t(key);
  const rule = run.lastErrorCode ? OCAccess.accountRuleMessage({ code: run.lastErrorCode }) : null;
  return t('workflowRun.startFailed', { error: rule || run.lastError });
}

function workflowRunInputValue(input) {
  const wrap = document.createElement('div');
  wrap.className = 'wr-input-value';
  if (Array.isArray(input.media)) {
    const row = document.createElement('div');
    row.className = 'wr-thumbs';
    for (const item of input.media) {
      if (!item.url) {
        // a file that was in the workflow already: it has no address in this chat
        row.appendChild(textNode('span', 'wr-chip', t('workflowRun.fileInWorkflow')));
        continue;
      }
      if (item.type === 'image') {
        const img = document.createElement('img');
        img.src = rel(item.url);
        img.alt = input.label;
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(rel(item.url)));
        row.appendChild(img);
      } else if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = rel(item.url);
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        row.appendChild(video);
      } else {
        row.appendChild(textNode('span', 'wr-chip', t('workflowRun.audioFile')));
      }
    }
    wrap.appendChild(row);
    if (input.count > input.media.length) wrap.appendChild(textNode('span', 'wr-more', t('workflowRun.moreFiles', { count: input.count - input.media.length })));
  } else if (typeof input.text === 'string') {
    wrap.appendChild(textNode('span', 'wr-text', input.text));
  } else {
    const value = Array.isArray(input.value) ? input.value.join(', ') : typeof input.value === 'boolean' ? t(input.value ? 'workflowRun.yes' : 'workflowRun.no') : String(input.value);
    wrap.appendChild(textNode('span', 'wr-text', value));
  }
  return wrap;
}

function workflowRunOpenLink(run) {
  if (!run.workflowId) return null;
  const link = document.createElement('a');
  link.className = 'wr-open';
  link.href = `#w=${encodeURIComponent(run.workflowId)}`;
  link.textContent = t('workflowRun.open');
  return link;
}

function workflowRunBudgetBlock(run) {
  const block = run.blocked;
  if (!block) return '';
  if (block.reason === 'exhausted') return t('workflowRun.blockedExhausted');
  return t('workflowRun.blockedBudget', { estimate: videoModelMoney(block.needUsd), remaining: videoModelMoney(block.remainingUsd) });
}

async function afterWorkflowRunChange() {
  await Promise.all([refreshDetail(), loadSessions(), refreshCosts().catch(() => {})]);
  if (OCAccess.me().restricted) OCAccess.refreshMe().catch(() => {});
}

async function startWorkflowRun(run, card) {
  if (state.streaming || run.status !== 'pending' || !state.currentId || card.dataset.busy === '1') return;
  card.dataset.busy = '1';
  const buttons = [...card.querySelectorAll('button')];
  const line = card.querySelector('.wr-status');
  for (const button of buttons) button.disabled = true;
  line.textContent = t('workflowRun.starting');
  line.classList.remove('error');
  try {
    // The click says what this card showed; the server starts nothing when its estimate has moved on since.
    const totals = run.totals || {};
    const seen = { maxUsd: totals.usd || 0, maxCredits: totals.credits || 0, maxUnknownNodes: totals.unknownNodes || 0, rev: run.rev };
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/workflow-runs/${encodeURIComponent(run.id)}`, { method: 'POST', body: JSON.stringify(seen) });
    await afterWorkflowRunChange();
  } catch (error) {
    // The card may be out of date (price, budget, started elsewhere): the chat is read again and shows the reason.
    const rule = OCAccess.accountRuleMessage(error);
    if (rule) OCAccess.refreshMe().catch(() => {});
    const known = error.code && i18nHas(`workflowRun.error.${error.code}`) ? t(`workflowRun.error.${error.code}`) : null;
    line.textContent = known || t('workflowRun.startFailed', { error: rule || error.message });
    line.classList.add('error');
    // The buttons stay locked until the card is drawn again with what the server has now: a quick second click on the old
    // card would otherwise accept a new price that was never shown.
    await refreshDetail().catch(() => {});
    if (card.isConnected) {
      delete card.dataset.busy;
      for (const button of buttons) button.disabled = false;
    }
  }
}

async function cancelWorkflowRun(run, card) {
  if (!state.currentId || card.dataset.busy === '1') return;
  card.dataset.busy = '1';
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/workflow-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', body: '{}' });
    await refreshDetail();
  } catch (error) {
    const line = card.querySelector('.wr-status');
    line.textContent = error.message;
    line.classList.add('error');
    delete card.dataset.busy;
    for (const button of card.querySelectorAll('button')) button.disabled = false;
  }
}

function workflowRunCard(run) {
  const status = run.status || 'pending';
  const waiting = status === 'pending' || status === 'processing';
  const card = document.createElement('section');
  card.className = `workflow-run ${status}`;
  card.dataset.runId = run.id;
  card.setAttribute('aria-label', t('workflowRun.label'));

  const head = document.createElement('div');
  head.className = 'wr-head';
  head.appendChild(textNode('span', 'wr-kind', t('workflowRun.label')));
  head.appendChild(textNode('span', `wr-state ${status}`, t(`workflowRun.state.${status}`)));
  card.appendChild(head);
  card.appendChild(textNode('strong', 'wr-title', run.title || ''));
  const nodes = run.nodeCount === 1 ? t('workflowRun.nodeOne') : t('workflowRun.nodeMany', { count: run.nodeCount });
  card.appendChild(textNode('p', 'wr-meta', `${t(run.origin === 'template' ? 'workflowRun.originTemplate' : 'workflowRun.originWorkflow')} · ${nodes}`));
  if (run.created && run.mine) card.appendChild(textNode('p', 'wr-note', t('workflowRun.listNote')));

  if (waiting && (run.inputs || []).length) {
    const inputs = document.createElement('div');
    inputs.className = 'wr-inputs';
    inputs.appendChild(textNode('span', 'wr-section', t('workflowRun.inputs')));
    for (const input of run.inputs) {
      const row = document.createElement('div');
      row.className = 'wr-input';
      row.appendChild(textNode('span', 'wr-input-label', input.label));
      row.appendChild(workflowRunInputValue(input));
      inputs.appendChild(row);
    }
    card.appendChild(inputs);
  }

  if (waiting) {
    const steps = document.createElement('div');
    steps.className = 'wr-steps';
    if (run.paid) {
      steps.appendChild(textNode('span', 'wr-section', t('workflowRun.paidSteps')));
      const list = document.createElement('ul');
      for (const step of run.paidSteps || []) {
        const item = document.createElement('li');
        item.appendChild(textNode('span', 'wr-step-name', step.label));
        item.appendChild(textNode('span', 'wr-step-price', workflowRunStepPrice(step)));
        list.appendChild(item);
      }
      steps.appendChild(list);
    } else {
      steps.appendChild(textNode('span', 'wr-section', t('workflowRun.noPaid')));
    }
    if (run.localSteps > 0) steps.appendChild(textNode('p', 'wr-local', t(run.localSteps === 1 ? 'workflowRun.localOne' : 'workflowRun.localMany', { count: run.localSteps })));
    card.appendChild(steps);

    const total = document.createElement('div');
    total.className = 'wr-total';
    total.appendChild(textNode('span', 'wr-total-label', t('workflowRun.total')));
    total.appendChild(textNode('strong', 'wr-total-value', workflowRunTotal(run)));
    card.appendChild(total);
    if (run.paid) card.appendChild(textNode('p', 'wr-fine', t('workflowRun.priceNote')));
    if (run.budget) card.appendChild(textNode('p', 'wr-budget', t('workflowRun.budgetLine', { remaining: videoModelMoney(run.budget.remainingUsd) || '$0.00' })));
    if (run.blocked) card.appendChild(textNode('p', 'wr-blocked', workflowRunBudgetBlock(run)));
    if (run.note === 'plan_changed') card.appendChild(textNode('p', 'wr-note', t('workflowRun.planChanged')));
    if (run.inputsKept && run.mine) card.appendChild(textNode('p', 'wr-note', t('workflowRun.inputsKept')));
  }

  if (status === 'running') {
    const live = run.run || {};
    const step = live.step;
    const progress = document.createElement('div');
    progress.className = 'wr-progress';
    const bar = document.createElement('div');
    bar.className = 'wr-bar';
    bar.setAttribute('role', 'progressbar');
    const percent = step && step.total > 0 ? Math.round((step.done / step.total) * 100) : 0;
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.max(4, percent))}%`;
    bar.appendChild(fill);
    progress.appendChild(bar);
    const parts = [];
    if (step && step.total > 0) parts.push(t('workflowRun.progress', { done: Math.min(step.total, step.done + 1), total: step.total }));
    if ((live.running || []).length) parts.push(live.running.join(', '));
    if (live.costUsd > 0) parts.push(t('workflowRun.costSoFar', { amount: videoModelMoney(live.costUsd) }));
    else if (live.credits > 0) parts.push(t('workflowRun.costSoFar', { amount: workflowRunCredits(live.credits) }));
    progress.appendChild(textNode('p', 'wr-progress-text', parts.length ? parts.join(' · ') : t('workflowRun.runningNow')));
    card.appendChild(progress);
    card.appendChild(textNode('p', 'wr-fine', t('workflowRun.resultHere')));
  }

  if (status === 'completed') {
    const result = run.result || {};
    const facts = [t('workflowRun.doneIn', { duration: workflowRunDuration(result.durationMs) })];
    if (result.costUsd > 0) facts.push(t('workflowRun.costDone', { amount: videoModelMoney(result.costUsd) }));
    else if (result.credits > 0) facts.push(t('workflowRun.costDone', { amount: workflowRunCredits(result.credits) }));
    card.appendChild(textNode('p', 'wr-result', facts.join(' · ')));
    const count = (result.assets || []).length;
    if (count) card.appendChild(textNode('p', 'wr-result-line', t(count === 1 ? 'workflowRun.filesOne' : 'workflowRun.filesMany', { count })));
    for (const text of result.texts || []) {
      const details = document.createElement('details');
      details.className = 'wr-text-result';
      details.appendChild(textNode('summary', '', t('workflowRun.textSummary', { label: text.label })));
      details.appendChild(textNode('div', 'wr-text-body', text.text));
      card.appendChild(details);
    }
    if ((result.model3d || []).length) card.appendChild(textNode('p', 'wr-note', t('workflowRun.model3d', { labels: result.model3d.map((item) => item.label).join(', ') })));
    if (result.skipped > 0) card.appendChild(textNode('p', 'wr-note', t('workflowRun.skipped', { count: result.skipped })));
    if (result.empty) card.appendChild(textNode('p', 'wr-note', t('workflowRun.empty')));
  }

  if (status === 'failed') {
    card.appendChild(textNode('p', 'wr-error-text', t('workflowRun.failedLine')));
    if (run.error) card.appendChild(textNode('p', 'wr-error-detail', run.error));
    for (const failure of run.failures || []) {
      card.appendChild(textNode('p', 'wr-error-detail', failure.message ? `${failure.label}: ${failure.message}` : failure.label));
    }
    const cost = run.result && run.result.costUsd > 0 ? videoModelMoney(run.result.costUsd) : '';
    if (cost) card.appendChild(textNode('p', 'wr-fine', t('workflowRun.costDone', { amount: cost })));
  }

  if (status === 'cancelled') {
    card.appendChild(textNode('p', 'wr-result', t(run.result ? 'workflowRun.cancelledRun' : 'workflowRun.cancelled')));
  }

  const foot = document.createElement('div');
  foot.className = 'wr-foot';
  const locked = state.streaming;
  if (waiting && run.mine) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'wr-start';
    start.textContent = workflowRunStartLabel(run);
    start.disabled = locked || status !== 'pending' || Boolean(run.blocked);
    if (locked) start.title = t('workflowRun.waitStream');
    start.addEventListener('click', () => startWorkflowRun(run, card));
    foot.appendChild(start);
  }
  const open = workflowRunOpenLink(run);
  if (open) foot.appendChild(open);
  if ((waiting || status === 'running') && run.mine) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'wr-cancel';
    cancel.textContent = t('workflowRun.cancel');
    cancel.disabled = waiting && (locked || status !== 'pending');
    cancel.addEventListener('click', () => cancelWorkflowRun(run, card));
    foot.appendChild(cancel);
  }
  if (foot.children.length) card.appendChild(foot);
  if (waiting && !run.mine) card.appendChild(textNode('p', 'wr-fine', t('workflowRun.onlyRequester')));

  const line = document.createElement('div');
  line.className = 'wr-status';
  line.setAttribute('role', 'status');
  if (waiting && run.lastError && status === 'pending') {
    line.textContent = workflowRunErrorText(run);
    line.classList.add('error');
  } else if (status === 'processing') {
    line.textContent = t('workflowRun.starting');
  }
  card.appendChild(line);
  return card;
}

// While a run is running (or starting) the card is asked about every few seconds: one cheap read of the run, and the chat is
// only read again when the state changed (the finished result is in the chat then).
function openWorkflowRuns() {
  return (state.detail?.session?.messages || []).filter((message) => message.workflowRun && ['running', 'processing'].includes(message.workflowRun.status));
}

function scheduleWorkflowRunPolling() {
  if (state.workflowRunTimer) {
    clearInterval(state.workflowRunTimer);
    state.workflowRunTimer = null;
  }
  if (!openWorkflowRuns().length) return;
  state.workflowRunTimer = setInterval(async () => {
    if (!state.currentId || state.streaming || document.hidden) return;
    const sessionId = state.currentId;
    let changed = false;
    for (const message of openWorkflowRuns()) {
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/workflow-runs/${encodeURIComponent(message.workflowRun.id)}`);
        if (state.currentId !== sessionId || !data.run) return;
        if (data.run.status !== message.workflowRun.status) changed = true;
        message.workflowRun = data.run;
        const old = el.messages.querySelector(`.workflow-run[data-run-id="${CSS.escape(data.run.id)}"]`);
        if (old && !changed) old.replaceWith(workflowRunCard(data.run));
      } catch (err) {
        if (err.status === 404 && OCAccess.isActive()) return handleSessionGone(sessionId);
      }
    }
    if (changed) await afterWorkflowRunChange().catch(() => {});
    if (!openWorkflowRuns().length && state.workflowRunTimer) {
      clearInterval(state.workflowRunTimer);
      state.workflowRunTimer = null;
    }
  }, WORKFLOW_RUN_POLL_MS);
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

