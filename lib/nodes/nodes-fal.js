'use strict';

// fal.ai node types (category `fal`): the MiniMax H3 Max endpoints, background removal, image to 3D (four models), segmenting
// a video (SAM 3) and a free-form fal model node.
// Everything is a thin adapter over the node-only tool `fal_generate` (lib/tools.js): the executors check ALL inputs
// first (params, number and kind of the connections, durations and aspect ratios that ffprobe can measure, sizes),
// build the model input exactly as docs/fal-h3-max.json describes it and only then call the tool, which uploads the
// media and queues the job. The poller (lib/poller.js) fetches the result. Nothing here talks to fal.ai directly, with one
// exception: fal.video_segment uploads the video it prepared itself (planVideoSegment says why and which checks that repeats).
//
// Status: NOT verified against the live API (the schemas and list prices come from docs/fal-h3-max.json, fetched
// 2026-09-29), hence every node is `experimental` - except image to 3D, which all four models ran live on 2026-10-03.
// fal.video_segment is experimental as well: its endpoint ran in a paid mini test on 2026-10-03 (notes at the node), the node itself has not.
// minimax/h3-max/director is a realtime WebRTC endpoint (no queue API) and is deliberately not offered.

const fsp = require('fs/promises');
const path = require('path');

const fal = require('../fal');
const ffmpeg = require('../ffmpeg');
const store = require('../store');
const tools = require('../tools');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const videoPrep = require('./video-prep');
const { textValue, isPlainObject } = require('./types');

const MB = 1024 * 1024;
const MAX_PROMPT = 50000;
const MAX_STYLE_PROMPT = 49800; // the style endpoints reserve part of the 50000 characters for their style text
const MAX_3D_PROMPT = 2000;
// The poller gives a fal job 90 minutes; the node waits a little longer so the poller's own message wins.
const FAL_WAIT_MS = 95 * 60 * 1000;
const NODE_TIMEOUT_MS = 100 * 60 * 1000;
const MAX_RESULT_JSON = 50 * 1024;

/* ---------- list prices (USD per generated second) ---------- */

// Source: docs/fal-h3-max.json (fetched 2026-09-29). These are the list prices AFTER the launch discounts end on
// 2026-09-30. Reference tokens above the free allowance and generated reference images are not estimated.
const PRICES = Object.freeze({
  source: 'docs/fal-h3-max.json',
  fetched: '2026-09-29',
  listPricesFrom: '2026-09-30',
  max: Object.freeze({ '480P': 0.05, '768P': 0.08, '1080P': 0.16, '2K': 0.32 }),
  turbo: Object.freeze({ '480P': 0.025, '768P': 0.04, '1080P': 0.08 }),
  insert: Object.freeze({ '480p': 0.05, '768p': 0.06 }),
  style: 0.08,
  lipsyncOverSeconds: 15,
  lipsyncOverMultiplier: 1.2,
  // fal.remove_background: Bria RMBG 2.0, a flat price per image. Source: https://fal.ai/models/fal-ai/bria/background/remove/llms.txt
  // ("Price: $0.018 per generations", fetched 2026-10-02; schema from https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/bria/background/remove).
  removeBackground: Object.freeze({ endpoint: 'fal-ai/bria/background/remove', usd: 0.018, fetched: '2026-10-02' }),
  // fal.image_to_3d: list prices in USD per generation, fetched 2026-10-02 from the "Pricing" section of
  //   https://fal.ai/models/<endpoint>/llms.txt (the schemas: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>).
  // Everything that changes the price is sent explicitly (texture, pbr, quality, quad, rigging, animation), so the estimate
  // below is what fal bills for exactly the request that is made. Options that cost extra but are not offered stay at their
  // price list entry for completeness (Tripo quad, Meshy rigging and animation) and are always sent switched off.
  image3d: Object.freeze({
    fetched: '2026-10-02',
    // tripo3d/h3.1/image-to-3d and tripo3d/h3.1/multiview-to-3d (same prices): "$0.20 (without textures), $0.30 (with standard
    // textures), or $0.40 (with HD textures), plus an additional $0.20 for detailed geometry and $0.05 for quad mesh".
    tripo: Object.freeze({
      endpoint: 'tripo3d/h3.1/image-to-3d',
      multiviewEndpoint: 'tripo3d/h3.1/multiview-to-3d',
      noTexture: 0.2,
      texture: 0.3,
      hdTexture: 0.4,
      detailedGeometry: 0.2,
      quad: 0.05
    }),
    // fal-ai/hunyuan-3d/v3.1/pro/image-to-3d: "$0.375 per generation. Enabling PBR materials adds $0.15. Using multi-view
    // images adds $0.15. Custom face count adds $0.15." (one surcharge for the extra views, however many there are)
    hunyuan: Object.freeze({ endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', base: 0.375, pbr: 0.15, extraViews: 0.15, ownFaceCount: 0.15 }),
    // meshy/v7.1/multi-image-to-3d: "A base model without textures costs $0.80. Adding textures brings the total to $1.20.
    // Optional auto-rigging adds $0.20, and animation adds $0.12". PBR maps have no surcharge on that page.
    meshy: Object.freeze({ endpoint: 'meshy/v7.1/multi-image-to-3d', noTexture: 0.8, texture: 1.2, rigging: 0.2, animation: 0.12 }),
    // fal-ai/sam-3/3d-objects: "$0.02 per unit". The page does not say what a unit is (probably one reconstructed object);
    // one object is assumed, so a scene with several objects may cost more than the estimate. A real run (2026-10-03, one object)
    // was billed 1.00 unit = 0.02 USD in the fal dashboard, as estimated.
    sam3d: Object.freeze({ endpoint: 'fal-ai/sam-3/3d-objects', perUnit: 0.02 })
  }),
  // fal.video_segment: SAM 3 on video (fal-ai/sam-3/video). List price 0.005 USD per 16 frames of the INPUT video, that is of
  // the prepared file the node uploads (confirmed by the fal pricing API on 2026-10-03). A started block of 16 frames is
  // counted as a whole (rounded up; assumed, not read from the page). Schema (fetched 2026-10-02):
  //   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/sam-3/video
  videoSegment: Object.freeze({ endpoint: 'fal-ai/sam-3/video', usdPerBlock: 0.005, framesPerBlock: 16, fetched: '2026-10-03' })
});

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

function secondsPrice(perSecond, seconds) {
  return Number.isFinite(perSecond) && Number.isFinite(seconds) && seconds > 0 ? roundUsd(perSecond * seconds) : null;
}

/* ---------- shared helpers ---------- */

function falAvailable() {
  return fal.hasKey() ? true : 'FAL_KEY is not set';
}

// fal.video_segment prepares the video with ffmpeg first, so it needs the tools as well as the key (the key is named first).
function videoSegmentAvailable() {
  const key = falAvailable();
  if (key !== true) return key;
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

function shortMessage(err) {
  return String(err?.message || err).slice(0, 200);
}

function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

function assetIdsOf(ctx, values) {
  return values.map((value) => {
    if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);
    return value.assetId;
  });
}

function limitCheck(items, max, label) {
  if (items.length > max) throw new Error(`${label}: at most ${max} are allowed (got ${items.length})`);
}

function promptOf(inputs, { required = false, max = MAX_PROMPT } = {}) {
  const text = inputs.prompt ? String(inputs.prompt.value).trim() : '';
  if (required && !text) throw new Error('prompt: enter a prompt or connect a text');
  if ([...text].length > max) throw new Error(`prompt: at most ${max} characters are allowed (got ${[...text].length})`);
  return text;
}

// Size, duration and dimensions of a media value. Sizes always come from the file; duration and dimensions from
// ffprobe when it is installed (otherwise from the value, or unknown = null: such checks are skipped).
async function inspectMedia(ctx, value, label) {
  assetIdsOf(ctx, [value]); // only assets of this workflow's session
  const file = assets.assetFilePath(value);
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch (_) {
    throw new Error(`${label}: the file is missing`);
  }
  const info = { size, duration: Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null, width: null, height: null };
  const binaries = ffmpeg.binaries();
  if (binaries.available) {
    let probe;
    try {
      probe = await ctx.withLocalSlot(() => ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal }));
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      throw new Error(`${label}: the file could not be analysed (${shortMessage(err)})`);
    }
    if (probe.duration) info.duration = probe.duration;
    if (probe.video) {
      info.width = probe.video.width || null;
      info.height = probe.video.height || null;
    }
  }
  return info;
}

function checkDuration(info, label, { min, max }) {
  if (info.duration === null) return;
  if (min !== undefined && info.duration < min) throw new Error(`${label}: must be at least ${min} s long (got ${info.duration.toFixed(2)} s)`);
  if (max !== undefined && info.duration > max) throw new Error(`${label}: must be at most ${max} s long (got ${info.duration.toFixed(2)} s)`);
}

function checkRatio(info, label, { min, max }) {
  if (!info.width || !info.height) return;
  const ratio = info.width / info.height;
  if (ratio < min || ratio > max) {
    throw new Error(`${label}: the aspect ratio (width / height) must be between ${min} and ${max} (got ${ratio.toFixed(2)})`);
  }
}

function checkSize(info, label, maxBytes) {
  if (info.size > maxBytes) throw new Error(`${label}: at most ${Math.round(maxBytes / MB)} MB are allowed (got ${(info.size / MB).toFixed(1)} MB)`);
}

function totalDuration(infos) {
  return infos.reduce((sum, info) => sum + (info.duration || 0), 0);
}

// Reads the small metadata the poller stored on the job (seed, expanded prompt, duration, result JSON).
async function readJob(ctx, job) {
  try {
    const session = await store.readSession(ctx.sessionId);
    return (session.jobs || []).find((entry) => entry.assetId === job.assetId) || null;
  } catch (_) {
    return null;
  }
}

// Queues the job through the tool, waits for the poller and returns the result value, the job metadata and the cost.
async function runFal(ctx, plan) {
  // A cancelled run must not start a paid job (the uploads before the submit can take minutes).
  if (ctx.signal?.aborted) throw fal.abortError();
  const outcome = await tools.executeTool(ctx.toolCtx, 'fal_generate', {
    endpoint: plan.endpoint,
    input: plan.input,
    media: plan.media,
    kind: plan.kind || 'video',
    estimateUsd: plan.estimateUsd === undefined ? null : plan.estimateUsd,
    pricing: plan.pricing || null,
    keepResult: plan.keepResult === true
  });
  for (const note of outcome.corrections || []) ctx.log(note);
  const ids = await ctx.waitForJob(outcome.job, { timeoutMs: FAL_WAIT_MS });
  const value = await assets.valueFromAsset(ctx.sessionId, ids[0]);
  const meta = await readJob(ctx, outcome.job);
  const known = await assets.ledgerCosts(ctx.sessionId, ids);
  return { value, meta, ids, cost: typeof known === 'number' ? { usd: known } : undefined };
}

function videoResult(outcome, { withExpanded = false, prompt = '' } = {}) {
  const variant = { video: outcome.value };
  if (withExpanded) variant.expanded_prompt = textValue(outcome.meta?.expanded_prompt || prompt);
  return { variants: [variant], cost: outcome.cost };
}

function mediaEntry(field, ctx, values, multiple = false) {
  return { field, assetIds: assetIdsOf(ctx, values), multiple };
}

function pricingFor(perSecond, extra = {}) {
  return { perSecond, durationField: 'duration', ...extra };
}

/* ---------- shared params ---------- */

const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const EXPANSION_MODES = ['disabled', 'balanced', 'quality'];

const PROMPT_PARAM = { id: 'prompt', kind: 'textarea', default: '', inline: true };
const SEED_PARAM = { id: 'seed', kind: 'integer', min: 0, max: 2147483647, optional: true, default: null };
const SAFETY_PARAM = { id: 'safety', kind: 'boolean', default: true };
const EXPANSION_MODE_PARAM = { id: 'prompt_expansion', kind: 'select', options: EXPANSION_MODES, default: 'balanced' };
const EXPANSION_FLAG_PARAM = { id: 'prompt_expansion', kind: 'boolean', default: true };
const NO_FIRST_FRAME = { port: 'first_frame', connected: false };
// H3 Max video sends the ratio only in text-to-video mode: neither a first nor a last frame may be connected.
const NO_FRAMES = { ports: ['first_frame', 'last_frame'], connected: false };

const promptInput = (required) => ({ id: 'prompt', type: 'text', required, param: 'prompt' });

function withSeed(input, params) {
  if (params.seed !== null && params.seed !== undefined) input.seed = params.seed;
  return input;
}

/* ---------- camera presets ---------- */

const keyframe = (time, azimuth, elevation, distance) => ({ time, azimuth, elevation, distance });

// Camera path presets of fal.h3_camera. Keyframes are { time 0..1, azimuth in degrees, elevation in degrees, distance }.
// Assumptions (not verified live): a positive azimuth moves the camera to the right of the subject, a positive
// elevation up; distance 1 is the framing of the image, smaller is closer. A clip starts at { 0, 0, 0, 1 }.
const CAMERA_PRESETS = Object.freeze({
  orbit_left: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, -90, 0, 1)]),
  orbit_right: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, 90, 0, 1)]),
  orbit_360: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, 360, 0, 1)]),
  dolly_in: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, 0, 0, 0.5)]),
  dolly_out: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, 0, 0, 1.5)]),
  crane_up: Object.freeze([keyframe(0, 0, 0, 1), keyframe(1, 0, 30, 1)]),
  crane_down: Object.freeze([keyframe(0, 0, 30, 1), keyframe(1, 0, 0, 1)])
});
const CAMERA_PRESET_NAMES = Object.freeze([...Object.keys(CAMERA_PRESETS), 'custom']);
const KEYFRAME_FIELDS = Object.freeze(['time', 'azimuth', 'elevation', 'distance']);
const MAX_AZIMUTH_TRAVEL = 32 * 360;

// Strict check of a custom camera path (JSON text): 2 to 12 keyframes with exactly time (0..1, ascending),
// azimuth, elevation (-90..90) and distance (> 0), at most 32 full turns of total azimuth travel.
function parseTrajectory(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (_) {
    throw new Error('trajectory: not valid JSON (expected an array of keyframes)');
  }
  if (!Array.isArray(data)) throw new Error('trajectory: expected a JSON array of keyframes');
  if (data.length < 2 || data.length > 12) throw new Error(`trajectory: 2 to 12 keyframes are required (got ${data.length})`);
  let previousTime = -Infinity;
  let previousAzimuth = null;
  let travel = 0;
  const frames = data.map((frame, index) => {
    const at = `trajectory keyframe ${index + 1}`;
    if (!isPlainObject(frame)) throw new Error(`${at}: expected an object`);
    for (const key of Object.keys(frame)) {
      if (!KEYFRAME_FIELDS.includes(key)) throw new Error(`${at}: unknown field ${key}`);
    }
    for (const key of KEYFRAME_FIELDS) {
      if (typeof frame[key] !== 'number' || !Number.isFinite(frame[key])) throw new Error(`${at}: ${key} must be a number`);
    }
    const { time, azimuth, elevation, distance } = frame;
    if (time < 0 || time > 1) throw new Error(`${at}: time must be between 0 and 1`);
    if (time <= previousTime) throw new Error(`${at}: time must be greater than the previous keyframe`);
    if (elevation < -90 || elevation > 90) throw new Error(`${at}: elevation must be between -90 and 90`);
    if (!(distance > 0)) throw new Error(`${at}: distance must be greater than 0`);
    previousTime = time;
    if (previousAzimuth !== null) travel += Math.abs(azimuth - previousAzimuth);
    previousAzimuth = azimuth;
    return { time, azimuth, elevation, distance };
  });
  if (travel > MAX_AZIMUTH_TRAVEL) throw new Error('trajectory: at most 32 full turns (11520 degrees) of azimuth travel are allowed');
  return frames;
}

function trajectoryFor(params) {
  if (params.preset === 'custom') return parseTrajectory(params.trajectory);
  const preset = CAMERA_PRESETS[params.preset];
  if (!preset) throw new Error(`preset: "${params.preset}" is not a valid option`);
  return preset.map((frame) => ({ ...frame }));
}

/* ---------- fal.h3_video ---------- */

function h3VideoEndpoint(params, withImage) {
  const base = params.model === 'turbo' ? 'minimax/h3-max-turbo' : 'minimax/h3-max';
  return `${base}/${withImage ? 'image-to-video' : 'text-to-video'}`;
}

function h3VideoPrice(params) {
  return (params.model === 'turbo' ? PRICES.turbo : PRICES.max)[params.resolution];
}

async function planH3Video(ctx, inputs, params) {
  const prompt = promptOf(inputs, { required: true });
  const first = inputs.first_frame || null;
  const last = inputs.last_frame || null;
  const audio = inputs.audio || null;
  if (audio) {
    const info = await inspectMedia(ctx, audio, 'audio');
    checkSize(info, 'audio', 15 * MB);
    checkDuration(info, 'audio', { min: 2 });
  }
  const withImage = Boolean(first || last);
  const input = withSeed(
    {
      prompt,
      prompt_expansion_mode: params.prompt_expansion,
      resolution: params.resolution,
      duration: params.duration,
      enable_safety_checker: params.safety
    },
    params
  );
  if (!withImage) input.aspect_ratio = params.aspect_ratio; // the image decides the canvas otherwise
  const media = [];
  if (first) media.push(mediaEntry('image_url', ctx, [first]));
  if (last) media.push(mediaEntry('end_image_url', ctx, [last]));
  if (audio) media.push(mediaEntry('target_audio_url', ctx, [audio]));
  const perSecond = h3VideoPrice(params);
  return {
    endpoint: h3VideoEndpoint(params, withImage),
    input,
    media,
    estimateUsd: secondsPrice(perSecond, params.duration),
    pricing: pricingFor(perSecond),
    prompt
  };
}

/* ---------- fal.h3_reference ---------- */

const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;
const MAX_REF_FILES = 12;

async function planH3Reference(ctx, inputs, params) {
  const prompt = promptOf(inputs, { required: true });
  const images = itemsOf(inputs, 'images');
  const videos = itemsOf(inputs, 'videos');
  const audios = itemsOf(inputs, 'audios');
  limitCheck(images, MAX_REF_IMAGES, 'images');
  limitCheck(videos, MAX_REF_VIDEOS, 'videos');
  limitCheck(audios, MAX_REF_AUDIOS, 'audios');
  if (images.length + videos.length + audios.length > MAX_REF_FILES) {
    throw new Error(`images, videos and audios together: at most ${MAX_REF_FILES} files are allowed (got ${images.length + videos.length + audios.length})`);
  }
  const videoInfos = [];
  for (const [index, video] of videos.entries()) {
    const info = await inspectMedia(ctx, video, `videos[${index + 1}]`);
    checkDuration(info, `videos[${index + 1}]`, { min: 2, max: 15 });
    videoInfos.push(info);
  }
  if (totalDuration(videoInfos) > 15) throw new Error(`videos: together at most 15 s are allowed (got ${totalDuration(videoInfos).toFixed(1)} s)`);
  const audioInfos = [];
  for (const [index, audio] of audios.entries()) {
    const info = await inspectMedia(ctx, audio, `audios[${index + 1}]`);
    checkDuration(info, `audios[${index + 1}]`, { min: 2, max: 15 });
    audioInfos.push(info);
  }
  if (totalDuration(audioInfos) > 15) throw new Error(`audios: together at most 15 s are allowed (got ${totalDuration(audioInfos).toFixed(1)} s)`);

  const input = withSeed(
    {
      prompt,
      prompt_expansion_mode: params.prompt_expansion,
      resolution: params.resolution,
      aspect_ratio: params.aspect_ratio,
      duration: params.duration,
      enable_safety_checker: params.safety
    },
    params
  );
  const media = [];
  if (images.length) media.push(mediaEntry('reference_image_urls', ctx, images, true));
  if (videos.length) media.push(mediaEntry('reference_video_urls', ctx, videos, true));
  if (audios.length) media.push(mediaEntry('reference_audio_urls', ctx, audios, true));
  const perSecond = PRICES.max[params.resolution];
  return {
    endpoint: 'minimax/h3-max/reference-to-video',
    input,
    media,
    estimateUsd: secondsPrice(perSecond, params.duration),
    pricing: pricingFor(perSecond),
    prompt
  };
}

/* ---------- fal.h3_lipsync ---------- */

async function planH3Lipsync(ctx, inputs, params) {
  const image = inputs.image;
  const audio = inputs.audio;
  if (!image) throw new Error('image: connect a portrait image');
  if (!audio) throw new Error('audio: connect the speech audio');
  const imageInfo = await inspectMedia(ctx, image, 'image');
  checkRatio(imageInfo, 'image', { min: 0.4, max: 2.5 });
  const audioInfo = await inspectMedia(ctx, audio, 'audio');
  checkDuration(audioInfo, 'audio', { min: 5, max: 15 * 60 });
  const input = withSeed(
    {
      resolution: params.resolution,
      enable_transcription: params.transcription,
      enable_safety_checker: params.safety
    },
    params
  );
  const perSecond = PRICES.max[params.resolution];
  const seconds = audioInfo.duration;
  let estimateUsd = secondsPrice(perSecond, seconds);
  if (estimateUsd !== null && seconds > PRICES.lipsyncOverSeconds) estimateUsd = roundUsd(estimateUsd * PRICES.lipsyncOverMultiplier);
  return {
    endpoint: 'minimax/h3-max/lip-sync/image-to-video',
    input,
    media: [mediaEntry('image_url', ctx, [image]), mediaEntry('audio_url', ctx, [audio])],
    estimateUsd,
    // the result carries the billed duration: it replaces the estimate when it arrives
    pricing: { perSecond, durationField: 'duration', overSeconds: PRICES.lipsyncOverSeconds, overMultiplier: PRICES.lipsyncOverMultiplier },
    prompt: ''
  };
}

/* ---------- fal.h3_camera ---------- */

async function planH3Camera(ctx, inputs, params) {
  const image = inputs.image;
  if (!image) throw new Error('image: connect an image');
  const prompt = promptOf(inputs);
  const trajectory = trajectoryFor(params);
  const input = withSeed(
    {
      prompt_expansion_mode: params.prompt_expansion,
      resolution: params.resolution,
      duration: params.duration,
      camera_trajectory: trajectory,
      enable_safety_checker: params.safety
    },
    params
  );
  if (prompt) input.prompt = prompt; // blank: fal falls back to "only the camera moves"
  const perSecond = PRICES.max[params.resolution];
  return {
    endpoint: 'minimax/h3-max/camera-controls',
    input,
    media: [mediaEntry('image_url', ctx, [image])],
    estimateUsd: secondsPrice(perSecond, params.duration),
    pricing: pricingFor(perSecond),
    prompt
  };
}

/* ---------- fal.h3_extend ---------- */

async function planH3Extend(ctx, inputs, params) {
  const video = inputs.video;
  if (!video) throw new Error('video: connect the video to extend');
  const prompt = promptOf(inputs, { required: true });
  const info = await inspectMedia(ctx, video, 'video');
  checkSize(info, 'video', 50 * MB);
  checkDuration(info, 'video', { min: 1.625, max: 60 });
  checkRatio(info, 'video', { min: 0.4, max: 2.5 });
  const input = withSeed(
    {
      prompt,
      output: params.output,
      enable_prompt_expansion: params.prompt_expansion,
      enable_safety_checker: params.safety,
      resolution: params.resolution,
      aspect_ratio: params.aspect_ratio,
      duration: params.duration
    },
    params
  );
  const perSecond = PRICES.max[params.resolution];
  return {
    endpoint: 'minimax/h3-max/extend-video',
    input,
    media: [mediaEntry('video_url', ctx, [video])],
    estimateUsd: secondsPrice(perSecond, params.duration),
    // the reported duration may include the source clip: only the requested length is billed
    pricing: pricingFor(perSecond, { durationField: null }),
    prompt
  };
}

/* ---------- fal.h3_insert ---------- */

const MIN_TIME = 1.625;

function insertTimeIssues(params) {
  const issues = [];
  if (params.start_time < MIN_TIME || params.start_time > 60) issues.push('start_time: must be between 1.625 and 60 seconds');
  if (params.resume_time <= MIN_TIME || params.resume_time > 60) issues.push('resume_time: must be greater than 1.625 and at most 60 seconds');
  if (params.resume_time < params.start_time) issues.push('resume_time: must not be before start_time');
  return issues;
}

async function planH3Insert(ctx, inputs, params) {
  const video = inputs.video;
  if (!video) throw new Error('video: connect the video to insert a scene into');
  const prompt = promptOf(inputs);
  const images = itemsOf(inputs, 'images');
  const videos = itemsOf(inputs, 'videos');
  limitCheck(images, MAX_REF_IMAGES, 'images');
  limitCheck(videos, MAX_REF_VIDEOS, 'videos');
  const issues = insertTimeIssues(params);
  if (issues.length) throw new Error(issues[0]);
  const info = await inspectMedia(ctx, video, 'video');
  checkDuration(info, 'video', { min: MIN_TIME, max: 60 });
  if (info.duration !== null && params.start_time >= info.duration) {
    throw new Error(`start_time: must be inside the video (it is ${info.duration.toFixed(2)} s long)`);
  }
  if (info.duration !== null && params.resume_time > info.duration + 0.05) {
    throw new Error(`resume_time: must not be after the end of the video (${info.duration.toFixed(2)} s)`);
  }
  const input = withSeed(
    {
      start_time: params.start_time,
      resume_time: params.resume_time,
      duration: params.duration,
      resolution: params.resolution,
      color_match: params.color_match,
      enable_prompt_expansion: params.prompt_expansion
    },
    params
  );
  if (prompt) input.prompt = prompt;
  const media = [mediaEntry('video_url', ctx, [video])];
  if (images.length) media.push(mediaEntry('reference_image_urls', ctx, images, true));
  if (videos.length) media.push(mediaEntry('reference_video_urls', ctx, videos, true));
  const perSecond = PRICES.insert[params.resolution];
  return {
    endpoint: 'minimax/h3-max/insert-video',
    input,
    media,
    // only the newly generated scene is billed
    estimateUsd: secondsPrice(perSecond, params.duration),
    pricing: pricingFor(perSecond, { durationField: 'injected_duration' }),
    prompt
  };
}

/* ---------- fal.h3_3d ---------- */

const MAX_3D_IMAGES = 8;

async function planH33d(ctx, inputs, params) {
  const video = inputs.video;
  if (!video) throw new Error('video: connect the Blender video');
  const prompt = promptOf(inputs, { max: MAX_3D_PROMPT });
  const images = itemsOf(inputs, 'images');
  limitCheck(images, MAX_3D_IMAGES, 'images');
  const info = await inspectMedia(ctx, video, 'video');
  checkDuration(info, 'video', { max: 15 });
  const input = { resolution: params.resolution, max_generated_reference_images: params.max_generated_reference_images };
  if (prompt) input.prompt = prompt;
  const media = [mediaEntry('video_url', ctx, [video])];
  if (images.length) media.push(mediaEntry('reference_image_urls', ctx, images, true));
  // the duration comes from the video (minimum 5 s billed); the result reports none
  const billed = info.duration === null ? null : Math.max(5, info.duration);
  return {
    endpoint: 'minimax/h3-max/3d-to-video',
    input,
    media,
    estimateUsd: secondsPrice(PRICES.max[params.resolution], billed),
    pricing: null,
    prompt
  };
}

/* ---------- fal.h3_style ---------- */

const STYLES = Object.freeze(['vhs', 'retro-toon-70s', 'low-poly', 'hand-drawn', '16bit-pixel']);

async function planH3Style(ctx, inputs, params) {
  const prompt = promptOf(inputs, { required: true, max: MAX_STYLE_PROMPT });
  if (!STYLES.includes(params.style)) throw new Error(`style: "${params.style}" is not a valid option`);
  const first = inputs.first_frame || null;
  const input = withSeed({ prompt, duration: params.duration }, params);
  if (params.style === 'vhs') input.damage_level = params.damage_level;
  if (!first) input.aspect_ratio = params.aspect_ratio; // ignored by fal when an image is given
  const media = first ? [mediaEntry('image_url', ctx, [first])] : [];
  return {
    endpoint: `minimax/h3-max/styles/${params.style}`,
    input,
    media,
    estimateUsd: secondsPrice(PRICES.style, params.duration),
    pricing: pricingFor(PRICES.style),
    prompt
  };
}

/* ---------- fal.remove_background ---------- */

// One image in, one PNG with an alpha channel out (output.image of the endpoint, content type image/png). Only the raster
// formats fal takes as an image (the tool refuses everything else when it uploads).
const REMOVE_BACKGROUND_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

async function planRemoveBackground(ctx, inputs) {
  const image = inputs.image;
  if (!image) throw new Error('image: connect an image');
  assetIdsOf(ctx, [image]); // only assets of this workflow's session
  const ext = path.extname(String(image.file || '')).toLowerCase();
  if (!REMOVE_BACKGROUND_EXTENSIONS.includes(ext)) {
    throw new Error(`image: only PNG, JPEG or WebP images can be sent to fal.ai (got ${ext || 'a file without extension'})`);
  }
  let size;
  try {
    size = (await fsp.stat(assets.assetFilePath(image))).size;
  } catch (_) {
    throw new Error('image: the file is missing');
  }
  checkSize({ size }, 'image', fal.MAX_UPLOAD_BYTES);
  return {
    endpoint: PRICES.removeBackground.endpoint,
    input: {},
    media: [mediaEntry('image_url', ctx, [image])],
    kind: 'image',
    estimateUsd: PRICES.removeBackground.usd,
    pricing: null
  };
}

/* ---------- fal.image_to_3d ---------- */

// One front image (plus up to three more views) in, a GLB model and a preview image of it out: the render of the provider,
// else one the app draws from the GLB (lib/glb-preview.js).
// Four models through fal.ai; what differs between them is kept in this table: the endpoint, how many views and in which
// order, which options exist, the range of the face count and what the model takes as an input image.
//   views        how many views besides the front image the model takes (left, back, right)
//   ordered      the views have to be connected from the left without a gap (Tripo: its image list is front, left, back, right)
//   faces        range of the face count, null = the option does not exist
//   formats      file types of the input image; maxBytes / pixels: the limits the provider names (null = none named)
//   pbr, detail  the options exist (Tripo "detailed" sets geometry and texture quality)
//   seed         the endpoint takes a seed; object: the model needs the name of the object (SAM 3D)
//   preview      the provider renders a preview image (Tripo rendered_image, Hunyuan and Meshy thumbnail); SAM 3D delivers none,
//                and where a provider render cannot be fetched either, the poller renders the preview from the GLB
const MB_BYTES = 1024 * 1024;
const VIEW_PORTS = Object.freeze(['left', 'back', 'right']);
const DEFAULT_IMAGE3D_MODEL = 'tripo_h31';
const IMAGE3D_MODELS = Object.freeze({
  tripo_h31: Object.freeze({
    id: 'tripo_h31',
    name: 'Tripo H3.1',
    strength: 'allround',
    views: 3,
    ordered: true,
    faces: Object.freeze({ min: 1000, max: 2000000 }),
    formats: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
    maxBytes: null,
    pixels: null,
    pbr: true,
    detail: true,
    seed: true,
    object: false,
    preview: true
  }),
  hunyuan_pro31: Object.freeze({
    id: 'hunyuan_pro31',
    name: 'Hunyuan 3D Pro 3.1',
    strength: 'detail',
    views: 3,
    ordered: false,
    faces: Object.freeze({ min: 40000, max: 1500000 }),
    formats: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
    maxBytes: 8 * MB_BYTES, // "Resolution: 128-5000px, max 8MB, formats: JPG/PNG/WEBP" (input_image_url of the schema)
    pixels: Object.freeze({ min: 128, max: 5000 }),
    pbr: true,
    detail: false,
    seed: false,
    object: false,
    preview: true
  }),
  meshy_71: Object.freeze({
    id: 'meshy_71',
    name: 'Meshy 7.1',
    strength: 'clean',
    views: 3,
    ordered: false,
    faces: Object.freeze({ min: 100, max: 300000 }),
    formats: Object.freeze(['.png', '.jpg', '.jpeg']), // "Supports .jpg, .jpeg, .png" - WebP is not listed
    maxBytes: 20 * MB_BYTES,
    pixels: null,
    pbr: true,
    detail: false,
    seed: false,
    object: false,
    preview: true
  }),
  sam3d_objects: Object.freeze({
    id: 'sam3d_objects',
    name: 'SAM 3D Objects',
    strength: 'scene',
    experimental: true,
    views: 0,
    ordered: false,
    faces: null,
    formats: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
    maxBytes: null,
    pixels: null,
    pbr: false,
    detail: false,
    seed: true,
    object: true,
    preview: false
  })
});
const IMAGE3D_MODEL_IDS = Object.freeze(Object.keys(IMAGE3D_MODELS));
const FORMAT_NAMES = Object.freeze({ '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WebP' });
const MAX_OBJECT_NAME = 200;

// An error with a stable code that the interface shows in its own language (nodes.issue.<code>, with `data` filling the
// placeholders). The codes have no digits: the engine only passes on codes of the form ABC_DEF.
function meshError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

function formatsText(model) {
  return [...new Set(model.formats.map((ext) => FORMAT_NAMES[ext]))].join(', ');
}

function flag(value, fallback) {
  return value === undefined || value === null ? fallback : value === true || value === 'true';
}

function ownFaceCount(params) {
  return params.face_count === null || params.face_count === undefined || params.face_count === '' ? null : Number(params.face_count);
}

// What the options of the node mean for one model, after the rules between them: PBR needs a texture, a model without the
// option never gets it. The one place the request and the estimate both read.
function image3dSettings(model, params) {
  const textured = flag(params.texture, true);
  return {
    textured,
    pbr: Boolean(model.pbr && textured && flag(params.pbr, false)),
    detailed: Boolean(model.detail && params.detail === 'detailed'),
    faces: model.faces ? ownFaceCount(params) : null,
    seed: model.seed && params.seed !== null && params.seed !== undefined && params.seed !== '' ? Number(params.seed) : null,
    object: model.object ? String(params.object ?? '').trim() : ''
  };
}

// List price of one generation (USD) for these options, or null where it cannot be known: an unknown model, and Hunyuan
// while it is not known whether views are connected (they add a surcharge). `views` is the number of connected views.
function image3dEstimate(params, views) {
  const model = IMAGE3D_MODELS[params.model];
  if (!model) return null;
  const set = image3dSettings(model, params);
  const price = PRICES.image3d;
  if (model.id === 'tripo_h31') {
    const base = set.textured ? (set.detailed ? price.tripo.hdTexture : price.tripo.texture) : price.tripo.noTexture;
    return roundUsd(base + (set.detailed ? price.tripo.detailedGeometry : 0));
  }
  if (model.id === 'hunyuan_pro31') {
    if (!Number.isFinite(views)) return null;
    return roundUsd(price.hunyuan.base + (set.pbr ? price.hunyuan.pbr : 0) + (views > 0 ? price.hunyuan.extraViews : 0) + (set.faces !== null ? price.hunyuan.ownFaceCount : 0));
  }
  if (model.id === 'meshy_71') return set.textured ? price.meshy.texture : price.meshy.noTexture;
  if (model.id === 'sam3d_objects') return price.sam3d.perUnit;
  return null;
}

// What the chosen model takes at the three optional views (registry `limitBy` / limitsFor). {} while the model is not known.
function image3dLimits(params) {
  const model = IMAGE3D_MODELS[String(params.model || '')];
  if (!model) return {};
  const out = {};
  for (const id of VIEW_PORTS) out[id] = { max: model.views > 0 ? 1 : 0, roles: [], required: false, subject: model.name };
  return out;
}

// The entries of the model list in the node view (GET /api/nodes/options/image-to-3d-models): what each model takes (the
// views as capabilities `left`, `back`, `right` with { max }), what a generation costs (`fromUsd` with the default options and
// no extra view, `minUsd` without texture) and what it is good at (`strength`, a key the page translates).
function image3dOptions() {
  return IMAGE3D_MODEL_IDS.map((id) => {
    const model = IMAGE3D_MODELS[id];
    const base = { model: id, texture: true, pbr: false, detail: 'standard', face_count: null };
    const entry = { value: id, label: model.name, strength: model.strength, views: model.views };
    for (const view of VIEW_PORTS) entry[view] = { max: model.views > 0 ? 1 : 0 };
    const from = image3dEstimate(base, 0);
    const min = image3dEstimate({ ...base, texture: false }, 0);
    if (from !== null) entry.fromUsd = from;
    if (min !== null) entry.minUsd = min;
    if (model.experimental) entry.experimental = true;
    return entry;
  });
}

// The rules between the connections and the options of one model, as issues { code, port?, data?, message }. `counts`:
// how many images are connected at left, back and right. One list for the check before the run (validate) and the run.
function image3dIssues(params, counts) {
  const model = IMAGE3D_MODELS[params.model];
  if (!model) return [{ code: 'invalid_param', message: `model: "${params.model}" is not a valid option` }];
  const issues = [];
  const data = { model: model.name };
  const connected = VIEW_PORTS.filter((id) => counts[id] > 0);
  for (const id of VIEW_PORTS) {
    if (counts[id] > 1) issues.push({ code: 'invalid', port: id, message: `${id}: at most 1 image is allowed` });
  }
  if (model.views === 0) {
    for (const id of connected) issues.push({ code: 'MESH_VIEW_UNSUPPORTED', port: id, data, message: `Model ${model.name} takes no additional views (${id})` });
  } else if (model.ordered) {
    // Tripo reads its views as a list in the order left, back, right: a view after a gap would end up in the wrong place
    const gap = VIEW_PORTS.find((id, index) => !(counts[id] > 0) && VIEW_PORTS.slice(index + 1).some((later) => counts[later] > 0));
    if (gap) issues.push({ code: 'MESH_VIEW_GAP', port: gap, data, message: `Model ${model.name} needs the views in the order left, back, right without a gap: connect ${gap} first` });
  }
  const set = image3dSettings(model, params);
  if (model.object && !set.object) {
    issues.push({ code: 'MESH_OBJECT_REQUIRED', data, message: 'object: name the object that is to become a 3D model (for example "chair")' });
  } else if (set.object && [...set.object].length > MAX_OBJECT_NAME) {
    issues.push({ code: 'invalid_param', message: `object: at most ${MAX_OBJECT_NAME} characters are allowed` });
  }
  if (model.faces && set.faces !== null && (!Number.isInteger(set.faces) || set.faces < model.faces.min || set.faces > model.faces.max)) {
    issues.push({ code: 'MESH_FACES_RANGE', data: { ...data, min: model.faces.min, max: model.faces.max }, message: `face_count: ${model.name} takes ${model.faces.min} to ${model.faces.max} faces` });
  }
  return issues;
}

// Format, size and pixels of one input image against what the model names (before anything is uploaded).
async function checkImage3dInput(ctx, model, value, label) {
  const info = await inspectMedia(ctx, value, label);
  const ext = path.extname(String(value.file || '')).toLowerCase();
  const data = { model: model.name };
  if (!model.formats.includes(ext)) {
    throw meshError('MESH_IMAGE_FORMAT', `${label}: ${model.name} takes ${formatsText(model)} images (got ${ext || 'a file without extension'})`, { ...data, formats: formatsText(model) });
  }
  checkSize(info, label, fal.MAX_UPLOAD_BYTES);
  if (model.maxBytes && info.size > model.maxBytes) {
    throw meshError('MESH_IMAGE_SIZE', `${label}: ${model.name} takes images up to ${Math.round(model.maxBytes / MB)} MB (got ${(info.size / MB).toFixed(1)} MB)`, { ...data, max: Math.round(model.maxBytes / MB) });
  }
  if (model.pixels && info.width && info.height) {
    const longest = Math.max(info.width, info.height);
    const shortest = Math.min(info.width, info.height);
    if (shortest < model.pixels.min || longest > model.pixels.max) {
      throw meshError(
        'MESH_IMAGE_PIXELS',
        `${label}: ${model.name} takes images of ${model.pixels.min} to ${model.pixels.max} pixels per side (got ${info.width} x ${info.height})`,
        { ...data, min: model.pixels.min, max: model.pixels.max, width: info.width, height: info.height }
      );
    }
  }
  return info;
}

async function planImageTo3d(ctx, inputs, params) {
  const model = IMAGE3D_MODELS[params.model];
  if (!model) throw new Error(`model: "${params.model}" is not a valid option`);
  const front = inputs.image;
  if (!front) throw new Error('image: connect the front view');
  const views = {};
  for (const id of VIEW_PORTS) {
    const items = itemsOf(inputs, id);
    limitCheck(items, 1, id);
    if (items.length) views[id] = items[0];
  }
  const counts = Object.fromEntries(VIEW_PORTS.map((id) => [id, views[id] ? 1 : 0]));
  const problem = image3dIssues(params, counts)[0];
  if (problem) throw meshError(problem.code, problem.message, problem.data);
  const set = image3dSettings(model, params);

  await checkImage3dInput(ctx, model, front, 'image');
  for (const id of VIEW_PORTS) {
    if (views[id]) await checkImage3dInput(ctx, model, views[id], id);
  }

  const connectedViews = VIEW_PORTS.filter((id) => views[id]);
  let endpoint;
  let input;
  let media;
  if (model.id === 'tripo_h31') {
    // The price depends on texture, PBR and both qualities and the endpoint's own defaults are texture and PBR ON: all of it
    // is sent, also when it is switched off (pbr true would also switch the texture on). quad is never wanted (it can return an FBX).
    input = {
      texture: set.textured,
      pbr: set.pbr,
      texture_quality: set.textured && set.detailed ? 'detailed' : 'standard',
      geometry_quality: set.detailed ? 'detailed' : 'standard',
      quad: false
    };
    if (set.faces !== null) input.face_limit = set.faces;
    if (set.seed !== null) {
      input.model_seed = set.seed;
      input.texture_seed = set.seed;
    }
    if (connectedViews.length) {
      // image_urls = [front, left, back, right], no gap (checked above)
      endpoint = PRICES.image3d.tripo.multiviewEndpoint;
      media = [mediaEntry('image_urls', ctx, [front, ...connectedViews.map((id) => views[id])], true)];
    } else {
      endpoint = PRICES.image3d.tripo.endpoint;
      media = [mediaEntry('image_url', ctx, [front])];
    }
  } else if (model.id === 'hunyuan_pro31') {
    endpoint = PRICES.image3d.hunyuan.endpoint;
    // generate_type Geometry is the untextured model; enable_pbr is ignored there, yet sent as false. face_count only when
    // the person set one (the endpoint's own 500 000 is the default and a chosen number costs extra).
    input = { generate_type: set.textured ? 'Normal' : 'Geometry', enable_pbr: set.pbr };
    if (set.faces !== null) input.face_count = set.faces;
    media = [mediaEntry('input_image_url', ctx, [front])];
    for (const id of connectedViews) media.push(mediaEntry(`${id}_image_url`, ctx, [views[id]]));
  } else if (model.id === 'meshy_71') {
    endpoint = PRICES.image3d.meshy.endpoint;
    // rigging and animation cost extra and make no GLB of the model itself: sent switched off
    input = { should_texture: set.textured, enable_pbr: set.pbr, enable_rigging: false, enable_animation: false };
    if (set.faces !== null) input.target_polycount = set.faces;
    media = [mediaEntry('image_urls', ctx, [front, ...connectedViews.map((id) => views[id])], true)];
  } else {
    endpoint = PRICES.image3d.sam3d.endpoint;
    // the endpoint's own default prompt is "car": the object is always sent. export_textured_glb: a baked texture instead of
    // vertex colours. Points, boxes and masks are not used.
    input = { prompt: set.object, export_textured_glb: set.textured };
    if (set.seed !== null) input.seed = set.seed;
    media = [mediaEntry('image_url', ctx, [front])];
  }
  return {
    endpoint,
    input,
    media,
    kind: 'model3d',
    estimateUsd: image3dEstimate(params, connectedViews.length),
    pricing: null,
    prompt: set.object
  };
}

/* ---------- fal.video_segment ---------- */

// SAM 3 on video (fal-ai/sam-3/video): the objects named in `prompt` (commas for several) are found and followed through the
// video. What the endpoint delivers (paid mini test on 2026-10-03: a 2 s clip of 1280 x 720 at 24 fps, `prompt: "person"`):
//   apply_mask false                   a black and white mask, the object white (MP4 or WebM)
//   apply_mask true, X264 (.mp4)       the object on black, no alpha
//   apply_mask true, VP9 (.webm)       a real cutout: VP9 with an alpha channel
// The three outputs of the node are exactly these. The result `video` comes as application/octet-stream under the name
// output.mp4 / output.webm; the poller names the stored file by its first bytes (lib/poller.js videoExtensionOf). point_prompts
// and box_prompts are not used, nor the deprecated text_prompt.
const SEGMENT_OUTPUTS = Object.freeze({
  cutout: Object.freeze({ apply_mask: true, video_output_type: 'VP9 (.webm)' }),
  mask: Object.freeze({ apply_mask: false, video_output_type: 'X264 (.mp4)' }),
  cutout_black: Object.freeze({ apply_mask: true, video_output_type: 'X264 (.mp4)' })
});
const SEGMENT_OUTPUT_IDS = Object.freeze(Object.keys(SEGMENT_OUTPUTS));
const SEGMENT_SECONDS = Object.freeze({ min: 1, max: 60, default: 10 });
const SEGMENT_THRESHOLD = Object.freeze({ min: 0.1, max: 0.9, default: 0.5 });
const MAX_SEGMENT_OBJECT = 200;

// An error with a stable code that the interface shows in its own language (nodes.issue.<code>).
function segmentError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// What is sent as the prompt: the names between the commas, trimmed, no empty one ("person ,, cloth," -> "person, cloth").
function segmentObject(value) {
  return String(value ?? '')
    .split(/[,，]/)
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

// The rules of the options, as issues { code, message }. One list for the check before the run (validate, which sees the params
// after the registry clamped the numbers) and for the run itself, which may be handed raw values.
function segmentIssues(params) {
  const issues = [];
  const object = segmentObject(params.object);
  if (!object) {
    issues.push({ code: 'SEGMENT_OBJECT_REQUIRED', message: 'object: name the object that is cut out of the video (for example "person", several with commas)' });
  } else if ([...object].length > MAX_SEGMENT_OBJECT) {
    issues.push({ code: 'invalid_param', message: `object: at most ${MAX_SEGMENT_OBJECT} characters are allowed` });
  }
  if (!Object.prototype.hasOwnProperty.call(SEGMENT_OUTPUTS, params.output)) {
    issues.push({ code: 'invalid_param', message: `output: "${params.output}" is not a valid option` });
  }
  const seconds = params.max_seconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < SEGMENT_SECONDS.min || seconds > SEGMENT_SECONDS.max) {
    issues.push({ code: 'invalid_param', message: `max_seconds: a whole number from ${SEGMENT_SECONDS.min} to ${SEGMENT_SECONDS.max} is required` });
  }
  const threshold = params.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < SEGMENT_THRESHOLD.min || threshold > SEGMENT_THRESHOLD.max) {
    issues.push({ code: 'invalid_param', message: `threshold: a number from ${SEGMENT_THRESHOLD.min} to ${SEGMENT_THRESHOLD.max} is required` });
  }
  return issues;
}

// The price of the job: a started block of 16 frames of the video that is sent counts as a whole.
function segmentUsd(frames) {
  const price = PRICES.videoSegment;
  return roundUsd(Math.ceil(frames / price.framesPerBlock) * price.usdPerBlock);
}

// Seconds of the connected video when the plan knows them: the value the node would receive now (context.inputs, which the plan
// fills only while everything before the node is up to date), the longest one of a list. null = not known. An earlier result of
// a node that is about to run again is not taken for it: the new video may be longer.
function knownSegmentSeconds(context) {
  const value = context?.inputs?.video;
  const items = value && value.type === 'list' && Array.isArray(value.items) ? value.items : value ? [value] : [];
  if (!items.length) return null;
  const seconds = items.map((item) => Number(item?.duration));
  return seconds.every((item) => Number.isFinite(item) && item > 0) ? Math.max(...seconds) : null;
}

// The price the plan shows: an upper bound. At most the first max_seconds of the video are used, at most 30 frames per second;
// the length of the connected video replaces max_seconds where the plan knows it and it is shorter.
function segmentBound(params, context) {
  const limit = params.max_seconds;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  const known = knownSegmentSeconds(context);
  const seconds = known === null ? limit : Math.min(known, limit);
  // the epsilon keeps a product such as 4.8 x 30 = 144.00000000000003 from counting a frame more
  return segmentUsd(Math.max(1, Math.ceil(seconds * videoPrep.MAX_FPS - 1e-9)));
}

// Whether `file` lies in a scratch folder (assets.createScratchDir) of this session: <asset dir>/<.nodes-...>/<name>.
function inScratchFolder(sessionId, file) {
  const parts = path.relative(path.resolve(store.sessionAssetDir(sessionId)), path.resolve(file)).split(path.sep);
  return parts.length === 2 && parts[0].startsWith(assets.SCRATCH_PREFIX) && parts[1] !== '' && !parts.includes('..');
}

// Uploads the prepared video. It is no ledger asset (it would show up in the asset list of the workflow), so fal_generate cannot
// take it by its id; the node uploads it itself, before the tool runs, and hands over the address in input.video_url. What the
// tool checks for an upload is checked here as well: the run is not cancelled, the key is set, the file is a regular file (no
// link) in a scratch folder of THIS session that the node made itself (never a path from a parameter), its type is one the tool
// uploads (tools.FAL_UPLOAD_MIME) and it fits the size limit (lib/fal.js repeats that and keeps every address out of its messages).
async function uploadPrepared(ctx, file) {
  if (ctx.signal?.aborted) throw fal.abortError();
  if (!fal.hasKey()) throw new Error(fal.MISSING_KEY_MESSAGE);
  if (!inScratchFolder(ctx.sessionId, file)) throw new Error('video: the prepared file is not in the scratch folder of this workflow');
  const ext = path.extname(file).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(tools.FAL_UPLOAD_MIME, ext)) throw new Error(`video: ${ext || 'a file without extension'} cannot be uploaded to fal.ai`);
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('video: the prepared file is missing');
  checkSize({ size: stat.size }, 'video', fal.MAX_UPLOAD_BYTES);
  const uploaded = await fal.uploadFile(file, { contentType: tools.FAL_UPLOAD_MIME[ext], fileName: videoPrep.PREPARED_FILE, signal: ctx.signal });
  return uploaded.url;
}

// Everything is checked and prepared before anything is paid; the upload is free, the job is queued by the tool afterwards.
//   1. the options, the connection (a video of THIS workflow), ffmpeg and the key
//   2. the video is made fit (lib/nodes/video-prep.js): the first max_seconds, at most 30 frames per second, at most 1920 pixels,
//      H.264 without sound - or left as it is when it fits already - and its frames are counted exactly
//   3. the price is that count: a block of 16 frames, rounded up (this is what is booked)
//   4. the upload: a video that was left as it is goes through the tool like every asset; a prepared one is uploaded here
async function planVideoSegment(ctx, inputs, params) {
  const problem = segmentIssues(params)[0];
  if (problem) throw segmentError(problem.code, problem.message);
  const video = inputs.video;
  if (!video) throw new Error('video: connect the video to segment');
  assetIdsOf(ctx, [video]); // only assets of this workflow's session
  const file = assets.assetFilePath(video);
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch (_) {
    throw new Error('video: the file is missing');
  }
  const binaries = ffmpeg.binaries();
  if (!binaries.available) {
    throw segmentError('SEGMENT_FFMPEG_MISSING', 'ffmpeg and ffprobe are needed to prepare the video, but were not found. Nothing was uploaded or charged.');
  }
  if (!fal.hasKey()) throw new Error(fal.MISSING_KEY_MESSAGE);
  if (ctx.signal?.aborted) throw fal.abortError();

  const object = segmentObject(params.object);
  const output = SEGMENT_OUTPUTS[params.output];
  let url = null;
  let prepared;
  const scratch = await assets.createScratchDir(ctx.sessionId);
  try {
    prepared = await ctx.withLocalSlot(() =>
      videoPrep.prepareVideo({
        file,
        extension: path.extname(String(video.file || '')).toLowerCase(),
        size,
        scratch,
        maxSeconds: params.max_seconds,
        maxBytes: fal.MAX_UPLOAD_BYTES,
        signal: ctx.signal,
        binaries
      })
    );
    // never more frames than the options allow, whatever the preparation did (the price is that count)
    if (prepared.frames > videoPrep.frameLimit(params.max_seconds)) {
      throw new Error(`video: the prepared video has ${prepared.frames} frames, more than ${params.max_seconds} s at ${videoPrep.MAX_FPS} frames per second allow. Nothing was uploaded or charged.`);
    }
    checkSize({ size: prepared.bytes }, 'video', fal.MAX_UPLOAD_BYTES);
    ctx.log(prepared.unchanged ? `Video is sent as it is: ${prepared.frames} frames` : `Video prepared (${prepared.reasons.join(', ')}): ${prepared.frames} frames`);
    if (!prepared.unchanged) url = await uploadPrepared(ctx, prepared.file);
  } finally {
    await assets.removeScratchDir(scratch).catch(() => {});
  }

  const input = { prompt: object, apply_mask: output.apply_mask, video_output_type: output.video_output_type, detection_threshold: params.threshold };
  const media = [];
  if (url) input.video_url = url;
  else media.push(mediaEntry('video_url', ctx, [video]));
  return {
    endpoint: PRICES.videoSegment.endpoint,
    input,
    media,
    kind: 'video',
    estimateUsd: segmentUsd(prepared.frames),
    pricing: null,
    prepared: { unchanged: prepared.unchanged, reasons: prepared.reasons, frames: prepared.frames }
  };
}

/* ---------- fal.model (free-form) ---------- */

const MAX_MODEL_IMAGES = 10;
const MAX_MODEL_VIDEOS = 5;
const MAX_MODEL_AUDIOS = 5;
const OUTPUT_KINDS = Object.freeze(['auto', 'video', 'image', 'audio']);
const SINGLE_PLACEHOLDER = /^\{\{\s*(image|video|audio)_(\d+)\s*\}\}$/;
const LIST_PLACEHOLDER = /^\{\{\s*(images|videos|audios)\s*\}\}$/;
const ANY_MEDIA_PLACEHOLDER = /\{\{\s*(?:image|video|audio)s?(?:_\d+)?\s*\}\}/;
const HAS_PROMPT_PLACEHOLDER = /\{\{\s*prompt\s*\}\}/;
const ALL_PROMPT_PLACEHOLDERS = /\{\{\s*prompt\s*\}\}/g;
const MEDIA_LIMITS = { image: MAX_MODEL_IMAGES, video: MAX_MODEL_VIDEOS, audio: MAX_MODEL_AUDIOS };
const PLURAL = { image: 'images', video: 'videos', audio: 'audios' };
const SENTINEL = (name) => `@@fal:${name}@@`;

function parseModelInput(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (err) {
    throw new Error(`input_json: not valid JSON (${shortMessage(err)})`);
  }
  if (!isPlainObject(data)) throw new Error('input_json: expected a JSON object');
  return data;
}

// Walks the PARSED JSON (never the raw text) and replaces the placeholders: a string that is exactly {{image_1}} /
// {{video_2}} / {{audio_1}} becomes a media sentinel (the tool swaps it for the uploaded URL), {{images}} /
// {{videos}} / {{audios}} the URL list; {{prompt}} inside a string is replaced by the prompt text.
function resolvePlaceholders(node, context) {
  if (typeof node === 'string') {
    let match = SINGLE_PLACEHOLDER.exec(node);
    if (match) {
      const kind = match[1];
      const index = Number(match[2]);
      const list = context.media[kind];
      if (index < 1 || index > list.length) {
        throw new Error(`input_json: ${node.trim()} refers to ${kind} ${index}, but ${list.length} ${PLURAL[kind]} ${list.length === 1 ? 'is' : 'are'} connected`);
      }
      context.used.single.set(`${kind}_${index}`, list[index - 1]);
      return SENTINEL(`${kind}_${index}`);
    }
    match = LIST_PLACEHOLDER.exec(node);
    if (match) {
      const kind = match[1].slice(0, -1);
      if (!context.media[kind].length) throw new Error(`input_json: ${node.trim()} is used, but no ${PLURAL[kind]} are connected`);
      context.used.list.set(PLURAL[kind], context.media[kind]);
      return SENTINEL(PLURAL[kind]);
    }
    if (ANY_MEDIA_PLACEHOLDER.test(node)) {
      throw new Error('input_json: media placeholders such as {{image_1}} must be the whole string value');
    }
    if (HAS_PROMPT_PLACEHOLDER.test(node)) {
      if (!context.prompt) throw new Error('input_json: {{prompt}} is used, but no prompt is connected or entered');
      return node.replace(ALL_PROMPT_PLACEHOLDERS, () => context.prompt);
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((item) => resolvePlaceholders(item, context));
  if (isPlainObject(node)) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolvePlaceholders(value, context)]));
  }
  return node;
}

function modelIssues(params) {
  const issues = [];
  const endpoint = String(params.endpoint || '').trim();
  if (!endpoint) issues.push('endpoint: enter a fal.ai endpoint id such as fal-ai/flux/dev');
  else if (!fal.isValidEndpointId(endpoint)) issues.push('endpoint: not a valid fal.ai endpoint id (lowercase path such as fal-ai/flux/dev)');
  try {
    parseModelInput(params.input_json);
  } catch (err) {
    issues.push(err.message);
  }
  if (!OUTPUT_KINDS.includes(params.output_kind)) issues.push(`output_kind: "${params.output_kind}" is not a valid option`);
  return issues;
}

async function planModel(ctx, inputs, params) {
  const issues = modelIssues(params);
  if (issues.length) throw new Error(issues[0]);
  const endpoint = params.endpoint.trim();
  const media = {
    image: itemsOf(inputs, 'images'),
    video: itemsOf(inputs, 'videos'),
    audio: itemsOf(inputs, 'audios')
  };
  for (const kind of Object.keys(media)) limitCheck(media[kind], MEDIA_LIMITS[kind], PLURAL[kind]);
  const prompt = inputs.prompt ? String(inputs.prompt.value) : '';
  const context = { media, prompt, used: { single: new Map(), list: new Map() } };
  const input = resolvePlaceholders(parseModelInput(params.input_json), context);
  const entries = [];
  for (const [name, value] of context.used.single) entries.push({ placeholder: SENTINEL(name), assetIds: assetIdsOf(ctx, [value]), multiple: false });
  for (const [name, values] of context.used.list) entries.push({ placeholder: SENTINEL(name), assetIds: assetIdsOf(ctx, values), multiple: true });
  // The reserved result file gets its real kind and extension from the result (auto = first hit: video, image, audio).
  return { endpoint, input, media: entries, kind: params.output_kind, estimateUsd: null, pricing: null, keepResult: true, prompt };
}

/* ---------- definitions ---------- */

const h3Common = {
  category: 'fal',
  paid: true,
  async: true,
  experimental: true,
  timeoutMs: NODE_TIMEOUT_MS,
  available: falAvailable
};

const usdEstimate = (compute) => ({
  unit: 'usd',
  estimate: (params) => {
    try {
      const value = compute(params);
      return Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  }
});

function multiCount(ports, portId, max, label = portId) {
  return ports[portId]?.count > max ? [`${label}: at most ${max} are allowed`] : [];
}

const definitions = [
  {
    ...h3Common,
    type: 'fal.h3_video',
    label: 'H3 Max video',
    keywords: ['h3', 'max', 'minimax', 'fal', 'video', 'text to video', 'image to video', 'first frame', 'last frame', 'audio', 'turbo'],
    description:
      'MiniMax H3 Max (fal.ai): text to video, or image to video with a first and/or last frame. An audio input sets the soundtrack ' +
      '(at least 2 s, at most 15 MB). The aspect ratio only applies without a first and last frame. Model "turbo" is faster and cheaper.',
    inputs: [
      promptInput(true),
      { id: 'first_frame', type: 'image' },
      { id: 'last_frame', type: 'image' },
      { id: 'audio', type: 'audio' }
    ],
    outputs: [
      { id: 'video', type: 'video' },
      { id: 'expanded_prompt', type: 'text' }
    ],
    params: [
      PROMPT_PARAM,
      { id: 'model', kind: 'select', options: ['max', 'turbo'], default: 'max' },
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P'], default: '768P' },
      { id: 'aspect_ratio', kind: 'select', options: RATIOS, default: '16:9', showIf: NO_FRAMES },
      { id: 'duration', kind: 'integer', min: 5, max: 15, default: 5 },
      EXPANSION_MODE_PARAM,
      SEED_PARAM,
      SAFETY_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(h3VideoPrice(params), params.duration)),
    execute: async (ctx, inputs, params) => {
      const plan = await planH3Video(ctx, inputs, params);
      return videoResult(await runFal(ctx, plan), { withExpanded: true, prompt: plan.prompt });
    }
  },
  {
    ...h3Common,
    type: 'fal.h3_reference',
    label: 'H3 Max reference video',
    keywords: ['h3', 'max', 'minimax', 'fal', 'reference', 'video', 'subject', 'style', 'motion', 'audio'],
    description:
      'MiniMax H3 Max reference to video (fal.ai). Refer to the references in the prompt by kind and connection order: ' +
      '"Image 1", "Video 1", "Audio 1". Up to 9 images, 3 videos and 3 audios, 12 files together; videos and audios 2 to 15 s each, ' +
      '15 s together. Reference tokens above the free allowance are not part of the cost estimate.',
    inputs: [
      promptInput(true),
      { id: 'images', type: 'image', multiple: true, max: MAX_REF_IMAGES },
      { id: 'videos', type: 'video', multiple: true, max: MAX_REF_VIDEOS },
      { id: 'audios', type: 'audio', multiple: true, max: MAX_REF_AUDIOS }
    ],
    outputs: [
      { id: 'video', type: 'video' },
      { id: 'expanded_prompt', type: 'text' }
    ],
    params: [
      PROMPT_PARAM,
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P'], default: '768P' },
      { id: 'aspect_ratio', kind: 'select', options: ['adaptive', ...RATIOS], default: 'adaptive' },
      { id: 'duration', kind: 'integer', min: 5, max: 15, default: 5 },
      EXPANSION_MODE_PARAM,
      SEED_PARAM,
      SAFETY_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(PRICES.max[params.resolution], params.duration)),
    validate: (_params, ports) => {
      const issues = [
        ...multiCount(ports, 'images', MAX_REF_IMAGES),
        ...multiCount(ports, 'videos', MAX_REF_VIDEOS),
        ...multiCount(ports, 'audios', MAX_REF_AUDIOS)
      ];
      const total = (ports.images?.count || 0) + (ports.videos?.count || 0) + (ports.audios?.count || 0);
      if (total > MAX_REF_FILES) issues.push(`images, videos and audios together: at most ${MAX_REF_FILES} files are allowed`);
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const plan = await planH3Reference(ctx, inputs, params);
      return videoResult(await runFal(ctx, plan), { withExpanded: true, prompt: plan.prompt });
    }
  },
  {
    ...h3Common,
    type: 'fal.h3_lipsync',
    label: 'H3 Max lip sync',
    keywords: ['h3', 'max', 'minimax', 'fal', 'lip sync', 'lipsync', 'talking', 'portrait', 'speech', 'avatar'],
    description:
      'MiniMax H3 Max lip sync (fal.ai): a portrait image speaks the connected audio (at least 5 s, up to 15 min). ' +
      'The video is as long as the audio. Price per generated second, 1.2 times above 15 s; the estimate appears once the audio is known.',
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'audio', type: 'audio', required: true }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P', '2K'], default: '768P' },
      { id: 'transcription', kind: 'boolean', default: false },
      SEED_PARAM,
      SAFETY_PARAM
    ],
    cost: usdEstimate(() => null),
    execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planH3Lipsync(ctx, inputs, params)))
  },
  {
    ...h3Common,
    type: 'fal.h3_camera',
    label: 'H3 Max camera move',
    keywords: ['h3', 'max', 'minimax', 'fal', 'camera', 'orbit', 'dolly', 'crane', 'trajectory', 'multi-angle', 'image to video'],
    description:
      'MiniMax H3 Max camera controls (fal.ai): the scene of the image stays frozen while the camera moves along a preset or a custom path. ' +
      'Presets are keyframe lists {time 0..1, azimuth, elevation, distance}: orbit_left/right = azimuth -90/+90, orbit_360 = +360, ' +
      'dolly_in/out = distance 1 to 0.5/1.5, crane_up/down = elevation 0 to 30 / 30 to 0. Custom: 2 to 12 keyframes as JSON. ' +
      'A blank prompt lets fal use "only the camera moves".',
    inputs: [{ id: 'image', type: 'image', required: true }, promptInput(false)],
    outputs: [
      { id: 'video', type: 'video' },
      { id: 'expanded_prompt', type: 'text' }
    ],
    params: [
      PROMPT_PARAM,
      { id: 'preset', kind: 'select', options: CAMERA_PRESET_NAMES, default: 'orbit_right' },
      {
        id: 'trajectory',
        kind: 'code',
        default: JSON.stringify(CAMERA_PRESETS.orbit_right, null, 2),
        showIf: { param: 'preset', equals: 'custom' }
      },
      { id: 'duration', kind: 'integer', min: 3, max: 15, default: 5 },
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P'], default: '480P' },
      EXPANSION_MODE_PARAM,
      SEED_PARAM,
      SAFETY_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(PRICES.max[params.resolution], params.duration)),
    validate: (params) => {
      if (params.preset !== 'custom') return [];
      try {
        parseTrajectory(params.trajectory);
        return [];
      } catch (err) {
        return [err.message];
      }
    },
    execute: async (ctx, inputs, params) => {
      const plan = await planH3Camera(ctx, inputs, params);
      return videoResult(await runFal(ctx, plan), { withExpanded: true, prompt: plan.prompt });
    }
  },
  {
    ...h3Common,
    type: 'fal.h3_extend',
    label: 'H3 Max extend video',
    keywords: ['h3', 'max', 'minimax', 'fal', 'extend', 'continue', 'continuation', 'video', 'longer'],
    description:
      'MiniMax H3 Max extend video (fal.ai): adds new footage after the source video (1.625 to 60 s, at most 50 MB). Describe what happens next, ' +
      'not the source. Output "extended" returns source plus new footage, "continuation" only the new part.',
    inputs: [{ id: 'video', type: 'video', required: true }, promptInput(true)],
    outputs: [
      { id: 'video', type: 'video' },
      { id: 'expanded_prompt', type: 'text' }
    ],
    params: [
      PROMPT_PARAM,
      { id: 'output', kind: 'select', options: ['extended', 'continuation'], default: 'extended' },
      { id: 'duration', kind: 'integer', min: 5, max: 15, default: 5 },
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P', '2K'], default: '768P' },
      { id: 'aspect_ratio', kind: 'select', options: ['auto', ...RATIOS], default: 'auto' },
      EXPANSION_FLAG_PARAM,
      SEED_PARAM,
      SAFETY_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(PRICES.max[params.resolution], params.duration)),
    execute: async (ctx, inputs, params) => {
      const plan = await planH3Extend(ctx, inputs, params);
      return videoResult(await runFal(ctx, plan), { withExpanded: true, prompt: plan.prompt });
    }
  },
  {
    ...h3Common,
    type: 'fal.h3_insert',
    label: 'H3 Max insert scene',
    keywords: ['h3', 'max', 'minimax', 'fal', 'insert', 'scene', 'inpaint', 'video', 'edit'],
    description:
      'MiniMax H3 Max insert scene (fal.ai): generates a new scene at start_time and resumes the source at resume_time. ' +
      'Only the new scene (5 to 13 s) is billed. Optional references: up to 9 images and 3 videos.',
    inputs: [
      { id: 'video', type: 'video', required: true },
      promptInput(false),
      { id: 'images', type: 'image', multiple: true, max: MAX_REF_IMAGES },
      { id: 'videos', type: 'video', multiple: true, max: MAX_REF_VIDEOS }
    ],
    outputs: [
      { id: 'video', type: 'video' },
      { id: 'expanded_prompt', type: 'text' }
    ],
    params: [
      PROMPT_PARAM,
      { id: 'start_time', kind: 'number', min: MIN_TIME, max: 60, step: 0.125, default: 2 },
      { id: 'resume_time', kind: 'number', min: MIN_TIME, max: 60, step: 0.125, default: 2 },
      { id: 'duration', kind: 'number', min: 5, max: 13, step: 0.5, default: 5 },
      { id: 'resolution', kind: 'select', options: ['480p', '768p'], default: '768p' },
      { id: 'color_match', kind: 'boolean', default: true },
      EXPANSION_FLAG_PARAM,
      SEED_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(PRICES.insert[params.resolution], params.duration)),
    validate: (params, ports) => [
      ...insertTimeIssues(params),
      ...multiCount(ports, 'images', MAX_REF_IMAGES),
      ...multiCount(ports, 'videos', MAX_REF_VIDEOS)
    ],
    execute: async (ctx, inputs, params) => {
      const plan = await planH3Insert(ctx, inputs, params);
      return videoResult(await runFal(ctx, plan), { withExpanded: true, prompt: plan.prompt });
    }
  },
  {
    ...h3Common,
    type: 'fal.h3_3d',
    label: 'H3 Max 3D to video',
    keywords: ['h3', 'max', 'minimax', 'fal', '3d', 'blender', 'proxy', 'previz', 'video'],
    description:
      'MiniMax H3 Max 3D to video (fal.ai): turns a Blender proxy video (at most 15 s) into a finished shot; camera and movement come from the video. ' +
      'Optional references (up to 8 images); without them fal generates up to max_generated_reference_images itself. ' +
      'The estimate covers the video seconds (minimum 5 s) only, not generated reference images or reference tokens.',
    inputs: [
      { id: 'video', type: 'video', required: true },
      promptInput(false),
      { id: 'images', type: 'image', multiple: true, max: MAX_3D_IMAGES }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      PROMPT_PARAM,
      { id: 'resolution', kind: 'select', options: ['480P', '768P', '1080P'], default: '768P' },
      { id: 'max_generated_reference_images', kind: 'integer', min: 1, max: 8, default: 2 }
    ],
    cost: usdEstimate(() => null),
    validate: (params, ports) => [
      ...multiCount(ports, 'images', MAX_3D_IMAGES),
      ...(!ports.prompt?.connected && [...String(params.prompt || '')].length > MAX_3D_PROMPT ? [`prompt: at most ${MAX_3D_PROMPT} characters are allowed`] : [])
    ],
    execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planH33d(ctx, inputs, params)))
  },
  {
    ...h3Common,
    type: 'fal.h3_style',
    label: 'H3 Max style video',
    keywords: ['h3', 'max', 'minimax', 'fal', 'style', 'vhs', 'retro', 'toon', 'low poly', 'hand drawn', 'pixel', '16 bit', 'video'],
    description:
      'MiniMax H3 Max style videos (fal.ai): VHS (with tape damage level), retro 70s toon, low poly, hand drawn and 16-bit pixel. ' +
      'The style is applied automatically: describe scene, action, camera and sound. An optional first frame sets the canvas; the aspect ratio only applies without it.',
    inputs: [promptInput(true), { id: 'first_frame', type: 'image' }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      PROMPT_PARAM,
      { id: 'style', kind: 'select', options: STYLES, default: 'vhs' },
      { id: 'damage_level', kind: 'select', options: ['light', 'medium', 'heavy'], default: 'medium', showIf: { param: 'style', equals: 'vhs' } },
      { id: 'aspect_ratio', kind: 'select', options: RATIOS, default: '16:9', showIf: NO_FIRST_FRAME },
      { id: 'duration', kind: 'integer', min: 5, max: 15, default: 5 },
      SEED_PARAM
    ],
    cost: usdEstimate((params) => secondsPrice(PRICES.style, params.duration)),
    execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planH3Style(ctx, inputs, params)))
  },
  {
    ...h3Common,
    experimental: false, // all four models ran live (2026-10-03); the list marks SAM 3D on its own
    type: 'fal.image_to_3d',
    label: 'Image to 3D',
    keywords: ['3d', 'glb', 'mesh', 'model', 'object', 'figure', 'product', 'tripo', 'hunyuan', 'meshy', 'sam', 'image to 3d', 'photo to 3d', 'fal'],
    description:
      'Turns an image into a 3D model (GLB) with fal.ai: Tripo H3.1, Hunyuan 3D Pro 3.1, Meshy 7.1 or SAM 3D Objects (experimental). ' +
      'The front image is required; left, back and right views are optional and improve the back of the model (Tripo needs them in that order without a gap, ' +
      'SAM 3D takes none). Result: the GLB and a preview image of it (the render of the provider; for SAM 3D, or when that render is missing, a view from the front that the app draws itself). ' +
      'Texture and PBR cost extra; the estimate follows the choices.',
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'left', type: 'image', multiple: true, max: 1, limitBy: { param: 'model', capability: 'left' } },
      { id: 'back', type: 'image', multiple: true, max: 1, limitBy: { param: 'model', capability: 'back' } },
      { id: 'right', type: 'image', multiple: true, max: 1, limitBy: { param: 'model', capability: 'right' } }
    ],
    outputs: [
      { id: 'model', type: 'model3d' },
      { id: 'preview', type: 'image' }
    ],
    params: [
      // noDefaultEntry: the node names its model itself (Tripo), the list has no "default" entry of the configuration
      { id: 'model', kind: 'select', optionsSource: 'image-to-3d-models', default: DEFAULT_IMAGE3D_MODEL, inline: true, noDefaultEntry: true },
      { id: 'object', kind: 'text', default: '', inline: true, showIf: { param: 'model', equals: 'sam3d_objects' } },
      { id: 'texture', kind: 'boolean', default: true },
      { id: 'pbr', kind: 'boolean', default: false, showIf: { all: [{ param: 'model', in: ['tripo_h31', 'hunyuan_pro31', 'meshy_71'] }, { param: 'texture', equals: true }] } },
      { id: 'detail', kind: 'select', options: ['standard', 'detailed'], default: 'standard', showIf: { param: 'model', equals: 'tripo_h31' } },
      { id: 'face_count', kind: 'integer', min: 100, max: 2000000, optional: true, default: null, showIf: { param: 'model', in: ['tripo_h31', 'hunyuan_pro31', 'meshy_71'] } },
      { ...SEED_PARAM, showIf: { param: 'model', in: ['tripo_h31', 'sam3d_objects'] } }
    ],
    cost: {
      unit: 'usd',
      // Hunyuan adds a surcharge for extra views: the plan knows which views are connected (context.connected)
      estimate: (params, context) => {
        try {
          const views = context?.connected instanceof Set ? VIEW_PORTS.filter((id) => context.connected.has(id)).length : NaN;
          return image3dEstimate(params, views);
        } catch (_) {
          return null;
        }
      },
      // the price follows the model and the options: never guessed from the last result of the node type
      history: false
    },
    limitsFor: image3dLimits,
    validate: (params, ports) => image3dIssues(params, Object.fromEntries(VIEW_PORTS.map((id) => [id, ports[id]?.count || 0]))),
    execute: async (ctx, inputs, params) => {
      const outcome = await runFal(ctx, await planImageTo3d(ctx, inputs, params));
      const variant = { model: outcome.value };
      // the preview image is the second result of the job (the render of the provider, else the one the poller drew from the
      // GLB); it is missing only when both failed, and a node behind it then stops with OUTPUT_EMPTY (see the engine)
      if (outcome.ids.length > 1) variant.preview = await assets.valueFromAsset(ctx.sessionId, outcome.ids[1]);
      return { variants: [variant], cost: outcome.cost };
    }
  },
  {
    ...h3Common,
    type: 'fal.remove_background',
    label: 'Remove background (fal)',
    keywords: ['remove background', 'background', 'cutout', 'transparent', 'png', 'alpha', 'isolate', 'fal', 'bria', 'rmbg'],
    description:
      'Removes the background of an image with Bria RMBG 2.0 (fal.ai): one image in, one PNG with a transparent background out. ' +
      'It needs no Higgsfield account and is open to participants (the cost counts against their budget). Flat price per image.',
    inputs: [{ id: 'image', type: 'image', required: true }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [],
    cost: usdEstimate(() => PRICES.removeBackground.usd),
    execute: async (ctx, inputs) => {
      const outcome = await runFal(ctx, await planRemoveBackground(ctx, inputs));
      return { variants: [{ image: outcome.value }], cost: outcome.cost };
    }
  },
  {
    ...h3Common,
    type: 'fal.video_segment',
    available: videoSegmentAvailable,
    label: 'Segment video',
    keywords: ['segment', 'mask', 'matte', 'cutout', 'rotoscope', 'roto', 'alpha', 'transparent', 'sam', 'sam 3', 'isolate', 'video', 'fal'],
    description:
      'Cuts a named object out of a video with SAM 3 (fal.ai) and follows it through the clip: "cutout" is a WebM with a transparent background, ' +
      '"mask" a black and white video (the object white) for editing software, "cutout_black" the object on black as MP4. ' +
      'Only the first max_seconds (at most 60) are used, at most 30 frames per second, without sound; the video is prepared with ffmpeg first. ' +
      'Price: 0.005 USD per 16 frames (about 0.075 USD for 10 s at 24 fps). The estimate is an upper bound until the video is prepared.',
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'object', kind: 'text', default: '', inline: true },
      { id: 'output', kind: 'select', options: SEGMENT_OUTPUT_IDS, default: 'cutout', inline: true },
      { id: 'max_seconds', kind: 'integer', min: SEGMENT_SECONDS.min, max: SEGMENT_SECONDS.max, default: SEGMENT_SECONDS.default },
      { id: 'threshold', kind: 'number', min: SEGMENT_THRESHOLD.min, max: SEGMENT_THRESHOLD.max, step: 0.05, default: SEGMENT_THRESHOLD.default }
    ],
    cost: {
      unit: 'usd',
      // an upper bound from max_seconds and, where the plan knows it, the length of the connected video (context.inputs)
      estimate: (params, context) => {
        try {
          return segmentBound(params, context);
        } catch (_) {
          return null;
        }
      },
      // the price follows the length of this video: never guessed from the last result of the node type
      history: false
    },
    validate: (params) => segmentIssues(params),
    execute: async (ctx, inputs, params) => {
      const outcome = await runFal(ctx, await planVideoSegment(ctx, inputs, params));
      return videoResult(outcome);
    }
  },
  {
    ...h3Common,
    type: 'fal.model',
    label: 'fal.ai model (free)',
    keywords: ['fal', 'fal.ai', 'model', 'endpoint', 'api', 'custom', 'flux', 'kling', 'any model', 'free'],
    description:
      'Runs any fal.ai queue endpoint. input_json is the model input as a JSON object. Placeholders are replaced after the JSON is parsed: ' +
      'a string that is exactly {{image_1}}, {{video_2}} or {{audio_1}} becomes the uploaded URL of that connection (in order), ' +
      '{{images}}, {{videos}} or {{audios}} the list of URLs, and {{prompt}} inside a string is replaced by the prompt. Only referenced media are uploaded. ' +
      'The cost is unknown and not estimated.',
    inputs: [
      promptInput(false),
      { id: 'images', type: 'image', multiple: true, max: MAX_MODEL_IMAGES },
      { id: 'videos', type: 'video', multiple: true, max: MAX_MODEL_VIDEOS },
      { id: 'audios', type: 'audio', multiple: true, max: MAX_MODEL_AUDIOS }
    ],
    outputs: [
      { id: 'media', type: 'any' },
      { id: 'json', type: 'text' }
    ],
    params: [
      { id: 'endpoint', kind: 'text', default: '', inline: true },
      PROMPT_PARAM,
      { id: 'input_json', kind: 'code', default: '{\n  "prompt": "{{prompt}}"\n}' },
      { id: 'output_kind', kind: 'select', options: OUTPUT_KINDS, default: 'auto' }
    ],
    cost: usdEstimate(() => null),
    validate: (params, ports) => [
      ...modelIssues(params),
      ...multiCount(ports, 'images', MAX_MODEL_IMAGES),
      ...multiCount(ports, 'videos', MAX_MODEL_VIDEOS),
      ...multiCount(ports, 'audios', MAX_MODEL_AUDIOS)
    ],
    execute: async (ctx, inputs, params) => {
      const outcome = await runFal(ctx, await planModel(ctx, inputs, params));
      const json = typeof outcome.meta?.resultJson === 'string' ? outcome.meta.resultJson : '';
      return {
        variants: [{ media: outcome.value, json: textValue(json.slice(0, MAX_RESULT_JSON)) }],
        cost: outcome.cost
      };
    }
  }
];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  PRICES,
  CAMERA_PRESETS,
  CAMERA_PRESET_NAMES,
  STYLES,
  MAX_RESULT_JSON,
  parseTrajectory,
  trajectoryFor,
  parseModelInput,
  resolvePlaceholders,
  planH3Video,
  planH3Reference,
  planH3Lipsync,
  planH3Camera,
  planH3Extend,
  planH3Insert,
  planH33d,
  planH3Style,
  planRemoveBackground,
  planVideoSegment,
  planImageTo3d,
  SEGMENT_OUTPUTS,
  segmentIssues,
  segmentObject,
  segmentUsd,
  segmentBound,
  IMAGE3D_MODELS,
  IMAGE3D_MODEL_IDS,
  DEFAULT_IMAGE3D_MODEL,
  image3dEstimate,
  image3dOptions,
  image3dIssues,
  planModel
};
