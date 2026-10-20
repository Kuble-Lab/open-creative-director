'use strict';

// No sockets, provider calls or real app data: routes and providers run against a private app copy.
const assert = require('node:assert/strict');
const { createIsolatedApp } = require('./support/isolated-app');
const P = 'participant@example.test';
const G = 'guest@example.test';
const I = 'internal@staff.test';
const A = 'admin@staff.test';

async function main() {
  const iso = await createIsolatedApp({ loadServer: false, env: {
    AUTH_WHOAMI_URL: 'https://identity.invalid', INTERNAL_EMAIL_DOMAINS: 'staff.test', ADMIN_EMAILS: A
  } });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network forbidden'); };
  try {
    const access = iso.load('lib/access');
    const settings = iso.load('lib/settings');
    const teams = iso.load('lib/teams');
    const store = iso.load('lib/store');
    const budget = iso.load('lib/budget');
    const costs = iso.load('lib/costs');
    const hf = iso.load('lib/higgsfield');
    const tools = iso.load('lib/tools');
    const catalog = iso.load('lib/nodes/higgsfield-catalog');
    const registryLib = iso.load('lib/nodes/registry');
    const assistant = iso.load('lib/nodes/assistant');
    const templates = iso.load('lib/nodes/templates');
    const poller = iso.load('lib/poller');
    const billing = iso.load('lib/higgsfield-billing');
    const { textValue } = iso.load('lib/nodes/types');
    store.ensureDirs();
    const team = teams.createTeam({ name: 'Participants', budgetUsd: 10 });
    teams.addMembers(team.id, [P]);
    const viewer = (user) => access.viewerOf({ kubleUser: user });
    let connected = true;
    hf.status = () => ({ connected });
    const model = { id: 'test_image', name: 'Test image', credits_per_unit: 7, credit_unit: 'per_image', medias: [] };
    catalog.getModel = async (id) => id === model.id ? model : null;
    let calls = 0;
    let fail = false;
    let startedReserved;
    hf.mcpCall = async (name) => {
      if (name === 'models_explore') return JSON.stringify(model);
      assert.equal(name, 'generate_image_batch');
      calls += 1;
      startedReserved = (await budget.status(viewer(P))).reservedUsd;
      if (fail) throw new Error('Injected submit failure');
      return `Job ${String(calls).padStart(8, '0')}-1234-4234-8234-123456789abc`;
    };
    hf.downloadResult = async (url) => ({ buffer: Buffer.from('mock image'), contentType: 'image/png', url });

    const registry = registryLib.createRegistry();
    let executed = 0;
    registry.register({ type: 'test.higgsfield', category: 'higgsfield', paid: true,
      cost: { unit: 'credits', estimate: () => ({ credits: 7 }) },
      outputs: [{ id: 'text', type: 'text' }], execute: async () => {
        executed += 1;
        return { variants: [{ text: textValue('done') }], cost: { credits: 7 } };
      }
    });
    const workflows = iso.load('lib/nodes/workflows-store').createWorkflowsStore({ registry });
    const engine = iso.load('lib/nodes/engine').createEngine({ registry, store: workflows });
    const { workflow } = await workflows.createWorkflow({ name: 'Credit workflow', owner: P, graph: {
      nodes: [{ id: 'hf', type: 'test.higgsfield', params: {}, x: 0, y: 0 }], edges: []
    } });
    // Capture the actual route handlers without binding a port.
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
    iso.load('lib/nodes/routes').registerNodeRoutes(app, { engine, store: workflows, registry: registryLib.registry, higgsfieldCatalog: catalog });
    async function route(path, user, params = {}) {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, set() { return this; } };
      await handlers.get(`get ${path}`)({ kubleUser: user, params, query: {} }, res);
      return res;
    }
    function visible(user) {
      return tools.toolDefinitions(viewer(user)).some((tool) => tool.function.name === 'higgsfield_generate_image');
    }
    function assistantVisible(user) {
      return assistant.visibleDescriptors(registry, !access.higgsfieldAllowed(viewer(user))).descriptors.some((def) => def.type === 'test.higgsfield');
    }
    async function assertSurfaces(user, allowed) {
      assert.equal(visible(user), allowed);
      assert.equal(assistantVisible(user), allowed);
      const listed = await route('/api/nodes/registry', user);
      const node = listed.body.nodeTypes.find((def) => def.type === 'image.higgsfield');
      assert.equal(node.restricted === true, !allowed);
      const template = await route('/api/workflow-templates/:id', user, { id: 'dub-clip' });
      assert.equal(template.statusCode, allowed ? 200 : 403);
      const list = await route('/api/workflow-templates', user);
      assert.equal(list.body.templates.some((entry) => entry.id === 'dub-clip'), allowed);
      const options = await route('/api/nodes/higgsfield-models/:modelId', user, { modelId: model.id });
      assert.equal(options.statusCode, allowed ? 200 : 403);
    }
    // Exercise the settings route itself without a listening socket or authentication service.
    const server = iso.load('server.js');
    async function preference(user, value) {
      const layer = server.app._router.stack.find((entry) => entry.route?.path === '/api/settings/preferences' && entry.route.methods.put);
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await layer.route.stack[0].handle({ kubleUser: user, body: { name: 'higgsfieldUsdPerCredit', value } }, res);
      return res;
    }
    assert.equal((await preference(P, 0.2)).statusCode, 403);
    assert.equal((await preference(A, 0)).statusCode, 400);
    assert.equal((await preference(A, '0.2')).statusCode, 400);
    assert.equal((await preference(A, null)).statusCode, 200);
    assert.equal(settings.getPreference('higgsfieldUsdPerCredit'), null);
    await assertSurfaces(P, false);
    await assertSurfaces(I, true);
    await assertSurfaces(A, true);
    assert.equal((await engine.plan(workflow.id, { user: P })).blocked.length, 1);
    await assert.rejects(engine.start(workflow.id, { user: P }), { code: 'FORBIDDEN_FOR_ROLE' });
    assert.equal(executed, 0);
    for (const value of [0, -1, NaN, Infinity, '0.2', false, undefined]) assert.throws(() => settings.setPreference('higgsfieldUsdPerCredit', value));
    assert.equal((await preference(A, 0.2)).body.preferences.higgsfieldUsdPerCredit, 0.2);
    settings.loadSettings();
    assert.equal(settings.getPreference('higgsfieldUsdPerCredit'), 0.2, 'rate survives reload');
    await assertSurfaces(P, true);
    await assertSurfaces(G, false);
    await assertSurfaces(I, true);
    await assertSurfaces(A, true);
    connected = false;
    await assertSurfaces(P, false);
    assert.equal(access.higgsfieldAllowed(viewer(I)), true, 'internal access is unchanged while disconnected');
    connected = true;
    const plan = await engine.plan(workflow.id, { user: P });
    assert.deepEqual(plan.blocked, []);
    assert.ok(Math.abs(plan.totals.usd - 1.4) < 1e-6);
    assert.equal(plan.totals.credits, 7);
    const runId = await engine.start(workflow.id, { user: P });
    assert.equal((await engine.whenFinished(workflow.id, runId)).status, 'completed');
    assert.equal(executed, 1);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    assert.equal((await engine.plan(workflow.id, { user: I, force: true })).totals.usd, 0);

    const session = await store.createSession({ owner: P });
    const ctx = (user = P, extra = {}) => ({ sessionId: session.id, user, config: {}, emit() {}, ...extra });
    const args = { model: model.id, prompt: 'Test' };
    const outcome = await tools.executeTool(ctx(), 'higgsfield_generate_image', args);
    assert.equal(startedReserved, 1.4, 'reserve credits times rate before provider start');
    assert.equal(outcome.job.higgsfieldUsdPerCredit, 0.2);
    assert.equal(outcome.job.estimateCredits, 7);
    settings.setPreference('higgsfieldUsdPerCredit', 0.5);
    await poller.handleHiggsfieldCompleted(session.id, outcome.job, { urls: ['https://result.invalid/image.png'], credits: 8 });
    const booked = (await costs.readCosts()).filter((entry) => entry.type === 'higgsfield' && entry.cost > 0);
    assert.equal(booked.length, 1);
    assert.equal(booked[0].credits, 8);
    assert.equal(booked[0].usd, 1.6, 'use the rate frozen at submission');
    assert.equal(booked[0].cost, 1.6);
    assert.equal(booked[0].user, P);
    assert.equal((await budget.status(viewer(P))).spentUsd, 1.6);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    const finished = (await store.readSession(session.id)).jobs.at(-1);
    assert.equal(finished.accountingStatus, 'booked');
    await poller.settleAccounting(session.id, { ...finished, accountingStatus: 'pending', accountingEntry: booked[0] });
    assert.equal((await costs.readCosts()).filter((entry) => entry.cost > 0).length, 1, 'journal retry is idempotent');

    const aborted = new AbortController();
    aborted.abort();
    const beforeAbort = calls;
    await assert.rejects(tools.executeTool(ctx(P, { signal: aborted.signal }), 'higgsfield_generate_image', args), { code: 'ABORT_ERR' });
    assert.equal(calls, beforeAbort);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);

    fail = true;
    await assert.rejects(tools.executeTool(ctx(), 'higgsfield_generate_image', args), /Injected/);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0, 'failed submit releases the hold');
    fail = false;
    const failedJob = await tools.executeTool(ctx(), 'higgsfield_generate_image', args);
    await poller.handleFailed(session.id, failedJob.job, { error: 'Provider failed' });
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0, 'failed async job releases the hold');

    const unusable = await tools.executeTool(ctx(), 'higgsfield_generate_image', args);
    const download = hf.downloadResult;
    hf.downloadResult = async () => { throw new Error('Injected result download failure'); };
    await assert.rejects(poller.handleHiggsfieldCompleted(session.id, unusable.job, { urls: ['https://result.invalid/unavailable.png'] }), /download failure/);
    hf.downloadResult = download;
    assert.equal((await store.readSession(session.id)).jobs.at(-1).status, 'failed');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0, 'unusable completion frees the hold');

    const unknown = await tools.executeTool(ctx(), 'higgsfield_generate_image', { ...args, model: 'unknown_model' });
    assert.equal(unknown.job.estimateUsd, null);
    assert.equal((await budget.status(viewer(P))).reservedUsd, budget.ASYNC_HOLD_USD());
    await poller.handleHiggsfieldCompleted(session.id, unknown.job, { urls: ['https://result.invalid/unknown.png'] });
    const unknownCharge = (await costs.readCosts()).at(-1);
    assert.equal(unknownCharge.cost, budget.ASYNC_HOLD_USD());
    assert.equal(unknownCharge.billing, 'unknown-price-flat');
    assert.equal(unknownCharge.credits, undefined, 'never invent actual credits');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);

    // An unpriced Higgsfield step reserves only the usual flat amount, never the whole run/budget.
    const unpricedRun = await budget.beginRun(viewer(P), { runId: 'unpriced-higgsfield', estimateUsd: 0 });
    const unpricedJob = await tools.executeTool(ctx(P, { budgetKey: unpricedRun.key }), 'higgsfield_generate_image', { ...args, model: 'unknown_model' });
    assert.equal(unpricedJob.job.reservedUsd, budget.ASYNC_HOLD_USD());
    assert.equal((await budget.status(viewer(P))).reservedUsd, budget.ASYNC_HOLD_USD());
    unpricedRun.release();
    assert.equal((await budget.status(viewer(P))).reservedUsd, budget.ASYNC_HOLD_USD(), 'unpriced run jobs recover without losing their flat hold');
    await poller.handleFailed(session.id, unpricedJob.job, { error: 'Unpriced job failed' });
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);

    const beforeInternal = (await budget.status(viewer(P))).spentUsd;
    const internal = await tools.executeTool(ctx(I), 'higgsfield_generate_image', args);
    assert.equal(internal.job.budgetKey, undefined);
    assert.equal(internal.job.higgsfieldUsdPerCredit, undefined);
    await poller.handleHiggsfieldCompleted(session.id, internal.job, { urls: ['https://result.invalid/internal.png'], credits: 8 });
    assert.equal((await costs.readCosts()).at(-1).cost, 0);
    assert.equal((await costs.readCosts()).at(-1).usd, undefined);
    assert.equal((await budget.status(viewer(P))).spentUsd, beforeInternal);
    assert.equal(access.modelAllowed(viewer(P), 'chatgpt/test'), false);
    await assert.rejects(tools.executeTool(ctx(), 'import_gts_asset', { query: 'test' }), { code: 'FORBIDDEN_FOR_ROLE' });
    await assert.rejects(tools.executeTool(ctx(G), 'higgsfield_generate_image', args), { code: 'FORBIDDEN_FOR_ROLE' });

    // Unknown Higgsfield prices need an extra flat hold; other providers keep using the run's planned hold.
    const unknownRun = await budget.beginRun(viewer(P), { runId: 'unknown-credit-price', estimateUsd: 1 });
    fail = true;
    await assert.rejects(tools.executeTool(ctx(P, { budgetKey: unknownRun.key }), 'higgsfield_generate_image',
      { ...args, model: 'unknown_model' }), /Injected/);
    assert.equal(startedReserved, 1 + budget.ASYNC_HOLD_USD(), 'flat hold is present before the unknown-price job starts');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 1, 'failed submit releases only the extra flat hold');
    fail = false;
    const unknownInRun = await tools.executeTool(ctx(P, { budgetKey: unknownRun.key }), 'higgsfield_generate_image',
      { ...args, model: 'unknown_model' });
    assert.equal(unknownInRun.job.reservedUsd, budget.ASYNC_HOLD_USD());
    assert.equal(unknownInRun.job.unknownCostUsd, budget.ASYNC_HOLD_USD());
    assert.equal((await budget.status(viewer(P))).reservedUsd, 1 + budget.ASYNC_HOLD_USD());
    await poller.handleFailed(session.id, unknownInRun.job, { error: 'Test cleanup' });
    unknownRun.release();
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);

    // Jobs inside a node run live on the run's reservation: the open-job cap of chat jobs does not apply (list nodes).
    settings.setPreference('higgsfieldUsdPerCredit', 0.01);
    const runGrant = await budget.beginRun(viewer(P), { runId: 'jobs', estimateUsd: 1 });
    const open = [];
    for (let i = 0; i < budget.MAX_OPEN_JOBS() + 1; i += 1) open.push(await tools.executeTool(ctx(P, { budgetKey: runGrant.key }), 'higgsfield_generate_image', args));
    for (const job of open) await poller.handleFailed(session.id, job.job, { error: 'Test cleanup' });
    runGrant.release();
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);

    // A real tool/poller cycle reports the same USD/credits in node history and never books twice.
    let keepOpen = false;
    let started;
    let submitted;
    registry.register({ type: 'test.higgsfield_job', category: 'higgsfield', paid: true, async: true,
      cost: { unit: 'credits', estimate: () => ({ credits: 7 }) }, outputs: [{ id: 'text', type: 'text' }],
      execute: async (nodeCtx) => {
        submitted = await tools.executeTool(nodeCtx.toolCtx, 'higgsfield_generate_image', args);
        started?.();
        if (!keepOpen) await poller.handleHiggsfieldCompleted(nodeCtx.sessionId, submitted.job, { urls: ['https://result.invalid/node.png'], credits: 3 });
        await nodeCtx.waitForJob(submitted.job, { intervalMs: 1 });
        return { variants: [{ text: textValue('done') }] };
      }
    });
    const { workflow: jobWorkflow } = await workflows.createWorkflow({ name: 'Async credit workflow', owner: P, graph: {
      nodes: [{ id: 'hfjob', type: 'test.higgsfield_job', params: {}, x: 0, y: 0 }], edges: []
    } });
    const beforeNode = (await budget.status(viewer(P))).spentUsd;
    const jobRunId = await engine.start(jobWorkflow.id, { user: P });
    const jobRun = await engine.whenFinished(jobWorkflow.id, jobRunId);
    assert.equal(jobRun.status, 'completed');
    assert.equal(jobRun.cost.usd, 0.03);
    assert.equal(jobRun.cost.credits, 3);
    assert.ok(Math.abs((await budget.status(viewer(P))).spentUsd - beforeNode - 0.03) < 1e-6);
    keepOpen = true;
    const submittedPromise = new Promise((resolve) => { started = resolve; });
    const cancelledRunId = await engine.start(jobWorkflow.id, { user: P, force: true });
    await submittedPromise;
    engine.cancel(jobWorkflow.id, cancelledRunId);
    assert.equal((await engine.whenFinished(jobWorkflow.id, cancelledRunId)).status, 'cancelled');
    const pending = (await store.readSession(jobWorkflow.sessionId)).jobs.at(-1);
    assert.ok(pending.budgetKey.startsWith('hold:'), 'cancelled run hands its provider obligation over');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0.07);
    const recovered = budget.createBudget({ loadJobs: () => store.listOpenJobs() });
    assert.equal((await recovered.status(viewer(P))).reservedUsd, 0.07, 'restart recovers the USD hold');
    await poller.handleFailed(jobWorkflow.sessionId, pending, { error: 'Cancelled run provider finished unsuccessfully' });
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    assert.equal((await recovered.status(viewer(P))).reservedUsd, 0);

    const journalJob = await tools.executeTool(ctx(), 'higgsfield_generate_image', args);
    const record = costs.recordCost;
    costs.recordCost = async () => { throw new Error('Injected journal failure'); };
    await poller.handleHiggsfieldCompleted(session.id, journalJob.job, { urls: ['https://result.invalid/journal.png'], credits: 4 });
    const pendingBooking = (await store.readSession(session.id)).jobs.at(-1);
    assert.equal(pendingBooking.accountingStatus, 'pending');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0.07, 'failed journal append keeps the hold');
    costs.recordCost = record;
    await poller.settleAccounting(session.id, pendingBooking);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    const estimateJob = await tools.executeTool(ctx(), 'higgsfield_generate_image', args);
    await poller.handleHiggsfieldCompleted(session.id, estimateJob.job, { urls: ['https://result.invalid/estimate.png'] });
    assert.equal((await costs.readCosts()).at(-1).billing, 'credit-estimate');
    assert.equal((await costs.readCosts()).at(-1).credits, 7);
    assert.equal((await costs.readCosts()).at(-1).usd, 0.07);
    assert.equal((await store.readSession(session.id)).jobs.at(-1).costEstimated, true);
    assert.equal(iso.load('lib/result-meta').billingOf((await store.readSession(session.id)).jobs.at(-1)), null);

    settings.setPreference('higgsfieldUsdPerCredit', 0.2);
    const spent = (await budget.status(viewer(P))).spentUsd;
    teams.updateTeam(team.id, { budgetUsd: spent + 0.1 });
    await assert.rejects(tools.executeTool(ctx(), 'higgsfield_generate_image', args), { code: 'BUDGET_INSUFFICIENT' });
    await assert.rejects(engine.start(workflow.id, { user: P, force: true }), { code: 'BUDGET_INSUFFICIENT' });
    teams.updateTeam(team.id, { budgetUsd: 0 });
    const before = calls;
    await assert.rejects(tools.executeTool(ctx(), 'higgsfield_generate_image', args), { code: 'BUDGET_EXHAUSTED' });
    await assert.rejects(engine.start(workflow.id, { user: P, force: true }), { code: 'BUDGET_EXHAUSTED' });
    assert.equal(calls, before, 'budget refusal happens before submission');
    settings.setPreference('higgsfieldUsdPerCredit', null);
    await assertSurfaces(P, false);
    assert.equal(billing.reportedCredits({ text: 'Completed: {"generation": {"cost": {"credits": 3}}} More details.' }), 3);
    assert.equal(billing.reportedCredits({ text: '{"balance": {"credits": 999}}' }), null);
    assert.equal(catalog.creditsFor({ credits_per_unit: null }), null);
  } finally {
    global.fetch = originalFetch;
    await iso.cleanup();
  }
  console.log('test-higgsfield-participants.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
