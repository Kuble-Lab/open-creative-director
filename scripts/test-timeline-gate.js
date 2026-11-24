'use strict';

const assert = require('assert/strict');
const { fixture } = require('./support/timeline');
const engineLib = require('../lib/nodes/engine');
const budget = require('../lib/budget');
const registry = require('../lib/nodes/registry');

async function main() {
  const f = await fixture();
  const originalBegin = budget.beginRun;
  let reservations = 0;
  budget.beginRun = async () => { reservations++; throw new Error('No reservation expected'); };
  try {
    const original = f.registry.get('t.cut');
    const oldDef = { ...original, params: original.params.filter((param) => param.id !== 'review') };
    for (const review of ['off', 'required']) assert.equal(engineLib.computeCacheKey(original, { review }, {}), engineLib.computeCacheKey(oldDef, {}, {}));
    for (const type of ['music_video.edit', 'explainer.edit', 'video.concat', 'event_video.cut']) {
      const def = registry.get(type), previous = { ...def, params: def.params.filter((param) => param.id !== 'review') };
      const expected = engineLib.computeCacheKey(previous, registry.normalizeParams(previous, {}), {});
      for (const review of ['off', 'required']) assert.equal(engineLib.computeCacheKey(def, registry.normalizeParams(def, { review }), {}), expected, `${type}: review never changes the existing key`);
    }
    const first = await f.run({ mode: 'node', nodeIds: ['make'] });
    assert.equal(first.nodes.make.status, 'done');
    assert.equal(original.params.find((param) => param.id === 'review').default, 'off');
    await f.edit((graph) => { graph.nodes.find((node) => node.id === 'cut').params.review = 'required'; });
    let plan = await f.engine.plan(f.id);
    assert.equal(plan.nodes.cut.reasonCode, 'TIMELINE_REVIEW_OPEN');
    assert.deepEqual(plan.nodes.cut.reasonData, { open: 2, total: 2 });
    assert.equal(plan.nodes.down.executions, 0);
    assert.equal(plan.totals.usd, 0);
    await assert.rejects(f.engine.start(f.id), { code: 'TIMELINE_REVIEW_OPEN', data: { open: 2, total: 2 } });
    assert.deepEqual(f.calls, { make: 2, cut: 0, down: 0 });
    assert.equal(reservations, 0);
    const noDependency = engineLib.createEngine({ store: f.store, registry: f.registry });
    await assert.rejects(noDependency.start(f.id), { code: 'TIMELINE_REVIEW_OPEN' });
    const viewer = { active: false };
    await f.service.setReviews(viewer, f.id, 'cut', { kind: 'clip', status: 'approved' });
    plan = await f.engine.plan(f.id);
    assert.equal(plan.nodes.cut.status, 'stale');
    let record = await f.run();
    assert.equal(record.nodes.cut.status, 'done');
    assert.equal(record.nodes.down.status, 'done');
    assert.equal(f.calls.cut, 1);
    await f.service.setReviews(viewer, f.id, 'cut', { keys: ['clip:0', 'clip:1'], status: 'open' });
    assert.equal((await f.engine.plan(f.id)).nodes.cut.status, 'cached', 'existing film stays cached with open approvals');
    record = await f.run();
    assert.equal(record.nodes.cut.status, 'cached');
    assert.equal(f.calls.cut, 1);
    // Fresh upstream results must override the old approved assets, using the real review store and locks.
    await f.service.setReviews(viewer, f.id, 'cut', { kind: 'clip', status: 'approved' });
    await f.edit((graph) => { graph.nodes.find((node) => node.id === 'source').params.token = 'replacement'; });
    record = await f.run();
    assert.equal(record.nodes.cut.status, 'error');
    assert.equal(record.nodes.cut.code, 'TIMELINE_REVIEW_OPEN');
    assert.deepEqual(record.nodes.cut.data, { open: 2, total: 2 });
    assert.equal(record.nodes.down.status, 'skipped');
    assert.equal(record.accounting.bookedUsd, 0);
    assert.equal(record.accounting.reservedUsd, 0);
    assert.equal(record.accountingAttempts.length, 0, 'no paid executor was entered');
    assert.equal(f.calls.cut, 1);
    await f.edit((graph) => { delete graph.nodes.find((node) => node.id === 'cut').params.review; });
    record = await f.run();
    assert.equal(record.nodes.cut.status, 'done', 'default off ignores approvals');
  } finally {
    budget.beginRun = originalBegin;
    await f.cleanup();
  }
  console.log('test-timeline-gate.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
