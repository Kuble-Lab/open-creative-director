'use strict';

const BASE = 'https://openrouter.ai/api/v1';

class OpenRouterError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.body = body;
  }
}

function apiKey() {
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  // Platzhalter aus .env.example (z.B. "sk-or-v1-...") gilt nicht als Key
  if (key.endsWith('...') || key.length < 20) return '';
  return key;
}

function hasKey() {
  return Boolean(apiKey());
}

function headers(extra) {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'Open Creative Director',
    ...(extra || {})
  };
}

function requireKey() {
  if (!hasKey()) {
    throw new OpenRouterError('Kein OPENROUTER_API_KEY gesetzt. Unter ⚙️ Einstellungen hinterlegen.', 0, null);
  }
}

async function readError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    /* ignore */
  }
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || text;
    const rawProviderError = parsed?.error?.metadata?.raw;
    if (typeof rawProviderError === 'string') {
      try {
        const providerError = JSON.parse(rawProviderError);
        detail = providerError?.error?.message || providerError?.message || detail;
      } catch (_) {
        /* keep outer detail */
      }
    }
  } catch (_) {
    /* keep raw text */
  }
  if (/image data .*does not represent a valid image/i.test(String(detail))) {
    detail = 'Die hochgeladene Bilddatei hat ein nicht unterstuetztes oder ungueltiges Format. Bitte PNG, JPEG, GIF oder WebP verwenden.';
  }
  // HTML-Fehlerseiten (Cloudflare & Co.) nie roh in den Chat kippen - nur den Titel extrahieren.
  if (/^\s*<(!doctype|html)/i.test(String(detail))) {
    const title = /<title>([^<]*)<\/title>/i.exec(String(detail));
    detail = title ? title[1].trim() : 'Dienst voruebergehend nicht erreichbar (HTML-Fehlerseite).';
    if (/worker exceeded resource limits/i.test(detail)) {
      detail = 'Anfrage zu gross oder Dienst ueberlastet (Worker exceeded resource limits). Bitte erneut versuchen.';
    }
  }
  return new OpenRouterError(
    `OpenRouter ${res.status}: ${String(detail || res.statusText).slice(0, 600)}`,
    res.status,
    text
  );
}

async function postJson(pathname, payload) {
  requireKey();
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function getJson(pathname) {
  requireKey();
  const res = await fetch(BASE + pathname, { method: 'GET', headers: headers() });
  if (!res.ok) throw await readError(res);
  return res.json();
}

// Chat completions with stream:true. Returns the raw Response for SSE parsing.
async function chatStream(payload) {
  requireKey();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: headers({ Accept: 'text/event-stream' }),
    body: JSON.stringify({ ...payload, stream: true, usage: { include: true } })
  });
  if (!res.ok) throw await readError(res);
  return res;
}

async function createImage(payload) {
  return postJson('/images', payload);
}

async function createVideo(payload) {
  return postJson('/videos', payload);
}

async function getVideoJob(jobId) {
  return getJson(`/videos/${encodeURIComponent(jobId)}`);
}

async function downloadVideo(jobId, index) {
  requireKey();
  const res = await fetch(
    `${BASE}/videos/${encodeURIComponent(jobId)}/content?index=${index || 0}`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey()}` } }
  );
  if (!res.ok) throw await readError(res);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function listImageModels() {
  return getJson('/images/models');
}

async function listVideoModels() {
  return getJson('/videos/models');
}

module.exports = {
  OpenRouterError,
  hasKey,
  postJson,
  chatStream,
  createImage,
  createVideo,
  getVideoJob,
  downloadVideo,
  listImageModels,
  listVideoModels
};
