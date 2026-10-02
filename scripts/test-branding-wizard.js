'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const discovery = require('../lib/discovery');
const { runTurn } = require('../lib/brain');

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const originals = {
    chatStream: or.chatStream,
    brainSupportsImages: discovery.brainSupportsImages,
    videoCapabilities: discovery.videoCapabilities
  };
  let request;
  or.chatStream = async (payload) => {
    request = payload;
    return new Response(
      'data: {"choices":[{"delta":{"content":"Wie heisst die Marke?"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
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
      text: 'Branding erstellen',
      brainModel: 'brain-test',
      attachments: [],
      config: { imageModel: 'image-test', videoModel: 'video-test' },
      emit() {},
      brandingWizard: true
    });
    const saved = await store.readSession(session.id);
    const wizard = saved.messages.find(
      (message) => message.hidden && typeof message.content === 'string' && message.content.includes('Branding-Wizard')
    );
    assert.ok(wizard);
    assert.match(wizard.content, /Warte nach JEDEM Schritt IMMER auf die Antwort/);
    assert.match(wizard.content, /1\. Frage nach Marke, Werten und Zielgruppe/);
    assert.match(wizard.content, /11\. Gib eine kompakte Zusammenfassung/);
    assert.ok(request.messages.some((message) => message.content === wizard.content));
    console.log('Branding-Wizard: Versteckte Schrittfolge wird persistiert und an das Brain uebergeben.');
  } finally {
    or.chatStream = originals.chatStream;
    discovery.brainSupportsImages = originals.brainSupportsImages;
    discovery.videoCapabilities = originals.videoCapabilities;
    await store.deleteSession(session.id);
  }
  console.log('test-branding-wizard.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
