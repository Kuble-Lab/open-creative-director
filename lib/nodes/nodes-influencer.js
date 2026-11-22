'use strict';

const fsp = require('fs/promises');
const path = require('path');
const influencers = require('../influencers');
const access = require('../access');
const assets = require('./assets');
const { textValue, listValue, sha256Hex, canonicalJson } = require('./types');

const OUTPUTS = ['figure', 'images', 'voice', 'voice_description', 'style'];

async function readChosen(params, ctx) {
  const chosen = String(params.influencer || '').trim();
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  try {
    const id = await influencers.resolveInfluencerId(chosen, { viewer });
    return await influencers.readVisibleInfluencer(id, viewer);
  } catch (err) {
    if (err.code === 'INFLUENCER_NOT_FOUND') {
      throw Object.assign(new Error(`The influencer "${chosen}" does not exist for your account (it was deleted, belongs to somebody else or is no longer shared). Choose one of your own, create one in the chat view under «Influencer», or choose none.`), { code: 'INFLUENCER_NOT_FOUND' });
    }
    throw err;
  }
}

function textOutputs(influencer) {
  const fields = { figure: influencers.figureText(influencer), voice: influencer.voice?.voiceId,
    voice_description: influencer.voice?.description, style: influencer.style };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, textValue(value)]));
}

async function cacheStamp(params, ctx) {
  if (!String(params.influencer || '').trim()) return undefined;
  let influencer;
  try { influencer = await readChosen(params, ctx); } catch (err) {
    if (err.code === 'INFLUENCER_NOT_FOUND') return { missing: String(params.influencer).trim() };
    throw err;
  }
  return { outputs: textOutputs(influencer), images: await Promise.all(influencer.images.map(async (file) => sha256Hex(await influencers.readInfluencerAsset(influencer.id, file)))) };
}

// Images count by their bytes: an asset an earlier run of this node saved with the same bytes is the same reference
// (like the logo of input.branding), so a text-only edit keeps the keys of the image nodes after it.
async function heldImages(ctx) {
  const values = (ctx.earlierVariants ? ctx.earlierVariants() : []).flatMap((variant) => variant?.images?.items || []);
  const found = new Map();
  const tried = new Set();
  for (const value of values) {
    if (value.sessionId !== ctx.sessionId || tried.has(value.assetId)) continue;
    tried.add(value.assetId);
    try {
      const current = await assets.valueFromAsset(ctx.sessionId, value.assetId);
      const hash = sha256Hex(await fsp.readFile(assets.assetFilePath(current)));
      if (!found.has(hash)) found.set(hash, current);
    } catch (_) {
      // Deleted files cannot serve as references; execution will save them again.
    }
  }
  return found;
}

async function cacheStampAdopts(entry, { stamp }) {
  const variant = entry?.variants?.[0];
  if (!variant || stamp.missing) return false;
  const { images, ...outputs } = variant;
  try {
    const hashes = await Promise.all((images?.items || []).map(async (value) => sha256Hex(await fsp.readFile(assets.assetFilePath(value)))));
    return canonicalJson({ outputs, images: hashes }) === canonicalJson(stamp);
  } catch (_) { return false; }
}

async function cacheStampOutputs(stamp, { ctx, nodeResults }) {
  if (!stamp || stamp.missing) return null;
  const held = await heldImages({ ...ctx, earlierVariants: () => (nodeResults?.history || []).slice(0, 50).flatMap((entry) => entry.variants || []) });
  const outputs = { ...stamp.outputs };
  if (stamp.images.every((hash) => held.has(hash))) {
    if (stamp.images.length) outputs.images = listValue('image', stamp.images.map((hash) => held.get(hash)));
    return { outputs, unknown: [] };
  }
  return { outputs, unknown: ['images'] };
}

const definition = {
  type: 'input.influencer', category: 'input', label: 'Influencer',
  keywords: ['influencer', 'character', 'figure', 'persona', 'avatar', 'singer', 'voice', 'reference images'],
  description: 'Gives a saved influencer to the next nodes: the figure text, reference images in their saved order, voice ID, voice description and style. Without a selection all outputs stay empty. Changed text or images refresh the node; unchanged images keep their workflow assets.',
  inputs: [],
  outputs: OUTPUTS.map((id) => ({ id, type: id === 'images' ? 'image[]' : 'text' })),
  params: [{ id: 'influencer', kind: 'select', optionsSource: 'influencers', default: '', inline: true }],
  cost: { unit: 'local' },
  emptyOutputs: (params) => String(params.influencer || '').trim() ? [] : OUTPUTS.slice(),
  emptyOutputsSwitched: true,
  cacheStamp, cacheStampAdopts, cacheStampOutputs,
  execute: async (ctx, _inputs, params) => {
    if (!String(params.influencer || '').trim()) {
      ctx.log('No influencer chosen');
      return { variants: [{}] };
    }
    const influencer = await readChosen(params, ctx);
    const variant = textOutputs(influencer);
    const held = await heldImages(ctx);
    const images = [];
    for (const file of influencer.images) {
      const buffer = await influencers.readInfluencerAsset(influencer.id, file);
      const hash = sha256Hex(buffer);
      let value = held.get(hash);
      if (!value) {
        const scratch = await assets.createScratchDir(ctx.sessionId);
        try {
          const ext = path.extname(file).toLowerCase().replace('.jpeg', '.jpg');
          const target = path.join(scratch, `reference${ext}`);
          await fsp.writeFile(target, buffer);
          value = await ctx.saveOutputFile({ kind: 'image', ext, sourceFile: target, prompt: `Influencer reference: ${influencer.name} [${hash}]`, cost: 0 });
          held.set(hash, value);
        } finally { await assets.removeScratchDir(scratch); }
      }
      images.push(value);
    }
    if (images.length) variant.images = listValue('image', images);
    return { variants: [variant] };
  }
};

module.exports = { definitions: [definition], registerAll: (registry) => registry.register(definition) };
