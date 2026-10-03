'use strict';

// Music video nodes (WP34): from a song to a music video cut to the beat.
//   audio.beats           tempo, beats, sections and loudness of a song (local, free)
//   audio.lyrics_timing   the times of the sung words and lines (ElevenLabs, paid by the hour of audio)
//   music_video.plan      the scenes: cuts on the beats and the lyric lines, an image prompt and a motion for each, the scenes
//                         for the singer with the exact slice of the song
//   music_video.edit      the clips cut to the beat with the song underneath (local, free)
// The work is done by lib/music-analysis.js, lib/lyrics-timing.js (with the tool `lyrics_timing` of lib/tools.js),
// lib/music-video-plan.js and lib/music-video-edit.js: pure, tested on their own. This module is the adapter between them and
// the engine: inputs and parameters, files, costs and the codes of the errors.
// The lists between the nodes follow the scenes: story_prompts, story_motion and the clips made from them come back in the order of
// the scenes of kind "story", performance_* of the scenes of kind "singer"; a list may be empty (no scenes of that kind).

const path = require('path');

const tools = require('../tools');
const elevenlabs = require('../elevenlabs');
const ffmpeg = require('../ffmpeg');
const lyricsTiming = require('../lyrics-timing');
const musicAnalysis = require('../music-analysis');
const planLib = require('../music-video-plan');
const editLib = require('../music-video-edit');
const renderLib = require('../music-video-render');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const generate = require('./nodes-generate');
const { runOp } = require('./nodes-edit');
const { textValue, numberValue, listValue } = require('./types');

const { askModel, usdCost, llmAvailable, MODEL_PARAM } = generate;

/* ---------- shared helpers ---------- */

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

function elevenLabsAvailable() {
  return elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set';
}

// An error with a stable code (upper case words) that the interface shows in its own language; `data` fills its placeholders.
function musicVideoError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

function textOf(inputs, portId) {
  return inputs[portId] ? String(inputs[portId].value || '') : '';
}

// 75.4 -> "1:15.4"
const stamp = (seconds) => lyricsTiming.formatTime(seconds);

/* ---------- audio.beats ---------- */

const WARNING_LOGS = Object.freeze({
  NO_PULSE: 'No clear pulse was found: the beats are a regular grid at the tempo of the plan or 120 BPM.',
  PLAN_LENGTH_MISMATCH: 'The song plan is much longer or shorter than the audio: its sections were not used, the sections come from the sound.'
});

const beatsDefinition = {
  type: 'audio.beats',
  category: 'audio',
  label: 'Analyze song',
  keywords: ['beats', 'beat', 'bpm', 'tempo', 'rhythm', 'sections', 'analyze', 'analysis', 'song', 'music video', 'audio', 'ffmpeg'],
  description:
    'Finds the tempo (BPM), the beats, the sections and the loudness of a song, on this machine and free of charge. A connected song plan ' +
    'gives the names and lengths of the sections and a tempo hint. The analysis is a JSON text for "Plan music video".',
  inputs: [
    { id: 'audio', type: 'audio', required: true },
    { id: 'plan', type: 'text' }
  ],
  outputs: [
    { id: 'analysis', type: 'text' },
    { id: 'bpm', type: 'number' }
  ],
  params: [],
  cost: { unit: 'local' },
  available: ffmpegAvailable,
  execute: async (ctx, inputs) => {
    const file = assets.assetFilePath(inputs.audio);
    const result = await ctx.withLocalSlot(() => musicAnalysis.analyseFile(file, { planText: textOf(inputs, 'plan'), signal: ctx.signal }));
    for (const code of result.warnings) if (WARNING_LOGS[code]) ctx.log(WARNING_LOGS[code]);
    ctx.log(`${Math.round(result.bpm)} BPM, ${result.beats.length} beats, ${result.sections.length} sections, ${Math.round(result.duration)} s`);
    return { variants: [{ analysis: textValue(JSON.stringify(result)), bpm: numberValue(result.bpm) }] };
  }
};

/* ---------- audio.lyrics_timing ---------- */

// The price of the node: by the hour of audio (lib/tools.js, lyricsTimingUsd). The length is known when the song reaches the node
// with its duration (a song from the music node, or any step before that already ran). An uploaded file carries none: the plan then
// shows no price (never an invented one); what is booked is always the measured length.
function timingEstimate(_params, context) {
  const audio = context?.inputs?.audio;
  const seconds = audio && audio.type !== 'list' ? audio.duration : null;
  return Number.isFinite(seconds) && seconds > 0 ? tools.lyricsTimingUsd(seconds) : null;
}

const lyricsTimingDefinition = {
  type: 'audio.lyrics_timing',
  category: 'audio',
  provider: 'elevenlabs',
  label: 'Lyrics timing (ElevenLabs)',
  keywords: ['lyrics', 'timing', 'words', 'lines', 'karaoke', 'align', 'alignment', 'transcribe', 'transcript', 'scribe', 'song', 'elevenlabs', 'audio'],
  description:
    'Finds when each word and each line of a song is sung. With the text (or a song plan) the text is aligned to the audio, without it the ' +
    'words are recognised (Scribe). Output "timing" is a JSON text for "Plan music video", output "lyrics" the readable lines with their times. ' +
    'Price: an estimate by the hour of audio (ELEVENLABS_TIMING_USD_PER_HOUR), a few cents for a song.',
  inputs: [
    { id: 'audio', type: 'audio', required: true },
    { id: 'lyrics', type: 'text', param: 'lyrics' }
  ],
  outputs: [
    { id: 'timing', type: 'text' },
    { id: 'lyrics', type: 'text' }
  ],
  params: [
    { id: 'lyrics', kind: 'textarea', default: '' },
    { id: 'method', kind: 'select', options: tools.TIMING_METHODS, default: 'auto', inline: true }
  ],
  paid: true,
  // the length of the song is not a thing to guess from an earlier run: the plan uses the length it knows, else no price
  cost: { unit: 'usd', history: false, estimate: timingEstimate },
  available: elevenLabsAvailable,
  validate: (params, ports) =>
    params.method === 'align' && !ports.lyrics?.connected && !String(params.lyrics || '').trim()
      ? [{ code: 'TIMING_NO_LYRICS', port: 'lyrics', message: 'lyrics: the alignment needs the text that is sung; write or connect it, or choose the method "transcribe"' }]
      : [],
  execute: async (ctx, inputs, params) => {
    const audio = inputs.audio;
    if (audio.sessionId !== ctx.sessionId) throw new Error(`Asset ${audio.assetId} belongs to another session`);
    const outcome = await tools.executeTool(ctx.toolCtx, 'lyrics_timing', {
      audio_asset_id: audio.assetId,
      text: textOf(inputs, 'lyrics'),
      method: params.method,
      duration_seconds: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined
    });
    if (!outcome?.timing) throw new Error('lyrics_timing returned no timing');
    const { timing } = outcome;
    ctx.log(`${outcome.method === 'align' ? 'Aligned the text' : 'Recognised the words'}: ${timing.lines.length} lines, ${timing.words.length} words, ${Math.round(outcome.durationSeconds || timing.duration || 0)} s of audio`);
    if (Number.isFinite(timing.expected) && timing.matched < timing.expected) ctx.log(`${timing.expected - timing.matched} of ${timing.expected} words of the text were not heard and got an estimated time`);
    return { variants: [{ timing: textValue(JSON.stringify(timing)), lyrics: textValue(outcome.readable) }], cost: usdCost([outcome.costUsd]) };
  }
};

/* ---------- music_video.plan ---------- */

const PLAN_WARNING_LOGS = Object.freeze({
  NO_TIMING: 'No lyric times: the scenes are cut on the beats.',
  NO_LYRICS_FOR_PERFORMANCE: 'No scene for the singer could be planned (no sung lines long enough): the share for the singer is 0.',
  SCENES_LONGER_THAN_CLIP: 'Some story scenes are longer than the clip length plus a little slow motion: the last frame is held there. A higher clip length or more scenes per minute avoids that.'
});

// The song slices of the singer's scenes: exact to the sample, as WAV (the lip sync takes them as its audio).
async function sliceSong(ctx, song, scenes) {
  if (!scenes.length) return [];
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
  const file = assets.assetFilePath(song);
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const values = [];
      for (const [index, scene] of scenes.entries()) {
        const out = path.join(scratch, `slice-${index}.wav`);
        await ffmpeg.runProcess(binaries.ffmpeg, editLib.sliceAudioArgs(file, scene.start, scene.duration, out), { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal });
        const probe = await ops.probeMedia(out, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
        values.push(
          await ctx.saveOutputFile({
            kind: 'audio',
            ext: '.wav',
            sourceFile: out,
            prompt: `Song slice ${stamp(scene.start)}-${stamp(scene.end)}`,
            cost: 0,
            duration: probe.duration || undefined
          })
        );
      }
      return values;
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

// The prompts of all scenes from the language model: one answer, a second one for the scenes it left out or wrote badly (told what
// was wrong), and plain prompts (fallbackContent) for what is still missing. Returns { contents, costs, attempts, fallbacks }.
async function writeContent(ctx, params, plan, request) {
  const scenes = plan.scenes;
  const items = scenes.map(() => null);
  const costs = [];
  const unusable = (list) => list.some((item, index) => !item || (scenes[index].kind === 'story' && !item.motion));
  let problems = [];
  let attempts = 0;
  for (let attempt = 0; attempt < 2 && (attempt === 0 || unusable(items)); attempt += 1) {
    let result;
    try {
      result = await askModel(ctx, params, {
        system: planLib.systemPrompt(),
        prompt: planLib.userPrompt({ ...request, plan, problems }),
        json: true
      });
    } catch (err) {
      // the first answer is needed; a failed second one leaves the prompts of the first (and plain ones for the rest)
      if (attempt === 0 || ctx.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
      ctx.log(`The second request to the language model failed (${String(err.message || err).slice(0, 160)}): plain prompts are used for the rest.`);
      break;
    }
    attempts += 1;
    costs.push(result.usd);
    const read = planLib.readContent(result.text, scenes);
    read.items.forEach((item, index) => {
      if (item) items[index] = item;
    });
    problems = read.problems;
    if (attempt === 0 && unusable(items)) ctx.log(`The answer of the language model had ${problems.length} problem${problems.length === 1 ? '' : 's'}: asking once more (${problems.slice(0, 2).join(' ')})`);
  }
  let fallbacks = 0;
  const contents = scenes.map((scene, index) => {
    const item = items[index];
    if (item && (scene.kind !== 'story' || item.motion)) return item;
    fallbacks += 1;
    const plain = planLib.fallbackContent(scene, request);
    return item ? { ...item, motion: plain.motion } : plain;
  });
  return { contents, costs, attempts, fallbacks };
}

const planDefinition = {
  type: 'music_video.plan',
  category: 'video',
  provider: 'llm',
  label: 'Plan music video',
  keywords: ['music video', 'plan', 'scenes', 'shots', 'storyboard', 'beats', 'lyrics', 'song', 'cut', 'revid', 'llm'],
  description:
    'Plans a music video from a song: the cuts follow the beats and the lyric lines, a language model writes an image prompt and a motion for ' +
    'every scene from your brief, and some scenes show the singer (with the exact slice of the song for the lip sync). Outputs are lists in ' +
    'scene order: connect them to image and video nodes, then to "Cut to the beat". At most 50 scenes.',
  inputs: [
    { id: 'analysis', type: 'text', required: true },
    { id: 'timing', type: 'text' },
    { id: 'brief', type: 'text', required: true, param: 'brief' },
    { id: 'characters', type: 'text', param: 'characters' },
    { id: 'song', type: 'audio', required: true }
  ],
  outputs: [
    { id: 'shots', type: 'text' },
    { id: 'story_prompts', type: 'text[]' },
    { id: 'story_motion', type: 'text[]' },
    { id: 'performance_prompts', type: 'text[]' },
    { id: 'performance_audio', type: 'audio[]' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'brief', kind: 'textarea', default: '', inline: true },
    { id: 'characters', kind: 'textarea', default: '' },
    { id: 'style', kind: 'textarea', default: '' },
    { id: 'shots_per_minute', kind: 'slider', min: 6, max: 30, step: 1, default: 14 },
    { id: 'performance_share', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
    { id: 'cut_on', kind: 'select', options: planLib.CUT_MODES, default: 'lines' },
    { id: 'clip_seconds', kind: 'integer', min: 2, max: 10, default: 5 },
    { id: 'aspect_ratio', kind: 'select', options: planLib.ASPECT_RATIOS, default: '16:9' }
  ],
  paid: true,
  // the language model is billed by its tokens: no estimate here, the plan shows the cost of the last run of this node
  cost: { unit: 'usd' },
  available: () => {
    const reason = ffmpegAvailable();
    return reason === true ? llmAvailable() : reason;
  },
  validate: (params, ports) =>
    !ports.timing?.connected && (params.cut_on === 'lines' || params.performance_share > 0)
      ? [{ level: 'warning', code: 'MUSICVIDEO_NO_TIMING', port: 'timing', message: 'timing: without the lyric times the scenes are cut on the beats and there is no scene for the singer' }]
      : [],
  execute: async (ctx, inputs, params) => {
    const brief = textOf(inputs, 'brief').trim();
    if (!brief) throw new Error('brief: describe the idea or the story of the video');
    const plan = planLib.planScenes(textOf(inputs, 'analysis'), textOf(inputs, 'timing'), {
      shotsPerMinute: params.shots_per_minute,
      performanceShare: params.performance_share,
      cutOn: params.cut_on,
      clipSeconds: params.clip_seconds
    });
    for (const code of plan.warnings) if (PLAN_WARNING_LOGS[code]) ctx.log(PLAN_WARNING_LOGS[code]);
    const request = { brief, style: params.style, characters: textOf(inputs, 'characters'), aspectRatio: params.aspect_ratio };
    const written = await writeContent(ctx, params, plan, request);
    if (written.fallbacks) ctx.log(`${written.fallbacks} of ${plan.scenes.length} scenes got plain prompts: the language model did not deliver them.`);
    const shots = planLib.buildShots(plan, written.contents, { aspectRatio: params.aspect_ratio, brief });
    const story = shots.shots.filter((shot) => shot.kind === 'story');
    const performance = shots.shots.filter((shot) => shot.kind === 'performance');
    const slices = await sliceSong(ctx, inputs.song, performance);
    ctx.log(`${shots.shots.length} scenes (${story.length} story, ${performance.length} singer), cut on ${plan.cutOn}, ${Math.round(shots.duration)} s`);
    return {
      variants: [
        {
          shots: textValue(JSON.stringify(shots)),
          story_prompts: listValue('text', story.map((shot) => textValue(shot.prompt))),
          story_motion: listValue('text', story.map((shot) => textValue(shot.motion))),
          performance_prompts: listValue('text', performance.map((shot) => textValue(shot.prompt))),
          performance_audio: listValue('audio', slices)
        }
      ],
      cost: usdCost(written.costs)
    };
  }
};

/* ---------- music_video.edit ---------- */

const editDefinition = {
  type: 'music_video.edit',
  category: 'edit-video',
  label: 'Cut to the beat',
  keywords: ['music video', 'cut', 'edit', 'beat', 'assemble', 'timeline', 'crossfade', 'flash', 'song', 'video', 'ffmpeg'],
  description:
    'Cuts the clips of the scenes to the scene times of the plan and puts the song underneath: every clip starts at the beginning of its scene ' +
    'and is trimmed to its length (a story clip that is too short is slowed down to 0.8 at most, then the last frame is held; the singer is only held, ' +
    'so the lips stay in sync). Local and free. Up to 50 clips.',
  inputs: [
    { id: 'song', type: 'audio', required: true },
    { id: 'shots', type: 'text', required: true },
    { id: 'story', type: 'video', required: true, multiple: true, max: planLib.MAX_SCENES },
    { id: 'performance', type: 'video', multiple: true, max: planLib.MAX_SCENES }
  ],
  outputs: [{ id: 'video', type: 'video' }],
  params: [
    { id: 'transition', kind: 'select', options: editLib.TRANSITIONS, default: 'cut', inline: true },
    { id: 'resolution', kind: 'select', options: editLib.RESOLUTIONS, default: '720p' },
    { id: 'fps', kind: 'select', options: editLib.FPS_VALUES.map(String), default: '25' },
    { id: 'fit', kind: 'select', options: editLib.FIT_MODES, default: 'crop' },
    { id: 'fade_out', kind: 'number', min: 0, max: 10, default: 1 }
  ],
  cost: { unit: 'local' },
  available: ffmpegAvailable,
  execute: async (ctx, inputs, params) => {
    const shots = planLib.parseShots(textOf(inputs, 'shots'));
    const story = itemsOf(inputs, 'story');
    const performance = itemsOf(inputs, 'performance');
    for (const [kind, code, expected, got] of [
      ['story', 'MUSICVIDEO_STORY_MISMATCH', shots.story, story.length],
      ['performance', 'MUSICVIDEO_PERFORMANCE_MISMATCH', shots.performance, performance.length]
    ]) {
      if (expected !== got) throw musicVideoError(code, `${kind}: the plan has ${expected} scenes of this kind but ${got} clips arrived`, { expected, got });
    }
    // input 0 is the song, then the story clips, then the clips of the singer: every scene names the file it takes
    const files = [inputs.song, ...story, ...performance].map((value) => assets.assetFilePath(value));
    const order = shots.shots.map((shot) => 1 + (shot.kind === 'story' ? shot.clip : story.length + shot.clip));
    let built = null;
    const [video] = await runOp(ctx, {
      label: 'Cut to the beat',
      files,
      build: (infos) => {
        built = editLib.buildEditPlan({ shots, order, infos, params });
        return built;
      },
      // many scenes are cut in batches (a few at a time, one encoder): see lib/music-video-edit.js
      execute: ({ spec, files: inputs, outputFiles, ffmpegPath, signal, timeoutMs }) =>
        renderLib.renderPlan(spec, { files: inputs, outputFile: outputFiles[0], ffmpegPath, signal, timeoutMs })
    });
    if (built) {
      const slowed = built.summary.filter((scene) => scene.speed < 1).length;
      const held = built.summary.filter((scene) => scene.fromClip !== null && scene.fromClip < scene.frames / built.fps - 0.05).length;
      ctx.log(
        `${built.summary.length} scenes, ${Math.round(built.seconds)} s at ${built.fps} fps, ${built.width}x${built.height}` +
          `${built.mode === 'batched' ? `, cut in ${built.batches.length} batches` : ''}` +
          `${slowed ? `, ${slowed} clips slowed down` : ''}${held ? `, ${held} clips too short (last frame held)` : ''}`
      );
    }
    return { variants: [{ video }] };
  }
};

const definitions = [beatsDefinition, lyricsTimingDefinition, planDefinition, editDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = { definitions, registerAll, writeContent, sliceSong, timingEstimate };
