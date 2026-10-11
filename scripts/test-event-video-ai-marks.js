'use strict';

// The AI clip per photo of the event video (WP55): the marks of the photos in the order (the form of the app: "auto", "never AI", "always AI") and
// the switches of the approval after step 1 (every photo of the film, its AI clip on or off). lib/event-video/plan.js, the node event_video.plan,
// the param kind `marks`, the app format (marks of an input, switches of an output), the widgets and the whole flow through the real engine. No
// network, nothing paid: the language model is replaced by answers of the test.
//   never      a photo marked "never AI" gets no AI clip, also when the answer ranks it first and when it is switched on; zoom, pan and parallax
//              stay allowed; with "all chosen photos" every photo but it
//   sure       a photo marked "always AI" gets a clip when the film can show it: ranked low, not picked (the code puts it in place of the pick with
//              the lowest score), not usable (a note on the board); the rule for the number of clips
//   switch     the switches of the approval: the plan is made again from the answer the first run keeps, without a request; the same request,
//              whatever the switches; the prompts of the photos switched on come from that answer
//   copies     (review) the mark of a photo the analysis took for a copy holds for the photo that is kept, "no AI" before "AI clip"
//   added      (review) a photo the code added to fill an act has no switch that could be switched on (locked, why "added"), and the board says why
//   main       without marks everything is as on main (34fe755): the prompts, the plans and the cache keys, byte for byte (digests computed with
//              the code of main)
//   format     the param kind `marks` (registry), marks and switches in the app section (server and client)
//   widgets    the summary of the marks in the inspector, the hook of the list of files, the pure functions of the switches, the texts in de/en/es
//   engine     the template through the real engine: step 1 with marks, then the plan and the run of the approval with switches: the planner is not
//              asked again (a mock counts the calls), the node is free in the plan, the clips are counted right in the cost of step 2; (review) after a
//              forced run of the planner (a new answer for the same request) the same switches find no result made from the older answer

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const contract = require('../lib/event-video/contract');
const styles = require('../lib/event-video/styles');
const plan = require('../lib/event-video/plan');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SUPPORT = path.join(__dirname, 'support', 'event-video');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SUPPORT, name), 'utf8'));
const clone = (value) => structuredClone(value);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const material60 = load('material-60.json');
const styleFixture = load('style-corporate-fresh.json');
const beats = load('beats-60.json');
const answerOk = load('answer-ok.json');
const infoPhoto = load('info-photo.json');
const { ACTS } = contract;

const PRICES = Object.freeze({
  visionPerItem: 0.006,
  speechPerHour: 0.22,
  music: (seconds) => (seconds / 60) * 0.2,
  llm: { inputPerMillion: 4, outputPerMillion: 20, charsPerToken: 3 },
  depth: 0.01,
  clipPerSecond: 0.04,
  voicePerChar: 0.08 / 1000
});
const AI = Object.freeze({ photoMotion: 'ai', parallax: true, voiceover: false, lowerThirds: true, soundbites: 'auto' });

/* ---------- material and answers (as in test-event-video-ai-clips.js) ---------- */

const SUBJECTS = ['stage', 'guests', 'coffee', 'badges', 'keynote', 'panel', 'workshop', 'laptop', 'sticker', 'handshake', 'applause', 'dinner', 'concert', 'dancing', 'toast', 'lights', 'terrace', 'sunset'];
function photo(index, { upright = false, faces = 0, quality = 4, subject = null } = {}) {
  const info = clone(infoPhoto);
  info.id = `photo-${index}`;
  info.meta.width = upright ? 4284 : 5712;
  info.meta.height = upright ? 5712 : 4284;
  info.meta.rotation = 0;
  info.scenes[0].quality = quality;
  info.scenes[0].reasons = quality >= 3 ? ['ok'] : ['blurry'];
  info.scenes[0].faces = faces ? { count: faces, x: 0.42, y: 0.36, size: 0.08 } : { count: 0, x: null, y: null, size: null };
  info.vision.framing = ['wide', 'medium', 'close', 'detail'][index % 4];
  info.vision.score = 3 + (index % 3);
  info.vision.subject = subject || `the event, picture ${index}`;
  info.vision.text_in_image = [];
  info.vision.risk = [];
  info.vision.people = faces ? '2-5' : '0';
  return info;
}

// A model that answers from the request and counts the requests
function scripted(answerFor) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    const answer = typeof answerFor === 'function' ? answerFor(request) : answerFor;
    return { text: JSON.stringify(answer), usd: 0.3, model: 'anthropic/claude-opus-5.5', usage: { completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 5000 } } };
  };
  return { ask, calls };
}

// A model that must not be asked
const silent = () => {
  const calls = [];
  return {
    calls,
    ask: async (request) => {
      calls.push(request);
      throw new Error('the language model was asked');
    }
  };
};

function run(extra) {
  return plan.runEventPlanner({ brief: material60.brief, style: styleFixture, videos: material60.videos, photos: material60.photos, analysis: beats, musicSeconds: 62, prices: PRICES, sleep: async () => {}, ...extra });
}

function picksFor(system, refs) {
  const counts = Object.fromEntries([...system.matchAll(/(\w+) (\d+) picks? \(/g)].map((match) => [match[1], Number(match[2])]));
  let next = 0;
  return ACTS.map((act) => ({ act, picks: Array.from({ length: counts[act] }, () => ({ ref: refs[next++], why: 'a photo' })) }));
}

function passesContract(result, label) {
  assert.deepEqual(contract.checkPair(result.shots, result.graphics).problems, [], label);
}

// 18 photos, one a duplicate (17 usable), 60 s; the answer ranks p0, p2, p3, p15, p5, p10, p13, p6 and lists p0 first for the parallax (the live test
// of 2026-10-11, test-event-video-ai-clips.js)
function livePhotos() {
  const list = Array.from({ length: 17 }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0, subject: `the ${SUBJECTS[index]}` }));
  list[3].scenes[0].hash = 'a1b2c3d4e5f60718';
  const copy = clone(list[3]);
  copy.id = 'photo-17';
  return [...list, copy];
}

function liveAnswer(request) {
  const acts = picksFor(request.system, Array.from({ length: 17 }, (_, index) => `p${index}`));
  const of = (act) => acts.find((entry) => entry.act === act).picks.map((pick) => pick.ref);
  const ranked = [of('hook')[0], of('arrival')[0], of('arrival')[1], of('close')[0], of('programme')[1], of('people')[1], of('peak')[1], of('programme')[2]];
  return {
    treatment: 'Ein Abend.',
    acts,
    title: { text: 'Innovation Day 2026', sub: null, source: 'description' },
    ai_photos: ranked.map((ref) => ({ ref, prompt: 'Slow push-in, the light breathes softly.' })),
    parallax: [ranked[0], of('programme')[0], of('people')[0], of('peak')[0], of('close')[1], of('people')[2]],
    endcard: { line: 'Danke.', source: 'generic' }
  };
}

// The same, but every picked photo has a prompt of its own (WP55: the person may switch on any photo)
function promptedAnswer(request) {
  const answer = liveAnswer(request);
  const ranked = answer.ai_photos.map((item) => item.ref);
  const rest = answer.acts.flatMap((act) => act.picks.map((pick) => pick.ref)).filter((ref) => !ranked.includes(ref));
  answer.ai_photos = [...ranked, ...rest].map((ref) => ({ ref, prompt: `Slow push-in on ${ref}.` }));
  return answer;
}

const LIVE = () => styles.combineStyle({ event_type: 'conference', mood: 'fresh', length: 60 });
const liveRun = (extra) => run({ style: LIVE(), videos: [], photos: livePhotos(), ...extra });

/* ---------- never ---------- */

async function testNever() {
  // the answer ranks p0 first and lists it first for the parallax; the person marked it "never AI"
  const model = scripted(liveAnswer);
  const result = await liveRun({ ask: model.ask, options: { ...AI, aiMarks: { 0: 'never' } } });
  passesContract(result, 'never');
  assert.equal(model.calls.length, 1);
  assert.match(model.calls[0].system, / The person marked p0 "no AI": never list them in "ai_photos" \(zoom, pan and parallax are fine\)\./);
  assert.equal(result.aiPhotos.length, 4, 'still four clips');
  assert.ok(!result.aiPhotos.includes(0), `p0 has no AI clip: ${result.aiPhotos}`);
  assert.ok(result.notes.includes('ai_photos p0 was left out: it is marked "no AI"'));
  assert.ok(!result.shots.shots.some((shot) => shot.kind === 'photo_ai' && result.sources[shot.source]?.index === 0 && result.sources[shot.source]?.kind === 'photo'));
  assert.ok(result.parallaxPhotos.includes(0), 'the parallax stays allowed (the first of the list)');
  // the switches: p0 is locked
  const p0 = result.switches.find((item) => item.ref === 'p0');
  assert.deepEqual(p0, { ref: 'p0', photo: 0, on: false, auto: false, mark: 'never', locked: true });
  assert.equal(result.switches.filter((item) => item.on).length, 4);

  // switched on in the approval: it stays without a clip, and the board says why
  const again = await liveRun({ ask: silent().ask, reuse: async () => result.kept, options: { ...AI, aiMarks: { 0: 'never' }, aiChoice: { 0: 'on' } } });
  assert.deepEqual(again.aiPhotos, result.aiPhotos);
  assert.ok(again.notes.includes('p0 stays without an AI clip: marked "no AI"'), again.notes.join(' | '));
  assert.deepEqual(again.shots, result.shots, 'the same cut');

  // "all chosen photos": every photo but the marked ones; the rule says so
  const party = styles.combineStyle({ event_type: 'party', mood: 'fast', length: 30 });
  const nine = Array.from({ length: 9 }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0, subject: `the ${SUBJECTS[index]}` }));
  const allAnswer = (request) => {
    const acts = picksFor(request.system, Array.from({ length: 9 }, (_, index) => `p${index}`));
    const picked = acts.flatMap((act) => act.picks.map((pick) => pick.ref));
    return { treatment: 't', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, ai_photos: picked.map((ref) => ({ ref, prompt: 'gentle drift' })), parallax: [], endcard: { line: 'Danke.', source: 'generic' } };
  };
  const all = scripted(allAnswer);
  const every = await run({ ask: all.ask, style: party, videos: [], photos: nine, musicSeconds: 32, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS, aiMarks: { 1: 'never', 4: 'never' } } });
  passesContract(every, 'every photo');
  assert.match(all.calls[0].system, /The code animates every photo you pick with AI except those marked "no AI"\. .* The person marked p1, p4 "no AI"/);
  // (p8 is a photo the code added to the arrival, as on main: no candidate of the answer)
  assert.deepEqual(every.aiPhotos, [0, 2, 3, 5, 6, 7]);
  assert.ok(every.notes.includes('ai_photos p1 was left out: it is marked "no AI"') && every.notes.includes('ai_photos p4 was left out: it is marked "no AI"'));
  // no more clips than the photos that may have one
  const limits = plan.answerLimits(plan.planGrid({ analysis: beats, style: party, material: plan.readMaterial([], nine), musicSeconds: 32, options: AI }), plan.readMaterial([], nine), { ...AI, maxAiPhotos: 4, aiMarks: { 0: 'never', 1: 'never', 2: 'never', 3: 'never', 4: 'never', 5: 'never', 6: 'never', 7: 'never' } });
  assert.equal(limits.ai, 1);
  // with the photos moved by code a mark changes nothing
  const code = await run({ ask: scripted(answerOk).ask, options: { ...AI, photoMotion: 'code', aiMarks: { 1: 'never', 2: 'always' } } });
  const plainCode = await run({ ask: scripted(answerOk).ask, options: { ...AI, photoMotion: 'code' } });
  assert.deepEqual([code.shots, code.board, code.switches], [plainCode.shots, plainCode.board, []]);
}

/* ---------- sure ---------- */

// The answer of the fixtures without p4 (a scene the answer does not use takes its place): p4 is not picked
function answerWithout4() {
  const answer = clone(answerOk);
  const programme = answer.acts.find((act) => act.act === 'programme');
  programme.picks = programme.picks.map((pick) => (pick.ref === 'p4' ? { ...pick, ref: 'v0#2' } : pick));
  return answer;
}

async function testSure() {
  // ranked low (not among the candidates): p5 is marked and gets its clip, the field stays the number of clips
  const low = scripted(answerOk);
  const ranked = await run({ ask: low.ask, options: { ...AI, maxAiPhotos: 2, aiMarks: { 5: 'always' } } });
  passesContract(ranked, 'sure, ranked low');
  assert.match(low.calls[0].system, / The person marked p5 "AI clip": pick each of them where it fits and list them first in "ai_photos"\./);
  assert.match(low.calls[0].system, /The code animates 2 of the photos you pick with AI/);
  assert.equal(ranked.aiPhotos.length, 2);
  assert.ok(ranked.aiPhotos.includes(5), `p5 has its clip: ${ranked.aiPhotos}`);
  assert.ok(ranked.notes.includes('p5 is marked "AI clip" but the answer has no prompt for it: it gets a gentle camera move'));
  assert.equal(ranked.aiPrompts[ranked.aiPhotos.indexOf(5)], plan.DEFAULT_AI_PROMPT);
  assert.deepEqual(ranked.switches.find((item) => item.ref === 'p5'), { ref: 'p5', photo: 5, on: true, auto: true, mark: 'always', locked: false });

  // not picked: the code puts it in place of the pick with the lowest score, and it gets its clip
  const missing = await run({ ask: scripted(answerWithout4()).ask, options: { ...AI, maxAiPhotos: 2, aiMarks: { 4: 'always' } } });
  passesContract(missing, 'sure, not picked');
  assert.ok(missing.sources.some((source) => source.kind === 'photo' && source.index === 4), 'p4 is in the film');
  assert.ok(missing.notes.some((note) => /^\w+: p4 is marked "AI clip" and was not picked: the code put it in place of /.test(note)), missing.notes.join(' | '));
  assert.ok(missing.aiPhotos.includes(4));
  assert.equal(missing.aiPhotos.length, 2);

  // not usable (p6 is a HEIC the analysis could not read): a note, and the number of clips stays
  const unusable = await run({ ask: scripted(answerOk).ask, options: { ...AI, maxAiPhotos: 2, aiMarks: { 6: 'always' } } });
  passesContract(unusable, 'sure, unusable');
  assert.ok(unusable.notes.some((note) => /^p6 is marked "AI clip" but cannot be used \(/.test(note)), unusable.notes.join(' | '));
  assert.ok(!unusable.aiPhotos.includes(6));
  assert.equal(unusable.aiPhotos.length, 2);
  assert.match(unusable.board, /p6 is marked "AI clip" but cannot be used/);
  // a photo the film can show in no act (quality 1) does not count either
  const blurry = livePhotos();
  blurry[9].scenes[0].quality = 1;
  blurry[9].scenes[0].reasons = ['blurry'];
  const notShown = await run({ ask: scripted(liveAnswer).ask, style: LIVE(), videos: [], photos: blurry, options: { ...AI, maxAiPhotos: 2, aiMarks: { 9: 'always' } } });
  assert.ok(notShown.notes.includes('p9 is marked "AI clip" but cannot be used: quality 1 is below 3'), notShown.notes.join(' | '));
  assert.equal(notShown.aiPhotos.length, 2);

  // the number: the field stays the number of clips, more marks than clips make more clips, "no AI" and the usable photos cap it
  const count = async (aiMarks, maxAiPhotos = 2) => (await run({ ask: scripted(answerOk).ask, options: { ...AI, maxAiPhotos, aiMarks } })).aiPhotos;
  assert.equal((await count({ 4: 'always' })).length, 2, 'one marked, one of the answer');
  assert.deepEqual((await count({ 0: 'always', 3: 'always', 4: 'always', 5: 'always' })).slice().sort(), [0, 3, 4, 5], 'four marked: four clips, the marked ones');
  // all chosen photos: the usable photos but the marked ones (6 - 2 = 4 clips); the answer of the fixtures has only p1 and p2 as candidates
  const capped = await run({ ask: scripted(answerOk).ask, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS, aiMarks: { 0: 'never', 1: 'never' } } });
  assert.deepEqual(capped.aiPhotos, [2], 'never a marked one');
  assert.ok(capped.notes.includes('AI clips: the answer has 1 candidate for 4 clips'), capped.notes.join(' | '));
}

/* ---------- switch ---------- */

async function testSwitch() {
  const first = scripted(promptedAnswer);
  const options = { ...AI, aiMarks: { 1: 'never' } };
  const before = await liveRun({ ask: first.ask, options });
  assert.equal(first.calls.length, 1);
  assert.deepEqual(before.aiPhotos, [0, 5, 10, 13]);
  assert.deepEqual(Object.keys(before.kept), ['text', 'plain', 'why', 'records', 'model']);
  assert.equal(before.reused, false);
  // the request does not depend on the switches: the key of the answer the node keeps stays
  const input = { brief: material60.brief, style: LIVE(), videos: [], photos: livePhotos(), analysis: beats, musicSeconds: 62 };
  const plain = plan.planRequest({ ...input, options });
  const switched = plan.planRequest({ ...input, options: { ...options, aiChoice: { 2: 'on', 5: 'off' } } });
  assert.deepEqual([switched.system, switched.prompt], [plain.system, plain.prompt]);
  assert.equal(plain.system, first.calls[0].system);
  assert.equal(plain.prompt, first.calls[0].prompt);

  // the approval: p2 and p7 on, p5 off, p1 ("no AI") on: no request, the lists and the cut are made again
  const model = silent();
  const asked = [];
  const after = await liveRun({
    ask: model.ask,
    reuse: async (request) => {
      asked.push(request);
      return before.kept;
    },
    options: { ...options, aiChoice: { 2: 'on', 7: 'on', 5: 'off', 1: 'on' } }
  });
  assert.equal(model.calls.length, 0, 'the language model is not asked');
  assert.deepEqual(asked, [{ system: plain.system, prompt: plain.prompt }], 'the kept answer is asked for with the first request');
  assert.equal(after.reused, true);
  assert.deepEqual(after.tries, [], 'no request in the log of the node');
  assert.deepEqual(after.costs, [], 'nothing paid');
  passesContract(after, 'switched');
  assert.deepEqual(after.aiPhotos, [0, 2, 7, 10, 13]);
  assert.deepEqual(after.aiPrompts, ['Slow push-in on p0.', 'Slow push-in on p2.', 'Slow push-in on p7.', 'Slow push-in on p10.', 'Slow push-in on p13.'], 'the prompts of the answer');
  assert.ok(after.notes.includes('AI clips switched in the approval: on p2, p7; off p5'), after.notes.join(' | '));
  assert.ok(after.notes.includes('p1 stays without an AI clip: marked "no AI"'));
  assert.ok(after.notes.includes('the answer of the language model of an earlier run is used again: no new request'));
  assert.equal(after.shots.shots.filter((shot) => shot.kind === 'photo_ai').length, 5);
  assert.equal(after.cost.parts.ai, 5 * plan.CLIP_SECONDS * PRICES.clipPerSecond, 'the price of five clips');
  assert.match(after.board, /AI clips 5 1\.00/);
  // the parallax: never a photo with an AI clip, the next of the list takes the place
  assert.ok(after.parallaxPhotos.every((index) => !after.aiPhotos.includes(index)));
  // the switches: what the plan gave and what is on now
  const state = Object.fromEntries(after.switches.map((item) => [item.ref, [item.on, item.auto]]));
  assert.deepEqual([state.p2, state.p5, state.p7, state.p0, state.p1], [[true, false], [false, true], [true, false], [true, true], [false, false]]);
  // the kept answer is the same, so a later switch finds it again
  assert.deepEqual(after.kept, before.kept);
  // the same switches with the request: the same plan
  const direct = await liveRun({ ask: scripted(promptedAnswer).ask, options: { ...options, aiChoice: { 2: 'on', 7: 'on', 5: 'off', 1: 'on' } } });
  assert.deepEqual([direct.shots, direct.graphics, direct.aiPhotos, direct.aiPrompts, direct.parallaxPhotos], [after.shots, after.graphics, after.aiPhotos, after.aiPrompts, after.parallaxPhotos]);
  // no switch at all: the plan of before, from the kept answer
  const same = await liveRun({ ask: silent().ask, reuse: async () => before.kept, options });
  assert.deepEqual([same.shots, same.graphics, same.aiPhotos, same.aiPrompts, same.parallaxPhotos], [before.shots, before.graphics, before.aiPhotos, before.aiPrompts, before.parallaxPhotos]);
  // a photo switched on without a prompt in the answer gets the gentle move, and the board says so
  const short = await liveRun({ ask: silent().ask, reuse: async () => (await liveRun({ ask: scripted(liveAnswer).ask, options })).kept, options: { ...options, aiChoice: { 7: 'on' } } });
  assert.equal(short.aiPrompts[short.aiPhotos.indexOf(7)], plan.DEFAULT_AI_PROMPT);
  assert.ok(short.notes.includes('p7 is switched on but the answer has no prompt for it: it gets a gentle camera move'));
}

/* ---------- copies ---------- */

async function testCopies() {
  // p17 is a copy of p3 (livePhotos): the analysis keeps p3, p17 is never in the film
  const material = plan.readMaterial([], livePhotos());
  assert.deepEqual([...material.duplicates], [['p17', 'p3']]);
  const marks = plan.photoMarks(material, { ...AI, aiMarks: { 17: 'never' } });
  assert.deepEqual([[...marks.never], [...marks.always], marks.copies], [['p3'], [], [['p17', 'p3', 'never']]]);
  // "no AI" before "AI clip" when the photo and its copy disagree, either way
  const both = (aiMarks) => {
    const found = plan.photoMarks(material, { ...AI, aiMarks });
    return [[...found.never], [...found.always]];
  };
  assert.deepEqual(both({ 3: 'always', 17: 'never' }), [['p3'], []]);
  assert.deepEqual(both({ 3: 'never', 17: 'always' }), [['p3'], []]);
  assert.deepEqual(both({ 17: 'always' }), [[], ['p3']]);
  assert.deepEqual(plan.photoMarks(material, { ...AI, photoMotion: 'code', aiMarks: { 17: 'never' } }).copies, [], 'no marks with the photos moved by code');

  // "all chosen photos", the copy marked "no AI": the photo that is kept gets no clip, its switch is locked, the prompt and the board say so
  const allOf = (request) => {
    const answer = promptedAnswer(request);
    answer.parallax = [];
    return answer;
  };
  const model = scripted(allOf);
  const never = await liveRun({ ask: model.ask, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS, aiMarks: { 17: 'never' } } });
  passesContract(never, 'copy never');
  assert.match(model.calls[0].system, /except those marked "no AI"\. .* The person marked p3 "no AI"/);
  assert.ok(!never.aiPhotos.includes(3) && !never.aiPhotos.includes(17), `p3 has no AI clip: ${never.aiPhotos}`);
  assert.equal(never.aiPhotos.length, 16, 'every other photo');
  assert.deepEqual(never.switches.find((item) => item.ref === 'p3'), { ref: 'p3', photo: 3, on: false, auto: false, mark: 'never', locked: true });
  assert.ok(never.notes.includes('p17 is a copy of p3: its mark "no AI" holds for p3'), never.notes.join(' | '));
  assert.match(never.board, /p17 is a copy of p3: its mark "no AI" holds for p3/);
  // switched on in the approval: it stays without a clip
  const switched = await liveRun({ ask: silent().ask, reuse: async () => never.kept, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS, aiMarks: { 17: 'never' }, aiChoice: { 3: 'on' } } });
  assert.deepEqual(switched.aiPhotos, never.aiPhotos);

  // the copy has the better quality, the photo marked "no AI" is the one left out: the copy that is kept gets no clip either
  const better = livePhotos();
  better[17].scenes[0].quality = 5;
  assert.deepEqual([...plan.readMaterial([], better).duplicates], [['p3', 'p17']]);
  const swapped = (request) => JSON.parse(JSON.stringify(allOf(request)).replace(/"p3"/g, '"p17"'));
  const kept = await run({ ask: scripted(swapped).ask, style: LIVE(), videos: [], photos: better, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS, aiMarks: { 3: 'never' } } });
  passesContract(kept, 'original never');
  assert.ok(!kept.aiPhotos.includes(17) && !kept.aiPhotos.includes(3), `p17 has no AI clip: ${kept.aiPhotos}`);
  assert.deepEqual(kept.switches.find((item) => item.ref === 'p17'), { ref: 'p17', photo: 17, on: false, auto: false, mark: 'never', locked: true });
  assert.ok(kept.notes.includes('p3 is a copy of p17: its mark "no AI" holds for p17'), kept.notes.join(' | '));

  // the copy marked "AI clip": the photo that is kept gets the clip (no longer "cannot be used")
  const sure = await liveRun({ ask: scripted(liveAnswer).ask, options: { ...AI, maxAiPhotos: 2, aiMarks: { 17: 'always' } } });
  passesContract(sure, 'copy always');
  assert.ok(sure.aiPhotos.includes(3), `p3 has its clip: ${sure.aiPhotos}`);
  assert.equal(sure.aiPhotos.length, 2);
  assert.ok(sure.notes.includes('p17 is a copy of p3: its mark "AI clip" holds for p3'), sure.notes.join(' | '));
  assert.ok(!sure.notes.some((note) => /p17 is marked "AI clip" but cannot be used/.test(note)));
  // "AI clip" on the copy, "no AI" on the photo: no clip, and the board says which mark counts
  const both2 = await liveRun({ ask: scripted(liveAnswer).ask, options: { ...AI, maxAiPhotos: 2, aiMarks: { 3: 'never', 17: 'always' } } });
  assert.ok(!both2.aiPhotos.includes(3));
  assert.ok(both2.notes.includes('p17 is a copy of p3: its mark "AI clip" gives way to "no AI"'), both2.notes.join(' | '));
}

/* ---------- added ---------- */

async function testAdded() {
  // party, 30 s, nine photos, two clips: the shots of the arrival are too short, the code adds p8 (as on main)
  const party = styles.combineStyle({ event_type: 'party', mood: 'fast', length: 30 });
  const nine = Array.from({ length: 9 }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0, subject: `the ${SUBJECTS[index]}` }));
  const answer = (request) => {
    const acts = picksFor(request.system, Array.from({ length: 9 }, (_, index) => `p${index}`));
    const picked = acts.flatMap((act) => act.picks.map((pick) => pick.ref));
    return { treatment: 't', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, ai_photos: picked.map((ref) => ({ ref, prompt: 'gentle drift' })), parallax: [], endcard: { line: 'Danke.', source: 'generic' } };
  };
  const nineRun = (extra) => run({ style: party, videos: [], photos: nine, musicSeconds: 32, ...extra });
  const first = await nineRun({ ask: scripted(answer).ask, options: { ...AI, maxAiPhotos: 2 } });
  passesContract(first, 'added');
  assert.ok(first.notes.includes('arrival: the code added p8, the shots were too short for the act'), first.notes.join(' | '));
  assert.deepEqual(first.aiPhotos, [0, 2]);
  // p8 is in the film but cannot be switched on: the switches are applied to the picks of the answer
  assert.deepEqual(first.switches.find((item) => item.ref === 'p8'), { ref: 'p8', photo: 8, on: false, auto: false, mark: null, locked: true, why: 'added' });
  const picks = new Set();
  for (const act of ACTS) for (const pick of first.content.acts[act]) if (pick.unit.kind === 'photo' && !pick.unit.detail) picks.add(pick.unit.ref);
  for (const item of first.switches) assert.equal(item.locked, !picks.has(item.ref) || item.mark === 'never', `${item.ref}: a switch only for a pick`);
  // switched on all the same (the node view): no clip, the same plan, and the board says why
  const again = await nineRun({ ask: silent().ask, reuse: async () => first.kept, options: { ...AI, maxAiPhotos: 2, aiChoice: { 8: 'on' } } });
  assert.deepEqual([again.aiPhotos, again.shots], [first.aiPhotos, first.shots]);
  assert.ok(again.notes.includes('p8 stays without an AI clip: the plan did not pick it'), again.notes.join(' | '));
  assert.deepEqual(again.switches.find((item) => item.ref === 'p8'), { ref: 'p8', photo: 8, on: false, auto: false, mark: null, locked: true, why: 'added' });
  // the node passes the reason on to the app
  const nodes = require('../lib/nodes/nodes-event-video');
  const values = nine.map((_, index) => ({ type: 'image', assetId: `asset-${index}`, sessionId: 'session-1' }));
  const variant = nodes.planVariant(first, values, { key: 'ans:test', selection: null });
  const items = JSON.parse(variant.ai_switches.value).items;
  assert.equal(items.find((item) => item.label === 'p8').why, 'added');
  assert.ok(items.filter((item) => item.label !== 'p8').every((item) => !('why' in item)), 'only the added photo has a reason of its own');
}

/* ---------- main ---------- */

// The plans of AI mode without marks: shots, graphics, board, lists and notes as with the code of main (34fe755). The digests were computed with
// that code and these scenarios.
const MAIN_DIGESTS = Object.freeze({
  'live 4': '888997820facc7dec6b7b2bdfb6bec6d0a12000b387cb310818b4b082ecb54ca',
  'live 8': '15352e3d1167843ac9c7829c012f011c4b4fb330b6d8bf49543983278091ba1d',
  'live flat': '8538337b3213f02ea8c251c93a7c89b4fea8a6032e927db7a0a13a0a9d305f2c',
  'fixtures ai': '18ab715b2f90b51c9368567bc171dc1880834a8583fcde7a36a7e27aee42a04b',
  'all 9': '4c975408626dc0c61bb338990cf2d5cdff205f0bdffb080c76a4de26fa2cb7b0',
  'prompt all 9': 'b8f1067ed0d81d7d5fac8b359e168dcba74de16fa0fb11587ab2ecf241c19f52'
});
// The cache keys of the node without marks (computed with the code of main)
const MAIN_KEYS = Object.freeze({
  default: 'sha256:d4353ffa5fd8ca7092b3576845ebf9c9ec924d6b8dc152b451d9e5793ab8457c',
  'ai 4': 'sha256:7617779138d126731e39bbeee17d97d4b41395103b32480ec2a133aead2edd6d',
  'ai all': 'sha256:9b5659dcf27e83eb4d128fdd6130e86c88a60d1dc770c4cb1b607a0941686d96'
});

async function testMain() {
  const digestOf = (result) => sha(JSON.stringify({ shots: result.shots, graphics: result.graphics, board: result.board, ai: result.aiPhotos, prompts: result.aiPrompts, parallax: result.parallaxPhotos, notes: result.notes }));
  const out = {};
  out['live 4'] = digestOf(await liveRun({ ask: scripted(liveAnswer).ask, options: AI }));
  out['live 8'] = digestOf(await liveRun({ ask: scripted(liveAnswer).ask, options: { ...AI, maxAiPhotos: 8 } }));
  out['live flat'] = digestOf(await liveRun({ ask: scripted(liveAnswer).ask, options: { ...AI, parallax: false } }));
  out['fixtures ai'] = digestOf(await run({ ask: scripted(answerOk).ask, options: AI }));
  const party = styles.combineStyle({ event_type: 'party', mood: 'fast', length: 30 });
  const nine = Array.from({ length: 9 }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0, subject: `the ${SUBJECTS[index]}` }));
  const allAnswer = (request) => {
    const acts = picksFor(request.system, Array.from({ length: 9 }, (_, index) => `p${index}`));
    const picked = acts.flatMap((act) => act.picks.map((pick) => pick.ref));
    return { treatment: 't', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, ai_photos: picked.map((ref) => ({ ref, prompt: 'gentle drift' })), parallax: ['p1', 'p2'], endcard: { line: 'Danke.', source: 'generic' } };
  };
  out['all 9'] = digestOf(await run({ ask: scripted(allAnswer).ask, style: party, videos: [], photos: nine, musicSeconds: 32, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS } }));
  const material = plan.readMaterial([], nine);
  const grid = plan.planGrid({ analysis: beats, style: party, material, musicSeconds: 32, options: AI });
  out['prompt all 9'] = sha(plan.systemPrompt({ style: party, grid, material, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS } }));
  assert.deepEqual(out, { ...MAIN_DIGESTS });
  // empty marks are no marks
  assert.equal(digestOf(await liveRun({ ask: scripted(liveAnswer).ask, options: { ...AI, aiMarks: {}, aiChoice: {} } })), MAIN_DIGESTS['live 4']);

  // the cache keys of the node: the new params are left out while they hold no mark
  const registry = require('../lib/nodes/registry');
  const nodes = require('../lib/nodes/nodes-event-video');
  const engine = require('../lib/nodes/engine');
  const { textValue, listValue } = require('../lib/nodes/types');
  const own = registry.createRegistry();
  nodes.registerAll(own);
  const def = own.get('event_video.plan');
  const image = (n) => ({ type: 'image', assetId: `asset-${n}`, sessionId: 'session-1', mime: 'image/jpeg', width: 640, height: 480 });
  const inputs = {
    brief: textValue('Innovation Day 2026'),
    style: textValue('{"a":1}'),
    photos: listValue('image', [image(1), image(2), image(3)]),
    photo_info: listValue('text', [textValue('{}'), textValue('{}'), textValue('{}')]),
    music_analysis: textValue('{"beats":[]}')
  };
  const keys = {};
  for (const [name, raw] of [['default', {}], ['ai 4', { photo_motion: 'ai', max_ai_photos: 4 }], ['ai all', { photo_motion: 'ai', max_ai_photos: 50, parallax: false, voiceover: true }]]) {
    keys[name] = engine.computeCacheKey(def, registry.normalizeParams(def, raw), inputs);
  }
  assert.deepEqual(keys, { ...MAIN_KEYS });
  const marked = engine.computeCacheKey(def, registry.normalizeParams(def, { photo_motion: 'ai', max_ai_photos: 4, ai_marks: { 'asset-1': 'never' } }), inputs);
  assert.notEqual(marked, MAIN_KEYS['ai 4'], 'a mark is part of the key');
  assert.equal(engine.computeCacheKey(def, registry.normalizeParams(def, { photo_motion: 'ai', max_ai_photos: 4, ai_marks: { 'asset-1': 'auto' } }), inputs), MAIN_KEYS['ai 4'], '"auto" is no mark');
  // the stamp without switches is the one of main; with switches it holds the key of the answer
  const ctx = { user: 'staff1@staff.example.com', config: { defaultBrain: 'anthropic/claude-opus-5.5' }, sessionId: 'session-1', inputs: {} };
  const explainer = require('../lib/nodes/nodes-explainer');
  const params = registry.normalizeParams(def, { photo_motion: 'ai' });
  assert.deepEqual(await def.cacheStamp(params, ctx), explainer.fallbackBrainStamp(params, ctx));
  const stamped = await def.cacheStamp(registry.normalizeParams(def, { photo_motion: 'ai', ai_choice: { 'asset-1': 'on' } }), ctx);
  assert.ok(stamped && 'answer' in stamped, 'with switches the stamp names the answer');
  assert.equal(stamped.answer, null, 'unknown while the length of the music is not known');
  // which answer (review): the newest of the earlier results, named only when they keep more than one answer for the key
  const kept = (key, id) => ({ variants: [{ ai_switches: textValue(JSON.stringify({ version: 1, answer: { key, id } })) }] });
  assert.deepEqual(nodes.answerStamp([], 'ans:a'), {});
  assert.deepEqual(nodes.answerStamp([kept('ans:a', 'one'), kept('ans:a', 'one'), kept('ans:b', 'other')], 'ans:a'), {}, 'one answer: the key alone');
  assert.deepEqual(nodes.answerStamp([kept('ans:a', 'two'), kept('ans:a', 'one'), kept('ans:a', 'one')], 'ans:a'), { id: 'two' }, 'two answers: the newest');
  assert.deepEqual(nodes.answerStamp([kept('ans:a', 'two'), kept('ans:a', 'one')], null), {});
}

/* ---------- format ---------- */

function testFormat() {
  const registry = require('../lib/nodes/registry');
  // the kind
  const own = registry.createRegistry();
  const define = (param, extra = {}) =>
    own.register({ type: `test.marks${own.list().length}`, category: 'utility', label: 'x', inputs: [{ id: 'files', type: 'image[]' }], outputs: [{ id: 'list', type: 'text', hidden: true }], execute: async () => ({}), params: [{ id: 'm', kind: 'marks', options: ['auto', 'yes', 'no'], items: 'files', default: {}, ...param }], ...extra });
  assert.doesNotThrow(() => define({}));
  assert.doesNotThrow(() => define({ source: 'list' }));
  assert.throws(() => define({ options: ['auto'] }), /param m has bad marks/);
  assert.throws(() => define({ options: ['auto', ''] }), /param m has bad marks/);
  assert.throws(() => define({ items: 'Files' }), /param m has bad marks/);
  assert.throws(() => define({ default: { a: 'yes' } }), /param m has bad marks/);
  assert.throws(() => define({ items: 'other' }), /marks the items of unknown input other/);
  assert.throws(() => define({ source: 'nope' }), /lists its items at unknown output nope/);
  const def = own.list()[0];
  assert.deepEqual(registry.normalizeParams(def, {}).m, {});
  // sorted ids, only the options after the first, valid ids, at most MAX_MARKS
  assert.deepEqual(registry.normalizeParams(def, { m: { b2: 'no', a1: 'yes', c3: 'auto', d4: 'maybe', 'e/5': 'yes', f6: 1 } }).m, { a1: 'yes', b2: 'no' });
  assert.deepEqual(registry.normalizeParams(def, { m: ['a1'] }).m, {});
  const many = Object.fromEntries(Array.from({ length: registry.MAX_MARKS + 5 }, (_, index) => [`id${String(index).padStart(4, '0')}`, 'yes']));
  assert.equal(Object.keys(registry.normalizeParams(def, { m: many }).m).length, registry.MAX_MARKS);
  // the planner of the event video
  const nodes = require('../lib/nodes/nodes-event-video');
  const planDef = registry.registry.get('event_video.plan');
  const marks = planDef.params.find((param) => param.id === 'ai_marks');
  const choice = planDef.params.find((param) => param.id === 'ai_choice');
  assert.deepEqual([marks.kind, marks.options, marks.items, marks.cacheOmitDefault, marks.showIf], ['marks', ['auto', 'never', 'always'], 'photos', true, { param: 'photo_motion', equals: 'ai' }]);
  assert.deepEqual([choice.kind, choice.options, choice.items, choice.source], ['marks', ['auto', 'on', 'off'], 'photos', 'ai_switches']);
  assert.deepEqual(nodes.markOptions({ ai_marks: { b: 'never', z: 'always' }, ai_choice: { a: 'on' } }, [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }]), { aiMarks: { 1: 'never' }, aiChoice: { 0: 'on' } });
  assert.deepEqual(nodes.markOptions({ ai_marks: {}, ai_choice: {} }, [{ assetId: 'a' }]), {});

  // the app section on the server: marks of a list of files, switches of an output; a gone node is dropped, a wrong param refused
  const { normalizeApp, pruneApp } = require('../lib/nodes/workflows-store');
  const templates = require('../lib/nodes/templates');
  const doc = templates.resolveTemplate('event-video', { lang: 'de' });
  assert.deepEqual(doc.app.inputs.find((entry) => entry.node === 'n2').marks, { node: 'n10', param: 'ai_marks' });
  assert.deepEqual(doc.app.outputs.find((entry) => entry.node === 'n25').switches, { node: 'n10', param: 'ai_choice' });
  const app = normalizeApp(doc.app, doc.graph);
  assert.deepEqual(app, doc.app, 'the template keeps them');
  const withInput = (patch) => normalizeApp({ ...doc.app, inputs: doc.app.inputs.map((entry) => (entry.node === 'n2' ? { ...entry, ...patch } : entry)) }, doc.graph);
  assert.throws(() => withInput({ marks: { node: 'n10', param: 'max_ai_photos' } }), /is no param of marks/);
  assert.equal(withInput({ marks: { node: 'gone', param: 'ai_marks' } }).inputs.find((entry) => entry.node === 'n2').marks, undefined);
  assert.equal(withInput({ marks: 'n10.ai_marks' }).inputs.find((entry) => entry.node === 'n2').marks, undefined);
  assert.throws(() => normalizeApp({ ...doc.app, inputs: doc.app.inputs.map((entry) => (entry.node === 'n3' ? { ...entry, marks: { node: 'n10', param: 'ai_marks' } } : entry)) }, doc.graph), /marks need a list of files/);
  assert.throws(() => normalizeApp({ ...doc.app, outputs: doc.app.outputs.map((entry) => (entry.node === 'n25' ? { ...entry, switches: { node: 'n10', param: 'voiceover' } } : entry)) }, doc.graph), /is no param of marks/);
  // the planner gone from the graph: the marks and switches go, the fields stay
  const without = { ...doc.graph, nodes: doc.graph.nodes.filter((node) => node.id !== 'n10') };
  const pruned = pruneApp(app, without);
  assert.equal(pruned.inputs.find((entry) => entry.node === 'n2').marks, undefined);
  assert.equal(pruned.outputs.find((entry) => entry.node === 'n25').switches, undefined);
  assert.equal(pruned.inputs.find((entry) => entry.node === 'n2').label, app.inputs.find((entry) => entry.node === 'n2').label);
  // the other templates have neither
  const others = templates.loadTemplates().filter((template) => template.id !== 'event-video');
  assert.ok(others.length >= 30, `the other templates: ${others.length}`);
  for (const template of others) {
    assert.ok(!(template.app?.inputs || []).some((entry) => entry.marks) && !(template.app?.outputs || []).some((entry) => entry.switches), template.id);
  }

  // the app section in the browser (public/nodes/main.js): the same fields
  const match = read('public/nodes/main.js').match(/function normalizeApp\(raw\) \{[\s\S]*?\n  \}\n/);
  assert.ok(match, 'main.js has normalizeApp');
  const client = new Function(`${match[0]}; return normalizeApp;`)();
  const back = client(JSON.parse(JSON.stringify(doc.app)));
  assert.deepEqual(back.inputs.find((entry) => entry.node === 'n2').marks, { node: 'n10', param: 'ai_marks' });
  assert.deepEqual(back.outputs.find((entry) => entry.node === 'n25').switches, { node: 'n10', param: 'ai_choice' });
  assert.equal(client({ inputs: [{ node: 'n2', param: 'assets', marks: 'x' }], outputs: [{ node: 'n25', switches: { node: 1 } }] }).inputs[0].marks, undefined);
}

/* ---------- widgets ---------- */

async function testWidgets() {
  const { loadPage, FakeNode } = require('./support/fake-dom');
  const registry = require('../lib/nodes/registry');
  const planDef = registry.registry.get('event_video.plan');
  const marks = planDef.params.find((param) => param.id === 'ai_marks');
  const node = { id: 'n10', type: 'event_video.plan', params: {} };
  const words = {
    de: { never: 'nie KI', always: 'sicher KI', none: 'Keine Markierungen', clear: 'Alle entfernen', label: 'KI pro Foto', sum: 'KI-Clips: 3 · ≈ 0.60 USD', generic: 'Eingeschaltet: 3 · ≈ 0.60 USD' },
    en: { never: 'never AI', always: 'always AI', none: 'No marks', clear: 'Remove all', label: 'AI per photo', sum: 'AI clips: 3 · ≈ 0.60 USD', generic: 'Switched on: 3 · ≈ 0.60 USD' },
    es: { never: 'nunca IA', always: 'siempre IA', none: 'Sin marcas', clear: 'Quitar todas', label: 'IA por foto', sum: 'Clips de IA: 3 · ≈ 0.60 USD', generic: 'Activados: 3 · ≈ 0.60 USD' }
  };
  for (const lang of ['de', 'en', 'es']) {
    const page = loadPage(lang, { scripts: ['node-ui', 'preview'] });
    const ui = page.OCD.ui;
    const w = words[lang];
    // the inspector: how many photos carry which mark, and a button that takes them all away
    const changes = [];
    const widget = ui.paramWidget(marks, { a: 'never', b: 'always', c: 'always' }, { node, onChange: (value, meta) => changes.push([value, meta.commit]) });
    assert.equal(widget.el.children[0].textContent, `${w.never}: 1 · ${w.always}: 2`, `${lang}: the summary`);
    const clear = widget.el.children[1];
    assert.equal(clear.textContent, w.clear);
    assert.equal(clear.hidden, false);
    clear.fire('click');
    assert.deepEqual(JSON.parse(JSON.stringify(changes)), [[{}, true]]);
    assert.ok(widget.el.children[0].textContent.startsWith(w.none), `${lang}: no marks`);
    assert.equal(clear.hidden, true);
    widget.set({ x: 'never' });
    assert.equal(widget.get().x, 'never');
    assert.equal(ui.paramLabel('ai_marks'), w.label);
    assert.ok(ui.paramHint('event_video.plan', 'ai_marks').length > 40, `${lang}: the hint of the marks`);
    assert.ok(ui.paramHint('event_video.plan', 'ai_choice').length > 40, `${lang}: the hint of the switches`);
    // the list of files shows what the caller adds to each file (the marks of the app view)
    const files = [
      { type: 'image', assetId: 'a1', sessionId: 's', file: 'one.jpg', url: 'assets/one.jpg', mime: 'image/jpeg' },
      { type: 'image', assetId: 'a2', sessionId: 's', file: 'two.jpg', url: 'assets/two.jpg', mime: 'image/jpeg' }
    ];
    const seen = [];
    const list = ui.paramWidget({ id: 'assets', kind: 'assets', accept: 'image' }, files, {
      node: { id: 'n2', type: 'input.media_list', params: { kind: 'image' } },
      onChange() {},
      itemExtra: (item, index) => {
        seen.push([item.assetId, index]);
        const mark = new FakeNode('select');
        mark.classList.add('nv-asset-mark');
        return mark;
      }
    });
    assert.deepEqual(seen, [['a1', 0], ['a2', 1]], `${lang}: one extra per file`);
    assert.equal(list.el.find((item) => item.classes.has('nv-asset-mark')).length, 2);
    // the texts of the panel of the switches: a wording of the param where it has one
    const T = page.window.I18N[lang];
    const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
    assert.equal(fill(T['nodes.app.switchesSum.ai_choice'], { count: 3, usd: '0.60' }), w.sum);
    assert.equal(fill(T['nodes.app.switchesSum'], { count: 3, usd: '0.60' }), w.generic);
    for (const key of ['nodes.app.markLabel', 'nodes.app.switchItem', 'nodes.app.switchLocked', 'nodes.app.switchLocked.added', 'nodes.app.switchesCount', 'nodes.app.switchesHint', 'nodes.app.switchesCount.ai_choice', 'nodes.option.ai_choice.on', 'nodes.option.ai_choice.off', 'nodes.param.ai_choice']) {
      assert.ok(T[key] && !T[key].includes('ß'), `${lang}: ${key}`);
    }
    assert.ok(T['nodes.app.switchLocked'].includes('{mark}') && T['nodes.app.markLabel'].includes('{item}'));
  }

  // the pure functions of the switches (public/nodes/app-mode.js)
  const vm = require('vm');
  const window = { OCDNodes: { graph: {}, ui: { el: () => ({}), icon: () => ({}), T: (key) => key }, api: {}, run: {} } };
  vm.runInNewContext(read('public/nodes/app-mode.js'), { window, localStorage: undefined, console });
  const app = window.OCDNodes.appMode;
  const plainOf = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plainOf(app.marksOfItems({ a: 'never', b: 'auto', gone: 'always', c: 'maybe' }, [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }], ['auto', 'never', 'always'])), { a: 'never' });
  const payload = app.switchPayload(
    JSON.stringify({
      version: 1,
      unit: { usd: 0.2 },
      answer: { id: 'answer-1', key: 'ans:x' },
      items: [
        { id: 'a', label: 'p0', on: true, auto: true, mark: null, locked: false },
        { id: 'b', label: 'p1', on: false, auto: false, mark: 'never', locked: true },
        { id: 'c', label: 'p2', on: false, auto: false, mark: null, locked: false },
        { label: 'no id' }
      ]
    })
  );
  assert.equal(payload.base, 'answer-1');
  assert.equal(payload.items.length, 3);
  assert.equal(app.switchPayload('not json'), null);
  const start = plainOf(app.switchView(payload, {}));
  assert.deepEqual([start.count, start.usd], [1, 0.2]);
  let value = app.toggleSwitch({}, payload.items[2], true);
  assert.deepEqual(plainOf(value), { c: 'on' });
  value = app.toggleSwitch(value, payload.items[0], false);
  assert.deepEqual(plainOf(value), { c: 'on', a: 'off' });
  assert.deepEqual(plainOf(app.toggleSwitch(value, payload.items[1], true)), plainOf(value), 'a locked item stays');
  value = app.toggleSwitch(value, payload.items[0], true);
  assert.deepEqual(plainOf(value), { c: 'on' }, 'back to the plan: no entry');
  const view = plainOf(app.switchView(payload, { ...value, b: 'on' }));
  assert.deepEqual([view.items.map((item) => item.on), view.count, view.usd], [[true, false, true], 2, 0.4], 'the locked one stays off');
  // the state read back from a result made with switches
  assert.deepEqual(plainOf(app.switchesFromItems([{ id: 'a', on: false, auto: true }, { id: 'b', on: true, auto: false }, { id: 'c', on: true, auto: true }, { id: 'd', on: false, auto: false, locked: true }])), { a: 'off', b: 'on' });
  // the switches count only for the steps after their stage (stageFlow with the overrides of each stage)
  const flow = app.stageFlow({
    stages: [['n25']],
    overrides: { n10: { ai_choice: { c: 'on' } } },
    stageOverrides: [{ n10: {} }],
    previews: [{ nodes: { n25: { status: 'stale' } }, order: ['n10', 'n25'] }],
    all: { nodes: {} }
  });
  assert.deepEqual(plainOf(flow.request.overrides), { n10: {} }, 'step 1 is asked without the switches');
}

/* ---------- engine ---------- */

const STAFF = 'staff1@staff.example.com';
const BRIEF = 'Innovation Day 2026 der Muster AG am 12. März 2026 in Zürich. Anna Muster, CEO, eröffnet den Tag. Danach Workshops und ein Apéro.';

function beatsFor(seconds) {
  const before = (t) => t < seconds;
  return {
    ...beats,
    duration: seconds,
    beats: beats.beats.filter(before),
    downbeats: beats.downbeats.filter(before),
    hits: beats.hits.filter((hit) => before(hit.t)),
    energy: beats.energy.slice(0, Math.floor(seconds * 2)),
    sections: beats.sections.filter((section) => before(section.start)).map((section) => ({ ...section, end: Math.min(section.end, seconds) }))
  };
}

// The planner "answers" from its prompt (as test-event-video-chain.js): the photos in order, as many per act as the grid asks for; every photo is a
// candidate with a prompt of its own, p0 first
function planAnswer(system, prompt) {
  const acts = [...system.matchAll(/(hook|arrival|programme|people|peak|close) (\d+) picks?/g)].map((match) => ({ act: match[1], count: Number(match[2]) }));
  const units = [];
  for (const line of prompt.split('\n')) {
    const found = /^(p\d+) photo/.exec(line);
    if (found) units.push(found[1]);
  }
  const queue = units.slice();
  return {
    treatment: 'A bright day of ideas.',
    acts: acts.map(({ act, count }) => ({ act, picks: queue.splice(0, count).map((ref) => ({ ref, why: 'a good moment', slow: false, pair: null })) })),
    soundbites: [],
    title: { text: 'Innovation Day 2026', sub: 'Zürich, 12. März 2026', source: 'description' },
    lower_thirds: [],
    intertitles: [],
    ai_photos: units.map((ref) => ({ ref, prompt: `slow push in on ${ref}, people move a little` })),
    parallax: units.slice(1, 3),
    voiceover: [],
    endcard: { line: 'Danke, Zürich.', sub: null, url: null, source: 'description' }
  };
}

async function testEngine() {
  const { createIsolatedApp } = require('./support/isolated-app');
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: 'admin@example.com',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'test-openrouter-key-0123456789',
      ELEVENLABS_API_KEY: 'test-elevenlabs-key-0123456789',
      FAL_KEY: 'test-fal-key-0123456789',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      GTS_API_TOKEN: ''
    }
  });
  const restorers = [];
  const patch = (target, key, value) => {
    const before = target[key];
    target[key] = value;
    restorers.push(() => {
      target[key] = before;
    });
  };
  try {
    await engineFlow(iso, patch);
  } finally {
    while (restorers.length) restorers.pop()();
    global.fetch = original;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
}

async function engineFlow(iso, patch) {
  const ffmpegLib = iso.load('lib/ffmpeg');
  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the flow through the engine is skipped');
    return;
  }
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const tools = iso.load('lib/tools');
  const costs = iso.load('lib/costs');
  const registryModule = iso.load('lib/nodes/registry');
  const templatesLib = iso.load('lib/nodes/templates');
  const vision = iso.load('lib/event-video/vision');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue } = iso.load('lib/nodes/types');
  const toneWav = require('./support/explainer-media').toneWav;
  const ff = (args) => execFileAsync(bins.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
  const workDir = await fsp.mkdtemp(path.join(iso.root, 'event-marks-'));

  // the providers, replaced: the vision model, the planner (counted), the music, the beats, the depth maps and the AI clips (counted)
  patch(costs, 'recordCost', async (entry) => entry);
  const seen = { planner: [], clips: [], depth: 0 };
  let looked = 0;
  // a later answer of the planner ranks the photos the other way round (a forced run: a new answer for the same request)
  let reversed = false;
  patch(llm, 'completeText', async (options) => {
    if (options.system === vision.SYSTEM) {
      const n = looked++;
      const answer = { subject: `guests at the event, photo ${n}`, people: '2-5', faces_visible: true, emotion: 'laughing', action: 'other', framing: ['wide', 'medium', 'close', 'detail'][n % 4], stage: false, text_in_image: [], risk: [], fit: ['b_roll'], score: 4 };
      return { text: JSON.stringify(answer), usd: 0.006 };
    }
    seen.planner.push(options);
    const answer = planAnswer(options.system, options.prompt);
    if (reversed) answer.ai_photos.reverse();
    return { text: JSON.stringify(answer), usd: 0.4, model: options.model, usage: { completion_tokens: 4000 } };
  });
  const originalTool = tools.executeTool;
  patch(tools, 'executeTool', async (ctx, name, args) => {
    if (name === 'generate_music') {
      const saved = await store.saveAsset(ctx.sessionId, { kind: 'audio', buffer: toneWav(args.length_seconds, 220), ext: '.wav', prompt: args.prompt, cost: 0 });
      return { asset: saved };
    }
    return originalTool(ctx, name, args);
  });
  const registry = registryModule.createRegistry();
  for (const def of registryModule.registry.list()) registry.register(def);
  const double = (type, execute) => {
    const def = registry.get(type);
    registry.unregister(type);
    registry.register({ ...def, available: () => true, prepare: undefined, execute });
  };
  const scratchFile = async (ctx, name) => path.join(await assets.createScratchDir(ctx.sessionId), name);
  const keepFile = async (ctx, file, options) => {
    const value = await ctx.saveOutputFile({ sourceFile: file, ...options });
    await assets.removeScratchDir(path.dirname(file));
    return value;
  };
  double('audio.beats', async (_ctx, inputs) => ({ variants: [{ analysis: textValue(JSON.stringify(beatsFor(inputs.audio.duration || 32))) }] }));
  double('fal.depth_map', async (ctx) => {
    seen.depth += 1;
    const file = await scratchFile(ctx, 'depth.png');
    await ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x48,format=gray', '-frames:v', '1', file]);
    return { variants: [{ depth: await keepFile(ctx, file, { kind: 'image', ext: '.png', prompt: 'depth map', cost: 0 }) }] };
  });
  double('fal.h3_video', async (ctx, inputs, params) => {
    seen.clips.push({ photo: inputs.first_frame.assetId, prompt: inputs.prompt.value });
    const file = await scratchFile(ctx, 'clip.mp4');
    await ff(['-f', 'lavfi', '-i', `testsrc2=s=320x180:r=24:d=${params.duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    return { variants: [{ video: await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: inputs.prompt.value, cost: 0, duration: params.duration }) }] };
  });
  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-event-marks'), registry, events: bus });
  const engineConfig = { imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5', defaultBrain: 'anthropic/claude-opus-5.5', brainModels: ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5'] };
  const engine = createEngine({ store: flowStore, registry, events: bus, getConfig: () => engineConfig, limits: { jobPollMs: 20 } });

  // six photos of different shapes (the analysis must not take them for duplicates)
  const PATTERNS = ['mandelbrot', 'testsrc', 'cellauto', 'pal100bars', 'yuvtestsrc', 'smptehdbars'];
  const photos = [];
  for (let index = 0; index < 6; index += 1) {
    const file = path.join(workDir, `photo-${index}.jpg`);
    await ff(['-f', 'lavfi', '-i', `${PATTERNS[index]}=s=${index % 2 ? '640x480' : '480x640'}:r=1`, '-vf', `hue=h=${index * 50},format=yuvj420p`, '-frames:v', '1', '-q:v', '3', file]);
    photos.push(file);
  }
  const created = await flowStore.createWorkflow({ document: templatesLib.resolveTemplate('event-video', { lang: 'de' }), user: STAFF, owner: null });
  const workflow = created.workflow;
  const graph = JSON.parse(JSON.stringify(workflow.graph));
  const params = (id, values) => Object.assign(graph.nodes.find((node) => node.id === id).params, values);
  const ids = [];
  for (const file of photos) {
    const saved = await store.saveAsset(workflow.sessionId, { kind: 'upload', buffer: await fsp.readFile(file), ext: '.jpg', prompt: 'seed' });
    ids.push(saved.id);
  }
  params('n2', { assets: ids.map((assetId) => ({ assetId, sessionId: workflow.sessionId })) });
  params('n3', { prompt: BRIEF });
  params('n0', { length: '30', format: '9:16', event_type: 'party', mood: 'fast', language: 'de' });
  params('n10', { photo_motion: 'ai', max_ai_photos: 1 });
  await flowStore.saveGraph(workflow.id, { baseRev: workflow.rev, graph });
  const finish = async (request) => {
    const runId = await engine.start(workflow.id, { user: STAFF, ...request });
    const record = await engine.whenFinished(workflow.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 1500));
    return record;
  };
  const latest = async () => (await flowStore.readResults(workflow.id)).nodes.n10.history[0];
  const STEP1 = ['n23', 'n24', 'n25'];

  // step 1: the photo p0 is marked "never AI" in the form (the marks of the app go with the request, by asset id)
  const aiMarks = { [ids[0]]: 'never' };
  await finish({ mode: 'selection', nodeIds: STEP1, overrides: { n10: { ai_marks: aiMarks } } });
  assert.equal(seen.planner.length, 1, 'one answer of the planner');
  assert.match(seen.planner[0].system, /The person marked p0 "no AI"/);
  const first = await latest();
  const step1 = first.variants[0];
  assert.ok(!step1.ai_photos.items.some((item) => item.assetId === ids[0]), 'p0 has no AI clip although the answer ranks it first');
  assert.equal(step1.ai_photos.items.length, 1);
  const switches = JSON.parse(step1.ai_switches.value);
  assert.equal(switches.param, 'ai_choice');
  assert.equal(switches.unit.usd, 0.2, 'the price of one clip: H3 Max turbo, 768P, 5 s');
  assert.ok(switches.answer.text && switches.answer.key.startsWith('ans:') && switches.answer.id, 'the answer is kept');
  const locked = switches.items.find((item) => item.id === ids[0]);
  assert.deepEqual([locked.locked, locked.mark, locked.on], [true, 'never', false]);
  const auto = switches.items.filter((item) => item.auto);
  assert.equal(auto.length, 1);
  const free = switches.items.filter((item) => !item.auto && !item.locked);
  assert.ok(free.length >= 2, `photos to switch on: ${free.length}`);

  // the approval: the clip of the plan off, two others on, p0 on (the app does not send it: the server holds the mark anyway)
  const aiChoice = { [auto[0].id]: 'off', [free[0].id]: 'on', [free[1].id]: 'on', [ids[0]]: 'on' };
  const overrides = { n10: { ai_marks: aiMarks, ai_choice: aiChoice } };
  const without = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides: { n10: { ai_marks: aiMarks } } });
  const planned = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides });
  assert.equal(without.nodes.n10.status, 'cached');
  assert.equal(without.nodes.n11.executions, 1);
  // the planner is free in the plan (its answer is kept), the clips are known before the run: the cost of step 2 counts two clips
  assert.deepEqual([planned.nodes.n10.status, planned.nodes.n10.paid, planned.nodes.n10.free, planned.nodes.n10.estimate], ['stale', false, true, null]);
  assert.equal(planned.nodes.n11.executions, 2);
  assert.equal(planned.nodes.n11.estimate.usd, 0.2);
  assert.equal(planned.nodes.n25.status, 'cached', 'the chosen shots stay: the same sources, the same contact sheet');
  assert.equal(planned.totals.unknownNodes, without.totals.unknownNodes, 'nothing becomes unknown');
  // the cost of the step: the paid nodes that run, each as often as it runs (the planner not among them)
  const cost = (plan) => Object.values(plan.nodes).reduce((sum, entry) => sum + (entry.paid && entry.status !== 'cached' && entry.estimate ? entry.estimate.usd * entry.executions : 0), 0);
  assert.equal(Math.round(planned.totals.usd * 10000), Math.round(cost(planned) * 10000));
  const depth = (plan) => (plan.nodes.n12a.status === 'cached' ? 0 : plan.nodes.n12a.estimate.usd * plan.nodes.n12a.executions);
  assert.equal(Math.round((planned.totals.usd - without.totals.usd) * 10000), Math.round((0.2 + depth(planned) - depth(without)) * 10000), 'one clip more (two instead of one), the depth maps as they follow');

  // step 2 up to the clips: no new answer, nothing paid for the planner, the clips of the switches with the prompts of the answer
  const record = await finish({ mode: 'selection', nodeIds: ['n11'], overrides });
  assert.equal(seen.planner.length, 1, 'the planner is not asked again');
  assert.equal(record.nodes.n10.status, 'done');
  const second = await latest();
  assert.equal(second.cost.usd, 0, 'nothing paid for the planner');
  const made = second.variants[0];
  assert.deepEqual(made.ai_photos.items.map((item) => item.assetId).sort(), [free[0].id, free[1].id].sort());
  assert.deepEqual(seen.clips.map((clip) => clip.photo).sort(), [free[0].id, free[1].id].sort());
  for (const clip of seen.clips) assert.match(clip.prompt, /^slow push in on p\d+, people move a little$/, 'the prompt of the answer');
  assert.deepEqual(made.selection, step1.selection, 'the contact sheet of step 1');
  const after = JSON.parse(made.ai_switches.value);
  assert.equal(after.answer.id, switches.answer.id, 'the same answer: the switches stay in the app');
  assert.deepEqual(after.items.filter((item) => item.on).map((item) => item.id).sort(), [free[0].id, free[1].id].sort());
  assert.ok(after.items.find((item) => item.id === ids[0]).locked);
  // step 1 is still done: its plan without the switches finds the result of before
  const preview = await engine.plan(workflow.id, { mode: 'selection', nodeIds: STEP1, user: STAFF, overrides: { n10: { ai_marks: aiMarks } } });
  assert.equal(preview.nodes.n10.status, 'cached');
  // other switches later: again no request
  await finish({ mode: 'selection', nodeIds: ['n11'], overrides: { n10: { ai_marks: aiMarks, ai_choice: { [free[0].id]: 'on' } } } });
  assert.equal(seen.planner.length, 1);
  assert.equal(seen.clips.length, 3, 'the clip of the plan is made, the one switched on is taken from the cache');

  // (review) the planner forced to run again (the node view) asks the model once more: a new answer for the same request, shown with its board and
  // switches. The switches of the first approval again: the result made from the first answer must not be found by its key
  reversed = true;
  await finish({ mode: 'selection', nodeIds: ['n10'], force: true, overrides: { n10: { ai_marks: aiMarks } } });
  assert.equal(seen.planner.length, 2, 'a new answer');
  const renewed = JSON.parse((await latest()).variants[0].ai_switches.value);
  assert.equal(renewed.answer.key, switches.answer.key, 'the same request');
  assert.notEqual(renewed.answer.id, switches.answer.id, 'another answer');
  const replanned = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides });
  assert.deepEqual([replanned.nodes.n10.status, replanned.nodes.n10.paid, replanned.nodes.n10.free], ['stale', false, true], 'free, but not the result of before');
  await finish({ mode: 'selection', nodeIds: ['n11'], overrides });
  assert.equal(seen.planner.length, 2, 'no request: the switches are applied to the answer it holds');
  const fourth = await latest();
  assert.equal(fourth.cost.usd, 0);
  const applied = JSON.parse(fourth.variants[0].ai_switches.value);
  assert.equal(applied.answer.id, renewed.answer.id, 'the switches are applied to the new answer');
  assert.notDeepEqual(fourth.variants[0].shots, second.variants[0].shots, 'not the plan of the first answer');
  const results = await flowStore.readResults(workflow.id);
  assert.equal(results.nodes.n10.selected.entry, fourth.id, 'the result shown is the one of the new answer');
  // and it stays: the plan of the same switches finds it now
  const settled = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides });
  assert.equal(settled.nodes.n10.status, 'cached');
}

async function main() {
  for (const test of [testNever, testSure, testSwitch, testCopies, testAdded, testMain, testFormat, testWidgets, testEngine]) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log('test-event-video-ai-marks.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
