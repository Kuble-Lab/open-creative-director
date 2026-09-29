'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { SETTING_NAMES, createSettingsStore } = require('../lib/settings');

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-settings-'));
  const file = path.join(directory, 'settings.json');
  const originalEnvironment = Object.fromEntries(
    SETTING_NAMES.map((name) => [name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined])
  );

  try {
    process.env.OPENROUTER_API_KEY = 'env-fallback-value';
    delete process.env.GTS_API_TOKEN;
    const settings = createSettingsStore({ file, env: process.env });
    settings.loadSettings();

    assert.equal(settings.getSetting('OPENROUTER_API_KEY'), 'env-fallback-value');
    assert.deepEqual(
      settings.listSettingsStatus().find((entry) => entry.name === 'OPENROUTER_API_KEY'),
      { name: 'OPENROUTER_API_KEY', source: 'env', masked: 'env-…alue' }
    );
    assert.throws(() => settings.setSetting('NICHT_ERLAUBT', 'wert'), /nicht erlaubt/);
    assert.throws(() => settings.setSetting('GTS_API_TOKEN', 'x'.repeat(501)), /maximal 500/);

    settings.setSetting('OPENROUTER_API_KEY', '  settings-secret-value  ');
    assert.equal(settings.getSetting('OPENROUTER_API_KEY'), 'settings-secret-value');
    assert.equal(process.env.OPENROUTER_API_KEY, 'settings-secret-value');
    assert.deepEqual(
      settings.listSettingsStatus().find((entry) => entry.name === 'OPENROUTER_API_KEY'),
      { name: 'OPENROUTER_API_KEY', source: 'settings', masked: 'sett…alue' }
    );

    settings.setSetting('GTS_API_TOKEN', 'short-key');
    assert.equal(process.env.GTS_API_TOKEN, 'short-key');
    assert.deepEqual(
      settings.listSettingsStatus().find((entry) => entry.name === 'GTS_API_TOKEN'),
      { name: 'GTS_API_TOKEN', source: 'settings', masked: '…gesetzt' }
    );
    settings.setSetting('GTS_BASE_URL', ' https://knowledge.example.test/api/chatgpt/ ');
    assert.equal(process.env.GTS_BASE_URL, 'https://knowledge.example.test/api/chatgpt/');

    const stored = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.deepEqual(stored, {
      OPENROUTER_API_KEY: 'settings-secret-value',
      GTS_API_TOKEN: 'short-key',
      GTS_BASE_URL: 'https://knowledge.example.test/api/chatgpt/'
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    settings.setSetting('OPENROUTER_API_KEY', '');
    assert.equal(settings.getSetting('OPENROUTER_API_KEY'), 'env-fallback-value');
    assert.equal(process.env.OPENROUTER_API_KEY, 'env-fallback-value');
    assert.equal(
      settings.listSettingsStatus().find((entry) => entry.name === 'OPENROUTER_API_KEY').source,
      'env'
    );

    settings.setSetting('GTS_API_TOKEN', '   ');
    assert.equal(settings.getSetting('GTS_API_TOKEN'), '');
    assert.equal(process.env.GTS_API_TOKEN, undefined);
    settings.setSetting('GTS_BASE_URL', '');
    assert.equal(settings.getSetting('GTS_BASE_URL'), '');
    assert.equal(process.env.GTS_BASE_URL, undefined);
    assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), {});
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // fal.ai key (node view): whitelisted, mirrored into the environment, masked in the status list
    assert.ok(SETTING_NAMES.includes('FAL_KEY'));
    delete process.env.FAL_KEY;
    settings.loadSettings();
    assert.equal(settings.listSettingsStatus().find((entry) => entry.name === 'FAL_KEY').source, null);
    settings.setSetting('FAL_KEY', ' 00000000-aaaa-bbbb-cccc-000000000000:secretvalue ');
    assert.equal(settings.getSetting('FAL_KEY'), '00000000-aaaa-bbbb-cccc-000000000000:secretvalue');
    assert.equal(process.env.FAL_KEY, '00000000-aaaa-bbbb-cccc-000000000000:secretvalue');
    assert.deepEqual(
      settings.listSettingsStatus().find((entry) => entry.name === 'FAL_KEY'),
      { name: 'FAL_KEY', source: 'settings', masked: '0000…alue' }
    );
    settings.setSetting('FAL_KEY', '');
    assert.equal(process.env.FAL_KEY, undefined);
    assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), {});

    console.log('Settings: Whitelist, Maskierung, Set/Get/Delete, Env-Fallback, Spiegelung und Dateirechte sind korrekt.');
  } finally {
    for (const name of SETTING_NAMES) {
      if (originalEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnvironment[name];
    }
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
