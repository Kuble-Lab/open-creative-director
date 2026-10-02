'use strict';

// The fal.ai node types (lib/nodes/nodes-fal.js): registry, input building per endpoint, validation BEFORE anything is
// uploaded or queued, cost estimates, camera presets and the free-form model node with placeholders. No network:
// lib/fal.js upload / submit are replaced by recorders; the real tool fal_generate runs on top of them and the job is
// completed by the test like the poller does. Backing sessions and temp files are removed at the end.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const fal = require('../lib/fal');
const ffmpeg = require('../lib/ffmpeg');
const assets = require('../lib/nodes/assets');
const jobs = require('../lib/nodes/jobs');
const ops = require('../lib/nodes/ffmpeg-ops');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const defaultRegistry = require('../lib/nodes/registry');
const { createRegistry } = defaultRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');

const MB = 1024 * 1024;

/* ---------- mock plumbing ---------- */

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

function oneOf(registry, type) {
  const def = registry.get(type);
  assert.ok(def, `${type} is registered`);
  return def;
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-fal-'));
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  nodesFal.registerAll(registry);
  const sessions = [];
  const created = [];
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(tmpDir, 'workflows'), registry, events: bus });

  try {
    const session = await store.createSession();
    sessions.push(session.id);
    const sessionId = session.id;

    /* ---------- recorders and helpers ---------- */

    let hasKey = true;
    const falCalls = { upload: [], submit: [] };
    let requestCounter = 0;
    patch(fal, 'hasKey', () => hasKey);
    patch(fal, 'uploadFile', async (file, options) => {
      falCalls.upload.push({ file: path.basename(file), contentType: options.contentType });
      return { url: `https://v3b.fal.media/files/${path.basename(file)}`, size: 4, contentType: options.contentType, fileName: options.fileName };
    });
    patch(fal, 'submit', async (endpoint, input) => {
      falCalls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)) });
      requestCounter += 1;
      return {
        requestId: `req-${requestCounter}`,
        statusUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}/status`,
        responseUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}`
      };
    });
    const resetCalls = () => {
      falCalls.upload.length = 0;
      falCalls.submit.length = 0;
    };
    const nothingSent = (message) => assert.deepEqual([falCalls.upload.length, falCalls.submit.length], [0, 0], message || 'nothing uploaded, nothing queued');

    // ffprobe: measured values come from this table (by file name); `probing = false` simulates a missing ffprobe
    let probing = true;
    const probes = new Map();
    patch(ffmpeg, 'binaries', () => (probing ? { available: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } : { available: false }));
    patch(ops, 'probeMedia', async (file) => {
      const probe = probes.get(path.basename(file));
      if (!probe) throw new Error('unreadable file');
      return probe;
    });

    let assetCounter = 0;
    async function media(kind, ext, { duration, width = 0, height = 0, bytes = 'data', size } = {}) {
      assetCounter += 1;
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.from(`${bytes}${assetCounter}`), ext, prompt: 'seed' });
      if (size) {
        const handle = await fsp.open(path.join(store.sessionAssetDir(sessionId), saved.file), 'w');
        await handle.truncate(size);
        await handle.close();
      }
      probes.set(saved.file, {
        video: kind === 'audio' ? null : { codec: 'x', width, height, fps: 25 },
        audio: kind === 'image' ? null : { codec: 'x', sampleRate: 44100, channels: 2, channelLayout: 'stereo' },
        duration: duration ?? null
      });
      return assets.valueFromAsset(sessionId, saved.id);
    }
    const image = (options = {}) => media('image', '.png', { width: 1024, height: 1024, ...options });
    const video = (options = {}) => media('video', '.mp4', { duration: 10, width: 1280, height: 720, ...options });
    const audio = (options = {}) => media('audio', '.mp3', { duration: 8, ...options });
    const uploadedFile = (value) => value.file;
    const urlOf = (value) => `https://v3b.fal.media/files/${value.file}`;

    // completes the queued job like the poller does (asset first, then the job record)
    let nextCompletion = { cost: 0.4, expanded: null, resultJson: null };
    const ctx = () => {
      const controller = new AbortController();
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: {},
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', emit() {} },
        log() {},
        waitForJob: async (job) => {
          await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), nextCompletion.cost);
          await store.mutateSession(sessionId, (s) => {
            const target = s.jobs.find((entry) => entry.assetId === job.assetId);
            target.status = 'completed';
            target.resultAssetIds = [job.assetId];
            if (nextCompletion.expanded) target.expanded_prompt = nextCompletion.expanded;
            if (nextCompletion.resultJson) target.resultJson = nextCompletion.resultJson;
          });
          return [job.assetId];
        },
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn()
      };
    };
    const run = (type, inputs, rawParams = {}) => {
      const def = oneOf(registry, type);
      return def.execute(ctx(), inputs, registry.normalizeParams(def, rawParams));
    };
    const lastSubmit = () => falCalls.submit[falCalls.submit.length - 1];
    const failing = async (type, inputs, rawParams, pattern) => {
      resetCalls();
      await assert.rejects(run(type, inputs, rawParams), pattern);
      nothingSent(`${type}: ${pattern}`);
    };
    const text = textValue;
    const list = (of, items) => listValue(of, items);

    /* ---------- registry ---------- */
    {
      const types = ['fal.h3_video', 'fal.h3_reference', 'fal.h3_lipsync', 'fal.h3_camera', 'fal.h3_extend', 'fal.h3_insert', 'fal.h3_3d', 'fal.h3_style', 'fal.remove_background', 'fal.model'];
      assert.deepEqual(nodesFal.definitions.map((def) => def.type), types, 'H3 Max first, background removal before the free node, which stays last');
      for (const type of types) {
        const def = oneOf(registry, type);
        assert.equal(def.category, 'fal', type);
        assert.equal(def.paid, true, type);
        assert.equal(def.async, true, type);
        assert.equal(def.experimental, true, type);
        assert.equal(def.cost.unit, 'usd', type);
        assert.equal(typeof def.execute, 'function');
        assert.ok(def.timeoutMs > 95 * 60 * 1000, 'longer than the poller timeout of 90 minutes');
      }
      // available follows the key
      hasKey = false;
      for (const type of types) assert.equal(registry.availability(oneOf(registry, type)), 'FAL_KEY is not set', type);
      hasKey = true;
      for (const type of types) assert.equal(registry.availability(oneOf(registry, type)), true, type);
      assert.ok(defaultRegistry.CATEGORIES.includes('fal'));
      assert.ok(defaultRegistry.publicRegistry().categories.includes('fal'));
      for (const type of types) assert.ok(defaultRegistry.get(type), `${type} in the default registry`);
      assert.equal(defaultRegistry.list().length, 77, '62 + 10 fal.ai node types + the Prompt node + the two music nodes + the video node with a model choice + the video grid');
      assert.equal(defaultRegistry.list().filter((def) => def.category === 'fal').length, 10);

      const ports = (type) => ({ in: oneOf(registry, type).inputs.map((port) => port.id), out: oneOf(registry, type).outputs.map((port) => port.id) });
      assert.deepEqual(ports('fal.h3_video'), { in: ['prompt', 'first_frame', 'last_frame', 'audio'], out: ['video', 'expanded_prompt'] });
      assert.deepEqual(ports('fal.h3_reference'), { in: ['prompt', 'images', 'videos', 'audios'], out: ['video', 'expanded_prompt'] });
      assert.deepEqual(ports('fal.h3_lipsync'), { in: ['image', 'audio'], out: ['video'] });
      assert.deepEqual(ports('fal.h3_camera'), { in: ['image', 'prompt'], out: ['video', 'expanded_prompt'] });
      assert.deepEqual(ports('fal.h3_extend'), { in: ['video', 'prompt'], out: ['video', 'expanded_prompt'] });
      assert.deepEqual(ports('fal.h3_insert'), { in: ['video', 'prompt', 'images', 'videos'], out: ['video', 'expanded_prompt'] });
      assert.deepEqual(ports('fal.h3_3d'), { in: ['video', 'prompt', 'images'], out: ['video'] });
      assert.deepEqual(ports('fal.h3_style'), { in: ['prompt', 'first_frame'], out: ['video'] });
      assert.deepEqual(ports('fal.remove_background'), { in: ['image'], out: ['image'] });
      assert.deepEqual(ports('fal.model'), { in: ['prompt', 'images', 'videos', 'audios'], out: ['media', 'json'] });
      // prompt inputs follow the other generation nodes: a text port with an inline param fallback
      const prompt = oneOf(registry, 'fal.h3_video').inputs[0];
      assert.deepEqual([prompt.type, prompt.required, prompt.param], ['text', true, 'prompt']);
      assert.equal(oneOf(registry, 'fal.h3_video').params.find((param) => param.id === 'prompt').inline, true);
      assert.equal(oneOf(registry, 'fal.h3_camera').inputs[1].required, false);
      assert.equal(oneOf(registry, 'fal.h3_reference').inputs[1].max, 9);
      assert.equal(oneOf(registry, 'fal.h3_reference').inputs[2].max, 3);
      assert.equal(oneOf(registry, 'fal.model').inputs[3].max, 5);
      // defaults from the schemas
      const defaults = (type) => registry.normalizeParams(oneOf(registry, type), {});
      assert.deepEqual(defaults('fal.h3_video'), { prompt: '', model: 'max', resolution: '768P', aspect_ratio: '16:9', duration: 5, prompt_expansion: 'balanced', seed: null, safety: true });
      assert.equal(defaults('fal.h3_reference').aspect_ratio, 'adaptive');
      assert.deepEqual([defaults('fal.h3_lipsync').resolution, defaults('fal.h3_lipsync').transcription], ['768P', false]);
      assert.deepEqual([defaults('fal.h3_camera').preset, defaults('fal.h3_camera').resolution, defaults('fal.h3_camera').duration], ['orbit_right', '480P', 5]);
      assert.deepEqual([defaults('fal.h3_extend').output, defaults('fal.h3_extend').aspect_ratio, defaults('fal.h3_extend').prompt_expansion], ['extended', 'auto', true]);
      assert.deepEqual([defaults('fal.h3_insert').resolution, defaults('fal.h3_insert').color_match, defaults('fal.h3_insert').duration], ['768p', true, 5]);
      assert.deepEqual([defaults('fal.h3_3d').resolution, defaults('fal.h3_3d').max_generated_reference_images], ['768P', 2]);
      assert.deepEqual([defaults('fal.h3_style').style, defaults('fal.h3_style').damage_level], ['vhs', 'medium']);
      // conditional params
      const showIf = (type, id) => oneOf(registry, type).params.find((param) => param.id === id).showIf;
      assert.deepEqual(showIf('fal.h3_video', 'aspect_ratio'), { ports: ['first_frame', 'last_frame'], connected: false });
      assert.deepEqual(showIf('fal.h3_style', 'aspect_ratio'), { port: 'first_frame', connected: false });
      assert.deepEqual(showIf('fal.h3_camera', 'trajectory'), { param: 'preset', equals: 'custom' });
      assert.deepEqual(showIf('fal.h3_style', 'damage_level'), { param: 'style', equals: 'vhs' });
      // the resolution enums differ in case exactly as the schemas do
      const options = (type, id) => oneOf(registry, type).params.find((param) => param.id === id).options;
      assert.deepEqual(options('fal.h3_video', 'resolution'), ['480P', '768P', '1080P']);
      assert.deepEqual(options('fal.h3_insert', 'resolution'), ['480p', '768p']);
      assert.deepEqual(options('fal.h3_lipsync', 'resolution'), ['480P', '768P', '1080P', '2K']);
      assert.deepEqual(options('fal.h3_reference', 'aspect_ratio'), ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
      assert.deepEqual(options('fal.h3_extend', 'aspect_ratio'), ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
      assert.deepEqual(options('fal.h3_style', 'style'), ['vhs', 'retro-toon-70s', 'low-poly', 'hand-drawn', '16bit-pixel']);
      // no node ever sends sync_mode
      assert.ok(nodesFal.definitions.every((def) => !def.params.some((param) => /sync/.test(param.id))));
    }

    /* ---------- cost estimates (list prices after 2026-09-30) ---------- */
    {
      const estimate = (type, rawParams = {}) => {
        const def = oneOf(registry, type);
        return def.cost.estimate(registry.normalizeParams(def, rawParams));
      };
      assert.equal(nodesFal.PRICES.listPricesFrom, '2026-09-30');
      assert.equal(nodesFal.PRICES.source, 'docs/fal-h3-max.json');
      assert.equal(estimate('fal.h3_video'), 0.4, '5 s at 768P max');
      assert.equal(estimate('fal.h3_video', { resolution: '480P', duration: 10 }), 0.5);
      assert.equal(estimate('fal.h3_video', { resolution: '1080P', duration: 15 }), 2.4);
      assert.equal(estimate('fal.h3_video', { model: 'turbo', resolution: '480P', duration: 5 }), 0.125);
      assert.equal(estimate('fal.h3_video', { model: 'turbo', resolution: '768P', duration: 5 }), 0.2);
      assert.equal(estimate('fal.h3_video', { model: 'turbo', resolution: '1080P', duration: 10 }), 0.8);
      assert.equal(estimate('fal.h3_reference', { resolution: '1080P', duration: 5 }), 0.8);
      assert.equal(estimate('fal.h3_camera'), 0.25, 'default 480P, 5 s');
      assert.equal(estimate('fal.h3_camera', { resolution: '768P', duration: 3 }), 0.24);
      assert.equal(estimate('fal.h3_extend', { resolution: '2K', duration: 5 }), 1.6);
      assert.equal(estimate('fal.h3_extend'), 0.4);
      assert.equal(estimate('fal.h3_insert'), 0.3, '5 s at 768p, only the new scene');
      assert.equal(estimate('fal.h3_insert', { resolution: '480p', duration: 10 }), 0.5);
      assert.equal(estimate('fal.h3_style', { duration: 10 }), 0.8);
      // the duration is not a param: unknown
      assert.equal(estimate('fal.h3_lipsync'), null);
      assert.equal(estimate('fal.h3_3d'), null);
      assert.equal(estimate('fal.model'), null);
      assert.equal(estimate('fal.remove_background'), 0.018, 'flat price per image (details in test-nodes-remove-background.js)');
    }

    /* ---------- fal.h3_video ---------- */
    {
      resetCalls();
      // text to video: aspect ratio sent, no image fields, sync_mode never
      let out = await run('fal.h3_video', { prompt: text('A kitten in a garden') });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/text-to-video');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'A kitten in a garden',
        prompt_expansion_mode: 'balanced',
        resolution: '768P',
        duration: 5,
        enable_safety_checker: true,
        aspect_ratio: '16:9'
      });
      assert.equal(falCalls.upload.length, 0);
      assert.equal(out.variants.length, 1);
      assert.equal(out.variants[0].video.type, 'video');
      assert.equal(out.variants[0].expanded_prompt.value, 'A kitten in a garden', 'falls back to the sent prompt');
      assert.deepEqual(out.cost, { usd: 0.4 }, 'the ledger cost written by the poller is reported');
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.endpoint, 'minimax/h3-max/text-to-video');
      assert.equal(job.costEstimateUsd, 0.4);
      assert.deepEqual(job.pricing, { perSecond: 0.08, durationField: 'duration' });

      // the expanded prompt of the result is passed on
      nextCompletion = { cost: 0.4, expanded: 'A fluffy white kitten, slow tracking shot', resultJson: null };
      out = await run('fal.h3_video', { prompt: text('kitten') });
      assert.equal(out.variants[0].expanded_prompt.value, 'A fluffy white kitten, slow tracking shot');
      nextCompletion = { cost: 0.4, expanded: null, resultJson: null };

      // turbo with a first frame: image-to-video, no aspect ratio, seed and safety switch sent
      resetCalls();
      const first = await image();
      await run('fal.h3_video', { prompt: text('animate'), first_frame: first }, { model: 'turbo', resolution: '1080P', duration: 8, seed: 7, safety: false, prompt_expansion: 'quality', aspect_ratio: '9:16' });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max-turbo/image-to-video');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'animate',
        prompt_expansion_mode: 'quality',
        resolution: '1080P',
        duration: 8,
        enable_safety_checker: false,
        seed: 7,
        image_url: urlOf(first)
      });
      assert.equal(falCalls.upload.length, 1);
      const turboJob = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(turboJob.costEstimateUsd, 0.64, '8 s at 0.08 (turbo 1080P)');

      // last frame alone, and both frames plus audio
      resetCalls();
      const last = await image();
      await run('fal.h3_video', { prompt: text('end shot'), last_frame: last });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/image-to-video');
      assert.equal(lastSubmit().input.end_image_url, urlOf(last));
      assert.equal(lastSubmit().input.image_url, undefined);
      assert.equal(lastSubmit().input.aspect_ratio, undefined);
      resetCalls();
      const track = await audio({ duration: 12 });
      await run('fal.h3_video', { prompt: text('both'), first_frame: first, last_frame: last, audio: track });
      assert.equal(lastSubmit().input.image_url, urlOf(first));
      assert.equal(lastSubmit().input.end_image_url, urlOf(last));
      assert.equal(lastSubmit().input.target_audio_url, urlOf(track));
      assert.deepEqual(falCalls.upload.map((entry) => entry.file), [uploadedFile(first), uploadedFile(last), uploadedFile(track)]);
      assert.deepEqual(falCalls.upload.map((entry) => entry.contentType), ['image/png', 'image/png', 'audio/mpeg']);

      // audio and prompt problems are found before anything is uploaded
      await failing('fal.h3_video', { prompt: text('x'), first_frame: first, audio: await audio({ duration: 1.5 }) }, {}, /audio: must be at least 2 s/);
      await failing('fal.h3_video', { prompt: text('x'), audio: await audio({ duration: 5, size: 15 * MB + 1 }) }, {}, /audio: at most 15 MB/);
      await failing('fal.h3_video', { prompt: text('x'), audio: await audio({ duration: 5, size: 15 * MB + 1 }) }, {}, /audio: at most 15 MB/);
      await failing('fal.h3_video', { prompt: text('   ') }, {}, /prompt/);
      await failing('fal.h3_video', {}, {}, /prompt/);
      await failing('fal.h3_video', { prompt: text('x'.repeat(50001)) }, {}, /at most 50000 characters/);
      // exactly 15 MB and exactly 2 s pass
      resetCalls();
      await run('fal.h3_video', { prompt: text('x'), audio: await audio({ duration: 2, size: 15 * MB }) });
      assert.equal(falCalls.submit.length, 1);
      // an audio file of a foreign session is refused
      const foreign = { ...(await audio()), sessionId: 'someone-else' };
      await failing('fal.h3_video', { prompt: text('x'), audio: foreign }, {}, /another session/);
      // an unreadable file (ffprobe fails) is reported, not sent
      const broken = await audio();
      probes.delete(broken.file);
      await failing('fal.h3_video', { prompt: text('x'), audio: broken }, {}, /could not be analysed/);

      // without ffprobe only sizes are checked: a short audio passes, a big one still fails
      probing = false;
      resetCalls();
      await run('fal.h3_video', { prompt: text('x'), audio: await audio({ duration: 0.5 }) });
      assert.equal(falCalls.submit.length, 1);
      await failing('fal.h3_video', { prompt: text('x'), audio: await audio({ size: 16 * MB }) }, {}, /at most 15 MB/);
      probing = true;
    }

    /* ---------- fal.h3_reference ---------- */
    {
      resetCalls();
      const images = [await image(), await image()];
      const videos = [await video({ duration: 4 }), await video({ duration: 6 })];
      const audios = [await audio({ duration: 5 })];
      await run(
        'fal.h3_reference',
        { prompt: text('Image 1 meets Image 2 in Video 1'), images: list('image', images), videos: list('video', videos), audios: list('audio', audios) },
        { resolution: '1080P', aspect_ratio: '9:16', duration: 6, seed: 3, safety: false }
      );
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/reference-to-video');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'Image 1 meets Image 2 in Video 1',
        prompt_expansion_mode: 'balanced',
        resolution: '1080P',
        aspect_ratio: '9:16',
        duration: 6,
        enable_safety_checker: false,
        seed: 3,
        reference_image_urls: images.map(urlOf),
        reference_video_urls: videos.map(urlOf),
        reference_audio_urls: audios.map(urlOf)
      });
      assert.equal(falCalls.upload.length, 5);
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, 0.96);

      // no references at all: only the prompt
      resetCalls();
      await run('fal.h3_reference', { prompt: text('just text') });
      assert.equal(lastSubmit().input.reference_image_urls, undefined);
      assert.equal(lastSubmit().input.aspect_ratio, 'adaptive');

      // limits: 9 images / 3 videos / 3 audios / 12 files / durations, all before any upload
      const many = async (count) => Promise.all(Array.from({ length: count }, () => image()));
      resetCalls();
      await run('fal.h3_reference', { prompt: text('nine'), images: list('image', await many(9)) });
      assert.equal(lastSubmit().input.reference_image_urls.length, 9);
      await failing('fal.h3_reference', { prompt: text('x'), images: list('image', await many(10)) }, {}, /images: at most 9/);
      await failing('fal.h3_reference', { prompt: text('x'), videos: list('video', await Promise.all([1, 2, 3, 4].map(() => video({ duration: 3 })))) }, {}, /videos: at most 3/);
      await failing('fal.h3_reference', { prompt: text('x'), audios: list('audio', await Promise.all([1, 2, 3, 4].map(() => audio({ duration: 3 })))) }, {}, /audios: at most 3/);
      await failing(
        'fal.h3_reference',
        { prompt: text('x'), images: list('image', await many(9)), videos: list('video', await Promise.all([1, 2].map(() => video({ duration: 3 })))), audios: list('audio', await Promise.all([1, 2].map(() => audio({ duration: 3 })))) },
        {},
        /together: at most 12 files/
      );
      resetCalls();
      await run('fal.h3_reference', { prompt: text('twelve'), images: list('image', await many(9)), videos: list('video', await Promise.all([1, 2].map(() => video({ duration: 3 })))), audios: list('audio', [await audio({ duration: 3 })]) });
      assert.equal(falCalls.upload.length, 12);
      await failing('fal.h3_reference', { prompt: text('x'), videos: list('video', [await video({ duration: 1.9 })]) }, {}, /videos\[1\]: must be at least 2 s/);
      await failing('fal.h3_reference', { prompt: text('x'), videos: list('video', [await video({ duration: 15.5 })]) }, {}, /videos\[1\]: must be at most 15 s/);
      await failing('fal.h3_reference', { prompt: text('x'), videos: list('video', [await video({ duration: 9 }), await video({ duration: 8 })]) }, {}, /videos: together at most 15 s/);
      await failing('fal.h3_reference', { prompt: text('x'), audios: list('audio', [await audio({ duration: 9 }), await audio({ duration: 8 })]) }, {}, /audios: together at most 15 s/);
      await failing('fal.h3_reference', { images: list('image', await many(1)) }, {}, /prompt/);
      // static validation (before a run): counts of the connections
      const validate = (type, params, ports) => oneOf(registry, type).validate(registry.normalizeParams(oneOf(registry, type), params), ports);
      assert.deepEqual(validate('fal.h3_reference', {}, { images: { connected: true, count: 10 }, videos: { count: 0 }, audios: { count: 0 } }), ['images: at most 9 are allowed']);
      assert.equal(validate('fal.h3_reference', {}, { images: { count: 9 }, videos: { count: 3 }, audios: { count: 3 } }).length, 1, 'over 12 files together');
      assert.deepEqual(validate('fal.h3_reference', {}, { images: { count: 9 }, videos: { count: 3 }, audios: { count: 0 } }), []);
    }

    /* ---------- fal.h3_lipsync ---------- */
    {
      resetCalls();
      const portrait = await image({ width: 800, height: 1000 });
      const speech = await audio({ duration: 20 });
      const out = await run('fal.h3_lipsync', { image: portrait, audio: speech }, { resolution: '2K', transcription: true, seed: 12 });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/lip-sync/image-to-video');
      assert.deepEqual(lastSubmit().input, {
        resolution: '2K',
        enable_transcription: true,
        enable_safety_checker: true,
        seed: 12,
        image_url: urlOf(portrait),
        audio_url: urlOf(speech)
      });
      assert.equal(out.variants[0].video.type, 'video');
      assert.equal(Object.keys(out.variants[0]).join(), 'video', 'no expanded prompt for lip sync');
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.costEstimateUsd, 7.68, '20 s x 0.32 x 1.2 over 15 s');
      assert.deepEqual(job.pricing, { perSecond: 0.32, durationField: 'duration', overSeconds: 15, overMultiplier: 1.2 });

      resetCalls();
      await run('fal.h3_lipsync', { image: portrait, audio: await audio({ duration: 5 }) });
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, 0.4, '5 s at 768P (docs example)');
      assert.equal(lastSubmit().input.enable_transcription, false);
      assert.equal(lastSubmit().input.seed, undefined);
      // boundaries: ratio 0.4 and 2.5, 5 s and 15 minutes pass
      await run('fal.h3_lipsync', { image: await image({ width: 400, height: 1000 }), audio: await audio({ duration: 900 }) });
      await run('fal.h3_lipsync', { image: await image({ width: 2500, height: 1000 }), audio: await audio({ duration: 5 }) });

      await failing('fal.h3_lipsync', { image: await image({ width: 300, height: 1000 }), audio: speech }, {}, /aspect ratio .* between 0\.4 and 2\.5/);
      await failing('fal.h3_lipsync', { image: await image({ width: 2600, height: 1000 }), audio: speech }, {}, /aspect ratio/);
      await failing('fal.h3_lipsync', { image: portrait, audio: await audio({ duration: 4.9 }) }, {}, /audio: must be at least 5 s/);
      await failing('fal.h3_lipsync', { image: portrait, audio: await audio({ duration: 901 }) }, {}, /audio: must be at most 900 s/);
      await failing('fal.h3_lipsync', { audio: speech }, {}, /image: connect/);
      await failing('fal.h3_lipsync', { image: portrait }, {}, /audio: connect/);
      // without ffprobe nothing about the ratio or length is known: sent without an estimate
      probing = false;
      resetCalls();
      await run('fal.h3_lipsync', { image: await image({ width: 1, height: 100 }), audio: await audio({ duration: 1 }) });
      assert.equal(falCalls.submit.length, 1);
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, null);
      probing = true;
    }

    /* ---------- fal.h3_camera ---------- */
    {
      const expectedTail = {
        orbit_left: { azimuth: -90, elevation: 0, distance: 1 },
        orbit_right: { azimuth: 90, elevation: 0, distance: 1 },
        orbit_360: { azimuth: 360, elevation: 0, distance: 1 },
        dolly_in: { azimuth: 0, elevation: 0, distance: 0.5 },
        dolly_out: { azimuth: 0, elevation: 0, distance: 1.5 },
        crane_up: { azimuth: 0, elevation: 30, distance: 1 },
        crane_down: { azimuth: 0, elevation: 0, distance: 1 }
      };
      const source = await image();
      for (const [preset, tail] of Object.entries(expectedTail)) {
        resetCalls();
        await run('fal.h3_camera', { image: source }, { preset });
        const path = lastSubmit().input.camera_trajectory;
        assert.equal(lastSubmit().endpoint, 'minimax/h3-max/camera-controls');
        assert.equal(path.length, 2, preset);
        assert.deepEqual(path[0], preset === 'crane_down' ? { time: 0, azimuth: 0, elevation: 30, distance: 1 } : { time: 0, azimuth: 0, elevation: 0, distance: 1 }, `${preset} start`);
        assert.deepEqual(path[1], { time: 1, ...tail }, `${preset} end`);
        nodesFal.parseTrajectory(JSON.stringify(path)); // every preset passes the strict custom check
      }
      assert.deepEqual(nodesFal.CAMERA_PRESET_NAMES, [...Object.keys(expectedTail), 'custom']);

      // a blank prompt is left out (fal then keeps the camera-only default), a given one is sent
      resetCalls();
      await run('fal.h3_camera', { image: source }, { preset: 'dolly_in', duration: 3, resolution: '768P', seed: 5, safety: false, prompt_expansion: 'disabled' });
      assert.deepEqual(lastSubmit().input, {
        prompt_expansion_mode: 'disabled',
        resolution: '768P',
        duration: 3,
        camera_trajectory: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 1, azimuth: 0, elevation: 0, distance: 0.5 }],
        enable_safety_checker: false,
        seed: 5,
        image_url: urlOf(source)
      });
      assert.equal('prompt' in lastSubmit().input, false);
      await run('fal.h3_camera', { image: source, prompt: text('  keep the vase still  ') });
      assert.equal(lastSubmit().input.prompt, 'keep the vase still');
      nextCompletion = { cost: 0.25, expanded: 'expanded camera prompt', resultJson: null };
      const withExpanded = await run('fal.h3_camera', { image: source });
      assert.equal(withExpanded.variants[0].expanded_prompt.value, 'expanded camera prompt');
      nextCompletion = { cost: 0.4, expanded: null, resultJson: null };
      assert.equal((await run('fal.h3_camera', { image: source })).variants[0].expanded_prompt.value, '', 'no prompt sent: empty text');

      // custom trajectory: JSON from the param, strictly validated
      const custom = [
        { time: 0, azimuth: 0, elevation: 10, distance: 1 },
        { time: 0.5, azimuth: 45, elevation: -20, distance: 0.8 },
        { time: 1, azimuth: 720, elevation: 90, distance: 2 }
      ];
      resetCalls();
      await run('fal.h3_camera', { image: source }, { preset: 'custom', trajectory: JSON.stringify(custom) });
      assert.deepEqual(lastSubmit().input.camera_trajectory, custom);
      const bad = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
      const frame = (overrides = {}) => ({ time: 0, azimuth: 0, elevation: 0, distance: 1, ...overrides });
      const invalid = [
        ['not json', /not valid JSON/],
        [{ time: 0 }, /expected a JSON array/],
        [[frame()], /2 to 12 keyframes/],
        [Array.from({ length: 13 }, (_unused, index) => frame({ time: index / 13 })), /2 to 12 keyframes/],
        [[frame(), 'x'], /keyframe 2: expected an object/],
        [[frame(), { time: 1, azimuth: 0, elevation: 0 }], /keyframe 2: distance must be a number/],
        [[frame(), { ...frame({ time: 1 }), roll: 3 }], /keyframe 2: unknown field roll/],
        [[frame(), frame({ time: 1, azimuth: '10' })], /azimuth must be a number/],
        [[frame(), frame({ time: 1.1 })], /time must be between 0 and 1/],
        [[frame({ time: -0.1 }), frame({ time: 1 })], /time must be between 0 and 1/],
        [[frame({ time: 0.5 }), frame({ time: 0.5 })], /greater than the previous/],
        [[frame({ time: 0.8 }), frame({ time: 0.2 })], /greater than the previous/],
        [[frame(), frame({ time: 1, elevation: 91 })], /elevation must be between -90 and 90/],
        [[frame(), frame({ time: 1, elevation: -90.5 })], /elevation must be between -90 and 90/],
        [[frame(), frame({ time: 1, distance: 0 })], /distance must be greater than 0/],
        [[frame(), frame({ time: 1, distance: -1 })], /distance must be greater than 0/],
        [[frame(), frame({ time: 1, azimuth: 11521 })], /32 full turns/]
      ];
      for (const [value, pattern] of invalid) {
        await failing('fal.h3_camera', { image: source }, { preset: 'custom', trajectory: bad(value) }, pattern);
        // the same problem is reported before the run by validate()
        const issues = oneOf(registry, 'fal.h3_camera').validate(registry.normalizeParams(oneOf(registry, 'fal.h3_camera'), { preset: 'custom', trajectory: bad(value) }), {});
        assert.equal(issues.length, 1);
        assert.match(issues[0], pattern);
      }
      // exactly 12 keyframes and exactly 32 turns are allowed
      const twelve = Array.from({ length: 12 }, (_unused, index) => frame({ time: index / 11, azimuth: index * 30 }));
      assert.equal(nodesFal.parseTrajectory(JSON.stringify(twelve)).length, 12);
      assert.equal(nodesFal.parseTrajectory(JSON.stringify([frame(), frame({ time: 1, azimuth: 11520 })])).length, 2);
      assert.deepEqual(oneOf(registry, 'fal.h3_camera').validate(registry.normalizeParams(oneOf(registry, 'fal.h3_camera'), { preset: 'orbit_left', trajectory: 'not json' }), {}), [], 'the path is only read for the custom preset');
      await failing('fal.h3_camera', {}, {}, /image: connect/);
      await failing('fal.h3_camera', { image: source, prompt: text('x'.repeat(50001)) }, {}, /at most 50000/);
      // duration 3 to 15
      assert.equal(registry.normalizeParams(oneOf(registry, 'fal.h3_camera'), { duration: 2 }).duration, 3);
      assert.equal(registry.normalizeParams(oneOf(registry, 'fal.h3_camera'), { duration: 40 }).duration, 15);
    }

    /* ---------- fal.h3_extend ---------- */
    {
      resetCalls();
      const source = await video({ duration: 12, width: 1280, height: 720 });
      await run('fal.h3_extend', { video: source, prompt: text('The car drives away') }, { output: 'continuation', duration: 8, resolution: '1080P', aspect_ratio: '9:16', prompt_expansion: false, seed: 4, safety: false });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/extend-video');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'The car drives away',
        output: 'continuation',
        enable_prompt_expansion: false,
        enable_safety_checker: false,
        resolution: '1080P',
        aspect_ratio: '9:16',
        duration: 8,
        seed: 4,
        video_url: urlOf(source)
      });
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, 1.28);
      resetCalls();
      await run('fal.h3_extend', { video: source, prompt: text('next') });
      assert.deepEqual([lastSubmit().input.output, lastSubmit().input.aspect_ratio, lastSubmit().input.enable_prompt_expansion], ['extended', 'auto', true]);
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.pricing.durationField, null, 'the reported duration may include the source clip and is not used');
      // boundaries pass
      await run('fal.h3_extend', { video: await video({ duration: 1.625 }), prompt: text('x') });
      await run('fal.h3_extend', { video: await video({ duration: 60, size: 50 * MB }), prompt: text('x') });
      // problems
      await failing('fal.h3_extend', { video: await video({ duration: 1.5 }), prompt: text('x') }, {}, /video: must be at least 1\.625 s/);
      await failing('fal.h3_extend', { video: await video({ duration: 61 }), prompt: text('x') }, {}, /video: must be at most 60 s/);
      await failing('fal.h3_extend', { video: await video({ duration: 5, size: 50 * MB + 1 }), prompt: text('x') }, {}, /video: at most 50 MB/);
      await failing('fal.h3_extend', { video: await video({ duration: 5, width: 3000, height: 1000 }), prompt: text('x') }, {}, /aspect ratio/);
      await failing('fal.h3_extend', { video: await video({ duration: 5, width: 300, height: 1000 }), prompt: text('x') }, {}, /aspect ratio/);
      await failing('fal.h3_extend', { video: source }, {}, /prompt/);
      await failing('fal.h3_extend', { prompt: text('x') }, {}, /video: connect/);
    }

    /* ---------- fal.h3_insert ---------- */
    {
      resetCalls();
      const source = await video({ duration: 20 });
      const refs = [await image(), await image()];
      const clips = [await video({ duration: 4 })];
      await run(
        'fal.h3_insert',
        { video: source, prompt: text('A dragon flies through'), images: list('image', refs), videos: list('video', clips) },
        { start_time: 5, resume_time: 8.5, duration: 6.5, resolution: '480p', color_match: false, prompt_expansion: false, seed: 9 }
      );
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/insert-video');
      assert.deepEqual(lastSubmit().input, {
        start_time: 5,
        resume_time: 8.5,
        duration: 6.5,
        resolution: '480p',
        color_match: false,
        enable_prompt_expansion: false,
        seed: 9,
        prompt: 'A dragon flies through',
        video_url: urlOf(source),
        reference_image_urls: refs.map(urlOf),
        reference_video_urls: clips.map(urlOf)
      });
      assert.equal('enable_safety_checker' in lastSubmit().input, false, 'the insert schema has no safety switch');
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.costEstimateUsd, 0.325, '6.5 s at 0.05');
      assert.equal(job.pricing.durationField, 'injected_duration');
      resetCalls();
      await run('fal.h3_insert', { video: source }, { start_time: 3, resume_time: 3 });
      assert.deepEqual(lastSubmit().input, { start_time: 3, resume_time: 3, duration: 5, resolution: '768p', color_match: true, enable_prompt_expansion: true, video_url: urlOf(source) });
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, 0.3);

      await failing('fal.h3_insert', { video: source }, { start_time: 25, resume_time: 26 }, /start_time: must be inside the video \(it is 20\.00 s long\)/);
      await failing('fal.h3_insert', { video: source }, { start_time: 5, resume_time: 21 }, /resume_time: must not be after the end of the video/);
      await failing('fal.h3_insert', { video: source }, { start_time: 8, resume_time: 6 }, /resume_time: must not be before start_time/);
      await failing('fal.h3_insert', { video: source }, { start_time: 1.625, resume_time: 1.625 }, /resume_time: must be greater than 1\.625/);
      await failing('fal.h3_insert', { video: await video({ duration: 1 }) }, {}, /video: must be at least 1\.625 s/);
      await failing('fal.h3_insert', { video: source, images: list('image', await Promise.all(Array.from({ length: 10 }, () => image()))) }, {}, /images: at most 9/);
      await failing('fal.h3_insert', { video: source, videos: list('video', await Promise.all(Array.from({ length: 4 }, () => video()))) }, {}, /videos: at most 3/);
      await failing('fal.h3_insert', { prompt: text('x') }, {}, /video: connect/);
      // clamped by the registry to the documented ranges
      const insert = oneOf(registry, 'fal.h3_insert');
      const clamped = registry.normalizeParams(insert, { start_time: 0, resume_time: 99, duration: 40 });
      assert.deepEqual([clamped.start_time, clamped.resume_time, clamped.duration], [1.625, 60, 13]);
      assert.deepEqual(insert.validate(registry.normalizeParams(insert, { start_time: 9, resume_time: 4 }), {}), ['resume_time: must not be before start_time']);
      assert.deepEqual(insert.validate(registry.normalizeParams(insert, {}), { images: { count: 12 } }), ['images: at most 9 are allowed']);
    }

    /* ---------- fal.h3_3d ---------- */
    {
      resetCalls();
      const blender = await video({ duration: 10 });
      const refs = [await image()];
      await run('fal.h3_3d', { video: blender, prompt: text('The block is a running person'), images: list('image', refs) }, { resolution: '1080P', max_generated_reference_images: 4 });
      assert.equal(lastSubmit().endpoint, 'minimax/h3-max/3d-to-video');
      assert.deepEqual(lastSubmit().input, {
        resolution: '1080P',
        max_generated_reference_images: 4,
        prompt: 'The block is a running person',
        video_url: urlOf(blender),
        reference_image_urls: refs.map(urlOf)
      });
      let job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.costEstimateUsd, 1.6, '10 s at 0.16');
      assert.equal(job.pricing, null, 'the result reports no duration');
      resetCalls();
      await run('fal.h3_3d', { video: await video({ duration: 3 }) });
      assert.deepEqual(lastSubmit().input, { resolution: '768P', max_generated_reference_images: 2, video_url: lastSubmit().input.video_url });
      job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.costEstimateUsd, 0.4, 'billed for at least 5 s');
      await run('fal.h3_3d', { video: await video({ duration: 15 }) });
      await failing('fal.h3_3d', { video: await video({ duration: 15.5 }) }, {}, /video: must be at most 15 s/);
      await failing('fal.h3_3d', { video: blender, prompt: text('x'.repeat(2001)) }, {}, /prompt: at most 2000/);
      await failing('fal.h3_3d', { video: blender, images: list('image', await Promise.all(Array.from({ length: 9 }, () => image()))) }, {}, /images: at most 8/);
      await failing('fal.h3_3d', {}, {}, /video: connect/);
      const def = oneOf(registry, 'fal.h3_3d');
      assert.deepEqual(def.validate(registry.normalizeParams(def, { prompt: 'x'.repeat(2001) }), {}), ['prompt: at most 2000 characters are allowed']);
      assert.deepEqual(def.validate(registry.normalizeParams(def, { prompt: 'x'.repeat(2001) }), { prompt: { connected: true } }), []);
      const clamped = registry.normalizeParams(def, { max_generated_reference_images: 12 });
      assert.equal(clamped.max_generated_reference_images, 8);
    }

    /* ---------- fal.h3_style ---------- */
    {
      const styles = {
        vhs: 'minimax/h3-max/styles/vhs',
        'retro-toon-70s': 'minimax/h3-max/styles/retro-toon-70s',
        'low-poly': 'minimax/h3-max/styles/low-poly',
        'hand-drawn': 'minimax/h3-max/styles/hand-drawn',
        '16bit-pixel': 'minimax/h3-max/styles/16bit-pixel'
      };
      for (const [style, endpoint] of Object.entries(styles)) {
        assert.equal(fal.isValidEndpointId(endpoint), true, endpoint);
        resetCalls();
        await run('fal.h3_style', { prompt: text('A street at night') }, { style, aspect_ratio: '4:3', duration: 7, damage_level: 'heavy', seed: 2 });
        assert.equal(lastSubmit().endpoint, endpoint);
        const expected = { prompt: 'A street at night', duration: 7, aspect_ratio: '4:3', seed: 2 };
        if (style === 'vhs') expected.damage_level = 'heavy';
        assert.deepEqual(lastSubmit().input, expected, style);
      }
      // with a first frame the canvas comes from the image: no aspect ratio
      resetCalls();
      const frame = await image();
      await run('fal.h3_style', { prompt: text('x'), first_frame: frame }, { style: 'low-poly' });
      assert.deepEqual(lastSubmit().input, { prompt: 'x', duration: 5, image_url: urlOf(frame) });
      assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].costEstimateUsd, 0.4);
      await failing('fal.h3_style', { prompt: text('x'.repeat(49801)) }, {}, /at most 49800/);
      await failing('fal.h3_style', {}, {}, /prompt/);
      const def = oneOf(registry, 'fal.h3_style');
      resetCalls();
      await assert.rejects(def.execute(ctx(), { prompt: text('x') }, { ...registry.normalizeParams(def, {}), style: 'gothic' }), /style: "gothic" is not a valid option/);
      nothingSent();
      assert.deepEqual(registry.checkParams(def, { ...registry.normalizeParams(def, {}), style: 'gothic' }), ['param style: "gothic" is not a valid option']);
    }

    /* ---------- fal.model (free) ---------- */
    {
      const images = [await image(), await image(), await image()];
      const clip = await video();
      const voice = await audio();
      const params = (json, extra = {}) => ({ endpoint: 'fal-ai/some-model/edit', input_json: json, ...extra });

      // placeholders are replaced in the parsed JSON: exact strings become URLs, lists become URL lists
      resetCalls();
      nextCompletion = { cost: 0, expanded: null, resultJson: '{"video":{"url":"https://v3b.fal.media/f.mp4"},"seed":5}' };
      const out = await run(
        'fal.model',
        { prompt: text('a red fox'), images: list('image', images), videos: list('video', [clip]), audios: list('audio', [voice]) },
        params(
          JSON.stringify({
            prompt: 'Photo of {{prompt}}, high quality. {{prompt}}!',
            image_url: '{{image_1}}',
            image_urls: ['{{image_2}}', '{{image_3}}'],
            all: '{{images}}',
            nested: { clip: '{{video_1}}', voices: '{{audios}}', voice: '{{audio_1}}', keep: 'plain', n: 3, on: true, nothing: null }
          }),
          { output_kind: 'video' }
        )
      );
      assert.equal(lastSubmit().endpoint, 'fal-ai/some-model/edit');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'Photo of a red fox, high quality. a red fox!',
        image_url: urlOf(images[0]),
        image_urls: [urlOf(images[1]), urlOf(images[2])],
        all: images.map(urlOf),
        nested: { clip: urlOf(clip), voices: [urlOf(voice)], voice: urlOf(voice), keep: 'plain', n: 3, on: true, nothing: null }
      });
      assert.equal(falCalls.upload.length, 5, 'each referenced medium once (the images through the list count once each)');
      assert.deepEqual(new Set(falCalls.upload.map((entry) => entry.file)), new Set([...images, clip, voice].map(uploadedFile)));
      const job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.keepResult, true);
      assert.equal(job.costEstimateUsd, null);
      assert.equal(job.pricing, null);
      assert.equal(job.resultKind, 'video');
      assert.deepEqual(Object.keys(out.variants[0]).sort(), ['json', 'media']);
      assert.equal(out.variants[0].media.type, 'video');
      assert.equal(out.variants[0].json.value, '{"video":{"url":"https://v3b.fal.media/f.mp4"},"seed":5}');
      assert.deepEqual(out.cost, { usd: 0 }, 'the ledger cost of the completed asset is reported as it is');
      nextCompletion = { cost: 0.4, expanded: null, resultJson: null };

      // only referenced media are uploaded
      resetCalls();
      await run('fal.model', { images: list('image', images), videos: list('video', [clip]) }, params('{"image_url":"{{image_2}}"}'));
      assert.deepEqual(falCalls.upload.map((entry) => entry.file), [uploadedFile(images[1])]);
      assert.deepEqual(lastSubmit().input, { image_url: urlOf(images[1]) });
      resetCalls();
      await run('fal.model', { images: list('image', images) }, params('{"steps": 4}'));
      assert.equal(falCalls.upload.length, 0);
      assert.deepEqual(lastSubmit().input, { steps: 4 });

      // the prompt is data: neither JSON syntax nor placeholders inside it are interpreted
      resetCalls();
      const evil = '"}, "admin": true, "x": {"y": "{{image_1}} {{prompt}} \\';
      await run('fal.model', { prompt: text(evil), images: list('image', images) }, params('{"prompt":"{{prompt}}","meta":{"note":"note: {{prompt}}"}}'));
      assert.deepEqual(lastSubmit().input, { prompt: evil, meta: { note: `note: ${evil}` } });
      assert.equal(falCalls.upload.length, 0, 'a placeholder inside the prompt is not a media reference');
      // a $-pattern in the prompt is inserted literally
      await run('fal.model', { prompt: text('cost $& and $1') }, params('{"prompt":"{{prompt}}"}'));
      assert.equal(lastSubmit().input.prompt, 'cost $& and $1');
      // keys are never rewritten
      await run('fal.model', { prompt: text('x') }, params('{"{{prompt}}":"a","b":"{{ prompt }}"}'));
      assert.deepEqual(lastSubmit().input, { '{{prompt}}': 'a', b: 'x' });

      // problems are found before anything is uploaded
      const two = { images: list('image', images.slice(0, 2)) };
      await failing('fal.model', two, params('{"a":"{{image_3}}"}'), /refers to image 3, but 2 images are connected/);
      await failing('fal.model', two, params('{"a":"{{image_0}}"}'), /refers to image 0/);
      await failing('fal.model', {}, params('{"a":"{{video_1}}"}'), /refers to video 1, but 0 videos are connected/);
      await failing('fal.model', {}, params('{"a":"{{audios}}"}'), /no audios are connected/);
      await failing('fal.model', two, params('{"a":"see {{image_1}} here"}'), /must be the whole string value/);
      await failing('fal.model', two, params('{"a":"{{images}} and more"}'), /must be the whole string value/);
      await failing('fal.model', {}, params('{"a":"{{prompt}}"}'), /\{\{prompt\}\} is used, but no prompt/);
      await failing('fal.model', {}, params('{"a": '), /input_json: not valid JSON/);
      await failing('fal.model', {}, params('[1,2]'), /expected a JSON object/);
      await failing('fal.model', {}, params('"text"'), /expected a JSON object/);
      await failing('fal.model', {}, params('null'), /expected a JSON object/);
      await failing('fal.model', {}, { endpoint: '', input_json: '{}' }, /endpoint: enter a fal\.ai endpoint id/);
      await failing('fal.model', {}, { endpoint: 'https://queue.fal.run/fal-ai/x', input_json: '{}' }, /not a valid fal\.ai endpoint id/);
      await failing('fal.model', {}, { endpoint: 'Fal-AI/Flux', input_json: '{}' }, /not a valid fal\.ai endpoint id/);
      await failing('fal.model', {}, { endpoint: '../fal-ai/flux', input_json: '{}' }, /not a valid fal\.ai endpoint id/);
      await failing('fal.model', {}, { endpoint: 'fal-ai/flux/dev', input_json: '{}', output_kind: 'gif' }, /output_kind/);
      await failing('fal.model', { images: list('image', await Promise.all(Array.from({ length: 11 }, () => image()))) }, params('{}'), /images: at most 10/);
      await failing('fal.model', { videos: list('video', await Promise.all(Array.from({ length: 6 }, () => video()))) }, params('{}'), /videos: at most 5/);
      await failing('fal.model', { audios: list('audio', await Promise.all(Array.from({ length: 6 }, () => audio()))) }, params('{}'), /audios: at most 5/);
      // an asset of another session
      await failing('fal.model', { images: list('image', [{ ...images[0], sessionId: 'other' }]) }, params('{"a":"{{image_1}}"}'), /another session/);
      // validate() reports the parameter problems in the editor already
      const model = oneOf(registry, 'fal.model');
      assert.deepEqual(model.validate(registry.normalizeParams(model, params('{"a":1}')), {}), []);
      assert.equal(model.validate(registry.normalizeParams(model, { endpoint: 'nope', input_json: '{' }), {}).length, 2);
      assert.equal(model.validate(registry.normalizeParams(model, {}), {}).length, 1, 'the empty endpoint');
      // defaults
      assert.deepEqual(registry.normalizeParams(model, {}), { endpoint: '', prompt: '', input_json: '{\n  "prompt": "{{prompt}}"\n}', output_kind: 'auto' });
      assert.equal(nodesFal.MAX_RESULT_JSON, 50 * 1024);
    }

    /* ---------- no key, no run ---------- */
    {
      hasKey = false;
      resetCalls();
      await assert.rejects(run('fal.h3_video', { prompt: text('x') }), /FAL_KEY/);
      await assert.rejects(run('fal.model', {}, { endpoint: 'fal-ai/flux/dev', input_json: '{}' }), /FAL_KEY/);
      nothingSent();
      hasKey = true;
    }

    /* ---------- engine: plan, confirmation numbers, run, result ---------- */
    {
      const engine = createEngine({
        store: wfStore,
        registry,
        events: bus,
        getConfig: () => ({}),
        limits: { jobPollMs: 20 }
      });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow } = await wfStore.createWorkflow({
        name: 'fal engine',
        graph: {
          nodes: [
            node('n1', 'input.text', { text: 'A lighthouse in a storm' }),
            node('n2', 'fal.h3_video', { duration: 10, resolution: '480P' }, 300),
            node('n3', 'output.result', { label: 'Clip' }, 600)
          ],
          edges: [edge('e1', 'n1', 'text', 'n2', 'prompt'), edge('e2', 'n2', 'video', 'n3', 'inputs')]
        }
      });
      created.push(workflow.id);
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.equal(plan.nodes.n2.paid, true);
      assert.deepEqual(plan.nodes.n2.estimate, { usd: 0.5 });
      assert.equal(plan.totals.usd, 0.5);

      // the workflow's own backing session receives the job; a completer plays the poller
      const backing = workflow.sessionId;
      const submitsBefore = falCalls.submit.length;
      const completer = setInterval(async () => {
        let current;
        try {
          current = await store.readSession(backing);
        } catch (_) {
          return;
        }
        for (const job of current.jobs) {
          if (job.source !== 'fal' || job.status !== 'pending') continue;
          await store.completeAsset(backing, job.assetId, Buffer.from('fake-mp4'), 0.5);
          await store.mutateSession(backing, (s) => {
            const target = s.jobs.find((entry) => entry.assetId === job.assetId);
            target.status = 'completed';
            target.resultAssetIds = [job.assetId];
            target.expanded_prompt = 'expanded by fal';
          });
        }
      }, 10);
      try {
        const runId = await engine.start(workflow.id, { mode: 'all', user: 'tester' });
        const record = await engine.whenFinished(workflow.id, runId);
        assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
        assert.equal(falCalls.submit.length, submitsBefore + 1);
        assert.equal(lastSubmit().input.prompt, 'A lighthouse in a storm');
        assert.equal(lastSubmit().input.duration, 10);
        const results = await wfStore.readResults(workflow.id);
        const variant = results.nodes.n2.history[0].variants[0];
        assert.equal(variant.video.type, 'video');
        assert.equal(variant.expanded_prompt.value, 'expanded by fal');
        assert.equal(results.nodes.n2.history[0].cost.usd, 0.5);
        const cached = await engine.plan(workflow.id, { mode: 'all' });
        assert.equal(cached.nodes.n2.status, 'cached');
      } finally {
        clearInterval(completer);
      }
      // a node with an unmet requirement fails in the plan, not at the provider
      hasKey = false;
      const unavailable = await engine.plan(workflow.id, { mode: 'all', force: true });
      assert.equal(unavailable.nodes.n2.status, 'unavailable');
      assert.match(unavailable.nodes.n2.reason, /FAL_KEY/);
      hasKey = true;
      void jobs;
    }

    console.log('test-nodes-fal: ok');
  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
