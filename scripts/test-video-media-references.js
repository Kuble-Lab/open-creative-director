'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const publicrefs = require('../lib/publicrefs');
const { buildVideoPayload, toolDefinitions } = require('../lib/tools');

const CAPABILITIES = {
  resolutions: ['480p', '720p'],
  aspectRatios: ['16:9', '9:16'],
  durations: { min: 4, max: 30 }
};

async function main() {
  store.ensureDirs();
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://example.test/supercomputer';
  const session = await store.createSession();
  let files = [];
  try {
    const image = await store.saveAsset(session.id, {
      kind: 'image', buffer: Buffer.from('png'), ext: '.png', prompt: 'Bild', cost: null
    });
    const video = await store.saveAsset(session.id, {
      kind: 'video', buffer: Buffer.from('mp4'), ext: '.mp4', prompt: 'Video', cost: null
    });
    const audio = await store.saveAsset(session.id, {
      kind: 'audio', buffer: Buffer.from('mp3'), ext: '.mp3', prompt: 'Audio', cost: null
    });
    const ctx = { sessionId: session.id, config: { videoModel: 'test/video' } };
    const built = await buildVideoPayload(ctx, {
      prompt: 'A person speaks to camera.',
      mode: 'text_to_video',
      reference_asset_ids: [image.id],
      reference_video_asset_ids: [video.id],
      reference_audio_asset_ids: [audio.id],
      duration_seconds: 8,
      aspect_ratio: '16:9',
      resolution: '720p'
    }, { capabilities: CAPABILITIES });
    files = built.publishedRefs;
    assert.equal(built.payload.input_references.length, 3);
    assert.match(built.payload.input_references[0].image_url.url, /^data:image\/png;base64,/);
    assert.match(built.payload.input_references[1].video_url.url, /^https:\/\/example\.test\/supercomputer\/refs\/[a-f0-9]{32}\.mp4$/);
    assert.match(built.payload.input_references[2].audio_url.url, /^https:\/\/example\.test\/supercomputer\/refs\/[a-f0-9]{32}\.mp3$/);

    for (const file of files) await publicrefs.removeRef(file);
    files = [];
    delete process.env.PUBLIC_BASE_URL;
    const imageOnly = await buildVideoPayload(ctx, {
      prompt: 'Image-only reference.', mode: 'text_to_video', reference_asset_ids: [image.id]
    }, { capabilities: CAPABILITIES });
    assert.equal(imageOnly.payload.input_references[0].type, 'image_url');
    await assert.rejects(
      buildVideoPayload(ctx, {
        prompt: 'Needs voice.', mode: 'text_to_video', reference_audio_asset_ids: [audio.id]
      }, { capabilities: CAPABILITIES }),
      /Audio-\/Video-Referenzen brauchen PUBLIC_BASE_URL \(Produktion\)\. Bilder-Referenzen funktionieren weiterhin\./
    );

    process.env.PUBLIC_BASE_URL = 'https://example.test/supercomputer';
    await assert.rejects(
      buildVideoPayload(ctx, {
        prompt: 'Wrong reference type.', mode: 'text_to_video', reference_video_asset_ids: [image.id]
      }, { capabilities: CAPABILITIES }),
      /Bilder gehoeren in reference_asset_ids/
    );
    const definition = toolDefinitions().find((entry) => entry.function.name === 'generate_video').function;
    assert.equal(definition.parameters.properties.reference_video_asset_ids.maxItems, 10);
    assert.equal(definition.parameters.properties.reference_audio_asset_ids.maxItems, 10);
    console.log('Video-Payload: Bild-data-URL, Video-HTTPS-URL, Audio-HTTPS-URL und Validierung sind korrekt.');
  } finally {
    for (const file of files) await publicrefs.removeRef(file).catch(() => {});
    await store.deleteSession(session.id);
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
