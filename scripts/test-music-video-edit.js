'use strict';

// Cutting a music video (lib/music-video-edit.js and lib/music-video-render.js, WP34): the filter graph is checked as text, and then
// run with real ffmpeg on small clips made with lavfi. What is covered: the number of frames of every scene (boundaries rounded once,
// so no drift), the total length (within one frame), the cuts at the scene boundaries (a colour per clip tells which clip is on screen
// at a time), clips that are too short (slowed down to 0.8 at most, then the last frame held; the singer's clip only held), clips of
// another size and frame rate, the three transitions, fit crop and pad, the song underneath with its fade-out, and the errors.
// A film of more than BATCH_SCENES scenes is cut in batches (a few scenes per process, one encoder): the plan as text, the film
// against the one a single process makes (the same frames, also at the batch boundaries under a crossfade), the number of clips any
// process holds, 50 scenes, and an abort, a failing batch, a failing encoder, a time-out and a wrong frame count (no process is left).
// The part that needs ffmpeg is skipped when it is missing.
// WP44: a film without scenes of the kind "still" is cut as it always was. A fingerprint of the plans and the ffmpeg arguments of many films
// (every transition, one process and batches, 1 to 50 scenes, sizes, frame rates, fits, captions, scenes that cut hard), made with the code as
// it was before the kind "still" came in, holds that byte for byte; the scenes of the kind "still" are covered after it.

const assert = require('assert/strict');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const edit = require('../lib/music-video-edit');
const renderer = require('../lib/music-video-render');
const ops = require('../lib/nodes/ffmpeg-ops');
const ffmpeg = require('../lib/ffmpeg');

const execFileAsync = promisify(execFile);

/* ---------- the pieces that need no ffmpeg ---------- */

function testPieces() {
  assert.deepEqual(edit.outputSize('16:9', '720p'), [1280, 720]);
  assert.deepEqual(edit.outputSize('16:9', '1080p'), [1920, 1080]);
  assert.deepEqual(edit.outputSize('9:16', '720p'), [720, 1280]);
  assert.deepEqual(edit.outputSize('9:16', '1080p'), [1080, 1920]);
  assert.deepEqual(edit.outputSize('1:1', '720p'), [720, 720]);
  assert.deepEqual(edit.outputSize('whatever', 'whatever'), [1280, 720]);
  // frame boundaries: rounded once from the times, never added up
  const shots = Array.from({ length: 50 }, (_unused, index) => ({ start: (index * 120) / 50, end: ((index + 1) * 120) / 50 }));
  const bounds = edit.frameBounds(shots, 25);
  assert.equal(bounds.length, 51);
  assert.equal(bounds[0], 0);
  assert.equal(bounds[50], 3000, 'fifty scenes of 2.4 s are exactly 120 s');
  bounds.forEach((bound, index) => {
    if (index) assert.ok(bound > bounds[index - 1]);
  });
  // a scene shorter than a frame still has one
  const tiny = edit.frameBounds([{ start: 0, end: 0.001 }, { start: 0.001, end: 0.002 }], 25);
  assert.deepEqual(tiny, [0, 1, 2]);
  // the chain of a scene: the exact count of frames at the end, the sizes, the speed
  const story = edit.sceneChain({ kind: 'story', seconds: 2, frames: 100, fps: 25, width: 1280, height: 720, fit: 'crop', flash: false });
  assert.equal(story.speed, 0.8, 'a clip of 2 s for 4 s is slowed to 0.8 at most');
  assert.match(story.chain, /setpts=1\.25\*PTS/);
  assert.match(story.chain, /tpad=stop=100:stop_mode=clone,trim=end_frame=100/);
  assert.match(story.chain, /scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720,setsar=1,format=yuv420p$/);
  const nearly = edit.sceneChain({ kind: 'story', seconds: 3.8, frames: 100, fps: 25, width: 1280, height: 720, fit: 'crop', flash: false });
  assert.ok(Math.abs(nearly.speed - 0.95) < 1e-9);
  const enough = edit.sceneChain({ kind: 'story', seconds: 5, frames: 100, fps: 25, width: 1280, height: 720, fit: 'crop', flash: false });
  assert.equal(enough.speed, 1);
  assert.doesNotMatch(enough.chain, /setpts=1/);
  const singer = edit.sceneChain({ kind: 'performance', seconds: 2, frames: 100, fps: 25, width: 1280, height: 720, fit: 'crop', flash: false });
  assert.equal(singer.speed, 1, 'the singer is never slowed down');
  assert.doesNotMatch(singer.chain, /setpts=1\./);
  assert.match(singer.chain, /tpad=stop=100/);
  const unknown = edit.sceneChain({ kind: 'story', seconds: null, frames: 100, fps: 25, width: 1280, height: 720, fit: 'pad', flash: true });
  assert.equal(unknown.speed, 1);
  assert.match(unknown.chain, /force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/);
  assert.match(unknown.chain, /fade=t=in:st=0:d=0.15:color=white$/);
  // the spec
  const scenes = {
    aspect_ratio: '16:9',
    shots: [
      { start: 0, end: 4.2, kind: 'story', clip: 0 },
      { start: 4.2, end: 10.7, kind: 'performance', clip: 0 },
      { start: 10.7, end: 14, kind: 'story', clip: 1 }
    ]
  };
  const infos = [{ audio: {}, video: null, duration: 14 }, { video: {}, duration: 5 }, { video: {}, duration: 6.5 }, { video: {}, duration: 3 }];
  const build = (params) => edit.buildEditSpec({ shots: scenes, order: [1, 2, 3], infos, params: { resolution: '720p', fps: 25, fit: 'crop', fade_out: 1, ...params } });
  const cut = build({ transition: 'cut' });
  assert.equal(cut.frames, 350);
  assert.equal(cut.seconds, 14);
  assert.deepEqual(cut.summary.map((item) => item.frames), [105, 163, 82]);
  assert.match(cut.graph, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[vx\]/);
  assert.match(cut.graph, /\[vx\]fade=t=out:st=13:d=1\[v\]/);
  assert.match(cut.graph, /\[0:a\]atrim=start=0:end=14,asetpts=PTS-STARTPTS,apad=whole_dur=14,afade=t=out:st=13:d=1\[a\]/);
  assert.deepEqual(cut.outputs[0].maps, ['[v]', '[a]']);
  assert.deepEqual(cut.inputOpts, [['-threads', '1'], ['-threads', '1'], ['-threads', '1'], ['-threads', '1']], 'one decoder thread per input');
  assert.ok(cut.outputs[0].args.includes('-t') && cut.outputs[0].args.includes('14'));
  assert.doesNotMatch(cut.graph, /xfade|fade=t=in/);
  const cross = build({ transition: 'crossfade' });
  assert.equal(cross.frames, 350, 'a crossfade does not make the film longer');
  assert.match(cross.graph, /xfade=transition=fade:duration=0\.24:offset=4\.2\[x1\]/);
  assert.match(cross.graph, /\[x1\]\[v2\]xfade=transition=fade:duration=0\.24:offset=10\.72\[vx\]/);
  assert.doesNotMatch(cross.graph, /concat/);
  const flash = build({ transition: 'flash' });
  assert.equal((flash.graph.match(/color=white/g) || []).length, 2, 'every scene but the first comes in from white');
  assert.doesNotMatch(flash.graph.split(';')[0], /color=white/);
  // no fade-out
  const plain = build({ fade_out: 0 });
  assert.doesNotMatch(plain.graph, /fade=t=out|afade/);
  assert.match(plain.graph, /\[vx\]null\[v\]/);
  // the fade-out is at most half the film
  assert.match(build({ fade_out: 100 }).graph, /afade=t=out:st=7:d=7/);
  // one scene: no joining
  const one = edit.buildEditSpec({ shots: { aspect_ratio: '1:1', shots: [scenes.shots[0]] }, order: [1], infos: infos.slice(0, 2), params: { transition: 'crossfade', resolution: '1080p', fps: 30, fit: 'pad', fade_out: 0 } });
  assert.match(one.graph, /\[v0\]null\[v\]/);
  assert.equal(one.width, 1080);
  assert.equal(one.height, 1080);
  assert.equal(one.frames, 126);
  // unknown values fall back
  const odd = build({ transition: 'nonsense', fps: 99, fit: 'nonsense' });
  assert.equal(odd.fps, 25);
  assert.match(odd.graph, /concat=n=3/);
  // the errors
  assert.throws(() => edit.buildEditSpec({ shots: { shots: [] }, order: [], infos, params: {} }), /no scenes/);
  assert.throws(() => edit.buildEditSpec({ shots: scenes, order: [1, 2], infos, params: {} }), /needs a clip/);
  assert.throws(() => edit.buildEditSpec({ shots: scenes, order: [1, 2, 3], infos: [infos[0], { video: null, duration: 5 }, infos[2], infos[3]], params: {} }), /clip of scene 1 has no video/);
  assert.throws(() => edit.buildEditSpec({ shots: scenes, order: [1, 2, 3], infos: [{ video: null, audio: null }, ...infos.slice(1)], params: {} }), /song has no audio/);
  testPlan(edit);
  // a slice of the song
  const slice = edit.sliceAudioArgs('/in.mp3', 12.3456, 5.5, '/out.wav');
  assert.deepEqual(slice.slice(slice.indexOf('-af'), slice.indexOf('-af') + 2), ['-af', 'atrim=start=12.3456:duration=5.5,asetpts=PTS-STARTPTS']);
  assert.ok(slice.includes('pcm_s16le') && slice[slice.length - 1] === '/out.wav');
}

/* ---------- a film without stills is cut as it always was ---------- */

const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// What the cut makes of a film: the plan (graphs, input options, outputs, summary) and the arguments that ffmpeg gets, for a set of films.
function editFingerprints() {
  const out = {};
  const argsOf = (plan, film) => {
    const files = ['/song.wav', ...film.order.map((index) => `/clip-${index}.mp4`)];
    if (plan.mode === 'single') return ops.assembleArgs(plan.spec, files, ['/out.mp4']);
    return { batches: plan.batches.map((batch) => edit.batchArgs(batch, files)), encoder: ops.assembleArgs(plan.final, ['pipe:0', '/song.wav'], ['/out.mp4']) };
  };
  const add = (name, film, extra = {}) => {
    const plan = edit.buildEditPlan({ ...film, ...extra });
    out[name] = sha({ plan, args: argsOf(plan, film), geometry: edit.geometry({ shots: film.shots, params: extra.params }) });
  };
  for (const transition of ['cut', 'crossfade', 'flash']) {
    for (const n of [1, 2, 3, 4, 9, 10]) add(`${transition} ${n} scenes`, filmOf(n), { params: { ...PARAMS, transition } });
    add(`${transition} 50 scenes`, filmOf(50, { seconds: 2.4 }), { params: { ...PARAMS, transition } });
  }
  add('vertical 1080p 24 fps padded, no fade', filmOf(9, { aspect: '9:16' }), { params: { ...PARAMS, transition: 'crossfade', resolution: '1080p', fps: 24, fit: 'pad', fade_out: 0 } });
  add('square 30 fps', filmOf(5, { aspect: '1:1' }), { params: { ...PARAMS, transition: 'flash', fps: 30 } });
  add('captions, one process', filmOf(3), { params: PARAMS, captionsFile: '/s/captions.ass' });
  add('captions, batches', filmOf(7), { params: { ...PARAMS, transition: 'crossfade' }, captionsFile: '/s/captions.ass' });
  for (const batchScenes of [1, 2, 5]) add(`crossfade batches of ${batchScenes}`, filmOf(10), { params: { ...PARAMS, transition: 'crossfade' }, batchScenes });
  // scenes that name their own fit or cut hard (the explainer video does)
  const hard = filmOf(6);
  hard.shots.shots[1] = { ...hard.shots.shots[1], hardCut: true };
  hard.shots.shots[2] = { ...hard.shots.shots[2], fit: 'pad' };
  add('hard cut and own fit', hard, { params: { ...PARAMS, transition: 'crossfade' } });
  // a scene of one frame, clips of unknown length
  const odd = filmOf(6);
  odd.shots.shots[2] = { ...odd.shots.shots[2], start: 6, end: 6.001 };
  odd.infos[3] = { video: {}, duration: null };
  add('a scene of one frame, a clip of unknown length', odd, { params: { ...PARAMS, transition: 'crossfade' } });
  out.slice = sha(edit.sliceAudioArgs('/in.mp3', 12.3456, 5.5, '/out.wav'));
  return out;
}

// The fingerprints of the code before the kind "still" (PRINT_GOLDEN=1 node scripts/test-music-video-edit.js prints them again; only a change
// that is meant to move the cut of a film without stills may replace them).
const EDIT_GOLDEN = {
  'cut 1 scenes': 'c4405c1ef6ee710f48642b072ae90aebdecddbecb0f257e212783cec96e8cc8b',
  'cut 2 scenes': 'a1692488c991a60d3da24e0eec1a4826487973a0cbf12af0c5681e807a3aef65',
  'cut 3 scenes': '314014275da1b337a3f115961fee360ce3eb360a476ad0a3d161cc5f78dde8ca',
  'cut 4 scenes': 'f634c1094a531d5eeb94e10336b66a3b4b32d291dcc753366824d9714de2cd98',
  'cut 9 scenes': 'c5fd880c3f345cc60d6eff34aa93d6237d4965f74b4e283dffe2de4b4bba0dfd',
  'cut 10 scenes': 'fe3734620a72869c21a65569301e76173bc0b2fa7bff4af437c0b655f1ba7209',
  'cut 50 scenes': '19c387ce11df4d2118bdb198578bcaf718a5d239c874f88693ac3132375e53f8',
  'crossfade 1 scenes': 'c4405c1ef6ee710f48642b072ae90aebdecddbecb0f257e212783cec96e8cc8b',
  'crossfade 2 scenes': '2f943ff367893054addc0dd698c16b1a2c947bb311b5d3d57518a0485ebc500d',
  'crossfade 3 scenes': '1ea429487f714aac01171e3016d7667cd34b7ab9313b3786d3f6b8f68e6d1821',
  'crossfade 4 scenes': '8ab39d0ba6728a59df3761b8bf273f696adb31f0b0f91167aa7beafd91080dec',
  'crossfade 9 scenes': '40e9158f88c2f60e97e796a0b3e8aadd6fa2c6917563722f659d1f10c6ba16bc',
  'crossfade 10 scenes': '05ad3805087196030036be70defe753e88b6dc1dd3dc6b29a5f9927079fe0d4c',
  'crossfade 50 scenes': '944af26176e92250bce5761135cd3527080783fb3dc08d85dd7f7fbcaad7a870',
  'flash 1 scenes': 'c4405c1ef6ee710f48642b072ae90aebdecddbecb0f257e212783cec96e8cc8b',
  'flash 2 scenes': '283ffd9b302ea0540fe95c8ef9b15bc85c73df61933bdbb7562f7a4a9993deec',
  'flash 3 scenes': '33a62bdedb4e48a9960a65f51524f0065f5d8d78d517f585f3eb77d770d1c4fb',
  'flash 4 scenes': '270aa8b45a58d4a5d87ecc3c857e6a1eb9f8b5bf20c0adf0686a867966406750',
  'flash 9 scenes': '73d39bcb1fb9efb90b5172ee524f60b8e86ecd3bde60ff25d0cbb6d525179b30',
  'flash 10 scenes': '65233603bbb6c5de4c32016e2fbeac7081755dcce76adae3f747a3a6cc7c9d2e',
  'flash 50 scenes': '146dc5adef34dd0786f17aabf5ca405a018dc8c3940d0a0909e79ea344c590ee',
  'vertical 1080p 24 fps padded, no fade': '7566eba44ab9b9c4a506f1773003d3bbd1dccebe3ca7ebb866ffd83e475266bf',
  'square 30 fps': '7fc66e586f6e4afcbd9cc0b124fe7c04d87faf22f12f3aa9ceae208529bfd03c',
  'captions, one process': 'd3bd35a1cfbc87eb6f6609c2c3945725e6d8d58a77757c047f57bbb4303e0ca3',
  'captions, batches': '687b3390eaa16a7b36438b3a1ea43b3d8aa90b85a676b8b0a3c93c4986105143',
  'crossfade batches of 1': 'c0b98d24043d437c74c08c6ac9f65131d0bb9dbfab47cb45399a40c5cce6551b',
  'crossfade batches of 2': 'c0b98d24043d437c74c08c6ac9f65131d0bb9dbfab47cb45399a40c5cce6551b',
  'crossfade batches of 5': 'cf5ff2f248185f508f926e0873100bd88421de8d3e0c0805f0a4924a1e950705',
  'hard cut and own fit': '2cefa7e82e4690d7cf2c290c367f91a6f70aed41ea6de555413a81da1717d9e2',
  'a scene of one frame, a clip of unknown length': '527d151920313d37a0efd459fd87ced7d5ba14df686cd533d70a0f3cecc3bb39',
  'slice': 'a67f01871b8aacdee2a15f059c68035987b52cee61ad45cf3d9f0c155d7203dd'
};

function testEditUnchanged() {
  const found = editFingerprints();
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(found, null, 2));
  assert.deepEqual(Object.keys(found).sort(), Object.keys(EDIT_GOLDEN).sort(), 'the same films are fingerprinted');
  for (const name of Object.keys(EDIT_GOLDEN)) assert.equal(found[name], EDIT_GOLDEN[name], `the cut of "${name}" changed`);
}

/* ---------- scenes of the kind "still" (WP44) ---------- */

// A still is a picture that image.to_video moves (zoom or parallax): its clip is cut like a story clip. Every clip is found by the place the
// node gives it (`order`), so a film with all three kinds takes each clip for its own scene.
function testStills() {
  const base = { seconds: 2, frames: 100, fps: 25, width: 1280, height: 720, fit: 'crop', flash: false };
  const story = edit.sceneChain({ kind: 'story', ...base });
  const still = edit.sceneChain({ kind: 'still', ...base });
  assert.deepEqual(still, story, 'a still clip is cut like a story clip');
  assert.equal(still.speed, 0.8, 'slowed down to 0.8 at most');
  assert.match(still.chain, /setpts=1\.25\*PTS/);
  assert.match(still.chain, /tpad=stop=100:stop_mode=clone,trim=end_frame=100/, 'then the last frame is held');
  assert.equal(edit.sceneChain({ kind: 'still', ...base, seconds: 5 }).speed, 1, 'a clip that is long enough is not slowed down');
  assert.equal(edit.sceneChain({ kind: 'still', ...base, seconds: null }).speed, 1, 'a clip of unknown length neither');
  assert.equal(edit.sceneChain({ kind: 'performance', ...base }).speed, 1, 'the singer still is not');
  assert.equal(edit.sceneChain({ kind: 'other', ...base }).speed, 1, 'a kind that is not known is not slowed down either');

  // five scenes of three kinds; the clips come in this order: song, the story clips (2), the singer (1), the stills (2) - as the node lists them
  const scenes = {
    aspect_ratio: '16:9',
    shots: [
      { start: 0, end: 3, kind: 'story', clip: 0 },
      { start: 3, end: 6, kind: 'still', clip: 0 },
      { start: 6, end: 9, kind: 'performance', clip: 0 },
      { start: 9, end: 12, kind: 'still', clip: 1 },
      { start: 12, end: 15, kind: 'story', clip: 1 }
    ]
  };
  const infos = [{ audio: {}, video: null, duration: 15 }, { video: {}, duration: 5 }, { video: {}, duration: 5 }, { video: {}, duration: 2 }, { video: {}, duration: 2.4 }, { video: {}, duration: 5 }];
  const order = [1, 4, 3, 5, 2];
  const spec = edit.buildEditSpec({ shots: scenes, order, infos, params: { ...PARAMS } });
  assert.deepEqual(spec.summary.map((item) => item.kind), ['story', 'still', 'performance', 'still', 'story']);
  assert.deepEqual(spec.summary.map((item) => item.fromClip), [5, 2.4, 2, 5, 5], 'every scene reads the clip that `order` names');
  assert.deepEqual(spec.summary.map((item) => item.speed), [1, 0.8, 1, 1, 1], 'only the still with the short clip is slowed down: the singer is held, not slowed');
  assert.deepEqual(spec.summary.map((item) => item.frames), [75, 75, 75, 75, 75]);
  order.forEach((file, index) => assert.ok(spec.graph.includes(`[${file}:v]`), `scene ${index} opens clip ${file}`));
  assert.equal(spec.frames, 375);
  // a plan of batches carries the same
  const batched = edit.buildEditPlan({ shots: scenes, order, infos, params: { ...PARAMS }, batchScenes: 2 });
  assert.equal(batched.mode, 'batched');
  assert.deepEqual(batched.batches.map((batch) => batch.inputs), [[1, 4], [3, 5], [2]]);
  assert.deepEqual(batched.summary, spec.summary);
  // the clip of a still is not special for a crossfade: the same plan as for a story clip in its place
  const asStory = { ...scenes, shots: scenes.shots.map((shot) => (shot.kind === 'still' ? { ...shot, kind: 'story' } : shot)) };
  for (const transition of ['cut', 'crossfade', 'flash']) {
    assert.equal(
      edit.buildEditSpec({ shots: scenes, order, infos, params: { ...PARAMS, transition } }).graph,
      edit.buildEditSpec({ shots: asStory, order, infos, params: { ...PARAMS, transition } }).graph,
      `${transition}: a still is cut like a story scene`
    );
  }
}

/* ---------- the plan: one process, or batches ---------- */

// n scenes of `seconds` each; every fifth is a scene of the singer. Clip files are 1.. in order (the song is input 0).
function filmOf(n, { seconds = 3, aspect = '16:9' } = {}) {
  let story = 0;
  let singer = 0;
  const shots = Array.from({ length: n }, (_unused, index) => {
    const kind = index % 5 === 3 ? 'performance' : 'story';
    return { start: index * seconds, end: (index + 1) * seconds, kind, clip: kind === 'story' ? story++ : singer++ };
  });
  const infos = [{ audio: {}, video: null, duration: n * seconds }, ...shots.map((_shot, index) => ({ video: {}, duration: 2 + (index % 4) }))];
  return { shots: { aspect_ratio: aspect, shots }, order: shots.map((_shot, index) => index + 1), infos };
}
const PARAMS = { transition: 'cut', resolution: '720p', fps: 25, fit: 'crop', fade_out: 1 };

function testPlan(edit) {
  assert.equal(edit.BATCH_SCENES, 3);

  // up to BATCH_SCENES scenes: one process, the spec that buildEditSpec makes
  for (const n of [1, 2, 3]) {
    const film = filmOf(n);
    const plan = edit.buildEditPlan({ ...film, params: PARAMS });
    assert.equal(plan.mode, 'single', `${n} scenes`);
    assert.deepEqual(plan.spec, edit.buildEditSpec({ ...film, params: PARAMS }));
    assert.deepEqual(plan.outputs, plan.spec.outputs);
    assert.equal(plan.frames, plan.spec.frames);
    assert.equal(plan.batches, undefined);
  }

  // more: batches of three, the last one smaller, one encoder after them
  const film = filmOf(10);
  const single = edit.buildEditSpec({ ...film, params: PARAMS });
  const plan = edit.buildEditPlan({ ...film, params: PARAMS });
  assert.equal(plan.mode, 'batched');
  assert.deepEqual(plan.batches.map((batch) => [batch.from, batch.to]), [[0, 3], [3, 6], [6, 9], [9, 10]]);
  assert.deepEqual(plan.batches.map((batch) => batch.frames), [225, 225, 225, 75], 'a batch has the frames of its scenes');
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.frames, 0), plan.frames, 'together exactly the film');
  assert.equal(plan.frames, 750);
  assert.equal(plan.seconds, 30);
  assert.deepEqual(plan.summary, single.summary, 'what is done per scene does not depend on the way it is cut');
  assert.deepEqual([plan.fps, plan.width, plan.height], [single.fps, single.width, single.height]);
  assert.equal(plan.frameBytes, 1280 * 720 * 1.5);
  plan.batches.forEach((batch) => {
    assert.deepEqual(batch.inputs, film.order.slice(batch.from, batch.to), 'a batch opens the clips of its scenes and nothing else');
    assert.deepEqual(batch.inputOpts, batch.inputs.map(() => ['-threads', '1']));
    assert.equal(batch.map, '[vb]');
    assert.ok(batch.graph.endsWith(`trim=end_frame=${batch.frames},setpts=PTS-STARTPTS[vb]`), 'exactly its frames at the end');
    assert.doesNotMatch(batch.graph, /xfade|fade=t=out|atrim/);
  });
  assert.match(plan.batches[0].graph, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[vj\];\[vj\]trim=end_frame=225/);
  assert.match(plan.batches[2].graph, /\[v6\]\[v7\]\[v8\]concat=n=3:v=1:a=0\[vj\]/);
  assert.match(plan.batches[3].graph, /^\[0:v\].*\[v9\];\[v9\]trim=end_frame=75,setpts=PTS-STARTPTS\[vb\]$/, 'a batch of one scene has nothing to join');
  // every scene has the chain a single process gives it
  film.order.forEach((file, index) => {
    const chain = new RegExp(`\\[${file}:v\\](.*?)\\[v${index}\\]`).exec(single.graph)[1];
    const batch = plan.batches.find((candidate) => index >= candidate.from && index < candidate.to);
    assert.ok(batch.graph.includes(`[${index - batch.from}:v]${chain}[v${index}]`), `scene ${index}`);
  });
  // the encoder: the raw frames come in, the fade-out and the song as in a single process, the same encoding
  assert.deepEqual(plan.final.outputs, single.outputs, 'encoded as a single process encodes');
  assert.deepEqual(plan.outputs, single.outputs);
  assert.deepEqual(plan.final.inputOpts, [['-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '1280x720', '-framerate', '25'], []]);
  assert.equal(plan.final.graph, '[0:v]fade=t=out:st=29:d=1[v];[1:a]atrim=start=0:end=30,asetpts=PTS-STARTPTS,apad=whole_dur=30,afade=t=out:st=29:d=1[a]');
  assert.deepEqual(single.graph.split(';').slice(-2), plan.final.graph.replace('[0:v]', '[vx]').replace('[1:a]', '[0:a]').split(';'), 'the same end as the graph of a single process');
  const encoderArgs = ops.assembleArgs(plan.final, ['pipe:0', '/song.mp3'], ['/out.mp4']);
  assert.deepEqual(encoderArgs.slice(0, 4), ['-nostdin', '-v', 'error', '-y']);
  assert.deepEqual(encoderArgs.slice(4, 13), ['-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '1280x720', '-framerate', '25', '-i']);
  assert.equal(encoderArgs[13], 'pipe:0');
  assert.deepEqual(encoderArgs.slice(14, 16), ['-i', '/song.mp3']);
  assert.equal(encoderArgs.at(-1), '/out.mp4');

  // the arguments of a batch
  const files = ['/song.wav', ...film.order.map((index) => `/clip-${index}.mp4`)];
  const args = edit.batchArgs(plan.batches[1], files);
  assert.deepEqual(args.slice(0, 4), ['-nostdin', '-v', 'error', '-y']);
  assert.deepEqual(args.slice(4, 16), ['-threads', '1', '-i', '/clip-4.mp4', '-threads', '1', '-i', '/clip-5.mp4', '-threads', '1', '-i', '/clip-6.mp4']);
  assert.ok(args.includes('-filter_complex') && args[args.indexOf('-filter_complex') + 1] === plan.batches[1].graph);
  assert.deepEqual(args.slice(args.indexOf('-map')), ['-map', '[vb]', '-an', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']);

  // the size of a batch is a parameter; nonsense falls back to the default
  assert.deepEqual(edit.buildEditPlan({ ...film, params: PARAMS, batchScenes: 2 }).batches.map((batch) => batch.to - batch.from), [2, 2, 2, 2, 2]);
  assert.deepEqual(edit.buildEditPlan({ ...film, params: PARAMS, batchScenes: 9 }).batches.map((batch) => batch.to - batch.from), [9, 1]);
  assert.equal(edit.buildEditPlan({ ...film, params: PARAMS, batchScenes: 10 }).mode, 'single');
  for (const nonsense of [0, -1, 2.5, 'x', null, NaN]) {
    assert.deepEqual(edit.buildEditPlan({ ...film, params: PARAMS, batchScenes: nonsense }).batches.map((batch) => batch.to - batch.from), [3, 3, 3, 1], String(nonsense));
  }

  // a film of fifty scenes: no process opens more than BATCH_SCENES clips, whatever the transition (a crossfade also opens the clip
  // before the batch, so its batches hold one scene less)
  const fifty = filmOf(50, { seconds: 2.4 });
  for (const transition of ['cut', 'crossfade', 'flash']) {
    const big = edit.buildEditPlan({ ...fifty, params: { ...PARAMS, transition } });
    assert.equal(big.batches.length, transition === 'crossfade' ? 25 : 17, transition);
    assert.equal(big.frames, 3000);
    assert.equal(big.batches.reduce((sum, batch) => sum + batch.frames, 0), 3000);
    const most = Math.max(...big.batches.map((batch) => batch.inputs.length));
    assert.equal(most, edit.BATCH_SCENES, `${transition}: the clips one process opens`);
  }

  // crossfade: the scene before a batch runs on under the fade-in of its first scene (a second decoder of that clip); with that clip
  // the batch opens BATCH_SCENES clips, so it holds two scenes
  const cross = edit.buildEditPlan({ ...film, params: { ...PARAMS, transition: 'crossfade' } });
  const crossSingle = edit.buildEditSpec({ ...film, params: { ...PARAMS, transition: 'crossfade' } });
  assert.deepEqual(cross.batches.map((batch) => [batch.from, batch.to]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
  assert.deepEqual(cross.batches.map((batch) => batch.frames), [150, 150, 150, 150, 150]);
  assert.deepEqual(cross.batches.map((batch) => batch.inputs.length), [2, 3, 3, 3, 3], 'the first batch has no scene before it');
  assert.deepEqual(cross.batches[1].inputs, [film.order[1], film.order[2], film.order[3]]);
  assert.deepEqual(cross.batches[4].inputs, [film.order[7], film.order[8], film.order[9]]);
  assert.doesNotMatch(cross.batches[0].graph, /tail/);
  const sceneOne = /\[2:v\](.*?)\[v1\]/.exec(crossSingle.graph)[1];
  assert.ok(cross.batches[1].graph.startsWith(`[0:v]${sceneOne},trim=start_frame=75,setpts=PTS-STARTPTS[tail];`), 'the same chain as in the batch before, from the end of the scene on');
  assert.match(cross.batches[1].graph, /\[tail\]\[v2\]xfade=transition=fade:duration=0\.24:offset=0\[x2\]/, 'the fade-in starts with the batch');
  assert.match(cross.batches[1].graph, /\[x2\]\[v3\]xfade=transition=fade:duration=0\.24:offset=3\[x3\]/, 'later ones where their scene starts, from the start of the batch');
  assert.match(cross.batches[1].graph, /\[x3\]trim=end_frame=150,setpts=PTS-STARTPTS\[vb\]/, 'what runs on under the next batch is cut off');
  assert.match(cross.batches[0].graph, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.24:offset=3\[x1\]/);
  assert.match(cross.batches[0].graph, /\[x1\]trim=end_frame=150/);
  // every scene is made with its own 75 frames and the 6 that run on under the next one (the last scene of the film has no next one);
  // the second decoder makes the same 81 frames as the batch before, of which it keeps the last 6
  const count = (graph, pattern) => (graph.match(pattern) || []).length;
  assert.deepEqual(cross.batches.map((batch) => count(batch.graph, /tpad=stop=81:/g)), [2, 3, 3, 3, 2]);
  assert.deepEqual(cross.batches.map((batch) => count(batch.graph, /tpad=stop=75:/g)), [0, 0, 0, 0, 1], 'the last scene of the film');
  // a batch of one clip is a batch of one scene and the clip before it
  assert.deepEqual(edit.buildEditPlan({ ...film, params: { ...PARAMS, transition: 'crossfade' }, batchScenes: 1 }).batches.map((batch) => batch.to - batch.from), Array(10).fill(1));
  assert.deepEqual(edit.buildEditPlan({ ...film, params: { ...PARAMS, transition: 'crossfade' }, batchScenes: 5 }).batches.map((batch) => [batch.from, batch.to]), [[0, 4], [4, 8], [8, 10]]);

  // flash: every scene but the first comes in from white, also the first one of a batch
  const flash = edit.buildEditPlan({ ...film, params: { ...PARAMS, transition: 'flash' } });
  assert.doesNotMatch(flash.batches[0].graph.split(';')[0], /color=white/);
  assert.match(flash.batches[1].graph.split(';')[0], /fade=t=in:st=0:d=0\.15:color=white/);
  assert.equal(flash.batches[1].inputs.length, 3, 'no second decoder: nothing runs on under a flash');

  // a scene too short to fade has no fade-in and so no second decoder (the first scene of the second batch is one frame long)
  const regular = edit.buildEditPlan({ ...filmOf(6), params: { ...PARAMS, transition: 'crossfade' } });
  assert.deepEqual(regular.batches.map((batch) => batch.inputs.length), [2, 3, 3]);
  const brief = filmOf(6);
  brief.shots.shots[2] = { ...brief.shots.shots[2], start: 6, end: 6.001 };
  brief.shots.shots[3] = { ...brief.shots.shots[3], start: 6.001, end: 9 };
  const quick = edit.buildEditPlan({ ...brief, params: { ...PARAMS, transition: 'crossfade' } });
  assert.deepEqual(quick.batches.map((batch) => batch.inputs.length), [2, 2, 3], 'a scene of one frame does not fade in');

  // the errors of a single process are the errors of the plan
  assert.throws(() => edit.buildEditPlan({ shots: { shots: [] }, order: [], infos: film.infos, params: {} }), /no scenes/);
  assert.throws(() => edit.buildEditPlan({ ...film, order: film.order.slice(1), params: {} }), /needs a clip/);
  const noVideo = film.infos.slice();
  noVideo[9] = { video: null, duration: 5 };
  assert.throws(() => edit.buildEditPlan({ ...film, infos: noVideo, params: {} }), /clip of scene 9 has no video/, 'also in a later batch');
  assert.throws(() => edit.buildEditPlan({ ...film, infos: [{ video: null, audio: null }, ...film.infos.slice(1)], params: {} }), /song has no audio/);
}

/* ---------- with ffmpeg ---------- */

let tools = null;
const COLORS = { red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255] };

async function ff(args) {
  await execFileAsync(tools.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
}

async function makeClip(file, { color, seconds, size = '640x360', fps = 25, withAudio = false }) {
  const args = ['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=1000:duration=${seconds}`, '-shortest');
  await ff([...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(withAudio ? ['-c:a', 'aac'] : []), file]);
}

// The colour at (x, y) of the frame at time t (default the middle of the picture), as [r, g, b].
async function colorAt(file, time, x = null, y = null) {
  const crop = x === null ? 'scale=1:1' : `format=rgb24,crop=1:1:${x}:${y}`;
  const { stdout } = await execFileAsync(tools.ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [...stdout.subarray(0, 3)];
}

const close = (actual, expected, tolerance = 30) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

async function probe(file) {
  const { stdout } = await execFileAsync(tools.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  const [num, den] = String(video.avg_frame_rate).split('/').map(Number);
  return {
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    fps: num / den,
    frames: Number(video.nb_read_frames),
    videoSeconds: Number(video.duration),
    audio: audio ? { codec: audio.codec_name, seconds: Number(audio.duration) } : null,
    seconds: Number(data.format.duration)
  };
}

// The plan of the edit for a list of scenes (times given) and the clip files, one per scene; the song is dir/song.wav.
const clipInfos = new Map();
async function planFilm(dir, shotList, files, params, aspect = '16:9', batchScenes = undefined) {
  const song = path.join(dir, 'song.wav');
  const inputs = [song, ...files];
  // the clips are made once and never change; the song does, from one part of the test to the next
  const infos = [await ops.probeMedia(song)];
  for (const file of files) {
    if (!clipInfos.has(file)) clipInfos.set(file, await ops.probeMedia(file));
    infos.push(clipInfos.get(file));
  }
  const plan = edit.buildEditPlan({
    shots: { aspect_ratio: aspect, shots: shotList },
    order: files.map((_file, index) => index + 1),
    infos,
    batchScenes,
    params: { transition: 'cut', resolution: '720p', fps: 25, fit: 'crop', fade_out: 1, ...params }
  });
  return { plan, inputs };
}

// Runs the edit (one process or batches, as the plan says) and returns the output file and the plan (`spec` is the same: the tests
// read frames and summary from it).
async function render(dir, name, shotList, files, params, aspect = '16:9', { batchScenes, signal, onSpawn, timeoutMs = 300000 } = {}) {
  const { plan, inputs } = await planFilm(dir, shotList, files, params, aspect, batchScenes);
  const output = path.join(dir, `${name}.mp4`);
  await renderer.renderPlan(plan, { files: inputs, outputFile: output, ffmpegPath: tools.ffmpeg, timeoutMs, signal, onSpawn });
  return { output, spec: plan, plan };
}

async function testWithFfmpeg() {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) {
    console.log('(ffmpeg not found: the cutting is not run)');
    return;
  }
  tools = binaries;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-music-video-edit-'));
  try {
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', path.join(dir, 'song.wav')]);
    await makeClip(path.join(dir, 'red.mp4'), { color: 'red', seconds: 5 });
    await makeClip(path.join(dir, 'blue.mp4'), { color: 'blue', seconds: 6.5, size: '640x480', fps: 30, withAudio: true });
    await makeClip(path.join(dir, 'yellow.mp4'), { color: 'yellow', seconds: 3, size: '320x240', fps: 24 });
    await makeClip(path.join(dir, 'green.mp4'), { color: 'green', seconds: 1 });
    const files = ['red', 'blue', 'yellow'].map((name) => path.join(dir, `${name}.mp4`));
    const shotList = [
      { start: 0, end: 4.2, kind: 'story', clip: 0 },
      { start: 4.2, end: 10.7, kind: 'performance', clip: 0 },
      { start: 10.7, end: 14, kind: 'story', clip: 1 }
    ];

    // --- cut
    const cut = await render(dir, 'cut', shotList, files, { transition: 'cut' });
    const info = await probe(cut.output);
    assert.equal(info.codec, 'h264');
    assert.deepEqual([info.width, info.height], [1280, 720]);
    assert.equal(info.fps, 25);
    assert.equal(info.frames, cut.spec.frames, 'exactly the frames of the plan');
    assert.equal(info.frames, 350);
    assert.ok(Math.abs(info.seconds - 14) <= 0.04 + 0.02, `${info.seconds} s`);
    assert.equal(info.audio.codec, 'aac', 'the song is underneath');
    assert.ok(Math.abs(info.audio.seconds - 14) <= 0.1, `audio ${info.audio.seconds} s`);
    // which clip is on screen: red until 4.2 s, blue (the singer, 640x480 cropped to fill) until 10.7 s, yellow after
    assert.ok(close(await colorAt(cut.output, 2), COLORS.red), 'scene 1 is red');
    assert.ok(close(await colorAt(cut.output, 4.12), COLORS.red), 'still red a moment before the cut');
    assert.ok(close(await colorAt(cut.output, 4.28), COLORS.blue), 'blue a moment after the cut');
    assert.ok(close(await colorAt(cut.output, 7.5), COLORS.blue), 'scene 2 is blue');
    assert.ok(close(await colorAt(cut.output, 10.62), COLORS.blue), 'still blue before the cut');
    assert.ok(close(await colorAt(cut.output, 10.78), COLORS.yellow), 'yellow after the cut');
    assert.ok(close(await colorAt(cut.output, 12.9), COLORS.yellow), 'the short clip (3 s for 3.3 s, slowed) holds to the end of the scene');
    const dark = await colorAt(cut.output, 13.95);
    assert.ok(dark.every((value) => value < 60), `the picture fades out with the song: ${dark}`);
    // the sound of the clips is not used: one audio stream, the song, with its fade-out
    const loud = await meanVolume(cut.output, 2, 1);
    const quiet = await meanVolume(cut.output, 13.5, 0.5);
    assert.ok(loud > -25, `the song is there: ${loud} dB`);
    assert.ok(quiet < loud - 6, `and fades out: ${quiet} dB against ${loud} dB`);
    assert.ok((await probeAudioStreams(cut.output)) === 1);
    // the speed per scene as it was built
    assert.deepEqual(cut.spec.summary.map((item) => item.kind), ['story', 'performance', 'story']);
    assert.ok(cut.spec.summary[2].speed < 1 && cut.spec.summary[2].speed >= 0.8);

    // --- a clip much too short: slowed to 0.8, then the last frame is held; the singer is only held
    const shortList = [
      { start: 0, end: 4, kind: 'story', clip: 0 },
      { start: 4, end: 8, kind: 'performance', clip: 0 }
    ];
    const tooShort = await render(dir, 'short', shortList, [path.join(dir, 'green.mp4'), path.join(dir, 'green.mp4')], { transition: 'cut', fade_out: 0 });
    assert.equal(tooShort.spec.summary[0].speed, 0.8);
    assert.equal(tooShort.spec.summary[1].speed, 1);
    const shortInfo = await probe(tooShort.output);
    assert.equal(shortInfo.frames, 200);
    assert.ok(close(await colorAt(tooShort.output, 3.9), COLORS.green), 'held to the end of the scene');
    assert.ok(close(await colorAt(tooShort.output, 7.9), COLORS.green));

    // --- fit: pad leaves bars, crop fills the frame
    const padded = await render(dir, 'pad', [{ start: 0, end: 3, kind: 'story', clip: 0 }], [path.join(dir, 'yellow.mp4')], { fit: 'pad', fade_out: 0 });
    assert.ok(close(await colorAt(padded.output, 1, 5, 360), [0, 0, 0], 10), 'a black bar on the left (4:3 in 16:9)');
    assert.ok(close(await colorAt(padded.output, 1, 640, 360), COLORS.yellow), 'the picture in the middle');
    const cropped = await render(dir, 'crop', [{ start: 0, end: 3, kind: 'story', clip: 0 }], [path.join(dir, 'yellow.mp4')], { fit: 'crop', fade_out: 0 });
    assert.ok(close(await colorAt(cropped.output, 1, 5, 360), COLORS.yellow), 'no bar when cropped');
    // vertical
    const vertical = await render(dir, 'vertical', [{ start: 0, end: 3, kind: 'story', clip: 0 }], [path.join(dir, 'red.mp4')], { resolution: '720p', fade_out: 0 }, '9:16');
    const verticalInfo = await probe(vertical.output);
    assert.deepEqual([verticalInfo.width, verticalInfo.height], [720, 1280]);
    assert.ok(close(await colorAt(vertical.output, 1), COLORS.red));

    // --- crossfade: the same length, a mix at the boundary, the scene boundaries stay where they are
    const cross = await render(dir, 'cross', shotList, files, { transition: 'crossfade' });
    const crossInfo = await probe(cross.output);
    assert.equal(crossInfo.frames, 350, 'a crossfade does not make the film longer');
    assert.ok(close(await colorAt(cross.output, 4.1), COLORS.red), 'pure red before');
    const mixed = await colorAt(cross.output, 4.32);
    assert.ok(mixed[0] > 30 && mixed[2] > 30, `a mix of red and blue in the fade: ${mixed}`);
    assert.ok(close(await colorAt(cross.output, 4.6), COLORS.blue), 'pure blue after the fade');
    assert.ok(close(await colorAt(cross.output, 10.5), COLORS.blue));
    assert.ok(close(await colorAt(cross.output, 11.1), COLORS.yellow));

    // --- flash: the new scene comes in from white at the boundary
    const flash = await render(dir, 'flash', shotList, files, { transition: 'flash' });
    assert.equal((await probe(flash.output)).frames, 350);
    const white = await colorAt(flash.output, 4.2);
    assert.ok(white.every((value) => value > 200), `white at the cut: ${white}`);
    assert.ok(close(await colorAt(flash.output, 4.5), COLORS.blue), 'and blue 0.3 s later');
    assert.ok(close(await colorAt(flash.output, 2), COLORS.red), 'the first scene starts as it is');

    // --- 1080p, 30 fps
    const hd = await render(dir, 'hd', [{ start: 0, end: 2, kind: 'story', clip: 0 }], [path.join(dir, 'red.mp4')], { resolution: '1080p', fps: 30, fade_out: 0 });
    const hdInfo = await probe(hd.output);
    assert.deepEqual([hdInfo.width, hdInfo.height, hdInfo.fps, hdInfo.frames], [1920, 1080, 30, 60]);

    // --- a song that is shorter than the film is padded with silence, one that is longer is cut
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', path.join(dir, 'song.wav')]);
    const briefSong = await render(dir, 'brief-song', shotList, files, { fade_out: 0 });
    const briefInfo = await probe(briefSong.output);
    assert.ok(Math.abs(briefInfo.audio.seconds - 14) <= 0.1, `padded to ${briefInfo.audio.seconds} s`);
    assert.equal(briefInfo.frames, 350);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', path.join(dir, 'song.wav')]);

    await testBatches(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- batches, with ffmpeg ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The colour of every frame of a video (the mean of its picture), as [r, g, b].
async function frameColors(file) {
  const { stdout } = await execFileAsync(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-an', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  });
  const colors = [];
  for (let at = 0; at + 3 <= stdout.length; at += 3) colors.push([stdout[at], stdout[at + 1], stdout[at + 2]]);
  return colors;
}

// Every frame as a picture of 48 x 27 pixels (rgb), to compare two films frame by frame.
const THUMB_BYTES = 48 * 27 * 3;
async function thumbnails(file) {
  const { stdout } = await execFileAsync(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-an', '-vf', 'scale=48:27:flags=area,format=rgb24', '-f', 'rawvideo', '-'], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024
  });
  return stdout;
}

// The largest difference of a colour value between two lists of thumbnails, and the frame it is in.
function compareFilms(left, right) {
  assert.equal(left.length, right.length, 'the same number of frames');
  let worst = 0;
  let frame = -1;
  for (let index = 0; index < left.length; index += 1) {
    const diff = Math.abs(left[index] - right[index]);
    if (diff > worst) {
      worst = diff;
      frame = Math.floor(index / THUMB_BYTES);
    }
  }
  return { worst, frame };
}

// Follows the processes a render starts: how many clips each opens, how many batches run at a time, whether all have ended.
function tracker() {
  const state = { children: [], calls: [], mostBatchesAtOnce: 0 };
  let live = 0;
  state.onSpawn = (child, args) => {
    const batch = !args.includes('pipe:0');
    state.children.push(child);
    state.calls.push({ batch, inputs: args.filter((arg) => arg === '-i').length, args });
    if (batch) {
      live += 1;
      state.mostBatchesAtOnce = Math.max(state.mostBatchesAtOnce, live);
      child.on('close', () => {
        live -= 1;
      });
    }
  };
  // true when every process has ended (waits a moment for the last ones)
  state.allEnded = async () => {
    for (let wait = 0; wait < 200; wait += 1) {
      if (state.children.every((child) => child.exitCode !== null || child.signalCode !== null)) return true;
      await sleep(50);
    }
    return false;
  };
  return state;
}

// Checks the colour of every frame of a film against the scenes: the clips are one colour each, so the frame a scene starts with, the
// frames it keeps and the way it comes in (cut, a mix with the scene before over `overlap` frames, from white) tell the number of frames
// of every scene exactly. The frames of the fade-out at the end are left out.
function checkColors(colors, { bounds, sceneColors, transition, fps, fadeFrames, label }) {
  const total = bounds[bounds.length - 1] - bounds[0];
  assert.equal(colors.length, total, `${label}: the number of frames`);
  const overlap = Math.max(1, Math.round(edit.CROSSFADE_SEC * fps));
  const flashFrames = Math.ceil(edit.FLASH_SEC * fps) + 1;
  let scene = 0;
  for (let frame = 0; frame < total - fadeFrames; frame += 1) {
    while (frame >= bounds[scene + 1]) scene += 1;
    const into = frame - bounds[scene];
    let expected = sceneColors[scene];
    let tolerance = 30;
    if (scene > 0 && transition === 'crossfade' && into < overlap) {
      const weight = into / overlap;
      expected = sceneColors[scene - 1].map((value, channel) => value * (1 - weight) + sceneColors[scene][channel] * weight);
      tolerance = 40;
    } else if (scene > 0 && transition === 'flash' && into < flashFrames) {
      if (into > 0) continue; // a mix with white: not looked at
      expected = [255, 255, 255];
    }
    assert.ok(close(colors[frame], expected, tolerance), `${label}: frame ${frame} (${into} into scene ${scene + 1}) is ${colors[frame]}, not ${expected.map(Math.round)}`);
  }
}

const framesOf = (shotList, fps) => {
  const bounds = edit.frameBounds(shotList, fps);
  return bounds[bounds.length - 1] - bounds[0];
};

async function testBatches(dir) {
  const clip = (name) => path.join(dir, `${name}.mp4`);
  await makeClip(clip('cyan'), { color: 'cyan', seconds: 4 });
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip('moving')]);

  // --- the film of batches is the film of a single process, frame for frame, whatever the batches and the transition: ten scenes of
  // different lengths (the boundaries fall on odd frames), clips of other sizes and frame rates, too short ones, a moving picture, the
  // singer; batches of one scene and of three (the last one with a single scene)
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=16', path.join(dir, 'song.wav')]);
  const parts = [['story', 'red'], ['story', 'blue'], ['performance', 'yellow'], ['story', 'moving'], ['story', 'green'], ['story', 'cyan'], ['performance', 'moving'], ['story', 'red'], ['story', 'yellow'], ['story', 'blue']];
  const times = [0, 1.7, 3.1, 5.0, 6.45, 8.2, 9.0, 11.3, 12.6, 14.1, 16.0];
  const shotList = parts.map(([kind], index) => ({ start: times[index], end: times[index + 1], kind, clip: 0 }));
  const files = parts.map(([, name]) => clip(name));
  for (const transition of edit.TRANSITIONS) {
    const reference = await render(dir, `reference-${transition}`, shotList, files, { transition, fade_out: 1 }, '16:9', { batchScenes: 1000 });
    assert.equal(reference.plan.mode, 'single');
    const referenceFrames = await thumbnails(reference.output);
    assert.equal(referenceFrames.length / THUMB_BYTES, 400);
    for (const batchScenes of [1, 3]) {
      const tracked = tracker();
      const batched = await render(dir, `batches-of-${batchScenes}-${transition}`, shotList, files, { transition, fade_out: 1 }, '16:9', { batchScenes, onSpawn: tracked.onSpawn });
      const label = `${transition}, batches of ${batchScenes}`;
      assert.equal(batched.plan.mode, 'batched', label);
      assert.equal(tracked.calls.length, batched.plan.batches.length + 1, `${label}: a process for every batch and the encoder`);
      assert.equal(tracked.mostBatchesAtOnce, 1, `${label}: the batches run one after the other`);
      assert.ok(await tracked.allEnded(), `${label}: no process is left`);
      const info = await probe(batched.output);
      assert.equal(info.frames, 400, `${label}: the frames`);
      assert.equal(info.codec, 'h264');
      assert.ok(Math.abs(info.audio.seconds - 16) <= 0.1 && Math.abs(info.seconds - 16) <= 0.1, `${label}: the sound`);
      const { worst, frame } = compareFilms(referenceFrames, await thumbnails(batched.output));
      assert.ok(worst <= 4, `${label}: differs from the film of a single process by ${worst} (colour value) in frame ${frame}`);
    }
  }
  // nothing but the films is left in the folder: no pieces
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => /segment|piece|\.raw|\.yuv|\.tmp|\.txt/.test(name)), [], 'no intermediate files');

  // --- other formats: vertical, and 1080p at 30 fps with a crossfade (the size of the raw frames follows the plan)
  const vertical = await render(dir, 'vertical-batched', shotList.slice(0, 6), files.slice(0, 6), { fade_out: 0 }, '9:16', { batchScenes: 2 });
  assert.equal(vertical.plan.mode, 'batched');
  const verticalInfo = await probe(vertical.output);
  assert.deepEqual([verticalInfo.width, verticalInfo.height, verticalInfo.frames], [720, 1280, framesOf(shotList.slice(0, 6), 25)]);
  assert.ok(close(await colorAt(vertical.output, 0.5), COLORS.red) && close(await colorAt(vertical.output, 3.5), COLORS.yellow));
  const hd = await render(dir, 'hd-batched', shotList.slice(0, 5), files.slice(0, 5), { resolution: '1080p', fps: 30, fade_out: 0, transition: 'crossfade' }, '16:9', { batchScenes: 2 });
  const hdInfo = await probe(hd.output);
  assert.deepEqual([hdInfo.width, hdInfo.height, hdInfo.fps, hdInfo.frames], [1920, 1080, 30, framesOf(shotList.slice(0, 5), 30)]);

  // --- fifty scenes of 1.2 s, 60 s: cut in batches (of three scenes, under a crossfade of two and the clip before), whatever the transition
  const names = ['red', 'blue', 'yellow', 'green', 'cyan'];
  const sceneColors = names.map((name) => COLORS[name]);
  const many = [];
  const manyFiles = [];
  let storyClip = 0;
  let singerClip = 0;
  for (let index = 0; index < 50; index += 1) {
    const kind = index % 7 === 3 ? 'performance' : 'story';
    many.push({ start: (index * 60) / 50, end: ((index + 1) * 60) / 50, kind, clip: kind === 'story' ? storyClip++ : singerClip++ });
    manyFiles.push(clip(names[index % 5]));
  }
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', path.join(dir, 'song.wav')]);
  const bounds = edit.frameBounds(many, 25);
  const fadeFrames = 50; // fade_out 2 s
  for (const transition of edit.TRANSITIONS) {
    const label = `fifty scenes, ${transition}`;
    const tracked = tracker();
    const started = Date.now();
    const fifty = await render(dir, `fifty-${transition}`, many, manyFiles, { transition, resolution: '720p', fps: 25, fade_out: 2 }, '16:9', { onSpawn: tracked.onSpawn });
    assert.equal(fifty.plan.mode, 'batched', label);
    const size = transition === 'crossfade' ? edit.BATCH_SCENES - 1 : edit.BATCH_SCENES;
    const batchCount = Math.ceil(50 / size);
    assert.equal(fifty.plan.batches.length, batchCount);
    assert.deepEqual(fifty.plan.batches.map((batch) => batch.from), Array.from({ length: batchCount }, (_unused, index) => index * size));
    // the processes: the encoder (the pictures from a pipe, and the song) and a batch at a time with no more clips than a batch has
    assert.equal(tracked.calls.length, batchCount + 1, `${label}: ${batchCount} batches and the encoder`);
    assert.ok(!tracked.calls[0].batch && tracked.calls[0].args.includes('pipe:0'), `${label}: the encoder is started first and reads the pictures from a pipe`);
    assert.equal(tracked.calls[0].inputs, 2, `${label}: the encoder opens the pipe and the song`);
    assert.equal(tracked.mostBatchesAtOnce, 1, `${label}: one batch at a time`);
    const most = Math.max(...tracked.calls.filter((call) => call.batch).map((call) => call.inputs));
    assert.equal(most, edit.BATCH_SCENES, `${label}: the clips one process opens`);
    assert.ok(await tracked.allEnded(), `${label}: no process is left`);

    // the length: 1500 frames, within one frame of 60 s
    const info = await probe(fifty.output);
    assert.equal(info.frames, 1500, `${label}: exactly 60 s`);
    assert.ok(Math.abs(info.videoSeconds - 60) <= 0.04, `${label}: ${info.videoSeconds} s`);
    assert.ok(Math.abs(info.seconds - 60) <= 0.1);
    // every scene has its frames, the boundaries are where the plan put them, also at the starts of the batches (3, 6, ... or 2, 4, ...)
    const colors = await frameColors(fifty.output);
    checkColors(colors, { bounds, sceneColors: many.map((_shot, index) => sceneColors[index % 5]), transition, fps: 25, fadeFrames, label });
    if (transition === 'cut') {
      // the number of frames of every scene, counted: a run of frames of the colour of the scene
      const nearest = (color) => sceneColors.reduce((best, candidate, index) => (best === -1 || colorDistance(color, candidate) < colorDistance(color, sceneColors[best]) ? index : best), -1);
      const runs = [];
      colors.slice(0, colors.length - fadeFrames).forEach((color, frame) => {
        const index = nearest(color);
        if (runs.length && runs[runs.length - 1].index === index) runs[runs.length - 1].length += 1;
        else runs.push({ index, length: 1, frame });
      });
      const lengths = many.map((_shot, index) => bounds[index + 1] - bounds[index]);
      assert.deepEqual(runs.slice(0, 47).map((run) => run.length), lengths.slice(0, 47), 'the frames of every scene');
      assert.deepEqual(runs.slice(0, 47).map((run) => run.index), many.slice(0, 47).map((_shot, index) => index % 5));
    }
    // the fade-out: the picture goes dark with the song
    const last = colors[colors.length - 1];
    assert.ok(last.every((value) => value < 40), `${label}: the last frame is dark: ${last}`);
    // half way down the fade: darker than the clip of its scene is (the fade covers the end of the last two scenes)
    const halfFrame = colors.length - fadeFrames / 2;
    const halfScene = bounds.findIndex((bound, index) => halfFrame >= bound && halfFrame < bounds[index + 1]);
    const brightness = (color) => color.reduce((sum, value) => sum + value, 0);
    assert.ok(brightness(colors[halfFrame]) < brightness(sceneColors[halfScene % 5]) * 0.8, `${label}: half way down (${colors[halfFrame]} in scene ${halfScene + 1})`);
    // the sound: one stream, the song, with its fade-out
    assert.equal(await probeAudioStreams(fifty.output), 1);
    assert.ok(Math.abs(info.audio.seconds - 60) <= 0.15, `${label}: the sound lasts ${info.audio.seconds} s`);
    const loud = await meanVolume(fifty.output, 30, 1);
    const quiet = await meanVolume(fifty.output, 59.5, 0.5);
    assert.ok(loud > -25, `${label}: the song is there: ${loud} dB`);
    assert.ok(quiet < loud - 6, `${label}: and fades out: ${quiet} dB against ${loud} dB`);
    assert.ok(Date.now() - started < 150000, `${label}: ${Date.now() - started} ms`);
    await fsp.rm(fifty.output, { force: true });
  }

  // --- when it goes wrong: an abort, a clip that cannot be read, an encoder that cannot write, the time limit, a batch with the
  // wrong number of frames; every time the job ends at once with the reason, and no process is left
  const { plan, inputs } = await planFilm(dir, many, manyFiles, { transition: 'crossfade', resolution: '720p', fps: 25, fade_out: 2 });
  const output = path.join(dir, 'failing.mp4');
  const run = (overrides = {}) => renderer.renderPlan(overrides.plan || plan, { files: overrides.files || inputs, outputFile: overrides.outputFile || output, ffmpegPath: tools.ffmpeg, ...overrides.options });
  const isAbort = (err) => err.name === 'AbortError' && err.code === 'ABORT_ERR';

  // abort in the middle of the job
  {
    const controller = new AbortController();
    const tracked = tracker();
    const started = Date.now();
    await assert.rejects(
      run({
        options: {
          signal: controller.signal,
          onSpawn: (child, args) => {
            tracked.onSpawn(child, args);
            if (tracked.children.length === 3) controller.abort(); // the encoder and two batches have been started
          }
        }
      }),
      isAbort
    );
    assert.ok(await tracked.allEnded(), 'abort: every process is killed');
    assert.equal(tracked.children.length, 3, 'abort: nothing is started after it');
    assert.ok(Date.now() - started < 30000, 'abort: at once');
  }
  // a signal that has been aborted before: nothing is started
  {
    const controller = new AbortController();
    controller.abort();
    const tracked = tracker();
    await assert.rejects(run({ options: { signal: controller.signal, onSpawn: tracked.onSpawn } }), isAbort);
    assert.equal(tracked.children.length, 0);
  }
  // a clip that cannot be read, in the fifth batch (scenes 9 and 10, the plan is a crossfade): the reason, the earlier batches have run,
  // the later ones do not
  {
    const broken = inputs.slice();
    broken[10] = path.join(dir, 'missing.mp4');
    const tracked = tracker();
    await assert.rejects(run({ files: broken, options: { onSpawn: tracked.onSpawn } }), /^Error: Scenes 9 to 10: ffmpeg ist fehlgeschlagen \(Exit \d+\).*missing\.mp4/);
    assert.ok(await tracked.allEnded(), 'broken clip: every process is killed');
    assert.equal(tracked.children.length, 6, 'broken clip: the encoder and five batches');
  }
  // an encoder that cannot write its file: at once, not after the film
  {
    const tracked = tracker();
    const started = Date.now();
    await assert.rejects(run({ outputFile: path.join(dir, 'no-such-folder', 'film.mp4'), options: { onSpawn: tracked.onSpawn } }), /^Error: ffmpeg ist fehlgeschlagen \(Exit \d+\)/);
    assert.ok(await tracked.allEnded(), 'encoder: every process is killed');
    assert.ok(tracked.children.length <= 2, 'encoder: at most the first batch was started');
    assert.ok(Date.now() - started < 20000, 'encoder: at once');
  }
  // the time limit of the whole job
  {
    const tracked = tracker();
    await assert.rejects(run({ options: { timeoutMs: 400, onSpawn: tracked.onSpawn } }), /Zeitlimit/);
    assert.ok(await tracked.allEnded(), 'time limit: every process is killed');
  }
  // a batch that delivers more or fewer frames than it should (the raw frames have no times: it would shift the rest of the film)
  {
    const small = await planFilm(dir, shotList, files, { transition: 'crossfade', fade_out: 1 });
    assert.equal(small.plan.mode, 'batched');
    const claimed = small.plan.batches[1].frames;
    for (const [claim, delivered] of [[claimed + 1, claimed], [claimed - 1, claimed]]) {
      const wrong = { ...small.plan, batches: small.plan.batches.map((batch, index) => (index === 1 ? { ...batch, frames: claim } : batch)) };
      const tracked = tracker();
      await assert.rejects(
        run({ plan: wrong, files: small.inputs, options: { onSpawn: tracked.onSpawn } }),
        new RegExp(`^Error: The cut of scenes ${small.plan.batches[1].from + 1} to ${small.plan.batches[1].to} delivered ${delivered} frames instead of ${claim}$`)
      );
      assert.ok(await tracked.allEnded(), 'wrong number of frames: every process is killed');
    }
    // the same plan, right, works
    await run({ plan: small.plan, files: small.inputs, outputFile: path.join(dir, 'small.mp4') });
    assert.equal((await probe(path.join(dir, 'small.mp4'))).frames, 400);
  }
  // the plan that is not there
  await assert.rejects(renderer.renderPlan(plan, { files: inputs, outputFile: output }), /ffmpeg wurde nicht gefunden/);
  await assert.rejects(renderer.renderPlan({ mode: 'other' }, { files: inputs, outputFile: output, ffmpegPath: tools.ffmpeg }), /Unknown plan mode other/);
}

const colorDistance = (left, right) => left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0);

async function meanVolume(file, start, seconds) {
  const { stderr } = await execFileAsync(tools.ffmpeg, ['-nostdin', '-hide_banner', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).catch((err) => err);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(stderr));
  return match ? Number(match[1]) : -Infinity;
}

async function probeAudioStreams(file) {
  const { stdout } = await execFileAsync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return stdout.split(/\r?\n/).filter(Boolean).length;
}

(async () => {
  testEditUnchanged();
  testStills();
  testPieces();
  await testWithFfmpeg();
  console.log('test-music-video-edit.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
