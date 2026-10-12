'use strict';

// Bootstrap and state container of the node view (SPEC §12.1-§12.7): hash routing (#w=), page
// chrome, workflow loading, autosave with optimistic rev, undo/redo, clipboard, shortcuts,
// import / export and the wiring of canvas, palette, inspector and workflow list. WP7 adds the
// Design App builder (workflow.app, inspector panel, card marks), the #app= view (app-mode.js),
// templates, project assignment and the chat bridge.
// Extension points: OCDNodes.bus (events), OCDNodes.editor (state access), OCDNodes.extensions
// (node / canvas / workflow menu items). The run UX (run.js, preview.js) plugs in through them and
// through the controller created in boot().
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    state, rememberReturnHash, nativeReplaceState, buildChrome, refreshInspector, hasSelection,
    setInspector, bus, selectionIds, applyGraph, graphLib, updateZoomLabel, scheduleSave,
    VIEWPORT_SAVE_DELAY, connectEdge, ui, openPalette, onCanvasContextMenu, applyParams, renameNode,
    extractPrompt, uploadFile, onFilesDropped, onPalettePick, templateStore, insertTemplate, nodeHelp,
    onPalettePickWithInputs, applyFix, selectNodeById, reorderInput, orderMenuItems, convertMotionHtml,
    deleteSelection, duplicateSelection, groupSelected, markDirty, appApi, sendNodeToChat, navigate,
    createWorkflow, importFile, renameWorkflow, duplicateWorkflow, exportWorkflow, exportWorkflowZip,
    deleteWorkflow, loadList, openTemplateDialog, openWorkflowApp, assignProject, openShareDialog,
    assistantWarnings, canInsertNow, insertSubgraph, undo, flushSave, api, showNodes, currentLang,
    setAssistantOpen, lsGet, LS_ASSISTANT_MODEL, lsSet, onModelCapabilities, extensions, hasNodeResult,
    leaveToChat, LS_DRAWER, setDrawer, LS_INSPECTOR, setTool, updateChrome, onKeyDown, onKeyUp,
    textSelectedOutsideCanvas, isEditable, dialogOpen, pasteClipboard, recheckRegistry, recheckPlan,
    route, relabelChrome, LS_LAST, checkStillAccessible, parseHash, reloadWorkflow, redo, addNodeAt,
    adoptTextResult, insertWithInputs, addInputFor, copySelection, fitAfterMeasure, changeApp
  } = runtime;
  // Resolve cross-part function bindings only after every part has registered.
  for (const connect of runtime.connect) connect();

  let booted = false;

  /* ---------- boot ---------- */

  function installHashGuard() {
    // app.js rewrites the hash to #s=<chat> after its own init finished; while the node view is
    // open that would throw us out of #w=, so those calls are swallowed (and remembered as return target).
    history.replaceState = function (stateObj, title, url) {
      if (state.active && typeof url === 'string') {
        const hashIndex = url.indexOf('#');
        const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
        if (!/^#(w|app)=/.test(hash)) {
          rememberReturnHash(hash);
          return undefined;
        }
      }
      return nativeReplaceState(stateObj, title, url);
    };
  }

  function boot() {
    if (booted) return;
    const rootEl = document.getElementById('nodeApp');
    if (!rootEl) return;
    booted = true;
    runtime.dom = buildChrome(rootEl);
    runtime.dom.root.classList.add('hidden');

    runtime.canvas = OCD.canvas.createCanvas(runtime.dom.canvasHost, {
      minimap: runtime.dom.minimap,
      onSelectionChange(selection) {
        state.selection = selection;
        refreshInspector();
        if (hasSelection() && !state.inspectorOpen && (state.inspectorAutoClosed || global.innerWidth > 1500)) setInspector(true, { remember: false });
        bus.emit('selection', selectionIds());
      },
      onMoveEnd(positions) {
        if (!Object.keys(positions).length) return;
        applyGraph(graphLib.setPositions(state.graph, positions), { history: 'move' });
      },
      onViewportChange(viewport) {
        state.graph = { ...state.graph, viewport };
        state.dirtyViewport = true;
        updateZoomLabel();
        scheduleSave(VIEWPORT_SAVE_DELAY);
      },
      onConnect: connectEdge,
      onConnectRefused(error) {
        // an error of the graph ({ code, data? }) or just the code of a refused drop target
        ui.toast(ui.connectText(error), { kind: 'warn' });
      },
      onDetach(edgeId) {
        applyGraph(graphLib.disconnect(state.graph, edgeId), { history: 'disconnect' });
      },
      onDropEmpty({ anchor, portType, portMultiple, world, client }) {
        // Weavy-style quick pick at the release point: only nodes with a compatible port, Prompt first for text inputs,
        // Media list and the single input node first for a multi-input of a media type.
        openPalette({ world, anchor, exact: true, client }, { dir: anchor.dir, type: portType, multiple: portMultiple === true });
      },
      onCanvasDoubleClick({ world }) {
        openPalette({ world, exact: true });
      },
      onContextMenu: onCanvasContextMenu,
      onParam: (nodeId, paramId, value, meta) => applyParams(nodeId, { [paramId]: value }, meta, `p:${nodeId}:${paramId}`),
      onRename: renameNode,
      onExtractPrompt: extractPrompt,
      onNoteChange(id, patch) {
        applyGraph(graphLib.updateNote(state.graph, id, patch), { history: 'note', key: `note:${id}:${Object.keys(patch).join(',')}` });
      },
      onGroupChange(id, patch) {
        applyGraph(graphLib.updateGroup(state.graph, id, patch), { history: 'group-edit', key: `group:${id}:${Object.keys(patch).join(',')}` });
      },
      uploadFile,
      onFilesDropped
    });
    runtime.canvas.setRegistry(null);

    runtime.palette = OCD.palette.createPalette({
      host: runtime.dom.overlays,
      getReg: () => state.reg,
      onPick: onPalettePick,
      getTemplates: () => templateStore.list(),
      onPickTemplate: (template) => insertTemplate(template),
      help: nodeHelp,
      onPickWithInputs: onPalettePickWithInputs
    });
    // The "?" of a card (popover) and the remedy buttons on cards (slot.fix, filled by run.js).
    ui.setCardActions({
      help: (nodeId, anchor) => {
        const node = graphLib.getNode(state.graph, nodeId);
        if (node) nodeHelp.openPopover(node.type, anchor);
      },
      fix: applyFix,
      select: selectNodeById,
      reorder: reorderInput,
      orderMenu: (nodeId, portId, edgeId, x, y) => ui.menu(x, y, orderMenuItems(nodeId, portId, edgeId))
    });
    OCD.inspector.installApprovalGuard(OCD.api, () => state);
    runtime.runController = OCD.run.createController({ OCD });
    runtime.inspector = OCD.inspector.createInspector({
      host: runtime.dom.inspectorScroll,
      getReg: () => state.reg,
      callbacks: {
        onParam: (nodeId, paramId, value, meta) => applyParams(nodeId, { [paramId]: value }, meta, `p:${nodeId}:${paramId}`),
        onParams: (nodeId, patch, meta, key) => applyParams(nodeId, patch, meta, `p:${nodeId}:${key || Object.keys(patch).join(',')}`),
        onTitle: (nodeId, title) => renameNode(nodeId, title),
        onExtractPrompt: extractPrompt,
        onConvertMotionHtml: convertMotionHtml,
        onFix: applyFix,
        help: nodeHelp,
        onDelete: deleteSelection,
        onDuplicate: duplicateSelection,
        onGroupSelection: groupSelected,
        onDisconnect: (edgeId) => applyGraph(graphLib.disconnect(state.graph, edgeId), { history: 'disconnect' }),
        onNote: (id, patch) => applyGraph(graphLib.updateNote(state.graph, id, patch), { history: 'note', key: `note:${id}:${Object.keys(patch).join(',')}` }),
        onGroup: (id, patch) => applyGraph(graphLib.updateGroup(state.graph, id, patch), { history: 'group-edit', key: `group:${id}:${Object.keys(patch).join(',')}` }),
        onWorkflowMeta: (patch) => {
          Object.assign(state.workflow, patch);
          markDirty();
        },
        uploadFile,
        app: appApi(),
        run: { ...runtime.runController.inspectorApi, runAll: () => runtime.runController.startRun({ mode: 'all', force: false }), runAllAgain: () => runtime.runController.runAllAgain(), sendToChat: sendNodeToChat, selectNode: selectNodeById },
        onRendered: (slot, ctx) => bus.emit('inspector', { slot, selection: ctx.selection, graph: ctx.graph })
      }
    });
    runtime.workflowList = OCD.workflowList.createWorkflowList({
      host: runtime.dom.drawer,
      callbacks: {
        onOpen: (id) => navigate(id),
        onCreate: createWorkflow,
        onImport: importFile,
        onRename: renameWorkflow,
        onDuplicate: duplicateWorkflow,
        onExport: exportWorkflow,
        onExportZip: exportWorkflowZip,
        onDelete: deleteWorkflow,
        onReload: loadList,
        onTemplate: openTemplateDialog,
        onOpenApp: openWorkflowApp,
        onProject: assignProject,
        onShare: openShareDialog
      }
    });

    runtime.runController.attach();
    runtime.assistant = OCD.assistant.createAssistant({
      OCD,
      host: runtime.dom.assistantHost,
      help: nodeHelp,
      getWorkflowId: () => (state.workflow ? state.workflow.id : null),
      getGraph: () => state.graph,
      getReg: () => state.reg,
      getSelection: () => [...state.selection.nodes],
      getWarnings: assistantWarnings,
      canInsert: canInsertNow,
      insert: (sub, options) => insertSubgraph(sub, options),
      historyRevision: () => state.history.revision,
      undo,
      flushSave: () => flushSave().catch(() => {}),
      plan: () => api.plan(state.workflow.id, { mode: 'all', force: false }),
      showNodes,
      getLang: currentLang,
      onToggle: setAssistantOpen,
      // the language models of the chat (app.js), and the choice of this person in this browser (lsGet / lsSet guard the storage)
      getModelChoices: () => (global.OCBrain ? global.OCBrain.choices() : null),
      modelStore: { read: () => lsGet(LS_ASSISTANT_MODEL) || '', write: (model) => lsSet(LS_ASSISTANT_MODEL, model) }
    });
    bus.on('workflow:open', () => runtime.assistant.workflowChanged());
    bus.on('workflow:close', () => runtime.assistant.workflowChanged());
    ui.onModelChange(onModelCapabilities);
    extensions.nodeMenu.push(({ nodeId }) => [{ label: ui.T('nodes.send.menu'), icon: 'send', disabled: !hasNodeResult(nodeId), onClick: () => sendNodeToChat(nodeId) }]);
    runtime.appView = OCD.appMode.createAppView({
      host: runtime.dom.appView,
      callbacks: {
        onBack: leaveToChat,
        onEdit: (id) => navigate(id)
      }
    });
    const drawerPref = lsGet(LS_DRAWER);
    setDrawer(drawerPref === null ? global.innerWidth >= 1360 : drawerPref === '1', { remember: false });
    const inspectorPref = lsGet(LS_INSPECTOR);
    setInspector(inspectorPref === null ? true : inspectorPref === '1', { remember: false });
    setTool('select');
    updateChrome();

    document.addEventListener('focusin', (event) => {
      if (!state.active || !runtime.dom || runtime.dom.root.contains(event.target)) return;
      const chat = document.querySelector('body > .app');
      if (chat && chat.contains(event.target)) {
        event.target.blur();
        runtime.dom.canvasHost.focus({ preventScroll: true });
      }
    });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    // A press on the canvas ends a text selection elsewhere, so copy, cut and delete work on the nodes again.
    runtime.dom.canvasHost.addEventListener('pointerdown', () => {
      if (textSelectedOutsideCanvas()) global.getSelection().removeAllRanges();
    }, true);
    global.addEventListener('blur', () => runtime.canvas.setSpace(false));
    document.addEventListener('paste', (event) => {
      if (!state.active || !state.workflow || isEditable(event.target) || dialogOpen()) return;
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (text && pasteClipboard(null, text)) event.preventDefault();
    });
    global.addEventListener('beforeunload', (event) => {
      if (state.active && state.workflow && (state.dirtyContent || state.saving)) {
        flushSave({ keepalive: true }).catch(() => {});
        event.preventDefault();
        event.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.active && state.workflow) flushSave({ keepalive: true }).catch(() => {});
      if (document.visibilityState === 'visible') recheckRegistry();
    });
    global.addEventListener('focus', recheckRegistry);
    // the plan also looks again, for a branding that was changed in the chat or in another tab (not more often than every 5 s)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') recheckPlan();
    });
    global.addEventListener('focus', recheckPlan);
    global.addEventListener('resize', () => runtime.canvas && runtime.canvas.relayout());
    global.addEventListener('hashchange', route);

    const previousLang = global.onLangChange;
    global.onLangChange = (...args) => {
      if (typeof previousLang === 'function') previousLang(...args);
      if (booted) relabelChrome();
    };

    const nodesBtn = document.getElementById('nodesBtn');
    if (nodesBtn) {
      nodesBtn.addEventListener('click', () => {
        rememberReturnHash(global.location.hash);
        const last = lsGet(LS_LAST);
        navigate(last || '');
      });
    }

    installHashGuard();
    global.addEventListener('focus', checkStillAccessible);
    if (parseHash()) route();
  }

  OCD.bus = bus;
  OCD.extensions = extensions;
  OCD.editor = {
    getState: () => state,
    getGraph: () => state.graph,
    getWorkflow: () => state.workflow,
    getSelection: selectionIds,
    getCanvas: () => runtime.canvas,
    getInspector: () => runtime.inspector,
    getRegistry: () => state.reg,
    applyParams,
    flushSave,
    reload: reloadWorkflow,
    dom: () => runtime.dom,
    navigate,
    openPalette,
    undo,
    redo,
    addNodeAt,
    insertSubgraph,
    adoptTextResult,
    insertTemplate,
    insertWithInputs,
    addInputFor,
    getHelp: () => nodeHelp,
    getTemplates: () => templateStore,
    connectEdge,
    deleteSelection,
    duplicateSelection,
    copySelection,
    pasteClipboard,
    importFile,
    loadList,
    createWorkflow,
    setTool,
    fitAfterMeasure,
    getAppView: () => runtime.appView,
    openTemplateDialog,
    assignProject,
    changeApp,
    sendNodeToChat
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
