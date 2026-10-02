'use strict';

// The surface of the music nodes (WP30), without a browser: the texts the interface builds from codes and values (errors
// with a line number, the suggestion of ElevenLabs, the reasons of "Use as text"), the words that must agree between help,
// templates and menu in German, English and Spanish, and the wiring of the pieces that need a DOM. The format itself is
// tested in test-music-plan.js, the nodes in test-nodes-generate.js, the graph step in test-nodes-graph.js.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const musicPlan = require('../public/nodes/music-plan');
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

const NEW_KEYS = [
  'nodes.badge.free',
  'nodes.run.menu.useAsText',
  'nodes.run.menu.useAsTextHint',
  'nodes.run.menu.useAsText.multiple',
  'nodes.run.menu.useAsText.list',
  'nodes.run.menu.useAsText.empty',
  'nodes.adopt.done',
  'nodes.adopt.doneUnconnected',
  'nodes.adopt.failed',
  'nodes.adopt.appCutOff',
  'nodes.app.noOutputReach',
  'nodes.app.noOutputReachBadge',
  'costs.speech',
  'costs.music',
  'nodes.music.planFormat',
  'nodes.music.planPlaceholder',
  'nodes.music.planOk',
  'nodes.music.suggestion',
  'nodes.music.suggestionTitle',
  'nodes.help.cost.freecall'
];

function testTextsInThreeLanguages() {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of NEW_KEYS) {
    const forms = LANGS.map((lang) => uis[lang].T(key));
    for (const [index, text] of forms.entries()) {
      assert.notEqual(text, key, `${LANGS[index]} misses ${key}`);
      assert.ok(text.trim().length > 2, `${LANGS[index]} ${key} is empty`);
      assert.equal(text.includes('ß'), false, `${LANGS[index]} ${key}: no sharp s`);
    }
    assert.equal(new Set(forms.map(placeholders)).size, 1, `${key}: the same placeholders in every language`);
  }
  // the three texts of the empty song text field show the same structure (sections, styles, lines) in every language
  const lines = (lang) => uis[lang].T('nodes.music.planPlaceholder').split('\n');
  assert.equal(lines('de').length, lines('en').length);
  assert.equal(lines('de').length, lines('es').length);
  for (const lang of LANGS) {
    const text = uis[lang].T('nodes.music.planPlaceholder');
    const parsed = musicPlan.parse(text);
    assert.deepEqual(parsed.errors, [], `${lang}: the example in the empty field is a valid song text`);
    assert.equal(parsed.plan.sections.length, 2);
    assert.equal(musicPlan.totalMs(parsed.plan), 35000);
  }
  // the reasons of "Use as text" are the reasons run.js produces
  for (const reason of ['multiple', 'list', 'empty']) {
    for (const lang of LANGS) assert.notEqual(uis[lang].T(`nodes.run.menu.useAsText.${reason}`), `nodes.run.menu.useAsText.${reason}`);
  }
}

function testErrorTextsWithValues() {
  // plan problems: the line number is in the text, in every language
  const broken = '[Verse]\nA line\n[Chorus | 2 s]\nB line';
  const { errors } = musicPlan.parse(broken);
  assert.ok(errors.length >= 2);
  for (const lang of LANGS) {
    for (const problem of errors) {
      const text = uis[lang].issueText({ code: problem.code, data: problem.data, message: problem.message });
      assert.ok(text.includes(String(problem.line)), `${lang} ${problem.code}: names line ${problem.line} (${text})`);
      assert.doesNotMatch(text, /\{\w+\}/, `${lang} ${problem.code}: every value is filled in`);
      assert.notEqual(text, problem.message, `${lang} ${problem.code}: translated, not the English fallback`);
    }
  }
  // a refused prompt: the text, then the suggestion of ElevenLabs on one line
  for (const lang of LANGS) {
    const ui = uis[lang];
    const bare = ui.issueText({ code: 'MUSIC_PROMPT_REJECTED' });
    assert.ok(bare.length > 40);
    const withSuggestion = ui.issueText({ code: 'MUSIC_PROMPT_REJECTED', data: { suggestion: 'calm piano,\nsoft strings' } });
    assert.equal(withSuggestion, `${bare} ${ui.T('nodes.music.suggestion', { suggestion: 'calm piano, soft strings' })}`);
    assert.equal(ui.issueText({ code: 'MUSIC_PROMPT_REJECTED', data: { suggestion: '   ' } }), bare, 'an empty suggestion adds nothing');
    assert.equal(ui.issueText({ code: 'MUSIC_PROMPT_REJECTED', data: {} }), bare);
    // a long suggestion (a whole song text) is cut for the card
    const long = ui.issueText({ code: 'MUSIC_PLAN_REJECTED', data: { suggestion: `${'word '.repeat(200)}END` } });
    assert.ok(long.endsWith('…'), 'cut with an ellipsis');
    assert.ok(long.length < bare.length + 400, 'short enough for a card');
    assert.ok(!long.includes('END'));
  }
  // every runtime code of the music and speech calls has a text in every language
  for (const code of [
    'MUSIC_SOURCE_MISSING', 'MUSIC_PLAN_WINS', 'MUSIC_SUBSCRIPTION_REQUIRED', 'MUSIC_PROMPT_REJECTED', 'MUSIC_PLAN_REJECTED',
    'ELEVENLABS_RATE_LIMITED', 'ELEVENLABS_QUOTA_EXCEEDED', 'ELEVENLABS_KEY_REJECTED', 'ELEVENLABS_TIMEOUT', 'ELEVENLABS_SERVER_ERROR',
    ...musicPlan.ERROR_CODES
  ]) {
    for (const lang of LANGS) assert.equal(uis[lang].hasIssueText(code), true, `${lang} has a text for ${code}`);
  }
  // text that does not exist keeps the message of the engine
  assert.equal(uis.de.issueText({ code: 'NOT_A_CODE', message: 'raw' }), 'raw');
}

function testWordsAgree() {
  // The command is named the same way in the menu, the help of the music nodes and the song template.
  const registry = registryModule.publicRegistry();
  const types = new Set(registry.nodeTypes.map((type) => type.type));
  assert.ok(types.has('audio.music') && types.has('audio.music_plan'));
  const template = templates.loadTemplates().find((item) => item.id === 'song-from-idea');
  for (const lang of LANGS) {
    const ui = uis[lang];
    const name = ui.T('nodes.run.menu.useAsText');
    const note = lang === 'en' ? template.graph.notes[0].text : template.i18n[lang]['note.t1'];
    assert.ok(note.includes(name), `${lang}: the template note names “${name}”`);
    assert.ok(ui.T('nodes.type.audio.music.tip.3').includes(name), `${lang}: the tip of the music node names “${name}”`);
  }
  // the unit on the card: a node that charges nothing but calls a service says so (help sentence and badge)
  const plan = registry.nodeTypes.find((type) => type.type === 'audio.music_plan');
  assert.equal(plan.paid, false);
  assert.deepEqual(plan.cost, { unit: 'free', hasEstimate: false });
  assert.equal(plan.provider, 'elevenlabs');
  const source = read('public/nodes/node-ui.js');
  assert.match(source, /def\.cost && def\.cost\.unit === 'free' && def\.provider/, 'node-ui.js marks the free call on the card');
}

function testCostHints() {
  // the hints of the cost line no longer claim that every estimate comes from an earlier run
  for (const lang of LANGS) {
    const estimate = uis[lang].T('nodes.cost.estimateHint');
    const unknown = uis[lang].T('nodes.cost.unknownHint');
    assert.ok(estimate.length > 60 && unknown.length > 60, `${lang}: the hints say more than before`);
  }
  assert.match(uis.de.T('nodes.cost.unknownHint'), /Verbindung/, 'unknown: names the connection as a cause');
  assert.match(uis.en.T('nodes.cost.unknownHint'), /connection/);
  assert.match(uis.es.T('nodes.cost.unknownHint'), /conexión/);
}

function testMenuHintMarkup() {
  // item.hint puts a line under the label; a disabled entry with a hint stays readable
  const ui = read('public/nodes/node-ui.js');
  assert.match(ui, /nv-menu-hint/);
  const css = read('public/nodes/nodes.css');
  assert.match(css, /\.nv-menu-item\.has-hint:disabled\s*{[^}]*opacity:\s*1/);
  assert.match(css, /\.nv-badge\.is-free/);
}

function testPlanFieldWiring() {
  // the song text field: a placeholder with the format, the check while typing, the shared module
  const ui = read('public/nodes/node-ui.js');
  assert.match(ui, /node\.type === 'audio\.music' && param\.id === 'plan'/);
  const inspector = read('public/nodes/inspector.js');
  assert.match(inspector, /function planCheck\(/);
  assert.match(inspector, /musicPlan\.parse\(value, \{ model \}\)/, 'the check knows the model: its limits differ');
  assert.match(inspector, /param\.id === 'plan' && node\.type === 'audio\.music'/);
  // while a plan is in the field, the length and the vocals are hidden (their settings have no effect then)
  const registry = graphLib.indexRegistry(JSON.parse(JSON.stringify(registryModule.publicRegistry())));
  const def = registry.types.get('audio.music');
  const shown = (id, params, connected = []) => graphLib.isVisible(def.params.find((param) => param.id === id).showIf, { type: 'audio.music', params }, def, new Set(connected));
  assert.equal(shown('length', { plan: '' }), true);
  assert.equal(shown('length', { plan: '[A | 10 s]' }), false);
  assert.equal(shown('instrumental', { plan: '[A | 10 s]' }), false);
  assert.equal(shown('length', { plan: '' }, ['match']), false);
}

// The cost overview (chat) and the monitoring name the new cost types instead of showing the raw key.
function testCostTypeNames() {
  assert.match(read('public/app.js'), /COST_TYPE_KEYS = \{[^}]*speech: 'costs\.speech'[^}]*music: 'costs\.music'[^}]*\}/s);
  assert.match(read('public/monitoring.js'), /COST_TYPES = \{[^}]*speech: 'costs\.speech'[^}]*music: 'costs\.music'[^}]*\}/s);
  const names = Object.fromEntries(LANGS.map((lang) => [lang, [uis[lang].T('costs.speech'), uis[lang].T('costs.music')]]));
  assert.deepEqual(names.de, ['Sprache', 'Musik']);
  assert.deepEqual(names.en, ['Speech', 'Music']);
  assert.deepEqual(names.es, ['Voz', 'Música']);
}

// "Use as text" warns when Design App inputs no longer reach an app output, and the app panel marks such inputs.
function testAppCutOffWiring() {
  const main = read('public/nodes/main.js');
  assert.match(main, /graphLib\.appInputsCutOff\(state\.graph, result\.graph, currentApp\(\)\)/);
  assert.match(main, /nodes\.adopt\.appCutOff/);
  const inspector = read('public/nodes/inspector.js');
  assert.match(inspector, /graphLib\.appInputsWithoutOutput\(ctx\.graph, app\)/);
  assert.match(inspector, /nodes\.app\.noOutputReach/);
  for (const lang of LANGS) {
    assert.match(uis[lang].T('nodes.adopt.appCutOff', { count: 2 }), /2/);
    assert.doesNotMatch(uis[lang].T('nodes.adopt.appCutOff', { count: 2 }), /\{count\}/);
  }
}

const tests = [testTextsInThreeLanguages, testErrorTextsWithValues, testWordsAgree, testCostHints, testMenuHintMarkup, testPlanFieldWiring, testCostTypeNames, testAppCutOffWiring];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('test-nodes-music-ui ok');
