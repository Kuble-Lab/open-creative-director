'use strict';

// What the chat shows under a result besides the asset id: the model that made it, with a readable name, and how it was
// billed. The names are decided once, here, and travel with the asset and the job (`modelName`), so the browser never
// rebuilds them from a slug.
//
//   displayName(id, storedName)   readable name: curated table, else the name the catalogue gave (without the provider
//                                 prefix "Alibaba: "), else the slug without the provider
//   describe(entry)               { model, modelName } of a ledger entry or a job, or {} when no model was recorded
//   billingOf(job)                'credits' for Higgsfield (credits, no USD), otherwise null

const MAX_ID_LENGTH = 120;
const MAX_NAME_LENGTH = 80;

// Still-image models (OpenRouter slugs).
const IMAGE_MODELS = Object.freeze({
  'openai/gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
  'openai/gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'openai/gpt-image-2': 'GPT Image 2',
  'openai/gpt-image-1': 'GPT Image 1',
  'google/gemini-3.1-flash-image': 'Nano Banana 2',
  'google/gemini-3-pro-image': 'Nano Banana Pro',
  'google/gemini-nano-banana-2.1': 'Nano Banana 2.1'
});

// Speech and music models, stored as "elevenlabs/<model_id>".
const AUDIO_MODELS = Object.freeze({
  'elevenlabs/eleven_v4': 'ElevenLabs v4',
  'elevenlabs/eleven_v4_turbo': 'ElevenLabs v4 Turbo',
  'elevenlabs/eleven_v3': 'ElevenLabs v3',
  'elevenlabs/eleven_v3_conversational': 'ElevenLabs v3 Conversational',
  'elevenlabs/eleven_multilingual_v2': 'ElevenLabs Multilingual v2',
  'elevenlabs/eleven_turbo_v2_5': 'ElevenLabs Turbo v2.5',
  'elevenlabs/eleven_flash_v2_5': 'ElevenLabs Flash v2.5',
  'elevenlabs/eleven_turbo_v2': 'ElevenLabs Turbo v2',
  'elevenlabs/eleven_flash_v2': 'ElevenLabs Flash v2',
  'elevenlabs/eleven_monolingual_v1': 'ElevenLabs Monolingual v1',
  // Music models.
  'elevenlabs/music_v2_5': 'ElevenLabs Music v2.5',
  'elevenlabs/music_v2': 'ElevenLabs Music v2',
  'elevenlabs/music_v1': 'ElevenLabs Music v1'
});

// Local tools that run without a paid model.
const LOCAL_MODELS = Object.freeze({
  'hyperframes/rendernode': 'HyperFrames'
});

function cleanId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_ID_LENGTH ? text : '';
}

// "Alibaba: Wan 3.0 Prime" -> "Wan 3.0 Prime". Catalogue names carry the provider in front.
function stripProvider(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  const match = /^[^:/]{1,40}:\s+(\S.*)$/.exec(text);
  return (match ? match[1] : text).trim();
}

function slugWithoutProvider(id) {
  const slash = id.indexOf('/');
  return slash >= 0 && slash < id.length - 1 ? id.slice(slash + 1) : id;
}

// The curated video models live in lib/video-models.js (their texts and limits are there too). Loaded on use: that module
// uses this one for the catalogue names.
function curatedVideoName(id) {
  try {
    return require('./video-models').profileName(id);
  } catch (_) {
    return '';
  }
}

function displayName(id, storedName = '') {
  const model = cleanId(id);
  if (!model) return '';
  const known = IMAGE_MODELS[model] || AUDIO_MODELS[model] || LOCAL_MODELS[model] || curatedVideoName(model);
  if (known) return known;
  let given = stripProvider(storedName).slice(0, MAX_NAME_LENGTH);
  // A name that is just the full slug (stored by an earlier version for a model the catalogue did not name) is no name.
  if (given === model) given = '';
  return given || slugWithoutProvider(model).slice(0, MAX_NAME_LENGTH);
}

// Entries and jobs share the fields `model` and (optionally) `modelName`.
function describe(source) {
  const model = cleanId(source && (source.model || source.metadata?.model));
  if (!model) return {};
  return { model, modelName: displayName(model, source.modelName) };
}

function billingOf(job) {
  if (!job) return null;
  return job.source === 'higgsfield' || job.provider === 'higgsfield' || job.costUnit === 'higgsfield_credits' ? 'credits' : null;
}

// The fields a new ledger entry or job records for its model: nothing when the model is unknown.
function recorded(model, modelName) {
  const id = cleanId(model);
  if (!id) return {};
  const name = stripProvider(modelName).slice(0, MAX_NAME_LENGTH);
  return { model: id, ...(name ? { modelName: name } : {}) };
}

module.exports = { displayName, describe, billingOf, recorded, stripProvider, IMAGE_MODELS, AUDIO_MODELS, LOCAL_MODELS };
