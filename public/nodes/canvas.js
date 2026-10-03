'use strict';

// Infinite canvas of the node view (SPEC §12.2-§12.4): viewport, world layer, node cards, notes,
// groups, bezier edges, pointer interactions and the minimap. The canvas renders whatever graph it
// is given and reports user intent through callbacks; main.js owns the state and applies changes.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const geometry = OCD.edgeGeometry;
  const ui = OCD.ui;
  const { el } = ui;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DRAG_THRESHOLD = 3;
  const GRID = 8;
  const MINIMAP_W = 200;
  const MINIMAP_H = 132;
  const FALLBACK_PORT_Y = 46;

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }

  function emptySelection() {
    return { nodes: new Set(), notes: new Set(), groups: new Set(), edge: null };
  }

  const bezier = geometry.path;

  function createCanvas(container, options) {
    const opts = options || {};
    let reg = null;
    let graph = graphLib.emptyGraph();
    let viewport = { x: 0, y: 0, zoom: 1 };
    let selection = emptySelection();
    let tool = 'select';
    let spaceDown = false;
    let drag = null;
    let dragPositions = null;
    let lastPointer = { x: 0, y: 0 };
    let measureQueued = false;
    let minimapQueued = false;
    let edgesQueued = false;
    let destroyed = false;

    const cards = new Map();
    const noteEls = new Map();
    const groupEls = new Map();
    const edgeEls = new Map();
    const sizes = new Map();
    const portOffsets = new Map();
    const slots = new Map();
    const pendingMeasure = new Set();
    const connectedCache = new Map();

    /* ---------- DOM ---------- */

    container.classList.add('nv-canvas');
    container.tabIndex = 0;
    container.setAttribute('role', 'application');
    const world = el('div', { class: 'nv-world' });
    const groupLayer = el('div', { class: 'nv-layer nv-layer-groups' });
    const noteLayer = el('div', { class: 'nv-layer nv-layer-notes' });
    const edgeSvg = svgEl('svg', { class: 'nv-edges', width: 1, height: 1 });
    const edgeGroup = svgEl('g', { class: 'nv-edges-main' });
    const ghostGroup = svgEl('g', { class: 'nv-edges-ghost' });
    edgeSvg.append(edgeGroup, ghostGroup);
    const nodeLayer = el('div', { class: 'nv-layer nv-layer-nodes' });
    world.append(groupLayer, noteLayer, edgeSvg, nodeLayer);
    const marquee = el('div', { class: 'nv-marquee hidden' });
    container.append(world, marquee);

    // Hover help for ports (port-tip.js): screen-space tooltip, hidden whenever the view or the graph changes.
    const portTip = OCD.portTip
      ? OCD.portTip.createPortTip({
          container,
          getReg: () => reg,
          getGraph: () => graph,
          isBusy: () => Boolean(drag)
        })
      : null;

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const id = entry.target.dataset?.id;
            if (id && cards.has(id)) pendingMeasure.add(id);
          }
          scheduleMeasure();
        })
      : null;

    /* ---------- helpers ---------- */

    const rectOfContainer = () => container.getBoundingClientRect();

    function clientToWorld(clientX, clientY) {
      const rect = rectOfContainer();
      return graphLib.screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
    }

    function containerSize() {
      return { width: container.clientWidth, height: container.clientHeight };
    }

    function posOf(id) {
      if (dragPositions && dragPositions[id]) return dragPositions[id];
      const node = graph.nodes.find((n) => n.id === id);
      return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
    }

    function nodeMap() {
      const map = new Map();
      for (const node of graph.nodes) map.set(node.id, node);
      return map;
    }

    function portPoint(nodeId, direction, portId) {
      const pos = posOf(nodeId);
      const offset = portOffsets.get(nodeId)?.[direction]?.[portId];
      const size = sizes.get(nodeId);
      if (offset) return { x: pos.x + offset.x, y: pos.y + offset.y };
      return { x: pos.x + (direction === 'out' ? size?.w || graphLib.DEFAULT_NODE_SIZE.w : 0), y: pos.y + FALLBACK_PORT_Y };
    }

    function portBase(nodeId, direction, portId) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const port = node && reg ? graphLib.findPort(reg, node, direction, portId) : null;
      return port ? graphLib.parseType(port.type)?.base || 'any' : 'any';
    }

    /* ---------- viewport ---------- */

    function applyViewport() {
      if (portTip) portTip.hide();
      world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
      let step = 24;
      while (step * viewport.zoom < 14) step *= 2;
      const size = step * viewport.zoom;
      container.style.backgroundSize = `${size}px ${size}px`;
      container.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
      container.style.setProperty('--nv-zoom', String(viewport.zoom));
      scheduleMinimap();
    }

    function setViewport(next, settings = {}) {
      viewport = { x: next.x, y: next.y, zoom: graphLib.clampZoom(next.zoom) };
      applyViewport();
      if (!settings.silent && opts.onViewportChange) opts.onViewportChange({ ...viewport });
    }

    function zoomBy(factor, cx, cy) {
      const size = containerSize();
      const px = cx ?? size.width / 2;
      const py = cy ?? size.height / 2;
      setViewport(graphLib.zoomAt(viewport, factor, px, py));
    }

    function setZoom(zoom, cx, cy) {
      const size = containerSize();
      setViewport(graphLib.zoomAt(viewport, zoom, cx ?? size.width / 2, cy ?? size.height / 2, true));
    }

    function fit(settings = {}) {
      const size = containerSize();
      const selectedAny = selection.nodes.size || selection.notes.size || selection.groups.size;
      const rect = graphLib.boundsOf(graph, sizes, settings.selectionOnly && selectedAny ? selection : undefined);
      if (!rect) {
        setViewport({ x: size.width / 2, y: size.height / 2, zoom: 1 });
        return;
      }
      setViewport(graphLib.fitViewport(rect, size.width, size.height, { padding: settings.padding ?? 72, maxZoom: settings.maxZoom ?? 1 }));
    }

    function centerOnWorld(x, y) {
      const size = containerSize();
      setViewport({ zoom: viewport.zoom, x: size.width / 2 - x * viewport.zoom, y: size.height / 2 - y * viewport.zoom });
    }

    /* ---------- measuring ---------- */

    function scheduleMeasure() {
      if (measureQueued || destroyed) return;
      measureQueued = true;
      requestAnimationFrame(() => {
        measureQueued = false;
        flushMeasure();
      });
    }

    function measureCard(id) {
      const state = cards.get(id);
      if (!state || !state.el.isConnected) return;
      const cardRect = state.el.getBoundingClientRect();
      const zoom = viewport.zoom || 1;
      const offsets = { in: {}, out: {} };
      for (const direction of ['in', 'out']) {
        for (const [portId, dot] of state.portEls[direction]) {
          const rect = dot.getBoundingClientRect();
          offsets[direction][portId] = { x: (rect.left + rect.width / 2 - cardRect.left) / zoom, y: (rect.top + rect.height / 2 - cardRect.top) / zoom };
        }
      }
      portOffsets.set(id, offsets);
      sizes.set(id, { w: state.el.offsetWidth, h: state.el.offsetHeight });
    }

    function flushMeasure() {
      if (!pendingMeasure.size) return;
      const ids = new Set(pendingMeasure);
      pendingMeasure.clear();
      for (const id of ids) measureCard(id);
      updateEdges(ids);
      scheduleMinimap();
    }

    /* ---------- order of the connections (row under a multi-input) ---------- */

    // A small preview of what a source hands over on one output: the first image of its latest result (the slot preview
    // painted by run.js), else, for an input node, the file it holds. Null while there is nothing to show.
    function thumbOf(sourceId, outPort) {
      const leaves = (value, out = []) => {
        if (!value || typeof value !== 'object') return out;
        if (Array.isArray(value)) value.forEach((item) => leaves(item, out));
        else if (value.type === 'list' && Array.isArray(value.items)) value.items.forEach((item) => leaves(item, out));
        else out.push(value);
        return out;
      };
      const image = (value) => leaves(value).find((item) => item.type === 'image' && typeof item.url === 'string') || null;
      const preview = slots.get(sourceId)?.preview;
      const fromResult = Array.isArray(preview) ? preview.find((item) => item.port === outPort) : null;
      let found = fromResult ? image(fromResult.value) : null;
      if (!found) {
        const node = graph.nodes.find((item) => item.id === sourceId);
        const def = node && reg ? reg.types.get(node.type) : null;
        if (def && def.category === 'input') {
          for (const param of def.params || []) {
            if (param.kind === 'asset' || param.kind === 'assets') found = found || image(node.params?.[param.id]);
          }
        }
      }
      return found ? ui.mediaUrl(found) : null;
    }

    // One row per multi-input of the node that has two or more connections, in the order the engine collects them.
    // The numbers are the ones on the edges (graphLib.connectionOrder): "…" behind the first list.
    function orderRowsFor(node, connected) {
      if (!reg || !connected || ![...connected.values()].some((count) => count > 1)) return [];
      const rows = [];
      for (const port of graphLib.portsFor(reg, node).inputs) {
        if (port.hidden || !port.multiple || (connected.get(port.id) || 0) < 2) continue;
        const edges = graphLib.incomingEdges(graph, node.id, port.id);
        const base = graphLib.parseType(port.type)?.base || 'any';
        const items = graphLib.connectionOrder(reg, graph, edges, true).map(({ edge, order, list, from, fromDef, outputs }) => {
          const custom = from && typeof from.title === 'string' ? from.title.trim() : '';
          const source = custom || (fromDef ? ui.typeLabel(fromDef) : from ? from.type : edge.from.node);
          return {
            edgeId: edge.id,
            order,
            text: geometry.orderText(order),
            list,
            title: source,
            source,
            output: outputs.length > 1 ? ui.portLabel(edge.from.port) : '',
            thumb: base === 'image' ? thumbOf(edge.from.node, edge.from.port) : null
          };
        });
        rows.push({ portId: port.id, label: ui.portLabel(port.id), base, items });
      }
      return rows;
    }

    function refreshOrder(nodeId, connected) {
      const state = cards.get(nodeId);
      const node = state && graph.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      const rows = orderRowsFor(node, connected || incomingMap().get(nodeId));
      if (rows.length || state.orderKey) ui.applyOrder(state, rows);
    }

    /* ---------- cards ---------- */

    // Map(nodeId -> Map(inputPortId -> edge count)) built in one pass over the edges.
    function incomingMap() {
      const all = new Map();
      for (const edge of graph.edges) {
        let ports = all.get(edge.to.node);
        if (!ports) {
          ports = new Map();
          all.set(edge.to.node, ports);
        }
        ports.set(edge.to.port, (ports.get(edge.to.port) || 0) + 1);
      }
      return all;
    }

    const cardContext = {
      get reg() {
        return reg;
      },
      onParam: (nodeId, paramId, value, meta) => opts.onParam && opts.onParam(nodeId, paramId, value, meta),
      onRename: (nodeId, title) => opts.onRename && opts.onRename(nodeId, title),
      onExtract: (nodeId, portId) => opts.onExtractPrompt && opts.onExtractPrompt(nodeId, portId),
      uploadFile: (nodeId, file, settings) => (opts.uploadFile ? opts.uploadFile(nodeId, file, settings) : Promise.reject(new Error('Upload unavailable')))
    };

    function positionCard(state, x, y) {
      state.el.style.transform = `translate(${x}px, ${y}px)`;
      state.x = x;
      state.y = y;
    }

    // Returns the ids of nodes whose card was created or moved (their edges need new geometry).
    function renderNodes() {
      const seen = new Set();
      const changed = new Set();
      const incoming = incomingMap();
      const none = new Map();
      for (const node of graph.nodes) {
        seen.add(node.id);
        let state = cards.get(node.id);
        const connected = incoming.get(node.id) || none;
        const connSig = connected.size ? JSON.stringify([...connected.entries()]) : '';
        if (!state) {
          state = ui.createCard(node, cardContext);
          cards.set(node.id, state);
          nodeLayer.append(state.el);
          if (resizeObserver) resizeObserver.observe(state.el);
          ui.updateCard(state, node, connected, cardContext);
          state.connSig = connSig;
          state.x = null;
          ui.applySlots(state, slots.get(node.id));
          pendingMeasure.add(node.id);
          changed.add(node.id);
        } else if (state.node !== node || state.connSig !== connSig) {
          const rebuilt = ui.updateCard(state, node, connected, cardContext);
          state.connSig = connSig;
          if (rebuilt) {
            pendingMeasure.add(node.id);
            changed.add(node.id);
          }
        }
        if (state.x !== node.x || state.y !== node.y) {
          positionCard(state, node.x, node.y);
          changed.add(node.id);
        }
        refreshOrder(node.id, connected);
      }
      for (const [id, state] of cards) {
        if (seen.has(id)) continue;
        if (resizeObserver) resizeObserver.unobserve(state.el);
        ui.disposeWidgets(state);
        state.el.remove();
        cards.delete(id);
        portOffsets.delete(id);
        sizes.delete(id);
      }
      scheduleMeasure();
      return changed;
    }

    /* ---------- notes and groups ---------- */

    function renderNotes() {
      const seen = new Set();
      for (const note of graph.notes) {
        seen.add(note.id);
        let entry = noteEls.get(note.id);
        if (!entry) {
          const root = el('div', { class: 'nv-note', dataset: { id: note.id } });
          const head = el('div', { class: 'nv-note-head' }, ui.icon('note', 13), el('span', { text: ui.T('nodes.note.title') }));
          const area = el('textarea', { class: 'nv-note-text nv-nodrag', placeholder: ui.T('nodes.note.placeholder'), 'aria-label': ui.T('nodes.note.title'), spellcheck: 'false' });
          const handle = el('div', { class: 'nv-note-resize', title: ui.T('nodes.canvas.resize') });
          root.append(head, area, handle);
          area.addEventListener('input', () => opts.onNoteChange && opts.onNoteChange(note.id, { text: area.value }, { commit: false }));
          area.addEventListener('change', () => opts.onNoteChange && opts.onNoteChange(note.id, { text: area.value }, { commit: true }));
          area.addEventListener('wheel', (event) => {
            if (area.scrollHeight > area.clientHeight && !event.ctrlKey && !event.metaKey) event.stopPropagation();
          });
          entry = { el: root, area, note: null };
          noteEls.set(note.id, entry);
          noteLayer.append(root);
        }
        if (entry.note !== note) {
          entry.note = note;
          entry.el.style.width = `${note.w}px`;
          entry.el.style.height = `${note.h}px`;
          if (document.activeElement !== entry.area && entry.area.value !== note.text) entry.area.value = note.text;
        }
        const pos = dragPositions?.[note.id] || note;
        entry.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      }
      for (const [id, entry] of noteEls) {
        if (!seen.has(id)) {
          entry.el.remove();
          noteEls.delete(id);
        }
      }
    }

    function renderGroups() {
      const seen = new Set();
      for (const group of graph.groups) {
        seen.add(group.id);
        let entry = groupEls.get(group.id);
        if (!entry) {
          const root = el('div', { class: 'nv-group', dataset: { id: group.id } });
          const bar = el('div', { class: 'nv-group-bar' });
          const title = el('span', { class: 'nv-group-title' });
          bar.append(ui.icon('group', 13), title);
          const handle = el('div', { class: 'nv-group-resize', title: ui.T('nodes.canvas.resize') });
          root.append(bar, handle);
          title.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            const current = groupEls.get(group.id)?.group;
            ui.inlineEdit(title, current?.title || '', (value) => opts.onGroupChange && opts.onGroupChange(group.id, { title: value }, { commit: true }), { label: ui.T('nodes.group.title') });
          });
          entry = { el: root, title, group: null };
          groupEls.set(group.id, entry);
          groupLayer.append(root);
        }
        if (entry.group !== group) {
          entry.group = group;
          entry.el.style.width = `${group.w}px`;
          entry.el.style.height = `${group.h}px`;
          entry.el.dataset.color = group.color || 'amber';
          entry.title.textContent = group.title || ui.T('nodes.group.untitled');
          entry.title.classList.toggle('is-placeholder', !group.title);
        }
        const pos = dragPositions?.[group.id] || group;
        entry.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      }
      for (const [id, entry] of groupEls) {
        if (!seen.has(id)) {
          entry.el.remove();
          groupEls.delete(id);
        }
      }
    }

    /* ---------- edges ---------- */

    function scheduleEdges() {
      if (edgesQueued || destroyed) return;
      edgesQueued = true;
      requestAnimationFrame(() => {
        edgesQueued = false;
        updateEdges(null);
      });
    }

    function edgePath(edge) {
      const a = portPoint(edge.from.node, 'out', edge.from.port);
      const b = portPoint(edge.to.node, 'in', edge.to.port);
      return { a, b, d: bezier(a, b) };
    }

    // Recomputes edge geometry. affected = Set of node ids whose edges need updating (null = all).
    // The number badges of a multi-input are placed together (geometry.placeBadges): each on its own curve, moved back
    // until it covers no other badge of the input. The number is the position the engine hands the connection over at
    // (graphLib.connectionOrder, the same logic as the port tooltip): "…" behind the first list, none for a single edge.
    function updateEdges(affected) {
      const seen = new Set();
      const nodes = nodeMap();
      const byInput = new Map();
      for (const edge of graph.edges) {
        const key = `${edge.to.node}.${edge.to.port}`;
        if (!byInput.has(key)) byInput.set(key, []);
        byInput.get(key).push(edge);
      }
      const touched = (edge) => {
        const entry = edgeEls.get(edge.id);
        return !affected || affected.has(edge.from.node) || affected.has(edge.to.node) || !entry || entry.edge !== edge;
      };
      // edge id -> { x, y, text } for the edges that get a badge. An input is placed again when one of its edges moved or
      // when its connections changed (an edge added, removed or reordered).
      const badges = new Map();
      for (const list of byInput.values()) {
        const signature = list.map((edge) => edge.id).join(',');
        if (list.length < 2 || !(list.some(touched) || list.some((edge) => edgeEls.get(edge.id)?.signature !== signature))) continue;
        const toNode = nodes.get(list[0].to.node);
        const toPort = toNode && reg ? graphLib.findPort(reg, toNode, 'in', list[0].to.port) : null;
        if (!toPort?.multiple) continue;
        const paths = list.map((edge) => edgePath(edge));
        const spots = geometry.placeBadges(paths.map(({ a, b }) => ({ a, b })));
        const order = graphLib.connectionOrder(reg, graph, list, true);
        list.forEach((edge, index) => badges.set(edge.id, { x: spots[index].x, y: spots[index].y, text: geometry.orderText(order[index].order), list: order[index].list }));
      }
      for (const edge of graph.edges) {
        seen.add(edge.id);
        let entry = edgeEls.get(edge.id);
        const fromBase = portBase(edge.from.node, 'out', edge.from.port);
        if (!entry) {
          const group = svgEl('g', { class: 'nv-edge', 'data-id': edge.id });
          const hit = svgEl('path', { class: 'nv-edge-hit' });
          const line = svgEl('path', { class: 'nv-edge-line' });
          const badge = svgEl('g', { class: 'nv-edge-badge' });
          badge.append(svgEl('circle', { r: geometry.BADGE_RADIUS }), svgEl('text', { 'text-anchor': 'middle', dy: '3.5' }));
          group.append(hit, line, badge);
          edgeGroup.append(group);
          entry = { group, hit, line, badge, base: null, edge: null };
          edgeEls.set(edge.id, entry);
        }
        const touches = touched(edge);
        const input = byInput.get(`${edge.to.node}.${edge.to.port}`);
        const signature = input.length < 2 ? '' : input.map((item) => item.id).join(',');
        const regroup = entry.signature !== signature;
        entry.signature = signature;
        entry.edge = edge;
        if (entry.base !== fromBase) {
          entry.base = fromBase;
          entry.line.setAttribute('style', `stroke: var(--nv-port-${fromBase}, var(--nv-port-any))`);
          entry.badge.setAttribute('style', `--edge-color: var(--nv-port-${fromBase}, var(--nv-port-any))`);
        }
        if (touches) {
          const { d } = edgePath(edge);
          entry.hit.setAttribute('d', d);
          entry.line.setAttribute('d', d);
        }
        if (touches || regroup || badges.has(edge.id)) {
          const spot = badges.get(edge.id);
          entry.badge.style.display = spot ? '' : 'none';
          if (spot) {
            entry.badge.setAttribute('transform', `translate(${spot.x} ${spot.y})`);
            entry.badge.querySelector('text').textContent = spot.text;
            entry.badge.classList.toggle('is-list', spot.list);
          }
        }
        entry.group.classList.toggle('is-selected', selection.edge === edge.id);
        entry.group.classList.toggle('is-detaching', Boolean(drag && drag.type === 'edge' && drag.edgeId === edge.id));
      }
      for (const [id, entry] of edgeEls) {
        if (!seen.has(id)) {
          entry.group.remove();
          edgeEls.delete(id);
        }
      }
      paintActiveEdges();
    }

    function paintActiveEdges() {
      const active = selection.nodes;
      for (const entry of edgeEls.values()) {
        const edge = entry.edge;
        entry.group.classList.toggle('is-active', Boolean(edge) && (active.has(edge.from.node) || active.has(edge.to.node)));
      }
    }

    /* ---------- selection ---------- */

    function selectionSnapshot() {
      return { nodes: new Set(selection.nodes), notes: new Set(selection.notes), groups: new Set(selection.groups), edge: selection.edge };
    }

    function sameSelection(a, b) {
      const same = (x, y) => x.size === y.size && [...x].every((id) => y.has(id));
      return same(a.nodes, b.nodes) && same(a.notes, b.notes) && same(a.groups, b.groups) && a.edge === b.edge;
    }

    function paintSelection() {
      for (const [id, state] of cards) state.el.classList.toggle('is-selected', selection.nodes.has(id));
      for (const [id, entry] of noteEls) entry.el.classList.toggle('is-selected', selection.notes.has(id));
      for (const [id, entry] of groupEls) entry.el.classList.toggle('is-selected', selection.groups.has(id));
      for (const [id, entry] of edgeEls) entry.group.classList.toggle('is-selected', selection.edge === id);
      paintActiveEdges();
      scheduleMinimap();
    }

    function setSelection(next, settings = {}) {
      const value = {
        nodes: new Set(next?.nodes || []),
        notes: new Set(next?.notes || []),
        groups: new Set(next?.groups || []),
        edge: next?.edge || null
      };
      if (sameSelection(selection, value)) return;
      selection = value;
      paintSelection();
      if (!settings.silent && opts.onSelectionChange) opts.onSelectionChange(selectionSnapshot());
    }

    function selectionCount() {
      return selection.nodes.size + selection.notes.size + selection.groups.size;
    }

    /* ---------- render ---------- */

    function render(nextGraph, settings = {}) {
      if (portTip) portTip.hide();
      graph = nextGraph;
      if (settings.selection) selection = { ...settings.selection, edge: settings.selection.edge || null };
      // drop selection entries that vanished
      const nodeIds = new Set(graph.nodes.map((n) => n.id));
      const noteIds = new Set(graph.notes.map((n) => n.id));
      const groupIds = new Set(graph.groups.map((g) => g.id));
      const edgeIds = new Set(graph.edges.map((e) => e.id));
      let pruned = false;
      const prune = (set, ids) => {
        for (const id of [...set]) {
          if (!ids.has(id)) {
            set.delete(id);
            pruned = true;
          }
        }
      };
      prune(selection.nodes, nodeIds);
      prune(selection.notes, noteIds);
      prune(selection.groups, groupIds);
      if (selection.edge && !edgeIds.has(selection.edge)) {
        selection.edge = null;
        pruned = true;
      }
      renderGroups();
      renderNotes();
      const changedNodes = renderNodes();
      updateEdges(changedNodes);
      paintSelection();
      if (pruned && opts.onSelectionChange) opts.onSelectionChange(selectionSnapshot());
      scheduleMinimap();
    }

    /* ---------- slots (status / preview / cost) ---------- */

    function setSlot(nodeId, patch) {
      const next = { ...(slots.get(nodeId) || {}), ...patch };
      if (patch.preview !== undefined) next.previewKey = JSON.stringify(patch.preview);
      slots.set(nodeId, next);
      const state = cards.get(nodeId);
      if (state) {
        ui.applySlots(state, next);
        pendingMeasure.add(nodeId);
        scheduleMeasure();
      }
      // a new result changes the previews in the order row of the nodes this one feeds
      if (patch.preview !== undefined) {
        const fed = new Set(graph.edges.filter((edge) => edge.from.node === nodeId).map((edge) => edge.to.node));
        for (const id of fed) refreshOrder(id);
      }
    }

    function clearSlots(nodeId) {
      if (nodeId) slots.delete(nodeId);
      else slots.clear();
      for (const [id, state] of cards) {
        if (!nodeId || id === nodeId) ui.applySlots(state, slots.get(id));
      }
      for (const id of cards.keys()) refreshOrder(id);
      scheduleMeasure();
    }

    /* ---------- pointer interactions ---------- */

    const INTERACTIVE = 'input, textarea, select, button, video, audio, a, .nv-nodrag, .nv-inline-input, [contenteditable="true"]';

    function isPanGesture(event) {
      return event.button === 1 || (event.button === 0 && (tool === 'hand' || spaceDown));
    }

    function updateCursorClass() {
      container.classList.toggle('tool-hand', tool === 'hand' || spaceDown);
    }

    function itemAt(target) {
      const card = target.closest('.nv-node');
      if (card) return { kind: 'node', id: card.dataset.id, el: card };
      const note = target.closest('.nv-note');
      if (note) return { kind: 'note', id: note.dataset.id, el: note };
      const group = target.closest('.nv-group');
      if (group) return { kind: 'group', id: group.dataset.id, el: group };
      return null;
    }

    function selectOnPress(kind, id, shift) {
      const key = kind === 'node' ? 'nodes' : kind === 'note' ? 'notes' : 'groups';
      const has = selection[key].has(id);
      if (!has) {
        const next = shift ? selectionSnapshot() : emptySelection();
        next[key].add(id);
        next.edge = null;
        setSelection(next);
      } else if (selection.edge) {
        setSelection({ nodes: selection.nodes, notes: selection.notes, groups: selection.groups, edge: null });
      }
      return has;
    }

    function collectMoveItems(pressedKind, pressedId) {
      const positions = {};
      const kinds = {};
      const add = (kind, id, x, y) => {
        if (positions[id]) return;
        positions[id] = { x, y };
        kinds[id] = kind;
      };
      const nodes = nodeMap();
      for (const id of selection.nodes) {
        const node = nodes.get(id);
        if (node) add('node', id, node.x, node.y);
      }
      for (const id of selection.notes) {
        const note = graph.notes.find((n) => n.id === id);
        if (note) add('note', id, note.x, note.y);
      }
      for (const id of selection.groups) {
        const group = graph.groups.find((g) => g.id === id);
        if (!group) continue;
        add('group', id, group.x, group.y);
        const members = graphLib.membersOfGroup(graph, sizes, group);
        for (const memberId of members.nodes) {
          const node = nodes.get(memberId);
          if (node) add('node', memberId, node.x, node.y);
        }
        for (const memberId of members.notes) {
          const note = graph.notes.find((n) => n.id === memberId);
          if (note) add('note', memberId, note.x, note.y);
        }
      }
      return { positions, kinds, primary: positions[pressedId] ? pressedId : Object.keys(positions)[0], pressedKind };
    }

    function applyDragPositions(positions, kinds) {
      dragPositions = dragPositions || {};
      const moved = new Set();
      for (const [id, pos] of Object.entries(positions)) {
        dragPositions[id] = pos;
        const kind = kinds[id];
        if (kind === 'node') {
          const state = cards.get(id);
          if (state) positionCard(state, pos.x, pos.y);
          moved.add(id);
        } else if (kind === 'note') {
          const entry = noteEls.get(id);
          if (entry) entry.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        } else if (kind === 'group') {
          const entry = groupEls.get(id);
          if (entry) entry.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        }
      }
      if (moved.size) updateEdges(moved);
      scheduleMinimap();
    }

    function beginEdgeDrag(portEl, event) {
      const card = portEl.closest('.nv-node');
      if (!card || !reg) return;
      const nodeId = card.dataset.id;
      const direction = portEl.dataset.dir;
      const portId = portEl.dataset.port;
      let anchor = { dir: direction, node: nodeId, port: portId };
      let edgeId = null;
      if (direction === 'in') {
        const incoming = graph.edges.filter((edge) => edge.to.node === nodeId && edge.to.port === portId);
        if (incoming.length) {
          const edge = incoming[incoming.length - 1];
          edgeId = edge.id;
          anchor = { dir: 'out', node: edge.from.node, port: edge.from.port };
        }
      }
      const node = graph.nodes.find((n) => n.id === anchor.node);
      const port = node ? graphLib.findPort(reg, node, anchor.dir, anchor.port) : null;
      if (!port) return;
      const baseGraph = edgeId ? graphLib.disconnect(graph, edgeId) : graph;
      const blocked = anchor.dir === 'out' ? graphLib.ancestors(baseGraph, [anchor.node]) : graphLib.descendants(baseGraph, [anchor.node]);
      blocked.add(anchor.node);
      drag = {
        type: 'edge',
        anchor,
        edgeId,
        originalTo: edgeId ? { node: nodeId, port: portId } : null,
        portType: port.type,
        portMultiple: anchor.dir === 'in' && port.multiple === true,
        blocked,
        baseGraph,
        started: false,
        startX: event.clientX,
        startY: event.clientY,
        ghost: svgEl('path', { class: 'nv-edge-ghost-line' })
      };
      ghostGroup.append(drag.ghost);
      const base = graphLib.parseType(port.type)?.base || 'any';
      drag.ghost.setAttribute('style', `stroke: var(--nv-port-${base}, var(--nv-port-any))`);
      updateGhost(event);
    }

    function markConnectable(active) {
      container.classList.toggle('is-connecting', active);
      for (const [id, state] of cards) {
        for (const direction of ['in', 'out']) {
          for (const [portId, dot] of state.portEls[direction]) {
            dot.classList.remove('is-ok', 'is-no');
            if (!active || !drag) continue;
            if (direction === drag.anchor.dir) {
              dot.classList.add('is-no');
              continue;
            }
            const ok = id !== drag.anchor.node && !drag.blocked.has(id) && canConnectPort(id, direction, portId) && !atModelLimit(id, direction, portId);
            dot.classList.add(ok ? 'is-ok' : 'is-no');
          }
        }
      }
    }

    // An input that already has as many connections as the chosen model takes is not offered as a target.
    function atModelLimit(nodeId, direction, portId) {
      if (direction !== 'in') return false;
      const node = graph.nodes.find((n) => n.id === nodeId);
      const port = node ? graphLib.findPort(reg, node, 'in', portId) : null;
      if (!port || !port.multiple || !port.limit || !port.limit.known) return false;
      // the graph without the connection that is being moved: its own input is free for it again
      return graphLib.incomingEdges((drag && drag.baseGraph) || graph, nodeId, portId).length >= port.max;
    }

    function canConnectPort(nodeId, direction, portId) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const port = node ? graphLib.findPort(reg, node, direction, portId) : null;
      if (!port || port.hidden) return false;
      return drag.anchor.dir === 'out' ? graphLib.canConnectTypes(reg, drag.portType, port.type) : graphLib.canConnectTypes(reg, port.type, drag.portType);
    }

    function updateGhost(event) {
      if (!drag || drag.type !== 'edge') return;
      const cursor = clientToWorld(event.clientX, event.clientY);
      const anchorPoint = portPoint(drag.anchor.node, drag.anchor.dir, drag.anchor.port);
      drag.ghost.setAttribute('d', drag.anchor.dir === 'out' ? bezier(anchorPoint, cursor) : bezier(cursor, anchorPoint));
    }

    function resolveDropTarget(event) {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (!under || !container.contains(under)) return { kind: 'empty' };
      const wantDir = drag.anchor.dir === 'out' ? 'in' : 'out';
      const portEl = under.closest('.nv-port');
      if (portEl && portEl.dataset.dir === wantDir) {
        return { kind: 'port', node: portEl.closest('.nv-node').dataset.id, port: portEl.dataset.port };
      }
      if (portEl) return { kind: 'refused', code: 'same_side' };
      const card = under.closest('.nv-node');
      if (card) {
        const node = graph.nodes.find((n) => n.id === card.dataset.id);
        if (!node || node.id === drag.anchor.node) return { kind: 'refused', code: 'same_node' };
        const port = graphLib.firstCompatiblePort(reg, node, drag.anchor.dir, drag.portType);
        if (port) return { kind: 'port', node: node.id, port: port.id };
        return { kind: 'refused', code: 'incompatible' };
      }
      if (under.closest('.nv-note, .nv-group-bar')) return { kind: 'refused', code: 'none' };
      return { kind: 'empty' };
    }

    function finishEdgeDrag(event) {
      const info = drag;
      const target = info.started ? resolveDropTarget(event) : null;
      ghostGroup.textContent = '';
      markConnectable(false);
      drag = null;
      updateEdges(null);
      if (limitsPending) setTimeout(() => limitsPending && refreshLimits(), 0);
      if (!info.started) return;
      const anchor = info.anchor;
      if (target.kind === 'port') {
        const from = anchor.dir === 'out' ? { node: anchor.node, port: anchor.port } : { node: target.node, port: target.port };
        const to = anchor.dir === 'out' ? { node: target.node, port: target.port } : { node: anchor.node, port: anchor.port };
        if (info.edgeId && info.originalTo && info.originalTo.node === to.node && info.originalTo.port === to.port) return;
        const error = graphLib.checkConnection(reg, info.baseGraph, from, to);
        if (error) {
          // the whole error: over the limit of a model it carries the model and the limit for the text
          if (opts.onConnectRefused) opts.onConnectRefused(error);
          return;
        }
        if (opts.onConnect) opts.onConnect(from, to, { replaceEdge: info.edgeId });
        return;
      }
      if (target.kind === 'refused') {
        if (opts.onConnectRefused) opts.onConnectRefused(target.code);
        return;
      }
      // Dropped on empty canvas
      if (info.edgeId) {
        if (opts.onDetach) opts.onDetach(info.edgeId);
        return;
      }
      if (opts.onDropEmpty) {
        opts.onDropEmpty({ anchor, portType: info.portType, portMultiple: info.portMultiple, world: clientToWorld(event.clientX, event.clientY), client: { x: event.clientX, y: event.clientY } });
      }
    }

    function onPointerDown(event) {
      if (event.pointerType === 'mouse' && ![0, 1].includes(event.button)) return;
      lastPointer = { x: event.clientX, y: event.clientY };
      ui.closeMenu();
      if (event.button === 0 && !isPanGesture(event)) {
        const portEl = event.target.closest('.nv-port');
        if (portEl) {
          event.preventDefault();
          container.setPointerCapture(event.pointerId);
          beginEdgeDrag(portEl, event);
          return;
        }
      }
      const item = itemAt(event.target);
      const interactive = event.target.closest(INTERACTIVE);
      if (interactive && !isPanGesture(event)) {
        // Focus lands in a field: select its node but never start a drag.
        if (item && item.kind === 'node') selectOnPress('node', item.id, event.shiftKey);
        else if (item && item.kind === 'note') selectOnPress('note', item.id, event.shiftKey);
        return;
      }
      if (isPanGesture(event)) {
        event.preventDefault();
        container.setPointerCapture(event.pointerId);
        drag = { type: 'pan', startX: event.clientX, startY: event.clientY, origin: { ...viewport } };
        container.classList.add('is-panning');
        return;
      }
      if (event.button !== 0) return;
      const edgeHit = event.target.closest('.nv-edge-hit');
      if (edgeHit) {
        const edgeId = edgeHit.parentNode.getAttribute('data-id');
        setSelection({ nodes: [], notes: [], groups: [], edge: edgeId });
        container.focus({ preventScroll: true });
        return;
      }
      container.focus({ preventScroll: true });
      if (item) {
        const resizeHandle = event.target.closest('.nv-note-resize, .nv-group-resize');
        if (resizeHandle && (item.kind === 'note' || item.kind === 'group')) {
          event.preventDefault();
          container.setPointerCapture(event.pointerId);
          selectOnPress(item.kind, item.id, false);
          const source = item.kind === 'note' ? graph.notes.find((n) => n.id === item.id) : graph.groups.find((g) => g.id === item.id);
          drag = { type: 'resize', kind: item.kind, id: item.id, startX: event.clientX, startY: event.clientY, w: source.w, h: source.h, moved: false };
          return;
        }
        if (item.kind === 'group' && !event.target.closest('.nv-group-bar')) {
          // The frame body lets clicks through to the canvas (marquee).
        } else {
          event.preventDefault();
          container.setPointerCapture(event.pointerId);
          const wasSelected = selectOnPress(item.kind, item.id, event.shiftKey);
          drag = {
            type: 'move',
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            pressed: item,
            shift: event.shiftKey,
            wasSelected,
            items: null
          };
          return;
        }
      }
      // Empty canvas: marquee (or a plain click that clears the selection).
      event.preventDefault();
      container.setPointerCapture(event.pointerId);
      const rect = rectOfContainer();
      drag = {
        type: 'marquee',
        startX: event.clientX,
        startY: event.clientY,
        localX: event.clientX - rect.left,
        localY: event.clientY - rect.top,
        base: event.shiftKey ? selectionSnapshot() : emptySelection(),
        moved: false
      };
    }

    function onPointerMove(event) {
      lastPointer = { x: event.clientX, y: event.clientY };
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.type === 'pan') {
        setViewport({ x: drag.origin.x + dx, y: drag.origin.y + dy, zoom: viewport.zoom });
        return;
      }
      if (drag.type === 'edge') {
        if (!drag.started && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          drag.started = true;
          markConnectable(true);
          updateEdges(null);
        }
        if (drag.started) {
          updateGhost(event);
          const under = document.elementFromPoint(event.clientX, event.clientY);
          for (const dot of container.querySelectorAll('.nv-port.is-hover')) dot.classList.remove('is-hover');
          const portEl = under && under.closest ? under.closest('.nv-port') : null;
          if (portEl && portEl.classList.contains('is-ok')) portEl.classList.add('is-hover');
        }
        return;
      }
      if (drag.type === 'marquee') {
        if (!drag.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        drag.moved = true;
        const rect = rectOfContainer();
        const x1 = Math.min(drag.localX, event.clientX - rect.left);
        const y1 = Math.min(drag.localY, event.clientY - rect.top);
        const x2 = Math.max(drag.localX, event.clientX - rect.left);
        const y2 = Math.max(drag.localY, event.clientY - rect.top);
        marquee.classList.remove('hidden');
        marquee.style.left = `${x1}px`;
        marquee.style.top = `${y1}px`;
        marquee.style.width = `${x2 - x1}px`;
        marquee.style.height = `${y2 - y1}px`;
        const a = graphLib.screenToWorld(viewport, x1, y1);
        const b = graphLib.screenToWorld(viewport, x2, y2);
        const hit = graphLib.itemsInRect(graph, sizes, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
        setSelection({
          nodes: [...drag.base.nodes, ...hit.nodes],
          notes: [...drag.base.notes, ...hit.notes],
          groups: [...drag.base.groups, ...hit.groups],
          edge: null
        });
        return;
      }
      if (drag.type === 'move') {
        if (!drag.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        if (!drag.moved) {
          drag.moved = true;
          drag.items = collectMoveItems(drag.pressed.kind, drag.pressed.id);
          container.classList.add('is-dragging');
        }
        const { positions, kinds, primary } = drag.items;
        let wx = dx / viewport.zoom;
        let wy = dy / viewport.zoom;
        if (!event.altKey && primary) {
          const origin = positions[primary];
          wx = graphLib.snap(origin.x + wx, GRID) - origin.x;
          wy = graphLib.snap(origin.y + wy, GRID) - origin.y;
        }
        const next = {};
        for (const [id, origin] of Object.entries(positions)) next[id] = { x: origin.x + wx, y: origin.y + wy };
        applyDragPositions(next, kinds);
        return;
      }
      if (drag.type === 'resize') {
        drag.moved = true;
        const w = Math.max(120, graphLib.snap(drag.w + dx / viewport.zoom, GRID));
        const h = Math.max(80, graphLib.snap(drag.h + dy / viewport.zoom, GRID));
        drag.next = { w, h };
        const entry = drag.kind === 'note' ? noteEls.get(drag.id) : groupEls.get(drag.id);
        if (entry) {
          entry.el.style.width = `${w}px`;
          entry.el.style.height = `${h}px`;
        }
        scheduleMinimap();
      }
    }

    function onPointerUp(event) {
      if (!drag) return;
      const info = drag;
      try {
        container.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* not captured */
      }
      if (info.type === 'pan') {
        drag = null;
        container.classList.remove('is-panning');
        return;
      }
      if (info.type === 'edge') {
        finishEdgeDrag(event);
        return;
      }
      drag = null;
      if (info.type === 'marquee') {
        marquee.classList.add('hidden');
        if (!info.moved) {
          if (!info.base.nodes.size && !info.base.notes.size && !info.base.groups.size) setSelection(emptySelection());
        }
        return;
      }
      if (info.type === 'move') {
        container.classList.remove('is-dragging');
        if (!info.moved) {
          // Plain click on an already selected item: narrow the selection (or toggle with shift).
          const key = info.pressed.kind === 'node' ? 'nodes' : info.pressed.kind === 'note' ? 'notes' : 'groups';
          if (info.wasSelected && info.shift) {
            const next = selectionSnapshot();
            next[key].delete(info.pressed.id);
            setSelection(next);
          } else if (info.wasSelected && !info.shift && selectionCount() > 1) {
            const next = emptySelection();
            next[key].add(info.pressed.id);
            setSelection(next);
          }
          return;
        }
        const positions = dragPositions || {};
        dragPositions = null;
        if (opts.onMoveEnd) opts.onMoveEnd(positions);
        return;
      }
      if (info.type === 'resize') {
        if (info.next) {
          if (info.kind === 'note' && opts.onNoteChange) opts.onNoteChange(info.id, info.next, { commit: true });
          if (info.kind === 'group' && opts.onGroupChange) opts.onGroupChange(info.id, info.next, { commit: true });
        }
      }
    }

    function onPointerCancel(event) {
      if (!drag) return;
      const info = drag;
      drag = null;
      ghostGroup.textContent = '';
      marquee.classList.add('hidden');
      container.classList.remove('is-panning', 'is-dragging');
      markConnectable(false);
      if (info.type === 'move' && info.moved) {
        const positions = dragPositions || {};
        dragPositions = null;
        if (opts.onMoveEnd) opts.onMoveEnd(positions);
      }
      dragPositions = null;
      void event;
    }

    function onWheel(event) {
      // Let scrollable fields (textareas, notes, text previews) scroll on their own.
      const scroller = event.target.closest && event.target.closest('textarea, .nv-scroll');
      if (scroller && !event.ctrlKey && !event.metaKey && scroller.scrollHeight > scroller.clientHeight + 1) return;
      event.preventDefault();
      const rect = rectOfContainer();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      if (event.ctrlKey || event.metaKey) {
        const raw = event.deltaY * scale;
        const pinch = event.ctrlKey && !event.metaKey && Math.abs(raw) < 30;
        const delta = Math.max(-60, Math.min(60, raw));
        const factor = Math.exp(-delta * (pinch ? 0.01 : 0.004));
        zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      setViewport({ x: viewport.x - event.deltaX * scale, y: viewport.y - event.deltaY * scale, zoom: viewport.zoom });
    }

    function onContextMenu(event) {
      const item = itemAt(event.target);
      const edgeHit = event.target.closest('.nv-edge-hit');
      if (event.target.closest('input, textarea') && !item) return;
      event.preventDefault();
      if (!opts.onContextMenu) return;
      const world = clientToWorld(event.clientX, event.clientY);
      if (edgeHit) {
        const edgeId = edgeHit.parentNode.getAttribute('data-id');
        setSelection({ nodes: [], notes: [], groups: [], edge: edgeId });
        opts.onContextMenu({ kind: 'edge', id: edgeId, clientX: event.clientX, clientY: event.clientY, world });
        return;
      }
      if (item) {
        if (item.kind === 'group' && !event.target.closest('.nv-group-bar')) {
          opts.onContextMenu({ kind: 'canvas', clientX: event.clientX, clientY: event.clientY, world });
          return;
        }
        const key = item.kind === 'node' ? 'nodes' : item.kind === 'note' ? 'notes' : 'groups';
        if (!selection[key].has(item.id)) {
          const next = emptySelection();
          next[key].add(item.id);
          setSelection(next);
        }
        opts.onContextMenu({ kind: item.kind, id: item.id, clientX: event.clientX, clientY: event.clientY, world });
        return;
      }
      opts.onContextMenu({ kind: 'canvas', clientX: event.clientX, clientY: event.clientY, world });
    }

    function onDoubleClick(event) {
      // Pointer capture on the container retargets the click sequence to it: hand the event back to the element under the cursor.
      if (event.target === container) {
        const under = document.elementFromPoint(event.clientX, event.clientY);
        if (under && under !== container && container.contains(under)) {
          under.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, view: window }));
          return;
        }
      }
      if (event.target.closest(INTERACTIVE) || event.target.closest('.nv-node, .nv-note, .nv-group-bar, .nv-edge-hit')) return;
      if (opts.onCanvasDoubleClick) opts.onCanvasDoubleClick({ world: clientToWorld(event.clientX, event.clientY), client: { x: event.clientX, y: event.clientY } });
    }

    function hasFiles(event) {
      return Array.from(event.dataTransfer?.types || []).includes('Files');
    }

    function onDragOver(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      container.classList.add('is-file-drop');
    }

    function onDrop(event) {
      container.classList.remove('is-file-drop');
      if (!hasFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length && opts.onFilesDropped) opts.onFilesDropped(files, clientToWorld(event.clientX, event.clientY));
    }

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('dblclick', onDoubleClick);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', (event) => {
      if (!container.contains(event.relatedTarget)) container.classList.remove('is-file-drop');
    });
    container.addEventListener('drop', onDrop);
    container.addEventListener('pointerleave', () => container.classList.remove('is-file-drop'));
    // Prevent the browser's native drag of images / links inside cards from starting.
    container.addEventListener('dragstart', (event) => {
      if (event.target.closest('.nv-node, .nv-note')) event.preventDefault();
    });

    /* ---------- minimap ---------- */

    const minimapHost = opts.minimap || null;
    let minimapCanvas = null;
    let minimapMap = null;
    const colorCache = new Map();

    function categoryColor(category) {
      if (!colorCache.has(category)) {
        const value = getComputedStyle(container).getPropertyValue(`--nv-cat-${category}`).trim();
        colorCache.set(category, value || '#9aa1ab');
      }
      return colorCache.get(category);
    }

    if (minimapHost) {
      minimapCanvas = el('canvas', { class: 'nv-minimap-canvas', width: MINIMAP_W * 2, height: MINIMAP_H * 2, 'aria-label': ui.T('nodes.canvas.minimap') });
      minimapHost.append(minimapCanvas);
      let dragging = false;
      const navigate = (event) => {
        if (!minimapMap) return;
        const rect = minimapCanvas.getBoundingClientRect();
        const mx = ((event.clientX - rect.left) / rect.width) * MINIMAP_W;
        const my = ((event.clientY - rect.top) / rect.height) * MINIMAP_H;
        centerOnWorld((mx - minimapMap.ox) / minimapMap.scale, (my - minimapMap.oy) / minimapMap.scale);
      };
      minimapCanvas.addEventListener('pointerdown', (event) => {
        dragging = true;
        minimapCanvas.setPointerCapture(event.pointerId);
        navigate(event);
        event.stopPropagation();
      });
      minimapCanvas.addEventListener('pointermove', (event) => {
        if (dragging) navigate(event);
      });
      const stop = (event) => {
        dragging = false;
        try {
          minimapCanvas.releasePointerCapture(event.pointerId);
        } catch (_) {
          /* not captured */
        }
      };
      minimapCanvas.addEventListener('pointerup', stop);
      minimapCanvas.addEventListener('pointercancel', stop);
      minimapCanvas.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    }

    function scheduleMinimap() {
      if (!minimapCanvas || minimapQueued || destroyed) return;
      minimapQueued = true;
      requestAnimationFrame(() => {
        minimapQueued = false;
        drawMinimap();
      });
    }

    function drawMinimap() {
      if (!minimapCanvas) return;
      const ctx2d = minimapCanvas.getContext('2d');
      const width = MINIMAP_W;
      const height = MINIMAP_H;
      ctx2d.setTransform(2, 0, 0, 2, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      const size = containerSize();
      const view = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, w: size.width / viewport.zoom, h: size.height / viewport.zoom };
      const content = graphLib.boundsOf(graph, sizes);
      const union = graphLib.unionRect(content ? [content, view] : [view]);
      const pad = 40;
      const scale = Math.min((width - 12) / (union.w + pad * 2), (height - 12) / (union.h + pad * 2));
      const ox = (width - union.w * scale) / 2 - union.x * scale;
      const oy = (height - union.h * scale) / 2 - union.y * scale;
      minimapMap = { scale, ox, oy };
      const px = (x) => x * scale + ox;
      const py = (y) => y * scale + oy;
      for (const group of graph.groups) {
        const pos = dragPositions?.[group.id] || group;
        ctx2d.fillStyle = 'rgba(216,162,95,0.10)';
        ctx2d.fillRect(px(pos.x), py(pos.y), group.w * scale, group.h * scale);
      }
      for (const note of graph.notes) {
        const pos = dragPositions?.[note.id] || note;
        ctx2d.fillStyle = 'rgba(229,192,123,0.35)';
        ctx2d.fillRect(px(pos.x), py(pos.y), note.w * scale, note.h * scale);
      }
      ctx2d.lineWidth = 0.8;
      for (const edge of graph.edges) {
        const a = portPoint(edge.from.node, 'out', edge.from.port);
        const b = portPoint(edge.to.node, 'in', edge.to.port);
        ctx2d.strokeStyle = 'rgba(154,161,171,0.45)';
        ctx2d.beginPath();
        ctx2d.moveTo(px(a.x), py(a.y));
        ctx2d.lineTo(px(b.x), py(b.y));
        ctx2d.stroke();
      }
      const defs = reg ? reg.types : new Map();
      for (const node of graph.nodes) {
        const pos = posOf(node.id);
        const nodeSize = graphLib.sizeOf(sizes, node.id);
        const def = defs.get(node.type);
        ctx2d.fillStyle = categoryColor(def ? def.category : 'utility');
        ctx2d.globalAlpha = selection.nodes.has(node.id) ? 1 : 0.75;
        ctx2d.fillRect(px(pos.x), py(pos.y), Math.max(2, nodeSize.w * scale), Math.max(2, nodeSize.h * scale));
      }
      ctx2d.globalAlpha = 1;
      ctx2d.strokeStyle = 'rgba(216,162,95,0.95)';
      ctx2d.lineWidth = 1.2;
      ctx2d.fillStyle = 'rgba(216,162,95,0.08)';
      ctx2d.fillRect(px(view.x), py(view.y), view.w * scale, view.h * scale);
      ctx2d.strokeRect(px(view.x), py(view.y), view.w * scale, view.h * scale);
    }

    /* ---------- misc api ---------- */

    // A new registry (availability changed on the server). Only the cards whose node type changed its availability
    // are marked for a new build with the next render(); all others, with the field the person may be typing in,
    // stay untouched.
    function setRegistry(nextReg) {
      const previous = reg;
      reg = nextReg;
      if (!previous) return;
      for (const state of cards.values()) {
        const type = state.node && state.node.type;
        if (type && previous.types.get(type)?.available !== nextReg.types.get(type)?.available) state.node = null;
      }
    }

    // The limits of inputs that follow a model arrive after the card was drawn (the model description is read when it is
    // needed): the cards of such nodes are brought up to date, the others stay untouched.
    let limitsPending = false;

    function refreshLimits() {
      if (!reg || !graph) return;
      // not under a connection that is being dragged (the ports would be built again); it is done when the drag ends
      if (drag) {
        limitsPending = true;
        return;
      }
      limitsPending = false;
      for (const state of cards.values()) {
        const def = state.node ? reg.types.get(state.node.type) : null;
        if (def && (def.inputs || []).some((port) => port.limitBy)) state.node = null;
      }
      render(graph);
    }

    function setTool(next) {
      tool = next === 'hand' ? 'hand' : 'select';
      updateCursorClass();
    }

    function setSpace(down) {
      if (spaceDown === down) return;
      spaceDown = down;
      updateCursorClass();
    }

    // Language switch: rebuild card texts, note / group labels.
    function relabel() {
      if (portTip) portTip.hide();
      for (const state of cards.values()) {
        state.sig = null;
        state.node = null;
      }
      for (const entry of noteEls.values()) {
        entry.el.querySelector('.nv-note-head span').textContent = ui.T('nodes.note.title');
        entry.area.placeholder = ui.T('nodes.note.placeholder');
        entry.area.setAttribute('aria-label', ui.T('nodes.note.title'));
      }
      for (const entry of groupEls.values()) {
        entry.group = null;
      }
      render(graph);
    }

    function destroy() {
      destroyed = true;
      if (portTip) portTip.destroy();
      if (resizeObserver) resizeObserver.disconnect();
      for (const state of cards.values()) ui.disposeWidgets(state);
    }

    function relayout() {
      for (const id of cards.keys()) pendingMeasure.add(id);
      scheduleMeasure();
      scheduleMinimap();
    }

    applyViewport();

    return {
      setRegistry,
      refreshLimits,
      render,
      setViewport,
      getViewport: () => ({ ...viewport }),
      zoomBy,
      setZoom,
      fit,
      centerOnWorld,
      clientToWorld,
      containerSize,
      setSelection,
      getSelection: selectionSnapshot,
      setTool,
      getTool: () => tool,
      setSpace,
      getSizes: () => sizes,
      getCard: (id) => cards.get(id) || null,
      getLastPointer: () => ({ ...lastPointer }),
      setSlot,
      clearSlots,
      relabel,
      relayout,
      scheduleMinimap,
      destroy
    };
  }

  OCD.canvas = { createCanvas, bezier };
})(window);
