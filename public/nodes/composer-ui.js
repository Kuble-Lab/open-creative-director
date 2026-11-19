'use strict';

// The editor of the Composer node (image.composer): a stage of the chosen format on which images from the inputs, texts and shapes are
// layers that are moved, scaled and turned with the mouse, with guides that snap to the stage and to the other layers, a list of the
// layers (order, show, lock), the settings of the chosen layer, its own undo and keyboard shortcuts. What is laid out here is the
// param `layers` (public/nodes/composer-model.js) of the node, so a run, a template or the agent access makes the same picture; the
// server draws it (lib/composer-render.js) with the same fonts, wrap and line positions as this stage.
//
// OCDNodes.composer.open({ nodeId, getNode, sources, commit, label }) opens it over the node view:
//   getNode()   the node as it is in the graph now ({ id, params })
//   sources()   what is connected: { images: [{ value, label }], texts: [{ text, label }], brand: profile | null }
//   commit(patch)  writes params of the node (one step of the undo of the node view)
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const model = OCD.composerModel;
  const { el, icon, T } = ui;

  const HISTORY_MAX = 100;
  const SNAP_PX = 6; // on screen
  const PAD = 72; // room around the stage, on screen
  const HANDLE = 9;
  const ROTATE_GAP = 26;
  const MIN_PX = 4;
  const ZOOMS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const CANVAS_PARAMS = Object.freeze(['format', 'short_edge', 'width', 'height', 'transparent', 'background']);

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const fmt = (value, digits = 0) => {
    const factor = 10 ** digits;
    return String(Math.round(value * factor) / factor);
  };

  /* ---------- fonts ---------- */

  // FontFace objects of the stage: the fonts of the app from /api/nodes/composer/fonts, the brand fonts from the branding. A family is
  // known to CSS as "OCD <family>"; every face claims the whole weight range, so the browser sets the weight of a variable font and never
  // makes a bold of its own (the server draws the nearest face, see lib/composer-render.js).
  const loadedFaces = new Map();
  function cssFamily(family) {
    return `OCD ${String(family).replace(/["\\]/g, '')}`;
  }
  function addFace(key, family, url, weight, onLoad) {
    if (loadedFaces.has(key) || typeof FontFace !== 'function') return;
    let face;
    try {
      face = new FontFace(cssFamily(family), `url("${url}")`, { weight, style: 'normal' });
    } catch (_) {
      return;
    }
    loadedFaces.set(key, face);
    document.fonts.add(face);
    face.load().then(onLoad, () => {});
  }
  function ensureFonts(brand, onLoad) {
    for (const font of model.FONTS) {
      const files = font.files.slice().sort((a, b) => a.weights[0] - b.weights[0]);
      files.forEach((entry, index) => {
        // static files of one family share the range between them
        const low = index === 0 ? 1 : Math.floor((files[index - 1].weights[files[index - 1].weights.length - 1] + entry.weights[0]) / 2) + 1;
        const high = index === files.length - 1 ? 1000 : Math.floor((entry.weights[entry.weights.length - 1] + files[index + 1].weights[0]) / 2);
        addFace(`app:${entry.file}`, font.family, OCD.api.rel(`api/nodes/composer/fonts/${entry.file}`), `${low} ${high}`, onLoad);
      });
    }
    const byFamily = new Map();
    for (const font of model.brandFonts(brand)) {
      if (!byFamily.has(font.family)) byFamily.set(font.family, []);
      byFamily.get(font.family).push(font);
    }
    for (const [family, list] of byFamily) {
      list.sort((a, b) => a.weight - b.weight);
      list.forEach((font, index) => {
        const low = index === 0 ? 1 : Math.floor((list[index - 1].weight + font.weight) / 2) + 1;
        const high = index === list.length - 1 ? 1000 : Math.floor((font.weight + list[index + 1].weight) / 2);
        const url = OCD.api.rel(`api/brandings/${encodeURIComponent(font.branding)}/assets/${encodeURIComponent(font.file)}`);
        addFace(`brand:${font.branding}:${font.file}`, family, url, `${low} ${high}`, onLoad);
      });
    }
  }

  /* ---------- the editor ---------- */

  let openEditor = null;

  function open(options) {
    if (openEditor) openEditor.close();
    openEditor = createEditor(options);
    return openEditor;
  }

  function createEditor({ nodeId, getNode, sources: getSources, commit, label }) {
    const startNode = getNode();
    if (!startNode) return null;
    const params = startNode.params || {};
    let doc = {
      layers: model.normalizeComposition(params.layers).layers,
      format: model.FORMAT_OPTIONS.includes(params.format) ? params.format : model.DEFAULT_FORMAT,
      short_edge: model.SHORT_EDGES.includes(Number(params.short_edge)) ? Number(params.short_edge) : model.DEFAULT_SHORT_EDGE,
      width: Number(params.width) || 1080,
      height: Number(params.height) || 1080,
      transparent: params.transparent === true,
      background: model.hexColor(params.background) || '#ffffff'
    };
    let sources = readSources();
    let selected = null;
    let zoom = 1;
    let fitMode = true;
    let editingText = null;
    let drag = null;
    const past = [];
    const future = [];
    const measured = new Map(); // id -> text height in px of the stage
    const imageSizes = new Map(); // url -> { w, h }

    function readSources() {
      const raw = (getSources && getSources()) || {};
      return {
        images: Array.isArray(raw.images) ? raw.images : [],
        texts: Array.isArray(raw.texts) ? raw.texts : [],
        brand: raw.brand || null
      };
    }
    const canvas = () => model.canvasSize(doc);
    const layerById = (id) => doc.layers.find((layer) => layer.id === id) || null;
    const textsOf = () => sources.texts.map((entry) => (typeof entry.text === 'string' ? entry.text : null));

    /* ----- skeleton ----- */

    const root = el('div', { class: 'nv-cmp', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('nodes.composer.title') });
    const title = el('div', { class: 'nv-cmp-title' }, icon('layers', 16), el('strong', { text: label || T('nodes.composer.title') }));
    const formatBar = el('div', { class: 'nv-cmp-formats', role: 'radiogroup', 'aria-label': T('nodes.param.format') });
    const sizeLabel = el('span', { class: 'nv-cmp-size' });
    const undoBtn = toolButton('undo', T('nodes.composer.undo'), () => undo());
    const redoBtn = toolButton('redo', T('nodes.composer.redo'), () => redo());
    const zoomOut = toolButton('minus', T('nodes.composer.zoomOut'), () => setZoom(stepZoom(-1)));
    const zoomLabel = el('button', { type: 'button', class: 'nv-cmp-zoom', title: T('nodes.composer.zoomFit') });
    zoomLabel.addEventListener('click', () => fit());
    const zoomIn = toolButton('plus', T('nodes.composer.zoomIn'), () => setZoom(stepZoom(1)));
    const done = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-cmp-done' }, el('span', { text: T('nodes.composer.done') }));
    done.addEventListener('click', () => close());
    const top = el(
      'header',
      { class: 'nv-cmp-top' },
      title,
      formatBar,
      sizeLabel,
      el('div', { class: 'nv-cmp-spacer' }),
      el('div', { class: 'nv-cmp-group' }, undoBtn, redoBtn),
      el('div', { class: 'nv-cmp-group' }, zoomOut, zoomLabel, zoomIn),
      done
    );

    const layersPanel = el('aside', { class: 'nv-cmp-panel nv-cmp-left' });
    const propsPanel = el('aside', { class: 'nv-cmp-panel nv-cmp-right' });
    const viewport = el('div', { class: 'nv-cmp-viewport' });
    const sizer = el('div', { class: 'nv-cmp-sizer' });
    const stage = el('div', { class: 'nv-cmp-stage' });
    const overlay = el('div', { class: 'nv-cmp-overlay' });
    const guides = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    guides.setAttribute('class', 'nv-cmp-guides');
    sizer.append(stage, guides, overlay);
    viewport.append(sizer);
    const hint = el('div', { class: 'nv-cmp-hint', role: 'status' });
    const centre = el('main', { class: 'nv-cmp-centre' }, viewport, hint);
    root.append(top, el('div', { class: 'nv-cmp-body' }, layersPanel, centre, propsPanel));
    ui.root().append(root);
    document.documentElement.classList.add('nv-cmp-open');

    function toolButton(name, text, onClick) {
      const button = el('button', { type: 'button', class: 'nv-cmp-tool', title: text, 'aria-label': text }, icon(name, 16));
      button.addEventListener('click', onClick);
      return button;
    }

    /* ----- history and saving ----- */

    function snapshot() {
      return JSON.stringify(doc);
    }
    // Every finished change: one step of the own undo, written to the node at once
    function change(mutate, { push = true } = {}) {
      const before = snapshot();
      mutate();
      const after = snapshot();
      if (before === after) return;
      if (push) {
        past.push(before);
        if (past.length > HISTORY_MAX) past.shift();
        future.length = 0;
      }
      save(JSON.parse(before));
      render();
    }
    function save(previous) {
      const patch = {};
      const now = { ...doc, layers: { layers: withTextHeights(doc.layers) } };
      if (!previous || JSON.stringify(previous.layers) !== JSON.stringify(doc.layers)) patch.layers = now.layers;
      for (const key of CANVAS_PARAMS) if (!previous || previous[key] !== doc[key]) patch[key] = doc[key];
      if (Object.keys(patch).length) commit(patch);
    }
    // a text box keeps the height of its lines in the saved layers (agents and the list read it; the server measures again)
    function withTextHeights(layers) {
      const size = canvas();
      return layers.map((layer) => (layer.type === 'text' && measured.has(layer.id) ? { ...layer, h: model.round((measured.get(layer.id) / size.height) * 100) } : layer));
    }
    function undo() {
      if (!past.length) return;
      const before = JSON.parse(snapshot());
      future.push(snapshot());
      doc = JSON.parse(past.pop());
      if (selected && !layerById(selected)) selected = null;
      save(before);
      render();
    }
    function redo() {
      if (!future.length) return;
      const before = JSON.parse(snapshot());
      past.push(snapshot());
      doc = JSON.parse(future.pop());
      if (selected && !layerById(selected)) selected = null;
      save(before);
      render();
    }

    /* ----- zoom ----- */

    function fitZoom() {
      const size = canvas();
      const room = { w: Math.max(100, viewport.clientWidth - PAD * 2), h: Math.max(100, viewport.clientHeight - PAD * 2) };
      return Math.max(0.05, Math.min(4, room.w / size.width, room.h / size.height));
    }
    function stepZoom(direction) {
      const current = zoom;
      if (direction > 0) return ZOOMS.find((value) => value > current + 0.001) || ZOOMS[ZOOMS.length - 1];
      return [...ZOOMS].reverse().find((value) => value < current - 0.001) || ZOOMS[0];
    }
    function setZoom(value, anchor) {
      const before = zoom;
      zoom = Math.max(0.05, Math.min(4, value));
      fitMode = false;
      const point = anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
      const stageX = (viewport.scrollLeft + point.x - PAD) / before;
      const stageY = (viewport.scrollTop + point.y - PAD) / before;
      layout();
      viewport.scrollLeft = stageX * zoom + PAD - point.x;
      viewport.scrollTop = stageY * zoom + PAD - point.y;
    }
    function fit() {
      fitMode = true;
      zoom = fitZoom();
      layout();
    }
    viewport.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        setZoom(zoom * Math.exp(-event.deltaY * 0.0025), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      },
      { passive: false }
    );

    // the stage at its size and zoom; in fit mode it stands in the middle of the viewport
    function layout() {
      const size = canvas();
      const w = size.width * zoom;
      const h = size.height * zoom;
      const outerW = Math.max(viewport.clientWidth, w + PAD * 2);
      const outerH = Math.max(viewport.clientHeight, h + PAD * 2);
      sizer.style.width = `${outerW}px`;
      sizer.style.height = `${outerH}px`;
      const left = Math.round((outerW - w) / 2);
      const topPx = Math.round((outerH - h) / 2);
      stage.style.left = `${left}px`;
      stage.style.top = `${topPx}px`;
      stage.style.width = `${size.width}px`;
      stage.style.height = `${size.height}px`;
      stage.style.transform = `scale(${zoom})`;
      stageOrigin.x = left;
      stageOrigin.y = topPx;
      guides.setAttribute('width', String(outerW));
      guides.setAttribute('height', String(outerH));
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      drawSelection();
    }
    const stageOrigin = { x: 0, y: 0 };
    const toScreen = (x, y) => ({ x: stageOrigin.x + x * zoom, y: stageOrigin.y + y * zoom });
    // a pointer event in pixels of the stage
    function stagePoint(event) {
      const rect = sizer.getBoundingClientRect();
      return { x: (event.clientX - rect.left - stageOrigin.x) / zoom, y: (event.clientY - rect.top - stageOrigin.y) / zoom };
    }

    /* ----- drawing the stage ----- */

    const layerEls = new Map();

    function imageSource(layer) {
      const entry = sources.images[layer.input];
      const url = entry && entry.value && typeof entry.value.url === 'string' ? ui.mediaUrl(entry.value) : '';
      return { entry, url };
    }

    function drawLayer(layer) {
      const size = canvas();
      let node = layerEls.get(layer.id);
      const kind = `nv-cmp-layer is-${layer.type}`;
      if (!node || node.dataset.type !== layer.type) {
        if (node) node.remove();
        node = el('div', { class: kind, dataset: { id: layer.id, type: layer.type } });
        layerEls.set(layer.id, node);
      }
      node.className = `${kind}${layer.hidden ? ' is-hidden' : ''}${layer.locked ? ' is-locked' : ''}`;
      const box = model.boxPx(layer, size);
      node.style.left = `${box.x}px`;
      node.style.top = `${box.y}px`;
      node.style.width = `${box.w}px`;
      node.style.opacity = String(layer.opacity);
      node.style.transform = layer.rotation ? `rotate(${layer.rotation}deg)` : '';
      if (layer.type === 'image') {
        node.style.height = `${box.h}px`;
        const { entry, url } = imageSource(layer);
        const radius = (layer.radius / 100) * Math.min(box.w, box.h);
        let img = node.querySelector('img');
        let holder = node.querySelector('.nv-cmp-placeholder');
        if (url) {
          if (holder) holder.remove();
          if (!img) {
            img = el('img', { alt: '', draggable: 'false' });
            img.addEventListener('load', () => {
              imageSizes.set(img.src, { w: img.naturalWidth, h: img.naturalHeight });
            });
            node.append(img);
          }
          if (img.getAttribute('src') !== url) img.setAttribute('src', url);
          img.style.objectFit = layer.fit === 'contain' ? 'contain' : layer.fit === 'fill' ? 'fill' : 'cover';
          img.style.transform = layer.flip_x || layer.flip_y ? `scale(${layer.flip_x ? -1 : 1}, ${layer.flip_y ? -1 : 1})` : '';
          img.style.borderRadius = `${radius}px`;
        } else {
          if (img) img.remove();
          if (!holder) {
            holder = el('div', { class: 'nv-cmp-placeholder' });
            node.append(holder);
          }
          holder.textContent = '';
          holder.style.borderRadius = `${radius}px`;
          holder.append(
            icon('image', Math.max(16, Math.min(64, box.w / 6))),
            el('span', { text: entry ? T('nodes.composer.imagePending', { n: layer.input + 1, name: entry.label || '' }) : T('nodes.composer.imageMissing', { n: layer.input + 1 }) })
          );
        }
      } else if (layer.type === 'shape') {
        node.style.height = `${box.h}px`;
        const fill = model.splitColor(layer.fill, '#111111');
        node.style.background = colorCss(fill);
        node.style.borderRadius = layer.shape === 'ellipse' ? '50%' : `${(layer.radius / 100) * Math.min(box.w, box.h)}px`;
      } else {
        node.style.height = '';
        const px = model.fontPx(layer, size);
        const color = model.splitColor(layer.color, '#111111');
        node.style.fontFamily = `"${cssFamily(layer.font)}", "${cssFamily(model.DEFAULT_FONT)}", sans-serif`;
        node.style.fontWeight = String(layer.weight);
        node.style.fontSize = `${px}px`;
        node.style.lineHeight = String(layer.line_height);
        node.style.letterSpacing = `${layer.letter_spacing}em`;
        node.style.textAlign = layer.align;
        node.style.color = colorCss(color);
        node.style.fontVariationSettings = `"opsz" ${Math.round(px)}`;
        node.style.fontFeatureSettings = layer.letter_spacing ? '"liga" 0, "clig" 0, "dlig" 0, "calt" 0' : '';
        node.style.textShadow = layer.shadow ? `0 ${0.04 * px}px ${0.12 * px}px rgba(0, 0, 0, 0.45)` : '';
        if (editingText !== layer.id) node.textContent = model.layerText({ ...layer, uppercase: false }, textsOf());
        node.style.textTransform = layer.uppercase ? 'uppercase' : '';
        node.classList.toggle('is-bound', Number.isInteger(layer.text_input));
      }
      return node;
    }

    function colorCss(color) {
      const r = parseInt(color.rgb.slice(1, 3), 16);
      const g = parseInt(color.rgb.slice(3, 5), 16);
      const b = parseInt(color.rgb.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${color.alpha})`;
    }

    function drawStage() {
      const size = canvas();
      stage.classList.toggle('is-transparent', doc.transparent);
      stage.style.background = doc.transparent ? '' : colorCss(model.splitColor(doc.background, '#ffffff'));
      const keep = new Set(doc.layers.map((layer) => layer.id));
      for (const [id, node] of layerEls) {
        if (!keep.has(id)) {
          node.remove();
          layerEls.delete(id);
        }
      }
      doc.layers.forEach((layer) => {
        const node = drawLayer(layer);
        if (stage.lastChild !== node) stage.append(node);
      });
      // the order of the elements is the order of the layers
      doc.layers.forEach((layer, index) => {
        const node = layerEls.get(layer.id);
        if (stage.children[index] !== node) stage.insertBefore(node, stage.children[index] || null);
      });
      // text boxes are as high as their lines
      for (const layer of doc.layers) if (layer.type === 'text') measured.set(layer.id, layerEls.get(layer.id).offsetHeight);
      sizeLabel.textContent = `${size.width} × ${size.height} px`;
    }

    function boxOf(layer) {
      const size = canvas();
      return model.boxPx(layer, size, layer.type === 'text' ? measured.get(layer.id) : undefined);
    }

    /* ----- selection frame ----- */

    function drawSelection() {
      overlay.textContent = '';
      const layer = selected ? layerById(selected) : null;
      if (!layer || layer.hidden) return;
      const box = boxOf(layer);
      const start = toScreen(box.x, box.y);
      const frame = el('div', { class: `nv-cmp-frame${layer.locked ? ' is-locked' : ''}` });
      frame.style.left = `${start.x}px`;
      frame.style.top = `${start.y}px`;
      frame.style.width = `${box.w * zoom}px`;
      frame.style.height = `${box.h * zoom}px`;
      frame.style.transform = layer.rotation ? `rotate(${layer.rotation}deg)` : '';
      overlay.append(frame);
      if (layer.locked || editingText === layer.id) return;
      const handles = layer.type === 'text' ? [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0], [1, 0]] : [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
      for (const [hx, hy] of handles) {
        const handle = el('div', { class: `nv-cmp-handle${hx && hy ? ' is-corner' : ''}`, dataset: { hx: String(hx), hy: String(hy) } });
        handle.style.left = `${((hx + 1) / 2) * box.w * zoom - HANDLE / 2}px`;
        handle.style.top = `${((hy + 1) / 2) * box.h * zoom - HANDLE / 2}px`;
        handle.style.cursor = resizeCursor(hx, hy, layer.rotation);
        handle.addEventListener('pointerdown', (event) => startResize(event, layer, hx, hy));
        frame.append(handle);
      }
      const rotate = el('div', { class: 'nv-cmp-rotate', title: T('nodes.composer.rotateHint') });
      rotate.style.left = `${(box.w * zoom) / 2 - 7}px`;
      rotate.style.top = `${-ROTATE_GAP - 7}px`;
      rotate.addEventListener('pointerdown', (event) => startRotate(event, layer));
      frame.append(el('div', { class: 'nv-cmp-rotate-line', style: `left:${(box.w * zoom) / 2}px;top:${-ROTATE_GAP + 7}px;height:${ROTATE_GAP - 7}px` }), rotate);
    }

    function resizeCursor(hx, hy, rotation) {
      const base = Math.atan2(hy, hx) * (180 / Math.PI) + (rotation || 0);
      const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
      const index = Math.round((((base % 180) + 180) % 180) / 45) % 4;
      return names[index];
    }

    function drawGuides(list) {
      guides.textContent = '';
      for (const guide of list || []) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        const a = guide.axis === 'x' ? toScreen(guide.pos, guide.from) : toScreen(guide.from, guide.pos);
        const b = guide.axis === 'x' ? toScreen(guide.pos, guide.to) : toScreen(guide.to, guide.pos);
        line.setAttribute('x1', String(a.x));
        line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x));
        line.setAttribute('y2', String(b.y));
        line.setAttribute('class', guide.stage ? 'is-stage' : '');
        guides.append(line);
      }
    }

    /* ----- pointer work on the stage ----- */

    function targetsFor(id) {
      const others = doc.layers.filter((layer) => layer.id !== id && !layer.hidden).map((layer) => model.bounds(boxOf(layer), layer.rotation));
      return model.snapTargets(canvas(), others);
    }

    function setBox(layer, box) {
      const percent = model.fromPx(box, canvas());
      layer.x = percent.x;
      layer.y = percent.y;
      layer.w = Math.max(0.1, percent.w);
      if (layer.type !== 'text') layer.h = Math.max(0.1, percent.h);
    }

    function beginDrag(event, info) {
      event.preventDefault();
      event.stopPropagation();
      drag = { ...info, pointer: event.pointerId, before: snapshot(), moved: false };
      root.setPointerCapture?.(event.pointerId);
      root.addEventListener('pointermove', onDragMove);
      root.addEventListener('pointerup', onDragEnd);
      root.addEventListener('pointercancel', onDragEnd);
    }

    function onDragMove(event) {
      if (!drag || event.pointerId !== drag.pointer) return;
      const point = stagePoint(event);
      drag.moved = drag.moved || Math.hypot(point.x - drag.start.x, point.y - drag.start.y) * zoom > 2;
      if (!drag.moved) return;
      drag.update(point, event);
      const layer = layerById(drag.id);
      if (layer) drawLayer(layer);
      if (layer && layer.type === 'text') measured.set(layer.id, layerEls.get(layer.id).offsetHeight);
      drawSelection();
      paintProps();
    }

    function onDragEnd(event) {
      if (!drag || event.pointerId !== drag.pointer) return;
      root.removeEventListener('pointermove', onDragMove);
      root.removeEventListener('pointerup', onDragEnd);
      root.removeEventListener('pointercancel', onDragEnd);
      drawGuides([]);
      const finished = drag;
      drag = null;
      if (!finished.moved) {
        if (finished.onClick) finished.onClick(event);
        return;
      }
      const after = snapshot();
      if (after !== finished.before) {
        past.push(finished.before);
        if (past.length > HISTORY_MAX) past.shift();
        future.length = 0;
        save(JSON.parse(finished.before));
      }
      render();
    }

    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest('.nv-cmp-layer');
      if (editingText && target && target.dataset.id === editingText) return;
      if (editingText) finishTextEdit();
      // a click goes to the topmost unlocked layer under the pointer
      const hit = target ? layerById(target.dataset.id) : null;
      if (!hit || hit.locked) {
        select(null);
        return;
      }
      if (selected !== hit.id) select(hit.id);
      startMove(event, hit);
    });
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target === viewport || event.target === sizer || event.target === guides) {
        if (editingText) finishTextEdit();
        select(null);
      }
    });
    stage.addEventListener('dblclick', (event) => {
      const target = event.target.closest('.nv-cmp-layer');
      const layer = target ? layerById(target.dataset.id) : null;
      if (layer && layer.type === 'text' && !layer.locked) startTextEdit(layer);
      if (layer && layer.type === 'image' && !layer.locked) fitImageAspect(layer);
    });

    function startMove(event, layer) {
      const start = stagePoint(event);
      const origin = boxOf(layer);
      const targets = targetsFor(layer.id);
      beginDrag(event, {
        id: layer.id,
        start,
        update(point, moveEvent) {
          let dx = point.x - start.x;
          let dy = point.y - start.y;
          if (moveEvent.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          let box = { ...origin, x: origin.x + dx, y: origin.y + dy };
          let shown = [];
          if (!(moveEvent.metaKey || moveEvent.ctrlKey)) {
            const snap = model.snapMove(model.bounds(box, layer.rotation), targets, SNAP_PX / zoom);
            box = { ...box, x: box.x + (moveEvent.shiftKey && dx === 0 ? 0 : snap.dx), y: box.y + (moveEvent.shiftKey && dy === 0 ? 0 : snap.dy) };
            shown = snap.guides;
          }
          setBox(layer, box);
          drawGuides(shown);
          showHint(`X ${fmt(box.x)} · Y ${fmt(box.y)}`);
        }
      });
    }

    // Resize from a handle (hx, hy in -1, 0, 1). The opposite side stays where it is (Alt: the centre); images keep their proportions at
    // the corners (Shift: free), shapes are free (Shift: keep); a text changes its width at the sides and its size at the corners.
    function startResize(event, layer, hx, hy) {
      if (event.button !== 0) return;
      const start = stagePoint(event);
      const origin = boxOf(layer);
      const originSize = layer.size;
      const rad = (layer.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const targets = targetsFor(layer.id);
      const aspect = origin.w / Math.max(1e-6, origin.h);
      beginDrag(event, {
        id: layer.id,
        start,
        update(point, moveEvent) {
          const dx = point.x - start.x;
          const dy = point.y - start.y;
          // the pointer movement in the axes of the turned box
          const lx = dx * cos + dy * sin;
          const ly = -dx * sin + dy * cos;
          const fromCentre = moveEvent.altKey;
          const factor = fromCentre ? 2 : 1;
          let w = origin.w + hx * lx * factor;
          let h = origin.h + hy * ly * factor;
          const corner = hx !== 0 && hy !== 0;
          const keep = layer.type === 'text' ? corner : layer.type === 'image' ? corner !== moveEvent.shiftKey : moveEvent.shiftKey;
          if (keep && layer.type !== 'text') {
            if (corner) {
              if (Math.abs(w / origin.w) > Math.abs(h / origin.h)) h = w / aspect;
              else w = h * aspect;
            } else if (hx) h = w / aspect;
            else w = h * aspect;
          }
          if (layer.type === 'text' && corner) {
            const scale = Math.max(MIN_PX / origin.w, w / origin.w);
            w = origin.w * scale;
            layer.size = model.round(Math.max(0.2, Math.min(100, originSize * scale)));
            h = origin.h * scale;
          }
          w = Math.max(MIN_PX, w);
          h = Math.max(MIN_PX, h);
          let box = placeResized(origin, w, h, hx, hy, fromCentre, keep, cos, sin);
          let shown = [];
          if (!layer.rotation && !(moveEvent.metaKey || moveEvent.ctrlKey) && !(layer.type === 'text' && corner)) {
            const edges = [];
            if (hx < 0 || (fromCentre && hx)) edges.push('left');
            if (hx > 0 || (fromCentre && hx)) edges.push('right');
            if (layer.type !== 'text') {
              if (hy < 0 || (fromCentre && hy)) edges.push('top');
              if (hy > 0 || (fromCentre && hy)) edges.push('bottom');
            }
            const snap = model.snapEdges(box, edges, targets, SNAP_PX / zoom);
            if (snap.dx && !keep) {
              w = Math.max(MIN_PX, w + (hx > 0 ? snap.dx : -snap.dx) * (fromCentre ? 2 : 1));
            }
            if (snap.dy && !keep) {
              h = Math.max(MIN_PX, h + (hy > 0 ? snap.dy : -snap.dy) * (fromCentre ? 2 : 1));
            }
            if ((snap.dx || snap.dy) && !keep) {
              box = placeResized(origin, w, h, hx, hy, fromCentre, keep, cos, sin);
              shown = snap.guides;
            }
          }
          setBox(layer, box);
          drawGuides(shown);
          showHint(layer.type === 'text' && corner ? `${fmt(model.fontPx(layer, canvas()))} px` : `${fmt(box.w)} × ${fmt(box.h)}`);
        }
      });
    }

    // The box after a resize: the fixed point (the opposite handle, or the centre) stays in place on the turned stage
    function placeResized(origin, w, h, hx, hy, fromCentre, keep, cos, sin) {
      const cx = origin.x + origin.w / 2;
      const cy = origin.y + origin.h / 2;
      if (fromCentre) return { x: cx - w / 2, y: cy - h / 2, w, h };
      // the fixed point: the opposite handle; with kept proportions at a side handle the middle of the opposite side
      const ax = -hx * (origin.w / 2);
      const ay = -hy * (origin.h / 2);
      const fixed = { x: cx + ax * cos - ay * sin, y: cy + ax * sin + ay * cos };
      const nx = -hx * (w / 2);
      const ny = -hy * (h / 2);
      const centre = { x: fixed.x - (nx * cos - ny * sin), y: fixed.y - (nx * sin + ny * cos) };
      return { x: centre.x - w / 2, y: centre.y - h / 2, w, h };
    }

    function startRotate(event, layer) {
      if (event.button !== 0) return;
      const start = stagePoint(event);
      const box = boxOf(layer);
      const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const startAngle = Math.atan2(start.y - centre.y, start.x - centre.x);
      const origin = layer.rotation;
      beginDrag(event, {
        id: layer.id,
        start,
        update(point, moveEvent) {
          const now = Math.atan2(point.y - centre.y, point.x - centre.x);
          let value = origin + ((now - startAngle) * 180) / Math.PI;
          if (moveEvent.shiftKey) value = Math.round(value / 15) * 15;
          else {
            // straight angles catch the turn
            const nearest = Math.round(value / 90) * 90;
            if (Math.abs(nearest - value) < 3) value = nearest;
          }
          layer.rotation = model.normalizeLayer({ ...layer, rotation: value }).rotation;
          showHint(`${fmt(layer.rotation)}°`);
        }
      });
    }

    let hintTimer = null;
    function showHint(text) {
      hint.textContent = text;
      hint.classList.add('is-on');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.remove('is-on'), 900);
    }

    /* ----- text editing on the stage ----- */

    function startTextEdit(layer) {
      if (Number.isInteger(layer.text_input)) {
        showHint(T('nodes.composer.textBound'));
        return;
      }
      const node = layerEls.get(layer.id);
      if (!node) return;
      select(layer.id);
      editingText = layer.id;
      editingBefore = snapshot();
      node.textContent = layer.text;
      node.setAttribute('contenteditable', 'plaintext-only');
      if (node.contentEditable !== 'plaintext-only') node.setAttribute('contenteditable', 'true');
      node.classList.add('is-editing');
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = global.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      drawSelection();
    }
    let editingBefore = null;
    function onTextInput(event) {
      const node = event.target.closest('.nv-cmp-layer');
      if (!node || node.dataset.id !== editingText) return;
      const layer = layerById(editingText);
      if (!layer) return;
      layer.text = model.normalizeLayer({ ...layer, text: node.innerText.replace(/\n$/, '') }).text;
      measured.set(layer.id, node.offsetHeight);
      drawSelection();
      paintProps();
    }
    stage.addEventListener('input', onTextInput);
    stage.addEventListener('paste', (event) => {
      if (!editingText) return;
      // only plain text comes in
      event.preventDefault();
      const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
      document.execCommand('insertText', false, text);
    });
    function finishTextEdit() {
      const id = editingText;
      if (!id) return;
      editingText = null;
      const node = layerEls.get(id);
      if (node) {
        node.removeAttribute('contenteditable');
        node.classList.remove('is-editing');
      }
      const before = editingBefore;
      editingBefore = null;
      if (before && before !== snapshot()) {
        past.push(before);
        if (past.length > HISTORY_MAX) past.shift();
        future.length = 0;
        save(JSON.parse(before));
      }
      render();
    }

    /* ----- actions on layers ----- */

    function select(id) {
      if (editingText && editingText !== id) finishTextEdit();
      selected = id;
      drawSelection();
      paintLayers();
      paintProps(true);
    }

    function addLayer(layer) {
      change(() => {
        doc.layers.push(layer);
        selected = layer.id;
      });
      paintProps(true);
    }

    function addImage(index) {
      const size = canvas();
      const entry = sources.images[index];
      const url = entry && entry.value && typeof entry.value.url === 'string' ? ui.mediaUrl(entry.value) : '';
      const place = (naturalW, naturalH) => {
        const aspect = naturalW && naturalH ? naturalW / naturalH : 1;
        // the image fits into 80 % of the stage, in its own proportions
        let w = size.width * 0.8;
        let h = w / aspect;
        if (h > size.height * 0.8) {
          h = size.height * 0.8;
          w = h * aspect;
        }
        const box = model.fromPx({ x: (size.width - w) / 2, y: (size.height - h) / 2, w, h }, size);
        addLayer(model.newLayer('image', doc.layers, { ...box, input: index, name: entry && entry.label ? entry.label : '' }));
      };
      if (!url) return place(1, 1);
      const probe = new Image();
      probe.onload = () => place(probe.naturalWidth, probe.naturalHeight);
      probe.onerror = () => place(1, 1);
      probe.src = url;
    }

    function addText(textInput) {
      const size = canvas();
      const brandHead = model.brandFonts(sources.brand).find((font) => /head|title|display/i.test(font.role)) || model.brandFonts(sources.brand)[0];
      const brandText = model.brandColors(sources.brand).find((color) => /text|ink|primary/i.test(color.role));
      const background = doc.transparent ? '#ffffff' : doc.background;
      const dark = luminance(background) > 0.5;
      const sizePercent = model.round((Math.min(size.width, size.height) * 0.08 * 100) / size.width);
      addLayer(
        model.newLayer('text', doc.layers, {
          x: 10,
          y: 42,
          w: 80,
          text: T('nodes.composer.newText'),
          text_input: Number.isInteger(textInput) ? textInput : null,
          font: brandHead ? brandHead.family : model.DEFAULT_FONT,
          weight: brandHead ? brandHead.weight : 700,
          size: sizePercent,
          color: brandText ? brandText.hex : dark ? '#111111' : '#ffffff'
        })
      );
    }

    function addShape(shape) {
      const size = canvas();
      const side = Math.min(size.width, size.height) * 0.4;
      const box = model.fromPx({ x: (size.width - side) / 2, y: (size.height - side) / 2, w: side, h: side }, size);
      const accent = model.brandColors(sources.brand).find((color) => /accent|primary|brand/i.test(color.role));
      addLayer(model.newLayer('shape', doc.layers, { ...box, shape, fill: accent ? accent.hex : '#d8a25f' }));
    }

    function luminance(hex) {
      const color = model.splitColor(hex, '#ffffff').rgb;
      const [r, g, b] = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function updateLayer(id, patch, { push = true } = {}) {
      change(
        () => {
          const index = doc.layers.findIndex((layer) => layer.id === id);
          if (index < 0) return;
          const next = model.normalizeLayer({ ...doc.layers[index], ...patch });
          if (next) doc.layers[index] = next;
        },
        { push }
      );
    }

    function removeLayer(id) {
      change(() => {
        doc.layers = doc.layers.filter((layer) => layer.id !== id);
        if (selected === id) selected = null;
      });
      paintProps(true);
    }

    function duplicateLayer(id) {
      const layer = layerById(id);
      if (!layer) return;
      const copy = model.newLayer(layer.type, doc.layers, { ...clone(layer), x: layer.x + 2, y: layer.y + 2, locked: false });
      change(() => {
        const index = doc.layers.findIndex((item) => item.id === id);
        doc.layers.splice(index + 1, 0, copy);
        selected = copy.id;
      });
      paintProps(true);
    }

    // where: 'up' | 'down' | 'top' | 'bottom' | a number (the new index)
    function moveLayer(id, where) {
      change(() => {
        const index = doc.layers.findIndex((layer) => layer.id === id);
        if (index < 0) return;
        const [layer] = doc.layers.splice(index, 1);
        let target = index;
        if (where === 'up') target = Math.min(doc.layers.length, index + 1);
        else if (where === 'down') target = Math.max(0, index - 1);
        else if (where === 'top') target = doc.layers.length;
        else if (where === 'bottom') target = 0;
        else if (Number.isInteger(where)) target = Math.max(0, Math.min(doc.layers.length, where));
        doc.layers.splice(target, 0, layer);
      });
    }

    function alignLayer(id, how) {
      const layer = layerById(id);
      if (!layer) return;
      const size = canvas();
      const box = boxOf(layer);
      const outer = model.bounds(box, layer.rotation);
      let dx = 0;
      let dy = 0;
      if (how === 'left') dx = -outer.x;
      if (how === 'hcenter') dx = size.width / 2 - (outer.x + outer.w / 2);
      if (how === 'right') dx = size.width - (outer.x + outer.w);
      if (how === 'top') dy = -outer.y;
      if (how === 'vcenter') dy = size.height / 2 - (outer.y + outer.h / 2);
      if (how === 'bottom') dy = size.height - (outer.y + outer.h);
      change(() => setBox(layer, { ...box, x: box.x + dx, y: box.y + dy }));
    }

    // the box of an image gets the proportions of the image (its width stays)
    function fitImageAspect(layer) {
      const { url } = imageSource(layer);
      const known = url ? imageSizes.get(new URL(url, document.baseURI).href) : null;
      const apply = (w, h) => {
        if (!w || !h) return;
        const box = boxOf(layer);
        const height = box.w / (w / h);
        change(() => setBox(layer, { ...box, y: box.y + (box.h - height) / 2, h: height }));
      };
      if (known) return apply(known.w, known.h);
      if (!url) return;
      const probe = new Image();
      probe.onload = () => apply(probe.naturalWidth, probe.naturalHeight);
      probe.src = url;
    }

    function fillStage(layer) {
      change(() => {
        Object.assign(layer, { x: 0, y: 0, w: 100, h: 100, rotation: 0, fit: 'cover' });
      });
    }

    function nudge(id, dx, dy) {
      const layer = layerById(id);
      if (!layer || layer.locked) return;
      const box = boxOf(layer);
      change(() => setBox(layer, { ...box, x: box.x + dx, y: box.y + dy }));
    }

    /* ----- format ----- */

    function setCanvas(patch) {
      const before = canvas();
      change(() => {
        Object.assign(doc, patch);
        const after = canvas();
        if (before.width / before.height !== after.width / after.height) doc.layers = model.retarget(doc.layers, before, after);
      });
      if (fitMode) fit();
      else layout();
    }

    function paintFormats() {
      formatBar.textContent = '';
      for (const format of model.FORMAT_OPTIONS) {
        const active = doc.format === format;
        const chip = el('button', { type: 'button', class: `nv-cmp-chip${active ? ' is-active' : ''}`, role: 'radio', 'aria-checked': active ? 'true' : 'false' });
        if (format !== 'custom') {
          const [rw, rh] = model.FORMATS[format];
          const scale = 12 / Math.max(rw, rh);
          chip.append(el('i', { class: 'nv-cmp-ratio', style: `width:${Math.max(4, rw * scale)}px;height:${Math.max(4, rh * scale)}px` }));
        }
        chip.append(el('span', { text: format === 'custom' ? T('nodes.option.custom') : format }));
        chip.addEventListener('click', () => {
          if (doc.format === format) return;
          const patch = { format };
          if (format === 'custom') Object.assign(patch, canvas());
          setCanvas(patch);
        });
        formatBar.append(chip);
      }
    }

    /* ----- the list of layers ----- */

    let dragRow = null;
    function paintLayers() {
      layersPanel.textContent = '';
      const head = el('div', { class: 'nv-cmp-panel-head' }, el('span', { text: T('nodes.composer.layers') }));
      const adders = el('div', { class: 'nv-cmp-add' });
      const imageBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, icon('image', 14), el('span', { text: T('nodes.composer.addImage') }));
      imageBtn.addEventListener('click', (event) => {
        if (!sources.images.length) {
          showHint(T('nodes.composer.noImages'));
          return;
        }
        if (sources.images.length === 1) return addImage(0);
        const rect = event.currentTarget.getBoundingClientRect();
        ui.menu(
          rect.left,
          rect.bottom + 4,
          sources.images.map((entry, index) => ({ label: `${index + 1} · ${entry.label || T('nodes.composer.image')}`, onClick: () => addImage(index) }))
        );
      });
      const textBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, icon('text', 14), el('span', { text: T('nodes.composer.addText') }));
      textBtn.addEventListener('click', () => addText());
      const shapeBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, icon('shape', 14), el('span', { text: T('nodes.composer.addShape') }));
      shapeBtn.addEventListener('click', (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        ui.menu(rect.left, rect.bottom + 4, [
          { label: T('nodes.composer.rect'), onClick: () => addShape('rect') },
          { label: T('nodes.composer.ellipse'), onClick: () => addShape('ellipse') }
        ]);
      });
      adders.append(imageBtn, textBtn, shapeBtn);
      const list = el('ol', { class: 'nv-cmp-list', 'aria-label': T('nodes.composer.layers') });
      const ordered = doc.layers.map((layer, index) => ({ layer, index })).reverse();
      for (const { layer, index } of ordered) list.append(layerRow(layer, index));
      if (!doc.layers.length) list.append(el('li', { class: 'nv-cmp-empty', text: T('nodes.composer.emptyList') }));
      layersPanel.append(head, adders, list, inputsBlock());
    }

    function layerRow(layer, index) {
      const row = el('li', { class: `nv-cmp-row${layer.id === selected ? ' is-selected' : ''}${layer.hidden ? ' is-hidden' : ''}`, draggable: 'true', dataset: { id: layer.id } });
      const thumb = el('span', { class: `nv-cmp-thumb is-${layer.type}` });
      if (layer.type === 'image') {
        const { url } = imageSource(layer);
        if (url) thumb.append(el('img', { src: url, alt: '', draggable: 'false' }));
        else thumb.append(icon('image', 14));
      } else if (layer.type === 'text') thumb.append(icon('text', 14));
      else {
        const swatch = el('i', { class: `nv-cmp-swatch${layer.shape === 'ellipse' ? ' is-round' : ''}` });
        swatch.style.background = colorCss(model.splitColor(layer.fill));
        thumb.append(swatch);
      }
      const name = el('span', { class: 'nv-cmp-name', text: rowName(layer) });
      const eye = el('button', { type: 'button', class: 'nv-cmp-icon', title: T(layer.hidden ? 'nodes.composer.show' : 'nodes.composer.hide'), 'aria-label': T(layer.hidden ? 'nodes.composer.show' : 'nodes.composer.hide') }, icon(layer.hidden ? 'eye-off' : 'eye', 14));
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        updateLayer(layer.id, { hidden: !layer.hidden });
      });
      const lock = el('button', { type: 'button', class: `nv-cmp-icon${layer.locked ? ' is-on' : ''}`, title: T(layer.locked ? 'nodes.composer.unlock' : 'nodes.composer.lock'), 'aria-label': T(layer.locked ? 'nodes.composer.unlock' : 'nodes.composer.lock') }, icon(layer.locked ? 'lock' : 'unlock', 14));
      lock.addEventListener('click', (event) => {
        event.stopPropagation();
        updateLayer(layer.id, { locked: !layer.locked });
      });
      row.append(thumb, name, eye, lock);
      row.addEventListener('click', () => select(layer.id));
      row.addEventListener('dblclick', () => renameRow(row, name, layer));
      row.addEventListener('dragstart', (event) => {
        dragRow = { id: layer.id, index };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', layer.id);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => {
        dragRow = null;
        row.classList.remove('is-dragging');
      });
      row.addEventListener('dragover', (event) => {
        if (!dragRow) return;
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        const above = event.clientY < rect.top + rect.height / 2;
        row.classList.toggle('is-drop-above', above);
        row.classList.toggle('is-drop-below', !above);
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop-above', 'is-drop-below'));
      row.addEventListener('drop', (event) => {
        if (!dragRow) return;
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        const above = event.clientY < rect.top + rect.height / 2;
        // the list shows the top layer first: "above" in the list is later in the layers
        let target = above ? index + 1 : index;
        if (dragRow.index < target) target -= 1;
        const moving = dragRow.id;
        dragRow = null;
        if (target !== doc.layers.findIndex((item) => item.id === moving)) moveLayer(moving, target);
        else render();
      });
      return row;
    }

    function rowName(layer) {
      const own = model.layerSummary(layer);
      if (layer.type === 'text' && Number.isInteger(layer.text_input)) {
        const entry = sources.texts[layer.text_input];
        return `${T('nodes.composer.textInput', { n: layer.text_input + 1 })}${entry && entry.label ? ` · ${entry.label}` : ''}`;
      }
      if (own) return own;
      if (layer.type === 'image') return `${T('nodes.composer.image')} ${layer.input + 1}`;
      if (layer.type === 'shape') return T(layer.shape === 'ellipse' ? 'nodes.composer.ellipse' : 'nodes.composer.rect');
      return T('nodes.composer.text');
    }

    function renameRow(row, name, layer) {
      const input = el('input', { class: 'nv-input nv-cmp-rename', type: 'text', maxlength: String(model.LIMITS.nameChars), value: layer.name || rowName(layer) });
      name.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (keep) => {
        if (finished) return;
        finished = true;
        if (keep) updateLayer(layer.id, { name: input.value.trim() });
        else paintLayers();
      };
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (event) => event.stopPropagation());
    }

    // the connected inputs: a click adds them as a layer
    function inputsBlock() {
      const block = el('div', { class: 'nv-cmp-inputs' });
      block.append(el('div', { class: 'nv-cmp-panel-head' }, el('span', { text: T('nodes.composer.inputs') })));
      const grid = el('div', { class: 'nv-cmp-input-grid' });
      sources.images.forEach((entry, index) => {
        const url = entry && entry.value && typeof entry.value.url === 'string' ? ui.mediaUrl(entry.value) : '';
        const tile = el('button', { type: 'button', class: 'nv-cmp-input', title: `${T('nodes.composer.addImage')}: ${index + 1} · ${entry.label || ''}` });
        if (url) tile.append(el('img', { src: url, alt: '', draggable: 'false' }));
        else tile.append(icon('image', 16));
        tile.append(el('span', { class: 'nv-cmp-input-n', text: String(index + 1) }));
        tile.addEventListener('click', () => addImage(index));
        grid.append(tile);
      });
      sources.texts.forEach((entry, index) => {
        const tile = el('button', { type: 'button', class: 'nv-cmp-input is-text', title: `${T('nodes.composer.addText')}: ${T('nodes.composer.textInput', { n: index + 1 })}` });
        tile.append(icon('text', 14), el('span', { class: 'nv-cmp-input-text', text: typeof entry.text === 'string' && entry.text.trim() ? entry.text.trim().slice(0, 40) : entry.label || '' }));
        tile.append(el('span', { class: 'nv-cmp-input-n', text: `T${index + 1}` }));
        tile.addEventListener('click', () => addText(index));
        grid.append(tile);
      });
      if (!grid.children.length) block.append(el('p', { class: 'nv-hint', text: T('nodes.composer.noInputs') }));
      else block.append(grid);
      return block;
    }

    /* ----- settings of the chosen layer (or of the stage) ----- */

    let propsFor = undefined;
    const propFields = new Map();

    // rebuild: the form is built anew (another layer chosen); otherwise only the values are set (while dragging)
    function paintProps(rebuild = false) {
      const layer = selected ? layerById(selected) : null;
      const key = layer ? `${layer.id}:${layer.type}:${layer.type === 'text' ? layer.text_input : ''}:${layer.type === 'shape' ? layer.shape : ''}` : 'stage';
      if (!rebuild && propsFor === key) {
        for (const [, field] of propFields) field.sync && field.sync();
        return;
      }
      propsFor = key;
      propFields.clear();
      propsPanel.textContent = '';
      if (!layer) return paintStageProps();
      const size = canvas();
      const head = el('div', { class: 'nv-cmp-panel-head' }, el('span', { text: rowName(layer) }));
      propsPanel.append(head);

      // position and size in pixels
      const geometry = el('div', { class: 'nv-cmp-grid' });
      const px = (getter, setter, labelText, options = {}) => {
        const input = el('input', { class: 'nv-input nv-cmp-num', type: 'number', step: options.step || '1', 'aria-label': labelText });
        const sync = () => {
          if (document.activeElement !== input) input.value = fmt(getter(), options.digits || 0);
        };
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (Number.isFinite(value)) setter(value);
          else sync();
        });
        input.addEventListener('keydown', (event) => event.stopPropagation());
        sync();
        propFields.set(labelText, { sync });
        return el('label', { class: 'nv-cmp-field' }, el('span', { text: labelText }), input);
      };
      const boxNow = () => boxOf(layerById(layer.id) || layer);
      geometry.append(
        px(() => boxNow().x, (value) => change(() => setBox(layerById(layer.id), { ...boxNow(), x: value })), 'X'),
        px(() => boxNow().y, (value) => change(() => setBox(layerById(layer.id), { ...boxNow(), y: value })), 'Y'),
        px(() => boxNow().w, (value) => change(() => setBox(layerById(layer.id), { ...boxNow(), w: Math.max(MIN_PX, value) })), T('nodes.composer.w')),
        layer.type === 'text'
          ? px(() => boxNow().h, () => paintProps(), T('nodes.composer.h'))
          : px(() => boxNow().h, (value) => change(() => setBox(layerById(layer.id), { ...boxNow(), h: Math.max(MIN_PX, value) })), T('nodes.composer.h')),
        px(() => (layerById(layer.id) || layer).rotation, (value) => updateLayer(layer.id, { rotation: value }), T('nodes.composer.rotation')),
        px(() => Math.round((layerById(layer.id) || layer).opacity * 100), (value) => updateLayer(layer.id, { opacity: Math.max(0, Math.min(100, value)) / 100 }), T('nodes.composer.opacity'))
      );
      if (layer.type === 'text') geometry.querySelectorAll('input')[3].disabled = true;
      propsPanel.append(section(T('nodes.composer.position'), geometry));

      const align = el('div', { class: 'nv-cmp-buttons' });
      for (const [how, name] of [['left', 'align-left'], ['hcenter', 'align-hcenter'], ['right', 'align-right'], ['top', 'align-top'], ['vcenter', 'align-vcenter'], ['bottom', 'align-bottom']]) {
        align.append(toolButton(name, T(`nodes.composer.align.${how}`), () => alignLayer(layer.id, how)));
      }
      propsPanel.append(section(T('nodes.composer.alignStage'), align));

      if (layer.type === 'image') propsPanel.append(...imageProps(layer));
      if (layer.type === 'text') propsPanel.append(...textProps(layer, size));
      if (layer.type === 'shape') propsPanel.append(...shapeProps(layer));

      const arrange = el('div', { class: 'nv-cmp-buttons' });
      arrange.append(
        toolButton('to-front', T('nodes.composer.toFront'), () => moveLayer(layer.id, 'top')),
        toolButton('arrowUp', T('nodes.composer.forward'), () => moveLayer(layer.id, 'up')),
        toolButton('arrowDown', T('nodes.composer.backward'), () => moveLayer(layer.id, 'down')),
        toolButton('to-back', T('nodes.composer.toBack'), () => moveLayer(layer.id, 'bottom')),
        toolButton('duplicate', T('nodes.composer.duplicate'), () => duplicateLayer(layer.id)),
        toolButton('trash', T('nodes.composer.delete'), () => removeLayer(layer.id))
      );
      propsPanel.append(section(T('nodes.composer.arrange'), arrange));
    }

    function section(titleText, ...children) {
      return el('section', { class: 'nv-cmp-section' }, el('h3', { text: titleText }), ...children);
    }

    function segmented(options, current, onPick, labelOf) {
      const group = el('div', { class: 'nv-cmp-seg', role: 'radiogroup' });
      for (const option of options) {
        const active = option.value === current;
        const button = el('button', { type: 'button', class: active ? 'is-active' : '', role: 'radio', 'aria-checked': active ? 'true' : 'false', title: option.title || null });
        if (option.icon) button.append(icon(option.icon, 15));
        if (!option.icon || labelOf) button.append(el('span', { text: labelOf ? labelOf(option) : option.label }));
        button.addEventListener('click', () => onPick(option.value));
        group.append(button);
      }
      return group;
    }

    function selectField(labelText, options, current, onPick) {
      const select = el('select', { class: 'nv-input nv-select', 'aria-label': labelText });
      for (const option of options) {
        if (option.group) {
          const group = el('optgroup', { label: option.group });
          for (const item of option.items) group.append(el('option', { value: item.value, text: item.label, selected: item.value === current ? true : null }));
          select.append(group);
        } else select.append(el('option', { value: option.value, text: option.label, selected: option.value === current ? true : null }));
      }
      select.value = current;
      select.addEventListener('change', () => onPick(select.value));
      select.addEventListener('keydown', (event) => event.stopPropagation());
      return el('label', { class: 'nv-cmp-field is-wide' }, el('span', { text: labelText }), select);
    }

    function colorField(labelText, value, onPick) {
      const color = model.splitColor(value);
      const picker = el('input', { type: 'color', class: 'nv-cmp-color', value: color.rgb, 'aria-label': labelText });
      const hex = el('input', { class: 'nv-input nv-cmp-hex', type: 'text', value, maxlength: '9', spellcheck: 'false', 'aria-label': `${labelText} (hex)` });
      picker.addEventListener('input', () => {
        hex.value = picker.value + (value.length === 9 ? value.slice(7) : '');
      });
      picker.addEventListener('change', () => onPick(picker.value + (value.length === 9 ? value.slice(7) : '')));
      hex.addEventListener('change', () => {
        const next = model.hexColor(hex.value);
        if (next) onPick(next);
        else hex.value = value;
      });
      hex.addEventListener('keydown', (event) => event.stopPropagation());
      const row = el('div', { class: 'nv-cmp-colorrow' }, picker, hex);
      const swatches = model.brandColors(sources.brand);
      const presets = swatches.length ? swatches : [{ hex: '#ffffff' }, { hex: '#111111' }, { hex: '#d8a25f' }, { hex: '#4f8cff' }, { hex: '#e0685f' }];
      const strip = el('div', { class: 'nv-cmp-swatches' });
      for (const swatch of presets.slice(0, 12)) {
        const button = el('button', { type: 'button', class: 'nv-cmp-swatchbtn', title: swatch.name ? `${swatch.name} ${swatch.hex}` : swatch.hex, 'aria-label': swatch.name || swatch.hex });
        button.style.background = swatch.hex;
        button.addEventListener('click', () => onPick(swatch.hex));
        strip.append(button);
      }
      return el('div', { class: 'nv-cmp-field is-wide' }, el('span', { text: labelText }), row, strip);
    }

    function numberField(labelText, value, onPick, { step = 1, min, max, digits = 0, suffix = '' } = {}) {
      const input = el('input', { class: 'nv-input nv-cmp-num', type: 'number', step: String(step), min: min !== undefined ? String(min) : null, max: max !== undefined ? String(max) : null, value: fmt(value, digits), 'aria-label': labelText });
      input.addEventListener('change', () => {
        const number = Number(input.value);
        if (Number.isFinite(number)) onPick(number);
      });
      input.addEventListener('keydown', (event) => event.stopPropagation());
      return el('label', { class: 'nv-cmp-field' }, el('span', { text: suffix ? `${labelText} (${suffix})` : labelText }), input);
    }

    function toggleField(labelText, value, onPick) {
      const input = el('input', { type: 'checkbox', checked: value ? true : null });
      input.addEventListener('change', () => onPick(input.checked));
      return el('label', { class: 'nv-cmp-toggle' }, input, el('span', { text: labelText }));
    }

    function imageProps(layer) {
      const out = [];
      const options = sources.images.map((entry, index) => ({ value: String(index), label: `${index + 1} · ${entry.label || T('nodes.composer.image')}` }));
      if (layer.input >= sources.images.length) options.push({ value: String(layer.input), label: T('nodes.composer.imageMissing', { n: layer.input + 1 }) });
      const fields = el('div', { class: 'nv-cmp-grid' });
      fields.append(selectField(T('nodes.composer.source'), options, String(layer.input), (value) => updateLayer(layer.id, { input: Number(value) })));
      out.push(section(T('nodes.composer.image'), fields));
      out.push(
        section(
          T('nodes.composer.fit'),
          segmented(
            model.FITS.map((fit) => ({ value: fit, label: T(`nodes.composer.fit.${fit}`) })),
            layer.fit,
            (value) => updateLayer(layer.id, { fit: value })
          )
        )
      );
      const look = el('div', { class: 'nv-cmp-grid' });
      look.append(numberField(T('nodes.composer.radius'), layer.radius, (value) => updateLayer(layer.id, { radius: value }), { min: 0, max: 50, suffix: '%' }));
      const flips = el('div', { class: 'nv-cmp-buttons' });
      const flipH = toolButton('flip-h', T('nodes.composer.flipH'), () => updateLayer(layer.id, { flip_x: !layer.flip_x }));
      const flipV = toolButton('flip-v', T('nodes.composer.flipV'), () => updateLayer(layer.id, { flip_y: !layer.flip_y }));
      flipH.classList.toggle('is-on', layer.flip_x);
      flipV.classList.toggle('is-on', layer.flip_y);
      const aspect = toolButton('fit', T('nodes.composer.aspect'), () => fitImageAspect(layer));
      const fill = toolButton('expand', T('nodes.composer.fillStage'), () => fillStage(layerById(layer.id)));
      flips.append(flipH, flipV, aspect, fill);
      out.push(section(T('nodes.composer.look'), look, flips));
      return out;
    }

    function fontOptions(current) {
      const brand = [...new Set(model.brandFonts(sources.brand).map((font) => font.family))];
      const app = model.FONTS.map((font) => font.family);
      const groups = [];
      if (brand.length) groups.push({ group: T('nodes.composer.brandFonts'), items: brand.map((family) => ({ value: family, label: family })) });
      groups.push({ group: T('nodes.composer.appFonts'), items: app.map((family) => ({ value: family, label: family })) });
      if (!brand.includes(current) && !app.includes(current)) groups.push({ group: T('nodes.composer.otherFont'), items: [{ value: current, label: current }] });
      return groups;
    }

    function weightOptions(family) {
      const bundled = model.bundledFont(family);
      const weights = bundled ? model.weightsOf(bundled) : [100, 200, 300, 400, 500, 600, 700, 800, 900];
      return weights.map((weight) => ({ value: String(weight), label: T(`nodes.composer.weight.${weight}`) }));
    }

    function textProps(layer, size) {
      const out = [];
      const content = el('div', { class: 'nv-cmp-grid' });
      if (sources.texts.length || Number.isInteger(layer.text_input)) {
        const options = [{ value: '', label: T('nodes.composer.ownText') }, ...sources.texts.map((entry, index) => ({ value: String(index), label: `${T('nodes.composer.textInput', { n: index + 1 })}${entry.label ? ` · ${entry.label}` : ''}` }))];
        if (Number.isInteger(layer.text_input) && layer.text_input >= sources.texts.length) options.push({ value: String(layer.text_input), label: T('nodes.composer.textInput', { n: layer.text_input + 1 }) });
        content.append(selectField(T('nodes.composer.textSource'), options, Number.isInteger(layer.text_input) ? String(layer.text_input) : '', (value) => updateLayer(layer.id, { text_input: value === '' ? null : Number(value) })));
      }
      if (!Number.isInteger(layer.text_input)) {
        const area = el('textarea', { class: 'nv-input nv-textarea nv-cmp-text', rows: '3', 'aria-label': T('nodes.composer.text'), spellcheck: 'true' });
        area.value = layer.text;
        let before = null;
        area.addEventListener('focus', () => {
          before = snapshot();
        });
        area.addEventListener('input', () => {
          const current = layerById(layer.id);
          if (!current) return;
          current.text = model.normalizeLayer({ ...current, text: area.value }).text;
          drawLayer(current);
          measured.set(current.id, layerEls.get(current.id).offsetHeight);
          drawSelection();
        });
        area.addEventListener('blur', () => {
          if (before && before !== snapshot()) {
            past.push(before);
            future.length = 0;
            save(JSON.parse(before));
            paintLayers();
          }
          before = null;
        });
        area.addEventListener('keydown', (event) => event.stopPropagation());
        propFields.set('text', {
          sync: () => {
            const current = layerById(layer.id);
            if (current && document.activeElement !== area) area.value = current.text;
          }
        });
        content.append(el('label', { class: 'nv-cmp-field is-wide' }, el('span', { text: T('nodes.composer.text') }), area));
      }
      out.push(section(T('nodes.composer.text'), content));

      const type = el('div', { class: 'nv-cmp-grid' });
      type.append(
        selectField(T('nodes.composer.font'), fontOptions(layer.font), layer.font, (value) => {
          const bundled = model.bundledFont(value);
          const weights = bundled ? model.weightsOf(bundled) : null;
          const weight = weights && !weights.includes(layer.weight) ? weights.reduce((best, item) => (Math.abs(item - layer.weight) < Math.abs(best - layer.weight) ? item : best), weights[0]) : layer.weight;
          updateLayer(layer.id, { font: value, weight });
        }),
        selectField(T('nodes.composer.weight'), weightOptions(layer.font), String(layer.weight), (value) => updateLayer(layer.id, { weight: Number(value) })),
        numberField(T('nodes.composer.size'), model.fontPx(layer, size), (value) => updateLayer(layer.id, { size: (Math.max(1, value) / size.width) * 100 }), { min: 1, suffix: 'px' }),
        numberField(T('nodes.composer.lineHeight'), layer.line_height, (value) => updateLayer(layer.id, { line_height: value }), { step: 0.05, min: 0.5, max: 4, digits: 2 }),
        numberField(T('nodes.composer.letterSpacing'), layer.letter_spacing * 100, (value) => updateLayer(layer.id, { letter_spacing: value / 100 }), { step: 1, min: -20, max: 100, suffix: '%' })
      );
      out.push(section(T('nodes.composer.type'), type));
      out.push(
        section(
          T('nodes.composer.alignText'),
          segmented(
            model.ALIGNS.map((align) => ({ value: align, icon: `text-${align}`, title: T(`nodes.composer.textAlign.${align}`) })),
            layer.align,
            (value) => updateLayer(layer.id, { align: value })
          )
        )
      );
      out.push(section(T('nodes.composer.color'), colorField(T('nodes.composer.color'), layer.color, (value) => updateLayer(layer.id, { color: value }))));
      const toggles = el('div', { class: 'nv-cmp-toggles' });
      toggles.append(
        toggleField(T('nodes.composer.uppercase'), layer.uppercase, (value) => updateLayer(layer.id, { uppercase: value })),
        toggleField(T('nodes.composer.shadow'), layer.shadow, (value) => updateLayer(layer.id, { shadow: value }))
      );
      out.push(section(T('nodes.composer.style'), toggles));
      return out;
    }

    function shapeProps(layer) {
      const out = [];
      out.push(
        section(
          T('nodes.composer.shape'),
          segmented(
            model.SHAPES.map((shape) => ({ value: shape, label: T(shape === 'ellipse' ? 'nodes.composer.ellipse' : 'nodes.composer.rect') })),
            layer.shape,
            (value) => updateLayer(layer.id, { shape: value })
          )
        )
      );
      out.push(section(T('nodes.composer.fill'), colorField(T('nodes.composer.fill'), layer.fill, (value) => updateLayer(layer.id, { fill: value }))));
      if (layer.shape === 'rect') {
        const look = el('div', { class: 'nv-cmp-grid' });
        look.append(numberField(T('nodes.composer.radius'), layer.radius, (value) => updateLayer(layer.id, { radius: value }), { min: 0, max: 50, suffix: '%' }));
        out.push(section(T('nodes.composer.look'), look));
      }
      return out;
    }

    function paintStageProps() {
      propsPanel.append(el('div', { class: 'nv-cmp-panel-head' }, el('span', { text: T('nodes.composer.stage') })));
      const size = el('div', { class: 'nv-cmp-grid' });
      if (doc.format === 'custom') {
        size.append(
          numberField(T('nodes.param.width'), doc.width, (value) => setCanvas({ width: Math.round(model.clamp(value, model.LIMITS.minEdge, model.LIMITS.maxEdge)) }), { min: model.LIMITS.minEdge, max: model.LIMITS.maxEdge, suffix: 'px' }),
          numberField(T('nodes.param.height'), doc.height, (value) => setCanvas({ height: Math.round(model.clamp(value, model.LIMITS.minEdge, model.LIMITS.maxEdge)) }), { min: model.LIMITS.minEdge, max: model.LIMITS.maxEdge, suffix: 'px' })
        );
      } else {
        size.append(
          selectField(
            T('nodes.param.short_edge'),
            model.SHORT_EDGES.map((edge) => ({ value: String(edge), label: `${edge} px` })),
            String(doc.short_edge),
            (value) => setCanvas({ short_edge: Number(value) })
          )
        );
      }
      propsPanel.append(section(T('nodes.composer.size'), size));
      const background = el('div');
      background.append(toggleField(T('nodes.param.transparent'), doc.transparent, (value) => setCanvas({ transparent: value })));
      if (!doc.transparent) background.append(colorField(T('nodes.param.background'), doc.background, (value) => setCanvas({ background: value })));
      propsPanel.append(section(T('nodes.param.background'), background));
      const tips = el('ul', { class: 'nv-cmp-tips' });
      for (const key of ['move', 'snap', 'resize', 'rotate', 'text', 'keys']) tips.append(el('li', { text: T(`nodes.composer.tip.${key}`) }));
      propsPanel.append(section(T('nodes.composer.tips'), tips));
    }

    /* ----- keyboard ----- */

    function onKey(event) {
      if (!root.isConnected) return;
      const typing = event.target && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      const mod = event.metaKey || event.ctrlKey;
      if (editingText) {
        if (event.key === 'Escape') {
          event.preventDefault();
          finishTextEdit();
        }
        event.stopPropagation();
        return;
      }
      if (typing) return;
      event.stopPropagation();
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (selected) select(null);
        else close();
        return;
      }
      if (mod && key === '0') {
        event.preventDefault();
        fit();
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        event.preventDefault();
        setZoom(stepZoom(1));
        return;
      }
      if (mod && key === '-') {
        event.preventDefault();
        setZoom(stepZoom(-1));
        return;
      }
      if (!selected) return;
      const layer = layerById(selected);
      if (!layer) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeLayer(layer.id);
      } else if (mod && key === 'd') {
        event.preventDefault();
        duplicateLayer(layer.id);
      } else if (event.key === ']') {
        event.preventDefault();
        moveLayer(layer.id, mod ? 'top' : 'up');
      } else if (event.key === '[') {
        event.preventDefault();
        moveLayer(layer.id, mod ? 'bottom' : 'down');
      } else if (event.key === 'Enter' && layer.type === 'text') {
        event.preventDefault();
        startTextEdit(layer);
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        nudge(layer.id, dx, dy);
      }
    }
    global.addEventListener('keydown', onKey, true);

    const onResize = () => {
      if (fitMode) fit();
      else layout();
    };
    global.addEventListener('resize', onResize);

    /* ----- the whole ----- */

    function render() {
      drawStage();
      layout();
      paintLayers();
      paintProps();
      paintFormats();
      undoBtn.disabled = !past.length;
      redoBtn.disabled = !future.length;
    }

    function close() {
      if (editingText) finishTextEdit();
      global.removeEventListener('keydown', onKey, true);
      global.removeEventListener('resize', onResize);
      document.documentElement.classList.remove('nv-cmp-open');
      root.remove();
      if (openEditor === api) openEditor = null;
    }

    // what is connected may change while the editor is open (a run finishes): the stage follows
    function refreshSources() {
      const next = readSources();
      if (JSON.stringify(next) === JSON.stringify(sources)) return;
      sources = next;
      ensureFonts(sources.brand, onFontLoad);
      if (drag || editingText) return;
      render();
      paintProps(true);
    }

    let fontFrame = null;
    function onFontLoad() {
      if (fontFrame) return;
      fontFrame = requestAnimationFrame(() => {
        fontFrame = null;
        if (!root.isConnected || drag) return;
        drawStage();
        drawSelection();
      });
    }

    ensureFonts(sources.brand, onFontLoad);
    paintFormats();
    render();
    requestAnimationFrame(() => {
      fit();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(onFontLoad);
    });
    root.tabIndex = -1;
    root.focus();

    const api = { close, refreshSources, nodeId, get layers() {
      return doc.layers;
    } };
    return api;
  }

  function current() {
    return openEditor;
  }

  OCD.composer = { open, current };
})(window);
