'use strict';

// Design App of the node view (SPEC §14, WP7): logic of the frontend modules that runs without a DOM
// (batch counter parity with the server's list parser), server-side validation of the app section,
// a free local flow with an exposed text list that runs as a batch through the engine (overrides,
// no change of the saved graph), and static checks of the browser wiring (script order, no native
// dialogs, no innerHTML, every CSS class of the new modules is defined, i18n keys exist in three languages).

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
    testStatic();
    testI18n();
  } finally {
    for (const sessionId of created.sessions) await store.deleteSession(sessionId).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-app ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
