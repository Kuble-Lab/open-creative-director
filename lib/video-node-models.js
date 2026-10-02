'use strict';

// Video models of the node view (video.generate): which models a node may use, what a model takes (end frame, reference
// images, videos and audio), which durations and resolutions it offers and what a job costs.
//
// The models are those of the model picker in the chat (lib/video-models.js): the configured video model first, then the
// curated list. The price is the same calculation as there (priceEstimate), and so are the duration and resolution a model
// really uses (effectiveDuration, effectiveResolution). This file only adds what a node needs: a list that can be read
// synchronously after load() (the plan and the port limits of the page cannot wait for the network), and the entries of
// the model list in the node view.
//
//   allowedModels(config)    the models a node may use: config.videoModel first, then the curated list
//   isAllowed(config, id)    a model that is not on the list is refused when the node runs (a shared or imported workflow
//                            cannot make a participant pay for any model of the provider)
//   load()                   reads the public video model list of OpenRouter (cached, never throws)
//   aspectRatios(id)         the aspect ratios the list names for a model (text to video), or null while not known
//   limits(id)               { images, videos, audios, firstFrame, lastFrame }: how many each model takes; null = not known
//   settings(id, wanted)     the duration and resolution the model would use, or the reason it cannot
//   estimate(id, wanted)     { option, price } of one job, or null when the price is not known (never 0)
//   options({ config })      the entries of the model list in the node view

const discovery = require('./discovery');
const videoModels = require('./video-models');

const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const LOAD_TIMEOUT_MS = 8 * 1000;
const DEFAULT_ASPECT_RATIO = '16:9';
const DEFAULT_DURATION_SECONDS = 5;

let catalog = new Map(); // id -> entry of the OpenRouter list
let loadedFrom = null; // the payload the map was built from
let failedAt = 0;

function payloadList(payload) {
  return Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function indexCatalog(payload) {
  const next = new Map();
  for (const item of payloadList(payload)) {
    if (!item || typeof item !== 'object') continue;
    const id = videoModels.modelId(item);
    if (id) next.set(id, item);
  }
  return next;
}

// Reads the model list of OpenRouter once in a while (lib/discovery.js caches it). Never throws: what cannot be read
// stays unknown (no price, no end frame claim) and the fixed limits of the inputs apply.
async function load({ timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
  let timer = null;
  try {
    // a slow answer is no reason to hold a plan or the option list back
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const payload = await Promise.race([discovery.listVideoModels(), timeout]);
    failedAt = 0;
    if (payload !== loadedFrom) {
      catalog = indexCatalog(payload);
      loadedFrom = payload;
    }
  } catch (_) {
    failedAt = Date.now();
  } finally {
    clearTimeout(timer);
  }
}

// For tests: forget what was read.
function reset() {
  catalog = new Map();
  loadedFrom = null;
  failedAt = 0;
}

function allowedModels(config) {
  return [...new Set([config?.videoModel, ...videoModels.CURATED_MODEL_IDS].map(cleanId).filter(Boolean))];
}

function isAllowed(config, id) {
  const model = cleanId(id);
  return Boolean(model) && allowedModels(config).includes(model);
}

// The entry of the list for a model, or null while it is not known.
function peek(id) {
  return catalog.get(cleanId(id)) || null;
}

function displayName(id) {
  const model = cleanId(id);
  return model ? videoModels.displayName(peek(model), model) : '';
}

// The frames a model takes, from the list: 1 = takes it, 0 = does not, null = the list does not say.
function frameSupport(item) {
  const frames = stringList(item?.supported_frame_images);
  if (!frames.length) return { first: null, last: null };
  return { first: frames.includes('first_frame') ? 1 : 0, last: frames.includes('last_frame') ? 1 : 0 };
}

// How many of each the model takes; null = not known (the fixed maximum of the input is the only limit then). The
// reference limits are those the chat enforces (lib/video-models.js: only the curated models and the configured one have
// profiles); the frames come from the model list.
function limits(id) {
  const model = cleanId(id);
  if (!model) return null;
  const references = videoModels.referenceLimits(model);
  const frames = frameSupport(peek(model));
  return {
    images: references ? references.images : null,
    videos: references ? references.videos : null,
    audios: references ? references.audios : null,
    firstFrame: frames.first,
    lastFrame: frames.last
  };
}

// The aspect ratios the list names for a model (text to video), or null while the list does not say.
function aspectRatios(id) {
  const ratios = stringList(peek(id)?.supported_aspect_ratios);
  return ratios.length ? ratios : null;
}

// What a job would use at this model. wanted: { duration, resolution ('' or 'auto' = the model decides), aspectRatio,
// firstFrame, refVideos }. Returns { known: false } while the list does not know the model, { error: 'duration' | 'resolution',
// values } when the model does not offer what is asked for, else { known: true, item, duration, resolution, job }.
function settings(id, wanted = {}) {
  const item = peek(id);
  const rounded = Math.round(Number(wanted.duration));
  const requestedDuration = Number.isFinite(rounded) && rounded >= 1 ? rounded : DEFAULT_DURATION_SECONDS;
  if (!item) return { known: false, duration: requestedDuration };
  const duration = videoModels.effectiveDuration(item, requestedDuration);
  if (duration === null) {
    const support = videoModels.durationSupport(item.supported_durations);
    return { error: 'duration', values: support && support.values ? support.values.slice() : [] };
  }
  const asked = typeof wanted.resolution === 'string' && wanted.resolution && wanted.resolution !== 'auto' ? wanted.resolution : null;
  const resolution = videoModels.effectiveResolution(item, asked);
  if (resolution === null) return { error: 'resolution', values: stringList(item.supported_resolutions) };
  const imageToVideo = wanted.firstFrame === true;
  return {
    known: true,
    item,
    duration,
    resolution,
    job: {
      duration,
      resolution,
      mode: imageToVideo ? 'image_to_video' : 'text_to_video',
      // the first frame defines the format of an image to video job: the price is then calculated for the usual one
      aspectRatio: imageToVideo ? '' : cleanId(wanted.aspectRatio) || DEFAULT_ASPECT_RATIO,
      hasVideoInput: wanted.refVideos === true
    }
  };
}

// { option, price } of one job: option is what the job remembers of the choice (the name, the estimate the budget
// reserves, the same fields as the card of the chat), price the estimate of lib/video-models.js. null when the model or
// its price is not known; an estimate of 0 is no estimate.
function estimate(id, wanted = {}) {
  const model = cleanId(id);
  const used = settings(model, wanted);
  if (!used.known) return null;
  const option = videoModels.publicOption(used.item, { mode: used.job.mode, aspectRatio: used.job.aspectRatio, hasVideoInput: used.job.hasVideoInput }, { duration: used.duration, resolution: used.resolution }, model);
  if (!option.price || !(option.estimateUsd > 0)) return null;
  return { option, price: option.price, duration: used.duration, resolution: used.resolution };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// The entries of the model list: the first one (value '') is "the model of the configuration", then the models of the
// list that the model list of OpenRouter knows. Each entry says what the model takes, so the page can show it and limit
// the inputs without asking again: references / videos / audio { max } (stopping at the fixed maximum of the input),
// last_frame { max: 0 | 1 }, durations ({ min, max } or { values }) and perSecondUsd { min, max } (where the price is known).
// A field that is not known is left out. Without a readable list only the configured model is offered.
async function options({ config, ceilings = {} } = {}) {
  await load();
  const cap = (value, ceiling) => (Number.isFinite(ceiling) ? Math.min(value, ceiling) : value);
  const entry = (id, value) => {
    const item = peek(id);
    const out = { value, label: displayName(id) };
    const taken = limits(id);
    if (taken.images !== null) out.references = { max: cap(taken.images, ceilings.refs), roles: [], required: false };
    if (taken.videos !== null) out.videos = { max: cap(taken.videos, ceilings.videos) };
    if (taken.audios !== null) out.audio = { max: cap(taken.audios, ceilings.audios) };
    if (taken.lastFrame !== null) out.last_frame = { max: taken.lastFrame };
    if (item) {
      const support = videoModels.durationSupport(item.supported_durations);
      if (support) out.durations = support.values ? { values: support.values.slice() } : { min: support.min, max: support.max };
      const resolution = videoModels.effectiveResolution(item, null);
      const price = resolution ? videoModels.priceEstimate(item, { duration: 1, resolution, mode: 'text_to_video', aspectRatio: DEFAULT_ASPECT_RATIO, hasVideoInput: false }) : null;
      if (price && price.maxPerSecond > 0) out.perSecondUsd = { min: round6(price.minPerSecond), max: round6(price.maxPerSecond) };
    }
    return out;
  };
  const defaultId = cleanId(config?.videoModel);
  const list = [];
  if (defaultId) list.push({ ...entry(defaultId, ''), default: true });
  if (catalog.size) {
    for (const id of allowedModels(config)) {
      if (catalog.has(id)) list.push(entry(id, id));
    }
  }
  return list;
}

module.exports = {
  allowedModels,
  aspectRatios,
  displayName,
  estimate,
  isAllowed,
  limits,
  load,
  options,
  peek,
  reset,
  settings
};
