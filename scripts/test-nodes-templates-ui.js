'use strict';

// Starter templates in the browser (public/nodes/templates-ui.js, the "Templates" tab of palette.js, the start of an
// empty workflow in main.js): the logic that runs without a DOM (reading line, cost text, search, the store with its
// cache) in three languages, and static checks of the wiring (script order, no innerHTML, every CSS class defined,
// every translation key present, the server-computed fields the cards read).

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const runLib = require('../public/nodes/run');
const templates = require('../lib/nodes/templates');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadUi(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  const ui = { el: () => ({}), icon: () => ({}), T: (key, vars) => window.t(key, vars) };
  window.OCDNodes = { graph: graphLib, ui, run: runLib };
  vm.runInNewContext(read('public/nodes/templates-ui.js'), { window }, { filename: 'public/nodes/templates-ui.js' });
  return { ui: window.OCDNodes.templatesUi, window };
}

const LABELS = { 'input.text': 'Text', 'input.image': 'Image', 'video.seedance': 'Seedance', 'output.result': 'Result', 'hf.dubbing': 'Dubbing' };
const labelOf = (type) => LABELS[type] || type;

function testFlowAndCost() {
  const { ui } = loadUi('en');
  const all = templates.listTemplates({ lang: 'en', checks: Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true])) });
  const byId = Object.fromEntries(all.map((item) => [item.id, item]));

  assert.equal(ui.flowText(byId['image-to-video'], labelOf), 'Image + input.prompt → Seedance → Result');
  assert.equal(ui.flowText(byId['dub-clip'], labelOf), 'input.video → 3× Dubbing → Result', 'equal steps are counted');
  assert.equal(ui.flowText({}, labelOf), '');

  const text = (id) => ui.costInfo(byId[id]);
  assert.deepEqual(JSON.parse(JSON.stringify(text('text-on-video'))), { kind: 'free', text: 'free (local)', title: '' });
  assert.equal(text('image-to-video').kind, 'unknown');
  assert.equal(text('image-to-video').text, 'Cost depends on model and length · OpenRouter');
  assert.match(text('image-to-video').title, /Rough estimate/);
  assert.equal(text('image-to-ad').text, 'Cost depends on model and length · OpenRouter, ElevenLabs', 'the paid services are named');
  assert.equal(text('dub-clip').text, 'Cost depends on model and length · Higgsfield');

  // estimated amounts, same notation as the node cards; a list says "per row"
  const priced = (kind, usd, credits, batch) => ({ batch, cost: { kind, usd, credits, providers: ['fal'] } });
  assert.equal(ui.costInfo(priced('estimate', 0.2, 0, false)).text, 'about $0.20 per run · fal.ai');
  assert.equal(ui.costInfo(priced('estimate', 1.5, 0, true)).text, 'about $1.50 per row · fal.ai');
  assert.equal(ui.costInfo(priced('partial', 0.5, 0, false)).text, 'from $0.50 per run · fal.ai');
  assert.equal(ui.costInfo(priced('partial', 0.5, 0, true)).text, 'from $0.50 per row · fal.ai');
  assert.equal(ui.costInfo(priced('estimate', 0, 12, false)).text, 'about 12 credits per run · fal.ai');
  assert.equal(ui.costInfo(priced('estimate', 0.25, 3, false)).text, 'about $0.25 · 3 credits per run · fal.ai');
  assert.equal(ui.costInfo(priced('estimate', 0, 0, false)).kind, 'unknown', 'an estimate without an amount says nothing');
  assert.equal(ui.costInfo({ cost: { kind: 'free', providers: [] } }).text, 'free (local)');
  assert.equal(ui.costInfo({}).kind, 'unknown', 'a template without a cost field is unknown, not free');

  // German and Spanish read the same facts
  const de = loadUi('de').ui;
  assert.equal(de.costInfo(byId['text-on-video']).text, 'kostenlos (lokal)');
  assert.equal(de.costInfo(priced('estimate', 0.2, 0, true)).text, 'ca. $0.20 pro Zeile · fal.ai');
  assert.equal(de.costInfo(priced('partial', 0.2, 0, false)).text, 'ab $0.20 pro Lauf · fal.ai');
  assert.equal(de.costInfo(byId['image-to-video']).text, 'Kosten je nach Modell und Länge · OpenRouter');
  const es = loadUi('es').ui;
  assert.equal(es.costInfo(byId['photo-slideshow']).text, 'gratis (local)');
  assert.equal(es.costInfo(priced('estimate', 0.2, 0, false)).text, 'aprox. $0.20 por ejecución · fal.ai');
  assert.equal(es.costInfo(byId['video-to-post']).text, 'Coste según modelo y duración · OpenRouter');

  assert.equal(ui.requirementLabel('fal'), 'fal.ai');
  assert.equal(ui.requirementLabel('unheard'), 'unheard');
  assert.equal(ui.missingText({ missing: [{ key: 'openrouter' }, { key: 'fal' }] }), 'OpenRouter, fal.ai');
}

function testSearch() {
  const { ui } = loadUi('en');
  const list = [
    { id: 'a', name: 'Image to video', description: 'Bring a still to life', nodeTypes: ['input.image', 'video.seedance'] },
    { id: 'b', name: 'Product hero', description: 'Four stills of a product scene', nodeTypes: ['input.text', 'image.generate'] },
    { id: 'c', name: 'Clip dubbing', description: 'Speech in three languages', nodeTypes: ['input.video', 'hf.dubbing'] }
  ];
  const ids = (query) => Array.from(ui.rank(list, query, labelOf), (item) => item.id);
  assert.deepEqual(ids(''), ['a', 'b', 'c'], 'no search: the order stays');
  assert.deepEqual(ids('   '), ['a', 'b', 'c']);
  assert.deepEqual(ids('video'), ['a', 'c'], 'the name beats the node names');
  assert.deepEqual(ids('dubbing'), ['c']);
  assert.deepEqual(ids('seedance'), ['a'], 'the nodes inside are searched');
  assert.deepEqual(ids('hf.dubbing'), ['c'], 'the type id works as well');
  assert.deepEqual(ids('still'), ['a', 'b'], 'description: order of the list');
  assert.deepEqual(ids('stills product'), ['b'], 'every word has to match');
  assert.deepEqual(ids('image to video'), ['a'], 'glue words ("to") need not match on their own');
  assert.deepEqual(ids('zzz'), []);
  assert.deepEqual(Array.from(ui.rank(list, 'IMAGE', (type) => (type === 'video.seedance' ? 'Bild' : type)), (item) => item.id), ['a', 'b'], 'upper case, and the node names come from the label function');
  assert.deepEqual(ids('Ölsardinen'), []);
  // the node names are the translated ones
  assert.deepEqual(Array.from(ui.rank(list, 'bildmotor', (type) => (type === 'image.generate' ? 'Bildmotor' : type)), (item) => item.id), ['b']);
  assert.equal(ui.SEARCH_MIN, 8, 'a search field from more than eight templates');
}

async function testStore() {
  const { ui } = loadUi('en');
  const calls = [];
  let lang = 'en';
  let clock = 0;
  const api = {
    templates: async (value) => {
      calls.push(`list:${value}`);
      return { templates: [{ id: 'x', nodeTypes: ['video.seedance'] }, { id: 'y', nodeTypes: ['input.text'] }] };
    },
    template: async (id, value) => {
      calls.push(`doc:${id}:${value}`);
      return { document: { name: id, graph: { nodes: [], edges: [] } } };
    }
  };
  const store = ui.createStore({ api, getLang: () => lang, now: () => clock });
  assert.equal(store.cached(), null);
  assert.equal(store.withType('video.seedance').length, 0, 'nothing known before the first list');
  const [first, second] = await Promise.all([store.list(), store.list()]);
  assert.equal(first, second);
  assert.deepEqual(calls, ['list:en'], 'concurrent calls share one request');
  await store.list();
  assert.equal(calls.length, 1, 'cached');
  assert.deepEqual(Array.from(store.withType('video.seedance'), (item) => item.id), ['x'], 'templates that contain a node type');
  assert.equal(store.withType('nope.type').length, 0);
  clock += 6 * 60 * 1000;
  await store.list();
  assert.equal(calls.length, 2, 'the list expires after a few minutes');
  await store.list({ refresh: true });
  assert.equal(calls.length, 3, 'refresh asks again');
  lang = 'de';
  await store.list();
  assert.equal(calls[calls.length - 1], 'list:de', 'another language is another list');
  assert.equal((await store.document('x')).name, 'x');
  assert.equal(calls[calls.length - 1], 'doc:x:de');
  store.invalidate();
  assert.equal(store.cached(), null);

  // a failing request is not cached and does not block the next one
  let fail = true;
  const flaky = ui.createStore({
    api: {
      templates: async () => {
        if (fail) throw new Error('offline');
        return { templates: [] };
      }
    },
    getLang: () => 'en'
  });
  await assert.rejects(flaky.list(), /offline/);
  fail = false;
  assert.equal((await flaky.list()).length, 0);
}

function testServerFields() {
  // what the cards read from GET /api/workflow-templates
  const all = templates.listTemplates({ lang: 'en' });
  assert.ok(all.length > 8, 'more than eight templates: the gallery shows a search field');
  for (const item of all) {
    assert.ok(Array.isArray(item.nodeTypes) && item.nodeTypes.length >= 3, item.id);
    assert.ok(Array.isArray(item.flow) && item.flow.every((step) => Array.isArray(step) && step.every((entry) => entry.type && entry.count >= 1)), item.id);
    assert.ok(item.flow.flat().reduce((sum, entry) => sum + entry.count, 0) === item.nodeCount, `${item.id}: the reading line covers every node`);
    assert.ok(['free', 'estimate', 'partial', 'unknown'].includes(item.cost.kind), item.id);
    assert.equal(typeof item.nodeCount, 'number');
  }
}

function testWiring() {
  const html = read('public/index.html');
  assert.ok(html.indexOf('<script src="nodes/templates-ui.js"></script>') > html.indexOf('<script src="nodes/canvas.js"></script>'), 'templates-ui.js loads after canvas.js');
  assert.ok(html.indexOf('<script src="nodes/templates-ui.js"></script>') < html.indexOf('<script src="nodes/palette.js"></script>'), 'and before the palette that uses it');

  const css = read('public/nodes/nodes.css');
  const classes = new Set();
  for (const file of ['public/nodes/templates-ui.js', 'public/nodes/palette.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, `${file}: no HTML from strings`);
    assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\(/, `${file}: no native dialogs`);
    for (const match of source.matchAll(/'([^'\n]*\bnv-[a-z0-9-]+[^'\n]*)'/g)) {
      for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
    }
  }
  const main = read('public/nodes/main.js');
  for (const match of main.matchAll(/class: '([^']*\bnv-(?:start|tpl)[^']*)'/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  assert.ok(classes.has('nv-start-card') && classes.has('nv-tpl-flow') && classes.has('nv-pal-desc'), 'the new classes were found');
  const missing = [...classes].filter((name) => !name.endsWith('-')).filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css)); // `nv-port-` and the like are completed at run time
  assert.deepEqual(missing, [], `CSS classes without a rule: ${missing.join(', ')}`);

  // the start of an empty workflow lets the canvas keep its gestures
  assert.match(css, /\.nv-start \{[^}]*pointer-events: none/);
  assert.match(css, /\.nv-start-actions \{[^}]*pointer-events: auto/);
  assert.match(css, /\.nv-stage\.is-loading \.nv-start \{[^}]*display: none/);

  // every literal key of the three files exists in all languages (the i18n test checks the rest of the node view)
  const window = { document: { documentElement: { lang: '' }, querySelectorAll: () => [] }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.runInNewContext(read('public/i18n.js'), { window });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window });
  for (const file of ['public/nodes/templates-ui.js', 'public/nodes/palette.js', 'public/nodes/main.js']) {
    for (const match of read(file).matchAll(/'(nodes\.(?:template|start|insert)\.[A-Za-z0-9_.]+)'/g)) {
      for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][match[1]], `${lang}: ${match[1]} (${file})`);
    }
  }
  assert.equal(window.I18N.de['nodes.template.insert'], 'In diesen Workflow einfügen');
  assert.equal(window.I18N.de['nodes.start.template'], 'Mit einer Vorlage starten');
}

(async () => {
  testFlowAndCost();
  testSearch();
  await testStore();
  testServerFields();
  testWiring();
  console.log('test-nodes-templates-ui.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
