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

const OUTPUT_EXT = Object.freeze({ image: '.png', video: '.mp4', audio: '.m4a' });

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

// Video codecs that can be muxed into MP4 without re-encoding (video.merge_audio copies them).
const MP4_COPY_CODECS = Object.freeze(['h264', 'hevc', 'mpeg4']);

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
function scaleChain(params, { video = false } = {}) {
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
      const transparent = !video && params.transparent === true;
      if (transparent) parts.push('format=rgba');
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

// image (+ audio) -> video. Zoom uses the closed form of zoompan on the output frame number.
function buildImageToVideo(params, infos, { duration } = {}) {
  const { width, height } = dims(infos[0]);
  const fps = clamp(int(params.fps, 30), 1, 60);
  const audioInfo = infos[1] || null;
  let seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = Number(params.duration);
  if (params.match_audio === true && audioInfo?.duration) seconds = audioInfo.duration;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be greater than 0');
  seconds = Math.min(seconds, 600);
  const w = even(width);
  const h = even(height);
  const frames = Math.max(1, Math.round(seconds * fps));
  const zoom = params.zoom || 'none';
  const parts = [];
  if (zoom === 'in' || zoom === 'out') {
    // Upscale small images first so zoompan does not stutter on integer crop offsets.
    const factor = w <= 2000 ? 2 : 1;
    if (factor > 1) parts.push(`scale=${w * factor}:${h * factor}:flags=lanczos`);
    else parts.push(`scale=${w}:${h}:flags=lanczos`);
    const z = zoom === 'in' ? `1+0.2*on/${frames}` : `1.2-0.2*on/${frames}`;
    parts.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`);
  } else {
    parts.push(`scale=${w}:${h}:flags=lanczos`, `fps=${fps}`);
  }
  // JPEG sources are full range (yuvj420p): convert to the limited range every player expects.
  parts.push('setsar=1', 'scale=out_range=tv', 'format=yuv420p');
  const chain = parts.join(',');
  const graph = `[0:v]${chain}[out]`;
  const maps = audioInfo ? ['[out]', '1:a:0'] : ['[out]'];
  return {
    chain,
    graph,
    inputOpts: [['-loop', '1', '-framerate', String(fps)]],
    outputs: [{ kind: 'video', maps, noAudio: !audioInfo, args: ['-t', num(seconds)] }],
    duration: seconds
  };
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
  const output = params.accurate === false
    ? { kind: 'video', maps, copyAll: true, args: ['-avoid_negative_ts', 'make_zero'] }
    : { kind: 'video', maps };
  return { inputOpts: [inputOpts], outputs: [output] };
}

function buildVideoResize(params, infos) {
  dims(infos[0], 'video');
  const chain = scaleChain(params, { video: true });
  return { chain, graph: chainGraph(chain), outputs: [{ kind: 'video', maps: ['[out]', '0:a?'] }] };
}

function buildVideoAdjust(params, infos) {
  dims(infos[0], 'video');
  const chain = adjustChain(params);
  return { chain, graph: chainGraph(chain), outputs: [{ kind: 'video', maps: ['[out]', '0:a?'] }] };
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
    return { chain: `setpts=PTS/${num(factor)}`, graph: video, outputs: [{ kind: 'video', maps: ['[v]'], noAudio: true }] };
  }
  const audio = `[0:a]${atempoChain(factor)}[a]`;
  return { chain: `setpts=PTS/${num(factor)}`, graph: `${video};${audio}`, outputs: [{ kind: 'video', maps: ['[v]', '[a]'] }] };
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
  buildExtractFrame,
  buildTrim,
  buildVideoResize,
  buildVideoAdjust,
  buildSpeed,
  buildOverlayImage,
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
