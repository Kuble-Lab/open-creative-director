'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const gts = require('../lib/gts');
const discovery = require('../lib/discovery');
const { runTurn } = require('../lib/brain');

async function main() {
  store.ensureDirs();
  const folder = `Brain-Profil-${Date.now()}`;
  const session = await store.createSession({ folder });
  await store.mutateSession(session.id, (saved) => {
    saved.contextBrains = [{ id: 'session-brain', title: 'Session Brain' }];
  });
  await store.writeFolderProfile(folder, {
    guidelines: 'Logo immer oben rechts und Grundfarbe Petrol.',
    contextBrains: ['profile-brain', 'session-brain']
  });

  const originals = {
    chatStream: or.chatStream,
    getBrain: gts.getBrain,
    listAssets: gts.listAssets,
    brainSupportsImages: discovery.brainSupportsImages,
    videoCapabilities: discovery.videoCapabilities
  };
  let request;
  or.chatStream = async (payload) => {
    request = payload;
    return new Response('data: {"choices":[{"delta":{"content":"Erledigt."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };
  gts.getBrain = async (id) => ({ id, title: `Titel ${id}`, body: `Inhalt ${id}` });
  gts.listAssets = async (id) => [{ filename: `${id}.png`, mimeType: 'image/png', size: 42 }];
  discovery.brainSupportsImages = async () => true;
  discovery.videoCapabilities = async () => ({
    resolutions: ['720p'],
    aspectRatios: ['16:9'],
    durations: { min: 4, max: 30 },
    frameImages: ['first_frame']
  });

  try {
    await runTurn({
      sessionId: session.id,
      text: 'Profil pruefen',
      brainModel: 'brain-test',
      attachments: [],
      config: { imageModel: 'image-test', videoModel: 'video-test' },
      emit() {}
    });
    const prompt = request.messages[0].content;
    assert.match(prompt, new RegExp(`# Production profile \\(folder: ${folder}\\)`));
    assert.match(prompt, /Logo immer oben rechts und Grundfarbe Petrol\./);
    assert.equal((prompt.match(/## Titel session-brain/g) || []).length, 1);
    assert.equal((prompt.match(/## Titel profile-brain/g) || []).length, 1);
    assert.ok(prompt.indexOf('# Production profile') < prompt.indexOf('# ATTACHED KNOWLEDGE CONTEXT'));
    assert.match(prompt, /profile-brain\.png/);
    console.log('Brain-Profil: Richtlinien, deduplizierte GTS-Brains und Asset-Inventar landen im System-Prompt.');
  } finally {
    or.chatStream = originals.chatStream;
    gts.getBrain = originals.getBrain;
    gts.listAssets = originals.listAssets;
    discovery.brainSupportsImages = originals.brainSupportsImages;
    discovery.videoCapabilities = originals.videoCapabilities;
    await store.deleteSession(session.id);
    await store.deleteFolder(folder);
  }
  console.log('test-folder-profile-brain.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
