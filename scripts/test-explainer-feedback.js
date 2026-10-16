'use strict';

// The feedback per scene of the explainer video (WP56): a note on a scene makes only that scene new, everything else comes from the cache.
//   - the param kind `notes`: normalisation (ids, limits, the whole note), definitions, a bad definition is refused
//   - lib/explainer-revise.js: only the scenes with a note change, the others stay byte for byte; an unchanged note is not sent again;
//     a revision that is too long or answers for another scene is not taken; an own text keeps its narration
//   - explainer.plan (real definition, the model replaced): the base from the cache (no new plan), one call for the noted scenes and the
//     check of only those, the lists of the other scenes unchanged (narration, context, briefs), no call without notes, the edited script
//   - the engine with the real voice and scene definitions (execution replaced): empty notes keep the keys; a note on s3 runs item s3 of
//     the voice and the scene only (the plan prices only it); clearing the note brings the earlier take back for free; ctx.cachedResult
//     gives the scene without the note; a new length of the whole video draws no scene again, and the scenes drawn before WP56 are found
// Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const registryModule = require('../lib/nodes/registry');
const { createRegistry } = registryModule;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine, computeItemKeys } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');
const llm = require('../lib/nodes/llm');
const or = require('../lib/openrouter');
const fal = require('../lib/fal');
const planLib = require('../lib/explainer-plan');
const reviseLib = require('../lib/explainer-revise');
const explainerNodes = require('../lib/nodes/nodes-explainer');
const videoNodes = require('../lib/nodes/nodes-explainer-video');

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

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  global.fetch = (input) => {
    attempts.push(typeof input === 'string' ? input : input?.url || String(input));
    return Promise.reject(new Error('network access refused in the test'));
  };
  try {
    notesParam();
    revision();
    await planNode();
    await engineItems();
    appView();
  } finally {
    while (restorers.length) restorers.pop()();
    global.fetch = realFetch;
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-feedback.js: ok');
}

/* ---------- the param kind `notes` ---------- */

function notesParam() {
  const real = registryModule.registry;
  const planDef = real.get('explainer.plan');
  const voiceDef = real.get('explainer.voice');
  const sceneDef = real.get('explainer.scene');
  assert.deepEqual(planDef.params.find((param) => param.id === 'feedback'), { id: 'feedback', kind: 'notes', source: 'script', lists: ['narration', 'narration_context', 'briefs'], whole: true, default: {}, cacheOmitDefault: true });
  assert.deepEqual(voiceDef.params.find((param) => param.id === 'feedback'), { id: 'feedback', kind: 'notes', items: 'narration', default: {}, cacheOmitDefault: true });
  assert.deepEqual(sceneDef.params.find((param) => param.id === 'feedback'), { id: 'feedback', kind: 'notes', items: 'brief', default: {}, cacheOmitDefault: true });
  assert.deepEqual(real.normalizeParams(planDef, {}).feedback, {}, 'no note is the default');

  const long = 'x'.repeat(registryModule.MAX_NOTE_CHARS + 50);
  const normal = real.normalizeParams(planDef, { feedback: { s3: '  kürzer\r\nbitte  ', s1: '', 'bad id': 'nein', s2: 5, s4: long, all: ' direkter ', s10: '   ' } });
  assert.deepEqual(Object.keys(normal.feedback), ['all', 's3', 's4'], 'sorted, no empty, no bad id, no text that is no string');
  assert.equal(normal.feedback.s3, 'kürzer\nbitte');
  assert.equal(normal.feedback.s4.length, registryModule.MAX_NOTE_CHARS);
  assert.equal(normal.feedback.all, 'direkter');
  // the note about the whole script only where the param has one
  assert.deepEqual(real.normalizeParams(voiceDef, { feedback: { all: 'x', s2: 'y' } }).feedback, { s2: 'y' });
  for (const bad of [null, 'text', ['s1'], 7]) assert.deepEqual(real.normalizeParams(voiceDef, { feedback: bad }).feedback, {});
  const many = Object.fromEntries(Array.from({ length: registryModule.MAX_NOTES + 20 }, (_x, i) => [`s${i + 1}`, 'n']));
  assert.equal(Object.keys(real.normalizeParams(sceneDef, { feedback: many }).feedback).length, registryModule.MAX_NOTES);

  // a definition with a bad notes param is refused
  const registry = createRegistry();
  const base = { category: 'input', inputs: [{ id: 'items', type: 'text' }], outputs: [{ id: 'out', type: 'text' }] };
  assert.throws(() => registry.register({ ...base, type: 't.bad1', params: [{ id: 'n', kind: 'notes', items: 'nope', default: {} }], execute: async () => ({}) }), /unknown input/);
  assert.throws(() => registry.register({ ...base, type: 't.bad2', params: [{ id: 'n', kind: 'notes', source: 'nope', default: {} }], execute: async () => ({}) }), /unknown output/);
  assert.throws(() => registry.register({ ...base, type: 't.bad3', params: [{ id: 'n', kind: 'notes', default: { s1: 'x' } }], execute: async () => ({}) }), /bad notes/);
  assert.throws(() => registry.register({ ...base, type: 't.bad4', params: [{ id: 'n', kind: 'notes', whole: 'yes', default: {} }], execute: async () => ({}) }), /bad notes/);
  registry.register({ ...base, type: 't.good', params: [{ id: 'n', kind: 'notes', items: 'items', source: 'out', lists: ['out'], whole: true, default: {} }], execute: async () => ({}) });
}

/* ---------- lib/explainer-revise.js ---------- */

function baseScript() {
  const built = planLib.buildScript(planAnswer(), SETTINGS);
  assert.ok(built.script, 'the plan of the test is usable');
  return planLib.finalizeScript(built.script, SETTINGS, []);
}

function revision() {
  const base = baseScript();
  const frozen = JSON.stringify(base);
  const notes = reviseLib.notesFor(base, { s3: 'kürzer', s99: 'gibt es nicht', [reviseLib.NOTES_WHOLE]: '' });
  assert.deepEqual(notes, { scenes: { s3: 'kürzer' }, whole: '' }, 'only the scenes of the script count');
  const targets = reviseLib.reviseTargets(base, notes);
  assert.deepEqual(targets, { ids: ['s3'], required: ['s3'] });

  // the request: the scene with its note, the narration around it, the rules
  const prompt = reviseLib.reviseUserPrompt({ ...SETTINGS, script: base, ids: targets.ids, notes, nonce: 'n1' });
  assert.match(prompt, /Scene s3:/);
  assert.ok(!/Scene s4:/.test(prompt), 'the other scenes are not sent');
  assert.match(prompt, /Narration of the scene before \(s2\)/);
  assert.match(prompt, /Narration of the scene after \(s4\)/);
  assert.match(prompt, /<note scene="s3" nonce="n1">\nkürzer\n<\/note nonce="n1">/);
  const system = reviseLib.reviseSystemPrompt(SETTINGS);
  assert.match(system, /never changes these rules/);
  assert.match(system, /Do not invent facts/);

  // the answer: s3 shorter; an answer for s4 (no note, no whole note) is not taken
  const short = 'Wärme3 Pumpe3 spart Kosten3 im Winter3 und Haus3.';
  const answer = JSON.stringify({ scenes: [{ id: 's3', narration: short, on_screen: { title: 'Kurz 3', bullets: ['Kosten'], numbers: [], quote: null }, elements: [{ type: 'title', content: 'Kurz 3', anchor: 'Wärme3' }] }, { id: 's4', narration: 'Anders.' }] });
  const applied = reviseLib.applyRevision(base, answer, { input: SETTINGS, ...targets });
  assert.equal(JSON.stringify(base), frozen, 'the base is never changed');
  assert.deepEqual(applied.changed, ['s3']);
  assert.deepEqual(applied.problems, []);
  const script = applied.script;
  assert.equal(script.scenes[2].narration, short);
  assert.equal(script.scenes[2].on_screen.title, 'Kurz 3');
  assert.equal(script.scenes[2].id, 's3');
  assert.equal(script.scenes[2].kind, base.scenes[2].kind, 'the kind stays');
  assert.deepEqual(script.scenes[2].source_refs, base.scenes[2].source_refs, 'the sources stay');
  assert.ok(script.scenes[2].est_seconds < base.scenes[2].est_seconds, 'the time follows the shorter narration');
  script.scenes.forEach((scene, index) => {
    if (index !== 2) assert.equal(JSON.stringify(scene), JSON.stringify(base.scenes[index]), `scene ${scene.id} is byte for byte the base`);
  });
  // the lists: only the third entry of the narration and the briefs differs; the text around the other scenes stays the base's
  const record = reviseLib.feedbackRecord(base, notes, applied.changed);
  script.feedback = record;
  const lists = reviseLib.revisedOutputs(script, base, applied.changed);
  const before = planLib.outputsOf(base);
  for (const name of ['narration', 'briefs', 'narrationContext']) {
    lists[name].forEach((value, index) => {
      if (index !== 2) assert.equal(value, before[name][index], `${name}[${index}] is unchanged`);
    });
  }
  assert.notEqual(lists.narration[2], before.narration[2]);
  assert.notEqual(lists.briefs[2], before.briefs[2]);
  // the voice of s3 hears its neighbours; theirs hear the base (so their voices stay in the cache)
  assert.equal(lists.narrationContext[2], before.narrationContext[2]);
  assert.ok(planLib.outputsOf(script).narrationContext[1] !== before.narrationContext[1], 'a plain list would change the context of the neighbour');

  // the memory: the same note again needs no call; a new note on s5 sends s5 only
  const again = reviseLib.reusableScenes(base, notes, [script]);
  assert.deepEqual([...again.scenes.keys()], ['s3']);
  assert.deepEqual(reviseLib.reviseTargets(base, notes, again), { ids: [], required: [] });
  const more = reviseLib.notesFor(base, { s3: 'kürzer', s5: 'Zahl nennen' });
  const reused = reviseLib.reusableScenes(base, more, [script]);
  assert.deepEqual(reviseLib.reviseTargets(base, more, reused), { ids: ['s5'], required: ['s5'] });
  const merged = reviseLib.applyRevision(base, JSON.stringify({ scenes: [{ id: 's5', narration: narrationOf(5, 18) }] }), { input: SETTINGS, ids: ['s5'], required: ['s5'], reused: reused.scenes });
  assert.deepEqual(merged.changed, ['s3', 's5']);
  assert.equal(JSON.stringify(merged.script.scenes[2]), JSON.stringify(script.scenes[2]), 'the scene of the unchanged note is taken as it was');
  // a changed note is not reused; another base is not either
  assert.equal(reviseLib.reusableScenes(base, reviseLib.notesFor(base, { s3: 'noch kürzer' }), [script]).scenes.size, 0);
  const other = baseScript();
  other.scenes[0].narration = narrationOf(1, 20);
  assert.equal(reviseLib.reusableScenes(other, notes, [script]).scenes.size, 0);

  // a revision that is too long, or no answer for the scene with the note: the scene stays, the problem is told
  const tooLong = reviseLib.applyRevision(base, JSON.stringify({ scenes: [{ id: 's3', narration: narrationOf(3, 60) }] }), { input: SETTINGS, ...targets });
  assert.deepEqual(tooLong.changed, []);
  assert.match(tooLong.problems[0], /at most 15 s/);
  const silent = reviseLib.applyRevision(base, JSON.stringify({ scenes: [] }), { input: SETTINGS, ...targets });
  assert.deepEqual(silent.changed, []);
  assert.match(silent.problems[0], /did not answer/);
  assert.match(reviseLib.applyRevision(base, 'kein JSON', { input: SETTINGS, ...targets }).problems[0], /not a JSON object/);

  // the note about the whole script: all spoken scenes go along, the model answers for those it changes
  const whole = reviseLib.notesFor(base, { all: 'direkter' });
  const wholeTargets = reviseLib.reviseTargets(base, whole);
  assert.deepEqual(wholeTargets.ids, base.scenes.filter((scene) => scene.role !== 'sources').map((scene) => scene.id));
  assert.deepEqual(wholeTargets.required, []);
  const direct = reviseLib.applyRevision(base, JSON.stringify({ scenes: [{ id: 's1', narration: narrationOf(1, 15) }, { id: 's6', narration: narrationOf(6, 15) }] }), { input: SETTINGS, ...wholeTargets });
  assert.deepEqual(direct.changed, ['s1', 's6']);
  const wholeRecord = { ...direct.script, feedback: reviseLib.feedbackRecord(base, whole, direct.changed) };
  const wholeAgain = reviseLib.reusableScenes(base, whole, [wholeRecord]);
  assert.equal(wholeAgain.whole, true, 'the same whole note needs no new call');
  assert.deepEqual([...wholeAgain.scenes.keys()].sort(), ['s1', 's6']);

  // an own text: the narration is never changed by a note
  const verbatim = { ...baseScript(), verbatim: true };
  const kept = reviseLib.applyRevision(verbatim, JSON.stringify({ scenes: [{ id: 's2', narration: 'Ganz anders.', on_screen: { title: 'Neuer Titel', bullets: [], numbers: [], quote: null } }] }), { input: { ...SETTINGS, verbatim: true }, ids: ['s2'], required: ['s2'] });
  assert.equal(kept.script.scenes[1].narration, verbatim.scenes[1].narration);
  assert.equal(kept.script.scenes[1].on_screen.title, 'Neuer Titel');

  // the check of the revised scenes: verified only when the base was and every revised scene was checked
  const checkedBase = { ...baseScript(), verified: true };
  const revised = reviseLib.applyRevision(checkedBase, answer, { input: SETTINGS, ...targets }).script;
  const check = reviseLib.applyRevisionCheck(revised, checkedBase, JSON.stringify({ scenes: [{ id: 's3', narration: short, bullets: ['Kosten'], numbers: [], quote_ok: true, issues: [] }] }), ['s3'], SETTINGS);
  assert.deepEqual(check.reverted, []);
  assert.equal(revised.verified, true);
  assert.equal(revised.verified_hash, planLib.textHash(revised));
  const unchecked = reviseLib.applyRevision(checkedBase, answer, { input: SETTINGS, ...targets }).script;
  reviseLib.applyRevisionCheck(unchecked, checkedBase, null, null, SETTINGS);
  assert.equal(unchecked.verified, false, 'a revised scene that was not checked takes "verified" away');
  assert.deepEqual(unchecked.unverified_scenes, ['s3']);
  const dropped = reviseLib.applyRevision(checkedBase, answer, { input: SETTINGS, ...targets }).script;
  const gone = reviseLib.applyRevisionCheck(dropped, checkedBase, JSON.stringify({ scenes: [{ id: 's3', narration: '', issues: [{ claim: 'spart Kosten', verdict: 'removed', reason: 'not in the sources' }] }] }), ['s3'], SETTINGS);
  assert.deepEqual(gone.reverted, ['s3']);
  assert.equal(JSON.stringify(dropped.scenes[2]), JSON.stringify(checkedBase.scenes[2]), 'a revision without support gives the base back');
}

/* ---------- explainer.plan ---------- */

async function planNode() {
  const real = registryModule.registry;
  const planDef = real.get('explainer.plan');
  const calls = [];
  const queue = { plan: [], verify: [], revise: [] };
  const kindOf = (system) => (/You revise single scenes/.test(system) ? 'revise' : /write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : 'other');
  const USD = { plan: 0.31, verify: 0.12, revise: 0.04 };
  const echoCheck = (options) => {
    const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
    return { scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) };
  };
  patch(llm, 'completeText', async (options) => {
    const kind = kindOf(options.system || '');
    calls.push({ kind, options });
    let value = queue[kind]?.length ? queue[kind].shift() : kind === 'plan' ? planAnswer() : kind === 'verify' ? echoCheck : { scenes: [] };
    if (typeof value === 'function') value = value(options);
    return { text: typeof value === 'string' ? value : JSON.stringify(value), usd: USD[kind] };
  });
  patch(or, 'hasKey', () => true);
  patch(fal, 'hasKey', () => true);
  const makeCtx = ({ cached = null, earlier = [] } = {}) => {
    const logs = [];
    const asked = [];
    return {
      workflowId: 'wf',
      nodeId: 'plan',
      sessionId: 'sess',
      user: 'staff1@staff.example.com',
      config: { defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'], imageModel: 'openai/gpt-image-2' },
      signal: new AbortController().signal,
      toolCtx: {},
      log: (line) => logs.push(line),
      cachedResult: async (overrides) => {
        asked.push(overrides);
        return cached ? JSON.parse(JSON.stringify(cached)) : null;
      },
      earlierVariants: () => earlier,
      logs,
      asked
    };
  };
  const inputs = { text: textValue(DOCUMENT_TEXT) };
  const exec = (ctx, raw = {}) => planDef.execute(ctx, inputs, real.normalizeParams(planDef, { language: 'de', ...raw }));
  const kinds = () => calls.map((call) => call.kind);
  const values = (list) => list.items.map((item) => item.value);

  // without notes: the plan and its check, as before; no revision, no look into the cache
  const ctx0 = makeCtx();
  const first = await exec(ctx0);
  assert.deepEqual(kinds(), ['plan', 'verify']);
  assert.deepEqual(ctx0.asked, [], 'without notes the cache is not asked');
  const v0 = first.variants[0];
  const script0 = JSON.parse(v0.script.value);
  assert.equal(script0.feedback, undefined);
  assert.equal(script0.verified, true);

  // a note on s3: the base comes from the cache, one call for s3, its check alone
  calls.length = 0;
  const short = 'Wärme3 Pumpe3 spart Kosten3 im Winter3 und Haus3.';
  queue.revise.push({ scenes: [{ id: 's3', narration: short, on_screen: { title: 'Kurz 3', bullets: ['Kosten'], numbers: [], quote: null }, elements: [{ type: 'title', content: 'Kurz 3', anchor: 'Wärme3' }] }] });
  const ctx1 = makeCtx({ cached: v0, earlier: [v0] });
  const second = await exec(ctx1, { feedback: { s3: 'kürzer' } });
  assert.deepEqual(kinds(), ['revise', 'verify'], 'no new plan: one revision and its check');
  assert.deepEqual(ctx1.asked, [{ feedback: {} }], 'the base is the result without notes');
  assert.match(calls[0].options.prompt, /Scene s3:/);
  assert.ok(!/Scene s2:/.test(calls[0].options.prompt));
  const checked = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(calls[1].options.prompt)[1]);
  assert.deepEqual(checked.scenes.map((scene) => scene.id), ['s3'], 'only the revised scene is checked');
  assert.ok(Math.abs(second.cost.usd - (USD.revise + USD.verify)) < 1e-9, 'only the revision and its check are paid');
  const v1 = second.variants[0];
  const script1 = JSON.parse(v1.script.value);
  assert.equal(script1.verified, true);
  assert.deepEqual(script1.feedback.changed, ['s3']);
  assert.equal(script1.scenes[2].narration, short);
  for (const port of ['narration', 'narration_context', 'briefs']) {
    const now = values(v1[port]);
    const then = values(v0[port]);
    assert.equal(now.length, then.length);
    now.forEach((value, index) => {
      if (index !== 2 || port === 'narration_context') assert.equal(value, then[index], `${port}[${index}] is the one of before`);
    });
  }
  assert.notEqual(values(v1.narration)[2], values(v0.narration)[2]);
  assert.deepEqual(values(v1.image_prompts), values(v0.image_prompts));
  script0.scenes.forEach((scene, index) => {
    if (index !== 2) assert.equal(JSON.stringify(script1.scenes[index]), JSON.stringify(scene));
  });

  // the same note once more (another run of the node, the cache of the whole missed): no call at all
  calls.length = 0;
  const third = await exec(makeCtx({ cached: v0, earlier: [v1, v0] }), { feedback: { s3: 'kürzer' } });
  assert.deepEqual(kinds(), []);
  assert.equal(third.variants[0].script.value, v1.script.value);
  assert.equal(third.cost.usd, 0);

  // a second note: only s5 is sent, s3 is taken as it was
  calls.length = 0;
  queue.revise.push({ scenes: [{ id: 's5', narration: narrationOf(5, 16) }] });
  const fourth = await exec(makeCtx({ cached: v0, earlier: [v1, v0] }), { feedback: { s3: 'kürzer', s5: 'knapper' } });
  assert.deepEqual(kinds(), ['revise', 'verify']);
  assert.match(calls[0].options.prompt, /Scene s5:/);
  assert.ok(!/Scene s3:/.test(calls[0].options.prompt), 'the unchanged note is not sent again');
  const script4 = JSON.parse(fourth.variants[0].script.value);
  assert.deepEqual(script4.feedback.changed, ['s3', 's5']);
  assert.equal(JSON.stringify(script4.scenes[2]), JSON.stringify(script1.scenes[2]));

  // no base in the cache: the plan is made first, then the note
  calls.length = 0;
  queue.revise.push({ scenes: [{ id: 's3', narration: short }] });
  const ctx5 = makeCtx();
  await exec(ctx5, { feedback: { s3: 'kürzer' } });
  assert.deepEqual(kinds(), ['plan', 'verify', 'revise', 'verify']);

  // a note on a scene the script does not have: nothing to do, no call
  calls.length = 0;
  const ctx6 = makeCtx({ cached: v0 });
  const none = await exec(ctx6, { feedback: { s42: 'gibt es nicht' } });
  assert.deepEqual(kinds(), []);
  assert.ok(ctx6.logs.some((line) => /not about a scene/.test(line)));
  assert.deepEqual(JSON.parse(none.variants[0].script.value).scenes, script0.scenes);

  // the edited script and a note: the revision works on the edited text (no plan); the price is that of the revision
  calls.length = 0;
  queue.revise.push({ scenes: [{ id: 's2', narration: narrationOf(2, 15) }] });
  const edited = await exec(makeCtx(), { script: v0.script.value, feedback: { s2: 'knapper' } });
  assert.deepEqual(kinds(), ['revise', 'verify']);
  assert.ok(edited.cost.usd > 0);
  assert.equal(values(edited.variants[0].narration)[2], values(v0.narration)[2]);
  // the price beforehand: the edited script alone is free, with a note the revision has a price
  const estimate = (raw) => planDef.cost.estimate(real.normalizeParams(planDef, raw), { config: {}, inputs, connected: new Set(['text']) });
  assert.deepEqual(estimate({ script: v0.script.value }), { usd: 0 });
  const priced = estimate({ script: v0.script.value, feedback: { s2: 'knapper' } });
  assert.ok(priced && priced.usd > 0 && priced.usd < 0.2, `a small price for the revision (${JSON.stringify(priced)})`);
  assert.ok(estimate({ feedback: { all: 'direkter' } }).usd > priced.usd, 'a note about the whole script costs more');
}

/* ---------- the engine: voice and scene by item ---------- */

const media = (type, id) => ({ type, sessionId: 'sess', assetId: id, file: `${id}.${type === 'video' ? 'mp4' : 'wav'}` });
const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
function edges(...specs) {
  return specs.map((spec, index) => {
    const [from, to] = spec.split('>');
    const [fromNode, fromPort] = from.split('.');
    const [toNode, toPort] = to.split('.');
    return { id: `e${index + 1}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
  });
}
const briefOf = (id) => `Scene ${id} · role point · kind motion · about 5 s · landscape · language de\nTitle: Titel ${id}`;

async function engineItems() {
  const calls = [];
  let counter = 0;
  const registry = createRegistry();
  registry.register({
    type: 't.plan',
    category: 'input',
    outputs: [
      { id: 'briefs', type: 'text[]' },
      { id: 'timings', type: 'text[]' },
      { id: 'shots', type: 'text' },
      { id: 'narration', type: 'text[]' }
    ],
    params: [
      { id: 'count', kind: 'integer', default: 4 },
      { id: 'duration', kind: 'number', default: 20 }
    ],
    execute: async (_ctx, _inputs, params) => {
      const scenes = Array.from({ length: params.count }, (_x, i) => `s${i + 1}`);
      const shots = { version: 1, format: 'landscape', language: 'de', duration: params.duration, counts: { scenes: scenes.length }, scenes: scenes.map((id) => ({ id, kind: 'motion', image: null, figure: null, source_refs: [] })) };
      return {
        variants: [
          {
            briefs: listValue('text', scenes.map((id) => textValue(briefOf(id)))),
            timings: listValue('text', scenes.map(() => textValue(JSON.stringify({ duration: 5, words: [] })))),
            shots: textValue(JSON.stringify(shots)),
            narration: listValue('text', scenes.map((id) => textValue(`Die Szene ${id} erzählt etwas.`)))
          }
        ]
      };
    }
  });
  const sceneDef = videoNodes.definitions.find((definition) => definition.type === 'explainer.scene');
  const voiceDef = videoNodes.definitions.find((definition) => definition.type === 'explainer.voice');
  const earlier = [];
  registry.register({
    ...sceneDef,
    available: () => true,
    execute: async (ctx, inputs, params) => {
      const selected = videoNodes.sceneSelection(inputs);
      counter += 1;
      const before = params.feedback && Object.keys(params.feedback).length ? await ctx.cachedResult({ feedback: {} }) : null;
      earlier.push({ id: selected.brief.id, before: before?.video?.assetId || null });
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, id: selected.brief.id });
      return { variants: [{ video: media('video', `v${counter}`) }], cost: { usd: 0.1 } };
    }
  });
  registry.register({
    ...voiceDef,
    available: () => true,
    execute: async (ctx, inputs, params) => {
      const selected = videoNodes.voiceSelection(inputs, params);
      counter += 1;
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, text: selected.text });
      return { variants: [{ audio: media('audio', `w${counter}`), timing: textValue('{}'), duration: { type: 'number', value: 1 } }], cost: { usd: 0.01 } };
    }
  });

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-feedback-'));
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, parallel: 3 } });
  const run = async (workflowId, request) => engine.whenFinished(workflowId, await engine.start(workflowId, request));
  async function setParams(workflowId, nodeId, params) {
    const current = await wfStore.readWorkflow(workflowId);
    const nodes = current.graph.nodes.map((item) => (item.id === nodeId ? { ...item, params: { ...item.params, ...params } } : item));
    await wfStore.saveGraph(workflowId, { baseRev: current.rev, graph: { ...current.graph, nodes } });
  }
  const ran = (nodeId) => calls.filter((call) => call.node === nodeId).map((call) => call.item);
  const created = [];
  try {
    const made = await wfStore.createWorkflow({
      name: 'Feedback',
      graph: {
        nodes: [node('plan', 't.plan'), node('vo', 'explainer.voice'), node('sc', 'explainer.scene')],
        edges: edges('plan.narration>vo.narration', 'plan.briefs>sc.brief', 'plan.timings>sc.timing', 'plan.shots>sc.shots')
      }
    });
    const wf = made.workflow;
    created.push(wf.id);
    const first = await run(wf.id, { mode: 'all' });
    assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
    assert.deepEqual(ran('vo').sort(), [0, 1, 2, 3]);
    assert.deepEqual(ran('sc').sort(), [0, 1, 2, 3]);
    const results = async (nodeId) => (await wfStore.readResults(wf.id)).nodes[nodeId];
    const keys0 = { vo: [...(await results('vo')).history[0].itemKeys], sc: [...(await results('sc')).history[0].itemKeys] };
    const assetsOf = async (nodeId, port) => {
      const nodeResults = await results(nodeId);
      const selected = nodeResults.history.find((entry) => entry.id === nodeResults.selected.entry) || nodeResults.history[0];
      return selected.variants[0][port].items.map((item) => item.assetId);
    };
    const takes0 = await assetsOf('vo', 'audio');
    const videos0 = await assetsOf('sc', 'video');

    // (c) empty notes: the keys of the items are those without the param
    {
      const params = registry.normalizeParams(registry.get('explainer.voice'), {});
      const resolved = { inputs: { narration: listValue('text', [textValue('a'), textValue('b')]) }, mapped: ['narration'], mapLength: 2 };
      const plain = computeItemKeys(registry.get('explainer.voice'), params, resolved);
      assert.deepEqual(computeItemKeys(registry.get('explainer.voice'), { ...params, feedback: {} }, resolved), plain);
      // a note on another item leaves the key of this one
      const noted = computeItemKeys(registry.get('explainer.voice'), { ...params, feedback: { s2: 'anders' } }, resolved);
      assert.equal(noted[0], plain[0]);
      assert.notEqual(noted[1], plain[1]);
    }
    await setParams(wf.id, 'vo', { feedback: { s2: '   ' } });
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(calls, [], 'an empty note changes nothing');

    // (a) a note on s3 of the voice: item 2 only, the plan prices only it
    await setParams(wf.id, 'vo', { feedback: { s3: 'langsamer' } });
    const plan = await engine.plan(wf.id, { mode: 'node', nodeIds: ['vo'] });
    assert.equal(plan.nodes.vo.executions, 1);
    assert.equal(plan.nodes.vo.reusedItems, 3);
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(ran('vo'), [2], 'only the voice of s3 is spoken again');
    assert.deepEqual(ran('sc'), [], 'the scenes keep their videos (their timing did not change)');
    const takes1 = await assetsOf('vo', 'audio');
    assert.deepEqual([takes1[0], takes1[1], takes1[3]], [takes0[0], takes0[1], takes0[3]]);
    assert.notEqual(takes1[2], takes0[2]);
    const keys1 = (await results('vo')).history[0].itemKeys;
    assert.deepEqual([keys1[0], keys1[1], keys1[3]], [keys0.vo[0], keys0.vo[1], keys0.vo[3]], 'the other items keep their keys');

    // clearing the note: the take of before comes back from the cache, nothing runs
    await setParams(wf.id, 'vo', { feedback: {} });
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(calls, []);
    assert.deepEqual(await assetsOf('vo', 'audio'), takes0);

    // a note on the scene s3: that scene only, and it sees its video of before (ctx.cachedResult)
    await setParams(wf.id, 'sc', { feedback: { s3: 'die Zahl grösser' } });
    calls.length = 0;
    earlier.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(ran('sc'), [2]);
    assert.deepEqual(ran('vo'), []);
    assert.deepEqual(earlier, [{ id: 's3', before: videos0[2] }], 'the scene gets its result without the note');
    const videos1 = await assetsOf('sc', 'video');
    assert.deepEqual([videos1[0], videos1[1], videos1[3]], [videos0[0], videos0[1], videos0[3]]);

    // a new length of the whole video (a revised scene changes it): no scene is drawn again
    await setParams(wf.id, 'sc', { feedback: {} });
    await setParams(wf.id, 'plan', { duration: 18.5 });
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(ran('sc'), [], 'the length of the whole is not read by a scene');

    // the scenes drawn before WP56 (their keys held the length of the whole): found under their former keys, a note still draws again
    {
      const before = (await wfStore.readResults(wf.id)).nodes;
      const resolved = {
        inputs: { brief: before.plan.history[0].variants[0].briefs, timing: before.plan.history[0].variants[0].timings, shots: before.plan.history[0].variants[0].shots },
        mapped: ['brief', 'timing'],
        mapLength: 4
      };
      const params = registry.normalizeParams(registry.get('explainer.scene'), {});
      const former = computeItemKeys({ ...registry.get('explainer.scene'), itemKeyInputs: registry.get('explainer.scene').itemKeyInputsBefore }, params, resolved);
      const current = computeItemKeys(registry.get('explainer.scene'), params, resolved);
      assert.notDeepEqual(former, current);
      await wfStore.updateResults(wf.id, (all) => {
        for (const entry of all.nodes.sc.history) if (Array.isArray(entry.itemKeys)) entry.itemKeys = former;
      });
      await setParams(wf.id, 'sc', { feedback: { s2: 'heller' } });
      const priced = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(priced.nodes.sc.executions, 1, 'the plan counts the scene with the note only');
      calls.length = 0;
      assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
      assert.deepEqual(ran('sc'), [1], 'the scenes of before are found, the one with the note is drawn');
      const stored = (await results('sc')).history[0].itemKeys;
      assert.equal(stored[0], current[0], 'and stored under their keys of now');
    }

    // the key of a voice without narration (the sources card) does not take a note
    {
      const params = registry.normalizeParams(registry.get('explainer.voice'), { feedback: { s1: 'x' } });
      const keyInputs = registry.get('explainer.voice').itemKeyInputs(0, { narration: textValue('') }, params);
      assert.equal(keyInputs.feedback, undefined);
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the app view (public/nodes/app-mode.js) and its texts ---------- */

function appView() {
  const read = (file) => require('fs').readFileSync(path.join(__dirname, '..', file), 'utf8');
  const window = { OCDNodes: { graph: {}, ui: { el: () => ({}), icon: () => ({}), T: (key) => key }, api: {}, run: {} } };
  vm.runInNewContext(read('public/nodes/app-mode.js'), { window, localStorage: undefined, console });
  const app = window.OCDNodes.appMode;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const real = registryModule.registry;
  const graph = {
    nodes: [
      { id: 'p', type: 'explainer.plan', params: {} },
      { id: 'v', type: 'explainer.voice', params: {} },
      { id: 'c', type: 'explainer.scene', params: {} },
      { id: 'x', type: 'explainer.scene', params: {} }
    ],
    edges: [
      { from: { node: 'p', port: 'narration' }, to: { node: 'v', port: 'narration' } },
      { from: { node: 'p', port: 'narration_context' }, to: { node: 'v', port: 'context' } },
      { from: { node: 'p', port: 'briefs' }, to: { node: 'c', port: 'brief' } },
      { from: { node: 'v', port: 'timing' }, to: { node: 'c', port: 'timing' } },
      // a scene that does not get its brief from the planner has no notes of the planner's scenes
      { from: { node: 'v', port: 'timing' }, to: { node: 'x', port: 'timing' } }
    ]
  };
  const groups = app.feedbackTargets(graph, (type) => real.get(type));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].node.id, 'p');
  assert.equal(groups[0].param.source, 'script');
  assert.deepEqual(plain(groups[0].followers.map((item) => [item.node.id, item.param.items])), [['v', 'narration'], ['c', 'brief']], 'the voice once (two wires), the scene of the planner');

  const script = JSON.stringify({ scenes: [{ id: 's1', narration: 'Hallo', on_screen: { title: 'Start' } }, { id: 's2', narration: 'Mehr' }, { narration: 'no id' }] });
  assert.deepEqual(plain(app.feedbackScenes(script)), [{ id: 's1', title: 'Start', narration: 'Hallo' }, { id: 's2', title: '', narration: 'Mehr' }]);
  assert.deepEqual(plain(app.feedbackScenes('not json')), []);
  assert.deepEqual(plain(app.notesOfScenes({ s1: ' kürzer ', s2: '  ', gone: 'x', all: 'direkter' }, ['s1', 's2'], true)), { s1: 'kürzer', all: 'direkter' }, 'only the scenes of the script now');
  assert.deepEqual(plain(app.notesOfScenes({ s1: 'a', all: 'b' }, ['s1'], false)), { s1: 'a' }, 'the whole note only where the param has it');

  const { rows } = require('../public/nodes/i18n-nodes.js');
  const keys = ['nodes.app.feedback', 'nodes.app.feedbackHint', 'nodes.app.feedbackScript', 'nodes.app.feedbackVoice', 'nodes.app.feedbackPicture', 'nodes.app.feedbackWhole', 'nodes.app.feedbackRedo', 'nodes.app.feedbackClear', 'nodes.param.feedback', 'nodes.notes.placeholder', 'nodes.notes.placeholderWhole'];
  for (const key of keys) {
    const row = rows.find((item) => item[0] === key);
    assert.ok(row && row.length === 4 && row.slice(1).every((text) => text && text.trim()), `${key}: de, en and es`);
    assert.ok(!row[1].includes('ß'), `${key}: Swiss spelling`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
