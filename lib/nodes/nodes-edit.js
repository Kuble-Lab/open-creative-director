'use strict';

// Editing node types (SPEC §5.7 ffmpeg, §5.4 image.svg_rasterize and image.text_render via resvg).
// Everything runs locally: the argument builders live in ffmpeg-ops.js, this module resolves the input files,
// runs ffmpeg through ffmpeg.runProcess (abortable, one of the engine's local slots) and stores the results as
// ledger assets of the workflow's backing session. No provider, no cost journal entries.

const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const { assertNoExternalReferences } = require('../svg-safe');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const { numberValue } = require('./types');

const MAX_AUDIO_TRACKS = 8;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_RASTER_EDGE = 16384;
const MAX_RASTER_PIXELS = 50 * 1000 * 1000;
const MAX_TEXT_LINES = 200;

/* ---------- availability and shared helpers ---------- */

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

let resvgModule;
function loadResvg() {
  if (resvgModule === undefined) {
    try {
      resvgModule = require('@resvg/resvg-js');
    } catch (_) {
      resvgModule = null;
    }
  }
  return resvgModule;
}

function resvgAvailable() {
  return loadResvg() ? true : '@resvg/resvg-js is not installed';
}

function colorIssue(value, label = 'color') {
  return ops.isHexColor(value) ? null : `${label}: use a hex colour like #ff8800`;
}

function compact(list) {
  return list.filter(Boolean);
}

// Runs one ffmpeg op: probes the inputs, builds the argv from the op spec, runs ffmpeg inside a scratch dir in the
// session asset dir and stores every output as a ledger asset. Returns the output values in spec order.
async function runOp(ctx, { label, files, build }) {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const infos = [];
      for (const file of files) {
        infos.push(await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal }));
      }
      const spec = build(infos);
      const outputFiles = spec.outputs.map((output, index) => path.join(scratch, `out-${index}${ops.OUTPUT_EXT[output.kind]}`));
      const args = ops.assembleArgs(spec, files, outputFiles);
      await ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal });
      const values = [];
      for (let index = 0; index < spec.outputs.length; index += 1) {
        const output = spec.outputs[index];
        const file = outputFiles[index];
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat || !stat.size) throw new Error(`ffmpeg produced no output for ${label}`);
        let duration;
        if (output.kind !== 'image') {
          const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
          duration = probe.duration || undefined;
        }
        values.push(
          await ctx.saveOutputFile({
            kind: output.kind,
            ext: ops.OUTPUT_EXT[output.kind],
            sourceFile: file,
            prompt: label,
            cost: 0,
            duration
          })
        );
      }
      return values;
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

// Definition factory for a plain ffmpeg op. `collect(inputs)` returns the media values in -i order,
// `build(params, infos, inputs)` returns the op spec, `outputIds` names the output port of each spec output.
function ffmpegNode({ collect, build, outputIds, ...meta }) {
  return {
    ...meta,
    cost: { unit: 'local' },
    available: ffmpegAvailable,
    execute: async (ctx, inputs, params) => {
      const values = collect(inputs);
      const produced = await runOp(ctx, {
        label: meta.label,
        files: values.map((value) => assets.assetFilePath(value)),
        build: (infos) => build(params, infos, inputs)
      });
      const variant = {};
      outputIds.forEach((id, index) => {
        variant[id] = produced[index];
      });
      return { variants: [variant] };
    }
  };
}

const single = (portId) => (inputs) => [inputs[portId]];

/* ---------- shared param definitions ---------- */

const IMAGE_IN = [{ id: 'image', type: 'image', required: true }];
const IMAGE_OUT = [{ id: 'image', type: 'image' }];
const VIDEO_IN = [{ id: 'video', type: 'video', required: true }];
const VIDEO_OUT = [{ id: 'video', type: 'video' }];

const adjustParams = () => [
  { id: 'brightness', kind: 'slider', min: -1, max: 1, step: 0.01, default: 0 },
  { id: 'contrast', kind: 'slider', min: 0, max: 3, step: 0.01, default: 1 },
  { id: 'saturation', kind: 'slider', min: 0, max: 3, step: 0.01, default: 1 },
  { id: 'gamma', kind: 'slider', min: 0.1, max: 3, step: 0.01, default: 1 },
  { id: 'hue', kind: 'slider', min: -180, max: 180, step: 1, default: 0 }
];

const positionParams = () => [
  { id: 'x', kind: 'number', default: 0 },
  { id: 'y', kind: 'number', default: 0 },
  { id: 'unit', kind: 'select', options: ['px', 'percent'], default: 'px' },
  { id: 'anchor', kind: 'select', options: ['top-left', 'center'], default: 'top-left' },
  { id: 'scale', kind: 'number', min: 1, max: 1000, default: 100 },
  { id: 'opacity', kind: 'slider', min: 0, max: 1, step: 0.01, default: 1 }
];

/* ---------- image ops ---------- */

const imageDefinitions = [
  ffmpegNode({
    type: 'image.crop',
    category: 'edit-image',
    label: 'Crop image',
    keywords: ['crop', 'cut', 'trim', 'aspect', 'frame', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'mode', kind: 'select', options: ['pixels', 'aspect'], default: 'aspect', inline: true },
      { id: 'aspect', kind: 'select', options: ops.ASPECTS, default: '1:1', inline: true, showIf: { param: 'mode', equals: 'aspect' } },
      { id: 'anchor', kind: 'select', options: ops.ANCHORS, default: 'center', showIf: { param: 'mode', equals: 'aspect' } },
      { id: 'x', kind: 'integer', min: 0, default: 0, showIf: { param: 'mode', equals: 'pixels' } },
      { id: 'y', kind: 'integer', min: 0, default: 0, showIf: { param: 'mode', equals: 'pixels' } },
      { id: 'width', kind: 'integer', min: 0, default: 0, showIf: { param: 'mode', equals: 'pixels' } },
      { id: 'height', kind: 'integer', min: 0, default: 0, showIf: { param: 'mode', equals: 'pixels' } }
    ],
    collect: single('image'),
    build: (params, infos) => ops.buildCrop(params, infos),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.resize',
    category: 'edit-image',
    label: 'Resize image',
    keywords: ['resize', 'scale', 'lanczos', 'upscale', 'downscale', 'size', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'width', kind: 'integer', min: 0, max: 16384, default: 1024, inline: true },
      { id: 'height', kind: 'integer', min: 0, max: 16384, default: 0, inline: true },
      { id: 'fit', kind: 'select', options: ops.FIT_MODES, default: 'contain' },
      { id: 'background', kind: 'color', default: '#000000' },
      { id: 'transparent', kind: 'boolean', default: false }
    ],
    validate: (params) =>
      compact([
        params.width <= 0 && params.height <= 0 ? 'set a width or a height' : null,
        colorIssue(params.background, 'background')
      ]),
    collect: single('image'),
    build: (params) => ops.buildImageResize(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.adjust',
    category: 'edit-image',
    label: 'Adjust colours',
    keywords: ['brightness', 'contrast', 'saturation', 'gamma', 'hue', 'colour', 'color', 'grade', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: adjustParams(),
    collect: single('image'),
    build: (params) => ops.buildImageAdjust(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.levels',
    category: 'edit-image',
    label: 'Levels',
    keywords: ['levels', 'black point', 'white point', 'tone', 'histogram', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'in_black', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0 },
      { id: 'in_white', kind: 'slider', min: 0, max: 1, step: 0.01, default: 1 },
      { id: 'out_black', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0 },
      { id: 'out_white', kind: 'slider', min: 0, max: 1, step: 0.01, default: 1 }
    ],
    validate: (params) =>
      compact([
        params.in_black >= params.in_white ? 'in_black must be lower than in_white' : null,
        params.out_black >= params.out_white ? 'out_black must be lower than out_white' : null
      ]),
    collect: single('image'),
    build: (params) => ops.buildLevels(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.blur',
    category: 'edit-image',
    label: 'Blur',
    keywords: ['blur', 'gaussian', 'soften', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [{ id: 'radius', kind: 'slider', min: 0, max: 50, step: 0.5, default: 8, inline: true }],
    collect: single('image'),
    build: (params) => ops.buildBlur(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.sharpen',
    category: 'edit-image',
    label: 'Sharpen',
    keywords: ['sharpen', 'unsharp', 'detail', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [{ id: 'amount', kind: 'slider', min: 0, max: 3, step: 0.05, default: 1, inline: true }],
    collect: single('image'),
    build: (params) => ops.buildSharpen(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.invert',
    category: 'edit-image',
    label: 'Invert colours',
    keywords: ['invert', 'negative', 'negate', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [{ id: 'alpha', kind: 'boolean', default: false }],
    collect: single('image'),
    build: (params) => ops.buildInvert(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.transform',
    category: 'edit-image',
    label: 'Flip / rotate',
    keywords: ['flip', 'mirror', 'rotate', 'turn', 'transpose', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'flip', kind: 'select', options: ['none', 'h', 'v', 'both'], default: 'none', inline: true },
      { id: 'rotate', kind: 'select', options: ['0', '90', '180', '270'], default: '0', inline: true }
    ],
    collect: single('image'),
    build: (params) => ops.buildTransform(params),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.pad',
    category: 'edit-image',
    label: 'Pad canvas',
    keywords: ['pad', 'canvas', 'border', 'extend', 'letterbox', 'aspect', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'mode', kind: 'select', options: ['aspect', 'size'], default: 'aspect', inline: true },
      { id: 'aspect', kind: 'select', options: ops.ASPECTS, default: '16:9', inline: true, showIf: { param: 'mode', equals: 'aspect' } },
      { id: 'width', kind: 'integer', min: 0, max: 16384, default: 0, showIf: { param: 'mode', equals: 'size' } },
      { id: 'height', kind: 'integer', min: 0, max: 16384, default: 0, showIf: { param: 'mode', equals: 'size' } },
      { id: 'color', kind: 'color', default: '#000000' },
      { id: 'transparent', kind: 'boolean', default: false },
      { id: 'position', kind: 'select', options: ops.ANCHORS, default: 'center' }
    ],
    validate: (params) => compact([colorIssue(params.color)]),
    collect: single('image'),
    build: (params, infos) => ops.buildPad(params, infos),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.composite',
    category: 'edit-image',
    label: 'Composite layer',
    keywords: ['composite', 'overlay', 'layer', 'blend', 'multiply', 'screen', 'mask', 'merge', 'image', 'ffmpeg'],
    inputs: [
      { id: 'background', type: 'image', required: true },
      { id: 'layer', type: 'image', required: true },
      { id: 'mask', type: 'image' }
    ],
    outputs: IMAGE_OUT,
    params: [...positionParams(), { id: 'blend', kind: 'select', options: ops.BLEND_MODES, default: 'normal' }],
    collect: (inputs) => compact([inputs.background, inputs.layer, inputs.mask]),
    build: (params, infos) => ops.buildComposite(params, infos),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.mask_apply',
    category: 'edit-image',
    label: 'Apply mask',
    keywords: ['mask', 'alpha', 'cutout', 'transparent', 'matte', 'feather', 'image', 'ffmpeg'],
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'mask', type: 'image', required: true }
    ],
    outputs: IMAGE_OUT,
    params: [
      { id: 'invert', kind: 'boolean', default: false },
      { id: 'feather', kind: 'number', min: 0, max: 200, default: 0 }
    ],
    collect: (inputs) => [inputs.image, inputs.mask],
    build: (params, infos) => ops.buildMaskApply(params, infos),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'image.chroma_key',
    category: 'edit-image',
    label: 'Chroma key',
    keywords: ['chroma', 'key', 'green screen', 'greenscreen', 'colorkey', 'remove background', 'transparent', 'image', 'ffmpeg'],
    inputs: IMAGE_IN,
    outputs: [
      { id: 'image', type: 'image' },
      { id: 'mask', type: 'image' }
    ],
    params: [
      { id: 'color', kind: 'color', default: '#00ff00', inline: true },
      { id: 'similarity', kind: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.3 },
      { id: 'blend', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.1 }
    ],
    validate: (params) => compact([colorIssue(params.color)]),
    collect: single('image'),
    build: (params) => ops.buildChromaKey(params),
    outputIds: ['image', 'mask']
  })
];

/* ---------- video ops ---------- */

const videoDefinitions = [
  ffmpegNode({
    type: 'image.to_video',
    category: 'edit-video',
    // Local zoom over a still image, no AI. The name and the keywords deliberately leave out "image to video",
    // "animate" and "AI" (even as "no AI": a search for "ai" would find exactly this node), so that searches for an
    // AI video find the generators first. The type id stays for saved workflows.
    label: 'Still image zoom (local)',
    keywords: ['ken burns', 'zoom', 'pan', 'slideshow', 'still image', 'still', 'audio', 'video', 'ffmpeg'],
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'audio', type: 'audio' },
      { id: 'duration', type: 'number', param: 'duration' }
    ],
    outputs: VIDEO_OUT,
    params: [
      { id: 'duration', kind: 'number', min: 0.1, max: 600, default: 5, inline: true },
      { id: 'match_audio', kind: 'boolean', default: false },
      { id: 'fps', kind: 'integer', min: 1, max: 60, default: 30 },
      { id: 'zoom', kind: 'select', options: ['none', 'in', 'out'], default: 'none', inline: true }
    ],
    validate: (params, ports) =>
      params.match_audio && !ports.audio?.connected ? [{ level: 'warning', message: 'match_audio has no effect without a connected audio' }] : [],
    collect: (inputs) => compact([inputs.image, inputs.audio]),
    build: (params, infos, inputs) => ops.buildImageToVideo(params, infos, { duration: inputs.duration?.value }),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.extract_frame',
    category: 'edit-video',
    label: 'Extract frame',
    keywords: ['frame', 'still', 'thumbnail', 'last frame', 'first frame', 'grab', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: IMAGE_OUT,
    params: [
      { id: 'position', kind: 'select', options: ['first', 'middle', 'last', 'time'], default: 'last', inline: true },
      { id: 'time', kind: 'number', min: 0, default: 0, showIf: { param: 'position', equals: 'time' } }
    ],
    collect: single('video'),
    build: (params, infos) => ops.buildExtractFrame(params, infos),
    outputIds: ['image']
  }),
  ffmpegNode({
    type: 'video.trim',
    category: 'edit-video',
    label: 'Trim video',
    keywords: ['trim', 'cut', 'clip', 'start', 'end', 'shorten', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: VIDEO_OUT,
    params: [
      { id: 'start', kind: 'number', min: 0, default: 0, inline: true },
      { id: 'end', kind: 'number', min: 0, default: 0, inline: true },
      { id: 'accurate', kind: 'boolean', default: true }
    ],
    validate: (params) => (params.end > 0 && params.end <= params.start ? ['end must be greater than start'] : []),
    collect: single('video'),
    build: (params, infos) => ops.buildTrim(params, infos),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.resize',
    category: 'edit-video',
    label: 'Resize video',
    keywords: ['resize', 'scale', 'vertical', '9:16', 'crop', 'letterbox', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: VIDEO_OUT,
    params: [
      { id: 'width', kind: 'integer', min: 0, max: 7680, default: 1080, inline: true },
      { id: 'height', kind: 'integer', min: 0, max: 7680, default: 0, inline: true },
      { id: 'fit', kind: 'select', options: ops.FIT_MODES, default: 'contain' },
      { id: 'background', kind: 'color', default: '#000000' }
    ],
    validate: (params) =>
      compact([
        params.width <= 0 && params.height <= 0 ? 'set a width or a height' : null,
        colorIssue(params.background, 'background')
      ]),
    collect: single('video'),
    build: (params, infos) => ops.buildVideoResize(params, infos),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.adjust',
    category: 'edit-video',
    label: 'Adjust video colours',
    keywords: ['brightness', 'contrast', 'saturation', 'gamma', 'hue', 'colour', 'color', 'grade', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: VIDEO_OUT,
    params: adjustParams(),
    collect: single('video'),
    build: (params, infos) => ops.buildVideoAdjust(params, infos),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.speed',
    category: 'edit-video',
    label: 'Change speed',
    keywords: ['speed', 'slow motion', 'slowmo', 'fast', 'timelapse', 'tempo', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: VIDEO_OUT,
    params: [{ id: 'factor', kind: 'slider', min: 0.25, max: 4, step: 0.05, default: 1, inline: true }],
    collect: single('video'),
    build: (params, infos) => ops.buildSpeed(params, infos),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.overlay_image',
    category: 'edit-video',
    label: 'Overlay image on video',
    keywords: ['overlay', 'logo', 'watermark', 'title', 'image', 'sticker', 'video', 'ffmpeg'],
    inputs: [
      { id: 'video', type: 'video', required: true },
      { id: 'image', type: 'image', required: true }
    ],
    outputs: VIDEO_OUT,
    params: [
      ...positionParams(),
      { id: 'start', kind: 'number', min: 0, default: 0 },
      { id: 'end', kind: 'number', min: 0, default: 0 }
    ],
    validate: (params) => (params.end > 0 && params.end <= params.start ? ['end must be greater than start'] : []),
    collect: (inputs) => [inputs.video, inputs.image],
    build: (params, infos) => ops.buildOverlayImage(params, infos),
    outputIds: ['video']
  }),
  ffmpegNode({
    type: 'video.merge_audio',
    category: 'edit-video',
    label: 'Merge audio into video',
    keywords: ['audio', 'music', 'voice over', 'voiceover', 'mix', 'replace', 'sound', 'video', 'ffmpeg'],
    inputs: [
      { id: 'video', type: 'video', required: true },
      { id: 'audio', type: 'audio', required: true }
    ],
    outputs: VIDEO_OUT,
    params: [
      { id: 'mode', kind: 'select', options: ['replace', 'mix'], default: 'replace', inline: true },
      { id: 'audio_volume', kind: 'slider', min: 0, max: 4, step: 0.05, default: 1 },
      { id: 'video_volume', kind: 'slider', min: 0, max: 4, step: 0.05, default: 1, showIf: { param: 'mode', equals: 'mix' } },
      { id: 'length', kind: 'select', options: ['shortest', 'video'], default: 'video' }
    ],
    collect: (inputs) => [inputs.video, inputs.audio],
    build: (params, infos) => ops.buildMergeAudio(params, infos),
    outputIds: ['video']
  })
];

/* ---------- audio ops ---------- */

const audioDefinitions = [
  ffmpegNode({
    type: 'video.extract_audio',
    category: 'edit-audio',
    label: 'Extract audio',
    keywords: ['extract audio', 'audio track', 'sound', 'strip', 'm4a', 'aac', 'video', 'ffmpeg'],
    inputs: VIDEO_IN,
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [],
    collect: single('video'),
    build: (params, infos) => ops.buildExtractAudio(params, infos),
    outputIds: ['audio']
  }),
  ffmpegNode({
    type: 'audio.trim',
    category: 'edit-audio',
    label: 'Trim audio',
    keywords: ['trim', 'cut', 'fade', 'fade in', 'fade out', 'audio', 'ffmpeg'],
    inputs: [{ id: 'audio', type: 'audio', required: true }],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'start', kind: 'number', min: 0, default: 0, inline: true },
      { id: 'end', kind: 'number', min: 0, default: 0, inline: true },
      { id: 'fade_in', kind: 'number', min: 0, max: 60, default: 0 },
      { id: 'fade_out', kind: 'number', min: 0, max: 60, default: 0 }
    ],
    validate: (params) => (params.end > 0 && params.end <= params.start ? ['end must be greater than start'] : []),
    collect: single('audio'),
    build: (params, infos) => ops.buildAudioTrim(params, infos),
    outputIds: ['audio']
  }),
  ffmpegNode({
    type: 'audio.mix',
    category: 'edit-audio',
    label: 'Mix audio tracks',
    keywords: ['mix', 'combine', 'layer', 'music', 'voice', 'volume', 'audio', 'ffmpeg'],
    inputs: [{ id: 'tracks', type: 'audio', required: true, multiple: true, max: MAX_AUDIO_TRACKS }],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'volumes', kind: 'text', default: '', inline: true },
      { id: 'length', kind: 'select', options: ['longest', 'shortest', 'first'], default: 'longest' }
    ],
    validate: (params, ports) => {
      const issues = [];
      const count = ports.tracks?.count || 0;
      if (count < 2 || count > MAX_AUDIO_TRACKS) issues.push(`tracks: connect 2 to ${MAX_AUDIO_TRACKS} audio tracks`);
      try {
        ops.parseVolumes(params.volumes, Math.max(count, 1));
      } catch (err) {
        issues.push(err.message);
      }
      return issues;
    },
    collect: (inputs) => itemsOf(inputs, 'tracks'),
    build: (params, infos) => ops.buildAudioMix(params, infos),
    outputIds: ['audio']
  })
];

/* ---------- media.info ---------- */

const infoDefinition = {
  type: 'media.info',
  category: 'utility',
  label: 'Media info',
  keywords: ['info', 'duration', 'width', 'height', 'size', 'probe', 'length', 'metadata', 'ffprobe'],
  inputs: [{ id: 'media', type: 'any', required: true }],
  outputs: [
    { id: 'duration', type: 'number' },
    { id: 'width', type: 'number' },
    { id: 'height', type: 'number' }
  ],
  params: [],
  cost: { unit: 'local' },
  available: ffmpegAvailable,
  // Duration in seconds (0 for images), width and height in pixels (0 for audio).
  execute: async (ctx, inputs) => {
    const media = inputs.media;
    if (!['image', 'video', 'audio'].includes(media?.type)) throw new Error('media: connect an image, video or audio');
    const binaries = ffmpeg.binaries();
    if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
    const probe = await ctx.withLocalSlot(() =>
      ops.probeMedia(assets.assetFilePath(media), { ffprobePath: binaries.ffprobe, signal: ctx.signal })
    );
    const duration = media.type === 'image' ? 0 : Math.round((probe.duration || 0) * 1000) / 1000;
    return {
      variants: [
        {
          duration: numberValue(duration),
          width: numberValue(probe.video?.width || 0),
          height: numberValue(probe.video?.height || 0)
        }
      ]
    };
  }
};

/* ---------- resvg nodes ---------- */

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

// resvg resolves absolute file paths in href / url(): only inline data and in-document references are allowed,
// so a text-driven SVG cannot pull other images from the server's disk into the render.
function checkSvgSafe(svg) {
  if (!/<svg[\s>]/i.test(svg)) throw new Error('svg: the text is not an SVG document');
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error('svg: the document is larger than 2 MB');
  assertNoExternalReferences(svg);
}

// Greedy word wrap on an estimated glyph width (resvg does not wrap text).
function wrapText(text, maxChars) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.slice(0, MAX_TEXT_LINES);
}

// SVG document for image.text_render. height 0 = fit to the text.
function buildTextSvg(params) {
  const fontSize = Math.max(4, Math.round(Number(params.font_size) || 96));
  const width = Math.max(16, Math.round(Number(params.width) || 1024));
  const weight = ['400', '600', '800'].includes(String(params.font_weight)) ? String(params.font_weight) : '600';
  const lineFactor = Math.max(0.5, Number(params.line_height) || 1.2);
  const margin = Math.round(fontSize * 0.3);
  const glyph = fontSize * (weight === '400' ? 0.55 : 0.6);
  const maxChars = Math.max(1, Math.floor((width - 2 * margin) / glyph));
  const lines = wrapText(params.text, maxChars);
  const lineHeight = fontSize * lineFactor;
  const blockHeight = lines.length * lineHeight;
  const height = Number(params.height) > 0 ? Math.round(Number(params.height)) : Math.max(16, Math.ceil(blockHeight + 2 * margin));
  if (height > MAX_RASTER_EDGE || width * height > MAX_RASTER_PIXELS) {
    throw new Error('text: the rendered image would be too large; use a smaller font size or a shorter text');
  }
  const top = Number(params.height) > 0 ? (height - blockHeight) / 2 : margin;
  const align = ['left', 'center', 'right'].includes(params.align) ? params.align : 'center';
  const x = align === 'left' ? margin : align === 'right' ? width - margin : width / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const color = ops.svgColor(params.color, '#ffffff');
  const family = String(params.font_family || 'Helvetica').replace(/[^A-Za-z0-9 ,_'-]/g, '').trim() || 'Helvetica';
  const texts = lines
    .map((line, index) => {
      if (!line) return '';
      const y = top + index * lineHeight + lineHeight / 2 + fontSize * 0.35;
      return `<text x="${ops.num(x)}" y="${ops.num(y)}">${escapeXml(line)}</text>`;
    })
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g font-family="${escapeXml(`${family}, sans-serif`)}" font-size="${fontSize}" font-weight="${weight}" ` +
    `fill="${color.rgb}" fill-opacity="${color.alpha}" text-anchor="${anchor}">${texts}</g></svg>`;
  return { svg, width, height, lines: lines.length };
}

// Renders an SVG string to a PNG buffer with resvg (system fonts loaded).
function renderSvg(svg, { width } = {}) {
  const resvg = loadResvg();
  if (!resvg) throw new Error('@resvg/resvg-js is not installed');
  let renderer;
  try {
    renderer = new resvg.Resvg(svg, {
      fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
      font: { loadSystemFonts: true }
    });
  } catch (err) {
    throw new Error(`svg: could not be parsed (${String(err.message || err).slice(0, 200)})`);
  }
  if (width && renderer.width > 0) {
    const height = Math.round((renderer.height * width) / renderer.width);
    if (height > MAX_RASTER_EDGE || width * height > MAX_RASTER_PIXELS) {
      throw new Error('svg: the rendered image would be too large; use a smaller width');
    }
  }
  const rendered = renderer.render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
}

async function saveRenderedPng(ctx, png, prompt) {
  const scratch = await assets.createScratchDir(ctx.sessionId);
  try {
    const file = path.join(scratch, 'render.png');
    await fsp.writeFile(file, png);
    return await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt, cost: 0 });
  } finally {
    await assets.removeScratchDir(scratch);
  }
}

const resvgDefinitions = [
  {
    type: 'image.svg_rasterize',
    category: 'image',
    label: 'Rasterize SVG',
    keywords: ['svg', 'vector', 'rasterize', 'render', 'png', 'logo', 'resvg', 'image'],
    inputs: [{ id: 'svg', type: 'text', required: true, suggest: 'llm.chat' }],
    outputs: IMAGE_OUT,
    params: [{ id: 'width', kind: 'integer', min: 16, max: 8192, default: 1024, inline: true }],
    cost: { unit: 'local' },
    available: resvgAvailable,
    execute: async (ctx, inputs, params) => {
      const svg = stripCodeFence(inputs.svg.value);
      checkSvgSafe(svg);
      const { png } = renderSvg(svg, { width: params.width });
      return { variants: [{ image: await saveRenderedPng(ctx, png, 'Rasterized SVG') }] };
    }
  },
  {
    type: 'image.text_render',
    category: 'image',
    label: 'Render text',
    keywords: ['text', 'title', 'typography', 'font', 'caption', 'transparent', 'png', 'resvg', 'image'],
    inputs: [{ id: 'text', type: 'text', required: true, param: 'text' }],
    outputs: IMAGE_OUT,
    params: [
      { id: 'text', kind: 'textarea', default: '', inline: true },
      { id: 'font_family', kind: 'text', default: 'Helvetica' },
      { id: 'font_size', kind: 'integer', min: 4, max: 1000, default: 96 },
      { id: 'font_weight', kind: 'select', options: ['400', '600', '800'], default: '600' },
      { id: 'color', kind: 'color', default: '#ffffff' },
      { id: 'width', kind: 'integer', min: 16, max: 8192, default: 1024 },
      { id: 'height', kind: 'integer', min: 0, max: 8192, default: 0 },
      { id: 'align', kind: 'select', options: ['left', 'center', 'right'], default: 'center' },
      { id: 'line_height', kind: 'number', min: 0.5, max: 4, default: 1.2 }
    ],
    cost: { unit: 'local' },
    available: resvgAvailable,
    validate: (params) => compact([colorIssue(params.color)]),
    execute: async (ctx, inputs, params) => {
      const text = inputs.text.value;
      if (!text.trim()) throw new Error('text: nothing to render');
      const { svg } = buildTextSvg({ ...params, text });
      const { png } = renderSvg(svg);
      return { variants: [{ image: await saveRenderedPng(ctx, png, `Text: ${text.trim().slice(0, 60)}`) }] };
    }
  }
];

const definitions = [...imageDefinitions, ...videoDefinitions, ...audioDefinitions, infoDefinition, ...resvgDefinitions];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  runOp,
  checkSvgSafe,
  stripCodeFence,
  wrapText,
  buildTextSvg,
  renderSvg,
  escapeXml
};
