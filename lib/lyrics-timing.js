'use strict';

// Word times of a song (WP34, node "Lyrics timing"): what ElevenLabs returns for a song - the forced alignment of a known
// text, or the transcript of Scribe - is cleaned and put into lines. The functions here are pure (no network, no files); the
// calls are in lib/elevenlabs.js, the paid tool `lyrics_timing` in lib/tools.js, the node in lib/nodes/nodes-music-video.js.
//
// What the real answers taught (a sung song, 2 minutes):
//   - the words come with separate entries for every blank and line break (the alignment: ' ' and '\n'; Scribe: type "spacing")
//   - the alignment puts the first character of the song at the start of the audio, so the first word reaches from the intro
//     to the real start (0.58 s to 16.1 s for a word of 0.3 s); Scribe gets it right
//   - held notes get very long (the last word of a line lasted 7 s; the very last one reached to the end of the file), which is
//     why the end of a line is limited (MAX_LINE_HOLD_SEC)
//   - the words of the alignment are exactly the words of the text (split at blanks); Scribe writes its own capitalisation and
//     punctuation and may get a word wrong, so it is matched with the text by the words that agree

const musicPlan = require('../public/nodes/music-plan');

// The singer may hold the last note of a line for many seconds. A line counts as over this long after its last word began.
const MAX_LINE_HOLD_SEC = 2;
// A first word that lasts longer than this (and is not a very long word) began in the intro, see fixFirstWord.
const FIRST_WORD_MAX_SEC = 4;
// Between two characters of the first word a gap of this size means that the first one belongs to the intro.
const FIRST_CHAR_GAP_SEC = 2;
// Lines from pauses (Scribe without a text): a pause of this length ends a line, a shorter one when the line is already
// long, and a line never has more words than MAX_LINE_WORDS.
const LINE_PAUSE_SEC = 0.9;
const LINE_SOFT_PAUSE_SEC = 0.45;
const LINE_SOFT_WORDS = 6;
const MAX_LINE_WORDS = 14;
// A word of the text that was not heard gets at most this long (see placeTokens).
const ESTIMATED_WORD_SEC = 0.8;
// Above this many cells (words x words) the matching with a text falls back to a cheaper walk through both lists.
const MAX_MATCH_CELLS = 16_000_000;

/* ---------- the text that is sung ---------- */

const HEADER_LINE = /^\[[^\]]*\]?$/;
const PLAN_HEADER_LINE = /^\[[^\]]*\|[^\]]*\]?$/;
const NOT_SUNG_LINE = /^\(.*\)$/;

// A text with at least one section line like [Verse | 20 s] is a song plan.
function looksLikePlan(text) {
  return String(text || '')
    .split(/\r\n|\r|\n/)
    .some((line) => PLAN_HEADER_LINE.test(line.trim()));
}

// The lines that are sung in a pasted text or a song plan: no section lines ([Chorus], [Verse | 20 s]), none of the style
// lines of a plan (+ ..., - ...), none that only consist of a note in parentheses such as (ahhh) or (hm-mm). Blank lines go.
// A plan is read by the parser of the plan format, which also copes with a plan that has mistakes.
function sungLines(text) {
  const raw = looksLikePlan(text)
    ? musicPlan.parse(String(text)).plan.sections.flatMap((section) => section.lines)
    : String(text || '').split(/\r\n|\r|\n/).filter((line) => !HEADER_LINE.test(line.trim()));
  return raw
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !NOT_SUNG_LINE.test(line));
}

/* ---------- words ---------- */

const round3 = (value) => Math.round(value * 1000) / 1000;

// Comparable form of a word: no case, no accents, no punctuation.
function normalise(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokensOf(line) {
  return String(line).split(/\s+/).filter(Boolean);
}

// The words of an answer without the entries for blanks and line breaks and without audio events, in order, each as
// { text, start, end } in seconds. Times that go backwards are held to the word before, so the list never overlaps.
function cleanWords(raw) {
  const words = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
    if (item.type && item.type !== 'word') continue;
    let start = Number(item.start);
    let end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    end = Math.max(start, end);
    const previous = words[words.length - 1];
    if (previous) {
      if (start < previous.start) start = previous.start;
      if (end < start) end = start;
      if (previous.end > start) previous.end = start;
    }
    words.push({ text: item.text.trim(), start, end });
  }
  return words;
}

// The alignment sets the first character of the audio at its very start, so the first word reaches from there to its real
// end. With the characters of the answer the real start is the first character that is not alone in the intro. Without
// them, a first word that lasts far too long gets the time a word of that length takes. Words that begin later are never
// touched: each one is held in place by the words around it.
function fixFirstWord(words, characters) {
  const first = words[0];
  if (!first) return false;
  const letters = [...first.text.replace(/\s+/g, '')].length;
  const marks = (Array.isArray(characters) ? characters : []).filter((item) => item && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.start));
  if (marks.length > letters) {
    const own = marks.slice(0, letters);
    let index = 0;
    while (index < own.length - 1 && own[index + 1].start - own[index].start > FIRST_CHAR_GAP_SEC) index += 1;
    // the characters are the better witness: when none of them is alone, the word really lasts that long (a held "Oh")
    if (index === 0 || own[index].start <= first.start) return false;
    first.start = Math.min(own[index].start, first.end);
    return true;
  }
  const duration = first.end - first.start;
  const typical = Math.min(1.5, Math.max(0.3, 0.1 * letters + 0.1));
  if (duration > FIRST_WORD_MAX_SEC && duration > 6 * typical && words.length > 1 && words[1].start - first.end < 1) {
    first.start = Math.max(first.start, first.end - typical);
    return true;
  }
  return false;
}

/* ---------- lines ---------- */

// A line is over MAX_LINE_HOLD_SEC after its last word began, however long the singer holds that note.
function lineSpan(words) {
  const first = words[0];
  const last = words[words.length - 1];
  return { start: first.start, end: Math.min(last.end, last.start + MAX_LINE_HOLD_SEC) };
}

// Lines from the pauses between the words (Scribe without a text): groups of words.
function linesFromPauses(words) {
  const groups = [];
  let current = [];
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.start - previous.end;
      const hard = gap >= LINE_PAUSE_SEC || current.length >= MAX_LINE_WORDS;
      const soft = gap >= LINE_SOFT_PAUSE_SEC && current.length >= LINE_SOFT_WORDS;
      const sentence = /[.!?…]$/.test(previous.text) && gap >= 0.3;
      if (hard || soft || sentence) {
        groups.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

// Ties the words of the text to the words that were heard. `lines` are strings; the result lists every word of the text,
// line by line: { tokens: [{ text, line, heard }], matched, expected } where `heard` is the index in `words` or -1 (not found).
// With as many heard words as the text has words and `byOrder` (the alignment sends exactly the words of its text), by order.
// Otherwise the words that agree (the same word after normalise(), in order: a longest common subsequence) are tied; a word
// that was recognised wrongly, missed or added by the recogniser only costs its own tie.
function matchWords(words, lines, { byOrder = false } = {}) {
  const tokens = [];
  lines.forEach((line, index) => {
    for (const text of tokensOf(line)) tokens.push({ text, line: index, heard: -1 });
  });
  if (byOrder && words.length === tokens.length) {
    tokens.forEach((token, index) => {
      token.heard = index;
    });
    return { tokens, matched: tokens.length, expected: tokens.length };
  }
  const flat = tokens.map((token) => normalise(token.text));
  const heard = words.map((word) => normalise(word.text));
  const rows = flat.length + 1;
  const cols = heard.length + 1;
  if (rows * cols <= MAX_MATCH_CELLS) {
    // length of the longest common subsequence of flat[i..] and heard[j..]
    const table = new Uint16Array(rows * cols);
    for (let i = flat.length - 1; i >= 0; i -= 1) {
      for (let j = heard.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] =
          flat[i] && flat[i] === heard[j]
            ? table[(i + 1) * cols + j + 1] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < flat.length && j < heard.length) {
      if (flat[i] && flat[i] === heard[j]) {
        tokens[i].heard = j;
        i += 1;
        j += 1;
      } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  } else {
    // very long lists: walk through both and look a few words ahead
    let j = 0;
    for (let i = 0; i < flat.length; i += 1) {
      for (let look = j; look < Math.min(heard.length, j + 8); look += 1) {
        if (flat[i] && flat[i] === heard[look]) {
          tokens[i].heard = look;
          j = look + 1;
          break;
        }
      }
    }
  }
  return { tokens, matched: tokens.filter((token) => token.heard >= 0).length, expected: tokens.length };
}

// The time of every word of the text: the time it was heard at, or - for a word that found no partner - a place between the
// words around it (a stretch of missing words is spread over the gap, at most ESTIMATED_WORD_SEC each, in the middle of it;
// at the start or the end of the song it is placed next to the one word that is known). Returns false where no word of the text
// was heard at all.
function placeTokens(tokens, words) {
  const known = tokens.map((token) => (token.heard >= 0 ? words[token.heard] : null));
  if (!known.some(Boolean)) return false;
  let index = 0;
  while (index < tokens.length) {
    if (known[index]) {
      tokens[index].start = known[index].start;
      tokens[index].end = known[index].end;
      index += 1;
      continue;
    }
    let stop = index;
    while (stop < tokens.length && !known[stop]) stop += 1;
    const count = stop - index;
    const before = index > 0 ? tokens[index - 1].end : null;
    const after = stop < tokens.length ? known[stop].start : null;
    let slot = ESTIMATED_WORD_SEC;
    let at;
    if (before !== null && after !== null) {
      const gap = Math.max(0, after - before);
      slot = Math.min(ESTIMATED_WORD_SEC, gap / count);
      at = before + (gap - slot * count) / 2;
    } else if (after !== null) {
      at = Math.max(0, after - slot * count);
    } else {
      at = before;
    }
    for (let k = index; k < stop; k += 1) {
      tokens[k].start = at + slot * (k - index);
      tokens[k].end = Math.max(tokens[k].start, at + slot * (k - index + 1) - 0.02);
      tokens[k].estimated = true;
    }
    index = stop;
  }
  return true;
}

/* ---------- the result ---------- */

function finish({ source, words, lines, duration, extra = {} }) {
  const last = words[words.length - 1];
  const known = Number.isFinite(duration) && duration > 0 ? duration : last ? last.end : 0;
  const clip = (value) => round3(Math.min(value, known || value));
  const outWords = words.map((word) => {
    const item = { text: word.text, start: clip(word.start), end: clip(Math.max(word.start, word.end)) };
    if (Number.isInteger(word.line)) item.line = word.line;
    if (word.estimated) item.estimated = true;
    return item;
  });
  const outLines = lines.map((line) => {
    const item = { text: line.text, start: clip(line.start), end: clip(Math.max(line.start, line.end)) };
    if (line.estimated) item.estimated = true;
    return item;
  });
  return { version: 1, source, duration: round3(known), words: outWords, lines: outLines, ...extra };
}

function build({ source, words, lines, duration, extra = {} }) {
  if (!words.length) return finish({ source, words: [], lines: [], duration, extra });
  // no text: the words as they were heard, lines from the pauses
  if (!lines.length) {
    const outLines = linesFromPauses(words).map((group, index) => {
      group.forEach((word) => {
        word.line = index;
      });
      return { text: group.map((word) => word.text).join(' '), ...lineSpan(group) };
    });
    return finish({ source, words, lines: outLines, duration, extra });
  }
  // a text: the words and lines of the text, with the times of the words that were heard
  const { tokens, matched, expected } = matchWords(words, lines, { byOrder: source === 'align' });
  const stats = matched !== expected || source === 'transcribe' ? { matched, expected } : {};
  if (!placeTokens(tokens, words)) return finish({ source, words: [], lines: [], duration, extra: { ...extra, ...stats } });
  const outLines = lines.map((text, index) => {
    const own = tokens.filter((token) => token.line === index);
    return { text, ...lineSpan(own), ...(own.every((token) => token.estimated) ? { estimated: true } : {}) };
  });
  return finish({ source, words: tokens, lines: outLines, duration, extra: { ...extra, ...stats } });
}

// The timing of an alignment. `answer` = { words, characters?, loss? } as forcedAlignment() returns it, `text` the text that
// was aligned (a string, or the lines of sungLines()). The lines are the lines of the text; their words come by order.
function fromAlignment(answer, text, { duration } = {}) {
  const lines = (Array.isArray(text) ? text : sungLines(text)).filter(Boolean);
  const words = cleanWords(answer?.words);
  fixFirstWord(words, answer?.characters);
  return build({ source: 'align', words, lines, duration, extra: Number.isFinite(answer?.loss) ? { loss: round3(answer.loss) } : {} });
}

// The timing of a transcript. With a text the lines are its lines (tied to the words that agree), without one they come from
// the pauses.
function fromTranscript(answer, text, { duration } = {}) {
  const lines = (Array.isArray(text) ? text : sungLines(text)).filter(Boolean);
  const words = cleanWords(answer?.words);
  fixFirstWord(words, null);
  return build({ source: 'transcribe', words, lines, duration });
}

/* ---------- reading and showing ---------- */

// 15.84 -> "0:15.8", 76.12 -> "1:16.1" (tenths of a second, rounded)
function formatTime(seconds) {
  const tenths = Math.max(0, Math.round((Number(seconds) || 0) * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

// The readable form, one line each: "0:15.8–0:19.2 text of the line"
function readableLyrics(timing) {
  return (timing?.lines || []).map((line) => `${formatTime(line.start)}–${formatTime(line.end)} ${line.text}`).join('\n');
}

// The timing from the text a node passes on (JSON); null where it is none. Lines and words are checked and sorted by time.
function parseTiming(text) {
  let data = null;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.lines)) return null;
  const sane = (item) => item && typeof item.text === 'string' && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start && item.start >= 0;
  const lines = data.lines.filter(sane).map((item) => ({ ...item })).sort((a, b) => a.start - b.start);
  const words = Array.isArray(data.words) ? data.words.filter(sane).map((item) => ({ ...item })).sort((a, b) => a.start - b.start) : [];
  return { ...data, lines, words };
}

module.exports = {
  MAX_LINE_HOLD_SEC,
  sungLines,
  looksLikePlan,
  normalise,
  cleanWords,
  fixFirstWord,
  linesFromPauses,
  matchWords,
  fromAlignment,
  fromTranscript,
  formatTime,
  readableLyrics,
  parseTiming
};
