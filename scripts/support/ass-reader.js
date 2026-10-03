'use strict';

// Test support (not a test): a reader for caption scripts (ASS) that follows the rules of libass, so that a test can check what a script
// means independently of the code that wrote it.
//
//   const { parseAss, lex, karaokeWords, OWN_BLOCK } = require('./support/ass-reader');
//   parseAss(text)           // { info: { PlayResX, ... }, style: { Fontname, ... }, events: [{ start, end, text }] }, times in hundredths of a second
//   lex(eventText)           // { visible, blocks, segments }: the text as it is shown ('\n' for \N), the override blocks, the text after each block
//   karaokeWords(eventText)  // [{ text, from, to }]: the words of a karaoke line with the start and end of their fill, counted from the event

const assert = require('assert/strict');

const toCentis = (stamp) => {
  const match = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(stamp);
  assert.ok(match, `time ${stamp} has the form H:MM:SS.cc`);
  return Number(match[1]) * 360000 + Number(match[2]) * 6000 + Number(match[3]) * 100 + Number(match[4]);
};

function parseAss(text) {
  const info = {};
  let style = null;
  const events = [];
  let section = '';
  let styleFormat = [];
  for (const line of text.split('\n')) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
    } else if (section === 'Script Info' && /^[A-Za-z ]+:/.test(line)) {
      const at = line.indexOf(':');
      info[line.slice(0, at)] = line.slice(at + 1).trim();
    } else if (section === 'V4+ Styles' && line.startsWith('Format:')) {
      styleFormat = line.slice(7).split(',').map((name) => name.trim());
    } else if (section === 'V4+ Styles' && line.startsWith('Style:')) {
      const values = line.slice(6).trim().split(',');
      assert.equal(values.length, styleFormat.length, 'the style has a value for every column');
      style = Object.fromEntries(styleFormat.map((name, index) => [name, values[index]]));
    } else if (section === 'Events' && line.startsWith('Dialogue:')) {
      const values = line.slice(9).trim().split(',');
      const body = values.slice(9).join(',');
      events.push({ layer: values[0], start: toCentis(values[1]), end: toCentis(values[2]), style: values[3], text: body });
    }
  }
  return { info, style, events };
}

// Reads the text of an event the way libass does: {...} is a block of override tags, \N a line break, \{ and \} are braces, \n a blank,
// \h a hard blank, and every other backslash is a letter of the text. Returns the visible text ('\n' for a break), the blocks, and the
// text after each block.
function lex(text) {
  let visible = '';
  const blocks = [];
  const segments = [{ tags: null, text: '' }];
  const put = (char) => {
    visible += char;
    segments[segments.length - 1].text += char;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      const close = text.indexOf('}', index);
      assert.ok(close > index, `an override block is closed in ${JSON.stringify(text)}`);
      blocks.push(text.slice(index + 1, close));
      segments.push({ tags: text.slice(index + 1, close), text: '' });
      index = close + 1;
    } else if (char === '\\') {
      const next = text[index + 1];
      if (next === 'N') {
        put('\n');
        index += 2;
      } else if (next === 'n') {
        put(' ');
        index += 2;
      } else if (next === 'h') {
        put('\u00a0');
        index += 2;
      } else if (next === '{' || next === '}') {
        put(next);
        index += 2;
      } else {
        put('\\');
        index += 1;
      }
    } else {
      put(char);
      index += 1;
    }
  }
  return { visible, blocks, segments };
}

// The words of a karaoke event with the time (hundredths of a second from the start of the event) at which their fill begins and ends
function karaokeWords(eventText) {
  const { segments } = lex(eventText);
  const words = [];
  let at = 0;
  for (const segment of segments) {
    if (!segment.tags) continue;
    const match = /^(?:\\k(\d+))?\\kf(\d+)$/.exec(segment.tags);
    assert.ok(match, `a karaoke block holds only \\k and \\kf, got ${segment.tags}`);
    at += Number(match[1] || 0);
    const from = at;
    at += Number(match[2]);
    words.push({ text: segment.text.replace(/\s+$/g, '').replace(/\n/g, ''), from, to: at });
  }
  return words;
}

const OWN_BLOCK = /^(?:(?:\\k\d+)?\\kf\d+|\\1c&H[0-9A-F]{6}&|\\r)$/;

module.exports = { parseAss, lex, karaokeWords, OWN_BLOCK, toCentis };
