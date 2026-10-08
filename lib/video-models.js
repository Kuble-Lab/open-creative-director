'use strict';

// Video model picker of the chat.
//
// generate_video does not start a paid job on its own: it stores a request in the chat (session.videoModelRequests),
// shows a card with the compatible OpenRouter video models, an estimated price for exactly this job, short strengths and
// weaknesses and a recommendation, and ends the Director's turn. Only the click on a model starts the job.
//
//   request status   pending -> processing -> submitted        (a failed start reopens it: processing -> pending)
//                    pending -> cancelled
//
// The options of a request are fixed when it is created; the model of a click must be one of them (the client never sends
// a free model id). What a person may still pay is checked live, again at the click (lib/budget.js).
//
// A provider may refuse the image of the request (a real person on it, lib/video-refusal.js). The request then remembers
// that provider (request.refusedProviders): the reopened card marks all its models as refusing this image and the server
// does not start them for this request. The chat also remembers which provider refused which images
// (session.videoImageRefusals): the next call with the same images opens a card with that provider marked, even when a
// remembered model would otherwise start at once. Without that, the Director would start the refused model again and again.
//
// A person can remember a choice for a chat ("do not ask again in this chat", session.videoModelPreferences, one entry per
// person): the next video of that person in the chat then starts with that model, as long as it fits the job and the budget.
// What one person remembered never starts a paid job for anybody else in a shared chat: the others still get the card.

const crypto = require('crypto');
const path = require('path');

const store = require('./store');
const discovery = require('./discovery');
const budget = require('./budget');
const resultMeta = require('./result-meta');
const videoRefusal = require('./video-refusal');
const imageSize = require('./image-size');

const MAX_PENDING_PER_SESSION = 20;
const MAX_FINISHED_KEPT = 60;
const MAX_IMAGE_REFUSALS = 30;
// The card shows every compatible model of the curated list (WP41: six with Runway Gen-4.5, seven with FLUX.3 Video). The options
// sit in a wrapping grid (public/styles.css .vmc-options), so seven cards are no more to scan than five; a cap below the length of
// the list would have hidden the newest model whenever all of them fit. Models outside the list (the configured default, fill
// candidates) can still push the list beyond this cap; the cap then cuts from the end, as before. Keep it as long as the list.
const MAX_OPTIONS = 7;
const FRAME_RATIO_CODE = 'VIDEO_FRAME_RATIO';
const FRAME_UNREADABLE_CODE = 'VIDEO_FRAME_UNREADABLE';
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const DEFAULT_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 30;
const ZERO_REFERENCES = Object.freeze({ images: 0, videos: 0, audios: 0 });

const CURATED_MODEL_IDS = Object.freeze([
  'bytedance/seedance-2.5',
  'bytedance/seedance-2.0-fast',
  'kwaivgi/kling-v3.0-std',
  'alibaba/wan-2.7',
  'google/veo-3.1-lite',
  'runway/gen-4.5',
  'black-forest-labs/flux-3-video'
]);

// What the chat knows about the curated models beyond the OpenRouter metadata: the key of the texts on the card and how
// many reference files of each kind the model takes (the metadata does not say). A model that is not listed here takes no
// references, except the configured default model, which the operator chose: it is not restricted here (the limits of the
// tool layer apply).
//   frameRatios  the formats a start image may have (the model takes no other; the provider would crop or stretch it): the card
//                leaves the model out for another format and the job is refused before it is paid (frameRatioProblem); a fitting
//                start image sends its own format as aspect_ratio, or the provider takes 16:9 (frameRatioFor)
const PROFILES = Object.freeze({
  'bytedance/seedance-2.5': { key: 'seedance25', name: 'Seedance 2.5', references: { images: 30, videos: 10, audios: 10 } },
  'bytedance/seedance-2.0-fast': { key: 'seedanceFast', name: 'Seedance 2.0 Fast', references: { images: 9, videos: 3, audios: 3 } },
  'kwaivgi/kling-v3.0-std': { key: 'klingStandard', name: 'Kling v3.0 Standard', references: ZERO_REFERENCES },
  'alibaba/wan-2.7': { key: 'wan27', name: 'Wan 2.7', references: { images: 5, videos: 0, audios: 0 } },
  'google/veo-3.1-lite': { key: 'veoLite', name: 'Veo 3.1 Lite', references: ZERO_REFERENCES },
  // read from the OpenRouter metadata on 2026-10-04: 720p only, 16:9 or 9:16, 2 to 10 s, a first frame only, no sound, 0.12 USD per second
  'runway/gen-4.5': { key: 'runwayGen45', name: 'Runway Gen-4.5', references: ZERO_REFERENCES, frameRatios: Object.freeze(['16:9', '9:16']) },
  // read from the OpenRouter metadata and the documentation of Black Forest Labs on 2026-10-08: 720p and 1080p, 5 to 20 s in whole seconds,
  // 21:9, 16:9, 4:3, 1:1, 3:4 and 9:16, a first and a last frame (no reference images), sound on by default (generate_audio true), 0.17 USD
  // per second at 720p and 0.29 at 1080p. A preview model of the maker. Nothing was paid yet; what is NOT known (per live test):
  //   frameRatios  the six formats of the list. Without an aspect_ratio the maker picks the format itself ("auto"), and whether
  //                OpenRouter hands that on or sets 16:9 as it did for Gen-4.5 is not known; a start image of another format (3:2, 2:3)
  //                is refused before it is paid and the card leaves the model out. Remove frameRatios once a live test shows that a
  //                start image keeps its format without it. The end frame is not checked (the card has none; the node takes one).
  'black-forest-labs/flux-3-video': { key: 'flux3Video', name: 'FLUX.3 Video', references: ZERO_REFERENCES, frameRatios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']) }
});

function payloadList(payload) {
  return Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
}

function modelId(item) {
  if (typeof item === 'string') return item;
  return String(item?.id || item?.slug || item?.canonical_slug || item?.model || '').trim();
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function numberList(value) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

async function availableModels() {
  return payloadList(await discovery.listVideoModels()).filter((item) => modelId(item));
}

// Only the curated models have their own texts. Any other model (a sibling such as a Master or Pro variant) gets the
// neutral ones: the strengths and weaknesses of a different model would be misleading, especially for the dearer ones.
function profileKeyOf(id) {
  return PROFILES[id]?.key || 'generic';
}

// The reference limits of a model; null = not restricted here (the limits of the tool layer apply).
function referenceLimits(id) {
  return PROFILES[id] ? { ...PROFILES[id].references } : null;
}

/* ---------- the format of a start image ---------- */

// A start image whose width / height is within this share of an allowed format counts as that format (1920 x 1088 is 16:9).
const FRAME_RATIO_TOLERANCE = 0.03;
const NAMED_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21', '5:4', '4:5']);

function ratioValue(label) {
  const [w, h] = String(label).split(':').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
}

// "1:1", "4:3" ... for a size; else the plain ratio ("1.37:1"). Only to tell the person what the image is.
function ratioLabel(size) {
  const actual = size.width / size.height;
  const named = NAMED_RATIOS.find((label) => Math.abs(actual / ratioValue(label) - 1) <= 0.02);
  return named || `${actual.toFixed(2)}:1`;
}

// The allowed format ('16:9' or '9:16') that a start image has, within the same tolerance as frameRatioProblem; null for a model without
// a format limit, a size that is not known, or an image that has none of the allowed formats. The job sends it as aspect_ratio: without
// it OpenRouter takes 16:9 for Gen-4.5 and crops a 9:16 start image (live test 2026-10-04). The closest format wins where several fit.
function frameRatioFor(id, size) {
  const allowed = PROFILES[id]?.frameRatios;
  if (!allowed || !size || !(size.width > 0) || !(size.height > 0)) return null;
  const actual = size.width / size.height;
  let best = null;
  for (const label of allowed) {
    const wanted = ratioValue(label);
    if (wanted === null) continue;
    const off = Math.abs(actual / wanted - 1);
    if (off <= FRAME_RATIO_TOLERANCE && (best === null || off < best.off)) best = { label, off };
  }
  return best ? best.label : null;
}

// null when the model takes this start image (or takes any format); else what is wrong:
// { allowed: ['16:9', '9:16'], width, height, ratio: '1:1' }. The model never gets a start image it would crop.
// requireSize: the start image is there but its size could not be read (the header is too long, an odd format): a model with a format
// limit does not take it on trust. { allowed, unreadable: true }. Without it an unknown size passes (no start image asked about).
function frameRatioProblem(id, size, { requireSize = false } = {}) {
  const allowed = PROFILES[id]?.frameRatios;
  if (!allowed) return null;
  if (!size || !(size.width > 0) || !(size.height > 0)) return requireSize ? { allowed: allowed.slice(), unreadable: true, width: 0, height: 0, ratio: null } : null;
  return frameRatioFor(id, size) ? null : { allowed: allowed.slice(), width: size.width, height: size.height, ratio: ratioLabel(size) };
}

// The size of the start image of a job (an asset of the session); null when it cannot be read. The first bytes of the file tell it;
// where they do not (a JPEG with long metadata in front of the picture) ffprobe is asked, which costs nothing either.
async function firstFrameSize(sessionId, assetId) {
  const id = String(assetId || '').trim();
  if (!id || !store.isValidId(sessionId)) return null;
  try {
    const entry = (await store.readLedger(sessionId)).find((item) => item.id === id);
    if (!entry || entry.pending || !entry.file || path.basename(entry.file) !== entry.file) return null;
    const file = path.join(store.sessionAssetDir(sessionId), entry.file);
    const quick = await imageSize.imageSizeOfFile(file);
    if (quick) return quick;
    const probe = await require('./nodes/ffmpeg-ops').probeMedia(file, { timeoutMs: 15000 });
    return probe && probe.video && probe.video.width > 0 && probe.video.height > 0 ? { width: probe.video.width, height: probe.video.height } : null;
  } catch (_) {
    return null;
  }
}

// The formats of a refusal as part of a sentence: "16:9 or 9:16" for two (as it always read), "21:9, 16:9, 4:3, 1:1, 3:4 or 9:16" for more.
function formatsText(allowed, or) {
  return allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} ${or} ${allowed[allowed.length - 1]}` : allowed.join('');
}

// The refusal of a job whose start image has a format the model does not take: before anything is paid, in both languages.
function frameRatioRefusal(option, problem) {
  const name = option && option.name ? option.name : 'This model';
  const allowed = formatsText(problem.allowed, 'or');
  const allowedDe = formatsText(problem.allowed, 'oder');
  if (problem.unreadable) {
    const unreadable = httpError(409, `${name} only takes start images in ${allowed}, and the size of this start image could not be read. It is not sent unchecked. Use a PNG or JPEG start image in ${allowed} or choose another model. Nothing was charged.`);
    unreadable.code = FRAME_UNREADABLE_CODE;
    unreadable.data = { model: name, allowed: problem.allowed.join(' / ') };
    unreadable.messageDe = `${name} nimmt nur Startbilder im Format ${allowedDe}, und die Grösse dieses Startbilds liess sich nicht lesen. Es wird nicht ungeprüft gesendet. Nimm ein PNG- oder JPEG-Startbild im Format ${allowedDe} oder wähle ein anderes Modell. Es wurde nichts berechnet.`;
    return unreadable;
  }
  const error = httpError(409, `${name} only takes start images in ${allowed}; this one is ${problem.ratio} (${problem.width} x ${problem.height}). It is not cropped. Use a ${allowed} start image or choose another model. Nothing was charged.`);
  error.code = FRAME_RATIO_CODE;
  error.data = { model: name, allowed: problem.allowed.join(' / '), ratio: problem.ratio, width: problem.width, height: problem.height };
  error.messageDe = `${name} nimmt nur Startbilder im Format ${allowedDe}; dieses ist ${problem.ratio} (${problem.width} x ${problem.height}). Es wird nicht beschnitten. Nimm ein Startbild im Format ${allowedDe} oder wähle ein anderes Modell. Es wurde nichts berechnet.`;
  return error;
}

/* ---------- what the job needs ---------- */

function requestRequirements(args = {}) {
  const requested = Math.round(Number(args.duration_seconds));
  const duration = Number.isFinite(requested) && requested >= 1 ? Math.min(MAX_DURATION_SECONDS, requested) : DEFAULT_DURATION_SECONDS;
  const firstFrame = String(args.first_frame_asset_id || '').trim();
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    duration,
    mode: args.mode === 'image_to_video' || firstFrame ? 'image_to_video' : 'text_to_video',
    resolution: typeof args.resolution === 'string' && args.resolution.trim() ? args.resolution.trim() : null,
    aspectRatio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio.trim() : '',
    imageReferences: count(args.reference_asset_ids),
    videoReferences: count(args.reference_video_asset_ids),
    audioReferences: count(args.reference_audio_asset_ids),
    hasVideoInput: count(args.reference_video_asset_ids) > 0
  };
}

// 'any' | { min, max } (a continuous range, the tool layer clamps into it) | { values } (fixed lengths).
function durationSupport(value) {
  if (Array.isArray(value)) {
    const values = [...new Set(numberList(value))].sort((a, b) => a - b);
    if (!values.length) return null;
    const continuous = values.length > 1 && values.every((entry, index) => index === 0 || entry - values[index - 1] === 1);
    return continuous ? { min: values[0], max: values.at(-1) } : { values };
  }
  if (value && typeof value === 'object') {
    const min = Number(value.min ?? value.minimum);
    const max = Number(value.max ?? value.maximum);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }
  return null;
}

function effectiveDuration(item, requested) {
  const support = durationSupport(item.supported_durations);
  if (!support) return requested;
  if (support.values) return support.values.includes(requested) ? requested : null;
  return Math.min(support.max, Math.max(support.min, requested));
}

function effectiveResolution(item, requested) {
  const supported = stringList(item.supported_resolutions);
  if (requested) return !supported.length || supported.includes(requested) ? requested : null;
  if (!supported.length || supported.includes('720p')) return '720p';
  return [...supported].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))[0];
}

// Returns { ok, duration, resolution } for one model and one job. `trusted`: the operator's configured default model.
function checkCompatibility(item, requirements, { trusted = false, frameSize = null, frameRead = false } = {}) {
  const id = modelId(item);
  if (typeof item === 'string') {
    return { ok: true, duration: requirements.duration, resolution: requirements.resolution || '720p' };
  }
  const duration = effectiveDuration(item, requirements.duration);
  if (duration === null) return { ok: false, reason: 'duration' };
  const resolution = effectiveResolution(item, requirements.resolution);
  if (resolution === null) return { ok: false, reason: 'resolution' };
  const ratios = stringList(item.supported_aspect_ratios);
  if (requirements.mode === 'text_to_video' && requirements.aspectRatio && ratios.length && !ratios.includes(requirements.aspectRatio)) {
    return { ok: false, reason: 'aspectRatio' };
  }
  const frames = stringList(item.supported_frame_images);
  if (requirements.mode === 'image_to_video' && frames.length && !frames.includes('first_frame')) {
    return { ok: false, reason: 'firstFrame' };
  }
  // a start image in a format the model does not take (Runway: 16:9 or 9:16 only) is never cropped: the model is left out
  if (requirements.mode === 'image_to_video' && frameRatioProblem(id, frameSize, { requireSize: frameRead })) return { ok: false, reason: 'frameRatio' };
  // A curated model keeps its limits even as the configured default, so the card never offers a job that cannot start. Any
  // other model takes no references, except the configured default (the operator chose it).
  const limits = PROFILES[id]?.references || (trusted ? null : ZERO_REFERENCES);
  if (limits) {
    if (requirements.imageReferences > limits.images) return { ok: false, reason: 'imageReferences' };
    if (requirements.videoReferences > limits.videos) return { ok: false, reason: 'videoReferences' };
    if (requirements.audioReferences > limits.audios) return { ok: false, reason: 'audioReferences' };
  }
  return { ok: true, duration, resolution };
}

/* ---------- price ---------- */

function dimensionsFor(resolution, aspectRatio) {
  const shortSide = resolution === '480p' ? 480 : resolution === '1080p' ? 1080 : 720;
  const [rawW, rawH] = String(aspectRatio || '16:9').split(':').map(Number);
  const widthRatio = Number.isFinite(rawW) && rawW > 0 ? rawW : 16;
  const heightRatio = Number.isFinite(rawH) && rawH > 0 ? rawH : 9;
  if (widthRatio === heightRatio) return { width: shortSide, height: shortSide };
  if (widthRatio > heightRatio) {
    return { width: Math.round(shortSide * widthRatio / heightRatio), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide * heightRatio / widthRatio) };
}

function finitePrice(value, divisor = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number / divisor : null;
}

function priceRates(item, job) {
  const skus = item?.pricing_skus && typeof item.pricing_skus === 'object' ? item.pricing_skus : {};
  const rates = [];
  const add = (key, divisor = 1) => {
    const value = finitePrice(skus[key], divisor);
    if (value !== null) rates.push(value);
  };
  const resolution = job.resolution.toLowerCase();
  const modePrefix = job.mode === 'image_to_video' ? 'image_to_video' : 'text_to_video';

  add(`${modePrefix}_duration_seconds_${resolution}`);
  add(`duration_seconds_without_audio_${resolution}`);
  add(`duration_seconds_with_audio_${resolution}`);
  add('duration_seconds_without_audio');
  add('duration_seconds_with_audio');
  add(`duration_seconds_${resolution}`);
  add('duration_seconds');
  add(`cents_per_video_output_second_${resolution}`, 100);
  add(`cents_per_second_output_${resolution}`, 100);
  add('cents_per_second_output', 100);

  const tokenKeys = job.hasVideoInput
    ? ['video_tokens_with_video_input', 'video_tokens_without_audio', 'video_tokens']
    : ['video_tokens_without_audio', 'video_tokens'];
  const dimensions = dimensionsFor(job.resolution, job.aspectRatio);
  const tokensPerSecond = dimensions.width * dimensions.height * 24 / 1024;
  for (const key of tokenKeys) {
    const tokenPrice = finitePrice(skus[key]);
    if (tokenPrice !== null) rates.push(tokenPrice * tokensPerSecond);
  }

  const unique = [...new Set(rates.filter(Number.isFinite).map(round6))];
  return unique.sort((a, b) => a - b);
}

// The least a job can cost, in USD: a model that bills a minimum per generation (Runway Aleph 2.0: minimum_cents_per_generation 56)
// never costs less, however short the video. null = no minimum.
function minimumCharge(item) {
  const skus = item?.pricing_skus && typeof item.pricing_skus === 'object' ? item.pricing_skus : {};
  const minimum = finitePrice(skus.minimum_cents_per_generation, 100);
  return minimum !== null && minimum > 0 ? minimum : null;
}

// job: { duration, resolution, mode, aspectRatio, hasVideoInput } (the duration and resolution this model would use).
// A minimum per generation raises both ends of the total (the estimate is never below it); `minimumTotal` names it where there is one.
function priceEstimate(item, job) {
  const rates = priceRates(item, job);
  if (!rates.length) return null;
  const minPerSecond = rates[0];
  const maxPerSecond = rates.at(-1);
  const minimum = minimumCharge(item);
  const floor = (value) => round6(minimum === null ? value : Math.max(value, minimum));
  return {
    currency: 'USD',
    durationSeconds: job.duration,
    minPerSecond,
    maxPerSecond,
    minTotal: floor(minPerSecond * job.duration),
    maxTotal: floor(maxPerSecond * job.duration),
    ...(minimum !== null ? { minimumTotal: round6(minimum) } : {}),
    source: 'openrouter-live'
  };
}

/* ---------- the options of one job ---------- */

// The curated name, else the name of the catalogue without the provider in front ("Alibaba: Wan 3.0 Prime").
function displayName(item, id) {
  return PROFILES[id]?.name || resultMeta.displayName(id, item?.name) || id;
}

// The curated name of a model; '' for any other model (lib/result-meta.js names those).
function profileName(id) {
  return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id].name : '';
}

function publicOption(item, requirements, check, defaultModel) {
  const id = modelId(item);
  const job = {
    duration: check.duration,
    resolution: check.resolution,
    mode: requirements.mode,
    aspectRatio: requirements.aspectRatio,
    hasVideoInput: requirements.hasVideoInput
  };
  const price = typeof item === 'string' ? null : priceEstimate(item, job);
  return {
    id,
    name: displayName(item, id),
    profileKey: profileKeyOf(id),
    recommended: id === defaultModel,
    durationSeconds: check.duration,
    resolution: check.resolution,
    price,
    // What the budget reserves for the job: the upper end of the estimate (audio, provider variants).
    estimateUsd: price ? price.maxTotal : null,
    capabilities: {
      resolutions: stringList(item?.supported_resolutions),
      aspectRatios: stringList(item?.supported_aspect_ratios),
      durations: numberList(item?.supported_durations),
      firstFrame: stringList(item?.supported_frame_images).includes('first_frame'),
      audio: item?.generate_audio === true
    }
  };
}

// Editing, upscaling, avatar and lip-sync models need a source the card does not have: a click would pay for a failing job.
const NOT_A_GENERATOR = /edit|upscal|avatar|lip-?sync|aleph/i;

// A model outside the curated list may fill a thin card only when the catalogue describes it as a generator for exactly
// this kind of job: resolutions, durations and formats listed, a first frame for image to video, not an editing model.
function fillCandidate(item, requirements) {
  if (!item || typeof item !== 'object') return false;
  if (NOT_A_GENERATOR.test(`${modelId(item)} ${item.name || ''}`)) return false;
  if (!stringList(item.supported_resolutions).length || !stringList(item.supported_aspect_ratios).length) return false;
  if (!durationSupport(item.supported_durations)) return false;
  if (requirements.mode === 'image_to_video' && !stringList(item.supported_frame_images).includes('first_frame')) return false;
  return true;
}

// The compatible models for the arguments of generate_video: the configured default first, then the curated list, then
// (if that is thin) other listed models that are plain generators with a known price. Returns { options, requirements }.
async function listOptions(args, defaultModel, { sessionId = null } = {}) {
  const requirements = requestRequirements(args);
  // the format of the start image decides which models take it (read from the file, nothing is paid)
  const frameSize = requirements.mode === 'image_to_video' && sessionId ? await firstFrameSize(sessionId, args?.first_frame_asset_id) : null;
  let models;
  try {
    models = await availableModels();
  } catch (_) {
    models = [{ id: defaultModel, name: defaultModel, pricing_skus: {} }];
  }
  const byId = new Map(models.map((item) => [modelId(item), item]));
  const orderedIds = [defaultModel, ...CURATED_MODEL_IDS].filter(Boolean);
  const seen = new Set();
  const options = [];
  const consider = (id, item, { fill = false } = {}) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!item) return;
    if (fill && !fillCandidate(item, requirements)) return;
    const check = checkCompatibility(item, requirements, { trusted: id === defaultModel, frameSize, frameRead: requirements.mode === 'image_to_video' && Boolean(sessionId) });
    if (!check.ok) return;
    const option = publicOption(item, requirements, check, defaultModel);
    // An unknown model without a price would show "price unknown" and reserve only the flat amount: not offered.
    if (fill && !option.price) return;
    options.push(option);
  };
  for (const id of orderedIds) consider(id, byId.get(id));
  if (options.length < 3) {
    for (const item of models) {
      if (options.length >= 4) break;
      consider(modelId(item), item, { fill: true });
    }
  }
  if (options.length && !options.some((option) => option.recommended)) options[0].recommended = true;
  return { options: options.slice(0, MAX_OPTIONS), requirements };
}

/* ---------- budget view of a request ---------- */

const EPSILON = 1e-6;

// What a person with a budget can still start: per option the reason it is blocked (or null).
function blockOf(option, budgetStatus) {
  if (!budgetStatus) return null;
  const remaining = Number(budgetStatus.remainingUsd) || 0;
  if (remaining <= EPSILON) return { reason: 'exhausted', remainingUsd: remaining };
  if (option.estimateUsd !== null && option.estimateUsd > remaining + EPSILON) {
    return { reason: 'budget', needUsd: option.estimateUsd, remainingUsd: remaining };
  }
  return null;
}

// The providers (the part of the model id before the slash) that refused the image of this request.
function refusedProvidersOf(request) {
  return Array.isArray(request?.refusedProviders) ? request.refusedProviders.filter((item) => typeof item === 'string' && item) : [];
}

// { code, provider } when the provider of this option refused the image of the request, else null.
function refusalOfOption(option, refusedProviders) {
  const provider = videoRefusal.providerOf(option?.id);
  return provider && refusedProviders.includes(provider) ? { code: videoRefusal.CODE, provider } : null;
}

// The request as the client sees it: options with their budget block, the recommendation moved to an option the person
// can afford, and the budget itself for the line on the card.
function publicChoice(request, budgetStatus = null) {
  // Names stored before the provider prefix was dropped ("Alibaba: Wan 3.0 Prime") are shortened on the way out.
  const refusedProviders = refusedProvidersOf(request);
  const options = (request.options || []).map((option) => ({
    ...option,
    name: resultMeta.stripProvider(option.name) || option.name,
    blocked: blockOf(option, budgetStatus),
    refused: refusalOfOption(option, refusedProviders)
  }));
  if (options.length) {
    // The recommendation goes to a model that is neither over the budget nor refusing the image.
    const open = options.filter((option) => !option.blocked && !option.refused);
    const recommended = options.find((option) => option.recommended && !option.blocked && !option.refused) || open[0] || null;
    for (const option of options) option.recommended = Boolean(recommended) && option.id === recommended.id;
  }
  const selected = (request.options || []).find((option) => option.id === request.selectedModel) || null;
  return {
    id: request.id,
    status: request.status,
    prompt: request.prompt,
    createdAt: request.createdAt,
    selectedModel: request.selectedModel || null,
    selectedName: selected ? resultMeta.stripProvider(selected.name) || selected.name : null,
    selectedEstimate: selected ? selected.price : null,
    remember: Boolean(request.remember),
    lastError: request.lastError || null,
    lastErrorCode: request.lastErrorCode || null,
    preferenceNote: request.preferenceNote || null,
    requirements: request.requirements,
    // The providers that refused the image of this request, and whether no other model is left on the card (or none within the budget).
    refusedProviders,
    noAlternative: refusedProviders.length > 0 && options.length > 0 && options.every((option) => option.refused),
    // The models that do not refuse are all over the budget of the person: there is an alternative, but not one to pay for.
    noAffordable: refusedProviders.length > 0 && options.some((option) => !option.refused) && options.every((option) => option.refused || option.blocked),
    options,
    budget: budgetStatus
      ? { limitUsd: budgetStatus.limitUsd, remainingUsd: budgetStatus.remainingUsd, reservedUsd: budgetStatus.reservedUsd }
      : null
  };
}

// Puts the (live) choice onto the tool messages that belong to a request. Messages are copied, the session stays as it is.
function attachChoices(messages, session, budgetStatus = null) {
  const requests = new Map((Array.isArray(session.videoModelRequests) ? session.videoModelRequests : []).filter(Boolean).map((request) => [request.id, request]));
  return messages.map((message) => {
    const id = message && message.videoModelChoiceId;
    if (!id) return message;
    const request = requests.get(id);
    return request ? { ...message, videoModelChoice: publicChoice(request, budgetStatus) } : message;
  });
}

/* ---------- a remembered choice ---------- */

// One entry per person: session.videoModelPreferences[email] ('lokal' without user management).
function viewerKey(viewer) {
  const email = viewer && typeof viewer.email === 'string' ? viewer.email.trim().toLowerCase() : '';
  return email || 'lokal';
}

function preferenceOf(session, viewer) {
  const all = session && session.videoModelPreferences;
  if (!all || typeof all !== 'object') return null;
  const key = viewerKey(viewer);
  const preference = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  return preference && typeof preference.model === 'string' && preference.model ? preference : null;
}

function publicPreference(session, viewer) {
  const preference = preferenceOf(session, viewer);
  return preference ? { model: preference.model, name: resultMeta.stripProvider(preference.name) || preference.model } : null;
}

async function clearPreference(sessionId, viewer) {
  await store.mutateSession(sessionId, (session) => {
    const all = session.videoModelPreferences;
    if (!all || typeof all !== 'object') return;
    delete all[viewerKey(viewer)];
    if (!Object.keys(all).length) delete session.videoModelPreferences;
  }, { touchUpdatedAt: false });
}

/* ---------- images a provider refused ---------- */

// The images of a call (first frame and reference images) as one key; '' without images.
function imageKeyOf(args = {}) {
  const ids = [args.first_frame_asset_id, ...(Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  return [...new Set(ids)].sort().join('|');
}

// The providers that refused exactly these images earlier in the chat.
function refusedProvidersForImages(session, args) {
  const key = imageKeyOf(args);
  if (!key || !Array.isArray(session?.videoImageRefusals)) return [];
  return [...new Set(session.videoImageRefusals.filter((entry) => entry && entry.key === key && entry.provider).map((entry) => entry.provider))];
}

// Inside a session mutation: a provider refused these images. Without images there is nothing to match later.
function noteImageRefusal(session, args, provider) {
  const key = imageKeyOf(args);
  if (!key || !provider) return;
  const all = Array.isArray(session.videoImageRefusals) ? session.videoImageRefusals.filter(Boolean) : [];
  if (all.some((entry) => entry.key === key && entry.provider === provider)) return;
  session.videoImageRefusals = [...all, { key, provider, at: new Date().toISOString() }].slice(-MAX_IMAGE_REFUSALS);
}

// A start with a remembered model was refused: the next call with the same images opens the card (lib/tools.js).
async function rememberImageRefusal({ sessionId, args, provider }) {
  if (!store.isValidId(sessionId) || !imageKeyOf(args) || !provider) return;
  await store.mutateSession(sessionId, (session) => noteImageRefusal(session, args, provider), { touchUpdatedAt: false });
}

// Decides what generate_video does for a chat call: 'direct' (the model this person remembered fits the job and the
// budget) or 'card'. Reads only; nothing is stored. budgetStatus: lib/budget.js status of the person (null without a budget).
async function plan({ sessionId, args, defaultModel, budgetStatus = null, viewer = null }) {
  const session = await store.readSession(sessionId);
  const { options, requirements } = await listOptions(args, defaultModel, { sessionId });
  const preference = preferenceOf(session, viewer);
  // A provider that refused these images before: its models do not start without asking, the card marks them.
  const refusedProviders = refusedProvidersForImages(session, args);
  let preferenceNote = null;
  if (preference) {
    const option = options.find((entry) => entry.id === preference.model);
    const refused = Boolean(option) && refusedProviders.includes(videoRefusal.providerOf(option.id));
    if (option && !refused && !blockOf(option, budgetStatus)) return { kind: 'direct', option, requirements, budgetStatus };
    // A refusing model needs no extra note: the card says that the provider rejects the image.
    if (!refused) preferenceNote = { model: preference.model, name: preference.name || preference.model, reason: option ? 'budget' : 'incompatible' };
  }
  return { kind: 'card', options, requirements, preferenceNote, refusedProviders, budgetStatus };
}

/* ---------- requests in the chat ---------- */

function stampMessages(session, requestId, change) {
  for (const message of session.messages || []) {
    if (message.videoModelChoiceId === requestId || message.videoModelRequestId === requestId) change(message);
  }
}

async function createRequest({ sessionId, args, plan: planned, user }) {
  if (!store.isValidId(sessionId)) throw new Error('Ungueltige Session-ID');
  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  if (!planned || !planned.options || !planned.options.length) {
    throw new Error('Kein kompatibles Videomodell fuer diesen Auftrag gefunden. Passe Dauer, Format, Aufloesung oder Referenzen an.');
  }
  const request = {
    id: `vmr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    status: 'pending',
    prompt,
    args: JSON.parse(JSON.stringify({ ...args, duration_seconds: planned.requirements.duration })),
    requirements: planned.requirements,
    options: planned.options,
    preferenceNote: planned.preferenceNote || null,
    ...(Array.isArray(planned.refusedProviders) && planned.refusedProviders.length ? { refusedProviders: planned.refusedProviders.slice() } : {}),
    selectedModel: null,
    createdAt: new Date().toISOString(),
    createdBy: user || 'lokal'
  };
  await store.mutateSession(sessionId, (session) => {
    const all = Array.isArray(session.videoModelRequests) ? session.videoModelRequests.filter(Boolean) : [];
    const pending = all.filter((entry) => entry.status === 'pending' || entry.status === 'processing');
    if (pending.length >= MAX_PENDING_PER_SESSION) {
      throw new Error(
        `In diesem Chat warten schon ${MAX_PENDING_PER_SESSION} Video-Modellwahlen. Entscheide oder brich zuerst offene Karten ab.`
      );
    }
    const finished = all.filter((entry) => entry.status !== 'pending' && entry.status !== 'processing').slice(-MAX_FINISHED_KEPT);
    session.videoModelRequests = [...all.filter((entry) => pending.includes(entry)), ...finished, request]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  });
  return request;
}

// Marks the request as being started (exactly one caller gets it) and returns what the job needs. The model must be one
// of the stored options. budgetStatus (a person with a budget): an option over what is left is refused before anything
// changes.
async function beginRequest({ sessionId, requestId, selectedModel, budgetStatus = null }) {
  let selected = null;
  await store.mutateSession(sessionId, (session) => {
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    if (!request) throw httpError(404, 'Video-Modellwahl wurde nicht gefunden.');
    if (request.status === 'processing' && Date.now() - (Date.parse(request.processingAt) || 0) > STALE_PROCESSING_MS) {
      // The server stopped while it started the job. Reopen it only if no job of this request exists.
      const started = (session.jobs || []).some((job) => job.videoModelRequestId === request.id);
      if (!started) {
        request.status = 'pending';
        request.selectedModel = null;
        delete request.processingAt;
      }
    }
    if (request.status !== 'pending') throw httpError(409, 'Diese Video-Modellwahl wurde bereits verarbeitet.');
    const option = (request.options || []).find((item) => item.id === selectedModel);
    if (!option) throw httpError(400, 'Das gewaehlte Videomodell ist fuer diesen Auftrag nicht verfuegbar.');
    if (refusalOfOption(option, refusedProvidersOf(request))) throw modelRefusal(option);
    const block = blockOf(option, budgetStatus);
    if (block) throw budgetRefusal(option, block, budgetStatus);
    request.status = 'processing';
    request.selectedModel = option.id;
    request.lastError = null;
    request.lastErrorCode = null;
    request.processingAt = new Date().toISOString();
    selected = {
      requestId: request.id,
      // The job gets the values the price was calculated for.
      args: JSON.parse(JSON.stringify({ ...request.args, duration_seconds: option.durationSeconds, resolution: option.resolution })),
      option: JSON.parse(JSON.stringify(option))
    };
  });
  return selected;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The provider of this model already refused the image of the request: nothing starts, the person gets a readable reason.
function modelRefusal(option) {
  const error = httpError(409, `${option.name} already refused the image of this request (real person). Choose another model or use an image without a real person.`);
  error.code = videoRefusal.MODEL_REFUSED_CODE;
  error.messageDe = `${option.name} hat das Bild dieser Anfrage bereits abgelehnt (echte Person möglich). Wähle ein anderes Modell oder ein Bild ohne reale Person.`;
  return error;
}

function budgetRefusal(option, block, budgetStatus) {
  const exhausted = block.reason === 'exhausted';
  return new budget.BudgetError(
    exhausted ? 'BUDGET_EXHAUSTED' : 'BUDGET_INSUFFICIENT',
    exhausted ? 'The budget is used up.' : `${option.name} is estimated at $${block.needUsd.toFixed(2)} but only $${block.remainingUsd.toFixed(2)} of the budget is left.`,
    exhausted
      ? 'Das Budget ist aufgebraucht. Bezahlte Aktionen sind gesperrt.'
      : `${option.name} kostet geschätzt $${block.needUsd.toFixed(2)}, aber vom Budget sind nur noch $${block.remainingUsd.toFixed(2)} übrig.`,
    { budget: budgetStatus, estimateUsd: block.needUsd ?? null }
  );
}

// The job is running: the card shows the end state, the tool message and the marker for the Director tell what happened.
async function finishRequest({ sessionId, requestId, outcome, remember = false, viewer = null }) {
  await store.mutateSession(sessionId, (session) => {
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    if (!request) throw new Error('Video-Modellwahl wurde nicht gefunden.');
    request.status = 'submitted';
    request.submittedAt = new Date().toISOString();
    request.jobId = outcome.job?.jobId || null;
    request.assetId = outcome.job?.assetId || null;
    request.remember = Boolean(remember);
    delete request.processingAt;
    const option = (request.options || []).find((item) => item.id === request.selectedModel);
    stampMessages(session, requestId, (message) => {
      if (message.videoModelChoiceId === requestId) {
        message.content = outcome.toolResult;
        message.job = outcome.job
          ? { jobId: outcome.job.jobId, assetId: outcome.job.assetId, prompt: outcome.job.prompt }
          : null;
      } else {
        message.content = `[System] Der User hat ${option ? option.name : request.selectedModel} gewählt. Video-Job ${request.assetId} wurde gestartet.`;
      }
    });
    if (remember && option) {
      const all = session.videoModelPreferences && typeof session.videoModelPreferences === 'object' ? session.videoModelPreferences : {};
      all[viewerKey(viewer)] = { model: option.id, name: option.name, since: new Date().toISOString() };
      session.videoModelPreferences = all;
    }
  });
}

async function reopenRequest({ sessionId, requestId, error }) {
  await store.mutateSession(sessionId, (session) => {
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    if (!request || request.status !== 'processing') return;
    // The provider already took the job and only the bookkeeping failed afterwards: the choice is done, a second click
    // would pay twice.
    const started = (session.jobs || []).find((job) => job && job.videoModelRequestId === requestId);
    if (started) {
      request.status = 'submitted';
      request.submittedAt = new Date().toISOString();
      request.jobId = started.jobId || null;
      request.assetId = started.assetId || null;
      request.lastError = null;
      request.lastErrorCode = null;
      delete request.processingAt;
      const option = (request.options || []).find((item) => item.id === request.selectedModel);
      stampMessages(session, requestId, (message) => {
        if (message.videoModelChoiceId === requestId) {
          message.content = `Video-Job ${started.assetId} gestartet (${option ? option.name : request.selectedModel}).`;
          message.job = { jobId: started.jobId, assetId: started.assetId, prompt: started.prompt };
        } else {
          message.content = `[System] Der User hat ${option ? option.name : request.selectedModel} gewählt. Video-Job ${started.assetId} wurde gestartet.`;
        }
      });
      return;
    }
    const refusal = videoRefusal.refusalOf(error, { model: request.selectedModel });
    if (refusal) {
      // The provider refused the image: its models stay on the card, marked, and the Director history says so.
      const provider = refusal.provider || videoRefusal.providerOf(request.selectedModel);
      if (provider) request.refusedProviders = [...new Set([...refusedProvidersOf(request), provider])];
      // The next request with these images starts with the provider marked.
      noteImageRefusal(session, request.args, provider);
      stampMessages(session, requestId, (message) => {
        message.content = message.videoModelChoiceId === requestId
          ? videoRefusal.requestWaitingText(requestId, refusal.model || request.selectedModel)
          : `[System] ${videoRefusal.requestWaitingText(requestId, refusal.model || request.selectedModel)}`;
      });
    }
    request.status = 'pending';
    request.selectedModel = null;
    request.lastError = String(refusal?.messageDe || error?.messageDe || error?.message || error || 'Video konnte nicht gestartet werden.').slice(0, 500);
    request.lastErrorCode = refusal ? refusal.code : typeof error?.code === 'string' && error.code.startsWith('BUDGET_') ? error.code : null;
    delete request.processingAt;
  });
}

async function cancelRequest({ sessionId, requestId }) {
  await store.mutateSession(sessionId, (session) => {
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    if (!request) throw httpError(404, 'Video-Modellwahl wurde nicht gefunden.');
    if (request.status === 'cancelled') return;
    if (request.status !== 'pending') throw httpError(409, 'Diese Video-Modellwahl wurde bereits verarbeitet.');
    request.status = 'cancelled';
    request.cancelledAt = new Date().toISOString();
    stampMessages(session, requestId, (message) => {
      if (message.videoModelChoiceId === requestId) {
        // Kept on the message too: the card can be pruned from the request list in a long chat, the label must survive.
        message.videoModelChoiceStatus = 'cancelled';
        message.content = 'Der User hat die Video-Modellwahl abgebrochen. Es wurde kein Video erzeugt und nichts berechnet.';
      } else {
        message.content = `[System] Der User hat die Video-Modellwahl ${requestId} abgebrochen. Kein Video wurde gestartet.`;
      }
    });
  });
}

function resetCache() {
  discovery.resetVideoModelCache();
}

module.exports = {
  CURATED_MODEL_IDS,
  MAX_PENDING_PER_SESSION,
  attachChoices,
  beginRequest,
  cancelRequest,
  clearPreference,
  createRequest,
  displayName,
  FRAME_RATIO_CODE,
  FRAME_UNREADABLE_CODE,
  durationSupport,
  effectiveDuration,
  effectiveResolution,
  finishRequest,
  firstFrameSize,
  frameRatioFor,
  frameRatioProblem,
  frameRatioRefusal,
  imageKeyOf,
  listOptions,
  minimumCharge,
  modelId,
  plan,
  preferenceOf,
  priceEstimate,
  profileName,
  publicChoice,
  publicOption,
  publicPreference,
  referenceLimits,
  rememberImageRefusal,
  reopenRequest,
  requestRequirements,
  resetCache
};
