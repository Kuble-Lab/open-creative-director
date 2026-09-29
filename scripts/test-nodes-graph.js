'use strict';

// Pure graph model of the node view (public/nodes/graph.js): registry index, ports, connections,
// cycles, clipboard, groups, viewport maths, fuzzy search and palette compatibility.

const assert = require('assert/strict');

const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');

// Same shape as GET /api/nodes/registry (JSON round trip removes functions and undefined).
const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
const reg = graphLib.indexRegistry(payload);

function build() {
  let graph = graphLib.emptyGraph();
  const add = (type, x, y, params) => {
    const out = graphLib.addNode(reg, graph, type, { x, y, params });
    graph = out.graph;
    return out.node.id;
  };
  return { get graph() { return graph; }, set graph(value) { graph = value; }, add };
}

function testRegistryIndex() {
  assert.ok(reg.types.size >= 72, 'registry index has all node types');
  assert.ok(reg.types.has('image.generate'));
  assert.equal(reg.listSuffix, '[]');
  const ports = graphLib.portsFor(reg, { type: 'input.media_list', params: {} });
  assert.equal(ports.outputs[0].type, 'image[]', 'default variant is image');
  const video = graphLib.portsFor(reg, { type: 'input.media_list', params: { kind: 'video' } });
  assert.equal(video.outputs[0].type, 'video[]', 'portVariants switch the output type');
  const remove = graphLib.portsFor(reg, { type: 'hf.remove_background', params: { kind: 'video' } });
  assert.equal(remove.inputs[0].type, 'video');
  assert.deepEqual(graphLib.portsFor(reg, { type: 'nope.unknown', params: {} }), { inputs: [], outputs: [] });
  const defaults = graphLib.paramDefaults(reg.types.get('image.generate'));
  assert.deepEqual(defaults, { prompt: '', aspect_ratio: '1:1', count: 1 });
  assert.deepEqual(graphLib.paramDefaults(reg.types.get('input.media_list')).assets, []);
}

function testTypeCompat() {
  const ok = (a, b) => graphLib.canConnectTypes(reg, a, b);
  assert.equal(ok('text', 'text'), true);
  assert.equal(ok('number', 'text'), true);
  assert.equal(ok('text', 'number'), false);
  assert.equal(ok('image[]', 'image'), true, 'list maps');
  assert.equal(ok('image', 'image[]'), true, 'single wraps');
  assert.equal(ok('video', 'image'), false);
  assert.equal(ok('any', 'video'), true);
  assert.equal(ok('image', 'any'), true);
  assert.equal(ok('bogus', 'image'), false);
}

function testConnect() {
  const b = build();
  const text = b.add('input.text', 0, 0);
  const gen = b.add('image.generate', 300, 0);
  const seed = b.add('video.seedance', 700, 0);
  const out = b.add('output.result', 1000, 0);
  assert.deepEqual([text, gen, seed, out], ['n1', 'n2', 'n3', 'n4']);

  let res = graphLib.connect(reg, b.graph, { node: text, port: 'text' }, { node: gen, port: 'prompt' });
  assert.ok(!res.error);
  assert.equal(res.edge.id, 'e1');
  b.graph = res.graph;

  // incompatible: image -> prompt(text)
  res = graphLib.connect(reg, b.graph, { node: gen, port: 'image' }, { node: seed, port: 'prompt' });
  assert.equal(res.error.code, 'incompatible');
  assert.equal(res.graph, b.graph, 'graph untouched on error');

  // compatible: image -> first_frame
  res = graphLib.connect(reg, b.graph, { node: gen, port: 'image' }, { node: seed, port: 'first_frame' });
  assert.ok(!res.error);
  b.graph = res.graph;

  // duplicate
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: gen, port: 'image' }, { node: seed, port: 'first_frame' }).code, 'duplicate');
  // self loop and missing ports
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: gen, port: 'image' }, { node: gen, port: 'prompt' }).code, 'same_node');
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: gen, port: 'nope' }, { node: seed, port: 'first_frame' }).code, 'no_output');
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: gen, port: 'image' }, { node: seed, port: 'nope' }).code, 'no_input');
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: 'zz', port: 'image' }, { node: seed, port: 'first_frame' }).code, 'unknown_node');

  // hidden output ports cannot be dragged from
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: out, port: 'result' }, { node: seed, port: 'refs' }).code, 'no_output');

  // cycle: seed -> (any) ... build gen2 fed by seed video? video -> image not allowed, use router
  const router = b.add('util.router', 400, 200);
  res = graphLib.connect(reg, b.graph, { node: gen, port: 'image' }, { node: router, port: 'inputs' });
  b.graph = res.graph;
  const text2 = b.add('text.join', 600, 200);
  // router.out(any) -> text.join.items(text) and text.join.text -> gen.prompt would not cycle.
  res = graphLib.connect(reg, b.graph, { node: router, port: 'out' }, { node: text2, port: 'items' });
  b.graph = res.graph;
  res = graphLib.connect(reg, b.graph, { node: text2, port: 'text' }, { node: gen, port: 'prompt' });
  assert.equal(res.error.code, 'cycle', 'gen -> router -> join -> gen closes a cycle');

  // single-input port replaces the previous edge
  const text3 = b.add('input.text', 0, 300);
  res = graphLib.connect(reg, b.graph, { node: text3, port: 'text' }, { node: gen, port: 'prompt' });
  assert.ok(!res.error);
  assert.equal(res.removed.length, 1, 'previous edge into prompt removed');
  b.graph = res.graph;
  assert.equal(graphLib.incomingEdges(b.graph, gen, 'prompt').length, 1);

  // multiple port keeps all edges
  const a = b.add('input.text', 0, 500);
  const c = b.add('input.text', 0, 600);
  for (const source of [a, c]) {
    res = graphLib.connect(reg, b.graph, { node: source, port: 'text' }, { node: out, port: 'inputs' });
    assert.ok(!res.error);
    b.graph = res.graph;
  }
  assert.equal(graphLib.incomingEdges(b.graph, out, 'inputs').length, 2);

  // max on a multiple port (video.seedance refs max 30 -> use llm.chat images max 8)
  const llm = b.add('llm.chat', 900, 600);
  for (let i = 0; i < 8; i += 1) {
    const img = b.add('input.image', 0, 700 + i * 10);
    res = graphLib.connect(reg, b.graph, { node: img, port: 'image' }, { node: llm, port: 'images' });
    assert.ok(!res.error, `edge ${i}`);
    b.graph = res.graph;
  }
  const extra = b.add('input.image', 0, 900);
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: extra, port: 'image' }, { node: llm, port: 'images' }).code, 'too_many');

  // list wrapping: text_list -> template a (text) is allowed (implicit map)
  const list = b.add('input.text_list', 0, 1000);
  const tpl = b.add('text.template', 400, 1000);
  assert.ok(!graphLib.checkConnection(reg, b.graph, { node: list, port: 'items' }, { node: tpl, port: 'a' }));

  // disconnect
  const edgeId = graphLib.incomingEdges(b.graph, out, 'inputs')[0].id;
  const before = b.graph.edges.length;
  b.graph = graphLib.disconnect(b.graph, edgeId);
  assert.equal(b.graph.edges.length, before - 1);
  assert.equal(graphLib.disconnect(b.graph, 'missing'), b.graph, 'unknown edge id is a no-op');
}

function testCyclesAndReach() {
  const b = build();
  const a = b.add('input.text', 0, 0);
  const t1 = b.add('text.template', 0, 0);
  const t2 = b.add('text.template', 0, 0);
  const t3 = b.add('text.template', 0, 0);
  const link = (x, y, port) => {
    const res = graphLib.connect(reg, b.graph, { node: x, port: x === a ? 'text' : 'text' }, { node: y, port });
    assert.ok(!res.error, `${x}->${y}`);
    b.graph = res.graph;
  };
  link(a, t1, 'a');
  link(t1, t2, 'a');
  link(t2, t3, 'a');
  assert.deepEqual([...graphLib.descendants(b.graph, [t1])].sort(), [t2, t3].sort());
  assert.deepEqual([...graphLib.ancestors(b.graph, [t3])].sort(), [a, t1, t2].sort());
  assert.equal(graphLib.wouldCreateCycle(b.graph, t3, t1), true);
  assert.equal(graphLib.wouldCreateCycle(b.graph, t1, t3), false);
  assert.equal(graphLib.checkConnection(reg, b.graph, { node: t3, port: 'text' }, { node: t1, port: 'b' }).code, 'cycle');
}

function testNodeMutations() {
  const b = build();
  const gen = b.add('image.generate', 10, 20, { prompt: 'hello', count: 3 });
  const node = graphLib.getNode(b.graph, gen);
  assert.deepEqual(node.params, { prompt: 'hello', aspect_ratio: '1:1', count: 3 }, 'defaults merged with overrides');
  assert.equal(node.typeVersion, 1);

  const moved = graphLib.moveItems(b.graph, { nodes: [gen] }, 5, -5);
  assert.equal(graphLib.getNode(moved, gen).x, 15);
  assert.equal(graphLib.getNode(moved, gen).y, 15);
  assert.equal(graphLib.getNode(b.graph, gen).x, 10, 'original untouched');

  const params = graphLib.setParams(b.graph, gen, { count: 2 });
  assert.equal(graphLib.getNode(params, gen).params.count, 2);
  assert.equal(graphLib.getNode(params, gen).params.prompt, 'hello');

  const titled = graphLib.setTitle(b.graph, gen, '  Hero  ');
  assert.equal(graphLib.getNode(titled, gen).title, 'Hero');
  assert.equal(graphLib.getNode(graphLib.setTitle(titled, gen, ''), gen).title, undefined, 'empty title removes it');

  // node ids are never reused when a reserved set is passed
  const removed = graphLib.removeNodes(b.graph, [gen]);
  assert.equal(removed.nodes.length, 0);
  assert.equal(graphLib.nextId('n', removed), 'n1');
  assert.equal(graphLib.nextId('n', removed, new Set(['n1', 'n7'])), 'n8');

  // removing a node removes its edges
  const text = graphLib.addNode(reg, b.graph, 'input.text', { x: 0, y: 0 });
  const connected = graphLib.connect(reg, text.graph, { node: text.node.id, port: 'text' }, { node: gen, port: 'prompt' });
  assert.equal(connected.graph.edges.length, 1);
  assert.equal(graphLib.removeNodes(connected.graph, [text.node.id]).edges.length, 0);
  assert.equal(graphLib.removeNodes(connected.graph, ['none']), connected.graph, 'no-op keeps identity');
}

function testPruneEdges() {
  const b = build();
  const list = b.add('input.media_list', 0, 0, { kind: 'image' });
  const gen = b.add('image.edit', 300, 0);
  const res = graphLib.connect(reg, b.graph, { node: list, port: 'items' }, { node: gen, port: 'images' });
  assert.ok(!res.error, 'image[] -> image');
  b.graph = res.graph;
  assert.equal(graphLib.pruneEdges(reg, b.graph), b.graph, 'nothing to prune');
  // switching kind to video changes the port type -> edge becomes incompatible
  const switched = graphLib.setParams(b.graph, list, { kind: 'video' });
  const pruned = graphLib.pruneEdges(reg, switched, [list]);
  assert.equal(pruned.edges.length, 0, 'incompatible edge is pruned after a portVariants change');
  // audio -> audio stays
  const withAudio = graphLib.setParams(b.graph, list, { kind: 'image' });
  assert.equal(graphLib.pruneEdges(reg, withAudio, [list]).edges.length, 1);
  // unknown node types keep their edges
  const unknownGraph = {
    ...b.graph,
    nodes: [...b.graph.nodes, { id: 'u1', type: 'future.thing', x: 0, y: 0, params: {} }],
    edges: [...b.graph.edges, { id: 'e9', from: { node: 'u1', port: 'x' }, to: { node: gen, port: 'prompt' } }]
  };
  assert.equal(graphLib.pruneEdges(reg, unknownGraph).edges.length, 2, 'edges of unknown types survive');
}

function testGroupsAndNotes() {
  const b = build();
  const a = b.add('input.text', 100, 100);
  const c = b.add('input.text', 500, 300);
  const sizes = new Map([[a, { w: 200, h: 100 }], [c, { w: 200, h: 100 }]]);
  const grouped = graphLib.groupSelection(b.graph, sizes, { nodes: [a, c] }, { title: 'Look' });
  assert.equal(grouped.group.id, 'g1');
  assert.equal(grouped.group.title, 'Look');
  assert.ok(grouped.group.x < 100 && grouped.group.y < 100, 'frame surrounds the nodes with padding');
  assert.ok(grouped.group.x + grouped.group.w > 700 && grouped.group.y + grouped.group.h > 400);
  b.graph = grouped.graph;
  const members = graphLib.membersOfGroup(b.graph, sizes, grouped.group);
  assert.deepEqual(members.nodes.sort(), [a, c].sort());

  const noted = graphLib.addNote(b.graph, { x: 5, y: 6, text: 'hi' });
  assert.equal(noted.note.id, 't1');
  b.graph = graphLib.updateNote(noted.graph, 't1', { text: 'changed', w: 300 });
  assert.equal(b.graph.notes[0].text, 'changed');
  assert.equal(b.graph.notes[0].w, 300);

  b.graph = graphLib.updateGroup(b.graph, 'g1', { color: 'blue', title: 'Renamed' });
  assert.equal(b.graph.groups[0].color, 'blue');
  b.graph = graphLib.removeGroups(b.graph, ['g1']);
  assert.equal(b.graph.groups.length, 0);
  b.graph = graphLib.removeNotes(b.graph, ['t1']);
  assert.equal(b.graph.notes.length, 0);
  assert.equal(graphLib.groupSelection(b.graph, sizes, { nodes: [] }).group, null, 'empty selection makes no group');
}

function testGeometry() {
  const b = build();
  const a = b.add('input.text', 0, 0);
  const c = b.add('input.text', 400, 400);
  const sizes = { [a]: { w: 100, h: 50 }, [c]: { w: 100, h: 50 } };
  const rect = graphLib.boundsOf(b.graph, sizes);
  assert.deepEqual(rect, { x: 0, y: 0, w: 500, h: 450 });
  assert.deepEqual(graphLib.boundsOf(b.graph, sizes, { nodes: [c] }), { x: 400, y: 400, w: 100, h: 50 });
  assert.equal(graphLib.boundsOf(graphLib.emptyGraph(), sizes), null);

  const hit = graphLib.itemsInRect(b.graph, sizes, { x: 50, y: 20, w: 20, h: 20 });
  assert.deepEqual(hit.nodes, [a]);
  const miss = graphLib.itemsInRect(b.graph, sizes, { x: 200, y: 200, w: 10, h: 10 });
  assert.deepEqual(miss.nodes, []);

  assert.equal(graphLib.snap(13), 16);
  assert.equal(graphLib.snap(11), 8);

  // zoom keeps the point under the cursor fixed
  const vp = { x: 100, y: 50, zoom: 1 };
  const zoomed = graphLib.zoomAt(vp, 2, 300, 250);
  const before = graphLib.screenToWorld(vp, 300, 250);
  const after = graphLib.screenToWorld(zoomed, 300, 250);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomed.zoom, 2);
  assert.equal(graphLib.zoomAt(vp, 100, 0, 0).zoom, graphLib.ZOOM_MAX, 'zoom clamps at the maximum');
  assert.equal(graphLib.zoomAt(vp, 0.001, 0, 0).zoom, graphLib.ZOOM_MIN, 'zoom clamps at the minimum');
  assert.equal(graphLib.zoomAt(vp, 1, 0, 0, true).zoom, 1);

  const fit = graphLib.fitViewport({ x: 0, y: 0, w: 1000, h: 500 }, 800, 600, { padding: 50 });
  assert.ok(Math.abs(fit.zoom - 0.7) < 1e-9);
  assert.ok(Math.abs(fit.x + 500 * fit.zoom - 400) < 1e-9, 'content is centred horizontally');
  const back = graphLib.worldToScreen(fit, 500, 250);
  assert.ok(Math.abs(back.x - 400) < 1e-9 && Math.abs(back.y - 300) < 1e-9);
  const small = graphLib.fitViewport({ x: 0, y: 0, w: 10, h: 10 }, 800, 600);
  assert.equal(small.zoom, 1, 'fit never zooms in past 100 % by default');
}

function testClipboard() {
  const b = build();
  const t = b.add('input.text', 100, 100, { text: 'hello' });
  const gen = b.add('image.generate', 400, 120);
  const other = b.add('input.text', 100, 400);
  b.graph = graphLib.connect(reg, b.graph, { node: t, port: 'text' }, { node: gen, port: 'prompt' }).graph;
  const tpl = b.add('text.template', 800, 400);
  b.graph = graphLib.connect(reg, b.graph, { node: other, port: 'text' }, { node: tpl, port: 'a' }).graph;
  b.graph = graphLib.addNote(b.graph, { x: 90, y: 90, text: 'note' }).graph;
  b.graph = graphLib.addGroup(b.graph, { x: 50, y: 50, w: 600, h: 300, title: 'G' }).graph;

  const clip = graphLib.copySelection(b.graph, { nodes: [t, gen], notes: ['t1'], groups: ['g1'] }, { workflowId: 'wf-1', sessionId: 's-1' });
  assert.equal(graphLib.isClipboard(clip), true);
  assert.equal(clip.edges.length, 1, 'only the edge between selected nodes travels');
  assert.equal(clip.sessionId, 's-1');
  assert.deepEqual(clip.origin, { x: 50, y: 50 });
  assert.equal(graphLib.copySelection(b.graph, { nodes: [] }), null);
  assert.equal(graphLib.isClipboard({ format: 'x' }), false);

  // JSON round trip (localStorage / system clipboard)
  const revived = JSON.parse(JSON.stringify(clip));
  const pasted = graphLib.paste(b.graph, revived, { x: 1000, y: 2000 });
  assert.equal(pasted.ids.nodes.length, 2);
  assert.deepEqual(pasted.ids.nodes, ['n5', 'n6'], 'fresh ids continue the numbering');
  assert.equal(pasted.graph.edges.length, 3, 'two original edges plus the pasted one');
  const newEdge = pasted.graph.edges[pasted.graph.edges.length - 1];
  assert.equal(newEdge.from.node, pasted.idMap[t]);
  assert.equal(newEdge.to.node, pasted.idMap[gen]);
  const pastedText = graphLib.getNode(pasted.graph, pasted.idMap[t]);
  assert.equal(pastedText.x, 1050, 'top-left lands on the paste position');
  assert.equal(pastedText.y, 2050);
  assert.equal(pastedText.params.text, 'hello');
  assert.equal(pasted.ids.notes.length, 1);
  assert.equal(pasted.ids.groups.length, 1);
  // clipboard payload is not mutated by pasting
  assert.equal(revived.nodes[0].id, t);

  // reserved ids are respected
  const reserved = graphLib.paste(b.graph, revived, { x: 0, y: 0 }, { reserved: new Set(['n9']) });
  assert.deepEqual(reserved.ids.nodes, ['n10', 'n11']);

  // paste into an empty graph (other workflow)
  const foreign = graphLib.paste(graphLib.emptyGraph(), revived, { x: 0, y: 0 });
  assert.deepEqual(foreign.ids.nodes, ['n1', 'n2']);

  const dup = graphLib.duplicate(b.graph, { nodes: [gen] }, 32);
  assert.equal(dup.ids.nodes.length, 1);
  const copy = graphLib.getNode(dup.graph, dup.ids.nodes[0]);
  assert.equal(copy.x, 432);
  assert.equal(copy.y, 152);
  assert.equal(dup.graph.edges.length, b.graph.edges.length, 'duplicate keeps only internal edges (none here)');

  const removed = graphLib.removeSelection(b.graph, { nodes: [t], notes: ['t1'], groups: ['g1'] });
  assert.equal(removed.nodes.length, 3);
  assert.equal(removed.notes.length, 0);
  assert.equal(removed.groups.length, 0);
  assert.equal(removed.edges.length, 1, 'the edge of the removed node vanishes, the unrelated one stays');
}

function testNormalizeLoaded() {
  const raw = {
    nodes: [
      { id: 'n1', type: 'input.text', x: 'bad', y: 5, params: null },
      { id: 'n1', type: 'input.text', x: 1, y: 1 },
      { id: 'bad id', type: 'input.text' },
      { id: 'n2', type: 'image.generate', x: 10, y: 10, params: { prompt: 'x' } }
    ],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'prompt' } },
      { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'prompt' } },
      { id: 'e2', from: { node: 'n1', port: 'text' }, to: { node: 'zz', port: 'prompt' } },
      { id: 'e3', from: { node: 'n1', port: 'text' }, to: { node: 'n1', port: 'prompt' } }
    ],
    groups: [{ id: 'n1', title: 5, x: 1, y: 2, w: 1, h: 1, color: 'nonsense' }],
    notes: [{ id: 't1', text: null }],
    viewport: { x: 5, y: 6, zoom: 99 }
  };
  const graph = graphLib.normalizeLoaded(raw);
  assert.equal(graph.nodes.length, 2, 'duplicate and invalid node ids dropped');
  assert.equal(graph.nodes[0].x, 0);
  assert.deepEqual(graph.nodes[0].params, {});
  assert.equal(graph.edges.length, 1, 'duplicate, dangling and self edges dropped');
  assert.equal(graph.groups[0].id, 'g1', 'group id colliding with a node id is renamed');
  assert.equal(graph.groups[0].color, 'amber');
  assert.equal(graph.groups[0].title, '');
  assert.ok(graph.groups[0].w >= 80 && graph.groups[0].h >= 60);
  assert.equal(graph.notes[0].text, '');
  assert.equal(graph.viewport.zoom, graphLib.ZOOM_MAX);
  assert.deepEqual(graphLib.normalizeLoaded(null).nodes, []);
  assert.equal(graphLib.normalizeLoaded(undefined).viewport.zoom, 1);

  assert.deepEqual(graphLib.validate(reg, graph), []);
  const bad = {
    nodes: [{ id: 'a', type: 'input.text', params: {} }, { id: 'b', type: 'future.x', params: {} }, { id: 'c', type: 'video.trim', params: {} }],
    edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'c', port: 'video' } }, { id: 'e2', from: { node: 'a', port: 'nope' }, to: { node: 'c', port: 'video' } }],
    groups: [],
    notes: []
  };
  const codes = graphLib.validate(reg, bad).map((issue) => issue.code).sort();
  assert.deepEqual(codes, ['bad_port', 'incompatible', 'unknown_type']);
}

function testContentSnapshots() {
  const b = build();
  b.add('input.text', 1, 2);
  const snapshot = graphLib.content(b.graph);
  assert.ok(!('viewport' in snapshot), 'viewport is not part of undo snapshots');
  snapshot.nodes[0].x = 999;
  assert.equal(b.graph.nodes[0].x, 1, 'snapshot is a deep copy');
  const restored = graphLib.withContent({ ...b.graph, viewport: { x: 7, y: 8, zoom: 2 } }, snapshot);
  assert.equal(restored.nodes[0].x, 999);
  assert.deepEqual(restored.viewport, { x: 7, y: 8, zoom: 2 }, 'restore keeps the current viewport');
  assert.equal(graphLib.sameContent(b.graph, { ...b.graph, viewport: { x: 1, y: 1, zoom: 1 } }), true);
  assert.equal(graphLib.sameContent(b.graph, restored), false);
}

function testFuzzyAndPalette() {
  const f = graphLib.fuzzyScore;
  assert.equal(f('', 'anything'), 1);
  assert.ok(f('gen', 'Generate image') > f('image', 'Generate image') - 1);
  assert.ok(f('gen', 'Generate image') > f('ner', 'Generate image'), 'word start beats inner substring');
  assert.ok(f('gimg', 'generate image') > 0, 'subsequence matches');
  assert.equal(f('zzz', 'generate image'), 0);
  assert.ok(f('gen ima', 'generate image') > 0, 'all tokens must match');
  assert.equal(f('gen zzz', 'generate image'), 0);
  assert.equal(f('xy', 'generate'), 0, 'short tokens need a real substring');

  // dragging from a text output: nodes with a text input
  const fromText = graphLib.compatibleTargets(reg, 'out', 'text');
  const types = new Set(fromText.map((entry) => entry.type));
  assert.ok(types.has('image.generate'));
  assert.ok(types.has('llm.chat'));
  assert.ok(!types.has('input.text'), 'input nodes have no inputs');
  assert.ok(!types.has('image.crop'), 'image.crop has no text port');
  const gen = fromText.find((entry) => entry.type === 'image.generate');
  assert.equal(gen.portId, 'prompt');
  // an image output finds image consumers via port variants as well
  const fromImage = graphLib.compatibleTargets(reg, 'out', 'image');
  const removeBg = fromImage.find((entry) => entry.type === 'hf.remove_background');
  assert.ok(removeBg && removeBg.portId === 'media');
  const fromVideo = graphLib.compatibleTargets(reg, 'out', 'video');
  const removeBgVideo = fromVideo.find((entry) => entry.type === 'hf.remove_background');
  assert.deepEqual(removeBgVideo.params, { kind: 'video' }, 'the variant that fits is preselected');
  // dragging from an image input backwards: producers of images
  const producers = new Set(graphLib.compatibleTargets(reg, 'in', 'image').map((entry) => entry.type));
  assert.ok(producers.has('input.image'));
  assert.ok(producers.has('image.generate'));
  assert.ok(producers.has('video.extract_frame'));
  assert.ok(!producers.has('input.text'));
  assert.deepEqual(graphLib.compatibleTargets(reg, 'out', 'bogus'), []);

  const node = { type: 'video.seedance', params: {} };
  const port = graphLib.firstCompatiblePort(reg, node, 'out', 'image');
  assert.ok(port && ['first_frame', 'refs'].includes(port.id), 'image output fits a seedance image input');
  assert.equal(graphLib.firstCompatiblePort(reg, { type: 'image.crop', params: {} }, 'out', 'text'), null);
  const back = graphLib.firstCompatiblePort(reg, { type: 'video.extract_frame', params: {} }, 'in', 'image');
  assert.equal(back.id, 'image');
}

// Palette entries the way palette.js builds them (label = English registry label, no i18n needed here).
function paletteEntries() {
  return reg.list.map((def) => ({
    key: def.type,
    type: def.type,
    category: def.category,
    label: def.label,
    search: [def.label, def.category, ...(def.keywords || []), def.type].join(' ')
  }));
}

function testPromptNodeRegistered() {
  const def = reg.types.get('input.prompt');
  assert.ok(def, 'input.prompt is in the registry');
  assert.equal(def.category, 'input');
  assert.deepEqual(def.outputs, [{ id: 'prompt', type: 'text' }]);
  assert.ok(reg.types.has('input.text'), 'input.text stays for saved workflows');
  const inputs = reg.list.filter((entry) => entry.category === 'input');
  assert.equal(inputs[0].type, 'input.prompt', 'Prompt is the first node of the input category');
}

function testPaletteRanking() {
  const entries = paletteEntries();
  // browsing the palette: "Inputs" first, Prompt at the very top
  assert.equal(graphLib.rankPaletteEntries(reg, entries)[0].type, 'input.prompt');
  // searching "prompt": the Prompt node beats "Text input" (which only has the keyword)
  const search = graphLib.rankPaletteEntries(reg, entries, { query: 'prompt' }).map((entry) => entry.type);
  assert.equal(search[0], 'input.prompt');
  assert.ok(search.indexOf('input.prompt') < search.indexOf('input.text'));
}

function testQuickPick() {
  const entries = paletteEntries();
  const rank = (dir, type, options = {}) => graphLib.rankPaletteEntries(reg, entries, { filter: { dir, type }, ...options });

  // dragging from an unconnected text input: producers of text, Prompt on top
  const fromTextInput = rank('in', 'text');
  assert.equal(fromTextInput[0].type, 'input.prompt', 'Prompt first for a text input');
  assert.equal(fromTextInput[0].compat.portId, 'prompt');
  const producers = new Set(fromTextInput.map((entry) => entry.type));
  assert.ok(producers.has('input.text') && producers.has('llm.chat'), 'other text producers stay available');
  assert.ok(!producers.has('image.crop'), 'image.crop has no text output');
  assert.ok(!producers.has('output.result'), 'output nodes produce nothing');
  assert.equal(rank('in', 'text', { query: 'prompt' })[0].type, 'input.prompt');
  // no Prompt boost for other types, and Prompt is not offered for an image input
  assert.ok(!rank('in', 'image').some((entry) => entry.type === 'input.prompt'), 'a text output does not fit an image input');
  assert.equal(rank('in', 'image')[0].type, 'input.image', 'exact matches lead for image inputs');
  // dragging from an output: only nodes with a compatible input, no Prompt (it has no inputs)
  const fromImageOutput = rank('out', 'image').map((entry) => entry.type);
  assert.ok(fromImageOutput.includes('image.crop'));
  assert.ok(!fromImageOutput.includes('input.prompt') && !fromImageOutput.includes('input.image'));
  const fromTextOutput = rank('out', 'text').map((entry) => entry.type);
  assert.ok(fromTextOutput.includes('image.generate') && !fromTextOutput.includes('image.crop'), 'incompatible types are filtered out');
  // the filter honours the compatibility matrix (video does not fit an image input)
  assert.ok(!rank('out', 'video').some((entry) => entry.type === 'image.crop'));
  // category chips still narrow the quick pick
  assert.ok(rank('in', 'text', { category: 'llm' }).every((entry) => entry.category === 'llm'));
  // pure targets used by the ranking
  const targets = graphLib.quickPickTargets(reg, 'in', 'text');
  assert.equal(targets[0].type, 'input.prompt');
  assert.deepEqual(graphLib.quickPickTargets(reg, 'in', 'bogus'), []);
}

function testExtractPrompt() {
  const b = build();
  const gen = b.add('image.generate', 600, 200, { prompt: 'a lighthouse at dawn' });
  const before = b.graph;
  const nodeCount = before.nodes.length;

  assert.equal(graphLib.canExtractTextParam(reg, before, gen, 'prompt'), true);
  const result = graphLib.extractTextParamToNode(reg, before, gen, 'prompt');
  assert.ok(!result.error);
  assert.equal(result.graph.nodes.length, nodeCount + 1);
  assert.equal(result.node.type, 'input.prompt');
  assert.equal(result.node.params.prompt, 'a lighthouse at dawn', 'the text moves into the Prompt node');
  assert.equal(graphLib.getNode(result.graph, gen).params.prompt, '', 'the param of the target is cleared');
  assert.equal(result.graph.edges.length, 1);
  assert.deepEqual(result.graph.edges[0].from, { node: result.node.id, port: 'prompt' });
  assert.deepEqual(result.graph.edges[0].to, { node: gen, port: 'prompt' });
  assert.deepEqual(graphLib.validate(reg, result.graph), []);
  // placed to the left of the target, at its height, without covering it
  assert.ok(result.node.x + 340 < 600, 'ends left of the target card');
  assert.equal(result.node.y, 200);
  // the input is connected now: extracting again is refused
  assert.equal(graphLib.canExtractTextParam(reg, result.graph, gen, 'prompt'), false);
  const again = graphLib.extractTextParamToNode(reg, result.graph, gen, 'prompt');
  assert.equal(again.error.reason, 'connected');
  assert.equal(again.graph, result.graph, 'a refused extraction returns the graph unchanged');
  // input already connected before: refused, nothing changes
  const text = b.add('input.text', 100, 0, { text: 'x' });
  const wired = graphLib.connect(reg, b.graph, { node: text, port: 'text' }, { node: gen, port: 'prompt' });
  assert.equal(graphLib.extractTextParamToNode(reg, wired.graph, gen, 'prompt').error.reason, 'connected');
  // only text inputs backed by a textarea qualify
  const dur = b.add('image.to_video', 900, 0);
  assert.equal(graphLib.extractTextParamIssue(reg, b.graph, dur, 'duration'), 'not_extractable', 'number inputs are not extractable');
  assert.equal(graphLib.extractTextParamIssue(reg, b.graph, gen, 'nope'), 'unknown_port');
  assert.equal(graphLib.extractTextParamIssue(reg, b.graph, 'zz', 'prompt'), 'unknown_node');
  const html = b.add('video.motion_graphics', 900, 300);
  assert.equal(graphLib.extractTextParamIssue(reg, b.graph, html, 'html'), 'not_extractable', 'code fields are not extractable');
  // a registry without the Prompt type refuses gracefully
  const noPrompt = { ...reg, types: new Map([...reg.types].filter(([type]) => type !== 'input.prompt')) };
  assert.equal(graphLib.extractTextParamIssue(noPrompt, b.graph, gen, 'prompt'), 'no_prompt_type');
  // explicit ids and position are honoured
  const custom = graphLib.extractTextParamToNode(reg, before, gen, 'prompt', { newNodeId: 'p9', edgeId: 'e9', position: { x: -80, y: 16 } });
  assert.equal(custom.node.id, 'p9');
  assert.equal(custom.edge.id, 'e9');
  assert.deepEqual([custom.node.x, custom.node.y], [-80, 16]);
  // an occupied spot is avoided: another card sits where the Prompt node would land
  const c = build();
  const target = c.add('image.generate', 600, 200, { prompt: 'p' });
  const blocker = c.add('input.text', 204, 200);
  const nudged = graphLib.extractTextParamToNode(reg, c.graph, target, 'prompt');
  const blockerRect = graphLib.nodeRect(graphLib.getNode(c.graph, blocker));
  assert.equal(graphLib.rectsIntersect({ x: nudged.node.x, y: nudged.node.y, w: 340, h: 200 }, blockerRect), false, 'does not land on top of another card');
  // one undo step restores everything (history snapshots of before / after)
  const history = require('../public/nodes/history').createHistory({ now: () => 0 });
  history.reset(graphLib.content(before));
  history.commit(graphLib.content(result.graph), { label: 'extract-prompt' });
  assert.equal(history.size, 2, 'the extraction is a single history entry');
  const undone = graphLib.withContent(result.graph, history.undo());
  assert.equal(undone.nodes.length, nodeCount);
  assert.equal(graphLib.getNode(undone, gen).params.prompt, 'a lighthouse at dawn', 'undo restores the text in the target');
  assert.equal(undone.edges.length, 0, 'undo removes the edge');
  assert.equal(graphLib.sameContent(undone, before), true);
  const redone = graphLib.withContent(undone, history.redo());
  assert.equal(graphLib.sameContent(redone, result.graph), true);
}

function testQuickPickCreatesConnectedNode() {
  // What main.js does after a pick: add the node and connect it to the first compatible port, as one graph.
  const b = build();
  const gen = b.add('image.generate', 600, 200);
  const added = graphLib.addNode(reg, b.graph, 'input.prompt', { x: 300, y: 180 });
  const port = graphLib.firstCompatiblePort(reg, added.node, 'in', 'text');
  assert.equal(port.id, 'prompt');
  const linked = graphLib.connect(reg, added.graph, { node: added.node.id, port: port.id }, { node: gen, port: 'prompt' });
  assert.ok(!linked.error);
  assert.equal(linked.graph.edges.length, 1);
  assert.deepEqual(graphLib.validate(reg, linked.graph), []);
}

function testShowIf() {
  const def = reg.types.get('video.seedance');
  const node = { type: 'video.seedance', params: {} };
  const aspect = def.params.find((param) => param.id === 'aspect_ratio');
  assert.equal(graphLib.isVisible(aspect.showIf, node, def, new Set()), true, 'visible while first_frame is not connected');
  assert.equal(graphLib.isVisible(aspect.showIf, node, def, new Set(['first_frame'])), false, 'hidden once first_frame is connected');
  // H3 Max video: the ratio is hidden as soon as a first OR a last frame is connected
  const h3 = reg.types.get('fal.h3_video');
  const h3Aspect = h3.params.find((param) => param.id === 'aspect_ratio');
  const h3Node = { type: 'fal.h3_video', params: {} };
  assert.equal(graphLib.isVisible(h3Aspect.showIf, h3Node, h3, new Set()), true);
  assert.equal(graphLib.isVisible(h3Aspect.showIf, h3Node, h3, new Set(['first_frame'])), false);
  assert.equal(graphLib.isVisible(h3Aspect.showIf, h3Node, h3, new Set(['last_frame'])), false);
  assert.equal(graphLib.isVisible(h3Aspect.showIf, h3Node, h3, new Set(['audio'])), true);
  const crop = reg.types.get('image.crop');
  const width = crop.params.find((param) => param.id === 'width');
  assert.equal(graphLib.isVisible(width.showIf, { type: 'image.crop', params: { mode: 'pixels' } }, crop, new Set()), true);
  assert.equal(graphLib.isVisible(width.showIf, { type: 'image.crop', params: { mode: 'aspect' } }, crop, new Set()), false);
  assert.equal(graphLib.isVisible(undefined, node, def, new Set()), true);
}

function testEveryTypeCanBePlaced() {
  // Registry-driven UI: every node type must be addable and expose its ports without exceptions.
  let graph = graphLib.emptyGraph();
  for (const def of reg.list) {
    const out = graphLib.addNode(reg, graph, def.type, {});
    graph = out.graph;
    const ports = graphLib.portsFor(reg, out.node);
    assert.ok(Array.isArray(ports.inputs) && Array.isArray(ports.outputs), def.type);
    for (const param of def.params) assert.ok(param.id in out.node.params, `${def.type}.${param.id} has a default`);
  }
  assert.equal(graph.nodes.length, reg.list.length);
  assert.deepEqual(graphLib.validate(reg, graph), []);
}

const tests = [
  testRegistryIndex,
  testTypeCompat,
  testConnect,
  testCyclesAndReach,
  testNodeMutations,
  testPruneEdges,
  testGroupsAndNotes,
  testGeometry,
  testClipboard,
  testNormalizeLoaded,
  testContentSnapshots,
  testFuzzyAndPalette,
  testPromptNodeRegistered,
  testPaletteRanking,
  testQuickPick,
  testExtractPrompt,
  testQuickPickCreatesConnectedNode,
  testShowIf,
  testEveryTypeCanBePlaced
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`graph ok: ${tests.length} Gruppen, ${reg.types.size} Node-Typen geprueft`);
