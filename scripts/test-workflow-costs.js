'use strict';

// The total a workflow has cost over all its runs (lib/nodes/workflow-costs.js): only the journal lines of its backing
// session count, grouped by kind and by model, largest first. No server, no provider.

const assert = require('assert/strict');
const { summariseWorkflowCosts, MAX_MODELS } = require('../lib/nodes/workflow-costs');

const line = (sessionId, type, model, cost, ts, extra = {}) => ({ ts, sessionId, type, model, cost, user: 'a@example.com', ...extra });

const entries = [
  line('s1', 'image', 'img-a', 0.1, '2026-03-02T08:00:00.000Z'),
  line('s1', 'image', 'img-a', 0.2, '2026-03-01T08:00:00.000Z'),
  line('s1', 'image', 'img-b', 0.05, '2026-03-05T08:00:00.000Z'),
  line('s1', 'video', 'vid-a', 3, '2026-03-04T08:00:00.000Z', { credits: 2200 }),
  line('s1', 'brain', 'llm-a', 0, '2026-03-03T08:00:00.000Z'),
  line('s2', 'video', 'vid-a', 50, '2026-03-03T08:00:00.000Z'),
  line('s1', 'video', 'vid-a', -1, '2026-03-03T08:00:00.000Z'),
  line('s1', 'video', 'vid-a', Number.NaN, '2026-03-03T08:00:00.000Z'),
  null
];

const sum = summariseWorkflowCosts(entries, 's1');
assert.equal(sum.totalUsd, 3.35);
assert.equal(sum.count, 5);
assert.equal(sum.credits, 2200);
assert.equal(sum.firstAt, '2026-03-01T08:00:00.000Z');
assert.equal(sum.lastAt, '2026-03-05T08:00:00.000Z');
assert.deepEqual(sum.byType, [
  { type: 'video', usd: 3, count: 1 },
  { type: 'image', usd: 0.35, count: 3 },
  { type: 'brain', usd: 0, count: 1 }
]);
assert.deepEqual(sum.byModel.map((row) => [row.model, row.type, row.usd, row.count]), [
  ['vid-a', 'video', 3, 1],
  ['img-a', 'image', 0.3, 2],
  ['img-b', 'image', 0.05, 1],
  ['llm-a', 'brain', 0, 1]
]);

// nothing booked, no session, no journal: an empty total, never an error
for (const empty of [summariseWorkflowCosts(entries, 'unknown'), summariseWorkflowCosts(entries, ''), summariseWorkflowCosts(null, 's1')]) {
  assert.deepEqual(empty, { totalUsd: 0, credits: 0, count: 0, firstAt: null, lastAt: null, byType: [], byModel: [] });
}

// many models: the list is capped, the total is not
const many = Array.from({ length: MAX_MODELS + 5 }, (_, index) => line('s1', 'image', `m${index}`, 1, '2026-03-01T08:00:00.000Z'));
const capped = summariseWorkflowCosts(many, 's1');
assert.equal(capped.byModel.length, MAX_MODELS);
assert.equal(capped.totalUsd, MAX_MODELS + 5);

console.log('test-workflow-costs.js: ok');
