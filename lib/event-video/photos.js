'use strict';

const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
const { readExif } = require('./exif');
const pending = new Map();
const TIMEOUT_MS = 60000;
const isHeic = (file) => ['.heic', '.heif'].includes(path.extname(file).toLowerCase());

// A small EXIF block preserves capture time while the converted pixels are already upright.
function dateHeader(takenAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2}|Z)?$/.exec(takenAt || '');
  if (!match) return Buffer.alloc(0);
  const tiff = Buffer.alloc(84);
  tiff.write('II');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(2, 26);
  for (const [at, tag, count, offset] of [[28, 0x9003, 20, 56], [40, 0x9011, 7, 76]]) {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(2, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(offset, at + 8);
  }
  tiff.write(`${match[1]}:${match[2]}:${match[3]} ${match[4]}\0`, 56);
  tiff.write(`${match[5] === 'Z' ? '+00:00' : match[5] || ''}\0`, 76);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(tiff.length + 8, 2);
  return Buffer.concat([head, Buffer.from('Exif\0\0'), tiff]);
}

// Convert once beside the immutable upload. Publish atomically and share simultaneous requests.
async function preparePhoto(file, { signal, runProcess = ffmpeg.runProcess } = {}) {
  if (!isHeic(file)) return file;
  if (pending.has(file)) return pending.get(file);
  const task = (async () => {
    const output = `${file}.jpg`;
    try {
      if ((await fs.stat(output)).size > 0) return output;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const scratch = await fs.mkdtemp(path.join(path.dirname(file), '.heic-'));
    const temp = path.join(scratch, 'photo.jpg');
    try {
      const exif = await readExif(file);
      const attempts = [
        [ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', file, '-frames:v', '1', '-q:v', '2', temp]],
        ['magick', [file + '[0]', '-auto-orient', '-quality', '95', temp]],
        ['convert', [file + '[0]', '-auto-orient', '-quality', '95', temp]]
      ];
      for (const [command, args] of attempts) {
        try {
          await fs.rm(temp, { force: true });
          await runProcess(command, args, { timeoutMs: TIMEOUT_MS, signal });
          const jpeg = await fs.readFile(temp);
          if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('Converter returned no JPEG');
          const convertedExif = await readExif(temp);
          const header = dateHeader(exif.taken_at || convertedExif.taken_at);
          if (header.length) await fs.writeFile(temp, Buffer.concat([jpeg.subarray(0, 2), header, jpeg.subarray(2)]));
          await fs.rename(temp, output);
          return output;
        } catch (err) {
          if (signal?.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') throw err;
        }
      }
      throw new Error(`Das Foto «${path.basename(file)}» konnte nicht aus HEIC/HEIF in JPEG umgewandelt werden. Benötigt wird ffmpeg mit HEIF-Unterstützung oder ImageMagick mit libheif. Exportiere das Foto sonst als JPEG.`);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  })();
  pending.set(file, task);
  try {
    return await task;
  } finally {
    pending.delete(file);
  }
}

module.exports = { isHeic, preparePhoto, dateHeader };
