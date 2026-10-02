'use strict';

// video.generate (WP28 part 2): the video node with a model choice. The model list (lib/video-node-models.js) is the one of the
// chat (lib/video-models.js: the configured model and the curated list, the same price estimate, the same duration and
// resolution a model really uses), the end frame only where the model takes one, the limits of the other inputs follow the
// model (WP31: limitBy / limitsFor), a node that does not fit is refused before anything is paid, and video.seedance stays
// as it was. Also: the option list of the server route, the model list in the page (node-ui.js, run without a DOM) and the
// texts of every code in German, English and Spanish. No provider is contacted: the video API, the model list of OpenRouter
// and the cost journal are replaced and restored in `finally`.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const costs = require('../lib/costs');
const discovery = require('../lib/discovery');
const publicrefs = require('../lib/publicrefs');
const tools = require('../lib/tools');
const videoModels = require('../lib/video-models');
const videoNodeModels = require('../lib/video-node-models');
const assets = require('../lib/nodes/assets');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const graphLib = require('../public/nodes/graph');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes } = require('../lib/nodes/routes');

const root = path.resolve(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const SEEDANCE = 'bytedance/seedance-2.5';
const SEEDANCE_FAST = 'bytedance/seedance-2.0-fast';
const KLING = 'kwaivgi/kling-v3.0-std';
const WAN = 'alibaba/wan-2.7';
const VEO = 'google/veo-3.1-lite';
const FIRST_ONLY = 'vendor/first-only';
const NOT_LISTED = 'vendor/not-listed';

// The shape of GET https://openrouter.ai/api/v1/videos/models (checked 2026-10-02), reduced to what matters here. The prices
// are those of the list on that day.
const catalogEntry = (id, name, fields) => ({ id, name, supported_aspect_ratios: ['16:9', '9:16', '1:1'], generate_audio: true, ...fields });
const CATALOG = {
  data: [
    catalogEntry(SEEDANCE, 'ByteDance: Seedance 2.5', {
      supported_resolutions: ['480p', '720p'],
      supported_aspect_ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      supported_durations: Array.from({ length: 27 }, (_unused, index) => index + 4),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { video_tokens: '0.0000107', video_tokens_without_audio: '0.0000107', video_tokens_with_video_input: '0.0000064' }
    }),
    catalogEntry(SEEDANCE_FAST, 'ByteDance: Seedance 2.0 Fast', {
      supported_resolutions: ['480p', '720p'],
      supported_durations: Array.from({ length: 12 }, (_unused, index) => index + 4),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { video_tokens: '0.0000042', video_tokens_without_audio: '0.0000042', video_tokens_with_video_input: '0.000002475' }
    }),
    catalogEntry(KLING, 'Kling: Video v3.0 Standard', {
      supported_resolutions: ['720p'],
      supported_durations: Array.from({ length: 13 }, (_unused, index) => index + 3),
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126', text_to_video_duration_seconds_720p: '0.084', image_to_video_duration_seconds_720p: '0.084' }
    }),
    catalogEntry(WAN, 'Alibaba: Wan 2.7', {
      supported_resolutions: ['720p', '1080p'],
      supported_durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds: '0.1' }
    }),
    catalogEntry(VEO, 'Google: Veo 3.1 Lite', {
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_durations: [8, 4, 6],
      supported_frame_images: ['first_frame', 'last_frame'],
      pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05', duration_seconds_with_audio_720p: '0.05', duration_seconds_without_audio_720p: '0.03' }
    }),
    // a model of the operator that takes a first frame only and has no profile in the app
    catalogEntry(FIRST_ONLY, 'Vendor: First Only', {
      supported_resolutions: ['720p', '1080p'],
      supported_durations: [5, 10],
      supported_frame_images: ['first_frame'],
      pricing_skus: { duration_seconds: '0.2' }
    })
  ]
};
const CONFIG = { imageModel: 'openai/gpt-image-2', videoModel: SEEDANCE, defaultBrain: 'vendor/default-brain' };

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function withEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

const text = (value) => ({ type: 'text', value });
const list = (of, items) => ({ type: 'list', of, items });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects of a vm have another prototype
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'amount'}: ${actual} is not ${expected}`);

// Completes the open jobs of a session like the poller does (asset first, then the job record).
function startJobCompleter(sessionId, { cost = null, fail = null, errorCode = null } = {}) {
  let stopped = false;
  const handled = new Set();
  const timer = setInterval(async () => {
    if (stopped) return;
    let session;
    try {
      session = await store.readSession(sessionId);
    } catch (_) {
      return;
    }
    for (const job of session.jobs) {
      if (job.status !== 'pending' || handled.has(job.jobId)) continue;
      handled.add(job.jobId);
      if (fail) {
        await store.mutateSession(sessionId, (s) => {
          const target = s.jobs.find((entry) => entry.jobId === job.jobId);
          target.status = 'failed';
          target.error = fail;
          if (errorCode) target.errorCode = errorCode;
        });
        continue;
      }
      await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), cost);
      await store.mutateSession(sessionId, (s) => {
        s.jobs.find((entry) => entry.jobId === job.jobId).status = 'completed';
      });
    }
  }, 10);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/* ---------- lib/video-node-models.js ---------- */

async function testModelLibrary() {
  videoNodeModels.reset();
  // nothing read yet: names are known, limits of the chat profiles too, prices and frames are not
  assert.equal(videoNodeModels.displayName(SEEDANCE), 'Seedance 2.5');
  assert.equal(videoNodeModels.displayName(KLING), 'Kling v3.0 Standard');
  assert.equal(videoNodeModels.displayName(''), '');
  assert.deepEqual(plain(videoNodeModels.limits(SEEDANCE)), { images: 30, videos: 10, audios: 10, firstFrame: null, lastFrame: null });
  assert.deepEqual(plain(videoNodeModels.limits(KLING)), { images: 0, videos: 0, audios: 0, firstFrame: null, lastFrame: null }, 'the profile of the chat: Kling takes no references');
  assert.deepEqual(plain(videoNodeModels.limits(FIRST_ONLY)), { images: null, videos: null, audios: null, firstFrame: null, lastFrame: null }, 'not known is not 0');
  assert.equal(videoNodeModels.limits(''), null);
  assert.equal(videoNodeModels.estimate(SEEDANCE, { duration: 5 }), null, 'no price before the list is read');
  assert.deepEqual(plain(videoNodeModels.settings(SEEDANCE, { duration: 5 })), { known: false, duration: 5 });

  let calls = 0;
  patch(discovery, 'listVideoModels', async () => {
    calls += 1;
    return CATALOG;
  });
  await videoNodeModels.load();
  assert.equal(calls, 1);
  // frames from the list: 1 = takes it, 0 = does not
  assert.equal(videoNodeModels.limits(SEEDANCE).lastFrame, 1);
  assert.equal(videoNodeModels.limits(FIRST_ONLY).lastFrame, 0);
  assert.equal(videoNodeModels.limits(FIRST_ONLY).firstFrame, 1);
  assert.equal(videoNodeModels.limits(NOT_LISTED).lastFrame, null);
  assert.equal(videoNodeModels.peek(KLING).id, KLING);
  assert.equal(videoNodeModels.peek(NOT_LISTED), null);
  assert.equal(videoNodeModels.displayName(FIRST_ONLY), 'First Only', 'the name of the list without the provider');
  await videoNodeModels.load();
  assert.equal(calls, 2);

  // the models of a node: the configured one first, then the curated list of the chat
  assert.deepEqual(videoNodeModels.allowedModels({ videoModel: FIRST_ONLY }), [FIRST_ONLY, ...videoModels.CURATED_MODEL_IDS]);
  assert.deepEqual(videoNodeModels.allowedModels({ videoModel: SEEDANCE }), [...videoModels.CURATED_MODEL_IDS]);
  assert.deepEqual(videoNodeModels.allowedModels({}), [...videoModels.CURATED_MODEL_IDS]);
  assert.equal(videoNodeModels.isAllowed(CONFIG, KLING), true);
  assert.equal(videoNodeModels.isAllowed(CONFIG, NOT_LISTED), false);
  assert.equal(videoNodeModels.isAllowed(CONFIG, FIRST_ONLY), false, 'a model of the list that neither the chat nor the configuration names');
  assert.equal(videoNodeModels.isAllowed({ videoModel: FIRST_ONLY }, FIRST_ONLY), true, 'the model of the configuration is always allowed');
  assert.equal(videoNodeModels.isAllowed(CONFIG, ''), false);

  // duration and resolution as the chat decides (effectiveDuration, effectiveResolution)
  const seed = videoNodeModels.settings(SEEDANCE, { duration: 99, resolution: 'auto' });
  assert.deepEqual([seed.known, seed.duration, seed.resolution], [true, 30, '720p'], 'a range clamps, "auto" is 720p where the model has it');
  assert.equal(videoNodeModels.settings(SEEDANCE, { duration: 1, resolution: '' }).duration, 4);
  assert.equal(videoNodeModels.settings(SEEDANCE, { duration: 6, resolution: '480p' }).resolution, '480p');
  assert.deepEqual(plain(videoNodeModels.settings(SEEDANCE, { duration: 6, resolution: '1080p' })), { error: 'resolution', values: ['480p', '720p'] });
  assert.deepEqual(plain(videoNodeModels.settings(VEO, { duration: 5, resolution: 'auto' })), { error: 'duration', values: [4, 6, 8] }, 'fixed lengths are not guessed');
  assert.equal(videoNodeModels.settings(VEO, { duration: 6, resolution: 'auto' }).duration, 6);
  assert.equal(videoNodeModels.settings(KLING, { duration: 5, resolution: 'auto' }).resolution, '720p');
  assert.equal(videoNodeModels.settings(NOT_LISTED, { duration: 5 }).known, false);

  // the price is the estimate of the chat for the same job; the upper end is what the budget reserves
  const chat = (id, job) => videoModels.priceEstimate(CATALOG.data.find((item) => item.id === id), job);
  const jobOf = (duration, resolution, extra = {}) => ({ duration, resolution, mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false, ...extra });
  for (const [id, duration, resolution] of [[SEEDANCE, 5, '720p'], [SEEDANCE, 12, '480p'], [KLING, 5, '720p'], [WAN, 7, '720p'], [VEO, 4, '720p'], [SEEDANCE_FAST, 8, '720p']]) {
    const priced = videoNodeModels.estimate(id, { duration, resolution });
    assert.deepEqual(priced.price, chat(id, jobOf(duration, resolution)), `${id}: the estimate of the chat`);
    assert.equal(priced.option.estimateUsd, priced.price.maxTotal);
    assert.deepEqual([priced.duration, priced.resolution], [duration, resolution]);
  }
  near(videoNodeModels.estimate(KLING, { duration: 5, resolution: 'auto' }).option.estimateUsd, 0.63, 'Kling, 5 s: up to 0.126 per second');
  near(videoNodeModels.estimate(WAN, { duration: 5 }).option.estimateUsd, 0.5, 'Wan, 5 s');
  near(videoNodeModels.estimate(VEO, { duration: 4 }).option.estimateUsd, 0.32, 'Veo, 4 s: up to 0.08 per second');
  assert.equal(videoNodeModels.estimate(KLING, { duration: 5 }).option.name, 'Kling v3.0 Standard');
  // a video as reference is priced like in the chat (own token price), a first frame as image to video
  assert.deepEqual(videoNodeModels.estimate(SEEDANCE, { duration: 5, refVideos: true }).price, chat(SEEDANCE, jobOf(5, '720p', { hasVideoInput: true })));
  assert.ok(videoNodeModels.estimate(SEEDANCE, { duration: 5, refVideos: true }).price.minTotal < videoNodeModels.estimate(SEEDANCE, { duration: 5 }).price.minTotal, 'the lower end follows the video input');
  assert.deepEqual(videoNodeModels.estimate(KLING, { duration: 5, firstFrame: true }).price, chat(KLING, jobOf(5, '720p', { mode: 'image_to_video', aspectRatio: '' })));
  // unknown stays unknown (null), never 0
  assert.equal(videoNodeModels.estimate(NOT_LISTED, { duration: 5 }), null);
  assert.equal(videoNodeModels.estimate(VEO, { duration: 5 }), null, 'a length the model does not offer: no price');
  assert.equal(videoNodeModels.estimate(SEEDANCE, { duration: 5, resolution: '1080p' }), null);
  assert.equal(videoNodeModels.estimate('', { duration: 5 }), null);
  patch(discovery, 'listVideoModels', async () => ({ data: [{ id: 'free/model', name: 'Free', supported_durations: [5], supported_resolutions: ['720p'], pricing_skus: { duration_seconds: '0' } }] }));
  videoNodeModels.reset();
  await videoNodeModels.load();
  assert.equal(videoNodeModels.estimate('free/model', { duration: 5 }), null, 'a price of 0 is no estimate');
  assert.equal(videoNodeModels.estimate('free/model', { duration: 5, resolution: 'auto' }), null);

  // the option list: the entry "no choice" first, the curated models the list knows, what each takes
  patch(discovery, 'listVideoModels', async () => CATALOG);
  videoNodeModels.reset();
  const entries = await videoNodeModels.options({ config: CONFIG, ceilings: { refs: 30, videos: 10, audios: 10 } });
  assert.deepEqual(entries.map((item) => item.value), ['', SEEDANCE, SEEDANCE_FAST, KLING, WAN, VEO], 'the order of the chat; models the list does not know are left out');
  assert.deepEqual(entries[0], { ...entries[1], value: '', default: true }, 'the default entry says the same as the model of the configuration');
  const byId = (id) => entries.find((item) => item.value === id);
  assert.deepEqual(plain(byId(SEEDANCE)), {
    value: SEEDANCE,
    label: 'Seedance 2.5',
    references: { max: 30, roles: [], required: false },
    videos: { max: 10 },
    audio: { max: 10 },
    last_frame: { max: 1 },
    durations: { min: 4, max: 30 },
    perSecondUsd: { min: 0.23112, max: 0.23112 }
  });
  assert.deepEqual(plain(byId(VEO).durations), { values: [4, 6, 8] });
  assert.deepEqual(plain(byId(VEO).references), { max: 0, roles: [], required: false }, 'takes none: said, not left out');
  assert.deepEqual(plain(byId(VEO).perSecondUsd), { min: 0.03, max: 0.08 });
  assert.deepEqual(plain(byId(KLING).perSecondUsd), { min: 0.084, max: 0.126 });
  assert.deepEqual(plain(byId(WAN).references), { max: 5, roles: [], required: false });
  assert.equal(byId(WAN).videos.max, 0);
  // the ceiling of the inputs wins over a larger limit of the model
  const capped = await videoNodeModels.options({ config: CONFIG, ceilings: { refs: 8, videos: 2, audios: 1 } });
  assert.deepEqual(plain(capped[1].references), { max: 8, roles: [], required: false });
  assert.deepEqual([capped[1].videos.max, capped[1].audio.max], [2, 1]);
  // a model of the configuration without a profile: said what is known, nothing about references
  const operator = await videoNodeModels.options({ config: { videoModel: FIRST_ONLY } });
  assert.deepEqual(operator.map((item) => item.value), ['', FIRST_ONLY, SEEDANCE, SEEDANCE_FAST, KLING, WAN, VEO]);
  assert.deepEqual(plain(operator[0]), { value: '', label: 'First Only', last_frame: { max: 0 }, durations: { values: [5, 10] }, perSecondUsd: { min: 0.2, max: 0.2 }, default: true });
  assert.equal('references' in operator[0], false, 'unknown: no claim');

  // an unreadable list: only the configured model is offered, no new attempt for a minute
  videoNodeModels.reset();
  calls = 0;
  patch(discovery, 'listVideoModels', async () => {
    calls += 1;
    throw new Error('no network');
  });
  await videoNodeModels.load();
  await videoNodeModels.load();
  assert.equal(calls, 1, 'a failed read is not repeated at once');
  const unreadable = await videoNodeModels.options({ config: CONFIG });
  assert.deepEqual(unreadable.map((item) => item.value), ['']);
  assert.equal(unreadable[0].label, 'Seedance 2.5');
  assert.equal(unreadable[0].references.max, 30, 'the chat profile still speaks');
  assert.equal('last_frame' in unreadable[0], false, 'the frames are not known without the list');
  assert.deepEqual(await videoNodeModels.options({ config: {} }), [], 'no model at all: nothing');
  // a slow list does not hold anything back
  videoNodeModels.reset();
  patch(discovery, 'listVideoModels', () => new Promise(() => {}));
  const started = Date.now();
  await videoNodeModels.load({ timeoutMs: 40 });
  assert.ok(Date.now() - started < 2000, 'load() gives up');
  videoNodeModels.reset();
}

// The model list of the chat for the same job, with the same list of the provider.
async function testSameAsChat() {
  videoNodeModels.reset();
  patch(discovery, 'listVideoModels', async () => CATALOG);
  const args = { prompt: 'x', mode: 'text_to_video', duration_seconds: 8, resolution: '720p', aspect_ratio: '16:9' };
  const { options } = await videoModels.listOptions(args, SEEDANCE);
  assert.ok(options.length >= 4);
  await videoNodeModels.load();
  for (const option of options) {
    const own = videoNodeModels.estimate(option.id, { duration: 8, resolution: '720p', aspectRatio: '16:9' });
    assert.ok(own, option.id);
    assert.deepEqual(plain(own.price), plain(option.price), `${option.id}: the same price estimate as the card of the chat`);
    assert.equal(own.option.estimateUsd, option.estimateUsd, `${option.id}: and the same amount reserved`);
    assert.equal(own.option.name, option.name);
    assert.deepEqual([own.duration, own.resolution], [option.durationSeconds, option.resolution]);
  }
  // the models the card leaves out because the job does not fit are the ones the node refuses (Veo: no 5 s)
  const five = await videoModels.listOptions({ ...args, duration_seconds: 5 }, SEEDANCE);
  assert.equal(five.options.some((option) => option.id === VEO), false);
  assert.equal(videoNodeModels.settings(VEO, { duration: 5 }).error, 'duration');
  assert.equal(five.options.some((option) => option.id === KLING), true);
  assert.equal(videoNodeModels.settings(KLING, { duration: 5 }).error, undefined);
}

/* ---------- the nodes ---------- */

async function main() {
  await testModelLibrary();
  await testSameAsChat();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-video-generate-'));
  const bus = createEventBus();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const created = [];
  const journal = [];
  try {
    const { workflow: base } = await wfStore.createWorkflow({ name: 'Video models', graph: { nodes: [], edges: [] } });
    created.push(base.id);
    const sessionId = base.sessionId;
    const upload = async (ext = '.png', buffer = PNG) => assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer, ext, prompt: 'seed', cost: null })).id);
    const image1 = await upload();
    const image2 = await upload();
    const image3 = await upload();
    const video1 = await upload('.mp4', Buffer.from('fake-mp4'));
    const audio1 = await upload('.mp3', Buffer.from('fake-mp3'));

    const payloads = [];
    const removedRefs = [];
    let jobCounter = 0; // provider job ids are unique in the session, like the real ones
    function baseMocks() {
      restoreAll();
      patch(or, 'hasKey', () => true);
      patch(costs, 'recordCost', async (record) => {
        journal.push(record);
        return record;
      });
      // the list of OpenRouter is read by the node (lib/video-node-models.js), the chat model cards and the capabilities of the tool
      patch(or, 'listVideoModels', async () => CATALOG);
      patch(discovery, 'listImageModels', async () => ({ data: [] }));
      discovery.resetVideoModelCache();
      patch(publicrefs, 'publishAsset', async (_session, assetId) => ({ url: `https://example.test/refs/${assetId}.png`, file: `${assetId}.png` }));
      patch(publicrefs, 'removeRef', async (file) => {
        removedRefs.push(file);
        return true;
      });
      withEnv('PUBLIC_BASE_URL', undefined);
      patch(or, 'createVideo', async (payload) => {
        payloads.push(payload);
        jobCounter += 1;
        return { id: `vid-job-${jobCounter}`, status: 'pending' };
      });
      videoNodeModels.reset();
      payloads.length = 0;
      journal.length = 0;
    }
    const makeCtx = (config = CONFIG) => {
      const controller = new AbortController();
      const runtime = { ...config };
      const toolEvents = [];
      const logs = [];
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: runtime,
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: runtime, user: 'tester', emit: (event) => toolEvents.push(event) },
        log: (label) => logs.push(label),
        waitForJob: (job) =>
          require('../lib/nodes/jobs').waitForSessionJob(sessionId, typeof job === 'string' ? job : job.jobId, {
            assetId: typeof job === 'string' ? undefined : job.assetId,
            signal: controller.signal,
            intervalMs: 20,
            timeoutMs: 8000
          }),
        withLocalSlot: (fn) => fn(),
        toolEvents,
        logs,
        controller
      };
    };
    const def = (type) => {
      const found = registry.get(type);
      assert.ok(found, `${type} is registered`);
      return found;
    };
    const run = (ctx, inputs, rawParams = {}) => def('video.generate').execute(ctx, inputs, registry.normalizeParams(def('video.generate'), rawParams));
    // runs a node and lets a poller finish its job
    const runWithJob = async (ctx, inputs, rawParams = {}, completer = {}) => {
      const stop = startJobCompleter(sessionId, completer);
      try {
        return await run(ctx, inputs, rawParams);
      } finally {
        stop();
      }
    };
    const issuesOf = (rawParams, ports = {}) => {
      const node = def('video.generate');
      return (node.validate(registry.normalizeParams(node, rawParams), ports) || []).map((issue) => (typeof issue === 'string' ? { level: 'error', message: issue } : { level: 'error', ...issue }));
    };
    const connected = (counts) => Object.fromEntries(Object.entries(counts).map(([port, count]) => [port, { connected: count > 0, count }]));

    /* ----- descriptors: a new type, video.seedance as it was ----- */
    {
      baseMocks();
      const node = def('video.generate');
      assert.equal(node.category, 'video');
      assert.equal(node.label, 'Generate video');
      assert.equal(node.paid, true);
      assert.equal(node.async, true);
      assert.equal(node.cost.unit, 'usd');
      assert.equal(node.cost.history, false, 'the price is read per model, never from the last video of the type');
      assert.equal(typeof node.cost.estimate, 'function');
      assert.equal(typeof node.prepare, 'function');
      assert.equal(typeof node.limitsFor, 'function');
      assert.deepEqual(node.inputs.map((port) => port.id), ['prompt', 'first_frame', 'last_frame', 'refs', 'ref_videos', 'ref_audios']);
      assert.deepEqual(node.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
      assert.deepEqual(node.params.map((param) => param.id), ['model', 'prompt', 'duration', 'aspect_ratio', 'resolution']);
      const model = node.params[0];
      assert.deepEqual([model.kind, model.optionsSource, model.default], ['select', 'video-models', '']);
      const limitedBy = (id) => node.inputs.find((port) => port.id === id).limitBy;
      assert.deepEqual(limitedBy('last_frame'), { param: 'model', capability: 'last_frame' });
      assert.deepEqual(limitedBy('refs'), { param: 'model', capability: 'references' });
      assert.deepEqual(limitedBy('ref_videos'), { param: 'model', capability: 'videos' });
      assert.deepEqual(limitedBy('ref_audios'), { param: 'model', capability: 'audio' });
      assert.equal(node.inputs.find((port) => port.id === 'first_frame').limitBy, undefined);
      assert.deepEqual(node.inputs.filter((port) => port.limitBy).map((port) => port.max), [1, 30, 10, 10], 'the fixed maxima stay the ceilings');
      assert.equal(node.inputs.find((port) => port.id === 'prompt').required, true);
      assert.equal(node.params.find((param) => param.id === 'aspect_ratio').showIf.port, 'first_frame');
      assert.deepEqual(node.params.find((param) => param.id === 'resolution').options, ['auto', '480p', '720p', '1080p']);
      assert.equal(registry.normalizeParams(node, {}).model, '', 'no choice by default: the model of the configuration');
      assert.equal(registry.normalizeParams(node, {}).resolution, 'auto');
      assert.equal(registry.normalizeParams(node, { duration: 99 }).duration, 30);
      assert.deepEqual(registry.checkParams(node, registry.normalizeParams(node, { resolution: '480p' })), []);
      assert.equal(registry.checkParams(node, registry.normalizeParams(node, { resolution: '8k' })).length, 1);

      // the Seedance node stays as it was: same ports, same params, no model
      const seedance = def('video.seedance');
      assert.equal(seedance.label, 'Generate video (Seedance)');
      assert.deepEqual(seedance.inputs.map((port) => port.id), ['prompt', 'first_frame', 'refs', 'ref_videos', 'ref_audios']);
      assert.deepEqual(seedance.params.map((param) => param.id), ['prompt', 'duration', 'aspect_ratio', 'resolution']);
      assert.ok(seedance.inputs.every((port) => !port.limitBy));
      assert.equal(seedance.limitsFor, undefined);
      assert.equal(seedance.cost.history, true);
      assert.deepEqual(seedance.params.find((param) => param.id === 'resolution').options, tools.VIDEO_RESOLUTIONS);
      // the descriptor the page gets
      const descriptor = plain(registry.publicDescriptor(node));
      assert.equal(descriptor.cost.hasEstimate, true);
      assert.deepEqual(descriptor.inputs.filter((port) => port.limitBy).map((port) => port.id), ['last_frame', 'refs', 'ref_videos', 'ref_audios']);
    }

    /* ----- the limits follow the model: end frame, references, videos, audio ----- */
    {
      baseMocks();
      await videoNodeModels.load();
      const portsOf = (params) => registry.portsFor(def('video.generate'), params).inputs;
      const portOf = (params, id) => portsOf(params).find((port) => port.id === id);
      // end frame: one where the model takes it, none where it does not, unknown while the list does not say
      assert.deepEqual(plain(portOf({ model: SEEDANCE }, 'last_frame').limit), { known: true, max: 1, roles: [], required: false, subject: 'Seedance 2.5' });
      assert.deepEqual(plain(portOf({ model: FIRST_ONLY }, 'last_frame')), { ...plain(portOf({ model: FIRST_ONLY }, 'last_frame')), max: 0, limit: { known: true, max: 0, roles: [], required: false, subject: 'First Only' } });
      assert.equal(portOf({ model: FIRST_ONLY }, 'last_frame').max, 0, 'an input with a limit of 0 takes no connection');
      assert.deepEqual(plain(portOf({ model: NOT_LISTED }, 'last_frame').limit), { known: false });
      assert.equal(portOf({ model: NOT_LISTED }, 'last_frame').max, 1, 'unknown: the fixed maximum');
      assert.deepEqual(plain(portOf({}, 'last_frame').limit), { known: false }, 'no choice: the server cannot tell, the run checks the configured model');
      // references, videos, audio: the profiles of the chat
      assert.equal(portOf({ model: SEEDANCE }, 'refs').max, 30);
      assert.equal(portOf({ model: SEEDANCE_FAST }, 'refs').max, 9);
      assert.equal(portOf({ model: SEEDANCE_FAST }, 'ref_videos').max, 3);
      assert.equal(portOf({ model: SEEDANCE_FAST }, 'ref_audios').max, 3);
      assert.equal(portOf({ model: WAN }, 'refs').max, 5);
      assert.equal(portOf({ model: WAN }, 'ref_videos').max, 0);
      assert.equal(portOf({ model: KLING }, 'refs').max, 0);
      assert.equal(portOf({ model: VEO }, 'ref_audios').max, 0);
      assert.deepEqual(plain(portOf({ model: FIRST_ONLY }, 'refs').limit), { known: false }, 'a model without a profile: not claimed');
      assert.equal(portOf({ model: FIRST_ONLY }, 'refs').max, 30);
      // the first frame and the prompt have no limit that follows the model
      assert.equal(portOf({ model: KLING }, 'first_frame').limit, undefined);
      assert.equal(portOf({ model: KLING }, 'prompt').limit, undefined);
      // limitsFor on its own (what the page asks for, in the same words)
      assert.deepEqual(plain(def('video.generate').limitsFor({ model: WAN })), {
        refs: { max: 5, roles: [], required: false, subject: 'Wan 2.7' },
        ref_videos: { max: 0, roles: [], required: false, subject: 'Wan 2.7' },
        ref_audios: { max: 0, roles: [], required: false, subject: 'Wan 2.7' },
        last_frame: { max: 1, roles: [], required: false, subject: 'Wan 2.7' }
      });
      assert.deepEqual(plain(def('video.generate').limitsFor({})), {});
      assert.deepEqual(plain(def('video.generate').limitsFor({ model: NOT_LISTED })), {});
    }

    /* ----- validation before the run ----- */
    {
      baseMocks();
      await videoNodeModels.load();
      const codes = (issues) => issues.map((issue) => issue.code);
      withEnv('PUBLIC_BASE_URL', 'https://example.test'); // the warning about the public address has its own part below
      assert.deepEqual(issuesOf({ model: SEEDANCE }, connected({ first_frame: 1, last_frame: 1, refs: 0 })), []);
      // an end frame needs a first frame (with and without a model chosen)
      for (const model of [SEEDANCE, '']) {
        const lonely = issuesOf({ model }, connected({ last_frame: 1 }));
        assert.deepEqual(codes(lonely), ['VIDEO_LAST_FRAME_NEEDS_FIRST'], `model "${model}"`);
        assert.equal(lonely[0].port, 'last_frame');
      }
      // a model that takes no end frame, no first frame, fewer references than connected
      const noEnd = issuesOf({ model: FIRST_ONLY }, connected({ first_frame: 1, last_frame: 1 }));
      assert.deepEqual(codes(noEnd), ['VIDEO_LAST_FRAME_UNSUPPORTED']);
      assert.deepEqual([noEnd[0].port, noEnd[0].data], ['last_frame', { model: 'First Only' }]);
      assert.match(noEnd[0].message, /Model First Only takes no end frame/);
      assert.deepEqual(issuesOf({ model: FIRST_ONLY }, connected({ first_frame: 1 })), []);
      const refs = issuesOf({ model: WAN }, connected({ refs: 6 }));
      assert.deepEqual(codes(refs), ['too_many_refs']);
      assert.deepEqual([refs[0].port, refs[0].data], ['refs', { model: 'Wan 2.7', max: 5, count: 6 }]);
      assert.match(refs[0].message, /Model Wan 2.7 accepts at most 5 reference images \(got 6\)/);
      assert.deepEqual(codes(issuesOf({ model: KLING }, connected({ refs: 1 }))), ['too_many_refs']);
      assert.deepEqual(issuesOf({ model: KLING }, connected({ refs: 1 }))[0].data, { model: 'Kling v3.0 Standard', max: 0, count: 1 });
      assert.deepEqual(issuesOf({ model: FIRST_ONLY }, connected({ refs: 30 })), [], 'no limit known: only the fixed maximum');
      const videosOver = issuesOf({ model: WAN }, connected({ ref_videos: 1 }));
      assert.deepEqual(codes(videosOver), ['VIDEO_TOO_MANY_REF_VIDEOS']);
      assert.deepEqual([videosOver[0].port, videosOver[0].data], ['ref_videos', { model: 'Wan 2.7', max: 0, count: 1 }]);
      assert.deepEqual(codes(issuesOf({ model: SEEDANCE_FAST }, connected({ ref_audios: 4 }))), ['VIDEO_TOO_MANY_REF_AUDIOS']);
      assert.deepEqual(issuesOf({ model: SEEDANCE_FAST }, connected({ ref_audios: 3 })), []);
      // the fixed maxima keep their words and are not reported twice
      assert.deepEqual(issuesOf({ model: SEEDANCE }, connected({ refs: 31 })).map((issue) => issue.message), ['refs: at most 30 references are allowed']);
      assert.deepEqual(issuesOf({}, connected({ refs: 31 })).map((issue) => issue.message), ['refs: at most 30 references are allowed']);
      assert.deepEqual(issuesOf({}, connected({ ref_videos: 11 })).map((issue) => issue.message), ['ref_videos: at most 10 are allowed']);
      assert.deepEqual(issuesOf({}, connected({ ref_audios: 11 })).map((issue) => issue.message), ['ref_audios: at most 10 are allowed']);
      assert.deepEqual(issuesOf({}, connected({ first_frame: 1, last_frame: 2 })).map((issue) => issue.message), ['last_frame: at most 1 end frame is allowed']);
      // no choice: nothing is known before the run (the configured model is checked then)
      assert.deepEqual(issuesOf({}, connected({ first_frame: 1, last_frame: 1, refs: 12, ref_videos: 3 })).filter((issue) => issue.level === 'error' && !issue.code?.startsWith('VIDEO_FRAMES')), []);
      // duration and resolution the model does not offer
      const fixed = issuesOf({ model: VEO, duration: 5 }, {});
      assert.deepEqual(codes(fixed), ['VIDEO_DURATION_UNSUPPORTED']);
      assert.deepEqual(fixed[0].data, { model: 'Veo 3.1 Lite', values: '4, 6, 8' });
      assert.deepEqual(issuesOf({ model: VEO, duration: 6 }, {}), []);
      assert.deepEqual(issuesOf({ model: SEEDANCE, duration: 99 }, {}), [], 'a range takes the nearest value');
      const resolution = issuesOf({ model: SEEDANCE, resolution: '1080p' }, {});
      assert.deepEqual(codes(resolution), ['VIDEO_RESOLUTION_UNSUPPORTED']);
      assert.deepEqual(resolution[0].data, { model: 'Seedance 2.5', values: '480p, 720p' });
      assert.deepEqual(issuesOf({ model: KLING, resolution: 'auto' }, {}), []);
      // the aspect ratio of a text to video job: a ratio the model does not list is refused, like the duration (the chat does not
      // offer such a model for it either); with a first frame the frame defines the format
      const ratio = issuesOf({ model: KLING, aspect_ratio: '21:9' }, {});
      assert.deepEqual(codes(ratio), ['VIDEO_ASPECT_RATIO_UNSUPPORTED']);
      assert.deepEqual(ratio[0].data, { model: 'Kling v3.0 Standard', values: '16:9, 9:16, 1:1' });
      assert.match(ratio[0].message, /Model Kling v3.0 Standard takes only these aspect ratios: 16:9, 9:16, 1:1/);
      assert.deepEqual(codes(issuesOf({ model: VEO, duration: 6, aspect_ratio: '4:3' }, {})), ['VIDEO_ASPECT_RATIO_UNSUPPORTED']);
      assert.deepEqual(issuesOf({ model: VEO, duration: 6, aspect_ratio: '9:16' }, {}), []);
      assert.deepEqual(issuesOf({ model: SEEDANCE, aspect_ratio: '21:9' }, {}), [], 'a model that lists the ratio takes it');
      assert.deepEqual(issuesOf({ model: KLING, aspect_ratio: '21:9' }, connected({ first_frame: 1 })), [], 'the first frame defines the format');
      // frames and references together: the provider may ignore the references (warning, not an error)
      const both = issuesOf({ model: SEEDANCE }, connected({ first_frame: 1, refs: 1 }));
      assert.deepEqual(both.map((issue) => [issue.code, issue.level]), [['VIDEO_FRAMES_PRECEDE_REFS', 'warning']]);
      assert.deepEqual(issuesOf({ model: SEEDANCE }, connected({ refs: 1 })), []);
      // video and audio references need a public address (as at video.seedance)
      assert.deepEqual(issuesOf({}, connected({ ref_videos: 1 })), []);
      withEnv('PUBLIC_BASE_URL', undefined);
      const warned = issuesOf({}, connected({ ref_videos: 1 }));
      assert.deepEqual(warned.map((issue) => [issue.code, issue.level]), [['public_base_url', 'warning']]);
    }

    /* ----- running: default, chosen model, the payload, the end frame ----- */
    {
      baseMocks();
      // an old-style call without a model: the configured model, 5 s, the resolution the model decides
      let result = await runWithJob(makeCtx(), { prompt: text('Slow push-in') }, {}, { cost: 0.55 });
      assert.equal(payloads.length, 1);
      assert.deepEqual(plain(payloads[0]), { model: SEEDANCE, prompt: 'Slow push-in', resolution: '720p', duration: 5, aspect_ratio: '16:9' });
      assert.equal(result.variants[0].video.type, 'video');
      assert.equal(result.variants[0].video.sessionId, sessionId);
      near(result.cost.usd, 0.55, 'the cost comes from the ledger the poller wrote');

      // a chosen model reaches the provider; the configuration itself is not touched
      payloads.length = 0;
      const chosenCtx = makeCtx();
      result = await runWithJob(chosenCtx, { prompt: text('A walk') }, { model: KLING, duration: 8, aspect_ratio: '9:16' }, { cost: 0.7 });
      assert.deepEqual(plain(payloads[0]), { model: KLING, prompt: 'A walk', resolution: '720p', duration: 8, aspect_ratio: '9:16' });
      assert.equal(chosenCtx.config.videoModel, SEEDANCE, 'config.videoModel is not changed by a node');
      assert.equal(chosenCtx.toolCtx.config.videoModel, SEEDANCE);
      const session = await store.readSession(sessionId);
      const job = session.jobs.find((entry) => entry.assetId === result.variants[0].video.assetId);
      assert.equal(job.model, KLING, 'the job knows its model');
      assert.equal(job.modelName, 'Kling v3.0 Standard');
      near(job.estimateUsd, 0.084 * 8 * 1.5, 'and the estimate the budget reserved (the upper end)');
      near(job.estimateMinUsd, 0.084 * 8, 'with the lower end for the card');
      const ledger = await store.readLedger(sessionId);
      assert.equal(ledger.find((item) => item.id === result.variants[0].video.assetId).model, KLING);

      // the duration and the resolution the model uses (not the ones asked for)
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: SEEDANCE, duration: 99, resolution: '480p' });
      assert.deepEqual([payloads[0].duration, payloads[0].resolution], [30, '480p'], 'a range clamps');
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: VEO, duration: 6, resolution: '1080p' });
      assert.deepEqual([payloads[0].model, payloads[0].duration, payloads[0].resolution], [VEO, 6, '1080p']);
      // another configured model is what "no choice" means
      payloads.length = 0;
      await runWithJob(makeCtx({ ...CONFIG, videoModel: WAN }), { prompt: text('x') }, { duration: 6 });
      assert.deepEqual([payloads[0].model, payloads[0].duration], [WAN, 6]);
      // the model of the configuration written out is the same as no choice
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: SEEDANCE });
      assert.equal(payloads[0].model, SEEDANCE);

      // the notes of the tool (what it changed) reach the log of the run, as at the fal nodes
      {
        const original = tools.executeTool;
        patch(tools, 'executeTool', async (...args) => {
          const outcome = await original(...args);
          return { ...outcome, corrections: ['aspect_ratio probe note'] };
        });
        const loggedCtx = makeCtx();
        await runWithJob(loggedCtx, { prompt: text('x') }, { model: SEEDANCE });
        assert.deepEqual(loggedCtx.logs, ['aspect_ratio probe note']);
        tools.executeTool = original;
      }
      // a ratio the model lists goes to the provider as chosen
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: SEEDANCE, aspect_ratio: '21:9' });
      assert.equal(payloads[0].aspect_ratio, '21:9');

      // first frame: image to video, the format comes from the image; with an end frame both frames go along
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('Animate'), first_frame: image1 }, { model: SEEDANCE, aspect_ratio: '9:16' });
      assert.deepEqual(payloads[0].frame_images.map((frame) => frame.frame_type), ['first_frame']);
      assert.ok(!('aspect_ratio' in payloads[0]), 'the first frame defines the format');
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('Open'), first_frame: image1, last_frame: list('image', [image2]) }, { model: SEEDANCE });
      assert.deepEqual(payloads[0].frame_images.map((frame) => frame.frame_type), ['first_frame', 'last_frame']);
      assert.ok(payloads[0].frame_images.every((frame) => frame.type === 'image_url' && frame.image_url.url.startsWith('data:image/png;base64,')));
      assert.ok(!payloads[0].input_references, 'no references');
      // the end frame as a single value of a list connection works the same
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('Open'), first_frame: image1, last_frame: image2 }, { model: KLING });
      assert.equal(payloads[0].frame_images.length, 2);
      // references, videos and audio go along (public address set)
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      payloads.length = 0;
      await runWithJob(makeCtx(), { prompt: text('x'), refs: list('image', [image1, image2]), ref_videos: list('video', [video1]), ref_audios: list('audio', [audio1]) }, { model: SEEDANCE_FAST });
      assert.equal(payloads[0].input_references.length, 4);
      assert.deepEqual(payloads[0].input_references.map((item) => item.type), ['image_url', 'image_url', 'video_url', 'audio_url']);
      withEnv('PUBLIC_BASE_URL', undefined);

      // the chat has no end frame: the tool takes the argument only in the node view
      payloads.length = 0;
      const stop = startJobCompleter(sessionId);
      try {
        const chatCtx = { sessionId, config: { ...CONFIG }, emit() {}, user: 'tester', skipVideoModelLimits: true };
        const asset = (await store.saveAsset(sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'p', cost: null })).id;
        await tools.executeTool(chatCtx, 'generate_video', { prompt: 'x', mode: 'image_to_video', first_frame_asset_id: asset, last_frame_asset_id: asset });
        assert.deepEqual(payloads[0].frame_images.map((frame) => frame.frame_type), ['first_frame'], 'ignored outside the node view');
        await assert.rejects(
          tools.executeTool({ ...chatCtx, nodeView: true }, 'generate_video', { prompt: 'x', mode: 'text_to_video', last_frame_asset_id: asset }),
          /last_frame_asset_id braucht first_frame_asset_id/
        );
      } finally {
        stop();
      }
      assert.ok(!JSON.stringify(tools.toolDefinitions().filter((entry) => entry.function.name === 'generate_video')).includes('last_frame'), 'the Director is not told about it');
      // an aborted run does not start work
      payloads.length = 0;
      const aborted = makeCtx();
      aborted.controller.abort();
      await assert.rejects(run(aborted, { prompt: text('x') }, { model: KLING }), { name: 'AbortError' });
      assert.equal(payloads.length, 0);
    }

    /* ----- refused before anything is paid ----- */
    {
      baseMocks();
      const refuse = async (config, inputs, rawParams) => {
        payloads.length = 0;
        journal.length = 0;
        const error = await run(makeCtx(config), inputs, rawParams).catch((err) => err);
        assert.ok(error instanceof Error, 'the node was refused');
        assert.equal(payloads.length, 0, 'the provider was not called');
        assert.equal(journal.length, 0, 'nothing was booked');
        return error;
      };
      // a model from outside the list: a workflow from somebody else cannot name any model of the provider
      let error = await refuse(CONFIG, { prompt: text('x') }, { model: NOT_LISTED });
      assert.equal(error.code, 'VIDEO_MODEL_NOT_ALLOWED');
      assert.deepEqual(error.data, { model: NOT_LISTED });
      error = await refuse(CONFIG, { prompt: text('x') }, { model: FIRST_ONLY });
      assert.equal(error.code, 'VIDEO_MODEL_NOT_ALLOWED', 'in the list of OpenRouter, but not one of this server');
      // an end frame where the model takes none (the configured one, nothing chosen)
      error = await refuse({ ...CONFIG, videoModel: FIRST_ONLY }, { prompt: text('x'), first_frame: image1, last_frame: list('image', [image2]) }, {});
      assert.equal(error.code, 'VIDEO_LAST_FRAME_UNSUPPORTED');
      assert.deepEqual(error.data, { model: 'First Only' });
      // an end frame without a first frame
      error = await refuse(CONFIG, { prompt: text('x'), last_frame: list('image', [image2]) }, { model: KLING });
      assert.equal(error.code, 'VIDEO_LAST_FRAME_NEEDS_FIRST');
      // too many references, videos, audio for the model (the run names the codes without a port)
      error = await refuse(CONFIG, { prompt: text('x'), refs: list('image', [image1, image2, image3]) }, { model: KLING });
      assert.equal(error.code, 'TOO_MANY_REFERENCES');
      assert.deepEqual(error.data, { model: 'Kling v3.0 Standard', max: 0, count: 3 });
      assert.match(error.message, /Model Kling v3.0 Standard takes no reference images \(got 3\)/);
      error = await refuse(CONFIG, { prompt: text('x'), refs: list('image', Array(6).fill(image1)) }, { model: WAN });
      assert.deepEqual([error.code, error.data.max, error.data.count], ['TOO_MANY_REFERENCES', 5, 6]);
      error = await refuse(CONFIG, { prompt: text('x'), refs: list('image', Array(10).fill(image1)) }, { model: SEEDANCE_FAST });
      assert.match(error.message, /accepts at most 9 reference images \(got 10\)/);
      error = await refuse(CONFIG, { prompt: text('x'), ref_videos: list('video', [video1]) }, { model: WAN });
      assert.equal(error.code, 'VIDEO_TOO_MANY_REF_VIDEOS');
      assert.deepEqual(error.data, { model: 'Wan 2.7', max: 0, count: 1 });
      error = await refuse(CONFIG, { prompt: text('x'), ref_audios: list('audio', [audio1, audio1, audio1, audio1]) }, { model: SEEDANCE_FAST });
      assert.equal(error.code, 'VIDEO_TOO_MANY_REF_AUDIOS');
      // the configured model decides when nothing is chosen
      error = await refuse({ ...CONFIG, videoModel: VEO }, { prompt: text('x'), refs: list('image', [image1]) }, {});
      assert.equal(error.code, 'TOO_MANY_REFERENCES');
      // fixed lengths and resolutions the model does not offer: refused, not changed (the price depends on them)
      error = await refuse(CONFIG, { prompt: text('x') }, { model: VEO, duration: 5 });
      assert.equal(error.code, 'VIDEO_DURATION_UNSUPPORTED');
      assert.deepEqual(error.data, { model: 'Veo 3.1 Lite', values: '4, 6, 8' });
      error = await refuse(CONFIG, { prompt: text('x') }, { model: SEEDANCE, resolution: '1080p' });
      assert.equal(error.code, 'VIDEO_RESOLUTION_UNSUPPORTED');
      assert.deepEqual(error.data, { model: 'Seedance 2.5', values: '480p, 720p' });
      // an aspect ratio the model does not list: refused as well, not sent without it (the video would come in the format of the provider)
      error = await refuse(CONFIG, { prompt: text('x') }, { model: KLING, aspect_ratio: '21:9' });
      assert.equal(error.code, 'VIDEO_ASPECT_RATIO_UNSUPPORTED');
      assert.deepEqual(error.data, { model: 'Kling v3.0 Standard', values: '16:9, 9:16, 1:1' });
      error = await refuse(CONFIG, { prompt: text('x') }, { model: VEO, duration: 6, aspect_ratio: '4:3' });
      assert.equal(error.code, 'VIDEO_ASPECT_RATIO_UNSUPPORTED');
      error = await refuse({ ...CONFIG, videoModel: VEO }, { prompt: text('x') }, { duration: 6, aspect_ratio: '1:1' });
      assert.equal(error.code, 'VIDEO_ASPECT_RATIO_UNSUPPORTED', 'the configured model decides when nothing is chosen');
      // the fixed maxima of the inputs
      await assert.rejects(refuse(CONFIG, { prompt: text('x'), refs: list('image', Array(31).fill(image1)) }, {}).then((err) => Promise.reject(err)), /at most 30/);
      await assert.rejects(refuse(CONFIG, { prompt: text('x'), first_frame: image1, last_frame: list('image', [image2, image3]) }, { model: SEEDANCE }).then((err) => Promise.reject(err)), /at most 1/);
      // audio and video references need the public address, the tool says so before it submits
      error = await refuse(CONFIG, { prompt: text('x'), ref_videos: list('video', [video1]) }, { model: SEEDANCE });
      assert.match(error.message, /PUBLIC_BASE_URL/);
      // an image that belongs to another session is not used
      error = await refuse(CONFIG, { prompt: text('x'), first_frame: { ...image1, sessionId: 'other-session' } }, { model: SEEDANCE });
      assert.match(error.message, /belongs to another session/);
    }

    /* ----- Seedance and real persons (WP24), failed jobs ----- */
    {
      baseMocks();
      // refused at the start: one stable code, nothing is booked, no job is left
      patch(or, 'createVideo', async (payload) => {
        payloads.push(payload);
        throw new or.OpenRouterError(
          'OpenRouter 400: HTTP 400: {"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input image \'content[1]\' may contain real person.","type":"BadRequest"}}',
          { status: 400 }
        );
      });
      const before = (await store.readSession(sessionId)).jobs.length;
      const refused = await run(makeCtx(), { prompt: text('x'), first_frame: image1 }, { model: SEEDANCE }).catch((err) => err);
      assert.equal(refused.code, 'VIDEO_REAL_PERSON');
      assert.equal(refused.provider, 'bytedance');
      assert.equal((await store.readSession(sessionId)).jobs.length, before, 'no job');
      assert.equal(journal.length, 0);
      // ... for Seedance only; the same wording from another provider stays that provider's own error
      const other = await run(makeCtx(), { prompt: text('x'), first_frame: image1 }, { model: KLING }).catch((err) => err);
      assert.notEqual(other.code, 'VIDEO_REAL_PERSON');
      assert.match(other.message, /real person/);

      // refused after the start, while the job is polled: the code of the poller reaches the node
      baseMocks();
      const stop = startJobCompleter(sessionId, { fail: 'Seedance hat das Bild dieses Videos abgelehnt', errorCode: 'VIDEO_REAL_PERSON_JOB' });
      try {
        const failed = await run(makeCtx(), { prompt: text('x') }, { model: SEEDANCE }).catch((err) => err);
        assert.equal(failed.code, 'VIDEO_REAL_PERSON_JOB', failed.message);
        assert.match(failed.message, /abgelehnt/);
      } finally {
        stop();
      }
      // another failed job keeps its message and has no code
      const stopOther = startJobCompleter(sessionId, { fail: 'content policy' });
      try {
        const plainFailure = await run(makeCtx(), { prompt: text('x') }, { model: KLING }).catch((err) => err);
        assert.match(plainFailure.message, /content policy/);
        assert.equal(plainFailure.code, undefined);
      } finally {
        stopOther();
      }
      // video.seedance does not change: it still runs on the model of the configuration
      baseMocks();
      const stopSeedance = startJobCompleter(sessionId, { cost: 0.3 });
      try {
        const old = await def('video.seedance').execute(makeCtx(), { prompt: text('Slow push-in') }, registry.normalizeParams(def('video.seedance'), { duration: 6, aspect_ratio: '9:16', resolution: '720p' }));
        assert.deepEqual(plain(payloads[0]), { model: SEEDANCE, prompt: 'Slow push-in', resolution: '720p', duration: 6, aspect_ratio: '9:16' });
        near(old.cost.usd, 0.3);
      } finally {
        stopSeedance();
      }
    }

    /* ----- what the tool gets to know about the price (the budget of a participant reserves it) ----- */
    {
      baseMocks();
      const seen = [];
      const realExecute = tools.executeTool;
      const spy = () =>
        patch(tools, 'executeTool', (ctx, name, args) => {
          seen.push({
            name,
            model: ctx.config.videoModel,
            estimate: ctx.videoEstimateUsd,
            option: ctx.videoOption && { id: ctx.videoOption.id, name: ctx.videoOption.name },
            duration: args.duration_seconds,
            resolution: args.resolution
          });
          return realExecute(ctx, name, args);
        });
      spy();
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: KLING, duration: 5 });
      await runWithJob(makeCtx(), { prompt: text('x') }, { duration: 4, resolution: '480p' });
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: WAN, duration: 3, resolution: '1080p' });
      near(seen[0].estimate, 0.63, 'Kling, 5 s');
      assert.deepEqual([seen[0].model, seen[0].option, seen[0].duration, seen[0].resolution], [KLING, { id: KLING, name: 'Kling v3.0 Standard' }, 5, '720p']);
      const chat = videoModels.priceEstimate(CATALOG.data[0], { duration: 4, resolution: '480p', mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false });
      assert.equal(seen[1].estimate, chat.maxTotal, 'the same amount as the card of the chat');
      near(seen[2].estimate, 0.3, 'Wan, 3 s');
      assert.equal(seen[2].resolution, '1080p');
      // the tool reserves what it is told, nothing else
      assert.equal(tools.toolEstimateUsd('generate_video', {}, { videoEstimateUsd: 0.63 }), 0.63);
      assert.equal(tools.toolEstimateUsd('generate_video', {}, {}), null, 'unknown: anything left is enough');
      // a model whose price is not known passes none (never 0)
      seen.length = 0;
      patch(or, 'listVideoModels', async () => ({ data: [{ ...CATALOG.data[0], pricing_skus: {} }, ...CATALOG.data.slice(1)] }));
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await runWithJob(makeCtx(), { prompt: text('x') }, { model: SEEDANCE });
      assert.equal(seen[0].estimate, undefined);
      assert.deepEqual(seen[0].option, { id: SEEDANCE, name: 'Seedance 2.5' }, 'the job still knows its model');
      // the list cannot be read: no price, no frames, the job still runs with the fallback capabilities of the tool
      baseMocks();
      spy();
      patch(or, 'listVideoModels', async () => {
        throw new Error('no network');
      });
      discovery.resetVideoModelCache();
      seen.length = 0;
      const unreadable = await runWithJob(makeCtx(), { prompt: text('x'), first_frame: image1, last_frame: list('image', [image2]) }, { model: KLING, duration: 5 });
      assert.equal(unreadable.variants.length, 1);
      assert.equal(seen[0].estimate, undefined);
      assert.deepEqual([seen[0].duration, seen[0].resolution], [5, undefined]);
    }

    /* ----- estimates of the plan ----- */
    {
      baseMocks();
      await videoNodeModels.load();
      const estimate = (rawParams, context = { config: CONFIG, connected: new Set() }) => {
        const node = def('video.generate');
        return node.cost.estimate(registry.normalizeParams(node, rawParams), context);
      };
      near(estimate({ model: KLING, duration: 5 }).usd, 0.63);
      near(estimate({ model: WAN, duration: 10 }).usd, 1);
      near(estimate({ model: VEO, duration: 8, resolution: '1080p' }).usd, 0.64, 'Veo, 8 s, upper end of 0.08');
      assert.equal(estimate({ model: SEEDANCE, duration: 5 }).usd, videoModels.priceEstimate(CATALOG.data[0], { duration: 5, resolution: '720p', mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false }).maxTotal);
      // no choice: the price of the configured model
      near(estimate({ duration: 5 }, { config: { ...CONFIG, videoModel: KLING } }).usd, 0.63);
      // the connections count: a first frame is image to video, a reference video has its own price
      const withFrame = estimate({ model: SEEDANCE, duration: 5 }, { config: CONFIG, connected: new Set(['first_frame']) });
      const withVideo = estimate({ model: SEEDANCE, duration: 5 }, { config: CONFIG, connected: new Set(['ref_videos']) });
      assert.ok(withVideo.usd <= estimate({ model: SEEDANCE, duration: 5 }).usd, 'what is reserved is the upper end');
      assert.ok(withFrame.usd > 0);
      // unknown stays unknown (null, never 0)
      assert.equal(estimate({ duration: 5 }, { config: {} }), null);
      assert.deepEqual(estimate({ duration: 5 }), estimate({ model: SEEDANCE, duration: 5 }), 'the configured model of the context');
      assert.equal(estimate({ model: NOT_LISTED, duration: 5 }), null);
      assert.equal(estimate({ model: VEO, duration: 5 }), null, 'a length the model does not offer');
      assert.equal(estimate({ model: SEEDANCE, duration: 5, resolution: '1080p' }), null);
      // a context without a configuration or without a set of connections still works
      const bare = (rawParams, context) => def('video.generate').cost.estimate(registry.normalizeParams(def('video.generate'), rawParams), context);
      assert.equal(bare({ duration: 5 }, undefined), null, 'nothing chosen and no configuration: unknown');
      near(bare({ model: KLING, duration: 5 }, undefined).usd, 0.63);
      near(bare({ model: KLING, duration: 5 }, { config: CONFIG }).usd, 0.63);
    }

    /* ----- engine: plan, run, cache, model change, refusal before the start ----- */
    {
      baseMocks();
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => CONFIG, limits: { jobPollMs: 20 } });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow } = await wfStore.createWorkflow({
        name: 'Two video models',
        graph: {
          nodes: [
            node('p', 'input.text', { text: 'a slow walk' }),
            node('v1', 'video.generate', { model: KLING, duration: 5 }, 300),
            node('v2', 'video.generate', { duration: 4 }, 300),
            node('o', 'output.result', { label: 'Clips' }, 600)
          ],
          edges: [edge('e1', 'p', 'text', 'v1', 'prompt'), edge('e2', 'p', 'text', 'v2', 'prompt'), edge('e3', 'v1', 'video', 'o', 'inputs'), edge('e4', 'v2', 'video', 'o', 'inputs')]
        }
      });
      created.push(workflow.id);
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      near(plan.nodes.v1.estimate.usd, 0.63, 'Kling, 5 s: read from the list of OpenRouter (prepare)');
      assert.equal(plan.nodes.v2.estimate.usd, videoModels.priceEstimate(CATALOG.data[0], { duration: 4, resolution: '720p', mode: 'text_to_video', aspectRatio: '16:9', hasVideoInput: false }).maxTotal, 'no choice: the configured model');
      assert.equal(plan.totals.unknownNodes, 0);

      const stop = startJobCompleter(workflow.sessionId, { cost: 0.2 });
      let record;
      try {
        record = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'tester' }));
      } finally {
        stop();
      }
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.deepEqual(payloads.map((payload) => payload.model).sort(), [KLING, SEEDANCE].sort());
      // after the run the plan still reads the price of the model, not the last cost of the type
      const after = await engine.plan(workflow.id, { mode: 'all', force: true });
      near(after.nodes.v1.estimate.usd, 0.63);

      // a changed model is a new result (the cache key follows the params)
      const current = await wfStore.readWorkflow(workflow.id);
      await wfStore.saveGraph(workflow.id, { baseRev: current.rev, graph: { ...current.graph, nodes: current.graph.nodes.map((item) => (item.id === 'v2' ? { ...item, params: { model: WAN, duration: 4 } } : item)) } });
      payloads.length = 0;
      const stopAgain = startJobCompleter(workflow.sessionId, { cost: 0.2 });
      try {
        const second = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'tester' }));
        assert.equal(second.status, 'completed');
      } finally {
        stopAgain();
      }
      assert.deepEqual(payloads.map((payload) => payload.model), [WAN], 'only the changed node runs again');

      // a model from outside the list fails the node with the code, nothing is paid
      payloads.length = 0;
      const { workflow: bad } = await wfStore.createWorkflow({
        name: 'Outside',
        graph: { nodes: [node('b1', 'video.generate', { prompt: 'x', model: NOT_LISTED })], edges: [] }
      });
      created.push(bad.id);
      const badRun = await engine.whenFinished(bad.id, await engine.start(bad.id, { mode: 'all', user: 'tester' }));
      assert.equal(badRun.status, 'failed');
      assert.equal(badRun.nodes.b1.status, 'error');
      assert.equal(badRun.nodes.b1.code, 'VIDEO_MODEL_NOT_ALLOWED');
      assert.deepEqual(badRun.nodes.b1.data, { model: NOT_LISTED });
      assert.equal(payloads.length, 0);

      // a limit that follows the model refuses the run before anything is paid: connections are never removed for it
      const { workflow: limited } = await wfStore.createWorkflow({
        name: 'End frame',
        graph: {
          nodes: [node('t', 'input.text', { text: 'open' }), node('i1', 'input.image', {}), node('i2', 'input.image', {}), node('g', 'video.generate', { model: FIRST_ONLY }, 300)],
          edges: [edge('l1', 't', 'text', 'g', 'prompt'), edge('l2', 'i1', 'image', 'g', 'first_frame'), edge('l3', 'i2', 'image', 'g', 'last_frame')]
        }
      });
      created.push(limited.id);
      const refusedPlan = await engine.plan(limited.id, { mode: 'all' });
      const issue = refusedPlan.issues.find((item) => item.code === 'VIDEO_LAST_FRAME_UNSUPPORTED');
      assert.ok(issue, JSON.stringify(refusedPlan.issues));
      assert.deepEqual([issue.nodeId, issue.port, issue.data], ['g', 'last_frame', { model: 'First Only' }]);
      assert.equal(refusedPlan.valid, false);
      assert.equal(refusedPlan.nodes.g.status, 'invalid');
      assert.equal(refusedPlan.nodes.g.reasonCode, 'VIDEO_LAST_FRAME_UNSUPPORTED');
      await assert.rejects(engine.start(limited.id, { mode: 'all', user: 'tester' }), (err) => err.code === 'INVALID_GRAPH' && err.issues.some((item) => item.code === 'VIDEO_LAST_FRAME_UNSUPPORTED'));
      assert.equal(payloads.length, 0);
      // the same graph with a model that takes an end frame is fine
      const stored = await wfStore.readWorkflow(limited.id);
      await wfStore.saveGraph(limited.id, { baseRev: stored.rev, graph: { ...stored.graph, nodes: stored.graph.nodes.map((item) => (item.id === 'g' ? { ...item, params: { model: SEEDANCE } } : item)) } });
      assert.equal((await engine.plan(limited.id, { mode: 'all' })).issues.some((item) => item.code === 'VIDEO_LAST_FRAME_UNSUPPORTED'), false);
    }

    /* ----- option list of the server route ----- */
    {
      baseMocks();
      const app = express();
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => CONFIG, limits: { jobPollMs: 20 } });
      registerNodeRoutes(app, { engine, store: wfStore, registry, events: bus, publicRuntimeConfig: () => CONFIG });
      const layers = app._router.stack.filter((item) => item.route);
      const handler = layers.find((item) => item.route.path === '/api/nodes/options/:source' && item.route.methods.get).route.stack.slice(-1)[0].handle;
      const call = (source) =>
        new Promise((resolve, reject) => {
          const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
          Promise.resolve(handler({ params: { source }, query: {}, headers: {}, kubleUser: 'tester' }, res)).catch(reject);
        });
      const served = await call('video-models');
      assert.equal(served.status, 200);
      assert.deepEqual(served.body.options.map((item) => item.value), ['', SEEDANCE, SEEDANCE_FAST, KLING, WAN, VEO]);
      assert.equal(served.body.options[0].default, true);
      const seedance = served.body.options.find((item) => item.value === SEEDANCE);
      assert.deepEqual([seedance.references.max, seedance.videos.max, seedance.audio.max, seedance.last_frame.max], [30, 10, 10, 1], 'the ceilings of the inputs');
      assert.deepEqual(plain(seedance.durations), { min: 4, max: 30 });
      assert.deepEqual(plain(served.body.options.find((item) => item.value === VEO).durations), { values: [4, 6, 8] });
      // the registry serves the node with its params
      const registryHandler = layers.find((item) => item.route.path === '/api/nodes/registry' && item.route.methods.get).route.stack.slice(-1)[0].handle;
      const registryPayload = await new Promise((resolve, reject) => {
        const res = { json: resolve, status() { return this; } };
        Promise.resolve(registryHandler({ params: {}, query: {}, headers: {}, kubleUser: 'tester' }, res)).catch(reject);
      });
      const descriptor = registryPayload.nodeTypes.find((item) => item.type === 'video.generate');
      assert.ok(descriptor);
      assert.equal(descriptor.params[0].optionsSource, 'video-models');
      assert.equal(registryPayload.nodeTypes.find((item) => item.type === 'video.seedance').params.some((param) => param.id === 'model'), false);
    }

    /* ----- the page: the list, what each model can do, the end frame input, kept connections ----- */
    {
      baseMocks();
      await videoNodeModels.load();
      const serverList = { options: await videoNodeModels.options({ config: CONFIG, ceilings: { refs: 30, videos: 10, audios: 10 } }) };
      serverList.options.push({ value: FIRST_ONLY, label: 'First Only', last_frame: { max: 0 }, durations: { values: [5, 10] }, perSecondUsd: { min: 0.2, max: 0.2 } });
      const storage = new Map([['vcd-lang', 'de']]);
      const load = (lang, api) => {
        storage.set('vcd-lang', lang);
        const window = {
          document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
          navigator: { language: 'de-CH' },
          localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
          OCDNodes: { graph: graphLib, api }
        };
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/node-ui.js'), 'utf8'), { window, document: window.document, setTimeout, clearTimeout }, { filename: 'public/nodes/node-ui.js' });
        return window.OCDNodes.ui;
      };
      const requested = [];
      const detailRequests = [];
      const api = {
        options: async (source) => {
          requested.push(source);
          return serverList;
        },
        higgsfieldModel: async (id) => {
          detailRequests.push(id);
          throw new Error('not a Higgsfield model');
        }
      };
      const expectations = {
        de: { lastFrame: 'Endbild', price: /ca\. \$0\.084–\$0\.126 pro Sekunde/, duration: '3–15 s', values: '4, 6, 8 s' },
        en: { lastFrame: 'last frame', price: /about \$0\.084–\$0\.126 per second/, duration: '3–15 s', values: '4, 6, 8 s' },
        es: { lastFrame: 'fotograma final', price: /aprox\. \$0\.084–\$0\.126 por segundo/, duration: '3–15 s', values: '4, 6, 8 s' }
      };
      for (const lang of ['de', 'en', 'es']) {
        const ui = load(lang, api);
        const normal = plain(ui.normalizeOptions(serverList));
        const entryOf = (value) => normal.find((item) => item.value === value);
        // the fields of a video model survive; junk does not
        assert.deepEqual(entryOf(WAN).last_frame, { max: 1 });
        assert.deepEqual(entryOf(VEO).durations, { values: [4, 6, 8] });
        assert.deepEqual(entryOf(KLING).perSecondUsd, { min: 0.084, max: 0.126 });
        assert.equal(entryOf(WAN).videos.max, 0);
        assert.equal(entryOf('').default, true);
        const junk = plain(ui.normalizeOptions({ options: [{ value: 'a', label: 'A', videos: 'x', last_frame: 5, durations: null, perSecondUsd: 3 }] }))[0];
        assert.deepEqual(Object.keys(junk).sort(), ['label', 'value']);

        const label = (value, usage) => ui.modelOptionLabel(entryOf(value), usage);
        const expect = expectations[lang];
        const kling = label(KLING, null).text;
        assert.match(kling, /^Kling v3\.0 Standard · /);
        assert.ok(kling.includes(expect.lastFrame), `${lang}: the end frame is named where the model takes one: ${kling}`);
        assert.ok(kling.includes(expect.duration), `${lang}: duration: ${kling}`);
        assert.match(kling, expect.price);
        assert.ok(label(VEO, null).text.includes(expect.values), `${lang}: fixed lengths are listed: ${label(VEO, null).text}`);
        assert.ok(!label(FIRST_ONLY, null).text.includes(expect.lastFrame), `${lang}: not named where the model takes none`);
        assert.match(label(SEEDANCE, null).text, /30/, 'references up to 30');
        assert.match(label(SEEDANCE, null).text, /10/, 'videos and audio');
        assert.ok(!label(KLING, null).text.includes('$0.000'), 'the price never shows 0');
        assert.doesNotMatch(ui.modelOptionLabel({ value: 'x', label: 'Plain', perSecondUsd: { min: 0, max: 0 } }, null).text, /\$/, 'a price of 0 is no price');
        // the connections that do not fit are marked in the list, as for the other model lists
        assert.equal(label(FIRST_ONLY, { last_frame: 1 }).misfit, true, 'a model that takes no end frame is marked while one is connected');
        assert.equal(label(FIRST_ONLY, { last_frame: 0 }).misfit, false);
        assert.equal(ui.modelOptionLabel({ value: 'x', label: 'Plain', durations: { min: 1, max: 2 } }, { last_frame: 1 }).misfit, false, 'a model with no claim about the end frame is not marked');
        assert.equal(label(WAN, { videos: 1 }).misfit, true);
        assert.equal(label(SEEDANCE_FAST, { videos: 2 }).misfit, false);
        assert.equal(label(SEEDANCE_FAST, { videos: 4 }).misfit, true);
        assert.equal(label(KLING, { references: 1 }).misfit, true);
        assert.equal(label(SEEDANCE, { references: 3, audio: 2, videos: 1, last_frame: 1 }).misfit, false);
        for (const text of [ui.misfitText(entryOf(FIRST_ONLY) && { last_frame: { max: 0 } }, { last_frame: 1 }), ui.misfitText({ videos: { max: 0 } }, { videos: 2 }), ui.misfitText({ videos: { max: 3 } }, { videos: 4 }), ui.misfitText({ last_frame: { max: 0 } }, { last_frame: 1 }, { short: true })]) {
          assert.ok(text && !/\{[a-z]+\}/.test(text), `${lang}: a finished sentence: ${text}`);
        }
        assert.equal(ui.misfitText({ last_frame: { max: 1 } }, { last_frame: 1 }), '');
      }

      // the limits of the chosen model come from the list, with no description to read from Higgsfield
      const ui = load('de', api);
      const generateNode = plain(registry.publicDescriptor(def('video.generate')));
      assert.equal(ui.optionsFor({ optionsSource: 'video-models' }).state, 'loading');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ui.optionsFor({ optionsSource: 'video-models' }).state, 'ready');
      assert.deepEqual(requested, ['video-models'], 'the list is fetched once');
      const limits = (model) => plain(ui.limitsFor({ id: 'n', type: 'video.generate', params: model === undefined ? {} : { model } }, generateNode));
      assert.deepEqual(limits(WAN), {
        refs: { max: 5, roles: [], required: false, subject: 'Wan 2.7' },
        ref_videos: { max: 0, roles: [], required: false, subject: 'Wan 2.7' },
        ref_audios: { max: 0, roles: [], required: false, subject: 'Wan 2.7' },
        last_frame: { max: 1, roles: [], required: false, subject: 'Wan 2.7' }
      });
      assert.deepEqual(limits(FIRST_ONLY), { last_frame: { max: 0, roles: [], required: false, subject: 'First Only' } }, 'no profile: only what the list says');
      assert.deepEqual(limits(NOT_LISTED), {});
      assert.equal(limits('').last_frame.max, 1, 'no choice: what the list says about the default entry');
      assert.deepEqual(detailRequests, [], 'no description is asked for from Higgsfield');

      // the same rule as on the server: an input with a limit of 0 takes no connection, nothing is removed by a model change
      const reg = graphLib.indexRegistry(JSON.parse(JSON.stringify(registry.publicRegistry())), { limitsFor: (node, definition) => ui.limitsFor(node, definition) });
      const graphOf = (model) => ({
        nodes: [
          { id: 'a', type: 'input.image', x: 0, y: 0, params: {} },
          { id: 'b', type: 'input.image', x: 0, y: 100, params: {} },
          { id: 'g', type: 'video.generate', x: 300, y: 0, params: { model } }
        ],
        edges: [],
        groups: [],
        notes: []
      });
      const refusal = graphLib.checkConnection(reg, graphOf(FIRST_ONLY), { node: 'a', port: 'image' }, { node: 'g', port: 'last_frame' });
      assert.equal(refusal.code, 'too_many');
      assert.deepEqual(plain(refusal.data), { port: 'last_frame', max: 0, count: 0, model: 'First Only' });
      assert.match(ui.connectText(refusal), /First Only/, 'the refusal names the model');
      assert.equal(graphLib.checkConnection(reg, graphOf(WAN), { node: 'a', port: 'image' }, { node: 'g', port: 'last_frame' }), null);
      const joined = graphLib.connect(reg, graphOf(WAN), { node: 'a', port: 'image' }, { node: 'g', port: 'last_frame' });
      assert.ok(joined.edge);
      assert.equal(graphLib.checkConnection(reg, joined.graph, { node: 'b', port: 'image' }, { node: 'g', port: 'last_frame' }).code, 'too_many', 'one end frame at most');
      // the model changes to one without an end frame: the connection stays, the node is over its limit
      const changed = { ...joined.graph, nodes: joined.graph.nodes.map((n) => (n.id === 'g' ? { ...n, params: { model: FIRST_ONLY } } : n)) };
      assert.equal(changed.edges.length, 1, 'no connection is removed');
      assert.equal(graphLib.pruneEdges(reg, changed).edges.length, 1, 'and the cleaning of the graph keeps it, too');
      assert.deepEqual(plain(graphLib.overLimits(reg, changed, 'g')), [{ port: 'last_frame', count: 1, max: 0, model: 'First Only' }]);
      assert.deepEqual(graphLib.capabilityUsage(reg, changed, 'g'), { last_frame: 1, references: 0, videos: 0, audio: 0 });
      const usage = graphLib.capabilityUsage(reg, changed, 'g');
      assert.equal(ui.modelOptionLabel({ ...plain(ui.normalizeOptions(serverList)).find((item) => item.value === FIRST_ONLY) }, usage).misfit, true, 'the list marks the model that does not fit');
      assert.equal(ui.modelOptionLabel(plain(ui.normalizeOptions(serverList)).find((item) => item.value === SEEDANCE), usage).misfit, false);
      // the port of an unknown limit keeps the fixed maximum, without a claim about the model
      const unknown = graphLib.portsFor(reg, graphOf(NOT_LISTED).nodes[2]).inputs.find((port) => port.id === 'last_frame');
      assert.deepEqual(plain(unknown.limit), { known: false });
      assert.equal(unknown.max, 1);
    }

    /* ----- texts: every code the node can report, in German, English and Spanish ----- */
    {
      const { rows } = require('../public/nodes/i18n-nodes.js');
      const have = (key) => rows.find((row) => row[0] === key);
      const source = fs.readFileSync(path.join(root, 'lib/nodes/nodes-generate.js'), 'utf8');
      const codes = [...new Set([...source.matchAll(/'(VIDEO_[A-Z_]+|TOO_MANY_REFERENCES)'/g)].map((match) => match[1]))];
      assert.ok(codes.length >= 9, `found the codes of the node: ${codes.join(', ')}`);
      for (const code of codes) {
        const row = have(`nodes.issue.${code}`);
        assert.ok(row, `nodes.issue.${code} has a text`);
        assert.ok(row.slice(1).every((value) => typeof value === 'string' && value.length > 20), code);
        // the sentences of a number of connections have their own wording for none and one
        if (/REF_(VIDEOS|AUDIOS)|TOO_MANY_REFERENCES/.test(code)) {
          assert.ok(have(`nodes.issue.${code}.none`) && have(`nodes.issue.${code}.one`), `${code}: none and one`);
        }
      }
      assert.ok(have('nodes.issue.VIDEO_REAL_PERSON_JOB'), 'a refusal after the start has its text in the node view');
      for (const key of ['nodes.type.video.generate.label', 'nodes.type.video.generate.keywords', 'nodes.type.video.generate.help', 'nodes.type.video.generate.example', 'nodes.type.video.generate.tip.1', 'nodes.port.last_frame', 'nodes.portdesc.video.generate.last_frame', 'nodes.cap.lastFrame', 'nodes.cap.priceVideo', 'nodes.cap.duration', 'nodes.cap.durationValues', 'nodes.cap.videosUpTo']) {
        const row = have(key);
        assert.ok(row && row.length === 4 && row.slice(1).every((value) => value.trim()), key);
        assert.ok(row.every((value) => !value.includes('ß')), `${key}: no sharp s`);
      }
      assert.ok(rows.filter((row) => /video\.generate|VIDEO_|last_frame|\.cap\./.test(row[0])).length > 25, 'the texts of the node are there');
    }

  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-video-generate.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
