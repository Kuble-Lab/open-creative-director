'use strict';

// The Composer node (image.composer): a free stage like the compositor of Weavy. Images from earlier nodes, texts and shapes are layers
// that a person moves, scales, turns and orders with the mouse in the editor of the node view (public/nodes/composer-ui.js); the
// layers are a param (kind `composition`, public/nodes/composer-model.js), so the same picture is made again by a run, a template or
// the agent access. The picture is drawn here, locally and for free: lib/composer-render.js (text as paths with fontkit, resvg).

const fsp = require('fs/promises');
const path = require('path');

const access = require('../access');
const brandings = require('../brandings');
const composer = require('../composer-render');
const ffmpeg = require('../ffmpeg');
const { readExif, orientationFilters } = require('../event-video/exif');
const model = require('../../public/nodes/composer-model');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const { sha256Hex } = require('./types');

// Images larger than this many times the long edge of the stage are made smaller before they are drawn (they are never shown larger)
const IMAGE_OVERSIZE = 2;
const DIRECT_EXT = new Set(['.png', '.jpg', '.jpeg']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const FONT_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MAX_BRAND_FONTS = 8;
const MAX_BRAND_FONT_BYTES = 8 * 1024 * 1024;

function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

function textOf(inputs, portId) {
  const value = inputs[portId];
  return value && value.type === 'text' && typeof value.value === 'string' ? value.value : '';
}

// The images the visible layers show, as data URLs (index = number at the input). A JPEG with an EXIF turn, a format resvg does not
// read (WebP, GIF, AVIF ...) and an image far larger than the stage go through ffmpeg into a PNG first.
async function prepareImages(ctx, values, layers, canvas) {
  const used = new Set(layers.filter((layer) => layer.type === 'image' && !layer.hidden).map((layer) => layer.input));
  const out = [];
  let scratch = null;
  try {
    for (let index = 0; index < values.length; index += 1) {
      if (!used.has(index)) {
        out.push({ href: '', unused: true });
        continue;
      }
      const file = assets.assetFilePath(values[index]);
      if (!file) throw new Error(`images: image ${index + 1} has no file`);
      const ext = path.extname(file).toLowerCase();
      const binaries = ffmpeg.binaries();
      let probe = null;
      if (binaries.available) probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal }).catch(() => null);
      const exif = ext === '.jpg' || ext === '.jpeg' ? await readExif(file).catch(() => ({ orientation: 1 })) : { orientation: 1 };
      const longEdge = Math.max(canvas.width, canvas.height) * IMAGE_OVERSIZE;
      const tooLarge = probe && probe.video && Math.max(probe.video.width || 0, probe.video.height || 0) > longEdge;
      const direct = DIRECT_EXT.has(ext) && (exif.orientation || 1) === 1 && !tooLarge;
      if (direct) {
        out.push({ href: `data:${MIME[ext]};base64,${(await fsp.readFile(file)).toString('base64')}` });
        continue;
      }
      if (!binaries.available) throw new Error(`images: image ${index + 1} (${ext || 'unknown format'}) needs ffmpeg to be read`);
      if (!scratch) scratch = await assets.createScratchDir(ctx.sessionId);
      const target = path.join(scratch, `image-${index}.png`);
      const filters = [...orientationFilters(exif.orientation), 'sidedata=mode=delete'];
      if (tooLarge) filters.push(`scale=w=min(${longEdge}\\,iw):h=min(${longEdge}\\,ih):force_original_aspect_ratio=decrease`);
      await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-noautorotate', '-i', file, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', target], {
        timeoutMs: 120000,
        signal: ctx.signal
      });
      out.push({ href: `data:image/png;base64,${(await fsp.readFile(target)).toString('base64')}` });
    }
  } finally {
    if (scratch) await assets.removeScratchDir(scratch);
  }
  return out;
}

// The font files of the brand the layers ask for ({ family, weight, buffer, file }), from the branding of the app and only where the
// person running may see it. A file that cannot be read is said in the log; the text is then drawn with a font of the app.
async function brandFontFiles(ctx, profile, layers, log) {
  const wanted = new Set(layers.filter((layer) => layer.type === 'text' && !layer.hidden).map((layer) => layer.font.toLowerCase()));
  const fonts = model.brandFonts(profile).filter((font) => wanted.has(font.family.toLowerCase()) && FONT_EXT.has(path.extname(font.file).toLowerCase()));
  if (!fonts.length) return [];
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  const found = [];
  for (const font of fonts.slice(0, MAX_BRAND_FONTS)) {
    try {
      const id = await brandings.resolveBrandingId(font.branding, { viewer });
      const buffer = await brandings.readBrandingAsset(id, font.file);
      if (buffer.length > MAX_BRAND_FONT_BYTES) throw new Error('the file is larger than 8 MB');
      found.push({ family: font.family, weight: font.weight, buffer, file: font.file });
    } catch (err) {
      log(`The font file ${font.file} could not be read (${String(err.message || err).slice(0, 100)}): a font of the app is used for ${font.family}`);
    }
  }
  return found;
}

// The stamp of a run: the brand font files it would draw with. The profile only names them; a file replaced under its name must make
// the picture again. Nothing without a brand.
async function cacheStamp(params, ctx) {
  const profile = model.parseProfile(textOf(ctx.inputs || {}, 'brand'));
  if (!profile) return undefined;
  const layers = model.normalizeComposition(params.layers).layers;
  const wanted = new Set(layers.filter((layer) => layer.type === 'text').map((layer) => layer.font.toLowerCase()));
  const fonts = model.brandFonts(profile).filter((font) => wanted.has(font.family.toLowerCase()));
  if (!fonts.length) return undefined;
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  const files = [];
  for (const font of fonts.slice(0, MAX_BRAND_FONTS)) {
    let hash = null;
    try {
      const id = await brandings.resolveBrandingId(font.branding, { viewer });
      hash = sha256Hex(await brandings.readBrandingAsset(id, font.file));
    } catch (_) {
      hash = null;
    }
    files.push({ branding: font.branding, file: font.file, hash });
  }
  return { fonts: files };
}

const definition = {
  type: 'image.composer',
  category: 'edit-image',
  label: 'Composer',
  keywords: ['composer', 'compose', 'layout', 'poster', 'thumbnail', 'social post', 'collage', 'canvas', 'typography', 'design', 'arrange', 'free'],
  description:
    'A free stage: images from earlier nodes, texts and shapes are layers that are moved, scaled, turned and ordered in the editor of the node; the result is one finished image (PNG). ' +
    'The layers are the param "layers". ' +
    model.AGENT_FORMAT,
  inputs: [
    { id: 'images', type: 'image', multiple: true, max: model.LIMITS.images },
    { id: 'texts', type: 'text', multiple: true, max: model.LIMITS.texts },
    { id: 'brand', type: 'text' }
  ],
  outputs: [{ id: 'image', type: 'image' }],
  params: [
    { id: 'layers', kind: 'composition', default: { layers: [] }, inline: true },
    { id: 'format', kind: 'select', options: model.FORMAT_OPTIONS.slice(), default: model.DEFAULT_FORMAT, inline: true },
    { id: 'short_edge', kind: 'integer', options: model.SHORT_EDGES.slice(), default: model.DEFAULT_SHORT_EDGE, showIf: { param: 'format', in: Object.keys(model.FORMATS) } },
    { id: 'width', kind: 'integer', min: model.LIMITS.minEdge, max: model.LIMITS.maxEdge, default: 1080, showIf: { param: 'format', equals: 'custom' } },
    { id: 'height', kind: 'integer', min: model.LIMITS.minEdge, max: model.LIMITS.maxEdge, default: 1080, showIf: { param: 'format', equals: 'custom' } },
    { id: 'transparent', kind: 'boolean', default: false },
    { id: 'background', kind: 'color', default: '#ffffff', showIf: { param: 'transparent', equals: false } }
  ],
  cost: { unit: 'local' },
  available: composer.available,
  validate: (params) => {
    const issues = [];
    if (!model.normalizeComposition(params.layers).layers.length) {
      issues.push({ code: 'composer_empty', message: 'layers: the stage has no layers yet. Open the Composer and add images, texts or shapes' });
    }
    if (!params.transparent && !model.hexColor(params.background)) issues.push('background: use a hex colour like #ffffff');
    return issues;
  },
  cacheStamp,
  execute: async (ctx, inputs, params) => {
    const log = (line) => ctx.log?.(line);
    const canvas = model.canvasSize(params);
    const { layers } = model.normalizeComposition(params.layers);
    const images = await prepareImages(ctx, itemsOf(inputs, 'images'), layers, canvas);
    const texts = itemsOf(inputs, 'texts').map((value) => (value && typeof value.value === 'string' ? value.value : ''));
    const profile = model.parseProfile(textOf(inputs, 'brand'));
    const brand = profile ? await brandFontFiles(ctx, profile, layers, log) : [];
    for (const layer of layers) {
      if (layer.type === 'text' && Number.isInteger(layer.text_input) && layer.text_input >= texts.length) {
        log(`The text layer ${layer.name || JSON.stringify(layer.text.slice(0, 30))} takes text ${layer.text_input + 1}, but only ${texts.length} ${texts.length === 1 ? 'text is' : 'texts are'} connected: its own text is shown`);
      }
    }
    const { png, width, height } = await ctx.withLocalSlot(async () => {
      const fonts = composer.createFontStore({ brand, log });
      return composer.render({
        canvas,
        background: params.background,
        transparent: params.transparent === true,
        layers,
        images: images.map((image) => (image.unused ? null : image)),
        texts,
        fonts,
        log
      });
    });
    log(`${layers.length} ${layers.length === 1 ? 'layer' : 'layers'} on ${width} x ${height} px`);
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const file = path.join(scratch, 'composer.png');
      await fsp.writeFile(file, png);
      const image = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt: 'Composer', cost: 0 });
      return { variants: [{ image }] };
    } finally {
      await assets.removeScratchDir(scratch);
    }
  }
};

const definitions = [definition];

function registerAll(registry) {
  for (const def of definitions) registry.register(def);
}

module.exports = { definitions, registerAll, prepareImages, cacheStamp };
