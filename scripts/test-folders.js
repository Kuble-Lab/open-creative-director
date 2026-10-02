'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');

const store = require('../lib/store');
const { PATHS } = require('../lib/config');

async function main() {
  store.ensureDirs();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const registered = `Registry-${suffix}`;
  const caseVariant = `registry-${suffix}`;
  const renamed = `Umbenannt-${suffix}`;
  const duplicate = `Duplikat-${suffix}`;
  const automatic = `Auto-${suffix}`;
  const profileOnly = `Profil-${suffix}`;
  const cleanup = new Set([registered, caseVariant, renamed, duplicate, automatic, profileOnly]);
  const session = await store.createSession();

  try {
    assert.equal(await store.createFolder(`  ${registered}  `), registered);
    await assert.rejects(store.createFolder(caseVariant), (err) => err.code === 'FOLDER_EXISTS');
    await assert.rejects(store.createFolder(registered), (err) => err.code === 'FOLDER_EXISTS');

    let folders = await store.listFolders();
    assert.ok(folders.includes(registered));
    assert.ok(!folders.includes(caseVariant), 'Projektnamen muessen ohne Beachtung der Schreibweise eindeutig sein');

    await store.createFolder(duplicate);
    await store.writeFolderProfile(registered, { guidelines: 'Profil bleibt erhalten', contextBrains: ['brain-1'] });
    await store.updateSessionMeta(session.id, { folder: registered });
    assert.equal(await store.renameFolder(registered, renamed), renamed);

    const registry = JSON.parse(await fs.readFile(path.join(PATHS.root, 'data', 'folders.json'), 'utf8'));
    assert.ok(registry.includes(renamed), 'Der neue Name muss in der Registry stehen');
    assert.ok(!registry.includes(registered), 'Der alte Name darf nicht in der Registry stehen bleiben');
    const profiles = JSON.parse(await fs.readFile(path.join(PATHS.root, 'data', 'folder-profiles.json'), 'utf8'));
    assert.equal(profiles[renamed]?.guidelines, 'Profil bleibt erhalten');
    assert.equal(Object.prototype.hasOwnProperty.call(profiles, registered), false, 'Der Profil-Key muss umgezogen werden');
    assert.equal((await store.readSession(session.id)).folder, renamed, 'Die Session muss dem neuen Namen zugeordnet sein');
    await assert.rejects(
      store.renameFolder(renamed, duplicate.toLowerCase()),
      (err) => err.code === 'FOLDER_EXISTS'
    );

    await store.writeFolderProfile(profileOnly, { guidelines: 'Testprofil' });
    folders = await store.listFolders();
    assert.ok(folders.includes(profileOnly), 'Projekte mit Profil muessen gelistet werden');
    await store.deleteFolder(profileOnly);
    assert.equal(await store.readFolderProfile(profileOnly), null);

    await store.updateSessionMeta(session.id, { folder: null });
    await store.deleteFolder(renamed);
    assert.ok(!(await store.listFolders()).includes(renamed));

    await store.updateSessionMeta(session.id, { folder: automatic });
    assert.ok((await store.listFolders()).includes(automatic), 'PATCH muss das Projekt registrieren');
    await assert.rejects(
      store.deleteFolder(automatic),
      (err) => err.code === 'FOLDER_NOT_EMPTY' && err.sessionCount === 1
    );

    await store.updateSessionMeta(session.id, { folder: null });
    await store.deleteFolder(automatic);
    assert.ok(!(await store.listFolders()).includes(automatic));

    await store.deleteFolder(duplicate);
    console.log('Projekt-Registry: Erstellen, Umbenennen, Profil-/Session-Migration, Konflikte und Loeschen sind korrekt.');
  } finally {
    try {
      await store.updateSessionMeta(session.id, { folder: null });
    } catch (_) {
      /* Session kann nach einem fruehen Fehler bereits fehlen. */
    }
    await store.deleteSession(session.id);
    for (const folder of cleanup) {
      try {
        await store.deleteFolder(folder);
      } catch (_) {
        /* Bestmoegliches Aufraeumen ohne bestehende Daten anzutasten. */
      }
    }
  }
  console.log('test-folders.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
