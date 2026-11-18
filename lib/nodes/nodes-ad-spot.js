'use strict';

// Nodes for the advertising spot ("Story spot", lib/ad-spot-plan.js):
//   ad.plan        brief / brand / product photos -> the script of the spot (hook, problem, product, benefit, end card), the prompts of the
//                  first frames and of the motions, the shots for the cut, the voice-over and the music (paid by tokens)
//   ad.music       the music of the spot: instrumental music of the exact length (ElevenLabs) or a sung jingle (Suno, the person's own
//                  account); which one follows from what the plan hands on (the switch "Music" of ad.plan)
//   ad.soundtrack  voice and music mixed to the exact length of the film, the music ducked under the voice (local, free)
//   ad.endcard     the end card with logo, claim and call to action in the brand's colours and fonts (render node, free)
// The clips are cut by "Cut to the beat" (music_video.edit): the shots of the plan are its story clips, the end card its still clip.

const path = require('path');

const tools = require('../tools');
const elevenlabs = require('../elevenlabs');
const rendernode = require('../rendernode');
const ffmpeg = require('../ffmpeg');
const or = require('../openrouter');
const languageLib = require('../language-detect');
const planLib = require('../ad-spot-plan');
const endcardLib = require('../ad-spot-endcard');
const sceneLib = require('../explainer-scene');
const explainerPlan = require('../explainer-plan');
const assets = require('./assets');
const generate = require('./nodes-generate');
const explainerNodes = require('./nodes-explainer');
const explainerVideoNodes = require('./nodes-explainer-video');
const sunoNodes = require('./nodes-suno');
const editNodes = require('./nodes-edit');
const { textValue, listValue } = require('./types');

const { askModel, usdCost, llmAvailable, itemsOf, imageDataUrls, MODEL_PARAM, MUSIC_MODEL_PARAM } = generate;

// The planner of the spot writes with Claude Fable 5.2 when the node names no model (like the planner of the HUD music video).
const AD_DEFAULT_MODEL = 'anthropic/claude-fable-5.2';
const PLAN_MAX_TOKENS = 8000;
const MAX_PRODUCT_IMAGES = 4;
const AUTO_LANGUAGE = 'auto';
const LANGUAGE_OPTIONS = [AUTO_LANGUAGE, ...planLib.LANGUAGES];
const LANGUAGE_LABELS = { de: 'German', en: 'English', es: 'Spanish' };

const textOf = (inputs, portId) => (inputs[portId] ? String(inputs[portId].value || '') : '');

function adError(code, message, data) {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

/* ---------- ad.plan ---------- */

// The language of the spot: the one chosen, else the one of the brief (lib/language-detect.js, no model call), else the interface language.
function spotLanguage(ctx, requested, brief) {
  if (requested !== AUTO_LANGUAGE) return requested;
  const found = languageLib.resolveLanguage([{ id: 'brief', text: brief }], { fallback: ctx.uiLang });
  ctx.log?.(`Language: ${LANGUAGE_LABELS[found.language]} (${found.source ? 'from the brief' : 'no hint in the brief: interface language'})`);
  return found.language;
}

function planEstimate(params, context) {
  if (String(params.script || '').trim()) return { usd: 0 };
  const named = String(params.model || '').trim();
  const model = named || AD_DEFAULT_MODEL;
  const restricted = context?.config?.restrictedBrainModels || [];
  // a participant whose list lacks the default, or an installation without OpenRouter, gets another model whose price is not known here
  if (!named && ((restricted.length && !restricted.includes(AD_DEFAULT_MODEL)) || !or.hasKey())) return null;
  const inputs = context?.inputs || {};
  const connected = context?.connected || new Set();
  for (const port of ['brief', 'brand']) if (connected.has(port) && !inputs[port]) return null;
  const textChars = String(inputs.brief?.value ?? params.brief ?? '').length + String(inputs.brand?.value ?? '').length;
  const images = connected.has('product') ? (inputs.product ? itemsOf(inputs, 'product').length : 1) : 0;
  const usd = planLib.estimateUsd({ price: explainerPlan.PRICES_PER_MILLION[model], textChars, productImages: Math.min(images, MAX_PRODUCT_IMAGES) });
  return usd === null ? null : { usd };
}

// The outputs the plan leaves empty: the music description with a jingle (or without music), the song pack without a jingle. The node
// "Spot music" behind them reads which one arrived: that is the switch between instrumental music and the jingle.
function planEmptyOutputs(params) {
  if (params.music === 'jingle') return ['music_prompt'];
  if (params.music === 'none') return ['music_prompt', 'jingle_pack'];
  return ['jingle_pack'];
}

// `ask` is the call of the language model (askModel); a test gives a double.
function createPlanDefinition({ ask = askModel } = {}) {
  return {
    type: 'ad.plan',
    category: 'llm',
    provider: 'llm',
    label: 'Plan advertising spot',
    keywords: ['ad', 'advertising', 'spot', 'commercial', 'werbung', 'werbespot', 'storyboard', 'plan', 'hook', 'claim', 'jingle', 'product', 'llm'],
    description:
      'Plans an advertising spot of 6 to 60 seconds from a brief, your branding and (optional) photos of the product: a hook in the first two seconds, ' +
      'the problem, the product, the benefit and an end card with claim and call to action. Outputs: the script (JSON, can be edited and fed back in ' +
      'without another model call), a storyboard to read, a first-frame prompt and a motion for every shot, the shots for "Cut to the beat", the ' +
      'voice-over text, and either the description of the instrumental music or the song pack of a sung jingle (the switch "Music"). The times of ' +
      'the shots always add up to the chosen length. Paid by tokens.',
    inputs: [
      { id: 'brief', type: 'text', required: true, param: 'brief' },
      { id: 'brand', type: 'text' },
      { id: 'product', type: 'image', multiple: true, max: MAX_PRODUCT_IMAGES }
    ],
    outputs: [
      { id: 'script', type: 'text' },
      { id: 'storyboard', type: 'text' },
      { id: 'image_prompts', type: 'text[]' },
      { id: 'motion_prompts', type: 'text[]' },
      { id: 'shots', type: 'text' },
      { id: 'voiceover', type: 'text' },
      { id: 'music_prompt', type: 'text' },
      { id: 'jingle_pack', type: 'text' }
    ],
    params: [
      MODEL_PARAM,
      { id: 'brief', kind: 'textarea', default: '', inline: true },
      { id: 'length_seconds', kind: 'integer', min: planLib.LIMITS.minLengthSeconds, max: planLib.LIMITS.maxLengthSeconds, default: planLib.LIMITS.defaultLengthSeconds, inline: true },
      { id: 'format', kind: 'select', options: Object.keys(planLib.FORMATS), default: 'landscape' },
      { id: 'language', kind: 'select', options: LANGUAGE_OPTIONS, default: AUTO_LANGUAGE },
      { id: 'tone', kind: 'select', options: planLib.TONES, default: 'bold' },
      { id: 'music', kind: 'select', options: planLib.MUSIC_MODES, default: 'instrumental', inline: true },
      { id: 'script', kind: 'textarea', default: '' }
    ],
    paid: true,
    emptyOutputs: planEmptyOutputs,
    emptyOutputsSwitched: true,
    // The model of the settings when OpenRouter is missing, and the interface language where "auto" finds no hint in the brief: neither is a
    // parameter, so both are part of the key then.
    cacheStamp: async (params, ctx) => {
      const stamp = { ...(explainerNodes.fallbackBrainStamp(params, ctx) || {}) };
      if (params.language === AUTO_LANGUAGE && !String(params.script || '').trim()) {
        const brief = String(ctx.inputs?.brief?.value ?? params.brief ?? '');
        const found = languageLib.resolveLanguage([{ id: 'brief', text: brief }], { fallback: ctx.uiLang });
        if (!found.source && found.language !== 'en') stamp.fallbackLanguage = found.language;
      }
      return Object.keys(stamp).length ? stamp : undefined;
    },
    cacheStampAdopts: true,
    // history: false: a price from an earlier run says nothing about the next brief
    cost: { unit: 'usd', estimate: planEstimate, history: false },
    available: llmAvailable,
    validate: (params, ports) => {
      const issues = [];
      const script = String(params.script || '').trim();
      if (script) {
        const parsed = planLib.parseScriptText(script, { lengthSeconds: params.length_seconds, format: params.format, music: params.music });
        if (parsed.error) issues.push({ code: 'AD_SCRIPT_INVALID', port: null, message: `script: ${parsed.error}` });
        else if (parsed.script.music !== params.music) {
          issues.push({ code: 'AD_SCRIPT_MUSIC', port: null, data: { planned: parsed.script.music, chosen: params.music }, message: `script: this script was planned with the music "${parsed.script.music}" but "Music" is set to "${params.music}". Set "Music" to "${parsed.script.music}", or empty the script and plan again.` });
        }
      } else if (!ports.brief?.connected && !String(params.brief || '').trim()) {
        issues.push({ code: 'AD_NO_BRIEF', port: 'brief', message: 'brief: say what the spot is for: the product, who it is for and what should stay in mind' });
      }
      if (ports.product?.count > MAX_PRODUCT_IMAGES) issues.push(`product: at most ${MAX_PRODUCT_IMAGES} photos are allowed`);
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      const brief = textOf(inputs, 'brief').trim();
      const brandText = textOf(inputs, 'brand').trim();
      let brand = null;
      if (brandText) {
        brand = parseJson(brandText);
        if (!brand) ctx.log('The brand input is not a JSON profile: it is ignored');
      }
      const products = itemsOf(inputs, 'product').slice(0, MAX_PRODUCT_IMAGES);
      const edited = String(params.script || '').trim();
      const costs = [];
      let script;
      if (edited) {
        const parsed = planLib.parseScriptText(edited, { lengthSeconds: params.length_seconds, format: params.format, music: params.music, tone: params.tone });
        if (parsed.error) throw adError('AD_SCRIPT_INVALID', `script: ${parsed.error}`);
        if (parsed.script.music !== params.music) {
          throw adError('AD_SCRIPT_MUSIC', `script: this script was planned with the music "${parsed.script.music}" but "Music" is set to "${params.music}". Set "Music" to "${parsed.script.music}", or empty the script and plan again.`, { planned: parsed.script.music, chosen: params.music });
        }
        script = parsed.script;
        ctx.log('The script of the parameter "script" is checked and used: no model call, no cost');
        if (script.length_seconds !== params.length_seconds || script.format !== params.format) ctx.log(`The script keeps its own length and format (${script.length_seconds} s, ${script.format})`);
      } else {
        if (!brief) throw adError('AD_NO_BRIEF', 'brief: say what the spot is for: the product, who it is for and what should stay in mind');
        const settings = {
          lengthSeconds: params.length_seconds,
          format: params.format,
          language: spotLanguage(ctx, params.language, brief),
          tone: params.tone,
          music: params.music,
          productImages: products.length
        };
        const model = explainerNodes.chooseModel(ctx, params, AD_DEFAULT_MODEL);
        const images = products.length ? await imageDataUrls(ctx, products) : [];
        const system = planLib.systemPrompt(settings);
        let built = null;
        let previous = '';
        let problems = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await ask(ctx, { ...params, model }, {
            system,
            prompt: planLib.userPrompt({ brief, brand, previous, problems }),
            images,
            json: true,
            maxTokens: PLAN_MAX_TOKENS
          });
          costs.push(result.usd);
          const next = planLib.buildScript(planLib.parseJsonAnswer(result.text), settings);
          // a usable script of an earlier attempt is better than an unusable later one
          if (next.script || !built) built = next.script ? next : built || next;
          if (!next.hasErrors) break;
          const errors = next.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
          if (attempt === 0) {
            ctx.log(`The plan had ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}: asking once more (${errors.slice(0, 2).join(' ').slice(0, 200)})`);
            previous = result.text;
            problems = errors;
          } else if (next.script) ctx.log(`Still ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} after the repair; corrected by the node where possible`);
        }
        if (!built || !built.script) throw adError('AD_PLAN_INVALID', `The model did not deliver a usable plan: ${(built?.issues || []).map((issue) => issue.message).join(' ').slice(0, 300)}`);
        script = built.script;
        // what the film cannot do without, even after the repair
        if (!script.voiceover.text) throw adError('AD_PLAN_INVALID', 'The model wrote neither a voice-over nor a claim. Run the node again.');
        if (script.music === 'jingle' && !script.jingle?.lyrics) throw adError('AD_PLAN_INVALID', 'The model did not write the jingle. Run the node again or set "Music" to instrumental.');
      }
      for (const warning of script.warnings.slice(0, 5)) ctx.log(`Note: ${warning}`);
      const lists = planLib.outputsOf(script, { productImages: products.length });
      ctx.log(`${script.shots.length} shots and an end card of ${script.endcard.seconds} s, ${script.length_seconds} s in all, voice-over ${script.voiceover.words} of ${script.voiceover.budget} words, music: ${script.music}`);
      const variant = {
        script: textValue(JSON.stringify(script, null, 2)),
        storyboard: textValue(lists.storyboard),
        image_prompts: listValue('text', lists.imagePrompts.map(textValue)),
        motion_prompts: listValue('text', lists.motionPrompts.map(textValue)),
        shots: textValue(JSON.stringify(lists.shots, null, 2))
      };
      if (lists.voiceover) variant.voiceover = textValue(lists.voiceover);
      if (lists.musicPrompt) variant.music_prompt = textValue(lists.musicPrompt);
      if (lists.jinglePack) variant.jingle_pack = textValue(lists.jinglePack);
      return { variants: [variant], cost: costs.length ? usdCost(costs) : { usd: 0 } };
    }
  };
}

/* ---------- ad.music ---------- */

const MUSIC_MIN_SECONDS = 3;

function musicSeconds(params, inputs) {
  const planned = inputs?.shots ? parseJson(textOf(inputs, 'shots')) : null;
  const seconds = Number(planned?.duration) > 0 ? Number(planned.duration) : Number(params.length);
  return Math.max(MUSIC_MIN_SECONDS, Math.ceil(seconds));
}

function createMusicDefinition({ makeSongs = sunoNodes.createSongMaker() } = {}) {
  return {
    type: 'ad.music',
    category: 'audio',
    // the paid way is ElevenLabs music; the jingle runs on the user's own Suno account and costs nothing here
    provider: 'elevenlabs',
    label: 'Spot music',
    // not the plain words "music" and "jingle": those find the general music node first
    keywords: ['advertising spot', 'ad', 'commercial', 'ad music', 'ad jingle', 'instrumental', 'suno', 'elevenlabs', 'soundtrack'],
    description:
      'Makes the music of an advertising spot, one of two ways, depending on what "Plan advertising spot" hands on. A description of the music ' +
      '(input "prompt"): instrumental music of exactly the length of the film with ElevenLabs (an estimate by the minute, needs a paid ElevenLabs ' +
      'plan). A song pack (input "pack"): a sung jingle with Suno through YOUR OWN Suno account (account menu → Suno → Connect; Suno bills its ' +
      'credits, the app charges nothing; the song is longer than the spot, "Sound of the spot" takes its beginning). Neither: no music, the ' +
      'output stays empty.',
    inputs: [
      { id: 'prompt', type: 'text' },
      { id: 'pack', type: 'text' },
      { id: 'shots', type: 'text' }
    ],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [
      { id: 'length', kind: 'integer', min: MUSIC_MIN_SECONDS, max: 120, default: 15, showIf: { port: 'shots', connected: false } },
      MUSIC_MODEL_PARAM,
      { id: 'version', kind: 'integer', min: 1, max: 99, default: 1 },
      { id: 'allow_download_credit', kind: 'boolean', default: true }
    ],
    paid: true,
    timeoutMs: sunoNodes.TIMEOUT_MS,
    // The way (and so the price) is known once the plan has run: instrumental by the minute, a jingle is billed by Suno to the person.
    cost: {
      unit: 'usd',
      history: false,
      estimate: (params, context) => {
        const inputs = context?.inputs || {};
        const connected = context?.connected || new Set();
        if (String(inputs.pack?.value || '').trim()) return { usd: 0 };
        if (String(inputs.prompt?.value || '').trim()) return tools.musicEstimateUsd(musicSeconds(params, inputs) * 1000);
        // nothing has arrived yet: a plan that has not run (unknown), or a plan without music (free)
        return connected.has('prompt') || connected.has('pack') ? null : { usd: 0 };
      }
    },
    validate: (_params, ports) =>
      ports.prompt?.connected || ports.pack?.connected ? [] : [{ code: 'AD_MUSIC_SOURCE', port: 'prompt', message: 'Connect the music description or the jingle pack of "Plan advertising spot"' }],
    execute: async (ctx, inputs, params) => {
      const pack = textOf(inputs, 'pack').trim();
      const prompt = textOf(inputs, 'prompt').trim();
      if (pack) {
        ctx.log('A song pack arrived: the jingle is made with Suno through your own account');
        const songs = await makeSongs(ctx, pack, { takes: 1, version: params.version, allow_download_credit: params.allow_download_credit === true });
        return { variants: songs.map((song) => ({ audio: song.audio })), cost: { usd: 0 } };
      }
      if (!prompt) {
        ctx.log('Neither a music description nor a jingle pack arrived: the spot has no music');
        return { variants: [{}], cost: { usd: 0 } };
      }
      if (!elevenlabs.hasKey()) throw adError('AD_MUSIC_NO_ELEVENLABS', 'ELEVENLABS_API_KEY is not set: instrumental music is made with ElevenLabs. Set "Music" in "Plan advertising spot" to jingle or none, or set up ElevenLabs.');
      const seconds = musicSeconds(params, inputs);
      ctx.log(`Instrumental music of ${seconds} s with ElevenLabs`);
      const outcome = await tools.executeTool(ctx.toolCtx, 'generate_music', { prompt, length_seconds: seconds, instrumental: true, model_id: params.model });
      if (!outcome?.asset) throw new Error('generate_music returned no asset');
      return {
        variants: [{ audio: await assets.valueFromAsset(ctx.sessionId, outcome.asset.id) }],
        cost: usdCost([typeof outcome.asset.cost === 'number' ? outcome.asset.cost : null])
      };
    }
  };
}

/* ---------- ad.soundtrack ---------- */

const soundtrackDefinition = {
  type: 'ad.soundtrack',
  category: 'edit-audio',
  label: 'Sound of the spot',
  keywords: ['sound', 'soundtrack', 'mix', 'voice', 'music', 'ducking', 'spot', 'ad', 'audio', 'ffmpeg'],
  description:
    'Mixes the voice and the music of an advertising spot to the exact length of the film: the music is cut to the length and faded out, the ' +
    'voice starts where the plan says (a jingle spot: on the end card) and the music gets quieter while the voice speaks. A voice that is a ' +
    'little too long is sped up by at most 15 %. Without voice and music the result is silence of the right length. Connect it to the song ' +
    'input of "Cut to the beat". Local and free.',
  inputs: [
    { id: 'shots', type: 'text', required: true },
    { id: 'voice', type: 'audio' },
    { id: 'music', type: 'audio' }
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'music_volume', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, inline: true },
    { id: 'voice_volume', kind: 'slider', min: 0, max: 2, step: 0.05, default: 1 },
    { id: 'ducking', kind: 'boolean', default: true },
    { id: 'fade_out', kind: 'number', min: 0, max: 10, default: 0.8 }
  ],
  cost: { unit: 'local' },
  available: () => (ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found'),
  execute: async (ctx, inputs, params) => {
    const plan = planLib.soundPlan(textOf(inputs, 'shots'));
    const files = [];
    const at = {};
    for (const id of ['voice', 'music']) {
      if (!inputs[id]) continue;
      at[id] = files.length;
      files.push(assets.assetFilePath(inputs[id]));
    }
    if (!files.length) ctx.log('No voice and no music arrived: the sound is silence');
    const [audio] = await editNodes.runOp(ctx, {
      label: 'Sound of the spot',
      files,
      build: (infos) => {
        for (const id of Object.keys(at)) if (!infos[at[id]]?.audio) throw new Error(`${id} has no audio stream`);
        const track = (id) => (at[id] === undefined ? null : { index: at[id], duration: infos[at[id]].duration });
        // a jingle is the foreground until the closing line: it plays louder than music under a voice-over
        const built = planLib.soundGraph({
          duration: plan.duration,
          voiceAt: plan.voiceAt,
          voice: track('voice'),
          music: track('music'),
          musicVolume: plan.music === 'jingle' ? Math.max(params.music_volume, 0.9) : params.music_volume,
          voiceVolume: params.voice_volume,
          ducking: params.ducking,
          fadeOut: params.fade_out
        });
        return { graph: built.graph, outputs: [{ kind: 'audio' }], notes: built.notes };
      }
    });
    return { variants: [{ audio }] };
  }
};

/* ---------- ad.endcard ---------- */

const ENDCARD_FORMATS = ['auto', ...Object.keys(planLib.FORMATS)];

const endcardDefinition = {
  type: 'ad.endcard',
  // with the other nodes that finish a film (the HUD render, the cuts): a step of the spot, not a general way from a text to a video
  category: 'edit-video',
  label: 'Spot end card',
  keywords: ['end card', 'endcard', 'outro', 'claim', 'logo', 'call to action', 'cta', 'packshot', 'spot', 'ad', 'motion', 'render', 'hyperframes'],
  description:
    'Renders the end card of an advertising spot on the render node: the logo of the branding (or its name), the claim word by word, the call to ' +
    'action and the web address, in the colours and fonts of the brand, exactly as long as the plan says. The card is written by the app, not by ' +
    'a model: the words are those of the script. Connect it to the input "still_clips" of "Cut to the beat". Free.',
  inputs: [
    { id: 'script', type: 'text', required: true },
    { id: 'brand', type: 'text' },
    { id: 'logo', type: 'image' }
  ],
  outputs: [{ id: 'video', type: 'video' }],
  params: [
    { id: 'format', kind: 'select', options: ENDCARD_FORMATS, default: 'auto' },
    { id: 'quality', kind: 'select', options: ['draft', 'standard', 'high'], default: 'standard' }
  ],
  async: true,
  cost: { unit: 'local' },
  available: () => (rendernode.enabled() ? true : 'No render node configured'),
  execute: async (ctx, inputs, params) => {
    const script = parseJson(textOf(inputs, 'script'));
    const card = script && script.kind === 'ad-spot' && script.endcard && typeof script.endcard === 'object' ? script.endcard : null;
    if (!card) throw adError('AD_SCRIPT_INVALID', 'script: connect the output "Script" of "Plan advertising spot"');
    const brandText = textOf(inputs, 'brand').trim();
    const brand = brandText ? parseJson(brandText) : null;
    if (brandText && !brand) ctx.log('The brand input is not a JSON profile: the neutral look is used');
    const logo = inputs.logo || null;
    if (logo && logo.sessionId !== ctx.sessionId) throw new Error(`Asset ${logo.assetId} belongs to another session`);
    const format = params.format !== 'auto' ? params.format : Object.prototype.hasOwnProperty.call(planLib.FORMATS, script.format) ? script.format : 'landscape';
    const duration = Math.min(15, Math.max(1, Number(card.seconds) || 3));
    const tokens = sceneLib.brandTokens(brand && brand.neutral !== true ? brand : null);
    let html = endcardLib.endcardHtml({ format, duration, tokens, claim: card.claim, cta: card.cta, url: card.url, name: brand && brand.neutral !== true ? brand.name : '', logo: Boolean(logo) });
    // the fonts of the brand (the files of the branding): left out where the document would get too large for the render node
    const fonts = sceneLib.fontFaces(await explainerVideoNodes.brandFonts(ctx, brand, (line) => ctx.log(line)));
    for (const line of fonts.skipped) ctx.log(`font: ${line}: the system font is used`);
    const embedded = sceneLib.embedFontsWithin(html, fonts.css);
    if (embedded.dropped) ctx.log('The fonts of the brand make the card too large for the render node: the system font is used');
    html = embedded.html;
    if (logo) html = html.replace(/\{\{asset:1\}\}/g, () => `${logo.assetId}${path.extname(logo.file)}`);
    const outcome = await tools.executeTool(ctx.toolCtx, 'render_motion_graphics', { html, label: 'End card', quality: params.quality, format, asset_ids: logo ? [logo.assetId] : [] });
    if (!outcome?.job) throw new Error('The tool did not start a job');
    const ids = await ctx.waitForJob(outcome.job);
    ctx.log(`End card of ${duration} s (${format})${logo ? ' with the logo' : ''}: ${[card.claim, card.cta, card.url].filter(Boolean).join(' · ')}`);
    return { variants: [{ video: await assets.valueFromAsset(ctx.sessionId, ids[0]) }] };
  }
};

const definitions = [createPlanDefinition(), createMusicDefinition(), soundtrackDefinition, endcardDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = { definitions, registerAll, createPlanDefinition, createMusicDefinition, soundtrackDefinition, endcardDefinition, planEstimate, planEmptyOutputs, AD_DEFAULT_MODEL, MAX_PRODUCT_IMAGES };
