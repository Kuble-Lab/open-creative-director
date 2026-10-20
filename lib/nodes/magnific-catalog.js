'use strict';

const magnific = require('../magnific');
const api = require('../tools/magnific');
const FALLBACK = [{ value: 'creative', label: 'Creative', scales: [2, 4, 8, 16] }, { value: 'precision', label: 'Precision', scales: [2, 4, 8, 16] }];
let modes = FALLBACK;
let expiresAt = 0;
const estimates = new Map();
function reset() { modes = FALLBACK; expiresAt = 0; estimates.clear(); api.clearUploads(); }
async function load() {
  const status = magnific.status();
  if (!status.connected) { reset(); return FALLBACK; }
  if (Date.now() < expiresAt) return modes;
  const result = await api.checkedCall('images_upscale_modes_list', {});
  const found = api.objects(result).filter((o) => typeof (o.mode || o.id || o.name) === 'string' && (Array.isArray(o.scales) || Array.isArray(o.scale_factors)))
    .map((o) => ({ value: o.mode || o.id || o.name, label: o.label || o.name || o.mode || o.id, scales: (o.scales || o.scale_factors).map(Number).filter((n) => Number.isInteger(n) && n >= 2 && n <= 16) }));
  if (!found.length) throw new Error('Magnific upscale mode schema is unknown; inspect magnific_tools before spending credits.');
  modes = found;
  expiresAt = Date.now() + 60 * 60 * 1000;
  return modes;
}
function check(mode, scale) {
  const spec = modes.find((m) => m.value === mode);
  if (!spec || !spec.scales.includes(scale)) throw new Error('Magnific: unsupported upscale mode or scale.');
}
function validate(params) {
  if (expiresAt <= Date.now()) return [];
  try { check(params.mode, Number(params.scale_factor ?? params.scale)); return []; }
  catch (_) { return [{ code: 'magnific_settings', message: 'Select a supported Magnific mode and scale factor.' }]; }
}
const key = (params, input) => JSON.stringify([params.mode, Number(params.scale_factor ?? params.scale), input?.sessionId, input?.assetId]);
async function prepare(params) { await load(); check(params.mode, Number(params.scale_factor ?? params.scale)); }
// Plans with an available input use the real uploaded creation to simulate the exact call. Uploads and estimates
// are cached, and participants are refused before any upload. Inputs produced later keep an unknown plan price.
async function prepareEstimate(params, ctx) {
  const access = require('../access');
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  if (access.isRestricted(viewer) || access.isUnconfirmed(viewer) || !magnific.status().connected) return;
  const input = ctx.inputs?.image;
  if (!input?.assetId || input.sessionId !== ctx.sessionId) return;
  const cacheKey = key(params, input);
  if (estimates.get(cacheKey)?.expiresAt > Date.now()) return;
  const uploaded = await api.uploadAsset(ctx, input.assetId);
  const args = await api.upscaleArgs(uploaded.creationId, params.mode, params.scale_factor ?? params.scale);
  const credits = api.creditsOf(await api.estimate('images_upscale', args));
  estimates.set(cacheKey, { credits, expiresAt: Date.now() + 60000 });
}
function estimate(params, ctx = {}) {
  const cached = estimates.get(key(params, ctx.inputs?.image));
  return cached?.expiresAt > Date.now() && cached.credits !== null ? { credits: cached.credits } : null;
}
module.exports = { FALLBACK, load, reset, check, prepare, prepareEstimate, estimate, validate };
