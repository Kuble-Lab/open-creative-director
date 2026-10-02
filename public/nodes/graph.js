'use strict';

// Pure graph model of the node view (SPEC §7.1, §12.3): no DOM, no I/O.
// Every mutation returns a new graph object (structural sharing); node objects that did not
// change keep their identity so the canvas can diff by reference.
// UMD: module.exports in Node (tests), window.OCDNodes.graph in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motion-html'));
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.graph = factory(root.OCDNodes.motionHtml);
  }
})(typeof self !== 'undefined' ? self : this, function (motionHtml) {
  const LIST_SUFFIX = '[]';
  const DEFAULT_NODE_SIZE = Object.freeze({ w: 280, h: 160 });
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 2.5;
  const MAX_NODES = 500;
  // Inserting a sub graph: gap to the existing content, and the width from which it goes below instead of beside.
  const SUBGRAPH_GAP = 120;
  const SUBGRAPH_WIDE = 2400;
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  const GROUP_COLORS = Object.freeze(['amber', 'blue', 'green', 'violet', 'rose', 'grey']);
  const PROMPT_TYPE = 'input.prompt';
  // Approximate footprint of a freshly extracted prompt node (card width + gap to its target).
  const PROMPT_NODE_WIDTH = 340;
  const PROMPT_NODE_GAP = 56;
  const PROMPT_BOOST = 10;
  // Dragging an image or text output: nodes that make a video of it (rank on top of 2 for an exact base type).
  const VIDEO_BOOST_CREATE = 3;
  const VIDEO_BOOST_LOCAL = 2;
  const VIDEO_BOOST_TEXT = 2; // from a text output: media generators (video and image alike) rank 4
  // "Convert to HTML with AI": a Motion graphics node whose HTML field holds an instruction gets a Prompt node and a
  // Motion HTML writer in front of it. Approximate card footprints for the placement.
  const MOTION_TYPE = 'video.motion_graphics';
  const MOTION_WRITER_TYPE = 'llm.motion_html';
  const WRITER_NODE_WIDTH = 340;
  const WRITER_NODE_HEIGHT = 260;
  const CONVERT_NODE_HEIGHT = 200;
  // Sources for missing inputs ("insert with inputs", the fix button of an incomplete card): the node that hands over a
  // value of a base type when the input carries no `suggest` hint, and the footprint used to lay the new cards out.
  const SOURCE_TYPES = Object.freeze({ image: 'input.image', video: 'input.video', audio: 'input.audio', text: PROMPT_TYPE });
  const SOURCE_NODE_WIDTH = 340;
  const SOURCE_NODE_GAP = 56;
  const SOURCE_ROW_GAP = 24;
  const SOURCE_NODE_HEIGHT = 220;
  // A multiple input with a `min` gets that many sources, at most this many (a minimum is a floor, not a plan).
  const MAX_MIN_SOURCES = 4;
  const SOURCE_HEIGHTS = Object.freeze({ [PROMPT_TYPE]: CONVERT_NODE_HEIGHT, [MOTION_WRITER_TYPE]: WRITER_NODE_HEIGHT });
  // A node that was asked for (hint of the input) ranks above every other candidate in the quick pick.
  const PREFER_BOOST = 20;
  // Quick pick from an unconnected multi-input of a media type: the media list node and the single
  // input node of that kind lead (the list first: it is the way to hand over several files at once).
  const MEDIA_BASES = Object.freeze(['image', 'video', 'audio']);
  const MEDIA_LIST_TYPE = 'input.media_list';
  const MEDIA_LIST_BOOST = 12;
  const MEDIA_SINGLE_BOOST = 11;
  // The port tooltip lists at most this many connections; the rest is summarised as a count.
  const PORT_TIP_MAX_CONNECTIONS = 5;

  /* ---------- basics ---------- */

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function emptyGraph() {
    return { nodes: [], edges: [], groups: [], notes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }

  // The undoable part of a graph (no viewport): what history snapshots contain.
  function content(graph) {
    return {
      nodes: clone(graph.nodes),
      edges: clone(graph.edges),
      groups: clone(graph.groups),
      notes: clone(graph.notes)
    };
  }

  function withContent(graph, snapshot) {
    const copy = clone(snapshot);
    return {
      nodes: copy.nodes || [],
      edges: copy.edges || [],
      groups: copy.groups || [],
      notes: copy.notes || [],
      viewport: graph.viewport
    };
  }

  function sameContent(a, b) {
    return JSON.stringify(content(a)) === JSON.stringify(content(b));
  }

  /* ---------- ids ---------- */

  function allIds(graph) {
    const ids = new Set();
    for (const list of [graph.nodes, graph.edges, graph.groups, graph.notes]) {
      for (const item of list) ids.add(item.id);
    }
    return ids;
  }

  // Next free id `<prefix><k>`. `reserved` (Set of ids or numbers) keeps ids of deleted nodes
  // unused so results stored under an old node id never attach to a new node.
  function nextId(prefix, graph, reserved) {
    let max = 0;
    const consider = (id) => {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(String(id));
      if (match) max = Math.max(max, Number(match[1]));
    };
    for (const list of [graph.nodes, graph.edges, graph.groups, graph.notes]) {
      for (const item of list) consider(item.id);
    }
    if (reserved) for (const id of reserved) consider(id);
    return `${prefix}${max + 1}`;
  }

  // Several fresh ids at once (paste): each new id is added to `reserved` before the next is drawn.
  function idSource(graph, reserved) {
    const taken = new Set(reserved || []);
    return (prefix) => {
      const id = nextId(prefix, graph, taken);
      taken.add(id);
      return id;
    };
  }

  /* ---------- registry index ---------- */

  // Wraps the payload of GET /api/nodes/registry for fast lookups.
  // options.limitsFor(node, def) -> { [portId]: { max, roles?, required?, subject? } } (optional): what the chosen option
  // of a param allows at the inputs with `limitBy` (the app reads it from the capabilities of the Higgsfield model);
  // graph.js itself does no I/O. Without it, or while the answer is unknown, such an input only has its fixed maximum.
  function indexRegistry(payload, options) {
    const source = payload || {};
    const types = new Map();
    for (const def of source.nodeTypes || []) types.set(def.type, def);
    return {
      limitsFor: options && typeof options.limitsFor === 'function' ? options.limitsFor : null,
      version: source.version || 1,
      types,
      list: Array.from(types.values()),
      portTypes: source.portTypes || {},
      compat: source.compat || {},
      listSuffix: source.listSuffix || LIST_SUFFIX,
      categories: source.categories || []
    };
  }

  function paramDefaults(def) {
    const out = {};
    for (const param of def?.params || []) {
      if (param.default !== undefined) out[param.id] = clone(param.default);
      else if (param.kind === 'boolean') out[param.id] = false;
      else if (param.kind === 'number' || param.kind === 'integer' || param.kind === 'slider') out[param.id] = param.optional ? null : 0;
      else if (param.kind === 'tags' || param.kind === 'assets') out[param.id] = [];
      else if (param.kind === 'asset') out[param.id] = null;
      else out[param.id] = '';
    }
    return out;
  }

  // Params with defaults filled in (what the server computes before running a node).
  function effectiveParams(def, node) {
    return { ...paramDefaults(def), ...(isPlainObject(node.params) ? node.params : {}) };
  }

  // Ports of a node, honouring registry portVariants (a param switches port types).
  function portsFor(reg, node) {
    const def = reg.types.get(node.type);
    if (!def) return { inputs: [], outputs: [] };
    let inputs = def.inputs || [];
    let outputs = def.outputs || [];
    const variants = def.portVariants;
    if (variants && variants.values) {
      const params = effectiveParams(def, node);
      const variant = variants.values[String(params[variants.param])];
      if (variant) {
        if (variant.inputs) inputs = variant.inputs;
        if (variant.outputs) outputs = variant.outputs;
      }
    }
    if (reg.limitsFor && inputs.some((port) => port.limitBy)) {
      let limits = {};
      try {
        limits = reg.limitsFor(node, def) || {};
      } catch (_) {
        limits = {};
      }
      inputs = inputs.map((port) => (port.limitBy ? withLimit(port, limits[port.id]) : port));
    }
    return { inputs, outputs };
  }

  // The same rule as portsFor of lib/nodes/registry.js: an input with `limitBy` carries `limit`. Known: { known: true,
  // max, roles, required, subject } and `max` is the smaller of that and the fixed maximum of the port; unknown:
  // { known: false } and the fixed maximum stays the ceiling (it is not shown as the limit of the model). The app adds
  // `error: true` when reading the model failed (limitsFor answers { error: true }): the limit is unknown for good then.
  function withLimit(port, limit) {
    if (!limit || !Number.isFinite(limit.max)) return { ...port, limit: limit && limit.error === true ? { known: false, error: true } : { known: false } };
    const max = Number.isFinite(port.max) ? Math.min(port.max, limit.max) : limit.max;
    return { ...port, max, limit: { known: true, max, roles: Array.isArray(limit.roles) ? limit.roles : [], required: limit.required === true, subject: String(limit.subject || '') } };
  }

  // The number to show as the maximum of an input ("n/max"): null when there is none or it is not known (an input whose
  // limit depends on a model that has not been read yet shows the count only).
  function portMax(port) {
    if (!port || !port.multiple) return null;
    if (port.limit && !port.limit.known) return null;
    return Number.isFinite(port.max) ? port.max : null;
  }

  function findPort(reg, node, direction, portId) {
    const ports = portsFor(reg, node);
    return (direction === 'out' ? ports.outputs : ports.inputs).find((port) => port.id === portId) || null;
  }

  /* ---------- port types ---------- */

  function parseType(type) {
    if (typeof type !== 'string') return null;
    const list = type.endsWith(LIST_SUFFIX);
    const base = list ? type.slice(0, -LIST_SUFFIX.length) : type;
    return base ? { base, list } : null;
  }

  // SPEC §6.2: list-ness never blocks a connection, only the base types must be compatible.
  function canConnectTypes(reg, fromType, toType) {
    const from = parseType(fromType);
    const to = parseType(toType);
    if (!from || !to) return false;
    const row = reg.compat[from.base];
    return Boolean(row && row[to.base]);
  }

  /* ---------- queries ---------- */

  function getNode(graph, id) {
    return graph.nodes.find((node) => node.id === id) || null;
  }

  function edgesOf(graph, nodeId) {
    return graph.edges.filter((edge) => edge.from.node === nodeId || edge.to.node === nodeId);
  }

  function incomingEdges(graph, nodeId, portId) {
    return graph.edges.filter((edge) => edge.to.node === nodeId && (portId === undefined || edge.to.port === portId));
  }

  function outgoingEdges(graph, nodeId, portId) {
    return graph.edges.filter((edge) => edge.from.node === nodeId && (portId === undefined || edge.from.port === portId));
  }

  // Map of nodeId -> Set of nodeIds reachable by following edges forward ('down') or backward ('up').
  function reach(graph, startIds, direction) {
    const adjacency = new Map();
    for (const edge of graph.edges) {
      const [a, b] = direction === 'down' ? [edge.from.node, edge.to.node] : [edge.to.node, edge.from.node];
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a).push(b);
    }
    const seen = new Set();
    const queue = [...startIds];
    while (queue.length) {
      const id = queue.pop();
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  // Nodes downstream of `ids` (they become stale when `ids` change).
  function descendants(graph, ids) {
    return reach(graph, Array.isArray(ids) ? ids : Array.from(ids), 'down');
  }

  function ancestors(graph, ids) {
    return reach(graph, Array.isArray(ids) ? ids : Array.from(ids), 'up');
  }

  // Would an edge fromNode -> toNode close a cycle? True if toNode already reaches fromNode.
  function wouldCreateCycle(graph, fromNode, toNode) {
    if (fromNode === toNode) return true;
    return descendants(graph, [toNode]).has(fromNode);
  }

  /* ---------- connections ---------- */

  // Returns null when the edge is allowed, otherwise { code } with one of:
  // unknown_node, same_node, no_output, no_input, incompatible, duplicate, cycle, too_many.
  function checkConnection(reg, graph, from, to) {
    const fromNode = getNode(graph, from?.node);
    const toNode = getNode(graph, to?.node);
    if (!fromNode || !toNode) return { code: 'unknown_node' };
    if (fromNode.id === toNode.id) return { code: 'same_node' };
    const fromPort = findPort(reg, fromNode, 'out', from.port);
    if (!fromPort || fromPort.hidden) return { code: 'no_output' };
    const toPort = findPort(reg, toNode, 'in', to.port);
    if (!toPort || toPort.hidden) return { code: 'no_input' };
    if (!canConnectTypes(reg, fromPort.type, toPort.type)) return { code: 'incompatible' };
    if (graph.edges.some((edge) => edge.from.node === from.node && edge.from.port === from.port && edge.to.node === to.node && edge.to.port === to.port)) {
      return { code: 'duplicate' };
    }
    if (wouldCreateCycle(graph, fromNode.id, toNode.id)) return { code: 'cycle' };
    if (toPort.multiple && Number.isFinite(toPort.max)) {
      const count = incomingEdges(graph, toNode.id, toPort.id).length;
      if (count >= toPort.max) return { code: 'too_many', data: limitData(toPort, count) };
    }
    return null;
  }

  // Values for the text of a refused connection: the input, its limit and, when the limit comes from a model, the model.
  function limitData(port, count) {
    const data = { port: port.id, max: port.max, count };
    if (port.limit && port.limit.known) data.model = port.limit.subject || '';
    return data;
  }

  // Inputs whose connections exceed the limit of the chosen model: [{ port, count, max, model }]. Connections are never
  // removed for this (a model change must not lose work); the node is invalid for the run instead (server side).
  function overLimits(reg, graph, nodeId) {
    const node = getNode(graph, nodeId);
    if (!node) return [];
    const found = [];
    for (const port of portsFor(reg, node).inputs) {
      if (!port.multiple || !port.limit || !port.limit.known) continue;
      const count = incomingEdges(graph, nodeId, port.id).length;
      if (count > port.limit.max) found.push({ port: port.id, count, max: port.limit.max, model: port.limit.subject || '' });
    }
    return found;
  }

  // How many connections each capability ('references', 'audio') of a node has at the moment: { [capability]: count }.
  // The model list uses it to mark the models that do not fit.
  function capabilityUsage(reg, graph, nodeId) {
    const node = getNode(graph, nodeId);
    const usage = {};
    if (!node) return usage;
    for (const port of portsFor(reg, node).inputs) {
      if (port.limitBy) usage[port.limitBy.capability] = incomingEdges(graph, nodeId, port.id).length;
    }
    return usage;
  }

  // Adds an edge. A single-input port replaces its previous edge (reported in `removed`).
  function connect(reg, graph, from, to, options = {}) {
    const error = checkConnection(reg, graph, from, to);
    if (error) return { graph, error };
    const toNode = getNode(graph, to.node);
    const toPort = findPort(reg, toNode, 'in', to.port);
    const removed = toPort.multiple ? [] : incomingEdges(graph, to.node, to.port).map((edge) => edge.id);
    const remaining = graph.edges.filter((edge) => !removed.includes(edge.id));
    const id = options.id || nextId('e', { ...graph, edges: remaining }, options.reserved);
    const edge = { id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
    return { graph: { ...graph, edges: [...remaining, edge] }, edge, removed };
  }

  function disconnect(graph, edgeId) {
    if (!graph.edges.some((edge) => edge.id === edgeId)) return graph;
    return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
  }

  function disconnectNode(graph, nodeId) {
    const edges = graph.edges.filter((edge) => edge.from.node !== nodeId && edge.to.node !== nodeId);
    return edges.length === graph.edges.length ? graph : { ...graph, edges };
  }

  // Removes edges whose ports no longer exist or became incompatible (after a portVariants param change) and a second
  // edge into a single input. Edges beyond the maximum of a multi-input port stay: that maximum can come from a model
  // (`limit`), and a change of the model must never delete connections (the node is invalid instead, see overLimits).
  function pruneEdges(reg, graph, nodeIds) {
    const scope = nodeIds ? new Set(nodeIds) : null;
    const kept = [];
    const counts = new Map();
    let changed = false;
    for (const edge of graph.edges) {
      if (scope && !scope.has(edge.from.node) && !scope.has(edge.to.node)) {
        kept.push(edge);
        continue;
      }
      const fromNode = getNode(graph, edge.from.node);
      const toNode = getNode(graph, edge.to.node);
      if (!fromNode || !toNode) {
        changed = true;
        continue;
      }
      // Edges of unknown node types are kept (the node renders as "unknown").
      if (!reg.types.has(fromNode.type) || !reg.types.has(toNode.type)) {
        kept.push(edge);
        continue;
      }
      const fromPort = findPort(reg, fromNode, 'out', edge.from.port);
      const toPort = findPort(reg, toNode, 'in', edge.to.port);
      let ok = Boolean(fromPort && toPort && !fromPort.hidden && canConnectTypes(reg, fromPort.type, toPort.type));
      if (ok && !toPort.multiple) {
        const key = `${toNode.id}.${toPort.id}`;
        if (counts.get(key)) ok = false;
        else counts.set(key, 1);
      }
      if (ok) kept.push(edge);
      else changed = true;
    }
    return changed ? { ...graph, edges: kept } : graph;
  }

  /* ---------- nodes ---------- */

  function addNode(reg, graph, type, options = {}) {
    const def = reg.types.get(type);
    const id = options.id || nextId('n', graph, options.reserved);
    const params = { ...paramDefaults(def), ...(isPlainObject(options.params) ? clone(options.params) : {}) };
    const node = { id, type, typeVersion: def?.version || 1, x: finiteOr(options.x, 0), y: finiteOr(options.y, 0), params };
    if (options.title) node.title = String(options.title).slice(0, 120);
    return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
  }

  function removeNodes(graph, ids) {
    const drop = new Set(ids);
    if (!graph.nodes.some((node) => drop.has(node.id))) return graph;
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => !drop.has(node.id)),
      edges: graph.edges.filter((edge) => !drop.has(edge.from.node) && !drop.has(edge.to.node))
    };
  }

  function replaceNode(graph, id, patch) {
    let found = false;
    const nodes = graph.nodes.map((node) => {
      if (node.id !== id) return node;
      found = true;
      return patch(node);
    });
    return found ? { ...graph, nodes } : graph;
  }

  function moveItems(graph, selection, dx, dy) {
    const ids = {
      nodes: new Set(selection.nodes || []),
      notes: new Set(selection.notes || []),
      groups: new Set(selection.groups || [])
    };
    const move = (item) => ({ ...item, x: item.x + dx, y: item.y + dy });
    return {
      ...graph,
      nodes: graph.nodes.map((node) => (ids.nodes.has(node.id) ? move(node) : node)),
      notes: graph.notes.map((note) => (ids.notes.has(note.id) ? move(note) : note)),
      groups: graph.groups.map((group) => (ids.groups.has(group.id) ? move(group) : group))
    };
  }

  // Sets absolute positions: positions = { [id]: { x, y } } for nodes, notes and groups.
  function setPositions(graph, positions) {
    const place = (item) => (positions[item.id] ? { ...item, x: positions[item.id].x, y: positions[item.id].y } : item);
    return { ...graph, nodes: graph.nodes.map(place), notes: graph.notes.map(place), groups: graph.groups.map(place) };
  }

  function setParams(graph, nodeId, patch) {
    return replaceNode(graph, nodeId, (node) => ({ ...node, params: { ...node.params, ...patch } }));
  }

  function setTitle(graph, nodeId, title) {
    return replaceNode(graph, nodeId, (node) => {
      const next = { ...node };
      const text = String(title || '').trim().slice(0, 120);
      if (text) next.title = text;
      else delete next.title;
      return next;
    });
  }

  /* ---------- notes and groups ---------- */

  function addNote(graph, options = {}) {
    const id = options.id || nextId('t', graph, options.reserved);
    const note = {
      id,
      x: finiteOr(options.x, 0),
      y: finiteOr(options.y, 0),
      w: finiteOr(options.w, 240),
      h: finiteOr(options.h, 140),
      text: typeof options.text === 'string' ? options.text : ''
    };
    return { graph: { ...graph, notes: [...graph.notes, note] }, note };
  }

  function updateNote(graph, id, patch) {
    return { ...graph, notes: graph.notes.map((note) => (note.id === id ? { ...note, ...patch } : note)) };
  }

  function removeNotes(graph, ids) {
    const drop = new Set(ids);
    return graph.notes.some((note) => drop.has(note.id)) ? { ...graph, notes: graph.notes.filter((note) => !drop.has(note.id)) } : graph;
  }

  function addGroup(graph, options = {}) {
    const id = options.id || nextId('g', graph, options.reserved);
    const group = {
      id,
      title: typeof options.title === 'string' ? options.title : '',
      x: finiteOr(options.x, 0),
      y: finiteOr(options.y, 0),
      w: finiteOr(options.w, 400),
      h: finiteOr(options.h, 240),
      color: GROUP_COLORS.includes(options.color) ? options.color : 'amber'
    };
    return { graph: { ...graph, groups: [...graph.groups, group] }, group };
  }

  function updateGroup(graph, id, patch) {
    return { ...graph, groups: graph.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)) };
  }

  function removeGroups(graph, ids) {
    const drop = new Set(ids);
    return graph.groups.some((group) => drop.has(group.id)) ? { ...graph, groups: graph.groups.filter((group) => !drop.has(group.id)) } : graph;
  }

  /* ---------- geometry ---------- */

  function sizeOf(sizes, id) {
    const size = sizes && (typeof sizes.get === 'function' ? sizes.get(id) : sizes[id]);
    return { w: size?.w > 0 ? size.w : DEFAULT_NODE_SIZE.w, h: size?.h > 0 ? size.h : DEFAULT_NODE_SIZE.h };
  }

  function nodeRect(node, sizes) {
    const size = sizeOf(sizes, node.id);
    return { x: node.x, y: node.y, w: size.w, h: size.h };
  }

  function unionRect(rects) {
    if (!rects.length) return null;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const rect of rects) {
      x1 = Math.min(x1, rect.x);
      y1 = Math.min(y1, rect.y);
      x2 = Math.max(x2, rect.x + rect.w);
      y2 = Math.max(y2, rect.y + rect.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function rectContainsPoint(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  // Bounds of every item (or of a selection { nodes, notes, groups }) in world coordinates.
  function boundsOf(graph, sizes, selection) {
    const has = (ids, id) => (ids instanceof Set ? ids.has(id) : Array.isArray(ids) && ids.includes(id));
    const pick = (list, ids) => (selection ? list.filter((item) => has(ids, item.id)) : list);
    const rects = [
      ...pick(graph.nodes, selection?.nodes).map((node) => nodeRect(node, sizes)),
      ...pick(graph.notes, selection?.notes).map((note) => ({ x: note.x, y: note.y, w: note.w, h: note.h })),
      ...pick(graph.groups, selection?.groups).map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h }))
    ];
    return unionRect(rects);
  }

  // Items touched by a world rectangle (marquee).
  function itemsInRect(graph, sizes, rect) {
    return {
      nodes: graph.nodes.filter((node) => rectsIntersect(nodeRect(node, sizes), rect)).map((node) => node.id),
      notes: graph.notes.filter((note) => rectsIntersect({ x: note.x, y: note.y, w: note.w, h: note.h }, rect)).map((note) => note.id),
      groups: graph.groups.filter((group) => {
        // Groups are selected by their title bar band only, so a marquee inside a big group
        // does not always select the frame.
        return rectsIntersect({ x: group.x, y: group.y, w: group.w, h: 36 }, rect);
      }).map((group) => group.id)
    };
  }

  // Nodes and notes whose centre lies inside a group frame (they move with the frame).
  function membersOfGroup(graph, sizes, group) {
    const inside = (rect) => rectContainsPoint(group, rect.x + rect.w / 2, rect.y + rect.h / 2);
    return {
      nodes: graph.nodes.filter((node) => inside(nodeRect(node, sizes))).map((node) => node.id),
      notes: graph.notes.filter((note) => inside({ x: note.x, y: note.y, w: note.w, h: note.h })).map((note) => note.id)
    };
  }

  function snap(value, grid = 8) {
    return Math.round(value / grid) * grid;
  }

  // Frames the selected nodes (and notes) in a new group with room for the title bar.
  function groupSelection(graph, sizes, selection, options = {}) {
    const rect = boundsOf(graph, sizes, { nodes: selection.nodes, notes: selection.notes });
    if (!rect) return { graph, group: null };
    const pad = 32;
    const top = 52;
    return addGroup(graph, {
      ...options,
      x: rect.x - pad,
      y: rect.y - top,
      w: rect.w + pad * 2,
      h: rect.h + top + pad
    });
  }

  /* ---------- viewport ---------- */

  function clampZoom(zoom) {
    return clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  }

  // Zoom keeping the world point under (cx, cy) (container coordinates) fixed.
  function zoomAt(viewport, factorOrZoom, cx, cy, absolute) {
    const zoom = clampZoom(absolute ? factorOrZoom : viewport.zoom * factorOrZoom);
    const wx = (cx - viewport.x) / viewport.zoom;
    const wy = (cy - viewport.y) / viewport.zoom;
    return { zoom, x: cx - wx * zoom, y: cy - wy * zoom };
  }

  // Viewport that shows `rect` (world) inside a container of the given size.
  function fitViewport(rect, width, height, options = {}) {
    const padding = options.padding ?? 64;
    const maxZoom = options.maxZoom ?? 1;
    if (!rect || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, zoom: 1 };
    const zoom = clampZoom(Math.min(maxZoom, (width - padding * 2) / Math.max(rect.w, 1), (height - padding * 2) / Math.max(rect.h, 1)));
    return {
      zoom,
      x: width / 2 - (rect.x + rect.w / 2) * zoom,
      y: height / 2 - (rect.y + rect.h / 2) * zoom
    };
  }

  function screenToWorld(viewport, x, y) {
    return { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom };
  }

  function worldToScreen(viewport, x, y) {
    return { x: x * viewport.zoom + viewport.x, y: y * viewport.zoom + viewport.y };
  }

  /* ---------- clipboard, duplicate ---------- */

  const CLIPBOARD_FORMAT = 'ocd.clipboard';

  // Serialises a selection ({ nodes, notes, groups } id arrays). Only edges between selected nodes travel.
  function copySelection(graph, selection, meta = {}) {
    const nodeIds = new Set(selection.nodes || []);
    const noteIds = new Set(selection.notes || []);
    const groupIds = new Set(selection.groups || []);
    const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
    const notes = graph.notes.filter((note) => noteIds.has(note.id));
    const groups = graph.groups.filter((group) => groupIds.has(group.id));
    if (!nodes.length && !notes.length && !groups.length) return null;
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.from.node) && nodeIds.has(edge.to.node));
    const rects = [
      ...nodes.map((node) => ({ x: node.x, y: node.y, w: 1, h: 1 })),
      ...notes.map((note) => ({ x: note.x, y: note.y, w: 1, h: 1 })),
      ...groups.map((group) => ({ x: group.x, y: group.y, w: 1, h: 1 }))
    ];
    const box = unionRect(rects);
    return clone({
      format: CLIPBOARD_FORMAT,
      version: 1,
      workflowId: meta.workflowId || null,
      sessionId: meta.sessionId || null,
      origin: { x: box.x, y: box.y },
      nodes,
      edges,
      notes,
      groups
    });
  }

  function isClipboard(value) {
    return isPlainObject(value) && value.format === CLIPBOARD_FORMAT && Array.isArray(value.nodes);
  }

  // Pastes a clipboard payload with fresh ids; its top-left corner lands on `at` ({x,y}).
  // Returns { graph, ids: { nodes, notes, groups }, idMap }.
  function paste(graph, clip, at, options = {}) {
    if (!isClipboard(clip)) return { graph, ids: { nodes: [], notes: [], groups: [] }, idMap: {} };
    const draw = idSource(graph, options.reserved);
    const dx = (at?.x ?? clip.origin?.x ?? 0) - (clip.origin?.x ?? 0);
    const dy = (at?.y ?? clip.origin?.y ?? 0) - (clip.origin?.y ?? 0);
    const idMap = {};
    const nodes = [];
    for (const source of (clip.nodes || []).slice(0, MAX_NODES)) {
      const id = draw('n');
      idMap[source.id] = id;
      nodes.push({ ...clone(source), id, x: finiteOr(source.x, 0) + dx, y: finiteOr(source.y, 0) + dy });
    }
    const edges = [];
    for (const source of clip.edges || []) {
      if (!idMap[source.from?.node] || !idMap[source.to?.node]) continue;
      edges.push({
        id: draw('e'),
        from: { node: idMap[source.from.node], port: source.from.port },
        to: { node: idMap[source.to.node], port: source.to.port }
      });
    }
    const notes = (clip.notes || []).map((source) => ({ ...clone(source), id: draw('t'), x: finiteOr(source.x, 0) + dx, y: finiteOr(source.y, 0) + dy }));
    const groups = (clip.groups || []).map((source) => ({ ...clone(source), id: draw('g'), x: finiteOr(source.x, 0) + dx, y: finiteOr(source.y, 0) + dy }));
    return {
      graph: {
        ...graph,
        nodes: [...graph.nodes, ...nodes],
        edges: [...graph.edges, ...edges],
        notes: [...graph.notes, ...notes],
        groups: [...graph.groups, ...groups]
      },
      ids: { nodes: nodes.map((n) => n.id), notes: notes.map((n) => n.id), groups: groups.map((g) => g.id), edges: edges.map((e) => e.id) },
      idMap
    };
  }

  // Duplicate = copy + paste next to the originals.
  function duplicate(graph, selection, offset = 32, options = {}) {
    const clip = copySelection(graph, selection);
    if (!clip) return { graph, ids: { nodes: [], notes: [], groups: [] }, idMap: {} };
    return paste(graph, clip, { x: clip.origin.x + offset, y: clip.origin.y + offset }, options);
  }

  /* ---------- insert a sub graph (templates, "insert with inputs", the assistant) ---------- */

  // Top-left corner for a sub graph of `size` that does not touch what is there: right of the existing content, or
  // below it when that content is already very wide; on an empty canvas centred on `center` (a world point).
  function freeSpotFor(graph, size, options = {}) {
    const taken = boundsOf(graph, options.sizes);
    if (!taken) {
      const center = options.center || { x: 0, y: 0 };
      return { x: snap(center.x - size.w / 2, 8), y: snap(center.y - size.h / 2, 8) };
    }
    if (taken.w <= SUBGRAPH_WIDE) return { x: snap(taken.x + taken.w + SUBGRAPH_GAP, 8), y: snap(taken.y, 8) };
    return { x: snap(taken.x, 8), y: snap(taken.y + taken.h + SUBGRAPH_GAP, 8) };
  }

  // Inserts a sub graph ({ nodes, edges, notes, groups }, the shape of a template graph) into `graph` with fresh ids:
  // nodes, edges between them, notes and groups. The caller makes it one undo step; nothing is run.
  //   options.at       world point where the top-left corner of the inserted items lands
  //   options.center   without `at`: centre of the visible area, used when the canvas is empty (otherwise the sub
  //                    graph goes to the right of, or below, the existing content)
  //   options.avoid    with `at`: move down while the items would overlap existing ones (default off)
  //   options.reg      registry index: unknown node types are refused, params get their defaults
  //   options.sizes    measured card sizes of the existing nodes; options.reserved ids not to be reused
  // Returns { graph, ids: { nodes, notes, groups, edges }, idMap (old node id -> new), at, bounds } or
  // { graph, error: { reason: 'empty' | 'too_many' | 'unknown_type', type? } }.
  function insertSubgraph(graph, sub, options = {}) {
    const source = isPlainObject(sub) ? sub : {};
    const nodes = Array.isArray(source.nodes) ? source.nodes : [];
    const notes = Array.isArray(source.notes) ? source.notes : [];
    const groups = Array.isArray(source.groups) ? source.groups : [];
    if (!nodes.length && !notes.length && !groups.length) return { graph, error: { reason: 'empty' } };
    if (graph.nodes.length + nodes.length > MAX_NODES) return { graph, error: { reason: 'too_many' } };
    if (options.reg) {
      const unknown = nodes.find((node) => !options.reg.types.has(node.type));
      if (unknown) return { graph, error: { reason: 'unknown_type', type: unknown.type } };
    }
    const prepared = nodes.map((node) => {
      const def = options.reg ? options.reg.types.get(node.type) : null;
      const params = { ...(def ? paramDefaults(def) : {}), ...(isPlainObject(node.params) ? clone(node.params) : {}) };
      return { ...clone(node), typeVersion: node.typeVersion || def?.version || 1, params };
    });
    const clip = copySelection(
      { nodes: prepared, edges: Array.isArray(source.edges) ? source.edges : [], notes, groups },
      { nodes: prepared.map((node) => node.id), notes: notes.map((note) => note.id), groups: groups.map((group) => group.id) }
    );
    const rects = [
      ...prepared.map((node) => ({ x: node.x, y: node.y, ...DEFAULT_NODE_SIZE })),
      ...notes.map((note) => ({ x: note.x, y: note.y, w: finiteOr(note.w, 240), h: finiteOr(note.h, 140) })),
      ...groups.map((group) => ({ x: group.x, y: group.y, w: finiteOr(group.w, 400), h: finiteOr(group.h, 240) }))
    ].map((rect) => ({ ...rect, x: finiteOr(rect.x, 0), y: finiteOr(rect.y, 0) }));
    const box = unionRect(rects);
    let at = options.at && Number.isFinite(options.at.x) && Number.isFinite(options.at.y) ? { x: options.at.x, y: options.at.y } : null;
    if (!at) at = freeSpotFor(graph, box, options);
    else if (options.avoid) {
      const others = [
        ...graph.nodes.map((node) => nodeRect(node, options.sizes)),
        ...graph.notes.map((note) => ({ x: note.x, y: note.y, w: note.w, h: note.h })),
        ...graph.groups.map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h }))
      ];
      for (let guard = 0; guard < 60; guard += 1) {
        const rect = { x: at.x + box.x - clip.origin.x, y: at.y + box.y - clip.origin.y, w: box.w, h: box.h };
        if (!others.some((other) => rectsIntersect(rect, other))) break;
        at = { x: at.x, y: at.y + 48 };
      }
    }
    const result = paste(graph, clip, at, { reserved: options.reserved });
    return {
      ...result,
      at,
      bounds: { x: at.x + box.x - clip.origin.x, y: at.y + box.y - clip.origin.y, w: box.w, h: box.h }
    };
  }

  // Deletes a whole selection { nodes, notes, groups }.
  function removeSelection(graph, selection) {
    let next = removeNodes(graph, selection.nodes || []);
    next = removeNotes(next, selection.notes || []);
    next = removeGroups(next, selection.groups || []);
    return next;
  }

  /* ---------- loading and validation ---------- */

  // Makes a graph coming from the server / an import safe for the editor: arrays exist, dangling
  // and duplicate edges are dropped, notes and groups get ids that do not collide with node ids.
  function normalizeLoaded(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const nodes = [];
    const nodeIds = new Set();
    for (const node of Array.isArray(source.nodes) ? source.nodes : []) {
      if (!isPlainObject(node) || typeof node.id !== 'string' || !ID_PATTERN.test(node.id) || nodeIds.has(node.id)) continue;
      nodeIds.add(node.id);
      nodes.push({
        ...node,
        typeVersion: Number.isInteger(node.typeVersion) && node.typeVersion > 0 ? node.typeVersion : 1,
        x: finiteOr(node.x, 0),
        y: finiteOr(node.y, 0),
        params: isPlainObject(node.params) ? node.params : {}
      });
    }
    const edges = [];
    const edgeKeys = new Set();
    const edgeIds = new Set();
    for (const edge of Array.isArray(source.edges) ? source.edges : []) {
      if (!isPlainObject(edge) || !isPlainObject(edge.from) || !isPlainObject(edge.to)) continue;
      if (!nodeIds.has(edge.from.node) || !nodeIds.has(edge.to.node) || edge.from.node === edge.to.node) continue;
      const key = `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      let id = typeof edge.id === 'string' && ID_PATTERN.test(edge.id) && !edgeIds.has(edge.id) ? edge.id : null;
      if (!id) {
        let k = edges.length + 1;
        while (edgeIds.has(`e${k}`)) k += 1;
        id = `e${k}`;
      }
      edgeIds.add(id);
      edges.push({ ...edge, id, from: { node: edge.from.node, port: edge.from.port }, to: { node: edge.to.node, port: edge.to.port } });
    }
    const used = new Set([...nodeIds]);
    const fixIds = (list, prefix) =>
      (Array.isArray(list) ? list : []).filter(isPlainObject).map((item) => {
        let id = typeof item.id === 'string' && ID_PATTERN.test(item.id) && !used.has(item.id) ? item.id : null;
        if (!id) {
          let k = 1;
          while (used.has(`${prefix}${k}`)) k += 1;
          id = `${prefix}${k}`;
        }
        used.add(id);
        return { ...item, id };
      });
    const groups = fixIds(source.groups, 'g').map((group) => ({
      ...group,
      title: typeof group.title === 'string' ? group.title : '',
      x: finiteOr(group.x, 0),
      y: finiteOr(group.y, 0),
      w: Math.max(80, finiteOr(group.w, 400)),
      h: Math.max(60, finiteOr(group.h, 240)),
      color: GROUP_COLORS.includes(group.color) ? group.color : 'amber'
    }));
    const notes = fixIds(source.notes, 't').map((note) => ({
      ...note,
      text: typeof note.text === 'string' ? note.text : '',
      x: finiteOr(note.x, 0),
      y: finiteOr(note.y, 0),
      w: Math.max(80, finiteOr(note.w, 240)),
      h: Math.max(60, finiteOr(note.h, 140))
    }));
    const vp = isPlainObject(source.viewport) ? source.viewport : {};
    return {
      nodes,
      edges,
      groups,
      notes,
      viewport: { x: finiteOr(vp.x, 0), y: finiteOr(vp.y, 0), zoom: clampZoom(finiteOr(vp.zoom, 1)) }
    };
  }

  // Structural problems of a graph against the registry (used by tests and before export).
  function validate(reg, graph) {
    const issues = [];
    const ids = new Set();
    for (const node of graph.nodes) {
      if (ids.has(node.id)) issues.push({ code: 'duplicate_id', id: node.id });
      ids.add(node.id);
      if (!reg.types.has(node.type)) issues.push({ code: 'unknown_type', id: node.id });
    }
    for (const edge of graph.edges) {
      const fromNode = getNode(graph, edge.from.node);
      const toNode = getNode(graph, edge.to.node);
      if (!fromNode || !toNode) {
        issues.push({ code: 'dangling', id: edge.id });
        continue;
      }
      if (!reg.types.has(fromNode.type) || !reg.types.has(toNode.type)) continue;
      const fromPort = findPort(reg, fromNode, 'out', edge.from.port);
      const toPort = findPort(reg, toNode, 'in', edge.to.port);
      if (!fromPort || !toPort) issues.push({ code: 'bad_port', id: edge.id });
      else if (!canConnectTypes(reg, fromPort.type, toPort.type)) issues.push({ code: 'incompatible', id: edge.id });
    }
    return issues;
  }

  /* ---------- palette helpers ---------- */

  // Search texts are compared in a normal form: lower case, no accents, every run of non-alphanumerics is one space
  // ("KI-Video" -> "ki video", "fal.ai" -> "fal ai"). Query and searched texts both go through it.
  function normalizeSearch(text) {
    return String(text ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  // Words that only glue a phrase together ("bild zu video"): they do not have to match on their own as long as
  // another word of the query is left. The whole phrase still earns its bonus.
  const SEARCH_STOP_WORDS = new Set(['zu', 'zum', 'zur', 'to', 'a', 'al', 'de', 'del', 'en', 'the', 'of', 'for', 'in', 'im', 'von', 'aus', 'und', 'and', 'y', 'o', 'or', 'oder']);
  // Scattered letters ("sedance" for "seedance") only help with a real word of this length, only from a word start,
  // only against labels, and only while fewer than MIN_REAL_MATCHES entries match for real.
  const SUBSEQUENCE_MIN = 4;
  const SUBSEQUENCE_SCORE = 20;
  const MIN_REAL_MATCHES = 3;
  const WEIGHT_LABEL = Object.freeze({ start: 100, inner: 60 });
  const WEIGHT_TERM = Object.freeze({ start: 90, inner: 50 });
  const WEIGHT_EXTRA = Object.freeze({ start: 40, inner: 20 });
  const PHRASE_LABEL_EXACT = 100;
  const PHRASE_LABEL_PART = 60;
  const PHRASE_TERM_EXACT = 80;
  const PHRASE_TERM_PART = 45;
  const PHRASE_TERM_ORDER_STEP = 2; // keywords are listed by importance: each position costs a little
  const PHRASE_TERM_ORDER_MAX = 10;
  const SINGLE_TERM_BONUS = 9; // stays below the gap between a synonym hit (90) and a name hit (100)
  const SINGLE_LABEL_EXACT = 20; // one word that IS the name ("prompt" for "Prompt"): ahead of every name that merely starts with it
  const SINGLE_TERM_STEP = 0.5;

  function parseSearchQuery(query) {
    const all = normalizeSearch(query).split(' ').filter(Boolean);
    const content = all.filter((word) => !SEARCH_STOP_WORDS.has(word));
    return { phrase: all.join(' '), count: all.length, tokens: content.length ? content : all };
  }

  // 0 = no match, weights.start = the token starts a word of the text, weights.inner = it sits inside a word.
  function matchToken(token, text, weights) {
    let at = text.indexOf(token);
    if (at < 0) return 0;
    while (at >= 0) {
      if (at === 0 || text[at - 1] === ' ') return weights.start;
      at = text.indexOf(token, at + 1);
    }
    return weights.inner;
  }

  function matchSubsequence(token, text) {
    if (token.length < SUBSEQUENCE_MIN) return false;
    for (let start = text.indexOf(token[0]); start >= 0; start = text.indexOf(token[0], start + 1)) {
      if (start !== 0 && text[start - 1] !== ' ') continue;
      let position = start + 1;
      let all = true;
      for (let i = 1; i < token.length; i += 1) {
        const found = text.indexOf(token[i], position);
        if (found < 0) {
          all = false;
          break;
        }
        position = found + 1;
      }
      if (all) return true;
    }
    return false;
  }

  // Normalised fuzzy score of one text: 0 = no match. Every whitespace-separated query token must match.
  // Word-start hits score above plain substrings, which score above scattered subsequences.
  function fuzzyScore(query, text) {
    const tokens = normalizeSearch(query).split(' ').filter(Boolean);
    if (!tokens.length) return 1;
    const haystack = normalizeSearch(text);
    if (!haystack) return 0;
    let total = 0;
    for (const token of tokens) {
      let score = matchToken(token, haystack, WEIGHT_LABEL);
      if (!score) score = matchSubsequence(token, haystack) ? SUBSEQUENCE_SCORE : 0;
      if (!score) return 0;
      total += score;
    }
    return total / tokens.length;
  }

  // Searchable parts of a palette entry, normalised once:
  //   labels   the names (translated and English): the strongest hits, and the only place scattered letters may match,
  //   keywords translated and English synonyms, one phrase each (entry.keywords),
  //   extra    everything else (category, type id, description; the plain entry.search of simple entries).
  const searchFieldCache = new WeakMap();

  function searchFields(entry) {
    let fields = searchFieldCache.get(entry);
    if (!fields) {
      fields = {
        labels: (Array.isArray(entry.labels) && entry.labels.length ? entry.labels : [entry.label]).map(normalizeSearch).filter(Boolean),
        terms: (entry.keywords || []).map(normalizeSearch).filter(Boolean),
        extra: normalizeSearch(entry.search)
      };
      searchFieldCache.set(entry, fields);
    }
    return fields;
  }

  function phraseBonus(fields, phrase) {
    let best = 0;
    for (const label of fields.labels) {
      if (label === phrase) best = Math.max(best, PHRASE_LABEL_EXACT);
      else if (matchToken(phrase, label, { start: PHRASE_LABEL_PART, inner: 0 })) best = Math.max(best, PHRASE_LABEL_PART);
    }
    fields.terms.forEach((term, index) => {
      const order = Math.min(index, PHRASE_TERM_ORDER_MAX) * PHRASE_TERM_ORDER_STEP;
      if (term === phrase) best = Math.max(best, PHRASE_TERM_EXACT - order);
      else if (matchToken(phrase, term, { start: PHRASE_TERM_PART, inner: 0 })) best = Math.max(best, PHRASE_TERM_PART - order);
    });
    return best;
  }

  // null = the entry does not match; otherwise { score, real } (real = no scattered-letter hit involved).
  function scoreEntry(entry, query) {
    const fields = searchFields(entry);
    let total = 0;
    let real = true;
    for (const token of query.tokens) {
      let best = 0;
      for (const label of fields.labels) best = Math.max(best, matchToken(token, label, WEIGHT_LABEL));
      if (best < WEIGHT_TERM.start) {
        fields.terms.forEach((term, index) => {
          let hit = matchToken(token, term, WEIGHT_TERM);
          // A single word that IS a synonym: the earlier in the list, the better (never as good as a name).
          if (hit && query.count === 1 && term === token) hit += Math.max(0, SINGLE_TERM_BONUS - index * SINGLE_TERM_STEP);
          best = Math.max(best, hit);
        });
      }
      if (best < WEIGHT_EXTRA.start) best = Math.max(best, matchToken(token, fields.extra, WEIGHT_EXTRA));
      if (!best) {
        if (!fields.labels.some((label) => matchSubsequence(token, label))) return null;
        best = SUBSEQUENCE_SCORE;
        real = false;
      }
      total += best;
    }
    let score = total / query.tokens.length;
    if (real) {
      if (query.count > 1) score += phraseBonus(fields, query.phrase);
      else if (fields.labels.includes(query.phrase)) score += SINGLE_LABEL_EXACT;
    }
    return { score, real };
  }

  // Who makes something new, who changes something, who merely helps (ties in the palette go in this order).
  const ROLE_CREATE = 0;
  const ROLE_EDIT = 1;
  const ROLE_TOOL = 2;
  const TOOL_CATEGORIES = new Set(['input', 'text', 'utility', 'output']);
  const EDIT_CATEGORIES = new Set(['edit-image', 'edit-video', 'edit-audio']);

  function nodeRole(def) {
    if (!def) return ROLE_TOOL;
    if (TOOL_CATEGORIES.has(def.category)) return ROLE_TOOL;
    if (EDIT_CATEGORIES.has(def.category)) return ROLE_EDIT;
    // A media node that needs media of its own output kind (a video in, a video out) edits; one that only needs a
    // prompt or an image for a video generates.
    const made = new Set((def.outputs || []).map((port) => parseType(port.type)?.base).filter((base) => MEDIA_BASES.includes(base)));
    const needed = (def.inputs || []).filter((port) => port.required && !port.hidden).map((port) => parseType(port.type)?.base);
    return needed.some((base) => made.has(base)) ? ROLE_EDIT : ROLE_CREATE;
  }

  // Node types that could take the other end of an edge dragged from a port.
  // dir 'out' = the drag starts on an output of `portType` -> candidates need a compatible input.
  // dir 'in'  = the drag starts on an input -> candidates need a compatible output.
  // Returns [{ type, portId, params? }] with the best matching port per type (params = portVariants
  // value needed for that port). Exact base-type matches rank above `any` matches.
  function compatibleTargets(reg, dir, portType) {
    const source = parseType(portType);
    if (!source) return [];
    const results = [];
    for (const def of reg.list) {
      const candidates = [{ params: null, ports: def }];
      if (def.portVariants && def.portVariants.values) {
        candidates.length = 0;
        for (const [value, ports] of Object.entries(def.portVariants.values)) {
          candidates.push({ params: { [def.portVariants.param]: value }, ports: { inputs: ports.inputs || def.inputs, outputs: ports.outputs || def.outputs } });
        }
      }
      let best = null;
      for (const candidate of candidates) {
        const list = (dir === 'out' ? candidate.ports.inputs : candidate.ports.outputs) || [];
        for (const port of list) {
          if (port.hidden) continue;
          const ok = dir === 'out' ? canConnectTypes(reg, portType, port.type) : canConnectTypes(reg, port.type, portType);
          if (!ok) continue;
          const target = parseType(port.type);
          const exact = target && target.base === source.base;
          const rank = (exact ? 2 : 0) + (port.required ? 1 : 0);
          if (!best || rank > best.rank) best = { rank, type: def.type, portId: port.id, params: candidate.params };
        }
      }
      if (best) results.push({ type: best.type, portId: best.portId, params: best.params, rank: best.rank });
    }
    return results;
  }

  // First port of a node type that accepts the dragged type (used for auto-connect after placement).
  function firstCompatiblePort(reg, node, dir, portType) {
    const ports = portsFor(reg, node);
    const list = dir === 'out' ? ports.inputs : ports.outputs;
    const source = parseType(portType);
    let best = null;
    for (const port of list) {
      if (port.hidden) continue;
      const ok = dir === 'out' ? canConnectTypes(reg, portType, port.type) : canConnectTypes(reg, port.type, portType);
      if (!ok) continue;
      const target = parseType(port.type);
      const rank = (target && source && target.base === source.base ? 2 : 0) + (port.required ? 1 : 0);
      if (!best || rank > best.rank) best = { rank, port };
    }
    return best ? best.port : null;
  }

  // Palette candidates for a dragged connection, best first. Same compatibility as compatibleTargets();
  // dragging from an unconnected TEXT input puts the Prompt node on top (it is the natural source).
  // options.multiple: the drag starts on a multi-input; for a media type the Media list node and the matching
  // single input node (Image / Video / Audio input) go on top, so handing over several references is one click.
  // options.prefer: a node type to put above everything (the `suggest` hint of an input that is asked for).
  // Dragging an image OUTPUT puts the nodes that turn it into a video first: the generators, then the local ones
  // (a zoom over a still image), before the many image editors that also take an image. Dragging a text OUTPUT puts
  // the generators of media (video and image alike) ahead of the helpers that merely take text.
  function quickPickTargets(reg, dir, portType, options = {}) {
    const targets = compatibleTargets(reg, dir, portType);
    const prefer = typeof options.prefer === 'string' ? options.prefer : null;
    const source = parseType(portType);
    const boost = dir === 'in' && source && source.base === 'text' && reg.types.has(PROMPT_TYPE);
    const mediaBoost = Boolean(dir === 'in' && options.multiple === true && source && MEDIA_BASES.includes(source.base));
    const single = mediaBoost ? `input.${source.base}` : null;
    const videoBoost = Boolean(dir === 'out' && source && (source.base === 'image' || source.base === 'text'));
    const fromText = Boolean(source && source.base === 'text');
    return targets
      .map((target) => {
        if (prefer && target.type === prefer) return { ...target, rank: target.rank + PREFER_BOOST };
        if (boost && target.type === PROMPT_TYPE) return { ...target, rank: target.rank + PROMPT_BOOST };
        if (mediaBoost && target.type === MEDIA_LIST_TYPE) return { ...target, rank: target.rank + MEDIA_LIST_BOOST };
        if (mediaBoost && target.type === single) return { ...target, rank: target.rank + MEDIA_SINGLE_BOOST };
        if (videoBoost) {
          const def = reg.types.get(target.type);
          // Only nodes that make the media from the dragged output (and maybe an optional extra): one that also
          // needs a video of its own (overlay, extend, motion transfer) is an editor of videos, not a way to get one.
          const needsVideo = def && (def.inputs || []).some((port) => port.required && parseType(port.type)?.base === 'video');
          const makes = (base) => Boolean(def) && (def.outputs || []).some((port) => parseType(port.type)?.base === base);
          // Optional or required input makes no difference here: a generator that takes the image only as an
          // optional start frame is as good a pick as one that needs it.
          if (def && !needsVideo && makes('video')) {
            const base = Math.min(target.rank, 2);
            // From a text a video is only one of the next steps (the image is the other common one): the generators
            // of both share one rank, so "Generate image" is not pushed below the whole video family.
            if (fromText) return nodeRole(def) === ROLE_CREATE ? { ...target, rank: base + VIDEO_BOOST_TEXT } : target;
            return { ...target, rank: base + (nodeRole(def) === ROLE_CREATE ? VIDEO_BOOST_CREATE : VIDEO_BOOST_LOCAL) };
          }
          if (fromText && def && nodeRole(def) === ROLE_CREATE && makes('image')) return { ...target, rank: Math.min(target.rank, 2) + VIDEO_BOOST_TEXT };
        }
        return target;
      })
      .sort((a, b) => b.rank - a.rank);
  }

  // Filters and orders palette entries (pure part of the command palette).
  // entries: [{ type, category, label, model? }] plus the searchable parts (see searchFields) or a plain `search` text.
  // options: query, category, filter ({ dir, type, multiple? } from a dragged connection), limit (nodes, default 150),
  // modelLimit (Higgsfield model entries, default 30).
  // Models need a search text (or their own category chip): without one they never crowd the nodes out. They have
  // their own limit, so many models cannot push a node out of the list either; the number that did not fit is
  // returned as `hiddenModels` on the array. Returns the entries (with `compat` = the matching port target or null),
  // best match first.
  function rankPaletteEntries(reg, entries, options = {}) {
    const { query = '', category = 'all', filter = null, limit = 150, modelLimit = 30 } = options;
    const parsed = parseSearchQuery(query);
    const hasQuery = parsed.tokens.length > 0;
    let list = entries;
    let compat = null;
    if (filter) {
      compat = new Map(quickPickTargets(reg, filter.dir, filter.type, { multiple: filter.multiple === true, prefer: filter.prefer }).map((item) => [item.type, item]));
      list = list.filter((entry) => compat.has(entry.type));
    }
    if (category !== 'all') list = list.filter((entry) => entry.category === category);
    if (!hasQuery && (category === 'all' || filter)) list = list.filter((entry) => !entry.model);
    const categoryOrder = new Map((reg.categories || []).map((id, index) => [id, index]));
    const defOf = (entry) => entry.def || reg.types.get(entry.type);
    let scored = [];
    for (const entry of list) {
      const hit = hasQuery ? scoreEntry(entry, parsed) : { score: 1, real: true };
      if (!hit) continue;
      const def = defOf(entry);
      scored.push({
        entry,
        score: hit.score,
        real: hit.real,
        rank: compat ? compat.get(entry.type).rank : 0,
        role: nodeRole(def),
        usable: def && def.available === true ? 0 : 1,
        model: entry.model ? 1 : 0
      });
    }
    // Enough genuine hits: the scattered-letter ones were only a fallback for typos.
    if (hasQuery && scored.filter((item) => item.real).length >= MIN_REAL_MATCHES) scored = scored.filter((item) => item.real);
    scored.sort((a, b) => {
      if (hasQuery) {
        return b.score - a.score || b.rank - a.rank || a.model - b.model || a.usable - b.usable || a.role - b.role || a.entry.label.localeCompare(b.entry.label);
      }
      if (compat && b.rank !== a.rank) return b.rank - a.rank;
      const ca = categoryOrder.get(a.entry.category) ?? 99;
      const cb = categoryOrder.get(b.entry.category) ?? 99;
      // The Prompt node is pinned to the top of its category ("Inputs"); in a block the usable nodes come first,
      // then generators before editors before helpers, models last, the rest alphabetical.
      const pa = a.entry.type === PROMPT_TYPE ? 0 : 1;
      const pb = b.entry.type === PROMPT_TYPE ? 0 : 1;
      return ca - cb || pa - pb || a.usable - b.usable || a.role - b.role || a.model - b.model || a.entry.label.localeCompare(b.entry.label);
    });
    const out = [];
    let nodes = 0;
    let models = 0;
    let hiddenModels = 0;
    for (const item of scored) {
      if (item.model) {
        if (models < modelLimit) {
          models += 1;
          out.push(item);
        } else hiddenModels += 1;
      } else if (nodes < limit) {
        nodes += 1;
        out.push(item);
      }
    }
    const result = out.map((item) => ({ ...item.entry, compat: compat ? compat.get(item.entry.type) : null }));
    result.hiddenModels = hiddenModels;
    return result;
  }

  // Palette entry of a node type. text = { label(def), keywords(def) -> translated synonyms, categoryLabel(id) }.
  // The searchable parts are kept apart (names, synonym phrases, everything else) so that a hit in a name, in a
  // synonym and in the description each count by their own weight instead of by their place in one long text.
  function paletteEntry(def, text) {
    const label = text.label(def);
    return {
      key: def.type,
      type: def.type,
      params: null,
      def,
      category: def.category,
      label,
      labels: uniqueTexts([label, def.label]),
      keywords: uniqueTexts([...(text.keywords(def) || []), ...(def.keywords || [])]),
      search: [text.categoryLabel(def.category), def.type, def.description || ''].join(' ')
    };
  }

  // Palette entry of one model of a node type with a model list (Higgsfield). spec = { type, kind }.
  function paletteModelEntry(def, option, spec, text) {
    return {
      key: `${spec.type}:${option.value}`,
      type: spec.type,
      params: { model: option.value },
      def,
      category: 'higgsfield',
      label: option.label,
      labels: [option.label],
      keywords: [],
      model: true,
      search: [option.value, 'higgsfield', spec.kind, text.categoryLabel('higgsfield')].join(' ')
    };
  }

  function uniqueTexts(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const text = String(item ?? '').trim();
      const key = normalizeSearch(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  // Keeps the registry in step with the server while the page stays open. The availability of nodes changes
  // outside the page (a key set up, Higgsfield connected in another tab), so the view looks again when the person
  // comes back, but not more often than every `minInterval` ms and never in the background.
  //   load()    -> Promise<registry payload>,   apply(payload) is called only when the availability changed.
  // check() resolves true when it applied a new payload, false when it skipped, found nothing new or failed.
  function registrySignature(payload) {
    return JSON.stringify((payload?.nodeTypes || []).map((def) => [def.type, def.available === true ? 1 : String(def.available), def.restricted === true ? 1 : 0]));
  }

  function createRegistryWatcher({ load, apply, now = Date.now, minInterval = 15000 }) {
    let signature = null;
    let lastAt = -Infinity;
    let pending = null;
    return {
      prime(payload) {
        signature = registrySignature(payload);
        lastAt = now();
      },
      check({ force = false } = {}) {
        if (pending) return pending;
        if (!force && now() - lastAt < minInterval) return Promise.resolve(false);
        lastAt = now();
        pending = Promise.resolve()
          .then(load)
          .then((payload) => {
            const next = registrySignature(payload);
            if (next === signature) return false;
            signature = next;
            apply(payload);
            return true;
          })
          .catch(() => false)
          .finally(() => {
            pending = null;
          });
        return pending;
      }
    };
  }

  /* ---------- extract a prompt into its own node ---------- */

  // Why the textarea param behind input port `portId` cannot be moved into a Prompt node, or null when it can.
  // Only unconnected `text` inputs backed by a `textarea` param qualify.
  function extractTextParamIssue(reg, graph, nodeId, portId) {
    if (!reg.types.has(PROMPT_TYPE)) return 'no_prompt_type';
    const node = getNode(graph, nodeId);
    if (!node) return 'unknown_node';
    const port = findPort(reg, node, 'in', portId);
    if (!port || port.hidden) return 'unknown_port';
    const def = reg.types.get(node.type);
    const param = port.param && def ? (def.params || []).find((item) => item.id === port.param) : null;
    if (port.type !== 'text' || !param || param.kind !== 'textarea') return 'not_extractable';
    if (incomingEdges(graph, nodeId, portId).length) return 'connected';
    return null;
  }

  function canExtractTextParam(reg, graph, nodeId, portId) {
    return extractTextParamIssue(reg, graph, nodeId, portId) === null;
  }

  // Moves the text of an embedded prompt field into a new Prompt node placed left of the target and
  // connects it to that input. Returns { graph, node, edge } or { graph, error: { reason } }.
  // One call = one undo step for the caller. options: { newNodeId, edgeId, position, sizes, reserved }.
  function extractTextParamToNode(reg, graph, nodeId, portId, options = {}) {
    const reason = extractTextParamIssue(reg, graph, nodeId, portId);
    if (reason) return { graph, error: { reason } };
    const target = getNode(graph, nodeId);
    const port = findPort(reg, target, 'in', portId);
    const def = reg.types.get(target.type);
    const text = String(effectiveParams(def, target)[port.param] ?? '');
    let position = options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y) ? { x: options.position.x, y: options.position.y } : null;
    if (!position) {
      const x = snap(target.x - PROMPT_NODE_WIDTH - PROMPT_NODE_GAP, 8);
      let y = snap(target.y, 8);
      // Step down while the spot overlaps another card (bounded, the canvas can always be tidied up).
      const height = 200;
      for (let guard = 0; guard < 40; guard += 1) {
        const rect = { x, y, w: PROMPT_NODE_WIDTH, h: height };
        const clash = graph.nodes.some((other) => other.id !== nodeId && rectsIntersect(rect, nodeRect(other, options.sizes)));
        if (!clash) break;
        y += 48;
      }
      position = { x, y };
    }
    const added = addNode(reg, graph, PROMPT_TYPE, { id: options.newNodeId, x: position.x, y: position.y, params: { prompt: text }, reserved: options.reserved });
    const linked = connect(reg, added.graph, { node: added.node.id, port: 'prompt' }, { node: nodeId, port: portId }, { id: options.edgeId, reserved: options.reserved });
    if (linked.error) return { graph, error: { reason: linked.error.code } };
    const cleared = setParams(linked.graph, nodeId, { [port.param]: '' });
    return { graph: cleared, node: added.node, edge: linked.edge };
  }

  /* ---------- take a text result over as a Prompt node ("Use as text") ---------- */

  // Why the text result at output port `portId` cannot become a Prompt node, or null when it can. `text` is the result.
  function adoptTextIssue(reg, graph, nodeId, portId, text) {
    if (!reg.types.has(PROMPT_TYPE)) return 'no_prompt_type';
    const node = getNode(graph, nodeId);
    if (!node) return 'unknown_node';
    const port = findPort(reg, node, 'out', portId);
    if (!port || port.hidden) return 'unknown_port';
    const parsed = parseType(port.type);
    if (!parsed || parsed.base !== 'text' || parsed.list) return 'not_text';
    if (typeof text !== 'string' || !text.trim()) return 'empty';
    return null;
  }

  // Puts the text result of an output into a new Prompt node below the node and moves the connections that leave this
  // output to the new node (same targets, same order, same edge ids): the person edits the text there and what used the
  // result now reads the edited text. The output itself keeps no connection, nothing is run. Returns
  // { graph, node, edges } (edges = ids of the moved connections) or { graph, error: { reason } }.
  // One call = one undo step for the caller. options: { newNodeId, position, sizes, reserved }.
  function adoptTextAsPrompt(reg, graph, nodeId, portId, text, options = {}) {
    const reason = adoptTextIssue(reg, graph, nodeId, portId, text);
    if (reason) return { graph, error: { reason } };
    const source = getNode(graph, nodeId);
    let position = options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y) ? { x: options.position.x, y: options.position.y } : null;
    if (!position) {
      const x = snap(source.x, 8);
      let y = snap(source.y + nodeRect(source, options.sizes).h + 48, 8);
      // Step down while the spot overlaps another card or a note (bounded, the canvas can always be tidied up).
      for (let guard = 0; guard < 40; guard += 1) {
        const rect = { x, y, w: PROMPT_NODE_WIDTH, h: CONVERT_NODE_HEIGHT };
        const clash = graph.nodes.some((other) => rectsIntersect(rect, nodeRect(other, options.sizes))) || (graph.notes || []).some((note) => rectsIntersect(rect, { x: note.x, y: note.y, w: note.w, h: note.h }));
        if (!clash) break;
        y += 48;
      }
      position = { x, y };
    }
    const added = addNode(reg, graph, PROMPT_TYPE, { id: options.newNodeId, x: position.x, y: position.y, params: { prompt: text }, reserved: options.reserved });
    const promptPort = portsFor(reg, added.node).outputs.find((port) => !port.hidden && port.type === 'text');
    if (!promptPort) return { graph, error: { reason: 'no_prompt_type' } };
    const moved = [];
    const edges = added.graph.edges.map((edge) => {
      if (edge.from.node !== nodeId || edge.from.port !== portId) return edge;
      moved.push(edge.id);
      return { ...edge, from: { node: added.node.id, port: promptPort.id } };
    });
    return { graph: { ...added.graph, edges }, node: added.node, edges: moved };
  }

  // Design App inputs ({ node, param }) whose node cannot reach any app output: changing them changes nothing in what the
  // app returns. Empty while the app has no output (nothing to reach yet) or nothing to check.
  function appInputsWithoutOutput(graph, app) {
    const inputs = Array.isArray(app?.inputs) ? app.inputs : [];
    const outputs = new Set((Array.isArray(app?.outputs) ? app.outputs : []).map((entry) => entry.node).filter((id) => getNode(graph, id)));
    if (!inputs.length || !outputs.size) return [];
    const cache = new Map();
    return inputs.filter((entry) => {
      if (!getNode(graph, entry.node)) return false;
      if (outputs.has(entry.node)) return false;
      if (!cache.has(entry.node)) cache.set(entry.node, descendants(graph, [entry.node]));
      return ![...outputs].some((id) => cache.get(entry.node).has(id));
    });
  }

  // The app inputs that reached an app output in `before` and no longer do in `after` (for example after "Use as text":
  // the new Prompt node drives the target, so the nodes that fed the source are cut off).
  function appInputsCutOff(before, after, app) {
    const already = new Set(appInputsWithoutOutput(before, app).map((entry) => `${entry.node}\u0000${entry.param}`));
    return appInputsWithoutOutput(after, app).filter((entry) => !already.has(`${entry.node}\u0000${entry.param}`));
  }

  /* ---------- Motion graphics: instruction in the HTML field -> Prompt + Motion HTML writer ---------- */

  // Why the HTML field of a Motion graphics node cannot be converted, or null when it can. Only an unconnected HTML
  // input whose field holds free text (not HTML) qualifies, and only while the Motion HTML writer is available.
  function motionHtmlConversionIssue(reg, graph, nodeId) {
    if (!reg.types.has(PROMPT_TYPE) || !reg.types.has(MOTION_WRITER_TYPE)) return 'no_writer_type';
    // The writer needs an LLM provider; without one the converted chain could not run, so no conversion is offered.
    if (reg.types.get(MOTION_WRITER_TYPE).available !== true) return 'writer_unavailable';
    const node = getNode(graph, nodeId);
    if (!node) return 'unknown_node';
    if (node.type !== MOTION_TYPE) return 'not_motion_node';
    const port = findPort(reg, node, 'in', 'html');
    const def = reg.types.get(node.type);
    if (!port || !def) return 'unknown_port';
    if (incomingEdges(graph, nodeId, 'html').length) return 'connected';
    const text = String(effectiveParams(def, node)[port.param || 'html'] ?? '');
    if (!text.trim()) return 'empty';
    if (motionHtml.looksLikeHtml(text)) return 'is_html';
    return null;
  }

  function canConvertMotionHtml(reg, graph, nodeId) {
    return motionHtmlConversionIssue(reg, graph, nodeId) === null;
  }

  // Turns the instruction in the HTML field of a Motion graphics node into a chain to its left:
  //   Prompt (text = the old field) -> Motion HTML writer (brief) -> Motion graphics (html)
  // The format of the node moves to the writer, every source on the node's "Assets" input is connected to the
  // writer's "Assets" input in the same order (so the writer knows the file names), the HTML field is cleared.
  // Nothing is run or paid for. Returns { graph, prompt, writer, edges } or { graph, error: { reason } }.
  // One call = one undo step for the caller. options: { promptId, writerId, edgeIds: {brief, html}, position: { x, y }
  // (of the Prompt node), sizes, reserved }.
  function convertMotionHtmlToWriter(reg, graph, nodeId, options = {}) {
    const reason = motionHtmlConversionIssue(reg, graph, nodeId);
    if (reason) return { graph, error: { reason } };
    const target = getNode(graph, nodeId);
    const def = reg.types.get(target.type);
    const params = effectiveParams(def, target);
    const text = String(params.html ?? '');
    const gap = PROMPT_NODE_GAP;
    let promptPos = options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y) ? { x: options.position.x, y: options.position.y } : null;
    if (!promptPos) {
      const writerX = snap(target.x - WRITER_NODE_WIDTH - gap, 8);
      const promptX = snap(writerX - PROMPT_NODE_WIDTH - gap, 8);
      let y = snap(target.y, 8);
      // Step down while either new card would overlap another one (bounded, the canvas can always be tidied up).
      for (let guard = 0; guard < 60; guard += 1) {
        const writerRect = { x: writerX, y, w: WRITER_NODE_WIDTH, h: WRITER_NODE_HEIGHT };
        const promptRect = { x: promptX, y, w: PROMPT_NODE_WIDTH, h: CONVERT_NODE_HEIGHT };
        const clash = graph.nodes.some((other) => {
          if (other.id === nodeId) return false;
          const rect = nodeRect(other, options.sizes);
          return rectsIntersect(writerRect, rect) || rectsIntersect(promptRect, rect);
        });
        if (!clash) break;
        y += 48;
      }
      promptPos = { x: promptX, y };
    }
    const writerPos = { x: promptPos.x + PROMPT_NODE_WIDTH + gap, y: promptPos.y };

    const addedPrompt = addNode(reg, graph, PROMPT_TYPE, { id: options.promptId, x: promptPos.x, y: promptPos.y, params: { prompt: text }, reserved: options.reserved });
    const addedWriter = addNode(reg, addedPrompt.graph, MOTION_WRITER_TYPE, { id: options.writerId, x: writerPos.x, y: writerPos.y, params: { format: params.format }, reserved: options.reserved });
    let next = addedWriter.graph;
    const edges = [];
    const link = (from, to, id) => {
      const result = connect(reg, next, from, to, { id, reserved: options.reserved });
      if (result.error) return null;
      next = result.graph;
      edges.push(result.edge);
      return result.edge;
    };
    const briefEdge = link({ node: addedPrompt.node.id, port: 'prompt' }, { node: addedWriter.node.id, port: 'brief' }, options.edgeIds && options.edgeIds.brief);
    if (!briefEdge) return { graph, error: { reason: 'connect_failed' } };
    // The assets of the node, in the order of graph.edges (= the order the engine collects them in).
    for (const edge of incomingEdges(graph, nodeId, 'assets')) link(edge.from, { node: addedWriter.node.id, port: 'assets' });
    const htmlEdge = link({ node: addedWriter.node.id, port: 'html' }, { node: nodeId, port: 'html' }, options.edgeIds && options.edgeIds.html);
    if (!htmlEdge) return { graph, error: { reason: 'connect_failed' } };
    next = setParams(next, nodeId, { html: '' });
    return { graph: next, prompt: addedPrompt.node, writer: addedWriter.node, edges };
  }

  /* ---------- sources for missing inputs: "insert with inputs" and the fix of an incomplete card ---------- */

  function isBlankValue(value) {
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  }

  // The visible output of a node type that can feed an input of `targetType`, the one of the same base type first.
  function bestOutputFor(reg, def, targetType) {
    const wanted = parseType(targetType);
    let best = null;
    for (const port of def.outputs || []) {
      if (port.hidden || !canConnectTypes(reg, port.type, targetType)) continue;
      const rank = parseType(port.type)?.base === wanted?.base ? 2 : 1;
      if (!best || rank > best.rank) best = { rank, port };
    }
    return best ? best.port : null;
  }

  // The node that should sit in front of the input `port`: the type named by the port's `suggest` hint (registry), else
  // the input node of its base type (image / video / audio input, Prompt for text). Types of this account that may not
  // be used (restricted) are skipped. Returns { type, port, hinted } (`port` = its output) or null, e.g. for `any`.
  function sourceFor(reg, port) {
    const make = (type, hinted) => {
      const def = reg.types.get(type);
      const out = def && def.restricted !== true ? bestOutputFor(reg, def, port.type) : null;
      return out ? { type, port: out.id, hinted } : null;
    };
    const hinted = typeof port.suggest === 'string' ? make(port.suggest, true) : null;
    if (hinted) return hinted;
    const parsed = parseType(port.type);
    const type = parsed && !parsed.list ? SOURCE_TYPES[parsed.base] : null;
    return type ? make(type, false) : null;
  }

  // Required inputs of a node that are neither connected nor filled (the rule of the engine's validation: a text or
  // number input backed by a param counts as given while the param holds a value). Ports in definition order.
  function missingInputs(reg, graph, nodeId) {
    const node = getNode(graph, nodeId);
    const def = node ? reg.types.get(node.type) : null;
    if (!def) return [];
    const params = effectiveParams(def, node);
    return portsFor(reg, node).inputs.filter((port) => {
      if (port.hidden || !port.required || incomingEdges(graph, nodeId, port.id).length) return false;
      const base = parseType(port.type)?.base;
      return !(port.param && (base === 'text' || base === 'number') && !isBlankValue(params[port.param]));
    });
  }

  // Sources for the missing inputs of a type that is not on the canvas yet: [{ port, source, children }] with the
  // missing inputs of every source one level deeper (`levels` = how many levels of sources behind sources).
  function planSources(reg, node, ports, levels) {
    const plan = [];
    for (const port of ports) {
      const source = sourceFor(reg, port);
      if (!source) continue;
      let children = [];
      if (levels > 0) {
        const probe = addNode(reg, emptyGraph(), source.type, { id: 'probe' });
        children = planSources(reg, probe.node, missingInputs(reg, probe.graph, 'probe'), levels - 1);
      }
      // a multiple input that needs several connections (Concatenate videos: 2 clips) gets that many sources
      const copies = port.multiple === true && Number.isInteger(port.min) ? Math.min(port.min, MAX_MIN_SOURCES) : 1;
      for (let copy = 0; copy < copies; copy += 1) plan.push({ port, source, children });
    }
    return plan;
  }

  // Layout of the plan to the left of x (column per level): { type, x, y, children }. Returns the height of the block.
  function layoutSources(plan, right, top, out) {
    let cursor = top;
    for (const item of plan) {
      const x = right - SOURCE_NODE_WIDTH - SOURCE_NODE_GAP;
      const own = SOURCE_HEIGHTS[item.source.type] || SOURCE_NODE_HEIGHT;
      const placed = { item, x, y: cursor, children: [] };
      const below = layoutSources(item.children, x, cursor, placed.children);
      out.push(placed);
      cursor += Math.max(own, below) + SOURCE_ROW_GAP;
    }
    return Math.max(0, cursor - top - SOURCE_ROW_GAP);
  }

  function flattenPlaced(placed) {
    return placed.flatMap((entry) => [entry, ...flattenPlaced(entry.children)]);
  }

  // Params a new source takes over from the node it feeds: a select param of the same id whose value is an option
  // there too (the Motion HTML writer gets the "format" of the Motion graphics node).
  function inheritedParams(sourceDef, targetDef, targetParams) {
    const out = {};
    for (const param of sourceDef.params || []) {
      if (param.kind !== 'select' || !Array.isArray(param.options)) continue;
      const mine = (targetDef.params || []).find((item) => item.id === param.id && item.kind === 'select');
      const value = mine ? targetParams[param.id] : undefined;
      const options = param.options.map((option) => (option && typeof option === 'object' ? option.value : option));
      if (value !== undefined && value !== '' && options.some((option) => String(option) === String(value))) out[param.id] = value;
    }
    return out;
  }

  // Puts a source in front of each missing required input of a node (or of options.ports) and connects it: the input
  // node of the port's base type, or the node named by the port's `suggest` hint, whose own missing required inputs
  // are supplied one level deeper (Motion HTML writer <- Prompt). The new cards stand left of the node, stepping down
  // while they would cover another card. A source also takes over what the node already has for inputs of the same id
  // (the assets on a Motion graphics node go to the writer too, so it knows the file names) and its "format".
  // Nothing is run. Returns { graph, nodes, edges, supplied: [{ port, node }] } or { graph, error: { reason } } with
  // reason 'unknown_node' | 'no_source' (nothing to supply). One call = one undo step for the caller.
  // options: { ports: [port ids] (default all missing), levels (default 1), sizes, reserved, at: { x, y } (top of the block) }
  function addInputSources(reg, graph, nodeId, options = {}) {
    const target = getNode(graph, nodeId);
    const targetDef = target ? reg.types.get(target.type) : null;
    if (!targetDef) return { graph, error: { reason: 'unknown_node' } };
    const only = Array.isArray(options.ports) ? new Set(options.ports) : null;
    const ports = missingInputs(reg, graph, nodeId).filter((port) => !only || only.has(port.id));
    const plan = planSources(reg, target, ports, Number.isInteger(options.levels) ? options.levels : 1);
    if (!plan.length) return { graph, error: { reason: 'no_source' } };

    const placed = [];
    const top = options.at && Number.isFinite(options.at.y) ? options.at.y : snap(target.y, 8);
    const right = options.at && Number.isFinite(options.at.x) ? options.at.x : target.x;
    layoutSources(plan, snap(right, 8), snap(top, 8), placed);
    let shift = 0;
    const flat = flattenPlaced(placed);
    for (let guard = 0; guard < 60; guard += 1) {
      const clash = flat.some((entry) => {
        const rect = { x: entry.x, y: entry.y + shift, w: SOURCE_NODE_WIDTH, h: SOURCE_HEIGHTS[entry.item.source.type] || SOURCE_NODE_HEIGHT };
        return graph.nodes.some((other) => other.id !== nodeId && rectsIntersect(rect, nodeRect(other, options.sizes)));
      });
      if (!clash) break;
      shift += 48;
    }

    let next = graph;
    const nodes = [];
    const edges = [];
    const supplied = [];
    const link = (from, to) => {
      const result = connect(reg, next, from, to, { reserved: options.reserved });
      if (result.error) return null;
      next = result.graph;
      edges.push(result.edge);
      return result.edge;
    };
    const build = (entries, parentId, parentDef, level) => {
      for (const entry of entries) {
        const { source, port } = entry.item;
        const sourceDef = reg.types.get(source.type);
        const parent = getNode(next, parentId);
        const params = level === 0 ? inheritedParams(sourceDef, parentDef, effectiveParams(parentDef, parent)) : {};
        const added = addNode(reg, next, source.type, { x: entry.x, y: entry.y + shift, params, reserved: options.reserved });
        next = added.graph;
        nodes.push(added.node);
        const edge = link({ node: added.node.id, port: source.port }, { node: parentId, port: port.id });
        if (!edge) continue;
        if (level === 0) supplied.push({ port: port.id, node: added.node.id });
        // What the node already has on an input the source has as well (same id): the same sources, in the same order.
        if (level === 0) {
          const mine = new Set(portsFor(reg, added.node).inputs.filter((item) => !item.hidden).map((item) => item.id));
          for (const incoming of graph.edges.filter((item) => item.to.node === parentId && item.to.port !== port.id && mine.has(item.to.port))) {
            link(incoming.from, { node: added.node.id, port: incoming.to.port });
          }
        }
        build(entry.children, added.node.id, sourceDef, level + 1);
      }
    };
    build(placed, nodeId, targetDef, 0);
    return { graph: next, nodes, edges, supplied };
  }

  // A node of `type` with a source in front of each of its required inputs, as a sub graph for insertSubgraph ("insert
  // with inputs"): { nodes, edges, target } with the node at (0, 0) and the sources to its left, or
  // { error: { reason: 'unknown_type' } }. Without any source to add it is the single node.
  function inputsSubgraph(reg, type, options = {}) {
    if (!reg.types.has(type)) return { error: { reason: 'unknown_type', type } };
    const added = addNode(reg, emptyGraph(), type, { id: 'n1', x: 0, y: 0, params: options.params });
    const result = addInputSources(reg, added.graph, 'n1', { levels: options.levels });
    const built = result.error ? added.graph : result.graph;
    return { nodes: built.nodes, edges: built.edges, target: 'n1' };
  }

  /* ---------- port descriptions (hover help) ---------- */

  // i18n keys of the description of a port. Lookup order (the caller uses the first key that has a text):
  //   dirKey                                   nodes.portdesc.<nodeType>.<portId>.<in|out>  one side of a node
  //   key                                      nodes.portdesc.<nodeType>.<portId>           this port of this node type
  //   fallbackKeys[0]                          nodes.portdesc.<portId>.<in|out>             the port id in general, one side
  //   fallbackKeys[1]                          nodes.portdesc.<portId>                      the port id in general
  //   fallbackKeys[2]                          nodes.portdesc.type.<base>.<in|out>          the port type, last resort
  // The side keys exist because many nodes use the same id on both sides (image in, image out).
  function portDescriptionKeys(nodeType, portId, base, direction) {
    const dir = direction === 'out' ? 'out' : 'in';
    const key = `nodes.portdesc.${nodeType}.${portId}`;
    return {
      key,
      dirKey: `${key}.${dir}`,
      fallbackKeys: [`nodes.portdesc.${portId}.${dir}`, `nodes.portdesc.${portId}`, `nodes.portdesc.type.${base || 'any'}.${dir}`]
    };
  }

  // All keys of a description in lookup order.
  function portDescriptionChain(text) {
    return [text.dirKey, text.key, ...text.fallbackKeys];
  }

  // Structured description of one port for the hover tooltip; no strings, no HTML: the UI resolves the keys.
  //   { nodeId, nodeType, portId, direction, labelKey, label, base, typeKey, list, required (in: boolean, out: null),
  //     multiple, max, count, limit (the limit that depends on the chosen model, or null), overLimit,
  //     text: { key, dirKey, fallbackKeys }, facts: [{ key, vars, error? }],
  //     connections: [{ order, edgeId, nodeId, nodeTitle, titled, nodeType, port, multiOutput }], moreConnections }
  // Facts come from the definition alone (multi-input, list input / output, param fallback). The connections of an
  // input are listed in graph.edges order, which is exactly the order resolveNodeInputs (lib/nodes/engine.js)
  // collects them in: `order` is the position a prompt refers to ("Image 1", "Image 2" ...) as long as no list
  // comes before it; a list counts with all of its items, so `order` is null behind the first list connection
  // (`list` marks such a connection) and the fact orderShift explains why.
  // Returns null for an unknown node or port.
  function describePort(reg, graph, nodeId, direction, portId) {
    const node = getNode(graph, nodeId);
    if (!node) return null;
    const dir = direction === 'out' ? 'out' : 'in';
    const port = findPort(reg, node, dir, portId);
    if (!port) return null;
    const def = reg.types.get(node.type) || null;
    const parsed = parseType(port.type) || { base: 'any', list: false };
    const isInput = dir === 'in';
    const multiple = isInput && port.multiple === true;
    const max = multiple ? portMax(port) : null;
    const incoming = isInput ? incomingEdges(graph, nodeId, portId) : [];
    const count = incoming.length;
    const media = MEDIA_BASES.includes(parsed.base);
    const facts = [];
    // An input whose limit depends on a param (the model): { known, max, roles, required, subject } or, while the model is
    // not known, { known: false, chosen } (chosen: a model is set, it only has not been read yet).
    let limit = null;
    if (multiple && port.limit) {
      limit = port.limit.known
        ? { known: true, max: port.limit.max, roles: port.limit.roles.slice(), required: port.limit.required, subject: port.limit.subject }
        : { known: false, ...(port.limit.error === true ? { error: true } : {}), chosen: Boolean(def && port.limitBy && String(effectiveParams(def, node)[port.limitBy.param] || '').trim()) };
    }
    if (multiple && limit && limit.known) {
      // 'none', 'one' or 'many' picks the wording; the list fact only matters when more than one connection fits
      const form = limit.max === 0 ? 'none' : limit.max === 1 ? 'one' : 'many';
      facts.push({ key: `nodes.porttip.fact.limit.${form}`, vars: { model: limit.subject, max: limit.max, count } });
      if (limit.max > 1) facts.push({ key: `nodes.porttip.fact.multiList${media ? 'Media' : ''}Max`, vars: { max: limit.max } });
      if (limit.required) facts.push({ key: 'nodes.porttip.fact.limitRequired', vars: { model: limit.subject } });
      if (count > limit.max) facts.push({ key: 'nodes.porttip.fact.limitOver', vars: { count, max: limit.max }, error: true });
    } else if (multiple && limit) {
      facts.push({ key: limit.error ? 'nodes.porttip.fact.limitError' : limit.chosen ? 'nodes.porttip.fact.limitUnknown' : 'nodes.porttip.fact.limitChoose', vars: { count } });
      facts.push({ key: `nodes.porttip.fact.multiList${media ? 'Media' : ''}`, vars: {} });
    } else if (multiple) {
      // a fixed maximum of 0 (an input that a param value switched off, see portVariants) takes nothing at all
      if (max === 0) {
        facts.push({ key: 'nodes.porttip.fact.takesNone', vars: { count } });
      } else {
        if (max !== null) facts.push({ key: 'nodes.porttip.fact.multi', vars: { max, count } });
        else facts.push({ key: 'nodes.porttip.fact.multiUnlimited', vars: { count } });
        const listKey = `nodes.porttip.fact.multiList${media ? 'Media' : ''}${max !== null ? 'Max' : ''}`;
        facts.push({ key: listKey, vars: max !== null ? { max } : {} });
      }
      if (max !== null && count > max) facts.push({ key: 'nodes.porttip.fact.limitOver', vars: { count, max }, error: true });
    } else if (isInput && parsed.list) {
      facts.push({ key: 'nodes.porttip.fact.listIn', vars: {} });
    } else if (isInput) {
      facts.push({ key: 'nodes.porttip.fact.singleMap', vars: {} });
    }
    if (isInput && port.param && def && (def.params || []).some((param) => param.id === port.param)) {
      facts.push({ key: 'nodes.porttip.fact.param', vars: {} });
    }
    if (!isInput && parsed.list) facts.push({ key: 'nodes.porttip.fact.listOut', vars: {} });

    // A list on a multi-input delivers all of its items, so its length decides every later position ("Image 4" ...);
    // that is unknown here, hence the positions behind the first list connection are null.
    let afterList = false;
    let shifted = false;
    const connections = incoming.slice(0, PORT_TIP_MAX_CONNECTIONS).map((edge, index) => {
      const from = getNode(graph, edge.from.node);
      const fromDef = from ? reg.types.get(from.type) || null : null;
      const outputs = from ? portsFor(reg, from).outputs.filter((output) => !output.hidden) : [];
      const fromPort = outputs.find((output) => output.id === edge.from.port);
      const isList = Boolean(fromPort && (parseType(fromPort.type) || {}).list);
      const order = multiple && afterList ? null : index + 1;
      if (order === null) shifted = true;
      if (isList) afterList = true;
      const custom = from && typeof from.title === 'string' && from.title.trim() ? from.title.trim() : '';
      return {
        order,
        list: isList,
        edgeId: edge.id,
        nodeId: edge.from.node,
        nodeTitle: custom || (fromDef ? fromDef.label : from ? from.type : edge.from.node),
        titled: Boolean(custom),
        nodeType: from ? from.type : null,
        port: edge.from.port,
        multiOutput: outputs.length > 1
      };
    });

    if (shifted || (afterList && count > connections.length)) facts.push({ key: 'nodes.porttip.fact.orderShift', vars: {} });

    const keys = portDescriptionKeys(node.type, portId, parsed.base, dir);
    return {
      nodeId,
      nodeType: node.type,
      portId,
      direction: dir,
      labelKey: `nodes.port.${portId}`,
      label: String(portId).replace(/[_-]+/g, ' ').replace(/^./, (char) => char.toUpperCase()),
      base: parsed.base,
      typeKey: `nodes.ptype.${parsed.base}`,
      list: parsed.list,
      required: isInput ? port.required === true : null,
      multiple,
      max,
      count,
      limit,
      overLimit: Boolean(multiple && Number.isFinite(port.max) && count > port.max),
      text: keys,
      facts,
      connections,
      moreConnections: Math.max(0, count - connections.length)
    };
  }

  // Conditional param visibility (registry showIf): { param, equals }, { param, in: [...] } (the param holds one of the values),
  // { param, empty } (empty true = the field holds no text),
  // { port, connected } or { ports: [...], connected } (connected false = none of the ports is connected, true = at
  // least one), and { all: [...] } when several of these must hold.
  // options.ignoreParams: conditions on the value of a param count as met. What is left is the part that only a connection
  // can change, so the inspector knows which fields it has to build at all (see dependsOnParam).
  function isVisible(showIf, node, def, connectedPorts, options) {
    if (!showIf) return true;
    const ignoreParams = Boolean(options && options.ignoreParams);
    if (Array.isArray(showIf.all)) return showIf.all.every((item) => isVisible(item, node, def, connectedPorts, options));
    if (showIf.param !== undefined) {
      if (ignoreParams) return true;
      const params = effectiveParams(def, node);
      if (showIf.empty !== undefined) return !String(params[showIf.param] ?? '').trim() === Boolean(showIf.empty);
      if (Array.isArray(showIf.in)) return showIf.in.some((value) => String(params[showIf.param]) === String(value));
      return String(params[showIf.param]) === String(showIf.equals);
    }
    if (showIf.port !== undefined) {
      const connected = Boolean(connectedPorts && connectedPorts.has(showIf.port));
      return connected === Boolean(showIf.connected);
    }
    if (Array.isArray(showIf.ports)) {
      const any = showIf.ports.some((port) => Boolean(connectedPorts && connectedPorts.has(port)));
      return any === Boolean(showIf.connected);
    }
    return true;
  }

  // Does the visibility of a field depend on the value of another param (typing or choosing something shows or hides it)?
  // Such fields stay in the form and are shown or hidden in place; building the form again would pull the cursor away.
  function dependsOnParam(showIf) {
    if (!showIf) return false;
    if (Array.isArray(showIf.all)) return showIf.all.some((item) => dependsOnParam(item));
    return showIf.param !== undefined;
  }

  return {
    LIST_SUFFIX,
    DEFAULT_NODE_SIZE,
    ZOOM_MIN,
    ZOOM_MAX,
    GROUP_COLORS,
    CLIPBOARD_FORMAT,
    clone,
    emptyGraph,
    content,
    withContent,
    sameContent,
    allIds,
    nextId,
    indexRegistry,
    paramDefaults,
    effectiveParams,
    portsFor,
    findPort,
    portMax,
    overLimits,
    capabilityUsage,
    parseType,
    canConnectTypes,
    getNode,
    edgesOf,
    incomingEdges,
    outgoingEdges,
    descendants,
    ancestors,
    wouldCreateCycle,
    checkConnection,
    connect,
    disconnect,
    disconnectNode,
    pruneEdges,
    addNode,
    removeNodes,
    replaceNode,
    moveItems,
    setPositions,
    setParams,
    setTitle,
    addNote,
    updateNote,
    removeNotes,
    addGroup,
    updateGroup,
    removeGroups,
    sizeOf,
    nodeRect,
    unionRect,
    rectsIntersect,
    rectContainsPoint,
    boundsOf,
    itemsInRect,
    membersOfGroup,
    snap,
    groupSelection,
    clampZoom,
    zoomAt,
    fitViewport,
    screenToWorld,
    worldToScreen,
    copySelection,
    isClipboard,
    paste,
    insertSubgraph,
    duplicate,
    removeSelection,
    normalizeLoaded,
    validate,
    normalizeSearch,
    parseSearchQuery,
    fuzzyScore,
    nodeRole,
    paletteEntry,
    paletteModelEntry,
    registrySignature,
    createRegistryWatcher,
    compatibleTargets,
    quickPickTargets,
    rankPaletteEntries,
    extractTextParamIssue,
    canExtractTextParam,
    extractTextParamToNode,
    adoptTextIssue,
    adoptTextAsPrompt,
    appInputsWithoutOutput,
    appInputsCutOff,
    motionHtmlConversionIssue,
    canConvertMotionHtml,
    convertMotionHtmlToWriter,
    sourceFor,
    missingInputs,
    addInputSources,
    inputsSubgraph,
    portDescriptionKeys,
    portDescriptionChain,
    describePort,
    PORT_TIP_MAX_CONNECTIONS,
    PROMPT_TYPE,
    firstCompatiblePort,
    isVisible,
    dependsOnParam
  };
});
