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
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const historyLib = OCD.history;
  const api = OCD.api;
  const ui = OCD.ui;
  const { el } = ui;

  const LS_LAST = 'ocd-nodes-last';
  const LS_CLIPBOARD = 'ocd-nodes-clipboard';
  const LS_DRAWER = 'ocd-nodes-drawer';
  const LS_INSPECTOR = 'ocd-nodes-inspector';
  const SS_RETURN = 'ocd-nodes-return';
  const SAVE_DELAY = 800;
  const VIEWPORT_SAVE_DELAY = 1600;
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const PASTE_OFFSET = 32;

  /* ---------- tiny event bus (extension point) ---------- */

  const listeners = new Map();
  const bus = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) || []) {
        try {
          fn(payload);
        } catch (error) {
          console.error(`nodes bus handler for ${name} failed`, error);
        }
      }
    }
  };
  const extensions = { nodeMenu: [], canvasMenu: [], workflowMenu: [], topbar: [] };

  /* ---------- storage helpers ---------- */

  function lsGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      if (value === null) global.localStorage.removeItem(key);
      else global.localStorage.setItem(key, value);
    } catch (_) {
      /* storage may be unavailable */
    }
  }

  function ssGet(key) {
    try {
      return global.sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function ssSet(key, value) {
    try {
      if (value === null) global.sessionStorage.removeItem(key);
      else global.sessionStorage.setItem(key, value);
    } catch (_) {
      /* storage may be unavailable */
    }
  }

  /* ---------- state ---------- */

  const state = {
    active: false,
    registry: null,
    reg: null,
    registryError: null,
    workflow: null,
    graph: graphLib.emptyGraph(),
    results: null,
    rev: 0,
    selection: { nodes: new Set(), notes: new Set(), groups: new Set(), edge: null },
    history: historyLib.createHistory(),
    workflows: [],
    listLoaded: false,
    listError: null,
    saveState: 'saved',
    dirtyContent: false,
    dirtyViewport: false,
    saving: false,
    savePromise: null,
    saveTimer: null,
    retryTimer: null,
    retryDelay: 2000,
    conflict: null,
    reserved: new Set(),
    clipboard: null,
    events: null,
    loadToken: 0,
    drawerOpen: true,
    inspectorOpen: true,
    inspectorAutoClosed: false,
    tool: 'select'
  };

  let dom = null;
  let canvas = null;
  let palette = null;
  let inspector = null;
  let workflowList = null;
  let runController = null;
  let appView = null;
  let booted = false;

  /* ---------- selection helpers ---------- */

  function selectionIds() {
    return { nodes: [...state.selection.nodes], notes: [...state.selection.notes], groups: [...state.selection.groups] };
  }

  function hasSelection() {
    return state.selection.nodes.size + state.selection.notes.size + state.selection.groups.size > 0;
  }

  function setSelection(next) {
    canvas.setSelection(next);
  }

  /* ---------- Design App state (workflow.app) ---------- */

  const MAX_APP_ENTRIES = 100;

  function emptyApp() {
    return { enabled: false, title: '', description: '', inputs: [], outputs: [] };
  }

  // workflow.app with all fields present (older documents and imports may lack some).
  function normalizeApp(raw) {
    const app = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: app.enabled === true,
      title: typeof app.title === 'string' ? app.title : '',
      description: typeof app.description === 'string' ? app.description : '',
      inputs: Array.isArray(app.inputs) ? app.inputs.filter((entry) => entry && typeof entry.node === 'string' && typeof entry.param === 'string').map((entry) => ({ node: entry.node, param: entry.param, label: typeof entry.label === 'string' ? entry.label : '' })) : [],
      outputs: Array.isArray(app.outputs) ? app.outputs.filter((entry) => entry && typeof entry.node === 'string').map((entry) => ({ node: entry.node, label: typeof entry.label === 'string' ? entry.label : '' })) : []
    };
  }

  function currentApp() {
    return state.workflow ? state.workflow.app || emptyApp() : emptyApp();
  }

  // Drops exposures of nodes that no longer exist (the server does the same on save).
  function pruneApp() {
    if (!state.workflow || !state.workflow.app) return;
    const ids = new Set(state.graph.nodes.map((node) => node.id));
    const app = state.workflow.app;
    const inputs = app.inputs.filter((entry) => ids.has(entry.node));
    const outputs = app.outputs.filter((entry) => ids.has(entry.node));
    if (inputs.length !== app.inputs.length || outputs.length !== app.outputs.length) {
      state.workflow.app = { ...app, inputs, outputs };
      updateAppButton();
    }
  }

  // Marks cards that take part in the Design App ('input', 'output', 'both').
  let appMarkFrame = 0;
  function scheduleAppMarks() {
    if (appMarkFrame) return;
    appMarkFrame = requestAnimationFrame(() => {
      appMarkFrame = 0;
      if (!dom) return;
      const app = currentApp();
      const marks = new Map();
      for (const entry of app.inputs) marks.set(entry.node, 'input');
      for (const entry of app.outputs) marks.set(entry.node, marks.get(entry.node) === 'input' ? 'both' : 'output');
      for (const card of dom.canvasHost.querySelectorAll('.nv-node')) {
        const cardState = ui.getCardState(card);
        if (cardState) ui.setAppMark(cardState, marks.get(card.dataset.id) || null);
      }
    });
  }

  function updateAppButton() {
    if (!dom) return;
    const app = currentApp();
    const on = Boolean(state.workflow) && app.enabled;
    dom.appBtn.classList.toggle('is-on', on);
    dom.appBtn.classList.toggle('hidden', !state.workflow);
    dom.appBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function changeApp(patch, options = {}) {
    if (!state.workflow) return;
    state.workflow.app = { ...currentApp(), ...patch };
    markDirty();
    updateAppButton();
    scheduleAppMarks();
    if (options.rebuild !== false) refreshInspector(true);
  }

  function defaultInputLabel(node, paramId) {
    const def = state.reg.types.get(node.type);
    if (node.title) return node.title;
    if (def && def.category === 'input') return ui.typeLabel(def);
    return ui.paramLabel(paramId);
  }

  function toggleAppInput(nodeId, paramId) {
    const app = currentApp();
    const index = app.inputs.findIndex((entry) => entry.node === nodeId && entry.param === paramId);
    if (index >= 0) {
      changeApp({ inputs: app.inputs.filter((_, i) => i !== index) });
      return;
    }
    const node = graphLib.getNode(state.graph, nodeId);
    if (!node) return;
    if (app.inputs.length >= MAX_APP_ENTRIES) {
      ui.toast(ui.T('nodes.app.tooMany'), { kind: 'warn' });
      return;
    }
    changeApp({ inputs: [...app.inputs, { node: nodeId, param: paramId, label: defaultInputLabel(node, paramId) }], enabled: true });
  }

  function toggleAppOutput(nodeId) {
    const app = currentApp();
    const index = app.outputs.findIndex((entry) => entry.node === nodeId);
    if (index >= 0) {
      changeApp({ outputs: app.outputs.filter((_, i) => i !== index) });
      return;
    }
    const node = graphLib.getNode(state.graph, nodeId);
    if (!node) return;
    if (app.outputs.length >= MAX_APP_ENTRIES) {
      ui.toast(ui.T('nodes.app.tooMany'), { kind: 'warn' });
      return;
    }
    const def = state.reg.types.get(node.type);
    changeApp({ outputs: [...app.outputs, { node: nodeId, label: String(node.params.label || node.title || (def ? ui.typeLabel(def) : '')).trim() }], enabled: true });
  }

  function moveAppEntry(kind, index, delta) {
    const list = currentApp()[kind].slice();
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    changeApp({ [kind]: list });
  }

  function appApi() {
    return {
      get: currentApp,
      signature(nodeId) {
        const app = currentApp();
        if (nodeId) return `${app.enabled ? 1 : 0}:${app.inputs.filter((entry) => entry.node === nodeId).map((entry) => entry.param).join(',')}:${app.outputs.some((entry) => entry.node === nodeId) ? 'o' : ''}`;
        return `${app.enabled ? 1 : 0}|${app.inputs.map((entry) => `${entry.node}.${entry.param}`).join(',')}|${app.outputs.map((entry) => entry.node).join(',')}`;
      },
      isExposed: (nodeId, paramId) => currentApp().inputs.some((entry) => entry.node === nodeId && entry.param === paramId),
      isOutput: (nodeId) => currentApp().outputs.some((entry) => entry.node === nodeId),
      toggleInput: toggleAppInput,
      toggleOutput: toggleAppOutput,
      setEnabled: (enabled) => changeApp({ enabled }),
      setMeta: (patch) => changeApp(patch, { rebuild: false }),
      setLabel(kind, index, label) {
        const list = currentApp()[kind].slice();
        if (!list[index]) return;
        list[index] = { ...list[index], label };
        changeApp({ [kind]: list }, { rebuild: false });
      },
      move: moveAppEntry,
      remove(kind, index) {
        changeApp({ [kind]: currentApp()[kind].filter((_, i) => i !== index) });
      },
      focusNode(nodeId) {
        const node = graphLib.getNode(state.graph, nodeId);
        if (!node) return;
        setSelection({ nodes: [nodeId], notes: [], groups: [], edge: null });
        canvas.centerOnWorld(node.x + 148, node.y + 60);
      },
      open: openAppView,
      copyLink: copyAppLink
    };
  }

  async function openAppView() {
    if (!state.workflow) return;
    const id = state.workflow.id;
    await flushSave().catch(() => {});
    if (state.conflict || state.saveState === 'offline') {
      ui.toast(ui.T('nodes.run.conflict'), { kind: 'warn' });
      return;
    }
    global.location.hash = `#app=${encodeURIComponent(id)}`;
  }

  async function copyAppLink() {
    if (!state.workflow) return;
    const url = new URL(`#app=${encodeURIComponent(state.workflow.id)}`, `${global.location.origin}${global.location.pathname}`).href;
    const ok = OCD.preview ? await OCD.preview.copyText(url) : false;
    ui.toast(ok ? ui.T('nodes.app.linkCopied') : ui.T('nodes.preview.copyFailed'), { kind: ok ? undefined : 'warn' });
  }

  function appButtonMenu() {
    if (!state.workflow) return;
    const app = currentApp();
    const rect = dom.appBtn.getBoundingClientRect();
    const ready = app.enabled && app.inputs.length > 0 && app.outputs.length > 0;
    ui.menu(rect.right - 230, rect.bottom + 6, [
      { label: ui.T('nodes.app.open'), icon: 'external', disabled: !ready, onClick: openAppView },
      { label: ui.T(app.enabled ? 'nodes.app.disable' : 'nodes.app.enable'), icon: 'app', onClick: () => changeApp({ enabled: !app.enabled }) },
      { label: ui.T('nodes.app.edit'), icon: 'edit', onClick: showAppPanel },
      { label: ui.T('nodes.app.copyLink'), icon: 'link', disabled: !app.enabled, onClick: copyAppLink }
    ]);
  }

  // Shows the workflow level inspector (with the App panel).
  function showAppPanel() {
    setSelection({ nodes: [], notes: [], groups: [], edge: null });
    if (!state.inspectorOpen) setInspector(true, { remember: false });
    refreshInspector(true);
    requestAnimationFrame(() => {
      const panel = dom.inspectorScroll.querySelector('.nv-app-panel');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  /* ---------- graph mutation ---------- */

  function updateUndoButtons() {
    if (!dom) return;
    dom.undo.disabled = !state.history.canUndo();
    dom.redo.disabled = !state.history.canRedo();
  }

  function refreshInspector(force) {
    if (!inspector || !state.workflow) return;
    inspector.render(
      {
        graph: state.graph,
        selection: state.selection,
        workflow: state.workflow
      },
      { force }
    );
  }

  // Applies a new graph. meta: { history: label|false, key: coalesceKey, render: bool }.
  function applyGraph(next, meta = {}) {
    state.graph = next;
    if (meta.render !== false) canvas.render(next);
    if (meta.history !== false) {
      state.history.commit(graphLib.content(next), { label: meta.history || '', coalesceKey: meta.key });
      updateUndoButtons();
    }
    pruneApp();
    markDirty();
    refreshInspector();
    scheduleAppMarks();
    bus.emit('graph', state.graph);
  }

  function markDirty() {
    state.dirtyContent = true;
    if (state.saveState !== 'conflict') setSaveState(state.saving ? 'saving' : 'dirty');
    scheduleSave(SAVE_DELAY);
  }

  function reserveId(id) {
    state.reserved.add(id);
  }

  /* ---------- save state and autosave ---------- */

  function setSaveState(next) {
    state.saveState = next;
    if (!dom) return;
    const label = { saved: 'nodes.save.saved', saving: 'nodes.save.saving', dirty: 'nodes.save.dirty', offline: 'nodes.save.offline', conflict: 'nodes.save.conflict' }[next];
    dom.saveState.textContent = ui.T(label);
    dom.saveState.dataset.state = next;
    dom.saveState.classList.toggle('hidden', !state.workflow);
  }

  function scheduleSave(delay) {
    if (!state.workflow || state.conflict) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      flushSave().catch(() => {});
    }, delay);
  }

  const KEEPALIVE_MAX_CHARS = 60000;

  function savePayload() {
    return {
      baseRev: state.rev,
      graph: {
        nodes: state.graph.nodes,
        edges: state.graph.edges,
        groups: state.graph.groups,
        notes: state.graph.notes,
        viewport: state.graph.viewport
      },
      description: state.workflow.description || '',
      app: currentApp()
    };
  }

  async function flushSave(options = {}) {
    clearTimeout(state.saveTimer);
    if (!state.workflow || state.conflict) return null;
    if (state.saving) {
      // A save is in flight: chain another one right after it so nothing is lost.
      await state.savePromise.catch(() => {});
      if (!state.dirtyContent && !state.dirtyViewport) return null;
      return flushSave(options);
    }
    if (!state.dirtyContent && !state.dirtyViewport) return null;
    const wf = state.workflow;
    const hadContent = state.dirtyContent;
    state.dirtyContent = false;
    state.dirtyViewport = false;
    state.saving = true;
    if (hadContent) setSaveState('saving');
    state.savePromise = (async () => {
      try {
        const payload = savePayload();
        // Browsers refuse keepalive requests above 64 KiB; a big graph then uses a normal request.
        const keepalive = Boolean(options.keepalive) && JSON.stringify(payload).length < KEEPALIVE_MAX_CHARS;
        const result = await api.saveWorkflow(wf.id, payload, { keepalive });
        if (state.workflow && state.workflow.id === wf.id) {
          state.rev = result.rev;
          wf.rev = result.rev;
          wf.updatedAt = result.updatedAt;
          state.retryDelay = 2000;
          if (state.saveState !== 'conflict') setSaveState(state.dirtyContent ? 'dirty' : 'saved');
          if (hadContent) updateListEntry(wf.id, { updatedAt: result.updatedAt, nodeCount: state.graph.nodes.length });
        }
        bus.emit('saved', { workflowId: wf.id, rev: result.rev });
      } catch (error) {
        if (state.workflow && state.workflow.id === wf.id) {
          state.dirtyContent = state.dirtyContent || hadContent;
          state.dirtyViewport = true;
          if (error.status === 409 || error.code === 'REV_CONFLICT') {
            enterConflict('save', error.rev);
          } else if (error.status === 400 || error.status === 404) {
            state.dirtyContent = false;
            state.dirtyViewport = false;
            setSaveState('conflict');
            showBanner({ kind: 'error', text: ui.T('nodes.banner.saveRejected', { error: error.message }), actions: [{ label: ui.T('nodes.banner.reload'), onClick: () => reloadWorkflow() }] });
          } else {
            setSaveState('offline');
            clearTimeout(state.retryTimer);
            state.retryTimer = setTimeout(() => scheduleSave(0), state.retryDelay);
            state.retryDelay = Math.min(state.retryDelay * 2, 30000);
          }
        }
        throw error;
      } finally {
        state.saving = false;
      }
    })();
    return state.savePromise;
  }

  /* ---------- conflict banner ---------- */

  function showBanner({ kind, text, actions }) {
    dom.banner.textContent = '';
    dom.banner.className = `nv-banner is-${kind || 'info'}`;
    dom.banner.append(ui.icon('warning', 16), el('span', { class: 'nv-banner-text', text }));
    for (const action of actions || []) {
      const button = el('button', { type: 'button', class: `nv-btn nv-btn-sm ${action.primary ? 'nv-btn-primary' : ''}`.trim(), text: action.label });
      button.addEventListener('click', action.onClick);
      dom.banner.append(button);
    }
  }

  function hideBanner() {
    dom.banner.className = 'nv-banner hidden';
    dom.banner.textContent = '';
  }

  function enterConflict(source, serverRev) {
    state.conflict = { source, rev: serverRev };
    clearTimeout(state.saveTimer);
    setSaveState('conflict');
    showBanner({
      kind: 'warn',
      text: ui.T('nodes.banner.conflict'),
      actions: [
        { label: ui.T('nodes.banner.reload'), onClick: () => reloadWorkflow() },
        { label: ui.T('nodes.banner.overwrite'), primary: true, onClick: () => overwriteConflict() }
      ]
    });
  }

  async function overwriteConflict() {
    if (!state.workflow || !state.conflict) return;
    try {
      const latest = await api.getWorkflow(state.workflow.id);
      state.rev = latest.workflow.rev;
      state.conflict = null;
      hideBanner();
      state.dirtyContent = true;
      await flushSave();
    } catch (error) {
      ui.toast(ui.T('nodes.toast.saveFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function reloadWorkflow() {
    if (!state.workflow) return;
    const id = state.workflow.id;
    state.conflict = null;
    state.dirtyContent = false;
    state.dirtyViewport = false;
    hideBanner();
    await loadWorkflow(id, { force: true });
  }

  /* ---------- workflow list ---------- */

  function updateListEntry(id, patch) {
    const entry = state.workflows.find((workflow) => workflow.id === id);
    if (entry) {
      Object.assign(entry, patch);
      workflowList.setData({ workflows: state.workflows });
    }
  }

  async function loadList() {
    workflowList.setData({ loading: !state.listLoaded, error: null });
    try {
      const payload = await api.listWorkflows();
      state.workflows = (payload.workflows || []).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      state.listLoaded = true;
      state.listError = null;
    } catch (error) {
      state.listError = error.message;
    }
    workflowList.setData({ workflows: state.workflows, loading: false, error: state.listError, activeId: state.workflow ? state.workflow.id : null });
  }

  /* ---------- registry ---------- */

  let registryPromise = null;

  function ensureRegistry() {
    if (state.reg) return Promise.resolve(state.reg);
    if (!registryPromise) {
      registryPromise = api
        .registry()
        .then((payload) => {
          state.registry = payload;
          state.reg = graphLib.indexRegistry(payload);
          state.registryError = null;
          canvas.setRegistry(state.reg);
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
    dom.root.classList.toggle('hidden', !active);
    document.documentElement.classList.toggle('nv-active', active);
    // The chat stays rendered below the overlay. While the node view is open it must not take focus or keys
    // (a late focus() of app.js on the chat input would otherwise receive typing and send it as a message).
    const chat = document.querySelector('body > .app');
    if (chat) {
      if (active) {
        chat.setAttribute('inert', '');
        const focused = document.activeElement;
        if (focused && focused !== document.body && chat.contains(focused)) focused.blur();
        if (dom.canvasHost) dom.canvasHost.focus({ preventScroll: true });
      } else {
        chat.removeAttribute('inert');
        const input = document.getElementById('input');
        if (input) input.focus({ preventScroll: true });
      }
    }
  }

  // The Design App view replaces topbar and editor body inside the same layer (#app=<id>).
  function setAppMode(on) {
    dom.root.classList.toggle('is-appview', on);
    dom.appView.classList.toggle('hidden', !on);
    if (!on && appView) appView.close();
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
        appView.showError(ui.T('nodes.stage.registryError', { error: error.message }));
        return;
      }
      await closeWorkflow();
      if (parseHash() && parseHash().view === 'app') {
        setAppMode(true);
        appView.open(target.id, state.reg);
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
        canvas.relayout();
      }
    } else {
      await closeWorkflow();
      showListView();
    }
  }

  /* ---------- stage states ---------- */

  function showStageMessage(kind, text) {
    dom.empty.classList.remove('hidden');
    dom.empty.dataset.kind = kind;
    dom.emptyTitle.textContent = text;
    dom.emptyBody.textContent = '';
    dom.emptyButton.classList.add('hidden');
    dom.emptyTemplate.classList.add('hidden');
  }

  function showListView() {
    dom.stage.classList.add('is-empty');
    dom.empty.classList.remove('hidden');
    dom.empty.dataset.kind = 'list';
    dom.emptyTitle.textContent = ui.T('nodes.stage.emptyTitle');
    dom.emptyBody.textContent = ui.T('nodes.stage.emptyBody');
    dom.emptyButton.classList.remove('hidden');
    dom.emptyTemplate.classList.remove('hidden');
    setDrawer(true, { remember: false });
    updateChrome();
  }

  function hideEmpty() {
    dom.stage.classList.remove('is-empty');
    dom.empty.classList.add('hidden');
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
    canvas.clearSlots();
    canvas.render(state.graph);
    hideBanner();
    updateChrome();
    bus.emit('workflow:close');
    workflowList.setData({ activeId: null });
  }

  async function loadWorkflow(id, options = {}) {
    const token = ++state.loadToken;
    if (!options.force && state.workflow) await closeWorkflow();
    hideEmpty();
    dom.stage.classList.add('is-loading');
    let payload;
    try {
      payload = await api.getWorkflow(id);
    } catch (error) {
      if (token !== state.loadToken) return;
      dom.stage.classList.remove('is-loading');
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
    canvas.clearSlots();
    setSelection({ nodes: [], notes: [], groups: [], edge: null });
    canvas.render(graph, { selection: { nodes: new Set(), notes: new Set(), groups: new Set(), edge: null } });
    const hasViewport = payload.workflow.graph && payload.workflow.graph.viewport && (payload.workflow.graph.viewport.x !== 0 || payload.workflow.graph.viewport.y !== 0 || payload.workflow.graph.viewport.zoom !== 1);
    dom.stage.classList.remove('is-loading');
    if (hasViewport) canvas.setViewport(graph.viewport, { silent: true });
    else if (graph.nodes.length) {
      makeRoomForFit();
      requestAnimationFrame(() => fitAfterMeasure());
    }
    else canvas.setViewport({ x: canvas.containerSize().width / 2 - 160, y: canvas.containerSize().height / 2 - 120, zoom: 1 }, { silent: true });
    setSaveState('saved');
    hideBanner();
    dom.name.value = state.workflow.name;
    lsSet(LS_LAST, id);
    if (state.listLoaded && !state.workflows.some((item) => item.id === id)) {
      const wf = payload.workflow;
      state.workflows.unshift({ id: wf.id, name: wf.name, folder: wf.folder || null, updatedAt: wf.updatedAt, updatedBy: wf.updatedBy || null, nodeCount: graph.nodes.length, app: { enabled: Boolean(wf.app && wf.app.enabled) } });
      workflowList.setData({ workflows: state.workflows });
    }
    workflowList.setData({ activeId: id });
    updateChrome();
    updateUndoButtons();
    refreshInspector(true);
    scheduleAppMarks();
    openEvents(id);
    bus.emit('workflow:open', { workflow: state.workflow, results: state.results, activeRun: payload.activeRun || null });
    if (!hasSelection()) canvas.relayout();
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

  // Fit once the cards have been measured and the side panels stopped animating (their grid
  // transition would otherwise leave the canvas wider than it ends up).
  function fitAfterMeasure() {
    const started = performance.now();
    const settle = () => {
      const animating = dom.body.getAnimations ? dom.body.getAnimations().some((animation) => animation.playState === 'running') : false;
      if (animating && performance.now() - started < 700) {
        requestAnimationFrame(settle);
        return;
      }
      requestAnimationFrame(() => {
        canvas.fit({ padding: 48 });
        state.graph = { ...state.graph, viewport: canvas.getViewport() };
      });
    };
    requestAnimationFrame(settle);
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
    if (dom && global.document.activeElement !== dom.name) dom.name.value = event.name;
    updateListEntry(state.workflow.id, { name: event.name, folder: event.folder || null });
  }

  /* ---------- chrome updates ---------- */

  function updateChrome() {
    if (!dom) return;
    const has = Boolean(state.workflow);
    dom.name.disabled = !has;
    dom.name.classList.toggle('hidden', !has);
    dom.saveState.classList.toggle('hidden', !has);
    dom.addNode.disabled = !has;
    dom.undo.disabled = !has || !state.history.canUndo();
    dom.redo.disabled = !has || !state.history.canRedo();
    dom.toolbar.classList.toggle('hidden', !has);
    dom.minimap.classList.toggle('hidden', !has);
    dom.menuBtn.classList.toggle('hidden', !has);
    updateAppButton();
    dom.inspectorToggle.classList.toggle('hidden', !has);
    dom.stage.classList.toggle('is-empty', !has);
    dom.body.classList.toggle('no-workflow', !has);
    if (!has) dom.name.value = '';
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (!dom || !canvas) return;
    dom.zoomLabel.textContent = `${Math.round(canvas.getViewport().zoom * 100)}%`;
  }

  function setDrawer(open, options = {}) {
    state.drawerOpen = open;
    dom.body.classList.toggle('drawer-closed', !open);
    dom.drawerToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (options.remember !== false) lsSet(LS_DRAWER, open ? '1' : '0');
    setTimeout(() => canvas && canvas.relayout(), 220);
  }

  function setInspector(open, options = {}) {
    state.inspectorOpen = open;
    if (options.remember !== false || open) state.inspectorAutoClosed = false;
    dom.body.classList.toggle('inspector-closed', !open);
    dom.inspectorToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (options.remember !== false) lsSet(LS_INSPECTOR, open ? '1' : '0');
    if (open) refreshInspector(true);
    setTimeout(() => canvas && canvas.relayout(), 220);
  }

  function setTool(tool) {
    state.tool = tool;
    canvas.setTool(tool);
    dom.toolSelect.classList.toggle('is-active', tool === 'select');
    dom.toolHand.classList.toggle('is-active', tool === 'hand');
    dom.toolSelect.setAttribute('aria-pressed', tool === 'select' ? 'true' : 'false');
    dom.toolHand.setAttribute('aria-pressed', tool === 'hand' ? 'true' : 'false');
  }

  /* ---------- node operations ---------- */

  function viewCenter() {
    const size = canvas.containerSize();
    return graphLib.screenToWorld(canvas.getViewport(), size.width / 2, size.height / 2);
  }

  function pointerWorld() {
    const rect = dom.canvasHost.getBoundingClientRect();
    const p = canvas.getLastPointer();
    if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) return canvas.clientToWorld(p.x, p.y);
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
        if (result.error) connectionError = result.error.code;
        else next = result.graph;
      }
    }
    applyGraph(next, { history: 'add-node' });
    setSelection({ nodes: [out.node.id], notes: [], groups: [], edge: null });
    if (connectionError) ui.toast(ui.T(`nodes.connect.${connectionError}`), { kind: 'warn' });
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
  }

  function renameNode(nodeId, title) {
    applyGraph(graphLib.setTitle(state.graph, nodeId, title), { history: 'rename', key: `t:${nodeId}` });
  }

  function connectEdge(from, to, meta = {}) {
    let graph = state.graph;
    if (meta.replaceEdge) graph = graphLib.disconnect(graph, meta.replaceEdge);
    const result = graphLib.connect(state.reg, graph, from, to, { reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.T(`nodes.connect.${result.error.code}`), { kind: 'warn' });
      return;
    }
    applyGraph(result.graph, { history: 'connect' });
    setSelection({ nodes: [...state.selection.nodes], notes: [...state.selection.notes], groups: [...state.selection.groups], edge: null });
  }

  function groupSelected() {
    if (!state.selection.nodes.size && !state.selection.notes.size) return;
    const result = graphLib.groupSelection(state.graph, canvas.getSizes(), selectionIds(), { reserved: state.reserved });
    if (!result.group) return;
    applyGraph(result.graph, { history: 'group' });
    setSelection({ nodes: [], notes: [], groups: [result.group.id], edge: null });
  }

  function addNoteAt(world) {
    const out = graphLib.addNote(state.graph, { x: graphLib.snap(world.x, 8), y: graphLib.snap(world.y, 8), reserved: state.reserved });
    applyGraph(out.graph, { history: 'add-note' });
    setSelection({ nodes: [], notes: [out.note.id], groups: [], edge: null });
    requestAnimationFrame(() => {
      const area = dom.canvasHost.querySelector(`.nv-note[data-id="${out.note.id}"] textarea`);
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
    state.graph = next;
    for (const node of next.nodes) reserveId(node.id);
    canvas.render(next);
    pruneApp();
    markDirty();
    updateUndoButtons();
    refreshInspector();
    scheduleAppMarks();
    bus.emit('graph', state.graph);
  }

  /* ---------- palette ---------- */

  function openPalette(context = {}, filter = null) {
    if (!state.workflow || !state.reg) return;
    const world = context.world || pointerWorld();
    palette.open({ filter, context: { ...context, world } });
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
        if (state.workflow && graphLib.getNode(state.graph, node.id)) applyParams(node.id, { asset: value }, { commit: true }, `asset:${node.id}`);
      } catch (error) {
        notice.remove();
        ui.toast(ui.T('nodes.toast.uploadFailed', { name: file.name, error: error.message }), { kind: 'error' });
      }
    }
  }

  /* ---------- workflow operations ---------- */

  async function createWorkflow() {
    try {
      const base = ui.T('nodes.workflow.untitled');
      const names = new Set(state.workflows.map((workflow) => workflow.name));
      let name = base;
      for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
      const payload = await api.createWorkflow({ name });
      state.workflows.unshift({ id: payload.workflow.id, name: payload.workflow.name, folder: payload.workflow.folder || null, updatedAt: payload.workflow.updatedAt, updatedBy: payload.workflow.updatedBy, nodeCount: 0, app: { enabled: false } });
      workflowList.setData({ workflows: state.workflows });
      navigate(payload.workflow.id);
      setTimeout(() => {
        dom.name.focus();
        dom.name.select();
      }, 400);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.createFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function renameWorkflow(workflow) {
    const name = await ui.promptDialog({ title: ui.T('nodes.list.rename'), label: ui.T('nodes.workflow.name'), value: workflow.name, maxLength: 120 });
    if (name === null || !name || name === workflow.name) return;
    await patchName(workflow.id, name);
  }

  async function patchName(id, name) {
    try {
      const result = await api.patchWorkflow(id, { name });
      updateListEntry(id, { name: result.name });
      if (state.workflow && state.workflow.id === id) {
        state.workflow.name = result.name;
        dom.name.value = result.name;
      }
    } catch (error) {
      ui.toast(ui.T('nodes.toast.renameFailed', { error: error.message }), { kind: 'error' });
      if (state.workflow && state.workflow.id === id) dom.name.value = state.workflow.name;
    }
  }

  async function duplicateWorkflow(workflow) {
    try {
      if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
      const payload = await api.duplicateWorkflow(workflow.id);
      const created = payload.workflow || payload;
      await loadList();
      ui.toast(ui.T('nodes.toast.duplicated', { name: created.name || workflow.name }));
      navigate(created.id);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.duplicateFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function deleteWorkflow(workflow) {
    const confirmed = await ui.confirmDialog({
      title: ui.T('nodes.delete.title', { name: workflow.name }),
      message: ui.T('nodes.delete.message'),
      confirmLabel: ui.T('nodes.delete.confirm'),
      danger: true
    });
    if (!confirmed) return;
    try {
      const isCurrent = state.workflow && state.workflow.id === workflow.id;
      if (isCurrent) {
        clearTimeout(state.saveTimer);
        state.dirtyContent = false;
        state.dirtyViewport = false;
      }
      await api.deleteWorkflow(workflow.id);
      state.workflows = state.workflows.filter((item) => item.id !== workflow.id);
      workflowList.setData({ workflows: state.workflows });
      if (lsGet(LS_LAST) === workflow.id) lsSet(LS_LAST, null);
      ui.toast(ui.T('nodes.toast.deleted', { name: workflow.name }));
      if (isCurrent) {
        state.workflow = null;
        closeEvents();
        navigate('');
      }
    } catch (error) {
      ui.toast(error.status === 409 ? ui.T('nodes.toast.deleteBusy') : ui.T('nodes.toast.deleteFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function exportWorkflow(workflow) {
    if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
    const link = el('a', { href: api.exportUrl(workflow.id), download: '', class: 'hidden' });
    dom.overlays.append(link);
    link.click();
    link.remove();
  }

  async function importFile(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      ui.toast(ui.T('nodes.toast.importTooLarge'), { kind: 'error' });
      return;
    }
    let document;
    try {
      document = JSON.parse(await file.text());
    } catch (_) {
      ui.toast(ui.T('nodes.toast.importInvalid'), { kind: 'error' });
      return;
    }
    try {
      const payload = await api.importWorkflow(document);
      await loadList();
      ui.toast(ui.T('nodes.toast.imported', { name: payload.workflow.name }));
      navigate(payload.workflow.id);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.importFailed', { error: error.message }), { kind: 'error' });
    }
  }

  /* ---------- templates, projects, chat bridge (WP7) ---------- */

  const REQUIREMENT_LABELS = { openrouter: 'OpenRouter', ffmpeg: 'ffmpeg', elevenlabs: 'ElevenLabs', rendernode: 'Render node', higgsfield: 'Higgsfield' };

  function currentLang() {
    return typeof global.getLang === 'function' ? global.getLang() : 'en';
  }

  async function loadFolders() {
    try {
      const payload = await api.request('GET', '/api/folders');
      return (payload.folders || []).map((folder) => folder.name).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function projectSelect(folders, value) {
    const select = el('select', { class: 'nv-input nv-select', 'aria-label': ui.T('nodes.project.label') });
    select.append(el('option', { value: '', text: ui.T('nodes.project.none') }));
    const names = value && !folders.includes(value) ? [value, ...folders] : folders;
    for (const name of names) select.append(el('option', { value: name, text: name }));
    select.value = value || '';
    return select;
  }

  // "New from template": cards of the starter workflows with their requirements.
  async function openTemplateDialog() {
    let templates;
    try {
      templates = (await api.request('GET', `/api/workflow-templates?lang=${encodeURIComponent(currentLang())}`)).templates || [];
    } catch (error) {
      ui.toast(ui.T('nodes.template.loadFailed', { error: error.message }), { kind: 'error' });
      return;
    }
    const folders = await loadFolders();
    let chosen = null;
    let panel = null;
    const grid = el('div', { class: 'nv-tpl-grid', role: 'listbox', 'aria-label': ui.T('nodes.template.title') });
    const cards = new Map();
    for (const template of templates) {
      const card = el('button', { type: 'button', class: `nv-tpl-card ${template.available ? '' : 'is-unavailable'}`.trim(), role: 'option', 'aria-selected': 'false', dataset: { id: template.id } });
      const head = el('div', { class: 'nv-tpl-head' }, el('span', { class: 'nv-tpl-icon' }, ui.icon('template', 16)), el('span', { class: 'nv-tpl-name', text: template.name }));
      const tags = el('div', { class: 'nv-tpl-tags' });
      if (template.batch) tags.append(el('span', { class: 'nv-badge is-batch', text: ui.T('nodes.app.batch') }));
      for (const key of template.requires || []) {
        const missing = (template.missing || []).find((item) => item.key === key);
        tags.append(el('span', { class: `nv-badge ${missing ? 'is-warn' : ''}`.trim(), title: missing ? missing.reason : ui.T('nodes.template.ready'), text: REQUIREMENT_LABELS[key] || key }));
      }
      card.append(head, el('p', { class: 'nv-tpl-desc', text: template.description }), tags);
      card.addEventListener('click', () => {
        chosen = template;
        for (const [id, other] of cards) {
          other.classList.toggle('is-selected', id === template.id);
          other.setAttribute('aria-selected', id === template.id ? 'true' : 'false');
        }
        update();
      });
      cards.set(template.id, card);
      grid.append(card);
    }
    const select = projectSelect(folders, '');
    const projectRow = el('div', { class: 'nv-tpl-project' }, el('label', { class: 'nv-field-label', text: ui.T('nodes.project.label') }), select);
    const note = el('p', { class: 'nv-hint nv-tpl-note', text: ui.T('nodes.template.note') });
    function update() {
      const create = panel && panel.querySelector('.nv-dialog-actions .nv-btn-primary');
      if (create) create.disabled = !chosen;
      note.classList.toggle('is-warn', Boolean(chosen && !chosen.available));
      note.textContent = chosen && !chosen.available ? ui.T('nodes.template.unavailableNote', { missing: chosen.missing.map((item) => REQUIREMENT_LABELS[item.key] || item.key).join(', ') }) : ui.T('nodes.template.note');
    }
    const result = await ui.dialog({
      title: ui.T('nodes.template.title'),
      body: el('div', { class: 'nv-tpl' }, grid, note, projectRow),
      width: 760,
      buttons: [
        { label: ui.T('nodes.common.cancel'), value: false, cancel: true },
        { label: ui.T('nodes.template.create'), value: true, primary: true }
      ],
      onOpen: (dialogPanel) => {
        panel = dialogPanel;
        dialogPanel.classList.add('is-wide');
        update();
      }
    });
    if (!result || !chosen) return;
    try {
      const payload = await api.createWorkflow({ templateId: chosen.id, lang: currentLang(), folder: select.value || null });
      state.workflows.unshift({
        id: payload.workflow.id,
        name: payload.workflow.name,
        folder: payload.workflow.folder || null,
        updatedAt: payload.workflow.updatedAt,
        updatedBy: payload.workflow.updatedBy,
        nodeCount: payload.workflow.graph.nodes.length,
        app: { enabled: Boolean(payload.workflow.app && payload.workflow.app.enabled) }
      });
      workflowList.setData({ workflows: state.workflows });
      navigate(payload.workflow.id);
    } catch (error) {
      ui.toast(ui.T('nodes.template.createFailed', { error: error.message }), { kind: 'error' });
    }
  }

  // Assigns a workflow to a project (chat folder) or removes the assignment.
  async function assignProject(workflow) {
    const folders = await loadFolders();
    const select = projectSelect(folders, workflow.folder || '');
    const result = await ui.dialog({
      title: ui.T('nodes.project.title', { name: workflow.name }),
      message: ui.T('nodes.project.message'),
      body: el('div', { class: 'nv-dialog-field' }, el('label', { class: 'nv-field-label', text: ui.T('nodes.project.label') }), select),
      buttons: [
        { label: ui.T('nodes.common.cancel'), value: false, cancel: true },
        { label: ui.T('nodes.common.save'), value: true, primary: true }
      ],
      onOpen: () => select.focus()
    });
    if (!result) return;
    const folder = select.value || null;
    if (folder === (workflow.folder || null)) return;
    try {
      const patched = await api.patchWorkflow(workflow.id, { folder });
      updateListEntry(workflow.id, { folder: patched.folder || null });
      if (state.workflow && state.workflow.id === workflow.id) state.workflow.folder = patched.folder || null;
      workflow.folder = patched.folder || null;
      ui.toast(folder ? ui.T('nodes.project.assigned', { project: folder }) : ui.T('nodes.project.removed'));
    } catch (error) {
      ui.toast(ui.T('nodes.project.failed', { error: error.message }), { kind: 'error' });
    }
  }

  async function openWorkflowApp(workflow) {
    if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
    global.location.hash = `#app=${encodeURIComponent(workflow.id)}`;
  }

  function hasNodeResult(nodeId) {
    const entry = state.results && state.results.nodes && state.results.nodes[nodeId];
    return Boolean(entry && entry.selected && entry.selected.entry);
  }

  // Sends the selected result of a node to a chat (asks which one).
  function sendNodeToChat(nodeId) {
    if (!state.workflow || !OCD.assetPicker) return Promise.resolve(null);
    if (!hasNodeResult(nodeId)) {
      ui.toast(ui.T('nodes.run.noResult'), { kind: 'warn' });
      return Promise.resolve(null);
    }
    return OCD.assetPicker.sendToChat({ workflowId: state.workflow.id, nodeId });
  }

  function openImportPicker() {
    const input = el('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) importFile(input.files[0]);
      input.remove();
    });
    dom.overlays.append(input);
    input.click();
  }

  /* ---------- menus ---------- */

  function canvasMenuItems(world) {
    const items = [
      { label: ui.T('nodes.menu.addNode'), icon: 'plus', shortcut: 'Tab', onClick: () => openPalette({ world, exact: true }) },
      { label: ui.T('nodes.menu.addNote'), icon: 'note', shortcut: 'N', onClick: () => addNoteAt(world) },
      { label: ui.T('nodes.menu.paste'), icon: 'copy', shortcut: '⌘V', disabled: !readClipboard(), onClick: () => pasteClipboard(world) },
      { separator: true },
      { label: ui.T('nodes.menu.selectAll'), shortcut: '⌘A', onClick: selectAll },
      { label: ui.T('nodes.menu.fit'), icon: 'fit', shortcut: 'F', onClick: () => canvas.fit({ padding: 96 }) }
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
      ui.menu(info.clientX, info.clientY, [{ label: ui.T('nodes.inspector.disconnect'), icon: 'trash', danger: true, onClick: () => applyGraph(graphLib.disconnect(state.graph, info.id), { history: 'disconnect' }) }]);
    } else {
      ui.menu(info.clientX, info.clientY, canvasMenuItems(info.world));
    }
  }

  function workflowMenu() {
    if (!state.workflow) return;
    const rect = dom.menuBtn.getBoundingClientRect();
    const workflow = state.workflow;
    ui.menu(rect.right - 200, rect.bottom + 6, [
      { label: ui.T('nodes.list.rename'), icon: 'edit', onClick: () => renameWorkflow(workflow) },
      { label: ui.T('nodes.list.duplicate'), icon: 'duplicate', onClick: () => duplicateWorkflow(workflow) },
      { label: ui.T('nodes.list.export'), icon: 'download', onClick: () => exportWorkflow(workflow) },
      { label: ui.T('nodes.list.import'), icon: 'upload', onClick: openImportPicker },
      { label: ui.T('nodes.project.assign'), icon: 'folder', onClick: () => assignProject(workflow) },
      { label: ui.T('nodes.template.new'), icon: 'template', onClick: openTemplateDialog },
      ...extensions.workflowMenu.flatMap((extra) => extra({ workflow }) || []),
      { separator: true },
      { label: ui.T('nodes.list.delete'), icon: 'trash', danger: true, onClick: () => deleteWorkflow(workflow) }
    ]);
  }

  /* ---------- keyboard ---------- */

  function isEditable(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function dialogOpen() {
    return Boolean(dom.overlays.querySelector('.nv-dialog-backdrop, .nv-viewer'));
  }

  function onKeyDown(event) {
    if (!state.active) return;
    if (dialogOpen()) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (key === 'Escape') {
      if (palette.isOpen()) return;
      if (isEditable(event.target)) {
        event.target.blur();
        canvas && dom.canvasHost.focus({ preventScroll: true });
        return;
      }
      ui.closeMenu();
      if (hasSelection() || state.selection.edge) setSelection({ nodes: [], notes: [], groups: [], edge: null });
      return;
    }
    if (isEditable(event.target)) return;
    if (!state.workflow) return;
    if (palette.isOpen()) return;

    if (key === ' ' || event.code === 'Space') {
      if (!event.repeat) canvas.setSpace(true);
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
        if (copySelection()) event.preventDefault();
      } else if (lower === 'x') {
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
        canvas.setZoom(1);
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
    } else if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
    } else if (lower === 'f' || (key === '!' && event.shiftKey) || (event.code === 'Digit1' && event.shiftKey)) {
      event.preventDefault();
      canvas.fit({ selectionOnly: true, padding: 96, maxZoom: 1.25 });
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
    if (event.key === ' ' || event.code === 'Space') canvas && canvas.setSpace(false);
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
    const back = tbtn('back', 'nodes.topbar.backTitle', { className: 'nv-btn nv-back', text: 'nodes.topbar.back' });
    back.addEventListener('click', leaveToChat);
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
    inspectorToggle.addEventListener('click', () => setInspector(!state.inspectorOpen));
    const topbar = el(
      'header',
      { class: 'nv-topbar' },
      back,
      drawerToggle,
      el('div', { class: 'nv-topbar-title' }, name, saveStateEl),
      el('div', { class: 'nv-topbar-spacer' }),
      runSlot,
      appBtn,
      addNode,
      el('div', { class: 'nv-btn-group' }, undoBtn, redoBtn),
      menuBtn,
      inspectorToggle
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
    zoomOut.addEventListener('click', () => canvas.zoomBy(1 / 1.25));
    zoomIn.addEventListener('click', () => canvas.zoomBy(1.25));
    zoomLabel.addEventListener('click', () => canvas.setZoom(1));
    fitBtn.addEventListener('click', () => canvas.fit({ padding: 96 }));
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
    const loading = el('div', { class: 'nv-loading', 'aria-hidden': 'true' }, el('div', { class: 'nv-spinner' }));
    const stage = el('section', { class: 'nv-stage is-empty' }, canvasHost, toolbar, minimap, empty, loading, banner);
    const inspectorHost = el('aside', { class: 'nv-inspector', 'aria-label': ui.T('nodes.inspector.label') });
    const inspectorScroll = el('div', { class: 'nv-insp-scroll' });
    inspectorHost.append(inspectorScroll);
    const body = el('div', { class: 'nv-body' }, drawer, stage, inspectorHost);
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
      empty,
      emptyTitle,
      emptyBody,
      emptyButton,
      emptyTemplate,
      inspectorHost,
      inspectorScroll,
      overlays,
      name,
      saveState: saveStateEl,
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
    for (const node of dom.root.querySelectorAll('[data-t-key]')) {
      const value = ui.T(node.dataset.tKey);
      node.title = value;
      node.setAttribute('aria-label', value);
    }
    for (const node of dom.root.querySelectorAll('[data-t-text]')) node.textContent = ui.T(node.dataset.tText);
    dom.name.placeholder = ui.T('nodes.workflow.name');
    dom.name.setAttribute('aria-label', ui.T('nodes.workflow.name'));
    setSaveState(state.saveState);
    if (!state.workflow) showListViewText();
    else if (state.conflict) enterConflictText();
    workflowList.relabel();
    if (canvas) canvas.relabel();
    if (runController) runController.relabel();
    if (appView) appView.relabel();
    if (inspector) inspector.invalidate();
    refreshInspector(true);
  }

  function showListViewText() {
    if (dom.empty.dataset.kind === 'list') {
      dom.emptyTitle.textContent = ui.T('nodes.stage.emptyTitle');
      dom.emptyBody.textContent = ui.T('nodes.stage.emptyBody');
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

  /* ---------- boot ---------- */

  const nativeReplaceState = history.replaceState.bind(history);

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
    dom = buildChrome(rootEl);
    dom.root.classList.add('hidden');

    canvas = OCD.canvas.createCanvas(dom.canvasHost, {
      minimap: dom.minimap,
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
      onConnectRefused(code) {
        ui.toast(ui.T(`nodes.connect.${code}`), { kind: 'warn' });
      },
      onDetach(edgeId) {
        applyGraph(graphLib.disconnect(state.graph, edgeId), { history: 'disconnect' });
      },
      onDropEmpty({ anchor, portType, world, client }) {
        void client;
        openPalette({ world, anchor, exact: true }, { dir: anchor.dir, type: portType });
      },
      onCanvasDoubleClick({ world }) {
        openPalette({ world, exact: true });
      },
      onContextMenu: onCanvasContextMenu,
      onParam: (nodeId, paramId, value, meta) => applyParams(nodeId, { [paramId]: value }, meta, `p:${nodeId}:${paramId}`),
      onRename: renameNode,
      onNoteChange(id, patch) {
        applyGraph(graphLib.updateNote(state.graph, id, patch), { history: 'note', key: `note:${id}:${Object.keys(patch).join(',')}` });
      },
      onGroupChange(id, patch) {
        applyGraph(graphLib.updateGroup(state.graph, id, patch), { history: 'group-edit', key: `group:${id}:${Object.keys(patch).join(',')}` });
      },
      uploadFile,
      onFilesDropped
    });
    canvas.setRegistry(null);

    palette = OCD.palette.createPalette({ host: dom.overlays, getReg: () => state.reg, onPick: onPalettePick });
    runController = OCD.run.createController({ OCD });
    inspector = OCD.inspector.createInspector({
      host: dom.inspectorScroll,
      getReg: () => state.reg,
      callbacks: {
        onParam: (nodeId, paramId, value, meta) => applyParams(nodeId, { [paramId]: value }, meta, `p:${nodeId}:${paramId}`),
        onParams: (nodeId, patch, meta, key) => applyParams(nodeId, patch, meta, `p:${nodeId}:${key || Object.keys(patch).join(',')}`),
        onTitle: (nodeId, title) => renameNode(nodeId, title),
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
        run: { ...runController.inspectorApi, runAll: () => runController.startRun({ mode: 'all', force: false }), sendToChat: sendNodeToChat },
        onRendered: (slot, ctx) => bus.emit('inspector', { slot, selection: ctx.selection, graph: ctx.graph })
      }
    });
    workflowList = OCD.workflowList.createWorkflowList({
      host: dom.drawer,
      callbacks: {
        onOpen: (id) => navigate(id),
        onCreate: createWorkflow,
        onImport: importFile,
        onRename: renameWorkflow,
        onDuplicate: duplicateWorkflow,
        onExport: exportWorkflow,
        onDelete: deleteWorkflow,
        onReload: loadList,
        onTemplate: openTemplateDialog,
        onOpenApp: openWorkflowApp,
        onProject: assignProject
      }
    });

    runController.attach();
    extensions.nodeMenu.push(({ nodeId }) => [{ label: ui.T('nodes.send.menu'), icon: 'send', disabled: !hasNodeResult(nodeId), onClick: () => sendNodeToChat(nodeId) }]);
    appView = OCD.appMode.createAppView({
      host: dom.appView,
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
      if (!state.active || !dom || dom.root.contains(event.target)) return;
      const chat = document.querySelector('body > .app');
      if (chat && chat.contains(event.target)) {
        event.target.blur();
        dom.canvasHost.focus({ preventScroll: true });
      }
    });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    global.addEventListener('blur', () => canvas.setSpace(false));
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
    });
    global.addEventListener('resize', () => canvas && canvas.relayout());
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
    if (parseHash()) route();
  }

  OCD.bus = bus;
  OCD.extensions = extensions;
  OCD.editor = {
    getState: () => state,
    getGraph: () => state.graph,
    getWorkflow: () => state.workflow,
    getSelection: selectionIds,
    getCanvas: () => canvas,
    getInspector: () => inspector,
    getRegistry: () => state.reg,
    applyParams,
    flushSave,
    reload: reloadWorkflow,
    dom: () => dom,
    navigate,
    openPalette,
    undo,
    redo,
    addNodeAt,
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
    getAppView: () => appView,
    openTemplateDialog,
    assignProject,
    changeApp,
    sendNodeToChat
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
