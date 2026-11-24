'use strict';

// The timeline review of a cutting node (docs/timeline-review.md): a full-size overlay of the node view that shows which clip is
// placed when in the film, plays every clip at its place under the sound of the film and takes the approval or the feedback of
// each clip. Geometry, statuses and keys come from public/nodes/timeline.js; the server builds the view (lib/timeline/service.js).
//
// OCDNodes.timelineUi.open({ workflowId, nodeId, ...deps }) opens it over the node view:
//   workflowName(), nodeTitle(id)        names for the header and the producer line
//   getNode()                            the cutting node as it is in the graph now ({ id, params }), null when it is gone
//   getRun()                             the run state of the node view ({ active, mode, targets, nodes })
//   producerInfo(nodeId, item)           { model, cost: { paid, usd, credits, unknown }, versions } of the node that made a clip
//   costText(cost, options)              a price as the node view writes it
//   setReview(value)                     writes the `review` param of the cutting node ('off' | 'required') through the normal save
//   flushSave(), savedRev(), holdExternalSaves(id), adoptServerEdit(edit, id)   the save path a server-side edit goes through
//   startRun(request)                    the normal run path of the node view (plan, cost question, budget)
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const tl = OCD.timeline;
  const { el, icon, T } = ui;

  const ZOOMS = [2, 4, 8, 15, 30, 60, 120, 240]; // pixels per second
  const KIND = {
    duet: 'nodes.timeline.kind.duet', performance: 'nodes.timeline.kind.performance', guest: 'nodes.timeline.kind.guest',
    story: 'nodes.timeline.kind.story', still: 'nodes.timeline.kind.still', scene: 'nodes.timeline.kind.scene',
    clip: 'nodes.timeline.kind.clip', intro: 'nodes.timeline.kind.intro', outro: 'nodes.timeline.kind.outro'
  };
  const STATUS = {
    approved: 'nodes.timeline.status.approved', feedback: 'nodes.timeline.status.feedback', remaking: 'nodes.timeline.status.remaking',
    open: 'nodes.timeline.status.open', missing: 'nodes.timeline.status.missing'
  };
  const STATUS_ICON = { approved: 'check', feedback: 'send', remaking: 'refresh', open: 'clock', missing: 'warning' };
  const ERRORS = {
    RUN_ACTIVE: 'nodes.timeline.error.runActive', REV_CONFLICT: 'nodes.timeline.error.conflict',
    TIMELINE_ASSET_MISSING: 'nodes.timeline.error.assetMissing', TIMELINE_FEEDBACK_UNAVAILABLE: 'nodes.timeline.error.noFeedback',
    TIMELINE_REROLL_UNAVAILABLE: 'nodes.timeline.error.noReroll', TIMELINE_BAD_ANSWER: 'nodes.timeline.error.badAnswer',
    TIMELINE_UNAVAILABLE: 'nodes.timeline.error.unavailable', TIMELINE_CLIP_NOT_FOUND: 'nodes.timeline.error.unavailable'
  };
  const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const kindLabel = (kind) => (KIND[kind] ? T(KIND[kind]) : String(kind || ''));
  const errorText = (error) => (error && ERRORS[error.code] ? T(ERRORS[error.code]) : T('nodes.timeline.error.other', { error: (error && error.message) || '' }));
  const url = (asset) => (asset && asset.url ? OCD.api.rel(asset.url) : '');

  /* ---------- waveform peaks, decoded once per asset ---------- */

  const peakCache = new Map(); // asset id -> Promise<number[] | null>
  let audioContext = null;
  function peaksOf(asset) {
    if (!asset || !asset.url) return Promise.resolve(null);
    const key = asset.id || asset.url;
    if (peakCache.has(key)) return peakCache.get(key);
    const Context = global.AudioContext || global.webkitAudioContext;
    const promise = !Context || typeof global.fetch !== 'function' ? Promise.resolve(null) : global.fetch(url(asset), { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((buffer) => {
        audioContext = audioContext || new Context();
        return audioContext.decodeAudioData(buffer);
      })
      .then((decoded) => {
        const channels = [];
        for (let index = 0; index < decoded.numberOfChannels; index++) channels.push(decoded.getChannelData(index));
        return tl.peaks(channels, Math.max(200, Math.min(8192, Math.round(decoded.duration * 50))));
      })
      .catch(() => null);
    peakCache.set(key, promise);
    return promise;
  }

  /* ---------- the overlay ---------- */

  let current = null;

  function open(options) {
    if (current) current.close();
    current = create(options);
    return current;
  }

  function create(deps) {
    const { workflowId, nodeId } = deps;
    const api = OCD.api;
    let model = null;
    let selectedKey = null;
    let filter = 'all';
    let zoom = 30;
    let fitted = false;
    let soundMode = 'film';
    let rangeMode = 'clip';
    let play = null; // { list, index, clip, wall, frame }
    let playTime = 0;
    let pending = null; // { nodeId, items } of the run this overlay asked for
    let wasActive = Boolean(deps.getRun() && deps.getRun().active);
    let busy = false;
    let closed = false;
    let showPrompt = false;
    let paintKey = '';
    let frame = null;
    const drafts = new Map(); // clip key -> feedback text typed and not sent
    const previousFocus = document.activeElement;

    /* ----- skeleton ----- */

    const root = el('div', { class: 'nv-tl', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('nodes.timeline.title'), tabindex: '-1' });
    const name = el('strong', { class: 'nv-tl-name' });
    const progressText = el('span', { class: 'nv-tl-progress-text' });
    const progressFill = el('span', { class: 'nv-tl-progress-fill' });
    const progress = el('div', { class: 'nv-tl-progress' }, progressText, el('span', { class: 'nv-tl-progress-bar', 'aria-hidden': 'true' }, progressFill));
    const countsEl = el('div', { class: 'nv-tl-counts' });
    const approveKindBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-tl-approve-kind' });
    const gateSwitch = el('button', { type: 'button', class: 'nv-switch', role: 'switch', 'aria-checked': 'false', 'aria-label': T('nodes.timeline.gate') }, el('span', { class: 'nv-switch-knob' }));
    const gate = el('label', { class: 'nv-tl-gate', title: T('nodes.timeline.gateHint') }, gateSwitch, el('span', { text: T('nodes.timeline.gate') }));
    const renderBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-tl-render' });
    const closeBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-icon nv-tl-close', title: T('nodes.common.close'), 'aria-label': T('nodes.common.close') }, icon('x', 16));
    const top = el('header', { class: 'nv-tl-top' },
      el('div', { class: 'nv-tl-title' }, icon('video', 16), name), progress, countsEl,
      el('div', { class: 'nv-tl-top-actions' }, approveKindBtn, gate, renderBtn, closeBtn));

    const video = el('video', { class: 'nv-tl-video', playsinline: true, preload: 'metadata' });
    const audio = el('audio', { preload: 'auto' });
    const stageNote = el('div', { class: 'nv-tl-stage-note' });
    const stage = el('div', { class: 'nv-tl-stage' }, video, stageNote);
    const playBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-icon nv-tl-play', title: T('nodes.timeline.play'), 'aria-label': T('nodes.timeline.play') }, icon('play', 15));
    const timeEl = el('span', { class: 'nv-tl-time' });
    const soundSeg = segmented(T('nodes.timeline.sound'), [['film', T('nodes.timeline.sound.film')], ['clip', T('nodes.timeline.sound.clip')]], () => soundMode, (value) => {
      soundMode = value;
      stopPlay();
    });
    const rangeSeg = segmented(T('nodes.timeline.range'), [['clip', T('nodes.timeline.range.clip')], ['neighbours', T('nodes.timeline.range.neighbours')], ['from', T('nodes.timeline.range.from')]], () => rangeMode, (value) => {
      rangeMode = value;
      stopPlay();
    });
    const player = el('section', { class: 'nv-tl-player', 'aria-label': T('nodes.timeline.player') }, stage,
      el('div', { class: 'nv-tl-controls' }, playBtn, timeEl, soundSeg.el, rangeSeg.el),
      el('p', { class: 'nv-tl-keys', text: T('nodes.timeline.keys') }));
    const detail = el('section', { class: 'nv-tl-detail nv-scroll', 'aria-label': T('nodes.timeline.detail') });

    const legend = el('div', { class: 'nv-tl-legend' });
    const filterSeg = segmented(T('nodes.timeline.filter'), [['all', T('nodes.timeline.filter.all')], ['open', T('nodes.timeline.filter.open')], ['lipsync', T('nodes.timeline.filter.lipsync')]], () => filter, (value) => {
      filter = value;
      stopPlay();
      paintTrack(true);
    });
    const zoomOut = el('button', { type: 'button', class: 'nv-btn nv-btn-icon nv-btn-sm', title: T('nodes.timeline.zoomOut'), 'aria-label': T('nodes.timeline.zoomOut') }, icon('minus', 13));
    const zoomFit = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-tl-zoom', title: T('nodes.timeline.zoomFit') });
    const zoomIn = el('button', { type: 'button', class: 'nv-btn nv-btn-icon nv-btn-sm', title: T('nodes.timeline.zoomIn'), 'aria-label': T('nodes.timeline.zoomIn') }, icon('plus', 13));
    const overview = el('div', { class: 'nv-tl-overview', role: 'presentation' });
    const overviewWindow = el('span', { class: 'nv-tl-overview-window' });
    const ruler = el('div', { class: 'nv-tl-ruler' });
    const sectionsRow = el('div', { class: 'nv-tl-row nv-tl-sections' });
    const clipsRow = el('div', { class: 'nv-tl-row nv-tl-clips', role: 'listbox', 'aria-label': T('nodes.timeline.clips') });
    const wordsRow = el('div', { class: 'nv-tl-row nv-tl-words' });
    const wave = el('canvas', { class: 'nv-tl-wave', 'aria-hidden': 'true' });
    const waveRow = el('div', { class: 'nv-tl-row nv-tl-waverow' }, wave);
    const playhead = el('span', { class: 'nv-tl-playhead', 'aria-hidden': 'true' });
    const inner = el('div', { class: 'nv-tl-inner' }, ruler, sectionsRow, clipsRow, wordsRow, waveRow, playhead);
    const scroller = el('div', { class: 'nv-tl-scroll nv-scroll' }, inner);
    const bottom = el('section', { class: 'nv-tl-bottom', 'aria-label': T('nodes.timeline.film') },
      el('div', { class: 'nv-tl-toolbar' }, legend, filterSeg.el, el('div', { class: 'nv-tl-zooms' }, zoomOut, zoomFit, zoomIn)),
      overview, scroller);
    const message = el('div', { class: 'nv-tl-message' });
    root.append(top, el('div', { class: 'nv-tl-main' }, player, detail), bottom, message, audio);

    function segmented(label, options, get, set) {
      const wrap = el('div', { class: 'nv-tl-seg', role: 'radiogroup', 'aria-label': label });
      const buttons = options.map(([value, text]) => {
        const button = el('button', { type: 'button', class: 'nv-tl-seg-btn', role: 'radio', text });
        button.addEventListener('click', () => {
          set(value);
          paint();
        });
        wrap.append(button);
        return [value, button];
      });
      const paint = () => {
        for (const [value, button] of buttons) {
          button.classList.toggle('is-on', get() === value);
          button.setAttribute('aria-checked', String(get() === value));
        }
      };
      paint();
      return { el: wrap, paint };
    }

    /* ----- data ----- */

    const clips = () => (model ? model.clips : []);
    const shown = () => tl.filter(clips(), filter, runView());
    const selected = () => clips().find((clip) => clip.key === selectedKey) || null;
    const statusOf = (clip) => tl.status(clip, runView());
    const gateOn = () => {
      const node = deps.getNode();
      return Boolean(node && node.params && node.params.review === 'required');
    };

    // the run as timeline.js reads it: a run of single items this overlay started names its items, any other run its nodes
    function runView() {
      const run = deps.getRun() || {};
      if (pending && run.active) return { active: true, mode: 'items', nodeId: pending.nodeId, items: pending.items, nodes: run.nodes };
      return run;
    }

    function setModel(next) {
      model = next;
      if (!model) return;
      if (!selected()) {
        const first = clips().find((clip) => statusOf(clip) !== 'approved') || clips()[0];
        selectedKey = first ? first.key : null;
      }
      if (!fitted) {
        fitted = true;
        const width = scroller.clientWidth || 1200;
        if (model.duration > 0 && model.duration * zoom < width) zoom = fitZoom();
      }
      paintAll();
    }

    async function load() {
      try {
        const payload = await api.getTimeline(workflowId, nodeId);
        if (closed) return;
        if (!payload.timeline) {
          model = null;
          showMessage(T('nodes.timeline.empty'));
          paintAll();
          return;
        }
        showMessage('');
        setModel(payload.timeline);
      } catch (error) {
        if (!closed) showMessage(errorText(error));
      }
    }

    function showMessage(text) {
      message.textContent = text || '';
      message.classList.toggle('is-shown', Boolean(text));
    }

    /* ----- painting ----- */

    function paintAll() {
      paintKey = '';
      paintHeader();
      paintLegend();
      paintTrack(true);
      paintDetail();
      showClip();
    }

    function paintHeader() {
      const counts = tl.counts(clips(), runView());
      name.textContent = [deps.workflowName(), deps.nodeTitle(nodeId)].filter(Boolean).join(' · ');
      progressText.textContent = T('nodes.timeline.progress', { approved: counts.approved, total: counts.total });
      progressFill.style.width = counts.total ? `${(counts.approved / counts.total) * 100}%` : '0';
      countsEl.textContent = '';
      for (const status of ['feedback', 'remaking', 'open', 'missing']) {
        if (!counts[status]) continue;
        countsEl.append(el('span', { class: 'nv-tl-count', dataset: { status } }, el('span', { class: 'nv-tl-dot' }), el('span', { text: `${counts[status]} ${T(STATUS[status])}` })));
      }
      const clip = selected();
      const kind = clip ? clip.kind : null;
      const approvable = kind ? clips().filter((entry) => entry.kind === kind && entry.asset && statusOf(entry) !== 'approved') : [];
      approveKindBtn.textContent = T('nodes.timeline.approveKind', { kind: kindLabel(kind), count: approvable.length });
      approveKindBtn.classList.toggle('hidden', !kind);
      approveKindBtn.disabled = busy || !approvable.length || Boolean(deps.getRun() && deps.getRun().active);
      const on = gateOn();
      gateSwitch.classList.toggle('is-on', on);
      gateSwitch.setAttribute('aria-checked', String(on));
      const locked = on && counts.remaining > 0;
      renderBtn.textContent = locked ? T('nodes.timeline.renderLocked', { count: counts.remaining }) : T('nodes.timeline.render');
      renderBtn.disabled = busy || locked || !model || Boolean(deps.getRun() && deps.getRun().active);
    }

    function paintLegend() {
      legend.textContent = '';
      const kinds = [...new Set(clips().map((clip) => clip.kind))];
      for (const kind of kinds) legend.append(el('span', { class: 'nv-tl-legend-item', dataset: { kind } }, el('span', { class: 'nv-tl-swatch' }), el('span', { text: kindLabel(kind) })));
      for (const status of ['approved', 'feedback', 'remaking', 'open']) {
        legend.append(el('span', { class: 'nv-tl-legend-item', dataset: { status } }, icon(STATUS_ICON[status], 11), el('span', { text: T(STATUS[status]) })));
      }
    }

    const fitZoom = () => Math.max(2, Math.min(240, ((scroller.clientWidth || 1200) - 2) / Math.max(1, model ? model.duration : 1)));

    function rulerStep(scale) {
      return RULER_STEPS.find((step) => step * scale >= 64) || 300;
    }

    function paintTrack(rebuild) {
      if (!model) {
        for (const row of [ruler, sectionsRow, clipsRow, wordsRow]) row.textContent = '';
        inner.style.width = '';
        return;
      }
      const layout = tl.layout(model, { zoom, filter, run: runView() });
      const scale = layout.scale;
      zoomFit.textContent = T('nodes.timeline.zoomValue', { value: Math.round(scale) });
      inner.style.width = `${Math.ceil(layout.width)}px`;
      if (rebuild) {
        ruler.textContent = '';
        const step = rulerStep(scale);
        for (let time = 0; time <= model.duration + 0.001; time += step) {
          ruler.append(el('span', { class: 'nv-tl-tick', style: `left:${time * scale}px`, text: tl.clock(time).replace(/\.0$/, '') }));
        }
        sectionsRow.textContent = '';
        for (const section of model.sections || []) {
          sectionsRow.append(el('span', { class: 'nv-tl-section', style: `left:${section.start * scale}px;width:${Math.max(0, (section.end - section.start) * scale)}px`, title: section.name || '', text: section.name || '' }));
        }
        wordsRow.textContent = '';
        for (const line of model.lines || []) {
          if (!line.text) continue;
          wordsRow.append(el('span', { class: 'nv-tl-word', dataset: line.voice ? { voice: String(line.voice) } : null, style: `left:${line.start * scale}px;width:${Math.max(0, (line.end - line.start) * scale)}px`, title: line.text, text: line.text }));
        }
        wordsRow.classList.toggle('is-empty', !(model.lines || []).some((line) => line.text));
        sectionsRow.classList.toggle('is-empty', !(model.sections || []).length);
      }
      clipsRow.textContent = '';
      for (const entry of layout.clips) {
        const clip = entry.clip;
        const label = clip.label || clip.key;
        const button = el('button', {
          type: 'button', class: 'nv-tl-clip', role: 'option', title: `${label} · ${T(STATUS[entry.status])}`,
          'aria-label': `${label}, ${kindLabel(clip.kind)}, ${T(STATUS[entry.status])}`, 'aria-selected': String(clip.key === selectedKey),
          dataset: { kind: clip.kind, status: entry.status, key: clip.key }, style: `left:${entry.left}px;width:${Math.max(3, entry.width - 1)}px`
        }, el('span', { class: 'nv-tl-clip-badge' }, icon(STATUS_ICON[entry.status], 10)), el('span', { class: 'nv-tl-clip-label', text: label }));
        if (entry.overWidth > 0) button.append(el('span', { class: 'nv-tl-over', style: `width:${entry.overWidth}px`, title: T('nodes.timeline.over', { seconds: clip.over.toFixed(1) }) }));
        button.classList.toggle('is-selected', clip.key === selectedKey);
        button.addEventListener('click', () => select(clip.key));
        clipsRow.append(button);
      }
      paintOverview();
      paintWave();
      paintPlayhead();
    }

    function paintOverview() {
      overview.textContent = '';
      if (!model || !(model.duration > 0)) return;
      for (const clip of shown()) {
        overview.append(el('span', { class: 'nv-tl-overview-clip', dataset: { status: statusOf(clip) }, style: `left:${(clip.start / model.duration) * 100}%;width:${(clip.duration / model.duration) * 100}%` }));
      }
      overview.append(overviewWindow);
      paintWindow();
    }

    function paintWindow() {
      if (!model || !(model.duration > 0)) return;
      const total = inner.clientWidth || 1;
      overviewWindow.style.left = `${(scroller.scrollLeft / total) * 100}%`;
      overviewWindow.style.width = `${Math.min(100, (scroller.clientWidth / total) * 100)}%`;
    }

    // The sound under the film: one song for the whole film, or the voice of every scene one after the other. The canvas only
    // covers the visible window (a long film at a high zoom is wider than a canvas may be) and follows the scrolling.
    function soundPieces() {
      if (!model) return [];
      if (model.audioAsset) return [{ asset: model.audioAsset, start: 0, duration: model.audioAsset.duration || model.duration }];
      return clips().filter((clip) => clip.soundAsset).map((clip) => ({ asset: clip.soundAsset, start: clip.start, duration: Math.min(clip.duration, clip.soundAsset.duration || clip.duration) }));
    }

    const drawn = new Map(); // asset key -> peaks | null once decoded
    function paintWave() {
      const pieces = soundPieces();
      waveRow.classList.toggle('is-empty', !pieces.length);
      if (!pieces.length || !wave.getContext) return;
      const width = Math.max(1, scroller.clientWidth);
      const height = 56;
      const ratio = global.devicePixelRatio || 1;
      wave.width = Math.round(width * ratio);
      wave.height = Math.round(height * ratio);
      wave.style.width = `${width}px`;
      wave.style.height = `${height}px`;
      wave.style.left = `${scroller.scrollLeft}px`;
      const context = wave.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = global.getComputedStyle(wave).color || '#5fd3a2';
      const scale = Math.max(2, Math.min(240, zoom));
      const from = scroller.scrollLeft / scale;
      for (const piece of pieces) {
        const key = piece.asset.id || piece.asset.url;
        if (!drawn.has(key)) {
          drawn.set(key, undefined);
          peaksOf(piece.asset).then((peaks) => {
            drawn.set(key, peaks);
            if (!closed) paintWave();
          });
        }
        const peaks = drawn.get(key);
        if (!peaks || !(piece.duration > 0)) continue;
        const real = piece.asset.duration || piece.duration;
        for (let x = Math.max(0, Math.floor((piece.start - from) * scale)); x < width; x++) {
          const time = from + x / scale - piece.start;
          if (time < 0) continue;
          if (time >= piece.duration) break;
          const value = peaks[Math.min(peaks.length - 1, Math.floor((time / real) * peaks.length))] || 0;
          const bar = Math.max(1, value * (height - 4));
          context.fillRect(x, (height - bar) / 2, 1, bar);
        }
      }
    }

    function paintPlayhead() {
      const scale = Math.max(2, Math.min(240, zoom));
      playhead.style.left = `${playTime * scale}px`;
      const clip = selected();
      timeEl.textContent = clip ? `${tl.clock(playTime)} / ${tl.clock(model ? model.duration : 0)}` : '';
    }

    function paintDetail() {
      detail.textContent = '';
      const clip = selected();
      if (!clip) {
        if (model) detail.append(el('p', { class: 'nv-tl-hint', text: T('nodes.timeline.noClip') }));
        return;
      }
      const status = statusOf(clip);
      const running = Boolean(deps.getRun() && deps.getRun().active);
      detail.append(el('div', { class: 'nv-tl-detail-head' },
        el('h2', { class: 'nv-tl-detail-name', text: clip.label || clip.key }),
        el('span', { class: 'nv-tl-chip', dataset: { kind: clip.kind }, text: kindLabel(clip.kind) }),
        el('span', { class: 'nv-tl-chip nv-tl-statuschip', dataset: { status } }, icon(STATUS_ICON[status], 11), el('span', { text: T(STATUS[status]) }))));

      const facts = el('dl', { class: 'nv-tl-facts' });
      const fact = (label, value) => value && facts.append(el('dt', { text: label }), el('dd', { text: value }));
      fact(T('nodes.timeline.place'), `${tl.clock(clip.start)} – ${tl.clock(clip.start + clip.duration)} (${clip.duration.toFixed(1)} s)`);
      fact(T('nodes.timeline.length'), clip.asset && Number.isFinite(clip.asset.duration) ? `${clip.asset.duration.toFixed(1)} s` : '');
      const producer = clip.producer ? deps.producerInfo(clip.producer.nodeId, clip.producer.item) : null;
      if (clip.producer) fact(T('nodes.timeline.producer'), T('nodes.timeline.producerItem', { node: deps.nodeTitle(clip.producer.nodeId), item: clip.producer.item + 1 }));
      if (producer && producer.model) fact(T('nodes.timeline.model'), producer.model);
      const price = producer && producer.cost ? priceText(producer.cost) : '';
      fact(T('nodes.timeline.cost'), price);
      if (producer && producer.versions) fact(T('nodes.timeline.versions'), String(producer.versions));
      detail.append(facts);

      if (clip.over > 0) {
        detail.append(el('div', { class: 'nv-notice is-warn nv-tl-warn' }, icon('warning', 14), el('span', { class: 'nv-notice-text', text: T('nodes.timeline.overWarn', { seconds: clip.over.toFixed(1) }) })));
      }
      if (status === 'missing') detail.append(el('div', { class: 'nv-notice is-warn nv-tl-warn' }, icon('warning', 14), el('span', { class: 'nv-notice-text', text: T('nodes.timeline.missingHint') })));

      const end = clip.start + clip.duration;
      const lines = (model.lines || []).filter((line) => line.text && line.end > clip.start && line.start < end);
      if (lines.length || clip.text) {
        const list = el('ul', { class: 'nv-tl-lines' });
        if (lines.length) for (const line of lines) list.append(el('li', {}, el('span', { class: 'nv-tl-line-time', text: tl.clock(line.start) }), el('span', { text: line.text })));
        else list.append(el('li', {}, el('span', { text: clip.text })));
        detail.append(el('h3', { class: 'nv-tl-sub', text: T('nodes.timeline.lines') }), list);
      }

      const actions = el('div', { class: 'nv-tl-actions' });
      const approve = el('button', { type: 'button', class: `nv-btn ${status === 'approved' ? '' : 'nv-btn-primary'} nv-tl-approve` },
        icon(status === 'approved' ? 'undo' : 'check', 14), el('span', { text: status === 'approved' ? T('nodes.timeline.reopen') : T('nodes.timeline.approve') }));
      approve.disabled = busy || running || !clip.asset;
      approve.addEventListener('click', () => review([clip.key], status === 'approved' ? 'open' : 'approved'));

      if (clip.feedbackCapability) {
        const field = el('textarea', { class: 'nv-input nv-tl-feedback', rows: '3', maxlength: '8000', placeholder: T('nodes.timeline.feedbackPlaceholder'), 'aria-label': T('nodes.timeline.feedback') });
        field.value = drafts.get(clip.key) || '';
        const send = el('button', { type: 'button', class: 'nv-btn nv-tl-send' }, icon('send', 14),
          el('span', { text: price ? T('nodes.timeline.sendPrice', { price }) : T('nodes.timeline.send') }));
        const sync = () => {
          send.disabled = busy || running || !field.value.trim();
        };
        field.addEventListener('input', () => {
          drafts.set(clip.key, field.value);
          sync();
        });
        send.addEventListener('click', () => feedback(clip, field.value));
        sync();
        detail.append(el('h3', { class: 'nv-tl-sub', text: T('nodes.timeline.feedback') }), field,
          el('p', { class: 'nv-tl-hint', text: T(clip.feedbackCapability === 'notes' ? 'nodes.timeline.feedbackNotes' : 'nodes.timeline.feedbackPrompt') }));
        actions.append(approve, send);
      } else {
        detail.append(el('p', { class: 'nv-tl-hint', text: T(clip.producer ? 'nodes.timeline.feedbackNone' : 'nodes.timeline.producerNone') }));
        actions.append(approve);
      }
      if (clip.producer) {
        const again = el('button', { type: 'button', class: 'nv-btn nv-tl-again' }, icon('refresh', 14), el('span', { text: T('nodes.timeline.again') }));
        again.disabled = busy || running;
        again.addEventListener('click', () => feedback(clip, ''));
        actions.append(again);
      }
      if (clip.prompt) {
        const toggle = el('button', { type: 'button', class: 'nv-btn nv-tl-prompt-toggle', 'aria-expanded': String(showPrompt) }, icon('eye', 14),
          el('span', { text: showPrompt ? T('nodes.timeline.hidePrompt') : T('nodes.timeline.showPrompt') }));
        toggle.addEventListener('click', () => {
          showPrompt = !showPrompt;
          paintDetail();
        });
        actions.append(toggle);
      }
      detail.append(actions);
      if (running) detail.append(el('p', { class: 'nv-tl-hint', text: T('nodes.timeline.runningHint') }));
      if (showPrompt && clip.prompt) detail.append(el('pre', { class: 'nv-tl-prompt nv-scroll', text: clip.prompt }));

      const history = (clip.review && clip.review.feedback) || [];
      if (history.length) {
        const list = el('ul', { class: 'nv-tl-history' });
        for (const entry of history.slice().reverse()) list.append(el('li', {}, el('span', { class: 'nv-tl-line-time', text: entry.at ? new Date(entry.at).toLocaleString() : '' }), el('span', { text: entry.text || '' })));
        detail.append(el('h3', { class: 'nv-tl-sub', text: T('nodes.timeline.history') }), list);
      }
    }

    function priceText(cost) {
      if (!cost.paid) return '';
      if (cost.unknown) return T('nodes.timeline.costUnknown');
      return deps.costText({ usd: cost.usd, credits: cost.credits }, { estimate: true });
    }

    // statuses change while a run goes on: repaint only when one of them did
    function schedulePaint() {
      if (frame || closed) return;
      frame = global.requestAnimationFrame(() => {
        frame = null;
        if (closed || !model) return;
        const key = `${clips().map(statusOf).join(',')}|${Boolean(deps.getRun() && deps.getRun().active)}|${gateOn()}|${busy}`;
        if (key === paintKey) return;
        paintKey = key;
        paintHeader();
        paintTrack(false);
        paintDetail();
      });
    }

    /* ----- the player ----- */

    function showClip() {
      const clip = selected();
      stageNote.textContent = '';
      stage.classList.toggle('is-missing', !clip || !clip.asset);
      if (!clip) return;
      if (!clip.asset) {
        video.removeAttribute('src');
        video.load();
        stageNote.textContent = T('nodes.timeline.status.missing');
      } else if (video.dataset.asset !== clip.asset.id) {
        video.dataset.asset = clip.asset.id;
        video.src = url(clip.asset);
      }
      if (!play) {
        playTime = clip.start;
        paintPlayhead();
      }
    }

    function soundFor(clip) {
      if (soundMode !== 'film' || !model) return null;
      if (model.audioAsset) return { src: url(model.audioAsset), at: clip.start };
      if (clip.soundAsset) return { src: url(clip.soundAsset), at: 0 };
      return null;
    }

    function startPlay() {
      const list = shown();
      const index = list.findIndex((clip) => clip.key === selectedKey);
      if (index < 0) return;
      const first = rangeMode === 'neighbours' ? Math.max(0, index - 1) : index;
      const last = rangeMode === 'from' ? list.length - 1 : rangeMode === 'neighbours' ? Math.min(list.length - 1, index + 1) : index;
      play = { list: list.slice(first, last + 1), index: -1, clip: null, wall: 0, frame: null };
      playBtn.replaceChildren(icon('pause', 15));
      playBtn.title = T('nodes.timeline.pause');
      playBtn.setAttribute('aria-label', T('nodes.timeline.pause'));
      nextSegment();
    }

    function nextSegment() {
      if (!play) return;
      play.index += 1;
      const clip = play.list[play.index];
      if (!clip) return stopPlay();
      play.clip = clip;
      play.wall = global.performance.now();
      stage.classList.toggle('is-missing', !clip.asset);
      stageNote.textContent = clip.asset ? '' : T('nodes.timeline.status.missing');
      const sound = soundFor(clip);
      video.muted = Boolean(sound);
      if (clip.asset) {
        if (video.dataset.asset !== clip.asset.id) {
          video.dataset.asset = clip.asset.id;
          video.src = url(clip.asset);
        }
        try { video.currentTime = 0; } catch (_) { /* not loaded yet: it starts at the beginning anyway */ }
        const started = video.play();
        if (started && started.catch) started.catch(() => {});
      } else {
        video.pause();
      }
      if (sound) {
        if (audio.dataset.src !== sound.src) {
          audio.dataset.src = sound.src;
          audio.src = sound.src;
        }
        if (audio.paused || Math.abs(audio.currentTime - sound.at) > 0.12) {
          try { audio.currentTime = sound.at; } catch (_) { /* seeks once the file is known */ }
        }
        const started = audio.play();
        if (started && started.catch) started.catch(() => {});
      } else {
        audio.pause();
      }
      tick();
    }

    function tick() {
      if (!play) return;
      const clip = play.clip;
      const elapsed = (global.performance.now() - play.wall) / 1000;
      playTime = clip.start + Math.min(elapsed, clip.duration);
      paintPlayhead();
      follow();
      if (elapsed >= clip.duration) return nextSegment();
      play.frame = global.requestAnimationFrame(tick);
    }

    function stopPlay() {
      if (play && play.frame) global.cancelAnimationFrame(play.frame);
      const was = Boolean(play);
      play = null;
      video.pause();
      audio.pause();
      playBtn.replaceChildren(icon('play', 15));
      playBtn.title = T('nodes.timeline.play');
      playBtn.setAttribute('aria-label', T('nodes.timeline.play'));
      if (was) showClip();
    }

    const togglePlay = () => (play ? stopPlay() : startPlay());

    function follow() {
      const x = playTime * Math.max(2, Math.min(240, zoom));
      if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = Math.max(0, x - 80);
    }

    function select(key, { reveal = false } = {}) {
      if (!clips().some((clip) => clip.key === key)) return;
      stopPlay();
      selectedKey = key;
      showPrompt = false;
      for (const button of clipsRow.children) {
        const on = button.dataset.key === key;
        button.classList.toggle('is-selected', on);
        button.setAttribute('aria-selected', String(on));
        if (on && reveal && button.scrollIntoView) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      paintHeader();
      paintDetail();
      showClip();
    }

    function step(delta) {
      const list = shown();
      if (!list.length) return;
      const index = list.findIndex((clip) => clip.key === selectedKey);
      const next = list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + delta))];
      select(next.key, { reveal: true });
    }

    /* ----- actions ----- */

    function setBusy(value) {
      busy = value;
      root.classList.toggle('is-busy', busy);
      paintKey = '';
      paintHeader();
      paintDetail();
    }

    async function review(keys, status) {
      if (busy || !keys.length) return;
      setBusy(true);
      try {
        const payload = await api.reviewTimeline(workflowId, nodeId, { keys, status });
        if (closed) return;
        busy = false;
        root.classList.remove('is-busy');
        setModel(payload.timeline);
        // the next clip that still waits, so a pass through the film is one key per clip
        if (status === 'approved' && keys.length === 1) {
          const list = shown();
          const index = list.findIndex((clip) => clip.key === keys[0]);
          const next = list.slice(index + 1).find((clip) => statusOf(clip) !== 'approved');
          if (next) select(next.key, { reveal: true });
        }
        if (deps.refreshPlan) deps.refreshPlan();
      } catch (error) {
        ui.toast(errorText(error), { kind: 'error' });
      } finally {
        if (!closed && busy) setBusy(false);
      }
    }

    // Feedback (or, with an empty text, the same clip once more): the server writes the note or the rewritten prompt into the graph,
    // this page takes that graph over and then starts the run of this one item through the normal cost path.
    async function feedback(clip, text) {
      if (busy) return;
      stopPlay();
      setBusy(true);
      let answer = null;
      let adoptedRev = null;
      let release = () => {};
      try {
        await deps.flushSave();
        const rev = deps.savedRev();
        if (rev === null || rev === undefined) throw Object.assign(new Error('unsaved'), { code: 'REV_CONFLICT' });
        release = deps.holdExternalSaves(workflowId);
        answer = await api.timelineFeedback(workflowId, nodeId, clip.key, { text, rev });
        if (answer.rev !== rev) {
          const adopted = await deps.adoptServerEdit({ baseRev: rev, rev: answer.rev }, workflowId);
          if (!adopted || !adopted.ok) throw Object.assign(new Error('conflict'), { code: 'REV_CONFLICT' });
          adoptedRev = answer.rev;
        }
      } catch (error) {
        answer = null;
        ui.toast(errorText(error), { kind: 'error' });
      } finally {
        await release(adoptedRev);
      }
      if (closed) return;
      if (!answer) return setBusy(false);
      drafts.delete(clip.key);
      const request = answer.runRequest;
      pending = { nodeId: request.nodeId, items: request.items.slice() };
      try {
        await deps.startRun(request);
      } finally {
        if (!(deps.getRun() && deps.getRun().active)) pending = null;
        wasActive = Boolean(deps.getRun() && deps.getRun().active);
        if (!closed) {
          busy = false;
          root.classList.remove('is-busy');
          await load();
        }
      }
    }

    async function renderFilm() {
      if (busy) return;
      stopPlay();
      await deps.startRun({ mode: 'all', force: false });
      schedulePaint();
    }

    /* ----- events ----- */

    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    closeBtn.addEventListener('click', () => close());
    renderBtn.addEventListener('click', renderFilm);
    gateSwitch.addEventListener('click', () => {
      deps.setReview(gateOn() ? 'off' : 'required');
      paintKey = '';
      paintHeader();
    });
    approveKindBtn.addEventListener('click', () => {
      const clip = selected();
      if (!clip) return;
      review(clips().filter((entry) => entry.kind === clip.kind && entry.asset && statusOf(entry) !== 'approved').map((entry) => entry.key), 'approved');
    });
    const setZoom = (value) => {
      const centre = (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(2, zoom);
      zoom = Math.max(2, Math.min(240, value));
      paintTrack(true);
      scroller.scrollLeft = Math.max(0, centre * zoom - scroller.clientWidth / 2);
    };
    zoomOut.addEventListener('click', () => setZoom(ZOOMS.slice().reverse().find((value) => value < zoom - 0.01) || ZOOMS[0]));
    zoomIn.addEventListener('click', () => setZoom(ZOOMS.find((value) => value > zoom + 0.01) || ZOOMS[ZOOMS.length - 1]));
    zoomFit.addEventListener('click', () => setZoom(fitZoom()));
    scroller.addEventListener('scroll', () => {
      paintWindow();
      paintWave();
    });
    ruler.addEventListener('click', (event) => {
      const clip = tl.clipAt(shown(), (event.clientX - inner.getBoundingClientRect().left) / Math.max(2, zoom));
      if (clip) select(clip.key);
    });
    overview.addEventListener('click', (event) => {
      const box = overview.getBoundingClientRect();
      if (!box.width) return;
      scroller.scrollLeft = Math.max(0, ((event.clientX - box.left) / box.width) * inner.clientWidth - scroller.clientWidth / 2);
    });

    function onKey(event) {
      if (document.querySelector('.nv-dialog-backdrop')) return; // a question of the node view (the cost of a run) is on top
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return close();
      }
      const action = tl.keyAction(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'play') togglePlay();
      else if (action === 'previous') step(-1);
      else if (action === 'next') step(1);
      else if (action === 'approve') {
        const clip = selected();
        if (clip && clip.asset && statusOf(clip) !== 'approved' && !(deps.getRun() && deps.getRun().active)) review([clip.key], 'approved');
      }
    }
    const onResize = () => {
      paintWindow();
      paintWave();
    };
    global.addEventListener('keydown', onKey, true);
    global.addEventListener('resize', onResize);

    // the run of the node view moved on: statuses follow, and when a run ends the clips are read again
    function onRun() {
      if (closed) return;
      const active = Boolean(deps.getRun() && deps.getRun().active);
      if (wasActive && !active) {
        pending = null;
        if (!busy) load();
      }
      wasActive = active;
      schedulePaint();
    }

    function close() {
      if (closed) return;
      closed = true;
      stopPlay();
      if (frame) global.cancelAnimationFrame(frame);
      global.removeEventListener('keydown', onKey, true);
      global.removeEventListener('resize', onResize);
      video.removeAttribute('src');
      audio.removeAttribute('src');
      root.remove();
      if (current === handle) current = null;
      if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
    }

    const handle = { nodeId, workflowId, close, onRun, reload: load, refresh: schedulePaint };
    ui.root().append(root);
    root.focus();
    paintHeader();
    showMessage(T('nodes.timeline.loading'));
    load();
    return handle;
  }

  OCD.timelineUi = { open, current: () => current };
})(window);
