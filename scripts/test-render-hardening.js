'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { createRenderNodeClient } = require('../lib/rendernode');
const { createRenderQueue } = require('../lib/render-queue');
const { createAgent, withContentSecurityPolicy } = require('../render-node/agent');
const ffmpeg = require('../lib/ffmpeg');
const { validateRenderResult } = require('../lib/render-result');
const MP4 = require('./support/render-test-video');
const quiet = { warn() {} };
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-hardening-'));
  const queues = [];
  const make = (options = {}) => {
    const queue = createRenderQueue({ dir: path.join(base, `queue-${queues.length}`), log: quiet, ...options });
    queues.push(queue);
    return queue;
  };
  try {
    // B1: CSP precedes executable markup, preserving an existing doctype.
    for (const prefix of ['', '<html>', '<head>', '<html><head>', '<!doctype html>', '<!doctype html><html><head>']) {
      const out = withContentSecurityPolicy(`${prefix}<script>x()</script><meta charset="utf-8">`);
      assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<script>'));
      assert.ok(out.indexOf('Content-Security-Policy') < out.lastIndexOf('<meta charset'));
      assert.equal(out.startsWith('<!doctype html>'), prefix.startsWith('<!doctype html>'));
    }

    const commented = '<!-- comment --><!doctype html><script>x()</script>';
    assert.ok(withContentSecurityPolicy(commented).startsWith('<!-- comment --><!doctype html><meta'));
    const escaped = '<!-- --!><script>x()</script><!-- --><!doctype html>';
    assert.ok(withContentSecurityPolicy(escaped).startsWith('<meta'));
    assert.ok(withContentSecurityPolicy('<!doctype html "><script>x()</script>" >').startsWith('<meta'));
    const quoted = '<!doctype html SYSTEM "a>b"><script>x()</script>';
    assert.ok(withContentSecurityPolicy(quoted).startsWith('<!doctype html SYSTEM "a>b"><meta'));

    // B7: exercise the exact shell guard without executing any installer or download.
    for (const name of ['install.sh', 'cloud-image.sh']) {
      const source = fs.readFileSync(path.join(__dirname, '../render-node', name), 'utf8');
      const guard = source.match(/server_protocols\(\) \{[\s\S]*?\n\}/)[0];
      const check = (url, allow = '') => execFileSync('bash', ['-c', `${guard}\nserver_protocols "$1" || printf REFUSED`, '_', url], {
        env: { ...process.env, RENDER_AGENT_ALLOW_HTTP: allow }, encoding: 'utf8'
      });
      for (const url of ['http://example.com', 'http://127.0.0.1.example.com', 'http://localhost@example.com', 'ftp://localhost']) {
        assert.equal(check(url), 'REFUSED');
      }
      assert.equal(check('https://example.com'), '=https');
      for (const url of ['http://localhost:3000', 'http://127.2.3.4', 'http://[::1]:3000']) assert.equal(check(url), '=http,https');
      assert.equal(check('http://example.com', 'true'), '=http,https');
      for (const line of source.split('\n').filter((line) => /^\s*(if ! )?curl /.test(line))) {
        assert.match(line, /--proto /);
        assert.match(line, /--proto-redir =https/);
      }
      assert.ok(source.indexOf('protocols="$(server_protocols') < source.indexOf('if ! curl'));
    }
    const ps = fs.readFileSync(path.join(__dirname, '../render-node/install.ps1'), 'utf8');
    assert.ok(ps.indexOf('[Uri]::TryCreate') < ps.indexOf('Invoke-WebRequest'));
    assert.match(ps, /Invoke-WebRequest -MaximumRedirection 0/);
    assert.match(ps, /RENDER_AGENT_ALLOW_HTTP/);

    // B9: metadata write failure never acknowledges or exposes the job, even after restart.
    const queue = make();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.endsWith('job.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    try {
      await assert.rejects(queue.enqueue({ html: '<main>x</main>' }), (err) => err.code === 'PERSIST_FAILED' && err.status === 500);
    } finally {
      fs.renameSync = rename;
    }
    assert.deepEqual(queue.snapshot(), []);
    assert.deepEqual(fs.readdirSync(path.join(base, 'queue-0')), []);

    // B10: repeated delivery errors have their own cap; the deadline survives errors and restart.
    let at = 1800000000000;
    let sends = 0;
    const push = {
      listNodes: () => [{ id: 'node', name: 'Node' }],
      nodeStatus: async () => ({ online: true, running: false, queue: 0 }),
      sendJob: async () => { sends += 1; throw new Error('response lost'); },
      resetStatusCache() {}
    };
    const limited = make({ now: () => at, push, limits: { maxPushAttempts: 2, pushCooldownMs: 1, jobDeadlineMs: 1000 } });
    const job = await limited.enqueue({ html: '<main>x</main>' });
    await limited.dispatch();
    await pause();
    at += 2;
    await limited.dispatch();
    await pause();
    assert.equal(sends, 2);
    assert.equal(limited.status(job.jobId).status, 'failed');
    assert.equal(limited.snapshot()[0].pushTries, 2);
    const pending = make({ now: () => at, push, limits: { maxPushAttempts: 10, pushCooldownMs: 100, jobDeadlineMs: 50 } });
    const second = await pending.enqueue({ html: '<main>x</main>' });
    await pending.dispatch();
    await pause();
    const deadline = pending.snapshot()[0].deadlineAt;
    pending.stop();
    const restored = make({ dir: path.join(base, 'queue-2'), now: () => at, push });
    assert.equal(restored.snapshot()[0].deadlineAt, deadline);
    at = deadline + 1;
    await restored.sweep();
    assert.equal(restored.status(second.jobId).status, 'failed');

    // B12: ffprobe checks video and duration, with an explicit fallback when unavailable.
    const file = path.join(base, 'result.mp4');
    await fsp.writeFile(file, MP4);
    if (ffmpeg.binaries().ffprobe) {
      await validateRenderResult(file);
      await fsp.writeFile(file, Buffer.from('0000ftyp'));
      await assert.rejects(validateRenderResult(file));
    }
    const binaries = ffmpeg.binaries;
    const probeVideo = ffmpeg.probeVideo;
    try {
      ffmpeg.binaries = () => ({ ffprobe: 'fake' });
      for (const probe of [{ video: {}, duration: 1 }, { video: { codec: 'h264', width: 16, height: 16 }, duration: 0 }]) {
        ffmpeg.probeVideo = async () => probe;
        await assert.rejects(validateRenderResult(file), /Videostream/);
      }
      ffmpeg.binaries = () => ({ ffprobe: null });
      const warnings = [];
      await validateRenderResult(file, { log: { warn: (line) => warnings.push(line) } });
      assert.equal(warnings.length, 1);
      ffmpeg.binaries = () => ({ ffprobe: 'fake' });
      ffmpeg.probeVideo = async () => { throw new Error('invalid video'); };
      const agent = { id: 'agent', owner: 'owner', name: 'Agent' };
      const invalid = make({ mayServe: () => 0 });
      await invalid.enqueue({ html: '<main>x</main>', owner: 'owner' });
      const lease = await invalid.poll(agent, { waitMs: 0 });
      await assert.rejects(invalid.acceptResult(agent, lease.jobId, lease.lease, Readable.from([Buffer.from('0000ftyp')])), /invalid video/);
      assert.equal(invalid.snapshot()[0].failures, 1);
      assert.notEqual(invalid.status(lease.jobId).status, 'completed');
      const direct = createRenderNodeClient({
        store: { listNodes: () => [{ id: 'node', name: 'Node', url: 'https://example.com', token: 'test', enabled: true }] },
        env: {}, fetchImpl: async () => new Response(Buffer.from('0000ftyp'))
      });
      await assert.rejects(direct.download('remote-job', 'node'), /invalid video/);
      const invalidPush = make({ push: {
        ...push, sendJob: async () => 'remote-job',
        jobStatus: async () => ({ status: 'completed' }),
        download: async () => Buffer.from('0000ftyp')
      } });
      await invalidPush.enqueue({ html: '<main>x</main>' });
      await invalidPush.dispatch();
      await pause();
      await invalidPush.watchPush();
      assert.equal(invalidPush.snapshot()[0].failures, 1);
      assert.notEqual(invalidPush.snapshot()[0].status, 'completed');
      invalidPush.stop();
    } finally {
      ffmpeg.binaries = binaries;
      ffmpeg.probeVideo = probeVideo;
    }

    // B8: a body that never ends is still bounded after headers; job cancellation stops it too.
    const agentBase = path.join(base, 'agent');
    await fsp.mkdir(path.join(agentBase, 'template'), { recursive: true });
    await fsp.writeFile(path.join(agentBase, 'template/hyperframes.json'), '{}');
    for (const mode of ['timeout', 'cancel', 'lease', 'preaborted']) {
      let cancelled = false;
      let rendered = false;
      let agent;
      const jobId = 'rq-abcdef12-01234567';
      const lease = 'a'.repeat(32);
      agent = createAgent({
        base: agentBase, noCaffeinate: true, log() {}, assetTimeoutMs: mode === 'timeout' ? 25 : 5000,
        credentials: { server: 'https://example.com', token: 'test' },
        executor: async () => { rendered = true; },
        fetchImpl: async (url) => {
          if (url.includes('/assets/')) {
            if (mode === 'cancel') setTimeout(() => agent.running.get(lease).controller.abort(), 25);
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
          }
          if (mode === 'lease' && url.endsWith('/progress') && agent.running.get(lease)?.downloadStarted) {
            return new Response(JSON.stringify({ error: 'lease lost' }), { status: 409 });
          }
          if (url.endsWith('/progress')) {
            agent.running.get(lease).downloadStarted = true;
            if (mode === 'preaborted') agent.running.get(lease).controller.abort();
          }
          return new Response('{}');
        }
      });
      await agent.handleJob({ jobId, lease, html: '<main>x</main>', heartbeatMs: 2000, assets: [{ filename: 'a.mp4', size: 10 }] });
      assert.equal(rendered, false);
      assert.equal(cancelled, mode !== 'preaborted', mode);
      assert.equal(agent.running.size, 0);
    }
    console.log('test-render-hardening.js: ok');
  } finally {
    for (const queue of queues) queue.stop();
    await fsp.rm(base, { recursive: true, force: true });
  }
}

const keepAlive = setInterval(() => {}, 1000);
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
