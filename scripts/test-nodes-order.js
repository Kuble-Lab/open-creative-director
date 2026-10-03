'use strict';

// Order of the connections of a multi-input (WP36): the geometry of the number badges on the edges (public/nodes/edge-geometry.js),
// the pure reordering and the numbering in public/nodes/graph.js, and the wiring of the order row, the menus and the texts.
// The engine side (the new order reaches the node and makes it stale) is tested in test-nodes-engine.js.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const geometry = require('../public/nodes/edge-geometry');
const graphLib = require('../public/nodes/graph');
const { createHistory } = require('../public/nodes/history');
const registryModule = require('../lib/nodes/registry');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const reg = graphLib.indexRegistry(JSON.parse(JSON.stringify(registryModule.publicRegistry())));

/* ---------- geometry ---------- */

const GAP = geometry.BADGE_RADIUS * 2 + 4;

function minDistance(spots) {
  let least = Infinity;
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) least = Math.min(least, Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y));
  }
  return least;
}

// distance of a point to the curve, by dense sampling
function distanceToCurve(a, b, point) {
  let least = Infinity;
  for (let i = 0; i <= 2000; i += 1) {
    const on = geometry.pointAt(a, b, i / 2000);
    least = Math.min(least, Math.hypot(on.x - point.x, on.y - point.y));
  }
  return least;
}

function testCurve() {
  // the same curve the canvas always drew
  const a = { x: 10, y: 20 };
  const b = { x: 410, y: 220 };
  assert.equal(geometry.path(a, b), 'M 10 20 C 210 20, 210 220, 410 220');
  assert.equal(geometry.path({ x: 0, y: 0 }, { x: 40, y: 0 }), 'M 0 0 C 60 0, -20 0, 40 0', 'short edges keep the minimum reach');
  assert.deepEqual(geometry.pointAt(a, b, 0), a);
  assert.deepEqual(geometry.pointAt(a, b, 1), b);
  const table = geometry.table(a, b);
  assert.ok(table.total > Math.hypot(400, 200) - 1e-6, 'a curve is not shorter than the straight line');
  assert.deepEqual([table.fromEnd(0).x, table.fromEnd(0).y], [b.x, b.y]);
  const start = table.fromEnd(table.total);
  assert.ok(Math.hypot(start.x - a.x, start.y - a.y) < 1e-6);
  assert.deepEqual([table.fromEnd(-5).x, table.fromEnd(-5).y], [b.x, b.y], 'clamped at the input');
  assert.ok(Math.abs(table.fromEnd(1e9).t) < 1e-9, 'clamped at the output');
  // the distance is along the curve, and it grows monotonically away from the input
  let last = -1;
  for (const distance of [0, 10, 30, 60, 120, 200]) {
    const point = table.fromEnd(distance);
    assert.ok(point.distance >= last);
    last = point.distance;
    assert.ok(distanceToCurve(a, b, point) < 0.5, 'the point lies on the curve');
  }
  // arc length of a straight run into the input: the badge is that far from it
  const near = table.fromEnd(48);
  assert.ok(Math.hypot(near.x - b.x, near.y - b.y) <= 48 + 1e-6 && Math.hypot(near.x - b.x, near.y - b.y) > 30);
  assert.equal(geometry.curveLength(a, b), table.total);
  assert.deepEqual(geometry.pointFromEnd(a, b, 20), table.fromEnd(20));
  // no NaN for a curve of no length
  const flat = geometry.table({ x: 5, y: 5 }, { x: 5, y: 5 });
  assert.ok(Number.isFinite(flat.fromEnd(48).x) && Number.isFinite(flat.fromEnd(48).y));
  assert.deepEqual(geometry.tangentAt({ x: 5, y: 5 }, { x: 5, y: 5 }, 0), { x: 1, y: 0 }, 'a curve between two equal ports leaves to the right');
  const turning = geometry.tangentAt({ x: 5, y: 5 }, { x: 5, y: 5 }, 0.5);
  assert.ok(Math.abs(Math.hypot(turning.x, turning.y) - 1) < 1e-9 && Number.isFinite(turning.x), 'a unit vector everywhere');
  const tangent = geometry.tangentAt(a, b, 0);
  assert.ok(Math.abs(Math.hypot(tangent.x, tangent.y) - 1) < 1e-9);
}

function testBadgesApart() {
  const b = { x: 600, y: 300 };
  const sources = [{ x: 0, y: 0 }, { x: 0, y: 600 }];
  // two sources above and below: close to the input the curves still lie together (they all arrive horizontally), so the
  // second badge moves back along its curve until the circles are apart; the first one keeps the preferred spot
  const two = geometry.placeBadges(sources.map((a) => ({ a, b })));
  assert.equal(two.length, 2);
  assert.ok(minDistance(two) >= GAP - 1e-6, 'the badges do not overlap');
  two.forEach((spot, index) => {
    assert.ok(distanceToCurve(sources[index], b, spot) < 0.5, 'each badge sits on its own curve');
    assert.equal(spot.free, true);
  });
  assert.ok(Math.abs(two[0].distance - geometry.BADGE_OFFSET) < 1e-6, 'the first badge: the preferred distance');
  assert.ok(two[1].distance >= geometry.BADGE_OFFSET, 'a badge never moves closer to the input than the preferred distance');
  // far apart sources: nobody has to move
  const far = geometry.placeBadges([{ a: { x: 0, y: -2000 }, b }, { a: { x: 0, y: 2600 }, b }]);
  assert.ok(far.every((spot) => Math.abs(spot.distance - geometry.BADGE_OFFSET) < 1e-6), 'nothing in the way: the preferred distance for all');
  assert.deepEqual(geometry.placeBadges([]), []);
  assert.equal(geometry.placeBadges([{ a: { x: 0, y: 0 }, b }]).length, 1);
}

function testBadgesMoveBack() {
  const b = { x: 800, y: 300 };
  // eight sources in a tight column: at the preferred distance the curves are far too close
  const curves = Array.from({ length: 8 }, (_v, i) => ({ a: { x: 0, y: 280 + i * 6 }, b }));
  const spots = geometry.placeBadges(curves);
  assert.equal(spots.length, 8);
  assert.ok(minDistance(spots) >= GAP - 1e-6, `eight badges without overlap, least distance ${minDistance(spots)}`);
  assert.ok(spots.every((spot) => spot.free));
  assert.ok(spots.some((spot) => spot.distance > geometry.BADGE_OFFSET), 'a badge moved back along its curve');
  spots.forEach((spot, index) => assert.ok(distanceToCurve(curves[index].a, b, spot) < 0.5, 'still on its own curve'));
  // the first badge keeps the preferred spot: the ones after it make room
  assert.ok(Math.abs(spots[0].distance - geometry.BADGE_OFFSET) < 1e-6);
  // it never goes back further than the allowed part of the curve
  for (const [index, spot] of spots.entries()) {
    assert.ok(spot.distance <= geometry.table(curves[index].a, b).total * 0.85 + 1e-6);
  }
}

function testBadgesEdgeCases() {
  const b = { x: 300, y: 100 };
  // identical curves (the same output twice): they never part, the badges are pushed sideways instead
  const same = geometry.placeBadges([{ a: { x: 0, y: 0 }, b }, { a: { x: 0, y: 0 }, b }, { a: { x: 0, y: 0 }, b }]);
  assert.ok(minDistance(same) >= GAP - 1e-6, `identical curves: no overlap (${minDistance(same)})`);
  assert.ok(same.every((spot) => Number.isFinite(spot.x) && Number.isFinite(spot.y)));

  // very short edges: the curve keeps a minimum reach, so even ports on top of each other have a curve of some length;
  // where the preferred distance does not fit into the curve, the badge sits in its middle
  const ports = { a: { x: 0, y: 0 }, b: { x: 30, y: 0 } };
  const total = geometry.curveLength(ports.a, ports.b);
  const short = geometry.placeBadges([ports]);
  assert.ok(short[0].distance > 0 && short[0].distance <= total * 0.85 + 1e-6, 'inside the curve');
  const tight = geometry.placeBadges([ports], { offset: total });
  assert.ok(Math.abs(tight[0].distance - total / 2) < 1e-6, 'the middle of a curve that is too short for the offset');
  const shortTwo = geometry.placeBadges([ports, { a: { x: 0, y: 20 }, b: ports.b }]);
  assert.ok(shortTwo.every((spot) => Number.isFinite(spot.x) && Number.isFinite(spot.y)));
  assert.ok(minDistance(shortTwo) >= GAP - 1e-6, `short edges: no overlap (${minDistance(shortTwo)})`);

  // an edge that runs backwards (the output is right of the input): a loop, the maths is the same
  const backwards = [{ a: { x: 700, y: 0 }, b: { x: 100, y: 120 } }, { a: { x: 700, y: 400 }, b: { x: 100, y: 120 } }];
  const loop = geometry.placeBadges(backwards);
  assert.ok(minDistance(loop) >= GAP - 1e-6);
  loop.forEach((spot, index) => assert.ok(distanceToCurve(backwards[index].a, backwards[index].b, spot) < 0.5));

  // the source straight above the target
  const above = [{ a: { x: 100, y: -300 }, b: { x: 100, y: 0 } }, { a: { x: 100, y: -500 }, b: { x: 100, y: 0 } }, { a: { x: 100, y: 300 }, b: { x: 100, y: 0 } }];
  const column = geometry.placeBadges(above);
  assert.ok(minDistance(column) >= GAP - 1e-6, `sources above and below: no overlap (${minDistance(column)})`);
  assert.ok(column.every((spot) => Number.isFinite(spot.x) && Number.isFinite(spot.y)));

  // a curve of no length does not break anything
  const nothing = geometry.placeBadges([{ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }]);
  assert.ok(Number.isFinite(nothing[0].x));
  // options: another offset
  const wide = geometry.placeBadges([{ a: { x: 0, y: 0 }, b: { x: 900, y: 300 } }], { offset: 80 });
  assert.ok(Math.abs(wide[0].distance - 80) < 1e-6);
}

function testOrderText() {
  assert.equal(geometry.orderText(1), '1');
  assert.equal(geometry.orderText(12), '12');
  assert.equal(geometry.orderText(null), '…');
  assert.equal(geometry.orderText(undefined), '…');
}

function testBrowserLoad() {
  const window = {};
  vm.runInNewContext(read('public/nodes/edge-geometry.js'), { window, self: window });
  assert.ok(window.OCDNodes.edgeGeometry && typeof window.OCDNodes.edgeGeometry.placeBadges === 'function', 'loads without Node: window.OCDNodes.edgeGeometry');
}

/* ---------- reordering in graph.js ---------- */

function mediaGraph() {
  let graph = graphLib.emptyGraph();
  const add = (type, x, y, params) => {
    const out = graphLib.addNode(reg, graph, type, { x, y, params });
    graph = out.graph;
    return out.node.id;
  };
  const link = (from, fromPort, to, toPort) => {
    const out = graphLib.connect(reg, graph, { node: from, port: fromPort }, { node: to, port: toPort });
    assert.ok(!out.error, `connect ${from}.${fromPort} > ${to}.${toPort}`);
    graph = out.graph;
    return out.edge.id;
  };
  const edit = add('image.edit', 600, 0);
  const prompt = add('input.prompt', 0, -200);
  const img1 = add('input.image', 0, 0);
  const img2 = add('input.image', 0, 200);
  const img3 = add('input.image', 0, 400);
  const img4 = add('input.image', 0, 600);
  // the prompt edge sits between the image edges
  const e1 = link(img1, 'image', edit, 'images');
  const ep = link(prompt, 'prompt', edit, 'prompt');
  const e2 = link(img2, 'image', edit, 'images');
  const e3 = link(img3, 'image', edit, 'images');
  const e4 = link(img4, 'image', edit, 'images');
  return { graph, edit, prompt, imgs: [img1, img2, img3, img4], edges: { e1, e2, e3, e4, ep } };
}

const ids = (graph) => graph.edges.map((edge) => edge.id);
const inputIds = (graph, node, port) => graphLib.incomingEdges(graph, node, port).map((edge) => edge.id);

function testMoveInputEdge() {
  const m = mediaGraph();
  const { e1, e2, e3, e4, ep } = m.edges;
  assert.deepEqual(ids(m.graph), [e1, ep, e2, e3, e4]);
  const snapshot = JSON.stringify(m.graph);

  const first = graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e3, 'first');
  assert.equal(first.changed, true);
  assert.deepEqual(inputIds(first.graph, m.edit, 'images'), [e3, e1, e2, e4]);
  assert.deepEqual(ids(first.graph), [e3, ep, e1, e2, e4], 'the other edge keeps its slot in graph.edges');
  assert.equal(JSON.stringify(m.graph), snapshot, 'the graph that went in is not changed');
  // edge objects are shared, not copied
  assert.equal(first.graph.edges.find((edge) => edge.id === e1), m.graph.edges.find((edge) => edge.id === e1));
  assert.equal(first.graph.nodes, m.graph.nodes, 'nothing but the edges is touched');

  const last = graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e1, 'last');
  assert.deepEqual(inputIds(last.graph, m.edit, 'images'), [e2, e3, e4, e1]);
  assert.equal(ids(last.graph)[1], ep);

  assert.deepEqual(inputIds(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e3, 'earlier').graph, m.edit, 'images'), [e1, e3, e2, e4]);
  assert.deepEqual(inputIds(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e2, 'later').graph, m.edit, 'images'), [e1, e3, e2, e4]);
  assert.deepEqual(inputIds(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e1, 2).graph, m.edit, 'images'), [e2, e3, e1, e4], 'a number is the place the edge has afterwards');
  assert.deepEqual(inputIds(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e4, 0).graph, m.edit, 'images'), [e4, e1, e2, e3]);

  // nothing to do: the same graph object, no error
  for (const [edge, target] of [[e1, 'first'], [e1, 'earlier'], [e4, 'last'], [e4, 'later'], [e2, 1]]) {
    const same = graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', edge, target);
    assert.equal(same.changed, false, `${edge} ${target}`);
    assert.equal(same.graph, m.graph);
    assert.equal(same.error, undefined);
  }

  // invalid calls
  const reason = (result) => result.error && result.error.reason;
  assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, 'nope', 'images', e1, 'first')), 'unknown_node');
  assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, m.edit, 'nope', e1, 'first')), 'unknown_port');
  assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, m.edit, 'prompt', ep, 'first')), 'not_multiple', 'a single input has no order');
  assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', ep, 'first')), 'unknown_edge', 'an edge of another input');
  assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', 'e999', 'first')), 'unknown_edge');
  for (const target of [-1, 4, 1.5, 'middle', null, undefined, NaN]) {
    assert.equal(reason(graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e1, target)), 'bad_target', String(target));
  }
  for (const failed of [graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', e1, 9), graphLib.moveInputEdge(reg, m.graph, 'nope', 'images', e1, 0)]) {
    assert.equal(failed.graph, m.graph, 'a refused call returns the graph unchanged');
  }
  assert.equal(JSON.stringify(m.graph), snapshot);
}

function testSetInputOrder() {
  const m = mediaGraph();
  const { e1, e2, e3, e4, ep } = m.edges;
  const done = graphLib.setInputOrder(reg, m.graph, m.edit, 'images', [e4, e3, e2, e1]);
  assert.equal(done.changed, true);
  assert.deepEqual(ids(done.graph), [e4, ep, e3, e2, e1]);
  const same = graphLib.setInputOrder(reg, m.graph, m.edit, 'images', [e1, e2, e3, e4]);
  assert.equal(same.changed, false);
  assert.equal(same.graph, m.graph);
  const reason = (list) => graphLib.setInputOrder(reg, m.graph, m.edit, 'images', list).error?.reason;
  assert.equal(reason([e1, e2, e3]), 'bad_order', 'an edge is missing');
  assert.equal(reason([e1, e2, e3, e4, ep]), 'bad_order', 'too many');
  assert.equal(reason([e1, e1, e3, e4]), 'bad_order', 'a repeat');
  assert.equal(reason([e1, e2, e3, ep]), 'bad_order', 'an edge of another input');
  assert.equal(reason('e1,e2'), 'bad_order');
  assert.equal(reason(undefined), 'bad_order');
  assert.equal(graphLib.setInputOrder(reg, m.graph, 'nope', 'images', []).error.reason, 'unknown_node');
  assert.equal(graphLib.setInputOrder(reg, m.graph, m.edit, 'nope', []).error.reason, 'unknown_port');
  assert.equal(graphLib.setInputOrder(reg, m.graph, m.edit, 'prompt', [ep]).error.reason, 'not_multiple');

  // only this input: a second multi-input of the same node and edges of other nodes stay as they are
  let graph = m.graph;
  const sink = graphLib.addNode(reg, graph, 'output.result', { x: 900, y: 0 });
  graph = sink.graph;
  const o1 = graphLib.connect(reg, graph, { node: m.edit, port: 'image' }, { node: sink.node.id, port: 'inputs' });
  graph = o1.graph;
  const o2 = graphLib.connect(reg, graph, { node: m.prompt, port: 'prompt' }, { node: sink.node.id, port: 'inputs' });
  graph = o2.graph;
  const moved = graphLib.moveInputEdge(reg, graph, sink.node.id, 'inputs', o2.edge.id, 'first');
  assert.deepEqual(inputIds(moved.graph, sink.node.id, 'inputs'), [o2.edge.id, o1.edge.id]);
  assert.deepEqual(inputIds(moved.graph, m.edit, 'images'), inputIds(graph, m.edit, 'images'), 'the images input did not move');
}

function testUndoIsOneStep() {
  const m = mediaGraph();
  const history = createHistory({ coalesceMs: 0 });
  history.reset(graphLib.content(m.graph));
  const moved = graphLib.moveInputEdge(reg, m.graph, m.edit, 'images', m.edges.e4, 'first');
  assert.equal(history.commit(graphLib.content(moved.graph), { label: 'reorder-inputs' }), true, 'a new order is a new snapshot');
  assert.equal(history.size, 2);
  const undone = history.undo();
  assert.deepEqual(undone.edges.map((edge) => edge.id), ids(m.graph), 'one undo restores the old order');
  assert.equal(history.canUndo(), false);
  assert.deepEqual(history.redo().edges.map((edge) => edge.id), ids(moved.graph));
  // an unchanged order is no step
  assert.equal(history.commit(graphLib.content(graphLib.moveInputEdge(reg, moved.graph, m.edit, 'images', m.edges.e4, 'first').graph)), false);
}

/* ---------- numbering ---------- */

function testConnectionOrder() {
  const m = mediaGraph();
  const edges = graphLib.incomingEdges(m.graph, m.edit, 'images');
  const order = graphLib.connectionOrder(reg, m.graph, edges, true);
  assert.deepEqual(order.map((item) => item.order), [1, 2, 3, 4]);
  assert.deepEqual(order.map((item) => item.edge.id), edges.map((edge) => edge.id));
  assert.ok(order.every((item) => item.list === false && item.from));

  // a list takes its own position and hides the ones behind it (it counts with all of its items)
  let graph = m.graph;
  const list = graphLib.addNode(reg, graph, 'input.media_list', { x: 0, y: 800 });
  graph = list.graph;
  const linked = graphLib.connect(reg, graph, { node: list.node.id, port: 'items' }, { node: m.edit, port: 'images' });
  graph = linked.graph;
  const extra = graphLib.addNode(reg, graph, 'input.image', { x: 0, y: 1000 });
  graph = extra.graph;
  graph = graphLib.connect(reg, graph, { node: extra.node.id, port: 'image' }, { node: m.edit, port: 'images' }).graph;
  const withList = graphLib.connectionOrder(reg, graph, graphLib.incomingEdges(graph, m.edit, 'images'), true);
  assert.deepEqual(withList.map((item) => item.order), [1, 2, 3, 4, 5, null], 'behind the list: no fixed number');
  assert.deepEqual(withList.map((item) => item.list), [false, false, false, false, true, false]);
  assert.deepEqual(withList.map((item) => geometry.orderText(item.order)), ['1', '2', '3', '4', '5', '…']);

  // the hover help uses the same numbers
  const described = graphLib.describePort(reg, graph, m.edit, 'in', 'images');
  // (the tooltip lists the first connections only)
  const shown = graphLib.PORT_TIP_MAX_CONNECTIONS;
  assert.deepEqual(described.connections.map((connection) => connection.order), withList.map((item) => item.order).slice(0, shown));
  assert.ok(described.facts.some((fact) => fact.key === 'nodes.porttip.fact.orderShift'));

  // after a move the numbers follow the new order
  const moved = graphLib.moveInputEdge(reg, graph, m.edit, 'images', linked.edge.id, 'first').graph;
  const after = graphLib.connectionOrder(reg, moved, graphLib.incomingEdges(moved, m.edit, 'images'), true);
  assert.deepEqual(after.map((item) => item.order), [1, null, null, null, null, null]);
  assert.equal(after[0].list, true);
  assert.deepEqual(graphLib.describePort(reg, moved, m.edit, 'in', 'images').connections.map((connection) => connection.order), after.map((item) => item.order).slice(0, shown));
  // a list in the last place changes no number
  const end = graphLib.moveInputEdge(reg, graph, m.edit, 'images', linked.edge.id, 'last').graph;
  assert.deepEqual(graphLib.connectionOrder(reg, end, graphLib.incomingEdges(end, m.edit, 'images'), true).map((item) => item.order), [1, 2, 3, 4, 5, 6]);
}

function testOrderFacts() {
  const m = mediaGraph();
  const keys = (graph, node, port) => graphLib.describePort(reg, graph, node, 'in', port).facts.map((fact) => fact.key);
  assert.ok(keys(m.graph, m.edit, 'images').includes('nodes.porttip.fact.orderImage'), 'several images: what the numbers mean and how to change them');
  // a single connection has no order to explain
  let single = graphLib.emptyGraph();
  const edit = graphLib.addNode(reg, single, 'image.edit', { x: 0, y: 0 });
  single = edit.graph;
  const one = graphLib.addNode(reg, single, 'input.image', { x: 0, y: 0 });
  single = one.graph;
  single = graphLib.connect(reg, single, { node: one.node.id, port: 'image' }, { node: edit.node.id, port: 'images' }).graph;
  assert.ok(!keys(single, edit.node.id, 'images').some((key) => key.includes('fact.order')));
  // other kinds: the general wording
  let texts = graphLib.emptyGraph();
  const join = graphLib.addNode(reg, texts, 'text.join', { x: 0, y: 0 });
  texts = join.graph;
  for (let i = 0; i < 2; i += 1) {
    const text = graphLib.addNode(reg, texts, 'input.text', { x: 0, y: i * 100 });
    texts = graphLib.connect(reg, text.graph, { node: text.node.id, port: 'text' }, { node: join.node.id, port: 'items' }).graph;
  }
  assert.ok(keys(texts, join.node.id, 'items').includes('nodes.porttip.fact.order'));
  assert.ok(!keys(texts, join.node.id, 'items').includes('nodes.porttip.fact.orderImage'));
}


/* ---------- the order row of a card, with a small stand-in for the DOM ---------- */

// Just enough of a DOM for el(), icon() and the event handling of the row: elements with classes, children, listeners that
// bubble, and a rectangle per element. No layout.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this.parent = null;
    this.ownText = '';
    this.classes = new Set();
    this.offsetWidth = 34;
    this.rect = { left: 0, top: 0, width: 34, height: 34 };
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((name) => self.classes.add(name)),
      remove: (...names) => names.forEach((name) => self.classes.delete(name)),
      contains: (name) => self.classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !self.classes.has(name) : Boolean(force);
        if (on) self.classes.add(name);
        else self.classes.delete(name);
        return on;
      }
    };
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'class') this.className = value;
  }

  getAttribute(key) {
    return key in this.attrs ? this.attrs[key] : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node && node.nodeType === 1) node.parent = this;
      this.children.push(node);
    }
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
  }

  dispatch(type, init = {}) {
    const event = { type, target: this, button: 0, clientX: 0, clientY: 0, pointerId: 1, key: '', stopped: false, prevented: false, ...init };
    event.preventDefault = () => {
      event.prevented = true;
    };
    event.stopPropagation = () => {
      event.stopped = true;
    };
    for (let node = this; node && !event.stopped; node = node.parent) for (const fn of (node.listeners[type] || []).slice()) fn(event);
    return event;
  }

  matches(selector) {
    return selector.split(',').some((part) => part.trim().startsWith('.') && this.classes.has(part.trim().slice(1)));
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  // like a browser: the rectangle includes the CSS transform (a dragged chip moves with the pointer)
  getBoundingClientRect() {
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(this.style.transform || '');
    if (!match || !this.rect) return this.rect;
    const dx = Number(match[1]);
    const dy = Number(match[2]);
    return { ...this.rect, left: this.rect.left + dx, top: this.rect.top + dy };
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function loadCardUi() {
  const storage = new Map([['vcd-lang', 'en']]);
  const document = {
    activeElement: null,
    body: new FakeNode('body'),
    createElement: (tag) => Object.assign(new FakeNode(tag), { ownerDocument: document }),
    createElementNS: (_ns, tag) => Object.assign(new FakeNode(tag), { ownerDocument: document }),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    documentElement: { lang: '' },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    document,
    navigator: { language: 'en' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    addEventListener() {},
    innerWidth: 1200,
    innerHeight: 800
  };
  const context = { window, document, self: window };
  vm.runInNewContext(read('public/i18n.js'), context, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), context, { filename: 'public/nodes/i18n-nodes.js' });
  window.OCDNodes = { graph: graphLib, api: { rel: (url) => url } };
  window.t = window.t || ((key) => key);
  vm.runInNewContext(read('public/nodes/node-ui.js'), context, { filename: 'public/nodes/node-ui.js' });
  return { ui: window.OCDNodes.ui, document };
}

function testOrderRowDom() {
  const { ui, document } = loadCardUi();
  const calls = [];
  const menus = [];
  ui.setCardActions({ reorder: (...args) => calls.push(args), orderMenu: (...args) => menus.push(args) });
  const node = { id: 'n1', type: 'image.edit', x: 0, y: 0, params: {} };
  const state = ui.createCard(node, { reg, onRename() {} });
  state.node = node;
  const host = state.refs.order;
  assert.ok(host.classes.has('nv-node-order') && host.classes.has('is-empty'), 'the row is part of every card and hidden while empty');
  assert.ok(state.el.children.indexOf(host) > state.el.children.indexOf(state.refs.ports), 'under the ports');

  const item = (edgeId, text, extra = {}) => ({ edgeId, order: Number(text) || null, text, list: false, title: `Source ${text}`, source: `Source ${text}`, output: '', thumb: null, ...extra });
  const rows = [{ portId: 'images', label: 'Images', base: 'image', items: [item('e1', '1', { thumb: 'a.png' }), item('e2', '2'), item('e3', '3', { list: true, output: 'Image' })] }];
  ui.applyOrder(state, rows);
  assert.equal(host.classes.has('is-empty'), false);
  const chips = () => host.querySelectorAll('.nv-order-chip');
  assert.equal(chips().length, 3);
  assert.deepEqual(chips().map((chip) => chip.querySelectorAll('.nv-order-num')[0].textContent), ['1', '2', '3'], 'the numbers of the edges');
  assert.equal(chips()[0].querySelectorAll('.nv-order-thumb').length, 1, 'a preview where there is a result');
  assert.equal(chips()[1].querySelectorAll('.nv-order-thumb').length, 0);
  assert.equal(chips()[1].querySelectorAll('.nv-order-name')[0].textContent, 'Source 2', 'a placeholder with the title of the source');
  assert.match(chips()[0].attrs.title, /No\. 1 · Source: Source 1/);
  assert.match(chips()[2].attrs.title, /Output: Image/);
  assert.match(chips()[2].attrs.title, /List: counts with all of its items/);
  assert.equal(chips()[2].classes.has('is-list'), true);
  assert.equal(chips()[0].attrs.tabindex, '0', 'reachable with the keyboard');
  assert.equal(host.querySelectorAll('.nv-order-head')[0].textContent, 'Order: Images');

  // the same rows again: nothing is built anew
  const before = chips();
  ui.applyOrder(state, JSON.parse(JSON.stringify(rows)));
  assert.ok(chips().every((chip, index) => chip === before[index]));

  // keyboard
  const key = (chip, name, extra) => chip.dispatch('keydown', { key: name, ...extra });
  assert.equal(key(chips()[2], 'ArrowLeft').prevented, true);
  key(chips()[1], 'ArrowRight');
  key(chips()[1], 'Home');
  key(chips()[0], 'End');
  key(chips()[0], 'ArrowUp');
  key(chips()[0], 'ArrowDown');
  assert.deepEqual(calls.map((call) => [call[0], call[1], call[2], call[3]]), [
    ['n1', 'images', 'e3', 'earlier'],
    ['n1', 'images', 'e2', 'later'],
    ['n1', 'images', 'e2', 'first'],
    ['n1', 'images', 'e1', 'last'],
    ['n1', 'images', 'e1', 'earlier'],
    ['n1', 'images', 'e1', 'later']
  ]);
  calls.length = 0;
  key(chips()[0], 'Tab');
  key(chips()[0], 'ArrowLeft', { metaKey: true });
  assert.equal(calls.length, 0, 'other keys and shortcuts are left alone');

  // context menu
  const menuEvent = chips()[1].dispatch('contextmenu', { clientX: 40, clientY: 50 });
  assert.equal(menuEvent.prevented, true);
  assert.equal(menuEvent.stopped, true, 'the menu of the node does not open on top');
  assert.deepEqual(menus.map((call) => [call[0], call[1], call[2], call[3], call[4]]), [['n1', 'images', 'e2', 40, 50]]);

  // dragging: the chip nearest to the pointer is the new place
  chips().forEach((chip, index) => {
    chip.rect = { left: index * 40, top: 0, width: 34, height: 34 };
  });
  const drag = (index, moves, finish) => {
    const chip = chips()[index];
    chip.dispatch('pointerdown', { clientX: index * 40 + 17, clientY: 17 });
    for (const [x, y] of moves) chip.dispatch('pointermove', { clientX: x, clientY: y });
    return chip.dispatch(finish, { clientX: moves.length ? moves[moves.length - 1][0] : 0, clientY: 17 });
  };
  const downEvent = chips()[0].dispatch('pointerdown', { clientX: 17, clientY: 17 });
  assert.equal(downEvent.stopped, true, 'a press on a chip does not start a drag of the card');
  chips()[0].dispatch('pointerup');
  assert.equal(calls.length, 0, 'a click without moving changes nothing');
  drag(0, [[19, 17]], 'pointerup');
  assert.equal(calls.length, 0, 'a move below the threshold is a click');
  drag(0, [[40, 17], [97, 17]], 'pointerup');
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [['n1', 'images', 'e1', 2]], 'dropped on the third place');
  calls.length = 0;
  drag(2, [[60, 17], [10, 17]], 'pointerup');
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [['n1', 'images', 'e3', 0]]);
  calls.length = 0;
  drag(1, [[60, 17], [100, 17], [47, 17]], 'pointerup');
  assert.equal(calls.length, 0, 'back on its own place: nothing to do');
  drag(0, [[200, 17]], 'pointercancel');
  assert.equal(calls.length, 0, 'a cancelled drag changes nothing');
  assert.equal(chips()[0].classes.has('is-dragging'), false);
  assert.equal(host.querySelectorAll('.nv-order-row')[0].classes.has('is-sorting'), false);
  assert.equal(chips()[0].style.transform, '', 'the chip is back on its place');

  // Escape while dragging
  const first = chips()[0];
  first.dispatch('pointerdown', { clientX: 17, clientY: 17 });
  first.dispatch('pointermove', { clientX: 100, clientY: 17 });
  assert.equal(first.classes.has('is-dragging'), true);
  assert.equal(chips()[2].classes.has('is-drop-after'), true, 'dragged to the right: the bar is behind the chip');
  assert.equal(chips()[2].classes.has('is-drop'), false);
  first.dispatch('keydown', { key: 'Escape' });
  first.dispatch('pointerup');
  assert.equal(calls.length, 0);
  assert.equal(chips()[2].classes.has('is-drop-after'), false);
  chips()[2].dispatch('pointerdown', { clientX: 97, clientY: 17 });
  chips()[2].dispatch('pointermove', { clientX: 10, clientY: 17 });
  assert.equal(chips()[0].classes.has('is-drop'), true, 'dragged to the left: the bar is before the chip');
  assert.equal(chips()[0].classes.has('is-drop-after'), false);
  chips()[2].dispatch('pointercancel');

  // a change of the rows while a chip is dragged waits for the drop
  const other = [{ ...rows[0], items: [rows[0].items[1], rows[0].items[0]] }];
  chips()[0].dispatch('pointerdown', { clientX: 17, clientY: 17 });
  chips()[0].dispatch('pointermove', { clientX: 60, clientY: 17 });
  ui.applyOrder(state, other);
  assert.equal(chips().length, 3, 'not rebuilt during the drag');
  chips()[0].dispatch('pointercancel');
  assert.equal(chips().length, 2, 'applied after the drag');

  // rows that arrived during a drag that ends in a move are not kept: a later click does not draw them
  ui.applyOrder(state, rows);
  chips().forEach((chip, index) => {
    chip.rect = { left: index * 40, top: 0, width: 34, height: 34 };
  });
  calls.length = 0;
  chips()[0].dispatch('pointerdown', { clientX: 17, clientY: 17 });
  chips()[0].dispatch('pointermove', { clientX: 60, clientY: 17 });
  ui.applyOrder(state, other);
  chips()[0].dispatch('pointermove', { clientX: 97, clientY: 17 });
  chips()[0].dispatch('pointerup');
  assert.equal(calls.length, 1, 'dropped on a new place');
  assert.equal(chips().length, 3, 'the move action draws the row, the pending rows are dropped');
  chips()[0].dispatch('pointerdown', { clientX: 17, clientY: 17 });
  chips()[0].dispatch('pointerup');
  assert.equal(chips().length, 3, 'a click afterwards draws nothing stale');
  calls.length = 0;
  ui.applyOrder(state, other);

  // the focus goes back to the moved chip after a keyboard move (the action redraws the row)
  ui.setCardActions({ reorder: () => ui.applyOrder(state, rows) });
  chips()[1].dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(document.activeElement && document.activeElement.dataset.edge, 'e1');
  ui.setCardActions({ reorder: (...args) => calls.push(args) });

  // not an image input: chips with the title, no preview
  ui.applyOrder(state, [{ portId: 'clips', label: 'Clips', base: 'video', items: [item('v1', '1'), item('v2', '2')] }]);
  assert.equal(chips().length, 2);
  assert.equal(chips()[0].classes.has('is-image'), false);
  assert.equal(chips()[0].querySelectorAll('.nv-order-thumb').length, 0);
  assert.equal(chips()[0].querySelectorAll('.nv-order-name')[0].textContent, 'Source 1');

  // fewer than two connections: the row disappears
  ui.applyOrder(state, []);
  assert.equal(host.classes.has('is-empty'), true);
  assert.equal(chips().length, 0);
}

/* ---------- wiring and texts ---------- */

function testWiring() {
  const html = read('public/index.html');
  assert.ok(html.indexOf('nodes/edge-geometry.js') > html.indexOf('nodes/graph.js') && html.indexOf('nodes/edge-geometry.js') < html.indexOf('nodes/node-ui.js'), 'edge-geometry.js loads after graph.js, before the cards and the canvas');
  const canvas = read('public/nodes/canvas.js');
  assert.ok(/geometry\.placeBadges\(/.test(canvas), 'the badges of an input are placed together');
  assert.ok(/graphLib\.connectionOrder\(/.test(canvas), 'the numbers come from the shared numbering');
  assert.ok(!/translate\(\$\{b\.x - 26\}/.test(canvas), 'no fixed spot for the badge any more');
  assert.ok(/ui\.applyOrder\(/.test(canvas) && /refreshOrder\(/.test(canvas), 'the canvas fills the order row of the cards');
  const nodeUi = read('public/nodes/node-ui.js');
  assert.ok(/function applyOrder\(/.test(nodeUi) && /cardActions\.reorder/.test(nodeUi) && /cardActions\.orderMenu/.test(nodeUi));
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.ok(nodeUi.includes(key), `keyboard: ${key}`);
  const main = read('public/nodes/main.js');
  assert.ok(/graphLib\.moveInputEdge\(/.test(main) && /history: 'reorder-inputs'/.test(main), 'one undo step through the graph function');
  assert.ok(/orderMenuItems\(edge\.to\.node, edge\.to\.port, edge\.id\)/.test(main), 'the menu of an edge offers the order');
  const css = read('public/nodes/nodes.css');
  for (const rule of ['.nv-node-order', '.nv-order-chip', '.nv-order-chip.is-dragging', '.nv-order-num', '.nv-edge-badge.is-list']) assert.ok(css.includes(rule), `CSS rule ${rule}`);
  for (const file of ['public/nodes/node-ui.js', 'public/nodes/canvas.js', 'public/nodes/edge-geometry.js']) {
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(read(file).replace(/\/\/.*$/gm, '')), `${file}: no innerHTML`);
  }
  // the reordering itself stays free of the DOM
  assert.ok(!/document\.|window\./.test(read('public/nodes/edge-geometry.js').replace(/\/\/.*$/gm, '').replace(/root\./g, '')), 'edge-geometry.js has no DOM');
}

function testTexts() {
  const window = {};
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window, self: window });
  const dict = window.I18N;
  const keys = [
    'nodes.order.title', 'nodes.order.hint', 'nodes.order.chipTitle', 'nodes.order.chipOutput', 'nodes.order.chipList', 'nodes.order.chipShifted',
    'nodes.order.first', 'nodes.order.earlier', 'nodes.order.later', 'nodes.order.last', 'nodes.porttip.fact.order', 'nodes.porttip.fact.orderImage'
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) assert.ok(dict[lang] && dict[lang][key], `${lang}: ${key}`);
    assert.match(dict[lang]['nodes.order.title'], /\{port\}/);
    assert.match(dict[lang]['nodes.order.chipTitle'], /\{n\}.*\{source\}/);
    assert.match(dict[lang]['nodes.order.chipOutput'], /\{output\}/);
  }
  assert.ok(!/ß/.test(keys.map((key) => dict.de[key]).join('')), 'Swiss spelling');
  // the tooltip names the numbers and how to change them
  assert.match(dict.de['nodes.porttip.fact.orderImage'], /«Bild 1»/);
  assert.match(dict.en['nodes.porttip.fact.orderImage'], /“Image 1”/);
  assert.match(dict.es['nodes.porttip.fact.orderImage'], /«Imagen 1»/);
  // the tips of "Edit image" say what "Image 1" means and how to change it
  assert.match(dict.de['nodes.type.image.edit.tip.1'], /«Bild 1».*ziehst/);
  assert.match(dict.en['nodes.type.image.edit.tip.1'], /“Image 1”.*Drag/);
  assert.match(dict.es['nodes.type.image.edit.tip.1'], /«Imagen 1».*Arrastra/);
}

const tests = [testCurve, testBadgesApart, testBadgesMoveBack, testBadgesEdgeCases, testOrderText, testBrowserLoad, testMoveInputEdge, testSetInputOrder, testUndoIsOneStep, testConnectionOrder, testOrderFacts, testOrderRowDom, testWiring, testTexts];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('test-nodes-order.js: ok');
