'use strict';

// The production nodes of the explainer video (WP37b): from the script of "Plan explainer video" to the finished film.
//   explainer.voice   one scene's narration -> the voice (ElevenLabs, with the time of every word), its timing and length (paid per character)
//   explainer.scene   one scene's brief + timing (+ brand, stills, page images) -> a silent video of exactly the length of the voice plus a
//                     pause: Claude writes HyperFrames code, the app checks it, puts in the source line itself, renders it on the render
//                     node, looks at two frames and asks again where it is wrong; after the last try a fixed scene stands in (paid by
//                     tokens)
//   explainer.edit    the scenes, the voices, the timings (+ clips, music, intro, outro) -> the film with sound (brought to -16 LUFS),
//                     captions and subtitles (local, ffmpeg)
// The rules live in lib/explainer-cues.js (times), lib/explainer-scene.js (the scene) and lib/explainer-edit.js (the cut), all pure and
// tested on their own. This module is the adapter to the engine: inputs and parameters, the model, the render node, ffmpeg, costs, logs
// and the codes of the errors. The lists follow the scenes (SPEC §9.6): a node that takes one scene runs once per entry of the lists it
// gets, and an entry depends only on its own inputs (no counter or time of the whole run in a result), so that a later version can keep
// the scenes that did not change.

const fsp = require('fs/promises');
const path = require('path');

const tools = require('../tools');
const access = require('../access');
const brandings = require('../brandings');
const captionsLib = require('../captions-ass');
const captionsFonts = require('../captions-fonts');
const cues = require('../explainer-cues');
const editLib = require('../explainer-edit');
const ffmpeg = require('../ffmpeg');
const elevenlabs = require('../elevenlabs');
const musicEdit = require('../music-video-edit');
const planLib = require('../explainer-plan');
const renderLib = require('../music-video-render');
const rendernode = require('../rendernode');
const sceneLib = require('../explainer-scene');
const store = require('../store');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const generate = require('./nodes-generate');
const jobs = require('./jobs');
const { runOp, noLibassIssue } = require('./nodes-edit');
const explainer = require('./nodes-explainer');
const { textValue, numberValue, canonicalJson, sha256Hex } = require('./types');

const { askModel, usdCost, llmAvailable, MODEL_PARAM } = generate;

const MAX_SCENES = 50;
// What one scene costs before the run (measured on 2026-10-03: writing 0.03 to 0.07 USD, looking at the frames about 0.03, a correction
// 0.07 more; Claude Opus 5.5). The estimate is per scene: the engine multiplies it by the number of scenes.
const SCENE_ESTIMATE_USD = 0.1;
const SCENE_ESTIMATE_NO_CHECK_USD = 0.07;
// A typography scene writes more code than the other scenes (a tween for every word of the voice) and thinks more. Measured in a live test on
// 2026-10-04 with 3 scenes: the node booked 0.8409 USD, 0.28 USD per scene with the look at the frames (the guess before was 0.13). Without the
// look the scene costs the 0.03 USD of the look less (the same difference as for the other scenes).
const TYPOGRAPHY_SCENE_USD = 0.28;
const TYPOGRAPHY_SCENE_NO_CHECK_USD = 0.25;
// A scene may take several tries (each: writing, render of 25 to 40 s, looking), and the render node renders one job at a time: with many
// scenes a scene waits for the ones that were sent before it. The time a node may run is longer than usual.
const SCENE_TIMEOUT_MS = 45 * 60 * 1000;
const EDIT_TIMEOUT_MS = 30 * 60 * 1000;
// A render of a scene takes 25 to 40 s; a job that takes longer than this on its own is stuck. The jobs ahead of it in the queue of the
// render node are added: every scene sends its render soon after the answer of the model, so the scenes stand in a line (measured: one
// scene in about 30 s). The wait of a job is RENDER_WAIT_MS + RENDER_PER_JOB_MS for every job of this server that was sent and is not yet
// done, but never more than RENDER_WAIT_MAX_MS (the node itself ends at SCENE_TIMEOUT_MS).
const RENDER_WAIT_MS = 8 * 60 * 1000;
const RENDER_PER_JOB_MS = 60 * 1000;
const RENDER_WAIT_MAX_MS = SCENE_TIMEOUT_MS - 5 * 60 * 1000;
let rendersInFlight = 0;
const FRAME_TOLERANCE = 2 / cues.FPS;
// A render node that is gone or stuck ends the node: no new try helps, and the fixed scene needs the render node as well.
const RENDER_GONE = /^(Timed out waiting for job|Job .* not found in session|Backing session no longer exists)/;

function videoError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

const textOf = (inputs, id) => (inputs[id] ? String(inputs[id].value ?? '') : '');
const itemsOf = (inputs, id) => (inputs[id] ? (inputs[id].type === 'list' ? inputs[id].items : [inputs[id]]) : []);

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

function elevenLabsAvailable() {
  return elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set';
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

const isAbort = (err, ctx) => Boolean(ctx.signal?.aborted) || jobs.isAbortError(err);
// What ends a scene instead of being tried again: the end of the run, an exhausted budget, a refusal of the account.
const isFatal = (err, ctx) => isAbort(err, ctx) || err?.name === 'BudgetError' || err?.name === 'RoleRestrictedError' || err instanceof access.RoleRestrictedError;

/* ---------- explainer.voice ---------- */

// The price of the voice by the characters of all scenes (known as soon as the narration is: it is a list that the node before made);
// per scene, because the engine multiplies the estimate by the number of scenes.
function voiceEstimate(params, context) {
  if (context?.connected?.has('narration')) {
    const value = context.inputs?.narration;
    if (!value) return null;
    const items = value.type === 'list' ? value.items : [value];
    if (!items.length) return { usd: 0 };
    let total = 0;
    for (const item of items) total += tools.speechEstimateUsd(String(item?.value || ''), params.model_id) || 0;
    return { usd: total / items.length };
  }
  return null;
}

// Four seconds of silence for a scene without narration (the sources card): no call to ElevenLabs, nothing to pay.
async function makeSilence(ctx, seconds) {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const file = path.join(scratch, 'silence.wav');
      await ffmpeg.runProcess(
        binaries.ffmpeg,
        ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100', '-t', String(seconds), '-c:a', 'pcm_s16le', file],
        { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }
      );
      return await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: file, prompt: 'Silence (scene without narration)', cost: 0, duration: seconds });
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

// The measured length of an audio asset in seconds (null where it cannot be measured).
async function measureAudio(ctx, value) {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) return null;
  try {
    const probe = await ops.probeMedia(assets.assetFilePath(value), { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    return probe.audio && probe.duration > 0 ? probe.duration : null;
  } catch (err) {
    if (isAbort(err, ctx)) throw err;
    return null;
  }
}

// Words for a voice whose answer carried no times: the words of the text spread over the length of the audio by their characters.
function evenWords(text, duration) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const total = tokens.reduce((sum, word) => sum + word.length + 1, 0) || 1;
  let at = 0;
  return tokens.map((word) => {
    const start = at;
    at += ((word.length + 1) / total) * duration;
    return { text: word, start: Math.round(start * 1000) / 1000, end: Math.round(Math.max(start, at - 0.05) * 1000) / 1000 };
  });
}

// What the voice of one scene reads from its inputs: the narration (trimmed) and, only for a scene that is spoken and with "use_context"
// switched on, the text before and after it. The execution and the key of the item (itemKeyInputs) both go through here, so a text that
// is not read cannot make a paid voice run again.
function voiceSelection(inputs, params) {
  const text = textOf(inputs, 'narration').trim();
  const readsContext = Boolean(text) && Boolean(params.use_context);
  let around = { previous_text: '', next_text: '' };
  if (readsContext) {
    const parsed = parseJson(textOf(inputs, 'context'));
    if (parsed) around = { previous_text: String(parsed.previous_text || ''), next_text: String(parsed.next_text || '') };
  }
  return { text, around, readsContext };
}

// The inputs of one voice as its key sees them: the text around the scene only where the voice reads it. Where it does, the inputs stay
// as they are (so the keys of the voices that exist are the same as before).
function voiceKeyInputs(_index, inputs, params) {
  if (voiceSelection(inputs, params).readsContext) return inputs;
  const reduced = { ...inputs };
  delete reduced.context;
  return reduced;
}

const voiceDefinition = {
  type: 'explainer.voice',
  category: 'audio',
  provider: 'elevenlabs',
  label: 'Explainer voice (ElevenLabs)',
  keywords: ['explainer', 'voice', 'narration', 'elevenlabs', 'audio', 'scenes'],
  description:
    'Speaks the narration of a scene with ElevenLabs and gives the time of every word, so that the picture of the scene can appear in the beat of the ' +
    'voice. Connect the list "Narration" of "Plan explainer video": the node runs once per scene. The narration around a scene goes along as ' +
    'context (previous text, next text), so each sentence sounds like part of the whole. A scene without narration (the sources card) gets four ' +
    'seconds of silence and costs nothing. The voice is the choice in the node, unless the input "Voice" is connected and not empty (the ' +
    'speaker voice of a branding, say): then that voice speaks. Price: like the speech, by the characters.',
  inputs: [
    { id: 'narration', type: 'text', required: true },
    { id: 'context', type: 'text' },
    { id: 'voice', type: 'text' }
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    { id: 'timing', type: 'text' },
    { id: 'duration', type: 'number' }
  ],
  params: [
    { id: 'voice_id', kind: 'select', optionsSource: 'elevenlabs-voices', default: tools.DEFAULT_ELEVENLABS_VOICE_ID },
    { id: 'model_id', kind: 'select', optionsSource: 'elevenlabs-tts-models', default: tools.DEFAULT_ELEVENLABS_MODEL_ID, noDefaultEntry: true },
    { id: 'use_context', kind: 'boolean', default: true }
  ],
  paid: true,
  // the narration arrives through a connection: its length is known once the plan has run, never from an earlier run
  cost: { unit: 'usd', history: false, estimate: voiceEstimate },
  available: () => {
    const key = elevenLabsAvailable();
    return key === true ? ffmpegAvailable() : key;
  },
  itemKeyInputs: voiceKeyInputs,
  execute: async (ctx, inputs, params) => {
    const { text, around } = voiceSelection(inputs, params);
    if (!text) {
      const silence = await makeSilence(ctx, cues.SILENT_SECONDS);
      ctx.log(`Scene without narration: ${cues.SILENT_SECONDS} s of silence, no voice made`);
      return {
        variants: [{ audio: silence, timing: textValue(JSON.stringify(cues.silentTiming(cues.SILENT_SECONDS))), duration: numberValue(cues.SILENT_SECONDS) }],
        cost: usdCost([0])
      };
    }
    if (ctx.signal?.aborted) throw jobs.abortError();
    const outcome = await tools.executeTool(ctx.toolCtx, 'generate_speech_timed', {
      text,
      voice_id: await generate.chooseSpeechVoice(ctx, inputs, params),
      model_id: String(params.model_id || '').trim() || undefined,
      previous_text: around.previous_text,
      next_text: around.next_text
    });
    if (!outcome?.asset) throw new Error('generate_speech_timed returned no asset');
    if (outcome.contextDropped) ctx.log('ElevenLabs does not take the text around the scene for this model: spoken again without it');
    const audio = await assets.valueFromAsset(ctx.sessionId, outcome.asset.id);
    let words = cues.wordsFromAlignment(outcome.alignment);
    const measured = await measureAudio(ctx, audio);
    const ending = words.length ? words[words.length - 1].end : 0;
    const duration = Math.round((measured || ending || 0) * 1000) / 1000;
    if (!(duration > 0)) throw videoError('EXPLAINER_VOICE_EMPTY', 'ElevenLabs delivered audio without a length');
    if (!words.length) {
      ctx.log('ElevenLabs delivered no times for the characters: the word times are estimated from the text');
      words = evenWords(text, duration);
    }
    const timing = cues.timingOf(words, duration);
    const cost = typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null;
    ctx.log(`Voice: ${words.length} words, ${duration} s${around.previous_text || around.next_text ? ' (with the text around it)' : ''}`);
    return {
      variants: [{ audio, timing: textValue(JSON.stringify(timing)), duration: numberValue(duration) }],
      cost: usdCost([cost])
    };
  }
};

/* ---------- explainer.scene ---------- */

// "850 output tokens, 120 of them thinking" from the usage of a call; '' where the provider reported none.
function usageLine(usage) {
  const output = Number(usage?.completion_tokens);
  if (!Number.isFinite(output) || output < 0) return '';
  const thinking = Number(usage?.completion_tokens_details?.reasoning_tokens);
  return `${output} output tokens${Number.isFinite(thinking) && thinking >= 0 ? `, ${thinking} of them thinking` : ''}`;
}

// The price of one scene (see SCENE_ESTIMATE_USD) for the model that will be used; null where the price of the model is not known.
function sceneEstimate(params, context) {
  const named = String(params.model || '').trim();
  const model = named || explainer.DEFAULT_MODEL;
  const restricted = context?.config?.restrictedBrainModels || [];
  if (!named && restricted.length && !restricted.includes(explainer.DEFAULT_MODEL)) return null;
  const price = planLib.PRICES_PER_MILLION[model];
  if (!price) return null;
  // a typography scene is more code (a tween for every word) and thinks more: its price is known once the plan has run
  const shots = parseJson(textOf(context?.inputs || {}, 'shots'));
  const typography = Boolean(shots && shots.visual_mode === 'typography');
  const checked = params.vision_check !== false;
  const base = typography ? (checked ? TYPOGRAPHY_SCENE_USD : TYPOGRAPHY_SCENE_NO_CHECK_USD) : (checked ? SCENE_ESTIMATE_USD : SCENE_ESTIMATE_NO_CHECK_USD);
  return { usd: Math.round(base * (price[0] / planLib.PRICES_PER_MILLION[explainer.DEFAULT_MODEL][0]) * 10000) / 10000 };
}

// The font files of the brand as { family, ext, buffer, weight }: those the profile names with a file, from the branding of the app.
// Participants and guests have no brandings: no files for them. The rest (more than two, too large) is left out by fontFaces().
async function brandFonts(ctx, brand, log) {
  const wanted = (Array.isArray(brand?.fonts) ? brand.fonts : []).filter((font) => font?.asset?.branding && font.asset.file);
  if (!wanted.length) return [];
  if (access.isRestricted(access.viewerOf({ kubleUser: ctx.user }))) {
    log('Brandings are not available for your account: the system font is used');
    return [];
  }
  const found = [];
  for (const font of wanted) {
    const ext = path.extname(String(font.asset.file)).toLowerCase();
    if (!sceneLib.FONT_MIME[ext]) {
      log(`The font file ${font.asset.file} is not a web font (woff2, woff, ttf or otf): the system font is used for ${font.family}`);
      continue;
    }
    try {
      const id = await brandings.resolveBrandingId(font.asset.branding);
      const buffer = await brandings.readBrandingAsset(id, font.asset.file);
      found.push({ family: font.family, ext, buffer, weight: String(font.weights || '').match(/\d{3}/)?.[0] || '400' });
    } catch (err) {
      log(`The font file ${font.asset.file} could not be read (${String(err.message || err).slice(0, 100)}): the system font is used for ${font.family}`);
    }
  }
  return found;
}

// The default font of the style "typography" (lib/fonts/inter-tight/, SIL Open Font License 1.1): { family, ext, buffer, weight } as the
// font files of a brand are, or null where the file cannot be read (the scene then uses the fonts it has). Read once.
let typographyFontCache = null;
async function typographyDefaultFont() {
  if (!typographyFontCache) {
    const spec = sceneLib.TYPOGRAPHY_FONT;
    const reading = fsp
      .readFile(path.join(__dirname, '..', '..', spec.file))
      .then((buffer) => ({ family: spec.family, ext: spec.ext, buffer, weight: spec.weight }))
      .catch(() => null);
    typographyFontCache = reading;
    // a failed read is not kept: the next scene reads the file again
    reading.then((value) => {
      if (!value && typographyFontCache === reading) typographyFontCache = null;
    });
  }
  return typographyFontCache;
}

// Is the plan of this scene in the style "typography"? The shot list says it (visual_mode); a brief that is used alone says it in its
// "Style:" line.
function isTypography(shots, brief) {
  return (shots && shots.visual_mode === 'typography') || (brief && brief.style === 'typography');
}

// The stamp of a scene (WP38g): the font files of the brand. The profile (the input brand) only names them, the bytes are read from the
// branding of the app when the scene is drawn, so a font file that was replaced under its name must renew the scenes. The stamp is the
// hash of every font file the scene would embed. Nothing to add without font files (or for a participant, who gets the system font). An
// old entry is taken once for the fonts of now (cacheStampAdopts), so a deploy does not make paid scenes run again.
async function sceneCacheStamp(_params, ctx) {
  const stamp = await brandFontStamp(ctx);
  // the style "typography" embeds a font of the app when the brand brings none: a new version of that file renews the scenes
  // the same test as in execute: the shot list, or the "Style:" line of a brief that is used alone
  if (!isTypography(parseJson(textOf(ctx.inputs || {}, 'shots')), sceneLib.parseBrief(textOf(ctx.inputs || {}, 'brief')))) return stamp;
  const font = await typographyDefaultFont();
  return { ...(stamp || {}), typography: { font: font ? sha256Hex(font.buffer) : null } };
}

async function brandFontStamp(ctx) {
  const brand = parseJson(textOf(ctx.inputs || {}, 'brand'));
  const wanted = (Array.isArray(brand?.fonts) ? brand.fonts : []).filter((font) => font?.asset?.branding && font.asset.file && sceneLib.FONT_MIME[path.extname(String(font.asset.file)).toLowerCase()]);
  if (!wanted.length || access.isRestricted(access.viewerOf({ kubleUser: ctx.user }))) return undefined;
  const files = [];
  for (const font of wanted) {
    let hash = null;
    try {
      const id = await brandings.resolveBrandingId(font.asset.branding);
      hash = sha256Hex(await brandings.readBrandingAsset(id, font.asset.file));
    } catch (_) {
      hash = null;
    }
    files.push({ branding: font.asset.branding, file: font.asset.file, hash });
  }
  return { fonts: files };
}

// A frame of a video as a data URL (PNG), made with ffmpeg in a scratch folder.
async function frameDataUrl(ctx, videoFile, at, scratch, name) {
  const binaries = ffmpeg.binaries();
  const file = path.join(scratch, `${name}.png`);
  await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-ss', String(at), '-i', videoFile, '-frames:v', '1', file], { timeoutMs: 60000, signal: ctx.signal });
  return `data:image/png;base64,${(await fsp.readFile(file)).toString('base64')}`;
}

// The part of a page image that holds a figure, cut out as an image asset: the region of the plan with 2 % more on every side, kept on
// the page (lib/explainer-scene.js figureRegion). Returns { value, width, height, caption } or { reason }.
async function cropFigure(ctx, { pages, info, figure }) {
  const placed = sceneLib.pageImageIndex(info, figure);
  if (placed.reason) return { reason: placed.reason };
  const page = pages[placed.index];
  if (!page) return { reason: `the page images hold no image number ${placed.index + 1}` };
  const binaries = ffmpeg.binaries();
  const region = sceneLib.figureRegion(figure.bbox);
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const file = path.join(scratch, 'figure.png');
      await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', assets.assetFilePath(page), '-vf', sceneLib.figureCropFilter(region), '-frames:v', '1', file], { timeoutMs: 60000, signal: ctx.signal });
      const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
      const value = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt: `Figure: page ${figure.page}`, cost: 0 });
      return { value, width: probe.video?.width, height: probe.video?.height, caption: `page ${figure.page} of the document, cut to the figure` };
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

// A plain video in the colour of the background, exactly the length of the scene: stands in for a scene that a generated clip replaces in
// the cut (kind "clip"), so that the lists of the scenes stay whole.
async function placeholderVideo(ctx, { format, duration, tokens }) {
  const { width, height } = sceneLib.formatOf(format);
  const binaries = ffmpeg.binaries();
  const frames = Math.round(duration * cues.FPS);
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const file = path.join(scratch, 'placeholder.mp4');
      const color = tokens.bg.replace('#', '0x');
      await ffmpeg.runProcess(
        binaries.ffmpeg,
        ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=${cues.FPS}`, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file],
        { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }
      );
      return await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: file, prompt: 'Placeholder of a clip scene', cost: 0, duration });
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

// Renders the HTML on the render node and returns the video value (silent). Throws { render: true } for a render that failed because of
// the code (the model is told), every other error ends the scene.
async function renderScene(ctx, { html, label, quality, format, attached, duration, log }) {
  // the end of the run stops the scene here, before a job is sent to the render node (the model answers even after an abort)
  if (ctx.signal?.aborted) throw jobs.abortError();
  const outcome = await tools.executeTool(ctx.toolCtx, 'render_motion_graphics', {
    html: generate.replaceAssetPlaceholders(html, attached),
    label,
    quality,
    format,
    asset_ids: attached.map((value) => value.assetId)
  });
  if (!outcome?.job) throw new Error('The render tool did not start a job');
  const ahead = rendersInFlight;
  rendersInFlight += 1;
  let ids;
  try {
    ids = await ctx.waitForJob(outcome.job, { timeoutMs: Math.min(RENDER_WAIT_MS + ahead * RENDER_PER_JOB_MS, RENDER_WAIT_MAX_MS) });
  } catch (err) {
    if (isFatal(err, ctx) || RENDER_GONE.test(String(err?.message || ''))) throw err;
    const failure = new Error(String(err?.message || err).slice(0, 400));
    failure.render = true;
    throw failure;
  } finally {
    rendersInFlight -= 1;
  }
  const value = await assets.valueFromAsset(ctx.sessionId, ids[0]);
  const binaries = ffmpeg.binaries();
  const probe = await ops.probeMedia(assets.assetFilePath(value), { ffprobePath: binaries.ffprobe, signal: ctx.signal });
  if (!probe.video || !(probe.duration > 0)) {
    const failure = new Error('The render produced no video');
    failure.render = true;
    throw failure;
  }
  if (Math.abs(probe.duration - duration) > FRAME_TOLERANCE) log(`the video is ${Math.round(probe.duration * 1000) / 1000} s long, the plan said ${duration} s: the cut uses the measured length`);
  return { value, probe };
}

// The sound taken out of a video: the video as it is, without an audio track (a scene is silent, the voice comes from the voices).
async function withoutSound(ctx, value, probe) {
  if (!probe.audio) return value;
  const binaries = ffmpeg.binaries();
  return ctx.withLocalSlot(async () => {
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const file = path.join(scratch, 'silent.mp4');
      await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', assets.assetFilePath(value), '-an', '-c:v', 'copy', file], { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal });
      return await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: file, prompt: 'Scene (silent)', cost: 0, duration: probe.duration });
    } finally {
      await assets.removeScratchDir(scratch);
    }
  });
}

// The document numbers (from 0) that the source line of a scene names; a reference without a document is about the first one.
function referencedDocuments(refs) {
  const found = [];
  for (const raw of Array.isArray(refs) ? refs : []) {
    const parsed = planLib.parseRef(raw);
    if (parsed && parsed.kind === 'page') found.push((parsed.doc || 1) - 1);
  }
  return found;
}

// What one scene takes from its inputs (the brief says which scene it is, never the position): the entry of the shot list with the id of
// the brief, the still and the page image that entry names, the documents of the info text that the figure and the source line name,
// the brand. The execution of the scene and the key of the item (itemKeyInputs) both read through here: whatever the scene sees is in
// the key, and what it does not see is not.
function sceneSelection(inputs) {
  const briefText = textOf(inputs, 'brief');
  const brief = sceneLib.parseBrief(briefText);
  const shotsText = textOf(inputs, 'shots');
  const shots = parseJson(shotsText);
  const entry = (shots && Array.isArray(shots.scenes) ? shots.scenes.find((scene) => scene && scene.id === brief.id) : null) || null;
  const info = parseJson(textOf(inputs, 'pages_info'));
  const brand = parseJson(textOf(inputs, 'brand'));
  const kind = (entry && entry.kind) || brief.kind || 'motion';
  const stills = itemsOf(inputs, 'stills');
  const still = kind === 'still' && entry && Number.isInteger(entry.image) ? stills[entry.image] || null : null;
  const pages = itemsOf(inputs, 'pages');
  // a clip scene is a plain stand-in: it takes no figure
  const figure = kind !== 'clip' && entry && entry.figure ? entry.figure : null;
  const placed = figure && pages.length && info ? sceneLib.pageImageIndex(info, figure) : null;
  const page = placed && !placed.reason ? pages[placed.index] || null : null;
  const documents = Array.isArray(info?.documents) ? info.documents : [];
  const named = [...referencedDocuments(entry?.source_refs), ...(figure && Number.isInteger(figure.document) ? [figure.document] : [])].filter((at) => at >= 0);
  return { briefText, brief, shotsText, shots, entry, info, brand, kind, stills, still, pages, figure, placed, page, documents, namedDocuments: named.length ? Math.max(...named) + 1 : 0 };
}

// The inputs of one scene as its key sees them: brief and timing of the scene, the brand and the logo completely, from the shot list the
// entry of the scene and the fields that hold for all scenes, the still of the scene, the page image of its figure, and from the info text
// the documents up to the last one the scene names (a figure counts the documents before it for the number of its page image).
function sceneKeyInputs(_index, inputs) {
  const selected = sceneSelection(inputs);
  const reduced = {};
  for (const id of ['brief', 'timing', 'brand', 'logo']) if (inputs[id] !== undefined) reduced[id] = inputs[id];
  if (inputs.shots !== undefined) {
    const plain = selected.shots && !Array.isArray(selected.shots);
    // a shot list that cannot be read is read by nobody: its text counts as it is, so that nothing is taken for the same
    const body = plain ? { globals: Object.fromEntries(Object.entries(selected.shots).filter(([name]) => name !== 'scenes')), entry: selected.entry } : { raw: selected.shotsText };
    reduced.shots = textValue(canonicalJson(body));
  }
  if (selected.still) reduced.stills = selected.still;
  if (selected.page) reduced.pages = selected.page;
  reduced.pages_info = textValue(
    canonicalJson({
      present: Boolean(selected.info),
      ...(selected.figure ? { pagesConnected: selected.pages.length > 0 } : {}),
      documents: selected.documents.slice(0, selected.namedDocuments)
    })
  );
  return reduced;
}

const sceneDefinition = {
  type: 'explainer.scene',
  category: 'video',
  provider: 'llm',
  label: 'Draw explainer scene',
  keywords: ['explainer', 'scene', 'motion graphics', 'html', 'gsap', 'render', 'hyperframes', 'infographic', 'numbers', 'chart', 'opus', 'video'],
  description:
    'Draws one scene of the explainer video as motion graphics: a language model (Claude Opus 5.5 by default) writes the HyperFrames code from the brief of the scene, ' +
    'text and numbers appear at the moment the voice says their word, the code is checked (nothing may reach outside the page), rendered on the render node and two ' +
    'frames are looked at; where something is wrong the model is asked again, and after the last try a fixed scene (title and bullets) stands in, so a scene never ' +
    'fails because of the model. The small source line at the very bottom is put in by the app, not written by the model, and the lower part of the ' +
    'frame stays free for the captions (not in the style typography: it has no captions, its type uses the frame down to the source line). Connect the lists of "Plan explainer video" (briefs) and "Explainer voice" (timing): the node runs once per ' +
    'scene. The scene is silent and exactly as long as the voice plus 0.4 s, to the frame. Paid by tokens.',
  inputs: [
    { id: 'brief', type: 'text', required: true },
    { id: 'timing', type: 'text', required: true },
    { id: 'brand', type: 'text' },
    { id: 'logo', type: 'image' },
    { id: 'stills', type: 'image', multiple: true },
    { id: 'pages', type: 'image', multiple: true },
    { id: 'shots', type: 'text' },
    { id: 'pages_info', type: 'text' }
  ],
  outputs: [{ id: 'video', type: 'video' }],
  params: [
    MODEL_PARAM,
    { id: 'format', kind: 'select', options: planLib.FORMATS, default: 'landscape' },
    { id: 'quality', kind: 'select', options: ['draft', 'standard', 'high'], default: 'standard' },
    { id: 'vision_check', kind: 'boolean', default: true },
    { id: 'max_retries', kind: 'integer', min: 0, max: 4, default: 2 },
    { id: 'fallback', kind: 'boolean', default: true }
  ],
  paid: true,
  cost: { unit: 'usd', history: false, estimate: sceneEstimate },
  itemKeyInputs: sceneKeyInputs,
  cacheStamp: sceneCacheStamp,
  cacheStampAdopts: true,
  timeoutMs: SCENE_TIMEOUT_MS,
  async: true,
  available: () => {
    if (!rendernode.enabled()) return 'No render node configured';
    const local = ffmpegAvailable();
    return local === true ? llmAvailable() : local;
  },
  execute: async (ctx, inputs, params) => {
    const selected = sceneSelection(inputs);
    const { briefText, brief } = selected;
    const label = brief.id || `scene ${(ctx.itemIndex ?? 0) + 1}`;
    const log = (line) => ctx.log(`${label}: ${line}`);
    const timing = cues.parseTiming(textOf(inputs, 'timing'));
    if (!timing) throw videoError('EXPLAINER_TIMING_INVALID', `${label}: the timing is not the JSON of "Explainer voice"`);
    const { shots, entry } = selected;
    if (shots && brief.id && !entry) log('the shot list has no entry with this id: no still, no figure');
    const planned = (shots && shots.format) || brief.format;
    if (planned && planned !== params.format) {
      throw videoError('EXPLAINER_FORMAT_MISMATCH', `${label}: the plan is ${planned}, this node is set to ${params.format}; set "Format" of both nodes to the same value`, { planned, set: params.format });
    }
    const format = params.format;
    const duration = cues.sceneDuration(timing.duration);
    const { info, brand, kind } = selected;
    // the style "typography" (WP40): its own palette and fonts, the words of the voice with their times, and the rubric of the look
    const style = isTypography(shots, brief) ? 'typography' : '';
    let tokens = style ? sceneLib.typographyTokens(brand) : sceneLib.brandTokens(brand);

    // a scene that a generated clip replaces in the cut: only a plain stand-in, no model, no render
    if (kind === 'clip') {
      log('a clip scene: a plain stand-in of the right length is made, the clip replaces it in the cut');
      return { variants: [{ video: await placeholderVideo(ctx, { format, duration, tokens }) }], cost: usdCost([0]) };
    }

    // the times of the elements
    const elements = entry && Array.isArray(entry.elements) && entry.elements.length ? entry.elements : brief.elements;
    const planned_cues = cues.cuesFor(elements, timing, duration);
    for (const note of planned_cues.notes.slice(0, 4)) log(`cue: ${note}`);
    if (planned_cues.notes.length > 4) log(`cue: ${planned_cues.notes.length - 4} more notes`);

    // the files that go into the scene: the still (background), the figure of a page, the logo
    const attached = [];
    const described = [];
    if (kind === 'still') {
      const { still } = selected;
      if (still) {
        attached.push(still);
        described.push({ kind: 'still', ext: path.extname(still.file).slice(1) });
      } else log('a still scene without a still picture (none arrived for it): drawn without a background');
    }
    if (selected.figure) {
      const { pages } = selected;
      if (!pages.length || !info) log('a figure is planned, but the page images or their info text are not connected: drawn without the figure');
      else {
        const figure = await cropFigure(ctx, { pages, info, figure: selected.figure });
        if (figure.reason) log(`the figure is left out: ${figure.reason}`);
        else {
          attached.push(figure.value);
          described.push({ kind: 'figure', ext: 'png', width: figure.width, height: figure.height, caption: figure.caption });
        }
      }
    }
    const logo = inputs.logo && inputs.logo.type !== 'list' ? inputs.logo : null;
    if (logo && (brief.role === 'hook' || brief.role === 'sources')) {
      attached.push(logo);
      described.push({ kind: 'logo', ext: path.extname(logo.file).slice(1) });
    }
    for (const value of attached) if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);

    const brandFontFiles = await brandFonts(ctx, brand, log);
    let fonts;
    if (style) {
      // only the files of the headline and body families count (a further file of the brand must not take the place of the default font);
      // a family of the brand whose file is embedded stays; whatever has none gets the default font of the style, which is embedded too
      const styleFiles = sceneLib.typographyBrandFiles(tokens, brandFontFiles);
      fonts = sceneLib.fontFaces(styleFiles);
      let typed = sceneLib.typographyFontTokens(tokens, fonts.used);
      if (typed.needsDefault) {
        const defaultFont = await typographyDefaultFont();
        if (defaultFont) fonts = sceneLib.fontFaces([...styleFiles, defaultFont]);
        else log(`font: the default font ${sceneLib.TYPOGRAPHY_FONT.family} could not be read: the system font is used`);
        typed = sceneLib.typographyFontTokens(tokens, fonts.used, { final: true });
      }
      tokens = typed.tokens;
    } else fonts = sceneLib.fontFaces(brandFontFiles);
    for (const line of fonts.skipped) log(`font: ${line}: the system font is used`);
    const source = sceneLib.sourceLine(entry?.source_refs || [], Array.isArray(info?.documents) ? info.documents : []);
    const model = explainer.chooseModel(ctx, params);

    // from here on every look at the result needs a place for the frames
    const costs = [];
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      // what the app puts into the code, for the scene of the model and the fixed one alike: the exact length, the source line (the model
      // is not told its text), the policy first in <head>, the fonts of the brand
      const finish = (html, fixed) => {
        const withDuration = sceneLib.fixDuration(html, duration);
        if (withDuration.changed && !fixed) log(`data-duration was set to ${duration} s`);
        const withSource = sceneLib.withSourceLine(withDuration.html, source, { format, tokens });
        const embedded = sceneLib.embedFontsWithin(sceneLib.withCsp(withSource), fonts.css);
        if (embedded.dropped) log(`font: the document with the fonts would be above ${sceneLib.MAX_HTML_BYTES / 1024 / 1024} MB: the system font is used`);
        return embedded.html;
      };
      const quality = params.quality;
      let lastProblems = [];

      /* the model writes, the app checks, renders and looks; the conversation goes on after a failure */
      const system = sceneLib.writerSystemPrompt({ format, duration, tokens, embeddedFonts: fonts.used, style });
      const prompt = sceneLib.writerUserPrompt({ brief: briefText, duration, cues: planned_cues.cues, assets: described, words: timing.words, style });
      const images = await Promise.all(attached.map((value) => store.assetDataUrl(ctx.sessionId, value.assetId)));
      const tries = 1 + params.max_retries;
      let history = [];
      let verdictText = 'not looked at';
      const maxTokens = sceneLib.MAX_TOKENS;
      // the thinking of the writer: null is the model's own; after an empty answer that ended at the limit of tokens the next tries
      // think less (RETRY_REASONING_EFFORT)
      let reasoningEffort = null;
      // the tries that were made: fewer than `tries` when the try with less thinking ended empty at the limit too (no further try then)
      let made = 0;
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        made = attempt;
        const head = `attempt ${attempt} of ${tries}`;
        let written;
        try {
          written = await askModel(ctx, { ...params, model }, { system, prompt, images, history, maxTokens, ...(reasoningEffort ? { reasoningEffort } : {}) });
        } catch (err) {
          if (isFatal(err, ctx)) throw err;
          // a failed answer can still have been billed (an empty one carries the cost the provider reported): it counts for the node
          if (typeof err?.usd === 'number') costs.push(err.usd);
          // the message of an empty answer carries finish_reason and the tokens
          log(`${head}: the model failed (${String(err.message || err).slice(0, 200)})`);
          lastProblems = [`the model failed: ${String(err.message || err).slice(0, 160)}`];
          // empty because the limit of tokens was reached: the model thought until the end and wrote nothing, and the same try would
          // end the same way
          if (err?.emptyAnswer && err.finishReason === 'length' && attempt < tries) {
            if (!reasoningEffort) {
              reasoningEffort = sceneLib.RETRY_REASONING_EFFORT;
              log(`${head}: the model thought until the limit of ${maxTokens} tokens and wrote nothing: the next try thinks less (effort ${reasoningEffort})`);
            } else {
              // with less thinking too: one more try would end the same way and cost as much again
              log(`${head}: the model thought until the limit again, with less thinking too: no further try`);
              break;
            }
          }
          continue;
        }
        costs.push(written.usd);
        const tokensUsed = usageLine(written.usage);
        if (tokensUsed) log(`${head}: the model used ${tokensUsed}`);
        // the model answers even when the run was stopped meanwhile: no render, no further call
        if (ctx.signal?.aborted) throw jobs.abortError();
        const raw = sceneLib.stripFence(written.text);
        const problems = sceneLib.checkCode(raw, { format, assets: attached.length });
        if (problems.length) {
          log(`${head}: the code was rejected before the render (${problems[0].slice(0, 140)}${problems.length > 1 ? ` and ${problems.length - 1} more` : ''})`);
          lastProblems = problems;
          history = [...history, { role: 'assistant', content: written.text }, { role: 'user', content: sceneLib.retryMessage('code', problems) }];
          continue;
        }
        const html = finish(raw);
        const started = Date.now();
        let rendered;
        try {
          rendered = await renderScene(ctx, { html, label: `Scene ${label}`, quality, format, attached, duration, log });
        } catch (err) {
          if (!err.render) throw err;
          log(`${head}: the render failed (${err.message.slice(0, 140)})`);
          lastProblems = [err.message];
          history = [...history, { role: 'assistant', content: written.text }, { role: 'user', content: sceneLib.retryMessage('render', [err.message]) }];
          continue;
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        if (ctx.signal?.aborted) throw jobs.abortError();
        // the look at two frames
        if (!params.vision_check) {
          log(`${head}: rendered in ${seconds} s, not looked at (the check is off)`);
          return { variants: [{ video: await withoutSound(ctx, rendered.value, rendered.probe) }], cost: usdCost(costs) };
        }
        // the rubric of the style is for scenes with a voice; the closing card of the sources (no words) is looked at as any other scene
        const lookStyle = style && timing.words.length ? style : '';
        const times = sceneLib.checkTimes(duration, planned_cues.cues, { style: lookStyle, words: timing.words });
        let verdict = null;
        try {
          const videoFile = assets.assetFilePath(rendered.value);
          const frames = [await frameDataUrl(ctx, videoFile, times[0], scratch, `a${attempt}-1`), await frameDataUrl(ctx, videoFile, times[1], scratch, `a${attempt}-2`)];
          const looked = await askModel(ctx, { ...params, model }, {
            system: sceneLib.checkSystemPrompt({ style: lookStyle }),
            prompt: sceneLib.checkUserPrompt({ brief: briefText, cues: planned_cues.cues, times, words: timing.words, style: lookStyle }),
            images: frames,
            json: true,
            maxTokens: 1200
          });
          costs.push(looked.usd);
          verdict = sceneLib.readVerdict(looked.text);
          if (!verdict) log(`${head}: the answer of the check could not be read: the scene is taken as it is`);
        } catch (err) {
          if (isFatal(err, ctx)) throw err;
          if (typeof err?.usd === 'number') costs.push(err.usd);
          log(`${head}: the check could not be made (${String(err.message || err).slice(0, 140)}): the scene is taken as it is`);
        }
        if (!verdict || verdict.ok) {
          verdictText = verdict ? `ok${verdict.minor.length ? `, ${verdict.minor.length} minor notes` : ''}` : 'not looked at';
          log(`${head}: rendered in ${seconds} s, check: ${verdictText}; no fixed scene`);
          return { variants: [{ video: await withoutSound(ctx, rendered.value, rendered.probe) }], cost: usdCost(costs) };
        }
        log(`${head}: rendered in ${seconds} s, check: ${verdict.blockers.length} ${verdict.blockers.length === 1 ? 'defect' : 'defects'} (${verdict.blockers[0].slice(0, 140)})`);
        lastProblems = verdict.blockers;
        history = [...history, { role: 'assistant', content: written.text }, { role: 'user', content: sceneLib.retryMessage('look', verdict.blockers) }];
      }

      /* no try gave a scene: the fixed one, or the end */
      if (!params.fallback) {
        throw videoError('EXPLAINER_SCENE_FAILED', `${label}: ${made} ${made === 1 ? 'try' : 'tries'} gave no usable scene (${String(lastProblems[0] || '').slice(0, 200)}) and the fixed scene is switched off`, { scene: label });
      }
      // the style "typography": the words of the voice as a plain kinetic typography (no background picture); without words (the closing
      // card of the sources) and in the other styles the title and the bullets, as ever
      const kinetic = Boolean(style) && timing.words.length > 0;
      const background = !kinetic && attached.length > 0 && described[0].kind === 'still';
      const fixed = sceneLib.fallbackHtml({
        format,
        duration,
        tokens,
        scene: { title: (entry && entry.title) || brief.title, bullets: brief.bullets, numbers: brief.numbers },
        elements,
        cues: planned_cues.cues,
        background,
        style,
        words: timing.words,
        keywords: kinetic ? ((entry?.typography?.keywords?.length ? entry.typography.keywords : sceneLib.briefKeywords(briefText))) : []
      });
      const used = background ? [attached[0]] : [];
      let rendered;
      try {
        rendered = await renderScene(ctx, { html: finish(fixed, true), label: `Scene ${label} (fixed)`, quality, format, attached: used, duration, log });
      } catch (err) {
        if (err.render) throw videoError('EXPLAINER_SCENE_RENDER_FAILED', `${label}: the fixed scene could not be rendered either (${err.message.slice(0, 200)})`, { scene: label });
        throw err;
      }
      log(`the fixed scene stands in after ${made} ${made === 1 ? 'try' : 'tries'} (last problem: ${String(lastProblems[0] || '').slice(0, 140)})`);
      return { variants: [{ video: await withoutSound(ctx, rendered.value, rendered.probe) }], cost: usdCost(costs) };
    } finally {
      await assets.removeScratchDir(scratch);
    }
  }
};

/* ---------- explainer.edit ---------- */

// 'landscape' -> '16:9'
const ASPECT = Object.freeze({ landscape: '16:9', portrait: '9:16' });

async function probeAll(ctx, values) {
  const binaries = ffmpeg.binaries();
  const out = [];
  for (const value of values) out.push(await ops.probeMedia(assets.assetFilePath(value), { ffprobePath: binaries.ffprobe, signal: ctx.signal }));
  return out;
}

// The sound of the film brought to the loudness of other videos (lib/explainer-edit.js: measured, one gain to -16 LUFS, a limiter): returns
// the file the cut uses. A sound that cannot be measured (no sound at all) or a call that fails leaves the sound as it is and the log says
// so; only the end of the run ends the node.
async function levelSound(ctx, { ffmpegPath, input, output }) {
  const run = (args) => ctx.withLocalSlot(() => ffmpeg.runProcess(ffmpegPath, args, { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }));
  try {
    const measured = editLib.readLoudness((await run(editLib.loudnessProbeArgs(input))).stderr);
    const gain = editLib.gainFor(measured);
    if (gain === null) {
      ctx.log('sound: the loudness could not be measured (no sound to measure): left as it is');
      return input;
    }
    await run(editLib.normalizeArgs({ inputFile: input, outputFile: output, gainDb: gain }));
    ctx.log(editLib.levelNote(gain));
    return output;
  } catch (err) {
    if (isAbort(err, ctx)) throw err;
    ctx.log(`sound: the loudness could not be set (${String(err.message || err).slice(0, 160)}): left as it is`);
    return input;
  }
}

const editDefinition = {
  type: 'explainer.edit',
  category: 'edit-video',
  label: 'Cut explainer video',
  keywords: ['explainer', 'cut', 'edit', 'assemble', 'voice', 'music', 'ducking', 'captions', 'subtitles', 'srt', 'crossfade', 'intro', 'outro', 'ffmpeg', 'video'],
  description:
    'Puts the scenes of the explainer video one after the other with the voices at the exact start of their scene, optional music underneath (lowered while ' +
    'the voice speaks), captions burnt in from the word times (never in the style typography: its words are the picture) and a subtitle file. The sound is brought to -16 LUFS (measured, one gain, a limiter ' +
    'against peaks), so the film is as loud as other videos. Generated clips replace the scenes the plan marked as clips (cut off, or ' +
    'slowed down to 0.8 at most, then the last frame is held); a person on camera can open and close the film. All lists come in the order of the scenes and ' +
    'must have the same length. The log tells the real length. Local and free.',
  inputs: [
    { id: 'scenes', type: 'video', required: true, multiple: true, max: MAX_SCENES },
    { id: 'audio', type: 'audio', required: true, multiple: true, max: MAX_SCENES },
    { id: 'timing', type: 'text', required: true, multiple: true, max: MAX_SCENES },
    { id: 'shots', type: 'text', required: true },
    { id: 'clips', type: 'video', multiple: true, max: 2 },
    { id: 'music', type: 'audio' },
    { id: 'intro', type: 'video' },
    { id: 'outro', type: 'video' }
  ],
  outputs: [
    { id: 'video', type: 'video' },
    { id: 'subtitles', type: 'text' },
    { id: 'captions', type: 'text' }
  ],
  params: [
    { id: 'transition', kind: 'select', options: editLib.TRANSITIONS, default: 'crossfade', inline: true },
    { id: 'resolution', kind: 'select', options: musicEdit.RESOLUTIONS, default: '1080p' },
    { id: 'fps', kind: 'select', options: musicEdit.FPS_VALUES.map(String), default: '30' },
    { id: 'captions', kind: 'select', options: ['off', 'lines', 'words'], default: 'lines' },
    { id: 'captions_position', kind: 'select', options: captionsLib.POSITIONS, default: 'bottom', showIf: { param: 'captions', in: ['lines', 'words'] } },
    { id: 'music_level', kind: 'select', options: editLib.MUSIC_LEVEL_NAMES.filter((name) => name !== 'off'), default: 'quiet' },
    { id: 'ducking', kind: 'boolean', default: true },
    { id: 'fade_out', kind: 'number', min: 0, max: 10, default: 1 },
    { id: 'fit', kind: 'select', options: musicEdit.FIT_MODES, default: 'crop' }
  ],
  cost: { unit: 'local' },
  timeoutMs: EDIT_TIMEOUT_MS,
  available: ffmpegAvailable,
  validate: (params) => {
    if (params.captions === 'off') return [];
    return ffmpegAvailable() === true && !ffmpeg.hasFilter('ass') ? [noLibassIssue()] : [];
  },
  execute: async (ctx, inputs, params) => {
    const shots = parseJson(textOf(inputs, 'shots'));
    if (!shots || !Array.isArray(shots.scenes) || !shots.scenes.length) throw videoError('EXPLAINER_SHOTS_INVALID', 'shots: the shot list is empty or not the JSON of "Plan explainer video"');
    const scenes = itemsOf(inputs, 'scenes');
    const voices = itemsOf(inputs, 'audio');
    const timings = itemsOf(inputs, 'timing');
    const counts = { scenes: scenes.length, audio: voices.length, timing: timings.length, shots: shots.scenes.length };
    if (new Set(Object.values(counts)).size > 1) {
      throw videoError('EXPLAINER_EDIT_MISMATCH', `The lists have different lengths (scenes ${counts.scenes}, voices ${counts.audio}, timings ${counts.timing}, plan ${counts.shots}): every scene needs its picture, its voice and its timing`, counts);
    }
    const format = shots.format === 'portrait' ? 'portrait' : 'landscape';
    const clipList = itemsOf(inputs, 'clips');
    const music = inputs.music && inputs.music.type !== 'list' ? inputs.music : null;
    const intro = inputs.intro && inputs.intro.type !== 'list' ? inputs.intro : null;
    const outro = inputs.outro && inputs.outro.type !== 'list' ? inputs.outro : null;
    for (const value of [...scenes, ...voices, ...clipList, music, intro, outro].filter(Boolean)) {
      if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);
    }
    const fps = Number(params.fps);
    const musicInfo = music ? (await ctx.withLocalSlot(() => probeAll(ctx, [music])))[0] : null;
    if (musicInfo && !musicInfo.audio) throw videoError('EXPLAINER_EDIT_NO_AUDIO', 'music: the file has no sound', { scene: 'music' });
    const parsedTimings = timings.map((value, index) => {
      const parsed = parseJson(value.value);
      if (!parsed || !Array.isArray(parsed.words)) throw videoError('EXPLAINER_TIMING_INVALID', `timing ${index + 1}: not the JSON of "Explainer voice"`);
      return parsed;
    });

    // the shots in order: [intro] scenes [outro]; a scene takes the clip the plan names for it
    const shotList = [];
    if (intro) shotList.push({ role: 'intro', value: intro });
    shots.scenes.forEach((scene, index) => {
      const clip = scene.kind === 'clip' && Number.isInteger(scene.clip) ? clipList[scene.clip] : null;
      if (scene.kind === 'clip' && !clip) ctx.log(`Scene ${scene.id}: the plan wants a clip but none arrived: the plain scene stays`);
      shotList.push({ role: clip ? 'clip' : 'scene', value: clip || scenes[index], voice: voices[index], timing: parsedTimings[index], scene });
    });
    if (outro) shotList.push({ role: 'outro', value: outro });
    const files = shotList.map((shot) => assets.assetFilePath(shot.value));

    // the real lengths of the pictures decide the film (the render rounds the scenes up to whole frames)
    const infos = await ctx.withLocalSlot(() => probeAll(ctx, shotList.map((shot) => shot.value)));
    const voiceInfos = await ctx.withLocalSlot(() => probeAll(ctx, voices));
    voiceInfos.forEach((info, index) => {
      if (!info.audio) throw videoError('EXPLAINER_EDIT_NO_AUDIO', `Scene ${shots.scenes[index].id}: the voice file has no sound`, { scene: shots.scenes[index].id });
    });
    shotList.forEach((shot, index) => {
      if (!infos[index].video) throw videoError('EXPLAINER_EDIT_NO_VIDEO', `${shot.role === 'scene' || shot.role === 'clip' ? `Scene ${shot.scene.id}` : shot.role}: the file has no picture`);
    });
    // a clip scene takes the length of the scene it replaces (the stand-in was made with exactly this length); everything else its own
    const durations = shotList.map((shot, index) => (shot.role === 'clip' ? cues.sceneDuration(shot.timing.duration) : infos[index].duration));
    const hardCuts = shotList.map((shot) => shot.role === 'intro' || shot.role === 'outro');
    const hardCutsAround = shotList.map((_shot, index) => hardCuts[index] || (index > 0 && shotList[index - 1].role === 'intro'));
    const timeline = editLib.planTimeline({ durations, hardCuts: hardCutsAround, fps, transition: params.transition });
    const kinds = shotList.map((shot) => (shot.role === 'clip' ? 'clip' : shot.role === 'intro' || shot.role === 'outro' ? 'person' : 'motion'));
    const fits = shotList.map((shot) => (shot.role === 'intro' || shot.role === 'outro' ? 'pad' : shot.role === 'clip' ? params.fit : null));
    // a voice that is longer than its scene would be cut off by the soundtrack: say so, with the scene and the seconds
    const cuts = editLib.voiceCuts(
      shotList.map((shot) => (shot.voice ? { label: `Scene ${shot.scene.id}`, seconds: voiceInfos[voices.indexOf(shot.voice)].duration } : null)),
      timeline
    );
    for (const note of cuts) ctx.log(`Warning: ${note}`);
    const shotsSpec = editLib.shotsOf({ timeline, kinds, aspectRatio: ASPECT[format], hardCuts: hardCutsAround, fits });
    const scenesOnly = shotList.map((shot, index) => (shot.role === 'scene' || shot.role === 'clip' ? timeline.owns[index] : 0)).reduce((sum, frames) => sum + frames, 0) / fps;

    const binaries = ffmpeg.binaries();
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      /* the sound: every voice at the start of its scene, the music underneath */
      const soundtrack = path.join(scratch, 'soundtrack.wav');
      const voiceFiles = shotList.map((shot, index) => {
        if (shot.role === 'intro' || shot.role === 'outro') return { file: infos[index].audio ? files[index] : null, channels: infos[index].audio?.channels };
        return { file: assets.assetFilePath(shot.voice), channels: voiceInfos[voices.indexOf(shot.voice)].audio.channels };
      });
      const level = editLib.MUSIC_LEVELS[params.music_level] || 0;
      const sound = editLib.soundtrackArgs({
        voices: voiceFiles,
        music: music ? { file: assets.assetFilePath(music), level, duck: params.ducking, channels: musicInfo.audio.channels } : null,
        timeline,
        outputFile: soundtrack
      });
      await ctx.withLocalSlot(() => ffmpeg.runProcess(binaries.ffmpeg, sound.argv, { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }));
      // the voices of ElevenLabs come at about -26 LUFS: the film is made as loud as other videos, with a limiter against peaks
      const levelled = await levelSound(ctx, { ffmpegPath: binaries.ffmpeg, input: soundtrack, output: path.join(scratch, 'soundtrack-level.wav') });

      /* the captions: the word times of the scenes in the times of the film */
      const startSeconds = timeline.starts.map((start) => start / fps);
      const sceneShots = shotList.map((shot, index) => (shot.role === 'scene' || shot.role === 'clip' ? index : -1)).filter((index) => index >= 0);
      const merged = editLib.mergeTimings(
        sceneShots.map((index) => shotList[index].timing),
        sceneShots.map((index) => startSeconds[index]),
        timeline.total
      );
      // a typography film has no burnt-in captions: its words are the picture (the SRT file and the word times below still come out)
      const wordsArePicture = isTypography(shots, null);
      const burnCaptions = params.captions !== 'off' && !wordsArePicture;
      const captionsOn = burnCaptions && merged.lines.length > 0;
      if (params.captions !== 'off' && wordsArePicture) ctx.log('Typography film: the words are the picture, so no captions are burnt in (the subtitle file is still made)');
      else if (burnCaptions && !merged.lines.length) ctx.log('No words to show: the film has no captions');
      let built = null;
      const [video] = await runOp(ctx, {
        label: 'Cut explainer video',
        files: [levelled, ...files],
        build: async (probed, { scratch: opScratch }) => {
          let captionsFile = null;
          const editParams = { transition: params.transition, resolution: params.resolution, fps, fit: params.fit, fade_out: params.fade_out };
          if (captionsOn) {
            if (!ffmpeg.hasFilter('ass')) throw videoError('CAPTIONS_NO_LIBASS', noLibassIssue().message);
            const film = musicEdit.geometry({ shots: shotsSpec, params: editParams });
            const script = captionsLib.buildAss({ timing: merged, width: film.width, height: film.height, style: params.captions, position: params.captions_position, offset: 0, duration: film.total });
            if (script.events) {
              captionsFile = path.join(opScratch, 'captions.ass');
              await fsp.writeFile(captionsFile, script.text, 'utf8');
              for (const note of await captionsFonts.captionNotes(script)) ctx.log(note);
            }
          }
          built = musicEdit.buildEditPlan({ shots: shotsSpec, order: shotList.map((_shot, index) => index + 1), infos: probed, params: editParams, captionsFile });
          return built;
        },
        execute: ({ spec, files: inputFiles, outputFiles, ffmpegPath, signal, timeoutMs }) => renderLib.renderPlan(spec, { files: inputFiles, outputFile: outputFiles[0], ffmpegPath, signal, timeoutMs })
      });
      const total = built ? built.seconds : timeline.total;
      ctx.log(
        `${scenes.length} scenes${intro || outro ? ` with ${[intro && 'intro', outro && 'outro'].filter(Boolean).join(' and ')}` : ''}, ${Math.round(total * 10) / 10} s at ${fps} fps, ${built ? `${built.width}x${built.height}` : ''}` +
          `${built && built.mode === 'batched' ? `, cut in ${built.batches.length} batches` : ''}` +
          `${shotList.some((shot) => shot.role === 'clip') ? `, ${shotList.filter((shot) => shot.role === 'clip').length} clips` : ''}` +
          `${music ? `, music ${params.music_level}${params.ducking ? ' (lowered under the voice)' : ''}` : ''}` +
          `${captionsOn ? `, captions (${params.captions})` : ''}`
      );
      const note = editLib.lengthNote(scenesOnly, shots.target_seconds);
      if (note) ctx.log(`Warning: ${note}`);
      else if (shots.target_seconds) ctx.log(`Length of the scenes: ${Math.round(scenesOnly)} s, asked for ${Math.round(shots.target_seconds)} s`);
      return {
        variants: [{ video, subtitles: textValue(editLib.srtOf(merged.lines, total)), captions: textValue(JSON.stringify(merged)) }]
      };
    } finally {
      await assets.removeScratchDir(scratch);
    }
  }
};

const definitions = [voiceDefinition, sceneDefinition, editDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  SCENE_ESTIMATE_USD,
  SCENE_ESTIMATE_NO_CHECK_USD,
  TYPOGRAPHY_SCENE_USD,
  TYPOGRAPHY_SCENE_NO_CHECK_USD,
  RENDER_WAIT_MS,
  RENDER_WAIT_MAX_MS,
  voiceEstimate,
  sceneEstimate,
  evenWords,
  cropFigure,
  voiceSelection,
  sceneSelection
};
