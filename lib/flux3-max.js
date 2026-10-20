'use strict';

// Shared by the fal nodes and the chat. Schemas: docs/fal-flux-3-max.json, fetched 2026-10-20.
const MODEL = 'fal/blackforestlabs/flux-3-max';
const NAME = 'FLUX.3 Max (fal)';
const BASE = 'blackforestlabs/flux-3-max';
const RATIOS = Object.freeze(['21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16']);
const EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);
const PROMO_START = Date.parse('2026-10-15T00:00:00Z');
const PROMO_END = Date.parse('2026-11-07T00:00:00Z');

// Sources (read 2026-10-20): https://fal.ai/models/blackforestlabs/flux-3-max/text-to-video and
// GET https://api.fal.ai/v1/models/pricing. The API's $0.02125 base unit does not describe the resolution multiplier.
// Use the model page: 720p $0.0425/s, 1080p $0.0725/s during the promotion, then $0.17/s and $0.29/s.
// Conservative cutoff: starts on Nov 7 already use list prices. Audio and reasoning do not change the rate.
function price(resolution = '720p', duration = 5, now = Date.now) {
  if (!['720p', '1080p'].includes(resolution)) throw new Error('resolution: choose 720p or 1080p');
  const seconds = Number(duration);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 20) throw new Error('duration: enter a whole number from 5 to 20 seconds');
  const timestamp = new Date(typeof now === 'function' ? now() : now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Invalid pricing time');
  const promotional = timestamp >= PROMO_START && timestamp < PROMO_END;
  const perSecond = (resolution === '1080p' ? 0.29 : 0.17) * (promotional ? 0.25 : 1);
  const total = Math.round(perSecond * seconds * 1e6) / 1e6;
  return { currency: 'USD', durationSeconds: seconds, minPerSecond: perSecond, maxPerSecond: perSecond,
    minTotal: total, maxTotal: total, source: 'fal-model-page-2026-10-20', promotional };
}

function frameIndices(count, duration, times = '') {
  if (!Number.isInteger(count) || count < 2 || count > 10) throw new Error('keyframes: connect 2 to 10 images');
  const text = String(times || '').trim();
  const seconds = text ? text.split(',').map((part) => part.trim() === '' ? NaN : Number(part))
    : Array.from({ length: count }, (_, i) => i * duration / (count - 1));
  if (seconds.length !== count) throw new Error('keyframe_times: the number of times must match the number of images');
  if (seconds.some((s, i) => !Number.isFinite(s) || s < 0 || s > duration || (i > 0 && s <= seconds[i - 1]))) {
    throw new Error('keyframe_times: enter increasing times from 0 to duration seconds');
  }
  const indices = seconds.map((s) => Math.round(s * 24));
  if (new Set(indices).size !== count) throw new Error('keyframe_times: times must produce unique frame indices at 24 fps');
  return indices;
}

// Image URLs can be upload placeholders; the caller validates local files before handing the plan to fal_generate.
function plan({ prompt, params = {}, first = null, last = null, images = null, now = Date.now }) {
  prompt = String(prompt || '').trim();
  if (!prompt) throw new Error('prompt: enter a prompt');
  const duration = params.duration ?? 5;
  const resolution = params.resolution ?? '720p';
  const pricing = price(resolution, duration, now);
  const aspect = params.aspect_ratio || 'auto';
  const reasoning = params.reasoning_level ?? 'high';
  const audio = params.generate_audio ?? true;
  if (!['auto', ...RATIOS].includes(aspect)) throw new Error('aspect_ratio: unsupported format');
  if (!['low', 'high'].includes(reasoning)) throw new Error('reasoning_level: choose low or high');
  if (typeof audio !== 'boolean') throw new Error('generate_audio: expected a boolean');
  if (last && !first) throw new Error('end_image_url: an end image requires a start image');
  const input = { prompt, duration: Number(duration), resolution, reasoning_level: reasoning, aspect_ratio: aspect, generate_audio: audio };
  if (params.seed !== null && params.seed !== undefined) {
    if (!Number.isSafeInteger(params.seed)) throw new Error('seed: enter an integer');
    input.seed = params.seed;
  }
  let mode = first ? 'image-to-video' : 'text-to-video';
  if (first) input.image_url = first;
  if (last) input.end_image_url = last;
  if (images !== null) {
    if (first || last) throw new Error('keyframes: start and end images cannot be combined with keyframes');
    const indices = frameIndices(images.length, Number(duration), params.keyframe_times);
    input.keyframes = images.map((image_url, i) => ({ image_url, frame_index: indices[i] }));
    mode = 'keyframes-to-video';
  }
  return { endpoint: `${BASE}/${mode}`, input, estimateUsd: pricing.maxTotal,
    pricing: { perSecond: pricing.maxPerSecond, durationField: 'duration' }, prompt };
}

function catalogueEntry() {
  return { id: MODEL, name: NAME, supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: [...RATIOS],
    supported_durations: Array.from({ length: 16 }, (_, i) => i + 5), supported_frame_images: ['first_frame'], generate_audio: true };
}

function contentRefusal(error) {
  return /content[ _-]?checker/i.test(String(error?.message || error || ''));
}

module.exports = { MODEL, NAME, BASE, RATIOS, EXTENSIONS, PROMO_END, price, frameIndices, plan, catalogueEntry, contentRefusal };
