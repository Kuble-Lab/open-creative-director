'use strict';

// Registry refresh, hash routing and workflow lifecycle from main.js.
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    state, api, graphLib, ui, refreshInspector, ssSet, SS_RETURN, ssGet, flushSave, loadList, hideBanner,
    bus, lsSet, LS_LAST, normalizeApp, setSelection, setSaveState, sharingFields, reloadListForTeams,
    updateUndoButtons, scheduleAppMarks, hasSelection, lsGet, LS_DRAWER, LS_INSPECTOR, enterConflict,
    updateListEntry, updateAppButton
  } = runtime;
  let checkStillAccessible;
  runtime.connect.push(() => {
    ({ checkStillAccessible } = runtime);
  });

  /* ---------- registry ---------- */

  let registryPromise = null;
  let registryWatcher = null;
  // Option lists that depend on a connection (Higgsfield) and are fetched again when the availability changes.
  const CONNECTION_OPTION_SOURCES = ['higgsfield-image-models', 'higgsfield-video-models', 'higgsfield-voices'];

  function ensureRegistry() {
    if (state.reg) {
      // Coming back to the node view after a while: look for changed availability (throttled, see recheckRegistry).
      recheckRegistry();
      return Promise.resolve(state.reg);
    }
    if (!registryPromise) {
      registryPromise = api
        .registry()
        .then((payload) => {
          state.registry = payload;
          state.reg = graphLib.indexRegistry(payload, { limitsFor: ui.limitsFor });
          state.registryError = null;
          runtime.canvas.setRegistry(state.reg);
          registryWatcher = graphLib.createRegistryWatcher({ load: () => api.registry(), apply: applyFreshRegistry });
          registryWatcher.prime(payload);
          return state.reg;
        })
        .catch((error) => {
          registryPromise = null;
          state.registryError = error.message;
          throw error;
        });
    }
    return registryPromise;
  }

  // The availability of nodes changed on the server (a key set up, Higgsfield connected in another tab): palette,
  // inspector and cards show the new state and the model lists are fetched again.
  function applyFreshRegistry(payload) {
    const previous = state.reg;
    state.registry = payload;
    state.reg = graphLib.indexRegistry(payload, { limitsFor: ui.limitsFor });
    // Only what depends on a type that changed is rebuilt: a card or the inspector the person is typing in stays.
    const changed = new Set();
    for (const def of state.reg.list) {
      const before = previous && previous.types.get(def.type);
      if (!before || before.available !== def.available || before.restricted !== def.restricted) changed.add(def.type);
    }
    if (runtime.canvas) {
      runtime.canvas.setRegistry(state.reg);
      if (state.graph) runtime.canvas.render(state.graph);
    }
    if (runtime.appView) runtime.appView.setRegistry(state.reg);
    for (const source of CONNECTION_OPTION_SOURCES) ui.refreshOptions(source);
    ui.refreshModelDetails();
    if (runtime.palette) runtime.palette.refresh();
    if (runtime.runController) runtime.runController.relabel();
    if (runtime.inspector) {
      const selected = state.graph ? [...(state.selection?.nodes || [])].map((id) => graphLib.getNode(state.graph, id)).filter(Boolean) : [];
      if (selected.some((node) => changed.has(node.type))) refreshInspectorWhenIdle();
    }
  }

  // Renders the inspector again, but not under the person's cursor: while a field of the inspector has the focus
  // it waits for the focus to leave.
  function refreshInspectorWhenIdle() {
    const host = runtime.dom && runtime.dom.inspectorScroll;
    const active = document.activeElement;
    if (!host || !active || active === document.body || !host.contains(active)) {
      refreshInspector(true);
      return;
    }
    host.addEventListener('focusout', () => setTimeout(() => refreshInspector(true), 0), { once: true });
  }

  // Only when the person comes back to the page (tab visible again, window focused) or opens the view again, never
  // in the background; the watcher keeps at least 15 s between two requests.
  function recheckRegistry() {
    if (!state.active || !state.reg || !registryWatcher) return;
    registryWatcher.check();
  }

  // A branding (or another setting a node reads) may have been changed elsewhere, in the chat or in another tab, while this page was in the
  // background: the plan is asked again when the page comes back, so the cards show what is out of date. Not more often than every 5 s.
  let lastPlanCheck = 0;
  function recheckPlan() {
    if (!state.active || !state.workflow || !runtime.runController) return;
    const now = Date.now();
    if (now - lastPlanCheck < 5000) return;
    lastPlanCheck = now;
    runtime.runController.refreshPlan();
  }

  /* ---------- routing ---------- */

  function parseHash() {
    const params = new URLSearchParams(global.location.hash.replace(/^#/, ''));
    if (params.has('w')) return { view: 'editor', id: (params.get('w') || '').trim() };
    if (params.has('app')) return { view: 'app', id: (params.get('app') || '').trim() };
    return null;
  }

  function rememberReturnHash(hash) {
    if (/^#s=/.test(hash || '')) ssSet(SS_RETURN, hash);
  }

  function navigate(id) {
    const hash = id ? `#w=${encodeURIComponent(id)}` : '#w=';
    if (global.location.hash === hash) {
      route();
      return;
    }
    global.location.hash = hash;
  }

  function leaveToChat() {
    const back = ssGet(SS_RETURN) || '';
    flushSave({ keepalive: true }).catch(() => {});
    if (back) {
      global.location.hash = back;
    } else {
      nativeReplaceState(null, '', `${global.location.pathname}${global.location.search}`);
      route();
    }
  }

  function setActive(active) {
    state.active = active;
    runtime.dom.root.classList.toggle('hidden', !active);
    document.documentElement.classList.toggle('nv-active', active);
    // The chat stays rendered below the overlay. While the node view is open it must not take focus or keys
    // (a late focus() of app.js on the chat input would otherwise receive typing and send it as a message).
    const chat = document.querySelector('body > .app');
    if (chat) {
      if (active) {
        chat.setAttribute('inert', '');
        const focused = document.activeElement;
        if (focused && focused !== document.body && chat.contains(focused)) focused.blur();
        if (runtime.dom.canvasHost) runtime.dom.canvasHost.focus({ preventScroll: true });
      } else {
        chat.removeAttribute('inert');
        const input = document.getElementById('input');
        if (input) input.focus({ preventScroll: true });
      }
    }
  }

  // The Design App view replaces topbar and editor body inside the same layer (#app=<id>).
  function setAppMode(on) {
    runtime.dom.root.classList.toggle('is-appview', on);
    runtime.dom.appView.classList.toggle('hidden', !on);
    if (!on && runtime.appView) runtime.appView.close();
  }

  async function route() {
    const target = parseHash();
    if (!target || (target.view !== 'editor' && target.view !== 'app')) {
      if (state.active) {
        flushSave({ keepalive: true }).catch(() => {});
        setActive(false);
        closeEvents();
        setAppMode(false);
      }
      return;
    }
    const activating = !state.active;
    if (activating) setActive(true);
    if (target.view === 'app') {
      try {
        await ensureRegistry();
      } catch (error) {
        setAppMode(true);
        runtime.appView.showError(ui.T('nodes.stage.registryError', { error: error.message }));
        return;
      }
      await closeWorkflow();
      if (parseHash() && parseHash().view === 'app') {
        setAppMode(true);
        runtime.appView.open(target.id, state.reg);
      }
      return;
    }
    setAppMode(false);
    try {
      await ensureRegistry();
    } catch (error) {
      showStageMessage('error', ui.T('nodes.stage.registryError', { error: error.message }));
      return;
    }
    if (activating || !state.listLoaded) loadList();
    if (target.id) {
      if (!state.workflow || state.workflow.id !== target.id) {
        await loadWorkflow(target.id);
      } else {
        // Coming back from the chat: the workflow is still loaded, only the stream needs to be reopened.
        if (!state.events) {
          openEvents(target.id);
          reconcile();
        }
        runtime.canvas.relayout();
      }
    } else {
      await closeWorkflow();
      showListView();
    }
  }

  /* ---------- stage states ---------- */

  function showStageMessage(kind, text) {
    runtime.dom.empty.classList.remove('hidden');
    runtime.dom.empty.dataset.kind = kind;
    runtime.dom.emptyTitle.textContent = text;
    runtime.dom.emptyBody.textContent = '';
    runtime.dom.emptyButton.classList.add('hidden');
    runtime.dom.emptyTemplate.classList.add('hidden');
  }

  function showListView() {
    runtime.dom.stage.classList.add('is-empty');
    runtime.dom.empty.classList.remove('hidden');
    runtime.dom.empty.dataset.kind = 'list';
    runtime.dom.emptyTitle.textContent = ui.T('nodes.stage.emptyTitle');
    runtime.dom.emptyBody.textContent = ui.T('nodes.stage.emptyBody');
    runtime.dom.emptyButton.classList.remove('hidden');
    runtime.dom.emptyTemplate.classList.remove('hidden');
    setDrawer(true, { remember: false });
    updateChrome();
  }

  function hideEmpty() {
    runtime.dom.stage.classList.remove('is-empty');
    runtime.dom.empty.classList.add('hidden');
  }

  /* ---------- open / close workflow ---------- */

  function closeEvents() {
    if (state.events) {
      state.events.close();
      state.events = null;
    }
  }

  async function closeWorkflow() {
    if (!state.workflow) return;
    await flushSave().catch(() => {});
    closeEvents();
    clearTimeout(state.saveTimer);
    clearTimeout(state.retryTimer);
    state.workflow = null;
    state.graph = graphLib.emptyGraph();
    state.results = null;
    state.conflict = null;
    state.dirtyContent = false;
    state.dirtyViewport = false;
    state.history.clear();
    state.appRemaps = [];
    runtime.canvas.clearSlots();
    runtime.canvas.render(state.graph);
    hideBanner();
    updateChrome();
    bus.emit('workflow:close');
    runtime.workflowList.setData({ activeId: null });
  }

  async function loadWorkflow(id, options = {}) {
    const token = ++state.loadToken;
    if (!options.force && state.workflow) await closeWorkflow();
    hideEmpty();
    runtime.dom.stage.classList.add('is-loading');
    let payload;
    try {
      payload = await api.getWorkflow(id);
    } catch (error) {
      if (token !== state.loadToken) return;
      runtime.dom.stage.classList.remove('is-loading');
      if (error.code === 'LOGIN_UNCONFIRMED') {
        // Not a missing workflow: the banner asks for a reload, the last opened workflow stays remembered.
        state.workflow = null;
        return;
      }
      ui.toast(error.status === 404 ? ui.T('nodes.toast.notFound') : ui.T('nodes.toast.loadFailed', { error: error.message }), { kind: 'error' });
      lsSet(LS_LAST, null);
      state.workflow = null;
      navigate('');
      return;
    }
    if (token !== state.loadToken) return;
    closeEvents();
    state.workflow = payload.workflow;
    state.workflow.app = normalizeApp(payload.workflow.app);
    state.rev = payload.workflow.rev;
    state.results = payload.results;
    state.conflict = null;
    state.dirtyContent = false;
    state.dirtyViewport = false;
    state.reserved = new Set(Object.keys((payload.results && payload.results.nodes) || {}));
    const graph = graphLib.normalizeLoaded(payload.workflow.graph);
    for (const node of graph.nodes) state.reserved.add(node.id);
    state.graph = graph;
    state.history.reset(graphLib.content(graph));
    state.appRemaps = [];
    runtime.canvas.clearSlots();
    setSelection({ nodes: [], notes: [], groups: [], edge: null });
    runtime.canvas.render(graph, { selection: { nodes: new Set(), notes: new Set(), groups: new Set(), edge: null } });
    const hasViewport = payload.workflow.graph && payload.workflow.graph.viewport && (payload.workflow.graph.viewport.x !== 0 || payload.workflow.graph.viewport.y !== 0 || payload.workflow.graph.viewport.zoom !== 1);
    runtime.dom.stage.classList.remove('is-loading');
    if (hasViewport) runtime.canvas.setViewport(graph.viewport, { silent: true });
    else if (graph.nodes.length) {
      makeRoomForFit();
      requestAnimationFrame(() => fitAfterMeasure());
    }
    else {
      // On a phone the panels would cover the start of an empty workflow.
      if (global.innerWidth < 900) makeRoomForFit();
      runtime.canvas.setViewport({ x: runtime.canvas.containerSize().width / 2 - 160, y: runtime.canvas.containerSize().height / 2 - 120, zoom: 1 }, { silent: true });
    }
    setSaveState('saved');
    hideBanner();
    runtime.dom.name.value = state.workflow.name;
    lsSet(LS_LAST, id);
    if (state.listLoaded && !state.workflows.some((item) => item.id === id)) {
      const wf = payload.workflow;
      state.workflows.unshift({ id: wf.id, name: wf.name, folder: wf.folder || null, updatedAt: wf.updatedAt, updatedBy: wf.updatedBy || null, nodeCount: graph.nodes.length, app: { enabled: Boolean(wf.app && wf.app.enabled) }, ...sharingFields(wf) });
      runtime.workflowList.setData({ workflows: state.workflows });
      reloadListForTeams();
    }
    runtime.workflowList.setData({ activeId: id });
    updateChrome();
    updateUndoButtons();
    refreshInspector(true);
    scheduleAppMarks();
    openEvents(id);
    bus.emit('workflow:open', { workflow: state.workflow, results: state.results, activeRun: payload.activeRun || null });
    if (!hasSelection()) runtime.canvas.relayout();
  }

  // On narrower windows the side panels would squeeze a freshly opened workflow to an unreadable zoom:
  // close them for the initial fit unless the user asked for them explicitly. The inspector comes back on selection.
  function makeRoomForFit() {
    if (global.innerWidth >= 1600) return;
    if (state.drawerOpen && lsGet(LS_DRAWER) !== '1') setDrawer(false, { remember: false });
    if (state.inspectorOpen && lsGet(LS_INSPECTOR) !== '1' && !hasSelection()) {
      setInspector(false, { remember: false });
      state.inspectorAutoClosed = true;
    }
  }

  // Runs `callback` once the cards have been measured and the side panels stopped animating (their grid
  // transition would otherwise leave the canvas wider than it ends up).
  function whenLayoutSettled(callback) {
    const started = performance.now();
    const settle = () => {
      const animating = runtime.dom.body.getAnimations ? runtime.dom.body.getAnimations().some((animation) => animation.playState === 'running') : false;
      if (animating && performance.now() - started < 700) {
        requestAnimationFrame(settle);
        return;
      }
      requestAnimationFrame(callback);
    };
    requestAnimationFrame(settle);
  }

  function fitAfterMeasure() {
    whenLayoutSettled(() => {
      runtime.canvas.fit({ padding: 48 });
      state.graph = { ...state.graph, viewport: runtime.canvas.getViewport() };
    });
  }

  function openEvents(id) {
    closeEvents();
    state.events = api.openEvents(id, {
      onEvent: (event) => {
        if (!state.workflow || state.workflow.id !== id) return;
        if (event.type === 'workflow_saved') handleExternalSave(event);
        if (event.type === 'workflow_renamed') handleExternalRename(event);
        bus.emit('sse', event);
      },
      onError: () => {
        state.sseBroken = true;
        checkStillAccessible();
      },
      onOpen: () => {
        if (state.sseBroken) {
          state.sseBroken = false;
          reconcile();
        }
      }
    });
  }

  async function reconcile() {
    if (!state.workflow) return;
    try {
      const payload = await api.getWorkflow(state.workflow.id);
      state.results = payload.results;
      if (payload.workflow.rev > state.rev) handleExternalSave({ rev: payload.workflow.rev, updatedBy: payload.workflow.updatedBy });
      bus.emit('reconcile', { workflow: payload.workflow, results: payload.results, activeRun: payload.activeRun || null });
    } catch (_) {
      /* the browser reconnects the stream on its own */
    }
  }

  async function handleExternalSave(event) {
    // Our own save also arrives here (sometimes before the PUT response): wait for it first.
    if (state.savePromise && state.saving) await state.savePromise.catch(() => {});
    if (!state.workflow || typeof event.rev !== 'number' || event.rev <= state.rev || state.conflict) return;
    enterConflict('external', event.rev);
  }

  // Another tab or the API renamed / moved this workflow: take over the name and folder (the autosave never sends them).
  function handleExternalRename(event) {
    if (!state.workflow || typeof event.name !== 'string' || !event.name) return;
    state.workflow.name = event.name;
    state.workflow.folder = event.folder || null;
    if (runtime.dom && global.document.activeElement !== runtime.dom.name) runtime.dom.name.value = event.name;
    updateListEntry(state.workflow.id, { name: event.name, folder: event.folder || null });
  }

  /* ---------- chrome updates ---------- */

  function updateChrome() {
    if (!runtime.dom) return;
    const has = Boolean(state.workflow);
    runtime.dom.name.disabled = !has;
    runtime.dom.name.classList.toggle('hidden', !has);
    runtime.dom.saveState.classList.toggle('hidden', !has);
    runtime.dom.addNode.disabled = !has;
    runtime.dom.undo.disabled = !has || !state.history.canUndo();
    runtime.dom.redo.disabled = !has || !state.history.canRedo();
    runtime.dom.toolbar.classList.toggle('hidden', !has);
    runtime.dom.minimap.classList.toggle('hidden', !has);
    runtime.dom.menuBtn.classList.toggle('hidden', !has);
    updateAccessChrome();
    updateAppButton();
    runtime.dom.inspectorToggle.classList.toggle('hidden', !has);
    runtime.dom.assistantBtn.classList.toggle('hidden', !has);
    runtime.dom.stage.classList.toggle('is-empty', !has);
    runtime.dom.body.classList.toggle('no-workflow', !has);
    if (!has) runtime.dom.name.value = '';
    updateStart();
    updateZoomLabel();
  }

  // The start in the middle of an open workflow without nodes; it goes as soon as there is a node.
  function updateStart() {
    if (!runtime.dom) return;
    runtime.dom.start.classList.toggle('hidden', !(state.workflow && state.graph.nodes.length === 0));
  }

  // User management (only with AUTH_WHOAMI_URL): owner in the header, share button, read-only name for others.
  function updateAccessChrome() {
    if (!runtime.dom) return;
    const access = global.OCAccess;
    const workflow = state.workflow;
    const active = Boolean(access && access.isActive() && workflow);
    runtime.dom.owner.textContent = '';
    const chip = active ? access.ownerChip(workflow) : null;
    if (chip) runtime.dom.owner.append(chip);
    runtime.dom.owner.classList.toggle('hidden', !chip);
    const canShare = active && workflow.canShare === true;
    runtime.dom.shareBtn.classList.toggle('hidden', !canShare);
    if (canShare) {
      const shared = !workflow.unowned && workflow.shareMode !== 'private';
      runtime.dom.shareBtn.classList.toggle('is-shared', shared);
      const label = `${ui.T('nodes.share.buttonTitle')} · ${access.stateText(workflow)}`;
      runtime.dom.shareBtn.title = label;
      runtime.dom.shareBtn.setAttribute('aria-label', label);
    }
    runtime.dom.name.readOnly = Boolean(active && workflow.canManage === false);
  }

  function updateZoomLabel() {
    if (!runtime.dom || !runtime.canvas) return;
    runtime.dom.zoomLabel.textContent = `${Math.round(runtime.canvas.getViewport().zoom * 100)}%`;
  }

  function setDrawer(open, options = {}) {
    state.drawerOpen = open;
    runtime.dom.body.classList.toggle('drawer-closed', !open);
    runtime.dom.drawerToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (options.remember !== false) lsSet(LS_DRAWER, open ? '1' : '0');
    setTimeout(() => runtime.canvas && runtime.canvas.relayout(), 220);
  }

  function setInspector(open, options = {}) {
    state.inspectorOpen = open;
    if (options.remember !== false || open) state.inspectorAutoClosed = false;
    runtime.dom.body.classList.toggle('inspector-closed', !open);
    runtime.dom.inspectorToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (options.remember !== false) lsSet(LS_INSPECTOR, open ? '1' : '0');
    if (open) refreshInspector(true);
    setTimeout(() => runtime.canvas && runtime.canvas.relayout(), 220);
  }

  function setTool(tool) {
    state.tool = tool;
    runtime.canvas.setTool(tool);
    runtime.dom.toolSelect.classList.toggle('is-active', tool === 'select');
    runtime.dom.toolHand.classList.toggle('is-active', tool === 'hand');
    runtime.dom.toolSelect.setAttribute('aria-pressed', tool === 'select' ? 'true' : 'false');
    runtime.dom.toolHand.setAttribute('aria-pressed', tool === 'hand' ? 'true' : 'false');
  }

  const nativeReplaceState = history.replaceState.bind(history);


  Object.assign(runtime, {
    CONNECTION_OPTION_SOURCES, ensureRegistry, applyFreshRegistry, refreshInspectorWhenIdle,
    recheckRegistry, recheckPlan, parseHash, rememberReturnHash, navigate, leaveToChat, setActive,
    setAppMode, route, showStageMessage, showListView, hideEmpty, closeEvents, closeWorkflow,
    loadWorkflow, makeRoomForFit, whenLayoutSettled, fitAfterMeasure, openEvents, reconcile,
    handleExternalSave, handleExternalRename, updateChrome, updateStart, updateAccessChrome,
    updateZoomLabel, setDrawer, setInspector, setTool, nativeReplaceState
  });
})(window);
