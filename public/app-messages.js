'use strict';

// Message rendering, node results and costs, moved from app.js. Loaded in index.html order.

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
  if (message.name === 'list_workflows') return t('tools.workflowsListed');
  if (message.name === 'run_workflow') return t(`tools.workflow.${message.workflowRun?.status || message.workflowRunStatus || 'running'}`);
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
      // The ChatGPT subscription failed and OpenRouter answered this step: say so (and that it is billed).
      if (message.subscriptionFallback) {
        const notice = document.createElement('div');
        notice.className = 'msg tool';
        notice.appendChild(chip(chatNoticeText({ code: 'CHATGPT_REPLACED' }), false, false));
        el.messages.appendChild(notice);
      }
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
      // A known cause (the provider refused the image) is said in the interface language, never as the raw tool text.
      const known = failed ? providerRuleMessage(message.errorCode) : null;
      wrap.appendChild(chip(known || (failed ? String(message.content).slice(0, 200) : toolLabel(message)), false, failed));
      if (message.videoModelChoice) wrap.appendChild(videoModelChoiceCard(message.videoModelChoice));
      if (message.workflowRun) wrap.appendChild(workflowRunCard(message.workflowRun));

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
            costEstimated: job.costEstimated === true || asset?.costEstimated === true,
            model: job.model || asset?.model || null,
            modelName: job.modelName || asset?.modelName || null,
            billing: job.billing || asset?.billing || null,
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
  higgsfield: 'costs.higgsfield',
  speech: 'costs.speech',
  music: 'costs.music'
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

