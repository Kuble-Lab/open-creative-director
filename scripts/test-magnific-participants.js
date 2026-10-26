'use strict';

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
  const fetch = global.fetch;
  global.fetch = async () => { throw new Error('Network forbidden'); };
  try {
    const access = iso.load('lib/access');
    const settings = iso.load('lib/settings');
    const teams = iso.load('lib/teams');
    const store = iso.load('lib/store');
    const budget = iso.load('lib/budget');
    const costs = iso.load('lib/costs');
    const magnific = iso.load('lib/magnific');
    const api = iso.load('lib/tools/magnific');
    const tools = iso.load('lib/tools');
    const registryLib = iso.load('lib/nodes/registry');
    const billing = iso.load('lib/magnific-billing');
    const poller = iso.load('lib/poller');
    store.ensureDirs();
    const team = teams.createTeam({ name: 'Participants', budgetUsd: 100 });
    teams.addMembers(team.id, [P]);
    const viewer = (user) => access.viewerOf({ kubleUser: user });
    let connected = true;
    let estimate = 7;
    let reported;
    let actual = 8;
    let fail = false;
    let count = 0;
    let reserved;
    let synchronous = false;
    magnific.status = () => ({ connected });
    magnific.listTools = async () => ['images_upscale', 'simulate_cost', 'creations_wait', 'account_balance', 'images_upscale_modes_list']
      .map((name) => ({ name, inputSchema: { type: 'object', additionalProperties: true } }));
    magnific.mcpCall = async (name, args) => {
      if (name === 'simulate_cost') {
        if (estimate === null) throw new Error('No price');
        return { estimated_credits: estimate };
      }
      if (name === 'account_balance') return { balance: { credits: 999 } };
      if (name === 'images_upscale_modes_list') return { modes: [] };
      if (name === 'creations_wait') return { creations: args.identifiers.map((id) => ({ identifier: id,
        status: 'completed', url: 'https://result.invalid/image.png', ...(actual === null ? {} : { credits: actual }) })) };
      assert.equal(name, 'images_upscale');
      count++;
      reserved = (await budget.status(viewer(P))).reservedUsd;
      if (fail) throw new Error('Injected submit failure');
      return { ...(synchronous ? {} : { creationIdentifier: `creation-${count}` }), ...(reported === undefined ? {} : { credits: reported }) };
    };
    magnific.downloadResult = async () => ({ buffer: Buffer.from('mock image'), contentType: 'image/png' });
    const server = iso.load('server.js');
    const preferenceLayer = server.app._router.stack.find((entry) => entry.route?.path === '/api/settings/preferences' && entry.route.methods.put);
    const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, set() { return this; } });
    async function preference(user, value) {
      const res = response();
      await preferenceLayer.route.stack[0].handle({ kubleUser: user, body: { name: 'magnificUsdPerCredit', value } }, res);
      return res;
    }
    // Exercise the browser form without a server: load, validation, clearing and failed saves.
    const vm = require('node:vm');
    const fs = require('node:fs');
    const path = require('node:path');
    const form = {};
    const ui = { el: { magnificRate: { value: '' }, magnificRateForm: form,
      higgsfieldRate: {}, videoAskToggle: {} }, state: { preferences: { magnificUsdPerCredit: 0.2 } },
      t: (key) => key, window: {} };
    vm.createContext(ui);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app-settings.js'), 'utf8'), ui);
    const feedback = [];
    const busy = [];
    ui.showSettingsFeedback = (message) => feedback.push(message);
    ui.setSettingsBusy = (target, value) => { assert.equal(target, form); busy.push(value); };
    let saved;
    ui.api = async (url, request) => {
      assert.equal(url, '/api/settings/preferences');
      saved = JSON.parse(request.body);
      return { preferences: { [saved.name]: saved.value } };
    };
    ui.renderVideoAskToggle();
    assert.equal(ui.el.magnificRate.value, 0.2);
    ui.el.magnificRate.value = '0';
    await ui.saveMagnificRate();
    assert.equal(saved, undefined);
    assert.equal(feedback.at(-1), 'magnific.rateInvalid');
    ui.el.magnificRate.value = '0.3';
    await ui.saveMagnificRate();
    assert.deepEqual(saved, { name: 'magnificUsdPerCredit', value: 0.3 });
    assert.equal(ui.state.preferences.magnificUsdPerCredit, 0.3);
    ui.el.magnificRate.value = '  ';
    await ui.saveMagnificRate();
    assert.equal(saved.value, null);
    ui.api = async () => { throw new Error('Save failed'); };
    ui.el.magnificRate.value = '0.4';
    await ui.saveMagnificRate();
    assert.equal(ui.state.preferences.magnificUsdPerCredit, null);
    assert.equal(feedback.at(-1), 'magnific.rateFailed');
    assert.deepEqual(busy, [true, false, true, false, true, false]);

    settings.setPreference('higgsfieldUsdPerCredit', 0.9);
    assert.equal(settings.getPreference('magnificUsdPerCredit'), null);
    assert.equal((await preference(P, 0.2)).statusCode, 403);
    for (const value of [0, -1, NaN, Infinity, '0.2', false, undefined]) {
      assert.throws(() => settings.setPreference('magnificUsdPerCredit', value));
      assert.equal((await preference(A, value)).statusCode, 400);
    }
    assert.equal((await preference(A, null)).statusCode, 200);
    const def = registryLib.get('magnific.upscale_image');
    assert.equal(access.magnificAllowed(viewer(P)), false);
    assert.equal(registryLib.blockedFor(def, viewer(P)), true);
    await assert.rejects(tools.executeTool({ user: P }, 'magnific_tools', {}), { code: 'FORBIDDEN_FOR_ROLE' });
    assert.equal((await preference(A, 0.2)).body.preferences.magnificUsdPerCredit, 0.2);
    settings.loadSettings();
    assert.equal(settings.getPreference('magnificUsdPerCredit'), 0.2);
    for (const user of [P, I, A]) {
      assert.equal(access.magnificAllowed(viewer(user)), true);
      assert.equal(registryLib.blockedFor(def, viewer(user)), false);
      assert.ok(tools.toolDefinitions(viewer(user)).some((tool) => tool.function.name === 'magnific_call'));
      await tools.executeTool({ user }, 'magnific_tools', {});
    }
    for (const user of [G, null]) {
      assert.equal(access.magnificAllowed(viewer(user)), false);
      assert.equal(registryLib.blockedFor(def, viewer(user)), true);
      await assert.rejects(tools.executeTool({ user }, 'magnific_tools', {}), { code: 'FORBIDDEN_FOR_ROLE' });
    }
    connected = false;
    assert.equal(access.magnificAllowed(viewer(P)), false);
    assert.equal(access.magnificAllowed(viewer(I)), true);
    assert.equal(access.magnificAllowed(access.LOCAL_VIEWER), true);
    connected = true;

    const registry = registryLib.createRegistry();
    registry.register({ type: 'test.magnific', provider: 'magnific', category: 'magnific', paid: true,
      cost: { unit: 'credits', estimate: () => ({ credits: 7 }) }, outputs: [{ id: 'text', type: 'text' }],
      execute: async () => ({ variants: [{ text: { type: 'text', value: 'done' } }], cost: { credits: 7 } }) });
    const workflows = iso.load('lib/nodes/workflows-store').createWorkflowsStore({ registry });
    const engine = iso.load('lib/nodes/engine').createEngine({ registry, store: workflows });
    const { workflow } = await workflows.createWorkflow({ name: 'Credits', owner: P, graph: {
      nodes: [{ id: 'mag', type: 'test.magnific', params: {}, x: 0, y: 0 }], edges: [] } });
    assert.ok(Math.abs((await engine.plan(workflow.id, { user: P })).totals.usd - 1.4) < 1e-6);
    assert.equal((await engine.plan(workflow.id, { user: I })).totals.usd, 0);
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
    iso.load('lib/nodes/routes').registerNodeRoutes(app, { engine, store: workflows, registry: registryLib.registry });
    for (const source of ['magnific-upscale-modes', 'magnific-upscale-scales']) {
      for (const [user, status] of [[P, 200], [G, 403], [null, 403]]) {
        const res = response();
        await handlers.get('get /api/nodes/options/:source')({ kubleUser: user, params: { source }, query: {} }, res);
        assert.equal(res.statusCode, status);
      }
    }
    const session = await store.createSession({ owner: P });
    const ctx = (user = P, extra = {}) => ({ sessionId: session.id, user, config: {}, emit() {}, ...extra });
    const args = { tool: 'images_upscale', arguments: { creationIdentifier: 'input', mode: 'creative', scale: '2x' } };
    const run = () => tools.executeTool(ctx(), 'magnific_call', args);
    await assert.rejects(tools.executeTool(ctx(G), 'magnific_call', args), { code: 'FORBIDDEN_FOR_ROLE' });
    const free = await tools.executeTool(ctx(), 'magnific_balance', {});
    assert.ok(free.toolResult);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    const job = (await run()).job;
    assert.equal(reserved, 1.4, 'reserve estimate times rate before provider start');
    assert.equal(job.magnificUsdPerCredit, 0.2);
    assert.equal(job.estimateCredits, 7);
    assert.equal(job.reservedUsd, 1.4);
    assert.equal((await costs.readCosts()).filter((row) => row.type === 'magnific').length, 0, 'no premature charge');
    settings.setPreference('magnificUsdPerCredit', 0.5);
    await api.pollJob(session.id, job, { wait: true });
    const booked = (await costs.readCosts()).filter((row) => row.type === 'magnific');
    assert.equal(booked.length, 1);
    assert.equal(booked[0].usd, 1.6, 'actual credits at the frozen rate');
    assert.equal(booked[0].credits, 8);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    assert.equal((await budget.status(viewer(P))).spentUsd, 1.6);
    const finished = (await store.readSession(session.id)).jobs.at(-1);
    assert.equal(finished.accountingStatus, 'booked');
    assert.equal(iso.load('lib/result-meta').billingOf(finished), null);
    await api.pollJob(session.id, job, { wait: true });
    assert.equal((await costs.readCosts()).filter((row) => row.type === 'magnific').length, 1, 'completion is idempotent');

    fail = true;
    await assert.rejects(run(), /Injected submit failure/);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    fail = false;
    const failed = (await run()).job;
    await poller.handleFailed(session.id, failed, { error: 'Provider failure' });
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    estimate = null;
    actual = null;
    const unknown = (await run()).job;
    assert.equal(unknown.reservedUsd, budget.ASYNC_HOLD_USD());
    await api.pollJob(session.id, unknown, { wait: true });
    assert.equal((await costs.readCosts()).at(-1).billing, 'unknown-price-flat');
    assert.equal((await costs.readCosts()).at(-1).cost, budget.ASYNC_HOLD_USD());
    const grant = await budget.beginRun(viewer(P), { runId: 'unknown', estimateUsd: 0 });
    const runUnknown = (await tools.executeTool(ctx(P, { budgetKey: grant.jobKey }), 'magnific_call', args)).job;
    assert.equal((await budget.status(viewer(P))).reservedUsd, budget.ASYNC_HOLD_USD());
    await api.pollJob(session.id, runUnknown, { wait: true });
    grant.release();
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    estimate = 7;
    const fallback = (await run()).job;
    await api.pollJob(session.id, fallback, { wait: true });
    assert.equal((await costs.readCosts()).at(-1).billing, 'credit-estimate');
    assert.equal((await costs.readCosts()).at(-1).cost, 3.5);
    const deferred = (await run()).job;
    actual = 8;
    const record = costs.recordCost;
    costs.recordCost = async () => { throw new Error('Journal unavailable'); };
    await api.pollJob(session.id, deferred, { wait: true });
    const pending = (await store.readSession(session.id)).jobs.at(-1);
    assert.equal(pending.accountingStatus, 'pending');
    assert.equal((await budget.status(viewer(P))).reservedUsd, 3.5);
    costs.recordCost = record;
    await poller.settleAccounting(session.id, pending);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    synchronous = true;
    const sync = await run();
    assert.equal(sync.job, undefined);
    assert.equal((await budget.status(viewer(P))).reservedUsd, 0);
    synchronous = false;
    const internal = (await tools.executeTool(ctx(I), 'magnific_call', args)).job;
    assert.equal(internal.magnificUsdPerCredit, undefined);
    assert.equal((await costs.readCosts()).at(-1).cost, 0);
    const before = count;
    teams.updateTeam(team.id, { budgetUsd: (await budget.status(viewer(P))).spentUsd + 0.1 });
    await assert.rejects(run(), { code: 'BUDGET_INSUFFICIENT' });
    teams.updateTeam(team.id, { budgetUsd: 0 });
    await assert.rejects(run(), { code: 'BUDGET_EXHAUSTED' });
    assert.equal(count, before);
    assert.equal(billing.reportedCredits({ balance: { credits: 900 }, estimated_credits: 7, estimated: { credits: 7 } }), null);
    assert.equal(billing.reportedCredits({ cost: { credits: 0 } }), 0);
    assert.equal((await preference(A, null)).statusCode, 200);
    assert.equal(access.magnificAllowed(viewer(P)), false);
  } finally {
    global.fetch = fetch;
    await iso.cleanup();
  }
  console.log('test-magnific-participants.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
