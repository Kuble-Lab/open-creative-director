'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const costs = require('../lib/costs');
const ffmpeg = require('../lib/ffmpeg');
const {
  toolDefinitions,
  executeTool,
  validateConcatArgs,
  concatStrategy
} = require('../lib/tools');

function probe(overrides = {}) {
  return {
    video: { codec: 'h264', width: 1920, height: 1080, fps: 25, ...(overrides.video || {}) },
    audio: overrides.audio === undefined
      ? { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' }
      : overrides.audio,
    duration: overrides.duration || 2
  };
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-concat-test-'));
  const ffmpegStub = path.join(directory, 'ffmpeg');
  const ffprobeStub = path.join(directory, 'ffprobe');
  await fsp.writeFile(ffmpegStub, '#!/bin/sh\nexit 0\n', 'utf8');
  await fsp.writeFile(ffprobeStub, '#!/bin/sh\nexit 0\n', 'utf8');
  await fsp.chmod(ffmpegStub, 0o755);
  await fsp.chmod(ffprobeStub, 0o755);

  const originalEnv = {
    FFMPEG_PATH: process.env.FFMPEG_PATH,
    FFPROBE_PATH: process.env.FFPROBE_PATH
  };
  const originals = {
    probeVideo: ffmpeg.probeVideo,
    concatVideos: ffmpeg.concatVideos,
    recordCost: costs.recordCost
  };
  let session;
  try {
    process.env.FFMPEG_PATH = path.join(directory, 'fehlt-ffmpeg');
    process.env.FFPROBE_PATH = path.join(directory, 'fehlt-ffprobe');
    assert.equal(
      toolDefinitions().some((definition) => definition.function.name === 'concat_videos'),
      false,
      'concat_videos muss ohne ffmpeg/ffprobe ausgeblendet sein'
    );

    process.env.FFMPEG_PATH = ffmpegStub;
    process.env.FFPROBE_PATH = ffprobeStub;
    assert.equal(
      toolDefinitions().some((definition) => definition.function.name === 'concat_videos'),
      true,
      'concat_videos muss mit gueltigen Binary-Overrides registriert sein'
    );

    assert.throws(() => validateConcatArgs({}), /asset_ids muss ein Array sein/);
    assert.throws(() => validateConcatArgs({ asset_ids: ['vid-001'] }), /2 bis 20/);
    assert.throws(() => validateConcatArgs({ asset_ids: Array(21).fill('vid-001') }), /2 bis 20/);
    assert.throws(() => validateConcatArgs({ asset_ids: ['vid-001', ''] }), /nicht-leere/);
    assert.deepEqual(validateConcatArgs({ asset_ids: [' vid-001 ', 'vid-002'] }), ['vid-001', 'vid-002']);

    const compatible = [probe(), probe()];
    assert.equal(concatStrategy(compatible), 'copy');
    assert.equal(concatStrategy([probe(), probe({ video: { width: 1080 } })]), 'reencode');
    assert.equal(concatStrategy([probe(), probe({ video: { fps: 30 } })]), 'reencode');
    assert.equal(concatStrategy([probe(), probe({ audio: null })]), 'reencode');
    assert.equal(concatStrategy([probe(), probe({ audio: { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' } })]), 'reencode');

    store.ensureDirs();
    session = await store.createSession();
    const first = await store.saveAsset(session.id, {
      kind: 'video', buffer: Buffer.from('clip-a'), ext: '.mp4', prompt: 'Kapitel A', cost: 0
    });
    const second = await store.saveAsset(session.id, {
      kind: 'video', buffer: Buffer.from('clip-b'), ext: '.mp4', prompt: 'Kapitel B', cost: 0
    });
    let concatCall;
    let recordedCost;
    ffmpeg.probeVideo = async (file) => probe({ duration: path.basename(file) === 'output.mp4' ? 4 : 2 });
    ffmpeg.concatVideos = async (options) => {
      concatCall = options;
      await fsp.writeFile(options.outputFile, Buffer.from('joined-video'));
    };
    costs.recordCost = async (entry) => { recordedCost = entry; return entry; };

    const outcome = await executeTool(
      { sessionId: session.id, emit() {}, user: 'concat-test@example.com' },
      'concat_videos',
      { asset_ids: [first.id, second.id], label: 'Episode komplett' }
    );
    assert.equal(concatCall.strategy, 'copy');
    assert.equal(outcome.asset.kind, 'video');
    assert.equal(outcome.asset.cost, 0);
    const ledger = await store.readLedger(session.id);
    const joined = ledger.find((entry) => entry.id === outcome.asset.id);
    assert.equal(joined.pending, undefined);
    assert.equal(joined.duration, 4);
    assert.equal(joined.cost, 0);
    assert.equal(await fsp.readFile(path.join(store.sessionAssetDir(session.id), joined.file), 'utf8'), 'joined-video');
    assert.equal(recordedCost.model, 'ffmpeg');
    assert.equal(recordedCost.cost, 0);

    console.log('concat_videos: Gating, Argumente, Copy/Re-Encode-Entscheid und Session-Asset sind korrekt.');
  } finally {
    ffmpeg.probeVideo = originals.probeVideo;
    ffmpeg.concatVideos = originals.concatVideos;
    costs.recordCost = originals.recordCost;
    if (originalEnv.FFMPEG_PATH === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalEnv.FFMPEG_PATH;
    if (originalEnv.FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = originalEnv.FFPROBE_PATH;
    if (session) await store.deleteSession(session.id);
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('test-concat-videos.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
