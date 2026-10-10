'use strict';

// Read only the JPEG header; TIFF offsets are relative to the APP1 TIFF block.
const fs = require('fs/promises');
const ROTATIONS = [0, 0, 0, 180, 0, 90, 90, 270, 270];

function parseExif(jpeg) {
  const empty = { orientation: 1, rotation: 0, taken_at: null };
  try {
    if (jpeg.readUInt16BE(0) !== 0xffd8) return empty;
    for (let p = 2; p + 4 <= jpeg.length;) {
      if (jpeg[p] !== 0xff) break;
      const marker = jpeg[p + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = jpeg.readUInt16BE(p + 2);
      if (length < 2 || p + 2 + length > jpeg.length) break;
      if (marker === 0xe1 && jpeg.toString('ascii', p + 4, p + 10) === 'Exif\0\0') {
        const tiff = jpeg.subarray(p + 10, p + 2 + length);
        const little = tiff.toString('ascii', 0, 2) === 'II';
        if (!little && tiff.toString('ascii', 0, 2) !== 'MM') return empty;
        const u16 = (at) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
        const u32 = (at) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
        if (u16(2) !== 42) return empty;
        const tags = new Map();
        const read = (offset) => {
          const count = u16(offset);
          if (count > 1024 || offset + 2 + count * 12 > tiff.length) return;
          for (let i = 0; i < count; i += 1) {
            const at = offset + 2 + i * 12;
            const tag = u16(at), type = u16(at + 2), n = u32(at + 4);
            if (type === 3 && n === 1) tags.set(tag, u16(at + 8));
            if (type === 4 && n === 1) tags.set(tag, u32(at + 8));
            if (type === 2 && n > 0 && n <= 128) {
              const start = n <= 4 ? at + 8 : u32(at + 8);
              if (start + n <= tiff.length) tags.set(tag, tiff.toString('ascii', start, start + n).replace(/\0.*$/, ''));
            }
          }
        };
        read(u32(4));
        if (tags.has(0x8769)) read(tags.get(0x8769));
        const orientation = tags.get(0x112) >= 1 && tags.get(0x112) <= 8 ? tags.get(0x112) : 1;
        const date = tags.get(0x9003) || tags.get(0x9004) || tags.get(0x132);
        const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(date || '');
        // Without OffsetTimeOriginal keep local wall time, rather than inventing a UTC offset.
        const offset = /^[+-]\d{2}:\d{2}$/.test(tags.get(0x9011) || '') ? tags.get(0x9011) : '';
        const iso = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}${offset}` : null;
        return { orientation, rotation: ROTATIONS[orientation], taken_at: iso && Number.isFinite(Date.parse(iso)) ? iso : null };
      }
      p += length + 2;
    }
  } catch (_) { /* A truncated header has no readable EXIF. */ }
  return empty;
}

async function readExif(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return parseExif(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

// Disable ffmpeg autorotation for photos, then apply all eight EXIF transforms, including mirrors.
function orientationFilters(orientation) {
  return ({ 2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'], 5: ['transpose=clock', 'hflip'],
    6: ['transpose=clock'], 7: ['transpose=clock', 'vflip'], 8: ['transpose=cclock'] })[orientation] || [];
}

module.exports = { parseExif, readExif, orientationFilters };
