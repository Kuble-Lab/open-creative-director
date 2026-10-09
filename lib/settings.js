'use strict';

const fs = require('fs');
const path = require('path');

const { PATHS } = require('./config');

const SETTING_NAMES = Object.freeze([
  'OPENROUTER_API_KEY',
  'ELEVENLABS_API_KEY',
  'FAL_KEY',
  // Google AI Studio (Gemini API): the Google image models straight at Google instead of through OpenRouter (lib/gemini-images.js)
  'GEMINI_API_KEY',
  'GTS_API_TOKEN',
  'GTS_BASE_URL',
  'RENDER_NODE_URL',
  'RENDER_NODE_TOKEN'
]);
const SETTING_NAME_SET = new Set(SETTING_NAMES);
// Plain on/off switches (no secrets, never masked). They live in the same file under "preferences".
const PREFERENCE_DEFAULTS = Object.freeze({
  // Ask for the video model in the chat before every video (the card of lib/video-models.js). Off = the configured
  // default model starts right away.
  askVideoModel: true
});
const PREFERENCE_NAMES = Object.freeze(Object.keys(PREFERENCE_DEFAULTS));
const SETTINGS_FILE = path.join(PATHS.root, 'data', 'settings.json');
const MAX_VALUE_LENGTH = 500;

function createSettingsStore({ file = SETTINGS_FILE, env = process.env } = {}) {
  let values = {};
  let preferences = {};
  let environmentFallbacks = null;

  function requireAllowedName(name) {
    if (typeof name !== 'string' || !SETTING_NAME_SET.has(name)) {
      throw new Error('Dieser Settings-Key ist nicht erlaubt.');
    }
    return name;
  }

  function captureEnvironmentFallbacks() {
    if (environmentFallbacks) return;
    environmentFallbacks = {};
    for (const name of SETTING_NAMES) {
      if (typeof env[name] === 'string') environmentFallbacks[name] = env[name];
    }
  }

  function mirrorSettingsToEnvironment() {
    captureEnvironmentFallbacks();
    for (const name of SETTING_NAMES) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        env[name] = values[name];
      } else if (Object.prototype.hasOwnProperty.call(environmentFallbacks, name)) {
        env[name] = environmentFallbacks[name];
      } else {
        delete env[name];
      }
    }
  }

  function loadSettings() {
    captureEnvironmentFallbacks();
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error('data/settings.json ist ungueltig oder konnte nicht gelesen werden.');
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('data/settings.json muss ein JSON-Objekt enthalten.');
    }

    values = {};
    for (const name of SETTING_NAMES) {
      if (typeof parsed[name] !== 'string') continue;
      const value = parsed[name].trim();
      if (value && [...value].length <= MAX_VALUE_LENGTH) values[name] = value;
    }
    preferences = {};
    const storedPreferences = parsed.preferences && typeof parsed.preferences === 'object' && !Array.isArray(parsed.preferences)
      ? parsed.preferences
      : {};
    for (const name of PREFERENCE_NAMES) {
      if (typeof storedPreferences[name] === 'boolean') preferences[name] = storedPreferences[name];
    }
    mirrorSettingsToEnvironment();
    return listSettingsStatus();
  }

  function getSetting(name) {
    requireAllowedName(name);
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    return typeof env[name] === 'string' ? env[name] : '';
  }

  function writeSettings() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    const document = Object.keys(preferences).length ? { ...values, preferences } : values;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  }

  function setSetting(name, rawValue) {
    requireAllowedName(name);
    if (typeof rawValue !== 'string') throw new TypeError('Der Settings-Wert muss ein String sein.');
    const value = rawValue.trim();
    if ([...value].length > MAX_VALUE_LENGTH) {
      throw new Error(`Der Settings-Wert darf maximal ${MAX_VALUE_LENGTH} Zeichen lang sein.`);
    }
    const previousValues = values;
    values = { ...values };
    if (value) values[name] = value;
    else delete values[name];
    try {
      writeSettings();
    } catch (err) {
      values = previousValues;
      throw err;
    }
    mirrorSettingsToEnvironment();
    return listSettingsStatus();
  }

  function getPreference(name) {
    if (!PREFERENCE_NAMES.includes(name)) throw new Error('Diese Einstellung ist nicht erlaubt.');
    return Object.prototype.hasOwnProperty.call(preferences, name) ? preferences[name] : PREFERENCE_DEFAULTS[name];
  }

  function listPreferences() {
    return Object.fromEntries(PREFERENCE_NAMES.map((name) => [name, getPreference(name)]));
  }

  function setPreference(name, value) {
    if (!PREFERENCE_NAMES.includes(name)) throw new Error('Diese Einstellung ist nicht erlaubt.');
    if (typeof value !== 'boolean') throw new TypeError('Der Wert muss true oder false sein.');
    const previous = preferences;
    preferences = { ...preferences };
    if (value === PREFERENCE_DEFAULTS[name]) delete preferences[name];
    else preferences[name] = value;
    try {
      writeSettings();
    } catch (err) {
      preferences = previous;
      throw err;
    }
    return listPreferences();
  }

  function maskValue(value) {
    const clean = String(value || '');
    if ([...clean].length < 12) return '…gesetzt';
    const characters = [...clean];
    return `${characters.slice(0, 4).join('')}…${characters.slice(-4).join('')}`;
  }

  function listSettingsStatus() {
    return SETTING_NAMES.map((name) => {
      const fromSettings = Object.prototype.hasOwnProperty.call(values, name);
      const value = fromSettings ? values[name] : typeof env[name] === 'string' ? env[name].trim() : '';
      return {
        name,
        source: value ? (fromSettings ? 'settings' : 'env') : null,
        masked: value ? maskValue(value) : null
      };
    });
  }

  return { loadSettings, getSetting, setSetting, listSettingsStatus, getPreference, setPreference, listPreferences };
}

const settings = createSettingsStore();

module.exports = {
  SETTING_NAMES,
  PREFERENCE_NAMES,
  PREFERENCE_DEFAULTS,
  SETTINGS_FILE,
  MAX_VALUE_LENGTH,
  createSettingsStore,
  loadSettings: settings.loadSettings,
  getSetting: settings.getSetting,
  setSetting: settings.setSetting,
  listSettingsStatus: settings.listSettingsStatus,
  getPreference: settings.getPreference,
  setPreference: settings.setPreference,
  listPreferences: settings.listPreferences
};
