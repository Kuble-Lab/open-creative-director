'use strict';

// Higgsfield model catalogue for the node view (SPEC §10): read-only `models_explore` calls (no credits),
// cached per process, mapped to a param schema the inspector can render. Model details come from
// `models_explore` (list/get); nothing here talks to a generation endpoint.

const higgsfieldLib = require('../higgsfield');
const { parseJsonLoose } = require('../tools');

const CACHE_TTL_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const MAX_REFS = 12;
const TYPES = Object.freeze(['image', 'video']);
// Parameters the node executes itself; they map to dedicated node params instead of extra_params.
const RESERVED_PARAMS = Object.freeze(['model', 'prompt', 'medias', 'use_unlim']);
const CORE_PARAMS = Object.freeze(['aspect_ratio', 'resolution', 'duration']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Items of a models_explore payload: { items: [...] } (list/search/recommend) or a single model (get).
function itemsOf(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (isObject(payload) && Array.isArray(payload.items)) return payload.items.filter(isObject);
  if (isObject(payload) && typeof payload.id === 'string') return [payload];
  return [];
}

function labelFromName(name) {
  return String(name || '').replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

// Maps one models_explore parameter to a node param descriptor (SPEC §10.2).
function mapParameter(parameter) {
  if (!isObject(parameter) || typeof parameter.name !== 'string' || !parameter.name) return null;
  if (RESERVED_PARAMS.includes(parameter.name)) return null;
  const options = Array.isArray(parameter.options) ? parameter.options.slice() : null;
  let kind;
  if (parameter.type === 'string') kind = options && options.length ? 'select' : 'text';
  else if (parameter.type === 'number') kind = options && options.length ? 'select' : 'number';
  else if (parameter.type === 'bool') kind = 'boolean';
  else if (parameter.type === 'string_array') kind = 'tags';
  else return null;
  const out = {
    id: parameter.name,
    kind,
    label: labelFromName(parameter.name),
    required: parameter.required === 'required',
    target: CORE_PARAMS.includes(parameter.name) ? parameter.name : 'extra_params'
  };
  if (options && options.length && kind === 'select') out.options = options;
  if (kind === 'number') {
    if (Number.isFinite(parameter.min)) out.min = parameter.min;
    if (Number.isFinite(parameter.max)) out.max = parameter.max;
  }
  if (parameter.default !== undefined) out.default = parameter.default;
  if (typeof parameter.description === 'string' && parameter.description) out.description = parameter.description.slice(0, 500);
  if (parameter.nullable === true) out.nullable = true;
  return out;
}

// Reference slots of a model: sum of medias[].max capped at 12 (SPEC §10.2), plus the accepted roles.
function referenceSlots(model) {
  const medias = Array.isArray(model?.medias) ? model.medias.filter((media) => !media?.type || media.type === 'image') : [];
  let max = 0;
  const roles = [];
  for (const media of medias) {
    max += Number.isFinite(media?.max) && media.max > 0 ? media.max : 1;
    for (const role of Array.isArray(media?.roles) ? media.roles : []) if (typeof role === 'string' && !roles.includes(role)) roles.push(role);
  }
  return { max: Math.min(MAX_REFS, max), roles, required: medias.some((media) => media?.required === true) };
}

// Credit estimate of one generation: credits_per_unit x (1 image | seconds of video). null when unknown.
function creditsFor(model, { duration } = {}) {
  const perUnit = Number(model?.credits_per_unit);
  if (!Number.isFinite(perUnit) || perUnit < 0) return null;
  if (model?.credit_unit === 'per_second') {
    const seconds = Number(duration);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(perUnit * seconds * 100) / 100 : null;
  }
  return perUnit;
}

// Payload of GET /api/nodes/higgsfield-models/:modelId.
function describeModel(model) {
  if (!isObject(model)) return null;
  const params = [];
  const seen = new Set();
  const push = (descriptor) => {
    if (descriptor && !seen.has(descriptor.id)) {
      seen.add(descriptor.id);
      params.push(descriptor);
    }
  };
  // Dedicated fields first: aspect_ratios[] -> select aspect_ratio, durations[] / duration_range -> duration.
  const ratios = Array.isArray(model.aspect_ratios) ? model.aspect_ratios.filter((ratio) => typeof ratio === 'string') : [];
  if (ratios.length) push({ id: 'aspect_ratio', kind: 'select', label: 'Aspect ratio', required: false, target: 'aspect_ratio', options: ratios });
  const durations = Array.isArray(model.durations) ? model.durations.filter(Number.isFinite) : [];
  if (durations.length) {
    push({ id: 'duration', kind: 'select', label: 'Duration', required: false, target: 'duration', options: durations });
  } else if (isObject(model.duration_range) && Number.isFinite(model.duration_range.min) && Number.isFinite(model.duration_range.max)) {
    push({
      id: 'duration',
      kind: 'integer',
      label: 'Duration',
      required: false,
      target: 'duration',
      min: model.duration_range.min,
      max: model.duration_range.max
    });
  }
  for (const parameter of Array.isArray(model.parameters) ? model.parameters : []) push(mapParameter(parameter));

  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider_name || '',
    type: model.output_type || null,
    description: typeof model.description === 'string' ? model.description.slice(0, 1000) : '',
    tags: Array.isArray(model.tags) ? model.tags.filter((tag) => typeof tag === 'string') : [],
    supportsUnlim: model.supports_unlim === true,
    refs: referenceSlots(model),
    credits: {
      perUnit: Number.isFinite(model.credits_per_unit) ? model.credits_per_unit : null,
      unit: model.credit_unit === 'per_second' || model.credit_unit === 'per_image' ? model.credit_unit : null
    },
    params
  };
}

function createCatalog({ higgsfield = higgsfieldLib, now = () => Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  const lists = new Map();
  const models = new Map();

  function fresh(entry) {
    return Boolean(entry) && now() - entry.at < ttlMs;
  }

  function clearCache() {
    lists.clear();
    models.clear();
  }

  // Models of one output type ('image' | 'video'), following next_page_token. [] while Higgsfield is disconnected.
  async function listModels(type, { refresh = false } = {}) {
    if (!TYPES.includes(type)) throw new Error(`Unknown model type ${type}`);
    if (!higgsfield.status().connected) return [];
    const cached = lists.get(type);
    if (!refresh && fresh(cached)) return cached.items;

    const items = [];
    let after;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = { action: 'list', type, limit: PAGE_LIMIT };
      if (after) payload.after = after;
      const parsed = parseJsonLoose(await higgsfield.mcpCall('models_explore', payload));
      items.push(...itemsOf(parsed).filter((item) => typeof item.id === 'string' && item.id));
      after = isObject(parsed) && typeof parsed.next_page_token === 'string' && parsed.next_page_token ? parsed.next_page_token : '';
      if (!after || parsed.has_more === false) break;
    }
    const unique = [...new Map(items.map((item) => [item.id, item])).values()];
    lists.set(type, { at: now(), items: unique });
    for (const item of unique) {
      if (!models.has(item.id) || !fresh(models.get(item.id))) models.set(item.id, { at: now(), model: item });
    }
    return unique;
  }

  // Full model definition (`models_explore get`); null while disconnected or when the model does not exist.
  async function getModel(modelId, { refresh = false } = {}) {
    const id = String(modelId || '').trim();
    if (!id || !higgsfield.status().connected) return null;
    const cached = models.get(id);
    if (!refresh && fresh(cached)) return cached.model;
    const parsed = parseJsonLoose(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: id }));
    const model = itemsOf(parsed).find((item) => item.id === id) || null;
    if (model) models.set(id, { at: now(), model });
    return model;
  }

  // Synchronous cache read for cost estimates (plan runs without I/O).
  function peekModel(modelId) {
    const cached = models.get(String(modelId || '').trim());
    return fresh(cached) ? cached.model : null;
  }

  return { listModels, getModel, peekModel, describeModel, creditsFor, clearCache };
}

const defaultCatalog = createCatalog();

module.exports = {
  CACHE_TTL_MS,
  MAX_REFS,
  TYPES,
  createCatalog,
  mapParameter,
  referenceSlots,
  creditsFor,
  describeModel,
  itemsOf,
  listModels: defaultCatalog.listModels,
  getModel: defaultCatalog.getModel,
  peekModel: defaultCatalog.peekModel,
  clearCache: defaultCatalog.clearCache
};
