'use strict';

// Workflow execution engine (SPEC §9): validation, plan (dirty propagation + cost preview),
// topological scheduling with a bounded pool, hash-based caching, lists (implicit map),
// error/skip propagation, cancel and per-workflow event emission.
//
// The engine knows nothing about HTTP or providers: node executors do the work through the
// context they receive (see buildContext), results are persisted through the workflows store.

const typesLib = require('./types');
const jobsLib = require('./jobs');
const assetsLib = require('./assets');
const nodeRegistry = require('./registry');
const eventsLib = require('./events');
const workflowsStore = require('./workflows-store');
const access = require('../access');
const budget = require('../budget');

const { isPlainObject, listValue, numberValue, textValue, parseType, adaptValue, isValue, fingerprint, canonicalJson, sha256Hex } = typesLib;
const { topoSort, ancestorsOf } = workflowsStore;

const MODES = ['all', 'node', 'selection'];
const CACHE_EXCLUDED_PARAMS = ['label', 'title'];

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveLimits(overrides = {}) {
  return {
    parallel: envInt('NODES_MAX_PARALLEL', 3),
    maxActiveRuns: envInt('NODES_MAX_ACTIVE_RUNS', 4),
    maxListItems: 50,
    syncTimeoutMs: 12 * 60 * 1000,
    asyncTimeoutMs: 30 * 60 * 1000,
    jobPollMs: jobsLib.DEFAULT_INTERVAL_MS,
    localJobs: 2,
    maxRunsKept: 50,
    ...overrides
  };
}

function engineError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// Participants and guests (lib/access.js) may not run Higgsfield nodes (credits of the operator).
function isRestrictedDef(def) {
  return Boolean(def) && (def.category === 'higgsfield' || def.cost?.unit === 'credits');
}

/* ---------- semaphore ---------- */

// FIFO counting semaphore; acquire() rejects with an AbortError when the signal fires while waiting.
function createSemaphore(max) {
  let active = 0;
  const waiters = [];

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(jobsLib.abortError());
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve() {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }
      };
      function onAbort() {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(jobsLib.abortError());
      }
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function release() {
    active -= 1;
    while (waiters.length && active < max) {
      active += 1;
      waiters.shift().resolve();
    }
  }

  return { acquire, release, get active() { return active; }, get waiting() { return waiters.length; }, max };
}

// A held slot that can be handed back while an executor only waits for a provider job.
async function acquireSlot(semaphore, signal) {
  await semaphore.acquire(signal);
  let held = true;
  return {
    get held() {
      return held;
    },
    release() {
      if (held) {
        held = false;
        semaphore.release();
      }
    },
    async reacquire(reacquireSignal) {
      if (held) return;
      await semaphore.acquire(reacquireSignal);
      held = true;
    }
  };
}

/* ---------- params, ports, validation ---------- */

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// Saved params overlaid with run overrides, coerced to the declared kinds, defaults applied.
function effectiveParams(registry, def, node, overrides) {
  const merged = { ...(node.params || {}), ...(overrides?.[node.id] || {}) };
  return registry.normalizeParams(def, merged);
}

function cacheParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (!CACHE_EXCLUDED_PARAMS.includes(key)) out[key] = value;
  }
  return out;
}

function normaliseIssue(nodeId, raw, defaults = {}) {
  if (typeof raw === 'string') return { nodeId, level: 'error', code: 'invalid', message: raw, ...defaults };
  return {
    nodeId,
    level: raw?.level === 'warning' ? 'warning' : 'error',
    code: raw?.code || 'invalid',
    message: String(raw?.message || 'invalid'),
    ...(raw?.port ? { port: raw.port } : {}),
    // Values for the placeholders of the translated text (client key nodes.issue.<code>).
    ...(isPlainObject(raw?.data) ? { data: raw.data } : {}),
    ...defaults
  };
}

// Structural and parameter validation of the nodes in `requiredIds` (SPEC §9.2 step 1).
// Returns issues { nodeId, level: 'error' | 'warning', code, message, port? }.
function validateGraph(workflow, registry, requiredIds, overrides = {}) {
  const issues = [];
  const graph = workflow.graph;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const required = requiredIds || new Set(graph.nodes.map((node) => node.id));
  const info = new Map();

  for (const node of graph.nodes) {
    if (!required.has(node.id)) continue;
    const def = registry.get(node.type);
    if (!def) {
      issues.push({ nodeId: node.id, level: 'error', code: 'unknown_type', message: `unknown node type ${node.type}` });
      continue;
    }
    const params = effectiveParams(registry, def, node, overrides);
    info.set(node.id, { def, params, ports: registry.portsFor(def, params) });
  }

  if (topoSort(graph.nodes.filter((node) => required.has(node.id)), graph.edges).cyclic) {
    issues.push({ nodeId: null, level: 'error', code: 'cycle', message: 'graph contains a cycle' });
  }

  for (const node of graph.nodes) {
    const entry = info.get(node.id);
    if (!entry) continue;
    const { def, params, ports } = entry;
    const incomingByPort = new Map();
    for (const edge of graph.edges) {
      if (edge.to.node !== node.id) continue;
      if (!incomingByPort.has(edge.to.port)) incomingByPort.set(edge.to.port, []);
      incomingByPort.get(edge.to.port).push(edge);
    }

    for (const [portId, edges] of incomingByPort) {
      const toPort = ports.inputs.find((port) => port.id === portId);
      if (!toPort) {
        issues.push({ nodeId: node.id, port: portId, level: 'error', code: 'bad_port', message: `input port ${portId} does not exist` });
        continue;
      }
      if (!toPort.multiple && edges.length > 1) {
        issues.push({ nodeId: node.id, port: portId, level: 'error', code: 'too_many_edges', message: `input ${portId} accepts one connection only` });
      }
      for (const edge of edges) {
        const from = info.get(edge.from.node) || null;
        if (!from) {
          if (!nodeById.has(edge.from.node)) {
            issues.push({ nodeId: node.id, port: portId, level: 'error', code: 'dangling', message: `edge from missing node ${edge.from.node}` });
          }
          continue;
        }
        const fromPort = from.ports.outputs.find((port) => port.id === edge.from.port);
        if (!fromPort || fromPort.hidden) {
          issues.push({ nodeId: node.id, port: portId, level: 'error', code: 'bad_port', message: `node ${edge.from.node} has no output ${edge.from.port}` });
        } else if (!typesLib.canConnect(fromPort.type, toPort.type)) {
          issues.push({
            nodeId: node.id,
            port: portId,
            level: 'error',
            code: 'incompatible',
            message: `${fromPort.type} cannot connect to ${toPort.type} (input ${portId})`
          });
        }
      }
    }

    const connected = {};
    for (const port of ports.inputs) {
      const count = (incomingByPort.get(port.id) || []).length;
      connected[port.id] = { connected: count > 0, count };
      if (count === 0 && port.required) {
        const base = parseType(port.type)?.base;
        const inline = port.param && (base === 'text' || base === 'number') && !isBlank(params[port.param]);
        if (!inline) {
          issues.push({ nodeId: node.id, port: port.id, level: 'error', code: 'missing_input', message: `input ${port.id} is not connected` });
        }
      }
    }

    for (const message of registry.checkParams(def, params)) {
      issues.push({ nodeId: node.id, level: 'error', code: 'invalid_param', message });
    }
    if (typeof def.validate === 'function') {
      try {
        for (const raw of def.validate(params, connected) || []) issues.push(normaliseIssue(node.id, raw));
      } catch (err) {
        issues.push({ nodeId: node.id, level: 'error', code: 'validate_failed', message: `validation failed: ${err.message}` });
      }
    }
  }
  return issues;
}

/* ---------- inputs and cache keys ---------- */

// Resolves the input values of a node from upstream outputs (outputsOf(nodeId) -> variant object).
// Applies number->text coercion, list wrapping and multiple-edge collection, and detects the
// implicit map (scalar port fed by a list). Throws Error for type or length problems.
function resolveNodeInputs({ node, ports, params, edges, outputsOf, maxListItems }) {
  const inputs = {};
  const mapped = [];
  for (const port of ports.inputs) {
    const parsed = parseType(port.type);
    const incoming = edges.filter((edge) => edge.to.node === node.id && edge.to.port === port.id);

    if (port.multiple) {
      if (!incoming.length) continue;
      const items = [];
      for (const edge of incoming) {
        const value = outputsOf(edge.from.node)?.[edge.from.port];
        if (value === undefined) throw new Error(`Input ${port.id}: node ${edge.from.node} produced no ${edge.from.port}`);
        const adapted = adaptValue(value, `${parsed.base}[]`);
        if (adapted.error) throw new Error(`Input ${port.id}: ${adapted.error}`);
        items.push(...adapted.value.items);
      }
      inputs[port.id] = listValue(parsed.base, items);
      continue;
    }

    if (!incoming.length) {
      if (port.param && !parsed.list && (parsed.base === 'text' || parsed.base === 'number') && !isBlank(params[port.param])) {
        inputs[port.id] = parsed.base === 'number' ? numberValue(params[port.param]) : textValue(params[port.param]);
      }
      continue;
    }

    const edge = incoming[0];
    const value = outputsOf(edge.from.node)?.[edge.from.port];
    if (value === undefined) throw new Error(`Input ${port.id}: node ${edge.from.node} produced no ${edge.from.port}`);
    const adapted = adaptValue(value, port.type);
    if (adapted.error) throw new Error(`Input ${port.id}: ${adapted.error}`);
    inputs[port.id] = adapted.value;
    if (adapted.map) mapped.push(port.id);
  }

  for (const port of ports.inputs) {
    if (port.required && inputs[port.id] === undefined) throw new Error(`Input ${port.id} is missing`);
  }

  let mapLength = null;
  if (mapped.length) {
    const lengths = mapped.map((id) => inputs[id].items.length);
    if (new Set(lengths).size > 1) {
      throw new Error(`List inputs have different lengths (${mapped.map((id, index) => `${id}: ${lengths[index]}`).join(', ')})`);
    }
    mapLength = lengths[0];
    if (mapLength > maxListItems) throw new Error(`List has ${mapLength} items; the limit is ${maxListItems}`);
  }
  return { inputs, mapped, mapLength };
}

// sha256(canonicalJSON({ t: type, v: registry version, p: params, i: input fingerprints })) (SPEC §9.3).
function computeCacheKey(def, params, inputs) {
  const fingerprints = {};
  for (const [portId, value] of Object.entries(inputs)) fingerprints[portId] = fingerprint(value);
  return `sha256:${sha256Hex(canonicalJson({ t: def.type, v: def.version, p: cacheParams(params), i: fingerprints }))}`;
}

// Cache lookup by key. Forced re-runs give several entries the same key, so the entry the user selected
// wins over a newer one with the same key; otherwise a run or plan would silently swap the chosen version.
function findCacheHit(nodeResults, cacheKey) {
  const history = nodeResults?.history || [];
  const selectedId = nodeResults?.selected?.entry;
  const chosen = selectedId ? history.find((entry) => entry.id === selectedId && entry.cacheKey === cacheKey) : null;
  return chosen || history.find((entry) => entry.cacheKey === cacheKey) || null;
}

// Finished items of a failed or cancelled implicit map (nodeResults.partial). They are reused when the same
// node runs again with the same cache key, so only the missing items are paid for a second time.
function reusablePartialItems(nodeResults, cacheKey) {
  const partial = nodeResults?.partial;
  if (!partial || partial.cacheKey !== cacheKey || !isPlainObject(partial.items)) return {};
  return partial.items;
}

// Keeps the user's variant when the selected entry is the hit, otherwise starts at variant 0.
function variantIndexFor(nodeResults, hit) {
  const selected = nodeResults?.selected;
  const index = selected?.entry === hit.id ? selected.variant : 0;
  return Number.isInteger(index) && index >= 0 && index < (hit.variants || []).length ? index : 0;
}

/* ---------- request ---------- */

function normaliseRequest(request, workflow, registry) {
  const raw = isPlainObject(request) ? request : {};
  const mode = raw.mode === undefined ? 'all' : raw.mode;
  if (!MODES.includes(mode)) throw engineError('INVALID_REQUEST', `unknown run mode ${mode}`);
  const nodeById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  let targets;
  if (mode === 'all') {
    targets = workflow.graph.nodes.filter((node) => registry.get(node.type)).map((node) => node.id);
  } else {
    if (!Array.isArray(raw.nodeIds) || !raw.nodeIds.length) throw engineError('INVALID_REQUEST', 'nodeIds is required');
    targets = [...new Set(raw.nodeIds.map(String))];
    for (const id of targets) {
      if (!nodeById.has(id)) throw engineError('INVALID_REQUEST', `unknown node ${id}`);
      if (!registry.get(nodeById.get(id).type)) throw engineError('INVALID_REQUEST', `node ${id} has an unknown type`);
    }
  }
  const overrides = {};
  if (raw.overrides !== undefined && raw.overrides !== null) {
    if (!isPlainObject(raw.overrides)) throw engineError('INVALID_REQUEST', 'overrides must be an object');
    for (const [nodeId, values] of Object.entries(raw.overrides)) {
      if (!nodeById.has(nodeId)) throw engineError('INVALID_REQUEST', `overrides reference unknown node ${nodeId}`);
      if (!isPlainObject(values)) throw engineError('INVALID_REQUEST', `overrides for ${nodeId} must be an object`);
      overrides[nodeId] = { ...values };
    }
  }
  return {
    mode,
    targets,
    force: raw.force === true,
    overrides,
    user: typeof raw.user === 'string' && raw.user.trim() ? raw.user.trim() : 'lokal'
  };
}

// Required set = targets and all their ancestors, in stable topological order.
function analyse(workflow, request) {
  const { nodes, edges } = workflow.graph;
  const required = ancestorsOf(edges, request.targets);
  const requiredNodes = nodes.filter((node) => required.has(node.id));
  const { order, cyclic } = topoSort(requiredNodes, edges);
  return { required, order, cyclic, nodeById: new Map(nodes.map((node) => [node.id, node])) };
}

/* ---------- cost estimates ---------- */

function normaliseCost(raw, unit) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return unit === 'credits' ? { credits: raw } : { usd: raw };
  }
  if (!isPlainObject(raw)) return null;
  const out = {};
  if (Number.isFinite(raw.usd)) out.usd = raw.usd;
  if (Number.isFinite(raw.credits)) out.credits = raw.credits;
  return Object.keys(out).length ? out : null;
}

function actualCost(entry) {
  const usd = Number.isFinite(entry?.cost?.usd) ? entry.cost.usd : null;
  const credits = Number.isFinite(entry?.cost?.credits) ? entry.cost.credits : null;
  return usd === null && credits === null ? null : { usd, credits };
}

// Cost of the newest history entry of one node.
function lastNodeCost(nodeResults) {
  const entry = nodeResults?.history?.[0];
  return entry ? actualCost(entry) : null;
}

// Newest actual USD cost of any node of this type in the workflow, scaled per `count` variant.
function lastTypeCost(workflow, results, type, count) {
  let best = null;
  for (const node of workflow.graph.nodes) {
    if (node.type !== type) continue;
    for (const entry of results.nodes?.[node.id]?.history || []) {
      const cost = actualCost(entry);
      if (!cost || cost.usd === null || !(cost.usd > 0)) continue;
      if (!best || String(entry.createdAt) > String(best.createdAt)) best = { createdAt: entry.createdAt, cost, count: Number(entry.params?.count) };
    }
  }
  if (!best) return null;
  let usd = best.cost.usd;
  if (Number.isFinite(best.count) && best.count > 0 && Number.isFinite(count) && count > 0) usd = (usd / best.count) * count;
  return { usd };
}

/* ---------- plan ---------- */

// Pure plan computation (SPEC §9.4). Mirrors the resolution the run performs but never executes.
function computePlan({ workflow, results, request, registry, limits }) {
  const analysis = analyse(workflow, request);
  const issues = validateGraph(workflow, registry, analysis.required, request.overrides);
  const invalidNodes = new Map();
  for (const issue of issues) {
    if (issue.level === 'error' && issue.nodeId && !invalidNodes.has(issue.nodeId)) invalidNodes.set(issue.nodeId, issue);
  }
  const forced = new Set(request.force ? request.targets : []);
  const state = new Map();
  const listy = new Map();
  const out = {};
  const totals = { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 };

  const outputsOf = (nodeId) => state.get(nodeId)?.outputs;

  for (const nodeId of analysis.order) {
    const node = analysis.nodeById.get(nodeId);
    const def = registry.get(node.type);
    if (!def) {
      state.set(nodeId, { status: 'invalid', outputs: null });
      out[nodeId] = { status: 'invalid', paid: false, estimate: null, lastCost: null, executions: 0, reason: `unknown node type ${node.type}` };
      continue;
    }
    const params = effectiveParams(registry, def, node, request.overrides);
    const ports = registry.portsFor(def, params);
    const nodeResults = results.nodes?.[nodeId];
    const incoming = workflow.graph.edges.filter((edge) => edge.to.node === nodeId);
    const upstreamKnown = incoming.every((edge) => state.get(edge.from.node)?.outputs);
    const declaredListOutput = ports.outputs.some((port) => parseType(port.type)?.list);
    const mayMap = incoming.some((edge) => {
      const toPort = ports.inputs.find((port) => port.id === edge.to.port);
      if (!toPort || toPort.multiple || parseType(toPort.type)?.list) return false;
      if (listy.get(edge.from.node)) return true;
      const fromNode = analysis.nodeById.get(edge.from.node);
      const fromDef = fromNode ? registry.get(fromNode.type) : null;
      if (!fromDef) return false;
      const fromPorts = registry.portsFor(fromDef, effectiveParams(registry, fromDef, fromNode, request.overrides));
      const declared = fromPorts.outputs.find((port) => port.id === edge.from.port);
      return Boolean(parseType(declared?.type)?.list);
    });
    listy.set(nodeId, declaredListOutput || mayMap);

    let status;
    let reason;
    let reasonIssue = null;
    let outputs = null;
    let executions = 1;
    let reusedItems = 0;

    if (invalidNodes.has(nodeId)) {
      status = 'invalid';
      reasonIssue = invalidNodes.get(nodeId);
      reason = reasonIssue.message;
      executions = 0;
    } else if (upstreamKnown) {
      try {
        const resolved = resolveNodeInputs({ node, ports, params, edges: workflow.graph.edges, outputsOf, maxListItems: limits.maxListItems });
        executions = resolved.mapLength === null ? 1 : resolved.mapLength;
        const key = computeCacheKey(def, params, resolved.inputs);
        const hit = findCacheHit(nodeResults, key);
        if (hit && !forced.has(nodeId)) {
          status = 'cached';
          outputs = hit.variants[variantIndexFor(nodeResults, hit)];
        } else {
          status = forced.has(nodeId) ? 'forced' : 'stale';
          if (!forced.has(nodeId) && resolved.mapLength !== null) {
            const reused = Object.keys(reusablePartialItems(nodeResults, key)).filter((index) => Number(index) < resolved.mapLength).length;
            if (reused) {
              executions = resolved.mapLength - reused;
              reusedItems = reused;
            }
          }
        }
      } catch (err) {
        status = 'invalid';
        reason = err.message;
        executions = 0;
      }
    } else {
      status = forced.has(nodeId) ? 'forced' : 'stale';
      executions = mayMap ? null : 1;
    }

    if ((status === 'stale' || status === 'forced') && !invalidNodes.has(nodeId)) {
      const availability = registry.availability(def);
      if (availability !== true) {
        status = 'unavailable';
        reason = availability;
      }
    }

    state.set(nodeId, { status, outputs });

    const entry = { status, paid: def.paid, estimate: null, lastCost: lastNodeCost(nodeResults), executions };
    if (reason) entry.reason = reason;
    // Machine readable cause of an invalid node so the client can show a translated text (nodes.issue.<code>).
    if (reasonIssue) {
      entry.reasonCode = reasonIssue.code;
      if (reasonIssue.data) entry.reasonData = reasonIssue.data;
    }
    if (reusedItems) entry.reusedItems = reusedItems;
    if (def.paid && (status === 'stale' || status === 'forced')) {
      let estimate = null;
      if (def.cost.estimate) {
        try {
          estimate = normaliseCost(def.cost.estimate(params, { workflow, results, lastCost: entry.lastCost }), def.cost.unit);
        } catch (_) {
          estimate = null;
        }
      }
      if (!estimate && def.cost.unit === 'usd') estimate = lastTypeCost(workflow, results, def.type, Number(params.count));
      entry.estimate = estimate;
      totals.paidNodes += 1;
      if (!estimate || executions === null) {
        totals.unknownNodes += 1;
      } else {
        totals.usd += (estimate.usd || 0) * executions;
        totals.credits += (estimate.credits || 0) * executions;
      }
    }
    out[nodeId] = entry;
  }

  return {
    mode: request.mode,
    targets: request.targets,
    force: request.force,
    order: analysis.order,
    nodes: out,
    issues,
    valid: !issues.some((issue) => issue.level === 'error'),
    totals
  };
}

/* ---------- engine ---------- */

function createEngine({
  store = workflowsStore.defaultStore,
  registry = nodeRegistry.registry,
  events = eventsLib,
  getConfig = () => ({}),
  limits: limitOverrides
} = {}) {
  const limits = resolveLimits(limitOverrides);
  const active = new Map();
  const localJobs = createSemaphore(limits.localJobs);

  async function loadContext(workflowId, request) {
    const { workflow, results } = await store.getWorkflow(workflowId);
    return { workflow, results, request: normaliseRequest(request, workflow, registry) };
  }

  // Dry run of a run request: per-node status (cached / stale / forced / unavailable / invalid),
  // paid flag, cost estimate, last cost and totals.
  //
  // For a participant (or guest) the plan also says what the run may not do and what the budget allows:
  //   blocked  [{ nodeId, feature: 'higgsfield' }]  nodes that would run but are not available for the account
  //   budget   { limitUsd, spentUsd, reservedUsd, remainingUsd, since, estimateUsd, enough, code? } (code: BUDGET_EXHAUSTED | BUDGET_INSUFFICIENT)
  async function plan(workflowId, request = {}) {
    const { workflow, results, request: normalised } = await loadContext(workflowId, request);
    const computed = computePlan({ workflow, results, request: normalised, registry, limits });
    const viewer = access.viewerOf({ kubleUser: normalised.user });
    if (!access.isRestricted(viewer)) return computed;
    computed.blocked = restrictedNodes(computed, workflow);
    for (const item of computed.blocked) {
      Object.assign(computed.nodes[item.nodeId], { status: 'unavailable', reason: 'Not available for your account', reasonCode: 'role_restricted' });
    }
    const snapshot = await budget.status(viewer);
    const estimateUsd = computed.totals.usd;
    const paid = computed.totals.paidNodes > 0;
    const exhausted = snapshot.remainingUsd <= budget.REMAINING_EPSILON;
    const insufficient = !exhausted && estimateUsd > snapshot.remainingUsd + budget.REMAINING_EPSILON;
    computed.budget = {
      ...snapshot,
      estimateUsd,
      enough: !paid || (!exhausted && !insufficient),
      ...(paid && exhausted ? { code: 'BUDGET_EXHAUSTED' } : paid && insufficient ? { code: 'BUDGET_INSUFFICIENT' } : {})
    };
    return computed;
  }

  // Nodes of the plan that would run but are restricted for participants.
  function restrictedNodes(computed, workflow) {
    const byId = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    const blocked = [];
    for (const [nodeId, entry] of Object.entries(computed.nodes)) {
      if (entry.status === 'cached' || entry.status === 'invalid') continue;
      const def = registry.get(byId.get(nodeId)?.type);
      if (isRestrictedDef(def)) blocked.push({ nodeId, feature: 'higgsfield' });
    }
    return blocked;
  }

  function statusSnapshot(state) {
    const nodes = {};
    for (const [nodeId, entry] of Object.entries(state.record.nodes)) nodes[nodeId] = entry.status;
    return nodes;
  }

  function activeRun(workflowId) {
    const state = active.get(workflowId);
    if (!state || !state.record) return null;
    return { runId: state.record.id, mode: state.record.mode, nodes: statusSnapshot(state) };
  }

  function emit(state, event) {
    events.emit(state.workflowId, event);
  }

  function setStatus(state, nodeId, status, extra = {}) {
    const previous = state.record.nodes[nodeId] || {};
    state.record.nodes[nodeId] = { ...previous, status, ...(extra.entry ? { entry: extra.entry } : {}), ...(extra.message ? { message: extra.message } : {}) };
    const event = { type: 'node_status', runId: state.record.id, nodeId, status };
    if (extra.message) event.message = extra.message;
    if (extra.progress) event.progress = extra.progress;
    emit(state, event);
    if (!['queued', 'running', 'waiting_job'].includes(status)) persist(state);
  }

  // Serialised, best-effort writes of the run record while the run is in progress.
  function persist(state) {
    state.writeChain = state.writeChain
      .then(() => store.writeRun(state.workflowId, state.record))
      .catch((err) => console.warn(`[nodes] run record write failed: ${err.message}`));
    return state.writeChain;
  }

  function addCost(state, cost) {
    if (!cost) return;
    state.record.cost.usd += cost.usd || 0;
    state.record.cost.credits += cost.credits || 0;
    emit(state, { type: 'run_cost', runId: state.record.id, usd: state.record.cost.usd, credits: state.record.cost.credits });
  }

  function toolEventLabel(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'tool_start') return event.label || event.tool || null;
    if (event.type === 'video_job' || event.type === 'generation_job') return `Job submitted (${event.assetId || event.jobId})`;
    return null;
  }

  // Executor context (SPEC §9.5). `slot` is the pool slot of the running execution.
  function buildContext(state, node, def, signal, slot, itemIndex) {
    const workflow = state.workflow;
    const log = (label) => {
      if (label) emit(state, { type: 'node_log', runId: state.record.id, nodeId: node.id, label: String(label).slice(0, 500) });
    };
    const config = state.config;
    return {
      workflowId: state.workflowId,
      runId: state.record.id,
      nodeId: node.id,
      itemIndex,
      sessionId: workflow.sessionId,
      user: state.request.user,
      config,
      signal,
      toolCtx: {
        nodeView: true,
        sessionId: workflow.sessionId,
        config,
        user: state.request.user,
        signal,
        // The reservation of this run (participants): the paid calls of its nodes count against the plan.
        budgetKey: state.budgetGrant?.key || null,
        emit: (event) => log(toolEventLabel(event))
      },
      log,
      // Waits for an async provider job written by the poller. The pool slot is handed back while waiting.
      async waitForJob(job, options = {}) {
        const jobId = typeof job === 'string' ? job : job?.jobId;
        const assetId = typeof job === 'string' ? undefined : job?.assetId;
        // Remembered for the end of the run: a job that is still open then keeps its own budget reservation.
        if (jobId && state.budgetGrant?.applies) state.watchedJobs.set(assetId || jobId, { jobId, assetId });
        setStatus(state, node.id, 'waiting_job');
        slot?.release();
        try {
          return await jobsLib.waitForSessionJob(workflow.sessionId, jobId, {
            assetId,
            signal,
            timeoutMs: options.timeoutMs || limits.asyncTimeoutMs,
            intervalMs: options.intervalMs || limits.jobPollMs
          });
        } finally {
          if (slot && !signal.aborted) {
            await slot.reacquire(signal).catch(() => {});
          }
          if (!signal.aborted) setStatus(state, node.id, 'running');
        }
      },
      saveOutputFile: (options) => assetsLib.saveOutputFile(workflow.sessionId, options),
      // Server-wide gate for local ffmpeg work (max limits.localJobs at a time).
      async withLocalSlot(fn) {
        await localJobs.acquire(signal);
        try {
          return await fn();
        } finally {
          localJobs.release();
        }
      }
    };
  }

  function normaliseExecResult(def, ports, result) {
    if (!isPlainObject(result) || !Array.isArray(result.variants) || !result.variants.length) {
      throw new Error('Node returned no variants');
    }
    const outputIds = new Set(ports.outputs.map((port) => port.id));
    for (const variant of result.variants) {
      if (!isPlainObject(variant)) throw new Error('Node returned an invalid variant');
      for (const [portId, value] of Object.entries(variant)) {
        if (!outputIds.has(portId)) throw new Error(`Node returned unknown output ${portId}`);
        if (!isValue(value)) throw new Error(`Node returned an invalid value for ${portId}`);
        const port = ports.outputs.find((item) => item.id === portId);
        const adapted = adaptValue(value, port.type);
        if (adapted.error) throw new Error(`Output ${portId}: ${adapted.error}`);
      }
    }
    const usd = Number.isFinite(result.cost?.usd) && result.cost.usd >= 0 ? result.cost.usd : null;
    const credits = Number.isFinite(result.cost?.credits) && result.cost.credits >= 0 ? result.cost.credits : null;
    return { variants: result.variants, cost: { usd, credits } };
  }

  // Runs one execute() call with its own abort controller (linked to the run) and timeout.
  async function executeWithLimits(state, node, def, ports, inputs, params, slot, itemIndex) {
    const controller = new AbortController();
    const onRunAbort = () => controller.abort();
    if (state.controller.signal.aborted) controller.abort();
    else state.controller.signal.addEventListener('abort', onRunAbort, { once: true });
    const timeoutMs = def.timeoutMs || (def.async ? limits.asyncTimeoutMs : limits.syncTimeoutMs);
    let timer;
    let timedOut = false;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(engineError('NODE_TIMEOUT', `Timed out after ${Math.round(timeoutMs / 1000)} s`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const ctx = buildContext(state, node, def, controller.signal, slot, itemIndex);
      const raw = await Promise.race([Promise.resolve().then(() => def.execute(ctx, inputs, params)), timeout]);
      return normaliseExecResult(def, ports, raw);
    } catch (err) {
      if (timedOut) throw engineError('NODE_TIMEOUT', `Timed out after ${Math.round(timeoutMs / 1000)} s`);
      throw err;
    } finally {
      clearTimeout(timer);
      state.controller.signal.removeEventListener('abort', onRunAbort);
    }
  }

  // Executes a node (single or mapped over list items) and returns { variants, cost }.
  async function executeNode(state, node, def, ports, params, resolved, cacheKey) {
    const signal = state.controller.signal;
    if (!resolved.mapped.length) {
      setStatus(state, node.id, 'queued');
      const slot = await acquireSlot(state.pool, signal);
      try {
        setStatus(state, node.id, 'running');
        return await executeWithLimits(state, node, def, ports, resolved.inputs, params, slot, undefined);
      } finally {
        slot.release();
      }
    }

    // Implicit map: one execution per item, zipped by index, count forced to 1.
    const total = resolved.mapLength;
    const itemParams = def.params.some((param) => param.id === 'count') ? { ...params, count: 1 } : params;
    const outputsPerItem = new Array(total);
    const freshIndexes = new Set();
    let done = 0;
    let failure = null;
    let started = false;
    // Items a former failed run already finished with the same inputs are not executed (and paid) again.
    const reusable = state.forced.has(node.id) ? {} : reusablePartialItems(state.results.nodes[node.id], cacheKey);
    for (let index = 0; index < total; index += 1) {
      const kept = reusable[index];
      if (isPlainObject(kept) && isPlainObject(kept.variant)) {
        outputsPerItem[index] = { variants: [kept.variant], cost: { usd: null, credits: null } };
        done += 1;
      }
    }
    setStatus(state, node.id, 'queued');
    await Promise.all(
      Array.from({ length: total }, async (_unused, index) => {
        if (outputsPerItem[index]) return;
        let slot = null;
        try {
          slot = await acquireSlot(state.pool, signal);
          if (failure || signal.aborted) return;
          if (!started) {
            started = true;
            setStatus(state, node.id, 'running', { progress: { done, total } });
          }
          const itemInputs = { ...resolved.inputs };
          for (const portId of resolved.mapped) itemInputs[portId] = resolved.inputs[portId].items[index];
          outputsPerItem[index] = await executeWithLimits(state, node, def, ports, itemInputs, itemParams, slot, index);
          freshIndexes.add(index);
          done += 1;
          setStatus(state, node.id, 'running', { progress: { done, total } });
        } catch (err) {
          if (!failure) failure = { index, err };
        } finally {
          slot?.release();
        }
      })
    );
    if (signal.aborted || failure) await keepPartialItems(state, node, cacheKey, outputsPerItem, freshIndexes, failure);
    if (signal.aborted) throw jobsLib.abortError();
    if (failure) {
      const error = new Error(`Item ${failure.index + 1} of ${total}: ${failure.err.message}`);
      error.code = failure.err.code;
      throw error;
    }
    const variant = {};
    for (const port of ports.outputs) {
      const base = parseType(port.type).base;
      variant[port.id] = listValue(base, outputsPerItem.map((item) => item.variants[0][port.id]).filter((value) => value !== undefined));
    }
    const cost = { usd: null, credits: null };
    for (const item of outputsPerItem) {
      if (item.cost.usd !== null) cost.usd = (cost.usd || 0) + item.cost.usd;
      if (item.cost.credits !== null) cost.credits = (cost.credits || 0) + item.cost.credits;
    }
    return { variants: [variant], cost };
  }

  // A map that fails or is cancelled keeps its finished items: their cost is booked and they are stored
  // in nodeResults.partial, so "run again" only pays for the missing items. The node itself still reports
  // an error, so nothing downstream runs on incomplete data.
  async function keepPartialItems(state, node, cacheKey, outputsPerItem, freshIndexes, failure) {
    const items = {};
    const cost = { usd: null, credits: null };
    outputsPerItem.forEach((item, index) => {
      if (!item) return;
      items[index] = { variant: item.variants[0] };
      if (freshIndexes.has(index)) {
        if (item.cost.usd !== null) cost.usd = (cost.usd || 0) + item.cost.usd;
        if (item.cost.credits !== null) cost.credits = (cost.credits || 0) + item.cost.credits;
      }
    });
    if (!freshIndexes.size) return;
    addCost(state, cost);
    try {
      state.results.nodes[node.id] = await store.updateResults(state.workflowId, (results) => {
        if (!isPlainObject(results.nodes[node.id])) results.nodes[node.id] = { selected: null, history: [] };
        const current = results.nodes[node.id];
        current.partial = {
          cacheKey,
          runId: state.record.id,
          createdAt: new Date().toISOString(),
          items,
          errors: failure ? [{ index: failure.index, message: String(failure.err?.message || failure.err).slice(0, 300) }] : []
        };
        return JSON.parse(JSON.stringify(current));
      });
    } catch (err) {
      console.warn(`[nodes] partial results of ${node.id} could not be stored: ${err.message}`);
    }
  }

  async function runNode(state, nodeId, upstreamOutcomes) {
    const node = state.analysis.nodeById.get(nodeId);
    const def = registry.get(node.type);
    const signal = state.controller.signal;

    if (signal.aborted || upstreamOutcomes.includes('cancelled')) {
      setStatus(state, nodeId, 'cancelled');
      return 'cancelled';
    }
    const blocker = upstreamOutcomes.findIndex((outcome) => outcome === 'error' || outcome === 'skipped');
    if (blocker >= 0) {
      const upstream = state.upstreamOf.get(nodeId)[blocker];
      const root = state.record.nodes[upstream]?.status === 'skipped' ? state.blockedBy.get(upstream) || upstream : upstream;
      state.blockedBy.set(nodeId, root);
      setStatus(state, nodeId, 'skipped', { message: `blocked by ${root}` });
      return 'skipped';
    }

    const startedAt = Date.now();
    try {
      const params = effectiveParams(registry, def, node, state.request.overrides);
      const ports = registry.portsFor(def, params);
      const resolved = resolveNodeInputs({
        node,
        ports,
        params,
        edges: state.workflow.graph.edges,
        outputsOf: (id) => state.outputs.get(id),
        maxListItems: limits.maxListItems
      });
      const cacheKey = computeCacheKey(def, params, resolved.inputs);
      const nodeResults = state.results.nodes[nodeId];
      const hit = state.forced.has(nodeId) ? null : findCacheHit(nodeResults, cacheKey);

      if (hit) {
        const variantIndex = variantIndexFor(nodeResults, hit);
        if (nodeResults?.selected?.entry !== hit.id || nodeResults?.selected?.variant !== variantIndex) {
          state.results.nodes[nodeId] = await store.updateResults(state.workflowId, (results) => {
            const current = results.nodes[nodeId];
            current.selected = { entry: hit.id, variant: variantIndex };
            return JSON.parse(JSON.stringify(current));
          });
        }
        state.outputs.set(nodeId, hit.variants[variantIndex]);
        setStatus(state, nodeId, 'cached', { entry: hit.id });
        return 'cached';
      }

      const availability = registry.availability(def);
      if (availability !== true) throw new Error(`unavailable: ${availability}`);

      const executed = await executeNode(state, node, def, ports, params, resolved, cacheKey);
      const entry = {
        runId: state.record.id,
        createdAt: new Date().toISOString(),
        user: state.request.user,
        cacheKey,
        params: cacheParamsForEntry(params),
        variants: executed.variants,
        cost: executed.cost,
        durationMs: Date.now() - startedAt
      };
      const stored = await store.appendHistory(state.workflowId, nodeId, entry);
      state.results.nodes[nodeId] = stored.node;
      if (stored.node.partial) {
        state.results.nodes[nodeId] = await store.updateResults(state.workflowId, (results) => {
          delete results.nodes[nodeId].partial;
          return JSON.parse(JSON.stringify(results.nodes[nodeId]));
        });
      }
      state.outputs.set(nodeId, stored.entry.variants[0]);
      addCost(state, executed.cost);
      emit(state, { type: 'node_result', runId: state.record.id, nodeId, entry: stored.entry });
      setStatus(state, nodeId, 'done', { entry: stored.entry.id });
      return 'done';
    } catch (err) {
      if (signal.aborted || jobsLib.isAbortError(err)) {
        setStatus(state, nodeId, 'cancelled');
        return 'cancelled';
      }
      const message = String(err?.message || err).slice(0, 500);
      state.errors.push({ nodeId, message });
      setStatus(state, nodeId, 'error', { message });
      return 'error';
    }
  }

  function cacheParamsForEntry(params) {
    return JSON.parse(JSON.stringify(params));
  }

  async function executeRun(state) {
    const { order } = state.analysis;
    const tasks = new Map();
    for (const nodeId of order) {
      const upstream = state.upstreamOf.get(nodeId);
      tasks.set(
        nodeId,
        (async () => {
          const outcomes = await Promise.all(upstream.map((id) => tasks.get(id)));
          return runNode(state, nodeId, outcomes);
        })()
      );
    }
    await Promise.all(tasks.values());
  }

  async function finishRun(state, failure) {
    const record = state.record;
    const aborted = state.controller.signal.aborted;
    record.finishedAt = new Date().toISOString();
    if (failure) {
      record.status = 'failed';
      record.error = String(failure.message || failure).slice(0, 500);
    } else if (aborted) {
      record.status = 'cancelled';
    } else if (state.errors.length) {
      record.status = 'failed';
      record.error = `${state.errors[0].nodeId}: ${state.errors[0].message}`.slice(0, 500);
    } else {
      record.status = 'completed';
    }
    for (const entry of Object.values(record.nodes)) {
      if (entry.status === 'queued' || entry.status === 'running' || entry.status === 'waiting_job') entry.status = 'cancelled';
    }
    await state.writeChain;
    try {
      await store.writeRun(state.workflowId, record);
      await store.pruneRuns(state.workflowId, limits.maxRunsKept);
    } catch (err) {
      console.warn(`[nodes] run record finalisation failed: ${err.message}`);
    }
    const event = { type: 'run_finished', runId: record.id, status: record.status };
    if (record.error) event.error = record.error;
    emit(state, event);
  }

  // Starts a run and returns its id immediately; use whenFinished(runId) to await the record.
  async function start(workflowId, request = {}) {
    if (active.has(workflowId)) {
      throw engineError('RUN_ACTIVE', 'A run is already active for this workflow', { runId: active.get(workflowId).runId || null });
    }
    if (active.size >= limits.maxActiveRuns) {
      throw engineError('RUN_LIMIT', `At most ${limits.maxActiveRuns} runs can be active at the same time`);
    }
    const reservation = { runId: null, record: null };
    let runGrant = null;
    active.set(workflowId, reservation);
    try {
      const { workflow, results, request: normalised } = await loadContext(workflowId, request);
      if (request?.rev !== undefined && request.rev !== workflow.rev) {
        throw engineError('REV_CONFLICT', 'Workflow has unsaved or newer changes', { rev: workflow.rev });
      }
      const analysis = analyse(workflow, normalised);
      const issues = validateGraph(workflow, registry, analysis.required, normalised.overrides);
      const errors = issues.filter((issue) => issue.level === 'error');
      if (errors.length) {
        throw engineError('INVALID_GRAPH', `Workflow is not valid: ${errors[0].message}`, { issues });
      }
      const plan = computePlan({ workflow, results, request: normalised, registry, limits });

      // Participants: no Higgsfield, and the whole run has to fit the budget (refused before anything starts). The plan
      // estimate is reserved for the run so parallel runs cannot overspend together.
      const viewer = access.viewerOf({ kubleUser: normalised.user });
      const runId = store.newRunId();
      if (access.isRestricted(viewer)) {
        if (restrictedNodes(plan, workflow).length) {
          throw new access.RoleRestrictedError(
            'higgsfield',
            'This run contains Higgsfield nodes, which are not available for your account',
            'Dieser Lauf enthält Higgsfield-Nodes, die für dein Konto nicht verfügbar sind.'
          );
        }
        runGrant = await budget.beginRun(viewer, { runId, estimateUsd: plan.totals.usd, paid: plan.totals.paidNodes > 0, label: 'run' });
      }
      const now = new Date().toISOString();
      const record = {
        id: runId,
        workflowId,
        mode: normalised.mode,
        targets: normalised.targets,
        force: normalised.force,
        user: normalised.user,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        nodes: {},
        cost: { usd: 0, credits: 0 },
        overrides: normalised.overrides,
        error: null
      };
      for (const nodeId of analysis.order) record.nodes[nodeId] = { status: 'queued' };

      const upstreamOf = new Map();
      for (const nodeId of analysis.order) {
        const ids = workflow.graph.edges
          .filter((edge) => edge.to.node === nodeId && analysis.required.has(edge.from.node))
          .map((edge) => edge.from.node);
        upstreamOf.set(nodeId, [...new Set(ids)]);
      }

      const state = {
        workflowId,
        runId,
        workflow,
        results: JSON.parse(JSON.stringify(results)),
        request: normalised,
        analysis,
        upstreamOf,
        record,
        forced: new Set(normalised.force ? normalised.targets : []),
        outputs: new Map(),
        errors: [],
        blockedBy: new Map(),
        controller: new AbortController(),
        pool: createSemaphore(limits.parallel),
        config: getConfig() || {},
        budgetGrant: runGrant,
        watchedJobs: new Map(),
        writeChain: Promise.resolve()
      };
      await store.writeRun(workflowId, record);
      active.set(workflowId, state);

      const planMap = {};
      for (const nodeId of analysis.order) {
        const status = plan.nodes[nodeId]?.status;
        planMap[nodeId] = status === 'cached' || status === 'forced' ? status : 'stale';
      }
      emit(state, { type: 'run_started', runId, mode: normalised.mode, targets: normalised.targets, plan: planMap });

      state.finished = (async () => {
        let failure = null;
        try {
          await executeRun(state);
        } catch (err) {
          failure = err;
        }
        // Before the run is reported as finished: by then the reservation of open provider jobs lives on their own keys.
        await handOverOpenJobs(state, viewer);
        try {
          await finishRun(state, failure);
        } finally {
          runGrant?.release();
          active.delete(workflowId);
        }
        return record;
      })();
      return runId;
    } catch (err) {
      runGrant?.release();
      if (active.get(workflowId) === reservation) active.delete(workflowId);
      throw err;
    }
  }

  // A cancelled or timed-out run leaves provider jobs behind that nobody stops and that are billed when they finish.
  // Their share of the run's reservation moves to the jobs (each gets its own hold, kept until the poller books the
  // cost), so the budget does not come back before the money is spent.
  async function handOverOpenJobs(state, viewer) {
    const grant = state.budgetGrant;
    if (!grant || !grant.applies || !state.watchedJobs.size) return;
    const sessionId = state.workflow.sessionId;
    try {
      const open = await jobsLib.openJobs(sessionId, [...state.watchedJobs.values()]);
      if (!open.length) return;
      const holds = await budget.detachRun(viewer, grant.key, open.length);
      const assignments = open.map((ref, index) => ({ ref, budgetKey: holds[index].key, reservedUsd: holds[index].usd }));
      const skipped = await jobsLib.reassignBudget(sessionId, assignments);
      for (const item of skipped) budget.release(item.budgetKey);
    } catch (err) {
      console.warn(`[budget] Offene Jobs von Lauf ${state.runId} konnten nicht uebernommen werden: ${err.message}`);
    }
  }

  function cancel(workflowId, runId) {
    const state = active.get(workflowId);
    if (!state || !state.record || (runId && state.runId !== runId)) return false;
    state.controller.abort();
    return true;
  }

  // Resolves with the final run record once the run has finished (also for a run that already ended
  // if it is still tracked); resolves null for unknown runs.
  async function whenFinished(workflowId, runId) {
    const state = active.get(workflowId);
    if (state?.finished && (!runId || state.runId === runId)) return state.finished;
    return runId ? store.readRun(workflowId, runId).catch(() => null) : null;
  }

  return { plan, start, cancel, activeRun, whenFinished, limits, localJobs, validate: (workflow, requiredIds, overrides) => validateGraph(workflow, registry, requiredIds, overrides) };
}

module.exports = {
  MODES,
  createEngine,
  createSemaphore,
  resolveLimits,
  validateGraph,
  computePlan,
  computeCacheKey,
  resolveNodeInputs,
  effectiveParams,
  normaliseRequest,
  analyse
};
