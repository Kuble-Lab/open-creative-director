'use strict';

// Trial listening to the ElevenLabs voices (WP38f). Where a voice is chosen, a button plays it first.
//   - the free sample: every library voice has a `preview_url` at ElevenLabs. The browser never gets that address and never names one:
//     the app looks the voice up in its own list, fetches the file of THAT voice (lib/elevenlabs.js fetchPreview: https, a public host,
//     size and time limit, no key sent) and keeps it for a while, so the same sample is not loaded again and again.
//   - a made sample: a voice without a preview_url (often a cloned one) is read once with a fixed sentence of about 100 characters in
//     the language of the interface and with the speech model that is chosen. That costs about one cent: it goes through the budget
//     like any speech (reserved, then booked as a cost of type speech) and is stored per voice, model and language, so it is paid only
//     once.
// Who may use a voice: the same rule as the list of voices. A participant or guest (and a caller whose login is unconfirmed, who may
// be one) gets the library voices only (category premade); the cloned voices of the operator are not theirs, and the answer for such a
// voice is the same as for one that does not exist.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');
const access = require('./access');
const budget = require('./budget');
const costs = require('./costs');
const elevenlabs = require('./elevenlabs');
const tools = require('./tools');

const SAMPLES_DIR = path.join(PATHS.root, 'data', 'voice-samples');
const COST_SESSION = 'voice-preview';
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// The free samples that were fetched, kept in memory: at most CACHE_MAX_BYTES together, each for CACHE_TTL_MS.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;

// The sentence of a made sample, in the languages of the interface (about 100 characters each).
const SAMPLE_TEXTS = Object.freeze({
  de: 'Hallo, so klingt meine Stimme. Mit mir wird aus deinem Text ein Video, dem man gerne zuhört.',
  en: 'Hello, this is how my voice sounds. With me, your text becomes a video that people enjoy listening to.',
  es: 'Hola, así suena mi voz. Conmigo, tu texto se convierte en un vídeo que da gusto escuchar.'
});
const DEFAULT_LANG = 'en';

class PreviewError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ---------- who may use which voice ---------- */

// Restricted for this purpose: a participant or guest, or a caller whose login could not be confirmed.
function isRestrictedViewer(viewer) {
  return access.isRestricted(viewer) || access.isUnconfirmed(viewer);
}

// The list of voices is kept for a short while and shared by all callers (every click on a play button and every price query looks a voice
// up; the list itself is one request to ElevenLabs). The permission is checked on each call, on the kept list.
const VOICES_TTL_MS = 60 * 1000;
let voicesKept = null; // { list, expires }
let voicesLoading = null; // Promise of the request that is running

async function voiceList(now = Date.now()) {
  if (voicesKept && voicesKept.expires > now) return voicesKept.list;
  if (!voicesLoading) {
    voicesLoading = Promise.resolve()
      .then(() => elevenlabs.listVoices())
      .then((list) => {
        voicesKept = { list, expires: now + VOICES_TTL_MS };
        return list;
      })
      .finally(() => { voicesLoading = null; });
  }
  return voicesLoading;
}

// The voice as the list of ElevenLabs knows it, if the caller may use it; else PreviewError NOT_FOUND (no difference between a voice
// that does not exist and one the caller may not have).
async function findVoice(voiceId, viewer, { now = Date.now() } = {}) {
  // "default" is the voice a node uses when none is chosen
  const id = String(voiceId || '') === 'default' ? tools.DEFAULT_ELEVENLABS_VOICE_ID : String(voiceId || '');
  if (!VOICE_ID_PATTERN.test(id)) throw new PreviewError('NOT_FOUND', 'Voice not found');
  if (!elevenlabs.hasKey()) throw new PreviewError('UNAVAILABLE', 'ElevenLabs API key is not configured');
  let voices;
  try {
    voices = await voiceList(now);
  } catch (err) {
    throw new PreviewError('UPSTREAM', `ElevenLabs voices could not be loaded: ${err.message}`);
  }
  const voice = voices.find((entry) => entry.voice_id === id);
  if (!voice || (isRestrictedViewer(viewer) && voice.category !== 'premade')) throw new PreviewError('NOT_FOUND', 'Voice not found');
  return voice;
}

/* ---------- the free sample ---------- */

const cache = new Map(); // voiceId -> { url, buffer, contentType, expires }
let cacheBytes = 0;

function cacheDrop(key) {
  const entry = cache.get(key);
  if (!entry) return;
  cacheBytes -= entry.buffer.length;
  cache.delete(key);
}

function cacheGet(voiceId, url, now) {
  const entry = cache.get(voiceId);
  if (!entry) return null;
  // another address (the voice got a new sample) or too old: fetch again
  if (entry.url !== url || entry.expires <= now) {
    cacheDrop(voiceId);
    return null;
  }
  // most recently used last
  cache.delete(voiceId);
  cache.set(voiceId, entry);
  return entry;
}

function cachePut(voiceId, url, sample, now) {
  cacheDrop(voiceId);
  if (sample.buffer.length > CACHE_MAX_BYTES) return;
  cache.set(voiceId, { url, buffer: sample.buffer, contentType: sample.contentType, expires: now + CACHE_TTL_MS });
  cacheBytes += sample.buffer.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size) cacheDrop(cache.keys().next().value);
}

const inFlight = new Map(); // voiceId -> Promise of the fetch that is running

// The free sample of a voice the caller may use: { buffer, contentType, cached }. NO_PREVIEW where ElevenLabs keeps none.
async function freePreview(voiceId, viewer, { now = Date.now() } = {}) {
  const voice = await findVoice(voiceId, viewer, { now });
  const url = voice.preview_url;
  if (!url) throw new PreviewError('NO_PREVIEW', 'This voice has no sample', { reason: 'NO_PREVIEW' });
  const hit = cacheGet(voice.voice_id, url, now);
  if (hit) return { buffer: hit.buffer, contentType: hit.contentType, cached: true };
  let pending = inFlight.get(voice.voice_id);
  if (!pending || pending.url !== url) {
    pending = { url, promise: elevenlabs.fetchPreview(url).finally(() => { if (inFlight.get(voice.voice_id) === pending) inFlight.delete(voice.voice_id); }) };
    inFlight.set(voice.voice_id, pending);
  }
  let sample;
  try {
    sample = await pending.promise;
  } catch (err) {
    throw new PreviewError('UPSTREAM', err?.code === 'PREVIEW_TOO_LARGE' ? 'The sample is too large' : 'The sample could not be loaded', { reason: err?.code || 'PREVIEW_UPSTREAM' });
  }
  cachePut(voice.voice_id, url, sample, now);
  return { buffer: sample.buffer, contentType: sample.contentType, cached: false };
}

/* ---------- the made sample ---------- */

function pickLang(value) {
  const lang = String(value || '').slice(0, 2).toLowerCase();
  return Object.prototype.hasOwnProperty.call(SAMPLE_TEXTS, lang) ? lang : DEFAULT_LANG;
}

function pickModel(value) {
  const model = String(value || '').trim();
  return MODEL_ID_PATTERN.test(model) ? model : tools.DEFAULT_ELEVENLABS_MODEL_ID;
}

function sampleFile(voiceId, modelId, lang) {
  const name = crypto.createHash('sha256').update(`${voiceId}\n${modelId}\n${lang}`).digest('hex').slice(0, 40);
  return path.join(SAMPLES_DIR, `${name}.mp3`);
}

async function readSample(file) {
  try {
    const buffer = await fsp.readFile(file);
    return buffer.length ? buffer : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeSample(file, buffer) {
  await fsp.mkdir(SAMPLES_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// What a made sample costs and whether it can be made now: { text, chars, usd, available, reason, cached }.
//   reason: 'no_key' (no ElevenLabs key), 'budget' (the budget of a participant does not cover it), null.
//   cached: the sample of this voice, model and language exists: it is free then and always available.
async function sampleInfo(viewer, { voiceId = '', model, lang } = {}) {
  const modelId = pickModel(model);
  const language = pickLang(lang);
  const text = SAMPLE_TEXTS[language];
  const usd = tools.speechEstimateUsd(text, modelId) || 0;
  const info = { text, chars: [...text].length, usd, model: modelId, lang: language, available: true, reason: null, cached: false };
  if (VOICE_ID_PATTERN.test(String(voiceId || '')) && (await readSample(sampleFile(voiceId, modelId, language)))) {
    info.cached = true;
    return info;
  }
  if (!elevenlabs.hasKey()) return { ...info, available: false, reason: 'no_key' };
  const status = access.isRestricted(viewer) ? await budget.status(viewer) : null;
  if (status && (status.remainingUsd <= budget.REMAINING_EPSILON || usd > status.remainingUsd + budget.REMAINING_EPSILON)) {
    return { ...info, available: false, reason: 'budget' };
  }
  return info;
}

const making = new Map(); // file -> Promise of the sample that is being made

// A made sample of a voice the caller may use: { buffer, cached, costUsd }. It is read from the store where it exists; else the sentence is
// spoken once (budget: reserved before, booked after, for everybody; a participant's budget must cover it) and stored. Two clicks at once
// make it once.
async function madeSample(voiceId, viewer, { user = 'lokal', model, lang } = {}) {
  const voice = await findVoice(voiceId, viewer);
  if (voice.preview_url) throw new PreviewError('PREVIEW_AVAILABLE', 'This voice has a free sample; no sample is made', { reason: 'PREVIEW_AVAILABLE' });
  const modelId = pickModel(model);
  const language = pickLang(lang);
  const file = sampleFile(voice.voice_id, modelId, language);
  const stored = await readSample(file);
  if (stored) return { buffer: stored, cached: true, costUsd: 0 };

  let pending = making.get(file);
  const mine = !pending;
  if (!pending) {
    pending = (async () => {
      const text = SAMPLE_TEXTS[language];
      const estimate = tools.speechEstimateUsd(text, modelId);
      // refuses (BudgetError) when a participant's budget does not cover the price; chats and results stay available
      const grant = await budget.begin(viewer, { estimateUsd: estimate, label: 'Voice sample' });
      try {
        const buffer = await elevenlabs.tts({ text, voiceId: voice.voice_id, modelId });
        if (!buffer.length) throw new PreviewError('UPSTREAM', 'ElevenLabs delivered an empty sample');
        // The call is paid once ElevenLabs has answered: booked before the file is written, so a disk that fails cannot leave it unbooked
        if (estimate !== null) {
          await costs.recordCost({
            ts: new Date().toISOString(),
            sessionId: COST_SESSION,
            type: 'speech',
            model: `elevenlabs/${modelId}`,
            cost: estimate,
            billing: 'Schaetzung (Zeichen)',
            user: String(user || 'lokal')
          });
          grant.settle?.(estimate);
        }
        // a sample that cannot be stored is still delivered (the next click makes and pays it again)
        try {
          await writeSample(file, buffer);
        } catch (err) {
          console.warn(`[voice-preview] sample could not be stored: ${err.message}`);
        }
        return { buffer, costUsd: estimate || 0 };
      } finally {
        grant.release();
      }
    })().finally(() => making.delete(file));
    making.set(file, pending);
  }
  const result = await pending;
  // whoever waited for the one that made it did not pay
  return { buffer: result.buffer, cached: !mine, costUsd: mine ? result.costUsd : 0 };
}

// For the tests: forget what is kept in memory.
function clearCaches() {
  cache.clear();
  cacheBytes = 0;
  inFlight.clear();
  making.clear();
  voicesKept = null;
  voicesLoading = null;
}

module.exports = {
  PreviewError,
  SAMPLE_TEXTS,
  SAMPLES_DIR,
  COST_SESSION,
  CACHE_TTL_MS,
  CACHE_MAX_BYTES,
  VOICES_TTL_MS,
  findVoice,
  freePreview,
  sampleInfo,
  madeSample,
  sampleFile,
  pickLang,
  pickModel,
  isRestrictedViewer,
  clearCaches
};
