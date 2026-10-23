'use strict';

// The model line under the title of a node card (node-ui.js modelLineOf): the chosen entry of a model choice that sits in
// the inspector only, "Default: <name>" when nothing is chosen, nothing for a type without a model choice or with the
// choice on the card itself. The option list comes from a stub of the options endpoint.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const VIDEO_MODELS = [
  { value: 'bytedance/seedance-2.5', label: 'Seedance 2.5', default: true },
  { value: 'kwaivgi/kling-2.5', label: 'Kling 2.5' }
];

function loadUi(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const requested = [];
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: {
      graph: graphLib,
      api: {
        options: (source) => {
          requested.push(source);
          return source === 'video-models' ? Promise.resolve({ options: VIDEO_MODELS }) : Promise.resolve({ options: [] });
        }
      }
    }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  vm.runInNewContext(read('public/nodes/node-ui.js'), { window, document: window.document, setTimeout, clearTimeout }, { filename: 'public/nodes/node-ui.js' });
  return { ui: window.OCDNodes.ui, requested };
}

async function main() {
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const defOf = (type) => payload.nodeTypes.find((def) => def.type === type);
  const video = defOf('video.generate');
  assert.ok(video, 'video.generate is registered');

  for (const [lang, standard] of [['de', 'Standard: Seedance 2.5'], ['en', 'Default: Seedance 2.5']]) {
    const { ui, requested } = loadUi(lang);
    const node = (params) => ({ id: 'n', type: 'video.generate', params });
    // the list is loading: no label yet, the card waits for it
    assert.deepEqual({ ...ui.modelLineOf(video, node({})) }, { label: '', loading: true });
    assert.ok(requested.includes('video-models'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({ ...ui.modelLineOf(video, node({})) }, { label: standard, loading: false }, 'no choice: the default model by name');
    assert.equal(ui.modelLineOf(video, node({ model: 'kwaivgi/kling-2.5' })).label, 'Kling 2.5', 'the chosen model');
    assert.equal(ui.modelLineOf(video, node({ model: 'old/model' })).label, 'old/model', 'a model that is not offered any more stays visible');
  }

  const { ui } = loadUi('en');
  // a type without a model choice has no line
  const prompt = payload.nodeTypes.find((def) => !def.params.some((param) => param.id === 'model'));
  assert.deepEqual({ ...ui.modelLineOf(prompt, { id: 'p', type: prompt.type, params: {} }) }, { label: '', loading: false });
  // a model choice that is on the card itself (inline) is not repeated
  const inline = payload.nodeTypes.find((def) => def.params.some((param) => param.id === 'model' && param.kind === 'select' && param.inline));
  assert.ok(inline, 'some type has its model choice on the card');
  assert.equal(ui.modelLineOf(inline, { id: 'i', type: inline.type, params: {} }).label, '');
  // a fixed list: the translated option name (Magnific Reimagine)
  const reimagine = defOf('magnific.reimagine');
  assert.equal(ui.modelLineOf(reimagine, { id: 'r', type: 'magnific.reimagine', params: {} }).label, 'Flux');
  assert.equal(ui.modelLineOf(undefined, { id: 'x', type: 'unknown', params: {} }).label, '');
  console.log('test-nodes-model-line.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
