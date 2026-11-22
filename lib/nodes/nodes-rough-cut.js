'use strict';

// Two nodes for recordings with speech (interviews, talking heads, presentations, podcasts), after the editing ideas of Scarlet
// (Forward Future, MIT, github.com/Forward-Future/scarlet):
//
//   video.rough_cut   "Rough cut from recording": cuts filler words, false starts, repeated takes and long pauses out of a video.
//                     The words and their times come from ElevenLabs Scribe (the tool lyrics_timing), a language model names the
//                     words that go, lib/rough-cut.js places the edges safely and ffmpeg cuts locally in one pass.
//   video.subtitles   "SRT/VTT file": readable cues from word times, as SubRip, WebVTT and as a timing for "Burn in captions". From a
//                     connected timing (the rough cut gives one) it is free; from a video or a sound it transcribes first.
//
// The pure work is in lib/rough-cut.js and lib/subtitles.js; this module is the adapter to the engine: ports, parameters, files and costs.

const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const tools = require('../tools');
const store = require('../store');
const elevenlabs = require('../elevenlabs');
const languageDetect = require('../language-detect');
const lyricsTiming = require('../lyrics-timing');
const roughCut = require('../rough-cut');
const subtitles = require('../subtitles');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const generate = require('./nodes-generate');
const { textValue } = require('./types');

// askModel is looked up at the call (generate.askModel), so a test can stand in for the language model.
const { usdCost, llmAvailable, MODEL_PARAM } = generate;
const { TIMING_MAX_SECONDS } = tools;

// The sound that is sent to Scribe: mono, 16 kHz, 16-bit PCM (what speech recognition needs, about 1.9 MB per minute).
const SPEECH_RATE_HZ = 16000;
const LANGUAGES = Object.freeze(['auto', 'de', 'en', 'es']);

function codedError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

function elevenLabsAvailable() {
  return elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set';
}

function isAbort(err, ctx) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || Boolean(ctx?.signal?.aborted);
}

function mediaSeconds(value) {
  return value && value.type !== 'list' && Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null;
}

// The words of a recording with their times. The sound of the video (or the audio) is written as a WAV into the session, sent to
// Scribe through the tool lyrics_timing (which checks the length, books the price and returns the cleaned words) and removed again.
// Returns { words, duration, costUsd, language }.
async function transcribeMedia(ctx, value, { language = 'auto' } = {}) {
  if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
  const file = assets.assetFilePath(value);
  const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
  if (!probe.audio) throw codedError('ROUGHCUT_NO_AUDIO', 'The recording has no sound, so there are no words to cut by');
  const duration = probe.duration || mediaSeconds(value);
  if (duration && duration > TIMING_MAX_SECONDS) {
    throw codedError('ROUGHCUT_TOO_LONG', `The recording is longer than ${TIMING_MAX_SECONDS / 60} minutes`, { minutes: TIMING_MAX_SECONDS / 60 });
  }
  const saved = await ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const wav = path.join(scratch, 'speech.wav');
      await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', String(SPEECH_RATE_HZ), '-c:a', 'pcm_s16le', wav], {
        timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS,
        signal: ctx.signal
      });
      return await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: wav, prompt: 'Speech for the transcript', cost: 0, duration: duration || undefined });
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
  try {
    const outcome = await tools.executeTool(ctx.toolCtx, 'lyrics_timing', {
      audio_asset_id: saved.assetId,
      method: 'transcribe',
      voices: 'off',
      duration_seconds: duration || undefined
    });
    const words = subtitles.usableWords(outcome?.timing?.words);
    const heard = words.map((word) => word.text).join(' ');
    const detected = language !== 'auto' && LANGUAGES.includes(language) ? language : heard ? languageDetect.detectLanguage(heard) : 'en';
    return { words, duration: duration || outcome?.durationSeconds || outcome?.timing?.duration || null, costUsd: outcome?.costUsd ?? null, language: detected };
  } finally {
    await store.removeAssets(ctx.sessionId, [saved.assetId]).catch(() => {});
  }
}

// Price of the transcript: by the length of the recording (ElevenLabs Scribe, ELEVENLABS_TIMING_USD_PER_HOUR). Unknown without a length.
function transcriptEstimate(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? tools.lyricsTimingUsd(Math.min(seconds, TIMING_MAX_SECONDS)) : null;
}

/* ---------- video.rough_cut ---------- */

// The language model reads the numbered words and names the words that go. Its answer is checked (lib/rough-cut.js readCuts); one
// more request after an answer that cannot be read. Returns { cuts, summary, costs }.
async function modelCuts(ctx, params, { words, language, instructions }) {
  const costs = [];
  const request = {
    system: roughCut.systemPrompt(),
    prompt: roughCut.userPrompt({ transcript: roughCut.transcriptForModel(words), instructions, language, removeFillers: params.remove_fillers !== false }),
    json: true
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generate.askModel(ctx, params, request);
    costs.push(result.usd);
    const read = roughCut.readCuts(result.text, words.length, { removeFillers: params.remove_fillers !== false });
    if (read.readable) {
      for (const problem of read.problems.slice(0, 3)) ctx.log(`Left out: ${problem}`);
      return { cuts: read.cuts, summary: read.summary, costs };
    }
    ctx.log(`The answer of the language model could not be read (${read.problems[0]})${attempt === 0 ? ': asking once more' : ''}`);
  }
  throw codedError('ROUGHCUT_MODEL_ANSWER', 'The language model gave no usable list of cuts');
}

const roughCutDefinition = {
  type: 'video.rough_cut',
  category: 'edit-video',
  provider: 'elevenlabs',
  label: 'Rough cut from recording',
  keywords: ['rough cut', 'first cut', 'dialogue', 'filler words', 'um', 'uh', 'false starts', 'retakes', 'pauses', 'silence', 'interview', 'talking head', 'podcast', 'jump cut', 'transcript', 'scribe', 'scarlet', 'video', 'ffmpeg'],
  description:
    'Cuts a recording with speech (interview, talking head, presentation) into a clean first cut: filler words, false starts, repeated takes ' +
    'and long pauses go, the content stays. ElevenLabs (Scribe) hears the words with their times, a language model decides which words ' +
    'go (it names words, never times), the edges are put into the pauses between words and on the frame grid, and ffmpeg cuts locally. ' +
    'Outputs: the cut video, a timing of the words that are kept (for "Burn in captions" or "Subtitles") and the list of the cuts with ' +
    'their reasons. Recordings up to 20 minutes. Price: the transcript by its length (about 4 cents for 10 minutes) and the language model.',
  inputs: [
    { id: 'video', type: 'video', required: true },
    { id: 'instructions', type: 'text', param: 'instructions' }
  ],
  outputs: [
    { id: 'video', type: 'video' },
    { id: 'timing', type: 'text' },
    { id: 'cuts', type: 'text' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'instructions', kind: 'textarea', default: '' },
    { id: 'remove_retakes', kind: 'boolean', default: true, inline: true },
    { id: 'remove_fillers', kind: 'boolean', default: true, inline: true },
    { id: 'shorten_pauses', kind: 'boolean', default: true },
    { id: 'max_pause', kind: 'slider', min: roughCut.MAX_PAUSE_MIN, max: 3, step: 0.05, default: roughCut.MAX_PAUSE_DEFAULT },
    { id: 'padding', kind: 'slider', min: 0, max: 0.3, step: 0.01, default: roughCut.PADDING_DEFAULT },
    { id: 'trim_ends', kind: 'boolean', default: true },
    { id: 'language', kind: 'select', options: LANGUAGES, default: 'auto' }
  ],
  paid: true,
  // the transcript by the length of the video; the language model by its tokens, which only an earlier run of the node knows
  cost: {
    unit: 'usd',
    estimate: (params, context) => {
      const transcript = transcriptEstimate(mediaSeconds(context?.inputs?.video));
      if (transcript === null) return null;
      return params?.remove_retakes === false ? transcript : null;
    }
  },
  available: () => {
    const reasons = [ffmpegAvailable(), elevenLabsAvailable()];
    const missing = reasons.find((reason) => reason !== true);
    if (missing) return missing;
    return llmAvailable();
  },
  validate: (params) =>
    params.remove_retakes === false && params.remove_fillers === false && params.shorten_pauses === false && params.trim_ends === false
      ? [{ code: 'ROUGHCUT_NOTHING_TO_DO', message: 'Switch on at least one kind of cut (retakes, filler words, pauses or the ends)' }]
      : [],
  execute: async (ctx, inputs, params) => {
    const video = inputs.video;
    const binaries = ffmpeg.binaries();
    if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
    const file = assets.assetFilePath(video);
    const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!probe.video?.width) throw codedError('ROUGHCUT_NO_PICTURE', 'The input has no picture; for a sound alone use "Subtitles"');
    const heard = await transcribeMedia(ctx, video, { language: params.language });
    const costs = [heard.costUsd];
    const duration = probe.duration || heard.duration;
    const words = heard.words;
    ctx.log(`Heard ${words.length} words in ${Math.round(duration || 0)} s (${heard.language})`);
    if (!words.length) throw codedError('ROUGHCUT_NO_WORDS', 'No words were heard in the recording');
    if (words.length > roughCut.MAX_MODEL_WORDS) throw codedError('ROUGHCUT_TOO_MANY_WORDS', `The recording has more than ${roughCut.MAX_MODEL_WORDS} words`, { words: roughCut.MAX_MODEL_WORDS });

    const fillers = params.remove_fillers === false ? [] : roughCut.fillerCuts(words);
    let modelList = [];
    let summary = '';
    if (params.remove_retakes !== false) {
      const instructions = inputs.instructions ? String(inputs.instructions.value || '') : String(params.instructions || '');
      const answer = await modelCuts(ctx, params, { words, language: heard.language, instructions });
      modelList = answer.cuts;
      summary = answer.summary;
      costs.push(...answer.costs);
    }
    const cuts = roughCut.mergeCuts(fillers, modelList);
    const plan = roughCut.planCut({
      words,
      duration,
      cuts,
      fps: probe.video.fps,
      padding: params.padding,
      maxPause: params.max_pause,
      shortenPauses: params.shorten_pauses !== false,
      trimEnds: params.trim_ends !== false
    });
    const removedWords = cuts.reduce((sum, cut) => sum + (cut.to - cut.from + 1), 0);
    ctx.log(`${removedWords} words in ${cuts.length} places go (${fillers.length} filler words by the list, ${modelList.length} cuts of the model); ${plan.removed.length} cuts in all`);
    ctx.log(`Length: ${lyricsTiming.formatTime(plan.duration)} before, ${lyricsTiming.formatTime(plan.newDuration)} after`);

    const cutVideo = await ctx.withLocalSlot(async () => {
      const scratch = await assets.createScratchDir(ctx.sessionId);
      try {
        const out = path.join(scratch, 'rough-cut.mp4');
        const args = roughCut.renderArgs({ input: file, output: out, keep: plan.keep, fps: plan.settings.fps, hasAudio: Boolean(probe.audio) });
        // one encode of the whole recording: up to three times its length (a 20-minute recording in full HD on a small server), at least the usual limit
        const timeoutMs = Math.max(ffmpeg.PROCESS_TIMEOUT_MS, Math.ceil((duration || 0) * 3000));
        await ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs, signal: ctx.signal });
        const stat = await fsp.stat(out).catch(() => null);
        if (!stat || !stat.size) throw new Error('ffmpeg produced no output for the rough cut');
        const result = await ops.probeMedia(out, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
        return await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: out, prompt: 'Rough cut', cost: 0, duration: result.duration || plan.newDuration });
      } finally {
        await assets.removeScratchDir(scratch);
      }
    });

    const kept = roughCut.remapWords(words, plan.keep);
    const timing = subtitles.subtitlesFromWords(kept, { duration: plan.newDuration, source: 'rough_cut', language: heard.language }).timing;
    const report = roughCut.cutReport(plan, { language: heard.language, summary });
    return {
      variants: [{ video: cutVideo, timing: textValue(JSON.stringify(timing)), cuts: textValue(report) }],
      cost: usdCost(costs)
    };
  }
};

/* ---------- video.subtitles ---------- */

function timingWords(text) {
  const timing = lyricsTiming.parseTiming(text);
  return timing ? { words: subtitles.usableWords(timing.words), duration: timing.duration, language: timing.language } : null;
}

const subtitlesDefinition = {
  type: 'video.subtitles',
  category: 'edit-video',
  provider: 'elevenlabs',
  label: 'SRT/VTT file',
  keywords: ['srt file', 'srt', 'vtt', 'webvtt', 'transcript', 'transcribe', 'words', 'timing', 'scribe', 'accessibility', 'video', 'audio'],
  description:
    'Makes subtitles that can be read: at most 42 characters on a line (adjustable), two lines, one to six seconds on the screen, a new ' +
    'subtitle at a pause or the end of a sentence. Outputs the subtitles as SubRip (.srt) and WebVTT (.vtt) text and as a timing for ' +
    '"Burn in captions". With a timing connected (from "Rough cut from recording" or "Lyrics timing") it is free and local; otherwise the ' +
    'words of the video or the sound are heard by ElevenLabs (Scribe), priced by the length.',
  inputs: [
    { id: 'video', type: 'video' },
    { id: 'audio', type: 'audio' },
    { id: 'timing', type: 'text' }
  ],
  outputs: [
    { id: 'timing', type: 'text' },
    { id: 'srt', type: 'text' },
    { id: 'vtt', type: 'text' }
  ],
  params: [
    { id: 'max_chars', kind: 'integer', min: subtitles.MAX_CHARS_MIN, max: subtitles.MAX_CHARS_MAX, default: subtitles.MAX_CHARS_DEFAULT, inline: true },
    { id: 'max_lines', kind: 'integer', min: 1, max: subtitles.MAX_LINES_MAX, default: subtitles.MAX_LINES_DEFAULT, inline: true },
    { id: 'max_seconds', kind: 'slider', min: subtitles.MAX_SECONDS_MIN, max: subtitles.MAX_SECONDS_MAX, step: 0.5, default: subtitles.MAX_SECONDS_DEFAULT },
    { id: 'language', kind: 'select', options: LANGUAGES, default: 'auto' }
  ],
  paid: true,
  // free with a timing; by the length of the video or the sound otherwise (unknown without a length)
  cost: {
    unit: 'usd',
    history: false,
    estimate: (_params, context) => {
      if (context?.connected?.has('timing')) return 0;
      return transcriptEstimate(mediaSeconds(context?.inputs?.video) ?? mediaSeconds(context?.inputs?.audio));
    }
  },
  available: () => ffmpegAvailable(),
  validate: (_params, ports) => {
    if (ports.timing?.connected || ports.video?.connected || ports.audio?.connected) return [];
    return [{ code: 'SUBTITLES_NO_INPUT', message: 'Connect a video, a sound or a timing' }];
  },
  execute: async (ctx, inputs, params) => {
    let source = null;
    let costUsd = 0;
    if (inputs.timing && String(inputs.timing.value || '').trim()) {
      source = timingWords(String(inputs.timing.value));
      if (!source) throw codedError('SUBTITLES_TIMING_INVALID', 'The timing is empty or unreadable');
      ctx.log(`From the timing: ${source.words.length} words, no transcript needed`);
    } else {
      const media = inputs.video || inputs.audio;
      if (!media) throw codedError('SUBTITLES_NO_INPUT', 'Connect a video, a sound or a timing');
      if (!elevenlabs.hasKey()) throw codedError('SUBTITLES_NO_KEY', 'ELEVENLABS_API_KEY is not set: the words cannot be heard without it (or connect a timing)');
      const heard = await transcribeMedia(ctx, media, { language: params.language });
      source = heard;
      costUsd = heard.costUsd;
      ctx.log(`Heard ${heard.words.length} words in ${Math.round(heard.duration || 0)} s (${heard.language})`);
    }
    const made = subtitles.subtitlesFromWords(source.words, {
      maxChars: params.max_chars,
      maxLines: params.max_lines,
      maxSeconds: params.max_seconds,
      duration: source.duration,
      language: source.language
    });
    ctx.log(`${made.cues.length} subtitles`);
    return {
      variants: [{ timing: textValue(JSON.stringify(made.timing)), srt: textValue(made.srt), vtt: textValue(made.vtt) }],
      cost: usdCost([costUsd])
    };
  }
};

function registerAll(registry) {
  registry.register(roughCutDefinition);
  registry.register(subtitlesDefinition);
}

module.exports = { registerAll, roughCutDefinition, subtitlesDefinition, transcribeMedia, LANGUAGES };
