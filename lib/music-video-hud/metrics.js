'use strict';

// How wide a text is in the faces of the HUD, so that the layout (lib/music-video-hud/graphics.js) can size the big words and stack the
// devices without a browser. The numbers come from the font files in lib/fonts/ (advance widths of the characters, in em); a character the
// font does not hold counts as its average width. Kerning is not measured (the error is a few per cent at most; the layout keeps room for it).
//   anton   the big words and numbers (Anton)
//   serif   the quiet lines (Instrument Serif Italic)
//   mono    labels, tables, tags (JetBrains Mono: every character 0.6 em wide)
//   sans    the karaoke line and the chat bubbles (Inter Tight Bold, a variable font that is not read here: a fixed average)
//   mont6, mont8, mont9   the Kuble style: Montserrat at the weights 600, 800 and 900 (one variable font, read at the weight: lib/music-video-hud/ttf.js).
//                         The digits of these faces stand in cells of one width (the widest digit): see `cell` and the style sheet of the style, so
//                         a number that rolls or runs does not change its width.
// The faces of the event video (WP53, lib/event-video/composition.js) are named by family and weight ("Montserrat:700", "Playfair Display:600:italic",
// see lib/event-video/contract.js) and measured by familyWidth(); load() and textWidth() of the HUD are not touched by them. EVENT_FAMILIES says which
// file stands for which family; a family whose file is missing is drawn and measured in the face named in `fallback`. DM Sans has an axis of the
// optical size (opsz 9 to 40): the browser sets it to the size of the text in px (font-optical-sizing auto), so its widths are read at that size.

const fs = require('fs');
const path = require('path');

const ttf = require('./ttf');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FILES = Object.freeze({
  anton: path.join(FONT_DIR, 'anton', 'Anton-Regular.ttf'),
  serif: path.join(FONT_DIR, 'instrument-serif', 'InstrumentSerif-Italic.ttf'),
  mono: path.join(FONT_DIR, 'jetbrains-mono', 'JetBrainsMono-Bold.ttf')
});
// Montserrat, the weights of the faces of the Kuble style
const VARIABLE = Object.freeze({
  mont6: { file: path.join(FONT_DIR, 'montserrat', 'Montserrat-Variable.ttf'), wght: 600 },
  mont8: { file: path.join(FONT_DIR, 'montserrat', 'Montserrat-Variable.ttf'), wght: 800 },
  mont9: { file: path.join(FONT_DIR, 'montserrat', 'Montserrat-Variable.ttf'), wght: 900 }
});
// Inter Tight Bold, measured on the English sentences of the HUD: 0.5 em on average
const SANS_ADVANCE = 0.5;

let cached = null;

function tableOf(metrics, cells) {
  const advances = {};
  let sum = 0;
  let count = 0;
  for (const [code, advance] of metrics.advances) {
    if (code < 32 || code > 0x2715) continue;
    advances[String.fromCodePoint(code)] = Math.round(advance * 1000) / 1000;
    if (code >= 33 && code <= 126) {
      sum += advance;
      count += 1;
    }
  }
  const entry = { advances, average: Math.round((sum / Math.max(1, count)) * 1000) / 1000, capHeight: Math.round(metrics.capHeight * 1000) / 1000 };
  // the width of the cell of a digit: the widest of the ten (they are not of one width in Montserrat)
  if (cells) entry.cell = Math.max(...'0123456789'.split('').map((digit) => advances[digit] || 0));
  return entry;
}

function load() {
  if (cached) return cached;
  const table = {};
  for (const [name, file] of Object.entries(FILES)) table[name] = tableOf(ttf.readMetrics(fs.readFileSync(file)), false);
  for (const [name, face] of Object.entries(VARIABLE)) table[name] = tableOf(ttf.readMetrics(fs.readFileSync(face.file), { wght: face.wght }), true);
  table.sans = { advances: {}, average: SANS_ADVANCE, capHeight: 0.727 };
  cached = table;
  return table;
}

// The width in px of `text` set in `face` at `size` px with `tracking` em of letter-spacing (the CSS letter-spacing is added after every character).
// A face with digit cells (Montserrat) counts every digit as the cell: `cells` false measures the digits at their own widths (the words, where the
// digits stand in the text as they are).
function textWidth(face, text, size, tracking = 0, cells = true) {
  const font = load()[face] || load().sans;
  let em = 0;
  const chars = Array.from(String(text));
  for (const char of chars) {
    if (cells && font.cell && char >= '0' && char <= '9') em += font.cell;
    else em += font.advances[char] !== undefined ? font.advances[char] : font.average;
  }
  return (em + chars.length * tracking) * size;
}

/* ---------- the faces of the event video (WP53) ---------- */

// family -> where its file is (relative to lib/fonts), its kind, and the face that stands in for it while the file is missing
const EVENT_FAMILIES = Object.freeze({
  Montserrat: Object.freeze({ file: 'montserrat/Montserrat-Variable.ttf', variable: true }),
  Anton: Object.freeze({ file: 'anton/Anton-Regular.ttf' }),
  'Inter Tight': Object.freeze({ file: 'inter-tight/InterTight-latin-variable.woff2', variable: true, average: { 400: 0.49, 500: 0.5, 600: 0.51, 700: 0.52 } }),
  'DM Sans': Object.freeze({ file: 'dm-sans/DMSans-Variable.ttf', variable: true, fallback: 'Inter Tight' }),
  'Space Grotesk': Object.freeze({ file: 'space-grotesk/SpaceGrotesk-Variable.ttf', variable: true, fallback: 'Inter Tight' }),
  'Playfair Display': Object.freeze({ file: 'playfair-display/PlayfairDisplay-Italic-Variable.ttf', variable: true, italic: true, fallback: 'Instrument Serif' }),
  'Instrument Serif': Object.freeze({ file: 'instrument-serif/InstrumentSerif-Italic.ttf', italic: true })
});

const familyCache = new Map();
const hasFile = (family) => Boolean(EVENT_FAMILIES[family]) && fs.existsSync(path.join(FONT_DIR, EVENT_FAMILIES[family].file));

// The family that is really drawn for `family`: itself when its file is there, else its stand-in (Instrument Serif for Playfair Display, Inter Tight for
// DM Sans and Space Grotesk).
function drawnFamily(family) {
  const entry = EVENT_FAMILIES[family];
  if (!entry) return 'Inter Tight';
  if (hasFile(family) || !entry.fallback) return family;
  return entry.fallback;
}

// The range of the optical size of a font file ([min, max]), null without that axis; read once per file.
const opszCache = new Map();
function opszRange(file) {
  if (!opszCache.has(file)) {
    const tables = ttf.readTables(fs.readFileSync(path.join(FONT_DIR, file)));
    const axis = tables.has('fvar') ? ttf.readAxes(tables.get('fvar')).find((item) => item.tag === 'opsz') : null;
    opszCache.set(file, axis ? [axis.min, axis.max] : null);
  }
  return opszCache.get(file);
}

// The table of a family at a weight (advances in em, average, cap height); a woff2 file (Inter Tight) is not read here: a fixed average by the weight.
// `size` (px) matters only for a font with an optical size (DM Sans): it is read at the size, held to the range of the axis, in whole px.
function familyTable(family, weight = 400, size = null) {
  const drawn = drawnFamily(family);
  const entry = EVENT_FAMILIES[drawn];
  const readable = !entry.file.endsWith('.woff2') && hasFile(drawn);
  const range = readable && entry.variable ? opszRange(entry.file) : null;
  const opsz = range ? Math.round(Math.min(range[1], Math.max(range[0], Number.isFinite(size) ? size : range[0]))) : null;
  const key = `${drawn}:${weight}${opsz === null ? '' : `:${opsz}`}`;
  if (familyCache.has(key)) return familyCache.get(key);
  let table;
  if (!readable) {
    const averages = entry.average || {};
    const near = Object.keys(averages).map(Number).sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight))[0];
    table = { advances: {}, average: near ? averages[near] : SANS_ADVANCE, capHeight: 0.727 };
  } else {
    const buffer = fs.readFileSync(path.join(FONT_DIR, entry.file));
    const coords = entry.variable ? { wght: weight, ...(opsz === null ? {} : { opsz }) } : undefined;
    table = tableOf(ttf.readMetrics(buffer, coords), false);
  }
  familyCache.set(key, table);
  return table;
}

// The width in px of `text` in a face of the event video ("Family:weight[:italic]" or { family, weight }) at `size` px with `tracking` em.
function familyWidth(face, text, size, tracking = 0) {
  const spec = typeof face === 'string' ? /^([^:]+):(\d+)/.exec(face) : null;
  const family = spec ? spec[1] : face && face.family;
  const weight = spec ? Number(spec[2]) : (face && face.weight) || 400;
  const font = familyTable(family, weight, size);
  let em = 0;
  const chars = Array.from(String(text));
  for (const char of chars) em += font.advances[char] !== undefined ? font.advances[char] : font.average;
  return (em + chars.length * tracking) * size;
}

module.exports = { load, textWidth, FILES, VARIABLE, EVENT_FAMILIES, drawnFamily, familyTable, familyWidth, FONT_DIR };
