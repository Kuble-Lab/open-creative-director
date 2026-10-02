'use strict';

// Help for node types (public/nodes/node-help.js, WP23): the texts written by hand (nodes.type.<type>.help / .example /
// .tip.1 to .tip.4 in public/nodes/i18n-nodes.js), the parts generated from the registry (ports, cost, availability),
// the fix for an incomplete node, and static checks of the wiring (no innerHTML, every CSS class defined, every
// translation key present, script order).
//
// Every node type has its texts, so the completeness check is on (`REQUIRE_ALL_TYPES`): a new node type without help,
// example and at least one tip fails the test. While texts are being written, set it to false: the test then only reports
// how many types are done (a single run can also be forced with `NODE_HELP_REQUIRE_ALL=1`).

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const runLib = require('../public/nodes/run');
const registryModule = require('../lib/nodes/registry');

const REQUIRE_ALL_TYPES = true;

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const LANGS = ['de', 'en', 'es'];
const SAMPLE_TYPES = ['video.motion_graphics', 'llm.motion_html', 'video.seedance', 'input.image', 'image.edit', 'video.concat'];
const LIMITS = { help: 320, example: 260, tip: 240 };
// Types with a fourth tip: real persons (Seedance), the cost of the speech, the points of the music nodes.
const FOURTH_TIP = ['video.seedance', 'audio.tts', 'audio.music', 'audio.music_plan'];

const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
const reg = graphLib.indexRegistry(payload);

// The browser pieces the module needs, without a DOM: the dictionaries, translation helpers and the registry index.
function loadHelp(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  const T = (key, vars) => window.t(key, vars);
  const tr = (key, fallback, vars) => {
    const value = T(key, vars);
    return value === key ? fallback : value;
  };
  const humanize = (id) => String(id).replace(/[_-]+/g, ' ');
  const ui = {
    el: () => ({}),
    T,
    tr,
    portLabel: (id) => tr(`nodes.port.${id}`, humanize(id)),
    typeLabel: (def) => tr(`nodes.type.${def.type}.label`, def.label || def.type),
    availabilityReason: (reason) => reason
  };
  window.OCDNodes = { graph: graphLib, ui, run: runLib };
  vm.runInNewContext(read('public/nodes/node-help.js'), { window }, { filename: 'public/nodes/node-help.js' });
  return { help: window.OCDNodes.nodeHelp, window };
}

const dictionaries = Object.fromEntries(LANGS.map((lang) => [lang, loadHelp(lang).window.I18N[lang]]));
const typeIds = payload.nodeTypes.map((def) => def.type);

// which types have which part, from the keys of the German dictionary
const KEY = /^nodes\.type\.(.+)\.(help|example|tip\.([0-9]+))$/;
function textKeys(lang) {
  const found = new Map();
  for (const key of Object.keys(dictionaries[lang])) {
    const match = key.match(KEY);
    if (!match) continue;
    if (!found.has(match[1])) found.set(match[1], { help: false, example: false, tips: [] });
    const entry = found.get(match[1]);
    if (match[2] === 'help') entry.help = true;
    else if (match[2] === 'example') entry.example = true;
    else entry.tips.push(Number(match[3]));
  }
  return found;
}

function testKeysBelongToTypes() {
  for (const lang of LANGS) {
    for (const [type, entry] of textKeys(lang)) {
      assert.ok(typeIds.includes(type), `${lang}: help text for unknown node type ${type}`);
      const sorted = [...entry.tips].sort((a, b) => a - b);
      assert.deepEqual(sorted, sorted.map((_, index) => index + 1), `${lang} ${type}: tips are numbered 1, 2, 3 without gaps`);
      assert.ok(sorted.length <= 4 && (sorted.length <= 3 || FOURTH_TIP.includes(type)), `${lang} ${type}: at most 3 tips (${FOURTH_TIP.join(', ')} have a fourth)`);
      assert.ok(entry.help, `${lang} ${type}: tips or an example without the help text`);
    }
  }
}

function testTextsAreComplete() {
  const base = textKeys('de');
  for (const lang of LANGS) {
    assert.deepEqual([...textKeys(lang)].sort(), [...base].sort(), `${lang} has other texts than de`);
  }
  for (const type of SAMPLE_TYPES) {
    const entry = base.get(type);
    assert.ok(entry && entry.help && entry.example && entry.tips.length >= 1, `${type}: help, example and at least one tip are written`);
  }
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(dictionaries[lang])) {
      const match = key.match(KEY);
      if (!match) continue;
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.equal(value.includes('ß'), false, `${lang}.${key} contains a sharp s`);
      assert.equal(/\s{2,}|^\s|\s$/.test(value), false, `${lang}.${key}: stray white space`);
      const limit = match[2].startsWith('tip') ? LIMITS.tip : LIMITS[match[2]];
      assert.ok(value.length <= limit, `${lang}.${key} has ${value.length} characters (limit ${limit}): shorten it`);
      assert.equal(/<[a-z/]|&[a-z]+;/i.test(value), false, `${lang}.${key}: the texts are plain text, no HTML`);
    }
  }
}

// The completeness check for every type: reported as a count until the texts exist, enforced once switched on.
function testEveryTypeHasHelp() {
  const written = textKeys('de');
  const missing = typeIds.filter((type) => !written.has(type) || !written.get(type).example || !written.get(type).tips.length);
  const enforce = REQUIRE_ALL_TYPES || process.env.NODE_HELP_REQUIRE_ALL === '1';
  if (enforce) assert.deepEqual(missing, [], `node types without a complete help text: ${missing.join(', ')}`);
  else console.log(`   help texts: ${typeIds.length - missing.length} of ${typeIds.length} node types written, ${missing.length} still to do (REQUIRE_ALL_TYPES is off)`);
}

function testTypeTextsAndFallback() {
  for (const lang of LANGS) {
    const { help } = loadHelp(lang);
    const dict = dictionaries[lang];
    const seedance = help.typeTexts('video.seedance');
    assert.equal(seedance.what, dict['nodes.type.video.seedance.help']);
    assert.equal(seedance.example, dict['nodes.type.video.seedance.example']);
    assert.deepEqual([...seedance.tips], [1, 2, 3, 4].map((n) => dict[`nodes.type.video.seedance.tip.${n}`]));
    // a type without texts, and one that does not exist: empty parts, never the key and never a made-up sentence
    const none = help.typeTexts('no.such_type');
    assert.deepEqual(JSON.parse(JSON.stringify(none)), { what: '', example: '', tips: [] });
    const unwritten = typeIds.find((type) => !textKeys('de').has(type));
    if (unwritten) assert.deepEqual(JSON.parse(JSON.stringify(help.typeTexts(unwritten))), { what: '', example: '', tips: [] });
  }
}

function testDescribe() {
  const { help } = loadHelp('de');
  const defOf = (type) => reg.types.get(type);

  // the ports come from the registry: nothing to keep in step by hand
  const motion = help.describe(reg, defOf('video.motion_graphics'));
  assert.equal(motion.hasTexts, true);
  assert.deepEqual(motion.inputs.map((row) => row.id), defOf('video.motion_graphics').inputs.map((port) => port.id));
  const html = motion.inputs.find((row) => row.id === 'html');
  assert.equal(html.required, true);
  assert.equal(html.base, 'text');
  assert.equal(html.orField, true, 'the HTML can also be typed into the node');
  const assets = motion.inputs.find((row) => row.id === 'assets');
  assert.equal(assets.required, false);
  assert.equal(assets.multiple, true);
  assert.ok(assets.max > 1, 'the maximum of a multi input is shown');
  assert.equal(motion.outputs.length, 1);
  assert.equal(motion.cost.kind, 'free');
  assert.equal(motion.available === true || typeof motion.unavailableReason === 'string', true);

  // cost kinds and who bills
  const kinds = new Map(payload.nodeTypes.map((def) => [def.type, help.costKey(def)]));
  assert.equal(kinds.get('video.seedance'), 'usd');
  assert.equal(kinds.get('video.higgsfield'), 'credits');
  assert.equal(kinds.get('fal.h3_video'), 'usd');
  assert.equal(kinds.get('llm.motion_html'), 'llm', 'a language model: OpenRouter, or the ChatGPT subscription');
  assert.equal(kinds.get('video.concat'), 'free');
  assert.equal(kinds.get('audio.tts'), 'usd', 'billed per character, the card shows the estimate');
  assert.equal(kinds.get('audio.music'), 'usd');
  assert.equal(kinds.get('audio.music_plan'), 'freecall', 'ElevenLabs is called, free of credits: neither local nor billed');
  assert.equal(kinds.get('input.image'), 'free');
  for (const [type, kind] of kinds) {
    assert.ok(['free', 'usd', 'llm', 'credits', 'external', 'freecall'].includes(kind), `${type}: ${kind}`);
    if (kind === 'usd' || kind === 'llm' || kind === 'credits') assert.ok(defOfPaid(type), `${type}: a paid node`);
  }
  function defOfPaid(type) {
    return reg.types.get(type).paid === true;
  }
  assert.ok(help.describe(reg, defOf('llm.motion_html')).cost.provider, 'a paid node names its provider');
  assert.ok(help.describe(reg, defOf('video.seedance')).cost.provider);
  assert.equal(help.describe(reg, defOf('input.image')).cost.provider, '');

  // every type can be described, in every language, with ports that exist
  for (const lang of LANGS) {
    const { help: localized } = loadHelp(lang);
    for (const def of payload.nodeTypes) {
      const info = localized.describe(reg, reg.types.get(def.type));
      assert.equal(info.type, def.type);
      assert.ok(info.label, `${lang} ${def.type}: label`);
      for (const row of [...info.inputs, ...info.outputs]) {
        assert.ok(row.label && row.typeLabel, `${lang} ${def.type}.${row.id}: label and type`);
        assert.equal(row.label.includes('nodes.'), false, `${lang} ${def.type}.${row.id}: untranslated key`);
      }
      assert.equal(localized.costText(info.cost).includes('nodes.help.cost'), false, `${lang} ${def.type}: cost text`);
      assert.equal(localized.costText(info.cost).includes('{'), false, `${lang} ${def.type}: placeholder left in the cost text`);
    }
  }

  // port flags
  const flags = help.portFlags(help.describe(reg, defOf('video.motion_graphics')).inputs.find((row) => row.id === 'html'));
  assert.ok(flags.some((flag) => flag.required === true), 'required flag');
  assert.ok(flags.length >= 2, 'required and "or type it in the node"');
  const outputFlags = help.portFlags(help.describe(reg, defOf('video.motion_graphics')).outputs[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(outputFlags)), [], 'an output has no flags');
}

function testSuggestHints() {
  const hinted = [];
  for (const def of payload.nodeTypes) {
    for (const port of def.inputs) {
      if (!port.suggest) continue;
      hinted.push(`${def.type}.${port.id}`);
      const source = reg.types.get(port.suggest);
      assert.ok(source, `${def.type}.${port.id}: suggest points to ${port.suggest}, which does not exist`);
      const accepts = source.outputs.some((out) => graphLib.canConnectTypes(reg, out.type, port.type));
      assert.ok(accepts, `${def.type}.${port.id}: ${port.suggest} has no output that fits the input`);
      assert.equal(graphLib.sourceFor(reg, port).type, port.suggest);
      assert.equal(graphLib.sourceFor(reg, port).hinted, true);
    }
  }
  assert.ok(hinted.includes('video.motion_graphics.html'), 'the Motion graphics node names its writer');
}

// The invalid card: text, port and the button.
function testInvalidFix() {
  const { window } = loadHelp('de');
  const T = (key, vars) => window.t(key, vars);
  // the issue texts exist for the two kinds of reader (card / app) in every language
  for (const lang of LANGS) {
    const dict = dictionaries[lang];
    for (const key of ['nodes.issue.missing_input', 'nodes.issue.missing_input.param', 'nodes.issue.missing_input.many', 'nodes.issue.missing_input.app', 'nodes.fix.addInput', 'nodes.fix.pickInput']) {
      assert.ok(dict[key], `${lang}: ${key}`);
    }
    assert.match(dict['nodes.issue.missing_input'], /\{port\}/);
    assert.match(dict['nodes.fix.addInput'], /\{name\}/);
  }
  assert.equal(T('nodes.issue.missing_input', { port: 'HTML' }), 'Eingang «HTML» fehlt. Verbinde einen passenden Node damit.');
}

function testWiring() {
  const help = read('public/nodes/node-help.js');
  const palette = read('public/nodes/palette.js');
  const inspector = read('public/nodes/inspector.js');
  const nodeUi = read('public/nodes/node-ui.js');
  const main = read('public/nodes/main.js');
  const runClient = read('public/nodes/run.js');
  const css = read('public/nodes/nodes.css');
  const html = read('public/index.html');

  for (const [file, source] of [['node-help.js', help], ['palette.js', palette], ['inspector.js', inspector], ['node-ui.js', nodeUi], ['main.js', main], ['run.js', runClient]]) {
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, `${file}: no HTML from strings`);
    assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\(/, `${file}: no native dialogs`);
  }

  // script order: after the templates (it asks them for their names), before the palette that shows it
  const at = (name) => html.indexOf(`<script src="nodes/${name}"></script>`);
  assert.ok(at('node-help.js') > at('templates-ui.js') && at('node-help.js') < at('palette.js'), 'node-help.js loads between templates-ui.js and palette.js');
  assert.ok(at('node-help.js') > at('node-ui.js') && at('node-help.js') > at('graph.js'));

  // every CSS class the help builds has a rule
  const classes = new Set();
  for (const source of [help, palette, inspector]) {
    for (const match of source.matchAll(/'([^'\n]*\bnv-[a-z0-9-]+[^'\n]*)'/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  }
  for (const match of nodeUi.matchAll(/'([^'\n]*\bnv-node-(?:help|fix)[a-z0-9-]*[^'\n]*)'/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  for (const name of ['nv-help', 'nv-help-pop', 'nv-node-help', 'nv-insp-help', 'nv-insp-fix', 'nv-pal-detail', 'nv-pal-help']) assert.ok(classes.has(name), `the class ${name} was found in the code`);
  // hooks the canvas and the inspector look for, which carry no style of their own
  const HOOKS = new Set(['nv-scroll', 'nv-nodrag', 'nv-insp-run-wrap', 'nv-help-insert']);
  const missing = [...classes].filter((name) => !name.endsWith('-') && !HOOKS.has(name)).filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
  assert.deepEqual(missing, [], `CSS classes without a rule: ${missing.join(', ')}`);
  assert.match(css, /@media \(max-width: 640px\)[^{]*\{[^]*\.nv-help-pop/, 'the popover becomes a bottom sheet on a phone');

  // every literal key of the help exists in all languages
  const window = { document: { documentElement: { lang: '' }, querySelectorAll: () => [] }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.runInNewContext(read('public/i18n.js'), { window });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window });
  for (const [file, source] of [['node-help.js', help], ['palette.js', palette], ['main.js', main], ['run.js', runClient], ['inspector.js', inspector]]) {
    for (const match of source.matchAll(/'(nodes\.(?:help|fix)\.[A-Za-z0-9_.]+)'/g)) {
      for (const lang of LANGS) assert.ok(window.I18N[lang][match[1]], `${lang}: ${match[1]} (${file})`);
    }
  }
  assert.ok(window.I18N.de['nodes.palette.insertWithInputs'] && window.I18N.en['nodes.palette.insertWithInputs'] && window.I18N.es['nodes.palette.insertWithInputs']);

  // the open/closed state is a convenience of the viewer: read and written inside try/catch
  assert.match(help, /try \{[^}]*localStorage[^}]*\} catch/);
  // the editor offers the pieces other code (and the tests of the editor) use
  assert.match(main, /insertWithInputs/);
  assert.match(main, /addInputFor/);
  assert.match(main, /fix: applyFix/);
  // keyboard: "?" / F1 open the help of the selected node, and the space bar still clicks a focused button (the "?")
  assert.match(main, /key === '\?' \|\| key === 'F1'/);
  assert.match(main, /function openSelectedHelp/);
  assert.match(main, /closest\('button'\)/);
  const page = read('public/help.html');
  assert.equal((page.match(/<strong>\?<\/strong>/g) || []).length >= 6, true, 'the key is named in the three languages (card help and keys)');
  assert.match(page, /Das Einfügen lässt sich mit einem Schritt rückgängig machen\. «Neuer Workflow» legt einen eigenen Workflow an/, '"New workflow" is not an undo step');
  assert.match(page, /Inserting can be undone in one step\. “New workflow” creates a workflow of its own/);
  assert.match(page, /La inserción se deshace en un solo paso\. «Nuevo workflow» crea un workflow propio/);
}

// The tips about list sizes say what the engine does: a list of more than 50 entries on a single input stops the run
// (it is not cut), a router index outside 0..connections-1 stops it, ChatGPT models run without OpenRouter cost.
async function testTextsMatchBehaviour() {
  const engineLib = require('../lib/nodes/engine');
  const limit = engineLib.resolveLimits().maxListItems;
  assert.equal(limit, 50, 'the texts say 50');
  const list = { type: 'list', itemType: 'text', items: Array.from({ length: limit + 1 }, (_, index) => ({ type: 'text', value: `x${index}` })) };
  const resolve = (items) =>
    engineLib.resolveNodeInputs({
      node: { id: 'b' },
      ports: { inputs: [{ id: 'in', type: 'text' }], outputs: [] },
      params: {},
      edges: [{ id: 'e', from: { node: 'a', port: 'items' }, to: { node: 'b', port: 'in' } }],
      outputsOf: () => ({ items }),
      maxListItems: limit
    });
  assert.throws(() => resolve(list), /limit is 50/, 'more than 50 items on a single input stop the run, they are not cut');
  assert.equal(resolve({ ...list, items: list.items.slice(0, limit) }).mapLength, limit);

  const tipsAbout = [['input.text_list', 2], ['text.split', 2], ['input.media_list', 3]];
  for (const lang of LANGS) {
    const dict = dictionaries[lang];
    for (const [type, number] of tipsAbout) {
      const tip = dict[`nodes.type.${type}.tip.${number}`];
      assert.match(tip, /\b50\b/, `${lang} ${type}.tip.${number}: names the limit`);
      assert.doesNotMatch(tip, /schon vorher|even earlier|aún antes|ohnehin|anyway|de todos modos/, `${lang} ${type}.tip.${number}: the engine does not cut the list for a single input`);
    }
    assert.match(dict['nodes.type.input.text_list.tip.2'], /stopp|stop|detien/, `${lang}: a longer list stops the run`);
    assert.match(dict['nodes.type.text.split.tip.2'], /stopp|stop|detien/, `${lang}: a longer split stops the run`);
  }

  // the router: index < 0 or >= connections fails, so "2 of 2" is wrong too
  const router = registryModule.get('util.router');
  const two = { inputs: { items: [{ type: 'text', value: 'a' }, { type: 'text', value: 'b' }] } };
  assert.equal((await router.execute({}, two, { index: 1 })).variants[0].out.value, 'b');
  await assert.rejects(router.execute({}, two, { index: 2 }), /out of range/, 'index = number of connections fails');
  await assert.rejects(router.execute({}, two, { index: -1 }), /out of range/, 'a negative index fails');
  for (const lang of LANGS) {
    assert.match(dictionaries[lang]['nodes.type.util.router.tip.2'], /(?:negativ|negative)/, `${lang}: the router tip names the negative index`);
    assert.match(dictionaries[lang]['nodes.type.util.router.tip.2'], /gleich|equal|igual/, `${lang}: ... and the index that equals the number of connections`);
  }
}

// Cost sentences: language models say that a ChatGPT model needs no OpenRouter, local nodes do not claim a place to run.
function testCostSentences() {
  const llm = ['llm.chat', 'llm.prompt_enhancer', 'llm.image_describer', 'llm.video_describer', 'llm.motion_html'];
  for (const lang of LANGS) {
    const { help: localized } = loadHelp(lang);
    for (const type of llm) {
      const info = localized.describe(reg, reg.types.get(type));
      assert.equal(info.cost.kind, 'llm', `${type}: language model`);
      assert.notEqual(info.cost.provider, 'llm', `${type}: the label names the service, not the kind`);
      assert.match(localized.costText(info.cost), /ChatGPT/, `${lang} ${type}: the ChatGPT subscription is mentioned`);
    }
    assert.equal(localized.describe(reg, reg.types.get('video.seedance')).cost.kind, 'usd');
    const free = localized.costText(localized.describe(reg, reg.types.get('video.motion_graphics')).cost);
    assert.doesNotMatch(free, /server|servidor/i, `${lang}: a free node (Motion graphics renders on the render node) does not claim to run on this server`);
  }
}

function testNoInternalNames() {
  // the help is shipped with the open source app: no names of internal systems in the texts or the code
  const files = ['public/nodes/node-help.js', 'public/nodes/templates-ui.js', 'public/nodes/i18n-nodes.js', 'public/help.html', ...fs.readdirSync(path.join(root, 'lib/nodes/templates')).map((name) => `lib/nodes/templates/${name}`)];
  for (const file of files) {
    const source = read(file);
    // generic on purpose: the names of hosts and people are not spelled out here either (see the tests of the internal hosts)
    assert.doesNotMatch(source, /kuble\.com|\.internal\b|\b10\.\d+\.\d+\.\d+\b|\/Users\/[a-z]/i, `${file}: internal name`);
  }
}

const tests = [testKeysBelongToTypes, testTextsAreComplete, testEveryTypeHasHelp, testTypeTextsAndFallback, testDescribe, testSuggestHints, testInvalidFix, testWiring, testTextsMatchBehaviour, testCostSentences, testNoInternalNames];
(async () => {
  for (const test of tests) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log(`help ok: ${tests.length} Gruppen, ${typeIds.length} Node-Typen`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
