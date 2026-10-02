'use strict';

// When the ChatGPT subscription fails, one model call is repeated through OpenRouter. The Director's tool loop
// (lib/brain.js) and the LLM nodes (lib/nodes/llm.js) both go through run(); nothing is copied.
//
// The rules:
//   - Per model call, not per turn. Tools that ran in earlier steps are never run again, because the history that
//     feeds the next step is neutral (OpenAI chat messages) and each provider maps it itself.
//   - Only a failure before anything arrived is repeated: no login (or a refresh that failed), 401/403/408, a usage or
//     rate limit (429), a server error (5xx), no connection or a timeout. A 400 is a fault in the request and a repeat
//     would only be billed twice; after streamed text or tool calls the call cannot be repeated at all.
//   - The replacement needs an OpenRouter key. Without one the subscription error stays, said in plain words.
//   - After a failure the subscription is left alone for ten minutes (memory only, no polling): every model call in
//     that time goes straight to OpenRouter. A subscription that is not connected needs no pause, the status says so.

const chatgpt = require('./chatgpt');
const or = require('./openrouter');

const SUBSCRIPTION_PREFIX = 'chatgpt/';
const REPLACEMENT_PREFIX = 'openai/';
const PAUSE_MS = 10 * 60 * 1000;
const RETRYABLE_HTTP = new Set([401, 403, 408, 429]);
// Codes a failed stream reports for an overloaded or limited backend (not for a bad request).
const RETRYABLE_STREAM_CODES = /rate_limit|usage_limit|quota|server_error|overloaded|unavailable|timeout|capacity/i;

const MESSAGE_EN = 'The ChatGPT subscription is not reachable right now, and no OpenRouter key is set, so the answer cannot run through OpenRouter instead. Check the connection in the settings or add an OpenRouter key.';
const MESSAGE_DE = 'Das ChatGPT-Abo ist gerade nicht erreichbar, und es ist kein OpenRouter-Schlüssel hinterlegt, über den die Antwort ersatzweise laufen könnte. Prüfe die Verbindung in den Einstellungen oder hinterlege einen OpenRouter-Schlüssel.';
const UNAVAILABLE_CODE = 'CHATGPT_UNAVAILABLE';

// The subscription failed and OpenRouter cannot take over (no key).
class SubscriptionUnavailableError extends Error {
  constructor(cause, reason) {
    super(MESSAGE_EN);
    this.name = 'SubscriptionUnavailableError';
    this.code = UNAVAILABLE_CODE;
    this.messageDe = MESSAGE_DE;
    this.reason = reason;
    this.cause = cause;
  }
}

let pausedUntil = 0;
let clock = () => Date.now();

function isSubscriptionModel(model) {
  return String(model || '').startsWith(SUBSCRIPTION_PREFIX);
}

// chatgpt/gpt-6.1-sol -> openai/gpt-6.1-sol
function replacementModel(model) {
  return `${REPLACEMENT_PREFIX}${String(model || '').slice(SUBSCRIPTION_PREFIX.length)}`;
}

// Why a failed subscription call may be repeated through OpenRouter, or null when it may not (see the rules above).
// Reads the fields lib/chatgpt.js puts on its errors; anything else (a bug, a cancelled call) is never repeated.
function replaceableReason(err) {
  if (!err || err.name !== 'ChatGPTError' || err.delivered) return null;
  switch (err.kind) {
    case 'not_connected':
      return 'not_connected';
    case 'refresh':
      return 'refresh';
    case 'network':
    case 'timeout':
      return err.kind;
    case 'http':
      if (RETRYABLE_HTTP.has(err.status)) return `http_${err.status}`;
      return err.status >= 500 ? `http_${err.status}` : null;
    case 'stream':
      return RETRYABLE_STREAM_CODES.test(String(err.code || '')) ? 'stream' : null;
    default:
      return null;
  }
}

function isPaused() {
  return clock() < pausedUntil;
}

function pauseSubscription() {
  pausedUntil = clock() + PAUSE_MS;
}

// A new import of the login ends the pause at once.
function resume() {
  pausedUntil = 0;
}

// Test hook: another clock (null restores the real one) and the pause cleared.
function useClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
  pausedUntil = 0;
}

function pausedUntilMs() {
  return pausedUntil;
}

// Runs one model call.
//   model         the chatgpt/<name> model of the call
//   subscription  () => Promise<result>      the call through the subscription
//   replacement   (openRouterModel) => Promise<result>      the same call through OpenRouter
//   onReplaced    ({ from, to, reason }) called before the replacement starts (a notice for the user)
// Resolves { result, model, replaced }: `model` is the model that answered (openai/... after a replacement).
async function run({ model, subscription, replacement, onReplaced } = {}) {
  const keyed = or.hasKey();
  let reason = null;
  if (keyed) {
    if (!chatgpt.status().connected) reason = 'not_connected';
    else if (isPaused()) reason = 'paused';
  }
  if (!reason) {
    try {
      return { result: await subscription(), model, replaced: false };
    } catch (err) {
      const failure = replaceableReason(err);
      if (!failure) throw err;
      if (!keyed) throw new SubscriptionUnavailableError(err, failure);
      reason = failure;
      if (failure !== 'not_connected') pauseSubscription();
    }
  }
  const to = replacementModel(model);
  // One line without secrets: no token, no header, nothing from the login file, no content of the call.
  console.log(`[chatgpt] Abo nicht nutzbar (${reason}) - dieser Schritt laeuft ueber OpenRouter (${to})${reason === 'paused' || reason === 'not_connected' ? '' : ', Abo pausiert fuer 10 Minuten'}.`);
  try {
    onReplaced?.({ from: model, to, reason });
  } catch (_) {
    /* A notice must never stop the answer. */
  }
  return { result: await replacement(to), model: to, replaced: true, reason };
}

module.exports = {
  run,
  replaceableReason,
  replacementModel,
  isSubscriptionModel,
  isPaused,
  pauseSubscription,
  resume,
  useClock,
  pausedUntil: pausedUntilMs,
  SubscriptionUnavailableError,
  UNAVAILABLE_CODE,
  MESSAGE_EN,
  MESSAGE_DE,
  PAUSE_MS
};
