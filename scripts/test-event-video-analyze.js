'use strict';

// Synthetic media, fake providers, real local decoding and real engine item-cache behaviour. No sockets.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ffmpeg = require('../lib/ffmpeg');
const frames = require('../lib/event-video/frames');
const exif = require('../lib/event-video/exif');
const speech = require('../lib/event-video/speech');
const vision = require('../lib/event-video/vision');
const { analyzeMedia, decodeArgs } = require('../lib/event-video/analyze');
const { checkInfo } = require('../lib/event-video/contract');
const assets = require('../lib/nodes/assets');
const routes = require('../lib/nodes/routes');
const mediaNodes = require('../lib/nodes/nodes-event-video-media');
const visionFixture = require('./support/event-video/info-photo.json').vision;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const valid = (info) => check(checkInfo(info).ok, checkInfo(info).problems.join('; '));
const run = (args) => ffmpeg.runProcess(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);

function jpegExif(orientation, little = true) {
  const t = Buffer.alloc(100);
  const u16 = (at, n) => little ? t.writeUInt16LE(n, at) : t.writeUInt16BE(n, at);
  const u32 = (at, n) => little ? t.writeUInt32LE(n, at) : t.writeUInt32BE(n, at);
  t.write(little ? 'II' : 'MM'); u16(2, 42); u32(4, 8); u16(8, 2);
  const entry = (at, tag, type, count, value) => { u16(at, tag); u16(at + 2, type); u32(at + 4, count); type === 3 ? u16(at + 8, value) : u32(at + 8, value); };
  entry(10, 0x112, 3, 1, orientation); entry(22, 0x8769, 4, 1, 38);
  u16(38, 2); entry(40, 0x9003, 2, 20, 68); entry(52, 0x9011, 2, 7, 88);
  t.write('2026:03:12 18:04:00\0', 68); t.write('+02:00\0', 88);
  const size = Buffer.alloc(2); size.writeUInt16BE(t.length + 8);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), size, Buffer.from('Exif\0\0'), t, Buffer.from([0xff, 0xd9])]);
}

async function testEngine(scratch, photo, broken) {
  const { createRegistry } = require('../lib/nodes/registry');
  const { createEventBus } = require('../lib/nodes/events');
  const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
  const { createEngine } = require('../lib/nodes/engine');
  const { listValue } = require('../lib/nodes/types');
  const llm = require('../lib/nodes/llm');
  const registry = createRegistry(), bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(scratch, 'workflows'), registry, events: bus });
  let items = [], calls = 0, fail = true;
  const original = llm.completeText;
  llm.completeText = async () => {
    calls += 1;
    if (fail && calls === 2) throw new Error('Synthetic API outage');
    return { text: JSON.stringify(visionFixture), usd: 0.006 };
  };
  registry.register({ type: 'test.photos', category: 'input', outputs: [{ id: 'items', type: 'image[]' }],
    execute: async () => ({ variants: [{ items: listValue('image', items) }] }) });
  mediaNodes.registerAll(registry);
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { parallel: 1 } });
  const node = (id, type) => ({ id, type, typeVersion: 1, x: 0, y: 0, params: {} });
  const wf = (await wfStore.createWorkflow({ name: 'Event analysis cache test', graph: {
    nodes: [node('input', 'test.photos'), node('analyze', 'event_video.analyze')],
    edges: [{ id: 'e1', from: { node: 'input', port: 'items' }, to: { node: 'analyze', port: 'media' } }]
  } })).workflow;
  try {
    const uploads = await assets.createScratchDir(wf.sessionId);
    try {
      for (const [i, file] of [photo, broken, photo].entries()) {
        const sourceFile = path.join(uploads, `upload-${i}.jpg`);
        await fs.copyFile(file, sourceFile);
        items.push(await assets.saveUploadFile(wf.sessionId, { sourceFile, ext: '.jpg' }));
      }
    } finally { await assets.removeScratchDir(uploads); }
    const execute = async () => { const id = await engine.start(wf.id, { mode: 'all' }); return engine.whenFinished(wf.id, id); };
    const first = await execute();
    check(first.status === 'failed', JSON.stringify(first));
    const partial = (await wfStore.readResults(wf.id)).nodes.analyze.partial;
    check(JSON.stringify(partial).includes('decode_failed'), 'Broken item was kept in partial cache');
    check(JSON.stringify(partial).includes(visionFixture.subject), 'Finished usable item was kept in partial cache');
    check(JSON.stringify(first).includes('EVENTMEDIA_VISION_FAILED'), 'API error code survives the implicit map');
    fail = false;
    const second = await execute();
    check(second.status === 'completed', JSON.stringify(second));
    check(calls === 3, 'Only the failed item calls vision again');
    const history = (await wfStore.readResults(wf.id)).nodes.analyze.history[0];
    check(history.itemKeys.length === 3 && history.variants[0].sheet.items.length === 3, 'Mixed lists preserve cache and sheet alignment');
    const third = await execute();
    check(third.status === 'completed' && calls === 3, 'A cached deterministic failure makes no API call');
  } finally { llm.completeText = original; await wfStore.deleteWorkflow(wf.id); }
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'event-analysis-test-'));
  let asks = 0, saves = 0;
  const saved = [];
  const ctx = { assetId: 'synthetic', sessionId: 'test', toolCtx: {}, log: () => {},
    withLocalSlot: async (task) => task(), eventVideo: { scratchRoot: scratch,
      completeText: async (request) => {
        asks += 1; check(request.images[0].startsWith('data:image/png;base64,'), 'Vision receives an image');
        return { text: JSON.stringify(visionFixture), usd: 0.006 };
      }, removeAssets: async () => {} },
    saveOutputFile: async (options) => {
      const file = path.join(scratch, `saved-${++saves}${options.ext}`);
      await fs.copyFile(options.sourceFile, file); saved.push({ ...options, file });
      return { type: options.kind, sessionId: 'test', assetId: `saved-${saves}`, file: path.basename(file) };
    } };
  try {
    for (const little of [true, false]) {
      const parsed = exif.parseExif(jpegExif(6, little));
      check(parsed.orientation === 6 && parsed.rotation === 90 && parsed.taken_at === '2026-03-12T18:04:00+02:00', 'EXIF byte order, sub-IFD, date and offset');
    }
    check(exif.parseExif(Buffer.from([0xff, 0xd8, 0xff])).orientation === 1, 'Truncated EXIF does not throw');
    for (let orientation = 1; orientation <= 8; orientation += 1) check(exif.parseExif(jpegExif(orientation)).orientation === orientation, 'All EXIF orientations');
    const photo = path.join(scratch, 'photo.jpg'), blur = path.join(scratch, 'blur.jpg'), dark = path.join(scratch, 'dark.jpg');
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', photo]);
    await run(['-i', photo, '-vf', 'gblur=sigma=12', '-frames:v', '1', blur]);
    await run(['-f', 'lavfi', '-i', 'color=black:size=640x360', '-frames:v', '1', dark]);
    const good = await analyzeMedia(ctx, photo, { kind: 'photo' }); valid(good);
    const blurry = await analyzeMedia(ctx, blur, { kind: 'photo' }); valid(blurry);
    const dim = await analyzeMedia(ctx, dark, { kind: 'photo' }); valid(dim);
    check(good.scenes[0].sharp > blurry.scenes[0].sharp && good.scenes[0].quality > blurry.scenes[0].quality, 'Laplace separates sharp and blurry pictures');
    check(blurry.scenes[0].reasons.includes('blurry') && dim.scenes[0].reasons.includes('dark'), 'Blur and darkness reasons');
    check(good.meta.seconds === 0 && good.meta.fps === 0 && good.speech === null && good.scenes[0].out === 0, 'Photo-only info');
    const big = path.join(scratch, 'big.jpg');
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=5712x4284', '-frames:v', '1', '-threads', '2', big]);
    const jpeg = await fs.readFile(big), header = jpegExif(6);
    await fs.writeFile(big, Buffer.concat([header.subarray(0, header.length - 2), jpeg.subarray(2)]));
    const bigInfo = await analyzeMedia(ctx, big, { kind: 'photo' }); valid(bigInfo);
    const sheet = saved[saved.length - 1].file;
    const resized = JSON.parse((await ffmpeg.runProcess(ffmpeg.binaries().ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', sheet])).stdout).streams[0];
    check(bigInfo.meta.width === 4284 && bigInfo.meta.height === 5712 && bigInfo.meta.rotation === 90, 'Display dimensions after EXIF rotation');
    check(Math.max(resized.width, resized.height) <= 1600 && resized.height > resized.width, '24 MP photo is reduced before vision');
    const corners = Buffer.alloc(320 * 240);
    for (let y = 0; y < 240; y += 1) for (let x = 0; x < 320; x += 1) corners[y * 320 + x] = [[50, 100], [150, 220]][y < 120 ? 0 : 1][x < 160 ? 0 : 1];
    const pgm = path.join(scratch, 'corners.pgm'), cornersJpg = path.join(scratch, 'corners.jpg');
    await fs.writeFile(pgm, Buffer.concat([Buffer.from('P5\n320 240\n255\n'), corners]));
    await run(['-i', pgm, '-frames:v', '1', cornersJpg]);
    const cornerJpeg = await fs.readFile(cornersJpg);
    // Corner order: top left, top right, bottom left, bottom right (independent of the filter strings).
    const expected = [[50, 100, 150, 220], [100, 50, 220, 150], [220, 150, 100, 50], [150, 220, 50, 100],
      [50, 150, 100, 220], [150, 50, 220, 100], [220, 100, 150, 50], [100, 220, 50, 150]];
    for (let o = 1; o <= 8; o += 1) {
      const head = jpegExif(o), oriented = path.join(scratch, `orientation-${o}.jpg`);
      await fs.writeFile(oriented, Buffer.concat([head.subarray(0, head.length - 2), cornerJpeg.subarray(2)]));
      const orientedInfo = await analyzeMedia(ctx, oriented, { kind: 'photo' }); valid(orientedInfo);
      const raw = path.join(scratch, 'corners.gray'), sheetFile = saved[saved.length - 1].file;
      await run(['-i', sheetFile, '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', raw]);
      const buffer = await fs.readFile(raw), w = orientedInfo.meta.width, h = orientedInfo.meta.height;
      const values = [buffer[10 * w + 10], buffer[10 * w + w - 11], buffer[(h - 11) * w + 10], buffer[(h - 11) * w + w - 11]];
      check(values.every((value, i) => Math.abs(value - expected[o - 1][i]) <= 4), `EXIF ${o} applies rotation and mirror to actual pixels: ${values}`);
    }
    const failed = path.join(scratch, 'broken.jpg'); await fs.writeFile(failed, 'broken');
    const before = asks;
    const bad = await analyzeMedia(ctx, failed, { kind: 'photo' }); valid(bad);
    check(!bad.usable && bad.reason === 'decode_failed' && asks === before, 'Corrupt media is cached without a provider call');
    const heic = await analyzeMedia(ctx, path.join(scratch, 'photo.heic'), { kind: 'photo' }); valid(heic);
    check(heic.reason === 'heic', 'HEIC gives a clear reason');
    check((await analyzeMedia(ctx, 'photo.tiff', { kind: 'photo' })).reason === 'unsupported_format', 'Unsupported format');
    check(assets.typeFromExtension('.MOV') === 'video' && assets.typeFromExtension('.m4v') === 'video', 'MOV and M4V upload types');
    check(routes.uploadExtension('video/quicktime', '').ext === '.mov' && routes.uploadExtension('video/x-m4v', '').ext === '.m4v', 'MOV and M4V MIME types');
    check(routes.uploadExtension('image/heic', 'photo.heic').reason === 'heic', 'HEIC upload rejection');
    const clip = path.join(scratch, 'clip.mov');
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '2', '-c:v', 'libx264', '-threads', '2', clip]);
    const clipInfo = await analyzeMedia(ctx, clip); valid(clipInfo);
    check(clipInfo.meta.fps === 24 && clipInfo.meta.seconds === 2 && !clipInfo.meta.has_audio, 'MOV clip analysis');
    const cut = path.join(scratch, 'cut.mp4');
    await run(['-f', 'lavfi', '-i', 'color=black:size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', 'color=white:size=320x180:rate=24:duration=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-threads', '2', cut]);
    const cutInfo = await analyzeMedia(ctx, cut); valid(cutInfo);
    check(cutInfo.scenes.length === 2 && Math.abs(cutInfo.scenes[1].in - 1) <= 0.2, 'Histogram cut with source times');
    const jitter = path.join(scratch, 'jitter.mp4');
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=352x212:rate=5', '-vf', 'crop=320:180:x=16+14*sin(n*PI/2):y=16',
      '-t', '3', '-c:v', 'libx264', '-threads', '2', jitter]);
    const jitterInfo = await analyzeMedia(ctx, jitter); valid(jitterInfo);
    check(jitterInfo.scenes.some((scene) => scene.reasons.includes('shaky')), 'Encoded jitter clip is marked shaky');
    const steady = path.join(scratch, 'steady.wav'), quiet = path.join(scratch, 'quiet.wav'), varied = path.join(scratch, 'varied.wav');
    await run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3', steady]);
    await run(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', quiet]);
    await run(['-i', steady, '-af', 'volume=0.5+0.45*sin(2*PI*t*3):eval=frame', varied]);
    check(!(await speech.speechGate(ctx, steady, scratch)).candidate, 'Steady sine does not invoke Scribe');
    check(!(await speech.speechGate(ctx, quiet, scratch)).candidate, 'Silence does not invoke Scribe');
    check((await speech.speechGate(ctx, varied, scratch)).candidate, 'Modulated speech candidate passes the gate');
    let transcriptions = 0;
    ctx.eventVideo.executeTool = async (_toolCtx, name, args) => {
      transcriptions += 1; check(name === 'lyrics_timing' && args.method === 'transcribe' && args.voices === 'off', 'Scribe adapter');
      return { timing: { language: 'de', words: [{ text: 'Hello.', start: 0.2, end: 0.8 }] }, costUsd: 0.001 };
    };
    const spoken = await speech.analyzeSpeech(ctx, varied, { seconds: 3, scratch, hasAudio: true });
    check(spoken.speech.words[0].w === 'Hello.' && spoken.speech.language === 'de', 'Scribe word mapping');
    await speech.analyzeSpeech(ctx, steady, { seconds: 3, scratch, hasAudio: true });
    await speech.analyzeSpeech(ctx, varied, { seconds: 3, scratch, hasAudio: true, mode: 'off' });
    check(transcriptions === 1, 'Gate and off mode skip Scribe');
    const speechClip = path.join(scratch, 'speech.mov');
    await run(['-i', clip, '-i', varied, '-c:v', 'copy', '-c:a', 'aac', '-shortest', speechClip]);
    const speechInfo = await analyzeMedia(ctx, speechClip); valid(speechInfo);
    check(speechInfo.speech.words[0].w === 'Hello.' && speechInfo.meta.has_audio, 'Full clip analysis includes fake Scribe words');
    ctx.eventVideo.executeTool = async () => { throw new Error('Synthetic API outage'); };
    await assert.rejects(() => speech.analyzeSpeech(ctx, varied, { seconds: 3, scratch, hasAudio: true }), { code: 'EVENTMEDIA_SPEECH_FAILED' }); checks += 1;
    const fakeAudio = { ...ctx, eventVideo: { ...ctx.eventVideo, probe: async () => ({ streams: [
      { codec_type: 'video', width: 320, height: 180, avg_frame_rate: '24/1' }, { codec_type: 'audio' }], format: { duration: '2' } }) } };
    check((await analyzeMedia(fakeAudio, clip)).reason === 'decode_failed', 'Deterministic audio decode failure is not an API error');
    const failCtx = { ...ctx, eventVideo: { ...ctx.eventVideo, completeText: async () => { throw new Error('Synthetic API outage'); } } };
    await assert.rejects(() => analyzeMedia(failCtx, photo, { kind: 'photo' }), { code: 'EVENTMEDIA_VISION_FAILED' }); checks += 1;
    await assert.rejects(() => vision.analyzeVision({ ...ctx, eventVideo: { completeText: async () => ({ text: '{}' }) } }, sheet, { kind: 'photo', scenes: good.scenes }), { code: 'EVENTMEDIA_VISION_FAILED' }); checks += 1;
    const noVideo = await analyzeMedia({ ...ctx, eventVideo: { ...ctx.eventVideo, probe: async () => ({ streams: [{ codec_type: 'audio' }], format: { duration: '2' } }) } }, clip);
    check(noVideo.reason === 'no_video_stream', 'Audio-only input has no video stream');
    const tooLong = await analyzeMedia({ ...ctx, eventVideo: { ...ctx.eventVideo, probe: async () => ({ streams: [{ codec_type: 'video', width: 320, height: 180, avg_frame_rate: '24/1' }], format: { duration: '1801' } }) } }, clip);
    check(tooLong.reason === 'too_long', 'Oversized clip is rejected before decoding');
    check(decodeArgs({ file: clip, rawFile: 'out', seconds: 301, width: 320, height: 180 }).args.includes('nokey'), 'Long clips use keyframe decoding');
    const pixels = Buffer.alloc(320 * 180);
    for (let y = 0; y < 180; y += 1) for (let x = 0; x < 320; x += 1) pixels[y * 320 + x] = 50 + ((x * 31 + y * 17) % 160);
    const sample = (shift) => {
      const moved = Buffer.alloc(pixels.length);
      for (let y = 0; y < 180; y += 1) for (let x = 0; x < 320; x += 1) moved[y * 320 + x] = pixels[y * 320 + ((x - shift + 320) % 320)];
      return { ...frames.frameMetrics(moved, 320, 180), faces: [] };
    };
    const shaking = frames.analyzeFrames([0, 8, 0, 8, 0, 8].map(sample), { seconds: 1.2, width: 320, height: 180, rate: 5 });
    check(shaking[0].reasons.includes('shaky') && shaking[0].motion === 'handheld', 'Projection acceleration detects shake');
    await testEngine(scratch, photo, failed);
    console.log(`${checks} checks passed`);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  console.log('test-event-video-analyze.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
