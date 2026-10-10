'use strict';

const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
const ops = require('../nodes/ffmpeg-ops');
const { readExif, orientationFilters } = require('./exif');
const { scanInWorker } = require('./frames');
const { analyzeSpeech } = require('./speech');
const { analyzeVision, DEFAULT_MODEL } = require('./vision');
const { LIMITS, checkInfo } = require('./contract');
// Formats accepted by the v1 analyser; HEIC gets its own actionable rejection below.
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
// Video containers supported by the upload and decode path.
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
// Millisecond precision keeps source times stable in info v1.
const TIME_PRECISION = 1000;
// The decode budget: 1..5 frames/s, about 1200 samples, keyframes only from 300 s.
const SAMPLE_MIN_FPS = 1;
// Upper sampling rate in frames/s for short clips.
const SAMPLE_MAX_FPS = 5;
// Approximate sample budget used to lower the rate for longer clips.
const SAMPLE_TARGET = 1200;
// Source duration in seconds at which decoding switches to keyframes only.
const KEYFRAME_ONLY_SECONDS = 300;
// A 320 px grey grid bounds frame analysis; photos for vision keep at most 1600 px per side.
const GRID_WIDTH_PX = 320;
// The width of the grey decode of a photo in px (faces down to about 2 % of the width are found).
const PHOTO_GRID_WIDTH_PX = 1024;
// Maximum photo side in px before the image is sent to vision.
const PHOTO_MAX_SIDE_PX = 1600;
// FFmpeg's JPEG decoder supports reduction levels 0..2 (full, half, quarter size).
const JPEG_MAX_LOWRES = 2;
// Keep local decoding below foreground priority, with two decoder threads and one filter thread.
const PROCESS_NICENESS = '10';
// Two decoder threads bound local CPU use.
const DECODE_THREADS = '2';
// One filter thread avoids extra parallel scaling work.
const FILTER_THREADS = '1';
// Bound decode diagnostics without changing the reason returned to the workflow.
const DECODE_ERROR_CHARS = 180;

// Round seconds to milliseconds for the serialised metadata.
const round = (n) => Math.round(n * TIME_PRECISION) / TIME_PRECISION;
// Share the engine's local slot when available, so decoders respect its concurrency limit.
const local = (ctx, task) => (ctx.withLocalSlot ? ctx.withLocalSlot(task) : task());
// Cancellation must propagate rather than become a cached decode failure.
const fatal = (ctx, err) => ctx.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';

// Run low-priority ffmpeg work with the workflow cancellation signal.
async function run(ctx, args) {
  return ffmpeg.runProcess('nice', ['-n', PROCESS_NICENESS, ffmpeg.binaries().ffmpeg, ...args], { signal: ctx.signal });
}

// Decode small grey samples at a bounded rate (frames/s), keeping even dimensions for ffmpeg.
function decodeArgs({ file, rawFile, seconds, width, height, photo }) {
  const rate = Math.max(SAMPLE_MIN_FPS, Math.min(SAMPLE_MAX_FPS, SAMPLE_TARGET / Math.max(1, seconds)));
  // A photo is decoded larger: the faces of a wide shot (a speaker at a lectern, an audience) are only a few px on the 320 px grid and the face
  // finder needs 24 px; frames.js measures sharpness and light on a 320 px copy of it, so the quality thresholds stay the same for both kinds.
  const gridWidth = photo ? PHOTO_GRID_WIDTH_PX : GRID_WIDTH_PX;
  const gridHeight = Math.max(2, Math.round(((height / width) * gridWidth) / 2) * 2);
  const args = [
    '-nostdin', '-v', 'error', '-y', '-threads', DECODE_THREADS, ...(seconds >= KEYFRAME_ONLY_SECONDS ? ['-skip_frame', 'nokey'] : []),
    '-i', file, '-an', '-filter_threads', FILTER_THREADS, '-vf',
    `${photo ? '' : `fps=${rate},`}scale=${gridWidth}:${gridHeight},format=gray`, ...(photo ? ['-frames:v', '1'] : []), '-f',
    'rawvideo', '-pix_fmt', 'gray', rawFile
  ];
  return { args, width: gridWidth, height: gridHeight, rate };
}

// Preserve display dimensions (px), duration (s), fps and source tags from the single probe.
function probeMeta(data, probe, exif, photo) {
  const stream = data.streams.find((s) => s.codec_type === 'video');
  const side = stream.side_data_list?.find((s) => s.rotation !== undefined);
  const angle = Number(side?.rotation ?? stream.tags?.rotate ?? 0);
  const rotation = photo ? exif.rotation : ((Math.round(angle) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const created = stream.tags?.creation_time || data.format?.tags?.creation_time;
  return {
    seconds: photo ? 0 : round(probe.duration),
    width: swap ? stream.height : stream.width,
    height: swap ? stream.width : stream.height,
    fps: photo ? 0 : probe.video.fps,
    rotation,
    hdr: ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer),
    has_audio: photo ? false : Boolean(probe.audio),
    taken_at: photo ? exif.taken_at : created && Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : null
  };
}

// Analyse one asset into info v1, caching deterministic failures and always releasing scratch files.
async function analyzeMedia(ctx, file, { kind = 'video', visionModel = DEFAULT_MODEL, speech = 'auto' } = {}) {
  const photo = kind === 'photo' || kind === 'image';
  const id = String(ctx.assetId || path.basename(file));
  let meta = null;
  // Keep every deterministic rejection in the same v1 shape, including metadata already read.
  const unusable = (reason) => ({
    version: 1,
    id,
    kind: photo ? 'photo' : 'video',
    usable: false,
    reason,
    meta,
    scenes: [],
    speech: null,
    vision: null
  });
  const ext = path.extname(file).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    ctx.log?.('HEIC is not supported yet; export this photo as JPEG or PNG.');
    return unusable('heic');
  }
  if (!(photo ? PHOTO_EXTS : VIDEO_EXTS).has(ext)) return unusable('unsupported_format');
  const scratch = ctx.eventVideo?.scratchRoot
    ? await fs.mkdtemp(path.join(ctx.eventVideo.scratchRoot, 'event-analysis-'))
    : await require('../nodes/assets').createScratchDir(ctx.sessionId);
  try {
    let decoded;
    try {
      decoded = await local(ctx, async () => {
        const exif = photo ? await readExif(file) : null;
        // Use probeMedia's normaliser on one probe, also retaining HDR and creation tags locally.
        // Allow a synthetic probe in tests; production retains the original ffprobe JSON.
        const probeCall =
          ctx.eventVideo?.probe ||
          (async () => {
            const answer = await ffmpeg.runProcess(
              ffmpeg.binaries().ffprobe,
              ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
              { signal: ctx.signal }
            );
            return JSON.parse(answer.stdout);
          });
        const data = await probeCall(file);
        const probe = ops.normaliseMediaProbe(data);
        if (!probe.video) return { reason: 'no_video_stream' };
        if (!photo && !(probe.duration > 0 && probe.video.fps > 0)) return { reason: 'decode_failed' };
        meta = probeMeta(data, probe, exif, photo);
        if (!photo && meta.seconds > LIMITS.videoSeconds) return { reason: 'too_long' };
        if (![0, 90, 180, 270].includes(meta.rotation) || !(meta.width > 0 && meta.height > 0)) return { reason: 'decode_failed' };
        let input = file;
        if (photo) {
          input = path.join(scratch, 'photo.png');
          // JPEG's reduced decoder bounds memory before the scale filter sees a 24 MP picture.
          const lowres = ['.jpg', '.jpeg'].includes(ext)
            ? Math.min(JPEG_MAX_LOWRES, Math.max(0, Math.floor(Math.log2(Math.max(meta.width, meta.height) / PHOTO_MAX_SIDE_PX))))
            : 0;
          await run(ctx, [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-threads',
            DECODE_THREADS,
            '-noautorotate',
            ...(lowres ? ['-lowres', String(lowres)] : []),
            '-i',
            file,
            '-filter_threads',
            FILTER_THREADS,
            '-vf',
            [
              ...orientationFilters(exif.orientation),
              `scale=w=min(${PHOTO_MAX_SIDE_PX}\\,iw):h=min(${PHOTO_MAX_SIDE_PX}\\,ih):force_original_aspect_ratio=decrease`
            ].join(','),
            '-frames:v',
            '1',
            '-threads',
            DECODE_THREADS,
            input
          ]);
        }
        const rawFile = path.join(scratch, 'frames.gray');
        const pgm = path.join(scratch, 'sheet.pgm');
        const built = decodeArgs({ file: input, rawFile, ...meta, photo });
        await run(ctx, built.args);
// The scan hashes each scene's first frame (the full decoded image for a photo).
        const scanned = await scanInWorker(
          { file: rawFile, sheetFile: pgm, width: built.width, height: built.height, seconds: meta.seconds, rate: built.rate, photo },
          { signal: ctx.signal }
        );
        const sheet = path.join(scratch, 'sheet.png');
        await run(ctx, [
          '-nostdin', '-v', 'error', '-y', '-threads', DECODE_THREADS, '-i', photo ? input : pgm, '-frames:v', '1', '-threads',
          DECODE_THREADS, sheet
        ]);
        return { ...scanned, sheet };
      });
    } catch (err) {
      if (fatal(ctx, err)) throw err;
      ctx.log?.(`Media decode failed: ${String(err.message).slice(0, DECODE_ERROR_CHARS)}`);
      return unusable('decode_failed');
    }
    if (decoded.reason) return unusable(decoded.reason);
    // Run speech first so a failing transcription does not pay for vision on every retry.
    let spoken;
    try {
      spoken = await analyzeSpeech(ctx, file, { seconds: meta.seconds, scratch, hasAudio: meta.has_audio, mode: speech });
    } catch (err) {
      if (!fatal(ctx, err) && err.decodeFailed) return unusable('decode_failed');
      throw err;
    }
    const seen = await analyzeVision(ctx, decoded.sheet, { model: visionModel, kind: photo ? 'photo' : 'video', scenes: decoded.scenes });
    const info = {
      version: 1,
      id,
      kind: photo ? 'photo' : 'video',
      usable: true,
      reason: null,
      meta,
      scenes: decoded.scenes,
      speech: spoken.speech,
      vision: seen.vision
    };
    const checked = checkInfo(info);
    if (!checked.ok) throw Object.assign(new Error(checked.problems.join('; ')), { code: 'EVENTMEDIA_VISION_FAILED' });
    const sheet = ctx.saveOutputFile
      ? await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: decoded.sheet, prompt: 'Event keyframes', cost: 0 })
      : null;
    const cost = [spoken.usd, seen.usd].filter((usd) => typeof usd === 'number');
    // Adapter-only fields do not change info v1 or its JSON representation.
    Object.defineProperties(info, {
      sheet: { value: sheet },
      cost: { value: cost.length ? { usd: cost.reduce((a, b) => a + b, 0) } : undefined }
    });
    ctx.log?.(`Analyzed ${decoded.frames} frames, ${info.scenes.length} scenes, ${meta.width}x${meta.height}`);
    return info;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

module.exports = { analyzeMedia, decodeArgs, probeMeta };
