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
// The beat effects (WP45, params.effects `subtle` or `strong`, effects.js) bring more windows and five kinds of glitch over the whole picture: the colour
// channels, displaced blocks, a torn line, a VHS track and a short digital noise (in Kuble: the prism, the shards, a tear with a blue seam, a blue VHS
// track and a noise in night blue), each window at most 4 frames (fxGlitchWindows, fxVideoFilter). With the effects off (the default of this module) the
// command is the one of before, byte for byte. The slider `glitch` keeps its meaning with the effects on: how hard the glitch hits (0 is none at all).

const themes = require('./themes');
const effectsLib = require('./effects');

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

// The same mask for exactly `frames` frames (for a piece of the film: maskedmerge only ends with its last input)
function shardMaskFrames(facets, frames) {
  const term = ([slope, from, to, x0, x1]) => `between(Y${slope >= 0 ? '-' : '+'}${Math.abs(slope)}*X,${from},${to})*between(X,${x0},${x1})`;
  return `color=c=black:s=${SMALL.width}x${SMALL.height}:r=${FPS},trim=end_frame=1,format=gray,geq=lum='255*gt(${facets.map(term).join('+')},0)',scale=1920:1080:flags=bilinear,format=gbrp,loop=loop=${Math.max(0, frames - 1)}:size=1:start=0`;
}

// The tint of a ghost: the luma of the picture times the colour (r, g, b from 0 to 1), scaled by `gain`
function tintMixer([r, g, b], gain) {
  const luma = [0.2126, 0.7152, 0.0722];
  const rows = [r, g, b].map((channel, index) => luma.map((weight, column) => `${'rgb'[index]}${'rgb'[column]}=${round4(weight * channel * gain)}`));
  return `colorchannelmixer=${rows.flat().join(':')}`;
}

const hexToUnit = (hex) => themes.rgb(hex).split(',').map((part) => round4(Number(part) / 255));

// The filter graph of the video of Kuble. `colour`: the matrix and range of the chunks (inputColour): the picture goes to planar RGB and back with
// them, so that the conversions cancel out. The ghosts and the shards share the windows of the glitch (the shards take them in turn).
function kubleVideoFilter({ windows, grain, input, theme }) {
  const strength = windows.length ? Math.max(...windows.map((window) => window.strength)) : 0;
  return kubleGraph({ grain, input, theme, strength, ghosts: windows, shards: SHARDS.map((_facets, index) => windows.filter((_window, at) => at % SHARDS.length === index)) });
}

// The graph of Kuble: `ghosts` are the windows of the blue and amber ghosts, `shards[i]` the windows of the shards of the kind i, `strength` (0 to 1)
// how far they move; `extra(parts, label)` may add filters to the lit picture (in planar RGB) and returns the label of its result.
function kubleGraph({ grain, input, theme, strength, ghosts, shards, extra }) {
  const parts = [];
  const colour = inputColour(input);
  parts.push(`[0:v]fps=${FPS},scale=1920:1080:flags=bicubic,setsar=1,setpts=PTS-STARTPTS[vin]`);
  parts.push(`[vin]scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_range=pc,format=gbrp[rgb]`);
  const bloom = theme.post.bloom;
  const colors = theme.colors;
  const all = ghosts.length ? enableExpression(ghosts) : '';
  // the picture is used up to three times: the picture, the shards, the small canvas for the ghosts and the bloom
  const kinds = SHARDS.map((facets, index) => ({ facets, index, mine: shards[index] || [] })).filter((kind) => kind.mine.length);
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
  if (ghosts.length) {
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
  const lit = extra ? extra(parts, 'lit') : 'lit';
  const tail = [`scale=in_range=pc:out_color_matrix=${colour.matrix}:out_range=${colour.range}`, 'format=yuv420p'];
  const noise = Math.round(clamp(num(grain, 0.35), 0, 1) * 12 * theme.post.grain);
  if (noise > 0) tail.push(`noise=c0s=${noise}:c0f=t+u:c0_seed=17`);
  tail.push(`vignette=angle=${theme.post.vignette}:eval=init`);
  tail.push(`scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}:out_color_matrix=bt709:out_range=tv`);
  tail.push('format=yuv420p', 'setsar=1', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
  parts.push(`[${lit}]${tail.join(',')}[v]`);
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
  parts.push(`[${label}]${hudTail(grain, input)}[v]`);
  return parts.join(';');
}

// The end of the graph of HUD Blue: grain, vignette, BT.709 and its tags.
function hudTail(grain, input) {
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
  return tail.join(',');
}

/* ---------- the glitch of the beat effects (WP45) ---------- */

// at most this many windows of the glitch of the effects in a film (a song of 6 minutes has about 70 at `strong`)
const FX_MAX_WINDOWS = 160;

// The windows of the glitch of the effects on the time line of the film: plan.glitch (effects.js) for the level, [{ frame, frames, start, end, kind,
// variant, strength }]: the first frame of the window (0 is the first frame of the film), how many frames, and the same in seconds (start and end lie
// half a frame before the first frame and before the frame after the window). `glitch` (the slider of the node, 0 to 1) scales the strength; 0 is no
// glitch at all. The windows are at most 4 frames long and never touch.
function fxGlitchWindows(graphics, { glitch = 0.6, level = effectsLib.DEFAULT_LEVEL, plan } = {}) {
  const strength = clamp(num(glitch, 0.6), 0, 1);
  if (strength <= 0) return [];
  const made = plan || effectsLib.planEffects(graphics, { level });
  if (!made) return [];
  const first = frame(num(graphics.start, 0));
  const last = graphics.endFrame;
  return made.glitch
    .filter((item) => item.f >= first && item.f + item.n <= last)
    .slice(0, FX_MAX_WINDOWS)
    .map((item) => ({
      frame: item.f - first,
      frames: item.n,
      start: (item.f - first - 0.5) / FPS,
      end: (item.f - first + item.n - 0.5) / FPS,
      kind: item.kind,
      variant: item.variant,
      strength: round4(strength * item.s)
    }));
}

// The layouts of the kinds of glitch (px of 1920 x 1080); the variants of a kind take the windows in turn. blocks: [x, y, w, h, dx] (a block of the
// picture moved sideways by dx; the middle one is a negative); tear: [y, h, dx] (a band from y, h high, moved sideways, a bright seam on top of the
// first); vhs: [h, y0, speed] (a band h high that rolls down from y0 at `speed` px a second, noisy, brighter, its colours split and moved sideways);
// noise: [y, h] (the picture full of noise and a band of coarse blocks). The moves grow with the strength.
const FX_LAYOUTS = Object.freeze({
  blocks: [
    [[180, 140, 640, 120, 110], [1060, 420, 600, 96, -150], [360, 760, 980, 64, 80]],
    [[0, 300, 1920, 44, -90], [820, 520, 760, 150, 130], [140, 860, 520, 110, -70]],
    [[1180, 160, 560, 210, -120], [260, 470, 820, 70, 140], [700, 690, 900, 120, -100]]
  ],
  tear: [[[560, 520, 70]], [[300, 180, -110], [480, 90, 60]]],
  vhs: [[110, 140, 760], [150, 520, 980]],
  noise: [[440, 200]]
});

const grow = (px, strength) => Math.round(px * (0.55 + 0.6 * clamp(strength, 0, 1)));
const variantOf = (window, count) => window.variant % count;

// The filters of one window of HUD Blue, from the label `from` to the label `to` (frames of the window only, so nothing is switched on and off).
function hudWindowFilters(parts, from, to, window, id) {
  const s = window.strength;
  const x = `x${id}`;
  if (window.kind === 'rgb') {
    const kind = glitchKinds(s)[variantOf(window, 3)];
    parts.push(`[${from}]split=2[${x}a][${x}b]`);
    parts.push(`[${x}b]crop=iw:${kind.strip.height}:0:${kind.strip.y}[${x}s]`);
    parts.push(`[${x}a]rgbashift=${kind.rgba}[${x}c]`);
    parts.push(`[${x}c][${x}s]overlay=x=${kind.strip.x}:y=${kind.strip.y},format=yuv420p[${to}]`);
    return;
  }
  if (window.kind === 'blocks') {
    const blocks = FX_LAYOUTS.blocks[variantOf(window, FX_LAYOUTS.blocks.length)];
    parts.push(`[${from}]split=${blocks.length + 1}[${x}a]${blocks.map((_block, i) => `[${x}b${i}]`).join('')}`);
    let at = `${x}a`;
    blocks.forEach(([bx, by, bw, bh, dx], i) => {
      parts.push(`[${x}b${i}]crop=${bw}:${bh}:${bx}:${by}${i === 1 ? ',negate' : ''}[${x}k${i}]`);
      const next = i === blocks.length - 1 ? to : `${x}o${i}`;
      parts.push(`[${at}][${x}k${i}]overlay=x=${bx + grow(dx, s)}:y=${by}${next === to ? ',format=yuv420p' : ''}[${next}]`);
      at = next;
    });
    return;
  }
  if (window.kind === 'tear') {
    tearFilters(parts, from, to, window, x, 'white@0.85', 'yuv420p');
    return;
  }
  if (window.kind === 'vhs') {
    vhsFilters(parts, from, to, window, x, `noise=alls=${grow(60, s)}:allf=t,eq=brightness=0.12:saturation=1.7`, 'yuv420p');
    return;
  }
  noiseFilters(parts, from, to, window, x, `c0s=${grow(72, s)}:c1s=30:c2s=30`, 'yuv420p');
}

// a torn picture: bands moved sideways and a seam of `seam` on the first one
function tearFilters(parts, from, to, window, x, seam, format) {
  const bands = FX_LAYOUTS.tear[variantOf(window, FX_LAYOUTS.tear.length)];
  parts.push(`[${from}]split=${bands.length + 1}[${x}a]${bands.map((_band, i) => `[${x}b${i}]`).join('')}`);
  let at = `${x}a`;
  bands.forEach(([by, bh, dx], i) => {
    parts.push(`[${x}b${i}]crop=1920:${bh}:0:${by}[${x}t${i}]`);
    parts.push(`[${at}][${x}t${i}]overlay=x=${grow(dx, window.strength)}:y=${by}[${x}o${i}]`);
    at = `${x}o${i}`;
  });
  parts.push(`[${at}]drawbox=x=0:y=${bands[0][0] - 1}:w=1920:h=3:color=${seam}:t=fill,format=${format}[${to}]`);
}

// a VHS track: a band that rolls down, with noise, its own colour (`look`) and split colour channels, moved sideways
function vhsFilters(parts, from, to, window, x, look, format) {
  const [bh, y0, speed] = FX_LAYOUTS.vhs[variantOf(window, FX_LAYOUTS.vhs.length)];
  const y = `'mod(${y0}+t*${speed},${1080 - bh})'`;
  const split = grow(10, window.strength);
  parts.push(`[${from}]split=2[${x}a][${x}b]`);
  parts.push(`[${x}b]crop=1920:${bh}:0:${y},${look},rgbashift=rh=${split}:bh=${-split}[${x}v]`);
  parts.push(`[${x}a][${x}v]overlay=x=${grow(34, window.strength)}:y=${y},format=${format}[${to}]`);
}

// digital noise over the whole picture and a band of coarse blocks
function noiseFilters(parts, from, to, window, x, amounts, format) {
  const [ny, nh] = FX_LAYOUTS.noise[0];
  parts.push(`[${from}]noise=${amounts}:allf=t+u,split=2[${x}a][${x}b]`);
  parts.push(`[${x}b]crop=1920:${nh}:0:${ny},scale=48:6:flags=area,scale=1920:${nh}:flags=neighbor[${x}p]`);
  parts.push(`[${x}a][${x}p]overlay=x=0:y=${ny},format=${format}[${to}]`);
}

// The filters of one window of Kuble (in planar RGB, on the lit picture): the prism (a blue ghost of the edges on one side and an amber one on the
// other) for the colour channels, its faceted shards for the blocks, a tear with a seam in its blue for writing, a VHS track tinted Kuble Blue and
// noise in night blue (the planes of planar RGB are G, B, R).
function kubleWindowFilters(theme) {
  const colors = theme.colors;
  const [r, g, b] = hexToUnit(colors.blue);
  return (parts, from, to, window, id) => {
    const s = window.strength;
    const x = `x${id}`;
    if (window.kind === 'rgb') {
      const shift = Math.round(8 + 26 * clamp(s, 0, 1));
      parts.push(`[${from}]split=3[${x}p][${x}q][${x}r]`);
      parts.push(`[${x}q]${tintMixer(hexToUnit(colors.blue), 1.3)},split=2[${x}q1][${x}q2]`);
      parts.push(`[${x}q1]pad=iw+${shift}:ih:0:0:color=black,crop=iw-${shift}:ih:${shift}:0[${x}q3]`);
      parts.push(`[${x}q3][${x}q2]blend=all_mode=subtract[${x}gb]`);
      parts.push(`[${x}r]${tintMixer(hexToUnit(colors.amber), 1.1)},split=2[${x}r1][${x}r2]`);
      parts.push(`[${x}r1]pad=iw+${shift}:ih:${shift}:0:color=black,crop=iw-${shift}:ih:0:0[${x}r3]`);
      parts.push(`[${x}r3][${x}r2]blend=all_mode=subtract[${x}ga]`);
      parts.push(`[${x}gb][${x}ga]blend=all_mode=addition[${x}g]`);
      parts.push(`[${x}p][${x}g]blend=all_mode=screen,format=gbrp[${to}]`);
      return;
    }
    if (window.kind === 'blocks') {
      const offset = Math.round(50 + 110 * clamp(s, 0, 1));
      parts.push(`[${from}]split=2[${x}a][${x}b]`);
      parts.push(`[${x}b]scroll=hpos=${round4(offset / 1920)}[${x}s]`);
      parts.push(`${shardMaskFrames(SHARDS[variantOf(window, SHARDS.length)], window.frames)}[${x}m]`);
      parts.push(`[${x}a][${x}s][${x}m]maskedmerge,format=gbrp[${to}]`);
      return;
    }
    if (window.kind === 'tear') {
      tearFilters(parts, from, to, window, x, `0x${colors.blueText.replace('#', '')}@0.9`, 'gbrp');
      return;
    }
    if (window.kind === 'vhs') {
      const tint = `colorchannelmixer=rr=${round4(0.45 + 0.4 * r)}:gg=${round4(0.45 + 0.4 * g)}:bb=${round4(0.7 + 0.5 * b)}`;
      vhsFilters(parts, from, to, window, x, `noise=alls=${grow(56, s)}:allf=t,${tint}`, 'gbrp');
      return;
    }
    noiseFilters(parts, from, to, window, x, `c0s=${grow(40, s)}:c1s=${grow(80, s)}:c2s=${grow(30, s)}`, 'gbrp');
  };
}

// The picture `label` cut into pieces at the windows (trim by frame number, each piece from time 0): the pieces between the windows as they are, each
// window through `filters`, then joined again (concat). So the filters of a glitch only work on its few frames: the cost of the post-pass grows with
// the frames of the windows, not with the length of the film. Returns the label of the result.
function fxWindowPieces(parts, label, windows, filters, format) {
  if (!windows.length) return label;
  const pieces = [];
  let at = 0;
  for (const window of windows) {
    if (window.frame > at) pieces.push({ from: at, to: window.frame });
    pieces.push({ from: window.frame, to: window.frame + window.frames, window });
    at = window.frame + window.frames;
  }
  pieces.push({ from: at, to: null });
  parts.push(`[${label}]split=${pieces.length}${pieces.map((_piece, i) => `[q${i}]`).join('')}`);
  pieces.forEach((piece, i) => {
    const trim = `trim=start_frame=${piece.from}${piece.to === null ? '' : `:end_frame=${piece.to}`},setpts=PTS-STARTPTS`;
    if (!piece.window) parts.push(`[q${i}]${trim}[r${i}]`);
    else {
      parts.push(`[q${i}]${trim}[w${i}]`);
      filters(parts, `w${i}`, `r${i}`, piece.window, i);
    }
  });
  parts.push(`${pieces.map((_piece, i) => `[r${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0,format=${format}[fxv]`);
  return 'fxv';
}

// The graph of the video with the effects on. HUD Blue: the windows on the picture as it comes, then the tail of before (grain, vignette, BT.709).
// Kuble: its graph of before without its own glitch (bloom, grain, vignette), the windows in its colours on the lit picture.
function fxVideoFilter({ windows, grain, input, theme = themes.get(themes.DEFAULT) }) {
  const sorted = windows.slice().sort((a, b) => a.frame - b.frame);
  if (theme.post.glitch === 'prism') {
    return kubleGraph({
      grain,
      input,
      theme,
      strength: 0,
      ghosts: [],
      shards: [],
      extra: sorted.length ? (parts, label) => fxWindowPieces(parts, label, sorted, kubleWindowFilters(theme), 'gbrp') : null
    });
  }
  const parts = [`[0:v]fps=${FPS},scale=1920:1080:flags=bicubic,setsar=1,setpts=PTS-STARTPTS[vin]`];
  const label = fxWindowPieces(parts, 'vin', sorted, hudWindowFilters, 'yuv420p');
  parts.push(`[${label}]${hudTail(grain, input)}[v]`);
  return parts.join(';');
}

// The audio: the song from `audioStart` for the length of the film, then silence up to the end of the end card.
function audioFilter({ audioStart, filmSeconds, totalSeconds }) {
  return `[1:a]atrim=start=${round4(audioStart)}:end=${round4(audioStart + filmSeconds)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${round4(totalSeconds)}[a]`;
}

// The command. listFile: the list of the chunks (concat demuxer, see concatListText); songFile: the song; graphics: the resolved data; params:
// { grain, glitch, effects }; endcardSeconds: 0 without an end card; inputColor: the tags of the chunks (see inputColour). The film is graphics.endFrame -
// first frame long, the end card follows. `effects` (effects.js: off, subtle, strong; anything else is off) takes the windows and kinds of the glitch
// from the plan of the effects (fxGlitchWindows, fxVideoFilter); off is the command of before.
function buildPostArgs({ listFile, songFile, outFile, graphics, params = {}, endcardSeconds = 0, inputColor }) {
  const origin = num(graphics.start, 0);
  const filmFrames = graphics.endFrame - frame(origin);
  const endcardFrames = Math.max(0, frame(endcardSeconds));
  const totalFrames = filmFrames + endcardFrames;
  const filmSeconds = filmFrames / FPS;
  const totalSeconds = totalFrames / FPS;
  const level = effectsLib.normalizeLevel(params.effects);
  const theme = themes.get(graphics.theme);
  const windows = level === 'off' ? glitchWindows(graphics, { glitch: params.glitch }) : fxGlitchWindows(graphics, { glitch: params.glitch, level });
  const video = level === 'off' ? videoFilter({ windows, grain: params.grain, input: inputColor, theme }) : fxVideoFilter({ windows, grain: params.grain, input: inputColor, theme });
  const filter = `${video};${audioFilter({ audioStart: origin, filmSeconds, totalSeconds })}`;
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
  fxGlitchWindows,
  fxVideoFilter,
  FX_LAYOUTS,
  FX_MAX_WINDOWS,
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
