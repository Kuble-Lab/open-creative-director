'use strict';

// The style "typography" of the explainer video (WP40): kinetic typography, the spoken words are the picture.
//   Part 1 (the pure libraries, no app)
//   - the other modes (motion, mix, ai_video) are untouched: every prompt, brief, shot list and fixed scene is the one of the day before WP40,
//     byte for byte (scripts/support/explainer-prompts-before-wp40.json)
//   - the planner in the mode typography: no picture and no clip prompts, kind motion for every scene, keywords that are spoken, a layout
//     from the list that changes from scene to scene, a camera hint, the briefs and the shot list with them, an edited script keeps its choices
//   - an own text (verbatim): the scenes are cut out of the text of the person, no word changes (the German sharp s included); where the model
//     changed one the app cuts the text itself; a short text is not held to the minimum of three scenes
//   - the writer of a scene: the rules of the style, the words of the voice with their times, other limits than the ordinary scene (every
//     spoken word may appear, labels may be smaller), the palette and the fonts (brand first, Inter Tight where it brings none)
//   - the look at the frames: the rubric of the style (cut at the edge and overlays are wanted; unreadable key word, accidental collision, empty
//     frame, wrong order are defects), the frame times, the words said by then
//   - the default font: the file, the licence next to it, the limits of the embedding, a variable font declared with the range of its weights
//   Part 2 (an isolated copy of the app, the model, the voice and the render node replaced)
//   - the nodes: the new input "own_text", the mode in the list, the planner with the mode and with an own text, the scene node in the style
//   - the two templates "Typography video" and "... from your own text" through the real engine: valid, wired, translated; the planner alone, then
//     everything; no picture, no clip, no cost for them; the own text comes out word for word in the voices
// Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { createAssStandIn } = require('./support/fake-ffmpeg');
const { toneWav, createMedia } = require('./support/explainer-media');
const cases = require('./support/explainer-prompt-cases');
const { sampleScene } = require('./support/typography-sample-scene');

const root = path.resolve(__dirname, '..');
const plan = require('../lib/explainer-plan');
const scene = require('../lib/explainer-scene');
const cues = require('../lib/explainer-cues');

const STAFF = 'staff1@staff.example.com';
const KEY = 'el-secret-key-0123456789';
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const tokensOf = (text) => (String(text).normalize('NFC').match(/[\p{L}\p{M}\p{N}]+/gu) || []).map((word) => word.normalize('NFKC').toLowerCase());

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

/* ---------- material ---------- */

const DOC = { name: 'report.pdf', title: 'Report', pageCount: 4 };
const FULL = { capabilities: { image: true, fal: true } };
const BASE = { language: 'en', lengthSeconds: 60, format: 'landscape', visualMode: 'typography', ...FULL };

// a scene of a typography answer: a narration of `words` words from the vocabulary, the keywords and the layout the model names
const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${'abcdefghijklmnop'[k]}`).join(' ') + '.';
function typoScene(k, fields = {}, words = 22) {
  const narration = narrationOf(k, words);
  const list = narration.replace(/\./g, '').split(' ');
  return {
    kind: 'motion',
    role: k === 1 ? 'hook' : k === 6 ? 'summary' : 'point',
    narration,
    on_screen: { title: `Titel ${k}`, bullets: [], numbers: [], quote: null },
    elements: [{ type: 'title', content: `Titel ${k}`, anchor: list[0] }],
    typography: { keywords: [list[3], list[9]], layout: plan.TYPOGRAPHY_LAYOUTS[(k - 1) % 5], camera: k > 1 ? 'keep travelling along the column of the scene before' : '' },
    figure: null,
    image_prompt: null,
    clip_prompt: null,
    source_refs: [],
    ...fields
  };
}
const typoAnswer = (mutate, count = 6) => {
  const answer = { title: 'Typografie', summary: 'Wörter als Bild', scenes: Array.from({ length: count }, (_x, i) => typoScene(i + 1)), presenter: null };
  if (mutate) mutate(answer);
  return answer;
};
const buildTypo = (answer, extra = {}) => plan.buildScript(JSON.parse(JSON.stringify(answer)), { ...BASE, ...extra });

// an own text and the way a model cuts it
const OWN_TEXT = [
  'Max wohnte in der Strasse am Fluss. Er zeichnete 1957 eine Schrift für die ganze Welt.',
  'Klar, neutral und ohne Schnörkel. Sie steht heute auf Schildern, in Büchern, in Apps und auf Strassenbahnen.',
  'Heiß diskutiert wurde sie nie, geliebt wird sie überall. «Gut gestaltet» sagte man damals; heute sagt man: «Das ist Helvetica.»'
].join('\n');
function ownCut(parts, extra = {}) {
  return { title: 'Schrift', summary: 's', scenes: parts.map((narration, index) => ({ kind: 'motion', role: index === 0 ? 'hook' : index === parts.length - 1 ? 'summary' : 'point', narration, on_screen: { title: `T${index + 1}`, bullets: [], numbers: [], quote: null }, elements: [], typography: { keywords: [], layout: '', camera: '' }, figure: null, image_prompt: null, clip_prompt: null, source_refs: [], ...extra })) };
}

async function main() {
  testOtherModesUnchanged();
  testPlannerPrompt();
  testPlannerScript();
  testBriefsAndLists();
  testEditedScript();
  testOwnText();
  testSceneWriter();
  testSceneCheck();
  testDefaultFont();
  testSampleScene();
  testDocs();

  const attempts = [];
  const realFetch = global.fetch;
  const eleven = { calls: [] };
  const respond = (status, body) => {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: new Map(), async text() { return text; }, async json() { return JSON.parse(text); } };
  };
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/with-timestamps/.test(url)) {
      const body = JSON.parse(init.body);
      eleven.calls.push({ url, body });
      const characters = [...body.text];
      const alignment = {
        characters,
        character_start_times_seconds: characters.map((_c, index) => Math.round(index * SECONDS_PER_CHAR * 1000) / 1000),
        character_end_times_seconds: characters.map((_c, index) => Math.round((index + 1) * SECONDS_PER_CHAR * 1000) / 1000)
      };
      return respond(200, { audio_base64: toneWav(characters.length * SECONDS_PER_CHAR + 0.1, 600).toString('base64'), alignment, normalized_alignment: alignment });
    }
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return realFetch(input, init);
  };
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: 'admin@example.com',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: KEY,
      FAL_KEY: 'fal-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      GTS_API_TOKEN: ''
    }
  });
  try {
    await run(iso, eleven);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-typography.js: ok');
}

const SECONDS_PER_CHAR = 0.02;

/* ---------- Part 1 ---------- */

function testOtherModesUnchanged() {
  const before = require('./support/explainer-prompts-before-wp40.json');
  const now = cases.compute({ planLib: plan, sceneLib: scene });
  assert.deepEqual(Object.keys(now).sort(), Object.keys(before).sort(), 'the same cases');
  for (const key of Object.keys(before)) assert.equal(now[key], before[key], `${key}: byte for byte as before WP40`);
  // the old modes: the prompts do not know the style at all
  for (const mode of ['motion', 'mix', 'ai_video']) {
    assert.doesNotMatch(plan.systemPrompt({ ...BASE, visualMode: mode }), /typography|kinetic/i, `${mode}: no word of the style`);
    assert.doesNotMatch(plan.userPrompt({ ...BASE, visualMode: mode, topic: 'x' }), /typography|Narration text/i);
  }
  assert.doesNotMatch(scene.writerSystemPrompt({ format: 'landscape', duration: 6 }), /typography|kinetic/i);
  assert.doesNotMatch(scene.checkSystemPrompt(), /typography|kinetic/i);
  // the mode is the fourth of the list; a name that is not in it falls back to the default as before
  assert.deepEqual(plan.VISUAL_MODES, ['motion', 'mix', 'ai_video', 'typography']);
  assert.equal(plan.settings({ visualMode: 'nonsense' }).visualMode, 'mix');
  // the layouts
  assert.deepEqual(plan.TYPOGRAPHY_LAYOUTS, ['stack', 'column', 'blocks', 'compare', 'curve', 'number']);
  for (const layout of plan.TYPOGRAPHY_LAYOUTS) assert.ok(plan.TYPOGRAPHY_LAYOUT_HELP[layout].length > 20, layout);
  // the old limits are still the old ones
  assert.equal(scene.MIN_FONT_PX, 54);
  assert.equal(plan.LIMITS.onScreenWords, 25);
}

function testPlannerPrompt() {
  const system = plan.systemPrompt({ ...BASE, documents: [DOC] });
  assert.match(system, /Visual mode "typography" \(kinetic typography\): every scene has kind "motion"/);
  assert.match(system, /No image_prompt, no clip_prompt \(leave them null\): no pictures and no clips are made/);
  // the schema asks for the typography field and for no still or clip
  assert.match(system, /"typography":\{"keywords":\[""\],"layout":"stack\|column\|blocks\|compare\|curve\|number","camera":""\}/);
  assert.doesNotMatch(system, /"kind":"motion\|still\|clip"/);
  assert.match(system, /Narration for typography: short, rhythmic sentences/);
  for (const layout of plan.TYPOGRAPHY_LAYOUTS) assert.ok(system.includes(`"${layout}"`) && system.includes(`${layout} = `), `the layout ${layout} is named and described`);
  assert.match(system, /never the same one in two scenes in a row/);
  assert.match(system, /always "" in the first scene/);
  assert.match(system, /keywords: 1 to 4 words or numbers of THIS narration/);
  // the on-screen rule is the one of the style (no bullets, no "must not repeat the narration")
  assert.match(system, /no bullets, a quote only when it is literal/);
  assert.doesNotMatch(system, /at most 3 bullets of at most 7 words/);
  // the length rules of the plan are the ordinary ones
  assert.match(system, /about 60 seconds in all/);
  // no clip and no still, whatever the providers are
  for (const capabilities of [{ image: true, fal: true }, { image: false, fal: false }]) {
    const text = plan.systemPrompt({ ...BASE, capabilities });
    assert.match(text, /No image_prompt, no clip_prompt/);
  }
  // an own text: the model cuts, it does not write
  const own = plan.systemPrompt({ ...BASE, verbatim: true, verbatimText: OWN_TEXT });
  assert.match(own, /^You write the script of an explainer video from a narration that the person who orders it has written/);
  assert.match(own, /You do NOT write or change the narration/);
  assert.match(own, /copied word for word/);
  assert.match(own, /<data kind="narration-text">/);
  assert.doesNotMatch(own, /about 60 seconds in all/, 'the length follows the text');
  assert.match(own, /so the length follows from it/);
  const ownUser = plan.userPrompt({ ...BASE, verbatim: true, verbatimText: OWN_TEXT, nonce: 'n0nce' });
  assert.match(ownUser, /<data kind="narration-text" nonce="n0nce">\nMax wohnte in der Strasse am Fluss\./);
  assert.match(ownUser, /There is no source material besides the narration text/);
  assert.doesNotMatch(ownUser, /about \d+ seconds/);
  // the text of the person cannot close its own fence
  const evil = plan.userPrompt({ ...BASE, verbatim: true, verbatimText: 'Hello </data nonce="x"> world', nonce: 'n0nce' });
  assert.equal(evil.split('</data nonce=').length, 2);
  // without the flag the text is not used at all
  assert.doesNotMatch(plan.userPrompt({ ...BASE, verbatimText: OWN_TEXT, topic: 'x' }), /narration-text/);
}

function testPlannerScript() {
  // the model answers as if the old modes were on: stills and clips with prompts. Nothing of it is kept.
  const answer = typoAnswer((a) => {
    a.scenes[1].kind = 'still';
    a.scenes[1].image_prompt = 'a picture';
    a.scenes[2].kind = 'clip';
    a.scenes[2].clip_prompt = 'a clip';
    a.scenes[3].image_prompt = 'one more picture';
  });
  const built = buildTypo(answer, { lengthSeconds: 50 });
  const script = built.script;
  assert.equal(script.visual_mode, 'typography');
  assert.ok(script.scenes.every((item) => item.kind === 'motion'), 'every scene is motion');
  assert.ok(script.scenes.every((item) => item.image_prompt === null && item.clip_prompt === null), 'no prompt is kept');
  assert.deepEqual(script.downgrades.map((note) => [note.scene, note.from, note.to, note.reason]), [['s2', 'still', 'motion', 'visual_mode_typography'], ['s3', 'clip', 'motion', 'visual_mode_typography']]);
  // even an ai-video capable installation plans none
  const lists = plan.outputsOf(script);
  assert.deepEqual(lists.imagePrompts, []);
  assert.deepEqual(lists.clipPrompts, []);
  assert.equal(lists.shots.counts.images, 0);
  assert.equal(lists.shots.counts.clips, 0);
  assert.ok(lists.shots.scenes.every((entry) => entry.image === null && entry.clip === null));
  // the typography fields: keywords are words of the narration, a layout from the list, the camera only after the first scene
  for (const item of script.scenes) {
    assert.ok(Array.isArray(item.typography.keywords) && 'layout' in item.typography && 'camera' in item.typography);
    for (const word of item.typography.keywords) assert.ok(plan.anchorIn(word, item.narration), `${item.id}: ${word} is spoken`);
    assert.ok(item.typography.keywords.length >= 1 && item.typography.keywords.length <= 4);
    assert.ok(plan.TYPOGRAPHY_LAYOUTS.includes(item.typography.layout), `${item.id}: ${item.typography.layout}`);
  }
  assert.equal(script.scenes[0].typography.camera, '', 'no camera to continue in the first scene');
  assert.equal(script.scenes[1].typography.camera, 'keep travelling along the column of the scene before');
  // the layouts change from scene to scene
  for (let index = 1; index < script.scenes.length; index += 1) {
    if (script.scenes[index].role === 'sources') continue;
    assert.notEqual(script.scenes[index].typography.layout, script.scenes[index - 1].typography.layout, `scene ${index + 1} differs from the one before`);
  }
  // no bullets
  const withBullets = buildTypo(typoAnswer((a) => {
    a.scenes[0].on_screen.bullets = ['one', 'two'];
  })).script;
  assert.deepEqual(withBullets.scenes[0].on_screen.bullets, []);

  // a wrong choice is put right and said
  const wrong = buildTypo(
    typoAnswer((a) => {
      a.scenes[0].typography = { keywords: ['nothing spoken here', narrationOf(1, 22).split(' ')[4]], layout: 'spiral', camera: 'keep going' };
      a.scenes[1].typography = { keywords: [], layout: 'number', camera: '' };
      a.scenes[2].typography = { keywords: ['a', 'b', 'c', 'd', 'e', 'f'].map((x, i) => narrationOf(3, 22).split(' ')[i]), layout: 'stack', camera: '' };
      a.scenes[3].typography = { keywords: [narrationOf(4, 22).split(' ')[2]], layout: 'stack', camera: '' };
    })
  );
  const codes = wrong.issues.map((issue) => issue.code);
  for (const code of ['KEYWORD_NOT_SPOKEN', 'LAYOUT_INVALID', 'LAYOUT_NO_NUMBER', 'KEYWORD_AUTO', 'TOO_MANY_KEYWORDS', 'LAYOUT_REPEATED']) assert.ok(codes.includes(code), `${code} is reported`);
  assert.ok(wrong.issues.filter((issue) => ['KEYWORD_NOT_SPOKEN', 'LAYOUT_INVALID', 'LAYOUT_NO_NUMBER', 'KEYWORD_AUTO', 'TOO_MANY_KEYWORDS', 'LAYOUT_REPEATED'].includes(issue.code)).every((issue) => issue.severity === 'warn'), 'they are corrected here, not sent back to the model');
  assert.equal(wrong.hasErrors, false);
  const [first, second, third, fourth] = wrong.script.scenes;
  assert.equal(first.typography.keywords.length, 1);
  assert.equal(first.typography.camera, '', 'the first scene has no camera hint, whatever the model wrote');
  assert.ok(plan.TYPOGRAPHY_LAYOUTS.includes(first.typography.layout) && first.typography.layout !== 'spiral');
  assert.notEqual(second.typography.layout, 'number', 'no number layout where no number is said');
  assert.equal(third.typography.keywords.length, 4);
  assert.notEqual(fourth.typography.layout, third.typography.layout);
  // a number in the narration allows the number layout and becomes the keyword when the model named none
  const numbered = buildTypo(typoAnswer((a) => {
    a.scenes[1].narration = 'Im Jahr 1957 entstand eine Schrift für die ganze Welt und niemand hat sie je vergessen können, nie.';
    a.scenes[1].typography = { keywords: [], layout: 'number', camera: '' };
  })).script;
  assert.equal(numbered.scenes[1].typography.layout, 'number');
  assert.deepEqual(numbered.scenes[1].typography.keywords, ['1957']);
  // the closing card of the sources has no typography choices
  const withSources = buildTypo(typoAnswer((a) => {
    a.scenes.forEach((item) => {
      item.source_refs = ['S. 1'];
    });
  }), { documents: [DOC] }).script;
  const card = withSources.scenes[withSources.scenes.length - 1];
  assert.equal(card.role, 'sources');
  assert.deepEqual(card.typography, { keywords: [], layout: '', camera: '' });
  assert.equal(card.kind, 'motion');
  // the German spelling: the keywords follow the narration
  const german = buildTypo(typoAnswer((a) => {
    a.scenes[0].narration = 'Die Straße zur Großen Brücke ist lang und führt durch das ganze Land bis zum Meer, weit und breit, nie zu Ende.';
    a.scenes[0].typography = { keywords: ['Straße'], layout: 'stack', camera: '' };
  }), { language: 'de' }).script;
  assert.match(german.scenes[0].narration, /Strasse zur Grossen Brücke/);
  assert.deepEqual(german.scenes[0].typography.keywords, ['Strasse']);
  // the other modes keep their scenes free of the field
  const mixed = plan.buildScript(JSON.parse(JSON.stringify(cases.ANSWER)), { ...BASE, visualMode: 'mix' }).script;
  assert.ok(mixed.scenes.every((item) => !('typography' in item)));
  // idempotent: finishing a finished script changes nothing
  const again = JSON.parse(JSON.stringify(script));
  plan.finalizeScript(again, { ...BASE, lengthSeconds: 50 });
  assert.deepEqual(again.scenes.map((item) => item.typography), script.scenes.map((item) => item.typography));
}

function testBriefsAndLists() {
  const script = buildTypo(typoAnswer(), { lengthSeconds: 50 }).script;
  const lists = plan.outputsOf(script);
  const brief = lists.briefs[1];
  assert.match(brief, /^Scene s2 · role point · kind motion · about [\d.]+ s · landscape · language en\nStyle: typography\n/);
  assert.match(brief, /\nLayout: column \(one long column of words/);
  assert.match(brief, /\nStress \(huge, accent colour\): \S+ \| \S+\n/);
  assert.match(brief, /\nCamera: keep travelling along the column of the scene before\n/);
  assert.doesNotMatch(lists.briefs[0], /\nCamera:/, 'the first scene has no camera line');
  assert.doesNotMatch(brief, /Background:/);
  // the scene node reads the style and the title and still finds its elements
  const parsed = scene.parseBrief(brief);
  assert.equal(parsed.style, 'typography');
  assert.equal(parsed.id, 's2');
  assert.equal(parsed.title, 'Titel 2');
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].type, 'title');
  assert.equal(scene.parseBrief('Scene s1 · role hook · kind motion · about 5 s · landscape · language en').style, '');
  // the shot list
  assert.equal(lists.shots.visual_mode, 'typography');
  assert.deepEqual(lists.shots.scenes[1].typography, { layout: 'column', keywords: script.scenes[1].typography.keywords, camera: 'keep travelling along the column of the scene before' });
  assert.deepEqual(lists.shots.counts, { scenes: 6, narration: 6, briefs: 6, images: 0, clips: 0 });
  // narration lists as before
  assert.equal(lists.narration.length, 6);
  // the brief of the sources card is a typography brief too, without a layout
  const withCard = buildTypo(typoAnswer((a) => a.scenes.forEach((item) => (item.source_refs = ['S. 1']))), { documents: [DOC] }).script;
  const cardBrief = plan.outputsOf(withCard).briefs.pop();
  assert.match(cardBrief, /\nStyle: typography\n/);
  assert.doesNotMatch(cardBrief, /\nLayout:/);
}

function testEditedScript() {
  const built = buildTypo(typoAnswer(), { lengthSeconds: 50 }).script;
  // the person sets the same layout twice and a word to stress: an edited script keeps what the person wrote
  const edited = JSON.parse(JSON.stringify(built));
  edited.scenes[1].typography.layout = edited.scenes[0].typography.layout;
  edited.scenes[1].typography.keywords = [narrationOf(2, 22).split(' ')[7]];
  const parsed = plan.parseScriptText(JSON.stringify(edited), { ...BASE, lengthSeconds: 50 });
  assert.ok(parsed.script);
  assert.equal(parsed.script.scenes[1].typography.layout, edited.scenes[0].typography.layout);
  assert.deepEqual(parsed.script.scenes[1].typography.keywords, edited.scenes[1].typography.keywords);
  assert.ok(parsed.script.scenes.every((item) => item.kind === 'motion' && !item.image_prompt && !item.clip_prompt));
  // an invalid layout is still put right
  edited.scenes[2].typography.layout = 'spiral';
  const fixed = plan.parseScriptText(JSON.stringify(edited), { ...BASE, lengthSeconds: 50 });
  assert.ok(plan.TYPOGRAPHY_LAYOUTS.includes(fixed.script.scenes[2].typography.layout));
  // the same script read in the mode motion loses the field
  const asMotion = plan.parseScriptText(JSON.stringify(edited), { ...BASE, visualMode: 'motion', lengthSeconds: 50 });
  assert.ok(asMotion.script.scenes.every((item) => !('typography' in item)));
}

function testOwnText() {
  // a cut of the text that keeps every word
  const sentences = OWN_TEXT.split(/(?<=[.!?»])\s+/);
  assert.ok(sentences.length >= 5);
  const cut = ownCut([sentences.slice(0, 2).join(' '), sentences.slice(2, 4).join(' '), sentences.slice(4).join(' ')]);
  const built = plan.buildScript(cut, { ...BASE, language: 'de', verbatim: true, verbatimText: OWN_TEXT });
  assert.equal(built.issues.filter((issue) => issue.code === 'VERBATIM_CHANGED').length, 0);
  assert.equal(built.script.verbatim, true);
  const spoken = built.script.scenes.filter((item) => item.role !== 'sources');
  assert.deepEqual(tokensOf(spoken.map((item) => item.narration).join(' ')), tokensOf(OWN_TEXT), 'no word changed, none lost, none added');
  // the person's own characters: punctuation, quotes and the German sharp s stay (the app writes "ss" in what it generates, not here)
  const joined = spoken.map((item) => item.narration).join(' ');
  assert.match(joined, /Heiß diskutiert/);
  assert.match(joined, /«Gut gestaltet»/);
  assert.match(joined, /«Das ist Helvetica\.»/);
  assert.match(joined, /Strasse am Fluss/);
  // a text that goes to a new line inside a sentence is one text
  assert.doesNotMatch(joined, /\n/);
  // the length is that of the text, not the length asked for; a short text may be fewer than three scenes
  const seconds = spoken.reduce((sum, item) => sum + plan.secondsFor(item.narration, 'de'), 0);
  near(built.script.length_seconds, Math.round(seconds), 1);
  assert.ok(built.script.length_seconds !== 60);
  assert.equal(built.issues.some((issue) => issue.code === 'LENGTH_OFF'), false);
  const short = plan.buildScript(ownCut(['Ein kurzer Text.', 'Mit nur zwei Teilen.']), { ...BASE, language: 'de', verbatim: true, verbatimText: 'Ein kurzer Text. Mit nur zwei Teilen.' });
  const tooFew = short.issues.find((issue) => issue.code === 'TOO_FEW_SCENES');
  assert.ok(tooFew && tooFew.severity === 'warn', 'two scenes are enough for a short text');
  assert.equal(short.hasErrors, false);
  // where the cut falls inside a sentence the quotes follow the right scene
  const quoted = plan.buildScript(ownCut(['Er sagte: «Gut gestaltet»', '«Das ist es» und ging.']), { ...BASE, verbatim: true, verbatimText: 'Er sagte: «Gut gestaltet» «Das ist es» und ging.' }).script;
  assert.deepEqual(quoted.scenes.map((item) => item.narration), ['Er sagte: «Gut gestaltet»', '«Das ist es» und ging.']);
  // a scene without words (a sources card the model added) keeps none
  const withEmpty = plan.alignNarration('Eins zwei. Drei vier.', ['Eins zwei.', '', 'Drei vier.']);
  assert.deepEqual(withEmpty, { ok: true, parts: ['Eins zwei.', '', 'Drei vier.'] });

  // the model changes a word, drops one, adds one, reorders: the app cuts the text itself and the model is told
  for (const [label, parts] of [
    ['changed', [sentences[0].replace('Strasse', 'Gasse'), ...sentences.slice(1)]],
    ['dropped', [sentences[0], ...sentences.slice(2)]],
    ['added', [sentences[0], `${sentences[1]} Und noch etwas.`, ...sentences.slice(2)]],
    ['reordered', [sentences[1], sentences[0], ...sentences.slice(2)]]
  ]) {
    const result = plan.buildScript(ownCut(parts), { ...BASE, language: 'de', verbatim: true, verbatimText: OWN_TEXT });
    const error = result.issues.find((issue) => issue.code === 'VERBATIM_CHANGED');
    assert.ok(error && error.severity === 'error', `${label}: the model is told`);
    assert.match(error.message, /differs from the given text|stop after|more words than the text/, `${label}: and where`);
    assert.equal(result.hasErrors, true);
    const kept = result.script.scenes.filter((item) => item.role !== 'sources').map((item) => item.narration).join(' ');
    assert.deepEqual(tokensOf(kept), tokensOf(OWN_TEXT), `${label}: whatever the model did, the narration is the text`);
    assert.match(kept, /Heiß/, `${label}: with the characters of the person`);
  }
  // when the model made as many scenes as the app, its plan for them is kept
  const four = plan.splitNarration(OWN_TEXT.replace(/\s+/g, ' '), 'de', plan.LIMITS.verbatimFallbackSceneSeconds);
  const same = plan.buildScript(ownCut(four.map((part, index) => (index === 0 ? part.replace('Strasse', 'Gasse') : part))), { ...BASE, language: 'de', verbatim: true, verbatimText: OWN_TEXT });
  assert.equal(same.script.scenes.filter((item) => item.role !== 'sources').length, four.length);
  assert.equal(same.script.scenes[0].on_screen.title, 'T1', 'the title of the model stays where the cut is the same');
  // whitespace and line breaks of the text do not matter, case and punctuation do not matter for the comparison
  const loose = plan.alignNarration('Hallo   Welt.\n\nWie geht es?', ['hallo welt', 'Wie geht es']);
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.parts, ['Hallo Welt.', 'Wie geht es?']);
  // a combining mark is part of the word (a decomposed "ä")
  assert.equal(plan.alignNarration('Za\u0308hne putzen.', ['Zähne putzen.']).ok, true);
  // no own text, no check: the old rules hold (the length, three scenes)
  const ordinary = plan.buildScript(ownCut(['Ein kurzer Text.', 'Mit nur zwei Teilen.']), { ...BASE, language: 'de' });
  assert.ok(ordinary.issues.some((issue) => issue.code === 'TOO_FEW_SCENES' && issue.severity === 'error'));
  assert.ok(ordinary.issues.some((issue) => issue.code === 'LENGTH_OFF'));
  // the limit of the length is named in the library
  assert.equal(plan.LIMITS.verbatimMaxSeconds, 480);
}

function testSceneWriter() {
  // the palette: paper without a brand, the colours of the brand with one
  const paper = scene.typographyTokens(null);
  assert.deepEqual([paper.bg, paper.fg, paper.accent, paper.accent2, paper.white], ['#e7e0d0', '#111111', '#d8412c', '#1f6a73', '#ffffff']);
  assert.ok(scene.contrast(paper.bg, paper.fg) >= 12);
  assert.ok(scene.contrast(paper.bg, paper.accent) >= 3, 'the accent against the paper');
  assert.ok(scene.contrast(paper.bg, paper.muted) >= 4.5, 'the small captions are legible');
  assert.ok(scene.contrast(paper.panel, paper.white) >= 3, 'white type on grey');
  assert.notEqual(paper.bgLight, paper.bgDark);
  const neutral = scene.typographyTokens({ neutral: true, colors: [{ role: 'background', hex: '#0f1115' }], fonts: [] });
  assert.equal(neutral.bg, '#e7e0d0', 'the neutral brand is no brand');
  const brand = { name: 'Example Brand', colors: [{ role: 'background', hex: '#101820' }, { role: 'text', hex: '#f2f2f2' }, { role: 'accent', hex: '#ff6b35' }, { role: 'secondary', hex: '#00a6a6' }], fonts: [{ role: 'headline', family: 'Example Sans' }, { role: 'body', family: 'Example Serif' }] };
  const branded = scene.typographyTokens(brand);
  assert.deepEqual([branded.bg, branded.fg, branded.accent, branded.accent2], ['#101820', '#f2f2f2', '#ff6b35', '#00a6a6'], 'a brand keeps its colours');
  assert.ok(scene.contrast(branded.bg, branded.muted) >= 4.5);
  assert.ok(branded.bgLight !== branded.bg && branded.bgDark !== branded.bg);

  // the fonts: the family of the brand where its file is embedded, else the default font
  const without = scene.typographyFontTokens(paper, []);
  assert.equal(without.needsDefault, true);
  assert.equal(without.tokens.headlineFamily, 'Inter Tight');
  assert.equal(without.tokens.bodyFamily, 'Inter Tight');
  assert.equal(without.tokens.headline, "'Inter Tight', sans-serif", 'an embedded family has no named system font behind it');
  assert.doesNotMatch(without.tokens.body, /system-ui|Helvetica|Arial/);
  const both = scene.typographyFontTokens(branded, ['Example Sans', 'Example Serif']);
  assert.equal(both.needsDefault, false);
  assert.deepEqual([both.tokens.headlineFamily, both.tokens.bodyFamily], ['Example Sans', 'Example Serif']);
  const one = scene.typographyFontTokens(branded, ['Example Sans']);
  assert.equal(one.needsDefault, true);
  assert.deepEqual([one.tokens.headlineFamily, one.tokens.bodyFamily], ['Example Sans', 'Inter Tight']);
  assert.match(one.tokens.headline, /^'Example Sans', sans-serif$/, 'an embedded family of the brand: no named system font either');

  // a third file of the brand (a mono face) must not take the place of the default font: only the files of the two families count
  {
    const file = (family) => ({ family, ext: '.woff2', buffer: Buffer.alloc(1000, 1), weight: '400' });
    const defaultFile = { family: 'Inter Tight', ext: '.woff2', buffer: Buffer.alloc(1000, 2), weight: '100 900' };
    const three = [file('Example Sans'), file('Brand Mono'), file('Example Serif')];
    const kept = scene.typographyBrandFiles(branded, [file('Brand Mono'), file('Example Sans'), { ...file('Example Sans'), ext: '.ttf' }]);
    assert.deepEqual(kept.map((item) => `${item.family}${item.ext}`), ['Example Sans.woff2'], 'one file per family, the other families are left out');
    assert.deepEqual(scene.typographyBrandFiles(branded, three).map((item) => item.family), ['Example Sans', 'Example Serif']);
    // headline and mono file, no file for the body family
    const files = scene.typographyBrandFiles(branded, [file('Example Sans'), file('Brand Mono')]);
    const planned = scene.typographyFontTokens(branded, scene.fontFaces(files).used);
    assert.equal(planned.needsDefault, true);
    const faces = scene.fontFaces([...files, defaultFile]);
    assert.deepEqual(faces.used, ['Example Sans', 'Inter Tight']);
    assert.deepEqual(faces.skipped, []);
    const final = scene.typographyFontTokens(branded, faces.used, { final: true });
    assert.deepEqual([final.tokens.headlineFamily, final.tokens.bodyFamily], ['Example Sans', 'Inter Tight']);
    // the default font is not among the embedded ones (not readable): no family is promised that is not in the page
    const missing = scene.typographyFontTokens(branded, ['Example Sans'], { final: true });
    assert.deepEqual([missing.tokens.headlineFamily, missing.tokens.bodyFamily], ['Example Sans', 'Example Serif']);
    assert.match(missing.tokens.body, /^'Example Serif', system-ui/, 'a family without an embedded file keeps the ordinary stack');
    const none = scene.typographyFontTokens(scene.typographyTokens(null), [], { final: true });
    assert.doesNotMatch(none.tokens.headline, /Inter Tight/);
    const prompt = scene.writerSystemPrompt({ format: 'landscape', duration: 7.4, tokens: none.tokens, embeddedFonts: [], style: 'typography' });
    assert.doesNotMatch(prompt, /variable font/, 'the variable font is promised only where it is in the page');
    assert.doesNotMatch(prompt, /Inter Tight/);
    // the stack of an embedded default font names no system font, and the prompt says to avoid characters outside of Latin
    const full = scene.writerSystemPrompt({ format: 'landscape', duration: 7.4, tokens: scene.typographyFontTokens(branded, [], {}).tokens, embeddedFonts: ['Inter Tight'], style: 'typography' });
    assert.match(full, /Inter Tight is a variable font/);
    assert.match(full, /avoid characters outside of that \(subscript digits, arrows, symbols\)/);
  }

  // the list of words in the request: the number is the number of the words that are listed
  {
    const many = Array.from({ length: 130 }, (_, index) => ({ text: `w${index}`, start: index * 0.1 }));
    const few = scene.writerUserPrompt({ brief: 'x', duration: 15, words: many.slice(0, 3), style: 'typography' });
    assert.match(few, /\(absolute seconds on tl; 3 words\)/);
    const cut = scene.writerUserPrompt({ brief: 'x', duration: 15, words: many, style: 'typography' });
    assert.match(cut, /; 120 words of 130, the rest is left out\)/);
    assert.ok(cut.includes('w119') && !cut.includes('w120'));
  }

  // the prompt of the writer
  const tokens = scene.typographyFontTokens(paper, ['Inter Tight']).tokens;
  const system = scene.writerSystemPrompt({ format: 'landscape', duration: 7.4, tokens, embeddedFonts: ['Inter Tight'], style: 'typography' });
  // the contract of the page is still there
  assert.match(system, /^You write ONE scene of an explainer video as a complete HTML document/);
  assert.ok(system.includes(`<script src="${GSAP}"></script>`));
  assert.match(system, /3\. Root element: <div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="7\.399">/);
  assert.match(system, /2\. body,html \{ margin:0; width:1920px; height:1080px; overflow:hidden; background:#e7e0d0; \}/);
  // the style
  assert.match(system, /style "typography" \(kinetic typography in the Swiss manner/);
  for (const rule of [
    /with the second at which it STARTS it/,
    /Each spoken word appears exactly then/,
    /data-at="1\.24"/,
    /they HIT: scale from 1\.7 to 2\.4 down to 1 with overshoot/,
    /motion blur in the direction of flight/,
    /stdDeviation="70 0"/,
    /Connecting words/,
    /mix-blend-mode: multiply/,
    /perspective:1400px/,
    /textLength="\{block width\}" and lengthAdjust="spacingAndGlyphs"/,
    /Do not measure text with JavaScript/,
    /line-height 0\.78 to 0\.95/,
    /strong radial vignette/,
    /Other type MAY run over the edge of the frame and be cut by it/,
    /never ends with a hard stop and never begins from rest/,
    /If the brief has a "Camera" line, begin with exactly that movement/,
    /Inter Tight is a variable font: every weight from 100 to 900 is real/,
    /name no other font family and rely on no system font/
  ]) assert.match(system, rule);
  for (const layout of plan.TYPOGRAPHY_LAYOUTS) assert.match(system, new RegExp(`- ${layout}: `), `the layout ${layout} is explained`);
  // the limits are the ones of the style
  assert.doesNotMatch(system, /At most 25 words on screen/);
  assert.doesNotMatch(system, /at most 4 list items/);
  assert.match(system, /Every spoken word may appear/);
  assert.match(system, new RegExp(`At most ${scene.TYPOGRAPHY_LABEL_WORDS} words that are NOT spoken`));
  assert.match(system, new RegExp(`never more than ${scene.TYPOGRAPHY_VISIBLE_WORDS} words in view at the same moment`));
  assert.match(system, new RegExp(`every spoken word at least ${scene.MIN_FONT_PX} px`));
  assert.match(system, new RegExp(`at least ${scene.MIN_LABEL_PX} px and in ${paper.muted} or darker`));
  assert.ok(scene.MIN_LABEL_PX < scene.MIN_FONT_PX, 'a label may be smaller than a spoken word');
  assert.ok(scene.MIN_LABEL_PX >= 28, 'but stays legible');
  // the palette is in the prompt, and the source line is left to the app
  for (const color of [paper.bg, paper.fg, paper.accent, paper.accent2, paper.white, paper.panel, paper.muted, paper.bgLight, paper.bgDark]) assert.ok(system.includes(color), `the colour ${color} is named`);
  assert.match(system, /do not write a source line or "Source:"/);
  // no zone for subtitles any more (the style has none): the whole frame is for the type, down to the source line the app sets
  assert.doesNotMatch(system, /burnt in|Keep the lowest|free of the word being said|subtitles are/i);
  assert.doesNotMatch(system, /lowest \d+ % of the frame/);
  assert.match(system, /There are no subtitles in this style: the type may use the whole frame down to 115 px above the lower edge, no lower zone is kept free/);
  assert.match(system, /The app adds the small source line at the very bottom itself \(inside the lowest 115 px\): do not write a source line or "Source:", and keep the key words and the word being said clear of it/);
  assert.match(system, /the key word being said is fully inside the frame, 115 px from every edge/);
  // portrait: another frame, another band, another size of the key words
  const portrait = scene.writerSystemPrompt({ format: 'portrait', duration: 7.4, tokens, embeddedFonts: ['Inter Tight'], style: 'typography' });
  assert.match(portrait, /1080px; height:1920px/);
  assert.doesNotMatch(portrait, /burnt in|subtitles are|lowest \d+ % of the frame/i);
  assert.match(portrait, /no lower zone is kept free/);
  assert.match(portrait, /down to 85 px above the lower edge/);
  assert.match(portrait, /fully inside the frame, 65 px from every edge/);
  assert.match(portrait, /huge \(260 to 520 px\)/);
  // a brand with two embedded families: the second may be used for single accents; the notes of the brand are told
  const brandTokens = scene.typographyFontTokens({ ...scene.typographyTokens({ ...brand, motion: { notes: 'Calm, precise movements.' } }) }, ['Example Sans', 'Example Serif']).tokens;
  const branded2 = scene.writerSystemPrompt({ format: 'landscape', duration: 9, tokens: brandTokens, embeddedFonts: ['Example Sans', 'Example Serif'], style: 'typography' });
  assert.match(branded2, /may be set in the second embedded family/);
  assert.match(branded2, /Notes of the brand on motion and look: Calm, precise movements\./);
  assert.doesNotMatch(branded2, /Inter Tight is a variable font/);
  assert.match(branded2, /ground #101820/);
  // the request: every word of the voice with its time
  const words = [{ text: 'Max', start: 0.35, end: 0.6 }, { text: 'Miedinger,', start: 0.72, end: 1.4 }, { text: 'der', start: 1.5, end: 1.6 }, { text: 'Schriftgestalter.', start: 1.62, end: 2.9 }];
  const user = scene.writerUserPrompt({ brief: 'Scene s1 · role hook · kind motion · about 4 s · landscape · language de\nStyle: typography', duration: 4.2, cues: [{ id: 'e1', type: 'title', anchor: 'Max', at: 0.2 }], words, style: 'typography' });
  assert.match(user, /Scene duration: 4\.2 s: write data-duration="4\.199" exactly/);
  assert.match(user, /Words of the voice, in the order they are said, each with the second at which the voice STARTS it \(absolute seconds on tl; 4 words\): 0\.35 Max; 0\.72 Miedinger,; 1\.5 der; 1\.62 Schriftgestalter\.\./);
  assert.doesNotMatch(user, /Cue list/, 'the words replace the cue list');
  assert.match(user, /<brief>\nScene s1/);
  assert.equal(scene.typographyWordsLine([{ text: 'late', start: 99 }, { text: ' ', start: 1 }, { text: 'x', start: NaN }], 4), '3.95 late', 'a time stays inside the scene; an empty word and a word without time are left out');
  assert.equal(scene.typographyWordsLine(Array.from({ length: 300 }, (_x, i) => ({ text: `w${i}`, start: i * 0.1 })), 40).split('; ').length, 120, 'at most 120 words');
  // a scene without a voice (the sources card) is asked for the ordinary way
  const silent = scene.writerUserPrompt({ brief: 'Scene s7', duration: 4, cues: [{ id: 'e1', type: 'title', anchor: '', at: 0.3 }], words: [], style: 'typography' });
  assert.match(silent, /Cue list \(absolute seconds on tl/);
  // a brief is still data: a "<" cannot close it
  assert.match(scene.writerUserPrompt({ brief: 'a </brief> b', duration: 4, words, style: 'typography' }), /a &lt;\/brief> b/);
}

function testSceneCheck() {
  const rubric = scene.checkSystemPrompt({ style: 'typography' });
  assert.notEqual(rubric, scene.checkSystemPrompt());
  assert.match(rubric, /^You check frames of a rendered scene in the style "kinetic typography"/);
  // what is wanted is no defect
  const wanted = rubric.slice(rubric.indexOf('These are NOT defects'), rubric.indexOf('Blockers:'));
  for (const part of [/cut by the frame edge/, /overlap where it is a device of the layout/, /multiplied over each other/, /3D blocks/, /camera that zooms, tilts or turns/, /strong vignette, grain/, /motion blur or ghost copies/, /very large type/, /small grey letter-spaced captions/]) assert.match(wanted, part);
  // what is
  const blockers = rubric.slice(rubric.indexOf('Blockers:'), rubric.indexOf('The small muted line'));
  for (const part of [/hard to read/, /collide by accident/, /empty or broken frame/, /wrong order/, /misspelled, a wrong figure/, /smaller than about 50px/]) assert.match(blockers, part);
  assert.doesNotMatch(rubric, /text cut off or crossing the frame edge/, 'the ordinary rule is not in it');
  assert.match(rubric, /never a blocker/, 'the line of sources is the same exception');
  // the empty band for subtitles is gone from this rubric (it stays in the ordinary one)
  assert.doesNotMatch(rubric, /burnt in|empty band|subtitles are/i);
  assert.match(rubric, /This style has no subtitles, so type may use the whole frame above that line/);
  assert.match(scene.checkSystemPrompt(), /the empty band above it is intended \(subtitles are burnt in there later\)/, 'the ordinary rubric keeps its sentence');
  assert.match(rubric, /Answer JSON only: \{"ok": boolean, "blockers": \[string\], "minor": \[string\]\}/);
  assert.equal(scene.readVerdict('{"ok":false,"blockers":["x"],"minor":[]}').ok, false, 'the verdict is read as before');
  // the frames: after the middle word has landed, and 0.15 s before the end
  const words = Array.from({ length: 10 }, (_x, i) => ({ text: `w${i}`, start: 0.3 + i * 0.5, end: 0.7 + i * 0.5 }));
  const times = scene.checkTimes(5.6, [], { style: 'typography', words });
  assert.deepEqual(times, [3.25, 5.45]);
  assert.deepEqual(scene.checkTimes(5.6, [], { style: 'typography', words: words.slice(0, 2) }), scene.checkTimes(5.6, []), 'too few words: the ordinary times');
  const late = scene.checkTimes(2, [], { style: 'typography', words: [{ text: 'a', start: 1.9 }, { text: 'b', start: 1.95 }, { text: 'c', start: 1.98 }] });
  assert.ok(late[0] < late[1] && late[0] > 0);
  // the request: what the voice has said by then, what not yet
  const user = scene.checkUserPrompt({ brief: 'Scene s1\nStyle: typography', times, words, style: 'typography' });
  assert.match(user, /frame 1: by 3\.25 s the voice has said "w0 w1 w2 w3 w4 w5" and has not yet said "w6 w7 w8 w9"/);
  assert.match(user, /frame 2: by 5\.45 s the voice has said "w0 w1 w2 w3 w4 w5 w6 w7 w8 w9"\./);
  assert.match(user, /Frame times: 3\.25 s and 5\.45 s \(frame 1 and frame 2\)\./);
  assert.match(scene.checkUserPrompt({ brief: 'b', times: [0.5, 3], words: [{ text: 'a', start: 4 }], style: 'typography' }), /has said "\(nothing yet\)"/);
  // without words (or without the style) the ordinary request
  assert.equal(scene.checkUserPrompt({ brief: 'b', cues: [], times: [1, 2], words: [], style: 'typography' }), scene.checkUserPrompt({ brief: 'b', cues: [], times: [1, 2] }));
}

function testDefaultFont() {
  const spec = scene.TYPOGRAPHY_FONT;
  assert.equal(spec.family, 'Inter Tight');
  const file = path.join(root, spec.file);
  const licence = path.join(root, spec.license);
  assert.ok(fs.existsSync(file), 'the font file is in the repository');
  assert.ok(fs.existsSync(licence), 'the licence');
  assert.equal(path.dirname(file), path.dirname(licence), 'the licence lies next to the font');
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 file');
  assert.equal(buffer.length, 44916);
  assert.ok(buffer.length < scene.MAX_FONT_BYTES, 'within the limit of one font file');
  assert.match(fs.readFileSync(licence, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.equal(path.extname(spec.file), spec.ext);
  // embedded: the range of the weights is declared (a rule with one weight would make the browser calculate bold)
  const faces = scene.fontFaces([{ family: spec.family, ext: spec.ext, buffer, weight: spec.weight }]);
  assert.deepEqual(faces.used, ['Inter Tight']);
  assert.deepEqual(faces.skipped, []);
  assert.match(faces.css, /^@font-face\{font-family:'Inter Tight';src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\('woff2'\);font-weight:100 900;font-style:normal\}$/);
  assert.equal(Buffer.from(/base64,([A-Za-z0-9+/=]+)\)/.exec(faces.css)[1], 'base64').equals(buffer), true, 'the bytes are those of the file');
  // the fvar table of the file really has the axis 100 to 900 (read from the font: the file is the variable font, not a static cut)
  const axis = weightAxisOf(buffer);
  assert.deepEqual(axis, { min: 100, default: 400, max: 900 });
  // other font rules are as they were: one weight, or none
  assert.match(scene.fontFaces([{ family: 'A', ext: '.woff2', buffer: Buffer.from('x'), weight: '700' }]).css, /font-weight:700;/);
  assert.match(scene.fontFaces([{ family: 'A', ext: '.woff2', buffer: Buffer.from('x'), weight: 'bold' }]).css, /font-weight:400;/);
  assert.match(scene.fontFaces([{ family: 'A', ext: '.woff2', buffer: Buffer.from('x'), weight: '100 900 x' }]).css, /font-weight:400;/);
  // the limits: two files at most, 400 KB each; a brand with two fonts leaves no room for the default one (the node adds it only when needed)
  const brandFont = (family) => ({ family, ext: '.woff2', buffer: Buffer.alloc(1000, 1), weight: '400' });
  const crowded = scene.fontFaces([brandFont('One'), brandFont('Two'), { family: spec.family, ext: spec.ext, buffer, weight: spec.weight }]);
  assert.deepEqual(crowded.used, ['One', 'Two']);
  assert.match(crowded.skipped.join(), /more than 2 font files/);
  const oneAndDefault = scene.fontFaces([brandFont('One'), { family: spec.family, ext: spec.ext, buffer, weight: spec.weight }]);
  assert.deepEqual(oneAndDefault.used, ['One', 'Inter Tight']);
  assert.equal(scene.MAX_FONT_FILES, 2);
  assert.equal(scene.MAX_FONT_BYTES, 400 * 1024);
  // the whole page stays far below the limit of the render node
  assert.ok(Buffer.byteLength(scene.embedFonts('<head></head>', faces.css)) < scene.MAX_HTML_BYTES / 10);
}

// The axes of the variable font in a woff2 file: the table directory, the one brotli stream, the table fvar.
function weightAxisOf(buffer) {
  const zlib = require('zlib');
  const known = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = buffer[at++];
      value = value * 128 + (byte & 127);
      if (!(byte & 128)) return value;
    }
    throw new Error('bad woff2');
  };
  const tables = [];
  for (let i = 0; i < buffer.readUInt16BE(12); i += 1) {
    const flags = buffer[at++];
    const index = flags & 63;
    let tag;
    if (index === 63) {
      tag = buffer.toString('latin1', at, at + 4);
      at += 4;
    } else tag = known[index];
    const transform = (flags >> 6) & 3;
    const original = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0;
    tables.push({ tag, length: transformed ? base128() : original });
  }
  const data = zlib.brotliDecompressSync(buffer.subarray(at, at + buffer.readUInt32BE(20)));
  let offset = 0;
  for (const table of tables) {
    if (table.tag === 'fvar') {
      const fvar = data.subarray(offset, offset + table.length);
      const axes = fvar.readUInt16BE(4);
      for (let i = 0; i < axes; i += 1) {
        const place = fvar.readUInt16BE(4) + i * fvar.readUInt16BE(10);
        if (fvar.toString('latin1', place, place + 4) === 'wght') return { min: fvar.readInt32BE(place + 4) / 65536, default: fvar.readInt32BE(place + 8) / 65536, max: fvar.readInt32BE(place + 12) / 65536 };
      }
    }
    offset += table.length;
  }
  return null;
}

function testSampleScene() {
  // what the prompt recommends passes the check of the code (the same sample, once in landscape and once in portrait)
  assert.deepEqual(scene.checkCode(sampleScene(), { format: 'landscape' }), []);
  assert.deepEqual(scene.checkCode(sampleScene({ width: 1080, height: 1920, duration: '5.999' }), { format: 'portrait' }), []);
  // the sample uses the tools of the prompt
  const html = sampleScene();
  for (const part of [/data-at=/, /querySelectorAll\('\.k'\)/, /textLength="1200" lengthAdjust="spacingAndGlyphs"/, /<textPath href="#curve"/, /feGaussianBlur id="mb"[^>]*stdDeviation="70 0"/, /attr:\{stdDeviation:'0 0'\}/, /mix-blend-mode:multiply/, /transform-style:preserve-3d/, /perspective:1400px/]) assert.match(html, part);
  // the rules of the check are still the rules: a way out of the page is refused in this style as in any other
  for (const bad of ['<script>document.body.innerHTML = "x"</script>', '<script>fetch("https://example.org")</script>', '<script>window.location = "x"</script>', '<img src="https://example.org/a.png">']) {
    assert.ok(scene.checkCode(html.replace('</div>\n</body>', `${bad}</div>\n</body>`), { format: 'landscape' }).length > 0, bad);
  }
}

function testDocs() {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  for (const file of ['README.md', 'README.de.md']) {
    const text = read(file);
    assert.match(text, /Inter Tight/, `${file}: the font is named`);
    assert.match(text, /lib\/fonts\/inter-tight\/OFL\.txt/, `${file}: with the licence file`);
    assert.match(text, /SIL Open Font License/, `${file}: and the licence`);
    assert.match(text, /WP40/, `${file}: the package`);
    const heading = file === 'README.md' ? '## Third-party software' : '## Software von Dritten';
    const section = text.slice(text.indexOf(heading), text.indexOf(file === 'README.md' ? '## License' : '## Lizenz'));
    assert.match(section, /\*\*Inter Tight\*\*[^\n]*SIL Open Font License 1\.1[^\n]*lib\/fonts\/inter-tight\/OFL\.txt/, `${file}: named in the section of third-party software`);
  }
  for (const file of ['docs/node-view/SPEC.md', 'docs/node-view/IMPLEMENTATION-NOTES.md']) assert.match(read(file), /WP40/, `${file}: WP40`);
  const help = read('public/help.html');
  for (const heading of ['<strong>Typografie-Video:</strong>', '<strong>Typography video:</strong>', '<strong>Vídeo tipográfico:</strong>']) assert.equal(help.split(heading).length, 2, `the help page has ${heading} once`);
  assert.doesNotMatch(help, /ß/);
  // no subtitles in the style (follow-up of WP40): the docs say so and keep no band for subtitles in the style any more
  assert.match(read('README.md'), /\*No subtitles:\* in this style the words are the picture/);
  assert.match(read('README.de.md'), /\*Keine Untertitel:\* In diesem Stil sind die Wörter das Bild/);
  for (const file of ['README.md', 'README.de.md']) {
    const entry = read(file).split('\n').find((line) => /WP40\)\*\* — /.test(line) && /(Typography|Typografie)/.test(line.slice(0, 80)));
    assert.ok(entry, `${file}: the entry of the style`);
    assert.doesNotMatch(entry, /lower 20 %|lower fifth stays free|unteren 20 %|untere Fünftel/, `${file}: no band for subtitles in the style`);
  }
  assert.match(read('docs/node-view/SPEC.md'), /No subtitles in the style Typography \(WP40 follow-up/);
  assert.match(read('docs/node-view/IMPLEMENTATION-NOTES.md'), /### Style Typography without subtitles \(WP40 follow-up/);
  for (const [heading, pattern] of [['<strong>Typografie-Video:</strong>', /<strong>keine Untertitel<\/strong>/], ['<strong>Typography video:</strong>', /<strong>no subtitles<\/strong>/], ['<strong>Vídeo tipográfico:</strong>', /<strong>no tiene subtítulos<\/strong>/]]) {
    const item = help.slice(help.indexOf(heading), help.indexOf('</li>', help.indexOf(heading)));
    assert.match(item, pattern, `${heading} says there are no subtitles`);
  }
  // no internal names in what this package wrote
  for (const file of ['lib/explainer-plan.js', 'lib/explainer-scene.js', 'lib/nodes/templates/typography-video.json', 'lib/nodes/templates/typography-video-text.json', 'lib/fonts/inter-tight/OFL.txt']) {
    assert.doesNotMatch(read(file), /kuble\.com|\.internal\b|\b10\.\d+\.\d+\.\d+\b|\/Users\/[a-z]/i, `${file}: no internal name or address`);
  }
}

/* ---------- Part 2 ---------- */

async function run(iso, eleven) {
  const nodeRegistry = iso.load('lib/nodes/registry');
  const templates = iso.load('lib/nodes/templates');
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const costs = iso.load('lib/costs');
  const discovery = iso.load('lib/discovery');
  const rendernode = iso.load('lib/rendernode');
  const jobsLib = iso.load('lib/nodes/jobs');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const tools = iso.load('lib/tools');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue } = iso.load('lib/nodes/types');
  const videoNodes = iso.load('lib/nodes/nodes-explainer-video');
  const planLib = iso.load('lib/explainer-plan');
  const sceneLib = iso.load('lib/explainer-scene');
  const real = nodeRegistry.registry;

  /* ----- definitions ----- */

  const planDef = real.get('explainer.plan');
  assert.deepEqual(planDef.inputs.map((port) => port.id), ['documents', 'text', 'own_text', 'topic', 'notes', 'sources', 'info', 'brand', 'brief']);
  assert.equal(planDef.inputs.find((port) => port.id === 'own_text').type, 'text');
  assert.ok(planDef.inputs.every((port) => !port.required), 'every input stays optional');
  const mode = planDef.params.find((param) => param.id === 'visual_mode');
  assert.deepEqual(mode.options, ['motion', 'mix', 'ai_video', 'typography']);
  assert.equal(mode.default, 'mix', 'the default mode is the same');
  // the mode is a choice in the same field: the sliders of the other modes are hidden for it
  assert.deepEqual(planDef.params.find((param) => param.id === 'max_still_share').showIf, { param: 'visual_mode', equals: 'mix' });
  assert.deepEqual(planDef.params.find((param) => param.id === 'clips').showIf, { param: 'visual_mode', in: ['mix', 'ai_video'] });
  assert.deepEqual(planDef.params.map((param) => param.id), ['model', 'topic', 'brief', 'length_seconds', 'language', 'audience', 'tone', 'visual_mode', 'format', 'max_still_share', 'clips', 'presenter', 'verify', 'script'], 'no parameter was added: an own text is an input');
  // the validation: an own text is material
  assert.deepEqual(planDef.validate({ script: '', topic: '' }, { own_text: { connected: true } }), []);
  assert.equal(planDef.validate({ script: '', topic: '' }, {}).length, 1);

  const bins = ffmpegLib.binaries();
  const haveFfmpeg = bins.available;

  const session = await store.createSession();
  const sessionId = session.id;
  const sessionDir = store.sessionAssetDir(sessionId);

  /* ----- the model, the voice and the render node, replaced ----- */

  const calls = [];
  const journal = [];
  const renders = [];
  const answers = { plan: [], research: [], writer: [], check: [] };
  const USD = { research: 0.05, plan: 0.3, verify: 0.1, writer: 0.06, check: 0.03 };
  const durationOf = (text) => Number(/data-duration="([\d.]+)"/.exec(text)[1]);
  const sizeOf = (text) => ({ width: Number(/data-width="(\d+)"/.exec(text)[1]), height: Number(/data-height="(\d+)"/.exec(text)[1]) });
  const kindOf = (system = '') =>
    /write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : /careful research assistant/.test(system) ? 'research' : /^You write ONE scene/.test(system) ? 'writer' : /^You check frames/.test(system) ? 'check' : 'other';
  const goodHtml = (options) => {
    const duration = durationOf(options.system);
    const { width, height } = sizeOf(options.system);
    const title = /Title: ([^\n]*)/.exec(options.prompt)?.[1] || 'Titel';
    return `<!doctype html>
<html><head><meta charset="utf-8"><script src="${GSAP}"></script><style>body,html{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head>
<body><div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><h1 id="t">${title}</h1>
<script>const tl = gsap.timeline({paused:true}); tl.from('#t',{opacity:0,duration:0.5},0.3); tl.to({}, {duration:0.01}, ${duration - 0.01}); window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl;</script></div></body></html>`;
  };
  patch(llm, 'completeText', async (options) => {
    const kind = kindOf(options.system);
    calls.push({ kind, options: JSON.parse(JSON.stringify({ ...options, onReplaced: undefined })) });
    if (kind === 'plan') {
      const next = answers.plan.shift();
      const value = typeof next === 'function' ? next(options) : next;
      if (value instanceof Error) throw value;
      return { text: JSON.stringify(value || typoAnswer()), usd: USD.plan };
    }
    if (kind === 'research') return answers.research.shift() || { text: 'Types shape how we read [Agency](https://example.org/a).', usd: USD.research, citations: [{ url: 'https://example.org/a', title: 'Agency' }], citationSpans: [] };
    if (kind === 'verify') {
      const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
      return { text: JSON.stringify({ scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) }), usd: USD.verify };
    }
    if (kind === 'check') {
      const next = answers.check.shift();
      return { text: next || '{"ok": true, "blockers": [], "minor": []}', usd: USD.check };
    }
    if (kind === 'writer') {
      const next = answers.writer.shift();
      return { text: typeof next === 'function' ? next(options) : next || goodHtml(options), usd: USD.writer };
    }
    throw new Error(`a model call that the test does not know: ${String(options.system).slice(0, 60)}`);
  });
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });
  patch(discovery, 'brainSupportsFiles', async () => true);
  patch(rendernode, 'enabled', () => true);
  patch(rendernode, 'listConfiguredNodes', () => [{ id: 'rn1', name: 'Render 1', enabled: true }]);
  patch(rendernode, 'submit', async (html, quality, files, format) => {
    renders.push({ html, quality, files, format, jobId: `job-${renders.length + 1}` });
    return { jobId: `job-${renders.length}`, nodeId: 'rn1' };
  });
  const reset = () => {
    calls.length = 0;
    journal.length = 0;
    renders.length = 0;
    eleven.calls.length = 0;
    for (const key of Object.keys(answers)) answers[key].length = 0;
  };

  function makeCtx({ user = STAFF, itemIndex = 0 } = {}) {
    const controller = new AbortController();
    const logs = [];
    const full = { defaultBrain: 'vendor/default-brain', brainModels: ['anthropic/claude-opus-5.5', 'vendor/default-brain'], imageModel: 'openai/gpt-image-2' };
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      itemIndex,
      user,
      config: full,
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId, config: full, user, emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn(),
      logs
    };
  }
  const exec = (type, ctx, inputs, raw = {}) => {
    const def = real.get(type);
    return def.execute(ctx, inputs, real.normalizeParams(def, raw));
  };
  const planWith = async (inputs, raw = {}) => {
    const ctx = makeCtx();
    const result = await exec('explainer.plan', ctx, inputs, raw);
    const variant = result.variants[0];
    return { ctx, result, out: variant, script: JSON.parse(variant.script.value), shots: JSON.parse(variant.shots.value) };
  };
  const text = (value) => textValue(value);

  /* ----- the planner node in the mode typography ----- */

  {
    reset();
    answers.plan.push(typoAnswer((a) => {
      a.scenes[1].kind = 'still';
      a.scenes[1].image_prompt = 'a picture';
      a.scenes[2].kind = 'clip';
      a.scenes[2].clip_prompt = 'a clip';
    }));
    const { ctx, result, out, script, shots } = await planWith({ topic: text('How a typeface changed the century') }, { verify: false, visual_mode: 'typography', language: 'en', length_seconds: 60 });
    assert.deepEqual(calls.map((call) => call.kind), ['plan']);
    assert.match(calls[0].options.system, /Visual mode "typography"/);
    assert.equal(out.image_prompts.items.length, 0, 'no picture prompt: the picture model has nothing to do');
    assert.equal(out.clip_prompts.items.length, 0, 'no clip prompt');
    assert.equal(shots.counts.images, 0);
    assert.equal(shots.counts.clips, 0);
    assert.equal(shots.visual_mode, 'typography');
    assert.ok(out.briefs.items.every((item) => /\nStyle: typography\n/.test(item.value)));
    assert.ok(script.scenes.every((item) => item.kind === 'motion'));
    assert.ok(ctx.logs.some((line) => /2 scenes: still -> motion \(visual_mode_typography\)|1 scene: still -> motion \(visual_mode_typography\)/.test(line)), ctx.logs.join(' | '));
    assert.ok(ctx.logs.some((line) => /6 scenes, about [\d.]+ s, 0 stills, 0 clips/.test(line)), 'the log says it: no stills, no clips');
    near(result.cost.usd, USD.plan, 1e-9, 'only the script is paid');

    // the estimate of the plan is the one of the planner: nothing for pictures or clips is in it
    const estimate = planDef.cost.estimate({ model: '', visual_mode: 'typography', verify: false, script: '' }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: { topic: text('x'.repeat(90)) }, connected: new Set(['topic']) });
    const estimateMix = planDef.cost.estimate({ model: '', visual_mode: 'mix', verify: false, script: '' }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: { topic: text('x'.repeat(90)) }, connected: new Set(['topic']) });
    assert.deepEqual(estimate, estimateMix, 'the same planner, the same price');
  }

  /* ----- the planner node with an own text ----- */

  {
    // the model cuts it as asked: the narrations are the text, the check against sources is not made, the verify call is not paid
    reset();
    const sentences = OWN_TEXT.split(/(?<=[.!?»])\s+/);
    answers.plan.push(ownCut([sentences.slice(0, 2).join(' '), sentences.slice(2, 4).join(' '), sentences.slice(4).join(' ')]));
    const own = await planWith({ own_text: text(OWN_TEXT) }, { visual_mode: 'typography', language: 'auto', verify: true });
    assert.deepEqual(calls.map((call) => call.kind), ['plan'], 'no check pass for the words of the person');
    assert.match(calls[0].options.system, /You do NOT write or change the narration/);
    assert.match(calls[0].options.prompt, /<data kind="narration-text" nonce="[0-9a-f]+">\nMax wohnte in der Strasse am Fluss\./);
    assert.ok(own.ctx.logs.some((line) => /Language: German \(from your own text\)/.test(line)), own.ctx.logs.join(' | '));
    assert.equal(own.script.language, 'de');
    assert.equal(own.script.verbatim, true);
    assert.ok(own.ctx.logs.some((line) => /Own text: the narration is your text word for word, so it is not checked against sources/.test(line)));
    assert.ok(own.ctx.logs.some((line) => /Own text: 3 scenes, your words unchanged/.test(line)));
    const spoken = own.out.narration.items.map((item) => item.value).filter(Boolean);
    assert.deepEqual(tokensOf(spoken.join(' ')), tokensOf(OWN_TEXT));
    assert.match(spoken.join(' '), /Heiß diskutiert/);
    assert.equal(own.script.verified, false);
    near(own.result.cost.usd, USD.plan, 1e-9);

    // the model changes a word: one more try, then the app cuts the text itself
    reset();
    answers.plan.push(ownCut(sentences.map((sentence, index) => (index === 0 ? sentence.replace('Fluss', 'Bach') : sentence))));
    answers.plan.push(ownCut(sentences.map((sentence, index) => (index === 0 ? sentence.replace('Fluss', 'See') : sentence))));
    const changed = await planWith({ own_text: text(OWN_TEXT) }, { visual_mode: 'typography', language: 'de' });
    assert.deepEqual(calls.map((call) => call.kind), ['plan', 'plan'], 'the model is asked once more');
    assert.match(calls[1].options.prompt, /differs from the given text at word/);
    assert.match(calls[1].options.prompt, /Your previous answer:/);
    assert.deepEqual(tokensOf(changed.out.narration.items.map((item) => item.value).join(' ')), tokensOf(OWN_TEXT), 'the narration is the text, whatever the model did');
    assert.ok(changed.ctx.logs.some((line) => /Own text: The narration of the scenes differs from the given text/.test(line)), 'and the person is told');
    assert.ok(changed.ctx.logs.some((line) => /Still 1 problem after the repair/.test(line)));

    // the model changes a word, and the repair is no usable answer at all: the plan of the first answer (cut by the app) is kept, and the
    // person is told about the cut all the same
    reset();
    answers.plan.push(ownCut(sentences.map((sentence, index) => (index === 0 ? sentence.replace('Fluss', 'Bach') : sentence))));
    answers.plan.push('this is not JSON');
    const unusable = await planWith({ own_text: text(OWN_TEXT) }, { visual_mode: 'typography', language: 'de' });
    assert.deepEqual(calls.map((call) => call.kind), ['plan', 'plan']);
    assert.deepEqual(tokensOf(unusable.out.narration.items.map((item) => item.value).join(' ')), tokensOf(OWN_TEXT));
    assert.ok(unusable.ctx.logs.some((line) => /Own text: .*The scenes were cut from your text by the app, your words are unchanged/.test(line)), unusable.ctx.logs.join(' | '));

    // the own text comes with documents: they are sources as before; a topic and a brief go along
    reset();
    answers.plan.push(ownCut(sentences.map((sentence) => sentence)));
    const mixed = await planWith({ own_text: text(OWN_TEXT), topic: text('Fonts'), brief: text('Calm') }, { visual_mode: 'typography', language: 'de', verify: false });
    assert.match(calls[0].options.prompt, /Topic:\nFonts/);
    assert.match(mixed.ctx.logs.join(' '), /Own text/);

    // too long: about 8 minutes of speech is the limit
    reset();
    const long = Array.from({ length: 1400 }, (_x, i) => `Wort${i}`).join(' ');
    const tooLong = await (async () => {
      try {
        await exec('explainer.plan', makeCtx(), { own_text: text(long) }, { language: 'de' });
      } catch (err) {
        return err;
      }
      return null;
    })();
    assert.ok(tooLong && tooLong.code === 'EXPLAINER_TEXT_TOO_LONG', String(tooLong));
    assert.match(tooLong.message, /at most 480 s/);
    assert.equal(calls.length, 0, 'nothing was asked');

    // the edited script (phase two) is checked without the text: the person's changes stand, there is no call and no cost
    reset();
    const edited = JSON.parse(own.out.script.value);
    edited.scenes[0].narration = `${edited.scenes[0].narration} Und noch ein Satz, den die Person selbst eingefügt hat.`;
    const second = await planWith({ own_text: text(OWN_TEXT) }, { visual_mode: 'typography', language: 'de', script: JSON.stringify(edited) });
    assert.equal(calls.length, 0);
    assert.equal(second.result.cost.usd, 0);
    assert.match(second.script.scenes[0].narration, /Und noch ein Satz/);
    assert.equal(second.script.verbatim, true);

    // without an own text, nothing of this applies
    reset();
    const ordinary = await planWith({ topic: text('Fonts') }, { visual_mode: 'typography', language: 'en', verify: false });
    assert.equal(ordinary.script.verbatim, undefined);
    assert.doesNotMatch(calls[0].options.prompt, /narration-text/);
  }

  if (!haveFfmpeg) {
    console.log('ffmpeg not found: the scene node and the runs through the engine are skipped');
    return;
  }

  const workDir = await fsp.mkdtemp(path.join(iso.root, 'explainer-typography-'));
  const media = createMedia({ ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, dir: workDir });
  const standIn = await createAssStandIn(workDir, { real: bins.ffmpeg });
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  restorers.push(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
    ffmpegLib.resetFilterCache();
  });
  process.env.FFMPEG_PATH = standIn.file;
  ffmpegLib.resetFilterCache();

  let rendered = 0;
  const makeVideo = async (entry, forSession) => {
    const duration = durationOf(entry.html);
    const { width, height } = sizeOf(entry.html);
    rendered += 1;
    const file = path.join(store.sessionAssetDir(forSession), `typo-render-${rendered}.mp4`);
    await media.ff(['-f', 'lavfi', '-i', `color=c=0x336699:s=${Math.round(width / 10)}x${Math.round(height / 10)}:r=30`, '-frames:v', String(Math.ceil(duration * 30 - 1e-9)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    return { file, duration };
  };
  patch(jobsLib, 'waitForSessionJob', async (id, jobId, { assetId }) => {
    const entry = renders.find((item) => item.jobId === jobId);
    assert.ok(entry, `a render was submitted for ${jobId}`);
    const made = await makeVideo(entry, id);
    await store.completeAssetFile(id, assetId, made.file, { cost: 0, duration: made.duration, ext: '.mp4', kind: 'video' });
    return [assetId];
  });
  const sceneCtx = () => {
    const ctx = makeCtx();
    ctx.waitForJob = async (job) => {
      const entry = renders.find((item) => item.jobId === job.jobId);
      assert.ok(entry, `a render was submitted for job ${job.jobId}`);
      const made = await makeVideo(entry, sessionId);
      await store.completeAssetFile(sessionId, job.assetId, made.file, { cost: 0, duration: made.duration, ext: '.mp4', kind: 'video' });
      return [job.assetId];
    };
    return ctx;
  };

  /* ----- the scene node in the style ----- */

  {
    reset();
    const built = buildTypo(typoAnswer(), { lengthSeconds: 50 }).script;
    const lists = planLib.outputsOf(built);
    const timingOf = (narration) => {
      const words = narration.split(/\s+/).filter(Boolean).map((word, index) => ({ text: word, start: Math.round((0.3 + index * 0.35) * 1000) / 1000, end: Math.round((0.3 + index * 0.35 + 0.3) * 1000) / 1000 }));
      return textValue(JSON.stringify({ version: 1, source: 'speech', duration: words[words.length - 1].end + 0.1, words, lines: [] }));
    };
    const inputs = (index, extra = {}) => ({ brief: textValue(lists.briefs[index]), timing: timingOf(lists.narration[index]), shots: textValue(JSON.stringify(lists.shots)), ...extra });
    const exec1 = (index, raw = {}, extra = {}) => exec('explainer.scene', sceneCtx(), inputs(index, extra), { vision_check: true, ...raw });

    // without a brand: Inter Tight is embedded, the paper look is told, the words and their times are in the request
    await exec1(1);
    const writer = calls.find((call) => call.kind === 'writer');
    assert.match(writer.options.system, /style "typography" \(kinetic typography/);
    assert.match(writer.options.system, /Headline font: 'Inter Tight', sans-serif \(embedded, use it as it is\)/);
    assert.match(writer.options.system, /ground #e7e0d0/);
    const words = JSON.parse(timingOf(lists.narration[1]).value).words;
    assert.ok(writer.options.prompt.includes(`Words of the voice, in the order they are said, each with the second at which the voice STARTS it (absolute seconds on tl; ${words.length} words): 0.3 ${words[0].text}; 0.65 ${words[1].text};`), writer.options.prompt.slice(0, 600));
    assert.match(writer.options.prompt, /Layout: column/);
    assert.match(writer.options.prompt, /Stress \(huge, accent colour\): /);
    assert.doesNotMatch(writer.options.prompt, /Cue list/);
    const sent = renders[0].html;
    const font = fs.readFileSync(path.join(root, sceneLib.TYPOGRAPHY_FONT.file));
    const rule = /@font-face\{font-family:'Inter Tight';src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\('woff2'\);font-weight:100 900;font-style:normal\}/.exec(sent);
    assert.ok(rule, 'the default font is in the page, with the range of its weights');
    assert.equal(Buffer.from(rule[1], 'base64').equals(font), true);
    assert.equal((sent.match(/@font-face/g) || []).length, 1, 'one font file');
    assert.ok(sent.indexOf('@font-face') > sent.indexOf('Content-Security-Policy'), 'after the policy, as the fonts of a brand');
    assert.match(sent, /font-src 'self' data:/, 'a data URL is allowed for fonts, nothing else');
    // the look at the frames: the rubric of the style, the words said by then
    const check = calls.find((call) => call.kind === 'check');
    assert.match(check.options.system, /^You check frames of a rendered scene in the style "kinetic typography"/);
    assert.match(check.options.prompt, /Words of the voice: frame 1: by [\d.]+ s the voice has said "/);

    // the same scene in the other mode: nothing of the style (a shot list without the mode, a brief without the style line)
    reset();
    const plain = buildTypo(typoAnswer(), { lengthSeconds: 50, visualMode: 'motion' }).script;
    const plainLists = planLib.outputsOf(plain);
    await exec('explainer.scene', sceneCtx(), { brief: textValue(plainLists.briefs[1]), timing: timingOf(plainLists.narration[1]), shots: textValue(JSON.stringify(plainLists.shots)) }, {});
    const ordinary = calls.find((call) => call.kind === 'writer');
    assert.doesNotMatch(ordinary.options.system, /typography/);
    assert.match(ordinary.options.prompt, /Cue list/);
    assert.match(calls.find((call) => call.kind === 'check').options.system, /^You check frames of a rendered explainer scene for layout defects/);
    assert.doesNotMatch(renders[0].html, /Inter Tight/, 'no default font in the other modes');
    assert.equal((renders[0].html.match(/@font-face/g) || []).length, 0);

    // the style is also read from the brief alone (a node used without the shot list)
    reset();
    await exec('explainer.scene', sceneCtx(), { brief: textValue(lists.briefs[1]), timing: timingOf(lists.narration[1]) }, { vision_check: false });
    assert.match(calls.find((call) => call.kind === 'writer').options.system, /style "typography"/);

    // the fixed scene of the style (WP40 part C): not a static title but the spoken words, each at the second the voice starts it; the
    // key words of the plan are large and in the accent colour; the other modes keep the title scene
    reset();
    answers.writer.push('no', 'no', 'no');
    const stood = sceneCtx();
    const standResult = await exec('explainer.scene', stood, inputs(1), {});
    assert.equal(renders.length, 1, 'only the fixed scene is rendered');
    const fixedHtml = renders[0].html;
    const spoken = JSON.parse(timingOf(lists.narration[1]).value).words;
    const second = (value) => `${Math.round(value * 100) / 100}`;
    const escaped = (value) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
    for (const word of spoken) {
      assert.ok(new RegExp(`<span class="w[ k]*" id="w\\d+" data-at="${second(word.start).replace('.', '\\.')}" style="font-size:\\d+px">${escaped(word.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`).test(fixedHtml), `the word "${word.text}" appears at ${second(word.start)} s`);
      assert.ok(fixedHtml.includes(`'#w${spoken.indexOf(word)}',{opacity:0,y:20},{opacity:1,y:0,duration:0.24,ease:'power2.out'},${second(word.start)});`), `the timeline has the word "${word.text}" at its start`);
    }
    const planned = lists.shots.scenes[1].typography.keywords;
    assert.ok(planned.length > 0, 'the plan names key words');
    assert.ok(/class="w k"/.test(fixedHtml), 'the key words are marked');
    assert.ok(!/<h1/.test(fixedHtml), 'no static title');
    assert.equal(sceneLib.checkCode(fixedHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), { format: 'landscape', assets: 0 }).length, 0, 'it passes the check of the code');
    assert.match(fixedHtml, /font-family:'Inter Tight'/, 'the fonts of the style');
    assert.ok(stood.logs.some((line) => /the fixed scene stands in after 3 tries/.test(line)), stood.logs.join(' | '));
    assert.ok(standResult.variants[0].video, 'a video came out');
    // the same node, the other mode: the title scene as ever
    reset();
    const motionLists = planLib.outputsOf(buildTypo(typoAnswer(), { lengthSeconds: 50, visualMode: 'motion' }).script);
    answers.writer.push('no', 'no', 'no');
    await exec('explainer.scene', sceneCtx(), { brief: textValue(motionLists.briefs[1]), timing: timingOf(motionLists.narration[1]), shots: textValue(JSON.stringify(motionLists.shots)) }, {});
    assert.match(renders[0].html, /<h1 id="title">/, 'the title scene stays in the other modes');
    assert.doesNotMatch(renders[0].html, /class="w/);

    // a brand with colours and fonts that have no file: its colours, and the default font for what has no embedded file
    reset();
    const brand = textValue(JSON.stringify({ name: 'Acme', colors: [{ role: 'background', hex: '#101820' }, { role: 'text', hex: '#f2f2f2' }, { role: 'accent', hex: '#ff6b35' }], fonts: [{ role: 'headline', family: 'Acme Display', weights: '700' }, { role: 'body', family: 'Acme Text', weights: '400' }] }));
    await exec1(0, { vision_check: false }, { brand });
    const branded = calls.find((call) => call.kind === 'writer').options.system;
    assert.match(branded, /ground #101820/);
    assert.match(branded, /ONE accent #ff6b35/);
    assert.match(branded, /Headline font: 'Inter Tight'/, 'a family of the brand without an embedded file is not used: no system font');
    assert.match(renders[0].html, /font-family:'Inter Tight'/);

    // a brand with three font files (headline, a mono face, no file for the body family): the mono face does not take the place of the
    // default font, the body is set in the embedded default font, the prompt and the page agree
    reset();
    {
      const brandingsLib = iso.load('lib/brandings');
      const made = await brandingsLib.createBranding({ name: 'Three Faces' });
      await brandingsLib.saveBrandingAsset(made.id, { buffer: Buffer.alloc(900, 1), filename: 'head.woff2' });
      await brandingsLib.saveBrandingAsset(made.id, { buffer: Buffer.alloc(900, 2), filename: 'mono.woff2' });
      const three = textValue(JSON.stringify({
        name: 'Three Faces',
        colors: [{ role: 'background', hex: '#101820' }, { role: 'text', hex: '#f2f2f2' }, { role: 'accent', hex: '#ff6b35' }],
        fonts: [
          { role: 'headline', family: 'Brand Head', weights: '700', asset: { branding: made.id, file: 'head.woff2' } },
          { role: 'mono', family: 'Brand Mono', weights: '400', asset: { branding: made.id, file: 'mono.woff2' } },
          { role: 'body', family: 'Brand Body', weights: '400', asset: null }
        ]
      }));
      await exec1(0, { vision_check: false }, { brand: three });
      const system = calls.find((call) => call.kind === 'writer').options.system;
      const html = renders[0].html;
      assert.match(system, /Headline font: 'Brand Head', sans-serif \(embedded, use it as it is\)/);
      assert.match(system, /Body font: 'Inter Tight', sans-serif \(embedded, use it as it is\)/);
      assert.match(system, /Inter Tight is a variable font/);
      assert.match(html, /font-family:'Brand Head'/);
      assert.match(html, /font-family:'Inter Tight';src:url\(data:font\/woff2;base64,[^)]+\) format\('woff2'\);font-weight:100 900/, 'the default font is in the page');
      assert.doesNotMatch(html, /Brand Mono/, 'a file of a family that is not used is left out');
      assert.equal((html.match(/@font-face/g) || []).length, 2);
    }

    // the sources card is looked at as any scene (it has no words)
    reset();
    const withCard = buildTypo(typoAnswer((a) => a.scenes.forEach((item) => (item.source_refs = ['S. 1']))), { documents: [DOC], lengthSeconds: 50 }).script;
    const cardLists = planLib.outputsOf(withCard);
    const last = cardLists.briefs.length - 1;
    await exec('explainer.scene', sceneCtx(), { brief: textValue(cardLists.briefs[last]), timing: textValue(JSON.stringify(cues.silentTiming(cues.SILENT_SECONDS))), shots: textValue(JSON.stringify(cardLists.shots)) }, {});
    assert.match(calls.find((call) => call.kind === 'writer').options.system, /quiet closing card/);
    assert.match(calls.find((call) => call.kind === 'writer').options.prompt, /Cue list/);
    assert.match(calls.find((call) => call.kind === 'check').options.system, /^You check frames of a rendered explainer scene/);

    // the price of a scene: more code than the other scenes, known once the plan has run
    const sceneDef = real.get('explainer.scene');
    const base = sceneDef.cost.estimate({ model: '', vision_check: true }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: {} });
    const typo = sceneDef.cost.estimate({ model: '', vision_check: true }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: { shots: textValue(JSON.stringify({ visual_mode: 'typography' })) } });
    const mix = sceneDef.cost.estimate({ model: '', vision_check: true }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: { shots: textValue(JSON.stringify({ visual_mode: 'mix' })) } });
    near(base.usd, 0.1, 1e-9);
    assert.deepEqual(mix, base, 'the other modes: the same price as before');
    near(typo.usd, 0.28, 1e-9, 'a typography scene is 0.28 USD (measured in a live test on 2026-10-04, with the look)');
    const typoNoCheck = sceneDef.cost.estimate({ model: '', vision_check: false }, { config: { defaultBrain: 'vendor/default-brain' }, inputs: { shots: textValue(JSON.stringify({ visual_mode: 'typography' })) } });
    near(typoNoCheck.usd, 0.25, 1e-9, 'without the look: 0.03 USD less');

    // the key of the cache: the style is in it, the font of the app is in the stamp (and only for the style)
    const stampTypo = await sceneDef.cacheStamp({}, { inputs: { shots: textValue(JSON.stringify({ visual_mode: 'typography' })) } });
    const hash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, sceneLib.TYPOGRAPHY_FONT.file))).digest('hex');
    assert.deepEqual(stampTypo, { typography: { font: hash } });
    // a scene that is typographic by its brief alone (no shot list) has the stamp too: the same test as when it is drawn
    assert.deepEqual(await sceneDef.cacheStamp({}, { inputs: { brief: textValue(lists.briefs[1]) } }), { typography: { font: hash } }, 'the style of the brief alone');
    assert.equal(await sceneDef.cacheStamp({}, { inputs: { shots: textValue(JSON.stringify({ visual_mode: 'mix' })) } }), undefined, 'the other modes have no stamp, as before');
    assert.equal(await sceneDef.cacheStamp({}, { inputs: {} }), undefined);
  }

  /* ----- the two templates through the engine ----- */

  const all = templates.loadTemplates();
  const byId = Object.fromEntries(all.map((template) => [template.id, template]));
  const IDS = ['typography-video', 'typography-video-text'];
  for (const id of IDS) assert.ok(byId[id], `${id} exists`);
  assert.deepEqual(templates.ORDER.filter((id) => id.startsWith('explainer-') || id.startsWith('typography-')), ['explainer-video', 'explainer-video-topic', 'explainer-video-presenter', 'explainer-script', 'explainer-script-topic', 'typography-video', 'typography-video-text']);
  const types = (template) => template.graph.nodes.map((node) => node.type);
  const wires = (template) => template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  const nodeOf = (template, id) => template.graph.nodes.find((node) => node.id === id);
  for (const id of IDS) {
    const template = byId[id];
    const checked = templates.validateTemplate(template);
    assert.ok(checked.app.enabled && checked.app.inputs.length && checked.app.outputs.length, `${id}: Design App`);
    assert.deepEqual(template.requires, ['openrouter', 'elevenlabs', 'rendernode', 'ffmpeg'], `${id}: no fal.ai, no Poppler`);
    assert.ok(!types(template).includes('image.generate'), `${id}: no picture node`);
    assert.ok(!types(template).some((type) => type.startsWith('fal.')), `${id}: no clip node`);
    assert.equal(templates.usesRestrictedNodes(template.graph), false, `${id}: no restricted node`);
    for (const node of template.graph.nodes) {
      const def = real.get(node.type);
      const params = JSON.parse(JSON.stringify(node.params));
      assert.deepEqual(real.normalizeParams(def, params), params, `${id}.${node.id} (${node.type}): the params are those of the node`);
    }
    const planNode = nodeOf(template, 'n4');
    assert.equal(planNode.type, 'explainer.plan');
    assert.equal(planNode.params.visual_mode, 'typography');
    assert.equal(planNode.params.clips, false);
    assert.equal(planNode.params.script, '', 'the script ships empty: step one is the planner alone');
    assert.equal(planNode.params.verify, true);
    assert.equal(planNode.params.language, 'auto');
    assert.equal(planNode.params.model, '');
    assert.equal(nodeOf(template, 'n8').params.format, planNode.params.format, 'the same format in the planner and the scenes');
    assert.equal(nodeOf(template, 'n8').params.vision_check, true);
    const wired = wires(template);
    for (const wire of ['n4.narration>n5.narration', 'n4.narration_context>n5.context', 'n4.briefs>n8.brief', 'n5.timing>n8.timing', 'n4.shots>n8.shots', 'n8.video>n9.scenes', 'n5.audio>n9.audio', 'n5.timing>n9.timing', 'n4.shots>n9.shots', 'n3.brand>n4.brand', 'n3.brand>n8.brand', 'n3.voice>n5.voice', 'n14.audio>n9.music']) assert.ok(wired.includes(wire), `${id} has ${wire}`);
    assert.ok(!wired.includes('n3.logo>n8.logo'), `${id}: the logo is left out so that the workflow runs with the neutral profile`);
    assert.equal(nodeOf(template, 'n14').params.instrumental, true);
    assert.equal(nodeOf(template, 'n14').params.length, 90, 'the music is as long as the default film');
    assert.match(template.description, /No pictures and no clips are made, so nothing is paid for them/);
    assert.match(template.description, /Run the planner first/);
    assert.match(template.description, /Inter Tight/);
    assert.match(template.graph.notes[0].text, /Inter Tight \(SIL Open Font License\)/);
    assert.match(template.graph.notes[0].text, /Edited script/);
    assert.match(template.graph.notes[0].text, /Logo/);
  }
  const topicT = byId['typography-video'];
  const textT = byId['typography-video-text'];
  assert.equal(nodeOf(topicT, 'n4').params.length_seconds, 90);
  for (const wire of ['n1.prompt>n2.topic', 'n2.notes>n4.notes', 'n2.sources>n4.sources', 'n1.prompt>n4.topic', 'n6.prompt>n4.brief']) assert.ok(wires(topicT).includes(wire), `the topic version has ${wire}`);
  assert.ok(!wires(topicT).some((wire) => wire.endsWith('>n4.own_text')), 'the topic version has no own text');
  // the own text version: no research, no sources, the text goes to the input "own_text"
  assert.ok(!types(textT).includes('llm.research'));
  assert.ok(wires(textT).includes('n1.prompt>n4.own_text'));
  assert.ok(!wires(textT).some((wire) => wire.endsWith('>n4.topic') || wire.endsWith('>n4.notes') || wire.endsWith('>n4.sources')));
  assert.equal(nodeOf(textT, 'n4').params.topic, '');
  // no subtitles in the app view (the words are the picture): no field "captions", no output "Subtitles"
  assert.deepEqual(textT.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n6.prompt', 'n3.branding', 'n4.language', 'n5.voice_id']);
  assert.deepEqual(textT.app.outputs.map((entry) => entry.node), ['n10', 'n12']);
  assert.deepEqual(topicT.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n6.prompt', 'n3.branding', 'n4.language', 'n2.language', 'n4.length_seconds', 'n5.voice_id']);
  assert.deepEqual(topicT.app.outputs.map((entry) => entry.node), ['n10', 'n12', 'n13']);
  for (const template of [topicT, textT]) {
    assert.equal(nodeOf(template, 'n9').params.captions, 'off', 'the cut burns no captions in');
    assert.ok(!template.graph.nodes.some((node) => node.id === 'n11'), 'no output node for subtitles');
    assert.ok(!template.graph.edges.some((edge) => edge.from.port === 'subtitles' || edge.to.node === 'n11'), 'and no edge to it');
    assert.ok(!template.graph.nodes.some((node) => node.type === 'output.result' && /subtitle/i.test(node.params.label)), 'no output labelled Subtitles');
    assert.ok(!template.app.inputs.some((entry) => entry.param === 'captions') && !template.app.outputs.some((entry) => entry.node === 'n11'));
    for (const lang of ['de', 'es']) {
      const keys = Object.keys(template.i18n[lang]);
      assert.ok(!keys.includes('app.input.n9.captions') && !keys.includes('app.output.n11'), `${lang}: no label left for the removed field and output`);
      // every label the app view needs is there in the language
      for (const entry of template.app.inputs) assert.ok(template.i18n[lang][`app.input.${entry.node}.${entry.param}`], `${lang}: input ${entry.node}.${entry.param}`);
      for (const entry of template.app.outputs) assert.ok(template.i18n[lang][`app.output.${entry.node}`], `${lang}: output ${entry.node}`);
    }
    // no text promises subtitles or a subtitle file any more; each language says there are none
    const promised = { en: /captions and a subtitle file|, captions|subtitle file|SRT/i, de: /Untertiteln und SRT|Untertitel und eine SRT|SRT-Datei/, es: /subtítulos y un archivo SRT|archivo SRT/ };
    const said = { en: /no subtitles|without subtitles/i, de: /keine Untertitel|ohne Untertitel/, es: /no hay subtítulos|sin subtítulos/i };
    for (const lang of ['en', 'de', 'es']) {
      const doc = templates.resolveTemplate(template.id, { lang });
      for (const text of [doc.description, doc.app.description, doc.graph.notes[0].text]) assert.doesNotMatch(text, promised[lang], `${template.id}.${lang}: promises no subtitle file`);
      assert.match(doc.description, said[lang]);
      assert.match(doc.app.description, said[lang]);
      assert.match(doc.graph.notes[0].text, said[lang]);
    }
  }
  // the existing templates are as they were: the same ids in the same order, no new param in any of them
  for (const id of ['explainer-video', 'explainer-video-topic', 'explainer-video-presenter', 'explainer-script', 'explainer-script-topic']) {
    const old = byId[id];
    assert.ok(old, id);
    assert.ok(!JSON.stringify(old).includes('typography'), `${id} knows nothing of the style`);
    assert.ok(!wires(old).some((wire) => wire.endsWith('.own_text')), `${id}: no own text`);
    assert.equal(old.graph.nodes.find((node) => node.type === 'explainer.plan').params.visual_mode, 'mix');
  }
  // texts in the three languages, Swiss spelling, the named costs
  const resolved = (id, lang) => templates.resolveTemplate(id, { lang });
  const NAMES = {
    'typography-video': ['Typography video for a topic', 'Typografie-Video zu einem Thema', /^Vídeo tipográfico sobre un tema/],
    'typography-video-text': ['Typography video from your own text', 'Typografie-Video aus eigenem Text', /^Vídeo tipográfico con tu propio texto/]
  };
  for (const id of IDS) {
    assert.equal(resolved(id, 'en').name, NAMES[id][0]);
    assert.equal(resolved(id, 'de').name, NAMES[id][1]);
    assert.match(resolved(id, 'es').name, NAMES[id][2]);
    for (const lang of ['en', 'de', 'es']) {
      const doc = resolved(id, lang);
      assert.match(doc.graph.notes[0].text, lang === 'de' ? /Skript \(bearbeitet\)/ : lang === 'es' ? /Guion \(editado\)/ : /Edited script/);
      assert.match(doc.description, lang === 'de' ? /Starte zuerst nur den Planer/ : lang === 'es' ? /Ejecuta primero solo el planificador/ : /Run the planner first/);
      assert.match(doc.description, lang === 'de' ? /Bestätigung/ : lang === 'es' ? /confirmes/ : /confirmation/);
      assert.match(doc.description, lang === 'de' ? /keine Bilder und keine Clips/ : lang === 'es' ? /No se crean imágenes ni clips/ : /No pictures and no clips/);
      assert.match(doc.description, /Inter Tight/);
      assert.match(doc.description, lang === 'de' ? /Etwa (3\.80 bis 4|3\.70) US-Dollar für 90 Sekunden.*Schätzung aus einem Testlauf/ : lang === 'es' ? /Unos (3,80 a 4|3,70) dólares para 90 segundos.*estimación de una ejecución de prueba/ : /About (3\.80 to 4|3\.70) US dollars for 90 seconds.*an estimate from one test run/);
      assert.equal(doc.graph.nodes.find((node) => node.id === 'n4').params.language, 'auto');
      for (const text of [doc.name, doc.description, doc.app.title, doc.app.description, doc.graph.notes[0].text, ...doc.graph.nodes.map((node) => node.title || ''), ...doc.graph.nodes.map((node) => node.params.prompt || '')]) assert.equal(String(text).includes('ß'), false, `${id}.${lang}: no sharp s`);
    }
    assert.notEqual(resolved(id, 'de').description, resolved(id, 'en').description);
    assert.notEqual(resolved(id, 'es').description, resolved(id, 'en').description);
  }
  // the sample texts are translated, and the sample text of the own text version is a text to be spoken
  assert.notEqual(resolved('typography-video-text', 'de').graph.nodes[0].params.prompt, textT.graph.nodes[0].params.prompt);
  assert.match(resolved('typography-video-text', 'de').graph.nodes[0].params.prompt, /Jedes Wort zählt\./);
  assert.ok(planLib.secondsFor(textT.graph.nodes[0].params.prompt, 'en') > 20 && planLib.secondsFor(textT.graph.nodes[0].params.prompt, 'en') < 90);
  // the gallery
  const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
  const listed = Object.fromEntries(templates.listTemplates({ lang: 'de', checks: allOn }).map((item) => [item.id, item]));
  for (const id of IDS) {
    assert.equal(listed[id].available, true);
    assert.equal(listed[id].cost.kind, 'partial', `${id}: only the music is priced beforehand`);
    assert.equal(listed[id].cost.usd, 0.3, `${id}: 90 s of music at 0.20 USD a minute`);
    assert.deepEqual(listed[id].requires, ['openrouter', 'elevenlabs', 'rendernode', 'ffmpeg']);
  }
  const noFal = Object.fromEntries(templates.listTemplates({ lang: 'en', checks: { ...allOn, fal: () => 'FAL_KEY is not set' } }).map((item) => [item.id, item]));
  for (const id of IDS) assert.equal(noFal[id].available, true, `${id} runs without fal.ai`);
  const noKey = Object.fromEntries(templates.listTemplates({ lang: 'en', checks: { ...allOn, elevenlabs: () => 'ELEVENLABS_API_KEY is not set' } }).map((item) => [item.id, item]));
  for (const id of IDS) assert.deepEqual(noKey[id].missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);

  // the engine: the real nodes, a stand-in for the picture node (it must never be asked in these templates), the music and the render node
  const imageDef = real.get('image.generate');
  const pictures = [];
  const musicCalls = [];
  const musicDef = real.get('audio.music');
  const registry = nodeRegistry.createRegistry();
  for (const type of real.list().map((def) => def.type)) {
    if (type === 'image.generate') {
      registry.register({
        ...imageDef,
        available: () => true,
        prepare: undefined,
        execute: async (ctx, inputs) => {
          pictures.push(inputs.prompt.value);
          return { variants: [], cost: { usd: 0.04 } };
        }
      });
    } else if (type === 'audio.music') {
      registry.register({
        ...musicDef,
        available: () => true,
        prepare: undefined,
        execute: async (ctx, inputs, params) => {
          const scratch = await assets.createScratchDir(ctx.sessionId);
          const file = path.join(scratch, 'music.wav');
          await fsp.writeFile(file, toneWav(params.length, 220, { amplitude: 0.5 }));
          const value = await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: file, prompt: inputs.prompt.value, cost: tools.musicEstimateUsd(params.length * 1000), duration: params.length });
          await assets.removeScratchDir(scratch);
          musicCalls.push({ prompt: inputs.prompt.value, length: params.length, instrumental: params.instrumental });
          return { variants: [{ audio: value }], cost: { usd: tools.musicEstimateUsd(params.length * 1000) } };
        }
      });
    } else registry.register(real.get(type));
  }
  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-typography'), registry, events: bus });
  const engine = createEngine({ store: flowStore, registry, events: bus, getConfig: () => ({ imageModel: 'openai/gpt-image-2', defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] }), limits: { jobPollMs: 20 } });
  const resultOf = async (workflowId, nodeId) => (await flowStore.readResults(workflowId)).nodes[nodeId].history[0];
  const writerCalls = () => calls.filter((call) => call.kind === 'writer');
  const sceneNumber = (call) => Number(/Scene s(\d+)/.exec(call.options.prompt)[1]);

  /* ----- the topic version: the planner alone, then everything ----- */
  {
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('typography-video', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const id = created.id;
    const graph = JSON.parse(JSON.stringify(created.graph));
    Object.assign(graph.nodes.find((node) => node.id === 'n9').params, { resolution: '720p', fps: '30' });
    await flowStore.saveGraph(id, { baseRev: created.rev, graph });
    const plan0 = await engine.plan(id, { mode: 'all', user: STAFF });
    assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
    assert.equal(plan0.nodes.n5.estimate, null, 'the voice has no price before the script is known');

    reset();
    answers.plan.push(typoAnswer());
    const first = await engine.start(id, { mode: 'node', nodeIds: ['n4'], user: STAFF });
    const firstRecord = await engine.whenFinished(id, first);
    assert.equal(firstRecord.status, 'completed', JSON.stringify(firstRecord.nodes).slice(0, 600));
    assert.deepEqual(calls.map((call) => call.kind), ['research', 'plan', 'verify'], 'research, script and check, nothing more');
    assert.equal(renders.length, 0);
    assert.equal(eleven.calls.length, 0);
    assert.equal(pictures.length, 0);
    const planResult = await resultOf(id, 'n4');
    const script = JSON.parse(planResult.variants[0].script.value);
    assert.equal(script.visual_mode, 'typography');
    assert.equal(script.scenes.length, 6);
    assert.equal(planResult.variants[0].image_prompts.items.length, 0);
    assert.equal(planResult.variants[0].clip_prompts.items.length, 0);
    assert.match(calls[1].options.system, /Visual mode "typography"/);

    // everything: the edited script is only checked; every scene is drawn as typography with ITS words; no picture, no clip, no cost for them
    script.scenes[0].typography.layout = 'blocks';
    reset();
    const runId = await engine.start(id, { mode: 'all', user: STAFF, overrides: { n4: { script: JSON.stringify(script) } } });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    assert.deepEqual(calls.filter((call) => ['research', 'plan', 'verify'].includes(call.kind)), []);
    assert.equal(writerCalls().length, 6);
    assert.equal(renders.length, 6);
    assert.equal(pictures.length, 0, 'the picture model was never asked');
    assert.ok(!(await flowStore.readResults(id)).nodes.n7, 'there is no picture node in the template');
    assert.equal(eleven.calls.length, 6);
    const planned = JSON.parse((await resultOf(id, 'n4')).variants[0].script.value);
    const byScene = new Map(writerCalls().map((call) => [sceneNumber(call), call]));
    for (let k = 1; k <= 6; k += 1) {
      const call = byScene.get(k);
      assert.ok(call, `scene ${k} was written`);
      assert.match(call.options.system, /style "typography"/);
      assert.match(call.options.prompt, /\nStyle: typography\n/);
      assert.match(call.options.prompt, new RegExp(`Layout: ${planned.scenes[k - 1].typography.layout}`));
      // every word of the narration of THIS scene is in the request, with a time
      const line = /\(absolute seconds on tl; (\d+) words\): ([^\n]*)\./.exec(call.options.prompt);
      assert.ok(line, `scene ${k}: the words are in the request`);
      assert.equal(Number(line[1]), planned.scenes[k - 1].narration.split(/\s+/).length);
      assert.equal(line[2].split('; ')[0].split(' ').slice(1).join(' '), planned.scenes[k - 1].narration.split(/\s+/)[0]);
      assert.ok(!/@font-face\{font-family:'Inter Tight'/.test(call.options.system), 'the font is for the page, not for the prompt');
    }
    assert.match(byScene.get(1).options.prompt, /Layout: blocks/, 'the edited layout is the one that is drawn');
    for (const entry of renders) {
      assert.equal((entry.html.match(/@font-face\{font-family:'Inter Tight'[^}]*font-weight:100 900/g) || []).length, 1, 'every page has the font once');
      assert.deepEqual(entry.files, { files: [], totalBytes: 0 }, 'no picture is attached to any scene');
    }
    const final = (await resultOf(id, 'n9')).variants[0];
    const info = await media.probe(assets.assetFilePath(final.video));
    assert.deepEqual([info.width, info.height], [1280, 720]);
    assert.equal(info.hasAudio, true);
    assert.match(final.subtitles.value, /^1\n\d\d:\d\d:\d\d,\d\d\d --> /);
    // the money: the script, the voices, the scenes, the music (90 s); nothing for pictures or clips
    assert.equal(musicCalls.length, 1);
    assert.equal(musicCalls[0].length, 90);
    near((await resultOf(id, 'n14')).cost.usd, 0.3, 1e-9);
    assert.equal(journal.filter((entry) => /image|picture|fal|clip/i.test(String(entry.type))).length, 0, 'no picture or clip is booked');
    const sceneCost = (await resultOf(id, 'n8')).cost;
    near(sceneCost.usd, 6 * (USD.writer + USD.check), 1e-9);
    // the plan after the run: a scene costs 0.28 once the shot list says typography
    const priced = await engine.plan(id, { mode: 'all', user: STAFF, overrides: { n8: { quality: 'high' } } });
    assert.equal(priced.valid, true, JSON.stringify(priced.issues));
    assert.equal(priced.nodes.n8.executions, 6);
    near(priced.nodes.n8.estimate.usd, 0.28, 1e-9, '0.28 USD per scene in the style');
    assert.deepEqual(await fsp.readdir(store.sessionAssetDir(created.sessionId)).then((names) => names.filter((name) => name.startsWith('.nodes-'))), [], 'no scratch folder is left');
  }

  /* ----- the own text version ----- */
  {
    reset();
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('typography-video-text', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const id = created.id;
    const graph = JSON.parse(JSON.stringify(created.graph));
    Object.assign(graph.nodes.find((node) => node.id === 'n9').params, { resolution: '720p', fps: '30' });
    graph.nodes.find((node) => node.id === 'n1').params.prompt = OWN_TEXT;
    await flowStore.saveGraph(id, { baseRev: created.rev, graph });
    const plan0 = await engine.plan(id, { mode: 'all', user: STAFF });
    assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
    const sentences = OWN_TEXT.split(/(?<=[.!?»])\s+/);
    answers.plan.push(ownCut([sentences.slice(0, 2).join(' '), sentences.slice(2, 4).join(' '), sentences.slice(4).join(' ')]));
    const first = await engine.start(id, { mode: 'node', nodeIds: ['n4'], user: STAFF });
    const firstRecord = await engine.whenFinished(id, first);
    assert.equal(firstRecord.status, 'completed', JSON.stringify(firstRecord.nodes).slice(0, 600));
    assert.deepEqual(calls.map((call) => call.kind), ['plan'], 'only the planner: no research, no check');
    const script = JSON.parse((await resultOf(id, 'n4')).variants[0].script.value);
    assert.equal(script.language, 'de', 'the language follows the text');
    assert.equal(script.verbatim, true);
    // the voices speak the words of the person, and nothing else
    reset();
    const runId = await engine.start(id, { mode: 'all', user: STAFF, overrides: { n4: { script: JSON.stringify(script) } } });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    assert.deepEqual(calls.filter((call) => ['research', 'plan', 'verify'].includes(call.kind)), []);
    assert.equal(eleven.calls.length, 3);
    const spoken = eleven.calls.map((call) => call.body.text);
    assert.deepEqual(tokensOf(spoken.join(' ')), tokensOf(OWN_TEXT), 'the voice says the text of the person, word for word');
    assert.match(spoken.join(' '), /Heiß diskutiert/, 'with the sharp s the person wrote');
    assert.equal(writerCalls().length, 3);
    assert.equal(pictures.length, 0);
    const final = (await resultOf(id, 'n9')).variants[0];
    assert.equal((await media.probe(assets.assetFilePath(final.video))).hasAudio, true);
    assert.equal(JSON.parse((await resultOf(id, 'n12')).variants[0].result.items[0].value).verbatim, true);
  }

  await fsp.rm(path.join(iso.root, 'data', 'workflows-typography'), { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
