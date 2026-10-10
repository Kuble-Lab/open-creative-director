'use strict';

// Read only the JPEG header; TIFF offsets are relative to the APP1 TIFF block.
const fs = require('fs/promises');
// EXIF orientations 1..8 map to clockwise display rotation in degrees; mirrors are handled separately.
const ROTATIONS = [0, 0, 0, 180, 0, 90, 90, 270, 270];

// JPEG/TIFF layout constants come from their file formats, not media-quality heuristics.
const JPEG_SOI = 0xffd8;
// Prefix byte shared by JPEG segment markers.
const JPEG_MARKER_PREFIX = 0xff;
// Start-of-scan marker: compressed pixels follow, so stop header parsing.
const JPEG_SOS = 0xda;
// End-of-image marker: no further metadata follows.
const JPEG_EOI = 0xd9;
const JPEG_APP1 = 0xe1;
// Two bytes identify a JPEG marker; segment length includes its own two bytes.
const JPEG_MARKER_BYTES = 2;
// Marker and length occupy four bytes before the segment payload.
const JPEG_SEGMENT_HEADER_BYTES = 4;
// TIFF starts after the four-byte JPEG header and six-byte EXIF signature.
const EXIF_TIFF_OFFSET = 10;
// TIFF header signature defined by the format.
const TIFF_MAGIC = 42;
// Each TIFF directory entry occupies 12 bytes.
const TIFF_ENTRY_BYTES = 12;
// TIFF type ID for a two-byte unsigned integer.
const TIFF_SHORT = 3;
// TIFF type ID for a four-byte unsigned integer.
const TIFF_LONG = 4;
// TIFF type ID for a NUL-terminated ASCII string.
const TIFF_ASCII = 2;
// TIFF tags identify orientation, the EXIF sub-IFD and capture dates with an optional timezone offset.
const TAG_ORIENTATION = 0x112;
// TIFF pointer tag for the EXIF sub-directory.
const TAG_EXIF_IFD = 0x8769;
// EXIF tag for the original capture date.
const TAG_DATE_ORIGINAL = 0x9003;
// EXIF tag for the digitisation date, used as the next fallback.
const TAG_DATE_DIGITISED = 0x9004;
// TIFF modification date, used when neither EXIF capture date is present.
const TAG_DATE = 0x132;
// EXIF timezone offset accompanying the original date.
const TAG_OFFSET_ORIGINAL = 0x9011;
// Safety bounds: at most 1024 entries, 128 bytes per string and 256 KiB of JPEG header.
const MAX_IFD_ENTRIES = 1024;
// Bound metadata strings to 128 bytes before reading them.
const MAX_TAG_STRING_BYTES = 128;
// Read at most 256 KiB of a JPEG header to bound memory use.
const HEADER_READ_BYTES = 256 * 1024;
// All eight EXIF orientations are supported; malformed tags retain the unrotated default.
const MAX_ORIENTATION = 8;

// Read orientation and capture time without decoding pixels; malformed or truncated headers use defaults.
function parseExif(jpeg) {
  const empty = { orientation: 1, rotation: 0, taken_at: null };
  try {
    if (jpeg.readUInt16BE(0) !== JPEG_SOI) return empty;
    for (let p = JPEG_MARKER_BYTES; p + JPEG_SEGMENT_HEADER_BYTES <= jpeg.length;) {
      if (jpeg[p] !== JPEG_MARKER_PREFIX) break;
      const marker = jpeg[p + 1];
      if (marker === JPEG_SOS || marker === JPEG_EOI) break;
      const length = jpeg.readUInt16BE(p + JPEG_MARKER_BYTES);
      if (length < JPEG_MARKER_BYTES || p + JPEG_MARKER_BYTES + length > jpeg.length) break;
      if (marker === JPEG_APP1 && jpeg.toString('ascii', p + JPEG_SEGMENT_HEADER_BYTES, p + EXIF_TIFF_OFFSET) === 'Exif\0\0') {
        const tiff = jpeg.subarray(p + EXIF_TIFF_OFFSET, p + JPEG_MARKER_BYTES + length);
        const little = tiff.toString('ascii', 0, 2) === 'II';
        if (!little && tiff.toString('ascii', 0, 2) !== 'MM') return empty;
        // TIFF values use the byte order declared in this block.
        const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
        // Read TIFF offsets and LONG values with the same byte order.
        const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
        if (u16(2) !== TIFF_MAGIC) return empty;
        const tags = new Map();
        // Collect only scalar SHORT/LONG and bounded ASCII tags from one image directory.
        const read = (offset) => {
          const count = u16(offset);
          if (count > MAX_IFD_ENTRIES || offset + 2 + count * TIFF_ENTRY_BYTES > tiff.length) return;
          for (let i = 0; i < count; i += 1) {
            const at = offset + 2 + i * TIFF_ENTRY_BYTES;
            const tag = u16(at);
            const type = u16(at + 2);
            const n = u32(at + 4);
            if (type === TIFF_SHORT && n === 1) tags.set(tag, u16(at + 8));
            if (type === TIFF_LONG && n === 1) tags.set(tag, u32(at + 8));
            if (type === TIFF_ASCII && n > 0 && n <= MAX_TAG_STRING_BYTES) {
              const start = n <= 4 ? at + 8 : u32(at + 8);
              if (start + n <= tiff.length) tags.set(tag, tiff.toString('ascii', start, start + n).replace(/\0.*$/, ''));
            }
          }
        };
        read(u32(4));
        if (tags.has(TAG_EXIF_IFD)) read(tags.get(TAG_EXIF_IFD));
        const orientation = tags.get(TAG_ORIENTATION) >= 1 && tags.get(TAG_ORIENTATION) <= MAX_ORIENTATION ? tags.get(TAG_ORIENTATION) : 1;
        const date = tags.get(TAG_DATE_ORIGINAL) || tags.get(TAG_DATE_DIGITISED) || tags.get(TAG_DATE);
        const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(date || '');
        // Without OffsetTimeOriginal keep local wall time, rather than inventing a UTC offset.
        const offset = /^[+-]\d{2}:\d{2}$/.test(tags.get(TAG_OFFSET_ORIGINAL) || '') ? tags.get(TAG_OFFSET_ORIGINAL) : '';
        const iso = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}${offset}` : null;
        return { orientation, rotation: ROTATIONS[orientation], taken_at: iso && Number.isFinite(Date.parse(iso)) ? iso : null };
      }
      p += length + JPEG_MARKER_BYTES;
    }
  } catch (_) {
    /* A truncated header has no readable EXIF. */
  }
  return empty;
}

// Read a bounded header so large photos do not require loading their full compressed file.
async function readExif(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return parseExif(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// Disable ffmpeg autorotation for photos, then apply all eight EXIF transforms, including mirrors.
function orientationFilters(orientation) {
  return (
    {
      2: ['hflip'],
      3: ['hflip', 'vflip'],
      4: ['vflip'],
      5: ['transpose=clock', 'hflip'],
      6: ['transpose=clock'],
      7: ['transpose=clock', 'vflip'],
      8: ['transpose=cclock']
    }[orientation] || []
  );
}

module.exports = { parseExif, readExif, orientationFilters };
