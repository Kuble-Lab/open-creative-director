'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-atomic-sync-'));
  const original = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  try {
    const settings = require('../lib/settings').createSettingsStore({ file: path.join(directory, 'settings.json'), env: {} });
    const nodes = require('../lib/rendernodes-store').createRenderNodesStore({ file: path.join(directory, 'nodes.json') });
    const uploads = require('../lib/mcp/uploads').createUploads({ file: path.join(directory, 'uploads.json'), sessions: {
      isValidId: () => true, createSession: async () => ({ id: 'test-session' }), readSessionAccess: async () => ({})
    } });
    let keyId = 0;
    const cases = [
      { name: 'settings', write: () => settings.setSetting('OPENROUTER_API_KEY', 'test-placeholder') },
      { name: 'nodes', write: () => nodes.createNode({ name: 'Test', url: 'https://render.example.test', token: 'test-placeholder' }) },
      { name: 'uploads', write: () => uploads.sessionFor({ id: `key-${++keyId}` }, { active: false }) }
    ];
    for (const entry of cases) {
      for (const method of Object.keys(original)) {
        fs[method] = (...args) => {
          if (method === 'writeFileSync') original.writeFileSync(...args);
          throw new Error('injected sync failure');
        };
        await assert.rejects(async () => entry.write(), /injected sync failure/, entry.name);
        Object.assign(fs, original);
        assert.equal((await fsp.readdir(directory)).some((name) => name.endsWith('.tmp')), false, `${entry.name}/${method}: no leftovers`);
      }
      await entry.write();
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directory, `${entry.name}.json`), 'utf8')));
    }
  } finally {
    Object.assign(fs, original);
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('test-atomic-sync-writes.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
