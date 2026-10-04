'use strict';

// Runway Aleph 2.0 as a model of the node "Edit video with references" (fal.video_edit, WP41), through OpenRouter. A fake OpenRouter
// and a fake ffmpeg: nothing is paid and nothing leaves the machine.
//   - everything the app ASSUMES about the model stands in lib/nodes/aleph-edit.js ("per live test"): the table is read here, so a
//     change of an assumption shows up in this test
//   - the request: model, prompt and the video in input_references (video_url); no duration, no resolution, no aspect ratio, no frames
//   - the price: 0.28 USD per second, at least 0.56 USD per run (1 s and 2 s = 0.56, 3 s = 0.84); the live list wins over the constants
//   - the checks before the run: length (2 to 30 s), format, size, no images, prompt, the keys and the address of the server
//   - "Cut to the allowed length" works for Aleph like for the other models (a cut file is published and removed)
//   - the job record, the removal of the published address when the provider refuses, nothing booked on a refusal
//   - rights and budget: the tool is paid and node-only (the budget of a participant and of a guest is tested in test-teams-api.js)

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const discovery = require('../lib/discovery');
const publicrefs = require('../lib/publicrefs');
const publicrefsReal = { publishFile: publicrefs.publishFile };
const ffmpeg = require('../lib/ffmpeg');
const tools = require('../lib/tools');
const videoNodeModels = require('../lib/video-node-models');
const assets = require('../lib/nodes/assets');
const ops = require('../lib/nodes/ffmpeg-ops');
const alephEdit = require('../lib/nodes/aleph-edit');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const { createRegistry } = require('../lib/nodes/registry');
const { textValue } = require('../lib/nodes/types');

const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');
const TYPE = 'fal.video_edit';
const ALEPH = 'runway/aleph-2';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'amount'}: ${actual} is not ${expected}`);
const plain = (value) => JSON.parse(JSON.stringify(value));

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

const CATALOG = {
  data: [
    {
      id: ALEPH,
      name: 'Runway: Aleph 2.0',
      generate_audio: false,
      supported_aspect_ratios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
      pricing_skus: { cents_per_second_output: '28', minimum_cents_per_generation: '56' }
    }
  ]
};

/* ---------- the table of assumptions ---------- */

function testAssumptionTable() {
  assert.equal(alephEdit.MODEL, ALEPH);
  assert.equal(alephEdit.NAME, 'Runway Aleph 2.0');
  // the facts of the OpenRouter list
  near(alephEdit.FACTS.perSecondUsd, 0.28);
  near(alephEdit.FACTS.minimumUsd, 0.56);
  assert.match(alephEdit.FACTS.fetched, /^\d{4}-\d{2}-\d{2}$/);
  // the assumptions: one place, every one of them named as such in the file
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'aleph-edit.js'), 'utf8');
  assert.ok((source.match(/per live test/g) || []).length >= 6, 'every assumption is marked "per live test"');
  assert.deepEqual(plain(alephEdit.ASSUMPTIONS.formats), ['.mp4', '.webm']);
  assert.equal(alephEdit.ASSUMPTIONS.imagesSupported, false);
  assert.equal(alephEdit.ASSUMPTIONS.videoReferenceType, 'video_url');
  assert.deepEqual(plain(alephEdit.LIMITS), { minSeconds: 2, maxSeconds: 30, maxBytes: 16 * MB, maxEdge: 1920, formats: ['.mp4', '.webm'], maxImages: 0 });
  assert.ok(Object.isFrozen(alephEdit.ASSUMPTIONS) && Object.isFrozen(alephEdit.LIMITS));
  // nothing else knows the limits: the node reads them from the table
  const model = nodesFal.EDIT_MODELS.runway_aleph;
  assert.equal(model.name, 'Runway Aleph 2.0');
  assert.equal(model.openrouter, true);
  assert.equal(model.maxSeconds, alephEdit.LIMITS.maxSeconds);
  assert.equal(model.minSeconds, alephEdit.LIMITS.minSeconds);
  assert.equal(model.maxBytes, alephEdit.LIMITS.maxBytes);
  assert.equal(model.maxImages, 0);
  // the request shape
  assert.deepEqual(plain(alephEdit.videoReference('https://example.test/v.mp4')), { type: 'video_url', video_url: { url: 'https://example.test/v.mp4' } });
  assert.deepEqual(plain(alephEdit.requestExtras()), {});
  // the price: per second, never below the minimum
  for (const [seconds, usd] of [[1, 0.56], [2, 0.56], [2.5, 0.7], [3, 0.84], [10, 2.8], [30, 8.4]]) near(alephEdit.priceFor(seconds), usd, `${seconds} s`);
  near(alephEdit.priceFor(1, { perSecondUsd: 0.3, minimumUsd: 0.6 }), 0.6, 'the numbers of the live list');
  near(alephEdit.priceFor(5, { perSecondUsd: 0.3, minimumUsd: 0.6 }), 1.5);
  assert.equal(alephEdit.priceFor(0), null);
  assert.equal(alephEdit.priceFor(NaN), null);
  console.log('   ok testAssumptionTable');
}

/* ---------- the node ---------- */

async function main() {
  testAssumptionTable();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-aleph-edit-'));
  const sessions = [];
  try {
    const session = await store.createSession();
    sessions.push(session.id);
    const sessionId = session.id;
    const registry = createRegistry();
    nodesBasic.registerAll(registry);
    nodesFal.registerAll(registry);
    const def = registry.get(TYPE);
    const normalised = (rawParams) => registry.normalizeParams(def, rawParams);

    /* ----- fakes ----- */
    const realBinaries = ffmpeg.binaries();
    const payloads = [];
    const published = [];
    const removed = [];
    const cuts = [];
    let jobCounter = 0;
    let createVideoError = null;
    withEnv('PUBLIC_BASE_URL', 'https://example.test');
    patch(or, 'hasKey', () => true);
    patch(or, 'listVideoModels', async () => CATALOG);
    patch(discovery, 'listVideoModels', async () => CATALOG);
    patch(discovery, 'listImageModels', async () => ({ data: [] }));
    discovery.resetVideoModelCache();
    videoNodeModels.reset();
    patch(or, 'createVideo', async (payload) => {
      payloads.push(JSON.parse(JSON.stringify(payload)));
      if (createVideoError) throw createVideoError;
      jobCounter += 1;
      return { id: `aleph-job-${jobCounter}`, status: 'pending' };
    });
    patch(publicrefs, 'publishAsset', async (_session, assetId) => {
      published.push({ asset: assetId });
      return { url: `https://example.test/refs/${assetId}.mp4`, file: `${assetId}.mp4` };
    });
    patch(publicrefs, 'publishFile', async (_session, file) => {
      published.push({ file: path.basename(file) });
      return { url: `https://example.test/refs/${path.basename(file)}`, file: path.basename(file) };
    });
    patch(publicrefs, 'removeRef', async (file) => {
      removed.push(file);
      return true;
    });
    const probes = new Map();
    patch(ffmpeg, 'binaries', () => ({ available: true, ffmpeg: realBinaries.ffmpeg || 'ffmpeg', ffprobe: realBinaries.ffprobe || 'ffprobe' }));
    patch(ops, 'probeMedia', async (file) => {
      const probe = probes.get(path.basename(file));
      if (!probe) throw new Error('unreadable file');
      return probe;
    });
    patch(ffmpeg, 'runProcess', async (_command, args) => {
      cuts.push(args.slice());
      await fsp.writeFile(args[args.length - 1], 'cut video');
      return { stdout: '', stderr: '' };
    });

    let assetCounter = 0;
    async function media(kind, ext, { duration, width = 0, height = 0, size } = {}) {
      assetCounter += 1;
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.from(`data${assetCounter}`), ext, prompt: 'seed' });
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
    const video = (options = {}) => media('video', '.mp4', { duration: 10, width: 1280, height: 720, ...options });
    const image = (options = {}) => media('image', '.png', { width: 1024, height: 1024, ...options });

    const logs = [];
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
        log: (line) => logs.push(line),
        waitForJob: async (job) => {
          await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), 0.84);
          await store.mutateSession(sessionId, (s) => {
            const target = s.jobs.find((entry) => entry.assetId === job.assetId);
            target.status = 'completed';
            target.resultAssetIds = [job.assetId];
          });
          return [job.assetId];
        },
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn()
      };
    };
    const reset = () => {
      payloads.length = 0;
      published.length = 0;
      removed.length = 0;
      cuts.length = 0;
      logs.length = 0;
      createVideoError = null;
    };
    const run = (inputs, rawParams = {}) => def.execute(ctx(), inputs, normalised({ model: 'runway_aleph', ...rawParams }));
    const plan = (inputs, rawParams = {}) => nodesFal.planVideoEdit(ctx(), inputs, normalised({ model: 'runway_aleph', ...rawParams }));
    const prompt = textValue('Make it snow');
    const jobsNow = async () => (await store.readSession(sessionId)).jobs;
    const scratchLeftovers = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith(assets.SCRATCH_PREFIX));

    async function refused(inputs, rawParams, code, { data, message } = {}) {
      reset();
      const jobs = (await jobsNow()).length;
      const error = await run(inputs, rawParams).catch((err) => err);
      assert.ok(error instanceof Error, `${code}: refused`);
      if (code) assert.equal(error.code, code, `${code}: ${error.message}`);
      if (data) for (const [key, value] of Object.entries(data)) assert.deepEqual(error.data[key], value, `${code}.${key}`);
      if (message) assert.match(error.message, message);
      assert.equal(payloads.length, 0, `${code}: the provider was not called`);
      assert.equal(published.length, 0, `${code}: nothing published`);
      assert.equal((await jobsNow()).length, jobs, `${code}: no job`);
      assert.deepEqual(await scratchLeftovers(), [], `${code}: no scratch folder left`);
      return error;
    }

    /* ----- definition ----- */
    {
      const model = def.params.find((param) => param.id === 'model');
      assert.deepEqual(model.options, ['kling_o3', 'wan_replace', 'gemini_omni', 'runway_aleph']);
      assert.equal(model.default, 'kling_o3');
      assert.deepEqual(plain(def.params.find((param) => param.id === 'in_parts').showIf), { param: 'model', in: ['kling_o3', 'gemini_omni', 'runway_aleph'] });
      assert.equal(typeof def.available, 'function');
      // the node is usable with the OpenRouter key alone (without a fal key) and with fal alone
      const fal = require('../lib/fal');
      patch(fal, 'hasKey', () => false);
      assert.equal(def.available(), true, 'OpenRouter key and ffmpeg');
      patch(or, 'hasKey', () => false);
      assert.equal(def.available(), 'FAL_KEY is not set', 'no key at all: the reason is given');
      patch(fal, 'hasKey', () => true);
      assert.equal(def.available(), true, 'fal key and ffmpeg');
      patch(or, 'hasKey', () => true);
      // validation: images are refused before the run, the address of the server is a warning
      const issues = (rawParams, ports) => def.validate(normalised({ model: 'runway_aleph', prompt: 'x', ...rawParams }), ports);
      const codes = (list) => list.map((issue) => issue.code);
      assert.deepEqual(codes(issues({}, { images: { connected: true, count: 1 } })), ['VIDEO_EDIT_ALEPH_IMAGES']);
      assert.deepEqual(plain(issues({}, { images: { connected: true, count: 1 } })[0].data), { model: 'Runway Aleph 2.0' });
      assert.deepEqual(codes(issues({}, {})), []);
      assert.deepEqual(codes(issues({ prompt: '' }, {})), ['VIDEO_EDIT_PROMPT_REQUIRED']);
      assert.deepEqual(codes(issues({ prompt: '' }, { prompt: { connected: true, count: 1 } })), []);
      withEnv('PUBLIC_BASE_URL', undefined);
      assert.deepEqual(codes(issues({}, {})), ['public_base_url']);
      assert.equal(issues({}, {})[0].level, 'warning');
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      // the other models do not ask for the address
      assert.deepEqual(codes(def.validate(normalised({ model: 'gemini_omni', prompt: 'x' }), {})), []);
    }

    /* ----- price ----- */
    {
      // the constants (the list is not read yet)
      videoNodeModels.reset();
      for (const [seconds, usd] of [[1, 0.56], [2, 0.56], [3, 0.84], [10, 2.8]]) {
        near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: seconds } } }), usd, `${seconds} s`);
      }
      near(nodesFal.videoEditPlanUsd(normalised({ model: 'runway_aleph' }), { inputs: {} }), 0.28 * 30.05, 'no video known: the longest one');
      // longer than the limit without the cut: the whole length is the price asked (the run is refused later)
      near(def.cost.estimate(normalised({ model: 'runway_aleph', cut_to_limit: true }), { inputs: { video: { type: 'video', duration: 60 } } }), 0.28 * 30, 'cut to 30 s');
      // the live list wins: another price of the provider
      patch(discovery, 'listVideoModels', async () => ({
        data: [{ ...CATALOG.data[0], pricing_skus: { cents_per_second_output: '30', minimum_cents_per_generation: '60' } }]
      }));
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 1 } } }), 0.6, 'the minimum of the list');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 3 } } }), 0.9, 'the price of the list');
      patch(discovery, 'listVideoModels', async () => CATALOG);
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 3 } } }), 0.84, 'back to 0.28 per second');
      // the node does not change the price of the other models
      near(def.cost.estimate(normalised({}), { inputs: { video: { type: 'video', duration: 8 } } }), 1.12, 'Kling O3: 8 s at 0.14');
    }

    /* ----- a run: the request ----- */
    {
      reset();
      const source = await video({ duration: 3 });
      const outcome = await run({ video: source, prompt }, {});
      assert.equal(payloads.length, 1);
      assert.deepEqual(payloads[0], {
        model: ALEPH,
        prompt: 'Make it snow',
        input_references: [{ type: 'video_url', video_url: { url: `https://example.test/refs/${source.assetId}.mp4` } }]
      });
      for (const field of ['duration', 'resolution', 'aspect_ratio', 'frame_images', 'generate_audio', 'seed']) assert.equal(field in payloads[0], false, `no ${field}`);
      assert.deepEqual(published, [{ asset: source.assetId }]);
      assert.equal(outcome.variants.length, 1);
      assert.equal(outcome.variants[0].video.type, 'video');
      near(outcome.cost.usd, 0.84, 'the cost of the run is the one the provider booked');
      // the job record: the model, the estimate (the price of 3 s), the address that is removed when the job is over
      const job = (await jobsNow()).slice(-1)[0];
      assert.equal(job.mode, 'video_edit');
      assert.equal(job.model, ALEPH);
      assert.equal(job.modelName, 'Runway Aleph 2.0');
      near(job.estimateUsd, 0.84);
      assert.deepEqual(job.publicRefFiles, [`${source.assetId}.mp4`]);
      assert.equal('partKey' in job, false, 'a single run has no part key');
      // the prompt is sent as written: Aleph knows no @-names, nothing is translated
      reset();
      await run({ video: await video({ duration: 3 }), prompt: textValue('Replace the Bild 1 in the video') }, {});
      assert.equal(payloads[0].prompt, 'Replace the Bild 1 in the video');
      // 2 s is the shortest video
      reset();
      await run({ video: await video({ duration: 2 }), prompt: textValue('Make it night') }, {});
      assert.equal(payloads[0].prompt, 'Make it night');
      near((await jobsNow()).slice(-1)[0].estimateUsd, 0.56, '2 s: the minimum');
      // 1 s is too short (below the 2 s of the table)
    }

    /* ----- the minimum in the plan ----- */
    {
      reset();
      near((await plan({ video: await video({ duration: 2 }), prompt })).estimateUsd, 0.56, '2 s');
      near((await plan({ video: await video({ duration: 3 }), prompt })).estimateUsd, 0.84, '3 s');
      near((await plan({ video: await video({ duration: 12.5 }), prompt })).estimateUsd, 3.5, '12.5 s');
      const planned = await plan({ video: await video({ duration: 5 }), prompt });
      assert.ok(planned.openrouter, 'the OpenRouter way');
      assert.equal(planned.endpoint, undefined, 'no fal endpoint');
      assert.equal(planned.openrouter.model, ALEPH);
      assert.equal(planned.cleanup, null);
    }

    /* ----- refused before anything is paid ----- */
    {
      const ok = await video({ duration: 5 });
      await refused({ video: await video({ duration: 1 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SHORT', { data: { model: 'Runway Aleph 2.0', min: 2, found: 1 } });
      await refused({ video: await video({ duration: 31 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Runway Aleph 2.0', max: 30, found: 31 } });
      await refused({ video: await video({ duration: 5, size: 17 * MB }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_HEAVY');
      await refused({ video: await video({ duration: 5, width: 3840, height: 2160 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LARGE');
      await refused({ video: ok }, {}, 'VIDEO_EDIT_PROMPT_REQUIRED');
      // the images: refused while the way for them is not confirmed (per live test)
      await refused({ video: ok, prompt, images: { type: 'list', of: 'image', items: [await image()] } }, {}, 'VIDEO_EDIT_ALEPH_IMAGES', { data: { model: 'Runway Aleph 2.0' } });
      // a format the app cannot hand over
      const mov = await media('video', '.mov', { duration: 5, width: 1280, height: 720 }).catch(() => null);
      if (mov) await refused({ video: mov, prompt }, {}, 'VIDEO_EDIT_VIDEO_FORMAT');
      // the key and the address
      patch(or, 'hasKey', () => false);
      await refused({ video: ok, prompt }, {}, undefined, { message: /OPENROUTER_API_KEY is not set/ });
      patch(or, 'hasKey', () => true);
      withEnv('PUBLIC_BASE_URL', undefined);
      await refused({ video: ok, prompt }, {}, 'VIDEO_EDIT_PUBLIC_URL', { data: { model: 'Runway Aleph 2.0' } });
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      // 4 reference images are fine for Kling O3, and the fal key is not asked for Aleph: a fal key that is gone does not stop Aleph
      const fal = require('../lib/fal');
      patch(fal, 'hasKey', () => false);
      reset();
      await run({ video: ok, prompt }, {});
      assert.equal(payloads.length, 1, 'Aleph runs without a fal key');
      // ... and the fal models still ask for theirs
      await assert.rejects(def.execute(ctx(), { video: ok, prompt }, normalised({ model: 'kling_o3' })), /FAL_KEY/);
      patch(fal, 'hasKey', () => true);
    }

    /* ----- Cut to the allowed length ----- */
    {
      reset();
      const long = await video({ duration: 45, width: 1280, height: 720 });
      const plain30 = await plan({ video: long, prompt }, { cut_to_limit: true });
      near(plain30.estimateUsd, 0.28 * 30, 'the price of the first 30 s');
      assert.equal(plain30.trimmed, true);
      assert.equal(typeof plain30.cleanup, 'function');
      assert.ok(plain30.openrouter.videoFile && !plain30.openrouter.videoAssetId, 'the cut file is sent, not the asset');
      assert.ok(fs.existsSync(plain30.openrouter.videoFile));
      assert.equal(cuts[0][cuts[0].indexOf('-t') + 1], '29.95', `ffmpeg cuts to the limit less the slack: ${cuts[0].join(' ')}`);
      await plain30.cleanup();
      assert.deepEqual(await scratchLeftovers(), [], 'the plan left nothing behind after cleanup');
      // a run: the cut file is published and the scratch folder is removed afterwards
      reset();
      const outcome = await run({ video: long, prompt }, { cut_to_limit: true });
      assert.equal(payloads.length, 1);
      assert.equal(published.length, 1);
      assert.ok(published[0].file, 'a file (the cut), not an asset');
      assert.equal(payloads[0].input_references[0].video_url.url, `https://example.test/refs/${published[0].file}`);
      assert.equal(outcome.variants[0].video.type, 'video');
      assert.deepEqual(await scratchLeftovers(), []);
      near((await jobsNow()).slice(-1)[0].estimateUsd, 8.4, '30 s');
    }

    /* ----- the provider refuses ----- */
    {
      reset();
      createVideoError = new or.OpenRouterError('OpenRouter 400: HTTP 400: {"error":{"message":"bad request"}}', { status: 400 });
      const jobs = (await jobsNow()).length;
      const source = await video({ duration: 4 });
      const error = await run({ video: source, prompt }, {}).catch((err) => err);
      assert.match(error.message, /bad request/);
      assert.equal((await jobsNow()).length, jobs, 'no job is left');
      assert.deepEqual(removed, [`${source.assetId}.mp4`], 'the public address is taken back');
      // no asset stays reserved for the refused job
      const reserved = (await store.readLedger(sessionId)).filter((entry) => entry.pending === true && entry.kind === 'video');
      assert.deepEqual(reserved.filter((entry) => entry.prompt === 'Make it snow'), []);
    }

    /* ----- the tool ----- */
    {
      assert.ok(tools.NODE_ONLY_TOOLS ? tools.NODE_ONLY_TOOLS.has('edit_video_openrouter') : true);
      const names = tools.toolDefinitions({ active: false, admin: true }).map((entry) => entry.function.name);
      assert.equal(names.includes('edit_video_openrouter'), false, 'a node-only tool is not offered to the chat');
      reset();
      const toolCtx = { nodeView: true, sessionId, config: {}, user: 'tester', emit() {} };
      const call = (args) => tools.executeTool(toolCtx, 'edit_video_openrouter', args);
      const source = await video({ duration: 4 });
      await assert.rejects(call({ model: 'other/model', prompt: 'x', video_asset_id: source.assetId }), /kein Videobearbeitungsmodell/);
      await assert.rejects(call({ model: ALEPH, prompt: '', video_asset_id: source.assetId }), /prompt fehlt/);
      await assert.rejects(call({ model: ALEPH, prompt: 'x' }), /Genau eines/);
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_asset_id: source.assetId, video_file: '/x.mp4' }), /Genau eines/);
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_asset_id: source.assetId, estimateUsd: -1 }), /estimateUsd/);
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_asset_id: 'no-such-asset' }), /./);
      // not from the chat
      await assert.rejects(tools.executeTool({ sessionId, config: {}, user: 'tester', emit() {} }, 'edit_video_openrouter', { model: ALEPH, prompt: 'x', video_asset_id: source.assetId }), /./);
      assert.equal(payloads.length, 0);
      // a file outside the folder of the session is not published
      const outside = path.join(tmpDir, 'outside.mp4');
      await fsp.writeFile(outside, 'x');
      await assert.rejects(publicrefsReal.publishFile(sessionId, outside), /./);
    }
  } finally {
    restoreAll();
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // the texts of the codes of the model
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  for (const lang of ['de', 'en', 'es']) {
    for (const key of ['nodes.issue.VIDEO_EDIT_ALEPH_IMAGES', 'nodes.issue.VIDEO_EDIT_PUBLIC_URL', 'nodes.option.runway_aleph']) {
      assert.ok(window.I18N[lang][key], `${lang}: ${key}`);
    }
    assert.match(window.I18N[lang]['nodes.option.runway_aleph'], /Runway Aleph 2\.0/);
    assert.match(window.I18N[lang]['nodes.type.fal.video_edit.tip.3'], /0\.28/, `${lang}: the price of Aleph is in the help`);
  }
  console.log('test-aleph-edit.js: ok');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
