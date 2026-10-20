'use strict';

// Queue attribution, engine events/records and viewer filtering; no provider calls.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { createIsolatedApp } = require('./support/isolated-app');
const run = require('../public/nodes/run');
const { renderStatus, publicStatus } = require('../lib/nodes/render-status');
const MP4 = require('./support/render-test-video');

function pure() {
  const jobs = new Map();
  jobs.set('a', { status: 'running', nodeName: 'Cloud Display' });
  jobs.set('b', { status: 'queued' });
  assert.deepEqual(renderStatus(jobs), { phase: 'rendering', names: ['Cloud Display'] });
  jobs.set('a', { status: 'completed', nodeName: 'Cloud Display' });
  assert.equal(renderStatus(jobs), null, 'queued chunks do not claim the whole film finished');
  jobs.set('b', { status: 'completed', nodeName: 'Workstation' });
  const render = renderStatus(jobs);
  assert.deepEqual(render.names, ['Cloud Display', 'Workstation']);
  const record = { nodes: { n: { render } } };
  for (const viewer of [{ active: false }, { admin: true }, { kind: 'internal' }]) assert.deepEqual(publicStatus(record, viewer), record);
  for (const viewer of [{ kind: 'participant' }, { kind: 'guest' }, null]) {
    const filtered = publicStatus(record, viewer);
    assert.deepEqual(filtered.nodes.n.render, { phase: 'completed', count: 2 });
    assert.ok(!JSON.stringify(filtered).includes('Workstation'));
  }
  assert.deepEqual(record.nodes.n.render.names, ['Cloud Display', 'Workstation'], 'filtering never mutates shared records');
  const snapshot = { type: 'snapshot', activeRun: { nodeRenders: { n: render, idle: null } } };
  assert.deepEqual(publicStatus(snapshot, { kind: 'guest' }).activeRun.nodeRenders, { n: { phase: 'completed', count: 2 }, idle: null });
  for (const [index, lang] of ['de', 'en', 'es'].entries()) {
    const { rows } = require('../public/nodes/i18n-nodes');
    const T = (key, data) => rows.find((row) => row[0] === key)[index + 1].replace(/\{(\w+)\}/g, (_, k) => data[k]);
    assert.ok(run.renderText(render, T).includes('Cloud Display'), lang);
    assert.ok(!run.renderText({ phase: 'completed', count: 1 }, T).includes('Cloud Display'), lang);
  }

  let state = run.reduce(run.createRunState(), { type: 'node_status', runId: 'r', nodeId: 'n', status: 'waiting_job', render: { phase: 'rendering', names: ['Cloud Display'] } });
  state = run.reduce(state, { type: 'node_status', runId: 'r', nodeId: 'n', status: 'done', render });
  assert.deepEqual(state.nodes.n.render, render);
  assert.deepEqual(run.restoreRun(run.createRunState(), { id: 'r', status: 'completed', nodes: { n: { status: 'done', render } } }).nodes.n.render, render);
  const snap = run.reduce(run.createRunState(), { type: 'snapshot', activeRun: { runId: 'r', nodes: { n: 'waiting_job' }, nodeRenders: { n: render } } });
  assert.deepEqual(snap.nodes.n.render, render, 'reconnecting clients receive attribution');
  state = run.reduce(state, { type: 'node_status', runId: 'r', nodeId: 'n', status: 'error' });
  assert.equal(state.nodes.n.render, undefined);
  state = run.reduce(state, { type: 'node_status', runId: 'new', nodeId: 'n', status: 'running' });
  assert.equal(state.nodes.n.render, undefined, 'a fresh run clears attribution');
  const tr = (key, data) => `${key}:${data.name || data.n}`;
  assert.equal(run.renderText({ phase: 'completed', count: 2 }, tr), 'nodes.render.completed:nodes.render.computer:1, nodes.render.computer:2');
}

async function main() {
  pure();
  const isolated = await createIsolatedApp({ active: false });
  let queue;
  try {
    const { createRenderQueue } = isolated.load('lib/render-queue');
    const { createRenderAgentsStore } = isolated.load('lib/render-agents');
    const { defaultMayServe } = isolated.load('lib/rendernode');
    const { createRegistry } = isolated.load('lib/nodes/registry');
    const { createEventBus } = isolated.load('lib/nodes/events');
    const { createWorkflowsStore } = isolated.load('lib/nodes/workflows-store');
    const { createEngine } = isolated.load('lib/nodes/engine');
    const { textValue } = isolated.load('lib/nodes/types');
    const agents = createRenderAgentsStore({ file: path.join(isolated.root, 'data', 'test-agents.json') });
    const { code } = agents.createPairingCode('lokal');
    const agent = agents.pair({ code, ip: '127.0.0.1', name: 'Cloud Display', versions: { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0' } }).agent;
    queue = createRenderQueue({ dir: path.join(isolated.root, 'data', 'test-queue'), agents, mayServe: defaultMayServe });
    const bus = createEventBus();
    const registry = createRegistry();
    const received = [];
    let engine;
    registry.register({ type: 't.render', category: 'video', outputs: [{ id: 'out', type: 'text' }], execute: async (ctx) => {
      await queue.enqueue({ html: '<html>render</html>', owner: 'lokal', onStatus: ctx.toolCtx.onRenderStatus });
      const job = await queue.poll(agent, { waitMs: 0 });
      assert.ok(job);
      assert.deepEqual(engine.activeRun(ctx.workflowId).nodeRenders.n, { phase: 'rendering', names: ['Cloud Display'] });
      await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
      assert.deepEqual(queue.status(job.jobId).nodeName, 'Cloud Display');
      return { variants: [{ out: textValue('done') }] };
    } });
    const store = createWorkflowsStore({ dir: path.join(isolated.root, 'data', 'test-workflows'), registry, events: bus });
    engine = createEngine({ store, registry, events: bus });
    const { workflow } = await store.createWorkflow({ name: 'Render status', graph: { nodes: [{ id: 'n', type: 't.render', typeVersion: 1, x: 0, y: 0, params: {} }], edges: [] } });
    bus.subscribe(workflow.id, (event) => received.push(event));
    const id = await engine.start(workflow.id, { mode: 'all' });
    const record = await engine.whenFinished(workflow.id, id);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    assert.deepEqual(record.nodes.n.render, { phase: 'completed', names: ['Cloud Display'] });
    assert.deepEqual((await store.readRun(workflow.id, id)).nodes.n.render, record.nodes.n.render);
    assert.ok(received.some((event) => event.type === 'node_status' && event.render?.phase === 'rendering'));
    assert.ok(received.some((event) => event.status === 'done' && event.render?.phase === 'completed'));
    const changes = [];
    const cancelled = await queue.enqueue({ html: '<html>x</html>', owner: 'lokal', onStatus: (event) => changes.push(event) });
    await queue.poll(agent, { waitMs: 0 });
    queue.cancel(cancelled.jobId);
    assert.equal(changes[0].status, 'queued');
    assert.ok(changes.some((event) => event.status === 'running' && event.nodeName === 'Cloud Display'));
    assert.equal(changes.at(-1).status, 'cancelled');
    const length = changes.length;
    queue.cancel(cancelled.jobId);
    assert.equal(changes.length, length, 'terminal observers are removed');
    const saved = JSON.parse(fs.readFileSync(path.join(isolated.root, 'data', 'test-queue', cancelled.jobId, 'job.json')));
    assert.equal(saved.onStatus, undefined);
    // Observer failures must never stop queue submissions or leak into persisted job data.
    const broken = await queue.enqueue({ html: '<html>x</html>', owner: 'lokal', onStatus() { throw new Error('UI observer'); } });
    queue.cancel(broken.jobId);
    assert.equal(queue.snapshot().find((job) => job.id === broken.jobId).onStatus, undefined);
    console.log('test-nodes-render-status.js: ok');
  } finally {
    queue?.stop();
    await isolated.cleanup();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
