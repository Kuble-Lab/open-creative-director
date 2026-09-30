'use strict';

const { getSetting } = require('./settings');

const BASE_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 60 * 1000;

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

async function errorFromResponse(response, key) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      detail = body?.detail?.message || body?.detail || body?.message || text;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch (_) {
      detail = text;
    }
  } catch (_) {
    /* Eine unlesbare Fehlerantwort wird nur mit dem HTTP-Status gemeldet. */
  }
  const clean = scrubKey(detail, key).replace(/\s+/g, ' ').trim().slice(0, 600);
  return new Error(`ElevenLabs antwortete mit HTTP ${response.status}${clean ? `: ${clean}` : '.'}`);
}

async function request(pathname, options, consume) {
  const key = apiKey();
  if (!key) throw new Error('Kein ELEVENLABS_API_KEY hinterlegt — unter ⚙️ Einstellungen setzen.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
    if (!response.ok) throw await errorFromResponse(response, key);
    return consume(response);
  } catch (err) {
    if (controller.signal.aborted) throw new Error('ElevenLabs antwortet nicht (Timeout nach 60 Sekunden).');
    throw new Error(scrubKey(err.message, key));
  } finally {
    clearTimeout(timer);
  }
}

async function tts({ text, voiceId, modelId }) {
  return request(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId })
    },
    async (response) => Buffer.from(await response.arrayBuffer())
  );
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

module.exports = { hasKey, tts, listVoices, TIMEOUT_MS };
