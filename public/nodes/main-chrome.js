'use strict';

// Menus, keyboard handling and page chrome from main.js.
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    ui, openPalette, addNoteAt, readClipboard, pasteClipboard, selectAll, extensions, duplicateSelection,
    copySelection, graphLib, state, applyGraph, groupSelected, selectionIds, deleteSelection, renameNode,
    renameWorkflow, duplicateWorkflow, exportWorkflow, exportWorkflowZip, openImportPicker,
    assignProject, openShareDialog, openTemplateDialog, deleteWorkflow, nodeHelp, hasSelection,
    setSelection, redo, undo, bus, pointerWorld, setTool, moveSelectionBy, el, leaveToChat, setDrawer,
    patchName, appButtonMenu, viewCenter, setInspector, createWorkflow, setSaveState, refreshInspector,
    showBanner, reloadWorkflow, overwriteConflict
  } = runtime;

  /* ---------- menus ---------- */

  function canvasMenuItems(world) {
    const items = [
      { label: ui.T('nodes.menu.addNode'), icon: 'plus', shortcut: 'Tab', onClick: () => openPalette({ world, exact: true }) },
      { label: ui.T('nodes.menu.addNote'), icon: 'note', shortcut: 'N', onClick: () => addNoteAt(world) },
      { label: ui.T('nodes.menu.paste'), icon: 'copy', shortcut: '⌘V', disabled: !readClipboard(), onClick: () => pasteClipboard(world) },
      { separator: true },
      { label: ui.T('nodes.menu.selectAll'), shortcut: '⌘A', onClick: selectAll },
      { label: ui.T('nodes.menu.fit'), icon: 'fit', shortcut: 'F', onClick: () => runtime.canvas.fit({ padding: 96 }) }
    ];
    for (const extra of extensions.canvasMenu) {
      const more = extra({ world });
      if (more && more.length) items.push({ separator: true }, ...more);
    }
    return items;
  }

  function nodeMenuItems(id) {
    const items = [
      { label: ui.T('nodes.action.duplicate'), icon: 'duplicate', shortcut: '⌘D', onClick: duplicateSelection },
      { label: ui.T('nodes.action.copy'), icon: 'copy', shortcut: '⌘C', onClick: copySelection },
      { label: ui.T('nodes.action.cut'), shortcut: '⌘X', onClick: () => cutSelection() },
      { label: ui.T('nodes.action.rename'), icon: 'edit', onClick: () => renameNodeDialog(id) },
      { label: ui.T('nodes.action.disconnect'), disabled: !graphLib.edgesOf(state.graph, id).length, onClick: () => applyGraph(graphLib.disconnectNode(state.graph, id), { history: 'disconnect' }) }
    ];
    if (state.selection.nodes.size + state.selection.notes.size > 1) items.push({ label: ui.T('nodes.action.group'), icon: 'group', shortcut: '⌘G', onClick: groupSelected });
    for (const extra of extensions.nodeMenu) {
      const more = extra({ nodeId: id, selection: selectionIds() });
      if (more && more.length) items.push({ separator: true }, ...more);
    }
    items.push({ separator: true }, { label: ui.T('nodes.action.delete'), icon: 'trash', shortcut: '⌫', danger: true, onClick: deleteSelection });
    return items;
  }

  // Moves one connection of a multi-input to another place in the order of that input (a chip dragged in the row of a
  // card, the arrow keys, the menus). Only the edges of this input change places in graph.edges; one undo step. The next
  // plan marks the node as stale: its cache key contains the inputs in this order.
  function reorderInput(nodeId, portId, edgeId, target) {
    const result = graphLib.moveInputEdge(state.reg, state.graph, nodeId, portId, edgeId, target);
    if (result.error || !result.changed) return false;
    applyGraph(result.graph, { history: 'reorder-inputs' });
    return true;
  }

  // Menu entries to move a connection within its input: only for a multi-input with two or more connections; an entry
  // that would change nothing (the first one cannot go forward) is disabled.
  function orderMenuItems(nodeId, portId, edgeId) {
    const ids = graphLib.incomingEdges(state.graph, nodeId, portId).map((edge) => edge.id);
    const node = graphLib.getNode(state.graph, nodeId);
    const port = node && state.reg ? graphLib.findPort(state.reg, node, 'in', portId) : null;
    const at = ids.indexOf(edgeId);
    if (!port || !port.multiple || ids.length < 2 || at < 0) return [];
    const go = (place) => () => reorderInput(nodeId, portId, edgeId, place);
    return [
      { label: ui.T('nodes.order.first'), icon: 'arrowUp', disabled: at === 0, onClick: go('first') },
      { label: ui.T('nodes.order.earlier'), icon: 'chevron-left', disabled: at === 0, onClick: go('earlier') },
      { label: ui.T('nodes.order.later'), icon: 'chevron', disabled: at === ids.length - 1, onClick: go('later') },
      { label: ui.T('nodes.order.last'), icon: 'arrowDown', disabled: at === ids.length - 1, onClick: go('last') }
    ];
  }

  async function renameNodeDialog(id) {
    const node = graphLib.getNode(state.graph, id);
    if (!node) return;
    const def = state.reg.types.get(node.type);
    const title = await ui.promptDialog({ title: ui.T('nodes.action.rename'), label: ui.T('nodes.inspector.title'), value: node.title || '', placeholder: def ? ui.typeLabel(def) : node.type });
    if (title !== null) renameNode(id, title);
  }

  function cutSelection() {
    if (copySelection()) deleteSelection();
  }

  function onCanvasContextMenu(info) {
    if (info.kind === 'node') ui.menu(info.clientX, info.clientY, nodeMenuItems(info.id));
    else if (info.kind === 'note') {
      ui.menu(info.clientX, info.clientY, [
        { label: ui.T('nodes.action.duplicate'), icon: 'duplicate', shortcut: '⌘D', onClick: duplicateSelection },
        { label: ui.T('nodes.action.copy'), icon: 'copy', shortcut: '⌘C', onClick: copySelection },
        { separator: true },
        { label: ui.T('nodes.action.delete'), icon: 'trash', danger: true, onClick: deleteSelection }
      ]);
    } else if (info.kind === 'group') {
      ui.menu(info.clientX, info.clientY, [
        { label: ui.T('nodes.action.duplicate'), icon: 'duplicate', shortcut: '⌘D', onClick: duplicateSelection },
        { label: ui.T('nodes.action.ungroup'), icon: 'x', onClick: deleteSelection }
      ]);
    } else if (info.kind === 'edge') {
      const edge = state.graph.edges.find((item) => item.id === info.id);
      const order = edge ? orderMenuItems(edge.to.node, edge.to.port, edge.id) : [];
      ui.menu(info.clientX, info.clientY, [
        ...order,
        order.length ? { separator: true } : null,
        { label: ui.T('nodes.inspector.disconnect'), icon: 'trash', danger: true, onClick: () => applyGraph(graphLib.disconnect(state.graph, info.id), { history: 'disconnect' }) }
      ]);
    } else {
      ui.menu(info.clientX, info.clientY, canvasMenuItems(info.world));
    }
  }

  function workflowMenu() {
    if (!state.workflow) return;
    const rect = runtime.dom.menuBtn.getBoundingClientRect();
    const workflow = state.workflow;
    const manage = workflow.canManage !== false;
    ui.menu(rect.right - 200, rect.bottom + 6, [
      manage && { label: ui.T('nodes.list.rename'), icon: 'edit', onClick: () => renameWorkflow(workflow) },
      { label: ui.T('nodes.list.duplicate'), icon: 'duplicate', onClick: () => duplicateWorkflow(workflow) },
      { label: ui.T('nodes.list.export'), icon: 'download', onClick: () => exportWorkflow(workflow) },
      { label: ui.T('nodes.list.exportZip'), icon: 'zip', onClick: () => exportWorkflowZip(workflow) },
      { label: ui.T('nodes.list.import'), icon: 'upload', onClick: openImportPicker },
      manage && { label: ui.T('nodes.project.assign'), icon: 'folder', onClick: () => assignProject(workflow) },
      workflow.canShare === true && { label: ui.T('nodes.share.menu'), icon: 'users', onClick: () => openShareDialog(workflow) },
      { label: ui.T('nodes.template.new'), icon: 'template', onClick: openTemplateDialog },
      ...extensions.workflowMenu.flatMap((extra) => extra({ workflow }) || []),
      manage && { separator: true },
      manage && { label: ui.T('nodes.list.delete'), icon: 'trash', danger: true, onClick: () => deleteWorkflow(workflow) }
    ].filter(Boolean));
  }

  /* ---------- keyboard ---------- */

  function isEditable(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function dialogOpen() {
    return Boolean(runtime.dom.overlays.querySelector('.nv-dialog-backdrop, .nv-viewer'));
  }

  // Text the person selected outside the canvas, for example in an answer of the assistant, in the inspector or in a
  // help text. Copy, cut and delete then belong to that text (the browser copies it), not to the selected nodes. A press
  // on the canvas ends such a selection again (see the pointerdown listener in boot).
  function textSelectedOutsideCanvas() {
    if (!runtime.dom || !runtime.dom.canvasHost || typeof global.getSelection !== 'function') return false;
    const selection = global.getSelection();
    if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
    const anchor = selection.anchorNode;
    const element = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    return Boolean(element) && !runtime.dom.canvasHost.contains(element);
  }

  // "?" or F1: the help popover of the selected node, the keyboard way to the "?" of its card. Needs exactly one node.
  function openSelectedHelp() {
    if (state.selection.nodes.size !== 1) return false;
    const [id] = state.selection.nodes;
    const node = graphLib.getNode(state.graph, id);
    const card = [...runtime.dom.canvasHost.querySelectorAll('.nv-node')].find((item) => item.dataset.id === id);
    const anchor = card && card.querySelector('.nv-node-help');
    if (!node || !anchor) return false;
    nodeHelp.openPopover(node.type, anchor);
    return true;
  }

  function onKeyDown(event) {
    if (!state.active) return;
    if (dialogOpen()) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (key === 'Escape') {
      if (runtime.palette.isOpen()) return;
      if (isEditable(event.target)) {
        event.target.blur();
        runtime.canvas && runtime.dom.canvasHost.focus({ preventScroll: true });
        return;
      }
      ui.closeMenu();
      if (hasSelection() || state.selection.edge) setSelection({ nodes: [], notes: [], groups: [], edge: null });
      return;
    }
    if (isEditable(event.target)) return;
    if (!state.workflow) return;
    if (runtime.palette.isOpen()) return;

    if (key === ' ' || event.code === 'Space') {
      // on a focused button (the "?" of a card) the space bar clicks, as it does everywhere else
      if (event.target && event.target.closest && event.target.closest('button')) return;
      if (!event.repeat) runtime.canvas.setSpace(true);
      event.preventDefault();
      return;
    }
    if (mod) {
      if (lower === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (lower === 'y') {
        event.preventDefault();
        redo();
      } else if (lower === 'c') {
        if (textSelectedOutsideCanvas()) return; // the browser copies the selected text
        if (copySelection()) event.preventDefault();
      } else if (lower === 'x') {
        if (textSelectedOutsideCanvas()) return;
        if (hasSelection()) {
          event.preventDefault();
          cutSelection();
        }
      } else if (lower === 'v') {
        if (pasteClipboard()) event.preventDefault();
      } else if (lower === 'd') {
        event.preventDefault();
        duplicateSelection();
      } else if (lower === 'a') {
        event.preventDefault();
        selectAll();
      } else if (lower === 'g') {
        event.preventDefault();
        groupSelected();
      } else if (key === '0') {
        event.preventDefault();
        runtime.canvas.setZoom(1);
      } else if (key === 'Enter') {
        event.preventDefault();
        bus.emit(event.shiftKey ? 'run:all' : 'run:selection', { selection: selectionIds() });
      }
      return;
    }
    if (event.altKey) return;
    if (key === 'Tab' || key === '/') {
      event.preventDefault();
      openPalette({ world: pointerWorld() });
    } else if (key === '?' || key === 'F1') {
      if (openSelectedHelp()) event.preventDefault();
    } else if (key === 'Delete' || key === 'Backspace') {
      if (textSelectedOutsideCanvas()) return;
      event.preventDefault();
      deleteSelection();
    } else if (lower === 'f' || (key === '!' && event.shiftKey) || (event.code === 'Digit1' && event.shiftKey)) {
      event.preventDefault();
      runtime.canvas.fit({ selectionOnly: true, padding: 96, maxZoom: 1.25 });
    } else if (lower === 'n') {
      event.preventDefault();
      addNoteAt(pointerWorld());
    } else if (lower === 'v') {
      setTool('select');
    } else if (lower === 'h') {
      setTool('hand');
    } else if (key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      moveSelectionBy(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
    }
  }

  function onKeyUp(event) {
    if (event.key === ' ' || event.code === 'Space') runtime.canvas && runtime.canvas.setSpace(false);
  }

  /* ---------- chrome ---------- */

  function tbtn(iconName, labelKey, options = {}) {
    const button = el('button', { type: 'button', class: options.className || 'nv-icon-btn', dataset: { tKey: labelKey } });
    button.append(ui.icon(iconName, options.size || 16));
    if (options.text) button.append(el('span', { class: 'nv-btn-text', dataset: { tText: options.text }, text: ui.T(options.text) }));
    button.title = ui.T(labelKey);
    button.setAttribute('aria-label', ui.T(labelKey));
    return button;
  }

  function buildChrome(rootEl) {
    rootEl.textContent = '';
    rootEl.classList.add('nv-app');
    // Chat | Nodes: the same switch at the same place as in the chat header (right, next to the avatar), so it does not
    // move when the view changes. Header height, right padding, gap, switch and avatar size match public/styles.css.
    const modeChat = el('button', { type: 'button', class: 'mode-switch-button', dataset: { tKey: 'mode.chatTitle', tText: 'mode.chat' }, text: ui.T('mode.chat') });
    modeChat.title = ui.T('mode.chatTitle');
    modeChat.addEventListener('click', leaveToChat);
    const modeNodes = el('button', { type: 'button', class: 'mode-switch-button active', 'aria-current': 'page', dataset: { tText: 'mode.nodes' }, text: ui.T('mode.nodes') });
    const modeSwitch = el('div', { class: 'mode-switch nv-mode-switch', role: 'group', dataset: { tKey: 'mode.selector' } }, modeChat, modeNodes);
    modeSwitch.setAttribute('aria-label', ui.T('mode.selector'));
    // The menu behind the avatar (costs, settings, help, language, sign-out) is shared with the chat view (public/shell.js).
    const accountMenu = global.OCShell ? global.OCShell.accountMenu({ variant: 'nodes' }) : null;
    const drawerToggle = tbtn('panel', 'nodes.topbar.toggleList');
    drawerToggle.addEventListener('click', () => setDrawer(!state.drawerOpen));
    const name = el('input', { class: 'nv-name-input', type: 'text', maxlength: 120, autocomplete: 'off', spellcheck: 'false' });
    name.setAttribute('aria-label', ui.T('nodes.workflow.name'));
    name.placeholder = ui.T('nodes.workflow.name');
    name.addEventListener('change', () => {
      const value = name.value.trim();
      if (!state.workflow) return;
      if (!value) {
        name.value = state.workflow.name;
        return;
      }
      if (value !== state.workflow.name) patchName(state.workflow.id, value);
    });
    name.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') name.blur();
      if (event.key === 'Escape') {
        name.value = state.workflow ? state.workflow.name : '';
        name.blur();
      }
    });
    const saveStateEl = el('span', { class: 'nv-save-state hidden', role: 'status', dataset: { state: 'saved' } });
    const ownerEl = el('span', { class: 'nv-owner hidden' });
    const shareBtn = tbtn('users', 'nodes.share.buttonTitle', { className: 'nv-btn nv-share-btn hidden', text: 'nodes.share.button' });
    shareBtn.addEventListener('click', openShareDialog);
    const runSlot = el('div', { class: 'nv-run-slot', dataset: { slot: 'run' } });
    const appBtn = tbtn('app', 'nodes.app.button', { className: 'nv-icon-btn nv-app-btn hidden' });
    appBtn.append(el('i', { class: 'nv-app-dot' }));
    appBtn.addEventListener('click', appButtonMenu);
    const addNode = tbtn('plus', 'nodes.topbar.addNodeTitle', { className: 'nv-btn nv-btn-primary nv-add-node', text: 'nodes.topbar.addNode' });
    addNode.addEventListener('click', () => openPalette({ world: viewCenter() }));
    const undoBtn = tbtn('undo', 'nodes.topbar.undo');
    undoBtn.addEventListener('click', undo);
    const redoBtn = tbtn('redo', 'nodes.topbar.redo');
    redoBtn.addEventListener('click', redo);
    const menuBtn = tbtn('more', 'nodes.topbar.menu');
    menuBtn.addEventListener('click', workflowMenu);
    const inspectorToggle = tbtn('panel-right', 'nodes.topbar.toggleInspector');
    // The assistant takes the place of the inspector; this button brings the inspector back.
    inspectorToggle.addEventListener('click', () => {
      if (runtime.assistant && runtime.assistant.isOpen()) {
        runtime.assistant.close();
        setInspector(true, { remember: false });
        return;
      }
      setInspector(!state.inspectorOpen);
    });
    const assistantBtn = tbtn('sparkle', 'nodes.assistant.buttonTitle', { className: 'nv-btn nv-assistant-btn hidden', text: 'nodes.assistant.button' });
    assistantBtn.setAttribute('aria-pressed', 'false');
    assistantBtn.addEventListener('click', () => runtime.assistant && runtime.assistant.toggle());
    const topbar = el(
      'header',
      { class: 'nv-topbar' },
      drawerToggle,
      el('div', { class: 'nv-topbar-title' }, name, saveStateEl, ownerEl),
      el('div', { class: 'nv-topbar-spacer' }),
      runSlot,
      shareBtn,
      appBtn,
      assistantBtn,
      addNode,
      el('div', { class: 'nv-btn-group' }, undoBtn, redoBtn),
      menuBtn,
      inspectorToggle,
      el('span', { class: 'nv-topbar-divider', 'aria-hidden': 'true' }),
      modeSwitch,
      accountMenu ? accountMenu.element : null
    );

    const drawer = el('aside', { class: 'nv-drawer', 'aria-label': ui.T('nodes.list.title') });
    const canvasHost = el('div', { class: 'nv-canvas-host' });
    const toolSelect = tbtn('cursor', 'nodes.tool.select', { className: 'nv-tool is-active' });
    const toolHand = tbtn('hand', 'nodes.tool.hand', { className: 'nv-tool' });
    toolSelect.addEventListener('click', () => setTool('select'));
    toolHand.addEventListener('click', () => setTool('hand'));
    const zoomOut = tbtn('minus', 'nodes.zoom.out', { className: 'nv-tool' });
    const zoomIn = tbtn('plus', 'nodes.zoom.in', { className: 'nv-tool' });
    const zoomLabel = el('button', { type: 'button', class: 'nv-zoom-label', title: ui.T('nodes.zoom.reset'), dataset: { tKey: 'nodes.zoom.reset' }, text: '100%' });
    const fitBtn = tbtn('fit', 'nodes.zoom.fit', { className: 'nv-tool' });
    zoomOut.addEventListener('click', () => runtime.canvas.zoomBy(1 / 1.25));
    zoomIn.addEventListener('click', () => runtime.canvas.zoomBy(1.25));
    zoomLabel.addEventListener('click', () => runtime.canvas.setZoom(1));
    fitBtn.addEventListener('click', () => runtime.canvas.fit({ padding: 96 }));
    const toolbar = el('div', { class: 'nv-toolbar hidden', role: 'toolbar' }, toolSelect, toolHand, el('span', { class: 'nv-toolbar-sep' }), zoomOut, zoomLabel, zoomIn, fitBtn);
    const minimap = el('div', { class: 'nv-minimap hidden' });
    const banner = el('div', { class: 'nv-banner hidden', role: 'alert' });
    const emptyTitle = el('h2', { class: 'nv-empty-title' });
    const emptyBody = el('p', { class: 'nv-empty-body' });
    const emptyButton = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-empty-button' }, ui.icon('plus', 15), el('span', { text: ui.T('nodes.list.new'), dataset: { tText: 'nodes.list.new' } }));
    emptyButton.addEventListener('click', createWorkflow);
    const emptyTemplate = el('button', { type: 'button', class: 'nv-btn nv-empty-button nv-empty-template' }, ui.icon('template', 15), el('span', { text: ui.T('nodes.template.new'), dataset: { tText: 'nodes.template.new' } }));
    emptyTemplate.addEventListener('click', openTemplateDialog);
    const empty = el('div', { class: 'nv-empty' }, el('div', { class: 'nv-empty-mark' }, ui.icon('workflow', 26)), emptyTitle, emptyBody, el('div', { class: 'nv-empty-actions' }, emptyButton, emptyTemplate));
    // An open workflow without nodes: a quiet start in the middle (it lets drops, drags and shortcuts through).
    const startTemplate = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-start-button' }, ui.icon('template', 15), el('span', { text: ui.T('nodes.start.template'), dataset: { tText: 'nodes.start.template' } }));
    startTemplate.addEventListener('click', () => openTemplateDialog({ primary: 'insert' }));
    const startAdd = el('button', { type: 'button', class: 'nv-btn nv-start-button' }, ui.icon('plus', 15), el('span', { text: ui.T('nodes.start.addNode'), dataset: { tText: 'nodes.start.addNode' } }));
    startAdd.addEventListener('click', () => openPalette({ world: viewCenter() }));
    const start = el(
      'div',
      { class: 'nv-start hidden' },
      el(
        'div',
        { class: 'nv-start-card' },
        el('h3', { class: 'nv-start-title', text: ui.T('nodes.start.title'), dataset: { tText: 'nodes.start.title' } }),
        el('p', { class: 'nv-start-body', text: ui.T('nodes.start.body'), dataset: { tText: 'nodes.start.body' } }),
        el('div', { class: 'nv-start-actions' }, startTemplate, startAdd),
        el('p', { class: 'nv-start-hint', text: ui.T('nodes.start.hint'), dataset: { tText: 'nodes.start.hint' } })
      )
    );
    const loading = el('div', { class: 'nv-loading', 'aria-hidden': 'true' }, el('div', { class: 'nv-spinner' }));
    const stage = el('section', { class: 'nv-stage is-empty' }, canvasHost, toolbar, minimap, start, empty, loading, banner);
    const inspectorHost = el('aside', { class: 'nv-inspector', 'aria-label': ui.T('nodes.inspector.label') });
    const inspectorScroll = el('div', { class: 'nv-insp-scroll' });
    inspectorHost.append(inspectorScroll);
    const assistantHost = el('aside', { class: 'nv-assistant', 'aria-label': ui.T('nodes.assistant.label') });
    const body = el('div', { class: 'nv-body' }, drawer, stage, inspectorHost, assistantHost);
    const appViewEl = el('section', { class: 'nv-appview hidden', 'aria-label': ui.T('nodes.app.section') });
    const overlays = el('div', { class: 'nv-overlays' });
    rootEl.append(topbar, body, appViewEl, overlays);
    ui.setRoot(overlays);
    return {
      root: rootEl,
      topbar,
      body,
      drawer,
      stage,
      canvasHost,
      minimap,
      toolbar,
      toolSelect,
      toolHand,
      zoomLabel,
      banner,
      start,
      empty,
      emptyTitle,
      emptyBody,
      emptyButton,
      emptyTemplate,
      inspectorHost,
      inspectorScroll,
      assistantHost,
      assistantBtn,
      overlays,
      name,
      saveState: saveStateEl,
      owner: ownerEl,
      shareBtn,
      addNode,
      undo: undoBtn,
      redo: redoBtn,
      menuBtn,
      drawerToggle,
      inspectorToggle,
      runSlot,
      appBtn,
      appView: appViewEl
    };
  }

  function relabelChrome() {
    for (const node of runtime.dom.root.querySelectorAll('[data-t-key]')) {
      const value = ui.T(node.dataset.tKey);
      node.title = value;
      node.setAttribute('aria-label', value);
    }
    for (const node of runtime.dom.root.querySelectorAll('[data-t-text]')) node.textContent = ui.T(node.dataset.tText);
    runtime.dom.name.placeholder = ui.T('nodes.workflow.name');
    runtime.dom.name.setAttribute('aria-label', ui.T('nodes.workflow.name'));
    runtime.dom.assistantHost.setAttribute('aria-label', ui.T('nodes.assistant.label'));
    if (runtime.assistant) runtime.assistant.relabel();
    if (global.OCShell) global.OCShell.refresh();
    setSaveState(state.saveState);
    if (!state.workflow) showListViewText();
    else if (state.conflict) enterConflictText();
    runtime.workflowList.relabel();
    if (runtime.canvas) runtime.canvas.relabel();
    if (runtime.runController) runtime.runController.relabel();
    if (runtime.appView) runtime.appView.relabel();
    if (runtime.inspector) runtime.inspector.invalidate();
    refreshInspector(true);
  }

  function showListViewText() {
    if (runtime.dom.empty.dataset.kind === 'list') {
      runtime.dom.emptyTitle.textContent = ui.T('nodes.stage.emptyTitle');
      runtime.dom.emptyBody.textContent = ui.T('nodes.stage.emptyBody');
    }
  }

  function enterConflictText() {
    showBanner({
      kind: 'warn',
      text: ui.T('nodes.banner.conflict'),
      actions: [
        { label: ui.T('nodes.banner.reload'), onClick: () => reloadWorkflow() },
        { label: ui.T('nodes.banner.overwrite'), primary: true, onClick: () => overwriteConflict() }
      ]
    });
  }


  Object.assign(runtime, {
    canvasMenuItems, nodeMenuItems, reorderInput, orderMenuItems, renameNodeDialog, cutSelection,
    onCanvasContextMenu, workflowMenu, isEditable, dialogOpen, textSelectedOutsideCanvas,
    openSelectedHelp, onKeyDown, onKeyUp, tbtn, buildChrome, relabelChrome, showListViewText,
    enterConflictText
  });
})(window);
