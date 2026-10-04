'use strict';

// Engine behaviour that the node "Edit video with references" needs when it edits a long video in parts (WP41 review), with fake nodes:
//   - "run again" (force) tells a node (ctx.forced) only where a finished result is put aside; after a run that failed it only goes on,
//     so the finished parts of a long video are not paid a second time; a result made after the last finished one is kept
//   - several waits of one node at the same time: the node stays "waiting" until the LAST one has ended
//   - a job that was started but never waited for (the run fails between two starts) is handed its share of the budget reservation
//   - the plan's reservation for the node is told to the node (ctx.reservedUsd)
// No provider calls; the backing sessions are real and removed.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const access = require('../lib/access');
const budget = require('../lib/budget');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { textValue } = require('../lib/nodes/types');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-engine-rerun-'));
  const bus = createEventBus();
  const registry = createRegistry();
  const seen = [];
  const behaviour = { fail: false, reserved: [] };
  registry.register({
    type: 't.paid',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'x', kind: 'text', default: 'a' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => 3, history: false },
    execute: async (ctx) => {
      seen.push({ forced: ctx.forced, since: ctx.forcedSince, reserved: ctx.reservedUsd });
      if (behaviour.fail) throw new Error('part 3 failed');
      return { variants: [{ out: textValue('ok') }], cost: { usd: 1 } };
    }
  });
  // two jobs waited for at the same time; the second one ends later
  registry.register({
    type: 't.twojobs',
    category: 'video',
    outputs: [{ id: 'out', type: 'text' }],
    async: true,
    execute: async (ctx) => {
      await store.mutateSession(ctx.sessionId, (session) => {
        session.jobs.push({ jobId: 'job-a', assetId: 'vid-a', status: 'pending', kind: 'video' }, { jobId: 'job-b', assetId: 'vid-b', status: 'pending', kind: 'video' });
      });
      const finish = (jobId, delay) =>
        sleep(delay).then(() =>
          store.mutateSession(ctx.sessionId, (session) => {
            const job = session.jobs.find((entry) => entry.jobId === jobId);
            job.status = 'completed';
            job.resultAssetIds = [job.assetId];
          })
        );
      behaviour.finishedB = null;
      finish('job-a', 60);
      finish('job-b', 500).then(() => {
        behaviour.finishedB = Date.now();
      });
      await Promise.all([ctx.waitForJob({ jobId: 'job-a', assetId: 'vid-a' }), ctx.waitForJob({ jobId: 'job-b', assetId: 'vid-b' })]);
      return { variants: [{ out: textValue('both') }] };
    }
  });
  // starts two jobs, never waits for them, and fails
  registry.register({
    type: 't.startfail',
    category: 'video',
    outputs: [{ id: 'out', type: 'text' }],
    async: true,
    paid: true,
    cost: { unit: 'usd', estimate: () => null, history: false },
    execute: async (ctx) => {
      await store.mutateSession(ctx.sessionId, (session) => {
        session.jobs.push({ jobId: 'job-c', assetId: 'vid-c', status: 'pending', kind: 'video' }, { jobId: 'job-d', assetId: 'vid-d', status: 'pending', kind: 'video' });
      });
      ctx.watchJob({ jobId: 'job-c', assetId: 'vid-c' });
      ctx.watchJob({ jobId: 'job-d', assetId: 'vid-d' });
      throw new Error('part 3 could not be cut');
    }
  });

  const wfStore = createWorkflowsStore({ dir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
  const created = [];
  const make = async (type, params = {}) => {
    const { workflow } = await wfStore.createWorkflow({ name: `rerun ${type}`, graph: { nodes: [{ id: 'p', type, typeVersion: 1, x: 0, y: 0, params }], edges: [] } });
    created.push(workflow.id);
    return workflow;
  };
  const run = async (workflowId, request) => engine.whenFinished(workflowId, await engine.start(workflowId, request));

  try {
    /* ----- force: only over a finished result ----- */
    {
      const workflow = await make('t.paid');
      behaviour.fail = true;
      const first = await run(workflow.id, { mode: 'all', force: false });
      assert.equal(first.status, 'failed');
      assert.deepEqual(seen.at(-1), { forced: false, since: null, reserved: 3 }, 'a normal run: not forced; the plan reserved 3 USD for the node');
      // the button "Retry" under the error / the play button / "Run" in the node menu: force:true, but there is nothing to put aside
      const retry = await run(workflow.id, { mode: 'node', nodeIds: ['p'], force: true });
      assert.equal(retry.status, 'failed');
      assert.equal(seen.at(-1).forced, false, 'after a failed run "run again" is not "everything again": the finished work is kept');
      assert.equal(seen.at(-1).since, null);
      // the run succeeds: now there is a result
      behaviour.fail = false;
      const done = await run(workflow.id, { mode: 'node', nodeIds: ['p'], force: true });
      assert.equal(done.status, 'completed');
      assert.equal(seen.at(-1).forced, false, 'still nothing to put aside while the node had no result');
      const entry = (await wfStore.readResults(workflow.id)).nodes.p.history[0];
      // with a finished result, "run again" is the explicit request for everything again
      const again = await run(workflow.id, { mode: 'node', nodeIds: ['p'], force: true });
      assert.equal(again.status, 'completed');
      assert.equal(seen.at(-1).forced, true);
      assert.equal(typeof seen.at(-1).since, 'string');
      assert.ok(Date.parse(seen.at(-1).since) >= Date.parse(entry.createdAt), 'the time of the finished result that is put aside');
      // a forced run that fails: the next one is still forced over the (old) result, with its time, so work made in between is kept
      const timeOfResult = (await wfStore.readResults(workflow.id)).nodes.p.history.map((item) => item.createdAt).sort().at(-1);
      behaviour.fail = true;
      await run(workflow.id, { mode: 'node', nodeIds: ['p'], force: true });
      assert.equal(seen.at(-1).forced, true);
      assert.equal(seen.at(-1).since, timeOfResult);
      behaviour.fail = false;
      // "Run all" without force does not run the node again at all (its result is there)
      const before = seen.length;
      await run(workflow.id, { mode: 'all', force: false });
      assert.equal(seen.length, before);
    }

    /* ----- several waits of one node: waiting until the last one has ended ----- */
    {
      const workflow = await make('t.twojobs');
      const events = [];
      const unsubscribe = bus.subscribe(workflow.id, (event) => {
        if (event.type === 'node_status' && event.nodeId === 'p') events.push({ status: event.status, at: Date.now() });
      });
      const record = await run(workflow.id, { mode: 'all', force: false });
      unsubscribe();
      assert.equal(record.status, 'completed');
      const running = events.filter((event) => event.status === 'running');
      assert.equal(running.length >= 1, true);
      const lastRunning = running.at(-1);
      assert.ok(behaviour.finishedB, 'the second job ended');
      assert.ok(lastRunning.at >= behaviour.finishedB - 5, 'the node is "running" again only when the last job has ended');
      // between the end of the first job (60 ms) and the second (500 ms) the status stays "waiting_job": nothing says "running"
      const afterFirstWait = events.findIndex((event) => event.status === 'waiting_job');
      const inBetween = events.slice(afterFirstWait).filter((event) => event.status === 'running' && event.at < behaviour.finishedB - 20);
      assert.deepEqual(inBetween, [], 'no "running" while a part still waits');
    }

    /* ----- a job that was started but never waited for gets its share of the reservation ----- */
    {
      const originals = { viewerOf: access.viewerOf, beginRun: budget.beginRun, detachRun: budget.detachRun, release: budget.release };
      const detached = [];
      const released = [];
      access.viewerOf = () => ({ active: true, kind: 'participant', email: 'p@example.test' });
      budget.beginRun = async () => ({ applies: true, key: 'run:fake', jobKey: 'run:fake', reservedUsd: 0, release() {}, settle() {} });
      budget.detachRun = async (_viewer, key, count) => {
        detached.push({ key, count });
        return Array.from({ length: count }, (_, index) => ({ key: `hold:${index}`, usd: 2 }));
      };
      budget.release = (key) => released.push(key);
      try {
        const workflow = await make('t.startfail');
        const record = await run(workflow.id, { mode: 'all', force: false });
        assert.equal(record.status, 'failed');
        assert.deepEqual(detached, [{ key: 'run:fake', count: 2 }], 'both started jobs take over the reservation of the run');
        const session = await store.readSession((await wfStore.readWorkflow(workflow.id)).sessionId);
        assert.deepEqual(session.jobs.map((job) => job.budgetKey).sort(), ['hold:0', 'hold:1'], 'every job carries a hold of its own');
      } finally {
        Object.assign(access, { viewerOf: originals.viewerOf });
        Object.assign(budget, { beginRun: originals.beginRun, detachRun: originals.detachRun, release: originals.release });
      }
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-engine-rerun.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
