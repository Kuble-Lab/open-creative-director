'use strict';

// Higgsfield model catalogue for the node view (SPEC §10): read-only `models_explore` calls (no credits),
// cached per process, mapped to a param schema the inspector can render. Model details come from
// `models_explore` (list/get); nothing here talks to a generation endpoint. The voice list (`list_voices`,
// also read-only) lives here as well: same cache lifetime, same connection check.

const higgsfieldLib = require('../higgsfield');
const tools = require('../tools');

const { parseJsonLoose } = tools;

const CACHE_TTL_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const VOICE_PAGE_SIZE = 100;
const MAX_VOICE_PAGES = 5;
const MAX_REFS = 12;
const TYPES = Object.freeze(['image', 'video', 'audio']);
// Parameters the node executes itself; they map to dedicated node params instead of extra_params.
const RESERVED_PARAMS = Object.freeze(['model', 'prompt', 'medias', 'use_unlim']);
const CORE_PARAMS = Object.freeze(['aspect_ratio', 'resolution', 'duration']);
// The speech models get their voice from the node's own voice params: the raw fields are not offered a second time.
const SPEECH_NODE_PARAMS = Object.freeze(['voice_id', 'voice_type']);

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
  let options = Array.isArray(parameter.options) ? parameter.options.slice() : null;
  // Audio formats the app cannot store (pcm, ogg_opus) are not offered; the tool rejects them as well.
  if (parameter.name === 'format' && options && options.some((option) => tools.HIGGSFIELD_SPEECH_FORMATS.includes(option))) {
    options = options.filter((option) => tools.HIGGSFIELD_SPEECH_FORMATS.includes(option));
  }
  let kind;
  if (parameter.type === 'string') kind = options && options.length ? 'select' : 'text';
  else if (parameter.type === 'number' || parameter.type === 'integer') {
    kind = options && options.length ? 'select' : parameter.type === 'integer' ? 'integer' : 'number';
  } else if (parameter.type === 'bool') kind = 'boolean';
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
  if (kind === 'number' || kind === 'integer') {
    if (Number.isFinite(parameter.min)) out.min = parameter.min;
    if (Number.isFinite(parameter.max)) out.max = parameter.max;
  }
  if (parameter.default !== undefined) out.default = parameter.default;
  if (typeof parameter.description === 'string' && parameter.description) out.description = parameter.description.slice(0, 500);
  if (parameter.nullable === true) out.nullable = true;
  return out;
}

// Slots whose roles are all audio roles take an audio track, not an image (models_explore types every slot as image).
function isAudioSlot(media) {
  const roles = Array.isArray(media?.roles) ? media.roles.filter((role) => typeof role === 'string' && role.trim()) : [];
  return media?.type === 'audio' || (roles.length > 0 && roles.every((role) => /audio/i.test(role)));
}

// Reference slots of a model: sum of medias[].max capped at 12 (SPEC §10.2), plus the accepted roles.
function referenceSlots(model) {
  const medias = Array.isArray(model?.medias)
    ? model.medias.filter((media) => (!media?.type || media.type === 'image') && !isAudioSlot(media))
    : [];
  let max = 0;
  const roles = [];
  for (const media of medias) {
    max += Number.isFinite(media?.max) && media.max > 0 ? media.max : 1;
    for (const role of Array.isArray(media?.roles) ? media.roles : []) if (typeof role === 'string' && !roles.includes(role)) roles.push(role);
  }
  return { max: Math.min(MAX_REFS, max), roles, required: medias.some((media) => media?.required === true) };
}

// What a model accepts as input, as the node view shows and enforces it: { references: { max, roles, required },
// audio: { max } }. `audio` is only there for video models (max 0 = no audio input; without a stated limit of the model
// the limit of the tool applies). null while the model record has no media list (a list entry that was not read in
// full): the limits are unknown then, which is not the same as "no references".
function capabilitiesOf(model, { type } = {}) {
  if (!isObject(model) || !Array.isArray(model.medias)) return null;
  const caps = { references: referenceSlots(model) };
  if (type === 'video' || model.output_type === 'video') {
    const slot = tools.audioSlotFromModel(model);
    caps.audio = { max: slot ? (slot.max === null ? tools.HIGGSFIELD_MAX_AUDIO_REFS : Math.min(slot.max, tools.HIGGSFIELD_MAX_AUDIO_REFS)) : 0 };
  }
  return caps;
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

// `references` (and for video `audio`) of a model for the option list and the model description; absent keys mean unknown.
function capabilitiesFields(model) {
  const caps = capabilitiesOf(model);
  return caps ? { references: caps.references, ...(caps.audio ? { audio: caps.audio } : {}) } : { references: null };
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
  const speech = tools.HIGGSFIELD_SPEECH_MODELS.includes(model.id);
  for (const parameter of Array.isArray(model.parameters) ? model.parameters : []) {
    if (speech && SPEECH_NODE_PARAMS.includes(parameter?.name)) continue;
    push(mapParameter(parameter));
  }

  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider_name || '',
    type: model.output_type || null,
    description: typeof model.description === 'string' ? model.description.slice(0, 1000) : '',
    tags: Array.isArray(model.tags) ? model.tags.filter((tag) => typeof tag === 'string') : [],
    supportsUnlim: model.supports_unlim === true,
    refs: referenceSlots(model),
    ...capabilitiesFields(model),
    credits: {
      perUnit: Number.isFinite(model.credits_per_unit) ? model.credits_per_unit : null,
      unit: model.credit_unit === 'per_second' || model.credit_unit === 'per_image' ? model.credit_unit : null
    },
    params
  };
}

function stringOf(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

// One voice of list_voices: { voice_id, voice_type: 'preset' | 'element', name, gender, ... } as the MCP answers it
// (live verified); the Higgsfield CLI calls the same fields `id` and `type`, so both spellings are read.
// The label is the name plus the gender, when there is one.
function normalizeVoice(raw) {
  if (!isObject(raw)) return null;
  const id = stringOf(raw.voice_id ?? raw.voiceId ?? raw.id);
  if (!id) return null;
  const type = stringOf(raw.voice_type ?? raw.voiceType ?? raw.type).toLowerCase() === 'element' ? 'element' : 'preset';
  const name = stringOf(raw.name ?? raw.title ?? raw.label) || id;
  const gender = stringOf(raw.gender);
  const language = stringOf(raw.language ?? raw.locale ?? raw.lang);
  return { value: `${type}:${id}`, label: gender ? `${name} (${gender})` : name, id, type, name, gender, language };
}

// list_voices answers a text part ("5 voice(s):\n- Grady (voice_id=..., voice_type=preset)") and, in structuredContent,
// { voices: [...], has_more, next_cursor }: the cursor is only in the structured part (live verified). Without it the
// text is read as JSON, or line by line, as a fallback.
// Returns { voices, nextCursor, hasMore, error } (hasMore is null when the answer does not say).
function parseVoices(text, structured) {
  if (isObject(structured)) {
    if (Array.isArray(structured.voices)) {
      return {
        voices: structured.voices.map(normalizeVoice).filter(Boolean),
        nextCursor: stringOf(structured.next_cursor ?? structured.nextCursor),
        hasMore: typeof structured.has_more === 'boolean' ? structured.has_more : null,
        error: stringOf(structured.error)
      };
    }
    if (stringOf(structured.error)) return { voices: [], nextCursor: '', hasMore: null, error: stringOf(structured.error) };
  }
  const raw = String(text || '');
  const parsed = parseJsonLoose(raw);
  const source = isObject(parsed) ? parsed : null;
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (source) list = [source.voices, source.items, source.results, source.data].find(Array.isArray) || null;
  if (list) {
    const cursor = source ? stringOf(source.next_cursor ?? source.nextCursor) : '';
    return {
      voices: list.map(normalizeVoice).filter(Boolean),
      nextCursor: cursor,
      hasMore: source && typeof source.has_more === 'boolean' ? source.has_more : null,
      error: source ? stringOf(source.error) : ''
    };
  }
  if (source && stringOf(source.error)) return { voices: [], nextCursor: '', hasMore: null, error: stringOf(source.error) };
  const voices = [];
  for (const line of raw.split(/\r?\n/)) {
    const id = /voice_?id["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/i.exec(line);
    if (!id) continue;
    const type = /voice_?type["']?\s*[:=]\s*["']?(preset|element)/i.exec(line);
    const labelled = /(?:^|[\s,;|(])name["']?\s*[:=]\s*["']?([^,;|"'()\n]+)/i.exec(line);
    const head = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').split(/\s+[—–-]\s+|\s*[|(,;]|\s+voice_?id/i)[0].trim();
    const name = (labelled && labelled[1].trim()) || (/^voice_?id/i.test(head) ? '' : head);
    const gender = /gender["']?\s*[:=]\s*["']?([A-Za-z]+)/i.exec(line);
    const voice = normalizeVoice({ voice_id: id[1], voice_type: type ? type[1] : 'preset', name, gender: gender ? gender[1] : '' });
    if (voice) voices.push(voice);
  }
  const cursor = /next_?cursor["']?\s*[:=]\s*["']?([^\s"',}]+)/i.exec(raw);
  const more = /has_?more["']?\s*[:=]\s*(true|false)/i.exec(raw);
  return {
    voices,
    nextCursor: cursor && !/^(null|none|undefined)$/i.test(cursor[1]) ? cursor[1] : '',
    hasMore: more ? more[1].toLowerCase() === 'true' : null,
    error: ''
  };
}

function createCatalog({ higgsfield = higgsfieldLib, now = () => Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  const lists = new Map();
  const models = new Map();
  let voices = null;

  function fresh(entry) {
    return Boolean(entry) && now() - entry.at < ttlMs;
  }

  function clearCache() {
    lists.clear();
    models.clear();
    voices = null;
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
      if (!models.has(item.id) || !fresh(models.get(item.id))) models.set(item.id, { at: now(), model: item, listed: true });
    }
    return unique;
  }

  // Voices for speech and voice change (`list_voices`, up to 5 pages of 100 via next_cursor, which only the structured
  // part of the answer carries), value "<voice_type>:<voice_id>". [] while Higgsfield is disconnected.
  async function listVoices({ refresh = false } = {}) {
    if (!higgsfield.status().connected) return [];
    if (!refresh && fresh(voices)) return voices.items;
    const items = [];
    let cursor = '';
    for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
      const args = { size: VOICE_PAGE_SIZE };
      if (cursor) args.cursor = cursor;
      const answer = await higgsfield.mcpCall('list_voices', args, { withStructured: true });
      const parsed = typeof answer === 'string' ? parseVoices(answer) : parseVoices(answer?.text, answer?.structured);
      if (parsed.error && !parsed.voices.length) throw new Error(`Higgsfield list_voices: ${parsed.error.slice(0, 200)}`);
      items.push(...parsed.voices);
      if (!parsed.nextCursor || parsed.nextCursor === cursor || parsed.hasMore === false) break;
      cursor = parsed.nextCursor;
    }
    const unique = [...new Map(items.map((voice) => [voice.value, voice])).values()];
    voices = { at: now(), items: unique };
    return unique;
  }

  // Full model definition (`models_explore get`); null while disconnected or when the model does not exist.
  async function getModel(modelId, { refresh = false } = {}) {
    const id = String(modelId || '').trim();
    if (!id || !higgsfield.status().connected) return null;
    const cached = models.get(id);
    // An entry that only came from the list and has no media list is not the full record: read it, or the references of
    // the model would look like "none".
    const partial = Boolean(cached?.listed) && !Array.isArray(cached.model?.medias);
    if (!refresh && fresh(cached) && !partial) return cached.model;
    const parsed = parseJsonLoose(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: id }));
    const model = itemsOf(parsed).find((item) => item.id === id) || null;
    if (model) models.set(id, { at: now(), model });
    return model || (partial ? cached.model : null);
  }

  // Synchronous cache read for cost estimates (plan runs without I/O).
  function peekModel(modelId) {
    const cached = models.get(String(modelId || '').trim());
    return fresh(cached) ? cached.model : null;
  }

  return { listModels, listVoices, getModel, peekModel, describeModel, creditsFor, clearCache };
}

const defaultCatalog = createCatalog();

module.exports = {
  CACHE_TTL_MS,
  MAX_REFS,
  MAX_VOICE_PAGES,
  TYPES,
  createCatalog,
  mapParameter,
  referenceSlots,
  capabilitiesOf,
  creditsFor,
  describeModel,
  itemsOf,
  parseVoices,
  listModels: defaultCatalog.listModels,
  listVoices: defaultCatalog.listVoices,
  getModel: defaultCatalog.getModel,
  peekModel: defaultCatalog.peekModel,
  clearCache: defaultCatalog.clearCache
};
