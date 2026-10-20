'use strict';

// FLUX.3 Max: pure plans and pricing plus the chat click lifecycle with fake fal. No external network or paid calls.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const spec = require('../lib/flux3-max');
const { createIsolatedApp } = require('./support/isolated-app');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const ADMIN = 'admin@example.com';
const MEMBER = 'member@example.org';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const DURATIONS = Array.from({ length: 16 }, (_, i) => i + 5);

function pureTests() {
  const promo = () => Date.parse('2026-11-06T23:59:59.999Z');
  const list = () => Date.parse('2026-11-07T00:00:00Z');
  for (const duration of DURATIONS) {
    near(spec.price('720p', duration, promo).maxTotal, 0.0425 * duration);
    near(spec.price('1080p', duration, promo).maxTotal, 0.0725 * duration);
    near(spec.price('720p', duration, list).maxTotal, 0.17 * duration);
    near(spec.price('1080p', duration, list).maxTotal, 0.29 * duration);
  }
  const params = { duration: 5, resolution: '1080p', aspect_ratio: '2:1', generate_audio: false, reasoning_level: 'low', seed: 42 };
  const expected = { prompt: 'Walk', duration: 5, resolution: '1080p', aspect_ratio: '2:1', generate_audio: false, reasoning_level: 'low', seed: 42 };
  assert.deepEqual(spec.plan({ prompt: ' Walk ', params, now: promo }).input, expected);
  assert.equal(spec.plan({ prompt: 'Walk' }).endpoint, `${spec.BASE}/text-to-video`);
  assert.deepEqual(spec.plan({ prompt: 'Walk' }).input, { prompt: 'Walk', duration: 5, resolution: '720p', reasoning_level: 'high', aspect_ratio: 'auto', generate_audio: true });
  const image = spec.plan({ prompt: 'Walk', params, first: 'first', last: 'last', now: promo });
  assert.equal(image.endpoint, `${spec.BASE}/image-to-video`);
  assert.deepEqual(image.input, { ...expected, image_url: 'first', end_image_url: 'last' });
  const keyframes = spec.plan({ prompt: 'Walk', params, images: ['a', 'b', 'c', 'd'], now: promo });
  assert.equal(keyframes.endpoint, `${spec.BASE}/keyframes-to-video`);
  assert.deepEqual(keyframes.input, { ...expected, keyframes: ['a', 'b', 'c', 'd'].map((image_url, i) => ({ image_url, frame_index: i * 40 })) });
  assert.deepEqual(spec.frameIndices(3, 5, '0, 2.5, 5'), [0, 60, 120]);
  assert.deepEqual(spec.frameIndices(4, 5), [0, 40, 80, 120]);
  assert.deepEqual(spec.frameIndices(1, 5), [0]);
  assert.deepEqual(spec.frameIndices(1, 5, '5'), [120]);
  for (const count of [0, 11]) {
    assert.throws(() => spec.frameIndices(count, 5), (err) => err.code === 'FLUX_MAX_KEYFRAMES_COUNT' && /1 to 10/.test(err.message));
  }
  assert.throws(() => spec.frameIndices(2, 5, '0'), (err) => err.code === 'FLUX_MAX_KEYFRAME_TIMES_COUNT' && err.data.times === 1);
  assert.throws(() => spec.frameIndices(2, 5, '3, 1'), (err) => err.code === 'FLUX_MAX_KEYFRAME_TIMES_ORDER' && err.data.duration === 5);
  assert.throws(() => spec.frameIndices(2, 5, '1, 1.01'), (err) => err.code === 'FLUX_MAX_KEYFRAME_TIMES_UNIQUE');
  for (const times of ['0, 0, 5', '0, 2, 6', '0, 3, 2', '0, 5', '0, , 5', '-1, 2, 5', '0, 0.001, 5']) {
    assert.throws(() => spec.frameIndices(3, 5, times), /keyframe_times/);
  }
  assert.throws(() => spec.plan({ prompt: 'x', last: 'a' }), /requires a start/);
  for (const duration of [4, 21, 5.5, 'x']) assert.throws(() => spec.plan({ prompt: 'x', params: { duration } }), /duration/);
  for (const params of [{ resolution: '4k' }, { reasoning_level: 'medium' }, { generate_audio: 'yes' }, { seed: 1.5 }, { aspect_ratio: '3:2' }]) {
    assert.throws(() => spec.plan({ prompt: 'x', params }));
  }
}

async function integration(iso) {
  // A private copy of the app (scripts/support/isolated-app.js): chats and assets land in a temp directory, never in projects/.
  const load = (name) => iso.load(`lib/${name}`);
  const store = load('store');
  store.ensureDirs();
  const fal = load('fal');
  const tools = load('tools');
  const video = load('video-models');
  const nodes = load('nodes/nodes-fal');
  const assetLib = load('nodes/assets');
  const poller = load('poller');

  const base = 'bytedance/seedance-2.5';
  load('discovery').listVideoModels = async () => ({ data: video.CURATED_MODEL_IDS.map((id) => ({ id, name: id,
    supported_resolutions: ['720p', '1080p'], supported_durations: DURATIONS,
    supported_aspect_ratios: ['16:9', '1:1'], supported_frame_images: ['first_frame'], pricing_skus: { duration_seconds: '0.1' } })) });
  const vm = require('vm');
  const window = { document: { documentElement: {}, querySelectorAll() { return []; } }, navigator: { language: 'de' }, localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../public/i18n.js'), 'utf8'), { window });
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../public/nodes/i18n-nodes.js'), 'utf8'), { window });
  for (const lang of ['de', 'en', 'es']) {
    for (const field of ['summary', 'pro', 'con']) assert.ok(window.I18N[lang][`videoModel.profile.flux3Max.${field}`]);
    assert.ok(window.I18N[lang]['videoModel.contentChecker']);
  }
  const submissions = [];
  const uploads = [];
  let fail = false;
  fal.uploadFile = async (file) => { uploads.push(file); return { url: `https://fal.media/${path.basename(file)}` }; };
  fal.submit = async (endpoint, input) => {
    if (fail) throw new fal.FalError('fal 422: content checker rejected this input', 422);
    submissions.push({ endpoint, input });
    const id = `flux-${submissions.length}`;
    return { requestId: id, statusUrl: `https://queue.fal.run/${id}/status`, responseUrl: `https://queue.fal.run/${id}`, cancelUrl: `https://queue.fal.run/${id}/cancel` };
  };
  load('openrouter').createVideo = async () => { throw new Error('FLUX Max must never reach OpenRouter'); };
  const session = await store.createSession();
  const args = { prompt: 'Walk', duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9' };
  const viewerFor = (email) => ({ email, active: true, admin: email === ADMIN, kind: email === ADMIN ? 'internal' : 'participant' });
  const ctx = { sessionId: session.id, user: ADMIN, viewer: viewerFor(ADMIN), config: { videoModel: base }, emit() {}, pickVideoModel: true };
  const card = async (requestArgs = args, context = ctx) => {
    const events = [];
    const outcome = await tools.executeTool({ ...context, viewer: viewerFor(context.user), emit: (e) => events.push(e) }, 'generate_video', requestArgs);
    assert.equal(outcome.halt, true);
    return events.find((e) => e.type === 'video_model_choice').choice;
  };
  // Same orchestration as POST /video-model-requests/:id: compatibility, budget, tool, finish or reopen.
  const click = async (id, model = spec.MODEL, remember = false, as = ADMIN, sid = session.id) => {
    let selected;
    try {
      selected = await video.beginRequest({ sessionId: sid, requestId: id, selectedModel: model,
        budgetStatus: await load('budget').status(viewerFor(as)) });
      const outcome = await tools.executeTool({ sessionId: sid, user: as, viewer: viewerFor(as), emit() {},
        config: { videoModel: model }, selectedVideoModel: true, videoOption: selected.option,
        videoEstimateUsd: selected.option.estimateUsd, videoModelRequestId: id }, 'generate_video', selected.args);
      await video.finishRequest({ sessionId: sid, requestId: id, outcome, remember, viewer: viewerFor(as) });
      return { status: 201, body: { job: outcome.job } };
    } catch (error) {
      if (selected) await video.reopenRequest({ sessionId: sid, requestId: id, error });
      return { status: error.status || 400, text: error.message };
    }
  };
  const request = async (id) => (await store.readSession(session.id)).videoModelRequests.find((r) => r.id === id);
  process.env.FAL_KEY = '';
  assert.equal((await video.listOptions(args, base)).options.length, 7);
  assert.equal((await video.listOptions(args, base)).options.some((o) => o.id === spec.MODEL), false);
  for (const def of nodes.definitions.filter((d) => d.type.startsWith('fal.flux3max'))) assert.equal(def.available(), 'FAL_KEY is not set');
  process.env.FAL_KEY = 'fake-fal-key';
  const choice = await card();
  assert.equal(choice.options.length, 8);
  const option = choice.options.find((o) => o.id === spec.MODEL);
  assert.equal(option.name, spec.NAME);
  assert.equal(option.profileKey, 'flux3Max');
  near(option.estimateUsd, spec.price('720p', 5).maxTotal);
  assert.deepEqual(video.referenceLimits(spec.MODEL), { images: 0, videos: 0, audios: 0 });
  assert.equal((await video.listOptions({ ...args, reference_asset_ids: ['x'] }, base)).options.some((o) => o.id === spec.MODEL), false);
  for (const ratio of spec.RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    assert.equal(video.frameRatioFor(spec.MODEL, { width: w * 100, height: h * 100 }), ratio);
  }
  assert.equal(video.frameRatioFor(spec.MODEL, { width: 1780, height: 1000 }), '16:9');
  assert.ok(video.frameRatioProblem(spec.MODEL, { width: 1500, height: 1000 }));
  assert.ok(video.frameRatioProblem(spec.MODEL, null, { requireSize: true }));
  const firstClick = await click(choice.id, spec.MODEL, true);
  assert.equal(firstClick.status, 201, firstClick.text);
  assert.deepEqual(submissions[0], { endpoint: `${spec.BASE}/text-to-video`, input: { prompt: 'Walk', duration: 5, resolution: '720p', reasoning_level: 'high', aspect_ratio: '16:9', generate_audio: true } });
  assert.equal((await request(choice.id)).status, 'submitted');
  assert.equal(firstClick.body.job.source, 'fal');
  assert.equal(firstClick.body.job.modelName, spec.NAME);
  assert.equal(firstClick.body.job.videoModelRequestId, choice.id);
  assert.equal((await click(choice.id)).status, 409);
  const remembered = await tools.executeTool(ctx, 'generate_video', { ...args, prompt: 'Remembered' });
  assert.ok(remembered.job);
  assert.equal(submissions.length, 2);
  // A remembered choice also returns a readable card on immediate or late moderation.
  fail = true;
  const directEvents = [];
  const directRefusal = await tools.executeTool({ ...ctx, emit: (e) => directEvents.push(e) }, 'generate_video', args);
  fail = false;
  assert.equal(directRefusal.halt, true);
  assert.equal(directEvents.find((e) => e.type === 'video_model_choice').choice.lastErrorCode, 'FAL_CONTENT_CHECKER');
  await poller.handleFailed(session.id, remembered.job, { error: 'fal 422: content checker' });
  assert.ok((await store.readSession(session.id)).messages.some((m) => m.videoModelChoiceId));
  await video.clearPreference(session.id, viewerFor(ADMIN));

  const first = await store.saveAsset(session.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'start' });
  const frameArgs = { ...args, first_frame_asset_id: first.id };
  const frameChoice = await card(frameArgs);
  const frameClick = await click(frameChoice.id);
  assert.equal(frameClick.status, 201, frameClick.text);
  assert.deepEqual(submissions.at(-1), { endpoint: `${spec.BASE}/image-to-video`, input: { ...submissions[0].input, aspect_ratio: '1:1', image_url: `https://fal.media/${first.file}` } });
  assert.equal(uploads.length, 1);
  const invalid = Buffer.from(PNG); invalid.writeUInt32BE(1500, 16); invalid.writeUInt32BE(1000, 20);
  const wrong = await store.saveAsset(session.id, { kind: 'image', buffer: invalid, ext: '.png' });
  assert.equal((await video.listOptions({ ...args, first_frame_asset_id: wrong.id }, base, { sessionId: session.id })).options.some((o) => o.id === spec.MODEL), false);
  await assert.rejects(tools.executeTool({ ...ctx, config: { videoModel: spec.MODEL }, pickVideoModel: false }, 'generate_video', { ...args, first_frame_asset_id: wrong.id }), { code: 'VIDEO_FRAME_RATIO' });

  const nodeCtx = { sessionId: session.id };
  const value = await assetLib.valueFromAsset(session.id, first.id);
  const text = { type: 'text', value: 'Walk' };
  const params = { duration: 5, resolution: '720p', aspect_ratio: 'auto', reasoning_level: 'high', generate_audio: true };
  for (const [inputs, keyframes, mode] of [
    [{ prompt: text }, false, 'text-to-video'],
    [{ prompt: text, first_frame: value, last_frame: value }, false, 'image-to-video'],
    [{ prompt: text, images: { type: 'list', items: [value, value, value] } }, true, 'keyframes-to-video']
  ]) {
    const plan = await nodes.planFluxMax(nodeCtx, inputs, { ...params, keyframe_times: '0, 2.5, 5' }, keyframes);
    assert.equal(plan.endpoint, `${spec.BASE}/${mode}`);
    near(plan.estimateUsd, spec.price('720p', 5).maxTotal);
    const outcome = await tools.executeTool({ ...ctx, nodeView: true }, 'fal_generate', { ...plan, kind: 'video' });
    assert.ok(outcome.job);
    const input = submissions.at(-1).input;
    assert.equal(input.duration, 5);
    if (keyframes) assert.deepEqual(input.keyframes, [0, 60, 120].map((frame_index) => ({ image_url: `https://fal.media/${first.file}`, frame_index })));
    if (inputs.last_frame) assert.equal(input.end_image_url, input.image_url);
  }
  const beforeInvalid = [uploads.length, submissions.length];
  const single = await nodes.planFluxMax(nodeCtx, { prompt: text, images: { type: 'list', items: [value] } }, params, true);
  assert.deepEqual(single.input.keyframes, [{ image_url: '@@flux_max_image_0@@', frame_index: 0 }]);
  for (const count of [0, 11]) await assert.rejects(nodes.planFluxMax(nodeCtx, { prompt: text, images: { type: 'list', items: Array(count).fill(value) } }, params, true), (err) => err.code === 'FLUX_MAX_KEYFRAMES_COUNT');
  await assert.rejects(nodes.planFluxMax(nodeCtx, { prompt: text, last_frame: value }, params), /requires a start/);
  await assert.rejects(nodes.planFluxMax(nodeCtx, { prompt: text, first_frame: { ...value, file: 'test.gif' } }, params), /PNG, JPEG or WebP/);
  const large = await store.saveAsset(session.id, { kind: 'image', buffer: PNG, ext: '.png' });
  await fs.truncate(path.join(store.sessionAssetDir(session.id), large.file), fal.MAX_UPLOAD_BYTES + 1);
  await assert.rejects(nodes.planFluxMax(nodeCtx, { prompt: text, first_frame: await assetLib.valueFromAsset(session.id, large.id) }, params), /at most/);
  assert.deepEqual([uploads.length, submissions.length], beforeInvalid, 'invalid inputs never upload or submit');
  // A stale promotional card must reserve the list price at the cutoff, or refuse a budget that no longer fits.
  const stale = await card();
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-07T00:00:00Z');
  try {
    const oldRequest = await request(stale.id);
    near(video.publicChoice(oldRequest).options.find((o) => o.id === spec.MODEL).estimateUsd, 0.85);
    await assert.rejects(video.beginRequest({ sessionId: session.id, requestId: stale.id, selectedModel: spec.MODEL,
      budgetStatus: { remainingUsd: 0.3 } }), { code: 'BUDGET_INSUFFICIENT' });
    assert.equal((await request(stale.id)).status, 'pending');
  } finally { Date.now = realNow; }
  const beforeRefusal = submissions.length;
  const refusal = await card();
  fail = true;
  assert.equal((await click(refusal.id)).status, 422);
  fail = false;
  assert.equal((await request(refusal.id)).status, 'pending');
  assert.equal((await request(refusal.id)).lastErrorCode, 'FAL_CONTENT_CHECKER');
  assert.equal(submissions.length, beforeRefusal);
  assert.equal((await click(refusal.id)).status, 201, 'a corrected retry can start');
  const refusedJob = (await store.readSession(session.id)).jobs.at(-1);
  await poller.handleFailed(session.id, refusedJob, { error: 'fal 422: content checker' });
  assert.equal((await request(refusal.id)).status, 'pending', 'late moderation reopens the card too');

  const team = load('teams').createTeam({ name: 'Flux test', budgetUsd: 0.1 });
  load('teams').addMembers(team.id, [MEMBER]);
  const memberChat = await store.createSession();
  const blocked = await card(args, { ...ctx, sessionId: memberChat.id, user: MEMBER });
  assert.equal(blocked.options.find((o) => o.id === spec.MODEL).blocked.reason, 'budget');
  const beforeBudget = submissions.length;
  assert.equal((await click(blocked.id, spec.MODEL, false, MEMBER, memberChat.id)).status, 402);
  assert.equal(submissions.length, beforeBudget);
  // A sufficient budget reserves the same amount as the card, until the poller settles it.
  load('teams').updateTeam(team.id, { budgetUsd: 10 });
  const granted = await click(blocked.id, spec.MODEL, false, MEMBER, memberChat.id);
  assert.equal(granted.status, 201, granted.text);
  const budgetStatus = await load('budget').status(viewerFor(MEMBER));
  assert.ok(budgetStatus);
  assert.ok(granted.body.job.budgetKey);
  near(budgetStatus.reservedUsd, spec.price('720p', 5).maxTotal);
  // The normal fal completion saves the video, keeps its model name, settles the grant and writes the journal.
  fal.downloadToFile = async (_url, file) => {
    await fs.writeFile(file, Buffer.from('0000ftypisom00000000'));
    return { contentType: 'video/mp4' };
  };
  const result = { video: { url: 'https://fal.media/result.mp4', content_type: 'video/mp4', width: 1280, height: 720,
    duration: 5.04, fps: 24, num_frames: 121 }, seed: 123 };
  await poller.handleFalCompleted(memberChat.id, granted.body.job, result, fal.extractMedia(result, 'video'));
  const saved = (await store.readLedger(memberChat.id)).find((e) => e.id === granted.body.job.assetId);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.duration, 5.04);
  assert.equal(saved.modelName, spec.NAME);
  near(saved.cost, granted.body.job.costEstimateUsd);
  near((await load('budget').status(viewerFor(MEMBER))).reservedUsd, 0);
  const journal = await load('costs').readCosts();
  assert.ok(journal.some((entry) => entry.assetId === saved.id && entry.model === spec.NAME));
  // An abort before the tool starts never queues another request.
  const controller = new AbortController(); controller.abort();
  const beforeAbort = submissions.length;
  await assert.rejects(tools.executeTool({ ...ctx, signal: controller.signal, selectedVideoModel: true,
    config: { videoModel: spec.MODEL } }, 'generate_video', args), { name: 'AbortError' });
  assert.equal(submissions.length, beforeAbort);

}

async function main() {
  pureTests();
  const iso = await createIsolatedApp({ active: false, env: { ADMIN_EMAILS: ADMIN, AUTH_WHOAMI_URL: 'http://unused.invalid' } });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network forbidden in FLUX Max tests'); };
  try { await integration(iso); }
  finally {
    global.fetch = originalFetch;
    await iso.cleanup();
  }
  console.log('test-flux-3-max.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
