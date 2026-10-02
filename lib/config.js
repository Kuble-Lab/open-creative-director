'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHATGPT_BRAIN_MODELS = Object.freeze([
  'chatgpt/gpt-6.1-sol',
  'chatgpt/gpt-5.6-sol',
  'chatgpt/gpt-5.6-terra',
  'chatgpt/gpt-5.6-luna'
]);
const PATHS = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  assetsDir: path.join(ROOT, 'assets'),
  projectsDir: path.join(ROOT, 'projects'),
  publicRefsDir: path.join(ROOT, 'data', 'public-refs'),
  configFile: path.join(ROOT, 'config.json'),
  envFile: path.join(ROOT, '.env'),
  systemPrompt: path.join(ROOT, 'SystemPrompt-Video-Creativ-Director.md')
};

const DEFAULT_CONFIG = {
  imageModel: 'openai/gpt-image-2',
  // The image models the node view offers next to imageModel (image.generate and image.edit have a model list).
  imageModels: ['openai/gpt-image-2', 'google/gemini-3-pro-image'],
  videoModel: 'bytedance/seedance-2.5',
  brainModels: ['anthropic/claude-opus-4.6', 'openai/gpt-5.2', 'google/gemini-3.1-pro'],
  defaultBrain: 'anthropic/claude-opus-4.6'
};

// Load .env: prefer the native loader, fall back to a tiny parser.
function loadEnv() {
  if (!fs.existsSync(PATHS.envFile)) return;
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(PATHS.envFile);
      return;
    } catch (err) {
      console.warn('[env] loadEnvFile fehlgeschlagen, nutze Fallback-Parser:', err.message);
    }
  }
  try {
    const raw = fs.readFileSync(PATHS.envFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[env] .env konnte nicht gelesen werden:', err.message);
  }
}

function loadConfig() {
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(PATHS.configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(PATHS.configFile, 'utf8'));
      config = { ...config, ...parsed };
    } catch (err) {
      console.warn('[config] config.json ist ungueltig, nutze Defaults:', err.message);
    }
  } else {
    try {
      fs.writeFileSync(PATHS.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      console.log('[config] config.json mit Defaults erzeugt.');
    } catch (err) {
      console.warn('[config] config.json konnte nicht geschrieben werden:', err.message);
    }
  }
  if (!Array.isArray(config.brainModels) || config.brainModels.length === 0) {
    config.brainModels = DEFAULT_CONFIG.brainModels.slice();
  }
  if (!config.defaultBrain || !config.brainModels.includes(config.defaultBrain)) {
    config.defaultBrain = config.brainModels[0];
  }
  config.restrictedBrainModels = normaliseRestrictedBrainModels(config.restrictedBrainModels);
  config.imageModels = normaliseImageModels(config.imageModels, config.imageModel);
  config.publicBaseUrl = publicBaseUrl();
  return config;
}

// config.restrictedBrainModels: the only brain models participants and guests may see and use. A list of model ids
// (anything but the ChatGPT subscription models, which they never get). Empty or missing = no extra restriction.
function normaliseRestrictedBrainModels(value) {
  if (!Array.isArray(value)) return [];
  const models = value
    .filter((model) => typeof model === 'string')
    .map((model) => model.trim())
    .filter((model) => model && model.length <= 200 && !model.startsWith('chatgpt/'));
  return [...new Set(models)];
}

// config.imageModels: the OpenRouter image models the node view offers. The model of config.imageModel always comes
// first (it is what a node without a choice uses). A missing or unusable list falls back to the default list.
const IMAGE_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
function normaliseImageModels(value, imageModel) {
  const listed = Array.isArray(value) ? value : DEFAULT_CONFIG.imageModels;
  const models = [imageModel, ...listed]
    .filter((model) => typeof model === 'string')
    .map((model) => model.trim())
    .filter((model) => model.length <= 200 && IMAGE_MODEL_ID.test(model));
  return [...new Set(models)];
}

// `restrictedModels`: the list for a participant or guest (see normaliseRestrictedBrainModels); when it is not empty it
// replaces the whole list, regardless of what else is configured.
function availableBrainModels(brainModels, chatgptConnected = false, restrictedModels = []) {
  const restrictedList = normaliseRestrictedBrainModels(restrictedModels);
  if (restrictedList.length) return restrictedList;
  const configured = Array.isArray(brainModels) ? brainModels : [];
  const regular = configured.filter((model) => typeof model === 'string' && !model.startsWith('chatgpt/'));
  if (!chatgptConnected) return regular;
  return [...new Set([...regular, ...CHATGPT_BRAIN_MODELS])];
}

function availableDefaultBrain(defaultBrain, brainModels) {
  if (brainModels.includes(defaultBrain)) return defaultBrain;
  return brainModels[0] || DEFAULT_CONFIG.defaultBrain;
}

function publicBaseUrl() {
  const value = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (!/^https:\/\/[^\s]+$/i.test(value)) {
    throw new Error('PUBLIC_BASE_URL muss eine oeffentliche HTTPS-URL sein');
  }
  return value;
}

module.exports = {
  PATHS,
  DEFAULT_CONFIG,
  CHATGPT_BRAIN_MODELS,
  loadEnv,
  loadConfig,
  publicBaseUrl,
  availableBrainModels,
  availableDefaultBrain,
  normaliseRestrictedBrainModels,
  normaliseImageModels
};
