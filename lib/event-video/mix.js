'use strict';

// The sound and the last step of the event video (WP53, node event_video.render, spec §7 "Ton-Mix" and "Schluss-Pass"): pure builders of ffmpeg
// arguments, the node runs them.
//   mixArgs(graphics, files)   the music (the length of the film, faded out over its last 1.5 s), ducked by graphics.mix.duck_db with a ramp of
//                              graphics.mix.ramp s under every soundbite and every line of the voice; the stem of the clips (nat) at mix.nat_level, at
//                              full level under a soundbite; the voice lines at their times. One WAV (48 kHz, stereo, 16 bit), mixed without a change of
//                              level (amix normalize=0). A photo-only event has no stem: the music and the voice alone
//   loudness                   two passes like the explainer video (lib/explainer-edit.js): the mix is measured (loudnessProbeArgs, readLoudness), then
//                              brought to graphics.mix.lufs (gainOf) under the limiter (normalizeArgs)
//   finishArgs({ ... })        the drawn chunks joined (concat demuxer), the grain and the vignette of the look (spec §5c: noise c0s = round(12 grain),
//                              vignette angle PI / (5 + 3 (1 - contrast))), BT.709 with its tags, the sound as AAC: H.264 CRF 17, the size of the format
//   subtitlesSrt(graphics)     the SRT of the soundbites (the lines of view.js, the times of the film)

const contract = require('./contract');
const view = require('./view');
const composition = require('./composition');
const explainerEdit = require('../explainer-edit');
const postLib = require('../music-video-hud/postpass');
const ops = require('../nodes/ffmpeg-ops');

const num = ops.num;
const FPS = contract.FPS;
const SAMPLE_RATE = 48000;
const MUSIC_FADE_OUT = 1.5;
// the stem rises to full level under a soundbite over this ramp
const NAT_RAMP = 0.15;
// below this loudness (LUFS) the stem is taken for silence and left out of the mix
const SILENT_LUFS = -60;
const DEFAULT_MIX = Object.freeze({ duck_db: -12, ramp: 0.3, nat_level: 0.15, lufs: -16 });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function mixOf(graphics) {
  const mix = (graphics && graphics.mix) || {};
  const pick = (key) => (Number.isFinite(mix[key]) ? clamp(mix[key], contract.MIX_RANGES[key][0], contract.MIX_RANGES[key][1]) : DEFAULT_MIX[key]);
  return { duck_db: pick('duck_db'), ramp: pick('ramp'), nat_level: pick('nat_level'), lufs: pick('lufs') };
}

// The windows in which the music is ducked: every soundbite and every line of the voice (its start and its length; `voiceSeconds[index]` is the
// length of voice[index]). Sorted, those that overlap joined.
function duckWindows(graphics, voiceSeconds = []) {
  const windows = [];
  for (const bite of graphics.soundbites || []) windows.push({ start: bite.start, end: bite.end });
  for (const line of graphics.voiceover || []) {
    const seconds = Number(voiceSeconds[line.index]);
    if (Number.isFinite(seconds) && seconds > 0) windows.push({ start: line.start, end: Math.min(graphics.duration, line.start + seconds) });
  }
  windows.sort((a, b) => a.start - b.start);
  const joined = [];
  for (const window of windows) {
    const last = joined[joined.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else joined.push({ ...window });
  }
  return joined;
}

// 0..1, how far the time t is inside the windows: 1 inside, ramps of `ramp` s before and after (the music is down when the soundbite starts)
function insideExpression(windows, ramp) {
  if (!windows.length) return '0';
  const terms = windows.map((w) => `clip(min((t-${num(w.start - ramp)})/${num(ramp)},(${num(w.end + ramp)}-t)/${num(ramp)}),0,1)`);
  return terms.reduce((all, term) => `max(${all},${term})`);
}

// The volume of the music over time: 1, down to duck_db inside the windows (spec §7: -12 dB, 0.3 s ramp)
function musicVolume(windows, { duck_db: duckDb, ramp }) {
  if (!windows.length) return '1';
  const low = 10 ** (duckDb / 20);
  return `1-${num(1 - low)}*${insideExpression(windows, ramp)}`;
}

// The volume of the stem: nat_level under the B-roll, 1 under a soundbite
function natVolume(graphics, natLevel) {
  const bites = (graphics.soundbites || []).map((bite) => ({ start: bite.start + NAT_RAMP, end: bite.end - NAT_RAMP })).filter((w) => w.end > w.start);
  if (!bites.length) return num(natLevel);
  return `${num(natLevel)}+${num(1 - natLevel)}*${insideExpression(bites, NAT_RAMP)}`;
}

const toStereo = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

// The mix. files: { music, nat (or null: no stem), voices: [{ file, seconds }] by the index of graphics.voiceover, out }. Returns { args, windows }.
function mixArgs(graphics, files) {
  const duration = graphics.duration;
  const mix = mixOf(graphics);
  const voices = Array.isArray(files.voices) ? files.voices : [];
  const windows = duckWindows(graphics, voices.map((voice) => voice && voice.seconds));
  const args = ['-nostdin', '-v', 'error', '-y', '-i', files.music];
  const lines = [];
  const labels = [];
  const fadeAt = Math.max(0, duration - MUSIC_FADE_OUT);
  lines.push(
    `[0:a]${toStereo},atrim=0:${num(duration)},asetpts=PTS-STARTPTS,apad=whole_dur=${num(duration)},` +
      `volume='${musicVolume(windows, mix)}':eval=frame,afade=t=out:st=${num(fadeAt)}:d=${num(duration - fadeAt)}[m]`
  );
  labels.push('[m]');
  let input = 1;
  if (files.nat) {
    args.push('-i', files.nat);
    lines.push(`[${input}:a]${toStereo},atrim=0:${num(duration)},asetpts=PTS-STARTPTS,volume='${natVolume(graphics, mix.nat_level)}':eval=frame[n]`);
    labels.push('[n]');
    input += 1;
  }
  for (const line of graphics.voiceover || []) {
    const voice = voices[line.index];
    if (!voice || !voice.file) continue;
    args.push('-i', voice.file);
    const delay = Math.round(line.start * 1000);
    lines.push(`[${input}:a]${toStereo},asetpts=PTS-STARTPTS,adelay=delays=${delay}:all=1[v${line.index}]`);
    labels.push(`[v${line.index}]`);
    input += 1;
  }
  const mixed = labels.length === 1 ? `${labels[0]}anull` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0`;
  lines.push(`${mixed},atrim=0:${num(duration)},apad=whole_dur=${num(duration)}[mix]`);
  args.push('-filter_complex', lines.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2', files.out);
  return { args, windows };
}

// The gain in dB that brings a measured loudness to the target of the plan (graphics.mix.lufs), within the bounds of the explainer video; null where
// nothing was measured.
function gainOf(measured, lufs = DEFAULT_MIX.lufs) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return null;
  return Math.round(clamp(lufs - measured, explainerEdit.GAIN_MIN_DB, explainerEdit.GAIN_MAX_DB) * 10) / 10 + 0;
}

// Is the stem silent (a measured loudness of null or below SILENT_LUFS)?
const isSilent = (measured) => typeof measured !== 'number' || !Number.isFinite(measured) || measured < SILENT_LUFS;

// The last step: the chunks (listFile, concat demuxer) and the mixed sound into the film. `look`: graphics.look (grain, contrast); `inputColor`: the
// colour tags of the chunks (postpass.inputColour). Returns { args, filter, frames, seconds }.
function finishArgs({ listFile, audioFile, outFile, format, graphics, inputColor }) {
  const { width, height } = contract.FORMAT_SIZES[format];
  const look = graphics.look || {};
  const frames = graphics.endFrame;
  const seconds = frames / FPS;
  const colour = postLib.inputColour(inputColor);
  const grain = Math.round(12 * clamp(Number(look.grain) || 0, 0, 1));
  const contrast = clamp(Number(look.contrast) || 0, 0, 1);
  const parts = [`fps=${FPS}`, `scale=${width}:${height}:flags=bicubic`, 'setsar=1', 'setpts=PTS-STARTPTS', 'format=yuv420p'];
  if (grain > 0) parts.push(`noise=c0s=${grain}:c0f=t+u:c0_seed=17`);
  parts.push(`vignette=angle=PI/${num(5 + 3 * (1 - contrast))}:eval=init`);
  parts.push(`scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_color_matrix=bt709:out_range=tv`);
  parts.push('format=yuv420p', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
  const filter = `[0:v]${parts.join(',')}[v];[1:a]${toStereo},apad=whole_dur=${num(seconds)}[a]`;
  const args = [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-i', audioFile,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(FPS), '-g', '48',
    '-c:a', 'aac', '-b:a', '256k', '-ar', String(SAMPLE_RATE), '-ac', '2',
    '-frames:v', String(frames), '-t', num(seconds),
    '-movflags', '+faststart',
    outFile
  ];
  return { args, filter, frames, seconds };
}

// The subtitles of the soundbites as SRT (the lines the pages show, in the times of the film); '' without a soundbite.
function subtitlesSrt(graphics, format = '16:9') {
  const type = composition.TYPE[format] || composition.TYPE['16:9'];
  const lines = (graphics.soundbites || []).flatMap((bite) => view.subtitleLines(bite, type.subChars));
  return explainerEdit.srtOf(lines, graphics.duration);
}

module.exports = {
  SAMPLE_RATE,
  MUSIC_FADE_OUT,
  SILENT_LUFS,
  DEFAULT_MIX,
  mixOf,
  duckWindows,
  insideExpression,
  musicVolume,
  natVolume,
  mixArgs,
  gainOf,
  isSilent,
  finishArgs,
  subtitlesSrt,
  loudnessProbeArgs: explainerEdit.loudnessProbeArgs,
  readLoudness: explainerEdit.readLoudness,
  normalizeArgs: explainerEdit.normalizeArgs
};
