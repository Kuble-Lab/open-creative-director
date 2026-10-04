'use strict';

// Run UX of the node view (SPEC §9.4, §11.4, §13).
// Part 1 is pure and UMD (module.exports in Node tests, window.OCDNodes.run in the browser): the SSE event
// reducer that turns server events into per-node run status, result helpers (selected variant, history,
// costs), plan descriptions for the confirmation dialog and the status a card should display.
// Part 2 (createController) is the browser glue: topbar run controls, plan / confirm / cancel flows,
// live painting of cards through canvas.setSlot, variant selection, inspector data and downloads.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.run = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'waiting_job']);
  const FINAL_STATUSES = Object.freeze(['cached', 'done', 'error', 'skipped', 'cancelled']);
  const MAX_HISTORY = 30;

  const isActive = (status) => ACTIVE_STATUSES.includes(status);
  const isFinal = (status) => FINAL_STATUSES.includes(status);
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  /* ---------- run state reducer ---------- */

  function createRunState() {
    return {
      runId: null,
      mode: null,
      targets: [],
      active: false,
      status: 'idle', // idle | running | completed | failed | cancelled | interrupted | finished
      nodes: {}, // nodeId -> { status, message?, code?, data?, progress?, startedAt?, endedAt?, entryId? }
      logs: {}, // nodeId -> [label]
      cost: { usd: 0, credits: 0 },
      error: null,
      startedAt: null,
      finishedAt: null,
      resync: false // set when the client learned that a run ended without seeing run_finished
    };
  }

  function freshRun(runId, event, now) {
    return {
      ...createRunState(),
      runId: runId || null,
      mode: (event && event.mode) || null,
      targets: (event && Array.isArray(event.targets) && event.targets) || [],
      active: true,
      status: 'running',
      startedAt: now
    };
  }

  // A different run id than the tracked one means a new run started (this tab may have missed run_started).
  function runFor(state, runId, now) {
    if (!runId) return state.runId ? state : freshRun(null, null, now);
    if (state.runId === runId) return state;
    if (!state.runId && !state.active) return { ...freshRun(runId, null, now) };
    return freshRun(runId, null, now);
  }

  function reduceSnapshot(state, active, now) {
    if (!active) {
      if (!state.active) return state;
      return { ...state, active: false, status: state.status === 'running' ? 'finished' : state.status, finishedAt: now, resync: true };
    }
    const base = state.runId === active.runId ? state : freshRun(active.runId, active, now);
    const nodes = { ...base.nodes };
    for (const [nodeId, status] of Object.entries(active.nodes || {})) {
      const previous = nodes[nodeId] || {};
      const startedAt = previous.startedAt || (status === 'running' || status === 'waiting_job' ? now : undefined);
      nodes[nodeId] = { ...previous, status, ...(startedAt ? { startedAt } : {}), ...(isFinal(status) && !previous.endedAt ? { endedAt: now } : {}) };
    }
    return { ...base, active: true, status: 'running', mode: active.mode || base.mode, nodes, resync: false };
  }

  function reduceNodeStatus(state, event, now) {
    if (!event.nodeId) return state;
    const base = runFor(state, event.runId, now);
    const previous = base.nodes[event.nodeId] || {};
    const status = event.status;
    const next = { ...previous, status };
    if ((status === 'running' || status === 'waiting_job') && !previous.startedAt) next.startedAt = now;
    if (isFinal(status)) next.endedAt = now;
    else delete next.endedAt;
    if (typeof event.message === 'string' && event.message) next.message = event.message;
    else if (status !== 'error' && status !== 'skipped') delete next.message;
    // The stable error code of a failed node (nodes.issue.<code> shows its cause in the interface language).
    if (status === 'error' && typeof event.code === 'string' && event.code) next.code = event.code;
    else delete next.code;
    // The values of that cause (the suggestion of a refused music prompt, a line number …) for the translated text.
    if (status === 'error' && next.code && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) next.data = event.data;
    else delete next.data;
    if (event.progress && isNumber(event.progress.done) && isNumber(event.progress.total)) next.progress = { done: event.progress.done, total: event.progress.total };
    else if (isFinal(status)) delete next.progress;
    return { ...base, active: base.active || !isFinal(status), status: base.status === 'idle' ? 'running' : base.status, nodes: { ...base.nodes, [event.nodeId]: next } };
  }

  // Pure reducer: (state, sse event, now) -> new state. Unknown events leave the state untouched.
  function reduce(state, event, now = Date.now()) {
    if (!event || typeof event.type !== 'string') return state;
    switch (event.type) {
      case 'snapshot':
        return reduceSnapshot(state, event.activeRun || null, now);
      case 'run_started': {
        const same = state.active && state.runId === event.runId;
        const base = same ? state : freshRun(event.runId, event, now);
        const nodes = { ...base.nodes };
        for (const nodeId of Object.keys(event.plan || {})) if (!nodes[nodeId]) nodes[nodeId] = { status: 'queued' };
        return { ...base, active: true, status: 'running', mode: event.mode || base.mode, targets: Array.isArray(event.targets) ? event.targets : base.targets, nodes, resync: false };
      }
      case 'node_status':
        return reduceNodeStatus(state, event, now);
      case 'node_log': {
        if (!event.nodeId || typeof event.label !== 'string') return state;
        const base = runFor(state, event.runId, now);
        const list = [...(base.logs[event.nodeId] || []), event.label].slice(-30);
        return { ...base, logs: { ...base.logs, [event.nodeId]: list } };
      }
      case 'node_result': {
        if (!event.nodeId || !event.entry) return state;
        const base = runFor(state, event.runId, now);
        return { ...base, nodes: { ...base.nodes, [event.nodeId]: { ...(base.nodes[event.nodeId] || {}), entryId: event.entry.id } } };
      }
      case 'run_cost': {
        const base = runFor(state, event.runId, now);
        return { ...base, cost: { usd: isNumber(event.usd) ? event.usd : 0, credits: isNumber(event.credits) ? event.credits : 0 } };
      }
      case 'run_finished': {
        const base = runFor(state, event.runId, now);
        const status = event.status || 'completed';
        const nodes = {};
        for (const [nodeId, node] of Object.entries(base.nodes)) {
          nodes[nodeId] = isActive(node.status) && status !== 'completed' ? { ...node, status: 'cancelled', endedAt: now } : node;
        }
        return { ...base, nodes, active: false, status, error: event.error || null, finishedAt: now, resync: false };
      }
      default:
        return state;
    }
  }

  function clearResync(state) {
    return state.resync ? { ...state, resync: false } : state;
  }

  function activeNodeIds(state) {
    return Object.entries(state.nodes)
      .filter(([, node]) => isActive(node.status))
      .map(([nodeId]) => nodeId);
  }

  function progressOf(state) {
    const all = Object.values(state.nodes);
    return { done: all.filter((node) => isFinal(node.status)).length, total: all.length };
  }

  // Provider work that a cancel cannot stop: nodes waiting for a job, and running nodes that are paid.
  function inFlightNodes(state, isPaid) {
    return Object.entries(state.nodes)
      .filter(([nodeId, node]) => node.status === 'waiting_job' || (node.status === 'running' && Boolean(isPaid && isPaid(nodeId))))
      .map(([nodeId]) => nodeId);
  }

  /* ---------- formatting ---------- */

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (minutes) return `${minutes}:${String(seconds).padStart(2, '0')}`;
    return `${seconds}s`;
  }

  function formatUsd(value) {
    if (!isNumber(value)) return '';
    // Small amounts (single LLM calls, images) keep four decimals so they do not round to $0.02.
    return `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`;
  }

  function formatCredits(value) {
    if (!isNumber(value)) return '';
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // { usd, credits } -> { usd: '$0.0188' | null, credits: '12' | null }; zero and missing amounts are null.
  function costParts(cost) {
    const usd = cost && isNumber(cost.usd) && cost.usd > 0 ? formatUsd(cost.usd) : null;
    const credits = cost && isNumber(cost.credits) && cost.credits > 0 ? formatCredits(cost.credits) : null;
    return { usd, credits };
  }

  /* ---------- results helpers ---------- */

  function nodeResults(results, nodeId) {
    return (results && results.nodes && results.nodes[nodeId]) || null;
  }

  function selectedRef(results, nodeId) {
    const node = nodeResults(results, nodeId);
    return node && node.selected && node.selected.entry ? { entry: node.selected.entry, variant: node.selected.variant || 0 } : null;
  }

  function selectedEntry(results, nodeId) {
    const node = nodeResults(results, nodeId);
    const ref = selectedRef(results, nodeId);
    return node && ref ? (node.history || []).find((entry) => entry.id === ref.entry) || null : null;
  }

  function selectedVariant(results, nodeId) {
    const entry = selectedEntry(results, nodeId);
    const ref = selectedRef(results, nodeId);
    if (!entry || !ref || !Array.isArray(entry.variants) || !entry.variants.length) return null;
    return entry.variants[ref.variant] || entry.variants[0] || null;
  }

  // { entry, entryId, entryIndex, entryCount, variantIndex, variantCount } of the selected result, or null.
  function variantInfo(results, nodeId) {
    const node = nodeResults(results, nodeId);
    const entry = selectedEntry(results, nodeId);
    if (!node || !entry) return null;
    const ref = selectedRef(results, nodeId);
    const variantCount = (entry.variants || []).length;
    return {
      entry,
      entryId: entry.id,
      entryIndex: (node.history || []).findIndex((item) => item.id === entry.id),
      entryCount: (node.history || []).length,
      variantIndex: Math.min(ref.variant, Math.max(0, variantCount - 1)),
      variantCount
    };
  }

  // Immutable: adds a history entry (newest first, capped) and selects its first variant.
  function applyNodeResult(results, nodeId, entry, max = MAX_HISTORY) {
    const base = results && results.nodes ? results : { version: 1, nodes: {} };
    const previous = base.nodes[nodeId] || { selected: null, history: [] };
    const history = [entry, ...(previous.history || []).filter((item) => item.id !== entry.id)].slice(0, max);
    return { ...base, nodes: { ...base.nodes, [nodeId]: { ...previous, history, selected: { entry: entry.id, variant: 0 } } } };
  }

  // Immutable local selection (optimistic; the server answers with the authoritative node results).
  function applySelection(results, nodeId, entryId, variantIndex) {
    const node = nodeResults(results, nodeId);
    if (!node) return results;
    return { ...results, nodes: { ...results.nodes, [nodeId]: { ...node, selected: { entry: entryId, variant: variantIndex } } } };
  }

  function replaceNodeResults(results, nodeId, node) {
    const base = results && results.nodes ? results : { version: 1, nodes: {} };
    return { ...base, nodes: { ...base.nodes, [nodeId]: node } };
  }

  // Next / previous variant inside the selected entry, or null when already at the edge.
  function stepVariant(results, nodeId, delta) {
    const info = variantInfo(results, nodeId);
    if (!info) return null;
    const target = info.variantIndex + delta;
    if (target < 0 || target >= info.variantCount) return null;
    return { entry: info.entryId, variant: target };
  }

  function entryCost(entry) {
    return entry && entry.cost && typeof entry.cost === 'object' ? entry.cost : null;
  }

  // Items of a variant to preview: visible output ports in port order (hidden ports only when asked,
  // e.g. the hidden `result` of output nodes).
  function previewItems(variant, portOrder, hidden, includeHidden) {
    if (!variant) return [];
    const order = Array.isArray(portOrder) ? portOrder : Object.keys(variant);
    const ids = [...order.filter((id) => id in variant), ...Object.keys(variant).filter((id) => !order.includes(id))];
    return ids.filter((id) => includeHidden || !(hidden && hidden.has(id))).map((port) => ({ port, value: variant[port] })).filter((item) => item.value !== undefined && item.value !== null);
  }

  // Every media / text value of a variant, flattened (lists expanded), for downloads and the viewer.
  function flattenValues(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (value.type === 'list' && Array.isArray(value.items)) value.items.forEach((item) => flattenValues(item, out));
    else out.push(value);
    return out;
  }

  // The text result "Use as text" can take over, from the selected variant and the visible outputs of the node:
  //   { reason: 'ok', port, text }  exactly one plain text result
  //   { reason: 'none' }            no text result (the entry is not offered)
  //   { reason: 'multiple' }        several text results (texts on several outputs, or a list of texts and more)
  //   { reason: 'list' }            the one text result is a list of texts
  //   { reason: 'empty', port }     the text is empty
  function textResultOf(variant, outputs) {
    if (!variant) return { reason: 'none' };
    const plain = [];
    let listed = 0;
    for (const port of outputs || []) {
      const value = variant[port.id];
      if (!value || typeof value !== 'object') continue;
      if (value.type === 'text') plain.push({ port: port.id, text: String(value.value ?? '') });
      else if (value.type === 'list') listed += flattenValues(value).filter((item) => item.type === 'text').length;
    }
    if (plain.length + listed === 0) return { reason: 'none' };
    if (plain.length > 1 || listed > 1 || (plain.length && listed)) return { reason: 'multiple' };
    if (listed) return { reason: 'list' };
    if (!plain[0].text.trim()) return { reason: 'empty', port: plain[0].port };
    return { reason: 'ok', port: plain[0].port, text: plain[0].text };
  }

  /* ---------- plan helpers ---------- */

  // Summary of a plan for the confirmation dialog. titleOf(nodeId) provides display names.
  function describePlan(plan, titleOf = (id) => id) {
    const nodes = (plan && plan.nodes) || {};
    const paid = [];
    let willRun = 0;
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.status === 'stale' || node.status === 'forced') willRun += 1;
      if (!node.paid || (node.status !== 'stale' && node.status !== 'forced')) continue;
      const executions = node.executions === null || node.executions === undefined ? null : node.executions;
      const estimate = node.estimate || null;
      const perRun = estimate ? costParts(estimate) : { usd: null, credits: null };
      paid.push({
        nodeId,
        title: titleOf(nodeId),
        executions,
        estimate,
        unknown: !estimate || executions === null,
        usd: estimate && isNumber(estimate.usd) && executions !== null ? estimate.usd * executions : null,
        credits: estimate && isNumber(estimate.credits) && executions !== null ? estimate.credits * executions : null,
        perRun,
        lastCost: node.lastCost || null
      });
    }
    const issues = (plan && plan.issues) || [];
    return {
      paid,
      willRun,
      totals: (plan && plan.totals) || { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 },
      errors: issues.filter((issue) => issue.level === 'error'),
      warnings: issues.filter((issue) => issue.level !== 'error'),
      valid: plan ? plan.valid !== false : true,
      needsConfirm: paid.length > 0,
      // Participants: what is left of the budget ({ remainingUsd, estimateUsd, enough, code? }) and the nodes that
      // are not available for the account ([{ nodeId, feature }]). Both are absent for everybody else.
      budget: plan && plan.budget && typeof plan.budget === 'object' ? plan.budget : null,
      blocked: plan && Array.isArray(plan.blocked) ? plan.blocked : []
    };
  }

  // What stops a participant's run before it starts: nodes of the account's blocked features, a budget that is used up
  // or too small for the estimate. null = nothing in the way (the server checks again when the run starts).
  function gateOf(info) {
    if (!info) return null;
    if (info.blocked && info.blocked.length) return { kind: 'blocked', nodeIds: info.blocked.map((item) => item.nodeId) };
    const budget = info.budget;
    if (budget && budget.enough === false) {
      return { kind: budget.code === 'BUDGET_EXHAUSTED' ? 'exhausted' : 'insufficient', budget };
    }
    return null;
  }

  // The line in the confirmation dialog of a paid run: what is left and what this run is estimated at.
  function budgetLine(info, T, money) {
    const budget = info && info.budget;
    if (!budget) return null;
    const remaining = money(Math.max(0, Number(budget.remainingUsd) || 0));
    return Number(budget.estimateUsd) > 0
      ? T('nodes.run.confirm.budget', { remaining, estimate: money(Number(budget.estimateUsd)) })
      : T('nodes.run.confirm.budgetUnknown', { remaining });
  }

  // The status a card shows, combining the live run state with the (stale-marking) plan.
  // Returns { status, message? } where status may be a run status or one of
  // stale | notrun | invalid | unavailable | null (no badge).
  function displayStatus({ run, planNode, hasResults, category }) {
    const runStatus = run && run.status;
    if (isActive(runStatus)) return { status: runStatus };
    if (runStatus === 'error' || runStatus === 'skipped' || runStatus === 'cancelled') {
      return { status: runStatus, message: run.message || null, ...(runStatus === 'error' && run.code ? { code: run.code } : {}), ...(runStatus === 'error' && run.code && run.data ? { data: run.data } : {}) };
    }
    const planStatus = planNode && planNode.status;
    if (planStatus === 'invalid') {
      // reasonCode / reasonData (from an issue with a code) let the UI show a translated text.
      const shown = { status: 'invalid', message: planNode.reason || null };
      if (planNode.reasonCode) shown.code = planNode.reasonCode;
      if (planNode.reasonData) shown.data = planNode.reasonData;
      if (planNode.reasonPort) shown.port = planNode.reasonPort;
      return shown;
    }
    if (planStatus === 'unavailable') return { status: 'unavailable', message: planNode.reason || null };
    if (planStatus === 'stale' || planStatus === 'forced') {
      if (category === 'input') return { status: runStatus || null };
      return { status: hasResults ? 'stale' : 'notrun' };
    }
    return { status: runStatus || null };
  }

  // A failed node whose cause has a translated text (nodes.issue.<code>, e.g. an image the provider refused) shows it in
  // the interface language; any other error keeps the engine's message.
  function localizeError(shown, ui) {
    if (shown && shown.status === 'error' && shown.code && ui.hasIssueText(shown.code)) {
      return { ...shown, message: ui.issueText({ code: shown.code, data: shown.data, message: shown.message }) };
    }
    return shown;
  }

  function buildRunRequest({ mode, nodeIds, force, rev, nodeId, items }) {
    const request = { mode, force: Boolean(force) };
    if (mode === 'items') {
      // single items of the list of one node made again (the scene table of the inspector)
      request.nodeId = nodeId;
      request.items = Array.isArray(items) ? items.slice() : [];
    } else if (mode !== 'all') {
      request.nodeIds = Array.isArray(nodeIds) ? nodeIds.slice() : [];
    }
    if (Number.isInteger(rev)) request.rev = rev;
    return request;
  }

  /* ---------- length of the music nodes ---------- */

  // The node that feeds an input and its text, from the selected result of that node: { nodeId, text } with text null
  // where there is no result yet (or it is no plain text); null where nothing is connected to the input.
  function connectedText(graph, results, nodeId, portId) {
    const edge = ((graph && graph.edges) || []).find((item) => item.to.node === nodeId && item.to.port === portId);
    if (!edge) return null;
    const variant = selectedVariant(results, edge.from.node);
    const value = variant ? variant[edge.from.port] : null;
    return { nodeId: edge.from.node, text: value && value.type === 'text' && typeof value.value === 'string' ? value.value : null };
  }

  // What the card and the inspector of a music node say about the length of the song (the numbers are milliseconds, the
  // wording is the interface's): for "Generate music" where the length comes from the song text or the video instead of
  // its own setting, for "Song text and structure" the length of its result.
  //   { kind: 'field' | 'plan', ms, nodeId? }   nodeId: the connected song text node (the line leads there)
  //   { kind: 'video' }
  //   { kind: 'result', ms, count }
  // overrides.planText: the text of the song text field as typed right now (the saved graph lags behind while typing).
  function musicLengthInfo(node, graph, results, musicPlan, overrides = {}) {
    if (!node || !musicPlan) return null;
    if (node.type === 'audio.music_plan') {
      const variant = selectedVariant(results, node.id);
      const value = variant ? variant.plan : null;
      const summary = value && value.type === 'text' && typeof value.value === 'string' ? musicPlan.describe(value.value) : null;
      return summary ? { kind: 'result', ms: summary.ms, count: summary.count } : null;
    }
    if (node.type !== 'audio.music') return null;
    const plan = connectedText(graph, results, node.id, 'plan');
    const match = connectedText(graph, results, node.id, 'match');
    const planText = overrides.planText !== undefined ? overrides.planText : node.params && node.params.plan;
    const source = musicPlan.lengthSource({
      planText,
      planConnected: Boolean(plan),
      connectedText: plan ? plan.text : null,
      matchConnected: Boolean(match)
    });
    if (!source) return null;
    return source.kind === 'plan' ? { ...source, nodeId: plan.nodeId } : source;
  }

  const pure = {
    ACTIVE_STATUSES,
    FINAL_STATUSES,
    MAX_HISTORY,
    isActive,
    isFinal,
    createRunState,
    reduce,
    clearResync,
    activeNodeIds,
    progressOf,
    inFlightNodes,
    formatDuration,
    formatUsd,
    formatCredits,
    costParts,
    nodeResults,
    selectedRef,
    selectedEntry,
    selectedVariant,
    variantInfo,
    applyNodeResult,
    applySelection,
    replaceNodeResults,
    stepVariant,
    entryCost,
    previewItems,
    flattenValues,
    textResultOf,
    connectedText,
    musicLengthInfo,
    describePlan,
    gateOf,
    budgetLine,
    displayStatus,
    localizeError,
    buildRunRequest
  };

  /* ---------- browser controller ---------- */

  // deps: { OCD } (the window.OCDNodes namespace). All other modules are read lazily from it.
  function createController(deps) {
    const OCD = deps.OCD;
    const graphLib = OCD.graph;
    const api = OCD.api;
    const ui = OCD.ui;
    const bus = OCD.bus;
    const { el, icon } = ui;
    const T = ui.T;

    let runState = createRunState();
    let plan = null;
    let planRev = null;
    let planTimer = null;
    let planToken = 0;
    let recentRuns = [];
    let tickTimer = null;
    let pollTimer = null;
    let paintTimer = 0;
    let starting = false;
    const dirtyNodes = new Set();
    const painted = new Set();
    let paintAllNext = false;
    const parts = {};
    let attached = false;

    const S = () => OCD.editor.getState();
    const canvas = () => OCD.editor.getCanvas();
    const workflowId = () => (S().workflow ? S().workflow.id : null);
    const defOf = (nodeId) => {
      const st = S();
      const node = st.graph.nodes.find((item) => item.id === nodeId);
      return node && st.reg ? st.reg.types.get(node.type) || null : null;
    };
    const nodeOf = (nodeId) => S().graph.nodes.find((item) => item.id === nodeId) || null;
    const titleOf = (nodeId) => {
      const node = nodeOf(nodeId);
      if (!node) return nodeId;
      const def = defOf(nodeId);
      return node.title || (def ? ui.typeLabel(def) : node.type);
    };

    /* ----- length of the music nodes ----- */

    const clock = (ms) => {
      const seconds = Math.round(ms / 1000);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };

    // The line about the length of a music node: { text, nodeId } (nodeId: where a click leads), or null. A song text in the
    // field is judged by the same module as on the server; overrides.planText is the field as typed right now.
    function lengthNote(nodeId, overrides) {
      const node = nodeOf(nodeId);
      const st = S();
      if (!node || !st.reg) return null;
      const info = musicLengthInfo(node, st.graph, st.results, OCD.musicPlan, overrides);
      if (!info) return null;
      const duration = info.ms === null || info.ms === undefined ? '' : clock(info.ms);
      if (info.kind === 'result') return { text: T('nodes.music.planResult', { duration, count: info.count }), nodeId: null };
      if (info.kind === 'video') return { text: T('nodes.music.length.video'), nodeId: null };
      if (info.kind === 'field') return { text: T(duration ? 'nodes.music.length.field' : 'nodes.music.length.fieldUnknown', { duration }), nodeId: null };
      return { text: T(duration ? 'nodes.music.length.plan' : 'nodes.music.length.planUnknown', { duration, name: titleOf(info.nodeId) }), nodeId: info.nodeId };
    }
    // What the cards showed last, to paint a music card when its line changes (a song text typed in the field, a new result).
    const lengthNotes = new Map();

    /* ----- formatting with i18n ----- */

    function costText(cost, options = {}) {
      const p = costParts(cost);
      const pieces = [];
      if (p.usd) pieces.push(options.estimate ? T('nodes.cost.estimate', { amount: p.usd }) : p.usd);
      if (p.credits) pieces.push(options.estimate ? T('nodes.cost.creditsEstimate', { credits: p.credits }) : T('nodes.cost.credits', { credits: p.credits }));
      return pieces.join(' · ');
    }

    /* ----- painting ----- */

    function hiddenPorts(node) {
      const st = S();
      return new Set(graphLib.portsFor(st.reg, node).outputs.filter((port) => port.hidden).map((port) => port.id));
    }

    function outputOrder(node) {
      return graphLib.portsFor(S().reg, node).outputs.map((port) => port.id);
    }

    function statusTooltip(status, message) {
      return message || T(`nodes.statusHint.${status}`) || '';
    }

    // What to show for a node. The plan lags behind an edit by the autosave and a second: a "missing input" it still
    // reports, but the graph has already filled (a node put in front, a value typed), shows as not run yet instead of
    // as a stale complaint; the next plan confirms.
    function shownFor(node, def, run, planNode, hasResults) {
      const shown = displayStatus({ run, planNode, hasResults, category: def && def.category });
      const st = S();
      if (shown.status === 'invalid' && shown.code === 'missing_input' && st.reg && !graphLib.missingInputs(st.reg, st.graph, node.id).length) {
        return { status: hasResults ? 'stale' : 'notrun' };
      }
      return localizeError(shown, ui);
    }

    // Text and one-click remedy of an invalid node. The cause has a translated text (nodes.issue.<code>) when it comes
    // with a code. Free text in the HTML field of a Motion graphics node offers the conversion (when it is possible);
    // a missing required input is named by its label and gets a button: the node named by the input's `suggest` hint
    // goes in front of it (one undo step), else the quick pick opens for exactly that input.
    function invalidInfo(node, shown) {
      const st = S();
      const fallback = { message: shown.message || null, fix: null };
      if (!ui.hasIssueText(shown.code)) return fallback;
      const data = { ...(shown.data || {}) };
      let variant;
      let fix = null;
      if (shown.code === 'not_html') {
        const offer = graphLib.canConvertMotionHtml(st.reg, st.graph, node.id);
        if (!offer) variant = 'plain';
        else fix = { id: 'motion-html', label: T('nodes.motion.convert'), title: T('nodes.motion.convertTitle'), icon: 'sparkle' };
      } else if (shown.code === 'missing_input') {
        // the graph is always newer than the plan: name what is missing now, not what the plan saw
        const missing = graphLib.missingInputs(st.reg, st.graph, node.id);
        if (missing.length) {
          data.port = missing.map((port) => ui.portLabel(port.id)).join(', ');
          if (missing.length > 1) variant = 'many';
          else if (missing[0].param && ['text', 'number'].includes(graphLib.parseType(missing[0].type)?.base)) variant = 'param';
          const hinted = missing.find((port) => {
            const source = graphLib.sourceFor(st.reg, port);
            return source && source.hinted;
          });
          if (hinted) {
            const name = ui.typeLabel(st.reg.types.get(graphLib.sourceFor(st.reg, hinted).type));
            fix = { id: 'add-input', port: hinted.id, label: T('nodes.fix.addInput', { name }), title: T('nodes.fix.addInputTitle', { name, port: ui.portLabel(hinted.id) }), icon: 'plus' };
          } else {
            fix = { id: 'pick-input', port: missing[0].id, label: T('nodes.fix.pickInput'), title: T('nodes.fix.pickInputTitle', { port: ui.portLabel(missing[0].id) }), icon: 'search' };
          }
        } else if (shown.port) {
          data.port = ui.portLabel(shown.port);
        }
      }
      return { message: ui.issueText({ code: shown.code, data, port: shown.port, message: shown.message }, variant), fix };
    }

    function slotFor(node) {
      const st = S();
      const def = st.reg.types.get(node.type) || null;
      const run = runState.nodes[node.id];
      const info = variantInfo(st.results, node.id);
      const planNode = plan && plan.nodes ? plan.nodes[node.id] : null;
      const shown = shownFor(node, def, run, planNode, Boolean(info));
      const status = shown.status;
      // Invalid nodes whose cause has a translated text (nodes.issue.<code>) show it on the card, with a remedy button.
      const invalid = status === 'invalid' ? invalidInfo(node, shown) : null;
      const translated = invalid && ui.hasIssueText(shown.code) ? invalid.message : null;
      if (translated) shown.message = translated;
      const slot = {
        status: status || '',
        label: status ? ui.statusLabel(status) : '',
        message: null,
        fix: null,
        tooltip: status ? statusTooltip(status, status === 'error' ? null : shown.message) : '',
        since: null,
        progress: null,
        busy: runState.active || starting,
        canRun: Boolean(def) && def.available === true,
        working: isActive(status)
      };
      if (status === 'error') slot.message = shown.message || T('nodes.run.failedNode');
      if (translated) {
        slot.message = translated;
        slot.fix = invalid.fix;
      }
      if (status === 'skipped') {
        const blocked = /^blocked by (\S+)$/.exec(shown.message || '');
        slot.message = blocked ? T('nodes.run.blockedBy', { name: titleOf(blocked[1]) }) : shown.message || T('nodes.run.skipped');
      }
      if ((status === 'running' || status === 'waiting_job') && run && run.startedAt) slot.since = run.startedAt;
      if (isActive(status) && run && run.progress) slot.progress = run.progress;
      if (status === 'waiting_job' && run && !run.progress) slot.tooltip = T('nodes.statusHint.waiting_job');

      // preview of the selected result (inputs already show their asset in the widget)
      let items = [];
      if (def && def.category !== 'input') {
        const variant = selectedVariant(st.results, node.id);
        items = previewItems(variant, outputOrder(node), hiddenPorts(node), def.category === 'output');
      }
      slot.preview = items;
      const note = node.type === 'audio.music' || node.type === 'audio.music_plan' ? lengthNote(node.id) : null;
      lengthNotes.set(node.id, note ? note.text : '');
      slot.note = note;
      slot.pager = info && info.variantCount > 1 ? { index: info.variantIndex, total: info.variantCount } : null;

      // cost: last actual cost of the selected result, else the plan's estimate for paid nodes
      const actual = info ? costText(entryCost(info.entry)) : '';
      if (actual) {
        slot.cost = actual;
        slot.costKind = 'actual';
        slot.costTitle = T('nodes.cost.actualHint');
      } else if (def && def.paid && planNode && (planNode.status === 'stale' || planNode.status === 'forced') && !isActive(status)) {
        const executions = planNode.executions === null || planNode.executions === undefined ? null : planNode.executions;
        const est = planNode.estimate;
        if (est && executions !== null) {
          const total = { usd: isNumber(est.usd) ? est.usd * executions : undefined, credits: isNumber(est.credits) ? est.credits * executions : undefined };
          slot.cost = costText(total, { estimate: true });
          slot.costKind = 'estimate';
          slot.costTitle = T('nodes.cost.estimateHint');
        } else {
          slot.cost = T('nodes.cost.unknown');
          slot.costKind = 'estimate';
          slot.costTitle = T('nodes.cost.unknownHint');
        }
      } else {
        slot.cost = '';
      }
      return slot;
    }

    function flushPaint() {
      paintTimer = 0;
      const st = S();
      if (!st.workflow || !st.reg || !canvas()) return;
      const ids = paintAllNext ? st.graph.nodes.map((node) => node.id) : [...dirtyNodes];
      paintAllNext = false;
      dirtyNodes.clear();
      const known = new Set(st.graph.nodes.map((node) => node.id));
      for (const id of ids) {
        if (!known.has(id)) continue;
        canvas().setSlot(id, slotFor(nodeOf(id)));
        painted.add(id);
      }
      updateTopbar();
      const inspector = OCD.editor.getInspector();
      if (inspector && inspector.refreshRun) inspector.refreshRun();
    }

    function schedulePaint(nodeIds) {
      if (!nodeIds) paintAllNext = true;
      else for (const id of nodeIds) dirtyNodes.add(id);
      if (!paintTimer) paintTimer = requestAnimationFrame(flushPaint);
    }

    /* ----- topbar ----- */

    function buildTopbar() {
      const host = OCD.editor.dom().runSlot;
      host.textContent = '';
      parts.runAll = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-run-all', dataset: { tKey: 'nodes.run.allTitle' } }, icon('play', 12), el('span', { class: 'nv-btn-text', dataset: { tText: 'nodes.run.all' } }));
      parts.runSel = el('button', { type: 'button', class: 'nv-btn nv-run-sel', dataset: { tKey: 'nodes.run.selectionTitle' } }, icon('skip', 13), el('span', { class: 'nv-btn-text' }));
      parts.cancel = el('button', { type: 'button', class: 'nv-btn nv-run-cancel hidden', dataset: { tKey: 'nodes.run.cancelTitle' } }, icon('stop', 12), el('span', { class: 'nv-btn-text', dataset: { tText: 'nodes.run.cancel' } }));
      parts.summary = el('span', { class: 'nv-run-summary hidden', role: 'status' });
      parts.runAll.addEventListener('click', () => startRun({ mode: 'all', force: false }));
      parts.runSel.addEventListener('click', () => runSelection());
      parts.cancel.addEventListener('click', () => cancelRun());
      host.append(parts.summary, parts.cancel, parts.runSel, parts.runAll);
      relabelTopbar();
    }

    function relabelTopbar() {
      if (!parts.runAll) return;
      for (const node of [parts.runAll, parts.runSel, parts.cancel]) {
        const title = T(node.dataset.tKey);
        node.title = title;
        node.setAttribute('aria-label', title);
      }
      parts.runAll.querySelector('.nv-btn-text').textContent = T('nodes.run.all');
      parts.cancel.querySelector('.nv-btn-text').textContent = T('nodes.run.cancel');
      updateTopbar();
    }

    function selectedNodeIds() {
      return [...S().selection.nodes];
    }

    function updateTopbar() {
      if (!parts.runAll) return;
      const st = S();
      const has = Boolean(st.workflow);
      const busy = runState.active || starting;
      parts.runAll.disabled = !has || busy;
      const count = has ? selectedNodeIds().length : 0;
      parts.runSel.disabled = !has || busy || count === 0;
      parts.runSel.querySelector('.nv-btn-text').textContent = count > 1 ? T('nodes.run.selectionCount', { count }) : T('nodes.run.selection');
      parts.cancel.classList.toggle('hidden', !runState.active);
      parts.runAll.classList.toggle('hidden', !has);
      parts.runSel.classList.toggle('hidden', !has);

      let text = '';
      let title = '';
      let state = '';
      if (runState.active) {
        const progress = progressOf(runState);
        const cost = costText(runState.cost);
        text = [T('nodes.run.running'), progress.total ? T('nodes.run.progress', { done: progress.done, total: progress.total }) : '', cost].filter(Boolean).join(' · ');
        state = 'running';
      } else if (runState.runId && runState.status !== 'idle') {
        const cost = costText(runState.cost);
        text = [T(`nodes.run.result.${runState.status}`), cost].filter(Boolean).join(' · ');
        state = runState.status;
        title = T('nodes.run.lastRunHint');
      } else if (recentRuns.length) {
        const last = recentRuns[0];
        const cost = costText(last.cost);
        text = [T('nodes.run.lastRun'), cost || T(`nodes.run.result.${last.status}`)].filter(Boolean).join(' · ');
        state = last.status;
        title = `${T(`nodes.run.result.${last.status}`)} · ${last.user || ''} · ${last.startedAt ? new Date(last.startedAt).toLocaleString() : ''}`;
      }
      parts.summary.textContent = text;
      parts.summary.title = title;
      parts.summary.dataset.state = state;
      parts.summary.classList.toggle('hidden', !has || !text);
    }

    /* ----- ticker and polling ----- */

    function startTimers() {
      if (!tickTimer) {
        tickTimer = setInterval(() => {
          const now = Date.now();
          for (const node of document.querySelectorAll('.nv-node .nv-status-time, .nv-run-line .nv-status-time')) {
            const since = Number(node.dataset.since);
            if (since) node.textContent = formatDuration(now - since);
          }
        }, 1000);
      }
      if (!pollTimer) pollTimer = setInterval(pollRun, 4000);
    }

    function stopTimers() {
      clearInterval(tickTimer);
      clearInterval(pollTimer);
      tickTimer = null;
      pollTimer = null;
    }

    // Safety net next to the SSE stream: the run record repairs missed events and a lost run_finished.
    async function pollRun() {
      const id = workflowId();
      if (!id || !runState.active || !runState.runId) return;
      try {
        const record = await api.getRun(id, runState.runId);
        if (workflowId() !== id || !runState.active || runState.runId !== record.id) return;
        if (record.status !== 'running') {
          dispatch({ type: 'run_finished', runId: record.id, status: record.status, error: record.error });
          return;
        }
        const nodes = {};
        for (const [nodeId, node] of Object.entries(record.nodes || {})) nodes[nodeId] = node.status;
        dispatch({ type: 'snapshot', activeRun: { runId: record.id, mode: record.mode, nodes } });
        const results = S().results;
        const missing = Object.entries(record.nodes || {}).some(([nodeId, node]) => node.entry && !(nodeResults(results, nodeId)?.history || []).some((entry) => entry.id === node.entry));
        if (missing) refreshResults();
      } catch (_) {
        /* the stream is the primary channel */
      }
    }

    /* ----- events ----- */

    function dispatch(event) {
      const before = runState;
      runState = reduce(runState, event);
      if (event.type === 'node_result' && event.entry && event.nodeId) {
        const st = S();
        st.results = applyNodeResult(st.results, event.nodeId, event.entry);
        schedulePaint([event.nodeId, ...descendantIds(event.nodeId)]);
      }
      if (runState.active && !before.active) {
        plan = null;
        clearTimeout(planTimer);
        startTimers();
      }
      if (!runState.active && before.active) {
        stopTimers();
        onRunEnded(event);
      }
      if (runState.resync) {
        runState = clearResync(runState);
        onRunEnded({ type: 'snapshot' });
      }
      if (event.type === 'node_status' && event.nodeId) schedulePaint([event.nodeId]);
      else if (event.type !== 'node_result' && event.type !== 'node_log') schedulePaint();
      else updateTopbar();
      if (event.type === 'node_log') {
        const inspector = OCD.editor.getInspector();
        if (inspector && inspector.refreshRun) inspector.refreshRun();
      }
    }

    function descendantIds(nodeId) {
      return [...graphLib.descendants(S().graph, [nodeId])];
    }

    async function onRunEnded(event) {
      refreshBudget();
      await refreshResults();
      schedulePlan(0);
      loadRecentRuns();
      schedulePaint();
      const status = runState.status;
      if (event && event.type === 'run_finished') {
        if (status === 'completed') ui.toast(T('nodes.run.toast.completed'));
        else if (status === 'failed') ui.toast(T('nodes.run.toast.failed'), { kind: 'error' });
        else if (status === 'cancelled') ui.toast(T('nodes.run.toast.cancelled'), { kind: 'warn' });
        else if (status === 'interrupted') ui.toast(T('nodes.run.toast.interrupted'), { kind: 'warn' });
      }
    }

    async function refreshResults() {
      const id = workflowId();
      if (!id) return;
      try {
        const payload = await api.getWorkflow(id);
        if (workflowId() !== id) return;
        S().results = payload.results;
        schedulePaint();
      } catch (_) {
        /* keep the local results */
      }
    }

    /* ----- plan ----- */

    function schedulePlan(delay = 1000, options = {}) {
      clearTimeout(planTimer);
      if (!workflowId()) return;
      planTimer = setTimeout(() => refreshPlan(options), delay);
    }

    async function refreshPlan() {
      const id = workflowId();
      if (!id || runState.active) return;
      const token = ++planToken;
      try {
        const result = await api.plan(id, { mode: 'all', force: false });
        if (token !== planToken || workflowId() !== id || runState.active) return;
        plan = result;
        planRev = S().rev;
        schedulePaint();
      } catch (_) {
        if (token === planToken) {
          plan = null;
          schedulePaint();
        }
      }
    }

    async function loadRecentRuns() {
      const id = workflowId();
      if (!id) return;
      try {
        const payload = await api.listRuns(id, 5);
        if (workflowId() !== id) return;
        recentRuns = payload.runs || [];
        updateTopbar();
        const inspector = OCD.editor.getInspector();
        if (inspector && inspector.refreshRun) inspector.refreshRun();
      } catch (_) {
        recentRuns = [];
      }
    }

    /* ----- starting and cancelling ----- */

    function issueList(issues) {
      const list = el('ul', { class: 'nv-confirm-list is-issues' });
      for (const issue of issues) {
        const item = el('li', {});
        const label = issue.nodeId ? titleOf(issue.nodeId) : '';
        if (label) {
          const link = el('button', { type: 'button', class: 'nv-link', text: label });
          link.addEventListener('click', () => focusNode(issue.nodeId));
          item.append(link, ': ');
        }
        item.append(el('span', { text: ui.issueText(issue) }));
        list.append(item);
      }
      return list;
    }

    function focusNode(nodeId) {
      const c = canvas();
      c.setSelection({ nodes: [nodeId], notes: [], groups: [], edge: null });
      const node = nodeOf(nodeId);
      if (node) c.centerOnWorld(node.x + 148, node.y + 60);
    }

    async function showIssues(issues) {
      await ui.dialog({
        title: T('nodes.run.invalid.title'),
        message: T('nodes.run.invalid.body'),
        body: issueList(issues.filter((issue) => issue.level === 'error')),
        buttons: [{ label: T('nodes.common.close'), value: true, primary: true, cancel: true }]
      });
    }

    // Dollar amounts of the budget (participants) as the account menu shows them.
    const money = (value) => (window.OCAccess && window.OCAccess.formatUsd ? window.OCAccess.formatUsd(value) : `$${Number(value || 0).toFixed(2)}`);
    const accountRuleText = (error) => (window.OCAccess && window.OCAccess.accountRuleMessage ? window.OCAccess.accountRuleMessage(error) : null);
    const refreshBudget = () => {
      if (window.OCAccess && window.OCAccess.me().restricted) window.OCAccess.refreshMe().catch(() => {});
    };

    // The toast of a run that cannot start: a refusal with a stable reason that has a translated text (nodes.issue.<reason>,
    // e.g. ITEMS_OUT_OF_RANGE with {item} and {length}) shows it, any other error shows the server's English message.
    const startFailedText = (error) => {
      if (error && typeof error.reason === 'string' && ui.hasIssueText && ui.hasIssueText(error.reason)) {
        return ui.issueText({ code: error.reason, data: error.params || {}, message: error.message });
      }
      return T('nodes.run.startFailed', { error: error.message });
    };

    // A participant's run that cannot start: the budget is used up or too small, or nodes need a feature the account
    // does not have. Nothing is started and nothing is asked.
    async function showGate(gate) {
      const body = el('div', { class: 'nv-confirm' });
      let message;
      if (gate.kind === 'blocked') {
        message = T('nodes.run.blocked.body');
        const list = el('ul', { class: 'nv-confirm-list is-issues' });
        for (const nodeId of gate.nodeIds) list.append(el('li', {}, el('span', { text: titleOf(nodeId) })));
        body.append(list);
      } else if (gate.kind === 'exhausted') {
        message = T('nodes.run.budget.exhausted');
      } else {
        message = T('nodes.run.budget.insufficient', { estimate: money(gate.budget.estimateUsd), remaining: money(Math.max(0, gate.budget.remainingUsd)) });
      }
      await ui.dialog({
        title: T(gate.kind === 'blocked' ? 'nodes.run.blocked.title' : 'nodes.run.budget.title'),
        message,
        body,
        buttons: [{ label: T('nodes.common.close'), value: true, primary: true, cancel: true }]
      });
    }

    async function confirmPaid(info) {
      const body = el('div', { class: 'nv-confirm' });
      body.append(el('p', { class: 'nv-confirm-intro', text: T('nodes.run.confirm.intro') }));
      const list = el('ul', { class: 'nv-confirm-list' });
      for (const row of info.paid) {
        const item = el('li', {});
        item.append(el('span', { class: 'nv-confirm-name', text: row.title }));
        if (row.executions && row.executions > 1) item.append(el('span', { class: 'nv-confirm-times', text: `× ${row.executions}` }));
        const amount = row.unknown ? T('nodes.run.confirm.unknown') : costText({ usd: row.usd ?? undefined, credits: row.credits ?? undefined }, { estimate: true }) || T('nodes.run.confirm.unknown');
        item.append(el('span', { class: `nv-confirm-cost ${row.unknown ? 'is-unknown' : ''}`.trim(), text: amount }));
        list.append(item);
      }
      body.append(list);
      const totals = info.totals;
      const summary = [];
      const totalCost = costText({ usd: totals.usd, credits: totals.credits }, { estimate: true });
      if (totalCost) summary.push(T('nodes.run.confirm.total', { amount: totalCost }));
      if (totals.unknownNodes) summary.push(T('nodes.run.confirm.unknownCount', { count: totals.unknownNodes }));
      if (summary.length) body.append(el('p', { class: 'nv-confirm-total', text: summary.join(' · ') }));
      body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.estimateNote') }));
      if (totals.credits > 0) body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.creditsNote') }));
      body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.noRefund') }));
      const budgetText = budgetLine(info, T, money);
      if (budgetText) body.append(el('p', { class: 'nv-confirm-budget', text: budgetText }));
      if (info.warnings.length) {
        body.append(el('h3', { class: 'nv-confirm-sub', text: T('nodes.run.confirm.warnings') }), issueList(info.warnings));
      }
      return ui.dialog({
        title: T('nodes.run.confirm.title', { count: info.paid.length }),
        body,
        width: 480,
        focus: 'cancel',
        buttons: [
          { label: T('nodes.common.cancel'), value: false, cancel: true },
          { label: T('nodes.run.confirm.start'), value: true, primary: true, enter: false }
        ]
      });
    }

    async function startRun({ mode, nodeIds, force, nodeId, items }) {
      const st = S();
      if (!st.workflow || !st.reg) return;
      if (runState.active || starting) {
        ui.toast(T('nodes.run.alreadyRunning'), { kind: 'warn' });
        return;
      }
      if (st.conflict) {
        ui.toast(T('nodes.run.conflict'), { kind: 'warn' });
        return;
      }
      starting = true;
      updateTopbar();
      schedulePaint();
      // descriptions of models that are out of date are read again: the cards show the limit the server will apply
      ui.refreshStaleModelDetails();
      try {
        try {
          await OCD.editor.flushSave();
        } catch (error) {
          ui.toast(T('nodes.run.saveFailed', { error: error.message }), { kind: 'error' });
          return;
        }
        if (S().conflict || S().saveState === 'conflict' || S().saveState === 'offline') {
          ui.toast(T('nodes.run.conflict'), { kind: 'warn' });
          return;
        }
        const id = st.workflow.id;
        const request = buildRunRequest({ mode, nodeIds, force, nodeId, items });
        let planned;
        try {
          planned = await api.plan(id, request);
        } catch (error) {
          if (error.issues) await showIssues(error.issues);
          else ui.toast(startFailedText(error), { kind: 'error' });
          return;
        }
        const info = describePlan(planned, titleOf);
        if (!info.valid) {
          plan = planned;
          schedulePaint();
          await showIssues(info.errors);
          return;
        }
        const gate = gateOf(info);
        if (gate) {
          await showGate(gate);
          return;
        }
        if (info.needsConfirm) {
          const confirmed = await confirmPaid(info);
          if (!confirmed) return;
        }
        try {
          const started = await api.startRun(id, { ...request, rev: S().rev });
          if (workflowId() === id && !runState.active) dispatch({ type: 'run_started', runId: started.runId, mode, targets: planned.targets || nodeIds || (nodeId ? [nodeId] : []), plan: Object.fromEntries((planned.order || []).map((nodeId) => [nodeId, 'queued'])) });
        } catch (error) {
          if (error.status === 409 && error.code === 'RUN_ACTIVE') {
            ui.toast(T('nodes.run.alreadyRunning'), { kind: 'warn' });
            if (error.runId) dispatch({ type: 'snapshot', activeRun: { runId: error.runId, mode: null, nodes: {} } });
          } else if (error.status === 409) {
            ui.toast(T('nodes.run.conflict'), { kind: 'warn' });
          } else if (error.status === 429) {
            ui.toast(T('nodes.run.limit'), { kind: 'warn' });
          } else if (accountRuleText(error)) {
            ui.toast(accountRuleText(error), { kind: 'warn' });
            refreshBudget();
          } else if (error.issues) {
            await showIssues(error.issues);
          } else {
            ui.toast(startFailedText(error), { kind: 'error' });
          }
        }
      } finally {
        starting = false;
        updateTopbar();
        schedulePaint();
      }
    }

    function runNode(nodeId) {
      return startRun({ mode: 'node', nodeIds: [nodeId], force: true });
    }

    function runFrom(nodeId) {
      const ids = [nodeId, ...descendantIds(nodeId).filter((id) => id !== nodeId)];
      return startRun({ mode: ids.length > 1 ? 'selection' : 'node', nodeIds: ids, force: false });
    }

    // Single items of the list of a node made again (the scene table): the run goes through the same plan, confirmation and budget
    // steps as every run; the items that are not asked for come from the selected result
    function runItems(nodeId, items) {
      const request = OCD.sceneTable.itemsRequest(nodeId, items);
      if (!request.items.length) return Promise.resolve();
      return startRun({ mode: 'items', nodeId, items: request.items, force: false });
    }

    // The scene table of a node as data (see public/nodes/scene-table.js), or null; `busy` and `canRun` say whether a button can start a run now
    function scenesOf(nodeId) {
      const st = S();
      const node = nodeOf(nodeId);
      const def = defOf(nodeId);
      if (!node || !def || !st.reg || !OCD.sceneTable) return null;
      const entry = selectedEntry(st.results, nodeId);
      const variant = selectedVariant(st.results, nodeId);
      const ports = graphLib.portsFor(st.reg, node);
      const table = OCD.sceneTable.sceneTable({
        nodeId,
        category: def.category,
        entry,
        variant,
        order: outputOrder(node),
        hidden: hiddenPorts(node),
        inputPorts: ports.inputs,
        edges: st.graph.edges,
        upstreamVariant: (id) => selectedVariant(st.results, id)
      });
      if (!table) return null;
      const planNode = plan && plan.nodes ? plan.nodes[nodeId] : null;
      return {
        ...table,
        entryId: entry ? entry.id : null,
        cost: OCD.sceneTable.itemCost(planNode, def),
        busy: runState.active || starting,
        canRun: def.available === true
      };
    }

    function runSelection() {
      const ids = selectedNodeIds();
      if (!ids.length) {
        ui.toast(T('nodes.run.needSelection'), { kind: 'warn' });
        return Promise.resolve();
      }
      return startRun({ mode: ids.length === 1 ? 'node' : 'selection', nodeIds: ids, force: true });
    }

    async function cancelRun() {
      const id = workflowId();
      if (!id || !runState.active || !runState.runId) return;
      const flight = inFlightNodes(runState, (nodeId) => Boolean(defOf(nodeId) && defOf(nodeId).paid));
      if (flight.length) {
        const confirmed = await ui.confirmDialog({
          title: T('nodes.run.cancelWarn.title'),
          message: T('nodes.run.cancelWarn.message'),
          confirmLabel: T('nodes.run.cancelWarn.confirm'),
          cancelLabel: T('nodes.run.cancelWarn.keep'),
          danger: true
        });
        if (!confirmed) return;
      }
      try {
        const result = await api.cancelRun(id, runState.runId);
        if (!result.ok) ui.toast(T('nodes.run.cancelGone'), { kind: 'warn' });
      } catch (error) {
        ui.toast(T('nodes.run.cancelFailed', { error: error.message }), { kind: 'error' });
      }
    }

    /* ----- variant selection ----- */

    async function selectVariant(nodeId, entryId, variantIndex) {
      const id = workflowId();
      const st = S();
      const current = selectedRef(st.results, nodeId);
      if (!id || (current && current.entry === entryId && current.variant === variantIndex)) return;
      const previous = st.results;
      st.results = applySelection(st.results, nodeId, entryId, variantIndex);
      schedulePaint([nodeId, ...descendantIds(nodeId)]);
      try {
        const node = await api.selectVariant(id, nodeId, entryId, variantIndex);
        if (workflowId() !== id) return;
        S().results = replaceNodeResults(S().results, nodeId, node);
        schedulePlan(0);
        schedulePaint();
      } catch (error) {
        if (workflowId() === id) {
          S().results = previous;
          schedulePaint([nodeId]);
          ui.toast(T('nodes.run.selectFailed', { error: error.message }), { kind: 'error' });
        }
      }
    }

    function page(nodeId, delta) {
      const step = stepVariant(S().results, nodeId, delta);
      if (step) selectVariant(nodeId, step.entry, step.variant);
    }

    /* ----- viewer, downloads ----- */

    function viewerItems(nodeId) {
      const node = nodeOf(nodeId);
      if (!node) return [];
      const def = defOf(nodeId);
      const variant = selectedVariant(S().results, nodeId);
      const shown = previewItems(variant, outputOrder(node), hiddenPorts(node), def && def.category === 'output');
      const list = [];
      for (const item of shown) for (const leaf of flattenValues(item.value)) list.push({ value: leaf, label: ui.portLabel(item.port) });
      return list.filter((item) => OCD.preview.isViewable(item.value));
    }

    function openResult(nodeId, index = 0) {
      const items = viewerItems(nodeId);
      if (items.length) OCD.preview.openViewer(items, index, { title: titleOf(nodeId) });
    }

    function downloadResult(nodeId) {
      const media = viewerItems(nodeId).filter((item) => OCD.preview.isMedia(item.value));
      // a 3D result downloads the GLB file; its preview image (a second file) is not what "Download" asks for
      const models = media.filter((item) => item.value.type === 'model3d');
      const items = models.length ? models : media;
      if (!items.length) {
        ui.toast(T('nodes.run.noResult'), { kind: 'warn' });
        return;
      }
      items.forEach((item, i) => setTimeout(() => OCD.preview.download(item.value), i * 250));
    }

    function downloadZip(runId) {
      const id = workflowId();
      if (!id) return;
      const link = el('a', { href: api.outputsZipUrl(id, runId), download: '', class: 'hidden' });
      OCD.editor.dom().overlays.append(link);
      link.click();
      link.remove();
    }

    function hasOutputResults() {
      const st = S();
      return st.graph.nodes.some((node) => node.type === 'output.result' && Boolean(selectedEntry(st.results, node.id)));
    }

    // "Use as text": the text result of a node as the state of its menu entry { reason, port?, text? } (see textResultOf), or null
    // for nodes that have none (and for inputs and outputs, whose text is their own setting).
    function adoptState(nodeId) {
      const st = S();
      const node = nodeOf(nodeId);
      const def = defOf(nodeId);
      if (!node || !def || def.category === 'input' || def.category === 'output') return null;
      const outputs = graphLib.portsFor(st.reg, node).outputs.filter((port) => !port.hidden);
      const found = textResultOf(selectedVariant(st.results, nodeId), outputs);
      return found.reason === 'none' ? null : found;
    }

    function adoptText(nodeId) {
      const found = adoptState(nodeId);
      if (!found || found.reason !== 'ok') return;
      OCD.editor.adoptTextResult(nodeId, found.port, found.text);
    }

    async function copyResultUrl(nodeId) {
      const media = viewerItems(nodeId).find((item) => OCD.preview.isMedia(item.value));
      if (!media) return;
      const url = new URL(ui.mediaUrl(media.value), document.baseURI).href;
      const ok = await OCD.preview.copyText(url);
      ui.toast(ok ? T('nodes.preview.copied') : T('nodes.preview.copyFailed'), { kind: ok ? undefined : 'warn' });
    }

    /* ----- inspector data ----- */

    const inspectorApi = {
      info(nodeId) {
        const st = S();
        const node = nodeOf(nodeId);
        if (!node || !st.reg) return null;
        const def = st.reg.types.get(node.type) || null;
        const run = runState.nodes[nodeId];
        const planNode = plan && plan.nodes ? plan.nodes[nodeId] : null;
        const results = nodeResults(st.results, nodeId);
        const shown = shownFor(node, def, run, planNode, Boolean(selectedEntry(st.results, nodeId)));
        const invalid = shown.status === 'invalid' ? invalidInfo(node, shown) : null;
        return {
          node,
          def,
          status: shown.status,
          message: (invalid ? invalid.message : shown.message) || null,
          fix: invalid ? invalid.fix : null,
          run: run || null,
          log: runState.logs[nodeId] || [],
          plan: planNode,
          results,
          selected: selectedRef(st.results, nodeId),
          busy: runState.active || starting,
          canRun: Boolean(def) && def.available === true,
          hiddenPorts: def ? hiddenPorts(node) : new Set(),
          outputOrder: def ? outputOrder(node) : [],
          isOutput: Boolean(def) && def.category === 'output',
          adopt: adoptState(nodeId)
        };
      },
      workflow() {
        const progress = progressOf(runState);
        return {
          active: runState.active,
          runId: runState.runId,
          status: runState.status,
          cost: runState.cost,
          progress,
          recent: recentRuns,
          hasOutputs: hasOutputResults()
        };
      },
      runNode,
      runFrom,
      runItems,
      scenes: scenesOf,
      selectVariant,
      openResult,
      downloadResult,
      downloadZip,
      adoptText,
      cancel: cancelRun,
      lengthNote,
      costText,
      formatDuration,
      titleOf
    };

    /* ----- wiring ----- */

    function attach() {
      if (attached) return;
      attached = true;
      buildTopbar();
      ui.setCardActions({
        run: runNode,
        page,
        open: openResult
      });

      OCD.extensions.nodeMenu.push(({ nodeId }) => {
        const def = defOf(nodeId);
        const busy = runState.active || starting;
        const hasResult = viewerItems(nodeId).length > 0;
        const adopt = adoptState(nodeId);
        const items = [
          { label: T('nodes.run.menu.run'), icon: 'play', shortcut: '', disabled: busy || !def || def.available !== true, onClick: () => runNode(nodeId) },
          { label: T('nodes.run.menu.runFrom'), icon: 'skip', disabled: busy || !def || def.available !== true, onClick: () => runFrom(nodeId) },
          { separator: true },
          { label: T('nodes.run.menu.open'), icon: 'fullscreen', disabled: !hasResult, onClick: () => openResult(nodeId) },
          { label: T('nodes.run.menu.download'), icon: 'download', disabled: !viewerItems(nodeId).some((item) => OCD.preview.isMedia(item.value)), onClick: () => downloadResult(nodeId) },
          { label: T('nodes.run.menu.copyUrl'), icon: 'link', disabled: !viewerItems(nodeId).some((item) => OCD.preview.isMedia(item.value)), onClick: () => copyResultUrl(nodeId) }
        ];
        // The text result as an editable Prompt node. Several text results: the entry is there, disabled, and says why.
        if (adopt) {
          items.push({
            label: T('nodes.run.menu.useAsText'),
            icon: 'extract',
            disabled: adopt.reason !== 'ok',
            hint: adopt.reason === 'ok' ? T('nodes.run.menu.useAsTextHint') : T(`nodes.run.menu.useAsText.${adopt.reason}`),
            onClick: () => adoptText(nodeId)
          });
        }
        return items;
      });
      OCD.extensions.workflowMenu.push(() => [
        { label: T('nodes.run.menu.zip'), icon: 'zip', disabled: !hasOutputResults(), onClick: () => downloadZip() }
      ]);

      bus.on('sse', (event) => {
        if (event.type === 'workflow_saved') return;
        dispatch(event);
      });
      bus.on('run:all', () => startRun({ mode: 'all', force: false }));
      bus.on('run:selection', () => runSelection());
      bus.on('selection', () => updateTopbar());
      bus.on('graph', (graph) => {
        // Only cards without slot state yet (new or restored nodes) are painted; the plan refreshes the rest after autosave.
        // Cards the plan calls invalid are painted too: the edit may have removed the cause (an input filled), which
        // the card shows at once instead of with the next plan.
        const invalid = (graph.nodes || []).map((node) => node.id).filter((id) => plan && plan.nodes && plan.nodes[id] && plan.nodes[id].status === 'invalid');
        const fresh = (graph.nodes || []).map((node) => node.id).filter((id) => !painted.has(id));
        // The line about the length of a music node follows the song text typed in the field and the connections.
        const music = (graph.nodes || [])
          .filter((node) => (node.type === 'audio.music' || node.type === 'audio.music_plan') && painted.has(node.id))
          .filter((node) => {
            const note = lengthNote(node.id);
            return (note ? note.text : '') !== lengthNotes.get(node.id);
          })
          .map((node) => node.id);
        if (fresh.length || invalid.length || music.length) schedulePaint([...fresh, ...invalid, ...music]);
      });
      bus.on('saved', ({ rev }) => {
        if (rev !== planRev) schedulePlan(1000);
      });
      bus.on('workflow:open', (payload) => {
        painted.clear();
        stopTimers();
        clearTimeout(planTimer);
        runState = createRunState();
        plan = null;
        planRev = null;
        recentRuns = [];
        if (payload && payload.activeRun) {
          runState = { ...createRunState(), runId: typeof payload.activeRun === 'string' ? payload.activeRun : payload.activeRun.runId, active: true, status: 'running' };
          startTimers();
        }
        schedulePaint();
        schedulePlan(0);
        loadRecentRuns();
      });
      bus.on('workflow:close', () => {
        stopTimers();
        clearTimeout(planTimer);
        planToken += 1;
        runState = createRunState();
        plan = null;
        recentRuns = [];
        updateTopbar();
      });
      bus.on('reconcile', (payload) => {
        if (!payload) return;
        if (!payload.activeRun && runState.active) dispatch({ type: 'snapshot', activeRun: null });
        else schedulePaint();
      });
      updateTopbar();
    }

    return {
      attach,
      relabel() {
        relabelTopbar();
        painted.clear();
        if (canvas()) canvas().clearSlots();
        schedulePaint();
      },
      paintAll: () => schedulePaint(),
      startRun,
      runNode,
      runFrom,
      runSelection,
      cancelRun,
      selectVariant,
      page,
      openResult,
      downloadZip,
      refreshPlan: () => schedulePlan(0),
      inspectorApi,
      getRunState: () => runState,
      getPlan: () => plan
    };
  }

  return { ...pure, createController };
});
