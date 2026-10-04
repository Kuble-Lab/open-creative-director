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

const MODES = ['all', 'node', 'selection', 'items'];
const CACHE_EXCLUDED_PARAMS = ['label', 'title'];
const MAX_LIST_ITEMS = 50;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveLimits(overrides = {}) {
  return {
    parallel: envInt('NODES_MAX_PARALLEL', 3),
    maxActiveRuns: envInt('NODES_MAX_ACTIVE_RUNS', 4),
    maxListItems: MAX_LIST_ITEMS,
    syncTimeoutMs: 12 * 60 * 1000,
    asyncTimeoutMs: 30 * 60 * 1000,
    jobPollMs: jobsLib.DEFAULT_INTERVAL_MS,
    localJobs: 2,
    maxRunsKept: 50,
    prepareTimeoutMs: 10 * 1000,
    ...overrides
  };
}

// The values an error with a stable code hands to the translated text (err.data, e.g. the suggestion of a refused music
// prompt): flat, strings and numbers only, so the run record stays small.
function errorData(err) {
  if (!isPlainObject(err?.data)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(err.data)) {
    if (typeof value === 'string') out[key] = value.slice(0, 8000);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function engineError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// Participants and guests (lib/access.js) may not run Higgsfield nodes (credits of the operator).
const isRestrictedDef = nodeRegistry.isRestricted;

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

// The outputs a node never fills with these params (def.emptyOutputs(params) -> port ids); [] for any other node.
function emptyOutputsOf(def, params) {
  if (typeof def.emptyOutputs !== 'function') return [];
  try {
    const ids = def.emptyOutputs(params);
    return Array.isArray(ids) ? ids : [];
  } catch (_) {
    return [];
  }
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
        } else if (emptyOutputsOf(from.def, from.params).includes(edge.from.port)) {
          // an output the node never fills with these options (the preview of SAM 3D): said now, not after the node before is paid
          issues.push({
            nodeId: node.id,
            port: portId,
            level: 'error',
            code: 'OUTPUT_EMPTY',
            message: `Input ${portId}: node ${edge.from.node} produces no ${edge.from.port} with these options`,
            data: { input: portId, output: edge.from.port }
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

// An upstream node that finished without a value for the output a connection reads (an optional output: the preview image of
// a 3D model that the provider does not render). Stable code OUTPUT_EMPTY, so the page can say what to do in its own language.
function emptyOutputError(portId, edge) {
  return engineError('OUTPUT_EMPTY', `Input ${portId}: node ${edge.from.node} produced no ${edge.from.port}`, { data: { input: portId, output: edge.from.port } });
}

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
        if (value === undefined) throw emptyOutputError(port.id, edge);
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
    if (value === undefined) throw emptyOutputError(port.id, edge);
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

// Keeps the user's variant when the selected entry is the hit, otherwise starts at variant 0.
function variantIndexFor(nodeResults, hit) {
  const selected = nodeResults?.selected;
  const index = selected?.entry === hit.id ? selected.variant : 0;
  return Number.isInteger(index) && index >= 0 && index < (hit.variants || []).length ? index : 0;
}

/* ---------- cache per item of an implicit map (SPEC §9.6) ---------- */

// The params one item of an implicit map runs with: `count` is forced to 1 (see executeNode).
function itemParamsOf(def, params) {
  return def.params.some((param) => param.id === 'count') ? { ...params, count: 1 } : params;
}

// A node whose result depends on ctx.itemIndex says so (def.itemIndexInKey(params) -> boolean); only then the position of
// the item is part of its key. Without it an entry that moved in the list would be reused with the motion of its old place.
function indexInKey(def, params) {
  if (typeof def.itemIndexInKey !== 'function') return false;
  try {
    return Boolean(def.itemIndexInKey(params));
  } catch (_) {
    return false;
  }
}

// The key of one item: like computeCacheKey, but over the parameters of one run (count = 1) and the inputs as this item
// sees them. An input fed by the list counts with its element only, a single value and a whole list (a `multiple` input)
// count completely. Returns one key per item.
function computeItemKeys(def, params, resolved) {
  const itemParams = cacheParams(itemParamsOf(def, params));
  const withIndex = indexInKey(def, params);
  const keys = [];
  for (let index = 0; index < resolved.mapLength; index += 1) {
    const fingerprints = {};
    for (const [portId, value] of Object.entries(resolved.inputs)) {
      fingerprints[portId] = resolved.mapped.includes(portId) ? fingerprint(value.items[index]) : fingerprint(value);
    }
    const body = { t: def.type, v: def.version, p: itemParams, i: fingerprints };
    if (withIndex) body.x = index;
    keys.push(`sha256:${sha256Hex(canonicalJson(body))}`);
  }
  return keys;
}

// The outputs of a node that does not hand out its items one by one (a list port of its own, an optional output that is
// missing for some items) cannot be cut into items again; such a node keeps the cache of the whole list only.
function itemsCuttable(ports) {
  return ports.outputs.every((port) => !parseType(port.type)?.list);
}

// Item `index` of a stored entry as the variant one execution returned ({ portId: value }), or null when the entry has no
// key for the item or its lists do not line up with the keys.
function itemVariantOf(entry, index, ports) {
  const variant = entry?.variants?.[0];
  if (!isPlainObject(variant) || !Array.isArray(entry.itemKeys) || index >= entry.itemKeys.length) return null;
  const out = {};
  for (const port of ports.outputs) {
    const value = variant[port.id];
    if (value === undefined) continue;
    if (!typesLib.isListValue(value)) return null;
    if (value.items.length === 0) continue;
    if (value.items.length !== entry.itemKeys.length) return null;
    out[port.id] = value.items[index];
  }
  return out;
}

// Finds a finished item by its key: first in the entry the user selected, then in the rest of the history (newest
// first), then in the items a failed or cancelled run kept (`partial`). Returns find(key, index) -> { variant, source } | null.
function createItemFinder(nodeResults, ports, cacheKey) {
  const history = nodeResults?.history || [];
  const selectedId = nodeResults?.selected?.entry;
  const ordered = [];
  const chosen = selectedId ? history.find((entry) => entry.id === selectedId) : null;
  if (chosen) ordered.push(chosen);
  for (const entry of history) if (entry !== chosen) ordered.push(entry);
  const partial = isPlainObject(nodeResults?.partial) && isPlainObject(nodeResults.partial.items) ? nodeResults.partial : null;
  return function find(key, index) {
    for (const entry of ordered) {
      if (!Array.isArray(entry.itemKeys)) continue;
      const at = entry.itemKeys.indexOf(key);
      if (at < 0) continue;
      const variant = itemVariantOf(entry, at, ports);
      if (variant) return { variant, source: 'history' };
    }
    if (partial) {
      let at = -1;
      if (Array.isArray(partial.itemKeys)) at = partial.itemKeys.findIndex((itemKey, position) => itemKey === key && isPlainObject(partial.items[position]?.variant));
      else if (partial.cacheKey === cacheKey && isPlainObject(partial.items[index]?.variant)) at = index;
      if (at >= 0) return { variant: partial.items[at].variant, source: 'partial' };
    }
    return null;
  };
}

/* ---------- request ---------- */

function normaliseRequest(request, workflow, registry) {
  const raw = isPlainObject(request) ? request : {};
  const mode = raw.mode === undefined ? 'all' : raw.mode;
  if (!MODES.includes(mode)) throw engineError('INVALID_REQUEST', `unknown run mode ${mode}`);
  const nodeById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  let targets;
  let itemsRun = null;
  if (mode === 'all') {
    targets = workflow.graph.nodes.filter((node) => registry.get(node.type)).map((node) => node.id);
  } else if (mode === 'items') {
    // { mode: 'items', nodeId, items: [index, ...] }: only these items of the list of one node are made again
    if (typeof raw.nodeId !== 'string' || !raw.nodeId) throw engineError('INVALID_REQUEST', 'nodeId is required');
    const target = nodeById.get(raw.nodeId);
    if (!target) throw engineError('INVALID_REQUEST', `unknown node ${raw.nodeId}`);
    if (!registry.get(target.type)) throw engineError('INVALID_REQUEST', `node ${raw.nodeId} has an unknown type`);
    if (!Array.isArray(raw.items) || !raw.items.length) throw engineError('INVALID_REQUEST', 'items must list the numbers of the items to make again');
    if (!raw.items.every((item) => Number.isInteger(item) && item >= 0)) throw engineError('INVALID_REQUEST', 'items must be whole numbers from 0');
    const items = [...new Set(raw.items)].sort((a, b) => a - b);
    if (items.length > MAX_LIST_ITEMS) throw engineError('INVALID_REQUEST', `at most ${MAX_LIST_ITEMS} items can be made again at once`);
    targets = [raw.nodeId];
    itemsRun = { nodeId: raw.nodeId, items };
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
    force: mode !== 'items' && raw.force === true,
    ...(itemsRun ? { itemsRun } : {}),
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

// A run of single items (mode 'items') needs a list result to take the other items from: the selected entry of the node
// must have lists, and every number must be inside the list. Said before anything runs or is paid.
function checkItemsRequest(request, results) {
  const run = request.itemsRun;
  if (!run) return;
  const nodeResults = results?.nodes?.[run.nodeId];
  const entry = (nodeResults?.history || []).find((item) => item.id === nodeResults?.selected?.entry);
  const variant = entry?.variants?.[nodeResults.selected.variant];
  let length = null;
  if (Array.isArray(entry?.itemKeys)) {
    length = entry.itemKeys.length;
  } else if (isPlainObject(variant)) {
    for (const value of Object.values(variant)) {
      if (typesLib.isListValue(value)) length = Math.max(length || 0, value.items.length);
    }
  }
  if (length === null) throw engineError('INVALID_REQUEST', `node ${run.nodeId} has no list result to make single items again`, { reason: 'ITEMS_NO_LIST' });
  const outside = run.items.find((index) => index >= length);
  if (outside !== undefined) {
    throw engineError('INVALID_REQUEST', `item ${outside + 1} does not exist: the list of node ${run.nodeId} has ${length} items`, { reason: 'ITEMS_OUT_OF_RANGE', params: { item: outside + 1, length } });
  }
}

// The same two questions once the inputs of the node are known: does it run once per item, and are the numbers inside the list.
function assertItemsFit(run, resolved) {
  if (!resolved.mapped.length) {
    throw engineError('ITEMS_NO_LIST', `Node ${run.nodeId} does not run once per list item, so single items cannot be made again`);
  }
  const outside = run.items.find((index) => index >= resolved.mapLength);
  if (outside !== undefined) {
    throw engineError('ITEMS_OUT_OF_RANGE', `Item ${outside + 1} does not exist: the list has ${resolved.mapLength} items`, { data: { item: outside + 1, length: resolved.mapLength } });
  }
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
function computePlan({ workflow, results, request, registry, limits, config = {} }) {
  const analysis = analyse(workflow, request);
  const issues = validateGraph(workflow, registry, analysis.required, request.overrides);
  const invalidNodes = new Map();
  for (const issue of issues) {
    if (issue.level === 'error' && issue.nodeId && !invalidNodes.has(issue.nodeId)) invalidNodes.set(issue.nodeId, issue);
  }
  const forced = new Set(request.force ? request.targets : request.itemsRun ? [request.itemsRun.nodeId] : []);
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
    // What the node would receive now; only known while everything before it is up to date (see `upstreamKnown`).
    let inputsNow = null;

    if (invalidNodes.has(nodeId)) {
      status = 'invalid';
      reasonIssue = invalidNodes.get(nodeId);
      reason = reasonIssue.message;
      executions = 0;
    } else if (upstreamKnown) {
      try {
        const resolved = resolveNodeInputs({ node, ports, params, edges: workflow.graph.edges, outputsOf, maxListItems: limits.maxListItems });
        if (request.itemsRun?.nodeId === nodeId) assertItemsFit(request.itemsRun, resolved);
        inputsNow = resolved.inputs;
        executions = resolved.mapLength === null ? 1 : resolved.mapLength;
        const key = computeCacheKey(def, params, resolved.inputs);
        const hit = findCacheHit(nodeResults, key);
        if (hit && !forced.has(nodeId)) {
          status = 'cached';
          outputs = hit.variants[variantIndexFor(nodeResults, hit)];
        } else {
          status = forced.has(nodeId) ? 'forced' : 'stale';
          // Cache per item (SPEC §9.6): the items that are found in the results of the node do not run and cost nothing.
          // A forced node looks for none, except in a run of single items, where the items not asked for are looked up.
          const onlyItems = request.itemsRun?.nodeId === nodeId ? new Set(request.itemsRun.items) : null;
          if (resolved.mapLength !== null && (!forced.has(nodeId) || onlyItems) && itemsCuttable(ports)) {
            const find = createItemFinder(nodeResults, ports, key);
            const itemKeys = computeItemKeys(def, params, resolved);
            let reused = 0;
            for (let index = 0; index < resolved.mapLength; index += 1) {
              if (!onlyItems?.has(index) && find(itemKeys[index], index)) reused += 1;
            }
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
        // a stable code (OUTPUT_EMPTY) lets the page show the cause in its own language
        if (typeof err.code === 'string' && /^[A-Z]+(_[A-Z]+)+$/.test(err.code)) reasonIssue = { code: err.code, message: err.message, ...(errorData(err) ? { data: errorData(err) } : {}) };
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
      if (reasonIssue.port) entry.reasonPort = reasonIssue.port;
    }
    if (reusedItems) entry.reusedItems = reusedItems;
    if (def.paid && (status === 'stale' || status === 'forced')) {
      let estimate = null;
      if (def.cost.estimate) {
        try {
          // `connected`: the input ports with a connection (their field in params does not count then).
          const connected = new Set(incoming.map((edge) => edge.to.port));
          // `inputs`: the values the node receives now (a length that is only known from the connected media, for example), or
          // {} while something before the node still has to run: an earlier result of the node before is not taken for it.
          estimate = normaliseCost(def.cost.estimate(params, { workflow, results, lastCost: entry.lastCost, nodeId, connected, config, inputs: inputsNow || {} }), def.cost.unit);
        } catch (_) {
          estimate = null;
        }
      }
      // A node whose price depends on something that is not known yet (a length that arrives through a connection) opts out
      // of the guess from an earlier run (cost.history: false): the plan then says "unknown" instead of a wrong amount.
      if (!estimate && def.cost.unit === 'usd' && def.cost.history !== false) estimate = lastTypeCost(workflow, results, def.type, Number(params.count));
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

// Rough cost of ONE run of a graph that is not a workflow yet (a starter template, SPEC §15). It reuses the plan
// estimates of computePlan with every availability check switched off, so a missing key does not hide the price.
// A graph with a list counts one list item, unless `runs(nodeId, entry)` knows better (how often a node runs when the
// list length is fixed), or answers null: the length is not known before the run (a node makes the list), so the price of
// the node is not either. unknownNodes are paid nodes without an estimate (no price table, no earlier run) and those.
// Returns { paidNodes, unknownNodes, usd, credits }.
function estimateGraph(graph, { registry = nodeRegistry.registry, limits = resolveLimits(), runs = () => 1 } = {}) {
  const workflow = { graph };
  const ready = { ...registry, availability: () => true };
  const request = normaliseRequest({ mode: 'all' }, workflow, ready);
  const plan = computePlan({ workflow, results: { nodes: {} }, request, registry: ready, limits });
  const out = { paidNodes: 0, unknownNodes: 0, usd: 0, credits: 0 };
  for (const [nodeId, entry] of Object.entries(plan.nodes)) {
    if (!entry.paid) continue;
    out.paidNodes += 1;
    if (!entry.estimate) {
      out.unknownNodes += 1;
      continue;
    }
    const known = runs(nodeId, entry);
    if (known === null) {
      out.unknownNodes += 1;
      continue;
    }
    const times = known || 1;
    out.usd += (entry.estimate.usd || 0) * times;
    out.credits += (entry.estimate.credits || 0) * times;
  }
  return out;
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
    const normalised = normaliseRequest(request, workflow, registry);
    checkItemsRequest(normalised, results);
    await prepareNodes(workflow, normalised);
    return { workflow, results, request: normalised };
  }

  // Some checks of a node need data that is only cached (the references a Higgsfield model takes): validation reads the
  // cache without I/O. Before a plan or a run the data of the nodes that will run is therefore loaded (`def.prepare(params)`),
  // so a cold or expired cache cannot let a run through that the page shows as invalid. A failure or a slow answer
  // leaves the data unknown (the node then checks again when it runs); it never fails the plan or the run.
  async function prepareNodes(workflow, request) {
    const jobs = [];
    // what a participant may not run is not asked for either (the plan blocks it)
    const restricted = access.isRestricted(access.viewerOf({ kubleUser: request.user }));
    for (const nodeId of analyse(workflow, request).required) {
      const node = workflow.graph.nodes.find((item) => item.id === nodeId);
      const def = node ? registry.get(node.type) : null;
      if (def && typeof def.prepare === 'function' && !(restricted && isRestrictedDef(def))) jobs.push({ def, params: effectiveParams(registry, def, node, request.overrides) });
    }
    if (!jobs.length) return;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, limits.prepareTimeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      await Promise.race([Promise.all(jobs.map(async ({ def, params }) => {
        try {
          await def.prepare(params, { config: getConfig() || {} });
        } catch (_) {
          // unknown stays unknown
        }
      })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Dry run of a run request: per-node status (cached / stale / forced / unavailable / invalid),
  // paid flag, cost estimate, last cost and totals.
  //
  // For a participant (or guest) the plan also says what the run may not do and what the budget allows:
  //   blocked  [{ nodeId, feature: 'higgsfield' }]  nodes that would run but are not available for the account
  //   budget   { limitUsd, spentUsd, reservedUsd, remainingUsd, since, estimateUsd, enough, code? } (code: BUDGET_EXHAUSTED | BUDGET_INSUFFICIENT)
  async function plan(workflowId, request = {}) {
    const { workflow, results, request: normalised } = await loadContext(workflowId, request);
    const computed = computePlan({ workflow, results, request: normalised, registry, limits, config: getConfig() || {} });
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
    state.record.nodes[nodeId] = { ...previous, status, ...(extra.entry ? { entry: extra.entry } : {}), ...(extra.message ? { message: extra.message } : {}), ...(extra.code ? { code: extra.code } : {}), ...(extra.data ? { data: extra.data } : {}) };
    const event = { type: 'node_status', runId: state.record.id, nodeId, status };
    if (extra.message) event.message = extra.message;
    if (extra.code) event.code = extra.code;
    if (extra.data) event.data = extra.data;
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
    const cost = { usd, credits };
    // the model a paid node really used (image nodes), kept so the plan can price the next run by the last cost of that model
    if (typeof result.cost?.model === 'string' && result.cost.model.trim()) cost.model = result.cost.model.trim().slice(0, 200);
    return { variants: result.variants, cost };
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
    const itemParams = itemParamsOf(def, params);
    const outputsPerItem = new Array(total);
    const freshIndexes = new Set();
    let done = 0;
    let failure = null;
    let started = false;
    // Cache per item (SPEC §9.6): an item that was made before with the same parameters and the same inputs is taken from
    // the results of the node (the selected entry, the rest of the history, the items a failed run kept) and neither runs
    // nor costs anything. A forced run looks for none; a run of single items (mode 'items') makes the asked ones again and
    // looks for the others.
    const asked = state.forcedItems.get(node.id) || null;
    const cuttable = itemsCuttable(ports);
    const itemKeys = cuttable ? computeItemKeys(def, params, resolved) : null;
    const find = cuttable && (!state.forced.has(node.id) || asked) ? createItemFinder(state.results.nodes[node.id], ports, cacheKey) : null;
    let reused = 0;
    for (let index = 0; index < total; index += 1) {
      if (!find || asked?.has(index)) continue;
      const kept = find(itemKeys[index], index);
      if (kept) {
        outputsPerItem[index] = { variants: [kept.variant], cost: { usd: null, credits: null } };
        done += 1;
        reused += 1;
      }
    }
    if (reused) emit(state, { type: 'node_log', runId: state.record.id, nodeId: node.id, label: `Reused ${reused} of ${total} unchanged items` });
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
    if (signal.aborted || failure) await keepPartialItems(state, node, cacheKey, itemKeys, outputsPerItem, freshIndexes, failure);
    if (signal.aborted) throw jobsLib.abortError();
    if (failure) {
      const error = new Error(`Item ${failure.index + 1} of ${total}: ${failure.err.message}`);
      error.code = failure.err.code;
      error.data = failure.err.data;
      throw error;
    }
    const variant = {};
    let aligned = cuttable;
    for (const port of ports.outputs) {
      const base = parseType(port.type).base;
      const values = outputsPerItem.map((item) => item.variants[0][port.id]).filter((value) => value !== undefined);
      // a port that is missing for some items cannot be cut into items again (see itemVariantOf)
      if (values.length !== 0 && values.length !== total) aligned = false;
      variant[port.id] = listValue(base, values);
    }
    const cost = { usd: null, credits: null };
    for (const item of outputsPerItem) {
      if (item.cost.usd !== null) cost.usd = (cost.usd || 0) + item.cost.usd;
      if (item.cost.credits !== null) cost.credits = (cost.credits || 0) + item.cost.credits;
      if (item.cost.model && !cost.model) cost.model = item.cost.model;
    }
    return { variants: [variant], cost, ...(aligned ? { itemKeys } : {}) };
  }

  // A map that fails or is cancelled keeps its finished items: their cost is booked and they are stored
  // in nodeResults.partial, so "run again" only pays for the missing items. The node itself still reports
  // an error, so nothing downstream runs on incomplete data.
  async function keepPartialItems(state, node, cacheKey, itemKeys, outputsPerItem, freshIndexes, failure) {
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
          // the key of every item (by position), so a later run finds the finished items also when the list has changed
          ...(itemKeys ? { itemKeys } : {}),
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
      if (state.forcedItems.has(nodeId)) assertItemsFit({ nodeId, items: [...state.forcedItems.get(nodeId)] }, resolved);
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
        // the key of every item of a list (cache per item); an entry without it is only found as a whole
        ...(executed.itemKeys ? { itemKeys: executed.itemKeys } : {}),
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
      // A stable error code (VIDEO_REAL_PERSON, ...) lets the interface show the cause in its own language; system error
      // codes such as ENOENT have no underscore and stay out.
      const code = typeof err?.code === 'string' && /^[A-Z]+(_[A-Z]+)+$/.test(err.code) ? err.code : undefined;
      state.errors.push({ nodeId, message });
      setStatus(state, nodeId, 'error', { message, code, data: code ? errorData(err) : undefined });
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
      const plan = computePlan({ workflow, results, request: normalised, registry, limits, config: getConfig() || {} });
      // single items of a node that does not run once per item: said before an earlier node is run or paid
      const itemsNode = normalised.itemsRun ? plan.nodes[normalised.itemsRun.nodeId] : null;
      if (itemsNode?.status === 'invalid' && /^ITEMS_/.test(itemsNode.reasonCode || '')) {
        throw engineError('INVALID_REQUEST', itemsNode.reason, { reason: itemsNode.reasonCode, ...(itemsNode.reasonData ? { params: itemsNode.reasonData } : {}) });
      }

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
        ...(normalised.itemsRun ? { items: normalised.itemsRun.items } : {}),
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
        forced: new Set(normalised.force ? normalised.targets : normalised.itemsRun ? [normalised.itemsRun.nodeId] : []),
        // mode 'items': node id -> Set of the items that are made again (the others come from the results of the node)
        forcedItems: new Map(normalised.itemsRun ? [[normalised.itemsRun.nodeId, new Set(normalised.itemsRun.items)]] : []),
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
  estimateGraph,
  computeCacheKey,
  resolveNodeInputs,
  effectiveParams,
  normaliseRequest,
  analyse
};
