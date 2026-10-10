'use strict';

// The planner of the event video (WP53, package B): lib/event-video/plan.js and the node event_video.plan of lib/nodes/nodes-event-video.js. No network,
// nothing paid: the language model is replaced by answers of the test. The event, its people and its address are made up (scripts/support/event-video).
//   material    the infos are read and checked, the units get their score, the faults of the specification keep units out
//   grid        the acts on the downbeats for 30, 60 and 90 s, the shots of the style, the soundbites; little material: longer photo shots, details, a shorter film
//   prompt      the rules of spec §6 with the grid, the photos, the soundbites (none without videos), the voice-over only when it is on
//   answer      readAnswer against wrong refs, wrong word ranges, invented names and numbers, the maker of the tool, an answer cut off
//   run         one call; a second try with the problems; empty answers asked again (the second time after a pause); EVENTPLAN_MODEL_FAILED or the plain plan
//   shots       contract.checkPair for every plan; fit only for a detail of a photo (D17); a film of photos only; no format anywhere
//   board       a snapshot of the board for the answer of the fixtures (support/event-video/board-60.txt; EVENT_BOARD_UPDATE=1 writes it again)
//   estimate    the table of spec §2
//   node        the node with the store, ffmpeg for the contact sheet and the language model replaced (in the copy of scripts/run-tests.js)

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const contract = require('../lib/event-video/contract');
const styles = require('../lib/event-video/styles');
const plan = require('../lib/event-video/plan');

const SUPPORT = path.join(__dirname, 'support', 'event-video');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SUPPORT, name), 'utf8'));
const clone = (value) => structuredClone(value);
const round3 = (value) => Math.round(value * 1000) / 1000;

const material60 = load('material-60.json');
const styleFixture = load('style-corporate-fresh.json');
const beats = load('beats-60.json');
const answerOk = load('answer-ok.json');
const infoPhoto = load('info-photo.json');
const BRIEF = material60.brief;

const PRICES = Object.freeze({
  visionPerItem: 0.006,
  speechPerHour: 0.22,
  music: (seconds) => (seconds / 60) * 0.2,
  llm: { inputPerMillion: 4, outputPerMillion: 20, charsPerToken: 3 },
  depth: 0.01,
  clipPerSecond: 0.04,
  voicePerChar: 0.08 / 1000
});
const AI_OPTIONS = Object.freeze({ photoMotion: 'ai', voiceover: true, lowerThirds: true, soundbites: 'auto' });

function contextOf({ material = plan.readMaterial(material60.videos, material60.photos), style = styleFixture, options = AI_OPTIONS, musicSeconds = 62, brief = BRIEF } = {}) {
  const grid = plan.planGrid({ analysis: beats, style, material, musicSeconds, options });
  return { material, grid, style, options, sources: plan.sourcesOf(brief, material), brand: null, brief };
}

// A photo of the material, upright or wide, with or without faces (iPhone sized, like the real test photos: 5712 x 4284)
function photo(index, { upright = false, faces = 0, quality = 4, risk = [], framing = null } = {}) {
  const info = clone(infoPhoto);
  info.id = `photo-${index}`;
  info.meta.width = upright ? 4284 : 5712;
  info.meta.height = upright ? 5712 : 4284;
  info.meta.rotation = 0;
  info.scenes[0].quality = quality;
  info.scenes[0].reasons = quality >= 3 ? ['ok'] : ['blurry'];
  info.scenes[0].faces = faces ? { count: faces, x: 0.42, y: 0.36, size: 0.08 } : { count: 0, x: null, y: null, size: null };
  info.vision.framing = framing || ['wide', 'medium', 'close', 'detail'][index % 4];
  info.vision.score = 3 + (index % 3);
  info.vision.subject = `the event, picture ${index}`;
  info.vision.text_in_image = [];
  info.vision.risk = risk;
  info.vision.people = faces ? '2-5' : '0';
  return info;
}
const photos = (count) => Array.from({ length: count }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0 }));

// A good answer for a grid: the best units by score, every act with the picks it asks for, each unit once
function goodAnswer(ctx, extra = {}) {
  const used = new Set();
  const acts = ctx.grid.acts.map((act) => {
    const picks = [];
    for (const unit of ctx.material.units.slice().sort((a, b) => plan.baseScore(b) - plan.baseScore(a) || a.ref.localeCompare(b.ref))) {
      if (picks.length >= act.picks) break;
      if (used.has(unit.ref) || plan.unitFault(unit, act.act, ctx.style)) continue;
      used.add(unit.ref);
      picks.push({ ref: unit.ref, why: `a good ${unit.framing} shot`, slow: false, pair: null });
    }
    return { act: act.act, picks };
  });
  return { treatment: 'A calm film of the day.', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, endcard: { line: 'Danke. Bis 2027.', sub: null, url: null, source: 'description' }, ...extra };
}

// A model of the test: answers in order (an object or a text is the answer, an Error is thrown, a function is asked), after the script the last one again
function scripted(steps) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    const step = steps.length > 1 ? steps.shift() : steps[0];
    const value = typeof step === 'function' ? step(request) : step;
    if (value instanceof Error) throw value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), usd: 0.3, model: 'anthropic/claude-opus-5.5', usage: { completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 5000 } } };
  };
  return { ask, calls };
}
const emptyError = (finishReason = 'stop') => Object.assign(new Error('the language model returned an empty answer'), { emptyAnswer: true, finishReason, usd: 0.02, completionTokens: 30, reasoningTokens: 0 });

async function run(extra = {}) {
  const sleeps = [];
  const result = await plan.runEventPlanner({
    brief: BRIEF,
    style: styleFixture,
    videos: material60.videos,
    photos: material60.photos,
    analysis: beats,
    musicSeconds: 62,
    options: AI_OPTIONS,
    prices: PRICES,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra
  });
  return { result, sleeps };
}

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('no error');
};

function passesContract(result, label) {
  const check = contract.checkPair(result.shots, result.graphics);
  assert.deepEqual(check.problems, [], label);
  assert.ok(contract.checkShots(result.shots).ok && contract.checkGraphics(result.graphics).ok, label);
}

/* ---------- the material ---------- */

function testMaterial() {
  const material = plan.readMaterial(material60.videos, material60.photos);
  assert.equal(material.videos.length, 8);
  assert.equal(material.photos.length, 7);
  assert.equal(material.usable, 13);
  assert.deepEqual([material.videos[7].usable, material.videos[7].reason, material.photos[6].reason], [false, 'decode_failed', 'heic']);
  assert.equal(material.units.length, 26);
  assert.deepEqual(material.speechVideos, [0, 4]);
  // a text that is not an info cannot be used and says why
  const broken = plan.readMaterial(['{"version":2}', 'not json'], []);
  assert.equal(broken.usable, 0);
  assert.match(broken.videos[0].reason, /^the analysis is not valid/);
  const wrongKind = plan.readMaterial([JSON.stringify(infoPhoto)], []);
  assert.match(wrongKind.videos[0].reason, /of a photo, not of a video/);
  // the score (spec §4): vision.score + quality / 2 + 1 for an emotion that is not neutral - the soft risks
  const p3 = material.byRef.get('p3');
  assert.equal(plan.baseScore(p3), p3.vision + p3.quality / 2 + (p3.emotion !== 'neutral' ? 1 : 0) - 1);
  // the faults: quality, hard risks, dark and shaky only in the peak of a party
  const dark = material.byRef.get('v6#2');
  assert.match(plan.unitFault(dark, 'peak', styleFixture), /quality 2/);
  const darkGood = { ...dark, quality: 3 };
  assert.match(plan.unitFault(darkGood, 'peak', styleFixture), /dark and shaky/);
  assert.equal(plan.unitFault(darkGood, 'peak', styles.combineStyle({ event_type: 'party', mood: 'fast' })), null);
  assert.match(plan.unitFault(darkGood, 'people', styles.combineStyle({ event_type: 'party', mood: 'fast' })), /dark and shaky/);
  assert.match(plan.unitFault({ ...p3, hard: ['child'] }, 'hook', styleFixture), /risk child/);
}

/* ---------- the grid ---------- */

function testFactsAndHashes() {
  const empty = plan.readMaterial();
  const source = (text) => plan.sourcesOf(text, empty).brief;
  for (const month of ['September', 'Sept.', 'Sep', 'sept.', 'septiembre']) {
    assert.deepEqual(plan.unknownFacts('17.09.2030', source(`17 ${month} 2030`)), []);
    assert.deepEqual(plan.unknownFacts(`17 ${month} 2030`, source('17.09.2030')), []);
  }
  for (const run of ['017.09.2030', '17/9/2030', "17'09'2030", '17’09’2030', '17:09:2030', '17-09-2030', '17,09,2030']) {
    assert.deepEqual(plan.unknownFacts(run, source('17 September 2030')), []);
  }
  assert.deepEqual(plan.unknownFacts('17092030', source('17.09.2030')), []);
  assert.ok(plan.unknownFacts('18.09.2030', source('17 September 2030')).length);
  assert.ok(plan.unknownFacts('17 October 2030', source('17.09.2030')).length);
  assert.ok(plan.unknownFacts('SEP', source('9'), 'de', { free: true }).length);
  const generic = source('three 3');
  for (const text of ['Dabeisein', 'Perspektiven', 'Entwicklung', 'Miteinander']) {
    assert.deepEqual(plan.unknownFacts(text, generic, 'de', { free: true }), []);
    assert.ok(plan.unknownFacts(text, generic).length);
  }
  for (const text of ['Nordtal', 'Elena', 'Novexa', 'Basel', 'testAIn', 'HR', '18', 'Panel2']) {
    for (const free of [true, false]) assert.ok(plan.unknownFacts(text, generic, 'de', { free }).length, text);
  }
  const ctx = contextOf({ brief: `${BRIEF} 17 September 2030` });
  const answer = clone(answerOk);
  answer.endcard.line = 'Danke fürs Dabeisein';
  answer.title.sub = '17.09.2030';
  answer.intertitles = [{ act: 'programme', text: 'Entwicklung', source: 'generic' }];
  answer.voiceover = [{ act: 'arrival', text: 'Danke fürs Dabeisein' }];
  let checked = plan.validateAnswer(answer, ctx);
  assert.ok(checked.ok, checked.problems.join(' | '));
  answer.title.sub = 'Dabeisein';
  answer.endcard.sub = 'Dabeisein';
  checked = plan.validateAnswer(answer, ctx);
  for (const field of ['title.sub', 'endcard.sub']) assert.ok(checked.problems.some((problem) => problem.startsWith(field)), field);
  answer.title.text = 'Dabeisein';
  checked = plan.validateAnswer(answer, ctx);
  assert.ok(checked.problems.some((problem) => problem.startsWith('title.text')));
  answer.lower_thirds[0].name = 'Dabeisein';
  answer.lower_thirds[0].role = 'Entwicklung';
  checked = plan.validateAnswer(answer, ctx);
  assert.ok(checked.problems.some((problem) => problem.startsWith('lower third 0: the name')));
  assert.ok(checked.problems.some((problem) => problem.startsWith('lower third 0 role')));
  const input = photos(10);
  input[0].scenes[0].hash = '0000000000000000';
  input[1].scenes[0].hash = '000000000000003f'; // Six bits: duplicate, vision wins.
  input[0].vision.score = 3;
  input[1].vision.score = 5;
  input[2].scenes[0].hash = '0000000000003fc0'; // Fourteen bits from p1: similar.
  input[3].scenes[0].hash = 'ffffffffffffffff';
  const material = plan.readMaterial([], input);
  assert.equal(material.byRef.has('p0'), false);
  assert.equal(material.photos[0].reason, 'duplicate of p1');
  assert.ok(material.byRef.get('p1').similar.includes('p2'));
  assert.match(plan.materialText(material).text, /p1 looks like p2/);
  assert.equal(plan.hashDistance('0000000000000000', 'ffffffffffffffff'), 64);
  const equal = [photo(0), photo(1), photo(2)];
  for (const info of equal) { info.scenes[0].hash = 'aaaaaaaaaaaaaaaa'; info.vision.score = 4; }
  equal[1].scenes[0].quality = equal[2].scenes[0].quality = 5;
  assert.deepEqual(plan.readMaterial([], equal).units.map((unit) => unit.ref), ['p1']);
  assert.equal(plan.readMaterial([], photos(10)).units.length, 10);
  for (const distance of [6, 7, 14, 15]) {
    const pair = [photo(0), photo(1)];
    pair[0].scenes[0].hash = '0000000000000000';
    pair[1].scenes[0].hash = ((1n << BigInt(distance)) - 1n).toString(16).padStart(16, '0');
    const selected = plan.readMaterial([], pair);
    assert.equal(selected.units.length, distance <= 6 ? 1 : 2);
    if (distance > 6) assert.equal(selected.units[0].similar.length, distance <= 14 ? 1 : 0);
  }
  const videos = [load('info-video.json'), load('info-video.json')];
  for (const info of videos) for (const scene of info.scenes) scene.hash = '0123456789abcdef';
  const scenes = plan.readMaterial(videos);
  assert.equal(scenes.units.length, 1);
  assert.equal(scenes.duplicates.size, videos.reduce((sum, info) => sum + info.scenes.length, 0) - 1);
}

async function testSimilarShots() {
  const input = photos(18);
  // Unique but mutually similar: the planner must insert alternatives, including at act boundaries.
  input[0].scenes[0].hash = '0000000000000000';
  input[1].scenes[0].hash = '000000000000007f';
  input[2].scenes[0].hash = '0000000000003f80';
  const ctx = contextOf({ material: plan.readMaterial([], input), options: { soundbites: 'off' } });
  const answer = goodAnswer(ctx);
  const picks = answer.acts.flatMap((act) => act.picks);
  const order = ['p0', 'p1', 'p2', ...ctx.material.units.map((unit) => unit.ref).filter((ref) => !['p0', 'p1', 'p2'].includes(ref))];
  picks.forEach((pick, index) => { pick.ref = order[index]; });
  const { result } = await run({ videos: [], photos: input, options: { soundbites: 'off' }, ask: scripted([answer]).ask });
  passesContract(result, 'hash-aware photos');
  for (let index = 1; index < result.shots.shots.length; index += 1) {
    const before = result.shots.shots[index - 1];
    const after = result.shots.shots[index];
    const distance = plan.hashDistance(input[before.source].scenes[0].hash, input[after.source].scenes[0].hash);
    assert.ok(distance > 14, `adjacent similar sources ${before.source}, ${after.source}`);
  }
  const duplicates = clone(input);
  duplicates[3].scenes[0].hash = duplicates[0].scenes[0].hash;
  duplicates[3].vision.score = 5;
  duplicates[0].vision.score = 3;
  const dupeCtx = contextOf({ material: plan.readMaterial([], duplicates), options: { soundbites: 'off' } });
  const { result: dupeResult } = await run({ videos: [], photos: duplicates, options: { soundbites: 'off' }, ask: scripted([goodAnswer(dupeCtx)]).ask });
  assert.match(dupeResult.board, /p0 \(duplicate of p3\)/);
  assert.ok(dupeResult.shots.shots.every((shot) => shot.source !== 0));
  const alike = photos(5);
  alike[0].scenes[0].hash = '0000000000000000';
  for (let index = 1; index < alike.length; index += 1) {
    alike[index].scenes[0].hash = (127n << BigInt((index - 1) * 7)).toString(16).padStart(16, '0');
  }
  const alikeCtx = contextOf({ material: plan.readMaterial([], alike), options: { soundbites: 'off' } });
  const { result: noAlternative } = await run({ videos: [], photos: alike, options: { soundbites: 'off' }, ask: scripted([goodAnswer(alikeCtx)]).ask });
  passesContract(noAlternative, 'similar photos without an alternative');
}

function testGrid() {
  const material = plan.readMaterial(material60.videos, material60.photos);
  for (const length of [30, 60, 90]) {
    const style = styles.combineStyle({ event_type: 'corporate', mood: 'fresh', length });
    const grid = plan.planGrid({ analysis: beats, style, material, musicSeconds: length + 2, options: AI_OPTIONS });
    assert.equal(grid.acts.length, 6);
    assert.equal(grid.acts[0].start, 0);
    assert.equal(grid.acts[5].end, grid.duration);
    // WP53 D: the soundbites of a short film fit into 15 % of it, also where the shortest one of the style is longer (a conference: 5 to 8 s)
    for (const eventType of ['corporate', 'conference', 'workshop', 'launch', 'party', 'celebration']) {
      const seconds = plan.planGrid({ analysis: beats, style: styles.combineStyle({ event_type: eventType, mood: 'fresh', length }), material, musicSeconds: length + 2, options: AI_OPTIONS }).soundbites.seconds;
      assert.ok(seconds[0] <= seconds[1] && seconds[1] <= 0.15 * length + 1e-9, `${eventType} ${length} s: soundbites of ${seconds.join(' to ')} s`);
    }
    grid.acts.forEach((act, index) => {
      if (index) assert.equal(act.start, grid.acts[index - 1].end);
      assert.ok(act.end - act.start >= 1.5, `${length}: ${act.act} too short`);
      assert.ok(act.slots >= 1 && act.picks >= 1 && act.picks <= act.slots);
    });
    // the boundaries on downbeats (the analysis is 62 s; the beats go on at their pace for 90 s)
    for (const act of grid.acts.slice(1)) assert.ok(grid.downbeats.some((beat) => Math.abs(beat - act.start) < 0.002), `${length}: ${act.act} starts off a downbeat at ${act.start}`);
    // the share of every act within two bars of the nominal one
    let share = 0;
    for (const act of grid.acts.slice(0, 5)) {
      share += contract.ACT_SHARES[act.act];
      assert.ok(Math.abs(act.end - share * grid.duration) <= 2.1, `${length}: ${act.act} ends at ${act.end}`);
    }
    assert.ok(grid.beats[grid.beats.length - 1] >= grid.duration - 1);
    assert.deepEqual(grid.soundbites.count, styles.soundbitesFor('corporate', length).count);
    assert.deepEqual(grid.soundbites.acts, ['programme', 'people', 'arrival'].slice(0, grid.soundbites.count[1]));
  }
  const g60 = contextOf().grid;
  assert.deepEqual(
    g60.acts.map((act) => [act.act, act.start, act.end]),
    load('graphics-60.json').acts.map((act) => [act.act, act.start, act.end]),
    'the acts of the fixture graphics-60.json'
  );
  assert.deepEqual(g60.soundbites.seconds, [4, 7]);
  // party: the soundbites of the table (2 to 3 s at 60 s, at most one), none at 30 s; conference 5 to 8 s
  const party = plan.planGrid({ analysis: beats, style: styles.combineStyle({ event_type: 'party', mood: 'fast' }), material, options: AI_OPTIONS });
  assert.deepEqual([party.soundbites.count, party.soundbites.seconds], [[0, 1], [2, 3]]);
  const party30 = plan.planGrid({ analysis: beats, style: styles.combineStyle({ event_type: 'party', mood: 'fast', length: 30 }), material, options: AI_OPTIONS });
  assert.deepEqual(party30.soundbites.count, [0, 0]);
  // soundbites off, and a film without clips: none
  assert.deepEqual(plan.planGrid({ analysis: beats, style: styleFixture, material, options: { soundbites: 'off' } }).soundbites.count, [0, 0]);
  // own music shorter than the film: the film 2 s shorter than the music
  const own = plan.planGrid({ analysis: beats, style: styleFixture, material, musicSeconds: 41, options: AI_OPTIONS });
  assert.equal(own.duration, 39);
  assert.match(own.notes[0], /the music is 41 s long: the film is 39 s instead of 60 s/);

  // 14 photos for 60 s (the real test material): the shots get longer, nothing is cut
  const fourteen = plan.readMaterial([], photos(14));
  const conference = styles.combineStyle({ event_type: 'conference', mood: 'fresh' });
  const g14 = plan.planGrid({ analysis: beats, style: conference, material: fourteen, options: AI_OPTIONS });
  assert.equal(g14.duration, 60);
  assert.equal(g14.stretched, true);
  assert.equal(g14.details, 0);
  assert.equal(g14.picks, 14);
  assert.equal(g14.shortened, null);
  assert.ok(g14.acts.every((act) => act.shotSeconds <= plan.PHOTO_LONG + 1e-9 || act.act === 'close'));
  assert.deepEqual(g14.soundbites.count, [0, 0], 'no videos: no soundbites');
  // 14 photos for 90 s: longer shots and photos once more as a detail
  const g90 = plan.planGrid({ analysis: beats, style: styles.combineStyle({ event_type: 'celebration', mood: 'calm', length: 90 }), material: fourteen, musicSeconds: 92, options: AI_OPTIONS });
  assert.equal(g90.duration, 90);
  assert.equal(g90.details, g90.picks - 14);
  assert.ok(g90.details > 0 && g90.details <= 14);
  assert.equal(g90.acts.reduce((sum, act) => sum + act.picks, 0), 14, 'the model is asked for every photo once');
  assert.match(g90.notes.join(' '), /shown a second time as a detail/);
  // 6 photos for 90 s: not even so: the film is shortened, with a note
  const six = plan.readMaterial([], photos(6));
  const g6 = plan.planGrid({ analysis: beats, style: styles.combineStyle({ event_type: 'conference', mood: 'fresh', length: 90 }), material: six, musicSeconds: 92, options: AI_OPTIONS });
  assert.ok(g6.duration < 90);
  assert.deepEqual(g6.shortened, { from: 90, to: g6.duration });
  assert.match(g6.notes.join(' '), /the film is shortened to \d+ s/);
  assert.ok(g6.picks <= 12);

  // beats that repeat or lie too close (a spacing of 0) once hung the server, the estimate included: duplicates go, the pace falls back to the BPM
  for (const [label, analysis, spacing] of [
    ['the same beat four times', { bpm: 120, duration: 62, beats: [1, 1, 1, 1, 2], downbeats: [1] }, 0.5],
    ['beats 1 ms apart', { bpm: 0, duration: 62, beats: [0, 0.001, 0.002, 0.003, 0.004, 0.005], downbeats: [0] }, 60 / styles.derive(styleFixture).bpm],
    ['a BPM of a million', { bpm: 1e6, duration: 62, beats: [], downbeats: [] }, 60 / styles.derive(styleFixture).bpm]
  ]) {
    const grid = plan.planGrid({ analysis: JSON.stringify(analysis), style: styleFixture, material, musicSeconds: 62, options: AI_OPTIONS });
    assert.ok(grid.beats.length < 200, `${label}: ${grid.beats.length} beats`);
    const gaps = grid.beats.slice(1).map((beat, index) => beat - grid.beats[index]);
    assert.ok(gaps.slice(-10).every((gap) => Math.abs(gap - spacing) < 0.002), `${label}: the pace ${gaps.slice(-3).join(', ')}`);
    assert.equal(grid.acts[5].end, grid.duration, label);
  }
}

/* ---------- the prompt ---------- */

function testPrompt() {
  const ctx = contextOf();
  const system = plan.systemPrompt(ctx);
  assert.match(system, /^You are the editor of an event aftermovie/);
  assert.ok(system.includes(styles.styleBlock(styleFixture)));
  for (const act of ctx.grid.acts) assert.ok(system.includes(`${act.act} ${act.picks} pick`), act.act);
  assert.match(system, /Choose up to 4 of the photos you pick for AI animation/);
  assert.match(system, /Soundbites: pick 1 to 2 complete, intelligible sentences of 4 to 7 s/);
  assert.match(system, /Voice-over \("voiceover"\): 2 or 3 short sentences in German \(Swiss High German/);
  assert.match(system, /Intertitles \(at most 2\)/);
  assert.match(system, /Prefer quality 4-5 and tags speaker, detail, b_roll/);
  assert.ok(system.includes(plan.answerSchema()));
  const user = plan.userPrompt({ brief: BRIEF, style: styleFixture, grid: ctx.grid, material: ctx.material });
  assert.ok(user.startsWith(`EVENT (the only source of facts)\n${BRIEF}`));
  assert.match(user, /event corporate, mood fresh, length 60 s, music 118\.04 BPM, 62 s/);
  assert.match(user, /\nv0 video 96\.4 s, 30 fps: keynote on stage/);
  assert.match(user, /\n {2}v0#1 31\.2-70\.5 s, quality 5, static, faces 1/);
  assert.match(user, /transcript \(de\): 0 Guten 1 Morgen 2 zusammen\. 3 Willkommen/);
  assert.match(user, /\np2 photo landscape, quality 4, faces 42/);
  assert.ok(!/\bv7\b|\bp6\b/.test(user), 'the elements that cannot be used are not in the prompt');
  assert.ok(!/YOUR LAST ANSWER/.test(user));
  const again = plan.userPrompt({ brief: BRIEF, style: styleFixture, grid: ctx.grid, material: ctx.material, problems: ['p9 is not in the material'], previous: '{"acts":[]}' });
  assert.match(again, /YOUR LAST ANSWER HAD THESE PROBLEMS[^\n]*\n- p9 is not in the material\n\nYOUR LAST ANSWER\n\{"acts":\[\]\}/);
  // the code moves the photos: parallax; the voice-over off; lower thirds off
  const code = plan.systemPrompt({ ...ctx, options: { photoMotion: 'code', parallax: true, voiceover: false, lowerThirds: false } });
  assert.match(code, /Choose up to 4 of the photos you pick with clear depth for "parallax"/);
  assert.match(code, /No voice-over: leave "voiceover" empty/);
  assert.match(code, /No lower thirds: leave "lower_thirds" empty/);
  // photos only (no videos): no soundbites and no sound of the clips, and the material is short
  const only = contextOf({ material: plan.readMaterial([], photos(14)), style: styles.combineStyle({ event_type: 'conference', mood: 'fresh' }) });
  const onlySystem = plan.systemPrompt(only);
  assert.match(onlySystem, /There are no videos, only photos: there are no soundbites and no sound of the clips\. Leave "soundbites" and "lower_thirds" empty\./);
  assert.match(onlySystem, /The material is short \(14 usable clips and photos\): the shots are long and calm, photos up to about 4\.5 s/);
  const ninety = contextOf({ material: plan.readMaterial([], photos(14)), style: styles.combineStyle({ event_type: 'celebration', mood: 'calm', length: 90 }), musicSeconds: 92 });
  assert.match(plan.systemPrompt(ninety), /the code shows \d+ photos a second time as a detail\. Never repeat a ref yourself\./);
  // a long material is cut by the score (about 25 000 tokens)
  const talk = clone(material60.videos[0]);
  talk.speech.words = Array.from({ length: 3000 }, (_, index) => ({ w: `word${index}`, s: round3(index * 0.03), e: round3(index * 0.03 + 0.02) }));
  const many = plan.readMaterial(Array.from({ length: 6 }, () => talk), []);
  assert.equal(many.usable, 6);
  const text = plan.materialText(many);
  assert.ok(text.text.length <= plan.MAX_MATERIAL_CHARS);
  assert.ok(text.left.length > 0);
}

/* ---------- the answer ---------- */

function testAnswer() {
  const ctx = contextOf();
  // the answer of the fixtures: nothing replaced, the soundbites whole sentences, the texts kept
  const ok = plan.readAnswer(JSON.stringify(answerOk), ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.cut, false);
  assert.equal(ok.replaced, 0);
  assert.deepEqual(ok.problems, []);
  const c = ok.content;
  assert.deepEqual(c.soundbites.map((bite) => [bite.ref, bite.wordFrom, bite.wordTo, bite.start, bite.end]), [
    ['v0', 3, 17, 39.5, 46.01],
    ['v4', 10, 21, 7.17, 11.71]
  ]);
  assert.deepEqual(c.title, { text: 'Innovation Day 2026', sub: 'Zürich, 12. März 2026', source: 'description' });
  assert.deepEqual(c.lowerThirds.map((third) => third.name), ['Anna Muster', 'Luca Beispiel']);
  assert.deepEqual(c.intertitles.map((title) => title.text), ['320 Gäste', '12 Workshops']);
  assert.deepEqual(c.aiPhotos.map((item) => item.ref), ['p1', 'p2']);
  assert.deepEqual(c.parallax, [], 'no parallax when the photos are animated by AI');
  assert.match(ok.notes.join(' '), /parallax p0 was left out: the photos are animated by AI/);
  assert.equal(c.voiceover.length, 2);
  assert.deepEqual(c.endcard, { line: 'Danke. Bis 2027.', sub: null, url: 'innovation-day.example', source: 'description' });
  assert.equal(c.acts.programme[3].pair.ref, 'v3#2');

  // wrong refs: not in the material, unusable, picked twice, dark and shaky outside the peak of a party, a hard risk
  const wrong = clone(answerOk);
  wrong.acts[0].picks[0].ref = 'v99#0';
  wrong.acts[1].picks[0].ref = 'p6';
  wrong.acts[2].picks[1].ref = 'v0#0';
  wrong.acts[4].picks[1].ref = 'v6#2';
  wrong.acts[4].picks[2].ref = 'banana';
  const read = plan.readAnswer(JSON.stringify(wrong), ctx);
  assert.equal(read.replaced, 5);
  const said = read.problems.join('\n');
  assert.match(said, /hook pick 0: "v99#0" is not in the material; the code put \S+ there/);
  assert.match(said, /arrival pick 0: p6 cannot be used \(heic\)/);
  assert.match(said, /programme pick 1: v0#0 is picked twice/);
  assert.match(said, /peak pick 1: v6#2 cannot be used here: quality 2 is below 3/);
  assert.match(said, /peak pick 2: "banana" is not in the material/);
  const all = contract.ACTS.flatMap((act) => read.content.acts[act].flatMap((pick) => [pick.unit.ref, ...(pick.pair ? [pick.pair.ref] : [])]));
  assert.equal(new Set(all).size, all.length, 'no unit twice');
  assert.ok(!all.includes('v6#2') && !all.includes('p6'));

  // wrong word ranges and sentences of the wrong length
  const words = clone(answerOk);
  words.soundbites = [
    { ref: 'v0', word_from: 3, word_to: 400, speaker: null, role: null, source: 'transcript' },
    { ref: 'v1', word_from: 0, word_to: 3, speaker: null, role: null, source: 'transcript' },
    { ref: 'v0', word_from: 0, word_to: 20, speaker: null, role: null, source: 'transcript' },
    { ref: 'v4', word_from: 12, word_to: 14, speaker: null, role: null, source: 'transcript' }
  ];
  words.lower_thirds = [{ soundbite: 3, name: 'Luca Beispiel', role: null, label: null, source: 'description' }];
  const bites = plan.readAnswer(JSON.stringify(words), ctx);
  const told = bites.problems.join('\n');
  assert.match(told, /soundbite 0: the words 3 to 400 are not in the transcript of v0 \(0 to 20\); it was left out/);
  assert.match(told, /soundbite 1: v1 has no transcript; it was left out/);
  assert.match(told, /soundbite 2: the words 0 to 20 of v0 make 9\.54 s as whole sentences; a soundbite has 4 to 7 s; it was left out/);
  // words 12 to 14 snap out to their sentence 10 to 15 (2.33 s, too short) and take the next one: 10 to 21 (4.54 s)
  assert.deepEqual(bites.content.soundbites.map((bite) => [bite.ref, bite.wordFrom, bite.wordTo]), [['v4', 10, 21]]);
  assert.deepEqual(bites.content.lowerThirds, [{ soundbite: 0, name: 'Luca Beispiel', role: null, label: null }]);

  // invented names and numbers, and the maker of the tool
  const invented = clone(answerOk);
  invented.title = { text: 'Gala Night 2031', sub: 'Bern, 4. Mai', source: 'description' };
  invented.lower_thirds = [
    { soundbite: 0, name: 'Max Erfunden', role: 'CEO', label: null, source: 'description' },
    { soundbite: 1, name: 'Kuble', role: null, label: null, source: 'description' }
  ];
  invented.intertitles = [
    { act: 'arrival', text: '500 Gäste', source: 'description' },
    { act: 'programme', text: 'Made with Kuble', source: 'description' }
  ];
  invented.endcard = { line: 'Danke, Kuble!', sub: null, url: 'kuble.ai', source: 'description' };
  invented.voiceover = [{ act: 'arrival', text: 'Willkommen in Basel bei der Gala.' }];
  const facts = plan.readAnswer(JSON.stringify(invented), ctx);
  const factText = facts.problems.join('\n');
  assert.equal(facts.content.title, null, 'an invented title is removed');
  assert.match(factText, /title\.text «Gala Night 2031» names «Gala», «2031», which are not in the description/);
  assert.deepEqual(facts.content.lowerThirds, [{ soundbite: 0, name: null, role: 'CEO', label: null }], 'the invented name goes, the role stays; nothing stays of the other');
  assert.match(factText, /lower third 0: the name «Max Erfunden» is not in the description/);
  assert.deepEqual(facts.content.intertitles, []);
  assert.match(factText, /intertitle 0 «500 Gäste» names «500»/);
  assert.match(factText, /intertitle 1 names the tool or its maker/);
  assert.deepEqual(facts.content.endcard, { line: 'Danke', sub: null, url: null, source: 'generic' }, 'the end card falls back to the generic thanks');
  assert.match(factText, /endcard\.line names the tool or its maker/);
  assert.deepEqual(facts.content.voiceover, []);
  assert.match(factText, /voice-over 0 names «Basel», «Gala»/);
  const onScreen = JSON.stringify([facts.content.title, facts.content.lowerThirds, facts.content.intertitles, facts.content.endcard]);
  assert.ok(!/kuble/i.test(onScreen));
  // the generic thanks in every language, and the facts of the other languages
  for (const [language, line] of [['en', 'Thank you'], ['es', 'Gracias']]) {
    const style = { ...styleFixture, language };
    const other = plan.readAnswer(JSON.stringify({ ...answerOk, endcard: { line: 'Kuble', source: 'generic' } }), contextOf({ style }));
    assert.equal(other.content.endcard.line, line);
  }
  const sources = plan.sourcesOf('testAIn x Northern Science Days: Automation im Daten-Zeitalter. 17. September 2030, Basel Nordtal. Drei Labor-Stationen.', plan.readMaterial([], []));
  assert.deepEqual(plan.unknownFacts('Automation im Daten-Zeitalter', sources.all, 'de'), []);
  assert.deepEqual(plan.unknownFacts('3 Labor-Stationen', sources.all, 'de'), [], 'a number written as a word counts');
  assert.deepEqual(plan.unknownFacts('testAIn 2030 in Basel', sources.all, 'de'), []);
  assert.deepEqual(plan.unknownFacts('Danke. Bis bald.', sources.all, 'de'), []);
  assert.deepEqual(plan.unknownFacts('Thanks for a great day in Basel', sources.all, 'en'), []);
  assert.deepEqual(plan.unknownFacts('See you in Geneva', sources.all, 'en'), ['Geneva']);
  assert.deepEqual(plan.unknownFacts('TestLabs x Northern Science Days', sources.all, 'en'), ['TestLabs']);

  // an answer cut off: the complete acts are kept, the rest is filled, the second try is told
  const text = JSON.stringify(answerOk);
  const cutAt = text.indexOf('{"act":"people"');
  const cut = plan.readAnswer(text.slice(0, cutAt + 40), ctx);
  assert.equal(cut.ok, true);
  assert.equal(cut.cut, true);
  assert.match(cut.problems[0], /Your answer was cut off/);
  assert.deepEqual(cut.content.acts.hook.map((pick) => pick.unit.ref).slice(0, 3), ['v1#0', 'p1', 'v0#0']);
  assert.deepEqual(cut.content.acts.programme.map((pick) => pick.unit.ref).slice(0, 4), ['v0#1', 'v3#0', 'p4', 'v3#1']);
  assert.ok(cut.content.acts.peak.length >= 1, 'the missing acts are filled');
  assert.ok(cut.replaced > 0);
  assert.equal(cut.content.title, null);
  assert.deepEqual(plan.salvageAnswer('{"treatment":"x","acts":[{"act":"hook","picks":[{"ref":"v1#0"}]},{"act":"arr').data, { treatment: 'x', acts: [{ act: 'hook', picks: [{ ref: 'v1#0' }] }] });
  // no JSON at all
  const none = plan.readAnswer('I would rather not.', ctx);
  assert.deepEqual([none.ok, none.content], [false, null]);
  // too many and too few picks
  const counts = clone(answerOk);
  counts.acts[0].picks = Array.from({ length: 9 }, (_, index) => ({ ref: ['v1#0', 'p1', 'v0#0', 'v0#2', 'v2#0', 'p0', 'v3#0', 'v5#0', 'v5#1'][index] }));
  counts.acts[5].picks = [];
  const counted = plan.readAnswer(JSON.stringify(counts), ctx);
  assert.match(counted.problems.join('\n'), /the act hook has 9 picks; the grid asks for \d+ \(plus or minus 2\): the code left out the last/);
  assert.ok(counted.content.acts.close.length >= 1);
}

// WP53 review: a soundbite shows its clip, so a clip with a hard risk gives none and a soundbite over a scene below quality 3 is left out
async function testSoundbiteRisks() {
  const videos = clone(material60.videos);
  videos[0].vision.risk = ['child'];
  const material = plan.readMaterial(videos, material60.photos);
  assert.deepEqual(material.speechVideos, [4], 'the clip with a child gives no soundbite');
  const ctx = contextOf({ material });
  const prompt = plan.userPrompt({ brief: BRIEF, style: ctx.style, grid: ctx.grid, material });
  assert.match(prompt, /\n {2}no soundbites from this clip: it has the risk child\n/);
  assert.equal(prompt.split('\n').filter((line) => line.startsWith('  transcript (')).length, 1, 'the transcript of v4 only');
  const read = plan.readAnswer(JSON.stringify(answerOk), ctx);
  assert.match(read.problems.join('\n'), /soundbite 0: v0 cannot give a soundbite: it has the risk child; it was left out\./);
  assert.deepEqual(read.content.soundbites.map((bite) => bite.ref), ['v4']);
  // a soundbite over a scene of quality 2 (the clip has a good scene as well): left out, the clip stays a speaker
  const dim = clone(material60.videos);
  dim[4].scenes[0].quality = 2;
  dim[4].scenes[0].reasons = ['blurry'];
  const dimCtx = contextOf({ material: plan.readMaterial(dim, material60.photos) });
  assert.deepEqual(dimCtx.material.speechVideos, [0, 4]);
  const dimRead = plan.readAnswer(JSON.stringify(answerOk), dimCtx);
  assert.match(dimRead.problems.join('\n'), /soundbite 1: the words 10 to 21 of v4 show a picture that cannot be used: scene 0 has quality 2, below 3; it was left out\./);
  assert.deepEqual(dimRead.content.soundbites.map((bite) => bite.ref), ['v0']);
  // the run of the review: v0 and v4 with a child, the model gives soundbites of both all the same: no soundbite of them in the film
  const both = clone(material60.videos);
  for (const index of [0, 4]) both[index].vision.risk = ['child'];
  const model = scripted([answerOk]);
  const { result } = await run({ ask: model.ask, videos: both, options: { ...AI_OPTIONS, allowPlain: true } });
  passesContract(result, 'clips with a child');
  assert.equal(result.plain, false);
  assert.deepEqual(result.shots.shots.filter((shot) => shot.kind === 'soundbite' || (shot.kind === 'video' && [0, 4].includes(shot.source))), []);
  assert.match(model.calls[0].system, /No soundbites in this film \(no clip has speech that can be used\)/);
}

// WP53 review: the voice-over fits its act (about 14 characters a second); the planner places it by the estimated length and never lets it run past the end
async function testVoiceover() {
  const style30 = styles.combineStyle({ event_type: 'corporate', mood: 'fresh', length: 30 });
  const ctx = contextOf({ style: style30, musicSeconds: 32 });
  const arrival = plan.voiceChars(ctx.grid, 'arrival');
  const close = plan.voiceChars(ctx.grid, 'close');
  const closeAct = ctx.grid.acts.find((act) => act.act === 'close');
  assert.equal(close, Math.floor((closeAct.end - closeAct.start - 0.4 - 0.3) * plan.VOICE_CHARS_PER_SECOND));
  assert.ok(close < 63 && arrival >= 69, `${arrival} / ${close}`);
  assert.match(plan.systemPrompt(ctx), new RegExp(`speaks about 14 characters a second: at most ${arrival} characters in arrival and ${close} in close`));
  // the close line of the fixtures (63 characters, two sentences) is too long for 30 s: its first sentence stays
  const read = plan.readAnswer(JSON.stringify(answerOk), ctx);
  assert.deepEqual(read.content.voiceover.map((line) => line.text), ['Ein Tag voller Ideen: 320 Gäste kamen zum Innovation Day nach Zürich.', 'Danke an alle, die dabei waren.']);
  assert.match(read.notes.join(' '), /voice-over 1 was shortened to the sentences that fit into \d+ characters/);
  // one long sentence: left out, and the model hears it
  const long = clone(answerOk);
  long.voiceover = [{ act: 'close', text: 'Danke an alle Gäste, Referentinnen und Referenten des Innovation Day in Zürich für diesen inspirierenden Tag.' }];
  const longRead = plan.readAnswer(JSON.stringify(long), ctx);
  assert.deepEqual(longRead.content.voiceover, []);
  assert.match(longRead.problems.join('\n'), /voice-over 0 has 109 characters; the act close has room for \d+ \(about 14 a second\): it was left out\./);
  // the run: every line ends before the end of the film by its estimate, the lines of the voice and the graphics agree
  const { result } = await run({ ask: scripted([answerOk]).ask, style: style30, musicSeconds: 32 });
  passesContract(result, '30 s with voice');
  assert.equal(result.voLines.length, result.graphics.voiceover.length);
  result.graphics.voiceover.forEach((line) => {
    const seconds = [...result.voLines[line.index]].length / plan.VOICE_CHARS_PER_SECOND;
    assert.ok(line.start + seconds <= result.graphics.duration - 0.3 + 1e-6, `line ${line.index} at ${line.start} for ${seconds} s`);
  });
  // a line the graphics cannot place is left out with its voice: the list of the voice and the indices stay together
  const content = clone(read.content);
  const made = { shots: result.shots, notes: [], biteOrder: [], pageTransitions: [] };
  const lines = { ...content, soundbites: [], lowerThirds: [], voiceover: [{ act: 'arrival', text: 'Kurz.' }, { act: 'close', text: 'x'.repeat(170) }, { act: 'close', text: 'Danke.' }] };
  const graphics = plan.toGraphics(lines, made, { ...ctx, grid: { ...ctx.grid, duration: result.graphics.duration } });
  assert.deepEqual(lines.voiceover.map((line) => line.text), ['Kurz.', 'Danke.']);
  assert.deepEqual(graphics.voiceover.map((line) => line.index), [0, 1]);
  assert.match(made.notes.join(' '), /voice-over 1 \(about 12\.14 s\) fits nowhere/);
}

/* ---------- the run ---------- */

async function testRun() {
  // a good answer: one request with the settings of WP52a, a plan that passes the contract
  {
    const model = scripted([answerOk]);
    const { result } = await run({ ask: model.ask });
    assert.equal(model.calls.length, 1);
    assert.deepEqual([model.calls[0].json, model.calls[0].maxTokens, model.calls[0].reasoningEffort], [true, plan.PLAN_MAX_TOKENS, 'medium']);
    assert.ok(plan.PLAN_MAX_TOKENS >= 32000);
    passesContract(result, 'the good answer');
    assert.equal(result.plain, false);
    assert.equal(result.graphics.title.text, 'Innovation Day 2026');
    assert.deepEqual(result.aiPhotos, [1, 2]);
    assert.deepEqual(result.aiPrompts.length, 2);
    assert.deepEqual(result.parallaxPhotos, []);
    assert.equal(result.voLines.length, 2);
    assert.deepEqual(result.costs, [0.3]);
    // the soundbites: the shot plays its sentence at its own speed, the subtitle words relative to its start, the lower third over it
    const bite = result.shots.shots.find((shot) => shot.kind === 'soundbite');
    assert.deepEqual([bite.source, bite.from, bite.to], [0, 39.5, 46.01]);
    assert.equal(result.graphics.soundbites[0].words[0].w, 'Willkommen');
    assert.equal(result.graphics.soundbites[0].words[0].s, 0.15);
    assert.equal(result.graphics.lower_thirds[0].name, 'Anna Muster');
    // slow motion: 0.5 for the clip of 59.94 fps
    assert.ok(result.shots.shots.some((shot) => shot.kind === 'video' && shot.source === 5 && shot.speed === 0.5));
    // the match cut of the pair
    const pair = result.shots.shots.find((shot) => shot.transition === 'match');
    assert.deepEqual([pair.source, pair.act], [3, 'programme']);
    // no fit without a reason (D17: the cut decides), no format in the plan
    result.shots.shots.forEach((shot, index) => assert.equal(shot.fit, result.sources[index].detail ? 'crop' : undefined, shot.id));
    // D18: the anchor says whether a face holds it (from the faces of the analysis); a soundbite without a face in the analysis says nothing (its speaker)
    for (const shot of result.shots.shots) {
      if (!shot.anchor) continue;
      if (shot.kind === 'soundbite') assert.ok(shot.anchor.face === undefined || shot.anchor.face === true, shot.id);
      else assert.equal(typeof shot.anchor.face, 'boolean', shot.id);
    }
    assert.ok(result.shots.shots.some((shot) => shot.anchor && shot.anchor.face === true), 'the faces of the analysis reach the cut');
    assert.ok(!/format|landscape|portrait|1920|1080/.test(JSON.stringify(result.shots)));
    // the look of the page from the style, the accent white without a branding
    assert.deepEqual(result.graphics.look, { type: { title: 'Montserrat:700', body: 'Inter Tight:500' }, accent: '#FFFFFF', tint: -0.015, glow: 0, title_seconds: 0.97, ease: 'power3.out', grain: 0.1, contrast: 0.55 });
    assert.deepEqual(result.graphics.mix, { duck_db: -12, ramp: 0.3, nat_level: 0.12, lufs: -16 });
    assert.equal(result.graphics.endcard.seconds, 3);
  }
  // a branding brings its accent
  {
    const { result } = await run({ ask: scripted([answerOk]).ask, brand: JSON.stringify({ neutral: false, colors: [{ role: 'accent', hex: '#3b6cff' }] }) });
    assert.equal(result.graphics.look.accent, '#3B6CFF');
  }
  // problems: a second try that is told them; the better answer wins
  {
    const wrong = clone(answerOk);
    wrong.acts[0].picks[0].ref = 'v99#0';
    const model = scripted([wrong, answerOk]);
    const { result } = await run({ ask: model.ask });
    assert.equal(model.calls.length, 2);
    assert.match(model.calls[1].prompt, /YOUR LAST ANSWER HAD THESE PROBLEMS/);
    assert.match(model.calls[1].prompt, /hook pick 0: "v99#0" is not in the material/);
    assert.equal(result.tries.length, 2);
    assert.match(result.board, /MODEL {6}anthropic\/claude-opus-5\.5 · try 1: effort medium, 9,000 of 32,000 tokens \(thinking 5,000, text 4,000\), complete, 1 of \d+ picks replaced, 0\.30 USD · try 2: .*0 of \d+ picks replaced/);
    assert.equal(result.content.acts.hook[0].unit.ref, 'v1#0');
  }
  // soft points never ask again: they are notes on the board
  {
    const soft = clone(answerOk);
    soft.title.text = 'Innovation Day 2026 der Muster AG in Zürich';
    const model = scripted([soft]);
    const { result } = await run({ ask: model.ask });
    assert.equal(model.calls.length, 1);
    assert.match(result.board, /NOTE {7}title\.text was cut to 28 characters/);
    assert.equal(result.graphics.title.text, 'Innovation Day 2026 der');
  }
  // empty answers: asked again twice, the second time after a pause of 20 s
  {
    const model = scripted([emptyError(), emptyError('length'), answerOk]);
    const { result, sleeps } = await run({ ask: model.ask });
    assert.equal(model.calls.length, 3);
    assert.deepEqual(sleeps, [plan.EMPTY_PAUSE_MS]);
    assert.equal(plan.EMPTY_PAUSE_MS, 20000);
    assert.equal(model.calls[2].reasoningEffort, 'low', 'an empty answer at the limit: the next request thinks less');
    passesContract(result, 'after two empty answers');
    assert.deepEqual(result.costs, [0.02, 0.02, 0.3]);
    assert.match(result.board, /request 2 \(empty before, again\): .*empty, 0\.02 USD · request 3 \(empty before, again after a pause\): .*complete/);
  }
  // three empty answers: EVENTPLAN_MODEL_FAILED, or the plain plan with allow_plain
  {
    const model = scripted([emptyError()]);
    const err = await errorOf(run({ ask: model.ask }));
    assert.equal(err.code, 'EVENTPLAN_MODEL_FAILED');
    assert.equal(model.calls.length, 3);
    assert.match(err.message, /empty answers/);
    assert.deepEqual(err.costs, [0.02, 0.02, 0.02]);
    const plain = await run({ ask: scripted([emptyError()]).ask, options: { ...AI_OPTIONS, allowPlain: true } });
    const result = plain.result;
    passesContract(result, 'the plain plan');
    assert.equal(result.plain, true);
    assert.equal(result.graphics.title, null);
    assert.equal(result.graphics.endcard.line, 'Danke');
    assert.deepEqual(result.graphics.soundbites, []);
    assert.deepEqual([result.aiPhotos, result.voLines], [[], []]);
    assert.match(result.board, /\nPLAIN {6}a plan by the score alone/);
  }
  // more than a quarter of the picks replaced: EVENTPLAN_MODEL_FAILED after the second try, the plain plan with allow_plain
  {
    const bad = clone(answerOk);
    for (const act of bad.acts) for (const pick of act.picks) pick.ref = 'v99#9';
    const model = scripted([bad]);
    const err = await errorOf(run({ ask: model.ask }));
    assert.equal(err.code, 'EVENTPLAN_MODEL_FAILED');
    assert.equal(model.calls.length, 2);
    assert.match(err.message, /\d+ of \d+ picks had to be replaced by the code/);
    assert.equal(err.data.attempts, 2);
    const { result } = await run({ ask: scripted([bad]).ask, options: { ...AI_OPTIONS, allowPlain: true } });
    assert.equal(result.plain, true);
    passesContract(result, 'plain after replaced picks');
  }
  // an error of the call itself before any answer is thrown as it is; a failed second request leaves the first answer
  {
    const err = await errorOf(run({ ask: scripted([new Error('network down')]).ask }));
    assert.equal(err.message, 'network down');
    const wrong = clone(answerOk);
    wrong.acts[0].picks[0].ref = 'v99#0';
    const logs = [];
    const { result } = await run({ ask: scripted([wrong, new Error('network down')]).ask, log: (line) => logs.push(line) });
    assert.ok(logs.some((line) => /The second request to the language model failed \(network down\): the first answer is used/.test(line)));
    passesContract(result, 'the first answer');
    // a fatal error (the end of the run, the budget) ends at once
    const fatal = Object.assign(new Error('budget'), { name: 'BudgetError' });
    const ended = await errorOf(run({ ask: scripted([fatal]).ask, fatal: (e) => e.name === 'BudgetError' }));
    assert.equal(ended.name, 'BudgetError');
  }
  // the checks before anything is paid
  {
    const asked = scripted([answerOk]);
    assert.equal((await errorOf(run({ ask: asked.ask, brief: '   ' }))).code, 'EVENTPLAN_BRIEF_EMPTY');
    const few = await errorOf(run({ ask: asked.ask, videos: [], photos: photos(4) }));
    assert.equal(few.code, 'EVENTPLAN_NO_MATERIAL');
    assert.deepEqual(few.data, { usable: 4, needed: 5 });
    const long = clone(material60.videos[0]);
    long.meta.seconds = 1000;
    long.scenes[2].out = 1000;
    const much = await errorOf(run({ ask: asked.ask, videos: [long, long, material60.videos[1]] }));
    assert.equal(much.code, 'EVENTPLAN_TOO_MUCH_MATERIAL');
    assert.match(much.message, /33:43 min long together, at most 30 min are allowed: leave out v\d/);
    assert.equal(asked.calls.length, 0);
  }
}

/* ---------- photos only, the details, every style ---------- */

async function testPhotosOnly() {
  // the real case: 14 photos (upright and wide), no video, 60 s, the code moves the photos with parallax
  const answerFor = (request) => {
    const counts = Object.fromEntries([...request.system.matchAll(/(\w+) (\d+) picks? \(/g)].map((match) => [match[1], Number(match[2])]));
    let next = 0;
    const acts = contract.ACTS.map((act) => ({ act, picks: Array.from({ length: counts[act] }, () => ({ ref: `p${next++}`, why: 'a photo' })) }));
    return { treatment: 'Ein Nachmittag.', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, parallax: ['p1', 'p2', 'p4', 'p5', 'p7'], endcard: { line: 'Danke.', source: 'generic' } };
  };
  for (const [eventType, mood, length] of [['conference', 'fresh', 60], ['party', 'fast', 30], ['celebration', 'calm', 90], ['corporate', 'elegant', 90]]) {
    const style = styles.combineStyle({ event_type: eventType, mood, length });
    const model = scripted([answerFor]);
    const { result } = await run({ ask: model.ask, style, videos: [], photos: photos(14), musicSeconds: length + 2, options: { photoMotion: 'code', parallax: true, voiceover: false, soundbites: 'auto' } });
    const label = `${eventType} x ${mood} x ${length}`;
    passesContract(result, label);
    assert.equal(model.calls.length, 1, `${label}: one request`);
    assert.match(model.calls[0].system, /There are no videos, only photos/);
    const shots = result.shots.shots;
    assert.ok(shots.every((shot) => ['photo', 'photo_parallax'].includes(shot.kind)), label);
    assert.deepEqual(result.graphics.soundbites, []);
    assert.equal(result.graphics.mix.nat_level, 0, `${label}: no sound of the clips`);
    assert.equal(result.graphics.duration, length);
    // the photo shots are calm: about 4 to 5 s where the style is slower than that
    if (eventType !== 'party') assert.ok(shots.filter((shot) => shot.act !== 'close').every((shot) => shot.end - shot.start >= 2.4 && shot.end - shot.start <= plan.PHOTO_MAX + 1e-9), label);
    // a photo comes back only as a detail, with a crop of another part (D17: the only fit the plan sets) and another motion
    const seen = new Map();
    shots.forEach((shot, index) => {
      const source = result.sources[index];
      if (shot.fit !== undefined) assert.equal(shot.fit, 'crop');
      if (source.detail) {
        assert.equal(shot.fit, 'crop', `${label}: a detail is a crop`);
        if (shot.kind === 'photo') assert.equal(shot.zoom, plan.DETAIL_ZOOM, `${label}: a detail starts zoomed in (D18)`);
        const first = seen.get(source.index);
        assert.ok(first, `${label}: the detail of p${source.index} comes after the photo`);
        assert.ok(Math.abs(first.anchor.x - shot.anchor.x) >= 0.15 || Math.abs(first.anchor.y - shot.anchor.y) >= 0.09, `${label}: the detail of p${source.index} shows another part`);
        if (first.motion) assert.notEqual(first.motion.type, shot.motion.type);
      } else {
        assert.ok(!seen.has(source.index), `${label}: p${source.index} twice without being a detail`);
        assert.equal(shot.zoom, undefined, `${label}: only a detail has a zoom`);
        seen.set(source.index, shot);
      }
    });
    assert.equal(result.parallaxPhotos.length, Math.min(5, plan.CLIPS_BY_LENGTH[length]));
  }
}

// A model of the test that stays within the tolerance of the grid: every act between max(1, picks - 2) and picks + 2 picks of units not used yet, in a
// random order of a fixed seed (an act gets fewer only when the material is used up).
function toleranceModel(seed) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const answerFor = (ctx) => {
    const used = new Set();
    const units = ctx.material.units.slice();
    const acts = ctx.grid.acts.map((act) => {
      const wanted = Math.max(1, act.picks - 2, act.picks + Math.floor(random() * 5) - 2);
      const picks = [];
      for (const unit of units.sort(() => random() - 0.5)) {
        if (picks.length >= wanted) break;
        if (used.has(unit.ref) || plan.unitFault(unit, act.act, ctx.style)) continue;
        used.add(unit.ref);
        picks.push({ ref: unit.ref, why: 'x', slow: random() < 0.3, pair: null });
      }
      return { act: act.act, picks };
    });
    const picked = acts.flatMap((act) => act.picks.map((pick) => pick.ref)).filter((ref) => ref.startsWith('p'));
    return { treatment: 't', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, ai_photos: picked.slice(0, 6).map((ref) => ({ ref, prompt: 'slow push in' })),
      parallax: picked.slice(0, 6), voiceover: [{ act: 'arrival', text: 'Innovation Day 2026.' }], endcard: { line: 'Danke', sub: null, url: null, source: 'generic' } };
  };
  return { random, answerFor };
}

async function testScarceMaterial() {
  // the case of the review: 8 photos for 60 s, the model gives hook, arrival and programme two picks more than asked: every act keeps a shot, nothing fails
  {
    const style = styles.combineStyle({ event_type: 'corporate', mood: 'fresh', length: 60 });
    const eight = Array.from({ length: 8 }, (_, index) => photo(index, { faces: 0 }));
    const options = { photoMotion: 'code', parallax: true, voiceover: false, lowerThirds: true, soundbites: 'auto' };
    const ctx = contextOf({ material: plan.readMaterial([], eight), style, options });
    assert.ok(ctx.grid.details > 0);
    let next = 0;
    const greedy = { ...goodAnswer(ctx), acts: ctx.grid.acts.map((act) => ({ act: act.act, picks: Array.from({ length: Math.min(act.picks + 2, 8 - next) }, () => ({ ref: `p${next++}`, why: 'x' })) })) };
    assert.deepEqual(greedy.acts.map((act) => act.picks.length).slice(3), [0, 0, 0], 'the model used every photo in the first three acts');
    const read = plan.validateAnswer(greedy, ctx);
    for (const act of contract.ACTS) assert.ok(read.content.acts[act].length >= 1, `${act} has a pick`);
    assert.ok(read.replaced / read.picks <= plan.MAX_REPLACED_SHARE, `${read.replaced} of ${read.picks} replaced`);
    assert.match(read.notes.join(' '), /moved here, the material is short/);
    const { result } = await run({ ask: scripted([greedy]).ask, style, videos: [], photos: eight, options });
    passesContract(result, 'eight photos');
    assert.equal(result.plain, false);
    for (const act of contract.ACTS) assert.ok(result.shots.shots.some((shot) => shot.act === act), `${act} has a shot`);
  }
  // every style, length and 5 to 10 photos, the answers within the tolerance: no plan fails
  let runs = 0;
  for (const eventType of contract.EVENT_TYPES) {
    for (const mood of contract.MOODS) {
      for (const length of [30, 60, 90]) {
        for (let count = 5; count <= 10; count += 1) {
          const model = toleranceModel(runs + 1);
          const style = styles.combineStyle({ event_type: eventType, mood, length });
          const list = Array.from({ length: count }, (_, index) => photo(index, { upright: model.random() < 0.4, faces: model.random() < 0.5 ? 1 + Math.floor(model.random() * 3) : 0, quality: 3 + Math.floor(model.random() * 3) }));
          const options = { photoMotion: runs % 2 ? 'ai' : 'code', parallax: true, voiceover: runs % 3 === 0, lowerThirds: true, soundbites: 'auto', allowPlain: false };
          const ctx = contextOf({ material: plan.readMaterial([], list), style, options, musicSeconds: length + 2 });
          const label = `${eventType} x ${mood} x ${length} s, ${count} photos`;
          let result;
          try {
            ({ result } = await run({ ask: scripted([() => model.answerFor(ctx)]).ask, style, videos: [], photos: list, musicSeconds: length + 2, options }));
          } catch (err) {
            assert.fail(`${label}: ${err.code || ''} ${err.message.slice(0, 300)}`);
          }
          passesContract(result, label);
          for (const act of contract.ACTS) assert.ok(result.shots.shots.some((shot) => shot.act === act), `${label}: ${act} has a shot`);
          runs += 1;
        }
      }
    }
  }
  assert.equal(runs, contract.EVENT_TYPES.length * contract.MOODS.length * 3 * 6);
  // a plan that does not pass the contract all the same: EVENTPLAN_MODEL_FAILED with its code, the plain plan with allow_plain
  {
    const original = contract.checkPair;
    let calls = 0;
    contract.checkPair = (...args) => (calls++ === 0 ? { ok: false, problems: ['shots[3].start is 9, not the end of the shot before (7)'] } : original(...args));
    try {
      const err = await errorOf(run({ ask: scripted([answerOk]).ask }));
      assert.equal(err.code, 'EVENTPLAN_MODEL_FAILED');
      assert.match(err.message, /the plan does not pass the contract: shots\[3\]\.start is 9/);
      assert.equal(err.data.attempts, 1);
      calls = 0;
      const logs = [];
      const { result } = await run({ ask: scripted([answerOk]).ask, options: { ...AI_OPTIONS, allowPlain: true }, log: (line) => logs.push(line) });
      assert.equal(result.plain, true);
      assert.ok(logs.some((line) => /does not pass the contract .*a plan by the score alone is made/.test(line)));
      calls = 1;
      contract.checkPair = () => ({ ok: false, problems: ['a gap'] });
      const plainErr = await errorOf(run({ ask: scripted([answerOk]).ask, options: { ...AI_OPTIONS, allowPlain: true } }));
      assert.equal(plainErr.code, 'EVENTPLAN_MODEL_FAILED');
      assert.match(plainErr.message, /the plain plan does not pass the contract either: a gap/);
    } finally {
      contract.checkPair = original;
    }
  }
  // fewer scenes and photos than acts: EVENTPLAN_NO_MATERIAL before anything is paid
  {
    const single = clone(material60.videos.find((video) => video.usable && video.scenes.length >= 1));
    single.scenes = [{ ...single.scenes[0], i: 0, in: 0, out: Math.min(single.meta.seconds, 4) }];
    const asked = scripted([answerOk]);
    const err = await errorOf(run({ ask: asked.ask, videos: [single, single, single, single, single], photos: [] }));
    assert.equal(err.code, 'EVENTPLAN_NO_MATERIAL');
    assert.deepEqual(err.data, { usable: 5, needed: 6 });
    assert.equal(asked.calls.length, 0);
  }
}

async function testEveryStyle() {
  // every event type and mood at 60 s with the material of the fixtures: a plan that passes the contract
  for (const eventType of [...contract.EVENT_TYPES, 'festival']) {
    for (const mood of contract.MOODS) {
      const style = styles.combineStyle({ event_type: eventType, mood });
      const ctx = contextOf({ style });
      const model = scripted([() => goodAnswer(ctx, { soundbites: [{ ref: 'v4', word_from: 10, word_to: 21, source: 'transcript' }] })]);
      const { result } = await run({ ask: model.ask, style });
      passesContract(result, `${eventType} x ${mood}`);
      const kinds = new Set(result.shots.shots.map((shot) => shot.transition));
      for (const kind of kinds) assert.ok(contract.SHOT_TRANSITIONS.includes(kind));
      for (const item of result.graphics.transitions) assert.ok(item.type === 'dip' ? style.transitions.dip : style.transitions.flash || style.transitions.strobe, `${eventType} x ${mood}: ${item.type}`);
      if (result.shots.shots.some((shot) => shot.transition === 'dissolve')) assert.ok(style.transitions.dissolve);
    }
  }
}

/* ---------- the board ---------- */

async function testBoard() {
  const { result } = await run({ ask: scripted([answerOk]).ask });
  const file = path.join(SUPPORT, 'board-60.txt');
  if (process.env.EVENT_BOARD_UPDATE === '1') fs.writeFileSync(file, `${result.board}\n`);
  assert.equal(`${result.board}\n`, fs.readFileSync(file, 'utf8'), 'the board differs from support/event-video/board-60.txt (EVENT_BOARD_UPDATE=1 writes it again)');
  const lines = result.board.split('\n');
  for (const label of ['TREATMENT', 'STYLE ', 'NUMBERS ', 'ESTIMATE ', 'MODEL ', 'NOTE ', 'SOUNDBITES ', 'TITLES ', 'LEFT OUT ', 'HOOK ', 'CLOSE ']) assert.ok(lines.some((line) => line.startsWith(label)), label);
  assert.match(result.board, /\nLEFT OUT {3}v7 \(decode_failed\), p6 \(heic\)/);
}

/* ---------- the estimate (spec §2) ---------- */

function testEstimate() {
  // the material of the table: 20 clips of 10 min, 20 photos, Scribe 15 min, the cuts of the default style; AI clips, depth maps and the voice 2 / 4 / 6 and the
  // characters that give its voice line
  const cents = (value) => Math.round(value * 100) / 100;
  const cpm = styles.derive(styles.combineStyle({})).cpm;
  const table = {
    30: { vision: 0.24, speech: 0.06, music: 0.11, llm: 0.35, depth: 0.02, ai: 0.4, voice: 0.03, code: 0.8 },
    60: { vision: 0.24, speech: 0.06, music: 0.21, llm: 0.42, depth: 0.04, ai: 0.8, voice: 0.06, code: 1.0 },
    90: { vision: 0.24, speech: 0.06, music: 0.31, llm: 0.5, depth: 0.06, ai: 1.2, voice: 0.08, code: 1.2 }
  };
  const voiceChars = { 30: 360, 60: 720, 90: 1000 };
  for (const length of [30, 60, 90]) {
    const clips = plan.CLIPS_BY_LENGTH[length];
    const e = plan.estimate(
      {
        items: plan.TYPICAL_MATERIAL.videos + plan.TYPICAL_MATERIAL.photos,
        speechSeconds: plan.TYPICAL_MATERIAL.speechSeconds,
        musicSeconds: length + 2,
        picks: Math.round((cpm * length) / 60),
        promptChars: plan.typicalPromptChars(),
        aiClips: clips,
        depthMaps: clips,
        voiceChars: voiceChars[length]
      },
      PRICES
    );
    for (const part of Object.keys(e.parts)) assert.equal(cents(e.parts[part]), table[length][part], `${length} s: ${part} ${e.parts[part]}`);
    const code = e.parts.vision + e.parts.speech + e.parts.music + e.parts.llm + e.parts.depth;
    assert.equal(Math.round(code * 10) / 10, table[length].code, `${length} s: the sum with the code motion`);
  }
  // own music and unknown prices
  const own = plan.estimate({ items: 10, musicSeconds: 0, picks: 20, promptChars: 9000 }, PRICES);
  assert.equal(own.parts.music, 0);
  const unknown = plan.estimate({ items: 10, musicSeconds: 62, picks: 20 }, { visionPerItem: 0.006 });
  assert.equal(unknown.total, null);
  assert.deepEqual(unknown.unknown, ['music', 'llm']);
}

/* ---------- the node ---------- */

async function testNodeDefinition() {
  const registry = require('../lib/nodes/registry');
  const nodes = require('../lib/nodes/nodes-event-video');
  const own = registry.createRegistry();
  nodes.registerAll(own);
  const def = own.get('event_video.plan');
  assert.deepEqual(def.outputs.map((port) => `${port.id}:${port.type}`), ['shots:text', 'graphics:text', 'board:text', 'selection:image', 'ai_photos:image[]', 'ai_prompts:text[]', 'parallax_photos:image[]', 'vo_lines:text[]']);
  assert.deepEqual(registry.normalizeParams(def, {}), { model: '', brief: '', photo_motion: 'code', parallax: true, max_ai_photos: 0, voiceover: false, lower_thirds: true, soundbites: 'auto', allow_plain: false });
  assert.deepEqual(nodes.optionsOf(registry.normalizeParams(def, { photo_motion: 'ai', max_ai_photos: 3 })), { photoMotion: 'ai', parallax: true, maxAiPhotos: 3, voiceover: false, lowerThirds: true, soundbites: 'auto', allowPlain: false });
  // the estimate of one answer: the typical material while the analysis is not there, else the prompt of the material
  const openrouter = require('../lib/openrouter');
  const savedKey = openrouter.hasKey;
  try {
    openrouter.hasKey = () => true;
    const typical = def.cost.estimate(registry.normalizeParams(def, {}), { inputs: {} });
    assert.equal(Math.round(typical.usd * 100) / 100, 0.42);
    const { textValue, listValue } = require('../lib/nodes/types');
    const style = textValue(JSON.stringify(styleFixture));
    const inputs = {
      style,
      brief: textValue(BRIEF),
      music_analysis: textValue(JSON.stringify(beats)),
      video_info: listValue('text', material60.videos.map((info) => textValue(JSON.stringify(info)))),
      photo_info: listValue('text', material60.photos.map((info) => textValue(JSON.stringify(info))))
    };
    const known = def.cost.estimate(registry.normalizeParams(def, {}), { inputs });
    assert.ok(known.usd > 0.2 && known.usd < 0.6, `estimate ${known.usd}`);
    assert.equal(def.cost.estimate(registry.normalizeParams(def, { model: 'vendor/unknown' }), { inputs }), null);
  } finally {
    openrouter.hasKey = savedKey;
  }
}

// The node with the real store and ffmpeg for the contact sheet; the language model is replaced. Writes a session into the data folder of the repository it
// runs in: start it through scripts/run-tests.js (it runs in a copy).
async function testNode() {
  const ffmpegLib = require('../lib/ffmpeg');
  if (!ffmpegLib.binaries().available) {
    console.log('test-event-video-plan.js: ffmpeg is missing, the run of the node is skipped');
    return;
  }
  const store = require('../lib/store');
  const assets = require('../lib/nodes/assets');
  const llm = require('../lib/nodes/llm');
  const registry = require('../lib/nodes/registry');
  const nodes = require('../lib/nodes/nodes-event-video');
  const { textValue, listValue } = require('../lib/nodes/types');
  const { toneWav } = require('./support/explainer-media');
  const own = registry.createRegistry();
  nodes.registerAll(own);
  const def = own.get('event_video.plan');

  const session = await store.createSession();
  const sessionId = session.id;
  const scratch = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'event-plan-'));
  const restore = [];
  // a key for the availability of the language model; the model itself is replaced below, nothing leaves the machine
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-for-the-event-plan-0123456789';
  restore.push(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });
  try {
    // 6 small photos and 2 clips (made by ffmpeg), the music as a tone
    const make = async (name, args) => {
      const file = path.join(scratch, name);
      await ffmpegLib.runProcess(ffmpegLib.binaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { timeoutMs: 60000 });
      return file;
    };
    const photoValues = [];
    for (let index = 0; index < 6; index += 1) {
      const size = index % 2 ? '360x480' : '640x480';
      const file = await make(`p${index}.jpg`, ['-f', 'lavfi', '-i', `testsrc2=s=${size}:d=1`, '-frames:v', '1']);
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(file), ext: '.jpg', prompt: `photo ${index}` });
      photoValues.push(await assets.valueFromAsset(sessionId, saved.id));
    }
    const videoValues = [];
    for (let index = 0; index < 2; index += 1) {
      const file = await make(`v${index}.mp4`, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=24:r=25', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']);
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(file), ext: '.mp4', prompt: `clip ${index}` });
      videoValues.push(await assets.valueFromAsset(sessionId, saved.id));
    }
    const savedMusic = await store.saveAsset(sessionId, { kind: 'upload', buffer: toneWav(62, 330), ext: '.wav', prompt: 'music of the test' });
    const musicValue = await assets.valueFromAsset(sessionId, savedMusic.id);
    // the infos: two clips of the fixtures (shortened to 24 s) and six photos
    const videoInfo = [material60.videos[1], material60.videos[4]].map((info) => {
      const copy = clone(info);
      copy.meta.seconds = 24;
      copy.scenes = copy.scenes.filter((scene) => scene.in < 24).map((scene) => ({ ...scene, out: Math.min(scene.out, 24) }));
      if (copy.speech) copy.speech.words = copy.speech.words.filter((word) => word.e <= 24);
      return copy;
    });
    const photoInfo = photos(6);

    const calls = [];
    const original = llm.completeText;
    llm.completeText = async (options) => {
      calls.push(options);
      const counts = Object.fromEntries([...options.system.matchAll(/(\w+) (\d+) picks? \(/g)].map((match) => [match[1], Number(match[2])]));
      const refs = ['v0#0', 'p0', 'v0#1', 'p1', 'v1#0', 'p2', 'p3', 'p4', 'p5'];
      const acts = contract.ACTS.map((act) => ({ act, picks: refs.splice(0, counts[act]).map((ref) => ({ ref, why: 'test' })) }));
      return {
        text: JSON.stringify({ treatment: 'Test.', acts, title: { text: 'Innovation Day 2026', source: 'description' }, ai_photos: [{ ref: 'p1', prompt: 'Slow push-in.' }], endcard: { line: 'Danke.', source: 'generic' } }),
        usd: 0.31,
        model: 'anthropic/claude-opus-5.5'
      };
    };
    restore.push(() => {
      llm.completeText = original;
    });
    const logs = [];
    const controller = new AbortController();
    const config = { defaultBrain: 'anthropic/claude-opus-5.5', brainModels: ['anthropic/claude-opus-5.5'] };
    const ctx = {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n10',
      sessionId,
      user: 'tester',
      config,
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId, config, user: 'tester', emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn()
    };
    const inputs = {
      brief: textValue(BRIEF),
      style: textValue(JSON.stringify(styleFixture)),
      videos: listValue('video', videoValues),
      photos: listValue('image', photoValues),
      video_info: listValue('text', videoInfo.map((info) => textValue(JSON.stringify(info)))),
      photo_info: listValue('text', photoInfo.map((info) => textValue(JSON.stringify(info)))),
      music: musicValue,
      music_analysis: textValue(JSON.stringify(beats))
    };
    const params = registry.normalizeParams(def, { model: 'anthropic/claude-opus-5.5', photo_motion: 'ai' });
    const result = await def.execute(ctx, inputs, params);
    assert.equal(calls.length, 1, logs.join('\n'));
    assert.deepEqual([calls[0].model, calls[0].json, calls[0].maxTokens, calls[0].reasoningEffort, calls[0].sessionId], ['anthropic/claude-opus-5.5', true, plan.PLAN_MAX_TOKENS, 'medium', sessionId]);
    const out = result.variants[0];
    const shots = JSON.parse(out.shots.value);
    const graphics = JSON.parse(out.graphics.value);
    assert.deepEqual(contract.checkPair(shots, graphics).problems, []);
    assert.match(out.board.value, /^TREATMENT\nTest\./);
    assert.match(out.board.value, /ESTIMATE {3}AI clips 1 0\.20/);
    assert.equal(out.selection.type, 'image');
    assert.equal(path.extname(out.selection.file), '.jpg');
    // the contact sheet: 6 thumbnails a row
    const probe = await require('../lib/nodes/ffmpeg-ops').probeMedia(assets.assetFilePath(out.selection));
    assert.equal(probe.video.width, 6 * 320 + 7 * 4);
    assert.equal(probe.video.height, Math.ceil(shots.shots.length / 6) * 180 + (Math.ceil(shots.shots.length / 6) + 1) * 4);
    assert.deepEqual(out.ai_photos.items.map((item) => item.assetId), [photoValues[1].assetId]);
    assert.deepEqual(out.ai_prompts.items.map((item) => item.value), ['Slow push-in.']);
    assert.deepEqual([out.parallax_photos.items, out.vo_lines.items], [[], []]);
    assert.deepEqual(result.cost, { usd: 0.31 });
    assert.ok(logs.some((line) => /^Language model, request 1: effort medium/.test(line)));
    // the analyses must belong to the lists
    const err = await errorOf(def.execute(ctx, { ...inputs, photo_info: listValue('text', []) }, params));
    assert.match(err.message, /photo_info: 0 analyses for 6 photos/);
    assert.equal((await errorOf(def.execute(ctx, { ...inputs, brief: textValue(' ') }, params))).code, 'EVENTPLAN_BRIEF_EMPTY');
    // no scratch folder is left
    const left = (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-'));
    assert.deepEqual(left, []);
  } finally {
    for (const fn of restore) fn();
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

(async () => {
  testMaterial();
  testFactsAndHashes();
  await testSimilarShots();
  testGrid();
  testPrompt();
  testAnswer();
  await testSoundbiteRisks();
  await testVoiceover();
  await testRun();
  await testPhotosOnly();
  await testScarceMaterial();
  await testEveryStyle();
  await testBoard();
  testEstimate();
  await testNodeDefinition();
  await testNode();
  console.log('test-event-video-plan.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
