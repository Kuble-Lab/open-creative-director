'use strict';

// The queue of the own computers (WP46, lib/render-queue.js) with the rule of lib/rendernode.js defaultMayServe:
// who may render what (owner, team, everybody, foreign), the order (own computer first, then team, then shared, then a
// render node), work stealing (a copy of a slow job for an idle computer or render node, the first result wins), leases
// (a minute without a sign of life or the deadline: the job goes back and is handed out again, to a render node too, with
// the same id), giving a job back, failures, jobs nobody can take, a restart of the app, and the limits and checks of
// names, ids and sizes. A fake clock and a fake render node; no network.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.AUTH_WHOAMI_URL = 'http://127.0.0.1:9/whoami'; // user management on (never called here)
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.SUPERADMIN_EMAILS;

const access = require('../lib/access');
const { createRenderAgentsStore } = require('../lib/render-agents');
const { createRenderQueue, RenderQueueError, QUEUE_NODE_ID } = require('../lib/render-queue');
const { defaultMayServe } = require('../lib/rendernode');

const ANNA = 'anna@example.com';
const BEN = 'ben@example.com';
const CARL = 'carl@example.com';
const ADMIN = 'admin@example.com';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="main" data-width="1920" data-height="1080"></div></body></html>';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
const quiet = { warn() {}, log() {} };

// Teams: anna and ben in T1, carl in T2.
const TEAMS = { [ANNA]: ['t1'], [BEN]: ['t1'], [CARL]: ['t2'] };
access.useTeamsStore({ activeTeamIdsOf: (email) => TEAMS[String(email).toLowerCase()] || [] });

// The queue hands work on with setImmediate and reads its files asynchronously: give it a moment.
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 40));
};

function fakePush() {
  const nodes = [];
  let counter = 0;
  const find = (id) => nodes.find((node) => node.id === id);
  return {
    nodes,
    add(id, name) {
      const node = { id, name, status: { online: true, running: false, queue: 0, streamingUploads: true }, jobs: new Map(), sent: [] };
      nodes.push(node);
      return node;
    },
    listNodes: () => nodes.map((node) => ({ id: node.id, name: node.name })),
    nodeStatus: async (node) => ({ ...find(node.id).status }),
    sendJob: async (node, status, payload) => {
      const target = find(node.id);
      counter += 1;
      const remote = `r-test${counter}-0000000${counter}`;
      target.sent.push({ remote, payload, status });
      target.jobs.set(remote, { status: 'running' });
      target.status.running = true;
      return remote;
    },
    jobStatus: async (remote, nodeId) => ({ jobId: remote, ...find(nodeId).jobs.get(remote) }),
    download: async (remote, nodeId) => find(nodeId).jobs.get(remote).bytes,
    resetStatusCache: () => {},
    finish(nodeId, remote, bytes = MP4) {
      const node = find(nodeId);
      node.jobs.set(remote, { status: 'completed', bytes });
      node.status.running = false;
    }
  };
}

function setup({ limits = {}, withPush = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-render-queue-'));
  const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
  const now = () => clock.now;
  const store = createRenderAgentsStore({ file: path.join(dir, 'render-agents.json'), now });
  const push = withPush ? fakePush() : null;
  const make = () => createRenderQueue({ dir: path.join(dir, 'render-queue'), agents: store, mayServe: defaultMayServe, push, now, limits, log: quiet });
  const queue = make();
  function computer(owner, name, patch) {
    clock.now += 61 * 1000; // a fresh window for the codes of the person
    const { code } = store.createPairingCode(owner);
    const { agent } = store.pair({ code, ip: '10.0.0.1', name });
    return patch ? store.update(agent.id, patch) : agent;
  }
  return { dir, clock, store, push, queue, make, computer };
}

const poll = (queue, agent, options = {}) => queue.poll(agent, { waitMs: 0, ...options });
const result = (queue, agent, job, bytes = MP4, options = {}) => queue.acceptResult(agent, job.jobId, job.lease, Readable.from([bytes]), options);

async function expectQueueError(promiseOrFn, code, status) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    assert.ok(err instanceof RenderQueueError, err.stack);
    assert.equal(err.code, code, err.message);
    if (status) assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected ${code}`);
}

async function testOwnerOnly() {
  const { queue, computer, store } = setup();
  const anna = computer(ANNA, 'Annas Mac');
  const ben = computer(BEN, 'Bens PC');
  assert.equal(queue.acceptsOwner(ANNA), false, 'nobody online yet: the old way');
  assert.equal(await poll(queue, anna), null);
  assert.equal(await poll(queue, ben), null);
  assert.equal(queue.acceptsOwner(ANNA), true);
  assert.equal(queue.acceptsOwner(CARL), false, 'nobody renders for carl');
  const { jobId, nodeId } = await queue.enqueue({ html: HTML, quality: 'draft', owner: ANNA, label: 'Annas Film', resolution: 'landscape', fps: 24 });
  assert.equal(nodeId, QUEUE_NODE_ID);
  await settle();
  assert.equal(queue.status(jobId).status, 'pending');
  assert.equal(await poll(queue, ben), null, 'a foreign computer never sees the job');
  const job = await poll(queue, anna);
  assert.equal(job.jobId, jobId);
  assert.equal(job.own, true);
  assert.equal(job.label, 'Annas Film');
  assert.equal(job.html, HTML);
  assert.equal(job.fps, 24);
  assert.equal(job.resolution, 'landscape');
  assert.match(job.lease, /^[0-9a-f]{32}$/);
  // the foreign computer cannot use the job even with its id and lease
  await expectQueueError(() => queue.progress(ben, jobId, job.lease, { progress: 0.5 }), 'JOB_NOT_FOUND', 404);
  await expectQueueError(() => queue.openAsset(ben, jobId, job.lease, 'x.png'), 'JOB_NOT_FOUND', 404);
  await expectQueueError(result(queue, ben, job), 'JOB_NOT_FOUND', 404);
  await expectQueueError(() => queue.fail(ben, jobId, job.lease, { error: 'x' }), 'JOB_NOT_FOUND', 404);
  // the owner's computer renders it
  queue.progress(anna, jobId, job.lease, { progress: 0.4 });
  assert.equal(queue.status(jobId).status, 'running');
  assert.equal(queue.status(jobId).nodeName, 'Annas Mac');
  assert.equal(queue.status(jobId).progress, 0.4);
  const activity = queue.agentActivity(anna);
  assert.equal(activity.online, true);
  assert.equal(activity.rendering[0].label, 'Annas Film');
  assert.deepEqual(await result(queue, anna, job), { ok: true, bytes: MP4.length });
  assert.equal(queue.status(jobId).status, 'completed');
  assert.equal(queue.status(jobId).nodeName, 'Annas Mac');
  assert.deepEqual(await queue.readResult(jobId), MP4);
  assert.equal(store.getAgent(anna.id).completed, 1);
  await expectQueueError(() => queue.progress(anna, jobId, job.lease, {}), 'LEASE_LOST', 409);
}

async function testTeamsAndEverybody() {
  const { queue, computer, store } = setup();
  const ben = computer(BEN, 'Bens PC');
  const carl = computer(CARL, 'Carls PC', { shareTeams: true });
  await poll(queue, ben);
  await poll(queue, carl);
  assert.equal(queue.acceptsOwner(ANNA), false, 'ben does not share');
  store.update(ben.id, { shareTeams: true });
  const benShared = store.getAgent(ben.id);
  await poll(queue, benShared);
  assert.equal(queue.acceptsOwner(ANNA), true, 'ben shares with his team (anna)');
  const { jobId } = await queue.enqueue({ html: HTML, owner: ANNA, label: 'Geheim' });
  await settle();
  assert.equal(await poll(queue, carl), null, 'carl shares, but with another team');
  const job = await poll(queue, benShared);
  assert.equal(job.jobId, jobId);
  assert.equal(job.own, false);
  assert.equal(job.label, '', 'a team member does not see the label of somebody else');
  assert.equal(queue.agentActivity(benShared).rendering[0].label, '');
  await result(queue, benShared, job);

  // "for everybody": an admin's computer takes the job of anybody; the same flag on a non-admin's computer counts for nothing
  const admin = computer(ADMIN, 'Gemeinsamer Mac', { shareAll: true });
  store.update(carl.id, { shareAll: true });
  const carlAll = store.getAgent(carl.id);
  await poll(queue, admin);
  await poll(queue, carlAll);
  assert.equal(queue.acceptsOwner('dora@example.com'), true, 'the shared computer renders for everybody');
  const other = await queue.enqueue({ html: HTML, owner: 'dora@example.com' });
  await settle();
  assert.equal(await poll(queue, carlAll), null, 'not an admin: no shared node');
  assert.equal((await poll(queue, admin)).jobId, other.jobId);
  // an anonymous owner ('lokal' while user management is on) is nobody's own job
  const lokal = computer('lokal', 'Alt');
  await poll(queue, lokal);
  const anonymous = await queue.enqueue({ html: HTML, owner: 'lokal' });
  await settle();
  assert.equal(await poll(queue, lokal), null);
  assert.equal(queue.status(anonymous.jobId).status, 'pending');
}

async function testOrder() {
  const { queue, computer, push } = setup({ withPush: true });
  const node = push.add('node-a', 'Render-Node A');
  const admin = computer(ADMIN, 'Gemeinsamer Mac', { shareAll: true });
  const annaTeamMate = computer(BEN, 'Bens PC', { shareTeams: true });
  const anna = computer(ANNA, 'Annas Mac');
  // all three wait (long poll), the render node is idle: the owner's own computer gets the job
  const waitingAdmin = queue.poll(admin, { waitMs: 3000 });
  const waitingBen = queue.poll(annaTeamMate, { waitMs: 3000 });
  const waitingAnna = queue.poll(anna, { waitMs: 3000 });
  const first = await queue.enqueue({ html: HTML, owner: ANNA, label: 'eins' });
  assert.equal((await waitingAnna).jobId, first.jobId, 'own computer first');
  assert.equal(node.sent.length, 0, 'not the render node');
  // the next job: the team member before the shared computer
  const second = await queue.enqueue({ html: HTML, owner: ANNA, label: 'zwei' });
  assert.equal((await waitingBen).jobId, second.jobId);
  // the third: the shared computer
  const third = await queue.enqueue({ html: HTML, owner: ANNA, label: 'drei' });
  assert.equal((await waitingAdmin).jobId, third.jobId);
  // the fourth: nobody waits, the idle render node takes it, exactly as a direct job
  const fourth = await queue.enqueue({ html: HTML, quality: 'high', owner: ANNA, label: 'vier', resolution: 'portrait', fps: 30 });
  await settle();
  assert.equal(node.sent.length, 1);
  assert.deepEqual(node.sent[0].payload, { html: HTML, quality: 'high', assetFiles: null, resolution: 'portrait', fps: 30 });
  assert.equal(queue.status(fourth.jobId).status, 'running');
  assert.equal(queue.status(fourth.jobId).nodeName, 'Render-Node A');
  // the render node finishes: the queue fetches the result, the job id stays
  push.finish('node-a', node.sent[0].remote, Buffer.concat([MP4, Buffer.from('push')]));
  await queue.watchPush();
  assert.equal(queue.status(fourth.jobId).status, 'completed');
  assert.ok((await queue.readResult(fourth.jobId)).toString().endsWith('push'));
}

async function testLeases() {
  const { queue, computer, push, clock } = setup({ withPush: true });
  const anna = computer(ANNA, 'Annas Mac');
  await poll(queue, anna);
  const { jobId } = await queue.enqueue({ html: HTML, owner: ANNA, label: 'Lease' });
  const job = await poll(queue, anna);
  assert.equal(job.jobId, jobId);
  // signs of life keep the lease
  for (let i = 0; i < 5; i += 1) {
    clock.now += 50 * 1000;
    queue.progress(anna, jobId, job.lease, { progress: 0.1 * (i + 1) });
    await queue.sweep();
    assert.equal(queue.status(jobId).status, 'running');
  }
  // a minute without a sign of life: the job goes back; a render node that appears takes it with the same id
  clock.now += 61 * 1000;
  await queue.sweep();
  assert.equal(queue.status(jobId).status, 'pending');
  const node = push.add('node-a', 'Render-Node A');
  await queue.dispatch();
  await settle();
  assert.equal(node.sent.length, 1, 'handed to the render node');
  assert.equal(queue.status(jobId).nodeName, 'Render-Node A');
  // the old lease is gone: the computer is told to stop
  await expectQueueError(() => queue.progress(anna, jobId, job.lease, { progress: 0.9 }), 'LEASE_LOST', 409);
  await expectQueueError(result(queue, anna, job), 'LEASE_LOST', 409);
  push.finish('node-a', node.sent[0].remote);
  await queue.watchPush();
  assert.equal(queue.status(jobId).status, 'completed');
  const history = queue.snapshot().find((entry) => entry.id === jobId).history.map((entry) => `${entry.kind}:${entry.outcome}`);
  assert.deepEqual(history, ['agent:lost', 'push:completed']);

  // the deadline: a computer that reports but never finishes loses the job after 20 minutes
  const second = await queue.enqueue({ html: HTML, owner: ANNA });
  const slow = await poll(queue, anna);
  assert.equal(slow.jobId, second.jobId);
  for (let elapsed = 0; elapsed <= 20 * 60 * 1000; elapsed += 30 * 1000) {
    clock.now += 30 * 1000;
    queue.progress(anna, slow.jobId, slow.lease, { progress: 0.01 });
  }
  node.status.running = true; // the render node is busy: the job waits in the queue
  await queue.sweep();
  assert.equal(queue.status(second.jobId).status, 'pending');
  // giving back: a poll that does not list the lease releases it (the computer forgot it); the job comes back to it
  const again = await poll(queue, anna);
  assert.equal(again.jobId, second.jobId);
  const released = await poll(queue, anna, { running: [] });
  assert.equal(released.jobId, second.jobId, 'released and handed out again');
  assert.notEqual(released.lease, again.lease);
  const kinds = queue.snapshot().find((entry) => entry.id === second.jobId).history.map((entry) => entry.outcome);
  assert.deepEqual(kinds, ['lost', 'released']);
  // the computer is removed: its job goes back
  queue.revokeAgent(anna.id);
  assert.equal(queue.status(second.jobId).status, 'pending');
}

async function testWorkStealing() {
  const { queue, computer, push, clock, store } = setup({ withPush: true });
  const anna = computer(ANNA, 'Langsamer Laptop');
  const fast = computer(ANNA, 'Schneller Mac');
  await poll(queue, anna);
  const { jobId } = await queue.enqueue({ html: HTML, owner: ANNA, label: 'Kapitel 9' });
  const slowJob = await poll(queue, anna);
  assert.equal(slowJob.jobId, jobId);
  // too early for a copy
  clock.now += 30 * 1000;
  queue.progress(anna, jobId, slowJob.lease, { progress: 0.05 });
  assert.equal(await poll(queue, fast), null, 'no copy before a minute');
  // after a minute and with most of the work to do, an idle computer takes a copy
  clock.now += 31 * 1000;
  queue.progress(anna, jobId, slowJob.lease, { progress: 0.1 });
  const copy = await poll(queue, fast);
  assert.equal(copy.jobId, jobId, 'the same job id');
  assert.equal(copy.backup, true);
  assert.notEqual(copy.lease, slowJob.lease);
  // the first result wins, the slow computer is told to stop
  await result(queue, fast, copy);
  assert.equal(queue.status(jobId).status, 'completed');
  assert.equal(queue.status(jobId).nodeName, 'Schneller Mac');
  await expectQueueError(() => queue.progress(anna, jobId, slowJob.lease, { progress: 0.2 }), 'LEASE_LOST', 409);
  assert.equal(store.getAgent(fast.id).completed, 1);

  // nearly done: no copy (less than 30 s to go after the progress)
  const second = await queue.enqueue({ html: HTML, owner: ANNA });
  const almost = await poll(queue, anna);
  assert.equal(almost.jobId, second.jobId);
  clock.now += 90 * 1000;
  queue.progress(anna, second.jobId, almost.lease, { progress: 0.9 });
  assert.equal(await poll(queue, fast), null);
  await result(queue, anna, almost);

  // an idle render node takes a copy of a slow job too, and its result counts
  const node = push.add('node-a', 'Render-Node A');
  const third = await queue.enqueue({ html: HTML, owner: ANNA });
  await settle();
  // the render node took the queued job at once (nobody waited): finish it and start the slow case properly
  if (node.sent.length) {
    push.finish('node-a', node.sent[0].remote);
    await queue.watchPush();
    assert.equal(queue.status(third.jobId).status, 'completed');
  }
  node.status.running = true;
  const fourth = await queue.enqueue({ html: HTML, owner: ANNA });
  const lazy = await poll(queue, anna);
  assert.equal(lazy.jobId, fourth.jobId);
  clock.now += 70 * 1000;
  queue.progress(anna, fourth.jobId, lazy.lease, { progress: 0.1 });
  node.status.running = false;
  await queue.dispatch();
  await settle();
  const sent = node.sent[node.sent.length - 1];
  assert.equal(node.sent.length, 2, 'the render node got a copy');
  push.finish('node-a', sent.remote);
  await queue.watchPush();
  assert.equal(queue.status(fourth.jobId).status, 'completed');
  assert.equal(queue.status(fourth.jobId).nodeName, 'Render-Node A');
  await expectQueueError(() => queue.progress(anna, fourth.jobId, lazy.lease, {}), 'LEASE_LOST', 409);
}

async function testFailuresAndOrphans() {
  const { queue, computer, clock } = setup();
  const anna = computer(ANNA, 'Annas Mac');
  await poll(queue, anna);
  const { jobId } = await queue.enqueue({ html: HTML, owner: ANNA });
  const first = await poll(queue, anna);
  queue.fail(anna, jobId, first.lease, { error: 'Chrome abgestuerzt' });
  assert.equal(queue.status(jobId).status, 'pending', 'one failure: another try');
  const second = await poll(queue, anna);
  queue.fail(anna, jobId, second.lease, { error: 'wieder' });
  const failed = queue.status(jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /wieder/);
  // giving back does not count as a failure
  const other = await queue.enqueue({ html: HTML, owner: ANNA });
  const taken = await poll(queue, anna);
  queue.fail(anna, other.jobId, taken.lease, { released: true });
  assert.equal(queue.status(other.jobId).status, 'pending');
  // nobody online for 10 minutes: the job fails with a clear message
  clock.now += 46 * 1000;
  await queue.sweep();
  assert.equal(queue.status(other.jobId).status, 'pending');
  clock.now += 10 * 60 * 1000;
  await queue.sweep();
  assert.equal(queue.status(other.jobId).status, 'failed');
  assert.match(queue.status(other.jobId).error, /Kein Rechner/);
}

async function testRestart() {
  const { queue, computer, make, clock, dir, push } = setup({ withPush: true });
  const anna = computer(ANNA, 'Annas Mac');
  await poll(queue, anna);
  const running = await queue.enqueue({ html: `${HTML}<!-- laeuft -->`, owner: ANNA, label: 'laeuft' });
  const job = await poll(queue, anna);
  const waiting = await queue.enqueue({ html: `${HTML}<!-- wartet -->`, owner: ANNA, label: 'wartet' });
  // the folder: job.json mode 600, the folder 700
  const folder = path.join(dir, 'render-queue', running.jobId);
  assert.equal(fs.statSync(path.join(folder, 'job.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  // the app restarts
  queue.stop();
  const restarted = make();
  assert.equal(restarted.status(running.jobId).status, 'running', 'the running job keeps its lease for a while');
  assert.equal(restarted.status(waiting.jobId).status, 'pending');
  restarted.progress(anna, running.jobId, job.lease, { progress: 0.5 });
  clock.now += 30 * 1000;
  await restarted.sweep();
  assert.equal(restarted.status(running.jobId).status, 'running');
  // the computer does not come back: after a minute the job goes back and is handed out again (here: the render node)
  clock.now += 61 * 1000;
  push.add('node-a', 'Render-Node A');
  await restarted.sweep();
  await settle();
  assert.equal(restarted.status(running.jobId).status, 'pending', 'the lease ran out: back in the queue');
  assert.equal(restarted.status(waiting.jobId).nodeName, 'Render-Node A', 'the older job first');
  push.finish('node-a', push.nodes[0].sent[0].remote);
  await restarted.watchPush();
  await settle();
  assert.equal(restarted.status(waiting.jobId).status, 'completed');
  assert.equal(restarted.status(running.jobId).nodeName, 'Render-Node A', 'then the job of the lost computer, with the same id');
  // a job on a render node is watched on after the next restart
  restarted.stop();
  const third = make();
  assert.equal(third.status(running.jobId).status, 'running');
  push.finish('node-a', push.nodes[0].sent[1].remote);
  await third.watchPush();
  assert.equal(third.status(running.jobId).status, 'completed');
  assert.deepEqual(await third.readResult(running.jobId), MP4);
}

async function testLimitsAndChecks() {
  const { queue, computer, dir } = setup({ limits: { maxHtmlBytes: 200, maxAssetBytes: 1000, maxResultBytes: 500 } });
  const anna = computer(ANNA, 'Annas Mac');
  await poll(queue, anna);
  await expectQueueError(queue.enqueue({ html: 'x'.repeat(201), owner: ANNA }), 'TOO_LARGE', 413);
  await expectQueueError(queue.enqueue({ html: ' ', owner: ANNA }), 'INVALID_JOB');
  await expectQueueError(queue.enqueue({ html: HTML.slice(0, 150), quality: 'ultra', owner: ANNA }), 'INVALID_JOB');
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-render-queue-assets-'));
  const asset = (name, size) => {
    const file = path.join(assetDir, `${Math.random()}`);
    fs.writeFileSync(file, Buffer.alloc(size, 1));
    return { filename: name, path: file, size };
  };
  const html = '<html><body>x</body></html>';
  await expectQueueError(queue.enqueue({ html, owner: ANNA, assetFiles: { files: Array.from({ length: 11 }, (_, i) => asset(`a${i}.png`, 1)) } }), 'TOO_LARGE', 413);
  await expectQueueError(queue.enqueue({ html, owner: ANNA, assetFiles: { files: [asset('../x.png', 1)] } }), 'INVALID_JOB');
  await expectQueueError(queue.enqueue({ html, owner: ANNA, assetFiles: { files: [asset('a/b.png', 1)] } }), 'INVALID_JOB');
  await expectQueueError(queue.enqueue({ html, owner: ANNA, legacyAssets: { 'x y.png': 'AAAA' } }), 'INVALID_JOB');
  await expectQueueError(queue.enqueue({ html, owner: ANNA, assetFiles: { files: [asset('a.mp4', 600), asset('b.mp4', 600)] } }), 'TOO_LARGE', 413);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'render-queue')), [], 'nothing stays of a refused job');
  // assets: only the computer that holds the job, only the files of the job
  const { jobId } = await queue.enqueue({ html, owner: ANNA, assetFiles: { files: [asset('clip.mp4', 300)] }, legacyAssets: null });
  const job = await poll(queue, anna);
  assert.deepEqual(job.assets, [{ filename: 'clip.mp4', size: 300 }]);
  const file = queue.openAsset(anna, jobId, job.lease, 'clip.mp4');
  assert.equal(fs.statSync(file.path).size, 300);
  await expectQueueError(() => queue.openAsset(anna, jobId, job.lease, '../job.json'), 'ASSET_NOT_FOUND', 404);
  await expectQueueError(() => queue.openAsset(anna, jobId, job.lease, 'index.html'), 'ASSET_NOT_FOUND', 404);
  await expectQueueError(() => queue.progress(anna, '../etc', job.lease, {}), 'JOB_NOT_FOUND', 404);
  await expectQueueError(() => queue.progress(anna, jobId, 'abc', {}), 'JOB_NOT_FOUND', 404);
  // the result: size, type, empty
  await expectQueueError(result(queue, anna, job, MP4, { contentLength: '501' }), 'TOO_LARGE', 413);
  await expectQueueError(result(queue, anna, job, Buffer.concat([MP4, Buffer.alloc(400)])), 'TOO_LARGE', 413);
  await expectQueueError(result(queue, anna, job, Buffer.from('<html>not a video</html>')), 'INVALID_RESULT', 422);
  await expectQueueError(result(queue, anna, job, Buffer.alloc(0)), 'INVALID_RESULT', 422);
  assert.equal(queue.status(jobId).status, 'running', 'a refused upload keeps the lease');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'render-queue', jobId)).filter((name) => name.endsWith('.part')), [], 'no partial file stays');
  await result(queue, anna, job);
  assert.equal(queue.status(jobId).status, 'completed');
  await expectQueueError(queue.readResult('rq-nope'), 'JOB_NOT_FOUND', 404);
}

async function main() {
  // the timers of the long poll do not keep a process alive (unref): this test keeps it alive itself
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await runAll();
  } finally {
    clearInterval(keepAlive);
  }
}

async function runAll() {
  await testOwnerOnly();
  await testTeamsAndEverybody();
  await testOrder();
  await testLeases();
  await testWorkStealing();
  await testFailuresAndOrphans();
  await testRestart();
  await testLimitsAndChecks();
  access.useTeamsStore(null);
  console.log('Warteschlange der eigenen Rechner: Besitzer, Team, alle und fremd, Reihenfolge, Work-Stealing, Leasing, Rückgabe, Übergabe an den Render-Node mit gleicher Job-ID, Neustart und Grenzen sind korrekt.');
  console.log('test-render-queue.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
