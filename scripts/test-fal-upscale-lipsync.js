'use strict';

// An isolated app with provider calls replaced: no sockets, network, paid calls or writes to the checkout's data/projects.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');
const schemas = require('../docs/fal-upscale-lipsync.json').endpoints;

async function main() {
  const app = await createIsolatedApp({ loadServer: false, env: { FAL_KEY: 'test-key' } });
  try {
    const nodes = app.load('lib/nodes/nodes-fal');
    const helper = app.load('lib/nodes/fal-upscale-lipsync');
    const store = app.load('lib/store');
    const fal = app.load('lib/fal');
    const ops = app.load('lib/nodes/ffmpeg-ops');
    const ffmpeg = app.load('lib/ffmpeg');
    const prep = app.load('lib/nodes/video-prep');
    const tools = app.load('lib/tools');
    const assets = app.load('lib/nodes/assets');
    const { createRegistry } = app.load('lib/nodes/registry');
    const registry = createRegistry(); nodes.registerAll(registry);
    await store.ensureDirs();
    const session = await store.createSession();
    const sessionId = session.id;
    const ctx = { sessionId, signal: new AbortController().signal, withLocalSlot: (fn) => fn(), toolCtx: { nodeView: true, sessionId }, log: () => {} };
    const probes = new Map();
    let paidCalls = 0;
    tools.executeTool = async () => { paidCalls++; throw new Error('test stops before payment'); };
    fal.submit = fal.uploadFile = async () => { throw new Error('Network forbidden'); };
    fal.hasKey = () => true;
    ffmpeg.binaries = () => ({ available: true, ffprobe: 'mock', ffmpeg: 'mock' });
    ops.probeMedia = async (file) => { const info = probes.get(path.basename(file)); if (!info) throw new Error('unreadable'); return info; };
    prep.countFrames = async () => 301;
    async function media(type, { width = 1280, height = 720, duration = 5, fps = 30, ext, size } = {}) {
      const saved = await store.saveAsset(sessionId, { kind: type, buffer: Buffer.from('fixture'), ext: ext || (type === 'image' ? '.png' : type === 'audio' ? '.mp3' : '.mp4') });
      const value = await assets.valueFromAsset(sessionId, saved.id);
      probes.set(saved.file, { duration, video: type === 'audio' ? null : { width, height, fps } });
      if (size) { const handle = await fs.open(assets.assetFilePath(value), 'r+'); await handle.truncate(size); await handle.close(); }
      return value;
    }
    const video = await media('video'); const audio = await media('audio'); const image = await media('image', { width: 2000, height: 1500 });
    const defaults = (type, raw) => registry.normalizeParams(registry.get(type), raw);
    const P = nodes.PRICES;
    const imgPrice = (params, width, height) => helper.imageUsd(P, params, { width, height });
    assert.equal(imgPrice({}, 3000, 2000), 0.08); // 24 MP exactly
    assert.equal(imgPrice({}, 3001, 2000), 0.16);
    assert.equal(imgPrice({}, 6000, 2000), 0.16); // 48 MP exactly
    assert.equal(imgPrice({}, 6001, 2000), 0.24);
    assert.equal(imgPrice({}, 9000, 2000), 0.24); // 72 MP exactly
    assert.equal(imgPrice({}, 9001, 2000), 0.32);
    assert.equal(imgPrice({ upscale_factor: 4 }, 3000, 2000), 0.32); // 96 MP
    for (const model of helper.IMAGE_PRECISION) assert.equal(imgPrice({ precision_model: model }, 3000, 2000), 0.08);
    for (const model of helper.IMAGE_GENERATIVE) {
      assert.equal(imgPrice({ model: 'topaz_generative', generative_model: model }, 3000, 2000), ['Wonder 3', 'Wonder 3.5'].includes(model) ? 0.24 : 0.48);
    }
    assert.equal(imgPrice({ model: 'seedvr' }, 2000, 1500), 0.012);
    assert.equal(imgPrice({ model: 'recraft_crisp' }), 0.004);
    const vidPrice = (params, info = {}) => helper.videoUsd(P, params, { width: 960, height: 540, fps: 30, duration: 10, ...info });
    for (const [res, rate] of Object.entries(P.upscaleVideo.topaz)) {
      assert.equal(vidPrice({ topaz_resolution: res }), rate);
      assert.equal(vidPrice({ topaz_resolution: res, target_fps: 60 }, { duration: 10.001 }), rate * 4);
    }
    assert.equal(vidPrice({}, { duration: 1 }), 0.20);
    assert.equal(vidPrice({}, { duration: 60 }), 1.20);
    assert.equal(vidPrice({ video_precision_model: 'Gaia 2' }), 0.1);
    assert.equal(vidPrice({ video_precision_model: 'Proteus Natural' }), 0.2);
    for (const [res, rate] of Object.entries(P.upscaleVideo.bytedance)) {
      for (const fps of [30, 60]) for (const mode of ['fast', 'standard', 'pro']) {
        assert.equal(vidPrice({ model: 'bytedance', resolution: res, target_fps: fps, enhancement_tier: mode }), Math.round(10 * rate * fps / 30 * (mode === 'pro' ? 10 : 1) * 1e6) / 1e6);
      }
    }
    for (const style of ['precise', 'creative']) for (const [res, rate] of Object.entries(style === 'precise' ? P.upscaleVideo.fluxPrecise : P.upscaleVideo.fluxCreative)) {
      const short = Number.parseInt(res) / 2;
      assert.equal(vidPrice({ model: 'flux_video_upscale', resolution: res, upscale_style: style }, { width: short * 16 / 9, height: short }), Math.round(rate * 10 * 1e6) / 1e6);
    }
    for (const [resolution, [width, height]] of Object.entries({ '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '2160p': [3840, 2160] })) {
      assert.equal(vidPrice({ model: 'seedvr', seedvr_resolution: resolution }, { frames: 301 }), Math.round(width * height * 301 / 1e6 * 0.001 * 1e6) / 1e6);
      for (const [model, table] of [['Proteus Natural', P.upscaleVideo.topazNatural], ['Gaia 2', P.upscaleVideo.topazGaia2]]) {
        if (resolution === '1440p') continue;
        assert.equal(vidPrice({ video_precision_model: model, topaz_resolution: resolution }, { width: width / 2, height: height / 2 }), table[resolution]);
      }
    }
    for (const [seconds, usd] of [[2, 0.07], [5, 0.07], [5.001, 0.14], [10, 0.14]]) assert.equal(helper.klingUsd(P, seconds), usd);

    // Exact per-endpoint input, including uploaded fields; stale hidden model params never leak into another endpoint.
    function exact(plan, expectedEndpoint, expectedInput) {
      assert.equal(plan.endpoint, expectedEndpoint);
      const input = { ...plan.input };
      for (const item of plan.media) { assert.equal(item.multiple, false); input[item.field] = `https://example.invalid/${item.assetIds[0]}`; }
      const expected = { ...expectedInput };
      for (const [key, value] of Object.entries(expected)) if (value === '$image') expected[key] = `https://example.invalid/${image.assetId}`;
      else if (value === '$video') expected[key] = `https://example.invalid/${video.assetId}`;
      else if (value === '$audio') expected[key] = `https://example.invalid/${audio.assetId}`;
      assert.deepEqual(input, expected);
      const endpoint = schemas[plan.endpoint.replaceAll('/', '_')];
      const schema = Object.entries(endpoint.components.schemas).find(([name]) => name.endsWith('Input'))[1];
      for (const key of Object.keys(input)) assert.ok(schema.properties[key], `${plan.endpoint} knows ${key}`);
      for (const key of schema.required) assert.ok(key in input, `${plan.endpoint} requires ${key}`);
    }
    const imageCases = [
      [{}, 'topaz/upscale/image/precision', { model: 'Standard V2', upscale_factor: 2, output_format: 'png', enable_safety_checker: true, image_url: '$image' }],
      [{ model: 'topaz_generative' }, 'topaz/upscale/image/generative', { model: 'Wonder 3.5', upscale_factor: 2, output_format: 'png', enable_safety_checker: true, image_url: '$image' }],
      [{ model: 'seedvr' }, 'fal-ai/seedvr/upscale/image', { upscale_mode: 'factor', upscale_factor: 2, output_format: 'png', image_url: '$image' }],
      [{ model: 'recraft_crisp' }, 'fal-ai/recraft/upscale/crisp', { enable_safety_checker: true, image_url: '$image' }]
    ];
    for (const [params, endpoint, input] of imageCases) exact(await nodes.planUpscaleImage(ctx, { image }, defaults('fal.upscale_image', params)), endpoint, input);
    const videoCases = [
      [{}, 'topaz/upscale/video/precision', { model: 'Proteus', upscale_factor: 1.5, target_fps: 30, H264_output: true, video_url: '$video' }],
      [{ model: 'bytedance' }, 'fal-ai/bytedance-upscaler/upscale/video', { target_resolution: '1080p', target_fps: 30, enhancement_tier: 'standard', video_url: '$video' }],
      [{ model: 'seedvr' }, 'fal-ai/seedvr/upscale/video', { upscale_mode: 'target', target_resolution: '1080p', output_format: 'X264 (.mp4)', video_url: '$video' }],
      [{ model: 'flux_video_upscale' }, 'blackforestlabs/flux-video-upscale', { upscale_factor: 1.5, creativity: 0, safety_tolerance: 2, video_url: '$video' }]
    ];
    for (const [params, endpoint, input] of videoCases) exact(await nodes.planUpscaleVideo(ctx, { video }, defaults('fal.upscale_video', params)), endpoint, input);
    exact(await nodes.planKlingLipsync(ctx, { video, audio }, { voice_id: 'invalid but hidden' }), 'fal-ai/kling-video/lipsync/audio-to-video', { video_url: '$video', audio_url: '$audio', enable_safety_checker: true });
    exact(await nodes.planKlingLipsync(ctx, { video }, { text: 'Hello', voice_id: 'uk_boy1', voice_language: 'en', voice_speed: 1.2 }), 'fal-ai/kling-video/lipsync/text-to-video', { video_url: '$video', text: 'Hello', voice_id: 'uk_boy1', voice_language: 'en', voice_speed: 1.2, enable_safety_checker: true });
    assert.equal((await nodes.planKlingLipsync(ctx, { video, text: { type: 'text', value: 'Connected' } }, { text: 'Ignored' })).input.text, 'Connected');
    for (const duration of [2, 10]) {
      const accepted = await nodes.planKlingLipsync(ctx, { video: await media('video', { duration, width: 1080, height: 1920, ext: '.mov' }), audio: await media('audio', { duration: 60 }) }, {});
      assert.equal(accepted.estimateUsd, duration === 2 ? 0.07 : 0.14);
    }
    assert.equal((await nodes.planKlingLipsync(ctx, { video, text: { type: 'text', value: '😀'.repeat(120) } }, {})).input.text, '😀'.repeat(120));


    async function rejects(type, inputs, params, pattern) {
      const before = paidCalls;
      await assert.rejects(registry.get(type).execute(ctx, inputs, defaults(type, params)), pattern);
      assert.equal(paidCalls, before, 'Refusal before budget, upload or submit');
    }
    for (const inputs of [{ video }, { video, audio, text: { type: 'text', value: 'Hello' } }]) await rejects('fal.kling_lipsync', inputs, {}, /exactly one/);
    await rejects('fal.kling_lipsync', { video, audio }, { text: 'Hello' }, /exactly one/);
    for (const duration of [1, 11]) await rejects('fal.kling_lipsync', { video: await media('video', { duration }), audio }, {}, /duration/);
    for (const options of [{ width: 640, height: 480 }, { width: 2000, height: 1080 }, { width: 1280, height: 721 }]) await rejects('fal.kling_lipsync', { video: await media('video', options), audio }, {}, /upscale\/crop/);
    await rejects('fal.kling_lipsync', { video, audio: await media('audio', { duration: 61 }) }, {}, /duration/);
    await rejects('fal.kling_lipsync', { video, audio: await media('audio', { duration: 1 }) }, {}, /duration/);
    await rejects('fal.kling_lipsync', { video, audio: await media('audio', { size: 5 * 1024 * 1024 + 1 }) }, {}, /smaller MP3/);
    await rejects('fal.kling_lipsync', { video: await media('video', { size: 100 * 1024 * 1024 + 1 }), audio }, {}, /100 MB/);
    await rejects('fal.kling_lipsync', { video: await media('video', { ext: '.webm' }), audio }, {}, /mp4 or .mov/);
    await rejects('fal.kling_lipsync', { video }, { text: 'x'.repeat(121) }, /120/);
    await rejects('fal.kling_lipsync', { video }, { text: 'hello', voice_id: 'unknown' }, /voice_id/);
    await rejects('fal.kling_lipsync', { video }, { text: 'hello', voice_language: 'de' }, /voice_language/);
    // Direct planner checks remain strict even if a caller bypasses registry normalization.
    await assert.rejects(nodes.planKlingLipsync(ctx, { video }, { text: 'hello', voice_speed: 2.1 }), /voice_speed/);
    await assert.rejects(nodes.planKlingLipsync(ctx, { video, text: { type: 'text', value: '' } }, { text: 'ignored' }), /exactly one/);
    await rejects('fal.kling_lipsync', { video: await media('video', { duration: null }), audio }, {}, /duration could not/);
    await rejects('fal.upscale_image', { image }, { upscale_factor: 5 }, /upscale_factor/);
    await rejects('fal.upscale_image', { image: await media('image', { ext: '.jpg' }) }, { model: 'recraft_crisp' }, /PNG/);
    await rejects('fal.upscale_video', { video: await media('video', { width: 256, height: 144 }) }, {}, /scaling factor/);
    await rejects('fal.upscale_video', { video: await media('video', { width: 640, height: 360 }) }, { model: 'flux_video_upscale', resolution: '2160p' }, /scaling factor/);
    await rejects('fal.upscale_video', { video: await media('video', { duration: 21 }) }, { model: 'flux_video_upscale' }, /duration/);
    await rejects('fal.upscale_video', { video: await media('video', { size: 50 * 1024 * 1024 + 1 }) }, { model: 'flux_video_upscale' }, /50 MB/);
    await rejects('fal.upscale_video', { video: await media('video', { width: 4000, height: 720 }) }, { model: 'bytedance' }, /Output exceeds/);
    await rejects('fal.upscale_video', { video }, { video_precision_model: 'Gaia 2' }, /only a 2x/);
    await rejects('fal.upscale_image', { image: { ...image, sessionId: 'other' } }, {}, /another session/);
    const countFrames = prep.countFrames;
    prep.countFrames = async () => { throw new Error('Frame count unavailable'); };
    await rejects('fal.upscale_video', { video }, { model: 'seedvr' }, /Frame count/);
    prep.countFrames = countFrames;
    assert.ok(helper.klingIssues({}, {}).length);
    assert.ok(helper.klingIssues({ text: 'hello' }, { audio: { connected: true } }).length);
    assert.deepEqual(helper.klingIssues({}, { audio: { connected: true } }), []);
    assert.deepEqual(helper.klingIssues({}, { text: { connected: true } }), []);

    // Every endpoint goes through fal_generate with the measured estimate; finishJob still reads the result and booked cost.
    const submissions = [];
    const outputImage = await store.saveAsset(sessionId, { kind: 'image', buffer: Buffer.from('result'), ext: '.png', cost: 0.08 });
    const outputVideo = await store.saveAsset(sessionId, { kind: 'video', buffer: Buffer.from('result'), ext: '.mp4', cost: 0.14 });
    let resultId;
    tools.executeTool = async (_ctx, name, args) => {
      assert.equal(name, 'fal_generate'); paidCalls++; submissions.push(args);
      assert.ok(Number.isFinite(args.estimateUsd) && args.estimateUsd > 0);
      resultId = args.kind === 'image' ? outputImage.id : outputVideo.id;
      return { job: { jobId: 'mock', assetId: resultId } };
    };
    ctx.waitForJob = async () => [resultId];
    for (const [raw] of imageCases) {
      const out = await registry.get('fal.upscale_image').execute(ctx, { image }, defaults('fal.upscale_image', raw));
      assert.equal(out.variants[0].image.assetId, outputImage.id);
    }
    for (const [raw] of videoCases) {
      const out = await registry.get('fal.upscale_video').execute(ctx, { video }, defaults('fal.upscale_video', raw));
      assert.equal(out.variants[0].video.assetId, outputVideo.id);
    }
    await registry.get('fal.kling_lipsync').execute(ctx, { video, audio }, defaults('fal.kling_lipsync', {}));
    await registry.get('fal.kling_lipsync').execute(ctx, { video }, defaults('fal.kling_lipsync', { text: 'Hello' }));
    assert.equal(submissions.length, 10);
    assert.equal(submissions[0].estimateUsd, 0.08);
    assert.equal(submissions[3].estimateUsd, 0.004);
    assert.equal(submissions[8].estimateUsd, 0.07);
    assert.deepEqual(submissions[5].pricing, { perSecond: 0.0072, durationField: 'duration' });
    const poller = app.load('lib/poller');
    assert.equal(poller.falJobCost({ pricing: submissions[5].pricing, costEstimateUsd: submissions[5].estimateUsd }, { duration: 6 }), 0.0432);
    assert.equal(poller.falJobCost({ costEstimateUsd: submissions[8].estimateUsd }, {}), 0.07);

    // No ffprobe: image header dimensions remain usable; video dimensions are required, never guessed before payment.
    ffmpeg.binaries = () => ({ available: false });
    const header = Buffer.alloc(24);
    header.writeUInt32BE(0x89504e47, 0); header.write('IHDR', 12); header.writeUInt32BE(3001, 16); header.writeUInt32BE(2000, 20);
    await fs.writeFile(assets.assetFilePath(image), header);
    assert.equal((await nodes.planUpscaleImage(ctx, { image }, defaults('fal.upscale_image'))).estimateUsd, 0.16);
    const imageDef = registry.get('fal.upscale_image');
    assert.equal(imageDef.cost.estimate(defaults('fal.upscale_image'), { workflow: { sessionId }, inputs: { image } }), 0.16);
    assert.equal(imageDef.cost.estimate(defaults('fal.upscale_image'), { workflow: { sessionId: 'other' }, inputs: { image } }), null);
    await rejects('fal.upscale_video', { video }, {}, /dimensions/);
    for (const type of ['fal.upscale_image', 'fal.upscale_video', 'fal.kling_lipsync']) {
      const def = registry.get(type);
      assert.equal(def.category, 'fal'); assert.equal(def.experimental, true);
      fal.hasKey = () => false;
      assert.equal(def.available(), 'FAL_KEY is not set');
      await rejects(type, { image, video, audio }, {}, /FAL_KEY/);
      fal.hasKey = () => true;
      assert.equal(def.available(), true);
    }
    const controller = new AbortController(); controller.abort();
    const beforeAbort = paidCalls;
    await assert.rejects(registry.get('fal.upscale_image').execute({ ...ctx, signal: controller.signal }, { image }, defaults('fal.upscale_image')), { name: 'AbortError' });
    assert.equal(paidCalls, beforeAbort, 'An aborted run never starts a provider job');
    // Enum snapshots exactly match the supplied OpenAPI.
    for (const [endpoint, key, values] of [
      ['topaz_upscale_image_precision', 'model', helper.IMAGE_PRECISION],
      ['topaz_upscale_image_generative', 'model', helper.IMAGE_GENERATIVE],
      ['topaz_upscale_video_precision', 'model', helper.VIDEO_PRECISION],
      ['fal-ai_kling-video_lipsync_text-to-video', 'voice_id', helper.KLING_VOICES]
    ]) assert.deepEqual(Object.entries(schemas[endpoint].components.schemas).find(([name]) => name.endsWith('Input'))[1].properties[key].enum, values);
  } finally { await app.cleanup(); }
  console.log('test-fal-upscale-lipsync.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
