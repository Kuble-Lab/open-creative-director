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
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const round = (n) => Math.round(n * 1000) / 1000;
const local = (ctx, task) => ctx.withLocalSlot ? ctx.withLocalSlot(task) : task();
const fatal = (ctx, err) => ctx.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';

async function run(ctx, args) {
  return ffmpeg.runProcess('nice', ['-n', '10', ffmpeg.binaries().ffmpeg, ...args], { signal: ctx.signal });
}

function decodeArgs({ file, rawFile, seconds, width, height, photo }) {
  const rate = Math.max(1, Math.min(5, 1200 / Math.max(1, seconds)));
  const gridWidth = 320, gridHeight = Math.max(2, Math.round(height / width * gridWidth / 2) * 2);
  const args = ['-nostdin', '-v', 'error', '-y', '-threads', '2', ...(seconds >= 300 ? ['-skip_frame', 'nokey'] : []), '-i', file,
    '-an', '-filter_threads', '1', '-vf', `${photo ? '' : `fps=${rate},`}scale=${gridWidth}:${gridHeight},format=gray`,
    ...(photo ? ['-frames:v', '1'] : []), '-f', 'rawvideo', '-pix_fmt', 'gray', rawFile];
  return { args, width: gridWidth, height: gridHeight, rate };
}

function probeMeta(data, probe, exif, photo) {
  const stream = data.streams.find((s) => s.codec_type === 'video');
  const side = stream.side_data_list?.find((s) => s.rotation !== undefined);
  const angle = Number(side?.rotation ?? stream.tags?.rotate ?? 0);
  const rotation = photo ? exif.rotation : ((Math.round(angle) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const created = stream.tags?.creation_time || data.format?.tags?.creation_time;
  return { seconds: photo ? 0 : round(probe.duration), width: swap ? stream.height : stream.width,
    height: swap ? stream.width : stream.height, fps: photo ? 0 : probe.video.fps,
    rotation, hdr: ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer), has_audio: photo ? false : Boolean(probe.audio),
    taken_at: photo ? exif.taken_at : created && Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : null };
}

async function analyzeMedia(ctx, file, { kind = 'video', visionModel = DEFAULT_MODEL, speech = 'auto' } = {}) {
  const photo = kind === 'photo' || kind === 'image';
  const id = String(ctx.assetId || path.basename(file));
  let meta = null;
  const unusable = (reason) => ({ version: 1, id, kind: photo ? 'photo' : 'video', usable: false, reason, meta, scenes: [], speech: null, vision: null });
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
        const probeCall = ctx.eventVideo?.probe || (async () => {
          const answer = await ffmpeg.runProcess(ffmpeg.binaries().ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal: ctx.signal });
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
          const lowres = ['.jpg', '.jpeg'].includes(ext) ? Math.min(2, Math.max(0, Math.floor(Math.log2(Math.max(meta.width, meta.height) / 1600)))) : 0;
          await run(ctx, ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-noautorotate', ...(lowres ? ['-lowres', String(lowres)] : []), '-i', file,
            '-filter_threads', '1', '-vf', [...orientationFilters(exif.orientation), 'scale=w=min(1600\\,iw):h=min(1600\\,ih):force_original_aspect_ratio=decrease'].join(','),
            '-frames:v', '1', '-threads', '2', input]);
        }
        const rawFile = path.join(scratch, 'frames.gray'), pgm = path.join(scratch, 'sheet.pgm');
        const built = decodeArgs({ file: input, rawFile, ...meta, photo });
        await run(ctx, built.args);
        const scanned = await scanInWorker({ file: rawFile, sheetFile: pgm, width: built.width, height: built.height,
          seconds: meta.seconds, rate: built.rate, photo }, { signal: ctx.signal });
        const sheet = path.join(scratch, 'sheet.png');
        await run(ctx, ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', photo ? input : pgm, '-frames:v', '1', '-threads', '2', sheet]);
        return { ...scanned, sheet };
      });
    } catch (err) {
      if (fatal(ctx, err)) throw err;
      ctx.log?.(`Media decode failed: ${String(err.message).slice(0, 180)}`);
      return unusable('decode_failed');
    }
    if (decoded.reason) return unusable(decoded.reason);
    // Run speech first so a failing transcription does not pay for vision on every retry.
    let spoken;
    try { spoken = await analyzeSpeech(ctx, file, { seconds: meta.seconds, scratch, hasAudio: meta.has_audio, mode: speech }); }
    catch (err) {
      if (!fatal(ctx, err) && err.decodeFailed) return unusable('decode_failed');
      throw err;
    }
    const seen = await analyzeVision(ctx, decoded.sheet, { model: visionModel, kind: photo ? 'photo' : 'video', scenes: decoded.scenes });
    const info = { version: 1, id, kind: photo ? 'photo' : 'video', usable: true, reason: null, meta,
      scenes: decoded.scenes, speech: spoken.speech, vision: seen.vision };
    const checked = checkInfo(info);
    if (!checked.ok) throw Object.assign(new Error(checked.problems.join('; ')), { code: 'EVENTMEDIA_VISION_FAILED' });
    const sheet = ctx.saveOutputFile ? await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: decoded.sheet, prompt: 'Event keyframes', cost: 0 }) : null;
    const cost = [spoken.usd, seen.usd].filter((usd) => typeof usd === 'number');
    // Adapter-only fields do not change info v1 or its JSON representation.
    Object.defineProperties(info, { sheet: { value: sheet }, cost: { value: cost.length ? { usd: cost.reduce((a, b) => a + b, 0) } : undefined } });
    ctx.log?.(`Analyzed ${decoded.frames} frames, ${info.scenes.length} scenes, ${meta.width}x${meta.height}`);
    return info;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

module.exports = { analyzeMedia, decodeArgs, probeMeta };
