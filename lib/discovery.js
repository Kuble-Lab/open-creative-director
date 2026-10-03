'use strict';

const or = require('./openrouter');

const SEEDANCE_25_FALLBACK_CAPABILITIES = Object.freeze({
  resolutions: Object.freeze(['480p', '720p']),
  aspectRatios: Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']),
  durations: Object.freeze({ min: 4, max: 30 }),
  frameImages: Object.freeze(['first_frame', 'last_frame'])
});

// The video model list is fetched once per MODEL_LIST_TTL_MS and shared by the startup check, the capability lookup and
// the model picker of the chat (lib/video-models.js). A failed fetch is never cached.
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
let videoModelsCache = null; // { at, promise }

function listVideoModelsOnce() {
  const now = Date.now();
  if (videoModelsCache && now - videoModelsCache.at < MODEL_LIST_TTL_MS) return videoModelsCache.promise;
  const entry = { at: now, promise: Promise.resolve().then(() => or.listVideoModels()) };
  entry.promise.catch(() => {
    if (videoModelsCache === entry) videoModelsCache = null;
  });
  videoModelsCache = entry;
  return entry.promise;
}

function resetVideoModelCache() {
  videoModelsCache = null;
}

// The image model list (lib/image-models.js: reference limits of the models in the node view) is kept the same way.
let imageModelsCache = null; // { at, promise }

function listImageModelsOnce() {
  const now = Date.now();
  if (imageModelsCache && now - imageModelsCache.at < MODEL_LIST_TTL_MS) return imageModelsCache.promise;
  const entry = { at: now, promise: Promise.resolve().then(() => or.listImageModels()) };
  entry.promise.catch(() => {
    if (imageModelsCache === entry) imageModelsCache = null;
  });
  imageModelsCache = entry;
  return entry.promise;
}

function resetImageModelCache() {
  imageModelsCache = null;
}

// Model listings differ slightly per endpoint; collect every plausible slug field.
function collectSlugs(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
  const slugs = [];
  for (const item of list) {
    if (typeof item === 'string') {
      slugs.push(item);
      continue;
    }
    for (const key of ['id', 'slug', 'canonical_slug', 'model']) {
      if (typeof item?.[key] === 'string') slugs.push(item[key]);
    }
  }
  return [...new Set(slugs)];
}

function pickFallback(slugs, needle) {
  const hits = slugs.filter((s) => s.toLowerCase().includes(needle));
  if (hits.length === 0) return null;
  // Prefer the shortest match: usually the plain, non-variant slug.
  hits.sort((a, b) => a.length - b.length);
  return hits[0];
}

async function verify(label, configured, needle, fetcher) {
  try {
    const slugs = collectSlugs(await fetcher());
    if (slugs.length === 0) {
      console.warn(`[discovery] ${label}: Liste leer, nutze konfiguriertes Modell ${configured}.`);
      return configured;
    }
    if (slugs.includes(configured)) {
      console.log(`[discovery] ${label}: ${configured} verifiziert.`);
      return configured;
    }
    const fallback = pickFallback(slugs, needle);
    if (fallback) {
      console.warn(
        `[discovery] ${label}: ${configured} nicht gefunden. Laufzeit-Fallback auf ${fallback} (config.json bleibt unveraendert).`
      );
      return fallback;
    }
    console.warn(
      `[discovery] ${label}: ${configured} nicht gefunden und kein Treffer fuer "${needle}". Nutze weiterhin ${configured}.`
    );
    return configured;
  } catch (err) {
    console.warn(`[discovery] ${label}: Abruf fehlgeschlagen (${err.message}). Nutze ${configured}.`);
    return configured;
  }
}

// Never throws - discovery must not block startup.
async function resolveModels(config) {
  if (!or.hasKey()) return { imageModel: config.imageModel, videoModel: config.videoModel };
  const [imageModel, videoModel] = await Promise.all([
    verify('Bildmodell', config.imageModel, 'gpt-image', listImageModelsOnce),
    verify('Videomodell', config.videoModel, 'seedance', listVideoModelsOnce)
  ]);
  return { imageModel, videoModel };
}

// Cache: model id -> input_modalities (Chat-Modelle). Einmal pro Prozess geladen.
let modalityMapPromise = null;

async function loadModalityMap() {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const map = new Map();
  for (const item of payload?.data || []) {
    if (item?.id) map.set(item.id, item.architecture?.input_modalities || null);
  }
  return map;
}

// true, wenn das Brain-Modell Bild-Input akzeptiert. Bei unbekanntem Modell oder
// Abruf-Fehler: true (bisheriges Verhalten, blockiert nichts).
async function brainSupportsImages(modelId) {
  try {
    if (!modalityMapPromise) modalityMapPromise = loadModalityMap();
    const map = await modalityMapPromise;
    const modalities = map.get(modelId);
    if (!Array.isArray(modalities)) return true;
    return modalities.includes('image');
  } catch (err) {
    modalityMapPromise = null;
    console.warn(`[discovery] Modalitaeten-Abruf fehlgeschlagen (${err.message}), nehme Bild-Support an.`);
    return true;
  }
}

// true, wenn das Brain-Modell Dateien (PDF) als Eingabe akzeptiert: "file" in input_modalities der oeffentlichen Liste.
// Anders als bei Bildern gilt ein unbekanntes Modell oder ein Abruf-Fehler als false: Dateiteile sind eine Zugabe (der Text
// allein genuegt), ein Modell, das sie ablehnt, wuerde den ganzen Aufruf scheitern lassen.
async function brainSupportsFiles(modelId) {
  try {
    if (!modalityMapPromise) modalityMapPromise = loadModalityMap();
    const map = await modalityMapPromise;
    const modalities = map.get(modelId);
    return Array.isArray(modalities) && modalities.includes('file');
  } catch (err) {
    modalityMapPromise = null;
    console.warn(`[discovery] Modalitaeten-Abruf fehlgeschlagen (${err.message}), sende keine Dateien.`);
    return false;
  }
}

// Fuer Tests: die gemerkte Modalitaeten-Liste verwerfen.
function resetModalityCache() {
  modalityMapPromise = null;
}

function fallbackVideoCapabilities() {
  return {
    resolutions: [...SEEDANCE_25_FALLBACK_CAPABILITIES.resolutions],
    aspectRatios: [...SEEDANCE_25_FALLBACK_CAPABILITIES.aspectRatios],
    durations: { ...SEEDANCE_25_FALLBACK_CAPABILITIES.durations },
    frameImages: [...SEEDANCE_25_FALLBACK_CAPABILITIES.frameImages]
  };
}

function payloadList(payload) {
  return Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
}

function itemSlug(item) {
  if (typeof item === 'string') return item;
  for (const key of ['id', 'slug', 'canonical_slug', 'model']) {
    if (typeof item?.[key] === 'string') return item[key];
  }
  return '';
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))]
    : [];
}

function durationRange(value) {
  if (Array.isArray(value)) {
    const durations = value.map(Number).filter(Number.isFinite);
    if (durations.length) return { min: Math.min(...durations), max: Math.max(...durations) };
  }
  if (value && typeof value === 'object') {
    const min = Number(value.min ?? value.minimum);
    const max = Number(value.max ?? value.maximum);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }
  return null;
}

// Never throws. If discovery fails or the configured model is absent, the verified
// Seedance 2.5 constraints keep generation safe.
async function videoCapabilities(videoModel) {
  try {
    const item = payloadList(await listVideoModelsOnce()).find((entry) => itemSlug(entry) === videoModel);
    if (!item || typeof item === 'string') {
      console.warn(`[discovery] Video-Capabilities für ${videoModel} nicht gefunden, nutze Seedance-2.5-Fallback.`);
      return fallbackVideoCapabilities();
    }

    const source = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : item;
    const fallback = fallbackVideoCapabilities();
    const resolutions = stringList(source.supported_resolutions);
    const aspectRatios = stringList(source.supported_aspect_ratios);
    const durations = durationRange(source.supported_durations);
    const frameImages = stringList(source.supported_frame_images);

    return {
      resolutions: resolutions.length ? resolutions : fallback.resolutions,
      aspectRatios: aspectRatios.length ? aspectRatios : fallback.aspectRatios,
      durations: durations || fallback.durations,
      frameImages: frameImages.length ? frameImages : fallback.frameImages
    };
  } catch (err) {
    console.warn(`[discovery] Video-Capabilities-Abruf fehlgeschlagen (${err.message}), nutze Seedance-2.5-Fallback.`);
    return fallbackVideoCapabilities();
  }
}

module.exports = {
  resolveModels,
  brainSupportsImages,
  brainSupportsFiles,
  resetModalityCache,
  videoCapabilities,
  listVideoModels: listVideoModelsOnce,
  resetVideoModelCache,
  listImageModels: listImageModelsOnce,
  resetImageModelCache
};
