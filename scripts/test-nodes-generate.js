'use strict';

// Tests for the generative node types (lib/nodes/nodes-generate.js, llm.js, higgsfield-catalog.js) and the
// tools.js extensions they need (extra_params, higgsfield_edit). No provider is contacted: every provider function is
// replaced on its module object and restored in `finally`. Backing sessions and temp files are removed at the end.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const chatgpt = require('../lib/chatgpt');
const costs = require('../lib/costs');
const discovery = require('../lib/discovery');
const higgsfield = require('../lib/higgsfield');
const rendernode = require('../lib/rendernode');
const elevenlabs = require('../lib/elevenlabs');
const publicrefs = require('../lib/publicrefs');
const ffmpeg = require('../lib/ffmpeg');
const poller = require('../lib/poller');
const tools = require('../lib/tools');
const assets = require('../lib/nodes/assets');
const jobs = require('../lib/nodes/jobs');
const llm = require('../lib/nodes/llm');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const catalogLib = require('../lib/nodes/higgsfield-catalog');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_B64 = PNG.toString('base64');
const MEDIA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function withEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

// Completes open jobs of a session like the poller does (asset first, then the job record).
function startJobCompleter(sessionId, { cost = null, results = 1, fail = null } = {}) {
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
        });
        continue;
      }
      const isHiggsfield = job.provider === 'higgsfield';
      const kind = job.kind || 'video';
      const ids = [(await store.completeAsset(sessionId, job.assetId, kind === 'image' ? PNG : Buffer.from('fake-mp4'), isHiggsfield ? 0 : cost)).id];
      for (let index = 1; index < results; index += 1) {
        const extra = await store.saveAsset(sessionId, {
          kind,
          buffer: kind === 'image' ? PNG : Buffer.from('fake-mp4'),
          ext: kind === 'image' ? '.png' : '.mp4',
          prompt: job.prompt,
          cost: 0
        });
        ids.push(extra.id);
      }
      await store.mutateSession(sessionId, (s) => {
        const target = s.jobs.find((entry) => entry.jobId === job.jobId);
        target.status = 'completed';
        if (isHiggsfield) target.resultAssetIds = ids;
      });
    }
  }, 10);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function makeCtx(sessionId, config = {}) {
  const controller = new AbortController();
  const logs = [];
  const toolEvents = [];
  const runtime = {
    imageModel: 'openai/gpt-image-2',
    videoModel: 'bytedance/seedance-2.5',
    defaultBrain: 'vendor/default-brain',
    brainModels: ['vendor/default-brain'],
    ...config
  };
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
    waitForJob: (job) => jobs.waitForSessionJob(sessionId, typeof job === 'string' ? job : job.jobId, { assetId: typeof job === 'string' ? undefined : job.assetId, signal: controller.signal, intervalMs: 20, timeoutMs: 8000 }),
    saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
    withLocalSlot: (fn) => fn(),
    logs,
    toolEvents,
    controller
  };
}

function oneOf(registry, type) {
  const def = registry.get(type);
  assert.ok(def, `${type} is registered`);
  return def;
}

// Runs a node definition directly: normalised params, executor with a fake context.
async function execute(registry, type, ctx, inputs, rawParams = {}) {
  const def = oneOf(registry, type);
  return def.execute(ctx, inputs, registry.normalizeParams(def, rawParams));
}

function issuesOf(registry, type, rawParams, ports = {}) {
  const def = oneOf(registry, type);
  const params = registry.normalizeParams(def, rawParams);
  return (def.validate ? def.validate(params, ports) || [] : []).map((issue) =>
    typeof issue === 'string' ? { level: 'error', message: issue } : { level: issue.level || 'error', message: issue.message, code: issue.code }
  );
}

const text = (value) => ({ type: 'text', value });
const list = (of, items) => ({ type: 'list', of, items });

function imageResponse(cost = 0.04) {
  return { data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost } };
}

function modelJson(extra = {}) {
  return JSON.stringify({
    id: 'kling-3',
    name: 'Kling 3',
    provider_name: 'Kling',
    description: 'A video model',
    output_type: 'video',
    parameters: [
      { name: 'quality', required: 'optional', type: 'string', options: ['low', 'high'], default: 'low' },
      { name: 'seed', required: 'optional', type: 'number', min: 0, max: 100 },
      { name: 'audio', required: 'optional', type: 'bool' },
      { name: 'styles', required: 'optional', type: 'string_array' },
      { name: 'prompt', required: 'required', type: 'string' }
    ],
    medias: [{ name: 'start', type: 'image', max: 2, roles: ['start_image', 'end_image'] }],
    aspect_ratios: ['16:9', '9:16'],
    durations: [5, 10],
    credits_per_unit: 3,
    credit_unit: 'per_second',
    tags: ['video'],
    ...extra
  });
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-generate-'));
  const bus = createEventBus();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const created = [];
  const newWorkflow = async (name, graph) => {
    const { workflow } = await wfStore.createWorkflow({ name, graph });
    created.push(workflow.id);
    return workflow;
  };

  const journal = [];
  try {
    const base = await newWorkflow('Generate test', { nodes: [], edges: [] });
    const sessionId = base.sessionId;
    const upload = async (ext, buffer = PNG) => {
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer, ext, prompt: 'seed', cost: null });
      return assets.valueFromAsset(sessionId, saved.id);
    };
    const image1 = await upload('.png');
    const image2 = await upload('.png');
    const video1 = await upload('.mp4', Buffer.from('fake-mp4'));

    const removedRefs = [];
    let jobCounter = 0;
    const nextJobId = () => {
      jobCounter += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-${String(jobCounter).padStart(12, '0')}`;
    };
    // common mocks; every section starts from this state again
    function baseMocks() {
      patch(or, 'hasKey', () => true);
      patch(costs, 'recordCost', async (entry) => {
        journal.push(entry);
        return entry;
      });
      patch(discovery, 'brainSupportsImages', async () => true);
      patch(discovery, 'videoCapabilities', async () => ({
        resolutions: ['480p', '720p'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        durations: { min: 4, max: 30 },
        frameImages: ['first_frame']
      }));
      patch(publicrefs, 'publishAsset', async (session, assetId) => ({ url: `https://example.test/refs/${assetId}.png`, file: `${assetId}.png` }));
      patch(publicrefs, 'removeRef', async (file) => {
        removedRefs.push(file);
        return true;
      });
      withEnv('PUBLIC_BASE_URL', undefined);
    }
    function resetMocks() {
      restoreAll();
      baseMocks();
    }

    /* ----- registry: definitions, availability, ports ----- */
    {
      resetMocks();
      const expected = [
        'llm.chat', 'llm.prompt_enhancer', 'llm.image_describer', 'llm.video_describer', 'llm.motion_html',
        'image.generate', 'image.edit', 'image.relight', 'image.higgsfield',
        'video.seedance', 'video.higgsfield', 'video.motion_graphics', 'video.concat', 'audio.tts',
        'hf.remove_background', 'hf.upscale_image', 'hf.upscale_video', 'hf.outpaint_image', 'hf.reframe_video'
      ];
      for (const type of expected) oneOf(registry, type);
      assert.equal(generate.definitions.length, expected.length);
      assert.ok(oneOf(registry, 'hf.upscale_image').experimental && oneOf(registry, 'hf.reframe_video').experimental);
      assert.ok(!oneOf(registry, 'image.higgsfield').experimental);
      assert.equal(oneOf(registry, 'image.higgsfield').category, 'higgsfield');

      // the default registry (used by the server) carries them, too
      const defaults = require('../lib/nodes/registry');
      for (const type of expected) assert.ok(defaults.get(type), `${type} in the default registry`);

      // availability follows the same checks as the tools
      patch(or, 'hasKey', () => false);
      patch(chatgpt, 'status', () => ({ connected: false }));
      assert.match(registry.availability(oneOf(registry, 'image.generate')), /OPENROUTER/);
      assert.match(registry.availability(oneOf(registry, 'llm.chat')), /ChatGPT/);
      patch(chatgpt, 'status', () => ({ connected: true }));
      assert.equal(registry.availability(oneOf(registry, 'llm.chat')), true, 'ChatGPT alone is enough for LLM nodes');
      patch(or, 'hasKey', () => true);
      assert.equal(registry.availability(oneOf(registry, 'image.generate')), true);

      patch(higgsfield, 'status', () => ({ connected: false }));
      for (const type of ['image.higgsfield', 'video.higgsfield', 'hf.remove_background', 'hf.upscale_video']) {
        assert.match(registry.availability(oneOf(registry, type)), /Higgsfield/, type);
      }
      patch(higgsfield, 'status', () => ({ connected: true }));
      assert.equal(registry.availability(oneOf(registry, 'image.higgsfield')), true);
      assert.match(registry.availability(oneOf(registry, 'hf.remove_background')), /PUBLIC_BASE_URL/, 'edit tools need PUBLIC_BASE_URL');
      assert.match(registry.availability(oneOf(registry, 'hf.outpaint_image')), /PUBLIC_BASE_URL/);
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      assert.equal(registry.availability(oneOf(registry, 'hf.remove_background')), true);
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: null, ffprobe: null, available: false }));
      assert.equal(registry.availability(oneOf(registry, 'hf.outpaint_image')), true);
      assert.match(registry.availability(oneOf(registry, 'hf.upscale_image')), /ffmpeg/);
      assert.match(registry.availability(oneOf(registry, 'video.concat')), /ffmpeg/);
      assert.match(registry.availability(oneOf(registry, 'llm.video_describer')), /ffmpeg/);
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      assert.equal(registry.availability(oneOf(registry, 'hf.upscale_image')), true);
      patch(rendernode, 'enabled', () => false);
      assert.match(registry.availability(oneOf(registry, 'video.motion_graphics')), /render node/i);
      patch(rendernode, 'enabled', () => true);
      assert.equal(registry.availability(oneOf(registry, 'video.motion_graphics')), true);
      patch(elevenlabs, 'hasKey', () => false);
      assert.match(registry.availability(oneOf(registry, 'audio.tts')), /ELEVENLABS/);
      patch(elevenlabs, 'hasKey', () => true);
      withEnv('PUBLIC_BASE_URL', undefined);

      // ports: prompt inputs fall back to their inline param, media ports are multiple/typed
      const chat = oneOf(registry, 'llm.chat');
      assert.equal(chat.inputs.find((port) => port.id === 'prompt').param, 'prompt');
      assert.equal(chat.inputs.find((port) => port.id === 'images').multiple, true);
      const seedance = oneOf(registry, 'video.seedance');
      assert.deepEqual(seedance.inputs.map((port) => port.id), ['prompt', 'first_frame', 'refs', 'ref_videos', 'ref_audios']);
      assert.equal(seedance.params.find((param) => param.id === 'aspect_ratio').showIf.port, 'first_frame');
      const removeBackground = oneOf(registry, 'hf.remove_background');
      assert.equal(registry.portsFor(removeBackground, { kind: 'video' }).outputs[0].type, 'video');
      assert.equal(registry.portsFor(removeBackground, { kind: 'image' }).inputs[0].type, 'image');

      // the public descriptor serialises (no functions) and keeps the dynamic-param hints
      const descriptor = registry.publicDescriptor(oneOf(registry, 'video.higgsfield'));
      JSON.stringify(descriptor);
      assert.equal(descriptor.params.find((param) => param.id === 'extra_params').dynamic, 'higgsfield-model');
      assert.equal(descriptor.cost.unit, 'credits');
    }

    /* ----- Director tool list is unchanged ----- */
    {
      resetMocks();
      patch(rendernode, 'enabled', () => true);
      patch(higgsfield, 'status', () => ({ connected: true }));
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      const names = tools.toolDefinitions().map((definition) => definition.function.name);
      assert.deepEqual(names, [
        'generate_image', 'edit_image', 'generate_video', 'generate_speech', 'list_voices', 'import_gts_asset',
        'create_branding', 'update_branding', 'add_branding_asset', 'import_branding_asset', 'create_cast_member',
        'update_cast_member', 'import_cast_asset', 'save_memory', 'save_project_memory', 'render_motion_graphics',
        'concat_videos', 'higgsfield_models', 'higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_check_balance'
      ]);
      assert.ok(!names.includes('higgsfield_edit'));
      // the Director's Higgsfield schemas stay closed: no extra_params for it
      for (const definition of tools.toolDefinitions().filter((item) => item.function.name.startsWith('higgsfield_generate'))) {
        assert.equal(definition.function.parameters.additionalProperties, false);
        assert.ok(!definition.function.parameters.properties.extra_params);
      }
    }

    /* ----- image.generate: count variants, cost journal, partial failures ----- */
    {
      resetMocks();
      const calls = [];
      patch(or, 'createImage', async (payload) => {
        calls.push(payload);
        return imageResponse(0.04);
      });
      journal.length = 0;
      const ctx = makeCtx(sessionId);
      const result = await execute(registry, 'image.generate', ctx, { prompt: text('A coffee cup') }, { aspect_ratio: '9:16', count: 3 });
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0], { model: 'openai/gpt-image-2', prompt: 'A coffee cup', n: 1, aspect_ratio: '9:16' });
      assert.equal(result.variants.length, 3);
      for (const variant of result.variants) {
        assert.equal(variant.image.type, 'image');
        assert.equal(variant.image.sessionId, sessionId);
        assert.match(variant.image.url, new RegExp(`^/assets/${sessionId}/img-\\d{3}\\.png$`));
      }
      assert.equal(new Set(result.variants.map((variant) => variant.image.assetId)).size, 3);
      assert.equal(journal.filter((entry) => entry.type === 'image').length, 3, 'one cost journal line per image');
      assert.ok(Math.abs(result.cost.usd - 0.12) < 1e-9);
      assert.equal(ctx.toolEvents.filter((event) => event.type === 'tool_start').length, 3);

      // one variant fails: the paid ones are kept and the failure is logged
      let call = 0;
      patch(or, 'createImage', async () => {
        call += 1;
        if (call === 2) throw new Error('provider hiccup');
        return imageResponse(0.04);
      });
      const partialCtx = makeCtx(sessionId);
      const partial = await execute(registry, 'image.generate', partialCtx, { prompt: text('x') }, { count: 3 });
      assert.equal(partial.variants.length, 2);
      assert.match(partialCtx.logs.join('\n'), /1 of 3 variants failed: provider hiccup/);

      // all fail: the node fails with the provider error
      patch(or, 'createImage', async () => {
        throw new Error('quota exceeded');
      });
      await assert.rejects(execute(registry, 'image.generate', makeCtx(sessionId), { prompt: text('x') }, { count: 2 }), /quota exceeded/);

      // an aborted run does not start work
      const aborted = makeCtx(sessionId);
      aborted.controller.abort();
      await assert.rejects(execute(registry, 'image.generate', aborted, { prompt: text('x') }), { name: 'AbortError' });

      // missing cost stays unknown
      patch(or, 'createImage', async () => ({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] }));
      const unknown = await execute(registry, 'image.generate', makeCtx(sessionId), { prompt: text('x') });
      assert.equal(unknown.cost, undefined);

      // validation: the prompt may come from the inline param
      const def = oneOf(registry, 'image.generate');
      assert.equal(def.inputs[0].required, true);
      assert.equal(def.inputs[0].param, 'prompt');
    }

    /* ----- image.edit / image.relight ----- */
    {
      resetMocks();
      const calls = [];
      patch(or, 'createImage', async (payload) => {
        calls.push(payload);
        return imageResponse(0.05);
      });
      const ctx = makeCtx(sessionId);
      const edited = await execute(registry, 'image.edit', ctx, { prompt: text('Make it blue'), images: list('image', [image1, image2]) }, { aspect_ratio: '16:9', count: 2 });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].input_references.length, 2, 'both reference images are sent');
      assert.match(calls[0].input_references[0].image_url.url, /^data:image\/png;base64,/);
      assert.equal(calls[0].aspect_ratio, '16:9');
      assert.equal(edited.variants.length, 2);

      calls.length = 0;
      await execute(registry, 'image.edit', makeCtx(sessionId), { prompt: text('x'), images: list('image', [image1]) });
      assert.equal(calls.length, 1);
      assert.ok(!('aspect_ratio' in calls[0]), 'auto omits the aspect ratio');
      await assert.rejects(execute(registry, 'image.edit', makeCtx(sessionId), { prompt: text('x'), images: list('image', []) }), /at least one image/);
      await assert.rejects(
        execute(registry, 'image.edit', makeCtx(sessionId), { prompt: text('x'), images: list('image', Array(9).fill(image1)) }),
        /at most 8/
      );
      const foreign = { ...image1, sessionId: 'someone-else' };
      await assert.rejects(execute(registry, 'image.edit', makeCtx(sessionId), { prompt: text('x'), images: list('image', [foreign]) }), /another session/);

      calls.length = 0;
      await execute(registry, 'image.relight', makeCtx(sessionId), { image: image1, notes: text('keep the window light') }, { light: 'golden_hour', strength: 'strong', count: 1 });
      assert.equal(calls.length, 1);
      assert.match(calls[0].prompt, /^Relight this exact scene with warm golden-hour sunlight/);
      assert.match(calls[0].prompt, /composition.*identity.*unchanged/);
      assert.match(calls[0].prompt, /strong change/);
      assert.match(calls[0].prompt, /Additional notes: keep the window light/);
      assert.equal(calls[0].input_references.length, 1);
      assert.match(generate.buildRelightPrompt({ light: 'custom', custom: 'green lamp light', strength: 'subtle' }), /green lamp light.*subtly/);
      assert.throws(() => generate.buildRelightPrompt({ light: 'custom', custom: ' ', strength: 'subtle' }), /custom field/);
      assert.equal(issuesOf(registry, 'image.relight', { light: 'custom', custom: '' }).length, 1);
      assert.equal(issuesOf(registry, 'image.relight', { light: 'candle' }).length, 0);
      assert.equal(issuesOf(registry, 'image.edit', {}, { images: { connected: true, count: 9 } }).length, 1);
    }

    /* ----- video.seedance: mode, payload, waiting for the job, cost ----- */
    {
      resetMocks();
      const payloads = [];
      patch(or, 'createVideo', async (payload) => {
        payloads.push(payload);
        return { id: `or-job-${payloads.length}`, status: 'pending' };
      });

      let stop = startJobCompleter(sessionId, { cost: 0.55 });
      try {
        const ctx = makeCtx(sessionId);
        const t2v = await execute(registry, 'video.seedance', ctx, { prompt: text('Slow push-in') }, { duration: 6, aspect_ratio: '9:16', resolution: '720p' });
        assert.equal(payloads[0].model, 'bytedance/seedance-2.5');
        assert.equal(payloads[0].aspect_ratio, '9:16');
        assert.equal(payloads[0].duration, 6);
        assert.ok(!payloads[0].frame_images, 'text to video has no first frame');
        assert.equal(t2v.variants[0].video.type, 'video');
        assert.equal(t2v.variants[0].video.sessionId, sessionId);
        assert.equal(t2v.cost.usd, 0.55, 'the cost comes from the ledger the poller wrote');

        const i2v = await execute(registry, 'video.seedance', makeCtx(sessionId), { prompt: text('Animate'), first_frame: image1, refs: list('image', [image2]) }, { aspect_ratio: '9:16' });
        assert.equal(payloads[1].frame_images[0].frame_type, 'first_frame', 'image_to_video as soon as first_frame is connected');
        assert.ok(!('aspect_ratio' in payloads[1]), 'the first frame defines the format');
        assert.equal(payloads[1].input_references.length, 1);
        assert.equal(i2v.variants.length, 1);
      } finally {
        stop();
      }

      // audio/video references need PUBLIC_BASE_URL: reported before the run and by the tool (nothing is submitted)
      const before = payloads.length;
      const warned = issuesOf(registry, 'video.seedance', {}, { ref_videos: { connected: true, count: 1 } });
      assert.equal(warned.length, 1);
      assert.equal(warned[0].level, 'warning');
      assert.match(warned[0].message, /PUBLIC_BASE_URL/);
      await assert.rejects(
        execute(registry, 'video.seedance', makeCtx(sessionId), { prompt: text('x'), ref_videos: list('video', [video1]) }),
        /PUBLIC_BASE_URL/
      );
      assert.equal(payloads.length, before);
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      assert.equal(issuesOf(registry, 'video.seedance', {}, { ref_videos: { connected: true, count: 1 } }).length, 0);
      withEnv('PUBLIC_BASE_URL', undefined);

      // a failed job surfaces the provider error
      stop = startJobCompleter(sessionId, { fail: 'content policy' });
      try {
        await assert.rejects(execute(registry, 'video.seedance', makeCtx(sessionId), { prompt: text('x') }), /content policy/);
      } finally {
        stop();
      }
    }

    /* ----- catalogue: paging, caching, mapping ----- */
    {
      resetMocks();
      const calls = [];
      let clock = 1000;
      const fake = {
        status: () => ({ connected: true }),
        mcpCall: async (name, args) => {
          calls.push({ name, args });
          if (args.action === 'list' && !args.after) {
            return `${JSON.stringify({ items: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }], next_page_token: 'p2', has_more: true })}`;
          }
          if (args.action === 'list' && args.after === 'p2') {
            return `${JSON.stringify({ items: [{ id: 'm3', name: 'Three' }, { id: 'm1', name: 'One again' }], has_more: false })}`;
          }
          return `${modelJson({ id: args.model_id })}\n\nUnlim configs: none`;
        }
      };
      const catalog = catalogLib.createCatalog({ higgsfield: fake, now: () => clock, ttlMs: 500 });
      const models = await catalog.listModels('video');
      assert.deepEqual(models.map((model) => model.id), ['m1', 'm2', 'm3'], 'follows next_page_token and de-duplicates');
      assert.deepEqual(calls.map((call) => call.args.after), [undefined, 'p2']);
      assert.equal(calls[0].args.limit, 100);
      assert.equal(calls[0].args.type, 'video');
      await catalog.listModels('video');
      assert.equal(calls.length, 2, 'cached');
      assert.equal(catalog.peekModel('m2').name, 'Two', 'list items feed the model cache');
      clock += 501;
      assert.equal(catalog.peekModel('m2'), null, 'cache expires');
      await catalog.listModels('video');
      assert.equal(calls.length, 4, 'refetched after the TTL');
      await catalog.listModels('video', { refresh: true });
      assert.equal(calls.length, 6, 'manual refresh');
      await assert.rejects(catalog.listModels('audio'), /Unknown model type/);

      const model = await catalog.getModel('kling-3');
      assert.equal(model.id, 'kling-3', 'tolerates text after the JSON');
      const getCalls = calls.length;
      await catalog.getModel('kling-3');
      assert.equal(calls.length, getCalls, 'getModel is cached');

      const described = catalog.describeModel(model);
      assert.equal(described.name, 'Kling 3');
      assert.equal(described.provider, 'Kling');
      const byId = Object.fromEntries(described.params.map((param) => [param.id, param]));
      assert.deepEqual(byId.aspect_ratio.options, ['16:9', '9:16']);
      assert.equal(byId.aspect_ratio.target, 'aspect_ratio');
      assert.deepEqual(byId.duration.options, [5, 10]);
      assert.equal(byId.quality.kind, 'select');
      assert.equal(byId.quality.target, 'extra_params');
      assert.equal(byId.seed.kind, 'number');
      assert.equal(byId.seed.max, 100);
      assert.equal(byId.audio.kind, 'boolean');
      assert.equal(byId.styles.kind, 'tags');
      assert.ok(!byId.prompt, 'reserved parameters are not exposed');
      assert.deepEqual(described.refs, { max: 2, roles: ['start_image', 'end_image'], required: false });
      assert.deepEqual(described.credits, { perUnit: 3, unit: 'per_second' });
      assert.equal(catalog.creditsFor(model, { duration: 5 }), 15);
      assert.equal(catalog.creditsFor(model, {}), null, 'per-second pricing needs a duration');
      assert.equal(catalog.creditsFor({ credits_per_unit: 2, credit_unit: 'per_image' }), 2);

      const ranged = catalog.describeModel(JSON.parse(modelJson({ durations: undefined, duration_range: { min: 3, max: 15 }, medias: [{ name: 'a', type: 'image', max: 9, roles: ['image'] }, { name: 'b', type: 'image', max: 9, roles: ['image'] }] })));
      const duration = ranged.params.find((param) => param.id === 'duration');
      assert.deepEqual([duration.kind, duration.min, duration.max], ['integer', 3, 15]);
      assert.equal(ranged.refs.max, 12, 'references are capped at 12');

      // disconnected: no calls, empty results
      const offline = catalogLib.createCatalog({ higgsfield: { status: () => ({ connected: false }), mcpCall: async () => assert.fail('no call expected') } });
      assert.deepEqual(await offline.listModels('image'), []);
      assert.equal(await offline.getModel('x'), null);
    }

    /* ----- Higgsfield generation: extra_params whitelist, references, variants, credits ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      const calls = [];
      const submittedJobs = [];
      let modelResponse = () => `${modelJson()}\n\nUnlim configs: none`;
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (name === 'models_explore') return modelResponse(args);
        if (name === 'media_import_url') return `Imported media ${MEDIA_ID}`;
        if (name === 'generate_image_batch' || name === 'generate_video_batch') {
          submittedJobs.push(nextJobId());
          return `Submitted 1/1 generations.\n- index 0: ${submittedJobs.at(-1)} (pending)`;
        }
        throw new Error(`unexpected MCP call ${name}`);
      });
      catalogLib.clearCache();

      const stop = startJobCompleter(sessionId, { results: 2 });
      try {
        const ctx = makeCtx(sessionId);
        const result = await execute(
          registry,
          'video.higgsfield',
          ctx,
          { prompt: text('A fox runs') },
          { model: 'kling-3', aspect_ratio: '16:9', resolution: '1080p', duration: 5, extra_params: JSON.stringify({ quality: 'high', bogus: 1, seed: 500, audio: 'yes', model: 'evil', prompt: 'evil', use_unlim: true, styles: ['a'] }) }
        );
        const submit = calls.find((call) => call.name === 'generate_video_batch');
        const sent = submit.args.requests[0].params;
        assert.deepEqual(sent, { model: 'kling-3', prompt: 'A fox runs', use_unlim: false, aspect_ratio: '16:9', resolution: '1080p', duration: 5, quality: 'high', styles: ['a'] });
        const notes = ctx.logs.join('\n');
        assert.match(notes, /bogus.*nicht definiert/);
        assert.match(notes, /seed.*groesser als 100/);
        assert.match(notes, /audio.*true oder false/);
        assert.match(notes, /model ist reserviert/);
        assert.match(notes, /prompt ist reserviert/);
        assert.match(notes, /use_unlim ist reserviert/);
        assert.equal(result.variants.length, 2, 'every result becomes a variant');
        assert.deepEqual(result.variants.map((variant) => variant.video.type), ['video', 'video']);
        assert.notEqual(result.variants[0].video.assetId, result.variants[1].video.assetId);
        assert.deepEqual(result.cost, { credits: 15 }, 'credits_per_unit x duration');
        const jobRecord = (await store.readSession(sessionId)).jobs.find((job) => job.jobId === submittedJobs[0]);
        assert.equal(jobRecord.provider, 'higgsfield');
        assert.equal(jobRecord.kind, 'video');
        assert.equal(jobRecord.mode, 'higgsfield_video');
        assert.ok(journal.some((entry) => entry.type === 'higgsfield' && entry.model === 'kling-3' && entry.cost === 0));

        // a Director call (no ctx.nodeView) has extra_params ignored, so credits cannot be multiplied
        calls.length = 0;
        await tools.executeTool(
          { ...makeCtx(sessionId).toolCtx, nodeView: undefined },
          'higgsfield_generate_video',
          { model: 'kling-3', prompt: 'A fox runs', duration: 5, extra_params: { quality: 'high', num_images: 4 } }
        );
        const directorSubmit = calls.find((call) => call.name === 'generate_video_batch');
        assert.ok(directorSubmit, 'the Director call still submits');
        assert.ok(!('quality' in directorSubmit.args.requests[0].params) && !('num_images' in directorSubmit.args.requests[0].params), 'extra_params are ignored without ctx.nodeView');

        // image node with references (needs PUBLIC_BASE_URL) - the start_image role comes from the model
        calls.length = 0;
        await assert.rejects(
          execute(registry, 'image.higgsfield', makeCtx(sessionId), { prompt: text('x'), refs: list('image', [image1]) }, { model: 'kling-3' }),
          /PUBLIC_BASE_URL/
        );
        assert.ok(!calls.some((call) => call.name.endsWith('_batch')), 'nothing is submitted without PUBLIC_BASE_URL');
        withEnv('PUBLIC_BASE_URL', 'https://example.test');
        const withRefs = await execute(registry, 'image.higgsfield', makeCtx(sessionId), { prompt: text('Portrait'), refs: list('image', [image1, image2]) }, { model: 'kling-3', aspect_ratio: '9:16' });
        const imageSubmit = calls.find((call) => call.name === 'generate_image_batch');
        assert.deepEqual(imageSubmit.args.requests[0].params.medias, [{ value: MEDIA_ID, role: 'start_image' }, { value: MEDIA_ID, role: 'start_image' }]);
        assert.equal(imageSubmit.args.requests[0].params.aspect_ratio, '9:16');
        assert.equal(withRefs.variants.length, 2);
        assert.equal(withRefs.variants[0].image.type, 'image');
        assert.equal(removedRefs.length >= 2, true, 'published reference files are removed again');
        assert.equal(withRefs.cost, undefined, 'a per-second price without a duration stays unknown for images');
        await assert.rejects(
          execute(registry, 'image.higgsfield', makeCtx(sessionId), { prompt: text('x'), refs: list('image', [image1, image2, image1]) }, { model: 'kling-3' }),
          /accepts at most 2 reference images/
        );
        withEnv('PUBLIC_BASE_URL', undefined);
      } finally {
        stop();
      }

      // an unverifiable model with extra_params fails before anything is reserved or submitted
      calls.length = 0;
      modelResponse = () => {
        throw new Error('models_explore down');
      };
      catalogLib.clearCache();
      const ledgerBefore = (await store.readLedger(sessionId)).length;
      await assert.rejects(
        execute(registry, 'image.higgsfield', makeCtx(sessionId), { prompt: text('x') }, { model: 'unknown-model', extra_params: '{"quality":"high"}' }),
        /konnte nicht geprueft werden/
      );
      assert.ok(!calls.some((call) => call.name.endsWith('_batch')));
      assert.equal((await store.readLedger(sessionId)).length, ledgerBefore, 'no reserved asset is left behind');

      // without extra_params the model is not needed for the call itself
      modelResponse = () => {
        throw new Error('models_explore down');
      };
      const stopPlain = startJobCompleter(sessionId);
      try {
        const plain = await execute(registry, 'image.higgsfield', makeCtx(sessionId), { prompt: text('Plain') }, { model: 'unknown-model' });
        assert.equal(plain.variants.length, 1);
        assert.equal(plain.cost, undefined, 'unknown model, unknown credits');
      } finally {
        stopPlain();
      }

      // estimates for the plan come from the cached model without I/O
      modelResponse = () => `${modelJson()}`;
      catalogLib.clearCache();
      const videoDef = oneOf(registry, 'video.higgsfield');
      assert.equal(videoDef.cost.estimate({ model: 'kling-3', duration: 10 }), null, 'unknown until the catalogue was read');
      await catalogLib.getModel('kling-3');
      assert.deepEqual(videoDef.cost.estimate({ model: 'kling-3', duration: 10 }), { credits: 30 });

      // validation
      assert.match(issuesOf(registry, 'image.higgsfield', { model: '' })[0].message, /select a Higgsfield model/);
      assert.match(issuesOf(registry, 'video.higgsfield', { model: 'm', extra_params: '{nope' })[0].message, /not valid JSON/);
      assert.match(issuesOf(registry, 'video.higgsfield', { model: 'm', extra_params: '[1]' })[0].message, /JSON object/);
      const refWarning = issuesOf(registry, 'image.higgsfield', { model: 'm' }, { refs: { connected: true, count: 1 } });
      assert.equal(refWarning[0].level, 'warning');
      assert.deepEqual(generate.parseExtraParams(''), {});
    }

    /* ----- video.motion_graphics: placeholders ----- */
    {
      resetMocks();
      patch(rendernode, 'enabled', () => true);
      patch(rendernode, 'listConfiguredNodes', () => [{ id: 'mini', name: 'Mac mini', enabled: true }]);
      const submits = [];
      patch(rendernode, 'submit', async (html, quality, files, format) => {
        submits.push({ html, quality, files, format });
        return { jobId: `rn-${submits.length}`, nodeId: 'mini' };
      });
      const html = '<div id="main-composition" data-composition-id="main" data-width="1080" data-height="1920" data-start="0" data-duration="4"><img src="{{asset:2}}"><video src="{{asset: 1}}" muted></video></div>';
      const stop = startJobCompleter(sessionId);
      try {
        const ctx = makeCtx(sessionId);
        const result = await execute(
          registry,
          'video.motion_graphics',
          ctx,
          { html: text(html), assets: list('any', [video1, image1]) },
          { format: 'portrait', quality: 'draft', label: 'Title card' }
        );
        assert.equal(submits.length, 1);
        assert.equal(submits[0].quality, 'draft');
        assert.equal(submits[0].format, 'portrait');
        assert.match(submits[0].html, new RegExp(`<img src="${image1.assetId}\\.png"><video src="${video1.assetId}\\.mp4"`));
        assert.ok(!/\{\{asset/.test(submits[0].html));
        assert.deepEqual(submits[0].files.files.map((file) => file.filename), [`${video1.assetId}.mp4`, `${image1.assetId}.png`]);
        assert.equal(result.variants[0].video.type, 'video');
        assert.equal(result.cost, undefined, 'render nodes are free');
      } finally {
        stop();
      }
      await assert.rejects(
        execute(registry, 'video.motion_graphics', makeCtx(sessionId), { html: text('<div data-width="1920" data-height="1080">{{asset:3}}</div>'), assets: list('any', [image1]) }),
        /\{\{asset:3\}\} has no matching asset/
      );
      assert.equal(submits.length, 1, 'nothing is submitted for a bad placeholder');
      await assert.rejects(
        execute(registry, 'video.motion_graphics', makeCtx(sessionId), { html: text('<div data-width="100" data-height="100"></div>') }),
        /Composition-Masse/,
        'the tool validates the format dimensions'
      );
      assert.equal(issuesOf(registry, 'video.motion_graphics', { html: '<img src="{{asset:1}}">' }, { assets: { connected: false, count: 0 } }).length, 1);
      assert.equal(issuesOf(registry, 'video.motion_graphics', { html: '<img src="{{asset:1}}">' }, { assets: { connected: true, count: 1 } }).length, 0);
      assert.equal(generate.replaceAssetPlaceholders('a {{asset:1}} b', [image1]), `a ${image1.assetId}.png b`);
    }

    /* ----- audio.tts ----- */
    {
      resetMocks();
      patch(elevenlabs, 'hasKey', () => true);
      const requests = [];
      patch(elevenlabs, 'tts', async (request) => {
        requests.push(request);
        return Buffer.from('fake-mp3');
      });
      const result = await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hallo Welt') }, { voice_id: 'voice-9' });
      assert.deepEqual(requests[0], { text: 'Hallo Welt', voiceId: 'voice-9', modelId: 'eleven_multilingual_v2' });
      assert.equal(result.variants[0].audio.type, 'audio');
      assert.match(result.variants[0].audio.file, /\.mp3$/);
      await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hi') }, { voice_id: '' });
      assert.equal(requests[1].voiceId, '21m00Tcm4TlvDq8ikWAM', 'blank voice falls back to the default voice');
      await assert.rejects(execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('x'.repeat(2501)) }), /at most 2500/);
      assert.equal(issuesOf(registry, 'audio.tts', { text: 'x'.repeat(2501) }, { text: { connected: false, count: 0 } }).length, 1);
      assert.equal(requests.length, 2);
    }

    /* ----- video.concat (real ffmpeg when available) ----- */
    resetMocks();
    {
      await assert.rejects(execute(registry, 'video.concat', makeCtx(sessionId), { clips: list('video', [video1]) }), /at least 2 videos/);
      await assert.rejects(execute(registry, 'video.concat', makeCtx(sessionId), { clips: list('video', Array(21).fill(video1)) }), /at most 20/);
    }
    if (ffmpeg.binaries().available) {
      const binaries = ffmpeg.binaries();
      const dir = store.sessionAssetDir(sessionId);
      const clips = [];
      for (const name of ['a', 'b']) {
        const file = path.join(dir, `.gen-${name}.mp4`);
        execFileSync(binaries.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-y', file]);
        clips.push(await assets.saveOutputFile(sessionId, { kind: 'video', ext: '.mp4', sourceFile: file, prompt: `clip ${name}` }));
      }
      const ctx = makeCtx(sessionId);
      let slotUses = 0;
      ctx.withLocalSlot = (fn) => {
        slotUses += 1;
        return fn();
      };
      const joined = await execute(registry, 'video.concat', ctx, { clips: list('video', clips) }, { label: 'Joined' });
      assert.equal(slotUses, 1, 'ffmpeg work goes through the local slot');
      assert.equal(joined.variants[0].video.type, 'video');
      const probe = await ffmpeg.probeVideo(assets.assetFilePath(joined.variants[0].video));
      assert.ok(probe.duration > 1.5 && probe.duration < 2.6, `duration ${probe.duration}`);
      assert.equal(joined.cost, undefined);
    } else {
      console.log('SKIP ffmpeg fehlt: video.concat laeuft nicht real');
    }

    /* ----- LLM adapter and nodes ----- */
    {
      resetMocks();
      const postCalls = [];
      let postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        return { choices: [{ message: { content: 'Enhanced prompt' } }], usage: { cost: 0.002 } };
      };
      patch(or, 'postJson', (...args) => postImpl(...args));
      const streamCalls = [];
      patch(chatgpt, 'streamResponses', async (options) => {
        streamCalls.push(options);
        return { text: 'From ChatGPT', toolCalls: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      });
      patch(chatgpt, 'status', () => ({ connected: true }));
      journal.length = 0;

      // llm.chat via OpenRouter: default model, params, journal
      const ctx = makeCtx(sessionId);
      const chat = await execute(registry, 'llm.chat', ctx, { prompt: text('Write a haiku'), system: text('You are terse') }, { temperature: 0.3, max_tokens: 200, json: true });
      assert.equal(postCalls[0].route, '/chat/completions');
      assert.equal(postCalls[0].payload.model, 'vendor/default-brain', 'blank model = default brain');
      assert.deepEqual(postCalls[0].payload.messages, [{ role: 'system', content: 'You are terse' }, { role: 'user', content: 'Write a haiku' }]);
      assert.equal(postCalls[0].payload.temperature, 0.3);
      assert.equal(postCalls[0].payload.max_tokens, 200);
      assert.deepEqual(postCalls[0].payload.response_format, { type: 'json_object' });
      assert.deepEqual(chat.variants[0].text, { type: 'text', value: 'Enhanced prompt' });
      assert.equal(chat.cost.usd, 0.002);
      assert.deepEqual(journal.filter((entry) => entry.type === 'brain').map((entry) => [entry.sessionId, entry.model, entry.cost, entry.user]), [[sessionId, 'vendor/default-brain', 0.002, 'tester']]);
      assert.ok('temperature' in postCalls[0].payload);

      // blank temperature / max_tokens are not sent
      postCalls.length = 0;
      await execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x') }, { model: 'vendor/other' });
      assert.equal(postCalls[0].payload.model, 'vendor/other');
      assert.ok(!('temperature' in postCalls[0].payload) && !('max_tokens' in postCalls[0].payload) && !('response_format' in postCalls[0].payload));

      // response_format rejected (400) -> retried once without it
      postCalls.length = 0;
      let first = true;
      postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        if (first && payload.response_format) {
          first = false;
          throw Object.assign(new Error('bad response_format'), { status: 400 });
        }
        return { choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.001 } };
      };
      const json = await execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x') }, { json: true });
      assert.equal(postCalls.length, 2);
      assert.ok(!('response_format' in postCalls[1].payload));
      assert.equal(json.variants[0].text.value, '{"ok":true}');
      postImpl = async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      };
      await assert.rejects(execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x') }, { json: true }), /rate limited/);

      // images: content parts; non-vision models are rejected
      postCalls.length = 0;
      postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        return { choices: [{ message: { content: [{ type: 'text', text: 'seen' }] } }], usage: { cost: 0.003 } };
      };
      const seen = await execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('What is this?'), images: list('image', [image1, image2]) });
      const userMessage = postCalls[0].payload.messages.at(-1);
      assert.equal(userMessage.content[0].type, 'text');
      assert.equal(userMessage.content.filter((part) => part.type === 'image_url').length, 2);
      assert.match(userMessage.content[1].image_url.url, /^data:image\/png;base64,/);
      assert.equal(seen.variants[0].text.value, 'seen', 'array content is flattened');
      patch(discovery, 'brainSupportsImages', async () => false);
      await assert.rejects(execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x'), images: list('image', [image1]) }), /does not accept images/);
      patch(discovery, 'brainSupportsImages', async () => true);
      await assert.rejects(execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x'), images: list('image', Array(9).fill(image1)) }), /at most 8/);

      // count -> variants
      postCalls.length = 0;
      postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        return { choices: [{ message: { content: `answer ${postCalls.length}` } }], usage: { cost: 0.01 } };
      };
      const multi = await execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x') }, { count: 3 });
      assert.equal(multi.variants.length, 3);
      assert.ok(Math.abs(multi.cost.usd - 0.03) < 1e-9);

      // empty answers are errors
      postImpl = async () => ({ choices: [{ message: { content: '  ' } }], usage: { cost: 0 } });
      await assert.rejects(execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('x') }), /empty answer/);

      // ChatGPT subscription route: streamResponses, no postJson, journaled with cost 0 and billing Abo
      postCalls.length = 0;
      journal.length = 0;
      const gpt = await execute(registry, 'llm.chat', makeCtx(sessionId), { prompt: text('Hello'), system: text('Be brief'), images: list('image', [image1]) }, { model: 'chatgpt/gpt-5.6-sol', json: true, temperature: 1.2 });
      assert.equal(postCalls.length, 0);
      assert.equal(streamCalls.length, 1);
      assert.equal(streamCalls[0].model, 'chatgpt/gpt-5.6-sol');
      assert.match(streamCalls[0].instructions, /^Be brief\n\nRespond with a single valid JSON object/);
      assert.deepEqual(streamCalls[0].tools, []);
      assert.equal(streamCalls[0].input[0].role, 'user');
      assert.deepEqual(streamCalls[0].input[0].content.map((part) => part.type), ['input_text', 'input_image']);
      assert.equal(gpt.variants[0].text.value, 'From ChatGPT');
      assert.equal(gpt.cost.usd, 0);
      const abo = journal.find((entry) => entry.type === 'brain');
      assert.equal(abo.cost, 0);
      assert.equal(abo.billing, 'Abo');
      assert.equal(abo.model, 'chatgpt/gpt-5.6-sol');
      assert.equal(abo.usage.total_tokens, 15);

      // prompt enhancer / describers / motion html
      postCalls.length = 0;
      postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        return { choices: [{ message: { content: 'result text' } }], usage: { cost: 0.002 } };
      };
      await execute(registry, 'llm.prompt_enhancer', makeCtx(sessionId), { prompt: text('ein Kaffee'), images: list('image', [image1]) }, { target: 'video', notes: 'vertical, 5 seconds' });
      assert.match(postCalls[0].payload.messages[0].content, /video generator/);
      assert.match(postCalls[0].payload.messages[0].content, /English/);
      assert.match(postCalls[0].payload.messages[1].content[0].text, /^ein Kaffee\n\nAdditional notes: vertical, 5 seconds$/);
      assert.equal(postCalls[0].payload.messages[1].content.length, 2);
      assert.match(generate.enhancerSystem('speech'), /Keep the language of the input/);

      postCalls.length = 0;
      await execute(registry, 'llm.image_describer', makeCtx(sessionId), { image: image1 }, { focus: 'style', language: 'de' });
      assert.match(postCalls[0].payload.messages[0].content, /visual style/);
      assert.match(postCalls[0].payload.messages[0].content, /German/);
      assert.equal(postCalls[0].payload.messages[1].content.filter((part) => part.type === 'image_url').length, 1);

      // video describer: three frames of poller.extractVideoFrames
      const extracted = [];
      patch(poller, 'extractVideoFrames', async (file) => {
        extracted.push(file);
        return [Buffer.from('f1'), Buffer.from('f2'), Buffer.from('f3')];
      });
      postCalls.length = 0;
      let slotUsed = 0;
      const videoCtx = makeCtx(sessionId);
      videoCtx.withLocalSlot = (fn) => {
        slotUsed += 1;
        return fn();
      };
      const described = await execute(registry, 'llm.video_describer', videoCtx, { video: video1 }, { focus: 'motion' });
      assert.equal(extracted[0], path.join(store.sessionAssetDir(sessionId), video1.file));
      const frameParts = postCalls[0].payload.messages[1].content.filter((part) => part.type === 'image_url');
      assert.equal(frameParts.length, 3, 'three frames are sent');
      assert.equal(frameParts[0].image_url.url, `data:image/jpeg;base64,${Buffer.from('f1').toString('base64')}`);
      assert.match(postCalls[0].payload.messages[0].content, /movement/);
      assert.equal(slotUsed, 1);
      assert.equal(described.variants[0].text.value, 'result text');

      // motion html writer: system prompt from the tool description, fences stripped
      postCalls.length = 0;
      postImpl = async (route, payload) => {
        postCalls.push({ route, payload });
        return { choices: [{ message: { content: '```html\n<div id="main-composition"></div>\n```' } }], usage: { cost: 0.01 } };
      };
      const motion = await execute(registry, 'llm.motion_html', makeCtx(sessionId), { brief: text('Title card'), assets: list('any', [image1, video1]) }, { format: 'portrait', duration: 8 });
      assert.equal(motion.variants[0].html.value, '<div id="main-composition"></div>');
      const motionSystem = postCalls[0].payload.messages[0].content;
      assert.match(motionSystem, /portrait = 1080x1920 px, duration 8 seconds/);
      assert.match(motionSystem, /data-width="1080"/);
      assert.match(motionSystem, /\{\{asset:1\}\} = image \(png\)/);
      assert.match(motionSystem, /\{\{asset:2\}\} = video \(mp4\)/);
      assert.ok(motionSystem.includes(tools.RENDER_MOTION_GRAPHICS_DEFINITION.function.description), 'includes the render contract');
      assert.equal(generate.stripCodeFence('Here it is: <div>x</div>'), '<div>x</div>');

      // direct adapter checks
      await assert.rejects(llm.completeText({ model: '', prompt: 'x' }), /No model/);
      await assert.rejects(llm.completeText({ model: 'vendor/x', prompt: ' ' }), /prompt is empty/);
      assert.equal(llm.isChatGPTModel('chatgpt/gpt-5.6-luna'), true);
      assert.equal(llm.isChatGPTModel('openai/gpt-5.2'), false);
    }

    /* ----- Higgsfield edit tools (experimental) ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      const removed = removedRefs;
      removed.length = 0;
      const calls = [];
      const editJobs = [];
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (name === 'media_import_url') return `Imported media ${MEDIA_ID}`;
        // the reply mentions the source media as well: the job id must not be mistaken for it
        editJobs.push(nextJobId());
        return `Job for source ${MEDIA_ID} submitted: ${editJobs.at(-1)} (pending)`;
      });
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      let probed = { video: { width: 640, height: 480 }, duration: 8 };
      patch(ffmpeg, 'probeVideo', async () => probed);
      withEnv('PUBLIC_BASE_URL', 'https://example.test');

      const stop = startJobCompleter(sessionId, {});
      try {
        const editCtx = () => makeCtx(sessionId);
        const bg = await execute(registry, 'hf.remove_background', editCtx(), { media: image1 }, { kind: 'image' });
        assert.deepEqual(calls.at(-1), { name: 'remove_background', args: { params: { media_id: MEDIA_ID, media_type: 'image' } } });
        assert.equal(bg.variants[0].media.type, 'image');
        assert.equal((await store.readSession(sessionId)).jobs.find((job) => job.jobId === editJobs[0]).mode, 'higgsfield_edit');
        assert.ok(removed.length >= 1, 'published sources are removed again');

        await execute(registry, 'hf.remove_background', editCtx(), { media: video1 }, { kind: 'video' });
        assert.deepEqual(calls.at(-1).args.params, { media_id: MEDIA_ID, media_type: 'video' });
        assert.equal((await store.readSession(sessionId)).jobs.at(-1).kind, 'video');

        const up = await execute(registry, 'hf.upscale_image', editCtx(), { image: image1 }, { resolution: '2k' });
        assert.deepEqual(calls.at(-1), { name: 'upscale_image', args: { params: { provider: 'bytedance', width: 640, height: 480, resolution: '2k', image_id: MEDIA_ID } } });
        assert.equal(up.variants[0].image.type, 'image');

        await execute(registry, 'hf.upscale_video', editCtx(), { video: video1 }, { provider: 'topaz', resolution: '4k' });
        assert.deepEqual(calls.at(-1).args.params, { provider: 'topaz', resolution: '2160p', video_id: MEDIA_ID });
        await execute(registry, 'hf.upscale_video', editCtx(), { video: video1 }, { provider: 'bytedance', resolution: '2k' });
        assert.deepEqual(calls.at(-1).args.params, { provider: 'bytedance', width: 640, height: 480, resolution: '2k', video_id: MEDIA_ID });
        await assert.rejects(execute(registry, 'hf.upscale_video', editCtx(), { video: video1 }, { provider: 'topaz', resolution: '2k' }), /Topaz supports/);
        assert.equal(issuesOf(registry, 'hf.upscale_video', { provider: 'topaz', resolution: '2k' }).length, 1);

        await execute(registry, 'hf.outpaint_image', editCtx(), { image: image1 }, { aspect_ratio: '21:9' });
        assert.deepEqual(calls.at(-1), { name: 'outpaint_image', args: { params: { aspect_ratio: '21:9', image_id: MEDIA_ID } } });

        await execute(registry, 'hf.reframe_video', editCtx(), { video: video1 }, { aspect_ratio: '9:16', resolution: '720p' });
        assert.deepEqual(calls.at(-1).args.params, { aspect_ratio: '9:16', resolution: '720p', medias: [{ value: MEDIA_ID, role: 'video' }] }, 'short videos need no duration');
        probed = { video: { width: 640, height: 480 }, duration: 20.2 };
        await execute(registry, 'hf.reframe_video', editCtx(), { video: video1 }, { aspect_ratio: '9:16', resolution: '1080p' });
        assert.equal(calls.at(-1).args.params.duration_seconds, 21, 'sources over 15 s pass their duration');
        probed = { video: { width: 640, height: 480 }, duration: 75 };
        await assert.rejects(execute(registry, 'hf.reframe_video', editCtx(), { video: video1 }, {}), /up to 60 s/);

        // the Director (no ctx.nodeView) can never reach the node-only edit tool
        const directorCtx = { ...editCtx().toolCtx, nodeView: undefined };
        const beforeDirector = calls.length;
        await assert.rejects(tools.executeTool(directorCtx, 'higgsfield_edit', { tool: 'upscale_image', kind: 'image', source_asset_ids: [image1.assetId] }), /nur in der Node-Ansicht/);
        assert.equal(calls.length, beforeDirector, 'the Director call submitted nothing');

        // direct tool guards
        await assert.rejects(tools.executeTool(editCtx().toolCtx, 'higgsfield_edit', { tool: 'format_disk', kind: 'image', source_asset_ids: [image1.assetId] }), /Unbekanntes Higgsfield-Edit-Tool/);
        await assert.rejects(tools.executeTool(editCtx().toolCtx, 'higgsfield_edit', { tool: 'outpaint_image', kind: 'image', source_asset_ids: [] }), /genau eine Asset-ID/);
        await assert.rejects(tools.executeTool(editCtx().toolCtx, 'higgsfield_edit', { tool: 'upscale_video', kind: 'video', source_asset_ids: [image1.assetId] }), /keine gueltige Video-Quelle/);
        withEnv('PUBLIC_BASE_URL', undefined);
        const submitted = calls.length;
        await assert.rejects(execute(registry, 'hf.outpaint_image', editCtx(), { image: image1 }, {}), /PUBLIC_BASE_URL/);
        assert.equal(calls.length, submitted, 'nothing is imported without PUBLIC_BASE_URL');
      } finally {
        stop();
      }
    }

    /* ----- engine integration: list map, count variants, caching ----- */
    {
      resetMocks();
      const imageCalls = [];
      patch(or, 'createImage', async (payload) => {
        imageCalls.push(payload);
        return imageResponse(0.04);
      });
      const brainCalls = [];
      patch(or, 'postJson', async (route, payload) => {
        brainCalls.push(payload);
        return { choices: [{ message: { content: `Better: ${payload.messages.at(-1).content}` } }], usage: { cost: 0.001 } };
      });
      const engine = createEngine({
        store: wfStore,
        registry,
        events: bus,
        getConfig: () => ({ imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5', defaultBrain: 'vendor/default-brain' }),
        limits: { jobPollMs: 20 }
      });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

      const wf = await newWorkflow('Engine integration', {
        nodes: [
          node('n1', 'input.text', { text: 'a cup of coffee' }),
          node('n2', 'llm.prompt_enhancer', { target: 'image' }, 300),
          node('n3', 'image.generate', { aspect_ratio: '9:16', count: 3 }, 600),
          node('n4', 'output.result', { label: 'Stills' }, 900)
        ],
        edges: [edge('e1', 'n1', 'text', 'n2', 'prompt'), edge('e2', 'n2', 'text', 'n3', 'prompt'), edge('e3', 'n3', 'image', 'n4', 'inputs')]
      });
      const planBefore = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(planBefore.valid, true, JSON.stringify(planBefore.issues));
      assert.equal(planBefore.nodes.n3.status, 'stale');
      assert.equal(planBefore.nodes.n3.paid, true);
      assert.equal(planBefore.nodes.n3.estimate, null, 'no price table: unknown before the first run');
      assert.equal(planBefore.totals.paidNodes, 2);

      const runId = await engine.start(wf.id, { mode: 'all', user: 'tester' });
      const record = await engine.whenFinished(wf.id, runId);
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(imageCalls.length, 3);
      assert.equal(imageCalls[0].prompt, 'Better: a cup of coffee');
      assert.equal(brainCalls.length, 1);
      const results = await wfStore.readResults(wf.id);
      assert.equal(results.nodes.n3.history[0].variants.length, 3);
      assert.ok(Math.abs(results.nodes.n3.history[0].cost.usd - 0.12) < 1e-9);
      assert.equal(results.nodes.n2.history[0].cost.usd, 0.001);
      assert.ok(Math.abs(record.cost.usd - 0.121) < 1e-9);

      const planAfter = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(planAfter.nodes.n3.status, 'cached');
      const cachedRun = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all' }));
      assert.equal(cachedRun.nodes.n3.status, 'cached');
      assert.equal(imageCalls.length, 3, 'a cache hit calls no provider');

      // estimate = last actual cost of the node type in this workflow, scaled by count
      const current = await wfStore.readWorkflow(wf.id);
      const changed = current.graph.nodes.map((item) => (item.id === 'n3' ? { ...item, params: { aspect_ratio: '9:16', count: 1 } } : item));
      await wfStore.saveGraph(wf.id, { baseRev: current.rev, graph: { ...current.graph, nodes: changed } });
      const planCount1 = await engine.plan(wf.id, { mode: 'node', nodeIds: ['n3'] });
      assert.equal(planCount1.nodes.n3.status, 'stale');
      assert.ok(Math.abs(planCount1.nodes.n3.estimate.usd - 0.04) < 1e-9);

      // implicit map: a text list feeds the prompt port, count is forced to 1 per item
      imageCalls.length = 0;
      const listWf = await newWorkflow('Batch', {
        nodes: [
          node('l1', 'input.text_list', { text: 'red mug\ngreen mug\nblue mug' }),
          node('l2', 'image.generate', { count: 4 }, 300)
        ],
        edges: [edge('e1', 'l1', 'items', 'l2', 'prompt')]
      });
      const listRun = await engine.whenFinished(listWf.id, await engine.start(listWf.id, { mode: 'all' }));
      assert.equal(listRun.status, 'completed', JSON.stringify(listRun.nodes));
      assert.deepEqual(imageCalls.map((payload) => payload.prompt).sort(), ['blue mug', 'green mug', 'red mug']);
      const listResults = await wfStore.readResults(listWf.id);
      const listVariant = listResults.nodes.l2.history[0].variants;
      assert.equal(listVariant.length, 1);
      assert.equal(listVariant[0].image.type, 'list');
      assert.equal(listVariant[0].image.items.length, 3);

      // an unconnected required prompt is a validation error before any provider call
      const bad = await newWorkflow('Invalid', { nodes: [node('b1', 'image.generate', { prompt: '' })], edges: [] });
      await assert.rejects(engine.start(bad.id, { mode: 'all' }), (err) => err.code === 'INVALID_GRAPH' && /prompt/.test(err.message));
      assert.equal(imageCalls.length, 3);

      // an unavailable provider is reported by the plan and fails the node
      patch(or, 'hasKey', () => false);
      const planOff = await engine.plan(bad.id, { mode: 'all' });
      assert.equal(planOff.nodes.b1.status, 'invalid');
      const okWf = await newWorkflow('Offline', { nodes: [node('o1', 'image.generate', { prompt: 'x' })], edges: [] });
      const offlinePlan = await engine.plan(okWf.id, { mode: 'all' });
      assert.equal(offlinePlan.nodes.o1.status, 'unavailable');
      assert.match(offlinePlan.nodes.o1.reason, /OPENROUTER/);
    }

    /* ----- option sources and model route of the real server app use the catalogue ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      patch(higgsfield, 'mcpCall', async (name, args) => {
        assert.equal(name, 'models_explore');
        if (args.action === 'list') {
          return JSON.stringify({ items: [{ id: `${args.type}-model`, name: `Model for ${args.type}` }], has_more: false });
        }
        return args.model_id === 'kling-3' ? modelJson() : JSON.stringify({ items: [] });
      });
      catalogLib.clearCache();
      const { app: realApp } = require('../server');
      const layers = realApp._router.stack.filter((item) => item.route);
      const handlerOf = (routePath) => layers.find((item) => item.route.path === routePath && item.route.methods.get).route.stack.slice(-1)[0].handle;
      const call = (routePath, params) =>
        new Promise((resolve, reject) => {
          const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
          Promise.resolve(handlerOf(routePath)({ params, query: {}, headers: {} }, res)).catch(reject);
        });
      const images = await call('/api/nodes/options/:source', { source: 'higgsfield-image-models' });
      assert.equal(images.status, 200);
      assert.deepEqual(images.body.options, [{ value: 'image-model', label: 'Model for image' }]);
      const videos = await call('/api/nodes/options/:source', { source: 'higgsfield-video-models' });
      assert.deepEqual(videos.body.options, [{ value: 'video-model', label: 'Model for video' }]);
      const model = await call('/api/nodes/higgsfield-models/:modelId', { modelId: 'kling-3' });
      assert.equal(model.status, 200);
      assert.equal(model.body.name, 'Kling 3');
      assert.ok(model.body.params.some((param) => param.id === 'quality' && param.target === 'extra_params'));
      assert.equal((await call('/api/nodes/higgsfield-models/:modelId', { modelId: 'gone' })).status, 404);
      const registryPayload = (await call('/api/nodes/registry', {})).body;
      assert.ok(registryPayload.nodeTypes.some((type) => type.type === 'image.higgsfield' && type.category === 'higgsfield'));
      assert.ok(registryPayload.nodeTypes.some((type) => type.type === 'hf.remove_background' && type.experimental === true));
      catalogLib.clearCache();
    }

    console.log('test-nodes-generate: ok');
  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
