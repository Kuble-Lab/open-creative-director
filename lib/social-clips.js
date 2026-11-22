'use strict';

// Social clips from a film (node "Social clips from film", video.social_clips): the strongest passages of a film with speech (an
// interview, a talk, a podcast, a webinar, an explainer) as short clips for Reels, Shorts, TikTok and LinkedIn. The division of work
// is the one of the rough cut (lib/rough-cut.js, after Scarlet): the model decides, the code measures and keeps every clip safe.
//
//   1. the words of the film with their times (ElevenLabs Scribe, or a connected timing; lib/nodes/nodes-social-clips.js)
//   2. which passages make a clip: a language model reads the numbered words and names the first and the last word of every clip,
//      with a title, the hook, a post text and a score (systemPrompt, userPrompt, readClips); it names words, never times
//   3. the clips (readClips, planClips): each one is brought to the wanted length at the end of a sentence or at a pause, clips that
//      overlap a better one go, the edges are put into the pauses before the first and after the last word and on the frame grid
//   4. the words of every clip at their times in the clip (clipWords), for "Burn in captions"
//   5. the picture: the part of the frame that fits the wanted format (cropFor), around the face that was measured in the clip
//      (focusOf), or the whole frame on a blurred copy of itself; the ffmpeg arguments of a clip (renderArgs)
//
// Pure: no network, no files.

const lyricsTiming = require('./lyrics-timing');
const roughCut = require('./rough-cut');

const COUNT_MIN = 1;
const COUNT_MAX = 12;
const COUNT_DEFAULT = 3;
// Seconds: the limits of the length of a clip and their defaults.
const SECONDS_MIN = 5;
const SECONDS_MAX = 180;
const MIN_SECONDS_DEFAULT = 20;
const MAX_SECONDS_DEFAULT = 60;
// A clip of the model may be this much shorter than the minimum or longer than the maximum before the code repairs or drops it.
const SHORT_TOLERANCE = 0.7;
const LONG_TOLERANCE = 1.05;
// How many words the end of a clip is moved forward at most to reach the end of its sentence.
const EXTEND_WORDS = 25;
// Silence kept before the first word and after the last one of a clip, and the least distance to the neighbouring word outside it.
const LEAD_IN_SEC = 0.25;
const TAIL_SEC = 0.4;
const NEIGHBOUR_SEC = 0.04;
// A gap between two words from which a clip may end there when no sentence ends in reach.
const PAUSE_SEC = 0.5;
// At most this many words go to the model (two hours of fast speech). The model has to see the whole film to compare its passages.
const MAX_MODEL_WORDS = 30000;

const FORMATS = Object.freeze(['9:16', '4:5', '1:1', '16:9', 'source']);
const FRAMINGS = Object.freeze(['face', 'center', 'fit']);
// The long edge of the clip in px for every format (what the platforms take as full quality); "source" keeps the size of the film.
const SIZES = Object.freeze({ '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] });
// Seconds of the fade of the sound at both ends of a clip (no click at the cut).
const AUDIO_FADE_SEC = 0.04;

const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const endsSentence = (text) => /[.!?…]["»«”’)]*$/.test(String(text || ''));

function normaliseSettings(options = {}) {
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  const minSeconds = num(options.minSeconds, SECONDS_MIN, SECONDS_MAX, MIN_SECONDS_DEFAULT);
  const maxSeconds = Math.max(minSeconds, num(options.maxSeconds, SECONDS_MIN, SECONDS_MAX, MAX_SECONDS_DEFAULT));
  return { count: Math.round(num(options.count, COUNT_MIN, COUNT_MAX, COUNT_DEFAULT)), minSeconds, maxSeconds };
}

/* ---------- the model ---------- */

const LANGUAGE_NAMES = { de: 'German (Swiss High German: always "ss", never the sharp s)', en: 'English', es: 'Spanish' };

function systemPrompt() {
  return [
    'You are an editor for social media. You get the transcript of a film (an interview, a talk, a podcast, a webinar, an explainer) as',
    'numbered words and pick the passages that work best as short clips on Reels, Shorts, TikTok and LinkedIn.',
    'A good clip:',
    '- stands on its own: a viewer who has not seen the film understands it; no "as I said before", no answer without its question or context',
    '- starts with a hook in its first sentence: a surprising claim, a question, a number, a strong opinion, a problem the viewer knows',
    '- has one thought and brings it to an end: a point, a punch line, a result, an advice one can act on',
    '- starts at the beginning of a sentence and ends at the end of a sentence',
    'Prefer passages with energy, concrete examples, stories, numbers and quotable sentences. Leave out greetings, organisational talk,',
    'small talk, reading out of slides and passages that need the picture to be understood.',
    'A clip is one continuous passage of the film: you never skip, reorder or rewrite words. Clips must not overlap.',
    'Answer with JSON only: {"clips":[{"from":<index of the first word>,"to":<index of the last word>,"title":"<short title, at most 60 characters>",',
    '"hook":"<the sentence that opens the clip, as it is spoken>","post":"<a text for the post, 1 to 3 sentences, with 2 to 4 hashtags at the end>",',
    '"reason":"<why this passage works, one sentence>","score":<0 to 100: how well it works as a clip on its own>}]}.',
    'Indices are the numbers in square brackets. A clip covers the words from..to inclusive. Title, post and reason are written in the',
    'language of the film. Give fewer clips rather than weak ones; an empty list is a valid answer when nothing fits.'
  ].join('\n');
}

function userPrompt({ transcript, instructions = '', language = '', count, minSeconds, maxSeconds, feedback = '' }) {
  const settings = normaliseSettings({ count, minSeconds, maxSeconds });
  const parts = [];
  if (LANGUAGE_NAMES[language]) parts.push(`Language of the film: ${LANGUAGE_NAMES[language]}.`);
  parts.push(
    `Wanted: the ${settings.count === 1 ? 'best clip' : `${settings.count} best clips`}, each between ${Math.round(settings.minSeconds)} and ${Math.round(settings.maxSeconds)} seconds long ` +
      '(the time at the start of every line of the transcript tells you how long a passage is). ' +
      `Name up to ${Math.min(COUNT_MAX + 4, settings.count + 3)} candidates, so that the best ${settings.count} can be chosen by their score.`
  );
  const wish = String(instructions || '').trim();
  if (wish) parts.push(`Wishes of the editor (they win over the rules above where they differ):\n${wish}`);
  if (feedback) parts.push(`Your last answer could not be used: ${feedback} Answer again, with clips of the wanted length.`);
  parts.push(`Transcript (time of the line, then the numbered words):\n${transcript}`);
  return parts.join('\n\n');
}

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

const oneLine = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const spanOf = (words, from, to) => words[to].end - words[from].start;

// The last word of a clip that starts at `from`, brought into the wanted length: a clip that stops in the middle of a sentence is
// carried on to the end of that sentence (while it stays within the maximum), a clip that is too long ends at the last sentence end
// (else the last pause, else the last word) that still fits. Returns the index of the last word.
function fitEnd(words, from, to, { minSeconds, maxSeconds }) {
  let end = to;
  if (spanOf(words, from, end) <= maxSeconds && !endsSentence(words[end].text)) {
    for (let i = end + 1; i < words.length && i <= end + EXTEND_WORDS; i += 1) {
      if (spanOf(words, from, i) > maxSeconds) break;
      if (endsSentence(words[i].text)) {
        end = i;
        break;
      }
    }
  }
  if (spanOf(words, from, end) <= maxSeconds * LONG_TOLERANCE) return end;
  let lastFit = from;
  let sentence = -1;
  let pause = -1;
  for (let i = from; i <= end; i += 1) {
    if (spanOf(words, from, i) > maxSeconds) break;
    lastFit = i;
    if (spanOf(words, from, i) < minSeconds * SHORT_TOLERANCE) continue;
    if (endsSentence(words[i].text)) sentence = i;
    else if (words[i + 1] && words[i + 1].start - words[i].end >= PAUSE_SEC) pause = i;
  }
  return sentence >= 0 ? sentence : pause >= 0 ? pause : lastFit;
}

// The clips of the model's answer, checked against the words: whole indices within the transcript, the wanted length (repaired where
// it can be, see fitEnd; dropped where the passage is far too short), no overlaps (the clip with the better score stays), the best
// `count` of them, best first. Returns { clips: [{ from, to, title, hook, post, reason, score, seconds }], problems, readable }.
function readClips(text, words, options = {}) {
  const settings = normaliseSettings(options);
  const data = parseJsonObject(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.clips)) return { clips: [], problems: ['the answer is no JSON object with a list "clips"'], readable: false };
  const problems = [];
  const found = [];
  for (const [position, item] of data.clips.entries()) {
    const from = Number(item?.from);
    const rawTo = Number(item?.to);
    if (!Number.isInteger(from) || !Number.isInteger(rawTo) || from < 0 || rawTo < from || rawTo >= words.length) {
      problems.push(`clip ${position + 1}: the words ${item?.from}..${item?.to} are not in the transcript`);
      continue;
    }
    const to = fitEnd(words, from, rawTo, settings);
    const seconds = spanOf(words, from, to);
    if (seconds < settings.minSeconds * SHORT_TOLERANCE) {
      problems.push(`clip ${position + 1} (words ${from}..${rawTo}) is ${seconds.toFixed(0)} s long, shorter than the ${Math.round(settings.minSeconds)} s wanted`);
      continue;
    }
    const score = Number(item?.score);
    found.push({
      from,
      to,
      title: oneLine(item?.title, 100),
      hook: oneLine(item?.hook, 300),
      post: String(item?.post || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 800),
      reason: oneLine(item?.reason, 300),
      score: Number.isFinite(score) ? clamp(Math.round(score), 0, 100) : 50,
      seconds: round3(seconds),
      order: position
    });
  }
  found.sort((a, b) => b.score - a.score || a.order - b.order);
  const clips = [];
  for (const clip of found) {
    const other = clips.find((kept) => clip.from <= kept.to && clip.to >= kept.from);
    if (other) {
      problems.push(`the clip of the words ${clip.from}..${clip.to} overlaps a better one (${other.from}..${other.to}) and was left out`);
      continue;
    }
    if (clips.length < settings.count) clips.push(clip);
  }
  return { clips: clips.map(({ order: _order, ...clip }) => clip), problems, readable: true };
}

/* ---------- the times ---------- */

// The times of the clips in the film: from a little before the first word to a little after the last one, never into the word
// before or after the passage, on the frame grid of `fps`. Returns the clips with { start, end, duration } added.
function planClips({ words, duration, clips, fps }) {
  const length = Number(duration);
  if (!(length > 0)) throw new Error('planClips: the film has no length');
  const rate = roughCut.frameRate(fps);
  const frame = 1 / rate;
  return clips.map((clip) => {
    const first = words[clip.from];
    const last = words[clip.to];
    const before = words[clip.from - 1];
    const after = words[clip.to + 1];
    const earliest = before ? Math.min(first.start, before.end + Math.min(NEIGHBOUR_SEC, Math.max(0, first.start - before.end) / 2)) : 0;
    const latest = after ? Math.max(last.end, after.start - Math.min(NEIGHBOUR_SEC, Math.max(0, after.start - last.end) / 2)) : length;
    let start = Math.max(0, earliest, first.start - LEAD_IN_SEC);
    let end = Math.min(length, latest, last.end + TAIL_SEC);
    // on the grid: the start not after the first word, the end not before the last one
    start = Math.max(0, Math.floor(start / frame + 1e-6) * frame);
    end = Math.min(length, Math.ceil(end / frame - 1e-6) * frame);
    return { ...clip, start: round3(start), end: round3(end), duration: round3(end - start) };
  });
}

// The words of a clip at their times in the clip.
function clipWords(words, clip) {
  const out = [];
  for (let i = clip.from; i <= clip.to && i < words.length; i += 1) {
    const start = round3(Math.max(0, words[i].start - clip.start));
    out.push({ text: words[i].text, start, end: round3(Math.max(start, Math.min(clip.duration, words[i].end - clip.start))) });
  }
  return out;
}

/* ---------- the picture ---------- */

// The size of the clip: the size of the format (SIZES), or of the film for "source" (even numbers).
function outputSize(format, source) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  if (SIZES[format]) return { width: SIZES[format][0], height: SIZES[format][1] };
  return { width: even(source.width), height: even(source.height) };
}

// The part of the film's frame that has the shape of the clip: as large as it can be, its middle at `focusX` and `focusY` (shares of
// the width and height, 0..1) and moved back into the frame where it would stick out. Even numbers. { w, h, x, y }.
function cropFor({ width, height, format, focusX = 0.5, focusY = 0.5 }) {
  const out = outputSize(format, { width, height });
  const ratio = out.width / out.height;
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  let w = width;
  let h = height;
  if (width / height > ratio) w = even(height * ratio);
  else h = even(width / ratio);
  w = Math.min(even(w), even(width));
  h = Math.min(even(h), even(height));
  const x = Math.round(clamp(clamp(focusX, 0, 1) * width - w / 2, 0, width - w));
  const y = Math.round(clamp(clamp(focusY, 0, 1) * height - h / 2, 0, height - h));
  return { w, h, x, y };
}

// Where the face is in a clip. `perFrame` is [{ faces: [{ x, y, s, q }] }] in px of 1920 x 1080 (lib/music-video-hud/faces.js
// findFaces), a few frames of the clip. The largest face of every frame counts; the focus is the median of their middles, so a face
// that is only found in a few frames, or a second person who is seen for a moment, does not move it. Returns { x, y, share, spread }
// (shares of the frame; `share` the part of the frames with a face, `spread` how far the faces lie apart) or null with too few finds.
function focusOf(perFrame, { minShare = 0.2 } = {}) {
  const frames = Array.isArray(perFrame) ? perFrame : [];
  const points = [];
  for (const item of frames) {
    const faces = Array.isArray(item?.faces) ? item.faces.filter((face) => Number.isFinite(face?.x) && Number.isFinite(face?.y)) : [];
    if (!faces.length) continue;
    const largest = faces.reduce((best, face) => ((face.s || 0) > (best.s || 0) ? face : best), faces[0]);
    points.push({ x: clamp(largest.x / 1920, 0, 1), y: clamp(largest.y / 1080, 0, 1) });
  }
  if (!frames.length || points.length < 2 || points.length / frames.length < minShare) return null;
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const xs = points.map((point) => point.x);
  return { x: round3(median(xs)), y: round3(median(points.map((point) => point.y))), share: round3(points.length / frames.length), spread: round3(Math.max(...xs) - Math.min(...xs)) };
}

// The ffmpeg arguments that write the frames to look at for the face of a clip: `count` frames spread over the clip, 640 x 360 grey
// (the grid of the face finder), one after the other as raw bytes.
function faceFramesArgs({ input, output, start, duration, count }) {
  const every = Math.max(0.04, duration / count);
  return [
    '-nostdin', '-v', 'error', '-y',
    '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    '-an', '-vf', `fps=1/${every.toFixed(4)},scale=640:360:flags=area,format=gray`, '-frames:v', String(count),
    '-f', 'rawvideo', '-pix_fmt', 'gray', output
  ];
}

// The ffmpeg arguments of one clip: the passage start..end of the film, brought to the format. "face" and "center" fill the clip with
// the part of the frame around the focus (cropFor); "fit" shows the whole frame on a blurred, enlarged copy of itself. A film that
// already has the shape of the format is only scaled. The sound gets a fade of a few hundredths of a second at both ends.
function renderArgs({ input, output, start, end, source, format = '9:16', framing = 'face', focus = null, fps, hasAudio = true }) {
  const duration = round3(end - start);
  const out = outputSize(format, source);
  const sameShape = Math.abs(source.width / source.height - out.width / out.height) < 0.01;
  const rate = roughCut.frameRate(fps);
  const fpsText = Number.isInteger(rate) ? String(rate) : Math.abs(rate - 30000 / 1001) < 1e-3 ? '30000/1001' : Math.abs(rate - 24000 / 1001) < 1e-3 ? '24000/1001' : Math.abs(rate - 60000 / 1001) < 1e-3 ? '60000/1001' : String(Math.round(rate * 1000) / 1000);
  const graph = [];
  if (format === 'source' || sameShape) {
    graph.push(`[0:v]fps=${fpsText},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[v]`);
  } else if (framing === 'fit') {
    graph.push(
      `[0:v]fps=${fpsText},split=2[bg0][fg0]`,
      `[bg0]scale=${out.width}:${out.height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${out.width}:${out.height},boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.12[bg]`,
      `[fg0]scale=${out.width}:${out.height}:force_original_aspect_ratio=decrease:flags=lanczos:force_divisible_by=2[fg]`,
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]'
    );
  } else {
    const crop = cropFor({ width: source.width, height: source.height, format, focusX: framing === 'face' && focus ? focus.x : 0.5, focusY: 0.5 });
    graph.push(`[0:v]fps=${fpsText},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[v]`);
  }
  if (hasAudio) {
    const fade = Math.min(AUDIO_FADE_SEC, duration / 4);
    graph.push(`[0:a]aresample=48000,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, duration - fade).toFixed(3)}:d=${fade.toFixed(3)}[a]`);
  }
  return [
    '-nostdin', '-v', 'error', '-y',
    '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
    '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart', output
  ];
}

/* ---------- the texts ---------- */

// The text of the post of a clip: the title, then the post text of the model.
function postText(clip) {
  return [clip.title, clip.post].filter(Boolean).join('\n\n');
}

// The overview of the clips: "1. Title (0:42.0–1:15.5, 33 s, score 92)", the hook and the reason.
function clipsReport(clips, { language = 'de', duration = 0 } = {}) {
  const labels = {
    de: { head: (n) => `${n} ${n === 1 ? 'Clip' : 'Clips'} aus ${lyricsTiming.formatTime(duration)} Film.`, score: 'Wertung', hook: 'Einstieg', why: 'Warum' },
    en: { head: (n) => `${n} ${n === 1 ? 'clip' : 'clips'} from ${lyricsTiming.formatTime(duration)} of film.`, score: 'score', hook: 'Hook', why: 'Why' },
    es: { head: (n) => `${n} ${n === 1 ? 'clip' : 'clips'} de ${lyricsTiming.formatTime(duration)} de película.`, score: 'puntuación', hook: 'Gancho', why: 'Por qué' }
  };
  const l = labels[language] || labels.en;
  const blocks = clips.map((clip, index) =>
    [
      `${index + 1}. ${clip.title || '–'} (${lyricsTiming.formatTime(clip.start)}–${lyricsTiming.formatTime(clip.end)}, ${Math.round(clip.duration)} s, ${l.score} ${clip.score})`,
      clip.hook ? `${l.hook}: «${clip.hook}»` : '',
      clip.reason ? `${l.why}: ${clip.reason}` : ''
    ].filter(Boolean).join('\n')
  );
  return [l.head(clips.length), '', blocks.join('\n\n')].join('\n').trim();
}

module.exports = {
  COUNT_MIN,
  COUNT_MAX,
  COUNT_DEFAULT,
  SECONDS_MIN,
  SECONDS_MAX,
  MIN_SECONDS_DEFAULT,
  MAX_SECONDS_DEFAULT,
  MAX_MODEL_WORDS,
  FORMATS,
  FRAMINGS,
  SIZES,
  normaliseSettings,
  systemPrompt,
  userPrompt,
  fitEnd,
  readClips,
  planClips,
  clipWords,
  outputSize,
  cropFor,
  focusOf,
  faceFramesArgs,
  renderArgs,
  postText,
  clipsReport
};
