'use strict';

// Item prompt edits: validation, shared resolution, per-item cache and pricing. No providers or ports.
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../lib/nodes/registry');
const { normalizeGraph, createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine, applyItemEdits, resolveNodeInputs, computeCacheKey, computeItemKeys } = require('../lib/nodes/engine');
const { createEventBus } = require('../lib/nodes/events');
const { textValue, listValue } = require('../lib/nodes/types');
const scenes = require('../public/nodes/scene-table');
const { withoutItemEdit } = require('../public/nodes/item-edits');
const { loadPage, FakeNode } = require('./support/fake-dom');

const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
const edge = (id, from, out, to, input) => ({ id, from: { node: from, port: out }, to: { node: to, port: input } });
const textList = (...texts) => listValue('text', texts.map(textValue));

function environment() {
  const registry = createRegistry();
  const calls = [];
  const estimates = [];
  registry.register({
    type: 't.words', category: 'input',
    params: [{ id: 'text', kind: 'text', default: 'a,b,c' }],
    outputs: [{ id: 'items', type: 'text[]' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ items: textList(...params.text.split(',')) }] })
  });
  registry.register({
    type: 't.context', category: 'input',
    params: [{ id: 'text', kind: 'text', default: 'context' }],
    outputs: [{ id: 'text', type: 'text' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ text: textValue(params.text) }] })
  });
  registry.register({
    type: 't.scene', category: 'text', paid: true,
    inputs: [
      { id: 'prompt', type: 'text', required: true },
      { id: 'context', type: 'text' },
      { id: 'refs', type: 'text', multiple: true },
      { id: 'texts', type: 'text[]' },
      { id: 'image', type: 'image' }
    ],
    outputs: [{ id: 'out', type: 'text' }],
    cost: { unit: 'usd', history: false, estimate: (_params, { inputs }) => {
      estimates.push(inputs);
      return inputs.prompt?.value === 'edited' ? 0.7 : 0.1;
    } },
    execute: async (ctx, inputs) => {
      calls.push({ index: ctx.itemIndex, text: inputs.prompt.value });
      return { variants: [{ out: textValue(`${inputs.prompt.value}:${calls.length}`) }], cost: { usd: inputs.prompt.value === 'edited' ? 0.7 : 0.1 } };
    }
  });
  registry.register({
    type: 't.dynamic', category: 'text',
    params: [{ id: 'kind', kind: 'select', default: 'text', options: ['text', 'image'] }],
    inputs: [{ id: 'in', type: 'text' }], outputs: [],
    portVariants: { param: 'kind', values: {
      text: { inputs: [{ id: 'in', type: 'text' }], outputs: [] },
      image: { inputs: [{ id: 'in', type: 'image' }], outputs: [] }
    } },
    execute: async () => ({ variants: [{}] })
  });
  return { registry, calls, estimates };
}

function testValidation(registry) {
  const clean = (itemEdits, type = 't.scene', params = {}) => normalizeGraph({ nodes: [{ ...node('n', type, params), itemEdits }], edges: [] }, { registry }).nodes[0];
  const valid = { prompt: { 0: { text: 'edited', was: 'a', ignored: true }, 2: { text: '', was: 'c' } }, context: {} };
  assert.deepEqual(clean(valid).itemEdits, { prompt: { 0: { text: 'edited', was: 'a' }, 2: { text: '', was: 'c' } } });
  assert.equal(valid.prompt[0].ignored, true, 'normalization does not change the supplied graph');
  assert.equal('itemEdits' in clean({}), false, 'empty edits are not persisted');
  assert.equal('itemEdits' in clean({ prompt: {} }), false, 'empty port maps are not persisted');
  assert.equal('itemEdits' in clean(undefined), false);
  assert.equal('itemEdits' in clean({}, 'missing.node'), false);
  const edit = { text: 'x', was: 'before' };
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i, edit]));
  assert.equal(Object.keys(clean({ prompt: entries }).itemEdits.prompt).length, 200);
  assert.equal(clean({ prompt: { 0: { ...edit, text: 'x'.repeat(8000) } } }).itemEdits.prompt[0].text.length, 8000);
  assert.ok(clean({ texts: { 0: edit } }).itemEdits.texts, 'whole-list text ports are valid storage, but do not map');
  assert.ok(clean({ in: { 0: edit } }, 't.dynamic').itemEdits.in);
  const invalid = [
    null, [], 'bad', { prompt: [] }, { prompt: null },
    { prompt: { ...entries, 200: edit } }, { prompt: entries, context: { 0: edit } },
    { prompt: { 0: { ...edit, text: 'x'.repeat(8001) } } },
    { image: { 0: edit } }, { unknown: { 0: edit } },
    { prompt: { '-1': edit } }, { prompt: { '1.5': edit } }, { prompt: { '01': edit } },
    { prompt: { '1e2': edit } }, { prompt: { '9007199254740992': edit } },
    { prompt: { 0: { text: 'x', was: 1 } } }, { prompt: { 0: { text: 1, was: 'x' } } },
    { prompt: { 0: {} } }, { prompt: { 0: null } }
  ];
  for (const value of invalid) assert.throws(() => clean(value), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => clean({ prompt: { 0: edit } }, 'missing.node'), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => clean({ in: { 0: edit } }, 't.dynamic', { kind: 'image' }), { code: 'INVALID_WORKFLOW' });
}

function testResolution(registry) {
  const original = textList('a', 'b', 'c');
  const snapshot = JSON.stringify(original);
  const applied = applyItemEdits(original, { 1: { text: 'edited', was: 'b' }, 2: { text: 'stale', was: 'old' }, 99: { text: 'outside', was: 'x' } });
  assert.deepEqual(applied.value.items.map((item) => item.value), ['a', 'edited', 'c']);
  assert.deepEqual(applied.edited, [1]);
  assert.deepEqual(applied.stale, [2]);
  assert.equal(JSON.stringify(original), snapshot, 'the helper never mutates upstream data');
  assert.equal(applied.value.items[0], original.items[0]);
  assert.equal(applyItemEdits(original).value, original);
  assert.equal(applyItemEdits(original, { 0: { text: 'x', was: 'old' } }).value, original);
  const n = { ...node('n', 't.scene'), itemEdits: {
    prompt: { 1: { text: 'edited', was: 'b' } },
    texts: { 1: { text: 'ignored', was: 'b' } },
    refs: { 1: { text: 'ignored', was: 'b' } },
    context: { 0: { text: 'ignored', was: 'scalar' } }
  } };
  const def = registry.get(n.type);
  const params = registry.normalizeParams(def, n.params);
  const ports = registry.portsFor(def, params);
  const args = { node: n, ports, params, edges: [
    edge('a', 'up', 'items', 'n', 'prompt'), edge('b', 'up', 'items', 'n', 'texts'),
    edge('c', 'up', 'items', 'n', 'refs'), edge('d', 'up', 'single', 'n', 'context')
  ], outputsOf: () => ({ items: original, single: textValue('scalar') }), maxListItems: 120 };
  const resolved = resolveNodeInputs(args);
  assert.deepEqual(resolved.mapped, ['prompt']);
  assert.equal(resolved.inputs.prompt.items[1].value, 'edited');
  assert.equal(resolved.inputs.texts.items[1].value, 'b', 'whole-list inputs stay unchanged');
  assert.equal(resolved.inputs.refs.items[1].value, 'b', 'multiple-edge collection stays unchanged');
  assert.equal(resolved.inputs.context.value, 'scalar', 'scalar values stay unchanged');
  const noEdits = { ...n };
  delete noEdits.itemEdits;
  const before = resolveNodeInputs({ ...args, node: noEdits });
  const empty = resolveNodeInputs({ ...args, node: { ...noEdits, itemEdits: {} } });
  assert.equal(computeCacheKey(def, params, before.inputs), computeCacheKey(def, params, empty.inputs));
  assert.deepEqual(computeItemKeys(def, params, before), computeItemKeys(def, params, empty));
  const expectedInputs = { prompt: original, texts: original, refs: original, context: textValue('scalar') };
  assert.equal(computeCacheKey(def, params, before.inputs), computeCacheKey(def, params, expectedInputs), 'existing nodes keep the key of their original inputs');
  const numbers = resolveNodeInputs({ ...args, node: { ...noEdits, itemEdits: { prompt: { 0: { text: 'number edit', was: '3' } } } },
    ports: { inputs: [{ id: 'prompt', type: 'text' }] },
    edges: [args.edges[0]], outputsOf: () => ({ items: listValue('number', [{ type: 'number', value: 3 }]) }) });
  assert.equal(numbers.inputs.prompt.items[0].value, 'number edit', 'edits match after the normal number-to-text coercion');
}

function testSceneTable() {
  const input = { nodeId: 'n', category: 'video', entry: { itemKeys: ['a', 'b'], params: {} },
    variant: { out: textList('result a', 'result b') }, order: ['out'], inputPorts: [{ id: 'prompt', type: 'text' }],
    edges: [edge('e', 'up', 'items', 'n', 'prompt')], upstreamVariant: () => ({ items: textList('a', 'b') }),
    itemEdits: { prompt: { 0: { text: 'edited', was: 'a' }, 1: { text: 'old edit', was: 'before b' } } } };
  const table = scenes.sceneTable(input);
  assert.equal(table.rows[0].text, 'edited');
  assert.deepEqual(table.rows[0].itemEdit, { port: 'prompt', index: 0, stale: false });
  assert.equal(table.rows[1].text, 'b');
  assert.equal(table.rows[1].itemEdit.stale, true);
  assert.equal(scenes.sceneTable({ ...input, category: 'input' }), null, 'no new table is forced');
  const n = { ...node('n', 't.scene'), itemEdits: input.itemEdits };
  const removed = withoutItemEdit(n, 'prompt', 0);
  assert.equal(scenes.sceneTable({ ...input, itemEdits: removed.itemEdits }).rows[0].text, 'a');
  assert.ok(n.itemEdits.prompt[0], 'removal leaves the undo snapshot intact');
  assert.equal('itemEdits' in withoutItemEdit(removed, 'prompt', 1), false, 'removing the last edit removes its empty containers');
  const otherPort = { ...n, itemEdits: { ...n.itemEdits, context: { 0: { text: 'other', was: 'x' } } } };
  assert.ok(withoutItemEdit(withoutItemEdit(otherPort, 'prompt', 0), 'prompt', 1).itemEdits.context[0]);
  assert.equal(scenes.sceneTable({ ...input, inputPorts: [{ id: 'prompt', type: 'text[]' }] }).rows[0].text, 'a');
}

function testInspector(registry) {
  const reg = require('../public/nodes/graph').indexRegistry(JSON.parse(JSON.stringify(registry.publicRegistry())));
  for (const lang of ['de', 'en', 'es']) {
    const { OCD } = loadPage(lang, { scripts: ['node-ui', 'preview', 'inspector'] });
    OCD.sceneTable = scenes;
    const host = new FakeNode('div');
    const ctx = { workflow: { id: 'test' }, graph: {
      nodes: [node('up', 't.words'), { ...node('n', 't.scene'), itemEdits: { prompt: { 0: { text: '<script>edited</script>', was: 'a' } } } }],
      edges: [edge('e', 'up', 'items', 'n', 'prompt')], notes: [], groups: []
    }, selection: { nodes: new Set(['n']), notes: new Set(), groups: new Set(), edge: null } };
    let busy = false;
    let inspector;
    const removals = [];
    inspector = OCD.inspector.createInspector({ host, getReg: () => reg, callbacks: {
      onRemoveItemEdit: (id, port, index) => {
        removals.push([id, port, index]);
        ctx.graph = { ...ctx.graph, nodes: ctx.graph.nodes.map((n) => n.id === id ? withoutItemEdit(n, port, index) : n) };
        inspector.render(ctx);
      },
      run: {
        info: () => null,
        scenes: () => ({ ...scenes.sceneTable({ nodeId: 'n', category: 'text', variant: { out: textList('result') },
          entry: { params: {}, itemKeys: ['key'] }, order: ['out'], inputPorts: [{ id: 'prompt', type: 'text' }],
          edges: ctx.graph.edges, upstreamVariant: () => ({ items: textList('a') }), itemEdits: ctx.graph.nodes[1].itemEdits }),
          busy, canRun: true, cost: { paid: false, usd: null, credits: null, unknown: false } })
      }
    } });
    const byClass = (name) => host.find((child) => child.classes?.has(name));
    inspector.render(ctx);
    assert.equal(byClass('nv-scene-text')[0].textContent, '<script>edited</script>', 'prompt content stays literal text');
    assert.equal(byClass('nv-scene-edited')[0].textContent, OCD.ui.T('nodes.scenes.itemEdited'));
    assert.equal(byClass('nv-scene-reset')[0].textContent, OCD.ui.T('nodes.scenes.itemEditRemove'));
    busy = true;
    inspector.refreshRun();
    assert.equal(byClass('nv-scene-reset')[0].hasAttribute('disabled'), true, 'removal is disabled during a run');
    busy = false;
    inspector.refreshRun();
    byClass('nv-scene-reset')[0].fire('click');
    assert.deepEqual(removals, [['n', 'prompt', 0]], 'the remove button uses the graph callback, never a run');
    assert.equal(byClass('nv-scene-edited').length, 0, 'the inspector repaints immediately after removal');
    assert.equal(byClass('nv-scene-text')[0].textContent, 'a');
    inspector.dispose();
  }
}

async function testEngine(env) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-item-edits-'));
  const events = createEventBus();
  const store = createWorkflowsStore({ dir, registry: env.registry, events });
  const engine = createEngine({ store, registry: env.registry, events, getConfig: () => ({}) });
  const ids = [];
  const logs = [];
  const run = async (id, request = { mode: 'all' }) => {
    const record = await engine.whenFinished(id, await engine.start(id, request));
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    return record;
  };
  const change = async (id, update) => {
    const wf = await store.readWorkflow(id);
    await store.saveGraph(id, { baseRev: wf.rev, graph: { ...wf.graph, nodes: wf.graph.nodes.map(update) } });
  };
  try {
    const { workflow } = await store.createWorkflow({ name: 'Item edits', graph: {
      nodes: [node('words', 't.words'), node('context', 't.context'), node('scene', 't.scene')],
      edges: [edge('a', 'words', 'items', 'scene', 'prompt'), edge('b', 'context', 'text', 'scene', 'context')]
    } });
    ids.push(workflow.id);
    events.subscribe(workflow.id, (event) => { if (event.type === 'node_log') logs.push(event.label); });
    await run(workflow.id);
    const first = (await store.readResults(workflow.id)).nodes.scene.history[0];
    const firstItems = first.variants[0].out.items;
    env.calls.length = 0;
    await change(workflow.id, (n) => n.id === 'scene' ? { ...n, itemEdits: { prompt: { 1: { text: 'edited', was: 'b' } } } } : n);
    env.estimates.length = 0;
    const plan = await engine.plan(workflow.id, { mode: 'all' });
    assert.equal(plan.nodes.scene.status, 'stale');
    assert.equal(plan.nodes.scene.executions, 1);
    assert.equal(plan.nodes.scene.reusedItems, 2);
    assert.equal(plan.totals.usd, 0.7, 'only the edited item is priced with its replaced value');
    assert.deepEqual(plan.nodes.scene.itemEstimates.map((entry) => entry.usd), [0.1, 0.7, 0.1]);
    assert.deepEqual(env.calls, [], 'planning never executes a node');
    const secondRun = await run(workflow.id);
    assert.deepEqual(env.calls, [{ index: 1, text: 'edited' }]);
    assert.equal(secondRun.cost.usd, 0.7);
    const second = (await store.readResults(workflow.id)).nodes.scene.history[0];
    assert.equal(second.itemKeys[0], first.itemKeys[0]);
    assert.notEqual(second.itemKeys[1], first.itemKeys[1]);
    assert.equal(second.itemKeys[2], first.itemKeys[2]);
    assert.deepEqual(second.variants[0].out.items[0], firstItems[0]);
    assert.deepEqual(second.variants[0].out.items[2], firstItems[2]);
    assert.equal((await engine.plan(workflow.id, { mode: 'all' })).nodes.scene.status, 'cached');
    env.calls.length = 0;
    await run(workflow.id);
    assert.deepEqual(env.calls, [], 'the edited inputs also hit the whole-node cache on the next run');

    // Pricing-only resolution: one input is known while a different upstream node must still run.
    await change(workflow.id, (n) => n.id === 'context' ? { ...n, params: { text: 'new context' } } : n);
    env.estimates.length = 0;
    await engine.plan(workflow.id, { mode: 'all' });
    assert.ok(env.estimates.some((inputs) => inputs.prompt?.type === 'list' && inputs.prompt.items[1].value === 'edited'), 'partial estimates use the central replacement too');
    await change(workflow.id, (n) => n.id === 'context' ? { ...n, params: { text: 'context' } } : n);

    // Change upstream, keep the saved edit. Only that input changes; its stale replacement must not run.
    await change(workflow.id, (n) => n.id === 'words' ? { ...n, params: { text: 'a,new b,c' } } : n);
    await run(workflow.id, { mode: 'node', nodeIds: ['words'] });
    env.calls.length = 0;
    const stalePlan = await engine.plan(workflow.id, { mode: 'all' });
    assert.equal(stalePlan.nodes.scene.executions, 1);
    assert.equal(stalePlan.nodes.scene.reusedItems, 2);
    assert.equal(stalePlan.totals.usd, 0.1);
    await run(workflow.id);
    assert.deepEqual(env.calls, [{ index: 1, text: 'new b' }]);
    await engine.plan(workflow.id, { mode: 'all' });
    await run(workflow.id);
    assert.equal(logs.filter((label) => /Ignored stale item edit/.test(label)).length, 1, 'the same stale edit is logged only once across resolutions and runs');
    assert.ok(logs.every((label) => !label.includes('new b')), 'the log contains no upstream prompt');

    // Removing an edit restores the original cache key and reuses its historical result.
    await change(workflow.id, (n) => n.id === 'words' ? { ...n, params: { text: 'a,b,c' } } : n.id === 'scene' ? withoutItemEdit(n, 'prompt', 1) : n);
    await run(workflow.id, { mode: 'node', nodeIds: ['words'] });
    env.calls.length = 0;
    assert.equal((await engine.plan(workflow.id, { mode: 'all' })).nodes.scene.status, 'cached');
    await run(workflow.id);
    assert.deepEqual(env.calls, []);
    const saved = await store.readWorkflow(workflow.id);
    assert.equal('itemEdits' in saved.graph.nodes.find((n) => n.id === 'scene'), false);
  } finally {
    for (const id of ids) await store.deleteWorkflow(id);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const env = environment();
  testValidation(env.registry);
  testResolution(env.registry);
  testSceneTable();
  testInspector(env.registry);
  await testEngine(env);
  console.log('test-item-edits.js: ok');
}

main().catch((err) => { console.error(err); process.exit(1); });
