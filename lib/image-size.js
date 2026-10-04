'use strict';

// Width and height of a raster image from its first bytes (PNG, JPEG, WebP, GIF). Nothing is decoded and no tool is started, so
// the check is free and can run before a paid call. The EXIF rotation of a JPEG is not applied. An unreadable file answers null.

const fsp = require('fs/promises');

const HEADER_BYTES = 256 * 1024;

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifSize(buffer) {
  if (buffer.length < 10 || !/^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // start of frame (not DHT 0xc4, JPG 0xc8, DAC 0xcc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (kind === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function imageSizeOf(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const size = pngSize(buffer) || jpegSize(buffer) || webpSize(buffer) || gifSize(buffer);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

async function imageSizeOfFile(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return imageSizeOf(buffer.subarray(0, bytesRead));
  } catch (_) {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { imageSizeOf, imageSizeOfFile };
