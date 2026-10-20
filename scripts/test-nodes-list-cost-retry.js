'use strict';

// List pricing and retry regressions (#231, #249). Private app modules/storage, no sockets or provider calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createIsolatedApp } = require('./support/isolated-app');
const scenes = require('../public/nodes/scene-table');
const runUI = require('../public/nodes/run');

async function main() {
  const app = await createIsolatedApp({ loadServer: false });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Unexpected network call'); };
  let phase = 'setup';
  const watchdog = setTimeout(() => { throw new Error(`List pricing/retry test stalled: ${phase}`); }, 30000);
  try {
    const { createRegistry } = app.load('lib/nodes/registry');
    const { createEngine } = app.load('lib/nodes/engine');
    const { createWorkflowsStore } = app.load('lib/nodes/workflows-store');
    const { textValue, listValue } = app.load('lib/nodes/types');
    const { costCount } = app.load('lib/nodes/cost-history');
    await app.load('lib/store').ensureDirs();
    const registry = createRegistry();
    let singleFails = false;
    const singleCalls = [];
    registry.register({ type: 'test.single', category: 'text', paid: true, cost: { unit: 'usd', estimate: () => 0.1 },
      outputs: [{ id: 'out', type: 'text' }], execute: async (ctx) => {
        singleCalls.push(ctx.forced);
        if (singleFails) throw new Error('single failed');
        return { variants: [{ out: textValue('single') }], cost: { usd: 0.1 } };
      } });
    const imageRegistry = createRegistry();
    app.load('lib/nodes/nodes-generate').registerAll(imageRegistry);
    const calls = [];
    let failures = new Set();
    let unknownPrice = false;
    const model = 'google/gemini-nano-banana-2.1';
    const config = { imageModel: model, imageModels: [model] };
    registry.register({ type: 'test.list', category: 'input', outputs: [{ id: 'out', type: 'text[]' }],
      execute: async () => ({ variants: [{ out: listValue('text', Array.from({ length: 56 }, (_, i) => textValue(String(i)))) }] }) });
    registry.register({ type: 'test.ref', category: 'input', outputs: [{ id: 'out', type: 'image' }],
      execute: async () => ({ variants: [{ out: { type: 'image', sessionId: 's', assetId: 'ref' } }] }) });
    // Keep the real image pricing formula, model stamp and params. Replace only provider work/availability.
    registry.register({ ...imageRegistry.get('image.edit'), prepare: undefined, available: () => true,
      execute: async (ctx, _inputs, params) => {
        assert.equal(params.count, 1, 'mapped runs ignore the saved variant count');
        calls.push(ctx.itemIndex);
        return { variants: [{ image: { type: 'image', sessionId: 's', assetId: `image-${calls.length}` } }], cost: { usd: 2.29 / 56, model } };
      } });
    for (const type of ['test.history', 'test.unknown', 'test.video', 'test.variable']) registry.register({ type, category: 'text', paid: true,
      inputs: [{ id: 'in', type: 'text', required: true }], outputs: [{ id: 'out', type: 'text' }],
      params: [{ id: 'count', kind: 'integer', default: 1, min: 1, max: 4 }],
      cost: type === 'test.variable' ? { unit: 'usd', history: false, estimate: (_params, { inputs }) =>
        inputs.in?.type === 'text' ? (unknownPrice && inputs.in.value === '55' ? null : (Number(inputs.in.value) + 1) / 100) : 0.285
      } : type === 'test.video' ? { unit: 'usd', history: false, estimate: () => 0.48 } : { unit: 'usd', history: type !== 'test.unknown' },
      execute: async (ctx, inputs) => {
        if (failures.has(ctx.itemIndex)) throw Object.assign(new Error('failed clip'), { code: 'IMAGE_SAFETY_EXHAUSTED' });
        calls.push(ctx.itemIndex);
        return { variants: [{ out: textValue(`${inputs.in.value}-${calls.length}`) }], cost: {
          usd: type === 'test.variable' ? (Number(inputs.in.value) + 1) / 100 : type === 'test.video' ? 0.48 : 2.29 / 56
        } };
      } });
    const store = createWorkflowsStore({ dir: path.join(app.root, 'test-workflows'), registry });
    const engine = createEngine({ store, registry, getConfig: () => config, limits: { parallel: 3 } });
    // Invoke the real HTTP handlers in process: serialization is covered without opening a port.
    const handlers = new Map();
    const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method,
      (url, handler) => handlers.set(`${method} ${url}`, handler)]));
    app.load('lib/nodes/routes').registerNodeRoutes(routes, { engine, store, registry });
    async function post(wf, endpoint, body) {
      phase = `${endpoint}: ${JSON.stringify(body)}`;
      let data;
      let status = 200;
      const response = { status(code) { status = code; return this; }, json(value) { data = value; } };
      await handlers.get(`post /api/workflows/:id/${endpoint}`)({ params: { id: wf.id }, body }, response);
      assert.ok(status < 400, JSON.stringify(data));
      return data;
    }
    const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
    const edge = (id, source, port, target, input) => ({ id, from: { node: source, port }, to: { node: target, port: input } });
    async function workflow(type) {
      return (await store.createWorkflow({ name: 'List regression', graph: {
        nodes: [node('l', 'test.list'), node('r', 'test.ref'), node('m', type, { count: 4, model })],
        edges: [edge('e1', 'l', 'out', 'm', type === 'image.edit' ? 'prompt' : 'in'), ...(type === 'image.edit' ? [edge('e2', 'r', 'out', 'm', 'images')] : [])]
      } })).workflow;
    }
    async function run(wf, request) {
      return engine.whenFinished(wf.id, await engine.start(wf.id, request));
    }
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`);

    // The real Nano Banana formula must divide a 56-item history cost before pricing two chosen rows.
    for (const type of ['image.edit', 'test.history']) {
      const wf = await workflow(type);
      assert.equal((await run(wf, { mode: 'all' })).status, 'completed');
      const cached = await engine.plan(wf.id, { mode: 'all' });
      near(cached.nodes.m.itemEstimate.usd, 2.29 / 56);
      near(scenes.selectionCost(scenes.itemCost(cached.nodes.m, { paid: true }), 2).usd, 2.29 / 28);
      const request = { mode: 'items', nodeId: 'm', items: [1, 3] };
      const plan = await post(wf, 'runs/plan', request);
      assert.equal(plan.nodes.m.executions, 2);
      near(plan.nodes.m.estimate.usd, cached.nodes.m.itemEstimate.usd);
      near(plan.totals.usd, 2.29 / 28);
      calls.length = 0;
      const done = await run(wf, { ...request, maxUsd: 0.09, requireKnownPrices: true });
      assert.equal(done.status, 'completed', 'the per-step ceiling uses the same single-item price');
      assert.deepEqual(calls.sort((a, b) => a - b), [1, 3]);
      near(done.cost.usd, plan.totals.usd);
      const after = await engine.plan(wf.id, request);
      near(after.totals.usd, plan.totals.usd);
      assert.equal((await store.readResults(wf.id)).nodes.m.history[0].freshItemCount, 2);
    }

    // Legacy image lists have no fresh count; a list with two newly paid items must use two, never 56.
    const history = { params: { count: 4 }, variants: [{ image: listValue('image', Array(56).fill({ type: 'image' })) }] };
    assert.equal(costCount(history, true), 56);
    assert.equal(costCount({ ...history, freshItemCount: 2 }, true), 2);
    assert.equal(costCount({ ...history, freshItemCount: 0 }, true), 0);
    assert.equal(costCount({ params: {}, variants: history.variants }), 1, 'a node returning a whole list is not assumed to be a map');
    const unknown = await workflow('test.unknown');
    await run(unknown, { mode: 'all' });
    const unknownPlan = await engine.plan(unknown.id, { mode: 'items', nodeId: 'm', items: [0, 1] });
    assert.equal(unknownPlan.nodes.m.estimate, null, 'opting out of historical pricing still leaves the price unknown');
    assert.equal(unknownPlan.totals.unknownNodes, 1);

    // A costly selected input must not be priced by the average of all 56 inputs (for example differing clip lengths).
    const variable = await workflow('test.variable');
    await run(variable, { mode: 'all' });
    const variableCached = await engine.plan(variable.id, { mode: 'all' });
    near(scenes.itemCost(variableCached.nodes.m, { paid: true }, 55).usd, 0.56);
    const selection = [54, 55];
    const variablePlan = await post(variable, 'runs/plan', { mode: 'items', nodeId: 'm', items: selection });
    near(variablePlan.totals.usd, 1.11);
    near(scenes.selectionCost(selection.map((index) => scenes.itemCost(variableCached.nodes.m, { paid: true }, index))).usd, 1.11);
    assert.equal((await run(variable, { mode: 'items', nodeId: 'm', items: selection, maxUsd: 1.11 })).status, 'completed');
    unknownPrice = true;
    const mixedUnknown = await engine.plan(variable.id, { mode: 'items', nodeId: 'm', items: [0, 55] });
    assert.equal(mixedUnknown.nodes.m.estimate, null, 'a known cheap row never hides the unknown price of another chosen row');
    assert.equal(mixedUnknown.totals.unknownNodes, 1);
    unknownPrice = false;

    // Retry: 49 finished clips stay byte-for-byte; the plan, approval and execution cover only the missing seven.
    const video = await workflow('test.video');
    failures = new Set([0, 8, 16, 24, 32, 40, 48]);
    assert.equal((await run(video, { mode: 'all' })).status, 'failed');
    const partial = (await store.readResults(video.id)).nodes.m.partial;
    assert.equal(Object.keys(partial.items).length, 49);
    failures.clear();
    const retry = { mode: 'node', nodeIds: ['m'], force: false, retry: true };
    const plan = await engine.plan(video.id, retry);
    assert.equal(plan.nodes.m.executions, 7);
    assert.equal(plan.nodes.m.reusedItems, 49);
    near(plan.totals.usd, 3.36);
    const description = runUI.describePlan(plan);
    assert.equal(description.paid[0].executions, 7);
    assert.equal(description.paid[0].reusedItems, 49);
    calls.length = 0;
    const done = await run(video, { ...retry, maxUsd: 3.36, requireKnownPrices: true });
    assert.equal(done.status, 'completed');
    assert.equal(calls.length, 7);
    near(done.cost.usd, 3.36);
    const entry = (await store.readResults(video.id)).nodes.m.history[0];
    for (const [index, item] of Object.entries(partial.items)) assert.deepEqual(entry.variants[0].out.items[index], item.variant.out);
    const allAgain = await engine.plan(video.id, { mode: 'node', nodeIds: ['m'], force: true });
    assert.equal(allAgain.nodes.m.executions, 56, 'explicitly making everything again remains available');
    near(allAgain.totals.usd, 26.88);

    // A failed explicit fresh run also resumes its own partial, rather than silently selecting the older complete list.
    failures = new Set([0, 8, 16, 24, 32, 40, 48]);
    assert.equal((await run(video, { mode: 'node', nodeIds: ['m'], force: true })).status, 'failed');
    const freshPartial = (await store.readResults(video.id)).nodes.m.partial;
    failures.clear();
    const retryFresh = await post(video, 'runs/plan', retry);
    assert.equal(retryFresh.nodes.m.executions, 7);
    assert.equal(retryFresh.nodes.m.reusedItems, 49);
    calls.length = 0;
    const started = await post(video, 'runs', { ...retry, maxUsd: 3.36 });
    assert.equal((await engine.whenFinished(video.id, started.runId)).status, 'completed');
    assert.equal(calls.length, 7);
    const freshEntry = (await store.readResults(video.id)).nodes.m.history[0];
    for (const [index, item] of Object.entries(freshPartial.items)) assert.deepEqual(freshEntry.variants[0].out.items[index], item.variant.out);

    // Scalar Retry keeps its previous behavior: retry the failed execution, rather than choosing an older whole result.
    const single = (await store.createWorkflow({ name: 'Scalar retry', graph: { nodes: [node('m', 'test.single')], edges: [] } })).workflow;
    await run(single, { mode: 'all' });
    singleFails = true;
    assert.equal((await run(single, { mode: 'node', nodeIds: ['m'], force: true })).status, 'failed');
    singleFails = false;
    assert.equal((await engine.plan(single.id, retry)).nodes.m.executions, 1);
    assert.equal((await run(single, retry)).status, 'completed');
    assert.deepEqual(singleCalls, [false, true, true]);
    console.log('test-nodes-list-cost-retry.js: ok');
  } finally {
    clearTimeout(watchdog);
    global.fetch = originalFetch;
    await app.cleanup();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
