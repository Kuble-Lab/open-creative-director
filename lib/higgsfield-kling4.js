'use strict';

// Kling 4.0 through Higgsfield as an option of the chat's video model picker (lib/video-models.js). The card lists
// OpenRouter and fal models; this entry is synthetic like FLUX.3 Max (lib/flux3-max.js) and only offered while Higgsfield
// is connected. A click starts higgsfield_generate_video with the Higgsfield model kling4_0 (lib/tools.js, executeTool).
//
// Read from models_explore through the app on 2026-10-24: modes text-to-video, image-to-video, reference-to-video and
// video-edit (default text-to-video), aspect_ratio 21:9, 16:9, 9:16, 1:1 or auto, resolution 720p or 1080p (default
// 1080p), duration 3 to 30 whole seconds (default 10), media roles start_image, end_image and image_references. The
// catalogue names no credit price (credits_per_unit null): the card shows "price unknown" until it does. No paid run yet,
// so NOT known: whether a start plus an end image runs as image-to-video, and whether the result has sound.

const higgsfield = require('./higgsfield');

const MODEL = 'higgsfield/kling4_0';
const HF_MODEL = 'kling4_0';
const NAME = 'Kling 4.0 (Higgsfield)';
const RATIOS = Object.freeze(['21:9', '16:9', '9:16', '1:1']);
const RESOLUTIONS = Object.freeze(['720p', '1080p']);
const MIN_SECONDS = 3;
const MAX_SECONDS = 30;

function available() {
  try {
    return higgsfield.status().connected === true;
  } catch (_) {
    return false;
  }
}

function catalogueEntry() {
  return {
    id: MODEL,
    name: NAME,
    supported_resolutions: [...RESOLUTIONS],
    supported_aspect_ratios: [...RATIOS],
    supported_durations: Array.from({ length: MAX_SECONDS - MIN_SECONDS + 1 }, (_, i) => i + MIN_SECONDS),
    supported_frame_images: ['first_frame', 'last_frame'],
    generate_audio: false
  };
}

// The card's price in USD from the credits of the Higgsfield catalogue and the configured USD per credit, or null while the
// catalogue names no credits (as on 2026-10-24) or the model was not read yet. Never throws.
function price(duration) {
  try {
    const catalog = require('./nodes/higgsfield-catalog');
    const model = catalog.peekModel(HF_MODEL);
    const credits = model ? catalog.creditsFor(model, { duration }) : null;
    const rate = Number(require('./settings').getPreference('higgsfieldUsdPerCredit'));
    if (credits === null || !Number.isFinite(rate) || rate <= 0) return null;
    const total = Math.round(credits * rate * 1e6) / 1e6;
    const perSecond = Math.round((total / duration) * 1e6) / 1e6;
    return { currency: 'USD', durationSeconds: duration, minPerSecond: perSecond, maxPerSecond: perSecond, minTotal: total, maxTotal: total, credits, source: 'higgsfield-catalogue' };
  } catch (_) {
    return null;
  }
}

// The arguments of generate_video as a Higgsfield request: { params, frames } where frames lists the asset ids with their
// media role (start_image, end_image). Reference files are refused: the card never offers this model for them.
function plan(args = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  if (args.reference_asset_ids?.length || args.reference_video_asset_ids?.length || args.reference_audio_asset_ids?.length) {
    throw new Error(`${NAME}: im Chat nur Start- und Endbild, keine Referenzdateien. Es wurde nichts eingereicht.`);
  }
  const first = String(args.first_frame_asset_id || '').trim();
  const last = String(args.last_frame_asset_id || '').trim();
  if (args.mode === 'image_to_video' && !first) throw new Error('first_frame_asset_id fehlt');
  if (last && !first) throw new Error(`${NAME}: ein Endbild braucht ein Startbild. Es wurde nichts eingereicht.`);
  const duration = Math.round(Number(args.duration_seconds ?? 5));
  if (!Number.isInteger(duration) || duration < MIN_SECONDS || duration > MAX_SECONDS) {
    throw new Error(`${NAME}: Dauer ${MIN_SECONDS} bis ${MAX_SECONDS} s. Es wurde nichts eingereicht.`);
  }
  const resolution = String(args.resolution || '720p');
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`${NAME}: Aufloesung 720p oder 1080p. Es wurde nichts eingereicht.`);
  const ratio = String(args.aspect_ratio || '').trim();
  // A start image keeps its own format ("auto"); text to video takes the requested format, else 16:9.
  const aspect = first ? 'auto' : RATIOS.includes(ratio) ? ratio : '16:9';
  const params = { model: HF_MODEL, prompt, use_unlim: false, mode: first ? 'image-to-video' : 'text-to-video', aspect_ratio: aspect, resolution, duration };
  const frames = [...(first ? [{ assetId: first, role: 'start_image' }] : []), ...(last ? [{ assetId: last, role: 'end_image' }] : [])];
  return { params, frames, prompt };
}

module.exports = { MODEL, HF_MODEL, NAME, RATIOS, RESOLUTIONS, MIN_SECONDS, MAX_SECONDS, available, catalogueEntry, price, plan };
