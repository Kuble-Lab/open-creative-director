'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'job-accounting-'));
  const { PATHS } = require('../lib/config');
  Object.assign(PATHS, { root, projectsDir: path.join(root, 'sessions'), assetsDir: path.join(root, 'assets'), publicRefsDir: path.join(root, 'refs') });
  const store = require('../lib/store');
  const costs = require('../lib/costs');
  const budgetLib = require('../lib/budget');
  const { createAccounting, RESERVATION_TTL_MS } = require('../lib/mcp/accounting');
  const or = require('../lib/openrouter');
  const fal = require('../lib/fal');
  const rendernode = require('../lib/rendernode');
  const higgsfield = require('../lib/higgsfield');
  const poller = require('../lib/poller');
  const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
  store.ensureDirs();
  or.hasKey = fal.hasKey = () => false;
  rendernode.listConfiguredNodes = () => [];
  higgsfield.status = () => ({ connected: false });
  global.fetch = async () => { throw new Error('Network forbidden in this test'); };
  const recordCost = costs.recordCost;
  const mutateSession = store.mutateSession;
  const settleJob = budgetLib.settleJob;
  const settled = [];
  budgetLib.settleJob = (job, amount) => settled.push({ job, amount });
  try {
    // C1: the common store protects ordinary and hidden sessions, including the workflow delete path.
    const session = await store.createSession({ kind: 'workflow' });
    const workflows = createWorkflowsStore({ dir: path.join(root, 'workflows') });
    const { workflow } = await workflows.createWorkflow({ name: 'Accounting test' });
    for (const id of [session.id, workflow.sessionId]) {
      await store.mutateSession(id, (saved) => saved.jobs.push({ jobId: 'open', assetId: 'vid-001', status: 'running' }));
      await assert.rejects(store.deleteSession(id), (err) => err.status === 409 && /Aufträge/.test(err.message));
      assert.equal((await store.readSession(id)).jobs.length, 1);
    }
    await assert.rejects(workflows.deleteWorkflow(workflow.id), (err) => err.status === 409);
    assert.equal((await workflows.readWorkflow(workflow.id)).id, workflow.id);
    await store.mutateSession(workflow.sessionId, (saved) => { saved.jobs[0].status = 'cancelled'; });
    await workflows.deleteWorkflow(workflow.id);
    await store.mutateSession(session.id, (saved) => { saved.jobs = []; });

    // A macOS "._" file next to the sessions must not stop the open-job scan (team list, every paid start).
    await store.mutateSession(session.id, (saved) => saved.jobs.push({ jobId: 'open', assetId: 'vid-001', status: 'running' }));
    await fsp.writeFile(path.join(PATHS.projectsDir, `._${session.id}.json`), 'Mac metadata');
    assert.deepEqual((await store.listOpenJobs()).map((job) => job.sessionId), [session.id]);
    await fsp.rm(path.join(PATHS.projectsDir, `._${session.id}.json`));
    await store.mutateSession(session.id, (saved) => { saved.jobs = []; });

    // C3: both completion paths persist pending accounting before attempting the journal write.
    or.downloadVideo = async () => Buffer.from('test video');
    fal.downloadToFile = async (_url, file) => {
      await fsp.writeFile(file, Buffer.from('test image'));
      return { contentType: 'image/png' };
    };
    for (const source of ['openrouter', 'fal']) {
      const asset = await store.reserveAsset(session.id, { kind: source === 'fal' ? 'image' : 'video', ext: source === 'fal' ? '.png' : '.mp4' });
      const job = { jobId: source, assetId: asset.id, file: asset.file, source, status: 'pending', model: 'test/model', endpoint: 'test/model',
        kind: source === 'fal' ? 'image' : 'video', user: 'user@example.com', createdAt: new Date().toISOString(),
        budgetKey: `hold:${source}`, reservedUsd: 3, costEstimateUsd: 3 };
      await store.mutateSession(session.id, (saved) => saved.jobs.push(job));
      const countBefore = settled.length;
      costs.recordCost = async () => { throw new Error('Injected journal write failure'); };
      if (source === 'fal') await poller.handleFalCompleted(session.id, job, {}, { kind: 'image', url: 'https://example.invalid/image.png' });
      else await poller.handleCompleted(session.id, job, { usage: { cost: 3 } });
      let saved = (await store.readSession(session.id)).jobs.at(-1);
      assert.equal(saved.status, 'completed');
      assert.equal(saved.accountingStatus, 'pending');
      assert.equal(settled.length, countBefore, 'failed booking must keep the reservation');
      await assert.rejects(store.deleteSession(session.id), (err) => err.status === 409);
      const pending = saved;
      const bookingId = saved.accountingEntry.bookingId;
      costs.recordCost = recordCost;
      // The append succeeds but marking the job fails: retry must find the same journal entry.
      store.mutateSession = async () => { throw new Error('Injected session write failure'); };
      await assert.rejects(poller.settleAccounting(session.id, saved), /session write/);
      assert.equal(settled.length, countBefore);
      store.mutateSession = mutateSession;
      await poller.pollOnce(); // no configured provider is required to retry accounting
      await poller.pollOnce();
      saved = (await store.readSession(session.id)).jobs.at(-1);
      assert.equal(saved.accountingStatus, 'booked');
      await Promise.all([poller.settleAccounting(session.id, pending), poller.settleAccounting(session.id, pending)]);
      assert.equal((await costs.readCosts()).filter((entry) => entry.bookingId === bookingId).length, 1);
      assert.equal(settled.length, countBefore + 1);
    }
    const tools = require('../lib/tools');
    fal.hasKey = () => true;
    fal.submit = async () => ({ requestId: 'mcp-persisted' });
    await costs.withVia({ keyId: 'k0123456789abcdef', keyName: 'Test', reservationId: 'persisted', reservationUsd: 10 }, () =>
      tools.executeTool({ sessionId: session.id, config: {}, emit() {}, nodeView: true }, 'fal_generate',
        { endpoint: 'test/model', kind: 'image', input: { prompt: 'Test' }, estimateUsd: 10 }));
    fal.hasKey = () => false;
    const persisted = (await store.readSession(session.id)).jobs.at(-1);
    assert.equal(persisted.mcpReservationId, 'persisted');
    assert.equal(persisted.mcpReservedUsd, 10);
    const fromDisk = createAccounting({ budget: { spentByKey: async () => 0 } });
    assert.equal((await fromDisk.monthUsage('k0123456789abcdef')).reservedUsd, 10);
    await store.mutateSession(session.id, (saved) => { saved.jobs.at(-1).status = 'cancelled'; });
    const row = { ts: new Date().toISOString(), sessionId: session.id, type: 'fal', model: 'test/model', cost: 2, user: 'user@example.com', bookingId: 'concurrent' };
    await fsp.appendFile(costs.COSTS_FILE, '{"partial":');
    await Promise.all([costs.recordCost(row), costs.recordCost(row)]);
    delete require.cache[require.resolve('../lib/costs')];
    await require('../lib/costs').recordCost(row);
    assert.equal((await costs.readCosts()).filter((entry) => entry.bookingId === row.bookingId).length, 1, 'deduplication survives module restart');
    await store.deleteSession(session.id);

    // C4: the first budget check restores every persisted job, not just the first one polled.
    let time = Date.now();
    let jobs = [
      { jobId: 'a', assetId: 'vid-001', budgetKey: 'run:old', user: 'user@example.com', reservedUsd: 6 },
      { jobId: 'b', assetId: 'vid-002', budgetKey: 'hold:old', user: 'user@example.com', reservedUsd: 4 }
    ];
    const options = { index: { refresh: async () => {}, spent: () => 0, spentByKey: () => 0 },
      teams: () => ({ membershipsOf: () => [{ budgetUsd: 10 }] }), now: () => time, loadJobs: async () => jobs };
    let budget = budgetLib.createBudget(options);
    const viewer = { active: true, kind: 'participant', email: 'user@example.com' };
    await assert.rejects(budget.begin(viewer, { estimateUsd: 1 }), (err) => err.code === 'BUDGET_EXHAUSTED');
    await assert.rejects(budget.beginRun(viewer, { runId: 'new', estimateUsd: 1 }), (err) => err.code === 'BUDGET_EXHAUSTED');
    time += 2 * budgetLib.RUN_TTL_MS;
    assert.equal((await budget.status(viewer)).reservedUsd, 10);
    jobs = [{ jobId: 'legacy', budgetKey: 'run:legacy', user: viewer.email, costEstimateUsd: 10 }];
    budget = budgetLib.createBudget(options);
    assert.equal((await budget.status(viewer)).reservedUsd, 10, 'legacy run jobs recover their saved estimate');
    delete jobs[0].costEstimateUsd;
    assert.equal((await budget.status(viewer)).remainingUsd, 0, 'unknown legacy commitments fail closed');
    jobs = [];
    assert.equal((await budget.status(viewer)).reservedUsd, 0, 'completed obligations are removed');
    const run = await budget.beginRun(viewer, { runId: 'live', estimateUsd: 10 });
    const grant = await budget.begin(viewer, { runKey: run.key, estimateUsd: 6, asyncJob: true });
    assert.equal(grant.reservedUsd, 6, 'child grants persist the amount needed for recovery');
    jobs = [{ ...grant, budgetKey: grant.jobKey, jobId: 'child', user: viewer.email }];
    assert.equal((await budget.status(viewer)).reservedUsd, 10, 'live run and its job are not counted twice');
    run.release();
    assert.equal((await budget.status(viewer)).reservedUsd, 6);

    // C5: a cancelled MCP run keeps its provider commitment beyond both old expiry periods and restart.
    const keyId = 'k0123456789abcdef';
    let mcpJobs = [{ keyId, mcpReservationId: 'reservation', mcpReservedUsd: 10, jobId: 'provider' }];
    const accountingOptions = { budget: options.index, now: () => time, loadJobs: async () => mcpJobs };
    const accounting = createAccounting(accountingOptions);
    accounting.begin(keyId, 'run', 10, 'reservation');
    await accounting.end('run', 'cancelled');
    time += 2 * RESERVATION_TTL_MS;
    assert.equal((await accounting.monthUsage(keyId)).reservedUsd, 10);
    const restarted = createAccounting(accountingOptions);
    assert.equal((await restarted.monthUsage(keyId)).reservedUsd, 10);
    mcpJobs.push({ ...mcpJobs[0], jobId: 'second' });
    assert.equal((await restarted.monthUsage(keyId)).reservedUsd, 10, 'the run estimate is not multiplied by its jobs');
    mcpJobs = [];
    assert.equal((await accounting.monthUsage(keyId)).reservedUsd, 0);
    assert.equal((await restarted.monthUsage(keyId)).reservedUsd, 0);
    accounting.begin(keyId, 'orphan', 5);
    await accounting.end('orphan', 'cancelled');
    time += RESERVATION_TTL_MS;
    assert.equal((await accounting.monthUsage(keyId)).reservedUsd, 0, 'orphan reservations still expire');
    mcpJobs = [{ keyId, jobId: 'free', mcpReservationId: 'free', mcpReservedUsd: 0 }];
    assert.equal((await restarted.monthUsage(keyId)).reservedUsd, 0, 'known free work reserves no dollars');
    mcpJobs = [{ keyId, jobId: 'old-a', budgetKey: 'run:old', reservedUsd: 0, costEstimateUsd: 6 },
      { keyId, jobId: 'old-b', budgetKey: 'run:old', reservedUsd: 0, costEstimateUsd: 4 }];
    assert.equal((await restarted.monthUsage(keyId)).reservedUsd, 10, 'legacy run jobs add their individual estimates');
    const broken = createAccounting({ ...accountingOptions, loadJobs: async () => { throw new Error('Unreadable sessions'); } });
    await assert.rejects(broken.monthUsage(keyId), /Unreadable/);
  } finally {
    costs.recordCost = recordCost;
    store.mutateSession = mutateSession;
    budgetLib.settleJob = settleJob;
    await fsp.rm(root, { recursive: true, force: true });
  }
  console.log('test-job-accounting.js: ok');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
