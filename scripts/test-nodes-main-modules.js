'use strict';

// Exercise the split entry point without a server: load order, both boot paths, live UI state,
// cross-part graph/history/app/save callbacks and the hash guard. No provider calls or real timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPage, FakeNode } = require('./support/fake-dom');
const { nodeMainFiles } = require('./support/node-main-source');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function testOrder() {
  const html = read('public/index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  const parts = scripts.filter((file) => /^nodes\/main(?:-.*)?\.js$/.test(file));
  assert.deepEqual(parts, nodeMainFiles.map((file) => `nodes/${file}`), 'all parts load exactly once in dependency order');
  assert.ok(scripts.indexOf('nodes/app-mode.js') < scripts.indexOf(parts[0]));
  assert.ok(scripts.indexOf('nodes/assistant-ui.js') < scripts.indexOf(parts[0]));
}

async function testBoot(readyState) {
  const page = loadPage('en', { scripts: ['node-ui', 'templates-ui', 'node-help', 'archive-ui'] });
  const { window, document, OCD } = page;
  const root = new FakeNode('main');
  document.readyState = readyState;
  document.documentElement.classList = new FakeNode('html').classList;
  document.getElementById = (id) => id === 'nodeApp' ? root : null;
  document.querySelector = () => null;
  window.location = { hash: '', pathname: '/editor', search: '', origin: 'https://example.test' };
  window.innerWidth = 1600;
  window.addEventListener = () => {};
  const storage = new Map();
  window.sessionStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const replaced = [];
  const history = { replaceState: (...args) => replaced.push(args) };
  const saves = [];
  OCD.api.saveWorkflow = async (id, payload) => { saves.push({ id, payload }); return { rev: 2, updatedAt: '2026-01-01T00:00:00Z' }; };
  OCD.history = require('../public/nodes/history');
  const noop = () => {};
  let mounts = 0;
  let renders = 0;
  let attached = 0;
  const canvas = { setRegistry: noop, setTool: noop, relayout: noop, getViewport: () => ({ zoom: 1 }), render: () => { renders++; } };
  OCD.canvas = { createCanvas: () => { mounts++; return canvas; } };
  OCD.palette = { createPalette: () => ({ isOpen: () => false }) };
  OCD.inspector = { installApprovalGuard: noop, warnApprovalChanges: noop, createInspector: () => ({ render: noop }) };
  OCD.workflowList = { createWorkflowList: () => ({ update: noop }) };
  OCD.run = { createController: () => ({ inspectorApi: {}, attach: () => { attached++; } }) };
  OCD.assistant = { createAssistant: () => ({ workflowChanged: noop }) };
  OCD.appMode = { createAppView: () => ({}) };
  const context = vm.createContext({ window, document, history, URL, URLSearchParams, Blob, console, setTimeout: () => 1, clearTimeout: noop, requestAnimationFrame: () => 1 });
  for (const file of nodeMainFiles) {
    vm.runInContext(read(`public/nodes/${file}`), context, { filename: file });
    if (file !== 'main.js') assert.equal(mounts, 0, 'parts register without booting');
    if (file === 'main-state.js') {
      OCD.main = new Proxy(OCD.main, {
        get(target, name) {
          assert.ok(name in target, `only registered bindings may be read: ${String(name)}`);
          return target[name];
        }
      });
    }
  }
  if (readyState === 'loading') {
    assert.equal(mounts, 0);
    assert.equal(document.listeners.DOMContentLoaded.length, 1);
    document.listeners.DOMContentLoaded[0]();
    document.listeners.DOMContentLoaded[0]();
  }
  assert.equal(mounts, 1, 'boot mounts once');
  assert.equal(attached, 1, 'run controller attaches once');
  assert.equal(OCD.editor.getCanvas(), canvas);
  assert.equal(OCD.editor.dom(), OCD.main.dom);
  const runtime = OCD.main;
  const state = OCD.editor.getState();
  assert.equal(state, runtime.state);
  for (const file of nodeMainFiles) {
    const source = read(`public/nodes/${file}`);
    for (const imports of source.matchAll(/(?:\b(?:let|const) |\()\{([^}]+)\} = runtime[;)]/g)) {
      for (const name of imports[1].split(',').map((name) => name.trim())) {
        assert.notEqual(runtime[name], undefined, `${file}: linked ${name}`);
      }
    }
  }
  state.workflow = { id: 'workflow', name: 'Workflow', app: { enabled: false, inputs: [], outputs: [] } };
  state.history.reset(OCD.graph.content(state.graph));
  runtime.applyGraph({ ...state.graph, notes: [{ id: 'note', x: 0, y: 0, text: 'A note' }] });
  assert.equal(state.graph.notes.length, 1);
  OCD.editor.undo();
  assert.equal(state.graph.notes.length, 0);
  OCD.editor.redo();
  assert.equal(state.graph.notes.length, 1);
  assert.equal(renders, 3, 'state and history parts share the canvas installed by boot');
  OCD.editor.changeApp({ enabled: true });
  assert.equal(OCD.editor.dom().appBtn.getAttribute('aria-pressed'), 'true');
  const savedEvents = [];
  OCD.bus.on('saved', (event) => savedEvents.push(event));
  await OCD.editor.flushSave();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].id, 'workflow');
  assert.equal(saves[0].payload.app.enabled, true);
  assert.equal(saves[0].payload.graph.notes.length, 1);
  assert.equal(state.rev, 2);
  assert.equal(state.saveState, 'saved');
  assert.equal(savedEvents.length, 1);
  await OCD.editor.flushSave();
  assert.equal(saves.length, 1, 'a clean editor does not save again');
  state.active = true;
  history.replaceState(null, '', '#s=chat');
  assert.equal(replaced.length, 0, 'the hash guard preserves the active editor');
  assert.equal(storage.get('ocd-nodes-return'), '#s=chat');
  history.replaceState(null, '', '#w=workflow');
  assert.equal(replaced.length, 1);
  OCD.editor.navigate('other workflow');
  assert.equal(window.location.hash, '#w=other%20workflow');
}

(async () => {
  testOrder();
  await testBoot('loading');
  await testBoot('complete');
  console.log('test-nodes-main-modules.js: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
