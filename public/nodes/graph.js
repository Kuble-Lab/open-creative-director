'use strict';

// Pure graph model of the node view (SPEC §7.1, §12.3): no DOM, no I/O.
// Every mutation returns a new graph object (structural sharing); node objects that did not
// change keep their identity so the canvas can diff by reference.
// UMD: module.exports in Node (tests), window.OCDNodes.graph in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.graph = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const LIST_SUFFIX = '[]';
  const DEFAULT_NODE_SIZE = Object.freeze({ w: 280, h: 160 });
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 2.5;
  const MAX_NODES = 500;
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  const GROUP_COLORS = Object.freeze(['amber', 'blue', 'green', 'violet', 'rose', 'grey']);
  const PROMPT_TYPE = 'input.prompt';
  // Approximate footprint of a freshly extracted prompt node (card width + gap to its target).
  const PROMPT_NODE_WIDTH = 340;
  const PROMPT_NODE_GAP = 56;
  const PROMPT_BOOST = 10;

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
  function indexRegistry(payload) {
    const source = payload || {};
    const types = new Map();
    for (const def of source.nodeTypes || []) types.set(def.type, def);
    return {
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
    return { inputs, outputs };
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
      if (count >= toPort.max) return { code: 'too_many' };
    }
    return null;
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

  // Removes edges whose ports no longer exist or became incompatible (after a portVariants param
  // change) and edges beyond the max of a multi-input port.
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
      ids: { nodes: nodes.map((n) => n.id), notes: notes.map((n) => n.id), groups: groups.map((g) => g.id) },
      idMap
    };
  }

  // Duplicate = copy + paste next to the originals.
  function duplicate(graph, selection, offset = 32, options = {}) {
    const clip = copySelection(graph, selection);
    if (!clip) return { graph, ids: { nodes: [], notes: [], groups: [] }, idMap: {} };
    return paste(graph, clip, { x: clip.origin.x + offset, y: clip.origin.y + offset }, options);
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

  // Normalised fuzzy score: 0 = no match. Every whitespace-separated query token must match.
  // Word-start hits score above plain substrings, which score above scattered subsequences.
  function fuzzyScore(query, text) {
    const tokens = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return 1;
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return 0;
    let total = 0;
    for (const token of tokens) {
      const index = haystack.indexOf(token);
      if (index >= 0) {
        const wordStart = index === 0 || /[^a-z0-9]/.test(haystack[index - 1]);
        total += wordStart ? 100 - Math.min(index, 40) * 0.5 : 60 - Math.min(index, 40) * 0.5;
        continue;
      }
      // subsequence
      let position = 0;
      let matched = 0;
      for (const char of token) {
        const found = haystack.indexOf(char, position);
        if (found < 0) {
          matched = -1;
          break;
        }
        position = found + 1;
        matched += 1;
      }
      if (matched < 0 || token.length < 3) return 0;
      total += 20;
    }
    return total / tokens.length;
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
  function quickPickTargets(reg, dir, portType) {
    const targets = compatibleTargets(reg, dir, portType);
    const source = parseType(portType);
    const boost = dir === 'in' && source && source.base === 'text' && reg.types.has(PROMPT_TYPE);
    return targets
      .map((target) => (boost && target.type === PROMPT_TYPE ? { ...target, rank: target.rank + PROMPT_BOOST } : target))
      .sort((a, b) => b.rank - a.rank);
  }

  // Filters and orders palette entries (pure part of the command palette).
  // entries: [{ type, category, label, search, model? }]. filter: { dir, type } from a dragged connection.
  // Returns the entries (with `compat` = the matching port target or null), best match first.
  function rankPaletteEntries(reg, entries, options = {}) {
    const { query = '', category = 'all', filter = null, limit = 90 } = options;
    let list = entries;
    let compat = null;
    if (filter) {
      compat = new Map(quickPickTargets(reg, filter.dir, filter.type).map((item) => [item.type, item]));
      list = list.filter((entry) => compat.has(entry.type));
    }
    if (category !== 'all') list = list.filter((entry) => entry.category === category);
    const text = String(query).trim();
    const categoryOrder = new Map((reg.categories || []).map((id, index) => [id, index]));
    const scored = list
      .map((entry) => ({ entry, score: fuzzyScore(text, entry.search), rank: compat ? compat.get(entry.type).rank : 0 }))
      .filter((item) => item.score > 0);
    scored.sort((a, b) => {
      if (text) return b.score - a.score || b.rank - a.rank || a.entry.label.localeCompare(b.entry.label);
      if (compat && b.rank !== a.rank) return b.rank - a.rank;
      const ca = categoryOrder.get(a.entry.category) ?? 99;
      const cb = categoryOrder.get(b.entry.category) ?? 99;
      // The Prompt node is pinned to the top of its category ("Inputs"); the rest is alphabetical.
      const pa = a.entry.type === PROMPT_TYPE ? 0 : 1;
      const pb = b.entry.type === PROMPT_TYPE ? 0 : 1;
      return ca - cb || pa - pb || Number(Boolean(a.entry.model)) - Number(Boolean(b.entry.model)) || a.entry.label.localeCompare(b.entry.label);
    });
    return scored.slice(0, limit).map((item) => ({ ...item.entry, compat: compat ? compat.get(item.entry.type) : null }));
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

  // Conditional param visibility (registry showIf): { param, equals }, { port, connected } or { ports: [...], connected }
  // (connected false = none of the ports is connected, true = at least one).
  function isVisible(showIf, node, def, connectedPorts) {
    if (!showIf) return true;
    if (showIf.param !== undefined) {
      const params = effectiveParams(def, node);
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
    duplicate,
    removeSelection,
    normalizeLoaded,
    validate,
    fuzzyScore,
    compatibleTargets,
    quickPickTargets,
    rankPaletteEntries,
    extractTextParamIssue,
    canExtractTextParam,
    extractTextParamToNode,
    PROMPT_TYPE,
    firstCompatiblePort,
    isVisible
  };
});
