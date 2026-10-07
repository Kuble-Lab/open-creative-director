'use strict';

// Price and model on every result of the chat (WP19). A private copy of the app runs in a temp directory (own data
// folders, ephemeral port). OpenRouter, ElevenLabs, fal.ai and Higgsfield are local doubles and a fetch guard refuses
// everything except localhost, so nothing is paid and nothing leaves the machine.
//
//   server  the model (and a readable name) is recorded on the ledger entry of generate_image, edit_image,
//           generate_speech, generate_video (card click and remembered model), fal and Higgsfield jobs; assetsWithUrls
//           and jobsWithUrls serve it for every kind; old entries without a model stay without one; the estimate of the
//           model card is kept on the video job; Higgsfield is billed in credits
//   client  the meta line for image, video and audio, readable names with a fallback, a running job with its estimate,
//           Higgsfield without USD, free local results without a price, no innerHTML, texts in all languages

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const SEEDANCE = 'bytedance/seedance-2.5';
const KLING = 'kwaivgi/kling-v3.0-std';
const PRIME = 'alibaba/wan-3.0-prime';
const UNNAMED = 'acme/foo-video-1';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const MODEL_LIST = {
  data: [
    { id: SEEDANCE, name: 'ByteDance: Seedance 2.5', pricing_skus: { video_tokens: '0.0000107' }, supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9', '9:16'], supported_durations: range(4, 30), supported_frame_images: ['first_frame'] },
    { id: KLING, name: 'Kling: Video v3.0 Standard', pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126' }, supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9', '9:16'], supported_durations: range(3, 15), supported_frame_images: ['first_frame'] },
    { id: PRIME, name: 'Alibaba: Wan 3.0 Prime', pricing_skus: { duration_seconds_720p: '0.2' }, supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9'], supported_durations: range(2, 15), supported_frame_images: ['first_frame'] },
    { id: UNNAMED, pricing_skus: { duration_seconds_720p: '0.1' }, supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9'], supported_durations: range(2, 15), supported_frame_images: ['first_frame'] }
  ]
};

function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return { attempts, restore() { global.fetch = original; } };
}

function scriptedDirector(or) {
  const rounds = [];
  or.chatStream = async () => {
    const round = rounds.shift() || { text: 'Okay.' };
    const lines = [];
    if (round.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: round.text } }] })}`, '');
    (round.tools || []).forEach((call, index) => {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] } }] })}`, '');
    });
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: round.tools ? 'tool_calls' : 'stop' }] })}`, '', 'data: [DONE]', '');
    return new Response(lines.join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { say: (round) => rounds.push(round) };
}

function parseEvents(text) {
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()));
}

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      ELEVENLABS_API_KEY: 'el-test-key-with-enough-length',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await runServer(iso);
  } finally {
    await iso.cleanup();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  runClient();
  console.log('Preis und Modell am Ergebnis: Modell am Ledger-Eintrag, Anzeigenamen, Schaetzung am Video-Job, Higgsfield in Credits, alte Eintraege ohne Modell, Meta-Zeile fuer Bild/Video/Audio und Texte sind korrekt.');
  console.log('test-result-meta.js: ok');
}

async function runServer(iso) {
  const api = iso.request;
  const store = iso.load('lib/store');
  const or = iso.load('lib/openrouter');
  const discovery = iso.load('lib/discovery');
  const tools = iso.load('lib/tools');
  const elevenlabs = iso.load('lib/elevenlabs');
  const fal = iso.load('lib/fal');
  const higgsfield = iso.load('lib/higgsfield');
  const resultMeta = iso.load('lib/result-meta');
  const videoModels = iso.load('lib/video-models');

  discovery.brainSupportsImages = async () => true;
  or.listVideoModels = async () => JSON.parse(JSON.stringify(MODEL_LIST));
  let imageCalls = 0;
  or.createImage = async (payload) => {
    imageCalls += 1;
    return { data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 }, model: 'something-else/routed', requested: payload.model };
  };
  elevenlabs.tts = async () => Buffer.from('ID3-test-mp3');
  const submittedVideos = [];
  or.createVideo = async (payload) => {
    submittedVideos.push(payload);
    return { id: `job-${submittedVideos.length}`, status: 'pending', polling_url: 'http://127.0.0.1:1/x' };
  };
  const director = scriptedDirector(or);

  const newChat = async () => (await api('/api/sessions', { method: 'POST', as: ADMIN, json: {} })).body.session;
  const detail = async (id) => (await api(`/api/sessions/${id}`, { as: ADMIN })).body;
  const config = { imageModel: 'openai/gpt-image-2', videoModel: SEEDANCE };
  const call = (sessionId, name, args, extra = {}) => {
    const events = [];
    return tools.executeTool({ sessionId, config, emit: (event) => events.push(event), user: ADMIN, ...extra }, name, args)
      .then((outcome) => Object.assign(outcome, { events }));
  };

  // ============ 1. images: the model that was sent is recorded, not the model the answer names ============
  const chat = await newChat();
  const generated = await call(chat.id, 'generate_image', { prompt: 'A red kite over a beach.' });
  let ledger = await store.readLedger(chat.id);
  assert.equal(ledger[0].model, 'openai/gpt-image-2', 'the model of the request');
  assert.equal(ledger[0].cost, 0.04);
  const assetEvent = generated.events.find((event) => event.type === 'asset');
  assert.equal(assetEvent.asset.model, 'openai/gpt-image-2');
  assert.equal(assetEvent.asset.modelName, 'GPT Image 2', 'the live card gets the readable name at once');
  const edited = await call(chat.id, 'edit_image', { prompt: 'Make it dusk.', reference_asset_ids: [ledger[0].id] }, { config: { ...config, imageModel: 'google/gemini-3.1-flash-image' } });
  ledger = await store.readLedger(chat.id);
  assert.equal(ledger[1].model, 'google/gemini-3.1-flash-image');
  assert.equal(edited.events.find((event) => event.type === 'asset').asset.modelName, 'Nano Banana 2');
  assert.equal(imageCalls, 2);

  // ============ 2. speech ============
  const spoken = await call(chat.id, 'generate_speech', { text: 'Hallo zusammen.' });
  ledger = await store.readLedger(chat.id);
  const speech = ledger.find((entry) => entry.kind === 'audio');
  assert.equal(speech.model, 'elevenlabs/eleven_v4', 'the Director speaks with Eleven v4 unless it names a model');
  assert.equal(spoken.events.find((event) => event.type === 'asset').asset.modelName, 'ElevenLabs v4');
  // the estimate per character is booked for everybody (internal people included): the card must not show it as the price the provider charged
  assert.equal(speech.costEstimated, true);
  assert.ok(speech.cost > 0);
  const paid = await call(chat.id, 'generate_speech', { text: 'Mit Budget.' }, { budgetGrant: { applies: true } });
  const paidEntry = (await store.readLedger(chat.id)).find((entry) => entry.id === paid.asset.id);
  assert.ok(paidEntry.cost > 0);
  assert.equal(paidEntry.costEstimated, true, 'the speech estimate is marked in the ledger');
  assert.equal(paid.events.find((event) => event.type === 'asset').asset.costEstimated, true, 'the live card gets the mark at once');
  assert.equal((await detail(chat.id)).assets.find((asset) => asset.id === paid.asset.id).costEstimated, true, 'and the reloaded chat');
  assert.equal(generated.events.find((event) => event.type === 'asset').asset.costEstimated, undefined, 'a price from the provider is not marked');
  await call(chat.id, 'generate_speech', { text: 'Noch einmal.', model_id: 'eleven_turbo_v2_5' });
  assert.equal((await store.readLedger(chat.id)).filter((entry) => entry.kind === 'audio').at(-1).model, 'elevenlabs/eleven_turbo_v2_5');
  const turbo = await call(chat.id, 'generate_speech', { text: 'Und schnell.', model_id: 'eleven_v4_turbo' });
  assert.equal(turbo.events.find((event) => event.type === 'asset').asset.modelName, 'ElevenLabs v4 Turbo');
  // every model the speech node offers has a readable name of its own, not the slug
  for (const [id, name] of [
    ['eleven_v4', 'ElevenLabs v4'],
    ['eleven_v4_turbo', 'ElevenLabs v4 Turbo'],
    ['eleven_v3', 'ElevenLabs v3'],
    ['eleven_v3_conversational', 'ElevenLabs v3 Conversational'],
    ['eleven_multilingual_v2', 'ElevenLabs Multilingual v2'],
    ['eleven_flash_v2_5', 'ElevenLabs Flash v2.5'],
    ['eleven_turbo_v2_5', 'ElevenLabs Turbo v2.5'],
    ['eleven_flash_v2', 'ElevenLabs Flash v2'],
    ['eleven_turbo_v2', 'ElevenLabs Turbo v2']
  ]) {
    assert.equal(resultMeta.displayName(`elevenlabs/${id}`), name, id);
  }

  // ============ 3. the tool message of a turn carries the model, the reloaded chat serves it for every kind ============
  // A turn runs with the image model of the app's own configuration (config.json), whichever it is.
  const runtimeImageModel = (await api('/api/config', { as: ADMIN })).body.imageModel;
  assert.ok(runtimeImageModel, 'the app names its image model');
  const turnChat = await newChat();
  director.say({ text: 'Ich male es.', tools: [{ name: 'generate_image', args: { prompt: 'A lighthouse at night.' } }] });
  director.say({ text: 'Fertig.' });
  const turn = await api(`/api/sessions/${turnChat.id}/message`, { method: 'POST', as: ADMIN, json: { text: 'Bild bitte', brainModel: 'brain-test' } });
  assert.equal(turn.status, 200, turn.text);
  const liveAsset = parseEvents(turn.text).find((event) => event.type === 'asset');
  assert.equal(liveAsset.asset.modelName, resultMeta.displayName(runtimeImageModel));
  const toolMessage = (await store.readSession(turnChat.id)).messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.assets[0].model, runtimeImageModel, 'the stored tool message keeps the model');
  assert.equal(toolMessage.assets[0].modelName, resultMeta.displayName(runtimeImageModel));
  assert.equal(toolMessage.assets[0].cost, 0.04);

  const reloaded = await detail(chat.id);
  const byId = new Map(reloaded.assets.map((asset) => [asset.id, asset]));
  assert.equal(byId.get('img-001').model, 'openai/gpt-image-2');
  assert.equal(byId.get('img-001').modelName, 'GPT Image 2');
  assert.equal(byId.get('img-002').modelName, 'Nano Banana 2');
  assert.equal(byId.get(speech.id).modelName, 'ElevenLabs v4');

  // ============ 4. old entries stay without a model: nothing is guessed, the configured model is not put in ============
  const old = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'old', cost: 0.07 });
  const oldVideo = await store.saveAsset(chat.id, { kind: 'video', buffer: Buffer.from('v'), ext: '.mp4', prompt: 'old video', cost: 0.5 });
  const upload = await store.saveAsset(chat.id, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'upload', cost: null });
  assert.equal(old.model, undefined);
  const afterOld = new Map((await detail(chat.id)).assets.map((asset) => [asset.id, asset]));
  for (const id of [old.id, oldVideo.id, upload.id]) {
    assert.equal(afterOld.get(id).model, undefined, `${id} has no model`);
    assert.equal(afterOld.get(id).modelName, undefined);
    assert.equal(afterOld.get(id).billing, undefined);
  }
  assert.equal(afterOld.get(old.id).cost, 0.07, 'the price stays');
  // a model that is too long or not a string is not recorded
  const odd = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'odd', model: 'x'.repeat(500) });
  assert.equal(odd.model, undefined);

  // ============ 5. video from the model card: model, readable name and the estimate stay on the job ============
  const videoChat = await newChat();
  const askVideo = (args = {}) => ({ prompt: 'A calm walk through a quiet street.', mode: 'text_to_video', duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9', ...args });
  const card = await call(videoChat.id, 'generate_video', askVideo(), { pickVideoModel: true });
  assert.equal(card.halt, true);
  const choice = card.events.find((event) => event.type === 'video_model_choice').choice;
  assert.equal(choice.options.find((option) => option.id === KLING).name, 'Kling v3.0 Standard');
  const click = await api(`/api/sessions/${videoChat.id}/video-model-requests/${choice.id}`, { method: 'POST', as: ADMIN, json: { model: KLING, remember: true } });
  assert.equal(click.status, 201, click.text);
  assert.equal(submittedVideos.length, 1);
  const savedVideo = await store.readSession(videoChat.id);
  const klingJob = savedVideo.jobs[0];
  assert.equal(klingJob.model, KLING);
  assert.equal(klingJob.modelName, 'Kling v3.0 Standard');
  assert.equal(klingJob.estimateUsd, 0.63, 'the upper end, what the budget reserves');
  assert.equal(klingJob.estimateMinUsd, 0.42);
  const klingEntry = (await store.readLedger(videoChat.id)).find((entry) => entry.id === klingJob.assetId);
  assert.equal(klingEntry.model, KLING, 'the reserved asset records the model at once');
  assert.equal(click.body.job.modelName, 'Kling v3.0 Standard');
  assert.equal(click.body.job.estimateUsd, 0.63);
  assert.equal(click.body.job.billing, null);
  const served = await detail(videoChat.id);
  assert.equal(served.jobs[0].modelName, 'Kling v3.0 Standard');
  assert.equal(served.jobs[0].estimateMinUsd, 0.42);
  assert.equal(served.assets.find((asset) => asset.id === klingJob.assetId).modelName, 'Kling v3.0 Standard');
  assert.equal((await api(`/api/sessions/${videoChat.id}/jobs`, { as: ADMIN })).body.jobs[0].estimateUsd, 0.63);

  // the remembered model starts without a card and keeps the estimate and the name too
  const direct = await call(videoChat.id, 'generate_video', askVideo({ prompt: 'A second shot.' }), { pickVideoModel: true });
  assert.ok(direct.job && !direct.halt);
  const directJob = (await store.readSession(videoChat.id)).jobs.at(-1);
  assert.equal(directJob.modelName, 'Kling v3.0 Standard');
  assert.equal(directJob.estimateUsd, 0.63);
  const directEvent = direct.events.find((event) => event.type === 'video_job');
  assert.equal(directEvent.modelName, 'Kling v3.0 Standard');
  assert.equal(directEvent.estimateUsd, 0.63);
  assert.equal(directEvent.estimateMinUsd, 0.42);

  // ============ 6. a catalogue name loses the provider in front; the slug is the fallback ============
  const primeChat = await newChat();
  const primeCard = await call(primeChat.id, 'generate_video', askVideo(), { pickVideoModel: true, config: { ...config, videoModel: PRIME } });
  const primeChoice = primeCard.events.find((event) => event.type === 'video_model_choice').choice;
  assert.equal(primeChoice.options.find((option) => option.id === PRIME).name, 'Wan 3.0 Prime', 'no "Alibaba: " in front');
  await api(`/api/sessions/${primeChat.id}/video-model-requests/${primeChoice.id}`, { method: 'POST', as: ADMIN, json: { model: PRIME } });
  const primeServed = await detail(primeChat.id);
  assert.equal(primeServed.jobs[0].modelName, 'Wan 3.0 Prime');
  assert.equal(primeServed.assets.find((asset) => asset.id === primeServed.jobs[0].assetId).modelName, 'Wan 3.0 Prime');
  // a catalogue model without a name: the slug without the provider on the card, the job and the result, the same everywhere
  const unnamedChat = await newChat();
  const unnamedCard = await call(unnamedChat.id, 'generate_video', askVideo(), { pickVideoModel: true, config: { ...config, videoModel: UNNAMED } });
  const unnamedChoice = unnamedCard.events.find((event) => event.type === 'video_model_choice').choice;
  assert.equal(unnamedChoice.options.find((option) => option.id === UNNAMED).name, 'foo-video-1', 'the card shows no provider');
  await api(`/api/sessions/${unnamedChat.id}/video-model-requests/${unnamedChoice.id}`, { method: 'POST', as: ADMIN, json: { model: UNNAMED } });
  const unnamedServed = await detail(unnamedChat.id);
  assert.equal(unnamedServed.jobs[0].modelName, 'foo-video-1');
  assert.equal(unnamedServed.assets.find((asset) => asset.id === unnamedServed.jobs[0].assetId).modelName, 'foo-video-1', 'the result shows the same name as the card');
  // a request stored with the old name is shortened on the way out
  await store.mutateSession(primeChat.id, (session) => {
    session.videoModelRequests.push({ id: 'vmr-old', status: 'cancelled', prompt: 'x', options: [{ id: PRIME, name: 'Alibaba: Wan 3.0 Prime', price: null, estimateUsd: null }], createdAt: new Date().toISOString() });
  });
  assert.equal(videoModels.publicChoice((await store.readSession(primeChat.id)).videoModelRequests.find((request) => request.id === 'vmr-old')).options[0].name, 'Wan 3.0 Prime');
  assert.equal(resultMeta.displayName('acme/some-model-9', ''), 'some-model-9', 'the slug without the provider');
  assert.equal(resultMeta.displayName('acme/some-model-9', 'Acme: Some Model 9'), 'Some Model 9');
  assert.equal(resultMeta.displayName('bytedance/seedance-2.5', 'whatever'), 'Seedance 2.5', 'the curated name wins');
  assert.equal(resultMeta.displayName('openai/gpt-image-2.5-sunburst'), 'GPT Image 2.5 Sunburst');
  assert.equal(resultMeta.displayName('openai/gpt-image-2.5-flare'), 'GPT Image 2.5 Flare');
  assert.equal(resultMeta.displayName('google/gemini-nano-banana-2.1'), 'Nano Banana 2.1');
  assert.equal(resultMeta.displayName('fal-ai/flux/dev'), 'flux/dev');
  assert.equal(resultMeta.displayName('acme/foo-video-1', 'acme/foo-video-1'), 'foo-video-1', 'a stored full slug is no name');
  assert.equal(resultMeta.displayName(''), '');
  assert.equal(resultMeta.displayName('x'.repeat(200)), '', 'an unusable id gives no name');
  assert.deepEqual(resultMeta.describe({ kind: 'image' }), {});
  assert.deepEqual(resultMeta.describe({ model: 'acme/x', modelName: 'A: B' }), { model: 'acme/x', modelName: 'B' });
  assert.equal(resultMeta.displayName('acme/<b>x</b>', 'Acme: <i>Name</i>'), '<i>Name</i>', 'foreign text stays text (the client uses textContent)');

  // ============ 7. fal and Higgsfield jobs record the model; Higgsfield is billed in credits ============
  const mixChat = await newChat();
  fal.hasKey = () => true;
  fal.submit = async (endpoint) => ({ requestId: 'fal-req-1', statusUrl: `https://queue.fal.run/${endpoint}/status`, responseUrl: `https://queue.fal.run/${endpoint}` });
  const falEvents = [];
  const falRun = await tools.executeTool(
    { nodeView: true, sessionId: mixChat.id, user: ADMIN, config, emit: (event) => falEvents.push(event) },
    'fal_generate',
    { endpoint: 'fal-ai/flux/dev', input: { prompt: 'A cat' }, kind: 'image', estimateUsd: 0.03 }
  );
  const falEntry = (await store.readLedger(mixChat.id)).find((entry) => entry.id === falRun.job.assetId);
  assert.equal(falEntry.model, 'fal-ai/flux/dev');
  assert.equal(falEvents.find((event) => event.type === 'generation_job').modelName, 'flux/dev');
  assert.equal(falEvents.find((event) => event.type === 'generation_job').billing, undefined, 'fal is billed in USD');

  higgsfield.status = () => ({ connected: true, refreshExpiresAt: Date.now() + 10000, pending: false });
  higgsfield.mcpCall = async () => 'Submitted. Job: 7e1f2c4a-3b5d-4e6f-8a9b-0c1d2e3f4a5b';
  const hfEvents = [];
  const hfRun = await tools.executeTool(
    { sessionId: mixChat.id, user: ADMIN, config, emit: (event) => hfEvents.push(event) },
    'higgsfield_generate_image',
    { model: 'nano_banana_2', prompt: 'A lamp' }
  );
  const hfEntry = (await store.readLedger(mixChat.id)).find((entry) => entry.id === hfRun.job.assetId);
  assert.equal(hfEntry.model, 'nano_banana_2');
  const hfEvent = hfEvents.find((event) => event.type === 'generation_job');
  assert.equal(hfEvent.billing, 'credits');
  assert.equal(hfEvent.model, 'nano_banana_2');
  assert.equal(hfEvent.modelName, 'nano_banana_2');

  // a finished Higgsfield job: the result assets (also the further ones) are credits, never "$0.00"
  const hfFirst = await store.saveAsset(mixChat.id, { kind: 'video', buffer: Buffer.from('v'), ext: '.mp4', prompt: 'hf', cost: 0 });
  const hfSecond = await store.saveAsset(mixChat.id, { kind: 'video', buffer: Buffer.from('v'), ext: '.mp4', prompt: 'hf', cost: 0 });
  await store.mutateSession(mixChat.id, (session) => {
    session.jobs.push({ jobId: 'hf-job-2', provider: 'higgsfield', source: 'higgsfield', kind: 'video', assetId: hfFirst.id, status: 'completed', prompt: 'hf', model: 'seedance_2_0', cost: 0, costUnit: 'higgsfield_credits', resultAssetIds: [hfFirst.id, hfSecond.id], file: hfFirst.file, submittedAt: new Date().toISOString() });
  });
  const mixServed = await detail(mixChat.id);
  const mixAssets = new Map(mixServed.assets.map((asset) => [asset.id, asset]));
  for (const asset of [hfFirst, hfSecond]) {
    assert.equal(mixAssets.get(asset.id).billing, 'credits');
    assert.equal(mixAssets.get(asset.id).model, 'seedance_2_0', 'from the job, because the entry has none');
  }
  assert.equal(mixServed.jobs.find((job) => job.jobId === 'hf-job-2').billing, 'credits');
  assert.equal(mixServed.jobs.find((job) => job.jobId === 'fal-req-1').billing, null);
  // the poller records the model on the further results of a job too
  const poller = iso.load('lib/poller');
  assert.equal(typeof poller.handleHiggsfieldCompleted, 'function');
  const pollerSource = await fsp.readFile(path.join(iso.root, 'lib', 'poller.js'), 'utf8');
  assert.match(pollerSource, /cost: 0,\s+model: job\.model/);

  // fal: the list price is an estimate and stays marked from the ledger to the card
  const falDone = await store.saveAsset(mixChat.id, { kind: 'video', buffer: Buffer.from('v'), ext: '.mp4', prompt: 'fal', cost: 0.56, costEstimated: true, model: 'fal-ai/veo3' });
  const falPending = await store.reserveAsset(mixChat.id, { kind: 'video', ext: '.mp4', prompt: 'fal', model: 'fal-ai/veo3' });
  const falTemp = path.join(store.sessionAssetDir(mixChat.id), '.fal-test.part');
  await fsp.writeFile(falTemp, 'v');
  const falFinished = await store.completeAssetFile(mixChat.id, falPending.id, falTemp, { cost: 0.4, costEstimated: true });
  assert.equal(falFinished.costEstimated, true);
  const ledgerAfterFal = new Map((await detail(mixChat.id)).assets.map((asset) => [asset.id, asset]));
  assert.equal(ledgerAfterFal.get(falDone.id).costEstimated, true);
  assert.equal(ledgerAfterFal.get(falPending.id).costEstimated, true);
  const plain = await store.saveAsset(mixChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'img', cost: 0.04 });
  assert.equal(plain.costEstimated, undefined, 'a provider price is not an estimate');
  const pollerFal = await fsp.readFile(path.join(iso.root, 'lib', 'poller.js'), 'utf8');
  assert.match(pollerFal, /costEstimated: cost !== null/, 'the fal poller marks the list price as an estimate');
  await store.mutateSession(mixChat.id, (session) => {
    session.jobs.push({ jobId: 'fal-done', provider: 'fal', source: 'fal', kind: 'video', assetId: falPending.id, status: 'completed', prompt: 'fal', model: 'fal-ai/veo3', cost: 0.4, costEstimated: true, resultAssetIds: [falPending.id], file: falPending.file, submittedAt: new Date().toISOString() });
  });
  assert.equal((await detail(mixChat.id)).jobs.find((job) => job.jobId === 'fal-done').costEstimated, true);

  // a local free result and the render node
  const concat = await store.saveAsset(mixChat.id, { kind: 'video', buffer: Buffer.from('v'), ext: '.mp4', prompt: 'cut', cost: 0 });
  assert.equal(new Map((await detail(mixChat.id)).assets.map((asset) => [asset.id, asset])).get(concat.id).model, undefined, 'a cut has no model');
}

/* ---------- client ---------- */

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this.className = '';
    this.title = '';
  }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  find(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.children) child.find(predicate, out);
    return out;
  }
}

function runClient() {
  const fs = require('fs');
  const root = path.resolve(__dirname, '..');
  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const i18nSource = fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8');

  // texts in all languages
  const window = { document: { documentElement: { lang: '' }, querySelectorAll() { return []; } }, navigator: { language: 'de-CH' }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(i18nSource, { window }, { filename: 'public/i18n.js' });
  for (const lang of ['de', 'en', 'es']) {
    for (const key of ['assets.model', 'assets.credits', 'jobs.estimate', 'jobs.durationInline', 'jobs.duration']) {
      assert.equal(typeof window.I18N[lang][key], 'string', `${lang}.${key}`);
    }
    assert.match(window.I18N[lang]['jobs.estimate'], /\{amount\}/);
    assert.match(window.I18N[lang]['assets.model'], /\{model\}/);
  }
  assert.equal(window.I18N.de['assets.credits'], 'Higgsfield-Credits');

  // the builders, cut out of the app and run against a tiny DOM
  const formatCost = /function formatCost\(cost\) \{[\s\S]*?\n\}\n/.exec(appSource)[0];
  // a failed job with a known cause (the provider refused the image after the start) says it in the interface language
  const providerRuleMessage = /function providerRuleMessage\(code\) \{[\s\S]*?\n\}\n/.exec(appSource)[0];
  const start = appSource.indexOf('/* ---------- element builders ---------- */');
  const end = appSource.indexOf('function videoModelPriceLabel');
  assert.ok(start > 0 && end > start, 'the builders are in public/app.js');
  const section = appSource.slice(start, end);
  assert.doesNotMatch(section, /innerHTML|insertAdjacentHTML|outerHTML/, 'result cards never build markup from provider data');
  assert.doesNotMatch(section, /videoModelShortName/, 'the name comes from the server, not from the slug');

  const lang = 'de';
  const context = {
    document: { createElement: (tag) => new FakeElement(tag) },
    rel: (url) => url,
    openLightbox() {},
    i18nHas: (key) => Object.prototype.hasOwnProperty.call(window.I18N[lang], key),
    t: (key, vars = {}) => String(window.I18N[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '')
  };
  vm.runInNewContext(`${formatCost}\n${providerRuleMessage}\n${section}\nthis.api = { assetMeta, jobCard, mediaCard, assetPriceLabel };`, context, { filename: 'public/app.js (builders)' });
  const { assetMeta, jobCard, mediaCard, assetPriceLabel } = context.api;
  const lineOf = (node) => node.children.map((child) => child.textContent).join(' · ');

  // images, video and audio: the same line
  assert.equal(lineOf(assetMeta({ id: 'img-001', kind: 'image', cost: 0.04, model: 'openai/gpt-image-2', modelName: 'GPT Image 2' })), 'img-001 · $0.04 · GPT Image 2');
  assert.equal(lineOf(assetMeta({ id: 'vid-002', kind: 'video', cost: 0.84, model: KLING, modelName: 'Kling v3.0 Standard' })), 'vid-002 · $0.84 · Kling v3.0 Standard');
  assert.equal(lineOf(assetMeta({ id: 'aud-001', kind: 'audio', cost: 0.0045, model: 'elevenlabs/eleven_multilingual_v2', modelName: 'ElevenLabs Multilingual v2' })), 'aud-001 · $0.0045 · ElevenLabs Multilingual v2');
  const withModel = assetMeta({ id: 'img-003', kind: 'image', cost: 0.04, model: 'openai/gpt-image-2', modelName: 'GPT Image 2' });
  assert.equal(withModel.children[2].title, 'Modell: openai/gpt-image-2', 'the full id is the hover text');
  assert.ok(withModel.children[2].className === 'asset-model');
  // an old asset: price only; nothing else is made up
  assert.equal(lineOf(assetMeta({ id: 'img-009', kind: 'image', cost: 0.07 })), 'img-009 · $0.07');
  assert.equal(lineOf(assetMeta({ id: 'upl-001', kind: 'upload', cost: null })), 'upl-001');
  assert.equal(lineOf(assetMeta({ id: 'vid-009', kind: 'video', model: KLING })), 'vid-009', 'an id without a name from the server shows no model line');
  // an estimate (fal list price, speech flat rate) says "about"; a price the provider charged does not
  assert.equal(lineOf(assetMeta({ id: 'aud-002', kind: 'audio', cost: 0.0045, costEstimated: true, model: 'elevenlabs/eleven_multilingual_v2', modelName: 'ElevenLabs Multilingual v2' })), 'aud-002 · ca. $0.0045 · ElevenLabs Multilingual v2');
  assert.equal(assetPriceLabel({ cost: 0.56, costEstimated: true }), 'ca. $0.56');
  assert.equal(assetPriceLabel({ cost: 0.56, costEstimated: false }), '$0.56');
  assert.equal(assetPriceLabel({ cost: 0, costEstimated: true }), '', 'an estimated zero is still no price');
  // no "$0.00" as a cost: free local results show no price
  assert.equal(lineOf(assetMeta({ id: 'vid-010', kind: 'video', cost: 0 })), 'vid-010');
  assert.equal(assetPriceLabel({ cost: 0 }), '');
  assert.equal(assetPriceLabel({ cost: null }), '');
  // Higgsfield: credits, no USD (the stored 0 is not a price)
  assert.equal(lineOf(assetMeta({ id: 'vid-011', kind: 'video', cost: 0, billing: 'credits', model: 'seedance_2_0', modelName: 'seedance_2_0' })), 'vid-011 · Higgsfield-Credits · seedance_2_0');
  // foreign text stays text
  const hostile = assetMeta({ id: 'img-004', kind: 'image', cost: 0.01, model: '<img src=x onerror=1>', modelName: '<img src=x onerror=1>' });
  assert.equal(hostile.children[2].textContent, '<img src=x onerror=1>');
  assert.equal(hostile.find((node) => node.tagName === 'img').length, 0, 'no element comes out of a model name');
  assert.equal(mediaCard({ id: 'aud-001', kind: 'audio', url: '/a', cost: 0.0045, modelName: 'X' }).find((node) => node.className === 'asset-meta').length, 1);
  assert.equal(mediaCard({ id: 'vid-001', kind: 'video', url: '/v' }).find((node) => node.className === 'asset-meta').length, 1);
  assert.equal(mediaCard({ id: 'img-001', kind: 'image', url: '/i' }).find((node) => node.className === 'asset-meta').length, 1);

  // a running job: name, the estimate of the card and the duration
  const small = (card) => card.find((node) => node.tagName === 'small')[0];
  const running = jobCard({ assetId: 'vid-002', status: 'in_progress', kind: 'video', model: KLING, modelName: 'Kling v3.0 Standard', estimateUsd: 0.84 });
  assert.equal(small(running).textContent, 'Kling v3.0 Standard · ca. $0.84 · dauert meist 2–5 Minuten');
  assert.equal(small(running).title, `Modell: ${KLING}`);
  assert.match(running.textContent, /Video-Job vid-002 läuft/);
  assert.equal(small(jobCard({ assetId: 'vid-003', status: 'pending', kind: 'video', modelName: 'Kling v3.0 Standard', estimateUsd: 0.63, estimateMinUsd: 0.42 })).textContent, 'Kling v3.0 Standard · ca. $0.42–$0.63 · dauert meist 2–5 Minuten', 'a range when the estimate has one');
  assert.equal(small(jobCard({ assetId: 'vid-004', status: 'pending', kind: 'video', modelName: 'Seedance 2.5' })).textContent, 'Seedance 2.5 · dauert meist 2–5 Minuten', 'no estimate: no price');
  assert.equal(small(jobCard({ assetId: 'vid-004b', status: 'pending', kind: 'video', modelName: 'Seedance 2.5', estimateUsd: null, estimateMinUsd: null })).textContent, 'Seedance 2.5 · dauert meist 2–5 Minuten', 'null is no estimate, not $0');
  assert.equal(small(jobCard({ assetId: 'vid-005', status: 'pending', kind: 'video' })).textContent, 'Dauert meist 2-5 Minuten', 'a job from before: as it was');
  assert.equal(small(jobCard({ assetId: 'vid-006', status: 'pending', kind: 'video', modelName: 'seedance_2_0', billing: 'credits', estimateUsd: 5 })).textContent, 'seedance_2_0 · Higgsfield-Credits · dauert meist 2–5 Minuten', 'Higgsfield shows credits, never USD');
  assert.equal(small(jobCard({ assetId: 'vid-007', status: 'pending', kind: 'video', modelName: 'HyperFrames' })).textContent, 'HyperFrames · dauert meist 2–5 Minuten', 'a local render has no price');
  assert.equal(small(jobCard({ assetId: 'vid-008', status: 'failed', kind: 'video', modelName: 'Kling v3.0 Standard', estimateUsd: 0.84, error: 'Boom' })).textContent, 'Boom · Kling v3.0 Standard', 'a failed job shows the reason, no estimate');
  assert.equal(small(jobCard({ assetId: 'vid-008b', status: 'failed', kind: 'video', modelName: 'Seedance 2.5', error: 'German fallback sentence', errorCode: 'VIDEO_REAL_PERSON_JOB' })).textContent, `${window.I18N.de['videoModel.error.VIDEO_REAL_PERSON_JOB']} · Seedance 2.5`, 'a known code: the sentence of the interface language');
  assert.equal(small(jobCard({ assetId: 'vid-008c', status: 'failed', kind: 'video', modelName: 'Seedance 2.5', error: 'Boom', errorCode: 'SOMETHING_UNKNOWN' })).textContent, 'Boom · Seedance 2.5', 'an unknown code: the stored text');

  // the other languages
  for (const [code, expected] of [['en', 'Kling v3.0 Standard · about $0.84 · usually takes 2–5 minutes'], ['es', 'Kling v3.0 Standard · aprox. $0.84 · suele tardar entre 2 y 5 minutos']]) {
    const localized = { ...context, t: (key, vars = {}) => String(window.I18N[code][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '') };
    vm.runInNewContext(`${formatCost}\n${providerRuleMessage}\n${section}\nthis.api = { jobCard };`, localized, { filename: `public/app.js (${code})` });
    assert.equal(small(localized.api.jobCard({ assetId: 'vid-002', status: 'pending', kind: 'video', modelName: 'Kling v3.0 Standard', estimateUsd: 0.84 })).textContent, expected);
    localized.i18nHas = (key) => Object.prototype.hasOwnProperty.call(window.I18N[code], key);
    assert.equal(small(localized.api.jobCard({ assetId: 'vid-008b', status: 'failed', kind: 'video', error: 'x', errorCode: 'VIDEO_REAL_PERSON_JOB' })).textContent, window.I18N[code]['videoModel.error.VIDEO_REAL_PERSON_JOB'], `${code}: the late refusal in the interface language`);
  }

  // the card of the model choice and the tool message use the same line
  assert.match(appSource, /modelName: job\.modelName \|\| asset\?\.modelName \|\| null/);
  assert.match(appSource, /billing: job\.billing \|\| asset\?\.billing \|\| null/);
  assert.match(appSource, /estimateUsd: event\.estimateUsd/);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
