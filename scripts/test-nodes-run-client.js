'use strict';

// Run UX of the node view: the pure part of public/nodes/run.js (SSE reducer for every event type,
// results helpers, cost formatting, plan description, displayed status) and static checks of the
// browser wiring (preview.js and run.js are loaded, the pure module also runs without a DOM).

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const run = require('../public/nodes/run');

const root = path.resolve(__dirname, '..');
const T0 = 1_000_000;

function apply(state, events, start = T0) {
  let now = start;
  for (const event of events) {
    state = run.reduce(state, event, now);
    now += 100;
  }
  return state;
}

/* ---------- reducer ---------- */

function testSnapshot() {
  let state = run.createRunState();
  assert.equal(run.reduce(state, { type: 'snapshot', activeRun: null }, T0), state, 'no run and no active run: unchanged');

  state = run.reduce(state, { type: 'snapshot', activeRun: { runId: 'r1', mode: 'all', nodes: { a: 'done', b: 'running', c: 'queued' } } }, T0);
  assert.equal(state.active, true);
  assert.equal(state.runId, 'r1');
  assert.equal(state.mode, 'all');
  assert.equal(state.nodes.a.status, 'done');
  assert.equal(state.nodes.b.status, 'running');
  assert.equal(state.nodes.b.startedAt, T0, 'a running node seen in a snapshot starts its timer now');
  assert.equal(state.nodes.c.startedAt, undefined);

  // a later snapshot of the same run keeps timers and adds progress
  const later = run.reduce(state, { type: 'snapshot', activeRun: { runId: 'r1', mode: 'all', nodes: { a: 'done', b: 'waiting_job', c: 'running' } } }, T0 + 5000);
  assert.equal(later.nodes.b.status, 'waiting_job');
  assert.equal(later.nodes.b.startedAt, T0, 'the timer of b survives');
  assert.equal(later.nodes.c.startedAt, T0 + 5000);

  // reconnect after the run ended: snapshot says no run -> finished + resync request
  const ended = run.reduce(later, { type: 'snapshot', activeRun: null }, T0 + 9000);
  assert.equal(ended.active, false);
  assert.equal(ended.status, 'finished');
  assert.equal(ended.resync, true, 'the client has to reload results');
  assert.equal(run.clearResync(ended).resync, false);
  assert.equal(run.reduce(ended, { type: 'snapshot', activeRun: null }, T0 + 9500).resync, true, 'still flagged until cleared');
  assert.equal(run.reduce(run.clearResync(ended), { type: 'snapshot', activeRun: null }, T0 + 9500).resync, false);

  // a snapshot with another run id replaces the tracked run
  const other = run.reduce(later, { type: 'snapshot', activeRun: { runId: 'r2', mode: 'node', nodes: { z: 'running' } } }, T0 + 10000);
  assert.equal(other.runId, 'r2');
  assert.deepEqual(Object.keys(other.nodes), ['z']);
}

function testRunStartedAndNodeStatus() {
  let state = run.reduce(run.createRunState(), { type: 'run_started', runId: 'r1', mode: 'all', targets: ['c'], plan: { a: 'stale', b: 'cached', c: 'forced' } }, T0);
  assert.equal(state.active, true);
  assert.deepEqual(state.targets, ['c']);
  assert.deepEqual(Object.keys(state.nodes).sort(), ['a', 'b', 'c']);
  assert.ok(Object.values(state.nodes).every((node) => node.status === 'queued'));
  assert.deepEqual(run.progressOf(state), { done: 0, total: 3 });

  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'running' }, T0 + 100);
  assert.equal(state.nodes.a.status, 'running');
  assert.equal(state.nodes.a.startedAt, T0 + 100);
  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'waiting_job' }, T0 + 900);
  assert.equal(state.nodes.a.startedAt, T0 + 100, 'waiting for the provider keeps the start time');
  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'running', progress: { done: 1, total: 4 } }, T0 + 1000);
  assert.deepEqual(state.nodes.a.progress, { done: 1, total: 4 });
  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'done' }, T0 + 2000);
  assert.equal(state.nodes.a.status, 'done');
  assert.equal(state.nodes.a.endedAt, T0 + 2000);
  assert.equal(state.nodes.a.progress, undefined, 'progress is dropped when a node finishes');

  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'b', status: 'cached' }, T0 + 2100);
  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'c', status: 'error', message: 'provider said no' }, T0 + 2200);
  assert.equal(state.nodes.c.message, 'provider said no');
  assert.deepEqual(run.progressOf(state), { done: 3, total: 3 });
  assert.deepEqual(run.activeNodeIds(state), []);

  // a repeated run_started of the same run does not reset statuses (POST response after the SSE event)
  const again = run.reduce(state, { type: 'run_started', runId: 'r1', mode: 'all', targets: ['c'], plan: { a: 'stale', b: 'cached', c: 'forced', d: 'stale' } }, T0 + 3000);
  assert.equal(again.nodes.a.status, 'done');
  assert.equal(again.nodes.d.status, 'queued');

  // skipped keeps its message, other statuses drop stale messages
  const skipped = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'd', status: 'skipped', message: 'blocked by c' }, T0 + 3100);
  assert.equal(skipped.nodes.d.message, 'blocked by c');
  const retried = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'c', status: 'running' }, T0 + 3100);
  assert.equal(retried.nodes.c.message, undefined);
}

function testNewRunAndMissedStart() {
  // events of an unknown run start tracking it (missed run_started, e.g. another tab started the run)
  let state = run.reduce(run.createRunState(), { type: 'node_status', runId: 'r7', nodeId: 'x', status: 'running' }, T0);
  assert.equal(state.runId, 'r7');
  assert.equal(state.active, true);
  assert.equal(state.nodes.x.status, 'running');

  // a different run id resets the previous run
  state = run.reduce(state, { type: 'node_status', runId: 'r8', nodeId: 'y', status: 'queued' }, T0 + 50);
  assert.equal(state.runId, 'r8');
  assert.deepEqual(Object.keys(state.nodes), ['y']);
}

function testLogCostResultFinish() {
  let state = run.reduce(run.createRunState(), { type: 'run_started', runId: 'r1', mode: 'all', targets: [], plan: { a: 'stale', b: 'stale' } }, T0);
  for (let i = 0; i < 40; i += 1) state = run.reduce(state, { type: 'node_log', runId: 'r1', nodeId: 'a', label: `step ${i}` }, T0 + i);
  assert.equal(state.logs.a.length, 30, 'log is capped');
  assert.equal(state.logs.a[29], 'step 39');
  assert.equal(run.reduce(state, { type: 'node_log', runId: 'r1', label: 'x' }, T0), state, 'a log without node is ignored');

  state = run.reduce(state, { type: 'run_cost', runId: 'r1', usd: 0.0188, credits: 4 }, T0 + 100);
  assert.deepEqual(state.cost, { usd: 0.0188, credits: 4 });
  state = run.reduce(state, { type: 'run_cost', runId: 'r1', usd: 0.05 }, T0 + 110);
  assert.deepEqual(state.cost, { usd: 0.05, credits: 0 });

  state = run.reduce(state, { type: 'node_result', runId: 'r1', nodeId: 'a', entry: { id: 'h-1', variants: [] } }, T0 + 120);
  assert.equal(state.nodes.a.entryId, 'h-1');
  assert.equal(run.reduce(state, { type: 'node_result', runId: 'r1', nodeId: 'a' }, T0), state, 'a result without entry is ignored');

  state = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'running' }, T0 + 130);
  state = run.reduce(state, { type: 'run_finished', runId: 'r1', status: 'cancelled' }, T0 + 500);
  assert.equal(state.active, false);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.nodes.a.status, 'cancelled', 'unfinished nodes of a cancelled run become cancelled');
  assert.equal(state.nodes.b.status, 'cancelled');
  assert.equal(state.finishedAt, T0 + 500);

  const failed = run.reduce(run.reduce(run.createRunState(), { type: 'run_started', runId: 'r2', plan: { a: 'stale' } }, T0), { type: 'run_finished', runId: 'r2', status: 'failed', error: 'boom' }, T0 + 10);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');

  // events the reducer does not know leave the state as it is
  assert.equal(run.reduce(state, { type: 'workflow_saved', rev: 3 }, T0), state);
  assert.equal(run.reduce(state, null, T0), state);
  assert.equal(run.reduce(state, { nope: true }, T0), state);
}

function testEveryEventTypeCovered() {
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'engine.js'), 'utf8');
  const emitted = new Set([...source.matchAll(/type: '([a-z_]+)'/g)].map((match) => match[1]));
  for (const type of ['run_started', 'node_status', 'node_log', 'node_result', 'run_cost', 'run_finished']) assert.ok(emitted.has(type), `engine no longer emits ${type}`);
  const reducerSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'run.js'), 'utf8');
  for (const type of [...emitted, 'snapshot']) {
    if (['workflow_saved'].includes(type)) continue;
    assert.ok(reducerSource.includes(`case '${type}'`), `the reducer has no case for ${type}`);
  }
}

function testInFlight() {
  const state = apply(run.createRunState(), [
    { type: 'run_started', runId: 'r1', plan: { a: 1, b: 1, c: 1, d: 1 } },
    { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'running' },
    { type: 'node_status', runId: 'r1', nodeId: 'b', status: 'waiting_job' },
    { type: 'node_status', runId: 'r1', nodeId: 'c', status: 'running' }
  ]);
  const paid = new Set(['a']);
  assert.deepEqual(run.inFlightNodes(state, (id) => paid.has(id)).sort(), ['a', 'b'], 'waiting jobs and running paid nodes cannot be cancelled remotely');
  assert.deepEqual(run.inFlightNodes(state, () => false), ['b']);
  assert.deepEqual(run.activeNodeIds(state).sort(), ['a', 'b', 'c', 'd']);
}

/* ---------- results ---------- */

function entry(id, variants, extra = {}) {
  return { id, runId: 'r', createdAt: '2026-09-29T10:00:00.000Z', user: 'lokal', cacheKey: `k-${id}`, params: {}, variants, cost: { usd: 0.02 }, durationMs: 1200, ...extra };
}

const img = (n) => ({ type: 'image', sessionId: 's1', assetId: `img-00${n}`, file: `img-00${n}.png`, url: `/assets/s1/img-00${n}.png` });

function testResultsHelpers() {
  let results = { version: 1, nodes: {} };
  assert.equal(run.selectedEntry(results, 'n1'), null);
  assert.equal(run.selectedVariant(results, 'n1'), null);
  assert.equal(run.variantInfo(results, 'n1'), null);

  results = run.applyNodeResult(results, 'n1', entry('h1', [{ image: img(1) }, { image: img(2) }, { image: img(3) }]));
  assert.deepEqual(run.selectedRef(results, 'n1'), { entry: 'h1', variant: 0 });
  assert.equal(run.selectedVariant(results, 'n1').image.assetId, 'img-001');
  let info = run.variantInfo(results, 'n1');
  assert.equal(info.variantCount, 3);
  assert.equal(info.entryCount, 1);
  assert.equal(info.variantIndex, 0);

  // a second run: newest first, selected, the first stays in the history
  results = run.applyNodeResult(results, 'n1', entry('h2', [{ image: img(4) }]));
  assert.deepEqual(results.nodes.n1.history.map((item) => item.id), ['h2', 'h1']);
  assert.equal(run.variantInfo(results, 'n1').entryIndex, 0);
  assert.equal(run.variantInfo(results, 'n1').variantCount, 1);

  // the same entry twice (SSE event plus reload) is not duplicated
  const dup = run.applyNodeResult(results, 'n1', entry('h2', [{ image: img(4) }]));
  assert.equal(dup.nodes.n1.history.length, 2);

  // history cap
  let many = { version: 1, nodes: {} };
  for (let i = 0; i < 40; i += 1) many = run.applyNodeResult(many, 'n1', entry(`h${i}`, [{ image: img(1) }]));
  assert.equal(many.nodes.n1.history.length, run.MAX_HISTORY);
  assert.equal(many.nodes.n1.history[0].id, 'h39');

  // local selection is immutable
  const picked = run.applySelection(results, 'n1', 'h1', 2);
  assert.deepEqual(run.selectedRef(picked, 'n1'), { entry: 'h1', variant: 2 });
  assert.equal(run.selectedVariant(picked, 'n1').image.assetId, 'img-003');
  assert.deepEqual(run.selectedRef(results, 'n1'), { entry: 'h2', variant: 0 }, 'the original is untouched');
  assert.equal(run.applySelection(results, 'missing', 'h1', 0), results);

  // paging inside the selected entry
  assert.deepEqual(run.stepVariant(picked, 'n1', -1), { entry: 'h1', variant: 1 });
  assert.equal(run.stepVariant(picked, 'n1', 1), null, 'already at the last variant');
  const first = run.applySelection(results, 'n1', 'h1', 0);
  assert.equal(run.stepVariant(first, 'n1', -1), null, 'already at the first variant');
  assert.deepEqual(run.stepVariant(first, 'n1', 1), { entry: 'h1', variant: 1 });
  assert.equal(run.stepVariant(results, 'nope', 1), null);

  // server answer replaces the node
  const replaced = run.replaceNodeResults(picked, 'n1', { selected: { entry: 'h2', variant: 0 }, history: [] });
  assert.deepEqual(replaced.nodes.n1.selected, { entry: 'h2', variant: 0 });
  assert.equal(run.replaceNodeResults(null, 'n9', { selected: null, history: [] }).nodes.n9.history.length, 0);

  // a stale selection index is clamped when the entry has fewer variants
  const clamped = { version: 1, nodes: { n1: { selected: { entry: 'h', variant: 9 }, history: [entry('h', [{ image: img(1) }])] } } };
  assert.equal(run.variantInfo(clamped, 'n1').variantIndex, 0);
  assert.equal(run.selectedVariant(clamped, 'n1').image.assetId, 'img-001');
  info = run.variantInfo(results, 'n1');
  assert.equal(info.entryId, 'h2');
}

function testPreviewItems() {
  const variant = { image: img(1), mask: img(2), result: { type: 'list', of: 'any', items: [img(3)] } };
  const hidden = new Set(['result']);
  assert.deepEqual(run.previewItems(variant, ['image', 'mask', 'result'], hidden, false).map((item) => item.port), ['image', 'mask']);
  assert.deepEqual(run.previewItems(variant, ['image', 'mask', 'result'], hidden, true).map((item) => item.port), ['image', 'mask', 'result']);
  assert.deepEqual(run.previewItems({ b: img(1), a: img(2) }, ['a', 'b'], new Set(), false).map((item) => item.port), ['a', 'b'], 'port order wins');
  assert.deepEqual(run.previewItems(null, [], new Set(), false), []);
  const flat = run.flattenValues({ type: 'list', of: 'any', items: [img(1), { type: 'list', of: 'image', items: [img(2), { type: 'text', value: 'x' }] }] });
  assert.deepEqual(flat.map((value) => value.type), ['image', 'image', 'text']);
}

/* ---------- formatting ---------- */

function testFormatting() {
  assert.equal(run.formatDuration(0), '0s');
  assert.equal(run.formatDuration(4200), '4s');
  assert.equal(run.formatDuration(65_000), '1:05');
  assert.equal(run.formatDuration(3_723_000), '1:02:03');
  assert.equal(run.formatDuration(-5), '0s');
  assert.equal(run.formatDuration(undefined), '0s');
  assert.equal(run.formatUsd(0.0188), '$0.0188');
  assert.equal(run.formatUsd(0.5), '$0.50');
  assert.equal(run.formatUsd(0.0099), '$0.0099');
  assert.equal(run.formatUsd(NaN), '');
  assert.equal(run.formatCredits(12), '12');
  assert.equal(run.formatCredits(12.34), '12.3');
  assert.deepEqual(run.costParts({ usd: 0.0188, credits: null }), { usd: '$0.0188', credits: null });
  assert.deepEqual(run.costParts({ usd: 0, credits: 3 }), { usd: null, credits: '3' }, 'zero amounts are not shown');
  assert.deepEqual(run.costParts(null), { usd: null, credits: null });
  assert.deepEqual(run.costParts({ usd: 0, credits: 0 }), { usd: null, credits: null });
}

/* ---------- plan ---------- */

function testDescribePlan() {
  const plan = {
    valid: true,
    issues: [{ nodeId: 'p2', level: 'warning', message: 'needs PUBLIC_BASE_URL' }],
    nodes: {
      a: { status: 'cached', paid: false, estimate: null, executions: 1 },
      p1: { status: 'stale', paid: true, estimate: { usd: 0.05 }, executions: 2, lastCost: { usd: 0.05 } },
      p2: { status: 'forced', paid: true, estimate: null, executions: 1 },
      p3: { status: 'stale', paid: true, estimate: { credits: 6 }, executions: 1 },
      p4: { status: 'cached', paid: true, estimate: null, executions: 1 },
      p5: { status: 'stale', paid: true, estimate: { usd: 0.1 }, executions: null }
    },
    totals: { paidNodes: 4, usd: 0.1, credits: 6, unknownNodes: 2 }
  };
  const info = run.describePlan(plan, (id) => `T ${id}`);
  assert.equal(info.needsConfirm, true);
  assert.deepEqual(info.paid.map((row) => row.nodeId), ['p1', 'p2', 'p3', 'p5'], 'only paid nodes that will actually run');
  assert.equal(info.willRun, 4);
  assert.equal(info.paid[0].title, 'T p1');
  assert.equal(info.paid[0].usd, 0.1, 'estimate times executions');
  assert.equal(info.paid[0].unknown, false);
  assert.equal(info.paid[1].unknown, true, 'no estimate');
  assert.equal(info.paid[2].credits, 6);
  assert.equal(info.paid[3].unknown, true, 'unknown number of executions');
  assert.deepEqual(info.totals, plan.totals);
  assert.equal(info.warnings.length, 1);
  assert.equal(info.errors.length, 0);
  assert.equal(info.valid, true);

  const free = run.describePlan({ valid: true, issues: [], nodes: { a: { status: 'stale', paid: false, executions: 1 } }, totals: { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 } });
  assert.equal(free.needsConfirm, false);
  assert.equal(free.willRun, 1);

  const bad = run.describePlan({ valid: false, issues: [{ nodeId: 'x', level: 'error', message: 'missing' }], nodes: {}, totals: {} });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 1);
  assert.equal(run.describePlan(null).needsConfirm, false);

  // Participants: the plan carries the budget and the nodes blocked for the account.
  assert.equal(info.budget, null, 'no budget for everybody else');
  assert.deepEqual(info.blocked, []);
  assert.equal(run.gateOf(info), null, 'nothing in the way without a budget');
  const paidPlan = { valid: true, issues: [], nodes: { p1: { status: 'stale', paid: true, estimate: { usd: 1.5 }, executions: 1 } }, totals: { paidNodes: 1, usd: 1.5, credits: 0, unknownNodes: 0 } };
  const enough = run.describePlan({ ...paidPlan, budget: { remainingUsd: 4, estimateUsd: 1.5, enough: true } });
  assert.equal(enough.budget.remainingUsd, 4);
  assert.equal(run.gateOf(enough), null, 'enough budget: the normal confirmation follows');
  const exhausted = run.describePlan({ ...paidPlan, budget: { remainingUsd: 0, estimateUsd: 1.5, enough: false, code: 'BUDGET_EXHAUSTED' } });
  assert.equal(run.gateOf(exhausted).kind, 'exhausted');
  const insufficient = run.describePlan({ ...paidPlan, budget: { remainingUsd: 1, estimateUsd: 1.5, enough: false, code: 'BUDGET_INSUFFICIENT' } });
  assert.equal(run.gateOf(insufficient).kind, 'insufficient');
  assert.equal(run.gateOf(insufficient).budget.remainingUsd, 1);
  const blocked = run.describePlan({ ...paidPlan, blocked: [{ nodeId: 'h1', feature: 'higgsfield' }], budget: { remainingUsd: 0, enough: false, code: 'BUDGET_EXHAUSTED' } });
  assert.equal(run.gateOf(blocked).kind, 'blocked', 'blocked nodes come first');
  assert.deepEqual([...run.gateOf(blocked).nodeIds], ['h1']);
  const T = (key, vars) => `${key} ${JSON.stringify(vars || {})}`;
  const money = (value) => `$${value.toFixed(2)}`;
  assert.match(run.budgetLine(enough, T, money), /confirm\.budget .*"remaining":"\$4\.00".*"estimate":"\$1\.50"/, 'the confirmation names what is left and the estimate');
  assert.match(run.budgetLine(run.describePlan({ ...paidPlan, budget: { remainingUsd: 4, estimateUsd: 0, enough: true } }), T, money), /confirm\.budgetUnknown/, 'no estimate: only what is left');
  assert.equal(run.budgetLine(info, T, money), null, 'no line without a budget');
}

function testDisplayStatus() {
  const d = run.displayStatus;
  assert.deepEqual(d({ run: { status: 'running' }, planNode: { status: 'stale' }, hasResults: true, category: 'image' }), { status: 'running' }, 'live status wins');
  assert.deepEqual(d({ run: { status: 'queued' } }), { status: 'queued' });
  assert.deepEqual(d({ run: { status: 'error', message: 'boom' }, planNode: { status: 'stale' } }), { status: 'error', message: 'boom' }, 'errors stay until the next run');
  assert.deepEqual(d({ run: { status: 'skipped', message: 'blocked by a' } }), { status: 'skipped', message: 'blocked by a' });
  assert.deepEqual(d({ run: { status: 'cancelled' } }), { status: 'cancelled', message: null });
  assert.deepEqual(d({ run: { status: 'done' }, planNode: { status: 'stale' }, hasResults: true, category: 'image' }), { status: 'stale' }, 'a later edit marks a finished node stale');
  assert.deepEqual(d({ run: { status: 'done' }, planNode: { status: 'cached' }, hasResults: true, category: 'image' }), { status: 'done' });
  assert.deepEqual(d({ run: { status: 'cached' }, planNode: null, hasResults: true, category: 'image' }), { status: 'cached' });
  assert.deepEqual(d({ planNode: { status: 'stale' }, hasResults: false, category: 'image' }), { status: 'notrun' });
  assert.deepEqual(d({ planNode: { status: 'forced' }, hasResults: true, category: 'llm' }), { status: 'stale' });
  assert.deepEqual(d({ planNode: { status: 'stale' }, hasResults: false, category: 'input' }), { status: null }, 'input nodes carry no stale badge');
  assert.deepEqual(d({ planNode: { status: 'cached' }, hasResults: true, category: 'image' }), { status: null }, 'unchanged results need no badge');
  assert.deepEqual(d({ planNode: { status: 'invalid', reason: 'prompt missing' }, category: 'image' }), { status: 'invalid', message: 'prompt missing' });
  assert.deepEqual(d({ planNode: { status: 'invalid', reason: 'html: not html', reasonCode: 'not_html', reasonData: { width: 1920 } }, category: 'video' }), { status: 'invalid', message: 'html: not html', code: 'not_html', data: { width: 1920 } }, 'the cause code and data pass through for the translated text');
  assert.deepEqual(d({ planNode: { status: 'unavailable', reason: 'no key' }, category: 'image' }), { status: 'unavailable', message: 'no key' });
  assert.deepEqual(d({}), { status: null });
}

// The values behind a failed node (WP30): the engine sends err.data with the stable code; the card shows the translated text.
function testErrorData() {
  const rejected = { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'error', message: 'Rejected', code: 'MUSIC_PROMPT_REJECTED', data: { suggestion: 'calm piano' } };
  let state = run.reduce(run.createRunState(), { type: 'run_started', runId: 'r1', mode: 'all', targets: ['a'], plan: { a: 'stale' } }, T0);
  state = run.reduce(state, rejected, T0 + 10);
  assert.equal(state.nodes.a.code, 'MUSIC_PROMPT_REJECTED');
  assert.deepEqual(state.nodes.a.data, { suggestion: 'calm piano' });
  // the display status carries the data on to the translated text
  assert.deepEqual(run.displayStatus({ run: state.nodes.a }), { status: 'error', message: 'Rejected', code: 'MUSIC_PROMPT_REJECTED', data: { suggestion: 'calm piano' } });
  const texts = [];
  const ui = { hasIssueText: (code) => code === 'MUSIC_PROMPT_REJECTED', issueText: (issue) => { texts.push(issue); return `text of ${issue.code}`; } };
  const localized = run.localizeError(run.displayStatus({ run: state.nodes.a }), ui);
  assert.equal(localized.message, 'text of MUSIC_PROMPT_REJECTED');
  assert.deepEqual(texts[0].data, { suggestion: 'calm piano' }, 'the values reach issueText');
  // data without a code, a code without data, and data that is no object are not kept
  const noCode = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'error', message: 'x', data: { a: 1 } }, T0 + 20);
  assert.equal(noCode.nodes.a.data, undefined);
  const noData = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'error', message: 'x', code: 'ELEVENLABS_TIMEOUT' }, T0 + 20);
  assert.equal(noData.nodes.a.data, undefined);
  assert.equal(run.displayStatus({ run: noData.nodes.a }).data, undefined);
  const bad = run.reduce(state, { ...rejected, data: 'text' }, T0 + 20);
  assert.equal(bad.nodes.a.data, undefined);
  // a new attempt clears the cause with the rest
  const again = run.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'a', status: 'running' }, T0 + 30);
  assert.equal(again.nodes.a.code, undefined);
  assert.equal(again.nodes.a.data, undefined);
}

// "Use as text": which result the command can take over, and why not (WP30).
function testTextResultOf() {
  const text = (value) => ({ type: 'text', value });
  const outputs = [{ id: 'plan' }, { id: 'extra' }];
  assert.deepEqual(run.textResultOf({ plan: text('[A | 10 s]') }, outputs), { reason: 'ok', port: 'plan', text: '[A | 10 s]' });
  assert.deepEqual(run.textResultOf(null, outputs), { reason: 'none' }, 'no result yet');
  assert.deepEqual(run.textResultOf({ plan: { type: 'audio', url: '/a.mp3' } }, outputs), { reason: 'none' }, 'media is no text');
  assert.deepEqual(run.textResultOf({ plan: text('a'), extra: text('b') }, outputs), { reason: 'multiple' }, 'two text results');
  assert.deepEqual(run.textResultOf({ plan: text('a'), extra: { type: 'image', url: '/i.png' } }, outputs), { reason: 'ok', port: 'plan', text: 'a' }, 'other media beside the one text do not count');
  assert.deepEqual(run.textResultOf({ plan: { type: 'list', of: 'text', items: [text('a')] } }, outputs), { reason: 'list' });
  assert.deepEqual(run.textResultOf({ plan: { type: 'list', of: 'text', items: [text('a'), text('b')] } }, outputs), { reason: 'multiple' });
  assert.deepEqual(run.textResultOf({ plan: text('a'), extra: { type: 'list', of: 'text', items: [text('b')] } }, outputs), { reason: 'multiple' });
  assert.deepEqual(run.textResultOf({ plan: text('  \n') }, outputs), { reason: 'empty', port: 'plan' });
  assert.deepEqual(run.textResultOf({ plan: text('') }, outputs), { reason: 'empty', port: 'plan' });
  assert.deepEqual(run.textResultOf({ hidden: text('secret'), plan: text('shown') }, outputs), { reason: 'ok', port: 'plan', text: 'shown' }, 'only the visible outputs count');
  assert.deepEqual(run.textResultOf({ plan: text('x') }, []), { reason: 'none' });
  assert.deepEqual(run.textResultOf({ plan: text('x') }, undefined), { reason: 'none' });
}

function testRunRequest() {
  assert.deepEqual(run.buildRunRequest({ mode: 'all', force: false, rev: 4 }), { mode: 'all', force: false, rev: 4 });
  assert.deepEqual(run.buildRunRequest({ mode: 'node', nodeIds: ['n1'], force: true }), { mode: 'node', force: true, nodeIds: ['n1'] });
  assert.deepEqual(run.buildRunRequest({ mode: 'selection', nodeIds: ['a', 'b'], rev: 1.5 }), { mode: 'selection', force: false, nodeIds: ['a', 'b'] }, 'rev must be an integer');
  const ids = ['a'];
  const request = run.buildRunRequest({ mode: 'selection', nodeIds: ids });
  ids.push('b');
  assert.deepEqual(request.nodeIds, ['a'], 'node ids are copied');
}

/* ---------- static wiring ---------- */

function testWiring() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('nodes/preview.js') > html.indexOf('nodes/node-ui.js'), 'preview.js loads after node-ui.js');
  assert.ok(html.indexOf('nodes/run.js') > html.indexOf('nodes/workflow-list.js') && html.indexOf('nodes/run.js') < html.indexOf('nodes/main.js'), 'run.js loads before main.js');
  assert.equal(typeof run.createController, 'function');

  // the app chat script and the styles of the chat stay untouched by the node view
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(!/OCDNodes|nv-run|outputs\.zip/.test(app));

  // WP30: "Use as text" is offered in the menu and in the inspector, and main.js provides what they call
  const runSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'run.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'main.js'), 'utf8');
  const inspectorSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'inspector.js'), 'utf8');
  assert.ok(/OCD\.editor\.adoptTextResult\(/.test(runSource) && /adoptTextResult,/.test(mainSource), 'run.js calls the function main.js exports');
  assert.ok(/nodes\.run\.menu\.useAsText/.test(runSource) && /nodes\.run\.menu\.useAsText/.test(inspectorSource), 'menu and inspector offer the command');
  assert.ok(/graphLib\.adoptTextAsPrompt\(/.test(mainSource) && /history: 'use-as-text'/.test(mainSource), 'one undo step through the graph function');
  assert.ok(html.indexOf('nodes/music-plan.js') > 0 && html.indexOf('nodes/music-plan.js') < html.indexOf('nodes/inspector.js'), 'the plan check of the inspector can use music-plan.js');
  assert.ok(/OCD\.musicPlan/.test(inspectorSource), 'the inspector checks the song text with the shared module');

  // no native browser dialogs anywhere in the node view
  for (const file of fs.readdirSync(path.join(root, 'public', 'nodes')).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, 'public', 'nodes', file), 'utf8');
    assert.ok(!/\b(?:window\.)?(?:alert|confirm|prompt)\(/.test(source.replace(/confirmDialog|promptDialog/g, '')), `${file} uses a native browser dialog`);
  }

  // texts from providers and users are never inserted as HTML
  for (const file of ['run.js', 'preview.js', 'port-tip.js', 'node-ui.js', 'canvas.js']) {
    const source = fs.readFileSync(path.join(root, 'public', 'nodes', file), 'utf8');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(source), `${file} must not use innerHTML`);
  }
}

// Port hover help (public/nodes/port-tip.js): wiring and the placement maths, which do not need a DOM.
function testPortTip() {
  const vm = require('vm');
  const read = (file) => fs.readFileSync(path.join(root, 'public', 'nodes', file), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('nodes/port-tip.js') > html.indexOf('nodes/node-ui.js') && html.indexOf('nodes/port-tip.js') < html.indexOf('nodes/canvas.js'), 'port-tip.js loads between node-ui.js and canvas.js');

  // the canvas owns the tooltip and hides it whenever the view, the graph or the language changes
  const canvas = read('canvas.js');
  assert.ok(/OCD\.portTip\s*\?\s*OCD\.portTip\.createPortTip/.test(canvas), 'canvas.js creates the port tooltip');
  for (const fn of ['applyViewport', 'render', 'relabel']) {
    const at = canvas.indexOf(`function ${fn}(`);
    assert.ok(at > 0 && canvas.slice(at, at + 160).includes('portTip.hide()'), `${fn} hides the tooltip`);
  }
  assert.ok(/isBusy:\s*\(\)\s*=>\s*Boolean\(drag\)/.test(canvas), 'no tooltip while a drag (edge, node, pan) is running');

  // no native title on ports: the tooltip covers the whole row
  const nodeUi = read('node-ui.js');
  const dot = nodeUi.slice(nodeUi.indexOf('function portDot('), nodeUi.indexOf('function portCountText('));
  assert.ok(dot.length > 100 && !/\btitle\b/.test(dot), 'the port dot has no native title');
  assert.ok(/is-multi/.test(dot), 'multi-inputs get their own dot');
  const buildPorts = nodeUi.slice(nodeUi.indexOf('function buildPorts('), nodeUi.indexOf('function countTextItems('));
  assert.ok(!/title:/.test(buildPorts), 'no native titles in the port rows');

  // placement: beside the dot, on the side facing away from the card, flipped and clamped inside the window
  const window = { OCDNodes: { graph: require('../public/nodes/graph'), ui: { el: () => null, T: (key) => key, tr: (_key, fallback) => fallback } }, innerWidth: 1000, innerHeight: 600 };
  vm.runInNewContext(read('port-tip.js'), { window, document: {}, setTimeout, clearTimeout });
  const { place } = window.OCDNodes.portTip;
  const tip = () => ({ offsetWidth: 300, offsetHeight: 180, style: {} });
  const at = (left, top) => ({ left, right: left + 13, top, bottom: top + 13, width: 13, height: 13 });
  let box = tip();
  place(box, at(500, 300), 'in');
  assert.equal(parseInt(box.style.left, 10), 500 - 10 - 300, 'an input tip sits left of the dot');
  place((box = tip()), at(100, 300), 'in');
  assert.equal(parseInt(box.style.left, 10), 100 + 13 + 10, 'no room on the left: flips to the right');
  place((box = tip()), at(300, 300), 'out');
  assert.equal(parseInt(box.style.left, 10), 300 + 13 + 10, 'an output tip sits right of the dot');
  place((box = tip()), at(900, 300), 'out');
  assert.equal(parseInt(box.style.left, 10), 900 - 10 - 300, 'no room on the right: flips to the left');
  place((box = tip()), at(500, 590), 'in');
  assert.equal(parseInt(box.style.top, 10), 600 - 180 - 8, 'kept inside the window at the bottom');
  place((box = tip()), at(500, 2), 'in');
  assert.equal(parseInt(box.style.top, 10), 8, 'kept inside the window at the top');
  place((box = tip()), at(2, 300), 'in');
  assert.ok(parseInt(box.style.left, 10) >= 8, 'never left of the window edge');
  assert.equal(window.OCDNodes.portTip.SHOW_DELAY, 300);
}

const tests = [
  testSnapshot,
  testRunStartedAndNodeStatus,
  testNewRunAndMissedStart,
  testLogCostResultFinish,
  testEveryEventTypeCovered,
  testInFlight,
  testResultsHelpers,
  testPreviewItems,
  testFormatting,
  testDescribePlan,
  testDisplayStatus,
  testErrorData,
  testTextResultOf,
  testRunRequest,
  testWiring,
  testPortTip
];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('test-nodes-run-client ok');
