'use strict';

const assert = require('assert/strict');
const { fixture } = require('./support/timeline');
const { createTimelineService, REWRITE_SYSTEM } = require('../lib/timeline/service');
const access = require('../lib/access');
const or = require('../lib/openrouter');
const budget = require('../lib/budget');
const costs = require('../lib/costs');
const { textValue } = require('../lib/nodes/types');

async function main() {
  let modelCalls = 0, onComplete = null;
  const f = await fixture({ notes: true, complete: async (options) => {
    modelCalls++;
    assert.equal(options.model, 'anthropic/claude-fable-5.2');
    assert.equal(options.system, REWRITE_SYSTEM);
    const input = JSON.parse(options.prompt);
    assert.equal(input.kind, 'clip');
    assert.equal(input.duration, 2);
    assert.equal(input.line, 'Line 0');
    assert.deepEqual(input.neighbours, [null, 'a second']);
    if (onComplete) await onComplete();
    return { text: 'The rewritten prompt' };
  } });
  const viewer = { active: false };
  const currentRev = async () => (await f.store.readWorkflow(f.id)).rev;
  const feedback = (text, rev) => f.service.feedback(viewer, f.id, 'cut', 'clip:0', { text, rev });
  try {
    await f.run({ mode: 'selection', nodeIds: ['make', 'notes'] });
    const before = JSON.stringify((await f.store.readWorkflow(f.id)).graph);
    let result = await feedback('   ', await currentRev());
    assert.deepEqual(result.runRequest, { mode: 'items', nodeId: 'make', items: [0] });
    assert.equal(result.prompt, 'a first');
    assert.equal(JSON.stringify((await f.store.readWorkflow(f.id)).graph), before);
    assert.equal(modelCalls, 0);
    const oldRev = await currentRev();
    result = await feedback('Show the subject closer', oldRev);
    assert.equal(result.rev, oldRev + 1);
    assert.equal(result.prompt, 'The rewritten prompt');
    assert.deepEqual(result.runRequest, { mode: 'items', nodeId: 'make', items: [0] });
    let graph = (await f.store.readWorkflow(f.id)).graph;
    assert.deepEqual(graph.nodes.find((node) => node.id === 'make').itemEdits, { prompt: { 0: { text: 'The rewritten prompt', was: 'a first' } } });
    assert.equal(graph.nodes.find((node) => node.id === 'notes').itemEdits, undefined);
    let history = (await f.store.timelineReviews.read(f.id)).nodes.cut['clip:0'];
    assert.equal(history.status, 'open');
    assert.deepEqual(history.feedback[0], { text: 'Show the subject closer', by: 'lokal', at: history.feedback[0].at, was: 'a first', prompt: 'The rewritten prompt' });
    const count = modelCalls;
    await assert.rejects(feedback('Stale revision', oldRev), { code: 'REV_CONFLICT' });
    assert.equal(modelCalls, count, 'conflicts are rejected before a model call');
    result = await f.service.feedback(viewer, f.id, 'cut', 'clip:2', { text: 'Speak more slowly', rev: await currentRev() });
    assert.deepEqual(result.runRequest, { mode: 'items', nodeId: 'notes', items: [0] });
    graph = (await f.store.readWorkflow(f.id)).graph;
    assert.equal(graph.nodes.find((node) => node.id === 'notes').params.feedback.s1, 'Speak more slowly');
    assert.equal(modelCalls, count, 'notes do not call the model');
    const originalBusy = f.engine.isBusy;
    f.engine.isBusy = () => true;
    await assert.rejects(feedback('During run', await currentRev()), { code: 'RUN_ACTIVE' });
    assert.equal(modelCalls, count);
    f.engine.isBusy = originalBusy;
    onComplete = () => f.edit((draft) => { draft.nodes.find((node) => node.id === 'source').label = 'Changed elsewhere'; });
    const historyLength = (await f.store.timelineReviews.read(f.id)).nodes.cut['clip:0'].feedback.length;
    await assert.rejects(feedback('Conflict during model call', await currentRev()), { code: 'REV_CONFLICT' });
    assert.equal((await f.store.timelineReviews.read(f.id)).nodes.cut['clip:0'].feedback.length, historyLength);
    onComplete = () => { f.engine.isBusy = () => true; };
    await assert.rejects(feedback('Run starts during model call', await currentRev()), { code: 'RUN_ACTIVE' });
    f.engine.isBusy = originalBusy;
    onComplete = null;
    await feedback('Revise the edited prompt', await currentRev());
    graph = (await f.store.readWorkflow(f.id)).graph;
    assert.equal(graph.nodes.find((node) => node.id === 'make').itemEdits.prompt[0].was, 'a first', 'a second rewrite keeps the original upstream anchor');
    const outsider = access.viewerOf({ kubleUser: 'outsider@example.com' }, { AUTH_WHOAMI_URL: 'https://whoami.invalid' });
    await assert.rejects(f.service.feedback(outsider, f.id, 'cut', 'clip:0', { text: 'No access', rev: await currentRev() }), { code: 'WORKFLOW_NOT_FOUND' });
    for (const request of [{ text: 'x' }, { text: 3, rev: 1 }, { text: 'x'.repeat(8001), rev: 1 }]) {
      await assert.rejects(f.service.feedback(viewer, f.id, 'cut', 'clip:0', request), { code: 'INVALID_REQUEST' });
    }
    assert.equal(f.calls.cut, 0);
    assert.equal(f.calls.down, 0, 'feedback never starts a paid run');
    const invalidAnswer = createTimelineService({ store: f.store, registry: f.registry, runEngine: f.engine,
      resolveAsset: async (value) => value, complete: async () => ({ text: '' }) });
    const unchangedRev = await currentRev();
    await assert.rejects(invalidAnswer.feedback(viewer, f.id, 'cut', 'clip:0', { text: 'Try again', rev: unchangedRev }), { code: 'TIMELINE_BAD_ANSWER' });
    assert.equal(await currentRev(), unchangedRev);
    await assert.rejects(f.service.setReviews(viewer, f.id, 'cut', { keys: ['clip:0'], kind: 'clip', status: 'open' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.service.setReviews(viewer, f.id, 'cut', { keys: ['__proto__'], status: 'open' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.service.setReviews(viewer, f.id, 'cut', { keys: ['unknown'], status: 'open' }), { code: 'INVALID_REQUEST' });
    // A scalar broadcast input has no prompt that can be rewritten per item.
    let savedTexts;
    await f.store.updateResults(f.id, (results) => {
      const source = results.nodes.source;
      const variant = source.history.find((entry) => entry.id === source.selected.entry).variants[source.selected.variant];
      savedTexts = variant.texts;
      variant.texts = textValue('A broadcast prompt');
    });
    await assert.rejects(feedback('No mapped prompt', await currentRev()), { code: 'TIMELINE_FEEDBACK_UNAVAILABLE' });
    await f.store.updateResults(f.id, (results) => {
      const source = results.nodes.source;
      source.history.find((entry) => entry.id === source.selected.entry).variants[source.selected.variant].texts = savedTexts;
    });

    // Exercise the normal LLM adapter with only its provider transport replaced: booking and budget checks stay in place.
    const original = { postJson: or.postJson, begin: budget.begin, recordCost: costs.recordCost };
    const journal = [], grants = [];
    let released = 0;
    try {
      or.postJson = async (_route, payload) => {
        assert.equal(payload.model, 'anthropic/claude-fable-5.2');
        return { choices: [{ message: { content: 'Booked rewrite' } }], usage: { cost: 0.037 } };
      };
      budget.begin = async (who, options) => { grants.push({ who, options }); return { release: () => { released++; } }; };
      costs.recordCost = async (entry) => { journal.push(entry); };
      const booked = createTimelineService({ store: f.store, registry: f.registry, resolveAsset: async (value) => value });
      await booked.feedback({ active: false, email: 'participant@example.com' }, f.id, 'cut', 'clip:0', { text: 'Change camera', rev: await currentRev() });
      assert.equal(grants.length, 1);
      assert.ok(grants[0].options.estimateUsd > 0);
      assert.equal(released, 1);
      assert.equal(journal.length, 1);
      assert.equal(journal[0].type, 'brain');
      assert.equal(journal[0].sessionId, (await f.store.readWorkflow(f.id)).sessionId);
      assert.equal(journal[0].user, 'participant@example.com');
      assert.equal(journal[0].cost, 0.037);
      budget.begin = async () => { throw Object.assign(new Error('Budget exhausted'), { code: 'BUDGET_EXHAUSTED' }); };
      await assert.rejects(booked.feedback(viewer, f.id, 'cut', 'clip:0', { text: 'Over budget', rev: await currentRev() }), { code: 'BUDGET_EXHAUSTED' });
      assert.equal(journal.length, 1);
    } finally { Object.assign(or, { postJson: original.postJson }); budget.begin = original.begin; costs.recordCost = original.recordCost; }
  } finally { await f.cleanup(); }
  console.log('test-timeline-feedback.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
