'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const store = require('../lib/store');
const cast = require('../lib/cast');
const { castSection } = require('../lib/brain');
const { executeTool, toolDefinitions } = require('../lib/tools');
const { app } = require('../server');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xkAAAAASUVORK5CYII=',
  'base64'
);

async function main() {
  store.ensureDirs();
  const originalFolder = `Cast-Test-${Date.now()}`;
  const renamedFolder = `${originalFolder}-Neu`;
  const session = await store.createSession({ folder: originalFolder });
  const createdIds = [];
  const events = [];
  const ctx = { sessionId: session.id, config: {}, emit: (event) => events.push(event), user: 'test' };
  try {
    const names = toolDefinitions().map((entry) => entry.function.name);
    for (const name of ['create_cast_member', 'update_cast_member', 'import_cast_asset']) {
      assert.ok(names.includes(name), `${name} muss verfuegbar sein`);
    }

    const image = await store.saveAsset(session.id, {
      kind: 'image', buffer: PNG_1X1, ext: '.png', prompt: 'Portrait', cost: null
    });
    const video = await store.saveAsset(session.id, {
      kind: 'video', buffer: Buffer.from('voice-video'), ext: '.mp4', prompt: 'Voice-Master', cost: null
    });
    const audio = await store.saveAsset(session.id, {
      kind: 'audio', buffer: Buffer.from('voice-audio'), ext: '.mp3', prompt: 'Neue Stimme', cost: null
    });

    const created = await executeTool(ctx, 'create_cast_member', {
      name: 'Mara',
      soul: 'Ruhig, warm und praezise.',
      image_asset_ids: [image.id],
      voice_asset_id: video.id
    });
    const memberId = /ID (cast-[a-f0-9]+)/.exec(created.toolResult)?.[1];
    assert.ok(memberId);
    createdIds.push(memberId);
    let member = await cast.readMember(memberId);
    assert.equal(member.images.length, 1);
    assert.match(member.voice, /\.mp4$/);

    const importedImage = await executeTool(ctx, 'import_cast_asset', { member: 'Mara', asset: 'image:1' });
    assert.match(importedImage.toolResult, /reference_asset_ids/);
    assert.equal(importedImage.asset.kind, 'image');
    assert.equal(importedImage.inject.length, 1);
    const importedVoice = await executeTool(ctx, 'import_cast_asset', { member: memberId, asset: 'voice' });
    assert.match(importedVoice.toolResult, /reference_video_asset_ids/);
    assert.equal(importedVoice.asset.kind, 'video');

    const oldVoice = member.voice;
    await executeTool(ctx, 'update_cast_member', {
      name: 'Mara', new_name: 'Mara Neu', soul: 'Direkt, freundlich und ruhig.', voice_asset_id: audio.id
    });
    member = await cast.readMember(memberId);
    assert.equal(member.name, 'Mara Neu');
    assert.match(member.voice, /\.mp3$/);
    await assert.rejects(fsp.access(path.join(cast.memberAssetsDir(memberId), oldVoice)), /ENOENT/);
    const importedAudio = await executeTool(ctx, 'import_cast_asset', { member: memberId, asset: 'voice' });
    assert.match(importedAudio.toolResult, /reference_audio_asset_ids/);
    assert.equal(importedAudio.asset.kind, 'audio');
    const promptSection = await castSection(originalFolder);
    assert.match(promptSection, /# CAST \(Projekt\)/);
    assert.match(promptSection, /IMMER zuerst `import_cast_asset`/);
    assert.match(promptSection, /Voice-Master ein Video-Clip/);

    for (let index = 0; index < 5; index += 1) {
      await cast.addMemberAsset(memberId, {
        kind: 'image',
        sourcePath: path.join(store.sessionAssetDir(session.id), image.file),
        filename: `portrait-${index}.png`
      });
    }
    await assert.rejects(
      cast.addMemberAsset(memberId, {
        kind: 'image',
        sourcePath: path.join(store.sessionAssetDir(session.id), image.file),
        filename: 'portrait-zu-viel.png'
      }),
      /maximal 6 Bilder/
    );

    for (let index = 1; index < cast.MAX_MEMBERS; index += 1) {
      const extra = await cast.createMember(originalFolder, { name: `Extra ${index}`, soul: '' });
      createdIds.push(extra.id);
    }
    await assert.rejects(
      cast.createMember(originalFolder, { name: 'Zu viel', soul: '' }),
      /maximal 12 Cast-Mitglieder/
    );

    await store.renameFolder(originalFolder, renamedFolder);
    const afterRename = await cast.listMembers(renamedFolder);
    assert.equal(afterRename.length, cast.MAX_MEMBERS);
    assert.ok(afterRename.some((entry) => entry.id === memberId));

    const getRoute = app._router.stack.find((layer) => layer.route?.path === '/api/folders/:name/cast' && layer.route.methods.get);
    assert.ok(getRoute, 'GET /api/folders/:name/cast muss registriert sein');
    const getResponse = { json: (value) => { getResponse.body = value; }, status: () => getResponse };
    await getRoute.route.stack[0].handle({ params: { name: renamedFolder } }, getResponse);
    assert.equal(getResponse.body.members.length, cast.MAX_MEMBERS);
    const apiRemovedId = createdIds.at(-1);
    const deleteRoute = app._router.stack.find((layer) => layer.route?.path === '/api/cast/:id' && layer.route.methods.delete);
    assert.ok(deleteRoute, 'DELETE /api/cast/:id muss registriert sein');
    const deleteResponse = { json: (value) => { deleteResponse.body = value; }, status: () => deleteResponse };
    await deleteRoute.route.stack[0].handle({ params: { id: apiRemovedId } }, deleteResponse);
    assert.equal(deleteResponse.body.ok, true);
    createdIds.pop();

    assert.equal(await cast.removeMember(memberId), true);
    assert.ok(!(await store.readFolderProfile(renamedFolder)).cast.includes(memberId));
    await assert.rejects(fsp.access(path.join(cast.CAST_DIR, memberId)), /ENOENT/);
    createdIds.splice(createdIds.indexOf(memberId), 1);
    assert.ok(events.some((event) => event.type === 'asset'));
    console.log('Casting: Create, Update, Import, Limits, projektweites Rename und Remove sind korrekt.');
  } finally {
    for (const id of createdIds) await cast.removeMember(id).catch(() => {});
    await store.deleteSession(session.id).catch(() => {});
    await store.deleteFolder(renamedFolder).catch(() => {});
    await store.deleteFolder(originalFolder).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
