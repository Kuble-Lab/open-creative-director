'use strict';

const assert = require('node:assert/strict');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const discovery = require('../lib/discovery');
const { executeTool, toolDefinitions } = require('../lib/tools');
const { runTurn } = require('../lib/brain');

async function main() {
  store.ensureDirs();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const folder = `Memory-${suffix}`;
  const renamed = `Memory-neu-${suffix}`;
  const missingFolder = `Memory-fehlt-${suffix}`;
  const cleanupFolders = new Set([folder, renamed]);
  let projectSession;
  let looseSession;

  const originals = {
    chatStream: or.chatStream,
    brainSupportsImages: discovery.brainSupportsImages,
    videoCapabilities: discovery.videoCapabilities
  };

  try {
    await store.createFolder(folder);
    projectSession = await store.createSession({ folder });
    looseSession = await store.createSession();

    await assert.rejects(store.addFolderMemory(missingFolder, 'Test'), (err) => err.code === 'FOLDER_NOT_FOUND');
    await assert.rejects(store.addFolderMemory(folder, '   '), /darf nicht leer sein/);
    await assert.rejects(store.addFolderMemory(folder, 'x'.repeat(501)), /maximal 500 Zeichen/);

    const maxLengthEntry = await store.addFolderMemory(folder, 'x'.repeat(500));
    assert.match(maxLengthEntry.id, /^mem-[0-9a-f]{8}$/);
    assert.equal([...maxLengthEntry.note].length, 500);
    assert.match(maxLengthEntry.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await store.removeFolderMemory(folder, 'mem-ffffffff'), false);
    assert.equal(await store.removeFolderMemory(folder, maxLengthEntry.id), true);
    assert.deepEqual((await store.readFolderProfile(folder))?.memory || [], []);

    await assert.rejects(
      executeTool({ sessionId: looseSession.id, emit() {} }, 'save_project_memory', { note: 'Nur im Projekt' }),
      /Dieser Chat gehoert zu keinem Projekt.*save_memory verwenden/
    );

    const durableNote = 'Standardepisoden dauern 2 Minuten.';
    const toolResult = await executeTool(
      { sessionId: projectSession.id, emit() {} },
      'save_project_memory',
      { note: `  ${durableNote}  ` }
    );
    assert.match(toolResult.toolResult, new RegExp(folder));
    assert.match(toolResult.toolResult, /Standardepisoden dauern 2 Minuten\./);
    assert.match(toolResult.toolResult, /1 Eintraege/);

    const definitions = toolDefinitions({});
    const projectMemoryTool = definitions.find((definition) => definition.function?.name === 'save_project_memory');
    const globalMemoryTool = definitions.find((definition) => definition.function?.name === 'save_memory');
    assert.equal(projectMemoryTool?.function.parameters.properties.note.maxLength, 500);
    assert.match(globalMemoryTool?.function.description || '', /PROJECT-specific rules use save_project_memory/);

    await store.addFolderMemory(folder, 'Zweite Projektregel.');
    await store.writeFolderProfile(folder, { guidelines: 'Manuell gepflegte Richtlinie.' });
    let profile = await store.readFolderProfile(folder);
    assert.equal(profile.memory.length, 2, 'Manuelle Profil-Writes duerfen Projekt-Memory nicht ueberschreiben');
    assert.equal(profile.memory[0].note, durableNote);

    let request;
    or.chatStream = async (payload) => {
      request = payload;
      return new Response('data: {"choices":[{"delta":{"content":"Erledigt."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };
    discovery.brainSupportsImages = async () => true;
    discovery.videoCapabilities = async () => ({
      resolutions: ['720p'],
      aspectRatios: ['16:9'],
      durations: { min: 4, max: 30 },
      frameImages: ['first_frame']
    });

    await runTurn({
      sessionId: projectSession.id,
      text: 'Projekt-Memory pruefen',
      brainModel: 'brain-test',
      attachments: [],
      config: { imageModel: 'image-test', videoModel: 'video-test' },
      emit() {}
    });
    const prompt = request.messages[0].content;
    assert.match(prompt, /## PROJEKT-MEMORY \(verbindlich fuer dieses Projekt\)/);
    assert.match(prompt, /Regeln wurden vom Director selbst gespeichert und gelten verbindlich/);
    assert.match(prompt, /- Standardepisoden dauern 2 Minuten\./);
    assert.match(prompt, /- Zweite Projektregel\./);
    assert.ok(
      prompt.indexOf(`- ${durableNote}`) < prompt.indexOf('- Zweite Projektregel.'),
      'Projekt-Memory muss im System-Prompt aelteste Eintraege zuerst enthalten'
    );

    for (let index = 3; index <= 50; index += 1) {
      await store.addFolderMemory(folder, `Projektregel ${index}`);
    }
    profile = await store.readFolderProfile(folder);
    assert.equal(profile.memory.length, 50);
    assert.equal(profile.memory[0].note, durableNote, 'Projekt-Memory muss in Erstellreihenfolge gelesen werden');
    assert.equal(profile.memory[49].note, 'Projektregel 50');
    await assert.rejects(
      store.addFolderMemory(folder, 'Ein Eintrag zu viel'),
      /Projekt-Memory ist voll \(50 Eintraege\)/
    );

    const idsBeforeRename = profile.memory.map((entry) => entry.id);
    assert.equal(await store.renameFolder(folder, renamed), renamed);
    profile = await store.readFolderProfile(renamed);
    assert.deepEqual(profile.memory.map((entry) => entry.id), idsBeforeRename);
    assert.equal((await store.readSession(projectSession.id)).folder, renamed);
    assert.equal(await store.readFolderProfile(folder), null);

    await store.deleteSession(projectSession.id);
    projectSession = null;
    await store.deleteFolder(renamed);
    assert.equal(await store.readFolderProfile(renamed), null, 'Projektloeschen muss das Memory-Profil mitloeschen');

    console.log('Projekt-Memory: Store, Limits, Tools, Prompt-Injektion, Rename und Loeschen sind korrekt.');
  } finally {
    or.chatStream = originals.chatStream;
    discovery.brainSupportsImages = originals.brainSupportsImages;
    discovery.videoCapabilities = originals.videoCapabilities;
    for (const session of [projectSession, looseSession]) {
      if (!session) continue;
      try {
        await store.updateSessionMeta(session.id, { folder: null });
      } catch (_) {
        /* Session kann nach einem fruehen Fehler bereits fehlen. */
      }
      await store.deleteSession(session.id).catch(() => {});
    }
    for (const name of cleanupFolders) {
      await store.deleteFolder(name).catch(() => {});
    }
  }
  console.log('test-project-memory.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
