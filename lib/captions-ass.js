'use strict';

// Captions for a video as an ASS script (WP35, node "Burn in captions" and the cut of a music video). The script is built from the
// times of the lines and words of a song (lib/lyrics-timing.js) and burnt into the picture by the filter `ass` of ffmpeg (libass).
// Pure functions: nothing here touches the disk or starts a process; the nodes (lib/nodes/nodes-edit.js,
// lib/nodes/nodes-music-video.js) write the file and run ffmpeg.
//
// Styles
//   karaoke  the line stands in the base colour and every word is filled with the highlight colour while it is sung: one event per
//            line with a \kf part for each word (hundredths of a second, so the fill follows the word); the pause before a word is
//            an empty \k part
//   words    the line stands in the base colour and the word that is sung is in the highlight colour: one event per word, each with
//            the whole line (the layout of all of them is the same)
//   lines    the whole line, nothing highlighted
// A line appears a moment before its first word (LEAD_IN_SEC) and stays a moment after its last (HOLD_SEC); where the next line
// comes sooner the pause between the two is shared, so two lines are not on screen together by accident. Without times for the
// words (lines only) the words of a line share its time evenly. The size is a share of the height of the picture, long lines are
// broken in rows of about the same length, and the text is escaped so that no character of a lyric can act as a tag.
//
// The times of the script are the times of the timing JSON plus `offset`; the film that carries the captions starts at 0.

const lyricsTiming = require('./lyrics-timing');

const STYLES = Object.freeze(['karaoke', 'words', 'lines']);
const POSITIONS = Object.freeze(['bottom', 'middle', 'top']);
// Families that are on almost every machine that renders video (libass finds them through fontconfig, and uses a font of its own choice
// where a family is missing). The value of the option is the id, the name is what the script asks for.
const FONT_FAMILIES = Object.freeze({
  'dejavu-sans': 'DejaVu Sans',
  'dejavu-serif': 'DejaVu Serif',
  'liberation-sans': 'Liberation Sans',
  'liberation-serif': 'Liberation Serif',
  'noto-sans': 'Noto Sans',
  'noto-serif': 'Noto Serif'
});
const FONTS = Object.freeze(Object.keys(FONT_FAMILIES));
const DEFAULT_FONT = 'dejavu-sans';

// The size of the text in percent of the height of the picture: the default for a landscape or square picture; a picture that is
// higher than wide gets the same text size in pixels as a landscape one of the same width would (the height is not what limits it)
const DEFAULT_SIZE_PERCENT = 6;
const MIN_SIZE_PERCENT = 2;
const MAX_SIZE_PERCENT = 15;
// The outline is a share of the text size
const DEFAULT_OUTLINE_PERCENT = 8;
const MAX_OUTLINE_PERCENT = 25;
const MAX_OFFSET_SEC = 600;
const LEAD_IN_SEC = 0.4;
const HOLD_SEC = 0.4;
// an event is on screen for this long at least
const MIN_EVENT_SEC = 0.3;
// a word is filled for this long at least (an estimated word may have no length at all)
const MIN_FILL_SEC = 0.15;
// style `words`: after a pause this long the highlight is taken off the word (a shorter one keeps it until the next word)
const WORD_GAP_SEC = 0.4;
// The tolerance with which a word belongs to the time of a line (times are rounded to milliseconds, words that were not heard are placed)
const LINE_TOLERANCE_SEC = 0.5;
// Average width of a character of the bold fonts in shares of the text size: the longest row that fits in the picture is estimated with it
const CHAR_WIDTH = 0.68;
const CHAR_WIDTH_UPPERCASE = 0.8;
const ROW_SHARE_OF_WIDTH = 0.88;
const MIN_ROW_CHARS = 8;
const MAX_ROW_CHARS = 90;
const MAX_LINES = 2000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/* ---------- small pieces of the format ---------- */

// 75.4 -> 7540 (hundredths of a second, what the format counts in)
const centis = (seconds) => Math.round(seconds * 100);

// 75.4 -> "0:01:15.40"
function assTime(seconds) {
  const total = Math.max(0, centis(seconds));
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor((total % 360000) / 6000);
  const secs = Math.floor((total % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(total % 100).padStart(2, '0')}`;
}

const HEX_COLOR = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;

// '#rrggbb' or '#rrggbbaa' -> { r, g, b, opacity } (opacity 0..255); `fallback` where the value is no colour
function parseColor(value, fallback) {
  const match = HEX_COLOR.exec(String(value ?? '').trim()) || HEX_COLOR.exec(fallback);
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    opacity: match[2] ? parseInt(match[2], 16) : 255
  };
}

const hex2 = (value) => value.toString(16).toUpperCase().padStart(2, '0');

// The colour of a style: &HAABBGGRR, the alpha counted the other way round (00 is opaque)
const assColor = (color) => `&H${hex2(255 - color.opacity)}${hex2(color.b)}${hex2(color.g)}${hex2(color.r)}`;

// The colour in an override tag: &HBBGGRR& (the alpha of the style stays)
const assTagColor = (color) => `&H${hex2(color.b)}${hex2(color.g)}${hex2(color.r)}&`;

// Text of a lyric made safe for the text field of an event. `{` and `}` open and close override blocks and `\` starts a tag, so they
// are written as the characters libass takes literally (`\{` and `\}`) or, for the backslash, which has no such form, as the similar
// SET MINUS; a line break becomes `\N`. Control characters are dropped.
function escapeText(text) {
  return String(text ?? '')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\u2216')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\N');
}

// A value of the filter `ass` (a file name): escaped for the arguments of the filter and then for the filter graph, which is why
// a backslash that the first step adds is doubled by the second (ffmpeg-filters, "Notes on filtergraph escaping").
function escapeFilterValue(value) {
  return String(value)
    .replace(/[\\':]/g, (char) => `\\${char}`)
    .replace(/[\\'[\],;=]/g, (char) => `\\${char}`);
}

// The filter that burns the script `file` into the picture.
function assFilter(file) {
  if (!file) throw new Error('The script file of the captions is missing');
  return `ass=filename=${escapeFilterValue(file)}`;
}

/* ---------- the options ---------- */

// The font id for a value: an id, or the name of a family (any case); the default for everything else
function fontId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (FONT_FAMILIES[text]) return text;
  const found = FONTS.find((id) => FONT_FAMILIES[id].toLowerCase() === text);
  return found || DEFAULT_FONT;
}

// The options of a caption script, checked and with their defaults. `width` and `height` are the size of the video (the script is
// written for exactly that size). sizePercent: of the height; null or 0 is the automatic size.
function normalizeOptions(raw = {}) {
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (!(width >= 16 && height >= 16)) throw new Error('The captions need the size of the video');
  const number = (value, fallback, low, high) => {
    const n = Number(value);
    return value === null || value === undefined || value === '' || !Number.isFinite(n) ? fallback : clamp(n, low, high);
  };
  const percent = Number(raw.sizePercent);
  const automatic = !(percent > 0);
  const sizePercent = automatic ? DEFAULT_SIZE_PERCENT * Math.min(1, width / height) : clamp(percent, MIN_SIZE_PERCENT, MAX_SIZE_PERCENT);
  const uppercase = raw.uppercase === true;
  const fontSize = Math.max(8, Math.round((height * sizePercent) / 100));
  const autoChars = Math.floor((width * ROW_SHARE_OF_WIDTH) / (fontSize * (uppercase ? CHAR_WIDTH_UPPERCASE : CHAR_WIDTH)));
  const chars = Math.round(Number(raw.maxChars));
  return {
    style: STYLES.includes(raw.style) ? raw.style : 'karaoke',
    position: POSITIONS.includes(raw.position) ? raw.position : 'bottom',
    width,
    height,
    sizePercent,
    fontSize,
    color: parseColor(raw.color, '#ffffff'),
    highlightColor: parseColor(raw.highlightColor, '#ffd400'),
    outlineColor: parseColor(raw.outlineColor, '#000000'),
    outlinePercent: number(raw.outlinePercent, DEFAULT_OUTLINE_PERCENT, 0, MAX_OUTLINE_PERCENT),
    font: fontId(raw.font),
    uppercase,
    offset: number(raw.offset, 0, -MAX_OFFSET_SEC, MAX_OFFSET_SEC),
    leadIn: number(raw.leadIn, LEAD_IN_SEC, 0, 5),
    hold: number(raw.hold, HOLD_SEC, 0, 5),
    maxChars: chars > 0 ? clamp(chars, 1, 200) : clamp(autoChars, MIN_ROW_CHARS, MAX_ROW_CHARS),
    duration: finite(raw.duration) && raw.duration > 0 ? raw.duration : null
  };
}

/* ---------- the lines and the words ---------- */

const sane = (item) => item && typeof item.text === 'string' && finite(item.start) && finite(item.end) && item.end >= item.start && item.start >= 0;

// The timing as lib/lyrics-timing.js parseTiming() reads it (JSON text or object); null where it cannot be used. A list of words
// without lines (as a transcription gives it) is accepted, the lines are made from its pauses.
function readTiming(input) {
  if (input === null || input === undefined || input === '') return null;
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (_) {
      return null;
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data.lines) && Array.isArray(data.words)) data = { ...data, lines: [] };
  return lyricsTiming.parseTiming(data);
}

function cleanWord(word) {
  return { text: String(word.text).replace(/\s+/g, ' ').trim(), start: word.start, end: word.end };
}

// A line without the times of its words: its words share its time evenly.
function evenWords(line) {
  const tokens = String(line.text).split(/\s+/).filter(Boolean);
  const slot = (line.end - line.start) / Math.max(1, tokens.length);
  return tokens.map((text, index) => ({ text, start: line.start + slot * index, end: line.start + slot * (index + 1) }));
}

// The lines to show: [{ text, start, end, words: [{ text, start, end }] }] in the order of time. The words of a line are the ones it
// carries (`words` in the line), else the ones of the list of words that name it (`line`, the index of the line, when the word starts
// within the time of that line) or start within its time; a line without any gets its words spread evenly over its time. Where the
// timing has words but no lines, the lines are made from the pauses between the words, as the transcription does.
function collectLines(timing) {
  if (!timing) return [];
  const flat = (Array.isArray(timing.words) ? timing.words : []).filter(sane).map((word) => ({ ...cleanWord(word), line: word.line }));
  let lines = (Array.isArray(timing.lines) ? timing.lines : []).filter(sane);
  const nested = lines.map((line) => (Array.isArray(line.words) ? line.words.filter(sane).map(cleanWord).filter((word) => word.text) : null));
  if (!lines.length && flat.length) {
    lines = lyricsTiming.linesFromPauses(flat).map((group) => ({
      text: group.map((word) => word.text).join(' '),
      start: group[0].start,
      end: group[group.length - 1].end,
      words: group
    }));
    lines.forEach((line, index) => {
      nested[index] = line.words;
    });
  }
  const within = (line, word) => word.start >= line.start - LINE_TOLERANCE_SEC && word.start <= line.end + LINE_TOLERANCE_SEC;
  const own = lines.map((_line, index) => (nested[index] && nested[index].length ? nested[index].slice() : []));
  for (const word of flat) {
    if (!word.text) continue;
    let at = Number.isInteger(word.line) && lines[word.line] && !(nested[word.line] && nested[word.line].length) && within(lines[word.line], word) ? word.line : -1;
    for (let index = lines.length - 1; at < 0 && index >= 0; index -= 1) {
      if (!(nested[index] && nested[index].length) && within(lines[index], word)) at = index;
    }
    if (at >= 0) own[at].push({ text: word.text, start: word.start, end: word.end });
  }
  return lines.slice(0, MAX_LINES).map((line, index) => {
    const text = String(line.text).replace(/\s+/g, ' ').trim();
    const words = own[index].length ? own[index].sort((a, b) => a.start - b.start) : evenWords({ ...line, text });
    return { text, start: line.start, end: line.end, words: words.filter((word) => word.text) };
  }).filter((line) => line.words.length);
}

/* ---------- layout ---------- */

const rowLength = (token) => [...token].length;
// Above this many words in a line the rows are filled one after the other, without the search for the even division
const MAX_BALANCED_WORDS = 300;

// The words of a line in rows of at most `limit` characters. The fewest rows that can hold the line are found first (filling each row
// as far as it goes); then the words are divided over that many rows so that the rows come out about equally long (a line of 60
// characters with a limit of 36 becomes two rows of about 30, not 36 and 24). A word that is longer than the limit stands in a row
// of its own.
function wrapTokens(tokens, limit) {
  const max = Math.max(1, Math.floor(limit));
  const sizes = tokens.map(rowLength);
  const count = tokens.length;
  if (count < 2) return [tokens.slice()];
  const filled = [[tokens[0]]];
  let used = sizes[0];
  for (let index = 1; index < count; index += 1) {
    if (used + 1 + sizes[index] > max) {
      filled.push([tokens[index]]);
      used = sizes[index];
    } else {
      filled[filled.length - 1].push(tokens[index]);
      used += 1 + sizes[index];
    }
  }
  const rows = filled.length;
  if (rows === 1 || count > MAX_BALANCED_WORDS) return filled;
  // the least total squared distance of the rows from the mean length, over the divisions into `rows` rows that respect the limit
  const prefix = [0];
  sizes.forEach((size, index) => prefix.push(prefix[index] + size));
  const mean = (prefix[count] + count - 1) / rows;
  const cost = (from, to) => {
    const length = prefix[to] - prefix[from] + (to - from - 1);
    return length > max && to - from > 1 ? Infinity : (length - mean) ** 2;
  };
  const best = Array.from({ length: rows + 1 }, () => new Array(count + 1).fill(Infinity));
  const cut = Array.from({ length: rows + 1 }, () => new Array(count + 1).fill(0));
  best[0][0] = 0;
  for (let row = 1; row <= rows; row += 1) {
    for (let end = row; end <= count; end += 1) {
      for (let from = row - 1; from < end; from += 1) {
        const total = best[row - 1][from] + cost(from, end);
        if (total < best[row][end]) {
          best[row][end] = total;
          cut[row][end] = from;
        }
      }
    }
  }
  if (!Number.isFinite(best[rows][count])) return filled;
  const out = [];
  for (let row = rows, end = count; row > 0; row -= 1) {
    out.unshift(tokens.slice(cut[row][end], end));
    end = cut[row][end];
  }
  return out;
}

// The time each line is on screen, [{ start, end }] for lines in order. A line begins `leadIn` before its first word and ends `hold`
// after its last; where that would make two lines overlap, the time between the last word of the one and the first of the other
// is shared at its middle (as far as the margins allow).
function displayWindows(lines, { leadIn, hold }) {
  const windows = lines.map((line) => {
    const first = line.words[0].start;
    const last = line.fillEnd;
    return { first, last, start: first - leadIn, end: Math.max(last + hold, first - leadIn + MIN_EVENT_SEC) };
  });
  for (let index = 1; index < windows.length; index += 1) {
    const before = windows[index - 1];
    const after = windows[index];
    if (before.end > after.start && before.last <= after.first) {
      const middle = before.last + (after.first - before.last) / 2;
      const at = clamp(middle, after.start, before.end);
      before.end = at;
      after.start = at;
    }
  }
  return windows;
}

/* ---------- the script ---------- */

function header(options) {
  return [
    '[Script Info]',
    '; Captions made by Open Creative Director',
    'ScriptType: v4.00+',
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    ''
  ];
}

function styleLines(options) {
  const { fontSize, position, width, height, style } = options;
  const alignment = position === 'top' ? 8 : position === 'middle' ? 5 : 2;
  const marginSide = Math.round(width * 0.05);
  const marginV = position === 'middle' ? 0 : Math.round(height * 0.06);
  const outline = ((fontSize * options.outlinePercent) / 100).toFixed(1);
  const shadow = (fontSize * 0.04).toFixed(1);
  // In a karaoke line the part that has not been sung yet is shown in the secondary colour and the part that has been sung in the primary one
  const primary = style === 'karaoke' ? options.highlightColor : options.color;
  const secondary = style === 'karaoke' ? options.color : options.highlightColor;
  const back = { r: 0, g: 0, b: 0, opacity: 128 };
  return [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${FONT_FAMILIES[options.font]},${fontSize},${assColor(primary)},${assColor(secondary)},${assColor(options.outlineColor)},${assColor(back)},-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginSide},${marginSide},${marginV},1`,
    ''
  ];
}

const dialogue = (start, end, text) => `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;

// The text of a karaoke event: a \kf part per word, the pause before a word as \k, the rows divided by \N. `base` is the start of the
// event in hundredths of a second; all parts are counted from it, so rounding never adds up.
function karaokeText(rows, words, base) {
  const parts = [];
  let cursor = 0;
  let index = 0;
  rows.forEach((row, rowIndex) => {
    row.forEach((token, position) => {
      const word = words[index];
      index += 1;
      const start = centis(word.start) - base;
      const end = centis(word.fillEnd) - base;
      const gap = Math.max(0, start - cursor);
      const length = Math.max(0, end - Math.max(start, cursor));
      cursor = Math.max(cursor, end);
      parts.push(`{${gap ? `\\k${gap}` : ''}\\kf${length}}${escapeText(token)}${position < row.length - 1 ? ' ' : ''}`);
    });
    if (rowIndex < rows.length - 1) parts.push('\\N');
  });
  return parts.join('');
}

// The text of the whole line in rows, with the word `active` (an index into the words) in the highlight colour
function rowsText(rows, active, highlight) {
  let index = 0;
  return rows
    .map((row) =>
      row
        .map((token) => {
          const text = escapeText(token);
          const marked = index === active;
          index += 1;
          return marked ? `{\\1c${assTagColor(highlight)}}${text}{\\r}` : text;
        })
        .join(' ')
    )
    .join('\\N');
}

// Builds the script. options: { timing (JSON text or object), width, height, style, position, sizePercent, color, highlightColor,
// outlineColor, outlinePercent, font, uppercase, offset, leadIn, hold, maxChars, duration }, see normalizeOptions. `duration` is the
// length of the film: what lies beyond it is dropped.
// Returns { text, events, lines, fontSize, maxChars, options } - `events` is the number of Dialogue lines (0: nothing to show).
function buildAss(input = {}) {
  const options = normalizeOptions(input);
  const timing = readTiming(input.timing);
  const shift = options.offset;
  const limit = options.duration;
  // the lines at their times in the film, the words with the end of their fill
  const lines = collectLines(timing)
    .map((line) => {
      const words = line.words.map((word, index, all) => {
        const next = all[index + 1];
        const start = word.start + shift;
        let end = Math.max(word.end, word.start) + shift;
        if (next) end = Math.min(end, next.start + shift);
        else end = Math.min(end, Math.max(line.end, word.start + MIN_FILL_SEC) + shift);
        return { text: word.text, start, fillEnd: Math.max(end, start + (next ? 0 : MIN_FILL_SEC)) };
      });
      return { ...line, words, fillEnd: words[words.length - 1].fillEnd };
    })
    .filter((line) => line.fillEnd > 0);
  const windows = displayWindows(lines, options);
  const out = [];
  lines.forEach((line, index) => {
    const window = windows[index];
    const start = Math.max(0, window.start);
    const end = limit === null ? window.end : Math.min(window.end, limit);
    if (!(end > start) || (limit !== null && start >= limit)) return;
    const tokens = line.words.map((word) => (options.uppercase ? word.text.toUpperCase() : word.text));
    const rows = wrapTokens(tokens, options.maxChars);
    if (options.style === 'lines') {
      out.push(dialogue(start, end, rowsText(rows, -1, options.highlightColor)));
    } else if (options.style === 'karaoke') {
      out.push(dialogue(start, end, karaokeText(rows, line.words, centis(start))));
    } else {
      // an event for every stretch of the line: before the first word, a word, a pause, ...; they follow each other without a gap
      const marks = [];
      let at = start;
      const stretch = (to, active) => {
        const stop = Math.min(end, Math.max(to, at));
        if (centis(stop) > centis(at)) marks.push({ from: at, to: stop, active });
        at = Math.max(at, stop);
      };
      line.words.forEach((word, position) => {
        const next = line.words[position + 1];
        stretch(word.start, -1);
        // the highlight stays until the next word begins, unless the pause is long
        stretch(next && next.start - word.fillEnd <= WORD_GAP_SEC ? next.start : word.fillEnd, position);
      });
      stretch(end, -1);
      if (!marks.length) marks.push({ from: start, to: end, active: -1 });
      for (const mark of marks) out.push(dialogue(mark.from, mark.to, rowsText(rows, mark.active, options.highlightColor)));
    }
  });
  const text = [...header(options), ...styleLines(options), '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...out, ''].join('\n');
  return { text, events: out.length, lines: lines.length, fontSize: options.fontSize, maxChars: options.maxChars, options };
}

module.exports = {
  STYLES,
  POSITIONS,
  FONT_FAMILIES,
  FONTS,
  DEFAULT_FONT,
  DEFAULT_SIZE_PERCENT,
  MIN_SIZE_PERCENT,
  MAX_SIZE_PERCENT,
  DEFAULT_OUTLINE_PERCENT,
  MAX_OUTLINE_PERCENT,
  MAX_OFFSET_SEC,
  LEAD_IN_SEC,
  HOLD_SEC,
  centis,
  assTime,
  parseColor,
  assColor,
  assTagColor,
  escapeText,
  escapeFilterValue,
  assFilter,
  normalizeOptions,
  readTiming,
  collectLines,
  wrapTokens,
  displayWindows,
  buildAss
};
