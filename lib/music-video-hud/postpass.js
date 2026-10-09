'use strict';

// The last step of the music video with the HUD (WP44), on this machine with ffmpeg: the rendered chunks are joined, the glitch is put on the
// cuts that ask for it and on the strong hits, the grain and a light vignette go over everything, the colour is tagged BT.709, the song goes
// underneath (padded with silence for the end card) and the film is encoded (H.264 CRF 17, yuv420p, +faststart). This module makes the arguments
// of ffmpeg and reads what came out; it runs nothing itself (the node does), so it is tested without ffmpeg.
// The style of the graphics (`graphics.theme`, themes.js) decides what is done to the film itself: HUD Blue shifts the colour channels and displaces
// strips; Kuble has a prism instead (a blue and an amber ghost of the picture and a few faceted shards that are displaced), a lighter grain, a
// stronger vignette and a light bloom on the highlights. Everything that lies over the film (pulse, sweep, sparks, type) is drawn in the page.
//
//   glitchWindows(graphics, { glitch })      the moments of the glitch on the time line of the film: [{ start, end, strength }] in seconds
//   buildPostArgs({ ... })                   { args, filter, windows }: the whole command
//   verifyOutput(probe, expected)            the problems of a finished film (colour tags, size, frame rate, length, sound): [] when it is right
//   contactSheetArgs({ ... })                the arguments for the sheet of 12 frames (4 x 3)
//   concatListText(files)                    the list file of the concat demuxer
//   cutClipArgs({ ... })                     the base film cut to the frames of one chunk (the footage of a render job)
//   lumaArgs / lumaPerCut                    how bright the left and the right half of every cut are (the HUD changes its ink on bright footage)
// Times of the film start at 0 where the first cut of the graphics starts (the song time of the first cut is graphics.start).

const themes = require('./themes');

const FPS = 24;
const GLITCH_FRAMES = { min: 3, max: 5 };
const MAX_WINDOWS = 400;
const SHEET = { columns: 4, rows: 3, width: 640, padding: 4 };

const frame = (seconds) => Math.round(seconds * FPS);
const round4 = (value) => Math.round(value * 10000) / 10000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// The glitch (RGB shift and a displaced strip of the picture for 3 to 5 frames) sits on the cut that has `transition: glitch` and on every hit
// with a strength of 0.8 or more (the stronger, the longer). Windows that touch are one window. Nothing at all when the strength of the node is 0.
function glitchWindows(graphics, { glitch = 0.6 } = {}) {
  const strength = clamp(num(glitch, 0.6), 0, 1);
  if (strength <= 0) return [];
  const origin = num(graphics.start, 0);
  const film = graphics.endFrame / FPS - origin;
  const found = [];
  const add = (songTime, frames, power) => {
    const first = frame(songTime - origin);
    if (first < 0 || first >= frame(film)) return;
    found.push({ first, last: Math.min(frame(film), first + frames), power });
  };
  (graphics.cuts || []).forEach((cut, index) => {
    if (index > 0 && cut.transition === 'glitch') add(cut.start, 4, 1);
  });
  for (const hit of (graphics.music && graphics.music.hits) || []) {
    const power = num(hit.strength, 0);
    if (power >= 0.8) add(hit.t, GLITCH_FRAMES.min + Math.round(((power - 0.8) / 0.2) * (GLITCH_FRAMES.max - GLITCH_FRAMES.min)), power);
  }
  found.sort((a, b) => a.first - b.first || b.last - a.last);
  const merged = [];
  for (const item of found) {
    const last = merged[merged.length - 1];
    if (last && item.first <= last.last) {
      last.last = Math.max(last.last, item.last);
      last.power = Math.max(last.power, item.power);
    } else merged.push({ ...item });
  }
  return merged.slice(0, MAX_WINDOWS).map((item) => ({ start: item.first / FPS, end: item.last / FPS, strength: round4(strength * item.power) }));
}

// The three kinds of glitch, taken in turn by the windows: the shift of the colour channels and the strip of the picture that is displaced.
// `shift` is the pixel shift of the colour planes, `offset` the displacement of the strip.
function glitchKinds(strength) {
  const shift = Math.round(6 + 26 * clamp(strength, 0, 1));
  const offset = Math.round(40 + 90 * clamp(strength, 0, 1));
  return [
    { rgba: `rh=${-shift}:bh=${shift}`, strip: { y: 216, height: 72, x: offset } },
    { rgba: `rv=${Math.round(shift / 3)}:bv=${-Math.round(shift / 3)}:gh=${-Math.round(shift / 2)}`, strip: { y: 540, height: 108, x: -offset } },
    { rgba: `rh=${shift}:bh=${-shift}:gv=${Math.round(shift / 4)}`, strip: { y: 792, height: 54, x: Math.round(offset * 0.6) } }
  ];
}

// "gte(t,a)*lt(t,b)+..." the moments of the windows
function enableExpression(windows) {
  return windows.map((window) => `gte(t,${round4(window.start)})*lt(t,${round4(window.end)})`).join('+');
}

// The colour of what the render nodes return: HyperFrames draws BT.709 and tags it (limited range), so a chunk is normally left as it is. A chunk without
// tags is taken for BT.709 as well (the matrix that swscale would guess for an untagged picture is BT.601, which would shift every colour); one with other
// tags is converted from what it says. `tags` are the fields color_space and color_range of ffprobe.
const MATRIX_NAMES = Object.freeze({ bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470', fcc: 'fcc', smpte240m: 'smpte240m', bt2020nc: 'bt2020', bt2020c: 'bt2020' });
function inputColour(tags) {
  const space = MATRIX_NAMES[String((tags && (tags.space || tags.color_space)) || '')] || 'bt709';
  const range = (tags && (tags.range || tags.color_range)) === 'pc' ? 'pc' : 'tv';
  return { matrix: space, range };
}

// The prism glitch of Kuble: the windows are the same as for the RGB glitch, the look is another. On a small canvas (a quarter of the picture) the
// picture is tinted blue and shifted one way and tinted amber and shifted the other way: the two ghosts are added and, in a window, laid over the
// picture. Faceted shards (slanted strips that a mask cuts out of the picture) are displaced sideways at the same moments. `shard` says where on a
// canvas of 480 x 270 the strips of a kind lie: [slope, from, to, x0, x1] is the area where from <= y - slope * x <= to, between x0 and x1.
const SMALL = Object.freeze({ width: 480, height: 270 });
const SHARDS = Object.freeze([
  [[0.12, 40, 56, 40, 420], [-0.22, 176, 186, 90, 470]],
  [[-0.16, 120, 138, 20, 440], [0.3, 8, 20, 120, 400], [0.05, 222, 230, 0, 330]],
  [[0.18, 24, 34, 60, 470], [-0.12, 90, 110, 0, 380], [0.26, 100, 108, 150, 460], [-0.3, 250, 262, 30, 300]]
]);

// The mask of a kind of shards as a source of ffmpeg: white where a shard is, a single frame that is repeated.
function shardMask(facets) {
  const term = ([slope, from, to, x0, x1]) => `between(Y${slope >= 0 ? '-' : '+'}${Math.abs(slope)}*X,${from},${to})*between(X,${x0},${x1})`;
  return `color=c=black:s=${SMALL.width}x${SMALL.height}:r=${FPS},format=gray,geq=lum='255*gt(${facets.map(term).join('+')},0)',scale=1920:1080:flags=bilinear,format=gbrp,loop=loop=-1:size=1:start=0`;
}

// The tint of a ghost: the luma of the picture times the colour (r, g, b from 0 to 1), scaled by `gain`
function tintMixer([r, g, b], gain) {
  const luma = [0.2126, 0.7152, 0.0722];
  const rows = [r, g, b].map((channel, index) => luma.map((weight, column) => `${'rgb'[index]}${'rgb'[column]}=${round4(weight * channel * gain)}`));
  return `colorchannelmixer=${rows.flat().join(':')}`;
}

const hexToUnit = (hex) => themes.rgb(hex).split(',').map((part) => round4(Number(part) / 255));

// The filter graph of the video of Kuble. `colour`: the matrix and range of the chunks (inputColour): the picture goes to planar RGB and back with
// them, so that the conversions cancel out.
function kubleVideoFilter({ windows, grain, input, theme }) {
  const parts = [];
  const colour = inputColour(input);
  parts.push(`[0:v]fps=${FPS},scale=1920:1080:flags=bicubic,setsar=1,setpts=PTS-STARTPTS[vin]`);
  parts.push(`[vin]scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_range=pc,format=gbrp[rgb]`);
  const strength = windows.length ? Math.max(...windows.map((window) => window.strength)) : 0;
  const bloom = theme.post.bloom;
  const colors = theme.colors;
  const all = windows.length ? enableExpression(windows) : '';
  // the picture is used up to three times: the picture, the shards, the small canvas for the ghosts and the bloom
  const kinds = SHARDS.map((facets, index) => ({ facets, index, mine: windows.filter((_window, at) => at % SHARDS.length === index) })).filter((kind) => kind.mine.length);
  let label = 'rgb';
  if (kinds.length) {
    const offset = Math.round(50 + 110 * clamp(strength, 0, 1));
    parts.push(`[rgb]split=3[k0][k1][k2]`);
    parts.push(`[k1]scroll=hpos=${round4(offset / 1920)},split=${kinds.length}[${kinds.map((kind) => `ks${kind.index}`).join('][')}]`);
    label = 'k0';
    kinds.forEach((kind) => {
      parts.push(`${shardMask(kind.facets)}[km${kind.index}]`);
      parts.push(`[${label}][ks${kind.index}][km${kind.index}]maskedmerge=enable='${enableExpression(kind.mine)}'[m${kind.index}]`);
      label = `m${kind.index}`;
    });
    // the small canvas comes from the picture after the shards
    parts.push(`[k2]scale=${SMALL.width}:${SMALL.height}:flags=area,split=3[sb][sg1][sg2]`);
  } else {
    parts.push(`[rgb]split=2[k0][k2]`);
    parts.push(`[k2]scale=${SMALL.width}:${SMALL.height}:flags=area,split=3[sb][sg1][sg2]`);
    label = 'k0';
  }
  // the bloom: the highlights of the small canvas, blurred
  const gain = round4(4 * bloom.opacity);
  const lift = `clip((val-${bloom.threshold})*${gain},0,255)`;
  parts.push(`[sb]lutrgb=r='${lift}':g='${lift}':b='${lift}',gblur=sigma=${bloom.sigma}[bloom]`);
  let small = 'bloom';
  if (kinds.length) {
    // the ghosts: the blue copy of the picture shifted to the left and the amber one to the right, each minus the copy that is not shifted, so that
    // only the edges are left (a fringe of blue on one side and of amber on the other, like a prism); the shift grows with the strength of the glitch
    const shift = Math.max(2, Math.round((8 + 26 * clamp(strength, 0, 1)) / 4));
    parts.push(`[sg1]${tintMixer(hexToUnit(colors.blue), 1.3)},split=2[b0][b1]`);
    parts.push(`[b0]pad=iw+${shift}:ih:0:0:color=black,crop=iw-${shift}:ih:${shift}:0[b2]`);
    parts.push(`[b2][b1]blend=all_mode=subtract[gb]`);
    parts.push(`[sg2]${tintMixer(hexToUnit(colors.amber), 1.1)},split=2[a0][a1]`);
    parts.push(`[a0]pad=iw+${shift}:ih:${shift}:0:color=black,crop=iw-${shift}:ih:0:0[a2]`);
    parts.push(`[a2][a1]blend=all_mode=subtract[ga]`);
    parts.push(`[gb][ga]blend=all_mode=addition[gsum]`);
    parts.push(`[bloom][gsum]blend=all_mode=addition:enable='${all}'[fxs]`);
    small = 'fxs';
  } else {
    parts.push('[sg1]nullsink');
    parts.push('[sg2]nullsink');
  }
  parts.push(`[${small}]scale=1920:1080:flags=bilinear[fx]`);
  parts.push(`[${label}][fx]blend=all_mode=screen[lit]`);
  const tail = [`scale=in_range=pc:out_color_matrix=${colour.matrix}:out_range=${colour.range}`, 'format=yuv420p'];
  const noise = Math.round(clamp(num(grain, 0.35), 0, 1) * 12 * theme.post.grain);
  if (noise > 0) tail.push(`noise=c0s=${noise}:c0f=t+u:c0_seed=17`);
  tail.push(`vignette=angle=${theme.post.vignette}:eval=init`);
  tail.push(`scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_color_matrix=bt709:out_range=tv`);
  tail.push('format=yuv420p', 'setsar=1', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
  parts.push(`[lit]${tail.join(',')}[v]`);
  return parts.join(';');
}

// The filter graph of the video. `windows`: from glitchWindows. grain 0 to 1 (luma noise that changes with every frame), the vignette is light.
// `theme`: the table of the style (themes.js); the first style is the default.
function videoFilter({ windows, grain, input, theme = themes.get(themes.DEFAULT) }) {
  if (theme.post.glitch === 'prism') return kubleVideoFilter({ windows, grain, input, theme });
  const parts = [];
  // whatever the render nodes returned is brought to 1920x1080 at 24 fps (both are no-ops for a chunk that is already right)
  parts.push(`[0:v]fps=${FPS},scale=1920:1080:flags=bicubic,setsar=1,setpts=PTS-STARTPTS[vin]`);
  let label = 'vin';
  const strength = windows.length ? Math.max(...windows.map((window) => window.strength)) : 0;
  const kinds = glitchKinds(strength);
  kinds.forEach((kind, index) => {
    const mine = windows.filter((_window, at) => at % kinds.length === index);
    if (!mine.length) return;
    const enable = enableExpression(mine);
    const base = `g${index}a`;
    const source = `g${index}b`;
    const strip = `g${index}s`;
    const shifted = `g${index}c`;
    const next = `g${index}`;
    parts.push(`[${label}]split=2[${base}][${source}]`);
    parts.push(`[${source}]crop=iw:${kind.strip.height}:0:${kind.strip.y}[${strip}]`);
    parts.push(`[${base}]rgbashift=${kind.rgba}:enable='${enable}'[${shifted}]`);
    parts.push(`[${shifted}][${strip}]overlay=x=${kind.strip.x}:y=${kind.strip.y}:enable='${enable}'[${next}]`);
    label = next;
  });
  const tail = ['format=yuv420p'];
  // temporal luma noise: 4 at the default of 0.35 (a fine grain, about 9 Mbit/s at CRF 17), 12 at 1; stronger noise cannot be compressed
  const noise = Math.round(clamp(num(grain, 0.35), 0, 1) * 12);
  if (noise > 0) tail.push(`noise=c0s=${noise}:c0f=t+u:c0_seed=17`);
  tail.push('vignette=angle=PI/7:eval=init');
  // the conversion to BT.709 / limited range from what the chunks say they are, and then the tags on every frame (the encoder takes the
  // primaries and the transfer from the frames, the options of the command alone leave them "unknown")
  const colour = inputColour(input);
  tail.push(`scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_color_matrix=bt709:out_range=tv`);
  tail.push('format=yuv420p', 'setsar=1', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
  parts.push(`[${label}]${tail.join(',')}[v]`);
  return parts.join(';');
}

// The audio: the song from `audioStart` for the length of the film, then silence up to the end of the end card.
function audioFilter({ audioStart, filmSeconds, totalSeconds }) {
  return `[1:a]atrim=start=${round4(audioStart)}:end=${round4(audioStart + filmSeconds)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${round4(totalSeconds)}[a]`;
}

// The command. listFile: the list of the chunks (concat demuxer, see concatListText); songFile: the song; graphics: the resolved data; params:
// { grain, glitch }; endcardSeconds: 0 without an end card; inputColor: the tags of the chunks (see inputColour). The film is graphics.endFrame - first frame
// long, the end card follows.
function buildPostArgs({ listFile, songFile, outFile, graphics, params = {}, endcardSeconds = 0, inputColor }) {
  const origin = num(graphics.start, 0);
  const filmFrames = graphics.endFrame - frame(origin);
  const endcardFrames = Math.max(0, frame(endcardSeconds));
  const totalFrames = filmFrames + endcardFrames;
  const filmSeconds = filmFrames / FPS;
  const totalSeconds = totalFrames / FPS;
  const windows = glitchWindows(graphics, { glitch: params.glitch });
  const filter = `${videoFilter({ windows, grain: params.grain, input: inputColor, theme: themes.get(graphics.theme) })};${audioFilter({ audioStart: origin, filmSeconds, totalSeconds })}`;
  const args = [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-i', songFile,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(FPS), '-g', '48',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
    '-frames:v', String(totalFrames), '-t', String(round4(totalSeconds)),
    '-movflags', '+faststart',
    outFile
  ];
  return { args, filter, windows, frames: totalFrames, seconds: totalSeconds };
}

// The list file of the concat demuxer: one `file` line per chunk, a quote in a path is written the way the demuxer reads it.
function concatListText(files) {
  return files.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

// What is wrong with the finished film. `probe` is the JSON of `ffprobe -show_streams -show_format`; `expected`: { frames, seconds, width, height }.
function verifyOutput(probe, expected = {}) {
  const problems = [];
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) return ['no video stream'];
  const width = expected.width || 1920;
  const height = expected.height || 1080;
  if (video.codec_name !== 'h264') problems.push(`video codec ${video.codec_name}, not h264`);
  if (video.pix_fmt !== 'yuv420p') problems.push(`pixel format ${video.pix_fmt}, not yuv420p`);
  if (Number(video.width) !== width || Number(video.height) !== height) problems.push(`size ${video.width}x${video.height}, not ${width}x${height}`);
  if (video.r_frame_rate !== `${FPS}/1`) problems.push(`frame rate ${video.r_frame_rate}, not ${FPS}/1`);
  for (const [field, value] of [['color_space', 'bt709'], ['color_primaries', 'bt709'], ['color_transfer', 'bt709'], ['color_range', 'tv']]) {
    if (video[field] !== value) problems.push(`${field} is ${video[field] || 'not set'}, not ${value}`);
  }
  if (!audio) problems.push('no audio stream');
  else if (audio.codec_name !== 'aac') problems.push(`audio codec ${audio.codec_name}, not aac`);
  const seconds = Number(probe.format && probe.format.duration);
  if (Number.isFinite(expected.seconds) && !(Math.abs(seconds - expected.seconds) <= 1 / FPS + 0.06)) problems.push(`length ${Number.isFinite(seconds) ? seconds.toFixed(3) : '?'} s, not ${expected.seconds.toFixed(3)} s`);
  const frames = Number(video.nb_frames);
  if (Number.isFinite(expected.frames) && Number.isFinite(frames) && Math.abs(frames - expected.frames) > 1) problems.push(`${frames} frames, not ${expected.frames}`);
  return problems;
}

// The contact sheet: 12 frames spread over the film, 4 across and 3 down, as one PNG.
function contactSheetArgs({ inputFile, outFile, frames }) {
  const count = SHEET.columns * SHEET.rows;
  const total = Math.max(1, Math.floor(frames));
  const picks = [];
  for (let i = 0; i < count; i += 1) picks.push(Math.min(total - 1, Math.round(((i + 0.5) * total) / count)));
  const select = [...new Set(picks)].map((index) => `eq(n,${index})`).join('+');
  const filter = `select='${select}',scale=${SHEET.width}:-2:flags=lanczos,tile=${SHEET.columns}x${SHEET.rows}:padding=${SHEET.padding}:color=black`;
  return { args: ['-nostdin', '-v', 'error', '-y', '-i', inputFile, '-vf', filter, '-fps_mode', 'passthrough', '-frames:v', '1', outFile], picks };
}

// The base film cut to one chunk: exactly `frames` frames from `start` (seconds on the time line of the base film), 1920x1080, 24 fps, no sound,
// CRF 16. A film that ends early holds its last frame (tpad), so the chunk always has all its frames.
function cutClipArgs({ inputFile, outFile, start, frames }) {
  const filter = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=' + FPS + ',tpad=stop_mode=clone:stop_duration=5,format=yuv420p';
  return [
    '-nostdin', '-v', 'error', '-y',
    '-ss', String(round4(Math.max(0, start))), '-i', inputFile,
    '-an', '-vf', filter, '-frames:v', String(Math.max(1, Math.round(frames))),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    outFile
  ];
}

// The brightness of the picture: 4 samples a second, each a pair of bytes (the mean of the left half and of the right half of the frame, 0 to 255).
const LUMA_RATE = 4;
function lumaArgs({ inputFile, outFile }) {
  return ['-nostdin', '-v', 'error', '-y', '-i', inputFile, '-an', '-vf', `fps=${LUMA_RATE},scale=2:1:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', outFile];
}

// [left, right] (0 to 1, three decimals) for every cut: the mean of the samples inside the cut (without its first and last tenth of a second, where the
// picture is still or already the next one); a cut too short for that takes the sample nearest to its middle. `origin` is the song time of the first frame.
function lumaPerCut(buffer, cuts, origin = 0) {
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return cuts.map(() => null);
  const at = (index) => [buffer[index * 2] / 255, buffer[index * 2 + 1] / 255];
  return cuts.map((cut) => {
    const from = cut.start - origin + 0.1;
    const to = cut.end - origin - 0.1;
    const first = Math.ceil(from * LUMA_RATE - 0.5);
    const last = Math.floor(to * LUMA_RATE - 0.5);
    let sum = [0, 0];
    let count = 0;
    for (let index = Math.max(0, first); index <= Math.min(samples - 1, last); index += 1) {
      const pair = at(index);
      sum = [sum[0] + pair[0], sum[1] + pair[1]];
      count += 1;
    }
    if (!count) {
      const middle = clamp(Math.round(((cut.start + cut.end) / 2 - origin) * LUMA_RATE - 0.5), 0, samples - 1);
      const pair = at(middle);
      return [Math.round(pair[0] * 1000) / 1000, Math.round(pair[1] * 1000) / 1000];
    }
    return [Math.round((sum[0] / count) * 1000) / 1000, Math.round((sum[1] / count) * 1000) / 1000];
  });
}

module.exports = {
  LUMA_RATE,
  cutClipArgs,
  lumaArgs,
  lumaPerCut,
  FPS,
  MAX_WINDOWS,
  SHEET,
  glitchWindows,
  glitchKinds,
  shardMask,
  SHARDS,
  enableExpression,
  inputColour,
  videoFilter,
  audioFilter,
  buildPostArgs,
  concatListText,
  verifyOutput,
  contactSheetArgs
};
