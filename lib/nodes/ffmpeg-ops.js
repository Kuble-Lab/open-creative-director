'use strict';

// Pure ffmpeg argument builders for the editing nodes (SPEC §5.7) plus a tolerant media probe.
// A builder takes the normalised node params and the probe results of its inputs and returns an op spec:
//   {
//     chain?:     simple filter chain of a single input (documentation / tests),
//     graph?:     full -filter_complex graph, must define the labels used in `outputs`,
//     inputOpts?: [[...], ...] options placed before -i of each input,
//     outputs:    [{ kind: 'image'|'video'|'audio', label?, maps?, videoCopy?, audioCopy?, copyAll?, noAudio?, args? }]
//   }
// assembleArgs() turns a spec plus file paths into the argv for ffmpeg. Nothing here touches the disk or spawns
// a process except probeMedia(); the node module (nodes-edit.js) runs the argv through ffmpeg.runProcess.

const ffmpeg = require('../ffmpeg');
const captionsLib = require('../captions-ass');

const OUTPUT_EXT = Object.freeze({ image: '.png', video: '.mp4', audio: '.m4a' });

// Transparency (WP33b). A video with an alpha channel (probe: video.alpha) keeps it through the ops that reshape exactly one video;
// those write WebM (VP9 with alpha, the sound as Opus), every other video op writes MP4 as before (H.264 knows no alpha).
// The builders of these ops mark their output `alpha: true` when the input has alpha; runOp() (nodes-edit.js) turns the mark into
// `container: 'webm'` when the ffmpeg has the encoders (ffmpeg.alphaVideoAvailable) and otherwise writes MP4 with a log line.
//   video.trim    cut to a range (always re-encoded with alpha: a stream copy cannot go from the source container to WebM)
//   video.speed   change the speed
//   video.resize  size and fit (the bars of contain are transparent, whatever the background colour says)
//   video.adjust  brightness, contrast, saturation, gamma, hue (colours only, the alpha plane passes through)
//   video.concat  join clips, when every clip has alpha (lib/tools.js concat_videos; otherwise MP4)
// MP4 stays for: image.to_video (no video input), video.overlay_image and video.overlay_video (the result is a film on a background),
// video.merge_audio, video.captions, video.soundwave, video.grid, video.extract_frame (a PNG, which keeps the alpha by itself),
// explainer.edit and music_video.edit (finished films).
const ALPHA_KEEPING_OPS = Object.freeze(['video.trim', 'video.speed', 'video.resize', 'video.adjust', 'video.concat']);
// The WebM of an alpha result (VP9 with alpha, the sound as Opus): the arguments live in lib/ffmpeg.js, where the joining of clips uses them too.
const ALPHA_VIDEO_ARGS = ffmpeg.ALPHA_VIDEO_ARGS;
const ALPHA_AUDIO_ARGS = ffmpeg.ALPHA_AUDIO_ARGS;

// The extension of the file an output is written to (WebM for a result with alpha).
function outputExt(output) {
  return output.kind === 'video' && output.container === 'webm' ? '.webm' : OUTPUT_EXT[output.kind];
}

const ASPECTS = Object.freeze(['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '21:9']);
const ANCHORS = Object.freeze(['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
const BLEND_MODES = Object.freeze(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']);
const FIT_MODES = Object.freeze(['contain', 'cover', 'stretch']);

// video.grid: the arrangements, which side is made equal, how long the result runs and where its sound comes from.
const GRID_LAYOUTS = Object.freeze(['auto', 'side_by_side', 'stacked', 'grid']);
const GRID_MATCH = Object.freeze(['auto', 'height', 'width']);
const GRID_LENGTHS = Object.freeze(['longest', 'shortest']);
const GRID_AUDIO = Object.freeze(['none', 'first_video']);
const GRID_LABEL_POSITIONS = Object.freeze(['bottom', 'top']);
const GRID_MIN_VIDEOS = 2;
const GRID_MAX_VIDEOS = 4;
const GRID_MAX_EDGE = 4096;

// video.overlay_video: how long the result runs, where its sound comes from, and whether a colour of the layer is keyed out first.
const OVERLAY_LENGTHS = Object.freeze(['background', 'layer', 'shortest']);
const OVERLAY_AUDIO = Object.freeze(['background', 'layer', 'mix', 'none']);
const OVERLAY_KEYS = Object.freeze(['none', 'chroma']);

// Video codecs that can be muxed into MP4 without re-encoding (video.merge_audio copies them).
const MP4_COPY_CODECS = Object.freeze(['h264', 'hevc', 'mpeg4']);
// The same for sound: what the nodes that only draw on the picture (video.captions, video.soundwave) pass on as it is.
const MP4_AUDIO_COPY_CODECS = Object.freeze(['aac', 'mp3']);

// video.soundwave: the shapes of the wave (the modes of the filter showwaves, and bars of the spectrum from showfreqs), where it sits,
// and how much of the picture it takes.
const WAVE_MODES = Object.freeze(['line', 'p2p', 'cline', 'point', 'bars']);
const WAVE_POSITIONS = Object.freeze(['bottom', 'middle', 'top']);
const WAVE_MIN_HEIGHT_PX = 16;
// distance of a wave at the top or the bottom from the edge, in % of the height of the picture
const WAVE_MARGIN_PERCENT = 4;

/* ---------- small helpers ---------- */

// Number -> compact string for filter expressions (no exponent notation, max 4 decimals).
function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number ${value}`);
  return String(Math.round(n * 10000) / 10000);
}

function int(value, fallback = 0) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Even dimensions are required by yuv420p / libx264.
function even(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

const HEX_COLOR = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;

function isHexColor(value) {
  return HEX_COLOR.test(String(value || '').trim());
}

// '#rrggbb' or '#rrggbbaa' -> '0xrrggbb' / '0xrrggbb@0.500' (ffmpeg colour syntax).
function ffColor(value, fallback = '#000000') {
  const text = String(value === undefined || value === null || String(value).trim() === '' ? fallback : value).trim();
  const match = HEX_COLOR.exec(text);
  if (!match) throw new Error(`Invalid colour "${text}" (use #rrggbb)`);
  const rgb = `0x${match[1].toLowerCase()}`;
  if (!match[2]) return rgb;
  return `${rgb}@${(parseInt(match[2], 16) / 255).toFixed(3)}`;
}

// { rgb: '#rrggbb', alpha: 0..1 } for SVG fills.
function svgColor(value, fallback = '#ffffff') {
  const text = String(value === undefined || value === null || String(value).trim() === '' ? fallback : value).trim();
  const match = HEX_COLOR.exec(text);
  if (!match) throw new Error(`Invalid colour "${text}" (use #rrggbb)`);
  return { rgb: `#${match[1].toLowerCase()}`, alpha: match[2] ? Math.round((parseInt(match[2], 16) / 255) * 1000) / 1000 : 1 };
}

function parseAspect(value) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new Error(`Invalid aspect ratio "${value}"`);
  return Number(match[1]) / Number(match[2]);
}

// Horizontal / vertical fraction (0..1) of an anchor name.
function anchorFractions(anchor) {
  const name = String(anchor || 'center');
  if (!ANCHORS.includes(name)) throw new Error(`Unknown anchor "${name}"`);
  const fx = name.includes('left') ? 0 : name.includes('right') ? 1 : 0.5;
  const fy = name.includes('top') ? 0 : name.includes('bottom') ? 1 : 0.5;
  return [fx, fy];
}

// Pixel size of the first video (image) stream of a probe.
function dims(info, label = 'input') {
  if (!info?.video?.width || !info?.video?.height) throw new Error(`${label} has no image/video stream`);
  return { width: info.video.width, height: info.video.height };
}

// True when the first video stream of a probe has an alpha channel.
function hasAlpha(info) {
  return Boolean(info?.video?.alpha);
}

// The mark of an output that carries the alpha of its input (see ALPHA_KEEPING_OPS): nothing for an input without alpha.
function alphaMark(info) {
  return hasAlpha(info) ? { alpha: true } : {};
}

function chainGraph(chain, stream = 'v') {
  return `[0:${stream}]${chain}[out]`;
}

function imageOut(extra = {}) {
  return { kind: 'image', ...extra };
}

/* ---------- assembling argv ---------- */

function codecArgs(output) {
  if (output.kind === 'image') return ['-frames:v', '1', '-update', '1', '-c:v', 'png'];
  if (output.kind === 'audio') return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
  if (output.kind === 'video' && output.container === 'webm') {
    return [...ALPHA_VIDEO_ARGS, ...(output.noAudio ? ['-an'] : ALPHA_AUDIO_ARGS)];
  }
  if (output.kind === 'video') {
    if (output.copyAll) return ['-c', 'copy', '-movflags', '+faststart'];
    const args = output.videoCopy
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
    if (output.noAudio) args.push('-an');
    else if (output.audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart');
    return args;
  }
  throw new Error(`Unknown output kind ${output.kind}`);
}

// argv for ffmpeg (without the binary). inputFiles / outputFiles are absolute paths.
function assembleArgs(spec, inputFiles, outputFiles) {
  if (!spec || !Array.isArray(spec.outputs) || !spec.outputs.length) throw new Error('Op spec has no outputs');
  if (outputFiles.length !== spec.outputs.length) throw new Error('Output file count does not match the op spec');
  const args = ['-nostdin', '-v', 'error', '-y'];
  inputFiles.forEach((file, index) => {
    args.push(...((spec.inputOpts && spec.inputOpts[index]) || []), '-i', file);
  });
  if (spec.graph) args.push('-filter_complex', spec.graph);
  spec.outputs.forEach((output, index) => {
    const maps = output.maps || [`[${output.label || 'out'}]`];
    for (const map of maps) args.push('-map', map);
    args.push(...codecArgs(output), ...(output.args || []), outputFiles[index]);
  });
  return args;
}

/* ---------- image builders ---------- */

// mode 'pixels': x/y offset, width/height 0 = up to the edge. mode 'aspect': largest crop of that ratio at the anchor.
function buildCrop(params, infos) {
  const { width: iw, height: ih } = dims(infos[0]);
  let x;
  let y;
  let w;
  let h;
  if (params.mode === 'aspect') {
    const ratio = parseAspect(params.aspect);
    w = iw;
    h = Math.round(iw / ratio);
    if (h > ih) {
      h = ih;
      w = Math.round(ih * ratio);
    }
    const [fx, fy] = anchorFractions(params.anchor);
    x = Math.round((iw - w) * fx);
    y = Math.round((ih - h) * fy);
  } else {
    x = clamp(int(params.x), 0, iw - 1);
    y = clamp(int(params.y), 0, ih - 1);
    w = int(params.width) > 0 ? Math.min(int(params.width), iw - x) : iw - x;
    h = int(params.height) > 0 ? Math.min(int(params.height), ih - y) : ih - y;
  }
  if (w < 1 || h < 1) throw new Error('Crop area is empty');
  const chain = `crop=${w}:${h}:${x}:${y}`;
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

// Shared by image.resize and video.resize. `video` forces even sizes and setsar=1.
function scaleChain(params, { video = false, alpha = false } = {}) {
  const width = int(params.width);
  const height = int(params.height);
  if (width <= 0 && height <= 0) throw new Error('Set a width or a height');
  const fit = params.fit || 'contain';
  if (!FIT_MODES.includes(fit)) throw new Error(`Unknown fit "${fit}"`);
  const fixed = (value) => (video ? even(value) : value);
  const auto = video ? -2 : -1;
  const parts = [];
  if (width <= 0 || height <= 0) {
    parts.push(`scale=${width > 0 ? fixed(width) : auto}:${height > 0 ? fixed(height) : auto}:flags=lanczos`);
  } else {
    const w = fixed(width);
    const h = fixed(height);
    if (fit === 'stretch') {
      parts.push(`scale=${w}:${h}:flags=lanczos`);
    } else if (fit === 'cover') {
      parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${w}:${h}`);
    } else {
      // an image is padded transparently on request; a video with alpha always is (its pixel format has the alpha plane already)
      const transparent = video ? alpha : params.transparent === true;
      if (transparent && !video) parts.push('format=rgba');
      parts.push(
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${transparent ? 'black@0' : ffColor(params.background)}`
      );
    }
  }
  if (video) parts.push('setsar=1');
  return parts.join(',');
}

function buildImageResize(params) {
  const chain = scaleChain(params);
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

// eq + hue filters for image.adjust and video.adjust; 'null' when everything is neutral.
function adjustChain(params) {
  const eq = [];
  if (Number(params.brightness) !== 0) eq.push(`brightness=${num(params.brightness)}`);
  if (Number(params.contrast) !== 1) eq.push(`contrast=${num(params.contrast)}`);
  if (Number(params.saturation) !== 1) eq.push(`saturation=${num(params.saturation)}`);
  if (Number(params.gamma) !== 1) eq.push(`gamma=${num(params.gamma)}`);
  const parts = [];
  if (eq.length) parts.push(`eq=${eq.join(':')}`);
  if (Number(params.hue) !== 0) parts.push(`hue=h=${num(params.hue)}`);
  return parts.length ? parts.join(',') : 'null';
}

function buildImageAdjust(params) {
  const chain = adjustChain(params);
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

function buildLevels(params) {
  const inBlack = Number(params.in_black);
  const inWhite = Number(params.in_white);
  const outBlack = Number(params.out_black);
  const outWhite = Number(params.out_white);
  if (!(inBlack < inWhite)) throw new Error('in_black must be lower than in_white');
  if (!(outBlack < outWhite)) throw new Error('out_black must be lower than out_white');
  const channels = ['r', 'g', 'b'];
  const parts = [];
  for (const c of channels) parts.push(`${c}imin=${num(inBlack)}`);
  for (const c of channels) parts.push(`${c}imax=${num(inWhite)}`);
  for (const c of channels) parts.push(`${c}omin=${num(outBlack)}`);
  for (const c of channels) parts.push(`${c}omax=${num(outWhite)}`);
  const chain = `colorlevels=${parts.join(':')}`;
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

function buildBlur(params) {
  const radius = Number(params.radius);
  const chain = radius > 0 ? `gblur=sigma=${num(radius)}` : 'null';
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

function buildSharpen(params) {
  const amount = Number(params.amount);
  const chain = amount > 0 ? `unsharp=5:5:${num(amount)}` : 'null';
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

function buildInvert(params) {
  const chain = params.alpha === true ? 'negate=negate_alpha=1' : 'negate';
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

// Flip first, then rotate clockwise.
function buildTransform(params) {
  const parts = [];
  const flip = params.flip || 'none';
  if (flip === 'h' || flip === 'both') parts.push('hflip');
  if (flip === 'v' || flip === 'both') parts.push('vflip');
  const rotate = String(params.rotate || '0');
  if (rotate === '90') parts.push('transpose=1');
  else if (rotate === '180') parts.push('hflip', 'vflip');
  else if (rotate === '270') parts.push('transpose=2');
  else if (rotate !== '0') throw new Error(`Unsupported rotation ${rotate}`);
  const chain = parts.length ? parts.join(',') : 'null';
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

// Grows the canvas: mode 'aspect' (smallest canvas of that ratio around the image) or 'size' (width/height, never smaller).
function buildPad(params, infos) {
  const { width: iw, height: ih } = dims(infos[0]);
  let cw;
  let ch;
  if (params.mode === 'size') {
    cw = Math.max(iw, int(params.width) > 0 ? int(params.width) : iw);
    ch = Math.max(ih, int(params.height) > 0 ? int(params.height) : ih);
  } else {
    const ratio = parseAspect(params.aspect);
    if (iw / ih > ratio) {
      cw = iw;
      ch = Math.max(ih, Math.round(iw / ratio));
    } else {
      ch = ih;
      cw = Math.max(iw, Math.round(ih * ratio));
    }
  }
  const [fx, fy] = anchorFractions(params.position);
  const x = Math.round((cw - iw) * fx);
  const y = Math.round((ch - ih) * fy);
  const transparent = params.transparent === true;
  const chain = `${transparent ? 'format=rgba,' : ''}pad=${cw}:${ch}:${x}:${y}:color=${transparent ? 'black@0' : ffColor(params.color)}`;
  return { chain, graph: chainGraph(chain), outputs: [imageOut()] };
}

// Position expressions for overlay(): the point (x, y) is in pixels or percent of the background;
// anchor 'center' puts the layer's centre on that point, 'top-left' its corner.
function positionExprs(params) {
  const axis = (value, dim, size) => {
    let expr = params.unit === 'percent' ? `${dim}*${num(Number(value) / 100)}` : num(value);
    if (params.anchor === 'center') expr += `-${size}/2`;
    return expr;
  };
  return { x: axis(params.x, 'W', 'w'), y: axis(params.y, 'H', 'h') };
}

// Layer preparation shared by image.composite and video.overlay_image: rgba, scale in %, opacity.
function layerSteps(params, layerDims) {
  const scale = Number(params.scale) / 100;
  const lw = Math.max(1, Math.round(layerDims.width * scale));
  const lh = Math.max(1, Math.round(layerDims.height * scale));
  const steps = ['format=rgba'];
  if (lw !== layerDims.width || lh !== layerDims.height) steps.push(`scale=${lw}:${lh}:flags=lanczos`);
  return { steps, lw, lh };
}

function opacityStep(params) {
  const opacity = Number(params.opacity);
  return opacity < 1 ? `colorchannelmixer=aa=${num(opacity)}` : null;
}

// background, layer, optional mask (its luminance replaces the layer alpha, white = visible).
// Blend modes other than normal are computed on the layer footprint only, so the rest of the background stays untouched.
function buildComposite(params, infos) {
  const bg = dims(infos[0], 'background');
  const layer = dims(infos[1], 'layer');
  const hasMask = Boolean(infos[2]);
  const blend = params.blend || 'normal';
  if (!BLEND_MODES.includes(blend)) throw new Error(`Unknown blend mode "${blend}"`);
  const { steps, lw, lh } = layerSteps(params, layer);
  const opacity = opacityStep(params);
  const pos = positionExprs(params);
  const graph = [];
  const layerChain = steps.join(',');
  if (hasMask) {
    graph.push(`[1:v]${layerChain}[l0]`);
    graph.push(`[2:v]scale=${lw}:${lh}:flags=bicubic,format=gray[m]`);
    graph.push(`[l0][m]alphamerge${opacity ? `,${opacity}` : ''}[l]`);
  } else {
    graph.push(`[1:v]${layerChain}${opacity ? `,${opacity}` : ''}[l]`);
  }
  if (blend === 'normal') {
    graph.push('[0:v]format=rgba[bg]');
    graph.push(`[bg][l]overlay=x=${pos.x}:y=${pos.y}:format=auto,format=rgba[out]`);
  } else {
    graph.push('[0:v]format=rgba,split[b0][b1]');
    graph.push(`color=c=black@0:s=${bg.width}x${bg.height}:d=1,format=rgba[cv0]`);
    graph.push(`[cv0][l]overlay=x=${pos.x}:y=${pos.y}:format=auto[cv]`);
    graph.push('[cv]split[cv1][cv2]');
    graph.push('[cv2]alphaextract[al]');
    graph.push(`[b0][cv1]blend=all_mode=${blend}[bl]`);
    graph.push('[bl][al]alphamerge[bla]');
    graph.push('[b1][bla]overlay=format=auto,format=rgba[out]');
  }
  return { graph: graph.join(';'), outputs: [imageOut()] };
}

// image + mask -> RGBA image whose alpha is the mask luminance (white = opaque).
function buildMaskApply(params, infos) {
  const { width, height } = dims(infos[0]);
  dims(infos[1], 'mask');
  const maskSteps = [`scale=${width}:${height}:flags=bicubic`, 'format=gray'];
  if (params.invert === true) maskSteps.push('negate');
  if (Number(params.feather) > 0) maskSteps.push(`gblur=sigma=${num(params.feather)}`);
  const graph = `[0:v]format=rgba[i];[1:v]${maskSteps.join(',')}[m];[i][m]alphamerge,format=rgba[out]`;
  return { graph, outputs: [imageOut()] };
}

// image -> keyed RGBA image plus the alpha matte (white = kept).
function buildChromaKey(params) {
  const similarity = clamp(Number(params.similarity), 0.01, 1);
  const blend = clamp(Number(params.blend), 0, 1);
  const key = `colorkey=${ffColor(params.color, '#00ff00')}:${num(similarity)}:${num(blend)}`;
  const graph = `[0:v]format=rgba,${key},split[keyed][k2];[k2]alphaextract[matte]`;
  return {
    chain: key,
    graph,
    outputs: [imageOut({ label: 'keyed' }), imageOut({ label: 'matte' })]
  };
}

/* ---------- video builders ---------- */

// image.to_video: the motions of the still image (SPEC §5.7). `none` stands still, `in` / `out` zoom from the centre, the
// four `pan_*` travel at a constant zoom, `alternate` and `varied` pick one of them by the position of the item in a list
// (ctx.itemIndex; outside a list 0), the three `parallax_*` move the picture by a depth map (see parallaxGraph).
const ZOOM_MODES = Object.freeze([
  'none', 'in', 'out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'alternate', 'varied', 'parallax_left', 'parallax_right', 'parallax_in'
]);
const PAN_ZOOM = 1.15; // the constant zoom of a pan: the window is 1 / 1.15 of the picture and travels over the rest
const VARIED_SEQUENCE = Object.freeze(['in', 'pan_right', 'out', 'pan_left']);
const PARALLAX_BASE_ZOOM = 1.08; // the slow zoom under parallax_in (the displacement there points inwards at the borders)
const PARALLAX_SHIFT = 0.05; // the nearest pixels move by this share of the width at a strength of 100 %
const PARALLAX_MAX_SHIFT = 120; // displace takes 8 bits around 128: at most +-127 pixels
const PARALLAX_MAP_DIVISOR = 4; // the displacement map is calculated at a quarter of the size and scaled up (it is smooth)
const PARALLAX_FALLBACK = Object.freeze({ parallax_left: 'pan_left', parallax_right: 'pan_right', parallax_in: 'in' });

// The motion that really runs for item `itemIndex`: `alternate` is in, out, in, ...; `varied` is in, pan_right, out, pan_left, ...
function resolveMotion(zoom, itemIndex) {
  const index = Math.max(0, Math.floor(Number(itemIndex)) || 0);
  if (zoom === 'alternate') return index % 2 === 0 ? 'in' : 'out';
  if (zoom === 'varied') return VARIED_SEQUENCE[index % VARIED_SEQUENCE.length];
  return ZOOM_MODES.includes(zoom) ? zoom : 'none';
}

function parallaxStrength(params) {
  const value = Number(params.parallax_strength);
  return clamp(Number.isFinite(value) ? value : 30, 0, 100);
}

// Whether the depth map takes part: a parallax motion, a strength above 0 and a connected map. The node collects the map
// only then (nodes-edit.js), and the builder reads it from the end of the inputs.
function usesDepth(params, inputs) {
  return String(params.zoom || '').startsWith('parallax') && parallaxStrength(params) > 0 && Boolean(inputs?.depth);
}

// zoompan with a constant zoom that travels along one axis from one edge of the picture to the other.
// `keep` (pixels of the input, sideways pans only) is a strip at the end of the travel that the window never reaches: a pan
// to the right ends `keep` pixels before the right edge, a pan to the left `keep` pixels after the left edge.
function panFilter(motion, { zoom, frames, w, h, fps, keep = 0 }) {
  const last = Math.max(1, frames - 1);
  const across = (size) => `(${size}-${size}/zoom)`;
  const forward = `on/${last}`;
  const backward = `(1-on/${last})`;
  const room = keep > 0 ? `max(0,${across('iw')}-${num(keep)})` : across('iw');
  let x = 'iw/2-(iw/zoom/2)';
  let y = 'ih/2-(ih/zoom/2)';
  if (motion === 'pan_right') x = `${room}*${forward}`;
  else if (motion === 'pan_left') x = `${keep > 0 ? `${num(keep)}+` : ''}${room}*${backward}`;
  else if (motion === 'pan_down') y = `${across('ih')}*${forward}`;
  else if (motion === 'pan_up') y = `${across('ih')}*${backward}`;
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${fps}`;
}

// Parallax with a depth map (bright = near): the picture goes through `displace`, whose maps come from the depth map by `geq`
// and change with the time T. A map value of 128 means no displacement (the output pixel is taken from x + value - 128), so
// the first frame is the picture as it is and the nearest pixels move furthest. The sideways motions shift the content (the
// far plane stays where the base motion puts it), `parallax_in` magnifies from the centre: the nearer, the more. `edge=smear`
// repeats the border where the displacement reaches over it; the base motion (a zoompan after it) keeps the borders of the
// picture away from the frame: `parallax_in` shifts towards the inside at the borders, the sideways motions pan with a
// window that stays clear of the strip the displacement can smear (see below). Works on planar RGB (gbrp) because displace moves each plane with the same
// plane of the map: the red channel of the depth map is the depth, and the map is written to all three planes.
function parallaxGraph(motion, { w, h, fps, frames, seconds, strength, depthIndex }) {
  const factor = w <= 1400 ? 2 : 1;
  const work = { w: w * factor, h: h * factor };
  const shift = clamp(Math.round(work.w * PARALLAX_SHIFT * (strength / 100)), 1, PARALLAX_MAX_SHIFT);
  const mapW = Math.max(16, Math.ceil(work.w / PARALLAX_MAP_DIVISOR));
  const mapH = Math.max(16, Math.ceil(work.h / PARALLAX_MAP_DIVISOR));
  const progress = `min(1,T/${num(seconds)})`;
  const depth = `r(X,Y)/255*${progress}`;
  let xExpr;
  let yExpr = '128';
  let base;
  if (motion === 'parallax_in') {
    xExpr = `128-(2*X/W-1)*${shift}*${depth}`;
    yExpr = `128-(2*Y/H-1)*${shift}*${depth}`;
    base = `zoompan=z='1+${num(PARALLAX_BASE_ZOOM - 1)}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
  } else {
    const sign = motion === 'parallax_right' ? 1 : -1;
    xExpr = `128+${sign * shift}*${depth}`;
    // The displacement drags the picture over one border (the right one for parallax_right, the left one for parallax_left)
    // and `edge=smear` repeats the last column there, up to `shift` pixels wide at the end of the clip. The window of the
    // pan keeps the strip of the strongest shift (strength 100 %, plus a little for the blur of the map) out of the frame.
    // Zoom and travel are the same for every strength, so the first frame is the same picture and the strength only
    // changes how far the near parts move against the far ones.
    const keep = clamp(Math.round(work.w * PARALLAX_SHIFT), 1, PARALLAX_MAX_SHIFT) + 2;
    base = panFilter(motion === 'parallax_right' ? 'pan_right' : 'pan_left', { zoom: PAN_ZOOM, frames, w, h, fps, keep });
  }
  const plane = (expr) => `geq=r='clip(${expr},0,255)':g='clip(${expr},0,255)':b='clip(${expr},0,255)'`;
  const toWork = `scale=${work.w}:${work.h}:flags=bilinear,format=gbrp`;
  const chain = [
    `displace=edge=smear`,
    base,
    'setsar=1',
    'scale=out_range=tv',
    'format=yuv420p'
  ].join(',');
  const graph = [
    `[0:v]scale=${work.w}:${work.h}:flags=lanczos,format=gbrp[src]`,
    `[${depthIndex}:v]scale=${mapW}:${mapH}:flags=bilinear,format=gbrp,gblur=sigma=2,split=2[dx][dy]`,
    `[dx]${plane(xExpr)},${toWork}[xmap]`,
    `[dy]${plane(yExpr)},${toWork}[ymap]`,
    `[src][xmap][ymap]${chain}[out]`
  ].join(';');
  return { chain, graph };
}

// image (+ audio) (+ depth map) -> video. The zoom uses the closed form of zoompan on the output frame number.
// infos: the image, then the audio if it has one, then the depth map if `opts.depth` is true (usesDepth).
// opts: { duration, itemIndex, depth }. Returns the op spec; `notes` are lines for the log of the node.
function buildImageToVideo(params, infos, { duration, itemIndex = 0, depth = false } = {}) {
  const { width, height } = dims(infos[0]);
  const fps = clamp(int(params.fps, 30), 1, 60);
  const audioInfo = infos.length > (depth ? 2 : 1) ? infos[1] : null;
  let seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = Number(params.duration);
  if (params.match_audio === true && audioInfo?.duration) seconds = audioInfo.duration;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be greater than 0');
  seconds = Math.min(seconds, 600);
  const w = even(width);
  const h = even(height);
  const frames = Math.max(1, Math.round(seconds * fps));
  const notes = [];
  let zoom = resolveMotion(params.zoom || 'none', itemIndex);
  if (zoom.startsWith('parallax') && !depth) {
    const strength = parallaxStrength(params);
    const fallback = PARALLAX_FALLBACK[zoom];
    notes.push(strength > 0 ? `No depth map is connected: ${zoom} becomes ${fallback}` : `Parallax strength is 0: ${zoom} becomes ${fallback}`);
    zoom = fallback;
  }
  const loop = ['-loop', '1', '-framerate', String(fps)];
  const inputOpts = [loop];
  if (audioInfo) inputOpts.push([]);
  if (depth) inputOpts.push(loop);
  const maps = audioInfo ? ['[out]', '1:a:0'] : ['[out]'];
  const outputs = [{ kind: 'video', maps, noAudio: !audioInfo, args: ['-t', num(seconds)] }];
  // JPEG sources are full range (yuvj420p): convert to the limited range every player expects.
  const finish = ['setsar=1', 'scale=out_range=tv', 'format=yuv420p'];

  if (zoom.startsWith('parallax')) {
    const { chain, graph } = parallaxGraph(zoom, { w, h, fps, frames, seconds, strength: parallaxStrength(params), depthIndex: audioInfo ? 2 : 1 });
    return { chain, graph, inputOpts, outputs, duration: seconds, notes };
  }
  const parts = [];
  if (zoom === 'none') {
    parts.push(`scale=${w}:${h}:flags=lanczos`, `fps=${fps}`);
  } else {
    // Upscale small images first so zoompan does not stutter on integer crop offsets.
    const factor = w <= 2000 ? 2 : 1;
    if (factor > 1) parts.push(`scale=${w * factor}:${h * factor}:flags=lanczos`);
    else parts.push(`scale=${w}:${h}:flags=lanczos`);
    if (zoom === 'in' || zoom === 'out') {
      const z = zoom === 'in' ? `1+0.2*on/${frames}` : `1.2-0.2*on/${frames}`;
      parts.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`);
    } else {
      parts.push(panFilter(zoom, { zoom: PAN_ZOOM, frames, w, h, fps }));
    }
  }
  parts.push(...finish);
  const chain = parts.join(',');
  const graph = `[0:v]${chain}[out]`;
  return { chain, graph, inputOpts, outputs, duration: seconds, notes };
}

// Frame position in seconds for video.extract_frame.
function frameTime(params, info) {
  const duration = info?.duration || 0;
  const fps = info?.video?.fps || 25;
  switch (params.position) {
    case 'first':
      return 0;
    case 'middle':
      return Math.max(0, duration / 2);
    case 'last':
      return Math.max(0, duration - 2 / fps);
    case 'time': {
      const time = Math.max(0, Number(params.time) || 0);
      if (duration && time >= duration) throw new Error(`time ${num(time)} s is beyond the end of the video (${num(duration)} s)`);
      return time;
    }
    default:
      throw new Error(`Unknown position "${params.position}"`);
  }
}

function buildExtractFrame(params, infos) {
  dims(infos[0], 'video');
  const time = frameTime(params, infos[0]);
  return {
    inputOpts: [['-ss', num(time)]],
    outputs: [imageOut({ maps: ['0:v:0'] })],
    time
  };
}

// Cut a range. end 0 = until the end of the clip. accurate = re-encode, otherwise stream copy (keyframe snapped).
function buildTrim(params, infos) {
  const info = infos[0];
  dims(info, 'video');
  const start = Math.max(0, Number(params.start) || 0);
  const end = Math.max(0, Number(params.end) || 0);
  const total = info.duration || 0;
  if (total && start >= total) throw new Error(`start (${num(start)} s) is beyond the end of the video (${num(total)} s)`);
  const stop = end > 0 ? (total ? Math.min(end, total) : end) : total;
  const length = stop ? stop - start : 0;
  if (stop && length <= 0) throw new Error('end must be greater than start');
  const inputOpts = ['-ss', num(start)];
  if (length > 0 && (end > 0 || start > 0)) inputOpts.push('-t', num(length));
  const maps = ['0:v:0', '0:a?'];
  // with alpha the cut is always re-encoded: a stream copy would have to keep the source container, and only WebM carries the alpha
  const output = params.accurate === false && !hasAlpha(info)
    ? { kind: 'video', maps, copyAll: true, args: ['-avoid_negative_ts', 'make_zero'] }
    : { kind: 'video', maps, ...alphaMark(info) };
  return { inputOpts: [inputOpts], outputs: [output] };
}

function buildVideoResize(params, infos) {
  dims(infos[0], 'video');
  const chain = scaleChain(params, { video: true, alpha: hasAlpha(infos[0]) });
  return { chain, graph: chainGraph(chain), outputs: [{ kind: 'video', maps: ['[out]', '0:a?'], ...alphaMark(infos[0]) }] };
}

function buildVideoAdjust(params, infos) {
  dims(infos[0], 'video');
  const chain = adjustChain(params);
  return { chain, graph: chainGraph(chain), outputs: [{ kind: 'video', maps: ['[out]', '0:a?'], ...alphaMark(infos[0]) }] };
}

// atempo only accepts 0.5..2 per instance on older ffmpeg builds: chain instances.
function atempoChain(factor) {
  let rest = Number(factor);
  if (!(rest > 0)) throw new Error('Speed factor must be greater than 0');
  const parts = [];
  while (rest > 2) {
    parts.push(2);
    rest /= 2;
  }
  while (rest < 0.5) {
    parts.push(0.5);
    rest *= 2;
  }
  parts.push(rest);
  return parts.map((value) => `atempo=${num(value)}`).join(',');
}

function buildSpeed(params, infos) {
  const info = infos[0];
  dims(info, 'video');
  const factor = Number(params.factor);
  if (!(factor > 0)) throw new Error('Speed factor must be greater than 0');
  const video = `[0:v]setpts=PTS/${num(factor)}[v]`;
  if (!info.audio) {
    return { chain: `setpts=PTS/${num(factor)}`, graph: video, outputs: [{ kind: 'video', maps: ['[v]'], noAudio: true, ...alphaMark(info) }] };
  }
  const audio = `[0:a]${atempoChain(factor)}[a]`;
  return { chain: `setpts=PTS/${num(factor)}`, graph: `${video};${audio}`, outputs: [{ kind: 'video', maps: ['[v]', '[a]'], ...alphaMark(info) }] };
}

// video + still image on top, optionally only between start and end seconds (end 0 = until the end).
function buildOverlayImage(params, infos) {
  dims(infos[0], 'video');
  const layer = dims(infos[1], 'image');
  const { steps } = layerSteps(params, layer);
  const opacity = opacityStep(params);
  if (opacity) steps.push(opacity);
  const pos = positionExprs(params);
  const start = Math.max(0, Number(params.start) || 0);
  const end = Math.max(0, Number(params.end) || 0);
  let enable = '';
  if (end > 0) {
    if (end <= start) throw new Error('end must be greater than start');
    enable = `:enable='between(t,${num(start)},${num(end)})'`;
  } else if (start > 0) {
    enable = `:enable='gte(t,${num(start)})'`;
  }
  const graph = `[1:v]${steps.join(',')}[ov];[0:v][ov]overlay=x=${pos.x}:y=${pos.y}${enable}:format=auto[out]`;
  return { graph, outputs: [{ kind: 'video', maps: ['[out]', '0:a?'] }] };
}

// video + video on top (video.overlay_video). `infos[0]` is the background, `infos[1]` the layer; the layer uses its alpha channel where it
// has one (a WebM cutout) and can be keyed (`key: 'chroma'`) when it has a colour background instead.
//   x, y, unit, anchor   where the layer sits (px or % of the background; anchor 'center' puts its centre on the point)
//   scale                width of the layer in % of the width of the background (the layer keeps its ratio)
//   opacity              0..1
//   start, end           the layer appears at `start` seconds of the background (its own first frame is shown then) and is hidden
//                        from `end` on (0 = until the end of the layer)
//   loop_layer           the layer starts over when it ends (until the result ends)
//   length               background: the length of the background; layer: until the layer is gone (start + its length, or `end`); a
//                        background that is shorter holds its last frame, a looped layer without `end` has no end of its own and the
//                        result then runs as long as the background; shortest: the shorter of the two
//   audio                background, layer (delayed by `start`), mix of both, none
// The result is always cut to the length by -t, so a looped layer (an endless input) ends there.
function buildOverlayVideo(params, infos) {
  const bg = dims(infos[0], 'background');
  const layer = dims(infos[1], 'layer');
  const length = params.length || 'background';
  if (!OVERLAY_LENGTHS.includes(length)) throw new Error(`Unknown length "${length}"`);
  const audioMode = params.audio || 'background';
  if (!OVERLAY_AUDIO.includes(audioMode)) throw new Error(`Unknown audio mode "${audioMode}"`);
  const key = params.key || 'none';
  if (!OVERLAY_KEYS.includes(key)) throw new Error(`Unknown key "${key}"`);
  const scale = Number(params.scale === undefined ? 100 : params.scale);
  if (!(scale > 0)) throw new Error('scale must be greater than 0');
  const start = Math.max(0, Number(params.start) || 0);
  const end = Math.max(0, Number(params.end) || 0);
  if (end > 0 && end <= start) throw new Error('end must be greater than start');
  const loop = params.loop_layer === true;
  const bgSeconds = Number(infos[0].duration) || 0;
  const layerSeconds = Number(infos[1].duration) || 0;
  if (!(bgSeconds > 0)) throw new Error('The length of the background video could not be determined');
  if (!(layerSeconds > 0) && !loop) throw new Error('The length of the layer video could not be determined');

  // when the layer is gone: the end of its own run (never, when it loops) or `end`, whichever comes first
  const ownEnd = loop ? Infinity : start + layerSeconds;
  const goneAt = end > 0 ? Math.min(ownEnd, end) : ownEnd;
  const seconds = length === 'background' ? bgSeconds : length === 'layer' ? (Number.isFinite(goneAt) ? goneAt : bgSeconds) : Math.min(bgSeconds, goneAt);
  if (!(seconds > 0)) throw new Error('The result would be empty');
  const extra = seconds - bgSeconds;
  const holdBackground = extra > 0.001;

  const lw = even((bg.width * scale) / 100);
  const lh = even((lw * layer.height) / layer.width);
  const pos = positionExprs(params);

  const steps = [];
  if (key === 'chroma') {
    const similarity = clamp(Number(params.key_similarity === undefined ? 0.3 : params.key_similarity), 0.01, 1);
    const blend = clamp(Number(params.key_blend === undefined ? 0.1 : params.key_blend), 0, 1);
    steps.push('format=rgba', `colorkey=${ffColor(params.key_color, '#00ff00')}:${num(similarity)}:${num(blend)}`);
  }
  if (lw !== layer.width || lh !== layer.height) steps.push(`scale=${lw}:${lh}:flags=lanczos`);
  steps.push('format=yuva420p');
  const opacity = opacityStep(params);
  if (opacity) steps.push(opacity);
  steps.push(`setpts=PTS-STARTPTS+${num(start)}/TB`);

  const graph = [];
  graph.push(`[1:v]${steps.join(',')}[ov]`);
  const main = holdBackground ? 'bgh' : '0:v'; // the label of the background stream
  if (holdBackground) graph.push(`[0:v]tpad=stop_mode=clone:stop_duration=${num(extra)}[bgh]`);
  // The layer is hidden from `end` on, or where its own run is over: its last frame is held until then (eof_action=repeat) and `enable`
  // takes it away at the right moment. (eof_action=pass would drop it a frame too early.) A looped layer has no end of its own and ends
  // with the background (shortest=1: the looped input never ends).
  let enable = '';
  if (end > 0 && end <= ownEnd) enable = `:enable='between(t,${num(start)},${num(end)})'`;
  else if (Number.isFinite(ownEnd) && ownEnd < seconds - 0.001) enable = `:enable='lt(t,${num(ownEnd)})'`;
  graph.push(`[${main}][ov]overlay=x=${pos.x}:y=${pos.y}:eof_action=repeat${loop ? ':shortest=1' : ''}${enable}:format=auto[out]`);

  // sound: whichever tracks the mode asks for; a track that is not there is left out, with a note
  const notes = [];
  const wantBackground = audioMode === 'background' || audioMode === 'mix';
  const wantLayer = audioMode === 'layer' || audioMode === 'mix';
  const haveBackground = wantBackground && Boolean(infos[0].audio);
  const haveLayer = wantLayer && Boolean(infos[1].audio);
  if (wantBackground && !haveBackground && audioMode === 'background') notes.push('The background video has no sound');
  if (wantLayer && !haveLayer) notes.push('The layer has no sound');
  const tracks = [];
  if (haveBackground) {
    graph.push('[0:a]apad[ab]');
    tracks.push('[ab]');
  }
  if (haveLayer) {
    const parts = [];
    if (end > 0) parts.push(`atrim=duration=${num(end - start)}`, 'asetpts=PTS-STARTPTS');
    if (start > 0) parts.push(`adelay=${Math.round(start * 1000)}:all=1`);
    parts.push('apad');
    graph.push(`[1:a]${parts.join(',')}[al]`);
    tracks.push('[al]');
  }
  let audioMap = null;
  if (tracks.length === 2) {
    graph.push(`${tracks.join('')}amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
    audioMap = '[aout]';
  } else if (tracks.length === 1) {
    audioMap = tracks[0];
  }
  const output = { kind: 'video', maps: audioMap ? ['[out]', audioMap] : ['[out]'], args: ['-t', num(seconds)] };
  if (audioMode === 'none') output.noAudio = true;
  return { graph: graph.join(';'), inputOpts: [[], loop ? ['-stream_loop', '-1'] : []], outputs: [output], notes, duration: seconds };
}

// Caption script (lib/captions-ass.js) burnt into the picture by the filter `ass`; the sound is passed on as it is where MP4 takes it.
// `assFile` is the path of the script, `events` the number of captions in it: without any the video passes through unchanged.
function buildCaptions(params, infos, { assFile, events = 1 } = {}) {
  const video = infos[0];
  dims(video, 'video');
  const audioCopy = Boolean(video.audio) && MP4_AUDIO_COPY_CODECS.includes(video.audio.codec);
  if (!events) return { graph: null, outputs: [{ kind: 'video', maps: ['0:v:0', '0:a?'], copyAll: true }] };
  const chain = captionsLib.assFilter(assFile);
  return { chain, graph: `[0:v]${chain}[out]`, outputs: [{ kind: 'video', maps: ['[out]', '0:a?'], audioCopy }] };
}

// The wave of the sound drawn over the picture. The wave comes from the audio input, else from the sound of the video; the sound of
// the film stays the sound of the video, and a video without sound gets the sound of the audio input.
//   modes line / p2p / cline / point: the filter showwaves; bars: the spectrum (showfreqs) as bars
//   height: % of the height of the picture, as wide as the picture; position bottom / middle / top; colour; opacity
function buildSoundwave(params, infos) {
  const { width, height } = dims(infos[0], 'video');
  const video = infos[0];
  const extra = infos[1] || null;
  if (extra && !extra.audio) throw new Error('audio input has no audio stream');
  if (!extra && !video.audio) throw new Error('The video has no sound: connect an audio input');
  const mode = params.mode || 'cline';
  if (!WAVE_MODES.includes(mode)) throw new Error(`Unknown wave mode "${mode}"`);
  const position = params.position || 'bottom';
  if (!WAVE_POSITIONS.includes(position)) throw new Error(`Unknown wave position "${position}"`);
  const percent = clamp(Number(params.height) || 20, 1, 100);
  const waveHeight = Math.min(even(height), even(Math.max(WAVE_MIN_HEIGHT_PX, Math.round((height * percent) / 100))));
  const margin = even(Math.round((height * WAVE_MARGIN_PERCENT) / 100));
  const y = position === 'top' ? Math.min(margin, height - waveHeight) : position === 'middle' ? Math.round((height - waveHeight) / 2) : Math.max(0, height - waveHeight - margin);
  const fps = clamp(Number(video.video.fps) || 25, 1, 120);
  const color = ffColor(params.color, '#ffffff');
  const size = `${even(width)}x${waveHeight}`;
  const source = extra ? '1:a:0' : '0:a:0';
  const draw =
    mode === 'bars'
      ? `showfreqs=s=${size}:mode=bar:rate=${num(fps)}:fscale=log:ascale=sqrt:win_size=2048:averaging=3:colors=${color}`
      : `showwaves=s=${size}:mode=${mode}:rate=${num(fps)}:scale=sqrt:draw=full:colors=${color}`;
  const opacity = opacityStep(params);
  const graph = [];
  // the sound of the audio input is needed twice (the wave, and the sound of the film when the video has none). As the sound of the
  // film it is cut or padded to the length of the video: padding it without end under -shortest stops ffmpeg 6 with "No space left
  // on device" (its sync queue); only a video of unknown length still takes that way.
  const useAsSound = Boolean(extra) && !video.audio;
  const seconds = Number(video.duration) > 0 ? Number(video.duration) : 0;
  if (useAsSound) {
    graph.push(`[${source}]asplit=2[snd0][src]`, `[snd0]${seconds ? `atrim=end=${num(seconds)},apad=whole_dur=${num(seconds)}` : 'apad'}[snd]`);
    graph.push(`[src]aformat=channel_layouts=mono,${draw}${opacity ? `,format=rgba,${opacity}` : ''}[w]`);
  } else {
    graph.push(`[${source}]aformat=channel_layouts=mono,${draw}${opacity ? `,format=rgba,${opacity}` : ''}[w]`);
  }
  graph.push(`[0:v][w]overlay=x=0:y=${y}:eof_action=pass:format=auto[out]`);
  const audioCopy = Boolean(video.audio) && MP4_AUDIO_COPY_CODECS.includes(video.audio.codec);
  return {
    graph: graph.join(';'),
    outputs: [
      {
        kind: 'video',
        maps: useAsSound ? ['[out]', '[snd]'] : video.audio ? ['[out]', '0:a:0'] : ['[out]'],
        audioCopy,
        args: useAsSound && !seconds ? ['-shortest'] : []
      }
    ]
  };
}

// mode replace: the audio track replaces the video's; mix: both are mixed (volumes applied first).
// length 'shortest' ends with the shorter stream, 'video' keeps the video length (audio is padded with silence).
function buildMergeAudio(params, infos) {
  const video = infos[0];
  dims(video, 'video');
  const audio = infos[1];
  if (!audio?.audio) throw new Error('audio input has no audio stream');
  const mix = params.mode === 'mix' && Boolean(video.audio);
  const padVideo = params.length === 'video';
  const graph = [];
  const a1 = `[1:a]volume=${num(params.audio_volume)}${padVideo ? ',apad' : ''}`;
  if (mix) {
    graph.push(`[0:a]volume=${num(params.video_volume)}[a0]`);
    graph.push(`${a1}[a1]`);
    graph.push(`[a0][a1]amix=inputs=2:duration=${padVideo ? 'first' : 'shortest'}:dropout_transition=0[aout]`);
  } else {
    graph.push(`${a1}[aout]`);
  }
  const copyVideo = MP4_COPY_CODECS.includes(video.video.codec);
  return {
    graph: graph.join(';'),
    outputs: [{ kind: 'video', maps: ['0:v:0', '[aout]'], videoCopy: copyVideo, args: ['-shortest'] }]
  };
}

// Layout of video.grid: where every video sits on the canvas. `infos` are the probes of the videos in order.
// Each video keeps its aspect ratio and is scaled to the same height (match 'height') or width (match 'width'); the
// other side follows from the ratio. The slot of a column is as wide as its widest video, the slot of a row as high as
// its highest one, and the videos sit in the middle of their slot on the background colour. Sizes and positions are
// even (yuv420p). Nothing is cropped or stretched. size 0 = the smallest video decides, and the canvas never exceeds
// GRID_MAX_EDGE pixels on a side.
function planVideoGrid(params, infos) {
  const count = infos.length;
  if (count < GRID_MIN_VIDEOS || count > GRID_MAX_VIDEOS) {
    throw new Error(`video.grid needs ${GRID_MIN_VIDEOS} to ${GRID_MAX_VIDEOS} videos`);
  }
  const sizes = infos.map((info, index) => dims(info, `video ${index + 1}`));
  const wanted = params.layout || 'auto';
  if (!GRID_LAYOUTS.includes(wanted)) throw new Error(`Unknown layout "${wanted}"`);
  const layout = wanted === 'auto' ? (count === 4 ? 'grid' : 'side_by_side') : wanted;
  const cols = layout === 'stacked' ? 1 : layout === 'side_by_side' ? count : 2;
  const rows = Math.ceil(count / cols);
  const wantedMatch = params.match || 'auto';
  if (!GRID_MATCH.includes(wantedMatch)) throw new Error(`Unknown match "${wantedMatch}"`);
  const match = wantedMatch === 'auto' ? (layout === 'stacked' ? 'width' : 'height') : wantedMatch;
  const gap = Math.floor(clamp(int(params.gap), 0, 200) / 2) * 2;
  const smallest = Math.min(...sizes.map((size) => (match === 'height' ? size.height : size.width)));
  let side = even(int(params.size) > 0 ? int(params.size) : smallest);

  const compose = (edge) => {
    const cells = sizes.map((size) =>
      match === 'height'
        ? { w: even((size.width * edge) / size.height), h: edge }
        : { w: edge, h: even((size.height * edge) / size.width) }
    );
    const colWidths = Array.from({ length: cols }, () => 0);
    const rowHeights = Array.from({ length: rows }, () => 0);
    cells.forEach((cell, index) => {
      colWidths[index % cols] = Math.max(colWidths[index % cols], cell.w);
      rowHeights[Math.floor(index / cols)] = Math.max(rowHeights[Math.floor(index / cols)], cell.h);
    });
    const sum = (list) => list.reduce((total, value) => total + value, 0) + gap * (list.length - 1);
    return { cells, colWidths, rowHeights, width: sum(colWidths), height: sum(rowHeights) };
  };
  let plan = compose(side);
  for (let guard = 0; guard < 40 && (plan.width > GRID_MAX_EDGE || plan.height > GRID_MAX_EDGE) && side > 2; guard += 1) {
    side = even(side * 0.9);
    plan = compose(side);
  }

  const { cells, colWidths, rowHeights } = plan;
  const startOf = (list, index) => list.slice(0, index).reduce((total, value) => total + value + gap, 0);
  const placed = cells.map((cell, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      ...cell,
      x: startOf(colWidths, col) + Math.floor((colWidths[col] - cell.w) / 4) * 2,
      y: startOf(rowHeights, row) + Math.floor((rowHeights[row] - cell.h) / 4) * 2
    };
  });

  const durations = infos.map((info) => info.duration || 0);
  if (durations.some((value) => !(value > 0))) throw new Error('A video has no known duration');
  const length = params.length || 'longest';
  if (!GRID_LENGTHS.includes(length)) throw new Error(`Unknown length "${length}"`);
  const duration = length === 'shortest' ? Math.min(...durations) : Math.max(...durations);
  const fps = clamp(Math.round(Math.max(...infos.map((info) => info.video.fps || 0), 0) * 1000) / 1000 || 30, 1, 60);
  return { layout, match, cols, rows, width: plan.width, height: plan.height, cells: placed, duration, fps };
}

// video.grid: the videos arranged on one canvas. `labels` is one entry per video: the index of its label picture among
// the inputs (the label pictures follow the videos) or null. A label picture is a text pill; it is scaled to the font
// size (0 = a tenth of the video height) and sits at the bottom or top edge of its video.
// The last frame of a shorter video stays on screen (overlay repeats it); with length 'shortest' everything is cut at
// the shortest video. Sound: none, or the track of the first video (padded with silence, cut at the end).
function buildVideoGrid(params, infos, { labels = [] } = {}) {
  const count = labels.length || Math.min(infos.length, GRID_MAX_VIDEOS);
  const plan = planVideoGrid(params, infos.slice(0, count));
  const position = params.label_position || 'bottom';
  if (!GRID_LABEL_POSITIONS.includes(position)) throw new Error(`Unknown label position "${position}"`);
  const audio = params.audio || 'none';
  if (!GRID_AUDIO.includes(audio)) throw new Error(`Unknown audio mode "${audio}"`);
  const fps = num(plan.fps);
  const graph = [`color=c=${ffColor(params.background, '#000000')}:s=${plan.width}x${plan.height}:r=${fps}:d=${num(plan.duration)},format=yuv420p[bg]`];
  plan.cells.forEach((cell, index) => {
    graph.push(`[${index}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${cell.w}:${cell.h}:flags=lanczos,setsar=1,format=yuv420p[v${index}]`);
  });
  let last = 'bg';
  plan.cells.forEach((cell, index) => {
    const next = `t${index}`;
    graph.push(`[${last}][v${index}]overlay=x=${cell.x}:y=${cell.y}:eof_action=repeat:format=yuv420[${next}]`);
    last = next;
  });
  const fontSize = clamp(int(params.font_size), 0, 400);
  labels.forEach((source, index) => {
    if (source === null || source === undefined || !infos[source]) return;
    const cell = plan.cells[index];
    const pill = dims(infos[source], `label ${index + 1}`);
    const wantedHeight = fontSize > 0 ? Math.round(fontSize * 1.5) : Math.round(cell.h / 10);
    let height = clamp(wantedHeight, 12, cell.h);
    let width = Math.round((pill.width * height) / pill.height);
    const margin = Math.max(4, Math.round(height * 0.35));
    if (width > cell.w - 2 * margin) {
      width = Math.max(8, cell.w - 2 * margin);
      height = Math.max(8, Math.round((pill.height * width) / pill.width));
    }
    const x = cell.x + Math.floor((cell.w - width) / 2);
    const y = position === 'top' ? cell.y + margin : cell.y + cell.h - height - margin;
    graph.push(`[${source}:v]format=rgba,scale=${width}:${height}:flags=lanczos[l${index}]`);
    graph.push(`[${last}][l${index}]overlay=x=${x}:y=${Math.max(cell.y, y)}:format=auto[u${index}]`);
    last = `u${index}`;
  });
  graph.push(`[${last}]format=yuv420p[out]`);
  const withSound = audio === 'first_video' && Boolean(infos[0]?.audio);
  if (withSound) graph.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[sound]');
  return {
    graph: graph.join(';'),
    outputs: [{ kind: 'video', maps: withSound ? ['[out]', '[sound]'] : ['[out]'], noAudio: !withSound, args: ['-t', num(plan.duration)] }],
    plan
  };
}

/* ---------- audio builders ---------- */

function buildExtractAudio(_params, infos) {
  if (!infos[0]?.audio) throw new Error('The video has no audio track');
  return { outputs: [{ kind: 'audio', maps: ['0:a:0'] }] };
}

function buildAudioTrim(params, infos) {
  const info = infos[0];
  if (!info?.audio) throw new Error('input has no audio stream');
  const start = Math.max(0, Number(params.start) || 0);
  const end = Math.max(0, Number(params.end) || 0);
  const total = info.duration || 0;
  if (total && start >= total) throw new Error(`start (${num(start)} s) is beyond the end of the audio (${num(total)} s)`);
  if (end > 0 && end <= start) throw new Error('end must be greater than start');
  const stop = end > 0 ? (total ? Math.min(end, total) : end) : total;
  const length = stop ? stop - start : 0;
  const parts = [`atrim=start=${num(start)}${end > 0 ? `:end=${num(end)}` : ''}`, 'asetpts=PTS-STARTPTS'];
  const fadeIn = Math.max(0, Number(params.fade_in) || 0);
  let fadeOut = Math.max(0, Number(params.fade_out) || 0);
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${num(fadeIn)}`);
  if (fadeOut > 0) {
    if (!length) throw new Error('fade_out needs a known audio duration');
    fadeOut = Math.min(fadeOut, length);
    parts.push(`afade=t=out:st=${num(length - fadeOut)}:d=${num(fadeOut)}`);
  }
  const chain = parts.join(',');
  return { chain, graph: chainGraph(chain, 'a'), outputs: [{ kind: 'audio' }] };
}

// Comma separated list -> numbers; missing entries default to 1.
function parseVolumes(text, count) {
  const values = String(text || '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 10)) {
    throw new Error('volumes must be numbers between 0 and 10, separated by commas');
  }
  return Array.from({ length: count }, (_unused, index) => (values[index] === undefined ? 1 : values[index]));
}

function buildAudioMix(params, infos) {
  const count = infos.length;
  if (count < 2 || count > 8) throw new Error('audio.mix needs 2 to 8 tracks');
  infos.forEach((info, index) => {
    if (!info?.audio) throw new Error(`track ${index + 1} has no audio stream`);
  });
  const length = params.length || 'longest';
  if (!['longest', 'shortest', 'first'].includes(length)) throw new Error(`Unknown length mode "${length}"`);
  const volumes = parseVolumes(params.volumes, count);
  const graph = volumes.map((volume, index) => `[${index}:a]volume=${num(volume)}[a${index}]`);
  graph.push(`${volumes.map((_v, index) => `[a${index}]`).join('')}amix=inputs=${count}:duration=${length}:dropout_transition=0[out]`);
  return { graph: graph.join(';'), outputs: [{ kind: 'audio' }] };
}

/* ---------- probing ---------- */

// Display-matrix rotation of a video stream (phone footage, EXIF orientation), degrees or 0.
function streamRotation(stream) {
  const side = Array.isArray(stream?.side_data_list) ? stream.side_data_list.find((item) => item && item.rotation !== undefined) : null;
  const value = side ? Number(side.rotation) : Number(stream?.tags?.rotate);
  return Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : 0;
}

// Like ffmpeg.normaliseProbe but also accepts audio-only files; video sizes are swapped for 90/270 degree rotation.
function normaliseMediaProbe(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === 'video');
  if (videoStream) {
    const probe = ffmpeg.normaliseProbe(data);
    const rotation = streamRotation(videoStream);
    if (rotation === 90 || rotation === 270) {
      [probe.video.width, probe.video.height] = [probe.video.height, probe.video.width];
    }
    return probe;
  }
  const audioStream = streams.find((stream) => stream?.codec_type === 'audio');
  if (!audioStream) throw new Error('The file has no video or audio stream');
  const duration = Number(data?.format?.duration ?? audioStream.duration);
  return {
    video: null,
    audio: {
      codec: String(audioStream.codec_name || ''),
      sampleRate: Number(audioStream.sample_rate) || 0,
      channels: Number(audioStream.channels) || 0,
      channelLayout: String(audioStream.channel_layout || '')
    },
    duration: Number.isFinite(duration) && duration > 0 ? duration : null
  };
}

// Probes an image, video or audio file. `signal` aborts the ffprobe process.
async function probeMedia(file, { ffprobePath, timeoutMs = 30000, signal } = {}) {
  const command = ffprobePath || ffmpeg.binaries().ffprobe;
  if (!command) throw new Error('ffprobe not found');
  const { stdout } = await ffmpeg.runProcess(command, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    timeoutMs,
    signal
  });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`ffprobe output is invalid: ${err.message}`);
  }
  return normaliseMediaProbe(data);
}

module.exports = {
  OUTPUT_EXT,
  ALPHA_KEEPING_OPS,
  ALPHA_VIDEO_ARGS,
  outputExt,
  hasAlpha,
  ASPECTS,
  ANCHORS,
  BLEND_MODES,
  FIT_MODES,
  GRID_LAYOUTS,
  GRID_MATCH,
  GRID_LENGTHS,
  GRID_AUDIO,
  GRID_LABEL_POSITIONS,
  GRID_MIN_VIDEOS,
  GRID_MAX_VIDEOS,
  GRID_MAX_EDGE,
  MP4_COPY_CODECS,
  MP4_AUDIO_COPY_CODECS,
  WAVE_MODES,
  WAVE_POSITIONS,
  num,
  even,
  isHexColor,
  ffColor,
  svgColor,
  parseAspect,
  anchorFractions,
  positionExprs,
  scaleChain,
  adjustChain,
  atempoChain,
  parseVolumes,
  frameTime,
  assembleArgs,
  buildCrop,
  buildImageResize,
  buildImageAdjust,
  buildLevels,
  buildBlur,
  buildSharpen,
  buildInvert,
  buildTransform,
  buildPad,
  buildComposite,
  buildMaskApply,
  buildChromaKey,
  buildImageToVideo,
  ZOOM_MODES,
  PARALLAX_FALLBACK,
  resolveMotion,
  usesDepth,
  buildExtractFrame,
  buildTrim,
  buildVideoResize,
  buildVideoAdjust,
  buildSpeed,
  buildOverlayImage,
  buildOverlayVideo,
  OVERLAY_LENGTHS,
  OVERLAY_AUDIO,
  OVERLAY_KEYS,
  buildCaptions,
  buildSoundwave,
  buildMergeAudio,
  planVideoGrid,
  buildVideoGrid,
  buildExtractAudio,
  buildAudioTrim,
  buildAudioMix,
  streamRotation,
  normaliseMediaProbe,
  probeMedia
};
