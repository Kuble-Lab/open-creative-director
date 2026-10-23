'use strict';

const magnific = require('../magnific');
const catalog = require('./magnific-catalog');
const tools = require('../tools');
const assets = require('./assets');

const available = () => magnific.status().connected ? true : 'Magnific is not connected';
const num = (value) => Number(value);
const text = (value) => String(value ?? '').trim();
const AZIMUTHS = ['-135', '-90', '-45', '0', '45', '90', '135', '180'];
const ELEVATIONS = ['-90', '-45', '0', '45', '90'];
const EXPAND_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];

// One table row per Magnific tool that takes one session asset and returns new media. Argument names follow the
// live MCP schema (2026-10-22, docs/magnific-mcp-tools.md); the tool validates them again before any spend.
// args(params) holds the fixed arguments; the session asset goes in as `field`, extra ports as their argument.
const MEDIA_NODES = [
  { type: 'magnific.remove_background', tool: 'images_remove_background', label: 'Magnific Remove Background', port: 'image',
    description: 'Cut out the subject of an image onto a transparent PNG.', keywords: ['background', 'cutout', 'transparent', 'freistellen'],
    params: [], args: () => ({}) },
  { type: 'magnific.replace_background', tool: 'images_replace_background', label: 'Magnific Replace Background', port: 'image',
    description: 'Keep the subject and place it on a new background (prompt or backdrop image), relit to match.', keywords: ['background', 'replace', 'composite'],
    extra: [{ id: 'background', type: 'image', arg: 'backgroundCreationIdentifier' }],
    params: [{ id: 'prompt', kind: 'textarea', default: '', inline: true }],
    args: (p) => (text(p.prompt) ? { prompt: text(p.prompt).slice(0, 2000) } : {}),
    validate: (p, connected) => (text(p.prompt) || connected?.background?.connected ? [] : [{ code: 'magnific_background', message: 'Describe the new background or connect a backdrop image.' }]) },
  { type: 'magnific.relight', tool: 'images_relight', label: 'Magnific Relight', port: 'image',
    description: 'Relight an image with one light from the chosen direction.', keywords: ['relight', 'light', 'lighting', 'licht'],
    params: [
      { id: 'azimuth', kind: 'select', options: AZIMUTHS, default: '45' },
      { id: 'elevation', kind: 'select', options: ELEVATIONS, default: '45' },
      { id: 'intensity', kind: 'integer', min: 1, max: 10, default: 5 },
      { id: 'light_type', kind: 'select', options: ['neutral', 'gel'], default: 'neutral' },
      { id: 'color', kind: 'color', default: '#ffffff', showIf: { param: 'light_type', equals: 'gel' } },
      { id: 'resolution', kind: 'select', options: ['2k', '1k'], default: '2k' }
    ],
    args: (p) => ({ resolution: p.resolution, lights: [{ azimuth: num(p.azimuth), elevation: num(p.elevation), intensity: num(p.intensity),
      type: p.light_type, ...(p.light_type === 'gel' ? { color: p.color } : {}) }] }) },
  { type: 'magnific.expand', tool: 'images_expand', label: 'Magnific Expand', port: 'image',
    description: 'Outpaint an image to a new aspect ratio; the original stays and new surroundings are generated.', keywords: ['expand', 'outpaint', 'aspect', 'erweitern'],
    params: [
      { id: 'aspect_ratio', kind: 'select', options: EXPAND_RATIOS, default: '16:9' },
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'model', kind: 'select', options: ['auto', 'ideogram', 'flux', 'classic'], default: 'auto' }
    ],
    args: (p) => ({ aspectRatio: p.aspect_ratio, ...(text(p.prompt) ? { prompt: text(p.prompt) } : {}), ...(p.model && p.model !== 'auto' ? { mode: p.model } : {}) }) },
  { type: 'magnific.reimagine', tool: 'images_reimagine', label: 'Magnific Reimagine', port: 'image',
    description: 'Re-render an image with the same composition; strength sets how far it drifts.', keywords: ['reimagine', 'variation', 'rerender'],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'strength', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.6 },
      { id: 'model', kind: 'select', options: ['flux', 'fast', 'imagen-nano-banana'], default: 'flux' }
    ],
    args: (p) => ({ strength: num(p.strength), mode: p.model, ...(text(p.prompt) ? { prompt: text(p.prompt) } : {}) }) },
  { type: 'magnific.change_camera', tool: 'images_change_camera', label: 'Magnific Change Camera', port: 'image',
    description: 'Reframe the camera around the subject: rotate, tilt and zoom.', keywords: ['camera', 'angle', 'perspective', 'kamera'],
    params: [
      { id: 'rotate', kind: 'integer', min: 0, max: 360, default: 45 },
      { id: 'vertical', kind: 'integer', min: -30, max: 90, default: 0 },
      { id: 'closeup', kind: 'integer', min: 0, max: 10, default: 5 }
    ],
    args: (p) => ({ rotate: num(p.rotate), vertical: num(p.vertical), closeup: num(p.closeup) }) },
  { type: 'magnific.skin_enhancer', tool: 'images_skin_enhancer', label: 'Magnific Skin Enhancer', port: 'image',
    description: 'Natural skin detail for portraits; faithful keeps the identity.', keywords: ['skin', 'portrait', 'retouch', 'haut'],
    params: [
      { id: 'version', kind: 'select', options: ['faithful', 'creative', 'flexible'], default: 'faithful' },
      { id: 'sharpen', kind: 'integer', min: 0, max: 100, default: 0 },
      { id: 'smart_grain', kind: 'integer', min: 0, max: 100, default: 0 }
    ],
    args: (p) => ({ version: p.version, sharpen: num(p.sharpen), smartGrain: num(p.smart_grain) }) },
  { type: 'magnific.restyle', tool: 'images_restyle', label: 'Magnific Restyle', port: 'image',
    description: 'Re-render an image in the look of a style image; subject and layout stay.', keywords: ['restyle', 'style', 'look', 'stil'],
    extra: [{ id: 'style', type: 'image', arg: 'styleCreationIdentifier', required: true }],
    params: [], args: () => ({}) },
  { type: 'magnific.to_svg', tool: 'images_to_svg', label: 'Magnific Vectorize', port: 'image',
    description: 'Trace a raster image into an SVG vector.', keywords: ['svg', 'vector', 'vectorize', 'trace'],
    params: [], args: () => ({}) },
  { type: 'magnific.video_upscale', tool: 'video_upscale', label: 'Magnific Video Upscale', port: 'video', timeoutMs: 30 * 60 * 1000,
    description: 'Upscale a video with Magnific (creative or precision) to the chosen width.', keywords: ['video', 'upscale', 'resolution', '4k'],
    params: [
      { id: 'mode', kind: 'select', options: ['magnific', 'magnific_precision'], default: 'magnific_precision' },
      { id: 'target_width', kind: 'select', options: ['1280', '1920', '2560', '3840'], default: '1920' }
    ],
    args: (p) => ({ mode: p.mode, targetResolution: num(p.target_width) }) },
  { type: 'magnific.video_hdr', tool: 'video_hdr', label: 'Magnific Video HDR', port: 'video', timeoutMs: 30 * 60 * 1000,
    description: 'Convert an SDR video to HDR (Topaz Hyperion); resolution and frame rate stay.', keywords: ['video', 'hdr', 'color'],
    params: [], args: () => ({}) },
  { type: 'magnific.video_remove_background', tool: 'video_remove_background', label: 'Magnific Video Remove Background', port: 'video', timeoutMs: 30 * 60 * 1000,
    description: 'Cut the subject out of a clip (max 20 s): transparent WebM or MP4 on a colour.', keywords: ['video', 'background', 'cutout', 'alpha'],
    params: [
      { id: 'output', kind: 'select', options: ['webm', 'mp4'], default: 'webm' },
      { id: 'background', kind: 'color', default: '#00ff00', showIf: { param: 'output', equals: 'mp4' } },
      { id: 'model', kind: 'select', options: ['General Use (Light)', 'General Use (Heavy)', 'Matting', 'Portrait'], default: 'General Use (Light)' }
    ],
    args: (p) => (p.output === 'mp4'
      ? { videoOutputType: 'X264 (.mp4)', backgroundColor: p.background, model: p.model }
      : { videoOutputType: 'VP9 (.webm)', backgroundColor: 'transparent', model: p.model }) },
  // the lip sync of a clip to its slice of the song: Seedance takes the audio only as a guide, this puts the mouth on the exact words
  { type: 'magnific.lipsync', tool: 'video_speak', label: 'Magnific Lip Sync', port: 'video', field: 'videoUrl', timeoutMs: 30 * 60 * 1000,
    description: 'Sync the lips of a clip to an audio track (a slice of the song or a voice): the mouth follows the exact words, the rest of the picture stays. The clip should be at least as long as the audio.',
    keywords: ['lipsync', 'lip sync', 'lippensynchron', 'mouth', 'singing', 'video'],
    extra: [{ id: 'audio', type: 'audio', arg: 'audioUrl', required: true }],
    params: [{ id: 'model', kind: 'select', options: ['lipsync-2.0', 'veed-sync-2-v2v', 'latentsync'], default: 'lipsync-2.0' }],
    args: (p) => ({ mode: p.model }) },
  { type: 'magnific.clean_speech', tool: 'audio_clean_speech', label: 'Magnific Clean Speech', port: 'audio', field: 'audioUrl',
    description: 'Remove background noise from a speech recording and normalize loudness.', keywords: ['audio', 'speech', 'denoise', 'voice'],
    params: [{ id: 'target_lufs', kind: 'integer', min: -40, max: -8, default: -19 }],
    args: (p) => ({ targetLufs: num(p.target_lufs) }) }
];

function registerMedia(registry, spec) {
  const field = spec.field || 'creationIdentifier';
  const extra = spec.extra || [];
  const build = async function media(params, creationId, ids = {}) {
    const args = { ...spec.args(params), [field]: creationId };
    for (const port of extra) if (ids[port.id]) args[port.arg] = ids[port.id];
    return { tool: spec.tool, args };
  };
  const price = catalog.estimator(spec.port, build, extra.map((p) => p.id));
  registry.register({
    type: spec.type, category: 'magnific', provider: 'magnific', label: spec.label,
    description: `${spec.description} Billed in Magnific credits.`, keywords: ['magnific', ...spec.keywords],
    inputs: [{ id: spec.port, type: spec.port, required: true }, ...extra.map((p) => ({ id: p.id, type: p.type, required: Boolean(p.required) }))],
    outputs: [{ id: spec.port, type: spec.port }], params: spec.params,
    paid: true, async: true, timeoutMs: spec.timeoutMs || 11 * 60 * 1000, cost: { unit: 'credits', history: false, estimate: price.estimate },
    available, validate: spec.validate, cacheStamp: price.prepareEstimate,
    execute: async (ctx, inputs, params) => {
      const main = inputs[spec.port];
      if (main?.sessionId !== ctx.sessionId) throw new Error(`Magnific requires a ${spec.port} from this session.`);
      const extraAssets = {};
      for (const port of extra) {
        const value = inputs[port.id];
        if (!value) continue;
        if (value.sessionId !== ctx.sessionId) throw new Error(`Magnific requires a ${port.type} from this session.`);
        extraAssets[port.arg] = value.assetId;
      }
      const result = await tools.executeTool(ctx.toolCtx, 'magnific_media', { tool: spec.tool, field, asset_id: main.assetId, arguments: spec.args(params), extra_assets: extraAssets });
      if (!result.job) throw new Error('Magnific returned no creation.');
      const ids = await ctx.waitForJob(result.job);
      const values = await Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
      return { variants: values.map((value) => ({ [spec.port]: value })), cost: result.job.credits === null ? undefined : { credits: result.job.credits } };
    }
  });
}

// Video generation through Magnific (video_generate). One clip per run: text to video, a first frame as start keyframe,
// or a frame plus an audio reference (sung parts: the clip follows the audio; it is as long as the audio, rounded up).
const VIDEO_MODELS = [
  { value: 'bytedance-seedance-pro-2.5', max: 30, resolutions: ['1080p', '720p', '480p'] },
  { value: 'bytedance-seedance-pro-2.0', max: 15, resolutions: ['1080p', '720p', '480p'] },
  { value: 'bytedance-seedance-fast-2.0', max: 15, resolutions: ['720p', '480p'] }
];
const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const SUNG_PROMPT = 'The person of the image reference performs the song of the audio reference to the camera, lips in sync with the vocals, natural expression and body movement.';
const videoModel = (value) => VIDEO_MODELS.find((model) => model.value === value) || VIDEO_MODELS[0];
// The clip length: the audio decides when one is connected (at least 4 s), else the param; at most what the model makes.
function clipSeconds(params, audio) {
  const model = videoModel(params.model);
  const wanted = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? Math.ceil(audio.duration) : num(params.duration);
  return Math.min(model.max, Math.max(4, wanted || 5));
}
const videoEstimates = new Map();
const videoKey = (params) => JSON.stringify([params.model, params.duration, params.resolution, params.aspect_ratio, Boolean(params.sound)]);
async function videoPrepareEstimate(params, ctx) {
  const access = require('../access');
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  if (access.isRestricted(viewer) || access.isUnconfirmed(viewer) || !magnific.status().connected) return;
  const key = videoKey(params);
  if (videoEstimates.get(key)?.expiresAt > Date.now()) return;
  const api = require('../tools/magnific');
  const args = { slug: videoModel(params.model).value, prompt: 'estimate', duration: clipSeconds(params, null), resolution: params.resolution, aspectRatio: params.aspect_ratio, withSoundEffects: Boolean(params.sound) };
  videoEstimates.set(key, { credits: api.creditsOf(await api.estimate('video_generate', args)), expiresAt: Date.now() + 60000 });
}
function videoEstimate(params) {
  const cached = videoEstimates.get(videoKey(params));
  return cached?.expiresAt > Date.now() && cached.credits !== null ? { credits: cached.credits } : null;
}

function registerVideo(registry) {
  registry.register({
    type: 'magnific.video', category: 'magnific', provider: 'magnific', label: 'Magnific Video (Seedance)',
    description: 'Generate a video clip with Seedance through the connected Magnific account: from the prompt, from a first frame, or from a frame and an audio reference (the clip follows the audio and is as long as it, at least 4 s). "character" names a character of the Magnific library (e.g. gu) that keeps a real face the same in every clip. Billed in Magnific credits.',
    keywords: ['magnific', 'seedance', 'video', 'text to video', 'image to video', 'lip sync', 'sing', 'dance'],
    inputs: [
      { id: 'prompt', type: 'text', param: 'prompt' },
      { id: 'first_frame', type: 'image' },
      { id: 'audio', type: 'audio' }
    ],
    outputs: [{ id: 'video', type: 'video' }],
    params: [
      { id: 'prompt', kind: 'textarea', default: '', inline: true },
      { id: 'model', kind: 'select', options: VIDEO_MODELS.map((model) => model.value), default: VIDEO_MODELS[0].value },
      { id: 'duration', kind: 'integer', min: 4, max: 30, default: 5 },
      { id: 'resolution', kind: 'select', options: ['720p', '1080p', '480p'], default: '720p' },
      { id: 'aspect_ratio', kind: 'select', options: VIDEO_RATIOS, default: '16:9' },
      { id: 'sound', kind: 'boolean', default: false },
      { id: 'character', kind: 'text', default: '' }
    ],
    paid: true, async: true, timeoutMs: 31 * 60 * 1000, cost: { unit: 'credits', history: false, estimate: videoEstimate },
    available, cacheStamp: videoPrepareEstimate,
    validate: (params) => {
      const model = videoModel(params.model);
      const issues = [];
      if (!model.resolutions.includes(params.resolution)) issues.push({ code: 'magnific_settings', message: `${model.value} makes ${model.resolutions.join(', ')} only.` });
      if (num(params.duration) > model.max) issues.push({ code: 'magnific_settings', message: `${model.value} makes at most ${model.max} s.` });
      return issues;
    },
    execute: async (ctx, inputs, params) => {
      for (const port of ['first_frame', 'audio']) {
        if (inputs[port] && inputs[port].sessionId !== ctx.sessionId) throw new Error(`Magnific requires a ${port === 'audio' ? 'audio' : 'image'} from this session.`);
      }
      const audio = inputs.audio || null;
      const prompt = text(inputs.prompt ? inputs.prompt.value : params.prompt) || (audio ? SUNG_PROMPT : '');
      if (!prompt) throw new Error('prompt: enter a prompt or connect a text');
      const result = await tools.executeTool(ctx.toolCtx, 'magnific_video', {
        slug: videoModel(params.model).value, prompt, duration: clipSeconds(params, audio), resolution: params.resolution,
        ...(inputs.first_frame ? {} : { aspectRatio: params.aspect_ratio }), withSoundEffects: Boolean(params.sound),
        first_frame: inputs.first_frame?.assetId, audio: audio?.assetId, ...(text(params.character) ? { character: text(params.character) } : {})
      });
      if (!result.job) throw new Error('Magnific returned no creation.');
      const ids = await ctx.waitForJob(result.job);
      const values = await Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
      return { variants: values.map((value) => ({ video: value })), cost: result.job.credits === null ? undefined : { credits: result.job.credits } };
    }
  });
}

function registerAll(registry) {
  registry.register({
    type: 'magnific.upscale_image', category: 'magnific', provider: 'magnific', label: 'Magnific Upscale',
    description: 'Upscale a session image using the connected Magnific account. Billed in Magnific credits.',
    keywords: ['magnific', 'upscale', 'resolution', 'image'],
    inputs: [{ id: 'image', type: 'image', required: true }], outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'mode', kind: 'select', optionsSource: 'magnific-upscale-modes', noDefaultEntry: true, default: 'creative' },
      { id: 'scale_factor', kind: 'select', optionsSource: 'magnific-upscale-scales', noDefaultEntry: true, default: '2' }
    ],
    paid: true, async: true, timeoutMs: 11 * 60 * 1000, cost: { unit: 'credits', history: false, estimate: catalog.estimate },
    available, prepare: catalog.prepare, validate: catalog.validate, cacheStamp: catalog.prepareEstimate,
    execute: async (ctx, inputs, params) => {
      if (inputs.image?.sessionId !== ctx.sessionId) throw new Error('Magnific requires an image from this session.');
      const result = await tools.executeTool(ctx.toolCtx, 'magnific_upscale_image', { asset_id: inputs.image.assetId, mode: params.mode, scale: Number(params.scale_factor) });
      if (!result.job) throw new Error('Magnific returned no creation.');
      const ids = await ctx.waitForJob(result.job);
      const values = await Promise.all(ids.map((id) => assets.valueFromAsset(ctx.sessionId, id)));
      return { variants: values.map((value) => ({ image: value })), cost: result.job.credits === null ? undefined : { credits: result.job.credits } };
    }
  });
  for (const spec of MEDIA_NODES) registerMedia(registry, spec);
  registerVideo(registry);
}
module.exports = { registerAll, MEDIA_NODES, VIDEO_MODELS, clipSeconds };
