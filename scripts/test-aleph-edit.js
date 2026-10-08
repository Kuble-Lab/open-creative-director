'use strict';

// Runway Aleph 2.0 as a model of the node "Edit video with references" (fal.video_edit, WP41), through OpenRouter. A fake OpenRouter
// and a fake ffmpeg: nothing is paid and nothing leaves the machine.
//   - everything the app ASSUMES about the model stands in lib/nodes/aleph-edit.js ("per live test"): the table is read here, so a
//     change of an assumption shows up in this test
//   - the request: model, prompt and the video in input_references (video_url); no duration, no resolution, no aspect ratio, no frames
//   - the price: 0.28 USD per second and OpenRouter bills at least 5 s (live tests 2026-10-04: videos of 3 s and of 8 s each cost 1.40 USD), so
//     a run costs at least 1.40 USD (2 s and 3 s = 1.40) and a longer video is planned by its length as an upper bound (8 s = 2.24, 10 s =
//     2.80); the live list and the constants give the same price; the reservation of a run is never below it
//   - the checks before the run: length (2 to 30 s per run), format, size, no images, prompt, the keys and the address of the server
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
const access = require('../lib/access');
const budget = require('../lib/budget');
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
const editParts = require('../lib/nodes/video-edit-parts');
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
  assert.equal(alephEdit.FACTS.billedMinimumSeconds, 5, 'the live tests billed 3 s and 8 s as 5 s');
  assert.match(alephEdit.FACTS.fetched, /^\d{4}-\d{2}-\d{2}$/);
  // the assumptions: one place, every one of them named as such in the file
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'aleph-edit.js'), 'utf8');
  assert.ok((source.match(/per live test/g) || []).length >= 6, 'every assumption is marked "per live test"');
  assert.deepEqual(plain(alephEdit.ASSUMPTIONS.formats), ['.mp4', '.webm']);
  assert.equal(alephEdit.ASSUMPTIONS.imagesSupported, false);
  assert.equal(alephEdit.ASSUMPTIONS.videoReferenceType, 'video_url');
  // maxSeconds is 30 (the figure of the providers of the model). It was 5 for a few hours of 2026-10-04, after the first live test (only a
  // video of 3 s had been tried); the control run with a video of 8 s came back whole, so the limit went back to 30.
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
  // the price: per second of at least 5 billed seconds, never below the minimum. Changed after the live test of 2026-10-04: this was
  // [[1, 0.56], [2, 0.56], [2.5, 0.7], [3, 0.84], ...] (the list's minimum of 0.56 for a short run); a video of 3 s was billed 1.40 USD.
  // Above 5 s the length counts, an upper bound: the control run billed a video of 8 s 1.40 USD, the price says 2.24 (8 x 0.28), so that the
  // reservation is never too low if OpenRouter starts to bill by length.
  for (const [seconds, usd] of [[1, 1.4], [2, 1.4], [2.5, 1.4], [3, 1.4], [4.95, 1.4], [5, 1.4], [5.04, 1.4112], [8, 2.24], [10, 2.8], [30, 8.4]]) near(alephEdit.priceFor(seconds), usd, `${seconds} s`);
  assert.equal(alephEdit.billedSeconds(3), 5);
  assert.equal(alephEdit.billedSeconds(5), 5);
  assert.equal(alephEdit.billedSeconds(7.5), 7.5, 'a longer video is billed by its length');
  assert.equal(alephEdit.billedSeconds(8), 8);
  near(alephEdit.priceFor(1, { perSecondUsd: 0.1, minimumUsd: 0.6 }), 0.6, 'never below the minimum of the live list (5 s x 0.10 = 0.50)');
  near(alephEdit.priceFor(1, { perSecondUsd: 0.3, minimumUsd: 0.6 }), 1.5, 'the numbers of the live list, 5 billed seconds');
  near(alephEdit.priceFor(5, { perSecondUsd: 0.3, minimumUsd: 0.6 }), 1.5);
  assert.equal(alephEdit.priceFor(0), null);
  assert.equal(alephEdit.priceFor(NaN), null);
  // The key of a part (nodes-fal.js planEditParts): a paid part of an earlier run is found by it, so the fields, their values and their
  // order must not change when another model joins the node (test-video-edit-parts.js derives the key of a real plan from the same fields).
  // A fixed part of Aleph has this key since WP41.
  assert.equal(
    editParts.partKey({ via: 'openrouter', target: ALEPH, input: { prompt: 'Make it snow' }, media: [], source: 'vid-fixed-1', rate: '30', longest: 30, from: 0, frames: 803 }),
    'ep1-931161f08d3b0a4c6b8bddc738254553'
  );
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
      assert.deepEqual(model.options, ['kling_o3', 'wan_replace', 'gemini_omni', 'runway_aleph', 'flux_video_edit'], 'FLUX Video Edit comes after Aleph (test-flux-video-edit.js)');
      assert.equal(model.default, 'kling_o3');
      assert.deepEqual(plain(def.params.find((param) => param.id === 'in_parts').showIf), { param: 'model', in: ['kling_o3', 'gemini_omni', 'runway_aleph', 'flux_video_edit'] });
      assert.equal(typeof def.available, 'function');
      // the description (node library, assistant) is written from the table: the longest run and the least a run costs
      assert.match(def.description, /Runway Aleph 2\.0: [^.]*one run takes 30 s at the most and costs at least 1\.40 USD \(OpenRouter bills at least 5 s\)/);
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
      // the constants (the list is not read yet). Changed after the live test of 2026-10-04: 1 s, 2 s and 3 s were 0.56, 0.56 and 0.84;
      // OpenRouter billed a video of 3 s with 1.40 USD (5 s x 0.28), so nothing is priced under 5 s
      videoNodeModels.reset();
      for (const [seconds, usd] of [[1, 1.4], [2, 1.4], [3, 1.4], [5, 1.4], [8, 2.24], [10, 2.8]]) {
        near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: seconds } } }), usd, `${seconds} s`);
      }
      near(nodesFal.videoEditPlanUsd(normalised({ model: 'runway_aleph' }), { inputs: {} }), 0.28 * 30.05, 'no video known: the longest one (30 s and the slack)');
      // longer than the limit without the cut: the whole length is the price asked (the run is refused later)
      near(def.cost.estimate(normalised({ model: 'runway_aleph', cut_to_limit: true }), { inputs: { video: { type: 'video', duration: 60 } } }), 0.28 * 30, 'cut to 30 s');
      // the live list wins: another price of the provider; the billed seconds are the same way
      patch(discovery, 'listVideoModels', async () => ({
        data: [{ ...CATALOG.data[0], pricing_skus: { cents_per_second_output: '30', minimum_cents_per_generation: '60' } }]
      }));
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 1 } } }), 1.5, 'the price of the list, 5 billed seconds');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 3 } } }), 1.5, 'the price of the list, 5 billed seconds');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 8 } } }), 2.4, 'the price of the list, 8 s: by its length');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 10 } } }), 3, 'the price of the list, 10 s');
      // a list with a low price per second and a minimum per generation above 5 s of it: the minimum of the list still counts
      patch(discovery, 'listVideoModels', async () => ({
        data: [{ ...CATALOG.data[0], pricing_skus: { cents_per_second_output: '10', minimum_cents_per_generation: '60' } }]
      }));
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 3 } } }), 0.6, 'the minimum of the list');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 10 } } }), 1, 'the price of the list, 10 s');
      patch(discovery, 'listVideoModels', async () => CATALOG);
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      // the list of OpenRouter as it was read (28 and 56) and the constants (the list is not loaded) give the same price for the same
      // run: 3 s are 1.40 USD both ways (before: the list gave the minimum 0.84 for 3 s and 0.56 for 2 s, the constants the same)
      const planFromList = [1, 2, 3, 4.95, 5, 5.04, 7, 8].map((seconds) => def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: seconds } } }));
      near(planFromList[2], 1.4, 'back to 0.28 per second: 3 s');
      videoNodeModels.reset();
      const planFromConstants = [1, 2, 3, 4.95, 5, 5.04, 7, 8].map((seconds) => def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: seconds } } }));
      assert.deepEqual(planFromList, planFromConstants, 'the same seconds are billed with the live list and without it');
      near(planFromConstants[0], 1.4, '1 s');
      near(planFromConstants[5], 1.4112, '5.04 s is billed by its length');
      near(planFromConstants[6], 1.96, '7 s');
      near(planFromConstants[7], 2.24, '8 s: planned by its length (8 x 0.28), although the control run was billed 1.40 USD');
      await videoNodeModels.load();
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
      // byte for byte, the order of the keys included (model, prompt, the extra fields of the model: none, input_references): what the live tests of
      // 2026-10-04 sent. The request is built for every model of the tool edit_video_openrouter from one place; this line keeps Aleph's as it was.
      assert.equal(JSON.stringify(payloads[0]), `{"model":"runway/aleph-2","prompt":"Make it snow","input_references":[{"type":"video_url","video_url":{"url":"https://example.test/refs/${source.assetId}.mp4"}}]}`);
      assert.deepEqual(published, [{ asset: source.assetId }]);
      assert.equal(outcome.variants.length, 1);
      assert.equal(outcome.variants[0].video.type, 'video');
      near(outcome.cost.usd, 0.84, 'the cost of the run is the one the provider booked (the fake books what it likes)');
      // the job record: the model, the estimate (the price of 3 s: 5 billed seconds, as in the live test), the address that is removed when the job is over
      const job = (await jobsNow()).slice(-1)[0];
      assert.equal(job.mode, 'video_edit');
      assert.equal(job.model, ALEPH);
      assert.equal(job.modelName, 'Runway Aleph 2.0');
      near(job.estimateUsd, 1.4, 'the estimate of the job is what the live test was billed for 3 s (it was 0.84 before)');
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
      near((await jobsNow()).slice(-1)[0].estimateUsd, 1.4, '2 s: billed as 5 s (was 0.56)');
      // 1 s is too short (below the 2 s of the table)
      // 8 s is ONE run (the control run of 2026-10-04): sent as it is, the request without a duration, the estimate of the job is the price by
      // its length (2.24 USD, 8 x 0.28), the upper bound, although the control run was billed 1.40 USD
      reset();
      const eight = await video({ duration: 8 });
      await run({ video: eight, prompt }, {});
      assert.equal(payloads.length, 1, 'one request for the whole video');
      assert.deepEqual(payloads[0], {
        model: ALEPH,
        prompt: 'Make it snow',
        input_references: [{ type: 'video_url', video_url: { url: `https://example.test/refs/${eight.assetId}.mp4` } }]
      });
      assert.equal(cuts.length, 0, 'not cut');
      near((await jobsNow()).slice(-1)[0].estimateUsd, 2.24, '8 s: the price by its length');
    }

    /* ----- the billed minimum in the plan ----- */
    {
      reset();
      // Changed after the live test of 2026-10-04: 2 s and 3 s were 0.56 and 0.84. A run is billed for 5 s at least (3 s cost 1.40 USD). Above
      // 5 s the length counts, an upper bound (the control run billed 8 s 1.40 USD, the plan says 2.24); 12.5 s was 3.50 before and is again.
      near((await plan({ video: await video({ duration: 2 }), prompt })).estimateUsd, 1.4, '2 s');
      near((await plan({ video: await video({ duration: 3 }), prompt })).estimateUsd, 1.4, '3 s: what the first live test was billed');
      near((await plan({ video: await video({ duration: 4.5 }), prompt })).estimateUsd, 1.4, '4.5 s');
      near((await plan({ video: await video({ duration: 5 }), prompt })).estimateUsd, 1.4, '5 s');
      near((await plan({ video: await video({ duration: 5.04 }), prompt })).estimateUsd, 0.28 * 5.04, '5.04 s: the slack of the length, billed by its length');
      near((await plan({ video: await video({ duration: 8 }), prompt })).estimateUsd, 2.24, '8 s: by its length (8 x 0.28), 1.40 USD in the control run');
      near((await plan({ video: await video({ duration: 12.5 }), prompt })).estimateUsd, 3.5, '12.5 s');
      near((await plan({ video: await video({ duration: 30 }), prompt })).estimateUsd, 8.4, '30 s: the longest run');
      const planned = await plan({ video: await video({ duration: 5 }), prompt });
      assert.ok(planned.openrouter, 'the OpenRouter way');
      assert.equal(planned.endpoint, undefined, 'no fal endpoint');
      assert.equal(planned.openrouter.model, ALEPH);
      assert.equal(planned.cleanup, null);
    }

    /* ----- the reservation is never below what is billed ----- */
    {
      // a participant's call reserves the estimate of the node (executeTool -> budget.begin): the price of the billed seconds
      const begun = [];
      patch(access, 'viewerOf', () => ({ active: true, kind: 'participant', email: 'p@example.test' }));
      patch(budget, 'begin', async (_viewer, options) => {
        begun.push(options.estimateUsd);
        return budget.NOOP_GRANT;
      });
      reset();
      await run({ video: await video({ duration: 3 }), prompt }, {});
      assert.deepEqual(begun, [1.4], 'the reservation of a run of 3 s is 1.40 USD, the billed price (it was 0.84)');
      begun.length = 0;
      await run({ video: await video({ duration: 2 }), prompt }, {});
      assert.deepEqual(begun, [1.4]);
      begun.length = 0;
      await run({ video: await video({ duration: 8 }), prompt }, {});
      assert.deepEqual(begun, [2.24], 'a run of 8 s reserves 2.24 USD, the price by its length: never below the bill, whichever way OpenRouter bills');
      begun.length = 0;
      await run({ video: await video({ duration: 45 }), prompt }, { cut_to_limit: true });
      assert.deepEqual(begun, [8.4], 'cut to the first 30 s: the price of the limit (the cut file is 29.95 s)');
      // the budget stops a run that does not fit before anything is started: 1.40 does not fit 1.00
      patch(budget, 'begin', async (viewer, options) => {
        if (options.estimateUsd > 1) throw new budget.BudgetError('BUDGET_INSUFFICIENT', 'not enough', 'nicht genug', { estimateUsd: options.estimateUsd });
        return budget.NOOP_GRANT;
      });
      reset();
      const error = await run({ video: await video({ duration: 3 }), prompt }, {}).catch((err) => err);
      assert.equal(error.code, 'BUDGET_INSUFFICIENT');
      assert.equal(error.estimateUsd, 1.4);
      assert.equal(payloads.length, 0, 'the provider was not called');
      restorers.pop()();
      restorers.pop()();
      restorers.pop()();
    }

    /* ----- refused before anything is paid ----- */
    {
      const ok = await video({ duration: 5 });
      await refused({ video: await video({ duration: 1 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SHORT', { data: { model: 'Runway Aleph 2.0', min: 2, found: 1 } });
      // One run takes 30 s at the most: just over the slack and well over are refused. (From the first live test of 2026-10-04 until the control
      // run the limit was 5 s, and 6 s, 5.06 s and 31 s were refused with max 5.)
      await refused({ video: await video({ duration: 30.06 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Runway Aleph 2.0', max: 30, found: 30.1 } });
      await refused({ video: await video({ duration: 31 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Runway Aleph 2.0', max: 30, found: 31 } });
      await refused({ video: await video({ duration: 45 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Runway Aleph 2.0', max: 30, found: 45 } });
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
      // The first 30 s (8.40 USD). From the first live test of 2026-10-04 until the control run they were the first 5 s (1.40 USD).
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
      // the cut file is a little under the limit (29.95 s): the price asked is that of the limit, not of the cut file
      reset();
      const slightly = await video({ duration: 30.06, width: 1280, height: 720 });
      const cutSlightly = await plan({ video: slightly, prompt }, { cut_to_limit: true });
      assert.equal(cutSlightly.trimmed, true, 'just over the limit and the slack: cut');
      near(cutSlightly.estimateUsd, 8.4);
      await cutSlightly.cleanup();
      // a video within the slack (30.04 s) is sent as it is, with or without the switch, and priced by its length
      reset();
      const within = await video({ duration: 30.04, width: 1280, height: 720 });
      const asIs = await plan({ video: within, prompt }, { cut_to_limit: true });
      assert.equal(asIs.trimmed, false);
      assert.equal(cuts.length, 0, 'not cut');
      near(asIs.estimateUsd, 0.28 * 30.04);
      // a video under the limit is not cut either, and the switch changes nothing in its price
      reset();
      const under = await plan({ video: await video({ duration: 8, width: 1280, height: 720 }), prompt }, { cut_to_limit: true });
      assert.equal(under.trimmed, false);
      assert.equal(cuts.length, 0, 'not cut');
      near(under.estimateUsd, 2.24, '8 s with the switch on');
      // the node price of the graph with the switch: the first 30 s whatever the length
      for (const seconds of [31, 45, 120, 600]) near(def.cost.estimate(normalised({ model: 'runway_aleph', cut_to_limit: true }), { inputs: { video: { type: 'video', duration: seconds } } }), 8.4, `${seconds} s cut to 30 s`);
      // "in parts" wins over the cut (the plan of the whole video: test-video-edit-parts.js); here the node without the allowance for parts
      // (planVideoEdit without allowParts, as the plan of a single run) still cuts
      reset();
      const withParts = await plan({ video: long, prompt }, { cut_to_limit: true, in_parts: true });
      assert.equal(withParts.trimmed, true, 'without allowParts the plan of a single run is the cut');
      await withParts.cleanup();
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
      // the tool takes a file only from a scratch folder of the session and only a video (defence in depth, review)
      const folder = store.sessionAssetDir(sessionId);
      const inFolder = path.join(folder, 'loose.mp4');
      await fsp.writeFile(inFolder, 'x');
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_file: inFolder }), /Arbeitsordner/, 'a file of the asset folder that no node cut');
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_file: outside }), /Arbeitsordner/);
      const scratchFolder = await assets.createScratchDir(sessionId);
      await fsp.writeFile(path.join(scratchFolder, 'secret.json'), '{}');
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_file: path.join(scratchFolder, 'secret.json') }), /MP4 oder WebM/, "not a video");
      await assert.rejects(call({ model: ALEPH, prompt: 'x', video_file: path.join(scratchFolder, '..', 'loose.mp4') }), /Arbeitsordner/, 'no way out of the folder');
      await assets.removeScratchDir(scratchFolder);
      await fsp.rm(inFolder, { force: true });
      assert.equal(payloads.length, 0);
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
    // Added after the live test of 2026-10-04: the least a run costs, and the longest run, are in the help. The longest run is 30 s again after
    // the control run (for a few hours it was 5 s, and these lines demanded 5 s and no 30).
    assert.match(window.I18N[lang]['nodes.type.fal.video_edit.tip.3'], /1\.40/, `${lang}: the least a run costs`);
    assert.match(window.I18N[lang]['nodes.type.fal.video_edit.tip.2'], /Aleph[^,]*\b30\b/, `${lang}: Aleph takes 30 s at the most`);
    assert.doesNotMatch(window.I18N[lang]['nodes.type.fal.video_edit.tip.2'], /Aleph[^,]*\b5\b/, `${lang}: ... and no longer 5 s`);
    const port = window.I18N[lang]['nodes.portdesc.fal.video_edit.video.in'];
    assert.match(port, /Runway Aleph 2\.0: [^.]*\b30 s/, `${lang}: the port names the 30 s of Aleph`);
    assert.doesNotMatch(port, /Runway Aleph 2\.0: [^.]*\b5 s/, `${lang}: ... and no longer 5 s`);
    assert.match(port, /\b3 s\b[^.]*\b8 s\b/, `${lang}: the port names what was tried (3 s and 8 s)`);
  }
  console.log('test-aleph-edit.js: ok');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
