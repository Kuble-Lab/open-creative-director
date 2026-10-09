'use strict';

// The planner of the music video with the HUD (WP44, part 2): the logic behind the node music_video.hud_plan. Pure functions, no network, no files (the
// node, with the language model, the song slices and the costs, is lib/nodes/nodes-music-video-hud.js). What it makes:
//
//   planGrid()           the time grid, deterministic and without a language model: the windows of the singer (5 to 8 s, from a gap between two words to a
//                        gap, the end on a beat), the cuts on the beats and the strong hits, the units (one picture each: sung, story clip or still), the
//                        transitions and the drops
//   systemPrompt() / userPrompt()   what the model is told (the prompts of the brief, with their placeholders filled)
//   readAnswer()         the answer of the model, checked (the problems go back to the model in a second try)
//   completeContent()    the answer plus plain values (from the figure and the lines) for what the model did not deliver
//   buildPlan()          everything the next nodes need: the shots (music_video.edit), the lists of prompts, the graphics (graphics v1, lib/music-video-hud/
//                        graphics.js)
//   checkLayout()        the finished graphics through the layout of the renderer: which devices it leaves out (a wide device in a close-up)
//   boardText()          the board for the approval, in English; estimateCost() the price of the whole run
//
// A unit is the part of the film that one picture covers: a sung window (2 or 3 cuts: punch-ins on the beats), a story unit (a clip of the video model, 1 or
// 2 cuts) or a still (a picture with a slow move, 1 or 2 cuts). The model writes one plate (the picture) for every unit and the graphics for every lyric
// line; it never sets a time, a size or a position: the code does (the graphics show from their own word on, the layout of the renderer keeps them off the face).

const planLib = require('../music-video-plan');
const lyricsTiming = require('../lyrics-timing');
const languageLib = require('../language-detect');
const graphicsLib = require('./graphics');
const themes = require('./themes');

const { LIMITS } = graphicsLib;

const FPS = graphicsLib.FPS;
const MAX_UNITS = planLib.MAX_SCENES;
const MAX_LINES = graphicsLib.MAX.lines;
const MAX_WORDS = graphicsLib.MAX.words;
const MAX_DEVICES = graphicsLib.MAX.devices;
// how many problems of an answer are told to the model in the second try
const MAX_PROBLEMS_TOLD = 30;

const round3 = (value) => Math.round(value * 1000) / 1000;
const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = (seconds) => Math.round(seconds * 1000);

/* ---------- the settings ---------- */

const DEFAULTS = Object.freeze({ cutsPerMinute: 24, maxUnits: 40, lipsyncSecondsPerMinute: 22, motionShare: 0.3, clipSeconds: 5 });
const RANGES = Object.freeze({ cutsPerMinute: [14, 40], maxUnits: [6, MAX_UNITS], lipsyncSecondsPerMinute: [0, 60], motionShare: [0, 0.6], clipSeconds: [2, 10] });

function normalizeSettings(options = {}) {
  const read = (name) => {
    const value = Number(options[name]);
    return Number.isFinite(value) ? clamp(value, RANGES[name][0], RANGES[name][1]) : DEFAULTS[name];
  };
  return {
    cutsPerMinute: read('cutsPerMinute'),
    maxUnits: Math.round(read('maxUnits')),
    lipsyncSecondsPerMinute: read('lipsyncSecondsPerMinute'),
    motionShare: read('motionShare'),
    clipSeconds: read('clipSeconds')
  };
}

/* ---------- the figure ---------- */

const FIGURE_KEY = /^\s*(NAME|FULL|SHORT|CREDIT)\s*:\s*(.*)$/i;
// lines of the text of the person that are notes for the model, not forms of the identity
const NOTE_KEY = /^\s*(LOOKS?|FACE|NEVER|WARDROBE|VOICE|STYLE|NOTES?)\s*:/i;
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// The text of the field "Figure": the lines NAME:, FULL: (the full identity form, for close shots), SHORT: (for wide shots) and CREDIT: (the line for the end
// card); other labelled lines (LOOKS:, FACE:, NEVER: ...) are notes for the model. Without a FULL: line the free text (what is none of the labelled lines) is the
// full form, and without any labels the whole text is; the model then derives the short form (the answer's "figure_short").
function parseFigure(input) {
  const raw = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  const found = {};
  const notes = [];
  const free = [];
  let current = null;
  for (const line of raw.split('\n')) {
    const match = FIGURE_KEY.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      found[current] = squash(match[2]);
    } else if (NOTE_KEY.test(line)) {
      current = 'note';
      notes.push(squash(line));
    } else if (!line.trim()) {
      current = null;
    } else if (current === 'note') {
      notes[notes.length - 1] = squash(`${notes[notes.length - 1]} ${line}`);
    } else if (current) {
      found[current] = squash(`${found[current]} ${line}`);
    } else {
      free.push(line);
    }
  }
  const freeText = squash(free.join(' '));
  const full = found.full || freeText || squash(raw);
  if (found.full && freeText) notes.push(freeText);
  const name = squash(found.name || '');
  return {
    raw,
    name,
    full,
    short: found.short || '',
    credit: found.credit || '',
    notes,
    hasShort: Boolean(found.short),
    hasFull: Boolean(found.full),
    hudName: name ? name.toUpperCase().slice(0, 16).trim() : ''
  };
}

// A short form from the full one for the case that the model wrote none: the first parts of the sentence.
function deriveShort(full) {
  const parts = String(full || '').split(/,\s*/);
  let out = '';
  for (const part of parts) {
    if (out && `${out}, ${part}`.length > 190) break;
    out = out ? `${out}, ${part}` : part;
    if (out.length >= 110) break;
  }
  return out || squash(full);
}

/* ---------- the song: sections ---------- */

// the mean length of a cut by the kind of section (the Stilblatt of the reference video), in seconds
const CUT_SECONDS = Object.freeze({ intro: 1.3, verse: 1.6, chorus: 2.7, bridge: 2.2, drop: 1.6, outro: 4.4 });
const MIN_CHAPTER_SEC = 6;
const NAMED_KINDS = [
  ['drop', /\bdrop\b/i],
  ['intro', /intro|vorspiel|introducci/i],
  ['outro', /outro|ending|schluss|coda|\bfinal/i],
  ['bridge', /bridge|\bbreak\b|zwischenspiel|puente|middle\s*8/i],
  ['chorus', /chorus|refrain|\bhook\b|ritornell|estribillo|\bcoro\b/i],
  ['verse', /verse|strophe|vers[eo]\b|couplet|estrofa|pre-?chorus|pre-?refrain/i]
];

// The sections of the analysis as the chapters of the film: a section shorter than MIN_CHAPTER_SEC joins the one before it (the first one joins the next).
function chapterSections(analysis) {
  const list = analysis.sections.map((section) => ({ ...section }));
  let index = 0;
  while (list.length > 1 && index < list.length) {
    const section = list[index];
    if (section.end - section.start >= MIN_CHAPTER_SEC) {
      index += 1;
      continue;
    }
    if (index > 0) {
      list[index - 1].end = section.end;
      list.splice(index, 1);
    } else {
      list[1].start = section.start;
      list.splice(0, 1);
    }
    index = 0;
  }
  return list.map((section, position) => ({
    index: position,
    name: section.name,
    start: position === 0 ? 0 : round3(section.start),
    end: position === list.length - 1 ? analysis.duration : round3(section.end),
    energy: round3(planLib.energyBetween(analysis.energy, section.start, section.end) || section.energy || 0)
  }));
}

// The kind of every section: from its name when it says (Verse, Chorus, Refrain, Bridge, Drop ...), else from its place and its loudness: the first one is the
// intro, the last one the outro, the loud ones are choruses, one that is far louder than the one before it is a drop.
function sectionKinds(sections) {
  const peak = Math.max(0, ...sections.map((section) => section.energy));
  return sections.map((section, index) => {
    for (const [kind, pattern] of NAMED_KINDS) if (pattern.test(section.name)) return kind;
    const loud = peak > 0 && section.energy >= 0.8 * peak;
    if (sections.length > 2 && index === sections.length - 1 && !loud) return 'outro';
    if (sections.length > 1 && index === 0 && !loud) return 'intro';
    if (loud) {
      const before = index > 0 ? sections[index - 1].energy : null;
      return before !== null && peak > 0 && before <= 0.7 * section.energy && section.energy >= 0.95 * peak ? 'drop' : 'chorus';
    }
    return 'verse';
  });
}

const sectionIndexAt = (sections, time) => {
  let found = 0;
  for (const section of sections) if (time >= section.start - 1e-9) found = section.index;
  return found;
};

/* ---------- the song: the lyric lines with their words ---------- */

const cleanWord = (value) => graphicsLib.cleanText(value, 32);

// How far from its line a word may lie and still belong to it (the times of the words and of the lines come from one alignment, but are rounded apart).
const WORD_REACH_S = 0.15;

// Every word of the timing belongs to ONE line, the one it lies in or is nearest to (within WORD_REACH_S): two lines that follow each other closely must not both
// take the word between them. Returns one list of timing words for each line.
function wordsByLine(read, timingWords) {
  const lists = read.map(() => []);
  for (const word of timingWords) {
    if (!word || !Number.isFinite(word.start)) continue;
    let best = -1;
    let bestDistance = WORD_REACH_S + 1e-9;
    read.forEach((line, at) => {
      const distance = word.start < line.start ? line.start - word.start : word.start > line.end ? word.start - line.end : 0;
      if (distance < bestDistance - 1e-9) {
        best = at;
        bestDistance = distance;
      }
    });
    if (best >= 0) lists[best].push(word);
  }
  return lists;
}

// The words of a line [{ text, start, end }]: the words of the timing that are sung in it (`inside`, see wordsByLine); without words (a timing of lines only) the
// text of the line spread over its time by the length of the words.
function wordsFor(line, inside) {
  const words = [];
  for (const word of inside) {
    const text = cleanWord(word.text);
    if (!text) continue;
    words.push({ text, start: round3(word.start), end: round3(Math.max(word.start + 0.05, Number.isFinite(word.end) ? word.end : word.start + 0.3)) });
  }
  if (words.length) return words.slice(0, MAX_WORDS);
  const tokens = String(line.text).split(/\s+/).map(cleanWord).filter(Boolean).slice(0, MAX_WORDS);
  const weight = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  let at = line.start;
  return tokens.map((token) => {
    const length = ((token.length + 1) / weight) * (line.end - line.start);
    const word = { text: token, start: round3(at), end: round3(Math.max(at + 0.05, at + length - 0.03)) };
    at += length;
    return word;
  });
}

// The lines of the timing with their words, in order, without overlaps, each in the chapter it sings in:
//   [{ index, text, start, end, words, section }]
// A line without a word that can be drawn is left out (the lines of the graphics and of the prompt have the same numbers).
function readLyrics(timingInput, duration, sections) {
  const timing = lyricsTiming.parseTiming(typeof timingInput === 'string' ? timingInput : JSON.stringify(timingInput || {}));
  const read = planLib.readLines(timing || { lines: [] }, duration);
  const out = [];
  const inside = wordsByLine(read, timing ? timing.words || [] : []);
  for (const [at, line] of read.entries()) {
    const words = wordsFor(line, inside[at]);
    if (!words.length) continue;
    words.sort((a, b) => a.start - b.start);
    const start = round3(Math.min(line.start, words[0].start));
    const end = round3(Math.max(line.end, words[words.length - 1].end));
    out.push({ index: out.length, text: squash(line.text), start, end, words, section: 0 });
    if (out.length >= MAX_LINES) break;
  }
  for (const line of out) line.section = sectionIndexAt(sections, (line.words[0].start + line.words[line.words.length - 1].end) / 2);
  return out;
}

const lastWordEnd = (line) => line.words[line.words.length - 1].end;
const firstWordStart = (line) => line.words[0].start;

/* ---------- the beats and the places where a cut may be ---------- */

// A song without a clear pulse has no beats in a hand-written analysis: a regular grid at the tempo of the song or 120 BPM.
function regularBeats(bpm, duration) {
  const period = 60 / (bpm > 30 && bpm < 300 ? bpm : 120);
  const out = [];
  for (let at = period; at < duration - 0.2; at += period) out.push(round3(at));
  return out;
}

// The places where a cut may be: every beat, and the strong hits that are not on a beat (a hit within 25 ms of a beat only gives that beat its strength).
//   [{ t, down (the first beat of a bar), strength (0 .. 1: of the hit on it), offBeat }]
function snapPoints(analysis, grid) {
  const beats = analysis.beats.length ? analysis.beats : regularBeats(analysis.bpm, analysis.duration);
  const downs = new Set(grid.downbeats.map(keyOf));
  const points = beats.map((time) => ({ t: time, down: downs.has(keyOf(time)), strength: 0, offBeat: false }));
  for (const hit of grid.hits) {
    if (hit.strength < 0.5) continue;
    let near = null;
    for (const point of points) if (!point.offBeat && Math.abs(point.t - hit.t) <= 0.025 && (!near || Math.abs(point.t - hit.t) < Math.abs(near.t - hit.t))) near = point;
    if (near) near.strength = Math.max(near.strength, hit.strength);
    else points.push({ t: round3(hit.t), down: false, strength: hit.strength, offBeat: true });
  }
  return points.sort((a, b) => a.t - b.t);
}

// The place for a cut near `ideal` (at most `tolerance` away, between `from` and `to`): the nearest one, a strong hit or the first beat of a bar counting
// as a little nearer than they are, a hit between two beats as a little farther. null when there is none.
function pickSnap(snaps, ideal, tolerance, from, to) {
  let best = null;
  for (const point of snaps) {
    if (point.t < from - 1e-9 || point.t > to + 1e-9) continue;
    const distance = Math.abs(point.t - ideal);
    if (distance > tolerance) continue;
    const score = distance - (point.strength >= 0.8 ? 0.2 : 0) - (point.down ? 0.12 : 0) + (point.offBeat ? 0.06 : 0);
    if (!best || score < best.score - 1e-9) best = { point, score };
  }
  return best ? best.point : null;
}

/* ---------- the windows of the singer ---------- */

// A window for the lip sync: 5 to 8 s (the sound must be at least 5 s long: PERFORMANCE_MIN_SEC adds a margin for the rounding), begins in a gap between two words
// 0.3 to 0.7 s before its first word and ends in a gap, on a beat; it holds whole lines, one after the other.
const WINDOW_MIN = planLib.PERFORMANCE_MIN_SEC;
const WINDOW_MAX = 8;
const LEAD_MIN = 0.3;
const LEAD_MAX = 0.7;
const TAIL_MIN = 0.12;
const GAP_MARGIN = 0.04;
const SUNG_SHARE_MIN = 0.6;

// All the windows that the lines allow, each from the shortest run of lines that is long enough (as music_video.plan does): { start, end, first, last, score }.
// `relaxed`: a window may end in the gap without a beat (for a song whose lines are too close for a beat to fall between them).
function windowCandidates({ lines, snaps, sections, kinds, analysis, relaxed }) {
  const duration = analysis.duration;
  const out = [];
  for (let first = 0; first < lines.length; first += 1) {
    const firstWord = firstWordStart(lines[first]);
    const before = first > 0 ? lastWordEnd(lines[first - 1]) : 0;
    const low = Math.max(firstWord - LEAD_MAX, before + GAP_MARGIN, 0);
    const high = firstWord - LEAD_MIN;
    let start;
    if (low <= high + 1e-9) {
      const beat = pickSnap(snaps, firstWord - 0.5, 1, low, high);
      start = beat ? beat.t : clamp(firstWord - 0.5, low, high);
    } else if (first === 0 && before === 0 && firstWord >= 0.12) {
      // the voice comes at the very start of the song: the window starts with the song
      start = 0;
    } else if (relaxed && firstWord - before >= 0.12) {
      // the lines are too close for a lead of 0.3 s: the window starts in the middle of the gap
      start = (before + firstWord) / 2;
    } else {
      continue;
    }
    start = round3(start);
    for (let last = first; last < lines.length; last += 1) {
      const lastEnd = lastWordEnd(lines[last]);
      if (lastEnd + TAIL_MIN - start > WINDOW_MAX) break;
      const next = last + 1 < lines.length ? firstWordStart(lines[last + 1]) : duration;
      const endLow = Math.max(lastEnd + TAIL_MIN, start + WINDOW_MIN);
      const endHigh = Math.min(next - GAP_MARGIN, start + WINDOW_MAX, duration);
      if (endLow > endHigh + 1e-9) continue;
      let end;
      const found = snaps.find((point) => point.t >= endLow - 1e-9 && point.t <= endHigh + 1e-9);
      if (found) end = found.t;
      else if (duration >= endLow - 1e-9 && duration <= endHigh + 1e-9) end = duration;
      else if (relaxed) end = round3(endLow);
      else continue;
      // mostly sung: the words of the lines in it against the whole length
      let sung = 0;
      for (let index = first; index <= last; index += 1) sung += lastWordEnd(lines[index]) - firstWordStart(lines[index]);
      if (sung / (end - start) < SUNG_SHARE_MIN) continue;
      const middle = (start + end) / 2;
      const kind = kinds[sectionIndexAt(sections, middle)];
      out.push({ start, end, first, last, score: planLib.energyBetween(analysis.energy, start, end) + (kind === 'chorus' || kind === 'drop' ? 0.25 : 0) });
      break;
    }
  }
  return out;
}

// The windows that are made: as many as the seconds of lip sync per minute ask for, the choruses and the loud parts first, spread over the song.
function chooseWindows({ candidates, settings, duration }) {
  const target = (settings.lipsyncSecondsPerMinute * duration) / 60;
  if (!(target > 0) || !candidates.length) return [];
  // the units are a limit: between two windows (and before the first, behind the last) there is at least one unit of its own
  const cap = Math.max(0, Math.floor((settings.maxUnits - 1) / 2));
  if (cap < 1) return [];
  const length = (list) => list.reduce((sum, item) => sum + item.end - item.start, 0);
  const maxCount = Math.min(cap, candidates.length);
  let count = clamp(Math.round(target / 6.2), 1, maxCount);
  let picked = planLib.pickWindows(candidates, count, duration);
  while (picked.length === count && length(picked) < 0.9 * target && count < maxCount) {
    count += 1;
    picked = planLib.pickWindows(candidates, count, duration);
  }
  return picked.map((window) => candidates.find((candidate) => Math.abs(candidate.start - window.start) < 1e-6 && Math.abs(candidate.end - window.end) < 1e-6)).filter(Boolean);
}

// The cuts inside a window: 2 or 3 punch-ins on the beats (1.0 / 1.35 / 1.0). `hook`: the window is the first unit, its first cut is at most 1.5 s long.
const MIN_CUT = 0.9;
const HOOK_MAX_CUT = 1.5;
const HOOK_MIN_CUT = 0.6;
const PUNCH_IN = 1.35;
const PUNCH_IN_STILL = 1.3;

function windowCuts(window, snaps, hook) {
  const length = window.end - window.start;
  const count = length < 6.2 ? 2 : 3;
  const ideals = [];
  if (hook) {
    ideals.push(window.start + 1.35);
    if (count === 3) ideals.push(window.start + 1.35 + (length - 1.35) / 2);
  } else {
    for (let index = 1; index < count; index += 1) ideals.push(window.start + (index * length) / count);
  }
  const inner = [];
  let previous = window.start;
  for (const [position, ideal] of ideals.entries()) {
    const from = position === 0 && hook ? window.start + HOOK_MIN_CUT : previous + 1.2;
    const to = position === 0 && hook ? window.start + HOOK_MAX_CUT : window.end - 1.2;
    const point = pickSnap(snaps, ideal, 0.45 * (length / count), from, to) || pickSnap(snaps, ideal, length, from, to);
    if (!point) continue;
    inner.push(point.t);
    previous = point.t;
  }
  const edges = [window.start, ...inner, window.end];
  const zooms = [1, PUNCH_IN, 1];
  return edges.slice(0, -1).map((start, index) => ({ start, end: edges[index + 1], zoom: edges.length === 2 ? 1 : zooms[index % 3] }));
}

/* ---------- the cuts between the windows ---------- */

// How many cuts a stretch of `length` seconds gets: by the mean length of a cut, at most `maxCut` long each and at least MIN_CUT.
function cutCount(length, mean, maxCut) {
  const most = Math.max(1, Math.floor(length / MIN_CUT));
  const wanted = Math.max(Math.round(length / mean), Math.ceil(length / maxCut - 1e-9));
  return Math.max(1, Math.min(wanted, most));
}

// The cuts of a stretch [from, to]: `count` of about the same length, each cut on the place that is nearest to its ideal time (beat, first beat of a bar, strong
// hit); a cut that is longer than `maxCut` is cut again. `hook`: the first cut is at most 1.5 s long.
function fillStretch({ from, to, count, snaps, maxCut, hook }) {
  const length = to - from;
  const points = [];
  let previous = from;
  if (hook && length > HOOK_MAX_CUT + MIN_CUT) {
    const first = pickSnap(snaps, from + 1.2, 0.6, from + HOOK_MIN_CUT, from + HOOK_MAX_CUT);
    if (first) {
      points.push(first.t);
      previous = first.t;
    }
  }
  const remaining = Math.max(1, count - points.length);
  const step = (to - previous) / remaining;
  for (let index = 1; index < remaining; index += 1) {
    const ideal = previous + step * index;
    const point = pickSnap(snaps, ideal, Math.max(0.3, 0.45 * step), (points.length ? points[points.length - 1] : from) + MIN_CUT, to - MIN_CUT);
    if (point) points.push(point.t);
  }
  // no cut longer than maxCut
  let edges = [from, ...points, to];
  for (let guard = 0; guard < 40; guard += 1) {
    const at = edges.findIndex((edge, index) => index + 1 < edges.length && edges[index + 1] - edge > maxCut + 1e-9);
    if (at < 0) break;
    const a = edges[at];
    const b = edges[at + 1];
    const point = pickSnap(snaps, (a + b) / 2, (b - a) / 2 - MIN_CUT, a + MIN_CUT, b - MIN_CUT);
    if (!point) break;
    edges = [...edges.slice(0, at + 1), point.t, ...edges.slice(at + 1)];
  }
  return edges.slice(0, -1).map((start, index) => ({ start, end: edges[index + 1], zoom: 1 }));
}

/* ---------- the units ---------- */

// Takes the cuts of a piece two by two where there would be too many units: `needed` pairs of neighbours (in one piece: not across a window or a change of chapter)
// that are together at most `limit` long (a clip is `clip_seconds` long), the shortest pairs first. The first cut of the film stays alone (the hook). Returns the
// indexes of the first cut of every pair, or null when there are not enough pairs.
function choosePairs(items, needed, limit) {
  if (needed <= 0) return [];
  const candidates = [];
  for (let index = 0; index + 1 < items.length; index += 1) {
    const a = items[index];
    const b = items[index + 1];
    if (!a.piece && a.piece !== 0) continue;
    if (a.piece !== b.piece || a.lock || b.lock) continue;
    const length = b.end - a.start;
    if (length <= limit + 1e-9) candidates.push({ index, length });
  }
  candidates.sort((x, y) => x.length - y.length || x.index - y.index);
  const used = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (used.has(candidate.index) || used.has(candidate.index + 1)) continue;
    used.add(candidate.index);
    used.add(candidate.index + 1);
    pairs.push(candidate.index);
    if (pairs.length >= needed) break;
  }
  return pairs.length >= needed ? pairs : null;
}

// The units for a target number of cuts: the windows of the singer and the pieces between them (and between the changes of chapter) cut into cuts on the beats; when
// the units are more than `maxUnits` allows, neighbouring cuts share a unit. Returns { units, scale }, or { needed } (how many units there are at the least) when the units
// cannot be fitted.
//   windows    [{ start, end }] in order
//   cutsAt     the times at which a chapter begins and a cut is made (on a beat, outside the windows)
function layOutUnits({ windows, cutsAt, kinds, sections, snaps, settings, duration, targetCuts }) {
  // the intervals of the film: the windows, and the pieces in between cut at the changes of chapter
  const boundaries = [0, duration];
  for (const window of windows) boundaries.push(window.start, window.end);
  for (const at of cutsAt) boundaries.push(at);
  const times = [...new Set(boundaries.map(keyOf))].sort((a, b) => a - b).map((key) => key / 1000);
  const intervals = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const from = times[index];
    const to = times[index + 1];
    const window = windows.find((item) => Math.abs(item.start - from) < 1e-6 && Math.abs(item.end - to) < 1e-6);
    intervals.push(window ? { window, from, to } : { from, to });
  }
  const kindAt = (time) => kinds[sectionIndexAt(sections, time)];
  const meanAt = (interval, scale) => CUT_SECONDS[kindAt((interval.from + interval.to) / 2)] * scale;
  const windowCutTotal = windows.reduce((sum, window) => sum + (window.end - window.start < 6.2 ? 2 : 3), 0);
  const total = (scale) => windowCutTotal + intervals.reduce((sum, interval) => (interval.window ? sum : sum + cutCount(interval.to - interval.from, meanAt(interval, scale), settings.clipSeconds)), 0);
  // the scale of the mean lengths of the Stilblatt that gives the number of cuts that is asked for (the larger one when two are as near)
  let scale = 1;
  let gap = Infinity;
  for (let candidate = 0.3; candidate <= 6; candidate += 0.02) {
    const difference = Math.abs(total(candidate) - targetCuts);
    if (difference < gap - 1e-9 || (Math.abs(difference - gap) <= 1e-9 && candidate > scale)) {
      gap = difference;
      scale = candidate;
    }
  }
  const items = [];
  intervals.forEach((interval, index) => {
    if (interval.window) {
      items.push({ type: 'window', window: interval.window, start: interval.from, end: interval.to, hook: index === 0 && interval.from < 0.001 });
      return;
    }
    const hook = index === 0;
    const cuts = fillStretch({ from: interval.from, to: interval.to, count: cutCount(interval.to - interval.from, meanAt(interval, scale), settings.clipSeconds), snaps, maxCut: settings.clipSeconds, hook });
    cuts.forEach((cut, position) => items.push({ type: 'cut', start: cut.start, end: cut.end, piece: index, lock: hook && position === 0 }));
  });
  const pairs = choosePairs(items, items.length - settings.maxUnits, settings.clipSeconds);
  if (pairs === null) return { needed: items.length };
  const paired = new Set(pairs);
  const units = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'window') {
      units.push({ kind: 'performance', start: item.start, end: item.end, cuts: windowCuts(item.window, snaps, item.hook) });
    } else if (paired.has(index)) {
      const next = items[index + 1];
      units.push({ kind: 'still', start: item.start, end: next.end, cuts: [{ start: item.start, end: item.end, zoom: 1 }, { start: next.start, end: next.end, zoom: PUNCH_IN_STILL }] });
      index += 1;
    } else {
      units.push({ kind: 'still', start: item.start, end: item.end, cuts: [{ start: item.start, end: item.end, zoom: 1 }] });
    }
  }
  return { units, scale };
}

// Which of the units that the singer does not sing are clips of the video model (`motion_share` of them): the longest ones first and the loudest, since a clip
// costs the same whatever part of it is used. The first unit (the portrait of the hook) stays a still.
function chooseStories(units, share) {
  const open = units.filter((unit) => unit.kind !== 'performance' && unit.index > 0);
  const count = Math.min(open.length, Math.round(share * units.filter((unit) => unit.kind !== 'performance').length));
  if (count <= 0) return;
  const ranked = open.slice().sort((a, b) => b.end - b.start + 1.5 * b.energy - (a.end - a.start + 1.5 * a.energy) || a.index - b.index);
  // not three clips of the video model in a row (a rhythm of picture, picture, clip): the first round skips a unit that would make a run of three
  let made = 0;
  for (const strict of [true, false]) {
    for (const unit of ranked) {
      if (made >= count) return;
      if (unit.kind === 'story') continue;
      const before = units[unit.index - 1];
      const beforeThat = units[unit.index - 2];
      const after = units[unit.index + 1];
      const afterThat = units[unit.index + 2];
      const run = (a, b) => a && b && a.kind === 'story' && b.kind === 'story';
      if (strict && (run(before, beforeThat) || run(before, after) || run(after, afterThat))) continue;
      unit.kind = 'story';
      made += 1;
    }
  }
}

/* ---------- transitions and drops ---------- */

const GLITCH_HIT = 0.8;

// The transition at the start of every cut: `flash` at a chapter that starts with a jump in the loudness, `wipe` at some other changes of chapter, `glitch` on a cut that
// lies on a strong hit, else `cut`. At most every fourth cut is not a hard cut (the changes of chapter first, then the hardest hits).
function chooseTransitions({ cuts, sections, snaps, analysis }) {
  const transitions = cuts.map(() => 'cut');
  const budget = Math.floor(cuts.length / 4);
  if (budget < 1) return transitions;
  const candidates = [];
  let wipes = 0;
  cuts.forEach((cut, index) => {
    if (index === 0) return;
    const section = sections.find((item) => item.index > 0 && Math.abs(item.start - cut.start) <= 0.6 && item.cut);
    if (section) {
      const before = planLib.energyBetween(analysis.energy, Math.max(0, cut.start - 4), cut.start);
      const after = planLib.energyBetween(analysis.energy, cut.start, cut.start + 4);
      if (after - before >= 0.12) candidates.push({ index, kind: 'flash', rank: 0 });
      else {
        wipes += 1;
        if (wipes % 2 === 1) candidates.push({ index, kind: 'wipe', rank: 1 });
      }
      return;
    }
    const point = snaps.find((item) => Math.abs(item.t - cut.start) < 1e-6);
    if (point && point.strength >= GLITCH_HIT) candidates.push({ index, kind: 'glitch', rank: 2 - point.strength });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const candidate of candidates.slice(0, budget)) transitions[candidate.index] = candidate.kind;
  return transitions;
}

// The drops: the strongest jumps of the loudness (the mean of the next 4 s against the 4 s before), at most 3, 20 s apart, on the first beat of a bar.
function findDrops(analysis, grid, sections, kinds) {
  const energy = analysis.energy;
  const found = [];
  for (let second = 6; second + 4 <= energy.length && second < analysis.duration - 2; second += 1) {
    const before = planLib.energyBetween(energy, second - 4, second);
    const after = planLib.energyBetween(energy, second, second + 4);
    if (after - before >= 0.15) found.push({ at: second, rise: after - before });
  }
  sections.forEach((section) => {
    if (kinds[section.index] === 'drop' && section.start >= 6) found.push({ at: section.start, rise: 1 });
  });
  found.sort((a, b) => b.rise - a.rise || a.at - b.at);
  const drops = [];
  for (const candidate of found) {
    if (drops.length >= 3) break;
    const down = grid.downbeats.filter((time) => Math.abs(time - candidate.at) <= 1.5).sort((a, b) => Math.abs(a - candidate.at) - Math.abs(b - candidate.at))[0];
    const at = round3(down === undefined ? candidate.at : down);
    if (at < 6 || at > analysis.duration - 1 || drops.some((other) => Math.abs(other - at) < 20)) continue;
    drops.push(at);
  }
  return drops.sort((a, b) => a - b);
}

/* ---------- the grid ---------- */

// The film cut on the beats, without a language model. Returns
//   { duration, bpm, settings, sections, kinds, lines, units, cuts, drops, music, warnings, stats }
//   sections  the chapters [{ index, name, kind, start, end, energy, cut }] (`cut`: the chapter begins at a cut)
//   lines     the lyric lines with their words [{ index, text, start, end, words, section }]
//   units     [{ index, kind: 'performance'|'story'|'still', start, end, section, energy, lines: [index], cuts: [{ start, end, zoom, transition }], windowSeconds }]
//   cuts      all cuts in order, with the number of their unit: [{ start, end, unit, zoom, transition }]
//   music     { bpm, beats, downbeats, hits, energy } for graphics v1
//   warnings  codes: NO_WINDOWS (no stretch of lines long enough for the lip sync), FEWER_CUTS (the units do not allow so many cuts), OFF_BEAT_WINDOWS
// Throws MUSICVIDEO_ANALYSIS_INVALID (no usable analysis) and HUDPLAN_NO_LINES (no sung line in the timing).
function planGrid(analysisInput, timingInput, options = {}) {
  const analysis = planLib.parseAnalysis(analysisInput);
  if (!analysis) throw Object.assign(new Error('The analysis of the song is missing or unreadable'), { code: 'MUSICVIDEO_ANALYSIS_INVALID' });
  const beatGrid = planLib.parseBeatGrid(analysisInput);
  const settings = normalizeSettings(options);
  const duration = analysis.duration;
  const warnings = [];
  const sections = chapterSections(analysis);
  const kinds = sectionKinds(sections);
  const lines = readLyrics(timingInput, duration, sections);
  if (!lines.length) throw Object.assign(new Error('The timing has no sung line: there is nothing to put a graphic on'), { code: 'HUDPLAN_NO_LINES' });
  const snaps = snapPoints(analysis, beatGrid);

  // 1. the windows of the singer
  let candidates = windowCandidates({ lines, snaps, sections, kinds, analysis, relaxed: false });
  let windows = chooseWindows({ candidates, settings, duration });
  if (settings.lipsyncSecondsPerMinute > 0 && windows.length < Math.min(2, Math.round((settings.lipsyncSecondsPerMinute * duration) / 60 / 6.2))) {
    // the lines are so close that no beat falls into the gaps: a window may end in a gap without one
    const relaxed = chooseWindows({ candidates: windowCandidates({ lines, snaps, sections, kinds, analysis, relaxed: true }), settings, duration });
    if (relaxed.length > windows.length) {
      windows = relaxed;
      warnings.push('OFF_BEAT_WINDOWS');
    }
  }
  if (settings.lipsyncSecondsPerMinute > 0 && !windows.length) warnings.push('NO_WINDOWS');
  windows.sort((a, b) => a.start - b.start);

  // 2. the chapters that begin at a cut: on a beat or a hit within 0.6 s, outside the windows, 1.2 s from every other cut
  const fixed = [0, duration, ...windows.flatMap((window) => [window.start, window.end])];
  const cutsAt = [];
  for (const section of sections.slice(1)) {
    const point = pickSnap(snaps, section.start, 0.6, 0, duration);
    if (!point) continue;
    const insideWindow = windows.some((window) => point.t > window.start - 0.05 && point.t < window.end + 0.05);
    if (insideWindow || [...fixed, ...cutsAt].some((other) => Math.abs(other - point.t) < 1.2)) continue;
    cutsAt.push(point.t);
    section.start = point.t;
    section.cut = true;
  }
  sections.forEach((section, index) => {
    section.end = index + 1 < sections.length ? sections[index + 1].start : duration;
    section.kind = kinds[index];
    section.cut = Boolean(section.cut);
  });

  // 3. the units: for as many cuts as asked for; when the units are too many for the limit, fewer cuts
  const requested = Math.max(1, Math.round((duration * settings.cutsPerMinute) / 60));
  let target = requested;
  let laid = null;
  for (let attempt = 0; attempt < 14 && !(laid && laid.units); attempt += 1) {
    laid = layOutUnits({ windows, cutsAt, kinds, sections, snaps, settings, duration, targetCuts: target });
    if (!laid.units) target = Math.max(1, Math.floor(target * 0.92));
  }
  if (!laid.units) {
    // every unit that is not sung is at most one clip long: a long song needs more units than allowed (`needed` is the number at the fewest cuts)
    throw Object.assign(new Error(`The song is ${Math.round(duration)} s long: with units of at most ${settings.clipSeconds} s it needs about ${laid.needed} units, but at most ${settings.maxUnits} are allowed: raise the units (up to ${MAX_UNITS}) or the clip length, or use a shorter song`), {
      code: 'HUDPLAN_TOO_LONG',
      data: { seconds: Math.round(duration), units: settings.maxUnits, clip: settings.clipSeconds, needed: laid.needed }
    });
  }
  const units = laid.units;
  if (target < requested) warnings.push('FEWER_CUTS');

  // 4. what every unit knows: its chapter, its loudness, its lines; which units are clips of the video model
  units.forEach((unit, index) => {
    unit.index = index;
    unit.duration = round3(unit.end - unit.start);
    unit.section = sectionIndexAt(sections, (unit.start + unit.end) / 2);
    unit.energy = round3(planLib.energyBetween(analysis.energy, unit.start, unit.end));
    unit.lines = lines
      .filter((line) => Math.min(unit.end, lastWordEnd(line)) - Math.max(unit.start, firstWordStart(line)) >= 0.3)
      .map((line) => line.index);
  });
  chooseStories(units, settings.motionShare);
  let clip = { story: 0, performance: 0, still: 0 };
  for (const unit of units) unit.clip = clip[unit.kind]++;

  // 5. the cuts in order, with their transitions
  const cuts = [];
  for (const unit of units) for (const cut of unit.cuts) cuts.push({ start: round3(cut.start), end: round3(cut.end), unit: unit.index, zoom: cut.zoom, transition: 'cut' });
  const transitions = chooseTransitions({ cuts, sections, snaps, analysis });
  cuts.forEach((cut, index) => {
    cut.transition = transitions[index];
  });
  let at = 0;
  for (const unit of units) {
    unit.cuts = cuts.slice(at, at + unit.cuts.length);
    at += unit.cuts.length;
  }

  const sung = units.filter((unit) => unit.kind === 'performance');
  return {
    duration,
    bpm: analysis.bpm,
    settings,
    sections,
    kinds,
    lines,
    units,
    cuts,
    drops: findDrops(analysis, beatGrid, sections, kinds),
    music: {
      bpm: analysis.bpm || 120,
      beats: snaps.filter((point) => !point.offBeat).map((point) => point.t),
      downbeats: beatGrid.downbeats,
      hits: beatGrid.hits.map((hit) => ({ t: round3(hit.t), strength: round3(hit.strength) })),
      energy: analysis.energy.map((value) => round3(value))
    },
    warnings,
    stats: {
      cuts: cuts.length,
      cutsPerMinute: round2((cuts.length * 60) / duration),
      requestedCuts: requested,
      units: units.length,
      sung: sung.length,
      story: units.filter((unit) => unit.kind === 'story').length,
      still: units.filter((unit) => unit.kind === 'still').length,
      lipsyncSeconds: round2(sung.reduce((sum, unit) => sum + unit.duration, 0))
    }
  };
}



/* ---------- the prompts ---------- */

// The texts of the brief for the planner. Only the {{...}} places are filled in (fill()); nothing else in these texts changes. (The brief shows the format of the rows of
// {{sections}}, {{lines}} and {{units}} in a note behind each placeholder: those notes are for the code, not for the model, and are not sent; sectionRows, lineRows and
// unitRows write exactly those rows, the units with their chapter at the end.)
const SYSTEM_TEMPLATE = `You are the director and motion designer of an AI pop music video: a photoreal AI singer, hard cuts on the beat, and on top of every shot a dense layer of graphics that explains each lyric line like an interface would. {{theme_block}} Your board decides whether the film is a banger or slop. Be specific, witty and concrete; never generic.

You receive the song (sections, lines with times, the units the code has already cut on the beat), the figure, the idea and the style. You answer with ONE JSON object and nothing else, in exactly the schema at the end.

THE FILM
- Write a treatment: one paragraph, what the film is about and why it is funny or moving. The lyrics carry the story; the pictures and graphics make every line land in one glance.
- Pick ONE through-line device: an on-screen counter that escalates across the film and pays off at the end (examples: "BREAKUP TEXTS DRAFTED 01 → 07 → 49 → 2,401", "HOURS AWAKE 18 → 36 → 72 → 410", "FOLLOWERS LOST ×12 → ×1,200 → ×980,000"). One value per chapter, always growing, the last one absurd.
- Name every chapter (one per song section) in 1 to 3 words, uppercase, like "LAST TRAIN", "NO SIGNAL", "LOUD AGAIN". Give each chapter one look for the figure (wardrobe), one set and one light, so chapters read as different worlds. Plant objects early that pay off later.
- Ticker: 8 to 12 short uppercase status lines that belong to this story and escalate ("UNREAD MESSAGES: 41", "COFFEE LEVEL 3%", "NEIGHBOURS AWAKE: ALL"). Each at most 40 characters.

THE HOOK
- Unit 0 is a close portrait of the figure with all identifying features; its display words state the premise. People meet the film muted in a feed and decide in a second: no black frame, no title card first.

THE PICTURES (one plate per unit)
- Write every plate prompt in this order: framing first (ECU, CU, MCU, MS, MWS, WS, FS, EWS or OTS, plus lens feel), then the figure's identity text EXACTLY as given (the full form for ECU to MS, the short form for MWS and wider), then the chapter look, the action with its end state, the place, the light, then "photographic film still, cinematic light, natural colour, film grain", and last "no text, no letters, no logos".
- Performance units (the figure sings): face and the whole mouth visible, facing the camera or slightly turned, nothing in front of the mouth (no microphone at the lips, no hands, no hair), an expression that fits the words. Vary the framing between ECU, CU and MCU.
- Story and still units: concrete sets and props that show the line (a laundromat at 3 a.m., a rooftop pool in the rain, a phone on a kitchen table, a karaoke booth, a city at night). The figure is in at least 70% of the runtime: put the figure in most story units too (whole figure, back view or seen through glass counts; hands alone do not). Other people are described one by one (age, build, hair, clothes) and never resemble real public figures. Name objects precisely ("a small white electric robotaxi with a lidar dome", not "a car"); give exact counts ("exactly four engineers").
- Motion prompts (story units only): one sentence of story beat, the blocking at the start, ONE camera move with start, direction and end, the end state of the action, exact counts, and "No text, letters or logos." At most 60 words.
- Never: real people or celebrities, brand names or logos, text in the picture, a second copy of the figure, anyone who reads under 18, nudity, the word "young".

THE GRAPHICS (the screen explains every line, densely)
- Every line gets one to three graphics that SHOW its meaning, one for each thing the line names (a number, a place, a time, an object, something someone says). A dense line ("Forty drafts to you, then my nerve gave out at three") gets three: a list of the drafts, a chart of the nerve, a running clock. A short sung hook gets one. Each graphic enters on its own naming word: give that word's index as its "key". Choose the type by what the words say:
  number → counter (int, percent, money, clock, fraction, multiplier), chart, progress, list
  claim or category → tag, stamp
  place or process → spec, blueprint, pin, list, chart
  speech or technology → terminal, chat, notification, voice
  time → clock, stopwatch
  correction → strike
  yes/no, on/off → toggle
- Use at least six different types in the film and never open three lines in a row with the same type. Graphics must look real (numbers, labels and interfaces that could exist), escalate across the film, and read on a phone in one glance. Numbers that appear twice are the same number.
- Close-ups leave room only beside the face: on ECU and CU units choose narrow graphics (counter, tag, stamp, toggle, progress, clock, stopwatch, notification, pin); wide ones (chart, spec, blueprint, terminal, list, chat, voice) belong on MS or wider units, or on units without the figure.
- You never set times, sizes or positions: the code shows each graphic from its key word until the screen needs the place, and keeps it off the face.
- Display words: most lines also get 1 to 4 rows of big words taken from the line (each row at most 14 characters). Use "condensed" (heavy, uppercase) for punchlines and the chorus, "serif" (italic, lower case) for soft or intimate lines, "around" (one word left and one word right of the head) for two-word hits on centred close-ups. Mark at most one row with "box": true (the accent box). Skip display words when the line is long and the graphic already says it.
- For every unit say where the figure stands ("subject": "left", "center" or "right") and how close the camera is ("framing"): the code keeps the graphics off the face with it.

LIMITS AND FORMAT
- All on-screen texts in {{hud_language}}, uppercase for HUD, tags, stamps and condensed rows. The lyrics themselves are never rewritten.
- Respect every length limit in the device catalogue below. No emoji.

DEVICE CATALOGUE
{{device_catalogue}}

ANSWER SCHEMA
{{answer_schema}}`;

const USER_TEMPLATE = `IDEA
{{brief}}

STYLE
{{style}}

FIGURE (identity text; use the forms verbatim)
{{figure}}

SONG
duration {{duration}} s, about {{bpm}} BPM, lyrics language {{lyrics_language}}
sections:
{{sections}}

LINES (index, time, section, words with their index)
{{lines}}

UNITS (already cut on the beat by the code; one plate per unit)
{{units}}

Return the JSON object now.`;

// The schema the answer has to follow; answerSchema() adds the notes after it.
const ANSWER_SCHEMA = `{
  "treatment": "string, one paragraph",
  "hud": {
    "title": "string ≤ 22, uppercase, the device name, e.g. NIGHT SHIFT",
    "counter_label": "string ≤ 12, e.g. DRAFT",
    "counter_values": [1, 7, 49, 2401],
    "console": "string ≤ 40, e.g. NIGHT LOG · CLAUDIA CONSOLE",
    "figure": "string ≤ 16, the figure's name in uppercase",
    "instances_label": "string ≤ 12, e.g. LISTENERS",
    "instances_values": [12, 1200, 980000],
    "ticker": ["8 to 12 strings ≤ 40"]
  },
  "chapters": [ { "section": 0, "name": "≤ 18, uppercase", "look": "wardrobe of the figure", "set": "the place", "light": "the light" } ],
  "units": [ { "index": 0, "framing": "CU", "with_figure": true, "subject": "center", "plate": "full plate prompt", "motion": "motion prompt or empty for performance and still units" } ],
  "lines": [ { "index": 0, "key": 1, "display": { "style": "condensed", "rows": [ { "text": "DRAFTS", "size": "xl", "box": false } ] }, "graphics": [ { "key": 1, "type": "list", "title": "DRAFT LOG", "rows": ["D-0141 HEY ...... DELETED", "D-0142 HI ...... DELETED"] }, { "key": 6, "type": "chart", "title": "NERVE · LEVEL", "values": [12, 18, 31, 64], "marker": "SEND? 64%" }, { "key": 10, "type": "stopwatch", "label": "SLEEP CLOCK · RUNNING", "from": "03:12:43:00" } ] } ],
  "endcard": { "title": "≤ 32, uppercase", "lines": ["one or two lines ≤ 60"] }
}`;

// The sentence about the look of the film, by the style (the parameter `theme`).
const THEME_BLOCKS = Object.freeze({
  hud: `The look is the "HUD" style that is all over X right now: electric blue on photoreal footage, heavy condensed type, a busy interface frame with a ticker and a recording badge, RGB glitches on the hits.`,
  kuble: `The look is "Kuble": night-ink darkness, Kuble Blue light and one warm amber spark, bold geometric type, loud on the beat (blue light pulses, prism glitches, amber sparks) and clean in between. Build the picture world from white plaster and crystal sculptures, blue glow, warm amber sparkle, dark material surfaces and clean architecture with hard light; the figure and the story stay free. On-screen texts are precise and witty, never hype; "Kuble" names the look only and never appears on screen.`
});

// The template of the figure sheet (the text for the node that makes the portrait): the full form of the figure goes in.
const SHEET_TEMPLATE = `Character reference portrait for a music video, photographic film still: {{figure_full}}. Head and shoulders, facing the camera, neutral calm expression, mouth closed, plain mid-grey studio background, soft even key light from the front, natural colour, sharp focus on the eyes, 85 mm lens. Exactly one person. No text, no letters, no logos.`;

const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_match, name) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : ''));

// The languages of the texts on the screen: the name for the prompt, and the AI label of the end card.
const HUD_LANGUAGES = Object.freeze({
  en: Object.freeze({ name: 'English', label: 'AI-GENERATED MUSIC VIDEO', note: 'Images, clips and graphics made with AI' }),
  de: Object.freeze({ name: 'German (Swiss High German, always "ss", never the sharp s)', label: 'KI-GENERIERTES MUSIKVIDEO', note: 'Bilder, Clips und Grafiken mit KI erstellt' }),
  es: Object.freeze({ name: 'Spanish', label: 'VIDEOCLIP GENERADO CON IA', note: 'Imágenes, clips y gráficos creados con IA' })
});
const LYRICS_LANGUAGES = Object.freeze({ en: 'English', de: 'German', es: 'Spanish' });

/* ---------- how big the devices are, and how much room the face leaves ---------- */

// One valid body for every type (within the limits), to measure how big a device of the type typically is.
const SAMPLE_BODIES = Object.freeze({
  counter: { label: 'COUNT 1', format: 'int', from: 0, to: 11 },
  tag: { text: 'TAG 1 · LINE 3' },
  stamp: { text: 'CHECKED', count: 2 },
  strike: { text: 'LEADING', mode: 'strike' },
  toggle: { label: 'OPTION 1', states: ['ON', 'OFF?'] },
  progress: { label: 'LOAD 1', from: 4, to: 41 },
  clock: { time: '00:07', label: 'LOCAL 1', arc: 0.9 },
  stopwatch: { from: '03:52:17:00', label: 'CLOCK 1' },
  notification: { app: 'ALERTS', title: 'Notice 1', text: 'Gate: open', time: 'now' },
  pin: { label: 'HERE', x: 0.5, y: 0.5 },
  chart: { title: 'CHART 1', values: [23, 27, 26, 34, 41, 58], marker: 'MAX 60%' },
  list: { title: 'LOG 1', rows: ['G-2210 ENTRY ..... PASS', 'G-2211 EXIT ...... PASS', 'G-2212 SPEED ..... PASS'] },
  spec: { title: 'SPEC 1', rows: [['TYPE', 'LATCH'], ['RATING', 'BAY 4 EAST'], ['OWNER', 'UNKNOWN']], redact: 2 },
  terminal: { prompt: '$', lines: ['tail -n 3 log', 'ticket 03 accepted', 'queue: 12 left'] },
  chat: { messages: [{ from: 'them', text: 'are you at home yet?' }, { from: 'her', text: 'no, still at the club' }] },
  blueprint: { title: 'FIG 1', labels: { a: 'A · SENSOR', b: 'B · HINGE' }, dims: [2.1, 1.4] },
  voice: { label: 'VOICE · HUMMING', db: -32 }
});

const sizeCache = new Map();

// The typical size in pixels of every type on the 1920 x 1080 screen in a style, measured with the layout of graphics.js: { type: { w, h } }. The classes of the brief
// ("narrow" and "wide") are not the sizes the layout works with: a clock is wider than a list. These numbers are.
function typicalSizes(theme) {
  const name = themes.resolve(theme);
  if (sizeCache.has(name)) return sizeCache.get(name);
  const sizes = {};
  for (const [type, body] of Object.entries(SAMPLE_BODIES)) {
    const input = {
      duration: 10,
      cuts: [{ start: 0, end: 10, kind: 'story', framing: 'MS', subject: 'center' }],
      lines: [{ start: 0, end: 3, key: 0, words: [{ text: 'a', start: 0, end: 1 }] }],
      graphics: [{ id: 'sample', line: 0, key: 0, start: 1, end: 5, type, position: 'mid-right', ...body }]
    };
    const planned = graphicsLib.normalizeGraphics(input, { theme: name }).graphics;
    const device = (planned.graphics || planned.devices || [])[0];
    if (!device) continue;
    const size = graphicsLib.measure(device, themes.get(name));
    sizes[type] = { w: Math.round(size.w), h: Math.round(size.h) };
  }
  sizeCache.set(name, Object.freeze(sizes));
  return sizeCache.get(name);
}

// The room the face of a unit leaves beside it: { left, right } in pixels between the zone of the face and the safe edge of the screen (a gap kept free).
function freeLanes({ framing, subject, kind = 'story' }) {
  const zone = graphicsLib.faceZone({ framing, subject, kind });
  if (!zone) return { left: graphicsLib.SAFE.right - graphicsLib.SAFE.left, right: graphicsLib.SAFE.right - graphicsLib.SAFE.left };
  return { left: Math.max(0, zone.x0 - graphicsLib.SAFE.left - graphicsLib.GAP), right: Math.max(0, graphicsLib.SAFE.right - zone.x1 - graphicsLib.GAP) };
}

// The width a device needs at the least: its typical width at the smallest scale the layout allows.
const narrowestWidth = (type, sizes) => (sizes[type] ? Math.round(sizes[type].w * (graphicsLib.MIN_SCALE[type] || 1)) : 0);

// The types that fit into `room` pixels of width, the smallest first (at most `count`).
function typesFitting(room, sizes, count = 4) {
  return GRAPHIC_TYPES.filter((type) => sizes[type] && narrowestWidth(type, sizes) <= room && type !== 'strike' && type !== 'pin')
    .sort((a, b) => sizes[a].w * sizes[a].h - sizes[b].w * sizes[b].h)
    .slice(0, count);
}

// The device catalogue of the prompt: the fields of every type with the limits of the normalisers of graphics.js (the LIMITS table is the one source), and how big a
// device of the type typically is, so that the model can see what finds room beside a face.
function deviceCatalogue({ theme = themes.DEFAULT } = {}) {
  const L = LIMITS;
  const sizes = typicalSizes(theme);
  const at = (type) => (sizes[type] ? ` — about ${sizes[type].w} x ${sizes[type].h} px` : '');
  const lane = (framing) => freeLanes({ framing, subject: 'center' }).left;
  const far = (framing) => freeLanes({ framing, subject: 'left' }).right;
  const room = [
    'Sizes are typical ones on the 1920 x 1080 screen (the layout shrinks a device by up to 20 or 30% where it must, a tag never). Beside the face a device finds about',
    `${lane('ECU')} px per side in an ECU, ${lane('CU')} in a CU, ${lane('MCU')} in an MCU, ${lane('MS')} in an MS and ${lane('MWS')} in an MWS or wider shot when the figure is in the middle;`,
    `with the figure at the left or right edge ("subject") the far side has ${far('ECU')} px in an ECU, ${far('CU')} in a CU, ${far('MCU')} in an MCU and ${far('MS')} in an MS.`
  ].join(' ');
  return [
    room,
    `display (the field "display" of a line, not an entry of "graphics"): {"style": "condensed | serif | around", "rows": [1 to ${L.display.rows} rows {"text": ≤ ${L.display.text} characters, "size": "xl | l | m", "box": true | false}]}; "around" takes ${L.display.around} rows; at most one row has "box": true`,
    `counter: {"type": "counter", "label": ≤ ${L.counter.label} characters, "format": "int | percent | money | clock | fraction | multiplier", "from": number, "to": number}, plus "total" for fraction; for clock "from" and "to" are "HH:MM:SS:FF"${at('counter')}`,
    `tag: {"type": "tag", "text": ≤ ${L.tag.text} characters}${at('tag')}`,
    `stamp: {"type": "stamp", "text": ≤ ${L.stamp.text} characters, "count": 1 to ${L.stamp.count}}${at('stamp')}`,
    `strike: {"type": "strike", "text": ≤ ${L.strike.text} characters, "mode": "strike | redact"}${at('strike')}`,
    `spec: {"type": "spec", "title": ≤ ${L.spec.title} characters, "rows": [${L.spec.minRows} to ${L.spec.rows} pairs ["label" ≤ ${L.spec.label}, "value" ≤ ${L.spec.value}]], "redact": row index or null}${at('spec')}`,
    `blueprint: {"type": "blueprint", "title": ≤ ${L.blueprint.title} characters, "labels": {"a": ≤ ${L.blueprint.label}, "b": ≤ ${L.blueprint.label}}, "dims": [height, width]}${at('blueprint')}`,
    `chart: {"type": "chart", "title": ≤ ${L.chart.title} characters, "values": [${L.chart.minValues} to ${L.chart.values} numbers from 0 to 100], "marker": ≤ ${L.chart.marker} characters}${at('chart')}`,
    `terminal: {"type": "terminal", "lines": [1 to ${L.terminal.lines} lines, each ≤ ${L.terminal.line} characters], "prompt": ≤ ${L.terminal.prompt} characters}${at('terminal')}`,
    `chat: {"type": "chat", "messages": [1 to ${L.chat.messages} of {"from": "them | her", "text": ≤ ${L.chat.text} characters}]}${at('chat')}`,
    `notification: {"type": "notification", "app": ≤ ${L.notification.app}, "title": ≤ ${L.notification.title}, "text": ≤ ${L.notification.text}, "time": ≤ ${L.notification.time} characters}${at('notification')}`,
    `voice: {"type": "voice", "label": ≤ ${L.voice.label} characters, "db": -120 to 0}${at('voice')}`,
    `clock: {"type": "clock", "time": "HH:MM", "label": ≤ ${L.clock.label} characters, "arc": 0 to 1}${at('clock')}`,
    `stopwatch: {"type": "stopwatch", "from": "HH:MM:SS:FF", "label": ≤ ${L.stopwatch.label} characters}${at('stopwatch')}`,
    `list: {"type": "list", "title": ≤ ${L.list.title} characters, "rows": [1 to ${L.list.rows} rows, each ≤ ${L.list.row} characters]}${at('list')}`,
    `toggle: {"type": "toggle", "label": ≤ ${L.toggle.label} characters, "states": ["ON", "OFF?"] (each ≤ ${L.toggle.state} characters)}${at('toggle')}`,
    `progress: {"type": "progress", "label": ≤ ${L.progress.label} characters, "from": 0 to 100, "to": 0 to 100}${at('progress')}`,
    `pin: {"type": "pin", "label": ≤ ${L.pin.label} characters, "x": 0.05 to 0.95, "y": 0.12 to 0.85}${at('pin')}`
  ]
    .map((line) => `- ${line}`)
    .join('\n');
}

// The schema of the answer and the notes that go with it. `needShort`: the figure has no SHORT form, so the answer carries one ("figure_short").
function answerSchema({ needShort = false } = {}) {
  const notes = [
    '- "counter_values" and "instances_values" have exactly one value per chapter and rise; the values in the example only show the shape.',
    '- "chapters" has one entry for each section of the list, with its section number.',
    '- "units" has one entry for each unit of the list, with its index; "motion" is empty for performance and still units.',
    '- "lines" has one entry for each line of the list, with its index; "key" is the index of the key word of the line (for the big words), "display" may be null, "graphics" has 1 to 3 entries whose "key" values are word indexes of that line in ascending order. The fields of a graphic follow the device catalogue (a chart has 5 to 12 values).',
    '- Texts are strings, numbers are numbers.'
  ];
  if (needShort) {
    notes.push('- The figure has no SHORT form: add the top-level key "figure_short" with one sentence of its identifying features (keep everything that makes the figure recognisable) and use exactly this sentence as the short form in the plates.');
  }
  return `${ANSWER_SCHEMA}\n\nNOTES ON THE SCHEMA\n${notes.join('\n')}`;
}

// The system prompt: `theme` hud | kuble, `hudLanguage` en | de | es.
function systemPrompt({ theme = themes.DEFAULT, hudLanguage = 'en', needShort = false } = {}) {
  const language = HUD_LANGUAGES[hudLanguage] || HUD_LANGUAGES.en;
  return fill(SYSTEM_TEMPLATE, {
    theme_block: THEME_BLOCKS[themes.resolve(theme)] || THEME_BLOCKS.hud,
    hud_language: language.name,
    device_catalogue: deviceCatalogue({ theme }),
    answer_schema: answerSchema({ needShort })
  });
}

const tenth = (seconds) => (Math.round(seconds * 10) / 10).toFixed(1);
const rangeText = (start, end) => `${tenth(start)}-${tenth(end)} s`;

// The name of a chapter for the model: as the analysis calls it, plus the kind the code derived where the name does not say it.
function chapterLabel(section) {
  const name = squash(section.name).toLowerCase();
  return name.includes(section.kind) ? name : `${name} [${section.kind}]`;
}

function sectionRows(grid) {
  const peak = Math.max(0, ...grid.sections.map((section) => section.energy));
  return grid.sections.map((section) => `${section.index} ${chapterLabel(section)} ${rangeText(section.start, section.end)} energy ${planLib.energyWord(section.energy, peak)}`).join('\n');
}

function lineRows(grid) {
  return grid.lines
    .map((line) => `${line.index} | ${rangeText(line.start, line.end)} | ${chapterLabel(grid.sections[line.section])} | ${line.words.map((word, at) => `${at}:${word.text}`).join(' ')}`)
    .join('\n');
}

function unitRows(grid) {
  return grid.units.map((unit) => `${unit.index} | ${unit.kind} | ${rangeText(unit.start, unit.end)} | lines ${unit.lines.length ? unit.lines.join(',') : '-'} | cuts ${unit.cuts.length} | chapter ${unit.section}`).join('\n');
}

// The figure as the model reads it: the full form, the short form (or the request to write one) and the notes of the person.
function figureBlock(figure) {
  const rows = [];
  if (figure.name) rows.push(`NAME: ${figure.name}`);
  rows.push(`FULL: ${figure.full}`);
  rows.push(figure.short ? `SHORT: ${figure.short}` : 'SHORT: (none given: write it yourself and return it as "figure_short")');
  for (const note of figure.notes) rows.push(note);
  return rows.join('\n');
}

const lyricsLanguageOf = (grid) => LYRICS_LANGUAGES[languageLib.detectLanguage(grid.lines.map((line) => line.text).join('\n'))] || 'English';

// The user message. `problems` and `previous`: the second try (what was wrong in the answer, and the answer itself).
function userPrompt({ brief, style, figure, grid, problems = [], previous = '' }) {
  let text = fill(USER_TEMPLATE, {
    brief: String(brief || '').trim(),
    style: String(style || '').trim() || '(none given)',
    figure: figureBlock(figure),
    duration: Math.round(grid.duration),
    bpm: grid.bpm ? Math.round(grid.bpm) : 'unknown',
    lyrics_language: lyricsLanguageOf(grid),
    sections: sectionRows(grid),
    lines: lineRows(grid),
    units: unitRows(grid)
  });
  if (problems.length) {
    const shown = problems.slice(0, MAX_PROBLEMS_TOLD);
    const more = problems.length > shown.length ? `\n- and ${problems.length - shown.length} more of the same kind` : '';
    const retry = [
      'YOUR PREVIOUS ANSWER HAD THESE PROBLEMS (fix every one of them, keep everything that was fine, and answer with the complete JSON object again)',
      ...shown.map((problem) => `- ${problem}`)
    ].join('\n');
    const answer = previous ? `\n\nYOUR PREVIOUS ANSWER\n${String(previous).trim()}` : '';
    text = text.replace('Return the JSON object now.', `${retry}${more}${answer}\n\nReturn the JSON object now.`);
  }
  return text;
}


// The prompt of the figure sheet (the text for the node that makes the portrait): the full form of the figure.
function sheetPrompt(figure) {
  return fill(SHEET_TEMPLATE, { figure_full: squash(figure.full).replace(/[.;:,\s]+$/, '') });
}

/* ---------- the answer of the model ---------- */

// The framings by the identity text they take: the full form up to the medium shot, the short form from the medium wide shot on.
const CLOSE_FRAMINGS = Object.freeze(['ECU', 'CU', 'MCU', 'MS']);
// A unit with the singer shows the face and the whole mouth: close, or at most a medium shot.
const SINGER_FRAMINGS = Object.freeze(['ECU', 'CU', 'MCU', 'MS']);
const HOOK_FRAMINGS = Object.freeze(['ECU', 'CU', 'MCU']);
const FIGURE_SUBJECTS = Object.freeze(['left', 'center', 'right']);
const GRAPHIC_TYPES = Object.freeze(graphicsLib.DEVICE_TYPES.filter((type) => type !== 'display'));
const GRAPHICS_PER_LINE = Object.freeze({ min: 1, max: 3 });
const FIGURE_SHARE_MIN = 0.7;
const TYPES_MIN = 6;
const TYPES_FROM_LINES = 8;
const TICKER = Object.freeze({ min: 8, max: 12, limit: 40 });
const HUD_LIMITS = Object.freeze({ title: 22, counterLabel: 12, console: 40, figure: 16, instancesLabel: 12, chapter: 18, endTitle: 32, endLine: 60, endLines: 2 });
const MAX_PLATE = planLib.MAX_PROMPT_CHARS;
const FORBIDDEN_WORD = /\byoung\b/i;
const NO_TEXT_PLATE = 'no text, no letters, no logos';
const NO_TEXT_MOTION = 'No text, letters or logos.';

const characters = (value) => Array.from(String(value)).length;

// A text for the screen that is too long, cut at the last word that fits (the answer is told about it; this is the last resort when it stays so).
function fit(value, max) {
  const chars = Array.from(String(value));
  if (chars.length <= max) return String(value);
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·\-–—(]+$/, '');
}

// A text of a field, cleaned like graphics.js cleans it (no control characters, one line); over `max` characters it is a problem and the text is cut.
function limited(value, max, where, problems, upper = false) {
  const clean = graphicsLib.cleanText(value, 4 * max + 80);
  const out = upper ? clean.toUpperCase() : clean;
  const length = characters(out);
  if (length > max) {
    problems.push(`${where}: ${length} characters, at most ${max}`);
    return fit(out, max);
  }
  return out;
}

const numberOf = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.replace(/,/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// "3:52:17:04", "03:52:17", "52:17" -> every part of two digits; null where it is none of them
function clockText(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  return /^\d{1,2}(:\d{1,2}){1,3}$/.test(raw) ? raw.split(':').map((part) => part.padStart(2, '0')).join(':') : null;
}

// 1, 2, 3, 7, 8 -> "1 to 3, 7 to 8"
function rangesText(list) {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const out = [];
  for (let at = 0; at < sorted.length; at += 1) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    out.push(end > at + 1 ? `${sorted[at]} to ${sorted[end]}` : sorted.slice(at, end + 1).join(', '));
    at = end;
  }
  return out.join(', ');
}

// The readers of the graphics: each takes the raw entry and returns the fields of the device (cut to the limits), or null for an entry that cannot be drawn.
// What is wrong is put into `problems`, with `where` in front of it.
const READERS = {
  counter(raw, where, problems) {
    const label = limited(raw.label, LIMITS.counter.label, `${where} label`, problems, true);
    let format = 'int';
    if (raw.format !== undefined && raw.format !== null && raw.format !== '') {
      if (graphicsLib.COUNTER_FORMATS.includes(raw.format)) format = raw.format;
      else problems.push(`${where}: the format "${graphicsLib.cleanText(raw.format, 20)}" is none of ${graphicsLib.COUNTER_FORMATS.join(', ')}`);
    }
    if (format === 'clock') {
      const from = clockText(raw.from);
      const to = clockText(raw.to);
      if (!from || !to) {
        problems.push(`${where}: a clock counter needs "from" and "to" as "HH:MM:SS:FF"`);
        return null;
      }
      return { label, format, from, to };
    }
    const to = numberOf(raw.to);
    if (to === null) {
      problems.push(`${where}: a counter needs a number in "to"`);
      return null;
    }
    const out = { label, format, from: Math.round(numberOf(raw.from) ?? 0), to: Math.round(to) };
    if (format === 'fraction') {
      const total = numberOf(raw.total);
      out.total = Math.round(total !== null && total > 0 ? total : Math.max(out.to, 1));
    }
    return out;
  },
  tag(raw, where, problems) {
    const text = limited(raw.text, LIMITS.tag.text, `${where} text`, problems);
    if (!text) problems.push(`${where}: the text is missing`);
    return text ? { text } : null;
  },
  stamp(raw, where, problems) {
    const text = limited(raw.text, LIMITS.stamp.text, `${where} text`, problems, true);
    if (!text) problems.push(`${where}: the text is missing`);
    return text ? { text, count: Math.round(clamp(numberOf(raw.count) ?? 1, 1, LIMITS.stamp.count)) } : null;
  },
  strike(raw, where, problems) {
    const text = limited(raw.text, LIMITS.strike.text, `${where} text`, problems, true);
    if (!text) problems.push(`${where}: the text is missing`);
    return text ? { text, mode: raw.mode === 'redact' ? 'redact' : 'strike' } : null;
  },
  spec(raw, where, problems) {
    const rows = [];
    for (const [at, row] of (Array.isArray(raw.rows) ? raw.rows : []).entries()) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const label = limited(row[0], LIMITS.spec.label, `${where} row ${at + 1} label`, problems);
      const value = limited(row[1], LIMITS.spec.value, `${where} row ${at + 1} value`, problems);
      if (label) rows.push([label, value]);
    }
    if (rows.length > LIMITS.spec.rows) rows.length = LIMITS.spec.rows;
    if (rows.length < LIMITS.spec.minRows) {
      problems.push(`${where}: needs ${LIMITS.spec.minRows} to ${LIMITS.spec.rows} rows of ["label", "value"]`);
      return null;
    }
    const redact = Number.isInteger(raw.redact) && raw.redact >= 0 && raw.redact < rows.length ? raw.redact : null;
    return { title: limited(raw.title, LIMITS.spec.title, `${where} title`, problems), rows, redact };
  },
  blueprint(raw, where, problems) {
    const labels = isObject(raw.labels) ? raw.labels : {};
    const dims = Array.isArray(raw.dims) ? raw.dims : [];
    return {
      title: limited(raw.title, LIMITS.blueprint.title, `${where} title`, problems),
      labels: { a: limited(labels.a, LIMITS.blueprint.label, `${where} label a`, problems) || 'A', b: limited(labels.b, LIMITS.blueprint.label, `${where} label b`, problems) || 'B' },
      dims: [clamp(numberOf(dims[0]) ?? 2.1, 0.01, 99), clamp(numberOf(dims[1]) ?? 1.4, 0.01, 99)]
    };
  },
  chart(raw, where, problems) {
    const values = (Array.isArray(raw.values) ? raw.values : []).map(numberOf).filter((value) => value !== null).map((value) => clamp(value, 0, 100));
    if (values.length < LIMITS.chart.minValues) {
      problems.push(`${where}: needs ${LIMITS.chart.minValues} to ${LIMITS.chart.values} values (has ${values.length})`);
      return null;
    }
    return {
      title: limited(raw.title, LIMITS.chart.title, `${where} title`, problems),
      values: values.slice(0, LIMITS.chart.values),
      marker: limited(raw.marker, LIMITS.chart.marker, `${where} marker`, problems)
    };
  },
  terminal(raw, where, problems) {
    const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((line, at) => limited(line, LIMITS.terminal.line, `${where} line ${at + 1}`, problems)).filter(Boolean);
    if (!lines.length) {
      problems.push(`${where}: needs 1 to ${LIMITS.terminal.lines} lines`);
      return null;
    }
    return { lines: lines.slice(0, LIMITS.terminal.lines), prompt: limited(raw.prompt, LIMITS.terminal.prompt, `${where} prompt`, problems) || '$' };
  },
  chat(raw, where, problems) {
    const messages = [];
    for (const [at, message] of (Array.isArray(raw.messages) ? raw.messages : []).entries()) {
      if (!isObject(message)) continue;
      const text = limited(message.text, LIMITS.chat.text, `${where} message ${at + 1}`, problems);
      if (text) messages.push({ from: message.from === 'her' ? 'her' : 'them', text });
    }
    if (!messages.length) {
      problems.push(`${where}: needs 1 to ${LIMITS.chat.messages} messages`);
      return null;
    }
    return { messages: messages.slice(0, LIMITS.chat.messages) };
  },
  notification(raw, where, problems) {
    const title = limited(raw.title, LIMITS.notification.title, `${where} title`, problems);
    const text = limited(raw.text, LIMITS.notification.text, `${where} text`, problems);
    if (!title && !text) {
      problems.push(`${where}: needs a title or a text`);
      return null;
    }
    return {
      app: limited(raw.app, LIMITS.notification.app, `${where} app`, problems, true) || 'MESSAGES',
      title,
      text,
      time: limited(raw.time, LIMITS.notification.time, `${where} time`, problems) || 'now'
    };
  },
  voice(raw, where, problems) {
    return { label: limited(raw.label, LIMITS.voice.label, `${where} label`, problems), db: clamp(numberOf(raw.db) ?? -32, -120, 0) };
  },
  clock(raw, where, problems) {
    const time = clockText(raw.time);
    if (!time) problems.push(`${where}: "time" has to be "HH:MM"`);
    return { time: (time || '12:00').split(':').slice(0, 2).join(':'), label: limited(raw.label, LIMITS.clock.label, `${where} label`, problems), arc: clamp(numberOf(raw.arc) ?? 0.5, 0, 1) };
  },
  stopwatch(raw, where, problems) {
    const from = clockText(raw.from);
    if (!from) problems.push(`${where}: "from" has to be "HH:MM:SS:FF"`);
    return { from: from || '00:00:00:00', label: limited(raw.label, LIMITS.stopwatch.label, `${where} label`, problems) };
  },
  list(raw, where, problems) {
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row, at) => limited(row, LIMITS.list.row, `${where} row ${at + 1}`, problems)).filter(Boolean);
    if (!rows.length) {
      problems.push(`${where}: needs 1 to ${LIMITS.list.rows} rows`);
      return null;
    }
    return { title: limited(raw.title, LIMITS.list.title, `${where} title`, problems), rows: rows.slice(0, LIMITS.list.rows) };
  },
  toggle(raw, where, problems) {
    const states = (Array.isArray(raw.states) ? raw.states : []).map((state, at) => limited(state, LIMITS.toggle.state, `${where} state ${at + 1}`, problems)).filter(Boolean);
    return { label: limited(raw.label, LIMITS.toggle.label, `${where} label`, problems), states: [states[0] || 'ON', states[1] || 'OFF?'] };
  },
  progress(raw, where, problems) {
    return {
      label: limited(raw.label, LIMITS.progress.label, `${where} label`, problems),
      from: Math.round(clamp(numberOf(raw.from) ?? 0, 0, 100)),
      to: Math.round(clamp(numberOf(raw.to) ?? 100, 0, 100))
    };
  },
  pin(raw, where, problems) {
    return { label: limited(raw.label, LIMITS.pin.label, `${where} label`, problems), x: clamp(numberOf(raw.x) ?? 0.5, 0.05, 0.95), y: clamp(numberOf(raw.y) ?? 0.5, 0.12, 0.85) };
  }
};

// The big words of a line: null for none. Rows are cut to the limits of graphics.js; "around" takes two rows, one box at most.
function readDisplay(raw, where, problems) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) {
    problems.push(`${where}: "display" is an object or null`);
    return null;
  }
  let style = 'condensed';
  if (['condensed', 'serif', 'around'].includes(raw.style)) style = raw.style;
  else if (raw.style !== undefined) problems.push(`${where}: the style "${graphicsLib.cleanText(raw.style, 20)}" is none of condensed, serif, around`);
  const list = Array.isArray(raw.rows) ? raw.rows : [];
  if (list.length > LIMITS.display.rows) problems.push(`${where}: ${list.length} rows, at most ${LIMITS.display.rows}`);
  const rows = [];
  let boxes = 0;
  for (const [at, item] of list.slice(0, LIMITS.display.rows).entries()) {
    const row = isObject(item) ? item : { text: item };
    const text = limited(row.text, LIMITS.display.text, `${where} row ${at + 1}`, problems, style !== 'serif');
    if (!text) continue;
    let box = row.box === true;
    if (box && boxes >= 1) {
      problems.push(`${where}: only one row may have "box": true`);
      box = false;
    }
    if (box) boxes += 1;
    rows.push({ text, size: ['xl', 'l', 'm'].includes(row.size) ? row.size : 'l', box });
  }
  if (!rows.length) return null;
  if (style === 'around' && rows.length > LIMITS.display.around) {
    problems.push(`${where}: "around" takes ${LIMITS.display.around} rows (one word left and one right of the head)`);
    rows.length = LIMITS.display.around;
  }
  return { style, rows };
}

// The index of the longest word of a line (its key word when the answer names none).
function longestWord(line) {
  let best = 0;
  line.words.forEach((word, at) => {
    if (word.text.length > line.words[best].text.length) best = at;
  });
  return best;
}

function readLineEntries(list, grid, problems) {
  const lines = grid.lines;
  const byIndex = new Map();
  (Array.isArray(list) ? list : []).forEach((entry, position) => {
    if (!isObject(entry)) return;
    const index = Number.isInteger(entry.index) ? entry.index : position;
    if (index < 0 || index >= lines.length) {
      problems.push(`lines: the entry with index ${graphicsLib.cleanText(entry.index, 12)} does not belong to a line`);
      return;
    }
    if (byIndex.has(index)) {
      problems.push(`line ${index}: appears twice`);
      return;
    }
    byIndex.set(index, entry);
  });
  const missing = [];
  const out = lines.map((line, index) => {
    const entry = byIndex.get(index);
    if (!entry) {
      missing.push(index);
      return null;
    }
    const words = line.words.length;
    const givenKey = numberOf(entry.key);
    const key = Number.isInteger(givenKey) ? clamp(givenKey, 0, words - 1) : longestWord(line);
    const display = readDisplay(entry.display, `line ${index} display`, problems);
    const given = Array.isArray(entry.graphics) ? entry.graphics : [];
    if (given.length < GRAPHICS_PER_LINE.min || given.length > GRAPHICS_PER_LINE.max) problems.push(`line ${index}: needs ${GRAPHICS_PER_LINE.min} to ${GRAPHICS_PER_LINE.max} graphics (has ${given.length})`);
    const graphics = [];
    for (const [at, raw] of given.slice(0, GRAPHICS_PER_LINE.max).entries()) {
      const where = `line ${index}, graphic ${at + 1}`;
      if (!isObject(raw)) {
        problems.push(`${where}: is no object`);
        continue;
      }
      const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
      if (!GRAPHIC_TYPES.includes(type)) {
        problems.push(`${where}: the type "${graphicsLib.cleanText(raw.type, 20)}" is not in the catalogue`);
        continue;
      }
      let deviceKey = numberOf(raw.key);
      if (deviceKey === null || !Number.isInteger(deviceKey) || deviceKey < 0 || deviceKey >= words) {
        problems.push(`${where} (${type}): "key" has to be a word index of the line (0 to ${words - 1})`);
        deviceKey = clamp(Math.round(deviceKey ?? key), 0, words - 1);
      }
      const body = READERS[type](raw, `${where} (${type})`, problems);
      if (body) graphics.push({ key: deviceKey, type, ...body });
    }
    // the keys rise from graphic to graphic (equal ones only where the line has fewer words than graphics)
    const keys = graphics.map((device) => device.key);
    const strict = words >= graphics.length;
    if (keys.some((value, at) => at > 0 && (strict ? value <= keys[at - 1] : value < keys[at - 1]))) {
      problems.push(`line ${index}: the "key" values of the graphics have to rise from graphic to graphic (they are ${keys.join(', ')})`);
      graphics.sort((a, b) => a.key - b.key);
    }
    return { key, display, graphics };
  });
  if (missing.length) problems.push(`lines: ${missing.length === 1 ? 'line' : 'lines'} ${rangesText(missing)} ${missing.length === 1 ? 'has' : 'have'} no entry`);
  return out;
}

// The words of the identity forms that must stand in a plate, by the framing of its unit.
const matchText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,\s]+$/, '');
const holdsForm = (plate, form) => Boolean(form) && matchText(plate).includes(matchText(form));

const DEFAULT_FRAMING = Object.freeze({ performance: 'CU', story: 'MWS', still: 'MS' });

function readUnitEntries(list, grid, figure, short, problems, notes) {
  const units = grid.units;
  const byIndex = new Map();
  (Array.isArray(list) ? list : []).forEach((entry, position) => {
    if (!isObject(entry)) return;
    const index = Number.isInteger(entry.index) ? entry.index : position;
    if (index < 0 || index >= units.length) {
      problems.push(`units: the entry with index ${graphicsLib.cleanText(entry.index, 12)} does not belong to a unit`);
      return;
    }
    if (byIndex.has(index)) {
      problems.push(`unit ${index}: appears twice`);
      return;
    }
    byIndex.set(index, entry);
  });
  const missing = [];
  const out = units.map((unit, index) => {
    const entry = byIndex.get(index);
    if (!entry) {
      missing.push(index);
      return null;
    }
    const singer = unit.kind === 'performance';
    let framing = typeof entry.framing === 'string' ? entry.framing.trim().toUpperCase() : '';
    if (!graphicsLib.FRAMINGS.includes(framing)) {
      problems.push(`unit ${index}: "framing" has to be one of ${graphicsLib.FRAMINGS.join(', ')}`);
      framing = DEFAULT_FRAMING[unit.kind];
    }
    let withFigure = entry.with_figure !== false;
    if (singer && !withFigure) {
      notes.push(`unit ${index} sings, so the figure is in it`);
      withFigure = true;
    }
    const subject = FIGURE_SUBJECTS.includes(entry.subject) ? entry.subject : 'center';
    if (singer && !SINGER_FRAMINGS.includes(framing)) problems.push(`unit ${index} (sung): the face and the whole mouth must be big enough to see: framing ECU, CU, MCU or MS, not ${framing}`);
    let plate = graphicsLib.cleanText(entry.plate, MAX_PLATE + 200);
    const where = `unit ${index} (${framing}${singer ? ', sung' : unit.kind === 'story' ? ', story' : ', still'})`;
    if (!plate) {
      problems.push(`${where}: the plate is missing`);
      return null;
    }
    if (characters(plate) > MAX_PLATE) problems.push(`${where}: the plate has ${characters(plate)} characters, at most ${MAX_PLATE}`);
    if (FORBIDDEN_WORD.test(plate) && !FORBIDDEN_WORD.test(`${figure.full} ${figure.short}`)) problems.push(`${where}: the plate has the word "young"`);
    if (withFigure) {
      const close = CLOSE_FRAMINGS.includes(framing);
      if (close && !holdsForm(plate, figure.full)) problems.push(`${where}: the plate must contain the full identity text of the figure verbatim`);
      if (!close) {
        const form = short || figure.full;
        if (!holdsForm(plate, form)) problems.push(`${where}: the plate must contain the ${short ? 'short' : 'full'} identity text of the figure verbatim`);
      }
    }
    // the ending that keeps text out of the picture: added where the model forgot it
    if (!/no text/i.test(plate)) {
      notes.push(`unit ${index}: "${NO_TEXT_PLATE}" was added to the plate`);
      plate = `${plate.replace(/[\s,.;]+$/, '')}, ${NO_TEXT_PLATE}`;
    }
    let motion = '';
    if (unit.kind === 'story') {
      motion = graphicsLib.cleanText(entry.motion, MAX_PLATE + 200);
      if (!motion) problems.push(`${where}: the motion prompt is missing`);
      else if (!/no text/i.test(motion)) motion = `${motion.replace(/\s+$/, '')} ${NO_TEXT_MOTION}`;
      if (FORBIDDEN_WORD.test(motion)) problems.push(`${where}: the motion prompt has the word "young"`);
    }
    return { framing, withFigure, subject, plate, motion };
  });
  if (missing.length) problems.push(`units: ${missing.length === 1 ? 'unit' : 'units'} ${rangesText(missing)} ${missing.length === 1 ? 'has' : 'have'} no entry`);
  return out;
}

// A list of numbers with one value per chapter, rising (the counters of the HUD).
function readRising(list, count, where, problems) {
  const values = (Array.isArray(list) ? list : []).map(numberOf).filter((value) => value !== null && value >= 0).map(Math.round);
  if (!values.length) {
    problems.push(`${where}: missing (needs ${count} rising numbers, one per chapter)`);
    return null;
  }
  if (values.length !== count) problems.push(`${where}: needs ${count} values, one per chapter (has ${values.length})`);
  if (values.some((value, at) => at > 0 && value <= values[at - 1])) problems.push(`${where}: the values have to rise from chapter to chapter (they are ${values.join(', ')})`);
  // repaired so that the film can still use it: the right length, every value above the one before
  const out = [];
  for (let at = 0; at < count; at += 1) {
    const wanted = at < values.length ? values[at] : (out[at - 1] || 1) * 2;
    out.push(at === 0 ? wanted : Math.max(wanted, out[at - 1] + 1));
  }
  return out;
}

function readHud(raw, grid, figure, problems) {
  if (!isObject(raw)) {
    problems.push('hud: missing');
    return null;
  }
  const chapters = grid.sections.length;
  const hud = {
    title: limited(raw.title, HUD_LIMITS.title, 'hud.title', problems, true),
    counterLabel: limited(raw.counter_label, HUD_LIMITS.counterLabel, 'hud.counter_label', problems, true),
    counterValues: readRising(raw.counter_values, chapters, 'hud.counter_values', problems),
    console: limited(raw.console, HUD_LIMITS.console, 'hud.console', problems, true),
    figure: limited(raw.figure || figure.hudName, HUD_LIMITS.figure, 'hud.figure', problems, true),
    instancesLabel: limited(raw.instances_label, HUD_LIMITS.instancesLabel, 'hud.instances_label', problems, true),
    instancesValues: readRising(raw.instances_values, chapters, 'hud.instances_values', problems),
    ticker: []
  };
  if (!hud.title) problems.push('hud.title: missing');
  if (!hud.counterLabel) problems.push('hud.counter_label: missing');
  const ticker = (Array.isArray(raw.ticker) ? raw.ticker : []).map((entry, at) => limited(entry, TICKER.limit, `hud.ticker ${at + 1}`, problems, true)).filter(Boolean);
  if (ticker.length < TICKER.min) problems.push(`hud.ticker: needs ${TICKER.min} to ${TICKER.max} lines (has ${ticker.length})`);
  hud.ticker = ticker.slice(0, TICKER.max);
  return hud;
}

function readChapters(list, grid, problems) {
  const count = grid.sections.length;
  const byIndex = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (isObject(entry) && Number.isInteger(entry.section) && entry.section >= 0 && entry.section < count && !byIndex.has(entry.section)) byIndex.set(entry.section, entry);
  }
  const missing = [];
  const out = grid.sections.map((section) => {
    const entry = byIndex.get(section.index);
    if (!entry) {
      missing.push(section.index);
      return null;
    }
    const name = limited(entry.name, HUD_LIMITS.chapter, `chapter ${section.index} name`, problems, true);
    if (!name) {
      problems.push(`chapter ${section.index}: the name is missing`);
      return null;
    }
    return { name, look: graphicsLib.cleanText(entry.look, 300), set: graphicsLib.cleanText(entry.set, 300), light: graphicsLib.cleanText(entry.light, 300) };
  });
  if (missing.length) problems.push(`chapters: needs one entry for each of the ${count} sections (${missing.length === 1 ? 'section' : 'sections'} ${rangesText(missing)} ${missing.length === 1 ? 'is' : 'are'} missing)`);
  return out;
}

function readEndcard(raw, problems) {
  if (!isObject(raw)) return null;
  const title = limited(raw.title, HUD_LIMITS.endTitle, 'endcard.title', problems, true);
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((line, at) => limited(line, HUD_LIMITS.endLine, `endcard line ${at + 1}`, problems)).filter(Boolean).slice(0, HUD_LIMITS.endLines);
  return title || lines.length ? { title, lines } : null;
}

// The seconds of the film in which the figure is on the screen, as a share of the film (a unit without an entry counts as with the figure: its plain plate has it).
function figureShare(grid, units) {
  let seen = 0;
  grid.units.forEach((unit, index) => {
    const content = units[index];
    if (!content || content.withFigure) seen += unit.duration;
  });
  return seen / grid.duration;
}

// What the answer has to satisfy across the entries: the hook, the share of the figure, no plate twice, enough types of graphics and no run of three.
function checkWhole({ grid, units, lines }, problems) {
  const first = units[0];
  if (first && (!first.withFigure || !HOOK_FRAMINGS.includes(first.framing))) problems.push(`unit 0 (the hook): must be a close portrait of the figure (framing ECU, CU or MCU, "with_figure": true), not ${first.withFigure ? first.framing : 'a unit without the figure'}`);
  const share = figureShare(grid, units);
  if (share < FIGURE_SHARE_MIN - 1e-9) {
    const without = grid.units.filter((unit, index) => units[index] && !units[index].withFigure).sort((a, b) => b.duration - a.duration);
    problems.push(`the figure is on the screen for only ${Math.round(share * 100)}% of the film, at least ${Math.round(FIGURE_SHARE_MIN * 100)}% are needed: put the figure into more story and still units (for example units ${without.slice(0, 6).map((unit) => unit.index).join(', ')}; the whole figure, a back view or the figure seen through glass counts, hands alone do not)`);
  }
  const seenPlates = new Map();
  units.forEach((unit, index) => {
    if (!unit) return;
    const key = matchText(unit.plate);
    if (!seenPlates.has(key)) seenPlates.set(key, []);
    seenPlates.get(key).push(index);
  });
  for (const group of seenPlates.values()) if (group.length > 1) problems.push(`units ${group.join(' and ')}: the plates are identical, write a different picture for each unit`);

  // the types: at least six different ones from eight lines on, and no three lines in a row that open with the same type
  const typed = lines.map((entry) => (entry && entry.graphics.length ? entry.graphics[0].type : null));
  const used = new Set(lines.flatMap((entry) => (entry ? entry.graphics.map((device) => device.type) : [])));
  if (grid.lines.length >= TYPES_FROM_LINES && used.size < TYPES_MIN) problems.push(`the film uses only ${used.size} different graphic types, use at least ${TYPES_MIN} (${GRAPHIC_TYPES.filter((type) => !used.has(type)).slice(0, 6).join(', ')} are free)`);
  for (let at = 2; at < typed.length; at += 1) {
    if (typed[at] && typed[at] === typed[at - 1] && typed[at] === typed[at - 2]) {
      problems.push(`lines ${at - 2}, ${at - 1} and ${at} all open with a ${typed[at]}: change the first graphic of line ${at - 1} (never the same type three lines in a row)`);
      // one message for a long run: jump past it
      while (at + 1 < typed.length && typed[at + 1] === typed[at]) at += 1;
    }
  }
}

// Reads the answer of the model. Returns
//   { ok, content, problems, notes }
// content: { treatment, hud, chapters, units, lines, endcard, figureShort } where an entry the answer did not deliver in a usable way is null and everything else is cut to the
// limits (so it can be used as it is); problems: what is wrong, for the second try; notes: what the code corrected without asking again.
function readAnswer(text, { grid, figure }) {
  const problems = [];
  const notes = [];
  const data = planLib.parseJsonAnswer(text);
  if (!isObject(data)) return { ok: false, content: null, problems: ['The answer is not a JSON object.'], notes };
  const shortGiven = figure.hasShort ? figure.short : '';
  let figureShort = shortGiven;
  if (!shortGiven) {
    figureShort = graphicsLib.cleanText(data.figure_short, 600);
    if (!figureShort) problems.push('figure_short: missing (the figure has no SHORT form, write one and use it in the plates of MWS and wider units)');
  }
  const treatment = graphicsLib.cleanText(data.treatment, 2000);
  if (!treatment) problems.push('treatment: missing');
  const hud = readHud(data.hud, grid, figure, problems);
  const chapters = readChapters(data.chapters, grid, problems);
  const units = readUnitEntries(data.units, grid, figure, figureShort, problems, notes);
  const lines = readLineEntries(data.lines, grid, problems);
  const endcard = readEndcard(data.endcard, problems);
  if (units.length && lines.length) checkWhole({ grid, units, lines }, problems);
  if (FORBIDDEN_WORD.test(treatment) && !FORBIDDEN_WORD.test(`${figure.full} ${figure.short}`)) problems.push('treatment: has the word "young"');
  return { ok: true, content: { treatment, hud, chapters, units, lines, endcard, figureShort }, problems, notes };
}

/* ---------- plain values for what the model did not deliver ---------- */

const NUMBER_WORDS = Object.freeze({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000,
  zehn: 10, elf: 11, zwölf: 12, zwanzig: 20, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100, tausend: 1000,
  diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, mil: 1000, millón: 1000000
});
const PERCENT_WORDS = /^(%|percent|prozent|ciento|por)$/i;
const plainWord = (word) => String(word).replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, '');

// The first number a line says: a figure ("2,048", "64%") or a number word ("forty"); { at (word index), value, percent } or null.
function numberInLine(line) {
  for (let at = 0; at < line.words.length; at += 1) {
    const word = plainWord(line.words[at].text);
    const lower = word.toLowerCase();
    let value = null;
    if (/^\d[\d.,]*%?$/.test(word)) value = Math.round(Number(word.replace(/%$/, '').replace(/,/g, '')));
    else if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, lower)) value = NUMBER_WORDS[lower];
    if (value === null || !Number.isFinite(value)) continue;
    const next = line.words[at + 1] ? plainWord(line.words[at + 1].text) : '';
    return { at, value, percent: word.endsWith('%') || PERCENT_WORDS.test(next), noun: next && !PERCENT_WORDS.test(next) ? next : '' };
  }
  return null;
}

const CHAPTER_NAMES = Object.freeze({ intro: 'INTRO', verse: 'VERSE', chorus: 'CHORUS', bridge: 'BRIDGE', drop: 'THE DROP', outro: 'OUTRO' });
const ROMAN = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']);
const roman = (number) => ROMAN[number - 1] || String(number);

function plainChapter(section, grid) {
  const same = grid.sections.filter((item) => item.kind === section.kind);
  const name = CHAPTER_NAMES[section.kind] || section.kind.toUpperCase();
  return { name: same.length > 1 ? `${name} ${roman(same.indexOf(section) + 1)}` : name, look: '', set: '', light: '' };
}

const clockOf = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// Small words that make a poor title (English, German, Spanish).
const TITLE_SKIP = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'and', 'about', 'with', 'to', 'for', 'who', 'that', 'is', 'are', 'ein', 'eine', 'einer', 'der', 'die', 'das', 'und', 'von', 'über', 'mit', 'zu',
  'für', 'un', 'una', 'el', 'la', 'los', 'las', 'de', 'y', 'sobre', 'con', 'para'
]);

function plainHud(grid, figure, brief, theme) {
  const sections = grid.sections.length;
  const words = squash(brief).replace(/[^\p{L}\p{N} '-]/gu, ' ').split(/\s+/).filter(Boolean);
  const title = fit(words.filter((word) => !TITLE_SKIP.has(word.toLowerCase())).slice(0, 3).join(' ').toUpperCase(), HUD_LIMITS.title) || 'MUSIC VIDEO';
  const name = figure.hudName || 'AI';
  const ticker = [
    `DURATION ${clockOf(grid.duration)}`,
    grid.bpm ? `TEMPO ${Math.round(grid.bpm)} BPM` : 'TEMPO: LIVE',
    `CHAPTERS ${sections}`,
    `LINES ${grid.lines.length}`,
    `CUTS ${grid.cuts.length}`,
    `FIGURE: ${name}`,
    `LOOK: ${themes.get(theme).label.toUpperCase()}`,
    'AI-GENERATED',
    'MODE: LIVE'
  ].map((entry) => fit(entry, TICKER.limit));
  return {
    title,
    counterLabel: 'CHAPTER',
    counterValues: Array.from({ length: sections }, (_item, at) => at + 1),
    console: fit(`${title} · ${name} CONSOLE`, HUD_LIMITS.console),
    figure: name,
    instancesLabel: '',
    instancesValues: null,
    ticker
  };
}

// The pictures of a unit by its kind and place when the model wrote none: a plain plate from the figure and the line (framing, identity, action, light, the endings).
// The first five of the variants are views of the face (for the sung units), all eight are places (for the others); with the seven lights no two units of a film of
// 50 units get the same plate.
const PLAIN_VARIANTS = Object.freeze([
  'seen from the front',
  'seen slightly from the left',
  'seen slightly from the right',
  'seen from a little below',
  'seen from a little above',
  'seen through a glass pane',
  'seen over a table with a lit screen',
  'seen against a window with daylight'
]);
const PLAIN_VIEWS = 5;
const PLAIN_LIGHTS = Object.freeze(['soft window light', 'warm tungsten light', 'cold blue dusk light', 'hard side light', 'neon glow from the side', 'overcast daylight', 'low golden light']);
const PLAIN_SUNG_FRAMINGS = Object.freeze(['CU', 'MCU']);
const PLAIN_MOTIONS = Object.freeze([
  'Slow push-in with gentle handheld movement, ending on a calm close frame.',
  'Smooth sideways dolly, the subject stays in frame and ends facing the lens.',
  'Slow pull-back that reveals the surroundings and ends on a wide, still frame.',
  'Slight orbit around the subject, ending on the starting side with a steady frame.'
]);
const PLAIN_FRAMINGS = Object.freeze({ performance: 'CU', story: 'MS', still: 'MCU' });
const PLAIN_SUBJECTS = Object.freeze(['center', 'left', 'center', 'right']);
const MOODS = Object.freeze({ low: 'calm and intimate', medium: 'focused', high: 'intense, open and loud' });

function plainUnit(unit, grid, figure, short, chapter) {
  const framing = unit.index === 0 ? 'CU' : unit.kind === 'performance' ? PLAIN_SUNG_FRAMINGS[unit.clip % PLAIN_SUNG_FRAMINGS.length] : PLAIN_FRAMINGS[unit.kind];
  const identity = CLOSE_FRAMINGS.includes(framing) ? figure.full : short;
  const peak = Math.max(0, ...grid.units.map((item) => item.energy));
  const mood = MOODS[planLib.energyWord(unit.energy, peak)];
  const line = unit.lines.length ? grid.lines[unit.lines[0]].text : '';
  const look = chapter ? [chapter.look, chapter.set, chapter.light].filter(Boolean).join(', ') : '';
  const lens = framing === 'CU' || framing === 'ECU' ? '85 mm lens' : '35 mm lens';
  const light = PLAIN_LIGHTS[unit.index % PLAIN_LIGHTS.length];
  const action =
    unit.kind === 'performance'
      ? `singing to the camera, the mouth open, the face and the whole mouth fully visible, facing the camera or slightly turned, nothing in front of the mouth, an expression that is ${mood}, ${PLAIN_VARIANTS[unit.index % PLAIN_VIEWS]}, ${light}`
      : `${line ? `in a scene that illustrates the sung line: ${line}` : `in a quiet scene of the film, ${mood}`}, ${PLAIN_VARIANTS[unit.index % PLAIN_VARIANTS.length]}, ${light}`;
  const plate = [`${framing}, ${lens}`, identity, look, action, 'photographic film still, cinematic light, natural colour, film grain', NO_TEXT_PLATE].filter(Boolean).join(', ');
  return {
    framing,
    withFigure: true,
    subject: unit.kind === 'performance' ? 'center' : PLAIN_SUBJECTS[unit.index % PLAIN_SUBJECTS.length],
    plate: plate.slice(0, MAX_PLATE),
    motion: unit.kind === 'story' ? `${PLAIN_MOTIONS[unit.index % PLAIN_MOTIONS.length]} ${NO_TEXT_MOTION}` : ''
  };
}

// The identity text goes into a plate that lacks it: after the framing at the start (framing and lens first, then the figure), else in front.
function withIdentity(plate, framing, form) {
  const start = /^\s*([^,]*\b(?:ECU|CU|MCU|MS|MWS|WS|FS|EWS|OTS)\b[^,]*(?:,\s*[^,]*\blens\b[^,]*)?)\s*,\s*/i.exec(plate);
  return start ? `${start[1]}, ${form}, ${plate.slice(start[0].length)}` : `${framing}, ${form}, ${plate}`;
}

// What the node mends in an entry of the answer after the last try, so that it can be used: the identity text of the figure in a plate that lacks it, the word "young"
// out of the pictures (it never reaches a picture model), a plate that is too long cut at a comma. The answer was told about all of it; this is for what stays wrong.
function repairUnit(entry, figure, short) {
  let plate = entry.plate;
  const form = CLOSE_FRAMINGS.includes(entry.framing) ? figure.full : short || figure.full;
  if (entry.withFigure && !holdsForm(plate, form)) plate = withIdentity(plate, entry.framing, squash(form).replace(/[.;:,\s]+$/, ''));
  const clean = (text) => text.replace(/\byoung\s+/gi, '').replace(/\byoung\b/gi, '');
  if (!FORBIDDEN_WORD.test(`${figure.full} ${figure.short}`)) plate = clean(plate);
  if (characters(plate) > MAX_PLATE) {
    const room = plate.slice(0, MAX_PLATE - NO_TEXT_PLATE.length - 4);
    plate = `${room.slice(0, Math.max(room.lastIndexOf(','), room.length * 0.6))}, ${NO_TEXT_PLATE}`;
  }
  return { ...entry, plate, motion: FORBIDDEN_WORD.test(`${figure.full} ${figure.short}`) ? entry.motion : clean(entry.motion) };
}

// The graphics of a line without an entry: a counter for a number in the line, else a tag with the first words of the line (at most 18 characters, about 210 px: it finds
// room beside a face in a close-up even when the tail of the line before is still on the screen); the key word is the longest one.
const PLAIN_TAG_CHARS = 18;
function plainLine(line) {
  const key = longestWord(line);
  const bare = (index) => plainWord(line.words[index].text);
  const number = numberInLine(line);
  const graphics = [];
  if (number) {
    const label = number.noun ? number.noun.toUpperCase().slice(0, LIMITS.counter.label) : 'COUNT';
    graphics.push({ key: number.at, type: 'counter', label, format: number.percent ? 'percent' : 'int', from: 0, to: number.percent ? clamp(number.value, 0, 999) : number.value });
  } else {
    graphics.push({ key, type: 'tag', text: fit(line.words.map((_word, at) => bare(at)).filter(Boolean).slice(0, 3).join(' ').toUpperCase(), PLAIN_TAG_CHARS) || 'LIVE' });
  }
  const rows = [];
  const picked = line.words.map((_word, at) => ({ at, text: bare(at) })).filter((item) => item.text.length >= 3).sort((a, b) => b.text.length - a.text.length || a.at - b.at).slice(0, line.words.length >= 5 ? 2 : 1).sort((a, b) => a.at - b.at);
  for (const item of picked) rows.push({ text: fit(item.text.toUpperCase(), LIMITS.display.text), size: rows.length ? 'l' : 'xl', box: false });
  return { key, display: rows.length ? { style: 'condensed', rows } : null, graphics };
}

// Completes the content: every entry the answer did not deliver is made from the figure and the line. Returns { content, fallbacks } where `fallbacks` says what was made so:
//   { units: [index], lines: [index], chapters: [index], hud: bool, treatment: bool }
function completeContent(content, { grid, figure, brief = '', theme = themes.DEFAULT }) {
  const base = content || { treatment: '', hud: null, chapters: [], units: [], lines: [], endcard: null, figureShort: '' };
  const short = figure.short || base.figureShort || deriveShort(figure.full);
  const fallbacks = { units: [], lines: [], chapters: [], hud: false, treatment: !base.treatment };
  const chapters = grid.sections.map((section, at) => {
    if (base.chapters[at]) return base.chapters[at];
    fallbacks.chapters.push(at);
    return plainChapter(section, grid);
  });
  const units = grid.units.map((unit, at) => {
    if (base.units[at]) return repairUnit(base.units[at], figure, short);
    fallbacks.units.push(at);
    return plainUnit(unit, grid, figure, short, chapters[unit.section]);
  });
  const lines = grid.lines.map((line, at) => {
    if (base.lines[at]) return base.lines[at];
    fallbacks.lines.push(at);
    return plainLine(line);
  });
  const plain = plainHud(grid, figure, brief, theme);
  fallbacks.hud = !base.hud;
  const given = base.hud || {};
  const hud = {
    title: given.title || plain.title,
    counterLabel: given.counterLabel || plain.counterLabel,
    counterValues: given.counterValues || plain.counterValues,
    console: given.console || plain.console,
    figure: given.figure || plain.figure,
    instancesLabel: given.instancesLabel || (given.instancesValues ? 'INSTANCES' : plain.instancesLabel),
    instancesValues: given.instancesValues || plain.instancesValues,
    ticker: given.ticker && given.ticker.length >= TICKER.min ? given.ticker : [...(given.ticker || []), ...plain.ticker].slice(0, TICKER.max)
  };
  if (!given.counterValues && base.hud) fallbacks.hud = true;
  return { content: { treatment: base.treatment, hud, chapters, units, lines, endcard: base.endcard, figureShort: short }, fallbacks };
}

/* ---------- graphics v1 ---------- */

// How long a device lives: from its own word to at most the end of the line after next, or this long after the end of its own line, never beyond the chapter;
// the big words go a little after their line. The code tries these tails one after the other until the layout leaves nothing out (see layoutLoop).
const DEVICE_TAILS = Object.freeze([2.5, 1.6, 1.0, 0.5]);
const DISPLAY_TAIL_S = 0.5;
const MIN_LIFE_S = 1.6;
const MIN_DISPLAY_LIFE_S = 1.0;
const SUBJECT_X = Object.freeze({ left: 0.27, center: 0.5, right: 0.73 });
const PUNCH_CENTER_Y = 0.42;
const REC_TEXT = 'REC · CAM A · 24 FPS · ISO 800';

// The band of the screen a type likes (top, middle, bottom) on the side that is away from the figure; the layout takes the next free place when it is taken.
const BAND = Object.freeze({
  counter: 'bottom', tag: 'mid', stamp: 'mid', toggle: 'bottom', progress: 'bottom', clock: 'top', stopwatch: 'bottom', notification: 'top',
  chart: 'mid', spec: 'mid', blueprint: 'bottom', terminal: 'bottom', chat: 'mid', voice: 'bottom', list: 'mid', strike: 'top'
});
const slotOf = (band, side) => (band === 'mid' ? side : `${band}-${side}`);

// The places of the devices of one line: the preferred one first, then the others, none twice within a line.
function positionFor(type, side, taken) {
  if (type === 'strike') return 'top';
  if (type === 'pin') return 'center';
  const other = side === 'left' ? 'right' : 'left';
  const band = BAND[type] || 'mid';
  const order = [slotOf(band, side), slotOf('mid', side), slotOf('top', side), slotOf('bottom', side), slotOf(band, other), slotOf('mid', other), slotOf('top', other), slotOf('bottom', other)];
  const place = order.find((slot) => !taken.has(slot)) || order[0];
  taken.add(place);
  return place;
}

const unitAtTime = (grid, time) => grid.units.find((unit) => time >= unit.start - 1e-6 && time < unit.end - 1e-6) || grid.units[grid.units.length - 1];

const normToken = (word) => String(word).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// The first word of the line that a row of the big words says (the display appears with it); the key word of the line when none matches.
function displayKey(display, line, fallback) {
  const wanted = new Set(display.rows.flatMap((row) => row.text.split(' ').map(normToken)).filter(Boolean));
  const at = line.words.findIndex((word) => wanted.has(normToken(word.text)));
  return at >= 0 ? at : fallback;
}

// The graphics (graphics v1) from the grid and the complete content. `tail`: how long a device lives after its line (DEVICE_TAILS).
// Returns { graphics, info } where info maps the id of every device to { line, key, type, unit }.
function buildGraphics({ grid, content, figure, theme, accent, hudLanguage, tail = DEVICE_TAILS[0] }) {
  const style = themes.resolve(theme);
  const language = HUD_LANGUAGES[hudLanguage] || HUD_LANGUAGES.en;
  const cuts = grid.cuts.map((cut) => {
    const unit = grid.units[cut.unit];
    const entry = content.units[cut.unit];
    const out = {
      start: cut.start,
      end: cut.end,
      kind: unit.kind,
      unit: unit.index,
      crop: { scale: cut.zoom, x: cut.zoom > 1 && entry.withFigure ? SUBJECT_X[entry.subject] : 0.5, y: cut.zoom > 1 && entry.withFigure ? PUNCH_CENTER_Y : 0.5 },
      subject: entry.withFigure ? entry.subject : 'none',
      transition: cut.transition
    };
    if (entry.withFigure) out.framing = entry.framing;
    return out;
  });
  const lines = grid.lines.map((line, at) => ({ start: line.start, end: line.end, key: content.lines[at].key, words: line.words }));

  const devices = [];
  const info = new Map();
  grid.lines.forEach((line, at) => {
    const entry = content.lines[at];
    const chapterEnd = grid.sections[line.section].end;
    const after = grid.lines[Math.min(at + 2, grid.lines.length - 1)];
    const reach = Math.min(after.end, line.end + tail, chapterEnd, grid.duration + 0.4);
    // the side away from the figure at the key word; with the figure in the middle the sides take turns from line to line
    const figureAt = (time) => {
      const unit = content.units[unitAtTime(grid, time).index];
      return unit.withFigure ? unit.subject : null;
    };
    const keyTime = line.words[Math.min(entry.key, line.words.length - 1)].start;
    const subject = figureAt(keyTime);
    const side = subject === 'left' ? 'right' : subject === 'right' ? 'left' : at % 2 ? 'left' : 'right';
    const taken = new Set();
    if (entry.display) {
      const key = displayKey(entry.display, line, entry.key);
      const start = line.start;
      const end = round3(Math.max(start + MIN_DISPLAY_LIFE_S, Math.min(line.end + DISPLAY_TAIL_S, chapterEnd, grid.duration + 0.4)));
      const position = entry.display.style === 'around' ? 'around' : slotOf('top', side);
      if (position !== 'around') taken.add(position);
      const id = `d${at}`;
      devices.push({ id, line: at, key, start: round3(start), end, type: 'display', position, style: entry.display.style, rows: entry.display.rows });
      info.set(id, { line: at, key, type: 'display', unit: unitAtTime(grid, line.words[key].start).index });
    }
    entry.graphics.forEach((graphic, n) => {
      const word = line.words[Math.min(graphic.key, line.words.length - 1)];
      const start = word.start;
      const end = round3(Math.max(start + MIN_LIFE_S, Math.min(reach, start + 12)));
      const { key, type, ...body } = graphic;
      const id = `g${at}${'abc'[n]}`;
      const device = { id, line: at, key, start: round3(start), end: Math.min(end, round3(grid.duration + 0.4)), type, position: positionFor(type, side, taken), ...body };
      if (type === 'toggle') {
        const last = line.words[line.words.length - 1].start;
        device.flips = device.end - device.start >= 1.2 ? [round3(clamp(last, device.start + 0.6, device.end - 0.4))] : [];
      }
      devices.push(device);
      info.set(id, { line: at, key, type, unit: unitAtTime(grid, start).index });
    });
  });

  // the through-line counters: one value per chapter, from the start of the chapter
  const steps = (values) => (values ? grid.sections.map((section, at) => ({ at: at === 0 ? 0 : section.start, value: values[at] })) : []);
  const hud = {
    title: content.hud.title,
    counter: { label: content.hud.counterLabel, pad: 2, steps: steps(content.hud.counterValues) },
    console: content.hud.console,
    chapters: grid.sections.map((section, at) => ({ start: section.start, end: section.end, name: content.chapters[at].name })),
    figure: content.hud.figure,
    ticker: content.hud.ticker,
    rec: REC_TEXT,
    drops: grid.drops
  };
  if (content.hud.instancesValues) hud.instances = { label: content.hud.instancesLabel || 'INSTANCES', steps: steps(content.hud.instancesValues) };

  const given = content.endcard || {};
  const note = `${language.label} · ${language.note}`;
  const own = given.lines || [];
  const endLines = figure.credit ? [...own.slice(0, 1), note, figure.credit] : [...own.slice(0, 2), note];
  const graphics = {
    version: 1,
    duration: grid.duration,
    fps: FPS,
    width: graphicsLib.WIDTH,
    height: graphicsLib.HEIGHT,
    accent: graphicsLib.accentFor(style, accent),
    theme: style,
    hud,
    music: grid.music,
    lines,
    cuts,
    graphics: devices,
    endcard: { seconds: 3, title: given.title || content.hud.title || language.label, lines: endLines.slice(0, 3) }
  };
  return { graphics, info };
}

// The finished graphics through the layout of the renderer (prepareGraphics): which devices it leaves out, and every other note it makes. Returns
//   { leftOut: [{ id, type, line, key, unit }], other: [message] }
const LEFT_OUT = /^the (\w+) "([^"]+)" \(([-\d.]+) to ([-\d.]+) s\) found no free place/;

function checkLayout(graphics, info) {
  const { warnings } = graphicsLib.prepareGraphics(graphics, { karaoke: false });
  const leftOut = [];
  const other = [];
  for (const warning of warnings) {
    const match = LEFT_OUT.exec(warning);
    if (match && info.has(match[2])) leftOut.push({ id: match[2], ...info.get(match[2]) });
    else other.push(warning);
  }
  return { leftOut, other };
}

// Builds the graphics with the longest life of the devices that leaves nothing out; if none does, the one that leaves out the fewest.
function layoutLoop(args) {
  let best = null;
  for (const tail of DEVICE_TAILS) {
    const built = buildGraphics({ ...args, tail });
    const check = checkLayout(built.graphics, built.info);
    if (!best || check.leftOut.length < best.check.leftOut.length) best = { ...built, check, tail };
    if (!check.leftOut.length) break;
  }
  return best;
}

// What the model is told about the devices the layout left out (the second try): for a device that is too wide for the room beside the face, the room and what would
// fit (or where to put the figure); for any other, that the screen was too full at that moment.
function layoutProblems(leftOut, content, { theme = themes.DEFAULT } = {}) {
  const sizes = typicalSizes(theme);
  return leftOut.map((device) => {
    const unit = content.units[device.unit];
    const where = unit ? ` (${unit.withFigure ? unit.framing : 'no figure'})` : '';
    if (device.type === 'display') return `line ${device.line}: the big words found no free place in unit ${device.unit}${where}: use fewer or shorter rows or skip them`;
    const full = `line ${device.line}: the ${device.type} found no free place in unit ${device.unit}${where}, there are too many graphics at the same time: take a graphic away from the lines around it or choose a smaller type`;
    if (!unit || !unit.withFigure || !sizes[device.type]) return full;
    const lanes = freeLanes({ framing: unit.framing, subject: unit.subject });
    const room = Math.max(lanes.left, lanes.right);
    if (narrowestWidth(device.type, sizes) <= room) return full;
    const fits = typesFitting(room, sizes);
    const remedies = [];
    if (fits.length) remedies.push(`choose a smaller type (${fits.join(', ')})`);
    if (unit.subject === 'center') remedies.push(`put the figure at the left or right of the picture in unit ${device.unit} ("subject")`);
    remedies.push(`make unit ${device.unit} wider (MS or more)`);
    return `line ${device.line}: the ${device.type} (about ${sizes[device.type].w} px wide) does not fit beside the face in unit ${device.unit} (${unit.framing}, figure ${unit.subject}: ${room} px are free): ${remedies.join(', or ')}`;
  });
}

/* ---------- the plan for the next nodes ---------- */

// The shots (the JSON of "Cut to the beat"), the lists of prompts in the order of the units of each kind, and the graphics. `looped`: the result of layoutLoop.
function buildPlan({ grid, content, figure, brief, looped }) {
  const scenes = grid.units.map((unit) => ({
    index: unit.index,
    start: unit.start,
    end: unit.end,
    duration: unit.duration,
    kind: unit.kind,
    section: unit.section,
    line: unit.lines.map((at) => grid.lines[at].text).join(' / ') || null,
    energy: unit.energy
  }));
  const plan = { scenes, analysis: { duration: grid.duration, bpm: grid.bpm }, cutOn: 'beats' };
  const contents = grid.units.map((_unit, at) => ({ image_prompt: content.units[at].plate, motion: content.units[at].motion, character: figure.name }));
  const shots = planLib.buildShots(plan, contents, { aspectRatio: '16:9', brief });
  shots.shots = shots.shots.map((shot, at) => ({ ...shot, framing: content.units[at].framing, subject: content.units[at].withFigure ? content.units[at].subject : 'none', with_figure: content.units[at].withFigure, cuts: grid.units[at].cuts.length }));
  const ofKind = (kind) => shots.shots.filter((shot) => shot.kind === kind);
  return { shots, performance: ofKind('performance'), story: ofKind('story'), still: ofKind('still'), graphics: looped.graphics, leftOut: looped.check.leftOut, notes: looped.check.other, tail: looped.tail };
}

/* ---------- the price ---------- */

// The tokens of one call: the prompt by its length, the answer by the units and lines (a plate and a motion for every unit, the graphics for every line, a little for the
// film itself; measured against a hand-written answer for 40 units and 45 lines: 15 to 20 thousand tokens).
function llmTokens(grid, promptChars, charsPerToken = 3) {
  return { input: Math.ceil(promptChars / charsPerToken), output: 1500 + 170 * grid.units.length + 220 * grid.lines.length };
}

const cents = (usd) => Math.round(usd * 10000) / 10000;

// The price of the whole run, from the units: the portrait sheet and a plate per unit (an image each), the lip sync of the sung units (billed by the second, at least 5 s), the clips
// of the story units, the depth map of every still, and the language model. `prices` (all in USD, null where not known; plan.js knows no price, the node reads them from the
// tables of the other nodes): { image, lipsync(seconds), clipPerSecond, depth, llm: { inputPerMillion, outputPerMillion, charsPerToken } }.
// Returns { parts, total, unknown } where `total` is null while a part is unknown.
function estimateCost({ grid, settings, prices, promptChars = 0 }) {
  const ofKind = (kind) => grid.units.filter((unit) => unit.kind === kind);
  const sung = ofKind('performance');
  const price = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const lipsync = typeof prices.lipsync === 'function' ? sung.map((unit) => price(prices.lipsync(Math.max(unit.duration, planLib.LIPSYNC_MIN_SEC)))) : [null];
  const llm = prices.llm && price(prices.llm.inputPerMillion) !== null && price(prices.llm.outputPerMillion) !== null ? prices.llm : null;
  const tokens = llmTokens(grid, promptChars, llm ? llm.charsPerToken : 3);
  const parts = {
    sheet: price(prices.image),
    plates: price(prices.image) === null ? null : price(prices.image) * grid.units.length,
    lipsync: lipsync.every((value) => value !== null) ? lipsync.reduce((sum, value) => sum + value, 0) : null,
    clips: price(prices.clipPerSecond) === null ? null : ofKind('story').length * settings.clipSeconds * price(prices.clipPerSecond),
    depth: price(prices.depth) === null ? null : ofKind('still').length * price(prices.depth),
    llm: llm ? (tokens.input * llm.inputPerMillion + tokens.output * llm.outputPerMillion) / 1e6 : null
  };
  const unknown = Object.keys(parts).filter((name) => parts[name] === null);
  for (const name of Object.keys(parts)) if (parts[name] !== null) parts[name] = cents(parts[name]);
  const total = unknown.length ? null : cents(Object.values(parts).reduce((sum, value) => sum + value, 0));
  return { parts, total, unknown, tokens, perMinute: total === null ? null : cents((total * 60) / grid.duration) };
}

/* ---------- the board ---------- */

const timeText = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const roughTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const KIND_LABEL = Object.freeze({ performance: 'SUNG', story: 'STORY', still: 'STILL' });
const money = (usd) => (usd === null || usd === undefined ? 'unknown' : usd.toFixed(2));
const group = (value) => Number(value).toLocaleString('en-US');

// A short name of a device for the board: the type and its main text.
function deviceName(device) {
  const text = (() => {
    switch (device.type) {
      case 'counter': return device.format === 'clock' ? `${device.label} ${device.to}`.trim() : `${device.label} ${group(device.to)}${device.format === 'percent' ? '%' : device.format === 'multiplier' ? 'x' : ''}`.trim();
      case 'tag': case 'stamp': case 'strike': return device.text;
      case 'spec': case 'blueprint': case 'chart': case 'list': return device.title;
      case 'terminal': return device.lines[0];
      case 'chat': return device.messages[0].text;
      case 'notification': return device.title || device.text;
      case 'voice': case 'stopwatch': case 'toggle': case 'pin': return device.label;
      case 'clock': return device.label || device.time;
      case 'progress': return `${device.label} ${device.to}%`.trim();
      default: return '';
    }
  })();
  return `${device.type} «${fit(String(text || ''), 28)}»`;
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What happens in a unit, from its plate: without the framing at the start, the identity text and the endings that are the same in every plate.
function sceneText(plate, figure, short) {
  let text = plate;
  for (const form of [figure.full, short]) {
    if (form) text = text.replace(new RegExp(escapeRegExp(squash(form).replace(/[.;:,\s]+$/, '')), 'i'), 'the figure');
  }
  text = text
    .replace(/photographic film still,?\s*cinematic light,?\s*natural colou?r,?\s*film grain/i, '')
    .replace(/no text, no letters,? no logos/i, '')
    .replace(/^\s*(?:ECU|CU|MCU|MS|MWS|WS|FS|EWS|OTS)\b[^,]*,\s*(?:\d+\s*mm\s*(?:lens)?,?\s*)?/i, '');
  return fit(text.replace(/\s*,(?:\s*,)+/g, ',').replace(/^[\s,]+|[\s,.]+$/g, ''), 170);
}

// The board for the approval, in English: the treatment, the leitmotif, the chapters, the numbers with the estimate, then one block for every unit.
function boardText({ grid, content, figure, plan, cost, settings, fallbacks, leftOut = [] }) {
  const out = [];
  const short = figure.short || content.figureShort;
  out.push('TREATMENT', content.treatment || '(the language model wrote none)', '');
  const values = (list) => list.map((value) => (value < 10 ? String(value).padStart(2, '0') : group(value))).join(' → ');
  const hud = content.hud;
  out.push(`LEITMOTIF  ${hud.title} · ${hud.counterLabel} ${values(hud.counterValues)}${hud.instancesValues ? ` · ${hud.instancesLabel || 'INSTANCES'} ${values(hud.instancesValues)}` : ''}`);
  out.push(
    `CHAPTERS   ${grid.sections.map((section, at) => `${roman(at + 1)} ${content.chapters[at].name} (${roughTime(section.start)}–${roughTime(section.end)}${content.chapters[at].look ? `, look ${fit(content.chapters[at].look, 70)}` : ''}${content.chapters[at].set ? `, set ${fit(content.chapters[at].set, 60)}` : ''})`).join(' · ')}`
  );
  const sung = grid.units.filter((unit) => unit.kind === 'performance');
  const withFigure = grid.units.reduce((sum, unit) => (content.units[unit.index].withFigure ? sum + unit.duration : sum), 0);
  out.push(
    `NUMBERS    ${grid.cuts.length} cuts (${round2((grid.cuts.length * 60) / grid.duration)}/min) · figure ${Math.round((withFigure / grid.duration) * 100)}% on screen · lip sync ${round2(sung.reduce((sum, unit) => sum + unit.duration, 0))} s · ${grid.units.length} units (${sung.length} sung, ${plan.story.length} story, ${plan.still.length} still) · estimate ${money(cost.total)} USD`
  );
  const names = { sheet: 'portrait sheet', plates: `${grid.units.length} plates`, lipsync: 'lip sync', clips: `${plan.story.length} clips`, depth: `${plan.still.length} depth maps`, llm: 'language model' };
  out.push(`ESTIMATE   ${Object.keys(names).map((name) => `${names[name]} ${money(cost.parts[name])}`).join(' + ')} = ${money(cost.total)} USD${cost.total === null ? ` (unknown: ${cost.unknown.join(', ')})` : ''}; a second attempt of the language model adds about ${money(cost.parts.llm)} USD`);
  if (fallbacks && (fallbacks.units.length || fallbacks.lines.length || fallbacks.hud || fallbacks.chapters.length)) {
    out.push(`PLAIN      made without the language model: ${[fallbacks.units.length ? `${fallbacks.units.length} plates` : '', fallbacks.lines.length ? `${fallbacks.lines.length} lines of graphics` : '', fallbacks.hud ? 'the HUD values' : '', fallbacks.chapters.length ? `${fallbacks.chapters.length} chapter names` : ''].filter(Boolean).join(', ')}`);
  }
  out.push('');

  // the devices of a line are listed in the unit its first word is sung in
  const unitOfLine = new Map();
  for (const line of grid.lines) unitOfLine.set(line.index, unitAtTime(grid, line.words[0].start).index);
  const deviceOf = new Map();
  for (const device of plan.graphics.graphics) {
    if (!deviceOf.has(device.line)) deviceOf.set(device.line, []);
    deviceOf.get(device.line).push(device);
  }
  const dropped = new Set(leftOut.map((device) => device.id));
  for (const unit of grid.units) {
    const entry = content.units[unit.index];
    const lineIndexes = grid.lines.filter((line) => unitOfLine.get(line.index) === unit.index).map((line) => line.index);
    const lyric = lineIndexes.length ? ` «${fit(grid.lines[lineIndexes[0]].text, 60)}${grid.lines[lineIndexes[0]].text.length > 60 || lineIndexes.length > 1 ? ' …' : ''}»` : '';
    const here = lineIndexes.flatMap((index) => deviceOf.get(index) || []).filter((device) => device.type !== 'display' && !dropped.has(device.id));
    const words = lineIndexes.flatMap((index) => (deviceOf.get(index) || []).filter((device) => device.type === 'display' && !dropped.has(device.id)));
    const graphics = here.length ? `  Graphics: ${here.map(deviceName).join(', ')}` : '';
    const bigWords = words.length ? ` · Words: ${words.map((device) => `${device.rows.map((row) => row.text).join(' | ')} (${device.style})`).join('; ')}` : '';
    out.push(`${String(unit.index).padStart(2, ' ')}  ${timeText(unit.start)}–${timeText(unit.end)}  ${KIND_LABEL[unit.kind].padEnd(5, ' ')}  ${(entry.withFigure ? entry.framing : `${entry.framing}, no figure`).padEnd(4, ' ')}${lyric}${graphics}${bigWords}`);
    out.push(`        ${sceneText(entry.plate, figure, short)}${entry.motion ? `  [motion: ${fit(entry.motion.replace(/\s*No text, letters or logos\.?$/i, ''), 110)}]` : ''}`);
  }
  if (leftOut.length) {
    out.push('', `LEFT OUT   ${leftOut.length} ${leftOut.length === 1 ? 'graphic' : 'graphics'} found no place beside the face and ${leftOut.length === 1 ? 'is' : 'are'} not drawn: ${leftOut.map((device) => `${device.type} on line ${device.line} (unit ${device.unit})`).join(', ')}`);
  }
  return out.join('\n');
}

/* ---------- the run ---------- */

// The tokens the model may use for its answer, thinking included. The planner of the explainer video has 24000 (PLAN_MAX_TOKENS in lib/nodes/nodes-explainer.js) for a script of
// about 10 000 tokens. The answer here is bigger: a plate (about 110 tokens) and for a third of the units a motion prompt (45), for every line a display and one to three graphics
// (about 220 tokens), and the film itself (treatment, chapters, ticker, counters) with about 1500: 40 units and 45 lines make 15 to 20 thousand tokens of JSON (see llmTokens).
// A model that thinks first spends thousands more on thinking, which count against the same limit; at 24000 a film with 50 units and 60 lines could end at the limit with nothing
// written. 32000 leaves about 12 000 tokens for thinking with the biggest film, and costs nothing unless they are used.
const PLAN_MAX_TOKENS = 32000;
// A model that thought until the limit and wrote nothing would do the same again: the next try thinks less (as the scenes of the explainer video do, RETRY_REASONING_EFFORT).
const RETRY_REASONING_EFFORT = 'low';
// One answer, and at most one more: with the problems of the first, or with less thinking after an empty one. What is still missing is made plain.
const MAX_ATTEMPTS = 2;

const GRID_WARNING_LOGS = Object.freeze({
  NO_WINDOWS: 'No stretch of lines is long enough for the lip sync (5 to 8 s in a gap between two words): there is no sung unit.',
  OFF_BEAT_WINDOWS: 'The lines are so close that some sung windows end between two beats.',
  FEWER_CUTS: 'The units do not allow so many cuts (the limit of units and the length of a clip): the film has fewer cuts than asked for.'
});

const errorText = (err) => String(err?.message || err).slice(0, 200);

// The whole planner without the network: the grid, the model (through `ask`), the checks with a second try, the plain values for the rest, the graphics through the layout, the
// board and the estimate. `ask({ system, prompt, json, maxTokens, reasoningEffort })` returns { text, usd } or throws (an empty answer carries emptyAnswer, finishReason and usd);
// `fatal(err)` says which errors end the node (the end of the run, an exhausted budget).
async function runPlanner(input) {
  const { analysis, timing, brief, figureText, style = '', theme = themes.DEFAULT, accent = graphicsLib.DEFAULT_ACCENT, hudLanguage = 'en', options = {}, ask, log = () => {}, prices = {}, fatal = () => false } = input;
  const figure = parseFigure(figureText);
  const grid = planGrid(analysis, timing, options);
  for (const code of grid.warnings) if (GRID_WARNING_LOGS[code]) log(GRID_WARNING_LOGS[code]);
  const system = systemPrompt({ theme, hudLanguage, needShort: !figure.hasShort });
  const costs = [];
  const tries = [];
  let effort = null;
  let told = [];
  let previous = '';
  let made = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt = userPrompt({ brief, style, figure, grid, problems: told, previous });
    let result;
    try {
      result = await ask({ system, prompt, json: true, maxTokens: PLAN_MAX_TOKENS, ...(effort ? { reasoningEffort: effort } : {}) });
    } catch (err) {
      if (fatal(err)) throw err;
      // a failed answer can still have been billed (an empty one carries the cost the provider reported)
      if (typeof err?.usd === 'number') costs.push(err.usd);
      if (!err?.emptyAnswer) {
        // an error of the call itself (the network, the account): the first answer is needed; a failed second one leaves the first
        if (!tries.length) throw err;
        log(`The second request to the language model failed (${errorText(err)}): the first answer is used.`);
        break;
      }
      log(`Attempt ${attempt} of ${MAX_ATTEMPTS}: the language model wrote nothing (${errorText(err)})`);
      if (attempt >= MAX_ATTEMPTS) break;
      // empty because the limit of tokens was reached: the model thought until the end, and the same try would end the same way
      if (err.finishReason === 'length' && !effort) {
        effort = RETRY_REASONING_EFFORT;
        log(`The model thought until the limit of ${PLAN_MAX_TOKENS} tokens and wrote nothing: the next try thinks less (effort ${effort}).`);
      }
      continue;
    }
    made += 1;
    costs.push(result.usd);
    const read = readAnswer(result.text, { grid, figure });
    const done = completeContent(read.ok ? read.content : null, { grid, figure, brief, theme });
    const looped = layoutLoop({ grid, content: done.content, figure, theme, accent, hudLanguage });
    const problems = [...read.problems, ...layoutProblems(looped.check.leftOut, done.content, { theme })];
    tries.push({ attempt, read, done, looped, problems, score: read.ok ? problems.length : 1e6 + problems.length });
    if (!problems.length) break;
    if (attempt < MAX_ATTEMPTS) {
      log(`The answer of the language model had ${problems.length} problem${problems.length === 1 ? '' : 's'}: asking once more (${problems.slice(0, 2).join('; ').slice(0, 200)})`);
      told = problems;
      previous = read.ok ? result.text : '';
    }
  }

  // the better of the answers (the later one where they are equally good), or nothing but plain values
  let best = tries.slice().sort((a, b) => a.score - b.score || b.attempt - a.attempt)[0];
  if (!best) {
    const done = completeContent(null, { grid, figure, brief, theme });
    best = { attempt: 0, read: { ok: false, problems: [], notes: [] }, done, looped: layoutLoop({ grid, content: done.content, figure, theme, accent, hudLanguage }), problems: [], score: 0 };
    log('The language model delivered no usable answer: the plates, the graphics and the HUD values are plain ones.');
  } else if (best.problems.length) {
    log(`${best.problems.length} problem${best.problems.length === 1 ? '' : 's'} left after the last try: the node corrected them where it could (${best.problems.slice(0, 2).join('; ').slice(0, 200)})`);
  }
  const content = best.done.content;
  const plan = buildPlan({ grid, content, figure, brief, looped: best.looped });
  const promptChars = system.length + userPrompt({ brief, style, figure, grid }).length;
  const cost = estimateCost({ grid, settings: grid.settings, prices, promptChars });
  const board = boardText({ grid, content, figure, plan, cost, settings: grid.settings, fallbacks: best.done.fallbacks, leftOut: best.looped.check.leftOut });
  return {
    figure,
    grid,
    content,
    plan,
    board,
    sheetPrompt: sheetPrompt(figure),
    cost,
    costs,
    attempts: made,
    effort,
    problems: best.problems,
    notes: best.read.notes || [],
    fallbacks: best.done.fallbacks,
    leftOut: best.looped.check.leftOut
  };
}

module.exports = {
  PLAN_MAX_TOKENS,
  RETRY_REASONING_EFFORT,
  MAX_ATTEMPTS,
  GRID_WARNING_LOGS,
  DEFAULTS,
  RANGES,
  HUD_LANGUAGES,
  DEVICE_TAILS,
  GRAPHIC_TYPES,
  HUD_LIMITS,
  TICKER,
  GRAPHICS_PER_LINE,
  FIGURE_SHARE_MIN,
  TYPES_MIN,
  normalizeSettings,
  parseFigure,
  deriveShort,
  sheetPrompt,
  planGrid,
  typicalSizes,
  freeLanes,
  typesFitting,
  deviceCatalogue,
  answerSchema,
  systemPrompt,
  userPrompt,
  readAnswer,
  completeContent,
  numberInLine,
  buildGraphics,
  checkLayout,
  layoutLoop,
  layoutProblems,
  buildPlan,
  llmTokens,
  estimateCost,
  boardText,
  runPlanner
};
