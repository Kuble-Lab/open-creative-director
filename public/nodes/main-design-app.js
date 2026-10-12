'use strict';

// Design App builder and exposure controls from main.js.
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    state, ui, markDirty, refreshInspector, graphLib, setSelection, flushSave
  } = runtime;
  let isPrivateOwned, setInspector;
  runtime.connect.push(() => {
    ({ isPrivateOwned, setInspector } = runtime);
  });

  /* ---------- Design App state (workflow.app) ---------- */

  const MAX_APP_ENTRIES = 100;

  function emptyApp() {
    return { enabled: false, title: '', description: '', inputs: [], outputs: [] };
  }

  // workflow.app with all fields present (older documents and imports may lack some). An output keeps `approve` as `true` (step 1,
  // also written as 1) or a whole number from 2 to 5 (a later step) and `hint` as a text of at most 300 characters; anything else is
  // dropped (the server does the same). An input keeps `marks` and an output `switches` (WP55): { node, param } of a param of marks.
  function normalizeApp(raw) {
    const app = raw && typeof raw === 'object' ? raw : {};
    const stage = (value) => (value === true || value === 1 ? true : Number.isInteger(value) && value >= 2 && value <= 5 ? value : null);
    const hint = (value) => (typeof value === 'string' && value.trim() ? [...value.trim()].slice(0, 300).join('') : '');
    const ref = (value) => (value && typeof value === 'object' && typeof value.node === 'string' && typeof value.param === 'string' ? { node: value.node, param: value.param } : null);
    const output = (entry) => {
      const approve = stage(entry.approve);
      const text = hint(entry.hint);
      const switches = ref(entry.switches);
      return { node: entry.node, label: typeof entry.label === 'string' ? entry.label : '', ...(approve !== null ? { approve } : {}), ...(text ? { hint: text } : {}), ...(switches ? { switches } : {}) };
    };
    const input = (entry) => {
      const marks = ref(entry.marks);
      return { node: entry.node, param: entry.param, label: typeof entry.label === 'string' ? entry.label : '', ...(entry.optional === true ? { optional: true } : {}), ...(marks ? { marks } : {}) };
    };
    return {
      enabled: app.enabled === true,
      title: typeof app.title === 'string' ? app.title : '',
      description: typeof app.description === 'string' ? app.description : '',
      inputs: Array.isArray(app.inputs) ? app.inputs.filter((entry) => entry && typeof entry.node === 'string' && typeof entry.param === 'string').map(input) : [],
      outputs: Array.isArray(app.outputs) ? app.outputs.filter((entry) => entry && typeof entry.node === 'string').map(output) : []
    };
  }

  // The approval step of an output entry: 1 for `true`, 2 to 5 for a later step, 0 without a mark.
  function approveStepOf(entry) {
    if (!entry || entry.approve === undefined) return 0;
    if (entry.approve === true || entry.approve === 1) return 1;
    return Number.isInteger(entry.approve) && entry.approve >= 2 && entry.approve <= 5 ? entry.approve : 0;
  }

  function currentApp() {
    return state.workflow ? state.workflow.app || emptyApp() : emptyApp();
  }

  // Points the Design App input exposure `from` ({ node, param }) at `to`; label and the rest of the entry stay.
  function moveAppInput(from, to) {
    const app = state.workflow && state.workflow.app;
    if (!app || !app.inputs.some((entry) => entry.node === from.node && entry.param === from.param)) return false;
    state.workflow.app = {
      ...app,
      inputs: app.inputs.map((entry) => (entry.node === from.node && entry.param === from.param ? { ...entry, node: to.node, param: to.param } : entry))
    };
    updateAppButton();
    return true;
  }

  // After undo / redo of a conversion: the exposure follows the node that drives the field. Without the converted
  // Prompt node the field is the original one again, with it the Prompt node's text is shared.
  function syncAppRemaps() {
    for (const remap of state.appRemaps) {
      const hasTo = state.graph.nodes.some((node) => node.id === remap.to.node);
      const hasFrom = state.graph.nodes.some((node) => node.id === remap.from.node);
      if (!hasFrom) continue;
      if (hasTo) moveAppInput(remap.from, remap.to);
      else moveAppInput(remap.to, remap.from);
    }
  }

  // Drops exposures of nodes that no longer exist (the server does the same on save), and the marks and switches (WP55) whose node is gone.
  function pruneApp() {
    if (!state.workflow || !state.workflow.app) return;
    const ids = new Set(state.graph.nodes.map((node) => node.id));
    const app = state.workflow.app;
    let dangling = false;
    const prune = (entry, key) => {
      if (!entry[key] || ids.has(entry[key].node)) return entry;
      dangling = true;
      const { [key]: _gone, ...rest } = entry;
      return rest;
    };
    const inputs = app.inputs.filter((entry) => ids.has(entry.node)).map((entry) => prune(entry, 'marks'));
    const outputs = app.outputs.filter((entry) => ids.has(entry.node)).map((entry) => prune(entry, 'switches'));
    if (dangling || inputs.length !== app.inputs.length || outputs.length !== app.outputs.length) {
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
      if (!runtime.dom) return;
      const app = currentApp();
      const marks = new Map();
      for (const entry of app.inputs) marks.set(entry.node, 'input');
      for (const entry of app.outputs) marks.set(entry.node, marks.get(entry.node) === 'input' ? 'both' : 'output');
      for (const card of runtime.dom.canvasHost.querySelectorAll('.nv-node')) {
        const cardState = ui.getCardState(card);
        if (cardState) ui.setAppMark(cardState, marks.get(card.dataset.id) || null);
      }
    });
  }

  function updateAppButton() {
    if (!runtime.dom) return;
    const app = currentApp();
    const on = Boolean(state.workflow) && app.enabled;
    runtime.dom.appBtn.classList.toggle('is-on', on);
    runtime.dom.appBtn.classList.toggle('hidden', !state.workflow);
    runtime.dom.appBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
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

  // "Show first for approval": the mark lives in the entry of the output, so it goes when the output leaves the app. `step` is the
  // step of the approval: 1 (or true) is stored as `true`, 2 to 5 as the number, anything else takes the mark away.
  function setAppApprove(nodeId, step) {
    const stage = step === true ? 1 : Number.isInteger(step) && step >= 1 && step <= 5 ? step : 0;
    const outputs = currentApp().outputs.map((entry) => {
      if (entry.node !== nodeId) return entry;
      const next = { ...entry };
      if (stage) next.approve = stage === 1 ? true : stage;
      else delete next.approve;
      return next;
    });
    changeApp({ outputs });
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
        if (nodeId) {
          const output = app.outputs.find((entry) => entry.node === nodeId);
          const step = approveStepOf(output);
          return `${app.enabled ? 1 : 0}:${app.inputs.filter((entry) => entry.node === nodeId).map((entry) => entry.param).join(',')}:${output ? (step ? `oa${step}` : 'o') : ''}`;
        }
        return `${app.enabled ? 1 : 0}|${app.inputs.map((entry) => `${entry.node}.${entry.param}`).join(',')}|${app.outputs.map((entry) => (approveStepOf(entry) ? `${entry.node}!${approveStepOf(entry)}` : entry.node)).join(',')}`;
      },
      isExposed: (nodeId, paramId) => currentApp().inputs.some((entry) => entry.node === nodeId && entry.param === paramId),
      isOutput: (nodeId) => currentApp().outputs.some((entry) => entry.node === nodeId),
      isApprove: (nodeId) => currentApp().outputs.some((entry) => entry.node === nodeId && approveStepOf(entry) > 0),
      // the step of the approval of an output: 0 without a mark, else 1 to 5
      approveStep: (nodeId) => approveStepOf(currentApp().outputs.find((entry) => entry.node === nodeId)),
      toggleInput: toggleAppInput,
      toggleOutput: toggleAppOutput,
      setApprove: setAppApprove,
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
        runtime.canvas.centerOnWorld(node.x + 148, node.y + 60);
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
    // A private workflow: the link only works for others after it has been shared.
    if (ok && isPrivateOwned(state.workflow)) ui.toast(ui.T('nodes.app.linkCopiedPrivate'), { kind: 'warn', timeout: 8000 });
    else ui.toast(ok ? ui.T('nodes.app.linkCopied') : ui.T('nodes.preview.copyFailed'), { kind: ok ? undefined : 'warn' });
  }

  function appButtonMenu() {
    if (!state.workflow) return;
    const app = currentApp();
    const rect = runtime.dom.appBtn.getBoundingClientRect();
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
      const panel = runtime.dom.inspectorScroll.querySelector('.nv-app-panel');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }


  Object.assign(runtime, {
    MAX_APP_ENTRIES, emptyApp, normalizeApp, approveStepOf, currentApp, moveAppInput, syncAppRemaps,
    pruneApp, scheduleAppMarks, updateAppButton, changeApp, defaultInputLabel, toggleAppInput,
    toggleAppOutput, setAppApprove, moveAppEntry, appApi, openAppView, copyAppLink, appButtonMenu,
    showAppPanel
  });
})(window);
