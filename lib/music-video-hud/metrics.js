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

module.exports = { load, textWidth, FILES, VARIABLE };
