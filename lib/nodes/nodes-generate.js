'use strict';

// Generative node types (SPEC §5.3 LLM, §5.4 image, §5.5 video, §5.6 audio, §5.8 experimental Higgsfield edits,
// phase 2c: Higgsfield dubbing, voice change, motion control and speech).
// Every executor is a thin adapter over an existing function: tools.executeTool (lib/tools.js), the LLM adapter
// (lib/nodes/llm.js) or the Higgsfield catalogue. Assets are ordinary ledger assets of the workflow's backing
// session; costs are journaled by the underlying tools and only reported back to the engine.

const path = require('path');

const tools = require('../tools');
const videoModels = require('../video-models');
const imageModels = require('../image-models');
const videoNodeModels = require('../video-node-models');
const motionHtml = require('../../public/nodes/motion-html');
const musicPlan = require('../../public/nodes/music-plan');
const store = require('../store');
const access = require('../access');
const or = require('../openrouter');
const chatgpt = require('../chatgpt');
const elevenlabs = require('../elevenlabs');
const higgsfield = require('../higgsfield');
const rendernode = require('../rendernode');
const ffmpeg = require('../ffmpeg');
const poller = require('../poller');
const assets = require('./assets');
const jobs = require('./jobs');
const llm = require('./llm');
const higgsfieldCatalog = require('./higgsfield-catalog');
const { textValue } = require('./types');

const MAX_LLM_IMAGES = 8;
const MAX_EDIT_IMAGES = 8;
const MAX_SEEDANCE_REFS = 30;
const MAX_SEEDANCE_MEDIA_REFS = 10;
const MAX_HIGGSFIELD_REFS = higgsfieldCatalog.MAX_REFS;
const MAX_MOTION_ASSETS = tools.MAX_RENDER_ASSETS;
const MIN_CONCAT_CLIPS = 2;
const MAX_CONCAT_CLIPS = tools.MAX_CONCAT_ASSETS;
const TTS_MAX_CHARS = 2500;
const MUSIC_MIN_SECONDS = musicPlan.LIMITS.minLengthMs / 1000;
const MUSIC_MAX_SECONDS = musicPlan.LIMITS.maxLengthMs / 1000;
const REFRAME_LONG_VIDEO_SECONDS = 15;
const REFRAME_MAX_SECONDS = 60;

/* ---------- shared helpers ---------- */

function publicBaseUrlSet() {
  return Boolean(String(process.env.PUBLIC_BASE_URL || '').trim());
}

function openRouterAvailable() {
  return or.hasKey() ? true : 'OPENROUTER_API_KEY is not set';
}

function llmAvailable() {
  return or.hasKey() || chatgpt.status().connected ? true : 'OPENROUTER_API_KEY is not set and ChatGPT is not connected';
}

function higgsfieldAvailable() {
  return higgsfield.status().connected ? true : 'Higgsfield is not connected';
}

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

// Items of an input: multiple ports deliver a list value, scalar ports a single value (or nothing).
function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

// The tools resolve asset ids inside ctx.sessionId; values of other sessions cannot be used.
function sessionAssetIds(ctx, values) {
  return values.map((value) => {
    if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);
    return value.assetId;
  });
}

function requireMedia(values, label) {
  for (const value of values) {
    if (!['image', 'video', 'audio'].includes(value?.type)) throw new Error(`${label}: only image, video and audio assets are allowed`);
  }
}

function limitCheck(items, max, label) {
  if (items.length > max) throw new Error(`${label}: at most ${max} are allowed (got ${items.length})`);
}

// { usd } for the numbers that are known, else undefined ("unknown" for the plan).
function usdCost(numbers) {
  const known = numbers.filter((value) => typeof value === 'number');
  return known.length ? { usd: known.reduce((sum, value) => sum + value, 0) } : undefined;
}

// An error with a stable code (upper case words) that the interface can show in its own language.
function musicError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function shortMessage(err) {
  return String(err?.message || err).slice(0, 200);
}

// Runs `task(index)` `count` times in parallel (variants of one node). Failed variants are dropped with a log line
// so already paid results are not lost; the node only fails when every variant failed.
async function collectVariants(ctx, count, task) {
  if (ctx.signal?.aborted) throw jobs.abortError();
  const settled = await Promise.allSettled(Array.from({ length: count }, (_unused, index) => task(index)));
  if (ctx.signal?.aborted) throw jobs.abortError();
  const done = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  const failed = settled.filter((entry) => entry.status === 'rejected');
  if (!done.length) throw failed[0].reason;
  if (failed.length) ctx.log(`${failed.length} of ${count} variants failed: ${shortMessage(failed[0].reason)}`);
  return done;
}

/* ---------- LLM nodes ---------- */

const MODEL_PARAM = { id: 'model', kind: 'select', optionsSource: 'brain-models', default: '' };
const LANGUAGES = { en: 'English', de: 'German (Swiss High German, always "ss", never the sharp s)', es: 'Spanish' };

async function imageDataUrls(ctx, values) {
  return Promise.all(sessionAssetIds(ctx, values).map((assetId) => store.assetDataUrl(ctx.sessionId, assetId)));
}

// One completion; a blank model falls back to the configured default brain (for participants and guests with
// config.restrictedBrainModels: to the default of their list). A model chosen by hand that is not on their list is
// refused by llm.completeText. When the ChatGPT subscription fails, the call runs through OpenRouter and the node log says so.
function askModel(ctx, params, options) {
  const restrictedModels = ctx.config?.restrictedBrainModels || [];
  let model = String(params.model || '').trim();
  if (!model) {
    const configured = ctx.config?.defaultBrain || '';
    const viewer = access.viewerOf({ kubleUser: ctx.user });
    model = access.brainModelFor(viewer, configured, { restrictedModels, defaultBrain: configured }).model || configured;
  }
  return llm.completeText({
    model,
    sessionId: ctx.sessionId,
    user: ctx.user,
    budgetKey: ctx.toolCtx?.budgetKey || null,
    restrictedModels,
    onReplaced: (info) => ctx.log?.(`ChatGPT subscription not reachable (${info.reason}): this call runs through OpenRouter (${info.to}) and is billed.`),
    ...options
  });
}

async function askVariants(ctx, params, options) {
  const results = await collectVariants(ctx, params.count || 1, () => askModel(ctx, params, options));
  return {
    variants: results.map((result) => ({ text: textValue(result.text) })),
    cost: usdCost(results.map((result) => result.usd))
  };
}

const ENHANCER_TARGETS = {
  image: 'a still image generator (composition, subject, setting, lighting, lens, colour palette, style, mood)',
  video:
    'a text-to-video / image-to-video generator (one continuous shot: subject action, camera movement, pacing, lighting, style; no cuts)',
  speech: 'a text-to-speech engine: write only the words to be spoken, natural punctuation for pacing, no stage directions or markup; keep the language of the input',
  motion: 'a motion-graphics designer (on-screen text, layout, colours, animation timing and easing, duration)'
};

function enhancerSystem(target) {
  return [
    `You are a prompt engineer. Rewrite the user's input into ONE production-ready prompt for ${ENHANCER_TARGETS[target] || ENHANCER_TARGETS.image}.`,
    target === 'speech'
      ? 'Keep the language of the input.'
      : 'Write the prompt in English, whatever language the input is in (the generation tools require English prompts).',
    "Keep the user's intent, subjects and constraints. Add concrete detail where the input is vague, but do not invent brands, logos or on-screen text unless requested.",
    'If images are attached, use them as visual context for the prompt.',
    'Answer with the prompt text only: no preamble, no quotation marks, no markdown, no explanations.'
  ].join('\n');
}

const DESCRIBE_FOCUS = {
  full: 'Cover subject, setting, composition, lighting, colours, style and mood.',
  subject: 'Focus on the main subject: who or what it is, appearance, pose, clothing, expression.',
  style: 'Focus on the visual style: medium, colour palette, lighting, texture, lens and artistic references.',
  composition: 'Focus on the composition: framing, camera angle, depth, layout and the position of every element.',
  motion: 'Focus on movement: subject action, camera movement, pacing and how the shot develops from start to end.'
};

function describerSystem(what, focus, language) {
  return [
    `You describe ${what} so the description can be used as a prompt for AI image and video generation.`,
    DESCRIBE_FOCUS[focus] || DESCRIBE_FOCUS.full,
    `Write the description in ${LANGUAGES[language] || LANGUAGES.en}. Be concrete and factual.`,
    'Answer with the description only: one plain-text paragraph, no preamble, no markdown.'
  ].join('\n');
}

// Placeholder list handed to the HTML writer: {{asset:N}} is replaced by the exact file name at render time.
function motionSystem({ format, duration, assetList }) {
  const [width, height] = tools.RENDER_FORMATS[format] || tools.RENDER_FORMATS.landscape;
  const assetLines = assetList.length
    ? assetList.map((entry, index) => `- {{asset:${index + 1}}} = ${entry.type} (${path.extname(entry.file).replace('.', '')})`).join('\n')
    : '- (no assets attached)';
  return [
    'You write the complete HTML composition for a deterministic motion-graphics render node.',
    'Answer with the HTML document only: no explanations and no markdown code fences.',
    `Target format: ${format} = ${width}x${height} px, duration ${duration} seconds. Use data-width="${width}", data-height="${height}" and data-duration="${duration}".`,
    'Attached assets are referenced ONLY through their placeholders (for example src="{{asset:1}}"). The placeholder is replaced with the exact file name before rendering, so write it literally, including the double braces.',
    assetLines,
    '',
    'Rendering contract:',
    tools.RENDER_MOTION_GRAPHICS_DEFINITION.function.description
  ].join('\n');
}

function stripCodeFence(text) {
  let out = String(text || '').trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(out);
  if (fenced) out = fenced[1].trim();
  if (!out.startsWith('<')) {
    const start = out.search(/<!doctype|<html|<div/i);
    if (start > 0) out = out.slice(start).trim();
  }
  return out;
}

const llmDefinitions = [
  {
    type: 'llm.chat',
    category: 'llm',
    label: 'LLM',
    keywords: ['llm', 'chat', 'gpt', 'claude', 'gemini', 'text', 'prompt', 'ai', 'language model'],
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      { id: 'system', type: 'text', param: 'system' },
      { id: 'images', type: 'image', multiple: true, max: MAX_LLM_IMAGES }
    ],
    outputs: [{ id: 'text', type: 'text' }],
    params: [
      MODEL_PARAM,
      { id: 'system', kind: 'textarea', default: '' },
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'temperature', kind: 'number', min: 0, max: 2, optional: true, default: null },
      { id: 'max_tokens', kind: 'integer', min: 1, optional: true, default: null },
      { id: 'json', kind: 'boolean', default: false },
      { id: 'count', kind: 'integer', min: 1, max: 4, default: 1 }
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: llmAvailable,
    validate: (_params, ports) =>
      ports.images?.count > MAX_LLM_IMAGES ? [`images: at most ${MAX_LLM_IMAGES} images are allowed`] : [],
    execute: async (ctx, inputs, params) => {
      const images = itemsOf(inputs, 'images');
      limitCheck(images, MAX_LLM_IMAGES, 'images');
      const dataUrls = await imageDataUrls(ctx, images);
      return askVariants(ctx, params, {
        system: inputs.system ? inputs.system.value : '',
        prompt: inputs.prompt.value,
        images: dataUrls,
        temperature: params.temperature,
        maxTokens: params.max_tokens,
        json: params.json
      });
    }
  },
  {
    type: 'llm.prompt_enhancer',
    category: 'llm',
    label: 'Prompt enhancer',
    keywords: ['prompt', 'enhance', 'improve', 'rewrite', 'llm', 'english'],
    inputs: [
      { id: 'prompt', type: 'text', required: true },
      { id: 'images', type: 'image', multiple: true, max: MAX_LLM_IMAGES }
    ],
    outputs: [{ id: 'text', type: 'text' }],
    params: [
      MODEL_PARAM,
      { id: 'target', kind: 'select', options: Object.keys(ENHANCER_TARGETS), default: 'image', inline: true },
      { id: 'notes', kind: 'textarea', default: '' }
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: llmAvailable,
    execute: async (ctx, inputs, params) => {
      const images = itemsOf(inputs, 'images');
      limitCheck(images, MAX_LLM_IMAGES, 'images');
      const notes = params.notes.trim();
      const prompt = notes ? `${inputs.prompt.value}\n\nAdditional notes: ${notes}` : inputs.prompt.value;
      return askVariants(ctx, { ...params, count: 1 }, {
        system: enhancerSystem(params.target),
        prompt,
        images: await imageDataUrls(ctx, images)
      });
    }
  },
  {
    type: 'llm.image_describer',
    category: 'llm',
    label: 'Image describer',
    keywords: ['describe', 'caption', 'image', 'vision', 'llm', 'alt text'],
    inputs: [{ id: 'image', type: 'image', required: true }],
    outputs: [{ id: 'text', type: 'text' }],
    params: [
      MODEL_PARAM,
      { id: 'focus', kind: 'select', options: ['full', 'subject', 'style', 'composition'], default: 'full' },
      { id: 'language', kind: 'select', options: Object.keys(LANGUAGES), default: 'en' }
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: llmAvailable,
    execute: async (ctx, inputs, params) =>
      askVariants(ctx, { ...params, count: 1 }, {
        system: describerSystem('images', params.focus, params.language),
        prompt: 'Describe the attached image.',
        images: await imageDataUrls(ctx, [inputs.image])
      })
  },
  {
    type: 'llm.video_describer',
    category: 'llm',
    label: 'Video describer',
    keywords: ['describe', 'caption', 'video', 'vision', 'llm', 'frames'],
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'text', type: 'text' }],
    params: [
      MODEL_PARAM,
      { id: 'focus', kind: 'select', options: ['full', 'subject', 'style', 'motion'], default: 'full' },
      { id: 'language', kind: 'select', options: Object.keys(LANGUAGES), default: 'en' }
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: () => {
      const ffmpegReason = ffmpegAvailable();
      return ffmpegReason === true ? llmAvailable() : ffmpegReason;
    },
    // Visual only: three frames (start, middle, end) are sent, the audio track is not transcribed.
    execute: async (ctx, inputs, params) => {
      sessionAssetIds(ctx, [inputs.video]);
      const frames = await ctx.withLocalSlot(() => poller.extractVideoFrames(assets.assetFilePath(inputs.video)));
      return askVariants(ctx, { ...params, count: 1 }, {
        system: describerSystem('videos', params.focus, params.language),
        prompt: 'The attached images are frames from one video, taken at the start, in the middle and near the end. Describe the video.',
        images: frames.map((frame) => `data:image/jpeg;base64,${frame.toString('base64')}`)
      });
    }
  },
  {
    type: 'llm.motion_html',
    category: 'llm',
    label: 'Motion HTML writer',
    keywords: ['motion', 'html', 'gsap', 'graphics', 'title', 'llm', 'code'],
    inputs: [
      { id: 'brief', type: 'text', required: true },
      { id: 'assets', type: 'any', multiple: true, max: MAX_MOTION_ASSETS }
    ],
    outputs: [{ id: 'html', type: 'text' }],
    params: [
      MODEL_PARAM,
      { id: 'format', kind: 'select', options: ['landscape', 'portrait', 'square'], default: 'landscape' },
      { id: 'duration', kind: 'integer', min: 1, max: 60, default: 6 }
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: llmAvailable,
    validate: (_params, ports) =>
      ports.assets?.count > MAX_MOTION_ASSETS ? [`assets: at most ${MAX_MOTION_ASSETS} assets are allowed`] : [],
    execute: async (ctx, inputs, params) => {
      const attached = itemsOf(inputs, 'assets');
      limitCheck(attached, MAX_MOTION_ASSETS, 'assets');
      requireMedia(attached, 'assets');
      sessionAssetIds(ctx, attached);
      const result = await askModel(ctx, params, {
        system: motionSystem({ format: params.format, duration: params.duration, assetList: attached }),
        prompt: inputs.brief.value
      });
      const html = stripCodeFence(result.text);
      if (!html) throw new Error('The model returned no HTML');
      return { variants: [{ html: textValue(html) }], cost: usdCost([result.usd]) };
    }
  }
];

/* ---------- image nodes ---------- */

// Result of an image tool call as { value, usd } (the tool journals the cost itself).
async function imageFromTool(ctx, name, args, toolCtx = ctx.toolCtx) {
  const outcome = await tools.executeTool(toolCtx, name, args);
  if (!outcome?.asset) throw new Error('The image tool returned no asset');
  return {
    value: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id),
    usd: typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null
  };
}

// model: the model the run really used. It is kept with the cost in the history, because an empty model param does not say
// which model was behind it (the configuration can change), and the plan prices the next run by the last cost of that model.
function imageVariants(results, model) {
  const cost = usdCost(results.map((result) => result.usd));
  return {
    variants: results.map((result) => ({ image: result.value })),
    cost: cost && model ? { ...cost, model } : cost
  };
}

const COUNT_PARAM = { id: 'count', kind: 'integer', min: 1, max: 4, default: 1 };

// Image models of the nodes (lib/image-models.js). The param is empty by default: the node then uses config.imageModel,
// as every workflow did before the model could be chosen. The lists come from GET /api/nodes/options/<source>.
const IMAGE_MODEL_PARAM = { id: 'model', kind: 'select', optionsSource: 'image-models', default: '' };
const IMAGE_EDIT_MODEL_PARAM = { ...IMAGE_MODEL_PARAM, optionsSource: 'image-edit-models' };

// An error with a stable code that the interface can show in its own language (like musicError).
function imageError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

// The model a node run uses: its own choice, which has to be on the list of the configuration (a workflow that comes
// from somebody else must not be able to run any model of the provider on this account), else config.imageModel.
function imageModelOf(ctx, params) {
  const chosen = String(params.model || '').trim();
  if (!chosen) return String(ctx.config?.imageModel || '').trim();
  if (!imageModels.isAllowed(ctx.config, chosen)) {
    throw imageError('IMAGE_MODEL_NOT_ALLOWED', `Image model ${chosen} is not on the list of this server (config.imageModels)`, { model: chosen });
  }
  return chosen;
}

// The context for the image tools: the model of the node replaces config.imageModel for this call (the way the chat
// replaces the video model), and the price of the model is what the budget of a participant reserves. No price known:
// nothing is passed, the budget then only needs something left (never 0).
function imageToolContext(ctx, params) {
  const model = imageModelOf(ctx, params);
  const toolCtx = { ...ctx.toolCtx };
  if (model && model !== ctx.toolCtx.config?.imageModel) toolCtx.config = { ...ctx.toolCtx.config, imageModel: model };
  const price = imageModels.estimateUsd(model);
  if (price !== null) toolCtx.imageEstimateUsd = price;
  return { toolCtx, model };
}

// Price of the nodes of an image type, per model: the last cost of the same model in this workflow, else the list price of
// the model (lib/image-models.js), else unknown (null). Scaled to the number of variants. The model of a history entry is
// the one the run really used (cost.model); an older entry or a node run with an empty model param counts as the configured
// model (config.imageModel), as does an empty choice now. So an explicit choice of the configured model and the default
// entry share their history, and a default entry that ran with another model than the configured one now is not used.
function lastImageCost(context, type, model, count) {
  const nodes = context?.workflow?.graph?.nodes || [];
  const configured = String(context?.config?.imageModel || '').trim();
  const wanted = model || configured;
  let best = null;
  for (const node of nodes) {
    if (node.type !== type) continue;
    for (const entry of context.results?.nodes?.[node.id]?.history || []) {
      const usd = entry?.cost?.usd;
      if (!Number.isFinite(usd) || !(usd > 0)) continue;
      const used = String(entry.cost?.model || entry.params?.model || '').trim() || configured;
      if (used !== wanted) continue;
      if (!best || String(entry.createdAt) > String(best.createdAt)) best = { createdAt: entry.createdAt, usd, count: Number(entry.params?.count) };
    }
  }
  if (!best) return null;
  return Number.isFinite(best.count) && best.count > 0 ? (best.usd / best.count) * count : best.usd;
}

function imageCostEstimate(type) {
  return (params, context) => {
    const chosen = String(params.model || '').trim();
    const count = Number.isFinite(Number(params.count)) && params.count > 0 ? Number(params.count) : 1;
    const last = lastImageCost(context, type, chosen, count);
    if (last !== null) return { usd: last };
    const price = imageModels.estimateUsd(chosen || context?.config?.imageModel);
    return price === null ? null : { usd: Math.round(price * count * 1e6) / 1e6 };
  };
}

// What the model of an image.edit node takes, for the input with `limitBy` (registry limitsFor). Only models whose limit is
// known; {} = unknown, the fixed maximum of the input is the only limit then.
function imageEditLimits(params) {
  const chosen = String(params.model || '').trim();
  const limits = chosen ? imageModels.referenceLimits(chosen) : null;
  return limits ? { images: { max: limits.max, roles: [], required: false, subject: imageModels.displayName(chosen) } } : {};
}

function tooManyReferences(model, max, count) {
  return max === 0
    ? `Model ${model} takes no reference images (got ${count})`
    : `Model ${model} accepts at most ${max} reference images (got ${count})`;
}

const LIGHT_PRESETS = {
  golden_hour: 'warm golden-hour sunlight from a low sun with long, soft shadows',
  soft_studio: 'soft, diffused studio lighting with gentle, even shadows',
  hard_noon_sun: 'hard direct noon sunlight with crisp, short, high-contrast shadows',
  overcast: 'flat, soft overcast daylight with muted shadows',
  neon_night: 'night-time neon lighting with saturated magenta and cyan glow and deep shadows',
  candle: 'warm, flickering candlelight that falls off quickly into darkness'
};

function buildRelightPrompt({ light, custom, strength, notes }) {
  const description = light === 'custom' ? String(custom || '').trim() : LIGHT_PRESETS[light];
  if (!description) throw new Error('Describe the desired lighting in the custom field');
  const parts = [
    `Relight this exact scene with ${description}.`,
    'Keep the composition, framing, camera angle, the identity, pose and expression of every person, all objects, materials, object colours and fine details unchanged; only the lighting, shadows and the resulting colour cast may change.',
    strength === 'strong' ? 'Apply a clearly visible, strong change.' : 'Apply the change subtly.'
  ];
  if (notes) parts.push(`Additional notes: ${notes}`);
  return parts.join(' ');
}

const imageDefinitions = [
  {
    type: 'image.generate',
    category: 'image',
    label: 'Generate image',
    keywords: ['gpt', 'image', 'text to image', 'generate', 'openai', 'picture', 'model', 'nano banana', 'gemini'],
    inputs: [{ id: 'prompt', type: 'text', required: true, param: 'prompt' }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      IMAGE_MODEL_PARAM,
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'aspect_ratio', kind: 'select', options: tools.IMAGE_RATIOS, default: '1:1' },
      COUNT_PARAM
    ],
    paid: true,
    // the price depends on the model: the plan reads it per model (imageCostEstimate), never from the last node of the type
    cost: { unit: 'usd', estimate: imageCostEstimate('image.generate'), history: false },
    available: openRouterAvailable,
    prepare: () => imageModels.load(),
    execute: async (ctx, inputs, params) => {
      const args = { prompt: inputs.prompt.value, aspect_ratio: params.aspect_ratio };
      const { toolCtx, model } = imageToolContext(ctx, params);
      return imageVariants(await collectVariants(ctx, params.count, () => imageFromTool(ctx, 'generate_image', args, toolCtx)), model);
    }
  },
  {
    type: 'image.edit',
    category: 'image',
    label: 'Edit image',
    keywords: ['gpt', 'image', 'edit', 'reference', 'image to image', 'openai', 'restyle', 'model', 'nano banana', 'gemini'],
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      // How many reference images the chosen model takes comes from the model list (limitBy / limitsFor); a model whose
      // limit is unknown keeps the fixed maximum.
      { id: 'images', type: 'image', required: true, multiple: true, max: MAX_EDIT_IMAGES, limitBy: { param: 'model', capability: 'references' } }
    ],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      IMAGE_EDIT_MODEL_PARAM,
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'aspect_ratio', kind: 'select', options: ['auto', ...tools.IMAGE_RATIOS], default: 'auto' },
      COUNT_PARAM
    ],
    paid: true,
    cost: { unit: 'usd', estimate: imageCostEstimate('image.edit'), history: false },
    available: openRouterAvailable,
    limitsFor: imageEditLimits,
    prepare: () => imageModels.load(),
    validate: (params, ports) => {
      const issues = [];
      const count = ports.images?.count || 0;
      if (count > MAX_EDIT_IMAGES) issues.push(`images: at most ${MAX_EDIT_IMAGES} images are allowed`);
      // against the chosen model, while its limit is known (execute() checks again with the model it really uses)
      const limit = imageEditLimits(params).images;
      if (limit && count > limit.max && count <= MAX_EDIT_IMAGES) {
        issues.push({
          code: 'too_many_refs',
          port: 'images',
          data: { model: limit.subject, max: limit.max, count },
          message: `images: model ${limit.subject} accepts at most ${limit.max} reference images (got ${count})`
        });
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const images = itemsOf(inputs, 'images');
      if (!images.length) throw new Error('images: connect at least one image');
      limitCheck(images, MAX_EDIT_IMAGES, 'images');
      const { toolCtx, model } = imageToolContext(ctx, params);
      // the model really used: its own choice or, without one, the configured model
      const limits = imageModels.referenceLimits(model);
      if (limits && images.length > limits.max) {
        const name = imageModels.displayName(model);
        throw imageError('TOO_MANY_REFERENCES', tooManyReferences(name, limits.max, images.length), { model: name, max: limits.max, count: images.length });
      }
      const args = { prompt: inputs.prompt.value, reference_asset_ids: sessionAssetIds(ctx, images) };
      if (params.aspect_ratio && params.aspect_ratio !== 'auto') args.aspect_ratio = params.aspect_ratio;
      return imageVariants(await collectVariants(ctx, params.count, () => imageFromTool(ctx, 'edit_image', args, toolCtx)), model);
    }
  },
  {
    type: 'image.relight',
    category: 'image',
    label: 'Relight image',
    keywords: ['relight', 'lighting', 'light', 'gpt', 'edit', 'mood'],
    description: 'Approximation: GPT Image 2 regenerates the image with a lighting prompt; there is no dedicated relighting model.',
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'notes', type: 'text' }
    ],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'light', kind: 'select', options: [...Object.keys(LIGHT_PRESETS), 'custom'], default: 'golden_hour', inline: true },
      { id: 'custom', kind: 'text', default: '', showIf: { param: 'light', equals: 'custom' } },
      { id: 'strength', kind: 'select', options: ['subtle', 'strong'], default: 'subtle' },
      COUNT_PARAM
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: openRouterAvailable,
    validate: (params) =>
      params.light === 'custom' && !params.custom.trim() ? [{ message: 'custom: describe the desired lighting', code: 'invalid_param' }] : [],
    execute: async (ctx, inputs, params) => {
      const prompt = buildRelightPrompt({
        light: params.light,
        custom: params.custom,
        strength: params.strength,
        notes: inputs.notes ? inputs.notes.value.trim() : ''
      });
      const args = { prompt, reference_asset_ids: sessionAssetIds(ctx, [inputs.image]) };
      return imageVariants(await collectVariants(ctx, params.count, () => imageFromTool(ctx, 'edit_image', args)));
    }
  }
];

/* ---------- Higgsfield generation (dynamic models, SPEC §10) ---------- */

function parseExtraParams(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`extra_params is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('extra_params must be a JSON object');
  return parsed;
}

function extraParamsIssues(text) {
  try {
    parseExtraParams(text);
    return [];
  } catch (err) {
    return [{ code: 'invalid_param', message: err.message }];
  }
}

// Catalogue lookups must never fail a run on their own (the tool re-verifies what it needs).
async function lookupModel(modelId) {
  try {
    return await higgsfieldCatalog.getModel(modelId);
  } catch (_) {
    return null;
  }
}

function higgsfieldCreditEstimate(params) {
  const model = higgsfieldCatalog.peekModel(params.model);
  const credits = model ? higgsfieldCatalog.creditsFor(model, { duration: params.duration }) : null;
  return credits === null ? null : { credits };
}

const AUDIO_NEEDS_REFS = 'audio: audio tracks need at least one image reference (connect refs)';

// What the chosen model takes at the inputs that depend on it (registry `limitBy`): reference images and, for video,
// audio tracks. Only while the model is in the catalogue cache (peekModel); {} = unknown, the fixed maximum of the
// port is the only limit then.
function higgsfieldLimits(params, isVideo) {
  const modelId = String(params.model || '').trim();
  const model = modelId ? higgsfieldCatalog.peekModel(modelId) : null;
  const caps = model ? higgsfieldCatalog.capabilitiesOf(model, { type: isVideo ? 'video' : 'image' }) : null;
  if (!caps) return {};
  const subject = String(model.name || modelId);
  const limits = { refs: { max: caps.references.max, roles: caps.references.roles, required: caps.references.required, subject } };
  if (isVideo && caps.audio) limits.audio = { max: caps.audio.max, subject };
  return limits;
}

function higgsfieldGenerationDefinition(kind) {
  const isVideo = kind === 'video';
  const tool = isVideo ? 'higgsfield_generate_video' : 'higgsfield_generate_image';
  const output = isVideo ? 'video' : 'image';
  return {
    type: `${output}.higgsfield`,
    category: 'higgsfield',
    label: isVideo ? 'Higgsfield video' : 'Higgsfield image',
    keywords: ['higgsfield', output, 'kling', 'veo', 'sora', 'nano banana', 'soul', 'model'],
    description:
      'Model parameters come from the Higgsfield catalogue (GET /api/nodes/higgsfield-models/:id). ' +
      'aspect_ratio, resolution and duration are separate params; every other model parameter goes into extra_params (JSON object).' +
      (isVideo
        ? ' The optional audio input (audio_references) needs a model that declares an audio media role and at least one image reference.'
        : ''),
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      // How many references a model takes (0 to 12), and which roles, comes from the catalogue: limitBy / limitsFor.
      { id: 'refs', type: 'image', multiple: true, max: MAX_HIGGSFIELD_REFS, limitBy: { param: 'model', capability: 'references' } },
      // Only for models that declare an audio media role (checked before anything is submitted); the API wants an
      // image or video reference next to the audio. How many tracks a model takes comes from the catalogue.
      ...(isVideo ? [{ id: 'audio', type: 'audio', multiple: true, max: tools.HIGGSFIELD_MAX_AUDIO_REFS, limitBy: { param: 'model', capability: 'audio' } }] : [])
    ],
    outputs: [{ id: output, type: output }],
    params: [
      { id: 'model', kind: 'select', optionsSource: isVideo ? 'higgsfield-video-models' : 'higgsfield-image-models', default: '' },
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'aspect_ratio', kind: 'text', default: '', dynamic: 'higgsfield-model' },
      { id: 'resolution', kind: 'text', default: '', dynamic: 'higgsfield-model' },
      ...(isVideo ? [{ id: 'duration', kind: 'integer', min: 1, optional: true, default: null, dynamic: 'higgsfield-model' }] : []),
      { id: 'extra_params', kind: 'code', default: '{}', dynamic: 'higgsfield-model' }
    ],
    paid: true,
    async: true,
    cost: { unit: 'credits', estimate: higgsfieldCreditEstimate },
    available: higgsfieldAvailable,
    limitsFor: (params) => higgsfieldLimits(params, isVideo),
    // validate() reads the model from the cache only: the engine loads it before a plan or a run (cold or expired cache)
    prepare: (params) => lookupModel(String(params.model || '')),
    validate: (params, ports) => {
      const issues = [];
      if (!params.model.trim()) issues.push({ code: 'invalid_param', message: 'model: select a Higgsfield model' });
      issues.push(...extraParamsIssues(params.extra_params));
      if (ports.refs?.count > MAX_HIGGSFIELD_REFS) issues.push(`refs: at most ${MAX_HIGGSFIELD_REFS} references are allowed`);
      // The references against the chosen model, while it is in the catalogue cache (execute() checks again with the
      // full record). Connections are never removed by a model change: a node that has too many is invalid instead.
      const refLimit = higgsfieldLimits(params, isVideo).refs;
      if (refLimit) {
        const count = ports.refs?.count || 0;
        const data = { model: refLimit.subject, max: refLimit.max, count };
        if (count > refLimit.max && count <= MAX_HIGGSFIELD_REFS) {
          issues.push({ code: 'too_many_refs', port: 'refs', data, message: `refs: model ${params.model} accepts at most ${refLimit.max} reference images (got ${count})` });
        } else if (refLimit.required && count === 0) {
          issues.push({ code: 'refs_required', port: 'refs', data: { model: refLimit.subject }, message: `refs: model ${params.model} needs a reference image (connect refs)` });
        }
      }
      if (isVideo && ports.audio?.connected) {
        if (ports.audio.count > tools.HIGGSFIELD_MAX_AUDIO_REFS) issues.push(`audio: at most ${tools.HIGGSFIELD_MAX_AUDIO_REFS} audio tracks are allowed`);
        if (!ports.refs?.connected) issues.push({ code: 'invalid_param', port: 'audio', message: AUDIO_NEEDS_REFS });
        // Only knowable while the full model is in the catalogue cache (a record without a media list says nothing, which
        // is not the same as "no audio"); execute() and the tool check again before submitting.
        const audioLimit = higgsfieldLimits(params, true).audio;
        if (audioLimit && ports.audio.count > audioLimit.max && ports.audio.count <= tools.HIGGSFIELD_MAX_AUDIO_REFS) {
          issues.push({
            code: 'too_many_audio',
            port: 'audio',
            data: { model: audioLimit.subject, max: audioLimit.max, count: ports.audio.count },
            message: audioLimit.max === 0
              ? `audio: model ${params.model} declares no audio input`
              : `audio: model ${params.model} accepts at most ${audioLimit.max} audio tracks`
          });
        }
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const extra = parseExtraParams(params.extra_params);
      const refs = itemsOf(inputs, 'refs');
      limitCheck(refs, MAX_HIGGSFIELD_REFS, 'refs');
      const audios = isVideo ? itemsOf(inputs, 'audio') : [];
      limitCheck(audios, tools.HIGGSFIELD_MAX_AUDIO_REFS, 'audio');
      if (audios.length && !refs.length) throw new Error(AUDIO_NEEDS_REFS);
      const model = await lookupModel(params.model);
      if (model) {
        // A record without a media list says nothing about references: only the fixed maximum above applies then (the tool
        // layer has no reference count check for Higgsfield generations). Knowingly so: unknown is not "none".
        const slots = higgsfieldCatalog.capabilitiesOf(model)?.references;
        if (slots && refs.length > slots.max) throw new Error(`Model ${params.model} accepts at most ${slots.max} reference images (got ${refs.length})`);
        if (slots && !refs.length && slots.required) throw new Error(`Model ${params.model} needs a reference image (connect refs)`);
        if (audios.length) {
          const slot = tools.audioSlotFromModel(model);
          if (!slot) throw new Error(`Model ${params.model} declares no audio input; disconnect the audio port or pick another model`);
          if (slot.max !== null && audios.length > slot.max) {
            throw new Error(`Model ${params.model} accepts at most ${slot.max} audio tracks (got ${audios.length})`);
          }
        }
      }
      const args = {
        model: params.model,
        prompt: inputs.prompt.value,
        aspect_ratio: params.aspect_ratio || undefined,
        resolution: params.resolution || undefined,
        reference_asset_ids: refs.length ? sessionAssetIds(ctx, refs) : undefined,
        reference_audio_asset_ids: audios.length ? sessionAssetIds(ctx, audios) : undefined,
        extra_params: Object.keys(extra).length ? extra : undefined
      };
      if (isVideo && params.duration !== null) args.duration = params.duration;
      const outcome = await tools.executeTool(ctx.toolCtx, tool, args);
      for (const note of outcome.corrections || []) ctx.log(note);
      const ids = await ctx.waitForJob(outcome.job);
      const values = await Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
      const credits = model ? higgsfieldCatalog.creditsFor(model, { duration: params.duration }) : null;
      return {
        variants: values.map((value) => ({ [output]: value })),
        cost: credits === null ? undefined : { credits }
      };
    }
  };
}

/* ---------- video nodes ---------- */

// Waits for the job of a tool outcome and returns the values of its result assets.
async function valuesFromJob(ctx, outcome) {
  if (!outcome?.job) throw new Error('The tool did not start a job');
  const ids = await ctx.waitForJob(outcome.job);
  return Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
}

const MOTION_PLACEHOLDER = /\{\{\s*asset\s*:\s*(\d+)\s*\}\}/g;
const HAS_MOTION_PLACEHOLDER = /\{\{\s*asset\s*:\s*\d+\s*\}\}/;

// {{asset:N}} -> "<assetId><ext>", exactly the file name renderAssetsFromIds copies beside index.html.
function replaceAssetPlaceholders(html, values) {
  return String(html).replace(MOTION_PLACEHOLDER, (_match, number) => {
    const value = values[Number(number) - 1];
    if (!value) throw new Error(`Placeholder {{asset:${number}}} has no matching asset (${values.length} connected)`);
    return `${value.assetId}${path.extname(value.file)}`;
  });
}

/* ---------- video.generate: the model is chosen in the node ---------- */

// Video models of the node (lib/video-node-models.js). The param is empty by default: the node then uses
// config.videoModel. The list comes from GET /api/nodes/options/video-models; it says what each model takes.
const VIDEO_MODEL_PARAM = { id: 'model', kind: 'select', optionsSource: 'video-models', default: '' };
const VIDEO_RESOLUTIONS = ['auto', '480p', '720p', '1080p'];
const MAX_VIDEO_LAST_FRAMES = 1;

// The model a video.generate run uses: its own choice, which has to be on the list of the node (the configured model and
// the curated list of the chat, like the cards of the chat), else config.videoModel.
function videoModelOf(ctx, params) {
  const chosen = String(params.model || '').trim();
  if (!chosen) return String(ctx.config?.videoModel || '').trim();
  if (!videoNodeModels.isAllowed(ctx.config, chosen)) {
    throw imageError('VIDEO_MODEL_NOT_ALLOWED', `Video model ${chosen} is not offered by this server`, { model: chosen });
  }
  return chosen;
}

// What the chosen model takes at the inputs that depend on it (registry `limitBy`): reference images, reference videos,
// audio and the end frame. Only what the model list or the chat profiles say; {} = unknown, the fixed maximum of the input
// is the only limit then.
function videoGenerateLimits(params) {
  const chosen = String(params.model || '').trim();
  const taken = chosen ? videoNodeModels.limits(chosen) : null;
  if (!taken) return {};
  const subject = videoNodeModels.displayName(chosen);
  const out = {};
  if (taken.images !== null) out.refs = { max: taken.images, roles: [], required: false, subject };
  if (taken.videos !== null) out.ref_videos = { max: taken.videos, roles: [], required: false, subject };
  if (taken.audios !== null) out.ref_audios = { max: taken.audios, roles: [], required: false, subject };
  if (taken.lastFrame !== null) out.last_frame = { max: taken.lastFrame, roles: [], required: false, subject };
  return out;
}

// What does not fit the chosen model: one list for the check before the run (validate, only for a model that is chosen in
// the node) and for the run itself (the model really used). counts: how many are connected at first_frame, last_frame,
// refs, ref_videos and ref_audios. The run uses the codes without a port in their text (the card of a failed run has no
// input to name).
function videoFitIssues(model, params, counts, { run = false } = {}) {
  const issues = [];
  if (counts.last > 0 && counts.first === 0) {
    issues.push({ code: 'VIDEO_LAST_FRAME_NEEDS_FIRST', port: 'last_frame', message: 'last_frame: an end frame needs a first frame (connect first_frame)' });
  }
  const taken = videoNodeModels.limits(model);
  if (!taken) return issues;
  const name = videoNodeModels.displayName(model);
  if (counts.last > 0 && taken.lastFrame === 0) {
    issues.push({ code: 'VIDEO_LAST_FRAME_UNSUPPORTED', port: 'last_frame', data: { model: name }, message: `Model ${name} takes no end frame` });
  }
  if (counts.first > 0 && taken.firstFrame === 0) {
    issues.push({ code: 'VIDEO_FIRST_FRAME_UNSUPPORTED', port: 'first_frame', data: { model: name }, message: `Model ${name} takes no first frame` });
  }
  // more than the fixed maximum of the input is reported once, in its own words (validate)
  const over = (count, max, fixed) => max !== null && count > max && count <= fixed;
  if (over(counts.refs, taken.images, MAX_SEEDANCE_REFS)) {
    issues.push({
      code: run ? 'TOO_MANY_REFERENCES' : 'too_many_refs',
      port: 'refs',
      data: { model: name, max: taken.images, count: counts.refs },
      message: tooManyReferences(name, taken.images, counts.refs)
    });
  }
  if (over(counts.videos, taken.videos, MAX_SEEDANCE_MEDIA_REFS)) {
    issues.push({
      code: 'VIDEO_TOO_MANY_REF_VIDEOS',
      port: 'ref_videos',
      data: { model: name, max: taken.videos, count: counts.videos },
      message: taken.videos === 0 ? `Model ${name} takes no reference videos (got ${counts.videos})` : `Model ${name} accepts at most ${taken.videos} reference videos (got ${counts.videos})`
    });
  }
  if (over(counts.audios, taken.audios, MAX_SEEDANCE_MEDIA_REFS)) {
    issues.push({
      code: 'VIDEO_TOO_MANY_REF_AUDIOS',
      port: 'ref_audios',
      data: { model: name, max: taken.audios, count: counts.audios },
      message: taken.audios === 0 ? `Model ${name} takes no reference audio (got ${counts.audios})` : `Model ${name} accepts at most ${taken.audios} reference audios (got ${counts.audios})`
    });
  }
  // the duration and the resolution the model really offers (a model with a range takes the nearest value; one with fixed
  // lengths does not guess: the run is refused instead of paying for another length)
  const used = videoNodeModels.settings(model, { duration: params.duration, resolution: params.resolution, aspectRatio: params.aspect_ratio, firstFrame: counts.first > 0 });
  if (used.error === 'duration') {
    issues.push({ code: 'VIDEO_DURATION_UNSUPPORTED', data: { model: name, values: used.values.join(', ') }, message: `Model ${name} takes only these durations: ${used.values.join(', ')} seconds` });
  } else if (used.error === 'resolution') {
    issues.push({ code: 'VIDEO_RESOLUTION_UNSUPPORTED', data: { model: name, values: used.values.join(', ') }, message: `Model ${name} takes only these resolutions: ${used.values.join(', ')}` });
  }
  // Text to video: the format of the job is the aspect ratio of the node. A ratio the model does not list would be dropped by
  // the tool layer and the provider would make its own format, so it is refused here like the duration (the chat does not
  // offer such a model either). With a first frame the frame defines the format; the ratio does not count.
  const ratios = counts.first > 0 ? null : videoNodeModels.aspectRatios(model);
  const ratio = String(params.aspect_ratio || '').trim();
  if (ratios && ratio && !ratios.includes(ratio)) {
    issues.push({ code: 'VIDEO_ASPECT_RATIO_UNSUPPORTED', data: { model: name, values: ratios.join(', ') }, message: `Model ${name} takes only these aspect ratios: ${ratios.join(', ')}` });
  }
  return issues;
}

// The price of a video.generate node: the estimate of the chat (priceEstimate) for the duration and resolution the chosen
// model really uses; its upper end, which is what the budget of a participant reserves. Unknown (null), never 0.
function videoGenerateEstimate(params, context) {
  const model = String(params.model || '').trim() || String(context?.config?.videoModel || '').trim();
  if (!model) return null;
  const connected = context?.connected instanceof Set ? context.connected : new Set();
  const priced = videoNodeModels.estimate(model, {
    duration: params.duration,
    resolution: params.resolution,
    aspectRatio: params.aspect_ratio,
    firstFrame: connected.has('first_frame'),
    refVideos: connected.has('ref_videos')
  });
  return priced ? { usd: priced.option.estimateUsd } : null;
}

const videoDefinitions = [
  {
    type: 'video.seedance',
    category: 'video',
    label: 'Generate video (Seedance)',
    keywords: ['seedance', 'video', 'text to video', 'image to video', 'bytedance', 'generate', 'animate'],
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      { id: 'first_frame', type: 'image' },
      { id: 'refs', type: 'image', multiple: true, max: MAX_SEEDANCE_REFS },
      { id: 'ref_videos', type: 'video', multiple: true, max: MAX_SEEDANCE_MEDIA_REFS },
      { id: 'ref_audios', type: 'audio', multiple: true, max: MAX_SEEDANCE_MEDIA_REFS }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'duration', kind: 'integer', min: 4, max: 30, default: 5 },
      { id: 'aspect_ratio', kind: 'select', options: tools.VIDEO_RATIOS, default: '16:9', showIf: { port: 'first_frame', connected: false } },
      { id: 'resolution', kind: 'select', options: tools.VIDEO_RESOLUTIONS, default: '720p' }
    ],
    paid: true,
    async: true,
    cost: { unit: 'usd' },
    available: openRouterAvailable,
    validate: (_params, ports) => {
      const issues = [];
      if (ports.refs?.count > MAX_SEEDANCE_REFS) issues.push(`refs: at most ${MAX_SEEDANCE_REFS} references are allowed`);
      if (ports.ref_videos?.count > MAX_SEEDANCE_MEDIA_REFS) issues.push(`ref_videos: at most ${MAX_SEEDANCE_MEDIA_REFS} are allowed`);
      if (ports.ref_audios?.count > MAX_SEEDANCE_MEDIA_REFS) issues.push(`ref_audios: at most ${MAX_SEEDANCE_MEDIA_REFS} are allowed`);
      if ((ports.ref_videos?.connected || ports.ref_audios?.connected) && !publicBaseUrlSet()) {
        issues.push({ level: 'warning', code: 'public_base_url', message: 'Video and audio references need PUBLIC_BASE_URL (image references work without it)' });
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const refs = itemsOf(inputs, 'refs');
      const refVideos = itemsOf(inputs, 'ref_videos');
      const refAudios = itemsOf(inputs, 'ref_audios');
      limitCheck(refs, MAX_SEEDANCE_REFS, 'refs');
      limitCheck(refVideos, MAX_SEEDANCE_MEDIA_REFS, 'ref_videos');
      limitCheck(refAudios, MAX_SEEDANCE_MEDIA_REFS, 'ref_audios');
      // The input limits above are those of Seedance 2.5. The video model of the configuration decides what is taken (the
      // tool layer skips its own check in the node view): refused before anything is submitted. Models that are not
      // restricted there (referenceLimits null) keep the limits of the tool layer.
      const modelName = ctx.config?.videoModel;
      const modelLimits = modelName ? videoModels.referenceLimits(modelName) : null;
      if (modelLimits) {
        for (const [items, max, label] of [[refs, modelLimits.images, 'reference images'], [refVideos, modelLimits.videos, 'reference videos'], [refAudios, modelLimits.audios, 'reference audios']]) {
          if (items.length > max) throw new Error(max === 0 ? `Model ${modelName} takes no ${label} (got ${items.length})` : `Model ${modelName} accepts at most ${max} ${label} (got ${items.length})`);
        }
      }
      const args = {
        prompt: inputs.prompt.value,
        duration_seconds: params.duration,
        resolution: params.resolution,
        reference_asset_ids: sessionAssetIds(ctx, refs),
        reference_video_asset_ids: sessionAssetIds(ctx, refVideos),
        reference_audio_asset_ids: sessionAssetIds(ctx, refAudios)
      };
      if (inputs.first_frame) {
        args.mode = 'image_to_video';
        args.first_frame_asset_id = sessionAssetIds(ctx, [inputs.first_frame])[0];
      } else {
        args.mode = 'text_to_video';
        args.aspect_ratio = params.aspect_ratio;
      }
      const outcome = await tools.executeTool(ctx.toolCtx, 'generate_video', args);
      const ids = await ctx.waitForJob(outcome.job);
      const value = await assets.valueFromAsset(ctx.sessionId, ids[0]);
      // The poller stores the provider cost in the ledger when the job completes.
      return { variants: [{ video: value }], cost: usdCost([await assets.ledgerCosts(ctx.sessionId, ids)]) };
    }
  },
  {
    type: 'video.generate',
    category: 'video',
    label: 'Generate video',
    keywords: ['video', 'text to video', 'image to video', 'generate', 'model', 'last frame', 'end frame', 'first frame', 'seedance', 'kling', 'veo', 'wan'],
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      { id: 'first_frame', type: 'image' },
      // The end frame only exists where the chosen model takes one (limitBy / limitsFor): the input then takes no connection.
      { id: 'last_frame', type: 'image', multiple: true, max: MAX_VIDEO_LAST_FRAMES, limitBy: { param: 'model', capability: 'last_frame' } },
      { id: 'refs', type: 'image', multiple: true, max: MAX_SEEDANCE_REFS, limitBy: { param: 'model', capability: 'references' } },
      { id: 'ref_videos', type: 'video', multiple: true, max: MAX_SEEDANCE_MEDIA_REFS, limitBy: { param: 'model', capability: 'videos' } },
      { id: 'ref_audios', type: 'audio', multiple: true, max: MAX_SEEDANCE_MEDIA_REFS, limitBy: { param: 'model', capability: 'audio' } }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      VIDEO_MODEL_PARAM,
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'duration', kind: 'integer', min: 1, max: 30, default: 5 },
      { id: 'aspect_ratio', kind: 'select', options: tools.VIDEO_RATIOS, default: '16:9', showIf: { port: 'first_frame', connected: false } },
      { id: 'resolution', kind: 'select', options: VIDEO_RESOLUTIONS, default: 'auto' }
    ],
    paid: true,
    async: true,
    // the price depends on the model, the duration and the resolution: the plan reads it from the model list (the estimate
    // of the chat), never from the last video of the type
    cost: { unit: 'usd', estimate: videoGenerateEstimate, history: false },
    available: openRouterAvailable,
    limitsFor: videoGenerateLimits,
    prepare: () => videoNodeModels.load(),
    validate: (params, ports) => {
      const issues = [];
      if (ports.refs?.count > MAX_SEEDANCE_REFS) issues.push(`refs: at most ${MAX_SEEDANCE_REFS} references are allowed`);
      if (ports.ref_videos?.count > MAX_SEEDANCE_MEDIA_REFS) issues.push(`ref_videos: at most ${MAX_SEEDANCE_MEDIA_REFS} are allowed`);
      if (ports.ref_audios?.count > MAX_SEEDANCE_MEDIA_REFS) issues.push(`ref_audios: at most ${MAX_SEEDANCE_MEDIA_REFS} are allowed`);
      if (ports.last_frame?.count > MAX_VIDEO_LAST_FRAMES) issues.push(`last_frame: at most ${MAX_VIDEO_LAST_FRAMES} end frame is allowed`);
      // against the model chosen in the node, while the model list is known (execute() checks again with the model it really
      // uses, which is also the configured one when nothing is chosen)
      const chosen = String(params.model || '').trim();
      if (chosen) {
        issues.push(...videoFitIssues(chosen, params, {
          first: ports.first_frame?.count || 0,
          last: ports.last_frame?.count || 0,
          refs: ports.refs?.count || 0,
          videos: ports.ref_videos?.count || 0,
          audios: ports.ref_audios?.count || 0
        }));
      } else if (ports.last_frame?.connected && !ports.first_frame?.connected) {
        issues.push({ code: 'VIDEO_LAST_FRAME_NEEDS_FIRST', port: 'last_frame', message: 'last_frame: an end frame needs a first frame (connect first_frame)' });
      }
      // With a first or last frame the provider treats the job as image to video and may ignore the reference images.
      if ((ports.first_frame?.connected || ports.last_frame?.connected) && ports.refs?.connected) {
        issues.push({ level: 'warning', code: 'VIDEO_FRAMES_PRECEDE_REFS', port: 'refs', message: 'refs: with a first or last frame the provider may ignore the reference images' });
      }
      if ((ports.ref_videos?.connected || ports.ref_audios?.connected) && !publicBaseUrlSet()) {
        issues.push({ level: 'warning', code: 'public_base_url', message: 'Video and audio references need PUBLIC_BASE_URL (image references work without it)' });
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      if (ctx.signal?.aborted) throw jobs.abortError();
      const model = videoModelOf(ctx, params);
      await videoNodeModels.load();
      const last = itemsOf(inputs, 'last_frame');
      const refs = itemsOf(inputs, 'refs');
      const refVideos = itemsOf(inputs, 'ref_videos');
      const refAudios = itemsOf(inputs, 'ref_audios');
      limitCheck(last, MAX_VIDEO_LAST_FRAMES, 'last_frame');
      limitCheck(refs, MAX_SEEDANCE_REFS, 'refs');
      limitCheck(refVideos, MAX_SEEDANCE_MEDIA_REFS, 'ref_videos');
      limitCheck(refAudios, MAX_SEEDANCE_MEDIA_REFS, 'ref_audios');
      // the model really used: refused before anything is submitted (the tool layer skips its own check in the node view)
      const problem = videoFitIssues(model, params, {
        first: inputs.first_frame ? 1 : 0,
        last: last.length,
        refs: refs.length,
        videos: refVideos.length,
        audios: refAudios.length
      }, { run: true })[0];
      if (problem) throw imageError(problem.code, problem.message, problem.data);

      const wanted = { duration: params.duration, resolution: params.resolution, aspectRatio: params.aspect_ratio, firstFrame: Boolean(inputs.first_frame), refVideos: refVideos.length > 0 };
      const used = videoNodeModels.settings(model, wanted);
      const priced = videoNodeModels.estimate(model, wanted);
      // what the job remembers of the choice (name, estimate), and what a participant's budget reserves
      const toolCtx = { ...ctx.toolCtx, config: { ...ctx.toolCtx.config, videoModel: model }, videoOption: priced ? priced.option : { id: model, name: videoNodeModels.displayName(model) } };
      if (priced) toolCtx.videoEstimateUsd = priced.option.estimateUsd;

      const args = {
        prompt: inputs.prompt.value,
        duration_seconds: used.known ? used.duration : params.duration,
        reference_asset_ids: sessionAssetIds(ctx, refs),
        reference_video_asset_ids: sessionAssetIds(ctx, refVideos),
        reference_audio_asset_ids: sessionAssetIds(ctx, refAudios)
      };
      const resolution = used.known ? used.resolution : params.resolution !== 'auto' ? params.resolution : '';
      if (resolution) args.resolution = resolution;
      if (inputs.first_frame) {
        args.mode = 'image_to_video';
        args.first_frame_asset_id = sessionAssetIds(ctx, [inputs.first_frame])[0];
        if (last.length) args.last_frame_asset_id = sessionAssetIds(ctx, last)[0];
      } else {
        args.mode = 'text_to_video';
        args.aspect_ratio = params.aspect_ratio;
      }
      const outcome = await tools.executeTool(toolCtx, 'generate_video', args);
      for (const note of outcome.corrections || []) ctx.log(note);
      const ids = await ctx.waitForJob(outcome.job);
      const value = await assets.valueFromAsset(ctx.sessionId, ids[0]);
      // The poller stores the provider cost in the ledger when the job completes.
      return { variants: [{ video: value }], cost: usdCost([await assets.ledgerCosts(ctx.sessionId, ids)]) };
    }
  },
  higgsfieldGenerationDefinition('video'),
  {
    type: 'video.motion_graphics',
    category: 'video',
    label: 'Motion graphics from HTML (render node)',
    keywords: ['motion', 'graphics', 'html', 'gsap', 'title', 'render', 'hyperframes', 'lower third'],
    description: 'Use {{asset:1}} ... {{asset:10}} in the HTML to reference the connected assets by their file names.',
    inputs: [
      { id: 'html', type: 'text', required: true, param: 'html', suggest: 'llm.motion_html' },
      { id: 'assets', type: 'any', multiple: true, max: MAX_MOTION_ASSETS }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'html', kind: 'code', default: '', inline: true },
      { id: 'format', kind: 'select', options: ['landscape', 'portrait', 'square'], default: 'landscape' },
      { id: 'quality', kind: 'select', options: ['draft', 'standard', 'high'], default: 'standard' },
      { id: 'label', kind: 'text', default: '' }
    ],
    async: true,
    cost: { unit: 'local' },
    available: () => (rendernode.enabled() ? true : 'No render node configured'),
    validate: (params, ports) => {
      const issues = [];
      if (ports.assets?.count > MAX_MOTION_ASSETS) issues.push(`assets: at most ${MAX_MOTION_ASSETS} assets are allowed`);
      // Only the inline field is checked here; HTML from a connected port arrives at run time (tools.js checks it then).
      const problem = !ports.html?.connected && String(params.html || '').trim() ? motionHtml.checkComposition(params.html, params.format) : null;
      // Free text is not HTML at all: the placeholder hint would be misleading (and, as the first issue of the node,
      // would hide the not_html cause and its remedy on the card).
      if (!ports.html?.connected && !ports.assets?.connected && problem?.code !== 'not_html' && HAS_MOTION_PLACEHOLDER.test(params.html)) {
        issues.push({ code: 'invalid_param', message: 'html uses {{asset:N}} placeholders but no assets are connected' });
      }
      if (!ports.html?.connected && String(params.html || '').trim()) {
        if (problem?.code === 'not_html') {
          issues.push({
            code: 'not_html',
            port: 'html',
            data: { format: problem.format, width: problem.width, height: problem.height },
            message:
              'html: this field expects the HTML code of a motion-graphics composition, not an instruction. ' +
              'To join videos use the Concatenate videos node; to create an animation from a description use the Motion HTML writer node in front of this one.'
          });
        } else if (problem) {
          issues.push({
            code: 'composition_size',
            port: 'html',
            data: { format: problem.format, width: problem.width, height: problem.height, foundWidth: problem.foundWidth || '?', foundHeight: problem.foundHeight || '?' },
            message:
              `html: the composition root element needs data-width="${problem.width}" and data-height="${problem.height}" for format ${problem.format} ` +
              `(found ${problem.foundWidth || '?'}x${problem.foundHeight || '?'})`
          });
        }
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const attached = itemsOf(inputs, 'assets');
      limitCheck(attached, MAX_MOTION_ASSETS, 'assets');
      requireMedia(attached, 'assets');
      const assetIds = sessionAssetIds(ctx, attached);
      const html = replaceAssetPlaceholders(inputs.html.value, attached);
      const outcome = await tools.executeTool(ctx.toolCtx, 'render_motion_graphics', {
        html,
        label: params.label.trim() || 'Motion graphics',
        quality: params.quality,
        format: params.format,
        asset_ids: assetIds
      });
      const values = await valuesFromJob(ctx, outcome);
      return { variants: [{ video: values[0] }] };
    }
  },
  {
    type: 'video.concat',
    category: 'video',
    label: 'Concatenate videos',
    keywords: ['concat', 'join', 'merge', 'combine', 'sequence', 'video', 'ffmpeg'],
    inputs: [{ id: 'clips', type: 'video', required: true, multiple: true, min: MIN_CONCAT_CLIPS, max: MAX_CONCAT_CLIPS }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [{ id: 'label', kind: 'text', default: '' }],
    cost: { unit: 'local' },
    available: ffmpegAvailable,
    validate: (_params, ports) =>
      ports.clips?.count > MAX_CONCAT_CLIPS ? [`clips: at most ${MAX_CONCAT_CLIPS} clips are allowed`] : [],
    // Edge order = playback order (a connected video[] keeps its own order).
    execute: async (ctx, inputs, params) => {
      const clips = itemsOf(inputs, 'clips');
      if (clips.length < MIN_CONCAT_CLIPS) throw new Error(`clips: connect at least ${MIN_CONCAT_CLIPS} videos (got ${clips.length})`);
      limitCheck(clips, MAX_CONCAT_CLIPS, 'clips');
      const args = { asset_ids: sessionAssetIds(ctx, clips), label: params.label.trim() || undefined };
      const outcome = await ctx.withLocalSlot(() => tools.executeTool(ctx.toolCtx, 'concat_videos', args));
      if (!outcome?.asset) throw new Error('concat_videos returned no asset');
      if (outcome.alphaLost) ctx.log?.('The transparency is lost: this ffmpeg cannot read and write VP9 with an alpha channel (libvpx-vp9, libopus)');
      return { variants: [{ video: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }] };
    }
  }
];

/* ---------- audio ---------- */

// Music: the video that sets the length, rounded up to whole seconds and kept within what the API takes.
function matchedSeconds(duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('match: the length of the video could not be determined');
  return Math.min(MUSIC_MAX_SECONDS, Math.max(MUSIC_MIN_SECONDS, Math.ceil(duration)));
}

// A plan from the field or the connection counts as present when it holds text.
function planPresent(params, ports) {
  return Boolean(ports.plan?.connected) || Boolean(String(params.plan || '').trim());
}

// The price of a music node in USD where it is known before the run: from the plan in the field, else from `length`.
// A plan or a video that arrives through a connection has no length yet: unknown, never 0 (the plan then says "unknown").
function musicEstimate(params, context) {
  const connected = context?.connected || new Set();
  if (connected.has('plan')) return null;
  const planText = String(params.plan || '').trim();
  if (planText) {
    const lengthMs = musicPlan.lengthOfText(planText);
    return lengthMs ? tools.musicEstimateUsd(lengthMs) : null;
  }
  if (connected.has('match')) return null;
  return tools.musicEstimateUsd(Number(params.length) * 1000);
}

const MUSIC_MODEL_PARAM = { id: 'model', kind: 'select', options: musicPlan.MODELS, default: musicPlan.DEFAULT_MODEL };

const audioDefinitions = [
  {
    type: 'audio.tts',
    category: 'audio',
    provider: 'elevenlabs',
    label: 'Text to speech (ElevenLabs)',
    keywords: ['tts', 'speech', 'voice', 'elevenlabs', 'narration', 'voiceover', 'audio'],
    inputs: [{ id: 'text', type: 'text', required: true, param: 'text' }],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'text', kind: 'textarea', default: '', inline: true },
      { id: 'voice_id', kind: 'select', optionsSource: 'elevenlabs-voices', default: tools.DEFAULT_ELEVENLABS_VOICE_ID },
      // noDefaultEntry: the node names its model itself (Eleven v4), the list has no entry for "default". The value is never checked
      // against the list, so a model saved in an older workflow keeps running and stays selectable.
      { id: 'model_id', kind: 'select', optionsSource: 'elevenlabs-tts-models', default: tools.DEFAULT_ELEVENLABS_MODEL_ID, noDefaultEntry: true }
    ],
    // Billed per character, at a price that depends on the model (estimate ELEVENLABS_USD_PER_1K_CHARS, see tools.js). A text
    // that arrives through a connection has no length yet: the price is unknown then, not a guess from an earlier run.
    paid: true,
    cost: {
      unit: 'usd',
      history: false,
      estimate: (params, context) => (context?.connected?.has('text') ? null : tools.speechEstimateUsd(params.text, params.model_id))
    },
    available: () => (elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set'),
    validate: (params, ports) =>
      !ports.text?.connected && [...params.text].length > TTS_MAX_CHARS ? [`text: at most ${TTS_MAX_CHARS} characters are allowed`] : [],
    execute: async (ctx, inputs, params) => {
      const text = inputs.text.value;
      if ([...text].length > TTS_MAX_CHARS) throw new Error(`text: at most ${TTS_MAX_CHARS} characters are allowed`);
      const outcome = await tools.executeTool(ctx.toolCtx, 'generate_speech', {
        text,
        voice_id: params.voice_id.trim() || undefined,
        model_id: params.model_id.trim() || undefined
      });
      if (!outcome?.asset) throw new Error('generate_speech returned no asset');
      return {
        variants: [{ audio: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }],
        cost: usdCost([typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null])
      };
    }
  },
  {
    type: 'audio.music',
    category: 'audio',
    provider: 'elevenlabs',
    label: 'Generate music (ElevenLabs)',
    keywords: ['music', 'song', 'soundtrack', 'jingle', 'lyrics', 'background music', 'instrumental', 'elevenlabs', 'audio'],
    description:
      'Music from a description, or from a song text with structure (the plan). With a plan the length comes from its sections and ' +
      '"length" and "instrumental" have no effect. Without a plan a connected video sets the length (rounded up, 3 to 600 s), else "length" does. ' +
      'Price: an estimate by the minute (ELEVENLABS_MUSIC_USD_PER_MIN). Needs a paid ElevenLabs plan.',
    inputs: [
      { id: 'prompt', type: 'text', param: 'prompt' },
      { id: 'plan', type: 'text', param: 'plan' },
      { id: 'match', type: 'video' }
    ],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'plan', kind: 'textarea', default: '' },
      // Hidden where they have no effect: a plan (in the field or through a connection) sets length and vocals, a connected video the length.
      { id: 'length', kind: 'integer', min: MUSIC_MIN_SECONDS, max: MUSIC_MAX_SECONDS, default: 30, inline: true, showIf: { all: [{ ports: ['plan', 'match'], connected: false }, { param: 'plan', empty: true }] } },
      { id: 'instrumental', kind: 'boolean', default: false, showIf: { all: [{ port: 'plan', connected: false }, { param: 'plan', empty: true }] } },
      MUSIC_MODEL_PARAM
    ],
    paid: true,
    // The length through a connection (plan or video) is not known before the run: no guess from an earlier result.
    cost: { unit: 'usd', history: false, estimate: musicEstimate },
    available: () => (elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set'),
    validate: (params, ports) => {
      const issues = [];
      const hasPlan = planPresent(params, ports);
      const hasPrompt = Boolean(ports.prompt?.connected) || Boolean(String(params.prompt || '').trim());
      if (!hasPlan && !hasPrompt) {
        issues.push({ code: 'MUSIC_SOURCE_MISSING', port: 'prompt', message: 'prompt: describe the music, or connect or write a plan' });
      }
      // A plan in the field is checked now; one that arrives through a connection is checked when the run reaches it.
      if (!ports.plan?.connected && String(params.plan || '').trim()) {
        const problem = musicPlan.parse(params.plan, { model: params.model }).errors[0];
        if (problem) issues.push({ code: problem.code, port: 'plan', data: problem.data, message: `plan: ${problem.message}` });
      }
      if (hasPlan && (hasPrompt || params.instrumental || ports.match?.connected)) {
        issues.push({ level: 'warning', code: 'MUSIC_PLAN_WINS', message: 'A plan is present: the description, length, instrumental and the connected video have no effect.' });
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const planText = inputs.plan ? String(inputs.plan.value || '').trim() : '';
      let args;
      if (planText) {
        args = { plan_text: planText, model_id: params.model };
      } else {
        const prompt = inputs.prompt ? String(inputs.prompt.value || '').trim() : '';
        if (!prompt) throw musicError('MUSIC_SOURCE_MISSING', 'prompt: describe the music, or connect or write a plan');
        let seconds = params.length;
        if (inputs.match) {
          seconds = matchedSeconds((await probeSource(ctx, inputs.match)).duration);
          ctx.log(`Length of the video: ${seconds} s`);
        }
        args = { prompt, length_seconds: seconds, instrumental: params.instrumental, model_id: params.model };
      }
      const outcome = await tools.executeTool(ctx.toolCtx, 'generate_music', args);
      if (!outcome?.asset) throw new Error('generate_music returned no asset');
      return {
        variants: [{ audio: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }],
        cost: usdCost([typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null])
      };
    }
  },
  {
    type: 'audio.music_plan',
    category: 'audio',
    provider: 'elevenlabs',
    label: 'Song text and structure (ElevenLabs)',
    keywords: ['song', 'lyrics', 'songtext', 'verse', 'chorus', 'structure', 'plan', 'music', 'elevenlabs', 'text'],
    description:
      'Writes a song text with sections from an idea, in a readable format you can edit (+ wanted styles, - unwanted styles, ' +
      '[Section | 20 s], then the song lines). Connect it to the plan input of "Generate music". ElevenLabs does not charge credits for it.',
    inputs: [{ id: 'prompt', type: 'text', required: true, param: 'prompt' }],
    outputs: [{ id: 'plan', type: 'text' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'length', kind: 'integer', min: MUSIC_MIN_SECONDS, max: MUSIC_MAX_SECONDS, default: 60, inline: true },
      MUSIC_MODEL_PARAM
    ],
    // Not paid, but not local either: ElevenLabs is called, free of credits (it counts against the limits of the plan).
    cost: { unit: 'free' },
    available: () => (elevenlabs.hasKey() ? true : 'ELEVENLABS_API_KEY is not set'),
    execute: async (ctx, inputs, params) => {
      const outcome = await tools.executeTool(ctx.toolCtx, 'plan_music', {
        prompt: inputs.prompt.value,
        length_seconds: params.length,
        model_id: params.model
      });
      if (!outcome?.planText) throw new Error('plan_music returned no plan');
      return { variants: [{ plan: textValue(outcome.planText) }] };
    }
  }
];

/* ---------- Higgsfield edit tools (experimental, SPEC §5.8) ---------- */

// The sources reach Higgsfield by URL (PUBLIC_BASE_URL) or, without it, by media_upload: no server address needed.
function higgsfieldEditAvailable({ needsFfmpeg = false } = {}) {
  return () => {
    const connected = higgsfieldAvailable();
    if (connected !== true) return connected;
    return needsFfmpeg ? ffmpegAvailable() : true;
  };
}

// Submits one edit job for its source values (one, or image + video for motion control) and returns the result values.
async function runHiggsfieldEditNode(ctx, { tool, kind, sources, toolParams }) {
  const outcome = await tools.executeTool(ctx.toolCtx, 'higgsfield_edit', {
    tool,
    kind,
    source_asset_ids: sessionAssetIds(ctx, sources),
    params: toolParams
  });
  return valuesFromJob(ctx, outcome);
}

// Width, height and duration of a source (ffprobe works on stills, too).
async function probeSource(ctx, value) {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('ffmpeg/ffprobe not found');
  const probe = await ctx.withLocalSlot(() => ffmpeg.probeVideo(assets.assetFilePath(value), { ffprobePath: binaries.ffprobe }));
  return { width: probe.video.width, height: probe.video.height, duration: probe.duration };
}

const HIGGSFIELD_OUTPAINT_RATIOS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'];
const HIGGSFIELD_REFRAME_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'];

const higgsfieldEditDefinitions = [
  {
    type: 'hf.remove_background',
    category: 'higgsfield',
    label: 'Remove background (Higgsfield)',
    keywords: ['higgsfield', 'background', 'remove', 'cutout', 'transparent', 'matte'],
    inputs: [{ id: 'media', type: 'image', required: true }],
    outputs: [{ id: 'media', type: 'image' }],
    params: [{ id: 'kind', kind: 'select', options: ['image', 'video'], default: 'image', inline: true }],
    portVariants: {
      param: 'kind',
      values: {
        image: { inputs: [{ id: 'media', type: 'image', required: true }], outputs: [{ id: 'media', type: 'image' }] },
        video: { inputs: [{ id: 'media', type: 'video', required: true }], outputs: [{ id: 'media', type: 'video' }] }
      }
    },
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable(),
    execute: async (ctx, inputs, params) => {
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'remove_background',
        kind: params.kind,
        sources: [inputs.media],
        toolParams: {}
      });
      return { variants: [{ media: values[0] }] };
    }
  },
  {
    type: 'hf.upscale_image',
    category: 'higgsfield',
    label: 'Upscale image (Higgsfield)',
    keywords: ['higgsfield', 'upscale', 'enhance', 'resolution', '4k', '2k', 'image'],
    inputs: [{ id: 'image', type: 'image', required: true }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [{ id: 'resolution', kind: 'select', options: ['2k', '4k'], default: '4k', inline: true }],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable({ needsFfmpeg: true }),
    execute: async (ctx, inputs, params) => {
      const { width, height } = await probeSource(ctx, inputs.image);
      if (!width || !height) throw new Error('The image size could not be determined');
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'upscale_image',
        kind: 'image',
        sources: [inputs.image],
        toolParams: { provider: 'bytedance', width, height, resolution: params.resolution }
      });
      return { variants: [{ image: values[0] }] };
    }
  },
  {
    type: 'hf.upscale_video',
    category: 'higgsfield',
    label: 'Upscale video (Higgsfield)',
    keywords: ['higgsfield', 'upscale', 'enhance', 'topaz', 'bytedance', 'resolution', 'video'],
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'provider', kind: 'select', options: ['topaz', 'bytedance'], default: 'topaz' },
      { id: 'resolution', kind: 'select', options: ['1080p', '2k', '4k'], default: '1080p', inline: true }
    ],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable({ needsFfmpeg: true }),
    validate: (params) =>
      params.provider === 'topaz' && params.resolution === '2k'
        ? [{ code: 'invalid_param', message: 'resolution: Topaz supports 1080p and 4k only' }]
        : [],
    execute: async (ctx, inputs, params) => {
      let toolParams;
      if (params.provider === 'topaz') {
        if (params.resolution === '2k') throw new Error('resolution: Topaz supports 1080p and 4k only');
        toolParams = { provider: 'topaz', resolution: params.resolution === '4k' ? '2160p' : '1080p' };
      } else {
        const { width, height } = await probeSource(ctx, inputs.video);
        if (!width || !height) throw new Error('The video size could not be determined');
        toolParams = { provider: 'bytedance', width, height, resolution: params.resolution };
      }
      const values = await runHiggsfieldEditNode(ctx, { tool: 'upscale_video', kind: 'video', sources: [inputs.video], toolParams });
      return { variants: [{ video: values[0] }] };
    }
  },
  {
    type: 'hf.outpaint_image',
    category: 'higgsfield',
    label: 'Outpaint image (Higgsfield)',
    keywords: ['higgsfield', 'outpaint', 'extend', 'uncrop', 'canvas', 'aspect ratio', 'image'],
    inputs: [{ id: 'image', type: 'image', required: true }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [{ id: 'aspect_ratio', kind: 'select', options: HIGGSFIELD_OUTPAINT_RATIOS, default: '16:9', inline: true }],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable(),
    execute: async (ctx, inputs, params) => {
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'outpaint_image',
        kind: 'image',
        sources: [inputs.image],
        toolParams: { aspect_ratio: params.aspect_ratio }
      });
      return { variants: [{ image: values[0] }] };
    }
  },
  {
    type: 'hf.reframe_video',
    category: 'higgsfield',
    label: 'Reframe video (Higgsfield)',
    keywords: ['higgsfield', 'reframe', 'aspect ratio', 'vertical', 'expand', 'video'],
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'aspect_ratio', kind: 'select', options: HIGGSFIELD_REFRAME_RATIOS, default: '9:16', inline: true },
      { id: 'resolution', kind: 'select', options: ['480p', '720p', '1080p'], default: '720p' }
    ],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable({ needsFfmpeg: true }),
    execute: async (ctx, inputs, params) => {
      const toolParams = { aspect_ratio: params.aspect_ratio, resolution: params.resolution };
      // Sources over 15 s need their duration (the tool accepts up to 60 s).
      const seconds = Number.isFinite(inputs.video.duration) ? inputs.video.duration : (await probeSource(ctx, inputs.video)).duration;
      if (seconds > REFRAME_MAX_SECONDS) throw new Error(`The source video is ${Math.round(seconds)} s long; reframe supports up to ${REFRAME_MAX_SECONDS} s`);
      if (seconds > REFRAME_LONG_VIDEO_SECONDS) toolParams.duration_seconds = Math.ceil(seconds);
      const values = await runHiggsfieldEditNode(ctx, { tool: 'reframe', kind: 'video', sources: [inputs.video], toolParams });
      return { variants: [{ video: values[0] }] };
    }
  }
];

/* ---------- Higgsfield lip sync, voice change, motion transfer and speech (phase 2c, experimental) ---------- */

// The voice of the voice nodes: "<voice_type>:<voice_id>" from the voices option list, or a manually typed
// voice id (`voice_custom`) that wins over the list. A bare id counts as a preset voice; "element:<id>" selects an
// own voice. Returns null when neither is set.
function parseVoiceParam(selected, custom) {
  const raw = String(custom || '').trim() || String(selected || '').trim();
  if (!raw) return null;
  const match = /^(preset|element):(.*)$/i.exec(raw);
  const voiceId = (match ? match[2] : raw).trim();
  return voiceId ? { voiceType: match ? match[1].toLowerCase() : 'preset', voiceId } : null;
}

const VOICE_PARAMS = [
  { id: 'voice', kind: 'select', optionsSource: 'higgsfield-voices', default: '' },
  // Fallback for a voice list that cannot be loaded (or a voice that is not in it); wins over `voice`.
  { id: 'voice_custom', kind: 'text', default: '' }
];
const VOICE_REQUIRED = { code: 'invalid_param', message: 'voice: select a voice or enter a voice ID' };

function speechModelId(params) {
  return String(params.model || '').trim() || tools.HIGGSFIELD_DEFAULT_AUDIO_MODEL;
}

function speechCreditEstimate(params) {
  const model = higgsfieldCatalog.peekModel(speechModelId(params));
  const credits = model ? higgsfieldCatalog.creditsFor(model, {}) : null;
  return credits === null ? null : { credits };
}

const higgsfieldVoiceDefinitions = [
  {
    type: 'hf.dubbing',
    category: 'higgsfield',
    label: 'Dub with lip sync (Higgsfield)',
    keywords: ['higgsfield', 'dubbing', 'dub', 'translate', 'lip sync', 'lipsync', 'language', 'localize', 'video'],
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
    params: [{ id: 'target_language', kind: 'select', options: tools.HIGGSFIELD_DUBBING_LANGUAGES, default: 'eng', inline: true }],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable(),
    execute: async (ctx, inputs, params) => {
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'dubbing',
        kind: 'video',
        sources: [inputs.video],
        toolParams: { target_language: params.target_language }
      });
      return { variants: [{ video: values[0] }] };
    }
  },
  {
    type: 'hf.voice_change',
    category: 'higgsfield',
    label: 'Change voice (Higgsfield)',
    keywords: ['higgsfield', 'voice', 'change', 'revoice', 'swap', 'speaker', 'video'],
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
    params: VOICE_PARAMS,
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable(),
    validate: (params) => (parseVoiceParam(params.voice, params.voice_custom) ? [] : [VOICE_REQUIRED]),
    execute: async (ctx, inputs, params) => {
      const voice = parseVoiceParam(params.voice, params.voice_custom);
      if (!voice) throw new Error(VOICE_REQUIRED.message);
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'voice_change',
        kind: 'video',
        sources: [inputs.video],
        toolParams: { voice_id: voice.voiceId, voice_type: voice.voiceType }
      });
      return { variants: [{ video: values[0] }] };
    }
  },
  {
    type: 'hf.motion_control',
    category: 'higgsfield',
    label: 'Motion transfer (Higgsfield)',
    keywords: ['higgsfield', 'motion', 'transfer', 'control', 'kling', 'puppeteer', 'recast', 'character', 'animate'],
    description: 'Animates the character image with the movement of the motion video (Kling 3.0 Motion Control).',
    inputs: [
      { id: 'image', type: 'image', required: true },
      { id: 'motion', type: 'video', required: true }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'resolution', kind: 'select', options: tools.HIGGSFIELD_MOTION_RESOLUTIONS, default: '720p', inline: true },
      { id: 'scene_control', kind: 'select', options: tools.HIGGSFIELD_SCENE_CONTROLS, default: 'image' }
    ],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits' },
    available: higgsfieldEditAvailable(),
    execute: async (ctx, inputs, params) => {
      const values = await runHiggsfieldEditNode(ctx, {
        tool: 'motion_control',
        kind: 'video',
        sources: [inputs.image, inputs.motion],
        toolParams: { resolution: params.resolution, scene_control: params.scene_control }
      });
      return { variants: [{ video: values[0] }] };
    }
  },
  {
    type: 'hf.speech',
    category: 'higgsfield',
    label: 'Speech (Higgsfield)',
    keywords: ['higgsfield', 'speech', 'tts', 'voice', 'voiceover', 'narration', 'seed audio', 'audio'],
    description:
      'Text to speech with seed_audio (default) or text2speech_v2. seed_audio also takes up to two reference audios ' +
      '(a voice or a reference is required); text2speech_v2 needs a voice and a variant in extra_params. ' +
      'The result is WAV (default) or mp3 (extra_params format); pcm and ogg_opus cannot be used.',
    inputs: [
      { id: 'text', type: 'text', required: true, param: 'text' },
      { id: 'reference_audio', type: 'audio', multiple: true, max: tools.HIGGSFIELD_MAX_SPEECH_REFS }
    ],
    // text2speech_v2 takes no reference audio: the input accepts no connection with it (a fixed list of models, so
    // portVariants is enough; the models of the catalogue use limitBy).
    portVariants: {
      param: 'model',
      values: {
        text2speech_v2: {
          inputs: [
            { id: 'text', type: 'text', required: true, param: 'text' },
            { id: 'reference_audio', type: 'audio', multiple: true, max: 0 }
          ]
        }
      }
    },
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'text', kind: 'textarea', default: '', inline: true },
      ...VOICE_PARAMS,
      { id: 'model', kind: 'select', options: tools.HIGGSFIELD_SPEECH_MODELS, default: tools.HIGGSFIELD_DEFAULT_AUDIO_MODEL },
      { id: 'extra_params', kind: 'code', default: '{}', dynamic: 'higgsfield-model' }
    ],
    experimental: true,
    paid: true,
    async: true,
    cost: { unit: 'credits', estimate: speechCreditEstimate },
    available: higgsfieldAvailable,
    validate: (params, ports) => {
      const issues = extraParamsIssues(params.extra_params);
      const extra = issues.length ? {} : parseExtraParams(params.extra_params);
      const voice = parseVoiceParam(params.voice, params.voice_custom);
      const references = ports.reference_audio;
      const invalid = (message, port) => issues.push({ code: 'invalid_param', ...(port ? { port } : {}), message });
      if (extra.format !== undefined && !tools.HIGGSFIELD_SPEECH_FORMATS.includes(extra.format)) {
        invalid(`extra_params.format: only ${tools.HIGGSFIELD_SPEECH_FORMATS.join(' or ')} can be used (pcm and ogg_opus are not supported)`);
      }
      if (speechModelId(params) === 'text2speech_v2') {
        if (!tools.HIGGSFIELD_SPEECH_VARIANTS.includes(extra.variant)) {
          invalid(`extra_params.variant: text2speech_v2 needs one of ${tools.HIGGSFIELD_SPEECH_VARIANTS.join(', ')}`);
        }
        if (references?.connected) invalid('reference_audio: text2speech_v2 takes no reference audio (use seed_audio)', 'reference_audio');
        if (!voice) issues.push(VOICE_REQUIRED);
      } else {
        // A reference audio can stand in for the voice (unverified: the API documents 0..2 references next to a voice).
        if (!voice && !references?.connected) issues.push(VOICE_REQUIRED);
        if (references?.count > tools.HIGGSFIELD_MAX_SPEECH_REFS) {
          invalid(`reference_audio: at most ${tools.HIGGSFIELD_MAX_SPEECH_REFS} reference audios are allowed`, 'reference_audio');
        }
      }
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const voice = parseVoiceParam(params.voice, params.voice_custom);
      const references = itemsOf(inputs, 'reference_audio');
      limitCheck(references, tools.HIGGSFIELD_MAX_SPEECH_REFS, 'reference_audio');
      if (!voice && !references.length) throw new Error(VOICE_REQUIRED.message);
      const extra = parseExtraParams(params.extra_params);
      const modelId = speechModelId(params);
      const model = await lookupModel(modelId);
      if (references.length && model && !tools.audioRoleFromModel(model)) {
        throw new Error(`Model ${modelId} declares no audio input; disconnect reference_audio or pick another model`);
      }
      const outcome = await tools.executeTool(ctx.toolCtx, 'higgsfield_speech', {
        model: modelId,
        prompt: inputs.text.value,
        voice_type: voice ? voice.voiceType : undefined,
        voice_id: voice ? voice.voiceId : undefined,
        reference_audio_asset_ids: references.length ? sessionAssetIds(ctx, references) : undefined,
        extra_params: Object.keys(extra).length ? extra : undefined
      });
      for (const note of outcome.corrections || []) ctx.log(note);
      const values = await valuesFromJob(ctx, outcome);
      const credits = model ? higgsfieldCatalog.creditsFor(model, {}) : null;
      return { variants: [{ audio: values[0] }], cost: credits === null ? undefined : { credits } };
    }
  }
];

const definitions = [
  ...llmDefinitions,
  ...imageDefinitions,
  higgsfieldGenerationDefinition('image'),
  ...videoDefinitions,
  ...audioDefinitions,
  ...higgsfieldEditDefinitions,
  ...higgsfieldVoiceDefinitions
];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  definitions,
  registerAll,
  buildRelightPrompt,
  parseVoiceParam,
  parseExtraParams,
  replaceAssetPlaceholders,
  stripCodeFence,
  enhancerSystem,
  describerSystem,
  motionSystem,
  collectVariants,
  // shared with the music video nodes (nodes-music-video.js) and the explainer nodes (nodes-explainer.js)
  askModel,
  usdCost,
  llmAvailable,
  openRouterAvailable,
  itemsOf,
  MODEL_PARAM,
  LANGUAGES
};
