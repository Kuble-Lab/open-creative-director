'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocd-atomic-'));
  const { PATHS } = require('../lib/config');
  const originalProjects = PATHS.projectsDir;
  const originalAssets = PATHS.assetsDir;
  PATHS.projectsDir = directory;
  PATHS.assetsDir = path.join(directory, 'assets');
  const store = require('../lib/store');
  const rename = fs.rename;
  const writeFile = fs.writeFile;
  try {
    const states = Array.from({ length: 100 }, (_, index) => ({ id: 'concurrent', index, text: String(index).repeat(10000) }));
    await Promise.all(states.map((state) => store.writeSession(state, { touchUpdatedAt: false })));
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'concurrent.json'), 'utf8'));
    assert.deepEqual(stored, states[stored.index], 'one complete snapshot, never a mix of concurrent writes');
    assert.deepEqual(await fs.readdir(directory), ['concurrent.json']);
    for (const method of ['writeFile', 'rename']) {
      fs[method] = async (...args) => {
        if (method === 'writeFile') await writeFile(...args); // partial write must also be removed
        throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
      };
      await assert.rejects(store.writeSession(states[0], { touchUpdatedAt: false }), /injected disk failure/);
      fs.rename = rename;
      fs.writeFile = writeFile;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'concurrent.json'), 'utf8')), stored);
      assert.deepEqual(await fs.readdir(directory), ['concurrent.json'], `${method} failure leaves no temporary file`);
    }
    const ledgers = states.map(({ index, text }) => [{ id: `asset-${index}`, text }]);
    await Promise.all(ledgers.map((entries) => store.writeLedger('concurrent', entries)));
    const ledger = await store.readLedger('concurrent');
    assert.deepEqual(ledger, ledgers[Number(ledger[0].id.split('-')[1])]);
    assert.equal((await fs.readdir(store.sessionAssetDir('concurrent'))).some((name) => name.endsWith('.tmp')), false);
    for (const provider of ['chatgpt', 'higgsfield']) {
      const file = path.join(directory, `${provider}.json`);
      const tokens = require(`../lib/${provider}`).createFileTokenStore(file);
      const values = states.map(({ index, text }) => ({ index, text }));
      await Promise.all(values.map((value) => tokens.write(value)));
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepEqual(value, values[value.index]);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      fs.rename = async () => { throw new Error('injected rename failure'); };
      await assert.rejects(tokens.write(values[0]), /injected rename failure/);
      fs.rename = rename;
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), value);
      assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
    }
  } finally {
    fs.rename = rename;
    fs.writeFile = writeFile;
    PATHS.projectsDir = originalProjects;
    PATHS.assetsDir = originalAssets;
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('test-atomic-writes.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
