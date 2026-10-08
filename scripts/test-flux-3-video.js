'use strict';

// FLUX.3 Video (black-forest-labs/flux-3-video) through OpenRouter: the seventh model of the curated list, in the card of the chat and in
// the node "Generate video". A fake OpenRouter (the model list as it was read on 2026-10-08, createVideo) and nothing paid. What is covered:
//   - the list and the profile: FLUX.3 is added at the end, the six others are as they were; no reference files; the six formats of the list
//   - the price from the list: 0.17 USD per second at 720p, 0.29 at 1080p (5 s at 720p = 0.85; 10 s at 1080p shows 1.70 to 2.90 because the
//     general price of the list is the lower end, and the card reserves the upper end, 2.90)
//   - the limits of the metadata: 5 to 20 s (a range is clamped), 720p and 1080p, six formats, a first and a last frame
//   - the card with seven models (MAX_OPTIONS is 7); a configured default outside the list makes eight candidates and the last one is cut
//   - the format of the start image: the six formats of the list pass and go out as aspect_ratio; 3:2 and 2:3 are never sent. The card leaves
//     the model out, a direct call is refused before it is paid (code VIDEO_FRAME_RATIO, in German and English), nothing is booked. The
//     end frame is not looked at (not known what the model does with another format: marked "per live test" in lib/video-models.js)
//   - the request of image to video: frame_images (first_frame, and last_frame in the node), resolution, duration and aspect_ratio; never
//     generate_audio (the sound is on by default and part of the price)
//   - the node "Generate video": the model is on the list with its limits and its price at 720p and at 1080p, a run sends the right request
//   - the texts of the card in German, English and Spanish: no promise of 1080p or of an end frame (the chat has neither)

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const costs = require('../lib/costs');
const discovery = require('../lib/discovery');
const tools = require('../lib/tools');
const videoModels = require('../lib/video-models');
const videoNodeModels = require('../lib/video-node-models');
const assets = require('../lib/nodes/assets');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createRegistry } = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');

const SEEDANCE = 'bytedance/seedance-2.5';
const FAST = 'bytedance/seedance-2.0-fast';
const KLING = 'kwaivgi/kling-v3.0-std';
const WAN = 'alibaba/wan-2.7';
const VEO = 'google/veo-3.1-lite';
const RUNWAY = 'runway/gen-4.5';
const FLUX3 = 'black-forest-labs/flux-3-video';
const FLUX_EDIT = 'black-forest-labs/flux-video-edit';
const EXTRA = 'vendor/extra-video';
const FORMATS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'amount'}: ${actual} is not ${expected}`);
const plain = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => ({ type: 'text', value });

// The shape of GET /videos/models, reduced. FLUX.3 Video and FLUX Video Edit exactly as OpenRouter listed them on 2026-10-08.
const entry = (id, name, fields) => ({ id, name, supported_aspect_ratios: ['16:9', '9:16', '1:1'], generate_audio: true, ...fields });
const FLUX3_ENTRY = {
  id: FLUX3,
  name: 'Black Forest Labs: FLUX.3 Video',
  supported_resolutions: ['720p', '1080p'],
  supported_aspect_ratios: FORMATS,
  supported_sizes: null,
  supported_durations: range(5, 20),
  supported_frame_images: ['first_frame', 'last_frame'],
  generate_audio: true,
  seed: false,
  pricing_skus: {
    cents_per_second_output: '17',
    cents_per_second_output_720p: '17',
    cents_per_second_output_1080p: '29',
    cents_per_second_video_continuation_720p: '41',
    cents_per_second_video_continuation_1080p: '53'
  },
  allowed_passthrough_parameters: ['safety_tolerance', 'version']
};
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
    entry(RUNWAY, 'Runway: Gen-4.5', {
      generate_audio: false,
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_durations: range(2, 10),
      supported_frame_images: ['first_frame'],
      pricing_skus: { cents_per_second_output: '12' }
    }),
    FLUX3_ENTRY,
    // FLUX Video Edit: an editor, not a generator; no resolutions, formats or lengths in the list, 3 cents per second
    {
      id: FLUX_EDIT,
      name: 'Black Forest Labs: FLUX Video Edit',
      supported_resolutions: null,
      supported_aspect_ratios: null,
      supported_durations: null,
      supported_frame_images: null,
      generate_audio: false,
      seed: false,
      pricing_skus: { cents_per_second_output: '3' },
      allowed_passthrough_parameters: ['safety_tolerance']
    },
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

/* ---------- the list, the profile, the price ---------- */

function testListAndPrice() {
  // the list: the six that were there, in their order, then FLUX.3 Video
  assert.deepEqual([...videoModels.CURATED_MODEL_IDS], [SEEDANCE, FAST, KLING, WAN, VEO, RUNWAY, FLUX3]);
  assert.equal(videoModels.CURATED_MODEL_IDS.length, 7, 'MAX_OPTIONS (7) is as long as the list');
  // golden: the profiles of the six others did not change
  const golden = {
    [SEEDANCE]: ['Seedance 2.5', { images: 30, videos: 10, audios: 10 }],
    [FAST]: ['Seedance 2.0 Fast', { images: 9, videos: 3, audios: 3 }],
    [KLING]: ['Kling v3.0 Standard', { images: 0, videos: 0, audios: 0 }],
    [WAN]: ['Wan 2.7', { images: 5, videos: 0, audios: 0 }],
    [VEO]: ['Veo 3.1 Lite', { images: 0, videos: 0, audios: 0 }],
    [RUNWAY]: ['Runway Gen-4.5', { images: 0, videos: 0, audios: 0 }]
  };
  for (const [id, [name, references]] of Object.entries(golden)) {
    assert.equal(videoModels.profileName(id), name, id);
    assert.deepEqual(videoModels.referenceLimits(id), references, id);
  }
  // FLUX.3 Video: its name, no reference files (the start and the end frame are no references)
  assert.equal(videoModels.profileName(FLUX3), 'FLUX.3 Video');
  assert.deepEqual(videoModels.referenceLimits(FLUX3), { images: 0, videos: 0, audios: 0 });
  assert.equal(videoModels.displayName(FLUX3_ENTRY, FLUX3), 'FLUX.3 Video', 'the curated name, not "Black Forest Labs: FLUX.3 Video"');
  assert.equal(videoModels.displayName(null, FLUX3), 'FLUX.3 Video');
  // the editor and the upscaler of the same maker are no generators: not on the list, never a filler of a thin card
  assert.equal(videoModels.CURATED_MODEL_IDS.includes(FLUX_EDIT), false);
  assert.equal(videoModels.profileName(FLUX_EDIT), '', 'FLUX Video Edit has no card text: it is a model of the node "Edit video with references"');

  const job = (duration, resolution, extra = {}) => ({ duration, resolution, mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false, ...extra });
  // 0.17 USD per second at 720p: 5 s = 0.85, 10 s = 1.70, 20 s = 3.40 (one price: the general price of the list is the same)
  for (const [seconds, usd] of [[5, 0.85], [6, 1.02], [10, 1.7], [20, 3.4]]) {
    const price = videoModels.priceEstimate(FLUX3_ENTRY, job(seconds, '720p'));
    near(price.minPerSecond, 0.17, 'per second');
    near(price.maxPerSecond, 0.17, 'per second');
    near(price.minTotal, usd, `${seconds} s at 720p`);
    near(price.maxTotal, usd, `${seconds} s at 720p`);
    assert.equal('minimumTotal' in price, false, 'no minimum per generation');
  }
  // 1080p: 0.29 USD per second from the list. The general price of the list (0.17) counts as the lower end of the range, as it does for
  // every model whose list names a general and a specific price: 10 s show 1.70 to 2.90, and 2.90 is what the card reserves
  const hd = videoModels.priceEstimate(FLUX3_ENTRY, job(10, '1080p'));
  near(hd.minPerSecond, 0.17, 'lower end');
  near(hd.maxPerSecond, 0.29, 'the price of 1080p');
  near(hd.minTotal, 1.7, '10 s at 1080p (low)');
  near(hd.maxTotal, 2.9, '10 s at 1080p (high)');
  near(videoModels.priceEstimate(FLUX3_ENTRY, job(5, '1080p')).maxTotal, 1.45, '5 s at 1080p');
  // image to video costs the same (the list has one price for both); the continuation prices (0.41, 0.53) are not read
  near(videoModels.priceEstimate(FLUX3_ENTRY, job(5, '720p', { mode: 'image_to_video', aspectRatio: '' })).maxTotal, 0.85);
  near(videoModels.priceEstimate(FLUX3_ENTRY, job(5, '1080p', { mode: 'image_to_video', aspectRatio: '' })).maxTotal, 1.45);
  assert.ok(videoModels.priceEstimate(FLUX3_ENTRY, job(20, '1080p')).maxTotal < 20 * 0.41, 'the dearer continuation price never enters');
  // FLUX Video Edit: 3 cents per second, no minimum (the node of the editor prices it, lib/nodes/flux-video-edit.js)
  near(videoModels.priceEstimate(CATALOG.data.find((item) => item.id === FLUX_EDIT), job(10, '720p', { hasVideoInput: true })).maxTotal, 0.3);
  assert.equal(videoModels.minimumCharge(FLUX3_ENTRY), null);
  console.log('   ok testListAndPrice');
}

/* ---------- the format of a start image ---------- */

function testFrameRatio() {
  const problem = (width, height) => videoModels.frameRatioProblem(FLUX3, { width, height });
  const ratioFor = (width, height) => videoModels.frameRatioFor(FLUX3, { width, height });
  // the six formats of the list pass and go out as their own format (the same tolerance of 3 % as for every model with a format limit)
  for (const [width, height, format] of [[2100, 900, '21:9'], [1920, 1080, '16:9'], [1920, 1088, '16:9'], [1600, 1200, '4:3'], [1000, 1000, '1:1'], [1200, 1600, '3:4'], [1080, 1920, '9:16'], [720, 1280, '9:16'], [1088, 1920, '9:16']]) {
    assert.equal(ratioFor(width, height), format, `${width} x ${height}`);
    assert.equal(problem(width, height), null, `${width} x ${height}: no problem`);
  }
  // 3:2 and 2:3 (the format of most cameras) and others are never sent to the model: the maker takes "auto" and nobody knows yet what
  // OpenRouter does without a value (it took 16:9 for Gen-4.5 and cropped)
  assert.equal(ratioFor(1500, 1000), null);
  assert.deepEqual(plain(problem(1500, 1000)), { allowed: FORMATS, width: 1500, height: 1000, ratio: '3:2' });
  assert.equal(problem(1000, 1500).ratio, '2:3');
  assert.equal(problem(1250, 1000).ratio, '5:4');
  assert.equal(problem(2000, 1000).ratio, '2.00:1', '2:1 is a format of the maker but not of the list');
  // a size that is not known passes where no start image is asked about, and is refused where one is there (fail closed)
  assert.equal(videoModels.frameRatioProblem(FLUX3, null), null);
  assert.deepEqual(plain(videoModels.frameRatioProblem(FLUX3, null, { requireSize: true })), { allowed: FORMATS, unreadable: true, width: 0, height: 0, ratio: null });
  // the refusal: a stable code, both languages, the formats as a sentence, a statement that nothing was charged
  const error = videoModels.frameRatioRefusal({ name: 'FLUX.3 Video' }, problem(1500, 1000));
  assert.equal(error.code, 'VIDEO_FRAME_RATIO');
  assert.equal(error.status, 409);
  assert.deepEqual(plain(error.data), { model: 'FLUX.3 Video', allowed: '21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16', ratio: '3:2', width: 1500, height: 1000 });
  assert.match(error.message, /^FLUX\.3 Video only takes start images in 21:9, 16:9, 4:3, 1:1, 3:4 or 9:16; this one is 3:2 \(1500 x 1000\)\. It is not cropped\./);
  assert.match(error.message, /Use a 21:9, 16:9, 4:3, 1:1, 3:4 or 9:16 start image/);
  assert.match(error.message, /Nothing was charged/);
  assert.match(error.messageDe, /^FLUX\.3 Video nimmt nur Startbilder im Format 21:9, 16:9, 4:3, 1:1, 3:4 oder 9:16; dieses ist 3:2 \(1500 x 1000\)\. Es wird nicht beschnitten\./);
  assert.match(error.messageDe, /nichts berechnet/);
  assert.equal(error.messageDe.includes('ß'), false);
  // two formats read as they always did (Runway Gen-4.5)
  const two = videoModels.frameRatioRefusal({ name: 'Runway Gen-4.5' }, videoModels.frameRatioProblem(RUNWAY, { width: 1000, height: 1000 }));
  assert.match(two.message, /only takes start images in 16:9 or 9:16; this one is 1:1/);
  assert.match(two.messageDe, /nur Startbilder im Format 16:9 oder 9:16; dieses ist 1:1/);
  const unreadable = videoModels.frameRatioRefusal({ name: 'FLUX.3 Video' }, videoModels.frameRatioProblem(FLUX3, null, { requireSize: true }));
  assert.equal(unreadable.code, 'VIDEO_FRAME_UNREADABLE');
  assert.match(unreadable.message, /start images in 21:9, 16:9, 4:3, 1:1, 3:4 or 9:16, and the size/);
  assert.match(unreadable.messageDe, /Startbilder im Format 21:9, 16:9, 4:3, 1:1, 3:4 oder 9:16, und die Grösse/);
  console.log('   ok testFrameRatio');
}

/* ---------- the card of the chat ---------- */

async function testCard(sessionId) {
  patch(discovery, 'listVideoModels', async () => CATALOG);
  const asset = async (width, height) => (await store.saveAsset(sessionId, { kind: 'upload', buffer: pngOf(width, height), ext: '.png', prompt: 'seed' })).id;
  const ids = (options) => options.map((option) => option.id);
  const everyone = [SEEDANCE, FAST, KLING, WAN, VEO, RUNWAY, FLUX3];

  // seven models in all (MAX_OPTIONS is 7: the grid wraps), with the price and the key of their texts
  let listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 6 }, SEEDANCE);
  assert.deepEqual(ids(listed.options), everyone, 'all seven curated models fit one card');
  const flux = listed.options.find((option) => option.id === FLUX3);
  assert.equal(flux.name, 'FLUX.3 Video');
  assert.equal(flux.profileKey, 'flux3Video');
  assert.equal(flux.durationSeconds, 6);
  assert.equal(flux.resolution, '720p', 'the card asks for 720p when nothing is wanted');
  near(flux.price.maxTotal, 1.02, '6 s at 0.17');
  near(flux.estimateUsd, 1.02, 'what the budget reserves');
  assert.deepEqual(plain(flux.capabilities), { resolutions: ['720p', '1080p'], aspectRatios: FORMATS, durations: range(5, 20), firstFrame: true, audio: true });
  assert.equal(listed.options.filter((option) => option.recommended).length, 1);
  assert.equal(listed.options.find((option) => option.recommended).id, SEEDANCE, 'the recommendation is the default model');
  assert.deepEqual(listed.options.map((option) => option.profileKey), ['seedance25', 'seedanceFast', 'klingStandard', 'wan27', 'veoLite', 'runwayGen45', 'flux3Video']);
  // the editor of the same maker is not on the card, however complete the catalog is
  assert.equal(ids(listed.options).includes(FLUX_EDIT), false);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6 }, FLUX3)).options)[0], FLUX3, 'configured as the default it comes first and only once');

  // eight candidates (a configured default that is not on the list): the list is cut at seven, from the end, so FLUX.3 falls off
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 6 }, EXTRA);
  assert.deepEqual(ids(listed.options), [EXTRA, SEEDANCE, FAST, KLING, WAN, VEO, RUNWAY], 'eight candidates, seven shown');
  assert.equal(videoModels.MAX_PENDING_PER_SESSION, 20);

  // the limits of the metadata: 5 to 20 s (a range is clamped, not refused)
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 4 }, SEEDANCE);
  const short = listed.options.find((option) => option.id === FLUX3);
  assert.equal(short.durationSeconds, 5, '4 s is raised to 5 s');
  near(short.price.maxTotal, 0.85, 'and priced as 5 s');
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 25 }, SEEDANCE);
  const long = listed.options.find((option) => option.id === FLUX3);
  assert.equal(long.durationSeconds, 20, '25 s is clamped to 20 s');
  near(long.price.maxTotal, 3.4, 'and priced as 20 s');
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 12 }, SEEDANCE);
  assert.equal(listed.options.find((option) => option.id === FLUX3).durationSeconds, 12, 'every whole second in between is taken as it is');
  // 720p and 1080p, nothing else
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, resolution: '480p' }, SEEDANCE)).options).includes(FLUX3), false, '480p: not offered');
  listed = await videoModels.listOptions({ prompt: 'x', duration_seconds: 10, resolution: '1080p' }, SEEDANCE);
  const fhd = listed.options.find((option) => option.id === FLUX3);
  assert.ok(fhd, '1080p: offered');
  assert.equal(fhd.resolution, '1080p');
  near(fhd.price.minTotal, 1.7, '10 s at 1080p (low)');
  near(fhd.price.maxTotal, 2.9, '10 s at 1080p (high)');
  near(fhd.estimateUsd, 2.9, 'the card reserves the upper end');
  // text to video: the six formats of the list; 3:2 is not one of them
  for (const ratio of FORMATS) assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, aspect_ratio: ratio }, SEEDANCE)).options).includes(FLUX3), true, ratio);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, aspect_ratio: '3:2' }, SEEDANCE)).options).includes(FLUX3), false, 'text to video in 3:2: not offered');
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, aspect_ratio: '2:3' }, SEEDANCE)).options).includes(FLUX3), false);
  // reference files: FLUX.3 takes none (the start image is no reference)
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, reference_asset_ids: ['a'] }, SEEDANCE)).options).includes(FLUX3), false);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, reference_video_asset_ids: ['a'] }, SEEDANCE)).options).includes(FLUX3), false);
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, reference_audio_asset_ids: ['a'] }, SEEDANCE)).options).includes(FLUX3), false);

  // the start image: the six formats are offered; 3:2 and 2:3 are not, and the other models stay
  const cases = [
    [await asset(160, 90), true, '16:9'],
    [await asset(90, 160), true, '9:16'],
    [await asset(100, 100), true, '1:1'],
    [await asset(120, 90), true, '4:3'],
    [await asset(90, 120), true, '3:4'],
    [await asset(210, 90), true, '21:9'],
    [await asset(192, 109), true, '1.76:1 is within the tolerance of 16:9'],
    [await asset(150, 100), false, '3:2'],
    [await asset(100, 150), false, '2:3']
  ];
  for (const [id, offered, label] of cases) {
    const args = { prompt: 'x', duration_seconds: 6, first_frame_asset_id: id };
    const withFrame = await videoModels.listOptions(args, SEEDANCE, { sessionId });
    assert.equal(withFrame.requirements.mode, 'image_to_video');
    assert.equal(ids(withFrame.options).includes(FLUX3), offered, label);
    assert.deepEqual(ids(withFrame.options).filter((model) => model !== FLUX3 && model !== RUNWAY), [SEEDANCE, FAST, KLING, WAN, VEO], `${label}: the models without a format limit are all there`);
    // the plan of the chat decides the same
    const planned = await videoModels.plan({ sessionId, args, defaultModel: SEEDANCE });
    assert.equal(planned.kind, 'card');
    assert.equal(ids(planned.options).includes(FLUX3), offered, `${label}: plan`);
  }
  // without the session the size is not known: the model stays on the card and the call is refused later (testPayloadAndNode)
  const photo = cases[7][0];
  assert.equal(ids((await videoModels.listOptions({ prompt: 'x', duration_seconds: 6, first_frame_asset_id: photo }, SEEDANCE)).options).includes(FLUX3), true);
  // a card with a request keeps what it showed: the request stores the options as they were, and a click on another model is refused
  const askArgs = { prompt: 'x', duration_seconds: 6, first_frame_asset_id: photo };
  const request = await videoModels.createRequest({ sessionId, args: askArgs, plan: await videoModels.plan({ sessionId, args: askArgs, defaultModel: SEEDANCE }), user: 'tester' });
  assert.equal(request.options.some((option) => option.id === FLUX3), false);
  await assert.rejects(videoModels.beginRequest({ sessionId, requestId: request.id, selectedModel: FLUX3 }), /nicht verf/, 'a click on a model that is not on the card is refused');
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
    return { id: `flux-job-${jobCounter}`, status: 'pending' };
  });
  videoNodeModels.reset();

  const upload = async (width, height) => assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: pngOf(width, height), ext: '.png', prompt: 'seed' })).id);
  const tall = await upload(720, 1280); // 9:16, the size of the live test of Gen-4.5
  const wide = await upload(1280, 720);
  const square = await upload(1000, 1000);
  const photo = await upload(1500, 1000); // 3:2
  const photoTall = await upload(1000, 1500); // 2:3
  const config = { imageModel: 'openai/gpt-image-2', videoModel: SEEDANCE };

  /* ----- the tool layer: the format of the start image is checked before anything is paid ----- */
  const capabilities = { resolutions: ['720p', '1080p'], durations: { min: 5, max: 20 }, aspectRatios: FORMATS };
  const toolCtx = (model) => ({ nodeView: true, sessionId, user: 'tester', config: { ...config, videoModel: model }, emit() {} });
  let refused = await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: photo.assetId, duration_seconds: 5 }, { capabilities }).catch((error) => error);
  assert.equal(refused.code, 'VIDEO_FRAME_RATIO');
  assert.deepEqual(plain(refused.data), { model: 'FLUX.3 Video', allowed: '21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16', ratio: '3:2', width: 1500, height: 1000 });
  assert.match(refused.messageDe, /nimmt nur Startbilder im Format 21:9, 16:9, 4:3, 1:1, 3:4 oder 9:16; dieses ist 3:2 \(1500 x 1000\)/);
  refused = await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: photoTall.assetId, duration_seconds: 5 }, { capabilities }).catch((error) => error);
  assert.equal(refused.code, 'VIDEO_FRAME_RATIO');
  assert.equal(refused.data.ratio, '2:3');
  assert.equal(payloads.length, 0, 'nothing was sent');
  // image to video: the first frame, the resolution and the length of the card, and the format of the start image as aspect_ratio
  const built = await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: tall.assetId, duration_seconds: 5 }, { capabilities });
  assert.equal(built.payload.model, FLUX3);
  assert.equal(built.payload.prompt, 'x');
  assert.equal(built.payload.resolution, '720p', 'nothing asked for: 720p');
  assert.equal(built.payload.duration, 5);
  assert.equal(built.payload.aspect_ratio, '9:16', 'the format of the start image is sent');
  assert.deepEqual(built.payload.frame_images.map((frame) => [frame.type, frame.frame_type]), [['image_url', 'first_frame']]);
  assert.match(built.payload.frame_images[0].image_url.url, /^data:image\/png;base64,/);
  for (const field of ['generate_audio', 'input_references', 'seed', 'size', 'provider']) assert.equal(field in built.payload, false, `no ${field}: the sound is on by default and the model takes no references`);
  assert.deepEqual(Object.keys(built.payload).sort(), ['aspect_ratio', 'duration', 'frame_images', 'model', 'prompt', 'resolution']);
  // 1080p, and the other formats
  const full = await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: wide.assetId, duration_seconds: 10, resolution: '1080p' }, { capabilities });
  assert.equal(full.payload.resolution, '1080p');
  assert.equal(full.payload.duration, 10);
  assert.equal(full.payload.aspect_ratio, '16:9');
  assert.equal((await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: square.assetId, duration_seconds: 5 }, { capabilities })).payload.aspect_ratio, '1:1');
  // the length is held to the limits of the list (the chat clamps; the card has done so already)
  assert.equal((await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: tall.assetId, duration_seconds: 4 }, { capabilities })).payload.duration, 5);
  assert.equal((await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: tall.assetId, duration_seconds: 25 }, { capabilities })).payload.duration, 20);
  // text to video: the format that was asked for, if the model takes it
  assert.equal((await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', duration_seconds: 6, aspect_ratio: '9:16' }, { capabilities })).payload.aspect_ratio, '9:16');
  assert.equal('aspect_ratio' in (await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', duration_seconds: 6, aspect_ratio: '3:2' }, { capabilities })).payload, false, 'a format the list does not name is dropped (the node refuses it before)');
  assert.equal(payloads.length, 0, 'building a request sends nothing');
  // an end frame (the node only): the end frame goes out as it is, its format is not checked (per live test: nobody knows what the model does)
  const withEnd = await tools.buildVideoPayload(toolCtx(FLUX3), { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: wide.assetId, last_frame_asset_id: photo.assetId, duration_seconds: 5 }, { capabilities });
  assert.deepEqual(withEnd.payload.frame_images.map((frame) => frame.frame_type), ['first_frame', 'last_frame']);
  assert.equal(withEnd.payload.aspect_ratio, '16:9', 'the start image decides the format');
  // the chat has no end frame argument
  const noEnd = await tools.buildVideoPayload({ ...toolCtx(FLUX3), nodeView: false }, { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: wide.assetId, last_frame_asset_id: photo.assetId, duration_seconds: 5 }, { capabilities });
  assert.deepEqual(noEnd.payload.frame_images.map((frame) => frame.frame_type), ['first_frame']);

  /* ----- the node "Generate video" ----- */
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const def = registry.get('video.generate');
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
        await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), 1.02);
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
  const run = (inputs, rawParams = {}) => def.execute(makeCtx(), inputs, registry.normalizeParams(def, { model: FLUX3, ...rawParams }));
  const lastJob = async () => (await store.readSession(sessionId)).jobs.slice(-1)[0];

  // the model is on the list of the node with its limits and its price
  await videoNodeModels.load();
  assert.ok(videoNodeModels.allowedModels(config).includes(FLUX3));
  assert.equal(videoNodeModels.isAllowed(config, FLUX3), true);
  assert.equal(videoNodeModels.isAllowed(config, FLUX_EDIT), false, 'FLUX Video Edit is no generator: it is not on the list of this node');
  assert.equal(videoNodeModels.displayName(FLUX3), 'FLUX.3 Video');
  assert.deepEqual(plain(videoNodeModels.limits(FLUX3)), { images: 0, videos: 0, audios: 0, firstFrame: 1, lastFrame: 1 });
  const at720 = videoNodeModels.estimate(FLUX3, { duration: 5 });
  near(at720.price.maxTotal, 0.85, 'the node shows the same price as the card: 5 s at 720p = 0.85 USD');
  assert.equal(at720.resolution, '720p');
  const at1080 = videoNodeModels.estimate(FLUX3, { duration: 10, resolution: '1080p' });
  assert.equal(at1080.resolution, '1080p');
  near(at1080.price.minTotal, 1.7, '10 s at 1080p (low)');
  near(at1080.price.maxTotal, 2.9, '10 s at 1080p (high)');
  near(at1080.option.estimateUsd, 2.9, 'what a participant reserves');
  near(videoNodeModels.estimate(FLUX3, { duration: 5, resolution: 'auto' }).price.maxTotal, 0.85, 'auto is 720p');
  assert.deepEqual(plain(videoNodeModels.settings(FLUX3, { duration: 3 })).duration, 5);
  assert.deepEqual(plain(videoNodeModels.settings(FLUX3, { duration: 30 })).duration, 20);
  assert.deepEqual(plain(videoNodeModels.settings(FLUX3, { resolution: '480p' })), { error: 'resolution', values: ['720p', '1080p'] });
  const offered = (await videoNodeModels.options({ config })).find((item) => item.value === FLUX3);
  assert.ok(offered, 'in the model list of the node');
  assert.equal(offered.label, 'FLUX.3 Video');
  assert.deepEqual(plain(offered.durations), { min: 5, max: 20 });
  assert.deepEqual(plain(offered.perSecondUsd), { min: 0.17, max: 0.17 }, 'the list shows the price of 720p, the resolution the node starts with');
  assert.deepEqual(plain(offered.references), { max: 0, roles: [], required: false });
  assert.deepEqual(plain(offered.last_frame), { max: 1 }, 'the end frame: one');
  assert.equal('minimumUsd' in offered, false);
  assert.deepEqual(plain(videoNodeModels.aspectRatios(FLUX3)), FORMATS);
  // the plan of the node: the price of the card, at the resolution that is chosen
  const planned = (rawParams) => def.cost.estimate(registry.normalizeParams(def, { model: FLUX3, ...rawParams }), { connected: new Set() });
  near(planned({ duration: 5 }).usd, 0.85, 'the plan at 720p');
  near(planned({ duration: 10, resolution: '720p' }).usd, 1.7, '10 s at 720p');
  near(planned({ duration: 10, resolution: '1080p' }).usd, 2.9, '10 s at 1080p: the upper end');
  near(planned({ duration: 20, resolution: '1080p' }).usd, 5.8, '20 s at 1080p');
  near(planned({ duration: 2 }).usd, 0.85, '2 s are raised to 5 s');

  // a run: text to video in 9:16 at 1080p
  payloads.length = 0;
  let out = await run({ prompt: text('A fox in the snow') }, { duration: 10, aspect_ratio: '9:16', resolution: '1080p' });
  assert.equal(payloads.length, 1);
  assert.deepEqual(plain(payloads[0]), { model: FLUX3, prompt: 'A fox in the snow', resolution: '1080p', duration: 10, aspect_ratio: '9:16' });
  assert.equal(out.variants[0].video.type, 'video');
  let job = await lastJob();
  assert.equal(job.model, FLUX3);
  assert.equal(job.modelName, 'FLUX.3 Video');
  near(job.estimateUsd, 2.9, 'the job shows the estimate the budget reserved');
  // resolution "auto" is 720p; a length below the minimum is made 5 s and priced as 5 s
  payloads.length = 0;
  await run({ prompt: text('x') }, { duration: 3 });
  assert.deepEqual(plain(payloads[0]), { model: FLUX3, prompt: 'x', resolution: '720p', duration: 5, aspect_ratio: '16:9' });
  near((await lastJob()).estimateUsd, 0.85, '5 s at 720p');
  // image to video with a start image: its own format goes out; no ratio of the node
  payloads.length = 0;
  await run({ prompt: text('x'), first_frame: tall }, { duration: 5 });
  assert.deepEqual(plain({ ...payloads[0], frame_images: payloads[0].frame_images.map((frame) => frame.frame_type) }), { model: FLUX3, prompt: 'x', resolution: '720p', duration: 5, aspect_ratio: '9:16', frame_images: ['first_frame'] });
  // ... and with an end frame (the node takes one)
  payloads.length = 0;
  await run({ prompt: text('x'), first_frame: tall, last_frame: { type: 'list', itemType: 'image', items: [tall] } }, { duration: 8, resolution: '1080p' });
  assert.deepEqual(plain({ ...payloads[0], frame_images: payloads[0].frame_images.map((frame) => frame.frame_type) }), { model: FLUX3, prompt: 'x', resolution: '1080p', duration: 8, aspect_ratio: '9:16', frame_images: ['first_frame', 'last_frame'] });
  near((await lastJob()).estimateUsd, 2.32, '8 s at 1080p: 8 x 0.29');
  for (const field of ['generate_audio', 'input_references']) assert.equal(field in payloads[0], false, `no ${field}`);

  // the limits are checked before the run: no reference files, 480p, 3:2 text to video, an end frame needs a start frame
  const issues = (rawParams, ports) => (def.validate(registry.normalizeParams(def, { model: FLUX3, ...rawParams }), ports) || []).map((issue) => (typeof issue === 'string' ? { code: 'invalid', message: issue } : issue));
  const connected = (counts) => Object.fromEntries(Object.entries(counts).map(([port, count]) => [port, { connected: count > 0, count }]));
  assert.deepEqual(issues({}, connected({ first_frame: 1, last_frame: 1 })).map((issue) => issue.code), [], 'a first and a last frame are fine');
  assert.deepEqual(issues({}, connected({ last_frame: 1 })).map((issue) => issue.code), ['VIDEO_LAST_FRAME_NEEDS_FIRST']);
  assert.deepEqual(issues({}, connected({ refs: 1 })).map((issue) => issue.code), ['too_many_refs']);
  assert.deepEqual(issues({}, connected({ ref_videos: 1 })).map((issue) => issue.code).filter((code) => code === 'VIDEO_TOO_MANY_REF_VIDEOS'), ['VIDEO_TOO_MANY_REF_VIDEOS']);
  assert.deepEqual(issues({ resolution: '480p' }, connected({})).map((issue) => issue.code), ['VIDEO_RESOLUTION_UNSUPPORTED']);
  assert.deepEqual(issues({ resolution: '1080p' }, connected({})).map((issue) => issue.code), []);
  assert.deepEqual(issues({ aspect_ratio: '3:2' }, connected({})).map((issue) => issue.code), ['VIDEO_ASPECT_RATIO_UNSUPPORTED'], 'text to video in a format the list does not name (the node offers none of them)');
  for (const ratio of FORMATS) assert.deepEqual(issues({ aspect_ratio: ratio }, connected({})).map((issue) => issue.code), [], ratio);
  assert.deepEqual(issues({ aspect_ratio: '3:2' }, connected({ first_frame: 1 })).map((issue) => issue.code), [], 'with a start image its own format counts, not the ratio of the node');

  // a start image of another format: refused before anything is sent, with a stable code
  payloads.length = 0;
  const before = (await store.readSession(sessionId)).jobs.length;
  const journalBefore = journal.length;
  const noPhoto = await run({ prompt: text('x'), first_frame: photo }, { duration: 5 }).catch((error) => error);
  assert.equal(noPhoto.code, 'VIDEO_FRAME_RATIO');
  assert.deepEqual(plain(noPhoto.data), { model: 'FLUX.3 Video', allowed: '21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16', ratio: '3:2', width: 1500, height: 1000 });
  assert.equal(payloads.length, 0, 'the provider was not called');
  assert.equal((await store.readSession(sessionId)).jobs.length, before, 'no job');
  assert.equal(journal.length, journalBefore, 'nothing was booked');
  // a square image is fine, and goes out as 1:1
  await run({ prompt: text('x'), first_frame: square }, { duration: 5 });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].aspect_ratio, '1:1');

  // the text of the code in every language, with a value for every placeholder
  const nodeTexts = loadNodeTexts();
  for (const lang of ['de', 'en', 'es']) {
    const message = nodeTexts[lang]['nodes.issue.VIDEO_FRAME_RATIO'];
    assert.ok(message, `${lang}: VIDEO_FRAME_RATIO`);
    assert.equal(message.includes('ß'), false);
    for (const name of new Set((message.match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))) assert.ok(noPhoto.data[name] !== undefined, `${lang}: {${name}} has a value`);
  }
  console.log('   ok testPayloadAndNode');
}

/* ---------- the texts of the card ---------- */

function testCardTexts() {
  const dictionaries = loadChatTexts();
  const fields = ['summary', 'pro', 'con'];
  for (const lang of ['de', 'en', 'es']) {
    for (const field of fields) {
      const value = dictionaries[lang][`videoModel.profile.flux3Video.${field}`];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}: videoModel.profile.flux3Video.${field}`);
      assert.equal(value.includes('ß'), false, `${lang}.${field}: no sharp s`);
      assert.equal(/\s{2,}|^\s|\s$/.test(value), false, `${lang}.${field}: no stray white space`);
    }
  }
  // strengths: clips up to 20 s, the sound is made with the picture; weaknesses: at least 5 s, the formats of a start image, no reference files
  const patterns = {
    de: { pro: [/20 s/, /Ton/], con: [/5 s/, /Referenz/, /3:4 oder 9:16/] },
    en: { pro: [/20 s/, /sound/], con: [/5 s/, /reference/, /3:4 or 9:16/] },
    es: { pro: [/20 s/, /sonido/], con: [/5 s/, /referencia/, /3:4 o 9:16/] }
  };
  for (const lang of ['de', 'en', 'es']) {
    const all = fields.map((field) => dictionaries[lang][`videoModel.profile.flux3Video.${field}`]).join(' ');
    const pro = dictionaries[lang]['videoModel.profile.flux3Video.pro'];
    const con = dictionaries[lang]['videoModel.profile.flux3Video.con'];
    for (const pattern of patterns[lang].pro) assert.match(pro, pattern, `${lang}: ${pro}`);
    for (const pattern of patterns[lang].con) assert.match(con, pattern, `${lang}: ${con}`);
    assert.match(dictionaries[lang]['videoModel.profile.flux3Video.summary'], /Black Forest Labs/, `${lang}: the maker is named`);
    // the card of the chat runs at 720p and has no end frame: the texts promise neither
    assert.doesNotMatch(all, /1080|Endbild|end frame|imagen final|última/i, `${lang}: ${all}`);
  }
  // the other texts are as they were
  assert.equal(dictionaries.de['videoModel.profile.klingStandard.summary'], 'Gute Mimik und natürliche Bewegung für kurze Clips.');
  assert.equal(dictionaries.en['videoModel.profile.runwayGen45.con'], '720p only, 16:9 or 9:16 only, at most 10 s, no sound, no reference files.');
  assert.equal(dictionaries.es['videoModel.profile.veoLite.pro'], 'Buena fidelidad de imagen para su precio.');
  // the key of the profile is the one the texts are written for
  assert.equal(videoModels.publicOption(FLUX3_ENTRY, { mode: 'text_to_video', aspectRatio: '', hasVideoInput: false }, { duration: 5, resolution: '720p' }, SEEDANCE).profileKey, 'flux3Video');
  console.log('   ok testCardTexts');
}

async function main() {
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
  console.log('test-flux-3-video.js: ok');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
