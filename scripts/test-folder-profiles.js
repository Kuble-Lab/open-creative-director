'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');

async function main() {
  store.ensureDirs();
  const folder = `Store-Profil-${Date.now()}`;

  try {
    assert.equal(await store.readFolderProfile(folder), null);
    const written = await store.writeFolderProfile(folder, {
      guidelines: '  Klare Markenfarben  ',
      contextBrains: ['brain-1', 'brain-2', 'brain-1']
    });
    assert.equal(written.guidelines, 'Klare Markenfarben');
    assert.deepEqual(written.contextBrains, ['brain-1', 'brain-2']);
    assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await store.readFolderProfile(folder), written);

    await assert.rejects(
      store.writeFolderProfile(folder, { guidelines: 'x'.repeat(30001) }),
      /maximal 30000/
    );
    await assert.rejects(
      store.writeFolderProfile(folder, { contextBrains: ['1', '2', '3', '4', '5', '6'] }),
      /maximal 5/
    );
    await assert.rejects(store.readFolderProfile('x'.repeat(61)), /maximal 60/);

    assert.equal(await store.writeFolderProfile(folder, { guidelines: ' ', contextBrains: [] }), null);
    assert.equal(await store.readFolderProfile(folder), null);
    console.log('Projekt-Profile: Schreiben, Lesen, Loeschen und Limits sind korrekt.');
  } finally {
    await store.writeFolderProfile(folder, {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
