'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMonitor } = require('../lib/admin-monitoring');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocd-monitor-atomic-'));
  const file = path.join(directory, 'errors.json');
  const original = { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename };
  const warn = console.warn;
  const now = Date.parse('2026-10-01T12:00:00Z');
  let scheduled;
  const monitor = createMonitor({ file, now: () => now, setTimer: (fn) => { scheduled = fn; return 1; }, clearTimer: () => { scheduled = null; } });
  const row = (index) => ({ ts: new Date(now).toISOString(), user: 'test@example.com', index });
  try {
    // Pause a read after it has obtained the old disk state; a flush must not open a visibility gap.
    monitor.recordError(row(0));
    const entered = deferred();
    const release = deferred();
    fs.readFile = async (...args) => {
      fs.readFile = original.readFile;
      let result, error;
      try { result = await original.readFile(...args); } catch (caught) { error = caught; }
      entered.resolve();
      await release.promise;
      if (error) throw error;
      return result;
    };
    const reading = monitor.readErrors();
    await entered.promise;
    const flushing = monitor.flush();
    release.resolve();
    assert.deepEqual(await reading, [row(0)]);
    await flushing;

    // Arrivals during a write and simultaneous flush calls must retain each row exactly once.
    const writing = deferred();
    const finishWrite = deferred();
    fs.writeFile = async (...args) => { writing.resolve(); await finishWrite.promise; return original.writeFile(...args); };
    monitor.recordError(row(1));
    const first = monitor.flush();
    await writing.promise;
    monitor.recordError(row(2));
    const second = monitor.flush();
    const during = monitor.readErrors();
    finishWrite.resolve();
    await Promise.all([first, second]);
    fs.writeFile = original.writeFile;
    assert.deepEqual((await during).map((entry) => entry.index), [0, 1, 2]);

    console.warn = () => {};
    for (const method of ['writeFile', 'rename', 'readFile']) {
      monitor.recordError(row(3));
      fs[method] = async (...args) => {
        if (method === 'writeFile') await original.writeFile(...args);
        throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
      };
      await monitor.flush();
      fs[method] = original[method];
      assert.equal(monitor.runtime().journalWritable, false);
      assert.equal((await monitor.readErrors()).at(-1).index, 3, `${method}: failed batch stays visible`);
      assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
      await monitor.flush();
      assert.equal(monitor.runtime().journalWritable, true);
    }
    assert.deepEqual((await monitor.readErrors()).map((entry) => entry.index), [0, 1, 2, 3, 3, 3]);
    await fs.writeFile(file, '{broken');
    monitor.recordError(row(4));
    await monitor.flush();
    assert.equal(await fs.readFile(file, 'utf8'), '{broken', 'a corrupt journal is not silently replaced');
    await fs.writeFile(file, '[]');
    await monitor.flush();
    assert.deepEqual(await monitor.readErrors(), [row(4)]);
    for (let index = 0; index < 200; index += 1) monitor.recordError({ ...row(index), user: `user${index % 4}@example.com` });
    fs.rename = async () => { throw new Error('disk unavailable'); };
    await monitor.flush();
    fs.rename = original.rename;
    assert.equal(typeof scheduled, 'function', 'a failed flush schedules a retry without new traffic');
    monitor.recordError(row(999));
    assert.equal(monitor.runtime().droppedErrors, 1, 'failed writes do not create an unbounded retry buffer');
    assert.equal(typeof scheduled, 'function', 'even a full buffer schedules a retry on new traffic');
    await scheduled();
    assert.equal((await monitor.readErrors()).length, 201);
    assert.equal(monitor.runtime().journalWritable, true);

    // Drive only the scheduled callbacks: retries must recover without requests or manual flushes.
    const timers = new Map();
    let timerId = 0;
    const retryFile = path.join(directory, 'retry.json');
    const retryMonitor = createMonitor({
      file: retryFile, now: () => now, flushMs: 40,
      setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
      clearTimer: (id) => timers.delete(id)
    });
    async function fireTimer(expectedDelay) {
      assert.equal(timers.size, 1, 'exactly one flush timer is pending');
      const [id, { fn, delay }] = timers.entries().next().value;
      assert.equal(delay, expectedDelay);
      timers.delete(id);
      await fn();
    }
    retryMonitor.recordError(row(5));
    let attempts = 0;
    fs.rename = async () => { attempts += 1; throw new Error('temporarily unavailable'); };
    await fireTimer(40);
    assert.equal(attempts, 1);
    assert.equal(retryMonitor.runtime().journalWritable, false);
    assert.deepEqual(await retryMonitor.readErrors(), [row(5)]);
    for (const delay of [40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960, 60000, 60000]) {
      await fireTimer(delay);
    }
    assert.equal(attempts, 14, 'each timer makes exactly one attempt with capped backoff');
    fs.rename = original.rename;
    await fireTimer(60000);
    assert.deepEqual(JSON.parse(await fs.readFile(retryFile, 'utf8')), [row(5)]);
    assert.equal(retryMonitor.runtime().journalWritable, true);
    assert.equal(timers.size, 0, 'successful retry stops the retry loop');
    retryMonitor.recordError(row(6));
    await fireTimer(40);
    fs.rename = async () => { throw new Error('another outage'); };
    retryMonitor.recordError(row(7));
    await fireTimer(40);
    fs.rename = original.rename;
    await fireTimer(40);
    assert.deepEqual(JSON.parse(await fs.readFile(retryFile, 'utf8')), [row(5), row(6), row(7)]);
    assert.equal(timers.size, 0, 'success resets the backoff for a later outage');
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    Object.assign(fs, original);
    console.warn = warn;
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('test-monitoring-atomic.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
