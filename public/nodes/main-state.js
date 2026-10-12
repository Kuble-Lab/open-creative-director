'use strict';

// Shared editor state, selection, graph mutations and autosave from main.js.
(function (global) {
  const runtime = {};
  runtime.connect = [];
  let pruneApp, scheduleAppMarks, updateStart, currentApp, handleAccessLost, loadWorkflow;
  runtime.connect.push(() => {
    ({ pruneApp, scheduleAppMarks, updateStart, currentApp, handleAccessLost, loadWorkflow } = runtime);
  });

  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const historyLib = OCD.history;
  const api = OCD.api;
  const ui = OCD.ui;
  const archiveUi = OCD.archiveUi;
  const { el } = ui;

  const LS_LAST = 'ocd-nodes-last';
  const LS_CLIPBOARD = 'ocd-nodes-clipboard';
  const LS_DRAWER = 'ocd-nodes-drawer';
  const LS_INSPECTOR = 'ocd-nodes-inspector';
  const LS_ASSISTANT_MODEL = 'ocd-nodes-assistant-model';
  const SS_RETURN = 'ocd-nodes-return';
  const SAVE_DELAY = 800;
  const VIEWPORT_SAVE_DELAY = 1600;
  const MAX_IMPORT_BYTES = archiveUi.MAX_JSON_BYTES;
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
    teamGroups: [],
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
    // Design App exposures moved by a conversion (outside the undo history): [{ from: {node,param}, to: {node,param} }]
    appRemaps: [],
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
  let assistant = null;
  let appView = null;
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
    OCD.inspector.warnApprovalChanges(state.graph, next, state.results);
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
    updateStart();
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
          } else if (error.status === 404 && global.OCAccess && global.OCAccess.isActive()) {
            handleAccessLost();
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

  // User management fields (owner, shareMode, canManage ...) a workflow answer carries in the active mode.
  const SHARING_KEYS = ['owner', 'ownerIsAdmin', 'unowned', 'mine', 'shareMode', 'sharedCount', 'sharedWith', 'canManage', 'canShare'];

  function sharingFields(workflow) {
    const out = {};
    if (workflow) for (const key of SHARING_KEYS) if (key in workflow) out[key] = workflow[key];
    return out;
  }

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
      // Admins also get the groups of the team view (head data: name, people); nobody else.
      state.teamGroups = Array.isArray(payload.teamGroups) ? payload.teamGroups : [];
      state.listLoaded = true;
      state.listError = null;
    } catch (error) {
      // An unconfirmed login has its own banner (public/access-client.js): no second message in the list.
      state.listError = error.code === 'LOGIN_UNCONFIRMED' ? null : error.message;
    }
    workflowList.setData({ workflows: state.workflows, teamGroups: state.teamGroups, loading: false, error: state.listError, activeId: state.workflow ? state.workflow.id : null });
  }

  // The team view groups by the team the server sends with each workflow. A workflow added to the list here has none
  // yet, so the list is read again (only in that view).
  function reloadListForTeams() {
    if (global.OCTeamGroups && global.OCTeamGroups.mode('workflows') === 'teams') loadList();
  }


  OCD.main = runtime;
  // UI instances have one owner; every part reads and writes these live references.
  Object.defineProperties(runtime, {
    dom: { get: () => dom, set: (value) => { dom = value; } },
    canvas: { get: () => canvas, set: (value) => { canvas = value; } },
    palette: { get: () => palette, set: (value) => { palette = value; } },
    inspector: { get: () => inspector, set: (value) => { inspector = value; } },
    workflowList: { get: () => workflowList, set: (value) => { workflowList = value; } },
    runController: { get: () => runController, set: (value) => { runController = value; } },
    assistant: { get: () => assistant, set: (value) => { assistant = value; } },
    appView: { get: () => appView, set: (value) => { appView = value; } }
  });

  Object.assign(runtime, {
    graphLib, historyLib, api, ui, archiveUi, el, LS_LAST, LS_CLIPBOARD, LS_DRAWER, LS_INSPECTOR,
    LS_ASSISTANT_MODEL, SS_RETURN, SAVE_DELAY, VIEWPORT_SAVE_DELAY, MAX_IMPORT_BYTES, PASTE_OFFSET,
    listeners, bus, extensions, lsGet, lsSet, ssGet, ssSet, state, selectionIds, hasSelection,
    setSelection, updateUndoButtons, refreshInspector, applyGraph, markDirty, reserveId, setSaveState,
    scheduleSave, KEEPALIVE_MAX_CHARS, savePayload, flushSave, showBanner, hideBanner, enterConflict,
    overwriteConflict, reloadWorkflow, SHARING_KEYS, sharingFields, updateListEntry, loadList,
    reloadListForTeams
  });
})(window);
