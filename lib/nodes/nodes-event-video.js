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
//                       WP55: the marks of the photos (ai_marks: never or surely an AI clip) and the switches of the approval (ai_choice); the switches are
//                       applied to the answer the node keeps (hidden output ai_switches), so they cost no new answer.
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
const { validateVideoDuration } = require('../event-video/analyze');
const explainerNodes = require('./nodes-explainer');
const falNodes = require('./nodes-fal');
const generate = require('./nodes-generate');
const jobs = require('./jobs');
const ops = require('./ffmpeg-ops');
const { textValue, listValue, canonicalJson, sha256Hex } = require('./types');

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
// the choices of the field "AI clips" (max_ai_photos): 0 by the length of the film (2, 4 or 6), the last every photo the plan picks (a list holds
// at most that many). An integer shown as a list, so the saved 0 keeps the cache key of the nodes saved before the field had a list.
const AI_CLIP_CHOICES = Object.freeze([0, 2, 4, 6, 8, 12, 16, contract.MAX_AI_PHOTOS]);
// The marks of the photos in the order of the app (WP55): "auto" (no mark), never an AI clip, surely one; and the switches of the approval: the plan
// decides, on, off. Both are kept by the asset id of the photo, so they follow a photo whose place in the list changes.
const AI_MARKS = Object.freeze(['auto', 'never', 'always']);
const AI_CHOICES = Object.freeze(['auto', 'on', 'off']);
// the version of the hidden output ai_switches (the switches of the approval and the answer they are applied to)
const SWITCHES_VERSION = 1;

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
    // an alias (festival) is read but not offered: the list shows the six types
    { id: 'event_type', kind: 'select', options: contract.EVENT_TYPES.slice(), hiddenOptions: Object.keys(contract.EVENT_TYPE_ALIASES), default: contract.DEFAULTS.event_type, inline: true },
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
  label: 'Event video soundtrack',
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
  validate: (_params, connected) => {
    const sources = connected?.own?.sources || [];
    const uploads = sources.filter((source) => source.type === 'input.media_list');
    const count = uploads.reduce((sum, source) => sum + (source.params.assets || []).length, 0);
    return count > 1 ? [{ level: 'error', code: 'EVENTMUSIC_TOO_MANY_FILES', port: 'own',
      message: 'Upload at most one file of your own music.', data: { node: uploads[0].node, field: 'assets' } }] : [];
  },
  // own music needs no ElevenLabs: the key is checked when the music is made
  available: () => true,
  execute: async (ctx, inputs, params) => {
    const style = readStyleInput(inputs);
    const own = itemsOf(inputs, 'own');
    if (own.length > 1) throw eventError('EVENTMUSIC_TOO_MANY_FILES', 'own: at most one piece of music is allowed', { field: 'own' });
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

// options.aiMarks and options.aiChoice of the planner, by the index of the photo, from the marks of the params, by its asset id (WP55). Nothing without
// marks, so the options are the ones of before.
function markOptions(params, photos) {
  const byIndex = (marks) => {
    const out = {};
    if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return out;
    photos.forEach((value, index) => {
      const mark = value && typeof value.assetId === 'string' && Object.prototype.hasOwnProperty.call(marks, value.assetId) ? marks[value.assetId] : null;
      if (typeof mark === 'string') out[index] = mark;
    });
    return out;
  };
  const aiMarks = byIndex(params.ai_marks);
  const aiChoice = byIndex(params.ai_choice);
  return { ...(Object.keys(aiMarks).length ? { aiMarks } : {}), ...(Object.keys(aiChoice).length ? { aiChoice } : {}) };
}

const hasChoice = (params) => Boolean(params.ai_choice && typeof params.ai_choice === 'object' && Object.keys(params.ai_choice).length);

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
  const picks = Math.round((styles.derive(style).cpm * style.length) / 60);
  // A reused answer records zero: keep looking for the newest paid answer of this node and model.
  for (const entry of context?.results?.nodes?.[context.nodeId]?.history || []) {
    if (!Number.isFinite(entry.cost?.usd) || !(entry.cost.usd > 0) || (String(entry.params?.model || '').trim() || explainerNodes.DEFAULT_MODEL) !== model) continue;
    let previousLength = null;
    try { previousLength = JSON.parse(entry.variants?.[0]?.shots?.value || '').duration; } catch (_) { /* old entries may lack shots */ }
    // Same film length keeps the measured cost; a longer film usually needs proportionally more picks.
    return { usd: entry.cost.usd * (inputs.style && previousLength > 0 ? style.length / previousLength : 1) };
  }
  const prices = { llm: { inputPerMillion: price[0], outputPerMillion: price[1], charsPerToken: explainerPlan.CHARS_PER_TOKEN } };
  try {
    if (inputs.music_analysis && (inputs.video_info || inputs.photo_info)) {
      const material = eventPlan.readMaterial(infoTexts(inputs, 'video_info'), infoTexts(inputs, 'photo_info'));
      const options = { ...optionsOf(params), ...markOptions(params, itemsOf(inputs, 'photos')) };
      const grid = eventPlan.planGrid({ analysis: textOf(inputs, 'music_analysis'), style, material, options });
      const promptChars =
        eventPlan.systemPrompt({ style, grid, material, options }).length + eventPlan.userPrompt({ brief: textOf(inputs, 'brief') || params.brief || '', style, grid, material }).length;
      return { usd: eventPlan.estimate({ picks: grid.picks, promptChars }, prices).parts.llm };
    }
  } catch (_) {
    /* the typical material below */
  }
  const photos = itemsOf(inputs, 'photos');
  const videos = itemsOf(inputs, 'videos');
  // Without analysed material, assume the known uploads; otherwise a modest 17-photo first run.
  const promptChars = eventPlan.typicalPromptChars({ photos: inputs.photos ? photos.length : 17, videos: videos.length,
    videoSeconds: videos.reduce((sum, video) => sum + (video.duration || 10), 0) });
  // A photo-only first run cannot ask for more distinct picks than uploaded photos.
  const estimatedPicks = inputs.photos && inputs.videos && !videos.length ? Math.min(picks, photos.length) : picks;
  return { usd: eventPlan.estimate({ picks: estimatedPicks, promptChars }, prices).parts.llm };
}

// Information about step 2, separate from the price and budget reservation of the planner.
function clipFollowup(params, context) {
  if (params.photo_motion !== 'ai' || !context.inputs.photos) return null;
  const photos = itemsOf(context.inputs, 'photos');
  let length = 60;
  try { length = readStyleInput(context.inputs).length; } catch (_) { /* default style */ }
  const requested = Number(params.max_ai_photos) || eventPlan.CLIPS_BY_LENGTH[length] || 4;
  const marked = photos.filter((photo) => params.ai_marks?.[photo.assetId] === 'always').length;
  const count = Math.min(photos.length, Math.max(requested, marked));
  const edge = context.workflow.graph.edges.find((item) => item.from.node === context.nodeId && item.from.port === 'ai_photos');
  const clip = context.workflow.graph.nodes.find((node) => node.id === edge?.to.node);
  let unitUsd = null;
  if (clip) {
    // A list result is billed once for all fresh items; divide by those items, never by cache hits.
    const history = context.workflow.graph.nodes.filter((node) => node.type === clip.type)
      .flatMap((node) => context.results.nodes?.[node.id]?.history || [])
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const entry of history) {
      if (!Number.isFinite(entry.cost?.usd) || !(entry.cost.usd > 0)) continue;
      const values = entry.variants?.[0]?.video;
      const fresh = Number.isInteger(entry.freshItemCount) ? entry.freshItemCount : values?.type === 'list' ? values.items.length : Number(entry.params?.count) || 1;
      if (fresh > 0) { unitUsd = entry.cost.usd / fresh; break; }
    }
    if (unitUsd === null) {
      const def = context.registry.get(clip.type);
      const normalized = context.registry.normalizeParams(def, { ...clip.params, ...context.overrides?.[clip.id] });
      const estimated = def.cost.estimate?.({ ...normalized, count: 1 }, { inputs: {}, connected: new Set(), config: context.config });
      unitUsd = typeof estimated === 'number' ? estimated : estimated?.usd;
    }
  }
  if (!Number.isFinite(unitUsd)) unitUsd = clipUsd();
  return { kind: 'eventAiClips', count, usd: count === 0 ? 0 : unitUsd === null ? null : Math.round(count * unitUsd * 10000) / 10000 };
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

// What the planner gets from the inputs and the params; execute, the stamp and the outputs said before a run (WP55) share it. `musicSeconds` is the
// length of the music (null: not known). Throws for inputs that do not fit, as execute does.
function plannerInput(ctx, inputs, params, musicSeconds) {
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
  return {
    videos,
    photos,
    input: {
      brief,
      style,
      videos: videoInfo,
      photos: photoInfo,
      analysis: textOf(inputs, 'music_analysis'),
      musicSeconds,
      brand: inputs.brand ? textOf(inputs, 'brand') : null,
      options: { ...optionsOf(params), ...markOptions(params, photos) }
    }
  };
}

const knownSeconds = (value) => (Number.isFinite(value?.duration) && value.duration > 0 ? value.duration : null);

// The length of the music before the run (the stamp and the outputs said before it, WP55), as execute finds it: the one the value says, else the file
// probed (once: an asset file does not change; the music of ElevenLabs has no length in its value).
const probedSeconds = new Map();
async function secondsBeforeRun(value) {
  const known = knownSeconds(value);
  if (known !== null || !value || typeof value.assetId !== 'string') return known;
  const key = `${value.sessionId}/${value.assetId}`;
  if (!probedSeconds.has(key)) {
    if (probedSeconds.size >= 200) probedSeconds.clear();
    const probe = ops
      .probeMedia(assets.assetFilePath(value))
      .then((info) => info.duration)
      .catch(() => {
        probedSeconds.delete(key);
        return null;
      });
    probedSeconds.set(key, probe);
  }
  return probedSeconds.get(key);
}

// The answer belongs to the plan inputs, independently of the approver's model and switches.
const answerKey = ({ system, prompt }, inputs, params) => {
  const { ai_choice, model, ...planning } = params;
  return `ans:${sha256Hex(canonicalJson({ system, prompt, inputs, planning }))}`;
};
// the contact sheet shows the sources of the shots: the same sources, the same sheet
const legacyAnswerKey = ({ system, prompt }, model) => `ans:${sha256Hex(canonicalJson({ system, prompt, model }))}`;
const sheetKey = (sources) => sha256Hex(canonicalJson(sources));

// The answers the earlier results of the node keep for `key`, newest first: [{ data, variant }] (data: ai_switches.answer, variant: the whole result).
function keptAnswers(variants, key, legacy = null) {
  const out = [];
  for (const variant of variants || []) {
    const raw = variant && variant.ai_switches && variant.ai_switches.type === 'text' ? variant.ai_switches.value : null;
    if (!raw) continue;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = null;
    }
    if (data && data.version === SWITCHES_VERSION && data.answer && (data.answer.key === key || (legacy && legacy(data.answer) === data.answer.key))) out.push({ data: data.answer, variant });
  }
  return out;
}

// Legacy answers have no input fingerprint. Verify the historical cache key against the actual inputs before accepting one.
function legacyMatcher(history, params, inputs, request) {
  const planning = ({ ai_choice, model, ...rest }) => rest;
  const keys = new Set();
  for (const entry of history || []) {
    if (!entry.params || !entry.cacheKey || canonicalJson(planning(entry.params)) !== canonicalJson(planning(params))) continue;
    if (require('./engine').computeCacheKey({ ...planDefinition, version: planDefinition.version || 1 }, entry.params, inputs, entry.stamp) !== entry.cacheKey) continue;
    for (const variant of entry.variants || []) {
      try {
        const data = JSON.parse(variant.ai_switches?.value).answer;
        if (data && data.key === legacyAnswerKey(request, data.model)) keys.add(data.key);
      } catch (_) { /* not a saved answer */ }
    }
  }
  return (data) => keys.has(data.key) ? data.key : null;
}

// The answers an earlier result keeps for `key` decide which one the switches are applied to: execute and predictPlan take the newest. With more than
// one (a forced run of the planner asked the model again for the same request) the stamp names the newest, so a result made with the same switches
// from an older answer is no cache hit (WP55 review); with one answer, or none, the key alone, so a run that had to ask the model keeps its key.
function answerStamp(history, key) {
  if (!key) return {};
  const ids = [...new Set(keptAnswers((history || []).flatMap((entry) => entry.variants || []), key).map((entry) => entry.data.id))];
  return ids.length > 1 ? { id: ids[0] } : {};
}

// The request and input key of the answer the node would use now, for its stamp (WP55), or null when it cannot be said before the run (the length of the music is not
// known, an input does not fit).
async function requestKeyOf(ctx, inputs, params) {
  try {
    const seconds = await secondsBeforeRun(inputs.music);
    if (seconds === null || seconds === undefined) return null;
    const { input } = plannerInput(ctx, inputs, params, seconds);
    const request = eventPlan.planRequest(input);
    return { key: answerKey(request, inputs, params), request };
  } catch (_) {
    return null;
  }
}

// The price of one AI clip of the switches (the clips of the template: H3 Max turbo, 768P, 5 s), null when not known
function clipUsd() {
  const perSecond = falNodes.PRICES.turbo[CLIP_RESOLUTION];
  return Number.isFinite(perSecond) ? Math.round(perSecond * eventPlan.CLIP_SECONDS * 10000) / 10000 : null;
}

// The outputs of the node from the result of the planner. With the photos animated by AI the hidden output ai_switches holds the switches of the
// approval (every photo of the film: its asset id, the photo, on, what the plan gave it, its mark, locked and why when it is not the mark) and the answer
// they are applied to (WP55).
function planVariant(result, photos, { key, selection }) {
  const variant = {
    shots: textValue(JSON.stringify(result.shots)),
    graphics: textValue(JSON.stringify(result.graphics)),
    board: textValue(result.board),
    ...(selection ? { selection } : {}),
    ai_photos: listValue('image', result.aiPhotos.map((index) => photos[index])),
    ai_prompts: listValue('text', result.aiPrompts.map((prompt) => textValue(prompt))),
    parallax_photos: listValue('image', result.parallaxPhotos.map((index) => photos[index])),
    vo_lines: listValue('text', result.voLines.map((line) => textValue(line)))
  };
  if (result.switches.length && key) {
    const answer = { key, id: sha256Hex(canonicalJson({ key, text: result.kept.text, plain: result.kept.plain })).slice(0, 16), sheet: sheetKey(result.sources), ...result.kept };
    const items = result.switches.map((item) => ({ id: photos[item.photo].assetId, label: item.ref, value: photos[item.photo], on: item.on, auto: item.auto, mark: item.mark, locked: item.locked, ...(item.textWarning ? { textWarning: true } : {}), ...(item.why ? { why: item.why } : {}) }));
    variant.ai_switches = textValue(JSON.stringify({ version: SWITCHES_VERSION, param: 'ai_choice', marks: 'ai_marks', unit: { usd: clipUsd() }, items, answer }));
  }
  return variant;
}

// What the node gives when it runs now, said before it runs (def.cacheStampOutputs, WP55): with switches of the approval and an answer an earlier result
// keeps for the same request, the node runs without a request, so it is free and its outputs are known: the AI clips, the parallax and the cut are
// planned with the switches. The contact sheet is the one of that result when the shots show the same sources, else it is made in the run.
async function predictPlan(raw, params, ctx, nodeResults) {
  if (!raw || typeof raw.answer !== 'string') return null;
  const found = keptAnswers((nodeResults?.history || []).slice(0, 50).flatMap((entry) => entry.variants || []), raw.answer, raw.legacy ? () => raw.legacy : null);
  if (!found.length) return null;
  const inputs = ctx.inputs || {};
  const model = explainerNodes.chooseModel(ctx, params);
  const { photos, input } = plannerInput(ctx, inputs, params, await secondsBeforeRun(inputs.music));
  const result = await eventPlan.runEventPlanner({
    ...input,
    ownMusic: await ownMusicOf(ctx, inputs.music),
    ask: async () => {
      throw new Error('the planner asks no model before the run');
    },
    reuse: async () => found[0].data,
    prices: planPrices(model)
  });
  const sheet = found.find((entry) => entry.data.sheet === sheetKey(result.sources) && entry.variant.selection);
  const outputs = planVariant(result, photos, { key: raw.answer, selection: sheet ? sheet.variant.selection : null });
  return { outputs, unknown: sheet ? [] : ['selection'], free: true };
}

// Said before anything is paid (the analysis and the music run before the plan): the description connected from an input node whose field is empty (named as
// that field, data.node and data.field, so the app view names the field of its form), and less material in the upload nodes than the plan needs together
// (the uploads of input.media_list are counted; other sources are known only when they ran).
const TEXT_INPUT_PARAMS = Object.freeze({ 'input.prompt': 'prompt', 'input.text': 'text' });
const isBlank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
function planValidate(params, connected) {
  const issues = validateVideoDuration(connected?.videos?.sources || []);
  const brief = connected && connected.brief;
  if (brief && brief.connected && brief.sources.length && brief.sources.every((source) => TEXT_INPUT_PARAMS[source.type] && isBlank(source.params[TEXT_INPUT_PARAMS[source.type]]))) {
    const source = brief.sources[0];
    issues.push({
      level: 'error',
      code: ERRORS.EVENTPLAN_BRIEF_EMPTY,
      port: 'brief',
      message: `The description of the event is empty: node ${source.node} delivers no text. Write what the event was (what, when, where, who) into it`,
      data: { node: source.node, field: TEXT_INPUT_PARAMS[source.type] }
    });
  }
  const material = ['videos', 'photos'].map((port) => (connected && connected[port]) || { connected: false, sources: [] });
  const uploads = material.every((port) => port.sources.every((source) => source.type === 'input.media_list'));
  if (uploads && material.some((port) => port.connected)) {
    const count = material.reduce((sum, port) => sum + port.sources.reduce((total, source) => total + (Array.isArray(source.params.assets) ? source.params.assets.length : 0), 0), 0);
    if (count < contract.LIMITS.minUsable) {
      issues.push({
        level: 'error',
        code: ERRORS.EVENTPLAN_NO_MATERIAL,
        message: `${count} clips and photos are uploaded, at least ${contract.LIMITS.minUsable} are needed together`,
        data: { usable: count, needed: contract.LIMITS.minUsable }
      });
    }
  }
  return issues;
}

const planDefinition = {
  type: 'event_video.plan',
  category: 'utility',
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
    'colour and slow motion. With the photos animated by AI, "AI clips" says how many (by the length 2, 4 or 6, up to every photo picked): the model ranks ' +
    'candidates, the code spreads the clips over the acts, and the other photos get the parallax when it is on. Outputs: the shots for the cut, the graphics ' +
    'for the render, the board, a contact sheet of the chosen shots, the photos and prompts for the AI clips, the photos for the depth maps and the lines of ' +
    'the voice. A film of photos only works as well (no soundbites, no sound of the clips). ' +
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
    { id: 'vo_lines', type: 'text[]' },
    // the switches of the approval and the answer they are applied to (WP55): for the app view and the node itself, not connectable
    { id: 'ai_switches', type: 'text', hidden: true }
  ],
  params: [
    MODEL_PARAM,
    { id: 'brief', kind: 'textarea', default: '', inline: true },
    { id: 'photo_motion', kind: 'select', options: ['code', 'ai'], default: 'code', inline: true },
    { id: 'max_ai_photos', kind: 'integer', min: 0, max: contract.MAX_AI_PHOTOS, default: 0, options: AI_CLIP_CHOICES.slice(), showIf: { param: 'photo_motion', equals: 'ai' } },
    // WP55: the marks of the photos (the form of the app) and the switches of the approval, by asset id; empty they leave the key of before
    { id: 'ai_marks', kind: 'marks', options: AI_MARKS.slice(), items: 'photos', default: {}, cacheOmitDefault: true, showIf: { param: 'photo_motion', equals: 'ai' } },
    { id: 'ai_choice', kind: 'marks', options: AI_CHOICES.slice(), items: 'photos', source: 'ai_switches', default: {}, cacheOmitDefault: true, showIf: { param: 'photo_motion', equals: 'ai' } },
    { id: 'parallax', kind: 'boolean', default: true },
    { id: 'voiceover', kind: 'boolean', default: false },
    { id: 'lower_thirds', kind: 'boolean', default: true },
    { id: 'soundbites', kind: 'select', options: ['auto', 'off'], default: 'auto' },
    { id: 'allow_plain', kind: 'boolean', default: false }
  ],
  paid: true,
  // the model of the settings when OpenRouter is missing (chooseModel falls back to it): it is not a parameter, so it is part of the key then. With
  // switches of the approval (WP55) the node reads the answer an earlier result keeps: the key of that answer (and which one, answerStamp) is part of its
  // key, and the outputs follow from it before the run (predictPlan). A cached or forced step 1 keeps its original stamp.
  cacheStamp: async (params, ctx) => {
    const fallback = explainerNodes.fallbackBrainStamp(params, ctx);
    if (!hasChoice(params)) {
      if (ctx.forced) return fallback;
      const stamp = fallback === undefined ? undefined : `st:${sha256Hex(canonicalJson(fallback))}`;
      const cached = require('./engine').computeCacheKey({ ...planDefinition, version: planDefinition.version || 1 }, params, ctx.inputs || {}, stamp);
      if ((ctx.history || []).some((entry) => entry.cacheKey === cached)) return fallback;
    }
    const identity = await requestKeyOf(ctx, ctx.inputs || {}, params);
    if (!identity) return hasChoice(params) ? { answer: null } : fallback;
    // Older WP55 answers used the model in their key. Match their original request with their recorded model.
    const found = keptAnswers((ctx.history || []).flatMap((entry) => entry.variants || []), identity.key, legacyMatcher(ctx.history, params, ctx.inputs || {}, identity.request));
    if (!hasChoice(params) && !found.length) return fallback;
    const legacy = found[0] && found[0].data.key !== identity.key ? found[0].data.key : null;
    return { answer: identity.key, ...(legacy ? { legacy } : {}), ...answerStamp(ctx.history, legacy || identity.key) };
  },
  cacheStampOutputs: (raw, { params, ctx, nodeResults }) => predictPlan(raw, params, ctx, nodeResults),
  cost: { unit: 'usd', estimate: planEstimate, followup: clipFollowup, history: false },
  validate: planValidate,
  available: () => llmAvailable(),
  execute: async (ctx, inputs, params) => {
    // the checks of the inputs before anything else (plannerInput says them again with the length of the music)
    plannerInput(ctx, inputs, params, null);
    if (llmAvailable() !== true) throw eventError(ERRORS.EVENTPLAN_NO_LLM, 'No language model is available: OPENROUTER_API_KEY is not set and ChatGPT is not connected');
    const model = explainerNodes.chooseModel(ctx, params);
    const music = inputs.music;
    let musicSeconds = knownSeconds(music);
    if (musicSeconds === null) {
      try {
        musicSeconds = await probeSeconds(ctx, music);
      } catch (err) {
        if (isFatal(err, ctx)) throw err;
        musicSeconds = null;
      }
    }
    const { photos, videos, input } = plannerInput(ctx, inputs, params, musicSeconds);
    // with switches of the approval the answer an earlier result keeps for the same request is used again (WP55): no request, nothing paid
    let key = null;
    let found = [];
    const result = await eventPlan.runEventPlanner({
      ...input,
      ownMusic: await ownMusicOf(ctx, music),
      ask: (request) => askModel(ctx, { ...params, model }, request),
      reuse: async (request) => {
        key = answerKey(request, inputs, params);
        if (!hasChoice(params) && ctx.forced) return null;
        found = keptAnswers(ctx.earlierVariants ? ctx.earlierVariants() : [], key, legacyMatcher(ctx.history, params, inputs, request));
        return found.length ? found[0].data : null;
      },
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
    // the answer used again with the same sources: the contact sheet of that result
    const same = result.reused ? found.find((entry) => entry.data.sheet === sheetKey(result.sources) && entry.variant.selection) : null;
    const selection = same ? same.variant.selection : await selectionSheet(ctx, { sources: result.sources, videos, photos });
    return {
      variants: [planVariant(result, photos, { key, selection })],
      cost: result.reused ? { usd: 0 } : usdCost(result.costs)
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
  AI_CLIP_CHOICES,
  AI_MARKS,
  AI_CHOICES,
  MUSIC_EXTRA_SECONDS,
  OWN_MUSIC_MIN_SECONDS,
  styleOutputs,
  readStyleInput,
  musicEstimate,
  planEstimate,
  planValidate,
  planPrices,
  optionsOf,
  markOptions,
  answerKey,
  answerStamp,
  keptAnswers,
  planVariant,
  selectionSheet
};
