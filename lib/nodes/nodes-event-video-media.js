'use strict';

// Scalar input: the engine expands a media list and preserves completed items on API failure.
const assets = require('./assets');
const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
const { textValue } = require('./types');
const { analyzeMedia } = require('../event-video/analyze');
const { DEFAULT_MODEL } = require('../event-video/vision');

// An unusable item still has a sheet slot, so mixed lists retain per-item cache alignment.
async function emptySheet(ctx) {
  const scratch = await assets.createScratchDir(ctx.sessionId);
  try {
    const file = path.join(scratch, 'empty.png');
    await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    return await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt: 'Unusable event media: no keyframes', cost: 0 });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

const analyzeDefinition = {
  type: 'event_video.analyze', category: 'utility', label: 'Analyze event media',
  description: 'Analyze one photo or video: quality, scenes, faces, visible subjects and speech. HEIC photos must be exported as JPEG or PNG.',
  inputs: [{ id: 'media', type: 'any', required: true }],
  outputs: [{ id: 'info', type: 'text' }, { id: 'sheet', type: 'image' }],
  params: [{ id: 'vision_model', kind: 'select', optionsSource: 'brain-models', default: DEFAULT_MODEL },
    { id: 'speech', kind: 'select', options: ['auto', 'off'], default: 'auto' }],
  paid: true, cost: { unit: 'usd', history: false, estimate: (params, context) => {
    const media = context?.inputs?.media;
    return 0.006 + (params.speech !== 'off' && media?.type === 'video' ? (media.duration || 0) / 3600 * 0.22 : 0);
  } },
  timeoutMs: 30 * 60 * 1000,
  available: () => ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found',
  execute: async (ctx, inputs, params) => {
    const media = inputs.media;
    if (media.sessionId !== ctx.sessionId) throw new Error('Media belongs to another workflow');
    if (!['image', 'video'].includes(media.type)) {
      const info = { version: 1, id: String(media.assetId || 'unsupported'), kind: 'video', usable: false,
        reason: 'unsupported_format', meta: null, scenes: [], speech: null, vision: null };
      return { variants: [{ info: textValue(JSON.stringify(info)), sheet: await emptySheet(ctx) }], cost: { usd: 0 } };
    }
    const info = await analyzeMedia({ ...ctx, assetId: media.assetId }, assets.assetFilePath(media),
      { kind: media.type === 'image' ? 'photo' : 'video', visionModel: params.vision_model || DEFAULT_MODEL, speech: params.speech || 'auto' });
    return { variants: [{ info: textValue(JSON.stringify(info)), sheet: info.sheet || await emptySheet(ctx) }], cost: info.cost || { usd: 0 } };
  }
};
const definitions = [analyzeDefinition];
function registerAll(registry) { for (const definition of definitions) registry.register(definition); }
module.exports = { definitions, registerAll };
