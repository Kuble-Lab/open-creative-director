#!/usr/bin/env node
'use strict';

// Developer tool (not a test): cuts a TrueType font down to the characters the HUD of the music video uses (lib/music-video-hud/), so that the
// fonts, embedded as base64 in every chunk, stay small (the render node takes at most 2 MB of HTML). No dependency: the glyph outlines of the
// characters that are kept stay as they are, every other glyph becomes empty, `cmap` lists only the kept characters, the glyph names are
// dropped and so is the layout (GSUB/GPOS/GDEF) unless --keep-layout is given (kerning of the display faces). A variable font (Montserrat) loses
// its axes unless --keep-variations is given: then fvar, avar, HVAR and MVAR stay and gvar keeps the changes of the kept glyphs only, so the one file
// holds every weight. The licence (SIL OFL 1.1) allows this; the folders in lib/fonts/ say where each file comes from.
//
//   node scripts/subset-font.js <in.ttf> <out.ttf> [--keep-layout] [--keep-variations] [--extra=<characters>]
//
// Kept: Basic Latin, Latin-1 Supplement, Latin Extended-A, general punctuation, and the signs the HUD draws (x, middle dot, degree, triangle,
// bullet, check, arrows, minus). A character the font does not have is skipped.

const fs = require('fs');

const { readTables, readCmap } = require('../lib/music-video-hud/ttf');

const RANGES = [
  [0x20, 0x7e], [0xa0, 0xff], [0x100, 0x17f],
  [0x2010, 0x2015], [0x2018, 0x201e], [0x2020, 0x2022], [0x2026, 0x2026], [0x2030, 0x2030], [0x2032, 0x2033], [0x2039, 0x203a], [0x20ac, 0x20ac],
  [0x2190, 0x2193], [0x2212, 0x2212], [0x2260, 0x2260], [0x2264, 0x2265],
  [0x25a0, 0x25a0], [0x25b2, 0x25b2], [0x25b6, 0x25b6], [0x25bc, 0x25bc], [0x25c0, 0x25c0], [0x25cb, 0x25cb], [0x25cf, 0x25cf], [0x2713, 0x2713], [0x2715, 0x2715]
];

// the glyphs a composite glyph is made of
function components(glyph) {
  const found = [];
  if (glyph.length < 10 || glyph.readInt16BE(0) >= 0) return found;
  let at = 10;
  for (;;) {
    const flags = glyph.readUInt16BE(at);
    found.push(glyph.readUInt16BE(at + 2));
    at += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) at += 2;
    else if (flags & 0x0040) at += 4;
    else if (flags & 0x0080) at += 8;
    if (!(flags & 0x0020)) break;
  }
  return found;
}

// `cmap` with one format 4 subtable (BMP) for the kept characters
function buildCmap(codes) {
  const sorted = [...codes.keys()].filter((code) => code < 0xffff).sort((a, b) => a - b);
  const segments = [];
  for (const code of sorted) {
    const last = segments[segments.length - 1];
    if (last && code === last.end + 1 && codes.get(code) === last.glyphs[last.glyphs.length - 1] + 1) {
      last.end = code;
      last.glyphs.push(codes.get(code));
    } else segments.push({ start: code, end: code, glyphs: [codes.get(code)] });
  }
  segments.push({ start: 0xffff, end: 0xffff, glyphs: [0], last: true });
  const count = segments.length;
  const body = Buffer.alloc(16 + count * 8);
  body.writeUInt16BE(4, 0);
  body.writeUInt16BE(body.length, 2);
  body.writeUInt16BE(0, 4);
  body.writeUInt16BE(count * 2, 6);
  const power = 2 ** Math.floor(Math.log2(count));
  body.writeUInt16BE(power * 2, 8);
  body.writeUInt16BE(Math.log2(power), 10);
  body.writeUInt16BE(count * 2 - power * 2, 12);
  segments.forEach((segment, index) => {
    body.writeUInt16BE(segment.end, 14 + index * 2);
    body.writeUInt16BE(segment.start, 16 + count * 2 + index * 2);
    body.writeInt16BE(segment.last ? 1 : (segment.glyphs[0] - segment.start) << 16 >> 16, 16 + count * 4 + index * 2);
    body.writeUInt16BE(0, 16 + count * 6 + index * 2);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, body]);
}

const pad4 = (buffer) => (buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer);

function checksum(buffer) {
  const padded = pad4(buffer);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

// `gvar` (the changes of the outlines along the axes) with the data of the kept glyphs only: the others get no data (an offset as large as the next
// one). The shared tuples stay as they are, the data of a glyph refers to them by number. Offsets are written as 32 bit numbers.
function filterGvar(gvar, kept, glyphCount) {
  const axisCount = gvar.readUInt16BE(4);
  const sharedCount = gvar.readUInt16BE(6);
  const sharedAt = gvar.readUInt32BE(8);
  const count = gvar.readUInt16BE(12);
  const long = (gvar.readUInt16BE(14) & 1) === 1;
  const dataAt = gvar.readUInt32BE(16);
  if (count !== glyphCount) throw new Error(`gvar has ${count} glyphs, the font has ${glyphCount}`);
  const offsetOf = (index) => (long ? gvar.readUInt32BE(20 + index * 4) : gvar.readUInt16BE(20 + index * 2) * 2);
  const shared = gvar.subarray(sharedAt, sharedAt + sharedCount * axisCount * 2);
  const headerSize = 20 + (count + 1) * 4;
  const offsets = [];
  const pieces = [];
  let size = 0;
  for (let glyph = 0; glyph < count; glyph += 1) {
    offsets.push(size);
    if (!kept.has(glyph)) continue;
    const data = gvar.subarray(dataAt + offsetOf(glyph), dataAt + offsetOf(glyph + 1));
    if (!data.length) continue;
    const padded = pad4(data);
    pieces.push(padded);
    size += padded.length;
  }
  offsets.push(size);
  const header = Buffer.alloc(headerSize);
  gvar.copy(header, 0, 0, 20);
  header.writeUInt32BE(headerSize, 8);
  header.writeUInt16BE(1, 14);
  header.writeUInt32BE(headerSize + shared.length, 16);
  offsets.forEach((offset, index) => header.writeUInt32BE(offset, 20 + index * 4));
  return Buffer.concat([header, shared, ...pieces]);
}

function subset(input, { keepLayout = false, keepVariations = false, extra = '' } = {}) {
  const tables = readTables(input);
  for (const need of ['head', 'maxp', 'loca', 'glyf', 'cmap', 'hhea', 'hmtx']) if (!tables.has(need)) throw new Error(`the font has no ${need} table (not a TrueType font with outlines)`);
  const head = Buffer.from(tables.get('head'));
  const longLoca = head.readInt16BE(50) === 1;
  const glyphCount = tables.get('maxp').readUInt16BE(4);
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const offsetOf = (glyph) => (longLoca ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2);
  const glyphData = (glyph) => glyf.subarray(offsetOf(glyph), offsetOf(glyph + 1));

  const all = readCmap(tables.get('cmap'));
  const wanted = new Set();
  for (const [from, to] of RANGES) for (let code = from; code <= to; code += 1) wanted.add(code);
  for (const char of extra) wanted.add(char.codePointAt(0));
  const kept = new Map();
  for (const code of wanted) if (all.has(code)) kept.set(code, all.get(code));

  // the glyphs that stay: .notdef, those of the kept characters and the parts of the composite ones
  const glyphs = new Set();
  const queue = [0, ...kept.values()];
  while (queue.length) {
    const glyph = queue.pop();
    if (glyph >= glyphCount || glyphs.has(glyph)) continue;
    glyphs.add(glyph);
    queue.push(...components(glyphData(glyph)));
  }
  const pieces = [];
  const offsets = [];
  let size = 0;
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    offsets.push(size);
    if (glyphs.has(glyph)) {
      const data = pad4(glyphData(glyph));
      pieces.push(data);
      size += data.length;
    }
  }
  offsets.push(size);
  const newLoca = Buffer.alloc(offsets.length * 4);
  offsets.forEach((offset, index) => newLoca.writeUInt32BE(offset, index * 4));
  head.writeInt16BE(1, 50);
  head.writeUInt32BE(0, 8);

  const post = Buffer.alloc(32);
  if (tables.has('post')) tables.get('post').copy(post, 4, 4, 32);
  post.writeUInt32BE(0x00030000, 0);

  const out = new Map();
  for (const [tag, data] of tables) {
    if (['glyf', 'loca', 'head', 'cmap', 'post', 'GSUB', 'GDEF', 'DSIG', 'kern', 'hdmx', 'LTSH', 'VDMX', 'meta', 'STAT', 'FFTM', 'MATH', 'BASE', 'JSTF'].includes(tag)) continue;
    if (tag === 'GPOS' && !keepLayout) continue;
    if (/^(fvar|gvar|avar|HVAR|MVAR|cvar|STAT)$/.test(tag)) continue;
    out.set(tag, data);
  }
  if (keepVariations) {
    for (const tag of ['fvar', 'avar', 'HVAR', 'MVAR']) if (tables.has(tag)) out.set(tag, tables.get(tag));
    if (tables.has('gvar')) out.set('gvar', filterGvar(tables.get('gvar'), glyphs, glyphCount));
  }
  if (keepLayout && tables.has('GSUB')) out.set('GSUB', tables.get('GSUB'));
  if (keepLayout && tables.has('GDEF')) out.set('GDEF', tables.get('GDEF'));
  out.set('head', head);
  out.set('glyf', Buffer.concat(pieces));
  out.set('loca', newLoca);
  out.set('cmap', buildCmap(kept));
  out.set('post', post);

  const tags = [...out.keys()].sort();
  const count = tags.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(count * 16 - power * 16, 10);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, index) => {
    const data = out.get(tag);
    const at = 12 + index * 16;
    header.write(tag, at, 'latin1');
    header.writeUInt32BE(checksum(data), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    const padded = pad4(data);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  const headAt = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8);
  font.writeUInt32BE(adjustment, headAt + 8);
  return { font, glyphs: glyphs.size, glyphCount, characters: kept.size };
}

module.exports = { subset, RANGES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length !== 2) {
    console.error('Usage: node scripts/subset-font.js <in.ttf> <out.ttf> [--keep-layout] [--keep-variations] [--extra=<characters>]');
    process.exit(2);
  }
  const extra = (args.find((arg) => arg.startsWith('--extra=')) || '').slice(8);
  const result = subset(fs.readFileSync(files[0]), { keepLayout: args.includes('--keep-layout'), keepVariations: args.includes('--keep-variations'), extra });
  fs.writeFileSync(files[1], result.font);
  console.log(`${files[1]}: ${result.characters} characters, ${result.glyphs} of ${result.glyphCount} glyphs, ${result.font.length} bytes`);
}
