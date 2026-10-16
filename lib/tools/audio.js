'use strict';

// Speech, music and lyric timing tools, moved from lib/tools.js.

const elevenlabs = require('../elevenlabs');
const access = require('../access');
const store = require('../store');
const resultMeta = require('../result-meta');
const musicPlan = require('../../public/nodes/music-plan');
const voiceDetect = require('../voice-detect');
const lyricsTiming = require('../lyrics-timing');
const path = require('path');
const fsp = require('fs/promises');
const ffmpeg = require('../ffmpeg');
const {
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_MODEL_ID,
  viewerOfCtx,
  shorten,
  recordToolCost,
  TIMING_METHODS,
  TIMING_VOICES,
  TIMING_UPLOAD_MIME,
  TIMING_MAX_SECONDS,
  TIMING_MAX_BYTES
} = require('./shared');

function requireElevenLabsKey() {
  if (!elevenlabs.hasKey()) {
    throw new Error('Kein ELEVENLABS_API_KEY hinterlegt — unter ⚙️ Einstellungen setzen.');
  }
}

// What a speech call needs: the text, the voice and the model, checked. Participants and guests get only the library voices.
async function prepareSpeech(ctx, args) {
  requireElevenLabsKey();
  const text = String(args.text || '').trim();
  const characters = [...text];
  if (!text) throw new Error('text fehlt');
  if (characters.length > 2500) throw new Error('text darf maximal 2500 Zeichen lang sein');
  const voiceId = String(args.voice_id || DEFAULT_ELEVENLABS_VOICE_ID).trim();
  const modelId = String(args.model_id || DEFAULT_ELEVENLABS_MODEL_ID).trim();
  if (!voiceId) throw new Error('voice_id darf nicht leer sein');
  if (!modelId) throw new Error('model_id darf nicht leer sein');
  // Participants and guests: only the library voices, not the cloned voices of the operator's account.
  if (access.isRestricted(viewerOfCtx(ctx)) && voiceId !== DEFAULT_ELEVENLABS_VOICE_ID) {
    const allowed = await libraryVoices();
    if (!allowed.some((voice) => voice.voice_id === voiceId)) {
      throw new access.RoleRestrictedError('voices', 'This voice is not available for your account', 'Diese Stimme ist für dein Konto nicht verfügbar.');
    }
  }
  return { text, characters, voiceId, modelId };
}

// Stores the audio of a speech call as an asset and books its cost. The estimate is booked for everybody, internal people included, so
// the cost overview shows what ElevenLabs costs; for a participant it is also what counts against the budget.
async function saveSpeech(ctx, { text, modelId, buffer }) {
  const speechCost = speechEstimateUsd(text, modelId);
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'audio',
    buffer,
    ext: '.mp3',
    prompt: `ElevenLabs Sprache: ${shorten(text, 160)}`,
    cost: speechCost,
    costEstimated: speechCost !== null,
    model: `elevenlabs/${modelId}`
  });
  if (speechCost !== null) {
    await recordToolCost(
      {
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        assetId: asset.id,
        type: 'speech',
        model: `elevenlabs/${modelId}`,
        cost: speechCost,
        billing: 'Schaetzung (Zeichen)',
        user: ctx.user || 'lokal'
      },
      ctx
    );
  }
  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'audio', prompt: asset.prompt, cost: speechCost, ...(speechCost !== null ? { costEstimated: true } : {}), ...resultMeta.describe(asset) }
  });
  return asset;
}

async function runGenerateSpeech(ctx, args) {
  const { text, characters, voiceId, modelId } = await prepareSpeech(ctx, args);

  ctx.emit({
    type: 'tool_start',
    tool: 'generate_speech',
    label: `Erzeuge Sprache mit ElevenLabs: ${shorten(text, 80)}`
  });
  const buffer = await elevenlabs.tts({ text, voiceId, modelId });
  if (!buffer.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  const asset = await saveSpeech(ctx, { text, modelId, buffer });
  return {
    toolResult:
      `Sprache erzeugt: ${asset.id} (${characters.length} Zeichen). ` +
      `Nutze ${asset.id} als Voice-Master beim Casting oder in reference_audio_asset_ids fuer Seedance.`,
    inject: [],
    asset
  };
}

// Node view only (NODE_ONLY_TOOLS), paid like the speech: the same text, voice, model, price and booking, but with the time of every
// character (the explainer video lets its scenes appear in the beat of the voice). previous_text and next_text (the narration of the
// scenes around) are sent along where there are any; the answer says whether the API refused them (`contextDropped`).
// Returns { asset, alignment: { characters, starts, ends } | null, contextDropped }.
async function runGenerateSpeechTimed(ctx, args) {
  const { text, characters, voiceId, modelId } = await prepareSpeech(ctx, args);
  ctx.emit({
    type: 'tool_start',
    tool: 'generate_speech_timed',
    label: `Erzeuge Sprache mit Wortzeiten (ElevenLabs): ${shorten(text, 80)}`
  });
  const answer = await elevenlabs.ttsWithTimestamps({
    text,
    voiceId,
    modelId,
    previousText: typeof args.previous_text === 'string' ? args.previous_text.trim() : '',
    nextText: typeof args.next_text === 'string' ? args.next_text.trim() : '',
    // another take of the same text (the feedback on a scene, WP56)
    seed: Number.isInteger(args.seed) ? args.seed : undefined
  });
  if (!answer.audio.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  const asset = await saveSpeech(ctx, { text, modelId, buffer: answer.audio });
  return {
    toolResult: `Sprache mit Wortzeiten erzeugt: ${asset.id} (${characters.length} Zeichen).`,
    inject: [],
    asset,
    alignment: answer.alignment,
    contextDropped: answer.contextDropped,
    seedDropped: Boolean(answer.seedDropped)
  };
}

// The code and the values of the first problem of a plan text (public/nodes/music-plan.js): the node shows the cause in
// the interface language, with the line number.
function musicPlanError(problem) {
  const err = new Error(problem.message);
  err.code = problem.code;
  err.data = { ...problem.data };
  return err;
}

// What a generate_music call is about: a plan text (plan_text, the length comes from its sections) or a description
// (prompt with length_seconds and instrumental). Throws for anything the API would refuse.
function musicRequest(args) {
  const modelId = String(args?.model_id || elevenlabs.DEFAULT_MUSIC_MODEL_ID).trim();
  if (!elevenlabs.MUSIC_MODELS.includes(modelId)) throw new Error(`model_id: unbekanntes Musikmodell ${modelId}`);
  const planText = String(args?.plan_text || '').trim();
  if (planText) {
    const { plan, errors } = musicPlan.parse(planText, { model: modelId });
    const problem = errors[0];
    if (problem) throw musicPlanError(problem);
    return { mode: 'plan', modelId, lengthMs: musicPlan.totalMs(plan), compositionPlan: musicPlan.toApi(plan, modelId), summary: plan.positive.join(', ') || plan.sections.map((section) => section.name).filter(Boolean).join(', ') };
  }
  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt oder plan_text fehlt');
  const seconds = Number(args?.length_seconds);
  const lengthMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || lengthMs < elevenlabs.MUSIC_MIN_MS || lengthMs > elevenlabs.MUSIC_MAX_MS) {
    throw new Error(`length_seconds muss zwischen ${elevenlabs.MUSIC_MIN_MS / 1000} und ${elevenlabs.MUSIC_MAX_MS / 1000} liegen`);
  }
  return { mode: 'prompt', modelId, prompt, lengthMs, instrumental: args?.instrumental === true, summary: prompt };
}

// Node view only (NODE_ONLY_TOOLS), paid: the estimate by minute is reserved and booked for everybody as a cost of the type music.
async function runGenerateMusic(ctx, args) {
  requireElevenLabsKey();
  const request = musicRequest(args);
  const seconds = Math.round(request.lengthMs / 100) / 10;
  ctx.emit({
    type: 'tool_start',
    tool: 'generate_music',
    label: `Erzeuge Musik mit ElevenLabs (${seconds} s): ${shorten(request.summary, 80)}`
  });
  const buffer = await elevenlabs.composeMusic(
    request.mode === 'plan'
      ? { compositionPlan: request.compositionPlan, modelId: request.modelId }
      : { prompt: request.prompt, lengthMs: request.lengthMs, instrumental: request.instrumental, modelId: request.modelId }
  );
  if (!buffer.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  const musicCost = musicEstimateUsd(request.lengthMs);
  const model = `elevenlabs/${request.modelId}`;
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'audio',
    buffer,
    ext: '.mp3',
    prompt: `ElevenLabs Musik: ${shorten(request.summary, 160)}`,
    cost: musicCost,
    costEstimated: musicCost !== null,
    model
  });
  if (musicCost !== null) {
    await recordToolCost(
      {
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        assetId: asset.id,
        type: 'music',
        model,
        cost: musicCost,
        billing: 'Schaetzung (Dauer)',
        user: ctx.user || 'lokal'
      },
      ctx
    );
  }
  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'audio', prompt: asset.prompt, cost: musicCost, ...(musicCost !== null ? { costEstimated: true } : {}), ...resultMeta.describe(asset) }
  });
  return { toolResult: `Musik erzeugt: ${asset.id} (${seconds} Sekunden).`, inject: [], asset };
}

// Node view only, free of credits: song text and structure for an idea, as the readable plan text.
async function runPlanMusic(ctx, args) {
  requireElevenLabsKey();
  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const modelId = String(args?.model_id || elevenlabs.DEFAULT_MUSIC_MODEL_ID).trim();
  if (!elevenlabs.MUSIC_MODELS.includes(modelId)) throw new Error(`model_id: unbekanntes Musikmodell ${modelId}`);
  let lengthMs;
  if (args?.length_seconds !== undefined && args.length_seconds !== null && args.length_seconds !== '') {
    lengthMs = Math.round(Number(args.length_seconds) * 1000);
    if (!(lengthMs >= elevenlabs.MUSIC_MIN_MS && lengthMs <= elevenlabs.MUSIC_MAX_MS)) {
      throw new Error(`length_seconds muss zwischen ${elevenlabs.MUSIC_MIN_MS / 1000} und ${elevenlabs.MUSIC_MAX_MS / 1000} liegen`);
    }
  }
  ctx.emit({ type: 'tool_start', tool: 'plan_music', label: `Plane Songtext und Aufbau mit ElevenLabs: ${shorten(prompt, 80)}` });
  const api = await elevenlabs.planMusic({ prompt, lengthMs, modelId });
  const plan = musicPlan.fromApi(api);
  const planText = musicPlan.stringify(plan);
  return { toolResult: `Songtext und Aufbau (${plan.sections.length} Abschnitte):\n${planText}`, inject: [], planText, plan };
}

// An error with a stable code (upper case words) that the node view shows in the interface language.
function timingError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

// Whether the tool asks Gemini who sings the lines: `voices: auto`, a key, and a text without marks of a choir (marks always win).
function timingDetectsVoices(args) {
  return args?.voices === 'auto' && voiceDetect.hasKey() && !lyricsTiming.hasChoirMarks(typeof args?.text === 'string' ? args.text : '');
}

// Who sings the lines of a timing that has no marks (`voices: auto`): Gemini hears the song (lib/voice-detect.js) and every line gets `voice`
// ('lead', 'choir' or 'both'); the timing says how it was found (`voices`). Without a key or after a failure there is no detection, the lines stay
// the figure's and `voices` says why ({ source: 'none', reason }: no_key, no_audio, no_credit (HTTP 402: the prepaid credit of the key is used
// up), key (HTTP 401 or 403: Google refuses the key) or failed). Never throws, except when the run is stopped. Returns { timing, usd, note }.
async function detectTimingVoices(ctx, { file, timing, duration }) {
  if (!timing.lines.length) return { timing, usd: 0, note: '' };
  if (!voiceDetect.hasKey()) return { timing: { ...timing, voices: { source: 'none', reason: 'no_key' } }, usd: 0, note: 'no GEMINI_API_KEY' };
  ctx.emit?.({ type: 'tool_start', tool: 'lyrics_timing', label: 'Höre, wer welche Zeile singt (Gemini)' });
  try {
    const { audio, mime } = await voiceDetect.compressAudio(file, { signal: ctx.signal });
    const found = await voiceDetect.detectVoices({ audio, mime, lines: timing.lines, seconds: duration });
    await recordToolCost({ ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'brain', model: `google/${found.model}`, cost: found.usd, ...(found.usage ? { usage: found.usage } : {}), user: ctx.user || 'lokal' }, ctx);
    const lines = timing.lines.map((line, index) => ({ ...line, voice: voiceDetect.voiceOf(found.voices[index]) }));
    const choir = lines.filter((line) => line.voice === 'choir').length;
    return { timing: { ...timing, lines, voices: { source: 'detect', model: found.model, choir } }, usd: found.usd, note: '' };
  } catch (err) {
    if (err?.name === 'AbortError' || ctx.signal?.aborted) throw err;
    const usd = Number.isFinite(err?.usd) && err.usd > 0 ? err.usd : 0;
    if (usd) await recordToolCost({ ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'brain', model: `google/${voiceDetect.model()}`, cost: usd, user: ctx.user || 'lokal' }, ctx);
    const refused = err?.code === 'VOICES_HTTP' ? err.status : 0;
    const reason = err?.code === 'VOICES_NO_AUDIO' ? 'no_audio' : refused === 402 ? 'no_credit' : refused === 401 || refused === 403 ? 'key' : 'failed';
    return { timing: { ...timing, voices: { source: 'none', reason } }, usd, note: String(err?.summary || err?.code || err?.message || err).slice(0, 120) };
  }
}

async function runLyricsTiming(ctx, args) {
  requireElevenLabsKey();
  const method = args?.method === undefined || args?.method === null || args?.method === '' ? 'auto' : String(args.method);
  if (!TIMING_METHODS.includes(method)) throw new Error(`method muss ${TIMING_METHODS.join(', ')} sein`);
  const voices = args?.voices === undefined || args?.voices === null || args?.voices === '' ? 'off' : String(args.voices);
  if (!TIMING_VOICES.includes(voices)) throw new Error(`voices muss ${TIMING_VOICES.join(', ')} sein`);
  // a pasted text or a song plan: only the sung lines count; a line of a choir is one of them and keeps its mark (WP48)
  const lines = lyricsTiming.markedLines(typeof args?.text === 'string' ? args.text : '');
  const marked = lines.some((line) => line.voice === 'choir');
  const mode = method === 'auto' ? (lines.length ? 'align' : 'transcribe') : method;
  if (mode === 'align' && !lines.length) throw timingError('TIMING_NO_LYRICS', 'The alignment needs the text that is sung (method align, but no lyrics)');

  const id = String(args?.audio_asset_id || '').trim();
  if (!id) throw new Error('audio_asset_id fehlt');
  const entry = (await store.readLedger(ctx.sessionId)).find((item) => item.id === id);
  if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
  if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
  const fileName = String(entry.file || '');
  const ext = path.extname(fileName).toLowerCase();
  if (!fileName || path.basename(fileName) !== fileName || !Object.prototype.hasOwnProperty.call(TIMING_UPLOAD_MIME, ext)) {
    throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) ist keine Audio-Datei (erlaubt: mp3, wav, m4a, aac).`);
  }
  const file = path.join(store.sessionAssetDir(ctx.sessionId), fileName);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new Error(`Die Datei von Asset ${id} fehlt.`);
  // The length decides the price, so it is measured here. Without ffprobe the caller's figure counts, and after the call the
  // length the API reports (or the end of the last word).
  let duration = null;
  const binaries = ffmpeg.binaries();
  if (binaries.available) {
    let probe;
    try {
      probe = await require('../nodes/ffmpeg-ops').probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    } catch (err) {
      if (err?.name === 'AbortError' || ctx.signal?.aborted) throw err;
      throw timingError('TIMING_BAD_ARGUMENT', `The audio file cannot be read: ${shorten(err.message, 160)}`);
    }
    if (!probe.audio || !(probe.duration > 0)) throw timingError('TIMING_BAD_ARGUMENT', 'The audio file has no sound that can be read.');
    duration = Math.round(probe.duration * 1000) / 1000;
  } else if (Number(args?.duration_seconds) > 0) {
    duration = Math.round(Number(args.duration_seconds) * 1000) / 1000;
  }
  if ((duration !== null && duration > TIMING_MAX_SECONDS) || stat.size > TIMING_MAX_BYTES) {
    throw timingError('TIMING_AUDIO_TOO_LONG', `The audio is longer than ${TIMING_MAX_SECONDS / 60} minutes (or larger than ${TIMING_MAX_BYTES / (1024 * 1024)} MB)`, { minutes: TIMING_MAX_SECONDS / 60 });
  }
  const audio = await fsp.readFile(file);
  ctx.emit({
    type: 'tool_start',
    tool: 'lyrics_timing',
    label: mode === 'align' ? 'Richte den Songtext am Audio aus (ElevenLabs)' : 'Erkenne die Wörter des Songs (ElevenLabs)'
  });
  const upload = { audio, filename: fileName, mime: TIMING_UPLOAD_MIME[ext], durationSec: duration };
  let timing;
  let model;
  let reported = null;
  if (mode === 'align') {
    model = 'forced-alignment';
    const answer = await elevenlabs.forcedAlignment({ ...upload, text: lines.map((line) => line.text).join('\n') });
    timing = lyricsTiming.fromAlignment(answer, lines, { duration });
  } else {
    model = process.env.ELEVENLABS_STT_MODEL || elevenlabs.STT_MODEL_ID;
    const answer = await elevenlabs.speechToText(upload);
    reported = answer.duration;
    timing = lyricsTiming.fromTranscript(answer, lines, { duration: duration || reported });
  }
  if (duration === null) duration = reported || timing.duration || null;
  // by the measured length, booked for everybody (like the speech and the music)
  const cost = lyricsTimingUsd(duration);
  await recordToolCost(
    {
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      type: 'speech',
      model: `elevenlabs/${model}`,
      cost,
      billing: 'Schaetzung (Dauer)',
      user: ctx.user || 'lokal'
    },
    ctx
  );
  // who sings the lines: the marks of the text, else (voices: auto) Gemini; without either the timing is the one of before
  let voicesUsd = 0;
  let voicesNote = '';
  if (voices === 'auto' && !marked) {
    const detected = await detectTimingVoices(ctx, { file, timing, duration });
    timing = detected.timing;
    voicesUsd = detected.usd;
    voicesNote = detected.note;
  }
  return {
    toolResult: `Songtext-Zeiten (${mode === 'align' ? 'Ausrichtung' : 'Erkennung'}): ${timing.lines.length} Zeilen, ${timing.words.length} Wörter.`,
    inject: [],
    timing,
    readable: lyricsTiming.readableLyrics(timing),
    method: mode,
    durationSeconds: duration,
    costUsd: cost,
    ...(voicesUsd ? { voicesUsd } : {}),
    ...(voicesNote ? { voicesNote } : {})
  };
}

function voiceLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return '';
  const entries = Object.entries(labels)
    .filter(([key, value]) => key && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .map(([key, value]) => `${key}=${value}`);
  return entries.length ? ` (${entries.join(', ')})` : '';
}

// The voices of ElevenLabs' own library (category "premade"): what participants may use.
async function libraryVoices() {
  return (await elevenlabs.listVoices()).filter((voice) => voice.category === 'premade');
}

async function runListVoices(ctx) {
  requireElevenLabsKey();
  ctx.emit({ type: 'tool_start', tool: 'list_voices', label: 'Lade ElevenLabs-Stimmen' });
  const voices = access.isRestricted(viewerOfCtx(ctx)) ? await libraryVoices() : await elevenlabs.listVoices();
  const lines = voices.map((voice) => `- ${voice.name}: ${voice.voice_id}${voiceLabels(voice.labels)}`);
  return {
    toolResult: lines.length
      ? `Verfuegbare ElevenLabs-Stimmen (${lines.length}):\n${lines.join('\n')}`
      : 'ElevenLabs meldet keine verfuegbaren Stimmen.',
    inject: []
  };
}

// ElevenLabs bills per character, and the price depends on the model. The price page (https://elevenlabs.io/pricing/api, read
// 2026-10-03, the same for every plan) lists 0.08 USD per 1000 characters for Eleven v4, v3 and Multilingual v2 and 0.04 for
// v4 Turbo, v3 Conversational and Flash / Turbo (v4 and v4 Turbo are 72% off until 12 October 2026; that offer is not counted).
// The estimate is reserved before the call and booked afterwards: ELEVENLABS_USD_PER_1K_CHARS (default 0.08, the list price)
// is the price of a full-price model, the half-price models count half of it, and a model that is not named here counts as
// full price.
const SPEECH_DEFAULT_USD_PER_1K_CHARS = 0.08;

const SPEECH_MAX_CHARS = 2500;

const SPEECH_HALF_PRICE_MODELS = new Set([
  'eleven_v4_turbo',
  'eleven_v3_conversational',
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'eleven_flash_v2',
  'eleven_turbo_v2'
]);

function speechUsdPerChar(modelId) {
  const perThousand = Number(process.env.ELEVENLABS_USD_PER_1K_CHARS);
  const model = String(modelId || '').trim() || DEFAULT_ELEVENLABS_MODEL_ID;
  const share = SPEECH_HALF_PRICE_MODELS.has(model) ? 0.5 : 1;
  return ((Number.isFinite(perThousand) && perThousand > 0 ? perThousand : SPEECH_DEFAULT_USD_PER_1K_CHARS) * share) / 1000;
}

function speechEstimateUsd(text, modelId) {
  const chars = Math.min([...String(text || '').trim()].length, SPEECH_MAX_CHARS);
  return chars > 0 ? Math.round(chars * speechUsdPerChar(modelId) * 1e6) / 1e6 : null;
}

// Music is billed by the minute (the API list price is 0.15 USD; the default leaves some room). The estimate is booked
// for everybody, like the speech, and reserved for participants before the call.
const MUSIC_DEFAULT_USD_PER_MIN = 0.2;

function musicUsdPerMinute() {
  const perMinute = Number(process.env.ELEVENLABS_MUSIC_USD_PER_MIN);
  return Number.isFinite(perMinute) && perMinute > 0 ? perMinute : MUSIC_DEFAULT_USD_PER_MIN;
}

function musicEstimateUsd(lengthMs) {
  return Number.isFinite(lengthMs) && lengthMs > 0 ? Math.round((lengthMs / 60000) * musicUsdPerMinute() * 1e6) / 1e6 : null;
}

// Word times are billed by the hour of audio. ElevenLabs lists speech to text with Scribe v2 (the model of the transcription,
// see elevenlabs.STT_MODEL_ID) at 0.22 USD per hour (https://elevenlabs.io/pricing/api, read 2026-10-03), and the forced
// alignment costs the same (https://elevenlabs.io/docs/capabilities/forced-alignment). That list price is the default, and
// ELEVENLABS_TIMING_USD_PER_HOUR replaces it. Without a known length the estimate counts the longest song people usually bring
// (an upper bound); what is booked is always the measured length.
const TIMING_DEFAULT_USD_PER_HOUR = 0.22;

const TIMING_ESTIMATE_SECONDS = 10 * 60;

function timingUsdPerHour() {
  const perHour = Number(process.env.ELEVENLABS_TIMING_USD_PER_HOUR);
  return Number.isFinite(perHour) && perHour > 0 ? perHour : TIMING_DEFAULT_USD_PER_HOUR;
}

function lyricsTimingUsd(durationSec) {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? Math.min(durationSec, TIMING_MAX_SECONDS) : TIMING_ESTIMATE_SECONDS;
  return Math.round((seconds / 3600) * timingUsdPerHour() * 1e6) / 1e6;
}

module.exports = {
  runGenerateSpeech,
  runGenerateSpeechTimed,
  runListVoices,
  runGenerateMusic,
  runPlanMusic,
  runLyricsTiming,
  speechEstimateUsd,
  lyricsTimingUsd,
  timingDetectsVoices,
  TIMING_ESTIMATE_SECONDS,
  musicEstimateUsd,
  musicRequest,
  libraryVoices
};
