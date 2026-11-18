'use strict';

// The text of a scene typed in the scene list of the node editor: the narration of single scenes of the explainer video is changed word
// for word, without a model, and only those scenes are made again.
//   - the param kind `notes` with `edits`: { s3: { text, was } }, normalisation, a bad definition is refused
//   - lib/explainer-revise.js applyNarrationEdits: only the scenes with a text change, the others stay byte for byte; the anchors follow
//     the new words; a text typed on another narration is left out; a text too long for one scene is named; the script is not verified
//     any more and remembers the scene of before; a scene of before is what a later run of the same notes reuses
//   - explainer.plan (real definition, the model replaced): no model call at all, the base from the cache, the lists of the other scenes
//     unchanged (narration, context, briefs), a text that is too long stops the run, texts together with a note
//   - public/nodes/scene-table.js: where the rows of a node are edited (the planner, the voice and the picture behind it), the fields of
//     the rows and the value of the param after typing
//   - the texts of the interface in every language
// Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const path = require('path');
const vm = require('vm');

const registryModule = require('../lib/nodes/registry');
const { createRegistry } = registryModule;
const { textValue } = require('../lib/nodes/types');
const llm = require('../lib/nodes/llm');
const or = require('../lib/openrouter');
const fal = require('../lib/fal');
const planLib = require('../lib/explainer-plan');
const reviseLib = require('../lib/explainer-revise');
require('../lib/nodes/nodes-explainer');
require('../lib/nodes/nodes-explainer-video');
const sceneTable = require('../public/nodes/scene-table');

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}

const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
const narrationOf = (k, n = 22) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';
function sceneOf(k) {
  const narration = narrationOf(k);
  const list = narration.replace(/\./g, '').split(' ');
  return {
    kind: 'motion',
    role: k === 1 ? 'hook' : k === 8 ? 'summary' : 'point',
    narration,
    on_screen: { title: `Titel ${k}`, bullets: [`Stichwort ${k}`], numbers: [], quote: null },
    elements: [{ type: 'title', content: `Titel ${k}`, anchor: list[0] }, { type: 'bullet', content: `Stichwort ${k}`, anchor: list[5] }],
    figure: null,
    image_prompt: null,
    clip_prompt: null,
    source_refs: [`S. ${((k - 1) % 3) + 1}`]
  };
}
const planAnswer = () => ({ title: 'Wärmepumpen', summary: 'Wie sie funktionieren', scenes: Array.from({ length: 8 }, (_x, i) => sceneOf(i + 1)), presenter: null });
const DOCUMENT_TEXT = '=== D1: bericht.pdf (12 pages) ===\n[p. 1]\nDie Wärmepumpe nutzt Strom.\n[p. 2]\nDer Markt wächst.\n[p. 3]\nDie Förderung läuft bis 2030.';
const SETTINGS = { language: 'de', visualMode: 'mix', format: 'landscape', lengthSeconds: 90, documents: [{ name: 'bericht.pdf', title: 'bericht', pageCount: 12 }], capabilities: { image: true, fal: true } };
const OWN = 'Eine Wärmepumpe holt die Wärme aus der Luft, auch im Winter, und braucht dafür nur wenig Strom.';

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  global.fetch = (input) => {
    attempts.push(typeof input === 'string' ? input : input?.url || String(input));
    return Promise.reject(new Error('network access refused in the test'));
  };
  try {
    editsParam();
    edits();
    await planNode();
    table();
    texts();
  } finally {
    while (restorers.length) restorers.pop()();
    global.fetch = realFetch;
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-scene-text.js: ok');
}

/* ---------- the param kind `notes` with `edits` ---------- */

function editsParam() {
  const real = registryModule.registry;
  const planDef = real.get('explainer.plan');
  assert.deepEqual(planDef.params.find((param) => param.id === 'narration_edits'), {
    id: 'narration_edits', kind: 'notes', edits: 'narration', source: 'script', lists: ['narration', 'narration_context', 'briefs'], default: {}, cacheOmitDefault: true
  });
  assert.deepEqual(real.normalizeParams(planDef, {}).narration_edits, {}, 'no text is the default');
  const long = 'x'.repeat(2000);
  const normal = real.normalizeParams(planDef, {
    narration_edits: { s3: { text: '  Neuer\r\nText  ', was: ' Alter Text ' }, s2: 'nur Text', s1: { text: '   ', was: 'x' }, 'bad id': { text: 'nein' }, s4: 5, s5: { was: 'ohne Text' }, s6: { text: long, was: long }, all: { text: 'für alle' }, s7: ['x'] }
  }).narration_edits;
  assert.deepEqual(Object.keys(normal), ['s2', 's3', 's6'], 'sorted; no empty text, no bad id, no entry without a text, no text for the whole script');
  assert.deepEqual(normal.s3, { text: 'Neuer\nText', was: 'Alter Text' });
  assert.deepEqual(normal.s2, { text: 'nur Text' }, 'a plain string is a text without what it replaces');
  assert.equal(normal.s6.text.length, 1500);
  assert.equal(normal.s6.was.length, 1500);
  for (const bad of [null, 'text', ['s1'], 7]) assert.deepEqual(real.normalizeParams(planDef, { narration_edits: bad }).narration_edits, {});
  // the notes next to it are still plain texts
  assert.deepEqual(real.normalizeParams(planDef, { feedback: { s3: { text: 'kein Text' }, s4: 'kürzer' } }).feedback, { s4: 'kürzer' });

  const registry = createRegistry();
  const base = { category: 'input', inputs: [{ id: 'items', type: 'text' }], outputs: [{ id: 'out', type: 'text' }] };
  assert.throws(() => registry.register({ ...base, type: 't.bad1', params: [{ id: 'n', kind: 'notes', edits: 'Bad Name', default: {} }], execute: async () => ({}) }), /bad notes/);
  assert.throws(() => registry.register({ ...base, type: 't.bad2', params: [{ id: 'n', kind: 'notes', edits: 'narration', whole: true, default: {} }], execute: async () => ({}) }), /bad notes/);
  registry.register({ ...base, type: 't.good', params: [{ id: 'n', kind: 'notes', edits: 'narration', source: 'out', lists: ['out'], default: {} }], execute: async () => ({}) });
}

/* ---------- lib/explainer-revise.js ---------- */

function baseScript() {
  const built = planLib.buildScript(planAnswer(), SETTINGS);
  assert.ok(built.script, 'the plan of the test is usable');
  const script = planLib.finalizeScript(built.script, SETTINGS, []);
  script.verified = true;
  script.verified_hash = planLib.textHash(script);
  return script;
}

function edits() {
  const base = baseScript();
  const frozen = JSON.stringify(base);
  const was = base.scenes[2].narration;

  // one scene with a text: only it changes
  const one = reviseLib.applyNarrationEdits(base, { s3: { text: `  ${OWN}  `, was }, s99: { text: 'gibt es nicht' } }, { input: SETTINGS });
  assert.equal(JSON.stringify(base), frozen, 'the base is never changed');
  assert.deepEqual(one.changed, ['s3']);
  assert.deepEqual(one.stale, []);
  assert.deepEqual(one.tooLong, []);
  assert.equal(one.script.scenes[2].narration, OWN, 'word for word');
  one.script.scenes.forEach((scene, index) => {
    if (index !== 2) assert.equal(JSON.stringify(scene), JSON.stringify(base.scenes[index]), `scene ${scene.id} stays byte for byte`);
  });
  const changed = one.script.scenes[2];
  assert.deepEqual(changed.on_screen, base.scenes[2].on_screen, 'the text on screen stays');
  assert.equal(changed.kind, base.scenes[2].kind);
  assert.deepEqual(changed.source_refs, base.scenes[2].source_refs);
  assert.equal(changed.est_seconds, Math.max(1, planLib.secondsFor(OWN, 'de')), 'the length follows the text');
  for (const element of changed.elements) assert.ok(!element.anchor || OWN.toLowerCase().includes(element.anchor.toLowerCase()), `the anchor "${element.anchor}" is a word of the new text`);
  assert.equal(one.script.verified, false, 'the check saw other words');
  assert.equal(one.script.verified_hash, undefined);
  assert.deepEqual(one.script.unverified_scenes, ['s3']);
  assert.equal(JSON.stringify(one.script.edits), JSON.stringify({ s3: base.scenes[2] }), 'the script remembers the scene of before');

  // the same text as the scene has, an empty one, the sources card: nothing happens
  const none = reviseLib.applyNarrationEdits(base, { s3: { text: was }, s4: { text: '   ' } }, { input: SETTINGS });
  assert.deepEqual(none.changed, []);
  assert.equal(JSON.stringify(none.script), frozen);
  const card = base.scenes.find((scene) => scene.role === 'sources');
  if (card) assert.deepEqual(reviseLib.narrationEditsFor(base, { [card.id]: { text: 'Quellen neu' } }), {});

  // a text typed on another narration is not put into this one
  const stale = reviseLib.applyNarrationEdits(base, { s3: { text: OWN, was: 'Ein ganz anderer Satz von früher.' }, s4: { text: 'Kurz und gut, die Pumpe spart Strom.', was: base.scenes[3].narration } }, { input: SETTINGS });
  assert.deepEqual(stale.stale, ['s3']);
  assert.deepEqual(stale.changed, ['s4']);
  assert.equal(stale.script.scenes[2].narration, was);
  // without `was` the text counts for whatever the scene says
  assert.deepEqual(reviseLib.applyNarrationEdits(base, { s3: OWN }, { input: SETTINGS }).changed, ['s3']);

  // too long for one scene: named, not put in
  const longText = Array.from({ length: 80 }, (_x, i) => VOCAB[i % VOCAB.length]).join(' ') + '.';
  const long = reviseLib.applyNarrationEdits(base, { s3: { text: longText, was } }, { input: SETTINGS });
  assert.deepEqual(long.changed, []);
  assert.equal(long.tooLong[0].id, 's3');
  assert.ok(long.tooLong[0].seconds > planLib.LIMITS.hardMaxSceneSeconds);

  // an own text (verbatim): the typed text counts there too, and its spelling is the person's
  const verbatim = { ...JSON.parse(frozen), verbatim: true };
  const sharp = 'Die Wärmepumpe spart Strom, und das ist heiß begehrt in jedem Haus.';
  const own = reviseLib.applyNarrationEdits(verbatim, { s2: { text: sharp } }, { input: { ...SETTINGS, verbatim: true } });
  assert.equal(own.script.scenes[1].narration, sharp);

  // a later run of the same note takes the scene as the note left it, not as the person typed over it
  const noted = JSON.parse(frozen);
  noted.scenes[2] = { ...noted.scenes[2], narration: 'Die Notiz machte diesen Satz kürzer und Wärme3 blieb.' };
  noted.feedback = reviseLib.feedbackRecord(base, { scenes: { s3: 'kürzer' }, whole: '' }, ['s3']);
  const typed = reviseLib.applyNarrationEdits(noted, { s3: { text: OWN, was: noted.scenes[2].narration } }, { input: SETTINGS }).script;
  assert.deepEqual(typed.feedback, noted.feedback, 'the memory of the notes stays');
  const reused = reviseLib.reusableScenes(base, { scenes: { s3: 'kürzer' }, whole: '' }, [typed]);
  assert.equal(reused.scenes.get('s3').narration, noted.scenes[2].narration);
}

/* ---------- explainer.plan ---------- */

async function planNode() {
  const real = registryModule.registry;
  const planDef = real.get('explainer.plan');
  const calls = [];
  const queue = { revise: [] };
  const kindOf = (system) => (/You revise single scenes/.test(system) ? 'revise' : /write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : 'other');
  const echoCheck = (options) => {
    const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
    return { scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) };
  };
  patch(llm, 'completeText', async (options) => {
    const kind = kindOf(options.system || '');
    calls.push(kind);
    let value = queue[kind]?.length ? queue[kind].shift() : kind === 'plan' ? planAnswer() : kind === 'verify' ? echoCheck : { scenes: [] };
    if (typeof value === 'function') value = value(options);
    return { text: JSON.stringify(value), usd: 0.1 };
  });
  patch(or, 'hasKey', () => true);
  patch(fal, 'hasKey', () => true);
  const makeCtx = ({ cached = null, earlier = [] } = {}) => {
    const logs = [];
    const asked = [];
    return {
      workflowId: 'wf', nodeId: 'plan', sessionId: 'sess', user: 'staff1@staff.example.com',
      config: { defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'], imageModel: 'openai/gpt-image-2' },
      signal: new AbortController().signal, toolCtx: {},
      log: (line) => logs.push(line),
      cachedResult: async (overrides) => {
        asked.push(overrides);
        return cached ? JSON.parse(JSON.stringify(cached)) : null;
      },
      earlierVariants: () => earlier,
      logs, asked
    };
  };
  const inputs = { text: textValue(DOCUMENT_TEXT) };
  const exec = (ctx, raw = {}) => planDef.execute(ctx, inputs, real.normalizeParams(planDef, { language: 'de', ...raw }));
  const values = (list) => list.items.map((item) => item.value);

  const v0 = (await exec(makeCtx())).variants[0];
  const script0 = JSON.parse(v0.script.value);
  assert.deepEqual(calls, ['plan', 'verify']);
  assert.equal(script0.verified, true);
  const was = script0.scenes[2].narration;

  // a text for s3: no model at all, the base from the cache, nothing to pay
  calls.length = 0;
  const ctx1 = makeCtx({ cached: v0, earlier: [v0] });
  const second = await exec(ctx1, { narration_edits: { s3: { text: OWN, was } } });
  assert.deepEqual(calls, [], 'no model call');
  assert.deepEqual(ctx1.asked, [{ feedback: {}, narration_edits: {} }], 'the base is the result without notes and without texts');
  assert.equal(second.cost.usd, 0);
  const v1 = second.variants[0];
  const script1 = JSON.parse(v1.script.value);
  assert.equal(script1.scenes[2].narration, OWN);
  assert.equal(script1.verified, false);
  assert.equal(script1.edits.s3.narration, was);
  assert.ok(ctx1.logs.some((line) => /Scene texts: s3 with your text/.test(line)), ctx1.logs.join('\n'));
  for (const port of ['narration', 'narration_context', 'briefs']) {
    const now = values(v1[port]);
    const before = values(v0[port]);
    assert.equal(now.length, before.length, `${port}: one entry per scene as before`);
    now.forEach((text, index) => {
      // (the text around s3 is the one of its neighbours, which did not change)
      if (index === 2 && port !== 'narration_context') assert.notEqual(text, before[index], `${port}: the scene with the text is new`);
      else if (index === 2) assert.equal(text, before[index]);
      else assert.equal(text, before[index], `${port}: scene ${index + 1} is unchanged, so its voice and picture come from the cache`);
    });
  }
  assert.equal(values(v1.narration)[2], OWN);
  for (const port of ['image_prompts', 'clip_prompts', 'presenter']) assert.deepEqual(values(v1[port]), values(v0[port]), `${port} unchanged`);
  assert.equal(v1.sources.value, v0.sources.value);

  // the price before the run: nothing
  assert.deepEqual(planDef.cost.estimate(real.normalizeParams(planDef, { language: 'de', narration_edits: { s3: { text: OWN, was } } }), { inputs, connected: new Set(['text']), config: {} }), { usd: 0 });

  // the text taken away again: the plan of before, from the cache (the engine finds it by its key; here the node is not asked at all)
  // a text that is too long stops the run with a message that names the scene
  const longText = Array.from({ length: 80 }, (_x, i) => VOCAB[i % VOCAB.length]).join(' ') + '.';
  await assert.rejects(exec(makeCtx({ cached: v0 }), { narration_edits: { s3: { text: longText, was } } }), (err) => err.code === 'EXPLAINER_EDIT_TOO_LONG' && /Scene s3/.test(err.message));

  // a text typed on another script: left out, the script stays the base
  calls.length = 0;
  const ctx2 = makeCtx({ cached: v0 });
  const third = await exec(ctx2, { narration_edits: { s3: { text: OWN, was: 'Ein Satz aus einem anderen Skript.' } } });
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(third.variants[0].script.value).scenes[2].narration, was);
  assert.ok(ctx2.logs.some((line) => /another narration than when the text was typed/.test(line)));
  assert.deepEqual(values(third.variants[0].narration), values(v0.narration));

  // a note on s5 and a text on s3: one call for s5 (and its check), s3 word for word, the others unchanged
  calls.length = 0;
  queue.revise.push({ scenes: [{ id: 's5', narration: 'Wärme5 Pumpe5 spart Kosten5 im Winter5 und Haus5.', on_screen: { title: 'Kurz 5', bullets: [], numbers: [], quote: null }, elements: [{ type: 'title', content: 'Kurz 5', anchor: 'Wärme5' }] }] });
  const fourth = await exec(makeCtx({ cached: v0, earlier: [v0] }), { feedback: { s5: 'kürzer' }, narration_edits: { s3: { text: OWN, was } } });
  assert.deepEqual(calls, ['revise', 'verify']);
  const v4 = fourth.variants[0];
  const script4 = JSON.parse(v4.script.value);
  assert.equal(script4.scenes[2].narration, OWN);
  assert.match(script4.scenes[4].narration, /^Wärme5 Pumpe5 spart/);
  assert.deepEqual(script4.feedback.changed, ['s5']);
  values(v4.narration).forEach((text, index) => {
    if (![2, 4].includes(index)) assert.equal(text, values(v0.narration)[index]);
  });
  values(v4.narration_context).forEach((text, index) => {
    if (![2, 4].includes(index)) assert.equal(text, values(v0.narration_context)[index], `the voice of scene ${index + 1} is not made again because a neighbour changed`);
  });

  // an edited script in the field "Script" and a text: the text goes into that script, no model
  calls.length = 0;
  const fifth = await exec(makeCtx(), { script: v0.script.value, narration_edits: { s3: { text: OWN, was } } });
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(fifth.variants[0].script.value).scenes[2].narration, OWN);
}

/* ---------- the scene list of the inspector ---------- */

function table() {
  const real = registryModule.registry;
  const typeOf = (types) => (id) => real.get(types[id]);
  const types = { p: 'explainer.plan', v: 'explainer.voice', c: 'explainer.scene', x: 'explainer.scene' };
  const edges = [
    { from: { node: 'p', port: 'narration' }, to: { node: 'v', port: 'narration' } },
    { from: { node: 'p', port: 'narration_context' }, to: { node: 'v', port: 'context' } },
    { from: { node: 'p', port: 'briefs' }, to: { node: 'c', port: 'brief' } },
    { from: { node: 'v', port: 'timing' }, to: { node: 'c', port: 'timing' } },
    { from: { node: 'v', port: 'timing' }, to: { node: 'x', port: 'timing' } }
  ];
  const target = (nodeId, port) => sceneTable.editTarget({ nodeId, def: real.get(types[nodeId]), port, inputPorts: real.get(types[nodeId]).inputs, edges, typeOf: typeOf(types) });
  // the planner itself, at the lists that follow its scenes
  assert.equal(target('p', 'narration').nodeId, 'p');
  assert.equal(target('p', 'narration').param.id, 'narration_edits');
  assert.equal(target('p', 'image_prompts'), null, 'a list that has not one entry per scene');
  // the voice and the picture behind it: the texts are the planner's
  assert.equal(target('v', 'audio').nodeId, 'p');
  assert.equal(target('c', 'video').nodeId, 'p');
  assert.equal(target('x', 'video'), null, 'a scene that does not get its brief from the planner');

  const script = {
    scenes: [{ id: 's1', role: 'hook', narration: 'Hallo zusammen.' }, { id: 's2', role: 'point', narration: 'Neu getippt.' }, { id: 's3', role: 'point', narration: 'Dritter Satz.' }, { id: 's4', role: 'sources', narration: '' }],
    edits: { s2: { id: 's2', narration: 'Zweiter Satz.' } }
  };
  const variant = { script: textValue(JSON.stringify(script)) };
  const params = { narration_edits: { s2: { text: 'Neu getippt.', was: 'Zweiter Satz.' }, s3: { text: 'Noch nicht gelaufen.', was: 'Dritter Satz.' } } };
  const rows = sceneTable.sceneEdits({ target: target('v', 'audio'), variant, params, count: 4 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { nodeId: 'p', param: 'narration_edits', id: 's1', text: 'Hallo zusammen.', original: 'Hallo zusammen.', value: 'Hallo zusammen.', changed: false, pending: false });
  assert.deepEqual([rows[1].value, rows[1].original, rows[1].changed, rows[1].pending], ['Neu getippt.', 'Zweiter Satz.', true, false], 'a text the result already holds');
  assert.deepEqual([rows[2].value, rows[2].original, rows[2].changed, rows[2].pending], ['Noch nicht gelaufen.', 'Dritter Satz.', true, true], 'a text the workflow has not run with yet');
  assert.equal(rows[3], null, 'the sources card has no text of its own');
  // a text taken away while the result still holds it: the field shows the result, and it is marked as not made yet
  const cleared = sceneTable.sceneEdits({ target: target('p', 'narration'), variant, params: {}, count: 4 });
  assert.deepEqual([cleared[1].value, cleared[1].changed, cleared[1].pending], ['Neu getippt.', false, true]);
  // no script, another number of scenes: no fields
  assert.equal(sceneTable.sceneEdits({ target: target('p', 'narration'), variant, params, count: 3 }), null);
  assert.equal(sceneTable.sceneEdits({ target: target('p', 'narration'), variant: { script: textValue('kein JSON') }, params, count: 4 }), null);
  assert.equal(sceneTable.sceneEdits({ target: null, variant, params, count: 4 }), null);

  // typing: the text with what it replaces; the original text or an empty field takes the entry away
  const current = params.narration_edits;
  const frozen = JSON.stringify(current);
  assert.deepEqual(sceneTable.withEdit(current, rows[0], '  Guten Tag.  '), { ...current, s1: { text: 'Guten Tag.', was: 'Hallo zusammen.' } });
  assert.deepEqual(sceneTable.withEdit(current, rows[1], 'Nochmals anders.').s2, { text: 'Nochmals anders.', was: 'Zweiter Satz.' }, 'the text it replaces is the one before the first typed text');
  assert.deepEqual(Object.keys(sceneTable.withEdit(current, rows[1], 'Zweiter  Satz. ')), ['s3'], 'back to the original');
  assert.deepEqual(Object.keys(sceneTable.withEdit(current, rows[2], '')), ['s2'], 'an empty field');
  assert.deepEqual(sceneTable.withEdit(undefined, rows[0], 'Hallo zusammen.'), {});
  assert.equal(JSON.stringify(current), frozen, 'the value of before is not changed');
  // what the fields write is what the registry keeps
  const planDef = real.get('explainer.plan');
  const written = sceneTable.withEdit(current, rows[0], 'Guten Tag.');
  assert.deepEqual(real.normalizeParams(planDef, { narration_edits: written }).narration_edits, written);

  // the app view keeps its notes: the param of the texts is none of them
  const read = (file) => require('fs').readFileSync(path.join(__dirname, '..', file), 'utf8');
  const window = { OCDNodes: { graph: {}, ui: { el: () => ({}), icon: () => ({}), T: (key) => key }, api: {}, run: {} } };
  vm.runInNewContext(read('public/nodes/app-mode.js'), { window, localStorage: undefined, console });
  const groups = window.OCDNodes.appMode.feedbackTargets({ nodes: Object.entries(types).map(([id, type]) => ({ id, type, params: {} })), edges }, (type) => real.get(type));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].param.id, 'feedback');
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].followers.map((item) => item.param.id))), ['feedback', 'feedback']);
}

/* ---------- the texts of the interface ---------- */

function texts() {
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'public/nodes/i18n-nodes.js'), 'utf8');
  for (const key of [
    'nodes.param.narration_edits', 'nodes.edits.none', 'nodes.edits.count', 'nodes.edits.clear', 'nodes.scenes.editText', 'nodes.scenes.editHint', 'nodes.scenes.edited',
    'nodes.scenes.editPending', 'nodes.scenes.editPendingHint', 'nodes.scenes.editReset', 'nodes.issue.EXPLAINER_EDIT_TOO_LONG'
  ]) {
    const line = source.split('\n').find((item) => item.includes(`['${key}',`));
    assert.ok(line, `${key} has its texts`);
    const row = vm.runInNewContext(`(${line.trim().replace(/,$/, '')})`);
    assert.equal(row.length, 4, `${key}: German, English, Spanish`);
    for (const text of row.slice(1)) assert.ok(typeof text === 'string' && text.trim(), `${key}: no empty text`);
    assert.ok(!row[1].includes('ß'), `${key}: Swiss spelling`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
