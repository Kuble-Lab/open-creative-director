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
  config.publicBaseUrl = publicBaseUrl();
  return config;
}

function availableBrainModels(brainModels, chatgptConnected = false) {
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
  availableDefaultBrain
};
