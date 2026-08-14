'use strict';

const or = require('./openrouter');

const SEEDANCE_25_FALLBACK_CAPABILITIES = Object.freeze({
  resolutions: Object.freeze(['480p', '720p']),
  aspectRatios: Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']),
  durations: Object.freeze({ min: 4, max: 30 }),
  frameImages: Object.freeze(['first_frame', 'last_frame'])
});

// Video-Modellliste einmal pro Prozess laden. Der authentifizierte Abruf wird
// sowohl von der Modellauflösung als auch von der Capability-Discovery geteilt.
let videoModelsPromise = null;

function listVideoModelsOnce() {
  if (!videoModelsPromise) videoModelsPromise = Promise.resolve().then(() => or.listVideoModels());
  return videoModelsPromise;
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
    verify('Bildmodell', config.imageModel, 'gpt-image', or.listImageModels),
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

module.exports = { resolveModels, brainSupportsImages, videoCapabilities };
