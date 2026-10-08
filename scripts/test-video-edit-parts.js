'use strict';

// "Edit longer videos in parts" (WP41): the switch of the node "Edit video with references" (fal.video_edit) for a video that is longer
// than the model takes. A fake fal and a fake OpenRouter, the REAL ffmpeg on small pictures (90 x 160 px, the luma of a picture
// grows with its time, so the order and the position of every part can be measured). Nothing is paid, nothing leaves the machine.
//   - the cut: 53.5 s at 30 fps are 1605 frames = 4 parts of 402, 401, 401, 401 frames (about 13.4 s), on frame boundaries, no sound
//   - the price: 53.5 x 0.14 USD, the sum of the parts (Aleph: every part is priced for at least 5 s and by its length above that, 2 parts
//     and 14.98 USD for 53.5 s), shown in the plan, booked per part
//   - the run: the parts go in order, are edited with the same prompt, are brought to the length of their input part and joined; the
//     film is as long as the original (within a frame), the pictures stay in order and the sound is the ORIGINAL sound
//   - a model that returns another length and another frame rate than it got (13.375 s at 24 fps for every part); a part that comes back
//     more than 10 % off its length is NOT stretched: the node fails with VIDEO_EDIT_PART_LENGTH, the paid parts stay and cost nothing
//     again, "Make part again" makes the bad one (live test 2026-10-04, Aleph)
//   - a part that fails: the finished parts cost nothing the next time; a running job is adopted; one part again ("redo_parts"), all
//     parts again (run again), a changed prompt makes new parts
//   - a video under the limit stays ONE run; "in parts" wins over "cut to the allowed length"
//   - the parts run side by side; the engine hands out ONE slot for the waits of one node
//   - the budget of a participant is checked for all parts before the first one starts
//   - the units: split, plan, key, retime, arguments of ffmpeg, the numbers of "redo_parts", the reader of the size of an image
//   - the texts of every new code in German, English and Spanish

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');

const store = require('../lib/store');
const fal = require('../lib/fal');
const or = require('../lib/openrouter');
const discovery = require('../lib/discovery');
const publicrefs = require('../lib/publicrefs');
const ffmpeg = require('../lib/ffmpeg');
const access = require('../lib/access');
const budget = require('../lib/budget');
const videoNodeModels = require('../lib/video-node-models');
const assets = require('../lib/nodes/assets');
const editParts = require('../lib/nodes/video-edit-parts');
const alephEdit = require('../lib/nodes/aleph-edit');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const engine = require('../lib/nodes/engine');
const { createRegistry } = require('../lib/nodes/registry');
const { textValue } = require('../lib/nodes/types');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const TYPE = 'fal.video_edit';

const near = (actual, expected, message, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${message || 'amount'}: ${actual} is not ${expected}`);
const plain = (value) => JSON.parse(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function withEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

/* ---------- units ---------- */

function testSplit() {
  // 53.5 s at 30 fps, Kling O3 (15 s less the slack): four parts of about 13.4 s, the spare frame to the first
  const parts = editParts.splitFrames({ totalFrames: 1605, fps: 30, maxSeconds: 14.95, minSeconds: 3 });
  assert.deepEqual(parts.map((part) => part.frames), [402, 401, 401, 401]);
  assert.deepEqual(parts.map((part) => part.startFrame), [0, 402, 803, 1204]);
  assert.equal(parts.reduce((sum, part) => sum + part.frames, 0), 1605, 'every frame is in exactly one part');
  parts.forEach((part, index) => {
    assert.equal(part.index, index);
    near(part.seconds, part.frames / 30, 'seconds');
    near(part.start, part.startFrame / 30, 'start');
    assert.ok(part.seconds <= 14.95 && part.seconds >= 3);
  });
  assert.ok(Math.max(...parts.map((part) => part.frames)) - Math.min(...parts.map((part) => part.frames)) <= 1, 'as equal as frames allow');
  // a video under the limit is one part, a video just over it two
  assert.equal(editParts.splitFrames({ totalFrames: 300, fps: 30, maxSeconds: 14.95 }).length, 1);
  assert.equal(editParts.splitFrames({ totalFrames: 449, fps: 30, maxSeconds: 14.95 }).length, 2);
  assert.equal(editParts.splitFrames({ totalFrames: 448, fps: 30, maxSeconds: 14.95 }).length, 1);
  // Runway Aleph 2.0, 30 s per run: 53.5 s are two parts of at most 29.95 s, none under the 2 s it needs
  const aleph = editParts.splitFrames({ totalFrames: 1605, fps: 30, maxSeconds: 29.95, minSeconds: 2 });
  assert.equal(aleph.length, 2);
  assert.deepEqual(aleph.map((part) => part.frames), [803, 802]);
  assert.equal(aleph.reduce((sum, part) => sum + part.frames, 0), 1605);
  assert.ok(aleph.every((part) => part.seconds <= 29.95 && part.seconds >= 2));
  // just over the limit (30.05 s and the slack): two parts, each far above the shortest length
  const alephJustOver = editParts.splitFrames({ totalFrames: 903, fps: 30, maxSeconds: 29.95, minSeconds: 2 });
  assert.equal(alephJustOver.length, 2);
  assert.ok(alephJustOver.every((part) => part.seconds > 15));
  // A short limit, as Aleph had from the first live test of 2026-10-04 until the control run (5 s per run): 53.5 s are eleven parts of at
  // most 4.95 s, none under the 2 s it needs
  const short = editParts.splitFrames({ totalFrames: 1605, fps: 30, maxSeconds: 4.95, minSeconds: 2 });
  assert.equal(short.length, 11);
  assert.deepEqual(short.map((part) => part.frames), [146, 146, 146, 146, 146, 146, 146, 146, 146, 146, 145]);
  assert.equal(short.reduce((sum, part) => sum + part.frames, 0), 1605);
  assert.ok(short.every((part) => part.seconds <= 4.95 && part.seconds >= 2));
  // just over that limit (5.05 s and the slack): two parts, each far above the shortest length
  const justOver = editParts.splitFrames({ totalFrames: 152, fps: 30, maxSeconds: 4.95, minSeconds: 2 });
  assert.equal(justOver.length, 2);
  assert.ok(justOver.every((part) => part.seconds > 2.4));
  // Gemini Omni, 10 s: 53.5 s are six parts
  const gemini = editParts.splitFrames({ totalFrames: 1605, fps: 30, maxSeconds: 9.95, minSeconds: 1 });
  assert.equal(gemini.length, 6);
  assert.equal(gemini.reduce((sum, part) => sum + part.frames, 0), 1605);
  assert.ok(gemini.every((part) => part.seconds <= 9.95));
  // a rate that is not whole (29.97)
  const ntsc = editParts.splitFrames({ totalFrames: 1603, fps: 30000 / 1001, maxSeconds: 14.95 });
  assert.equal(ntsc.reduce((sum, part) => sum + part.frames, 0), 1603);
  assert.ok(ntsc.every((part) => part.seconds <= 14.95));
  // a part below the shortest length of the model is an error (cannot happen while a model takes twice its shortest as its longest)
  assert.throws(() => editParts.splitFrames({ totalFrames: 100, fps: 30, maxSeconds: 5, minSeconds: 4 }), (err) => err.code === 'VIDEO_EDIT_PART_TOO_SHORT' && err.data.min === 4 && err.data.found === 3.33);
  assert.throws(() => editParts.splitFrames({ totalFrames: 0, fps: 30, maxSeconds: 5 }), /number of frames/);
  assert.throws(() => editParts.splitFrames({ totalFrames: 10, fps: 0, maxSeconds: 5 }), /rate/);
  console.log('   ok testSplit');
}

function testPlanAndKey() {
  const price = (seconds) => seconds * 0.14;
  assert.deepEqual(editParts.planParts(53.5, 14.95, price), { count: 4, usd: 7.49 });
  assert.deepEqual(editParts.planParts(14, 14.95, price), { count: 1, usd: 1.96 });
  assert.equal(editParts.planParts(NaN, 14.95, price), null);
  assert.equal(editParts.planParts(10, 0, price), null);
  assert.equal(editParts.planParts(10, 5, () => null), null);
  // the minimum of a price per part (the minimum per generation of a list, 0.56 for Aleph's): each part is priced on its own
  const withMinimum = (seconds) => Math.max(seconds * 0.28, 0.56);
  assert.deepEqual(editParts.planParts(1, 30, withMinimum), { count: 1, usd: 0.56 });
  assert.deepEqual(editParts.planParts(60.1, 29.95, withMinimum), { count: 3, usd: Math.round(3 * 0.28 * (60.1 / 3) * 1e6) / 1e6 });
  // Aleph with its real price (5 billed seconds at least, the length above that: lib/nodes/aleph-edit.js), 30 s per run: 53.5 s are two parts of
  // at most 29.95 s, priced by their length (53.5 x 0.28 = 14.98 USD, an upper bound: the live tests billed a flat 1.40 USD for 3 s and for 8 s)
  const aleph = (seconds) => alephEdit.priceFor(seconds);
  assert.deepEqual(editParts.planParts(53.5, 29.95, aleph), { count: 2, usd: 14.98 });
  assert.deepEqual(editParts.planParts(30.06, 29.95, aleph), { count: 2, usd: 8.4168 }, 'just over a run: two parts of 15.03 s, priced by their length');
  assert.deepEqual(editParts.planParts(4.9, 29.95, aleph), { count: 1, usd: 1.4 }, 'a short video: the 5 billed seconds');
  assert.deepEqual(editParts.planParts(8, 29.95, aleph), { count: 1, usd: 2.24 }, '8 s is one run, planned by its length (8 x 0.28)');
  assert.deepEqual(editParts.planParts(10, 29.95, aleph), { count: 1, usd: 2.8 });
  // A short limit (Aleph had 5 s per run from the first live test until the control run, 2026-10-04): every part is priced for 5 s at least,
  // so 53.5 s in parts of at most 4.95 s are 11 x 1.40 = 15.40 USD
  assert.deepEqual(editParts.planParts(53.5, 4.95, aleph), { count: 11, usd: 15.4 });
  assert.deepEqual(editParts.planParts(5.06, 4.95, aleph), { count: 2, usd: 2.8 }, 'just over a run: two runs of 1.40 (the parts are 2.53 s, billed as 5)');
  assert.deepEqual(editParts.planParts(4.9, 4.95, aleph), { count: 1, usd: 1.4 });
  assert.deepEqual(editParts.planParts(10, 4.95, aleph), { count: 3, usd: 4.2 });

  const base = { via: 'fal', target: 'fal-ai/kling/o3', input: { prompt: 'x' }, media: [], source: 'asset-1', rate: '30', longest: 15, from: 0, frames: 402 };
  const key = editParts.partKey(base);
  assert.match(key, /^ep1-[0-9a-f]{32}$/);
  assert.equal(editParts.partKey({ ...base }), key, 'the same part, the same key');
  for (const change of [{ from: 402 }, { frames: 401 }, { source: 'asset-2' }, { input: { prompt: 'y' } }, { target: 'fal-ai/other' }, { via: 'openrouter' }, { rate: '25' }, { longest: 10 }, { media: [['image_urls', ['a'], false]] }]) {
    assert.notEqual(editParts.partKey({ ...base, ...change }), key, `a change of ${Object.keys(change)[0]} is another part`);
  }
  console.log('   ok testPlanAndKey');
}

function testLengthProblems() {
  assert.equal(editParts.MAX_LENGTH_DEVIATION, 0.1, 'a part more than 10 % off is not stretched');
  const lengths = (wanted, found) => editParts.lengthProblems(wanted, found).map((item) => [item.number, Math.round(item.found * 1000) / 1000, Math.round(item.wanted * 1000) / 1000]);
  // what the models really do passes: Kling O3 returned 13.375 s for parts of 13.28 to 13.4 s (under 1 %), Aleph 0.4 % more than it got
  assert.deepEqual(lengths([13.4, 13.367, 13.367, 13.267], [13.375, 13.375, 13.375, 13.375]), []);
  assert.deepEqual(lengths([13.28], [13.375]), []);
  assert.deepEqual(lengths([13.4], [13.375]), []);
  assert.deepEqual(lengths([4.867, 4.867], [4.867 * 1.004, 4.867 * 0.996]), []);
  // a few per cent is fine as well: it is stretched
  assert.deepEqual(lengths([4.867, 4.867, 4.867, 4.867], [4.867 * 1.09, 4.867 * 0.91, 4.867 * 1.05, 4.867 * 0.95]), []);
  // more than 10 % in either direction is not (the numbers are those of the part in order, the first is 1)
  assert.deepEqual(lengths([4.867, 4.867, 4.867], [4.867 * 1.11, 4.867, 4.867 * 0.89]), [[1, 5.402, 4.867], [3, 4.332, 4.867]]);
  assert.deepEqual(lengths([4.867], [3]), [[1, 3, 4.867]], 'a 3 s result for a part of 4.87 s');
  assert.deepEqual(lengths([4.867], [9.7]), [[1, 9.7, 4.867]], 'twice as long');
  // a result without a length (no frames, nothing read) is a problem, never a stretch to infinity
  assert.deepEqual(lengths([4.867], [0]), [[1, 0, 4.867]]);
  assert.deepEqual(lengths([4.867], [NaN]), [[1, 0, 4.867]]);
  assert.deepEqual(lengths([4.867], [undefined]), [[1, 0, 4.867]]);
  assert.deepEqual(lengths([], []), []);
  // the share can be passed in (the constant is the default)
  assert.deepEqual(editParts.lengthProblems([10], [11.5], 0.2), []);
  assert.equal(editParts.lengthProblems([10], [11.5], 0.1).length, 1);
  // just under and just over the edge
  assert.deepEqual(lengths([10], [10.99]), []);
  assert.equal(lengths([10], [11.01]).length, 1);
  assert.deepEqual(lengths([10], [9.01]), []);
  assert.equal(lengths([10], [8.99]).length, 1);
  console.log('   ok testLengthProblems');
}

function testRetimeAndArguments() {
  // the frames of the edited parts at the rate of the model: the boundaries are rounded on the running sum
  const retime = editParts.retimePlan([402, 401, 401, 401], 30, 24);
  assert.equal(retime.reduce((sum, part) => sum + part.frames, 0), 1284, '53.5 s at 24 fps');
  assert.deepEqual(retime.map((part) => part.frames), [322, 320, 321, 321]);
  retime.forEach((part) => near(part.seconds, part.frames / 24, 'seconds'));
  // the sum is right whatever the number of parts
  for (const [frames, source, out] of [[[100, 100, 100], 25, 24], [[7, 7, 7, 7, 7], 30, 24], [[400, 399], 29.97, 24], [[1, 1, 1], 30, 24]]) {
    const total = frames.reduce((sum, value) => sum + value, 0);
    const parts = editParts.retimePlan(frames, source, out);
    assert.equal(parts.reduce((sum, part) => sum + part.frames, 0), Math.max(parts.length, Math.round((total / source) * out)), `sum for ${frames}`);
    assert.ok(parts.every((part) => part.frames >= 1));
  }

  assert.equal(editParts.rateText(24), '24');
  assert.equal(editParts.rateText(30), '30');
  assert.equal(editParts.rateText(30000 / 1001), '30000/1001');
  assert.equal(editParts.rateText(24000 / 1001), '24000/1001');
  assert.equal(editParts.rateText(25.0004), '25');
  assert.throws(() => editParts.rateText(0), /frame rate/);

  const cut = editParts.cutArgs({ source: '/in/v.mp4', output: '/out/p.mp4', startFrame: 402, frames: 401, fps: 30, width: 90, height: 160 });
  assert.equal(cut[cut.indexOf('-frames:v') + 1], '401');
  assert.ok(cut.includes('-an'), 'no sound in a part');
  near(Number(cut[cut.indexOf('-ss') + 1]), 401.5 / 30, 'half a frame early', 1e-5);
  assert.equal(cut.includes('-maxrate'), false);
  assert.equal(cut[cut.length - 1], '/out/p.mp4');
  const limited = editParts.cutArgs({ source: '/in/v.mp4', output: '/out/p.mp4', startFrame: 0, frames: 10, fps: 30, width: 91, height: 161, maxBitrate: 5000000 });
  assert.equal(limited[limited.indexOf('-maxrate') + 1], '5000000');
  assert.equal(limited[limited.indexOf('-bufsize') + 1], '10000000');
  assert.match(limited[limited.indexOf('-vf') + 1], /^scale=90:160:flags=lanczos,setsar=1$/, 'odd sizes are made even');
  // the ceiling for a size: 16 MB over 13.4 s, with a margin
  assert.equal(editParts.bitrateFor(16 * 1048576, 13.4), Math.floor((16 * 1048576 * 8 * 0.8) / 13.4));
  assert.equal(editParts.bitrateFor(Infinity, 13.4), 0);
  assert.equal(editParts.bitrateFor(1000, 0), 0);

  const retimeArgs = editParts.retimeArgs({ source: '/in/e.mp4', output: '/out/r.mp4', frames: 322, rate: '24', factor: 1.0018 });
  assert.match(retimeArgs[retimeArgs.indexOf('-vf') + 1], /^setpts=\(PTS-STARTPTS\)\*1\.0018,fps=24,setsar=1,tpad=stop_mode=clone:stop=3,trim=end_frame=322,setpts=PTS-STARTPTS$/);
  assert.ok(retimeArgs.includes('-an'));
  const scaled = editParts.retimeArgs({ source: '/in/e.mp4', output: '/out/r.mp4', frames: 322, rate: '24', factor: 1, scale: { width: 90, height: 160 } });
  assert.match(scaled[scaled.indexOf('-vf') + 1], /fps=24,scale=90:160:flags=lanczos,setsar=1/);

  assert.equal(editParts.listFileText(['/a/1.mp4', "/a/it's.mp4"]), "file '/a/1.mp4'\nfile '/a/it'\\''s.mp4'\n");
  const join = editParts.joinArgs({ list: '/l.txt', audioSource: '/in/v.mp4', output: '/o.mp4', seconds: 53.5 });
  assert.deepEqual(join.slice(join.indexOf('-map')), ['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'atrim=end=53.5,asetpts=PTS-STARTPTS,apad=whole_dur=53.5', '-t', '53.5', '-movflags', '+faststart', '/o.mp4']);
  const silent = editParts.joinArgs({ list: '/l.txt', audioSource: null, output: '/o.mp4', seconds: 53.5 });
  assert.equal(silent.includes('1:a:0'), false);
  assert.equal(silent.includes('-c:a'), false);

  for (const [text, expected] of [['', []], ['  ', []], ['2', [2]], ['2, 4', [2, 4]], ['4 2', [2, 4]], ['2;4;2', [2, 4]], ['10', [10]], ['abc', null], ['0', null], ['2-3', null], ['1.5', null], ['-1', null]]) {
    assert.deepEqual(editParts.parseRedoParts(text), expected, JSON.stringify(text));
  }
  assert.deepEqual(editParts.parseRedoParts(null), []);
  assert.deepEqual(editParts.parseRedoParts(undefined), []);
  console.log('   ok testRetimeAndArguments');
}

/* ---------- the slot of the engine ---------- */

async function testEngineSlot() {
  // several waits of one node (the parts) hand the slot back together and ask for it together: ONE permit comes back
  const semaphore = engine.createSemaphore(1);
  const slot = await engine.acquireSlot(semaphore);
  assert.equal(semaphore.active, 1);
  slot.release();
  slot.release();
  assert.equal(semaphore.active, 0, 'releasing twice gives one permit back');
  // somebody else takes the permit meanwhile; the three waits ask for it together
  const other = await engine.acquireSlot(semaphore);
  const asks = [slot.reacquire(), slot.reacquire(), slot.reacquire()];
  await sleep(10);
  assert.equal(semaphore.waiting, 1, 'one place in the queue, not three');
  other.release();
  await Promise.all(asks);
  assert.equal(slot.held, true);
  assert.equal(semaphore.active, 1, 'one permit is held for the three waits');
  assert.equal(semaphore.waiting, 0);
  slot.release();
  assert.equal(semaphore.active, 0, 'and it can be given back: nothing stays taken');
  // a reacquire that is aborted leaves nothing behind and a later one works
  const blocker = await engine.acquireSlot(semaphore);
  const controller = new AbortController();
  const aborted = slot.reacquire(controller.signal).then(() => 'taken', (err) => err.code || err.message);
  await sleep(5);
  controller.abort();
  assert.notEqual(await aborted, 'taken');
  assert.equal(semaphore.waiting, 0);
  assert.equal(slot.held, false);
  blocker.release();
  await slot.reacquire();
  assert.equal(slot.held, true);
  slot.release();
  assert.equal(semaphore.active, 0);
  console.log('   ok testEngineSlot');
}

/* ---------- the pipeline with the real ffmpeg ---------- */

async function ff(binary, args) {
  const { stdout } = await execFileAsync(binary, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function main() {
  testSplit();
  testPlanAndKey();
  testRetimeAndArguments();
  testLengthProblems();
  await testEngineSlot();

  const binaries = ffmpeg.binaries();
  if (!binaries.available) {
    console.log('ffmpeg not found: the pipeline tests are skipped');
    testTexts();
    console.log('test-video-edit-parts.js: ok');
    return;
  }
  const FFMPEG = binaries.ffmpeg;
  const FFPROBE = binaries.ffprobe;
  const probeText = async (args) => (await ff(FFPROBE, ['-v', 'error', ...args])).toString().trim();
  const framesOf = async (file) => Number(await probeText(['-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]));
  const durationOf = async (file, stream) => Number(await probeText(['-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]));
  const hasAudio = async (file) => (await probeText(['-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])) === 'audio';
  const sizeOf = async (file) => (await probeText(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file]));
  // the grey value of the picture at a time (one pixel: the mean of the picture)
  const lumaAt = async (file, seconds) => (await ff(FFMPEG, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']))[0];
  // the pitch of the sound in a window: zero crossings per second / 2
  const pitchAt = async (file, from, length) => {
    const pcm = await ff(FFMPEG, ['-v', 'error', '-ss', String(from), '-t', String(length), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    let crossings = 0;
    let previous = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const value = pcm.readInt16LE(offset);
      if (value !== 0 && previous !== 0 && value > 0 !== previous > 0) crossings += 1;
      if (value !== 0) previous = value;
    }
    return crossings / length / 2;
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-video-edit-parts-'));
  const sessions = [];
  try {
    const session = await store.createSession();
    sessions.push(session.id);
    const sessionId = session.id;
    const registry = createRegistry();
    nodesBasic.registerAll(registry);
    nodesFal.registerAll(registry);
    const def = registry.get(TYPE);
    const normalised = (rawParams) => registry.normalizeParams(def, rawParams);

    // the source: 53.5 s, 30 fps, 90 x 160 px, the grey value grows with the time; 440 Hz sound
    const makeSource = async (name, seconds, { audio = true, fps = 30 } = {}) => {
      const file = path.join(tmpDir, name);
      const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=90x160:r=${fps}:d=${seconds},geq=lum=255*T/${seconds}:cb=128:cr=128`];
      if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${seconds}`);
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15');
      if (audio) args.push('-c:a', 'aac', '-shortest');
      args.push(file);
      await ff(FFMPEG, args);
      return file;
    };
    const saveVideo = async (file) => {
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(file), ext: '.mp4', prompt: 'seed' });
      return assets.valueFromAsset(sessionId, saved.id);
    };
    const longFile = await makeSource('long.mp4', 53.5);
    assert.equal(await framesOf(longFile), 1605);
    const long = await saveVideo(longFile);
    const shortVideo = await saveVideo(await makeSource('short.mp4', 10));
    const silentLong = await saveVideo(await makeSource('silent.mp4', 53.5, { audio: false }));

    // The pictures are small to keep the test fast; the checks of the node (Kling takes 720 px and more) are told the size of a real clip.
    const ops = require('../lib/nodes/ffmpeg-ops');
    const realProbe = ops.probeMedia;
    patch(ops, 'probeMedia', async (file, options) => {
      const probe = await realProbe(file, options);
      return probe && probe.video && probe.video.width < 720 ? { ...probe, video: { ...probe.video, width: 720, height: 1280 } } : probe;
    });

    /* ----- the fake providers ----- */
    const falCalls = { upload: [], submit: [] };
    const copies = new Map(); // url -> a copy of the uploaded file
    let requestCounter = 0;
    const inputOfRequest = new Map(); // request id -> the url of its video (kept across the runs of the test)
    patch(fal, 'hasKey', () => true);
    patch(fal, 'uploadFile', async (file, options) => {
      const copy = path.join(tmpDir, `uploaded-${falCalls.upload.length}-${path.basename(file)}`);
      await fsp.copyFile(file, copy);
      const url = `https://v3b.fal.media/files/u${falCalls.upload.length}/${path.basename(file)}`;
      copies.set(url, copy);
      falCalls.upload.push({ file: path.basename(file), contentType: options.contentType, url });
      return { url, size: 4, contentType: options.contentType, fileName: options.fileName };
    });
    patch(fal, 'submit', async (endpoint, input) => {
      requestCounter += 1;
      inputOfRequest.set(`req-${requestCounter}`, input.video_url);
      falCalls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)), requestId: `req-${requestCounter}` });
      return {
        requestId: `req-${requestCounter}`,
        statusUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}/status`,
        responseUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}`
      };
    });
    const orPayloads = [];
    let orCounter = 0;
    const orCopies = new Map(); // job id -> the file that was published
    patch(or, 'hasKey', () => true);
    patch(or, 'listVideoModels', async () => ({ data: [] }));
    patch(discovery, 'listVideoModels', async () => ({ data: [] }));
    discovery.resetVideoModelCache();
    videoNodeModels.reset();
    withEnv('PUBLIC_BASE_URL', 'https://example.test');
    patch(or, 'createVideo', async (payload) => {
      orPayloads.push(JSON.parse(JSON.stringify(payload)));
      orCounter += 1;
      const url = payload.input_references[0].video_url.url;
      orCopies.set(`aleph-job-${orCounter}`, url);
      return { id: `aleph-job-${orCounter}`, status: 'pending' };
    });
    const publishedFiles = new Map(); // public file -> a copy
    patch(publicrefs, 'publishAsset', async (_session, assetId) => ({ url: `https://example.test/refs/${assetId}.mp4`, file: `${assetId}.mp4` }));
    patch(publicrefs, 'publishFile', async (_session, file) => {
      const copy = path.join(tmpDir, `published-${publishedFiles.size}-${path.basename(file)}`);
      await fsp.copyFile(file, copy);
      publishedFiles.set(path.basename(file), copy);
      publishedFiles.set(`https://example.test/refs/${path.basename(file)}`, copy);
      return { url: `https://example.test/refs/${path.basename(file)}`, file: path.basename(file) };
    });
    patch(publicrefs, 'removeRef', async () => true);

    // What the "model" returns for a part: the picture of the part stretched to its OWN length at ITS OWN rate (24 fps, Kling O3: 13.375 s =
    // 321 frames for every part, like the real model; the others, Aleph and Gemini Omni: 0.4 % longer than they got), and ITS OWN sound (1000 Hz).
    // lengthFactor: part number -> how long the "model" makes that part compared to the length it should have (1 = as usual)
    const behaviour = { failJob: new Set(), hangJob: new Set(), cost: 1, active: 0, maxActive: 0, delays: 0, lengthFactor: new Map() };
    const pathOfInput = async (job) => {
      if (inputOfRequest.has(job.jobId)) return copies.get(inputOfRequest.get(job.jobId));
      return publishedFiles.get(orCopies.get(job.jobId));
    };
    async function modelOutput(job) {
      const input = await pathOfInput(job);
      assert.ok(input, `the input of job ${job.jobId} is known`);
      const seconds = await durationOf(input, 'v:0');
      // Changed after the live test of 2026-10-04: every fal model returned 13.375 s (the length of Kling O3), also Gemini Omni for parts of
      // 8.9 s, which is 50 % off and is refused now (VIDEO_EDIT_PART_LENGTH). Only Kling O3 does that; the others come back about as long as they got.
      const fixed = /kling/.test(String(job.model));
      const number = Number((/part-(\d+)\.mp4$/.exec(input) || [])[1]);
      const own = (fixed ? 13.375 : seconds * 1.004) * (behaviour.lengthFactor.get(number) ?? 1);
      const frames = Math.round(own * 24);
      const out = path.join(tmpDir, `model-${job.jobId}.mp4`);
      await ff(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', input, '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=16000', '-vf', `setpts=(PTS-STARTPTS)*${own / seconds},fps=24`, '-frames:v', String(frames), '-r', '24', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
      return fsp.readFile(out);
    }
    const logs = [];
    const ctxFor = (overrides = {}) => {
      const controller = new AbortController();
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: {},
        forced: false,
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', emit() {} },
        log: (line) => logs.push(line),
        waitForJob: async (job) => {
          behaviour.active += 1;
          behaviour.maxActive = Math.max(behaviour.maxActive, behaviour.active);
          try {
            await sleep(30); // the jobs are really waited for side by side
            if (behaviour.hangJob.has(job.jobId)) throw new Error('node timed out (the job goes on at the provider)');
            if (behaviour.failJob.has(job.jobId)) {
              await store.mutateSession(sessionId, (s) => {
                const target = s.jobs.find((entry) => entry.jobId === job.jobId);
                target.status = 'failed';
                target.error = 'provider: the render failed';
              });
              throw new Error('provider: the render failed');
            }
            const known = (await store.readSession(sessionId)).jobs.find((entry) => entry.jobId === job.jobId);
            await store.completeAsset(sessionId, job.assetId, await modelOutput({ ...job, model: known.model }), behaviour.cost);
            await store.mutateSession(sessionId, (s) => {
              const target = s.jobs.find((entry) => entry.assetId === job.assetId);
              target.status = 'completed';
              target.resultAssetIds = [job.assetId];
            });
            return [job.assetId];
          } finally {
            behaviour.active -= 1;
          }
        },
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn(),
        ...overrides
      };
    };
    const prompt = textValue('Make the person older. Keep the Video as it is.');
    const run = (inputs, rawParams = {}, overrides = {}) => def.execute(ctxFor(overrides), inputs, normalised({ in_parts: true, ...rawParams }));
    const plan = (inputs, rawParams = {}) => nodesFal.planVideoEdit(ctxFor(), inputs, normalised({ in_parts: true, ...rawParams }), { allowParts: true });
    const scratchLeftovers = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith(assets.SCRATCH_PREFIX));
    const reset = () => {
      falCalls.upload.length = 0;
      falCalls.submit.length = 0;
      orPayloads.length = 0;
      logs.length = 0;
      behaviour.failJob.clear();
      behaviour.hangJob.clear();
      behaviour.lengthFactor.clear();
      behaviour.maxActive = 0;
    };
    const filmFile = (outcome) => assets.assetFilePath(outcome.variants[0].video);

    /* ----- the plan ----- */
    {
      reset();
      const planned = await plan({ video: long, prompt });
      assert.ok(planned.parts, 'a plan in parts');
      assert.equal(planned.parts.list.length, 4);
      assert.deepEqual(planned.parts.list.map((part) => part.frames), [402, 401, 401, 401]);
      assert.deepEqual(planned.parts.list.map((part) => part.number), [1, 2, 3, 4]);
      assert.equal(new Set(planned.parts.list.map((part) => part.key)).size, 4, 'a key for every part');
      near(planned.estimateUsd, 53.5 * 0.14, 'the price of 53.5 s at 0.14 USD', 1e-5);
      near(planned.parts.list.reduce((sum, part) => sum + part.usd, 0), 7.49, 'the sum of the parts', 1e-5);
      planned.parts.list.forEach((part) => near(part.usd, (part.frames / 30) * 0.14, 'the price of a part', 1e-6));
      assert.equal(planned.parts.source.totalFrames, 1605);
      near(planned.parts.source.fps, 30);
      assert.equal(planned.parts.source.hasAudio, true);
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0, 'planning pays and uploads nothing');
      assert.deepEqual(await scratchLeftovers(), []);

      // the price for the plan of the graph: the length only, 4 parts of equal length
      near(def.cost.estimate(normalised({ in_parts: true }), { inputs: { video: { type: 'video', duration: 53.5 } } }), 7.49, 'the plan of the graph', 1e-5);
      assert.equal(def.cost.estimate(normalised({ in_parts: true }), { inputs: { video: { type: 'video', duration: null } } }), null, 'a length that is not known has no price');
      // a video under the limit: the price of one run
      near(def.cost.estimate(normalised({ in_parts: true }), { inputs: { video: { type: 'video', duration: 8 } } }), 1.12);
      // without the switch the video is refused as before; with the cut the first seconds are priced
      reset();
      await assert.rejects(def.execute(ctxFor(), { video: long, prompt }, normalised({})), (err) => err.code === 'VIDEO_EDIT_VIDEO_TOO_LONG' && err.data.max === 15);
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0);
      // "in parts" wins over "cut to the allowed length"
      const both = await plan({ video: long, prompt }, { cut_to_limit: true });
      assert.ok(both.parts && both.parts.list.length === 4, 'in parts wins');
      assert.equal(both.trimmed, false);
      near(both.estimateUsd, 7.49, 'the whole video, not the first 15 s', 1e-5);
      // the models without a longest video have no parts: Wan Replace keeps its plan
      const wan = await nodesFal.planVideoEdit(ctxFor(), { video: shortVideo, images: { type: 'list', of: 'image', items: [await saveImageAsset(sessionId)] } }, normalised({ model: 'wan_replace', in_parts: true }), { allowParts: true });
      assert.equal(wan.parts, undefined);
      // a video under the limit stays ONE run
      const single = await plan({ video: shortVideo, prompt });
      assert.equal(single.parts, undefined, 'one run');
      assert.ok(single.endpoint, 'the plan of a single run');
      near(single.estimateUsd, 1.4, '10 s at 0.14', 1e-5);
      // the numbers for a part again are checked at once
      for (const [redo, code] of [['5', 'VIDEO_EDIT_PARTS_REDO_RANGE'], ['abc', 'VIDEO_EDIT_PARTS_REDO_INVALID'], ['2, 9', 'VIDEO_EDIT_PARTS_REDO_RANGE']]) {
        await assert.rejects(plan({ video: long, prompt }, { redo_parts: redo }), (err) => err.code === code, redo);
      }
      assert.deepEqual(plain((await plan({ video: long, prompt }, { redo_parts: '2, 4' })).parts.redo), [2, 4]);
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0);
      // validation of the node: the numbers, only where the switch is on
      const issues = (rawParams) => def.validate(normalised(rawParams), {}).map((issue) => issue.code);
      assert.ok(issues({ prompt: 'x', in_parts: true, redo_parts: 'abc' }).includes('VIDEO_EDIT_PARTS_REDO_INVALID'));
      assert.ok(!issues({ prompt: 'x', in_parts: true, redo_parts: '2' }).includes('VIDEO_EDIT_PARTS_REDO_INVALID'));
      assert.ok(!issues({ prompt: 'x', in_parts: false, redo_parts: 'abc' }).includes('VIDEO_EDIT_PARTS_REDO_INVALID'), 'off: the field is not looked at');
      assert.ok(!issues({ prompt: 'x', model: 'wan_replace', in_parts: true, redo_parts: 'abc' }).includes('VIDEO_EDIT_PARTS_REDO_INVALID'));
    }

    /* ----- the run: 53.5 s in four parts ----- */
    let firstKeys;
    let firstFilm;
    {
      reset();
      behaviour.cost = 1.2;
      const outcome = await run({ video: long, prompt });
      assert.equal(falCalls.submit.length, 4, 'one job for each part');
      assert.deepEqual(falCalls.upload.map((entry) => entry.file), ['part-1.mp4', 'part-2.mp4', 'part-3.mp4', 'part-4.mp4'], 'uploaded in order');
      assert.deepEqual(falCalls.submit.map((entry) => path.basename(entry.input.video_url)), ['part-1.mp4', 'part-2.mp4', 'part-3.mp4', 'part-4.mp4'], 'queued in order');
      // the same prompt and options for each part; the parts carry no sound, so nothing is kept
      for (const call of falCalls.submit) {
        assert.equal(call.endpoint, falCalls.submit[0].endpoint);
        assert.equal(call.input.prompt, 'Make the person older. Keep the @Video1 as it is.', 'the words of the prompt are translated once, for every part');
        assert.equal(call.input.prompt, falCalls.submit[0].input.prompt);
        assert.equal(call.input.keep_audio, false);
      }
      // each part as it was sent: the frames of its range, no sound, the size of the source
      const sent = [];
      for (const [index, call] of falCalls.submit.entries()) {
        const file = copies.get(call.input.video_url);
        sent.push(file);
        assert.equal(await framesOf(file), [402, 401, 401, 401][index], `part ${index + 1}: its frames`);
        assert.equal(await hasAudio(file), false, `part ${index + 1}: no sound`);
        assert.equal(await sizeOf(file), '90x160');
      }
      // the first picture of each part is the picture of the source at the start of the part (the grey value of the time)
      for (const [index, start] of [0, 402, 803, 1204].entries()) {
        const expected = await lumaAt(longFile, start / 30 + 1 / 60);
        const found = await lumaAt(sent[index], 1 / 60);
        assert.ok(Math.abs(found - expected) <= 6, `part ${index + 1} starts at frame ${start}: ${found} vs ${expected}`);
      }

      // the film: as long as the original, in order, with the sound of the original
      const film = filmFile(outcome);
      firstFilm = film;
      assert.equal(await framesOf(film), 1284, '53.5 s at 24 fps, to the frame');
      near(await durationOf(film, 'v:0'), 53.5, 'length of the picture', 0.05);
      assert.equal(await hasAudio(film), true);
      near(await durationOf(film, 'a:0'), 53.5, 'length of the sound', 0.06);
      assert.equal(await sizeOf(film), '90x160');
      const lumas = [];
      for (const seconds of [1, 8, 14, 20, 27, 33, 40, 47, 52.5]) {
        const expected = await lumaAt(longFile, seconds);
        const found = await lumaAt(film, seconds);
        lumas.push(found);
        assert.ok(Math.abs(found - expected) <= 9, `the picture at ${seconds} s is the picture of the original: ${found} vs ${expected}`);
      }
      assert.deepEqual([...lumas].sort((a, b) => a - b), lumas, 'the parts are in order');
      // the sound: the 440 Hz of the original over the whole film, never the 1000 Hz of the model, also at the joins (13.4 s, 26.8 s, 40.1 s)
      for (const from of [2, 12.9, 26.3, 39.6, 50]) {
        const pitch = await pitchAt(film, from, 1);
        assert.ok(Math.abs(pitch - 440) < 25, `the sound at ${from} s is the original (${Math.round(pitch)} Hz)`);
      }
      // the cost is the sum of the parts
      near(outcome.cost.usd, 4 * 1.2, 'the cost of the parts');
      // the jobs: the key of the part, the estimate of the part
      const jobs = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey);
      assert.equal(jobs.length, 4);
      firstKeys = jobs.map((job) => job.partKey);
      assert.equal(new Set(firstKeys).size, 4);
      jobs.forEach((job) => assert.match(job.partKey, /^ep1-[0-9a-f]{32}$/));
      near(jobs.reduce((sum, job) => sum + job.costEstimateUsd, 0), 7.49, 'the estimates of the parts add up to the plan', 1e-5);
      // side by side: all four waits were open at once
      assert.equal(behaviour.maxActive, 4, 'the parts run at the same time');
      assert.deepEqual(await scratchLeftovers(), [], 'no scratch folder left');
      assert.ok(logs.some((line) => /4 parts/.test(line)));
      assert.ok(logs.some((line) => /adjusted by/.test(line)), 'the retiming is logged');
    }

    /* ----- the same run again: everything is there, nothing is paid ----- */
    {
      const before = falCalls.submit.length;
      reset();
      const again = await run({ video: long, prompt });
      assert.equal(falCalls.submit.length, 0, 'no job: the parts are taken from the finished jobs');
      assert.equal(falCalls.upload.length, 0, 'nothing uploaded');
      assert.ok(before === 4);
      assert.equal(await framesOf(filmFile(again)), 1284);
      assert.equal(logs.filter((line) => /made before, no charge/.test(line)).length, 4);
      assert.equal(again.cost, undefined, 'no cost: nothing was paid this time');
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ----- one part again, all parts again, another prompt ----- */
    {
      reset();
      const one = await run({ video: long, prompt }, { redo_parts: '2' });
      assert.equal(falCalls.submit.length, 1, 'only part 2 is made again');
      assert.equal(path.basename(falCalls.submit[0].input.video_url), 'part-2.mp4');
      assert.equal(await framesOf(copies.get(falCalls.submit[0].input.video_url)), 401);
      assert.equal(await framesOf(filmFile(one)), 1284);
      near(one.cost.usd, 1.2, 'one part is paid');
      // the newest job of the part is the one that is used from now on: the next run takes it
      reset();
      await run({ video: long, prompt });
      assert.equal(falCalls.submit.length, 0);
      // "run again" (forced) with the field empty: every part is made again
      reset();
      const forced = await run({ video: long, prompt }, {}, { forced: true });
      assert.equal(falCalls.submit.length, 4, 'all parts again');
      assert.equal(await framesOf(filmFile(forced)), 1284);
      // forced with a list: only these
      reset();
      await run({ video: long, prompt }, { redo_parts: '1, 4' }, { forced: true });
      assert.deepEqual(falCalls.submit.map((call) => path.basename(call.input.video_url)), ['part-1.mp4', 'part-4.mp4']);
      // another prompt is another part: nothing is taken from the earlier jobs
      reset();
      await run({ video: long, prompt: textValue('Make it rain') });
      assert.equal(falCalls.submit.length, 4);
      // ... and so is another model or option
      reset();
      await run({ video: long, prompt }, { quality: 'pro' });
      assert.equal(falCalls.submit.length, 4, 'quality is part of the key');
      reset();
      await run({ video: long, prompt: textValue('Make it rain') });
      assert.equal(falCalls.submit.length, 0, 'the earlier prompt is still there');
      // errors in the numbers: before anything is cut, uploaded or paid
      reset();
      await assert.rejects(run({ video: long, prompt }, { redo_parts: '7' }), (err) => err.code === 'VIDEO_EDIT_PARTS_REDO_RANGE' && err.data.n === 7 && err.data.total === 4);
      await assert.rejects(run({ video: long, prompt }, { redo_parts: 'x' }), (err) => err.code === 'VIDEO_EDIT_PARTS_REDO_INVALID');
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0);
    }

    /* ----- a field with a part number stays in the node: the part is made ONCE for these numbers ----- */
    {
      const promptRedo = textValue('Redo case');
      reset();
      await run({ video: long, prompt: promptRedo });
      assert.equal(falCalls.submit.length, 4);
      reset();
      await run({ video: long, prompt: promptRedo }, { redo_parts: '2' });
      assert.equal(falCalls.submit.length, 1, 'part 2 is made again');
      const newest = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey).slice(-1)[0];
      assert.equal(newest.partRedo, '2', 'the job carries the numbers it was made for');
      assert.equal((await store.readSession(sessionId)).jobs.filter((job) => job.partKey).slice(-5, -1).every((job) => !job.partRedo), true, 'the other jobs of this video carry none');
      assert.ok(logs.some((line) => /a later run with the numbers 2 takes it as it is/.test(line)));
      // every later run of the node with the field unchanged (a changed option above, "Run all") pays nothing
      reset();
      const later = await run({ video: long, prompt: promptRedo }, { redo_parts: '2' });
      assert.equal(falCalls.submit.length, 0, 'the field still says 2: no second payment for part 2');
      assert.equal(later.cost, undefined);
      assert.ok(logs.some((line) => /already made again for these numbers/.test(line)));
      reset();
      await run({ video: long, prompt: promptRedo }, { redo_parts: '2', keep_audio: false });
      assert.equal(falCalls.submit.length, 0, 'also after a change of an option that is not part of a part');
      // other numbers make a part again; the numbers written in another way are the same numbers
      reset();
      await run({ video: long, prompt: promptRedo }, { redo_parts: '3' });
      assert.deepEqual(falCalls.submit.map((call) => path.basename(call.input.video_url)), ['part-3.mp4']);
      reset();
      await run({ video: long, prompt: promptRedo }, { redo_parts: ' 3; ' });
      assert.equal(falCalls.submit.length, 0, 'the same numbers');
      // "Run again" over the finished result makes the listed part once more (a third attempt for a part that is still not right)
      reset();
      await run({ video: long, prompt: promptRedo }, { redo_parts: '3' }, { forced: true, forcedSince: new Date(Date.now() + 1000).toISOString() });
      assert.deepEqual(falCalls.submit.map((call) => path.basename(call.input.video_url)), ['part-3.mp4']);
    }

    /* ----- "Run again": everything again over a finished result; after a failed run only what is missing ----- */
    {
      const promptAgain = textValue('Again case');
      reset();
      await run({ video: long, prompt: promptAgain });
      assert.equal(falCalls.submit.length, 4);
      const timeOfResult = new Date().toISOString();
      await sleep(15);
      // the engine says ctx.forced only over a finished result (test-nodes-engine-rerun.js); here the node: all parts older than it again
      reset();
      const failing = new Set([2]);
      const originalSubmit = fal.submit;
      let seenSubmits = 0;
      patch(fal, 'submit', async (endpoint, input) => {
        const result = await originalSubmit(endpoint, input);
        seenSubmits += 1;
        if (failing.has(seenSubmits)) behaviour.failJob.add(result.requestId);
        return result;
      });
      const failed = await run({ video: long, prompt: promptAgain }, {}, { forced: true, forcedSince: timeOfResult }).catch((err) => err);
      assert.equal(failed.code, 'VIDEO_EDIT_PARTS_FAILED');
      assert.equal(falCalls.submit.length, 4, 'every part was made again');
      // "Retry" under the error: the same finished result is still the one that was put aside; the three parts made after it are kept
      reset();
      failing.clear();
      behaviour.failJob.clear();
      const second = await run({ video: long, prompt: promptAgain }, {}, { forced: true, forcedSince: timeOfResult });
      assert.equal(falCalls.submit.length, 1, 'only the part that failed');
      assert.equal(path.basename(falCalls.submit[0].input.video_url), 'part-2.mp4');
      assert.equal(await framesOf(filmFile(second)), 1284);
      near(second.cost.usd, behaviour.cost, 'only the new part is paid');
      restorers.pop()();
      // and without a finished result (the engine passes forced:false) the failed run is simply gone on with
      reset();
      const promptNone = textValue('Never finished');
      const originalSubmit2 = fal.submit;
      let count2 = 0;
      patch(fal, 'submit', async (endpoint, input) => {
        const result = await originalSubmit2(endpoint, input);
        count2 += 1;
        if (count2 === 3) behaviour.failJob.add(result.requestId);
        return result;
      });
      const brokenOnce = await run({ video: long, prompt: promptNone }).catch((err) => err);
      assert.equal(brokenOnce.code, 'VIDEO_EDIT_PARTS_FAILED');
      restorers.pop()();
      reset();
      await run({ video: long, prompt: promptNone }, {}, { forced: false });
      assert.equal(falCalls.submit.length, 1, 'only part 3 again');
    }

    /* ----- a part fails: the finished ones are not paid again ----- */
    {
      reset();
      const prompt2 = textValue('Make it snow');
      // the third job of this run fails at the provider
      const originalSubmit = fal.submit;
      let count = 0;
      patch(fal, 'submit', async (endpoint, input) => {
        const result = await originalSubmit(endpoint, input);
        count += 1;
        if (count === 3) behaviour.failJob.add(result.requestId);
        return result;
      });
      const error = await run({ video: long, prompt: prompt2 }).catch((err) => err);
      assert.equal(error.code, 'VIDEO_EDIT_PARTS_FAILED', error.message);
      assert.deepEqual(plain(error.data), { failed: '3', total: 4, done: 3, reason: 'provider: the render failed' });
      assert.match(error.message, /Part 3 of 4 failed/);
      assert.match(error.message, /3 finished parts are kept/);
      assert.equal(falCalls.submit.length, 4, 'all four were started; the others went on');
      assert.deepEqual(await scratchLeftovers(), [], 'no scratch folder left after a failure');
      const finished = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey && job.status === 'completed');
      assert.ok(finished.length >= 3);
      // the next run: only part 3 is made; the other three cost nothing
      restorers.pop()();
      behaviour.failJob.clear();
      falCalls.submit.length = 0;
      falCalls.upload.length = 0;
      logs.length = 0;
      const second = await run({ video: long, prompt: prompt2 });
      assert.equal(falCalls.submit.length, 1, 'one job: only the part that failed');
      assert.equal(path.basename(falCalls.submit[0].input.video_url), 'part-3.mp4');
      near(second.cost.usd, 1.2, 'only the new part is paid');
      assert.equal(await framesOf(filmFile(second)), 1284);
      assert.equal(logs.filter((line) => /made before, no charge/.test(line)).length, 3);
      // and the film is as good as one made at once
      const lumasSecond = [];
      for (const seconds of [3, 20, 45]) lumasSecond.push(Math.abs((await lumaAt(filmFile(second), seconds)) - (await lumaAt(longFile, seconds))));
      assert.ok(lumasSecond.every((difference) => difference <= 9));
      assert.ok(Math.abs((await pitchAt(filmFile(second), 20, 1)) - 440) < 25);
    }

    /* ----- a run that was stopped: the running job is waited for, not started again ----- */
    {
      reset();
      const prompt3 = textValue('Make it foggy');
      const originalSubmit = fal.submit;
      let count = 0;
      patch(fal, 'submit', async (endpoint, input) => {
        const result = await originalSubmit(endpoint, input);
        count += 1;
        if (count === 2) behaviour.hangJob.add(result.requestId); // the run ends while this job is still open
        return result;
      });
      const error = await run({ video: long, prompt: prompt3 }).catch((err) => err);
      assert.equal(error.code, 'VIDEO_EDIT_PARTS_FAILED');
      assert.equal(error.data.failed, '2');
      restorers.pop()();
      behaviour.hangJob.clear();
      const open = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey && job.status === 'pending');
      assert.equal(open.length, 1, 'the job of part 2 is still open at the provider');
      falCalls.submit.length = 0;
      logs.length = 0;
      const outcome = await run({ video: long, prompt: prompt3 });
      assert.equal(falCalls.submit.length, 0, 'no second job and no second charge for the running part');
      assert.equal(logs.filter((line) => /still making it/.test(line)).length, 1);
      assert.equal(await framesOf(filmFile(outcome)), 1284);
      near(outcome.cost.usd, 1.2, 'the adopted part is the only one that was paid in this run');
    }

    /* ----- a deleted result is made again ----- */
    {
      reset();
      const prompt4 = textValue('Make it golden');
      await run({ video: long, prompt: prompt4 });
      const jobs = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey).slice(-4);
      await fsp.unlink(path.join(store.sessionAssetDir(sessionId), jobs[0].file));
      reset();
      await run({ video: long, prompt: prompt4 });
      assert.equal(falCalls.submit.length, 1, 'the part whose file is gone is made again');
      assert.equal(path.basename(falCalls.submit[0].input.video_url), 'part-1.mp4');
    }

    /* ----- a source without sound ----- */
    {
      reset();
      const outcome = await run({ video: silentLong, prompt });
      assert.equal(await hasAudio(filmFile(outcome)), false, 'no sound in the original: no sound in the film (the model\'s own is never used)');
      assert.equal(await framesOf(filmFile(outcome)), 1284);
    }

    /* ----- Kling without "keep original sound": a film without sound ----- */
    {
      reset();
      const outcome = await run({ video: long, prompt: textValue('Make it purple') }, { keep_audio: false });
      assert.equal(await hasAudio(filmFile(outcome)), false);
      assert.equal(falCalls.submit.every((call) => call.input.keep_audio === false), true);
    }

    /* ----- a video under the limit stays one run ----- */
    {
      reset();
      const outcome = await run({ video: shortVideo, prompt: textValue('Short run') });
      assert.equal(falCalls.submit.length, 1);
      assert.equal(falCalls.upload.length, 1, 'the video itself goes up as it is');
      assert.ok(!falCalls.upload[0].file.startsWith('part-'));
      assert.equal(falCalls.submit[0].input.keep_audio, true, 'a single run keeps the sound of the video as before');
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal('partKey' in job, false);
      assert.equal(outcome.variants[0].video.type, 'video');
    }

    /* ----- Gemini Omni: six parts of 10 s at the most ----- */
    {
      reset();
      const geminiPlan = await plan({ video: long, prompt }, { model: 'gemini_omni' });
      assert.equal(geminiPlan.parts.list.length, 6);
      assert.ok(geminiPlan.parts.list.every((part) => part.frames <= 298 && part.frames / 30 >= 1));
      assert.equal(geminiPlan.parts.list.reduce((sum, part) => sum + part.frames, 0), 1605);
      near(geminiPlan.estimateUsd, geminiPlan.parts.list.reduce((sum, part) => sum + part.usd, 0), 'sum', 1e-5);
      const outcome = await run({ video: long, prompt: textValue('Gemini parts') }, { model: 'gemini_omni' });
      assert.equal(falCalls.submit.length, 6);
      assert.ok(falCalls.submit.every((call) => !('keep_audio' in call.input)), 'Gemini Omni knows no keep_audio');
      assert.equal(await framesOf(filmFile(outcome)), 1284);
      assert.ok(Math.abs((await pitchAt(filmFile(outcome), 30, 1)) - 440) < 25, 'the sound of the original; Gemini has no switch for it, the original is used');
    }

    /* ----- Runway Aleph 2.0: parts of at most 30 s, through OpenRouter ----- */
    {
      reset();
      // 53.5 s are two parts of 803 and 802 frames (26.77 s and 26.73 s). A part is priced by its length above 5 s, an upper bound (the live
      // tests billed a flat 1.40 USD for 3 s and for 8 s), so the parts add up to 53.5 x 0.28 = 14.98 USD. Between the first live test and the
      // control run of 2026-10-04 a run took 5 s at the most: 53.5 s were eleven parts of 4.87 s, each billed as 5 s, 11 x 1.40 = 15.40 USD.
      const alephPlan = await plan({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph' });
      assert.equal(alephPlan.parts.list.length, 2);
      assert.deepEqual(alephPlan.parts.list.map((part) => part.frames), [803, 802]);
      assert.equal(alephPlan.parts.list.every((part) => part.seconds <= 29.95 && part.seconds >= 2), true, 'every part is a run of at most 30 s');
      near(alephPlan.estimateUsd, 53.5 * 0.28, 'Aleph: 0.28 per second over the whole length', 1e-5);
      assert.equal(alephPlan.parts.list.every((part) => part.usd >= 1.4), true, 'the 5 billed seconds (1.40 USD) are in the price of each part');
      // The key of an Aleph part is made of exactly these fields in this order (planEditParts, WP41): the paid parts of earlier runs are found
      // by it, so it must stay the same when another OpenRouter model joins the node
      alephPlan.parts.list.forEach((part) => {
        assert.equal(part.key, editParts.partKey({ via: 'openrouter', target: 'runway/aleph-2', input: { prompt: 'Aleph parts' }, media: [], source: long.assetId, rate: '30', longest: 30, from: part.startFrame, frames: part.frames }), `part ${part.number}`);
      });
      alephPlan.parts.list.forEach((part) => near(part.usd, (part.frames / 30) * 0.28, 'a part is priced by its length', 1e-6));
      // the plan of the graph (the length only) and the plan of the run (the frames) agree
      near(def.cost.estimate(normalised({ model: 'runway_aleph', in_parts: true }), { inputs: { video: { type: 'video', duration: 53.5 } } }), 14.98, 'the plan of the graph', 1e-5);
      near(def.cost.estimate(normalised({ model: 'runway_aleph', in_parts: true }), { inputs: { video: { type: 'video', duration: 5 } } }), 1.4, 'a video of one run stays one run');
      near(def.cost.estimate(normalised({ model: 'runway_aleph', in_parts: true }), { inputs: { video: { type: 'video', duration: 8 } } }), 2.24, 'a video of 8 s is one run, planned by its length');
      near(def.cost.estimate(normalised({ model: 'runway_aleph', in_parts: true }), { inputs: { video: { type: 'video', duration: 30.06 } } }), 8.4168, 'just over a run: two parts of 15.03 s', 1e-5);
      assert.equal(def.cost.estimate(normalised({ model: 'runway_aleph', in_parts: true }), { inputs: { video: { type: 'video', duration: null } } }), null, 'a length that is not known has no price');
      // "in parts" wins over "cut to the allowed length" for Aleph as for the others: the whole video, not its first 30 s
      const alephBoth = await plan({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph', cut_to_limit: true });
      assert.ok(alephBoth.parts && alephBoth.parts.list.length === 2, 'in parts wins');
      assert.equal(alephBoth.trimmed, false);
      near(alephBoth.estimateUsd, 14.98, 'the whole video, not the first 30 s', 1e-5);
      assert.deepEqual(await scratchLeftovers(), []);
      // the cut alone (the switch for the parts off) is the first 30 s: one run of 8.40 USD
      const alephCut = await plan({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph', in_parts: false, cut_to_limit: true });
      assert.equal(alephCut.parts, undefined);
      assert.equal(alephCut.trimmed, true);
      near(alephCut.estimateUsd, 8.4, 'the first 30 s');
      await alephCut.cleanup();
      // without either switch a video over 30 s is refused, with the length of Aleph
      await assert.rejects(def.execute(ctxFor(), { video: long, prompt: textValue('Aleph parts') }, normalised({ model: 'runway_aleph' })), (err) => err.code === 'VIDEO_EDIT_VIDEO_TOO_LONG' && err.data.max === 30);
      assert.equal(orPayloads.length, 0, 'nothing was paid');
      assert.deepEqual(await scratchLeftovers(), []);

      const outcome = await run({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph' });
      assert.equal(falCalls.submit.length, 0, 'not through fal');
      assert.equal(orPayloads.length, 2, 'one request for each part');
      for (const payload of orPayloads) {
        assert.equal(payload.model, 'runway/aleph-2');
        assert.equal(payload.prompt, 'Aleph parts');
        assert.equal(payload.input_references.length, 1);
        assert.equal(payload.input_references[0].type, 'video_url');
        assert.match(payload.input_references[0].video_url.url, /^https:\/\/example\.test\/refs\/.*part-[12]\.mp4$/);
        for (const field of ['duration', 'resolution', 'aspect_ratio']) assert.equal(field in payload, false);
      }
      // each part is a file of its own (the file that was cut), in order
      assert.deepEqual(orPayloads.map((payload, index) => payload.input_references[0].video_url.url.endsWith(`part-${index + 1}.mp4`)), [true, true]);
      const jobs = (await store.readSession(sessionId)).jobs.filter((job) => job.model === 'runway/aleph-2' && job.partKey).slice(-2);
      assert.equal(jobs.length, 2);
      jobs.forEach((job) => assert.match(job.partKey, /^ep1-/));
      // what each job reserved is what the plan priced its part at
      jobs.forEach((job, index) => near(job.estimateUsd, ([803, 802][index] / 30) * 0.28, 'the estimate of a part', 1e-6));
      near(jobs.reduce((sum, job) => sum + job.estimateUsd, 0), 14.98, 'the estimates of the parts add up to the plan', 1e-5);
      near(outcome.cost.usd, 2 * behaviour.cost, 'the cost of the parts');
      assert.equal(await framesOf(filmFile(outcome)), 1284, 'Aleph returns 0.4 % more than it got; the film still has the length of the original');
      assert.ok(Math.abs((await pitchAt(filmFile(outcome), 30, 1)) - 440) < 25);
      // the same again: nothing is paid
      orPayloads.length = 0;
      await run({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph' });
      assert.equal(orPayloads.length, 0);
      // a part again
      await run({ video: long, prompt: textValue('Aleph parts') }, { model: 'runway_aleph', redo_parts: '2' });
      assert.equal(orPayloads.length, 1);
      assert.match(orPayloads[0].input_references[0].video_url.url, /part-2\.mp4$/);
      // ... and the public addresses of the parts are published for the request only
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ----- FLUX Video Edit: parts of at most 15 s, through OpenRouter ----- */
    {
      reset();
      // 15 s per run (14.95 s a part, like Kling O3): 53.5 s are four parts of 402, 401, 401 and 401 frames. A part is priced by its length (0.03
      // USD per second; none is as short as the 5 billed seconds), so the parts add up to 53.5 x 0.03 = 1.605 USD.
      const fluxPlan = await plan({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit' });
      assert.deepEqual(fluxPlan.parts.list.map((part) => part.frames), [402, 401, 401, 401]);
      assert.equal(fluxPlan.parts.list.every((part) => part.seconds <= 14.95 && part.seconds >= 1), true, 'every part is a run of at most 15 s');
      near(fluxPlan.estimateUsd, 53.5 * 0.03, 'FLUX: 0.03 per second over the whole length', 1e-5);
      // the key of a part: the OpenRouter way with the model id of FLUX and 15 s as the longest part (the key of an Aleph part is pinned in
      // test-aleph-edit.js); the parts of the two models never share a key
      fluxPlan.parts.list.forEach((part) => {
        assert.equal(part.key, editParts.partKey({ via: 'openrouter', target: 'black-forest-labs/flux-video-edit', input: { prompt: 'FLUX parts' }, media: [], source: long.assetId, rate: '30', longest: 15, from: part.startFrame, frames: part.frames }), `part ${part.number}`);
      });
      // the plan of the graph (the length only) and the plan of the run (the frames) agree
      near(def.cost.estimate(normalised({ model: 'flux_video_edit', in_parts: true }), { inputs: { video: { type: 'video', duration: 53.5 } } }), 1.605, 'the plan of the graph', 1e-5);
      near(def.cost.estimate(normalised({ model: 'flux_video_edit', in_parts: true }), { inputs: { video: { type: 'video', duration: 5 } } }), 0.15, 'a video of one run stays one run');
      near(def.cost.estimate(normalised({ model: 'flux_video_edit', in_parts: true }), { inputs: { video: { type: 'video', duration: 15 } } }), 0.45, 'the longest run');
      near(def.cost.estimate(normalised({ model: 'flux_video_edit', in_parts: true }), { inputs: { video: { type: 'video', duration: 15.06 } } }), 0.4518, 'just over a run: two parts of 7.53 s', 1e-5);
      assert.equal(def.cost.estimate(normalised({ model: 'flux_video_edit', in_parts: true }), { inputs: { video: { type: 'video', duration: null } } }), null, 'a length that is not known has no price');
      // "in parts" wins over "cut to the allowed length": the whole video, not its first 15 s
      const fluxBoth = await plan({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit', cut_to_limit: true });
      assert.ok(fluxBoth.parts && fluxBoth.parts.list.length === 4, 'in parts wins');
      assert.equal(fluxBoth.trimmed, false);
      near(fluxBoth.estimateUsd, 1.605, 'the whole video, not the first 15 s', 1e-5);
      // the cut alone is the first 15 s: one run of 0.45 USD
      const fluxCut = await plan({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit', in_parts: false, cut_to_limit: true });
      assert.equal(fluxCut.parts, undefined);
      assert.equal(fluxCut.trimmed, true);
      near(fluxCut.estimateUsd, 0.45, 'the first 15 s');
      await fluxCut.cleanup();
      // without either switch a video over 15 s is refused, with the length of FLUX
      await assert.rejects(def.execute(ctxFor(), { video: long, prompt: textValue('FLUX parts') }, normalised({ model: 'flux_video_edit' })), (err) => err.code === 'VIDEO_EDIT_VIDEO_TOO_LONG' && err.data.max === 15 && err.data.model === 'FLUX Video Edit');
      assert.equal(orPayloads.length, 0, 'nothing was paid');
      assert.deepEqual(await scratchLeftovers(), []);

      const outcome = await run({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit' });
      assert.equal(falCalls.submit.length, 0, 'not through fal');
      assert.equal(orPayloads.length, 4, 'one request for each part');
      orPayloads.forEach((payload, index) => {
        assert.deepEqual(Object.keys(payload), ['model', 'prompt', 'input_references'], 'the request of a part: the same three fields as a single run');
        assert.equal(payload.model, 'black-forest-labs/flux-video-edit');
        assert.equal(payload.prompt, 'FLUX parts');
        assert.equal(payload.input_references.length, 1);
        assert.equal(payload.input_references[0].type, 'video_url');
        assert.match(payload.input_references[0].video_url.url, new RegExp(`^https://example\\.test/refs/.*part-${index + 1}\\.mp4$`));
      });
      const jobs = (await store.readSession(sessionId)).jobs.filter((job) => job.model === 'black-forest-labs/flux-video-edit' && job.partKey).slice(-4);
      assert.equal(jobs.length, 4);
      jobs.forEach((job) => assert.match(job.partKey, /^ep1-/));
      jobs.forEach((job) => assert.equal(job.modelName, 'FLUX Video Edit', 'the name of the model, not Aleph\'s'));
      assert.deepEqual(jobs.map((job) => job.partKey), fluxPlan.parts.list.map((part) => part.key));
      // what each job reserved is what the plan priced its part at
      jobs.forEach((job, index) => near(job.estimateUsd, ([402, 401, 401, 401][index] / 30) * 0.03, 'the estimate of a part', 1e-6));
      near(jobs.reduce((sum, job) => sum + job.estimateUsd, 0), 1.605, 'the estimates of the parts add up to the plan', 1e-5);
      near(outcome.cost.usd, 4 * behaviour.cost, 'the cost of the parts');
      assert.equal(await framesOf(filmFile(outcome)), 1284, 'the film has the length of the original');
      assert.ok(Math.abs((await pitchAt(filmFile(outcome), 30, 1)) - 440) < 25, 'the sound of the original lies over the film');
      // the same again: nothing is paid
      orPayloads.length = 0;
      await run({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit' });
      assert.equal(orPayloads.length, 0);
      // a part again
      await run({ video: long, prompt: textValue('FLUX parts') }, { model: 'flux_video_edit', redo_parts: '3' });
      assert.equal(orPayloads.length, 1);
      assert.match(orPayloads[0].input_references[0].video_url.url, /part-3\.mp4$/);
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ----- a part that comes back far from its length is not stretched (live test 2026-10-04) ----- */
    {
      // Every part is brought to the length of its input part. That is a correction for the small differences the models make (Kling
      // 13.375 s for 13.28 to 13.4 s, Aleph 0.4 % more): a part that is more than 10 % off would play too fast or too slow against the
      // original sound, so the node stops with VIDEO_EDIT_PART_LENGTH. The paid parts stay on their jobs, and "Make part again" names the bad part.
      // 60 s are three parts of 20 s with Aleph's 30 s per run (when Aleph took 5 s per run, a clip of 12 s was three parts of 4 s)
      const clip = await saveVideo(await makeSource('sixty.mp4', 60));
      const guardPrompt = textValue('Length guard');
      const saves = [];
      const overrides = { saveOutputFile: (options) => {
        saves.push(options);
        return assets.saveOutputFile(sessionId, options);
      } };
      reset();
      behaviour.lengthFactor.set(2, 0.6);
      const failed = await run({ video: clip, prompt: guardPrompt }, { model: 'runway_aleph' }, overrides).catch((err) => err);
      assert.equal(failed.code, 'VIDEO_EDIT_PART_LENGTH', failed.message);
      assert.deepEqual(plain(failed.data), { n: 2, found: '12.0', wanted: '20.0', percent: 10, redo: '2' });
      assert.match(failed.message, /Part 2 came back with 12\.0 s for the 20\.0 s that were sent/);
      assert.match(failed.message, /not stretched/);
      assert.match(failed.message, /write 2 in "Make part again \(number\)"/);
      assert.equal(orPayloads.length, 3, 'the three parts were made and paid');
      assert.equal(saves.length, 0, 'no film is saved');
      assert.deepEqual(await scratchLeftovers(), [], 'no scratch folder left');
      const kept = (await store.readSession(sessionId)).jobs.filter((job) => job.partKey && job.prompt === 'Length guard');
      assert.equal(kept.length, 3);
      assert.equal(kept.every((job) => job.status === 'completed' && job.resultAssetIds && job.resultAssetIds.length === 1), true, 'the paid parts are finished jobs');

      // run again with nothing changed: the parts are taken from the jobs, nothing is paid, and it is the same message (the part is still the same)
      reset();
      behaviour.lengthFactor.set(2, 0.6);
      const again = await run({ video: clip, prompt: guardPrompt }, { model: 'runway_aleph' }, overrides).catch((err) => err);
      assert.equal(again.code, 'VIDEO_EDIT_PART_LENGTH');
      assert.equal(again.data.n, 2);
      assert.equal(orPayloads.length, 0, 'no second payment for the parts that are there');
      assert.equal(logs.filter((line) => /made before, no charge/.test(line)).length, 3);
      assert.equal(saves.length, 0);

      // "Make part again" with the number of the message: only that part is paid, the film is complete
      reset();
      const fixed = await run({ video: clip, prompt: guardPrompt }, { model: 'runway_aleph', redo_parts: failed.data.redo }, overrides);
      assert.equal(orPayloads.length, 1, 'one request: part 2');
      assert.match(orPayloads[0].input_references[0].video_url.url, /part-2\.mp4$/);
      assert.equal(saves.length, 1);
      assert.equal(await framesOf(filmFile(fixed)), 1440, '60 s at 24 fps');
      near(fixed.cost.usd, behaviour.cost, 'only the new part is paid');
      assert.deepEqual(await scratchLeftovers(), []);

      // several bad parts: the first is named, all numbers are in the hint; a part too long is as bad as one too short
      const severalPrompt = textValue('Length guard several');
      reset();
      behaviour.lengthFactor.set(1, 1.3);
      behaviour.lengthFactor.set(3, 0.5);
      const several = await run({ video: clip, prompt: severalPrompt }, { model: 'runway_aleph' }, overrides).catch((err) => err);
      assert.equal(several.code, 'VIDEO_EDIT_PART_LENGTH');
      assert.equal(several.data.n, 1);
      assert.equal(several.data.found, '26.1');
      assert.equal(several.data.redo, '1, 3');
      assert.match(several.message, /write 1, 3 in/);
      assert.equal(orPayloads.length, 3);
      assert.equal(saves.length, 1, 'still only the one film of the run before');
      // both again at once
      reset();
      await run({ video: clip, prompt: severalPrompt }, { model: 'runway_aleph', redo_parts: several.data.redo }, overrides);
      assert.deepEqual(orPayloads.map((payload) => path.basename(payload.input_references[0].video_url.url)), ['part-1.mp4', 'part-3.mp4']);
      assert.equal(saves.length, 2);

      // a few per cent off is stretched as before (under the limit of 10 %): 8 % too long and 7 % too short
      const closePrompt = textValue('Length guard close');
      reset();
      behaviour.lengthFactor.set(1, 1.08);
      behaviour.lengthFactor.set(3, 0.93);
      const close = await run({ video: clip, prompt: closePrompt }, { model: 'runway_aleph' }, overrides);
      assert.equal(await framesOf(filmFile(close)), 1440, 'the film has the length of the original');
      assert.ok(logs.some((line) => /Part 1: the model returned 21\.\d\d s for 20\.00 s; the time is adjusted by/.test(line)), `the stretch is logged: ${logs.join(' | ')}`);
      assert.ok(logs.some((line) => /Part 3: the model returned 18\.\d\d s for 20\.00 s/.test(line)));
      assert.equal(saves.length, 3);

      // the same through fal (Kling, 4 parts): a part that is half as long is refused too, the known deviation of Kling (13.375 s) is not
      const klingPrompt = textValue('Length guard kling');
      reset();
      behaviour.lengthFactor.set(3, 0.5);
      const klingFailed = await run({ video: long, prompt: klingPrompt }, {}, overrides).catch((err) => err);
      assert.equal(klingFailed.code, 'VIDEO_EDIT_PART_LENGTH');
      assert.equal(klingFailed.data.n, 3);
      assert.equal(klingFailed.data.found, '6.7');
      assert.equal(klingFailed.data.wanted, '13.4');
      assert.equal(falCalls.submit.length, 4, 'all four parts were made');
      reset();
      const klingFixed = await run({ video: long, prompt: klingPrompt }, { redo_parts: '3' }, overrides);
      assert.equal(falCalls.submit.length, 1, 'only part 3 again');
      assert.equal(await framesOf(filmFile(klingFixed)), 1284);
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ----- the budget of a participant: the parts together, before the first one ----- */
    {
      reset();
      patch(access, 'viewerOf', () => ({ active: true, kind: 'participant', email: 'p@example.test' }));
      patch(budget, 'status', async () => ({ remainingUsd: 3, spentUsd: 0, limitUsd: 3 }));
      const error = await run({ video: long, prompt: textValue('Budget case') }).catch((err) => err);
      assert.equal(error.code, 'BUDGET_INSUFFICIENT');
      assert.equal(error.status, 402);
      near(error.estimateUsd, 7.49, 'the parts together', 1e-5);
      assert.match(error.messageDe, /nur noch \$3\.00/);
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0, 'nothing was cut, uploaded or paid');
      assert.deepEqual(await scratchLeftovers(), []);
      patch(budget, 'status', async () => ({ remainingUsd: 0, spentUsd: 3, limitUsd: 3 }));
      const used = await run({ video: long, prompt: textValue('Budget case') }).catch((err) => err);
      assert.equal(used.code, 'BUDGET_EXHAUSTED');
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0);
      restorers.pop()();
      restorers.pop()();
      restorers.pop()();
    }

    /* ----- a part that is too heavy for the model ----- */
    {
      reset();
      // Aleph takes 16 MB: a part over it is refused before it is uploaded (a sparse file stands for the cut)
      const realRun = ffmpeg.runProcess;
      patch(ffmpeg, 'runProcess', async (command, args, options) => {
        const result = await realRun(command, args, options);
        if (args.includes('-frames:v') && args.includes('-an') && args.includes('-maxrate')) await fsp.truncate(args[args.length - 1], 17 * 1024 * 1024);
        return result;
      });
      const error = await run({ video: long, prompt: textValue('Too heavy') }, { model: 'runway_aleph' }).catch((err) => err);
      assert.equal(error.code, 'VIDEO_EDIT_PART_TOO_HEAVY', error.message);
      assert.equal(error.data.max, 16);
      assert.equal(error.data.n, 1);
      assert.equal(orPayloads.length, 0);
      assert.deepEqual(await scratchLeftovers(), []);
      restorers.pop()();
      // the cut carries a ceiling for the bit rate for models with a size limit
      const maxrates = [];
      patch(ffmpeg, 'runProcess', async (command, args, options) => {
        if (args.includes('-maxrate')) maxrates.push(Number(args[args.indexOf('-maxrate') + 1]));
        return realRun(command, args, options);
      });
      await run({ video: long, prompt: textValue('Ceiling') }, { model: 'runway_aleph' });
      // two parts of 26.7 s (3 to 6 Mbit/s). From the first live test of 2026-10-04 until the control run there were eleven parts of 4.87 s (about 22 Mbit/s)
      assert.equal(maxrates.length, 2);
      assert.ok(maxrates.every((rate) => rate > 3000000 && rate < 6000000), `about 16 MB over 26.7 s: ${maxrates}`);
      restorers.pop()();
    }

    /* ----- a LATER part that is too heavy stops the run before the first part is paid ----- */
    {
      reset();
      const realRun = ffmpeg.runProcess;
      let cuts = 0;
      patch(ffmpeg, 'runProcess', async (command, args, options) => {
        const result = await realRun(command, args, options);
        if (args.includes('-frames:v') && args.includes('-an') && args.includes('-maxrate')) {
          cuts += 1;
          if (cuts === 2) await fsp.truncate(args[args.length - 1], 17 * 1024 * 1024);
        }
        return result;
      });
      const watched = [];
      const error = await run({ video: long, prompt: textValue('Second part too heavy') }, { model: 'runway_aleph' }, { watchJob: (job) => watched.push(job) }).catch((err) => err);
      assert.equal(error.code, 'VIDEO_EDIT_PART_TOO_HEAVY', error.message);
      assert.equal(error.data.n, 2);
      assert.equal(orPayloads.length, 0, 'part 1 was not started: nothing is paid for a film that cannot be finished');
      assert.equal(watched.length, 0);
      assert.deepEqual(await scratchLeftovers(), []);
      restorers.pop()();
      // the same through fal (Kling, 100 MB): a cut that fails on the third part starts nothing either
      reset();
      let cutsKling = 0;
      patch(ffmpeg, 'runProcess', async (command, args, options) => {
        if (args.includes('-frames:v') && args.includes('-an') && args.includes('-maxrate')) {
          cutsKling += 1;
          if (cutsKling === 3) throw new Error('disk full');
        }
        return realRun(command, args, options);
      });
      const cutError = await run({ video: long, prompt: textValue('Third part cannot be cut') }).catch((err) => err);
      assert.match(cutError.message, /part 3 could not be cut/);
      assert.equal(falCalls.upload.length + falCalls.submit.length, 0, 'nothing was uploaded or queued');
      restorers.pop()();
    }

    /* ----- jobs that were started belong to the run even if it fails before it waits for them ----- */
    {
      reset();
      const watched = [];
      const originalUpload = fal.uploadFile;
      let uploads = 0;
      patch(fal, 'uploadFile', async (file, options) => {
        uploads += 1;
        if (uploads === 3) throw new Error('upload broke off');
        return originalUpload(file, options);
      });
      const error = await run({ video: long, prompt: textValue('Third upload fails') }, {}, { watchJob: (job) => watched.push(job) }).catch((err) => err);
      assert.match(error.message, /upload broke off/);
      assert.equal(falCalls.submit.length, 2, 'two jobs were started');
      assert.equal(watched.length, 2, 'both are known to the run, so it can give them their share of the reservation');
      assert.deepEqual(watched.map((job) => typeof job.jobId), ['string', 'string']);
      restorers.pop()();
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ----- the reservation: what the plan did not cover is added to the run before the first part starts ----- */
    {
      const extended = [];
      const events = [];
      let participant = true;
      patch(access, 'viewerOf', () => (participant ? { active: true, kind: 'participant', email: 'p@example.test' } : { active: false, kind: 'local' }));
      patch(budget, 'status', async () => ({ remainingUsd: 50, spentUsd: 0, limitUsd: 50 }));
      patch(budget, 'begin', async () => budget.NOOP_GRANT);
      patch(budget, 'extendRun', (viewer, key, usd) => {
        extended.push({ key, usd: Math.round(usd * 1e6) / 1e6, submitsBefore: falCalls.submit.length });
        events.push('extend');
        return true;
      });
      const withRun = (reservedUsd) => ({ reservedUsd, toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', budgetKey: 'run:test', emit() {} } });
      // the plan knew nothing (an upload of unknown length): the sum of the parts is added, once, before anything is started
      reset();
      await run({ video: long, prompt: textValue('Reserve all') }, {}, withRun(0));
      assert.equal(extended.length, 1);
      assert.equal(extended[0].key, 'run:test');
      near(extended[0].usd, 7.49, 'the parts together', 1e-5);
      assert.equal(extended[0].submitsBefore, 0, 'before the first part');
      // the plan knew the whole price: nothing to add
      extended.length = 0;
      reset();
      await run({ video: long, prompt: textValue('Reserve none') }, {}, withRun(7.49));
      assert.equal(extended.length, 0);
      // the plan knew a part of it: the rest
      reset();
      await run({ video: long, prompt: textValue('Reserve rest') }, {}, withRun(5));
      near(extended[0].usd, 2.49, 'only the rest', 1e-5);
      // nothing to make (all parts are there): nothing is reserved
      extended.length = 0;
      reset();
      await run({ video: long, prompt: textValue('Reserve rest') }, {}, withRun(0));
      assert.equal(extended.length, 0, 'finished parts need no reservation');
      // a person without a budget reserves nothing
      participant = false;
      reset();
      await run({ video: long, prompt: textValue('No budget') }, {}, withRun(0));
      assert.equal(extended.length, 0);
      for (let index = 0; index < 4; index += 1) restorers.pop()();
    }

    /* ----- the length of an uploaded video is known to the plan ----- */
    {
      const scratch = await assets.createScratchDir(sessionId);
      const copy = path.join(scratch, 'upload.mp4');
      await fsp.copyFile(longFile, copy);
      const uploaded = await assets.saveUploadFile(sessionId, { sourceFile: copy, ext: '.mp4', name: 'long.mp4', duration: await assets.probeUploadSeconds(copy) });
      await assets.removeScratchDir(scratch);
      near(uploaded.duration, 53.5, 'the ledger holds the length of the upload', 0.1);
      near(def.cost.estimate(normalised({ in_parts: true }), { inputs: { video: uploaded } }), 7.49, 'the plan prices the parts of an upload', 1e-5);
      // a file that is no video has no length and the upload still works
      const notVideo = path.join(await assets.createScratchDir(sessionId), 'upload.mp4');
      await fsp.writeFile(notVideo, 'not a video');
      const bare = await assets.saveUploadFile(sessionId, { sourceFile: notVideo, ext: '.mp4', name: 'bad.mp4', duration: await assets.probeUploadSeconds(notVideo) });
      assert.equal('duration' in bare, false);
      await assets.removeScratchDir(path.dirname(notVideo));
    }

    /* ----- stopped runs ----- */
    {
      reset();
      const controller = new AbortController();
      controller.abort();
      const error = await def.execute(ctxFor({ signal: controller.signal }), { video: long, prompt: textValue('Stopped') }, normalised({ in_parts: true })).catch((err) => err);
      assert.ok(error instanceof Error);
      assert.equal(falCalls.submit.length, 0, 'a stopped run starts no paid job');
      assert.deepEqual(await scratchLeftovers(), []);
    }
  } finally {
    restoreAll();
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  testTexts();
  console.log('test-video-edit-parts.js: ok');
}

async function saveImageAsset(sessionId) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  return assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: png, ext: '.png', prompt: 'seed' })).id);
}

/* ---------- the texts ---------- */

function testTexts() {
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'nodes-fal.js'), 'utf8') + fs.readFileSync(path.join(root, 'lib', 'nodes', 'video-edit-parts.js'), 'utf8');
  const codes = [...new Set([...source.matchAll(/'(VIDEO_EDIT_[A-Z_]+)'/g)].map((match) => match[1]))];
  assert.ok(codes.includes('VIDEO_EDIT_PARTS_FAILED') && codes.includes('VIDEO_EDIT_PART_TOO_HEAVY') && codes.includes('VIDEO_EDIT_ALEPH_IMAGES'));
  assert.ok(codes.includes('VIDEO_EDIT_FLUX_IMAGES') && codes.includes('VIDEO_EDIT_PROMPT_TOO_LONG'), 'the codes of FLUX Video Edit are found and need a text');
  assert.ok(codes.includes('VIDEO_EDIT_PART_LENGTH'), 'the part that comes back far from its length has a code');
  const placeholders = (text) => [...new Set((String(text).match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))].sort();
  const expected = {
    VIDEO_EDIT_ALEPH_IMAGES: ['model'],
    VIDEO_EDIT_FLUX_IMAGES: ['model'],
    VIDEO_EDIT_PROMPT_TOO_LONG: ['found', 'max', 'model'],
    VIDEO_EDIT_VIDEO_FORMAT: ['format', 'formats', 'model'],
    VIDEO_EDIT_PUBLIC_URL: ['model'],
    VIDEO_EDIT_PARTS_FAILED: ['done', 'failed', 'reason', 'total'],
    VIDEO_EDIT_PARTS_REDO_INVALID: [],
    VIDEO_EDIT_PARTS_REDO_RANGE: ['n', 'total'],
    VIDEO_EDIT_PART_TOO_SHORT: ['found', 'min'],
    VIDEO_EDIT_PART_TOO_HEAVY: ['found', 'max', 'n'],
    VIDEO_EDIT_PART_LENGTH: ['found', 'n', 'percent', 'redo', 'wanted']
  };
  for (const code of codes) {
    for (const lang of ['de', 'en', 'es']) {
      const text = window.I18N[lang][`nodes.issue.${code}`];
      assert.ok(text, `${lang}: nodes.issue.${code} is written`);
      assert.equal(text.includes('ß'), false, `${lang}.${code}: no sharp s`);
      assert.equal(/\s{2,}|^\s|\s$/.test(text), false, `${lang}.${code}: no stray white space`);
      if (expected[code]) assert.deepEqual(placeholders(text), expected[code], `${lang}.${code}: placeholders`);
      assert.deepEqual(placeholders(text), placeholders(window.I18N.de[`nodes.issue.${code}`]), `${lang}.${code}: the same placeholders as German`);
    }
  }
  // the message of a part that came back far from its length names the field that makes it again, the way the field is called in that language
  for (const lang of ['de', 'en', 'es']) {
    assert.ok(window.I18N[lang]['nodes.issue.VIDEO_EDIT_PART_LENGTH'].includes(window.I18N[lang]['nodes.param.redo_parts']), `${lang}: VIDEO_EDIT_PART_LENGTH names the field`);
  }
  for (const key of ['nodes.param.in_parts', 'nodes.param.redo_parts', 'nodes.option.runway_aleph', 'nodes.option.flux_video_edit']) {
    for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][key] && window.I18N[lang][key].trim(), `${lang}: ${key}`);
  }
  assert.equal(window.I18N.de['nodes.param.in_parts'], 'Längere Videos in Teilen bearbeiten');
  assert.equal(window.I18N.en['nodes.param.in_parts'], 'Edit longer videos in parts');
  assert.equal(window.I18N.es['nodes.param.in_parts'], 'Editar vídeos más largos en partes');
  // the help says what to check: the joins and part by part, and how to make one part again
  for (const [lang, patterns] of Object.entries({ de: [/Übergängen/, /Teil für Teil/], en: [/joins/, /part by part/], es: [/uniones/, /parte por parte/] })) {
    const help = window.I18N[lang]['nodes.type.fal.video_edit.tip.3'];
    for (const pattern of patterns) assert.match(help, pattern, `${lang}: ${help}`);
  }
  console.log('   ok testTexts');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
