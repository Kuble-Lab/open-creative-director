'use strict';

// i18n of the node view: de/en/es parity, Swiss spelling, placeholder consistency, coverage of every
// registry type / category / port / param / option, and of every literal key used by public/nodes/*.js.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const registryModule = require('../lib/nodes/registry');
const graphLib = require('../public/nodes/graph');

const storage = new Map([['vcd-lang', 'de']]);
const window = {
  document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
  navigator: { language: 'de-CH' },
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
const beforeKeys = Object.keys(window.I18N.de).length;
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });

const languages = ['de', 'en', 'es'];
const nodeKeys = (lang) => Object.keys(window.I18N[lang]).filter((key) => key.startsWith('nodes.')).sort();

function testParity() {
  const base = nodeKeys('de');
  assert.ok(base.length > 300, `expected many node keys, got ${base.length}`);
  for (const lang of languages) {
    assert.deepEqual(nodeKeys(lang), base, `${lang} has a different node key set`);
    for (const key of base) {
      const value = window.I18N[lang][key];
      assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.equal(value.includes('ß'), false, `${lang}.${key} contains a sharp s`);
    }
  }
  // the node file only adds nodes.* keys and leaves the chat dictionaries untouched
  const total = Object.keys(window.I18N.de).length;
  assert.equal(total, beforeKeys + base.length, 'i18n-nodes.js must only add nodes.* keys');
  const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const key of base) {
    const expected = placeholders(window.I18N.de[key]);
    for (const lang of ['en', 'es']) assert.equal(placeholders(window.I18N[lang][key]), expected, `${lang}.${key} placeholders differ from de`);
  }
}

function testSwissSpelling() {
  for (const key of nodeKeys('de')) {
    const value = window.I18N.de[key];
    assert.equal(/[Ss]chließ|groß|weiß/.test(value), false, key);
  }
  assert.equal(window.I18N.de['nodes.common.close'], 'Schliessen');
  assert.equal(window.I18N.de['nodes.zoom.in'], 'Vergrössern');
}

const RAW_OPTION = /^[0-9.:]+[a-z]*$/i; // ratios, resolutions, numbers stay literal

function testRegistryCoverage() {
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const has = (key) => Object.prototype.hasOwnProperty.call(window.I18N.de, key);
  const missing = [];
  const need = (key) => {
    if (!has(key)) missing.push(key);
  };
  for (const category of payload.categories) need(`nodes.category.${category}`);
  for (const base of Object.keys(payload.portTypes)) need(`nodes.ptype.${base}`);
  for (const def of payload.nodeTypes) {
    need(`nodes.type.${def.type}.label`);
    const ports = [...def.inputs, ...def.outputs];
    for (const variant of Object.values(def.portVariants?.values || {})) ports.push(...(variant.inputs || []), ...(variant.outputs || []));
    for (const port of ports) need(`nodes.port.${port.id}`);
    for (const param of def.params) {
      need(`nodes.param.${param.id}`);
      if (param.kind === 'select' && Array.isArray(param.options)) {
        for (const option of param.options) {
          const value = option && typeof option === 'object' ? option.value : option;
          if (!RAW_OPTION.test(String(value))) need(`nodes.option.${value}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], `registry strings without translation: ${[...new Set(missing)].join(', ')}`);
  assert.ok(payload.nodeTypes.length >= 58);
}

function sourceFiles() {
  const dir = path.join(root, 'public', 'nodes');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.js') && file !== 'i18n-nodes.js').map((file) => path.join(dir, file));
}

function testSourceKeys() {
  const missing = [];
  const used = new Set();
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/'(nodes\.[A-Za-z0-9_.-]+)'/g)) {
      used.add(match[1]);
      if (!window.I18N.de[match[1]]) missing.push(`${path.basename(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `keys used in the sources but not defined: ${missing.join(', ')}`);
  assert.ok(used.size > 150, `expected to find many key literals, found ${used.size}`);

  // Keys built from a variable at run time.
  const dynamic = [];
  for (const code of ['unknown_node', 'same_node', 'no_output', 'no_input', 'incompatible', 'duplicate', 'cycle', 'too_many', 'same_side', 'none']) dynamic.push(`nodes.connect.${code}`);
  for (const color of graphLib.GROUP_COLORS) dynamic.push(`nodes.color.${color}`);
  for (const kind of ['image', 'video', 'audio']) dynamic.push(`nodes.asset.hint.${kind}`);
  for (const status of ['queued', 'running', 'waiting_job', 'cached', 'done', 'error', 'skipped', 'cancelled', 'stale', 'notrun', 'invalid', 'unavailable']) {
    dynamic.push(`nodes.status.${status}`);
    dynamic.push(`nodes.statusHint.${status}`);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'running', 'finished']) dynamic.push(`nodes.run.result.${status}`);
  for (const state of ['saved', 'saving', 'dirty', 'offline', 'conflict']) dynamic.push(`nodes.save.${state}`);
  for (const kind of ['image', 'video', 'audio']) {
    dynamic.push(`nodes.picker.title.${kind}`, `nodes.picker.none.${kind}`);
  }
  for (const mark of ['input', 'output', 'both']) dynamic.push(`nodes.app.mark.${mark}`);
  for (const key of dynamic) assert.ok(window.I18N.de[key], `missing dynamic key ${key}`);

  // every connection error code the graph can produce has a message
  const codes = new Set();
  const graphSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'graph.js'), 'utf8');
  for (const match of graphSource.matchAll(/code: '([a-z_]+)'/g)) codes.add(match[1]);
  for (const code of ['unknown_node', 'same_node', 'no_output', 'no_input', 'incompatible', 'duplicate', 'cycle', 'too_many']) {
    assert.ok(codes.has(code), `graph.js no longer emits ${code}`);
  }
  for (const code of codes) {
    if (['dangling', 'duplicate_id', 'unknown_type', 'bad_port'].includes(code)) continue; // validate() codes, not shown to users
    assert.ok(window.I18N.de[`nodes.connect.${code}`], `graph error code ${code} has no message`);
  }
}

function testHtmlWiring() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="nodesBtn"'), 'sidebar button missing');
  assert.ok(html.includes('id="nodeApp"'), 'node view container missing');
  assert.ok(html.includes('nodes/nodes.css'), 'stylesheet missing');
  const order = ['i18n.js', 'app.js', 'nodes/i18n-nodes.js', 'nodes/graph.js', 'nodes/history.js', 'nodes/api.js', 'nodes/node-ui.js', 'nodes/preview.js', 'nodes/canvas.js', 'nodes/palette.js', 'nodes/inspector.js', 'nodes/workflow-list.js', 'nodes/asset-picker.js', 'nodes/run.js', 'nodes/app-mode.js', 'nodes/main.js'];
  let last = -1;
  for (const file of order) {
    const index = html.indexOf(`<script src="${file}"></script>`);
    assert.ok(index > last, `script ${file} missing or out of order`);
    last = index;
  }
  for (const lang of languages) {
    assert.ok(window.I18N[lang]['sidebar.nodes'] && window.I18N[lang]['sidebar.nodesTitle'], `${lang} sidebar keys`);
  }
  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(!/OCDNodes|nodeApp|nodesBtn/.test(appSource), 'app.js must stay unchanged and independent of the node view');
}

const tests = [testParity, testSwissSpelling, testRegistryCoverage, testSourceKeys, testHtmlWiring];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`nodes i18n ok: ${nodeKeys('de').length} Keys in DE/EN/ES`);
