'use strict';

// Runway Gen-4.5 through OpenRouter (WP41): the model of the curated list, in the card of the chat and in the node "Generate video".
// What is covered, with a fake OpenRouter (the model list, createVideo) and nothing paid:
//   - the list and the profile of the curated models: Gen-4.5 is added, the five others are as they were (golden)
//   - the price: 5 s = 0.60 USD, a minimum per generation raises the estimate (the minimum of Aleph: 1 s and 2 s = 0.56, 3 s = 0.84),
//     a price without a minimum has exactly the shape it had before
//   - the limits of the metadata: 2 to 10 s (a range is clamped), 720p only, 16:9 or 9:16
//   - the card with six models (MAX_OPTIONS is 6: all of them, the grid wraps), a seventh from outside the list is cut from the end
//   - the format of the start image: another format than 16:9 or 9:16 is never cropped. The card leaves the model out, a direct call is
//     refused before it is paid (code VIDEO_FRAME_RATIO, in German and English), nothing is booked
//   - the node "Generate video": the model is on the list with its limits and its price, a run sends the right request, a start image
//     of another format is refused with the same code and the text of every language
//   - the texts of the card in German, English and Spanish for every profile of the list
//   - the reader of the size of an image (PNG, JPEG, WebP, GIF)

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const costs = require('../lib/costs');
const discovery = require('../lib/discovery');
const tools = require('../lib/tools');
const imageSize = require('../lib/image-size');
const videoModels = require('../lib/video-models');
const videoNodeModels = require('../lib/video-node-models');
const ffmpegLib = require('../lib/ffmpeg');
const assets = require('../lib/nodes/assets');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');

const root = path.resolve(__dirname, '..');

const SEEDANCE = 'bytedance/seedance-2.5';
const FAST = 'bytedance/seedance-2.0-fast';
const KLING = 'kwaivgi/kling-v3.0-std';
const WAN = 'alibaba/wan-2.7';
const VEO = 'google/veo-3.1-lite';
const RUNWAY = 'runway/gen-4.5';
const ALEPH = 'runway/aleph-2';
const EXTRA = 'vendor/extra-video';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'amount'}: ${actual} is not ${expected}`);
const plain = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => ({ type: 'text', value });

// The shape of GET /videos/models, reduced. Gen-4.5 and Aleph 2.0 as OpenRouter lists them (read 2026-10-04).
const entry = (id, name, fields) => ({ id, name, supported_aspect_ratios: ['16:9', '9:16', '1:1'], generate_audio: true, ...fields });
const CATALOG = {
  data: [
    entry(SEEDANCE, 'ByteDance: Seedance 2.5', {
      supported_resolutions: ['480p', '720p'],
      supported_aspect_ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      supported_durations: range(4, 30),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { video_tokens: '0.0000107', video_tokens_without_audio: '0.0000107', video_tokens_with_video_input: '0.0000064' }
    }),
    entry(FAST, 'ByteDance: Seedance 2.0 Fast', {
      supported_resolutions: ['480p', '720p'],
      supported_durations: range(4, 15),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { video_tokens: '0.0000042', video_tokens_without_audio: '0.0000042', video_tokens_with_video_input: '0.000002475' }
    }),
    entry(KLING, 'Kling: Video v3.0 Standard', {
      supported_resolutions: ['720p'],
      supported_durations: range(3, 15),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126', text_to_video_duration_seconds_720p: '0.084', image_to_video_duration_seconds_720p: '0.084' }
    }),
    entry(WAN, 'Alibaba: Wan 2.7', {
      supported_resolutions: ['720p', '1080p'],
      supported_durations: range(2, 10),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds: '0.1' }
    }),
    entry(VEO, 'Google: Veo 3.1 Lite', {
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_durations: [8, 4, 6],
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05', duration_seconds_with_audio_720p: '0.05', duration_seconds_without_audio_720p: '0.03' }
    }),
    // Runway Gen-4.5: text or a first frame to video, 720p only, 16:9 or 9:16, 2 to 10 s, no sound, 12 cents per second of the result
    entry(RUNWAY, 'Runway: Gen-4.5', {
      generate_audio: false,
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_durations: range(2, 10),
      supported_frame_images: ['first_frame'],
      pricing_skus: { cents_per_second_output: '12' }
    }),
    // Runway Aleph 2.0: an editor, not a generator; 28 cents per second, at least 56 cents per generation
    entry(ALEPH, 'Runway: Aleph 2.0', {
      generate_audio: false,
      supported_aspect_ratios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
      pricing_skus: { cents_per_second_output: '28', minimum_cents_per_generation: '56' }
    }),
    // a model of the operator outside the list, a plain generator
    entry(EXTRA, 'Vendor: Extra Video', {
      supported_resolutions: ['720p'],
      supported_durations: range(2, 10),
      supported_frame_images: ['first_frame'],
      pricing_skus: { duration_seconds: '0.2' }
    })
  ]
};

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

// A valid PNG of w x h (one colour): the header is what the app reads, the rest keeps the file a real picture.
function pngOf(width, height) {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])), 0);
    return Buffer.concat([length, Buffer.from(type), body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)]);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function loadChatTexts() {
  const window = { document: { documentElement: {}, querySelectorAll() { return []; } }, navigator: { language: 'de' }, localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window });
  return window.I18N;
}

function loadNodeTexts() {
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  return window.I18N;
}

/* ---------- the size of an image ---------- */

function testImageSize() {
  assert.deepEqual(imageSize.imageSizeOf(pngOf(160, 90)), { width: 160, height: 90 });
  assert.deepEqual(imageSize.imageSizeOf(pngOf(7, 3000)), { width: 7, height: 3000 });
  // JPEG: SOI, an APP0 segment, then a baseline frame header (SOF0)
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  ]);
  assert.deepEqual(imageSize.imageSizeOf(jpeg), { width: 800, height: 600 }, 'JPEG: height 600, width 800');
  // WebP, the three forms
  const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), Buffer.alloc(4), body]);
  const vp8x = Buffer.alloc(14);
  vp8x.writeUIntLE(1919, 4, 3);
  vp8x.writeUIntLE(1079, 7, 3);
  assert.deepEqual(imageSize.imageSizeOf(riff('VP8X', vp8x)), { width: 1920, height: 1080 });
  const vp8l = Buffer.alloc(10);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((499) | (299 << 14), 1);
  assert.deepEqual(imageSize.imageSizeOf(riff('VP8L', vp8l)), { width: 500, height: 300 });
  const vp8 = Buffer.alloc(14);
  vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a;
  vp8.writeUInt16LE(640, 6);
  vp8.writeUInt16LE(480, 8);
  assert.deepEqual(imageSize.imageSizeOf(riff('VP8 ', vp8)), { width: 640, height: 480 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(10)]);
  assert.deepEqual(imageSize.imageSizeOf(gif), { width: 320, height: 240 });
  // not an image, empty, truncated
  assert.equal(imageSize.imageSizeOf(Buffer.from('not an image at all, just text')), null);
  assert.equal(imageSize.imageSizeOf(Buffer.alloc(0)), null);
  assert.equal(imageSize.imageSizeOf(pngOf(10, 10).subarray(0, 20)), null);
  assert.equal(imageSize.imageSizeOf('text'), null);
  console.log('   ok testImageSize');
}

/* ---------- the list, the profile, the price ---------- */

function testListAndPrice() {
  // the list: the five that were there, in their order, then Runway
  assert.deepEqual([...videoModels.CURATED_MODEL_IDS], [SEEDANCE, FAST, KLING, WAN, VEO, RUNWAY]);
  // golden: the profiles of the five others did not change
  const golden = {
    [SEEDANCE]: ['Seedance 2.5', { images: 30, videos: 10, audios: 10 }],
    [FAST]: ['Seedance 2.0 Fast', { images: 9, videos: 3, audios: 3 }],
    [KLING]: ['Kling v3.0 Standard', { images: 0, videos: 0, audios: 0 }],
    [WAN]: ['Wan 2.7', { images: 5, videos: 0, audios: 0 }],
    [VEO]: ['Veo 3.1 Lite', { images: 0, videos: 0, audios: 0 }]
  };
  for (const [id, [name, references]] of Object.entries(golden)) {
    assert.equal(videoModels.profileName(id), name, id);
    assert.deepEqual(videoModels.referenceLimits(id), references, id);
    assert.equal(videoModels.displayName(null, id), name, id);
  }
  // Runway Gen-4.5: its name, no references except the start image
  assert.equal(videoModels.profileName(RUNWAY), 'Runway Gen-4.5');
  assert.deepEqual(videoModels.referenceLimits(RUNWAY), { images: 0, videos: 0, audios: 0 });
  assert.equal(videoModels.displayName(CATALOG.data.find((item) => item.id === RUNWAY), RUNWAY), 'Runway Gen-4.5');
  // Aleph is an editor: not on the list of the generators, and never offered as a filler of a thin card
  assert.equal(videoModels.CURATED_MODEL_IDS.includes(ALEPH), false);

  const byId = (id) => CATALOG.data.find((item) => item.id === id);
  const job = (duration, extra = {}) => ({ duration, resolution: '720p', mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false, ...extra });

  // Gen-4.5: 12 cents per second of the result: 5 s = 0.60 USD, 10 s = 1.20, 2 s = 0.24
  for (const [seconds, usd] of [[2, 0.24], [5, 0.6], [10, 1.2]]) {
    const price = videoModels.priceEstimate(byId(RUNWAY), job(seconds));
    near(price.minPerSecond, 0.12, 'per second');
    near(price.maxPerSecond, 0.12, 'per second');
    near(price.minTotal, usd, `${seconds} s`);
    near(price.maxTotal, usd, `${seconds} s`);
    assert.equal('minimumTotal' in price, false, 'no minimum for Gen-4.5');
  }
  // the same price for image to video
  near(videoModels.priceEstimate(byId(RUNWAY), job(5, { mode: 'image_to_video', aspectRatio: '' })).maxTotal, 0.6);

  // a minimum per generation: never below it (Aleph 2.0: 0.28 per second, at least 0.56)
  for (const [seconds, usd] of [[1, 0.56], [2, 0.56], [3, 0.84], [10, 2.8]]) {
    const price = videoModels.priceEstimate(byId(ALEPH), job(seconds, { hasVideoInput: true }));
    near(price.minTotal, usd, `Aleph ${seconds} s (low)`);
    near(price.maxTotal, usd, `Aleph ${seconds} s (high)`);
    near(price.minimumTotal, 0.56, 'the minimum is named');
    assert.ok(price.minTotal >= 0.56 - 1e-9 && price.maxTotal >= 0.56 - 1e-9, 'never below the minimum');
  }
  near(videoModels.minimumCharge(byId(ALEPH)), 0.56);
  assert.equal(videoModels.minimumCharge(byId(RUNWAY)), null);
  assert.equal(videoModels.minimumCharge({}), null);
  assert.equal(videoModels.minimumCharge({ pricing_skus: { minimum_cents_per_generation: 'x' } }), null);
  assert.equal(videoModels.minimumCharge({ pricing_skus: { minimum_cents_per_generation: '0' } }), null);

  // golden: a model without a minimum has exactly the shape of the price it had before WP41
  assert.deepEqual(plain(videoModels.priceEstimate(byId(KLING), job(5))), {
    currency: 'USD',
    durationSeconds: 5,
    minPerSecond: 0.084,
    maxPerSecond: 0.126,
    minTotal: 0.42,
    maxTotal: 0.63,
    source: 'openrouter-live'
  });
  assert.deepEqual(plain(videoModels.priceEstimate(byId(WAN), job(4, { resolution: '720p' }))), {
    currency: 'USD',
    durationSeconds: 4,
    minPerSecond: 0.1,
    maxPerSecond: 0.1,
    minTotal: 0.4,
    maxTotal: 0.4,
    source: 'openrouter-live'
  });
  assert.equal(videoModels.priceEstimate({ id: 'x', pricing_skus: {} }, job(5)), null, 'no price stays no price');
  // a minimum alone is no price
  assert.equal(videoModels.priceEstimate({ id: 'x', pricing_skus: { minimum_cents_per_generation: '56' } }, job(5)), null);
  console.log('   ok testListAndPrice');
}

/* ---------- the format of a start image ---------- */

function testFrameRatio() {
  const problem = (width, height) => videoModels.frameRatioProblem(RUNWAY, { width, height });
  assert.equal(problem(1920, 1080), null);
  assert.equal(problem(1080, 1920), null);
  assert.equal(problem(1920, 1088), null, '1920 x 1088 is 16:9 within the tolerance');
  assert.equal(problem(1280, 720), null);
  assert.equal(problem(720, 1280), null);
  assert.deepEqual(problem(1000, 1000), { allowed: ['16:9', '9:16'], width: 1000, height: 1000, ratio: '1:1' });
  assert.equal(problem(800, 600).ratio, '4:3');
  assert.equal(problem(600, 800).ratio, '3:4');
  assert.equal(problem(2100, 900).ratio, '21:9');
  assert.equal(problem(1200, 900 + 5).ratio, '4:3', 'near a named format');
  assert.match(problem(1300, 1000).ratio, /^1\.30:1$/, 'any other: the plain ratio');
  assert.equal(problem(1822, 1000), null, '1.822 is within 3 % of 16:9 (1.778)');
  assert.ok(problem(1900, 1000), '1.9 is not');
  // a model without a restriction, a size that is not known: no problem
  assert.equal(videoModels.frameRatioProblem(KLING, { width: 1000, height: 1000 }), null);
  assert.equal(videoModels.frameRatioProblem(RUNWAY, null), null);
  assert.equal(videoModels.frameRatioProblem(RUNWAY, { width: 0, height: 10 }), null);
  assert.equal(videoModels.frameRatioProblem('vendor/unknown', { width: 1, height: 3 }), null);
  // a start image that is there but whose size cannot be read is not taken on trust by a model with a format limit (fail closed)
  const unreadable = videoModels.frameRatioProblem(RUNWAY, null, { requireSize: true });
  assert.deepEqual(plain(unreadable), { allowed: ['16:9', '9:16'], unreadable: true, width: 0, height: 0, ratio: null });
  assert.equal(videoModels.frameRatioProblem(KLING, null, { requireSize: true }), null, 'a model without a limit takes it');
  assert.equal(videoModels.frameRatioProblem(RUNWAY, { width: 1920, height: 1080 }, { requireSize: true }), null, 'a size that is read is checked as before');
  const refusal = videoModels.frameRatioRefusal({ name: 'Runway Gen-4.5' }, unreadable);
  assert.equal(refusal.code, 'VIDEO_FRAME_UNREADABLE');
  assert.equal(refusal.status, 409);
  assert.deepEqual(plain(refusal.data), { model: 'Runway Gen-4.5', allowed: '16:9 / 9:16' });
  assert.match(refusal.message, /could not be read/);
  assert.match(refusal.message, /Nothing was charged/);
  assert.match(refusal.messageDe, /nicht lesen/);
  assert.match(refusal.messageDe, /nichts berechnet/);
  assert.equal(refusal.messageDe.includes('ß'), false);
  // the refusal: a stable code, both languages, the figures as data, a statement that nothing was charged
  const error = videoModels.frameRatioRefusal({ name: 'Runway Gen-4.5' }, problem(1000, 1000));
  assert.equal(error.code, 'VIDEO_FRAME_RATIO');
  assert.equal(error.status, 409);
  assert.deepEqual(plain(error.data), { model: 'Runway Gen-4.5', allowed: '16:9 / 9:16', ratio: '1:1', width: 1000, height: 1000 });
  assert.match(error.message, /only takes start images in 16:9 \/ 9:16 or 9:16|16:9 or 9:16/);
  assert.match(error.message, /not cropped/);
  assert.match(error.message, /Nothing was charged/);
  assert.match(error.messageDe, /nur Startbilder im Format 16:9 oder 9:16/);
  assert.match(error.messageDe, /nicht beschnitten/);
  assert.match(error.messageDe, /nichts berechnet/);
  assert.equal(error.messageDe.includes('ß'), false);
  console.log('   ok testFrameRatio');
}

/* ---------- the card of the chat ---------- */

async function testCard(sessionId) {
  patch(discovery, 'listVideoModels', async () => CATALOG);
  const asset = async (width, height) => (await store.saveAsset(sessionId, { kind: 'upload', buffer: pngOf(width, height), ext: '.png', prompt: 'seed' })).id;
  const ids = (options) => options.map((option) => option.id);

  // Gen-4.5 on the card: six models in all, with their price and the key of their texts
  let listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 6 }, SEEDANCE);
  assert.deepEqual(ids(listed.options), [SEEDANCE, FAST, KLING, WAN, VEO, RUNWAY], 'MAX_OPTIONS is 6: all six curated models fit one card');
  const runway = listed.options.find((option) => option.id === RUNWAY);
  assert.equal(runway.name, 'Runway Gen-4.5');
  assert.equal(runway.profileKey, 'runwayGen45');
  assert.equal(runway.durationSeconds, 6);
  assert.equal(runway.resolution, '720p');
  near(runway.price.maxTotal, 0.72, '6 s');
  near(runway.estimateUsd, 0.72, 'what the budget reserves');
  assert.deepEqual(plain(runway.capabilities), { resolutions: ['720p'], aspectRatios: ['16:9', '9:16'], durations: range(2, 10), firstFrame: true, audio: false });
  assert.equal(listed.options.filter((option) => option.recommended).length, 1);
  assert.equal(listed.options.find((option) => option.recommended).id, SEEDANCE, 'the recommendation is the default model');
  // the others keep their profile keys (golden)
  assert.deepEqual(listed.options.map((option) => option.profileKey), ['seedance25', 'seedanceFast', 'klingStandard', 'wan27', 'veoLite', 'runwayGen45']);

  // the card with a configured default model that is not on the list: it comes first and the list is cut at six, from the end
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 6 }, EXTRA);
  assert.deepEqual(ids(listed.options), [EXTRA, SEEDANCE, FAST, KLING, WAN, VEO], 'seven candidates, six shown');
  assert.equal(videoModels.MAX_PENDING_PER_SESSION, 20);

  // 5 s: Veo has fixed lengths (4, 6, 8) and drops out, as it always did; the others stay
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 5 }, SEEDANCE);
  assert.deepEqual(ids(listed.options), [SEEDANCE, FAST, KLING, WAN, RUNWAY]);
  near(listed.options.find((option) => option.id === RUNWAY).price.maxTotal, 0.6, '5 s = 0.60 USD');

  // the limits of the metadata: 2 to 10 s (a range is clamped, not refused), 720p only, 16:9 or 9:16
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 12 }, SEEDANCE);
  const long = listed.options.find((option) => option.id === RUNWAY);
  assert.equal(long.durationSeconds, 10, '12 s is clamped to 10 s');
  near(long.price.maxTotal, 1.2);
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 1 }, SEEDANCE);
  assert.equal(listed.options.find((option) => option.id === RUNWAY).durationSeconds, 2, '1 s is raised to 2 s');
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, resolution: '1080p' }, SEEDANCE)).options).includes(RUNWAY), false, '720p only');
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, aspect_ratio: '1:1' }, SEEDANCE)).options).includes(RUNWAY), false, 'text to video in 1:1: not offered');
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, aspect_ratio: '9:16' }, SEEDANCE)).options).includes(RUNWAY), true);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, aspect_ratio: '16:9' }, SEEDANCE)).options).includes(RUNWAY), true);
  // reference files: Gen-4.5 takes none (the start image is no reference)
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, reference_asset_ids: ['a'] }, SEEDANCE)).options).includes(RUNWAY), false);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 5, reference_video_asset_ids: ['a'] }, SEEDANCE)).options).includes(RUNWAY), false);

  // the start image: 16:9 and 9:16 are offered; 1:1 and 4:3 are not, and the others stay
  const wide = await asset(160, 90);
  const tall = await asset(90, 160);
  const square = await asset(100, 100);
  const classic = await asset(120, 90);
  const almostWide = await asset(192, 109);
  for (const [id, offered, label] of [[wide, true, '16:9'], [tall, true, '9:16'], [square, false, '1:1'], [classic, false, '4:3'], [almostWide, true, '1.76:1 is within the tolerance of 16:9']]) {
    const args = { prompt: 'x', duration_seconds: 6, first_frame_asset_id: id };
    const withFrame = await videoModels.listOptions(args, SEEDANCE, { sessionId });
    assert.equal(withFrame.requirements.mode, 'image_to_video');
    assert.equal(ids(withFrame.options).includes(RUNWAY), offered, label);
    assert.deepEqual(ids(withFrame.options).filter((model) => model !== RUNWAY), [SEEDANCE, FAST, KLING, WAN, VEO], `${label}: the other models are all there`);
    // the plan of the chat decides the same
    const planned = await videoModels.plan({ sessionId, args, defaultModel: SEEDANCE });
    assert.equal(planned.kind, 'card');
    assert.equal(ids(planned.options).includes(RUNWAY), offered, `${label}: plan`);
  }
  // without the session the size is not known: the model stays on the card and the call is refused later (below)
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, first_frame_asset_id: square }, SEEDANCE)).options).includes(RUNWAY), true);
  // a card with a request keeps what it showed: the request stores the options as they were
  const request = await videoModels.createRequest({ sessionId, args: { prompt: 'x', duration_seconds: 6, first_frame_asset_id: square }, plan: await videoModels.plan({ sessionId, args: { prompt: 'x', duration_seconds: 6, first_frame_asset_id: square }, defaultModel: SEEDANCE }), user: 'tester' });
  assert.equal(request.options.some((option) => option.id === RUNWAY), false);
  await assert.rejects(videoModels.beginRequest({ sessionId, requestId: request.id, selectedModel: RUNWAY }), /nicht verf/, 'a click on a model that is not on the card is refused');
  console.log('   ok testCard');
}

/* ---------- a direct call and the node ---------- */

async function testPayloadAndNode(sessionId) {
  const journal = [];
  const payloads = [];
  let jobCounter = 0;
  patch(or, 'hasKey', () => true);
  patch(or, 'listVideoModels', async () => CATALOG);
  patch(discovery, 'listImageModels', async () => ({ data: [] }));
  discovery.resetVideoModelCache();
  patch(costs, 'recordCost', async (record) => {
    journal.push(record);
    return record;
  });
  patch(or, 'createVideo', async (payload) => {
    payloads.push(payload);
    jobCounter += 1;
    return { id: `runway-job-${jobCounter}`, status: 'pending' };
  });
  videoNodeModels.reset();

  const upload = async (width, height) => assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: pngOf(width, height), ext: '.png', prompt: 'seed' })).id);
  const wide = await upload(160, 90);
  const tall = await upload(90, 160);
  const square = await upload(100, 100);
  const config = { imageModel: 'openai/gpt-image-2', videoModel: SEEDANCE };

  /* ----- the tool layer: the format of the start image is checked before anything is paid ----- */
  const capabilities = { resolutions: ['720p'], durations: { min: 2, max: 10 }, aspectRatios: ['16:9', '9:16'] };
  const toolCtx = (model) => ({ nodeView: true, sessionId, user: 'tester', config: { ...config, videoModel: model }, emit() {} });
  let refused = await tools.buildVideoPayload(toolCtx(RUNWAY), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: square.assetId, duration_seconds: 5 }, { capabilities }).catch((error) => error);
  assert.equal(refused.code, 'VIDEO_FRAME_RATIO');
  assert.deepEqual(plain(refused.data), { model: 'Runway Gen-4.5', allowed: '16:9 / 9:16', ratio: '1:1', width: 100, height: 100 });
  assert.match(refused.messageDe, /nur Startbilder im Format 16:9 oder 9:16; dieses ist 1:1 \(100 x 100\)/);
  assert.equal(payloads.length, 0, 'nothing was sent');
  const built = await tools.buildVideoPayload(toolCtx(RUNWAY), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: wide.assetId, duration_seconds: 5 }, { capabilities });
  assert.equal(built.payload.model, RUNWAY);
  assert.equal(built.payload.resolution, '720p');
  assert.equal(built.payload.duration, 5);
  assert.deepEqual(built.payload.frame_images.map((frame) => [frame.type, frame.frame_type]), [['image_url', 'first_frame']]);
  assert.equal('aspect_ratio' in built.payload, false, 'the first frame sets the format');
  assert.equal('input_references' in built.payload, false, 'no references');
  // a start image whose size cannot be read is refused by the model with the format limit (nothing is sent), not passed on unchecked
  const unreadableImage = await assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.concat([pngOf(160, 90).subarray(0, 8), Buffer.from('this is not a picture')]), ext: '.png', prompt: 'seed' })).id);
  refused = await tools.buildVideoPayload(toolCtx(RUNWAY), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: unreadableImage.assetId, duration_seconds: 5 }, { capabilities }).catch((error) => error);
  assert.equal(refused.code, 'VIDEO_FRAME_UNREADABLE');
  assert.equal(payloads.length, 0, 'nothing was sent');
  // ... while a JPEG with long metadata in front of the picture (the header reader gives up after 256 KB) is read by ffprobe
  if (ffmpegLib.binaries().available) {
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-runway-jpeg-'));
    const jpegFile = path.join(scratchDir, 'plain.jpg');
    await promisify(execFile)(ffmpegLib.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1', '-frames:v', '1', jpegFile]);
    const plainJpeg = await fsp.readFile(jpegFile);
    const filler = Buffer.alloc(60000, 0x41);
    const segments = [];
    for (let index = 0; index < 5; index += 1) segments.push(Buffer.from([0xff, 0xef, 0xea, 0x62]), filler.subarray(0, 0xea62 - 2));
    const heavy = Buffer.concat([plainJpeg.subarray(0, 2), ...segments, plainJpeg.subarray(2)]);
    const heavyAsset = await assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: heavy, ext: '.jpg', prompt: 'seed' })).id);
    assert.equal(await videoModels.firstFrameSize(sessionId, heavyAsset.assetId) !== null, true, 'the size comes from ffprobe');
    assert.deepEqual(plain(await videoModels.firstFrameSize(sessionId, heavyAsset.assetId)), { width: 160, height: 90 });
    const fine = await tools.buildVideoPayload(toolCtx(RUNWAY), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: heavyAsset.assetId, duration_seconds: 5 }, { capabilities });
    assert.equal(fine.payload.model, RUNWAY);
    await fsp.rm(scratchDir, { recursive: true, force: true });
  }
  // the same square image is fine for a model without that restriction
  const other = await tools.buildVideoPayload(toolCtx(KLING), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: square.assetId, duration_seconds: 5 }, { capabilities: { resolutions: ['720p'], durations: { min: 3, max: 15 }, aspectRatios: ['16:9'] } });
  assert.equal(other.payload.model, KLING);
  // text to video in 9:16
  const textual = await tools.buildVideoPayload(toolCtx(RUNWAY), { prompt: 'x', duration_seconds: 4, aspect_ratio: '9:16' }, { capabilities });
  assert.equal(textual.payload.aspect_ratio, '9:16');

  /* ----- the node "Generate video" ----- */
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const def = registry.get('video.generate');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-runway-models-'));
  try {
    const bus = createEventBus();
    createWorkflowsStore({ dir: tmpDir, registry, events: bus });
    const makeCtx = () => {
      const controller = new AbortController();
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: { ...config },
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: { ...config }, user: 'tester', emit() {} },
        log() {},
        waitForJob: async (job) => {
          await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), 0.6);
          await store.mutateSession(sessionId, (session) => {
            const target = session.jobs.find((item) => item.assetId === job.assetId);
            target.status = 'completed';
            target.resultAssetIds = [job.assetId];
          });
          return [job.assetId];
        },
        withLocalSlot: (fn) => fn()
      };
    };
    const run = (inputs, rawParams = {}) => def.execute(makeCtx(), inputs, registry.normalizeParams(def, { model: RUNWAY, ...rawParams }));

    // the model is on the list of the node with its limits and its price
    await videoNodeModels.load();
    assert.ok(videoNodeModels.allowedModels(config).includes(RUNWAY));
    assert.equal(videoNodeModels.isAllowed(config, RUNWAY), true);
    assert.equal(videoNodeModels.isAllowed(config, ALEPH), false, 'Aleph is no generator: it is not on the list of this node');
    assert.equal(videoNodeModels.displayName(RUNWAY), 'Runway Gen-4.5');
    assert.deepEqual(plain(videoNodeModels.limits(RUNWAY)), { images: 0, videos: 0, audios: 0, firstFrame: 1, lastFrame: 0 });
    const estimated = videoNodeModels.estimate(RUNWAY, { duration: 5 });
    near(estimated.price.maxTotal, 0.6, 'the node shows the same price as the card: 5 s = 0.60 USD');
    assert.equal(estimated.resolution, '720p');
    assert.deepEqual(plain(videoNodeModels.settings(RUNWAY, { duration: 12 })).duration, 10);
    const offered = (await videoNodeModels.options({ config })).find((item) => item.value === RUNWAY);
    assert.ok(offered, 'in the model list of the node');
    assert.equal(offered.label, 'Runway Gen-4.5');
    assert.deepEqual(plain(offered.durations), { min: 2, max: 10 });
    assert.deepEqual(plain(offered.perSecondUsd), { min: 0.12, max: 0.12 });
    assert.deepEqual(plain(offered.references), { max: 0, roles: [], required: false });
    assert.deepEqual(plain(offered.last_frame), { max: 0 });
    assert.equal('minimumUsd' in offered, false);
    assert.deepEqual(plain(videoNodeModels.aspectRatios(RUNWAY)), ['16:9', '9:16']);
    // the plan of the node: the price of the card
    const plannedUsd = def.cost.estimate(registry.normalizeParams(def, { model: RUNWAY, duration: 5 }), { connected: new Set() });
    near(plannedUsd.usd, 0.6, 'the plan');

    // a run: text to video
    const stopCompleter = () => {};
    payloads.length = 0;
    let out = await run({ prompt: text('A fox in the snow') }, { duration: 5, aspect_ratio: '9:16' });
    assert.equal(payloads.length, 1);
    assert.deepEqual(plain(payloads[0]), { model: RUNWAY, prompt: 'A fox in the snow', resolution: '720p', duration: 5, aspect_ratio: '9:16' });
    assert.equal(out.variants[0].video.type, 'video');
    const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
    assert.equal(job.model, RUNWAY);
    assert.equal(job.modelName, 'Runway Gen-4.5');
    near(job.estimateUsd, 0.6, 'the job shows the estimate');
    // the length is held to the limits: 12 s is made as 10 s and priced as 10 s
    payloads.length = 0;
    await run({ prompt: text('x') }, { duration: 12 });
    assert.equal(payloads[0].duration, 10);
    near((await store.readSession(sessionId)).jobs.slice(-1)[0].estimateUsd, 1.2, '10 s');
    // with a start image in 16:9
    payloads.length = 0;
    await run({ prompt: text('x'), first_frame: wide }, { duration: 5 });
    assert.deepEqual(payloads[0].frame_images.map((frame) => frame.frame_type), ['first_frame']);
    assert.equal('aspect_ratio' in payloads[0], false);
    // the limits are checked before the run: no end frame, no references, no videos
    const issues = (rawParams, ports) => (def.validate(registry.normalizeParams(def, { model: RUNWAY, ...rawParams }), ports) || []).map((issue) => (typeof issue === 'string' ? { code: 'invalid', message: issue } : issue));
    const connected = (counts) => Object.fromEntries(Object.entries(counts).map(([port, count]) => [port, { connected: count > 0, count }]));
    assert.deepEqual(issues({}, connected({ first_frame: 1, last_frame: 1 })).map((issue) => issue.code), ['VIDEO_LAST_FRAME_UNSUPPORTED']);
    assert.deepEqual(issues({}, connected({ refs: 2 })).map((issue) => issue.code), ['too_many_refs']);
    assert.deepEqual(issues({}, connected({ ref_videos: 1 })).map((issue) => issue.code).filter((code) => code === 'VIDEO_TOO_MANY_REF_VIDEOS'), ['VIDEO_TOO_MANY_REF_VIDEOS']);
    assert.deepEqual(issues({ aspect_ratio: '1:1' }, connected({})).map((issue) => issue.code), ['VIDEO_ASPECT_RATIO_UNSUPPORTED']);
    assert.deepEqual(issues({ resolution: '1080p' }, connected({})).map((issue) => issue.code), ['VIDEO_RESOLUTION_UNSUPPORTED']);

    // a start image of another format: refused before anything is sent, with a stable code
    payloads.length = 0;
    const before = (await store.readSession(sessionId)).jobs.length;
    const journalBefore = journal.length;
    const noSquare = await run({ prompt: text('x'), first_frame: square }, { duration: 5 }).catch((error) => error);
    assert.equal(noSquare.code, 'VIDEO_FRAME_RATIO');
    assert.deepEqual(plain(noSquare.data), { model: 'Runway Gen-4.5', allowed: '16:9 / 9:16', ratio: '1:1', width: 100, height: 100 });
    assert.equal(payloads.length, 0, 'the provider was not called');
    assert.equal((await store.readSession(sessionId)).jobs.length, before, 'no job');
    assert.equal(journal.length, journalBefore, 'nothing was booked');
    // a tall image is fine
    await run({ prompt: text('x'), first_frame: tall }, { duration: 5 });
    assert.equal(payloads.length, 1);
    void stopCompleter;

    // the text of the code in every language, with a value for every placeholder
    const nodeTexts = loadNodeTexts();
    for (const lang of ['de', 'en', 'es']) {
      const unreadableText = nodeTexts[lang]['nodes.issue.VIDEO_FRAME_UNREADABLE'];
      assert.ok(unreadableText, `${lang}: VIDEO_FRAME_UNREADABLE`);
      assert.equal(unreadableText.includes('ß'), false);
      for (const name of new Set((unreadableText.match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))) assert.ok(['model', 'allowed'].includes(name), `${lang}: {${name}} is given`);
      const message = nodeTexts[lang]['nodes.issue.VIDEO_FRAME_RATIO'];
      assert.ok(message, `${lang}: VIDEO_FRAME_RATIO`);
      assert.equal(message.includes('ß'), false);
      for (const name of new Set((message.match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))) assert.ok(noSquare.data[name] !== undefined, `${lang}: {${name}} has a value`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('   ok testPayloadAndNode');
}

/* ---------- the texts of the card ---------- */

function testCardTexts() {
  const dictionaries = loadChatTexts();
  const profileKeys = new Set(['generic']);
  const source = fs.readFileSync(path.join(root, 'lib', 'video-models.js'), 'utf8');
  for (const match of source.matchAll(/key: '([A-Za-z0-9]+)'/g)) profileKeys.add(match[1]);
  assert.ok(profileKeys.has('runwayGen45'));
  assert.equal(profileKeys.size, 7, 'the five, Runway and the neutral texts');
  for (const lang of ['de', 'en', 'es']) {
    for (const key of profileKeys) {
      for (const field of ['summary', 'pro', 'con']) {
        const value = dictionaries[lang][`videoModel.profile.${key}.${field}`];
        assert.ok(typeof value === 'string' && value.trim(), `${lang}: videoModel.profile.${key}.${field}`);
        assert.equal(value.includes('ß'), false);
      }
    }
  }
  // strengths: cinematic motion, image quality, follows the prompt; weaknesses: 720p only, 16:9 or 9:16 only, at most 10 s, no sound
  const patterns = {
    de: { pro: [/[Ff]ilmisch/, /Bildqualität/, /Prompt/], con: [/720p/, /16:9 oder 9:16/, /10 s/, /kein Ton/] },
    en: { pro: [/[Cc]inematic/, /image quality/, /prompt/], con: [/720p/, /16:9 or 9:16/, /10 s/, /no sound/] },
    es: { pro: [/cinematográfico/, /calidad de imagen/, /prompt/], con: [/720p/, /16:9 o 9:16/, /10 s/, /sin sonido/] }
  };
  for (const lang of ['de', 'en', 'es']) {
    const pro = dictionaries[lang]['videoModel.profile.runwayGen45.pro'];
    const con = dictionaries[lang]['videoModel.profile.runwayGen45.con'];
    for (const pattern of patterns[lang].pro) assert.match(pro, pattern, `${lang}: ${pro}`);
    for (const pattern of patterns[lang].con) assert.match(con, pattern, `${lang}: ${con}`);
  }
  // the old texts are as they were
  assert.equal(dictionaries.de['videoModel.profile.klingStandard.summary'], 'Gute Mimik und natürliche Bewegung für kurze Clips.');
  assert.equal(dictionaries.en['videoModel.profile.veoLite.con'], 'Few formats and fixed lengths, no reference files.');
  assert.equal(dictionaries.es['videoModel.profile.seedanceFast.pro'], 'Rápido, flexible y claramente más barato.');
  console.log('   ok testCardTexts');
}

async function main() {
  testImageSize();
  testListAndPrice();
  testFrameRatio();
  testCardTexts();
  const session = await store.createSession();
  try {
    await testCard(session.id);
    await testPayloadAndNode(session.id);
  } finally {
    restoreAll();
    await store.deleteSession(session.id).catch(() => {});
  }
  console.log('test-runway-models.js: ok');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
