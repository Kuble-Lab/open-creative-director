'use strict';

// The music video with the HUD (WP44), two nodes:
//   music_video.hud_plan    the planner: the film cut on the beats (sung windows for the lip sync, cuts on the beats and hits, at most 50 units), a language model that writes
//                           the picture of every unit and the graphics of every lyric line, the checks with a second try, plain values for the rest, the graphics plan (graphics
//                           v1), the board for the approval and the estimate. The work is done by lib/music-video-hud/plan.js (pure, tested without a network); this is the adapter.
//   music_video.hud_render  draws the graphics layer of the HUD (HUD frame, big words, an explaining
// graphic for every lyric line, glitch on the hits, an end card, the karaoke line when switched on) on the base cut of a music video, in one of two styles: HUD Blue
// (the default) or Kuble (parameter `theme`, lib/music-video-hud/themes.js: the same engine with other colours, faces, sizes and effects).
//   1. the graphics text (the plan, graphics v1) is read and cleaned (lib/music-video-hud/graphics.js: nothing in it can break the picture)
//   2. the brightness of the footage is measured for every cut (the HUD takes dark ink on bright footage), and where the face is under the tags
//      (WP51, lib/music-video-hud/faces.js: a face finder in plain JavaScript on small grey frames, so that a tag points at the mouth, the eyes or
//      the hair it names and follows the face)
//   3. the film is divided into chunks at the cuts, at most 24 s each (lib/music-video-hud/chunks.js)
//   4. every chunk: the base cut is cut to its frames (ffmpeg), the HTML page is built (lib/music-video-hud/composition.js) and the job goes to the
//      render node with the cut as its asset and `fps: 24`; all chunks are sent one after the other, so that every render node has work
//   5. a chunk that fails is drawn once more; a second failure ends the node
//   6. the chunks are joined and finished with ffmpeg (lib/music-video-hud/postpass.js: glitch on the cuts and hits, grain, vignette, BT.709, the
//      song underneath, H.264 CRF 17; Kuble: a prism instead of the RGB glitch, a lighter grain, a stronger vignette and a light bloom), checked with
//      ffprobe, and a contact sheet of 12 frames is made
// The beat effects (WP45, WP49, parameter `effects`: off, subtle, strong, wild; lib/music-video-hud/effects.js) are planned by code from the lyrics, beats,
// hits and loudness of the song, with a palette of its own for every part of the song: glitch, noise, VHS disturbances, time effects (freeze, stutter,
// echo, mirror), zoom, shake, distortion, light and colour, all drawn in the pages of the chunks (4); the post-pass (6) then only adds grain, vignette,
// colour and the encoding. `off` makes the pages and the command of before; `glitch` stays the strength of the glitch.
// The intermediate files (the cut footage, the chunks the render node returned) are removed at the end. Free of charge: the render nodes are ours.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const or = require('../openrouter');
const rendernode = require('../rendernode');
const store = require('../store');
const chunkRenderer = require('../render-chunks');
const explainerPlan = require('../explainer-plan');
const imageModels = require('../image-models');
const planLib = require('../music-video-plan');
const chunksLib = require('../music-video-hud/chunks');
const compositionLib = require('../music-video-hud/composition');
const effectsLib = require('../music-video-hud/effects');
const facesLib = require('../music-video-hud/faces');
const figuresLib = require('../music-video-hud/figures');
const graphicsLib = require('../music-video-hud/graphics');
const hudPlanLib = require('../music-video-hud/plan');
const postLib = require('../music-video-hud/postpass');
const themesLib = require('../music-video-hud/themes');
const assets = require('./assets');
const explainerNodes = require('./nodes-explainer');
const falNodes = require('./nodes-fal');
const generate = require('./nodes-generate');
const jobs = require('./jobs');
const ops = require('./ffmpeg-ops');
const musicVideoNodes = require('./nodes-music-video');
const { textValue, listValue } = require('./types');

const { askModel, usdCost, llmAvailable, MODEL_PARAM } = generate;

const FPS = 24;
const DEFAULT_ACCENT = graphicsLib.DEFAULT_ACCENT;
const AUTO_THEME = 'auto';
// The whole node may take its time: a film of 4 minutes is 12 chunks, and the render nodes work on one chunk each at a time (the wait of a chunk:
// lib/render-chunks.js, at most 10 minutes less than this).
const HUD_TIMEOUT_MS = 75 * 60 * 1000;
const MAX_TRIES = chunkRenderer.MAX_TRIES;
// The codes lib/render-chunks.js throws for the HUD (no render node, a node without large uploads, a chunk that failed twice).
const RENDER_CODES = Object.freeze({ noNode: 'HUD_NO_RENDER_NODE', noUploads: 'HUD_NODE_NO_UPLOADS', failed: 'HUD_RENDER_FAILED' });

function hudError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

const textOf = (inputs, id) => (inputs[id] ? String(inputs[id].value ?? '') : '');
const secondsText = (value) => `${Math.round(value * 10) / 10}`;

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

const isAbort = (err, ctx) => Boolean(ctx.signal?.aborted) || jobs.isAbortError(err);
// What ends the node instead of being tried again: the end of the run, an exhausted budget, a refusal of the account.
const isFatal = (err, ctx) => isAbort(err, ctx) || err?.name === 'BudgetError' || err?.name === 'RoleRestrictedError';

// The graphics text must be the plan: a JSON object with cuts. Single broken parts are left out by normalizeGraphics (with a warning), but a text
// that is no plan at all would draw an empty HUD on a film it knows nothing about.
function readGraphics(text) {
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.cuts) || !raw.cuts.length) {
    throw hudError('HUD_GRAPHICS_INVALID', 'graphics: the text is not the graphics plan (a JSON object with cuts)');
  }
  return raw;
}

/* ---------- the pieces of the run ---------- */

async function runFfmpeg(ctx, args, { timeoutMs = ffmpeg.PROCESS_TIMEOUT_MS } = {}) {
  const { ffmpeg: command } = ffmpeg.binaries();
  return ctx.withLocalSlot(() => ffmpeg.runProcess(command, args, { timeoutMs, signal: ctx.signal }));
}

// How bright every cut is (left and right half): one pass over the base cut, 4 samples a second. The HUD takes dark ink where the footage is bright.
// A failure is no reason to stop: the HUD then keeps its light ink.
async function measureLuma(ctx, { videoFile, scratch, graphics, log }) {
  try {
    const raw = path.join(scratch, 'luma.raw');
    await runFfmpeg(ctx, postLib.lumaArgs({ inputFile: videoFile, outFile: raw }));
    const buffer = await fsp.readFile(raw);
    await fsp.rm(raw, { force: true });
    return postLib.lumaPerCut(buffer, graphics.cuts, graphics.start);
  } catch (err) {
    if (isFatal(err, ctx)) throw err;
    log('the brightness of the footage could not be measured: the HUD keeps its light ink');
    return null;
  }
}

// Where the face is under the tags (WP51): the frames under every tag (every 4th frame, 640 x 360 grey) out of the base cut with ffmpeg, the face
// finder over them in a thread of its own (lib/music-video-hud/faces.js). The track goes into the pages of the chunks with a tag. A film without a
// tag looks at nothing; a failure is no reason to stop: the tags then point where the framing of the cut puts the face.
async function measureFaces(ctx, { videoFile, scratch, graphics, log }) {
  const frames = facesLib.samplesOf(graphics);
  if (!frames.length) return null;
  const raw = path.join(scratch, 'faces.raw');
  try {
    const started = Date.now();
    await runFfmpeg(ctx, facesLib.framesArgs({ inputFile: videoFile, outFile: raw, frames, origin: graphics.start }), { timeoutMs: Math.max(ffmpeg.PROCESS_TIMEOUT_MS, frames.length * 1000) });
    const track = await ctx.withLocalSlot(() => facesLib.trackFile(graphics, raw, frames, { signal: ctx.signal }));
    const tags = graphics.devices.filter((d) => d.type === 'tag').length;
    log(`the face under the ${tags} tags: ${frames.length} frames looked at, a face in ${track.points.length}, ${secondsText((Date.now() - started) / 1000)} s`);
    return track;
  } catch (err) {
    if (isFatal(err, ctx) || err?.name === 'AbortError') throw err;
    log(`the face under the tags could not be found (${String(err?.message || err).slice(0, 120)}): the tags point where the framing puts the face`);
    return null;
  } finally {
    await fsp.rm(raw, { force: true }).catch(() => {});
  }
}

// Does the graphics text hold a tag (WP51)? A cheap look at the plan for the cache stamp; never throws.
function planHasTag(text) {
  try {
    const raw = JSON.parse(text);
    return Boolean(raw && Array.isArray(raw.graphics) && raw.graphics.some((d) => d && String(d.type || '') === 'tag'));
  } catch (_) {
    return false;
  }
}

// The base cut cut to the frames of one chunk, stored as an asset of the session (the render job takes it from there).
async function cutChunk(ctx, { videoFile, scratch, graphics, chunk }) {
  const file = path.join(scratch, `chunk-${chunk.index + 1}.mp4`);
  await runFfmpeg(ctx, postLib.cutClipArgs({ inputFile: videoFile, outFile: file, start: chunk.start - graphics.start, frames: chunk.frames }));
  return ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: file, prompt: `HUD footage ${chunk.index + 1}`, cost: 0, duration: chunk.clipSeconds });
}

// Waits for one chunk, once more with a new job when it failed (lib/render-chunks.js). Returns { value, probe } of the rendered chunk.
function finishChunk(ctx, state, { index, count, temp, log }) {
  return chunkRenderer.finishChunk(ctx, state, { index, count, temp, log, fps: FPS, codes: RENDER_CODES });
}

// The run of all chunks (lib/render-chunks.js): cut, build, send (one after the other), then wait for all of them at the same time.
function renderChunks(ctx, { videoFile, scratch, graphics, chunks, params, endcardOn, temp, log }) {
  return chunkRenderer.renderChunks(ctx, {
    chunks,
    quality: params.quality,
    temp,
    log,
    fps: FPS,
    codes: RENDER_CODES,
    prepare: async (chunk) => {
      const clip = await cutChunk(ctx, { videoFile, scratch, graphics, chunk });
      temp.push(clip.assetId);
      const html = compositionLib.buildChunkHtml({
        graphics,
        chunk,
        clipFile: `${clip.assetId}${path.extname(clip.file)}`,
        options: { karaoke: params.karaoke, endcard: endcardOn, effects: params.effects, glitch: params.glitch }
      });
      return { html, label: `HUD ${chunk.index + 1}/${chunks.length}`, clipId: clip.assetId };
    }
  });
}

// The colour tags of a chunk (color_space, color_range), for the conversion to BT.709 in the post-pass; {} when they cannot be read.
async function colourOf(ctx, file) {
  try {
    const { ffprobe } = ffmpeg.binaries();
    const { stdout } = await ffmpeg.runProcess(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_range', '-of', 'json', file], { timeoutMs: 30000, signal: ctx.signal });
    const stream = (JSON.parse(stdout).streams || [])[0] || {};
    return { color_space: stream.color_space, color_range: stream.color_range };
  } catch (err) {
    if (isFatal(err, ctx)) throw err;
    return {};
  }
}

// The checks of the finished film with ffprobe (tags, size, frame rate, length, sound).
async function probeFilm(ctx, file) {
  const { ffprobe } = ffmpeg.binaries();
  const { stdout } = await ffmpeg.runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 60000, signal: ctx.signal });
  return JSON.parse(stdout);
}

/* ---------- music_video.hud_plan ---------- */

// The image model of the portrait sheet and of every plate (the template of the HUD music video uses it): its list price comes from lib/image-models.js.
const PLATE_IMAGE_MODEL = 'google/gemini-nano-banana-2.1';
// The resolution the lip sync and the clips are bought in (the templates use it): the prices are those of the table of the fal nodes.
const VIDEO_RESOLUTION = '768P';

// The prices the estimate of the planner reads, from the tables of the nodes that spend the money (nothing is copied here): an image of the plate model, the lip sync by the second
// (fal.h3_lipsync), a clip of the video model by the second (H3 turbo), the depth map of a still (fal.depth_map) and the tokens of the language model.
// `sheetReferences` (WP50): how many reference images the portrait sheet gets; each adds its input tokens to the price of the sheet.
function hudPrices(model, sheetReferences = 0) {
  const llm = explainerPlan.PRICES_PER_MILLION[model];
  const image = imageModels.estimateUsd(PLATE_IMAGE_MODEL);
  const perReference = imageModels.referenceUsd(PLATE_IMAGE_MODEL);
  return {
    image,
    ...(sheetReferences > 0 ? { sheet: image === null || perReference === null ? null : image + sheetReferences * perReference } : {}),
    lipsync: (seconds) => falNodes.lipsyncUsd({ resolution: VIDEO_RESOLUTION }, seconds),
    clipPerSecond: falNodes.PRICES.turbo[VIDEO_RESOLUTION],
    depth: falNodes.PRICES.depthMap.usd,
    llm: llm ? { inputPerMillion: llm[0], outputPerMillion: llm[1], charsPerToken: explainerPlan.CHARS_PER_TOKEN } : null
  };
}

// The settings of the grid from the parameters of the node.
const gridOptions = (params) => ({
  cutsPerMinute: params.cuts_per_minute,
  maxUnits: params.max_units,
  lipsyncSecondsPerMinute: params.lipsync_seconds_per_minute,
  motionShare: params.motion_share,
  clipSeconds: params.clip_seconds
});

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
// WP52a: the share of B-roll (a parameter added after plans were saved: missing, it is the default)
const brollShareOf = (params) => (params.broll_share === undefined || params.broll_share === null ? hudPlanLib.DEFAULT_BROLL_SHARE : Number(params.broll_share));

// The price of the node itself, the language model: from the size of the prompt (the grid of the song tells the units and the lines) and the answer that size makes. The film
// costs more (images, lip sync, clips): its estimate is on the board and in the plan of the nodes behind this one. null where the price of the model is not known. With the
// field "Idea" empty and nothing connected (WP48) the call that writes the brief comes first: its prompt by its length, its answer by its usual size, and the plan then reads a
// brief of the usual length.
function hudPlanEstimate(params, context) {
  const named = String(params.model || '').trim();
  const model = named || explainerNodes.DEFAULT_MODEL;
  const restricted = context?.config?.restrictedBrainModels || [];
  // a participant whose list lacks Opus, or an installation without OpenRouter, gets another model whose price is not known here
  if (!named && ((restricted.length && !restricted.includes(explainerNodes.DEFAULT_MODEL)) || !or.hasKey())) return null;
  const price = explainerPlan.PRICES_PER_MILLION[model];
  if (!price) return null;
  const inputs = context?.inputs || {};
  const connected = context?.connected || new Set();
  for (const port of ['analysis', 'timing', 'brief', 'figure']) if (connected.has(port) && !inputs[port]) return null;
  if (!inputs.analysis || !inputs.timing) return null;
  try {
    const grid = hudPlanLib.planGrid(textOf(inputs, 'analysis'), textOf(inputs, 'timing'), gridOptions(params));
    const figure = hudPlanLib.parseFigure(inputs.figure ? textOf(inputs, 'figure') : params.figure);
    const writes = !inputs.brief && !connected.has('brief') && isBlank(params.brief);
    const prompt = hudPlanLib.userPrompt({ brief: inputs.brief ? textOf(inputs, 'brief') : params.brief, style: params.style, figure, grid, broll: hudPlanLib.suggestBroll(grid, brollShareOf(params)) });
    const system = hudPlanLib.systemPrompt({ theme: params.theme, hudLanguage: params.hud_language, needShort: !figure.hasShort, brollShare: brollShareOf(params) });
    const tokens = hudPlanLib.llmTokens(grid, prompt.length + system.length + (writes ? hudPlanLib.BRIEF_TYPICAL_CHARS : 0), explainerPlan.CHARS_PER_TOKEN);
    if (writes) {
      const briefChars =
        hudPlanLib.briefSystemPrompt({ theme: params.theme, hudLanguage: params.hud_language, briefLanguage: params.brief_language }).length + hudPlanLib.briefUserPrompt({ grid, figure }).length;
      const brief = hudPlanLib.briefTokens(briefChars, explainerPlan.CHARS_PER_TOKEN);
      tokens.input += brief.input;
      tokens.output += brief.output;
    }
    return { usd: Math.round(((tokens.input * price[0] + tokens.output * price[1]) / 1e6) * 10000) / 10000 };
  } catch (_) {
    return null;
  }
}

// The idea connected from an input node whose text is empty (the templates with the song by ElevenLabs or Suno: there the idea makes the song as well, so it is
// required): said by the plan before the song is paid, as the empty field of that node (data.node, data.field), so that the app view names the field of its form
// (WP48). An empty field of the planner itself is no issue: the planner then writes the brief from the song.
const TEXT_INPUT_PARAMS = Object.freeze({ 'input.prompt': 'prompt', 'input.text': 'text' });
function hudPlanValidate(_params, connected) {
  const issues = [];
  if (connected?.figure_image?.count > 3) {
    issues.push({ level: 'error', port: 'figure_image', message: 'figure_image: at most 3 images are allowed' });
  }
  const brief = connected && connected.brief;
  if (!brief || !brief.connected || !brief.sources.length) return issues;
  if (!brief.sources.every((source) => TEXT_INPUT_PARAMS[source.type] && isBlank(source.params[TEXT_INPUT_PARAMS[source.type]]))) return issues;
  const source = brief.sources[0];
  return [
    ...issues,
    {
      level: 'error',
      code: 'HUDPLAN_IDEA_EMPTY',
      port: 'brief',
      message: `The idea is empty: node ${source.node} delivers no text. Write the idea of the video into it`,
      data: { node: source.node, field: TEXT_INPUT_PARAMS[source.type] }
    }
  ];
}

// The words of the log about the tokens of a call (OpenRouter: prompt_tokens and completion_tokens; the subscription: input_tokens and output_tokens).
function tokensText(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  return Number.isFinite(input) && Number.isFinite(output) ? `, ${input} tokens in, ${output} out` : '';
}

// WP50: the reference images of the portrait sheet. `official`: the figure of the app the figure text names (Claudia, lib/music-video-hud/figures.js) brings its
// official images; a connected "figure_image" (the person's own figure) wins over them. { kind, figure, own } or null: no reference, the sheet is made from the text
// alone as before.
function sheetReferencesOf(inputs, params, figureText) {
  const own = generate.itemsOf(inputs, 'figure_image');
  if (own.length) return { kind: 'own', count: own.length, own };
  if (params.official_images !== true) return null;
  const figure = figuresLib.figureOf(hudPlanLib.parseFigure(figureText));
  return figure ? { kind: figure.id, count: figure.images.length, figure } : null;
}

// The official images of a figure of the app as assets of the workflow. An image that the workflow already holds (the same file: its hash is in the prompt of the
// asset) is taken again, so a plan that runs again hands the sheet the same assets and the sheet keeps its key; only a missing one is copied in.
async function figureReferenceValues(ctx, figure) {
  const ledger = await store.readLedger(ctx.sessionId);
  const values = [];
  for (const image of figuresLib.referenceFiles(figure.id)) {
    const buffer = await fsp.readFile(image.path);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const prompt = `Official reference image of ${figure.credit}: ${image.id} (${image.url}) [${digest}]`;
    const held = ledger.find((entry) => entry.prompt === prompt && entry.kind === 'image' && !entry.pending);
    if (held) {
      try {
        const value = assets.valueFromLedgerEntry(ctx.sessionId, held);
        await fsp.access(assets.assetFilePath(value));
        values.push(value);
        continue;
      } catch (_) {
        /* the file is gone: copied in again below */
      }
    }
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const temp = path.join(scratch, `reference${path.extname(image.file).toLowerCase()}`);
      await fsp.writeFile(temp, buffer);
      values.push(await assets.saveOutputFile(ctx.sessionId, { kind: 'image', ext: path.extname(image.file).toLowerCase(), sourceFile: temp, prompt, alpha: false }));
    } finally {
      await assets.removeScratchDir(scratch);
    }
  }
  return values;
}

const hudPlanDefinition = {
  type: 'music_video.hud_plan',
  category: 'video',
  provider: 'llm',
  label: 'Plan music video HUD',
  keywords: ['music video', 'hud', 'plan', 'storyboard', 'graphics', 'lip sync', 'beats', 'lyrics', 'song', 'figure', 'board', 'slopcore', 'llm'],
  description:
    'Plans a music video in the HUD style from a song and a figure: the code cuts the film on the beats (sung windows of 5 to 8 s for the lip sync, in a dense song also from a ' +
    'gap between two words and up to 10 s; cuts of 1 to 4 s on beats and hits, at most 50 units), a language model (Claude Opus 5.5 unless you choose another) writes the ' +
    'picture of every unit and one to three graphics for every lyric line; about a third of the units that are not sung (Share of B-roll) show the image of their line ' +
    'without the figure, big and cinematic. The code checks the answer (a second try with the list of problems; an answer that was cut off keeps its complete parts and ' +
    'the second try asks for the rest) and tries the graphics in the layout of the renderer. When the model delivers too little (more than a quarter of the units or lines ' +
    'missing) the node stops with an error instead of a plain plan, unless "Allow a plain plan" is on. Outputs: the shot plan ' +
    'for "Cut to the beat", lists of prompts in unit order (sung, story, still), the song slices for the lip sync, the graphics plan for "Draw music video HUD", the board for the ' +
    'approval, the prompt of the figure sheet and the brief that was used. With the field "Idea" empty the same model first writes a brief from the song (the lyrics with their ' +
    'parts and times, the energy, the tempo, the figure and the look; output "brief"), in the language of "Language of the brief". Lines that the figure does not sing (a choir, ' +
    'marked in the lyrics or heard by "Lyrics timing") get no lip sync and become clips. Price: the language model, about 0.45 USD for a minute of song and 0.65 USD for two (a few ' +
    'cents more for the brief); the whole film (images, lip sync, clips) ' +
    'costs about 6 USD per minute of song at the default settings, where every unit that is not sung is a clip of the video model (about 12 USD for two minutes; the clips ' +
    'and the lip sync are the biggest parts); a lower share of motion makes stills that move by parallax instead (about 3.7 USD per minute at 0.3). The board shows the estimate ' +
    'for your song. At the default settings (50 units) the units cover a song of up to about 3 minutes; for a longer one raise the clip length. With "Official images of the ' +
    'figure" on and the figure Claudia, the output "sheet_refs" holds three official images of claudia.gallery for the figure sheet; pictures on "figure_image" take their place.',
  inputs: [
    { id: 'analysis', type: 'text', required: true },
    { id: 'timing', type: 'text', required: true },
    // WP48: optional. Empty, the planner writes the brief from the song first
    { id: 'brief', type: 'text', param: 'brief' },
    { id: 'figure', type: 'text', required: true, param: 'figure' },
    { id: 'song', type: 'audio', required: true },
    // WP50, optional: pictures of the person's own figure; they go to the portrait sheet as references (and the official images of Claudia do not)
    { id: 'figure_image', type: 'image', multiple: true, max: 3 }
  ],
  outputs: [
    { id: 'shots', type: 'text' },
    { id: 'performance_prompts', type: 'text[]' },
    { id: 'performance_audio', type: 'audio[]' },
    { id: 'story_prompts', type: 'text[]' },
    { id: 'story_motion', type: 'text[]' },
    { id: 'still_prompts', type: 'text[]' },
    { id: 'graphics', type: 'text' },
    { id: 'board', type: 'text' },
    { id: 'sheet_prompt', type: 'text' },
    // WP48: the brief that was used, the one of the field or the one the model wrote
    { id: 'brief', type: 'text' },
    // WP50: the reference images of the portrait sheet (the official images of Claudia, or the pictures of "figure_image"); empty without them
    { id: 'sheet_refs', type: 'image[]' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'brief', kind: 'textarea', default: '', inline: true },
    { id: 'figure', kind: 'textarea', default: '' },
    { id: 'style', kind: 'textarea', default: '' },
    { id: 'theme', kind: 'select', options: themesLib.NAMES.slice(), default: themesLib.DEFAULT, inline: true },
    { id: 'accent', kind: 'color', default: DEFAULT_ACCENT },
    { id: 'hud_language', kind: 'select', options: Object.keys(hudPlanLib.HUD_LANGUAGES), default: 'en' },
    // WP48: the language of a brief the model writes (the templates set the one of the interface). Added after plans were saved: at `en` it is no part of the key
    { id: 'brief_language', kind: 'select', options: Object.keys(hudPlanLib.BRIEF_LANGUAGES), default: 'en', cacheOmitDefault: true },
    // WP50: the official images of the figure for the portrait sheet (output sheet_refs, and the prompt of the sheet says what they fix), for Claudia. The
    // templates switch it on; added after plans were saved: off, it is no part of the key and the sheet prompt is the one of before
    { id: 'official_images', kind: 'boolean', default: false, cacheOmitDefault: true },
    { id: 'cuts_per_minute', kind: 'slider', min: hudPlanLib.RANGES.cutsPerMinute[0], max: hudPlanLib.RANGES.cutsPerMinute[1], step: 1, default: hudPlanLib.DEFAULTS.cutsPerMinute },
    { id: 'max_units', kind: 'integer', min: hudPlanLib.RANGES.maxUnits[0], max: hudPlanLib.RANGES.maxUnits[1], default: hudPlanLib.DEFAULTS.maxUnits },
    { id: 'lipsync_seconds_per_minute', kind: 'slider', min: hudPlanLib.RANGES.lipsyncSecondsPerMinute[0], max: hudPlanLib.RANGES.lipsyncSecondsPerMinute[1], step: 1, default: hudPlanLib.DEFAULTS.lipsyncSecondsPerMinute },
    { id: 'motion_share', kind: 'slider', min: hudPlanLib.RANGES.motionShare[0], max: hudPlanLib.RANGES.motionShare[1], step: 0.05, default: hudPlanLib.DEFAULTS.motionShare },
    { id: 'clip_seconds', kind: 'integer', min: hudPlanLib.RANGES.clipSeconds[0], max: hudPlanLib.RANGES.clipSeconds[1], default: hudPlanLib.DEFAULTS.clipSeconds },
    // WP52a: the share of the units that are not sung that show the image of their line without the figure (B-roll). Added after plans were saved: at the
    // default it is no part of the key (a saved plan keeps its result; a plan made again gets the B-roll)
    { id: 'broll_share', kind: 'slider', min: hudPlanLib.BROLL_SHARE_RANGE[0], max: hudPlanLib.BROLL_SHARE_RANGE[1], step: 0.05, default: hudPlanLib.DEFAULT_BROLL_SHARE, cacheOmitDefault: true },
    // WP52a: off, a plan for which the language model delivered too little ends with HUDPLAN_MODEL_FAILED instead of a silent plain plan; on, the rest is made plainly
    // (as before). Added after plans were saved: off, it is no part of the key
    { id: 'allow_plain', kind: 'boolean', default: false, cacheOmitDefault: true }
  ],
  paid: true,
  // the model of the settings when OpenRouter is missing (chooseModel falls back to it): it is not a parameter, so it is part of the key then
  cacheStamp: async (params, ctx) => explainerNodes.fallbackBrainStamp(params, ctx),
  cacheStampAdopts: true,
  // history: false: a price from an earlier run says nothing about the next song
  cost: { unit: 'usd', estimate: hudPlanEstimate, history: false },
  validate: hudPlanValidate,
  available: () => {
    const reason = ffmpegAvailable();
    return reason === true ? llmAvailable() : reason;
  },
  execute: async (ctx, inputs, params) => {
    // the idea: the field or what is connected; an empty field lets the model write the brief from the song (WP48), a connection that brings no text is a mistake
    const brief = textOf(inputs, 'brief').trim();
    if (inputs.brief !== undefined && !brief) throw hudError('HUDPLAN_NO_BRIEF', 'brief: the connected text is empty; describe the idea or the story of the video');
    const figureText = textOf(inputs, 'figure').trim();
    if (!figureText) throw hudError('HUDPLAN_NO_FIGURE', 'figure: describe the singer (an identity text, or the lines NAME:, FULL:, SHORT: and CREDIT:)');
    const model = explainerNodes.chooseModel(ctx, params);
    const references = sheetReferencesOf(inputs, params, figureText);
    // the pictures of the person's figure must be assets of this workflow (checked before the language model is paid)
    const own = references && references.kind === 'own' ? references.own : [];
    if (own.length > 3) throw new Error('figure_image: at most 3 images are allowed');
    for (const value of own) {
      if (value.sessionId !== ctx.sessionId) throw new Error(`figure_image: asset ${value.assetId} belongs to another workflow`);
      try {
        const stored = await assets.valueFromAsset(ctx.sessionId, value.assetId);
        if (stored.type !== 'image' || !['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(stored.file).toLowerCase())) {
          throw new Error(`asset ${value.assetId} must be a PNG, JPEG or WebP image`);
        }
        await fsp.access(assets.assetFilePath(stored));
      } catch (err) {
        throw new Error(`figure_image: ${err.message}`);
      }
    }
    const result = await hudPlanLib.runPlanner({
      analysis: textOf(inputs, 'analysis'),
      timing: textOf(inputs, 'timing'),
      brief,
      figureText,
      style: params.style,
      theme: params.theme,
      accent: params.accent,
      hudLanguage: params.hud_language,
      briefLanguage: params.brief_language,
      options: gridOptions(params),
      ask: (request) => askModel(ctx, { ...params, model }, request),
      log: (line) => ctx.log(line),
      fatal: (err) => isFatal(err, ctx),
      prices: hudPrices(model, references ? references.count : 0),
      sheetReferences: references ? { kind: references.kind, count: references.count } : null,
      // WP52a: a plain plan only when the person allows it (else HUDPLAN_MODEL_FAILED), and the share of the pictures without the figure
      allowPlain: params.allow_plain === true,
      brollShare: brollShareOf(params)
    });
    const { plan, grid, fallbacks } = result;
    if (result.briefInfo) {
      const info = result.briefInfo;
      ctx.log(`The brief (output "brief"): ${info.model || model}${info.usd === null ? '' : `, ${info.usd.toFixed(4)} USD`}${tokensText(info.usage)}; copy it into the field "Idea" to change it.`);
    }
    for (const record of result.tries) {
      ctx.log(`Language model, try ${record.attempt}${record.rest ? ' (the rest of a cut answer)' : ''}: effort ${record.effort}, ${record.completion === null ? 'tokens not reported' : `${record.completion} tokens out${record.reasoning === null ? '' : ` (${record.reasoning} thinking)`}`}, ${record.finish}${typeof record.usd === 'number' ? `, ${record.usd.toFixed(4)} USD` : ''}.`);
    }
    const plain = fallbacks.units.length;
    if (plain) ctx.log(`${plain} of ${grid.units.length} units got plain prompts: the language model did not deliver them.`);
    const brollCount = grid.units.filter((unit) => !result.content.units[unit.index].withFigure).length;
    if (brollCount) ctx.log(`${brollCount} units show the image of their line without the figure (B-roll).`);
    if (fallbacks.lines.length) ctx.log(`${fallbacks.lines.length} of ${grid.lines.length} lines got plain graphics (a counter for a number in the line, else a tag).`);
    if (result.leftOut.length) ctx.log(`${result.leftOut.length} graphics find no place beside the face and are not drawn (listed on the board).`);
    for (const note of result.notes.slice(0, 3)) ctx.log(`corrected: ${note}`);
    const slices = await musicVideoNodes.sliceSong(ctx, inputs.song, plan.performance);
    const stats = grid.stats;
    ctx.log(
      `${stats.units} units (${stats.sung} sung, ${stats.story} story, ${stats.still} still), ${stats.cuts} cuts (${stats.cutsPerMinute}/min), ${Math.round(grid.duration)} s, ` +
        `${plan.graphics.graphics.length} graphics for ${grid.lines.length} lines, ${result.attempts} ${result.attempts === 1 ? 'answer' : 'answers'} of the model` +
        `${result.cost.total === null ? '' : `, the film costs about ${result.cost.total.toFixed(2)} USD`}`
    );
    const texts = (list, field) => listValue('text', list.map((shot) => textValue(shot[field])));
    let sheetRefs = null;
    if (references) {
      sheetRefs = references.kind === 'own' ? references.own : await figureReferenceValues(ctx, references.figure);
      ctx.log(
        references.kind === 'own'
          ? `The portrait sheet gets ${sheetRefs.length} picture${sheetRefs.length === 1 ? '' : 's'} of the figure as reference (output "sheet_refs").`
          : `The portrait sheet gets ${sheetRefs.length} official reference images of ${references.figure.credit} (output "sheet_refs").`
      );
    }
    return {
      variants: [
        {
          shots: textValue(JSON.stringify(plan.shots)),
          performance_prompts: texts(plan.performance, 'prompt'),
          performance_audio: listValue('audio', slices),
          story_prompts: texts(plan.story, 'prompt'),
          story_motion: texts(plan.story, 'motion'),
          still_prompts: texts(plan.still, 'prompt'),
          graphics: textValue(JSON.stringify(plan.graphics)),
          board: textValue(result.board),
          sheet_prompt: textValue(result.sheetPrompt),
          brief: textValue(result.brief),
          ...(sheetRefs ? { sheet_refs: listValue('image', sheetRefs) } : {})
        }
      ],
      cost: usdCost(result.costs)
    };
  }
};

/* ---------- music_video.hud_render ---------- */

const hudRenderDefinition = {
  type: 'music_video.hud_render',
  category: 'edit-video',
  label: 'Draw music video HUD',
  keywords: ['hud', 'music video', 'graphics', 'overlay', 'karaoke', 'glitch', 'film grain', 'end card', 'slopcore', 'render', 'hyperframes', 'video', 'ffmpeg'],
  description:
    'Draws the graphics layer of the HUD on the base cut of a music video, in the style HUD Blue or Kuble (by default the style the plan names, HUD Blue where it names none): the HUD frame, big words, ' +
    'one explaining graphic for every lyric line, glitch on the hits and an end card; a karaoke line with the current word in the accent colour is off ' +
    'by default and can be switched on. Effects (strong by default, subtle, wild or off) put glitch, noise, VHS disturbances, freeze, stutter, echo, ' +
    'mirror, zoom, shake, distortion, light and colour on the beat, with a palette of its own for every part of the song that does not repeat itself: ' +
    'dense in the chorus and the drop, calmer in the verse, never on the face while it sings nor on the end card; Glitch sets how hard the glitch hits. ' +
    'The film is drawn in pieces of at most 24 s on the render nodes (all pieces at the same time, a piece that fails once more); film grain, ' +
    'a light vignette, BT.709 and the song (AAC 256k) are added on this machine with ffmpeg (H.264, CRF 17, 1920x1080, 24 fps). The style Kuble ' +
    'adds a prism glitch and a bloom but has a lighter grain, so it finishes a little faster. Connect the base cut without captions, the song and the graphics plan ' +
    '(JSON text). The second output is a contact sheet of 12 frames for the check. Free of charge. Time, measured on a laptop with one render node: ' +
    'the render takes 0.8 s (draft), 1.1 s (standard) or 1.7 s (high) per second of film, cutting, joining and encoding about 1 s per second of film more; ' +
    'a second render node halves the render part.',
  inputs: [
    { id: 'video', type: 'video', required: true },
    { id: 'audio', type: 'audio', required: true },
    { id: 'graphics', type: 'text', required: true }
  ],
  outputs: [
    { id: 'video', type: 'video' },
    { id: 'sheet', type: 'image' }
  ],
  params: [
    // `auto`: the style of the plan (hud_plan writes it), HUD Blue where the plan has none; the other two force a style
    { id: 'theme', kind: 'select', options: [AUTO_THEME, ...themesLib.NAMES], default: AUTO_THEME, inline: true },
    { id: 'accent', kind: 'color', default: DEFAULT_ACCENT, inline: true },
    { id: 'karaoke', kind: 'boolean', default: false },
    // WP45, WP49: how much happens on the beat (effects.js); the slider `glitch` stays the strength of the glitch
    { id: 'effects', kind: 'select', options: effectsLib.LEVELS.slice(), default: effectsLib.DEFAULT_LEVEL },
    { id: 'grain', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.35 },
    { id: 'glitch', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.6 },
    { id: 'endcard', kind: 'boolean', default: true },
    { id: 'quality', kind: 'select', options: ['draft', 'standard', 'high'], default: 'standard' }
  ],
  cost: { unit: 'local' },
  timeoutMs: HUD_TIMEOUT_MS,
  async: true,
  available: () => {
    if (!rendernode.enabled()) return 'No render node configured';
    return ffmpegAvailable();
  },
  // The effects of WP49 draw another film than those of WP45 for the same parameters: a film with the effects on gets a stamp, so a film drawn
  // before is drawn once more (free and local; no cacheStampAdopts, the old entry is not taken). With the effects off the pages and the command
  // are the ones of before, so there is no stamp and the key stays as it was.
  // WP51: a film with a tag draws its tags pointing at the face it found (the pages of its chunks with a tag change): it gets `tags` in its stamp and
  // is drawn once more, free as well. A film without a tag keeps its key.
  cacheStamp: (params, context) => {
    const stamp = {};
    if (effectsLib.normalizeLevel(params.effects) !== 'off') stamp.effects = 'wp49';
    if (planHasTag(textOf(context?.inputs || {}, 'graphics'))) stamp.tags = 'wp51';
    return Object.keys(stamp).length ? stamp : undefined;
  },
  execute: async (ctx, inputs, params) => {
    const log = (line) => ctx.log(line);
    const started = Date.now();
    const binaries = ffmpeg.binaries();
    const videoFile = assets.assetFilePath(inputs.video);
    const audioFile = assets.assetFilePath(inputs.audio);

    // 1. the plan
    // the style: the parameter wins over the field `theme` of the plan (as the accent colour does)
    const { graphics: normalized, warnings } = graphicsLib.normalizeGraphics(readGraphics(textOf(inputs, 'graphics')), { theme: params.theme });
    for (const warning of warnings.slice(0, 3)) log(`graphics: ${warning}`);
    if (warnings.length > 3) log(`graphics: ${warnings.length - 3} more notes`);
    const endcardOn = Boolean(params.endcard && normalized.endcard);
    if (params.endcard && !normalized.endcard) log('the plan has no end card: the film ends with the last cut');
    const endcardSeconds = endcardOn ? normalized.endcard.seconds : 0;
    const filmSeconds = normalized.endFrame / FPS - normalized.start;

    // the inputs: the base cut must be as long as the film (a little short is held on its last frame), the song needs sound
    const video = await ops.probeMedia(videoFile, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!video.video) throw hudError('HUD_VIDEO_INVALID', 'video: the file has no picture');
    if (!(video.duration >= filmSeconds - 2)) {
      throw hudError('HUD_VIDEO_TOO_SHORT', `video: ${secondsText(video.duration || 0)} s, the plan needs ${secondsText(filmSeconds)} s`, { have: secondsText(video.duration || 0), need: secondsText(filmSeconds) });
    }
    const song = await ops.probeMedia(audioFile, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!song.audio) throw hudError('HUD_AUDIO_INVALID', 'audio: the file has no sound');
    if (song.duration && song.duration < normalized.endFrame / FPS - 1) log(`the song is ${secondsText(song.duration)} s long, the plan ends at ${secondsText(normalized.endFrame / FPS)} s: the end is silent`);

    const scratch = await assets.createScratchDir(ctx.sessionId);
    const temp = [];
    try {
      // 2. the brightness of the footage, then everything the layout derives
      const luma = await measureLuma(ctx, { videoFile, scratch, graphics: normalized, log });
      const accent = graphicsLib.accentFor(normalized.theme, params.accent, normalized.accent);
      const cuts = normalized.cuts.map((cut, index) => (luma && luma[index] ? { ...cut, luma: luma[index] } : cut));
      // the layout puts no graphic on another or on the face; one that finds no place at all is left out and named here
      const notes = [];
      const graphics = graphicsLib.resolveGraphics({ ...normalized, accent, cuts, endcard: endcardOn ? normalized.endcard : null }, { karaoke: params.karaoke, warn: (message) => notes.push(message) });
      for (const note of notes.slice(0, 3)) log(`graphics: ${note}`);
      if (notes.length > 3) log(`graphics: ${notes.length - 3} more notes`);
      // the face under the tags (WP51): the pages of the chunks with a tag read it
      const faces = await measureFaces(ctx, { videoFile, scratch, graphics, log });
      if (faces) graphics.faces = faces;
      const chunks = chunksLib.planChunks(graphics, { endcardSeconds });
      log(`${secondsText(filmSeconds)} s of film${endcardOn ? ` and ${secondsText(endcardSeconds)} s of end card` : ''}, ${graphics.devices.length} graphics, ${chunks.length} chunks, style ${themesLib.resolve(graphics.theme)}, quality ${params.quality}, effects ${effectsLib.normalizeLevel(params.effects)}`);

      // 3. the chunks on the render nodes
      const drawn = Date.now();
      const rendered = await renderChunks(ctx, { videoFile, scratch, graphics, chunks, params, endcardOn, temp, log });
      const renderSeconds = (Date.now() - drawn) / 1000;

      // 4. joined and finished
      const finished = Date.now();
      const listFile = path.join(scratch, 'chunks.txt');
      await fsp.writeFile(listFile, postLib.concatListText(rendered.map((item) => assets.assetFilePath(item.value))), 'utf8');
      const outFile = path.join(scratch, 'film.mp4');
      // the render nodes tag what they draw as BT.709; anything else is converted
      const inputColor = await colourOf(ctx, assets.assetFilePath(rendered[0].value));
      const colour = postLib.inputColour(inputColor);
      if (colour.matrix !== 'bt709' || colour.range !== 'tv') log(`the chunks are tagged ${colour.matrix}, ${colour.range}: converted to BT.709`);
      const built = postLib.buildPostArgs({ listFile, songFile: audioFile, outFile, graphics, params: { grain: params.grain, glitch: params.glitch, effects: params.effects }, endcardSeconds, inputColor });
      await runFfmpeg(ctx, built.args, { timeoutMs: Math.max(ffmpeg.PROCESS_TIMEOUT_MS, Math.ceil(built.seconds * 4) * 1000 + 120000) });
      const problems = postLib.verifyOutput(await probeFilm(ctx, outFile), { frames: built.frames, seconds: built.seconds });
      if (problems.length) throw hudError('HUD_OUTPUT_CHECK', `the finished film is not right: ${problems.join('; ')}`, { problems: problems.join('; ') });

      // 5. the contact sheet, then the files
      const sheet = postLib.contactSheetArgs({ inputFile: outFile, outFile: path.join(scratch, 'sheet.png'), frames: built.frames });
      try {
        await runFfmpeg(ctx, sheet.args);
      } catch (err) {
        if (isFatal(err, ctx)) throw err;
        throw hudError('HUD_OUTPUT_CHECK', `the contact sheet could not be made from the film: ${String(err?.message || err).slice(0, 200)}`, { problems: 'the contact sheet could not be made from the film' });
      }
      const filmValue = await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: outFile, prompt: 'Music video with HUD', cost: 0, duration: built.seconds });
      const sheetValue = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: path.join(scratch, 'sheet.png'), prompt: 'Contact sheet of the music video with HUD', cost: 0 });
      const plan = compositionLib.effectsPlan(graphics, effectsLib.normalizeLevel(params.effects), params.glitch);
      const moments = plan ? `${effectsLib.accentsOf(plan).length} effects on the beat in ${plan.parts.length} parts of the song` : `${built.windows.length} glitch moments`;
      log(
        `${built.frames} frames, ${secondsText(built.seconds)} s; ${moments}; ` +
          `render ${secondsText(renderSeconds)} s, finishing ${secondsText((Date.now() - finished) / 1000)} s, all ${secondsText((Date.now() - started) / 1000)} s`
      );
      return { variants: [{ video: filmValue, sheet: sheetValue }] };
    } finally {
      await assets.removeScratchDir(scratch).catch(() => {});
      // the cut footage and the chunks of the render nodes are of no use any more (a chunk that is still being drawn is not touched)
      if (temp.length) await store.removeAssets(ctx.sessionId, temp).catch(() => {});
    }
  }
};

const definitions = [hudPlanDefinition, hudRenderDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  readGraphics,
  renderChunks,
  finishChunk,
  measureFaces,
  planHasTag,
  MAX_TRIES,
  HUD_TIMEOUT_MS,
  AUTO_THEME,
  PLATE_IMAGE_MODEL,
  hudPrices,
  hudPlanEstimate,
  hudPlanValidate,
  sheetReferencesOf,
  figureReferenceValues
};
