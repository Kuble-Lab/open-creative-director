'use strict';

const { readNodeMainSource } = require('./support/node-main-source');

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { loadPage, FakeNode } = require('./support/fake-dom');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const byClass = (node, name) => node.find((child) => child.classes?.has(name));
const clone = (value) => JSON.parse(JSON.stringify(value));
const entry = (id) => ({ id, cacheKey: 'same-key', params: { prompt: '<script>literal</script>', model: 'test-model', seed: 42 }, cost: { usd: 0.2, model: 'test-model' }, createdAt: '2026-01-01T12:00:00Z', variants: [{ out: { type: 'text', value: 'one' } }, { out: { type: 'text', value: 'two' } }] });

async function testStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-review-'));
  const sessions = { isValidId: (id) => /^[\w-]+$/.test(id), withLock: async (_key, fn) => fn() };
  const changes = [];
  const makeStore = () => createWorkflowsStore({ dir, sessions, events: { emit: (...args) => changes.push(args) } });
  try {
    const store = makeStore();
    await store.appendHistory('wf', 'a', entry('old'));
    const before = clone(await store.readResults('wf'));
    const approved = await store.approveVariant('wf', 'a', { entry: 'old', variant: 1 });
    assert.deepEqual(approved.approved, { entry: 'old', variant: 1 });
    assert.equal(changes[0][1].type, 'results_changed');
    assert.deepEqual(approved.selected, before.nodes.a.selected, 'approving never selects');
    assert.deepEqual(approved.history, before.nodes.a.history, 'all cache keys, params and values unchanged');
    assert.deepEqual((await makeStore().readResults('wf')).nodes.a.approved, approved.approved, 'survives reopening');
    await assert.rejects(store.approveVariant('wf', 'a', { entry: 'missing', variant: 0 }), { code: 'ENTRY_NOT_FOUND' });
    await assert.rejects(store.approveVariant('wf', 'a', { entry: 'old', variant: 2 }), { code: 'ENTRY_NOT_FOUND' });
    await assert.rejects(store.approveVariant('wf', 'a', { entry: 'old', variant: -1 }), { code: 'ENTRY_NOT_FOUND' });
    for (let i = 0; i < 35; i++) await store.appendHistory('wf', 'a', entry(`new${i}`));
    const after = (await store.readResults('wf')).nodes.a;
    assert.ok(after.history.some((item) => item.id === 'old'), 'approved entry survives history cap');
    assert.equal(after.history.length, 31);
    assert.equal(after.selected.entry, 'new34', 'new runs still select their result');
    await store.selectVariant('wf', 'a', { entry: 'old', variant: 1 });
    assert.deepEqual((await store.readResults('wf')).nodes.a.approved, approved.approved);
    await store.approveVariant('wf', 'a', { entry: 'new34', variant: 0 });
    await store.approveVariant('wf', 'a', { entry: 'old', variant: 1, approved: false });
    assert.equal((await store.readResults('wf')).nodes.a.approved.entry, 'new34', 'stale unapprove cannot clear another variant');
    await store.approveVariant('wf', 'a', { entry: 'new34', variant: 0, approved: false });
    assert.equal((await store.readResults('wf')).nodes.a.approved, undefined);
    await fs.writeFile(path.join(dir, 'wf', 'workflow.json'), JSON.stringify({ id: 'wf', graph: { nodes: [], edges: [] } }));
    await store.approveVariant('wf', 'a', { entry: 'old', variant: 1 });
    const removed = await store.deleteResults('wf', 'a', { entry: 'old' });
    assert.equal(removed.node.approved, undefined, 'explicit deletion removes approval without a dangling reference');
    await store.approveVariant('wf', 'a', { entry: 'new34', variant: 0 });
    const cleared = await store.deleteResults('wf', 'a');
    assert.equal(cleared.node.approved, undefined);
    assert.equal(cleared.node.history.length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function testRoute() {
  const { registerNodeRoutes } = require('../lib/nodes/routes');
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (route, fn) => handlers.set(`${method} ${route}`, fn)]));
  const calls = [];
  registerNodeRoutes(app, {
    engine: {}, sessions: { isValidId: () => true },
    store: {
      readWorkflow: async () => ({ id: 'wf' }),
      approveVariant: async (...args) => { calls.push(['approve', ...args]); return { approved: args[2] }; },
      selectVariant: async (...args) => { calls.push(['select', ...args]); return { selected: args[2] }; }
    }
  });
  const invoke = async (body) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get('patch /api/workflows/:id/results/:nodeId')({ params: { id: 'wf', nodeId: 'a' }, body }, response);
    return response;
  };
  assert.equal((await invoke({ entry: 'one', variant: 1, approved: true })).statusCode, 200);
  assert.equal(calls[0][0], 'approve');
  await invoke({ entry: 'one', approved: false });
  assert.equal(calls[1][3].approved, false);
  await invoke({ entry: 'one', variant: 1 });
  assert.equal(calls[2][0], 'select', 'legacy request still selects');
  assert.equal((await invoke({ entry: 'one', approved: 'true' })).statusCode, 400);
  assert.equal((await invoke({ entry: 'one', variant: -1, approved: true })).statusCode, 400);
  assert.equal((await invoke({ approved: true })).statusCode, 400);
  assert.equal(calls.length, 3, 'invalid bodies never reach storage');
}

function testCachePlan() {
  const engine = require('../lib/nodes/engine');
  const registry = require('../lib/nodes/registry').registry;
  const node = { id: 'a', type: 'input.prompt', typeVersion: 1, params: { text: 'hello' }, x: 0, y: 0 };
  const def = registry.get(node.type);
  const params = engine.effectiveParams(registry, def, node, {});
  const history = [{ ...entry('one'), params, cacheKey: engine.computeCacheKey(def, params, {}), variants: [{ text: { type: 'text', value: 'hello' } }] }];
  const results = { nodes: { a: { history, selected: { entry: 'one', variant: 0 } } } };
  const workflow = { graph: { nodes: [node], edges: [] } };
  const request = engine.normaliseRequest({ mode: 'all' }, workflow, registry);
  const plan = () => engine.computePlan({ workflow, results, request, registry, limits: engine.resolveLimits() });
  const before = plan();
  assert.equal(before.nodes.a.status, 'cached');
  results.nodes.a.approved = { entry: 'one', variant: 0 };
  assert.deepEqual(plan(), before, 'approval never invalidates cache or changes plan/costs');
}

async function testUI() {
  for (const lang of ['de', 'en', 'es']) {
    const page = loadPage(lang, { scripts: ['node-ui', 'preview', 'inspector'] });
    const { OCD } = page;
    const nodes = { a: { selected: { entry: 'one', variant: 0 }, approved: { entry: 'one', variant: 1 }, history: [entry('one')] } };
    const state = { workflow: { id: 'wf' }, results: { nodes } };
    let requests = 0;
    OCD.editor = { getState: () => state };
    OCD.api.request = async (_method, _url, body) => { requests++; nodes.a.approved = body.approved ? { entry: body.entry, variant: body.variant } : undefined; return clone(nodes.a); };
    const info = { def: {}, results: nodes.a, selected: nodes.a.selected, outputOrder: ['out'], hiddenPorts: new Set(), busy: false };
    const inspector = OCD.inspector.createInspector({ host: new FakeNode('div'), getReg: () => ({}), callbacks: { run: { info: () => ({ ...info, results: state.results.nodes.a }), costText: (cost) => cost ? `$${cost.usd}` : '', selectVariant: () => {} } } });
    const container = new FakeNode('div');
    inspector.renderHistory(container, 'a');
    assert.equal(byClass(container, 'nv-approve').length, 2);
    assert.equal(byClass(container, 'nv-compare-open').length, 1);
    let dialog;
    OCD.ui.dialog = (options) => { dialog = options; };
    byClass(container, 'nv-compare-open')[0].fire('click');
    assert.equal(byClass(dialog.body, 'nv-compare-card').length, 2, 'history button opens a comparison');
    assert.equal(dialog.width, 1200);
    await byClass(container, 'nv-approve')[0].listeners.click[0]();
    assert.equal(requests, 1);
    assert.equal(state.results.nodes.a.approved.variant, 0);
    assert.equal(state.results.nodes.a.selected.variant, 0);
    const saved = clone(state.results);
    let failure;
    OCD.ui.toast = (message) => { failure = message; };
    OCD.api.request = async () => { throw new Error('offline'); };
    await byClass(container, 'nv-approve')[0].listeners.click[0]();
    assert.deepEqual(clone(state.results), saved, 'failed save does not show a false approval');
    assert.ok(failure.includes('offline'));
    const selected = [], approvals = [];
    const e = entry('one');
    const variants = ['image', 'video', 'audio', 'text'].map((type, index) => ({ entry: e, index, variant: { out: type === 'text' ? { type, value: '<img src=x>' } : { type, url: '/assets/test/file' } } }));
    const panel = OCD.preview.comparisonPanel(variants, { approved: { entry: 'one', variant: 1 }, onSelect: (...args) => selected.push(args), onApprove: (...args) => approvals.push(args), costText: () => '$0.20' });
    assert.equal(byClass(panel, 'nv-compare-card').length, 4);
    for (const tag of ['img', 'video', 'audio']) assert.ok(panel.querySelector(tag));
    assert.ok(panel.textContent.includes('<script>literal</script>'));
    assert.ok(panel.textContent.includes('<img src=x>'));
    assert.ok(panel.textContent.includes('test-model'));
    assert.ok(panel.textContent.includes('42'));
    assert.ok(panel.textContent.includes('$0.20'));
    assert.ok(!panel.textContent.includes('nodes.compare.'));
    await byClass(panel, 'nv-approve')[1].listeners.click[0]();
    assert.deepEqual(approvals, [['one', 1, false]]);
    assert.equal(byClass(panel, 'nv-approve')[1].getAttribute('aria-pressed'), 'true');
    const legacy = OCD.preview.comparisonPanel([{ entry: { id: 'legacy', cost: { usd: 0 } }, index: 0, variant: { out: { type: 'text', value: 'saved' } } }], { costText: () => '' });
    assert.ok(legacy.textContent.includes('USD 0'));
    assert.ok(legacy.textContent.includes(OCD.ui.T('nodes.compare.unknown')));
  }
}

async function testGuards() {
  let starts = 0, selections = 0, prompts = 0, allow = false;
  const state = { workflow: { id: 'wf' }, results: { nodes: { a: { history: [entry('one')], selected: { entry: 'one', variant: 0 }, approved: { entry: 'one', variant: 0 } } } } };
  let status = 'forced';
  const api = { getWorkflow: async () => clone(state), plan: async () => ({ nodes: { a: { status } } }), startRun: async (_id, request) => { starts++; return request; }, request: async () => { selections++; } };
  const { OCD } = loadPage('en', { scripts: ['node-ui', 'preview', 'inspector'], api });
  OCD.ui.confirmDialog = async () => { prompts++; return allow; };
  OCD.inspector.installApprovalGuard(OCD.api, () => state);
  const request = { mode: 'all', force: true, overrides: { a: { prompt: 'exact' } } };
  await assert.rejects(OCD.api.startRun('wf', request), /Cancelled/);
  assert.equal(starts, 0);
  allow = true;
  assert.deepEqual(clone(await OCD.api.startRun('wf', request)), { ...request, reviewRevision: 0 }, 'execution parameters unchanged; review token added separately');
  assert.equal(starts, 1);
  status = 'cached'; allow = false;
  await assert.rejects(OCD.api.startRun('wf', request), /Cancelled/, 'cached selection can change too');
  status = 'invalid';
  await OCD.api.startRun('wf', request);
  assert.equal(starts, 2);
  await assert.rejects(OCD.api.selectVariant('wf', 'a', 'one', 1), /Cancelled/);
  assert.equal(selections, 0);
  allow = true;
  await OCD.api.selectVariant('wf', 'a', 'one', 1);
  assert.equal(selections, 1);
  const before = { nodes: [{ id: 'a', params: {} }, { id: 'b', params: {} }], edges: [{ from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } }] };
  const moved = clone(before); moved.nodes[1].x = 42;
  assert.equal(OCD.inspector.affectedApprovals(before, moved, state.results).length, 0);
  moved.nodes[1].params.label = 'Display only';
  moved.nodes[1].params.title = 'Display only';
  assert.equal(OCD.inspector.affectedApprovals(before, moved, state.results).length, 0, 'cache-excluded labels do not warn');
  const edited = clone(before); edited.nodes[1].params.prompt = 'new';
  assert.deepEqual([...OCD.inspector.affectedApprovals(before, edited, state.results)], ['a']);
  const disconnected = clone(before); disconnected.edges = [];
  assert.deepEqual([...OCD.inspector.affectedApprovals(before, disconnected, state.results)], ['a']);
  state.workflow.graph = before;
  allow = false;
  await assert.rejects(OCD.api.selectVariant('wf', 'b', 'other', 0), /Cancelled/, 'upstream selection warns about approved descendants');
  let warnings = 0;
  OCD.ui.toast = () => warnings++;
  OCD.inspector.warnApprovalChanges(before, edited, state.results);
  OCD.inspector.warnApprovalChanges(before, edited, state.results);
  assert.equal(warnings, 1, 'typing does not create a warning for every key');
  assert.ok(prompts >= 4);
}


async function testConcurrentReview() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-concurrency-'));
  const store = createWorkflowsStore({ dir });
  try {
    await fs.mkdir(path.join(dir, 'wf'), { recursive: true });
    await fs.writeFile(path.join(dir, 'wf', 'workflow.json'), JSON.stringify({ id: 'wf', graph: { nodes: [], edges: [] } }));
    await store.appendHistory('wf', 'a', entry('one'));
    const stale = (await store.readResults('wf')).reviewRevision;
    await store.approveVariant('wf', 'a', { entry: 'one', variant: 0 });
    let starts = 0;
    await assert.rejects(store.startReviewedRun('wf', stale, () => { starts++; }), { code: 'REVIEW_CONFLICT' });
    await assert.rejects(store.selectVariant('wf', 'a', { entry: 'one', variant: 1, reviewRevision: stale }), { code: 'REVIEW_CONFLICT' });
    assert.equal(starts, 0);
    assert.equal((await store.readResults('wf')).nodes.a.selected.variant, 0);
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (route, fn) => handlers.set(`${method} ${route}`, fn)]));
    let routeBusy = false, executionRequest;
    require('../lib/nodes/routes').registerNodeRoutes(app, {
      store,
      engine: {
        isBusy: () => routeBusy,
        start: async (id, request) => {
          starts++; routeBusy = true; executionRequest = request;
          await store.getWorkflow(id);
          return 'reviewed-run';
        }
      }
    });
    const invoke = async (route, body) => {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await handlers.get(route)({ params: { id: 'wf', nodeId: 'a' }, body }, response);
      return response;
    };
    const runRoute = 'post /api/workflows/:id/runs';
    const selectRoute = 'patch /api/workflows/:id/results/:nodeId';
    assert.equal((await invoke(runRoute, { mode: 'all', reviewRevision: stale })).statusCode, 409);
    assert.equal((await invoke(selectRoute, { entry: 'one', variant: 1, reviewRevision: stale })).statusCode, 409);
    assert.equal(starts, 0, 'route conflict never starts execution');
    assert.equal((await invoke(runRoute, { mode: 'all', reviewRevision: 'invalid' })).statusCode, 400);
    const current = (await store.readResults('wf')).reviewRevision;
    assert.equal((await invoke(runRoute, { mode: 'all', reviewRevision: current })).statusCode, 202);
    assert.equal(executionRequest.reviewRevision, undefined, 'review metadata never reaches the engine');
    assert.equal((await invoke(selectRoute, { entry: 'one', variant: 1, approved: true })).statusCode, 409, 'another tab cannot approve during execution');
    routeBusy = false;


    // Hold the start open while a second tab tries to approve. The engine can read
    // results during start; the review lock must neither deadlock it nor admit approval.
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let busy = false;
    const revision = (await store.readResults('wf')).reviewRevision;
    const running = store.startReviewedRun('wf', revision, async () => {
      busy = true;
      await store.getWorkflow('wf');
      entered();
      await gate;
      return 'run';
    });
    await started;
    const approval = store.approveVariant('wf', 'a', { entry: 'one', variant: 1 }, () => busy);
    const rejected = assert.rejects(approval, { code: 'RUN_ACTIVE' });
    release();
    assert.equal(await running, 'run');
    await rejected;
    assert.equal((await store.readResults('wf')).nodes.a.approved.variant, 0);

    // Legacy clients need no token.
    busy = false;
    assert.equal(await store.startReviewedRun('wf', undefined, () => 'legacy'), 'legacy');

    for (const operation of ['start', 'select']) for (const allow of [false, true]) {
      let confirmations = 0, executions = 0, reads = 0;
      const state = { workflow: { id: 'wf', graph: { nodes: [], edges: [] } } };
      const fresh = { ...state, results: { reviewRevision: 1, nodes: { a: { history: [entry('one')], selected: { entry: 'one', variant: 0 } } } } };
      const conflict = () => {
        fresh.results.nodes.a.approved = { entry: 'one', variant: 0 };
        fresh.results.reviewRevision++;
        throw Object.assign(new Error('changed'), { code: 'REVIEW_CONFLICT' });
      };
      const api = {
        getWorkflow: async () => { reads++; return clone(fresh); },
        plan: async () => ({ nodes: { a: { status: 'forced' } } }),
        startRun: async (_id, request) => { executions++; if (executions === 1) return conflict(); assert.equal(request.reviewRevision, 2); return 'started'; },
        request: async (_method, _url, request) => { executions++; if (executions === 1) return conflict(); assert.equal(request.reviewRevision, 2); return 'selected'; }
      };
      const { OCD } = loadPage('en', { scripts: ['node-ui', 'inspector'], api });
      OCD.ui.confirmDialog = async () => { confirmations++; return allow; };
      OCD.inspector.installApprovalGuard(OCD.api, () => state);
      const result = operation === 'start' ? OCD.api.startRun('wf', { mode: 'all' }) : OCD.api.selectVariant('wf', 'a', 'one', 1);
      if (allow) assert.equal(await result, operation === 'start' ? 'started' : 'selected');
      else await assert.rejects(result, /Cancelled/);
      assert.equal(executions, allow ? 2 : 1, 'only retry after explicit confirmation');
      assert.equal(reads, 2);
      assert.equal(confirmations, 1, 'approval made between read and mutation must be confirmed');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function testMetadata() {
  const { OCD } = loadPage('en', { scripts: ['node-ui', 'preview'] });
  const e = entry('one');
  e.params.prompt = 'unused local draft';
  e.params.model = 'requested model';
  e.cost.model = 'actual fallback model';
  const render = (variant) => OCD.preview.comparisonPanel([{ entry: e, variant, index: 0 }]);
  const details = (panel) => panel.querySelector('dl').children.filter((node) => node.tagName === 'DD').map((node) => node.textContent);
  // The connected prompt is not saved in old entries: never substitute the local draft.
  let rows = details(render({ out: { type: 'image', url: '/image' } }));
  assert.equal(rows[0], OCD.ui.T('nodes.compare.promptUnknown'));
  assert.equal(rows[1], 'actual fallback model');
  rows = details(render({ out: { type: 'image', url: '/image', prompt: 'recorded connected prompt', model: 'variant model' } }));
  assert.equal(rows[0], 'recorded connected prompt');
  assert.equal(rows[1], 'variant model');
}

async function testUndoRedoWarnings() {
  const vm = require('vm');
  const { OCD } = loadPage('en', { scripts: ['node-ui', 'inspector'] });
  const source = readNodeMainSource();
  const functions = ['undo', 'redo', 'restoreSnapshot'].map((name) => {
    const match = source.match(new RegExp('  function ' + name + '[(][^]*?\n  [}]'));
    assert.ok(match, name);
    return match[0];
  }).join('\n');
  const history = require('../public/nodes/history').createHistory();
  const first = { nodes: [{ id: 'a', params: { prompt: 'first' } }], edges: [] };
  const second = clone(first); second.nodes[0].params.prompt = 'second';
  history.reset(first); history.commit(second);
  const state = { history, graph: second, results: { nodes: { a: { history: [entry('one')], approved: { entry: 'one', variant: 0 } } } } };
  let warnings = 0;
  OCD.ui.toast = () => { warnings++; };
  const noop = () => {};
  const context = { OCD, state, graphLib: { withContent: (_graph, snapshot) => clone(snapshot) }, runtime: { canvas: { render: noop } }, bus: { emit: noop } };
  for (const name of ['reserveId', 'syncAppRemaps', 'pruneApp', 'markDirty', 'updateUndoButtons', 'refreshInspector', 'scheduleAppMarks', 'updateStart']) context[name] = noop;
  vm.runInNewContext(functions + ';undo();redo();', context);
  assert.equal(warnings, 2, 'both editor callbacks warn even when the approval was already warned about');
  assert.deepEqual(state.graph, second);
}

(async () => {
  await testStore();
  await testConcurrentReview();
  testMetadata();
  await testUndoRedoWarnings();
  await testRoute();
  testCachePlan();
  await testUI();
  await testGuards();
  console.log('test-nodes-variant-review.js: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
