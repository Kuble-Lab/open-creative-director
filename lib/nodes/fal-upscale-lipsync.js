'use strict';

// Plans only: all uploads, reservations, queue jobs, cancellation and billing stay in the existing fal tool/poller.
// Enum snapshots: docs/fal-upscale-lipsync.json, fetched 2026-10-20. No provider/network calls in this module.
const fs = require('fs');
const path = require('path');
const fal = require('../fal');
const ffmpeg = require('../ffmpeg');
const assets = require('./assets');
const imageSize = require('../image-size');
const videoPrep = require('./video-prep');
const { FAL_UPLOAD_MIME } = require('../tools/shared');

const IMAGE_PRECISION = Object.freeze([
  'Standard V2', 'High Fidelity V3', 'High Fidelity V2', 'Low Resolution V2',
  'CGI', 'Text Refine', 'Faces'
]);
const IMAGE_GENERATIVE = Object.freeze([
  'Wonder 3.5', 'Wonder 3', 'Wonder 2', 'Wonder',
  'Recover 3', 'Standard MAX', 'Redefine', 'Recovery V2',
  'Recovery'
]);
const VIDEO_PRECISION = Object.freeze([
  'Proteus', 'Proteus Natural', 'Iris', 'Iris Low Quality',
  'Dione DV', 'Dione TV', 'Dione Robust', 'Dione Dehalo',
  'Dione Robust Dehalo', 'Artemis High Quality', 'Artemis Medium Quality', 'Artemis Low Quality',
  'Artemis Strong Halo', 'Artemis Medium Halo', 'Artemis Aliasing & Moire', 'Gaia HQ',
  'Gaia CG', 'Gaia 2', 'Rhea', 'Theia Fine Tune Detail',
  'Theia Fine Tune Fidelity'
]);
const KLING_VOICES = Object.freeze([
  'genshin_vindi2', 'zhinen_xuesheng', 'AOT', 'ai_shatang',
  'genshin_klee2', 'genshin_kirara', 'ai_kaiya', 'oversea_male1',
  'ai_chenjiahao_712', 'girlfriend_4_speech02', 'chat1_female_new-3', 'chat_0407_5-1',
  'cartoon-boy-07', 'uk_boy1', 'cartoon-girl-01', 'PeppaPig_platform',
  'ai_huangzhong_712', 'ai_huangyaoshi_712', 'ai_laoguowang_712', 'chengshu_jiejie',
  'you_pingjing', 'calm_story1', 'uk_man2', 'laopopo_speech02',
  'heainainai_speech02', 'reader_en_m-v1', 'commercial_lady_en_f-v1', 'tiyuxi_xuedi',
  'tiexin_nanyou', 'girlfriend_1_speech02', 'girlfriend_2_speech02', 'zhuxi_speech02',
  'uk_oldman3', 'dongbeilaotie_speech02', 'chongqingxiaohuo_speech02', 'chuanmeizi_speech02',
  'chaoshandashu_speech02', 'ai_taiwan_man2_speech02', 'xianzhanggui_speech02', 'tianjinjiejie_speech02',
  'diyinnansang_DB_CN_M_04-v2', 'yizhipiannan-v1', 'guanxiaofang-v2', 'tianmeixuemei-v1',
  'daopianyansang-v1', 'mengwa-v1'
]);
const IMAGE_MODELS = Object.freeze({
  topaz_precision: 'topaz/upscale/image/precision', topaz_generative: 'topaz/upscale/image/generative',
  seedvr: 'fal-ai/seedvr/upscale/image', recraft_crisp: 'fal-ai/recraft/upscale/crisp'
});
const VIDEO_MODELS = Object.freeze({
  topaz_precision: 'topaz/upscale/video/precision', bytedance: 'fal-ai/bytedance-upscaler/upscale/video',
  seedvr: 'fal-ai/seedvr/upscale/video', flux_video_upscale: 'blackforestlabs/flux-video-upscale'
});
const RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'];
const TIERS = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '2160p': [3840, 2160] };
const round = (n) => Math.round(n * 1e6) / 1e6;
const positive = (n) => Number.isFinite(n) && n > 0;

function fail(message) { throw new Error(`${message}. Nothing was uploaded or charged.`); }
function choice(value, options, label) {
  if (!options.includes(value)) fail(`${label}: choose ${options.join(', ')}`);
  return value;
}
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label}: must be between ${min} and ${max}`);
  return value;
}
function dimensions(info) {
  if (!positive(info?.width) || !positive(info?.height)) fail('Media dimensions could not be read');
}
function length(info, label, min = 0, max = Infinity) {
  if (!positive(info?.duration)) fail(`${label}: duration could not be read`);
  number(info.duration, min, max, `${label} duration (s)`);
}
function requireValue(inputs, port, type) {
  const value = inputs[port];
  if (!value || value.type !== type) fail(`${port}: connect a ${type}`);
  return value;
}
function keyCheck() { if (!fal.hasKey()) throw new Error(fal.MISSING_KEY_MESSAGE); }

function imageSettings(params = {}) {
  const p = { model: 'topaz_precision', upscale_factor: 2, precision_model: 'Standard V2', generative_model: 'Wonder 3.5', ...params };
  choice(p.model, Object.keys(IMAGE_MODELS), 'model');
  const input = {};
  if (p.model !== 'recraft_crisp') input.upscale_factor = choice(Number(p.upscale_factor), [2, 4], 'upscale_factor');
  if (p.model === 'topaz_precision') input.model = choice(p.precision_model, IMAGE_PRECISION, 'precision_model');
  if (p.model === 'topaz_generative') input.model = choice(p.generative_model, IMAGE_GENERATIVE, 'generative_model');
  if (p.model.startsWith('topaz_')) Object.assign(input, { output_format: 'png', enable_safety_checker: true });
  if (p.model === 'seedvr') Object.assign(input, { upscale_mode: 'factor', output_format: 'png' });
  if (p.model === 'recraft_crisp') input.enable_safety_checker = true;
  return { p, input };
}
function imageUsd(prices, params, info) {
  const { p, input } = imageSettings(params);
  if (p.model === 'recraft_crisp') return prices.upscaleImage.recraft;
  if (!positive(info?.width) || !positive(info?.height)) return null;
  const mp = info.width * info.height * input.upscale_factor ** 2 / 1e6;
  const rates = prices.upscaleImage;
  if (p.model === 'seedvr') return round(mp * rates.seedvrMP);
  const block = p.model === 'topaz_precision' ? rates.precisionMP : ['Wonder 3', 'Wonder 3.5'].includes(input.model) ? rates.wonderMP : rates.generativeMP;
  return round(Math.ceil(mp / block) * rates.topazBlock);
}
function videoSettings(params = {}, info) {
  const p = { model: 'topaz_precision', resolution: '1080p', topaz_resolution: '1080p', seedvr_resolution: '1080p',
    video_precision_model: 'Proteus', target_fps: 30, enhancement_tier: 'standard', upscale_style: 'precise', ...params };
  choice(p.model, Object.keys(VIDEO_MODELS), 'model');
  const resolution = p.model === 'topaz_precision' ? p.topaz_resolution : p.model === 'seedvr' ? p.seedvr_resolution : p.resolution;
  choice(resolution, p.model === 'topaz_precision' ? ['720p', '1080p', '2160p'] : p.model === 'seedvr' ? RESOLUTIONS : RESOLUTIONS.slice(1), 'resolution');
  const input = {};
  if (p.model === 'topaz_precision') {
    input.model = choice(p.video_precision_model, VIDEO_PRECISION, 'video_precision_model');
    input.target_fps = choice(Number(p.target_fps), [30, 60], 'target_fps');
    input.H264_output = true;
  } else if (p.model === 'bytedance') {
    input.target_resolution = { '1080p': '1080p', '1440p': '2k', '2160p': '4k' }[resolution];
    input.target_fps = choice(Number(p.target_fps), [30, 60], 'target_fps');
    input.enhancement_tier = choice(p.enhancement_tier, ['fast', 'standard', 'pro'], 'enhancement_tier');
  } else if (p.model === 'seedvr') {
    Object.assign(input, { upscale_mode: 'target', target_resolution: resolution, output_format: 'X264 (.mp4)' });
  } else {
    input.creativity = choice(p.upscale_style, ['precise', 'creative'], 'upscale_style') === 'creative' ? 1 : 0;
    input.safety_tolerance = 2;
  }
  let output;
  if (info && positive(info.width) && positive(info.height)) {
    const factor = TIERS[resolution][1] / Math.min(info.width, info.height);
    if (p.model === 'topaz_precision' || p.model === 'flux_video_upscale') {
      number(factor, p.model === 'topaz_precision' ? 1 : 1.5, p.model === 'topaz_precision' ? 4 : 3, 'Target resolution / input scaling factor');
      if (['Proteus Natural', 'Gaia 2'].includes(input.model) && Math.abs(factor - 2) > 1e-6) fail(`${input.model}: only a 2x upscale is supported`);
      input.upscale_factor = factor;
    } else if (factor < 1) fail('Target resolution is smaller than the input; resize/crop the video first');
    output = { width: Math.ceil(info.width * factor - 1e-6), height: Math.ceil(info.height * factor - 1e-6) };
    // Target names are priced as standard 16:9 pixel tiers. Do not silently buy a larger tier for a very wide source.
    const [long, short] = TIERS[resolution];
    if (Math.max(output.width, output.height) > long || output.width * output.height > long * short) fail('Output exceeds the chosen resolution tier; crop the video first');
  }
  return { p, resolution, input, output };
}
function videoUsd(prices, params, info) {
  const { p, resolution, input, output } = videoSettings(params, info);
  if (!positive(info?.duration)) return null;
  const rates = prices.upscaleVideo;
  if (p.model === 'topaz_precision') {
    const table = input.model === 'Gaia 2' ? rates.topazGaia2 : input.model === 'Proteus Natural' ? rates.topazNatural : rates.topaz;
    return round(Math.ceil(info.duration / 10) * table[resolution] * input.target_fps / 30);
  }
  if (p.model === 'bytedance') return round(info.duration * rates.bytedance[resolution] * input.target_fps / 30 * (input.enhancement_tier === 'pro' ? rates.bytedancePro : 1));
  if (p.model === 'flux_video_upscale') return round(info.duration * (input.creativity ? rates.fluxCreative : rates.fluxPrecise)[resolution]);
  if (!output || (!positive(info.frames) && !positive(info.fps))) return null;
  const frames = positive(info.frames) ? info.frames : Math.ceil(info.duration * info.fps);
  return round(output.width * output.height * frames / 1e6 * rates.seedvrMP);
}
function klingUsd(prices, seconds) {
  return positive(seconds) ? round(Math.ceil(seconds / prices.klingLipsync.secondsPerBlock) * prices.klingLipsync.secondsPerBlock * prices.klingLipsync.perSecond) : null;
}
function avatarUsd(prices, params = {}, seconds) {
  const model = choice(params.model ?? 'standard', ['standard', 'pro'], 'model');
  return positive(seconds) ? round(Math.ceil(seconds) * prices.klingAvatar[model]) : null;
}
// Like H3 Lip Sync, implicit maps need the mean item cost; one unknown length keeps the plan unknown.
function avatarPlanUsd(prices, params, context) {
  const audio = context?.inputs?.audio;
  const items = audio?.type === 'list' ? audio.items : audio ? [audio] : [];
  const costs = items.map((item) => avatarUsd(prices, params, item?.duration));
  return costs.length && costs.every((usd) => usd !== null) ? costs.reduce((sum, usd) => sum + usd, 0) / costs.length : null;
}
function klingText(inputs, params) { return String(inputs.text?.value ?? params.text ?? '').trim(); }
function klingIssues(params = {}, ports = {}) {
  const audio = Boolean(ports.audio?.connected);
  const text = Boolean(ports.text?.connected) || Boolean(String(params.text || '').trim());
  if (audio === text) return ['Connect exactly one of audio or text (or enter text)'];
  if (!ports.text?.connected && [...String(params.text || '').trim()].length > 120) return ['text: at most 120 characters'];
  return [];
}

// Plans are synchronous: read at most one image header, never start ffprobe for every canvas update.
// SeedVR video needs dimensions/frame metadata for its plan price; other video models can use duration and target settings.
// Execution always probes and reserves the measured cost before submit.
function estimateInfo(value, sessionId) {
  if (!value || value.type === 'list') return null;
  if (value.type !== 'image' || (positive(value.width) && positive(value.height))) return value;
  let fd;
  try {
    if (value.sessionId !== sessionId) return null;
    fd = fs.openSync(assets.assetFilePath(value), 'r');
    const buffer = Buffer.alloc(256 * 1024);
    return { ...value, ...imageSize.imageSizeOf(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0))) };
  } catch (_) { return value; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function createNodes({ PRICES, common, inspectMedia, mediaEntry, runFal, videoResult }) {
  async function planImage(ctx, inputs, params) {
    keyCheck();
    const value = requireValue(inputs, 'image', 'image');
    const { p, input } = imageSettings(params);
    if (p.model === 'recraft_crisp' && path.extname(value.file).toLowerCase() !== '.png') fail('Recraft Crisp requires PNG; convert the image to PNG first');
    let info;
    if (p.model !== 'recraft_crisp') {
      // Image headers work without ffprobe; inspectMedia supplies the session/file checks and an authoritative probe when available.
      info = await inspectMedia(ctx, value, 'image');
      if (!info.width || !info.height) Object.assign(info, await imageSize.imageSizeOfFile(assets.assetFilePath(value)));
      dimensions(info);
    } else await inspectMedia(ctx, value, 'image');
    return { endpoint: IMAGE_MODELS[p.model], input, kind: 'image', media: [mediaEntry('image_url', ctx, [value])], estimateUsd: imageUsd(PRICES, p, info) };
  }
  async function planVideo(ctx, inputs, params) {
    keyCheck();
    const video = requireValue(inputs, 'video', 'video');
    const info = await inspectMedia(ctx, video, 'video');
    dimensions(info); length(info, 'video');
    const { p, input, resolution } = videoSettings(params, info);
    if (p.model === 'flux_video_upscale') {
      if (path.extname(video.file).toLowerCase() !== '.mp4') fail('FLUX Video Upscale requires MP4');
      length(info, 'video', 0, 20);
      if (info.size > 50 * 1024 * 1024) fail('FLUX Video Upscale: video must be at most 50 MB');
    }
    if (p.model === 'seedvr') {
      info.frames = await ctx.withLocalSlot(() => videoPrep.countFrames(assets.assetFilePath(video), { ffprobePath: ffmpeg.binaries().ffprobe, signal: ctx.signal }));
    }
    // Bytedance returns its billed duration; let the existing poller replace the input-length estimate when it arrives.
    const pricing = p.model === 'bytedance' ? {
      perSecond: PRICES.upscaleVideo.bytedance[resolution] * input.target_fps / 30 * (input.enhancement_tier === 'pro' ? PRICES.upscaleVideo.bytedancePro : 1),
      durationField: 'duration'
    } : null;
    return { endpoint: VIDEO_MODELS[p.model], input, media: [mediaEntry('video_url', ctx, [video])], estimateUsd: videoUsd(PRICES, p, info), pricing };
  }
  async function planKling(ctx, inputs, params = {}) {
    keyCheck();
    const video = requireValue(inputs, 'video', 'video');
    const text = klingText(inputs, params);
    if (Boolean(inputs.audio) === Boolean(text)) fail('Connect exactly one of audio or text (or enter text)');
    if (inputs.text && !text) fail('text: connected text is empty');
    const info = await inspectMedia(ctx, video, 'video');
    length(info, 'video', 2, 10); dimensions(info);
    if (!['.mp4', '.mov'].includes(path.extname(video.file).toLowerCase())) fail('Kling LipSync requires .mp4 or .mov video');
    if (info.size > 100 * 1024 * 1024) fail('Kling LipSync: video must be at most 100 MB');
    const short = Math.min(info.width, info.height);
    if (![720, 1080].includes(short) || Math.max(info.width, info.height) > 1920) fail('Kling LipSync requires 720p/1080p, each side 720–1920 px; upscale/crop the video first');
    const input = { enable_safety_checker: true };
    const media = [mediaEntry('video_url', ctx, [video])];
    let mode = 'text-to-video';
    if (inputs.audio) {
      const audio = requireValue(inputs, 'audio', 'audio');
      const audioInfo = await inspectMedia(ctx, audio, 'audio');
      length(audioInfo, 'audio', 2, 60);
      // The existing listening compressor writes AAC for Gemini, not an MP3 for Kling. Do not send that different format silently.
      if (audioInfo.size > 5 * 1024 * 1024) fail('Kling LipSync: audio must be at most 5 MB; export a smaller MP3 first');
      media.push(mediaEntry('audio_url', ctx, [audio]));
      mode = 'audio-to-video';
    } else {
      if ([...text].length > 120) fail('text: at most 120 characters');
      input.text = text;
      input.voice_id = choice(params.voice_id ?? 'reader_en_m-v1', KLING_VOICES, 'voice_id');
      input.voice_language = choice(params.voice_language ?? 'en', ['en', 'zh'], 'voice_language');
      input.voice_speed = number(params.voice_speed ?? 1, 0.8, 2, 'voice_speed');
    }
    return { endpoint: `fal-ai/kling-video/lipsync/${mode}`, input, media, estimateUsd: klingUsd(PRICES, info.duration) };
  }
  async function planAvatar(ctx, inputs, params = {}) {
    keyCheck();
    if (ctx.signal?.aborted) throw fal.abortError();
    const image = requireValue(inputs, 'image', 'image');
    const audio = requireValue(inputs, 'audio', 'audio');
    const model = choice(params.model ?? 'standard', ['standard', 'pro'], 'model');
    // The Avatar schemas/pages state no media limits. Reuse the app's upload formats and conservative LipSync audio guards,
    // not undocumented provider limits. No conversion or truncation is performed.
    for (const [value, type] of [[image, 'image'], [audio, 'audio']]) {
      const ext = path.extname(value.file).toLowerCase();
      if (assets.typeFromExtension(ext) !== type || !FAL_UPLOAD_MIME[ext]) fail(`${type}: unsupported upload format`);
    }
    const imageInfo = await inspectMedia(ctx, image, 'image');
    if (!imageInfo.size || imageInfo.size > fal.MAX_UPLOAD_BYTES) fail(`image: file must be non-empty and at most ${fal.MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const audioInfo = await inspectMedia(ctx, audio, 'audio');
    length(audioInfo, 'audio', 2, 60);
    if (!audioInfo.size || audioInfo.size > 5 * 1024 * 1024) fail('Kling Avatar: audio must be non-empty and at most 5 MB; export a smaller audio file first');
    if (inputs.prompt) requireValue(inputs, 'prompt', 'text');
    const prompt = String(inputs.prompt?.value ?? params.prompt ?? '').trim();
    if ([...prompt].length > 50000) fail('prompt: at most 50000 characters');
    const input = { enable_safety_checker: true };
    if (prompt) input.prompt = prompt; // blank: preserve the provider default "."
    return {
      endpoint: `fal-ai/kling-video/ai-avatar/v2/${model}`, input,
      media: [mediaEntry('image_url', ctx, [image]), mediaEntry('audio_url', ctx, [audio])],
      // Keep the rounded, measured audio estimate through settlement, as for Kling LipSync. The result's duration is metadata;
      // a raw perSecond pricing override in the poller would lose the started-second rounding.
      estimateUsd: avatarUsd(PRICES, { model }, audioInfo.duration)
    };
  }
  const cost = (port, compute) => ({ unit: 'usd', history: false, estimate: (p, c) => {
    try { return compute(p, estimateInfo(c?.inputs?.[port], c?.workflow?.sessionId ?? c?.sessionId)); } catch (_) { return null; }
  } });
  const show = (models) => ({ param: 'model', in: models });
  const select = (id, options, value, showIf) => ({ id, kind: 'select', options, default: value, ...(showIf ? { showIf } : {}) });
  const definitions = [
    {
      ...common, type: 'fal.upscale_image', label: 'Upscale image',
      keywords: ['upscale', 'image', 'enlarge', 'resolution', 'topaz', 'seedvr', 'recraft', 'crisp', 'gigapixel', 'fal'],
      description: 'Enlarges an image with Topaz Precision/Generative, SeedVR or Recraft Crisp (PNG input). Lists map to one job per image. Paid; experimental. Cost follows output pixels; Recraft is flat per image.',
      inputs: [{ id: 'image', type: 'image', required: true }], outputs: [{ id: 'image', type: 'image' }],
      params: [select('model', Object.keys(IMAGE_MODELS), 'topaz_precision'),
        select('upscale_factor', [2, 4], 2, show(['topaz_precision', 'topaz_generative', 'seedvr'])),
        select('precision_model', IMAGE_PRECISION, 'Standard V2', show(['topaz_precision'])),
        select('generative_model', IMAGE_GENERATIVE, 'Wonder 3.5', show(['topaz_generative']))],
      cost: cost('image', (p, info) => imageUsd(PRICES, p, info)),
      execute: async (ctx, inputs, params) => { const out = await runFal(ctx, await planImage(ctx, inputs, params)); return { variants: [{ image: out.value }], cost: out.cost }; }
    },
    {
      ...common, type: 'fal.upscale_video', label: 'Upscale video',
      keywords: ['upscale', 'video', 'enlarge', 'resolution', 'topaz', 'proteus', 'bytedance', 'seedvr', 'flux', '4k', 'fal'],
      description: 'Upscales a video with Topaz Precision, Bytedance, SeedVR or FLUX. Target is the short edge; aspect ratio stays. A target outside the model scaling range is refused before payment. Audio preservation needs live verification; no sound is rebuilt locally. Paid; experimental.',
      inputs: [{ id: 'video', type: 'video', required: true }], outputs: [{ id: 'video', type: 'video' }],
      params: [select('model', Object.keys(VIDEO_MODELS), 'topaz_precision'),
        select('topaz_resolution', ['720p', '1080p', '2160p'], '1080p', show(['topaz_precision'])),
        select('resolution', RESOLUTIONS.slice(1), '1080p', show(['bytedance', 'flux_video_upscale'])),
        select('seedvr_resolution', RESOLUTIONS, '1080p', show(['seedvr'])),
        select('video_precision_model', VIDEO_PRECISION, 'Proteus', show(['topaz_precision'])),
        select('target_fps', [30, 60], 30, show(['topaz_precision', 'bytedance'])),
        select('enhancement_tier', ['fast', 'standard', 'pro'], 'standard', show(['bytedance'])),
        select('upscale_style', ['precise', 'creative'], 'precise', show(['flux_video_upscale']))],
      cost: cost('video', (p, info) => videoUsd(PRICES, p, info)),
      execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planVideo(ctx, inputs, params)))
    },
    {
      ...common, type: 'fal.kling_lipsync', label: 'Kling LipSync',
      keywords: ['kling', 'lipsync', 'lip sync', 'audio', 'text', 'voice', 'talk', 'video', 'fal'],
      description: 'Lip sync for an existing MP4/MOV video, 2–10 s, at most 100 MB, 720p/1080p and each side 720–1920 px. Connect exactly one of audio (2–60 s, at most 5 MB) or text (at most 120 characters, English/Chinese). 0.014 USD/s of input video, rounded up to 5 s. Paid; experimental.',
      inputs: [{ id: 'video', type: 'video', required: true }, { id: 'audio', type: 'audio' }, { id: 'text', type: 'text' }],
      outputs: [{ id: 'video', type: 'video' }],
      params: [{ id: 'text', kind: 'text', default: '', inline: true }, select('voice_id', KLING_VOICES, 'reader_en_m-v1', { port: 'audio', connected: false }),
        select('voice_language', ['en', 'zh'], 'en', { port: 'audio', connected: false }), { id: 'voice_speed', kind: 'number', min: 0.8, max: 2, step: 0.1, default: 1, showIf: { port: 'audio', connected: false } }],
      cost: cost('video', (_p, info) => klingUsd(PRICES, info?.duration)), validate: klingIssues,
      execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planKling(ctx, inputs, params)))
    },
    {
      ...common, type: 'fal.kling_avatar', label: 'Kling Avatar',
      keywords: ['kling', 'avatar', 'talking', 'photo', 'portrait', 'image', 'audio', 'speech', 'video', 'fal'],
      description: 'Creates a talking video with sound from a photo and speech audio. Unlike Kling LipSync, no existing video is needed. Standard or Pro; priced per started audio second. App audio guards: 2–60 s, at most 5 MB. Paid; experimental.',
      inputs: [{ id: 'image', type: 'image', required: true }, { id: 'audio', type: 'audio', required: true }, { id: 'prompt', type: 'text' }],
      outputs: [{ id: 'video', type: 'video' }],
      params: [select('model', ['standard', 'pro'], 'standard'), { id: 'prompt', kind: 'textarea', default: '', inline: true }],
      cost: { unit: 'usd', history: false, estimate: (p, c) => {
        try { return avatarPlanUsd(PRICES, p, c); } catch (_) { return null; }
      } },
      execute: async (ctx, inputs, params) => videoResult(await runFal(ctx, await planAvatar(ctx, inputs, params)))
    }
  ];
  return { definitions, planImage, planVideo, planKling, planAvatar };
}

module.exports = { createNodes, imageSettings, videoSettings, imageUsd, videoUsd, klingUsd, klingIssues, avatarUsd, avatarPlanUsd, IMAGE_MODELS, VIDEO_MODELS, IMAGE_PRECISION, IMAGE_GENERATIVE, VIDEO_PRECISION, KLING_VOICES };
