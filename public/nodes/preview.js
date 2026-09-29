'use strict';

// Media previews of the node view (SPEC §13): the result area of a node card (image, video, audio,
// text, number, list grid), thumbnails for the history strip, downloads and the media viewer overlay
// (image zoom, video, audio, text). Text from LLMs and users is only ever set via textContent.
// Loaded after node-ui.js; node-ui calls renderCardPreview() for the preview slot of a card.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const { el, icon, T } = ui;

  const GRID_LIMIT = 12;
  const TEXT_LINES = 8;
  const MEDIA_TYPES = ['image', 'video', 'audio'];

  /* ---------- value helpers ---------- */

  const isMedia = (value) => Boolean(value) && MEDIA_TYPES.includes(value.type) && typeof value.url === 'string';
  const isViewable = (value) => isMedia(value) || (Boolean(value) && (value.type === 'text' || value.type === 'number'));

  // Video sources get a media fragment so browsers paint the first frame as poster.
  function videoSource(value) {
    const url = ui.mediaUrl(value);
    return url ? `${url}#t=0.1` : '';
  }

  // Flattens nested list values into viewable leaves.
  function leaves(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (value.type === 'list' && Array.isArray(value.items)) value.items.forEach((item) => leaves(item, out));
    else out.push(value);
    return out;
  }

  function fileNameOf(value, fallback) {
    if (isMedia(value) && value.file) return value.file;
    if (value && value.type === 'text') return `${fallback || 'text'}.txt`;
    return fallback || 'result';
  }

  /* ---------- clipboard and downloads ---------- */

  async function copyText(text) {
    try {
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        await global.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through to the legacy path */
    }
    const area = el('textarea', { class: 'hidden', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  // Programmatic download of one value: media via its asset URL, text as a small file.
  function download(value, name) {
    if (!value) return;
    let href = '';
    let revoke = null;
    if (isMedia(value)) {
      href = ui.mediaUrl(value);
    } else if (value.type === 'text' || value.type === 'number') {
      const blob = new Blob([String(value.value)], { type: 'text/plain;charset=utf-8' });
      href = URL.createObjectURL(blob);
      revoke = href;
    } else {
      return;
    }
    const link = el('a', { href, download: name || fileNameOf(value), class: 'hidden', rel: 'noopener' });
    document.body.append(link);
    link.click();
    link.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 4000);
  }

  // <a download> element for a media value (used in overlays; anchors never start a card drag).
  function downloadLink(value, className) {
    const label = T('nodes.preview.download');
    return el('a', { class: className || 'nv-pv-tool', href: ui.mediaUrl(value), download: fileNameOf(value), title: label, 'aria-label': label, rel: 'noopener' }, icon('download', 13));
  }

  function copyButton(getText, className) {
    const label = T('nodes.preview.copy');
    const button = el('button', { type: 'button', class: className || 'nv-pv-tool', title: label, 'aria-label': label }, icon('copy', 13));
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = await copyText(getText());
      button.replaceChildren(icon(ok ? 'check' : 'warning', 13));
      button.title = ok ? T('nodes.preview.copied') : T('nodes.preview.copyFailed');
      setTimeout(() => {
        button.replaceChildren(icon('copy', 13));
        button.title = label;
      }, 1400);
    });
    return button;
  }

  /* ---------- media elements ---------- */

  function mediaNode(value, options = {}) {
    if (value.type === 'image') {
      return el('img', { class: 'nv-media nv-media-image', src: ui.mediaUrl(value), alt: '', loading: 'lazy', draggable: 'false' });
    }
    if (value.type === 'video') {
      return el('video', { class: 'nv-media nv-media-video', src: videoSource(value), controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata' });
    }
    return el('audio', { class: 'nv-media nv-media-audio', src: ui.mediaUrl(value), controls: true, preload: 'metadata', autoplay: options.autoplay || null });
  }

  /* ---------- card preview ---------- */

  function shortText(text, max) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  // items: [{ port, value }] of the selected variant. Builds the whole preview area of a card.
  function renderCardPreview(container, items, options = {}) {
    container.textContent = '';
    // Flat list of everything the viewer can show, in reading order; cells map into it by index.
    const viewItems = [];
    const entries = [];
    for (const item of items) {
      const value = item.value;
      const label = options.portLabel ? options.portLabel(item.port) : item.port;
      // A list with one entry (output nodes) reads as that entry.
      const single = value && value.type === 'list' && Array.isArray(value.items) && value.items.length === 1 ? value.items[0] : value;
      if (single && single.type === 'list') {
        const list = single.items || [];
        const first = viewItems.length;
        for (const leaf of leaves(single)) if (isViewable(leaf)) viewItems.push({ value: leaf, label });
        entries.push({ kind: 'list', label, list, first });
      } else if (isViewable(single)) {
        entries.push({ kind: 'single', label, value: single, index: viewItems.length });
        viewItems.push({ value: single, label });
      }
    }
    const open = (index) => openViewer(viewItems, index, { title: options.title });
    const showLabels = entries.length > 1;

    for (const entry of entries) {
      const holder = el('div', { class: 'nv-pv-port' });
      if (showLabels || entry.kind === 'list') {
        const count = entry.kind === 'list' ? ` · ${entry.list.length}` : '';
        holder.append(el('div', { class: 'nv-pv-label', text: `${entry.label}${count}` }));
      }
      const body = el('div', { class: 'nv-pv-body' });
      if (entry.kind === 'single') renderSingle(body, entry.value, () => open(entry.index));
      else renderGrid(body, entry.list, entry.first, open);
      holder.append(body);
      container.append(holder);
    }
    container.classList.toggle('is-empty', !container.children.length);
  }

  function renderSingle(body, value, onOpen) {
    if (isMedia(value)) {
      const frame = el('div', { class: `nv-pv-frame is-${value.type}` });
      frame.append(mediaNode(value));
      const tools = el('div', { class: 'nv-pv-tools' });
      const expand = el('button', { type: 'button', class: 'nv-pv-tool', title: T('nodes.preview.open'), 'aria-label': T('nodes.preview.open') }, icon('fullscreen', 13));
      expand.addEventListener('click', (event) => {
        event.stopPropagation();
        onOpen();
      });
      tools.append(expand, downloadLink(value));
      frame.append(tools);
      if (value.type !== 'audio') frame.addEventListener('dblclick', (event) => {
        if (event.target.closest('video')) return;
        event.stopPropagation();
        onOpen();
      });
      body.append(frame);
    } else if (value.type === 'text') {
      const wrap = el('div', { class: 'nv-pv-textwrap' });
      wrap.append(el('div', { class: 'nv-pv-text nv-scroll', text: value.value, style: `max-height:${TEXT_LINES * 1.5 * 12 + 16}px` }));
      const tools = el('div', { class: 'nv-pv-tools' });
      const expand = el('button', { type: 'button', class: 'nv-pv-tool', title: T('nodes.preview.open'), 'aria-label': T('nodes.preview.open') }, icon('fullscreen', 13));
      expand.addEventListener('click', (event) => {
        event.stopPropagation();
        onOpen();
      });
      tools.append(expand, copyButton(() => value.value));
      wrap.append(tools);
      body.append(wrap);
    } else if (value.type === 'number') {
      body.append(el('div', { class: 'nv-pv-number', text: String(value.value) }));
    }
  }

  function renderGrid(body, list, firstIndex, open) {
    const grid = el('div', { class: 'nv-pv-grid' });
    const shown = list.slice(0, GRID_LIMIT);
    let index = firstIndex;
    shown.forEach((item) => {
      const cell = el('button', { type: 'button', class: 'nv-pv-cell' });
      if (isViewable(item)) {
        const at = index;
        index += 1;
        cell.append(thumb(item, { cover: true }));
        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          open(at);
        });
      } else {
        cell.append(icon('file', 16));
        cell.disabled = true;
      }
      grid.append(cell);
    });
    if (list.length > GRID_LIMIT) {
      const more = el('button', { type: 'button', class: 'nv-pv-cell nv-pv-more', text: `+${list.length - GRID_LIMIT}` });
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        open(index);
      });
      grid.append(more);
    }
    body.append(grid);
  }

  // Small tile for history strips and grids.
  function thumb(value, options = {}) {
    const wrap = el('span', { class: `nv-thumb ${options.cover ? 'is-cover' : ''}`.trim() });
    if (!value) {
      wrap.append(icon('file', 14));
    } else if (value.type === 'image' && isMedia(value)) {
      wrap.append(el('img', { src: ui.mediaUrl(value), alt: '', loading: 'lazy', draggable: 'false' }));
    } else if (value.type === 'video' && isMedia(value)) {
      wrap.append(el('video', { src: videoSource(value), muted: true, preload: 'metadata', playsinline: true, tabindex: '-1' }), el('span', { class: 'nv-thumb-badge' }, icon('play', 9)));
    } else if (value.type === 'audio') {
      wrap.classList.add('is-glyph');
      wrap.append(icon('audio', 16));
    } else if (value.type === 'text') {
      wrap.classList.add('is-text');
      wrap.append(el('span', { text: shortText(value.value, 90) }));
    } else if (value.type === 'number') {
      wrap.classList.add('is-text');
      wrap.append(el('span', { text: String(value.value) }));
    } else if (value.type === 'list') {
      const first = leaves(value).find(isMedia);
      if (first) return thumb(first, options);
      wrap.classList.add('is-text');
      wrap.append(el('span', { text: `${(value.items || []).length} ×` }));
    } else {
      wrap.append(icon('file', 14));
    }
    return wrap;
  }

  /* ---------- viewer overlay ---------- */

  let viewerOpen = null;

  function closeViewer() {
    if (viewerOpen) viewerOpen.close();
  }

  // items: [{ value, label? }]. Shows one item at a time with navigation, zoom (images) and download.
  function openViewer(items, startIndex, options = {}) {
    const list = (items || []).filter((item) => isViewable(item.value));
    if (!list.length) return null;
    closeViewer();
    const previousFocus = document.activeElement;
    let index = Math.max(0, Math.min(startIndex || 0, list.length - 1));

    const backdrop = el('div', { class: 'nv-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('nodes.preview.viewer') });
    const title = el('div', { class: 'nv-viewer-title' });
    const counter = el('div', { class: 'nv-viewer-counter' });
    const actions = el('div', { class: 'nv-viewer-actions' });
    const closeBtn = el('button', { type: 'button', class: 'nv-viewer-btn', title: T('nodes.common.close'), 'aria-label': T('nodes.common.close') }, icon('x', 16));
    const bar = el('div', { class: 'nv-viewer-bar' }, title, counter, actions, closeBtn);
    const stage = el('div', { class: 'nv-viewer-stage' });
    const prevBtn = el('button', { type: 'button', class: 'nv-viewer-nav is-prev', title: T('nodes.pager.prev'), 'aria-label': T('nodes.pager.prev') }, icon('chevron-left', 22));
    const nextBtn = el('button', { type: 'button', class: 'nv-viewer-nav is-next', title: T('nodes.pager.next'), 'aria-label': T('nodes.pager.next') }, icon('chevron', 22));
    backdrop.append(bar, stage, prevBtn, nextBtn);

    const zoom = { scale: 1, x: 0, y: 0, img: null };

    function applyZoom() {
      if (!zoom.img) return;
      zoom.img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
      stage.classList.toggle('is-zoomed', zoom.scale > 1.001);
    }

    function zoomAt(factor, clientX, clientY) {
      if (!zoom.img) return;
      const rect = stage.getBoundingClientRect();
      const px = clientX - rect.left - rect.width / 2;
      const py = clientY - rect.top - rect.height / 2;
      const next = Math.max(1, Math.min(10, zoom.scale * factor));
      const ratio = next / zoom.scale;
      zoom.x = px - (px - zoom.x) * ratio;
      zoom.y = py - (py - zoom.y) * ratio;
      zoom.scale = next;
      if (next === 1) {
        zoom.x = 0;
        zoom.y = 0;
      }
      applyZoom();
    }

    function stopMedia() {
      for (const media of stage.querySelectorAll('video, audio')) media.pause();
    }

    function show() {
      stopMedia();
      stage.textContent = '';
      stage.classList.remove('is-zoomed');
      zoom.scale = 1;
      zoom.x = 0;
      zoom.y = 0;
      zoom.img = null;
      const item = list[index];
      const value = item.value;
      title.textContent = [options.title, item.label].filter(Boolean).join(' · ');
      counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
      actions.textContent = '';
      if (value.type === 'image') {
        const img = el('img', { class: 'nv-viewer-img', src: ui.mediaUrl(value), alt: '', draggable: 'false' });
        zoom.img = img;
        stage.append(img);
      } else if (value.type === 'video') {
        stage.append(el('video', { class: 'nv-viewer-video', src: ui.mediaUrl(value), controls: true, autoplay: true, loop: true, playsinline: true }));
      } else if (value.type === 'audio') {
        stage.append(el('div', { class: 'nv-viewer-audio' }, icon('audio', 34), el('audio', { src: ui.mediaUrl(value), controls: true, autoplay: true })));
      } else if (value.type === 'text') {
        stage.append(el('pre', { class: 'nv-viewer-text nv-scroll', text: value.value }));
      } else {
        stage.append(el('div', { class: 'nv-viewer-number', text: String(value.value) }));
      }
      if (isMedia(value)) actions.append(downloadLink(value, 'nv-viewer-btn'));
      else {
        actions.append(copyButton(() => String(value.value), 'nv-viewer-btn'));
        const save = el('button', { type: 'button', class: 'nv-viewer-btn', title: T('nodes.preview.download'), 'aria-label': T('nodes.preview.download') }, icon('download', 16));
        save.addEventListener('click', () => download(value, `${options.title || 'text'}.txt`));
        actions.append(save);
      }
      prevBtn.classList.toggle('hidden', list.length < 2);
      nextBtn.classList.toggle('hidden', list.length < 2);
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === list.length - 1;
    }

    function go(delta) {
      const next = index + delta;
      if (next < 0 || next >= list.length) return;
      index = next;
      show();
    }

    function close() {
      stopMedia();
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      viewerOpen = null;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
    }

    function onKey(event) {
      const typing = event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (!typing && event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        go(-1);
      } else if (!typing && event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        go(1);
      } else if (!typing && zoom.img && (event.key === '+' || event.key === '=')) {
        event.stopPropagation();
        const rect = stage.getBoundingClientRect();
        zoomAt(1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else if (!typing && zoom.img && (event.key === '-' || event.key === '_')) {
        event.stopPropagation();
        const rect = stage.getBoundingClientRect();
        zoomAt(1 / 1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else if (!typing && zoom.img && event.key === '0') {
        event.stopPropagation();
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        applyZoom();
      }
    }

    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', () => go(-1));
    nextBtn.addEventListener('click', () => go(1));
    stage.addEventListener('pointerdown', (event) => {
      if (event.target === stage) close();
    });
    stage.addEventListener(
      'wheel',
      (event) => {
        if (!zoom.img) return;
        event.preventDefault();
        zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
      },
      { passive: false }
    );
    stage.addEventListener('dblclick', (event) => {
      if (!zoom.img || event.target !== zoom.img) return;
      if (zoom.scale > 1.001) {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        applyZoom();
      } else {
        zoomAt(2.5, event.clientX, event.clientY);
      }
    });
    let pan = null;
    stage.addEventListener('pointerdown', (event) => {
      if (!zoom.img || event.target !== zoom.img || zoom.scale <= 1.001 || event.button !== 0) return;
      pan = { x: event.clientX, y: event.clientY, ox: zoom.x, oy: zoom.y, id: event.pointerId };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('is-panning');
    });
    stage.addEventListener('pointermove', (event) => {
      if (!pan) return;
      zoom.x = pan.ox + (event.clientX - pan.x);
      zoom.y = pan.oy + (event.clientY - pan.y);
      applyZoom();
    });
    const endPan = () => {
      pan = null;
      stage.classList.remove('is-panning');
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);

    document.addEventListener('keydown', onKey, true);
    ui.root().append(backdrop);
    show();
    closeBtn.focus({ preventScroll: true });
    viewerOpen = { close };
    return viewerOpen;
  }

  OCD.preview = {
    isMedia,
    isViewable,
    leaves,
    fileNameOf,
    copyText,
    download,
    downloadLink,
    copyButton,
    mediaNode,
    thumb,
    shortText,
    renderCardPreview,
    openViewer,
    closeViewer,
    isViewerOpen: () => Boolean(viewerOpen)
  };
})(window);
