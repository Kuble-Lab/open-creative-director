'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createRenderQueue } = require('../lib/render-queue');
const { createRenderNodeClient } = require('../lib/rendernode');
const { createRenderService, defaultRenderExecutor } = require('../render-node/service');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const html = '<html>render</html>';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-cancel-'));
  const queues = [];
  let service;
  const queue = (name, push = null) => {
    const q = createRenderQueue({ dir: path.join(root, name), mayServe: () => 0, push, log: { warn() {} } });
    queues.push(q);
    return q;
  };
  try {
    const q = queue('agent');
    const control = new AbortController();
    const other = new AbortController();
    const first = await q.enqueue({ html, signal: control.signal, owner: 'owner', group: 'film' });
    const second = await q.enqueue({ html, signal: control.signal, owner: 'owner', group: 'film' });
    const kept = await q.enqueue({ html, signal: other.signal, owner: 'other', group: 'film' });
    const agent = { id: 'agent', name: 'Computer', owner: 'owner' };
    const lease = await q.poll(agent, { waitMs: 0 });
    control.abort();
    for (const { jobId } of [first, second]) {
      assert.equal(q.status(jobId).code, 'CANCELLED');
      assert.equal(q.status(jobId).status, 'failed');
    }
    assert.equal(q.status(kept.jobId).status, 'pending', 'same group in another scope stays open');
    assert.throws(() => q.progress(agent, lease.jobId, lease.lease, { progress: 0.2 }), { code: 'LEASE_LOST' });
    await assert.rejects(q.acceptResult(agent, lease.jobId, lease.lease, Readable.from(['late'])), { code: 'LEASE_LOST' });
    await assert.rejects(q.enqueue({ html, signal: control.signal }), { name: 'AbortError' });
    const interruptedLease = await q.poll(agent, { waitMs: 0 });
    assert.equal(interruptedLease.jobId, kept.jobId);
    const restored = queue('agent');
    assert.equal(restored.status(first.jobId).code, 'CANCELLED', 'cancellation survives restart');
    assert.equal((await restored.demand()).queued.length, 0);
    assert.equal(restored.status(kept.jobId).code, 'CANCELLED', 'live execution is interrupted on restart');
    assert.throws(() => restored.progress(agent, kept.jobId, interruptedLease.lease, {}), { code: 'LEASE_LOST' });
    // Independent chat/MCP jobs, including old records without executionScope,
    // keep both queued work and active leases across an application restart.
    for (const legacy of [false, true]) {
      const name = `independent-${legacy}`;
      const independent = queue(name);
      const running = await independent.enqueue({ html, group: 'chat' });
      const liveLease = await independent.poll(agent, { waitMs: 0 });
      const waiting = await independent.enqueue({ html, group: 'mcp' });
      const scoped = await independent.enqueue({ html, signal: new AbortController().signal });
      independent.stop();
      for (const job of [running, waiting]) {
        const file = path.join(root, name, job.jobId, 'job.json');
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(record.executionScope, null);
        if (legacy) {
          delete record.executionScope;
          fs.writeFileSync(file, JSON.stringify(record));
        }
      }
      const resumed = queue(name);
      assert.equal(resumed.status(scoped.jobId).code, 'CANCELLED', 'only scoped work is interrupted');
      assert.equal(resumed.status(waiting.jobId).status, 'pending');
      resumed.progress(agent, running.jobId, liveLease.lease, { progress: 0.5 });
      await resumed.acceptResult(agent, running.jobId, liveLease.lease,
        Readable.from([require('./support/render-test-video')]));
      assert.equal(resumed.status(running.jobId).status, 'completed', 'active independent lease survives');
      const nextLease = await resumed.poll(agent, { waitMs: 0 });
      assert.equal(nextLease.jobId, waiting.jobId, 'queued independent work is still dispatched');
      await resumed.acceptResult(agent, waiting.jobId, nextLease.lease,
        Readable.from([require('./support/render-test-video')]));
      assert.equal(resumed.status(waiting.jobId).status, 'completed');
    }

    const sending = deferred();
    const sent = deferred();
    const cancels = [];
    const push = {
      listNodes: () => [{ id: 'push', name: 'Push' }],
      nodeStatus: async () => ({ online: true, running: false, queue: 0 }),
      sendJob: async () => { sent.resolve(); return sending.promise; },
      cancel: async (...args) => { cancels.push(args); },
      resetStatusCache() {}
    };
    const pushing = queue('push', push);
    const scope = new AbortController();
    const submitted = await pushing.enqueue({ html, signal: scope.signal });
    await sent.promise;
    scope.abort();
    sending.resolve('remote-1');
    await tick(); await tick();
    assert.deepEqual(cancels, [['remote-1', 'push']], 'abort while submitting cancels the late remote id');
    assert.equal(pushing.status(submitted.jobId).code, 'CANCELLED');

    let retryNow = Date.now();
    let failures = 0;
    const retrySent = deferred();
    const retryPush = { ...push, sendJob: async () => { retrySent.resolve(); return 'retry-remote'; }, cancel: async () => {
      failures += 1;
      if (failures === 1) throw new Error('network unavailable');
      return { supported: true };
    } };
    const retryDir = path.join(root, 'retry');
    const retryQueue = createRenderQueue({ dir: retryDir, mayServe: () => 0, push: retryPush, now: () => retryNow, log: { warn() {} } });
    queues.push(retryQueue);
    const retryJob = await retryQueue.enqueue({ html });
    await retryQueue.dispatch(); await retrySent.promise; await tick();
    retryQueue.cancel(retryJob.jobId);
    await tick();
    assert.equal(failures, 1);
    retryQueue.stop();
    retryNow += 6000;
    const retryRestored = createRenderQueue({ dir: retryDir, mayServe: () => 0, push: retryPush, now: () => retryNow });
    queues.push(retryRestored);
    await retryRestored.sweep();
    assert.equal(failures, 2, 'pending remote cancellation retries after restart');
    const savedRetry = JSON.parse(fs.readFileSync(path.join(retryDir, retryJob.jobId, 'job.json')));
    assert.equal(savedRetry.pendingCancellations[0].outcome, 'cancelled');

    for (const legacy of [true, false]) {
      const requests = [];
      const client = createRenderNodeClient({
        store: { listNodes: () => [{ id: 'n', name: 'Node', url: 'https://render.example', token: 'test', enabled: true }] },
        env: {},
        fetchImpl: async (url, options) => {
          requests.push([url, options.method]);
          if (url.endsWith('/health')) return { ok: true, json: async () => ({ ok: true }) };
          if (url.endsWith('/render')) return { ok: true, json: async () => ({ jobId: 'remote' }) };
          if (url.endsWith('/cancel')) return legacy
            ? { ok: false, status: 404, text: async () => 'Not found' }
            : { ok: true, json: async () => ({ status: 'cancelled' }) };
          throw new Error('Unexpected request ' + url);
        }
      });
      const abort = new AbortController();
      const job = await client.submit(html, 'standard', undefined, undefined, undefined, { signal: abort.signal });
      abort.abort();
      await tick();
      assert.equal((await client.jobStatus(job.jobId, job.nodeId)).code, 'CANCELLED');
      await assert.rejects(client.download(job.jobId, job.nodeId), /cancelled/);
      assert.ok(requests.some(([url, method]) => url.endsWith('/cancel') && method === 'POST'));
    }

    const stagedAbort = new AbortController();
    let renderPosts = 0;
    const uploadClient = createRenderNodeClient({
      store: { listNodes: () => [] }, env: {},
      fetchImpl: async (url) => {
        if (url.endsWith('/uploads')) {
          stagedAbort.abort();
          return { ok: true, json: async () => ({ uploadId: 'upload' }) };
        }
        renderPosts += 1;
        throw new Error('No submission after cancellation');
      }
    });
    await assert.rejects(uploadClient.pushAdapter.sendJob({ id: 'n', url: 'https://render.example', token: 'test' },
      { streamingUploads: true }, { html, quality: 'standard', assetFiles: { totalBytes: 1, files: [{ filename: 'a.mp4', path: '/unused', size: 1 }] } },
      { canSubmit: () => !stagedAbort.signal.aborted }), { name: 'AbortError' });
    assert.equal(renderPosts, 0, 'an aborted upload never starts rendering');

    const routed = queue('routed');
    const client = createRenderNodeClient({ store: { listNodes: () => [] }, queue: routed, env: {} });
    const abort = new AbortController();
    const job = await client.submit(html, 'standard', undefined, undefined, undefined, { signal: abort.signal });
    assert.equal(job.nodeId, 'render-queue', 'signal-bearing submissions use the persistent queue even without agents');
    abort.abort();
    assert.equal((await client.jobStatus(job.jobId, job.nodeId)).code, 'CANCELLED');

    const started = deferred();
    const stopped = deferred();
    const release = deferred();
    let executions = 0;
    service = createRenderService({ base: path.join(root, 'service'), token: 'test',
      templateDir: path.resolve(__dirname, '../render-node/template'),
      renderExecutor: async ({ signal }) => {
        executions += 1;
        signal.addEventListener('abort', () => stopped.resolve(), { once: true });
        started.resolve();
        await release.promise;
        signal.throwIfAborted();
      }
    });
    const request = async (method, url, body, authenticated = true) => {
      const req = Readable.from(body ? [JSON.stringify(body)] : []);
      Object.assign(req, { method, url, headers: { authorization: authenticated ? 'Bearer test' : '' } });
      let status, result;
      await service.handle(req, { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } });
      return { status, ...result };
    };
    assert.equal((await request('GET', '/health')).cancellation, true);
    const active = await request('POST', '/render', { html });
    await started.promise;
    const waiting = await request('POST', '/render', { html });
    assert.equal((await request('POST', `/jobs/${active.jobId}/cancel`, null, false)).status, 401);
    assert.equal((await request('POST', `/jobs/${waiting.jobId}/cancel`)).status, 'cancelled');
    assert.equal((await request('POST', `/jobs/${active.jobId}/cancel`)).status, 'cancelled');
    await stopped.promise;
    release.resolve();
    for (let i = 0; i < 100 && (await request('GET', '/health')).running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await request('GET', '/health')).running, false, 'executor has settled before cleanup');
    assert.equal((await request('GET', `/jobs/${active.jobId}`)).status, 'cancelled');
    assert.equal(executions, 1, 'cancelled waiting render never starts');
    assert.equal((await request('GET', `/jobs/${active.jobId}/file`)).status, 409);
    assert.equal((await request('POST', `/jobs/${active.jobId}/cancel`)).status, 'cancelled', 'idempotent cancel');
    const completed = queue('completed');
    const doneAbort = new AbortController();
    const done = await completed.enqueue({ html, signal: doneAbort.signal });
    const doneLease = await completed.poll(agent, { waitMs: 0 });
    await completed.acceptResult(agent, done.jobId, doneLease.lease, Readable.from([require('./support/render-test-video')]));
    doneAbort.abort();
    assert.equal(completed.status(done.jobId).status, 'completed', 'completed results survive later cancellation');

    // A real process tree; the child ignores SIGTERM and must be killed by escalation.
    const shim = path.join(root, 'renderer.cjs');
    const descendantPid = path.join(root, 'descendant.pid');
    fs.writeFileSync(shim, `const child = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', ${JSON.stringify(descendantPid)}], { stdio: 'ignore' }); const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(descendantPid)})) { clearInterval(timer); console.log('ready'); } }, 10); setInterval(() => {}, 1000);`);
    const processAbort = new AbortController();
    await assert.rejects(defaultRenderExecutor({ base: root, hyperframesBin: shim, dir: root,
      out: path.join(root, 'unused.mp4'), quality: 'draft', signal: processAbort.signal,
      onOutput: () => processAbort.abort() }), /Render-Exit/);
    const pid = Number(fs.readFileSync(descendantPid, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'detached-output descendant is killed after leader close');
    console.log('test-render-cancellation.js: ok');
  } finally {
    for (const q of queues) q.stop();
    if (service) await service.close();
    await tick();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
