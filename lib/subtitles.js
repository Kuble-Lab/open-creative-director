'use strict';

// Subtitles from word times (node "Subtitles", video.subtitles; the rough cut uses them too). The words of a transcript (the
// timing JSON of audio.lyrics_timing: { words: [{ text, start, end }] }) are grouped into cues that can be read: at most
// `maxChars` characters on a line, at most `maxLines` lines, no longer than `maxSeconds` on the screen, a cue ends at a long
// pause and preferably at the end of a sentence. The cues are written as SubRip (.srt), WebVTT (.vtt) and as a timing whose
// lines are the cues, which "Burn in captions" (video.captions) shows one cue at a time. Pure: no network, no files.
//
// The figures follow the usual rules of subtitling (Netflix and BBC guides): 42 characters per line, two lines, a cue at least
// about a second and at most about six seconds, so the text can be read at roughly 17 characters per second.

const MAX_CHARS_DEFAULT = 42;
const MAX_CHARS_MIN = 16;
const MAX_CHARS_MAX = 80;
const MAX_LINES_DEFAULT = 2;
const MAX_LINES_MAX = 3;
const MAX_SECONDS_DEFAULT = 6;
const MAX_SECONDS_MIN = 1;
const MAX_SECONDS_MAX = 15;
// A cue shorter than this stays longer on the screen (into the pause after it, never into the next cue).
const MIN_SECONDS = 0.8;
// A pause of this length always ends a cue; a shorter one ends a cue that is already half full.
const HARD_PAUSE_SEC = 1.2;
const SOFT_PAUSE_SEC = 0.5;
// The end of a sentence ends a cue once it holds at least this share of the room.
const SENTENCE_SHARE = 0.4;
// Words after which a line should not be broken (articles, prepositions, conjunctions in de/en/es); used to pick the break.
const WEAK_BREAK = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'mit', 'von', 'zu', 'zum', 'zur', 'im', 'in', 'am', 'an', 'auf', 'für', 'bei', 'nach', 'aus',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'el', 'la', 'los', 'las', 'un', 'una', 'y', 'o', 'de', 'del', 'en', 'con', 'por', 'para', 'al'
]);

const round3 = (n) => Math.round(n * 1000) / 1000;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normaliseOptions(options = {}) {
  return {
    maxChars: Math.round(clampNumber(options.maxChars, MAX_CHARS_MIN, MAX_CHARS_MAX, MAX_CHARS_DEFAULT)),
    maxLines: Math.round(clampNumber(options.maxLines, 1, MAX_LINES_MAX, MAX_LINES_DEFAULT)),
    maxSeconds: clampNumber(options.maxSeconds, MAX_SECONDS_MIN, MAX_SECONDS_MAX, MAX_SECONDS_DEFAULT)
  };
}

// The usable words of a timing, in the order of time: { text, start, end } with a text and sane times.
function usableWords(words) {
  const out = [];
  for (const word of Array.isArray(words) ? words : []) {
    if (!word || typeof word.text !== 'string') continue;
    const text = word.text.replace(/\s+/g, ' ').trim();
    const start = Number(word.start);
    const end = Number(word.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0) continue;
    out.push({ text, start, end: Math.max(start, end) });
  }
  return out.sort((a, b) => a.start - b.start);
}

const joined = (words) => words.map((word) => word.text).join(' ');
const endsSentence = (text) => /[.!?…]["»«”’)]*$/.test(text);
const bare = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The words of one cue on at most `maxLines` lines: the break that makes the longest line shortest, avoiding a break after a weak
// word (an article, a preposition) where another break is about as good. Returns the lines as strings.
function breakLines(words, { maxChars, maxLines }) {
  const text = joined(words);
  if (maxLines <= 1 || text.length <= maxChars || words.length < 2) return [text];
  if (maxLines === 2 || words.length < 3) return twoLines(words, { maxChars });
  // three lines: the first break as for two lines of the whole, then the rest again in two when it is still too long
  const best = twoLines(words, { share: 1 / 3, maxChars });
  if (best.length < 2 || best[1].length <= maxChars) return best;
  const firstCount = best[0].split(' ').length;
  return [best[0], ...twoLines(words.slice(firstCount), { maxChars })];
}

// Whether the words fit one cue: every line within maxChars (a single word that is longer stands alone).
function fits(words, opts) {
  return breakLines(words, opts).every((line) => line.length <= opts.maxChars || !line.includes(' '));
}

function twoLines(words, { share = 0.5, maxChars = Infinity } = {}) {
  const total = joined(words).length;
  let best = null;
  for (let cut = 1; cut < words.length; cut += 1) {
    const first = joined(words.slice(0, cut));
    const second = joined(words.slice(cut));
    let score = Math.abs(first.length - total * share) + Math.max(first.length, second.length) * 0.01;
    // a line longer than the limit only where no break keeps both within it
    if (first.length > maxChars) score += 1000;
    if (second.length > maxChars && share === 0.5) score += 1000;
    if (WEAK_BREAK.has(bare(words[cut - 1].text))) score += 6;
    if (/[,;:]$/.test(words[cut - 1].text) || endsSentence(words[cut - 1].text)) score -= 4;
    if (!best || score < best.score) best = { score, lines: [first, second] };
  }
  return best ? best.lines : [joined(words)];
}

// The cues: [{ start, end, text, lines: [string], words: [{ text, start, end }] }]. The end of a cue is the end of its last word,
// at least MIN_SECONDS after its start where the next cue leaves room for that.
function buildCues(rawWords, options = {}) {
  const opts = normaliseOptions(options);
  const words = usableWords(rawWords);
  const room = opts.maxChars * opts.maxLines;
  const groups = [];
  let current = [];
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.start - previous.end;
      const length = joined(current).length;
      const withWord = length + 1 + word.text.length;
      const tooLong = withWord > room || !fits([...current, word], opts);
      const tooSlow = word.end - current[0].start > opts.maxSeconds;
      const pause = gap >= HARD_PAUSE_SEC || (gap >= SOFT_PAUSE_SEC && length >= room / 2);
      const sentence = endsSentence(previous.text) && length >= room * SENTENCE_SHARE;
      if (tooLong || tooSlow || pause || sentence) {
        groups.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const next = groups[index + 1];
    const start = group[0].start;
    let end = group[group.length - 1].end;
    if (end - start < MIN_SECONDS) end = next ? Math.min(start + MIN_SECONDS, next[0].start) : start + MIN_SECONDS;
    const lines = breakLines(group, opts);
    return { start: round3(start), end: round3(Math.max(end, start)), text: lines.join('\n'), lines, words: group.map((word) => ({ ...word })) };
  });
}

// 3723.456 -> "01:02:03,456" (SubRip) or "01:02:03.456" (WebVTT)
function stamp(seconds, separator) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const two = (n) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(rest).padStart(3, '0')}`;
}

function toSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.lines.join('\n')}\n`).join('\n');
}

// WebVTT: a cue text must not contain "-->", which is replaced by an arrow.
function toVtt(cues) {
  const body = cues.map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.lines.map((line) => line.replace(/-->/g, '→')).join('\n')}\n`).join('\n');
  return `WEBVTT\n\n${body}`;
}

// The timing JSON (as audio.lyrics_timing writes it) whose lines are the cues: "Burn in captions" then shows one cue at a time,
// with the times of its words for the karaoke styles.
function timingFromCues(cues, { duration, source = 'subtitles', language } = {}) {
  const words = [];
  const lines = cues.map((cue, index) => {
    for (const word of cue.words) words.push({ text: word.text, start: round3(word.start), end: round3(word.end), line: index });
    return { text: cue.lines.join(' '), start: cue.start, end: cue.end };
  });
  const last = cues[cues.length - 1];
  const known = Number.isFinite(duration) && duration > 0 ? duration : last ? last.end : 0;
  return { version: 1, source, duration: round3(known), words, lines, ...(language ? { language } : {}) };
}

// Everything at once: { cues, srt, vtt, timing } from words.
function subtitlesFromWords(words, options = {}) {
  const cues = buildCues(words, options);
  return { cues, srt: toSrt(cues), vtt: toVtt(cues), timing: timingFromCues(cues, options) };
}

module.exports = {
  MAX_CHARS_DEFAULT,
  MAX_CHARS_MIN,
  MAX_CHARS_MAX,
  MAX_LINES_DEFAULT,
  MAX_LINES_MAX,
  MAX_SECONDS_DEFAULT,
  MAX_SECONDS_MIN,
  MAX_SECONDS_MAX,
  MIN_SECONDS,
  usableWords,
  breakLines,
  buildCues,
  stamp,
  toSrt,
  toVtt,
  timingFromCues,
  subtitlesFromWords
};
