'use strict';

// The AI clips of the event video (live test 2026-10-11: a film of 60 s from 17 photos had three of its four AI clips in the first 11.5 s and only zoom
// and pan in the middle). lib/event-video/plan.js, the node event_video.plan and the field "AI clips" of the page. No network, nothing paid: the
// language model is replaced by answers of the test.
//   spread      spreadAiPhotos: the share of every act by its photos (largest remainder), the best candidates of an act, a share left over goes by the
//               rank, no two AI shots in a row where another candidate allows it
//   live        the case of the live test: at most one AI clip in hook and arrival, the others in the acts after, the parallax for photos without one
//   depth list  the parallax list of the answer may hold photos that get an AI clip (the model cannot know which candidates the spread takes): the
//               prompt asks for parallax + ai photos, the code gives the parallax to the first without an AI clip
//   all         "all chosen photos": a prompt for every photo, every photo an AI clip, no parallax
//   no shot     an AI clip whose shot is not in the film is not made, the clips are numbered again (D1)
//   code        the photos moved by code: the prompts and the plans of main, byte for byte (digests computed with the code of main, 3a4c45b)
//   field       the integer with a list of values: the registry checks it, the page shows a list that hands on numbers, the run service names it

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contract = require('../lib/event-video/contract');
const styles = require('../lib/event-video/styles');
const plan = require('../lib/event-video/plan');

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
const CODE = Object.freeze({ photoMotion: 'code', parallax: true, voiceover: false, lowerThirds: true, soundbites: 'auto' });

// A photo of the material (as in test-event-video-plan.js); `subject` gives the photos subjects that do not look alike
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
const photos = (count) => Array.from({ length: count }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0 }));

function scripted(answerFor) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    const answer = typeof answerFor === 'function' ? answerFor(request) : answerFor;
    return { text: JSON.stringify(answer), usd: 0.3, model: 'anthropic/claude-opus-5.5', usage: { completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 5000 } } };
  };
  return { ask, calls };
}

function run(extra) {
  return plan.runEventPlanner({ brief: material60.brief, style: styleFixture, videos: material60.videos, photos: material60.photos, analysis: beats, musicSeconds: 62, prices: PRICES, sleep: async () => {}, ...extra });
}

// The picks the grid asks for (read from the system prompt), the usable photos in order
function picksFor(system, refs) {
  const counts = Object.fromEntries([...system.matchAll(/(\w+) (\d+) picks? \(/g)].map((match) => [match[1], Number(match[2])]));
  let next = 0;
  return ACTS.map((act) => ({ act, picks: Array.from({ length: counts[act] }, () => ({ ref: refs[next++], why: 'a photo' })) }));
}

function passesContract(result, label) {
  assert.deepEqual(contract.checkPair(result.shots, result.graphics).problems, [], label);
  assert.ok(contract.checkShots(result.shots).ok && contract.checkGraphics(result.graphics).ok, label);
}

/* ---------- the spread ---------- */

// The picks of the acts as validateAnswer has them: "p<n>" a photo, "v<n>#<i>" a scene
function actsOf(layout) {
  const unit = (ref) => (ref.startsWith('p') ? { ref, kind: 'photo', element: ref } : { ref, kind: 'scene', element: ref.split('#')[0] });
  return Object.fromEntries(ACTS.map((act) => [act, (layout[act] || []).map((ref) => ({ unit: unit(ref), pair: null }))]));
}
const candidatesOf = (refs) => refs.map((ref) => ({ ref, photo: Number(ref.slice(1)), prompt: 'slow push in' }));
const refsOf = (spread) => spread.chosen.map((item) => item.ref);

function testSpread() {
  // the live test: 17 photos (2, 2, 5, 3, 3, 2), four clips; the model ranked three photos of hook and arrival and one of the close first
  const live = actsOf({ hook: ['p0', 'p1'], arrival: ['p2', 'p3'], programme: ['p4', 'p5', 'p6', 'p7', 'p8'], people: ['p9', 'p10', 'p11'], peak: ['p12', 'p13', 'p14'], close: ['p15', 'p16'] });
  const ranked = candidatesOf(['p0', 'p2', 'p3', 'p15', 'p5', 'p10', 'p13', 'p6']);
  const spread = plan.spreadAiPhotos(ranked, live, 4);
  // shares 4 x photos / 17: programme 1 (1.18), people and peak the largest remainders (0.71), then hook, arrival and close (0.47 each): the hook has
  // the best candidate
  assert.deepEqual(refsOf(spread), ['p0', 'p5', 'p10', 'p13']);
  assert.deepEqual(spread.chosen.map((item) => item.prompt), ['slow push in', 'slow push in', 'slow push in', 'slow push in']);
  assert.equal(spread.note, 'AI clips: 4 of 8 candidates, spread over the acts by their photos (hook 1, programme 1, people 1, peak 1); no AI clip for p2, p3, p15, p6');
  // an act without a candidate gives its share to the best candidate left (here the second of the arrival, which is not next to the first)
  const noPeak = plan.spreadAiPhotos(candidatesOf(['p0', 'p2', 'p5', 'p10', 'p3']), live, 4);
  assert.deepEqual(refsOf(noPeak), ['p0', 'p2', 'p5', 'p10']);
  // no two AI shots in a row where another candidate allows it: the second of the programme is skipped for the third; when nothing else is left,
  // they stand together
  const middle = actsOf({ hook: ['v0#0'], arrival: ['v1#0'], programme: ['p0', 'p1', 'p2'], people: ['v2#0'], peak: ['v3#0'], close: ['v4#0'] });
  assert.deepEqual(refsOf(plan.spreadAiPhotos(candidatesOf(['p0', 'p1', 'p2']), middle, 2)), ['p0', 'p2']);
  assert.deepEqual(refsOf(plan.spreadAiPhotos(candidatesOf(['p0', 'p1']), middle, 2)), ['p0', 'p1']);
  // across the border of two acts as well: the arrival takes its second photo, not the one right after the clip of the hook
  const border = actsOf({ hook: ['v0#0', 'p0'], arrival: ['p1', 'v1#0', 'p2'], programme: ['v2#0'], people: ['v3#0'], peak: ['v4#0'], close: ['v5#0'] });
  assert.deepEqual(refsOf(plan.spreadAiPhotos(candidatesOf(['p0', 'p1', 'p2']), border, 2)), ['p0', 'p2']);
  // the order of the film, whatever the rank
  assert.deepEqual(refsOf(plan.spreadAiPhotos(candidatesOf(['p13', 'p5', 'p0']), live, 3)), ['p0', 'p5', 'p13']);
  // fewer candidates than clips: every one, and a note; as many as the picked photos: no note; no clips: nothing
  const few = plan.spreadAiPhotos(candidatesOf(['p5', 'p13']), live, 4);
  assert.deepEqual([refsOf(few), few.note], [['p5', 'p13'], 'AI clips: the answer has 2 candidates for 4 clips']);
  const two = actsOf({ hook: ['p0'], arrival: ['v0#0'], programme: ['p1'], people: ['v1#0'], peak: ['v2#0'], close: ['v3#0'] });
  assert.deepEqual(plan.spreadAiPhotos(candidatesOf(['p1', 'p0']), two, 17), { chosen: candidatesOf(['p0', 'p1']), note: null });
  assert.deepEqual(plan.spreadAiPhotos([], live, 0), { chosen: [], note: null });
  // a candidate that is not a picked photo (a detail, another ref) is no candidate
  const detail = actsOf({ hook: ['p0'], arrival: ['v0#0'], programme: ['p1'], people: ['v1#0'], peak: ['v2#0'], close: ['v3#0'] });
  detail.close.push({ unit: { ref: 'p0*', kind: 'photo', element: 'p0', detail: true }, pair: null });
  assert.deepEqual(refsOf(plan.spreadAiPhotos(candidatesOf(['p9', 'p1']), detail, 2)), ['p1']);
}

/* ---------- the case of the live test ---------- */

// 18 photos, one of them a duplicate (17 usable), 60 s; the answer ranks like the model of the live test: three photos of hook and arrival and one of
// the close first, then the middle
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

async function testLive() {
  const style = styles.combineStyle({ event_type: 'conference', mood: 'fresh', length: 60 });
  const model = scripted(liveAnswer);
  const result = await run({ ask: model.ask, style, videos: [], photos: livePhotos(), options: AI });
  passesContract(result, 'the live test');
  assert.equal(model.calls.length, 1, 'one request: the candidates left out are no problem');
  assert.match(model.calls[0].system, /The code animates 4 of the photos you pick with AI and spreads them over the acts\./);
  assert.match(model.calls[0].system, /the code takes the clips from your first 8, from all acts; the person may switch on any other one, so give each a prompt\. In "parallax" list up to 8 of the photos you pick with clear depth, the best first; any of them may be among your candidates: the code gives the parallax to the first 4 without an AI clip\./);
  const shots = result.shots.shots;
  const ai = shots.filter((shot) => shot.kind === 'photo_ai');
  assert.equal(ai.length, 4);
  assert.equal(result.aiPhotos.length, 4);
  assert.equal(result.aiPrompts.length, 4);
  // at most one AI clip in hook and arrival, the others after them, in three acts at least
  assert.ok(ai.filter((shot) => shot.act === 'hook' || shot.act === 'arrival').length <= 1, ai.map((shot) => shot.act).join(', '));
  assert.ok(ai.filter((shot) => ['programme', 'people', 'peak', 'close'].includes(shot.act)).length >= 3);
  assert.ok(new Set(ai.map((shot) => shot.act)).size >= 3);
  assert.deepEqual(ai.map((shot) => shot.act), ['hook', 'programme', 'people', 'peak']);
  // no two AI shots in a row
  shots.forEach((shot, index) => assert.ok(!(shot.kind === 'photo_ai' && shots[index + 1]?.kind === 'photo_ai'), shot.id));
  // the parallax for photos without an AI clip, as many as the length gives (4 for 60 s)
  const parallax = shots.filter((shot) => shot.kind === 'photo_parallax');
  assert.equal(parallax.length, 4);
  assert.equal(result.parallaxPhotos.length, 4);
  assert.ok(result.parallaxPhotos.every((index) => !result.aiPhotos.includes(index)), 'never an AI photo');
  assert.ok(parallax.some((shot) => shot.act === 'programme' || shot.act === 'people'), 'the middle moves in space');
  // the board: the four clips, the candidates left out as a note, the price of four clips and four depth maps
  assert.match(result.board, /\nNOTE {7}AI clips: 4 of 8 candidates, spread over the acts by their photos \(hook 1, programme 1, people 1, peak 1\); no AI clip for /);
  assert.match(result.board, /\nNOTE {7}parallax p0 was left out: it gets an AI clip/);
  assert.match(result.board, /\nESTIMATE {3}AI clips 4 0\.80 \+ depth maps 4 0\.04 /);
  assert.equal(result.cost.parts.ai, 4 * plan.CLIP_SECONDS * PRICES.clipPerSecond);
  assert.ok(!result.notes.some((note) => /^repaired:/.test(note)), 'nothing was repaired');
  // more clips: 8 of the candidates, spread the same way
  const eight = await run({ ask: scripted(liveAnswer).ask, style, videos: [], photos: livePhotos(), options: { ...AI, maxAiPhotos: 8 } });
  passesContract(eight, 'eight clips');
  assert.equal(eight.aiPhotos.length, 8);
  assert.equal(eight.parallaxPhotos.length, 4);
  // the parallax switched off: AI clips only
  const flat = await run({ ask: scripted(liveAnswer).ask, style, videos: [], photos: livePhotos(), options: { ...AI, parallax: false } });
  assert.deepEqual([flat.aiPhotos.length, flat.parallaxPhotos.length], [4, 0]);
  assert.match(flat.board, /parallax p\d+ was left out: the parallax is switched off/);
}

/* ---------- the list of the parallax ---------- */

// The model lists as parallax the candidates 5 to 8 first (what the prompt of before suggested: photos not among its first 4 candidates), then four
// photos that are no candidates. The spread gives three of the first four an AI clip (the share of programme, people and peak takes candidates of
// rank 5 to 7): the parallax goes to the first four without an AI clip, still four depth maps.
async function testDepthList() {
  const style = styles.combineStyle({ event_type: 'conference', mood: 'fresh', length: 60 });
  let listed = [];
  const answerFor = (request) => {
    const answer = liveAnswer(request);
    const acts = answer.acts;
    const of = (act) => acts.find((entry) => entry.act === act).picks.map((pick) => pick.ref);
    const ranked = answer.ai_photos.map((item) => item.ref);
    listed = [...ranked.slice(4, 8), of('programme')[0], of('people')[0], of('peak')[0], of('close')[1]];
    return { ...answer, parallax: listed };
  };
  const model = scripted(answerFor);
  const result = await run({ ask: model.ask, style, videos: [], photos: livePhotos(), options: AI });
  passesContract(result, 'the list of the parallax');
  assert.equal(model.calls.length, 1);
  assert.match(model.calls[0].system, /In "parallax" list up to 8 of the photos you pick with clear depth, the best first; any of them may be among your candidates: the code gives the parallax to the first 4 without an AI clip\./);
  const ai = new Set(result.aiPhotos.map((index) => `p${index}`));
  assert.equal(ai.size, 4);
  assert.equal(listed.slice(0, 4).filter((ref) => ai.has(ref)).length, 3, 'three of the candidates 5 to 8 get an AI clip');
  const expected = listed.filter((ref) => !ai.has(ref)).slice(0, 4);
  assert.deepEqual(result.parallaxPhotos.map((index) => `p${index}`), expected);
  assert.equal(result.shots.shots.filter((shot) => shot.kind === 'photo_parallax').length, 4);
  for (const ref of listed.slice(0, 4).filter((item) => ai.has(item))) assert.ok(result.notes.includes(`parallax ${ref} was left out: it gets an AI clip`), ref);
  const spare = listed.filter((ref) => !ai.has(ref)).slice(4);
  assert.deepEqual(spare.length, 1);
  assert.ok(result.notes.includes(`parallax ${spare[0]} was not needed: the first 4 without an AI clip have it`), result.notes.join(' | '));
  assert.ok(!result.notes.some((note) => /parallax .* at most/.test(note)), 'no limit note for the photos the prompt asked for');
  assert.match(result.board, /\nESTIMATE {3}AI clips 4 0\.80 \+ depth maps 4 0\.04 /);
  // the answer of before (the candidates 5 to 8 only) would have kept a single parallax clip
  const before = await run({ ask: scripted((request) => ({ ...liveAnswer(request), parallax: answerFor(request).parallax.slice(0, 4) })).ask, style, videos: [], photos: livePhotos(), options: AI });
  assert.equal(before.parallaxPhotos.length, 1);
}

/* ---------- all chosen photos ---------- */

async function testAll() {
  const style = styles.combineStyle({ event_type: 'party', mood: 'fast', length: 30 });
  const list = Array.from({ length: 9 }, (_, index) => photo(index, { upright: index % 3 === 0, faces: index % 2 ? 2 : 0, subject: `the ${SUBJECTS[index]}` }));
  let picked = [];
  const answerFor = (request) => {
    const acts = picksFor(request.system, Array.from({ length: 9 }, (_, index) => `p${index}`));
    picked = acts.flatMap((act) => act.picks.map((pick) => pick.ref));
    return { treatment: 't', acts, title: { text: 'Innovation Day 2026', sub: null, source: 'description' }, ai_photos: picked.map((ref) => ({ ref, prompt: 'gentle drift' })), parallax: ['p1', 'p2'], endcard: { line: 'Danke.', source: 'generic' } };
  };
  const model = scripted(answerFor);
  const result = await run({ ask: model.ask, style, videos: [], photos: list, musicSeconds: 32, options: { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS } });
  passesContract(result, 'every photo');
  assert.match(model.calls[0].system, /The code animates every photo you pick with AI\. In "ai_photos" give each of them, the best for an AI clip first .* Leave "parallax" empty\./);
  // every photo of the picks is an AI clip (a photo the code adds itself, or shows a second time as a detail, has no prompt: it moves by code)
  const shots = result.shots.shots;
  assert.ok(picked.length >= 7, picked.join(' '));
  assert.deepEqual(result.aiPhotos.slice().sort((a, b) => a - b), picked.map((ref) => Number(ref.slice(1))).sort((a, b) => a - b));
  assert.equal(shots.filter((shot) => shot.kind === 'photo_ai').length, picked.length);
  shots.forEach((shot, index) => assert.ok(shot.kind === 'photo_ai' || result.sources[index].detail || !picked.includes(`p${result.sources[index].index}`), shot.id));
  assert.deepEqual(result.parallaxPhotos, []);
  assert.match(result.board, /parallax p1 was left out: the photos are animated by AI/);
  assert.equal(result.cost.parts.ai, Math.round(result.aiPhotos.length * plan.CLIP_SECONDS * PRICES.clipPerSecond * 10000) / 10000);
  // the limits: as many clips as usable photos, the parallax only for the photos left
  const material = plan.readMaterial([], list);
  const grid = plan.planGrid({ analysis: beats, style, material, musicSeconds: 32, options: AI });
  assert.deepEqual(['ai', 'parallax'].map((key) => plan.answerLimits(grid, material, { ...AI, maxAiPhotos: contract.MAX_AI_PHOTOS })[key]), [9, 0]);
  assert.deepEqual(['ai', 'parallax'].map((key) => plan.answerLimits(grid, material, { ...AI, maxAiPhotos: 8 })[key]), [8, 1]);
  assert.deepEqual(['ai', 'parallax'].map((key) => plan.answerLimits(grid, material, AI)[key]), [2, 2]);
  assert.deepEqual(['ai', 'parallax'].map((key) => plan.answerLimits(grid, material, CODE)[key]), [0, 2]);
}

/* ---------- an AI clip without its shot ---------- */

function testNoShot() {
  const material = plan.readMaterial(material60.videos, material60.photos);
  const grid = plan.planGrid({ analysis: beats, style: styleFixture, material, musicSeconds: 62, options: AI });
  const ctx = { material, grid, style: styleFixture, options: AI, sources: plan.sourcesOf(material60.brief, material), brand: null, brief: material60.brief };
  const read = plan.readAnswer(JSON.stringify(answerOk), ctx);
  const content = read.content;
  // a clip in the list whose photo has no shot (as when an act is too short for all its shots): it is not made, the others are numbered again
  content.aiPhotos.unshift({ ref: 'p3', photo: 3, prompt: 'not shown' });
  content.parallax.push({ ref: 'p4', photo: 4 });
  content.acts.arrival = content.acts.arrival.filter((pick) => pick.unit.ref !== 'p3');
  content.acts.programme = content.acts.programme.filter((pick) => pick.unit.ref !== 'p4');
  const made = plan.toShots(content, ctx);
  assert.deepEqual(content.aiPhotos.map((item) => item.ref), ['p1', 'p2']);
  assert.deepEqual(content.parallax.map((item) => item.ref), ['p0', 'p5']);
  assert.deepEqual(made.shots.shots.filter((shot) => shot.kind === 'photo_ai').map((shot) => shot.clip), [0, 1]);
  assert.deepEqual(made.shots.shots.filter((shot) => shot.kind === 'photo_parallax').map((shot) => shot.clip), [0, 1]);
  assert.match(made.notes.join(' | '), /p3: no AI clip, its shot was left out/);
  assert.match(made.notes.join(' | '), /p4: no parallax clip, its shot was left out/);
  assert.ok(contract.checkShots(made.shots).ok, contract.checkShots(made.shots).problems.join(' | '));
}

/* ---------- the photos moved by code: as on main ---------- */

async function testCodeUnchanged() {
  // the prompts (system and user) and the plans (shots, graphics, board, the lists, the notes) of the photos moved by code, computed with the code of
  // main (3a4c45b) for the same material and answers. Plan digests include the recalibrated ESTIMATE row; prompt digests stay unchanged
  const prompts = {
    material60: ['9c67ed4e10cad7c9fcf357fc248b65ea9237f346aa71728a5642334bd7aedbb8', plan.readMaterial(material60.videos, material60.photos), styleFixture, CODE, 62],
    'material60 without parallax': ['899b10757f1dc87422ee754f261e4a9fccf06796780b26a98fc211b4d9f968c0', plan.readMaterial(material60.videos, material60.photos), styleFixture, { ...CODE, parallax: false, voiceover: true }, 62],
    'photos14 60 s': ['7765046e80a8f753296d07e288502b7115e048d06b4eda3700f253c80af59cae', plan.readMaterial([], photos(14)), styles.combineStyle({ event_type: 'conference', mood: 'fresh' }), CODE, 62],
    'photos14 90 s': ['b56f99713fbe5096b6706c702d25278189a5fa3a0054b7082c28ebae5b9ff3d5', plan.readMaterial([], photos(14)), styles.combineStyle({ event_type: 'celebration', mood: 'calm', length: 90 }), CODE, 92]
  };
  for (const [name, [digest, material, style, options, music]] of Object.entries(prompts)) {
    const grid = plan.planGrid({ analysis: beats, style, material, musicSeconds: music, options });
    assert.equal(sha(`${plan.systemPrompt({ style, grid, material, options })}\n----\n${plan.userPrompt({ brief: material60.brief, style, grid, material })}`), digest, `the prompt of ${name}`);
  }
  const digestOf = (result) => sha(JSON.stringify({ shots: result.shots, graphics: result.graphics, board: result.board, ai: result.aiPhotos, prompts: result.aiPrompts, parallax: result.parallaxPhotos, notes: result.notes }));
  assert.equal(digestOf(await run({ options: CODE, ask: scripted(answerOk).ask })), 'd2c8376fd68f698ccc2491c67ce8d6df58e675c26b737c40c75409985efba4cf', 'the plan of the fixtures');
  assert.equal(digestOf(await run({ options: { ...CODE, parallax: false }, ask: scripted(answerOk).ask })), '090d1e6f2cfc76bf19d9b01a87df033be9d43b00557a38724c1962fe60e74c37', 'without parallax');
  const answerFor = (request) => ({
    treatment: 'Ein Nachmittag.',
    acts: picksFor(request.system, Array.from({ length: 14 }, (_, index) => `p${index}`)),
    title: { text: 'Innovation Day 2026', sub: null, source: 'description' },
    ai_photos: [{ ref: 'p3', prompt: 'push in' }],
    parallax: ['p1', 'p2', 'p4', 'p5', 'p7'],
    endcard: { line: 'Danke.', source: 'generic' }
  });
  const films = {
    'conference 60': ['e6f572e1bcf9be30353741b39f60a328fcebde0b6dccf18f6d8b97c9a085b7e8', 'conference', 'fresh', 60],
    'party 30': ['f3198c39a681a8162554b54648e31064c2117d99f9912ced98f3b05e922b5f55', 'party', 'fast', 30],
    'celebration 90': ['5be6947f3cf4e0aaabeecdda36c3103346a45f738f127a0822a3cbc66ed363f0', 'celebration', 'calm', 90]
  };
  for (const [name, [digest, eventType, mood, length]] of Object.entries(films)) {
    const style = styles.combineStyle({ event_type: eventType, mood, length });
    const result = await run({ style, videos: [], photos: photos(14), musicSeconds: length + 2, options: CODE, ask: scripted(answerFor).ask });
    assert.equal(digestOf(result), digest, `14 photos, ${name}`);
  }
}

/* ---------- the field "AI clips" ---------- */

function testField() {
  const registry = require('../lib/nodes/registry');
  const nodes = require('../lib/nodes/nodes-event-video');
  const own = registry.createRegistry();
  nodes.registerAll(own);
  const def = own.get('event_video.plan');
  const ids = def.params.map((param) => param.id);
  assert.equal(ids.indexOf('max_ai_photos'), ids.indexOf('photo_motion') + 1, 'right after the motion of the photos');
  const param = def.params.find((item) => item.id === 'max_ai_photos');
  assert.deepEqual([param.kind, param.min, param.max, param.default, param.options, param.showIf], ['integer', 0, 50, 0, [0, 2, 4, 6, 8, 12, 16, 50], { param: 'photo_motion', equals: 'ai' }]);
  assert.equal(contract.MAX_AI_PHOTOS, contract.LIMITS.listItems, 'all: every photo of a list');
  // the value stays a number: a saved 0 is the 0 of before, another whole number is still valid, too much is the most
  assert.equal(registry.normalizeParams(def, {}).max_ai_photos, 0);
  assert.equal(registry.normalizeParams(def, { max_ai_photos: '12' }).max_ai_photos, 12);
  assert.equal(registry.normalizeParams(def, { max_ai_photos: 3 }).max_ai_photos, 3);
  assert.equal(registry.normalizeParams(def, { max_ai_photos: 99 }).max_ai_photos, 50);
  assert.deepEqual(registry.checkParams(def, registry.normalizeParams(def, { max_ai_photos: 3 })), []);
  assert.equal(nodes.optionsOf(registry.normalizeParams(def, { photo_motion: 'ai', max_ai_photos: 16 })).maxAiPhotos, 16);
  // the registry checks the list of an integer
  const strict = registry.createRegistry();
  const define = (options) => strict.register({ type: `test.list${strict.list().length}`, category: 'utility', label: 'x', execute: async () => ({}), params: [{ id: 'n', kind: 'integer', min: 0, max: 10, default: 0, options }] });
  assert.throws(() => define(['a']), /param n has bad options/);
  assert.throws(() => define([0, 11]), /param n has bad options/);
  assert.throws(() => define([]), /param n has bad options/);
  assert.doesNotThrow(() => define([0, 5, 10]));
  // the run service names the values of the field of the app
  const templates = require('../lib/nodes/templates');
  const runService = require('../lib/nodes/run-service');
  const doc = templates.resolveTemplate('event-video', { lang: 'de' });
  const field = runService.inputDescriptors(doc.graph, doc.app, registry).find((entry) => entry.id === 'n10.max_ai_photos');
  assert.deepEqual([field.type, field.integer, field.min, field.max, field.options, field.label], ['number', true, 0, 50, [0, 2, 4, 6, 8, 12, 16, 50], 'KI-Clips']);
  // the page: a list with words for the first and the last value, numbers to the node, an old value stays visible
  const { loadPage } = require('./support/fake-dom');
  for (const [lang, first, last] of [['de', 'Nach Länge (2, 4 oder 6)', 'Alle gewählten Fotos'], ['en', 'By length (2, 4 or 6)', 'All chosen photos'], ['es', 'Según la duración (2, 4 o 6)', 'Todas las fotos elegidas']]) {
    const ui = loadPage(lang, { scripts: ['node-ui'] }).OCD.ui;
    const changes = [];
    const widget = ui.paramWidget(param, 0, { node: { id: 'n10', type: 'event_video.plan', params: {} }, onChange: (value, meta) => changes.push([value, meta.commit]) });
    assert.equal(widget.el.tagName, 'SELECT');
    assert.deepEqual(widget.el.children.map((option) => option.textContent), [first, '2', '4', '6', '8', '12', '16', last]);
    assert.deepEqual(widget.el.children.map((option) => option.attributes.value), ['0', '2', '4', '6', '8', '12', '16', '50']);
    widget.el.value = '12';
    widget.el.fire('change');
    assert.deepEqual(changes, [[12, true]], `${lang}: a number`);
    assert.equal(widget.get(), 12);
    const old = ui.paramWidget(param, 3, { node: { id: 'n10', type: 'event_video.plan', params: {} }, onChange() {} });
    assert.deepEqual(old.el.children.map((option) => option.attributes.value), ['0', '2', '4', '6', '8', '12', '16', '50', '3']);
  }
}

async function main() {
  for (const test of [testSpread, testLive, testDepthList, testAll, testNoShot, testCodeUnchanged, testField]) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log('test-event-video-ai-clips.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
