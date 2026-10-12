'use strict';

// Execute separate classic scripts in one realm: concatenation would hide cross-file hoisting and lexical errors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appScriptFiles, readAppSource } = require('./support/app-source');
const { FakeNode, makeDocument } = require('./support/fake-dom');

const root = path.resolve(__dirname, '..');
const files = appScriptFiles();
assert.deepEqual(files, [
  'public/app-core.js', 'public/app-cards.js', 'public/app-messages.js', 'public/app-settings.js',
  'public/app-sessions.js', 'public/app-brandings.js', 'public/app-context.js', 'public/app-transport.js', 'public/app.js'
]);
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const tags = files.map((file) => `<script src="${file.slice(7)}"></script>`);
assert.ok(index.includes(['<script src="shell.js"></script>', ...tags, '<script src="nodes/i18n-nodes.js"></script>'].join('\n    ')),
  'chat scripts load synchronously after the shell and before the node view');
assert.equal((readAppSource().match(/^init\(\);$/gm) || []).length, 1, 'initialization runs exactly once');
assert.match(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), /init\(\);\s*$/, 'entry point initializes last');

function load({ mobile, storageFails, mediaAvailable }) {
  const { document } = makeDocument();
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) {
      const node = new FakeNode('div');
      node.replaceChildren = (...children) => {
        node.textContent = '';
        children.forEach((child) => node.append(child));
      };
      elements.set(key, node);
    }
    return elements.get(key);
  };
  document.getElementById = element;
  document.querySelector = element;
  const calls = [];
  const listeners = new Map();
  const context = vm.createContext({
    document,
    localStorage: { getItem(key) {
      if (storageFails) throw new Error('Storage unavailable');
      return JSON.stringify([key]);
    } },
    t: (key) => key,
    fetch: (url, options) => {
      calls.push([url, options?.method || 'GET']);
      // Keep initialization at its first reads; no service, timer or paid action can run.
      return new Promise(() => {});
    },
    setTimeout: () => { throw new Error('Unexpected startup timer'); },
    OCShell: {
      accountMenu: () => ({ element: new FakeNode('div') }),
      register: (hooks) => { assert.equal(typeof hooks.openSettings, 'function'); },
      addSection: (_name, build) => { assert.equal(typeof build, 'function'); },
      refresh() {}
    },
    OCMcp: { attach() { calls.push('mcp'); } },
    OCRenderAgents: { attach() { calls.push('agents'); } },
    OCTeams: { attach() { calls.push('teams'); } },
    OCAccess: { onChange(fn) { assert.equal(typeof fn, 'function'); } },
    addEventListener: (type, fn) => listeners.set(type, fn)
  });
  context.window = context;
  if (mediaAvailable) context.matchMedia = () => ({ matches: mobile, addEventListener(type, fn) { listeners.set(type, fn); } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/team-groups.js'), 'utf8'), context);
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.startsWith("'use strict';"), `${file} is strict`);
    vm.runInContext(source, context, { filename: file });
    if (file !== 'public/app.js') assert.deepEqual(calls, [], `${file} does not initialize the app`);
  }
  assert.deepEqual(calls, ['mcp', 'agents', 'teams', ['api/prompt-presets', 'GET'], ['api/config', 'GET']]);
  assert.equal(vm.runInContext('state.collapsedFolders.size', context), storageFails ? 0 : 1);
  assert.equal(vm.runInContext('state.openPromptGroups.size', context), storageFails ? 0 : 1);
  assert.equal(vm.runInContext('el.sidebar.inert', context), mobile && mediaAvailable);
  assert.equal(typeof context.OCBrain.choices, 'function');
  assert.equal(typeof context.onLangChange, 'function');
  for (const type of ['focus', 'hashchange']) assert.equal(typeof listeners.get(type), 'function', type);
  if (mediaAvailable) assert.equal(typeof listeners.get('change'), 'function');
  assert.equal(elements.get('sendBtn').listeners.click.length, 1);
  assert.equal(elements.get('lightbox').listeners.click.length, 1);
  assert.equal(document.listeners.keydown.length, 2);
  return context;
}

load({ mobile: false, storageFails: false, mediaAvailable: true });
load({ mobile: true, storageFails: false, mediaAvailable: true });
load({ mobile: false, storageFails: true, mediaAvailable: false });

console.log('test-app-scripts.js: ok');
