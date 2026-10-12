'use strict';

// Node operations, clipboard, history, palette and uploads from main.js.
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    graphLib, state, reserveId, applyGraph, setSelection, ui, hasSelection, selectionIds, PASTE_OFFSET,
    lsSet, LS_CLIPBOARD, lsGet, api, moveAppInput, currentApp, syncAppRemaps, pruneApp, markDirty,
    updateUndoButtons, refreshInspector, scheduleAppMarks, updateStart, bus
  } = runtime;
  let revealBounds, insertWithInputs;
  runtime.connect.push(() => {
    ({ revealBounds, insertWithInputs } = runtime);
  });

  /* ---------- node operations ---------- */

  function viewCenter() {
    const size = runtime.canvas.containerSize();
    return graphLib.screenToWorld(runtime.canvas.getViewport(), size.width / 2, size.height / 2);
  }

  function pointerWorld() {
    const rect = runtime.dom.canvasHost.getBoundingClientRect();
    const p = runtime.canvas.getLastPointer();
    if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) return runtime.canvas.clientToWorld(p.x, p.y);
    return viewCenter();
  }

  // Free spot near (x, y): nudges diagonally while another node sits at the same place.
  function freeSpot(x, y) {
    let px = graphLib.snap(x, 8);
    let py = graphLib.snap(y, 8);
    for (let i = 0; i < 24; i += 1) {
      if (!state.graph.nodes.some((node) => Math.abs(node.x - px) < 16 && Math.abs(node.y - py) < 16)) break;
      px += 32;
      py += 32;
    }
    return { x: px, y: py };
  }

  function addNodeAt(type, world, options = {}) {
    const spot = options.exact ? { x: graphLib.snap(world.x, 8), y: graphLib.snap(world.y, 8) } : freeSpot(world.x, world.y);
    const out = graphLib.addNode(state.reg, state.graph, type, { x: spot.x, y: spot.y, params: options.params, reserved: state.reserved });
    reserveId(out.node.id);
    let next = out.graph;
    let connectionError = null;
    if (options.anchor) {
      const anchor = options.anchor;
      const port = graphLib.firstCompatiblePort(state.reg, out.node, anchor.dir, options.portType);
      if (port) {
        const result =
          anchor.dir === 'out'
            ? graphLib.connect(state.reg, next, { node: anchor.node, port: anchor.port }, { node: out.node.id, port: port.id }, { reserved: state.reserved })
            : graphLib.connect(state.reg, next, { node: out.node.id, port: port.id }, { node: anchor.node, port: anchor.port }, { reserved: state.reserved });
        if (result.error) connectionError = result.error;
        else next = result.graph;
      }
    }
    applyGraph(next, { history: 'add-node' });
    setSelection({ nodes: [out.node.id], notes: [], groups: [], edge: null });
    if (connectionError) ui.toast(ui.connectText(connectionError), { kind: 'warn' });
    return out.node;
  }

  function deleteSelection() {
    if (state.selection.edge && !hasSelection()) {
      applyGraph(graphLib.disconnect(state.graph, state.selection.edge), { history: 'disconnect' });
      return;
    }
    if (!hasSelection()) return;
    const next = graphLib.removeSelection(state.graph, selectionIds());
    setSelection({ nodes: [], notes: [], groups: [], edge: null });
    applyGraph(next, { history: 'delete' });
  }

  function duplicateSelection() {
    if (!hasSelection()) return;
    const result = graphLib.duplicate(state.graph, selectionIds(), PASTE_OFFSET, { reserved: state.reserved });
    if (!result.ids.nodes.length && !result.ids.notes.length && !result.ids.groups.length) return;
    result.ids.nodes.forEach(reserveId);
    applyGraph(result.graph, { history: 'duplicate' });
    setSelection({ nodes: result.ids.nodes, notes: result.ids.notes, groups: result.ids.groups, edge: null });
  }

  function copySelection() {
    if (!hasSelection() || !state.workflow) return false;
    const clip = graphLib.copySelection(state.graph, selectionIds(), { workflowId: state.workflow.id, sessionId: state.workflow.sessionId });
    if (!clip) return false;
    const json = JSON.stringify(clip);
    state.clipboard = json;
    lsSet(LS_CLIPBOARD, json);
    try {
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) global.navigator.clipboard.writeText(json).catch(() => {});
    } catch (_) {
      /* clipboard access may be denied */
    }
    return true;
  }

  function readClipboard(text) {
    const source = text || state.clipboard || lsGet(LS_CLIPBOARD);
    if (!source) return null;
    try {
      const clip = JSON.parse(source);
      return graphLib.isClipboard(clip) ? clip : null;
    } catch (_) {
      return null;
    }
  }

  function pasteClipboard(world, text) {
    const clip = readClipboard(text);
    if (!clip || !state.workflow) return false;
    const target = world || pointerWorld();
    const result = graphLib.paste(state.graph, clip, target, { reserved: state.reserved });
    result.ids.nodes.forEach(reserveId);
    applyGraph(result.graph, { history: 'paste' });
    setSelection({ nodes: result.ids.nodes, notes: result.ids.notes, groups: result.ids.groups, edge: null });
    if (clip.sessionId && clip.sessionId !== state.workflow.sessionId) rehomeAssets(result.ids.nodes);
    return true;
  }

  // Pasting nodes from another workflow: uploaded assets live in that workflow's session, so copy them over.
  async function rehomeAssets(nodeIds) {
    const workflowId = state.workflow && state.workflow.id;
    const sessionId = state.workflow && state.workflow.sessionId;
    let failed = 0;
    const importValue = async (value) => {
      if (!value || typeof value !== 'object' || value.missing || !value.assetId || !value.sessionId || value.sessionId === sessionId) return value;
      try {
        const res = await api.importAsset(workflowId, value.sessionId, value.assetId);
        return res.value;
      } catch (_) {
        failed += 1;
        return { ...value, missing: true };
      }
    };
    for (const id of nodeIds) {
      const node = graphLib.getNode(state.graph, id);
      const def = node && state.reg.types.get(node.type);
      if (!def) continue;
      for (const param of def.params) {
        if (param.kind !== 'asset' && param.kind !== 'assets') continue;
        const current = node.params[param.id];
        if (!current || (Array.isArray(current) && !current.length)) continue;
        const next = Array.isArray(current) ? await Promise.all(current.map(importValue)) : await importValue(current);
        if (!state.workflow || state.workflow.id !== workflowId) return;
        if (JSON.stringify(next) !== JSON.stringify(current)) applyParams(id, { [param.id]: next }, { commit: true }, `asset:${id}:${param.id}`);
      }
    }
    if (failed) ui.toast(ui.T('nodes.toast.assetsNotCopied', { count: failed }), { kind: 'warn' });
  }

  function applyParams(nodeId, patch, meta = {}, key) {
    const node = graphLib.getNode(state.graph, nodeId);
    if (!node) return;
    let next = graphLib.setParams(state.graph, nodeId, patch);
    const def = state.reg.types.get(node.type);
    if (def && def.portVariants && Object.prototype.hasOwnProperty.call(patch, def.portVariants.param)) {
      const before = next.edges.length;
      next = graphLib.pruneEdges(state.reg, next, [nodeId]);
      if (next.edges.length !== before) ui.toast(ui.T('nodes.toast.edgesRemoved'), { kind: 'info' });
    }
    // Choosing another Higgsfield model resets the model specific values.
    if (def && Object.prototype.hasOwnProperty.call(patch, 'model') && def.params.some((param) => param.dynamic === 'higgsfield-model') && patch.model !== node.params.model) {
      const reset = {};
      for (const param of def.params) if (param.dynamic === 'higgsfield-model') reset[param.id] = param.default !== undefined ? JSON.parse(JSON.stringify(param.default)) : '';
      if (def.params.some((param) => param.id === 'duration')) reset.duration = null;
      next = graphLib.setParams(next, nodeId, reset);
    }
    applyGraph(next, { history: 'params', key: key || `p:${nodeId}:${Object.keys(patch).join(',')}` });
    // Another model never removes connections; when it takes fewer than the node has, the person is told once.
    if (def && Object.prototype.hasOwnProperty.call(patch, 'model') && patch.model !== node.params.model && def.inputs.some((port) => port.limitBy)) noticeModelLimits(nodeId);
  }

  // Node ids whose new model has not been read yet; the notice follows when its description arrives.
  const limitNotices = new Set();

  // Says once that the connections of a node exceed what its model takes. The connections stay (the node is invalid
  // for the run until they fit, the server refuses the run before anything is paid).
  function noticeModelLimits(nodeId) {
    const node = graphLib.getNode(state.graph, nodeId);
    if (!node || !state.reg) {
      limitNotices.delete(nodeId);
      return;
    }
    const over = graphLib.overLimits(state.reg, state.graph, nodeId);
    if (over.length) {
      limitNotices.delete(nodeId);
      const first = over[0];
      ui.toast(ui.T(first.max === 0 ? 'nodes.toast.modelLimits.none' : 'nodes.toast.modelLimits', { model: first.model, port: ui.portLabel(first.port), count: first.count, max: first.max }), { kind: 'warn', timeout: 7000 });
      return;
    }
    // not known yet: wait for the description of the model, but only when something is connected to such an input
    const usage = graphLib.capabilityUsage(state.reg, state.graph, nodeId);
    const waiting = graphLib.portsFor(state.reg, node).inputs.some((port) => port.limit && !port.limit.known) && Object.values(usage).some((count) => count > 0);
    if (waiting) limitNotices.add(nodeId);
    else limitNotices.delete(nodeId);
  }

  // A model description arrived: cards, inspector (own listener) and plan follow, and a waiting notice is given.
  function onModelCapabilities() {
    if (!state.reg || !runtime.canvas || !state.graph) return;
    runtime.canvas.refreshLimits();
    for (const nodeId of [...limitNotices]) noticeModelLimits(nodeId);
    // the server knows the model now (the description came through it): the plan can judge the connections
    if (runtime.runController && state.workflow) runtime.runController.refreshPlan();
  }

  // Moves the text of an embedded prompt field into its own Prompt node (one undo step).
  function extractPrompt(nodeId, portId) {
    if (!state.workflow || !state.reg) return;
    const result = graphLib.extractTextParamToNode(state.reg, state.graph, nodeId, portId, { sizes: runtime.canvas.getSizes(), reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.T('nodes.prompt.extractFailed'), { kind: 'warn' });
      return;
    }
    reserveId(result.node.id);
    // A prompt field shared in the Design App would vanish (it is now driven by a connection): share the new
    // Prompt node's text instead, with the same label.
    const target = graphLib.getNode(state.graph, nodeId);
    const port = target ? graphLib.portsFor(state.reg, target).inputs.find((item) => item.id === portId) : null;
    if (port && port.param && moveAppInput({ node: nodeId, param: port.param }, { node: result.node.id, param: 'prompt' })) {
      // The app is not part of the undo history: remember the move so that undo / redo carry the exposure along.
      state.appRemaps.push({ from: { node: nodeId, param: port.param }, to: { node: result.node.id, param: 'prompt' } });
      if (state.appRemaps.length > 50) state.appRemaps.shift();
    }
    applyGraph(result.graph, { history: 'extract-prompt' });
  }

  // "Use as text": puts the text result of an output into a new Prompt node and moves the connections of that output to it
  // (one undo step). The person edits the text there; nothing is run. Takes any node with one text result (the song text of
  // the music nodes, a language-model answer …); run.js offers it in the menu of the node and in the inspector.
  function adoptTextResult(nodeId, portId, text) {
    if (!state.workflow || !state.reg) return null;
    const result = graphLib.adoptTextAsPrompt(state.reg, state.graph, nodeId, portId, text, { sizes: runtime.canvas.getSizes(), reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.T('nodes.adopt.failed'), { kind: 'warn' });
      return null;
    }
    reserveId(result.node.id);
    // The new Prompt node drives the target now, so what fed the source no longer reaches the result. Design App inputs
    // that were in that part of the graph stop working: say so instead of leaving the app with the frozen text.
    const cutOff = graphLib.appInputsCutOff(state.graph, result.graph, currentApp());
    applyGraph(result.graph, { history: 'use-as-text' });
    setSelection({ nodes: [result.node.id], notes: [], groups: [], edge: null });
    revealBounds(graphLib.nodeRect(result.node, runtime.canvas.getSizes()));
    ui.toast(ui.T(result.edges.length ? 'nodes.adopt.done' : 'nodes.adopt.doneUnconnected'));
    if (cutOff.length) ui.toast(ui.T('nodes.adopt.appCutOff', { count: cutOff.length }), { kind: 'warn', timeout: 9000 });
    return result;
  }

  // Turns free text in the HTML field of a Motion graphics node into Prompt -> Motion HTML writer -> Motion graphics
  // (one undo step). Nothing is run: the writer is a paid node and asks for confirmation when the user starts the run.
  function convertMotionHtml(nodeId) {
    if (!state.workflow || !state.reg) return;
    const result = graphLib.convertMotionHtmlToWriter(state.reg, state.graph, nodeId, { sizes: runtime.canvas.getSizes(), reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.T('nodes.motion.convertFailed'), { kind: 'warn' });
      return;
    }
    reserveId(result.prompt.id);
    reserveId(result.writer.id);
    for (const edge of result.edges) reserveId(edge.id);
    // An HTML field shared in the Design App would vanish (it is driven by a connection now): share the new Prompt
    // node's text instead, with the same label.
    const app = state.workflow.app;
    if (app && app.inputs.some((entry) => entry.node === nodeId && entry.param === 'html')) {
      moveAppInput({ node: nodeId, param: 'html' }, { node: result.prompt.id, param: 'prompt' });
      // The app is not part of the undo history: remember the move so that undo / redo carry the exposure along.
      state.appRemaps.push({ from: { node: nodeId, param: 'html' }, to: { node: result.prompt.id, param: 'prompt' } });
      if (state.appRemaps.length > 50) state.appRemaps.shift();
    }
    applyGraph(result.graph, { history: 'convert-motion-html' });
    ui.toast(ui.T('nodes.motion.converted'));
  }

  function renameNode(nodeId, title) {
    applyGraph(graphLib.setTitle(state.graph, nodeId, title), { history: 'rename', key: `t:${nodeId}` });
  }

  function connectEdge(from, to, meta = {}) {
    let graph = state.graph;
    if (meta.replaceEdge) graph = graphLib.disconnect(graph, meta.replaceEdge);
    const result = graphLib.connect(state.reg, graph, from, to, { reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.connectText(result.error), { kind: 'warn' });
      return;
    }
    applyGraph(result.graph, { history: 'connect' });
    setSelection({ nodes: [...state.selection.nodes], notes: [...state.selection.notes], groups: [...state.selection.groups], edge: null });
  }

  function groupSelected() {
    if (!state.selection.nodes.size && !state.selection.notes.size) return;
    const result = graphLib.groupSelection(state.graph, runtime.canvas.getSizes(), selectionIds(), { reserved: state.reserved });
    if (!result.group) return;
    applyGraph(result.graph, { history: 'group' });
    setSelection({ nodes: [], notes: [], groups: [result.group.id], edge: null });
  }

  function addNoteAt(world) {
    const out = graphLib.addNote(state.graph, { x: graphLib.snap(world.x, 8), y: graphLib.snap(world.y, 8), reserved: state.reserved });
    applyGraph(out.graph, { history: 'add-note' });
    setSelection({ nodes: [], notes: [out.note.id], groups: [], edge: null });
    requestAnimationFrame(() => {
      const area = runtime.dom.canvasHost.querySelector(`.nv-note[data-id="${out.note.id}"] textarea`);
      if (area) area.focus();
    });
  }

  function moveSelectionBy(dx, dy) {
    if (!hasSelection()) return;
    applyGraph(graphLib.moveItems(state.graph, selectionIds(), dx, dy), { history: 'nudge', key: 'nudge' });
  }

  function selectAll() {
    setSelection({
      nodes: state.graph.nodes.map((node) => node.id),
      notes: state.graph.notes.map((note) => note.id),
      groups: state.graph.groups.map((group) => group.id),
      edge: null
    });
  }

  function undo() {
    const snapshot = state.history.undo();
    if (snapshot) restoreSnapshot(snapshot);
  }

  function redo() {
    const snapshot = state.history.redo();
    if (snapshot) restoreSnapshot(snapshot);
  }

  function restoreSnapshot(snapshot) {
    const next = graphLib.withContent(state.graph, snapshot);
    OCD.inspector.warnApprovalChanges(state.graph, next, state.results, { repeat: true });
    state.graph = next;
    for (const node of next.nodes) reserveId(node.id);
    runtime.canvas.render(next);
    syncAppRemaps();
    pruneApp();
    markDirty();
    updateUndoButtons();
    refreshInspector();
    scheduleAppMarks();
    updateStart();
    bus.emit('graph', state.graph);
  }

  /* ---------- palette ---------- */

  function openPalette(context = {}, filter = null) {
    if (!state.workflow || !state.reg) return;
    const world = context.world || pointerWorld();
    runtime.palette.open({ filter, context: { ...context, world }, at: filter && context.client ? context.client : null });
  }

  function onPalettePick(entry, context, filter) {
    const world = context.world || viewCenter();
    const params = { ...(entry.params || {}), ...((entry.compat && entry.compat.params) || {}) };
    const options = { params, exact: Boolean(context.exact) };
    if (filter && context.anchor) {
      options.anchor = context.anchor;
      options.portType = filter.type;
    }
    addNodeAt(entry.type, { x: world.x - (context.anchor && context.anchor.dir === 'in' ? 300 : 0), y: world.y - 20 }, options);
  }

  // Shift+Enter in the palette: the node with a node in front of each required input, the node itself where it would go.
  function onPalettePickWithInputs(entry, context) {
    const world = context.world || viewCenter();
    insertWithInputs(entry.type, { params: { ...(entry.params || {}), ...((entry.compat && entry.compat.params) || {}) }, world: { x: world.x, y: world.y - 20 } });
  }

  /* ---------- uploads and file drops ---------- */

  async function uploadFile(nodeId, file, options = {}) {
    if (!state.workflow) throw new Error(ui.T('nodes.toast.noWorkflow'));
    const result = await api.upload(state.workflow.id, file, { accept: options.accept, onProgress: options.onProgress });
    return result.value;
  }

  function kindOfFile(file) {
    const type = String(file.type || '');
    const name = String(file.name || '').toLowerCase();
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/.test(name)) return 'image';
    if (type.startsWith('video/') || /\.(mp4|webm|mov)$/.test(name)) return 'video';
    if (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac)$/.test(name)) return 'audio';
    if (type === 'application/pdf' || /\.(pdf|txt|md)$/.test(name)) return 'document';
    return null;
  }

  async function onFilesDropped(files, world) {
    if (!state.workflow) return;
    let offset = 0;
    for (const file of files) {
      const kind = kindOfFile(file);
      if (!kind) {
        ui.toast(ui.T('nodes.toast.unsupportedFile', { name: file.name }), { kind: 'warn' });
        continue;
      }
      const node = addNodeAt(`input.${kind}`, { x: world.x + offset, y: world.y + offset }, { exact: true });
      offset += 40;
      const notice = ui.toast(ui.T('nodes.asset.uploading', { name: file.name, done: 1, total: 1 }), { timeout: 60000 });
      try {
        const value = await uploadFile(node.id, file, { accept: kind });
        notice.remove();
        if (state.workflow && graphLib.getNode(state.graph, node.id)) applyParams(node.id, kind === 'document' ? { assets: [value] } : { asset: value }, { commit: true }, `asset:${node.id}`);
      } catch (error) {
        notice.remove();
        ui.toast(ui.T('nodes.toast.uploadFailed', { name: file.name, error: error.message }), { kind: 'error' });
      }
    }
  }


  Object.assign(runtime, {
    viewCenter, pointerWorld, freeSpot, addNodeAt, deleteSelection, duplicateSelection, copySelection,
    readClipboard, pasteClipboard, rehomeAssets, applyParams, limitNotices, noticeModelLimits,
    onModelCapabilities, extractPrompt, adoptTextResult, convertMotionHtml, renameNode, connectEdge,
    groupSelected, addNoteAt, moveSelectionBy, selectAll, undo, redo, restoreSnapshot, openPalette,
    onPalettePick, onPalettePickWithInputs, uploadFile, kindOfFile, onFilesDropped
  });
})(window);
