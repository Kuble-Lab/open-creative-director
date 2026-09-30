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

// Cleans the Design App section. References to nodes that no longer exist are dropped;
// exposed params must exist and app outputs must be output.result nodes (known types only).
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
      return { node: entry.node, label: cleanString(entry.label, 120) };
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

  async function getWorkflow(id) {
    const workflow = await readWorkflow(id);
    return { workflow, results: await readResults(id) };
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
    if (includeSharing) Object.assign(item, access.sharingOf(workflow));
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
  async function createWorkflow({ name, folder = null, description = '', graph, app, document, user = 'lokal', owner = null } = {}) {
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
      ...(cleanOwner ? { owner: cleanOwner, shareMode: 'private', sharedWith: [] } : {})
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
  async function duplicateWorkflow(id, { name, user = 'lokal', owner = null } = {}) {
    const source = await readWorkflow(id);
    const created = await createWorkflow({
      owner,
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
    exportWorkflow,
    exportDocument,
    summary,
    updateResults,
    appendHistory,
    selectVariant,
    newRunId,
    writeRun,
    readRun,
    listRuns,
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
  validateDocument,
  thumbnailFor,
  emptyResults,
  newId
};

// Shared instance on data/workflows for the server; tests create their own with a temp dir.
module.exports.defaultStore = createWorkflowsStore();
