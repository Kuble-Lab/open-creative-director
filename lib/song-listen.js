'use strict';

const audio = require('./voice-detect');

function model() {
  const value = String(process.env.GEMINI_SONG_MODEL || '').trim();
  return /^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(value) ? value : audio.DEFAULT_MODEL;
}

function promptText(problem = '') {
  return 'Listen to this song. Describe its sound in English, not imagined visuals. Return only a JSON object with ' +
    'genre (string), subgenre (string), mood (array of words), tempoFeel (string), instruments (array of strings), vocals (string), ' +
    'energyArc (short string), cutsPerMinute (integer from 14 to 40), summary (one sentence). ' +
    'Suggest music-video cut density: laid-back 14–18, medium pop 22–26, fast and energetic 30–40 cuts per minute. ' +
    (problem ? `The previous answer was invalid: ${problem}. Follow the schema exactly.` : '');
}

function readSound(text) {
  let value;
  try { value = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch (_) { return { problem: 'invalid JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'expected an object' };
  const sound = {};
  for (const name of ['genre', 'subgenre', 'tempoFeel', 'vocals', 'energyArc', 'summary']) {
    if (typeof value[name] !== 'string' || !value[name].trim() || value[name].length > 1000) return { problem: `invalid ${name}` };
    sound[name] = value[name].trim();
  }
  for (const name of ['mood', 'instruments']) {
    if (!Array.isArray(value[name]) || !value[name].length || value[name].length > 30 || value[name].some((v) => typeof v !== 'string' || !v.trim() || v.length > 100)) return { problem: `invalid ${name}` };
    sound[name] = value[name].map((v) => v.trim());
  }
  if (typeof value.cutsPerMinute !== 'number' || !Number.isFinite(value.cutsPerMinute)) return { problem: 'invalid cutsPerMinute' };
  // A density is advice, so round and clamp it instead of paying again for an otherwise useful answer.
  sound.cutsPerMinute = Math.max(14, Math.min(40, Math.round(value.cutsPerMinute)));
  return { sound };
}

function listenSong(options) {
  return audio.requestAudio({ ...options, lines: [], modelCode: model(), prompt: promptText, readAnswer: readSound, retryStatus: (status) => status === 408 || status === 429 || (status >= 500 && status <= 599) });
}

module.exports = { model, hasKey: audio.hasKey, compressAudio: audio.compressAudio, estimateUsd: (seconds) => audio.estimateUsd(seconds, 0), listenSong, readSound, promptText };
