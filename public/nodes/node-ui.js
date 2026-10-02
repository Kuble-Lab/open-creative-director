'use strict';

// Node cards, generic param widgets and small UI helpers (dialogs, toasts, menus) of the node view.
// Strictly registry-driven: cards and widgets are generated from the descriptors of
// GET /api/nodes/registry. The only per-type knowledge is the generic param `kind`.
// Run UX slots (WP6, filled through canvas.setSlot -> applySlots): status row, message, preview
// (delegated to OCDNodes.preview), variant pager and cost. Card actions (run, pager, open) are
// routed through setCardActions() so cards stay free of run logic.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const api = OCD.api;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------- i18n helpers ---------- */

  const T = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);

  // Translation that falls back when the key is unknown (t() returns the key itself then).
  function tr(key, fallback, vars) {
    const value = T(key, vars);
    return value === key ? fallback : value;
  }

  function humanize(id) {
    const text = String(id || '').replace(/[_-]+/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  const typeLabel = (def) => tr(`nodes.type.${def.type}.label`, def.label || def.type);

  // Search synonyms of a node type in the interface language (nodes.type.<type>.keywords, comma separated phrases).
  // Types without a translation return an empty list; the registry's English keywords are searched in any case.
  function typeKeywords(def) {
    const text = tr(`nodes.type.${def.type}.keywords`, '');
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  // The reasons the server gives for a node that cannot be used, in the interface language. Unknown reasons are
  // shown as they come.
  const AVAILABILITY_REASONS = Object.freeze({
    'OPENROUTER_API_KEY is not set': 'nodes.reason.openrouter',
    'OPENROUTER_API_KEY is not set and ChatGPT is not connected': 'nodes.reason.llm',
    'Higgsfield is not connected': 'nodes.reason.higgsfield',
    'FAL_KEY is not set': 'nodes.reason.fal',
    'ELEVENLABS_API_KEY is not set': 'nodes.reason.elevenlabs',
    'No render node configured': 'nodes.reason.rendernode',
    'ffmpeg/ffprobe not found': 'nodes.reason.ffmpeg',
    '@resvg/resvg-js is not installed': 'nodes.reason.resvg',
    'Not available for your account': 'nodes.reason.account'
  });

  function availabilityReason(reason) {
    if (typeof reason !== 'string') return '';
    const key = AVAILABILITY_REASONS[reason];
    return key ? T(key) : reason;
  }
  const categoryLabel = (category) => tr(`nodes.category.${category}`, humanize(category));
  const portLabel = (id) => tr(`nodes.port.${id}`, humanize(id));
  const paramLabel = (id) => tr(`nodes.param.${id}`, humanize(id));
  const optionLabel = (value) => tr(`nodes.option.${value}`, String(value));

  // Longest suggestion of a provider that is shown on one line behind an error text.
  const SUGGESTION_SHORT = 280;

  // Translated text of a plan / validation issue { code, data?, port?, message }: nodes.issue.<code> with the
  // placeholders of `data` (width -> {w}, height -> {h}, foundWidth -> {foundW}, foundHeight -> {foundH}, format -> its
  // option label), {port} (the label of the input) and {message} (the engine's English wording of the detail); without
  // such a key the engine's own (English) message is shown as before.
  function hasIssueText(code) {
    return Boolean(code) && T(`nodes.issue.${code}`) !== `nodes.issue.${code}`;
  }

  // `variant` picks a wording for a place where the usual remedy is not available: nodes.issue.<code>.<variant>
  // ('plain' = no conversion button offered, 'app' = the Design App has no such button); without such a key the normal
  // text is used.
  function issueText(issue, variant) {
    const item = issue || {};
    const data = item.data || {};
    if (!hasIssueText(item.code)) return item.message || item.code || '';
    const vars = { ...data, w: data.width, h: data.height, foundW: data.foundWidth, foundH: data.foundHeight };
    if (data.format) vars.format = optionLabel(data.format);
    // The input an issue is about, by its label; the engine's own (English) message for the codes that have no more
    // specific wording (a setting that does not fit).
    if (vars.port === undefined && item.port) vars.port = portLabel(item.port);
    if (vars.message === undefined && item.message) vars.message = item.message;
    let key = variant && hasIssueText(`${item.code}.${variant}`) ? `nodes.issue.${item.code}.${variant}` : `nodes.issue.${item.code}`;
    // A text about a number of connections has its own wording for "none" and "one" (nodes.issue.<code>.none / .one).
    const form = data.max === 0 ? 'none' : data.max === 1 ? 'one' : '';
    if (form && key === `nodes.issue.${item.code}` && hasIssueText(`${item.code}.${form}`)) key = `nodes.issue.${item.code}.${form}`;
    const text = T(key, vars);
    // A provider that refuses an input and offers another one (a music prompt with an artist name): the suggestion follows
    // the text, on one line and cut short; the inspector shows it in full.
    const suggestion = typeof data.suggestion === 'string' ? data.suggestion.replace(/\s+/g, ' ').trim() : '';
    if (!suggestion) return text;
    return `${text} ${T('nodes.music.suggestion', { suggestion: suggestion.length > SUGGESTION_SHORT ? `${suggestion.slice(0, SUGGESTION_SHORT - 1)}…` : suggestion })}`;
  }

  // Text of a refused connection { code, data? }. Over the limit of a model it names the model and the limit
  // ("Grok Video 1.5 takes at most 1 reference image."): nodes.connect.too_many.<port>.<none|one|many>, else the generic
  // nodes.connect.too_many.limit.<form>; an input that takes nothing (max 0) says so without a model.
  function connectText(error) {
    const code = error && typeof error === 'object' ? error.code : error;
    const data = error && typeof error === 'object' && error.data ? error.data : null;
    if (code === 'too_many' && data && Number.isFinite(data.max)) {
      const form = data.max === 0 ? 'none' : data.max === 1 ? 'one' : 'many';
      const vars = { model: data.model || '', max: data.max, count: data.count, port: portLabel(data.port) };
      if (data.model) {
        for (const key of [`nodes.connect.too_many.${data.port}.${form}`, `nodes.connect.too_many.limit.${form}`]) {
          if (T(key) !== key) return T(key, vars);
        }
      } else if (data.max === 0) {
        return T('nodes.connect.too_many.none', vars);
      }
    }
    return T(`nodes.connect.${code}`);
  }

  /* ---------- DOM helpers ---------- */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const ICONS = {
    // categories
    input: 'M12 3v11m0 0l-4-4m4 4l4-4M5 17v3h14v-3',
    llm: 'M4 5h16v11H10l-5 4v-4H4z',
    text: 'M5 6h14M12 6v13M9 19h6',
    image: 'M4 5h16v14H4zM4 16l4.5-4.5L13 16l3-3 4 4M9 9.5h.01',
    video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
    audio: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
    cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    'edit-image': 'M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M7 15v4',
    'edit-video': 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
    'edit-audio': 'M3 12h3l2-6 4 12 3-9 2 3h4',
    higgsfield: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3.1-5.4 3.1 1.2-6-4.5-4.2 6.1-.7z',
    fal: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
    utility: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
    output: 'M12 15V4m0 0L8 8m4-4l4 4M5 17v3h14v-3',
    unknown: 'M9.5 9a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 4M12 17h.01',
    // ui
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
    redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    copy: 'M8 8h12v12H8zM4 16V4h12',
    x: 'M6 6l12 12M18 6L6 18',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    upload: 'M12 16V4m0 0L8 8m4-4l4 4M5 16v4h14v-4',
    download: 'M12 4v12m0 0l-4-4m4 4l4-4M5 20h14',
    folder: 'M3 7h6l2 2h10v10H3z',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
    cursor: 'M5 3l14 7-6 2-2 6z',
    hand: 'M8 13V6a1.5 1.5 0 013 0v5m0-6a1.5 1.5 0 013 0v6m0-4a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-1a6 6 0 01-5-3l-3-5a1.5 1.5 0 012.5-1.5L8 15',
    note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
    group: 'M4 4h6M14 4h6M4 20h6M14 20h6M4 4v6M4 14v6M20 4v6M20 14v6',
    back: 'M14 6l-6 6 6 6',
    chevron: 'M9 6l6 6-6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    panel: 'M4 5h16v14H4zM9 5v14',
    'panel-right': 'M4 5h16v14H4zM15 5v14',
    warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
    check: 'M5 12l5 5 9-10',
    link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
    workflow: 'M5 6a2 2 0 104 0 2 2 0 00-4 0zM15 18a2 2 0 104 0 2 2 0 00-4 0zM9 6h3a3 3 0 013 3v3a3 3 0 003 3',
    edit: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
    duplicate: 'M9 9h11v11H9zM4 15V4h11',
    sparkle: 'M12 4l1.8 4.7L18.5 10l-4.7 1.3L12 16l-1.8-4.7L5.5 10l4.7-1.3zM19 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
    fullscreen: 'M4 9V4h5M20 15v5h-5',
    play: 'M8 5.5v13l11-6.5z',
    stop: 'M7 7h10v10H7z',
    skip: 'M5 5.5v13l9-6.5zM18 5v14',
    'chevron-left': 'M15 6l-6 6 6 6',
    refresh: 'M20 11a8 8 0 00-14-4M4 5v4h4M4 13a8 8 0 0014 4M20 19v-4h-4',
    history: 'M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4v4h4M12 8v4l3 2',
    zip: 'M5 3h9l5 5v13H5zM12 3v6M12 11v2M12 15v2',
    clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
    app: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    send: 'M21 3L3 10.5l7 2.5 2.5 7zM21 3L10 13',
    template: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
    help: 'M12 4a8 8 0 100 16 8 8 0 000-16zM9.8 9.6a2.3 2.3 0 114.2 1.3c-.6.8-1.9 1.1-1.9 2.4M12 16.6h.01',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    arrowUp: 'M12 19V5m0 0l-5 5m5-5l5 5',
    arrowDown: 'M12 5v14m0 0l-5-5m5 5l5-5',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    extract: 'M9 6H5v12h4M9 12h11m0 0l-4-4m4 4l-4 4',
    users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 6.6M18 14a6 6 0 013.5 6'
  };

  function icon(name, size = 16, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.unknown);
    svg.append(path);
    return svg;
  }

  function categoryIcon(category, size = 15) {
    return icon(ICONS[category] ? category : 'unknown', size);
  }

  /* ---------- overlay root: dialogs, toasts, menus ---------- */

  let overlayRoot = null;

  function setRoot(node) {
    overlayRoot = node;
  }

  function root() {
    return overlayRoot || document.body;
  }

  // Modal dialog (in-app, never window.confirm/alert/prompt). Resolves with the chosen value.
  // buttons: { label, value, primary?, danger?, cancel?, enter? }. `enter: false` keeps Enter from firing the primary
  // button (paid runs); focus: 'cancel' puts the initial focus on the cancel button.
  function dialog({ title, message, body, buttons, width, onOpen, focus }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const backdrop = el('div', { class: 'nv-dialog-backdrop' });
      const panel = el('div', { class: 'nv-dialog', role: 'dialog', 'aria-modal': 'true', style: width ? `max-width:${width}px` : null });
      if (title) panel.append(el('h2', { class: 'nv-dialog-title', text: title }));
      if (message) panel.append(el('p', { class: 'nv-dialog-message', text: message }));
      if (body) panel.append(body);
      const actions = el('div', { class: 'nv-dialog-actions' });
      const buttonEls = [];
      const finish = (value) => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey, true);
        if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
        resolve(value);
      };
      for (const spec of buttons) {
        const button = el('button', {
          type: 'button',
          class: `nv-btn ${spec.primary ? 'nv-btn-primary' : ''} ${spec.danger ? 'nv-btn-danger' : ''}`.trim(),
          text: spec.label
        });
        button.addEventListener('click', () => {
          if (spec.onClick && spec.onClick(finish) === false) return;
          finish(spec.value);
        });
        actions.append(button);
        buttonEls.push(button);
      }
      panel.append(actions);
      backdrop.append(panel);
      backdrop.addEventListener('pointerdown', (event) => {
        if (event.target === backdrop) finish(buttons.find((b) => b.cancel)?.value ?? null);
      });
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(buttons.find((b) => b.cancel)?.value ?? null);
        } else if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) {
          const index = buttons.findIndex((b) => b.primary && b.enter !== false);
          if (index >= 0) {
            event.preventDefault();
            event.stopPropagation();
            buttonEls[index].click();
          }
        }
      }
      document.addEventListener('keydown', onKey, true);
      root().append(backdrop);
      const cancelIndex = buttons.findIndex((b) => b.cancel);
      const focusTarget =
        (focus === 'cancel' && cancelIndex >= 0 ? buttonEls[cancelIndex] : null) || panel.querySelector('input, textarea, select') || actions.querySelector('.nv-btn-primary') || actions.lastElementChild;
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      if (onOpen) onOpen(panel);
    });
  }

  function confirmDialog({ title, message, confirmLabel, cancelLabel, danger, extra }) {
    return dialog({
      title,
      message,
      body: extra || null,
      buttons: [
        { label: cancelLabel || T('nodes.common.cancel'), value: false, cancel: true },
        { label: confirmLabel || T('nodes.common.confirm'), value: true, primary: !danger, danger: Boolean(danger) }
      ]
    });
  }

  function promptDialog({ title, label, value, placeholder, confirmLabel, maxLength = 120 }) {
    const input = el('input', { class: 'nv-input', type: 'text', maxlength: maxLength, placeholder: placeholder || '', 'aria-label': label || title });
    input.value = value || '';
    const body = el('div', { class: 'nv-dialog-field' }, label ? el('label', { class: 'nv-field-label', text: label }) : null, input);
    return dialog({
      title,
      body,
      buttons: [
        { label: T('nodes.common.cancel'), value: null, cancel: true },
        { label: confirmLabel || T('nodes.common.save'), value: '__input__', primary: true }
      ],
      onOpen: () => {
        input.focus();
        input.select();
      }
    }).then((result) => (result === '__input__' ? input.value.trim() : null));
  }

  let toastHost = null;

  function toast(message, options = {}) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el('div', { class: 'nv-toasts', 'aria-live': 'polite' });
      root().append(toastHost);
    }
    const item = el('div', { class: `nv-toast ${options.kind ? `is-${options.kind}` : ''}`.trim(), role: 'status', text: message });
    toastHost.append(item);
    const remove = () => item.remove();
    setTimeout(remove, options.timeout ?? (options.kind === 'error' ? 7000 : 3500));
    item.addEventListener('click', remove);
    return item;
  }

  let openMenu = null;

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }

  // Context menu at client coordinates. items: [{ label, icon?, shortcut?, danger?, disabled?, onClick } | { separator: true }]
  function menu(x, y, items, options = {}) {
    closeMenu();
    const list = el('div', { class: 'nv-menu', role: 'menu' });
    for (const item of items) {
      if (!item) continue;
      if (item.separator) {
        list.append(el('div', { class: 'nv-menu-sep' }));
        continue;
      }
      const row = el('button', {
        type: 'button',
        role: 'menuitem',
        class: `nv-menu-item ${item.danger ? 'is-danger' : ''} ${item.hint ? 'has-hint' : ''}`.trim(),
        disabled: item.disabled,
        title: item.hint
      });
      // item.hint: a short line under the label, e.g. why the entry is not available
      row.append(
        item.icon ? icon(item.icon, 14) : el('span', { class: 'nv-menu-icon' }),
        item.hint
          ? el('span', { class: 'nv-menu-text' }, el('span', { class: 'nv-menu-label', text: item.label }), el('span', { class: 'nv-menu-hint', text: item.hint }))
          : el('span', { class: 'nv-menu-label', text: item.label })
      );
      if (item.shortcut) row.append(el('kbd', { class: 'nv-kbd', text: item.shortcut }));
      row.addEventListener('click', () => {
        closeMenu();
        item.onClick && item.onClick();
      });
      list.append(row);
    }
    root().append(list);
    const width = list.offsetWidth;
    const height = list.offsetHeight;
    const maxX = global.innerWidth - width - 8;
    const maxY = global.innerHeight - height - 8;
    list.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    list.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
    openMenu = list;
    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && list.contains(event.target)) return;
      if (event.type === 'blur' && event.target !== global) return; // element blurs bubble through the capture phase
      closeMenu();
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      global.removeEventListener('blur', dismiss, true);
      if (options.onClose) options.onClose();
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
      global.addEventListener('blur', dismiss, true);
    });
    return list;
  }

  // Replaces `target` (text element) with an input; Enter/blur commits, Esc cancels.
  function inlineEdit(target, value, onCommit, options = {}) {
    const input = el('input', { class: `nv-inline-input ${options.className || ''}`.trim(), type: 'text', maxlength: options.maxLength || 120, 'aria-label': options.label || '' });
    input.value = value || '';
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      input.replaceWith(target);
      target.style.display = '';
      if (commit && input.value.trim() !== (value || '')) onCommit(input.value.trim());
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    target.style.display = 'none';
    target.after(input);
    input.focus();
    input.select();
  }

  /* ---------- options (select param sources) ---------- */

  const optionCache = new Map();
  const optionListeners = new Set();

  // The views of a 3D model besides the front image: each is an input of its own with a maximum of 0 or 1.
  const VIEW_CAPS = Object.freeze(['left', 'back', 'right']);

  // Entries may carry what a model takes (`references`, `audio`, `videos`, `last_frame`, `durations`, see lib/nodes/routes.js),
  // what an image costs (`estimateUsd`) or a second of video (`perSecondUsd`) and `default: true` for the entry of the model that a node without a choice uses (value ''); they are
  // kept as they come.
  function normalizeOptions(payload) {
    const list = Array.isArray(payload?.options) ? payload.options : Array.isArray(payload) ? payload : [];
    return list.map((option) => {
      if (!option || typeof option !== 'object') return { value: String(option), label: String(option) };
      const out = { value: String(option.value), label: String(option.label ?? option.value) };
      if (option.references && typeof option.references === 'object') out.references = option.references;
      if (option.audio && typeof option.audio === 'object') out.audio = option.audio;
      // video models: reference videos, the end frame ({ max: 0 | 1 }), the durations and what a second costs
      if (option.videos && typeof option.videos === 'object') out.videos = option.videos;
      if (option.last_frame && typeof option.last_frame === 'object') out.last_frame = option.last_frame;
      if (option.durations && typeof option.durations === 'object') out.durations = option.durations;
      if (option.perSecondUsd && typeof option.perSecondUsd === 'object') out.perSecondUsd = option.perSecondUsd;
      if (Number.isFinite(option.estimateUsd) && option.estimateUsd > 0) out.estimateUsd = option.estimateUsd;
      // 3D models (image-to-3d-models): the views besides the front image ({ max } at left, back, right and their number), the
      // price from (with the default options, no extra view) and what the model is good at (a key the page translates)
      for (const view of VIEW_CAPS) if (option[view] && typeof option[view] === 'object' && Number.isFinite(option[view].max)) out[view] = { max: option[view].max };
      if (Number.isFinite(option.views)) out.views = option.views;
      if (Number.isFinite(option.fromUsd) && option.fromUsd > 0) out.fromUsd = option.fromUsd;
      if (typeof option.strength === 'string' && option.strength) out.strength = option.strength;
      if (option.default === true) out.default = true;
      return out;
    });
  }

  // The model lists of the app itself (image-models, image-edit-models): their entries say what a model takes. The
  // Higgsfield lists are only the names; what a model takes is read from its description.
  function isOwnModelList(source) {
    return Boolean(source) && !/^higgsfield-/.test(source);
  }

  // The entries of a select param as the node shows them. A model list starts with the entry of the model that a node without a
  // choice uses, named as such ("Default: GPT Image 2"). The same model once more with an explicit value stays what it is when
  // the server changes its default; its label says so ("GPT Image 2 (fixed)"), or the two entries look like a mistake.
  function selectEntries(param, source, current) {
    const standard = source.options.find((option) => option.default === true);
    const options = source.options
      .filter((option) => option !== standard)
      .map((option) => (param.optionsSource && standard && option.value !== '' && option.label === standard.label ? { ...option, label: T('nodes.option.pinnedNamed', { name: option.label }) } : option));
    // a list without a "default" entry (noDefaultEntry: the 3D models, the node names one of them itself) shows only its models
    if (param.optionsSource && !param.noDefaultEntry) {
      options.unshift(standard
        ? { ...standard, value: '', label: T('nodes.option.defaultNamed', { name: standard.label }) }
        : { value: '', label: source.state === 'loading' ? T('nodes.option.loading') : source.state === 'error' ? T('nodes.option.unavailable') : T('nodes.option.default') });
    }
    if (current !== '' && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
    return options;
  }

  // Option list of a select param: static or from an options source (fetched once, cached).
  function optionsFor(param) {
    if (param.optionsSource) {
      const cached = optionCache.get(param.optionsSource);
      if (!cached) {
        const entry = { state: 'loading', options: [], error: null };
        optionCache.set(param.optionsSource, entry);
        api
          .options(param.optionsSource)
          .then((payload) => {
            entry.options = normalizeOptions(payload);
            entry.state = 'ready';
          })
          .catch((error) => {
            entry.state = 'error';
            entry.error = error.message;
          })
          .finally(() => {
            optionListeners.forEach((fn) => fn(param.optionsSource));
            // a list of the app itself carries what its models take: cards, notices and the plan follow when it arrives
            if (isOwnModelList(param.optionsSource)) modelListeners.forEach((fn) => fn(param.optionsSource));
          });
        return entry;
      }
      return cached;
    }
    return {
      state: 'ready',
      options: (param.options || []).map((option) =>
        option && typeof option === 'object' ? { value: String(option.value), label: String(option.label ?? option.value) } : { value: String(option), label: optionLabel(option) }
      ),
      error: null
    };
  }

  function refreshOptions(source) {
    if (source) optionCache.delete(source);
    else optionCache.clear();
  }

  function onOptionsChange(fn) {
    optionListeners.add(fn);
    return () => optionListeners.delete(fn);
  }

  /* ---------- what the chosen model takes (limits that depend on a param) ---------- */

  // Description of a Higgsfield model (GET /api/nodes/higgsfield-models/:id), fetched once and shared by the inspector
  // and the limits of the inputs. { state: 'loading' | 'ready' | 'error', data, error }.
  const modelDetails = new Map();
  const modelListeners = new Set();

  // A description is not kept for good: the server forgets its copy of the catalogue after an hour (and at every restart),
  // so a limit the page still shows could be out of date. After this time it is read again; the old description stays in
  // use until the new one arrives.
  const MODEL_DETAIL_TTL_MS = 20 * 60 * 1000;

  function loadModelDetail(modelId, entry) {
    entry.loading = true;
    return api
      .higgsfieldModel(modelId)
      .then((data) => {
        entry.data = data;
        entry.state = 'ready';
        entry.error = null;
      })
      .catch((error) => {
        // a description that was read before is kept when the refresh fails
        if (entry.state !== 'ready') {
          entry.state = 'error';
          entry.error = error.message;
        }
      })
      .finally(() => {
        entry.loading = false;
        entry.at = Date.now();
        modelListeners.forEach((fn) => fn(modelId));
      });
  }

  function isStaleDetail(entry) {
    return entry.state === 'ready' && !entry.loading && Date.now() - entry.at > MODEL_DETAIL_TTL_MS;
  }

  function modelDetail(modelId) {
    let entry = modelDetails.get(modelId);
    if (!entry) {
      entry = { state: 'loading', data: null, error: null, at: Date.now(), loading: false };
      modelDetails.set(modelId, entry);
      loadModelDetail(modelId, entry);
    } else if (isStaleDetail(entry)) {
      loadModelDetail(modelId, entry);
    }
    return entry;
  }

  // The entry if the model has been asked for, without asking.
  function peekModelDetail(modelId) {
    return modelDetails.get(modelId) || null;
  }

  // Called with the model id whenever a description arrived (or failed).
  function onModelChange(fn) {
    modelListeners.add(fn);
    return () => modelListeners.delete(fn);
  }

  // A failed read is tried again with the next call (the connection to the provider may be there now).
  function refreshModelDetails() {
    for (const [id, entry] of modelDetails) if (entry.state === 'error') modelDetails.delete(id);
  }

  // Before a run: the descriptions that are out of date are read again (the answer refreshes the cards and the plan).
  function refreshStaleModelDetails() {
    for (const [id, entry] of modelDetails) if (isStaleDetail(entry)) loadModelDetail(id, entry);
  }

  // { name, references, audio } of the option `value` of a model param (`source` = its optionsSource), or null without a
  // value. references: { max, roles, required }, audio: { max }; either is null while it is not known. The option list
  // answers when it carries the media list of the models; if not, the description of the model is read once (async: the
  // listeners are told, the next call knows).
  function optionCapabilities(source, value) {
    const id = String(value ?? '').trim();
    const own = isOwnModelList(source);
    if (own && !optionCache.has(source)) optionsFor({ optionsSource: source });
    const list = source ? optionCache.get(source) : null;
    const ready = Boolean(list && list.state === 'ready');
    if (own) {
      // the entry says what the model takes (none: unknown, the fixed maximum of the input applies); no description to read.
      // Without a choice: the model of the configuration, which the list names as the entry with `default`.
      const entry = ready ? list.options.find((item) => (id ? item.value === id : item.default === true)) : null;
      if (!id && !entry) return null;
      return {
        name: entry ? entry.label : id,
        references: (entry && entry.references) || null,
        audio: (entry && entry.audio) || null,
        videos: (entry && entry.videos) || null,
        last_frame: (entry && entry.last_frame) || null,
        durations: (entry && entry.durations) || null,
        left: (entry && entry.left) || null,
        back: (entry && entry.back) || null,
        right: (entry && entry.right) || null,
        views: entry && Number.isFinite(entry.views) ? entry.views : null,
        strength: (entry && entry.strength) || '',
        error: false
      };
    }
    if (!id) return null;
    const option = ready ? list.options.find((item) => item.value === id) : null;
    let detail = modelDetails.get(id);
    const fromList = Boolean(option && option.references);
    if ((!detail && !fromList) || (detail && isStaleDetail(detail))) detail = modelDetail(id);
    const data = detail && detail.state === 'ready' ? detail.data : null;
    const references = (data && data.references) || (option && option.references) || null;
    return {
      name: (data && data.name) || (option && option.label) || id,
      references,
      audio: (data && data.audio) || (option && option.audio) || null,
      // reading the description failed (the model is gone from the catalogue, or the provider is not reachable)
      error: !references && Boolean(detail && detail.state === 'error')
    };
  }

  // reg.limitsFor of the app (graph.indexRegistry): per input with `limitBy` what the chosen model takes.
  function limitsFor(node, def) {
    const out = {};
    const params = graphLib.effectiveParams(def, node);
    for (const port of def.inputs || []) {
      if (!port.limitBy) continue;
      const param = (def.params || []).find((item) => item.id === port.limitBy.param);
      if (!param) continue;
      const caps = optionCapabilities(param.optionsSource, params[param.id]);
      const cap = caps && caps[port.limitBy.capability];
      if (cap && Number.isFinite(cap.max)) out[port.id] = { max: cap.max, roles: Array.isArray(cap.roles) ? cap.roles : [], required: cap.required === true, subject: caps.name };
      else if (caps && caps.error) out[port.id] = { error: true };
    }
    return out;
  }

  // A role of a reference slot ("start_image") in the interface language; unknown roles are shown readable.
  function roleLabel(role) {
    return tr(`nodes.role.${role}`, humanize(role));
  }

  function hasStartAndEnd(references) {
    const roles = (references.roles || []).map((role) => String(role).toLowerCase());
    return references.max === 2 && roles.some((role) => /start|first/.test(role)) && roles.some((role) => /end|last/.test(role));
  }

  // "1 image", "up to 4 images", "start and end image", "no reference image" (+ "required").
  function referencesText(references) {
    if (!references) return '';
    let text;
    if (references.max === 0) text = T('nodes.cap.refs.none');
    else if (hasStartAndEnd(references)) text = T('nodes.cap.refs.startEnd');
    else if (references.max === 1) text = T('nodes.cap.refs.one');
    else text = T('nodes.cap.refs.upTo', { max: references.max });
    return references.required && references.max > 0 ? `${text} ${T('nodes.cap.required')}` : text;
  }

  function audioText(audio) {
    if (!audio || !(audio.max > 0)) return '';
    return audio.max >= 15 ? T('nodes.cap.audio') : T('nodes.cap.audioUpTo', { max: audio.max });
  }

  // Video models: "end frame" where the model takes one, "videos up to 3", "4-30 s" or "4, 6, 8 s".
  function lastFrameText(lastFrame) {
    return lastFrame && lastFrame.max > 0 ? T('nodes.cap.lastFrame') : '';
  }

  function videosText(videos) {
    return videos && videos.max > 0 ? T('nodes.cap.videosUpTo', { max: videos.max }) : '';
  }

  function durationText(durations) {
    if (!durations) return '';
    if (Array.isArray(durations.values) && durations.values.length) return T('nodes.cap.durationValues', { values: durations.values.join(', ') });
    return Number.isFinite(durations.min) && Number.isFinite(durations.max) ? T('nodes.cap.duration', { min: durations.min, max: durations.max }) : '';
  }

  // 3D models: "up to 3 more views" or "no more views" (the front image is always there). '' while it is not known.
  function viewsText(caps) {
    if (!caps || !Number.isFinite(caps.views)) return '';
    return caps.views > 0 ? T('nodes.cap.views.upTo', { max: caps.views }) : T('nodes.cap.views.none');
  }

  // What a 3D model is good at (nodes.model3d.strength.<key>); '' for a key that has no text.
  function strengthText(caps) {
    if (!caps || !caps.strength) return '';
    return tr(`nodes.model3d.strength.${caps.strength}`, '');
  }

  // What a model takes, in one line: "end frame, up to 4 images, audio, 4-30 s". '' while nothing is known.
  function capabilitiesText(caps) {
    if (!caps) return '';
    return [lastFrameText(caps.last_frame), referencesText(caps.references), videosText(caps.videos), audioText(caps.audio), durationText(caps.durations), viewsText(caps)]
      .filter(Boolean)
      .join(', ');
  }

  // Why a model does not fit the connections of the node ('' = it fits or nothing is known); usage = { references, audio }
  // (graph.capabilityUsage).
  // `short` gives the form for an entry of the model list ("⚠ only 1"): a long text would be cut off in the closed field.
  function misfitText(caps, usage, { short = false } = {}) {
    if (!caps || !usage) return '';
    const refs = usage.references || 0;
    const audio = usage.audio || 0;
    const videos = usage.videos || 0;
    const lastFrame = usage.last_frame || 0;
    const key = (name) => (short ? `nodes.cap.misfitShort.${name}` : `nodes.cap.misfit.${name}`);
    if (caps.last_frame && lastFrame > caps.last_frame.max) return T(key('noLastFrame'), { count: lastFrame });
    if (caps.references && refs > caps.references.max) {
      return caps.references.max === 0 ? T(key('noRefs'), { count: refs }) : T(key('refs'), { max: caps.references.max, count: refs });
    }
    if (caps.videos && videos > caps.videos.max) {
      return caps.videos.max === 0 ? T(key('noVideos'), { count: videos }) : T(key('videos'), { max: caps.videos.max, count: videos });
    }
    if (caps.audio && audio > caps.audio.max) {
      return caps.audio.max === 0 ? T(key('noAudio'), { count: audio }) : T(key('audio'), { max: caps.audio.max, count: audio });
    }
    // 3D models: connections at left, back or right where the model takes no view
    const views = VIEW_CAPS.reduce((sum, view) => sum + ((caps[view] && usage[view] > caps[view].max) ? usage[view] : 0), 0);
    if (views > 0) return T(key('noViews'), { count: views });
    return '';
  }

  // "about $0.13 per image" for an entry that carries a price; '' while the price is not known (never "$0").
  function money(value, decimals) {
    return `$${value.toFixed(decimals === undefined ? (value < 0.1 ? 3 : 2) : decimals)}`;
  }

  // A video model: "about $0.05-$0.12 per second" (the range of the price estimate of the chat); '' while it is not known.
  function priceText(option) {
    const second = option && option.perSecondUsd;
    if (second && Number.isFinite(second.max) && second.max > 0) {
      const low = Number.isFinite(second.min) && second.min > 0 ? second.min : second.max;
      // a second costs cents: three decimals up to one dollar
      const decimals = second.max < 1 ? 3 : 2;
      return T('nodes.cap.priceVideo', { price: money(low, decimals) === money(second.max, decimals) ? money(second.max, decimals) : `${money(low, decimals)}–${money(second.max, decimals)}` });
    }
    // a 3D model: the price with the default options and no extra view ("from"; texture, PBR and more cost extra)
    if (option && Number.isFinite(option.fromUsd) && option.fromUsd > 0) {
      // whole cents as they are ($0.30, $1.20), a third decimal only where the price has one ($0.375)
      const cents = option.fromUsd * 100;
      return T('nodes.cap.price3d', { price: money(option.fromUsd, Math.abs(cents - Math.round(cents)) > 1e-6 ? 3 : 2) });
    }
    if (!option || !Number.isFinite(option.estimateUsd) || !(option.estimateUsd > 0)) return '';
    return T('nodes.cap.priceImage', { price: money(option.estimateUsd) });
  }

  // Label of an entry of the model list: the name, what it takes, what it costs and, when it does not fit the
  // connections, why.
  function modelOptionLabel(option, usage) {
    // a 3D model leads with the price and the views, what it is good at comes last: the closed field of a card cuts the end off
    const parts = option && option.strength ? [priceText(option), capabilitiesText(option), strengthText(option)] : [capabilitiesText(option), priceText(option)];
    const details = parts.filter(Boolean).join(' · ');
    // short in the entry (the full reason is in the inspector under "does not fit the connections")
    const misfit = misfitText(option, usage, { short: true });
    return { text: `${option.label}${details ? ` · ${details}` : ''}${misfit ? ` ${misfit}` : ''}`, misfit: Boolean(misfit) };
  }

  /* ---------- media previews ---------- */

  function mediaUrl(value) {
    return value && typeof value.url === 'string' ? api.rel(value.url) : '';
  }

  function isMediaValue(value) {
    return Boolean(value) && ['image', 'video', 'audio'].includes(value.type) && typeof value.url === 'string';
  }

  function mediaElement(value, options = {}) {
    const url = mediaUrl(value);
    if (value.type === 'image') {
      const img = el('img', { class: 'nv-media nv-media-image', src: url, alt: '', loading: 'lazy', draggable: 'false' });
      if (options.zoom !== false) {
        img.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          if (typeof global.openLightbox === 'function') global.openLightbox(url);
        });
      }
      return img;
    }
    if (value.type === 'video') {
      return el('video', { class: 'nv-media nv-media-video', src: url, controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata' });
    }
    return el('audio', { class: 'nv-media nv-media-audio', src: url, controls: true, preload: 'metadata' });
  }

  // Renders output values into a container: image/video/audio players, text, numbers, list grids.
  function renderValue(container, value) {
    container.textContent = '';
    if (value === undefined || value === null) return;
    if (isMediaValue(value)) {
      container.append(mediaElement(value));
    } else if (value.type === 'text') {
      container.append(el('div', { class: 'nv-pv-text nv-scroll', text: value.value }));
    } else if (value.type === 'number') {
      container.append(el('div', { class: 'nv-pv-number', text: String(value.value) }));
    } else if (value.type === 'list') {
      const grid = el('div', { class: 'nv-pv-grid' });
      const items = value.items || [];
      for (const item of items.slice(0, 12)) {
        const cell = el('div', { class: 'nv-pv-cell' });
        if (item && item.type === 'image') cell.append(el('img', { src: mediaUrl(item), alt: '', loading: 'lazy', draggable: 'false' }));
        else if (item && item.type === 'text') cell.append(el('span', { text: String(item.value).slice(0, 80) }));
        else if (item && item.type === 'number') cell.append(el('span', { text: String(item.value) }));
        else cell.append(icon(item?.type === 'video' ? 'video' : item?.type === 'audio' ? 'audio' : 'file', 16));
        grid.append(cell);
      }
      if (items.length > 12) grid.append(el('div', { class: 'nv-pv-cell nv-pv-more', text: `+${items.length - 12}` }));
      container.append(grid);
    }
  }

  /* ---------- param widgets ---------- */

  function numberOrNull(raw, param) {
    const text = String(raw).trim();
    if (text === '') return param.optional ? null : undefined;
    const number = Number(text);
    if (!Number.isFinite(number)) return undefined;
    return param.kind === 'integer' ? Math.round(number) : number;
  }

  function clampNumber(value, param) {
    if (value === null || value === undefined) return value;
    let next = value;
    if (Number.isFinite(param.min) && next < param.min) next = param.min;
    if (Number.isFinite(param.max) && next > param.max) next = param.max;
    return next;
  }

  function autosize(textarea, maxHeight) {
    textarea.style.height = 'auto';
    const next = Math.min(textarea.scrollHeight + 2, maxHeight);
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight + 2 > maxHeight ? 'auto' : 'hidden';
  }

  function acceptFor(param, node) {
    const accept = param.accept === 'kind' ? node?.params?.kind || 'image' : param.accept || 'image';
    return ['image', 'video', 'audio'].includes(accept) ? accept : 'image';
  }

  function fileInputAccept(kind) {
    return kind === 'image' ? 'image/*,.svg' : `${kind}/*`;
  }

  // Asset picker (upload only in WP5): a drop zone plus preview. `multi` = list of values.
  function assetWidget(param, value, ctx, multi) {
    const kind = acceptFor(param, ctx.node);
    const wrap = el('div', { class: 'nv-asset nv-nodrag' });
    const preview = el('div', { class: 'nv-asset-preview' });
    const status = el('div', { class: 'nv-asset-status', role: 'status' });
    const fileInput = el('input', { type: 'file', class: 'nv-file-input', accept: fileInputAccept(kind), multiple: multi || null, tabindex: '-1' });
    const zone = el('button', { type: 'button', class: 'nv-asset-drop' });
    zone.append(icon('upload', 16), el('span', { text: multi ? T('nodes.asset.addFiles') : T('nodes.asset.upload') }), el('small', { text: T(`nodes.asset.hint.${kind}`) }));
    // Browse: chats and the workflow's own assets (asset-picker.js, WP7).
    const browse = el('button', { type: 'button', class: 'nv-asset-browse', title: T('nodes.picker.browse'), 'aria-label': T('nodes.picker.browse') }, icon('folder', 15));
    const actions = el('div', { class: 'nv-asset-actions' }, zone, browse);
    let current = multi ? (Array.isArray(value) ? value : []) : value || null;
    let busy = 0;

    function setStatus(text, kind2) {
      status.textContent = text || '';
      status.className = `nv-asset-status ${kind2 ? `is-${kind2}` : ''}`.trim();
    }

    function emit(next) {
      current = next;
      ctx.onChange(next, { commit: true });
      draw();
    }

    function drawItem(item, index) {
      const cell = el('div', { class: 'nv-asset-item' });
      if (item?.missing || !isMediaValue(item)) {
        cell.append(el('div', { class: 'nv-asset-missing' }, icon('warning', 14), el('span', { text: T('nodes.asset.missing') })));
      } else {
        cell.append(mediaElement(item));
      }
      const remove = el('button', { type: 'button', class: 'nv-asset-remove', title: T('nodes.asset.remove'), 'aria-label': T('nodes.asset.remove') }, icon('x', 12));
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        emit(multi ? current.filter((_, i) => i !== index) : null);
      });
      cell.append(remove);
      if (item?.file && !multi) cell.append(el('div', { class: 'nv-asset-name', text: item.file }));
      return cell;
    }

    function draw() {
      preview.textContent = '';
      if (multi) {
        current.forEach((item, index) => preview.append(drawItem(item, index)));
        preview.classList.toggle('is-grid', current.length > 0);
      } else if (current) {
        preview.append(drawItem(current, 0));
      }
      zone.classList.toggle('is-compact', Boolean(multi ? current.length : current));
      zone.querySelector('span').textContent = multi ? T('nodes.asset.addFiles') : current ? T('nodes.asset.replace') : T('nodes.asset.upload');
    }

    async function handleFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return;
      const chosen = multi ? list : [list[0]];
      busy += 1;
      wrap.classList.add('is-busy');
      let done = 0;
      try {
        for (const file of chosen) {
          setStatus(T('nodes.asset.uploading', { name: file.name, done: done + 1, total: chosen.length }));
          const uploaded = await ctx.uploadFile(file, { accept: kind, onProgress: (ratio) => setStatus(`${T('nodes.asset.uploading', { name: file.name, done: done + 1, total: chosen.length })} ${Math.round(ratio * 100)}%`) });
          done += 1;
          if (multi) {
            if (current.length >= (param.max || 50)) throw new Error(T('nodes.asset.tooMany', { max: param.max || 50 }));
            emit([...current, uploaded]);
          } else {
            emit(uploaded);
          }
        }
        setStatus('');
      } catch (error) {
        setStatus(error.message, 'error');
      } finally {
        busy -= 1;
        if (!busy) wrap.classList.remove('is-busy');
      }
    }

    zone.addEventListener('click', () => fileInput.click());
    browse.addEventListener('click', async () => {
      const editorWorkflow = OCD.editor && OCD.editor.getWorkflow && OCD.editor.getWorkflow();
      const workflowId = ctx.workflowId || (editorWorkflow && editorWorkflow.id);
      if (!OCD.assetPicker || !workflowId) return;
      const limit = param.max || 50;
      if (multi && current.length >= limit) {
        setStatus(T('nodes.asset.tooMany', { max: limit }), 'error');
        return;
      }
      const values = await OCD.assetPicker.open({ kind, multi, max: multi ? limit - current.length : 1, workflowId, uploadFile: ctx.uploadFile });
      if (!values || !values.length) return;
      setStatus('');
      emit(multi ? [...current, ...values].slice(0, limit) : values[0]);
    });
    fileInput.addEventListener('change', () => {
      handleFiles(fileInput.files);
      fileInput.value = '';
    });
    for (const type of ['dragenter', 'dragover']) {
      wrap.addEventListener(type, (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        wrap.classList.add('is-drop');
      });
    }
    wrap.addEventListener('dragleave', () => wrap.classList.remove('is-drop'));
    wrap.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      event.stopPropagation();
      wrap.classList.remove('is-drop');
      handleFiles(event.dataTransfer.files);
    });

    wrap.append(preview, actions, status, fileInput);
    draw();
    return {
      el: wrap,
      set(next) {
        const incoming = multi ? (Array.isArray(next) ? next : []) : next || null;
        if (JSON.stringify(incoming) === JSON.stringify(current)) return;
        current = incoming;
        draw();
      },
      get: () => current
    };
  }

  // Widget options of a prompt textarea: the Prompt node gets a large field, embedded prompt fields that
  // also have a text input hint at the second way (connect a Prompt node). Empty object for other params.
  function promptFieldOptions(node, param, inputs) {
    // The HTML field of the Motion graphics node holds code, not an instruction: say so in the empty field.
    if (param && param.kind === 'code' && param.id === 'html' && node && node.type === 'video.motion_graphics') return { placeholder: T('nodes.motion.htmlPlaceholder') };
    if (!param || param.kind !== 'textarea') return {};
    // The song text of the music node is written in a format of its own: the empty field shows it.
    if (node && node.type === 'audio.music' && param.id === 'plan') return { placeholder: T('nodes.music.planPlaceholder'), rows: 9 };
    if (node && node.type === 'input.prompt') return { large: true, rows: 5, maxHeight: 360, placeholder: T('nodes.prompt.placeholder') };
    if (param.id === 'prompt' && (inputs || []).some((port) => port.param === param.id && port.type === 'text')) {
      return { placeholder: T('nodes.prompt.embeddedPlaceholder') };
    }
    return {};
  }

  // Builds the widget of one param. ctx = { node, onChange(value, { commit }), uploadFile, compact }.
  // Optional ctx.placeholder / rows / maxHeight / large (see promptFieldOptions) shape textarea fields.
  // Returns { el, set(value), get() }; set() is used when the node is updated from outside.
  function paramWidget(param, value, ctx) {
    const kind = param.kind;
    const compact = Boolean(ctx.compact);

    if (kind === 'asset' || kind === 'assets') return assetWidget(param, value, ctx, kind === 'assets');

    if (kind === 'textarea' || kind === 'code') {
      const area = el('textarea', {
        class: `nv-input nv-textarea nv-nodrag ${kind === 'code' ? 'is-code' : ''} ${ctx.large ? 'is-prompt' : ''}`.trim(),
        rows: ctx.rows || (compact ? 3 : kind === 'code' ? 8 : 4),
        spellcheck: kind === 'code' ? 'false' : null,
        'aria-label': paramLabel(param.id),
        placeholder: ctx.placeholder || paramLabel(param.id)
      });
      area.value = value ?? '';
      const max = ctx.maxHeight || (compact ? 220 : 320);
      area.addEventListener('input', () => {
        if (compact) autosize(area, max);
        ctx.onChange(area.value, { commit: false });
      });
      area.addEventListener('change', () => ctx.onChange(area.value, { commit: true }));
      area.addEventListener('wheel', (event) => {
        if (area.scrollHeight > area.clientHeight && !event.ctrlKey && !event.metaKey) event.stopPropagation();
      });
      if (compact) requestAnimationFrame(() => autosize(area, max));
      return {
        el: area,
        set(next) {
          if (document.activeElement === area || area.value === (next ?? '')) return;
          area.value = next ?? '';
          if (compact) autosize(area, max);
        },
        get: () => area.value
      };
    }

    if (kind === 'text') {
      const input = el('input', { class: 'nv-input nv-nodrag', type: 'text', 'aria-label': paramLabel(param.id), placeholder: param.placeholder || '' });
      input.value = value ?? '';
      input.addEventListener('input', () => ctx.onChange(input.value, { commit: false }));
      input.addEventListener('change', () => ctx.onChange(input.value, { commit: true }));
      return {
        el: input,
        set(next) {
          if (document.activeElement !== input) input.value = next ?? '';
        },
        get: () => input.value
      };
    }

    if (kind === 'number' || kind === 'integer') {
      const input = el('input', {
        class: 'nv-input nv-nodrag',
        type: 'number',
        min: Number.isFinite(param.min) ? param.min : null,
        max: Number.isFinite(param.max) ? param.max : null,
        step: param.step || (kind === 'integer' ? 1 : 'any'),
        'aria-label': paramLabel(param.id)
      });
      input.value = value === null || value === undefined ? '' : String(value);
      input.addEventListener('input', () => {
        const parsed = numberOrNull(input.value, param);
        if (parsed !== undefined) ctx.onChange(parsed, { commit: false });
      });
      input.addEventListener('change', () => {
        const parsed = numberOrNull(input.value, param);
        if (parsed === undefined) {
          input.value = value === null || value === undefined ? '' : String(value);
          return;
        }
        const clamped = clampNumber(parsed, param);
        if (clamped !== parsed) input.value = String(clamped);
        ctx.onChange(clamped, { commit: true });
      });
      return {
        el: input,
        set(next) {
          value = next;
          if (document.activeElement !== input) input.value = next === null || next === undefined ? '' : String(next);
        },
        get: () => numberOrNull(input.value, param)
      };
    }

    if (kind === 'slider') {
      const wrap = el('div', { class: 'nv-slider nv-nodrag' });
      const range = el('input', {
        type: 'range',
        class: 'nv-range',
        min: param.min ?? 0,
        max: param.max ?? 1,
        step: param.step || 0.01,
        'aria-label': paramLabel(param.id)
      });
      const output = el('output', { class: 'nv-slider-value' });
      const show = (number) => {
        range.value = String(number ?? param.min ?? 0);
        output.textContent = String(Math.round(Number(range.value) * 1000) / 1000);
      };
      show(value);
      range.addEventListener('input', () => {
        show(range.value);
        ctx.onChange(Number(range.value), { commit: false });
      });
      range.addEventListener('change', () => ctx.onChange(Number(range.value), { commit: true }));
      wrap.append(range, output);
      return { el: wrap, set: (next) => show(next), get: () => Number(range.value) };
    }

    if (kind === 'boolean') {
      const button = el('button', { type: 'button', class: 'nv-switch nv-nodrag', role: 'switch', 'aria-label': paramLabel(param.id) });
      const paint = (on) => {
        button.setAttribute('aria-checked', on ? 'true' : 'false');
        button.classList.toggle('is-on', Boolean(on));
      };
      let state = Boolean(value);
      paint(state);
      button.append(el('span', { class: 'nv-switch-knob' }));
      button.addEventListener('click', () => {
        state = !state;
        paint(state);
        ctx.onChange(state, { commit: true });
      });
      return {
        el: button,
        set(next) {
          state = Boolean(next);
          paint(state);
        },
        get: () => state
      };
    }

    if (kind === 'select') {
      const select = el('select', { class: 'nv-input nv-select nv-nodrag', 'aria-label': paramLabel(param.id) });
      let current = value === null || value === undefined ? '' : String(value);
      const fill = () => {
        const source = optionsFor(param);
        select.textContent = '';
        const options = selectEntries(param, source, current);
        // Model lists tell what each model takes; models that do not fit the connections of the node are marked.
        const usage = param.optionsSource && typeof ctx.usage === 'function' ? ctx.usage() : null;
        for (const option of options) {
          if (option.references || option.audio || option.videos || option.last_frame || option.durations || option.perSecondUsd || option.estimateUsd || option.fromUsd || option.strength) {
            const label = modelOptionLabel(option, usage);
            select.append(el('option', { value: option.value, text: label.text, dataset: label.misfit ? { misfit: '1' } : null }));
          } else {
            select.append(el('option', { value: option.value, text: option.label }));
          }
        }
        select.value = current;
      };
      fill();
      const unsubscribe = param.optionsSource
        ? onOptionsChange((source) => {
            if (!select.isConnected && !ctx.detached) return;
            if (source === param.optionsSource) fill();
          })
        : null;
      select.addEventListener('change', () => {
        current = select.value;
        ctx.onChange(current, { commit: true });
      });
      return {
        el: select,
        set(next) {
          current = next === null || next === undefined ? '' : String(next);
          fill();
        },
        get: () => select.value,
        dispose: () => unsubscribe && unsubscribe()
      };
    }

    if (kind === 'color') {
      const wrap = el('div', { class: 'nv-color nv-nodrag' });
      const picker = el('input', { type: 'color', class: 'nv-color-picker', 'aria-label': paramLabel(param.id) });
      const hex = el('input', { type: 'text', class: 'nv-input nv-color-hex', maxlength: 9, 'aria-label': paramLabel(param.id) });
      const show = (color) => {
        const text = String(color || '#000000');
        hex.value = text;
        picker.value = /^#[0-9a-f]{6}/i.test(text) ? text.slice(0, 7) : '#000000';
      };
      show(value);
      picker.addEventListener('input', () => {
        hex.value = picker.value;
        ctx.onChange(picker.value, { commit: false });
      });
      picker.addEventListener('change', () => ctx.onChange(picker.value, { commit: true }));
      hex.addEventListener('change', () => {
        ctx.onChange(hex.value.trim(), { commit: true });
        show(hex.value.trim());
      });
      wrap.append(picker, hex);
      return { el: wrap, set: show, get: () => hex.value };
    }

    if (kind === 'tags') {
      const input = el('input', { class: 'nv-input nv-nodrag', type: 'text', 'aria-label': paramLabel(param.id) });
      const show = (tags) => {
        if (document.activeElement !== input) input.value = Array.isArray(tags) ? tags.join(', ') : '';
      };
      show(value);
      const parse = () => input.value.split(',').map((tag) => tag.trim()).filter(Boolean);
      input.addEventListener('input', () => ctx.onChange(parse(), { commit: false }));
      input.addEventListener('change', () => ctx.onChange(parse(), { commit: true }));
      return { el: input, set: show, get: parse };
    }

    return { el: el('span', { class: 'nv-hint', text: String(value ?? '') }), set() {}, get: () => value };
  }

  // Labelled field wrapper used by the inspector (and reusable elsewhere).
  // options.expose = { active, title, onToggle() }: small "Design App" toggle next to the label (inspector).
  function field(labelText, widgetEl, options = {}) {
    const wrap = el('div', { class: `nv-field ${options.inline ? 'is-inline' : ''}`.trim() });
    if (labelText) {
      const label = el('label', { class: 'nv-field-label', text: labelText });
      if (options.action) {
        // small text button next to the label, e.g. "Move into a Prompt node"
        const action = el('button', { type: 'button', class: 'nv-field-action', title: options.action.title, 'aria-label': options.action.title, dataset: options.action.dataset || {} }, icon(options.action.icon || 'extract', 12), el('span', { text: options.action.label }));
        if (options.action.hidden) action.hidden = true;
        action.addEventListener('click', options.action.onClick);
        const tools = el('div', { class: 'nv-field-tools' }, action);
        if (options.expose) {
          const toggle = el('button', {
            type: 'button',
            class: `nv-expose ${options.expose.active ? 'is-on' : ''}`.trim(),
            title: options.expose.title,
            'aria-label': options.expose.title,
            'aria-pressed': options.expose.active ? 'true' : 'false'
          });
          toggle.append(icon('app', 12), el('span', { text: T('nodes.app.badge') }));
          toggle.addEventListener('click', options.expose.onToggle);
          tools.append(toggle);
        }
        wrap.append(el('div', { class: 'nv-field-head' }, label, tools));
      } else if (options.expose) {
        const toggle = el('button', {
          type: 'button',
          class: `nv-expose ${options.expose.active ? 'is-on' : ''}`.trim(),
          title: options.expose.title,
          'aria-label': options.expose.title,
          'aria-pressed': options.expose.active ? 'true' : 'false'
        });
        toggle.append(icon('app', 12), el('span', { text: T('nodes.app.badge') }));
        toggle.addEventListener('click', options.expose.onToggle);
        wrap.append(el('div', { class: 'nv-field-head' }, label, toggle));
      } else {
        wrap.append(label);
      }
    }
    wrap.append(widgetEl);
    if (options.hint) wrap.append(el('div', { class: 'nv-field-hint', text: options.hint }));
    return wrap;
  }

  /* ---------- node cards ---------- */

  const cardStates = new WeakMap();

  // Callbacks of the run UX: run(nodeId), page(nodeId, delta), open(nodeId, index), copy(text).
  const cardActions = {};

  function setCardActions(actions) {
    Object.assign(cardActions, actions || {});
  }

  // Port dot. The explanation is not a native title: the port tooltip (port-tip.js) covers the whole row.
  // Multi-inputs get a double ring (`is-multi`): they take several connections.
  function portDot(direction, port) {
    const parsed = graphLib.parseType(port.type);
    const classes = ['nv-port', `nv-port-${parsed?.base || 'any'}`];
    if (parsed?.list) classes.push('is-list');
    if (direction === 'in' && port.multiple) classes.push('is-multi');
    return el('span', { class: classes.join(' '), dataset: { dir: direction, port: port.id, type: port.type } });
  }

  // "n/max" next to the label of a multi-input from the first connection on ("n/∞" without a maximum). While the limit
  // of the chosen model is not known, only the number is shown.
  function portCountText(port, count) {
    if (!port.multiple || !count) return '';
    if (port.limit && !port.limit.known) return String(count);
    return `${count}/${Number.isFinite(port.max) ? port.max : '\u221e'}`;
  }

  // More connections than the input takes (the chosen model, or a fixed maximum such as 0 of an input a setting switched
  // off): the badge is an error then. An unknown limit of a model leaves the fixed ceiling as the only limit.
  function portOverLimit(port, count) {
    return Boolean(port.multiple && Number.isFinite(port.max) && count > port.max);
  }

  // Signature of everything that changes the card structure (ports, visible params).
  function cardSignature(node, def, connected, reg) {
    if (!def) return `unknown:${node.type}`;
    const ports = graphLib.portsFor(reg, node);
    const connectedPorts = new Set(connected.keys());
    const visible = def.params
      .filter((param) => param.inline && graphLib.isVisible(param.showIf, node, def, connectedPorts))
      .map((param) => {
        const linked = ports.inputs.find((port) => port.param === param.id && connected.has(port.id));
        const ctxKind = param.accept === 'kind' ? `:${node.params?.kind || 'image'}` : '';
        return `${param.id}${linked ? '~' : ''}${ctxKind}`;
      });
    return JSON.stringify([
      ports.inputs.filter((p) => !p.hidden).map((p) => `${p.id}:${p.type}:${p.multiple ? `m${p.max ?? ''}` : ''}:${p.required ? 'r' : ''}${p.limit ? (p.limit.known ? 'k' : 'u') : ''}`),
      ports.outputs.filter((p) => !p.hidden).map((p) => `${p.id}:${p.type}`),
      visible,
      def.available === true ? 1 : String(def.available),
      node.type === 'input.text_list' ? Number(node.params?.max) || 50 : 0
    ]);
  }

  function statusLabel(status) {
    return tr(`nodes.status.${status}`, humanize(status));
  }

  function createCard(node, ctx) {
    const def = ctx.reg.types.get(node.type);
    const card = el('div', { class: 'nv-node', dataset: { id: node.id, cat: def?.category || 'unknown' }, tabindex: '-1' });
    const head = el('div', { class: 'nv-node-head' });
    const iconWrap = el('span', { class: 'nv-node-icon' });
    const title = el('span', { class: 'nv-node-title' });
    const badges = el('span', { class: 'nv-node-badges' });
    const runBtn = el('button', { type: 'button', class: 'nv-node-run', title: T('nodes.card.run'), 'aria-label': T('nodes.card.run') }, icon('play', 11));
    // "?": the help of the node type in a popover (main.js -> node-help.js); the title keeps its double click to rename.
    const helpBtn = el('button', { type: 'button', class: 'nv-node-help', title: `${T('nodes.help.open')} (?)`, 'aria-label': T('nodes.help.open'), 'aria-haspopup': 'dialog', 'aria-keyshortcuts': '?' }, icon('help', 13));
    head.append(iconWrap, title, badges, helpBtn, runBtn);
    const status = el('div', { class: 'nv-node-status', dataset: { slot: 'status' } });
    const message = el('div', { class: 'nv-node-msg nv-scroll' });
    // One-click remedy for an issue shown in `message` (slot.fix), e.g. "Convert to HTML with AI".
    const fix = el('div', { class: 'nv-node-fix is-empty' });
    const ports = el('div', { class: 'nv-node-ports' });
    const params = el('div', { class: 'nv-node-params' });
    // A line to read under the settings (the length of a song and where it comes from), filled through the slot.
    const note = el('div', { class: 'nv-node-note is-empty', dataset: { slot: 'note' } });
    const preview = el('div', { class: 'nv-node-preview', dataset: { slot: 'preview' } });
    const pager = el('div', { class: 'nv-node-pager' });
    const cost = el('span', { class: 'nv-node-cost', dataset: { slot: 'cost' } });
    const foot = el('div', { class: 'nv-node-foot' }, pager, cost);
    card.append(head, status, message, fix, ports, params, note, preview, foot);
    const state = {
      el: card,
      refs: { head, iconWrap, title, badges, helpBtn, runBtn, status, message, fix, ports, params, note, preview, pager, cost, foot },
      widgets: new Map(),
      sig: null,
      node: null,
      portEls: { in: new Map(), out: new Map() },
      portRows: new Map(),
      connSig: '',
      slotKey: '',
      previewKey: null,
      noteKey: ''
    };
    cardStates.set(card, state);
    title.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      inlineEdit(title, node.title || '', (value) => ctx.onRename(state.node.id, value), { label: T('nodes.card.rename'), className: 'nv-title-input' });
    });
    runBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (cardActions.run && state.node) cardActions.run(state.node.id);
    });
    helpBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (cardActions.help && state.node) cardActions.help(state.node.id, helpBtn);
    });
    return state;
  }

  function disposeWidgets(state) {
    for (const widget of state.widgets.values()) widget.dispose && widget.dispose();
    state.widgets.clear();
  }

  // Connection state of the input rows (label colour, "n/max" badge, red when the chosen model takes fewer; the reason is in
  // the port tooltip). Runs on every card update, so a new connection shows up without rebuilding the card (the widgets
  // keep their focus).
  function patchPorts(state, connected, ctx) {
    if (!state.portRows) return;
    // The ports as they are now: the limit of the chosen model can change without the structure of the card changing.
    const fresh = ctx && state.node ? new Map(graphLib.portsFor(ctx.reg, state.node).inputs.map((port) => [port.id, port])) : null;
    for (const [portId, entry] of state.portRows) {
      const count = connected.get(portId) || 0;
      const port = (fresh && fresh.get(portId)) || entry.port;
      entry.row.classList.toggle('is-connected', count > 0);
      if (entry.badge) {
        const text = portCountText(port, count);
        const over = portOverLimit(port, count);
        if (entry.badge.textContent !== text) entry.badge.textContent = text;
        entry.badge.classList.toggle('hidden', !text);
        entry.badge.classList.toggle('is-over', over);
        entry.row.classList.toggle('is-over', over);
      }
    }
  }

  function buildPorts(state, node, def, connected, ctx) {
    const { ports } = state.refs;
    ports.textContent = '';
    state.portEls = { in: new Map(), out: new Map() };
    const list = graphLib.portsFor(ctx.reg, node);
    const inputs = list.inputs.filter((port) => !port.hidden);
    const outputs = list.outputs.filter((port) => !port.hidden);
    const left = el('div', { class: 'nv-ports-in' });
    const right = el('div', { class: 'nv-ports-out' });
    state.portRows = new Map();
    for (const port of inputs) {
      const dot = portDot('in', port);
      const row = el('div', { class: 'nv-port-row is-in' }, dot, el('span', { class: 'nv-port-label', text: portLabel(port.id) }));
      if (port.required) row.append(el('span', { class: 'nv-port-req', 'aria-label': T('nodes.port.required'), text: '*' }));
      const badge = port.multiple ? el('span', { class: 'nv-port-count' }) : null;
      if (badge) row.append(badge);
      state.portRows.set(port.id, { row, badge, port });
      left.append(row);
      state.portEls.in.set(port.id, dot);
    }
    for (const port of outputs) {
      const dot = portDot('out', port);
      const row = el('div', { class: 'nv-port-row is-out' }, el('span', { class: 'nv-port-label', text: portLabel(port.id) }), dot);
      right.append(row);
      state.portEls.out.set(port.id, dot);
    }
    patchPorts(state, connected, ctx);
    ports.append(left, right);
    ports.classList.toggle('is-empty', !inputs.length && !outputs.length);
  }

  // Mirrors parseTextList of lib/nodes/nodes-basic.js (lines, or blocks separated by a line `---`).
  function countTextItems(text) {
    const lines = String(text || '').split(/\r?\n/);
    let items = lines;
    if (lines.some((line) => line.trim() === '---')) {
      items = [];
      let block = [];
      for (const line of lines) {
        if (line.trim() === '---') {
          items.push(block.join('\n'));
          block = [];
        } else block.push(line);
      }
      items.push(block.join('\n'));
    }
    return items.map((item) => item.trim()).filter(Boolean).length;
  }

  function buildParams(state, node, def, connected, ctx) {
    const { params: wrap } = state.refs;
    disposeWidgets(state);
    wrap.textContent = '';
    if (!def) return;
    const connectedPorts = new Set(connected.keys());
    const effective = graphLib.effectiveParams(def, node);
    const list = graphLib.portsFor(ctx.reg, node);
    for (const param of def.params) {
      if (!param.inline || !graphLib.isVisible(param.showIf, node, def, connectedPorts)) continue;
      const linkedPort = list.inputs.find((port) => port.param === param.id && connected.has(port.id));
      const row = el('div', { class: `nv-param nv-param-${param.kind}` });
      if (linkedPort) {
        row.append(el('div', { class: 'nv-param-linked' }, icon('link', 13), el('span', { text: T('nodes.card.fromInput', { name: portLabel(linkedPort.id) }) })));
      } else {
        const showLabel = !['textarea', 'code', 'asset', 'assets'].includes(param.kind) || param.id !== 'prompt';
        if (['select', 'number', 'integer', 'slider', 'boolean', 'color', 'text'].includes(param.kind) && showLabel) {
          row.classList.add('has-label');
          row.append(el('span', { class: 'nv-param-label', text: paramLabel(param.id) }));
        }
        const isList = node.type === 'input.text_list' && param.id === 'text';
        const counter = isList ? el('div', { class: 'nv-batch-count' }) : null;
        const paintCount = (text) => {
          if (!counter) return;
          const count = countTextItems(text);
          const limit = Math.max(1, Number(graphLib.effectiveParams(def, state.node).max) || 50);
          counter.classList.toggle('is-warn', count > limit);
          counter.textContent = count > limit ? T('nodes.app.batchTruncated', { count, max: limit }) : T('nodes.app.batchCount', { count });
        };
        const widget = paramWidget(param, effective[param.id], {
          node,
          compact: true,
          ...promptFieldOptions(node, param, list.inputs),
          onChange: (value, meta) => {
            paintCount(value);
            ctx.onParam(state.node.id, param.id, value, meta);
          },
          uploadFile: (file, options) => ctx.uploadFile(state.node.id, file, options)
        });
        state.widgets.set(param.id, widget);
        row.append(widget.el);
        // The song length is asked for here and reaches 10 minutes: the range stands under the field.
        if (node.type === 'audio.music_plan' && param.id === 'length') row.append(el('div', { class: 'nv-param-hint', text: T('nodes.music.lengthRange') }));
        // "Move into a Prompt node": only for an unconnected text input backed by this textarea.
        const extractPort = param.kind === 'textarea' && ctx.onExtract && ctx.reg.types.has('input.prompt')
          ? list.inputs.find((port) => port.param === param.id && port.type === 'text' && !port.hidden && !connected.has(port.id))
          : null;
        if (extractPort) {
          row.classList.add('has-extract');
          const button = el('button', { type: 'button', class: 'nv-extract-btn nv-nodrag', title: T('nodes.prompt.extract'), 'aria-label': T('nodes.prompt.extract') }, icon('extract', 13));
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            ctx.onExtract(state.node.id, extractPort.id);
          });
          row.append(button);
        }
        if (counter) {
          paintCount(effective[param.id]);
          row.append(counter);
        }
      }
      wrap.append(row);
    }
    wrap.classList.toggle('is-empty', !wrap.children.length);
  }

  function buildBadges(state, def) {
    const { badges } = state.refs;
    badges.textContent = '';
    if (!def) return;
    if (def.experimental) badges.append(el('span', { class: 'nv-badge is-experimental', title: T('nodes.badge.experimentalHint'), text: T('nodes.badge.experimental') }));
    if (def.paid) badges.append(el('span', { class: 'nv-badge is-paid', title: T('nodes.badge.paidHint'), text: '$' }));
    // A service that is called but charges nothing (the song text of ElevenLabs): not "local", and not paid.
    else if (def.cost && def.cost.unit === 'free' && def.provider) {
      const named = global.OCDNodes.templatesUi && global.OCDNodes.templatesUi.requirementLabel;
      badges.append(el('span', { class: 'nv-badge is-free', title: T('nodes.help.cost.freecall', { provider: named ? named(def.provider) : def.provider }), text: T('nodes.badge.free') }));
    }
    if (def.available !== true) {
      const warn = el('span', { class: 'nv-badge is-warn', title: typeof def.available === 'string' ? availabilityReason(def.available) : T('nodes.badge.unavailable') });
      warn.append(icon('warning', 12));
      badges.append(warn);
    }
  }

  // Creates or patches the card for `node`. connected: Map(inputPortId -> edge count).
  function updateCard(state, node, connected, ctx) {
    const def = ctx.reg.types.get(node.type);
    const previousNode = state.node;
    state.node = node;
    const { refs } = state;
    state.el.dataset.cat = def?.category || 'unknown';
    state.el.dataset.type = node.type;
    state.el.classList.toggle('is-unknown', !def);
    state.el.classList.toggle('is-unavailable', Boolean(def) && def.available !== true);
    const heading = node.title || (def ? typeLabel(def) : node.type);
    if (refs.title.textContent !== heading) refs.title.textContent = heading;
    refs.title.title = def ? typeLabel(def) : node.type;
    const signature = cardSignature(node, def, connected, ctx.reg);
    if (signature !== state.sig) {
      state.sig = signature;
      refs.runBtn.title = T('nodes.card.run');
      refs.runBtn.setAttribute('aria-label', T('nodes.card.run'));
      refs.helpBtn.title = `${T('nodes.help.open')} (?)`;
      refs.helpBtn.setAttribute('aria-label', T('nodes.help.open'));
      refs.helpBtn.classList.toggle('hidden', !def);
      refs.iconWrap.textContent = '';
      refs.iconWrap.append(categoryIcon(def ? def.category : 'unknown'));
      buildBadges(state, def);
      buildPorts(state, node, def, connected, ctx);
      buildParams(state, node, def, connected, ctx);
      if (!def) {
        refs.params.textContent = '';
        refs.params.append(el('div', { class: 'nv-param-linked' }, icon('warning', 13), el('span', { text: T('nodes.card.unknownType', { type: node.type }) })));
        refs.params.classList.remove('is-empty');
      }
      return true;
    }
    // Same structure: refresh the connection badges and push new param values into the existing widgets.
    patchPorts(state, connected, ctx);
    if (def && (!previousNode || previousNode.params !== node.params)) {
      const effective = graphLib.effectiveParams(def, node);
      for (const [id, widget] of state.widgets) widget.set(effective[id]);
    }
    return false;
  }

  // Applies the persisted slot state of a card (see run.js slotFor): status row, message, preview,
  // variant pager, cost and the run button. Everything is keyed so unchanged parts are not rebuilt.
  function applySlots(state, slots) {
    const { status, message, fix, note, preview, pager, cost, runBtn } = state.refs;
    const info = slots || {};
    state.el.dataset.status = info.status || '';
    state.el.classList.toggle('is-working', Boolean(info.working));

    const statusKey = [info.status || '', info.label || '', info.since || '', info.progress ? `${info.progress.done}/${info.progress.total}` : '', info.message || '', info.fix ? `${info.fix.id}:${info.fix.port || ''}:${info.fix.label}` : ''].join('|');
    if (statusKey !== state.slotKey) {
      state.slotKey = statusKey;
      status.textContent = '';
      if (info.status) {
        status.append(el('span', { class: 'nv-status-dot' }), el('span', { class: 'nv-status-text', text: info.label || statusLabel(info.status) }));
        if (info.since) status.append(el('span', { class: 'nv-status-time', dataset: { since: String(info.since) }, text: '' }));
        if (info.progress && info.progress.total > 1) status.append(el('span', { class: 'nv-status-progress', text: `${info.progress.done}/${info.progress.total}` }));
        status.title = info.tooltip || '';
      }
      status.classList.toggle('is-empty', !info.status);
      message.textContent = info.message || '';
      message.classList.toggle('is-empty', !info.message);
      message.title = info.message || '';
      fix.textContent = '';
      if (info.fix) {
        const button = el('button', { type: 'button', class: 'nv-node-fix-btn nv-nodrag', title: info.fix.title || '' }, icon(info.fix.icon || 'sparkle', 12), el('span', { text: info.fix.label }));
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (cardActions.fix && state.node) cardActions.fix(state.node.id, info.fix.id, info.fix);
        });
        fix.append(button);
      }
      fix.classList.toggle('is-empty', !info.fix);
    }
    if (info.since) {
      const timeEl = status.querySelector('.nv-status-time');
      if (timeEl && !timeEl.textContent) timeEl.textContent = OCD.run ? OCD.run.formatDuration(Date.now() - info.since) : '';
    }

    runBtn.disabled = Boolean(info.busy);
    runBtn.classList.toggle('hidden', info.canRun === false);

    const noteKey = info.note ? `${info.note.nodeId || ''}|${info.note.text}` : '';
    if (noteKey !== state.noteKey) {
      state.noteKey = noteKey;
      note.textContent = '';
      if (info.note) {
        // With a node to lead to, the line is a button: one click selects that node.
        if (info.note.nodeId && cardActions.select) {
          const target = info.note.nodeId;
          const button = el('button', { type: 'button', class: 'nv-note-link nv-nodrag', title: T('nodes.music.length.goTo'), text: info.note.text });
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            cardActions.select(target);
          });
          note.append(button);
        } else {
          note.append(el('span', { text: info.note.text }));
        }
      }
      note.classList.toggle('is-empty', !info.note);
    }

    if (info.preview !== undefined && state.previewKey !== info.previewKey) {
      state.previewKey = info.previewKey;
      preview.textContent = '';
      const items = info.preview || [];
      if (OCD.preview) {
        OCD.preview.renderCardPreview(preview, items, { nodeId: state.node && state.node.id, actions: cardActions, portLabel });
      } else {
        for (const item of items) {
          const body = el('div', { class: 'nv-pv-body' });
          renderValue(body, item.value);
          preview.append(el('div', { class: 'nv-pv-port' }, body));
        }
      }
    } else if (info.preview === undefined && state.previewKey !== null) {
      state.previewKey = null;
      preview.textContent = '';
    }
    preview.classList.toggle('is-empty', !preview.children.length);

    pager.textContent = '';
    if (info.pager && info.pager.total > 1) {
      const prev = el('button', { type: 'button', class: 'nv-pager-btn', title: T('nodes.pager.prev'), 'aria-label': T('nodes.pager.prev'), disabled: info.pager.index <= 0 || info.busy }, icon('chevron-left', 12));
      const next = el('button', { type: 'button', class: 'nv-pager-btn', title: T('nodes.pager.next'), 'aria-label': T('nodes.pager.next'), disabled: info.pager.index >= info.pager.total - 1 || info.busy }, icon('chevron', 12));
      prev.addEventListener('click', (event) => {
        event.stopPropagation();
        if (cardActions.page && state.node) cardActions.page(state.node.id, -1);
      });
      next.addEventListener('click', (event) => {
        event.stopPropagation();
        if (cardActions.page && state.node) cardActions.page(state.node.id, 1);
      });
      pager.append(prev, el('span', { class: 'nv-pager-label', text: `${info.pager.index + 1} / ${info.pager.total}` }), next);
    }
    pager.classList.toggle('is-empty', !pager.children.length);
    cost.textContent = info.cost || '';
    cost.title = info.costTitle || '';
    cost.classList.toggle('is-estimate', info.costKind === 'estimate');
    state.refs.foot.classList.toggle('is-empty', !pager.children.length && !info.cost);
  }

  // Marks a card that takes part in the Design App: 'input', 'output', 'both' or null.
  function setAppMark(state, mark) {
    const { head } = state.refs;
    let badge = head.querySelector('.nv-node-appmark');
    if (!mark) {
      if (badge) badge.remove();
      state.el.classList.remove('has-app-mark');
      return;
    }
    if (!badge) {
      badge = el('span', { class: 'nv-node-appmark' }, icon('app', 11));
      head.insertBefore(badge, state.refs.badges);
    }
    badge.dataset.mark = mark;
    badge.title = T(`nodes.app.mark.${mark}`);
    state.el.classList.add('has-app-mark');
  }

  function getCardState(cardEl) {
    return cardStates.get(cardEl) || null;
  }

  OCD.ui = {
    selectEntries,
    T,
    tr,
    el,
    icon,
    categoryIcon,
    humanize,
    typeLabel,
    typeKeywords,
    availabilityReason,
    categoryLabel,
    portLabel,
    paramLabel,
    optionLabel,
    hasIssueText,
    issueText,
    connectText,
    setRoot,
    root,
    dialog,
    confirmDialog,
    promptDialog,
    toast,
    menu,
    closeMenu,
    inlineEdit,
    optionsFor,
    refreshOptions,
    onOptionsChange,
    normalizeOptions,
    modelDetail,
    peekModelDetail,
    onModelChange,
    refreshModelDetails,
    refreshStaleModelDetails,
    optionCapabilities,
    limitsFor,
    roleLabel,
    capabilitiesText,
    viewsText,
    strengthText,
    misfitText,
    modelOptionLabel,
    portCountText,
    portOverLimit,
    mediaElement,
    mediaUrl,
    isMediaValue,
    renderValue,
    paramWidget,
    promptFieldOptions,
    field,
    autosize,
    acceptFor,
    fileInputAccept,
    createCard,
    updateCard,
    applySlots,
    setAppMark,
    setCardActions,
    statusLabel,
    getCardState,
    disposeWidgets
  };
})(window);
