'use strict';

// Design App of the node view (SPEC §14, WP7): logic of the frontend modules that runs without a DOM
// (batch counter parity with the server's list parser), server-side validation of the app section,
// a free local flow with an exposed text list that runs as a batch through the engine (overrides,
// no change of the saved graph), and static checks of the browser wiring (script order, no native
// dialogs, no innerHTML, every CSS class of the new modules is defined, i18n keys exist in three languages).
// The optional approval step (outputs marked `approve: true`): the field in the app section (kept only as
// `true`, in the server and in the client, through save, export, import and duplicate), the pure decision of
// the app view (which step is due, which request starts it) and the whole flow through the real engine
// (step 1 makes only the marked outputs, step 2 takes their results from the cache, "again" is forced).

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const store = require('../lib/store');
const nodeRegistry = require('../lib/nodes/registry');
const { createRegistry } = nodeRegistry;
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore, normalizeApp } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/* ---------- pure frontend logic ---------- */

function loadAppMode() {
  const ui = { el: () => ({}), icon: () => ({}), T: (key) => key };
  const window = { OCDNodes: { graph: {}, ui, api: {}, run: {} } };
  vm.runInNewContext(read('public/nodes/app-mode.js'), { window, localStorage: undefined, console });
  return window.OCDNodes.appMode;
}

function extractCounter() {
  const source = read('public/nodes/node-ui.js');
  const match = source.match(/function countTextItems\(text\) \{[\s\S]*?\n  \}\n/);
  assert.ok(match, 'node-ui.js has countTextItems');
  return new Function(`${match[0]}; return countTextItems;`)();
}

function testCounter() {
  const appMode = loadAppMode();
  const cardCounter = extractCounter();
  const samples = [
    '',
    '   ',
    'one',
    'one\ntwo\nthree',
    'one\r\n\r\ntwo\r\n',
    'a\n---\nb\nb2\n---\n\n---\nc',
    '---',
    'x\n  ---  \ny',
    '\n\nsolo\n\n'
  ];
  for (const sample of samples) {
    const expected = nodesBasic.parseTextList(sample).length;
    assert.equal(appMode.countTextItems(sample), expected, `app-mode counts ${JSON.stringify(sample)}`);
    assert.equal(cardCounter(sample), expected, `card counter counts ${JSON.stringify(sample)}`);
  }
  assert.equal(appMode.countTextItems(undefined), 0);
}

/* ---------- app section validation ---------- */

function freeGraph() {
  return {
    nodes: [
      { id: 'n1', type: 'input.text_list', x: 0, y: 0, params: { text: 'alpha\nbeta\ngamma' } },
      { id: 'n2', type: 'text.template', x: 300, y: 0, params: { template: 'Scene: {{a}}' } },
      { id: 'n3', type: 'image.text_render', x: 600, y: 0, params: {} },
      { id: 'n4', type: 'output.result', x: 900, y: 0, params: { label: 'Cards' } }
    ],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'items' }, to: { node: 'n2', port: 'a' } },
      { id: 'e2', from: { node: 'n2', port: 'text' }, to: { node: 'n3', port: 'text' } },
      { id: 'e3', from: { node: 'n3', port: 'image' }, to: { node: 'n4', port: 'inputs' } }
    ],
    notes: [],
    groups: []
  };
}

function testAppValidation() {
  const graph = freeGraph();
  const ok = normalizeApp(
    { enabled: true, title: 'Cards', description: 'd', inputs: [{ node: 'n1', param: 'text', label: 'Lines' }], outputs: [{ node: 'n4', label: 'Cards' }] },
    graph
  );
  assert.equal(ok.enabled, true);
  assert.equal(ok.title, 'Cards');
  assert.deepEqual(ok.inputs, [{ node: 'n1', param: 'text', label: 'Lines' }]);
  assert.deepEqual(ok.outputs, [{ node: 'n4', label: 'Cards' }]);

  assert.throws(() => normalizeApp({ enabled: true, inputs: [{ node: 'n1', param: 'nope' }], outputs: [] }, graph), /does not exist/);
  assert.throws(() => normalizeApp({ enabled: true, inputs: [], outputs: [{ node: 'n3' }] }, graph), /output\.result/);
  assert.throws(() => normalizeApp({ enabled: true, inputs: [{ node: 'n1' }], outputs: [] }, graph), /needs node and param/);
  assert.throws(() => normalizeApp('x', graph), /must be an object/);

  // references to deleted nodes are dropped, not rejected
  const pruned = normalizeApp({ enabled: true, inputs: [{ node: 'gone', param: 'text', label: '' }], outputs: [{ node: 'gone', label: '' }] }, graph);
  assert.deepEqual(pruned.inputs, []);
  assert.deepEqual(pruned.outputs, []);
  assert.deepEqual(normalizeApp(undefined, graph), { enabled: false, title: '', description: '', inputs: [], outputs: [] });
}

/* ---------- batch through the engine with fake image rendering ---------- */

async function testBatch(tmpDir, created) {
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const rendered = [];
  const def = nodeRegistry.get('image.text_render');
  registry.register({
    ...def,
    available: () => true,
    validate: undefined,
    cost: undefined,
    execute: async (ctx, inputs) => {
      rendered.push(inputs.text.value);
      return {
        variants: [{ image: { type: 'image', sessionId: 'fake', assetId: `img-${ctx.itemIndex}`, file: `t${ctx.itemIndex}.png`, url: `/assets/fake/t${ctx.itemIndex}.png` } }]
      };
    }
  });
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
  const doc = {
    format: 'ocd.workflow',
    version: 1,
    name: 'WP7 app test',
    description: '',
    graph: freeGraph(),
    app: { enabled: true, title: 'Cards', description: '', inputs: [{ node: 'n1', param: 'text', label: 'Lines' }], outputs: [{ node: 'n4', label: 'Cards' }] }
  };
  const made = await wfStore.createWorkflow({ document: doc });
  created.workflows.push(made.workflow.id);
  created.sessions.push(made.workflow.sessionId);
  const id = made.workflow.id;
  assert.equal(made.workflow.app.enabled, true);

  const first = await engine.start(id, { mode: 'all', user: 'tester' });
  const firstRecord = await engine.whenFinished(id, first);
  assert.equal(firstRecord.status, 'completed', JSON.stringify(firstRecord.nodes));
  assert.deepEqual(rendered, ['Scene: alpha', 'Scene: beta', 'Scene: gamma'], 'the 3-item list runs once per item, in order');
  const results = await wfStore.readResults(id);
  const output = results.nodes.n4.history[0].variants[0];
  const value = output.result || output.outputs?.result;
  assert.ok(value, 'the output node stores its value');
  assert.equal(value.type, 'list');
  assert.equal(value.items.length, 3);

  // form values arrive as overrides: two lines, the saved graph stays untouched
  rendered.length = 0;
  const second = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n1: { text: 'one\ntwo' } } });
  assert.equal((await engine.whenFinished(id, second)).status, 'completed');
  assert.deepEqual(rendered, ['Scene: one', 'Scene: two']);
  const saved = await wfStore.readWorkflow(id);
  assert.equal(saved.graph.nodes.find((node) => node.id === 'n1').params.text, 'alpha\nbeta\ngamma');

  // an update without `app` keeps the stored app section
  const updated = await wfStore.saveGraph(id, { baseRev: saved.rev, graph: saved.graph, name: 'WP7 app test renamed' });
  const after = await wfStore.readWorkflow(id);
  assert.equal(after.name, 'WP7 app test renamed');
  assert.equal(after.app.enabled, true);
  assert.equal(after.app.inputs.length, 1);
  void updated;
}

/* ---------- optional approval step: the field ---------- */

// workflow.app as the node view keeps it in the browser (public/nodes/main.js): the function is cut out of the source
function extractClientNormalizeApp() {
  const match = read('public/nodes/main.js').match(/function normalizeApp\(raw\) \{[\s\S]*?\n  \}\n/);
  assert.ok(match, 'main.js has normalizeApp');
  return new Function(`${match[0]}; return normalizeApp;`)();
}

const WRONG_MARKS = ['yes', 'true', 'TRUE', 1, 0, null, false, undefined, {}, []];

function testApprovalField() {
  const graph = freeGraph();
  const server = (outputs) => normalizeApp({ enabled: true, inputs: [], outputs }, graph).outputs;
  const client = extractClientNormalizeApp();
  const clientOutputs = (outputs) => client({ enabled: true, inputs: [], outputs }).outputs;
  for (const [name, outputsOf] of [['server', server], ['client', clientOutputs]]) {
    // exactly `true` is the mark and stays
    assert.deepEqual(outputsOf([{ node: 'n4', label: 'Cards', approve: true }]), [{ node: 'n4', label: 'Cards', approve: true }], `${name}: true stays`);
    // anything else is no mark and does not stay (no key at all)
    for (const wrong of WRONG_MARKS) {
      const [entry] = outputsOf([{ node: 'n4', label: 'Cards', approve: wrong }]);
      assert.deepEqual(entry, { node: 'n4', label: 'Cards' }, `${name}: ${JSON.stringify(wrong)} is dropped`);
      assert.equal('approve' in entry, false, `${name}: no approve key for ${JSON.stringify(wrong)}`);
    }
    // an output without the field is stored as it always was, byte for byte
    assert.equal(JSON.stringify(outputsOf([{ node: 'n4', label: 'Cards' }])), '[{"node":"n4","label":"Cards"}]', `${name}: unchanged without the field`);
  }
  // the client keeps the entries of an app the way they are (labels, order) and the other fields of the app
  const app = client({ enabled: true, title: 'T', description: 'D', inputs: [{ node: 'n1', param: 'text', label: 'L' }], outputs: [{ node: 'n4', label: 'A', approve: true }, { node: 'n9', label: 'B' }] });
  assert.deepEqual(app, { enabled: true, title: 'T', description: 'D', inputs: [{ node: 'n1', param: 'text', label: 'L' }], outputs: [{ node: 'n4', label: 'A', approve: true }, { node: 'n9', label: 'B' }] });
  assert.deepEqual(client(undefined), { enabled: false, title: '', description: '', inputs: [], outputs: [] });

  // the mark belongs to outputs: an input entry keeps no extra field, an output of a node that is gone takes the mark with it
  const mixed = normalizeApp({ enabled: true, inputs: [{ node: 'n1', param: 'text', label: 'Lines', approve: true }], outputs: [{ node: 'gone', label: '', approve: true }, { node: 'n4', label: 'Cards', approve: true }] }, graph);
  assert.deepEqual(mixed.inputs, [{ node: 'n1', param: 'text', label: 'Lines' }]);
  assert.deepEqual(mixed.outputs, [{ node: 'n4', label: 'Cards', approve: true }]);
  // an output that is not an output.result node is refused, with or without the mark
  assert.throws(() => normalizeApp({ enabled: true, inputs: [], outputs: [{ node: 'n3', approve: true }] }, graph), /output\.result/);
}

// save, import, export and duplicate keep the mark; a save without `app` keeps the stored one (pruneApp) and drops what no longer exists
async function testApprovalStore(tmpDir, created) {
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: createEventBus() });
  const marked = [{ node: 'n4', label: 'Cards', approve: true }];
  const doc = {
    format: 'ocd.workflow',
    version: 1,
    name: 'Approval field test',
    description: '',
    graph: freeGraph(),
    app: { enabled: true, title: 'Cards', description: '', inputs: [{ node: 'n1', param: 'text', label: 'Lines' }], outputs: marked }
  };
  const track = (made) => {
    created.workflows.push(made.workflow.id);
    created.sessions.push(made.workflow.sessionId);
    return made.workflow.id;
  };
  const id = track(await wfStore.createWorkflow({ document: doc }));
  assert.deepEqual((await wfStore.readWorkflow(id)).app.outputs, marked, 'an imported document keeps the mark');
  const exported = await wfStore.exportWorkflow(id);
  assert.deepEqual(exported.app.outputs, marked, 'the export carries it');
  assert.deepEqual((await wfStore.readWorkflow(track(await wfStore.createWorkflow({ document: exported })))).app.outputs, marked, 'and an import of that export keeps it');
  assert.deepEqual((await wfStore.readWorkflow(track(await wfStore.duplicateWorkflow(id)))).app.outputs, marked, 'a copy keeps it');

  // a save without `app` keeps the stored section, mark included
  let current = await wfStore.readWorkflow(id);
  await wfStore.saveGraph(id, { baseRev: current.rev, graph: current.graph, name: 'renamed' });
  current = await wfStore.readWorkflow(id);
  assert.deepEqual(current.app.outputs, marked, 'a save without app keeps the mark');
  // a save with `app` is validated like an import: only `true` is a mark
  const wrongApp = { ...current.app, outputs: [{ node: 'n4', label: 'Cards', approve: 'yes' }] };
  await wfStore.saveGraph(id, { baseRev: current.rev, graph: current.graph, app: wrongApp });
  current = await wfStore.readWorkflow(id);
  assert.deepEqual(current.app.outputs, [{ node: 'n4', label: 'Cards' }], 'a wrong value is no mark');
  await wfStore.saveGraph(id, { baseRev: current.rev, graph: current.graph, app: { ...current.app, outputs: marked } });
  current = await wfStore.readWorkflow(id);
  assert.deepEqual(current.app.outputs, marked);
  // the output node goes: the entry goes with it, and so does its mark
  const without = { ...current.graph, nodes: current.graph.nodes.filter((node) => node.id !== 'n4'), edges: current.graph.edges.filter((edge) => edge.to.node !== 'n4') };
  await wfStore.saveGraph(id, { baseRev: current.rev, graph: without });
  assert.deepEqual((await wfStore.readWorkflow(id)).app.outputs, [], 'the mark leaves with its output');
}

/* ---------- optional approval step: the decision of the app view ---------- */

// A plan as the engine answers it, reduced to what the decision reads: `statuses` is { nodeId: status } in the order of the run
function planOf(statuses) {
  return { nodes: Object.fromEntries(Object.entries(statuses).map(([nodeId, status]) => [nodeId, { status }])), order: Object.keys(statuses) };
}

// app-mode.js runs in its own vm context: its arrays and objects have other prototypes than the ones of this file, so what it
// returns is cloned to plain data before it is compared or sent to the engine. `raw` is the module itself (for what is about identity).
function loadApprovalLogic() {
  const raw = loadAppMode();
  const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    raw,
    approvalTargets: (...args) => plain(raw.approvalTargets(...args)),
    previewRequest: (...args) => plain(raw.previewRequest(...args)),
    approvalFlow: (...args) => plain(raw.approvalFlow(...args))
  };
}

function testApprovalFlow() {
  const { raw, approvalTargets, previewRequest, approvalFlow } = loadApprovalLogic();
  const exists = (id) => ['n3', 'n5', 'n7'].includes(id);

  // the marked outputs that still exist, in the order of the app, each once
  assert.deepEqual(approvalTargets([{ node: 'n5', approve: true }, { node: 'n3' }, { node: 'n7', approve: true }, { node: 'n5', approve: true }, { node: 'gone', approve: true }], exists), ['n5', 'n7']);
  for (const wrong of WRONG_MARKS.filter((value) => value !== undefined)) assert.deepEqual(approvalTargets([{ node: 'n3', approve: wrong }], exists), [], `${JSON.stringify(wrong)} marks nothing`);
  assert.deepEqual(approvalTargets(undefined, exists), []);
  assert.deepEqual(approvalTargets([null, 'n3', { node: 3, approve: true }], exists), []);

  // the request of step 1: node for one target, selection for several, with the values of the form
  const overrides = { n1: { text: 'topic' } };
  assert.deepEqual(previewRequest({ targets: ['n3'], overrides }), { mode: 'node', nodeIds: ['n3'], force: false, overrides });
  assert.deepEqual(previewRequest({ targets: ['n3', 'n5'], overrides }), { mode: 'selection', nodeIds: ['n3', 'n5'], force: false, overrides });
  // forced: every node of the required set is made again (`force` holds for the targets only), in the order of the plan
  assert.deepEqual(previewRequest({ targets: ['n3'], overrides, force: true, order: ['n1', 'n2', 'n3'] }), { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides });
  assert.deepEqual(previewRequest({ targets: ['n3'], overrides, force: true, order: ['n3'] }), { mode: 'node', nodeIds: ['n3'], force: true, overrides });
  assert.deepEqual(previewRequest({ targets: ['n3'], overrides, force: true }), { mode: 'node', nodeIds: ['n3'], force: true, overrides }, 'without an order only the targets');
  assert.equal(raw.previewRequest({ targets: ['n3'], overrides }).overrides, overrides, 'the same values as the form, not a copy');

  // no marked output: nothing changes for the app
  assert.equal(approvalFlow({ targets: [], overrides, preview: planOf({ n3: 'cached' }), all: planOf({ n3: 'cached' }) }), null);
  assert.equal(approvalFlow({ overrides }), null);

  const stale = planOf({ n1: 'cached', n2: 'cached', n3: 'stale' });
  const cachedPreview = planOf({ n1: 'cached', n2: 'cached', n3: 'cached' });
  const restStale = planOf({ n1: 'cached', n2: 'cached', n3: 'cached', n4: 'stale', n5: 'stale' });
  const everythingCached = planOf({ n1: 'cached', n2: 'cached', n3: 'cached', n4: 'cached', n5: 'cached' });

  // step 1: a marked output is not up to date (also while the plans are not there)
  assert.deepEqual(approvalFlow({ targets: ['n3'], overrides, preview: stale, all: restStale }), { step: 'first', done: false, request: { mode: 'node', nodeIds: ['n3'], force: false, overrides } });
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: null, all: null }).step, 'first');
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: planOf({}), all: null }).step, 'first');
  for (const status of ['forced', 'invalid', 'unavailable']) assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: planOf({ n3: status }) }).step, 'first', status);
  // one of several marked outputs is not enough
  assert.equal(approvalFlow({ targets: ['n3', 'n5'], overrides, preview: planOf({ n3: 'cached', n5: 'stale' }) }).step, 'first');
  assert.deepEqual(approvalFlow({ targets: ['n3', 'n5'], overrides, preview: planOf({ n3: 'cached', n5: 'stale' }) }).request.mode, 'selection');

  // step 2: they are up to date, the rest is not; the request makes everything, not forced (the cache gives step 1 back)
  assert.deepEqual(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: restStale }), { step: 'approve', done: false, request: { mode: 'all', force: false, overrides } });
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: null }).step, 'approve', 'while the plan of everything is not known');
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: planOf({}) }).step, 'approve', 'an empty plan is not "everything is up to date"');
  assert.equal(approvalFlow({ targets: ['n3', 'n5'], overrides, preview: planOf({ n3: 'cached', n5: 'cached' }), all: restStale }).step, 'approve');
  // ... but only with something to show: a cached output without a result is not up to date for the person
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: restStale, hasResult: () => false }).step, 'first');
  assert.equal(approvalFlow({ targets: ['n3', 'n5'], overrides, preview: planOf({ n3: 'cached', n5: 'cached' }), all: restStale, hasResult: (id) => id === 'n3' }).step, 'first');
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: restStale, hasResult: (id) => id === 'n3' }).step, 'approve');

  // everything up to date: nothing is left to approve, "run again" starts at step 1 again and forces all of it
  assert.deepEqual(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: everythingCached }), {
    step: 'first',
    done: true,
    request: { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides }
  });

  // "make step 1 again" while step 2 is due, and when step 1 is due anyway
  assert.deepEqual(approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: restStale, redo: true }), {
    step: 'first',
    done: false,
    request: { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides }
  });
  assert.equal(approvalFlow({ targets: ['n3'], overrides, preview: stale, all: restStale, redo: true }).request.force, true);
  assert.deepEqual(approvalFlow({ targets: ['n3'], overrides, preview: planOf({ n3: 'cached' }), all: restStale, redo: true }).request, { mode: 'node', nodeIds: ['n3'], force: true, overrides });
  // the plans of the node view's states do not matter for the shape of a request: always the form values
  for (const flow of [raw.approvalFlow({ targets: ['n3'], overrides, preview: stale }), raw.approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: restStale }), raw.approvalFlow({ targets: ['n3'], overrides, preview: cachedPreview, all: everythingCached })]) {
    assert.equal(flow.request.overrides, overrides);
  }
}

// The two steps through the real engine, with free nodes only: step 1 makes only the marked output and what it needs, step 2 takes
// that from the cache (a node that counts its runs proves it), "again" makes the needed nodes again and brings step 2 back.
async function testApprovalThroughEngine(tmpDir, created) {
  const appMode = loadApprovalLogic();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  let stamps = 0;
  registry.register({
    type: 'test.stamp',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'text', type: 'text' }],
    execute: async (_ctx, inputs) => {
      stamps += 1;
      return { variants: [{ text: { type: 'text', value: `${inputs.in.value} #${stamps}` } }] };
    }
  });
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
  const node = (id, type, x, params = {}) => ({ id, type, x, y: 0, params });
  const doc = {
    format: 'ocd.workflow',
    version: 1,
    name: 'Approval flow test',
    description: '',
    graph: {
      // topic -> draft (changes with every run) -> [Draft output] and -> final text -> [Final output]
      nodes: [node('n1', 'input.text', 0, { text: 'topic' }), node('n2', 'test.stamp', 300), node('n3', 'output.result', 600, { label: 'Draft' }), node('n4', 'text.template', 600, { template: 'Final: {{a}}' }), node('n5', 'output.result', 900, { label: 'Final' })],
      edges: [
        { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'in' } },
        { id: 'e2', from: { node: 'n2', port: 'text' }, to: { node: 'n3', port: 'inputs' } },
        { id: 'e3', from: { node: 'n2', port: 'text' }, to: { node: 'n4', port: 'a' } },
        { id: 'e4', from: { node: 'n4', port: 'text' }, to: { node: 'n5', port: 'inputs' } }
      ],
      notes: [],
      groups: []
    },
    app: { enabled: true, title: 'Two steps', description: '', inputs: [{ node: 'n1', param: 'text', label: 'Topic' }], outputs: [{ node: 'n5', label: 'Final' }, { node: 'n3', label: 'Draft', approve: true }] }
  };
  const made = await wfStore.createWorkflow({ document: doc });
  created.workflows.push(made.workflow.id);
  created.sessions.push(made.workflow.sessionId);
  const id = made.workflow.id;
  const app = (await wfStore.readWorkflow(id)).app;
  const targets = appMode.approvalTargets(app.outputs, (nodeId) => made.workflow.graph.nodes.some((item) => item.id === nodeId));
  assert.deepEqual(targets, ['n3'], 'only the marked output is shown first');

  // what the app view does: both plans for the form values, the results it shows, then the decision
  const decide = async (overrides, extra = {}) => {
    const results = await wfStore.readResults(id);
    const hasResult = (nodeId) => Boolean(results.nodes[nodeId] && results.nodes[nodeId].selected);
    const preview = await engine.plan(id, appMode.previewRequest({ targets, overrides }));
    const all = await engine.plan(id, { mode: 'all', force: false, overrides });
    return { preview, all, flow: appMode.approvalFlow({ targets, overrides, preview, all, hasResult, ...extra }) };
  };
  const run = async (request) => {
    const runId = await engine.start(id, { ...request, user: 'tester' });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    return record;
  };
  const statuses = (record) => Object.fromEntries(Object.entries(record.nodes).map(([nodeId, entry]) => [nodeId, entry.status]));
  const overrides = { n1: { text: 'a topic' } };

  // nothing made yet: step 1
  let state = await decide(overrides);
  assert.equal(state.flow.step, 'first');
  assert.deepEqual(state.flow.request, { mode: 'node', nodeIds: ['n3'], force: false, overrides });
  assert.deepEqual([...state.preview.order].sort(), ['n1', 'n2', 'n3'], 'the plan of step 1 holds the output and what it needs');
  assert.deepEqual(Object.keys(state.all.nodes).sort(), ['n1', 'n2', 'n3', 'n4', 'n5']);

  // step 1 runs the marked output with its predecessors and nothing else
  const first = await run(state.flow.request);
  assert.deepEqual(statuses(first), { n1: 'done', n2: 'done', n3: 'done' });
  assert.equal(first.mode, 'node');
  assert.equal(stamps, 1);
  const shown = (await wfStore.readResults(id)).nodes;
  assert.equal(shown.n3.history.length, 1, 'the marked output has its result');
  assert.equal(shown.n5, undefined, 'the other output has none yet');

  // step 2 is due now, and it is the whole flow
  state = await decide(overrides);
  assert.deepEqual(state.flow, { step: 'approve', done: false, request: { mode: 'all', force: false, overrides } });
  assert.deepEqual(Object.fromEntries(Object.entries(state.all.nodes).map(([nodeId, entry]) => [nodeId, entry.status])), { n1: 'cached', n2: 'cached', n3: 'cached', n4: 'stale', n5: 'stale' }, 'the plan of step 2 counts only what is left');
  // a change of the form: step 1 is due again, nothing is remembered
  state = await decide({ n1: { text: 'another topic' } });
  assert.equal(state.flow.step, 'first');
  assert.deepEqual(state.flow.request.overrides, { n1: { text: 'another topic' } });
  // ... and back to the old value: step 2 again (the same values give the same cache keys)
  assert.equal((await decide(overrides)).flow.step, 'approve');

  // step 2: the results of step 1 come from the cache, only the rest is made
  const second = await run((await decide(overrides)).flow.request);
  assert.deepEqual(statuses(second), { n1: 'cached', n2: 'cached', n3: 'cached', n4: 'done', n5: 'done' });
  assert.equal(second.mode, 'all');
  assert.equal(stamps, 1, 'the node of step 1 ran once, step 2 did not make it again');
  assert.equal(second.cost.usd, 0);

  // everything is up to date: "Run again" is step 1 again, forced and with everything it needs, so the approval is asked once more
  state = await decide(overrides);
  assert.equal(state.flow.step, 'first');
  assert.equal(state.flow.done, true);
  assert.equal(state.flow.request.force, true);
  assert.deepEqual([...state.flow.request.nodeIds].sort(), ['n1', 'n2', 'n3']);
  const again = await run(state.flow.request);
  assert.deepEqual(statuses(again), { n1: 'done', n2: 'done', n3: 'done' }, 'nothing of it comes from the cache, nothing after it runs');
  assert.equal(stamps, 2);

  // the new draft is not the one the final text was made from: step 2 is due again
  state = await decide(overrides);
  assert.equal(state.flow.step, 'approve');
  assert.equal(state.all.nodes.n4.status, 'stale');
  // "make step 1 again" while step 2 is due
  const redo = (await decide(overrides, { redo: true })).flow;
  assert.equal(redo.step, 'first');
  assert.equal(redo.request.force, true);
  const redone = await run(redo.request);
  assert.deepEqual(statuses(redone), { n1: 'done', n2: 'done', n3: 'done' });
  assert.equal(stamps, 3);
  assert.equal((await decide(overrides)).flow.step, 'approve');
  const finished = await run((await decide(overrides)).flow.request);
  assert.deepEqual(statuses(finished), { n1: 'cached', n2: 'cached', n3: 'cached', n4: 'done', n5: 'done' });
  assert.equal(stamps, 3);
  assert.equal((await decide(overrides)).flow.done, true);

  // the saved graph never changed: the form values only travelled as overrides
  assert.equal((await wfStore.readWorkflow(id)).graph.nodes.find((item) => item.id === 'n1').params.text, 'topic');
}

/* ---------- static checks of the browser wiring ---------- */

function definedClasses() {
  const css = read('public/nodes/nodes.css');
  const set = new Set();
  for (const match of css.matchAll(/\.(nv-[a-z0-9-]+)/g)) set.add(match[1]);
  return set;
}

function usedClasses(source) {
  const used = new Set();
  for (const match of source.matchAll(/class:\s*(?:`([^`]*)`|'([^']*)')/g)) {
    const text = (match[1] || match[2]).replace(/\$\{[^}]*\}/g, ' ');
    for (const name of text.split(/\s+/)) if (/^nv-[a-z0-9-]+$/.test(name)) used.add(name);
  }
  for (const match of source.matchAll(/classList\.(?:add|toggle|remove)\('(nv-[a-z0-9-]+)'/g)) used.add(match[1]);
  return used;
}

// classes that only serve as JS hooks or containers (no rule of their own)
const HOOK_CLASSES = new Set(['nv-appbar-label', 'nv-apprun-label', 'nv-ap', 'nv-confirm', 'nv-scroll']);

function testStatic() {
  const modules = ['public/nodes/app-mode.js', 'public/nodes/asset-picker.js'];
  const css = definedClasses();
  for (const file of modules) {
    const source = read(file);
    assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(source.replace(/\/\/.*$/gm, '')), `${file}: no native dialogs`);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${file}: no innerHTML`);
    for (const name of usedClasses(source)) assert.ok(css.has(name) || HOOK_CLASSES.has(name), `${file}: CSS class ${name} is defined in nodes.css`);
  }

  // script order in the page: picker and app view come after node-ui / run and before main
  const html = read('public/index.html');
  const order = ['nodes/node-ui.js', 'nodes/asset-picker.js', 'nodes/run.js', 'nodes/app-mode.js', 'nodes/main.js'].map((name) => html.indexOf(name));
  assert.ok(order.every((index) => index > 0), 'all node scripts are included');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'node scripts are in dependency order');

  // hash routing knows the app view
  const main = read('public/nodes/main.js');
  assert.match(main, /#app=|app=/);
  assert.match(main, /is-appview/);

  // the workflow share dialog offers teams like the chat dialog: it loads them and passes them to the form
  const start = main.indexOf('async function openShareDialog');
  assert.ok(start > 0, 'main.js has the workflow share dialog');
  const shareDialog = main.slice(start, main.indexOf('\n  }\n', start));
  assert.match(shareDialog, /access\.loadOwnTeams\(\{ refresh: true \}\)/, 'the share dialog loads the teams');
  assert.match(shareDialog, /access\.shareForm\(\{ entry, members, teams \}\)/, 'the share dialog passes the teams to the form');
}

function testI18n() {
  const context = { window: {} };
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), context);
  const source = read('public/nodes/i18n-nodes.js');
  const keys = new Set();
  for (const match of source.matchAll(/\[\s*'(nodes\.[A-Za-z0-9_.]+)',/g)) keys.add(match[1]);
  for (const file of ['public/nodes/app-mode.js', 'public/nodes/asset-picker.js']) {
    for (const match of read(file).matchAll(/\bT\('(nodes\.[A-Za-z0-9_.]+)'/g)) assert.ok(keys.has(match[1]), `${file}: i18n key ${match[1]} exists`);
  }
  for (const key of ['nodes.app.batchCount', 'nodes.app.batchTruncated']) assert.ok(keys.has(key));
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-app-'));
  const created = { workflows: [], sessions: [] };
  try {
    testCounter();
    testAppValidation();
    await testBatch(tmpDir, created);
    testApprovalField();
    await testApprovalStore(tmpDir, created);
    testApprovalFlow();
    await testApprovalThroughEngine(tmpDir, created);
    testStatic();
    testI18n();
  } finally {
    for (const sessionId of created.sessions) await store.deleteSession(sessionId).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-app.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
