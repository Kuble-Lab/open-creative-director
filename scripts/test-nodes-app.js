'use strict';

// Design App of the node view (SPEC §14, WP7): logic of the frontend modules that runs without a DOM
// (batch counter parity with the server's list parser), server-side validation of the app section,
// a free local flow with an exposed text list that runs as a batch through the engine (overrides,
// no change of the saved graph), and static checks of the browser wiring (script order, no native
// dialogs, no innerHTML, every CSS class of the new modules is defined, i18n keys exist in three languages).
// The optional approval steps (outputs marked `approve`): the field in the app section (`true` for step 1, also
// written as 1, a whole number from 2 to 5 for a later step, anything else dropped; the hint of a marked output;
// in the server and in the client, through save, export, import and duplicate), the pure decision of the app view
// (which step is due, which request starts it; with marks of one stage exactly the decision of before, checked
// against a frozen copy of it) and the whole flow through the real engine, with one stage (step 1 makes only the
// marked outputs, step 2 takes their results from the cache, "again" is forced) and with two (a stage that needs
// an upload waits for it while the first one stays in the cache, the last step makes the rest).

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

function testOptionalFields() {
  const source = read('public/nodes/app-mode.js');
  const body = source.match(/function validateForm\(needed = null\) \{[\s\S]*?\n    \}/)[0];
  const fields = ['videos', 'photos', 'music'].map((key) => ({
    key, visible: true, entry: { optional: true }, node: { id: key, type: 'input.media_list' }, param: { kind: 'assets' }
  }));
  const state = { fields, values: new Map([['photos', [{ assetId: 'photo' }]]]) };
  const validate = new Function('s', 'T', 'updateFieldMeta', 'countTextItems', `${body}; return validateForm;`)(state, (key) => key, () => {}, () => 0);
  assert.equal(validate(), null, 'Photos only with generated music passes the form');
  fields.push({ key: 'required', visible: true, entry: {}, node: { id: 'required' }, param: { kind: 'assets' } });
  assert.equal(validate().key, 'required', 'Existing required uploads stay required');
  const graph = freeGraph();
  const raw = { inputs: [{ node: 'n1', param: 'text', label: 'Lines', optional: true }], outputs: [] };
  assert.equal(normalizeApp(raw, graph).inputs[0].optional, true, 'The store preserves optional fields');
  assert.equal(extractClientNormalizeApp()(raw).inputs[0].optional, true, 'The browser preserves optional fields');
  assert.equal(normalizeApp({ ...raw, inputs: [{ ...raw.inputs[0], optional: 'true' }] }, graph).inputs[0].optional, undefined);
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

// Values that are no mark (step 1 is `true` or 1, a later step a whole number from 2 to 5): the store and the browser drop them.
const WRONG_MARKS = ['yes', 'true', 'TRUE', '1', '2', 0, 6, 1.5, 2.5, -1, NaN, Infinity, null, false, undefined, {}, []];

// The step of a mark as the node view reads it (public/nodes/main.js): cut out of the source like normalizeApp
function extractApproveStepOf() {
  const match = read('public/nodes/main.js').match(/function approveStepOf\(entry\) \{[\s\S]*?\n  \}\n/);
  assert.ok(match, 'main.js has approveStepOf');
  return new Function(`${match[0]}; return approveStepOf;`)();
}

function testApprovalField() {
  const graph = freeGraph();
  const server = (outputs) => normalizeApp({ enabled: true, inputs: [], outputs }, graph).outputs;
  const client = extractClientNormalizeApp();
  const clientOutputs = (outputs) => client({ enabled: true, inputs: [], outputs }).outputs;
  for (const [name, outputsOf] of [['server', server], ['client', clientOutputs]]) {
    // `true` is step 1 and stays; 1 is step 1 as well and is stored as `true` (the way every app of before stores it)
    assert.deepEqual(outputsOf([{ node: 'n4', label: 'Cards', approve: true }]), [{ node: 'n4', label: 'Cards', approve: true }], `${name}: true stays`);
    assert.deepEqual(outputsOf([{ node: 'n4', label: 'Cards', approve: 1 }]), [{ node: 'n4', label: 'Cards', approve: true }], `${name}: 1 is step 1, stored as true`);
    // a later step is a whole number from 2 to 5 and stays as it is
    for (const step of [2, 3, 4, 5]) assert.deepEqual(outputsOf([{ node: 'n4', label: 'Cards', approve: step }]), [{ node: 'n4', label: 'Cards', approve: step }], `${name}: step ${step} stays`);
    // anything else is no mark and does not stay (no key at all)
    for (const wrong of WRONG_MARKS) {
      const [entry] = outputsOf([{ node: 'n4', label: 'Cards', approve: wrong }]);
      assert.deepEqual(entry, { node: 'n4', label: 'Cards' }, `${name}: ${JSON.stringify(wrong)} is dropped`);
      assert.equal('approve' in entry, false, `${name}: no approve key for ${JSON.stringify(wrong)}`);
    }
    // an output without the field, and one of an app of before, is stored as it always was, byte for byte
    assert.equal(JSON.stringify(outputsOf([{ node: 'n4', label: 'Cards' }])), '[{"node":"n4","label":"Cards"}]', `${name}: unchanged without the field`);
    assert.equal(JSON.stringify(outputsOf([{ node: 'n4', label: 'Cards', approve: true }])), '[{"node":"n4","label":"Cards","approve":true}]', `${name}: unchanged with the mark of before`);
    // the hint of a marked output: a text, trimmed, of at most 300 characters, after the mark; anything else is dropped. It stays without a mark
    // as well (the app view shows it only with one), so taking the mark away and giving it back keeps it
    assert.equal(JSON.stringify(outputsOf([{ hint: '  Upload the song.  ', approve: 2, label: 'Cards', node: 'n4' }])), '[{"node":"n4","label":"Cards","approve":2,"hint":"Upload the song."}]', `${name}: the hint, trimmed, in a fixed order`);
    assert.equal([...outputsOf([{ node: 'n4', label: 'Cards', approve: true, hint: '\u{1F3B5}'.repeat(400) }])[0].hint].length, 300, `${name}: at most 300 characters`);
    for (const wrong of ['', '   ', 5, null, {}, ['a'], true]) assert.equal('hint' in outputsOf([{ node: 'n4', label: 'Cards', approve: true, hint: wrong }])[0], false, `${name}: hint ${JSON.stringify(wrong)} is dropped`);
    assert.deepEqual(outputsOf([{ node: 'n4', label: 'Cards', hint: 'Later.' }]), [{ node: 'n4', label: 'Cards', hint: 'Later.' }], `${name}: a hint without a mark stays`);
  }
  // the server and the browser agree on every value
  for (const approve of [true, 1, 2, 3, 4, 5, ...WRONG_MARKS]) {
    for (const hint of [undefined, '', ' x ', 'Upload it.', 7]) {
      const entry = [{ node: 'n4', label: 'Cards', approve, hint }];
      assert.equal(JSON.stringify(clientOutputs(entry)), JSON.stringify(server(entry)), `approve ${JSON.stringify(approve)}, hint ${JSON.stringify(hint)}`);
    }
  }
  // the step the node view reads from an entry: 1 for step 1, 2 to 5, 0 without a mark
  const approveStepOf = extractApproveStepOf();
  assert.deepEqual([true, 1, 2, 3, 4, 5].map((approve) => approveStepOf({ node: 'n4', approve })), [1, 1, 2, 3, 4, 5]);
  for (const wrong of WRONG_MARKS) assert.equal(approveStepOf({ node: 'n4', approve: wrong }), 0, `${JSON.stringify(wrong)} is no step`);
  assert.equal(approveStepOf(undefined), 0);
  assert.equal(approveStepOf({ node: 'n4' }), 0);
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

  // a later step and its hint take the same ways
  const staged = [{ node: 'n4', label: 'Cards', approve: 3, hint: 'Upload the song, then go on.' }];
  const stagedId = track(await wfStore.createWorkflow({ document: { ...doc, app: { ...doc.app, outputs: staged } } }));
  assert.deepEqual((await wfStore.readWorkflow(stagedId)).app.outputs, staged, 'an imported document keeps the step and the hint');
  const stagedExport = await wfStore.exportWorkflow(stagedId);
  assert.deepEqual(stagedExport.app.outputs, staged, 'the export carries them');
  assert.deepEqual((await wfStore.readWorkflow(track(await wfStore.createWorkflow({ document: stagedExport })))).app.outputs, staged, 'and an import of that export keeps them');
  assert.deepEqual((await wfStore.readWorkflow(track(await wfStore.duplicateWorkflow(stagedId)))).app.outputs, staged, 'a copy keeps them');
  let stagedNow = await wfStore.readWorkflow(stagedId);
  await wfStore.saveGraph(stagedId, { baseRev: stagedNow.rev, graph: stagedNow.graph, name: 'renamed' });
  stagedNow = await wfStore.readWorkflow(stagedId);
  assert.deepEqual(stagedNow.app.outputs, staged, 'a save without app keeps them');
  // a step out of range is no mark; the hint stays for a mark given later
  await wfStore.saveGraph(stagedId, { baseRev: stagedNow.rev, graph: stagedNow.graph, app: { ...stagedNow.app, outputs: [{ ...staged[0], approve: 6 }] } });
  assert.deepEqual((await wfStore.readWorkflow(stagedId)).app.outputs, [{ node: 'n4', label: 'Cards', hint: 'Upload the song, then go on.' }]);
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
    plain,
    approvalTargets: (...args) => plain(raw.approvalTargets(...args)),
    approvalStages: (...args) => plain(raw.approvalStages(...args)),
    previewRequest: (...args) => plain(raw.previewRequest(...args)),
    stageFlow: (...args) => plain(raw.stageFlow(...args)),
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

// The decision of the app view with one stage of marks, as it was before there were stages (app-mode.js of 2026-10-07), frozen: an app of
// before must get the same step and the same request, byte for byte. (A mark of 1 did not exist then: the store dropped it.)
const LEGACY = (() => {
  function allCached(plan) {
    const nodes = plan && plan.nodes ? Object.values(plan.nodes) : [];
    return nodes.length > 0 && nodes.every((node) => node.status === 'cached');
  }
  function approvalTargets(outputs, hasNode) {
    const ids = [];
    for (const entry of Array.isArray(outputs) ? outputs : []) {
      if (entry && entry.approve === true && typeof entry.node === 'string' && hasNode(entry.node) && !ids.includes(entry.node)) ids.push(entry.node);
    }
    return ids;
  }
  function previewRequest({ targets, overrides, force = false, order = null }) {
    const nodeIds = force && Array.isArray(order) && order.length ? order.slice() : targets.slice();
    return { mode: nodeIds.length === 1 ? 'node' : 'selection', nodeIds, force, overrides };
  }
  function approvalFlow({ targets, overrides, preview, all = null, hasResult = () => true, redo = false }) {
    if (!targets || !targets.length) return null;
    const nodes = (preview && preview.nodes) || {};
    const current = targets.every((id) => nodes[id] && nodes[id].status === 'cached' && hasResult(id));
    const done = current && allCached(all);
    if (current && !done && !redo) return { step: 'approve', done: false, request: { mode: 'all', force: false, overrides } };
    return { step: 'first', done, request: previewRequest({ targets, overrides, force: redo || done, order: preview && preview.order }) };
  }
  return { approvalTargets, previewRequest, approvalFlow };
})();

// Apps of before (marks of one stage): the same marked outputs, and in every state the same step and request as before, byte for byte;
// the stages of such an app are one stage, and stageFlow says the same in its own words (index 0 is step 1, index 1 the approval).
function testOneStageAsBefore() {
  const { raw, plain, approvalTargets, approvalStages, approvalFlow, stageFlow } = loadApprovalLogic();
  const exists = (id) => ['n3', 'n5', 'n7'].includes(id);
  const outputsOfBefore = [
    [{ node: 'n5', approve: true }, { node: 'n3' }, { node: 'n7', approve: true }, { node: 'n5', approve: true }, { node: 'gone', approve: true }],
    [{ node: 'n3', approve: true }],
    [{ node: 'n3' }, { node: 'n5' }],
    [{ node: 'n3', approve: 'yes' }, { node: 'n5', approve: true }],
    []
  ];
  for (const outputs of outputsOfBefore) {
    assert.deepEqual(approvalTargets(outputs, exists), LEGACY.approvalTargets(outputs, exists), JSON.stringify(outputs));
    const stages = approvalStages(outputs, exists);
    assert.deepEqual(stages, LEGACY.approvalTargets(outputs, exists).length ? [LEGACY.approvalTargets(outputs, exists)] : [], `one stage: ${JSON.stringify(outputs)}`);
  }
  const overrides = { n1: { text: 'topic' } };
  const statusesOf = (status) => (status === 'missing' ? {} : { n1: 'cached', n2: status, n3: status, n5: status });
  const previews = [null, undefined, planOf({}), ...['cached', 'stale', 'forced', 'invalid', 'unavailable', 'missing'].map((status) => planOf(statusesOf(status))), planOf({ n1: 'cached', n3: 'cached', n5: 'stale' })];
  const alls = [null, planOf({}), planOf({ n1: 'cached', n3: 'cached', n5: 'cached', n9: 'stale' }), planOf({ n1: 'cached', n3: 'cached', n5: 'cached', n9: 'cached' })];
  const results = [() => true, () => false, (id) => id === 'n3'];
  let cases = 0;
  for (const targets of [['n3'], ['n3', 'n5'], [], undefined]) {
    for (const preview of previews) {
      for (const all of alls) {
        for (const hasResult of results) {
          for (const redo of [false, true]) {
            const args = { targets, overrides, preview, all, hasResult, redo };
            const before = LEGACY.approvalFlow(args);
            const now = raw.approvalFlow(args);
            assert.equal(JSON.stringify(now), JSON.stringify(before), `as before: ${JSON.stringify({ targets, preview, all, redo, result: hasResult('n5') })}`);
            if (before) assert.equal(now.request.overrides, overrides, 'the same values as the form');
            const flow = targets && targets.length ? stageFlow({ stages: [targets], overrides, previews: [preview], all, hasResult, redo }) : null;
            if (before) assert.deepEqual([flow.index === 0 ? 'first' : 'approve', flow.done, flow.total, flow.request], [before.step, before.done, 2, plain(before.request)]);
            cases += 1;
          }
        }
      }
    }
  }
  assert.ok(cases > 500, `${cases} states compared`);
  assert.equal(approvalFlow({ targets: ['n3'], overrides }).step, 'first');
}

// Several stages (SPEC §14): the stage of a mark, the outputs by stage, and the step that is due with its request.
function testStageFlow() {
  const { raw, approvalTargets, approvalStages, stageFlow } = loadApprovalLogic();
  const exists = (id) => ['n3', 'n5', 'n7', 'n8', 'n9'].includes(id);

  // the stage of a mark: 1 for true and 1, 2 to 5, 0 for anything else
  assert.deepEqual([true, 1, 2, 3, 4, 5].map((value) => raw.approvalStage(value)), [1, 1, 2, 3, 4, 5]);
  for (const wrong of WRONG_MARKS) assert.equal(raw.approvalStage(wrong), 0, `${JSON.stringify(wrong)} is no stage`);

  // the outputs by stage: the lowest stage first, the order of the app inside a stage, a node once (with its first mark), outputs that are
  // gone and stages without outputs left out: marks 1 and 3 are two steps of approval, not three
  assert.deepEqual(
    approvalStages([{ node: 'n9', approve: 3 }, { node: 'n3' }, { node: 'n5', approve: true }, { node: 'n7', approve: 3 }, { node: 'n5', approve: 2 }, { node: 'gone', approve: 2 }, { node: 'n8', approve: 'x' }], exists),
    [['n5'], ['n9', 'n7']]
  );
  assert.deepEqual(approvalStages([{ node: 'n3', approve: true }, { node: 'n5', approve: 1 }], exists), [['n3', 'n5']], 'true and 1 are the same step');
  assert.deepEqual(approvalStages([{ node: 'n3', approve: 5 }], exists), [['n3']], 'a single stage is step 1, whatever its number');
  assert.deepEqual(approvalStages(undefined, exists), []);
  assert.deepEqual(approvalStages([null, 'n3', { node: 3, approve: 2 }], exists), []);
  // every marked output, of any stage, in the order of the app
  assert.deepEqual(approvalTargets([{ node: 'n9', approve: 3 }, { node: 'n5', approve: true }, { node: 'n3', approve: 0 }], exists), ['n9', 'n5']);

  // no stage, or a stage without outputs: nothing to decide
  for (const stages of [[], null, undefined, [[]], [['n3'], []], 'n3']) assert.equal(stageFlow({ stages, overrides: {} }), null, JSON.stringify(stages));

  // two stages, three steps. Stage 1 is the Suno pack (n3, made from the idea n1); stage 2 the board and the sheet (n7, n8), made from the idea
  // and the song (n4, an upload); the rest makes the film (n9)
  const overrides = { n1: { text: 'idea' } };
  const stages = [['n3'], ['n7', 'n8']];
  const pack = (status) => planOf({ n1: 'cached', n2: status, n3: status });
  const board = (status) => planOf({ n1: 'cached', n4: status, n5: status, n7: status, n8: status });
  const film = (pack3, board78, rest) => planOf({ n1: 'cached', n2: pack3, n3: pack3, n4: board78, n5: board78, n7: board78, n8: board78, n6: rest, n9: rest });
  const decide = (previews, all, extra = {}) => stageFlow({ stages, overrides, previews, all, ...extra });

  // nothing made: step 1 of 3, the pack and what it needs
  assert.deepEqual(decide([pack('stale'), board('stale')], film('stale', 'stale', 'stale')), { index: 0, total: 3, done: false, request: { mode: 'node', nodeIds: ['n3'], force: false, overrides } });
  assert.equal(decide([null, null], null).index, 0, 'while the plans are not there');
  // the pack is made, the song is not there (the plan of stage 2 is invalid): step 2 is due, its request makes only the outputs of stage 2;
  // the pack is not forced, it comes from the cache. The app view checks the form for it and starts nothing without the song
  assert.deepEqual(decide([pack('cached'), board('invalid')], film('cached', 'invalid', 'invalid')), { index: 1, total: 3, done: false, request: { mode: 'selection', nodeIds: ['n7', 'n8'], force: false, overrides } });
  // with the song: the same step, now with a valid plan
  assert.deepEqual(decide([pack('cached'), board('stale')], film('cached', 'stale', 'stale')).request, { mode: 'selection', nodeIds: ['n7', 'n8'], force: false, overrides });
  // stage 2 made: the last step makes everything, not forced
  assert.deepEqual(decide([pack('cached'), board('cached')], film('cached', 'cached', 'stale')), { index: 2, total: 3, done: false, request: { mode: 'all', force: false, overrides } });
  assert.equal(decide([pack('cached'), board('cached')], null).index, 2, 'while the plan of everything is not known');
  // everything made: "Run again" begins at step 1 again, forced, with what stage 1 needs
  assert.deepEqual(decide([pack('cached'), board('cached')], film('cached', 'cached', 'cached')), { index: 0, total: 3, done: true, request: { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides } });
  // the lowest stage that is not up to date is due: a new idea makes the pack stale again, even with the board still in the cache
  assert.equal(decide([pack('stale'), board('cached')], film('stale', 'cached', 'cached')).index, 0);
  // up to date means: cached and with a result the app can show
  assert.equal(decide([pack('cached'), board('cached')], film('cached', 'cached', 'stale'), { hasResult: (id) => id !== 'n8' }).index, 1);
  assert.equal(decide([pack('cached'), board('cached')], film('cached', 'cached', 'stale'), { hasResult: (id) => id !== 'n3' }).index, 0);
  assert.equal(decide([pack('cached')], film('cached', 'cached', 'stale')).index, 1, 'a stage without its plan is not up to date');

  // "make step n again": the stage that stands for approval, forced with what it needs
  assert.deepEqual(decide([pack('cached'), board('invalid')], null, { redo: true }), { index: 0, total: 3, done: false, request: { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides } });
  assert.deepEqual(decide([pack('cached'), board('cached')], film('cached', 'cached', 'stale'), { redo: true }), {
    index: 1,
    total: 3,
    done: false,
    request: { mode: 'selection', nodeIds: ['n1', 'n4', 'n5', 'n7', 'n8'], force: true, overrides }
  });
  assert.deepEqual(decide([pack('stale'), board('stale')], null, { redo: true }), { index: 0, total: 3, done: false, request: { mode: 'selection', nodeIds: ['n1', 'n2', 'n3'], force: true, overrides } }, 'step 1 is due itself: it is made again');
  // with everything done the flow is the one of "Run again" (the app view shows no redo button then)
  assert.equal(decide([pack('cached'), board('cached')], film('cached', 'cached', 'cached'), { redo: true }).done, true);
  // the request always carries the values of the form itself
  assert.equal(raw.stageFlow({ stages, overrides, previews: [pack('cached'), board('stale')] }).request.overrides, overrides);
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

// Two stages through the real engine, with free nodes only, in the shape of the music video with the song by Suno: the idea makes the pack
// (stage 1); the idea and an upload make the board (stage 2); the board makes the film (the last step). A node that counts its runs per node
// proves what comes from the cache; the upload is a test node that is invalid without its file, like an empty song field.
async function testStagesThroughEngine(tmpDir, created) {
  const appMode = loadApprovalLogic();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const runs = {};
  registry.register({
    type: 'test.count',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'text', type: 'text' }],
    execute: async (ctx, inputs) => {
      runs[ctx.nodeId] = (runs[ctx.nodeId] || 0) + 1;
      return { variants: [{ text: { type: 'text', value: `${inputs.in.value} #${runs[ctx.nodeId]}` } }] };
    }
  });
  registry.register({
    type: 'test.upload',
    category: 'input',
    inputs: [],
    outputs: [{ id: 'text', type: 'text' }],
    params: [{ id: 'file', kind: 'text', default: '' }],
    validate: (params) => (params.file ? [] : [{ code: 'no_asset', message: 'file: no asset selected' }]),
    execute: async (_ctx, _inputs, params) => ({ variants: [{ text: { type: 'text', value: params.file } }] })
  });
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
  const node = (id, type, x, params = {}) => ({ id, type, x, y: 0, params });
  const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
  const doc = {
    format: 'ocd.workflow',
    version: 1,
    name: 'Stages test',
    description: '',
    graph: {
      // idea -> pack -> [Pack]; idea + song -> board -> [Board] -> film -> [Film]
      nodes: [
        node('n1', 'input.text', 0, { text: 'idea' }),
        node('n2', 'test.count', 300),
        node('n3', 'output.result', 600, { label: 'Pack' }),
        node('n4', 'test.upload', 0),
        node('n5', 'text.template', 300, { template: '{{a}} / {{b}}' }),
        node('n6', 'test.count', 600),
        node('n7', 'output.result', 900, { label: 'Board' }),
        node('n8', 'test.count', 900),
        node('n9', 'output.result', 1200, { label: 'Film' })
      ],
      edges: [
        edge('e1', 'n1', 'text', 'n2', 'in'),
        edge('e2', 'n2', 'text', 'n3', 'inputs'),
        edge('e3', 'n1', 'text', 'n5', 'a'),
        edge('e4', 'n4', 'text', 'n5', 'b'),
        edge('e5', 'n5', 'text', 'n6', 'in'),
        edge('e6', 'n6', 'text', 'n7', 'inputs'),
        edge('e7', 'n6', 'text', 'n8', 'in'),
        edge('e8', 'n8', 'text', 'n9', 'inputs')
      ],
      notes: [],
      groups: []
    },
    app: {
      enabled: true,
      title: 'Three steps',
      description: '',
      inputs: [{ node: 'n1', param: 'text', label: 'Idea' }, { node: 'n4', param: 'file', label: 'Song' }],
      outputs: [{ node: 'n9', label: 'Film' }, { node: 'n3', label: 'Pack', approve: true, hint: 'Make the song and upload it.' }, { node: 'n7', label: 'Board', approve: 2 }]
    }
  };
  const made = await wfStore.createWorkflow({ document: doc });
  created.workflows.push(made.workflow.id);
  created.sessions.push(made.workflow.sessionId);
  const id = made.workflow.id;
  const app = (await wfStore.readWorkflow(id)).app;
  assert.deepEqual(app.outputs.map((entry) => [entry.node, entry.approve, entry.hint]), [['n9', undefined, undefined], ['n3', true, 'Make the song and upload it.'], ['n7', 2, undefined]], 'the store keeps the stages and the hint');
  const stages = appMode.approvalStages(app.outputs, (nodeId) => made.workflow.graph.nodes.some((item) => item.id === nodeId));
  assert.deepEqual(stages, [['n3'], ['n7']]);

  // what the app view does: the plan of every stage and of everything for the form values, the results it shows, then the decision
  const decide = async (overrides, extra = {}) => {
    const results = await wfStore.readResults(id);
    const hasResult = (nodeId) => Boolean(results.nodes[nodeId] && results.nodes[nodeId].selected);
    const previews = [];
    for (const targets of stages) previews.push(await engine.plan(id, appMode.previewRequest({ targets, overrides })));
    const all = await engine.plan(id, { mode: 'all', force: false, overrides });
    return { previews, all, flow: appMode.stageFlow({ stages, overrides, previews, all, hasResult, ...extra }) };
  };
  const run = async (request) => {
    const runId = await engine.start(id, { ...request, user: 'tester' });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    return record;
  };
  const statuses = (record) => Object.fromEntries(Object.entries(record.nodes).map(([nodeId, entry]) => [nodeId, entry.status]));
  const noSong = { n1: { text: 'an idea' } };
  const withSong = { n1: { text: 'an idea' }, n4: { file: 'song.mp3' } };

  // step 1 of 3 without the song: the plan of the pack is valid, the ones of the board and of everything are not
  let state = await decide(noSong);
  assert.deepEqual([state.flow.index, state.flow.total, state.flow.done], [0, 3, false]);
  assert.deepEqual(state.flow.request, { mode: 'node', nodeIds: ['n3'], force: false, overrides: noSong });
  assert.equal(state.previews[0].valid, true, 'the pack needs no song');
  assert.equal(state.previews[1].valid, false, 'the board does');
  assert.deepEqual(state.previews[1].issues.filter((issue) => issue.level === 'error').map((issue) => [issue.nodeId, issue.code]), [['n4', 'no_asset']]);
  assert.ok(state.previews[1].order.includes('n4'), 'the plan of stage 2 names the node of the song: the app view checks that field before it starts');
  const first = await run(state.flow.request);
  assert.deepEqual(statuses(first), { n1: 'done', n2: 'done', n3: 'done' }, 'stage 1 runs without the song');
  assert.deepEqual(runs, { n2: 1 });

  // step 2 is due, but its request is invalid until the song is there; nothing ran for it
  state = await decide(noSong);
  assert.deepEqual([state.flow.index, state.flow.request], [1, { mode: 'node', nodeIds: ['n7'], force: false, overrides: noSong }]);
  assert.equal(state.previews[1].valid, false);
  await assert.rejects(engine.start(id, { ...state.flow.request, user: 'tester' }), (error) => Array.isArray(error.issues) && error.issues.some((issue) => issue.code === 'no_asset'), 'the engine refuses it as well');
  // the song is uploaded: the pack stays in the cache, step 2 is due with a valid plan
  state = await decide(withSong);
  assert.equal(state.previews[0].nodes.n3.status, 'cached', 'the pack stays in the cache after the upload');
  assert.deepEqual([state.flow.index, state.previews[1].valid], [1, true]);
  const second = await run(state.flow.request);
  assert.deepEqual(statuses(second), { n1: 'cached', n4: 'done', n5: 'done', n6: 'done', n7: 'done' }, 'stage 2 makes only its part, the pack is not in it');
  assert.deepEqual(runs, { n2: 1, n6: 1 });

  // step 3 (approve and finish): the rest, with both stages from the cache
  state = await decide(withSong);
  assert.deepEqual([state.flow.index, state.flow.request], [2, { mode: 'all', force: false, overrides: withSong }]);
  const third = await run(state.flow.request);
  assert.deepEqual(statuses(third), { n1: 'cached', n2: 'cached', n3: 'cached', n4: 'cached', n5: 'cached', n6: 'cached', n7: 'cached', n8: 'done', n9: 'done' });
  assert.deepEqual(runs, { n2: 1, n6: 1, n8: 1 }, 'nothing of the earlier steps is made or paid again');
  assert.equal(third.cost.usd, 0);

  // everything is up to date: "Run again" begins at step 1, forced
  state = await decide(withSong);
  assert.deepEqual([state.flow.index, state.flow.done, state.flow.request.force], [0, true, true]);
  assert.deepEqual([...state.flow.request.nodeIds].sort(), ['n1', 'n2', 'n3']);
  // "make step 2 again" while step 3 would be due: a new song instead makes stage 2 due, the pack stays
  state = await decide({ ...withSong, n4: { file: 'take-2.mp3' } });
  assert.deepEqual([state.flow.index, state.previews[0].nodes.n3.status], [1, 'cached'], 'a new song: step 2 again, not step 1');
  await run(state.flow.request);
  state = await decide({ ...withSong, n4: { file: 'take-2.mp3' } });
  assert.equal(state.flow.index, 2);
  const redo = (await decide({ ...withSong, n4: { file: 'take-2.mp3' } }, { redo: true })).flow;
  assert.deepEqual([redo.index, redo.request.force, [...redo.request.nodeIds].sort()], [1, true, ['n1', 'n4', 'n5', 'n6', 'n7']]);
  const redone = await run(redo.request);
  assert.deepEqual(statuses(redone), { n1: 'done', n4: 'done', n5: 'done', n6: 'done', n7: 'done' });
  assert.deepEqual(runs, { n2: 1, n6: 3, n8: 1 }, 'the pack was not made again');
  // a new idea: step 1 is due again
  assert.equal((await decide({ ...withSong, n1: { text: 'another idea' } })).flow.index, 0);
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
  // the approval keys of the inspector (the step of a mark) exist too
  for (const match of read('public/nodes/inspector.js').matchAll(/\bT\('(nodes\.app\.approve[A-Za-z0-9_.]*)'/g)) assert.ok(keys.has(match[1]), `inspector.js: i18n key ${match[1]} exists`);

  // An app of before (marks of one stage) reads as before: the texts with steps, filled in for two steps, are the texts of before, word for word
  const { rows } = require('../public/nodes/i18n-nodes');
  const text = (key, lang, vars) => Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), rows.find((row) => row[0] === key)[{ de: 1, en: 2, es: 3 }[lang]]);
  const BEFORE = [
    ['nodes.app.stepFirst', { total: 2, outputs: 'X' }, ['Schritt 1 von 2: Zuerst entsteht nur: X. Danach gibst du frei.', 'Step 1 of 2: first only this is made: X. Then you approve.', 'Paso 1 de 2: primero solo se genera: X. Después apruebas.']],
    ['nodes.app.stepApprove', { step: 2, total: 2, outputs: 'X' }, ['Schritt 2 von 2: Prüfe X. «Freigeben und fertigstellen» erzeugt den Rest.', 'Step 2 of 2: check X. “Approve and finish” makes the rest.', 'Paso 2 de 2: revisa X. «Aprobar y terminar» genera el resto.']],
    ['nodes.app.approveRedo', { step: 1 }, ['Schritt 1 neu erzeugen', 'Make step 1 again', 'Volver a generar el paso 1']],
    ['nodes.app.comesInStep', { step: 2 }, ['Kommt in Schritt 2, nach deiner Freigabe.', 'Comes in step 2, after your approval.', 'Llega en el paso 2, tras tu aprobación.']],
    ['nodes.app.statusStepDone', { step: 1 }, ['Schritt 1 fertig', 'Step 1 done', 'Paso 1 listo']],
    ['nodes.app.approveStart', {}, ['Schritt 1 starten', 'Start step 1', 'Iniciar paso 1']],
    ['nodes.app.approveFinish', {}, ['Freigeben und fertigstellen', 'Approve and finish', 'Aprobar y terminar']]
  ];
  for (const [key, vars, before] of BEFORE) {
    ['de', 'en', 'es'].forEach((lang, index) => assert.equal(text(key, lang, vars), before[index], `${key} ${lang}: as before`));
  }
  // with more stages the button and the line name the step: "Start step 1 of 3", "Approve and go on with step 2"
  assert.equal(text('nodes.app.stageStart', 'de', { step: 1, total: 3 }), 'Schritt 1 von 3 starten');
  assert.equal(text('nodes.app.stageNext', 'de', { step: 2 }), 'Freigeben und weiter mit Schritt 2');
  assert.equal(text('nodes.app.stepHint', 'de', { step: 2, total: 3, hint: 'Lade den Song hoch.' }), 'Schritt 2 von 3: Lade den Song hoch.');
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-app-'));
  const created = { workflows: [], sessions: [] };
  try {
    testCounter();
    testOptionalFields();
    testAppValidation();
    await testBatch(tmpDir, created);
    testApprovalField();
    await testApprovalStore(tmpDir, created);
    testApprovalFlow();
    testOneStageAsBefore();
    testStageFlow();
    await testApprovalThroughEngine(tmpDir, created);
    await testStagesThroughEngine(tmpDir, created);
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
