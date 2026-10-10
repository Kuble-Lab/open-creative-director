'use strict';

// The style and the music of the event video (WP53, package B): lib/event-video/styles.js and the nodes event_video.style and event_video.music of
// lib/nodes/nodes-event-video.js. No network, nothing paid: ElevenLabs is replaced where the music node would call it.
//   tables      every event type x mood x length (and the alias festival) gives a style that passes contract.checkStyle, within the limits of the table
//   examples    the examples of the specification (party x fast: eq contrast 1.24; corporate x fresh: the fixture style-corporate-fresh.json)
//   derive      bpm, cuts per minute, the beat step, the shortest shot, the zoom, the eq, tint and glow, the title, the soundbites by length
//   music       the prompt of the music: genre, BPM range, seconds, the energy, never an artist; the node: own music, too short, made by ElevenLabs
//   style node  the outputs, a bad value, the outputs said before the run, and a new format that does not change the style

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const contract = require('../lib/event-video/contract');
const styles = require('../lib/event-video/styles');

const SUPPORT = path.join(__dirname, 'support', 'event-video');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SUPPORT, name), 'utf8'));
const near = (actual, expected, tolerance = 1e-9, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected}`.trim());

/* ---------- every combination ---------- */

function testTables() {
  let count = 0;
  for (const eventType of [...contract.EVENT_TYPES, 'festival']) {
    for (const mood of contract.MOODS) {
      for (const length of contract.LENGTHS) {
        const style = styles.combineStyle({ event_type: eventType, mood, length, language: 'de' });
        const check = contract.checkStyle(style);
        assert.deepEqual(check.problems, [], `${eventType} x ${mood} x ${length}`);
        const type = contract.readEventType(eventType).type;
        const table = styles.EVENTS[type];
        for (const key of contract.STYLE_VALUES) {
          const row = table[key];
          const [low, high] = Array.isArray(row) ? [row[1], row[2]] : [0, 1];
          assert.ok(style.values[key] >= low - 1e-9 && style.values[key] <= high + 1e-9, `${eventType} x ${mood}: ${key} ${style.values[key]} outside ${low}..${high}`);
        }
        const sum = Object.values(style.transitions).reduce((total, weight) => total + weight, 0);
        assert.ok(style.transitions.cut >= sum / 2, `${eventType} x ${mood}: hard cuts at least half`);
        assert.equal(style.format, undefined, 'the style has no format');
        assert.equal(style.length, length);
        // the derived values stay in their ranges
        const derived = styles.derive(style);
        assert.ok(derived.bpm >= 70 && derived.bpm <= 140);
        assert.ok(derived.minShot >= 0.6 && derived.minShot <= 2.4);
        assert.ok(derived.titleSeconds >= 0.5 && derived.titleSeconds <= 1.5);
        assert.ok(derived.tint >= contract.TINT_RANGE[0] && derived.tint <= contract.TINT_RANGE[1]);
        assert.ok(derived.glow >= contract.GLOW_RANGE[0] && derived.glow <= contract.GLOW_RANGE[1]);
        assert.ok(derived.zoomRate > 0 && derived.zoomRate <= contract.MAX_PHOTO_RATE);
        assert.ok([1, 2, 4].includes(derived.beatStep));
        count += 1;
      }
    }
  }
  assert.equal(count, 7 * 6 * 3);
}

/* ---------- the examples of the specification ---------- */

function testExamples() {
  // the fixture of the contract is what the node writes for corporate x fresh, 60 s, German
  assert.deepEqual(styles.combineStyle({ event_type: 'corporate', mood: 'fresh', length: 60, language: 'de' }), load('style-corporate-fresh.json'));
  // party x fast: eq contrast 0.9 + 0.4 x 0.85 = 1.24 (spec §8 B)
  const party = styles.derive(styles.combineStyle({ event_type: 'party', mood: 'fast' }));
  near(party.eq.contrast, 1.24, 1e-9, 'party x fast contrast');
  assert.equal(party.bpm, 140);
  assert.equal(party.beatStep, 1);
  assert.equal(party.halfBeatsInPeak, true);
  assert.equal(party.noise, 5);
  // conference x calm: tempo 0.4 - 0.25 = 0.15 is below the lower limit of a conference (0.2), so the style holds 0.2 and the music 84 BPM. The example of the
  // specification (80 BPM) leaves the limit out; the formula of spec §5 with its limits gives 84.
  const calm = styles.combineStyle({ event_type: 'conference', mood: 'calm' });
  assert.equal(calm.values.tempo, 0.2);
  assert.equal(calm.values.density, 0.2);
  assert.equal(styles.derive(calm).bpm, 84);
  assert.equal(styles.derive(calm).beatStep, 4);
  // the transitions of the event type that the mood weighs; none in common: cut and dip
  assert.deepEqual(calm.transitions, { cut: 5, dip: 4, match: 1 });
  assert.deepEqual(styles.combineTransitions('workshop', 'epic'), { cut: 5, dip: 2 });
  assert.deepEqual(styles.combineTransitions('party', 'calm'), { cut: 4 });
  // festival: party, warmth and grain 0.1 higher
  const party60 = styles.combineStyle({ event_type: 'party', mood: 'fresh' });
  const festival = styles.combineStyle({ event_type: 'festival', mood: 'fresh' });
  assert.equal(festival.event_type, 'party');
  assert.equal(festival.event_alias, 'festival');
  near(festival.values.warmth, party60.values.warmth + 0.1, 1e-9);
  near(festival.values.grain, party60.values.grain + 0.1, 1e-9);
  // the title font: the one of the mood, else the one of the event type
  assert.equal(styles.combineStyle({ event_type: 'corporate', mood: 'epic' }).type.title, 'Anton:400');
  assert.equal(styles.combineStyle({ event_type: 'corporate', mood: 'calm' }).type.title, 'Montserrat:700');
  assert.equal(styles.combineStyle({ event_type: 'workshop', mood: 'fresh' }).type.body, 'DM Sans:400');
}

function testDerive() {
  const style = load('style-corporate-fresh.json');
  const derived = styles.derive(style);
  assert.equal(derived.bpm, 109);
  assert.deepEqual(derived.bpmRange, [103, 115]);
  assert.equal(derived.cpm, 36);
  assert.equal(derived.actCpm.peak, 54);
  assert.equal(derived.actCpm.close, 18);
  assert.equal(derived.beatStep, 2);
  assert.equal(derived.minShot, 1.5);
  assert.equal(derived.zoomRate, 0.084);
  assert.deepEqual(derived.eq, { contrast: 1.12, saturation: 1.12, gamma: 0.995 });
  assert.equal(derived.exposure(0.42), 0.015);
  assert.equal(derived.exposure(0.05), 0.08);
  assert.equal(derived.exposure(0.9), -0.08);
  assert.equal(derived.tint, -0.015);
  assert.equal(derived.tintColor, styles.TINT_COOL);
  assert.equal(derived.glow, 0);
  assert.equal(derived.titleSeconds, 0.97);
  assert.equal(derived.ease, 'power3.out');
  assert.equal(derived.vignette, 'PI/6.35');
  assert.deepEqual(derived.mix, { duck_db: -12, ramp: 0.3, lufs: -16, nat_level: 0.12 });
  // a party: back.out below a formality of 0.5, a warm tint and the light spot above a glow of 0.5
  const party = styles.derive(styles.combineStyle({ event_type: 'party', mood: 'fresh' }));
  assert.equal(party.ease, 'back.out(1.4)');
  assert.equal(party.tintColor, styles.TINT_WARM);
  near(party.glow, 0.22 * 0.8, 1e-9);
  // the soundbites by length (spec §5a): 30 s at most one (party none), 90 s the upper end plus one, seconds within 2..12
  assert.deepEqual(styles.soundbitesFor('conference', 30), { count: [1, 1], seconds: [5, 8] });
  assert.deepEqual(styles.soundbitesFor('conference', 60), { count: [2, 3], seconds: [5, 8] });
  assert.deepEqual(styles.soundbitesFor('conference', 90), { count: [2, 4], seconds: [5, 8] });
  assert.deepEqual(styles.soundbitesFor('party', 30), { count: [0, 0], seconds: [2, 3] });
  assert.deepEqual(styles.soundbitesFor('party', 90), { count: [0, 2], seconds: [2, 3] });
  // the reader of the app values
  for (const [field, raw] of [['event_type', { event_type: 'wedding' }], ['mood', { mood: 'sad' }], ['length', { length: 45 }], ['format', { format: '4:3' }], ['language', { language: 'fr' }]]) {
    assert.throws(() => styles.readChoice(raw), (err) => err.code === 'EVENTSTYLE_BAD_VALUE' && err.data.field === field, field);
  }
  assert.deepEqual(styles.readChoice({}), { eventType: 'conference', alias: null, shift: null, mood: 'fresh', length: 60, format: '16:9', language: 'de' });
  assert.equal(styles.readChoice({ length: '90', event_type: ' Party ' }).length, 90);
}

/* ---------- the music ---------- */

// Words that may stand in the prompt: those of the genre tables and of the template; a name of an artist or a song would be none of them.
function allowedWords() {
  const words = new Set();
  const add = (text) => String(text).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean).forEach((word) => words.add(word));
  for (const event of Object.values(styles.EVENTS)) add(event.genre);
  for (const mood of Object.values(styles.MOOD_TABLE)) add(mood.genre);
  add('Instrumental, to BPM, seconds. Starts almost silent soft light, Opens on the beat, builds fast steadily, grows slowly, peaks at about percent, fades over the last resolves calmly in the last seconds. Clean ending, no vocals, no lyrics, no artist references.');
  return words;
}

function testMusicPrompt() {
  const words = allowedWords();
  const ARTISTS = /\b(daft punk|coldplay|hans zimmer|avicii|beyonc|taylor swift|in the style of|like [A-Z])/i;
  for (const eventType of [...contract.EVENT_TYPES, 'festival']) {
    for (const mood of contract.MOODS) {
      for (const length of contract.LENGTHS) {
        const style = styles.combineStyle({ event_type: eventType, mood, length });
        const prompt = styles.musicPrompt(style);
        const { bpmRange } = styles.derive(style);
        assert.ok(prompt.includes(`Instrumental, ${bpmRange[0]} to ${bpmRange[1]} BPM, ${length + 2} seconds.`), prompt);
        assert.ok(prompt.endsWith('Clean ending, no vocals, no lyrics, no artist references.'), prompt);
        assert.ok(!ARTISTS.test(prompt), prompt);
        for (const word of prompt.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)) {
          assert.ok(words.has(word) || /^\d+$/.test(word), `${eventType} x ${mood}: «${word}» is not a word of the tables: ${prompt}`);
        }
      }
    }
  }
  assert.equal(
    styles.musicPrompt(load('style-corporate-fresh.json')),
    'Modern corporate, clean electronic pop, piano and soft synth pads, light percussion, bright, uplifting, light and airy, major key. Instrumental, 103 to 115 BPM, 62 seconds. ' +
      'Starts light, builds fast, peaks at about 70 percent, resolves calmly in the last 8 seconds. Clean ending, no vocals, no lyrics, no artist references.'
  );
  assert.match(styles.musicPrompt(styles.combineStyle({ event_type: 'conference', mood: 'calm' })), /Starts almost silent, builds steadily, peaks at about 70 percent, fades over the last 8 seconds\./);
  // the block of the system prompt: a sentence for every axis
  const block = styles.styleBlock(load('style-corporate-fresh.json'));
  assert.match(block, /^The event is corporate: .*\. The mood is fresh: .*\.$/);
}

/* ---------- the nodes ---------- */

async function testNodes() {
  const registry = require('../lib/nodes/registry');
  const nodes = require('../lib/nodes/nodes-event-video');
  const { textValue } = require('../lib/nodes/types');
  const own = registry.createRegistry();
  nodes.registerAll(own);
  const style = own.get('event_video.style');
  const music = own.get('event_video.music');
  const plan = own.get('event_video.plan');
  assert.ok(style && music && plan);

  // the style node: its outputs, the same style for every format (the key of the music and the plan does not change), the outputs before the run
  const run = async (params) => (await style.execute({}, {}, registry.normalizeParams(style, params))).variants[0];
  const wide = await run({ event_type: 'corporate', mood: 'fresh', length: '60', format: '16:9', language: 'de' });
  assert.deepEqual(JSON.parse(wide.style.value), load('style-corporate-fresh.json'));
  assert.equal(wide.format.value, '16:9');
  for (const format of ['9:16', '1:1']) {
    const other = await run({ event_type: 'corporate', mood: 'fresh', length: '60', format, language: 'de' });
    assert.equal(other.style.value, wide.style.value, `format ${format} changes the style`);
    assert.equal(other.format.value, format);
  }
  const predicted = await style.cacheStampOutputs(await style.cacheStamp({}), { params: registry.normalizeParams(style, { format: '9:16' }) });
  assert.deepEqual(predicted, { outputs: await run({ format: '9:16' }), unknown: [] });
  assert.deepEqual(style.validate(registry.normalizeParams(style, {})), []);
  const bad = style.validate({ ...registry.normalizeParams(style, {}), mood: 'grumpy' });
  assert.equal(bad[0].code, 'EVENTSTYLE_BAD_VALUE');
  assert.deepEqual(registry.checkParams(style, registry.normalizeParams(style, { event_type: 'festival' })), []);
  // neither the music nor the plan knows the format
  for (const def of [music, plan]) {
    assert.ok(!def.inputs.some((port) => port.id === 'format'), `${def.type} has an input format`);
    assert.ok(!def.params.some((param) => param.id === 'format'), `${def.type} has a parameter format`);
  }

  // the music node: the estimate
  const styleInput = textValue(wide.style.value);
  near(music.cost.estimate({}, { inputs: { style: styleInput } }).usd, (62 / 60) * 0.2, 1e-6, 'music of 62 s');
  near(music.cost.estimate({}, { inputs: {} }).usd, (92 / 60) * 0.2, 1e-6, 'unknown style: the longest');
  assert.deepEqual(music.cost.estimate({}, { inputs: { style: styleInput, own: { type: 'list', of: 'audio', items: [{ type: 'audio' }] } } }), { usd: 0 });

  // own music: passed on, too short is EVENTMUSIC_TOO_SHORT
  const logs = [];
  const ctx = { log: (line) => logs.push(line), withLocalSlot: (fn) => fn(), signal: null, toolCtx: {} };
  const ownValue = (duration) => ({ type: 'list', of: 'audio', items: [{ type: 'audio', sessionId: 's', assetId: 'a', file: 'a.mp3', duration }] });
  const passed = await music.execute(ctx, { style: styleInput, own: ownValue(75) }, registry.normalizeParams(music, {}));
  assert.equal(passed.variants[0].audio.assetId, 'a');
  assert.deepEqual(passed.cost, { usd: 0 });
  const shorter = await music.execute(ctx, { style: styleInput, own: ownValue(41) }, registry.normalizeParams(music, {}));
  assert.equal(shorter.variants[0].prompt.value, 'own music, 41 s');
  assert.match(logs[logs.length - 1], /the film will be 39 s instead of 60 s/);
  await assert.rejects(music.execute(ctx, { style: styleInput, own: ownValue(12) }, registry.normalizeParams(music, {})), (err) => err.code === 'EVENTMUSIC_TOO_SHORT' && err.data.min === 20);

  // made by ElevenLabs: the prompt of the code, the film plus 2 s, instrumental (the call is replaced)
  const tools = require('../lib/tools');
  const elevenlabs = require('../lib/elevenlabs');
  const assets = require('../lib/nodes/assets');
  const saved = { executeTool: tools.executeTool, hasKey: elevenlabs.hasKey, valueFromAsset: assets.valueFromAsset };
  const calls = [];
  try {
    elevenlabs.hasKey = () => true;
    tools.executeTool = async (_ctx, name, args) => {
      calls.push({ name, args });
      if (args.prompt === 'fail') throw new Error('nope');
      return { asset: { id: 'm1', cost: 0.2067 } };
    };
    assets.valueFromAsset = async (sessionId, id) => ({ type: 'audio', sessionId, assetId: id, file: `${id}.mp3` });
    const made = await music.execute({ ...ctx, sessionId: 's1' }, { style: styleInput }, registry.normalizeParams(music, {}));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'generate_music');
    assert.deepEqual(calls[0].args, { prompt: styles.musicPrompt(load('style-corporate-fresh.json')), length_seconds: 62, instrumental: true, model_id: registry.normalizeParams(music, {}).model });
    assert.equal(made.variants[0].audio.assetId, 'm1');
    assert.equal(made.variants[0].prompt.value, calls[0].args.prompt);
    assert.deepEqual(made.cost, { usd: 0.2067 });
    tools.executeTool = async () => {
      throw new Error('ElevenLabs said no');
    };
    await assert.rejects(music.execute({ ...ctx, sessionId: 's1' }, { style: styleInput }, registry.normalizeParams(music, {})), (err) => err.code === 'EVENTMUSIC_FAILED' && /ElevenLabs said no/.test(err.message));
    elevenlabs.hasKey = () => false;
    await assert.rejects(music.execute({ ...ctx, sessionId: 's1' }, { style: styleInput }, registry.normalizeParams(music, {})), (err) => err.code === 'EVENTMUSIC_FAILED' && /own music/.test(err.message));
  } finally {
    Object.assign(tools, { executeTool: saved.executeTool });
    elevenlabs.hasKey = saved.hasKey;
    assets.valueFromAsset = saved.valueFromAsset;
  }
  await assert.rejects(music.execute(ctx, { style: textValue('{"version":1}') }, registry.normalizeParams(music, {})), /style: the text is not the style/);
}

(async () => {
  testTables();
  testExamples();
  testDerive();
  testMusicPrompt();
  await testNodes();
  console.log('test-event-video-style.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
