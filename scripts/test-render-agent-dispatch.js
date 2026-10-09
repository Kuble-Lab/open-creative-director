'use strict';

// lib/rendernode.js with the queue of the own computers (WP46). Without a computer that may render the job, every request
// to the render nodes is byte for byte the one of the code before WP46 (support/render-requests-before-wp46.json: seven
// cases, the order, the headers, the bodies, the answers), with and without the owner. With such a computer online the job
// goes into the queue and no render node is asked; status and download come from the queue. A render node that takes a job
// from the queue gets exactly the requests of a direct job. No network.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { createRenderNodeClient, RenderNodeError, QUEUE_NODE_ID, defaultMayServe } = require('../lib/rendernode');
const { createRenderQueue } = require('../lib/render-queue');
const { createRenderAgentsStore } = require('../lib/render-agents');
const { runCases, HTML } = require('./support/render-request-cases');
const BEFORE = require('./support/render-requests-before-wp46.json');

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);
const quiet = { warn() {}, log() {} };
const plain = (value) => JSON.parse(JSON.stringify(value));

async function testUnchangedWithoutComputer() {
  assert.ok(BEFORE.length >= 7);
  assert.deepEqual(plain(await runCases(createRenderNodeClient)), BEFORE, 'without owner: the requests of before');
  let asked = 0;
  const queue = {
    acceptsOwner: () => {
      asked += 1;
      return false;
    },
    enqueue: () => assert.fail('no computer: nothing goes into the queue')
  };
  const withOwner = await runCases(createRenderNodeClient, { extraOptions: { owner: 'anna@example.com', label: 'Film' }, extraClient: { queue, agentsCount: () => 2 } });
  assert.deepEqual(plain(withOwner), BEFORE, 'with owner and no computer for it: byte for byte the same');
  assert.equal(asked, BEFORE.length, 'the queue was asked once per job');
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

// A render node behind a fake fetch that records every request (bodies of streams included).
function fakeNode(log, state) {
  let renders = 0;
  return async (url, options = {}) => {
    const parsed = new URL(url);
    let body = options.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      body = `stream:${Buffer.concat(chunks).toString('base64')}`;
    }
    log.push({ path: parsed.pathname, method: options.method || 'GET', body: body === undefined ? null : body });
    if (parsed.pathname === '/health') return json({ ok: true, queue: 0, running: state.running, streamingUploads: true });
    if (parsed.pathname === '/uploads') return json({ uploadId: 'r-upload1-0000000a' }, 201);
    if (parsed.pathname.startsWith('/uploads/')) return json({ ok: true }, 201);
    if (parsed.pathname === '/render') {
      renders += 1;
      state.running = true;
      return json({ jobId: `r-render${renders}-0000000b` }, 202);
    }
    if (parsed.pathname.endsWith('/file')) return new Response(MP4, { status: 200 });
    if (parsed.pathname.startsWith('/jobs/')) return json({ status: state.done ? 'completed' : 'running' });
    return json({ error: 'unknown' }, 404);
  };
}

async function testQueuePath() {
  process.env.AUTH_WHOAMI_URL = 'http://127.0.0.1:9/whoami';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-render-dispatch-'));
  const agents = createRenderAgentsStore({ file: path.join(dir, 'render-agents.json') });
  const log = [];
  const state = { running: false, done: false };
  const nodes = [{ id: 'node-1', name: 'Node 1', url: 'http://node1.test', token: 'token-1', enabled: true }];
  let queue = null;
  const client = createRenderNodeClient({
    store: { listNodes: () => nodes },
    env: {},
    fetchImpl: fakeNode(log, state),
    queue: () => queue,
    agentsCount: () => agents.count()
  });
  queue = createRenderQueue({ dir: path.join(dir, 'queue'), agents, mayServe: defaultMayServe, push: client.pushAdapter, log: quiet });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(client.enabled(), true);
    // anna's computer is online: her job goes into the queue, no render node is asked
    const { code } = agents.createPairingCode('anna@example.com');
    const { agent } = agents.pair({ code, ip: '10.0.0.1', name: 'Annas Mac' });
    assert.equal(await queue.poll(agent, { waitMs: 0 }), null);
    const assetDir = path.join(dir, 'assets');
    fs.mkdirSync(assetDir);
    fs.writeFileSync(path.join(assetDir, 'clip.mp4'), 'clip');
    const files = { files: [{ filename: 'upload-001.mp4', path: path.join(assetDir, 'clip.mp4'), size: 4 }], totalBytes: 4 };
    state.running = true; // the render node is busy: the job waits for the computer
    const queued = await client.submit(HTML, 'draft', files, 'landscape', 24, { owner: 'Anna@Example.com', label: 'Film' });
    assert.equal(queued.nodeId, QUEUE_NODE_ID);
    assert.match(queued.jobId, /^rq-[a-z0-9]+-[0-9a-f]{8}$/);
    assert.equal((await client.jobStatus(queued.jobId, QUEUE_NODE_ID)).status, 'pending');
    await assert.rejects(client.download(queued.jobId, QUEUE_NODE_ID), (err) => err instanceof RenderNodeError && /pending|queued/.test(err.message));
    assert.equal(client.whereOf(queued.jobId, QUEUE_NODE_ID), null, 'waiting: no name yet');
    const job = await queue.poll(agent, { waitMs: 0 });
    assert.equal(job.jobId, queued.jobId);
    assert.equal(client.whereOf(queued.jobId, QUEUE_NODE_ID), 'Annas Mac');
    await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
    assert.equal((await client.jobStatus(queued.jobId, QUEUE_NODE_ID)).status, 'completed');
    assert.deepEqual(await client.download(queued.jobId, QUEUE_NODE_ID), MP4);
    assert.ok(log.every((entry) => entry.path === '/health'), 'only the status of the render node was read, nothing was sent to it');
    // a job of somebody without a computer takes the old way
    const direct = await client.submit(HTML, 'draft', files, 'landscape', 24, { owner: 'ben@example.com' });
    assert.equal(direct.nodeId, 'node-1');
    const directRequests = log.filter((entry) => entry.path !== '/health').map((entry) => ({ ...entry }));
    // the same job through the queue: the render node, free again, takes it and gets exactly the same requests
    log.length = 0;
    state.running = false;
    const viaQueue = await queue.enqueue({ html: HTML, quality: 'draft', assetFiles: files, resolution: 'landscape', fps: 24, owner: 'anna@example.com' });
    for (let i = 0; i < 20 && !log.some((entry) => entry.path === '/render'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const queueRequests = log.filter((entry) => entry.path !== '/health');
    assert.deepEqual(queueRequests, directRequests, 'a job from the queue reaches the render node exactly like a direct one');
    state.done = true;
    await queue.watchPush();
    assert.equal(queue.status(viaQueue.jobId).status, 'completed');
    assert.equal(queue.status(viaQueue.jobId).nodeName, 'Node 1');
    // errors of the queue come back as RenderNodeError
    await assert.rejects(client.jobStatus('rq-nope0000-00000000', QUEUE_NODE_ID), (err) => err instanceof RenderNodeError && err.status === 404);
  } finally {
    clearInterval(keepAlive);
    queue.stop();
    delete process.env.AUTH_WHOAMI_URL;
  }
}

function testAvailability() {
  const none = createRenderNodeClient({ store: { listNodes: () => [] }, env: {}, fetchImpl: async () => json({}) });
  assert.equal(none.enabled(), false);
  assert.equal(none.pollable(), false);
  const withComputer = createRenderNodeClient({ store: { listNodes: () => [] }, env: {}, fetchImpl: async () => json({}), agentsCount: () => 1 });
  assert.equal(withComputer.enabled(), true, 'a paired computer offers the render tool');
  assert.equal(withComputer.pollable(), true);
  const openJobs = createRenderNodeClient({ store: { listNodes: () => [] }, env: {}, fetchImpl: async () => json({}), queue: { hasOpenJobs: () => true } });
  assert.equal(openJobs.enabled(), false);
  assert.equal(openJobs.pollable(), true, 'jobs of a removed computer are still watched');
}

async function main() {
  await testUnchangedWithoutComputer();
  await testQueuePath();
  testAvailability();
  console.log('Verteilung: ohne passenden Rechner Byte für Byte wie vor WP46, mit Rechner über die Warteschlange, ein Render-Node bekommt Aufträge aus der Warteschlange wie direkte.');
  console.log('test-render-agent-dispatch.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
