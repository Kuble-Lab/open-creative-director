'use strict';

// The timing of a scene of an explainer video (WP37b): where the voice says what, and from that when each element appears. Pure
// functions: no network, no files, no clock; the nodes (lib/nodes/nodes-explainer-video.js) call them.
//
//   wordsFromAlignment()   the characters of ElevenLabs (with their start and end times) -> the words with their times
//   timingOf()             the timing of a scene as JSON (the format of audio.lyrics_timing: words, lines, duration)
//   silentTiming()         the timing of a scene without a voice: no words
//   cuesFor()              one time for each element of the scene: the start of its anchor word minus a little, never too early
//   sceneDuration()        the length of the scene: the voice plus a pause, rounded up to a whole frame
//
// The code computes all of this; the language model is only told the times (a model that estimates them drifts away from the voice).

const FPS = 30;
// The pause after the voice before the next scene begins.
const TAIL_SECONDS = 0.4;
// An element appears this long before its anchor word is said, and never earlier than MIN_CUE after the start.
const LEAD_SECONDS = 0.15;
const MIN_CUE = 0.2;
// A title that is pulled forward to the start of the scene (see cuesFor) is noted when it comes this much earlier than its anchor said.
const TITLE_NOTE_SECONDS = 0.3;
// A scene without a voice (the sources card): the elements come one after the other from this time on, this far apart.
const SILENT_START = 0.3;
const SILENT_STEP = 0.35;
// The length of the silence that stands in for the voice of a scene without narration.
const SILENT_SECONDS = 4;
// A line of subtitles (the lines of the timing): at most this many words and characters, broken after a full stop where there is one.
const LINE_WORDS = 9;
const LINE_CHARS = 56;

const round3 = (value) => Math.round(value * 1000) / 1000;

/* ---------- the scene length ---------- */

// Rounds up to a whole frame: Math.ceil(d x fps) / fps. The small subtrahend keeps 4.4 s (132.00000000000003 frames) from becoming 133.
function frameExact(seconds, fps = FPS) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value * fps - 1e-6) / fps;
}

// The length of a scene: the length of its voice plus the pause, rounded up to a whole frame (the render rounds up itself, so a
// length that is not a whole number of frames would be longer than the video the app computes with: 5.84 s -> 5.867 s).
function sceneDuration(voiceSeconds, fps = FPS) {
  return round3(frameExact((Number(voiceSeconds) || 0) + TAIL_SECONDS, fps));
}

/* ---------- the words ---------- */

// The words of a text with the times of their characters: [{ text, start, end }]. A word is a run of characters between spaces (also
// no-break spaces and line breaks); its start is the start of its first character, its end the end of its last. Characters without a
// usable time take the time of their neighbour. alignment: { characters, starts, ends } (seconds, as lib/elevenlabs.js reads them).
function wordsFromAlignment(alignment) {
  if (!alignment || !Array.isArray(alignment.characters)) return [];
  const { characters, starts, ends } = alignment;
  const words = [];
  let text = '';
  let start = null;
  let end = null;
  const flush = () => {
    if (text) words.push({ text, start: round3(start), end: round3(Math.max(start, end)) });
    text = '';
    start = null;
    end = null;
  };
  for (let index = 0; index < characters.length; index += 1) {
    const char = String(characters[index] ?? '');
    if (/^\s*$/.test(char)) {
      flush();
      continue;
    }
    const from = Number.isFinite(starts[index]) ? starts[index] : Number.isFinite(ends[index]) ? ends[index] : end ?? 0;
    const to = Number.isFinite(ends[index]) ? ends[index] : from;
    text += char;
    if (start === null) start = from;
    end = to;
  }
  flush();
  // times never run backwards
  for (let index = 1; index < words.length; index += 1) {
    if (words[index].start < words[index - 1].start) words[index].start = words[index - 1].start;
    if (words[index].end < words[index].start) words[index].end = words[index].start;
  }
  return words;
}

// The words broken into the lines of the subtitles: after a word that ends a sentence, and where a line gets too long (at a comma where
// one is near the end). Returns [{ text, start, end, from, to }] with from/to the indexes of the first and the last word of the line.
function linesOf(words) {
  const lines = [];
  let from = 0;
  const push = (to) => {
    const part = words.slice(from, to + 1);
    if (part.length) lines.push({ text: part.map((word) => word.text).join(' '), start: part[0].start, end: part[part.length - 1].end, from, to });
    from = to + 1;
  };
  for (let index = 0; index < words.length; index += 1) {
    const size = index - from + 1;
    const chars = words.slice(from, index + 1).reduce((sum, word) => sum + word.text.length + 1, 0);
    if (/[.!?…]["»”')\]]*$/.test(words[index].text)) push(index);
    else if (size >= LINE_WORDS || chars >= LINE_CHARS) {
      // the last comma of the line, when it is in its second half, is the better place to break
      let cut = index;
      for (let back = index; back > from + Math.floor(size / 2); back -= 1) {
        if (/[,;:–—]$/.test(words[back].text)) {
          cut = back;
          break;
        }
      }
      push(cut);
      // the words after the cut start the next line: look at them again
      index = cut;
    }
  }
  push(words.length - 1);
  return lines;
}

// The timing of a scene as the nodes pass it on: { version, source, duration, words, lines } (the shape of audio.lyrics_timing, so the
// caption script of lib/captions-ass.js reads it). Every word names its line. duration: the length of the voice in seconds.
function timingOf(words, duration) {
  const lines = linesOf(words);
  const outWords = words.map((word) => ({ ...word }));
  lines.forEach((line, index) => {
    for (let at = line.from; at <= line.to; at += 1) outWords[at].line = index;
  });
  const known = Number.isFinite(duration) && duration > 0 ? duration : words.length ? words[words.length - 1].end : 0;
  return {
    version: 1,
    source: 'speech',
    duration: round3(known),
    words: outWords,
    lines: lines.map((line) => ({ text: line.text, start: line.start, end: line.end }))
  };
}

// A scene without a voice: no words, no lines, the length of the silence.
function silentTiming(duration = SILENT_SECONDS) {
  return { version: 1, source: 'silence', duration: round3(duration), words: [], lines: [] };
}

// The timing of a scene as JSON text -> { words, duration }; null where it cannot be read.
function parseTiming(text) {
  let data = text;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text);
    } catch (_) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.words)) return null;
  const words = data.words
    .filter((word) => word && typeof word.text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end))
    .map((word) => ({ text: word.text, start: word.start, end: word.end }));
  const last = words.length ? words[words.length - 1].end : 0;
  return { words, duration: Number.isFinite(data.duration) && data.duration > 0 ? data.duration : last };
}

/* ---------- the anchors ---------- */

// Letters and digits in lower case, as the planner compares them (lib/explainer-plan.js normalise): "Prozent." -> "prozent".
function tokens(text) {
  return (String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
}

// The words of a text as a person says them, one entry per word between spaces, without case and punctuation: "412,30 Metern" ->
// ["41230", "metern"] (a number with a comma stays one word, as the voice says it), "Grundlagen-Kurs" -> ["grundlagenkurs"].
function spokenTokens(text) {
  return String(text || '')
    .split(/\s+/)
    .map((word) => tokens(word).join(''))
    .filter(Boolean);
}

// Do two words count as the same? Equal, or one begins with the other (four letters at least: "Million" ~ "Millionen"), or they share
// the first five letters ("Wärmepumpe" ~ "Wärmepumpen").
function similar(a, b) {
  if (a === b) return true;
  const low = Math.min(a.length, b.length);
  if (low >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return low >= 5 && a.slice(0, 5) === b.slice(0, 5);
}

// Where the anchor stands in the words of the voice (`spoken`, see spokenTokens), at or after `from`: { index, how } with the index of
// its first word (-1: not found). Three tries, the first that finds something counts: the phrase word for word ('exact'), the phrase
// with similar words ('similar'), the first word of the phrase that is long enough to mean something, three letters or a number
// ('first word').
function findAnchor(anchor, spoken, from) {
  const wanted = spokenTokens(anchor);
  if (!wanted.length) return { index: -1, how: null };
  const same = (a, b) => a === b;
  const run = (match) => {
    for (let at = Math.max(0, from); at + wanted.length <= spoken.length; at += 1) {
      if (wanted.every((word, offset) => match(word, spoken[at + offset]))) return at;
    }
    return -1;
  };
  let index = run(same);
  if (index >= 0) return { index, how: 'exact' };
  index = run(similar);
  if (index >= 0) return { index, how: 'similar' };
  const strong = wanted.find((word) => word.length >= 3 || /^\d+$/.test(word));
  if (strong) {
    for (let at = Math.max(0, from); at < spoken.length; at += 1) {
      if (similar(strong, spoken[at])) return { index: at, how: 'first word' };
    }
  }
  return { index: -1, how: null };
}

// The times at which the elements of a scene appear.
//   elements  [{ id, type, content, anchor }] in the order of the plan
//   timing    { words: [{ text, start, end }], duration } of the voice (see parseTiming); no words: a scene without a voice
//   duration  the length of the scene in seconds
// Returns { cues: [{ id, type, anchor, at, found }], notes: [text] } with one cue per element in the order of the elements:
//   - found: the start of the anchor word minus LEAD_SECONDS, never below MIN_CUE; the anchor is searched from the word of the
//     cue before (the first occurrence from there), without case and punctuation, then with similar words, then by its first strong word
//   - an anchor that is not found in the narration, or an element without one: the cue is spread evenly between its neighbours
//     (or over the scene, when none is found), and a note says so
//   - the times never run backwards: an element whose anchor is said before the cue of the element before it comes at that cue
//   - a title that is the first element opens the scene: it comes at MIN_CUE, whatever its anchor says (a title tied to a word far into
//     the narration left the scene empty for seconds); the other elements keep their times, and a note says it where the title comes
//     more than TITLE_NOTE_SECONDS earlier than before
//   - a scene without words in its voice: the elements come one after the other from SILENT_START on
function cuesFor(elements, timing, duration) {
  const list = Array.isArray(elements) ? elements : [];
  const words = timing && Array.isArray(timing.words) ? timing.words : [];
  const notes = [];
  const total = Number.isFinite(duration) && duration > 0 ? duration : timing?.duration || 0;
  const latest = Math.max(MIN_CUE, total - 0.3);
  if (!list.length) return { cues: [], notes };
  const cueOf = (element, at, found) => ({ id: element.id, type: element.type, anchor: element.anchor || '', at: round3(Math.min(latest, Math.max(MIN_CUE, at))), found });
  if (!words.length) return { cues: list.map((element, index) => cueOf(element, SILENT_START + index * SILENT_STEP, false)), notes };

  const spoken = words.map((word) => tokens(word.text).join(''));
  const end = Math.min(latest, Math.max(words[words.length - 1].end, MIN_CUE));
  // 1 the anchors that are said
  const at = new Array(list.length).fill(null);
  let pointer = 0;
  let previous = 0;
  list.forEach((element, index) => {
    if (!element.anchor) return;
    let hit = findAnchor(element.anchor, spoken, pointer);
    let before = false;
    if (hit.index < 0) {
      // not said from here on: said earlier, then the element comes at the cue before it
      hit = findAnchor(element.anchor, spoken, 0);
      before = hit.index >= 0;
    }
    if (hit.index < 0) return;
    let time = Math.max(MIN_CUE, words[hit.index].start - LEAD_SECONDS);
    if (before) notes.push(`${element.id}: the anchor "${element.anchor}" is said before the element before it; it comes together with that one`);
    else pointer = hit.index;
    if (hit.how !== 'exact') notes.push(`${element.id}: the anchor "${element.anchor}" was found as a similar word`);
    time = Math.max(time, previous);
    previous = time;
    at[index] = time;
  });
  // 2 what is not said: spread evenly between the cues around it
  const said = at.map((time) => time !== null);
  let index = 0;
  while (index < list.length) {
    if (at[index] !== null) {
      index += 1;
      continue;
    }
    let stop = index;
    while (stop < list.length && at[stop] === null) stop += 1;
    const count = stop - index;
    const low = index > 0 ? at[index - 1] : null;
    const high = stop < list.length ? at[stop] : null;
    for (let step = 0; step < count; step += 1) {
      let time;
      if (low !== null) {
        const top = high !== null ? high : Math.max(low, end);
        time = low + ((top - low) * (step + 1)) / (count + 1);
      } else {
        const top = high !== null ? high : end;
        time = MIN_CUE + (Math.max(MIN_CUE, top) - MIN_CUE) * (step / count);
      }
      at[index + step] = time;
      notes.push(`${list[index + step].id}: ${list[index + step].anchor ? `the anchor "${list[index + step].anchor}" is not in the narration` : 'no anchor'}; its time is spread evenly over the scene`);
    }
    index = stop;
  }
  const cues = list.map((element, position) => cueOf(element, at[position], said[position]));
  // after the clamp the order still holds
  for (let position = 1; position < cues.length; position += 1) if (cues[position].at < cues[position - 1].at) cues[position].at = cues[position - 1].at;
  // the title opens the scene (the others keep their times: none of them can come before MIN_CUE, so the order holds)
  if (cues[0].type === 'title' && cues[0].at > MIN_CUE) {
    const earlier = round3(cues[0].at - MIN_CUE);
    if (earlier > TITLE_NOTE_SECONDS) notes.push(`${cues[0].id}: the title comes at the start of the scene, ${earlier} s earlier than ${cues[0].anchor ? `its anchor "${cues[0].anchor}" would have put it` : 'its place in the scene would have put it'}`);
    cues[0].at = MIN_CUE;
  }
  return { cues, notes };
}

module.exports = {
  FPS,
  TAIL_SECONDS,
  LEAD_SECONDS,
  MIN_CUE,
  TITLE_NOTE_SECONDS,
  SILENT_START,
  SILENT_STEP,
  SILENT_SECONDS,
  LINE_WORDS,
  LINE_CHARS,
  frameExact,
  sceneDuration,
  wordsFromAlignment,
  linesOf,
  timingOf,
  silentTiming,
  parseTiming,
  tokens,
  spokenTokens,
  similar,
  findAnchor,
  cuesFor
};
