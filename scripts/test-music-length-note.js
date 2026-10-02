'use strict';

// The length of a song made visible: the line of "Generate music" that says where the length comes from (it replaces the
// hidden "Length" field), the length and range on "Song text and structure", the tips and the label of the song template.
// The logic is pure (public/nodes/music-plan.js and run.js), the wording is checked in German, English and Spanish, the
// wiring that needs a DOM statically. The server logic is not touched: the limits are the ones of the music plan module.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const musicPlan = require('../public/nodes/music-plan');
const run = require('../public/nodes/run');
const registryModule = require('../lib/nodes/registry');
const templates = require('../lib/nodes/templates');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const LANGS = ['de', 'en', 'es'];

function loadUi(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: { graph: graphLib, api: {} }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  vm.runInNewContext(read('public/nodes/node-ui.js'), { window, document: window.document, setTimeout, clearTimeout }, { filename: 'public/nodes/node-ui.js' });
  return window.OCDNodes.ui;
}
const uis = Object.fromEntries(LANGS.map((lang) => [lang, loadUi(lang)]));

// a song text of 6 sections with 3:00 in all (30 s each)
const SONG = ['+ pop', ...[1, 2, 3, 4, 5, 6].map((n) => `\n[Part ${n} | 30 s]\nLine ${n}`)].join('\n');

function testLengthSource() {
  assert.equal(musicPlan.lengthOfText(SONG), 180000);
  assert.deepEqual(musicPlan.describe(SONG), { ms: 180000, count: 6 });
  assert.equal(musicPlan.describe('[A | 1 s]\nx'), null, 'an invalid text has no summary');
  assert.equal(musicPlan.describe(''), null);
  // the song text in the field
  assert.deepEqual(musicPlan.lengthSource({ planText: SONG }), { kind: 'field', ms: 180000 });
  assert.deepEqual(musicPlan.lengthSource({ planText: '[A | 1 s]\nx' }), { kind: 'field', ms: null }, 'not a valid plan yet');
  // a connected song text wins over the field and the video; its text is known or not
  assert.deepEqual(musicPlan.lengthSource({ planText: SONG, planConnected: true, connectedText: '[A | 20 s]\nx', matchConnected: true }), { kind: 'plan', ms: 20000 });
  assert.deepEqual(musicPlan.lengthSource({ planConnected: true }), { kind: 'plan', ms: null });
  assert.deepEqual(musicPlan.lengthSource({ planConnected: true, connectedText: 'nonsense' }), { kind: 'plan', ms: null });
  // the song text wins over the video, the video over the setting
  assert.deepEqual(musicPlan.lengthSource({ planText: SONG, matchConnected: true }), { kind: 'field', ms: 180000 });
  assert.deepEqual(musicPlan.lengthSource({ planText: '  \n ', matchConnected: true }), { kind: 'video' });
  // nothing replaces the setting
  assert.equal(musicPlan.lengthSource({ planText: '' }), null);
  assert.equal(musicPlan.lengthSource({}), null);
  assert.equal(musicPlan.lengthSource(), null);
}

// results as the client holds them: nodeId -> selected entry -> variant
function resultsOf(map) {
  const nodes = {};
  for (const [id, variant] of Object.entries(map)) nodes[id] = { selected: { entry: `${id}-e`, variant: 0 }, history: [{ id: `${id}-e`, variants: [variant] }] };
  return { version: 1, nodes };
}
const text = (value) => ({ type: 'text', value });
const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

function testMusicLengthInfo() {
  const graph = { nodes: [], edges: [edge('e1', 'p', 'plan', 'm', 'plan'), edge('e2', 'v', 'video', 'm', 'match')] };
  const results = resultsOf({ p: { plan: text(SONG) } });
  // the text of the connected node
  assert.deepEqual(run.connectedText(graph, results, 'm', 'plan'), { nodeId: 'p', text: SONG });
  assert.deepEqual(run.connectedText(graph, results, 'm', 'match'), { nodeId: 'v', text: null }, 'a source without a text result');
  assert.deepEqual(run.connectedText(graph, resultsOf({}), 'm', 'plan'), { nodeId: 'p', text: null }, 'no result yet');
  assert.equal(run.connectedText(graph, results, 'm', 'prompt'), null, 'nothing is connected');
  assert.equal(run.connectedText({ edges: [] }, results, 'm', 'plan'), null);
  assert.equal(run.connectedText(null, results, 'm', 'plan'), null);
  assert.deepEqual(run.connectedText(graph, resultsOf({ p: { plan: { type: 'list', items: [] } } }), 'm', 'plan'), { nodeId: 'p', text: null });

  const music = (params = {}) => ({ id: 'm', type: 'audio.music', params });
  // connected song text with a result: the length of the result, the node the line leads to
  assert.deepEqual(run.musicLengthInfo(music(), graph, results, musicPlan), { kind: 'plan', ms: 180000, nodeId: 'p' });
  // connected, but not run yet
  assert.deepEqual(run.musicLengthInfo(music(), graph, resultsOf({}), musicPlan), { kind: 'plan', ms: null, nodeId: 'p' });
  // only a video
  const videoOnly = { nodes: [], edges: [edge('e2', 'v', 'video', 'm', 'match')] };
  assert.deepEqual(run.musicLengthInfo(music(), videoOnly, resultsOf({}), musicPlan), { kind: 'video' });
  // the field; the typed text wins over the saved one
  const bare = { nodes: [], edges: [] };
  assert.deepEqual(run.musicLengthInfo(music({ plan: SONG }), bare, resultsOf({}), musicPlan), { kind: 'field', ms: 180000 });
  assert.deepEqual(run.musicLengthInfo(music({ plan: SONG }), bare, resultsOf({}), musicPlan, { planText: '[A | 20 s]\nx' }), { kind: 'field', ms: 20000 });
  assert.equal(run.musicLengthInfo(music({ plan: SONG }), bare, resultsOf({}), musicPlan, { planText: '' }), null, 'cleared while typing: the setting applies');
  // the setting applies: no line
  assert.equal(run.musicLengthInfo(music({ length: 60 }), bare, resultsOf({}), musicPlan), null);
  // the song text node shows the length of its result
  const planner = { id: 'p', type: 'audio.music_plan', params: {} };
  assert.deepEqual(run.musicLengthInfo(planner, bare, results, musicPlan), { kind: 'result', ms: 180000, count: 6 });
  assert.equal(run.musicLengthInfo(planner, bare, resultsOf({}), musicPlan), null, 'no result, no line');
  assert.equal(run.musicLengthInfo(planner, bare, resultsOf({ p: { plan: text('no sections') } }), musicPlan), null);
  // other types and missing parts
  assert.equal(run.musicLengthInfo({ id: 'x', type: 'audio.tts', params: {} }, bare, results, musicPlan), null);
  assert.equal(run.musicLengthInfo(null, bare, results, musicPlan), null);
  assert.equal(run.musicLengthInfo(music(), bare, results, null), null);
}

// The registry (the server side) is unchanged: 3 to 600 s, the length of "Generate music" hides exactly where it has no effect.
function testRegistry() {
  const registry = graphLib.indexRegistry(JSON.parse(JSON.stringify(registryModule.publicRegistry())));
  const planner = registry.types.get('audio.music_plan').params.find((param) => param.id === 'length');
  assert.deepEqual([planner.min, planner.max, planner.default], [3, 600, 60]);
  assert.equal(planner.inline, true, 'the length stands on the card of the song text');
  assert.equal(planner.showIf, undefined, 'and is always there');
  const def = registry.types.get('audio.music');
  const length = def.params.find((param) => param.id === 'length');
  assert.deepEqual([length.min, length.max, length.default], [3, 600, 30]);
  assert.equal(length.inline, true);
  const shown = (params, connected = []) => graphLib.isVisible(length.showIf, { type: 'audio.music', params }, def, new Set(connected));
  assert.equal(shown({ plan: '' }), true);
  assert.equal(shown({ plan: '[A | 10 s]' }), false);
  assert.equal(shown({ plan: '' }, ['plan']), false);
  assert.equal(shown({ plan: '' }, ['match']), false);
  // the hidden field is exactly what lengthSource explains
  for (const [params, connected, expected] of [
    [{ plan: '' }, [], false],
    [{ plan: SONG }, [], true],
    [{ plan: '' }, ['plan'], true],
    [{ plan: '' }, ['match'], true]
  ]) {
    const source = musicPlan.lengthSource({ planText: params.plan, planConnected: connected.includes('plan'), matchConnected: connected.includes('match') });
    assert.equal(Boolean(source), expected);
    assert.equal(shown(params, connected), !expected);
  }
}

const NEW_KEYS = [
  'nodes.music.planResult',
  'nodes.music.lengthRange',
  'nodes.music.length.field',
  'nodes.music.length.fieldUnknown',
  'nodes.music.length.plan',
  'nodes.music.length.planUnknown',
  'nodes.music.length.video',
  'nodes.music.length.goTo'
];

function testTexts() {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of NEW_KEYS) {
    const forms = LANGS.map((lang) => uis[lang].T(key));
    forms.forEach((form, index) => {
      assert.notEqual(form, key, `${LANGS[index]} misses ${key}`);
      assert.ok(form.trim().length > 8, `${LANGS[index]} ${key} is empty`);
      assert.equal(form.includes('ß'), false, `${LANGS[index]} ${key}: no sharp s`);
    });
    assert.equal(new Set(forms.map(placeholders)).size, 1, `${key}: the same placeholders in every language`);
  }
  assert.match(uis.de.T('nodes.music.lengthRange'), /3 bis 600 s.*10 Minuten/);
  assert.match(uis.en.T('nodes.music.lengthRange'), /3 to 600 s.*10 minutes/);
  assert.match(uis.es.T('nodes.music.lengthRange'), /3 a 600 s.*10 minutos/);
  assert.equal(uis.de.T('nodes.music.length.plan', { duration: '3:00', name: 'Songtext' }), 'Länge: aus dem Songtext (3:00) · ändern im Node «Songtext»');
  assert.equal(uis.de.T('nodes.music.length.video'), 'Länge: wie das verbundene Video');
  assert.equal(uis.de.T('nodes.music.planResult', { duration: '3:00', count: 6 }), 'Gesamtlänge: 3:00 · Abschnitte: 6');
}

function testTipsAndTemplate() {
  const tipKeys = { 'audio.music': 2, 'audio.music_plan': 4 };
  for (const lang of LANGS) {
    for (const [type, number] of Object.entries(tipKeys)) {
      const tip = uis[lang].T(`nodes.type.${type}.tip.${number}`);
      assert.ok(tip.length <= 240, `${lang} ${type} tip.${number} is short enough (${tip.length})`);
      assert.ok(/10 (Minuten|minutes|minutos)/.test(tip), `${lang} ${type}: the tip names the 10 minutes`);
      assert.equal(tip.includes('ß'), false);
      // at most 4 tips, no gaps
      assert.notEqual(uis[lang].T(`nodes.type.${type}.tip.4`), `nodes.type.${type}.tip.4`);
      assert.equal(uis[lang].T(`nodes.type.${type}.tip.5`), `nodes.type.${type}.tip.5`, `${lang} ${type}: no fifth tip`);
    }
    const planNode = uis[lang].T('nodes.type.audio.music_plan.label').replace(/ \(ElevenLabs\)$/, '');
    assert.ok(uis[lang].T('nodes.type.audio.music.tip.2').includes(planNode), `${lang}: the tip names the node “${planNode}”`);
  }
  const template = templates.loadTemplates().find((item) => item.id === 'song-from-idea');
  assert.equal(template.graph.nodes.find((node) => node.id === 'n2').params.length, 60, 'the default stays 60');
  const label = (lang) => (lang === 'en' ? template.app.inputs.find((input) => input.node === 'n2').label : template.i18n[lang]['app.input.n2.length']);
  assert.equal(label('de'), 'Länge (Sekunden, bis 600)');
  assert.equal(label('en'), 'Length (seconds, up to 600)');
  assert.equal(label('es'), 'Duración (segundos, hasta 600)');
}

function testWiring() {
  const ui = read('public/nodes/node-ui.js');
  assert.match(ui, /dataset: \{ slot: 'note' \}/, 'the card has a line for the note');
  assert.match(ui, /node\.type === 'audio\.music_plan' && param\.id === 'length'/, 'the range stands under the field on the card');
  assert.match(ui, /cardActions\.select\(target\)/, 'the line leads to the connected node');
  const runSource = read('public/nodes/run.js');
  assert.match(runSource, /slot\.note = note/, 'the slot carries the note');
  assert.match(runSource, /lengthNote,/, 'the inspector reads the same note');
  const inspector = read('public/nodes/inspector.js');
  assert.match(inspector, /param\.id === 'length' && node\.type === 'audio\.music'/, 'the inspector explains the hidden length');
  assert.match(inspector, /node\.type === 'audio\.music_plan'\) fieldEl\.append/, 'and shows the range of the song text');
  const main = read('public/nodes/main.js');
  assert.match(main, /select: selectNodeById/);
  assert.match(main, /selectNode: selectNodeById/);
  assert.match(read('public/nodes/nodes.css'), /\.nv-node-note\.is-empty\s*{[^}]*display:\s*none/);
}

const tests = [testLengthSource, testMusicLengthInfo, testRegistry, testTexts, testTipsAndTemplate, testWiring];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('test-music-length-note.js: ok');
