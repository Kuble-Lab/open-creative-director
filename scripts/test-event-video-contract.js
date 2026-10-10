'use strict';

// The contract of the event video (WP53, package 0): lib/event-video/contract.js and the shared test data in scripts/support/event-video/. No network,
// nothing paid, no footage of anybody: the event ("Innovation Day 2026"), its people ("Anna Muster", "Luca Beispiel") and the address are made up.
//   constants   the axes, the acts and their shares, the sizes of the formats, the codes of the errors and the limits agree with the specification
//               (spec §1, §3, §5) and with the code they come from
//   fixtures    every file of test data passes its check; the material, the style, the answer, the shots and the graphics fit each other (the refs,
//               the words of the soundbites, the clips, the look from the style); beats-60.json is what audio.beats writes
//   broken      a variant with one fault fails with a message that names the place of the fault
//   accepted    variants the contract allows on purpose (no title, no optional lists, a dissolve, a flash, the alias festival)
//   never       a check never throws, not on rubbish and not on an object whose field throws
//
// The test data:
//   material-60.json            { brief, videos: [info], photos: [info] }: 7 usable videos and 1 that cannot be decoded, 6 usable photos and a HEIC
//   info-video.json, info-photo.json, info-broken.json   videos[0], photos[1] and videos[7] of the material on their own
//   style-corporate-fresh.json  the output `style` of event_video.style for corporate x fresh, 60 s, German (no format)
//   beats-60.json               the output `analysis` of audio.beats: lib/music-analysis.js analyse() on a made-up song of 62 s at 118 BPM
//   answer-ok.json              an answer of the model to this material (photo_motion ai, parallax on, voice-over on)
//   shots-60.json, graphics-60.json   a plan of 60 s made from them: every kind of shot, every part of the graphics

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const contract = require('../lib/event-video/contract');
const analysis = require('../lib/music-analysis');

const SUPPORT = path.join(__dirname, 'support', 'event-video');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SUPPORT, name), 'utf8'));
const clone = (value) => structuredClone(value);
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());

const material = load('material-60.json');
const infoVideo = load('info-video.json');
const infoPhoto = load('info-photo.json');
const infoBroken = load('info-broken.json');
const style = load('style-corporate-fresh.json');
const beats = load('beats-60.json');
const answer = load('answer-ok.json');
const shots = load('shots-60.json');
const graphics = load('graphics-60.json');

function passes(result, label) {
  assert.equal(typeof result.ok, 'boolean', `${label}: ok`);
  assert.ok(Array.isArray(result.problems), `${label}: problems`);
  assert.deepEqual(result.problems, [], `${label}: ${result.problems.join(' | ')}`);
  assert.equal(result.ok, true, label);
}

function fails(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: passed, but should fail`);
  assert.ok(result.problems.length > 0, `${label}: no problem`);
  assert.ok(
    result.problems.some((problem) => pattern.test(problem)),
    `${label}: no problem matches ${pattern}: ${result.problems.join(' | ')}`
  );
}

/* ---------- the constants ---------- */

function testConstants() {
  assert.deepEqual(contract.EVENT_TYPES, ['corporate', 'conference', 'workshop', 'launch', 'party', 'celebration']);
  assert.deepEqual(contract.EVENT_TYPE_ALIASES, { festival: 'party' });
  assert.deepEqual(contract.ALIAS_SHIFTS, { festival: { warmth: 0.1, grain: 0.1 } });
  assert.deepEqual(contract.MOODS, ['fresh', 'calm', 'fast', 'emotional', 'epic', 'elegant']);
  assert.deepEqual(contract.LENGTHS, [30, 60, 90]);
  assert.deepEqual(contract.FORMATS, ['16:9', '9:16', '1:1']);
  assert.deepEqual(contract.LANGUAGES, ['de', 'en', 'es']);
  assert.deepEqual(contract.FORMAT_SIZES, {
    '16:9': { width: 1920, height: 1080, renderFormat: 'landscape' },
    '9:16': { width: 1080, height: 1920, renderFormat: 'portrait' },
    '1:1': { width: 1080, height: 1080, renderFormat: 'square' }
  });
  assert.deepEqual(contract.DEFAULTS, { event_type: 'conference', mood: 'fresh', length: 60, format: '16:9', language: 'de' });
  for (const [key, list] of Object.entries({ event_type: contract.EVENT_TYPES, mood: contract.MOODS, length: contract.LENGTHS, format: contract.FORMATS, language: contract.LANGUAGES })) {
    assert.ok(list.includes(contract.DEFAULTS[key]), `the default of ${key} is one of its values`);
  }

  // the acts and their shares: 10/15/25/20/20/10 %, together the whole film (spec §5c)
  assert.deepEqual(contract.ACTS, ['hook', 'arrival', 'programme', 'people', 'peak', 'close']);
  assert.deepEqual(Object.keys(contract.ACT_SHARES), contract.ACTS);
  near(Object.values(contract.ACT_SHARES).reduce((sum, share) => sum + share, 0), 1, 1e-9, 'the shares of the acts');
  const seconds = (length) => contract.ACTS.map((act) => Math.round(contract.ACT_SHARES[act] * length * 10) / 10);
  assert.deepEqual(seconds(30), [3, 4.5, 7.5, 6, 6, 3]);
  assert.deepEqual(seconds(60), [6, 9, 15, 12, 12, 6]);
  assert.deepEqual(seconds(90), [9, 13.5, 22.5, 18, 18, 9]);
  assert.deepEqual(contract.VOICEOVER_ACTS, ['arrival', 'close']);

  assert.equal(contract.FPS, 24);
  assert.equal(contract.INFO_VERSION, 1);
  assert.equal(contract.STYLE_VERSION, 1);
  assert.equal(contract.SHOTS_VERSION, 1);
  assert.equal(contract.GRAPHICS_VERSION, 1);
  assert.equal(contract.ENDCARD_SECONDS, 3);
  assert.equal(contract.TITLE_FROM, 1.5);

  // the codes of the errors of spec §3, each its own name
  assert.deepEqual(Object.keys(contract.ERRORS).sort(), [
    'EVENTCUT_FAILED',
    'EVENTCUT_SOURCE_MISSING',
    'EVENTMEDIA_SPEECH_FAILED',
    'EVENTMEDIA_VISION_FAILED',
    'EVENTMUSIC_FAILED',
    'EVENTMUSIC_TOO_SHORT',
    'EVENTPLAN_BRIEF_EMPTY',
    'EVENTPLAN_MODEL_FAILED',
    'EVENTPLAN_NO_LLM',
    'EVENTPLAN_NO_MATERIAL',
    'EVENTPLAN_TOO_MUCH_MATERIAL',
    'EVENTRENDER_CHUNK_FAILED',
    'EVENTRENDER_GRAPHICS_INVALID',
    'EVENTRENDER_NO_NODE',
    'EVENTRENDER_VERIFY_FAILED',
    'EVENTSTYLE_BAD_VALUE'
  ]);
  for (const [key, value] of Object.entries(contract.ERRORS)) assert.equal(value, key);
  assert.deepEqual(contract.UNUSABLE_REASONS, ['unsupported_format', 'decode_failed', 'no_video_stream', 'too_long', 'heic']);

  // the limits of a run (spec §1) are those of the code they come from
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.equal(contract.LIMITS.listItems, Number(/const MAX_MEDIA_LIST = (\d+);/.exec(source('lib/nodes/nodes-basic.js'))[1]));
  const upload = /const MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024;/.exec(source('lib/nodes/routes.js'));
  assert.equal(contract.LIMITS.fileBytes, Number(upload[1]) * 1024 * 1024);
  assert.equal(contract.LIMITS.videoSeconds, 1800);
  assert.equal(contract.LIMITS.minUsable, 5);
  // the render nodes know these formats (render_motion_graphics in lib/tools.js)
  assert.match(source('lib/tools.js'), /enum: \['landscape', 'portrait', 'square'\]/);
  assert.deepEqual(Object.values(contract.FORMAT_SIZES).map((size) => size.renderFormat), ['landscape', 'portrait', 'square']);

  // what shots and graphics know of the transitions of the style (D5): whip and strobe are not drawn yet
  assert.deepEqual(contract.SHOT_TRANSITIONS, ['cut', 'dissolve', 'match']);
  assert.deepEqual(contract.PAGE_TRANSITIONS, ['dip', 'flash']);
  for (const name of [...contract.SHOT_TRANSITIONS, ...contract.PAGE_TRANSITIONS]) assert.ok(contract.STYLE_TRANSITIONS.includes(name), name);
  assert.deepEqual(contract.SHOT_KINDS, ['video', 'photo', 'photo_ai', 'photo_parallax', 'soundbite']);
  assert.deepEqual(contract.SPEEDS, [0.5, 0.75, 1]);
  // one animation of the title per mood (spec §5b), each with its ease
  assert.equal(Object.keys(contract.TITLE_ANIMS).length, contract.MOODS.length);
  for (const [name, anim] of Object.entries(contract.TITLE_ANIMS)) assert.match(anim.ease, /^[a-z0-9]+\.(in|out|inOut)(\([\d.]+\))?$/, name);
  // the lengths of the texts of the answer (spec §4)
  for (const [key, max] of Object.entries({ treatment: 400, why: 80, title: 28, sub: 40, label: 32, intertitle: 32, aiPrompt: 300, voiceover: 180, endcardLine: 40, endcardSub: 40 })) {
    assert.equal(contract.TEXT_LIMITS[key], max, key);
  }
  assert.deepEqual(contract.INTERTITLES_BY_LENGTH, { 30: 1, 60: 2, 90: 3 });

  // the helpers
  assert.deepEqual(contract.readEventType('festival'), { type: 'party', alias: 'festival', shift: { warmth: 0.1, grain: 0.1 } });
  assert.deepEqual(contract.readEventType(' Corporate '), { type: 'corporate', alias: null, shift: null });
  assert.equal(contract.readEventType('gala'), null);
  assert.equal(contract.readEventType(undefined), null);
  assert.deepEqual(contract.parseRef('v3#2'), { kind: 'scene', video: 3, scene: 2 });
  assert.deepEqual(contract.parseRef('p7'), { kind: 'photo', photo: 7 });
  assert.deepEqual(contract.parseRef('v5'), { kind: 'video', video: 5 });
  for (const bad of ['v03#1', 'v1#', 'p', 'P1', 'v1#2#3', 'x1', ' p1', 12, null]) assert.equal(contract.parseRef(bad), null, String(bad));
  assert.deepEqual(contract.parseFont('Montserrat:700'), { family: 'Montserrat', weight: 700, italic: false });
  assert.deepEqual(contract.parseFont('Playfair Display:600:italic'), { family: 'Playfair Display', weight: 600, italic: true });
  for (const bad of ['Montserrat', 'Montserrat:750', 'Comic Sans:400', 'Anton:400:bold', 'inter tight:400']) assert.equal(contract.parseFont(bad), null, bad);
}

/* ---------- the test data ---------- */

// The corporate column of spec §5a and the fresh column of §5b, for the values of the style
const CORPORATE = { tempo: [0.45, 0.2, 0.7], density: [0.4, 0.2, 0.6], warmth: [0.45], contrast: [0.5], saturation: [0.45], grain: [0.15], glow: [0.2], formality: [0.85, 0.6, 1], slowmo: [0.1, 0, 0.25] };
const FRESH = { tempo: 0.1, density: 0.1, warmth: 0, contrast: 0.05, saturation: 0.15, grain: -0.05, glow: 0.1, formality: -0.1, slowmo: 0 };

async function testFixtures() {
  // every element of the material is an info v1; the single files are elements of it
  assert.equal(typeof material.brief, 'string');
  material.videos.forEach((info, index) => passes(contract.checkInfo(info), `material.videos[${index}]`));
  material.photos.forEach((info, index) => passes(contract.checkInfo(info), `material.photos[${index}]`));
  assert.ok(material.videos.every((info) => info.kind === 'video') && material.photos.every((info) => info.kind === 'photo'));
  assert.ok(material.videos.filter((info) => info.usable).length >= 6, 'at least 6 usable videos');
  assert.ok(material.photos.filter((info) => info.usable).length >= 6, 'at least 6 usable photos');
  assert.ok(material.videos.some((info) => !info.usable) && material.photos.some((info) => !info.usable), 'an element of each kind that cannot be used');
  assert.equal(new Set([...material.videos, ...material.photos].map((info) => info.id)).size, material.videos.length + material.photos.length, 'the ids differ');
  passes(contract.checkInfo(infoVideo), 'info-video.json');
  passes(contract.checkInfo(infoPhoto), 'info-photo.json');
  passes(contract.checkInfo(infoBroken), 'info-broken.json');
  assert.deepEqual(infoVideo, material.videos[0]);
  assert.deepEqual(infoPhoto, material.photos[1]);
  assert.deepEqual(infoBroken, material.videos[7]);
  assert.equal(infoBroken.usable, false);
  assert.ok(infoVideo.speech.words.length > 10 && infoVideo.scenes.length >= 3);
  assert.equal(infoPhoto.meta.rotation, 90, 'a portrait photo: the size as shown');
  assert.ok(infoPhoto.meta.height > infoPhoto.meta.width);
  assert.ok(material.videos.some((info) => info.usable && info.meta.hdr), 'an HDR clip');
  assert.ok(material.videos.some((info) => info.usable && info.meta.fps >= 50), 'a clip for slow motion');

  // the style: corporate x fresh after spec §5 (base + delta, clamped), and nothing about the format
  passes(contract.checkStyle(style), 'style-corporate-fresh.json');
  assert.equal(style.format, undefined);
  assert.deepEqual([style.event_type, style.event_alias, style.mood, style.length, style.language], ['corporate', null, 'fresh', 60, 'de']);
  for (const key of contract.STYLE_VALUES) {
    const [base, min = 0, max = 1] = CORPORATE[key];
    near(style.values[key], Math.min(max, Math.max(min, base + FRESH[key])), 1e-9, key);
  }
  // corporate (cut, dip, match) with the weights of fresh (cut 6, whip 2, match 2, dip 1)
  assert.deepEqual(style.transitions, { cut: 6, match: 2, dip: 1 });
  assert.equal(style.genre, 'modern corporate, clean electronic pop, piano and soft synth pads, light percussion, bright, uplifting, light and airy, major key');
  assert.deepEqual(style.type, { title: 'Montserrat:700', body: 'Inter Tight:500' });
  assert.equal(style.title_anim, 'words_up');
  assert.deepEqual(contract.ACTS.map((act) => style.energy[act]), [0.5, 0.55, 0.6, 0.8, 0.9, 0.5]);
  assert.deepEqual(style.soundbites, { count: [1, 2], seconds: [4, 7] });
  assert.equal(style.nat_level, 0.12);

  await testBeats();
  testAnswerFitsMaterial();
  testPlanFits();
}

// beats-60.json is what audio.beats writes: the fields of music-analysis.analyse() in their order, of a song of 62 s at about 118 BPM
function testBeats() {
  return analysis.analyse(new Float32Array(analysis.SAMPLE_RATE * 3), {}).then((fresh) => {
    assert.deepEqual(Object.keys(beats), Object.keys(fresh), 'the fields of the analysis');
    for (const key of Object.keys(fresh)) assert.equal(Array.isArray(beats[key]), Array.isArray(fresh[key]), key);
    assert.equal(beats.version, 1);
    assert.equal(beats.duration, 62);
    near(beats.bpm, 118, 0.5, 'bpm');
    assert.ok(beats.beats.length > 110 && beats.beats.every((time, index) => index === 0 || time > beats.beats[index - 1]), 'the beats rise');
    assert.ok(beats.downbeats.every((time) => beats.beats.includes(time)), 'the downbeats are beats');
    assert.equal(beats.sections[0].start, 0);
    assert.equal(beats.sections[beats.sections.length - 1].end, beats.duration);
    assert.equal(beats.energy.length, 62);
    assert.ok(beats.hits.every((hit) => Object.keys(hit).join() === 't,strength'));
    assert.deepEqual(beats.warnings, []);
  });
}

const sceneOf = (ref) => {
  const parsed = contract.parseRef(ref);
  return parsed.kind === 'scene' ? material.videos[parsed.video].scenes[parsed.scene] : material.photos[parsed.photo].scenes[0];
};
const infoOf = (ref) => {
  const parsed = contract.parseRef(ref);
  return parsed.kind === 'photo' ? material.photos[parsed.photo] : material.videos[parsed.video];
};

// The answer is one plan.js takes as it is: what the check of the shape does not see, but plan.js does (spec §4, validation), holds here
function testAnswerFitsMaterial() {
  passes(contract.checkAnswer(answer), 'answer-ok.json');
  assert.deepEqual(answer.acts.map((act) => act.act), contract.ACTS);
  const refs = answer.acts.flatMap((act) => act.picks.flatMap((pick) => [pick.ref, pick.pair].filter(Boolean)));
  assert.equal(new Set(refs).size, refs.length, 'no scene twice');
  for (const ref of refs) {
    const info = infoOf(ref);
    assert.ok(info && info.usable, `${ref} is usable`);
    const scene = sceneOf(ref);
    assert.ok(scene && scene.quality >= 3, `${ref} has a quality of 3 at least`);
    assert.ok(!info.vision.risk.some((risk) => contract.HARD_RISKS.includes(risk)), `${ref} has no hard risk`);
  }
  // the soundbites: whole sentences of a transcript, within the length of the style
  answer.soundbites.forEach((bite, index) => {
    const info = infoOf(bite.ref);
    const words = info.speech.words;
    assert.ok(bite.word_to < words.length, `soundbite ${index}: the words exist`);
    assert.match(words[bite.word_to].w, /[.!?]$/, `soundbite ${index} ends a sentence`);
    assert.ok(bite.word_from === 0 || /[.!?]$/.test(words[bite.word_from - 1].w), `soundbite ${index} starts a sentence`);
    const seconds = words[bite.word_to].e - words[bite.word_from].s;
    assert.ok(seconds >= style.soundbites.seconds[0] - 0.5 && seconds <= style.soundbites.seconds[1], `soundbite ${index}: ${seconds} s`);
    for (const key of ['speaker', 'role']) assert.ok(material.brief.includes(bite[key]), `soundbite ${index}: the ${key} is in the brief`);
  });
  assert.ok(answer.soundbites.length >= style.soundbites.count[0] && answer.soundbites.length <= style.soundbites.count[1]);
  // every name, number and place on the screen is in the brief
  for (const text of [
    answer.title.text,
    answer.title.sub.replace('Zürich, ', ''),
    ...answer.lower_thirds.flatMap((third) => [third.name, third.role]),
    ...answer.intertitles.map((title) => title.text),
    answer.endcard.url
  ]) {
    assert.ok(material.brief.includes(text), `"${text}" is in the brief`);
  }
  assert.ok(answer.intertitles.length <= contract.INTERTITLES_BY_LENGTH[60]);
  // AI clips and parallax only from usable photos, none in both lists
  for (const ref of [...answer.ai_photos.map((item) => item.ref), ...answer.parallax]) assert.ok(infoOf(ref).usable && infoOf(ref).kind === 'photo', ref);
}

// The shots and graphics are the plan of the answer: every kind of shot and every part of the graphics, cut on the beats of beats-60.json
function testPlanFits() {
  passes(contract.checkShots(shots), 'shots-60.json');
  passes(contract.checkGraphics(graphics), 'graphics-60.json');
  passes(contract.checkPair(shots, graphics), 'shots-60.json with graphics-60.json');
  assert.equal(shots.duration, 60);
  assert.deepEqual(new Set(shots.shots.map((shot) => shot.kind)), new Set(contract.SHOT_KINDS), 'every kind of shot');
  for (const key of ['title', 'lower_thirds', 'intertitles', 'soundbites', 'voiceover', 'endcard', 'transitions', 'look', 'mix']) {
    const value = graphics[key];
    assert.ok(value && (!Array.isArray(value) || value.length), `graphics.${key} is there`);
  }
  assert.ok(shots.shots.some((shot) => shot.transition === 'match') && shots.shots.some((shot) => shot.hdr) && shots.shots.some((shot) => shot.speed < 1));

  // the picks in the order of the acts are the shots that are not soundbites; a pair follows its pick
  const picks = answer.acts.flatMap((act) => act.picks.flatMap((pick) => [{ act: act.act, ref: pick.ref, slow: pick.slow }, ...(pick.pair ? [{ act: act.act, ref: pick.pair, match: true }] : [])]));
  const pictures = shots.shots.filter((shot) => shot.kind !== 'soundbite');
  assert.equal(pictures.length, picks.length);
  pictures.forEach((shot, index) => {
    const pick = picks[index];
    const parsed = contract.parseRef(pick.ref);
    assert.equal(shot.act, pick.act, shot.id);
    if (shot.kind === 'video') {
      assert.equal(parsed.kind, 'scene', shot.id);
      assert.equal(shot.source, parsed.video, shot.id);
      const info = material.videos[parsed.video];
      const scene = info.scenes[parsed.scene];
      assert.ok(shot.from >= scene.in && shot.from + (shot.end - shot.start) * shot.speed <= scene.out + 1e-9, `${shot.id} plays inside ${pick.ref}`);
      assert.equal(shot.speed, pick.slow ? (info.meta.fps >= 50 ? 0.5 : 0.75) : 1, `${shot.id} speed`);
      assert.equal(Boolean(shot.hdr), info.meta.hdr, `${shot.id} hdr`);
      assert.equal(shot.transition, pick.match ? 'match' : 'cut', `${shot.id} transition`);
    } else if (shot.kind === 'photo') {
      assert.equal(shot.source, parsed.photo, shot.id);
      assert.ok(!answer.parallax.includes(pick.ref) && !answer.ai_photos.some((item) => item.ref === pick.ref), shot.id);
      near(shot.motion.rate, 0.04 + 0.08 * style.values.tempo, 1e-9, `${shot.id} rate`);
    } else if (shot.kind === 'photo_ai') {
      assert.equal(answer.ai_photos[shot.clip].ref, pick.ref, shot.id);
    } else if (shot.kind === 'photo_parallax') {
      assert.equal(answer.parallax[shot.clip], pick.ref, shot.id);
    }
    if (shot.anchor) {
      const faces = sceneOf(pick.ref).faces;
      if (faces.count) assert.deepEqual([shot.anchor.x, shot.anchor.y], [faces.x, faces.y], `${shot.id} anchor on the faces`);
    }
    if (shot.exposure !== 0 || shot.kind === 'video' || shot.kind === 'photo') {
      near(shot.exposure, Math.min(0.08, Math.max(-0.08, (0.45 - sceneOf(pick.ref).luma) * 0.5)), 0.0005, `${shot.id} exposure`);
    }
  });

  // the soundbites: the first in programme, the second in people (spec §5c), the words of the answer with their times from the start
  const bites = shots.shots.filter((shot) => shot.kind === 'soundbite');
  assert.deepEqual(bites.map((shot) => shot.act), ['programme', 'people']);
  bites.forEach((shot, index) => {
    const bite = answer.soundbites[index];
    const words = infoOf(bite.ref).speech.words.slice(bite.word_from, bite.word_to + 1);
    assert.equal(shot.source, contract.parseRef(bite.ref).video);
    assert.ok(shot.from <= words[0].s && shot.from >= words[0].s - 0.5, `${shot.id} starts just before the first word`);
    assert.ok(shot.to >= words[words.length - 1].e && shot.to <= words[words.length - 1].e + 0.5, `${shot.id} ends just after the last word`);
    assert.deepEqual(graphics.soundbites[index].words, words.map((word) => ({ w: word.w, s: Math.round((word.s - shot.from) * 1000) / 1000, e: Math.round((word.e - shot.from) * 1000) / 1000 })));
    const third = graphics.lower_thirds[index];
    assert.deepEqual([third.name, third.role], [answer.lower_thirds[index].name, answer.lower_thirds[index].role]);
  });

  // the grid: the acts start on downbeats near their share, every cut on a beat or at the end of a soundbite
  graphics.acts.forEach((act, index) => {
    if (index === 0) return assert.equal(act.start, 0);
    assert.ok(beats.downbeats.includes(act.start), `${act.act} starts on a downbeat`);
    const nominal = contract.ACTS.slice(0, index).reduce((sum, name) => sum + contract.ACT_SHARES[name] * shots.duration, 0);
    assert.ok(Math.abs(act.start - nominal) <= 1.1, `${act.act} starts near ${nominal}`);
  });
  const biteEnds = bites.map((shot) => shot.end);
  for (const cut of graphics.cuts.slice(1)) assert.ok(beats.beats.includes(cut) || biteEnds.includes(cut), `the cut at ${cut}`);
  for (const item of graphics.transitions) assert.ok(graphics.acts.some((act) => act.start === item.at), `the ${item.type} at ${item.at} is the start of an act`);
  for (const item of graphics.transitions) assert.ok(style.transitions[item.type], `${item.type} is a transition of the style`);
  for (const shot of shots.shots) assert.ok(shot.transition === 'cut' || style.transitions[shot.transition], `${shot.id}: ${shot.transition} is a transition of the style`);

  // the texts of the answer, the look and the mix of the style (spec §5c)
  assert.equal(graphics.title.text, answer.title.text);
  assert.equal(graphics.title.sub, answer.title.sub);
  assert.equal(graphics.title.start, contract.TITLE_FROM);
  assert.equal(graphics.title.anim, style.title_anim);
  assert.deepEqual(graphics.intertitles.map((title) => title.text), answer.intertitles.map((title) => title.text));
  assert.deepEqual([graphics.endcard.line, graphics.endcard.sub, graphics.endcard.url], [answer.endcard.line, answer.endcard.sub, answer.endcard.url]);
  assert.equal(graphics.endcard.seconds, contract.ENDCARD_SECONDS);
  assert.equal(graphics.voiceover.length, answer.voiceover.length);
  graphics.voiceover.forEach((line, index) => {
    const act = graphics.acts.find((item) => item.act === answer.voiceover[index].act);
    assert.ok(line.start >= act.start && line.start < act.end, `voice-over ${index} in ${act.act}`);
    assert.ok(!graphics.soundbites.some((bite) => line.start >= bite.start && line.start < bite.end), `voice-over ${index} not over a soundbite`);
  });
  assert.deepEqual(shots.look, { contrast: style.values.contrast, saturation: style.values.saturation });
  assert.deepEqual(graphics.look.type, style.type);
  near(graphics.look.tint, (style.values.warmth - 0.5) * 0.3, 0.0005, 'tint');
  assert.equal(graphics.look.glow, 0, 'no light spot at a glow of 0.5 or less');
  near(graphics.look.title_seconds, 1.3 - 0.6 * style.values.tempo, 0.0005, 'title_seconds');
  assert.equal(graphics.look.ease, 'power3.out', 'formality 0.75');
  assert.deepEqual([graphics.look.grain, graphics.look.contrast], [style.values.grain, style.values.contrast]);
  assert.deepEqual(graphics.mix, { duck_db: -12, ramp: 0.3, nat_level: style.nat_level, lufs: -16 });
}

/* ---------- one fault each ---------- */

// [label, check, data, change, the problem it must give]
const BROKEN = [
  // info
  ['info: a field is missing', 'checkInfo', infoVideo, (info) => delete info.id, /^id is missing$/],
  ['info: a wrong type', 'checkInfo', infoVideo, (info) => (info.meta.width = '3840'), /^meta\.width must be a number, got string$/],
  ['info: a wrong version', 'checkInfo', infoVideo, (info) => (info.version = 2), /^version is 2, expected 1$/],
  ['info: an unknown kind', 'checkInfo', infoVideo, (info) => (info.kind = 'audio'), /^kind "audio" is not one of video, photo$/],
  ['info: a scene after the end', 'checkInfo', infoVideo, (info) => (info.scenes[2].out = 120), /^scenes\[2\]\.out is 120, after the end of the clip \(96\.4\)$/],
  ['info: scenes overlap', 'checkInfo', infoVideo, (info) => (info.scenes[1].in = 30), /^scenes\[1\]\.in is 30, before the end of the scene before \(31\.2\)$/],
  ['info: the index of a scene', 'checkInfo', infoVideo, (info) => (info.scenes[1].i = 4), /^scenes\[1\]\.i is 4, must be its place in the list \(1\)$/],
  ['info: a quality of 6', 'checkInfo', infoVideo, (info) => (info.scenes[0].quality = 6), /^scenes\[0\]\.quality is 6, outside 1\.\.5$/],
  ['info: ok next to a fault', 'checkInfo', infoVideo, (info) => (info.scenes[0].reasons = ['ok', 'dark']), /^scenes\[0\]\.reasons has "ok" next to a fault$/],
  ['info: a face outside 0..1', 'checkInfo', infoVideo, (info) => (info.scenes[0].faces.x = 1.3), /^scenes\[0\]\.faces\.x is 1\.3, outside 0\.\.1$/],
  ['info: a place without a face', 'checkInfo', material.photos[0], (info) => (info.scenes[0].faces.x = 0.5), /^scenes\[0\]\.faces\.x must be null when there is no face$/],
  ['info: a word that ends before it starts', 'checkInfo', infoVideo, (info) => (info.speech.words[4].e = 1), /^speech\.words\[4\]\.e is 1, before the start of the word \(40\.24\)$/],
  ['info: the words out of order', 'checkInfo', infoVideo, (info) => (info.speech.words[6].s = 40), /^speech\.words\[\]\.s\[6\] is 40, before the one before \(40\.52\)$/],
  ['info: a language that is not a code', 'checkInfo', infoVideo, (info) => (info.speech.language = 'German'), /^speech\.language "German" has not the form/],
  ['info: an unknown risk', 'checkInfo', infoVideo, (info) => (info.vision.risk = ['nudity']), /^vision\.risk\[0\] "nudity" is not one of child, /],
  ['info: people as a number', 'checkInfo', infoVideo, (info) => (info.vision.people = 3), /^vision\.people 3 is not one of 0, 1, 2-5, crowd$/],
  ['info: a score of 0', 'checkInfo', infoVideo, (info) => (info.vision.score = 0), /^vision\.score is 0, outside 1\.\.5$/],
  ['info: no date', 'checkInfo', infoVideo, (info) => (info.meta.taken_at = 'yesterday'), /^meta\.taken_at "yesterday" is not a date and time \(ISO 8601\)$/],
  ['info: a photo with seconds', 'checkInfo', infoPhoto, (info) => (info.meta.seconds = 5), /^meta\.seconds is 5, a photo has 0$/],
  ['info: a photo with speech', 'checkInfo', infoPhoto, (info) => (info.speech = { language: 'de', words: [{ w: 'Hallo', s: 0, e: 0.4 }] }), /^speech must be null for a photo$/],
  ['info: a photo with two scenes', 'checkInfo', infoPhoto, (info) => info.scenes.push({ ...info.scenes[0], i: 1 }), /^scenes has 2 entries, at most 1$/],
  ['info: a usable element with a reason', 'checkInfo', infoVideo, (info) => (info.reason = 'too_long'), /^reason is "too_long", must be null for a usable element$/],
  ['info: an unusable element without a reason', 'checkInfo', infoBroken, (info) => (info.reason = null), /^reason is null$/],
  ['info: an unknown reason', 'checkInfo', infoBroken, (info) => (info.reason = 'too_dark'), /^reason "too_dark" is not one of unsupported_format, /],
  ['info: an unusable element with scenes', 'checkInfo', infoBroken, (info) => (info.scenes = clone(infoVideo.scenes)), /^scenes must be empty for an element that cannot be used$/],

  // style
  ['style: a format', 'checkStyle', style, (s) => (s.format = '16:9'), /^format must not be part of the style/],
  ['style: a value above 1', 'checkStyle', style, (s) => (s.values.tempo = 1.2), /^values\.tempo is 1\.2, outside 0\.\.1$/],
  ['style: a value is missing', 'checkStyle', style, (s) => delete s.values.slowmo, /^values\.slowmo is missing$/],
  ['style: the alias as a type', 'checkStyle', style, (s) => (s.event_type = 'festival'), /^event_type "festival" is not one of corporate, /],
  ['style: an alias of another type', 'checkStyle', style, (s) => (s.event_alias = 'festival'), /^event_alias "festival" is read as party, not corporate$/],
  ['style: a length of 45', 'checkStyle', style, (s) => (s.length = 45), /^length 45 is not one of 30, 60, 90$/],
  ['style: too few hard cuts', 'checkStyle', style, (s) => (s.transitions.cut = 1), /^transitions\.cut is 1 of 4, less than half$/],
  ['style: an unknown transition', 'checkStyle', style, (s) => (s.transitions.wipe = 1), /^transitions\.wipe "wipe" is not one of cut, /],
  ['style: an unknown font', 'checkStyle', style, (s) => (s.type.title = 'Comic Sans:700'), /^type\.title "Comic Sans:700" is not "Family:weight"/],
  ['style: an unknown title animation', 'checkStyle', style, (s) => (s.title_anim = 'bounce'), /^title_anim "bounce" is not one of words_up, /],
  ['style: the energy of an act is missing', 'checkStyle', style, (s) => delete s.energy.peak, /^energy\.peak is missing$/],
  ['style: a range upside down', 'checkStyle', style, (s) => (s.soundbites.count = [3, 1]), /^soundbites\.count \[3, 1\] has the low end above the high end$/],
  ['style: a wrong version', 'checkStyle', style, (s) => (s.version = 0), /^version is 0, expected 1$/],

  // answer
  ['answer: a title that is too long', 'checkAnswer', answer, (a) => (a.title.text = 'Innovation Day 2026 in Zürich'), /^title\.text has 29 characters, at most 28$/],
  ['answer: a missing title', 'checkAnswer', answer, (a) => delete a.title, /^title is missing$/],
  ['answer: a wrong ref', 'checkAnswer', answer, (a) => (a.acts[0].picks[0].ref = 'clip1'), /^acts\[0\]\.picks\[0\]\.ref "clip1" is not a scene \("v<index>#<scene>"\) or a photo \("p<index>"\)$/],
  ['answer: a video without a scene as a pick', 'checkAnswer', answer, (a) => (a.acts[0].picks[0].ref = 'v1'), /^acts\[0\]\.picks\[0\]\.ref "v1" is not a scene/],
  ['answer: a scene as a soundbite', 'checkAnswer', answer, (a) => (a.soundbites[0].ref = 'v0#1'), /^soundbites\[0\]\.ref "v0#1" is not a video \("v<index>"\)$/],
  ['answer: words backwards', 'checkAnswer', answer, (a) => (a.soundbites[0].word_to = 2), /^soundbites\[0\]\.word_to is 2, before word_from \(3\)$/],
  ['answer: half a word', 'checkAnswer', answer, (a) => (a.soundbites[1].word_from = 10.5), /^soundbites\[1\]\.word_from is 10\.5, must be a whole number$/],
  ['answer: a lower third of a soundbite that is not there', 'checkAnswer', answer, (a) => (a.lower_thirds[1].soundbite = 5), /^lower_thirds\[1\]\.soundbite is 5, but there are 2 soundbites$/],
  ['answer: an empty lower third', 'checkAnswer', answer, (a) => Object.assign(a.lower_thirds[0], { name: null, role: null, label: null }), /^lower_thirds\[0\] has neither a name, nor a role, nor a label$/],
  ['answer: a label that is too long', 'checkAnswer', answer, (a) => (a.lower_thirds[0].label = 'Keynote über die Zukunft der Plattform'), /^lower_thirds\[0\]\.label has 38 characters, at most 32$/],
  ['answer: an unknown act', 'checkAnswer', answer, (a) => (a.acts[5].act = 'finale'), /^acts\[5\]\.act "finale" is not one of hook, /],
  ['answer: a missing act', 'checkAnswer', answer, (a) => a.acts.pop(), /^acts has no act close$/],
  ['answer: an act twice', 'checkAnswer', answer, (a) => (a.acts[5].act = 'hook'), /^acts\[5\]\.act "hook" is there twice$/],
  ['answer: a scene twice', 'checkAnswer', answer, (a) => (a.acts[5].picks[1].ref = 'v1#0'), /^acts\[5\]\.picks\[1\] uses "v1#0", which acts\[0\]\.picks\[0\] uses already$/],
  ['answer: a pair with itself', 'checkAnswer', answer, (a) => (a.acts[2].picks[3].pair = 'v3#1'), /^acts\[2\]\.picks\[3\]\.pair is the pick itself$/],
  ['answer: an act without picks', 'checkAnswer', answer, (a) => (a.acts[1].picks = []), /^acts\[1\]\.picks has 0 entries, at least 1$/],
  ['answer: slow as a text', 'checkAnswer', answer, (a) => (a.acts[3].picks[0].slow = 'yes'), /^acts\[3\]\.picks\[0\]\.slow must be true or false, got string$/],
  ['answer: a reason that is too long', 'checkAnswer', answer, (a) => (a.acts[0].picks[0].why = 'x'.repeat(81)), /^acts\[0\]\.picks\[0\]\.why has 81 characters, at most 80$/],
  ['answer: a treatment that is too long', 'checkAnswer', answer, (a) => (a.treatment = 'y'.repeat(401)), /^treatment has 401 characters, at most 400$/],
  ['answer: a voice-over in the peak', 'checkAnswer', answer, (a) => (a.voiceover[0].act = 'peak'), /^voiceover\[0\]\.act "peak" is not one of arrival, close$/],
  ['answer: four voice-over lines', 'checkAnswer', answer, (a) => a.voiceover.push(...clone(a.voiceover)), /^voiceover has 4 entries, at most 3$/],
  ['answer: a photo both animated and in parallax', 'checkAnswer', answer, (a) => (a.parallax[0] = 'p1'), /^parallax\[0\] "p1" is animated by AI already$/],
  ['answer: a scene for AI', 'checkAnswer', answer, (a) => (a.ai_photos[0].ref = 'v1#0'), /^ai_photos\[0\]\.ref "v1#0" has not the form/],
  ['answer: an AI prompt that is too long', 'checkAnswer', answer, (a) => (a.ai_photos[0].prompt = 'z'.repeat(301)), /^ai_photos\[0\]\.prompt has 301 characters, at most 300$/],
  ['answer: four intertitles', 'checkAnswer', answer, (a) => a.intertitles.push(...clone(a.intertitles)), /^intertitles has 4 entries, at most 3$/],
  ['answer: an invented source', 'checkAnswer', answer, (a) => (a.title.source = 'invented'), /^title\.source "invented" is not one of description, generic$/],
  ['answer: the maker on the end card', 'checkAnswer', answer, (a) => (a.endcard.line = 'Made with KUBLE'), /^endcard\.line names the tool or its maker/],
  ['answer: an empty end card line', 'checkAnswer', answer, (a) => (a.endcard.line = '  '), /^endcard\.line is empty$/],
  ['answer: acts as an object', 'checkAnswer', answer, (a) => (a.acts = { hook: [] }), /^acts must be a list, got object$/],

  // shots
  ['shots: an unknown fit', 'checkShots', shots, (s) => (s.shots[5].fit = 'stretch'), /^shots\[5\].fit "stretch" is not one of crop, blur$/],
  ['shots: an unknown kind', 'checkShots', shots, (s) => (s.shots[3].kind = 'still'), /^shots\[3\]\.kind "still" is not one of video, photo, photo_ai, photo_parallax, soundbite$/],
  ['shots: an anchor outside 0..1', 'checkShots', shots, (s) => (s.shots[0].anchor.x = 1.2), /^shots\[0\]\.anchor\.x is 1\.2, outside 0\.\.1$/],
  ['shots: a missing anchor', 'checkShots', shots, (s) => delete s.shots[0].anchor, /^shots\[0\]\.anchor is missing$/],
  ['shots: a face that is not true or false', 'checkShots', shots, (s) => (s.shots[0].anchor.face = 'yes'), /^shots\[0\]\.anchor\.face must be true or false, got string$/],
  ['shots: a zoom above 2', 'checkShots', shots, (s) => (s.shots[10].zoom = 2.5), /^shots\[10\]\.zoom is 2\.5, outside 1\.\.2$/],
  ['shots: a zoom below 1', 'checkShots', shots, (s) => (s.shots[0].zoom = 0.8), /^shots\[0\]\.zoom is 0\.8, outside 1\.\.2$/],
  ['shots: a zoom on a soundbite', 'checkShots', shots, (s) => (s.shots[8].zoom = 1.5), /^shots\[8\]\.zoom belongs to a video or a photo, not to soundbite$/],
  ['shots: a drift that is too wide', 'checkShots', shots, (s) => (s.shots[0].anchor.drift = [0.1, 0]), /^shots\[0\]\.anchor\.drift\[0\] is 0\.1, outside -0\.05\.\.0\.05$/],
  ['shots: a shot after the end', 'checkShots', shots, (s) => (s.shots[24].end = 61), /^shots\[24\]\.end is 61, after the end of the film \(60\)$/],
  ['shots: the last shot ends early', 'checkShots', shots, (s) => (s.shots[24].end = 59), /^shots\[24\]\.end is 59, the last shot ends with the film \(60\)$/],
  ['shots: a gap', 'checkShots', shots, (s) => (s.shots[5].start = 10.4), /^shots\[5\]\.start is 10\.4, not the end of the shot before \(10\.289\)$/],
  ['shots: a shot backwards', 'checkShots', shots, (s) => (s.shots[2].end = 4), /^shots\[2\]\.end is 4, not after the start \(4\.192\)$/],
  ['shots: shorter than a frame', 'checkShots', shots, (s) => (s.shots[0].end = s.shots[1].start = 0.03), /^shots\[0\] is 0\.03 s long, shorter than a frame$/],
  ['shots: the film does not start at 0', 'checkShots', shots, (s) => (s.shots[0].start = 0.5), /^shots\[0\]\.start is 0\.5, the film starts at 0$/],
  ['shots: the acts out of order', 'checkShots', shots, (s) => (s.shots[0].act = 'close'), /^shots\[1\]\.act "hook" comes after close$/],
  ['shots: an id twice', 'checkShots', shots, (s) => (s.shots[1].id = 's1'), /^shots\[1\]\.id "s1" is there twice$/],
  ['shots: a dissolve first', 'checkShots', shots, (s) => (s.shots[0].transition = 'dissolve'), /^shots\[0\]\.transition is "dissolve", the first shot has cut$/],
  ['shots: a dip as a shot transition', 'checkShots', shots, (s) => (s.shots[7].transition = 'dip'), /^shots\[7\]\.transition "dip" is not one of cut, dissolve, match$/],
  ['shots: a speed that is not allowed', 'checkShots', shots, (s) => (s.shots[13].speed = 0.6), /^shots\[13\]\.speed 0\.6 is not one of 0\.5, 0\.75, 1$/],
  ['shots: an unknown photo motion', 'checkShots', shots, (s) => (s.shots[5].motion.type = 'zoom'), /^shots\[5\]\.motion\.type "zoom" is not one of zoom_in, /],
  ['shots: a photo without motion', 'checkShots', shots, (s) => delete s.shots[5].motion, /^shots\[5\]\.motion is missing$/],
  ['shots: a photo rate of 0', 'checkShots', shots, (s) => (s.shots[5].motion.rate = 0), /^shots\[5\]\.motion\.rate is 0, must be above 0$/],
  ['shots: an exposure that is too strong', 'checkShots', shots, (s) => (s.shots[0].exposure = 0.2), /^shots\[0\]\.exposure is 0\.2, outside -0\.08\.\.0\.08$/],
  ['shots: HDR on a photo', 'checkShots', shots, (s) => (s.shots[5].hdr = true), /^shots\[5\]\.hdr belongs to a video or a soundbite, not to photo$/],
  ['shots: a clip that does not exist', 'checkShots', shots, (s) => (s.shots[1].clip = 5), /^shots\[1\]\.clip is 5, but the photo_ai shots number 2 \(clips 0\.\.1\)$/],
  ['shots: a clip twice', 'checkShots', shots, (s) => (s.shots[23].clip = 0), /^shots\[23\]\.clip 0 is used twice/],
  ['shots: a soundbite in the wrong time', 'checkShots', shots, (s) => (s.shots[8].to += 1), /^shots\[8\] plays 7\.51 s of the source in 6\.51 s of the film$/],
  ['shots: a soundbite that is too long', 'checkShots', shots, (s) => (s.shots[14].to = s.shots[14].from + 13), /^shots\[14\] is 13 s long, outside 2\.\.12 s$/],
  ['shots: a soundbite without words', 'checkShots', shots, (s) => (s.shots[14].to = s.shots[14].from), /^shots\[14\]\.to is 7\.17, not after from \(7\.17\)$/],
  ['shots: a source as a text', 'checkShots', shots, (s) => (s.shots[0].source = 'v1'), /^shots\[0\]\.source must be a number, got string$/],
  ['shots: a wrong version', 'checkShots', shots, (s) => (s.version = 2), /^version is 2, expected 1$/],
  ['shots: 25 fps', 'checkShots', shots, (s) => (s.fps = 25), /^fps is 25, expected 24$/],
  ['shots: a film of 120 s', 'checkShots', shots, (s) => (s.duration = 120), /^duration is 120, outside 18\.\.90$/],
  ['shots: no shots', 'checkShots', shots, (s) => (s.shots = []), /^shots has 0 entries, at least 1$/],

  // graphics
  ['graphics: a title that is too long', 'checkGraphics', graphics, (g) => (g.title.text = 'Innovation Day 2026 in Zürich'), /^title\.text has 29 characters, at most 28$/],
  ['graphics: a title after the end', 'checkGraphics', graphics, (g) => (g.title.end = 64), /^title\.end is 64, after the end of the film \(60\)$/],
  ['graphics: an unknown title animation', 'checkGraphics', graphics, (g) => (g.title.anim = 'spin'), /^title\.anim "spin" is not one of words_up, /],
  ['graphics: a wrong end frame', 'checkGraphics', graphics, (g) => (g.endFrame = 1441), /^endFrame is 1441, expected 1440 \(duration x fps\)$/],
  ['graphics: cuts out of order', 'checkGraphics', graphics, (g) => (g.cuts[3] = 2), /^cuts\[3\] is 2, not after the one before \(4\.192\)$/],
  ['graphics: the first cut', 'checkGraphics', graphics, (g) => (g.cuts[0] = 0.5), /^cuts\[0\] is 0\.5, the first cut is 0$/],
  ['graphics: a dip that is not at a cut', 'checkGraphics', graphics, (g) => (g.transitions[0].at = 15), /^transitions\[0\]\.at is 15, which is not a cut$/],
  ['graphics: a whip', 'checkGraphics', graphics, (g) => (g.transitions[0].type = 'whip'), /^transitions\[0\]\.type "whip" is not one of dip, flash$/],
  ['graphics: a dip of no frames', 'checkGraphics', graphics, (g) => (g.transitions[0].frames = 0), /^transitions\[0\]\.frames is 0, outside 1\.\.24$/],
  ['graphics: an act is missing', 'checkGraphics', graphics, (g) => g.acts.pop(), /^acts has 5 entries, at least 6$/],
  ['graphics: the acts out of order', 'checkGraphics', graphics, (g) => ([g.acts[1].act, g.acts[2].act] = ['programme', 'arrival']), /^acts\[1\]\.act is "programme", expected arrival$/],
  ['graphics: a gap between acts', 'checkGraphics', graphics, (g) => (g.acts[2].start = 15), /^acts\[2\]\.start is 15, not the end of the act before \(14\.362\)$/],
  ['graphics: a lower third without a soundbite', 'checkGraphics', graphics, (g) => Object.assign(g.lower_thirds[0], { start: 2, end: 5 }), /^lower_thirds\[0\] 2\.\.5 is not over a soundbite$/],
  ['graphics: a lower third without null', 'checkGraphics', graphics, (g) => delete g.lower_thirds[0].label, /^lower_thirds\[0\]\.label is missing \(null when empty\)$/],
  ['graphics: a role that is too long', 'checkGraphics', graphics, (g) => (g.lower_thirds[1].role = 'Leiter Forschung und Entwicklung, Region Nord'), /^lower_thirds\[1\]\.role has 45 characters, at most 40$/],
  ['graphics: the maker as an intertitle', 'checkGraphics', graphics, (g) => (g.intertitles[0].text = 'kuble.ai'), /^intertitles\[0\]\.text names the tool or its maker/],
  ['graphics: a word after the soundbite', 'checkGraphics', graphics, (g) => (g.soundbites[1].words[11].e = 9), /^soundbites\[1\]\.words\[11\]\.e is 9, after the end \(4\.54\)$/],
  ['graphics: soundbites overlap', 'checkGraphics', graphics, (g) => Object.assign(g.soundbites[1], { start: 20, end: 24.54 }), /^soundbites\[1\]\.start is 20, inside the soundbite before \(until 22\.905\)$/],
  ['graphics: a voice line twice', 'checkGraphics', graphics, (g) => (g.voiceover[1].index = 0), /^voiceover\[1\]\.index 0 is there twice$/],
  ['graphics: a voice line after the end', 'checkGraphics', graphics, (g) => (g.voiceover[1].start = 60), /^voiceover\[1\]\.start is 60, outside 0\.\.59\.999$/],
  ['graphics: the logo as a text', 'checkGraphics', graphics, (g) => (g.endcard.logo = 'yes'), /^endcard\.logo must be true or false, got string$/],
  ['graphics: an end card of 20 s', 'checkGraphics', graphics, (g) => (g.endcard.seconds = 20), /^endcard\.seconds is 20, outside 1\.\.10$/],
  ['graphics: an accent by name', 'checkGraphics', graphics, (g) => (g.look.accent = 'blue'), /^look\.accent "blue" has not the form/],
  ['graphics: too much glow', 'checkGraphics', graphics, (g) => (g.look.glow = 0.5), /^look\.glow is 0\.5, outside 0\.\.0\.22$/],
  ['graphics: an unknown ease', 'checkGraphics', graphics, (g) => (g.look.ease = 'linear'), /^look\.ease "linear" is not one of power3\.out, back\.out\(1\.4\)$/],
  ['graphics: a tint that is too strong', 'checkGraphics', graphics, (g) => (g.look.tint = 0.3), /^look\.tint is 0\.3, outside -0\.15\.\.0\.15$/],
  ['graphics: no grain', 'checkGraphics', graphics, (g) => delete g.look.grain, /^look\.grain is missing$/],
  ['graphics: too loud', 'checkGraphics', graphics, (g) => (g.mix.lufs = -5), /^mix\.lufs is -5, outside -30\.\.-8$/],
  ['graphics: no mix', 'checkGraphics', graphics, (g) => delete g.mix, /^mix is missing$/],
  ['graphics: a wrong version', 'checkGraphics', graphics, (g) => (g.version = '1'), /^version is "1", expected 1$/]
];

// the shots and the graphics of the same plan
const BROKEN_PAIRS = [
  ['pair: a cut moved', (s, g) => (g.cuts[5] = 10), /^graphics\.cuts are not the starts of the shots$/],
  ['pair: a soundbite moved', (s, g) => Object.assign(g.soundbites[0], { start: 16.495, end: 23.005 }), /^soundbites\[0\] is 16\.495\.\.23\.005 in the graphics, 16\.395\.\.22\.905 in the shots \(s9\)$/],
  ['pair: an act moved', (s, g) => (g.acts[1].end = g.acts[2].start = 14), /^acts\.arrival is 6\.224\.\.14 in the graphics, 6\.224\.\.14\.362 in the shots$/],
  ['pair: a soundbite too many', (s, g) => g.soundbites.push({ start: 40, end: 42, words: [{ w: 'Ja.', s: 0.1, e: 0.4 }] }), /^soundbites 2 soundbite shots, 3 soundbites in the graphics$/],
  ['pair: broken shots', (s) => (s.shots[0].kind = 'still'), /^shots: shots\[0\]\.kind "still" is not one of/]
];

function testBroken() {
  for (const [label, check, data, change, pattern] of BROKEN) {
    const copy = clone(data);
    change(copy);
    fails(contract[check](copy), pattern, label);
  }
  for (const [label, change, pattern] of BROKEN_PAIRS) {
    const [s, g] = [clone(shots), clone(graphics)];
    change(s, g);
    fails(contract.checkPair(s, g), pattern, label);
  }
  // one fault gives a short list, not a flood
  const one = clone(shots);
  one.shots[0].anchor.x = 1.2;
  assert.equal(contract.checkShots(one).problems.length, 1);
  // a flood is cut off with a last line that says how much more there was
  const flood = clone(material.videos[0]);
  flood.speech.words = Array.from({ length: 300 }, () => ({ w: '', s: -1, e: -2 }));
  const result = contract.checkInfo(flood);
  assert.equal(result.problems.length, 101);
  assert.match(result.problems[100], /^\.\.\. and \d+ more problems$/);
}

/* ---------- what the contract allows ---------- */

function testAccepted() {
  const accept = (label, check, data, change) => {
    const copy = clone(data);
    change(copy);
    passes(contract[check](copy), label);
  };
  // info: a video without speech, a photo without a date, an unusable element with what ffprobe read, a language Scribe names in three letters
  accept('a video without speech', 'checkInfo', infoVideo, (info) => (info.speech = null));
  accept('a photo without a date', 'checkInfo', infoPhoto, (info) => (info.meta.taken_at = null));
  accept('an unusable element with its meta', 'checkInfo', infoBroken, (info) => (info.meta = { seconds: 12.5, width: 1920, height: 1080 }));
  accept('a language of three letters', 'checkInfo', infoVideo, (info) => (info.speech.language = 'deu'));
  accept('a gap between scenes', 'checkInfo', infoVideo, (info) => (info.scenes[1].in = 32));
  accept('an unknown field', 'checkInfo', infoVideo, (info) => (info.debug = { decodeMs: 812 }));
  // style: festival is party with its alias; a style without any soundbite (party, 30 s)
  accept('festival', 'checkStyle', style, (s) => Object.assign(s, { event_type: 'party', event_alias: 'festival' }));
  accept('no soundbites', 'checkStyle', style, (s) => (s.soundbites = { count: [0, 0], seconds: [2, 3] }));
  // answer: the optional lists and fields may be missing
  accept('an answer without the optional parts', 'checkAnswer', answer, (a) => {
    for (const key of ['soundbites', 'lower_thirds', 'intertitles', 'ai_photos', 'parallax', 'voiceover']) delete a[key];
    delete a.title.sub;
    delete a.endcard.sub;
    delete a.endcard.url;
    for (const act of a.acts) for (const pick of act.picks) for (const key of ['why', 'slow', 'pair']) delete pick[key];
  });
  accept('a lower third with a label only', 'checkAnswer', answer, (a) => Object.assign(a.lower_thirds[1], { name: null, role: null, label: 'Keynote', source: 'generic' }));
  // shots: a dissolve later in the film, a parallax clip with an anchor, a shot of one frame
  accept('a dissolve', 'checkShots', shots, (s) => (s.shots[4].transition = 'dissolve'));
  accept('a parallax clip with an anchor', 'checkShots', shots, (s) => (s.shots[3].anchor = { x: 0.5, y: 0.4 }));
  accept('a shot of one frame', 'checkShots', shots, (s) => (s.shots[0].end = s.shots[1].start = 1 / 24));
  // D18: a photo shown a second time as a detail (zoom, another anchor, a crop), a clip zoomed in, a shot without a face
  accept('a detail of a photo', 'checkShots', shots, (s) => Object.assign(s.shots[10], { zoom: 1.5, fit: 'crop', anchor: { x: 0.37, y: 0.42, face: false } }));
  accept('a clip zoomed in', 'checkShots', shots, (s) => (s.shots[0].zoom = 2));
  accept('a parallax clip without a face', 'checkShots', shots, (s) => (s.shots[3].anchor = { x: 0.5, y: 0.4, face: false }));
  accept('a film cut short by its music', 'checkShots', shots, (s) => {
    s.duration = 57.074;
    s.shots.pop();
  });
  // graphics: a plan without a title (allow_plain), a flash at a cut, no lower thirds and no voice-over
  accept('no title', 'checkGraphics', graphics, (g) => (g.title = null));
  accept('a flash', 'checkGraphics', graphics, (g) => g.transitions.splice(1, 0, { at: g.cuts[20], type: 'flash', frames: 3 }));
  accept('nothing optional', 'checkGraphics', graphics, (g) => Object.assign(g, { lower_thirds: [], intertitles: [], soundbites: [], voiceover: [], transitions: [] }));
}

/* ---------- a check never throws ---------- */

function testNever() {
  const hostile = {
    get version() {
      throw new Error('boom');
    }
  };
  const rubbish = [undefined, null, 0, 42, NaN, 'text', '', true, [], [1, 2], {}, { shots: 'x', cuts: {}, acts: 7 }, Object.create(null), hostile, { version: 1, scenes: [null, 4, 'x'] }];
  for (const name of ['checkInfo', 'checkStyle', 'checkAnswer', 'checkShots', 'checkGraphics']) {
    rubbish.forEach((value, index) => {
      let result;
      assert.doesNotThrow(() => (result = contract[name](value)), `${name}(rubbish[${index}])`);
      assert.equal(result.ok, false, `${name}(rubbish[${index}])`);
      assert.ok(result.problems.length > 0 && result.problems.every((problem) => typeof problem === 'string'), name);
    });
  }
  assert.match(contract.checkShots(hostile).problems.join(' | '), /the check failed: boom/);
  assert.equal(contract.checkPair(null, undefined).ok, false);
  assert.match(contract.checkInfo(undefined).problems[0], /^info is missing$/);
  // the data of the test is not changed by a check
  const before = JSON.stringify([material, style, answer, shots, graphics]);
  contract.checkPair(shots, graphics);
  contract.checkAnswer(answer);
  material.videos.forEach(contract.checkInfo);
  assert.equal(JSON.stringify([material, style, answer, shots, graphics]), before);
}

async function main() {
  testConstants();
  await testFixtures();
  testBroken();
  testAccepted();
  testNever();
  console.log('test-event-video-contract.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
