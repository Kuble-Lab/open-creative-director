'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');

const CONFIG_PRESETS_FILE = path.join(PATHS.root, 'config', 'prompt-presets.json');
const CUSTOM_PRESETS_FILE = path.join(PATHS.root, 'data', 'prompt-presets-custom.json');
const CUSTOM_ID_PATTERN = /^custom-[0-9a-f]{8}$/;
const MAX_CUSTOM_PRESETS = 50;
const MAX_TITLE_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 120;
const MAX_PROMPT_LENGTH = 4000;
const MAX_GROUP_LENGTH = 40;

class PromptPresetValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptPresetValidationError';
  }
}

class PromptPresetNotFoundError extends Error {
  constructor(id) {
    super(`Die eigene Vorlage ${id} wurde nicht gefunden.`);
    this.name = 'PromptPresetNotFoundError';
  }
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PromptPresetValidationError('Die Vorlagen-Daten muessen ein Objekt sein.');
  }
  return value;
}

function requireAllowedFields(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PromptPresetValidationError(`Das Feld ${key} ist fuer Vorlagen nicht erlaubt.`);
  }
}

function validateText(raw, { label, max, required = true }) {
  if (typeof raw !== 'string') throw new PromptPresetValidationError(`${label} muss ein String sein.`);
  const value = raw.trim();
  if (required && !value) throw new PromptPresetValidationError(`${label} darf nicht leer sein.`);
  if ([...value].length > max) {
    throw new PromptPresetValidationError(`${label} darf maximal ${max} Zeichen lang sein.`);
  }
  return value;
}

function validateInput(raw) {
  const value = requireObject(raw);
  requireAllowedFields(value, new Set(['title', 'description', 'prompt', 'group']));
  return {
    title: validateText(value.title, { label: 'Der Vorlagen-Name', max: MAX_TITLE_LENGTH }),
    description: validateText(value.description ?? '', {
      label: 'Die Beschreibung',
      max: MAX_DESCRIPTION_LENGTH,
      required: false
    }),
    prompt: validateText(value.prompt, { label: 'Der Prompt', max: MAX_PROMPT_LENGTH }),
    group: validateText(value.group, { label: 'Die Gruppe', max: MAX_GROUP_LENGTH })
  };
}

function mergePresets(configPresets, customPresets) {
  const groups = [];
  const byGroup = new Map();
  for (const preset of [...configPresets, ...customPresets]) {
    if (!byGroup.has(preset.group)) {
      groups.push(preset.group);
      byGroup.set(preset.group, { builtIn: [], custom: [] });
    }
    byGroup.get(preset.group)[preset.custom === true ? 'custom' : 'builtIn'].push(preset);
  }
  return groups.flatMap((group) => {
    const entries = byGroup.get(group);
    return [...entries.builtIn, ...entries.custom].map((preset) => ({ ...preset }));
  });
}

function createPromptPresetsStore({
  configFile = CONFIG_PRESETS_FILE,
  customFile = CUSTOM_PRESETS_FILE,
  idGenerator = () => `custom-${crypto.randomBytes(4).toString('hex')}`,
  fsImpl = fs
} = {}) {
  let configCache = null;

  function readJsonArray(file, label, { missingIsEmpty = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (err) {
      if (missingIsEmpty && err.code === 'ENOENT') return [];
      throw new Error(`${label} ist ungueltig oder konnte nicht gelesen werden.`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${label} muss ein JSON-Array enthalten.`);
    return parsed;
  }

  function loadConfigPresets() {
    if (configCache) return configCache.map((preset) => ({ ...preset }));
    const parsed = readJsonArray(configFile, 'config/prompt-presets.json');
    const ids = new Set();
    configCache = parsed.map((raw) => {
      const value = requireObject(raw);
      requireAllowedFields(value, new Set(['id', 'title', 'description', 'prompt', 'group']));
      const id = validateText(value.id, { label: 'Die eingebaute Vorlagen-ID', max: 80 });
      if (ids.has(id)) throw new Error('config/prompt-presets.json enthaelt doppelte IDs.');
      ids.add(id);
      return { id, ...validateInput({
        title: value.title,
        description: value.description,
        prompt: value.prompt,
        group: value.group
      }) };
    });
    return configCache.map((preset) => ({ ...preset }));
  }

  function validateStoredCustom(raw) {
    const value = requireObject(raw);
    requireAllowedFields(value, new Set(['id', 'title', 'description', 'prompt', 'group', 'custom']));
    if (typeof value.id !== 'string' || !CUSTOM_ID_PATTERN.test(value.id)) {
      throw new Error('Eine gespeicherte eigene Vorlagen-ID ist ungueltig.');
    }
    if (value.custom !== true) throw new Error('Eine gespeicherte eigene Vorlage muss custom: true enthalten.');
    return { id: value.id, ...validateInput({
      title: value.title,
      description: value.description,
      prompt: value.prompt,
      group: value.group
    }), custom: true };
  }

  function loadCustomPresets() {
    const parsed = readJsonArray(customFile, 'data/prompt-presets-custom.json', { missingIsEmpty: true });
    if (parsed.length > MAX_CUSTOM_PRESETS) {
      throw new Error(`data/prompt-presets-custom.json darf maximal ${MAX_CUSTOM_PRESETS} Eintraege enthalten.`);
    }
    const presets = parsed.map(validateStoredCustom);
    if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
      throw new Error('data/prompt-presets-custom.json enthaelt doppelte IDs.');
    }
    return presets;
  }

  function writeCustomPresets(presets) {
    fsImpl.mkdirSync(path.dirname(customFile), { recursive: true });
    const temporaryFile = `${customFile}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(temporaryFile, `${JSON.stringify(presets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fsImpl.chmodSync(temporaryFile, 0o600);
    fsImpl.renameSync(temporaryFile, customFile);
    fsImpl.chmodSync(customFile, 0o600);
  }

  function listPresets() {
    return mergePresets(loadConfigPresets(), loadCustomPresets());
  }

  function createCustomPreset(raw) {
    const presets = loadCustomPresets();
    if (presets.length >= MAX_CUSTOM_PRESETS) {
      throw new PromptPresetValidationError(`Es sind maximal ${MAX_CUSTOM_PRESETS} eigene Vorlagen erlaubt.`);
    }
    const clean = validateInput(raw);
    let id = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = idGenerator();
      if (CUSTOM_ID_PATTERN.test(candidate) && !presets.some((preset) => preset.id === candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('Es konnte keine eindeutige Vorlagen-ID erzeugt werden.');
    const preset = { id, ...clean, custom: true };
    writeCustomPresets([...presets, preset]);
    return { ...preset };
  }

  function updateCustomPreset(id, raw) {
    const presets = loadCustomPresets();
    const index = presets.findIndex((preset) => preset.id === id);
    if (!CUSTOM_ID_PATTERN.test(String(id || '')) || index < 0) throw new PromptPresetNotFoundError(id);
    const updated = { id, ...validateInput(raw), custom: true };
    writeCustomPresets(presets.map((preset, presetIndex) => presetIndex === index ? updated : preset));
    return { ...updated };
  }

  function deleteCustomPreset(id) {
    const presets = loadCustomPresets();
    const existing = presets.find((preset) => preset.id === id);
    if (!CUSTOM_ID_PATTERN.test(String(id || '')) || !existing) throw new PromptPresetNotFoundError(id);
    writeCustomPresets(presets.filter((preset) => preset.id !== id));
    return { ...existing };
  }

  return {
    loadConfigPresets,
    loadCustomPresets,
    listPresets,
    createCustomPreset,
    updateCustomPreset,
    deleteCustomPreset
  };
}

const store = createPromptPresetsStore();

module.exports = {
  CONFIG_PRESETS_FILE,
  CUSTOM_PRESETS_FILE,
  CUSTOM_ID_PATTERN,
  MAX_CUSTOM_PRESETS,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_GROUP_LENGTH,
  PromptPresetValidationError,
  PromptPresetNotFoundError,
  mergePresets,
  createPromptPresetsStore,
  listPresets: store.listPresets,
  createCustomPreset: store.createCustomPreset,
  updateCustomPreset: store.updateCustomPreset,
  deleteCustomPreset: store.deleteCustomPreset
};
