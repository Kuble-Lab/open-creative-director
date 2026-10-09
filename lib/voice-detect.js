'use strict';

// Who sings a lyric line (WP48): the figure alone ("lead"), a choir or backing voices without her ("choir"), or both ("both"). A Gemini model with
// audio input hears the song straight at Google, with the key the app already uses for the images (GEMINI_API_KEY in the settings, see
// lib/gemini-images.js). The node "Lyrics timing" (audio.lyrics_timing, parameter `voices`: auto) asks it when the lyrics carry no marks of a choir
// (lib/lyrics-timing.js markedLines); the tool lyrics_timing (lib/tools.js) writes the result into the lines of the timing, and the planners give
// no lip sync to a line of the choir. `both` counts as the figure's: she may sing along. Pure apart from fetch and ffmpeg; no state.
//
//   hasKey()                          GEMINI_API_KEY is set
//   model()                           the code at Google: GEMINI_VOICES_MODEL, else DEFAULT_MODEL
//   compressAudio(file)               the song as a small AAC file for listening (mono, 16 kHz, 32 kbit/s: about 4 MB for 20 minutes), with ffmpeg
//   detectVoices({ audio, lines })    one request, and one more after an answer that is not valid or a failure of the service:
//                                     { voices: [{ index, voice, confidence }], usd, usage, model, attempts }; throws a VoiceDetectError
//   estimateUsd(seconds, lineCount)   what one request costs, for the plan and the reservation
//
// Per the docs, not checked with a call (ai.google.dev/gemini-api/docs: audio understanding, generate-content, tokens, pricing; read 2026-10-09):
//   request  v1beta generateContent, the key in the header x-goog-api-key, contents[0].parts = [{ inline_data: { mime_type, data } }, { text }]
//            (audio/aac is one of the formats; inline up to 20 MB for the whole request), generationConfig.responseMimeType application/json
//   tokens   32 tokens per second of audio
//   answer   candidates[0].content.parts[].text (thought: true marks the thinking), usageMetadata with promptTokenCount, promptTokensDetails by
//            modality (AUDIO, TEXT), candidatesTokenCount and thoughtsTokenCount
// The model is a cheap one of the Flash class with audio input. Its code and its prices are those of the docs and are checked live before they are
// relied on; GEMINI_VOICES_MODEL replaces the code without a deploy (its prices then count as those of DEFAULT_MODEL).

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const { getSetting } = require('./settings');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini 3 Flash (preview): audio input, the cheapest model of the Flash class with thinking. To be checked live (models.list) before use.
const DEFAULT_MODEL = 'gemini-3-flash-preview';
// USD per 1M tokens of DEFAULT_MODEL (pricing page of the docs): text input 0.50, audio input 1.00, output with thinking 3.00.
const PRICES = Object.freeze({ input: 0.5, audio: 1, output: 3 });
const AUDIO_TOKENS_PER_SECOND = 32;
// The answer: a short entry per line; the thinking of a Flash model is a few thousand tokens at most for this.
const ESTIMATE_OUTPUT_TOKENS = 3000;
const OUTPUT_TOKENS_PER_LINE = 20;
const PROMPT_CHARS = 1400;
// A request with a song takes longer than one with a picture.
const TIMEOUT_MS = 180 * 1000;
const MAX_REQUEST_BYTES = 19 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const VOICES = Object.freeze(['lead', 'choir', 'both']);
// A line counts as the choir's only when the model is at least this sure; below it the line stays the figure's (she may lip sync it).
const CHOIR_MIN_CONFIDENCE = 0.5;
// HTTP statuses after which the same request is tried once more (the service, not the request).
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_LINE_CHARS = 200;

// `code`: VOICES_NO_KEY, VOICES_HTTP, VOICES_NETWORK, VOICES_TIMEOUT, VOICES_TOO_LARGE, VOICES_BAD_ANSWER (no valid answer in two tries),
// VOICES_NO_AUDIO (ffmpeg missing or the song unreadable). `usd`: what the requests that were answered cost (they are billed all the same).
class VoiceDetectError extends Error {
  constructor(message, { code, status = 0, usd = 0, summary = '' } = {}) {
    super(message);
    this.name = 'VoiceDetectError';
    this.code = code;
    this.status = status;
    this.usd = usd;
    this.summary = summary || code;
  }
}

function apiKey() {
  return String(getSetting('GEMINI_API_KEY') || '').trim();
}

function hasKey() {
  return Boolean(apiKey());
}

function model() {
  const named = String(process.env.GEMINI_VOICES_MODEL || '').trim();
  return /^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(named) ? named : DEFAULT_MODEL;
}

// The key never leaves this module in a message.
function scrub(text, key) {
  const value = String(text ?? '');
  return key && key.length >= 8 ? value.split(key).join('[GEMINI_API_KEY]') : value;
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

// The price of one request for a song of `seconds` with `lineCount` lines (the lines of a song of that length when the count is not known yet).
function estimateUsd(seconds, lineCount) {
  const length = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const lines = Number.isInteger(lineCount) && lineCount >= 0 ? lineCount : Math.ceil(length / 3.5);
  const audio = length * AUDIO_TOKENS_PER_SECOND;
  const text = (PROMPT_CHARS + 60 * lines) / 4;
  const output = ESTIMATE_OUTPUT_TOKENS + OUTPUT_TOKENS_PER_LINE * lines;
  return round6((audio * PRICES.audio + text * PRICES.input + output * PRICES.output) / 1e6);
}

/* ---------- the audio ---------- */

// The song as AAC (ADTS) for listening: one channel at 16 kHz is what the model hears anyway, and 32 kbit/s keep the request small.
async function compressAudio(file, { signal } = {}) {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new VoiceDetectError('ffmpeg/ffprobe not found', { code: 'VOICES_NO_AUDIO', summary: 'no ffmpeg' });
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-voices-'));
  const output = path.join(directory, 'song.aac');
  try {
    await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', '-y', output], { timeoutMs: 5 * 60 * 1000, signal });
    const audio = await fsp.readFile(output);
    if (!audio.length) throw new VoiceDetectError('ffmpeg made no audio', { code: 'VOICES_NO_AUDIO', summary: 'no audio' });
    return { audio, mime: 'audio/aac' };
  } catch (err) {
    if (err instanceof VoiceDetectError || err?.name === 'AbortError') throw err;
    throw new VoiceDetectError(`The song cannot be prepared for listening: ${String(err?.message || err).slice(0, 200)}`, { code: 'VOICES_NO_AUDIO', summary: 'ffmpeg failed' });
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

/* ---------- the request ---------- */

const tenth = (seconds) => (Math.round(Number(seconds) * 10) / 10).toFixed(1);

// What the model is told: the task, the format of the answer and the lines with their times.
function promptText(lines, problem = '') {
  const rows = lines.map((line, index) => `${index} | ${tenth(line.start)}-${tenth(line.end)} s | ${String(line.text).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS)}`);
  return [
    'You hear a song. Below are its sung lines with their times in seconds from the start of the audio. For every line decide who sings it:',
    '- "lead": the lead singer alone (the main voice of the song, the one that sings most of the verses)',
    '- "choir": only other voices: a choir, backing vocals, a crowd or another singer; the lead singer is silent in this line',
    '- "both": the lead singer together with other voices',
    'Listen to the voices, not to the words: a line that repeats the words of the lead singer can still be sung by the choir.',
    'Answer with one JSON object and nothing else: {"lines": [{"index": 0, "voice": "lead", "confidence": 0.9}]}, exactly one entry for every line, in order, "voice" one of "lead", "choir", "both", "confidence" a number from 0 to 1.',
    ...(problem ? [`Your previous answer was not valid (${problem}). Answer again in exactly this format.`] : []),
    '',
    'LINES (index | time | text)',
    ...rows
  ].join('\n');
}

function buildBody({ audio, mime, lines, problem }) {
  return {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: audio.toString('base64') } }, { text: promptText(lines, problem) }] }],
    generationConfig: { responseMimeType: 'application/json' }
  };
}

// The readable part of an error body of Google ({ error: { message, status } }).
function errorDetail(text) {
  try {
    const error = JSON.parse(text)?.error;
    if (error && typeof error.message === 'string') return { message: error.message, status: typeof error.status === 'string' ? error.status : '' };
  } catch (_) {
    /* not JSON */
  }
  return { message: String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), status: '' };
}

async function send(url, body, key, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body, signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new VoiceDetectError(`Google answers nothing (timeout after ${Math.round(timeoutMs / 1000)} s).`, { code: 'VOICES_TIMEOUT', summary: 'timeout' });
    }
    const cause = String(err?.cause?.code || err?.code || '');
    throw new VoiceDetectError(`Google cannot be reached: ${scrub(err?.message || err, key).replace(/\s+/g, ' ').trim().slice(0, 200)}`, {
      code: 'VOICES_NETWORK',
      summary: /^[A-Z0-9_]{1,40}$/.test(cause) ? `no answer (${cause})` : 'no answer'
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- the answer ---------- */

const field = (object, camel, snake) => (object && typeof object === 'object' ? (object[camel] !== undefined ? object[camel] : object[snake]) : undefined);
const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

// The cost in USD from usageMetadata: the audio tokens at the audio price, the other tokens of the prompt at the text price, the answer and the
// thinking at the output price. Without usageMetadata: the estimate, never 0 (the request was billed).
function costOf(usage, lineCount, seconds) {
  const prompt = count(field(usage, 'promptTokenCount', 'prompt_token_count'));
  if (!prompt) return { usd: estimateUsd(seconds, lineCount), usage: null };
  let audio = 0;
  for (const entry of Array.isArray(field(usage, 'promptTokensDetails', 'prompt_tokens_details')) ? field(usage, 'promptTokensDetails', 'prompt_tokens_details') : []) {
    if (String(entry?.modality || '').toUpperCase() === 'AUDIO') audio += count(field(entry, 'tokenCount', 'token_count'));
  }
  const output = count(field(usage, 'candidatesTokenCount', 'candidates_token_count')) + count(field(usage, 'thoughtsTokenCount', 'thoughts_token_count'));
  const usd = round6((audio * PRICES.audio + Math.max(0, prompt - audio) * PRICES.input + output * PRICES.output) / 1e6);
  return { usd, usage: { input_tokens: prompt, output_tokens: output, total_tokens: prompt + output } };
}

// The text of the answer (without the thinking), or '' when there is none.
function answerText(data) {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  return parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

// The answer checked strictly: one entry for every line, every index once, a known voice and a confidence from 0 to 1. Returns { voices } in
// the order of the lines, or { problem }.
function readVoices(text, lineCount) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (_) {
    return { problem: 'the answer is no JSON' };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.lines) ? data.lines : null;
  if (!list) return { problem: 'the answer has no list "lines"' };
  if (list.length !== lineCount) return { problem: `${list.length} entries for ${lineCount} lines` };
  const voices = new Array(lineCount).fill(null);
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { problem: 'an entry is no object' };
    const index = entry.index;
    if (!Number.isInteger(index) || index < 0 || index >= lineCount) return { problem: `the index ${JSON.stringify(index)?.slice(0, 20)} is no line` };
    if (voices[index]) return { problem: `line ${index} appears twice` };
    const voice = typeof entry.voice === 'string' ? entry.voice.trim().toLowerCase() : '';
    if (!VOICES.includes(voice)) return { problem: `line ${index}: the voice is none of ${VOICES.join(', ')}` };
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : Number.NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { problem: `line ${index}: the confidence is no number from 0 to 1` };
    voices[index] = { index, voice, confidence: Math.round(confidence * 100) / 100 };
  }
  return { voices };
}

/* ---------- the call ---------- */

// Who sings each of `lines` ([{ text, start, end }], in order) in `audio` (a Buffer, `mime` its type). One request, one more after an answer that
// is not valid (with the problem told) or after a failure of the service (408, 429, 5xx, no answer, timeout); any other HTTP error is final. Throws a
// VoiceDetectError whose `usd` is what the answered requests cost. `fetchImpl` and `timeoutMs` are for tests.
async function detectVoices({ audio, mime = 'audio/aac', lines, seconds = null, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const key = apiKey();
  if (!key) throw new VoiceDetectError('No GEMINI_API_KEY is set.', { code: 'VOICES_NO_KEY', summary: 'no key' });
  const list = Array.isArray(lines) ? lines : [];
  const code = model();
  const url = `${BASE_URL}/${code}:generateContent`;
  let usd = 0;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let problem = '';
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const body = JSON.stringify(buildBody({ audio, mime, lines: list, problem }));
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new VoiceDetectError(`The song is too large to be sent inline (${(Buffer.byteLength(body) / (1024 * 1024)).toFixed(1)} MB, at most 20 MB).`, { code: 'VOICES_TOO_LARGE', summary: 'request too large' });
    }
    let answer;
    try {
      answer = await send(url, body, key, timeoutMs, fetchImpl);
    } catch (err) {
      last = err;
      last.usd = usd;
      if (attempt < MAX_ATTEMPTS) continue;
      throw last;
    }
    if (answer.status < 200 || answer.status >= 300) {
      const detail = errorDetail(answer.text);
      last = new VoiceDetectError(`Google ${answer.status}: ${scrub(detail.message, key).slice(0, 300) || 'no detail'}`, {
        code: 'VOICES_HTTP',
        status: answer.status,
        usd,
        summary: `HTTP ${answer.status}${/^[A-Z_]{1,40}$/.test(detail.status) ? ` ${detail.status}` : ''}`
      });
      if (RETRY_STATUSES.has(answer.status) && attempt < MAX_ATTEMPTS) continue;
      throw last;
    }
    let data = null;
    try {
      data = JSON.parse(answer.text);
    } catch (_) {
      data = null;
    }
    const cost = costOf(field(data, 'usageMetadata', 'usage_metadata'), list.length, seconds);
    usd = round6(usd + cost.usd);
    if (cost.usage) for (const name of Object.keys(usage)) usage[name] += cost.usage[name];
    const read = data ? readVoices(answerText(data), list.length) : { problem: 'the answer of Google is no JSON' };
    if (read.voices) return { voices: read.voices, usd, usage: usage.total_tokens ? usage : null, model: code, attempts: attempt };
    problem = read.problem;
    last = new VoiceDetectError(`Gemini gave no valid answer: ${problem}`, { code: 'VOICES_BAD_ANSWER', usd, summary: problem.slice(0, 80) });
  }
  last.usd = usd;
  throw last;
}

// The voice a line gets from an entry of the answer: a choir the model is not sure about stays the figure's.
function voiceOf(entry) {
  if (!entry) return 'lead';
  return entry.voice === 'choir' && entry.confidence < CHOIR_MIN_CONFIDENCE ? 'lead' : entry.voice;
}

module.exports = {
  DEFAULT_MODEL,
  PRICES,
  TIMEOUT_MS,
  VOICES,
  CHOIR_MIN_CONFIDENCE,
  VoiceDetectError,
  hasKey,
  model,
  estimateUsd,
  compressAudio,
  promptText,
  readVoices,
  costOf,
  detectVoices,
  voiceOf
};
