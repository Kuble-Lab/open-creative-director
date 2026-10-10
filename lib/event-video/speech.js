'use strict';

// A cheap speech candidate gate, not a speech recogniser: silence and steady tones need no API call.
const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
// Candidate heuristics, not a calibrated speech classifier: 100 ms mono windows at 16 kHz.
const SAMPLE_RATE_HZ = 16000;
// Samples per 100 ms window at 16 kHz.
const WINDOW_SAMPLES = 1600;
// Seconds represented by one gate window.
const WINDOW_SECONDS = 0.1;
// Telephone-band filtering (Hz) suppresses rumble and high-frequency noise before the cheap gate.
const HIGH_PASS_HZ = 200;
// Upper edge of the speech gate filter band in Hz.
const LOW_PASS_HZ = 3400;
// Active windows exceed -42 dB RMS and have 0.01..0.4 zero crossings/sample.
const ACTIVE_RMS_DB = -42;
// Lower bound in crossings/sample for an active window.
const MIN_ZERO_CROSSINGS = 0.01;
// Upper bound in crossings/sample for an active window.
const MAX_ZERO_CROSSINGS = 0.4;
// At least six windows and 2 dB RMS variation reject silence and steady tones; silence events need 0.3 s.
const MIN_ACTIVE_WINDOWS = 6;
// Minimum RMS standard deviation in dB to reject steady tones.
const MIN_VARIATION_DB = 2;
// Minimum silence duration in seconds for ffmpeg silence events.
const SILENCE_SECONDS = 0.3;
// Scribe output bounds follow info v1: 20000 words, 64 code points per word, 1 ms rounding tolerance.
const MAX_WORDS = 20000;
// Maximum Unicode code points per word accepted by info v1.
const MAX_WORD_CHARS = 64;
// Allow 1 ms beyond the source duration for independently rounded word times.
const TIME_TOLERANCE_SECONDS = 0.001;
// Millisecond rounding factor for serialised source times.
const TIME_PRECISION = 1000;
// Two decode threads at lower priority keep local work bounded; diagnostics retain at most 200 characters.
const DECODE_THREADS = '2';
// Lower scheduling priority of the local ffmpeg process.
const PROCESS_NICENESS = '10';
// Maximum diagnostic characters retained in provider error messages.
const ERROR_CHARS = 200;

// Round seconds and RMS variation to three decimals for stable reporting.
const round = (n) => Math.round(n * TIME_PRECISION) / TIME_PRECISION;

// Preserve cancellation and wrap provider failures with the stable speech-analysis error code.
function speechError(err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return err;
  return Object.assign(new Error(`Speech analysis failed: ${String(err?.message || err).slice(0, ERROR_CHARS)}`), {
    code: 'EVENTMEDIA_SPEECH_FAILED',
    cause: err
  });
}

// Read ffmpeg window statistics and decide whether varying, speech-like audio warrants transcription.
function parseGate(text) {
  const windows = [];
  for (const block of text.split(/frame:/).slice(1)) {
    // Missing per-channel statistics become non-finite and are discarded below.
    const value = (key) => Number(new RegExp(`lavfi\\.astats\\.1\\.${key}=([^\\s]+)`).exec(block)?.[1]);
    const rms = value('RMS_level');
    const zcr = value('Zero_crossings_rate');
    if (Number.isFinite(rms) && Number.isFinite(zcr)) windows.push({ rms, zcr });
  }
  const active = windows.filter((w) => w.rms > ACTIVE_RMS_DB && w.zcr > MIN_ZERO_CROSSINGS && w.zcr < MAX_ZERO_CROSSINGS);
  const average = active.length ? active.reduce((sum, w) => sum + w.rms, 0) / active.length : -Infinity;
  const variation = active.length ? Math.sqrt(active.reduce((sum, w) => sum + (w.rms - average) ** 2, 0) / active.length) : 0;
  const silenceEvents = [...text.matchAll(/lavfi\.silence_(start|end)=([^\s]+)/g)].map((m) => ({ type: m[1], time: Number(m[2]) }));
  return {
    candidate: active.length >= MIN_ACTIVE_WINDOWS && variation >= MIN_VARIATION_DB,
    activeSeconds: round(active.length * WINDOW_SECONDS),
    variation: round(variation),
    silenceEvents
  };
}

// Inspect mono 16 kHz audio locally; decode failures remain deterministic media failures.
async function speechGate(ctx, file, scratch) {
  const metadata = path.join(scratch, 'speech-stats.txt');
  // The metadata stays on disk; quote its path for the filter parser, not for a shell.
  const escaped = metadata.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  const args = [
    '-nostdin',
    '-v',
    'error',
    '-threads',
    DECODE_THREADS,
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE_HZ),
    '-af',
    `aformat=sample_rates=${SAMPLE_RATE_HZ}:channel_layouts=mono,` +
      `highpass=f=${HIGH_PASS_HZ},lowpass=f=${LOW_PASS_HZ},asetnsamples=n=${WINDOW_SAMPLES}:p=0,` +
      `astats=metadata=1:reset=1:measure_perchannel=RMS_level+Zero_crossings_rate:measure_overall=none,` +
      `silencedetect=noise=${ACTIVE_RMS_DB}dB:d=${SILENCE_SECONDS},ametadata=print:file='${escaped}'`,
    '-f',
    'null',
    '-'
  ];
  // Respect the workflow signal and local slot while lowering ffmpeg process priority.
  const run = () => ffmpeg.runProcess('nice', ['-n', PROCESS_NICENESS, ffmpeg.binaries().ffmpeg, ...args], { signal: ctx.signal });
  try {
    await (ctx.withLocalSlot ? ctx.withLocalSlot(run) : run());
  } catch (err) {
    err.decodeFailed = true;
    throw err;
  }
  return parseGate(await fs.readFile(metadata, 'utf8'));
}

// Map Scribe words to info v1 and validate ordered source times in seconds before returning them.
function readSpeech(outcome, seconds) {
  if (!outcome?.timing || !Array.isArray(outcome.timing.words)) throw new Error('Scribe returned no words');
  const words = outcome.timing.words.map((word) => ({
    w: word.text ?? word.w,
    s: round(word.start ?? word.s),
    e: round(word.end ?? word.e)
  }));
  if (
    words.length > MAX_WORDS ||
    words.some(
      (w, i) =>
        typeof w.w !== 'string' ||
        !w.w.trim() ||
        [...w.w].length > MAX_WORD_CHARS ||
        !Number.isFinite(w.s) ||
        !Number.isFinite(w.e) ||
        w.s < 0 ||
        w.e < w.s ||
        w.e > seconds + TIME_TOLERANCE_SECONDS ||
        (i && w.s < words[i - 1].s)
    )
  ) {
    throw new Error('Scribe returned invalid word times');
  }
  const raw = outcome.language || outcome.timing.language || null;
  const language = /^[a-z]{2,3}$/.test(raw || '') ? raw : null;
  return words.length ? { language, words } : null;
}

// Transcribe only gated candidates and remove the temporary saved audio even when the provider fails.
async function analyzeSpeech(ctx, file, { seconds, scratch, mode = 'auto', hasAudio = false }) {
  if (mode === 'off' || !hasAudio) return { speech: null, usd: 0 };
  try {
    const gate = await speechGate(ctx, file, scratch);
    ctx.log?.(`Speech gate: ${gate.activeSeconds} s active, ${gate.variation} dB variation, ${gate.candidate ? 'candidate' : 'no speech'}`);
    if (!gate.candidate) return { speech: null, usd: 0 };
    const wav = path.join(scratch, 'speech.wav');
    // Respect the workflow signal and local slot while lowering ffmpeg process priority.
    const run = () =>
      ffmpeg.runProcess(
        'nice',
        [
          '-n', PROCESS_NICENESS, ffmpeg.binaries().ffmpeg, '-nostdin', '-v', 'error', '-y', '-threads', DECODE_THREADS, '-i', file,
          '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE_HZ), '-c:a', 'pcm_s16le', wav
        ],
        { signal: ctx.signal }
      );
    try {
      await (ctx.withLocalSlot ? ctx.withLocalSlot(run) : run());
    } catch (err) {
      err.decodeFailed = true;
      throw err;
    }
    const audio = await ctx.saveOutputFile({
      kind: 'audio',
      ext: '.wav',
      sourceFile: wav,
      prompt: 'Event speech analysis input',
      cost: 0,
      duration: seconds
    });
    try {
      const execute = ctx.eventVideo?.executeTool || require('../tools').executeTool;
      const outcome = await execute(ctx.toolCtx, 'lyrics_timing', {
        audio_asset_id: audio.assetId,
        method: 'transcribe',
        voices: 'off',
        duration_seconds: seconds
      });
      return { speech: readSpeech(outcome, seconds), usd: outcome.costUsd ?? null };
    } finally {
      if (ctx.eventVideo?.removeAssets) await ctx.eventVideo.removeAssets(ctx.sessionId, [audio.assetId]);
      else await require('../store').removeAssets(ctx.sessionId, [audio.assetId]);
    }
  } catch (err) {
    if (ctx.signal?.aborted || err.decodeFailed) throw err;
    throw speechError(err);
  }
}

module.exports = { parseGate, speechGate, readSpeech, analyzeSpeech, speechError };
