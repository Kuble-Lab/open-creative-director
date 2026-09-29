'use strict';

// fal.ai node types (category `fal`): the MiniMax H3 Max endpoints and a free-form fal model node.
// Everything is a thin adapter over the node-only tool `fal_generate` (lib/tools.js): the executors check ALL inputs
// first (params, number and kind of the connections, durations and aspect ratios that ffprobe can measure, sizes),
// build the model input exactly as docs/fal-h3-max.json describes it and only then call the tool, which uploads the
// media and queues the job. The poller (lib/poller.js) fetches the result. Nothing here talks to fal.ai directly.
//
// Status: NOT verified against the live API (the schemas and list prices come from docs/fal-h3-max.json, fetched
// 2026-09-29), hence every node is `experimental`. minimax/h3-max/director is a realtime WebRTC endpoint
// (no queue API) and is deliberately not offered.

const fsp = require('fs/promises');

const fal = require('../fal');
const ffmpeg = require('../ffmpeg');
const store = require('../store');
const tools = require('../tools');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
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
  lipsyncOverMultiplier: 1.2
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
  return { value, meta, cost: typeof known === 'number' ? { usd: known } : undefined };
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
  planModel
};
