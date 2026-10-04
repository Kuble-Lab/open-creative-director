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
//
// Scripts other than Latin (WP35)
//   width     a row is limited in columns, not characters: a wide or fullwidth character (Chinese, Japanese, fullwidth forms) counts 2,
//             a combining mark 0
//   CJK       a word without spaces is broken between characters; a row never starts with a closing mark or a small kana and never ends
//             with an opening bracket (kinsoku, NO_START and NO_END). Between two such characters no space is put, where the timing has
//             them as separate words. The time of a word that is broken is divided over its pieces by their width.
//   RTL       Hebrew and Arabic stay in the order they are spoken (logical order); libass puts them in order on the screen when the
//             style has the encoding -1 (it detects the direction of a line; with the default it lays the words out left to right).
//             The \kf fill of libass runs from the left edge of a word whatever its direction, so a karaoke fill would run the wrong
//             way in a Hebrew or Arabic word: where a line has such text, the style `words` is used instead and `notes` says so.
//   fonts     buildAss() returns the scripts that occur (`scripts`: ja, zh, ko, ar, he); lib/captions-fonts.js asks fontconfig whether
//             a font for each exists.

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
// A wide character is as wide as the text size (two columns), so a column of a line of such characters is half of it
const WIDE_COLUMN_WIDTH = 0.5;
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
    autoMaxChars: !(chars > 0),
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

/* ---------- characters: width, scripts, line breaking rules ---------- */

// Characters that take two columns: the wide and fullwidth ones of the East Asian Width table (the blocks that matter for captions)
function isWideCode(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// Characters that take no column of their own: combining marks (Latin, Hebrew points, Arabic marks, kana voicing marks), joiners,
// direction marks and variation selectors
function isZeroWidthCode(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    code === 0x05bf ||
    code === 0x05c1 ||
    code === 0x05c2 ||
    code === 0x05c4 ||
    code === 0x05c5 ||
    code === 0x05c7 ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06dc) ||
    (code >= 0x06df && code <= 0x06e4) ||
    code === 0x06e7 ||
    code === 0x06e8 ||
    (code >= 0x06ea && code <= 0x06ed) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0x2060 ||
    (code >= 0x3099 && code <= 0x309a) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff
  );
}

// The columns of a text: wide characters 2, combining marks 0, everything else 1
function columns(text) {
  let total = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    total += isZeroWidthCode(code) ? 0 : isWideCode(code) ? 2 : 1;
  }
  return total;
}

// Characters of scripts that are written without spaces between the words and may be broken between any two of them: Han, kana,
// bopomofo, the punctuation of the CJK block and the fullwidth forms. Hangul is not among them: Korean is written with spaces.
function isBreakableCode(code) {
  return (
    (code >= 0x2e80 && code <= 0x303f) ||
    (code >= 0x3041 && code <= 0x30ff) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x31a0 && code <= 0x31ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xff66 && code <= 0xff9f) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// Kinsoku: a row does not start with one of NO_START (closing marks, marks of the end of a sentence, the prolonged sound mark, small
// kana, iteration marks) and does not end with one of NO_END (opening brackets).
const NO_START = new Set([...'、。，．）」』】〉》！？…ー' + '：；］｝〕〗〙〛・々ゝゞヽヾ〜' + 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ' + '),.:;!?]}%']);
const NO_END = new Set([...'（「『【〈《' + '［｛〔〖〘〚' + '([{']);

const firstChar = (text) => [...String(text)][0] || '';
const lastChar = (text) => {
  const chars = [...String(text)];
  return chars[chars.length - 1] || '';
};
const breakableChar = (char) => char !== '' && isBreakableCode(char.codePointAt(0));

// Hebrew and Arabic (and the other scripts written from right to left) as libass has to put them in order
const RTL_TEXT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const hasRtl = (text) => RTL_TEXT.test(String(text));

// The scripts of a text that need a font of their own: ['ja', 'zh', 'ko', 'ar', 'he'] in this order, those that occur. Han letters
// without kana or Hangul are taken as Chinese (a font for Japanese has them as well).
function scriptsOf(text) {
  const source = String(text ?? '');
  const found = new Set();
  let han = false;
  let kana = false;
  for (const char of source) {
    const code = char.codePointAt(0);
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff) || (code >= 0xff66 && code <= 0xff9f)) kana = true;
    else if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f) || (code >= 0xac00 && code <= 0xd7af)) found.add('ko');
    else if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x20000 && code <= 0x2fffd)) han = true;
    else if ((code >= 0x0590 && code <= 0x05ff) || (code >= 0xfb1d && code <= 0xfb4f)) found.add('he');
    else if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f) || (code >= 0x08a0 && code <= 0x08ff) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfefc)) found.add('ar');
  }
  if (kana) found.add('ja');
  else if (han && !found.has('ko')) found.add('zh');
  return ['ja', 'zh', 'ko', 'ar', 'he'].filter((id) => found.has(id));
}

const graphemes = (() => {
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return (text) => Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return (text) => [...text];
})();

// The pieces a word is laid out in: a word of scripts without spaces is cut after every character (a run of other characters, such as
// digits or Latin letters, stays together); a run of Hangul that is longer than a whole row is cut as well. Everything else is one piece.
function splitWord(text, limit) {
  const source = String(text);
  if (!/[^\u0000-\u2fff]/.test(source) || ![...source].some((char) => isWideCode(char.codePointAt(0)))) return [source];
  const pieces = [];
  let run = '';
  const flush = () => {
    if (!run) return;
    if (columns(run) > limit && [...run].some((char) => isWideCode(char.codePointAt(0)))) pieces.push(...graphemes(run));
    else pieces.push(run);
    run = '';
  };
  for (const grapheme of graphemes(source)) {
    if (breakableChar(firstChar(grapheme))) {
      flush();
      pieces.push(grapheme);
    } else {
      run += grapheme;
    }
  }
  flush();
  return pieces;
}

// No space is put between two words where BOTH have a character of a script without spaces at the edge between them (東京 + 駅).
// Next to a Latin word or a number the space of the source stays (「I love 東京 so much」, 「我爱 Beijing 天安门」).
const needsSpace = (before, after) => !(breakableChar(lastChar(before)) && breakableChar(firstChar(after)));

const rowLength = (token) => columns(token);
// Above this many words in a line the rows are filled one after the other, without the search for the even division
const MAX_BALANCED_WORDS = 300;

// Units in rows of at most `limit` columns. A unit is { size (columns), gap (columns of the space before it, 0 or 1), allowed (a row may
// start here: false where the rules of kinsoku forbid it) }; the first unit has no gap. Returns the rows as lists of indexes.
// The fewest rows that can hold the line are found first (filling each row as far as it goes; where a row would start where the rules
// forbid it, the break moves back to an earlier place that is allowed); then the units are divided over that many rows so that the rows
// come out about equally long (a line of 60 characters with a limit of 36 becomes two rows of about 30, not 36 and 24). A unit that is
// longer than the limit stands in a row of its own.
function wrapUnits(units, limit) {
  const max = Math.max(1, Math.floor(limit));
  const count = units.length;
  if (count < 2) return [units.map((_unit, index) => index)];
  const sizes = units.map((unit) => unit.size);
  const gaps = units.map((unit, index) => (index === 0 ? 0 : unit.gap));
  const allowed = units.map((unit, index) => index === 0 || unit.allowed !== false);
  const filled = [];
  let start = 0;
  let used = sizes[0];
  for (let index = 1; index < count; index += 1) {
    if (used + gaps[index] + sizes[index] > max) {
      let at = index;
      while (at > start + 1 && !allowed[at]) at -= 1;
      if (!allowed[at] || at <= start) at = index;
      filled.push(Array.from({ length: at - start }, (_value, offset) => start + offset));
      start = at;
      used = sizes[at];
      for (let follow = at + 1; follow <= index; follow += 1) used += gaps[follow] + sizes[follow];
    } else {
      used += gaps[index] + sizes[index];
    }
  }
  filled.push(Array.from({ length: count - start }, (_value, offset) => start + offset));
  const rows = filled.length;
  if (rows === 1 || count > MAX_BALANCED_WORDS) return filled;
  // the least total squared distance of the rows from the mean length, over the divisions into `rows` rows that respect the limit
  const prefix = [0];
  const gapPrefix = [0];
  sizes.forEach((size, index) => {
    prefix.push(prefix[index] + size);
    gapPrefix.push(gapPrefix[index] + gaps[index]);
  });
  const rowWidth = (from, to) => prefix[to] - prefix[from] + (gapPrefix[to] - gapPrefix[from + 1]);
  const mean = rowWidth(0, count) / rows;
  const cost = (from, to) => {
    const length = rowWidth(from, to);
    return length > max && to - from > 1 ? Infinity : (length - mean) ** 2;
  };
  const best = Array.from({ length: rows + 1 }, () => new Array(count + 1).fill(Infinity));
  const cut = Array.from({ length: rows + 1 }, () => new Array(count + 1).fill(0));
  best[0][0] = 0;
  for (let row = 1; row <= rows; row += 1) {
    for (let end = row; end <= count; end += 1) {
      for (let from = row - 1; from < end; from += 1) {
        if (!allowed[from]) continue;
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
    const from = cut[row][end];
    out.unshift(Array.from({ length: end - from }, (_value, offset) => from + offset));
    end = from;
  }
  return out;
}

// The words of a line in rows of at most `limit` columns, a word never broken (the rows are lists of the words).
function wrapTokens(tokens, limit) {
  const units = tokens.map((token) => ({ size: rowLength(token), gap: 1 }));
  return wrapUnits(units, limit).map((row) => row.map((index) => tokens[index]));
}

// The units of a line: its words, those of scripts without spaces cut into characters, each with the word it belongs to, the share
// of the word's time it covers (from, to: 0..1, by width) and whether a space comes before it. The rows come from wrapUnits() (the
// rules of kinsoku apply where the line has such characters). Returns the rows as lists of units { text, size, gap, word, from, to }.
function wrapLine(tokens, limit) {
  const max = Math.max(1, Math.floor(limit));
  const units = [];
  tokens.forEach((token, word) => {
    const pieces = splitWord(token, max);
    const total = pieces.reduce((sum, piece) => sum + Math.max(1, columns(piece)), 0);
    let before = 0;
    pieces.forEach((piece, position) => {
      const width = Math.max(1, columns(piece));
      units.push({
        text: piece,
        size: columns(piece),
        gap: position === 0 && word > 0 && needsSpace(tokens[word - 1], token) ? 1 : 0,
        word,
        from: before / total,
        to: (before + width) / total
      });
      before += width;
    });
  });
  const kinsoku = units.some((unit) => breakableChar(firstChar(unit.text)) || breakableChar(lastChar(unit.text)));
  units.forEach((unit, index) => {
    unit.allowed = !kinsoku || index === 0 || !(NO_START.has(firstChar(unit.text)) || NO_END.has(lastChar(units[index - 1].text)));
  });
  return wrapUnits(units, max).map((row) => row.map((index) => units[index]));
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

function styleLines(options, rtl = false) {
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
    `Style: Default,${FONT_FAMILIES[options.font]},${fontSize},${assColor(primary)},${assColor(secondary)},${assColor(options.outlineColor)},${assColor(back)},-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginSide},${marginSide},${marginV},${rtl ? -1 : 1}`,
    ''
  ];
}

const dialogue = (start, end, text) => `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;

// The text of a karaoke event: a \kf part per piece of a word, the pause before it as \k, the rows divided by \N. `base` is the start of
// the event in hundredths of a second; all parts are counted from it, so rounding never adds up. A word that is broken over several
// pieces fills them one after the other, each for its share of the time of the word.
function karaokeText(rows, words, base) {
  const parts = [];
  let cursor = 0;
  rows.forEach((row, rowIndex) => {
    row.forEach((unit, position) => {
      const word = words[unit.word];
      const span = word.fillEnd - word.start;
      const start = centis(word.start + span * unit.from) - base;
      const end = centis(word.start + span * unit.to) - base;
      const gap = Math.max(0, start - cursor);
      const length = Math.max(0, end - Math.max(start, cursor));
      cursor = Math.max(cursor, end);
      const next = row[position + 1];
      parts.push(`{${gap ? `\\k${gap}` : ''}\\kf${length}}${escapeText(unit.text)}${next && next.gap ? ' ' : ''}`);
    });
    if (rowIndex < rows.length - 1) parts.push('\\N');
  });
  return parts.join('');
}

// The text of the whole line in rows, with the word `active` (an index into the words) in the highlight colour; the pieces of a word that
// is broken are marked together
function rowsText(rows, active, highlight) {
  return rows
    .map((row) => {
      let text = '';
      let position = 0;
      while (position < row.length) {
        const first = row[position];
        let piece = '';
        let end = position;
        while (end < row.length && row[end].word === first.word) {
          piece += escapeText(row[end].text);
          end += 1;
        }
        if (position > 0 && first.gap) text += ' ';
        text += first.word === active ? `{\\1c${assTagColor(highlight)}}${piece}{\\r}` : piece;
        position = end;
      }
      return text;
    })
    .join('\\N');
}

// Builds the script. options: { timing (JSON text or object), width, height, style, position, sizePercent, color, highlightColor,
// outlineColor, outlinePercent, font, uppercase, offset, leadIn, hold, maxChars, duration }, see normalizeOptions. `duration` is the
// length of the film: what lies beyond it is dropped.
// Returns { text, events, lines, fontSize, maxChars, options, style, rtl, scripts, notes } - `events` is the number of Dialogue lines (0:
// nothing to show); `style` is the style that was used (`words` where karaoke was asked for and a line has right-to-left text), `rtl` says
// whether a line has such text, `scripts` lists the scripts that need a font of their own and `notes` are sentences for the log.
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
  const notes = [];
  const lineText = (line) => line.words.map((word) => word.text).join(' ');
  const rtl = lines.some((line) => hasRtl(lineText(line)));
  const scripts = scriptsOf(lines.map(lineText).join(' '));
  const requested = options.style;
  if (rtl && requested === 'karaoke') {
    // the fill of libass runs from the left edge of every word, which is the wrong side in a Hebrew or Arabic word
    options.style = 'words';
    notes.push('Right-to-left text: the karaoke fill would run from the wrong side of each word, so the captions use the style "words" (the sung word is highlighted)');
  }
  const windows = displayWindows(lines, options);
  const out = [];
  lines.forEach((line, index) => {
    const window = windows[index];
    const start = Math.max(0, window.start);
    const end = limit === null ? window.end : Math.min(window.end, limit);
    if (!(end > start) || (limit !== null && start >= limit)) return;
    const tokens = line.words.map((word) => (options.uppercase ? word.text.toUpperCase() : word.text));
    // the automatic limit counts a column as wide as the average Latin letter; a line that is mostly wide characters has narrower columns
    const wide = tokens.reduce((sum, token) => sum + [...token].filter((char) => isWideCode(char.codePointAt(0))).length * 2, 0);
    const scale = options.autoMaxChars && wide * 2 >= tokens.reduce((sum, token) => sum + columns(token), 0) ? (options.uppercase ? CHAR_WIDTH_UPPERCASE : CHAR_WIDTH) / WIDE_COLUMN_WIDTH : 1;
    const rows = wrapLine(tokens, Math.floor(options.maxChars * scale));
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
  const text = [...header(options), ...styleLines(options, rtl), '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...out, ''].join('\n');
  return { text, events: out.length, lines: lines.length, fontSize: options.fontSize, maxChars: options.maxChars, options, style: options.style, rtl, scripts, notes };
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
  wrapUnits,
  wrapLine,
  splitWord,
  columns,
  isWideCode,
  hasRtl,
  scriptsOf,
  NO_START,
  NO_END,
  displayWindows,
  buildAss
};
