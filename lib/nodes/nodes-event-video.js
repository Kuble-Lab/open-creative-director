'use strict';

// The event video (WP53), the nodes of the style, the music and the plan:
//   event_video.style   the choice of the app (event type, mood, length, format, language) as the style v1 of lib/event-video/contract.js (D16) and the format
//                       on its own: the style has no format, so a new format never changes the key of the music or the plan. Local, free; it says its
//                       outputs before it runs (cacheStampOutputs), so the music and the plan know the length for their estimate.
//   event_video.music   the music of the film: the own music when one is connected (passed on, free; under 20 s is EVENTMUSIC_TOO_SHORT), else ElevenLabs
//                       with the prompt the code builds from the style (lib/event-video/styles.js musicPrompt), instrumental, the film plus 2 s.
//   event_video.plan    the planner (lib/event-video/plan.js, pure and tested without a network; this is the adapter): the grid on the beats, the language model
//                       (Opus 5.5 unless another is chosen) chooses the material and writes the texts, the code checks and repairs, sets every time and writes
//                       shots v1 and graphics v1, the board, a contact sheet of the chosen shots and the lists for the AI clips, the depth maps and the voice.
// The analysis of the clips and photos (event_video.analyze), the cut and the render (event_video.cut, .render) are in their own files.

const fsp = require('fs/promises');
const path = require('path');

const tools = require('../tools');
const ffmpeg = require('../ffmpeg');
const or = require('../openrouter');
const store = require('../store');
const explainerPlan = require('../explainer-plan');
const contract = require('../event-video/contract');
const styles = require('../event-video/styles');
const eventPlan = require('../event-video/plan');
const assets = require('./assets');
const explainerNodes = require('./nodes-explainer');
const falNodes = require('./nodes-fal');
const generate = require('./nodes-generate');
const jobs = require('./jobs');
const ops = require('./ffmpeg-ops');
const { textValue, listValue } = require('./types');

// the model of the music is the one of audio.music
const { askModel, usdCost, llmAvailable, MODEL_PARAM, MUSIC_MODEL_PARAM, itemsOf } = generate;
const { ERRORS } = contract;

// The analysis of a clip or photo by the vision model (event_video.analyze, spec §2: Sonnet 5.5, about 0.006 USD an element) for the estimate on the board.
const VISION_USD_PER_ITEM = 0.006;
// the AI clips of the photos (event-video.json: fal.h3_video turbo, 768P)
const CLIP_RESOLUTION = '768P';
// the music is the film plus this much (spec §3)
const MUSIC_EXTRA_SECONDS = 2;
// own music under this is EVENTMUSIC_TOO_SHORT (the film would be under 18 s)
const OWN_MUSIC_MIN_SECONDS = 20;
// the contact sheet of the chosen shots: 6 a row, 320 x 180 each
const SHEET = Object.freeze({ columns: 6, width: 320, height: 180, padding: 4 });

function eventError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

const textOf = (inputs, id) => (inputs[id] ? String(inputs[id].value ?? '') : '');
const isAbort = (err, ctx) => Boolean(ctx.signal?.aborted) || jobs.isAbortError(err);
const isFatal = (err, ctx) => isAbort(err, ctx) || err?.name === 'BudgetError' || err?.name === 'RoleRestrictedError';

/* ---------- event_video.style ---------- */

// The outputs of the style node from its parameters (also before it runs).
function styleOutputs(params) {
  const choice = styles.readChoice(params);
  const style = styles.combineStyle(choice);
  return { style: textValue(styles.styleText(style)), format: textValue(choice.format) };
}

function readStyleInput(inputs) {
  const text = textOf(inputs, 'style');
  let style = null;
  try {
    style = JSON.parse(text);
  } catch (_) {
    style = null;
  }
  const check = contract.checkStyle(style);
  if (!check.ok) throw new Error(`style: the text is not the style of "Event video style" (${check.problems[0] || 'empty'})`);
  return style;
}

const styleDefinition = {
  type: 'event_video.style',
  category: 'utility',
  label: 'Event video style',
  keywords: ['event', 'event video', 'aftermovie', 'style', 'mood', 'look', 'conference', 'party', 'corporate', 'format'],
  description:
    'The style of an event video from five choices: the kind of event (corporate, conference, workshop, launch, party, celebration; festival is read as a ' +
    'warmer party with more grain), the mood (fresh, calm, fast, emotional, epic, elegant), the length (30, 60 or 90 s), the format (16:9, 9:16, 1:1) and the ' +
    'language of the texts (de, en, es). Output "style" is the combined style (tempo, cuts, look, transitions, fonts, title animation, the energy of the acts, ' +
    'the soundbites) for the music and the plan; output "format" goes to the cut and the render. The style holds no format: another format makes only the cut ' +
    'and the render again. Free.',
  inputs: [],
  outputs: [
    { id: 'style', type: 'text' },
    { id: 'format', type: 'text' }
  ],
  params: [
    { id: 'event_type', kind: 'select', options: [...contract.EVENT_TYPES, ...Object.keys(contract.EVENT_TYPE_ALIASES)], default: contract.DEFAULTS.event_type, inline: true },
    { id: 'mood', kind: 'select', options: contract.MOODS.slice(), default: contract.DEFAULTS.mood, inline: true },
    { id: 'length', kind: 'select', options: contract.LENGTHS.map(String), default: String(contract.DEFAULTS.length), inline: true },
    { id: 'format', kind: 'select', options: contract.FORMATS.slice(), default: contract.DEFAULTS.format, inline: true },
    { id: 'language', kind: 'select', options: contract.LANGUAGES.slice(), default: contract.DEFAULTS.language }
  ],
  cost: { unit: 'local' },
  // the outputs follow from the parameters alone: said before the node runs, so the music and the plan can estimate with the length
  cacheStamp: () => ({ style: contract.STYLE_VERSION }),
  cacheStampOutputs: (_raw, { params }) => {
    try {
      return { outputs: styleOutputs(params), unknown: [] };
    } catch (_) {
      return null;
    }
  },
  validate: (params) => {
    try {
      styles.readChoice(params);
      return [];
    } catch (err) {
      return [{ level: 'error', code: err.code, data: err.data, message: err.message }];
    }
  },
  execute: async (_ctx, _inputs, params) => ({ variants: [styleOutputs(params)] })
};

/* ---------- event_video.music ---------- */

// The length of the music the node asks for: the film plus 2 s.
const musicSecondsOf = (style) => style.length + MUSIC_EXTRA_SECONDS;

// The price: nothing with own music, else the music of the length of the style (unknown style: the longest film, too high is better than too low).
function musicEstimate(_params, context) {
  const inputs = context?.inputs || {};
  if (itemsOf(inputs, 'own').length) return { usd: 0 };
  let seconds = Math.max(...contract.LENGTHS) + MUSIC_EXTRA_SECONDS;
  if (inputs.style) {
    try {
      seconds = musicSecondsOf(readStyleInput(inputs));
    } catch (_) {
      /* the longest */
    }
  }
  return { usd: tools.musicEstimateUsd(seconds * 1000) };
}

async function probeSeconds(ctx, value) {
  const probe = await ctx.withLocalSlot(() => ops.probeMedia(assets.assetFilePath(value), { signal: ctx.signal }));
  return probe.duration;
}

const musicDefinition = {
  type: 'event_video.music',
  category: 'audio',
  provider: 'elevenlabs',
  label: 'Event video music',
  keywords: ['event', 'event video', 'music', 'soundtrack', 'instrumental', 'elevenlabs', 'own music', 'audio'],
  description:
    'The music of an event video. With a file at "own" that music is used as it is (free; at least 20 s; shorter than the film it makes the film shorter). ' +
    'Without one ElevenLabs makes instrumental music from the style: genre, tempo, length (the film plus 2 s) and the energy of the acts, never a song or an ' +
    'artist (output "prompt" shows what was asked). Price: about 0.20 USD a minute of music. Needs a paid ElevenLabs plan when no own music is connected.',
  inputs: [
    { id: 'own', type: 'audio', multiple: true, max: 1 },
    { id: 'style', type: 'text', required: true }
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    { id: 'prompt', type: 'text' }
  ],
  params: [MUSIC_MODEL_PARAM],
  paid: true,
  cost: { unit: 'usd', history: false, estimate: musicEstimate },
  // own music needs no ElevenLabs: the key is checked when the music is made
  available: () => true,
  execute: async (ctx, inputs, params) => {
    const style = readStyleInput(inputs);
    const own = itemsOf(inputs, 'own');
    if (own.length > 1) throw new Error('own: at most one piece of music is allowed');
    if (own.length) {
      const value = own[0];
      if (value.type !== 'audio') throw new Error('own: only an audio file is allowed');
      const seconds = Number.isFinite(value.duration) && value.duration > 0 ? value.duration : await probeSeconds(ctx, value);
      if (!(seconds >= OWN_MUSIC_MIN_SECONDS)) {
        throw eventError(ERRORS.EVENTMUSIC_TOO_SHORT, `own: the music is ${Math.round((seconds || 0) * 10) / 10} s long, at least ${OWN_MUSIC_MIN_SECONDS} s are needed`, {
          seconds: Math.round((seconds || 0) * 10) / 10,
          min: OWN_MUSIC_MIN_SECONDS
        });
      }
      if (seconds < style.length) ctx.log(`The own music is ${Math.round(seconds * 10) / 10} s long: the film will be ${Math.max(contract.DURATION_RANGE[0], Math.floor((seconds - 2) * 10) / 10)} s instead of ${style.length} s.`);
      else ctx.log(`The own music is used (${Math.round(seconds * 10) / 10} s, from the start).`);
      return { variants: [{ audio: value, prompt: textValue(`own music, ${Math.round(seconds * 10) / 10} s`) }], cost: { usd: 0 } };
    }
    const seconds = musicSecondsOf(style);
    const prompt = styles.musicPrompt(style, seconds);
    if (!require('../elevenlabs').hasKey()) throw eventError(ERRORS.EVENTMUSIC_FAILED, 'ELEVENLABS_API_KEY is not set: connect your own music at "own"');
    let outcome;
    try {
      outcome = await tools.executeTool(ctx.toolCtx, 'generate_music', { prompt, length_seconds: seconds, instrumental: true, model_id: params.model });
    } catch (err) {
      if (isFatal(err, ctx)) throw err;
      throw eventError(ERRORS.EVENTMUSIC_FAILED, `The music could not be made: ${String(err?.message || err).slice(0, 200)}`, { reason: String(err?.message || err).slice(0, 200) });
    }
    if (!outcome?.asset) throw eventError(ERRORS.EVENTMUSIC_FAILED, 'The music could not be made: ElevenLabs returned no file');
    ctx.log(`Music by ElevenLabs, ${seconds} s: ${prompt}`);
    return {
      variants: [{ audio: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id), prompt: textValue(prompt) }],
      cost: usdCost([typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null])
    };
  }
};

/* ---------- event_video.plan ---------- */

// The prices of the parts of the film for the estimate on the board (null where not known).
function planPrices(model) {
  const llm = explainerPlan.PRICES_PER_MILLION[model];
  const perHour = tools.lyricsTimingUsd(60) * 60;
  const voice = tools.speechEstimateUsd('x'.repeat(1000), tools.DEFAULT_ELEVENLABS_MODEL_ID);
  return {
    visionPerItem: VISION_USD_PER_ITEM,
    speechPerHour: Number.isFinite(perHour) ? perHour : null,
    music: (seconds) => tools.musicEstimateUsd(seconds * 1000),
    llm: llm ? { inputPerMillion: llm[0], outputPerMillion: llm[1], charsPerToken: explainerPlan.CHARS_PER_TOKEN } : null,
    depth: falNodes.PRICES.depthMap.usd,
    clipPerSecond: falNodes.PRICES.turbo[CLIP_RESOLUTION],
    voicePerChar: voice === null ? null : voice / 1000
  };
}

const optionsOf = (params) => ({
  photoMotion: params.photo_motion === 'ai' ? 'ai' : 'code',
  parallax: params.parallax !== false,
  maxAiPhotos: Number(params.max_ai_photos) || 0,
  voiceover: params.voiceover === true,
  lowerThirds: params.lower_thirds !== false,
  soundbites: params.soundbites === 'off' ? 'off' : 'auto',
  allowPlain: params.allow_plain === true
});

const infoTexts = (inputs, id) => itemsOf(inputs, id).map((value) => String(value?.value ?? ''));

// The price of the node itself, the language model, for one answer: from the prompt of the material when the analysis is there, else from the typical material of
// spec §2 at the length of the style (60 s while the style is not known). null where the price of the model is not known.
function planEstimate(params, context) {
  const named = String(params.model || '').trim();
  const model = named || explainerNodes.DEFAULT_MODEL;
  const restricted = context?.config?.restrictedBrainModels || [];
  if (!named && ((restricted.length && !restricted.includes(explainerNodes.DEFAULT_MODEL)) || !or.hasKey())) return null;
  const price = explainerPlan.PRICES_PER_MILLION[model];
  if (!price) return null;
  const inputs = context?.inputs || {};
  let style = null;
  if (inputs.style) {
    try {
      style = readStyleInput(inputs);
    } catch (_) {
      style = null;
    }
  }
  if (!style) style = styles.combineStyle({});
  const prices = { llm: { inputPerMillion: price[0], outputPerMillion: price[1], charsPerToken: explainerPlan.CHARS_PER_TOKEN } };
  try {
    if (inputs.music_analysis && (inputs.video_info || inputs.photo_info)) {
      const material = eventPlan.readMaterial(infoTexts(inputs, 'video_info'), infoTexts(inputs, 'photo_info'));
      const options = optionsOf(params);
      const grid = eventPlan.planGrid({ analysis: textOf(inputs, 'music_analysis'), style, material, options });
      const promptChars =
        eventPlan.systemPrompt({ style, grid, material, options }).length + eventPlan.userPrompt({ brief: textOf(inputs, 'brief') || params.brief || '', style, grid, material }).length;
      return { usd: eventPlan.estimate({ picks: grid.picks, promptChars }, prices).parts.llm };
    }
  } catch (_) {
    /* the typical material below */
  }
  const picks = Math.round((styles.derive(style).cpm * style.length) / 60);
  return { usd: eventPlan.estimate({ picks, promptChars: eventPlan.typicalPromptChars() }, prices).parts.llm };
}

async function runFfmpeg(ctx, args) {
  const { ffmpeg: command } = ffmpeg.binaries();
  return ctx.withLocalSlot(() => ffmpeg.runProcess(command, args, { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }));
}

// The contact sheet of the chosen shots in the order of the board: a frame of every clip in the middle of what the shot plays, every photo whole, 6 a row.
// Null (and a line in the log) when it cannot be made: the plan does not depend on it.
async function selectionSheet(ctx, { sources, videos, photos }) {
  if (!ffmpeg.binaries().available || !sources.length) return null;
  const scratch = await assets.createScratchDir(ctx.sessionId);
  try {
    const { width, height, columns, padding } = SHEET;
    const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1`;
    const rows = Math.ceil(sources.length / columns);
    for (let index = 0; index < rows * columns; index += 1) {
      const out = path.join(scratch, `t${String(index).padStart(3, '0')}.jpg`);
      const source = sources[index];
      if (!source) {
        await runFfmpeg(ctx, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x111111:s=${width}x${height}`, '-frames:v', '1', out]);
        continue;
      }
      const value = source.kind === 'video' ? videos[source.index] : photos[source.index];
      const file = assets.assetFilePath(value);
      const seek = source.kind === 'video' ? ['-ss', String(Math.max(0, source.at))] : [];
      await runFfmpeg(ctx, ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', ...seek, '-i', file, '-frames:v', '1', '-vf', fit, '-q:v', '4', out]);
    }
    const sheet = path.join(scratch, 'selection.jpg');
    await runFfmpeg(ctx, [
      '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(scratch, 't%03d.jpg'),
      '-vf', `tile=${columns}x${rows}:padding=${padding}:margin=${padding}:color=0x111111`, '-frames:v', '1', '-q:v', '3', sheet
    ]);
    return await ctx.saveOutputFile({ kind: 'image', ext: '.jpg', sourceFile: sheet, prompt: `Event video: the ${sources.length} chosen shots in the order of the board` });
  } catch (err) {
    if (isFatal(err, ctx)) throw err;
    ctx.log(`The contact sheet of the chosen shots could not be made (${String(err?.message || err).slice(0, 160)}); the plan is complete without it.`);
    return null;
  } finally {
    await assets.removeScratchDir(scratch).catch(() => {});
  }
}

// Whether the music was made by the music node (ElevenLabs) or is the person's own: the model of its asset.
async function ownMusicOf(ctx, value) {
  try {
    const ledger = await store.readLedger(ctx.sessionId);
    const entry = ledger.find((item) => item.id === value.assetId);
    return !(entry && /^elevenlabs\//.test(String(entry.model || '')));
  } catch (_) {
    return false;
  }
}

const planDefinition = {
  type: 'event_video.plan',
  category: 'video',
  provider: 'llm',
  label: 'Plan event video',
  keywords: ['event', 'event video', 'aftermovie', 'plan', 'storyboard', 'board', 'soundbites', 'lower thirds', 'title', 'llm'],
  description:
    'Plans an event video from the analysis of the clips and photos, the description of the event, the style and the beats of the music. The code lays the grid: ' +
    'six acts (hook, arrival, programme, people, peak, close) on the downbeats and the number of shots from the style; with little material the photo shots get ' +
    'longer (up to about 4.5 s), a photo may come back once as a detail of another part, and only then the film gets shorter. A language model (Claude Opus 5.5 ' +
    'unless you choose another) chooses which scene or photo goes where, the soundbites by their words, the title, the lower thirds, the intertitles and the end ' +
    'card. The code checks everything: unknown or unusable material is replaced by the best by score, a soundbite is whole sentences of the length of the style, a ' +
    'name or number that is not in the description, a transcript or a text in an image is removed; a second try gets the list of problems. When the code had to ' +
    'replace more than a quarter of the picks the node stops (EVENTPLAN_MODEL_FAILED) unless "Allow a plain plan" is on. The code sets every time, crop, transition, ' +
    'colour and slow motion. Outputs: the shots for the cut, the graphics for the render, the board, a contact sheet of the chosen shots, the photos and prompts ' +
    'for the AI clips, the photos for the depth maps and the lines of the voice. A film of photos only works as well (no soundbites, no sound of the clips). ' +
    'Price: the language model, about 0.35 to 0.50 USD for one answer (a second up to as much again).',
  inputs: [
    { id: 'brief', type: 'text', required: true, param: 'brief' },
    { id: 'style', type: 'text', required: true },
    { id: 'videos', type: 'video[]' },
    { id: 'photos', type: 'image[]' },
    { id: 'video_info', type: 'text[]' },
    { id: 'photo_info', type: 'text[]' },
    { id: 'music', type: 'audio', required: true },
    { id: 'music_analysis', type: 'text', required: true },
    { id: 'brand', type: 'text' }
  ],
  outputs: [
    { id: 'shots', type: 'text' },
    { id: 'graphics', type: 'text' },
    { id: 'board', type: 'text' },
    { id: 'selection', type: 'image' },
    { id: 'ai_photos', type: 'image[]' },
    { id: 'ai_prompts', type: 'text[]' },
    { id: 'parallax_photos', type: 'image[]' },
    { id: 'vo_lines', type: 'text[]' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'brief', kind: 'textarea', default: '', inline: true },
    { id: 'photo_motion', kind: 'select', options: ['code', 'ai'], default: 'code', inline: true },
    { id: 'parallax', kind: 'boolean', default: true },
    { id: 'max_ai_photos', kind: 'integer', min: 0, max: contract.MAX_AI_PHOTOS, default: 0 },
    { id: 'voiceover', kind: 'boolean', default: false },
    { id: 'lower_thirds', kind: 'boolean', default: true },
    { id: 'soundbites', kind: 'select', options: ['auto', 'off'], default: 'auto' },
    { id: 'allow_plain', kind: 'boolean', default: false }
  ],
  paid: true,
  // the model of the settings when OpenRouter is missing (chooseModel falls back to it): it is not a parameter, so it is part of the key then
  cacheStamp: async (params, ctx) => explainerNodes.fallbackBrainStamp(params, ctx),
  cost: { unit: 'usd', estimate: planEstimate, history: false },
  available: () => llmAvailable(),
  execute: async (ctx, inputs, params) => {
    const brief = textOf(inputs, 'brief').trim();
    if (!brief) throw eventError(ERRORS.EVENTPLAN_BRIEF_EMPTY, 'brief: describe the event (what, when, where, who): it is the only source of the facts on the screen');
    const style = readStyleInput(inputs);
    const videos = itemsOf(inputs, 'videos');
    const photos = itemsOf(inputs, 'photos');
    const videoInfo = infoTexts(inputs, 'video_info');
    const photoInfo = infoTexts(inputs, 'photo_info');
    if (videoInfo.length !== videos.length) throw new Error(`video_info: ${videoInfo.length} analyses for ${videos.length} videos (connect the analysis of the same list)`);
    if (photoInfo.length !== photos.length) throw new Error(`photo_info: ${photoInfo.length} analyses for ${photos.length} photos (connect the analysis of the same list)`);
    for (const [label, list, type] of [['videos', videos, 'video'], ['photos', photos, 'image']]) {
      for (const value of list) {
        if (value?.type !== type) throw new Error(`${label}: only ${type} files are allowed`);
        if (value.sessionId !== ctx.sessionId) throw new Error(`${label}: asset ${value.assetId} belongs to another workflow`);
      }
    }
    if (llmAvailable() !== true) throw eventError(ERRORS.EVENTPLAN_NO_LLM, 'No language model is available: OPENROUTER_API_KEY is not set and ChatGPT is not connected');
    const model = explainerNodes.chooseModel(ctx, params);
    const music = inputs.music;
    const analysisText = textOf(inputs, 'music_analysis');
    let musicSeconds = Number.isFinite(music?.duration) && music.duration > 0 ? music.duration : null;
    if (musicSeconds === null) {
      try {
        musicSeconds = await probeSeconds(ctx, music);
      } catch (err) {
        if (isFatal(err, ctx)) throw err;
        musicSeconds = null;
      }
    }
    const result = await eventPlan.runEventPlanner({
      brief,
      style,
      videos: videoInfo,
      photos: photoInfo,
      analysis: analysisText,
      musicSeconds,
      ownMusic: await ownMusicOf(ctx, music),
      brand: inputs.brand ? textOf(inputs, 'brand') : null,
      options: optionsOf(params),
      ask: (request) => askModel(ctx, { ...params, model }, request),
      log: (line) => ctx.log(line),
      fatal: (err) => isFatal(err, ctx),
      prices: planPrices(model)
    });
    for (const record of result.tries) {
      ctx.log(
        `Language model, request ${record.request}${record.again ? ' (asked again after an empty answer)' : ''}: effort ${record.effort}, ${record.completion === null ? 'tokens not reported' : `${record.completion} tokens out${record.reasoning === null ? '' : ` (${record.reasoning} thinking)`}`}, ${record.finish}${typeof record.usd === 'number' ? `, ${record.usd.toFixed(4)} USD` : ''}.`
      );
    }
    for (const note of result.notes.slice(0, 4)) ctx.log(`Plan note: ${note}`);
    const shots = result.shots.shots;
    ctx.log(
      `${shots.length} shots in ${result.grid.duration} s (${shots.filter((shot) => shot.kind === 'soundbite').length} soundbites), ${result.aiPhotos.length} AI clips, ${result.parallaxPhotos.length} depth maps, ${result.voLines.length} lines of voice` +
        `${result.cost.total === null ? '' : `; the film costs about ${result.cost.total.toFixed(2)} USD, ${result.cost.step2.toFixed(2)} USD of it after the approval`}`
    );
    const selection = await selectionSheet(ctx, { sources: result.sources, videos, photos });
    return {
      variants: [
        {
          shots: textValue(JSON.stringify(result.shots)),
          graphics: textValue(JSON.stringify(result.graphics)),
          board: textValue(result.board),
          ...(selection ? { selection } : {}),
          ai_photos: listValue('image', result.aiPhotos.map((index) => photos[index])),
          ai_prompts: listValue('text', result.aiPrompts.map((prompt) => textValue(prompt))),
          parallax_photos: listValue('image', result.parallaxPhotos.map((index) => photos[index])),
          vo_lines: listValue('text', result.voLines.map((line) => textValue(line)))
        }
      ],
      cost: usdCost(result.costs)
    };
  }
};

const definitions = [styleDefinition, musicDefinition, planDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  VISION_USD_PER_ITEM,
  MUSIC_EXTRA_SECONDS,
  OWN_MUSIC_MIN_SECONDS,
  styleOutputs,
  readStyleInput,
  musicEstimate,
  planEstimate,
  planPrices,
  optionsOf,
  selectionSheet
};
