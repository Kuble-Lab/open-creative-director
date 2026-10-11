'use strict';

const assert = require('node:assert/strict');
const { createEngine } = require('../lib/nodes/engine');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { textValue, listValue } = require('../lib/nodes/types');
const sessionStore = require('../lib/store');
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture({ count = 2, price = 1, execute, hooks = {} } = {}) {
  const registry = createRegistry();
  const calls = [];
  registry.register({ ...hooks, type: 'test.paid', category: 'text', paid: true,
    inputs: [{ id: 'input', type: 'text', optional: true }],
    params: [{ id: 'text', kind: 'text', default: 'hello' }], outputs: [{ id: 'text', type: 'text' }],
    cost: { unit: 'usd', history: false, estimate: () => price },
    execute: async (ctx, inputs, params) => {
      calls.push(ctx.nodeId);
      if (execute) return execute(ctx, inputs, params);
      return { variants: [{ text: textValue(params.text) }], cost: { usd: 1 } };
    }
  });
  const workflow = { id: 'w', rev: 1, sessionId: 's', graph: { nodes: Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'test.paid', params: {} })), edges: [] } };
  const results = { nodes: {} };
  let record;
  const store = {
    getWorkflow: async () => ({ workflow: clone(workflow), results: clone(results) }),
    readResults: async () => clone(results),
    readWorkflow: async () => clone(workflow), newRunId: () => 'r',
    // the route checks the review revision of the results first (variant approvals); here it only starts
    startReviewedRun: async (_id, _revision, start) => start(),
    writeRun: async (_, run) => { record = clone(run); }, readRun: async () => clone(record), pruneRuns: async () => {},
    appendHistory: async (_, id, entry) => {
      entry = { ...entry, id: id + '-result' };
      results.nodes[id] = { history: [entry], selected: { entry: entry.id, variant: 0 } };
      return { entry, node: results.nodes[id] };
    }
  };
  const events = createEventBus();
  const engine = createEngine({ registry, store, events, limits: { parallel: 3 } });
  return { engine, workflow, store, results, calls, events, registry };
}
function nextApproval(f) {
  return new Promise((resolve) => {
    const off = f.events.subscribe('w', (event) => { if (event.type === 'run_approval' && event.approval) { off(); resolve(event.approval); } });
  });
}

async function main() {
  const watchdog = setTimeout(() => { throw new Error('Budget test stalled'); }, 5000);
  try {
    const f = fixture();
    const paused = nextApproval(f);
    await f.engine.start('w', { maxUsd: 1 });
    const approval = await paused;
    assert.equal(approval.requiredUsd, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 1, 'parallel executions cannot reserve the same dollar');
    let record = await f.engine.accountingFor('w', await f.store.readRun());
    assert.equal(record.status, 'awaiting_approval');
    assert.equal(record.maxUsd, 1);
    await assert.rejects(f.engine.resume('w', 'r', { maxUsd: -1 }), { code: 'INVALID_REQUEST' });
    await f.engine.resume('w', 'r', { maxUsd: 2 });
    record = await f.engine.whenFinished('w', 'r');
    assert.equal(record.status, 'completed');
    assert.equal(f.calls.length, 2);
    assert.equal(record.cost.usd, 2);
    assert.equal(record.accounting.bookedUsd, 2);
    assert.equal(record.accounting.reservedUsd, 0);
    assert.equal(record.accounting.financiallyComplete, true);
    const cached = await f.engine.plan('w');
    assert.equal(cached.nodes.n0.changeReason, 'cached');
    assert.equal(cached.totals.usd, 0);
    f.workflow.graph.nodes[0].params.text = 'changed';
    const changed = await f.engine.plan('w');
    assert.equal(changed.nodes.n0.changeReason, 'parameters');
    assert.deepEqual(changed.nodes.n0.changedParams, ['text']);
    assert.equal((await f.engine.plan('w', { force: true })).nodes.n1.changeReason, 'forced');

    const unknown = fixture({ count: 1, price: null });
    const waiting = nextApproval(unknown);
    await unknown.engine.start('w', { maxUsd: 4 });
    assert.equal((await waiting).requiredUsd, null);
    assert.equal(unknown.calls.length, 0);
    await unknown.engine.resume('w', 'r', { maxUsd: 4, requireKnownPrices: false });
    assert.equal((await unknown.engine.whenFinished('w', 'r')).status, 'completed');

    const cancelled = fixture({ count: 1 });
    const waitCancel = nextApproval(cancelled);
    await cancelled.engine.start('w', { maxUsd: 0 });
    await waitCancel;
    cancelled.engine.cancel('w', 'r');
    assert.equal((await cancelled.engine.whenFinished('w', 'r')).status, 'cancelled');
    assert.equal(cancelled.calls.length, 0);

    const legacy = fixture({ price: null });
    await legacy.engine.start('w');
    assert.equal((await legacy.engine.whenFinished('w', 'r')).status, 'completed');
    assert.equal(legacy.calls.length, 2);
    for (const maxUsd of [-1, NaN, Infinity, '2', null]) await assert.rejects(fixture().engine.start('w', { maxUsd }), { code: 'INVALID_REQUEST' });

    const mapped = fixture({ count: 1 });
    mapped.registry.register({ type: 'test.list', category: 'input', outputs: [{ id: 'items', type: 'text[]' }],
      execute: async () => ({ variants: [{ items: listValue('text', [textValue('a'), textValue('b'), textValue('c')]) }] }) });
    const mappedDef = mapped.registry.get('test.paid');
    mappedDef.inputs[0].optional = false;
    mapped.workflow.graph.nodes.unshift({ id: 'source', type: 'test.list', params: {} });
    mapped.workflow.graph.edges.push({ id: 'edge', from: { node: 'source', port: 'items' }, to: { node: 'n0', port: 'input' } });
    assert.equal((await mapped.engine.plan('w')).nodes.n0.changeReason, 'upstream');
    const mapWaiting = nextApproval(mapped);
    await mapped.engine.start('w', { maxUsd: 2 });
    await mapWaiting;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mapped.calls.length, 2, 'each mapped item reserves separately');
    await mapped.engine.resume('w', 'r', { maxUsd: 3 });
    assert.equal((await mapped.engine.whenFinished('w', 'r')).cost.usd, 3);
    assert.equal(mapped.calls.length, 3);

    const repriced = fixture({ count: 1, price: 0.5 });
    repriced.registry.get('test.paid').cost.estimate = () => 2;
    const priceWaiting = nextApproval(repriced);
    await repriced.engine.start('w', { maxUsd: 1 });
    assert.equal((await priceWaiting).requiredUsd, 2);
    assert.equal(repriced.calls.length, 0);
    repriced.engine.cancel('w', 'r');
    await repriced.engine.whenFinished('w', 'r');

    const unresolved = fixture({ execute: async () => ({ variants: [{ text: textValue('done') }] }) });
    unresolved.workflow.graph.edges.push({ id: 'sequence', from: { node: 'n0', port: 'text' }, to: { node: 'n1', port: 'input' } });
    const unresolvedWaiting = nextApproval(unresolved);
    await unresolved.engine.start('w', { maxUsd: 1 });
    assert.equal((await unresolvedWaiting).requiredUsd, 2);
    assert.deepEqual(unresolved.calls, ['n0'], 'unknown final cost cannot release the first step reservation');
    assert.equal((await unresolved.engine.accountingFor('w', await unresolved.store.readRun())).accounting.reservedUsd, 1);
    unresolved.engine.cancel('w', 'r');
    await unresolved.engine.whenFinished('w', 'r');

    for (const price of [1, null]) {
      const hooks = {
        cacheStamp: (params) => ({ text: params.text }),
        cacheStampOutputs: (stamp, { nodeResults }) => nodeResults?.history.length
          ? { free: true, outputs: { text: nodeResults.history[0].variants[0].text } } : null
      };
      const reuse = fixture({ count: 1, price, hooks, execute: async (ctx, inputs, params) => {
        const predicted = await hooks.cacheStampOutputs(await hooks.cacheStamp(params), { nodeResults: reuse.results.nodes.n0 });
        if (!predicted) return { variants: [{ text: textValue('original') }], cost: { usd: 1 } };
        assert.equal(predicted.outputs.text.value, 'original', 'the execution reuses an existing result');
        return { variants: [predicted.outputs], cost: { usd: 0 } };
      } });
      await reuse.engine.start('w');
      await reuse.engine.whenFinished('w', 'r');
      reuse.workflow.graph.nodes[0].params.text = 'changed selection';
      assert.equal((await reuse.engine.plan('w')).totals.usd, 0);
      await reuse.engine.start('w', { maxUsd: 0 });
      assert.equal((await reuse.engine.whenFinished('w', 'r')).status, 'completed');
    }

    for (const usd of [undefined, 0.4]) {
      const failed = fixture({ count: 1, execute: async () => { const error = new Error('before submit'); error.usd = usd; throw error; } });
      await failed.engine.start('w', { maxUsd: 1 });
      const result = await failed.engine.whenFinished('w', 'r');
      assert.equal(result.accounting.financiallyComplete, true);
      assert.equal(result.accounting.openJobs, 0);
      assert.equal(result.accounting.reservedUsd, 0);
      assert.equal(result.accounting.bookedUsd, usd || 0);
      assert.equal(result.accounting.unknownCost, false);
    }
    const unpriced = fixture({ count: 1, execute: async () => ({ variants: [{ text: textValue('unpriced') }] }) });
    await unpriced.engine.start('w');
    const unpricedDone = await unpriced.engine.whenFinished('w', 'r');
    assert.equal(unpricedDone.accounting.financiallyComplete, true);
    assert.equal(unpricedDone.accounting.unknownCost, true);
    assert.equal(unpricedDone.accounting.unresolvedUsd, false);
    assert.equal(unpricedDone.accounting.reservedUsd, 0);

    const credits = fixture({ count: 1, price: 2, execute: async () => ({ variants: [{ text: textValue('credit result') }], cost: { credits: 2 } }) });
    credits.registry.get('test.paid').cost.unit = 'credits';
    await credits.engine.start('w', { maxUsd: 0 });
    assert.equal((await credits.engine.whenFinished('w', 'r')).accounting.financiallyComplete, true, 'credit billing is separate from USD');

    const serviceFixture = fixture({ count: 1 });
    const { createRunService } = require('../lib/nodes/run-service');
    const service = createRunService({ engine: serviceFixture.engine, store: serviceFixture.store,
      registry: serviceFixture.registry, sessions: { isValidId: () => true } });
    const started = await service.start({ active: false }, 'w', { maxUsd: 1 });
    const serviced = await serviceFixture.engine.whenFinished('w', started.runId);
    assert.equal(serviced.maxUsd, 1, 'service approval reaches the engine');
    assert.equal(serviced.requireKnownPrices, true);
    assert.equal((await service.status({ active: false }, 'r', { workflowId: 'w' })).accounting.financiallyComplete, true);

    const { registerNodeRoutes } = require('../lib/nodes/routes');
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, fn) => handlers.set(method + ' ' + path, fn)]));
    const routeFixture = fixture({ count: 1 });
    registerNodeRoutes(app, { engine: routeFixture.engine, store: routeFixture.store, registry: routeFixture.registry, sessions: { isValidId: () => true } });
    async function route(method, suffix, body = {}) {
      let payload;
      let code = 200;
      const res = { status(value) { code = value; return this; }, json(value) { payload = value; return this; } };
      await handlers.get(method + ' /api/workflows/:id/runs' + suffix)({ params: { id: 'w', runId: 'r' }, body }, res);
      return { code, payload };
    }
    const routeWaiting = nextApproval(routeFixture);
    assert.equal((await route('post', '', { maxUsd: 0 })).code, 202);
    await routeWaiting;
    assert.equal((await route('get', '/:runId')).payload.status, 'awaiting_approval');
    assert.equal((await route('post', '/:runId/resume', { maxUsd: 1 })).payload.ok, true);
    await routeFixture.engine.whenFinished('w', 'r');
    assert.equal((await route('get', '/:runId')).payload.accounting.financiallyComplete, true);

    const cancelWaiting = nextApproval(routeFixture);
    await route('post', '', { maxUsd: 0, force: true });
    await cancelWaiting;
    const cancelService = createRunService({ engine: routeFixture.engine, store: routeFixture.store, registry: routeFixture.registry, sessions: { isValidId: () => true } });
    assert.equal((await cancelService.cancel({ active: false }, 'r', { workflowId: 'w' })).cancelled, true);
    await routeFixture.engine.whenFinished('w', 'r');

    const originalRead = sessionStore.readSession;
    let job = { jobId: 'j', assetId: 'a', status: 'running' };
    sessionStore.readSession = async () => ({ jobs: [job] });
    try {
      let sessionReads = 0;
      sessionStore.readSession = async () => { sessionReads++; return { jobs: [job] }; };
      const unrestricted = fixture({ execute: async (ctx) => {
        assert.equal(sessionReads, 0, 'unrestricted reservations do not read provider sessions');
        ctx.watchJob({ jobId: 'j', assetId: 'a' });
        return { variants: [{ text: textValue('done') }] };
      } });
      unrestricted.workflow.graph.edges.push({ id: 'sequence', from: { node: 'n0', port: 'text' }, to: { node: 'n1', port: 'input' } });
      let reservationEvents = 0;
      unrestricted.events.subscribe('w', (event) => { if (event.type === 'run_accounting') reservationEvents++; });
      await unrestricted.engine.start('w');
      await unrestricted.engine.whenFinished('w', 'r');
      assert.ok(sessionReads > 0, 'provider accounting is reconciled at completion');
      assert.equal(reservationEvents, 2, 'unrestricted runs publish completion accounting, without additional reservation writes');
      const late = fixture({ execute: async (ctx) => {
        if (ctx.nodeId === 'n0') {
          ctx.watchJob({ jobId: 'j', assetId: 'a' });
          return { variants: [{ text: textValue('first') }] };
        }
        return { variants: [{ text: textValue('second') }], cost: { usd: 1 } };
      } });
      late.workflow.graph.edges.push({ id: 'sequence', from: { node: 'n0', port: 'text' }, to: { node: 'n1', port: 'input' } });
      const lateWaiting = nextApproval(late);
      await late.engine.start('w', { maxUsd: 1 });
      await lateWaiting;
      job = { ...job, status: 'completed', cost: 1.5, accountingStatus: 'booked' };
      const reconciled = await late.engine.accountingFor('w', await late.store.readRun());
      assert.equal(reconciled.accounting.bookedUsd, 1.5);
      assert.equal(reconciled.accounting.reservedUsd, 0);
      const stillWaiting = nextApproval(late);
      await late.engine.resume('w', 'r', { maxUsd: 2 });
      assert.equal((await stillWaiting).requiredUsd, 2.5, 'late bookings update the execution budget too');
      assert.deepEqual(late.calls, ['n0']);
      await late.engine.resume('w', 'r', { maxUsd: 2.5 });
      const lateDone = await late.engine.whenFinished('w', 'r');
      assert.equal(lateDone.accounting.bookedUsd, 2.5);
      assert.equal((await late.engine.accountingFor('w', lateDone)).accounting.bookedUsd, 2.5, 'late booking is counted once');
      job = { jobId: 'j', assetId: 'a', status: 'running' };
      const open = fixture({ count: 1, execute: async (ctx) => { ctx.watchJob({ jobId: 'j', assetId: 'a' }); throw new Error('cancelled after submit'); } });
      await open.engine.start('w', { maxUsd: 1 });
      const stopped = await open.engine.whenFinished('w', 'r');
      let result = await open.engine.accountingFor('w', stopped);
      assert.equal(result.accounting.openJobs, 1);
      assert.equal(result.accounting.reservedUsd, 1);
      assert.equal(result.accounting.financiallyComplete, false);
      job = { ...job, status: 'completed', cost: 0.8, accountingStatus: 'pending' };
      result = await open.engine.accountingFor('w', stopped);
      assert.equal(result.accounting.openJobs, 1, 'terminal provider status is not financial completion');
      job.accountingStatus = 'booked';
      result = await open.engine.accountingFor('w', stopped);
      assert.equal(result.accounting.bookedUsd, 0.8);
      assert.equal(result.accounting.reservedUsd, 0);
      assert.equal(result.accounting.financiallyComplete, true);
      assert.equal((await open.engine.accountingFor('w', stopped)).accounting.bookedUsd, 0.8, 'readback does not double book');
      const success = fixture({ count: 1, execute: async (ctx) => { ctx.watchJob({ jobId: 'j', assetId: 'a' }); return { variants: [{ text: textValue('done') }], cost: { usd: 0.8 } }; } });
      job.accountingStatus = 'pending';
      await success.engine.start('w', { maxUsd: 1 });
      const finished = await success.engine.whenFinished('w', 'r');
      result = await success.engine.accountingFor('w', finished);
      assert.equal(result.accounting.bookedUsd, 0);
      assert.equal(result.accounting.reservedUsd, 0.8);
      assert.equal(result.accounting.financiallyComplete, false);
      job.accountingStatus = 'booked';
      result = await success.engine.accountingFor('w', finished);
      assert.equal(result.accounting.bookedUsd, 0.8);
      assert.equal(result.accounting.reservedUsd, 0);
      assert.equal(result.accounting.financiallyComplete, true);

    } finally { sessionStore.readSession = originalRead; }
  } finally { clearTimeout(watchdog); }
  console.log('test-nodes-run-budget.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
