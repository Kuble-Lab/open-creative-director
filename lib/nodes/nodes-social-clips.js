'use strict';

// "Social clips from film" (video.social_clips): a film with speech goes in, its strongest passages come out as short clips in the
// format of the platforms (9:16 for Reels, Shorts and TikTok by default), each with the times of its words (for "Burn in captions"),
// a text for the post and an overview of what was chosen and why.
//
// The words and their times come from ElevenLabs Scribe (transcribeMedia of nodes-rough-cut.js; a film longer than one transcript
// takes is heard in parts) or from a connected timing (of "Rough cut from recording": then nothing is transcribed). A language model
// names the first and the last word of every clip; lib/social-clips.js brings them to the wanted length, places the edges and
// builds the ffmpeg arguments. The face is measured in every clip (lib/music-video-hud/faces.js), so the crop keeps the speaker in
// the picture. This module is the adapter to the engine: ports, parameters, files and costs.

const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const elevenlabs = require('../elevenlabs');
const languageDetect = require('../language-detect');
const lyricsTiming = require('../lyrics-timing');
const roughCut = require('../rough-cut');
const subtitles = require('../subtitles');
const socialClips = require('../social-clips');
const facesLib = require('../music-video-hud/faces');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const generate = require('./nodes-generate');
const nodesRoughCut = require('./nodes-rough-cut');
const { textValue, listValue } = require('./types');

const { usdCost, llmAvailable, MODEL_PARAM } = generate;
const { LANGUAGES } = nodesRoughCut;

// The longest film the node takes (a long film is heard in parts, nodesRoughCut.hearRecording).
const MAX_FILM_SECONDS = nodesRoughCut.MAX_RECORDING_SECONDS;
// The frames looked at for the face of a clip: two a second, within these limits.
const FACE_FRAMES_MIN = 8;
const FACE_FRAMES_MAX = 48;
// The lines of the captions of a clip: short, as they are read on a phone.
const CAPTION_CHARS_DEFAULT = 22;

function codedError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

function isAbort(err, ctx) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || Boolean(ctx?.signal?.aborted);
}

function mediaSeconds(value) {
  return value && value.type !== 'list' && Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null;
}

// The words of a connected timing: { words, language } or null where it cannot be read.
function timingWords(text, language) {
  const timing = lyricsTiming.parseTiming(text);
  if (!timing) return null;
  const words = subtitles.usableWords(timing.words);
  const heard = words.map((word) => word.text).join(' ');
  const known = language !== 'auto' && LANGUAGES.includes(language) ? language : LANGUAGES.includes(timing.language) && timing.language !== 'auto' ? timing.language : heard ? languageDetect.detectLanguage(heard) : 'en';
  return { words, language: known };
}

// The language model reads the numbered words and names the clips. Its answer is checked (lib/social-clips.js readClips); one more
// request, with what was wrong, after an answer that cannot be read or holds no usable clip. Returns { clips, costs }.
async function modelClips(ctx, params, { words, language, instructions, settings }) {
  const costs = [];
  const transcript = roughCut.transcriptForModel(words);
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generate.askModel(ctx, params, {
      system: socialClips.systemPrompt(),
      prompt: socialClips.userPrompt({ transcript, instructions, language, ...settings, feedback }),
      json: true
    });
    costs.push(result.usd);
    const read = socialClips.readClips(result.text, words, settings);
    if (read.readable && read.clips.length) {
      for (const problem of read.problems.slice(0, 3)) ctx.log(`Left out: ${problem}`);
      return { clips: read.clips, costs };
    }
    feedback = read.problems.slice(0, 4).join('; ') || 'it named no clip.';
    ctx.log(`${read.readable ? 'The language model named no usable clip' : 'The answer of the language model could not be read'} (${read.problems[0] || 'an empty list'})${attempt === 0 ? ': asking once more' : ''}`);
  }
  throw codedError('SOCIALCLIPS_MODEL_ANSWER', 'The language model named no usable clip');
}

// Where the face is in a clip (shares of the frame) or null: a few frames of the clip, small and grey, and the face finder over
// them in a thread of its own. A failure is no reason to stop: the clip then shows the whole frame on a blurred background.
async function measureFocus(ctx, { file, scratch, clip, index }) {
  const count = Math.min(FACE_FRAMES_MAX, Math.max(FACE_FRAMES_MIN, Math.round(clip.duration * 2)));
  const raw = path.join(scratch, `faces-${index}.raw`);
  try {
    await ffmpeg.runProcess(ffmpeg.binaries().ffmpeg, socialClips.faceFramesArgs({ input: file, output: raw, start: clip.start, duration: clip.duration, count }), {
      timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS,
      signal: ctx.signal
    });
    const perFrame = await facesLib.facesOfFile(raw, Array.from({ length: count }, (_unused, frame) => frame), { signal: ctx.signal });
    return socialClips.focusOf(perFrame);
  } catch (err) {
    if (isAbort(err, ctx)) throw err;
    ctx.log(`Clip ${index + 1}: the face could not be looked for (${String(err?.message || err).slice(0, 120)}); the clip shows the whole frame`);
    return null;
  } finally {
    await fsp.rm(raw, { force: true }).catch(() => {});
  }
}

const socialClipsDefinition = {
  type: 'video.social_clips',
  category: 'edit-video',
  provider: 'elevenlabs',
  label: 'Social clips from film',
  keywords: ['social clips', 'clips', 'highlights', 'best moments', 'shorts', 'reels', 'tiktok', 'linkedin', 'portrait', '9:16', 'vertical', 'repurpose', 'clipping', 'long video', 'podcast', 'interview', 'webinar', 'talk', 'transcript', 'scribe', 'ffmpeg'],
  description:
    'Finds the strongest passages of a film with speech (interview, talk, podcast, webinar, explainer) and cuts them as short clips for ' +
    'Reels, Shorts, TikTok and LinkedIn. ElevenLabs (Scribe) hears the words with their times, a language model picks the passages that ' +
    'stand on their own and open with a hook (it names words, never times), the edges are put at the ends of sentences and on the frame ' +
    'grid, and ffmpeg cuts locally. Portrait 9:16 by default: the crop is put around the face measured in each clip; without a face, or on request, the whole ' +
    'frame is shown on a blurred background. Outputs: the clips (a list), the times of the words of every clip (a list, for "Burn in captions"), a text ' +
    'for the post of every clip and an overview with the reasons. Films up to 120 minutes. Price: the transcript by the length of the film ' +
    '(about 4 cents for 10 minutes; nothing with a connected timing) and the language model.',
  inputs: [
    { id: 'video', type: 'video', required: true },
    { id: 'timing', type: 'text' },
    { id: 'instructions', type: 'text', param: 'instructions' }
  ],
  outputs: [
    { id: 'clips', type: 'video[]' },
    { id: 'timing', type: 'text[]' },
    { id: 'posts', type: 'text[]' },
    { id: 'info', type: 'text' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'instructions', kind: 'textarea', default: '' },
    { id: 'clip_count', kind: 'integer', min: socialClips.COUNT_MIN, max: socialClips.COUNT_MAX, default: socialClips.COUNT_DEFAULT, inline: true },
    { id: 'format', kind: 'select', options: socialClips.FORMATS, default: '9:16', inline: true },
    { id: 'framing', kind: 'select', options: socialClips.FRAMINGS, default: 'face', showIf: { param: 'format', in: Object.keys(socialClips.SIZES) } },
    { id: 'min_seconds', kind: 'integer', min: socialClips.SECONDS_MIN, max: socialClips.SECONDS_MAX, default: socialClips.MIN_SECONDS_DEFAULT },
    { id: 'max_seconds', kind: 'integer', min: socialClips.SECONDS_MIN, max: socialClips.SECONDS_MAX, default: socialClips.MAX_SECONDS_DEFAULT },
    { id: 'max_chars', kind: 'integer', min: subtitles.MAX_CHARS_MIN, max: subtitles.MAX_CHARS_MAX, default: CAPTION_CHARS_DEFAULT },
    { id: 'language', kind: 'select', options: LANGUAGES, default: 'auto' }
  ],
  paid: true,
  // the transcript by the length of the film and the language model by its tokens: only an earlier run of the node knows the sum
  cost: { unit: 'usd', estimate: () => null },
  available: () => {
    const reasons = [ffmpegAvailable(), elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set'];
    const missing = reasons.find((reason) => reason !== true);
    if (missing) return missing;
    return llmAvailable();
  },
  validate: (params) =>
    Number(params.min_seconds) > Number(params.max_seconds)
      ? [{ code: 'SOCIALCLIPS_LENGTHS', message: 'The shortest length of a clip must not be greater than the longest' }]
      : [],
  execute: async (ctx, inputs, params) => {
    const video = inputs.video;
    if (video.sessionId !== ctx.sessionId) throw new Error(`Asset ${video.assetId} belongs to another session`);
    const binaries = ffmpeg.binaries();
    if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
    const file = assets.assetFilePath(video);
    const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!probe.video?.width || !probe.video?.height) throw codedError('SOCIALCLIPS_NO_PICTURE', 'The input has no picture');
    const duration = probe.duration || mediaSeconds(video);
    if (!(duration > 0)) throw codedError('SOCIALCLIPS_NO_PICTURE', 'The length of the film is unknown');
    if (duration > MAX_FILM_SECONDS) throw codedError('SOCIALCLIPS_TOO_LONG', `The film is longer than ${MAX_FILM_SECONDS / 60} minutes`, { minutes: MAX_FILM_SECONDS / 60 });

    const costs = [];
    let words;
    let language;
    const timingText = inputs.timing && typeof inputs.timing.value === 'string' ? inputs.timing.value.trim() : '';
    if (timingText) {
      const known = timingWords(timingText, params.language);
      if (!known) throw codedError('SOCIALCLIPS_TIMING_INVALID', 'The timing is empty or unreadable');
      ({ words, language } = known);
      ctx.log(`From the timing: ${words.length} words, no transcript needed`);
    } else {
      if (!probe.audio) throw codedError('SOCIALCLIPS_NO_AUDIO', 'The film has no sound, so there are no words to choose clips by');
      const heard = await nodesRoughCut.hearRecording(ctx, video, { language: params.language, duration });
      ({ words, language } = heard);
      costs.push(...heard.costs);
      ctx.log(`Heard ${words.length} words in ${lyricsTiming.formatTime(duration)} (${language})`);
    }
    words = words.filter((word) => word.start < duration);
    if (!words.length) throw codedError('SOCIALCLIPS_NO_WORDS', 'No words were heard in the film');
    if (words.length > socialClips.MAX_MODEL_WORDS) throw codedError('SOCIALCLIPS_TOO_MANY_WORDS', `The film has more than ${socialClips.MAX_MODEL_WORDS} words`, { words: socialClips.MAX_MODEL_WORDS });

    // a film shorter than the wanted clips: the lengths give way, so a short film still gives its best passage
    const spoken = words[words.length - 1].end - words[0].start;
    const settings = socialClips.normaliseSettings({ count: params.clip_count, minSeconds: Math.min(params.min_seconds, Math.max(socialClips.SECONDS_MIN, spoken / 2)), maxSeconds: params.max_seconds });
    const instructions = inputs.instructions ? String(inputs.instructions.value || '') : String(params.instructions || '');
    const answer = await modelClips(ctx, params, { words, language, instructions, settings });
    costs.push(...answer.costs);
    const clips = socialClips.planClips({ words, duration, clips: answer.clips, fps: probe.video.fps });
    ctx.log(`${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}: ${clips.map((clip) => `${lyricsTiming.formatTime(clip.start)}–${lyricsTiming.formatTime(clip.end)}`).join(', ')}`);

    const format = socialClips.FORMATS.includes(params.format) ? params.format : '9:16';
    const framing = socialClips.FRAMINGS.includes(params.framing) ? params.framing : 'face';
    const source = { width: probe.video.width, height: probe.video.height };
    const out = socialClips.outputSize(format, source);
    const cropped = format !== 'source' && Math.abs(source.width / source.height - out.width / out.height) >= 0.01 && framing !== 'fit';

    const videos = await ctx.withLocalSlot(async () => {
      const scratch = await assets.createScratchDir(ctx.sessionId);
      try {
        const made = [];
        for (const [index, clip] of clips.entries()) {
          let focus = null;
          if (cropped && framing === 'face') {
            focus = await measureFocus(ctx, { file, scratch, clip, index });
            ctx.log(focus ? `Clip ${index + 1}: face at ${Math.round(focus.x * 100)} % of the width (in ${Math.round(focus.share * 100)} % of the frames)` : `Clip ${index + 1}: no face found, the clip shows the whole frame on a blurred background`);
          }
          // without a face nobody knows which part of the frame matters: the whole frame is shown rather than a blind crop of its middle
          const clipFraming = cropped && framing === 'face' && !focus ? 'fit' : framing;
          const target = path.join(scratch, `clip-${index + 1}.mp4`);
          const args = socialClips.renderArgs({ input: file, output: target, start: clip.start, end: clip.end, source, format, framing: clipFraming, focus, fps: probe.video.fps, hasAudio: Boolean(probe.audio) });
          const timeoutMs = Math.max(ffmpeg.PROCESS_TIMEOUT_MS, Math.ceil(clip.duration * 6000));
          await ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs, signal: ctx.signal });
          const stat = await fsp.stat(target).catch(() => null);
          if (!stat || !stat.size) throw new Error(`ffmpeg produced no output for clip ${index + 1}`);
          const result = await ops.probeMedia(target, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
          clip.rendered = result.duration || clip.duration;
          made.push(await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: target, prompt: clip.title || `Clip ${index + 1}`, cost: 0, duration: clip.rendered }));
        }
        return made;
      } finally {
        await assets.removeScratchDir(scratch);
      }
    });

    const timings = clips.map((clip) =>
      subtitles.subtitlesFromWords(socialClips.clipWords(words, clip), { maxChars: params.max_chars, maxLines: 1, duration: clip.rendered || clip.duration, source: 'social_clips', language }).timing
    );
    return {
      variants: [
        {
          clips: listValue('video', videos),
          timing: listValue('text', timings.map((timing) => textValue(JSON.stringify(timing)))),
          posts: listValue('text', clips.map((clip) => textValue(socialClips.postText(clip)))),
          info: textValue(socialClips.clipsReport(clips, { language, duration }))
        }
      ],
      cost: usdCost(costs)
    };
  }
};

function registerAll(registry) {
  registry.register(socialClipsDefinition);
}

module.exports = { registerAll, socialClipsDefinition, MAX_FILM_SECONDS };
