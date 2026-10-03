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
  assert.deepEqual(defaults, { model: '', prompt: '', aspect_ratio: '1:1', count: 1 });
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
  assert.deepEqual(node.params, { model: '', prompt: 'hello', aspect_ratio: '1:1', count: 3 }, 'defaults merged with overrides');
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

// Sub graph with links (the assistant): connections between new nodes and to existing ones, checked one by one against
// the graph as it is, never replacing anything.
function testInsertSubgraphLinks() {
  const b = build();
  const prompt = b.add('input.prompt', 40, 40, { prompt: 'Ein Fuchs' });
  const video = b.add('video.generate', 400, 40);
  const result = b.add('output.result', 800, 40);
  b.graph = graphLib.connect(reg, b.graph, { node: prompt, port: 'prompt' }, { node: video, port: 'prompt' }).graph;
  b.graph = graphLib.connect(reg, b.graph, { node: video, port: 'video' }, { node: result, port: 'inputs' }).graph;
  const before = b.graph;
  const snapshot = JSON.stringify(before);

  // new nodes, a link between them and one to a free input of an existing node
  const sub = {
    nodes: [
      { id: 'a1', type: 'input.prompt', x: 0, y: 0, params: { prompt: 'Titel' }, title: 'Titelidee' },
      { id: 'a2', type: 'image.generate', x: 380, y: 0, params: { prompt: 'Titel' } }
    ],
    links: [
      { from: { node: 'a1', port: 'prompt' }, to: { node: 'a2', port: 'prompt' } },
      { from: { node: 'a2', port: 'image' }, to: { node: video, port: 'first_frame', existing: true } }
    ]
  };
  const done = graphLib.insertSubgraph(before, sub, { reg, center: { x: 0, y: 0 } });
  assert.equal(done.error, undefined);
  assert.deepEqual(done.skippedLinks, []);
  assert.equal(done.graph.nodes.length, before.nodes.length + 2);
  assert.equal(done.graph.edges.length, before.edges.length + 2);
  assert.equal(done.ids.edges.length, 2, 'the links count as new edges');
  const added = done.graph.edges.slice(-2).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  assert.deepEqual(added, [`${done.idMap.a1}.prompt>${done.idMap.a2}.prompt`, `${done.idMap.a2}.image>${video}.first_frame`]);
  assert.equal(done.graph.nodes.find((node) => node.id === done.idMap.a1).title, 'Titelidee');
  assert.deepEqual(graphLib.validate(reg, done.graph), []);
  // what was there stays exactly as it was (same objects, same order)
  assert.equal(JSON.stringify(before), snapshot, 'the graph that went in is not changed');
  before.nodes.forEach((node, index) => assert.equal(done.graph.nodes[index], node));
  before.edges.forEach((edge, index) => assert.equal(done.graph.edges[index], edge));

  // a link from an existing output into a new node
  const fromExisting = graphLib.insertSubgraph(before, { nodes: [{ id: 'z', type: 'llm.chat', x: 0, y: 0, params: {} }], links: [{ from: { node: prompt, port: 'prompt', existing: true }, to: { node: 'z', port: 'prompt' } }] }, { reg });
  assert.deepEqual(fromExisting.skippedLinks, []);
  assert.equal(fromExisting.graph.edges.at(-1).from.node, prompt);
  assert.equal(fromExisting.graph.edges.at(-1).to.node, fromExisting.idMap.z);

  // refused links are skipped and named, the rest goes in; nothing is replaced or removed
  const mixed = graphLib.insertSubgraph(
    before,
    {
      nodes: [{ id: 'a', type: 'image.generate', x: 0, y: 0, params: { prompt: 'x' } }],
      links: [
        { from: { node: 'a', port: 'image' }, to: { node: video, port: 'prompt', existing: true } }, // text input already connected, wrong type as well
        { from: { node: 'a', port: 'image' }, to: { node: video, port: 'first_frame', existing: true } }, // fine
        { from: { node: 'a', port: 'image' }, to: { node: video, port: 'first_frame', existing: true } }, // the same again
        { from: { node: video, port: 'video', existing: true }, to: { node: prompt, port: 'prompt', existing: true } }, // nothing goes into a Prompt node
        { from: { node: 'a', port: 'nothing' }, to: { node: result, port: 'inputs', existing: true } },
        { from: { node: 'ghost', port: 'image' }, to: { node: result, port: 'inputs', existing: true } },
        { from: { node: 'a', port: 'image' }, to: { node: 'missing', port: 'inputs', existing: true } },
        { from: { node: 'a', port: 'image' } }
      ]
    },
    { reg }
  );
  assert.deepEqual(mixed.skippedLinks.map((item) => [item.index, item.code]), [[0, 'incompatible'], [2, 'duplicate'], [3, 'no_input'], [4, 'no_output'], [5, 'unknown_node'], [6, 'unknown_node'], [7, 'unknown_node']]);
  assert.equal(mixed.graph.edges.length, before.edges.length + 1);
  assert.equal(mixed.ids.edges.length, 1);

  // a taken single input is never taken over (connect() alone would replace it)
  const taken = graphLib.insertSubgraph(before, { nodes: [{ id: 't', type: 'input.prompt', x: 0, y: 0, params: { prompt: 'andere Idee' } }], links: [{ from: { node: 't', port: 'prompt' }, to: { node: video, port: 'prompt', existing: true } }] }, { reg });
  assert.deepEqual(taken.skippedLinks, [{ index: 0, code: 'input_taken' }]);
  assert.equal(taken.graph.edges.length, before.edges.length);
  assert.ok(taken.graph.edges.some((edge) => edge.from.node === prompt && edge.to.node === video && edge.to.port === 'prompt'), 'the old connection is still there');

  // a loop is refused as well
  const loop = graphLib.insertSubgraph(before, { nodes: [{ id: 'l', type: 'llm.chat', x: 0, y: 0, params: {} }], links: [{ from: { node: result, port: 'inputs', existing: true }, to: { node: 'l', port: 'prompt' } }] }, { reg });
  assert.equal(loop.skippedLinks.length, 1);

  // a multiple input takes several links, in the order given
  const multi = graphLib.insertSubgraph(before, { nodes: [{ id: 'i1', type: 'image.generate', x: 0, y: 0, params: { prompt: 'a' } }, { id: 'i2', type: 'image.generate', x: 0, y: 400, params: { prompt: 'b' } }], links: [{ from: { node: 'i1', port: 'image' }, to: { node: result, port: 'inputs', existing: true } }, { from: { node: 'i2', port: 'image' }, to: { node: result, port: 'inputs', existing: true } }] }, { reg });
  assert.deepEqual(multi.skippedLinks, []);
  assert.deepEqual(multi.graph.edges.slice(-2).map((edge) => edge.from.node), [multi.idMap.i1, multi.idMap.i2]);

  // no new items, only links between existing nodes: allowed while the input is free
  const only = graphLib.insertSubgraph(before, { nodes: [], links: [{ from: { node: prompt, port: 'prompt', existing: true }, to: { node: result, port: 'inputs', existing: true } }] }, { reg });
  assert.equal(only.error, undefined);
  assert.deepEqual(only.ids.nodes, []);
  assert.equal(only.ids.edges.length, 1);
  assert.equal(only.bounds, null);
  assert.equal(only.graph.nodes, before.nodes, 'no node was touched');
  assert.equal(graphLib.insertSubgraph(before, { nodes: [], links: [] }, { reg }).error.reason, 'empty');
  // without a registry the links are not trusted: nothing to do
  assert.equal(graphLib.insertSubgraph(before, { nodes: [], links: [{ from: { node: prompt, port: 'prompt', existing: true }, to: { node: result, port: 'inputs', existing: true } }] }, {}).error.reason, 'empty');
  // an id that happens to be a property name of Object is not a node of the sub graph
  const proto = graphLib.insertSubgraph(before, { nodes: [{ id: 'a', type: 'image.generate', x: 0, y: 0, params: { prompt: 'x' } }], links: [{ from: { node: 'constructor', port: 'image' }, to: { node: result, port: 'inputs', existing: true } }] }, { reg });
  assert.deepEqual(proto.skippedLinks.map((item) => item.code), ['unknown_node']);
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

// WP21: search normal form, scattered letters only as a late fallback, stop words, structured entries.
function testSearchRules() {
  const norm = graphLib.normalizeSearch;
  assert.equal(norm('KI-Video'), 'ki video');
  assert.equal(norm('  Vídeo   Über Grösse '), 'video uber grosse', 'accents and case are gone, the rest stays');
  assert.equal(norm('fal.ai'), 'fal ai');
  assert.equal(norm(null), '');
  const f = graphLib.fuzzyScore;
  assert.equal(f('vid', 'KI-Video'), 100, 'a word start inside a hyphenated word');
  assert.equal(f('video', 'Vídeo erzeugen'), 100, 'accents do not matter');
  assert.equal(f('xyz', 'abc'), 0);
  assert.equal(f('gen', 'abc'), 0);
  assert.equal(f('ger', 'generate image'), 0, 'three scattered letters never match');
  assert.ok(f('gnrt', 'generate image') > 0 && f('gnrt', 'generate image') < 60, 'four scattered letters from a word start still match, weakly');
  assert.equal(f('nrte', 'generate image'), 0, 'scattered letters must start at the start of a word');

  const entry = (label, keywords = [], search = '') => ({ type: 'x', category: 'video', label, labels: [label], keywords, search });
  const rank = (entries, query) => graphLib.rankPaletteEntries(reg, entries, { query }).map((item) => item.label);
  // names beat synonyms beat the rest
  assert.deepEqual(rank([entry('Other', [], 'clip'), entry('Third', ['clip']), entry('Clip maker')], 'clip'), ['Clip maker', 'Third', 'Other']);
  // the whole phrase counts: a node with "Bild zu Video" as a synonym beats one that has both words apart
  assert.deepEqual(rank([entry('Bild aus Video'), entry('Maker', ['Bild zu Video'])], 'bild zu video'), ['Maker', 'Bild aus Video']);
  // stop words glue the phrase but do not have to match alone
  assert.deepEqual(rank([entry('Seedance', ['Text zu Video'])], 'text zu video'), ['Seedance']);
  assert.deepEqual(rank([entry('Seedance', ['Text zu Video']), entry('Zoom')], 'zu'), ['Seedance'], 'a stop word alone is searched as it is');
  // earlier synonyms count a little more
  assert.deepEqual(rank([entry('B', ['foo', 'bar']), entry('A', ['bar', 'foo'])], 'bar baz'), [], 'every word must match');
  assert.deepEqual(rank([entry('Late', ['x1', 'x2', 'x3', 'animieren']), entry('Early', ['animieren'])], 'animieren'), ['Early', 'Late']);
  // scattered letters only as long as fewer than three entries match for real
  const few = [entry('Seedance'), entry('Other')];
  assert.deepEqual(rank(few, 'sedance'), ['Seedance']);
  const many = [entry('Sedance one'), entry('Sedance two'), entry('Sedance three'), entry('Seedance')];
  assert.deepEqual(rank(many, 'sedance').sort(), ['Sedance one', 'Sedance three', 'Sedance two']);
  // old entries with a plain search text keep working
  const plain = [{ type: 'a', category: 'x', label: 'Alpha', search: 'Alpha beta' }, { type: 'b', category: 'x', label: 'Beta', search: 'Beta' }];
  assert.deepEqual(graphLib.rankPaletteEntries(reg, plain, { query: 'beta' }).map((item) => item.label), ['Beta', 'Alpha']);
  assert.deepEqual(graphLib.rankPaletteEntries(reg, plain, { query: '  ' }).length, 2, 'a blank search shows everything');
  assert.deepEqual(graphLib.rankPaletteEntries(reg, plain, { query: '-' }).length, 2, 'a search without letters shows everything');

  // models: own limit, hint count, never without a search text in All
  const nodes = [{ ...entry('Video node'), type: 'video.higgsfield' }];
  const models = [];
  for (let i = 0; i < 50; i += 1) models.push({ ...entry(`Video model ${i}`), model: true, type: 'video.higgsfield', category: 'higgsfield' });
  const all = [...nodes, ...models];
  const found = graphLib.rankPaletteEntries(reg, all, { query: 'video', modelLimit: 30 });
  assert.equal(found.length, 31);
  assert.equal(found.hiddenModels, 20);
  assert.equal(found[0].label, 'Video node', 'the node leads on a tie');
  assert.equal(graphLib.rankPaletteEntries(reg, all, {}).length, 1, 'no models in All without a search text');
  assert.equal(graphLib.rankPaletteEntries(reg, all, { category: 'video' }).length, 1);
  assert.equal(graphLib.rankPaletteEntries(reg, all, { category: 'higgsfield', modelLimit: 90 }).length, 50, 'their own chip lists them');
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
  // the lead of a first output only decides between nodes that are equally usable: a node that cannot run here
  // does not move ahead of one that can
  {
    const fake = JSON.parse(JSON.stringify(payload));
    const base = { category: 'input', params: [], inputs: [], keywords: [] };
    fake.nodeTypes.push(
      { ...base, type: 'test.side', label: 'Side image', available: true, outputs: [{ id: 'text', type: 'text' }, { id: 'image', type: 'image' }] },
      { ...base, type: 'test.lead', label: 'Lead image', available: 'not set up', outputs: [{ id: 'image', type: 'image' }] },
      { ...base, type: 'test.lead_ok', label: 'Lead image ready', available: true, outputs: [{ id: 'image', type: 'image' }] }
    );
    const fakeReg = graphLib.indexRegistry(fake);
    const fakeEntries = fakeReg.list.filter((def) => def.type.startsWith('test.')).map((def) => ({ key: def.type, type: def.type, category: def.category, label: def.label, search: def.label }));
    const order = graphLib.rankPaletteEntries(fakeReg, fakeEntries, { filter: { dir: 'in', type: 'image' } }).map((entry) => entry.type);
    assert.deepEqual(order, ['test.lead_ok', 'test.side', 'test.lead'], 'usable first, then the lead, then the rest');
  }
  // pure targets used by the ranking
  const targets = graphLib.quickPickTargets(reg, 'in', 'text');
  assert.equal(targets[0].type, 'input.prompt');
  assert.deepEqual(graphLib.quickPickTargets(reg, 'in', 'bogus'), []);
}

// "Put a node in front" / "insert with inputs" (WP23): which source an input gets, what is missing, how the block is laid out.
function testInputSources() {
  const typeOf = (graph, id) => graph.nodes.find((node) => node.id === id).type;
  const portOf = (type, id) => reg.types.get(type).inputs.find((port) => port.id === id);

  // sourceFor: the hint of the registry first, else the input node of the base type
  assert.deepEqual(graphLib.sourceFor(reg, portOf('video.motion_graphics', 'html')), { type: 'llm.motion_html', port: 'html', hinted: true });
  assert.deepEqual(graphLib.sourceFor(reg, portOf('image.edit', 'prompt')), { type: 'input.prompt', port: 'prompt', hinted: false });
  assert.equal(graphLib.sourceFor(reg, portOf('image.edit', 'images')).type, 'input.image');
  assert.equal(graphLib.sourceFor(reg, { id: 'x', type: 'any' }), null, 'no source for any');
  assert.equal(graphLib.sourceFor(reg, { id: 'x', type: 'image[]' }), null, 'no single input node makes a list');
  assert.equal(graphLib.sourceFor(reg, { id: 'x', type: 'text', suggest: 'no.such_type' }).type, 'input.prompt', 'a hint to an unknown type falls back');

  // the case: a video on "Assets" of "Motion graphics from HTML", the HTML field empty
  const b = build();
  const video = b.add('input.video', 0, 0);
  const writerless = b.add('video.motion_graphics', 500, 0, { html: '' });
  b.graph = graphLib.connect(reg, b.graph, { node: video, port: 'video' }, { node: writerless, port: 'assets' }).graph;
  assert.deepEqual(graphLib.missingInputs(reg, b.graph, writerless).map((port) => port.id), ['html']);
  assert.deepEqual(graphLib.missingInputs(reg, b.graph, 'nope'), []);
  const filled = graphLib.setParams(b.graph, writerless, { html: '<div></div>' });
  assert.deepEqual(graphLib.missingInputs(reg, filled, writerless), [], 'a typed value fills a text input');

  const fix = graphLib.addInputSources(reg, b.graph, writerless);
  assert.ok(!fix.error);
  assert.deepEqual(fix.nodes.map((node) => node.type), ['llm.motion_html', 'input.prompt'], 'writer, and the prompt it needs');
  const [writer, prompt] = fix.nodes;
  assert.deepEqual(fix.supplied, [{ port: 'html', node: writer.id }]);
  const pairs = fix.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`).sort();
  assert.deepEqual(pairs, [`${prompt.id}.prompt>${writer.id}.brief`, `${video}.video>${writer.id}.assets`, `${writer.id}.html>${writerless}.html`].sort(), 'the assets go to the writer too');
  assert.equal(fix.graph.edges.length, b.graph.edges.length + 3);
  assert.equal(graphLib.missingInputs(reg, fix.graph, writerless).length, 0, 'the node is complete afterwards');
  assert.equal(graphLib.missingInputs(reg, fix.graph, writer.id).length, 0);
  assert.equal(new Set(fix.graph.nodes.map((node) => node.id)).size, fix.graph.nodes.length, 'unique ids');
  assert.deepEqual(graphLib.validate(reg, fix.graph), [], 'typed edges stay valid');
  for (const edge of fix.edges) assert.equal(graphLib.checkConnection(reg, { ...fix.graph, edges: fix.graph.edges.filter((item) => item.id !== edge.id) }, edge.from, edge.to), null, `${edge.id} is an allowed connection`);
  // laid out to the left of the node, not on top of anything
  assert.ok(fix.nodes.every((node) => node.x < fix.graph.nodes.find((item) => item.id === writerless).x));
  const boxes = fix.graph.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, w: graphLib.DEFAULT_NODE_SIZE.w, h: graphLib.DEFAULT_NODE_SIZE.h }));
  for (const first of boxes) for (const second of boxes) {
    if (first.id >= second.id) continue;
    assert.ok(first.x + first.w <= second.x || second.x + second.w <= first.x || first.y + first.h <= second.y || second.y + second.h <= first.y, `${first.id} and ${second.id} overlap`);
  }
  // the original graph is untouched (immutability)
  assert.equal(b.graph.nodes.length, 2);
  // only the asked ports
  assert.equal(graphLib.addInputSources(reg, b.graph, writerless, { ports: ['assets'] }).error.reason, 'no_source', 'assets are connected already');
  assert.deepEqual(graphLib.addInputSources(reg, b.graph, writerless, { ports: ['html'] }).supplied.map((item) => item.port), ['html']);

  // errors
  assert.equal(graphLib.addInputSources(reg, b.graph, 'zz').error.reason, 'unknown_node');
  const lone = build();
  const result = lone.add('output.result', 0, 0);
  assert.equal(graphLib.addInputSources(reg, lone.graph, result).error.reason, 'no_source', 'nothing to supply: any is not a source');

  // no hint: the input node of the base type, and a second call has nothing left to do
  const c = build();
  const edit = c.add('image.edit', 400, 100);
  const both = graphLib.addInputSources(reg, c.graph, edit);
  assert.deepEqual(both.nodes.map((node) => node.type).sort(), ['input.image', 'input.prompt']);
  assert.equal(graphLib.addInputSources(reg, both.graph, edit).error.reason, 'no_source');
  const onlyPrompt = graphLib.addInputSources(reg, c.graph, edit, { ports: ['prompt'] });
  assert.deepEqual(onlyPrompt.nodes.map((node) => node.type), ['input.prompt']);
  assert.equal(typeOf(onlyPrompt.graph, onlyPrompt.nodes[0].id), 'input.prompt');
  // reserved ids are not reused
  const reserved = graphLib.addInputSources(reg, c.graph, edit, { reserved: ['n2', 'n3', 'n4'] });
  assert.ok(reserved.nodes.every((node) => !['n1', 'n2', 'n3', 'n4'].includes(node.id)));

  // inputsSubgraph: "insert with inputs"
  const sub = graphLib.inputsSubgraph(reg, 'image.edit');
  assert.equal(sub.target, 'n1');
  assert.deepEqual(sub.nodes.map((node) => node.type), ['image.edit', 'input.prompt', 'input.image']);
  assert.equal(sub.nodes[0].x, 0);
  assert.ok(sub.nodes.slice(1).every((node) => node.x < 0), 'the sources stand to the left');
  assert.equal(sub.edges.length, 2);
  const inserted = graphLib.insertSubgraph(graphLib.emptyGraph(), sub, { reg, center: { x: 0, y: 0 } });
  assert.ok(!inserted.error);
  assert.equal(inserted.graph.nodes.length, 3);
  assert.equal(inserted.graph.edges.length, 2);
  const lonely = graphLib.inputsSubgraph(reg, 'input.prompt');
  assert.equal(lonely.nodes.length, 1, 'nothing to supply: the node alone');
  assert.equal(graphLib.inputsSubgraph(reg, 'no.such_type').error.reason, 'unknown_type');
  const motion = graphLib.inputsSubgraph(reg, 'video.motion_graphics');
  assert.deepEqual(motion.nodes.map((node) => node.type), ['video.motion_graphics', 'llm.motion_html', 'input.prompt'], 'the writer and its prompt');
  // a multiple input with a minimum gets that many sources: Concatenate videos needs two clips to run
  const concat = graphLib.inputsSubgraph(reg, 'video.concat');
  assert.deepEqual(concat.nodes.map((node) => node.type), ['video.concat', 'input.video', 'input.video'], 'two video inputs, not one');
  assert.equal(concat.edges.length, 2);
  assert.ok(concat.edges.every((edge) => edge.to.node === 'n1' && edge.to.port === 'clips' && edge.from.port === 'video'));
  assert.equal(new Set(concat.nodes.map((node) => `${node.x},${node.y}`)).size, 3, 'the cards do not stand on each other');
  const placedConcat = graphLib.insertSubgraph(graphLib.emptyGraph(), concat, { reg, center: { x: 0, y: 0 } });
  assert.ok(!placedConcat.error);
  assert.equal(graphLib.missingInputs(reg, placedConcat.graph, placedConcat.graph.nodes.find((node) => node.type === 'video.concat').id).length, 0, 'nothing is missing afterwards');
  const ownConcat = build();
  const concatId = ownConcat.add('video.concat', 400, 100);
  assert.equal(graphLib.addInputSources(reg, ownConcat.graph, concatId).supplied.length, 2, 'the fix of an empty Concatenate node supplies two clips');
  // the types with required inputs all produce a valid block
  for (const [type] of reg.types) {
    const block = graphLib.inputsSubgraph(reg, type);
    if (block.error) continue;
    const placed = graphLib.insertSubgraph(graphLib.emptyGraph(), block, { reg, center: { x: 0, y: 0 } });
    assert.ok(!placed.error, `${type}: ${JSON.stringify(placed.error)}`);
    assert.equal(placed.graph.edges.length, block.edges.length, `${type}: every edge survives`);
  }

  // the quick pick puts the hinted type first
  assert.equal(graphLib.quickPickTargets(reg, 'in', 'text', { prefer: 'llm.motion_html' })[0].type, 'llm.motion_html');
  assert.equal(graphLib.quickPickTargets(reg, 'in', 'text')[0].type, 'input.prompt');
}

// Media values the way the engine hands them around: assetId names the producing node, so the order is checkable.
function mediaValue(type, id) {
  return { type, sessionId: 's1', assetId: id, file: `${id}.png` };
}

function testDescribePort() {
  const engine = require('../lib/nodes/engine');
  const b = build();
  const ref = b.add('fal.h3_reference', 900, 0);
  const images = ['input.image', 'input.image', 'input.image'].map((type, index) => b.add(type, 0, index * 100));
  const prompt = b.add('input.prompt', 0, 400);
  // Connect in an order that differs from the node order: n3, n1, n2
  for (const id of [images[2], images[0], images[1]]) {
    const out = graphLib.connect(reg, b.graph, { node: id, port: 'image' }, { node: ref, port: 'images' });
    assert.ok(!out.error, 'connect');
    b.graph = out.graph;
  }
  b.graph = graphLib.connect(reg, b.graph, { node: prompt, port: 'prompt' }, { node: ref, port: 'prompt' }).graph;

  const d = graphLib.describePort(reg, b.graph, ref, 'in', 'images');
  assert.equal(d.direction, 'in');
  assert.equal(d.base, 'image');
  assert.equal(d.list, false);
  assert.equal(d.required, false, 'the reference images are optional');
  assert.equal(d.multiple, true);
  assert.equal(d.max, 9);
  assert.equal(d.count, 3);
  assert.equal(d.labelKey, 'nodes.port.images');
  assert.equal(d.typeKey, 'nodes.ptype.image');
  assert.deepEqual(d.text, graphLib.portDescriptionKeys('fal.h3_reference', 'images', 'image', 'in'));
  assert.equal(d.text.key, 'nodes.portdesc.fal.h3_reference.images');
  assert.deepEqual(graphLib.portDescriptionChain(d.text), [
    'nodes.portdesc.fal.h3_reference.images.in',
    'nodes.portdesc.fal.h3_reference.images',
    'nodes.portdesc.images.in',
    'nodes.portdesc.images',
    'nodes.portdesc.type.image.in'
  ]);
  assert.deepEqual(d.facts.map((fact) => fact.key), ['nodes.porttip.fact.multi', 'nodes.porttip.fact.multiListMediaMax', 'nodes.porttip.fact.orderImage'], 'three images: the fact about the numbers and how to change them');
  assert.deepEqual(d.facts[0].vars, { max: 9, count: 3 });

  // The connection order is the order resolveNodeInputs collects the items in (edge order of the graph).
  assert.deepEqual(d.connections.map((c) => c.nodeId), [images[2], images[0], images[1]]);
  assert.deepEqual(d.connections.map((c) => c.order), [1, 2, 3]);
  const ports = graphLib.portsFor(reg, graphLib.getNode(b.graph, ref));
  const outputsOf = (nodeId) => (images.includes(nodeId) ? { image: mediaValue('image', nodeId) } : { prompt: { type: 'text', value: 'x' } });
  const resolved = engine.resolveNodeInputs({ node: { id: ref }, ports, params: {}, edges: b.graph.edges, outputsOf, maxListItems: 100 });
  assert.deepEqual(resolved.inputs.images.items.map((item) => item.assetId), d.connections.map((c) => c.nodeId), 'tooltip order = engine order');
  assert.equal(d.connections[0].titled, false);
  assert.equal(d.connections[0].nodeTitle, 'Image input', 'registry label as long as the node has no title of its own');
  b.graph = graphLib.setTitle(b.graph, images[2], 'Product shot');
  const titled = graphLib.describePort(reg, b.graph, ref, 'in', 'images');
  assert.equal(titled.connections[0].nodeTitle, 'Product shot');
  assert.equal(titled.connections[0].titled, true);

  // A media list on a multi-input counts as one connection (and delivers all its items at once, see the fact).
  const list = b.add('input.media_list', 0, 600);
  b.graph = graphLib.connect(reg, b.graph, { node: list, port: 'items' }, { node: ref, port: 'images' }).graph;
  const withList = graphLib.describePort(reg, b.graph, ref, 'in', 'images');
  assert.equal(withList.count, 4);
  assert.equal(withList.connections[3].nodeType, 'input.media_list');
  assert.equal(withList.connections[3].list, true);
  assert.deepEqual(withList.connections.map((c) => c.order), [1, 2, 3, 4], 'nothing follows the list yet');
  assert.ok(!withList.facts.some((fact) => fact.key === 'nodes.porttip.fact.orderShift'));
  assert.deepEqual(withList.facts[1].vars, { max: 9 }, 'every list item counts toward the maximum');
  // Behind a list the positions are unknown (it counts with all of its items): no numbers, plus the shift hint.
  const extra = b.add('input.image', 0, 800);
  b.graph = graphLib.connect(reg, b.graph, { node: extra, port: 'image' }, { node: ref, port: 'images' }).graph;
  const behindList = graphLib.describePort(reg, b.graph, ref, 'in', 'images');
  assert.deepEqual(behindList.connections.map((c) => c.order), [1, 2, 3, 4, null]);
  assert.deepEqual(behindList.connections.map((c) => c.list), [false, false, false, true, false]);
  assert.ok(behindList.facts.some((fact) => fact.key === 'nodes.porttip.fact.orderShift'));
  b.graph = graphLib.disconnect(b.graph, behindList.connections[4].edgeId);

  // Required / optional, param fallback, single inputs
  const prompts = graphLib.describePort(reg, b.graph, ref, 'in', 'prompt');
  assert.equal(prompts.required, true);
  assert.equal(prompts.multiple, false);
  assert.deepEqual(prompts.facts.map((fact) => fact.key), ['nodes.porttip.fact.singleMap', 'nodes.porttip.fact.param']);
  assert.equal(prompts.connections.length, 1);
  assert.equal(prompts.connections[0].nodeType, 'input.prompt');
  const audios = graphLib.describePort(reg, b.graph, ref, 'in', 'audios');
  assert.equal(audios.count, 0);
  assert.deepEqual(audios.connections, []);
  assert.equal(audios.max, 3);

  // Outputs: no required flag, no connection list, list outputs explain the mapping
  const out = graphLib.describePort(reg, b.graph, ref, 'out', 'expanded_prompt');
  assert.equal(out.direction, 'out');
  assert.equal(out.required, null);
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.connections, []);
  assert.equal(out.text.key, 'nodes.portdesc.fal.h3_reference.expanded_prompt');
  assert.equal(out.text.dirKey, 'nodes.portdesc.fal.h3_reference.expanded_prompt.out');
  const listOut = graphLib.describePort(reg, b.graph, list, 'out', 'items');
  assert.equal(listOut.list, true);
  assert.equal(listOut.base, 'image');
  assert.deepEqual(listOut.facts.map((fact) => fact.key), ['nodes.porttip.fact.listOut']);

  // The "one run per item" hint belongs to single inputs of a scalar type only
  const pick = b.add('util.pick', 300, 600);
  assert.deepEqual(graphLib.describePort(reg, b.graph, pick, 'in', 'items').facts.map((fact) => fact.key), ['nodes.porttip.fact.listIn']);
  const dur = b.add('image.to_video', 600, 600);
  const durPort = graphLib.describePort(reg, b.graph, dur, 'in', 'duration');
  assert.deepEqual(durPort.facts.map((fact) => fact.key), ['nodes.porttip.fact.singleMap', 'nodes.porttip.fact.param']);
  for (const [type, port] of [['llm.chat', 'images'], ['audio.mix', 'tracks'], ['text.join', 'items'], ['util.router', 'inputs'], ['output.result', 'inputs']]) {
    const id = b.add(type, 0, 0);
    const info = graphLib.describePort(reg, b.graph, id, 'in', port);
    assert.equal(info.multiple, true, `${type}.${port}`);
    assert.ok(!info.facts.some((fact) => fact.key === 'nodes.porttip.fact.singleMap'), `${type}.${port} has no per-item hint`);
  }
  // no maximum: the unlimited wording, and a list fact without the media wording for non-media types
  const router = b.add('util.router', 0, 0);
  const routerInfo = graphLib.describePort(reg, b.graph, router, 'in', 'inputs');
  assert.equal(routerInfo.max, null);
  assert.deepEqual(routerInfo.facts.map((fact) => fact.key), ['nodes.porttip.fact.multiUnlimited', 'nodes.porttip.fact.multiList']);
  assert.equal(routerInfo.required, true);
  const join = b.add('text.join', 0, 0);
  const joinInfo = graphLib.describePort(reg, b.graph, join, 'in', 'items');
  assert.equal(joinInfo.facts[1].key, 'nodes.porttip.fact.multiList', 'text is not a media type');
  // an input without a param has no fallback fact
  const relight = b.add('image.relight', 0, 0);
  assert.ok(!graphLib.describePort(reg, b.graph, relight, 'in', 'image').facts.some((fact) => fact.key === 'nodes.porttip.fact.param'));

  // unknown things
  assert.equal(graphLib.describePort(reg, b.graph, 'nope', 'in', 'images'), null);
  assert.equal(graphLib.describePort(reg, b.graph, ref, 'in', 'nope'), null);
  assert.equal(graphLib.describePort(reg, b.graph, ref, 'out', 'images'), null, 'images is an input');
}

function testDescribePortTruncationAndVariants() {
  const b = build();
  const edit = b.add('image.edit', 900, 0);
  const sources = Array.from({ length: 8 }, (_unused, index) => b.add('input.image', 0, index * 50));
  for (const id of sources) b.graph = graphLib.connect(reg, b.graph, { node: id, port: 'image' }, { node: edit, port: 'images' }).graph;
  const d = graphLib.describePort(reg, b.graph, edit, 'in', 'images');
  assert.equal(d.count, 8);
  assert.equal(d.required, true);
  assert.equal(d.connections.length, graphLib.PORT_TIP_MAX_CONNECTIONS);
  assert.equal(d.moreConnections, 8 - graphLib.PORT_TIP_MAX_CONNECTIONS);
  assert.deepEqual(d.connections.map((c) => c.nodeId), sources.slice(0, graphLib.PORT_TIP_MAX_CONNECTIONS), 'the first connections are listed');
  assert.equal(d.facts[0].vars.count, 8, 'the count covers all connections');

  // portVariants: the type of the port follows the param
  const remove = b.add('hf.remove_background', 0, 0, { kind: 'video' });
  const video = graphLib.describePort(reg, b.graph, remove, 'in', 'media');
  assert.equal(video.base, 'video');
  assert.equal(video.required, true);
  const removeImage = b.add('hf.remove_background', 0, 0);
  const image = graphLib.describePort(reg, b.graph, removeImage, 'out', 'media');
  assert.equal(image.base, 'image');
  assert.equal(graphLib.describePort(reg, b.graph, remove, 'out', 'media').base, 'video');
  assert.deepEqual(graphLib.portDescriptionChain(video.text)[1], 'nodes.portdesc.hf.remove_background.media');
  const mediaList = b.add('input.media_list', 0, 0, { kind: 'audio' });
  assert.equal(graphLib.describePort(reg, b.graph, mediaList, 'out', 'items').base, 'audio');
  // a source node with a port of several outputs marks it
  const h3 = b.add('fal.h3_video', 0, 0);
  const sink = b.add('text.join', 0, 0);
  b.graph = graphLib.connect(reg, b.graph, { node: h3, port: 'expanded_prompt' }, { node: sink, port: 'items' }).graph;
  const joined = graphLib.describePort(reg, b.graph, sink, 'in', 'items');
  assert.equal(joined.connections[0].port, 'expanded_prompt');
  assert.equal(joined.connections[0].multiOutput, true);
}

function testQuickPickMultiMedia() {
  const entries = paletteEntries();
  const rank = (type, multiple, options = {}) => graphLib.rankPaletteEntries(reg, entries, { filter: { dir: 'in', type, multiple }, ...options });
  for (const kind of ['image', 'video', 'audio']) {
    const top = rank(kind, true).slice(0, 2);
    assert.deepEqual(top.map((entry) => entry.type), ['input.media_list', `input.${kind}`], `${kind}: media list, then the single input`);
    assert.deepEqual(top[0].compat.params, { kind }, 'the media list is created with the matching media type');
    // typing a search keeps the two on top for a query that matches both
    assert.ok(rank(kind, true, { query: 'input' }).slice(0, 4).some((entry) => entry.type === 'input.media_list'));
  }
  // the list also leads when the search matches something else better ("upload" is a keyword of the single input)
  const targets = graphLib.quickPickTargets(reg, 'in', 'image', { multiple: true });
  assert.equal(targets[0].type, 'input.media_list');
  assert.equal(targets[1].type, 'input.image');
  assert.ok(targets[0].rank > targets[1].rank && targets[1].rank > targets[2].rank);
  // no multiple: unchanged, exact matches by category order (the existing rule)
  const plain = graphLib.quickPickTargets(reg, 'in', 'image');
  assert.equal(plain.find((entry) => entry.type === 'input.media_list').rank, 2, 'no boost for a single input');
  assert.equal(rank('image', false)[0].type, 'input.image');
  // other multi-inputs: text keeps "Prompt first", any gets no media boost
  assert.equal(rank('text', true)[0].type, 'input.prompt');
  assert.ok(!graphLib.quickPickTargets(reg, 'in', 'any', { multiple: true }).some((entry) => entry.rank > 2), 'no boost for any');
  // dragging from an output is not affected
  const fromOutput = graphLib.rankPaletteEntries(reg, entries, { filter: { dir: 'out', type: 'image', multiple: true } });
  assert.ok(!fromOutput.some((entry) => entry.type === 'input.media_list'), 'the media list has no inputs');
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

// "Use as text" (WP30): the text result of an output becomes a Prompt node, the connections of that output move to it.
function testAdoptText() {
  const b = build();
  const planner = b.add('audio.music_plan', 100, 100, { prompt: 'a summer song' });
  const music = b.add('audio.music', 900, 100);
  const image = b.add('image.generate', 900, 500);
  let graph = b.graph;
  for (const [to, port] of [[music, 'plan'], [image, 'prompt']]) {
    const linked = graphLib.connect(reg, graph, { node: planner, port: 'plan' }, { node: to, port });
    assert.ok(!linked.error, `${to}.${port}`);
    graph = linked.graph;
  }
  const before = graph;
  const edgeIds = before.edges.map((edge) => edge.id);
  const songText = '+ indie pop\n\n[Verse | 20 s]\nA line';

  assert.equal(graphLib.adoptTextIssue(reg, before, planner, 'plan', songText), null);
  const result = graphLib.adoptTextAsPrompt(reg, before, planner, 'plan', songText);
  assert.ok(!result.error);
  assert.equal(result.node.type, 'input.prompt');
  assert.equal(result.node.params.prompt, songText, 'the text is taken over unchanged');
  assert.equal(result.graph.nodes.length, before.nodes.length + 1, 'one new node');
  assert.equal(result.graph.edges.length, before.edges.length, 'no edge is added or lost');
  assert.deepEqual(result.graph.edges.map((edge) => edge.id), edgeIds, 'same edges in the same order');
  assert.deepEqual(result.edges, edgeIds.filter((id) => before.edges.find((edge) => edge.id === id).from.node === planner), 'the moved edges are named');
  assert.equal(result.edges.length, 2);
  for (const edge of result.graph.edges.filter((item) => result.edges.includes(item.id))) {
    assert.deepEqual(edge.from, { node: result.node.id, port: 'prompt' }, 'now leaves the Prompt node');
    const was = before.edges.find((item) => item.id === edge.id);
    assert.deepEqual(edge.to, was.to, 'the target keeps its input');
  }
  assert.equal(result.graph.edges.some((edge) => edge.from.node === planner), false, 'the source output keeps no connection');
  assert.deepEqual(graphLib.getNode(result.graph, planner), graphLib.getNode(before, planner), 'the source node is untouched');
  assert.deepEqual(graphLib.validate(reg, result.graph), []);
  // below the source node, without covering another card
  const sourceRect = graphLib.nodeRect(graphLib.getNode(before, planner));
  assert.ok(result.node.y >= sourceRect.y + sourceRect.h, 'below the node');
  assert.equal(result.node.x, graphLib.snap(100, 8), 'in line with the node (on the grid)');
  for (const node of before.nodes) {
    assert.equal(graphLib.rectsIntersect(graphLib.nodeRect(result.node), graphLib.nodeRect(node)), false, `does not cover ${node.id}`);
  }
  // an occupied spot is avoided
  const crowded = build();
  const src = crowded.add('audio.music_plan', 100, 100);
  const blocker = crowded.add('input.text', 100, 100 + graphLib.nodeRect({ x: 0, y: 0, id: 'x' }).h + 48);
  const nudged = graphLib.adoptTextAsPrompt(reg, crowded.graph, src, 'plan', 'x');
  assert.equal(graphLib.rectsIntersect(graphLib.nodeRect(nudged.node), graphLib.nodeRect(graphLib.getNode(crowded.graph, blocker))), false);
  // a note in the way is avoided as well
  const noted = { ...crowded.graph, notes: [{ id: 't1', x: 90, y: 100 + graphLib.nodeRect({ x: 0, y: 0, id: 'x' }).h + 40, w: 380, h: 120, text: 'note' }] };
  const aroundNote = graphLib.adoptTextAsPrompt(reg, noted, src, 'plan', 'x');
  assert.equal(graphLib.rectsIntersect(graphLib.nodeRect(aroundNote.node), { x: 90, y: noted.notes[0].y, w: 380, h: 120 }), false, 'does not land on a note');
  // explicit id and position are honoured; an output without connections still gives the node
  const custom = graphLib.adoptTextAsPrompt(reg, crowded.graph, src, 'plan', 'x', { newNodeId: 'p7', position: { x: 8, y: 16 } });
  assert.equal(custom.node.id, 'p7');
  assert.deepEqual([custom.node.x, custom.node.y], [8, 16]);
  assert.deepEqual(custom.edges, []);
  // refused cases leave the graph untouched
  const refuse = (nodeId, port, text, reason) => {
    const refused = graphLib.adoptTextAsPrompt(reg, before, nodeId, port, text);
    assert.equal(refused.error.reason, reason);
    assert.equal(refused.graph, before, 'the graph is returned unchanged');
  };
  refuse(planner, 'plan', '   ', 'empty');
  refuse(planner, 'plan', undefined, 'empty');
  refuse(planner, 'nope', 'x', 'unknown_port');
  refuse('zz', 'plan', 'x', 'unknown_node');
  refuse(image, 'image', 'x', 'not_text');
  const noPrompt = { ...reg, types: new Map([...reg.types].filter(([type]) => type !== 'input.prompt')) };
  assert.equal(graphLib.adoptTextIssue(noPrompt, before, planner, 'plan', 'x'), 'no_prompt_type');
  // text of a language-model node works the same (a general command)
  const chat = build();
  const llm = chat.add('llm.chat', 100, 100);
  const outPort = graphLib.portsFor(reg, graphLib.getNode(chat.graph, llm)).outputs.find((port) => port.type === 'text');
  assert.ok(outPort, 'llm.chat has a text output');
  assert.equal(graphLib.adoptTextIssue(reg, chat.graph, llm, outPort.id, 'answer'), null);
  // one undo step restores everything
  const history = require('../public/nodes/history').createHistory({ now: () => 0 });
  history.reset(graphLib.content(before));
  history.commit(graphLib.content(result.graph), { label: 'use-as-text' });
  assert.equal(history.size, 2, 'a single history entry');
  const undone = graphLib.withContent(result.graph, history.undo());
  assert.equal(graphLib.sameContent(undone, before), true);
  assert.equal(graphLib.sameContent(graphLib.withContent(undone, history.redo()), result.graph), true);
}

// "Use as text" cuts off what fed the source: Design App inputs there stop reaching an app output. They are found, before
// and after, so the interface can warn; inputs that still reach an output are not named.
function testAppInputsCutOff() {
  const template = require('../lib/nodes/templates').loadTemplates().find((item) => item.id === 'song-from-idea');
  const graph = template.graph;
  const app = template.app;
  assert.deepEqual(graphLib.appInputsWithoutOutput(graph, app), [], 'the template as shipped: every app input reaches the result');
  const adopted = graphLib.adoptTextAsPrompt(reg, graph, 'n2', 'plan', '[Verse | 20 s]\nla');
  assert.ok(!adopted.error);
  const cut = graphLib.appInputsCutOff(graph, adopted.graph, app);
  assert.deepEqual(cut.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.length'], 'the idea and the length are cut off');
  assert.deepEqual(graphLib.appInputsWithoutOutput(adopted.graph, app).map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.length'], 'the app panel marks the same');
  // the new Prompt node is not exposed, so nothing else is named; an input that stays connected is not reported
  const withNew = { ...app, inputs: [...app.inputs, { node: adopted.node.id, param: 'prompt', label: 'Song text' }] };
  assert.deepEqual(graphLib.appInputsCutOff(graph, adopted.graph, withNew), cut);
  assert.deepEqual(graphLib.appInputsWithoutOutput(adopted.graph, withNew).map((entry) => entry.node), ['n1', 'n2']);
  // without app output or inputs there is nothing to reach
  assert.deepEqual(graphLib.appInputsCutOff(graph, adopted.graph, { ...app, outputs: [] }), []);
  assert.deepEqual(graphLib.appInputsCutOff(graph, adopted.graph, { ...app, inputs: [] }), []);
  assert.deepEqual(graphLib.appInputsCutOff(graph, adopted.graph, undefined), []);
  // an input that was already cut off before the step is not blamed on it; one on a node that is gone is ignored
  assert.deepEqual(graphLib.appInputsCutOff(adopted.graph, adopted.graph, app), []);
  assert.deepEqual(graphLib.appInputsWithoutOutput(graph, { ...app, inputs: [{ node: 'zz', param: 'x' }] }), []);
  // an input on the output node itself reaches it
  assert.deepEqual(graphLib.appInputsWithoutOutput(graph, { enabled: true, inputs: [{ node: 'n4', param: 'label' }], outputs: [{ node: 'n4' }] }), []);
  // a node that is not upstream of any app output is marked even before any command
  const stray = { ...graph, nodes: [...graph.nodes, { id: 'n9', type: 'input.prompt', typeVersion: 1, x: 0, y: 0, params: { prompt: 'x' } }] };
  assert.deepEqual(graphLib.appInputsWithoutOutput(stray, { ...app, inputs: [{ node: 'n9', param: 'prompt' }] }).map((entry) => entry.node), ['n9']);
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
  // {all} and {param, empty} (the music node: length and vocals only matter without a plan and without a video)
  const music = reg.types.get('audio.music');
  const length = music.params.find((param) => param.id === 'length');
  const instrumental = music.params.find((param) => param.id === 'instrumental');
  const musicNode = (params) => ({ type: 'audio.music', params });
  const visible = (param, params, connected) => graphLib.isVisible(param.showIf, musicNode(params), music, new Set(connected));
  assert.equal(visible(length, {}, []), true, 'nothing set: the length counts');
  assert.equal(visible(length, { plan: '' }, []), true);
  assert.equal(visible(length, { plan: '   \n' }, []), true, 'blank text is no plan');
  assert.equal(visible(length, { plan: '[A | 10 s]' }, []), false, 'a plan in the field: hidden');
  assert.equal(visible(length, {}, ['plan']), false, 'a connected plan: hidden');
  assert.equal(visible(length, {}, ['match']), false, 'a connected video: hidden');
  assert.equal(visible(length, {}, ['prompt']), true, 'a connected prompt does not matter');
  assert.equal(visible(instrumental, {}, ['match']), true, 'the video sets the length only, not the vocals');
  assert.equal(visible(instrumental, { plan: 'x' }, []), false, 'a plan in the field decides the vocals');
  assert.equal(visible(instrumental, {}, ['plan']), false);
  assert.equal(graphLib.isVisible({ param: 'a', empty: false }, { params: { a: 'x' } }, { params: [{ id: 'a', default: '' }] }, new Set()), true, 'empty: false = holds text');
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

// Sub graphs (templates, "insert with inputs", the assistant): fresh ids, free place, edges/notes/groups carried over.
function testInsertSubgraph() {
  const templates = require('../lib/nodes/templates');
  const doc = templates.resolveTemplate('image-formats', { lang: 'en' });
  const itemRects = (graph, ids) => [
    ...graph.nodes.filter((node) => ids.nodes.includes(node.id)).map((node) => graphLib.nodeRect(node)),
    ...graph.notes.filter((note) => ids.notes.includes(note.id)).map((note) => ({ x: note.x, y: note.y, w: note.w, h: note.h })),
    ...graph.groups.filter((group) => ids.groups.includes(group.id)).map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h }))
  ];

  // empty canvas: centred on the middle of the view
  const empty = graphLib.insertSubgraph(graphLib.emptyGraph(), doc.graph, { reg, center: { x: 600, y: 400 } });
  assert.equal(empty.error, undefined);
  assert.equal(empty.graph.nodes.length, 5);
  assert.equal(empty.graph.edges.length, 6);
  assert.equal(empty.graph.notes.length, 1);
  assert.equal(empty.graph.groups.length, 1);
  assert.deepEqual(empty.ids.nodes, ['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.equal(empty.ids.edges.length, 6);
  assert.ok(Math.abs(empty.bounds.x + empty.bounds.w / 2 - 600) <= 8, 'centred horizontally (on the 8 px grid)');
  assert.ok(Math.abs(empty.bounds.y + empty.bounds.h / 2 - 400) <= 8, 'centred vertically');
  assert.deepEqual(graphLib.validate(reg, empty.graph), [], 'the inserted graph is valid');
  assert.equal(empty.graph.nodes[0].params.asset, null);
  assert.equal(empty.graph.nodes[1].params.fit, 'cover', 'template params are kept');
  assert.equal(empty.graph.nodes[1].params.transparent, false);
  // the template document itself is untouched
  assert.equal(doc.graph.nodes[0].id, 'n1');
  assert.equal(doc.graph.nodes[1].x, 520);

  // beside existing content: new unique ids, right of everything, nothing overlaps
  const b = build();
  const text = b.add('input.text', 40, 40);
  const gen = b.add('image.generate', 400, 40);
  b.graph = graphLib.connect(reg, b.graph, { node: text, port: 'text' }, { node: gen, port: 'prompt' }).graph;
  b.graph = graphLib.addNote(b.graph, { x: 40, y: 400, w: 200, h: 100 }).graph;
  b.graph = graphLib.addGroup(b.graph, { x: 20, y: 20, w: 900, h: 300 }).graph;
  const before = graphLib.boundsOf(b.graph);
  const beside = graphLib.insertSubgraph(b.graph, doc.graph, { reg, center: { x: 0, y: 0 }, reserved: new Set(['n7']) });
  assert.deepEqual(beside.ids.nodes, ['n8', 'n9', 'n10', 'n11', 'n12'], 'reserved ids stay unused');
  assert.equal(beside.ids.notes[0], 't2');
  assert.equal(beside.ids.groups[0], 'g2');
  const all = graphLib.allIds(beside.graph);
  assert.equal(all.size, b.graph.nodes.length + b.graph.edges.length + b.graph.notes.length + b.graph.groups.length + 5 + 6 + 1 + 1, 'no id is used twice');
  assert.ok(beside.bounds.x >= before.x + before.w, 'right of the existing content');
  const placed = itemRects(beside.graph, beside.ids);
  const others = itemRects(beside.graph, { nodes: [text, gen], notes: ['t1'], groups: ['g1'] });
  for (const rect of placed) for (const other of others) assert.equal(graphLib.rectsIntersect(rect, other), false, 'nothing overlaps');
  // edges connect the new nodes with the mapped ids and keep their ports
  const mapped = beside.graph.edges.slice(-6);
  assert.deepEqual(mapped.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`), ['n8.image>n9.image', 'n8.image>n10.image', 'n8.image>n11.image', 'n9.image>n12.inputs', 'n10.image>n12.inputs', 'n11.image>n12.inputs']);
  assert.deepEqual(beside.idMap, { n1: 'n8', n2: 'n9', n3: 'n10', n4: 'n11', n5: 'n12' });
  assert.deepEqual(graphLib.validate(reg, beside.graph), []);
  // the old part is the same objects (structural sharing for the canvas)
  assert.equal(beside.graph.nodes[0], b.graph.nodes[0]);
  // inserted twice: again free and unique
  const twice = graphLib.insertSubgraph(beside.graph, doc.graph, { reg });
  assert.ok(twice.bounds.x >= beside.bounds.x + beside.bounds.w);
  assert.equal(new Set(twice.graph.nodes.map((node) => node.id)).size, 12);

  // very wide content: below instead of beside
  const wide = graphLib.addNode(reg, graphLib.addNode(reg, graphLib.emptyGraph(), 'input.text', { x: 0, y: 0 }).graph, 'input.text', { x: 3000, y: 0 }).graph;
  const below = graphLib.insertSubgraph(wide, doc.graph, { reg });
  assert.ok(below.bounds.y >= 160 && below.bounds.x <= 8, 'content wider than 2400 px: the new part goes below, at the left edge');

  // explicit place; `avoid` moves down while the items would sit on others
  const at = graphLib.insertSubgraph(b.graph, { nodes: [{ id: 'a', type: 'input.text', x: 10, y: 10, params: { text: 'x' } }], edges: [] }, { reg, at: { x: 400, y: 40 } });
  assert.deepEqual({ x: at.graph.nodes[2].x, y: at.graph.nodes[2].y }, { x: 400, y: 40 }, 'an explicit place is taken as given');
  const avoided = graphLib.insertSubgraph(b.graph, { nodes: [{ id: 'a', type: 'input.text', x: 0, y: 0, params: { text: 'x' } }], edges: [] }, { reg, at: { x: 400, y: 40 }, avoid: true });
  const moved = avoided.graph.nodes[2];
  assert.ok(moved.y > 40 && moved.x === 400, 'moved down, not sideways');
  assert.equal(graphLib.rectsIntersect(graphLib.nodeRect(moved), graphLib.nodeRect(gen)), false);

  // connecting to what was there works with the id map (the "insert with inputs" case)
  const linked = graphLib.insertSubgraph(b.graph, { nodes: [{ id: 'up', type: 'input.text', x: 0, y: 0, params: { text: 'a prompt' } }], edges: [] }, { reg, at: { x: -400, y: 400 } });
  const fixed = graphLib.connect(reg, linked.graph, { node: linked.idMap.up, port: 'text' }, { node: 'n2', port: 'prompt' }, { reserved: new Set() });
  assert.equal(fixed.error, undefined);

  // defaults are filled from the registry; node types the view does not know are refused
  const filled = graphLib.insertSubgraph(graphLib.emptyGraph(), { nodes: [{ id: 'a', type: 'image.generate', x: 0, y: 0 }], edges: [] }, { reg });
  assert.deepEqual(filled.graph.nodes[0].params, { model: '', prompt: '', aspect_ratio: '1:1', count: 1 });
  assert.equal(filled.graph.nodes[0].typeVersion, 1);
  const unknown = graphLib.insertSubgraph(b.graph, { nodes: [{ id: 'a', type: 'nope.unknown', x: 0, y: 0 }] }, { reg });
  assert.deepEqual(unknown.error, { reason: 'unknown_type', type: 'nope.unknown' });
  assert.equal(unknown.graph, b.graph, 'nothing changed');
  assert.equal(graphLib.insertSubgraph(b.graph, { nodes: [], edges: [] }, { reg }).error.reason, 'empty');
  assert.equal(graphLib.insertSubgraph(b.graph, null, { reg }).error.reason, 'empty');
  const crowded = graphLib.emptyGraph();
  crowded.nodes = Array.from({ length: 498 }, (_unused, index) => ({ id: `n${index + 1}`, type: 'input.text', typeVersion: 1, x: index, y: 0, params: {} }));
  assert.equal(graphLib.insertSubgraph(crowded, doc.graph, { reg }).error.reason, 'too_many', 'at most 500 nodes in a workflow');

  // every shipped template goes in cleanly and stays valid on top of existing content
  for (const template of templates.loadTemplates()) {
    const result = graphLib.insertSubgraph(beside.graph, templates.resolveTemplate(template.id, { lang: 'en' }).graph, { reg });
    assert.equal(result.error, undefined, template.id);
    assert.equal(result.ids.nodes.length, template.graph.nodes.length, template.id);
    assert.deepEqual(graphLib.validate(reg, result.graph), [], `${template.id} inserts into a graph that already has content`);
  }
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
  testInsertSubgraph,
  testInsertSubgraphLinks,
  testNormalizeLoaded,
  testContentSnapshots,
  testFuzzyAndPalette,
  testSearchRules,
  testPromptNodeRegistered,
  testPaletteRanking,
  testQuickPick,
  testDescribePort,
  testDescribePortTruncationAndVariants,
  testQuickPickMultiMedia,
  testExtractPrompt,
  testAdoptText,
  testAppInputsCutOff,
  testQuickPickCreatesConnectedNode,
  testShowIf,
  testEveryTypeCanBePlaced,
  testInputSources
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`graph ok: ${tests.length} Gruppen, ${reg.types.size} Node-Typen geprueft`);
console.log('test-nodes-graph.js: ok');
