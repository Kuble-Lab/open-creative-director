'use strict';

// Exercise the same fixtures without sockets, including on hosts without Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFixture } = require('./support/browser-fixture');
const { initializeBrowserDocument, waitFor } = require('./support/browser');
const vm = require('node:vm');

async function main() {
  const script = `(${initializeBrowserDocument.toString()})()`;
  const window = {};
  window.top = window;
  const writes = [];
  vm.runInNewContext(script, { window, localStorage: { setItem: (...args) => writes.push(args) } });
  assert.deepEqual(writes, [['vcd-lang', 'en']], 'the app document starts in English');
  const sandbox = { window: { top: window } };
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('Opaque frame storage is inaccessible'); } });
  assert.doesNotThrow(() => vm.runInNewContext(script, sandbox), 'preview frames never access storage');
  assert.throws(() => vm.runInNewContext(script, { window, localStorage: { setItem() { throw new Error('Storage failure'); } } }),
    /Storage failure/, 'real app initialization failures remain visible');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocd-browser-fixture-'));
  let fixture;
  try {
    fixture = await createFixture(temp, { listen: false });
    const presets = require('../lib/prompt-presets').listPresets();
    assert(presets.length > 0, 'the isolated shell can load its built-in prompt presets');
    assert.deepEqual(presets, JSON.parse(await fs.readFile(path.resolve(__dirname, '../config/prompt-presets.json'), 'utf8')));
    const { workflow, engine, calls, gates, store } = fixture;
    const id = await workflow({ approval: true, uploads: true });
    const preview = { mode: 'node', nodeIds: ['preview-out'] };
    const plan = await engine.plan(id, preview);
    assert.equal(plan.valid, true, JSON.stringify(plan.issues));
    const first = await engine.start(id, preview);
    const result = await engine.whenFinished(id, first);
    assert.equal(result.status, 'completed');
    assert.equal(result.cost.usd, 1.25);
    assert.deepEqual(calls, ['preview']);
    assert.equal((await engine.plan(id, preview)).nodes['preview-out'].status, 'cached');
    const second = await engine.start(id, { mode: 'node', nodeIds: ['final'] });
    await waitFor(() => gates.has('gate'), 'second stage gate');
    assert(engine.cancel(id, second));
    assert.equal((await engine.whenFinished(id, second)).status, 'cancelled');
    assert(!calls.includes('after'));
    const failedId = await workflow({ key: 'failure' });
    const failedRun = await engine.start(failedId, { mode: 'all' });
    await waitFor(() => gates.has('failure'), 'failure gate');
    gates.get('failure').finish('Synthetic reconnect failure');
    const failed = await engine.whenFinished(failedId, failedRun);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.cost.usd, 1.25);
    assert.match(failed.nodes.gate.message, /Synthetic reconnect failure/);
    assert.equal((await store.readRun(failedId, failedRun)).status, 'failed');
    const cardId = await workflow({ cards: true });
    const cardStep = { mode: 'node', nodeIds: ['board'] };
    const cardPlan = await engine.plan(cardId, cardStep);
    assert.equal(cardPlan.valid, true, JSON.stringify(cardPlan.issues));
    const cardRun = await engine.start(cardId, cardStep);
    assert.equal((await engine.whenFinished(cardId, cardRun)).status, 'completed');
    const saved = await store.getWorkflow(cardId);
    const source = require('../lib/event-video/card-preview').previewSource(saved.workflow, saved.results, 'render');
    assert.equal(require('../lib/event-video/card-preview').buildPreviews(source.graphics).previews.length, 3);
    assert.deepEqual(calls.slice(-1), ['card-plan'], 'approval fixture never executes the render');
  } finally {
    if (fixture) await fixture.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log('test-browser-fixture.js: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
