'use strict';

// Shared tool limits, asset helpers and accounting helpers, moved from lib/tools.js.

const motionHtml = require('../../public/nodes/motion-html');
const costs = require('../costs');
const budget = require('../budget');
const store = require('../store');
const path = require('path');
const access = require('../access');
const publicrefs = require('../publicrefs');
const resultMeta = require('../result-meta');

const WORKFLOW_LANGUAGES = ['de', 'en', 'es'];

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

const VIDEO_RESOLUTIONS = ['480p', '720p'];

const MAX_RENDER_ASSETS = 10;

const RENDER_FORMATS = motionHtml.FORMATS;

const MAX_RENDER_ASSET_BYTES = 500 * 1024 * 1024;

const MAX_CONCAT_ASSETS = 20;

const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4';

const HIGGSFIELD_MODEL_TEXT_LIMIT = 8000;

// Frist eines Higgsfield-Jobs ab dem Start. Zu Stosszeiten warten Auftraege bei Higgsfield lange in der Schlange;
// 10 Minuten reichten fuer Videos oft nicht (Higgsfield rendert dann trotzdem fertig und verrechnet die Credits).
// Videos bleiben unter der Frist eines Workflow-Nodes (30 Minuten, lib/nodes/engine.js).
const HIGGSFIELD_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const HIGGSFIELD_VIDEO_JOB_TIMEOUT_MS = 25 * 60 * 1000;

const HIGGSFIELD_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// fal.ai queue jobs (node view only): the poller gives up after this time, files above the upload cap are refused.
const FAL_JOB_TIMEOUT_MS = 90 * 60 * 1000;

const FAL_KINDS = Object.freeze(['video', 'image', 'audio', 'model3d', 'auto']);

const FAL_MAX_MEDIA_FILES = 30;

const FAL_MAX_INPUT_BYTES = 1024 * 1024;

const FAL_UPLOAD_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
});

const HIGGSFIELD_DEFAULT_AUDIO_MODEL = 'seed_audio';

// Speech models of the node view. The other audio models of the MCP (sonilo_music, mirelo_text_to_audio,
// inworld_text_to_speech) belong to the game pipeline and are not offered.
const HIGGSFIELD_SPEECH_MODELS = Object.freeze(['seed_audio', 'text2speech_v2']);

// seed_audio answers WAV by default and can also answer mp3, pcm and ogg_opus; the app stores wav and mp3 only.
const HIGGSFIELD_SPEECH_FORMATS = Object.freeze(['wav', 'mp3']);

// text2speech_v2 cannot run without one of these engines.
const HIGGSFIELD_SPEECH_VARIANTS = Object.freeze(['elevenlabs', 'minimax', 'seed_speech', 'vibe_voice', 'cozy_voice']);

// seed_audio takes 0..2 reference audios; video models with an audio role take up to 15 (the model's own limit is
// checked when the catalogue states it).
const HIGGSFIELD_MAX_SPEECH_REFS = 2;

const HIGGSFIELD_MAX_AUDIO_REFS = 15;

// The role of an audio reference when the model cannot be read; a readable model's own roles always win.
const HIGGSFIELD_AUDIO_REFERENCE_ROLE = 'audio_references';

function extFromMediaType(mediaType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return map[String(mediaType || '').toLowerCase()] || '.png';
}

function shorten(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ctx.budgetKey: the reservation of the node run the cost belongs to (lib/budget.js); it shrinks by what was booked.
async function recordToolCost(entry, ctx = null) {
  try {
    await costs.recordCost(entry);
    if (ctx && ctx.budgetKey) budget.settle(ctx.budgetKey, entry.cost);
  } catch (err) {
    console.warn('[costs] Tool-Kosten konnten nicht erfasst werden:', err.message);
  }
}

const RASTER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Die Bild-/Video-APIs akzeptieren nur Rasterformate; SVG & Co. muessen vorher klar abgewiesen werden.
async function requireRasterAsset(sessionId, id) {
  const entries = await store.readLedger(sessionId);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return; // assetDataUrl liefert gleich den sprechenden Fehler
  const ext = path.extname(entry.file).toLowerCase();
  if (!RASTER_EXTS.has(ext)) {
    throw new Error(
      `Asset ${id} (${ext}) ist kein Rasterbild - die Bild-/Video-API akzeptiert nur PNG, JPEG oder WebP. ` +
        'SVG-Importe aus dem GTS erhalten automatisch eine PNG-Variante (Asset-ID steht in der Import-Bestaetigung) - nutze diese. ' +
        'Fuer Vektor-Compositing nutze render_motion_graphics, das SVG direkt kann.'
    );
  }
}

async function referencesFromAssetIds(sessionId, ids) {
  const out = [];
  for (const id of ids || []) {
    await requireRasterAsset(sessionId, id);
    const url = await store.assetDataUrl(sessionId, id);
    out.push({ type: 'image_url', image_url: { url } });
  }
  return out;
}

// Word times of a song (node "Lyrics timing", WP34): the forced alignment of a known text or, without a text, the transcript of
// Scribe, both from ElevenLabs, then cleaned and put into lines (lib/lyrics-timing.js). Node view only, paid by the hour of audio:
// the estimate for the measured length is reserved and booked for everybody as a cost of the type speech.
// Who sings the lines (WP48, `voices`): a line the text marks as a choir's carries `voice: 'choir'`; with `voices: 'auto'` and a text without such
// marks, Gemini hears the song and says it for every line (lib/voice-detect.js, booked as a cost of the type brain). See detectTimingVoices.
const TIMING_METHODS = Object.freeze(['auto', 'align', 'transcribe']);

const TIMING_VOICES = Object.freeze(['off', 'auto']);

const TIMING_MAX_SECONDS = 20 * 60;

const TIMING_MAX_BYTES = 150 * 1024 * 1024;

const TIMING_UPLOAD_MIME = Object.freeze({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac' });

function safeExtFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.bin';
}

function rasterMimeForExt(ext, mimeType) {
  const expected = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  }[ext];
  if (!expected) return '';
  const listed = String(mimeType || '').toLowerCase();
  return listed === expected ? listed : expected;
}

const { assertNoExternalReferences } = require('../svg-safe');

async function storeImportedSessionAsset(ctx, { buffer, filename, prompt, sourceLabel, mimeType = '', kind = 'upload' }) {
  const ext = safeExtFromFilename(filename);
  const asset = await store.saveAsset(ctx.sessionId, {
    kind,
    buffer,
    ext,
    prompt,
    cost: null
  });

  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind, prompt, cost: null }
  });

  let toolResult = `${sourceLabel} importiert: ${filename} als ${asset.id} (Datei ${asset.file}).`;
  let previewMime = rasterMimeForExt(ext, mimeType);
  let previewId = asset.id;
  let previewFile = asset.file;
  let rasterAsset = null;

  // SVGs koennen die Bild-/Video-APIs nicht verarbeiten - zusaetzlich als PNG rastern.
  if (ext === '.svg') {
    try {
      assertNoExternalReferences(buffer.toString('utf8'));
      const { Resvg } = require('@resvg/resvg-js');
      const pngBuffer = new Resvg(buffer.toString('utf8'), {
        fitTo: { mode: 'width', value: 1024 }
      }).render().asPng();
      const pngAsset = await store.saveAsset(ctx.sessionId, {
        kind: 'upload',
        buffer: pngBuffer,
        ext: '.png',
        prompt: `${prompt} (PNG aus SVG)`,
        cost: null
      });
      ctx.emit({
        type: 'asset',
        asset: { id: pngAsset.id, url: pngAsset.url, kind: 'upload', prompt: pngAsset.prompt, cost: null }
      });
      toolResult =
        `${sourceLabel} importiert: ${filename} als ${asset.id} (SVG) und zusaetzlich als ${pngAsset.id} (PNG, 1024px gerastert). ` +
        `Nutze ${pngAsset.id} fuer edit_image und generate_video, ${asset.id} fuer render_motion_graphics.`;
      previewMime = 'image/png';
      previewId = pngAsset.id;
      previewFile = pngAsset.file;
      rasterAsset = pngAsset;
    } catch (err) {
      toolResult += ` Hinweis: PNG-Rasterung fehlgeschlagen (${err.message}) - das SVG ist nur fuer render_motion_graphics nutzbar, nicht fuer edit_image/generate_video.`;
    }
  }

  const inject = previewMime
    ? [
        {
          role: 'user',
          hidden: true,
          content: [
            { type: 'text', text: `[System] Automatische Vorschau des Imports ${previewId} zur Pruefung:` },
            { type: 'image_ref', file: previewFile, mime: previewMime }
          ]
        }
      ]
    : [];

  // rasterAsset = PNG variant of an imported SVG (null otherwise); the node view uses it for SVG uploads.
  return {
    toolResult,
    inject,
    asset,
    rasterAsset
  };
}

function requiredString(value, field) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`${field} fehlt`);
  return clean;
}

// User management: who is calling? ctx.user is the address the external login reported ('lokal' or unset = nobody).
// In the local mode everybody is an admin. The chat tools must not be a way around the admin-only routes.
function viewerOfCtx(ctx) {
  return ctx?.viewer || access.viewerOf({ kubleUser: ctx?.user });
}

function referenceIdArray(args, field, maxItems) {
  if (args[field] === undefined || args[field] === null) return [];
  if (!Array.isArray(args[field])) throw new Error(`${field} muss ein Array sein`);
  if (args[field].length > maxItems) {
    throw new Error(`generate_video akzeptiert maximal ${maxItems} ${field}`);
  }
  return args[field].map((value) => {
    const id = String(value || '').trim();
    if (!id) throw new Error(`${field} darf nur gueltige Asset-IDs enthalten`);
    return id;
  });
}

async function validateMediaReferenceAssets(sessionId, ids, allowedExtensions, label) {
  const ledger = await store.readLedger(sessionId);
  return ids.map((id) => {
    const asset = ledger.find((entry) => entry.id === id);
    if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const ext = path.extname(asset.file).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(
        `Asset ${id} (${ext || 'ohne Endung'}) ist keine gueltige ${label}. ` +
          'Bilder gehoeren in reference_asset_ids.'
      );
    }
    return asset;
  });
}

async function removePublishedRefs(files) {
  await Promise.all((files || []).map((file) => publicrefs.removeRef(file).catch((err) => {
    console.warn(`[publicrefs] Referenz ${file} konnte nicht entfernt werden: ${err.message}`);
  })));
}

// What a job carries so the poller can settle the reservation of a participant when the cost arrives, and (for a run that
// came in through an agent key) book it with the id and the name of the key as well (lib/costs.js withVia).
function budgetFieldsOf(ctx) {
  const grant = ctx && ctx.budgetGrant;
  const via = costs.currentVia();
  return {
    ...(via?.reservationId ? { mcpReservationId: via.reservationId, mcpReservedUsd: via.reservationUsd || 0 } : {}),
    ...(grant && grant.jobKey ? { budgetKey: grant.jobKey, ...(grant.reservedUsd > 0 ? { reservedUsd: grant.reservedUsd } : {}) } : {}),
    ...costs.viaFields()
  };
}

// The fields of a job the chat shows (live events carry the same as the job list of the server).
function jobMetaFields(job) {
  const billing = resultMeta.billingOf(job);
  return {
    ...resultMeta.describe(job),
    ...(Number.isFinite(job.estimateUsd) ? { estimateUsd: job.estimateUsd } : {}),
    ...(Number.isFinite(job.estimateMinUsd) ? { estimateMinUsd: job.estimateMinUsd } : {}),
    ...(billing ? { billing } : {})
  };
}

async function removeReservedAsset(sessionId, assetId) {
  await store.withLock(sessionId, async () => {
    const entries = await store.readLedger(sessionId);
    await store.writeLedger(
      sessionId,
      entries.filter((entry) => entry.id !== assetId)
    );
  });
}

module.exports = {
  IMAGE_RATIOS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_MODEL_ID,
  WORKFLOW_LANGUAGES,
  MAX_RENDER_ASSETS,
  MAX_CONCAT_ASSETS,
  recordToolCost,
  shorten,
  referencesFromAssetIds,
  extFromMediaType,
  storeImportedSessionAsset,
  viewerOfCtx,
  requiredString,
  TIMING_METHODS,
  TIMING_VOICES,
  TIMING_UPLOAD_MIME,
  TIMING_MAX_SECONDS,
  TIMING_MAX_BYTES,
  referenceIdArray,
  requireRasterAsset,
  validateMediaReferenceAssets,
  removePublishedRefs,
  removeReservedAsset,
  budgetFieldsOf,
  jobMetaFields,
  FAL_KINDS,
  FAL_MAX_INPUT_BYTES,
  FAL_MAX_MEDIA_FILES,
  FAL_UPLOAD_MIME,
  FAL_JOB_TIMEOUT_MS,
  MAX_RENDER_ASSET_BYTES,
  RENDER_FORMATS,
  HIGGSFIELD_MODEL_TEXT_LIMIT,
  HIGGSFIELD_AUDIO_REFERENCE_ROLE,
  HIGGSFIELD_UPLOAD_TIMEOUT_MS,
  HIGGSFIELD_MAX_AUDIO_REFS,
  HIGGSFIELD_JOB_TIMEOUT_MS,
  HIGGSFIELD_VIDEO_JOB_TIMEOUT_MS,
  HIGGSFIELD_DEFAULT_AUDIO_MODEL,
  HIGGSFIELD_SPEECH_MODELS,
  HIGGSFIELD_MAX_SPEECH_REFS,
  HIGGSFIELD_SPEECH_FORMATS,
  HIGGSFIELD_SPEECH_VARIANTS
};
