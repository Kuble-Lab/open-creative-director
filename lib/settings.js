'use strict';

const fs = require('fs');
const path = require('path');

const { PATHS } = require('./config');

const SETTING_NAMES = Object.freeze([
  'OPENROUTER_API_KEY',
  'ELEVENLABS_API_KEY',
  'GTS_API_TOKEN',
  'GTS_BASE_URL',
  'RENDER_NODE_URL',
  'RENDER_NODE_TOKEN'
]);
const SETTING_NAME_SET = new Set(SETTING_NAMES);
const SETTINGS_FILE = path.join(PATHS.root, 'data', 'settings.json');
const MAX_VALUE_LENGTH = 500;

function createSettingsStore({ file = SETTINGS_FILE, env = process.env } = {}) {
  let values = {};
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
    fs.writeFileSync(temporaryFile, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

  return { loadSettings, getSetting, setSetting, listSettingsStatus };
}

const settings = createSettingsStore();

module.exports = {
  SETTING_NAMES,
  SETTINGS_FILE,
  MAX_VALUE_LENGTH,
  createSettingsStore,
  loadSettings: settings.loadSettings,
  getSetting: settings.getSetting,
  setSetting: settings.setSetting,
  listSettingsStatus: settings.listSettingsStatus
};
