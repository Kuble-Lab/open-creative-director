'use strict';

// Generative node types (SPEC §5.3 LLM, §5.4 image, §5.5 video, §5.6 audio, §5.8 experimental Higgsfield edits,
// phase 2c: Higgsfield dubbing, voice change, motion control and speech).
// Every executor is a thin adapter over an existing function: tools.executeTool (lib/tools.js), the LLM adapter
// (lib/nodes/llm.js) or the Higgsfield catalogue. Assets are ordinary ledger assets of the workflow's backing
// session; costs are journaled by the underlying tools and only reported back to the engine.

const path = require('path');

const tools = require('../tools');
const motionHtml = require('../../public/nodes/motion-html');
const store = require('../store');
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

// One completion; a blank model falls back to the configured default brain.
function askModel(ctx, params, options) {
  const model = String(params.model || '').trim() || ctx.config?.defaultBrain || '';
  return llm.completeText({ model, sessionId: ctx.sessionId, user: ctx.user, ...options });
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
async function imageFromTool(ctx, name, args) {
  const outcome = await tools.executeTool(ctx.toolCtx, name, args);
  if (!outcome?.asset) throw new Error('The image tool returned no asset');
  return {
    value: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id),
    usd: typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null
  };
}

function imageVariants(results) {
  return {
    variants: results.map((result) => ({ image: result.value })),
    cost: usdCost(results.map((result) => result.usd))
  };
}

const COUNT_PARAM = { id: 'count', kind: 'integer', min: 1, max: 4, default: 1 };

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
    label: 'Generate image (GPT Image 2)',
    keywords: ['gpt', 'image', 'text to image', 'generate', 'openai', 'picture'],
    inputs: [{ id: 'prompt', type: 'text', required: true, param: 'prompt' }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'aspect_ratio', kind: 'select', options: tools.IMAGE_RATIOS, default: '1:1' },
      COUNT_PARAM
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: openRouterAvailable,
    execute: async (ctx, inputs, params) => {
      const args = { prompt: inputs.prompt.value, aspect_ratio: params.aspect_ratio };
      return imageVariants(await collectVariants(ctx, params.count, () => imageFromTool(ctx, 'generate_image', args)));
    }
  },
  {
    type: 'image.edit',
    category: 'image',
    label: 'Edit image (GPT Image 2)',
    keywords: ['gpt', 'image', 'edit', 'reference', 'image to image', 'openai', 'restyle'],
    inputs: [
      { id: 'prompt', type: 'text', required: true, param: 'prompt' },
      { id: 'images', type: 'image', required: true, multiple: true, max: MAX_EDIT_IMAGES }
    ],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'aspect_ratio', kind: 'select', options: ['auto', ...tools.IMAGE_RATIOS], default: 'auto' },
      COUNT_PARAM
    ],
    paid: true,
    cost: { unit: 'usd' },
    available: openRouterAvailable,
    validate: (_params, ports) =>
      ports.images?.count > MAX_EDIT_IMAGES ? [`images: at most ${MAX_EDIT_IMAGES} images are allowed`] : [],
    execute: async (ctx, inputs, params) => {
      const images = itemsOf(inputs, 'images');
      if (!images.length) throw new Error('images: connect at least one image');
      limitCheck(images, MAX_EDIT_IMAGES, 'images');
      const args = { prompt: inputs.prompt.value, reference_asset_ids: sessionAssetIds(ctx, images) };
      if (params.aspect_ratio && params.aspect_ratio !== 'auto') args.aspect_ratio = params.aspect_ratio;
      return imageVariants(await collectVariants(ctx, params.count, () => imageFromTool(ctx, 'edit_image', args)));
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
      { id: 'refs', type: 'image', multiple: true, max: MAX_HIGGSFIELD_REFS },
      // Only for models that declare an audio media role (checked before anything is submitted); the API wants an
      // image or video reference next to the audio. How many tracks a model takes comes from the catalogue.
      ...(isVideo ? [{ id: 'audio', type: 'audio', multiple: true, max: tools.HIGGSFIELD_MAX_AUDIO_REFS }] : [])
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
    validate: (params, ports) => {
      const issues = [];
      if (!params.model.trim()) issues.push({ code: 'invalid_param', message: 'model: select a Higgsfield model' });
      issues.push(...extraParamsIssues(params.extra_params));
      if (ports.refs?.count > MAX_HIGGSFIELD_REFS) issues.push(`refs: at most ${MAX_HIGGSFIELD_REFS} references are allowed`);
      if (isVideo && ports.audio?.connected) {
        if (ports.audio.count > tools.HIGGSFIELD_MAX_AUDIO_REFS) issues.push(`audio: at most ${tools.HIGGSFIELD_MAX_AUDIO_REFS} audio tracks are allowed`);
        if (!ports.refs?.connected) issues.push({ code: 'invalid_param', port: 'audio', message: AUDIO_NEEDS_REFS });
        // Only knowable while the model is in the catalogue cache; execute() and the tool check again before submitting.
        const cached = params.model.trim() ? higgsfieldCatalog.peekModel(params.model) : null;
        const slot = cached ? tools.audioSlotFromModel(cached) : null;
        if (cached && !slot) {
          issues.push({ code: 'invalid_param', port: 'audio', message: `audio: model ${params.model} declares no audio input` });
        } else if (slot && slot.max !== null && ports.audio.count > slot.max) {
          issues.push({ code: 'invalid_param', port: 'audio', message: `audio: model ${params.model} accepts at most ${slot.max} audio tracks` });
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
        const slots = higgsfieldCatalog.referenceSlots(model);
        if (refs.length > slots.max) throw new Error(`Model ${params.model} accepts at most ${slots.max} reference images (got ${refs.length})`);
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
  higgsfieldGenerationDefinition('video'),
  {
    type: 'video.motion_graphics',
    category: 'video',
    label: 'Motion graphics (render node)',
    keywords: ['motion', 'graphics', 'html', 'gsap', 'title', 'render', 'hyperframes', 'lower third'],
    description: 'Use {{asset:1}} ... {{asset:10}} in the HTML to reference the connected assets by their file names.',
    inputs: [
      { id: 'html', type: 'text', required: true, param: 'html' },
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
    inputs: [{ id: 'clips', type: 'video', required: true, multiple: true, max: MAX_CONCAT_CLIPS }],
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
      return { variants: [{ video: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }] };
    }
  }
];

/* ---------- audio ---------- */

const audioDefinitions = [
  {
    type: 'audio.tts',
    category: 'audio',
    label: 'Text to speech (ElevenLabs)',
    keywords: ['tts', 'speech', 'voice', 'elevenlabs', 'narration', 'voiceover', 'audio'],
    inputs: [{ id: 'text', type: 'text', required: true, param: 'text' }],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'text', kind: 'textarea', default: '', inline: true },
      { id: 'voice_id', kind: 'select', optionsSource: 'elevenlabs-voices', default: tools.DEFAULT_ELEVENLABS_VOICE_ID },
      { id: 'model_id', kind: 'text', default: tools.DEFAULT_ELEVENLABS_MODEL_ID }
    ],
    cost: { unit: 'local' },
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
      return { variants: [{ audio: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }] };
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
  collectVariants
};
