'use strict';

// Small preview images of session assets (lists, history strips, node cards, the gallery of the apps). A list of 100
// workflows otherwise loads every result in its original size: up to 6 MB per picture, 80 MB and more for one list.
// GET /assets/<session>/<file>?w=<width> answers with a copy of the image at most <width> pixels wide (WebP, which keeps
// the transparency; JPEG when this ffmpeg has no WebP encoder). The copies are made once by ffmpeg and kept in a cache
// folder outside the assets (cache/thumbs/ by default): not in the storage overview, not in the archive, not in the backups.
// When something goes wrong (no ffmpeg, an image ffmpeg cannot read) the caller sends the original instead.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ffmpeg = require('./ffmpeg');

// The widths a client may ask for: a fixed set, so nobody can fill the cache with a copy per pixel.
const WIDTHS = Object.freeze([96, 160, 320, 640]);
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 30000;

// The allowed width for a requested one: the next larger of WIDTHS (a request for 300 gets 320), null for no or a bad value.
function pickWidth(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return WIDTHS.find((width) => width >= n) || WIDTHS[WIDTHS.length - 1];
}

function isImageFile(name) {
  return IMAGE_FILE.test(String(name || ''));
}

function createThumbnailer({ assetsDir, cacheDir, ffmpegPath, maxParallel = MAX_PARALLEL, timeoutMs = TIMEOUT_MS } = {}) {
  let format = null; // { ext, args } chosen on first use
  const inFlight = new Map();
  const failed = new Map(); // target -> mtime of the original that ffmpeg could not read (not tried again)
  const waiting = [];
  let running = 0;

  function binary() {
    return ffmpegPath || ffmpeg.binaries().ffmpeg;
  }

  function outputFormat(command) {
    if (format) return format;
    format = ffmpeg.hasEncoder('libwebp', { ffmpegPath: command })
      ? { ext: 'webp', type: 'image/webp', args: ['-c:v', 'libwebp', '-quality', '78', '-compression_level', '4'] }
      : { ext: 'jpg', type: 'image/jpeg', args: ['-q:v', '4'] };
    return format;
  }

  // Runs at most maxParallel ffmpeg processes at once: a long list must not start a hundred of them.
  function limited(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        running += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            const next = waiting.shift();
            if (next) next();
          });
      };
      if (running < maxParallel) start();
      else waiting.push(start);
    });
  }

  // relPath: the path below the assets folder ("<session>/<file>"), already checked by the caller (no "..", no escapes).
  // Returns { file, type } of the small copy, or null when there is none (not an image, the original is missing, ffmpeg failed).
  async function get(relPath, width) {
    const size = pickWidth(width);
    if (!size || !isImageFile(relPath)) return null;
    const source = path.join(assetsDir, relPath);
    if (!source.startsWith(path.resolve(assetsDir) + path.sep)) return null;
    let sourceStat;
    try {
      sourceStat = await fsp.stat(source);
    } catch (_) {
      return null;
    }
    if (!sourceStat.isFile()) return null;
    const command = binary();
    if (!command) return null;
    const { ext, type, args } = outputFormat(command);
    const target = path.join(cacheDir, `${relPath}.w${size}.${ext}`);
    try {
      const targetStat = await fsp.stat(target);
      if (targetStat.mtimeMs >= sourceStat.mtimeMs) return { file: target, type };
    } catch (_) {
      /* not made yet */
    }
    if (failed.get(target) === sourceStat.mtimeMs) return null;
    // Two requests for the same copy share one ffmpeg run.
    if (!inFlight.has(target)) {
      const job = limited(async () => {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.tmp.${ext}`;
        try {
          await ffmpeg.runProcess(command, [
            '-nostdin', '-v', 'error', '-i', source,
            '-vf', `scale=w='min(${size},iw)':h=-2:flags=lanczos`,
            '-frames:v', '1', ...args, '-y', temp
          ], { timeoutMs });
          await fsp.rename(temp, target);
          return { file: target, type };
        } catch (err) {
          await fsp.rm(temp, { force: true }).catch(() => {});
          throw err;
        }
      }).finally(() => inFlight.delete(target));
      inFlight.set(target, job);
    }
    try {
      return await inFlight.get(target);
    } catch (err) {
      if (failed.size > 5000) failed.clear();
      failed.set(target, sourceStat.mtimeMs);
      console.warn(`[thumbnails] ${relPath}: ${err.message}`);
      return null;
    }
  }

  return { get };
}

module.exports = { WIDTHS, pickWidth, isImageFile, createThumbnailer };
