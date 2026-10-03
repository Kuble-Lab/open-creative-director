'use strict';

const { getSetting } = require('./settings');
const musicPlan = require('../public/nodes/music-plan');

const BASE_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 60 * 1000;
// Music takes longer than speech, so the wait grows with the length of the song: 90 s of margin plus the length. It stops at
// 300 s because fetch of Node (undici) gives up by itself after 300 s without an answer (headersTimeout): a longer wait
// would be a value that never takes effect. Songs of more than about 3.5 minutes therefore get the 300 s; if ElevenLabs
// needs longer, the call ends with ELEVENLABS_TIMEOUT (see musicTimeoutMs, SPEC §WP30). The 12 minutes a node may run
// (lib/nodes/engine.js) stay above it.
const MUSIC_TIMEOUT_BASE_MS = 90 * 1000;
const MUSIC_TIMEOUT_MAX_MS = 300 * 1000;
// Timeouts that fetch reports itself (err.cause.code): connection, no answer headers, no body in time. They count as
// ELEVENLABS_TIMEOUT, too.
const FETCH_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
// The one output format of the music (MP3, 44.1 kHz, 128 kbit/s), as for the speech.
const OUTPUT_FORMAT = 'mp3_44100_128';
// What the API takes for `music_length_ms` (compose and plan): 3 s to 10 min.
const MUSIC_MIN_MS = musicPlan.LIMITS.minLengthMs;
const MUSIC_MAX_MS = musicPlan.LIMITS.maxLengthMs;
const MUSIC_MODELS = musicPlan.MODELS;
const DEFAULT_MUSIC_MODEL_ID = musicPlan.DEFAULT_MODEL;
// Word times of a song (WP34): speech to text and forced alignment. The model of the transcription is the one that was
// tried against a real song (scribe_v1); ELEVENLABS_STT_MODEL swaps it (for example for a newer Scribe).
const STT_MODEL_ID = 'scribe_v1';
// Both calls answer within seconds for a song, so the wait is short: 60 s of margin plus one second per second of audio, never
// more than the 300 s after which fetch of Node (undici) gives up by itself (see MUSIC_TIMEOUT_MAX_MS).
const TIMING_TIMEOUT_BASE_MS = 60 * 1000;

// A failed call with a stable code. `message` is English (logs, Director), `messageDe` the German sentence for the
// interface fallback; `data` holds what the interface needs for its own text (for a refused prompt: `suggestion`).
//   MUSIC_SUBSCRIPTION_REQUIRED  the Music API needs a paid ElevenLabs plan
//   MUSIC_PROMPT_REJECTED        bad_prompt: names of artists or protected lyrics (data.suggestion: ElevenLabs' other prompt)
//   MUSIC_PLAN_REJECTED          bad_composition_plan: the same for the styles of a plan (data.suggestion: a plan as text)
//   ELEVENLABS_RATE_LIMITED      HTTP 429 (too many requests or runs at once)
//   ELEVENLABS_QUOTA_EXCEEDED    the credits of the plan are used up
//   ELEVENLABS_KEY_REJECTED      the key is not accepted
//   ELEVENLABS_TIMEOUT           no answer in time
//   ELEVENLABS_SERVER_ERROR      HTTP 5xx
class ElevenLabsError extends Error {
  constructor(code, message, messageDe, { status = null, data = null } = {}) {
    super(message);
    this.name = 'ElevenLabsError';
    this.code = code;
    this.status = status;
    this.messageDe = messageDe;
    this.data = data;
  }
}

function apiKey() {
  return String(getSetting('ELEVENLABS_API_KEY') || '').trim();
}

function hasKey() {
  return Boolean(apiKey());
}

function scrubKey(value, key) {
  const message = String(value || '');
  return key ? message.split(key).join('[ELEVENLABS-KEY]') : message;
}

function musicTimeoutMs(lengthMs) {
  const length = Number.isFinite(lengthMs) && lengthMs > 0 ? lengthMs : 0;
  return Math.min(MUSIC_TIMEOUT_MAX_MS, MUSIC_TIMEOUT_BASE_MS + length);
}

// The readable part of an error body: { detail: { status, message, data } } (also detail as text or a list of
// validation errors), as parsed JSON and as one line of text.
function readBody(text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    /* not JSON: the text is the message */
  }
  const detail = body && typeof body === 'object' ? body.detail : undefined;
  const status = detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.status === 'string' ? detail.status : '';
  const data = detail && typeof detail === 'object' && !Array.isArray(detail) && detail.data && typeof detail.data === 'object' ? detail.data : null;
  let message = '';
  if (body && typeof body === 'object') {
    message = detail?.message || detail || body.message || '';
    if (typeof message !== 'string') message = JSON.stringify(message);
  } else {
    message = text;
  }
  return { status, data, message };
}

const SUBSCRIPTION_HINT = /paid|subscription|upgrade|plan|tier|creator|starter/i;
const SUBSCRIPTION_STATUS = /^(paid_plan_required|payment_required|only_for_paid_subscriptions|subscription_required|upgrade_required|feature_not_available)/;

// A suggestion for another prompt or plan comes as text. A plan comes as the composition plan of the API; it is turned
// into the readable plan text so the interface can offer it as it is.
function suggestionOf(kind, data) {
  try {
    if (kind === 'prompt') {
      const value = data && (data.prompt_suggestion ?? data.promptSuggestion);
      return typeof value === 'string' ? value : '';
    }
    const value = data && (data.composition_plan_suggestion ?? data.compositionPlanSuggestion);
    if (typeof value === 'string') return value;
    return value && typeof value === 'object' ? musicPlan.stringify(musicPlan.fromApi(value)) : '';
  } catch (_) {
    return '';
  }
}

function classify(response, text, { scope, key }) {
  const status = response.status;
  const { status: detailStatus, data, message } = readBody(text);
  const clean = scrubKey(message, key).replace(/\s+/g, ' ').trim().slice(0, 600);
  // The speech (scope 'api', the Director and the voice list) keeps its German messages; the music nodes translate by code.
  const make = (code, en, de, extra = {}) => new ElevenLabsError(code, scope === 'api' ? de : en, de, { status, ...extra });

  if (detailStatus === 'bad_prompt' || detailStatus === 'bad_composition_plan') {
    const isPrompt = detailStatus === 'bad_prompt';
    const suggestion = scrubKey(suggestionOf(isPrompt ? 'prompt' : 'plan', data), key);
    const what = isPrompt ? 'description' : 'plan';
    const rejectedDe = isPrompt ? 'ElevenLabs nimmt diese Beschreibung nicht an: Sie nennt' : 'ElevenLabs nimmt diesen Plan nicht an: Er nennt';
    return make(
      isPrompt ? 'MUSIC_PROMPT_REJECTED' : 'MUSIC_PLAN_REJECTED',
      `ElevenLabs does not accept this ${what}: it names artists or uses protected lyrics.${suggestion ? ` Suggestion: ${suggestion}` : ''}`,
      `${rejectedDe} Künstler oder verwendet geschützte Texte.${suggestion ? ` Vorschlag: ${suggestion}` : ''}`,
      { data: { suggestion } }
    );
  }
  if (status === 429) {
    return make(
      'ELEVENLABS_RATE_LIMITED',
      'ElevenLabs is busy or the limit of your plan is reached (too many requests). Wait a moment and try again.',
      'ElevenLabs ist ausgelastet oder das Limit deines Abos ist erreicht (zu viele Anfragen). Warte einen Moment und versuche es erneut.'
    );
  }
  if (scope === 'music' && (status === 402 || SUBSCRIPTION_STATUS.test(detailStatus) || ((status === 401 || status === 403) && !/api key|api_key|invalid_api_key/i.test(`${detailStatus} ${clean}`) && SUBSCRIPTION_HINT.test(`${detailStatus} ${clean}`)))) {
    return make(
      'MUSIC_SUBSCRIPTION_REQUIRED',
      'The ElevenLabs Music API needs a paid ElevenLabs plan. Your account does not include it.',
      'Die ElevenLabs Music API braucht ein bezahltes ElevenLabs-Abo. Dein Konto enthält sie nicht.'
    );
  }
  if (detailStatus === 'quota_exceeded') {
    return make(
      'ELEVENLABS_QUOTA_EXCEEDED',
      'The credits of the ElevenLabs plan are used up.',
      'Die Credits des ElevenLabs-Abos sind aufgebraucht.'
    );
  }
  if (status === 401) {
    return make(
      'ELEVENLABS_KEY_REJECTED',
      'ElevenLabs does not accept the API key. Check it under Settings.',
      'ElevenLabs akzeptiert den API-Schlüssel nicht. Prüfe ihn unter Einstellungen.'
    );
  }
  if (status >= 500) {
    return make(
      'ELEVENLABS_SERVER_ERROR',
      `ElevenLabs reports an error on its side (HTTP ${status}). Try again later.`,
      `ElevenLabs meldet einen Fehler auf seiner Seite (HTTP ${status}). Versuche es später erneut.`
    );
  }
  const err = new Error(`ElevenLabs antwortete mit HTTP ${status}${clean ? `: ${clean}` : '.'}`);
  err.status = status;
  return err;
}

async function errorFromResponse(response, options) {
  let text = '';
  try {
    text = await response.text();
  } catch (_) {
    /* Eine unlesbare Fehlerantwort wird nur mit dem HTTP-Status gemeldet. */
  }
  return classify(response, text, options);
}

// Every part of a message the key could be in goes through here before the error leaves the module.
function scrubError(err, key) {
  err.message = scrubKey(err.message, key);
  if (err.messageDe) err.messageDe = scrubKey(err.messageDe, key);
  if (err.data && typeof err.data.suggestion === 'string') err.data.suggestion = scrubKey(err.data.suggestion, key);
  return err;
}

async function request(pathname, options, consume, { timeoutMs = TIMEOUT_MS, scope = 'api' } = {}) {
  const key = apiKey();
  if (!key) throw new Error('Kein ELEVENLABS_API_KEY hinterlegt — unter ⚙️ Einstellungen setzen.');

  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      ...options,
      headers: {
        'xi-api-key': key,
        ...(options?.headers || {})
      },
      signal: controller.signal
    });
    if (!response.ok) throw await errorFromResponse(response, { scope, key });
    return await consume(response);
  } catch (err) {
    const fetchTimeout = !controller.signal.aborted && FETCH_TIMEOUT_CODES.has(err?.cause?.code);
    if (controller.signal.aborted || fetchTimeout) {
      // our own timer: the value that was set; a timeout of fetch itself: the time that really passed
      const seconds = Math.round((fetchTimeout ? Math.min(timeoutMs, Date.now() - startedAt) : timeoutMs) / 1000);
      const de = `ElevenLabs antwortet nicht (Timeout nach ${seconds} Sekunden).`;
      const en = `ElevenLabs did not answer in time (timeout after ${seconds} s).`;
      throw new ElevenLabsError('ELEVENLABS_TIMEOUT', scope === 'api' ? de : en, de, { data: { seconds } });
    }
    throw scrubError(err instanceof Error ? err : new Error(String(err)), key);
  } finally {
    clearTimeout(timer);
  }
}

async function tts({ text, voiceId, modelId }) {
  return request(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId })
    },
    async (response) => Buffer.from(await response.arrayBuffer())
  );
}

function badArgument(message) {
  const err = new Error(message);
  err.code = 'MUSIC_BAD_ARGUMENT';
  return err;
}

function checkMusicModel(modelId) {
  const model = String(modelId || DEFAULT_MUSIC_MODEL_ID).trim();
  if (!MUSIC_MODELS.includes(model)) throw badArgument(`Unbekanntes Musikmodell: ${model}`);
  return model;
}

function checkMusicLength(lengthMs) {
  if (!Number.isInteger(lengthMs) || lengthMs < MUSIC_MIN_MS || lengthMs > MUSIC_MAX_MS) {
    throw badArgument(`Die Länge der Musik muss zwischen ${MUSIC_MIN_MS} und ${MUSIC_MAX_MS} Millisekunden liegen.`);
  }
  return lengthMs;
}

// Music as MP3. Either a description (`prompt`, with the length and `instrumental`) or a composition plan
// (`compositionPlan`, as the API takes it for the model: see public/nodes/music-plan.js toApi()); the API takes
// length and instrumental only together with a description. The length of a plan comes from its sections.
async function composeMusic({ prompt, compositionPlan, lengthMs, instrumental, modelId } = {}) {
  const model = checkMusicModel(modelId);
  const hasPrompt = typeof prompt === 'string' && prompt.trim() !== '';
  const hasPlan = compositionPlan !== undefined && compositionPlan !== null;
  if (hasPrompt === hasPlan) throw badArgument('Musik braucht entweder eine Beschreibung oder einen Plan, nicht beides.');
  const body = { model_id: model };
  let expectedMs;
  if (hasPrompt) {
    body.prompt = prompt.trim();
    if (lengthMs !== undefined && lengthMs !== null) body.music_length_ms = checkMusicLength(lengthMs);
    if (instrumental === true) body.force_instrumental = true;
    expectedMs = body.music_length_ms;
  } else {
    if (lengthMs !== undefined && lengthMs !== null) throw badArgument('Die Länge gilt nur für eine Beschreibung; ein Plan bringt sie mit.');
    if (instrumental === true) throw badArgument('„Instrumental“ gilt nur für eine Beschreibung.');
    body.composition_plan = compositionPlan;
    expectedMs = (compositionPlan.sections || compositionPlan.chunks || []).reduce((sum, item) => sum + (Number(item.duration_ms) || 0), 0);
  }
  const buffer = await request(
    `/v1/music?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body)
    },
    async (response) => Buffer.from(await response.arrayBuffer()),
    { timeoutMs: musicTimeoutMs(expectedMs), scope: 'music' }
  );
  return buffer;
}

// A composition plan (song text and structure) for a description, in the shape of the model: sections for music_v1,
// chunks for the others. The API does not charge credits for it (it counts against the limits of the plan).
async function planMusic({ prompt, lengthMs, modelId } = {}) {
  const model = checkMusicModel(modelId);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw badArgument('Der Plan braucht eine Beschreibung.');
  const body = { prompt: text, model_id: model };
  if (lengthMs !== undefined && lengthMs !== null) body.music_length_ms = checkMusicLength(lengthMs);
  return request(
    '/v1/music/plan',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    },
    (response) => response.json(),
    { scope: 'music' }
  );
}

function timingTimeoutMs(durationSec) {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.min(MUSIC_TIMEOUT_MAX_MS, TIMING_TIMEOUT_BASE_MS + Math.round(seconds * 1000));
}

function timingArgument(message) {
  const err = new Error(message);
  err.code = 'TIMING_BAD_ARGUMENT';
  return err;
}

// The upload of both calls: the audio file as multipart (FormData and Blob are part of Node). fetch sets the content type with
// its boundary itself, so none is passed.
function audioForm({ audio, filename, mime }, fields) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw timingArgument('The audio file is empty.');
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(name, String(value));
  }
  form.append('file', new Blob([audio], { type: mime || 'application/octet-stream' }), filename || 'audio.mp3');
  return form;
}

// The words of an answer as plain { text, start, end } (seconds) plus what the call returned beyond that (`type` of speech to
// text: word | spacing | audio_event; `loss` of the alignment: how well the word fits the audio). Entries without usable times
// are dropped here; the rest of the clean-up (whitespace, a wrong first word, held notes) is lib/lyrics-timing.js.
function timedWords(list) {
  if (!Array.isArray(list)) return [];
  const words = [];
  for (const item of list) {
    if (!item || typeof item.text !== 'string') continue;
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const word = { text: item.text, start, end };
    if (typeof item.type === 'string') word.type = item.type;
    if (Number.isFinite(item.loss)) word.loss = Number(item.loss);
    words.push(word);
  }
  return words;
}

// Forced alignment: where the words of a known text are sung or spoken in an audio file. { words: [{ text, start, end, loss }],
// characters: [{ text, start, end }], loss } with times in seconds. The characters tell where the first word really starts
// (see lib/lyrics-timing.js). The API charges by the length of the audio (see lyricsTimingUsd in lib/tools.js).
async function forcedAlignment({ audio, filename, mime, text, durationSec } = {}) {
  const lyrics = typeof text === 'string' ? text.trim() : '';
  if (!lyrics) throw timingArgument('The alignment needs the text that is sung.');
  const form = audioForm({ audio, filename, mime }, { text: lyrics });
  const body = await request(
    '/v1/forced-alignment',
    { method: 'POST', headers: { Accept: 'application/json' }, body: form },
    (response) => response.json(),
    { timeoutMs: timingTimeoutMs(durationSec), scope: 'timing' }
  );
  return { words: timedWords(body?.words), characters: timedWords(body?.characters), loss: Number.isFinite(body?.loss) ? Number(body.loss) : null };
}

// Speech to text with a time for every word: { words: [{ text, start, end, type }], text, language, duration } with times in
// seconds; duration is the length of the audio as ElevenLabs measured it (null if the answer has none).
// Audio events are not tagged (a held note must not turn into "(music)"), speakers are not told apart.
async function speechToText({ audio, filename, mime, durationSec, languageCode, modelId } = {}) {
  const model = String(modelId || process.env.ELEVENLABS_STT_MODEL || STT_MODEL_ID).trim();
  const form = audioForm(
    { audio, filename, mime },
    { model_id: model, timestamps_granularity: 'word', tag_audio_events: 'false', diarize: 'false', language_code: languageCode }
  );
  const body = await request(
    '/v1/speech-to-text',
    { method: 'POST', headers: { Accept: 'application/json' }, body: form },
    (response) => response.json(),
    { timeoutMs: timingTimeoutMs(durationSec), scope: 'timing' }
  );
  return {
    words: timedWords(body?.words),
    text: typeof body?.text === 'string' ? body.text : '',
    language: typeof body?.language_code === 'string' ? body.language_code : '',
    duration: Number.isFinite(body?.audio_duration_secs) && body.audio_duration_secs > 0 ? Number(body.audio_duration_secs) : null
  };
}

async function listVoices() {
  const body = await request(
    '/v1/voices',
    { method: 'GET', headers: { Accept: 'application/json' } },
    (response) => response.json()
  );
  const voices = Array.isArray(body?.voices) ? body.voices : [];
  return voices
    .filter((voice) => typeof voice?.voice_id === 'string' && voice.voice_id.trim())
    .map((voice) => ({
      voice_id: voice.voice_id.trim(),
      name: typeof voice.name === 'string' && voice.name.trim() ? voice.name.trim() : voice.voice_id.trim(),
      ...(typeof voice.category === 'string' && voice.category.trim() ? { category: voice.category.trim() } : {}),
      ...(voice.labels && typeof voice.labels === 'object' && !Array.isArray(voice.labels)
        ? { labels: voice.labels }
        : {})
    }));
}

module.exports = {
  hasKey,
  tts,
  listVoices,
  composeMusic,
  planMusic,
  musicTimeoutMs,
  forcedAlignment,
  speechToText,
  timingTimeoutMs,
  ElevenLabsError,
  TIMEOUT_MS,
  MUSIC_TIMEOUT_MAX_MS,
  MUSIC_MODELS,
  DEFAULT_MUSIC_MODEL_ID,
  MUSIC_MIN_MS,
  MUSIC_MAX_MS,
  STT_MODEL_ID
};
