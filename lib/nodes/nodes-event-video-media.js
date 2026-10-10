'use strict';

// Scalar input: the engine expands a media list and preserves completed items on API failure.
const assets = require('./assets');
const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
const { textValue } = require('./types');
const { analyzeMedia } = require('../event-video/analyze');
const { DEFAULT_MODEL } = require('../event-video/vision');

// The estimate: USD 0.006 for vision plus USD 0.22/hour for speech, before the candidate gate.
const VISION_ESTIMATE_USD = 0.006;
// The speech estimate in USD per source hour.
const SPEECH_USD_PER_HOUR = 0.22;
// Convert source seconds to hours for the speech estimate.
const SECONDS_PER_HOUR = 3600;
// Allow 30 minutes (ms) for local analysis and both remote providers.
const ANALYZE_TIMEOUT_MS = 30 * 60 * 1000;
// A fixed 1 x 1 px PNG preserves the image output slot without inventing keyframes.
const EMPTY_SHEET_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// An unusable item still has a sheet slot, so mixed lists retain per-item cache alignment.
async function emptySheet(ctx) {
  const scratch = await assets.createScratchDir(ctx.sessionId);
  try {
    const file = path.join(scratch, 'empty.png');
    await fs.writeFile(file, Buffer.from(EMPTY_SHEET_BASE64, 'base64'));
    return await ctx.saveOutputFile({
      kind: 'image',
      ext: '.png',
      sourceFile: file,
      prompt: 'Unusable event media: no keyframes',
      cost: 0
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// Scalar media node; implicit list mapping belongs to the engine so successful items survive retries.
const analyzeDefinition = {
  type: 'event_video.analyze',
  category: 'utility',
  label: 'Analyze event media',
  description:
    'Analyze one photo or video: quality, scenes, faces, visible subjects and speech. HEIC photos must be exported as JPEG or PNG.',
  inputs: [{ id: 'media', type: 'any', required: true }],
  outputs: [
    { id: 'info', type: 'text' },
    { id: 'sheet', type: 'image' }
  ],
  params: [
    { id: 'vision_model', kind: 'select', optionsSource: 'brain-models', default: DEFAULT_MODEL },
    { id: 'speech', kind: 'select', options: ['auto', 'off'], default: 'auto' }
  ],
  paid: true,
  cost: {
    unit: 'usd',
    history: false,
    // Estimate USD from source duration in seconds; the speech gate may avoid that part of the cost.
    estimate: (params, context) => {
      const media = context?.inputs?.media;
      return (
        VISION_ESTIMATE_USD +
        (params.speech !== 'off' && media?.type === 'video' ? ((media.duration || 0) / SECONDS_PER_HOUR) * SPEECH_USD_PER_HOUR : 0)
      );
    }
  },
  timeoutMs: ANALYZE_TIMEOUT_MS,
  // Disable the node when local probing or decoding is unavailable.
  available: () => (ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found'),
  // Reject cross-workflow assets, then return v1 JSON and an aligned sheet slot with booked cost.
  execute: async (ctx, inputs, params) => {
    const media = inputs.media;
    if (media.sessionId !== ctx.sessionId) throw new Error('Media belongs to another workflow');
    if (!['image', 'video'].includes(media.type)) {
      const info = {
        version: 1,
        id: String(media.assetId || 'unsupported'),
        kind: 'video',
        usable: false,
        reason: 'unsupported_format',
        meta: null,
        scenes: [],
        speech: null,
        vision: null
      };
      return { variants: [{ info: textValue(JSON.stringify(info)), sheet: await emptySheet(ctx) }], cost: { usd: 0 } };
    }
    const info = await analyzeMedia({ ...ctx, assetId: media.assetId }, assets.assetFilePath(media), {
      kind: media.type === 'image' ? 'photo' : 'video',
      visionModel: params.vision_model || DEFAULT_MODEL,
      speech: params.speech || 'auto'
    });
    return {
      variants: [{ info: textValue(JSON.stringify(info)), sheet: info.sheet || (await emptySheet(ctx)) }],
      cost: info.cost || { usd: 0 }
    };
  }
};
// Registration list consumed by the shared node registry.
const definitions = [analyzeDefinition];
// Register the analyser through the same entry point as other node modules.
function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}
module.exports = { definitions, registerAll };
