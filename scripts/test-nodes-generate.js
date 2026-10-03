'use strict';

// Tests for the generative node types (lib/nodes/nodes-generate.js, llm.js, higgsfield-catalog.js) and the
// tools.js extensions they need (extra_params, higgsfield_edit, higgsfield_speech, the media_upload path). No provider
// is contacted: every provider function (and global.fetch for the uploads) is replaced and restored in `finally`.
// Backing sessions and temp files are removed at the end.

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
      const bytes = kind === 'image' ? PNG : Buffer.from(kind === 'audio' ? 'fake-wav' : 'fake-mp4');
      const ids = [(await store.completeAsset(sessionId, job.assetId, bytes, isHiggsfield ? 0 : cost)).id];
      for (let index = 1; index < results; index += 1) {
        const extra = await store.saveAsset(sessionId, {
          kind,
          buffer: bytes,
          ext: kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4',
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

// seed_audio as the live MCP describes it (2026-09-29): its one media slot is typed "image" and carries both reference roles
function seedAudioJson(extra = {}) {
  return JSON.stringify({
    id: 'seed_audio',
    name: 'Seed Audio',
    provider_name: 'ByteDance',
    description: 'Speech',
    output_type: 'audio',
    parameters: [
      { name: 'prompt', required: 'required', type: 'string' },
      { name: 'format', required: 'optional', type: 'string', options: ['wav', 'mp3', 'pcm', 'ogg_opus'], default: 'wav' },
      { name: 'sample_rate', required: 'optional', type: 'number', options: [8000, 16000, 24000, 32000, 44100, 48000], default: 24000 },
      { name: 'speech_rate', required: 'optional', type: 'integer', min: -50, max: 100, default: 0 },
      { name: 'loudness_rate', required: 'optional', type: 'integer', min: -50, max: 100, default: 0 },
      { name: 'pitch_rate', required: 'optional', type: 'integer', min: -12, max: 12, default: 0 },
      { name: 'voice_type', required: 'optional', type: 'string', options: ['preset', 'element'] },
      { name: 'voice_id', required: 'optional', type: 'string' }
    ],
    medias: [{ name: 'medias', type: 'image', roles: ['image_references', 'audio_references'] }],
    supports_unlim: true,
    unlim: { available: false },
    credits_per_unit: 4,
    credit_unit: 'per_generation',
    ...extra
  });
}

// text2speech_v2 (no media slot, needs a variant); the exact shape is assumed, the variant names come from the CLI docs
function speechV2Json(extra = {}) {
  return JSON.stringify({
    id: 'text2speech_v2',
    name: 'Text2Speech v2',
    output_type: 'audio',
    parameters: [
      { name: 'prompt', required: 'required', type: 'string' },
      { name: 'variant', required: 'required', type: 'string', options: ['elevenlabs', 'minimax', 'seed_speech', 'vibe_voice', 'cozy_voice'] },
      { name: 'speed', required: 'optional', type: 'number', min: 0.5, max: 2 }
    ],
    credits_per_unit: 2,
    credit_unit: 'per_generation',
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
    const audio1 = await upload('.mp3', Buffer.from('fake-mp3'));

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
      // the image nodes read the model list of OpenRouter before a plan or a run (lib/image-models.js): none here
      patch(discovery, 'listImageModels', async () => ({ data: [] }));
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
        'video.seedance', 'video.generate', 'video.higgsfield', 'video.motion_graphics', 'video.concat', 'audio.tts', 'audio.music', 'audio.music_plan',
        'hf.remove_background', 'hf.upscale_image', 'hf.upscale_video', 'hf.outpaint_image', 'hf.reframe_video',
        'hf.dubbing', 'hf.voice_change', 'hf.motion_control', 'hf.speech'
      ];
      for (const type of expected) oneOf(registry, type);
      assert.equal(generate.definitions.length, expected.length);
      assert.ok(oneOf(registry, 'hf.upscale_image').experimental && oneOf(registry, 'hf.reframe_video').experimental);
      for (const type of ['hf.dubbing', 'hf.voice_change', 'hf.motion_control', 'hf.speech']) {
        const def = oneOf(registry, type);
        assert.equal(def.category, 'higgsfield', type);
        assert.equal(def.experimental, true, type);
        assert.equal(def.paid, true, type);
        assert.equal(def.async, true, type);
        assert.equal(def.cost.unit, 'credits', type);
      }
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
      for (const type of ['image.higgsfield', 'video.higgsfield', 'hf.remove_background', 'hf.upscale_video', 'hf.dubbing', 'hf.voice_change', 'hf.motion_control', 'hf.speech']) {
        assert.match(registry.availability(oneOf(registry, type)), /Higgsfield/, type);
      }
      patch(higgsfield, 'status', () => ({ connected: true }));
      assert.equal(registry.availability(oneOf(registry, 'image.higgsfield')), true);
      // the Higgsfield nodes depend on the connection only: without PUBLIC_BASE_URL the sources are uploaded (media_upload)
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      for (const type of ['hf.remove_background', 'hf.upscale_image', 'hf.upscale_video', 'hf.outpaint_image', 'hf.reframe_video', 'hf.dubbing', 'hf.voice_change', 'hf.motion_control', 'hf.speech']) {
        assert.equal(registry.availability(oneOf(registry, type)), true, `${type} without PUBLIC_BASE_URL`);
      }
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      assert.equal(registry.availability(oneOf(registry, 'hf.remove_background')), true);
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: null, ffprobe: null, available: false }));
      assert.equal(registry.availability(oneOf(registry, 'hf.outpaint_image')), true);
      for (const type of ['hf.dubbing', 'hf.voice_change', 'hf.motion_control', 'hf.speech']) {
        assert.equal(registry.availability(oneOf(registry, type)), true, `${type} does not probe with ffmpeg`);
      }
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
      const portSummary = (type) => {
        const def = oneOf(registry, type);
        return [def.inputs.map((port) => `${port.id}:${port.type}${port.required ? '!' : ''}`), def.outputs.map((port) => `${port.id}:${port.type}`)];
      };
      assert.deepEqual(portSummary('hf.dubbing'), [['video:video!'], ['video:video']]);
      assert.deepEqual(portSummary('hf.voice_change'), [['video:video!'], ['video:video']]);
      assert.deepEqual(portSummary('hf.motion_control'), [['image:image!', 'motion:video!'], ['video:video']]);
      assert.deepEqual(portSummary('hf.speech'), [['text:text!', 'reference_audio:audio'], ['audio:audio']]);
      assert.equal(oneOf(registry, 'hf.speech').inputs[0].param, 'text', 'the text may be typed inline');
      assert.deepEqual(portSummary('video.higgsfield')[0], ['prompt:text!', 'refs:image', 'audio:audio'], 'the audio input is optional');
      assert.deepEqual(portSummary('image.higgsfield')[0], ['prompt:text!', 'refs:image'], 'image models have no audio input');
      const paramOf = (type, id) => oneOf(registry, type).params.find((param) => param.id === id);
      assert.deepEqual(paramOf('hf.dubbing', 'target_language').options, tools.HIGGSFIELD_DUBBING_LANGUAGES);
      assert.equal(tools.HIGGSFIELD_DUBBING_LANGUAGES.length, 18);
      assert.equal(paramOf('hf.dubbing', 'target_language').default, 'eng');
      assert.equal(paramOf('hf.voice_change', 'voice').optionsSource, 'higgsfield-voices');
      assert.equal(paramOf('hf.speech', 'voice').optionsSource, 'higgsfield-voices');
      assert.deepEqual(paramOf('hf.speech', 'model').options, ['seed_audio', 'text2speech_v2'], 'only the verified speech models are offered');
      assert.deepEqual(paramOf('hf.speech', 'model').options, tools.HIGGSFIELD_SPEECH_MODELS);
      assert.equal(paramOf('hf.speech', 'model').optionsSource, undefined);
      assert.equal(paramOf('hf.speech', 'model').default, 'seed_audio');
      const portOf = (type, id) => oneOf(registry, type).inputs.find((port) => port.id === id);
      assert.deepEqual([portOf('hf.speech', 'reference_audio').multiple, portOf('hf.speech', 'reference_audio').max], [true, 2], 'seed_audio takes 0..2 reference audios');
      assert.deepEqual([portOf('video.higgsfield', 'audio').multiple, portOf('video.higgsfield', 'audio').max], [true, 15], 'up to 15 tracks, the model limit is checked at run time');
      assert.ok(!portOf('video.higgsfield', 'audio').required);
      assert.equal(paramOf('hf.speech', 'extra_params').dynamic, 'higgsfield-model');
      assert.deepEqual(paramOf('hf.motion_control', 'resolution').options, ['720p', '1080p']);
      assert.equal(paramOf('hf.motion_control', 'resolution').default, '720p');
      assert.deepEqual(paramOf('hf.motion_control', 'scene_control').options, ['image', 'video']);
      assert.equal(paramOf('hf.motion_control', 'scene_control').default, 'image');

      // the public descriptor serialises (no functions) and keeps the dynamic-param hints
      const descriptor = registry.publicDescriptor(oneOf(registry, 'video.higgsfield'));
      JSON.stringify(descriptor);
      assert.equal(descriptor.params.find((param) => param.id === 'extra_params').dynamic, 'higgsfield-model');
      assert.equal(descriptor.cost.unit, 'credits');
    }

    /* ----- Director tool list: unchanged except for the two workflow tools (WP26) ----- */
    {
      resetMocks();
      patch(rendernode, 'enabled', () => true);
      patch(higgsfield, 'status', () => ({ connected: true }));
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      const names = tools.toolDefinitions().map((definition) => definition.function.name);
      assert.deepEqual(names, [
        'generate_image', 'edit_image', 'generate_video', 'generate_speech', 'list_voices', 'import_gts_asset',
        'create_branding', 'update_branding', 'add_branding_asset', 'import_branding_asset', 'create_cast_member',
        'update_cast_member', 'import_cast_asset', 'save_memory', 'save_project_memory', 'list_workflows', 'run_workflow', 'render_motion_graphics',
        'concat_videos', 'higgsfield_models', 'higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_check_balance'
      ]);
      assert.ok(!names.includes('higgsfield_edit'));
      assert.ok(!names.includes('higgsfield_speech'), 'speech is node view only, too');
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

      // WP31: the limits of the inputs are those of Seedance 2.5; another configured video model takes fewer references
      // (lib/video-models.js). The node view skips the check of the tool layer, so the node refuses before anything is sent.
      const sent = payloads.length;
      const tenImages = list('image', Array.from({ length: 10 }, () => image1));
      await assert.rejects(
        execute(registry, 'video.seedance', makeCtx(sessionId, { videoModel: 'bytedance/seedance-2.0-fast' }), { prompt: text('x'), refs: tenImages }),
        /Model bytedance\/seedance-2.0-fast accepts at most 9 reference images \(got 10\)/
      );
      await assert.rejects(
        execute(registry, 'video.seedance', makeCtx(sessionId, { videoModel: 'alibaba/wan-2.7' }), { prompt: text('x'), ref_videos: list('video', [video1]) }),
        /Model alibaba\/wan-2.7 takes no reference videos \(got 1\)/
      );
      await assert.rejects(
        execute(registry, 'video.seedance', makeCtx(sessionId, { videoModel: 'google/veo-3.1-lite' }), { prompt: text('x'), refs: list('image', [image1]) }),
        /Model google\/veo-3.1-lite takes no reference images \(got 1\)/
      );
      assert.equal(payloads.length, sent, 'nothing was submitted');
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
      await assert.rejects(catalog.listModels('3d'), /Unknown model type/);
      calls.length = 0;
      await catalog.listModels('audio');
      assert.equal(calls[0].args.type, 'audio', 'audio models are listed, too');

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

        // image node with references imported by URL (PUBLIC_BASE_URL set; the upload path has its own section below)
        // - the start_image role comes from the model
        calls.length = 0;
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
      // references no longer warn about PUBLIC_BASE_URL: without it the images are uploaded
      assert.deepEqual(issuesOf(registry, 'image.higgsfield', { model: 'm' }, { refs: { connected: true, count: 1 } }), []);
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
      const composition = '<div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="4"><img src="{{asset:1}}"></div>';
      assert.equal(issuesOf(registry, 'video.motion_graphics', { html: composition }, { assets: { connected: false, count: 0 } }).length, 1);
      assert.equal(issuesOf(registry, 'video.motion_graphics', { html: composition }, { assets: { connected: true, count: 1 } }).length, 0);
      assert.equal(generate.replaceAssetPlaceholders('a {{asset:1}} b', [image1]), `a ${image1.assetId}.png b`);
    }

    /* ----- audio.tts ----- */
    {
      resetMocks();
      withEnv('ELEVENLABS_USD_PER_1K_CHARS', undefined);
      patch(elevenlabs, 'hasKey', () => true);
      const requests = [];
      patch(elevenlabs, 'tts', async (request) => {
        requests.push(request);
        return Buffer.from('fake-mp3');
      });
      const journalBefore = journal.length;
      const result = await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hallo Welt') }, { voice_id: 'voice-9' });
      assert.deepEqual(requests[0], { text: 'Hallo Welt', voiceId: 'voice-9', modelId: 'eleven_v4' }, 'a new node speaks with Eleven v4');
      assert.equal(result.variants[0].audio.type, 'audio');
      assert.match(result.variants[0].audio.file, /\.mp3$/);
      // paid, with the estimate by character; the run reports it and the tool journals it (for everybody)
      assert.deepEqual(result.cost, { usd: 0.0008 }, '10 characters at 0.08 USD per 1000 (the list price)');
      assert.equal(journal.length, journalBefore + 1);
      assert.equal(journal.at(-1).type, 'speech');
      assert.equal(journal.at(-1).cost, 0.0008);
      // without a login (local mode) the speech is booked for 'lokal' like every other cost, not for a user of its own
      const anonymous = makeCtx(sessionId);
      anonymous.user = undefined;
      anonymous.toolCtx.user = undefined;
      await execute(registry, 'audio.tts', anonymous, { text: text('Ohne Login') }, { voice_id: 'voice-9' });
      assert.equal(journal.at(-1).type, 'speech');
      assert.equal(journal.at(-1).user, 'lokal');
      requests.pop();
      await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hi') }, { voice_id: '' });
      assert.equal(requests[1].voiceId, '21m00Tcm4TlvDq8ikWAM', 'blank voice falls back to the default voice');
      await assert.rejects(execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('x'.repeat(2501)) }), /at most 2500/);
      assert.equal(issuesOf(registry, 'audio.tts', { text: 'x'.repeat(2501) }, { text: { connected: false, count: 0 } }).length, 1);
      assert.equal(requests.length, 2);

      // a workflow saved with another model runs with that model and is booked at its price; a blank model means the default
      requests.length = 0;
      await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hallo Welt') }, { model_id: 'eleven_multilingual_v2' });
      assert.equal(journal.at(-1).model, 'elevenlabs/eleven_multilingual_v2');
      assert.equal(journal.at(-1).cost, 0.0008);
      await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hallo Welt') }, { model_id: '  ' });
      assert.equal(journal.at(-1).model, 'elevenlabs/eleven_v4', 'blank: the default');
      const turbo = await execute(registry, 'audio.tts', makeCtx(sessionId), { text: text('Hallo Welt') }, { model_id: 'eleven_v4_turbo' });
      assert.deepEqual(requests.map((request) => request.modelId), ['eleven_multilingual_v2', 'eleven_v4', 'eleven_v4_turbo']);
      assert.equal(journal.at(-1).model, 'elevenlabs/eleven_v4_turbo');
      assert.equal(journal.at(-1).cost, 0.0004, 'a Turbo model is booked at half');
      assert.deepEqual(turbo.cost, { usd: 0.0004 });

      const tts = oneOf(registry, 'audio.tts');
      assert.equal(tts.paid, true);
      assert.equal(tts.cost.unit, 'usd');
      assert.equal(tts.cost.history, false, 'no guess from an earlier result');
      const estimate = (params, connected = []) => tts.cost.estimate(registry.normalizeParams(tts, params), { connected: new Set(connected) });
      assert.equal(estimate({ text: 'x'.repeat(1000) }), 0.08);
      // the price follows the model: Turbo and Flash count half (price page of ElevenLabs, see tools.js), an unknown model the full price
      assert.equal(estimate({ text: 'x'.repeat(1000), model_id: 'eleven_v4' }), 0.08);
      assert.equal(estimate({ text: 'x'.repeat(1000), model_id: 'eleven_multilingual_v2' }), 0.08, 'an older workflow keeps its price');
      for (const half of ['eleven_v4_turbo', 'eleven_v3_conversational', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2']) {
        assert.equal(estimate({ text: 'x'.repeat(1000), model_id: half }), 0.04, half);
      }
      assert.equal(estimate({ text: 'x'.repeat(1000), model_id: 'some_future_model' }), 0.08, 'an unknown model: the full price, never less');
      assert.equal(estimate({ text: 'x'.repeat(1000), model_id: '  ' }), 0.08, 'a blank model is the default');
      assert.equal(tools.speechEstimateUsd('x'.repeat(1000)), 0.08);
      assert.equal(tools.speechEstimateUsd('x'.repeat(1000), 'eleven_flash_v2_5'), 0.04);
      // the budget of a participant reserves the price of the model that is asked for
      assert.equal(tools.toolEstimateUsd('generate_speech', { text: 'x'.repeat(1000) }), 0.08);
      assert.equal(tools.toolEstimateUsd('generate_speech', { text: 'x'.repeat(1000), model_id: 'eleven_v4_turbo' }), 0.04);
      withEnv('ELEVENLABS_USD_PER_1K_CHARS', '0.5');
      assert.equal(estimate({ text: 'x'.repeat(1000) }), 0.5);
      assert.equal(estimate({ text: 'x'.repeat(1000), model_id: 'eleven_flash_v2_5' }), 0.25, 'the setting is the price of a full-price model, Flash counts half of it');
      assert.equal(estimate({ text: 'x'.repeat(5000) }), 1.25, 'capped at 2500 characters, as the tool is');
      assert.equal(estimate({ text: 'x'.repeat(1000) }, ['text']), null, 'a text through a connection: unknown, not 0');
      assert.equal(estimate({ text: '' }), null);
      assert.equal(registry.publicDescriptor(tts).provider, 'elevenlabs');
      assert.equal(registry.publicDescriptor(tts).paid, true);

      // the model is a choice from the list of the speech models, Eleven v4 for a new node. The server never checks the value against
      // the list, so a workflow saved with another model (an old id included) stays valid.
      const modelParam = registry.publicDescriptor(tts).params.find((param) => param.id === 'model_id');
      assert.deepEqual(
        { kind: modelParam.kind, optionsSource: modelParam.optionsSource, default: modelParam.default, noDefaultEntry: modelParam.noDefaultEntry },
        { kind: 'select', optionsSource: 'elevenlabs-tts-models', default: 'eleven_v4', noDefaultEntry: true }
      );
      assert.equal(tools.DEFAULT_ELEVENLABS_MODEL_ID, 'eleven_v4');
      assert.equal(registry.normalizeParams(tts, {}).model_id, 'eleven_v4', 'a new node');
      assert.equal(registry.normalizeParams(tts, { model_id: 'eleven_multilingual_v2' }).model_id, 'eleven_multilingual_v2', 'a saved model is kept');
      for (const saved of ['eleven_multilingual_v2', 'eleven_monolingual_v1', 'some_future_model']) {
        assert.deepEqual(registry.checkParams(tts, registry.normalizeParams(tts, { model_id: saved })), [], `${saved} stays valid`);
      }
      // the Director's tool says the same default
      const speechTool = tools.toolDefinitions().find((tool) => tool.function.name === 'generate_speech');
      assert.equal(speechTool.function.parameters.properties.model_id.default, 'eleven_v4');
      assert.match(speechTool.function.parameters.properties.model_id.description, /Defaults to eleven_v4/);
    }

    /* ----- audio.music and audio.music_plan ----- */
    {
      resetMocks();
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', undefined);
      patch(elevenlabs, 'hasKey', () => true);
      const composed = [];
      patch(elevenlabs, 'composeMusic', async (request) => {
        composed.push(request);
        return Buffer.from('fake-mp3');
      });
      const planned = [];
      let planAnswer;
      patch(elevenlabs, 'planMusic', async (request) => {
        planned.push(request);
        return planAnswer;
      });
      const music = oneOf(registry, 'audio.music');
      const planNode = oneOf(registry, 'audio.music_plan');
      const musicPlan = require('../public/nodes/music-plan');

      // definitions: ports, params, cost, availability for everybody with a key
      assert.deepEqual([music.inputs.map((p) => `${p.id}:${p.type}${p.required ? '!' : ''}`), music.outputs.map((p) => `${p.id}:${p.type}`)], [['prompt:text', 'plan:text', 'match:video'], ['audio:audio']]);
      assert.deepEqual([planNode.inputs.map((p) => `${p.id}:${p.type}${p.required ? '!' : ''}`), planNode.outputs.map((p) => `${p.id}:${p.type}`)], [['prompt:text!'], ['plan:text']]);
      assert.equal(music.paid, true);
      assert.deepEqual([music.cost.unit, music.cost.history], ['usd', false]);
      assert.equal(planNode.paid, false);
      assert.equal(planNode.cost.unit, 'free', 'ElevenLabs is called, free of credits: not local');
      assert.equal(registry.publicDescriptor(planNode).cost.unit, 'free');
      assert.equal(registry.publicDescriptor(planNode).provider, 'elevenlabs');
      assert.equal(require('../lib/nodes/registry').isRestricted(registry.publicDescriptor(music)), false, 'music is for participants and guests, too');
      const defaults = registry.normalizeParams(music, {});
      assert.deepEqual([defaults.length, defaults.instrumental, defaults.model], [30, false, 'music_v2_5']);
      assert.deepEqual(registry.normalizeParams(music, { length: 2 }).length, 3, 'clamped to 3 s');
      assert.deepEqual(registry.normalizeParams(music, { length: 9999 }).length, 600, 'clamped to 600 s');
      assert.deepEqual(music.params.find((p) => p.id === 'model').options, ['music_v2_5', 'music_v2', 'music_v1']);
      assert.equal(registry.normalizeParams(planNode, {}).length, 60);
      patch(elevenlabs, 'hasKey', () => false);
      assert.match(registry.availability(music), /ELEVENLABS/);
      assert.match(registry.availability(planNode), /ELEVENLABS/);
      patch(elevenlabs, 'hasKey', () => true);
      assert.equal(registry.availability(music), true);

      // description mode: the length of the field, instrumental, the model; booked as music for everybody
      const journalBefore = journal.length;
      const described = await execute(registry, 'audio.music', makeCtx(sessionId), { prompt: text('calm piano') }, { length: 45, instrumental: true });
      assert.deepEqual(composed[0], { prompt: 'calm piano', lengthMs: 45000, instrumental: true, modelId: 'music_v2_5' });
      assert.equal(described.variants[0].audio.type, 'audio');
      assert.match(described.variants[0].audio.file, /\.mp3$/);
      assert.deepEqual(described.cost, { usd: 0.15 }, '45 s at 0.20 USD per minute');
      const row = journal.at(-1);
      assert.equal(journal.length, journalBefore + 1);
      assert.deepEqual([row.type, row.model, row.cost, row.billing, row.user], ['music', 'elevenlabs/music_v2_5', 0.15, 'Schaetzung (Dauer)', 'tester']);
      assert.equal(row.assetId, described.variants[0].audio.assetId);
      const ledgerEntry = (await store.readLedger(sessionId)).find((entry) => entry.id === described.variants[0].audio.assetId);
      assert.deepEqual([ledgerEntry.kind, ledgerEntry.model, ledgerEntry.cost, ledgerEntry.costEstimated], ['audio', 'elevenlabs/music_v2_5', 0.15, true]);
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', '0.6');
      assert.deepEqual((await execute(registry, 'audio.music', makeCtx(sessionId), { prompt: text('x') }, { length: 30, model: 'music_v1' })).cost, { usd: 0.3 });
      assert.equal(composed[1].modelId, 'music_v1');
      assert.equal(composed[1].instrumental, false);
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', undefined);

      // plan mode: the plan text becomes the composition plan of the model, the length comes from the sections
      const planText = '+ indie pop, warm female vocals\n- autotune\n\n[Verse 1 | 20 s]\n+ soft guitar\nFirst line\nSecond line\n\n[Chorus | 0:15]\nLa la la';
      const planned1 = await execute(registry, 'audio.music', makeCtx(sessionId), { plan: text(planText), prompt: text('ignored') }, { length: 999, instrumental: true });
      assert.deepEqual(Object.keys(composed[2]).sort(), ['compositionPlan', 'modelId'], 'no prompt, length or instrumental next to a plan');
      assert.deepEqual(composed[2].compositionPlan, {
        chunks: [
          { text: '[Verse 1]\nFirst line\nSecond line', duration_ms: 20000, positive_styles: ['indie pop', 'warm female vocals', 'soft guitar'], negative_styles: ['autotune'] },
          { text: '[Chorus]\nLa la la', duration_ms: 15000, positive_styles: [], negative_styles: [] }
        ]
      });
      assert.deepEqual(planned1.cost, { usd: 0.116667 }, '35 s from the sections');
      await execute(registry, 'audio.music', makeCtx(sessionId), { plan: text(planText) }, { model: 'music_v1' });
      assert.deepEqual(composed[3].compositionPlan.positive_global_styles, ['indie pop', 'warm female vocals']);
      assert.equal(composed[3].compositionPlan.sections[0].section_name, 'Verse 1');
      assert.equal(composed[3].modelId, 'music_v1');
      // a bad plan at run time stops before ElevenLabs is called, with the code, the line and the values for the text
      const calls = composed.length;
      const badRun = await execute(registry, 'audio.music', makeCtx(sessionId), { plan: text('[Intro | 2 s]\nla') }).catch((error) => error);
      assert.equal(badRun.code, 'MUSIC_PLAN_DURATION_RANGE');
      assert.equal(badRun.data.line, 1);
      assert.match(badRun.message, /^Line 1:/);
      assert.equal(composed.length, calls);
      await assert.rejects(execute(registry, 'audio.music', makeCtx(sessionId), {}), (error) => error.code === 'MUSIC_SOURCE_MISSING');

      // length like the video: rounded up, between 3 and 600 s
      const ctxMatch = makeCtx(sessionId);
      let duration = 12.2;
      patch(ffmpeg, 'binaries', () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', available: true }));
      patch(ffmpeg, 'probeVideo', async () => ({ duration, video: { width: 1280, height: 720 } }));
      const matched = await execute(registry, 'audio.music', ctxMatch, { prompt: text('upbeat'), match: video1 }, { length: 99 });
      assert.equal(composed.at(-1).lengthMs, 13000);
      assert.deepEqual(matched.cost, { usd: 0.043333 });
      assert.ok(ctxMatch.logs.some((line) => /13 s/.test(line)));
      duration = 1.5;
      await execute(registry, 'audio.music', makeCtx(sessionId), { prompt: text('upbeat'), match: video1 });
      assert.equal(composed.at(-1).lengthMs, 3000, 'at least 3 s');
      duration = 700;
      await execute(registry, 'audio.music', makeCtx(sessionId), { prompt: text('upbeat'), match: video1 });
      assert.equal(composed.at(-1).lengthMs, 600000, 'at most 600 s');
      duration = 0;
      await assert.rejects(execute(registry, 'audio.music', makeCtx(sessionId), { prompt: text('upbeat'), match: video1 }), /length of the video/);
      // a plan wins over the video
      const calls2 = composed.length;
      await execute(registry, 'audio.music', makeCtx(sessionId), { plan: text(planText), match: video1 });
      assert.equal(composed.length, calls2 + 1);
      assert.ok(composed.at(-1).compositionPlan, 'the plan, not the video');

      // validation: something to make music from, a plan in the field is checked with its line, a plan wins (warning)
      const ports = (connected = []) => Object.fromEntries(['prompt', 'plan', 'match'].map((id) => [id, { connected: connected.includes(id), count: connected.includes(id) ? 1 : 0 }]));
      const issues = (params, connected) => issuesOf(registry, 'audio.music', params, ports(connected));
      assert.deepEqual(issues({}, []).map((i) => i.code), ['MUSIC_SOURCE_MISSING']);
      assert.deepEqual(issues({ prompt: 'x' }, []), []);
      assert.deepEqual(issues({}, ['prompt']), []);
      assert.deepEqual(issues({}, ['plan']), []);
      assert.deepEqual(issues({ plan: planText }, []), []);
      const lineIssue = issues({ plan: '[Verse | 20 s]\nok\n[Chorus | 400 s]' }, [])[0];
      assert.deepEqual([lineIssue.code, lineIssue.level], ['MUSIC_PLAN_DURATION_RANGE', 'error']);
      assert.match(lineIssue.message, /Line 3/);
      assert.equal(issues({ plan: 'First\n[Verse | 20 s]' }, [])[0].code, 'MUSIC_PLAN_TEXT_OUTSIDE');
      const warned = issues({ prompt: 'x', instrumental: true }, ['plan']);
      assert.deepEqual(warned.map((i) => [i.code, i.level]), [['MUSIC_PLAN_WINS', 'warning']]);
      assert.deepEqual(issues({ prompt: 'x' }, ['match']), [], 'a video without a plan is fine');
      assert.deepEqual(issues({ prompt: 'x' }, ['plan', 'match']).map((i) => i.code), ['MUSIC_PLAN_WINS']);
      // a description next to a plan is ignored, and the node says so (field or connection, plan in the field or connected)
      const bothInFields = issues({ prompt: 'calm lofi', plan: planText }, []);
      assert.deepEqual(bothInFields.map((i) => [i.code, i.level]), [['MUSIC_PLAN_WINS', 'warning']]);
      assert.match(bothInFields[0].message, /description/);
      assert.deepEqual(issues({ plan: planText }, []), [], 'a plan alone: no warning');
      assert.deepEqual(issues({ prompt: 'calm lofi' }, ['plan']).map((i) => i.code), ['MUSIC_PLAN_WINS']);
      assert.deepEqual(issues({}, ['prompt', 'plan']).map((i) => i.code), ['MUSIC_PLAN_WINS'], 'a connected description, too');
      // the limits of the chunk models are checked in the node, with the line number
      const thirty = `[Verse | 20 s]\n${Array(30).fill('la').join('\n')}`;
      const chunkIssue = issues({ plan: thirty, model: 'music_v2_5' }, [])[0];
      assert.deepEqual([chunkIssue.code, chunkIssue.level], ['MUSIC_PLAN_LINES_MAX_CHUNK', 'error']);
      assert.match(chunkIssue.message, /Line 1/);
      assert.deepEqual(issues({ plan: thirty, model: 'music_v1' }, []), [], 'music_v1: 30 song lines are fine');
      assert.equal(issues({ plan: '[| 10 s]\n\\[Intro]\nla', model: 'music_v2' }, [])[0].code, 'MUSIC_PLAN_NAME_NEEDED');

      // estimates: from the length, from a plan in the field; unknown (never 0) when the length arrives through a connection
      const estimate = (params, connected = []) => music.cost.estimate(registry.normalizeParams(music, params), { connected: new Set(connected) });
      assert.equal(estimate({ prompt: 'x' }), 0.1, '30 s');
      assert.equal(estimate({ length: 600 }), 2);
      assert.equal(estimate({ length: 90 }), 0.3);
      assert.equal(estimate({ plan: planText, length: 600 }), 0.116667, 'the plan in the field decides');
      assert.equal(estimate({ plan: '[Verse | 2 s]' }), null, 'a plan that is not valid has no price');
      assert.equal(estimate({ length: 90 }, ['match']), null);
      assert.equal(estimate({ length: 90 }, ['plan']), null);
      assert.equal(estimate({ plan: planText }, ['plan']), null);
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', '0.15');
      assert.equal(estimate({ length: 60 }), 0.15);
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', 'abc');
      assert.equal(estimate({ length: 60 }), 0.2, 'a bad value falls back to the default');
      withEnv('ELEVENLABS_MUSIC_USD_PER_MIN', undefined);

      // the song plan: a v2.5 answer (chunks) and a v1 answer (sections) both become the readable text; nothing is booked
      planAnswer = {
        chunks: [
          { text: '[Verse 1]\nWe ride the morning train', duration_ms: 20000, positive_styles: ['indie pop', 'warm vocals'], negative_styles: ['autotune'] },
          { text: '[Chorus]\nTo the sea, to the sea\n{guitar solo}', duration_ms: 25000, positive_styles: ['uplifting'] }
        ]
      };
      const journalCount = journal.length;
      const song = await execute(registry, 'audio.music_plan', makeCtx(sessionId), { prompt: text('summer song about a train to the sea') }, { length: 45 });
      assert.deepEqual(planned[0], { prompt: 'summer song about a train to the sea', lengthMs: 45000, modelId: 'music_v2_5' });
      assert.equal(song.variants[0].plan.type, 'text');
      assert.equal(song.variants[0].plan.value, '[Verse 1 | 20 s]\n+ indie pop, warm vocals\n- autotune\nWe ride the morning train\n\n[Chorus | 25 s]\n+ uplifting\nTo the sea, to the sea\n{guitar solo}');
      assert.equal(song.cost, undefined, 'free of credits');
      assert.equal(journal.length, journalCount, 'nothing is booked for a plan');
      // the text goes straight into the music node and gives the same plan back
      assert.equal(musicPlan.stringify(musicPlan.parse(song.variants[0].plan.value).plan), song.variants[0].plan.value);
      planAnswer = {
        positive_global_styles: ['rock', 'energetic'],
        negative_global_styles: [],
        sections: [{ section_name: 'Intro', positive_local_styles: [], negative_local_styles: ['vocals'], duration_ms: 8000, lines: [] }]
      };
      const v1 = await execute(registry, 'audio.music_plan', makeCtx(sessionId), { prompt: text('rock') }, { model: 'music_v1' });
      assert.equal(v1.variants[0].plan.value, '+ rock, energetic\n\n[Intro | 8 s]\n- vocals');
      assert.equal(planned.at(-1).modelId, 'music_v1');
      planAnswer = { nothing: true };
      await assert.rejects(execute(registry, 'audio.music_plan', makeCtx(sessionId), { prompt: text('x') }), (error) => error.code === 'MUSIC_PLAN_SHAPE');

      // the tools are for the node view only
      const names = tools.toolDefinitions().map((definition) => definition.function.name);
      assert.ok(!names.includes('generate_music') && !names.includes('plan_music'));
      const composedBefore = composed.length;
      for (const name of ['generate_music', 'plan_music']) {
        await assert.rejects(tools.executeTool({ sessionId, config: {}, user: 'tester', emit() {} }, name, { prompt: 'x', length_seconds: 30 }), /nur in der Node-Ansicht/);
      }
      assert.equal(composed.length, composedBefore, 'the rejected calls reached ElevenLabs never');
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
      } finally {
        stop();
      }
    }

    /* ----- Higgsfield dubbing, voice change and motion transfer (experimental): arguments and param validation ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      const calls = [];
      const mediaIds = [];
      const jobIds = [];
      let imported = [];
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (name === 'media_import_url') {
          mediaIds.push(`cccccccc-cccc-4ccc-8ccc-${String(mediaIds.length + 1).padStart(12, '0')}`);
          imported.push(mediaIds.at(-1));
          return `Imported media ${mediaIds.at(-1)}`;
        }
        jobIds.push(nextJobId());
        // the answer names the imported sources as well: the job id must not be mistaken for one of them
        const reply = `Submitted for ${imported.join(' and ')}: ${jobIds.at(-1)} (pending)`;
        imported = [];
        return reply;
      });
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      const editCtx = () => makeCtx(sessionId);
      const runEdit = (args) => tools.executeTool(editCtx().toolCtx, 'higgsfield_edit', { kind: 'video', source_asset_ids: [video1.assetId], ...args });
      const stop = startJobCompleter(sessionId, {});
      try {
        // enums come straight from the tool schemas
        const schemas = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'docs', 'higgsfield-tools.json'), 'utf8'));
        const propertiesOf = (name) => schemas.find((tool) => tool.name === name).inputSchema.properties.params.properties;
        assert.deepEqual(tools.HIGGSFIELD_DUBBING_LANGUAGES, propertiesOf('dubbing').target_language.enum);
        assert.deepEqual(tools.HIGGSFIELD_VOICE_TYPES, propertiesOf('voice_change').voice_type.enum);
        assert.deepEqual(tools.HIGGSFIELD_MOTION_RESOLUTIONS, propertiesOf('motion_control').resolution.enum);
        assert.deepEqual(tools.HIGGSFIELD_SCENE_CONTROLS, propertiesOf('motion_control').scene_control.enum);
        assert.equal(propertiesOf('dubbing').target_language.enum.length, 18);

        /* dubbing */
        const dubbed = await execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, {});
        assert.deepEqual(calls.at(-1), { name: 'dubbing', args: { params: { video_id: mediaIds[0], target_language: 'eng' } } }, 'English is the default');
        assert.equal(dubbed.variants[0].video.type, 'video');
        assert.equal(dubbed.cost, undefined, 'the credits are unknown');
        const record = (await store.readSession(sessionId)).jobs.find((job) => job.jobId === jobIds[0]);
        assert.deepEqual([record.mode, record.model, record.kind, record.provider], ['higgsfield_edit', 'dubbing', 'video', 'higgsfield']);
        await execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, { target_language: 'deu' });
        assert.equal(calls.at(-1).args.params.target_language, 'deu');

        // bad params fail before anything is imported (nothing to pay, nothing to clean up)
        const before = calls.length;
        await assert.rejects(runEdit({ tool: 'dubbing', params: { target_language: 'xx' } }), /target_language "xx" ist ungueltig/);
        await assert.rejects(runEdit({ tool: 'dubbing', params: {} }), /target_language fehlt/);
        await assert.rejects(runEdit({ tool: 'dubbing' }), /target_language fehlt/);
        assert.equal(calls.length, before, 'no import for invalid params');
        // unknown keys are dropped (the schema has additionalProperties: false)
        await runEdit({ tool: 'dubbing', params: { target_language: 'jpn', video_id: 'evil', prompt: 'x', count: 3 } });
        assert.deepEqual(calls.at(-1).args, { params: { video_id: mediaIds.at(-1), target_language: 'jpn' } });
        await assert.rejects(runEdit({ tool: 'dubbing', params: { target_language: 'deu' }, source_asset_ids: [image1.assetId] }), /keine gueltige Video-Quelle/);
        await assert.rejects(runEdit({ tool: 'dubbing', params: { target_language: 'deu' }, source_asset_ids: [] }), /genau eine Asset-ID/);

        /* voice change */
        await execute(registry, 'hf.voice_change', editCtx(), { video: video1 }, { voice: 'element:el-42' });
        assert.deepEqual(calls.at(-1), { name: 'voice_change', args: { params: { video_id: mediaIds.at(-1), voice_id: 'el-42', voice_type: 'element' } } });
        await execute(registry, 'hf.voice_change', editCtx(), { video: video1 }, { voice: 'preset:from-list', voice_custom: ' typed-id ' });
        assert.deepEqual(calls.at(-1).args.params, { video_id: mediaIds.at(-1), voice_id: 'typed-id', voice_type: 'preset' }, 'a typed voice id wins and a bare id is a preset');
        await execute(registry, 'hf.voice_change', editCtx(), { video: video1 }, { voice: 'preset:a', voice_custom: 'element:mine' });
        assert.deepEqual([calls.at(-1).args.params.voice_id, calls.at(-1).args.params.voice_type], ['mine', 'element']);
        assert.equal(issuesOf(registry, 'hf.voice_change', {}).length, 1, 'no voice is reported before the run');
        assert.match(issuesOf(registry, 'hf.voice_change', {})[0].message, /select a voice or enter a voice ID/);
        assert.equal(issuesOf(registry, 'hf.voice_change', { voice_custom: 'x' }).length, 0);
        assert.equal(issuesOf(registry, 'hf.voice_change', { voice: 'preset:a' }).length, 0);
        const beforeVoice = calls.length;
        await assert.rejects(execute(registry, 'hf.voice_change', editCtx(), { video: video1 }, {}), /select a voice or enter a voice ID/);
        await assert.rejects(runEdit({ tool: 'voice_change', params: { voice_id: '  ' } }), /voice_id fehlt/);
        await assert.rejects(runEdit({ tool: 'voice_change', params: {} }), /voice_id fehlt/);
        await assert.rejects(runEdit({ tool: 'voice_change', params: { voice_id: 'v', voice_type: 'cloned' } }), /voice_type "cloned" ist ungueltig/);
        assert.equal(calls.length, beforeVoice, 'no import for invalid voices');
        await runEdit({ tool: 'voice_change', params: { voice_id: 'plain', extra: true } });
        assert.deepEqual(calls.at(-1).args.params, { video_id: mediaIds.at(-1), voice_id: 'plain', voice_type: 'preset' }, 'preset is the default type, unknown keys are dropped');
        assert.deepEqual(generate.parseVoiceParam('', ''), null);
        assert.deepEqual(generate.parseVoiceParam('element:', ''), null);
        assert.deepEqual(generate.parseVoiceParam('ELEMENT:abc:def', ''), { voiceType: 'element', voiceId: 'abc:def' });

        /* motion transfer: image + motion video, both imported (image first) */
        const published = [];
        patch(publicrefs, 'publishAsset', async (session, assetId) => {
          published.push(assetId);
          return { url: `https://example.test/refs/${assetId}`, file: `${assetId}.bin` };
        });
        const moved = await execute(registry, 'hf.motion_control', editCtx(), { image: image1, motion: video1 }, {});
        assert.deepEqual(published, [image1.assetId, video1.assetId], 'the character image is imported before the motion video');
        assert.deepEqual(calls.at(-1), {
          name: 'motion_control',
          args: { params: { image_id: mediaIds.at(-2), motion_video_id: mediaIds.at(-1), resolution: '720p', scene_control: 'image' } }
        });
        assert.equal(moved.variants[0].video.type, 'video');
        await execute(registry, 'hf.motion_control', editCtx(), { image: image1, motion: video1 }, { resolution: '1080p', scene_control: 'video' });
        assert.deepEqual([calls.at(-1).args.params.resolution, calls.at(-1).args.params.scene_control], ['1080p', 'video']);
        const beforeMotion = calls.length;
        const motionArgs = (args) => runEdit({ tool: 'motion_control', kind: 'video', source_asset_ids: [image1.assetId, video1.assetId], ...args });
        await assert.rejects(motionArgs({ source_asset_ids: [image1.assetId] }), /genau 2 Asset-IDs enthalten \(Bild, Video\)/);
        await assert.rejects(motionArgs({ source_asset_ids: [video1.assetId, image1.assetId] }), /keine gueltige Bild-Quelle/, 'a video cannot be the character');
        await assert.rejects(motionArgs({ source_asset_ids: [image1.assetId, image2.assetId] }), /keine gueltige Video-Quelle/, 'an image cannot be the motion');
        await assert.rejects(motionArgs({ params: { resolution: '4k' } }), /resolution "4k" ist ungueltig/);
        await assert.rejects(motionArgs({ params: { scene_control: 'both' } }), /scene_control "both" ist ungueltig/);
        assert.equal(calls.length, beforeMotion, 'nothing is imported for invalid motion control calls');
        await motionArgs({ params: { unknown: 1 } });
        assert.deepEqual(Object.keys(calls.at(-1).args.params).sort(), ['image_id', 'motion_video_id', 'resolution', 'scene_control']);

        // the Director can never reach the new tools' entry point
        const directorCtx = { ...editCtx().toolCtx, nodeView: undefined };
        const beforeDirector = calls.length;
        await assert.rejects(tools.executeTool(directorCtx, 'higgsfield_edit', { tool: 'dubbing', kind: 'video', source_asset_ids: [video1.assetId], params: { target_language: 'deu' } }), /nur in der Node-Ansicht/);
        assert.equal(calls.length, beforeDirector);
      } finally {
        stop();
      }
    }

    /* ----- media_upload path without PUBLIC_BASE_URL: parsing, PUT, confirm, error paths, no signed URL in messages ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      patch(publicrefs, 'publishAsset', async () => {
        throw new Error('the URL import must not be used without PUBLIC_BASE_URL');
      });
      const logged = [];
      for (const level of ['log', 'info', 'warn', 'error']) patch(console, level, (...args) => logged.push(args.join(' ')));
      const calls = [];
      const events = [];
      const puts = [];
      const media = [];
      const jobIds = [];
      let imported = [];
      const SECRET = 'X-Amz-Signature=SECRETSIGNATURE';
      const uploadUrlFor = (n) => `https://upload.example.test/bucket/${n}?${SECRET}&X-Amz-Expires=900`;
      const uploadRecord = (args, n, extra = {}) => ({
        upload_url: uploadUrlFor(n),
        media_id: media[n - 1],
        url: `https://cdn.example.test/${n}`,
        expires_in_seconds: 900,
        method: 'PUT',
        content_type: args.content_type,
        instructions: 'Run the curl command, then call media_confirm.',
        ...extra
      });
      let uploadReply = (args, n) => JSON.stringify({ uploads: [uploadRecord(args, n)] });
      let confirmReply = (args) => JSON.stringify({ results: [{ media_id: args.media_id, status: 'confirmed', type: args.type }] });
      let putResponse = () => new Response('', { status: 200 });
      let uploads = 0;
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        events.push(name);
        if (name === 'media_upload') {
          uploads += 1;
          media.push(`dddddddd-dddd-4ddd-8ddd-${String(uploads).padStart(12, '0')}`);
          imported.push(media.at(-1));
          return uploadReply(args, uploads);
        }
        if (name === 'media_confirm') return confirmReply(args);
        if (name === 'media_import_url') assert.fail('media_import_url must not be used without PUBLIC_BASE_URL');
        if (name === 'models_explore') return modelJson({ id: args.model_id });
        jobIds.push(nextJobId());
        const reply = `Submitted for ${imported.join(' and ')}: ${jobIds.at(-1)} (pending)`;
        imported = [];
        return reply;
      });
      patch(global, 'fetch', async (url, options) => {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        events.push('put');
        puts.push({ url, method: options.method, headers: options.headers, duplex: options.duplex, body: Buffer.concat(chunks) });
        return putResponse(url, options);
      });
      catalogLib.clearCache();
      const editCtx = () => makeCtx(sessionId);
      const submits = (tool) => calls.filter((call) => call.name === tool).length;
      const stop = startJobCompleter(sessionId, {});
      try {
        // video source: media_upload -> PUT (Content-Type, Content-Length, streamed bytes) -> media_confirm -> edit tool
        const dubbed = await execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, { target_language: 'ita' });
        assert.deepEqual(events.slice(0, 4), ['media_upload', 'put', 'media_confirm', 'dubbing']);
        assert.deepEqual(calls[0], { name: 'media_upload', args: { filename: `${video1.assetId}.mp4`, content_type: 'video/mp4' } });
        assert.equal(puts.length, 1);
        assert.equal(puts[0].url, uploadUrlFor(1));
        assert.equal(puts[0].method, 'PUT');
        assert.equal(puts[0].headers['Content-Type'], 'video/mp4');
        assert.equal(puts[0].headers['Content-Length'], String(Buffer.byteLength('fake-mp4')));
        assert.equal(puts[0].duplex, 'half');
        assert.deepEqual(puts[0].body, Buffer.from('fake-mp4'));
        assert.deepEqual(calls[1], { name: 'media_confirm', args: { type: 'video', media_id: media[0] } });
        assert.deepEqual(calls.at(-1), { name: 'dubbing', args: { params: { video_id: media[0], target_language: 'ita' } } });
        assert.equal(dubbed.variants[0].video.type, 'video');

        // image source: the type follows the extension
        await execute(registry, 'hf.outpaint_image', editCtx(), { image: image1 }, { aspect_ratio: '16:9' });
        assert.deepEqual(calls.filter((call) => call.name === 'media_upload').at(-1).args, { filename: `${image1.assetId}.png`, content_type: 'image/png' });
        assert.equal(puts.at(-1).headers['Content-Type'], 'image/png');
        assert.deepEqual(puts.at(-1).body, PNG);
        assert.deepEqual(calls.filter((call) => call.name === 'media_confirm').at(-1).args, { type: 'image', media_id: media.at(-1) });
        assert.deepEqual(calls.at(-1).args.params, { aspect_ratio: '16:9', image_id: media.at(-1) });

        // two sources: uploaded one after the other, image first
        const uploadsBefore = uploads;
        await execute(registry, 'hf.motion_control', editCtx(), { image: image1, motion: video1 }, {});
        assert.deepEqual(calls.filter((call) => call.name === 'media_upload').slice(-2).map((call) => call.args.content_type), ['image/png', 'video/mp4']);
        assert.deepEqual(calls.filter((call) => call.name === 'media_confirm').slice(-2).map((call) => call.args.type), ['image', 'video']);
        assert.equal(uploads, uploadsBefore + 2);
        assert.deepEqual(calls.at(-1).args.params, { image_id: media.at(-2), motion_video_id: media.at(-1), resolution: '720p', scene_control: 'image' });

        // the Content-Type Higgsfield answers with is the one that was signed: it is sent as is
        uploadReply = (args, n) => JSON.stringify({ uploads: [uploadRecord(args, n, { content_type: 'application/octet-stream' })] });
        await execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, {});
        assert.equal(puts.at(-1).headers['Content-Type'], 'application/octet-stream');

        // other answer formats (the real one is not verified): JSON in prose, plain text, curl text, camelCase
        const bodies = [];
        const variants = [
          (args, n) => `Upload prepared:\n${JSON.stringify(uploadRecord(args, n))}\nRun the PUT, then confirm.`,
          (args, n) => JSON.stringify(uploadRecord(args, n)),
          (args, n) => `upload_url: ${uploadUrlFor(n)}\nmedia_id: ${media[n - 1]}\nexpires_in_seconds: 900`,
          (args, n) => `curl -X PUT -H "Content-Type: ${args.content_type}" --data-binary @clip.mp4 "${uploadUrlFor(n)}"\nThen call media_confirm for ${media[n - 1]}.`,
          (args, n) => JSON.stringify({ data: { uploads: [{ uploadUrl: uploadUrlFor(n), mediaId: media[n - 1] }] } })
        ];
        for (const format of variants) {
          uploadReply = format;
          const putsBefore = puts.length;
          await execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, { target_language: 'fra' });
          assert.equal(puts.length, putsBefore + 1);
          assert.equal(puts.at(-1).url, uploadUrlFor(uploads), 'the signed URL of this answer was used');
          assert.equal(calls.at(-1).args.params.video_id, media.at(-1), 'the media id of this answer was used');
          bodies.push(puts.at(-1).body.toString());
        }
        assert.ok(bodies.every((body) => body === 'fake-mp4'));

        // image references of a Higgsfield generation take the same path
        uploadReply = (args, n) => JSON.stringify({ uploads: [uploadRecord(args, n)] });
        const withRefs = await execute(registry, 'image.higgsfield', editCtx(), { prompt: text('Portrait'), refs: list('image', [image1, image2]) }, { model: 'kling-3' });
        const generation = calls.find((call) => call.name === 'generate_image_batch');
        assert.deepEqual(generation.args.requests[0].params.medias, [{ value: media.at(-2), role: 'start_image' }, { value: media.at(-1), role: 'start_image' }]);
        assert.equal(withRefs.variants[0].image.type, 'image');
        assert.ok(!calls.some((call) => call.name === 'media_import_url'));

        // ----- error paths: nothing is submitted, no signed URL in the message -----
        const failures = [];
        const expectFailure = async (label, run, pattern) => {
          imported = [];
          const submitted = submits('dubbing') + submits('outpaint_image');
          const putCount = puts.length;
          let caught = null;
          try {
            await run();
          } catch (err) {
            caught = err;
          }
          assert.ok(caught, `${label} fails`);
          assert.match(caught.message, pattern, label);
          assert.ok(!caught.message.includes('SECRET'), `${label}: no signature in the message`);
          assert.ok(!/https?:\/\//.test(caught.message), `${label}: no URL in the message`);
          assert.equal(submits('dubbing') + submits('outpaint_image'), submitted, `${label}: no job submitted`);
          failures.push([label, putCount, puts.length]);
        };
        const dub = () => execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, { target_language: 'spa' });

        uploadReply = () => `Upload prepared. Use ${uploadUrlFor(99)} and remember the id.`;
        await expectFailure('answer without a media id', dub, /Antwortformat von media_upload unbekannt/);
        uploadReply = () => 'Sorry, the upload could not be prepared.';
        await expectFailure('answer without any URL', dub, /Antwortformat von media_upload unbekannt/);
        uploadReply = (args, n) => JSON.stringify({ uploads: [uploadRecord(args, n, { upload_url: `http://upload.example.test/insecure?${SECRET}` })] });
        await expectFailure('non-https upload url', dub, /Antwortformat von media_upload unbekannt/);
        uploadReply = (args, n) => JSON.stringify({ uploads: [uploadRecord(args, n)] });
        assert.equal(failures.every(([, before, after]) => before === after), true, 'nothing was uploaded for unusable answers');

        putResponse = () =>
          new Response(`<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match ${SECRET}</Message><StringToSign>https://upload.example.test/x?${SECRET}</StringToSign></Error>`, { status: 403 });
        const confirmsBefore = submits('media_confirm');
        await expectFailure('PUT refused', dub, /HTTP 403, SignatureDoesNotMatch/);
        assert.equal(submits('media_confirm'), confirmsBefore, 'a failed PUT is not confirmed');
        putResponse = () => new Response('Service Unavailable', { status: 503 });
        await expectFailure('PUT unavailable', dub, /HTTP 503\)/);
        putResponse = () => {
          throw new Error(`connect ECONNREFUSED ${uploadUrlFor(1)}`);
        };
        await expectFailure('network error', dub, /Upload zu Higgsfield fehlgeschlagen: connect ECONNREFUSED \[URL\]/);
        putResponse = () => new Response('', { status: 200 });

        confirmReply = () => JSON.stringify({ error: `not found ${uploadUrlFor(1)}` });
        await expectFailure('confirm refused', dub, /nicht bestaetigen: not found \[URL\]/);
        confirmReply = (args) => JSON.stringify({ results: [{ media_id: args.media_id, status: 'failed' }] });
        await expectFailure('confirm failed status', dub, /nicht bestaetigen: Status failed/);
        confirmReply = (args) => JSON.stringify({ results: [{ media_id: args.media_id, status: 'confirmed' }] });

        // unusable files are rejected before media_upload
        const emptyClip = await upload('.mp4', Buffer.alloc(0));
        const uploadsBeforeEmpty = uploads;
        await assert.rejects(execute(registry, 'hf.dubbing', editCtx(), { video: emptyClip }, {}), /leere Datei/);
        const originalStat = fsp.stat;
        patch(fsp, 'stat', async (file, ...rest) =>
          String(file).endsWith(video1.file) ? { isFile: () => true, size: 501 * 1024 * 1024 } : originalStat.call(fsp, file, ...rest)
        );
        await assert.rejects(execute(registry, 'hf.dubbing', editCtx(), { video: video1 }, {}), /groesser als 500 MB/);
        assert.equal(uploads, uploadsBeforeEmpty, 'no upload for empty or oversized files');

        // a refused duration/extra_params sends no reference file to Higgsfield
        {
          const uploadsBeforeRefused = uploads;
          const putsBeforeRefused = puts.length;
          await assert.rejects(
            tools.executeTool(editCtx().toolCtx, 'higgsfield_generate_image', { model: 'kling-3', prompt: 'x', reference_asset_ids: [image1.assetId, image2.assetId], extra_params: [1] }),
            /extra_params muss ein Objekt sein/
          );
          await assert.rejects(
            tools.executeTool(editCtx().toolCtx, 'higgsfield_generate_video', { model: 'kling-3', prompt: 'x', reference_asset_ids: [image1.assetId], duration: 2.5 }),
            /ganze Zahl/
          );
          assert.equal(uploads, uploadsBeforeRefused, 'no media_upload before the parameters are valid');
          assert.equal(puts.length, putsBeforeRefused, 'no PUT before the parameters are valid');
        }

        // the signed URL never reaches a log line
        assert.ok(!logged.some((line) => line.includes('SECRET') || line.includes('upload.example.test')), 'no signed URL in the logs');
      } finally {
        stop();
      }
    }

    /* ----- parseHiggsfieldUpload: tolerant parsing of the (unverified) media_upload answer ----- */
    {
      const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const url = 'https://upload.example.test/put/1?X-Amz-Signature=abc&X-Amz-Expires=900';
      const parse = tools.parseHiggsfieldUpload;
      const expected = { uploadUrl: url, mediaId: id, contentType: '' };
      assert.deepEqual(parse(JSON.stringify({ uploads: [{ upload_url: url, media_id: id }] })), expected);
      assert.deepEqual(parse(JSON.stringify([{ upload_url: url, media_id: id }])), expected);
      assert.deepEqual(parse(JSON.stringify({ upload_url: url, media_id: id, content_type: 'video/mp4' })), { ...expected, contentType: 'video/mp4' });
      assert.deepEqual(parse(JSON.stringify({ result: { uploadUrl: url, mediaId: id } })), expected);
      assert.deepEqual(parse(`Ready.\n${JSON.stringify({ uploads: [{ upload_url: url, media_id: id }] })}\nDone.`), expected);
      assert.deepEqual(parse(`upload_url: ${url}\nmedia_id: ${id}`), expected);
      assert.deepEqual(parse(`"upload_url" = "${url}"\n"media_id" = "${id}"`), expected);
      assert.deepEqual(parse(`curl -X PUT -H 'Content-Type: video/mp4' --data-binary @a.mp4 '${url}'\nmedia: ${id}`), expected, 'curl style, unlabelled uuid');
      assert.throws(() => parse(`Upload to ${url} (media ${id}).`), /Antwortformat/, 'a bare URL in prose is never the upload target');
      assert.throws(() => parse(`Quota erreicht, Request ${id}, siehe https://higgsfield.ai/pricing`), /Antwortformat/, 'a hint link is not an upload target');
      // JSON with the url but without an id falls back to the text
      assert.equal(parse(`${JSON.stringify({ uploads: [{ upload_url: url }] })}\nmedia_id: ${id}`).mediaId, id);
      // a uuid inside the URL is not taken for the media id
      assert.throws(() => parse(`upload_url: https://upload.example.test/${id}.mp4?sig=1`), /media_id/);
      assert.throws(() => parse(`upload_url: http://upload.example.test/x\nmedia_id: ${id}`), /Antwortformat/);
      assert.throws(() => parse(`two urls https://a.example/x and https://b.example/y, media ${id}`), /Antwortformat/, 'ambiguous URLs are not guessed');
      assert.throws(() => parse(''), /Antwortformat/);
      // the error text carries no URL
      try {
        parse(`Use ${url} please`);
        assert.fail('must throw');
      } catch (err) {
        assert.ok(!err.message.includes('Signature') && !err.message.includes('example.test'), err.message);
      }
    }

    /* ----- hf.speech: seed_audio / text2speech_v2 requests, voice rules, reference voices, WAV results ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      const audio2 = await upload('.wav', Buffer.from('fake-wav'));
      const calls = [];
      const speechJobs = [];
      let reuseJob = null;
      let imports = 0;
      const importId = (n) => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`;
      let modelResponse = (args) => (args.model_id === 'text2speech_v2' ? speechV2Json() : seedAudioJson());
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (name === 'models_explore') return modelResponse(args);
        if (name === 'media_import_url') {
          imports += 1;
          return `Imported media ${importId(imports)}`;
        }
        if (name === 'generate_audio_batch') {
          const id = reuseJob || nextJobId();
          speechJobs.push(id);
          return `Submitted 1/1 generations.\n- index 0: ${id} (pending)`;
        }
        throw new Error(`unexpected MCP call ${name}`);
      });
      catalogLib.clearCache();
      const submitted = () => calls.filter((call) => call.name === 'generate_audio_batch');
      const sentParams = () => submitted().at(-1).args.requests[0].params;
      const toolCtx = () => makeCtx(sessionId).toolCtx;
      const speak = (inputs, params, ctx = makeCtx(sessionId)) => execute(registry, 'hf.speech', ctx, inputs, params);
      const sentNothing = () => !calls.some((call) => ['generate_audio_batch', 'media_import_url', 'media_upload'].includes(call.name));
      const reset = () => {
        calls.length = 0;
        imports = 0;
      };

      const stop = startJobCompleter(sessionId, {});
      try {
        // one request: model default, prompt = text, voice pair, no unlimited credits; the result is a WAV asset
        const ctx = makeCtx(sessionId);
        const spoken = await speak({ text: text('Hello world') }, { voice: 'preset:sarah' }, ctx);
        assert.deepEqual(submitted()[0].args, {
          requests: [{ index: 0, params: { model: 'seed_audio', prompt: 'Hello world', use_unlim: false, voice_type: 'preset', voice_id: 'sarah' } }]
        });
        assert.equal(spoken.variants.length, 1);
        assert.equal(spoken.variants[0].audio.type, 'audio');
        assert.match(spoken.variants[0].audio.file, /\.wav$/, 'the reserved result asset is a WAV: seed_audio answers WAV by default');
        assert.deepEqual(spoken.cost, { credits: 4 });
        const ledger = await store.readLedger(sessionId);
        assert.equal(ledger.find((entry) => entry.id === spoken.variants[0].audio.assetId).kind, 'audio');
        const record = (await store.readSession(sessionId)).jobs.find((job) => job.jobId === speechJobs[0]);
        assert.deepEqual([record.provider, record.kind, record.mode, record.model], ['higgsfield', 'audio', 'higgsfield_audio', 'seed_audio']);
        assert.ok(journal.some((entry) => entry.type === 'higgsfield' && entry.model === 'seed_audio' && entry.cost === 0));
        assert.ok(ctx.toolEvents.some((event) => event.type === 'generation_job' && event.kind === 'audio'));

        // a typed voice wins over the list; "element:" selects an own voice
        await speak({ text: text('Hi') }, { voice: 'preset:sarah', voice_custom: 'element:mine' });
        assert.deepEqual([sentParams().voice_type, sentParams().voice_id], ['element', 'mine']);

        // model parameters through extra_params: whitelisted against the model, the voice stays with the voice fields
        const extraCtx = makeCtx(sessionId);
        await speak({ text: text('Hi') }, {
          voice_custom: 'v1',
          extra_params: JSON.stringify({ format: 'mp3', sample_rate: 48000, speech_rate: 20, pitch_rate: 1.5, loudness_rate: 200, voice_id: 'x', bogus: 1, prompt: 'evil', use_unlim: true })
        }, extraCtx);
        assert.deepEqual(sentParams(), {
          model: 'seed_audio', prompt: 'Hi', use_unlim: false, voice_type: 'preset', voice_id: 'v1', format: 'mp3', sample_rate: 48000, speech_rate: 20
        });
        const notes = extraCtx.logs.join('\n');
        assert.match(notes, /extra_params\.voice_id ist fuer die Sprachausgabe reserviert/);
        assert.match(notes, /pitch_rate muss eine ganze Zahl sein/);
        assert.match(notes, /loudness_rate ist groesser als 100/);
        assert.match(notes, /bogus ist fuer seed_audio nicht definiert/);
        assert.match(notes, /prompt ist reserviert/);
        assert.match(notes, /use_unlim ist reserviert/);

        // only formats the app can play: wav (default) and mp3; pcm and ogg_opus are refused before anything is called
        for (const format of ['pcm', 'ogg_opus', 'flac', 'WAV']) {
          reset();
          await assert.rejects(
            speak({ text: text('x') }, { voice_custom: 'v', extra_params: JSON.stringify({ format }) }),
            /wird von der App nicht unterstuetzt \(erlaubt: wav, mp3;/
          );
          assert.ok(sentNothing(), `format ${format}: nothing is imported or submitted`);
        }
        reset();
        await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', extra_params: { format: 'pcm' } }), /Audioformat "pcm"/);
        assert.equal(calls.length, 0, 'the tool refuses without even reading the model');
        assert.match(issuesOf(registry, 'hf.speech', { voice_custom: 'v', extra_params: '{"format":"ogg_opus"}' })[0].message, /only wav or mp3/);
        for (const format of ['wav', 'mp3']) assert.equal(issuesOf(registry, 'hf.speech', { voice_custom: 'v', extra_params: JSON.stringify({ format }) }).length, 0);

        // reference voices: the role comes from the roles of the model (its one slot is typed "image"); 0..2 in total
        withEnv('PUBLIC_BASE_URL', 'https://example.test');
        reset();
        await speak({ text: text('Clone me'), reference_audio: audio1 }, {});
        assert.deepEqual(sentParams(), { model: 'seed_audio', prompt: 'Clone me', use_unlim: false, medias: [{ value: importId(1), role: 'audio_references' }] });
        assert.ok(calls.findIndex((call) => call.name === 'media_import_url') < calls.findIndex((call) => call.name === 'generate_audio_batch'));
        reset();
        await speak({ text: text('Both'), reference_audio: list('audio', [audio1, audio2]) }, { voice: 'preset:sarah' });
        assert.deepEqual(sentParams().medias, [{ value: importId(1), role: 'audio_references' }, { value: importId(2), role: 'audio_references' }], 'a voice plus two references');
        assert.equal(sentParams().voice_id, 'sarah');
        reset();
        await assert.rejects(speak({ text: text('x'), reference_audio: list('audio', [audio1, audio2, audio1]) }, { voice_custom: 'v' }), /reference_audio: at most 2 are allowed \(got 3\)/);
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', reference_audio_asset_ids: [audio1.assetId, audio2.assetId, audio1.assetId] }),
          /hoechstens 2 Referenz-Audiodateien \(3 angegeben\)/
        );
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', reference_audio_asset_ids: [image1.assetId] }),
          /keine gueltige Audio-Referenz/
        );
        assert.ok(sentNothing());
        assert.equal(issuesOf(registry, 'hf.speech', { voice_custom: 'v' }, { reference_audio: { connected: true, count: 3 } }).length, 1);

        // a readable model without an audio role, or with a smaller limit, fails before anything is imported or submitted
        modelResponse = (args) => modelJson({ id: args.model_id, output_type: 'audio' });
        catalogLib.clearCache();
        reset();
        await assert.rejects(speak({ text: text('x'), reference_audio: audio1 }, { voice_custom: 'v' }), /Model seed_audio declares no audio input/);
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', reference_audio_asset_ids: [audio1.assetId] }),
          /deklariert keine Audio-Referenz/
        );
        assert.ok(sentNothing());
        modelResponse = (args) => modelJson({ id: args.model_id, medias: [{ name: 'voice', type: 'image', max: 1, roles: ['audio_references'] }] });
        catalogLib.clearCache();
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', reference_audio_asset_ids: [audio1.assetId, audio2.assetId] }),
          /akzeptiert hoechstens 1 Audio-Referenzen/
        );
        assert.ok(sentNothing());

        // a model that cannot be read at all gets the documented role; extra_params still need a verifiable model
        for (const unreadable of [() => { throw new Error('models_explore down'); }, () => 'Model not found', () => '{"error":"nope"}']) {
          modelResponse = unreadable;
          catalogLib.clearCache();
          reset();
          await speak({ text: text('x'), reference_audio: audio1 }, { voice_custom: 'v' });
          assert.deepEqual(sentParams().medias, [{ value: importId(1), role: 'audio_references' }]);
        }
        reset();
        await assert.rejects(speak({ text: text('x') }, { voice_custom: 'v', extra_params: '{"speech_rate":5}' }), /konnte nicht geprueft werden/);
        assert.ok(sentNothing());
        modelResponse = (args) => (args.model_id === 'text2speech_v2' ? speechV2Json() : seedAudioJson());
        catalogLib.clearCache();

        // text2speech_v2: needs a variant and a voice, takes no reference audio
        reset();
        await speak({ text: text('Grüezi') }, { model: 'text2speech_v2', voice_custom: 'v2-voice', extra_params: JSON.stringify({ variant: 'minimax', speed: 1.25 }) });
        assert.deepEqual(sentParams(), {
          model: 'text2speech_v2', prompt: 'Grüezi', use_unlim: false, voice_type: 'preset', voice_id: 'v2-voice', variant: 'minimax', speed: 1.25
        });
        reset();
        await assert.rejects(speak({ text: text('x') }, { model: 'text2speech_v2', voice_custom: 'v' }), /variant fehlt oder ist ungueltig/);
        await assert.rejects(speak({ text: text('x') }, { model: 'text2speech_v2', voice_custom: 'v', extra_params: '{"variant":"siri"}' }), /variant fehlt oder ist ungueltig \(text2speech_v2 braucht eine dieser Varianten: elevenlabs, minimax, seed_speech, vibe_voice, cozy_voice\)/);
        await assert.rejects(speak({ text: text('x') }, { model: 'text2speech_v2', extra_params: '{"variant":"minimax"}' }), /select a voice or enter a voice ID/);
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { model: 'text2speech_v2', prompt: 'x', extra_params: { variant: 'minimax' } }),
          /voice_id fehlt \(text2speech_v2 braucht eine Stimme\)/
        );
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { model: 'text2speech_v2', prompt: 'x', voice_id: 'v', extra_params: { variant: 'siri' } }),
          /variant fehlt oder ist ungueltig/
        );
        assert.equal(calls.length, 0, 'an invalid variant is refused before the model is even read');
        await assert.rejects(
          speak({ text: text('x'), reference_audio: audio1 }, { model: 'text2speech_v2', voice_custom: 'v', extra_params: '{"variant":"minimax"}' }),
          /Model text2speech_v2 declares no audio input/
        );
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { model: 'text2speech_v2', prompt: 'x', voice_id: 'v', reference_audio_asset_ids: [audio1.assetId], extra_params: { variant: 'minimax' } }),
          /text2speech_v2 nimmt keine Referenz-Audiodatei/
        );
        assert.ok(sentNothing(), 'nothing is submitted for an incomplete text2speech_v2 call');
        // a variant the model does not define is dropped by the whitelist: the call is refused instead of sent without it
        modelResponse = (args) => JSON.stringify({ id: args.model_id, name: 'V2', output_type: 'audio', parameters: [{ name: 'speed', required: 'optional', type: 'number' }] });
        catalogLib.clearCache();
        await assert.rejects(
          speak({ text: text('x') }, { model: 'text2speech_v2', voice_custom: 'v', extra_params: '{"variant":"minimax"}' }),
          /variant fehlt oder ist ungueltig.*Es wurde nichts eingereicht/
        );
        assert.ok(sentNothing());
        modelResponse = (args) => (args.model_id === 'text2speech_v2' ? speechV2Json() : seedAudioJson());
        catalogLib.clearCache();
        // plan-time checks of the node
        assert.match(issuesOf(registry, 'hf.speech', { model: 'text2speech_v2', voice_custom: 'v' })[0].message, /variant: text2speech_v2 needs one of elevenlabs, minimax/);
        assert.equal(issuesOf(registry, 'hf.speech', { model: 'text2speech_v2', voice_custom: 'v', extra_params: '{"variant":"cozy_voice"}' }).length, 0);
        assert.match(
          issuesOf(registry, 'hf.speech', { model: 'text2speech_v2', voice_custom: 'v', extra_params: '{"variant":"minimax"}' }, { reference_audio: { connected: true, count: 1 } })[0].message,
          /text2speech_v2 takes no reference audio/
        );
        assert.match(issuesOf(registry, 'hf.speech', { model: 'text2speech_v2', extra_params: '{"variant":"minimax"}' })[0].message, /select a voice or enter a voice ID/);

        // only the speech models can be run; the game-pipeline audio models of the MCP cannot
        reset();
        for (const model of ['sonilo_music', 'mirelo_text_to_audio', 'inworld_text_to_speech']) {
          await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { model, prompt: 'x', voice_id: 'v' }), /ist fuer die Sprachausgabe nicht vorgesehen \(erlaubt: seed_audio, text2speech_v2\)/);
        }
        assert.equal(calls.length, 0);

        // argument checks of the tool itself: nothing is submitted for bad input
        await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: ' ', voice_id: 'v' }), /prompt fehlt/);
        await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x' }), /voice_id fehlt/);
        await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_id: 'v', voice_type: 'cloned' }), /voice_type "cloned" ist ungueltig/);
        await assert.rejects(tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_type: 'element' }), /voice_type und voice_id gehoeren zusammen/);
        await assert.rejects(
          tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', voice_type: 'preset', reference_audio_asset_ids: [audio1.assetId] }),
          /voice_type und voice_id gehoeren zusammen/
        );
        await assert.rejects(
          tools.executeTool({ ...toolCtx(), nodeView: undefined }, 'higgsfield_speech', { prompt: 'x', voice_id: 'v' }),
          /nur in der Node-Ansicht/
        );
        assert.equal(calls.length, 0, 'nothing was called');
        // a half voice cannot slip in through extra_params (voice_type without voice_id is refused by the API)
        await tools.executeTool(toolCtx(), 'higgsfield_speech', { prompt: 'x', reference_audio_asset_ids: [audio1.assetId], extra_params: { voice_type: 'element' } });
        assert.ok(!('voice_type' in sentParams()) && !('voice_id' in sentParams()));

        // Higgsfield answering with a job id that is already in use never creates a duplicate job
        reuseJob = speechJobs[0];
        const count = (await store.readLedger(sessionId)).length;
        await assert.rejects(speak({ text: text('Again') }, { voice_custom: 'v' }), /bereits fuer .* verwendete Job-ID/);
        assert.equal((await store.readLedger(sessionId)).length, count, 'the reserved asset is removed again');
        reuseJob = null;
      } finally {
        stop();
      }

      // validation before the run
      assert.match(issuesOf(registry, 'hf.speech', {})[0].message, /select a voice or enter a voice ID/);
      assert.equal(issuesOf(registry, 'hf.speech', {}, { reference_audio: { connected: true, count: 1 } }).length, 0, 'a reference voice can stand in for a voice');
      assert.equal(issuesOf(registry, 'hf.speech', { voice_custom: 'v' }).length, 0);
      assert.equal(issuesOf(registry, 'hf.speech', { voice: 'element:e' }).length, 0);
      assert.match(issuesOf(registry, 'hf.speech', { voice_custom: 'v', extra_params: '{nope' })[0].message, /not valid JSON/);
      await assert.rejects(speak({ text: text('x') }, {}), /select a voice or enter a voice ID/);
      // the credits estimate of the plan comes from the cached model without I/O
      await catalogLib.getModel('seed_audio');
      assert.deepEqual(oneOf(registry, 'hf.speech').cost.estimate({ model: 'seed_audio' }), { credits: 4 });
      assert.deepEqual(oneOf(registry, 'hf.speech').cost.estimate({ model: '' }), { credits: 4 }, 'an empty model means the default');
      assert.equal(oneOf(registry, 'hf.speech').cost.estimate({ model: 'text2speech_v2' }), null, 'not cached yet');
      catalogLib.clearCache();
    }

    /* ----- video.higgsfield with audio inputs: role and limit from the model, an image reference is required ----- */
    {
      resetMocks();
      patch(higgsfield, 'status', () => ({ connected: true }));
      const audio2 = await upload('.wav', Buffer.from('fake-wav'));
      const calls = [];
      const videoJobs = [];
      let imports = 0;
      const importId = (n) => `ffffffff-ffff-4fff-8fff-${String(n).padStart(12, '0')}`;
      // the audio role shares its slot with the image roles, like the one of seed_audio (limit of the audio part unknown)
      const combinedSlot = (args) =>
        modelJson({ id: args.model_id, medias: [{ name: 'medias', type: 'image', max: 4, roles: ['start_image', 'end_image', 'image_references', 'audio_references'] }] });
      // a slot with only the audio role states how many tracks the model takes
      const audioSlot = (args) =>
        modelJson({
          id: args.model_id,
          medias: [
            { name: 'start', type: 'image', max: 2, roles: ['start_image', 'end_image'] },
            { name: 'sound', type: 'image', max: 2, roles: ['audio_references'] }
          ]
        });
      let modelResponse = combinedSlot;
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (name === 'models_explore') return modelResponse(args);
        if (name === 'media_import_url') {
          imports += 1;
          return `Imported media ${importId(imports)}`;
        }
        if (name === 'generate_video_batch') {
          videoJobs.push(nextJobId());
          return `Submitted 1/1 generations.\n- index 0: ${videoJobs.at(-1)} (pending)`;
        }
        throw new Error(`unexpected MCP call ${name}`);
      });
      catalogLib.clearCache();
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      const submits = () => calls.filter((call) => call.name === 'generate_video_batch');
      const sentNothing = () => !calls.some((call) => call.name === 'media_import_url' || call.name.endsWith('_batch'));
      const reset = () => {
        calls.length = 0;
        imports = 0;
      };
      const generateVideo = (inputs, params = {}) => execute(registry, 'video.higgsfield', makeCtx(sessionId), inputs, { model: 'kling-3', duration: 5, ...params });
      const stop = startJobCompleter(sessionId, {});
      try {
        // without audio nothing changes: no audio slot is touched
        const plain = await generateVideo({ prompt: text('Silent') });
        assert.ok(!('medias' in submits()[0].args.requests[0].params));
        assert.equal(plain.variants[0].video.type, 'video');

        // an image reference plus one audio track: the image role is the image one, the audio role comes from the model
        reset();
        const talking = await generateVideo({ prompt: text('Talking head'), refs: list('image', [image1]), audio: audio1 });
        assert.deepEqual(submits()[0].args.requests[0].params.medias, [
          { value: importId(1), role: 'start_image' },
          { value: importId(2), role: 'audio_references' }
        ]);
        assert.equal(talking.variants[0].video.type, 'video');

        // several tracks (single value or list); a slot shared with the image roles states no limit of its own
        reset();
        await generateVideo({ prompt: text('Two tracks'), refs: list('image', [image1, image2]), audio: list('audio', [audio1, audio2]) });
        assert.deepEqual(submits()[0].args.requests[0].params.medias, [
          { value: importId(1), role: 'start_image' },
          { value: importId(2), role: 'start_image' },
          { value: importId(3), role: 'audio_references' },
          { value: importId(4), role: 'audio_references' }
        ]);

        // audio references need an image reference next to them: refused by the node and by the tool, nothing imported
        reset();
        await assert.rejects(generateVideo({ prompt: text('x'), audio: audio1 }), /audio: audio tracks need at least one image reference \(connect refs\)/);
        await assert.rejects(
          tools.executeTool(makeCtx(sessionId).toolCtx, 'higgsfield_generate_video', { model: 'kling-3', prompt: 'x', duration: 5, reference_audio_asset_ids: [audio1.assetId] }),
          /Audio-Referenzen brauchen mindestens eine Bild- oder Video-Referenz/
        );
        assert.ok(sentNothing());
        assert.equal(calls.length, 0, 'refused before even reading the model');
        const noRefs = issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { audio: { connected: true, count: 1 } });
        assert.equal(noRefs.length, 1);
        assert.match(noRefs[0].message, /at least one image reference/);
        assert.equal(issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { refs: { connected: true, count: 1 }, audio: { connected: true, count: 1 } }).length, 0);

        // the limit of a slot with only the audio role comes from the catalogue: node, plan and tool agree
        modelResponse = audioSlot;
        catalogLib.clearCache();
        reset();
        await generateVideo({ prompt: text('Fits'), refs: list('image', [image1]), audio: list('audio', [audio1, audio2]) });
        assert.equal(submits().length, 1);
        reset();
        await assert.rejects(
          generateVideo({ prompt: text('Too many'), refs: list('image', [image1]), audio: list('audio', [audio1, audio2, audio1]) }),
          /Model kling-3 accepts at most 2 audio tracks \(got 3\)/
        );
        await assert.rejects(
          tools.executeTool(makeCtx(sessionId).toolCtx, 'higgsfield_generate_video', {
            model: 'kling-3', prompt: 'x', duration: 5, reference_asset_ids: [image1.assetId], reference_audio_asset_ids: [audio1.assetId, audio2.assetId, audio1.assetId]
          }),
          /akzeptiert hoechstens 2 Audio-Referenzen \(3 angegeben\)/
        );
        assert.ok(sentNothing());
        await catalogLib.getModel('kling-3');
        const tooMany = issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { refs: { connected: true, count: 1 }, audio: { connected: true, count: 3 } });
        assert.equal(tooMany.length, 1);
        assert.match(tooMany[0].message, /accepts at most 2 audio tracks/);
        assert.equal(issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { refs: { connected: true, count: 1 }, audio: { connected: true, count: 2 } }).length, 0);
        // hard limit of 15, whatever the model says
        reset();
        await assert.rejects(
          generateVideo({ prompt: text('x'), refs: list('image', [image1]), audio: list('audio', Array.from({ length: 16 }, () => audio1)) }),
          /audio: at most 15 are allowed \(got 16\)/
        );
        assert.match(issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { refs: { connected: true, count: 1 }, audio: { connected: true, count: 16 } })[0].message, /at most 15 audio tracks/);
        assert.ok(sentNothing());

        // a non-audio asset is refused by the tool
        reset();
        await assert.rejects(generateVideo({ prompt: text('x'), refs: list('image', [image1]), audio: image1 }), /keine gueltige Audio-Referenz/);
        assert.ok(!calls.some((call) => call.name === 'media_import_url' || call.name.endsWith('_batch')));

        // a model without an audio role: nothing is imported or submitted
        modelResponse = (args) => modelJson({ id: args.model_id });
        catalogLib.clearCache();
        reset();
        const ledgerBefore = (await store.readLedger(sessionId)).length;
        await assert.rejects(
          generateVideo({ prompt: text('x'), refs: list('image', [image1]), audio: audio1 }),
          /Model kling-3 declares no audio input/
        );
        assert.ok(sentNothing());
        await assert.rejects(
          tools.executeTool(makeCtx(sessionId).toolCtx, 'higgsfield_generate_video', {
            model: 'kling-3', prompt: 'x', duration: 5, reference_asset_ids: [image1.assetId], reference_audio_asset_ids: [audio1.assetId]
          }),
          /deklariert keine Audio-Referenz/
        );
        assert.ok(sentNothing());
        assert.equal((await store.readLedger(sessionId)).length, ledgerBefore, 'no reserved asset is left behind');
        // the plan reports it from the cached model (no I/O), and only for a connected audio port
        await catalogLib.getModel('kling-3');
        const withRefs = { refs: { connected: true, count: 1 }, audio: { connected: true, count: 1 } };
        const issues = issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, withRefs);
        assert.equal(issues.length, 1);
        assert.match(issues[0].message, /declares no audio input/);
        const videoDef = oneOf(registry, 'video.higgsfield');
        assert.equal(videoDef.validate(registry.normalizeParams(videoDef, { model: 'kling-3' }), withRefs)[0].port, 'audio', 'the issue points at the audio port');
        assert.equal(issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, { refs: withRefs.refs }).length, 0, 'no audio connected, no issue');
        assert.equal(issuesOf(registry, 'video.higgsfield', { model: 'unknown' }, withRefs).length, 0, 'an unknown model is not judged before the run');
        modelResponse = combinedSlot;
        catalogLib.clearCache();
        await catalogLib.getModel('kling-3');
        assert.equal(issuesOf(registry, 'video.higgsfield', { model: 'kling-3' }, withRefs).length, 0);

        // a model that cannot be read at all: the documented role audio_references
        modelResponse = () => {
          throw new Error('models_explore down');
        };
        catalogLib.clearCache();
        reset();
        await generateVideo({ prompt: text('x'), refs: list('image', [image1]), audio: audio1 });
        assert.deepEqual(submits()[0].args.requests[0].params.medias, [
          { value: importId(1), role: 'image' },
          { value: importId(2), role: 'audio_references' }
        ], 'the safe image role and the documented audio role');

        // the Director (no ctx.nodeView) cannot pass audio at all
        modelResponse = combinedSlot;
        catalogLib.clearCache();
        reset();
        await tools.executeTool(
          { ...makeCtx(sessionId).toolCtx, nodeView: undefined },
          'higgsfield_generate_video',
          { model: 'kling-3', prompt: 'x', duration: 5, reference_audio_asset_ids: [audio1.assetId] }
        );
        assert.equal(submits().length, 1, 'the Director call still submits');
        assert.ok(!('medias' in submits()[0].args.requests[0].params), 'the audio reference is ignored without ctx.nodeView');
        assert.ok(!calls.some((call) => call.name === 'media_import_url'));
      } finally {
        stop();
      }
      catalogLib.clearCache();
    }

    /* ----- voices: parser (structured and text answers), paging, cache ----- */
    {
      resetMocks();
      const parse = catalogLib.parseVoices;
      // structuredContent of the live MCP: voices, has_more and the paging cursor (which the text does not carry)
      const structured = parse('5 voice(s):', {
        voices: [
          { voice_id: 'v-1', voice_type: 'preset', name: 'Grady', gender: 'male', preview_url: 'https://cdn.example/p1.mp3', logo_url: 'https://cdn.example/l1.png' },
          { voice_id: 'e-2', voice_type: 'element', name: 'My voice', gender: null },
          { voice_id: 'v-3', voice_type: 'preset', name: '', gender: 'female' },
          { name: 'no id' },
          'junk'
        ],
        has_more: true,
        next_cursor: ':4'
      });
      assert.deepEqual(structured.voices.map((voice) => [voice.value, voice.label]), [
        ['preset:v-1', 'Grady (male)'],
        ['element:e-2', 'My voice'],
        ['preset:v-3', 'v-3 (female)']
      ], 'label = name plus gender, when there is one');
      assert.equal(structured.nextCursor, ':4');
      assert.equal(structured.hasMore, true);
      assert.deepEqual(parse('x', { voices: [], has_more: false }), { voices: [], nextCursor: '', hasMore: false, error: '' });
      assert.equal(parse('x', { error: 'not allowed' }).error, 'not allowed');
      assert.equal(parse('- Anna (voice_id=a-1, voice_type=preset)', { unrelated: true }).voices[0].value, 'preset:a-1', 'a structured part without voices falls back to the text');
      // the text of the live MCP answer, as a fallback
      const live = parse([
        '5 voice(s):',
        '- Grady (voice_id=e2a2d2e6-0000-4000-8000-000000000001, voice_type=preset)',
        '- Ainsley (voice_id=e2a2d2e6-0000-4000-8000-000000000002, voice_type=preset)',
        '- My clone (voice_id=abc123, voice_type=element)'
      ].join('\n'));
      assert.deepEqual(live.voices.map((voice) => [voice.value, voice.name]), [
        ['preset:e2a2d2e6-0000-4000-8000-000000000001', 'Grady'],
        ['preset:e2a2d2e6-0000-4000-8000-000000000002', 'Ainsley'],
        ['element:abc123', 'My clone']
      ]);
      assert.equal(live.nextCursor, '', 'the text carries no cursor');
      assert.equal(live.hasMore, null);
      // the CLI spells the fields id / type; JSON in several shapes
      assert.deepEqual(parse(JSON.stringify({ voices: [{ id: 'c-1', type: 'element', name: 'CLI voice' }] })).voices.map((voice) => voice.value), ['element:c-1']);
      assert.equal(parse('[{"voice_id":"a","name":"A"}]').voices[0].value, 'preset:a', 'a bare array');
      assert.equal(parse(JSON.stringify({ items: [{ id: 'i-1', type: 'element', name: 'Item' }] })).voices[0].value, 'element:i-1', 'items / id / type aliases');
      assert.equal(parse(`Here you go:\n${JSON.stringify({ results: [{ voiceId: 'r-1' }] })}`).voices[0].value, 'preset:r-1', 'JSON inside prose');
      assert.deepEqual(parse('{"voices":[],"has_more":false}'), { voices: [], nextCursor: '', hasMore: false, error: '' });
      assert.equal(parse('{"error":"not allowed"}').error, 'not allowed');
      // other plain text shapes
      const plain = parse([
        'Voices (2 of 5):',
        '1. Sarah - voice_id: sarah-01, voice_type: preset, gender: female',
        '- Max (voice_id: max-02, voice_type: element)',
        'voice_id: bare-03',
        'next_cursor: abc123',
        'has_more: true'
      ].join('\n'));
      assert.deepEqual(plain.voices.map((voice) => voice.value), ['preset:sarah-01', 'element:max-02', 'preset:bare-03']);
      assert.equal(plain.voices[0].name, 'Sarah');
      assert.equal(plain.voices[0].label, 'Sarah (female)');
      assert.equal(plain.voices[1].name, 'Max');
      assert.equal(plain.voices[2].name, 'bare-03', 'the id is the name when none is given');
      assert.equal(plain.nextCursor, 'abc123');
      assert.equal(plain.hasMore, true);
      assert.deepEqual(parse('No voices found.'), { voices: [], nextCursor: '', hasMore: null, error: '' });
      assert.equal(parse('next_cursor: null').nextCursor, '');
      assert.deepEqual(parse('').voices, []);

      // paging through next_cursor of the structured part (size 100), de-duplication, cache, refresh
      const calls = [];
      let clock = 5000;
      const pages = {
        '': { voices: [{ voice_id: 'a', name: 'A' }, { voice_id: 'b', name: 'B' }], next_cursor: ':2', has_more: true },
        ':2': { voices: [{ voice_id: 'c', name: 'C' }, { voice_id: 'a', name: 'A again' }], next_cursor: ':4', has_more: true },
        ':4': { voices: [{ voice_id: 'd', voice_type: 'element', name: 'D' }], has_more: false }
      };
      const fake = {
        status: () => ({ connected: true }),
        mcpCall: async (name, args, options) => {
          calls.push({ name, args, options });
          assert.equal(name, 'list_voices');
          const page = pages[args.cursor || ''];
          // the live answer: a text part without cursor and the structured part with it
          return { text: `${page.voices.length} voice(s):\n${page.voices.map((voice) => `- ${voice.name} (voice_id=${voice.voice_id}, voice_type=preset)`).join('\n')}`, structured: page };
        }
      };
      const catalog = catalogLib.createCatalog({ higgsfield: fake, now: () => clock, ttlMs: 500 });
      const voices = await catalog.listVoices();
      assert.deepEqual(voices.map((voice) => voice.value), ['preset:a', 'preset:b', 'preset:c', 'element:d'], 'follows next_cursor and de-duplicates');
      assert.deepEqual(calls.map((call) => call.args), [{ size: 100 }, { size: 100, cursor: ':2' }, { size: 100, cursor: ':4' }], 'flat arguments, size 100');
      assert.ok(calls.every((call) => call.options && call.options.withStructured === true), 'the structured part is requested');
      await catalog.listVoices();
      assert.equal(calls.length, 3, 'cached');
      clock += 501;
      await catalog.listVoices();
      assert.equal(calls.length, 6, 'refetched after the TTL');
      await catalog.listVoices({ refresh: true });
      assert.equal(calls.length, 9, 'manual refresh');
      catalog.clearCache();
      await catalog.listVoices();
      assert.equal(calls.length, 12, 'clearCache forgets the voices');

      // at most five pages, a repeated cursor ends the loop, has_more:false wins (plain string answers work, too)
      let endless = 0;
      const many = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async () => {
            endless += 1;
            return JSON.stringify({ voices: [{ voice_id: `v${endless}` }], next_cursor: `n${endless}`, has_more: true });
          }
        }
      });
      assert.equal((await many.listVoices()).length, catalogLib.MAX_VOICE_PAGES);
      assert.equal(endless, 5, 'at most 5 pages');
      let loops = 0;
      const looping = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async () => {
            loops += 1;
            return { text: '', structured: { voices: [{ voice_id: `l${loops}` }], next_cursor: 'same' } };
          }
        }
      });
      assert.equal((await looping.listVoices()).length, 2);
      assert.equal(loops, 2, 'the same cursor twice stops the loop');
      let single = 0;
      const finished = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async () => {
            single += 1;
            return { text: '', structured: { voices: [{ voice_id: 'only' }], next_cursor: 'more', has_more: false } };
          }
        }
      });
      assert.equal((await finished.listVoices()).length, 1);
      assert.equal(single, 1, 'has_more:false ends the paging');
      // an answer without a structured part (text only) is one page: the text has no cursor
      let textOnly = 0;
      const texted = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async () => {
            textOnly += 1;
            return { text: '- Yan (voice_id=y-1, voice_type=preset)\n- Zed (voice_id=z-2, voice_type=element)', structured: null };
          }
        }
      });
      assert.deepEqual((await texted.listVoices()).map((voice) => voice.value), ['preset:y-1', 'element:z-2']);
      assert.equal(textOnly, 1);
      // a text answer that names a cursor pages the same way
      const textCalls = [];
      const cursored = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async (name, args) => {
            textCalls.push(args);
            return args.cursor ? '- Zed - voice_id: z-2\nhas_more: false' : '- Yan - voice_id: y-1\nnext_cursor: t2\nhas_more: true';
          }
        }
      });
      assert.deepEqual((await cursored.listVoices()).map((voice) => voice.value), ['preset:y-1', 'preset:z-2']);
      assert.equal(textCalls.length, 2);

      // disconnected: no call; an error answer fails (and is not cached), a later success works
      const offline = catalogLib.createCatalog({ higgsfield: { status: () => ({ connected: false }), mcpCall: async () => assert.fail('no call expected') } });
      assert.deepEqual(await offline.listVoices(), []);
      let healthy = false;
      let tries = 0;
      const flaky = catalogLib.createCatalog({
        higgsfield: {
          status: () => ({ connected: true }),
          mcpCall: async () => {
            tries += 1;
            return healthy ? JSON.stringify({ voices: [{ voice_id: 'ok' }] }) : { text: '', structured: { error: 'quota exceeded' } };
          }
        }
      });
      await assert.rejects(flaky.listVoices(), /Higgsfield list_voices: quota exceeded/);
      healthy = true;
      assert.equal((await flaky.listVoices()).length, 1);
      assert.equal(tries, 2, 'a failed answer is not cached');
      const throwing = catalogLib.createCatalog({ higgsfield: { status: () => ({ connected: true }), mcpCall: async () => { throw new Error('MCP down'); } } });
      await assert.rejects(throwing.listVoices(), /MCP down/);

      // model parameters of seed_audio as the live MCP lists them: integers and numeric options are exposed, the audio
      // formats the app cannot play are not offered
      const described = catalogLib.createCatalog({ higgsfield: { status: () => ({ connected: true }), mcpCall: async () => seedAudioJson() } });
      const seed = described.describeModel(await described.getModel('seed_audio'));
      const seedParam = Object.fromEntries(seed.params.map((param) => [param.id, param]));
      assert.deepEqual(seedParam.format.options, ['wav', 'mp3'], 'pcm and ogg_opus are not offered');
      assert.equal(seedParam.format.default, 'wav');
      assert.equal(seedParam.format.target, 'extra_params');
      assert.deepEqual(seedParam.sample_rate.options, [8000, 16000, 24000, 32000, 44100, 48000]);
      assert.equal(seedParam.sample_rate.default, 24000);
      assert.deepEqual([seedParam.speech_rate.kind, seedParam.speech_rate.min, seedParam.speech_rate.max, seedParam.speech_rate.default], ['integer', -50, 100, 0]);
      assert.deepEqual([seedParam.pitch_rate.min, seedParam.pitch_rate.max], [-12, 12]);
      assert.ok(!seedParam.prompt, 'reserved parameters are not exposed');
      assert.ok(!seedParam.voice_id && !seedParam.voice_type, 'the voice has its own node params');
      assert.equal(seed.type, 'audio');
      assert.equal(seed.supportsUnlim, true);
      assert.equal(seed.credits.perUnit, 4);
      // other models keep such parameters (a video model with a voice_id can still be given one)
      const videoVoice = described.describeModel(JSON.parse(modelJson({ parameters: [{ name: 'voice_id', type: 'string' }] })));
      assert.ok(videoVoice.params.some((param) => param.id === 'voice_id'));
      // image models keep their format options untouched
      assert.deepEqual(described.describeModel(JSON.parse(modelJson({ parameters: [{ name: 'format', type: 'string', options: ['png', 'jpg'] }] }))).params.find((param) => param.id === 'format').options, ['png', 'jpg']);
    }

    /* ----- WP31: what a model takes at its inputs (references, audio) is known, shown and enforced ----- */
    {
      resetMocks();
      // models as models_explore describes them: a Grok-like one with a single reference image, one with up to four, one
      // with start and end image (roles), one without image references, one that needs a reference, one image model
      const model = (id, name, medias, output = 'video') => JSON.stringify({ id, name, provider_name: 'Test', output_type: output, parameters: [], medias, credits_per_unit: 2, credit_unit: 'per_generation' });
      const catalogue = {
        one: model('grok_like', 'Grok Like 1.5', [{ name: 'start', type: 'image', max: 1, roles: ['start_image'] }]),
        four: model('four_refs', 'Four Refs', [{ name: 'refs', type: 'image', max: 4, roles: ['image_references'] }]),
        startEnd: model('start_end', 'Start End', [{ name: 'frames', type: 'image', max: 2, roles: ['start_image', 'end_image'] }]),
        none: model('text_only', 'Text Only', []),
        required: model('needs_ref', 'Needs Ref', [{ name: 'start', type: 'image', max: 1, required: true, roles: ['start_image'] }]),
        audio: model('with_audio', 'With Audio', [{ name: 'medias', type: 'image', max: 3, roles: ['start_image', 'audio_references'] }]),
        image: model('multi_image', 'Multi Image', [{ name: 'refs', type: 'image', max: 8, roles: ['image'] }], 'image')
      };
      const byId = Object.fromEntries(Object.values(catalogue).map((json) => [JSON.parse(json).id, json]));

      // capabilities: the numbers come from medias[]; no media list = unknown, which is not "no references"
      const caps = (json, options) => catalogLib.capabilitiesOf(JSON.parse(json), options);
      assert.deepEqual(caps(catalogue.one).references, { max: 1, roles: ['start_image'], required: false });
      assert.deepEqual(caps(catalogue.four).references, { max: 4, roles: ['image_references'], required: false });
      assert.deepEqual(caps(catalogue.startEnd).references, { max: 2, roles: ['start_image', 'end_image'], required: false });
      assert.deepEqual(caps(catalogue.none).references, { max: 0, roles: [], required: false }, 'a model without image slots takes none');
      assert.equal(caps(catalogue.required).references.required, true);
      assert.deepEqual(caps(catalogue.one).audio, { max: 0 }, 'a video model without an audio role takes no audio');
      assert.deepEqual(caps(catalogue.audio).audio, { max: 15 }, 'no stated limit: the limit of the tool');
      assert.deepEqual(caps(catalogue.image).references, { max: 8, roles: ['image'], required: false }, 'image models have capabilities');
      assert.ok(!('audio' in caps(catalogue.image)), 'audio is a video thing');
      assert.deepEqual(caps(catalogue.image, { type: 'video' }).audio, { max: 0 }, 'the type of the list can say it is a video model');
      assert.equal(catalogLib.capabilitiesOf({ id: 'x', name: 'No media list' }), null);
      assert.equal(catalogLib.capabilitiesOf(null), null);

      // the model description (GET /api/nodes/higgsfield-models/:id) carries the same, unknown as null
      const described = catalogLib.describeModel(JSON.parse(catalogue.startEnd));
      assert.deepEqual(described.references, { max: 2, roles: ['start_image', 'end_image'], required: false });
      assert.deepEqual(described.audio, { max: 0 });
      assert.deepEqual(described.refs, described.references, 'refs stays for older clients');
      assert.equal(catalogLib.describeModel({ id: 'bare', name: 'Bare' }).references, null);
      assert.ok(!('audio' in catalogLib.describeModel({ id: 'bare', name: 'Bare' })));

      // a list entry without media list is read again on the first getModel (it would look like "no references" otherwise)
      {
        const calls = [];
        const fake = {
          status: () => ({ connected: true }),
          mcpCall: async (name, args) => {
            calls.push(args);
            if (args.action === 'list') return JSON.stringify({ items: [{ id: 'grok_like', name: 'Grok Like 1.5' }, JSON.parse(catalogue.four)], has_more: false });
            return byId[args.model_id];
          }
        };
        const catalog = catalogLib.createCatalog({ higgsfield: fake });
        await catalog.listModels('video');
        assert.equal(catalog.peekModel('grok_like').medias, undefined, 'the list entry is partial');
        const full = await catalog.getModel('grok_like');
        assert.equal(calls.filter((call) => call.action === 'get').length, 1, 'the partial entry is read in full');
        assert.equal(catalogLib.capabilitiesOf(full).references.max, 1);
        await catalog.getModel('grok_like');
        await catalog.getModel('four_refs');
        assert.equal(calls.filter((call) => call.action === 'get').length, 1, 'a full entry (list or get) is cached');
      }

      // the registry gives the port its limit: known from the cached model, unknown otherwise; the fixed maximum stays the ceiling
      patch(higgsfield, 'status', () => ({ connected: true }));
      let getCalls = 0;
      patch(higgsfield, 'mcpCall', async (name, args) => {
        assert.equal(name, 'models_explore');
        if (args.action === 'get') {
          getCalls += 1;
          return byId[args.model_id] || JSON.stringify({ items: [] });
        }
        return JSON.stringify({ items: [], has_more: false });
      });
      catalogLib.clearCache();
      const refsPort = (type, model) => registry.portsFor(oneOf(registry, type), { model }).inputs.find((port) => port.id === 'refs');
      assert.deepEqual(refsPort('video.higgsfield', 'grok_like').limit, { known: false }, 'not in the cache yet: unknown');
      assert.equal(refsPort('video.higgsfield', 'grok_like').max, 12, 'the fixed maximum is the ceiling meanwhile');
      assert.deepEqual(refsPort('video.higgsfield', '').limit, { known: false });
      for (const id of Object.keys(byId)) await catalogLib.getModel(id);
      assert.deepEqual(refsPort('video.higgsfield', 'grok_like'), { id: 'refs', type: 'image', multiple: true, max: 1, limitBy: { param: 'model', capability: 'references' }, limit: { known: true, max: 1, roles: ['start_image'], required: false, subject: 'Grok Like 1.5' } });
      assert.equal(refsPort('video.higgsfield', 'four_refs').max, 4);
      assert.equal(refsPort('video.higgsfield', 'text_only').max, 0);
      assert.deepEqual(refsPort('video.higgsfield', 'start_end').limit.roles, ['start_image', 'end_image']);
      assert.equal(refsPort('image.higgsfield', 'multi_image').max, 8);
      const audioPort = (model) => registry.portsFor(oneOf(registry, 'video.higgsfield'), { model }).inputs.find((port) => port.id === 'audio');
      assert.equal(audioPort('grok_like').max, 0);
      assert.equal(audioPort('with_audio').max, 15);
      assert.equal(registry.portsFor(oneOf(registry, 'image.higgsfield'), { model: 'multi_image' }).inputs.some((port) => port.id === 'audio'), false);
      // what the client reads: the declaration of the descriptor
      const descriptor = registry.publicDescriptor(oneOf(registry, 'video.higgsfield'));
      assert.deepEqual(descriptor.inputs.find((port) => port.id === 'refs').limitBy, { param: 'model', capability: 'references' });
      assert.deepEqual(descriptor.inputs.find((port) => port.id === 'audio').limitBy, { param: 'model', capability: 'audio' });
      assert.equal(typeof descriptor.limitsFor, 'undefined', 'the function stays on the server');
      // a definition with limitBy needs a limitsFor, and limitBy names a param
      const broken = (patchDef) => () => createRegistry().register({ type: 'util.broken', category: 'utility', execute: async () => ({ variants: [] }), params: [{ id: 'model', kind: 'text' }], ...patchDef });
      assert.throws(broken({ inputs: [{ id: 'refs', type: 'image', multiple: true, max: 4, limitBy: { param: 'model', capability: 'references' } }] }), /limitsFor/);
      assert.throws(broken({ limitsFor: () => ({}), inputs: [{ id: 'refs', type: 'image', multiple: true, max: 4, limitBy: { param: 'nope', capability: 'references' } }] }), /unknown param/);
      assert.throws(broken({ limitsFor: () => ({}), inputs: [{ id: 'refs', type: 'image', max: 4, limitBy: { param: 'model', capability: 'references' } }] }), /limitBy/);

      // validate: too many references is an issue with a stable code and the data for the translation
      const issues = (type, model, ports) => oneOf(registry, type).validate(registry.normalizeParams(oneOf(registry, type), { model }), ports);
      const withRefs = (count) => ({ refs: { connected: count > 0, count } });
      let found = issues('video.higgsfield', 'grok_like', withRefs(2));
      assert.equal(found.length, 1);
      assert.deepEqual([found[0].code, found[0].port, found[0].data], ['too_many_refs', 'refs', { model: 'Grok Like 1.5', max: 1, count: 2 }]);
      assert.match(found[0].message, /accepts at most 1 reference images \(got 2\)/);
      assert.deepEqual(issues('video.higgsfield', 'grok_like', withRefs(1)), []);
      assert.deepEqual(issues('video.higgsfield', 'four_refs', withRefs(4)), []);
      assert.equal(issues('video.higgsfield', 'four_refs', withRefs(5))[0].data.max, 4);
      assert.deepEqual(issues('image.higgsfield', 'text_only', withRefs(1))[0].data, { model: 'Text Only', max: 0, count: 1 }, 'a model without image references takes none');
      assert.deepEqual(issues('image.higgsfield', 'text_only', withRefs(0)), []);
      assert.deepEqual(issues('image.higgsfield', 'multi_image', withRefs(8)), []);
      assert.equal(issues('image.higgsfield', 'multi_image', withRefs(9))[0].code, 'too_many_refs');
      assert.deepEqual(issues('video.higgsfield', 'start_end', withRefs(2)), []);
      assert.equal(issues('video.higgsfield', 'start_end', withRefs(3))[0].data.max, 2);
      // a model that is not in the cache (or not chosen) cannot be judged here: execute() checks again
      assert.deepEqual(issues('video.higgsfield', 'not_cached', withRefs(5)), []);
      assert.equal(issues('video.higgsfield', '', withRefs(2)).length, 1, 'only "select a model"');
      // more than 12 stays the fixed rule
      assert.deepEqual(issues('video.higgsfield', 'four_refs', withRefs(13)), ['refs: at most 12 references are allowed']);
      // a required reference
      found = issues('video.higgsfield', 'needs_ref', withRefs(0));
      assert.deepEqual([found[0].code, found[0].port, found[0].data], ['refs_required', 'refs', { model: 'Needs Ref' }]);
      assert.deepEqual(issues('video.higgsfield', 'needs_ref', withRefs(1)), []);
      assert.deepEqual(issues('video.higgsfield', 'grok_like', withRefs(0)), [], 'a model that does not require one is fine without');

      // changing the model never removes connections; the node is invalid and the run is refused before anything is submitted
      patch(or, 'hasKey', () => true);
      const calls = [];
      patch(higgsfield, 'mcpCall', async (name, args) => {
        calls.push({ name, args });
        if (args.action === 'get') return byId[args.model_id] || JSON.stringify({ items: [] });
        return JSON.stringify({ items: [], has_more: false });
      });
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const limited = await newWorkflow('Reference limits', {
        nodes: [
          node('p1', 'input.text', { text: 'A fox runs' }),
          node('i1', 'input.image', { asset: image1 }),
          node('i2', 'input.image', { asset: image2 }, 0),
          node('v1', 'video.higgsfield', { model: 'four_refs' }, 400)
        ],
        edges: [edge('e1', 'p1', 'text', 'v1', 'prompt'), edge('e2', 'i1', 'image', 'v1', 'refs'), edge('e3', 'i2', 'image', 'v1', 'refs')]
      });
      const fits = await engine.plan(limited.id, { mode: 'all' });
      assert.equal(fits.nodes.v1.status, 'stale', JSON.stringify(fits.issues));
      const before = await wfStore.readWorkflow(limited.id);
      const other = before.graph.nodes.map((item) => (item.id === 'v1' ? { ...item, params: { model: 'grok_like' } } : item));
      await wfStore.saveGraph(limited.id, { baseRev: before.rev, graph: { ...before.graph, nodes: other } });
      assert.equal((await wfStore.readWorkflow(limited.id)).graph.edges.length, 3, 'the connections stay');
      const over = await engine.plan(limited.id, { mode: 'all' });
      assert.equal(over.valid, false);
      assert.equal(over.nodes.v1.status, 'invalid');
      assert.equal(over.nodes.v1.reasonCode, 'too_many_refs');
      assert.equal(over.nodes.v1.reasonPort, 'refs');
      assert.deepEqual(over.nodes.v1.reasonData, { model: 'Grok Like 1.5', max: 1, count: 2 });
      assert.match(over.nodes.v1.reason, /accepts at most 1 reference images/);
      calls.length = 0;
      await assert.rejects(engine.start(limited.id, { mode: 'all', user: 'tester' }), (err) => err.code === 'INVALID_GRAPH' && /reference images/.test(err.message) && err.issues.some((issue) => issue.code === 'too_many_refs'));
      assert.equal(calls.filter((call) => call.name.endsWith('_batch') || call.name.startsWith('generate')).length, 0, 'nothing was submitted');
      // the same graph with a model that takes more is valid again, without touching the connections
      const back = await wfStore.readWorkflow(limited.id);
      await wfStore.saveGraph(limited.id, { baseRev: back.rev, graph: { ...back.graph, nodes: back.graph.nodes.map((item) => (item.id === 'v1' ? { ...item, params: { model: 'four_refs' } } : item)) } });
      assert.equal((await engine.plan(limited.id, { mode: 'all' })).nodes.v1.status, 'stale');

      // A cold or expired catalogue must not let the run through: the engine loads the model of the nodes before it judges
      // (plan and start). Measured before: plan valid, POST /runs accepted, execute failed after paid nodes had run.
      {
        const current = await wfStore.readWorkflow(limited.id);
        await wfStore.saveGraph(limited.id, { baseRev: current.rev, graph: { ...current.graph, nodes: current.graph.nodes.map((item) => (item.id === 'v1' ? { ...item, params: { model: 'grok_like' } } : item)) } });
        catalogLib.clearCache();
        assert.equal(catalogLib.peekModel('grok_like'), null, 'the cache is cold');
        calls.length = 0;
        const cold = await engine.plan(limited.id, { mode: 'all' });
        assert.equal(cold.valid, false, 'judged although the cache was cold');
        assert.equal(cold.nodes.v1.reasonCode, 'too_many_refs');
        assert.equal(calls.filter((call) => call.args.action === 'get').length, 1, 'the model was read once');
        await engine.plan(limited.id, { mode: 'all' });
        assert.equal(calls.filter((call) => call.args.action === 'get').length, 1, 'a warm cache is not asked again');
        catalogLib.clearCache();
        const runsBefore = (await wfStore.listRuns(limited.id)).length;
        await assert.rejects(engine.start(limited.id, { mode: 'all', user: 'tester' }), (err) => err.code === 'INVALID_GRAPH' && err.issues.some((issue) => issue.code === 'too_many_refs'));
        assert.equal((await wfStore.listRuns(limited.id)).length, runsBefore, 'no run was created');
        assert.equal(engine.activeRun(limited.id), null);
        // the catalogue cannot be read (or is slow): unknown stays unknown, the plan still works
        catalogLib.clearCache();
        patch(higgsfield, 'mcpCall', async () => {
          throw new Error('models_explore down');
        });
        const unreadable = await engine.plan(limited.id, { mode: 'all' });
        assert.equal(unreadable.nodes.v1.status, 'stale', 'not judged without the model');
        const slowEngine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, prepareTimeoutMs: 40 } });
        patch(higgsfield, 'mcpCall', () => new Promise(() => {}));
        const started = Date.now();
        // The timer of the preparation is unref'd and the answer never comes: without a handle of its own the process would
        // end here, quietly and with exit code 0 (and every check below would not run).
        const keepAlive = setInterval(() => {}, 20);
        try {
          assert.equal((await slowEngine.plan(limited.id, { mode: 'all' })).nodes.v1.status, 'stale');
        } finally {
          clearInterval(keepAlive);
        }
        assert.ok(Date.now() - started < 2000, 'a slow catalogue does not hold the plan');
        patch(higgsfield, 'mcpCall', async (name, args) => {
          calls.push({ name, args });
          if (args.action === 'get') return byId[args.model_id] || JSON.stringify({ items: [] });
          return JSON.stringify({ items: [], has_more: false });
        });
        // the hook is declared on the definition and must be a function
        assert.equal(typeof oneOf(registry, 'video.higgsfield').prepare, 'function');
        assert.throws(() => createRegistry().register({ type: 'util.broken', category: 'utility', execute: async () => ({ variants: [] }), prepare: 'no' }), /prepare/);
        catalogLib.clearCache();
      }

      // audio: the same rule as for references, with a stable code and the data for the translation
      {
        await catalogLib.getModel('grok_like');
        await catalogLib.getModel('with_audio');
        const audioIssues = (model, count) => oneOf(registry, 'video.higgsfield').validate(registry.normalizeParams(oneOf(registry, 'video.higgsfield'), { model }), { refs: { connected: true, count: 1 }, audio: { connected: true, count } });
        let audioFound = audioIssues('grok_like', 2);
        assert.equal(audioFound.length, 1);
        assert.deepEqual([audioFound[0].code, audioFound[0].port, audioFound[0].data], ['too_many_audio', 'audio', { model: 'Grok Like 1.5', max: 0, count: 2 }]);
        assert.match(audioFound[0].message, /declares no audio input/);
        assert.deepEqual(audioIssues('with_audio', 4), []);
        assert.equal(audioIssues('with_audio', 16).length, 1, 'more than 15 is only the fixed rule');
        // a list entry without the media list is not a model that takes no audio
        catalogLib.clearCache();
        const listOnly = catalogLib.createCatalog({ higgsfield: { status: () => ({ connected: true }), mcpCall: async () => JSON.stringify({ items: [{ id: 'grok_like', name: 'Grok Like 1.5' }], has_more: false }) } });
        await listOnly.listModels('video');
        assert.equal(listOnly.peekModel('grok_like').medias, undefined);
        assert.equal(catalogLib.capabilitiesOf(listOnly.peekModel('grok_like'), { type: 'video' }), null, 'unknown, not none');
        const realPeek = catalogLib.peekModel;
        catalogLib.peekModel = () => listOnly.peekModel('grok_like');
        try {
          assert.deepEqual(audioIssues('grok_like', 2), [], 'no issue from a partial record');
        } finally {
          catalogLib.peekModel = realPeek;
        }
        catalogLib.clearCache();
      }

      // hf.speech: text2speech_v2 takes no reference audio (a fixed list of models: portVariants)
      const speechPort = (model) => registry.portsFor(oneOf(registry, 'hf.speech'), { model }).inputs.find((port) => port.id === 'reference_audio');
      assert.equal(speechPort('seed_audio').max, 2);
      assert.equal(speechPort('text2speech_v2').max, 0);
      catalogLib.clearCache();
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
      let voicesFail = false;
      patch(higgsfield, 'mcpCall', async (name, args) => {
        if (name === 'list_voices') {
          if (voicesFail) throw new Error('MCP down');
          return JSON.stringify({
            voices: [
              { voice_id: 'v-1', voice_type: 'preset', name: 'Anna', gender: 'female' },
              { voice_id: 'e-2', voice_type: 'element', name: 'My voice', gender: null }
            ],
            has_more: false
          });
        }
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
      // hf.speech offers the two speech models itself: there is no catalogue list of audio models (game-pipeline models)
      assert.equal((await call('/api/nodes/options/:source', { source: 'higgsfield-audio-models' })).status, 404);
      const voices = await call('/api/nodes/options/:source', { source: 'higgsfield-voices' });
      assert.equal(voices.status, 200);
      assert.deepEqual(voices.body.options, [
        { value: 'preset:v-1', label: 'Anna (female)' },
        { value: 'element:e-2', label: 'My voice' }
      ]);
      // a failing voice list is a 502 (the inspector then falls back to the typed voice id) and is retried later
      catalogLib.clearCache();
      voicesFail = true;
      const failed = await call('/api/nodes/options/:source', { source: 'higgsfield-voices' });
      assert.equal(failed.status, 502);
      assert.match(failed.body.error, /Higgsfield voices could not be loaded: MCP down/);
      voicesFail = false;
      assert.equal((await call('/api/nodes/options/:source', { source: 'higgsfield-voices' })).status, 200);
      const model = await call('/api/nodes/higgsfield-models/:modelId', { modelId: 'kling-3' });
      assert.equal(model.status, 200);
      assert.equal(model.body.name, 'Kling 3');
      assert.ok(model.body.params.some((param) => param.id === 'quality' && param.target === 'extra_params'));
      assert.equal((await call('/api/nodes/higgsfield-models/:modelId', { modelId: 'gone' })).status, 404);
      // WP31: the description tells what the model takes; the model list does too when it carries the media list
      assert.deepEqual(model.body.references, { max: 2, roles: ['start_image', 'end_image'], required: false });
      assert.deepEqual(model.body.audio, { max: 0 });
      catalogLib.clearCache();
      patch(higgsfield, 'mcpCall', async (name, args) => {
        assert.equal(name, 'models_explore');
        const withMedias = (id, name, medias) => ({ id, name, output_type: args.type, medias });
        return JSON.stringify({
          items: [
            withMedias('one-ref', 'One Ref', [{ name: 'start', type: 'image', max: 1, roles: ['start_image'] }]),
            withMedias('frames', 'Frames', [{ name: 'start', type: 'image', max: 2, roles: ['start_image', 'end_image'], required: true }, { name: 'sound', type: 'image', max: 2, roles: ['audio_references'] }]),
            withMedias('text-only', 'Text only', []),
            { id: 'unread', name: 'Unread' }
          ],
          has_more: false
        });
      });
      const videoOptions = (await call('/api/nodes/options/:source', { source: 'higgsfield-video-models' })).body.options;
      assert.deepEqual(videoOptions, [
        { value: 'one-ref', label: 'One Ref', references: { max: 1, roles: ['start_image'], required: false }, audio: { max: 0 } },
        { value: 'frames', label: 'Frames', references: { max: 2, roles: ['start_image', 'end_image'], required: true }, audio: { max: 2 } },
        { value: 'text-only', label: 'Text only', references: { max: 0, roles: [], required: false }, audio: { max: 0 } },
        { value: 'unread', label: 'Unread' }
      ]);
      catalogLib.clearCache();
      const imageOptions = (await call('/api/nodes/options/:source', { source: 'higgsfield-image-models' })).body.options;
      assert.deepEqual(imageOptions[0], { value: 'one-ref', label: 'One Ref', references: { max: 1, roles: ['start_image'], required: false } }, 'no audio for image models');
      assert.deepEqual(imageOptions[3], { value: 'unread', label: 'Unread' }, 'without a media list nothing is claimed');
      const registryPayload = (await call('/api/nodes/registry', {})).body;
      assert.ok(registryPayload.nodeTypes.some((type) => type.type === 'image.higgsfield' && type.category === 'higgsfield'));
      assert.ok(registryPayload.nodeTypes.some((type) => type.type === 'hf.remove_background' && type.experimental === true));
      catalogLib.clearCache();
    }

  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-generate.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
