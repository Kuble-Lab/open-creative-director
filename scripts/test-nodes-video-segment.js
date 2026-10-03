'use strict';

// The node "Segment video" (fal.video_segment, lib/nodes/nodes-fal.js, lib/nodes/video-prep.js, WP33): SAM 3 on a video through
// fal.ai. What is covered:
//   - the definition: ports, options and their ranges, the three outputs and what each sends to the endpoint
//     (apply_mask, video_output_type), the price constant
//   - validation: no object, max_seconds out of range, nothing is uploaded or queued
//   - the preparation with real ffmpeg on small lavfi clips: cutting to max_seconds, the frame rate (60 -> 30, 24 stays),
//     the size (long side 1920, even sides), no sound, a video that fits goes up unchanged, a clip with a burst of frames
//   - the exact frame count and the price that follows (a started block of 16 frames counts as a whole)
//   - the upload of the prepared file: its checks (scratch folder of the session, size, type, cancellation, key), no leftovers
//   - the estimate of the plan with and without a known length, also over the API with a real workflow
//   - the extension of the result by its first bytes (WebM / MP4), also with no extension in the address, and that the
//     result is stored as it came (no re-encoding: the alpha channel of a WebM stays)
//
// A private copy of the app runs in a temp directory (own data folders, ephemeral port): nothing touches the real data.
// lib/fal.js is replaced by mocks and a fetch guard refuses everything except localhost, so nothing is paid and nothing
// leaves the machine. The clips are made here with ffmpeg (lavfi); the part that needs ffmpeg is skipped when it is missing.

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');

const { createIsolatedApp } = require('./support/isolated-app');

const execFileAsync = promisify(execFile);
const STAFF = 'staff1@staff.example.com';
const ADMIN = 'admin@example.com';
const P1 = 'p1@gmail.example';
const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} ${actual} !== ${expected}`.trim());

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

// Nothing but localhost may be reached, whatever a code path tries.
function guardFetch() {
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
  return {
    attempts,
    restore() {
      global.fetch = original;
    }
  };
}

const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });
const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

// The first bytes of the two containers a result can come in: an EBML header with the DocType "webm", and an ISO base media file.
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const FTYP = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2')]);

/* ---------- ffmpeg helpers (real files) ---------- */

let tools = null; // { ffmpeg, ffprobe } of the machine
async function ff(args) {
  await execFileAsync(tools.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
}

// What a file really is, counted by decoding.
async function probeFile(file) {
  const { stdout } = await execFileAsync(tools.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const [num, den] = String(video.avg_frame_rate).split('/').map(Number);
  return {
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    fps: den ? num / den : num,
    frames: Number(video.nb_read_frames),
    duration: Number(data.format.duration),
    pixFmt: video.pix_fmt,
    audio: data.streams.some((stream) => stream.codec_type === 'audio'),
    rotated: Array.isArray(video.side_data_list) && video.side_data_list.some((item) => item.rotation !== undefined && Number(item.rotation) !== 0),
    alpha: video.tags?.alpha_mode === '1'
  };
}

/* ---------- the texts ---------- */

function testTexts() {
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  const need = (lang, key) => {
    const value = window.I18N[lang][key];
    assert.ok(typeof value === 'string' && value.trim(), `${lang}: ${key}`);
    return value;
  };
  for (const lang of ['de', 'en', 'es']) {
    need(lang, 'nodes.type.fal.video_segment.label');
    need(lang, 'nodes.type.fal.video_segment.keywords');
    for (const code of ['SEGMENT_OBJECT_REQUIRED', 'SEGMENT_FFMPEG_MISSING']) need(lang, `nodes.issue.${code}`);
    for (const key of ['nodes.param.max_seconds', 'nodes.param.threshold', 'nodes.option.cutout', 'nodes.option.mask', 'nodes.option.cutout_black']) need(lang, key);
    for (const side of ['in', 'out']) need(lang, `nodes.portdesc.fal.video_segment.video.${side}`);
    // what the help has to say, in the help text and the tips together: price, limits, browsers, the mask
    const all = [need(lang, 'nodes.type.fal.video_segment.help'), need(lang, 'nodes.type.fal.video_segment.example'), ...[1, 2, 3].map((n) => need(lang, `nodes.type.fal.video_segment.tip.${n}`))].join(' ');
    for (const fact of ['0.005', '16', '0.075', '30', 'Safari', 'WebM']) assert.ok(all.includes(fact), `${lang}: the help names ${fact}`);
    assert.match(all, lang === 'de' ? /Schnittprogramm/ : lang === 'en' ? /editing software/ : /programas de edición/, `${lang}: the mask suits editing software`);
    assert.match(all, /1 (bis|to|a) 60/, `${lang}: the limit of max_seconds`);
    assert.equal(all.includes('ß'), false, `${lang}: no sharp s`);
  }
  assert.equal(window.I18N.de['nodes.type.fal.video_segment.label'], 'Video segmentieren');
  assert.equal(window.I18N.en['nodes.type.fal.video_segment.label'], 'Segment video');
  assert.equal(window.I18N.es['nodes.type.fal.video_segment.label'], 'Segmentar vídeo');
}

/* ---------- the pieces that need no ffmpeg ---------- */

function testDefinition({ registry, nodesFal, hasKeyRef, ffmpeg }) {
  const def = registry.get('fal.video_segment');
  assert.ok(def, 'fal.video_segment is registered');
  assert.equal(def.label, 'Segment video');
  assert.deepEqual([def.category, def.paid, def.async, def.experimental, def.cost.unit, def.cost.history], ['fal', true, true, true, 'usd', false]);
  assert.ok(def.timeoutMs > 95 * 60 * 1000, 'longer than the poller timeout');
  assert.deepEqual(def.inputs.map((port) => [port.id, port.type, port.required === true]), [['video', 'video', true]]);
  assert.deepEqual(def.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
  assert.deepEqual(def.params.map((param) => [param.id, param.kind]), [['object', 'text'], ['output', 'select'], ['max_seconds', 'integer'], ['threshold', 'number']]);
  assert.deepEqual(def.params.filter((param) => param.inline).map((param) => param.id), ['object', 'output']);
  assert.deepEqual(def.params.find((param) => param.id === 'output').options, ['cutout', 'mask', 'cutout_black']);
  const seconds = def.params.find((param) => param.id === 'max_seconds');
  const threshold = def.params.find((param) => param.id === 'threshold');
  assert.deepEqual([seconds.min, seconds.max], [1, 60]);
  assert.deepEqual([threshold.min, threshold.max], [0.1, 0.9]);
  assert.deepEqual(registry.normalizeParams(def, {}), { object: '', output: 'cutout', max_seconds: 10, threshold: 0.5 });
  // the registry holds numbers to their range before validate and execute see them
  const clamped = (raw) => registry.normalizeParams(def, raw);
  assert.equal(clamped({ max_seconds: 0 }).max_seconds, 1);
  assert.equal(clamped({ max_seconds: 100 }).max_seconds, 60);
  assert.equal(clamped({ max_seconds: 7.6 }).max_seconds, 8);
  assert.equal(clamped({ threshold: 0.05 }).threshold, 0.1);
  assert.equal(clamped({ threshold: 1 }).threshold, 0.9);
  for (const word of ['segment', 'mask', 'matte', 'cutout', 'rotoscope', 'roto', 'alpha', 'transparent', 'sam', 'sam 3', 'isolate', 'video', 'fal']) {
    assert.ok(def.keywords.includes(word), `keyword ${word}`);
  }
  // available with the key and with ffmpeg (the video is prepared locally); the missing key is named first
  const original = ffmpeg.binaries;
  try {
    ffmpeg.binaries = () => ({ available: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    hasKeyRef.value = false;
    assert.equal(registry.availability(def), 'FAL_KEY is not set');
    hasKeyRef.value = true;
    assert.equal(registry.availability(def), true);
    ffmpeg.binaries = () => ({ available: false });
    assert.equal(registry.availability(def), 'ffmpeg/ffprobe not found');
    hasKeyRef.value = false;
    assert.equal(registry.availability(def), 'FAL_KEY is not set');
  } finally {
    ffmpeg.binaries = original;
    hasKeyRef.value = true;
  }
  // it sits before the free node, and the price constant names its source
  const order = nodesFal.definitions.map((item) => item.type);
  assert.deepEqual(order.slice(-3), ['fal.remove_background', 'fal.video_segment', 'fal.model']);
  assert.deepEqual({ ...nodesFal.PRICES.videoSegment }, { endpoint: 'fal-ai/sam-3/video', usdPerBlock: 0.005, framesPerBlock: 16, fetched: '2026-10-03' });
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'nodes-fal.js'), 'utf8');
  const priceComment = source.slice(source.indexOf('// fal.video_segment: SAM 3 on video'), source.indexOf('videoSegment: Object.freeze'));
  assert.match(priceComment, /0\.005 USD per 16 frames/, 'the price constant has a source comment');
  assert.match(priceComment, /openapi\.json\?endpoint_id=fal-ai\/sam-3\/video/);
  // the new module is shipped with the open source app: no hosts, addresses or home directories in it
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'lib', 'nodes', 'video-prep.js'), 'utf8'), /kuble\.com|\.internal\b|\b10\.\d+\.\d+\.\d+\b|\/Users\/[a-z]/i);
}

function testIssues(nodesFal) {
  const good = { object: 'person', output: 'cutout', max_seconds: 10, threshold: 0.5 };
  assert.deepEqual(nodesFal.segmentIssues(good), []);
  const codes = (patch) => nodesFal.segmentIssues({ ...good, ...patch }).map((issue) => issue.code);
  // no object: nothing, blanks, only commas
  for (const object of ['', '   ', ' , ,, ', '，', undefined, null]) assert.deepEqual(codes({ object }), ['SEGMENT_OBJECT_REQUIRED'], JSON.stringify(object));
  assert.deepEqual(codes({ object: 'a'.repeat(200) }), []);
  assert.deepEqual(codes({ object: 'a'.repeat(201) }), ['invalid_param']);
  assert.deepEqual(codes({ output: 'nope' }), ['invalid_param']);
  for (const output of ['cutout', 'mask', 'cutout_black']) assert.deepEqual(codes({ output }), []);
  // max_seconds: a whole number from 1 to 60
  for (const max_seconds of [1, 10, 60]) assert.deepEqual(codes({ max_seconds }), [], String(max_seconds));
  for (const max_seconds of [0, -1, 61, 1000, 1.5, NaN, Infinity, '10', null, undefined]) {
    const issues = nodesFal.segmentIssues({ ...good, max_seconds });
    assert.deepEqual(issues.map((issue) => issue.code), ['invalid_param'], String(max_seconds));
    assert.match(issues[0].message, /max_seconds/);
  }
  for (const threshold of [0.1, 0.5, 0.9]) assert.deepEqual(codes({ threshold }), [], String(threshold));
  for (const threshold of [0.09, 0.91, 1, 0, NaN, '0.5', null, undefined]) {
    const issues = nodesFal.segmentIssues({ ...good, threshold });
    assert.deepEqual(issues.map((issue) => issue.code), ['invalid_param'], String(threshold));
    assert.match(issues[0].message, /threshold/);
  }
  // several problems are all listed, the object first
  assert.deepEqual(nodesFal.segmentIssues({ object: '', output: 'x', max_seconds: 0, threshold: 2 }).map((issue) => issue.code), ['SEGMENT_OBJECT_REQUIRED', 'invalid_param', 'invalid_param', 'invalid_param']);
  // what is sent as the prompt
  assert.equal(nodesFal.segmentObject(' person ,, cloth, '), 'person, cloth');
  assert.equal(nodesFal.segmentObject('red   car'), 'red car');
  assert.equal(nodesFal.segmentObject('person，dog'), 'person, dog');
  assert.equal(nodesFal.segmentObject(null), '');
}

function testPrices(nodesFal) {
  // a started block of 16 frames counts as a whole
  const table = [[1, 0.005], [16, 0.005], [17, 0.01], [32, 0.01], [33, 0.015], [48, 0.015], [49, 0.02], [240, 0.075], [241, 0.08], [300, 0.095], [1800, 0.565]];
  for (const [frames, usd] of table) near(nodesFal.segmentUsd(frames), usd, `${frames} frames`);
}

function testEstimate({ registry, nodesFal, typesLib }) {
  const def = registry.get('fal.video_segment');
  const estimate = (raw, context) => def.cost.estimate(registry.normalizeParams(def, raw), context);
  const withVideo = (value) => ({ inputs: { video: value } });
  const clip = (duration) => ({ type: 'video', sessionId: 's', assetId: 'vid-001', file: 'vid-001.mp4', ...(duration === undefined ? {} : { duration }) });

  // length unknown: max_seconds at 30 frames per second is the bound (10 s = 300 frames = 19 blocks)
  near(estimate({}, undefined), 0.095, 'no context');
  near(estimate({}, {}), 0.095, 'empty context');
  near(estimate({}, { inputs: {} }), 0.095, 'nothing known about the video');
  near(estimate({}, withVideo(clip())), 0.095, 'an upload has no stored length');
  near(estimate({ max_seconds: 1 }, undefined), 0.01, '1 s = 30 frames = 2 blocks');
  near(estimate({ max_seconds: 60 }, undefined), 0.565, '60 s = 1800 frames = 113 blocks');
  // length known: the shorter of the two counts
  near(estimate({}, withVideo(clip(2))), 0.02, '2 s = 60 frames = 4 blocks');
  near(estimate({ max_seconds: 1 }, withVideo(clip(2))), 0.01, 'max_seconds is shorter');
  near(estimate({}, withVideo(clip(30))), 0.095, 'a long video is cut at max_seconds');
  near(estimate({}, withVideo(clip(4.8))), 0.045, '4.8 s x 30 is exactly 144 frames, 9 blocks');
  // 496 / 30 x 30 comes out as 496.00000000000006 in floating point: still 31 blocks, not 32
  assert.ok((496 / 30) * 30 > 496, 'the float error this case is about');
  near(estimate({ max_seconds: 60 }, withVideo(clip(496 / 30))), 0.155, '496 frames = 31 blocks');
  near(estimate({ max_seconds: 60 }, withVideo(clip(992 / 30))), 0.31, '992 frames = 62 blocks');
  near(estimate({}, withVideo(clip(0.4))), 0.005, '12 frames, one block');
  // a list (the node runs once per item): the longest decides
  near(estimate({}, withVideo(typesLib.listValue('video', [clip(2), clip(5)]))), 0.05, 'the longest of two');
  near(estimate({}, withVideo(typesLib.listValue('video', [clip(2), clip()]))), 0.095, 'one without a length: the bound');
  near(estimate({}, withVideo(typesLib.listValue('video', []))), 0.095, 'an empty list');
  // nonsense lengths are not trusted
  for (const duration of [0, -3, NaN, Infinity, 'abc', null]) near(estimate({}, withVideo(clip(duration))), 0.095, `length ${duration}`);
  // never a guess from the last run of the node type, and nothing without a usable max_seconds
  assert.equal(def.cost.history, false);
  assert.equal(def.cost.estimate({ max_seconds: NaN }, undefined), null);
  assert.equal(def.cost.estimate({ max_seconds: 0 }, undefined), null);
  assert.equal(def.cost.estimate({}, undefined), null);
  // the bound is never below the price of any video it could stand for: sizes up to the limit
  for (const seconds of [1, 2, 3, 7, 10]) {
    for (let length = 0.5; length <= 15; length += 0.5) {
      const bound = estimate({ max_seconds: seconds }, withVideo(clip(length)));
      const frames = Math.floor(Math.min(length, seconds) * 30 + 1e-9);
      assert.ok(bound + 1e-9 >= nodesFal.segmentUsd(Math.max(1, frames)), `${seconds}/${length}`);
    }
  }
}

function testExtensionByBytes({ poller }) {
  assert.equal(poller.videoExtensionOf(EBML), '.webm');
  assert.equal(poller.videoExtensionOf(FTYP), '.mp4');
  assert.equal(poller.videoExtensionOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), '.webm', 'four bytes are enough');
  for (const box of ['moov', 'mdat', 'free', 'skip', 'wide']) {
    assert.equal(poller.videoExtensionOf(Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from(box), Buffer.alloc(8)])), '.mp4', `first box ${box}`);
  }
  for (const other of [Buffer.alloc(0), Buffer.from([0x1a, 0x45, 0xdf]), Buffer.from('<html>no</html>'), Buffer.from('RIFF....AVI '), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(32)]) {
    assert.equal(poller.videoExtensionOf(other), '', other.subarray(0, 8).toString('hex'));
  }
}

function testDecision({ videoPrep }) {
  const base = { codec: 'h264', width: 1280, height: 720, fps: 24, duration: 2, hasAudio: false, pixFmt: 'yuv420p', container: 'mov,mp4,m4a,3gp,3g2,mj2', rotated: false };
  const decide = (info = {}, options = {}) => videoPrep.decide({ ...base, ...info }, { maxSeconds: 10, extension: '.mp4', size: 1000, maxBytes: 90 * MB, ...options });
  const reasons = (info, options) => decide(info, options).reasons;

  // what fits goes up as it is
  assert.deepEqual(decide(), { unchanged: true, reasons: [], scale: null, capFps: false });
  assert.equal(decide({ fps: 30 }).unchanged, true);
  assert.equal(decide({ fps: 29.97 }).unchanged, true);
  assert.equal(decide({ fps: 30.0005 }).unchanged, true, 'a hair above 30 is 30');
  assert.equal(decide({ duration: 10 }).unchanged, true);
  assert.equal(decide({ width: 1920, height: 1080 }).unchanged, true);
  assert.equal(decide({ width: 1080, height: 1920 }).unchanged, true);
  // each of these alone makes a new file
  assert.deepEqual(reasons({ codec: 'hevc' }), ['format']);
  assert.deepEqual(reasons({ container: 'matroska,webm' }), ['format']);
  assert.deepEqual(reasons({}, { extension: '.webm' }), ['format']);
  assert.deepEqual(reasons({ pixFmt: 'yuv444p' }), ['pixel_format']);
  assert.deepEqual(reasons({ hasAudio: true }), ['audio']);
  assert.deepEqual(reasons({ rotated: true }), ['rotation']);
  assert.deepEqual(reasons({ duration: 10.5 }), ['duration']);
  assert.deepEqual(reasons({ duration: null }), ['duration']);
  assert.deepEqual(reasons({ fps: 60 }), ['fps']);
  assert.deepEqual(reasons({ fps: null }), ['fps'], 'a rate nobody can read is capped');
  assert.deepEqual(reasons({}, { size: 91 * MB }), ['bytes']);
  assert.equal(decide({ fps: 60 }).capFps, true);
  assert.equal(decide({ fps: 24, duration: 20 }).capFps, false, 'a lower rate is never raised');
  // sizes: the long side at most 1920, both sides even, the aspect ratio kept
  assert.deepEqual(decide({ width: 2560, height: 1440 }).scale, { width: 1920, height: 1080 });
  assert.deepEqual(decide({ width: 3840, height: 2160 }).scale, { width: 1920, height: 1080 });
  assert.deepEqual(decide({ width: 1080, height: 2400 }).scale, { width: 864, height: 1920 });
  assert.deepEqual(decide({ width: 1081, height: 1921 }).scale, { width: 1080, height: 1920 });
  assert.deepEqual(decide({ width: 641, height: 361 }).scale, { width: 642, height: 362 }, 'odd sides do not fit yuv420p');
  assert.deepEqual(reasons({ width: 2560, height: 1440 }), ['size']);
  assert.throws(() => decide({ width: 0, height: 0 }), /size of the video/);
  // several at once
  assert.deepEqual(reasons({ fps: 60, hasAudio: true, duration: 30, width: 3840, height: 2160 }), ['audio', 'duration', 'fps', 'size']);

  // the ffmpeg arguments: first seconds, rate only where it is capped, scale only where needed, no sound
  const args = videoPrep.buildArgs('in.mp4', 'out.mp4', { capFps: true, scale: { width: 1920, height: 1080 } }, { maxSeconds: 7 });
  assert.equal(args[args.indexOf('-filter_complex') + 1], '[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[out]');
  assert.equal(args[args.indexOf('-t') + 1], '7');
  assert.equal(args[args.indexOf('-i') + 1], 'in.mp4');
  assert.equal(args[args.length - 1], 'out.mp4');
  for (const flag of ['-an', '-maxrate', '-movflags']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  const plain = videoPrep.buildArgs('in.mp4', 'out.mp4', { capFps: false, scale: null }, { maxSeconds: 10 });
  assert.equal(plain[plain.indexOf('-filter_complex') + 1], '[0:v]setsar=1,format=yuv420p[out]');
  // the most frames a prepared video may have
  assert.deepEqual([1, 10, 60].map((seconds) => videoPrep.frameLimit(seconds)), [32, 302, 1802]);
  assert.equal(videoPrep.MAX_FPS, 30);
  assert.equal(videoPrep.MAX_EDGE, 1920);
}

/* ---------- main ---------- */

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const clipDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-segment-clips-'));
  try {
    await run(iso, clipDir);
  } finally {
    restoreAll();
    guard.restore();
    await iso.cleanup();
    await fsp.rm(clipDir, { recursive: true, force: true });
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('test-nodes-video-segment.js: ok');
}

async function run(iso, clipDir) {
  const store = iso.load('lib/store');
  const fal = iso.load('lib/fal');
  const ffmpeg = iso.load('lib/ffmpeg');
  const poller = iso.load('lib/poller');
  const jobs = iso.load('lib/nodes/jobs');
  const assets = iso.load('lib/nodes/assets');
  const costs = iso.load('lib/costs');
  const nodesFal = iso.load('lib/nodes/nodes-fal');
  const videoPrep = iso.load('lib/nodes/video-prep');
  const registryModule = iso.load('lib/nodes/registry');
  const typesLib = iso.load('lib/nodes/types');
  const budgetLib = iso.load('lib/budget');
  const registry = registryModule.registry;
  const api = (url, options = {}) => iso.request(url, options);

  /* ---------- the provider, replaced ---------- */

  const hasKeyRef = { value: true };
  const calls = { upload: [], submit: [], download: [] };
  const requests = new Map();
  let counter = 0;
  let scenario = null; // (input) -> result of the endpoint; default below
  let downloads = new Map(); // url -> bytes
  patch(fal, 'hasKey', () => hasKeyRef.value);
  // the uploaded file is looked at while it is still there: the node deletes its prepared copy right after the upload
  patch(fal, 'uploadFile', async (file, options) => {
    const probe = await probeFile(file).catch(() => null);
    const record = { path: file, name: path.basename(file), contentType: options.contentType, fileName: options.fileName, probe, bytes: (await fsp.stat(file)).size };
    record.url = `https://v3b.fal.media/files/up-${calls.upload.length + 1}/${record.name}`;
    calls.upload.push(record);
    return { url: record.url, size: record.bytes, contentType: options.contentType, fileName: options.fileName };
  });
  patch(fal, 'submit', async (endpoint, input) => {
    counter += 1;
    const requestId = `req-${counter}`;
    calls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)), requestId });
    requests.set(requestId, { endpoint, input });
    return { requestId, statusUrl: `https://queue.fal.run/${endpoint}/requests/${requestId}/status`, responseUrl: `https://queue.fal.run/${endpoint}/requests/${requestId}` };
  });
  patch(fal, 'getStatus', async () => ({ status: 'COMPLETED', queuePosition: null, error: null, errorType: null }));
  patch(fal, 'getResult', async (job) => {
    const request = requests.get(job.jobId);
    assert.ok(request, `a result for a job that was queued: ${job.jobId}`);
    return scenario ? scenario(request.input) : defaultResult();
  });
  patch(fal, 'downloadToFile', async (url, dest) => {
    calls.download.push(url);
    const bytes = downloads.get(url) || Buffer.from(`file ${url}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, bytes);
    return { bytes: bytes.length, contentType: 'application/octet-stream' };
  });
  // what the endpoint answered in the paid mini test: application/octet-stream, output.mp4 / output.webm
  const MP4_URL = 'https://v3b.fal.media/files/out/segmented/output.mp4';
  const defaultResult = () => ({ video: { url: MP4_URL, content_type: 'application/octet-stream', file_name: 'output.mp4', file_size: 100 }, boundingbox_frames_zip: null });
  const journal = [];
  const recordCost = costs.recordCost;
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return recordCost.call(costs, entry);
  });
  const resetCalls = () => {
    calls.upload.length = 0;
    calls.submit.length = 0;
    calls.download.length = 0;
    journal.length = 0;
    scenario = null;
    downloads = new Map();
  };
  const nothingSent = (message) => assert.deepEqual([calls.upload.length, calls.submit.length], [0, 0], message || 'nothing uploaded, nothing queued');

  /* ---------- the pieces that need no ffmpeg ---------- */

  testTexts();
  testDefinition({ registry, nodesFal, hasKeyRef, ffmpeg });
  testIssues(nodesFal);
  testPrices(nodesFal);
  testEstimate({ registry, nodesFal, typesLib });
  testExtensionByBytes({ poller });
  testDecision({ videoPrep });

  const session = await store.createSession();
  const sessionId = session.id;
  const sessionDir = store.sessionAssetDir(sessionId);
  let assetCounter = 0;
  async function asset(bytes, ext = '.mp4', owner = sessionId) {
    assetCounter += 1;
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes, ext, prompt: `seed ${assetCounter}` });
    return assets.valueFromAsset(owner, saved.id);
  }

  const def = registry.get('fal.video_segment');
  const params = (raw = {}) => registry.normalizeParams(def, { object: 'person', ...raw });
  const logs = [];
  const ctx = (owner = sessionId) => {
    const controller = new AbortController();
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId: owner,
      user: 'tester',
      config: {},
      signal: controller.signal,
      controller,
      toolCtx: { nodeView: true, sessionId: owner, config: {}, user: 'tester', emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      withLocalSlot: (fn) => fn(),
      // like the engine: the poller finishes the job, then the ids of the results come from the session
      waitForJob: async (job) => {
        const started = Date.now();
        for (;;) {
          await poller.pollOnce();
          const current = await store.readSession(owner);
          const record = current.jobs.find((entry) => entry.assetId === job.assetId);
          if (record && ['completed', 'failed'].includes(record.status)) break;
          if (Date.now() - started > 8000) throw new Error('the job did not finish');
        }
        return jobs.waitForSessionJob(owner, job.jobId, { assetId: job.assetId, signal: controller.signal, intervalMs: 20, timeoutMs: 8000 });
      }
    };
  };
  const plan = (video, raw, context = ctx()) => nodesFal.planVideoSegment(context, video ? { video } : {}, params(raw));
  const execute = (video, raw, context = ctx()) => def.execute(context, video ? { video } : {}, params(raw));
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  };
  const scratchLeft = async (owner = sessionId) => (await fsp.readdir(store.sessionAssetDir(owner))).filter((name) => name.startsWith('.nodes-'));
  const refused = async (video, raw, pattern, { code, context } = {}) => {
    resetCalls();
    const err = await errorOf(execute(video, raw, context));
    assert.ok(err, `refused: ${pattern}`);
    if (code) assert.equal(err.code, code, err.message);
    assert.match(err.message, pattern);
    nothingSent(String(pattern));
    assert.deepEqual(await scratchLeft(), [], 'no scratch folder is left');
    return err;
  };

  /* ---------- validation, before anything is touched ---------- */

  const stub = await asset(Buffer.from('not a video at all'));
  await refused(stub, { object: '' }, /Object|object/, { code: 'SEGMENT_OBJECT_REQUIRED' });
  await refused(stub, { object: ' , ' }, /object/, { code: 'SEGMENT_OBJECT_REQUIRED' });
  // raw values, as a caller outside the registry could hand them over (the registry clamps them before)
  for (const bad of [0, 61, 1.5, NaN]) {
    const err = await errorOf(nodesFal.planVideoSegment(ctx(), { video: stub }, { object: 'person', output: 'cutout', max_seconds: bad, threshold: 0.5 }));
    assert.match(err.message, /max_seconds/, String(bad));
  }
  const rawErr = await errorOf(nodesFal.planVideoSegment(ctx(), { video: stub }, { object: 'person', output: 'cutout', max_seconds: 10, threshold: 3 }));
  assert.match(rawErr.message, /threshold/);
  assert.match((await errorOf(nodesFal.planVideoSegment(ctx(), { video: stub }, { object: 'person', output: 'sepia', max_seconds: 10, threshold: 0.5 }))).message, /output/);
  nothingSent('raw values');
  await refused(null, {}, /connect the video/);
  // validate (the check before the run) says the same, with the same codes
  assert.deepEqual(def.validate(params({ object: '' }), {}).map((issue) => issue.code), ['SEGMENT_OBJECT_REQUIRED']);
  assert.deepEqual(def.validate(params(), {}), []);
  // a video of another workflow is refused
  const other = await store.createSession();
  try {
    const foreign = await asset(Buffer.from('x'), '.mp4', other.id);
    await refused(foreign, {}, /another session/);
  } finally {
    await store.deleteSession(other.id).catch(() => {});
  }
  // no key: the message of the other fal nodes
  hasKeyRef.value = false;
  await refused(stub, {}, /FAL_KEY/);
  hasKeyRef.value = true;
  // no ffmpeg: a clear message, nothing is paid
  patch(ffmpeg, 'binaries', () => ({ available: false }));
  const noTools = await refused(stub, {}, /ffmpeg and ffprobe are needed/, { code: 'SEGMENT_FFMPEG_MISSING' });
  assert.match(noTools.message, /Nothing was uploaded or charged/);
  restorers.pop()();

  tools = ffmpeg.binaries();
  if (!tools.available) {
    console.log('SKIP ffmpeg fehlt (nur die Teile ohne ffmpeg sind gelaufen)');
    return;
  }

  /* ---------- the clips (lavfi) ---------- */

  const clips = {};
  const make = async (name, { seconds, size = '640x360', rate = 24, sound = false, pixFmt = 'yuv420p', source = 'testsrc', extra = [] }) => {
    const file = path.join(clipDir, `${name}.mp4`);
    const input = source === 'testsrc' ? `testsrc=duration=${seconds}:size=${size}:rate=${rate}` : `color=c=0x336699:s=${size}:r=${rate}:d=${seconds}`;
    const args = ['-f', 'lavfi', '-i', input];
    if (sound) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=44100`);
    args.push('-c:v', 'libx264', '-pix_fmt', pixFmt);
    if (sound) args.push('-c:a', 'aac', '-shortest');
    await ff([...args, ...extra, file]);
    clips[name] = file;
    return file;
  };
  await make('fits', { seconds: 2, rate: 24 }); // MP4/H.264, 24 fps, 2 s, no sound: goes up as it is
  await make('fast', { seconds: 3, rate: 60, sound: true }); // 60 fps with sound
  await make('long24', { seconds: 4, rate: 24 });
  await make('big', { seconds: 1, rate: 24, size: '2560x1440', source: 'color' });
  await make('tall', { seconds: 1, rate: 24, size: '1080x2400', source: 'color' });
  // scaled to its odd size: the colour source of ffmpeg 6 rounds 641x361 down to even sides by itself
  await make('odd', { seconds: 1, rate: 24, pixFmt: 'yuv444p', source: 'color', extra: ['-vf', 'scale=641:361'] });
  await ff(['-display_rotation', '90', '-i', clips.long24, '-c', 'copy', path.join(clipDir, 'turned.mp4')]);
  clips.turned = path.join(clipDir, 'turned.mp4');
  // a burst of 45 frames per second for 2 s, then one frame per second: the average rate looks harmless
  await ff(['-f', 'lavfi', '-i', 'testsrc=d=2:r=45:s=160x90', '-f', 'lavfi', '-i', 'testsrc=d=8:r=1:s=160x90', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(clipDir, 'burst.mp4')]);
  clips.burst = path.join(clipDir, 'burst.mp4');

  const video = async (name) => asset(await fsp.readFile(clips[name]));
  const submitted = () => calls.submit[calls.submit.length - 1];
  const bytesOf = async (value) => fsp.readFile(path.join(store.sessionAssetDir(value.sessionId), value.file));

  // the clips are what the checks below say they are
  assert.deepEqual((({ fps, frames, audio }) => ({ fps, frames, audio }))(await probeFile(clips.fits)), { fps: 24, frames: 48, audio: false });
  assert.deepEqual((({ fps, frames, audio }) => ({ fps, frames, audio }))(await probeFile(clips.fast)), { fps: 60, frames: 180, audio: true });

  /* ---------- a video that fits goes up as it is ---------- */
  {
    resetCalls();
    const source = await video('fits');
    const planned = await plan(source, {});
    assert.deepEqual(planned.prepared, { unchanged: true, reasons: [], frames: 48 });
    assert.equal(planned.endpoint, 'fal-ai/sam-3/video');
    assert.equal(planned.kind, 'video');
    assert.equal(planned.pricing, null);
    near(planned.estimateUsd, 0.015, '48 frames = 3 blocks');
    assert.deepEqual(planned.media, [{ field: 'video_url', assetIds: [source.assetId], multiple: false }], 'the stored asset goes through the tool like any other media');
    assert.equal(planned.input.video_url, undefined);
    nothingSent('planning uploads nothing for an unchanged video');
    assert.deepEqual(await scratchLeft(), []);

    // the whole run: the tool uploads the stored file, the job is queued, the poller stores the result
    const outcome = await execute(source, {});
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0].name, source.file, 'the stored file itself, not a copy');
    assert.equal(calls.upload[0].contentType, 'video/mp4');
    assert.equal(calls.submit.length, 1);
    assert.equal(submitted().endpoint, 'fal-ai/sam-3/video');
    assert.deepEqual(submitted().input, { prompt: 'person', apply_mask: true, video_output_type: 'VP9 (.webm)', detection_threshold: 0.5, video_url: calls.upload[0].url });
    const result = outcome.variants[0].video;
    assert.equal(result.type, 'video');
    near(outcome.cost.usd, 0.015, 'booked: 48 frames');
    assert.equal(journal.length, 1);
    near(journal[0].cost, 0.015);
    assert.equal(journal[0].model, 'fal-ai/sam-3/video');
    assert.deepEqual(calls.download, [MP4_URL]);
    assert.ok(result.file.endsWith('.mp4'));
    assert.deepEqual(await scratchLeft(), []);
    assert.ok(logs.some((line) => /sent as it is: 48 frames/.test(line)), logs.join(' | '));
  }

  /* ---------- 60 fps with sound, 3 s, cut to 2 s: 30 fps, no sound, 60 frames ---------- */
  {
    resetCalls();
    const source = await video('fast');
    const planned = await plan(source, { max_seconds: 2 });
    assert.deepEqual(planned.prepared, { unchanged: false, reasons: ['audio', 'duration', 'fps'], frames: 60 });
    assert.equal(calls.upload.length, 1, 'the prepared copy is uploaded by the node');
    assert.deepEqual(planned.media, [], 'no media entry: the address is in the input');
    const up = calls.upload[0];
    assert.equal(planned.input.video_url, up.url);
    assert.equal(up.contentType, 'video/mp4');
    assert.equal(up.fileName, videoPrep.PREPARED_FILE);
    assert.notEqual(up.name, source.file, 'a copy, not the stored video');
    assert.equal(up.probe.fps, 30);
    assert.equal(up.probe.frames, 60);
    assert.ok(Math.abs(up.probe.duration - 2) < 0.1, `cut to 2 s, got ${up.probe.duration}`);
    assert.equal(up.probe.audio, false);
    assert.equal(up.probe.pixFmt, 'yuv420p');
    assert.equal(up.probe.codec, 'h264');
    assert.deepEqual([up.probe.width, up.probe.height], [640, 360]);
    near(planned.estimateUsd, 0.02, '60 frames = 4 blocks');
    assert.equal(calls.submit.length, 0, 'planning queues nothing');
    // the file is gone after the upload, and so is its folder
    assert.equal(fs.existsSync(up.path), false);
    assert.deepEqual(await scratchLeft(), []);
    // the source is untouched, and no extra asset appeared in the workflow
    assert.deepEqual(await fsp.readFile(path.join(sessionDir, source.file)), await fsp.readFile(clips.fast));
    const before = (await store.readLedger(sessionId)).length;
    await plan(source, { max_seconds: 2 });
    assert.equal((await store.readLedger(sessionId)).length, before, 'the prepared video never shows up as an asset');

    // the run books the price of the 60 frames
    resetCalls();
    const outcome = await execute(source, { max_seconds: 2 });
    near(outcome.cost.usd, 0.02, 'booked');
    assert.equal(submitted().input.video_url, calls.upload[0].url);
    near(journal[0].cost, 0.02);
    // the plan of the same options shows at least that much (3 s, cut to 2: 2 s x 30 fps)
    const bound = def.cost.estimate(params({ max_seconds: 2 }), { inputs: { video: { ...source, duration: 3 } } });
    assert.ok(bound + 1e-9 >= 0.02);
  }

  /* ---------- a lower frame rate stays; the cut ---------- */
  {
    resetCalls();
    const source = await video('long24');
    const planned = await plan(source, { max_seconds: 2 });
    assert.deepEqual(planned.prepared, { unchanged: false, reasons: ['duration'], frames: 48 });
    const up = calls.upload[0];
    assert.equal(up.probe.fps, 24, '24 fps stays 24');
    assert.equal(up.probe.frames, 48);
    assert.ok(Math.abs(up.probe.duration - 2) < 0.1);
    near(planned.estimateUsd, 0.015);
    // one second: 24 frames, two blocks
    resetCalls();
    near((await plan(source, { max_seconds: 1 })).estimateUsd, 0.01);
    assert.equal(calls.upload[0].probe.frames, 24);
    // the whole 4 s fit into max_seconds 10: nothing to cut, the file is sent as it is
    resetCalls();
    const whole = await plan(source, { max_seconds: 10 });
    assert.deepEqual(whole.prepared, { unchanged: true, reasons: [], frames: 96 });
    near(whole.estimateUsd, 0.03, '96 frames = 6 blocks');
    nothingSent('unchanged');
  }

  /* ---------- sizes ---------- */
  {
    resetCalls();
    let planned = await plan(await video('big'), {});
    assert.deepEqual(planned.prepared.reasons, ['size']);
    assert.deepEqual([calls.upload[0].probe.width, calls.upload[0].probe.height], [1920, 1080], '2560 x 1440 -> 1920 x 1080');
    assert.equal(calls.upload[0].probe.fps, 24);
    near(planned.estimateUsd, 0.01, '24 frames');
    resetCalls();
    planned = await plan(await video('tall'), {});
    assert.deepEqual([calls.upload[0].probe.width, calls.upload[0].probe.height], [864, 1920], 'the long side is 1920 in a portrait video too');
    resetCalls();
    planned = await plan(await video('odd'), {});
    assert.deepEqual(planned.prepared.reasons, ['pixel_format', 'size']);
    assert.deepEqual([calls.upload[0].probe.width, calls.upload[0].probe.height], [642, 362], 'even sides');
    assert.equal(calls.upload[0].probe.pixFmt, 'yuv420p');
    // a turned phone video is upright, without the rotation flag
    resetCalls();
    planned = await plan(await video('turned'), { max_seconds: 2 });
    assert.deepEqual(planned.prepared.reasons, ['rotation', 'duration']);
    assert.deepEqual([calls.upload[0].probe.width, calls.upload[0].probe.height, calls.upload[0].probe.rotated], [360, 640, false]);
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the exact count has the last word (a burst of frames) ---------- */
  {
    resetCalls();
    const source = await video('burst');
    const planned = await plan(source, { max_seconds: 2 });
    // the first two seconds hold about 90 frames although the rate on average is low: made again with the rate capped
    assert.deepEqual(planned.prepared.reasons, ['duration', 'frames']);
    assert.equal(planned.prepared.frames, 60);
    assert.equal(calls.upload[0].probe.frames, 60);
    near(planned.estimateUsd, 0.02);
    assert.ok(planned.prepared.frames <= videoPrep.frameLimit(2));
    // sent whole it is fine: 98 frames in under 10 s
    resetCalls();
    const whole = await plan(source, { max_seconds: 10 });
    assert.equal(whole.prepared.unchanged, true);
    assert.equal(whole.prepared.frames, 98);
    near(whole.estimateUsd, 0.035, '98 frames = 7 blocks');
  }

  /* ---------- the three outputs ---------- */
  {
    const source = await video('fits');
    const expected = {
      cutout: { apply_mask: true, video_output_type: 'VP9 (.webm)' },
      mask: { apply_mask: false, video_output_type: 'X264 (.mp4)' },
      cutout_black: { apply_mask: true, video_output_type: 'X264 (.mp4)' }
    };
    assert.deepEqual(JSON.parse(JSON.stringify(nodesFal.SEGMENT_OUTPUTS)), expected);
    for (const [output, fields] of Object.entries(expected)) {
      resetCalls();
      const planned = await plan(source, { output, object: ' person ,, cloth, ', threshold: 0.3 });
      assert.deepEqual(
        planned.input,
        { prompt: 'person, cloth', ...fields, detection_threshold: 0.3 },
        output
      );
      for (const unused of ['point_prompts', 'box_prompts', 'text_prompt']) assert.equal(unused in planned.input, false, `${unused} is not sent`);
    }
    // through the tool: what is queued is that input plus the address
    resetCalls();
    await execute(source, { output: 'mask', object: 'dog' });
    assert.deepEqual(submitted().input, { prompt: 'dog', apply_mask: false, video_output_type: 'X264 (.mp4)', detection_threshold: 0.5, video_url: calls.upload[0].url });
  }

  /* ---------- the upload of the prepared file, and what it checks ---------- */
  {
    const source = await video('fast');
    const real = videoPrep.prepareVideo;
    const withPrepared = async (make, pattern) => {
      resetCalls();
      patch(videoPrep, 'prepareVideo', async (options) => make(await real(options), options));
      try {
        const err = await errorOf(execute(source, { max_seconds: 2 }));
        assert.ok(err, `refused: ${pattern}`);
        assert.match(err.message, pattern);
        nothingSent(String(pattern));
        assert.deepEqual(await scratchLeft(), [], 'the scratch folder is removed');
      } finally {
        restorers.pop()();
      }
    };
    // a file that is not in a scratch folder of this session (the stored source itself, which is no copy)
    await withPrepared((prepared) => ({ ...prepared, unchanged: false, file: path.join(sessionDir, source.file) }), /scratch folder of this workflow/);
    // a file somewhere else on the disk
    await withPrepared((prepared) => ({ ...prepared, unchanged: false, file: clips.fits }), /scratch folder of this workflow/);
    // a file in a scratch folder of ANOTHER session
    const foreignSession = await store.createSession();
    try {
      const foreignScratch = await assets.createScratchDir(foreignSession.id);
      await fsp.copyFile(clips.fits, path.join(foreignScratch, 'prepared-video.mp4'));
      await withPrepared((prepared) => ({ ...prepared, unchanged: false, file: path.join(foreignScratch, 'prepared-video.mp4') }), /scratch folder of this workflow/);
    } finally {
      await store.deleteSession(foreignSession.id).catch(() => {});
    }
    // a link in the scratch folder, pointing at a real file
    await withPrepared(async (prepared, options) => {
      const link = path.join(options.scratch, 'link.mp4');
      await fsp.symlink(clips.fits, link);
      return { ...prepared, unchanged: false, file: link };
    }, /prepared file is missing/);
    // a type the tool would not upload
    await withPrepared(async (prepared, options) => {
      const file = path.join(options.scratch, 'prepared-video.mov');
      await fsp.copyFile(prepared.file, file);
      return { ...prepared, unchanged: false, file };
    }, /cannot be uploaded/);
    // too big (the size limit of the tool) and too many frames for the options
    await withPrepared((prepared) => ({ ...prepared, bytes: 91 * MB }), /at most 90 MB/);
    await withPrepared((prepared) => ({ ...prepared, frames: 9999 }), /more than 2 s at 30 frames per second allow/);
  }

  /* ---------- cancelled before and during the run, a broken file ---------- */
  {
    resetCalls();
    const source = await video('fast');
    const context = ctx();
    context.controller.abort();
    const err = await errorOf(execute(source, { max_seconds: 2 }, context));
    assert.ok(err && /abort|cancel/i.test(`${err.name} ${err.message}`), String(err));
    nothingSent('cancelled before the start');
    assert.deepEqual(await scratchLeft(), []);

    // cancelled while the preparation is done: the upload is not made
    resetCalls();
    const real = videoPrep.prepareVideo;
    const late = ctx();
    patch(videoPrep, 'prepareVideo', async (options) => {
      const prepared = await real(options);
      late.controller.abort();
      return prepared;
    });
    const lateErr = await errorOf(execute(source, { max_seconds: 2 }, late));
    restorers.pop()();
    assert.ok(lateErr && /abort|cancel/i.test(`${lateErr.name} ${lateErr.message}`), String(lateErr));
    nothingSent('cancelled after the preparation');
    assert.deepEqual(await scratchLeft(), []);

    // a file that is no video: a short message, nothing sent, nothing left behind
    resetCalls();
    const broken = await asset(Buffer.from('this is not a video file at all'));
    const brokenErr = await errorOf(execute(broken, {}));
    assert.match(brokenErr.message, /^video: the file could not be analysed/);
    assert.ok(brokenErr.message.length < 260, 'a short message');
    nothingSent('a file that is no video');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the extension of the result, by its first bytes ---------- */
  {
    // real containers: an H.264 MP4 and a VP9 WebM with an alpha channel (when this ffmpeg can make one)
    const mp4Bytes = await fsp.readFile(clips.fits);
    let webmBytes = null;
    try {
      await ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=160x90:r=10:d=1,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', path.join(clipDir, 'alpha.webm')]);
      webmBytes = await fsp.readFile(path.join(clipDir, 'alpha.webm'));
      assert.equal((await probeFile(path.join(clipDir, 'alpha.webm'))).alpha, true, 'the sample has an alpha channel');
    } catch (err) {
      webmBytes = null;
      console.log(`SKIP no VP9 encoder for a WebM sample (${String(err.message).split('\n')[0]}); the header bytes are used instead`);
    }
    const webm = webmBytes || Buffer.concat([EBML, Buffer.alloc(200)]);
    assert.equal(poller.videoExtensionOf(webm.subarray(0, 16)), '.webm');
    assert.equal(poller.videoExtensionOf(mp4Bytes.subarray(0, 16)), '.mp4');

    const source = await video('fits');
    const media = (url, extra = {}) => ({ kind: 'video', url, contentType: 'application/octet-stream', ...extra });
    const tmp = path.join(clipDir, 'download.part');
    const nameOf = async (media, contentType, bytes) => {
      await fsp.writeFile(tmp, bytes);
      return poller.falResultExtension(media, contentType, tmp);
    };
    // no extension in the address, no usable content type: the bytes decide
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/segmented/output'), 'application/octet-stream', webm), '.webm');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/segmented/output'), 'application/octet-stream', mp4Bytes), '.mp4');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/segmented/output?token=abc'), '', webm), '.webm');
    // a wrong hint loses against the bytes, in both directions
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/output.mp4', { contentType: 'video/mp4' }), 'video/mp4', webm), '.webm');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/output.webm', { contentType: 'video/webm' }), 'video/webm', mp4Bytes), '.mp4');
    // bytes that say nothing: the content type, then the address, then .mp4 as before
    const noise = Buffer.from('<html>not a video</html>');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/output', { contentType: 'video/webm' }), '', noise), '.webm');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/output.webm'), 'application/octet-stream', noise), '.webm');
    assert.equal(await nameOf(media('https://v3b.fal.media/files/out/output'), 'application/octet-stream', noise), '.mp4');
    // other kinds are not looked at
    assert.equal(await nameOf({ kind: 'image', url: 'https://v3b.fal.media/files/out/x', contentType: 'image/png' }, '', webm), '.png');
    assert.equal(await nameOf({ kind: 'audio', url: 'https://v3b.fal.media/files/out/x', contentType: '' }, '', webm), '.wav');
    // the file is not there: the hints decide, no crash
    assert.equal(await poller.falResultExtension(media('https://v3b.fal.media/files/out/output.webm'), '', path.join(clipDir, 'missing.part')), '.webm');

    // the whole way for a WebM without any extension in the address: stored as .webm, byte for byte (no re-encoding)
    const BARE = 'https://v3b.fal.media/files/out/segmented/output';
    for (const [bytes, expectedExt] of [[webm, '.webm'], [mp4Bytes, '.mp4']]) {
      resetCalls();
      downloads.set(BARE, bytes);
      scenario = () => ({ video: { url: BARE, content_type: 'application/octet-stream', file_name: expectedExt === '.webm' ? 'output.webm' : 'output.mp4' } });
      const outcome = await execute(source, {});
      const stored = outcome.variants[0].video;
      assert.ok(stored.file.endsWith(expectedExt), `${stored.file} is ${expectedExt}`);
      assert.deepEqual(await bytesOf(stored), bytes, 'stored as it came');
      assert.equal(stored.url.endsWith(expectedExt), true);
      const entry = (await store.readLedger(sessionId)).find((item) => item.id === stored.assetId);
      assert.deepEqual([entry.kind, entry.file], ['video', stored.file]);
      if (expectedExt === '.webm' && webmBytes) {
        assert.equal((await probeFile(path.join(sessionDir, stored.file))).alpha, true, 'the alpha channel is still there');
      }
    }
    resetCalls();
  }

  /* ---------- in a workflow, over the API: the plan with and without a known length, a full run ---------- */
  {
    const stop = { value: false };
    // the poller runs in the background, like on the server
    const pump = (async () => {
      while (!stop.value) {
        await poller.pollOnce().catch(() => {});
        await sleep(100);
      }
    })();
    try {
      const call = (method, url, json, extra = {}) => api(url, { method, as: STAFF, json, ...extra });
      const created = (await call('POST', '/api/workflows', { name: 'Freisteller' })).body.workflow;
      const seed = (name) => asset(fs.readFileSync(clips[name]), '.mp4', created.sessionId);
      // an upload has no stored length; a video made by an earlier node has one
      const uploaded = await seed('fits');
      const measured = await (async () => {
        const hidden = path.join(store.sessionAssetDir(created.sessionId), '.seed-measured.mp4');
        await fsp.copyFile(clips.fits, hidden);
        return assets.saveOutputFile(created.sessionId, { kind: 'video', ext: '.mp4', sourceFile: hidden, duration: 2.5 });
      })();
      assert.equal(uploaded.duration, undefined);
      assert.equal(measured.duration, 2.5);
      let rev = 1;
      const save = async (graph) => {
        const response = await call('PUT', `/api/workflows/${created.id}`, { baseRev: rev, graph: { ...graph, groups: [], notes: [] } });
        assert.equal(response.status, 200, response.text);
        rev = response.body.rev;
      };
      const input = (id, value, y) => node(id, 'input.video', { asset: { assetId: value.assetId, sessionId: created.sessionId } }, 0, y);
      const segment = (extra = {}) => node('s', 'fal.video_segment', { object: 'person', ...extra }, 300, 0);
      const planNow = async () => (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      const finish = async (runId) => {
        const started = Date.now();
        for (;;) {
          const record = (await call('GET', `/api/workflows/${created.id}/runs/${runId}`)).body;
          if (record && record.status !== 'running') return record;
          assert.ok(Date.now() - started < 60000, 'the run finishes');
          await sleep(100);
        }
      };
      const start = async (body) => {
        for (let i = 0; i < 100 && (await call('GET', `/api/workflows/${created.id}`)).body.activeRun; i += 1) await sleep(50);
        const response = await call('POST', `/api/workflows/${created.id}/runs`, body);
        assert.equal(response.status, 202, response.text);
        return finish(response.body.runId);
      };

      // 1. the video comes from a node that has not run yet: its length is not known, the bound is max_seconds
      await save({ nodes: [input('v', measured, 0), segment(), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)], edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')] });
      let planned = await planNow();
      assert.equal(planned.valid, true, JSON.stringify(planned.issues));
      near(planned.nodes.s.estimate.usd, 0.095, 'the upstream node is not up to date: 10 s at 30 fps');
      assert.equal(planned.totals.unknownNodes, 0);
      near(planned.totals.usd, 0.095);

      // 2. the upstream node has run: its stored length (2.5 s = 75 frames = 5 blocks) is used
      const upstream = await start({ mode: 'node', nodeIds: ['v'] });
      assert.equal(upstream.status, 'completed', JSON.stringify(upstream).slice(0, 400));
      planned = await planNow();
      near(planned.nodes.s.estimate.usd, 0.025, 'known length 2.5 s');
      near(planned.totals.usd, 0.025);
      // max_seconds shorter than the video
      await save({ nodes: [input('v', measured, 0), segment({ max_seconds: 1 }), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)], edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')] });
      near((await planNow()).nodes.s.estimate.usd, 0.01, 'max_seconds 1 = 30 frames');

      // 3. an upload has no stored length: the bound again
      await save({ nodes: [input('v', uploaded, 0), segment(), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)], edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')] });
      await start({ mode: 'node', nodeIds: ['v'] });
      near((await planNow()).nodes.s.estimate.usd, 0.095, 'an upload has no length');

      // 4. no object: the plan names the cause with a code the page translates, the run is refused, nothing is sent
      await save({ nodes: [input('v', uploaded, 0), segment({ object: '' }), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)], edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')] });
      resetCalls();
      planned = await planNow();
      assert.equal(planned.valid, false);
      const issue = planned.issues.find((item) => item.nodeId === 's');
      assert.equal(issue.code, 'SEGMENT_OBJECT_REQUIRED');
      assert.equal(planned.nodes.s.status, 'invalid');
      const refusedRun = await call('POST', `/api/workflows/${created.id}/runs`, { mode: 'all' });
      assert.ok(refusedRun.status >= 400, 'the run is refused before anything is paid');
      nothingSent('invalid object over the API');

      // 5. the full run with a 60 fps clip: prepared, uploaded, queued, stored as .webm, booked
      const fast = await seed('fast');
      await save({ nodes: [input('v', fast, 0), segment({ max_seconds: 2 }), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)], edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')] });
      resetCalls();
      const WEBM_URL = 'https://v3b.fal.media/files/out/segmented/output.webm';
      downloads.set(WEBM_URL, Buffer.concat([EBML, Buffer.alloc(300)]));
      scenario = () => ({ video: { url: WEBM_URL, content_type: 'application/octet-stream', file_name: 'output.webm' } });
      planned = await planNow();
      const bound = planned.nodes.s.estimate.usd;
      near(bound, 0.02, 'max_seconds 2 = 60 frames, the same as the exact count of this clip');
      const done = await start({ mode: 'all' });
      assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 600));
      assert.equal(calls.upload.length, 1);
      assert.equal(calls.upload[0].probe.frames, 60);
      assert.equal(calls.submit.length, 1);
      assert.equal(calls.submit[0].input.prompt, 'person');
      const results = (await call('GET', `/api/workflows/${created.id}`)).body.results;
      const entry = results.nodes.s.history[0];
      near(entry.cost.usd, 0.02, 'the run books the exact price');
      assert.ok(bound + 1e-9 >= entry.cost.usd, 'the plan showed at least what the run booked');
      const value = entry.variants[0].video;
      assert.ok(value.file.endsWith('.webm'), `the result is a WebM: ${value.file}`);
      const served = await api(value.url, { as: STAFF, raw: true });
      assert.equal(served.status, 200);
      assert.match(served.headers.get('content-type') || '', /video\/webm/, 'served as WebM');
      await served.arrayBuffer();
      assert.deepEqual(await scratchLeft(created.sessionId), [], 'no scratch folder is left in the workflow');
      // the ledger of the workflow: the two seeds, the upload of the clips and the one result, no prepared copy
      const ledger = await store.readLedger(created.sessionId);
      assert.equal(ledger.filter((entry) => entry.file === videoPrep.PREPARED_FILE).length, 0);
      assert.ok(ledger.some((entry) => entry.file.endsWith('.webm')), 'the WebM result is in the ledger');
    } finally {
      stop.value = true;
      await pump;
    }
  }

  /* ---------- participants: the budget counts, and nothing is uploaded when the run does not fit ---------- */
  {
    const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs Video', budgetUsd: 0.05 } })).body.team;
    assert.ok(team, 'a team with a budget of 0.05 USD');
    await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } });
    const call = (method, url, json, extra = {}) => api(url, { method, as: P1, json, ...extra });
    const stop = { value: false };
    const pump = (async () => {
      while (!stop.value) {
        await poller.pollOnce().catch(() => {});
        await sleep(100);
      }
    })();
    try {
      const registryPayload = (await call('GET', '/api/nodes/registry')).body;
      const entry = registryPayload.nodeTypes.find((type) => type.type === 'fal.video_segment');
      assert.ok(entry && !entry.restricted, 'the node is open to participants');
      assert.equal(entry.available, true);

      const flow = (await call('POST', '/api/workflows', { name: 'Teilnehmende' })).body.workflow;
      const seeded = await asset(await fsp.readFile(clips.fits), '.mp4', flow.sessionId);
      let rev = 1;
      const save = async (extra = {}) => {
        const response = await call('PUT', `/api/workflows/${flow.id}`, {
          baseRev: rev,
          graph: {
            nodes: [node('v', 'input.video', { asset: { assetId: seeded.assetId, sessionId: flow.sessionId } }), node('s', 'fal.video_segment', { object: 'person', ...extra }, 300, 0), node('out', 'output.result', { label: 'Freisteller' }, 600, 0)],
            edges: [edge('e1', 'v', 'video', 's', 'video'), edge('e2', 's', 'video', 'out', 'inputs')],
            groups: [],
            notes: []
          }
        });
        assert.equal(response.status, 200, response.text);
        rev = response.body.rev;
      };
      const finish = async (runId) => {
        const started = Date.now();
        for (;;) {
          const record = (await call('GET', `/api/workflows/${flow.id}/runs/${runId}`)).body;
          if (record && record.status !== 'running') return record;
          assert.ok(Date.now() - started < 60000, 'the run finishes');
          await sleep(100);
        }
      };

      // 10 s at 30 fps would be 0.095 USD: that does not fit a budget of 0.05, so the run is refused before anything is prepared or uploaded
      await save();
      resetCalls();
      const tightPlan = (await call('POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' })).body;
      near(tightPlan.totals.usd, 0.095);
      assert.equal(tightPlan.budget.enough, false);
      assert.equal(tightPlan.budget.code, 'BUDGET_INSUFFICIENT');
      const tooDear = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(tooDear.status, 402);
      assert.equal(tooDear.body.code, 'BUDGET_INSUFFICIENT');
      nothingSent('refused for the budget');
      assert.deepEqual(await scratchLeft(flow.sessionId), []);

      // 3 s (at most 90 frames = 0.03 USD) fits; the clip has 48 frames and the run books 0.015
      await save({ max_seconds: 3 });
      const fitsPlan = (await call('POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(fitsPlan.budget.enough, true);
      near(fitsPlan.budget.estimateUsd, 0.03);
      const started = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(started.status, 202, started.text);
      const done = await finish(started.body.runId);
      assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 400));
      assert.equal(calls.submit.length, 1);
      const me = (await api('/api/me', { as: P1 })).body.budget;
      near(me.spentUsd, 0.015, 'the exact price counts against the budget');
      assert.equal(me.reservedUsd, 0, 'nothing stays reserved');
      assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
      assert.equal(journal.length, 1);
      assert.equal(journal[0].user, P1);
      near(journal[0].cost, 0.015);

      // what is left (0.035) does not fit 10 s again: refused, and again nothing is uploaded
      await save();
      resetCalls();
      const again = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(again.status, 402);
      nothingSent('refused for the rest of the budget');
    } finally {
      stop.value = true;
      await pump;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
