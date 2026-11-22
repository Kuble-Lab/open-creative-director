'use strict';

// Rough cut of a recording (node "Rough cut from recording", video.rough_cut). The idea comes from Scarlet (Forward Future,
// MIT licence, github.com/Forward-Future/scarlet): the model decides what goes, the code measures and keeps every cut safe.
//
//   1. the words of the recording with their times (ElevenLabs Scribe, via the tool lyrics_timing; lib/nodes/nodes-rough-cut.js)
//   2. which words go: filler words by a list (fillerCuts), false starts and repeated takes by a language model that reads the
//      numbered words (transcriptForModel, systemPrompt, userPrompt, readCuts); the model names words, never times
//   3. the cut (planCut): the time to remove around those words, from the end of the word kept before them to the start of the word
//      kept after them, less a little padding on both sides, so an edge never lies inside a word; long pauses are shortened to
//      `maxPause`; the edges are put on the frame grid, so picture and sound lose exactly the same time and stay in sync
//   4. the timing of the words that are kept, moved to the times of the new film (remapWords), for subtitles and captions
//
// Pure: no network, no files. The ffmpeg arguments of the render are built here too (renderArgs).

const lyricsTiming = require('./lyrics-timing');

// Filler words that are cut by the list (lower case, without punctuation). Not words that also mean something ("er", "so", "like",
// "also", "mhm" as a yes): those are left to the language model.
const FILLERS = new Set([
  'äh', 'ähm', 'öh', 'öhm', 'ehm', 'hm', 'hmm', 'ähh', 'öhh',
  'uh', 'uhm', 'um', 'umm', 'erm', 'uhh',
  'eh', 'em', 'emm', 'este'
].map((word) => word.normalize('NFC')));
// "este" (es) is also a real word ("this"); it is only a filler when it stands alone between pauses, see isFiller.
const FILLER_ALONE_ONLY = new Set(['este', 'em']);

const KINDS = Object.freeze(['filler', 'false_start', 'retake', 'aside', 'pause']);
// Seconds: the padding left after the last word before a cut and before the first word after it (an edge never touches a word),
// the default longest pause, and the limits of the parameters.
const PADDING_DEFAULT = 0.08;
const PADDING_MAX = 0.5;
const MAX_PAUSE_DEFAULT = 0.7;
const MAX_PAUSE_MIN = 0.2;
const MAX_PAUSE_MAX = 5;
// Silence kept before the first word and after the last one when the ends are trimmed.
const LEAD_IN_SEC = 0.3;
const TAIL_SEC = 0.6;
// A removal shorter than this is not worth a cut (it would only make a jump in the picture); a piece kept shorter than this is dropped.
const MIN_CUT_SEC = 0.12;
const MIN_KEEP_SEC = 0.1;
// The frame rate used for the grid when the probe knows none.
const DEFAULT_FPS = 30;
// At most this many words go to the model in one request (about 20 minutes of speech); a longer transcript is refused before.
const MAX_MODEL_WORDS = 6000;

const round3 = (n) => Math.round(n * 1000) / 1000;
// The pieces keep microseconds: rounded to milliseconds an edge at 29.97 fps would leave the frame grid.
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const bare = (text) => String(text || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '');

function isFiller(words, index) {
  const word = bare(words[index]?.text);
  if (!FILLERS.has(word)) return false;
  if (!FILLER_ALONE_ONLY.has(word)) return true;
  const before = words[index - 1];
  const after = words[index + 1];
  const pauseBefore = !before || words[index].start - before.end >= 0.25;
  const pauseAfter = !after || after.start - words[index].end >= 0.25;
  return pauseBefore && pauseAfter;
}

// Every filler word as a cut of its own.
function fillerCuts(words) {
  const cuts = [];
  words.forEach((_word, index) => {
    if (isFiller(words, index)) cuts.push({ from: index, to: index, kind: 'filler', reason: '' });
  });
  return cuts;
}

// The words as the model reads them: "[index] word", a line per group of words between pauses, with the pause before the group.
// The model answers with indices, so it never has to guess a time.
function transcriptForModel(words) {
  const lines = [];
  let line = [];
  let lineStart = 0;
  const flush = (pause) => {
    if (!line.length) return;
    lines.push(`${lyricsTiming.formatTime(lineStart)}${pause ? ` (pause ${pause.toFixed(1)} s)` : ''}: ${line.join(' ')}`);
    line = [];
  };
  let pendingPause = 0;
  words.forEach((word, index) => {
    const previous = words[index - 1];
    const gap = previous ? word.start - previous.end : 0;
    if (previous && gap >= 0.6) {
      flush(pendingPause);
      pendingPause = gap;
    }
    if (!line.length) lineStart = word.start;
    line.push(`[${index}]${word.text}`);
  });
  flush(pendingPause);
  return lines.join('\n');
}

const LANGUAGE_NAMES = { de: 'German (Swiss High German: never the sharp s)', en: 'English', es: 'Spanish' };

function systemPrompt() {
  return [
    'You are a dialogue editor. You get the transcript of a recording (an interview, a talking head, a presentation, a podcast) as',
    'numbered words. You decide which words are cut for a clean first cut, as a careful human editor would:',
    '- false starts: a sentence or phrase that is started and abandoned, then started again ("We wanted to, we decided to ..." -> cut "We wanted to,")',
    '- repeated takes: the same thought said twice or more in a row; keep the best (usually the last, complete and fluent) take, cut the others',
    '- stutters and repeated words ("the the", "I I")',
    '- filler words (uh, um, äh, ähm, you know, like, also, halt, quasi) where they are only fillers and cutting them does not change the meaning',
    '- asides that are clearly not meant for the audience ("can we start again?", "wait, let me try that once more", counting in)',
    'Never cut content: facts, arguments, examples, jokes that work, the meaning of a sentence. When in doubt, keep it.',
    'Do not cut pauses: the app shortens long pauses on its own. Do not rewrite or reorder anything.',
    'Answer with JSON only: {"cuts":[{"from":<first word index>,"to":<last word index>,"kind":"false_start"|"retake"|"filler"|"aside","reason":"<short, in the language of the recording>"}],"summary":"<one sentence, in the language of the recording>"}.',
    'Indices are the numbers in square brackets. A cut covers the words from..to inclusive. Cuts must not overlap. An empty list is a valid answer.'
  ].join('\n');
}

function userPrompt({ transcript, instructions = '', language = '', removeFillers = true }) {
  const parts = [];
  if (LANGUAGE_NAMES[language]) parts.push(`Language of the recording: ${LANGUAGE_NAMES[language]}.`);
  if (!removeFillers) parts.push('Keep filler words: do not cut them (kind "filler" is not wanted).');
  const wish = String(instructions || '').trim();
  if (wish) parts.push(`Wishes of the editor (they win over the rules above where they differ):\n${wish}`);
  parts.push(`Transcript (time of the line, then the numbered words):\n${transcript}`);
  return parts.join('\n\n');
}

// Strips a code fence and reads the JSON object of the answer.
function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (__) {
        return null;
      }
    }
    return null;
  }
}

// The cuts of the model's answer, checked: whole indices within the words, from <= to, a known kind (else "retake"), no overlaps
// (a later cut that overlaps an earlier one is dropped). Returns { cuts, summary, problems, readable }.
function readCuts(text, wordCount, { removeFillers = true } = {}) {
  const data = parseJsonObject(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.cuts)) return { cuts: [], summary: '', problems: ['the answer is no JSON object with a list "cuts"'], readable: false };
  const problems = [];
  const cuts = [];
  for (const [position, item] of data.cuts.entries()) {
    const from = Number(item?.from);
    const to = item?.to === undefined || item?.to === null ? from : Number(item.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= wordCount) {
      problems.push(`cut ${position + 1}: the words ${item?.from}..${item?.to} are not in the transcript`);
      continue;
    }
    const kind = KINDS.includes(item?.kind) && item.kind !== 'pause' ? item.kind : 'retake';
    if (kind === 'filler' && !removeFillers) continue;
    cuts.push({ from, to, kind, reason: String(item?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  cuts.sort((a, b) => a.from - b.from || a.to - b.to);
  const clean = [];
  for (const cut of cuts) {
    const last = clean[clean.length - 1];
    if (last && cut.from <= last.to) {
      problems.push(`the cut of the words ${cut.from}..${cut.to} overlaps the one of ${last.from}..${last.to} and was left out`);
      continue;
    }
    clean.push(cut);
  }
  return { cuts: clean, summary: String(data.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400), problems, readable: true };
}

// Merges two sorted lists of word cuts (the list of filler words and the model's): where they overlap, the model's cut counts.
function mergeCuts(...lists) {
  const all = lists.flat().filter(Boolean).sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  for (const cut of all) {
    const last = out[out.length - 1];
    if (last && cut.from <= last.to) {
      if (cut.to > last.to) last.to = cut.to;
      continue;
    }
    out.push({ ...cut });
  }
  return out;
}

// The frame rate of the grid. A phone records with a variable rate whose average is a little off (60.017 for 60): a rate within 0.05 of
// a whole number or of an NTSC rate (23.976, 29.97, 59.94) is taken as that rate.
function frameRate(value) {
  const fps = Number(value);
  if (!(Number.isFinite(fps) && fps > 1 && fps <= 240)) return DEFAULT_FPS;
  for (const ntsc of [24000 / 1001, 30000 / 1001, 60000 / 1001]) if (Math.abs(fps - ntsc) < 0.01) return ntsc;
  return Math.abs(fps - Math.round(fps)) < 0.05 ? Math.round(fps) : fps;
}

function normaliseSettings(options = {}) {
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    padding: num(options.padding, 0, PADDING_MAX, PADDING_DEFAULT),
    maxPause: options.shortenPauses === false ? Infinity : num(options.maxPause, MAX_PAUSE_MIN, MAX_PAUSE_MAX, MAX_PAUSE_DEFAULT),
    trimEnds: options.trimEnds !== false,
    fps: frameRate(options.fps)
  };
}

// The plan of the cut. `words` [{ text, start, end }] in the order of time, `duration` the length of the recording, `cuts` the word
// cuts [{ from, to, kind, reason }]. Returns { keep: [{ start, end }], removed: [{ start, end, kind, reason, text }], duration,
// newDuration, settings }. Times in seconds on the frame grid of `fps`.
function planCut({ words, duration, cuts = [], ...options }) {
  const settings = normaliseSettings(options);
  const length = Number(duration);
  if (!(length > 0)) throw new Error('planCut: the recording has no length');
  const { padding, maxPause, trimEnds, fps } = settings;
  const removedWord = new Array(words.length).fill(null);
  for (const cut of cuts) for (let i = cut.from; i <= cut.to && i < words.length; i += 1) removedWord[i] = cut;
  const intervals = [];
  const add = (start, end, info) => {
    const a = Math.max(0, start);
    const b = Math.min(length, end);
    if (b - a >= MIN_CUT_SEC) intervals.push({ start: a, end: b, ...info });
  };
  const kept = words.map((_word, index) => index).filter((index) => !removedWord[index]);
  // the cuts of words: from the word kept before them to the word kept after them
  let i = 0;
  while (i < words.length) {
    if (!removedWord[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && removedWord[j + 1]) j += 1;
    const before = i > 0 ? words[i - 1] : null;
    const after = j + 1 < words.length ? words[j + 1] : null;
    const start = before ? before.end + padding : trimEnds ? 0 : Math.max(0, words[i].start - padding);
    const end = after ? after.start - padding : trimEnds ? length : Math.min(length, words[j].end + padding);
    const reasons = [...new Set(words.slice(i, j + 1).map((_w, k) => removedWord[i + k]).filter(Boolean))];
    const kinds = [...new Set(reasons.map((cut) => cut.kind))];
    add(start, end, {
      kind: kinds.length === 1 ? kinds[0] : kinds.includes('retake') ? 'retake' : kinds.includes('false_start') ? 'false_start' : kinds[0],
      reason: reasons.map((cut) => cut.reason).filter(Boolean).join('; ').slice(0, 300),
      text: words.slice(i, j + 1).map((word) => word.text).join(' ')
    });
    i = j + 1;
  }
  // long pauses between two kept words that follow each other: shortened to maxPause, half of it on each side
  if (Number.isFinite(maxPause)) {
    for (let k = 1; k < kept.length; k += 1) {
      const a = kept[k - 1];
      const b = kept[k];
      if (b !== a + 1) continue;
      const gap = words[b].start - words[a].end;
      if (gap > maxPause) add(words[a].end + maxPause / 2, words[b].start - maxPause / 2, { kind: 'pause', reason: `pause of ${gap.toFixed(1)} s`, text: '' });
    }
  }
  // the silence before the first and after the last kept word
  if (trimEnds && kept.length) {
    const first = words[kept[0]];
    const last = words[kept[kept.length - 1]];
    if (kept[0] === 0) add(0, first.start - LEAD_IN_SEC, { kind: 'pause', reason: 'silence at the start', text: '' });
    if (kept[kept.length - 1] === words.length - 1) add(last.end + TAIL_SEC, length, { kind: 'pause', reason: 'silence at the end', text: '' });
  }
  // merged, on the frame grid, and the pieces that are kept
  const frame = 1 / fps;
  const snap = (t) => Math.round(t / frame) * frame;
  const merged = [];
  for (const item of intervals.sort((a, b) => a.start - b.start)) {
    const start = snap(item.start);
    const end = Math.min(snap(item.end), length);
    if (end - start < frame / 2) continue;
    const last = merged[merged.length - 1];
    if (last && start <= last.end + 1e-6) {
      last.end = Math.max(last.end, end);
      if (item.kind !== 'pause') {
        last.kind = last.kind === 'pause' ? item.kind : last.kind;
        last.reason = [last.reason, item.reason].filter(Boolean).join('; ').slice(0, 300);
        last.text = [last.text, item.text].filter(Boolean).join(' ');
      }
      continue;
    }
    merged.push({ ...item, start, end });
  }
  const keep = [];
  let cursor = 0;
  for (const item of merged) {
    if (item.start - cursor >= MIN_KEEP_SEC) keep.push({ start: cursor, end: item.start });
    cursor = item.end;
  }
  if (length - cursor >= MIN_KEEP_SEC) keep.push({ start: cursor, end: length });
  if (!keep.length) throw Object.assign(new Error('Nothing would be left of the recording'), { code: 'ROUGHCUT_NOTHING_LEFT' });
  const out = keep.map((piece) => ({ start: round6(piece.start), end: round6(Math.min(piece.end, length)) }));
  const newDuration = round3(out.reduce((sum, piece) => sum + (piece.end - piece.start), 0));
  // what was removed, measured on the pieces (a piece kept too short to matter counts as removed)
  const removed = [];
  let previousEnd = 0;
  for (const piece of out) {
    if (piece.start - previousEnd > 1e-6) removed.push(describeGap(previousEnd, piece.start, merged));
    previousEnd = piece.end;
  }
  if (length - previousEnd > 1e-3) removed.push(describeGap(previousEnd, length, merged));
  return { keep: out, removed, duration: round3(length), newDuration, settings: { ...settings, maxPause: Number.isFinite(maxPause) ? maxPause : null } };
}

function describeGap(start, end, merged) {
  const inside = merged.filter((item) => item.end > start + 1e-6 && item.start < end - 1e-6);
  const kinds = inside.map((item) => item.kind).filter((kind) => kind !== 'pause');
  return {
    start: round3(start),
    end: round3(end),
    kind: kinds[0] || 'pause',
    reason: inside.map((item) => item.reason).filter(Boolean).join('; ').slice(0, 300),
    text: inside.map((item) => item.text).filter(Boolean).join(' ')
  };
}

// The time in the new film of a time of the recording; null when it lies in a removed part.
function mapTime(keep, t) {
  let offset = 0;
  for (const piece of keep) {
    if (t < piece.start - 1e-6) return null;
    if (t <= piece.end + 1e-6) return round3(offset + Math.min(piece.end, Math.max(piece.start, t)) - piece.start);
    offset += piece.end - piece.start;
  }
  return null;
}

// The words that are kept, at their times in the new film (a word whose start was cut away is dropped; its end is held inside its piece).
function remapWords(words, keep) {
  const out = [];
  for (const word of words) {
    const piece = keep.find((item) => word.start >= item.start - 1e-6 && word.start <= item.end + 1e-6);
    if (!piece) continue;
    const start = mapTime(keep, word.start);
    const end = mapTime(keep, Math.min(word.end, piece.end));
    if (start === null || end === null) continue;
    out.push({ text: word.text, start, end: Math.max(start, end) });
  }
  return out;
}

// The readable list of what was cut: "0:12.3–0:14.1 (1.8 s) false start: «we wanted to» – reason".
const KIND_LABELS = {
  de: { filler: 'Füllwort', false_start: 'Fehlstart', retake: 'Wiederholung', aside: 'Nebenbemerkung', pause: 'Pause' },
  en: { filler: 'filler', false_start: 'false start', retake: 'retake', aside: 'aside', pause: 'pause' },
  es: { filler: 'muletilla', false_start: 'falso comienzo', retake: 'repetición', aside: 'comentario aparte', pause: 'pausa' }
};

function cutReport(plan, { language = 'de', summary = '' } = {}) {
  const labels = KIND_LABELS[language] || KIND_LABELS.en;
  const lines = plan.removed.map((item) => {
    const seconds = (item.end - item.start).toFixed(1);
    const text = item.text ? `: «${item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text}»` : '';
    const reason = item.reason && item.kind !== 'pause' ? ` – ${item.reason}` : '';
    return `${lyricsTiming.formatTime(item.start)}–${lyricsTiming.formatTime(item.end)} (${seconds} s) ${labels[item.kind] || item.kind}${text}${reason}`;
  });
  const head = {
    de: `Vorher ${lyricsTiming.formatTime(plan.duration)}, nachher ${lyricsTiming.formatTime(plan.newDuration)}, ${plan.removed.length} Schnitte.`,
    en: `Before ${lyricsTiming.formatTime(plan.duration)}, after ${lyricsTiming.formatTime(plan.newDuration)}, ${plan.removed.length} cuts.`,
    es: `Antes ${lyricsTiming.formatTime(plan.duration)}, después ${lyricsTiming.formatTime(plan.newDuration)}, ${plan.removed.length} cortes.`
  }[language] || `Before ${lyricsTiming.formatTime(plan.duration)}, after ${lyricsTiming.formatTime(plan.newDuration)}, ${plan.removed.length} cuts.`;
  return [head, ...(summary ? [summary] : []), '', ...lines].join('\n').trim();
}

// The ffmpeg arguments of the cut: the picture is brought to a constant frame rate first (so the frame grid of the plan holds), then
// both streams keep the same pieces (select / aselect) and get new time stamps. One pass, one encode. aselect decides per block of
// samples, so the sound is first resampled to 48 kHz and cut into blocks of exactly one frame (48000 / fps samples, for 24, 25, 30,
// 50 and 60 fps) or, at rates such as 29.97, into blocks of 80 samples (1.7 ms): the sound then loses the same time as the picture.
const AUDIO_RATE = 48000;
const FINE_BLOCK_SAMPLES = 80;

function audioBlockSamples(fps) {
  const exact = AUDIO_RATE / fps;
  return Number.isInteger(exact) ? exact : Math.abs(exact - Math.round(exact)) < 1e-9 ? Math.round(exact) : FINE_BLOCK_SAMPLES;
}

function renderArgs({ input, output, keep, fps, hasAudio = true }) {
  const rate = frameRate(fps);
  // a frame is kept when it starts inside a piece: the bounds lie half a frame before the edges, so a rounded edge never loses or gains one
  const half = 0.5 / rate;
  const videoExpr = keep.map((piece) => `between(t,${(piece.start - half).toFixed(6)},${(piece.end - half).toFixed(6)})`).join('+');
  // a block of sound is kept when it starts inside a piece (10 µs below the edge for a rounded edge)
  const audioExpr = keep.map((piece) => `between(t,${(piece.start - 1e-5).toFixed(6)},${(piece.end - 1e-5).toFixed(6)})`).join('+');
  const fpsText = Number.isInteger(rate) ? String(rate) : Math.abs(rate - 30000 / 1001) < 1e-3 ? '30000/1001' : Math.abs(rate - 24000 / 1001) < 1e-3 ? '24000/1001' : Math.abs(rate - 60000 / 1001) < 1e-3 ? '60000/1001' : String(Math.round(rate * 1000) / 1000);
  const graph = [`[0:v]fps=${fpsText},select='${videoExpr}',setpts=N/FRAME_RATE/TB[v]`];
  if (hasAudio) graph.push(`[0:a]aresample=${AUDIO_RATE},asetnsamples=n=${audioBlockSamples(rate)}:p=0,aselect='${audioExpr}',asetpts=N/SR/TB[a]`);
  return [
    '-nostdin', '-v', 'error', '-y', '-i', input,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart', output
  ];
}

module.exports = {
  FILLERS,
  KINDS,
  PADDING_DEFAULT,
  PADDING_MAX,
  MAX_PAUSE_DEFAULT,
  MAX_PAUSE_MIN,
  MAX_PAUSE_MAX,
  MAX_MODEL_WORDS,
  isFiller,
  fillerCuts,
  transcriptForModel,
  systemPrompt,
  userPrompt,
  readCuts,
  mergeCuts,
  planCut,
  mapTime,
  remapWords,
  cutReport,
  audioBlockSamples,
  frameRate,
  renderArgs
};
