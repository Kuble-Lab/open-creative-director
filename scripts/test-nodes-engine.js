'use strict';

// Engine tests with fake executors: topo order, pool limit, cache, force, plan, errors,
// cancel, lists, overrides, job waiting. No provider calls; backing sessions are real and removed.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine, createSemaphore } = require('../lib/nodes/engine');
const jobs = require('../lib/nodes/jobs');
const { textValue, listValue } = require('../lib/nodes/types');
const nodesBasic = require('../lib/nodes/nodes-basic');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

function edges(...specs) {
  return specs.map((spec, index) => {
    const [from, to] = spec.split('>');
    const [fromNode, fromPort] = from.split('.');
    const [toNode, toPort] = to.split('.');
    return { id: `e${index + 1}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
  });
}

function buildEnvironment() {
  const calls = [];
  const state = { active: 0, peak: 0, counts: {}, startOrder: [], finishOrder: [], estimateContexts: [] };

  async function tracked(ctx, work) {
    state.counts[ctx.nodeId] = (state.counts[ctx.nodeId] || 0) + 1;
    state.startOrder.push(ctx.nodeId);
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    try {
      return await work();
    } finally {
      state.active -= 1;
      state.finishOrder.push(ctx.nodeId);
    }
  }

  const registry = createRegistry();
  registry.register({
    type: 't.src',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'text', kind: 'text', default: 'x' }, { id: 'delay', kind: 'integer', default: 0 }],
    execute: (ctx, _inputs, params) =>
      tracked(ctx, async () => {
        if (params.delay) await sleep(params.delay);
        return { variants: [{ out: textValue(params.text) }] };
      })
  });
  registry.register({
    type: 't.stamp',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: (ctx, inputs) =>
      tracked(ctx, async () => ({ variants: [{ out: textValue(`${inputs.in.value}-stamp${state.counts[ctx.nodeId]}`) }] }))
  });
  registry.register({
    type: 't.upper',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'delay', kind: 'integer', default: 15 }, { id: 'suffix', kind: 'text', default: '' }],
    execute: (ctx, inputs, params) =>
      tracked(ctx, async () => {
        await sleep(params.delay);
        return { variants: [{ out: textValue(inputs.in.value.toUpperCase() + params.suffix) }] };
      })
  });
  registry.register({
    type: 't.join2',
    category: 'text',
    inputs: [{ id: 'a', type: 'text', required: true }, { id: 'b', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: (ctx, inputs) =>
      tracked(ctx, async () => {
        await sleep(10);
        return { variants: [{ out: textValue(`${inputs.a.value}|${inputs.b.value}`) }] };
      })
  });
  registry.register({
    type: 't.fail',
    category: 'text',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: (ctx) =>
      tracked(ctx, async () => {
        await sleep(5);
        throw new Error('boom');
      })
  });
  registry.register({
    type: 't.list',
    category: 'input',
    outputs: [{ id: 'items', type: 'text[]' }],
    params: [{ id: 'n', kind: 'integer', default: 3 }],
    execute: (ctx, _inputs, params) =>
      tracked(ctx, async () => ({
        variants: [{ items: listValue('text', Array.from({ length: params.n }, (_v, i) => textValue(`item${i + 1}`))) }]
      }))
  });
  registry.register({
    type: 't.counted',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'count', kind: 'integer', default: 2, min: 1, max: 4 }],
    paid: true,
    cost: { unit: 'usd' },
    execute: (ctx, inputs, params) =>
      tracked(ctx, async () => {
        calls.push({ node: ctx.nodeId, count: params.count, item: ctx.itemIndex });
        await sleep(5);
        return {
          variants: Array.from({ length: params.count }, (_v, i) => ({ out: textValue(`${inputs.in.value}#${i + 1}`) })),
          cost: { usd: 0.01 * params.count }
        };
      })
  });
  // A price that depends on a field: known from the field, unknown (and never a guess from an earlier result) when the
  // input arrives through a connection. The estimate gets the connected ports.
  registry.register({
    type: 't.sized',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', param: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'text', kind: 'text', default: 'abc' }],
    paid: true,
    cost: {
      unit: 'usd',
      history: false,
      estimate: (params, context) => {
        const inputs = Object.fromEntries(Object.entries(context.inputs).map(([port, value]) => [port, value.value]));
        state.estimateContexts.push({ nodeId: context.nodeId, connected: [...context.connected], inputs });
        return context.connected.has('in') ? null : params.text.length * 0.01;
      }
    },
    execute: (ctx, inputs) =>
      tracked(ctx, async () => ({ variants: [{ out: textValue(inputs.in.value) }], cost: { usd: 0.5 } }))
  });
  registry.register({
    type: 't.freecall',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    cost: { unit: 'free' },
    execute: (ctx, inputs) => tracked(ctx, async () => ({ variants: [{ out: textValue(inputs.in.value) }] }))
  });
  // an error with a stable code and values for its translated text
  registry.register({
    type: 't.coded',
    category: 'text',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: (ctx) =>
      tracked(ctx, async () => {
        const err = new Error('Line 3: no');
        err.code = 'T_CODED_FAILURE';
        err.data = { line: 3, suggestion: 'x'.repeat(9000), nested: { no: true }, flag: true };
        throw err;
      })
  });
  registry.register({
    type: 't.itemflaky',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    paid: true,
    cost: { unit: 'usd' },
    execute: (ctx, inputs) =>
      tracked(ctx, async () => {
        calls.push({ node: ctx.nodeId, item: inputs.in.value });
        await sleep(15);
        if (state.failItem && inputs.in.value === state.failItem) throw new Error(`rejected ${state.failItem}`);
        return { variants: [{ out: textValue(`${inputs.in.value}!`) }], cost: { usd: 0.5 } };
      })
  });
  registry.register({
    type: 't.hang',
    category: 'text',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: (ctx) =>
      tracked(ctx, async () => {
        state.hangStarted = true;
        await jobs.sleep(60000, ctx.signal);
        return { variants: [{ out: textValue('never') }] };
      })
  });
  registry.register({
    type: 't.unavail',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }],
    available: () => 'no key configured',
    execute: async () => ({ variants: [{ out: textValue('x') }] })
  });
  registry.register({
    type: 't.job',
    category: 'video',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    async: true,
    execute: (ctx) =>
      tracked(ctx, async () => {
        const jobId = `job-${ctx.nodeId}`;
        await store.mutateSession(ctx.sessionId, (session) => {
          session.jobs.push({ jobId, assetId: 'vid-001', status: 'pending', kind: 'video' });
        });
        state.jobSubmitted = jobId;
        const ids = await ctx.waitForJob({ jobId });
        return { variants: [{ out: textValue(`done:${ids.join(',')}`) }] };
      })
  });
  registry.register({
    type: 't.bad',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => ({ variants: [{ nope: textValue('x') }] })
  });
  registry.register({
    type: 't.vid',
    category: 'video',
    outputs: [{ id: 'video', type: 'video' }],
    execute: async () => ({ variants: [] })
  });
  // An output that may stay empty. mode lean: the node says so beforehand (emptyOutputs(params), the plan refuses a connection
  // from it); mode silent: it delivers no value for `extra` without saying so (an optional result that did not come).
  registry.register({
    type: 't.optional',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }, { id: 'extra', type: 'text' }],
    params: [{ id: 'mode', kind: 'select', options: ['full', 'lean', 'silent'], default: 'full' }],
    emptyOutputs: (params) => (params.mode === 'lean' ? ['extra'] : []),
    execute: (ctx, _inputs, params) =>
      tracked(ctx, async () => ({ variants: [params.mode === 'full' ? { out: textValue('main'), extra: textValue('more') } : { out: textValue('main') }] }))
  });
  nodesBasic.registerAll(registry);
  return { registry, calls, state };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-engine-'));
  const bus = createEventBus();
  const created = [];
  let env = buildEnvironment();
  const wfStore = createWorkflowsStore({ dir, registry: env.registry, events: bus });

  function makeEngine(limits = {}) {
    return createEngine({ store: wfStore, registry: env.registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20, ...limits } });
  }

  async function makeWorkflow(nodes, edgeList = [], name = 'Engine test') {
    const result = await wfStore.createWorkflow({ name, graph: { nodes, edges: edgeList } });
    created.push(result.workflow.id);
    return result.workflow;
  }

  async function run(engine, workflowId, request) {
    const runId = await engine.start(workflowId, request);
    const record = await engine.whenFinished(workflowId, runId);
    return record;
  }

  function resetState() {
    env.state.active = 0;
    env.state.peak = 0;
    env.state.counts = {};
    env.state.startOrder = [];
    env.state.finishOrder = [];
    env.state.estimateContexts = [];
    env.calls.length = 0;
  }

  const results = async (id, nodeId) => (await wfStore.readResults(id)).nodes[nodeId];
  const selectedValue = async (id, nodeId, port) => {
    const nodeResults = await results(id, nodeId);
    const entry = nodeResults.history.find((item) => item.id === nodeResults.selected.entry);
    return entry.variants[nodeResults.selected.variant][port];
  };

  try {
    /* ----- semaphore ----- */
    {
      const semaphore = createSemaphore(2);
      const controller = new AbortController();
      await semaphore.acquire();
      await semaphore.acquire();
      const waiting = semaphore.acquire(controller.signal);
      controller.abort();
      await assert.rejects(waiting, { name: 'AbortError' });
      assert.equal(semaphore.waiting, 0);
      semaphore.release();
      semaphore.release();
      assert.equal(semaphore.active, 0);
    }

    /* ----- topo order, pool limit, events ----- */
    {
      resetState();
      const events = [];
      const wf = await makeWorkflow(
        [
          node('a', 't.src', { text: 'hello' }, 0, 0),
          node('b', 't.upper', {}, 100, 0),
          node('c', 't.upper', {}, 100, 10),
          node('d', 't.upper', {}, 100, 20),
          node('e', 't.upper', {}, 100, 30),
          node('f', 't.join2', {}, 200, 0)
        ],
        edges('a.out>b.in', 'a.out>c.in', 'a.out>d.in', 'a.out>e.in', 'b.out>f.a', 'c.out>f.b')
      );
      const unsubscribe = bus.subscribe(wf.id, (event) => events.push(event));
      const engine = makeEngine({ parallel: 2 });
      const record = await run(engine, wf.id, { mode: 'all', user: 'tester' });
      unsubscribe();

      assert.equal(record.status, 'completed');
      assert.equal(record.user, 'tester');
      assert.ok(env.state.peak >= 2, 'nodes should run in parallel');
      assert.ok(env.state.peak <= 2, `pool limit exceeded: ${env.state.peak}`);
      assert.equal(env.state.startOrder[0], 'a');
      const finishIndex = (id) => env.state.finishOrder.indexOf(id);
      const startIndex = (id) => env.state.startOrder.indexOf(id);
      assert.ok(startIndex('f') > finishIndex('b') && startIndex('f') > finishIndex('c'), 'f starts after b and c finished');
      for (const id of ['b', 'c', 'd', 'e']) assert.ok(startIndex(id) > finishIndex('a'));
      assert.equal((await selectedValue(wf.id, 'f', 'out')).value, 'HELLO|HELLO');

      const types = events.map((event) => event.type);
      assert.equal(types[0], 'run_started');
      assert.equal(types.at(-1), 'run_finished');
      assert.ok(types.includes('node_result') && types.includes('node_status'));
      assert.deepEqual(events[0].plan.a, 'stale');
      const bStatuses = events.filter((event) => event.type === 'node_status' && event.nodeId === 'b').map((event) => event.status);
      assert.deepEqual(bStatuses, ['queued', 'running', 'done']);

      const stored = await wfStore.readRun(wf.id, record.id);
      assert.equal(stored.status, 'completed');
      assert.equal(stored.nodes.f.status, 'done');
      assert.equal(engine.activeRun(wf.id), null);

      /* ----- second run: everything cached ----- */
      resetState();
      const second = await run(engine, wf.id, { mode: 'all' });
      assert.equal(second.status, 'completed');
      assert.deepEqual(Object.values(second.nodes).map((entry) => entry.status), Array(6).fill('cached'));
      assert.deepEqual(env.state.counts, {}, 'cache hits must not execute');

      /* ----- force only re-executes targets ----- */
      resetState();
      const forced = await run(engine, wf.id, { mode: 'node', nodeIds: ['b'], force: true });
      assert.equal(forced.nodes.a.status, 'cached');
      assert.equal(forced.nodes.b.status, 'done');
      assert.deepEqual(env.state.counts, { b: 1 });
      const bResults = await results(wf.id, 'b');
      assert.equal(bResults.history.length, 2);
      assert.equal(bResults.selected.entry, bResults.history[0].id);
      assert.equal(forced.nodes.f, undefined, 'f is not part of the required set');

      /* ----- plan: params and upstream selection make descendants stale ----- */
      const cleanPlan = await engine.plan(wf.id, { mode: 'all' });
      assert.ok(Object.values(cleanPlan.nodes).every((entry) => entry.status === 'cached'), JSON.stringify(cleanPlan.nodes));
      const current = await wfStore.readWorkflow(wf.id);
      const changedNodes = current.graph.nodes.map((item) => (item.id === 'a' ? { ...item, params: { text: 'other' } } : item));
      await wfStore.saveGraph(wf.id, { baseRev: current.rev, graph: { ...current.graph, nodes: changedNodes } });
      const stalePlan = await engine.plan(wf.id, { mode: 'all' });
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(stalePlan.nodes[id].status, 'stale', id);

      // re-run to make everything cached again, then flip the selected variant of b
      await run(engine, wf.id, { mode: 'all' });
      assert.ok(Object.values((await engine.plan(wf.id, { mode: 'all' })).nodes).every((entry) => entry.status === 'cached'));
      const bNow = await results(wf.id, 'b');
      await run(engine, wf.id, { mode: 'node', nodeIds: ['b'], force: true });
      const bAfter = await results(wf.id, 'b');
      assert.notEqual(bAfter.selected.entry, bNow.selected.entry);
      const plannedAfterForce = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plannedAfterForce.nodes.b.status, 'cached', 'same inputs give the same cache key');
      // b's new result has identical values, so choose the older entry: fingerprints equal -> f stays cached
      await wfStore.selectVariant(wf.id, 'b', { entry: bNow.selected.entry, variant: 0 });
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.f.status, 'cached');
      await assert.rejects(wfStore.selectVariant(wf.id, 'b', { entry: 'h-missing', variant: 0 }), { code: 'ENTRY_NOT_FOUND' });
    }

    /* ----- an older version with the same cache key stays selected (variant history) ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('s', 't.src', { text: 'ok' }, 0, 0), node('st', 't.stamp', {}, 100, 0), node('u', 't.upper', {}, 200, 0)],
        edges('s.out>st.in', 'st.out>u.in')
      );
      const engine = makeEngine();
      await run(engine, wf.id, { mode: 'all' });
      await run(engine, wf.id, { mode: 'node', nodeIds: ['st'], force: true });
      const stamped = await results(wf.id, 'st');
      assert.equal(stamped.history.length, 2);
      const [newer, older] = stamped.history;
      assert.equal(newer.cacheKey, older.cacheKey, 'a forced re-run shares the cache key');
      assert.notEqual(newer.variants[0].out.value, older.variants[0].out.value);

      // u ran for the first stamp: selecting the older version makes it (and the plan) consistent again
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.u.status, 'stale', 'the newer version is selected: u is stale');
      await wfStore.selectVariant(wf.id, 'st', { entry: older.id, variant: 0 });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.st.status, 'cached');
      assert.equal(plan.nodes.u.status, 'cached', 'the selected older version feeds u');
      resetState();
      const rerun = await run(engine, wf.id, { mode: 'all' });
      assert.equal(rerun.nodes.st.status, 'cached');
      assert.equal(rerun.nodes.u.status, 'cached');
      assert.deepEqual(env.state.counts, {}, 'nothing executes');
      assert.equal((await results(wf.id, 'st')).selected.entry, older.id, 'a run keeps the version the user selected');

      await wfStore.selectVariant(wf.id, 'st', { entry: newer.id, variant: 0 });
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.u.status, 'stale');
    }

    /* ----- errors block descendants, independent branches finish ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [
          node('s', 't.src', { text: 'ok' }, 0, 0),
          node('bad', 't.fail', {}, 100, 0),
          node('after', 't.upper', {}, 200, 0),
          node('after2', 't.upper', {}, 300, 0),
          node('good', 't.upper', {}, 100, 50)
        ],
        edges('s.out>bad.in', 'bad.out>after.in', 'after.out>after2.in', 's.out>good.in')
      );
      const events = [];
      bus.subscribe(wf.id, (event) => events.push(event));
      const engine = makeEngine();
      const record = await run(engine, wf.id, { mode: 'all' });
      assert.equal(record.status, 'failed');
      assert.equal(record.nodes.bad.status, 'error');
      assert.equal(record.nodes.bad.message, 'boom');
      assert.equal(record.nodes.after.status, 'skipped');
      assert.equal(record.nodes.after.message, 'blocked by bad');
      assert.equal(record.nodes.after2.status, 'skipped');
      assert.equal(record.nodes.after2.message, 'blocked by bad');
      assert.equal(record.nodes.good.status, 'done');
      assert.match(record.error, /^bad: boom/);
      assert.equal(events.at(-1).status, 'failed');
      assert.equal(env.state.counts.after, undefined);
    }

    /* ----- validation errors fail before execution ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('a', 't.src'), node('u', 't.upper'), node('v', 't.vid'), node('x', 'no.such_type')],
        edges('v.video>u.in')
      );
      const engine = makeEngine();
      await assert.rejects(engine.start(wf.id, { mode: 'node', nodeIds: ['u'] }), (err) => {
        assert.equal(err.code, 'INVALID_GRAPH');
        assert.ok(err.issues.some((issue) => issue.code === 'incompatible'));
        return true;
      });
      const wf2 = await makeWorkflow([node('u', 't.upper')], []);
      await assert.rejects(engine.start(wf2.id, { mode: 'all' }), (err) => {
        assert.equal(err.code, 'INVALID_GRAPH');
        assert.ok(err.issues.some((issue) => issue.code === 'missing_input' && issue.nodeId === 'u'));
        return true;
      });
      const plan = await engine.plan(wf2.id, { mode: 'all' });
      assert.equal(plan.valid, false);
      assert.equal(plan.nodes.u.status, 'invalid');
      assert.equal(plan.nodes.u.reasonCode, 'missing_input');
      assert.equal(plan.nodes.u.reasonPort, 'in', 'the plan names the input that is missing (the fix button needs it)');
      // unknown node types are kept but not executable
      const wf3 = await makeWorkflow([node('a', 't.src'), node('x', 'no.such_type')], []);
      const record = await run(engine, wf3.id, { mode: 'all' });
      assert.equal(record.status, 'completed');
      assert.equal(record.nodes.x, undefined);
      await assert.rejects(engine.start(wf3.id, { mode: 'node', nodeIds: ['x'] }), { code: 'INVALID_REQUEST' });
      await assert.rejects(engine.start(wf3.id, { mode: 'node', nodeIds: ['zzz'] }), { code: 'INVALID_REQUEST' });
      assert.deepEqual(env.state.counts, { a: 1 });
    }

    /* ----- unavailable nodes ----- */
    {
      const wf = await makeWorkflow([node('un', 't.unavail')], []);
      const engine = makeEngine();
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.un.status, 'unavailable');
      assert.equal(plan.nodes.un.reason, 'no key configured');
      const record = await run(engine, wf.id, { mode: 'all' });
      assert.equal(record.nodes.un.status, 'error');
      assert.equal(record.nodes.un.message, 'unavailable: no key configured');
    }

    /* ----- bad executor results become node errors ----- */
    {
      const wf = await makeWorkflow([node('b', 't.bad')], []);
      const record = await run(makeEngine(), wf.id, { mode: 'all' });
      assert.equal(record.nodes.b.status, 'error');
      assert.match(record.nodes.b.message, /unknown output nope/);
    }

    /* ----- an output that stays empty: refused before the run when the node says so, else the node behind stops with a code ----- */
    {
      resetState();
      const engine = makeEngine();
      const graph = (mode) =>
        makeWorkflow([node('o', 't.optional', { mode }), node('u', 't.upper'), node('a', 't.upper')], edges('o.extra>u.in', 'o.out>a.in'));
      // announced: the start and the plan refuse the connection, nothing runs, the node behind and the output are named
      const lean = await graph('lean');
      await assert.rejects(engine.start(lean.id, { mode: 'all' }), (err) => {
        assert.equal(err.code, 'INVALID_GRAPH');
        const issue = err.issues.find((item) => item.code === 'OUTPUT_EMPTY');
        assert.deepEqual([issue.nodeId, issue.port, issue.level, issue.data], ['u', 'in', 'error', { input: 'in', output: 'extra' }]);
        assert.equal(err.issues.filter((item) => item.code === 'OUTPUT_EMPTY').length, 1, 'only the connection from the empty output');
        return true;
      });
      const leanPlan = await engine.plan(lean.id, { mode: 'all' });
      assert.equal(leanPlan.valid, false);
      assert.equal(leanPlan.nodes.u.status, 'invalid');
      assert.equal(leanPlan.nodes.u.reasonCode, 'OUTPUT_EMPTY');
      assert.deepEqual(leanPlan.nodes.u.reasonData, { input: 'in', output: 'extra' });
      assert.notEqual(leanPlan.nodes.a.status, 'invalid', 'the connection from the other output is fine');
      assert.deepEqual(env.state.counts, {}, 'nothing ran');
      // the output is there: all is well
      const full = await graph('full');
      assert.equal((await engine.plan(full.id, { mode: 'all' })).valid, true);
      assert.equal((await run(engine, full.id, { mode: 'all' })).status, 'completed');
      assert.equal((await selectedValue(full.id, 'u', 'out')).value, 'MORE');
      // not announced: the plan cannot know, the run stops the node behind with the same code; the node before and the other branch stay
      resetState();
      const silent = await graph('silent');
      assert.equal((await engine.plan(silent.id, { mode: 'all' })).valid, true);
      const stopped = await run(engine, silent.id, { mode: 'all' });
      assert.equal(stopped.status, 'failed');
      assert.equal(stopped.nodes.o.status, 'done');
      assert.equal(stopped.nodes.u.status, 'error');
      assert.equal(stopped.nodes.u.code, 'OUTPUT_EMPTY');
      assert.deepEqual(stopped.nodes.u.data, { input: 'in', output: 'extra' });
      assert.match(stopped.nodes.u.message, /produced no extra/);
      assert.equal(stopped.nodes.a.status, 'done');
      assert.equal(env.state.counts.u, undefined, 'the node behind never started');
      // and the plan afterwards knows it too: the stored result has no value for the output
      const afterwards = await engine.plan(silent.id, { mode: 'all' });
      assert.equal(afterwards.nodes.u.status, 'invalid');
      assert.equal(afterwards.nodes.u.reasonCode, 'OUTPUT_EMPTY');
    }

    /* ----- cancel: aborts a waiting executor, pending nodes become cancelled ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('h', 't.hang', {}, 0, 0), node('next', 't.upper', {}, 100, 0), node('other', 't.src', {}, 0, 100)],
        edges('h.out>next.in')
      );
      const engine = makeEngine();
      const events = [];
      bus.subscribe(wf.id, (event) => events.push(event));
      const runId = await engine.start(wf.id, { mode: 'all' });
      await assert.rejects(engine.start(wf.id, { mode: 'all' }), (err) => err.code === 'RUN_ACTIVE' && err.runId === runId);
      assert.equal(engine.activeRun(wf.id).runId, runId);
      while (!env.state.hangStarted) await sleep(5);
      assert.equal(engine.cancel(wf.id, 'other-run'), false);
      assert.equal(engine.cancel(wf.id, runId), true);
      const record = await engine.whenFinished(wf.id, runId);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.nodes.h.status, 'cancelled');
      assert.equal(record.nodes.next.status, 'cancelled');
      assert.ok(events.some((event) => event.type === 'node_status' && event.nodeId === 'next' && event.status === 'cancelled'));
      assert.equal(engine.cancel(wf.id, runId), false, 'finished runs cannot be cancelled');
    }

    /* ----- run limits and rev check ----- */
    {
      resetState();
      const wf1 = await makeWorkflow([node('a', 't.hang')], []);
      const wf2 = await makeWorkflow([node('a', 't.hang')], []);
      const engine = makeEngine({ maxActiveRuns: 1 });
      const runId = await engine.start(wf1.id, {});
      await assert.rejects(engine.start(wf2.id, {}), { code: 'RUN_LIMIT' });
      engine.cancel(wf1.id, runId);
      await engine.whenFinished(wf1.id, runId);
      await assert.rejects(engine.start(wf2.id, { rev: 99 }), (err) => err.code === 'REV_CONFLICT' && err.rev === 1);
      const okId = await engine.start(wf2.id, { rev: 1 });
      engine.cancel(wf2.id, okId);
      await engine.whenFinished(wf2.id, okId);
    }

    /* ----- lists: implicit map, zip, count forced to 1, limits ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [
          node('l', 't.list', { n: 3 }, 0, 0),
          node('m', 't.counted', { count: 3 }, 100, 0),
          node('pre', 't.src', { text: 'P' }, 0, 100),
          node('z', 't.join2', {}, 200, 0),
          node('l2', 't.list', { n: 3 }, 0, 200),
          node('u', 't.upper', { delay: 20 }, 100, 200)
        ],
        edges('l.items>m.in', 'pre.out>z.a', 'm.out>z.b', 'l2.items>u.in')
      );
      const engine = makeEngine({ parallel: 3 });
      const record = await run(engine, wf.id, { mode: 'all' });
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(env.state.counts.m, 3, 'one execution per list item');
      assert.ok(env.calls.every((call) => call.count === 1), 'count forced to 1 inside a map');
      assert.deepEqual(env.calls.map((call) => call.item).sort(), [0, 1, 2]);
      const mOut = await selectedValue(wf.id, 'm', 'out');
      assert.deepEqual(mOut.items.map((item) => item.value), ['item1#1', 'item2#1', 'item3#1']);
      const mEntry = (await results(wf.id, 'm')).history[0];
      assert.equal(mEntry.variants.length, 1, 'a mapped node stores one variant with list ports');
      assert.ok(Math.abs(mEntry.cost.usd - 0.03) < 1e-9, `summed item cost: ${mEntry.cost.usd}`);
      const zOut = await selectedValue(wf.id, 'z', 'out');
      assert.deepEqual(zOut.items.map((item) => item.value), ['P|item1#1', 'P|item2#1', 'P|item3#1'], 'scalar input is broadcast');
      const uOut = await selectedValue(wf.id, 'u', 'out');
      assert.deepEqual(uOut.items.map((item) => item.value), ['ITEM1', 'ITEM2', 'ITEM3']);

      // zip of two lists with the same length, then a mismatch
      const zipWf = await makeWorkflow(
        [node('a', 't.list', { n: 2 }), node('b', 't.list', { n: 2 }), node('z', 't.join2')],
        edges('a.items>z.a', 'b.items>z.b')
      );
      const zipRecord = await run(engine, zipWf.id, { mode: 'all' });
      assert.equal(zipRecord.status, 'completed');
      assert.deepEqual((await selectedValue(zipWf.id, 'z', 'out')).items.map((item) => item.value), ['item1|item1', 'item2|item2']);
      const mismatch = await makeWorkflow(
        [node('a', 't.list', { n: 2 }), node('b', 't.list', { n: 3 }), node('z', 't.join2')],
        edges('a.items>z.a', 'b.items>z.b')
      );
      const bad = await run(engine, mismatch.id, { mode: 'all' });
      assert.equal(bad.nodes.z.status, 'error');
      assert.match(bad.nodes.z.message, /different lengths/);

      const tooMany = await makeWorkflow([node('a', 't.list', { n: 51 }), node('u', 't.upper')], edges('a.items>u.in'));
      const big = await run(engine, tooMany.id, { mode: 'all' });
      assert.equal(big.nodes.u.status, 'error');
      assert.match(big.nodes.u.message, /limit is 50/);
    }

    /* ----- a failing list item fails the node ----- */
    {
      env.registry.register({
        type: 't.flaky',
        category: 'text',
        inputs: [{ id: 'in', type: 'text', required: true }],
        outputs: [{ id: 'out', type: 'text' }],
        execute: async (_ctx, inputs) => {
          if (inputs.in.value === 'item2') throw new Error('item exploded');
          return { variants: [{ out: inputs.in }] };
        }
      });
      const wf = await makeWorkflow([node('l', 't.list'), node('f', 't.flaky')], edges('l.items>f.in'));
      const record = await run(makeEngine(), wf.id, { mode: 'all' });
      assert.equal(record.nodes.f.status, 'error');
      assert.match(record.nodes.f.message, /Item 2 of 3: item exploded/);
    }

    /* ----- overrides change the key but not the saved graph ----- */
    {
      resetState();
      const wf = await makeWorkflow([node('a', 't.src', { text: 'saved' }), node('u', 't.upper')], edges('a.out>u.in'));
      const engine = makeEngine();
      await run(engine, wf.id, { mode: 'all' });
      assert.equal((await selectedValue(wf.id, 'u', 'out')).value, 'SAVED');
      const overridden = await run(engine, wf.id, { mode: 'all', overrides: { a: { text: 'from app' } } });
      assert.equal(overridden.nodes.a.status, 'done');
      assert.equal((await selectedValue(wf.id, 'u', 'out')).value, 'FROM APP');
      assert.deepEqual(overridden.overrides, { a: { text: 'from app' } });
      const reloaded = await wfStore.readWorkflow(wf.id);
      assert.equal(reloaded.graph.nodes[0].params.text, 'saved');
      assert.equal(reloaded.rev, 1, 'overrides must not touch the saved graph');
      const cachedAgain = await run(engine, wf.id, { mode: 'all', overrides: { a: { text: 'from app' } } });
      assert.equal(cachedAgain.nodes.u.status, 'cached');
      await assert.rejects(engine.start(wf.id, { mode: 'all', overrides: { nope: {} } }), { code: 'INVALID_REQUEST' });
    }

    /* ----- costs: run total, plan estimates (last actual cost, unknown) ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('a', 't.src', { text: 'p' }), node('c', 't.counted', { count: 2 }), node('c2', 't.counted', { count: 4 })],
        edges('a.out>c.in', 'a.out>c2.in')
      );
      const engine = makeEngine();
      const before = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(before.nodes.c.paid, true);
      assert.equal(before.nodes.c.estimate, null, 'no prior cost: unknown');
      assert.equal(before.totals.paidNodes, 2);
      assert.equal(before.totals.unknownNodes, 2);
      const events = [];
      bus.subscribe(wf.id, (event) => events.push(event));
      const record = await run(engine, wf.id, { mode: 'node', nodeIds: ['c'] });
      assert.ok(Math.abs(record.cost.usd - 0.02) < 1e-9);
      assert.ok(events.some((event) => event.type === 'run_cost' && Math.abs(event.usd - 0.02) < 1e-9));
      const c = await results(wf.id, 'c');
      assert.equal(c.history[0].variants.length, 2, 'count 2 gives two variants');
      assert.ok(Math.abs(c.history[0].cost.usd - 0.02) < 1e-9);
      const after = await engine.plan(wf.id, { mode: 'node', nodeIds: ['c2'], force: true });
      assert.equal(after.nodes.c2.status, 'forced');
      assert.ok(Math.abs(after.nodes.c2.estimate.usd - 0.04) < 1e-9, 'estimate = last actual cost of the type, scaled by count');
      assert.equal(after.totals.unknownNodes, 0);
      assert.ok(Math.abs(after.totals.usd - 0.04) < 1e-9);
      const forcedPlan = await engine.plan(wf.id, { mode: 'node', nodeIds: ['c'], force: true });
      assert.equal(forcedPlan.nodes.c.status, 'forced');
      assert.ok(forcedPlan.nodes.c.lastCost.usd > 0);
    }

    /* ----- costs: an estimate that knows the connections, no guess from history, the free unit, coded errors with values ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('a', 't.src', { text: 'hello' }), node('typed', 't.sized', { text: 'abcd' }), node('wired', 't.sized'), node('free', 't.freecall'), node('bad', 't.coded')],
        edges('a.out>wired.in', 'a.out>free.in')
      );
      const engine = makeEngine();
      assert.equal(env.registry.get('t.freecall').cost.unit, 'free');
      assert.equal(env.registry.get('t.freecall').paid, false);
      assert.equal(env.registry.publicDescriptor(env.registry.get('t.freecall')).cost.unit, 'free');
      assert.equal(env.registry.get('t.sized').cost.history, false);
      assert.equal(env.registry.get('t.counted').cost.history, true, 'the guess from history stays the default');
      const first = await engine.plan(wf.id, { mode: 'all' });
      assert.ok(Math.abs(first.nodes.typed.estimate.usd - 0.04) < 1e-9, 'from its own field');
      assert.equal(first.nodes.wired.estimate, null, 'the input is connected: unknown');
      assert.equal(first.nodes.free.paid, false);
      assert.equal(first.nodes.free.estimate, null);
      assert.deepEqual(first.totals, { paidNodes: 2, usd: 0.04, credits: 0, unknownNodes: 1 });
      const seen = Object.fromEntries(env.state.estimateContexts.map((entry) => [entry.nodeId, entry.connected]));
      assert.deepEqual(seen, { typed: [], wired: ['in'] }, 'the estimate is told which inputs are connected and which node it is');
      // ... and what the node receives now: its own field, but nothing from a node before it that has yet to run
      const received = Object.fromEntries(env.state.estimateContexts.map((entry) => [entry.nodeId, entry.inputs]));
      assert.deepEqual(received, { typed: { in: 'abcd' }, wired: {} }, 'inputs: known values only, never an earlier result of a stale node');
      env.state.estimateContexts = [];
      // after a real run the plan still does not guess from the last result
      const record = await run(engine, wf.id, { mode: 'node', nodeIds: ['typed', 'wired'] });
      assert.ok(Math.abs(record.cost.usd - 1) < 1e-9);
      const again = await engine.plan(wf.id, { mode: 'node', nodeIds: ['typed', 'wired'], force: true });
      assert.equal(again.nodes.wired.estimate, null, 'no earlier cost is used: the length stays unknown');
      assert.deepEqual(env.state.estimateContexts.filter((entry) => entry.nodeId === 'wired').pop().inputs, { in: 'hello' }, 'with the node before up to date its value reaches the estimate');
      assert.ok(Math.abs(again.nodes.typed.estimate.usd - 0.04) < 1e-9);
      assert.equal(again.totals.unknownNodes, 1);

      // a failing node with a stable code hands its values to the interface: flat, numbers and strings, cut to a size
      const events = [];
      bus.subscribe(wf.id, (event) => events.push(event));
      const failed = await run(engine, wf.id, { mode: 'node', nodeIds: ['bad'] });
      const stored = await wfStore.readRun(wf.id, failed.id);
      const status = events.find((event) => event.type === 'node_status' && event.nodeId === 'bad' && event.status === 'error');
      assert.equal(status.code, 'T_CODED_FAILURE');
      assert.equal(status.data.line, 3);
      assert.equal(status.data.flag, true);
      assert.equal(status.data.suggestion.length, 8000);
      assert.equal('nested' in status.data, false);
      assert.deepEqual(stored.nodes.bad.data, status.data, 'the run record keeps them');
      assert.equal(stored.nodes.bad.code, 'T_CODED_FAILURE');
    }

    /* ----- waitForSessionJob and the job context ----- */
    {
      const session = await store.createSession({ kind: 'workflow', title: 'Workflow: jobs test' });
      try {
        const push = (job) => store.mutateSession(session.id, (s) => s.jobs.push(job));
        const setStatus = (jobId, patch) =>
          store.mutateSession(session.id, (s) => Object.assign(s.jobs.find((j) => j.jobId === jobId), patch));

        await push({ jobId: 'j1', assetId: 'vid-001', status: 'pending' });
        const waiting = jobs.waitForSessionJob(session.id, 'j1', { intervalMs: 10, timeoutMs: 2000 });
        await sleep(40);
        await setStatus('j1', { status: 'completed' });
        assert.deepEqual(await waiting, ['vid-001']);

        await push({ jobId: 'j2', assetId: 'img-001', status: 'running' });
        const multi = jobs.waitForSessionJob(session.id, 'j2', { intervalMs: 10, timeoutMs: 2000 });
        await setStatus('j2', { status: 'completed', resultAssetIds: ['img-001', 'img-002'] });
        assert.deepEqual(await multi, ['img-001', 'img-002']);

        await push({ jobId: 'j3', assetId: 'vid-002', status: 'running' });
        const failing = jobs.waitForSessionJob(session.id, 'j3', { intervalMs: 10, timeoutMs: 2000 });
        // the handler first: under load the poll can see the new status before setStatus returns, and a rejection nobody waits for ends the process
        const rejected = assert.rejects(failing, /provider said no/);
        await setStatus('j3', { status: 'failed', error: 'provider said no' });
        await rejected;

        await push({ jobId: 'j4', assetId: 'vid-003', status: 'running' });
        const controller = new AbortController();
        const aborted = jobs.waitForSessionJob(session.id, 'j4', { intervalMs: 10, timeoutMs: 2000, signal: controller.signal });
        setTimeout(() => controller.abort(), 30);
        await assert.rejects(aborted, { name: 'AbortError' });
        await assert.rejects(jobs.waitForSessionJob(session.id, 'j4', { intervalMs: 10, timeoutMs: 60 }), /Timed out/);
        await assert.rejects(jobs.waitForSessionJob(session.id, 'nope', { intervalMs: 5, timeoutMs: 1000 }), /not found/);

        // Higgsfield can reuse a job id: with assetId the waiter follows its own job, not the first match
        await push({ jobId: 'dup', assetId: 'img-010', status: 'completed' });
        await push({ jobId: 'dup', assetId: 'img-011', status: 'running' });
        const own = jobs.waitForSessionJob(session.id, 'dup', { assetId: 'img-011', intervalMs: 10, timeoutMs: 2000 });
        await sleep(40);
        await store.mutateSession(session.id, (s) => Object.assign(s.jobs.find((j) => j.assetId === 'img-011'), { status: 'completed' }));
        assert.deepEqual(await own, ['img-011']);
        assert.deepEqual(await jobs.waitForSessionJob(session.id, 'dup', { intervalMs: 5, timeoutMs: 500 }), ['img-010']);
      } finally {
        await store.deleteSession(session.id);
      }

      // node integration: the pool slot is handed back while waiting for the job
      resetState();
      const wf = await makeWorkflow(
        [node('j', 't.job', {}, 0, 0), node('s', 't.src', { text: 'quick' }, 0, 100)],
        []
      );
      const engine = makeEngine({ parallel: 1 });
      const events = [];
      bus.subscribe(wf.id, (event) => events.push(event));
      const runId = await engine.start(wf.id, { mode: 'all' });
      while (!env.state.jobSubmitted) await sleep(5);
      await sleep(80);
      // the other node ran to completion although parallel = 1 and the job is still open
      assert.ok(env.state.finishOrder.includes('s'), 'slot must be released while waiting for a job');
      assert.ok(events.some((event) => event.type === 'node_status' && event.nodeId === 'j' && event.status === 'waiting_job'));
      await store.mutateSession(wf.sessionId, (s) => {
        const job = s.jobs.find((entry) => entry.jobId === env.state.jobSubmitted);
        job.status = 'completed';
        job.resultAssetIds = ['vid-001', 'vid-002'];
      });
      const record = await engine.whenFinished(wf.id, runId);
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal((await selectedValue(wf.id, 'j', 'out')).value, 'done:vid-001,vid-002');
    }

    /* ----- integration with the real basic nodes ----- */
    {
      const wf = await makeWorkflow(
        [
          node('n', 'input.number', { value: 7 }, 0, 0),
          node('lst', 'input.text_list', { text: 'alpha\nbeta\ngamma' }, 0, 100),
          node('tpl', 'text.template', { template: '{{a}}:{{b}} {{zzz}}' }, 200, 50),
          node('join', 'text.join', { separator: ' + ' }, 400, 50),
          node('pick', 'util.pick', { index: -1 }, 400, 200),
          node('out', 'output.result', { label: 'Result' }, 600, 50)
        ],
        edges('n.value>tpl.a', 'lst.items>tpl.b', 'tpl.text>join.items', 'lst.items>pick.items', 'join.text>out.inputs', 'pick.item>out.inputs')
      );
      const engine = makeEngine();
      const record = await run(engine, wf.id, { mode: 'all' });
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      const tpl = await selectedValue(wf.id, 'tpl', 'text');
      assert.deepEqual(tpl.items.map((item) => item.value), ['7:alpha {{zzz}}', '7:beta {{zzz}}', '7:gamma {{zzz}}']);
      assert.equal((await selectedValue(wf.id, 'join', 'text')).value, '7:alpha {{zzz}} + 7:beta {{zzz}} + 7:gamma {{zzz}}');
      assert.equal((await selectedValue(wf.id, 'pick', 'item')).value, 'gamma');
      const out = await selectedValue(wf.id, 'out', 'result');
      assert.equal(out.items.length, 2);
      assert.equal(out.items[1].value, 'gamma');

      // label is a UI-only param: changing it keeps the cache
      const current = await wfStore.readWorkflow(wf.id);
      const nodes = current.graph.nodes.map((item) => (item.id === 'out' ? { ...item, params: { label: 'Other' } } : item));
      await wfStore.saveGraph(wf.id, { baseRev: current.rev, graph: { ...current.graph, nodes } });
      const again = await run(engine, wf.id, { mode: 'all' });
      assert.equal(again.nodes.out.status, 'cached');
    }

    /* ----- F2: a failing item of an implicit map keeps the paid items and only they are skipped on retry ----- */
    {
      resetState();
      const wf = await makeWorkflow(
        [node('lst', 't.list', { n: 4 }, 0, 0), node('fl', 't.itemflaky', {}, 200, 0), node('after', 't.upper', {}, 400, 0)],
        edges('lst.items>fl.in', 'fl.out>after.in'),
        'Partial map'
      );
      const engine = makeEngine();
      env.state.failItem = 'item2';
      const first = await run(engine, wf.id, { mode: 'all' });
      assert.equal(first.status, 'failed');
      assert.equal(first.nodes.fl.status, 'error');
      assert.equal(first.nodes.after.status, 'skipped', 'downstream never runs on incomplete data');
      assert.equal(env.calls.length, 4, 'all four items were submitted');
      assert.ok(Math.abs(first.cost.usd - 1.5) < 1e-9, `three paid items are booked, got ${first.cost.usd}`);
      const stored = await results(wf.id, 'fl');
      assert.equal((stored.history || []).length, 0, 'a partial map creates no history entry');
      assert.deepEqual(Object.keys(stored.partial.items).sort(), ['0', '2', '3']);
      assert.equal(stored.partial.errors[0].index, 1);
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.fl.executions, 1, 'the plan only counts the missing item');
      assert.equal(plan.nodes.fl.reusedItems, 3);

      // retry: only item2 runs again, the finished items are reused
      env.state.failItem = null;
      env.calls.length = 0;
      const second = await run(engine, wf.id, { mode: 'all' });
      assert.equal(second.status, 'completed', JSON.stringify(second.nodes));
      assert.deepEqual(env.calls.map((call) => call.item), ['item2'], 'only the failed item is paid again');
      assert.ok(Math.abs(second.cost.usd - 0.5) < 1e-9, `only the new item is booked, got ${second.cost.usd}`);
      const merged = (await selectedValue(wf.id, 'fl', 'out')).items.map((item) => item.value);
      assert.deepEqual(merged, ['item1!', 'item2!', 'item3!', 'item4!']);
      assert.equal((await results(wf.id, 'fl')).partial, undefined, 'the partial results are removed after success');

      // cancelling keeps what is finished as well
      env.state.failItem = null;
      await wfStore.saveGraph(wf.id, { baseRev: (await wfStore.readWorkflow(wf.id)).rev, graph: { ...(await wfStore.readWorkflow(wf.id)).graph, nodes: (await wfStore.readWorkflow(wf.id)).graph.nodes.map((item) => (item.id === 'lst' ? { ...item, params: { n: 3 } } : item)) } });
      env.state.failItem = 'item3';
      env.calls.length = 0;
      const third = await run(engine, wf.id, { mode: 'all' });
      assert.equal(third.nodes.fl.status, 'error');
      assert.ok((await results(wf.id, 'fl')).partial, 'a new failure stores the finished items again');
      env.state.failItem = null;
    }

    /* ----- order of the connections of a multi-input: the engine follows graph.edges, the cache key follows the order ----- */
    {
      const graphLib = require('../public/nodes/graph');
      const reg = graphLib.indexRegistry(JSON.parse(JSON.stringify(env.registry.publicRegistry())));
      const wf = await makeWorkflow(
        [
          node('a', 'input.text', { text: 'alpha' }, 0, 0),
          node('b', 'input.text', { text: 'beta' }, 0, 100),
          node('c', 'input.text', { text: 'gamma' }, 0, 200),
          node('j', 'text.join', { separator: '+' }, 300, 100),
          node('u', 't.upper', {}, 300, 300)
        ],
        // the edge into u sits between the edges of the multi-input
        edges('a.text>j.items', 'b.text>u.in', 'b.text>j.items', 'c.text>j.items'),
        'Input order'
      );
      const engine = makeEngine();
      const first = await run(engine, wf.id, { mode: 'all' });
      assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
      assert.equal((await selectedValue(wf.id, 'j', 'text')).value, 'alpha+beta+gamma');
      assert.ok(Object.values((await engine.plan(wf.id, { mode: 'all' })).nodes).every((entry) => entry.status === 'cached'));

      // gamma to the front: only the edges of the input change places, the rest stays where it was
      const save = async (graph) => {
        const current = await wfStore.readWorkflow(wf.id);
        await wfStore.saveGraph(wf.id, { baseRev: current.rev, graph: { ...current.graph, edges: graph.edges } });
      };
      const stored = (await wfStore.readWorkflow(wf.id)).graph;
      const moved = graphLib.moveInputEdge(reg, stored, 'j', 'items', 'e4', 'first');
      assert.equal(moved.changed, true);
      assert.deepEqual(moved.graph.edges.map((edge) => edge.id), ['e4', 'e2', 'e1', 'e3'], 'the edge into u keeps its slot');
      await save(moved.graph);
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.j.status, 'stale', 'the new order makes the node stale: its cache key contains the order');
      for (const id of ['a', 'b', 'c', 'u']) assert.equal(plan.nodes[id].status, 'cached', id);
      const second = await run(engine, wf.id, { mode: 'all' });
      assert.equal(second.nodes.j.status, 'done', 'not served from the cache of the old order');
      assert.equal((await selectedValue(wf.id, 'j', 'text')).value, 'gamma+alpha+beta');

      // and back: the first result is found again by its key
      const back = graphLib.setInputOrder(reg, (await wfStore.readWorkflow(wf.id)).graph, 'j', 'items', ['e1', 'e3', 'e4']);
      await save(back.graph);
      assert.equal((await engine.plan(wf.id, { mode: 'all' })).nodes.j.status, 'cached');
    }

  } finally {
    for (const id of created) {
      await wfStore.deleteWorkflow(id).catch(() => {});
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-engine.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
