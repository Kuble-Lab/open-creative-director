'use strict';

// FLUX Video Edit (black-forest-labs/flux-video-edit) as the fifth model of the node "Edit video with references" (fal.video_edit),
// through OpenRouter, next to Runway Aleph 2.0. A fake OpenRouter and a fake ffmpeg: nothing is paid and nothing leaves the machine.
//   - everything the app knows or ASSUMES about the model stands in lib/nodes/flux-video-edit.js (FACTS read on 2026-10-08 and measured by
//     the paid live test of the same day; ASSUMPTIONS marked "confirmed by the live test of 2026-10-08" or "per live test"): the table is
//     read here, so a change of an assumption shows up in this test
//   - the request: model, prompt and the video in input_references (video_url) like Aleph's, byte for byte; no duration, resolution,
//     aspect ratio, frames, sound or seed (the maker answers HTTP 422 to fields it does not know). This is the request the live test sent
//     and OpenRouter took without an error
//   - the price: 0.03 USD per second of the result, billed by its length with no minimum: the live test billed a clip of 3 s 0.09 USD, not
//     the 0.15 of a flat 5 s (Aleph's). So 3 s = 0.09, 5 s = 0.15, 8 s = 0.24, 15 s = 0.45, and a short clip is planned and reserved by its
//     length; the live list and the constants give the same price
//   - the checks before the run, with the limits of the model: 1 to 15 s, MP4 only, 50 MiB, 160 px on the smaller side and no largest side,
//     no images (never), a prompt of at most 4096 characters, the keys and the address of the server
//   - "Cut to the allowed length" cuts to 15 s (a cut file is published and removed afterwards)
//   - the job record carries the name of THIS model (and not Aleph's), the public address is removed when the provider refuses
//   - the tool edit_video_openrouter serves both models; Aleph's own request is pinned in test-aleph-edit.js
//   - the texts in German, English and Spanish: option, issues (every placeholder has a value), help, tips and port descriptions
// A long video in parts (15 s per run) needs the real ffmpeg: test-video-edit-parts.js.

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
const ffmpeg = require('../lib/ffmpeg');
const tools = require('../lib/tools');
const videoNodeModels = require('../lib/video-node-models');
const assets = require('../lib/nodes/assets');
const ops = require('../lib/nodes/ffmpeg-ops');
const alephEdit = require('../lib/nodes/aleph-edit');
const fluxEdit = require('../lib/nodes/flux-video-edit');
const editParts = require('../lib/nodes/video-edit-parts');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const { createRegistry } = require('../lib/nodes/registry');
const { textValue } = require('../lib/nodes/types');

const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');
const TYPE = 'fal.video_edit';
const FLUX = 'black-forest-labs/flux-video-edit';
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

// The entries of GET /videos/models as OpenRouter listed them on 2026-10-08 (reduced): the editor of the maker and Aleph.
const FLUX_ENTRY = {
  id: FLUX,
  name: 'Black Forest Labs: FLUX Video Edit',
  supported_resolutions: null,
  supported_aspect_ratios: null,
  supported_sizes: null,
  supported_durations: null,
  supported_frame_images: null,
  generate_audio: false,
  seed: false,
  pricing_skus: { cents_per_second_output: '3' },
  allowed_passthrough_parameters: ['safety_tolerance']
};
const ALEPH_ENTRY = {
  id: ALEPH,
  name: 'Runway: Aleph 2.0',
  generate_audio: false,
  supported_aspect_ratios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
  pricing_skus: { cents_per_second_output: '28', minimum_cents_per_generation: '56' }
};
const CATALOG = { data: [FLUX_ENTRY, ALEPH_ENTRY] };

/* ---------- the table of facts and assumptions ---------- */

function testAssumptionTable() {
  assert.equal(fluxEdit.MODEL, FLUX);
  assert.equal(fluxEdit.NAME, 'FLUX Video Edit');
  // the facts of the OpenRouter list and of the maker, with the day they were read
  near(fluxEdit.FACTS.perSecondUsd, 0.03);
  near(fluxEdit.FACTS.minimumUsd, 0);
  assert.equal(fluxEdit.FACTS.fetched, '2026-10-08');
  // measured by the live test of 2026-10-08 (a clip of 3 s, billed 0.09 USD = 3 s x 0.03): there is no minimum. Like Aleph's 5 s, a measured
  // number is a fact and no assumption; the 5 s that were taken from Aleph are gone from the assumptions
  assert.equal(fluxEdit.FACTS.billedMinimumSeconds, 0);
  assert.equal('billedMinimumSeconds' in fluxEdit.ASSUMPTIONS, false, 'the live test refuted the 5 s assumed from Aleph');
  // the assumptions: one place, every one of them marked in the file by the comment above it: proven by the live test of 2026-10-08 (the way
  // the video travels, the request without extra fields) or still "per live test" (the limits and the formats, which were not tried)
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'flux-video-edit.js'), 'utf8');
  const assumptionsSource = source.slice(source.indexOf('const ASSUMPTIONS'), source.indexOf('const LIMITS'));
  const marks = [...assumptionsSource.matchAll(/^ {2}\/\/ (confirmed by the live test of 2026-10-08|per live test)\b[^\n]*(?:\n {2}\/\/[^\n]*)*\n {2}(\w+):/gm)].map((match) => [match[2], match[1]]);
  assert.deepEqual(marks.map(([key]) => key), Object.keys(fluxEdit.ASSUMPTIONS), 'every assumption is marked in the comment above it');
  assert.deepEqual(Object.fromEntries(marks), {
    videoReferenceType: 'confirmed by the live test of 2026-10-08',
    extraFields: 'confirmed by the live test of 2026-10-08',
    minSeconds: 'per live test',
    maxSeconds: 'per live test',
    maxBytes: 'per live test',
    minEdge: 'per live test',
    maxPrompt: 'per live test',
    formats: 'per live test',
    aspectRatioChecked: 'per live test'
  });
  assert.equal(fluxEdit.ASSUMPTIONS.videoReferenceType, 'video_url');
  assert.deepEqual(plain(fluxEdit.ASSUMPTIONS.extraFields), {});
  assert.deepEqual(plain(fluxEdit.ASSUMPTIONS.formats), ['.mp4']);
  assert.equal(fluxEdit.ASSUMPTIONS.aspectRatioChecked, false);
  assert.deepEqual(plain(fluxEdit.LIMITS), { minSeconds: 1, maxSeconds: 15, maxBytes: 50 * MB, minEdge: 160, maxPrompt: 4096, formats: ['.mp4'], maxImages: 0 });
  assert.ok(Object.isFrozen(fluxEdit.ASSUMPTIONS) && Object.isFrozen(fluxEdit.LIMITS) && Object.isFrozen(fluxEdit.FACTS));
  assert.equal('maxEdge' in fluxEdit.LIMITS, false, 'no largest side: the maker scales a source over 720p down itself');
  // nothing else knows the limits: the node reads them from the table
  const model = nodesFal.EDIT_MODELS.flux_video_edit;
  assert.equal(model.name, 'FLUX Video Edit');
  assert.equal(model.openrouter, true);
  assert.equal(model.prompt, true);
  for (const key of ['minSeconds', 'maxSeconds', 'maxBytes', 'minEdge', 'maxPrompt']) assert.equal(model[key], fluxEdit.LIMITS[key], key);
  assert.equal(model.maxImages, 0);
  assert.equal(model.maxEdge, undefined);
  // the request shape: the same entry of input_references as Aleph's, no field besides model and prompt
  assert.deepEqual(plain(fluxEdit.videoReference('https://example.test/v.mp4')), { type: 'video_url', video_url: { url: 'https://example.test/v.mp4' } });
  assert.deepEqual(plain(fluxEdit.videoReference('https://example.test/v.mp4')), plain(alephEdit.videoReference('https://example.test/v.mp4')));
  assert.deepEqual(plain(fluxEdit.requestExtras()), {});
  // the price: 0.03 per second of the length of the video, with no minimum. The list and the maker say so, and the live test of 2026-10-08
  // billed a clip of 3 s 0.09 USD, not the 0.15 of Aleph's flat 5 s
  near(fluxEdit.priceFor(3), 0.09, 'the live test of 2026-10-08: 3 s were billed 0.09 USD');
  for (const [seconds, usd] of [[0.5, 0.015], [1, 0.03], [3, 0.09], [4.95, 0.1485], [5, 0.15], [5.04, 0.1512], [8, 0.24], [10, 0.3], [15, 0.45], [15.05, 0.4515]]) near(fluxEdit.priceFor(seconds), usd, `${seconds} s`);
  assert.equal(fluxEdit.billedSeconds(3), 3, 'a short clip is billed by its length, with no minimum of 5 s');
  assert.equal(fluxEdit.billedSeconds(0.5), 0.5);
  assert.equal(fluxEdit.billedSeconds(7.5), 7.5, 'a longer video is billed by its length');
  near(fluxEdit.priceFor(1, { perSecondUsd: 0.04 }), 0.04, 'the numbers of the live list, by length');
  near(fluxEdit.priceFor(1, { perSecondUsd: 0.01, minimumUsd: 0.2 }), 0.2, 'never below a minimum of the live list');
  assert.equal(fluxEdit.priceFor(0), null);
  assert.equal(fluxEdit.priceFor(NaN), null);
  // The key of a part (nodes-fal.js planEditParts): the same fields as Aleph's, so the model id is what tells the parts of the two apart
  const keyOf = (target) => editParts.partKey({ via: 'openrouter', target, input: { prompt: 'Make it snow' }, media: [], source: 'vid-fixed-1', rate: '30', longest: 15, from: 0, frames: 448 });
  assert.equal(keyOf(FLUX), 'ep1-c511ca7ef6be487c5d2362384aa5344b');
  assert.notEqual(keyOf(FLUX), keyOf(ALEPH));
  console.log('   ok testAssumptionTable');
}

/* ---------- the node ---------- */

async function main() {
  testAssumptionTable();

  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  const dictionary = window.I18N;
  const placeholdersOf = (text) => [...new Set((String(text).match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))].sort();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-flux-video-edit-'));
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
      return { id: `flux-job-${jobCounter}`, status: 'pending' };
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
          await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), 0.12);
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
    const run = (inputs, rawParams = {}) => def.execute(ctx(), inputs, normalised({ model: 'flux_video_edit', ...rawParams }));
    const plan = (inputs, rawParams = {}) => nodesFal.planVideoEdit(ctx(), inputs, normalised({ model: 'flux_video_edit', ...rawParams }));
    const estimate = (rawParams, seconds) => def.cost.estimate(normalised({ model: 'flux_video_edit', ...rawParams }), { inputs: { video: { type: 'video', duration: seconds } } });
    const prompt = textValue('Make it snow');
    const jobsNow = async () => (await store.readSession(sessionId)).jobs;
    const scratchLeftovers = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith(assets.SCRATCH_PREFIX));

    // a refusal: its stable code and data, nothing sent, nothing published, no job, and a value for every placeholder of the three texts
    async function refused(inputs, rawParams, code, { data, message } = {}) {
      reset();
      const jobs = (await jobsNow()).length;
      const error = await run(inputs, rawParams).catch((err) => err);
      assert.ok(error instanceof Error, `${code}: refused`);
      if (code) assert.equal(error.code, code, `${code}: ${error.message}`);
      if (data) for (const [key, value] of Object.entries(data)) assert.deepEqual(error.data[key], value, `${code}.${key}`);
      if (message) assert.match(error.message, message);
      if (code) {
        for (const lang of ['de', 'en', 'es']) {
          for (const name of placeholdersOf(dictionary[lang][`nodes.issue.${code}`])) assert.ok(error.data && error.data[name] !== undefined, `${lang}.${code}: {${name}} has a value`);
        }
      }
      assert.equal(payloads.length, 0, `${code}: the provider was not called`);
      assert.equal(published.length, 0, `${code}: nothing published`);
      assert.equal((await jobsNow()).length, jobs, `${code}: no job`);
      assert.deepEqual(await scratchLeftovers(), [], `${code}: no scratch folder left`);
      return error;
    }

    /* ----- definition ----- */
    {
      const model = def.params.find((param) => param.id === 'model');
      assert.deepEqual(model.options, ['kling_o3', 'wan_replace', 'gemini_omni', 'runway_aleph', 'flux_video_edit'], 'FLUX Video Edit is the fifth model, after Aleph');
      assert.equal(model.default, 'kling_o3', 'the default stays');
      const param = (id) => plain(def.params.find((item) => item.id === id).showIf);
      const withLimit = { param: 'model', in: ['kling_o3', 'gemini_omni', 'runway_aleph', 'flux_video_edit'] };
      assert.deepEqual(param('prompt'), withLimit);
      assert.deepEqual(param('cut_to_limit'), withLimit);
      assert.deepEqual(param('in_parts'), withLimit);
      assert.deepEqual(param('redo_parts'), { all: [withLimit, { param: 'in_parts', equals: true }] });
      // the options of the other models are not shown for FLUX Video Edit
      for (const id of ['quality', 'image_role', 'keep_audio', 'resolution', 'wan_resolution']) assert.notDeepEqual(param(id).in, withLimit.in, id);
      // the description (node library, assistant) is written from the table: the longest run, the price and what the model does not take
      assert.match(def.description, /FLUX Video Edit: changes the video by text, never images; one run takes 15 s at the most and costs 0\.03 USD per second of the video, billed by its length with no minimum \(3 s = 0\.09 USD\); the sound of the video stays\./);
      assert.doesNotMatch(def.description, /planned for at least|0\.15 USD/, 'no minimum of 5 s for FLUX Video Edit: the live test of 2026-10-08 was billed 3 s for 3 s');
      assert.match(def.description, /Runway Aleph and FLUX Video Edit through OpenRouter/);
      assert.match(def.description, /Runway Aleph 2\.0: [^.]*one run takes 30 s at the most and costs at least 1\.40 USD \(OpenRouter bills at least 5 s\)/, 'the sentence of Aleph is as it was');
      assert.ok(def.keywords.includes('flux') && def.keywords.includes('aleph'), 'found by "flux"');
      assert.equal(typeof def.prepare, 'function');
      // the price of the list is read for FLUX like for Aleph, and for no other model
      let loads = 0;
      patch(videoNodeModels, 'load', async () => {
        loads += 1;
      });
      await def.prepare({ model: 'flux_video_edit' });
      await def.prepare({ model: 'runway_aleph' });
      await def.prepare({ model: 'kling_o3' });
      assert.equal(loads, 2);
      restorers.pop()();
      // the node is usable with the OpenRouter key alone (without a fal key) and with fal alone
      const fal = require('../lib/fal');
      patch(fal, 'hasKey', () => false);
      assert.equal(def.available(), true, 'OpenRouter key and ffmpeg');
      patch(fal, 'hasKey', () => true);
      // validation before the run
      const issues = (rawParams, ports) => def.validate(normalised({ model: 'flux_video_edit', prompt: 'x', ...rawParams }), ports);
      const codes = (list) => list.map((issue) => issue.code);
      assert.deepEqual(codes(issues({}, { images: { connected: true, count: 1 } })), ['VIDEO_EDIT_FLUX_IMAGES']);
      assert.deepEqual(plain(issues({}, { images: { connected: true, count: 1 } })[0].data), { model: 'FLUX Video Edit' });
      assert.equal(issues({}, { images: { connected: true, count: 1 } })[0].port, 'images');
      assert.deepEqual(codes(issues({}, {})), []);
      assert.deepEqual(codes(issues({ prompt: '' }, {})), ['VIDEO_EDIT_PROMPT_REQUIRED']);
      assert.deepEqual(codes(issues({ prompt: '' }, { prompt: { connected: true, count: 1 } })), []);
      // a typed prompt over 4096 characters is an error; 4096 are fine; a connected text is measured when the node runs
      assert.deepEqual(codes(issues({ prompt: 'x'.repeat(4096) }, {})), []);
      const tooLong = issues({ prompt: 'x'.repeat(4097) }, {});
      assert.deepEqual(codes(tooLong), ['VIDEO_EDIT_PROMPT_TOO_LONG']);
      assert.deepEqual(plain(tooLong[0].data), { model: 'FLUX Video Edit', max: 4096, found: 4097 });
      assert.equal(tooLong[0].level, undefined, 'an error, not a warning');
      assert.deepEqual(codes(issues({ prompt: 'x'.repeat(5000) }, { prompt: { connected: true, count: 1 } })), []);
      assert.deepEqual(codes(def.validate(normalised({ model: 'gemini_omni', prompt: 'x'.repeat(5000) }), {})), [], 'the other models have no such limit');
      assert.deepEqual(codes(def.validate(normalised({ model: 'runway_aleph', prompt: 'x'.repeat(5000) }), {})), []);
      // the address of the server is a warning, with the name of this model
      withEnv('PUBLIC_BASE_URL', undefined);
      assert.deepEqual(codes(issues({}, {})), ['public_base_url']);
      assert.equal(issues({}, {})[0].level, 'warning');
      assert.match(issues({}, {})[0].message, /^FLUX Video Edit reads the video from an address of this server and needs PUBLIC_BASE_URL$/);
      assert.match(def.validate(normalised({ model: 'runway_aleph', prompt: 'x' }), {})[0].message, /^Runway Aleph 2\.0 reads the video from an address of this server and needs PUBLIC_BASE_URL$/);
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
    }

    /* ----- price ----- */
    {
      // the constants (the list is not read yet): 0.03 per second of the length, no minimum (the live test of 2026-10-08 billed 3 s 0.09 USD)
      videoNodeModels.reset();
      for (const [seconds, usd] of [[1, 0.03], [2, 0.06], [3, 0.09], [5, 0.15], [8, 0.24], [10, 0.3], [15, 0.45]]) near(estimate({}, seconds), usd, `${seconds} s`);
      assert.ok(estimate({}, 3) < estimate({}, 5), 'a short clip is planned by its length and not as 5 s');
      near(nodesFal.videoEditPlanUsd(normalised({ model: 'flux_video_edit' }), { inputs: {} }), 0.03 * 15.05, 'no video known: the longest one (15 s and the slack)');
      // longer than the limit without the cut: the whole length is the price asked (the run is refused later)
      near(estimate({ cut_to_limit: true }, 60), 0.03 * 15, 'cut to 15 s');
      for (const seconds of [16, 45, 120]) near(estimate({ cut_to_limit: true }, seconds), 0.45, `${seconds} s cut to 15 s`);
      // the list of OpenRouter as it was read (3 cents per second) gives the same price for the same run as the constants
      await videoNodeModels.load();
      assert.ok(videoNodeModels.peek(FLUX), 'the list is read');
      const seconds = [1, 2, 3, 4.95, 5, 5.04, 7, 8, 12.5, 15];
      const fromList = seconds.map((value) => estimate({}, value));
      videoNodeModels.reset();
      const fromConstants = seconds.map((value) => estimate({}, value));
      assert.deepEqual(fromList, fromConstants, 'the same seconds are billed with the live list and without it');
      near(fromConstants[2], 0.09, '3 s: what the live test of 2026-10-08 was billed');
      near(fromConstants[3], 0.1485, '4.95 s is billed by its length and not as 5 s');
      near(fromConstants[5], 0.1512, '5.04 s is billed by its length');
      near(fromConstants[8], 0.375, '12.5 s');
      // the live list wins: another price of the provider; the billed seconds (the length) are the same way
      patch(discovery, 'listVideoModels', async () => ({ data: [{ ...FLUX_ENTRY, pricing_skus: { cents_per_second_output: '4' } }] }));
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      near(estimate({}, 3), 0.12, 'the price of the list, by length: 3 x 0.04');
      near(estimate({}, 10), 0.4, 'the price of the list, 10 s');
      patch(discovery, 'listVideoModels', async () => CATALOG);
      discovery.resetVideoModelCache();
      videoNodeModels.reset();
      await videoNodeModels.load();
      // the node does not change the price of the other models
      near(def.cost.estimate(normalised({}), { inputs: { video: { type: 'video', duration: 8 } } }), 1.12, 'Kling O3: 8 s at 0.14');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 3 } } }), 1.4, 'Aleph: 3 s are billed as 5 s');
      near(def.cost.estimate(normalised({ model: 'runway_aleph' }), { inputs: { video: { type: 'video', duration: 8 } } }), 2.24, 'Aleph: 8 s by its length');
    }

    /* ----- a run: the request ----- */
    {
      reset();
      const source = await video({ duration: 3 });
      const outcome = await run({ video: source, prompt }, {});
      assert.equal(payloads.length, 1);
      assert.deepEqual(payloads[0], {
        model: FLUX,
        prompt: 'Make it snow',
        input_references: [{ type: 'video_url', video_url: { url: `https://example.test/refs/${source.assetId}.mp4` } }]
      });
      for (const field of ['duration', 'resolution', 'aspect_ratio', 'frame_images', 'generate_audio', 'seed', 'size', 'provider', 'mode', 'version', 'safety_tolerance']) {
        assert.equal(field in payloads[0], false, `no ${field}`);
      }
      // byte for byte, the order of the keys included: model, prompt, input_references, the same as Aleph's request except for the model
      assert.equal(JSON.stringify(payloads[0]), `{"model":"black-forest-labs/flux-video-edit","prompt":"Make it snow","input_references":[{"type":"video_url","video_url":{"url":"https://example.test/refs/${source.assetId}.mp4"}}]}`);
      assert.deepEqual(published, [{ asset: source.assetId }]);
      assert.equal(outcome.variants.length, 1);
      assert.equal(outcome.variants[0].video.type, 'video');
      near(outcome.cost.usd, 0.12, 'the cost of the run is the one the provider booked (the fake books what it likes)');
      // the job record carries the name of THIS model; the estimate is the price of 3 s by its length, the 0.09 USD of the live test of 2026-10-08
      const job = (await jobsNow()).slice(-1)[0];
      assert.equal(job.mode, 'video_edit');
      assert.equal(job.model, FLUX);
      assert.equal(job.modelName, 'FLUX Video Edit');
      near(job.estimateUsd, 0.09, 'the estimate of the job');
      assert.deepEqual(job.publicRefFiles, [`${source.assetId}.mp4`]);
      assert.equal('partKey' in job, false, 'a single run has no part key');
      // the prompt is sent as written: no @-names, nothing is translated, German or not
      reset();
      await run({ video: await video({ duration: 3 }), prompt: textValue('Replace the Bild 1 in the video') }, {});
      assert.equal(payloads[0].prompt, 'Replace the Bild 1 in the video');
      // a prompt of 4096 characters goes out whole
      reset();
      await run({ video: await video({ duration: 3 }), prompt: textValue('x'.repeat(4096)) }, {});
      assert.equal(payloads[0].prompt.length, 4096);
      // 1 s is the shortest video, priced by its length
      reset();
      await run({ video: await video({ duration: 1 }), prompt: textValue('Make it night') }, {});
      assert.equal(payloads[0].prompt, 'Make it night');
      near((await jobsNow()).slice(-1)[0].estimateUsd, 0.03, '1 s: billed by its length');
      // 15 s is ONE run: sent as it is, the estimate of the job is the price by its length
      reset();
      const fifteen = await video({ duration: 15 });
      await run({ video: fifteen, prompt }, {});
      assert.equal(payloads.length, 1, 'one request for the whole video');
      assert.equal(payloads[0].input_references[0].video_url.url, `https://example.test/refs/${fifteen.assetId}.mp4`);
      assert.equal(cuts.length, 0, 'not cut');
      near((await jobsNow()).slice(-1)[0].estimateUsd, 0.45, '15 s');
      // 4K is not refused here (the maker scales a source over 720p down itself); Aleph's largest side is 1920 px
      reset();
      const uhd = await video({ duration: 5, width: 3840, height: 2160 });
      await run({ video: uhd, prompt }, {});
      assert.equal(payloads.length, 1, 'a 4K video goes out');
      await refused({ video: uhd, prompt }, { model: 'runway_aleph' }, 'VIDEO_EDIT_VIDEO_TOO_LARGE');
      // a WebM: FLUX takes MP4 only (the maker names MP4), Aleph takes the WebM that the app can hand over
      const webm = await media('video', '.webm', { duration: 5, width: 1280, height: 720 });
      await refused({ video: webm, prompt }, {}, 'VIDEO_EDIT_VIDEO_FORMAT', {
        data: { model: 'FLUX Video Edit', format: 'WEBM', formats: 'MP4' },
        message: /^video: FLUX Video Edit takes MP4 \(the video is WEBM\)\. Convert it to an MP4/
      });
      reset();
      await run({ video: webm, prompt }, { model: 'runway_aleph' });
      assert.equal(payloads.length, 1, 'Aleph takes it');
      assert.equal(payloads[0].model, ALEPH);
      assert.equal((await jobsNow()).slice(-1)[0].modelName, 'Runway Aleph 2.0', 'the job of Aleph carries Aleph\'s name next to FLUX\'s');
    }

    /* ----- a short clip is planned by its length (no billed minimum) ----- */
    {
      reset();
      near((await plan({ video: await video({ duration: 1 }), prompt })).estimateUsd, 0.03, '1 s');
      near((await plan({ video: await video({ duration: 3 }), prompt })).estimateUsd, 0.09, '3 s: the live test of 2026-10-08 was billed 0.09 USD');
      near((await plan({ video: await video({ duration: 4.5 }), prompt })).estimateUsd, 0.135, '4.5 s');
      near((await plan({ video: await video({ duration: 5 }), prompt })).estimateUsd, 0.15, '5 s');
      near((await plan({ video: await video({ duration: 5.04 }), prompt })).estimateUsd, 0.03 * 5.04, '5.04 s: billed by its length');
      near((await plan({ video: await video({ duration: 8 }), prompt })).estimateUsd, 0.24, '8 s');
      near((await plan({ video: await video({ duration: 15 }), prompt })).estimateUsd, 0.45, '15 s: the longest run');
      const planned = await plan({ video: await video({ duration: 5 }), prompt });
      assert.ok(planned.openrouter, 'the OpenRouter way');
      assert.equal(planned.endpoint, undefined, 'no fal endpoint');
      assert.equal(planned.openrouter.model, FLUX);
      assert.equal(planned.openrouter.name, 'FLUX Video Edit');
      assert.equal(planned.cleanup, null);
    }

    /* ----- the reservation is never below what is billed ----- */
    {
      // a participant's call reserves the estimate of the node (executeTool -> budget.begin): the price of the billed seconds, that is of the length
      const begun = [];
      patch(access, 'viewerOf', () => ({ active: true, kind: 'participant', email: 'p@example.test' }));
      patch(budget, 'begin', async (_viewer, options) => {
        begun.push(options.estimateUsd);
        return budget.NOOP_GRANT;
      });
      reset();
      await run({ video: await video({ duration: 3 }), prompt }, {});
      assert.deepEqual(begun, [0.09], 'the reservation of a run of 3 s is the price of 3 s (it was reserved as 5 s, 0.15, before the live test of 2026-10-08)');
      begun.length = 0;
      await run({ video: await video({ duration: 8 }), prompt }, {});
      assert.deepEqual(begun, [0.24]);
      begun.length = 0;
      await run({ video: await video({ duration: 45 }), prompt }, { cut_to_limit: true });
      assert.deepEqual(begun, [0.45], 'cut to the first 15 s: the price of the limit (the cut file is 14.95 s)');
      // the budget stops a run that does not fit before anything is started: 0.10 USD are enough for a clip of 3 s (0.09), not for one of 5 s (0.15)
      patch(budget, 'begin', async (viewer, options) => {
        if (options.estimateUsd > 0.1) throw new budget.BudgetError('BUDGET_INSUFFICIENT', 'not enough', 'nicht genug', { estimateUsd: options.estimateUsd });
        return budget.NOOP_GRANT;
      });
      reset();
      await run({ video: await video({ duration: 3 }), prompt }, {});
      assert.equal(payloads.length, 1, 'a clip of 3 s fits into 0.10 USD: it is no longer reserved as 5 s');
      reset();
      const error = await run({ video: await video({ duration: 5 }), prompt }, {}).catch((err) => err);
      assert.equal(error.code, 'BUDGET_INSUFFICIENT');
      assert.equal(error.estimateUsd, 0.15);
      assert.equal(payloads.length, 0, 'the provider was not called');
      restorers.pop()();
      restorers.pop()();
      restorers.pop()();
    }

    /* ----- refused before anything is paid ----- */
    {
      const ok = await video({ duration: 5 });
      await refused({ video: await video({ duration: 0.5 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SHORT', { data: { model: 'FLUX Video Edit', min: 1, found: 0.5 } });
      // one run takes 15 s at the most: just over the slack and well over are refused
      await refused({ video: await video({ duration: 15.06 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'FLUX Video Edit', max: 15, found: 15.1 } });
      await refused({ video: await video({ duration: 16 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'FLUX Video Edit', max: 15, found: 16 } });
      await refused({ video: await video({ duration: 45 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'FLUX Video Edit', max: 15, found: 45 } });
      // 50 MiB are fine, one byte more is not
      await refused({ video: await video({ duration: 5, size: 50 * MB + 1 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_HEAVY', { data: { max: 50 } });
      reset();
      await run({ video: await video({ duration: 5, size: 50 * MB }), prompt }, {});
      assert.equal(payloads.length, 1, '50 MiB go out');
      // the smaller side: at least 160 px (no largest side)
      await refused({ video: await video({ duration: 5, width: 640, height: 150 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SMALL', { data: { model: 'FLUX Video Edit', min: 160, width: 640, height: 150 } });
      reset();
      await run({ video: await video({ duration: 5, width: 160, height: 160 }), prompt }, {});
      assert.equal(payloads.length, 1, '160 x 160 goes out');
      // a prompt is needed, and not longer than 4096 characters (measured before anything is published)
      await refused({ video: ok }, {}, 'VIDEO_EDIT_PROMPT_REQUIRED');
      await refused({ video: ok, prompt: textValue('x'.repeat(4097)) }, {}, 'VIDEO_EDIT_PROMPT_TOO_LONG', { data: { model: 'FLUX Video Edit', max: 4096, found: 4097 } });
      await refused({ video: ok, prompt: textValue('ä'.repeat(4097)) }, {}, 'VIDEO_EDIT_PROMPT_TOO_LONG', { data: { found: 4097 } });
      // images are never taken, with their own text (not Aleph's "not confirmed yet")
      await refused({ video: ok, prompt, images: { type: 'list', of: 'image', items: [await image()] } }, {}, 'VIDEO_EDIT_FLUX_IMAGES', { data: { model: 'FLUX Video Edit' }, message: /^FLUX Video Edit takes no images, only a video and a text\./ });
      // the key and the address
      patch(or, 'hasKey', () => false);
      await refused({ video: ok, prompt }, {}, undefined, { message: /OPENROUTER_API_KEY is not set/ });
      patch(or, 'hasKey', () => true);
      withEnv('PUBLIC_BASE_URL', undefined);
      await refused({ video: ok, prompt }, {}, 'VIDEO_EDIT_PUBLIC_URL', {
        data: { model: 'FLUX Video Edit' },
        message: /^FLUX Video Edit reads the video from an address of this server: set PUBLIC_BASE_URL\. Nothing was uploaded or charged\.$/
      });
      await refused({ video: ok, prompt }, { model: 'runway_aleph' }, 'VIDEO_EDIT_PUBLIC_URL', {
        data: { model: 'Runway Aleph 2.0' },
        message: /^Runway Aleph 2\.0 reads the video from an address of this server: set PUBLIC_BASE_URL\. Nothing was uploaded or charged\.$/
      });
      withEnv('PUBLIC_BASE_URL', 'https://example.test');
      // the fal key is not asked for FLUX: a fal key that is gone does not stop it ... and the fal models still ask for theirs
      const fal = require('../lib/fal');
      patch(fal, 'hasKey', () => false);
      reset();
      await run({ video: ok, prompt }, {});
      assert.equal(payloads.length, 1, 'FLUX Video Edit runs without a fal key');
      await assert.rejects(def.execute(ctx(), { video: ok, prompt }, normalised({ model: 'kling_o3' })), /FAL_KEY/);
      patch(fal, 'hasKey', () => true);
    }

    /* ----- Cut to the allowed length ----- */
    {
      // the first 15 s (0.45 USD)
      reset();
      const long = await video({ duration: 45, width: 1280, height: 720 });
      const cutPlan = await plan({ video: long, prompt }, { cut_to_limit: true });
      near(cutPlan.estimateUsd, 0.03 * 15, 'the price of the first 15 s');
      assert.equal(cutPlan.trimmed, true);
      assert.equal(typeof cutPlan.cleanup, 'function');
      assert.ok(cutPlan.openrouter.videoFile && !cutPlan.openrouter.videoAssetId, 'the cut file is sent, not the asset');
      assert.ok(fs.existsSync(cutPlan.openrouter.videoFile));
      assert.equal(cuts[0][cuts[0].indexOf('-t') + 1], '14.95', `ffmpeg cuts to the limit less the slack: ${cuts[0].join(' ')}`);
      await cutPlan.cleanup();
      assert.deepEqual(await scratchLeftovers(), [], 'the plan left nothing behind after cleanup');
      // a run: the cut file is published and the scratch folder is removed afterwards
      reset();
      const outcome = await run({ video: long, prompt }, { cut_to_limit: true });
      assert.equal(payloads.length, 1);
      assert.equal(published.length, 1);
      assert.ok(published[0].file, 'a file (the cut), not an asset');
      assert.equal(payloads[0].model, FLUX);
      assert.equal(payloads[0].input_references[0].video_url.url, `https://example.test/refs/${published[0].file}`);
      assert.equal(outcome.variants[0].video.type, 'video');
      assert.deepEqual(await scratchLeftovers(), []);
      near((await jobsNow()).slice(-1)[0].estimateUsd, 0.45, '15 s');
      // just over the limit and the slack: cut; within the slack (15.04 s): sent as it is and priced by its length
      reset();
      const slightly = await plan({ video: await video({ duration: 15.06 }), prompt }, { cut_to_limit: true });
      assert.equal(slightly.trimmed, true);
      near(slightly.estimateUsd, 0.45);
      await slightly.cleanup();
      reset();
      const within = await plan({ video: await video({ duration: 15.04 }), prompt }, { cut_to_limit: true });
      assert.equal(within.trimmed, false);
      assert.equal(cuts.length, 0, 'not cut');
      near(within.estimateUsd, 0.03 * 15.04);
      // a video under the limit is not cut either
      reset();
      const under = await plan({ video: await video({ duration: 8 }), prompt }, { cut_to_limit: true });
      assert.equal(under.trimmed, false);
      near(under.estimateUsd, 0.24, '8 s with the switch on');
      // "in parts" wins over the cut where parts are allowed (test-video-edit-parts.js); the plan of a single run still cuts
      reset();
      const single = await plan({ video: long, prompt }, { cut_to_limit: true, in_parts: true });
      assert.equal(single.trimmed, true);
      await single.cleanup();
    }

    /* ----- the provider refuses ----- */
    {
      reset();
      createVideoError = new or.OpenRouterError('OpenRouter 422: HTTP 422: {"error":{"message":"unexpected field"}}', { status: 422 });
      const jobs = (await jobsNow()).length;
      const source = await video({ duration: 4 });
      const error = await run({ video: source, prompt }, {}).catch((err) => err);
      assert.match(error.message, /unexpected field/);
      assert.equal((await jobsNow()).length, jobs, 'no job is left');
      assert.deepEqual(removed, [`${source.assetId}.mp4`], 'the public address is taken back');
      const reserved = (await store.readLedger(sessionId)).filter((entry) => entry.pending === true && entry.kind === 'video');
      assert.deepEqual(reserved.filter((entry) => entry.prompt === 'Make it snow'), []);
    }

    /* ----- the tool serves both models ----- */
    {
      reset();
      const toolCtx = { nodeView: true, sessionId, config: {}, user: 'tester', emit() {} };
      const call = (args) => tools.executeTool(toolCtx, 'edit_video_openrouter', args);
      const source = await video({ duration: 4 });
      await assert.rejects(call({ model: 'other/model', prompt: 'x', video_asset_id: source.assetId }), /kein Videobearbeitungsmodell/);
      await assert.rejects(call({ model: FLUX, prompt: '', video_asset_id: source.assetId }), /prompt fehlt/);
      await assert.rejects(call({ model: FLUX, prompt: 'x' }), /Genau eines/);
      await assert.rejects(call({ model: FLUX, prompt: 'x', video_asset_id: source.assetId, estimateUsd: -1 }), /estimateUsd/);
      await assert.rejects(tools.executeTool({ sessionId, config: {}, user: 'tester', emit() {} }, 'edit_video_openrouter', { model: FLUX, prompt: 'x', video_asset_id: source.assetId }), /./, 'not from the chat');
      assert.equal(payloads.length, 0);
      // a call without a name from the node falls back to the name of the model's own table
      await call({ model: FLUX, prompt: 'Make it snow', video_asset_id: source.assetId });
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].model, FLUX);
      assert.equal((await jobsNow()).slice(-1)[0].modelName, 'FLUX Video Edit');
      await call({ model: ALEPH, prompt: 'Make it snow', video_asset_id: source.assetId });
      assert.equal(payloads[1].model, ALEPH);
      assert.equal((await jobsNow()).slice(-1)[0].modelName, 'Runway Aleph 2.0');
    }
  } finally {
    restoreAll();
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  /* ---------- the texts ---------- */
  for (const lang of ['de', 'en', 'es']) {
    const d = dictionary[lang];
    for (const key of ['nodes.issue.VIDEO_EDIT_FLUX_IMAGES', 'nodes.issue.VIDEO_EDIT_PROMPT_TOO_LONG', 'nodes.option.flux_video_edit']) {
      assert.ok(d[key] && d[key].trim(), `${lang}: ${key}`);
      assert.equal(d[key].includes('ß'), false, `${lang}.${key}: no sharp s`);
    }
    assert.match(d['nodes.option.flux_video_edit'], /^FLUX Video Edit \(/);
    assert.deepEqual(placeholdersOf(d['nodes.issue.VIDEO_EDIT_FLUX_IMAGES']), ['model']);
    assert.deepEqual(placeholdersOf(d['nodes.issue.VIDEO_EDIT_PROMPT_TOO_LONG']), ['found', 'max', 'model']);
    // the format text names the formats of the model that refused (it said "MP4 or MOV" for every model before)
    assert.deepEqual(placeholdersOf(d['nodes.issue.VIDEO_EDIT_VIDEO_FORMAT']), ['format', 'formats', 'model'], `${lang}: the formats come from the model`);
    assert.doesNotMatch(d['nodes.issue.VIDEO_EDIT_VIDEO_FORMAT'], /MP4 (oder|or|o) MOV/, `${lang}: no fixed formats`);
    // the help names the model: search words, the sentence about the models that change by text, the lengths, the price, the ports
    assert.match(d['nodes.type.fal.video_edit.keywords'], /FLUX/i, `${lang}: found by "FLUX"`);
    assert.match(d['nodes.type.fal.video_edit.help'], /FLUX Video Edit/, `${lang}: help`);
    assert.match(d['nodes.type.fal.video_edit.tip.2'], /FLUX[^,.]*\b15\b/, `${lang}: FLUX takes 15 s at the most`);
    assert.match(d['nodes.type.fal.video_edit.tip.3'], /FLUX[^,.]*0\.03/, `${lang}: the price of FLUX is in the help`);
    const input = d['nodes.portdesc.fal.video_edit.video.in'];
    assert.match(input, /FLUX Video Edit: [^.]*\b1\b[^.]*\b15 s/, `${lang}: the port names the lengths of FLUX`);
    assert.match(input, /MP4/);
    assert.match(d['nodes.portdesc.fal.video_edit.video.out'], /FLUX Video Edit/, `${lang}: out`);
    assert.match(d['nodes.portdesc.fal.video_edit.images'], /FLUX Video Edit/, `${lang}: images`);
    assert.match(d['nodes.portdesc.fal.video_edit.prompt'], /FLUX[^.]*4096/, `${lang}: the longest prompt`);
    assert.match(d['nodes.issue.VIDEO_EDIT_PROMPT_REQUIRED'], /FLUX Video Edit/, `${lang}: prompt required`);
    // what the live test of 2026-10-08 measured is said so (1920 x 1080 came back as 1248 x 704), and the result is no longer called untested
    assert.match(d['nodes.portdesc.fal.video_edit.video.out'], /1248 x 704/, `${lang}: the size that came back`);
    assert.doesNotMatch(d['nodes.portdesc.fal.video_edit.video.out'], /(ungetestet|untested|sin probar)/, `${lang}: measured, not untested`);
    // FLUX has no minimum: the "at least" of the tip belongs to Aleph alone
    assert.doesNotMatch(d['nodes.type.fal.video_edit.tip.3'], /FLUX[^,.]*(mindestens|at least|mín)/, `${lang}: no minimum for FLUX`);
    // Aleph's lines are still there
    assert.match(d['nodes.type.fal.video_edit.tip.3'], /Aleph 0\.28/, `${lang}: Aleph`);
    assert.match(d['nodes.type.fal.video_edit.tip.3'], /1\.40/, `${lang}: Aleph's least`);
    assert.match(d['nodes.portdesc.fal.video_edit.video.in'], /Runway Aleph 2\.0: [^.]*\b30 s/, `${lang}: Aleph's 30 s`);
  }

  /* ---------- the help says what the live test of 2026-10-08 measured (three languages; the READMEs are not pinned) ---------- */
  {
    const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
    const help = read('public', 'help.html');
    // a clip of 3 s costs 0.09 USD, billed by its length: in the help of every language
    for (const phrase of [
      'FLUX Video Edit 0.03 (nach Länge, ohne Minimum: 3 s = 0.09 pro Lauf)',
      'FLUX Video Edit 0.03 (by length, no minimum: 3 s = 0.09 per run)',
      'FLUX Video Edit 0.03 (según la duración, sin mínimo: 3 s = 0.09 por ejecución)'
    ]) assert.ok(help.includes(phrase), `help.html: ${phrase}`);
    // and the help no longer says what held before the live test: a plan of at least 5 s for FLUX Video Edit
    const stale = [
      /planned for at least 5 s, so 0\.15|geplant mit mindestens 5 s, also 0\.15|se planifica con al menos 5 s, es decir, 0\.15/,
      /the plan counts at least 5 s \(0\.15 USD\)|der Plan rechnet mindestens 5 s \(0\.15 USD\)|el plan cuenta al menos 5 s \(0\.15 USD\)/
    ];
    for (const pattern of stale) assert.doesNotMatch(help, pattern, `help.html: ${pattern}`);
  }
  console.log('test-flux-video-edit.js: ok');
}

main().catch((error) => {
  restoreAll();
  console.error(error);
  process.exit(1);
});
