'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const discovery = require('../lib/discovery');
const { runTurn } = require('../lib/brain');

const HYPERFRAMES_HINT =
  '[System] Der User hat den HyperFrames-Modus aktiviert: Setze diese Anfrage mit dem Tool render_motion_graphics um (HTML/GSAP Motion Graphics auf dem Render-Node), nicht mit generate_video.';

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const originalChatStream = or.chatStream;
  const originalBrainSupportsImages = discovery.brainSupportsImages;
  const originalVideoCapabilities = discovery.videoCapabilities;
  let request;

  or.chatStream = async (payload) => {
    request = payload;
    const stream = [
      'data: {"choices":[{"delta":{"content":"Erledigt."},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
      text: 'Animierte Titelkarte erstellen',
      brainModel: 'brain-test',
      attachments: [],
      config: { imageModel: 'image-test', videoModel: 'video-test' },
      emit() {},
      renderMode: true,
      user: 'test'
    });

    const saved = await store.readSession(session.id);
    const hint = saved.messages.find((message) => message.hidden && message.content === HYPERFRAMES_HINT);
    assert.ok(hint, 'Der HyperFrames-Hinweis fehlt in der Session.');
    assert.equal(hint.role, 'user');
    assert.ok(
      request.messages.some((message) => message.role === 'user' && message.content === HYPERFRAMES_HINT),
      'Der versteckte HyperFrames-Hinweis fehlt im OpenRouter-Request.'
    );
    assert.equal(saved.messages.filter((message) => !message.hidden && message.role === 'user').length, 1);

    console.log('Render-Modus: Versteckter HyperFrames-Hinweis wird persistiert und nur API-seitig mitgesendet.');
  } finally {
    or.chatStream = originalChatStream;
    discovery.brainSupportsImages = originalBrainSupportsImages;
    discovery.videoCapabilities = originalVideoCapabilities;
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
