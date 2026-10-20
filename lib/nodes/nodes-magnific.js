'use strict';

const magnific = require('../magnific');
const catalog = require('./magnific-catalog');
const tools = require('../tools');
const assets = require('./assets');
function registerAll(registry) {
  registry.register({
    type: 'magnific.upscale_image', category: 'magnific', provider: 'magnific', label: 'Magnific Upscale',
    description: 'Upscale a session image using the connected Magnific account. Billed in Magnific credits.',
    keywords: ['magnific', 'upscale', 'resolution', 'image'],
    inputs: [{ id: 'image', type: 'image', required: true }], outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'mode', kind: 'select', optionsSource: 'magnific-upscale-modes', noDefaultEntry: true, default: 'creative' },
      { id: 'scale_factor', kind: 'select', optionsSource: 'magnific-upscale-scales', noDefaultEntry: true, default: '2' }
    ],
    paid: true, async: true, timeoutMs: 11 * 60 * 1000, cost: { unit: 'credits', history: false, estimate: catalog.estimate },
    available: () => magnific.status().connected ? true : 'Magnific is not connected', prepare: catalog.prepare, validate: catalog.validate, cacheStamp: catalog.prepareEstimate,
    execute: async (ctx, inputs, params) => {
      if (inputs.image?.sessionId !== ctx.sessionId) throw new Error('Magnific requires an image from this session.');
      const result = await tools.executeTool(ctx.toolCtx, 'magnific_upscale_image', { asset_id: inputs.image.assetId, mode: params.mode, scale: Number(params.scale_factor) });
      const ids = await ctx.waitForJob(result.job);
      const values = await Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
      return { variants: values.map((value) => ({ image: value })), cost: result.job.credits === null ? undefined : { credits: result.job.credits } };
    }
  });
}
module.exports = { registerAll };
