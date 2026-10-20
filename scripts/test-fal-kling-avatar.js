'use strict';

// Private app storage, mocked probes/provider: no network, sockets or paid calls.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');
const schemas = require('../docs/fal-kling-ai-avatar-v2.json').endpoints;

async function main() {
  const app = await createIsolatedApp({ loadServer: false, env: { FAL_KEY: 'test-key' } });
  try {
    const nodes = app.load('lib/nodes/nodes-fal');
    const helper = app.load('lib/nodes/fal-upscale-lipsync');
    const store = app.load('lib/store');
    const fal = app.load('lib/fal');
    const ffmpeg = app.load('lib/ffmpeg');
    const ops = app.load('lib/nodes/ffmpeg-ops');
    const tools = app.load('lib/tools');
    const assets = app.load('lib/nodes/assets');
    const { createRegistry } = app.load('lib/nodes/registry');
    const registry = createRegistry(); nodes.registerAll(registry);
    const def = registry.get('fal.kling_avatar');
    const params = (p) => registry.normalizeParams(def, p);
    await store.ensureDirs();
    const { id: sessionId } = await store.createSession();
    const ctx = { sessionId, signal: new AbortController().signal, withLocalSlot: (fn) => fn(), toolCtx: { nodeView: true, sessionId }, log: () => {} };
    const probes = new Map();
    let calls = 0;
    fal.uploadFile = fal.submit = async () => { throw new Error('Network forbidden'); };
    tools.executeTool = async () => { calls++; throw new Error('Unexpected paid tool'); };
    fal.hasKey = () => true;
    ffmpeg.binaries = () => ({ available: true, ffprobe: 'mock', ffmpeg: 'mock' });
    ops.probeMedia = async (file) => {
      const info = probes.get(path.basename(file));
      if (!info) throw new Error('Unreadable media');
      return info;
    };
    async function media(type, { duration = 5.01, ext = type === 'image' ? '.png' : '.mp3', size } = {}) {
      const saved = await store.saveAsset(sessionId, { kind: type, buffer: Buffer.from('fixture'), ext });
      const value = await assets.valueFromAsset(sessionId, saved.id);
      probes.set(saved.file, { duration, video: type === 'image' ? { width: 1024, height: 1024 } : null });
      if (size !== undefined) {
        const handle = await fs.open(assets.assetFilePath(value), 'r+');
        await handle.truncate(size); await handle.close();
      }
      return value;
    }
    const image = await media('image');
    const audio = await media('audio');
    const text = (value) => ({ type: 'text', value });
    assert.equal(params().model, 'standard');
    assert.equal(def.category, 'fal');
    assert.equal(def.paid, true); assert.equal(def.async, true); assert.equal(def.experimental, true);
    assert.deepEqual(def.outputs, [{ id: 'video', type: 'video' }]);
    assert.deepEqual(def.inputs.filter((port) => port.required).map((port) => port.id), ['image', 'audio']);
    assert.equal(def.cost.history, false);
    const known = (value) => ({ inputs: { audio: value } });
    for (const [model, rate] of [['standard', 0.0562], ['pro', 0.115]]) {
      for (const seconds of [2, 2.001, 5, 5.01, 59.99, 60]) {
        const usd = Math.round(Math.ceil(seconds) * rate * 1e6) / 1e6;
        assert.equal(helper.avatarUsd(nodes.PRICES, { model }, seconds), usd);
        assert.equal(def.cost.estimate(params({ model }), known({ ...audio, duration: seconds })), usd);
      }
      for (const seconds of [undefined, null, 0, -1, NaN, Infinity]) {
        assert.equal(def.cost.estimate(params({ model }), known({ ...audio, duration: seconds })), null);
      }
      assert.equal(def.cost.estimate(params({ model }), {}), null);
      const list = { type: 'list', of: 'audio', items: [{ ...audio, duration: 2 }, { ...audio, duration: 5.01 }] };
      assert.equal(def.cost.estimate(params({ model }), known(list)), (helper.avatarUsd(nodes.PRICES, { model }, 2) + helper.avatarUsd(nodes.PRICES, { model }, 5.01)) / 2);
      assert.equal(def.cost.estimate(params({ model }), known({ ...list, items: [...list.items, audio] })), null);
      assert.equal(def.cost.estimate(params({ model }), known({ ...list, items: [] })), null);
      for (const prompt of [undefined, '', '  ', 'Look to the left']) {
        const inputs = { image, audio, ...(prompt !== undefined ? { prompt: text(prompt) } : {}) };
        const plan = await nodes.planKlingAvatar(ctx, inputs, params({ model, prompt: 'Fallback', voice_id: 'hidden', safety: false }));
        const actual = { ...plan.input };
        for (const entry of plan.media) {
          assert.equal(entry.multiple, false);
          assert.equal(entry.assetIds.length, 1);
          actual[entry.field] = `https://example.invalid/${entry.assetIds[0]}`;
        }
        const expected = { enable_safety_checker: true, image_url: `https://example.invalid/${image.assetId}`, audio_url: `https://example.invalid/${audio.assetId}` };
        const resolved = prompt === undefined ? 'Fallback' : prompt.trim();
        if (resolved) expected.prompt = resolved;
        assert.equal(plan.endpoint, `fal-ai/kling-video/ai-avatar/v2/${model}`);
        assert.deepEqual(actual, expected);
        const schema = Object.entries(schemas[plan.endpoint.replaceAll('/', '_')].components.schemas).find(([name]) => name.endsWith('Input'))[1];
        for (const key of Object.keys(actual)) assert.ok(key in schema.properties, key);
        for (const key of schema.required) assert.ok(key in actual, key);
        assert.equal(plan.estimateUsd, model === 'standard' ? 0.3372 : 0.69);
        assert.equal(plan.pricing, undefined, 'Raw output duration must not erase started-second rounding');
      }
      const blank = await nodes.planKlingAvatar(ctx, { image, audio }, params({ model }));
      assert.deepEqual(blank.input, { enable_safety_checker: true });
    }
    assert.equal(def.cost.estimate({ model: 'invalid' }, known({ ...audio, duration: 5 })), null);

    async function refuses(inputs, raw, pattern, context = ctx) {
      const before = calls;
      await assert.rejects(def.execute(context, inputs, params(raw)), pattern);
      assert.equal(calls, before, 'Reject before upload, reservation or paid tool');
    }
    await refuses({}, {}, /image: connect/);
    await refuses({ image }, {}, /audio: connect/);
    await refuses({ audio }, {}, /image: connect/);
    await refuses({ image: audio, audio }, {}, /image: connect/);
    await refuses({ image, audio: image }, {}, /audio: connect/);
    await refuses({ image, audio, prompt: audio }, {}, /prompt: connect a text/);
    await refuses({ image, audio }, { prompt: 'x'.repeat(50001) }, /50000/);
    await assert.rejects(nodes.planKlingAvatar(ctx, { image, audio }, { model: 'unknown' }), /model: choose/);
    for (const duration of [null, 0, -1, NaN, 1.999, 60.001]) await refuses({ image, audio: await media('audio', { duration }) }, {}, /duration/);
    for (const duration of [2, 60]) assert.ok((await nodes.planKlingAvatar(ctx, { image, audio: await media('audio', { duration }) })).estimateUsd > 0);
    await refuses({ image, audio: await media('audio', { size: 5 * 1024 * 1024 + 1 }) }, {}, /5 MB/);
    await refuses({ image: await media('image', { size: fal.MAX_UPLOAD_BYTES + 1 }), audio }, {}, /90 MB/);
    await refuses({ image, audio: await media('audio', { size: 0 }) }, {}, /non-empty/);
    await refuses({ image: await media('image', { size: 0 }), audio }, {}, /non-empty/);
    for (const ext of ['.mp4', '.flac', '.bin']) await refuses({ image, audio: await media('audio', { ext }) }, {}, /unsupported upload format/);
    await refuses({ image: await media('image', { ext: '.pdf' }), audio }, {}, /unsupported upload format/);
    await refuses({ image: { ...image, file: 'unsupported.heic' }, audio }, {}, /unsupported upload format/);
    for (const ext of ['.mp3', '.wav', '.m4a', '.aac', '.MP3']) {
      await nodes.planKlingAvatar(ctx, { image, audio: await media('audio', { ext, size: 5 * 1024 * 1024 }) });
    }
    await nodes.planKlingAvatar(ctx, { image: await media('image', { size: fal.MAX_UPLOAD_BYTES }), audio });
    await refuses({ image: { ...image, sessionId: 'another' }, audio }, {}, /another session/);
    await refuses({ image, audio: { ...audio, sessionId: 'another' } }, {}, /another session/);
    probes.delete(audio.file);
    await refuses({ image, audio }, {}, /could not be analysed/);
    probes.set(audio.file, { duration: 5.01 });
    const controller = new AbortController(); controller.abort();
    await refuses({ image, audio }, {}, { name: 'AbortError' }, { ...ctx, signal: controller.signal });
    fal.hasKey = () => false;
    assert.equal(def.available(), 'FAL_KEY is not set');
    await refuses({ image, audio }, {}, /FAL_KEY/);
    fal.hasKey = () => true;
    assert.equal(def.available(), true);
    ffmpeg.binaries = () => ({ available: false });
    await refuses({ image, audio }, {}, /duration could not be read/);
    ffmpeg.binaries = () => ({ available: true, ffprobe: 'mock', ffmpeg: 'mock' });

    // The measured duration overrides stale asset metadata and the estimate reaches the shared paid tool.
    const result = await store.saveAsset(sessionId, { kind: 'video', buffer: Buffer.from('output'), ext: '.mp4', cost: 0.3372 });
    ctx.waitForJob = async () => [result.id];
    const submissions = [];
    tools.executeTool = async (_ctx, name, args) => {
      calls++; assert.equal(name, 'fal_generate'); submissions.push(args);
      return { job: { jobId: 'mock-avatar', assetId: result.id } };
    };
    for (const model of ['standard', 'pro']) {
      const out = await def.execute(ctx, { image, audio: { ...audio, duration: 59 } }, params({ model }));
      assert.equal(out.variants[0].video.assetId, result.id);
      assert.equal(out.cost.usd, 0.3372, 'Return the journal cost, never overwrite it with the current plan');
    }
    assert.deepEqual(submissions.map((args) => args.estimateUsd), [0.3372, 0.69]);
    assert.deepEqual(submissions.map((args) => args.kind), ['video', 'video']);
    assert.ok(submissions.every((args) => args.pricing === null));
    const poller = app.load('lib/poller');
    assert.equal(poller.falJobCost({ costEstimateUsd: submissions[0].estimateUsd }, { duration: 5.01 }), 0.3372);
  } finally { await app.cleanup(); }
  console.log('test-fal-kling-avatar.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
