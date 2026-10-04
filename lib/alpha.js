'use strict';

// Does a stored media file have visible transparency? The store asks this once for every file it saves (WP33c): a PNG or WebP
// image, or a WebM / MKV / MOV video. The answer decides whether the ledger entry is marked `alpha: true`, which makes the node
// view show a chequerboard behind the result. Nothing in here throws: a file that cannot be read, a missing ffmpeg or a timeout
// is the answer "no" (or, for an image without ffmpeg, the answer of the header), and saving goes on.
//
//   - Image (PNG, WebP): the header says whether the format carries an alpha channel (PNG colour type 4 or 6, or a tRNS chunk;
//     WebP VP8X alpha flag, or the alpha bit of VP8L). Many generators write RGBA PNGs in which every pixel is opaque, so when an
//     ffmpeg is there it also looks at the pixels (alphaextract + signalstats: the lowest alpha value must be below 255). Without
//     ffmpeg, or without those two filters, the header alone counts. An ffmpeg that fails on the file gives no mark.
//   - Video (WebM, MKV, MOV): ffprobe and ffmpeg.streamHasAlpha. MP4 is never looked at. Without ffprobe: no mark.
//   - Everything else (JPEG, GIF, MP4, audio, ...) is not looked at at all: no read, no process.

const fsp = require('fs/promises');

const ffmpeg = require('./ffmpeg');

const IMAGE_EXTS = new Set(['.png', '.webp']);
const VIDEO_EXTS = new Set(['.webm', '.mkv', '.mov']);
const IMAGE_CHECK_TIMEOUT_MS = 15000;
const VIDEO_PROBE_TIMEOUT_MS = 20000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The chunks of a PNG before the first IDAT are walked one header at a time; a file with more than this many is not a normal PNG.
const MAX_PNG_CHUNKS = 64;

// True for the extensions that are looked at (lower case, with the dot).
function isCandidateExtension(ext) {
  const clean = String(ext || '').toLowerCase();
  return IMAGE_EXTS.has(clean) || VIDEO_EXTS.has(clean);
}

/* ---------- headers ---------- */

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

// PNG: colour type 4 (grey + alpha) or 6 (RGBA) in IHDR, or a tRNS chunk (transparency for grey, RGB or palette) before the image data.
async function pngHeaderAlpha(handle) {
  const head = await readAt(handle, 0, 33);
  if (head.length < 33 || !head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString('ascii', 12, 16) !== 'IHDR') return false;
  const colorType = head[25];
  if (colorType === 4 || colorType === 6) return true;
  let position = 8 + 12 + head.readUInt32BE(8); // after the IHDR chunk (length, type, data, crc)
  for (let count = 0; count < MAX_PNG_CHUNKS; count += 1) {
    const chunk = await readAt(handle, position, 8);
    if (chunk.length < 8) return false;
    const type = chunk.toString('ascii', 4, 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    position += 12 + chunk.readUInt32BE(0);
  }
  return false;
}

// WebP: VP8X has an alpha flag (bit 4 of the flags byte); a lossless VP8L stream has an alpha_is_used bit after the two 14-bit sizes;
// a plain lossy VP8 stream has no alpha.
async function webpHeaderAlpha(handle) {
  const head = await readAt(handle, 0, 30);
  if (head.length < 21 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') return false;
  const type = head.toString('ascii', 12, 16);
  if (type === 'VP8X') return (head[20] & 0x10) !== 0;
  if (type === 'VP8L') return head.length >= 25 && head[20] === 0x2f && ((head[24] >> 4) & 1) === 1;
  return false;
}

// Whether the header of an image file says it has an alpha channel. False for any other extension and for a file that cannot be read.
async function imageHeaderAlpha(file, ext) {
  const clean = String(ext || '').toLowerCase();
  if (!IMAGE_EXTS.has(clean)) return false;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    return clean === '.png' ? await pngHeaderAlpha(handle) : await webpHeaderAlpha(handle);
  } catch (_) {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/* ---------- pixels ---------- */

// Whether at least one pixel of the first frame is not opaque: true or false, null when ffmpeg could not tell.
async function imageHasTransparentPixel(file, { ffmpegPath, timeoutMs = IMAGE_CHECK_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await ffmpeg.runProcess(
      ffmpegPath,
      [
        '-v', 'error', '-nostdin', '-i', file, '-frames:v', '1',
        '-vf', 'format=rgba,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
        '-f', 'null', '-'
      ],
      { timeoutMs }
    );
    const match = /lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/.exec(String(stdout || ''));
    if (!match) return null;
    return Number(match[1]) < 255;
  } catch (_) {
    return null;
  }
}

// An image with visible transparency: the header first (it costs a few bytes), then, with an ffmpeg that has the two filters,
// the pixels. Without that ffmpeg the header alone counts; an ffmpeg that fails gives no mark.
async function imageHasAlpha(file, ext, { binaries } = {}) {
  if (!(await imageHeaderAlpha(file, ext))) return false;
  const paths = binaries || ffmpeg.binaries();
  const command = paths.ffmpeg;
  if (!command || !ffmpeg.hasFilter('alphaextract', { ffmpegPath: command }) || !ffmpeg.hasFilter('signalstats', { ffmpegPath: command })) return true;
  return (await imageHasTransparentPixel(file, { ffmpegPath: command })) === true;
}

// A video with an alpha channel: ffprobe and the rule of ffmpeg.streamHasAlpha (VP8 / VP9 with alpha_mode, a pixel format with alpha).
async function videoHasAlpha(file, { binaries } = {}) {
  try {
    const paths = binaries || ffmpeg.binaries();
    if (!paths.ffprobe) return false;
    const { stdout } = await ffmpeg.runProcess(paths.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file], {
      timeoutMs: VIDEO_PROBE_TIMEOUT_MS
    });
    return ffmpeg.streamHasAlpha((JSON.parse(stdout).streams || [])[0]);
  } catch (_) {
    return false;
  }
}

// The one entry point of the store: whether the stored file has visible transparency. Never throws.
async function detectAlpha(file, ext, options = {}) {
  try {
    const clean = String(ext || '').toLowerCase();
    if (IMAGE_EXTS.has(clean)) return await imageHasAlpha(file, clean, options);
    if (VIDEO_EXTS.has(clean)) return await videoHasAlpha(file, options);
  } catch (_) {
    /* no mark */
  }
  return false;
}

module.exports = {
  IMAGE_EXTS,
  VIDEO_EXTS,
  isCandidateExtension,
  imageHeaderAlpha,
  imageHasTransparentPixel,
  imageHasAlpha,
  videoHasAlpha,
  detectAlpha
};
