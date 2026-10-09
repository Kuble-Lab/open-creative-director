'use strict';

// The Google image models of the app straight at Google (Gemini API, generateContent) with the operator's own key
// (GEMINI_API_KEY in the settings) instead of through OpenRouter. Why: OpenRouter serves them from a pool that all its customers
// share; on 2026-10-09 it answered Nano Banana 2.1 with "temporarily rate-limited upstream" (limit_source
// upstream_provider_shared_pool) until 09:00 CEST. A call with the own key counts against the own quota at Google.
//
//   hasKey()              GEMINI_API_KEY is set (any form: the prefix of the key is not checked)
//   accepts(payload)      this call goes to Google: key set, model in MODELS and nothing in the payload that cannot be translated
//                         (such a payload stays with OpenRouter, untouched)
//   createImage(payload)  takes the payload of lib/openrouter.js createImage and answers in its shape,
//                         { data: [{ b64_json, media_type }], usage: { cost } }, so storeImageResult (lib/tools.js) stays as it is
//   GeminiImageError      what createImage throws. `fallback`: the router (lib/tools.js createImage) may try the call once through
//                         OpenRouter, after HTTP 401, 402, 403, 404, 429 or 5xx, an invalid key, no answer, a timeout, an answer
//                         that is no JSON or a request above the inline limit; never after a block of the safety filter, an answer
//                         without an image or any other 400. `summary`: for the log, numbers and fixed words only.
//
// Checked on 2026-10-09 with free calls (models.list, a field check with an empty `contents`):
//   version  v1beta: gemini-nano-banana-2.1 is listed there only (GET under v1 answers 404), although the examples of the docs
//            use v1
//   codes    gemini-nano-banana-2.1 and gemini-3-pro-image (stable, listed under v1 and v1beta); the preview code of Pro still
//            answers but is not used
//   format   generationConfig.imageConfig { aspectRatio, imageSize } is accepted; generationConfig.responseFormat.image, which the
//            examples of the docs show, answers 400 (aspectRatio is an enum there, not a string)
// Per the docs, not checked with a call (ai.google.dev/gemini-api/docs: generate-content/image-generation, image-understanding,
// api-errors, pricing):
//   request  the key in the header x-goog-api-key; contents[0].parts = [{ text }, { inline_data: { mime_type, data } }, ...];
//            responseModalities TEXT and IMAGE; aspect ratios 1:1 1:4 1:8 2:3 3:2 3:4 4:1 4:3 4:5 5:4 8:1 9:16 16:9 21:9 (the
//            list of Nano Banana 2.1; the app sends only the seven of tools.IMAGE_RATIOS); images inline as PNG, JPEG, WEBP, HEIC
//            or HEIF, 20 MB for the whole request
//   answer   candidates[0].content.parts[] with inlineData { mimeType, data } (interim images of the thinking carry
//            thought: true), finishReason (STOP, IMAGE_SAFETY, IMAGE_OTHER ...), promptFeedback.blockReason, usageMetadata
//   errors   401 key missing, invalid or expired, 402 prepaid credit used up, 403 no permission, 404 not found, 429 limit,
//            500/503/504 the service. Not checked and not on that page: the older answer of Google APIs to an invalid or expired
//            key, 400 with the reason API_KEY_INVALID; it counts like the 401.
//   prices   USD per 1M tokens (page updated 2026-10-07): Nano Banana 2.1 input 1.50, text and thinking 7.50, image 30 (1K =
//            1120 tokens = 0.0336); Nano Banana Pro input 2.00, text and thinking 12.00, image 120 (1K and 2K = 1120 tokens)

const { getSetting } = require('./settings');
const imageModels = require('./image-models');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// An own timer per request, as in the other clients (lib/elevenlabs.js, lib/gts.js); it covers the wait for the body, too.
// 120 s leave room for the thinking of the models and stay below the 300 s after which fetch of Node gives up by itself.
const TIMEOUT_MS = 120 * 1000;
// 20 MB for the request with its inline images (per the docs); the margin is for the JSON around them. A larger one is not sent.
const MAX_REQUEST_BYTES = 19 * 1024 * 1024;
const MAX_DETAIL_LENGTH = 600;
// The app sends OpenRouter no size, and the estimates of lib/image-models.js are the price of 1K, so 1K is asked for.
const IMAGE_SIZE = '1K';
const ASPECT_RATIOS = Object.freeze(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']);
const REFERENCE_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
// The fields of an OpenRouter payload that are translated; a payload with any other field stays with OpenRouter.
const PAYLOAD_FIELDS = Object.freeze(['model', 'prompt', 'n', 'aspect_ratio', 'input_references']);
// HTTP statuses of Google after which the call may be tried once through OpenRouter (and every 5xx).
const FALLBACK_STATUSES = new Set([401, 402, 403, 404, 429]);

// App model id (the id on OpenRouter) -> code at Google and prices in USD per 1M tokens. The one place of this table.
const MODELS = Object.freeze({
  'google/gemini-nano-banana-2.1': Object.freeze({
    code: 'gemini-nano-banana-2.1',
    usdPerMillionTokens: Object.freeze({ input: 1.5, text: 7.5, image: 30 })
  }),
  'google/gemini-3-pro-image': Object.freeze({
    code: 'gemini-3-pro-image',
    usdPerMillionTokens: Object.freeze({ input: 2, text: 12, image: 120 })
  })
});

// `code`: GEMINI_IMAGE_HTTP (an HTTP error), GEMINI_IMAGE_NETWORK (no answer: connection, DNS, a body that broke off),
// GEMINI_IMAGE_TIMEOUT, GEMINI_IMAGE_BAD_ANSWER (no JSON), GEMINI_IMAGE_TOO_LARGE (above the inline limit, not sent),
// GEMINI_IMAGE_BLOCKED (no image, with a reason), GEMINI_IMAGE_NO_IMAGE (no image, no reason), GEMINI_IMAGE_UNSUPPORTED (no key or a
// payload that accepts() refuses; the router never calls it so). `status`: the HTTP status of Google, 0 without one.
class GeminiImageError extends Error {
  constructor(message, { code, status = 0, fallback = false, summary = '' } = {}) {
    super(message);
    this.name = 'GeminiImageError';
    this.code = code;
    this.status = status;
    this.fallback = fallback;
    this.summary = summary || code;
  }
}

function apiKey() {
  return String(getSetting('GEMINI_API_KEY') || '').trim();
}

function hasKey() {
  return Boolean(apiKey());
}

// The key never leaves this module in a message or a summary.
function scrub(text, key) {
  const value = String(text ?? '');
  return key && key.length >= 8 ? value.split(key).join('[GEMINI_API_KEY]') : value;
}

// The camelCase name of a field (what the REST answer uses) or its snake_case name.
function field(object, camel, snake) {
  if (!object || typeof object !== 'object') return undefined;
  return object[camel] !== undefined ? object[camel] : object[snake];
}

// { mime, data } of a base64 data URL of a supported image, else null.
function readDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0 || comma > 120) return null;
  const [mime, ...flags] = url.slice(5, comma).split(';');
  const type = mime.trim().toLowerCase();
  return flags.includes('base64') && REFERENCE_MIME.includes(type) ? { mime: type, data: url.slice(comma + 1) } : null;
}

// What an OpenRouter payload means for Google, { model, profile, prompt, ratio, references }, or null when a part of it cannot be
// handed over. The payload is only read.
function translate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some((name) => !PAYLOAD_FIELDS.includes(name))) return null;
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const profile = Object.prototype.hasOwnProperty.call(MODELS, model) ? MODELS[model] : null;
  if (!profile || typeof payload.prompt !== 'string' || !payload.prompt.trim()) return null;
  if (payload.n !== undefined && payload.n !== 1) return null;
  if (payload.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(payload.aspect_ratio)) return null;
  const list = payload.input_references === undefined ? [] : payload.input_references;
  if (!Array.isArray(list)) return null;
  const references = [];
  for (const reference of list) {
    const parsed = reference?.type === 'image_url' ? readDataUrl(reference.image_url?.url) : null;
    if (!parsed) return null;
    references.push(parsed);
  }
  return { model, profile, prompt: payload.prompt, ratio: payload.aspect_ratio, references };
}

function accepts(payload) {
  return hasKey() && translate(payload) !== null;
}

// The text first, then the reference images in their order.
function buildBody(plan) {
  const parts = [{ text: plan.prompt }];
  for (const reference of plan.references) parts.push({ inline_data: { mime_type: reference.mime, data: reference.data } });
  const imageConfig = plan.ratio ? { aspectRatio: plan.ratio, imageSize: IMAGE_SIZE } : { imageSize: IMAGE_SIZE };
  return { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig } };
}

/* ---------- errors ---------- */

// The readable part of an error body: { error: { code, message, status, details: [{ reason }] } }, also as the first entry of a
// list; any other body is taken as text, an HTML page by its title.
function readErrorBody(text) {
  let message = String(text ?? '').trim();
  let status = '';
  let reason = '';
  try {
    const parsed = JSON.parse(message);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (error && typeof error === 'object') {
      message = typeof error.message === 'string' ? error.message : '';
      status = [error.status, error.code].find((value) => typeof value === 'string') || '';
      reason = (Array.isArray(error.details) ? error.details : []).map((item) => item?.reason).find((value) => typeof value === 'string') || '';
    }
  } catch (_) {
    /* not JSON: the text itself */
  }
  if (/^\s*<(!doctype|html)/i.test(message)) message = /<title>([^<]*)<\/title>/i.exec(message)?.[1] || '';
  return { message: message.replace(/\s+/g, ' ').trim(), status: /^[A-Za-z0-9_.-]{1,40}$/.test(status) ? status : '', reason };
}

function httpError(status, text, key) {
  const body = readErrorBody(text);
  const badKey = status === 400 && (body.reason === 'API_KEY_INVALID' || /API key (not valid|expired)/i.test(body.message));
  const hint = badKey || status === 401 || status === 403 ? ' - GEMINI_API_KEY pruefen (Einstellungen)' : '';
  const detail = scrub(body.message, key).slice(0, MAX_DETAIL_LENGTH) || `Google antwortete mit HTTP ${status}`;
  return new GeminiImageError(`Google ${status}: ${detail}${hint}`, {
    code: 'GEMINI_IMAGE_HTTP',
    status,
    fallback: badKey || FALLBACK_STATUSES.has(status) || status >= 500,
    summary: scrub(`HTTP ${status}${body.status ? ` ${body.status}` : ''}`, key)
  });
}

// One request: the status and the text of the answer. Everything fetch throws is no answer; the own timer makes it a timeout.
async function send(url, body, key, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    if (controller.signal.aborted) {
      const seconds = Math.round(timeoutMs / 1000);
      throw new GeminiImageError(`Google antwortet nicht (Timeout nach ${seconds} Sekunden).`, { code: 'GEMINI_IMAGE_TIMEOUT', fallback: true, summary: `timeout after ${seconds} s` });
    }
    const cause = String(err?.cause?.code || err?.code || '');
    const code = /^[A-Z0-9_]{1,40}$/.test(cause) ? ` (${cause})` : '';
    const what = scrub(err?.message || err, key).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new GeminiImageError(`Google nicht erreichbar: ${what}${code}`, { code: 'GEMINI_IMAGE_NETWORK', fallback: true, summary: `no answer${code}` });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- answer ---------- */

// The final image: the last one that is no interim image of the thinking (thought: true), else the last image there is.
function pickImage(parts) {
  const images = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const inline = field(part, 'inlineData', 'inline_data');
    const mime = String(field(inline, 'mimeType', 'mime_type') || 'image/png').toLowerCase();
    if (typeof inline?.data === 'string' && inline.data && mime.startsWith('image/')) images.push({ data: inline.data, mime, thought: part.thought === true });
  }
  const final = images.filter((image) => !image.thought);
  return final[final.length - 1] || images[images.length - 1] || null;
}

function tokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// The cost in USD from usageMetadata: the prompt (text and images) at the input price, the thinking and the text of the answer at
// the text price, the image tokens at the image price. Without the list by kind (candidatesTokensDetails) all tokens of the answer
// count as image tokens, the dearer kind. Without image tokens: the list price of one image (lib/image-models.js), never 0.
function costOf(usage, plan) {
  const prices = plan.profile.usdPerMillionTokens;
  const input = tokens(field(usage, 'promptTokenCount', 'prompt_token_count'));
  const details = field(usage, 'candidatesTokensDetails', 'candidates_tokens_details');
  let image = tokens(field(usage, 'candidatesTokenCount', 'candidates_token_count'));
  let text = tokens(field(usage, 'thoughtsTokenCount', 'thoughts_token_count'));
  if (Array.isArray(details) && details.length) {
    image = 0;
    for (const entry of details) {
      const count = tokens(field(entry, 'tokenCount', 'token_count'));
      if (String(entry?.modality || '').toUpperCase() === 'IMAGE') image += count;
      else text += count;
    }
  }
  if (!image) return imageModels.estimateUsd(plan.model);
  return Math.round(input * prices.input + text * prices.text + image * prices.image) / 1e6;
}

// No image. A reason of the model or of the filter gets the sentence that OpenRouter hands on for the same answer of Gemini
// ("OpenRouter 400: Gemini could not generate an image (IMAGE_OTHER)", live on 2026-10-07), with "Google:" in front instead.
function noImageError(candidate, feedback) {
  const blockReason = String(field(feedback, 'blockReason', 'block_reason') || '');
  const finishReason = String(field(candidate, 'finishReason', 'finish_reason') || '');
  const reason = (blockReason || (finishReason !== 'STOP' ? finishReason : '')).slice(0, 60);
  if (reason) return new GeminiImageError(`Google: Gemini could not generate an image (${reason})`, { code: 'GEMINI_IMAGE_BLOCKED' });
  const text = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new GeminiImageError(text ? `Google: Gemini answered with text instead of an image: ${text.slice(0, 300)}` : 'Google: Gemini returned no image.', {
    code: 'GEMINI_IMAGE_NO_IMAGE'
  });
}

function readAnswer(text, plan) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new GeminiImageError('Google lieferte keine gueltige JSON-Antwort.', { code: 'GEMINI_IMAGE_BAD_ANSWER', fallback: true, summary: 'answer is no JSON' });
  }
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const image = pickImage(candidate?.content?.parts);
  if (!image) throw noImageError(candidate, field(data, 'promptFeedback', 'prompt_feedback'));
  return {
    data: [{ b64_json: image.data, media_type: image.mime }],
    usage: { cost: costOf(field(data, 'usageMetadata', 'usage_metadata'), plan) }
  };
}

/* ---------- call ---------- */

// One image at Google. `timeoutMs` is for tests.
async function createImage(payload, { timeoutMs = TIMEOUT_MS } = {}) {
  const key = apiKey();
  const plan = key ? translate(payload) : null;
  if (!plan) {
    const message = key ? 'Dieser Bildaufruf laesst sich nicht an Google uebergeben.' : 'Kein GEMINI_API_KEY gesetzt. Unter Einstellungen hinterlegen.';
    throw new GeminiImageError(message, { code: 'GEMINI_IMAGE_UNSUPPORTED', fallback: true });
  }
  const body = JSON.stringify(buildBody(plan));
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_REQUEST_BYTES) {
    const megabytes = (bytes / (1024 * 1024)).toFixed(1);
    throw new GeminiImageError(`Die Anfrage ist mit ${megabytes} MB zu gross fuer Google (inline hoechstens 20 MB).`, {
      code: 'GEMINI_IMAGE_TOO_LARGE',
      fallback: true,
      summary: 'request too large'
    });
  }
  const answer = await send(`${BASE_URL}/${plan.profile.code}:generateContent`, body, key, timeoutMs);
  if (answer.status < 200 || answer.status >= 300) throw httpError(answer.status, answer.text, key);
  try {
    return readAnswer(answer.text, plan);
  } catch (err) {
    // a text of the model that carries the key would be a leak
    if (err instanceof GeminiImageError) err.message = scrub(err.message, key);
    throw err;
  }
}

module.exports = {
  MODELS,
  TIMEOUT_MS,
  GeminiImageError,
  hasKey,
  accepts,
  createImage
};
