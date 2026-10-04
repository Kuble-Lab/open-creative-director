'use strict';

// Cache stamps of the engine (WP38g): def.cacheStamp(params, ctx) puts the state a node reads besides its parameters and inputs into its key.
//   - without a hook every key is the same, byte for byte (golden: the formula of before the change, and keys measured before it)
//   - run, plan (price, status "out of date"), key of every item: all see the stamp; `stamped` marks the node in the plan
//   - a changed state runs the node again, an unchanged result keeps what depends on it in the cache
//   - an entry from before the stamp: taken as it is (cacheStampAdopts: true), taken when a check says so (a function), or not taken
//   - a stamp that cannot be made is a stamp of its own; the plan finds stamps behind stamps (a stamp that reads an input)
//   - "run all again" as a plan: every node is `forced`, with the price
// Fake nodes and a private workflow store; nothing is paid.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const engineLib = require('../lib/nodes/engine');
const { createEngine, computeCacheKey, computeItemKeys, resolveStamp } = engineLib;
const { textValue, listValue, sha256Hex, canonicalJson, fingerprint } = require('../lib/nodes/types');
const nodesBasic = require('../lib/nodes/nodes-basic');

const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
const edge = (id, from, to) => {
  const [fromNode, fromPort] = from.split('.');
  const [toNode, toPort] = to.split('.');
  return { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
};

// the key as it was made before stamps existed (SPEC §9.3)
function oldKey(def, params, inputs) {
  const fingerprints = {};
  for (const [portId, value] of Object.entries(inputs)) fingerprints[portId] = fingerprint(value);
  return `sha256:${sha256Hex(canonicalJson({ t: def.type, v: def.version, p: params, i: fingerprints }))}`;
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-stamps-'));
  const created = [];
  const world = { value: 'one', model: 'm1', failing: false, legacy: false, counts: {}, stampCalls: 0, itemRuns: [] };
  const count = (ctx) => {
    world.counts[ctx.nodeId] = (world.counts[ctx.nodeId] || 0) + 1;
  };

  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  // a free source that reads the state of the app (like a branding): its output is that state
  registry.register({
    type: 't.state',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'name', kind: 'text', default: 'a' }],
    cacheStamp: async () => {
      world.stampCalls += 1;
      if (world.failing) throw new Error('state unreadable');
      return { value: world.value };
    },
    execute: async (ctx) => {
      count(ctx);
      return { variants: [{ out: textValue(world.value) }] };
    }
  });
  // the same output however the state changes (the profile text of a branding that changed only a logo, say): the state is a stamp, the text is not
  registry.register({
    type: 't.coarse',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    cacheStamp: async () => ({ value: world.value }),
    execute: async (ctx) => {
      count(ctx);
      return { variants: [{ out: textValue('constant') }] };
    }
  });
  // a paid consumer of the text
  registry.register({
    type: 't.paid',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.5 }) },
    execute: async (ctx, inputs) => {
      count(ctx);
      return { variants: [{ out: textValue(`paid(${inputs.in.value})`) }], cost: { usd: 0.5 } };
    }
  });
  // a paid node that reads a setting (the default model of the settings) with the three ways to treat an entry from before
  const modelNode = (type, adopts) => {
    registry.register({
      type,
      category: 'text',
      inputs: [{ id: 'in', type: 'text', required: true }],
      outputs: [{ id: 'out', type: 'text' }],
      paid: true,
      cost: { unit: 'usd', estimate: () => ({ usd: 0.25 }) },
      cacheStamp: async () => (world.legacy ? undefined : { model: world.model }),
      ...(adopts === undefined ? {} : { cacheStampAdopts: adopts }),
      execute: async (ctx, inputs) => {
        count(ctx);
        return { variants: [{ out: textValue(`${world.model}:${inputs.in.value}`) }], cost: { usd: 0.25 } };
      }
    });
  };
  modelNode('t.model_adopt', true);
  modelNode('t.model_verify', async (entry, { stamp }) => entry.variants[0].out.value.startsWith(`${stamp.model}:`));
  modelNode('t.model_plain');
  // a stamp that reads an input (like the fonts of a scene read from the brand)
  registry.register({
    type: 't.reads_input',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.1 }) },
    cacheStamp: async (_params, ctx) => ({ about: ctx.inputs.in ? ctx.inputs.in.value : null, world: world.value }),
    execute: async (ctx, inputs) => {
      count(ctx);
      return { variants: [{ out: textValue(`r(${inputs.in.value})`) }], cost: { usd: 0.1 } };
    }
  });
  // a node over the items of a list with a stamp
  registry.register({
    type: 't.list3',
    category: 'input',
    outputs: [{ id: 'items', type: 'text[]' }],
    execute: async (ctx) => {
      count(ctx);
      return { variants: [{ items: listValue('text', [textValue('a'), textValue('b'), textValue('c')]) }] };
    }
  });
  registry.register({
    type: 't.per_item',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.2 }) },
    cacheStamp: async () => ({ model: world.model }),
    cacheStampAdopts: true,
    execute: async (ctx, inputs) => {
      count(ctx);
      world.itemRuns.push(inputs.in.value);
      return { variants: [{ out: textValue(`${world.model}:${inputs.in.value}`) }], cost: { usd: 0.2 } };
    }
  });
  // no hook at all
  registry.register({
    type: 't.plain',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx, inputs) => {
      count(ctx);
      return { variants: [{ out: textValue(`plain(${inputs.in.value})`) }] };
    }
  });

  /* ---------- the registry checks the hooks ---------- */

  const bad = (extra) => () => createRegistry().register({ type: 't.bad', category: 'text', outputs: [{ id: 'out', type: 'text' }], execute: async () => ({ variants: [{}] }), ...extra });
  assert.throws(bad({ cacheStamp: 'x' }), /cacheStamp must be a function/);
  assert.throws(bad({ cacheStamp: async () => 1, cacheStampAdopts: 'yes' }), /cacheStampAdopts must be true or a function/);
  assert.throws(bad({ cacheStampAdopts: true }), /cacheStampAdopts needs a cacheStamp function/);
  assert.doesNotThrow(bad({ cacheStamp: async () => 1, cacheStampAdopts: true }));
  assert.doesNotThrow(bad({ cacheStamp: async () => 1, cacheStampAdopts: async () => true }));

  /* ---------- golden: without a stamp the keys are the ones of before ---------- */

  {
    const def = registry.get('t.plain');
    const inputs = { in: textValue('hello') };
    const params = {};
    assert.equal(computeCacheKey(def, params, inputs), oldKey(def, params, inputs));
    assert.equal(computeCacheKey(def, params, inputs, undefined), oldKey(def, params, inputs));
    const stamped = computeCacheKey(def, params, inputs, 'st:abc');
    assert.notEqual(stamped, oldKey(def, params, inputs), 'a stamp changes the key');
    assert.equal(stamped, `sha256:${sha256Hex(canonicalJson({ t: def.type, v: def.version, p: params, i: { in: fingerprint(inputs.in) }, s: 'st:abc' }))}`);
    assert.notEqual(computeCacheKey(def, params, inputs, 'st:abc'), computeCacheKey(def, params, inputs, 'st:abd'));
    // the real registry: keys measured before the change (the same two as test-branding-speaker.js) and the formula for stamped nodes
    const real = require('../lib/nodes/registry');
    const keyOf = (type, inputs, raw = {}) => {
      const realDef = real.registry.get(type);
      return computeCacheKey(realDef, real.registry.normalizeParams(realDef, raw), inputs);
    };
    assert.equal(keyOf('explainer.voice', { narration: textValue('Hallo Welt.') }), 'sha256:e9a32c9a51296d58991a23d750a70d39e706827fe0f9737c7ab0a27848cfa20b');
    assert.equal(keyOf('audio.tts', { text: textValue('Hallo Welt.') }), 'sha256:41c0002e34b949c35a9a7ea0121bf807a965bc97f1aa22d9f194a2614f10d06f');
    for (const [type, inputs] of [['llm.chat', { prompt: textValue('Hi') }], ['input.branding', {}], ['explainer.scene', {}], ['image.generate', { prompt: textValue('A cat') }]]) {
      const realDef = real.registry.get(type);
      const params = real.registry.normalizeParams(realDef, {});
      const bare = keyOf(type, inputs);
      assert.equal(bare, oldKey(realDef, params, inputs), `${type}: without a stamp the key is the old one`);
    }
    // item keys: no stamp, no change
    const resolved = { mapLength: 2, mapped: ['in'], inputs: { in: listValue('text', [textValue('a'), textValue('b')]) } };
    const listDef = registry.get('t.plain');
    const withoutStamp = computeItemKeys(listDef, {}, resolved);
    assert.deepEqual(computeItemKeys(listDef, {}, resolved, undefined), withoutStamp);
    assert.equal(withoutStamp[0], `sha256:${sha256Hex(canonicalJson({ t: listDef.type, v: listDef.version, p: {}, i: { in: fingerprint(textValue('a')) } }))}`);
    const withStamp = computeItemKeys(listDef, {}, resolved, 'st:x');
    assert.notDeepEqual(withStamp, withoutStamp);
    assert.notEqual(withStamp[0], withStamp[1]);
  }

  /* ---------- resolveStamp on its own ---------- */

  {
    const def = registry.get('t.state');
    const first = await resolveStamp(def, {}, {}, null, { user: 'u', config: {}, log() {} });
    assert.match(first.stamp, /^st:[0-9a-f]{64}$/);
    assert.equal(first.adopt, null);
    const again = await resolveStamp(def, {}, {}, null, { user: 'u', config: {}, log() {} });
    assert.equal(again.stamp, first.stamp, 'the same state, the same stamp');
    world.value = 'two';
    assert.notEqual((await resolveStamp(def, {}, {}, null, {})).stamp, first.stamp);
    world.value = 'one';
    world.failing = true;
    const failed = await resolveStamp(def, {}, {}, null, {});
    assert.match(failed.stamp, /^st:/, 'a stamp that cannot be made is a stamp of its own');
    assert.notEqual(failed.stamp, first.stamp);
    world.failing = false;
    assert.deepEqual(await resolveStamp(registry.get('t.plain'), {}, {}, null, {}), { stamp: undefined, adopt: null }, 'no hook, no stamp');
    // undefined and null mean "nothing to add"
    assert.equal((await resolveStamp({ ...def, cacheStamp: async () => undefined }, {}, {}, null, {})).stamp, undefined);
    assert.equal((await resolveStamp({ ...def, cacheStamp: async () => null }, {}, {}, null, {})).stamp, undefined);
  }

  /* ---------- the engine ---------- */

  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20 } });
  const makeWorkflow = async (nodes, edgeList, name) => {
    const result = await wfStore.createWorkflow({ name, graph: { nodes, edges: edgeList } });
    created.push(result.workflow.id);
    return result.workflow;
  };
  const run = async (workflowId, request = { mode: 'all' }) => engine.whenFinished(workflowId, await engine.start(workflowId, request));
  const reset = () => {
    world.counts = {};
    world.itemRuns.length = 0;
  };
  const statusOf = (record) => Object.fromEntries(Object.entries(record.nodes).map(([id, entry]) => [id, entry.status]));
  const history = async (workflowId, nodeId) => (await wfStore.readResults(workflowId)).nodes[nodeId].history;

  try {
    /* ----- a changed state: the node runs again, what depends on it follows ----- */
    {
      world.value = 'one';
      const wf = await makeWorkflow([node('s', 't.state'), node('p', 't.paid'), node('q', 't.plain')], [edge('e1', 's.out', 'p.in'), edge('e2', 'p.out', 'q.in')], 'state');
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'done', p: 'done', q: 'done' });
      assert.equal((await history(wf.id, 's'))[0].stamp.startsWith('st:'), true, 'the entry keeps the stamp it was made with');
      assert.equal('stamp' in (await history(wf.id, 'p'))[0], false, 'a node without a hook has none');
      const plan1 = await engine.plan(wf.id, { mode: 'all' });
      assert.deepEqual(Object.values(plan1.nodes).map((entry) => entry.status), ['cached', 'cached', 'cached']);
      assert.equal(plan1.nodes.s.stamped, true, 'the plan marks a node that reads state');
      assert.equal('stamped' in plan1.nodes.p, false);
      assert.equal(plan1.totals.paidNodes, 0);

      // unchanged: everything from the cache
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'cached', p: 'cached', q: 'cached' });
      assert.deepEqual(world.counts, {});

      // the state changed: the plan shows the node and everything after it, with the cost; the run makes them again
      world.value = 'two';
      const plan2 = await engine.plan(wf.id, { mode: 'all' });
      assert.deepEqual(Object.fromEntries(Object.entries(plan2.nodes).map(([id, entry]) => [id, entry.status])), { s: 'stale', p: 'stale', q: 'stale' });
      assert.equal(plan2.totals.paidNodes, 1);
      assert.equal(plan2.totals.usd, 0.5);
      assert.equal(plan2.nodes.p.estimate.usd, 0.5);
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'done', p: 'done', q: 'done' });
      assert.deepEqual(world.counts, { s: 1, p: 1, q: 1 });
      assert.equal((await history(wf.id, 'p')).length, 2);
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.q.status, 'cached');

      // back to the old state: the old entries are found again (a key per state)
      world.value = 'one';
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.p.status, 'cached');
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'cached', p: 'cached', q: 'cached' });
      assert.deepEqual(world.counts, {});

      // a stamp that cannot be made: the node runs (and the plan says so), nothing crashes
      world.failing = true;
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.s.status, 'stale');
      reset();
      assert.equal((await run(wf.id)).status, 'completed');
      assert.equal(world.counts.s, 1);
      assert.equal(world.counts.p, undefined, 'the text is the same: what depends on it stays cached');
      world.failing = false;
    }

    /* ----- the state changed, the output did not: what depends on it stays in the cache ----- */
    {
      world.value = 'one';
      const wf = await makeWorkflow([node('s', 't.coarse'), node('p', 't.paid')], [edge('e1', 's.out', 'p.in')], 'coarse');
      await run(wf.id);
      world.value = 'two';
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.s.status, 'stale', 'the plan cannot know the output before the node ran');
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'done', p: 'cached' });
      assert.deepEqual(world.counts, { s: 1 }, 'only the free node ran');
      assert.equal((await history(wf.id, 'p')).length, 1);
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).totals.paidNodes, 0);
      world.value = 'one';
    }

    /* ----- a paid node that reads a setting: another setting, another run ----- */
    {
      world.model = 'm1';
      world.legacy = false;
      const wf = await makeWorkflow([node('s', 't.state'), node('m', 't.model_adopt')], [edge('e1', 's.out', 'm.in')], 'setting');
      await run(wf.id);
      world.model = 'm2';
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.status, 'stale');
      assert.equal(plan.nodes.s.status, 'cached');
      assert.equal(plan.totals.usd, 0.25);
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'cached', m: 'done' });
      assert.equal((await history(wf.id, 'm'))[0].variants[0].out.value, 'm2:one');
      world.model = 'm1';
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.m.status, 'cached', 'the entry of the old setting is found again');
    }

    /* ----- entries from before the stamp ----- */
    for (const [type, mode] of [['t.model_adopt', 'adopted'], ['t.model_verify', 'verified'], ['t.model_plain', 'ignored']]) {
      world.model = 'm1';
      world.legacy = true; // the node had no stamp when the entries were made
      const wf = await makeWorkflow([node('s', 't.state'), node('m', type)], [edge('e1', 's.out', 'm.in')], `legacy ${mode}`);
      await run(wf.id);
      assert.equal('stamp' in (await history(wf.id, 'm'))[0], false, 'an old entry has no stamp');
      const oldKeyOfEntry = (await history(wf.id, 'm'))[0].cacheKey;
      world.legacy = false; // deployed: the node has a stamp now
      const plan = await engine.plan(wf.id, { mode: 'all' });
      if (mode === 'ignored') {
        assert.equal(plan.nodes.m.status, 'stale', `${type}: without cacheStampAdopts the old entry is not taken`);
        reset();
        assert.equal(statusOf(await run(wf.id)).m, 'done');
        continue;
      }
      assert.equal(plan.nodes.m.status, 'cached', `${type}: the plan takes the old entry`);
      assert.equal(plan.totals.paidNodes, 0);
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'cached', m: 'cached' }, `${type}: no paid run for a state nobody changed`);
      assert.equal(world.counts.m, undefined);
      const entry = (await history(wf.id, 'm'))[0];
      assert.match(entry.stamp, /^st:/, `${type}: the entry got its stamp`);
      assert.notEqual(entry.cacheKey, oldKeyOfEntry, `${type}: and the key with it`);
      assert.equal((await history(wf.id, 'm')).length, 1, `${type}: no second entry`);
      // from now on it is an ordinary stamped entry: another setting runs the node
      world.model = 'm2';
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.m.status, 'stale', `${type}: a changed setting is seen after the adoption`);
      reset();
      assert.equal(statusOf(await run(wf.id)).m, 'done');
      world.model = 'm1';
    }
    // the check of the function says no: not taken
    {
      world.model = 'm1';
      world.legacy = true;
      const wf = await makeWorkflow([node('s', 't.state'), node('m', 't.model_verify')], [edge('e1', 's.out', 'm.in')], 'legacy verify no');
      await run(wf.id);
      world.legacy = false;
      world.model = 'm9'; // the entry says "m1:one", the setting is another: the check fails
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.m.status, 'stale');
      world.model = 'm1';
    }
    // only the first deploy adopts: once an entry has a stamp, an older one without it is not taken any more (true)
    {
      world.model = 'm1';
      world.legacy = true;
      const wf = await makeWorkflow([node('s', 't.state'), node('m', 't.model_adopt')], [edge('e1', 's.out', 'm.in')], 'legacy once');
      await run(wf.id); // entry A, no stamp, input "one"
      world.value = 'two';
      await run(wf.id); // entry B, no stamp, input "two"
      world.legacy = false;
      await run(wf.id); // B is adopted (the newest, the selected one)
      world.model = 'm2';
      await run(wf.id); // C with a stamp
      world.value = 'one';
      // the inputs of entry A again, with the setting of now: A has no stamp and is not taken, because the node is stamped now
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.m.status, 'stale');
      world.model = 'm1';
      world.value = 'one';
    }

    /* ----- per item ----- */
    {
      world.model = 'm1';
      const wf = await makeWorkflow([node('l', 't.list3'), node('i', 't.per_item')], [edge('e1', 'l.items', 'i.in')], 'items');
      assert.equal((await run(wf.id)).status, 'completed');
      assert.deepEqual([...world.itemRuns].sort(), ['a', 'b', 'c']);
      const entry = (await history(wf.id, 'i'))[0];
      assert.equal(entry.itemKeys.length, 3);
      assert.match(entry.stamp, /^st:/);
      // the keys of the items carry the stamp: the same keys, from the engine's own function, with that stamp
      const def = registry.get('t.per_item');
      const resolved = { mapLength: 3, mapped: ['in'], inputs: { in: listValue('text', ['a', 'b', 'c'].map(textValue)) } };
      assert.deepEqual(entry.itemKeys, computeItemKeys(def, {}, resolved, entry.stamp));
      assert.notDeepEqual(entry.itemKeys, computeItemKeys(def, {}, resolved));
      // unchanged: cached
      reset();
      assert.equal(statusOf(await run(wf.id)).i, 'cached');
      // another setting: every item is made again (an item made with the other setting is not reused), the plan says the same
      world.model = 'm2';
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.i.status, 'stale');
      assert.equal(plan.nodes.i.executions, 3);
      assert.equal(plan.nodes.i.reusedItems, undefined);
      reset();
      assert.equal(statusOf(await run(wf.id)).i, 'done');
      assert.deepEqual([...world.itemRuns].sort(), ['a', 'b', 'c']);
      // an item of the new setting is reused after the list changed (the keys carry the same stamp)
      world.model = 'm2';
      const changed = await engine.plan(wf.id, { mode: 'all', overrides: {} });
      assert.equal(changed.nodes.i.status, 'cached');
    }

    /* ----- an old entry with item keys is adopted with new item keys ----- */
    {
      world.model = 'm1';
      const wf = await makeWorkflow([node('l', 't.list3'), node('i', 't.per_item')], [edge('e1', 'l.items', 'i.in')], 'items adopt');
      // make the entry as an unstamped node would (the key and item keys of before): take the stamped run and rewrite it
      await run(wf.id);
      const def = registry.get('t.per_item');
      const resolved = { mapLength: 3, mapped: ['in'], inputs: { in: listValue('text', ['a', 'b', 'c'].map(textValue)) } };
      await wfStore.updateResults(wf.id, (results) => {
        const entry = results.nodes.i.history[0];
        delete entry.stamp;
        entry.cacheKey = computeCacheKey(def, {}, resolved.inputs);
        entry.itemKeys = computeItemKeys(def, {}, resolved);
        return JSON.parse(JSON.stringify(results.nodes.i));
      });
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { l: 'cached', i: 'cached' });
      const entry = (await history(wf.id, 'i'))[0];
      assert.match(entry.stamp, /^st:/);
      assert.deepEqual(entry.itemKeys, computeItemKeys(def, {}, resolved, entry.stamp), 'the item keys carry the stamp now');
      // and a later change of the list finds the items of the entry
      world.model = 'm1';
    }

    /* ----- a stamp that reads an input, behind another stamp ----- */
    {
      world.value = 'one';
      const wf = await makeWorkflow([node('s', 't.state'), node('r', 't.reads_input'), node('q', 't.plain')], [edge('e1', 's.out', 'r.in'), edge('e2', 'r.out', 'q.in')], 'chain');
      await run(wf.id);
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.deepEqual(Object.values(plan.nodes).map((entry) => entry.status), ['cached', 'cached', 'cached'], 'the plan finds the stamp of a node whose input it only knows from the cache');
      world.value = 'two';
      const stale = await engine.plan(wf.id, { mode: 'all' });
      assert.deepEqual(Object.values(stale.nodes).map((entry) => entry.status), ['stale', 'stale', 'stale']);
      assert.equal(stale.totals.usd, 0.1);
      reset();
      assert.deepEqual(statusOf(await run(wf.id)), { s: 'done', r: 'done', q: 'done' });
      world.value = 'one';
    }

    /* ----- run all again: every node, with the price ----- */
    {
      world.value = 'one';
      world.model = 'm1';
      const wf = await makeWorkflow([node('s', 't.state'), node('p', 't.paid'), node('m', 't.model_adopt'), node('q', 't.plain')], [edge('e1', 's.out', 'p.in'), edge('e2', 'p.out', 'm.in'), edge('e3', 'm.out', 'q.in')], 'again');
      await run(wf.id);
      const cached = await engine.plan(wf.id, { mode: 'all', force: false });
      assert.deepEqual(Object.values(cached.nodes).map((entry) => entry.status), ['cached', 'cached', 'cached', 'cached']);
      assert.equal(cached.totals.paidNodes, 0);
      const forced = await engine.plan(wf.id, { mode: 'all', force: true });
      assert.equal(forced.force, true);
      assert.deepEqual(Object.values(forced.nodes).map((entry) => entry.status), ['forced', 'forced', 'forced', 'forced'], 'every node runs');
      assert.equal(forced.totals.paidNodes, 2);
      assert.equal(forced.totals.usd, 0.75, 'the price of the whole run');
      assert.equal(forced.totals.unknownNodes, 0);
      reset();
      const record = await run(wf.id, { mode: 'all', force: true });
      assert.deepEqual(statusOf(record), { s: 'done', p: 'done', m: 'done', q: 'done' });
      assert.deepEqual(world.counts, { s: 1, p: 1, m: 1, q: 1 });
      assert.equal(record.force, true);
      assert.equal(record.cost.usd, 0.75);
      // the plan after it: up to date again
      assert.deepEqual(Object.values((await engine.plan(wf.id, { mode: 'all' })).nodes).map((entry) => entry.status), ['cached', 'cached', 'cached', 'cached']);
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-stamps.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
