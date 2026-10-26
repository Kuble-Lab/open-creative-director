'use strict';

const magnific = require('../magnific');
const api = require('../tools/magnific');
// Snapshot of images_upscale_modes_list (2026-10-22). Used when the live answer cannot be read.
const FALLBACK = [
  { value: 'creative', label: 'Magnific Creative', scales: [2, 4, 8, 16] },
  { value: 'ultra-sublime', label: 'Magnific Precision (sublime)', scales: [2, 4, 8, 16] },
  { value: 'ultra-photo', label: 'Magnific Precision (photo)', scales: [2] },
  { value: 'ultra-denoiser', label: 'Magnific Precision (photo denoiser)', scales: [2] },
  { value: 'ultra', label: 'Magnific Precision v1 (high HDR)', scales: [2] }
];
let modes = FALLBACK;
let expiresAt = 0;
const estimates = new Map();
function reset() { modes = FALLBACK; expiresAt = 0; estimates.clear(); api.clearUploads(); }
const scalesOf = (o) => (o.params?.scale?.enum || o.scales || o.scale_factors || []).map((v) => Number(String(v).replace(/x$/i, ''))).filter((n) => Number.isInteger(n) && n >= 2 && n <= 16);
async function load() {
  const status = magnific.status();
  if (!status.connected) { reset(); return FALLBACK; }
  if (Date.now() < expiresAt) return modes;
  let found = [];
  try {
    const result = await api.checkedCall('images_upscale_modes_list', {});
    found = (Array.isArray(result?.modes) ? result.modes : []).filter((o) => typeof (o.id || o.mode) === 'string' && scalesOf(o).length)
      .map((o) => ({ value: o.id || o.mode, label: o.name || o.label || o.id || o.mode, scales: scalesOf(o) }));
  } catch (_) { /* keep the snapshot */ }
  modes = found.length ? found : FALLBACK;
  expiresAt = Date.now() + 60 * 60 * 1000;
  return modes;
}
function check(mode, scale) {
  const spec = modes.find((m) => m.value === mode);
  if (!spec || !spec.scales.includes(scale)) throw new Error('Magnific: unsupported upscale mode or scale.');
}
function validate(params) {
  try { check(params.mode, Number(params.scale_factor ?? params.scale)); return []; }
  catch (_) { return [{ code: 'magnific_settings', message: 'Select a supported Magnific mode and scale factor.' }]; }
}
async function prepare(params) { await load(); check(params.mode, Number(params.scale_factor ?? params.scale)); }

// Plans with an available input use the real uploaded creation to simulate the exact call (simulate_cost is free).
// Uploads and estimates are cached, and unauthorised viewers are refused before any upload. Inputs produced later keep an
// unknown plan price. build(params, creationId, extra) returns { tool, args } for the node.
function estimator(port, build, extraPorts = []) {
  const key = (params, ctx) => JSON.stringify([build.name, params, ...[port, ...extraPorts].map((p) => [ctx.inputs?.[p]?.sessionId, ctx.inputs?.[p]?.assetId])]);
  async function prepareEstimate(params, ctx) {
    const access = require('../access');
    const viewer = access.viewerOf({ kubleUser: ctx.user });
    if (!access.magnificAllowed(viewer) || !magnific.status().connected) return;
    const input = ctx.inputs?.[port];
    if (!input?.assetId || input.sessionId !== ctx.sessionId) return;
    const cacheKey = key(params, ctx);
    if (estimates.get(cacheKey)?.expiresAt > Date.now()) return;
    const uploaded = await api.uploadAsset(ctx, input.assetId);
    const extra = {};
    for (const p of extraPorts) {
      const value = ctx.inputs?.[p];
      if (value?.assetId && value.sessionId === ctx.sessionId) extra[p] = (await api.uploadAsset(ctx, value.assetId)).creationId;
    }
    const { tool, args } = await build(params, uploaded.creationId, extra);
    const credits = api.creditsOf(await api.estimate(tool, args));
    estimates.set(cacheKey, { credits, expiresAt: Date.now() + 60000 });
  }
  function estimate(params, ctx = {}) {
    const cached = estimates.get(key(params, ctx));
    return cached?.expiresAt > Date.now() && cached.credits !== null ? { credits: cached.credits } : null;
  }
  return { prepareEstimate, estimate };
}
const upscale = estimator('image', async function upscale(params, creationId) {
  return { tool: 'images_upscale', args: await api.upscaleArgs(creationId, params.mode, params.scale_factor ?? params.scale) };
});
module.exports = { FALLBACK, load, reset, check, prepare, validate, estimator, prepareEstimate: upscale.prepareEstimate, estimate: upscale.estimate };
