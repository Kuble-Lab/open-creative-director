'use strict';

// A cheap speech candidate gate, not a speech recogniser: silence and steady tones need no API call.
const fs = require('fs/promises');
const path = require('path');
const ffmpeg = require('../ffmpeg');
const round = (n) => Math.round(n * 1000) / 1000;

function speechError(err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return err;
  return Object.assign(new Error(`Speech analysis failed: ${String(err?.message || err).slice(0, 200)}`),
    { code: 'EVENTMEDIA_SPEECH_FAILED', cause: err });
}

function parseGate(text) {
  const windows = [];
  for (const block of text.split(/frame:/).slice(1)) {
    const value = (key) => Number(new RegExp(`lavfi\\.astats\\.1\\.${key}=([^\\s]+)`).exec(block)?.[1]);
    const rms = value('RMS_level'), zcr = value('Zero_crossings_rate');
    if (Number.isFinite(rms) && Number.isFinite(zcr)) windows.push({ rms, zcr });
  }
  const active = windows.filter((w) => w.rms > -42 && w.zcr > 0.01 && w.zcr < 0.4);
  const average = active.length ? active.reduce((sum, w) => sum + w.rms, 0) / active.length : -Infinity;
  const variation = active.length ? Math.sqrt(active.reduce((sum, w) => sum + (w.rms - average) ** 2, 0) / active.length) : 0;
  const silenceEvents = [...text.matchAll(/lavfi\.silence_(start|end)=([^\s]+)/g)].map((m) => ({ type: m[1], time: Number(m[2]) }));
  return { candidate: active.length >= 6 && variation >= 2, activeSeconds: round(active.length * 0.1),
    variation: round(variation), silenceEvents };
}

async function speechGate(ctx, file, scratch) {
  const metadata = path.join(scratch, 'speech-stats.txt');
  // The metadata stays on disk; quote its path for the filter parser, not for a shell.
  const escaped = metadata.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  const args = ['-nostdin', '-v', 'error', '-threads', '2', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
    '-af', `aformat=sample_rates=16000:channel_layouts=mono,highpass=f=200,lowpass=f=3400,asetnsamples=n=1600:p=0,astats=metadata=1:reset=1:measure_perchannel=RMS_level+Zero_crossings_rate:measure_overall=none,silencedetect=noise=-42dB:d=0.3,ametadata=print:file='${escaped}'`,
    '-f', 'null', '-'];
  const run = () => ffmpeg.runProcess('nice', ['-n', '10', ffmpeg.binaries().ffmpeg, ...args], { signal: ctx.signal });
  try { await (ctx.withLocalSlot ? ctx.withLocalSlot(run) : run()); }
  catch (err) { err.decodeFailed = true; throw err; }
  return parseGate(await fs.readFile(metadata, 'utf8'));
}

function readSpeech(outcome, seconds) {
  if (!outcome?.timing || !Array.isArray(outcome.timing.words)) throw new Error('Scribe returned no words');
  const words = outcome.timing.words.map((word) => ({ w: word.text ?? word.w, s: round(word.start ?? word.s), e: round(word.end ?? word.e) }));
  if (words.length > 20000 || words.some((w, i) => typeof w.w !== 'string' || !w.w.trim() || [...w.w].length > 64 ||
    !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e < w.s || w.e > seconds + 0.001 || (i && w.s < words[i - 1].s))) {
    throw new Error('Scribe returned invalid word times');
  }
  const raw = outcome.language || outcome.timing.language || null;
  const language = /^[a-z]{2,3}$/.test(raw || '') ? raw : null;
  return words.length ? { language, words } : null;
}

async function analyzeSpeech(ctx, file, { seconds, scratch, mode = 'auto', hasAudio = false }) {
  if (mode === 'off' || !hasAudio) return { speech: null, usd: 0 };
  try {
    const gate = await speechGate(ctx, file, scratch);
    ctx.log?.(`Speech gate: ${gate.activeSeconds} s active, ${gate.variation} dB variation, ${gate.candidate ? 'candidate' : 'no speech'}`);
    if (!gate.candidate) return { speech: null, usd: 0 };
    const wav = path.join(scratch, 'speech.wav');
    const run = () => ffmpeg.runProcess('nice', ['-n', '10', ffmpeg.binaries().ffmpeg,
      '-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: ctx.signal });
    try { await (ctx.withLocalSlot ? ctx.withLocalSlot(run) : run()); }
    catch (err) { err.decodeFailed = true; throw err; }
    const audio = await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: wav, prompt: 'Event speech analysis input', cost: 0, duration: seconds });
    try {
      const execute = ctx.eventVideo?.executeTool || require('../tools').executeTool;
      const outcome = await execute(ctx.toolCtx, 'lyrics_timing', { audio_asset_id: audio.assetId, method: 'transcribe', voices: 'off', duration_seconds: seconds });
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
