'use strict';

// Transparency through the ffmpeg nodes (WP33b). What is covered:
//   - the detection of an alpha channel in a probe: the stream tag alpha_mode of VP8 / VP9 (either case), pixel formats with alpha,
//     ProRes 4444; none for the rest
//   - the decoder option: libvpx-vp9 / libvpx before -i, only for VP8 / VP9 with alpha; an ffmpeg without the decoder logs
//     "transparency is lost" and the run goes on
//   - the ops that keep the alpha (video.trim, video.speed, video.resize, video.adjust, video.concat) write WebM (VP9 with alpha, Opus):
//     decoded with libvpx-vp9 and run through alphaextract, the pixels show it; the ops outside the list write MP4
//   - an ffmpeg without the encoder libvpx-vp9 or libopus writes MP4 with a log line
//   - the ledger marks a result with alpha (value.alpha), the preview puts a chequerboard behind it and says why in Safari
//   - without alpha nothing changes: the arguments of the ops are the ones of before WP33b (a file made from the code of that day)
//
// Clips are made with lavfi, small (64x64, 1 s, 5 frames per second), because VP9 with alpha is slow to encode. The part that needs
// libvpx-vp9 prints SKIP when the ffmpeg has no such encoder. Local and free: no network, no provider.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const poller = require('../lib/poller');
const store = require('../lib/store');
const costs = require('../lib/costs');
const assets = require('../lib/nodes/assets');
const { listValue } = require('../lib/nodes/types');
const generate = require('../lib/nodes/nodes-generate');
const { createEditHarness, execFileAsync } = require('./support/edit-harness');
const { loadPage } = require('./support/fake-dom');
const golden = require('./support/video-op-args-before-wp33b.json');
const videoOpCases = require('./support/video-op-cases');

const read = (file) => require('fs').readFileSync(path.join(__dirname, '..', file), 'utf8');

/* ---------- detection (pure) ---------- */

function stream(extra) {
  return { codec_type: 'video', codec_name: 'h264', width: 64, height: 64, avg_frame_rate: '5/1', pix_fmt: 'yuv420p', ...extra };
}
const probeData = (video, extra = {}) => ({ streams: [video], format: { duration: '1.0' }, ...extra });
const alphaOf = (video) => ops.normaliseMediaProbe(probeData(video)).video.alpha;

function testDetection() {
  // WebM keeps the alpha plane as a side channel: the pixel format of the native decoder is yuv420p, the tag says it
  for (const name of ['vp9', 'vp8']) {
    assert.equal(alphaOf(stream({ codec_name: name, tags: { alpha_mode: '1' } })), true, `${name} with alpha_mode 1`);
    assert.equal(alphaOf(stream({ codec_name: name, tags: { ALPHA_MODE: '1' } })), true, `${name}: the tag in capitals`);
    assert.equal(alphaOf(stream({ codec_name: name, tags: { Alpha_Mode: ' 1 ' } })), true, `${name}: any case, blanks around the value`);
    assert.equal(alphaOf(stream({ codec_name: name, tags: { alpha_mode: '0' } })), false, `${name} with alpha_mode 0`);
    assert.equal(alphaOf(stream({ codec_name: name, tags: { encoder: 'Lavf61' } })), false, `${name} without the tag`);
    assert.equal(alphaOf(stream({ codec_name: name })), false, `${name} without any tags`);
  }
  assert.equal(alphaOf(stream({ codec_name: 'h264', tags: { alpha_mode: '1' } })), false, 'the tag counts for VP8 and VP9 only');
  assert.equal(alphaOf(stream({ codec_name: 'av1', tags: { alpha_mode: '1' } })), false);

  // pixel formats with alpha
  for (const pixFmt of ['yuva420p', 'yuva422p', 'yuva444p', 'yuva444p10le', 'rgba', 'bgra', 'argb', 'abgr', 'rgba64le', 'ya8', 'ya16le', 'gbrap', 'gbrap12le', 'gbrapf32le']) {
    assert.equal(alphaOf(stream({ codec_name: 'png', pix_fmt: pixFmt })), true, pixFmt);
  }
  // none that carries no alpha: a palette, planar and packed colour, grey
  for (const pixFmt of ['pal8', 'yuv420p', 'yuv444p10le', 'rgb24', 'bgr24', 'gbrp', 'gray', 'gray16le', 'nv12', 'yuvj420p', '']) {
    assert.equal(alphaOf(stream({ codec_name: 'png', pix_fmt: pixFmt })), false, `${pixFmt || 'no pixel format'}`);
  }
  // ProRes 4444 with alpha is yuva444p*, one without alpha (or ProRes 422) has none
  assert.equal(alphaOf(stream({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuva444p12le' })), true, 'ProRes 4444 with alpha');
  assert.equal(alphaOf(stream({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuv444p12le' })), false, 'ProRes 4444 without alpha');
  assert.equal(alphaOf(stream({ codec_name: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le' })), false, 'ProRes 422 HQ');
  // the answer is always a boolean, also for the stream that has no facts, and the rest of the probe is unchanged
  assert.equal(alphaOf(stream({})), false);
  const probe = ops.normaliseMediaProbe(probeData(stream({ codec_name: 'vp9', tags: { alpha_mode: '1' } })));
  assert.deepEqual(probe, { video: { codec: 'vp9', width: 64, height: 64, fps: 5, alpha: true }, audio: null, duration: 1 });
  assert.equal(ops.normaliseMediaProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '2' } }).video, null, 'audio only: no video, so no alpha');
  assert.equal(ffmpeg.normaliseProbe(probeData(stream({ codec_name: 'vp9', tags: { alpha_mode: '1' } }))).video.alpha, true, 'the probe of the concat tool says it too');
}

/* ---------- the decoder option and the lists of an ffmpeg ---------- */

function testDecoderOptions() {
  const has = ffmpeg.hasDecoder('libvpx-vp9');
  const vp9 = { codec: 'vp9', alpha: true };
  const vp8 = { codec: 'vp8', alpha: true };
  if (has) assert.deepEqual(ffmpeg.alphaDecoderOptions(vp9), { opts: ['-c:v', 'libvpx-vp9'], lost: false }, 'VP9 with alpha');
  if (ffmpeg.hasDecoder('libvpx')) assert.deepEqual(ffmpeg.alphaDecoderOptions(vp8), { opts: ['-c:v', 'libvpx'], lost: false }, 'VP8 with alpha');
  // only VP8 and VP9 with alpha
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'vp9', alpha: false }), { opts: [], lost: false });
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'vp8', alpha: false }), { opts: [], lost: false });
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'prores', alpha: true }), { opts: [], lost: false }, 'ProRes reads its alpha itself');
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'png', alpha: true }), { opts: [], lost: false });
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'h264', alpha: false }), { opts: [], lost: false });
  assert.deepEqual(ffmpeg.alphaDecoderOptions(null), { opts: [], lost: false });
  assert.deepEqual(ffmpeg.alphaDecoderOptions({ codec: 'vp9' }), { opts: [], lost: false }, 'no mark, no option');
  // an ffmpeg that cannot be run has no decoders: the alpha is lost
  assert.deepEqual(ffmpeg.alphaDecoderOptions(vp9, { ffmpegPath: '/nonexistent/ffmpeg' }), { opts: [], lost: true });
  assert.equal(ffmpeg.hasDecoder('libvpx-vp9', { ffmpegPath: '/nonexistent/ffmpeg' }), false);
  assert.equal(ffmpeg.hasEncoder('libopus', { ffmpegPath: '/nonexistent/ffmpeg' }), false);
  assert.equal(ffmpeg.hasDecoder('no-such-decoder'), false);
  assert.equal(ffmpeg.hasEncoder('no-such-encoder'), false);

  // applyAlpha: the option goes before -i of the input with alpha, in front of the options the builder made
  const mp4 = { video: { codec: 'h264', width: 64, height: 64, fps: 5, alpha: false }, audio: null, duration: 1 };
  const webm = { video: { codec: 'vp9', width: 64, height: 64, fps: 5, alpha: true }, audio: null, duration: 1 };
  if (has) {
    const spec = { inputOpts: [['-ss', '0.5'], []], outputs: [{ kind: 'video', maps: ['0:v:0'], alpha: true }] };
    edit.applyAlpha(spec, [webm, mp4], { ffmpegPath: ffmpeg.binaries().ffmpeg });
    assert.deepEqual(spec.inputOpts[0], ['-c:v', 'libvpx-vp9', '-ss', '0.5']);
    assert.deepEqual(spec.inputOpts[1], [], 'the input without alpha is left as it is');
    const second = { outputs: [{ kind: 'video', maps: ['[out]'] }] };
    edit.applyAlpha(second, [mp4, webm], { ffmpegPath: ffmpeg.binaries().ffmpeg });
    assert.deepEqual(second.inputOpts.map((opts) => opts || []), [[], ['-c:v', 'libvpx-vp9']], 'a builder without input options gets just the decoder');
    // without any alpha input the spec stays what the builder made
    const plain = { inputOpts: [['-ss', '1']], graph: '[0:v]null[out]', outputs: [{ kind: 'video', maps: ['[out]'] }] };
    const copy = JSON.parse(JSON.stringify(plain));
    edit.applyAlpha(plain, [mp4], { ffmpegPath: ffmpeg.binaries().ffmpeg });
    assert.deepEqual(plain, copy, 'an op without alpha input is not touched');
    const noOpts = { graph: 'x', outputs: [{ kind: 'video', maps: ['[out]'] }] };
    edit.applyAlpha(noOpts, [mp4], { ffmpegPath: ffmpeg.binaries().ffmpeg });
    assert.deepEqual(noOpts, { graph: 'x', outputs: [{ kind: 'video', maps: ['[out]'] }] }, 'no inputOpts appear out of nothing');
    // a plan with its own processes (execute) gets no decoder option and writes MP4
    const planned = { inputOpts: [[]], outputs: [{ kind: 'video', maps: ['[out]'], alpha: true }] };
    edit.applyAlpha(planned, [webm], { ffmpegPath: ffmpeg.binaries().ffmpeg, plain: true });
    assert.deepEqual(planned.inputOpts, [[]]);
    assert.equal(planned.outputs[0].container, undefined);
    assert.equal(planned.outputs[0].alpha, undefined);
  }
  // VP8: libvpx (checked on the lists of the ffmpeg of the run: the option is only set when the decoder is there)
  const vp8Info = { video: { codec: 'vp8', width: 64, height: 64, fps: 5, alpha: true }, audio: null, duration: 1 };
  const vp8Spec = { outputs: [{ kind: 'video', maps: ['0:v:0'], alpha: true }] };
  const logs = [];
  edit.applyAlpha(vp8Spec, [vp8Info], { ffmpegPath: ffmpeg.binaries().ffmpeg, log: (line) => logs.push(line) });
  if (ffmpeg.hasDecoder('libvpx')) assert.deepEqual(vp8Spec.inputOpts[0], ['-c:v', 'libvpx']);
  else assert.match(logs.join('\n'), /transparency is lost/);
}

/* ---------- the arguments without alpha are the ones of before ---------- */

function testArgumentsWithoutAlpha() {
  const mp4 = { video: { codec: 'h264', width: 160, height: 90, fps: 25 }, audio: { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' }, duration: 3 };
  const mute = { ...mp4, audio: null };
  const png = { video: { codec: 'png', width: 40, height: 20, fps: 25 }, audio: null, duration: null };
  const argv = (spec, files, out) => ops.assembleArgs(spec, files, out);
  // `golden` was written by the code of the day before WP33b (git HEAD of that day): the same inputs, byte for byte the same arguments
  assert.deepEqual(argv(ops.buildTrim({ start: 0.5, end: 2, accurate: true }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.trim);
  assert.deepEqual(argv(ops.buildTrim({ start: 1, end: 0, accurate: false }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.trimCopy, 'the stream copy stays');
  assert.deepEqual(argv(ops.buildSpeed({ factor: 2 }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.speedAudio);
  assert.deepEqual(argv(ops.buildSpeed({ factor: 0.5 }, [mute]), ['/in.mp4'], ['/out.mp4']), golden.speedMute);
  assert.deepEqual(argv(ops.buildVideoResize({ width: 100, height: 100, fit: 'contain', background: '#000000' }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.resizeContain);
  assert.deepEqual(argv(ops.buildVideoResize({ width: 100, height: 100, fit: 'cover', background: '#000000' }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.resizeCover);
  assert.deepEqual(argv(ops.buildVideoResize({ width: 100, height: 0, fit: 'contain', background: '#000000' }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.resizeWidth);
  assert.deepEqual(argv(ops.buildVideoAdjust({ brightness: 0.1, contrast: 1.2, saturation: 1, gamma: 1, hue: 10 }, [mp4]), ['/in.mp4'], ['/out.mp4']), golden.adjust);
  assert.deepEqual(argv(ops.buildOverlayImage({ x: 50, y: 50, unit: 'percent', anchor: 'center', scale: 100, opacity: 0.8, start: 0.5, end: 2 }, [mp4, png]), ['/in.mp4', '/logo.png'], ['/out.mp4']), golden.overlayImage);
  assert.deepEqual(argv(ops.buildMergeAudio({ mode: 'replace', audio_volume: 1, video_volume: 1, length: 'video' }, [mp4, { video: null, audio: { codec: 'aac' }, duration: 5 }]), ['/in.mp4', '/a.m4a'], ['/out.mp4']), golden.mergeAudio);
  assert.deepEqual(argv(ops.buildImageResize({ width: 100, height: 100, fit: 'contain', background: '#000000', transparent: true }), ['/in.png'], ['/out.png']), golden.imageResize, 'images: transparent padding as before');
  assert.deepEqual(argv(ops.buildImageResize({ width: 100, height: 100, fit: 'contain', background: '#112233', transparent: false }), ['/in.png'], ['/out.png']), golden.imageResizeOpaque);
  assert.deepEqual(argv(ops.buildExtractFrame({ position: 'time', time: 1 }, [mp4]), ['/in.mp4'], ['/out.png']), golden.extractFrame);

  // the ops WP33b left alone (captions, sound wave, grid, image to video, concat of the tool): the probes come from normaliseMediaProbe on
  // an ffprobe output, so they carry `alpha: false` as real ones do; the arguments are the ones main wrote (scripts/support/video-op-cases.js)
  assert.deepEqual(videoOpCases.compute(ops, ffmpeg), golden.more, 'the ops outside the list: the arguments of before');

  // the same through applyAlpha: nothing is added to the spec of an op whose inputs have no alpha
  const spec = ops.buildTrim({ start: 0.5, end: 2, accurate: true }, [mp4]);
  edit.applyAlpha(spec, [mp4], { ffmpegPath: ffmpeg.binaries().ffmpeg });
  assert.deepEqual(argv(spec, ['/in.mp4'], ['/out.mp4']), golden.trim);
  // no output of an op without alpha input carries the mark
  for (const built of [ops.buildTrim({ start: 0, end: 0, accurate: true }, [mp4]), ops.buildSpeed({ factor: 2 }, [mp4]), ops.buildVideoResize({ width: 50, height: 0, fit: 'contain' }, [mp4]), ops.buildVideoAdjust({ brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0 }, [mp4])]) {
    assert.ok(built.outputs.every((output) => output.alpha === undefined && output.container === undefined));
  }
  assert.equal(ops.outputExt({ kind: 'video' }), '.mp4');
  assert.equal(ops.outputExt({ kind: 'video', container: 'webm' }), '.webm');
  assert.equal(ops.outputExt({ kind: 'image' }), '.png');
  assert.equal(ops.outputExt({ kind: 'audio' }), '.m4a');

  // the list of the ops that keep alpha, in the code
  assert.deepEqual([...ops.ALPHA_KEEPING_OPS], ['video.trim', 'video.speed', 'video.resize', 'video.adjust', 'video.concat']);
  // the arguments of the WebM
  const webm = { video: { codec: 'vp9', width: 64, height: 64, fps: 5, alpha: true }, audio: { codec: 'opus' }, duration: 1 };
  const trimmed = ops.buildTrim({ start: 0, end: 0, accurate: false }, [webm]);
  assert.equal(trimmed.outputs[0].alpha, true);
  assert.equal(trimmed.outputs[0].copyAll, undefined, 'with alpha the cut is re-encoded, never copied');
  trimmed.outputs[0] = { ...trimmed.outputs[0], container: 'webm' };
  const args = argv(trimmed, ['/in.webm'], ['/out.webm']);
  const codec = args.slice(args.indexOf('-c:v'));
  assert.deepEqual(codec, ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k', '/out.webm']);
  assert.ok(!args.includes('-movflags'), 'no MP4 flags for a WebM');
  const speedMute = ops.buildSpeed({ factor: 2 }, [{ ...webm, audio: null }]);
  speedMute.outputs[0] = { ...speedMute.outputs[0], container: 'webm' };
  assert.ok(argv(speedMute, ['/in.webm'], ['/out.webm']).includes('-an') && !argv(speedMute, ['/in.webm'], ['/out.webm']).includes('libopus'), 'no sound: no Opus');
  // the padding of a resized video with alpha is transparent, whatever the colour says
  const padded = ops.buildVideoResize({ width: 80, height: 96, fit: 'contain', background: '#ff0000' }, [webm]);
  assert.match(padded.graph, /pad=80:96:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0,setsar=1/);
  assert.doesNotMatch(padded.graph, /format=rgba/, 'the alpha plane is there already');
  assert.match(ops.buildVideoResize({ width: 80, height: 96, fit: 'contain', background: '#ff0000' }, [mp4]).graph, /color=0xff0000/, 'without alpha the colour is used');
}

/* ---------- real runs ---------- */

// An ffmpeg that says it lacks some decoders or encoders (the rest is passed on to the real one): the lists are filtered, nothing else.
async function makeWrapper(dir, name, { hideDecoders = '', hideEncoders = '' }) {
  const real = ffmpeg.binaries().ffmpeg;
  const file = path.join(dir, name);
  const filter = (pattern) => (pattern ? `| grep -v -E '${pattern}'` : '');
  const lines = [
    '#!/bin/sh',
    `REAL='${real}'`,
    'for arg in "$@"; do',
    '  case "$arg" in',
    `    -decoders) "$REAL" "$@" ${filter(hideDecoders)}; exit 0;;`,
    `    -encoders) "$REAL" "$@" ${filter(hideEncoders)}; exit 0;;`,
    '  esac',
    'done',
    'exec "$REAL" "$@"',
    ''
  ];
  await fsp.writeFile(file, lines.join('\n'), 'utf8');
  await fsp.chmod(file, 0o755);
  return file;
}

async function withFfmpeg(file, fn) {
  const before = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = file;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = before;
  }
}

async function testRuns() {
  const h = await createEditHarness({ prefix: 'ocd-alpha-', extraRegister: (registry) => generate.registerAll(registry) });
  const originals = { recordCost: costs.recordCost };
  costs.recordCost = async (entry) => entry;
  try {
    const W = 64;
    const VP9 = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4'];
    // the runs need libvpx-vp9 (encoder and decoder) and libopus; without them the fixtures cannot be made, so those parts are skipped
    const libvpx = ffmpeg.hasEncoder('libvpx-vp9') && ffmpeg.hasDecoder('libvpx-vp9') && ffmpeg.hasEncoder('libopus');
    let red = null;
    let redSound = null;
    let plainWebm = null;
    if (libvpx) {
      // half transparent red, 1 s, 5 frames per second; one with a sound of 880 Hz in Opus
      await h.ff(['-f', 'lavfi', '-i', `color=c=red@0.5:s=${W}x${W}:r=5:d=1,format=yuva420p`, ...VP9, h.src('red.webm')]);
      await h.ff(['-f', 'lavfi', '-i', `color=c=red@0.5:s=${W}x${W}:r=5:d=1,format=yuva420p`, '-f', 'lavfi', '-i', 'sine=f=880:d=1', ...VP9, '-c:a', 'libopus', h.src('red-sound.webm')]);
      // the same red, opaque, in a WebM without alpha
      await h.ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${W}:r=5:d=1,format=yuv420p`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '40', '-deadline', 'good', '-cpu-used', '5', h.src('plain.webm')]);
    }
    // an MP4, a WAV and a PNG need no libvpx
    await h.ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${W}:r=5:d=1,format=yuv420p`, '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', h.src('plain.mp4')]);
    await h.ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', '-c:a', 'pcm_s16le', h.src('tone.wav')]);
    await h.ff(['-f', 'lavfi', '-i', 'color=c=white:s=16x16', '-frames:v', '1', h.src('logo.png')]);

    if (libvpx) {
      red = await h.upload('red.webm', '.webm');
      redSound = await h.upload('red-sound.webm', '.webm');
      plainWebm = await h.upload('plain.webm', '.webm');
      assert.equal(red.type, 'video');
    }
    const plainMp4 = await h.upload('plain.mp4', '.mp4');
    const tone = await h.upload('tone.wav', '.wav');
    const logo = await h.upload('logo.png', '.png');
    if (!libvpx) {
      console.log('SKIP the ffmpeg has no libvpx-vp9 (encoder and decoder) or libopus: the runs that keep alpha were not tested');
    }

    const probeFile = (file) => ops.probeMedia(file, {});
    // the alpha (0 to 255) of the pixel (x, y) at time t: decoded with libvpx-vp9 (the one decoder that reads it), then alphaextract
    const alphaAt = async (file, x, y, t = 0.1) => {
      const { stdout } = await execFileAsync(
        ffmpeg.binaries().ffmpeg,
        ['-nostdin', '-v', 'error', '-c:v', 'libvpx-vp9', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `alphaextract,crop=1:1:${x}:${y},format=gray`, '-f', 'rawvideo', '-'],
        { encoding: 'buffer' }
      );
      assert.equal(stdout.length, 1, 'one pixel of the alpha plane');
      return stdout[0];
    };
    const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not near ${expected}`);
    const ranWith = async (type, inputs, raw = {}) => {
      const logs = [];
      const ctx = { ...h.makeCtx(), log: (line) => logs.push(line) };
      const definition = h.def(type);
      const result = await definition.execute(ctx, inputs, h.registry.normalizeParams(definition, raw));
      const variant = result.variants[0];
      return { value: variant.video || variant.image || variant, logs };
    };
    const outFile = async (value) => assets.assetFilePath(value);

    // the source: half transparent
    if (libvpx) {
      const source = await probeFile(await outFile(red));
      assert.equal(source.video.alpha, true, 'the test clip has alpha');
      near(await alphaAt(await outFile(red), 32, 32), 127, 3, 'the source is half transparent');
      assert.equal((await probeFile(await outFile(plainWebm))).video.alpha, false, 'a VP9 clip without alpha');
    }
    assert.equal((await probeFile(await outFile(plainMp4))).video.alpha, false);

    /* --- the ops that keep alpha write WebM with alpha --- */
    const cases = [
      { name: 'trim (accurate)', type: 'video.trim', params: { start: 0.2, end: 0.8, accurate: true }, check: (probe) => near(probe.duration, 0.6, 0.25, 'the cut is 0.6 s long') },
      { name: 'trim (copy requested)', type: 'video.trim', params: { start: 0, end: 0.6, accurate: false }, check: (probe) => near(probe.duration, 0.6, 0.25, 'the cut is 0.6 s long') },
      { name: 'speed', type: 'video.speed', params: { factor: 2 }, check: (probe) => assert.ok(probe.duration < 0.95, `faster: ${probe.duration} s`) },
      { name: 'resize (contain)', type: 'video.resize', params: { width: 80, height: 96, fit: 'contain', background: '#ff0000' }, size: [80, 96], bars: [[2, 2], [77, 93]], picture: [40, 48] },
      { name: 'resize (cover)', type: 'video.resize', params: { width: 80, height: 96, fit: 'cover', background: '#000000' }, size: [80, 96], picture: [4, 4] },
      { name: 'resize (width only)', type: 'video.resize', params: { width: 32, height: 0, fit: 'contain', background: '#000000' }, size: [32, 32], picture: [16, 16] },
      { name: 'adjust', type: 'video.adjust', params: { brightness: 0.1, contrast: 1.2, saturation: 1.1, gamma: 1.1, hue: 10 }, picture: [32, 32] }
    ];
    if (libvpx) {
      for (const spec of cases) {
        const { value, logs } = await ranWith(spec.type, { video: redSound }, spec.params);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.webm', `${spec.name}: WebM`);
        assert.equal(value.alpha, true, `${spec.name}: the result is marked as having alpha`);
        assert.deepEqual(logs, [], `${spec.name}: nothing to warn about`);
        const probe = await probeFile(file);
        assert.equal(probe.video.codec, 'vp9', `${spec.name}: VP9`);
        assert.equal(probe.video.alpha, true, `${spec.name}: the stream says alpha`);
        assert.equal(probe.audio.codec, 'opus', `${spec.name}: the sound is Opus`);
        if (spec.size) assert.deepEqual([probe.video.width, probe.video.height], spec.size, `${spec.name}: size`);
        if (spec.check) spec.check(probe);
        const [px, py] = spec.picture || [32, 32];
        near(await alphaAt(file, px, py), spec.type === 'video.adjust' ? 127 : 127, 4, `${spec.name}: the picture is still half transparent`);
        for (const [bx, by] of spec.bars || []) assert.equal(await alphaAt(file, bx, by), 0, `${spec.name}: the bars are transparent`);
        // the ledger knows it (what the preview reads) and the stored file is the WebM
        const entry = (await store.readLedger(h.sessionId)).find((item) => item.id === value.assetId);
        assert.equal(entry.alpha, true, `${spec.name}: ledger entry`);
        assert.match(entry.file, /\.webm$/);
      }
      // a clip without sound: no audio stream in the WebM (and no error about Opus)
      {
        const { value } = await ranWith('video.speed', { video: red }, { factor: 0.5 });
        const file = await outFile(value);
        const probe = await probeFile(file);
        assert.equal(probe.audio, null);
        assert.equal(probe.video.alpha, true);
        assert.ok(probe.duration > 1.5, 'slower: longer');
      }
      // the decoder option is the one in the arguments of the run: libvpx-vp9 before -i, only for the input with alpha
      const seen = [];
      const realRun = ffmpeg.runProcess;
      ffmpeg.runProcess = (command, args, options) => {
        if (command === ffmpeg.binaries().ffmpeg) seen.push(args);
        return realRun(command, args, options);
      };
      try {
        await ranWith('video.trim', { video: red }, { start: 0, end: 0.5, accurate: true });
        await ranWith('video.trim', { video: plainWebm }, { start: 0, end: 0.5, accurate: true });
        await ranWith('video.trim', { video: plainMp4 }, { start: 0, end: 0.5, accurate: true });
      } finally {
        ffmpeg.runProcess = realRun;
      }
      assert.equal(seen.length, 3);
      const before = (args) => args.slice(0, args.indexOf('-i'));
      assert.deepEqual(before(seen[0]).slice(4), ['-c:v', 'libvpx-vp9', '-ss', '0', '-t', '0.5'], 'alpha: the decoder is named before -i');
      assert.deepEqual(before(seen[1]).slice(4), ['-ss', '0', '-t', '0.5'], 'VP9 without alpha: no option');
      assert.deepEqual(before(seen[2]).slice(4), ['-ss', '0', '-t', '0.5'], 'H.264: no option');
      assert.ok(seen[0].includes('libvpx-vp9') && seen[0].includes('yuva420p'));
      assert.ok(seen[1].includes('libx264') && seen[2].includes('libx264'), 'without alpha: MP4 as before');

      // a clip without alpha still gives MP4 on every op of the list, with the same arguments as before
      for (const spec of cases.slice(0, 3)) {
        const { value } = await ranWith(spec.type, { video: plainMp4 }, spec.params);
        assert.equal(path.extname(await outFile(value)), '.mp4', `${spec.name}: no alpha, MP4`);
        assert.equal(value.alpha, undefined);
        assert.equal((await probeFile(await outFile(value))).video.codec, 'h264');
      }
      const plainWebmOut = (await ranWith('video.speed', { video: plainWebm }, { factor: 2 })).value;
      assert.equal(path.extname(await outFile(plainWebmOut)), '.mp4', 'a VP9 clip without alpha is written as MP4, as before');
    }

    /* --- the ops outside the list write MP4 --- */
    if (libvpx) {
      const mp4Cases = [
        { name: 'overlay image', type: 'video.overlay_image', inputs: { video: red, image: logo }, params: {} },
        { name: 'merge audio', type: 'video.merge_audio', inputs: { video: red, audio: tone }, params: { mode: 'replace', length: 'video' } },
        { name: 'sound wave', type: 'video.soundwave', inputs: { video: redSound }, params: { mode: 'line' } },
        { name: 'grid', type: 'video.grid', inputs: { videos: listValue('video', [red, red]) }, params: {} },
        { name: 'overlay video', type: 'video.overlay_video', inputs: { background: plainMp4, layer: red }, params: { scale: 50 } }
      ];
      for (const spec of mp4Cases) {
        const { value } = await ranWith(spec.type, spec.inputs, spec.params);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.mp4', `${spec.name}: MP4`);
        const probe = await probeFile(file);
        assert.equal(probe.video.codec, 'h264', `${spec.name}: H.264`);
        assert.equal(probe.video.alpha, false, `${spec.name}: no alpha in the result`);
        assert.equal(value.alpha, undefined, `${spec.name}: not marked`);
      }
      // a frame of a video with alpha is a PNG with alpha (the decoder that reads it is used)
      {
        const { value } = await ranWith('video.extract_frame', { video: red }, { position: 'first' });
        const file = await outFile(value);
        const probe = await probeFile(file);
        assert.equal(probe.video.alpha, true, 'the PNG has an alpha channel');
        const { stdout } = await execFileAsync(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-vf', 'alphaextract,crop=1:1:32:32,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
        near(stdout[0], 127, 3, 'the frame is half transparent');
      }
    }

    /* --- an ffmpeg without the decoder, the encoder or Opus --- */
    if (libvpx) {
      const noDecoder = await makeWrapper(h.dir, 'ffmpeg-no-decoder', { hideDecoders: ' libvpx(-vp9)? ' });
      const noEncoder = await makeWrapper(h.dir, 'ffmpeg-no-encoder', { hideEncoders: ' libvpx-vp9 ' });
      const noOpus = await makeWrapper(h.dir, 'ffmpeg-no-opus', { hideEncoders: ' libopus ' });
      assert.equal(ffmpeg.hasDecoder('libvpx-vp9', { ffmpegPath: noDecoder }), false);
      assert.equal(ffmpeg.hasEncoder('libvpx-vp9', { ffmpegPath: noEncoder }), false);
      assert.equal(ffmpeg.hasEncoder('libopus', { ffmpegPath: noOpus }), false);
      assert.equal(ffmpeg.hasEncoder('libvpx-vp9', { ffmpegPath: noOpus }), true, 'the others stay');

      // no decoder: the alpha cannot be read, so it is lost; a log line says so and the run goes on (MP4)
      await withFfmpeg(noDecoder, async () => {
        const { value, logs } = await ranWith('video.trim', { video: red }, { start: 0, end: 0.5, accurate: true });
        assert.ok(logs.some((line) => /transparency is lost/.test(line)), `a log line about the lost transparency: ${JSON.stringify(logs)}`);
        assert.equal(logs.length, 1);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.mp4');
        assert.equal((await probeFile(file)).video.codec, 'h264');
        assert.equal(value.alpha, undefined);
        // an input without alpha says nothing
        const quiet = await ranWith('video.trim', { video: plainMp4 }, { start: 0, end: 0.5, accurate: true });
        assert.deepEqual(quiet.logs, []);
      });
      // no encoder (libvpx-vp9): MP4 with a log line, the decoder is used
      await withFfmpeg(noEncoder, async () => {
        const { value, logs } = await ranWith('video.speed', { video: redSound }, { factor: 2 });
        assert.equal(logs.length, 1);
        assert.match(logs[0], /transparency is lost/);
        assert.match(logs[0], /MP4/);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.mp4');
        assert.equal((await probeFile(file)).audio.codec, 'aac');
        assert.equal(value.alpha, undefined);
      });
      // no Opus: the same
      await withFfmpeg(noOpus, async () => {
        const { value, logs } = await ranWith('video.adjust', { video: redSound }, { brightness: 0.1 });
        assert.equal(logs.length, 1);
        assert.match(logs[0], /transparency is lost/);
        assert.equal(path.extname(await outFile(value)), '.mp4');
      });
    }

    /* --- video.concat (the tool concat_videos behind it) --- */
    if (libvpx) {
      // the tool takes assets of kind video (a result of a node), not uploads
      const asVideo = async (name, ext) => {
        const saved = await store.saveAsset(h.sessionId, { kind: 'video', buffer: await fsp.readFile(h.src(name)), ext, prompt: name, cost: 0 });
        return assets.valueFromAsset(h.sessionId, saved.id);
      };
      const redClip = await asVideo('red.webm', '.webm');
      const redSoundClip = await asVideo('red-sound.webm', '.webm');
      const mp4Clip = await asVideo('plain.mp4', '.mp4');
      const concat = async (clips, env = null) => {
        const toolCtx = { sessionId: h.sessionId, emit() {}, user: 'alpha-test@example.com' };
        const logs = [];
        const ctx = { ...h.makeCtx(), toolCtx, log: (line) => logs.push(line) };
        const definition = h.def('video.concat');
        const run = () => definition.execute(ctx, { clips: listValue('video', clips) }, h.registry.normalizeParams(definition, {}));
        const result = env ? await withFfmpeg(env, run) : await run();
        return { value: result.variants[0].video, logs };
      };
      // every clip has alpha: WebM with alpha, as long as the clips together, sound in Opus
      {
        const { value, logs } = await concat([redSoundClip, redClip]);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.webm');
        assert.deepEqual(logs, []);
        const probe = await probeFile(file);
        assert.equal(probe.video.codec, 'vp9');
        assert.equal(probe.video.alpha, true);
        assert.equal(probe.audio.codec, 'opus');
        near(probe.duration, 2, 0.4, 'two clips of 1 s');
        assert.equal(value.alpha, true, 'marked in the ledger');
        near(await alphaAt(file, 32, 32, 0.3), 127, 4, 'half transparent in the first clip');
        near(await alphaAt(file, 32, 32, 1.5), 127, 4, 'and in the second');
        // clips of another size are put on transparent bars, not on black
        const small = await ranWith('video.resize', { video: red }, { width: 32, height: 16, fit: 'stretch', background: '#000000' });
        const joined = await concat([redClip, small.value]);
        const joinedFile = await outFile(joined.value);
        assert.equal((await probeFile(joinedFile)).video.alpha, true);
        near(await alphaAt(joinedFile, 32, 4, 1.5), 0, 4, 'above the small clip (a wide one on a square canvas): transparent bar');
        near(await alphaAt(joinedFile, 32, 32, 1.5), 127, 4, 'the small clip itself');
      }
      // not every clip has alpha: MP4 as before
      {
        const { value, logs } = await concat([redClip, mp4Clip]);
        const file = await outFile(value);
        assert.equal(path.extname(file), '.mp4');
        assert.deepEqual(logs, []);
        assert.equal((await probeFile(file)).video.alpha, false);
        assert.equal(value.alpha, undefined);
      }
      {
        const { value } = await concat([mp4Clip, mp4Clip]);
        assert.equal(path.extname(await outFile(value)), '.mp4');
      }
      // every clip has alpha but the ffmpeg cannot keep it: MP4 and a log line
      {
        const noEncoder = path.join(h.dir, 'ffmpeg-no-encoder');
        const { value, logs } = await concat([redClip, redClip], noEncoder);
        assert.equal(path.extname(await outFile(value)), '.mp4');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /transparency is lost/);
      }
    }

    /* --- the result of the segmentation is marked when it is stored --- */
    if (libvpx) {
      assert.equal(await poller.webmHasAlpha(h.src('red.webm')), true, 'a WebM with alpha');
      assert.equal(await poller.webmHasAlpha(h.src('plain.webm')), false, 'a WebM without');
      assert.equal(await poller.webmHasAlpha(h.src('plain.mp4')), false, 'an MP4');
      assert.equal(await poller.webmHasAlpha(h.src('does-not-exist.webm')), false, 'a file that is not there');
      await fsp.writeFile(h.src('broken.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
      assert.equal(await poller.webmHasAlpha(h.src('broken.webm')), false, 'a file that cannot be read says no and never throws');
    }

    // a value from the ledger carries the mark only when the entry has it
    {
      const marked = await assets.saveOutputFile(h.sessionId, { kind: 'video', ext: '.webm', sourceFile: await (async () => {
        const dir = await assets.createScratchDir(h.sessionId);
        const file = path.join(dir, 'x.webm');
        // any file will do: only the ledger mark is under test
        await fsp.copyFile(h.src(libvpx ? 'red.webm' : 'plain.mp4'), file);
        return file;
      })(), prompt: 'marked', alpha: true });
      assert.equal(marked.alpha, true);
      assert.equal((await assets.valueFromAsset(h.sessionId, marked.assetId)).alpha, true);
      assert.equal((red || plainMp4).alpha, undefined, 'an upload is not marked');
    }
  } finally {
    costs.recordCost = originals.recordCost;
    await h.cleanup();
  }
}

/* ---------- the preview ---------- */

function testPreview() {
  const css = read('public/nodes/nodes.css');
  assert.match(css, /\.nv-alpha[^{]*\{[^}]*linear-gradient/, 'a chequerboard rule');
  assert.match(css, /--nv-checker-a:\s*#[0-9a-f]{6};\s*--nv-checker-b:\s*#[0-9a-f]{6};/i, 'dark tiles by default');
  assert.ok(!/prefers-color-scheme|data-theme/.test(css.slice(css.indexOf('--nv-checker-a') - 200, css.indexOf('.nv-alpha-hint'))), 'the interface has no light theme, so no light tiles');
  // the thumbnail and the app view get their own background later in the file: the chequerboard rule must name them with the same weight
  const checker = css.match(/((?:[^{}]*\.nv-alpha[^{}]*,\s*)*[^{}]*\.nv-alpha[^{}]*)\{[^}]*linear-gradient/)[1];
  assert.match(checker, /\.nv-thumb\.nv-alpha/, 'the thumbnail (.nv-thumb sets a background of its own)');
  assert.match(checker, /\.nv-appleaf-frame \.nv-media\.nv-alpha/, 'the app view (.nv-appleaf-frame .nv-media sets a background of its own)');
  assert.match(read('public/nodes/app-mode.js'), /OCD\.preview\.alphaHint\(leaf\)/, 'the app view adds the Safari hint as the card does');
  assert.match(css, /\.nv-viewer-video\.nv-alpha/, 'it beats the black of the large view');
  assert.match(css, /\.nv-alpha-hint\s*\{/);

  const alphaVideo = { type: 'video', assetId: 'vid-1', sessionId: 'sess-1', file: 'vid-1.webm', url: '/assets/sess-1/vid-1.webm', alpha: true };
  const plainVideo = { ...alphaVideo, assetId: 'vid-2', alpha: undefined };
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  // every browser on an iPhone or iPad is WebKit: Chrome (CriOS), Firefox (FxiOS) and Edge (EdgiOS) show no VP9 alpha either
  const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
  const iosFirefox = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15';
  const iosEdge = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15';
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
  // an iPad in the desktop mode says it is a Mac (Safari, or Chrome with the Mac user agent), but it has a touch screen
  const ipadAsMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const ipadAsMacChrome = chrome;

  for (const lang of ['de', 'en', 'es']) {
    for (const [agent, name, hint, touch] of [
      [chrome, 'Chrome', false, 0], [firefox, 'Firefox', false, 0], [safari, 'Safari', true, 0], [iphone, 'Safari on iOS', true, 5],
      [android, 'Chrome on Android', false, 5], [iosChrome, 'Chrome on iOS', true, 5], [iosFirefox, 'Firefox on iOS', true, 5],
      [iosEdge, 'Edge on iOS', true, 5], [ipad, 'Chrome on iPadOS', true, 5], [ipadAsMac, 'Safari on an iPad as a Mac', true, 5],
      [ipadAsMacChrome, 'Chrome on an iPad as a Mac', true, 5], [chrome, 'Chrome on a Mac', false, 0]
    ]) {
      const page = loadPage(lang, { userAgent: agent, maxTouchPoints: touch });
      const { preview } = page.OCD;
      // the media element
      const node = preview.mediaNode(alphaVideo);
      assert.equal(node.tagName, 'VIDEO');
      assert.equal(node.classList.contains('nv-alpha'), true, `${lang} ${name}: the chequerboard on a video with alpha`);
      assert.equal(preview.mediaNode(plainVideo).classList.contains('nv-alpha'), false, 'none behind a video without');
      assert.equal(preview.mediaNode({ ...plainVideo, type: 'image', file: 'x.png', url: '/assets/sess-1/x.png' }).classList.contains('nv-alpha'), false);
      assert.equal(preview.mediaNode({ ...alphaVideo, type: 'image', file: 'x.png', url: '/assets/sess-1/x.png' }).classList.contains('nv-alpha'), true, 'the same for an image that is marked');
      // the card
      const card = new (require('./support/fake-dom').FakeNode)('div');
      preview.renderCardPreview(card, [{ port: 'video', value: alphaVideo }], {});
      const hints = card.find((item) => item.classes.has('nv-alpha-hint'));
      assert.equal(hints.length, hint ? 1 : 0, `${lang} ${name}: the Safari hint only in Safari`);
      if (hint) assert.equal(hints[0].textContent, page.window.I18N[lang]['nodes.preview.alphaSafari']);
      assert.equal(card.find((item) => item.classes.has('nv-alpha')).length, 1, 'one video with the chequerboard');
      const none = new (require('./support/fake-dom').FakeNode)('div');
      preview.renderCardPreview(none, [{ port: 'video', value: plainVideo }], {});
      assert.equal(none.find((item) => item.classes.has('nv-alpha-hint') || item.classes.has('nv-alpha')).length, 0, 'nothing for a video without alpha');
      // the thumbnail
      assert.equal(preview.thumb(alphaVideo).classList.contains('nv-alpha'), true);
      assert.equal(preview.thumb(plainVideo).classList.contains('nv-alpha'), false);
    }
    const text = loadPage(lang).window.I18N[lang]['nodes.preview.alphaSafari'];
    assert.match(text, /Safari/);
    assert.ok(text.length > 40);
  }
  // no HTML from data
  assert.ok(!/innerHTML/.test(read('public/nodes/preview.js')));
}

// the whole file again with an ffmpeg that knows neither libvpx, libvpx-vp9 nor libopus: it must print SKIP and end green
async function testWithoutVpx() {
  const os = require('os');
  const { spawn } = require('child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-novpx-'));
  try {
    const hide = ' (libvpx|libvpx-vp9|libopus) ';
    const wrapper = await makeWrapper(dir, 'ffmpeg-novpx', { hideDecoders: hide, hideEncoders: hide });
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename], { env: { ...process.env, FFMPEG_PATH: wrapper, OCD_ALPHA_TEST_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0, `without libvpx the test ends green: ${result.out}`);
    assert.match(result.out, /SKIP the ffmpeg has no libvpx-vp9/);
    assert.match(result.out, /test-nodes-video-alpha\.js: ok/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  testDetection();
  testDecoderOptions();
  testArgumentsWithoutAlpha();
  testPreview();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the pure parts were tested)');
  } else {
    await testRuns();
    if (!process.env.OCD_ALPHA_TEST_CHILD && ffmpeg.hasEncoder('libvpx-vp9')) await testWithoutVpx();
  }
  console.log('test-nodes-video-alpha.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
