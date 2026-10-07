'use strict';

// Image models of the node view (image.generate, image.edit): which models a node may use, how many reference images a
// model takes and what an image costs.
//
//   allowedModels(config)    the models a node may use: config.imageModel first, then config.imageModels
//   isAllowed(config, id)    a model that is not on the list is refused when the node runs (a shared or imported
//                            workflow cannot make a participant pay for any model of the provider)
//   load()                   reads the public model list of OpenRouter (cached, never throws); the data is then used
//                            synchronously by referenceLimits(), like the Higgsfield catalogue (peekModel)
//   referenceLimits(id)      { min, max } of reference images; max null = unknown
//   estimateUsd(id)          price of one image where it is known, else null (never 0)
//   options({ config, edit })  the entries of the model list in the node view
//
// The chat has one image model for everybody (config.imageModel, no choice, no extra rule for participants; a paid call
// counts against the budget of the person). The node view keeps that: everybody chooses from the same list of the
// operator, and the estimate of the chosen model is what the budget reserves.

const discovery = require('./discovery');
const resultMeta = require('./result-meta');

const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const LOAD_TIMEOUT_MS = 8 * 1000;

// What the app knows about a model besides the OpenRouter list (the list can be unreachable or leave a field out).
//   references   how many reference images the model takes (GET https://openrouter.ai/api/v1/images/models, checked 2026-10-02)
//   estimateUsd  list price of one image in USD. Nano Banana Pro: 1120 output tokens for an image of up to 2K at
//                0.00012 USD per token (https://openrouter.ai/api/v1/images/models/google/gemini-3-pro-image/endpoints,
//                the same 0.134 USD as on https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-02). The input
//                images (560 tokens, 0.0011 USD each) are not part of it. Nano Banana 2.1 (on OpenRouter since
//                2026-10-06): 14 reference images (GET https://openrouter.ai/api/v1/images/models) and 0.00003 USD per
//                output token (https://openrouter.ai/api/v1/images/models/google/gemini-nano-banana-2.1/endpoints); an
//                image of 1K, the size the app asks for (it sends no resolution), has 1120 tokens = 0.0336 USD
//                (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-07; 2K 0.0504, 4K 0.113), rounded up
//                to 0.034. The price of GPT Image 2 depends on the quality and size the provider picks and is not
//                estimated: the last cost of the node is used.
const PROFILES = Object.freeze({
  'openai/gpt-image-2': Object.freeze({ references: 16 }),
  'google/gemini-3-pro-image': Object.freeze({ references: 14, estimateUsd: 0.134 }),
  'google/gemini-nano-banana-2.1': Object.freeze({ references: 14, estimateUsd: 0.034 })
});

let catalog = new Map(); // id -> { name, minReferences, maxReferences }
let loadedFrom = null; // the payload the map was built from
let failedAt = 0;

function payloadList(payload) {
  return Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// min / max reference images of one list entry; null = the entry does not say.
function referencesOfEntry(item) {
  const range = item?.supported_parameters?.input_references;
  const max = range && typeof range === 'object' ? wholeNumber(range.max) : null;
  const min = range && typeof range === 'object' ? wholeNumber(range.min) : null;
  if (max !== null) return { min: min === null ? 0 : min, max };
  // no range and no image among the inputs: a model that cannot take a reference at all
  const inputs = item?.architecture?.input_modalities;
  if (Array.isArray(inputs) && inputs.length && !inputs.includes('image')) return { min: 0, max: 0 };
  return { min: null, max: null };
}

function indexCatalog(payload) {
  const next = new Map();
  for (const item of payloadList(payload)) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id) continue;
    const references = referencesOfEntry(item);
    next.set(id, { name: typeof item.name === 'string' ? item.name : '', minReferences: references.min, maxReferences: references.max });
  }
  return next;
}

// Reads the model list of OpenRouter once in a while (lib/discovery.js caches it). Never throws: what cannot be read
// stays unknown and the profiles above apply.
async function load({ timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
  let timer = null;
  try {
    // a slow answer is no reason to hold a plan or the option list back
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const payload = await Promise.race([discovery.listImageModels(), timeout]);
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

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function allowedModels(config) {
  const listed = Array.isArray(config?.imageModels) ? config.imageModels : [];
  return [...new Set([config?.imageModel, ...listed].map(cleanId).filter(Boolean))];
}

function isAllowed(config, id) {
  const model = cleanId(id);
  return Boolean(model) && allowedModels(config).includes(model);
}

function displayName(id) {
  const model = cleanId(id);
  return resultMeta.displayName(model, catalog.get(model)?.name || '');
}

// { min, max } or null when nothing is known. A number from the list wins over the profile.
function referenceLimits(id) {
  const model = cleanId(id);
  if (!model) return null;
  const entry = catalog.get(model);
  if (entry && entry.maxReferences !== null) return { min: entry.minReferences ?? 0, max: entry.maxReferences };
  const profile = PROFILES[model];
  if (profile && Number.isInteger(profile.references)) return { min: 0, max: profile.references };
  return null;
}

// Price of one image in USD, or null when it is not known (never 0).
function estimateUsd(id) {
  const profile = PROFILES[cleanId(id)];
  return profile && Number.isFinite(profile.estimateUsd) && profile.estimateUsd > 0 ? profile.estimateUsd : null;
}

// The entries of the model list: the first one (value '') is "the model of the configuration", then the models of the list.
// edit: the models that take a reference image (a model that is known to take none is left out); otherwise the models that
// make an image from the prompt alone (a model that is known to need a reference image is left out).
// ceiling: the most reference images the node connects at all (a smaller limit of the model wins).
async function options({ config, edit = false, ceiling = Infinity } = {}) {
  await load();
  const fits = (id) => {
    const limits = referenceLimits(id);
    if (!limits) return true;
    return edit ? limits.max > 0 : limits.min === 0;
  };
  const entry = (id, value) => {
    const out = { value, label: displayName(id) };
    const price = estimateUsd(id);
    if (price !== null) out.estimateUsd = price;
    const limits = edit ? referenceLimits(id) : null;
    if (limits) out.references = { max: Math.min(limits.max, ceiling), roles: [], required: false };
    return out;
  };
  const defaultId = cleanId(config?.imageModel);
  const list = [];
  if (defaultId) list.push({ ...entry(defaultId, ''), default: true });
  for (const id of allowedModels(config)) {
    if (fits(id)) list.push(entry(id, id));
  }
  return list;
}

module.exports = {
  PROFILES,
  allowedModels,
  isAllowed,
  load,
  reset,
  displayName,
  referenceLimits,
  estimateUsd,
  options
};
