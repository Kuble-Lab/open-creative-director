'use strict';

// Cutting an explainer video (WP37b, node "Cut explainer video"): the timeline of the scenes, the sound underneath and the captions.
// Pure builders in the style of lib/music-video-edit.js, which does the picture: this module only prepares what that one takes.
//
//   planTimeline()     where each scene stands in the film, in whole frames: the scenes follow each other; under a crossfade the next
//                      scene fades in over the end of the one before (the film is that much shorter), and a scene next to the person on
//                      camera comes in over one frame only, so that the last words of the person are not faded away
//   shotsOf()          the timeline as the shot list that buildEditPlan() takes
//   soundtrackArgs()   the ffmpeg call that makes ONE sound for the whole film: every voice at the start of its scene, the music
//                      underneath (louder or quieter, ducked under the voice if wished)
//   voiceCuts()        the voices that are longer than the frames their scene keeps (soundtrackArgs cuts them off): a sentence for each
//   mergeTimings()     the word times of the scenes moved to the times of the film (for the captions and the subtitle file)
//   srtOf()            the subtitle file (SRT) from the lines of such a timing
//   lengthNote()       the real length against the length that was asked for
//
// Everything is counted in frames and samples, rounded once, so nothing drifts: the voice of the last scene sits exactly where its
// picture is.

const editLib = require('./music-video-edit');
const ops = require('./nodes/ffmpeg-ops');

const SAMPLE_RATE = 48000;
const TRANSITIONS = Object.freeze(['cut', 'crossfade']);
const MUSIC_LEVELS = Object.freeze({ off: 0, quiet: 0.12, medium: 0.25, loud: 0.45 });
const MUSIC_LEVEL_NAMES = Object.freeze(Object.keys(MUSIC_LEVELS));
const LENGTH_TOLERANCE = 0.15;

const num = ops.num;

/* ---------- the timeline ---------- */

// durations: the length of every shot in seconds, as measured (the scenes, the person on camera). hardCuts[i]: the shot i comes in over one
// frame only. Returns { fps, overlap, frames, fades, owns, starts, totalFrames, total }:
//   frames[i]  the frames of the shot as it is                       fades[i]   the frames over which shot i fades in over the one before
//   owns[i]    the frames of the shot until the next one begins      starts[i]  the first frame of shot i in the film
// The numbers are the ones buildEditPlan() computes from the shot list shotsOf() makes (its fadeInto), so the sound and the picture agree.
function planTimeline({ durations, hardCuts = [], fps = 30, transition = 'crossfade' }) {
  if (!Array.isArray(durations) || !durations.length) throw new Error('There are no scenes to cut');
  const frames = durations.map((seconds) => Math.max(1, Math.round(Number(seconds) * fps)));
  const overlap = transition === 'crossfade' ? Math.max(1, Math.round(editLib.CROSSFADE_SEC * fps)) : 0;
  const count = frames.length;
  const fades = new Array(count + 1).fill(0);
  const owns = new Array(count).fill(0);
  // from the end: the frames a shot keeps for itself are its own, less the fade of the next shot into it; a fade is never longer than
  // the shot it fades in (less one frame) nor than the shot it fades over (less one frame), so every shot keeps a frame at least
  for (let index = count - 1; index >= 0; index -= 1) {
    owns[index] = frames[index] - fades[index + 1];
    fades[index] = overlap && index >= 1 ? Math.max(0, Math.min(hardCuts[index] ? 1 : overlap, owns[index] - 1, frames[index - 1] - 1)) : 0;
  }
  const starts = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    starts.push(at);
    at += owns[index];
  }
  return { fps, overlap, frames, fades: fades.slice(0, count), owns, starts, totalFrames: at, total: at / fps };
}

// The shot list for buildEditPlan(). kinds[i]: 'motion' (a scene drawn by code: it is held, never slowed), 'clip' (a generated clip: it is
// cut off, or slowed down to 0.8 and then held), 'person' (on camera, padded to the format: held, never slowed).
function shotsOf({ timeline, kinds, aspectRatio, hardCuts = [], fits = [] }) {
  const { fps, starts, owns } = timeline;
  return {
    aspect_ratio: aspectRatio,
    shots: starts.map((start, index) => ({
      kind: kinds[index] === 'clip' ? 'story' : 'performance',
      start: start / fps,
      end: (start + owns[index]) / fps,
      ...(fits[index] ? { fit: fits[index] } : {}),
      ...(hardCuts[index] ? { hardCut: true } : {})
    }))
  };
}

/* ---------- the sound ---------- */

const STEREO = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
// a mono source is put on both sides as it is (the default matrix of ffmpeg lowers it by 3 dB)
const stereoOf = (channels) => (channels === 1 ? `aresample=${SAMPLE_RATE},pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp` : STEREO);

// The ffmpeg call that makes the sound of the film as a WAV (48 kHz, stereo, 16 bit) of exactly the length of the film.
//   voices   one entry per shot: { file, channels } with an audio stream, or { file: null } for silence (a shot without sound)
//   music    { file, level, duck, channels } or null    level: 0 to 1 (volume)    duck: lower the music while the voice speaks
//   timeline planTimeline()
// The voices are laid one after the other, each cut or padded to the frames its shot keeps for itself, so every voice begins exactly with
// its scene. The music is looped to the length of the film. Returns { argv } (without the program name).
function soundtrackArgs({ voices, music = null, timeline, outputFile }) {
  const perFrame = SAMPLE_RATE / timeline.fps;
  if (!Number.isInteger(perFrame)) throw new Error(`A frame rate of ${timeline.fps} does not divide the sample rate`);
  if (voices.length !== timeline.owns.length) throw new Error('Every scene needs a voice (or silence)');
  const inputs = [];
  const inputOpts = [];
  const graph = [];
  const labels = [];
  voices.forEach((voice, index) => {
    const samples = timeline.owns[index] * perFrame;
    if (voice && voice.file) {
      inputs.push(voice.file);
      inputOpts.push([]);
      graph.push(`[${inputs.length - 1}:a:0]${stereoOf(voice.channels)},atrim=end_sample=${samples},asetpts=PTS-STARTPTS,apad=whole_len=${samples}[s${index}]`);
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[s${index}]`);
    }
    labels.push(`[s${index}]`);
  });
  graph.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[voice]`);
  const level = music && Number.isFinite(music.level) ? Math.max(0, Math.min(1, music.level)) : 0;
  if (music && music.file && level > 0) {
    const total = timeline.totalFrames * perFrame;
    inputs.push(music.file);
    inputOpts.push(['-stream_loop', '-1']);
    graph.push(`[${inputs.length - 1}:a:0]${stereoOf(music.channels)},atrim=end_sample=${total},asetpts=PTS-STARTPTS,volume=${num(level)}[music]`);
    if (music.duck) {
      // the voice is the side chain: the music gives way while it speaks, and comes back in about a third of a second
      graph.push('[voice]asplit=2[voicea][voiceb]');
      graph.push('[music][voiceb]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350:makeup=1[ducked]');
      graph.push('[voicea][ducked]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[sound]');
    } else {
      graph.push('[voice][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[sound]');
    }
  } else {
    graph.push('[voice]anull[sound]');
  }
  const argv = ['-nostdin', '-v', 'error', '-y'];
  inputs.forEach((file, index) => argv.push(...inputOpts[index], '-i', file));
  argv.push('-filter_complex', graph.join(';'), '-map', '[sound]', '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), outputFile);
  return { argv, graph: graph.join(';'), inputs };
}

// The voices that the soundtrack cuts off: voices[i] = { label, seconds } (null where a shot has no voice of its own) against the frames
// timeline.owns[i] that shot keeps. A scene that is shorter than its voice is cut silently by soundtrackArgs (atrim): this tells it.
// Returns one sentence per voice that loses more than half a frame.
function voiceCuts(voices, timeline) {
  const out = [];
  voices.forEach((voice, index) => {
    if (!voice || !(voice.seconds > 0)) return;
    const kept = timeline.owns[index] / timeline.fps;
    if (voice.seconds - kept > 0.5 / timeline.fps) {
      out.push(`${voice.label}: the voice is ${round3(voice.seconds)} s long, but the scene shows ${round3(kept)} s: the last ${round3(voice.seconds - kept)} s of the narration are cut off (draw the scene again, or check data-duration of its code)`);
    }
  });
  return out;
}

/* ---------- captions and subtitles ---------- */

// The timings of the scenes (lib/explainer-cues.js timingOf) as one timing in the times of the film: `starts` are the seconds at which
// the scenes begin. A scene without words adds none. Returns { version, source, duration, words, lines } with the same shape as every
// timing of the app (so the caption script of lib/captions-ass.js reads it).
function mergeTimings(timings, starts, total) {
  const words = [];
  const lines = [];
  timings.forEach((timing, index) => {
    const offset = Number(starts[index]) || 0;
    const lineBase = lines.length;
    for (const line of Array.isArray(timing?.lines) ? timing.lines : []) {
      lines.push({ text: line.text, start: round3(line.start + offset), end: round3(line.end + offset) });
    }
    for (const word of Array.isArray(timing?.words) ? timing.words : []) {
      words.push({ text: word.text, start: round3(word.start + offset), end: round3(word.end + offset), ...(Number.isInteger(word.line) ? { line: lineBase + word.line } : {}) });
    }
  });
  return { version: 1, source: 'speech', duration: round3(total), words, lines };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

function srtTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${pad(Math.floor(total / 3600000), 2)}:${pad(Math.floor((total % 3600000) / 60000), 2)}:${pad(Math.floor((total % 60000) / 1000), 2)},${pad(total % 1000, 3)}`;
}

// The subtitle file: one entry for every line, from its first word to its last (a little after it, but not into the next line), in the
// times of the film. `total` keeps the last entry inside the film.
function srtOf(lines, total = Infinity) {
  const out = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    let end = line.end + 0.25;
    if (next) end = Math.min(end, Math.max(line.end, next.start - 0.04));
    end = Math.min(end, total);
    if (!(end > line.start)) return;
    out.push(`${out.length + 1}\n${srtTime(line.start)} --> ${srtTime(end)}\n${line.text}\n`);
  });
  return out.join('\n');
}

/* ---------- the length ---------- */

// A sentence for the log when the film is more than 15 % longer or shorter than the length that was asked for; null when it is close.
function lengthNote(actualSeconds, targetSeconds) {
  if (!(targetSeconds > 0) || !(actualSeconds > 0)) return null;
  const deviation = (actualSeconds - targetSeconds) / targetSeconds;
  if (Math.abs(deviation) <= LENGTH_TOLERANCE) return null;
  return `The film is ${Math.round(actualSeconds)} s long, ${Math.round(Math.abs(deviation) * 100)} % ${deviation > 0 ? 'above' : 'below'} the ${Math.round(targetSeconds)} s that were asked for (the voice is slower or faster than the plan counted). Shorten or lengthen the script and run again.`;
}

module.exports = {
  SAMPLE_RATE,
  TRANSITIONS,
  MUSIC_LEVELS,
  MUSIC_LEVEL_NAMES,
  LENGTH_TOLERANCE,
  planTimeline,
  shotsOf,
  soundtrackArgs,
  voiceCuts,
  mergeTimings,
  srtTime,
  srtOf,
  lengthNote
};
