'use strict';

// File-based workflow store (SPEC §7): workflow.json (client-owned, optimistic `rev`),
// results.json (engine-owned) and runs/<runId>.json per workflow, plus one hidden backing
// session per workflow. Also the home of pure graph helpers (topological sort, ancestors)
// shared with the engine.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('../config');
const sessionStore = require('../store');
const access = require('../access');
const nodeRegistry = require('./registry');
const assets = require('./assets');
const eventsModule = require('./events');
const { isPlainObject, canonicalJson } = require('./types');

const FORMAT = 'ocd.workflow';
const VERSION = 1;
const DEFAULT_DIR = path.join(PATHS.root, 'data', 'workflows');

const LIMITS = Object.freeze({
  maxNodes: 500,
  maxEdges: 2000,
  maxGroups: 200,
  maxNotes: 200,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxHistory: 30,
  maxRuns: 50,
  maxNameLength: 120
});

// Import migrations keyed by the document version they upgrade from (none needed yet).
const MIGRATIONS = {};

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TYPE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const PORT_ID = /^[A-Za-z0-9_-]{1,32}$/;

function storeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function invalid(message) {
  return storeError('INVALID_WORKFLOW', message);
}

/* ---------- pure graph helpers ---------- */

function compareNodesByPosition(a, b) {
  return (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id));
}

// Kahn's algorithm; ties (several ready nodes) are ordered by y, then x, then id for a stable order.
// Edges that touch nodes outside `nodes` are ignored. Returns { order: [nodeId], cyclic }.
function topoSort(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    const from = edge.from?.node;
    const to = edge.to?.node;
    if (!byId.has(from) || !byId.has(to)) continue;
    outgoing.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0);
  const order = [];
  while (ready.length) {
    ready.sort(compareNodesByPosition);
    const node = ready.shift();
    order.push(node.id);
    for (const next of outgoing.get(node.id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(byId.get(next));
    }
  }
  return { order, cyclic: order.length !== nodes.length };
}

// Set of node ids reachable by walking edges backwards (ancestors) or forwards (descendants),
// including the start nodes themselves.
function reachable(edges, startIds, direction) {
  const [near, far] = direction === 'up' ? ['to', 'from'] : ['from', 'to'];
  const seen = new Set(startIds);
  const stack = [...startIds];
  while (stack.length) {
    const current = stack.pop();
    for (const edge of edges) {
      if (edge[near]?.node === current && !seen.has(edge[far]?.node)) {
        seen.add(edge[far].node);
        stack.push(edge[far].node);
      }
    }
  }
  return seen;
}

function ancestorsOf(edges, startIds) {
  return reachable(edges, startIds, 'up');
}

function descendantsOf(edges, startIds) {
  return reachable(edges, startIds, 'down');
}

/* ---------- graph and document validation ---------- */

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanString(value, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return [...String(value)].slice(0, maxLength).join('');
}

function arrayOf(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  if (value.length > max) throw invalid(`${label} has more than ${max} entries`);
  return value;
}

function uniqueId(value, label, seen) {
  if (typeof value !== 'string' || !ELEMENT_ID.test(value)) throw invalid(`${label} has an invalid id`);
  if (seen.has(value)) throw invalid(`duplicate ${label} id ${value}`);
  seen.add(value);
  return value;
}

// Validates and cleans a graph. Structure only by default (ids, endpoints, cycles); with
// checkPorts also verifies that edges use existing ports of known node types (import).
// Unknown node types are kept untouched.
function normalizeGraph(raw, { registry = nodeRegistry.registry, checkPorts = false } = {}) {
  if (!isPlainObject(raw)) throw invalid('graph must be an object');
  const rawNodes = arrayOf(raw.nodes, 'nodes', LIMITS.maxNodes);
  const rawEdges = arrayOf(raw.edges, 'edges', LIMITS.maxEdges);
  const rawGroups = arrayOf(raw.groups, 'groups', LIMITS.maxGroups);
  const rawNotes = arrayOf(raw.notes, 'notes', LIMITS.maxNotes);

  const nodeIds = new Set();
  const nodes = rawNodes.map((node) => {
    if (!isPlainObject(node)) throw invalid('node must be an object');
    const id = uniqueId(node.id, 'node', nodeIds);
    if (typeof node.type !== 'string' || !TYPE_ID.test(node.type)) throw invalid(`node ${id} has an invalid type`);
    const clean = {
      ...node,
      id,
      type: node.type,
      typeVersion: Number.isInteger(node.typeVersion) && node.typeVersion > 0 ? node.typeVersion : 1,
      x: finiteOr(node.x, 0),
      y: finiteOr(node.y, 0),
      params: isPlainObject(node.params) ? node.params : {}
    };
    if (node.title !== undefined && node.title !== null) clean.title = cleanString(node.title, 120);
    else delete clean.title;
    return clean;
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edgeIds = new Set();
  const edgeKeys = new Set();
  const edges = rawEdges.map((edge) => {
    if (!isPlainObject(edge)) throw invalid('edge must be an object');
    const id = uniqueId(edge.id, 'edge', edgeIds);
    const from = edge.from;
    const to = edge.to;
    if (!isPlainObject(from) || !isPlainObject(to)) throw invalid(`edge ${id} needs from and to`);
    if (!nodeById.has(from.node) || !nodeById.has(to.node)) throw invalid(`edge ${id} is dangling (unknown node)`);
    if (from.node === to.node) throw invalid(`edge ${id} connects a node to itself`);
    if (typeof from.port !== 'string' || !PORT_ID.test(from.port) || typeof to.port !== 'string' || !PORT_ID.test(to.port)) {
      throw invalid(`edge ${id} has an invalid port`);
    }
    const key = `${from.node}.${from.port}>${to.node}.${to.port}`;
    if (edgeKeys.has(key)) throw invalid(`edge ${id} duplicates another edge`);
    edgeKeys.add(key);
    if (checkPorts) {
      for (const [side, endpoint, direction] of [['from', from, 'outputs'], ['to', to, 'inputs']]) {
        const node = nodeById.get(endpoint.node);
        const def = registry.get(node.type);
        if (!def) continue;
        const ports = registry.portsFor(def, registry.normalizeParams(def, node.params))[direction];
        if (!ports.some((port) => port.id === endpoint.port)) {
          throw invalid(`edge ${id} is dangling (${side} port ${endpoint.port} does not exist on ${node.type})`);
        }
      }
    }
    return { ...edge, id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
  });

  if (topoSort(nodes, edges).cyclic) throw invalid('graph contains a cycle');

  const groupIds = new Set();
  const groups = rawGroups.map((group) => {
    if (!isPlainObject(group)) throw invalid('group must be an object');
    return {
      ...group,
      id: uniqueId(group.id, 'group', groupIds),
      title: cleanString(group.title, 120),
      x: finiteOr(group.x, 0),
      y: finiteOr(group.y, 0),
      w: Math.max(0, finiteOr(group.w, 200)),
      h: Math.max(0, finiteOr(group.h, 120)),
      color: cleanString(group.color, 24)
    };
  });

  const noteIds = new Set();
  const notes = rawNotes.map((note) => {
    if (!isPlainObject(note)) throw invalid('note must be an object');
    return {
      ...note,
      id: uniqueId(note.id, 'note', noteIds),
      x: finiteOr(note.x, 0),
      y: finiteOr(note.y, 0),
      w: Math.max(0, finiteOr(note.w, 240)),
      h: Math.max(0, finiteOr(note.h, 120)),
      text: cleanString(note.text, 20000)
    };
  });

  const viewport = isPlainObject(raw.viewport)
    ? { x: finiteOr(raw.viewport.x, 0), y: finiteOr(raw.viewport.y, 0), zoom: Math.min(2.5, Math.max(0.1, finiteOr(raw.viewport.zoom, 1))) }
    : { x: 0, y: 0, zoom: 1 };

  const graph = { nodes, edges, groups, notes, viewport };
  if (Buffer.byteLength(JSON.stringify(graph)) > LIMITS.maxDocumentBytes) throw invalid('graph is too large');
  return graph;
}

const EMPTY_APP = Object.freeze({ enabled: false, title: '', description: '', inputs: [], outputs: [] });
// Steps of approval an app output can be marked for (`approve`, SPEC §14), and the length of the hint that goes with a mark.
const MAX_APPROVAL_STAGE = 5;
const MAX_APPROVAL_HINT = 300;

// The approval step of an app output as it is stored: `true` for step 1 (also written as 1), a whole number from 2 to 5 for a
// later step, null for anything else (no mark). Step 1 stays `true`, so the apps of before are stored byte for byte as they were.
function approvalStage(value) {
  if (value === true || value === 1) return true;
  return Number.isInteger(value) && value >= 2 && value <= MAX_APPROVAL_STAGE ? value : null;
}

// Cleans the Design App section. References to nodes that no longer exist are dropped;
// exposed params must exist and app outputs must be output.result nodes (known types only).
// An output may carry `approve` (the app view makes it in a step of its own and asks for the approval before the next one): `true`
// for step 1, 2 to 5 for a later step (approvalStage; anything else is dropped), and `hint`, a text of at most 300 characters the
// app view shows while the step stands for approval. An output without them stays { node, label } byte for byte.
function normalizeApp(raw, graph, { registry = nodeRegistry.registry } = {}) {
  if (raw === undefined || raw === null) return { ...EMPTY_APP, inputs: [], outputs: [] };
  if (!isPlainObject(raw)) throw invalid('app must be an object');
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const inputs = arrayOf(raw.inputs, 'app.inputs', 100)
    .map((entry) => {
      if (!isPlainObject(entry) || typeof entry.node !== 'string' || typeof entry.param !== 'string') {
        throw invalid('app input needs node and param');
      }
      return { node: entry.node, param: entry.param, label: cleanString(entry.label, 120) };
    })
    .filter((entry) => nodeById.has(entry.node));
  for (const entry of inputs) {
    const def = registry.get(nodeById.get(entry.node).type);
    if (def && !def.params.some((param) => param.id === entry.param)) {
      throw invalid(`app input ${entry.node}.${entry.param} does not exist`);
    }
  }
  const outputs = arrayOf(raw.outputs, 'app.outputs', 100)
    .map((entry) => {
      if (!isPlainObject(entry) || typeof entry.node !== 'string') throw invalid('app output needs a node');
      const approve = approvalStage(entry.approve);
      const hint = typeof entry.hint === 'string' ? cleanString(entry.hint.trim(), MAX_APPROVAL_HINT) : '';
      return { node: entry.node, label: cleanString(entry.label, 120), ...(approve !== null ? { approve } : {}), ...(hint ? { hint } : {}) };
    })
    .filter((entry) => nodeById.has(entry.node));
  for (const entry of outputs) {
    const node = nodeById.get(entry.node);
    if (registry.get(node.type) && node.type !== 'output.result') {
      throw invalid(`app output ${entry.node} must be an output.result node`);
    }
  }
  return {
    enabled: raw.enabled === true,
    title: cleanString(raw.title, 120),
    description: cleanString(raw.description, 2000),
    inputs,
    outputs
  };
}

// Keeps the stored app but drops references to nodes that no longer exist (no validation, never throws).
function pruneApp(app, graph) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const source = isPlainObject(app) ? app : EMPTY_APP;
  return {
    ...source,
    inputs: (Array.isArray(source.inputs) ? source.inputs : []).filter((entry) => ids.has(entry?.node)),
    outputs: (Array.isArray(source.outputs) ? source.outputs : []).filter((entry) => ids.has(entry?.node))
  };
}

// Media input params (`asset`, `assets`) point into the exporting workflow's backing session;
// after import they are kept but marked missing so the node shows "re-upload".
function markAssetsMissing(graph) {
  const mark = (entry) => (isPlainObject(entry) ? { ...entry, missing: true } : entry);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const params = { ...node.params };
      if (isPlainObject(params.asset)) params.asset = mark(params.asset);
      if (Array.isArray(params.assets)) params.assets = params.assets.map(mark);
      return { ...node, params };
    })
  };
}

// Every media input param of a graph, in node order: `params.asset` (index null) and the entries of
// `params.assets` (index = position in the list). Only plain objects count; the export, the ZIP import and
// the recovery of files during a JSON import all walk the graph with this one function.
function assetParamRefs(graph) {
  const refs = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const params = isPlainObject(node.params) ? node.params : {};
    if (isPlainObject(params.asset)) refs.push({ nodeId: node.id, param: 'asset', index: null, entry: params.asset });
    if (Array.isArray(params.assets)) {
      params.assets.forEach((entry, index) => {
        if (isPlainObject(entry)) refs.push({ nodeId: node.id, param: 'assets', index, entry });
      });
    }
  }
  return refs;
}

// Copy of the graph in which `resolve(ref)` (sync or async) may replace a media param entry: a returned plain
// object replaces it, anything else leaves it as it is. Returns { graph, replaced }.
async function mapAssetParams(graph, resolve) {
  let replaced = 0;
  const nodes = [];
  for (const node of graph.nodes) {
    const params = isPlainObject(node.params) ? { ...node.params } : {};
    if (isPlainObject(params.asset)) {
      const next = await resolve({ nodeId: node.id, param: 'asset', index: null, entry: params.asset });
      if (isPlainObject(next)) {
        params.asset = next;
        replaced += 1;
      }
    }
    if (Array.isArray(params.assets)) {
      const list = [];
      for (let index = 0; index < params.assets.length; index += 1) {
        const entry = params.assets[index];
        const next = isPlainObject(entry) ? await resolve({ nodeId: node.id, param: 'assets', index, entry }) : undefined;
        if (isPlainObject(next)) {
          list.push(next);
          replaced += 1;
        } else {
          list.push(entry);
        }
      }
      params.assets = list;
    }
    nodes.push({ ...node, params });
  }
  return { graph: { ...graph, nodes }, replaced };
}

function cleanName(value, fallback = 'Untitled workflow') {
  const name = cleanString(value, LIMITS.maxNameLength).trim();
  return name || fallback;
}

// Validates an export/template document and returns { name, description, graph, app } ready to store.
function validateDocument(doc, { registry = nodeRegistry.registry } = {}) {
  if (!isPlainObject(doc)) throw invalid('document must be an object');
  if (doc.format !== FORMAT) throw invalid(`unsupported format (expected ${FORMAT})`);
  if (!Number.isInteger(doc.version) || doc.version < 1) throw invalid('document version is missing');
  if (doc.version > VERSION) throw invalid(`document version ${doc.version} is newer than this server supports (${VERSION})`);
  if (Buffer.byteLength(JSON.stringify(doc)) > LIMITS.maxDocumentBytes) throw invalid('document is larger than 2 MB');
  let current = doc;
  for (let version = doc.version; version < VERSION; version += 1) {
    if (MIGRATIONS[version]) current = MIGRATIONS[version](current);
  }
  const graph = markAssetsMissing(normalizeGraph(current.graph, { registry, checkPorts: true }));
  return {
    name: cleanName(current.name),
    description: cleanString(current.description, 2000),
    graph,
    app: normalizeApp(current.app, graph, { registry })
  };
}

/* ---------- results helpers ---------- */

function emptyResults() {
  return { version: 1, nodes: {} };
}

function newId(prefix, randomBytes = 3) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(randomBytes).toString('hex')}`;
}

// First image url found in a variant (values or lists of values), else null.
function imageUrlInVariant(variant) {
  for (const value of Object.values(variant || {})) {
    const candidates = value && value.type === 'list' && Array.isArray(value.items) ? value.items : [value];
    for (const candidate of candidates) {
      if (candidate && candidate.type === 'image' && typeof candidate.url === 'string') return candidate.url;
      if (candidate && candidate.type === 'list' && Array.isArray(candidate.items)) {
        const nested = candidate.items.find((item) => item && item.type === 'image' && typeof item.url === 'string');
        if (nested) return nested.url;
      }
    }
  }
  return null;
}

// Latest image result of an output.result node, else of any node.
function thumbnailFor(workflow, results) {
  const pick = (predicate) => {
    let best = null;
    for (const node of workflow.graph.nodes) {
      if (!predicate(node)) continue;
      const nodeResults = results.nodes?.[node.id];
      const entry = nodeResults?.history?.find((item) => item.id === nodeResults.selected?.entry);
      if (!entry) continue;
      const url = imageUrlInVariant(entry.variants?.[nodeResults.selected.variant]);
      if (url && (!best || String(entry.createdAt) >= String(best.createdAt))) best = { createdAt: entry.createdAt, url };
    }
    return best?.url || null;
  };
  return pick((node) => node.type === 'output.result') || pick(() => true);
}

/* ---------- deleting results (WP38e) ---------- */

const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const ASSET_URL = /\/assets\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._%-]+)/g;

// Every file of the session `sessionId` that a JSON value points at, whatever its shape: an object with an `assetId` (and the
// session of the file or none) names it by id, an object with a `file` by file name, a string with `/assets/<session>/<file>` (an
// address) by file name. Added to refs = { ids: Set, files: Set }. Used for "is anything still pointing at this file": it errs on
// the side of finding too much, never too little.
function collectFileRefs(value, sessionId, refs = { ids: new Set(), files: new Set() }) {
  if (typeof value === 'string') {
    if (value.includes('/assets/')) {
      ASSET_URL.lastIndex = 0;
      let match;
      while ((match = ASSET_URL.exec(value))) {
        if (match[1] !== sessionId) continue;
        try {
          refs.files.add(decodeURIComponent(match[2]));
        } catch (_) {
          refs.files.add(match[2]);
        }
      }
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, sessionId, refs);
    return refs;
  }
  if (!isPlainObject(value)) return refs;
  const own = !value.sessionId || value.sessionId === sessionId;
  if (own && typeof value.assetId === 'string') refs.ids.add(value.assetId);
  if (own && typeof value.file === 'string') refs.files.add(value.file);
  for (const inner of Object.values(value)) collectFileRefs(inner, sessionId, refs);
  return refs;
}

// The media of the session that a result (history entries, items a failed run kept) holds: ids of the files.
function ownMediaIds(value, sessionId, ids = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) ownMediaIds(item, sessionId, ids);
  } else if (isPlainObject(value)) {
    if (typeof value.assetId === 'string' && value.sessionId === sessionId) ids.add(value.assetId);
    for (const inner of Object.values(value)) ownMediaIds(inner, sessionId, ids);
  }
  return ids;
}

// What an entry holds per item of its list, as the cache per item sees it: canonical JSON of { port: item } for every position.
function itemSignatures(entry, into = new Set()) {
  const variant = entry && Array.isArray(entry.variants) ? entry.variants[0] : null;
  if (!isPlainObject(variant) || !Array.isArray(entry.itemKeys)) return into;
  for (let index = 0; index < entry.itemKeys.length; index += 1) {
    const item = {};
    for (const [portId, value] of Object.entries(variant)) {
      if (isPlainObject(value) && value.type === 'list' && Array.isArray(value.items) && value.items.length === entry.itemKeys.length) item[portId] = value.items[index];
    }
    if (Object.keys(item).length) into.add(canonicalJson(item));
  }
  return into;
}

// The items a failed run kept (nodeResults.partial) are a cache too (SPEC §9.6). After entries were deleted, no item may stay in it
// that is one of theirs (also a copy the run took from such an entry); items of the run's own stay, so paid work is not lost
// without need. A partial without the keys to tell them apart goes as a whole.
function prunePartial(nodeResults, removedEntries) {
  const partial = nodeResults.partial;
  if (!isPlainObject(partial)) return;
  if (!isPlainObject(partial.items) || !Array.isArray(partial.itemKeys)) {
    delete nodeResults.partial;
    return;
  }
  const signatures = new Set();
  for (const entry of removedEntries) itemSignatures(entry, signatures);
  for (const [index, item] of Object.entries(partial.items)) {
    if (!isPlainObject(item?.variant) || signatures.has(canonicalJson(item.variant))) delete partial.items[index];
  }
  if (!Object.keys(partial.items).length) {
    delete nodeResults.partial;
    return;
  }
  if (Array.isArray(partial.forcedItems)) partial.forcedItems = partial.forcedItems.filter((index) => partial.items[index] !== undefined);
}

/* ---------- store ---------- */

function createWorkflowsStore({ dir = DEFAULT_DIR, sessions = sessionStore, registry = nodeRegistry.registry, events = eventsModule } = {}) {
  function assertId(id) {
    if (!sessions.isValidId(id)) throw storeError('INVALID_ID', 'Invalid workflow id');
    return id;
  }

  const workflowDir = (id) => path.join(dir, assertId(id));
  const workflowFile = (id) => path.join(workflowDir(id), 'workflow.json');
  const resultsFile = (id) => path.join(workflowDir(id), 'results.json');
  const runsDir = (id) => path.join(workflowDir(id), 'runs');
  const runFile = (id, runId) => {
    if (!sessions.isValidId(runId)) throw storeError('INVALID_ID', 'Invalid run id');
    return path.join(runsDir(id), `${runId}.json`);
  };

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async function readJson(file) {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  }

  const lockKey = (id) => `wf:${id}`;
  const resultsLockKey = (id) => `wf-results:${id}`;

  /* ----- workflows ----- */

  async function readWorkflow(id) {
    let raw;
    try {
      raw = await readJson(workflowFile(id));
    } catch (err) {
      if (err.code === 'ENOENT') throw storeError('WORKFLOW_NOT_FOUND', 'Workflow not found');
      throw err;
    }
    raw.graph = isPlainObject(raw.graph) ? raw.graph : { nodes: [], edges: [], groups: [], notes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    for (const key of ['nodes', 'edges', 'groups', 'notes']) if (!Array.isArray(raw.graph[key])) raw.graph[key] = [];
    raw.app = isPlainObject(raw.app) ? raw.app : { ...EMPTY_APP, inputs: [], outputs: [] };
    // Sharing fields (owner, shareMode, sharedWith) are read through access.sharingOf: files without them stay valid as they are.
    return raw;
  }

  async function readResults(id) {
    try {
      const raw = await readJson(resultsFile(id));
      return isPlainObject(raw) && isPlainObject(raw.nodes) ? raw : emptyResults();
    } catch (_) {
      return emptyResults();
    }
  }

  // The results are read under their lock: a change in progress (deleting results) is complete before a run takes its picture of them.
  async function getWorkflow(id) {
    assertId(id);
    const workflow = await readWorkflow(id);
    return { workflow, results: await sessions.withLock(resultsLockKey(id), () => readResults(id)) };
  }

  async function workflowExists(id) {
    try {
      await fsp.access(workflowFile(id));
      return true;
    } catch (_) {
      return false;
    }
  }

  function summary(workflow, results, { includeSharing = false } = {}) {
    const item = {
      id: workflow.id,
      name: workflow.name,
      folder: workflow.folder || null,
      updatedAt: workflow.updatedAt,
      updatedBy: workflow.updatedBy || null,
      nodeCount: workflow.graph.nodes.length,
      app: { enabled: workflow.app?.enabled === true }
    };
    const thumbnail = results ? thumbnailFor(workflow, results) : null;
    if (thumbnail) item.thumbnail = thumbnail;
    if (includeSharing) {
      Object.assign(item, access.sharingOf(workflow));
      // For the team groups of the admins (lib/team-groups.js); the routes remove both again.
      item.createdAt = workflow.createdAt;
      if (typeof workflow.teamId === 'string') item.teamId = workflow.teamId;
    }
    return item;
  }

  // includeSharing: the summaries also carry owner, shareMode and sharedWith (the routes filter and decorate them).
  async function listWorkflows({ q, includeSharing = false } = {}) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return [];
    }
    const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
    const out = [];
    for (const name of names) {
      if (!sessions.isValidId(name)) continue;
      try {
        const workflow = await readWorkflow(name);
        if (needle && !`${workflow.name}\n${workflow.folder || ''}`.toLowerCase().includes(needle)) continue;
        out.push(summary(workflow, await readResults(name), { includeSharing }));
      } catch (_) {
        /* skip unreadable workflow folders */
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  // Creates a workflow plus its hidden backing session. `document` (export/template format)
  // takes precedence over graph/app/description.
  // owner (user management): the creator's address; the workflow and its backing session start private.
  // teamId: the creator's team (lib/team-groups.js teamForNew); the routes set it, a document never carries it.
  async function createWorkflow({ name, folder = null, description = '', graph, app, document, user = 'lokal', owner = null, teamId = null } = {}) {
    let base;
    if (document !== undefined && document !== null) {
      base = validateDocument(document, { registry });
      if (name) base.name = cleanName(name);
    } else {
      const cleanGraph = normalizeGraph(graph || { nodes: [], edges: [] }, { registry });
      base = {
        name: cleanName(name),
        description: cleanString(description, 2000),
        graph: cleanGraph,
        app: normalizeApp(app, cleanGraph, { registry })
      };
    }
    const id = newId('wf');
    const cleanOwner = access.normalizeEmail(owner);
    const session = await sessions.createSession({
      folder: folder || null,
      kind: 'workflow',
      title: `Workflow: ${base.name}`,
      ...(cleanOwner ? { owner: cleanOwner } : {})
    });
    const now = new Date().toISOString();
    const workflow = {
      format: FORMAT,
      version: VERSION,
      id,
      name: base.name,
      description: base.description,
      folder: session.folder || null,
      sessionId: session.id,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: user,
      updatedBy: user,
      graph: base.graph,
      app: base.app,
      ...(cleanOwner ? { owner: cleanOwner, shareMode: 'private', sharedWith: [] } : {}),
      ...(cleanOwner && sessions.isValidId(teamId) ? { teamId } : {})
    };
    try {
      await writeJson(workflowFile(id), workflow);
      await writeJson(resultsFile(id), emptyResults());
    } catch (err) {
      await sessions.deleteSession(session.id).catch(() => {});
      await fsp.rm(workflowDir(id), { recursive: true, force: true });
      throw err;
    }
    return { workflow, results: emptyResults() };
  }

  function comparableContent(workflow) {
    const { viewport, ...graphWithoutViewport } = workflow.graph;
    return canonicalJson({
      graph: graphWithoutViewport,
      name: workflow.name,
      description: workflow.description,
      app: workflow.app
    });
  }

  // Autosave (PUT). Optimistic concurrency: baseRev must equal the stored rev. The rev only advances
  // when something other than the viewport changed, so panning does not notify other tabs.
  async function saveGraph(id, { baseRev, graph, name, description, app, user = 'lokal' } = {}) {
    if (!Number.isInteger(baseRev)) throw invalid('baseRev is required');
    const outcome = await sessions.withLock(lockKey(id), async () => {
      const workflow = await readWorkflow(id);
      if (workflow.rev !== baseRev) {
        throw storeError('REV_CONFLICT', 'Workflow was changed elsewhere', { rev: workflow.rev });
      }
      const cleanGraph = normalizeGraph(graph, { registry });
      const before = comparableContent(workflow);
      const next = { ...workflow, graph: cleanGraph };
      if (name !== undefined) next.name = cleanName(name, workflow.name);
      if (description !== undefined) next.description = cleanString(description, 2000);
      next.app = app !== undefined ? normalizeApp(app, cleanGraph, { registry }) : pruneApp(workflow.app, cleanGraph);
      const changed = before !== comparableContent(next);
      if (changed) {
        next.rev = workflow.rev + 1;
        next.updatedAt = new Date().toISOString();
        next.updatedBy = user;
      }
      await writeJson(workflowFile(id), next);
      return { workflow: next, changed, renamed: next.name !== workflow.name };
    });
    if (outcome.renamed) {
      await sessions.updateSessionMeta(outcome.workflow.sessionId, { title: `Workflow: ${outcome.workflow.name}` }).catch(() => {});
    }
    if (outcome.changed) events.emit(id, { type: 'workflow_saved', rev: outcome.workflow.rev, updatedBy: user });
    return { rev: outcome.workflow.rev, updatedAt: outcome.workflow.updatedAt };
  }

  // PATCH: rename and/or move to a project folder. Does not change the rev (graph untouched);
  // keeps the backing session title and folder in sync.
  async function patchMeta(id, { name, folder, user = 'lokal' } = {}) {
    const hasFolder = folder !== undefined;
    const workflow = await sessions.withLock(lockKey(id), async () => {
      const current = await readWorkflow(id);
      if (name !== undefined) current.name = cleanName(name, current.name);
      if (hasFolder) {
        const meta = await sessions.updateSessionMeta(current.sessionId, { folder: folder === null || folder === '' ? null : folder });
        current.folder = meta.folder;
      }
      current.updatedAt = new Date().toISOString();
      current.updatedBy = user;
      await writeJson(workflowFile(id), current);
      return current;
    });
    if (name !== undefined) {
      await sessions.updateSessionMeta(workflow.sessionId, { title: `Workflow: ${workflow.name}` }).catch(() => {});
    }
    // Other tabs must not overwrite the new name/folder with their stale copy.
    events.emit(id, { type: 'workflow_renamed', name: workflow.name, folder: workflow.folder || null, updatedBy: user });
    return { id, name: workflow.name, folder: workflow.folder || null, rev: workflow.rev, updatedAt: workflow.updatedAt };
  }

  // Sets the sharing of a workflow and of its backing session (chat assets are served by session id, so both
  // must agree). `owner` is set only when given (an admin taking over a workflow without an owner).
  // Emits access_changed so open event streams re-check their access.
  async function setSharing(id, { shareMode, sharedWith, sharedTeams, owner } = {}) {
    const sharing = access.buildSharing({ shareMode, sharedWith, sharedTeams }, {}, () => true);
    const cleanOwner = owner === undefined ? undefined : access.normalizeEmail(owner);
    const workflow = await sessions.withLock(lockKey(id), async () => {
      const current = await readWorkflow(id);
      if (cleanOwner) current.owner = cleanOwner;
      current.shareMode = sharing.shareMode;
      current.sharedWith = sharing.sharedWith;
      if (sharing.sharedTeams) current.sharedTeams = sharing.sharedTeams;
      else delete current.sharedTeams;
      await writeJson(workflowFile(id), current);
      return current;
    });
    if (workflow.sessionId && typeof sessions.updateSessionSharing === 'function') {
      await sessions.updateSessionSharing(workflow.sessionId, {
        shareMode: workflow.shareMode,
        sharedWith: workflow.sharedWith,
        ...(workflow.sharedTeams ? { sharedTeams: workflow.sharedTeams } : {}),
        ...(cleanOwner ? { owner: cleanOwner } : {})
      });
    }
    events.emit(id, { type: 'access_changed' });
    return access.sharingOf(workflow);
  }

  // A project was renamed (newFolder = its new name) or deleted (newFolder = null) in the chat view:
  // workflow.json keeps its own copy of the folder, so it follows.
  async function followFolderChange(oldFolder, newFolder) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (!sessions.isValidId(name)) continue;
      await sessions.withLock(lockKey(name), async () => {
        let workflow;
        try {
          workflow = await readWorkflow(name);
        } catch (_) {
          return;
        }
        if (workflow.folder !== oldFolder) return;
        workflow.folder = newFolder;
        await writeJson(workflowFile(name), workflow);
      });
    }
  }
  if (typeof sessions.onFolderChange === 'function') sessions.onFolderChange(followFolderChange);

  // Deletes the workflow folder and its backing session including all assets (cost journal lines remain).
  // The caller must refuse while a run is active.
  async function deleteWorkflow(id) {
    const workflow = await readWorkflow(id);
    await sessions.withLock(lockKey(id), async () => {
      if (workflow.sessionId) await sessions.deleteSession(workflow.sessionId);
      await fsp.rm(workflowDir(id), { recursive: true, force: true });
    });
    return { id };
  }

  // Copies an asset param (upload response or { sessionId, assetId }) into another session.
  async function copyAssetParam(entry, fromSessionId, toSessionId) {
    if (!isPlainObject(entry) || entry.missing === true) return entry;
    const ref = assets.assetRefFromParam(entry, fromSessionId);
    if (!ref || ref.sessionId !== fromSessionId) return { ...entry, missing: true };
    try {
      const value = await assets.copyAsset(ref.sessionId, ref.assetId, toSessionId);
      return { ...entry, sessionId: value.sessionId, assetId: value.assetId, file: value.file, url: value.url };
    } catch (_) {
      return { ...entry, missing: true };
    }
  }

  // New workflow with the same graph and app, its own backing session, referenced input assets
  // copied over and no results.
  async function duplicateWorkflow(id, { name, user = 'lokal', owner = null, teamId = null } = {}) {
    const source = await readWorkflow(id);
    const created = await createWorkflow({
      owner,
      teamId,
      name: name || `${source.name} (copy)`,
      folder: source.folder || null,
      description: source.description,
      graph: source.graph,
      app: source.app,
      user
    });
    const target = created.workflow;
    const nodes = [];
    for (const node of target.graph.nodes) {
      const params = { ...node.params };
      if (isPlainObject(params.asset)) params.asset = await copyAssetParam(params.asset, source.sessionId, target.sessionId);
      if (Array.isArray(params.assets)) {
        params.assets = await Promise.all(params.assets.map((entry) => copyAssetParam(entry, source.sessionId, target.sessionId)));
      }
      nodes.push({ ...node, params });
    }
    target.graph = { ...target.graph, nodes };
    await writeJson(workflowFile(target.id), target);
    return created;
  }

  // Replaces media params of a stored workflow (files that were brought along by an import). `resolve(ref)`
  // as in mapAssetParams. The graph changes without a new rev: the workflow was created a moment ago and no
  // client has seen it yet. Returns { workflow, replaced }.
  async function relinkAssets(id, resolve) {
    return sessions.withLock(lockKey(id), async () => {
      const workflow = await readWorkflow(id);
      const { graph, replaced } = await mapAssetParams(workflow.graph, resolve);
      if (replaced) {
        workflow.graph = graph;
        await writeJson(workflowFile(id), workflow);
      }
      return { workflow, replaced };
    });
  }

  function exportDocument(workflow) {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      name: workflow.name,
      description: workflow.description || '',
      graph: workflow.graph,
      app: workflow.app
    };
  }

  async function exportWorkflow(id) {
    return exportDocument(await readWorkflow(id));
  }

  /* ----- results (engine-owned) ----- */

  // Serialised read-modify-write of results.json. fn mutates the results object and may return a value.
  async function updateResults(id, fn) {
    assertId(id);
    return sessions.withLock(resultsLockKey(id), async () => {
      const results = await readResults(id);
      const value = await fn(results);
      await writeJson(resultsFile(id), results);
      return value;
    });
  }

  function nodeResultsOf(results, nodeId) {
    if (!isPlainObject(results.nodes[nodeId])) results.nodes[nodeId] = { selected: null, history: [] };
    return results.nodes[nodeId];
  }

  // Adds a history entry (newest first, capped) and by default selects its first variant.
  async function appendHistory(id, nodeId, entry, { select = true } = {}) {
    return updateResults(id, (results) => {
      const nodeResults = nodeResultsOf(results, nodeId);
      const stored = { ...entry, id: entry.id || newId('h') };
      nodeResults.history = [stored, ...nodeResults.history].slice(0, LIMITS.maxHistory);
      if (select) nodeResults.selected = { entry: stored.id, variant: 0 };
      return { entry: stored, node: JSON.parse(JSON.stringify(nodeResults)) };
    });
  }

  // Selects a history entry and variant (PATCH results/:nodeId).
  async function selectVariant(id, nodeId, { entry, variant = 0 } = {}) {
    return updateResults(id, (results) => {
      const nodeResults = results.nodes[nodeId];
      const target = nodeResults?.history?.find((item) => item.id === entry);
      if (!target) throw storeError('ENTRY_NOT_FOUND', 'History entry not found');
      if (!Number.isInteger(variant) || variant < 0 || variant >= (target.variants || []).length) {
        throw storeError('ENTRY_NOT_FOUND', 'Variant not found');
      }
      nodeResults.selected = { entry, variant };
      return JSON.parse(JSON.stringify(nodeResults));
    });
  }

  // Who else may hold a file of the backing session (outside of this workflow's own documents): an open provider job of the session that
  // still has published reference copies (lib/publicrefs.js; the copies carry no link back to the file, so every file is kept while
  // such a job is open) and the chats (a stored chat that mentions the file by address, or by session and asset id). Returns the Set of
  // the asset ids to keep. Any failure keeps everything.
  async function defaultHolds({ sessionId, assets: list }) {
    const all = () => new Set(list.map((item) => item.assetId));
    try {
      const session = await sessions.readSession(sessionId);
      const open = (Array.isArray(session.jobs) ? session.jobs : []).some(
        (job) => !TERMINAL_JOB_STATES.has(String(job?.status || 'pending')) && Array.isArray(job.publicRefFiles) && job.publicRefFiles.length
      );
      if (open) return all();
      if (typeof sessions.findInSessionFiles !== 'function') return new Set();
      const tests = new Map(
        list.map((item) => [item.assetId, (text) => text.includes(`/assets/${sessionId}/${item.file}`) || text.includes(`"${item.assetId}"`)])
      );
      return await sessions.findInSessionFiles(sessionId, tests, { excludeId: sessionId });
    } catch (_) {
      return all();
    }
  }

  // The files of the deleted results go, but only the ones nothing else needs: own session (anything else is not touched at all),
  // not named by any other entry of any node (a Result node passes the same file on), by a partial result, by a parameter of an input
  // node or by the app, and not held outside (holds). Everything else stays in the ledger as it was. Returns { deleted, kept } (asset ids).
  async function releaseFiles(id, sessionId, candidates, holds) {
    const none = { deleted: [], kept: [] };
    if (!candidates.size || !sessionId) return none;
    const ledger = await sessions.readLedger(sessionId);
    const byId = new Map(ledger.map((entry) => [entry.id, entry]));
    const list = [...candidates]
      .filter((assetId) => byId.has(assetId) && !byId.get(assetId).pending && assets.isSafeFilename(byId.get(assetId).file))
      .map((assetId) => ({ assetId, file: byId.get(assetId).file }));
    if (!list.length) return none;
    let held;
    try {
      held = await holds({ sessionId, assets: list });
    } catch (_) {
      held = new Set(list.map((item) => item.assetId));
    }
    // Under the lock of the workflow: nobody saves a graph (a new asset parameter) while the references are read and the files go.
    return sessions.withLock(lockKey(id), async () => {
      const workflow = await readWorkflow(id);
      const refs = collectFileRefs(workflow, sessionId);
      collectFileRefs(await readResults(id), sessionId, refs);
      const deleted = [];
      const kept = [];
      for (const item of list) {
        if (held.has(item.assetId) || refs.ids.has(item.assetId) || refs.files.has(item.file)) kept.push(item.assetId);
        else deleted.push(item.assetId);
      }
      const removed = deleted.length ? new Set(await sessions.removeAssets(sessionId, deleted)) : new Set();
      return { deleted: deleted.filter((assetId) => removed.has(assetId)), kept: [...kept, ...deleted.filter((assetId) => !removed.has(assetId))] };
    });
  }

  // Deletes one history entry of a node (`entry`), or all results of the node (`entry` left out): DELETE results/:nodeId[/entries/:entryId].
  // The entry that was selected gives way to the newest one left (variant 0), none left means no result. The items a failed run kept that
  // came from the deleted entries go too (prunePartial), so nothing of them can be a cache hit any more. The files go afterwards
  // (releaseFiles). `assertIdle` runs under the lock of the results and throws when a run is active; `holds` replaces the check of
  // outside holders (tests). Returns { node, removed: [entryId], files: { deleted, kept } }.
  async function deleteResults(id, nodeId, { entry = null, assertIdle = null, holds = defaultHolds, user = 'lokal' } = {}) {
    assertId(id);
    if (typeof nodeId !== 'string' || !nodeId) throw storeError('ENTRY_NOT_FOUND', 'No results to delete');
    const workflow = await readWorkflow(id);
    const outcome = await updateResults(id, async (results) => {
      if (assertIdle) await assertIdle();
      const nodeResults = results.nodes[nodeId];
      const history = isPlainObject(nodeResults) && Array.isArray(nodeResults.history) ? nodeResults.history : [];
      let removed;
      if (entry === null) {
        if (!history.length && !(isPlainObject(nodeResults) && nodeResults.partial)) throw storeError('ENTRY_NOT_FOUND', 'The node has no results');
        removed = history.slice();
      } else {
        const target = history.find((item) => item.id === entry);
        if (!target) throw storeError('ENTRY_NOT_FOUND', 'History entry not found');
        removed = [target];
      }
      const partialBefore = isPlainObject(nodeResults.partial) ? JSON.parse(JSON.stringify(nodeResults.partial)) : null;
      let node;
      if (entry === null) {
        delete results.nodes[nodeId];
        node = { selected: null, history: [] };
      } else {
        nodeResults.history = history.filter((item) => item.id !== entry);
        const selectedStays = nodeResults.selected && nodeResults.history.some((item) => item.id === nodeResults.selected.entry);
        if (!selectedStays) nodeResults.selected = nodeResults.history.length ? { entry: nodeResults.history[0].id, variant: 0 } : null;
        prunePartial(nodeResults, removed);
        node = JSON.parse(JSON.stringify(nodeResults));
      }
      const candidates = new Set();
      for (const item of removed) ownMediaIds(item, workflow.sessionId, candidates);
      if (partialBefore && (entry === null || !node.partial || JSON.stringify(partialBefore) !== JSON.stringify(node.partial))) {
        ownMediaIds(partialBefore, workflow.sessionId, candidates);
      }
      return { node, removed: removed.map((item) => item.id), candidates };
    });
    const files = await releaseFiles(id, workflow.sessionId, outcome.candidates, holds);
    events.emit(id, { type: 'results_changed', nodeId, updatedBy: user });
    return { node: outcome.node, removed: outcome.removed, files };
  }

  /* ----- runs ----- */

  const newRunId = () => newId('r', 2);

  async function writeRun(id, run) {
    await writeJson(runFile(id, run.id), run);
    return run;
  }

  async function readRun(id, runId) {
    try {
      return await readJson(runFile(id, runId));
    } catch (err) {
      if (err.code === 'ENOENT') throw storeError('RUN_NOT_FOUND', 'Run not found');
      throw err;
    }
  }

  async function listRuns(id) {
    let names = [];
    try {
      names = await fsp.readdir(runsDir(id));
    } catch (_) {
      return [];
    }
    const runs = [];
    for (const name of names.filter((file) => file.endsWith('.json'))) {
      try {
        runs.push(await readJson(path.join(runsDir(id), name)));
      } catch (_) {
        /* ignore half-written files */
      }
    }
    runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return runs;
  }

  // The workflow a run belongs to, or null (the run service gets a run id only). Looks for the record file in the
  // workflow folders; an invalid run id finds nothing.
  async function findRunWorkflow(runId) {
    if (!sessions.isValidId(runId)) return null;
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return null;
    }
    for (const name of names) {
      if (!sessions.isValidId(name)) continue;
      try {
        await fsp.access(runFile(name, runId));
        return name;
      } catch (_) {
        /* not in this workflow */
      }
    }
    return null;
  }

  async function pruneRuns(id, keep = LIMITS.maxRuns) {
    const runs = await listRuns(id);
    for (const run of runs.slice(keep)) await fsp.rm(runFile(id, run.id), { force: true });
    return Math.max(0, runs.length - keep);
  }

  // Startup sweep: runs still marked `running` belong to a previous server process.
  async function markInterruptedRuns() {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (!sessions.isValidId(name)) continue;
      for (const run of await listRuns(name)) {
        if (run.status !== 'running') continue;
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.error = run.error || 'Server restarted during the run';
        await writeRun(name, run);
        count += 1;
      }
    }
    return count;
  }

  // Compact records of the retained runs of all workflows (monitoring): { workflowId, id, user, status, startedAt,
  // finishedAt, costUsd, credits, error }.
  async function listAllRuns() {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!sessions.isValidId(name)) continue;
      for (const run of await listRuns(name)) {
        out.push({
          workflowId: name,
          id: run.id,
          user: typeof run.user === 'string' ? run.user : 'lokal',
          status: run.status,
          startedAt: run.startedAt || null,
          finishedAt: run.finishedAt || null,
          costUsd: Number.isFinite(run.cost?.usd) ? run.cost.usd : null,
          credits: Number.isFinite(run.cost?.credits) ? run.cost.credits : null,
          error: typeof run.error === 'string' ? run.error.slice(0, 300) : null
        });
      }
    }
    return out;
  }

  return {
    dir,
    limits: LIMITS,
    readWorkflow,
    readResults,
    getWorkflow,
    workflowExists,
    listWorkflows,
    createWorkflow,
    saveGraph,
    patchMeta,
    setSharing,
    deleteWorkflow,
    duplicateWorkflow,
    relinkAssets,
    exportWorkflow,
    exportDocument,
    summary,
    updateResults,
    appendHistory,
    selectVariant,
    deleteResults,
    newRunId,
    writeRun,
    readRun,
    listRuns,
    findRunWorkflow,
    listAllRuns,
    pruneRuns,
    markInterruptedRuns
  };
}

module.exports = {
  FORMAT,
  VERSION,
  DEFAULT_DIR,
  LIMITS,
  MIGRATIONS,
  createWorkflowsStore,
  defaultStore: null,
  topoSort,
  ancestorsOf,
  descendantsOf,
  normalizeGraph,
  normalizeApp,
  approvalStage,
  MAX_APPROVAL_STAGE,
  MAX_APPROVAL_HINT,
  validateDocument,
  assetParamRefs,
  mapAssetParams,
  thumbnailFor,
  emptyResults,
  newId
};

// Shared instance on data/workflows for the server; tests create their own with a temp dir.
module.exports.defaultStore = createWorkflowsStore();
