'use strict';

// "Run all again" in the node view (WP38g) and the cards that follow a changed branding:
//   - the entry in the workflow menu (desktop and phone share it), disabled while a run is active, and the button of the inspector
//   - every node runs: the plan is asked with { mode: 'all', force: true }, the question shows the total cost and says which nodes have
//     no known price, a run without paid nodes is asked too (in plain words), cancelling changes nothing (no run is started)
//   - the checks of every run stay: a plan with errors, a budget that does not fit
//   - a node that reads state of the app (plan.stamped, a branding) shows "out of date" when the plan says so, other inputs never do
//   - the page asks the plan again when it comes back to the foreground
//   - the texts are in German, English and Spanish
// The node view runs on the stand-in of scripts/support/fake-dom.js; the server calls are fakes. Nothing is paid.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const { loadPage, FakeNode } = require('./support/fake-dom');
const run = require('../public/nodes/run');
const { rows: nodeRows } = require('../public/nodes/i18n-nodes');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN_ALL_CACHED = { mode: 'all', force: false, valid: true, order: ['b', 'p', 's'], issues: [], totals: { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 }, nodes: { b: { status: 'cached', paid: false }, p: { status: 'cached', paid: true, estimate: null }, s: { status: 'cached', paid: true, estimate: null } } };

function forcedPlan({ unknown = false, paid = true } = {}) {
  const nodes = {
    b: { status: 'forced', paid: false, executions: 1 },
    p: { status: 'forced', paid, estimate: paid ? { usd: 0.5 } : null, executions: 1, lastCost: null },
    s: { status: 'forced', paid, estimate: paid && !unknown ? { usd: 0.3 } : null, executions: 2, lastCost: null }
  };
  return {
    mode: 'all',
    force: true,
    valid: true,
    order: ['b', 'p', 's'],
    targets: ['b', 'p', 's'],
    issues: [],
    nodes,
    totals: paid ? (unknown ? { paidNodes: 2, usd: 0.5, credits: 0, unknownNodes: 1 } : { paidNodes: 2, usd: 1.1, credits: 0, unknownNodes: 0 }) : { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 }
  };
}

async function testController() {
  let restoreAppend = () => {};
  const page = loadPage('de', { scripts: ['node-ui', 'preview'] });
  const OCD = page.OCD;
  const ui = OCD.ui;
  const T = ui.T;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.window = page.window; // the run code reads window.OCAccess (the budget of a participant) when it is there
  try {
    const state = {
      workflow: { id: 'wf1' },
      rev: 7,
      saveState: 'saved',
      conflict: false,
      graph: {
        nodes: [
          { id: 'b', type: 'x.branding', title: 'Branding', params: {} },
          { id: 'p', type: 'x.paid', title: 'Planer', params: {} },
          { id: 's', type: 'x.paid', title: 'Szene', params: {} }
        ],
        edges: [],
        groups: [],
        notes: []
      },
      reg: { types: new Map() },
      results: { version: 1, nodes: {} },
      selection: { nodes: new Set() }
    };
    const calls = [];
    let nextPlan = forcedPlan();
    OCD.api = {
      plan: async (id, request) => {
        calls.push(['plan', id, request]);
        return request.force ? nextPlan : PLAN_ALL_CACHED;
      },
      startRun: async (id, request) => {
        calls.push(['startRun', id, request]);
        return { runId: 'run-1' };
      },
      listRuns: async () => ({ runs: [] }),
      getWorkflow: async () => ({ workflow: state.workflow, results: state.results })
    };
    const dialogs = [];
    const plain = [];
    let answer = false;
    ui.dialog = async (options) => {
      dialogs.push(options);
      return answer;
    };
    ui.confirmDialog = async (options) => {
      plain.push(options);
      return answer;
    };
    const toasts = [];
    ui.toast = (message, options = {}) => toasts.push({ message, kind: options.kind || null });
    const handlers = {};
    OCD.bus = { on: (name, fn) => { handlers[name] = fn; }, emit() {} };
    // the run that a confirmed start begins ends here (its timers must not outlive the test)
    const finish = () => handlers.sse({ type: 'run_finished', runId: 'run-1', status: 'completed' });
    OCD.editor = { getState: () => state, getCanvas: () => null, getInspector: () => null, dom: () => ({ runSlot: page.document.createElement('div') }), flushSave: async () => {} };
    OCD.extensions = { nodeMenu: [], workflowMenu: [] };
    FakeNode.prototype.querySelector = function querySelector(selector) {
      return this.find((item) => item.classes.has(String(selector).replace(/^\./, '')))[0] || null;
    };
    // a browser takes text in append(); the stand-in takes nodes only (the list of errors puts ": " between a name and its text)
    const originalAppend = FakeNode.prototype.append;
    FakeNode.prototype.append = function append(...nodes) {
      return originalAppend.apply(this, nodes.map((node) => {
        if (typeof node !== 'string') return node;
        const span = new FakeNode('span');
        span.textContent = node;
        return span;
      }));
    };
    restoreAppend = () => {
      FakeNode.prototype.append = originalAppend;
    };
    const controller = run.createController({ OCD });
    controller.attach();
    const started = () => calls.filter((call) => call[0] === 'startRun');
    const asked = () => calls.filter((call) => call[0] === 'plan');

    // the entry in the workflow menu
    const menu = () => OCD.extensions.workflowMenu.flatMap((extra) => extra({ workflow: state.workflow }) || []);
    const entry = () => menu().find((item) => item.label === T('nodes.run.menu.runAllAgain'));
    assert.ok(entry(), 'the workflow menu has "Run all again"');
    assert.equal(entry().label, 'Alles neu ausführen');
    assert.equal(entry().disabled, false);
    assert.equal(entry().hint, T('nodes.run.menu.runAllAgainHint'));
    controller.getRunState().active = true;
    assert.equal(entry().disabled, true, 'not while a run is active');
    controller.getRunState().active = false;
    assert.equal(typeof controller.runAllAgain, 'function');

    // paid nodes: the plan is asked with force, the question shows the cost, cancelling starts nothing
    answer = false;
    await controller.runAllAgain();
    assert.equal(asked().length, 1);
    assert.deepEqual(asked()[0].slice(1), ['wf1', { mode: 'all', force: true }], 'the whole workflow, forced');
    assert.equal(dialogs.length, 1, 'the question is asked');
    assert.equal(plain.length, 0);
    const question = dialogs[0];
    assert.equal(question.title, T('nodes.run.confirmAll.title'));
    assert.equal(question.title, 'Alles neu ausführen?');
    const text = question.body.textContent;
    assert.match(text, /Jeder Node läuft neu, auch wenn sein Ergebnis im Cache läge/);
    assert.match(text, /Planer/, 'the paid nodes are listed');
    assert.match(text, /Szene/);
    assert.match(text, /× 2/, 'how often a node runs');
    assert.match(text, /Bekannt: /, 'the total of what is known');
    assert.match(text, /1\.10|1,10/, 'the whole price of the run');
    assert.doesNotMatch(text, /ohne Schätzung/, 'every price is known here');
    assert.deepEqual(question.buttons.map((button) => [button.label, button.value]), [[T('nodes.common.cancel'), false], [T('nodes.run.confirmAll.start'), true]]);
    assert.equal(question.focus, 'cancel');
    assert.equal(started().length, 0, 'cancelling changes nothing: no run');
    assert.equal(controller.getRunState().active, false);

    // an unknown price is said
    nextPlan = forcedPlan({ unknown: true });
    dialogs.length = 0;
    await controller.runAllAgain();
    assert.match(dialogs[0].body.textContent, /1 ohne Schätzung/);
    assert.match(dialogs[0].body.textContent, /Kosten unbekannt/);
    assert.equal(started().length, 0);

    // confirming starts the whole workflow, forced
    nextPlan = forcedPlan();
    answer = true;
    dialogs.length = 0;
    await controller.runAllAgain();
    assert.equal(started().length, 1);
    assert.deepEqual(started()[0], ['startRun', 'wf1', { mode: 'all', force: true, rev: 7 }]);
    assert.equal(controller.getRunState().active, true, 'the run is started');
    finish();
    assert.equal(controller.getRunState().active, false);

    // nothing that costs money: asked all the same, in plain words
    nextPlan = forcedPlan({ paid: false });
    calls.length = 0;
    dialogs.length = 0;
    answer = false;
    await controller.runAllAgain();
    assert.equal(dialogs.length, 0);
    assert.equal(plain.length, 1);
    assert.equal(plain[0].title, T('nodes.run.confirmAll.title'));
    assert.equal(plain[0].message, T('nodes.run.confirmAll.free'));
    assert.equal(plain[0].confirmLabel, T('nodes.run.confirmAll.start'));
    assert.equal(started().length, 0, 'cancelled');
    answer = true;
    await controller.runAllAgain();
    assert.equal(started().length, 1);
    assert.equal(started()[0][2].force, true);
    finish();

    // the ordinary "Run all" is unchanged: from the cache, no question without paid nodes
    calls.length = 0;
    plain.length = 0;
    dialogs.length = 0;
    await controller.startRun({ mode: 'all', force: false });
    assert.deepEqual(asked()[0][2], { mode: 'all', force: false });
    assert.equal(plain.length + dialogs.length, 0);
    assert.equal(started()[0][2].force, false);
    finish();

    // the checks of every run stay: a plan with errors shows them and starts nothing
    calls.length = 0;
    nextPlan = { ...forcedPlan(), valid: false, issues: [{ level: 'error', code: 'missing_input', message: 'Eingang fehlt', nodeId: 'p' }] };
    dialogs.length = 0;
    plain.length = 0;
    await controller.runAllAgain();
    assert.equal(started().length, 0);
    assert.ok(dialogs.length + plain.length >= 1, 'the errors are shown');
    assert.ok(!dialogs.some((dialog) => dialog.title === T('nodes.run.confirmAll.title')), 'no question for a run that cannot start');

    // a budget that does not fit: said, nothing starts
    calls.length = 0;
    dialogs.length = 0;
    plain.length = 0;
    nextPlan = { ...forcedPlan(), budget: { limitUsd: 5, spentUsd: 4.9, reservedUsd: 0, remainingUsd: 0.1, estimateUsd: 1.1, enough: false, code: 'BUDGET_INSUFFICIENT' } };
    answer = true;
    await controller.runAllAgain();
    assert.equal(started().length, 0, 'the budget check stops the run');
    assert.ok(dialogs.length + plain.length >= 1, 'and says why');
    assert.ok(!dialogs.some((dialog) => dialog.title === T('nodes.run.confirmAll.title')));

    // while a run is active nothing is started
    calls.length = 0;
    controller.getRunState().active = true;
    await controller.runAllAgain();
    assert.equal(calls.length, 0);
    assert.equal(toasts.at(-1).message, T('nodes.run.alreadyRunning'));
    controller.getRunState().active = false;
    // what the finished runs set going (plan, paint) ends before the stand-ins are taken away
    await sleep(1300);
  } finally {
    restoreAppend();
    delete global.window;
    delete FakeNode.prototype.querySelector;
    delete global.requestAnimationFrame;
  }
}

function testDisplayStatus() {
  const stalePlan = { status: 'stale', paid: false, stamped: true };
  // an input node that reads state of the app shows out of date (when it has results), the others never do
  assert.deepEqual(run.displayStatus({ run: null, planNode: stalePlan, hasResults: true, category: 'input' }), { status: 'stale' });
  assert.deepEqual(run.displayStatus({ run: null, planNode: { ...stalePlan, status: 'forced' }, hasResults: true, category: 'input' }), { status: 'stale' });
  assert.deepEqual(run.displayStatus({ run: null, planNode: stalePlan, hasResults: false, category: 'input' }), { status: null }, 'no result yet: no badge');
  assert.deepEqual(run.displayStatus({ run: null, planNode: { status: 'stale', paid: false }, hasResults: true, category: 'input' }), { status: null }, 'an input without a stamp: never');
  assert.deepEqual(run.displayStatus({ run: { status: 'done' }, planNode: { status: 'stale', paid: false }, hasResults: true, category: 'input' }), { status: 'done' });
  assert.deepEqual(run.displayStatus({ run: { status: 'running' }, planNode: stalePlan, hasResults: true, category: 'input' }), { status: 'running' }, 'a running node shows that');
  assert.deepEqual(run.displayStatus({ run: null, planNode: { status: 'cached', stamped: true }, hasResults: true, category: 'input' }), { status: null });
  // the other nodes as before
  assert.deepEqual(run.displayStatus({ run: null, planNode: { status: 'stale', paid: true }, hasResults: true, category: 'text' }), { status: 'stale' });
  assert.deepEqual(run.displayStatus({ run: null, planNode: { status: 'stale', paid: true }, hasResults: false, category: 'text' }), { status: 'notrun' });
}

function testWiring() {
  const runSource = read('public/nodes/run.js');
  assert.match(runSource, /startRun\(\{ mode: 'all', force: true, again: true \}\)/, 'the whole workflow, forced');
  assert.match(runSource, /bus\.on\('run:allAgain'/);
  const inspector = read('public/nodes/inspector.js');
  assert.match(inspector, /cb\.run\.runAllAgain\(\)/, 'the inspector has the button');
  const main = read('public/nodes/main.js');
  assert.match(main, /runAllAgain: \(\) => runController\.runAllAgain\(\)/);
  // the plan is asked again when the page comes back (a branding changed in the chat or in another tab)
  assert.match(main, /function recheckPlan\(\)/);
  assert.match(main, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'visible'\) recheckPlan\(\);/);
  assert.match(main, /global\.addEventListener\('focus', recheckPlan\)/);
  assert.match(main, /function recheckPlan\(\) \{\s*if \(!state\.active \|\| !state\.workflow \|\| !runController\) return;/, 'nothing while the view is not shown');
}

function testWording() {
  const keys = ['nodes.run.menu.runAllAgain', 'nodes.run.menu.runAllAgainHint', 'nodes.run.confirmAll.title', 'nodes.run.confirmAll.intro', 'nodes.run.confirmAll.free', 'nodes.run.confirmAll.start', 'nodes.statusHint.stale', 'nodes.type.input.branding.tip.2'];
  const rows = Object.fromEntries(nodeRows.map((row) => [row[0], row]));
  for (const key of keys) {
    const row = rows[key];
    assert.ok(row, `${key} exists`);
    assert.equal(row.length, 4, `${key}: de, en and es`);
    for (const text of row.slice(1)) assert.ok(text.trim().length > 0, `${key} has text in every language`);
    assert.equal(row[1].includes('ß'), false, `${key}: no ß in the German text`);
    assert.notEqual(row[1], row[2], `${key}: the English text is not the German one`);
    assert.notEqual(row[3], row[2], `${key}: the Spanish text is not the English one`);
  }
  assert.equal(rows['nodes.run.menu.runAllAgain'][1], 'Alles neu ausführen');
  assert.equal(rows['nodes.run.menu.runAllAgain'][2], 'Run all again');
  assert.equal(rows['nodes.run.menu.runAllAgain'][3], 'Ejecutar todo de nuevo');
  // what the question says: every node runs again, also what the cache has
  for (const index of [1, 2, 3]) assert.ok(rows['nodes.run.confirmAll.intro'][index].length > 40);
  // the node tip of the branding says that the change is noticed (and no longer asks to run the node by hand)
  assert.doesNotMatch(rows['nodes.type.input.branding.tip.2'][1], /führst du diesen Node neu aus/);
  assert.match(rows['nodes.type.input.branding.tip.2'][1], /erkennt der Node selbst/);
}

async function main() {
  testDisplayStatus();
  testWiring();
  testWording();
  await testController();
  await sleep(10);
  console.log('test-nodes-run-again.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
