'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CUSTOM_ID_PATTERN,
  MAX_CUSTOM_PRESETS,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_GROUP_LENGTH,
  PromptPresetValidationError,
  PromptPresetNotFoundError,
  createPromptPresetsStore
} = require('../lib/prompt-presets');

function builtIn(id, group, title) {
  return { id, group, title, description: `${title} Beschreibung`, prompt: `${title}: [Platzhalter]` };
}

function customPayload(suffix = '') {
  return {
    title: `Eigene Vorlage${suffix}`,
    description: 'Kurzer Hinweis',
    prompt: 'Produziere [Inhalt] als konkretes Visual.',
    group: 'Gruppe A'
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function expectThrows(fn, ErrorType, pattern) {
  assert.throws(fn, (err) => err instanceof ErrorType && pattern.test(err.message), pattern.toString());
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-prompt-presets-'));
  const configFile = path.join(directory, 'config', 'prompt-presets.json');
  const customFile = path.join(directory, 'data', 'prompt-presets-custom.json');
  const renames = [];
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          renames.push({ source, destination, sourceExisted: fs.existsSync(source) });
          return fs.renameSync(source, destination);
        };
      }
      return target[property];
    }
  });

  try {
    writeJson(configFile, [
      builtIn('builtin-a', 'Gruppe A', 'A eingebaut'),
      builtIn('builtin-b', 'Gruppe B', 'B eingebaut')
    ]);
    writeJson(customFile, [
      { id: 'custom-00000001', ...customPayload(' B'), group: 'Gruppe B', custom: true },
      { id: 'custom-00000002', ...customPayload(' C'), group: 'Gruppe C', custom: true },
      { id: 'custom-00000003', ...customPayload(' A'), group: 'Gruppe A', custom: true }
    ]);

    let nextId = 4;
    const store = createPromptPresetsStore({
      configFile,
      customFile,
      fsImpl,
      idGenerator: () => `custom-${String(nextId++).padStart(8, '0')}`
    });

    const merged = store.listPresets();
    assert.deepEqual(merged.map((preset) => preset.id), [
      'builtin-a',
      'custom-00000003',
      'builtin-b',
      'custom-00000001',
      'custom-00000002'
    ], 'Gruppenreihenfolge sowie built-in-vor-custom Sortierung stimmen nicht.');
    assert.equal(merged[0].custom, undefined);
    assert.equal(merged[1].custom, true);

    const created = store.createCustomPreset(customPayload(' Neu'));
    assert.match(created.id, CUSTOM_ID_PATTERN);
    assert.equal(created.custom, true);
    assert.equal(created.title, 'Eigene Vorlage Neu');
    assert.equal(renames.length, 1, 'Persistenz muss genau einen atomaren Rename ausfuehren.');
    assert.equal(renames[0].destination, customFile);
    assert.equal(renames[0].sourceExisted, true);
    assert.equal(fs.readdirSync(path.dirname(customFile)).some((name) => name.endsWith('.tmp')), false);

    const reloaded = createPromptPresetsStore({ configFile, customFile });
    assert.ok(reloaded.loadCustomPresets().some((preset) => preset.id === created.id), 'Persistierte Vorlage fehlt nach Reload.');

    const updated = store.updateCustomPreset(created.id, {
      title: 'Aktualisiert',
      description: '',
      prompt: 'Neuer Prompt mit [Thema].',
      group: 'Gruppe B'
    });
    assert.equal(updated.title, 'Aktualisiert');
    assert.equal(updated.description, '');
    assert.equal(store.listPresets().find((preset) => preset.id === created.id).group, 'Gruppe B');
    const deleted = store.deleteCustomPreset(created.id);
    assert.equal(deleted.id, created.id);
    assert.equal(store.loadCustomPresets().some((preset) => preset.id === created.id), false);

    expectThrows(() => store.updateCustomPreset('custom-ffffffff', customPayload()), PromptPresetNotFoundError, /nicht gefunden/);
    expectThrows(() => store.deleteCustomPreset('builtin-a'), PromptPresetNotFoundError, /nicht gefunden/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), title: '' }), PromptPresetValidationError, /nicht leer/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }), PromptPresetValidationError, /maximal 60/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }), PromptPresetValidationError, /maximal 120/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) }), PromptPresetValidationError, /maximal 4000/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), group: 'x'.repeat(MAX_GROUP_LENGTH + 1) }), PromptPresetValidationError, /maximal 40/);
    expectThrows(() => store.createCustomPreset({ ...customPayload(), extra: true }), PromptPresetValidationError, /nicht erlaubt/);

    const full = Array.from({ length: MAX_CUSTOM_PRESETS }, (_, index) => ({
      id: `custom-${index.toString(16).padStart(8, '0')}`,
      ...customPayload(` ${index}`),
      custom: true
    }));
    writeJson(customFile, full);
    expectThrows(() => store.createCustomPreset(customPayload(' zu viel')), PromptPresetValidationError, /maximal 50/);

    console.log('Prompt-Vorlagen: Config-/Custom-Merge, Gruppierung, CRUD, Limits, IDs und atomare Persistenz sind korrekt.');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
