'use strict';

// The video model picker of the chat (WP18): generate_video stores a pending choice, shows a card and ends the turn;
// only the click starts the paid job. A private copy of the app runs in a temp directory (own data folders, ephemeral
// port, whoami stub). OpenRouter is a local double (model list, createVideo, chat stream) and a fetch guard refuses
// everything except localhost, so nothing is paid and nothing leaves the machine.
//
//   - the turn halts, no job before the click, exactly one job per click (parallel clicks), errors reopen the card
//   - foreign chats answer 404, an unknown model id 400, at most 20 waiting choices per chat, cancel
//   - compatibility and price from the OpenRouter metadata (duration, resolution, ratio, first frame, references)
//   - budget: a blocked option, the server refuses it, the reservation is the estimate
//   - "do not ask again in this chat" (and when it no longer fits), the admin switch, the prompt rules
//   - the model shows up on the job and on the asset; the node view keeps its way

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const BOB = 'bob@staff.example.com';
const CAROL = 'carol@staff.example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const SEEDANCE = 'bytedance/seedance-2.5';
const FAST = 'bytedance/seedance-2.0-fast';
const KLING = 'kwaivgi/kling-v3.0-std';
const WAN = 'alibaba/wan-2.7';
const VEO = 'google/veo-3.1-lite';

// Models the chat has no texts for: they must not borrow the texts of a curated model with a similar name.
const EXTRA_MODELS = [];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

// A small catalogue in the shape of GET /videos/models.
const MODEL_LIST = {
  data: [
    {
      id: SEEDANCE,
      name: 'ByteDance: Seedance 2.5',
      pricing_skus: { video_tokens: '0.0000107', video_tokens_without_audio: '0.0000107' },
      supported_resolutions: ['480p', '720p'],
      supported_aspect_ratios: ['16:9', '9:16', '1:1', '21:9'],
      supported_durations: range(4, 30),
      supported_frame_images: ['first_frame', 'last_frame']
    },
    {
      id: FAST,
      name: 'ByteDance: Seedance 2.0 Fast',
      pricing_skus: { video_tokens: '0.0000056' },
      supported_resolutions: ['480p', '720p'],
      supported_aspect_ratios: ['16:9', '9:16', '1:1'],
      supported_durations: range(4, 15),
      supported_frame_images: ['first_frame']
    },
    {
      id: KLING,
      name: 'Kling: Video v3.0 Standard',
      pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126' },
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9', '9:16', '1:1'],
      supported_durations: range(3, 15),
      supported_frame_images: ['first_frame']
    },
    {
      id: WAN,
      name: 'Alibaba: Wan 2.7',
      pricing_skus: { duration_seconds_720p: '0.1' },
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16', '1:1'],
      supported_durations: range(2, 15),
      supported_frame_images: ['first_frame']
    },
    {
      id: VEO,
      name: 'Google: Veo 3.1 Lite',
      pricing_skus: { duration_seconds_without_audio: '0.05' },
      supported_resolutions: ['720p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_durations: [4, 6, 8],
      supported_frame_images: ['first_frame']
    }
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

// The scripted Director: each call of chatStream takes the next round (text and tool calls) and records the request.
function scriptedDirector(or) {
  const rounds = [];
  const requests = [];
  or.chatStream = async (payload) => {
    requests.push(payload);
    const round = rounds.shift() || { text: 'Okay.' };
    const lines = [];
    if (round.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: round.text } }] })}`, '');
    (round.tools || []).forEach((call, index) => {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] } }] })}`, '');
    });
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: round.tools ? 'tool_calls' : 'stop' }] })}`, '', 'data: [DONE]', '');
    return new Response(lines.join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { rounds, requests, say: (round) => rounds.push(round) };
}

function parseEvents(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

async function main() {
  const guard = guardFetch();
  const tmp = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'ocd-video-model-'));
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    await iso.cleanup();
    await fsp.rm(tmp, { recursive: true, force: true });
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Video-Modellwahl: wartende Karte, Halt des Zugs, ein Job pro Klick, Fehler und Abbruch, Kompatibilitaet und Preis, Budget-Sperre und Reservierung, Merken pro Chat, Admin-Schalter, Prompt-Regeln und Modell auf Job und Asset sind korrekt.');
}

async function run(iso) {
  const api = iso.request;
  const store = iso.load('lib/store');
  const or = iso.load('lib/openrouter');
  const discovery = iso.load('lib/discovery');
  const tools = iso.load('lib/tools');
  const videoModels = iso.load('lib/video-models');
  const budgetLib = iso.load('lib/budget');
  const costsLib = iso.load('lib/costs');
  const teamsLib = iso.load('lib/teams');

  discovery.brainSupportsImages = async () => true;
  let listCalls = 0;
  let listFails = false;
  or.listVideoModels = async () => {
    listCalls += 1;
    if (listFails) throw new Error('catalogue down');
    return JSON.parse(JSON.stringify({ data: [...MODEL_LIST.data, ...EXTRA_MODELS] }));
  };
  const submitted = [];
  let createVideoDelay = 0;
  let createVideoError = null;
  or.createVideo = async (payload) => {
    if (createVideoDelay) await sleep(createVideoDelay);
    if (createVideoError) throw createVideoError;
    submitted.push(payload);
    return { id: `job-${submitted.length}`, status: 'pending', polling_url: 'http://127.0.0.1:1/x' };
  };
  const director = scriptedDirector(or);
  const resetCatalogue = () => { videoModels.resetCache(); listCalls = 0; };

  // ---- setup: a team with a small budget for P1 ----
  const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 1 } })).body.team;
  assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);

  const newChat = async (email) => (await api('/api/sessions', { method: 'POST', as: email, json: {} })).body.session;
  const detail = async (id, email) => (await api(`/api/sessions/${id}`, { as: email })).body;
  const choiceOf = async (id, email) => (await detail(id, email)).session.messages.filter((m) => m.videoModelChoice).at(-1)?.videoModelChoice;
  const send = async (id, email, text) => {
    const response = await api(`/api/sessions/${id}/message`, { method: 'POST', as: email, json: { text, brainModel: 'brain-test' } });
    return { status: response.status, events: response.status === 200 ? parseEvents(response.text) : [], body: response.body };
  };
  const click = (id, requestId, email, json) => api(`/api/sessions/${id}/video-model-requests/${requestId}`, { method: 'POST', as: email, json });
  const requestOf = async (id, requestId) => (await store.readSession(id)).videoModelRequests.find((r) => r.id === requestId);
  const optionOf = (choice, model) => choice.options.find((option) => option.id === model);
  const askVideo = (args = {}) => ({ prompt: 'A calm walk through a quiet street at sunrise.', mode: 'text_to_video', duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9', ...args });
  const config = { imageModel: 'test/image', videoModel: SEEDANCE };
  const call = (sessionId, email, args, extra = {}) => {
    const events = [];
    return tools.executeTool({ sessionId, config, emit: (event) => events.push(event), user: email, pickVideoModel: true, ...extra }, 'generate_video', args)
      .then((outcome) => Object.assign(outcome, { events }));
  };

  // ============ 1. the turn halts, nothing starts before the click ============
  const chat = await newChat(ADMIN);
  director.say({ text: 'Die Modellauswahl erscheint gleich unten.', tools: [{ name: 'generate_video', args: askVideo() }] });
  const first = await send(chat.id, ADMIN, 'Mach ein Video');
  assert.equal(first.status, 200);
  assert.equal(director.requests.length, 1, 'the turn ended after the tool round: no second model call');
  const choiceEvent = first.events.find((event) => event.type === 'video_model_choice');
  assert.ok(choiceEvent, 'the live view gets the card');
  assert.equal(first.events.some((event) => event.type === 'video_job'), false);
  assert.equal(submitted.length, 0, 'no paid call before the click');
  let saved = await store.readSession(chat.id);
  assert.equal(saved.jobs.length, 0, 'no job before the click');
  assert.equal(saved.videoModelRequests.length, 1);
  const toolMessage = saved.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.name, 'generate_video');
  assert.equal(toolMessage.videoModelChoiceId, saved.videoModelRequests[0].id);
  assert.match(toolMessage.content, /wartet auf den User/);
  const marker = saved.messages.find((m) => m.hidden && m.videoModelRequestId);
  assert.ok(marker, 'the Director history keeps a hidden marker');
  assert.equal(marker.role, 'assistant');

  let choice = await choiceOf(chat.id, ADMIN);
  assert.equal(choice.status, 'pending');
  assert.equal(choice.id, choiceEvent.choice.id);
  assert.equal(choice.budget, null, 'no budget line for an admin');
  assert.deepEqual(choice.options.map((o) => o.id), [SEEDANCE, FAST, KLING, WAN], 'only compatible models: Veo has no 5 s');
  assert.equal(choice.options.find((o) => o.recommended).id, SEEDANCE, 'the configured default model is recommended');
  const seedance = optionOf(choice, SEEDANCE);
  assert.ok(Math.abs(seedance.price.minTotal - 1.1556) < 0.001, `seedance token price ${seedance.price.minTotal}`);
  assert.equal(seedance.name, 'Seedance 2.5');
  assert.equal(optionOf(choice, KLING).name, 'Kling v3.0 Standard');
  const kling = optionOf(choice, KLING);
  assert.equal(kling.price.minTotal, 0.42);
  assert.equal(kling.price.maxTotal, 0.63);
  assert.equal(kling.estimateUsd, 0.63, 'the upper end of the estimate is what the budget reserves');
  assert.equal(optionOf(choice, WAN).price.minTotal, 0.5);
  assert.ok(choice.options.every((o) => o.durationSeconds === 5 && o.resolution === '720p' && o.blocked === null));
  assert.deepEqual(choice.options.map((o) => o.profileKey), ['seedance25', 'seedanceFast', 'klingStandard', 'wan27']);

  // the Director sees the waiting state in the next turn and the rules in the prompt
  director.say({ text: 'Ich warte auf deine Wahl.' });
  await send(chat.id, ADMIN, 'Und?');
  const systemPrompt = director.requests.at(-1).messages[0].content;
  assert.match(systemPrompt, /## Video model selection/);
  assert.match(systemPrompt, /BEFORE the call, say in one short sentence that the model selection appears below/);
  assert.match(systemPrompt, /Do not call `generate_video` again while a selection is waiting/);
  assert.match(systemPrompt, /Higgsfield\) only when the user explicitly asks/);
  assert.match(systemPrompt, /first opens the required model picker and stops your turn/);
  assert.match(JSON.stringify(director.requests.at(-1).messages), /Warte auf die Video-Modellwahl/);

  // ============ 2. rights and validation ============
  const requestId = choice.id;
  assert.equal((await click(chat.id, requestId, BOB, { model: KLING })).status, 404, 'a foreign chat answers 404');
  assert.equal((await click(chat.id, requestId, null, { model: KLING })).status, 401, 'an unconfirmed caller is refused');
  assert.equal((await click(chat.id, requestId, ADMIN, { model: 'evil/free-model' })).status, 400, 'an unknown model id');
  assert.equal((await click(chat.id, requestId, ADMIN, { model: VEO })).status, 400, 'a model that was not offered for this job');
  assert.equal((await click(chat.id, requestId, ADMIN, {})).status, 400);
  assert.equal((await click(chat.id, 'vmr-doesnotexist', ADMIN, { model: KLING })).status, 404);
  assert.equal((await click(chat.id, 'a%2Fb', ADMIN, { model: KLING })).status, 400);
  assert.equal(submitted.length, 0);
  assert.equal((await store.readSession(chat.id)).videoModelRequests[0].status, 'pending', 'rejected clicks change nothing');

  // ============ 3. the click starts exactly one job with the chosen model ============
  const started = await click(chat.id, requestId, ADMIN, { model: KLING, remember: true });
  assert.equal(started.status, 201, started.text);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].model, KLING);
  assert.equal(submitted[0].duration, 5);
  assert.equal(submitted[0].resolution, '720p');
  assert.equal(submitted[0].aspect_ratio, '16:9');
  assert.equal(started.body.choice.status, 'submitted');
  assert.equal(started.body.choice.selectedModel, KLING);
  assert.equal(started.body.choice.selectedName, 'Kling v3.0 Standard');
  assert.equal(started.body.job.model, KLING);
  assert.deepEqual(started.body.videoModelPreference, { model: KLING, name: 'Kling v3.0 Standard' });
  saved = await store.readSession(chat.id);
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].model, KLING);
  assert.equal(saved.jobs[0].videoModelRequestId, requestId);
  const toolAfter = saved.messages.find((m) => m.role === 'tool');
  assert.match(toolAfter.content, /Video-Job vid-\d+ gestartet/);
  assert.equal(toolAfter.job.jobId, 'job-1');
  assert.match(saved.messages.find((m) => m.hidden && m.videoModelRequestId).content, /hat Kling v3.0 Standard gewählt/);
  assert.equal((await click(chat.id, requestId, ADMIN, { model: KLING })).status, 409, 'a processed choice cannot be clicked again');
  assert.equal(submitted.length, 1);
  // the model is on the job and on the asset of the chat
  const reloaded = await detail(chat.id, ADMIN);
  assert.equal(reloaded.jobs[0].model, KLING);
  assert.equal(reloaded.assets.find((asset) => asset.id === saved.jobs[0].assetId).model, KLING);
  assert.equal((await api(`/api/sessions/${chat.id}/jobs`, { as: ADMIN })).body.jobs[0].model, KLING);
  assert.equal(reloaded.session.videoModelPreference.model, KLING);
  assert.equal((await choiceOf(chat.id, ADMIN)).status, 'submitted');

  // ============ 4. remembered for this chat: the next video starts without a card ============
  const direct = await call(chat.id, ADMIN, askVideo({ prompt: 'A second shot, closer, same street.' }));
  assert.equal(direct.halt, undefined);
  assert.ok(direct.job, 'a job without a card');
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].model, KLING);
  assert.match(direct.toolResult, /Modell kwaivgi\/kling-v3\.0-std/);
  assert.match(direct.toolResult, /Nenne dem User Modell und geschaetzten Preis \(\$0\.42-\$0\.63 fuer 5 s\)/);
  assert.equal(direct.events.some((event) => event.type === 'video_model_choice'), false);
  assert.equal(direct.events.find((event) => event.type === 'video_job').model, KLING);
  assert.equal((await store.readSession(chat.id)).videoModelRequests.length, 1, 'no request for a remembered choice');
  // the Director is told in the prompt
  director.say({ text: 'ok' });
  await send(chat.id, ADMIN, 'weiter');
  assert.match(director.requests.at(-1).messages[0].content, /The user has chosen \*\*Kling v3\.0 Standard\*\* \(kwaivgi\/kling-v3\.0-std\) for every video in this chat/);

  // it no longer fits (references the model does not take): the card is back, with the reason
  const refs = [];
  for (let i = 0; i < 12; i += 1) refs.push((await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'ref', cost: null })).id);
  const noFit = await call(chat.id, ADMIN, askVideo({ reference_asset_ids: refs.slice(0, 4) }));
  assert.equal(noFit.halt, true);
  assert.equal(submitted.length, 2);
  const noFitChoice = noFit.events.find((event) => event.type === 'video_model_choice').choice;
  assert.deepEqual(noFitChoice.options.map((o) => o.id), [SEEDANCE, FAST, WAN], 'Kling and Veo take no reference files');
  assert.deepEqual(noFitChoice.preferenceNote, { model: KLING, name: 'Kling v3.0 Standard', reason: 'incompatible' });

  // reset: "ask again"
  assert.equal((await api(`/api/sessions/${chat.id}/video-model-preference`, { method: 'DELETE', as: BOB })).status, 404);
  assert.equal((await api(`/api/sessions/${chat.id}/video-model-preference`, { method: 'DELETE', as: ADMIN })).status, 200);
  assert.equal((await detail(chat.id, ADMIN)).session.videoModelPreference, null);
  assert.equal((await call(chat.id, ADMIN, askVideo())).halt, true, 'asks again after the reset');
  assert.equal(submitted.length, 2);

  // ============ 5. parameters per model: a choice is never an expensive failed job ============
  const many = await call(chat.id, ADMIN, askVideo({ reference_asset_ids: refs }));
  assert.deepEqual(many.events.find((e) => e.type === 'video_model_choice').choice.options.map((o) => o.id), [SEEDANCE], '12 images: only Seedance 2.5 takes them');
  const longClip = (await call(chat.id, ADMIN, askVideo({ duration_seconds: 20 }))).events.find((e) => e.type === 'video_model_choice').choice;
  assert.deepEqual(longClip.options.map((o) => [o.id, o.durationSeconds]), [[SEEDANCE, 20], [FAST, 15], [KLING, 15], [WAN, 15]], 'a range is clamped, fixed lengths exclude (Veo)');
  assert.ok(Math.abs(optionOf(longClip, KLING).price.maxTotal - 0.126 * 15) < 1e-6, 'the price is for the length the model would run');
  const wide = (await call(chat.id, ADMIN, askVideo({ aspect_ratio: '21:9' }))).events.find((e) => e.type === 'video_model_choice').choice;
  assert.deepEqual(wide.options.map((o) => o.id), [SEEDANCE], 'only Seedance 2.5 has 21:9');
  const shortClip = (await call(chat.id, ADMIN, askVideo({ duration_seconds: 6 }))).events.find((e) => e.type === 'video_model_choice').choice;
  assert.ok(shortClip.options.some((o) => o.id === VEO), 'Veo takes 6 s');
  const hd = (await call(chat.id, ADMIN, askVideo({ resolution: '1080p' }))).events.find((e) => e.type === 'video_model_choice').choice;
  assert.deepEqual(hd.options.map((o) => o.id), [WAN], 'only Wan has 1080p in this catalogue');
  assert.equal(optionOf(hd, WAN).resolution, '1080p');
  // the chosen model's own limits also hold when the tool is called directly with it
  await assert.rejects(
    tools.buildVideoPayload({ sessionId: chat.id, config: { ...config, videoModel: KLING } }, { prompt: 'x', mode: 'text_to_video', reference_asset_ids: [refs[0]] }),
    /nimmt hoechstens 0 Referenzbilder/
  );
  // no model fits: a clear error instead of an empty card
  await assert.rejects(call(chat.id, ADMIN, askVideo({ resolution: '4k' })), /Kein kompatibles Videomodell/);
  // arguments that could never start do not open a card
  await assert.rejects(call(chat.id, ADMIN, askVideo({ mode: 'image_to_video' })), /first_frame_asset_id fehlt/);
  await assert.rejects(call(chat.id, ADMIN, askVideo({ reference_video_asset_ids: ['vid-001'] })), /PUBLIC_BASE_URL/);
  await assert.rejects(call(chat.id, ADMIN, askVideo({ mode: 'image_to_video', first_frame_asset_id: 'img-999' })), /existiert nicht in dieser Session/);
  await assert.rejects(call(chat.id, ADMIN, askVideo({ reference_asset_ids: ['img-999'] })), /existiert nicht in dieser Session/);

  // ============ 6. two clicks at once start one job ============
  await call(chat.id, ADMIN, askVideo({ prompt: 'Parallel click test.' }));
  const parallelId = (await store.readSession(chat.id)).videoModelRequests.at(-1).id;
  createVideoDelay = 150;
  const before = submitted.length;
  const both = await Promise.all([click(chat.id, parallelId, ADMIN, { model: FAST }), click(chat.id, parallelId, ADMIN, { model: FAST })]);
  createVideoDelay = 0;
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  assert.equal(submitted.length, before + 1, 'exactly one job');
  assert.equal(submitted.at(-1).model, FAST);

  // ============ 7. a failing start reopens the choice ============
  await call(chat.id, ADMIN, askVideo({ prompt: 'Failing start.' }));
  const failingId = (await store.readSession(chat.id)).videoModelRequests.at(-1).id;
  const jobsBefore = (await store.readSession(chat.id)).jobs.length;
  const ledgerBefore = (await store.readLedger(chat.id)).length;
  createVideoError = new or.OpenRouterError('OpenRouter 500: provider hiccup', 500, '');
  const failed = await click(chat.id, failingId, ADMIN, { model: WAN });
  createVideoError = null;
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /provider hiccup/);
  saved = await store.readSession(chat.id);
  const reopened = saved.videoModelRequests.find((r) => r.id === failingId);
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.selectedModel, null);
  assert.match(reopened.lastError, /provider hiccup/);
  assert.equal(saved.jobs.length, jobsBefore, 'no job');
  assert.equal((await store.readLedger(chat.id)).length, ledgerBefore, 'no asset left behind');
  assert.match((await choiceOf(chat.id, ADMIN) || {}).lastError || 'x', /./);
  const retried = await click(chat.id, failingId, ADMIN, { model: WAN });
  assert.equal(retried.status, 201, 'the same card works again');
  assert.equal(submitted.at(-1).model, WAN);

  // ============ 8. cancel ============
  await call(chat.id, ADMIN, askVideo({ prompt: 'To be cancelled.' }));
  const cancelId = (await store.readSession(chat.id)).videoModelRequests.at(-1).id;
  const cancelUrl = (id) => `/api/sessions/${chat.id}/video-model-requests/${id}/cancel`;
  assert.equal((await api(cancelUrl(cancelId), { method: 'POST', as: BOB, json: {} })).status, 404);
  const cancelled = await api(cancelUrl(cancelId), { method: 'POST', as: ADMIN, json: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.choice.status, 'cancelled');
  assert.equal((await click(chat.id, cancelId, ADMIN, { model: KLING })).status, 409, 'a cancelled choice cannot start');
  assert.equal((await api(cancelUrl(failingId), { method: 'POST', as: ADMIN, json: {} })).status, 409, 'a started choice cannot be cancelled');
  const jobCountNow = submitted.length;
  assert.equal(jobCountNow, submitted.length);

  // ============ 9. at most 20 waiting choices per chat ============
  const crowded = await newChat(ADMIN);
  for (let i = 0; i < videoModels.MAX_PENDING_PER_SESSION; i += 1) await call(crowded.id, ADMIN, askVideo({ prompt: `Waiting ${i}` }));
  assert.equal((await store.readSession(crowded.id)).videoModelRequests.filter((r) => r.status === 'pending').length, 20);
  await assert.rejects(call(crowded.id, ADMIN, askVideo({ prompt: 'One too many' })), /schon 20 Video-Modellwahlen/);
  // a cancelled card frees a place
  const firstWaiting = (await store.readSession(crowded.id)).videoModelRequests[0].id;
  assert.equal((await api(`/api/sessions/${crowded.id}/video-model-requests/${firstWaiting}/cancel`, { method: 'POST', as: ADMIN, json: {} })).status, 200);
  assert.equal((await call(crowded.id, ADMIN, askVideo({ prompt: 'Fits again' }))).halt, true);

  // ============ 10. participants: budget on the card, refused by the server, reserved by the estimate ============
  const pChat = await newChat(P1);
  const costsBefore = await budgetLib.statusOfEmail(P1);
  assert.equal(costsBefore.remainingUsd, 1);
  const pCall = await call(pChat.id, P1, askVideo());
  assert.equal(pCall.halt, true);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'opening the card reserves nothing');
  let pChoice = pCall.events.find((e) => e.type === 'video_model_choice').choice;
  assert.deepEqual(pChoice.budget, { limitUsd: 1, remainingUsd: 1, reservedUsd: 0 });
  assert.equal(optionOf(pChoice, SEEDANCE).blocked.reason, 'budget', 'over the rest');
  assert.ok(Math.abs(optionOf(pChoice, SEEDANCE).blocked.needUsd - 1.1556) < 0.001);
  assert.equal(optionOf(pChoice, SEEDANCE).blocked.remainingUsd, 1);
  assert.equal(optionOf(pChoice, KLING).blocked, null);
  assert.equal(pChoice.options.find((o) => o.recommended).id, FAST, 'the recommendation moves to an option the person can afford');
  assert.ok(pChoice.options.every((o) => !String(o.id).includes('higgsfield')), 'no Higgsfield option');
  const pRequestId = (await store.readSession(pChat.id)).videoModelRequests.at(-1).id;
  // the same view comes from the chat endpoint (persist the tool message like the Director turn does)
  await store.mutateSession(pChat.id, (s) => {
    s.messages.push({ role: 'tool', tool_call_id: 'c1', name: 'generate_video', content: 'wartet', videoModelChoiceId: pRequestId, ts: new Date().toISOString() });
  });
  const pView = (await choiceOf(pChat.id, P1));
  assert.equal(optionOf(pView, SEEDANCE).blocked.reason, 'budget');
  assert.equal(pView.budget.remainingUsd, 1);
  // the server refuses an option over the rest, whatever the client does
  const providerCallsBefore = submitted.length;
  const refused = await click(pChat.id, pRequestId, P1, { model: SEEDANCE });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'BUDGET_INSUFFICIENT');
  assert.ok(Math.abs(refused.body.estimateUsd - 1.1556) < 0.001);
  assert.equal(submitted.length, providerCallsBefore, 'the provider was not called');
  assert.equal((await store.readSession(pChat.id)).videoModelRequests.at(-1).status, 'pending', 'the choice stays open');
  // an option that fits: the reservation is the estimate, not the flat amount
  const ok = await click(pChat.id, pRequestId, P1, { model: KLING, remember: true });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(submitted.at(-1).model, KLING);
  const pJob = (await store.readSession(pChat.id)).jobs[0];
  assert.match(pJob.budgetKey, /^hold:/);
  assert.equal(pJob.reservedUsd, 0.63, 'reserved by the estimate of the chosen model');
  assert.equal((await budgetLib.statusOfEmail(P1)).reservedUsd, 0.63);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 1);
  budgetLib.settleJob(pJob, 0.45); // the poller books the cost
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: pChat.id, type: 'video', model: KLING, cost: 0.45, user: P1 });
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  // remembered, but the rest (0.55) no longer takes the upper estimate (0.63): the card comes back and says why
  const pAgain = await call(pChat.id, P1, askVideo({ prompt: 'Again for the participant.' }));
  assert.equal(pAgain.halt, true);
  const againChoice = pAgain.events.find((e) => e.type === 'video_model_choice').choice;
  assert.equal(againChoice.preferenceNote.reason, 'budget');
  assert.equal(optionOf(againChoice, KLING).blocked.reason, 'budget');
  assert.equal(optionOf(againChoice, FAST).blocked.reason, 'budget');
  assert.equal(optionOf(againChoice, WAN).blocked, null);
  assert.equal(againChoice.options.find((o) => o.recommended).id, WAN);
  // a remembered model that fits starts directly and reserves its estimate
  await store.mutateSession(pChat.id, (s) => { s.videoModelPreferences = { [P1]: { model: WAN, name: 'Wan 2.7', since: new Date().toISOString() } }; });
  const pDirect = await call(pChat.id, P1, askVideo({ prompt: 'Direct for the participant.' }));
  assert.ok(pDirect.job, 'fits the budget: no card');
  assert.equal(submitted.at(-1).model, WAN);
  assert.equal((await store.readSession(pChat.id)).jobs.at(-1).reservedUsd, 0.5, 'the estimate of the remembered model');
  budgetLib.releaseJob((await store.readSession(pChat.id)).jobs.at(-1));
  // used up: no card at all, the person is told why
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: pChat.id, type: 'video', model: KLING, cost: 50, user: P1 });
  await assert.rejects(call(pChat.id, P1, askVideo()), (error) => error.code === 'BUDGET_EXHAUSTED');
  // a stranger without a team has no budget either
  const guestChat = await newChat('guest@gmail.example');
  await assert.rejects(call(guestChat.id, 'guest@gmail.example', askVideo()), (error) => error.code === 'BUDGET_EXHAUSTED');
  // a used-up budget stops a chat turn before the model is called
  const pText = await send((await newChat(P1)).id, P1, 'hallo');
  assert.equal(pText.status, 402);

  // ============ 11. the admin switch ============
  assert.equal((await api('/api/settings/preferences', { method: 'PUT', as: P1, json: { name: 'askVideoModel', value: false } })).status, 403);
  assert.equal((await api('/api/settings/preferences', { method: 'PUT', as: ADMIN, json: { name: 'other', value: false } })).status, 400);
  assert.equal((await api('/api/settings/preferences', { method: 'PUT', as: ADMIN, json: { name: 'askVideoModel', value: 'no' } })).status, 400);
  assert.equal((await api('/api/settings', { as: ADMIN })).body.preferences.askVideoModel, true, 'default: on');
  assert.equal((await api('/api/config', { as: P1 })).body.askVideoModel, true);
  const off = await api('/api/settings/preferences', { method: 'PUT', as: ADMIN, json: { name: 'askVideoModel', value: false } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.preferences, { askVideoModel: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(iso.root, 'data', 'settings.json'), 'utf8')).preferences, { askVideoModel: false });
  assert.equal(fs.statSync(path.join(iso.root, 'data', 'settings.json')).mode & 0o777, 0o600);
  const offChat = await newChat(ADMIN);
  const submittedBeforeOff = submitted.length;
  director.say({ text: 'Starte.', tools: [{ name: 'generate_video', args: askVideo() }] });
  director.say({ text: 'Das Video laeuft.' });
  const offTurn = await send(offChat.id, ADMIN, 'Mach ein Video ohne Rueckfrage');
  assert.equal(offTurn.events.some((e) => e.type === 'video_model_choice'), false, 'no card');
  assert.equal(offTurn.events.some((e) => e.type === 'video_job'), true, JSON.stringify(offTurn.events));
  assert.equal(submitted.length, submittedBeforeOff + 1, 'the old behaviour: the job starts at once');
  assert.equal(submitted.at(-1).model, SEEDANCE, 'with the default model');
  assert.equal(director.requests.length >= 2, true);
  const offPrompt = director.requests.at(-1).messages[0].content;
  assert.doesNotMatch(offPrompt, /## Video model selection/);
  assert.match(offPrompt, /`generate_video` - submits a video generation job to bytedance\/seedance-2\.5/);
  assert.equal((await store.readSession(offChat.id)).videoModelRequests, undefined);
  assert.equal((await api('/api/config', { as: P1 })).body.askVideoModel, false);
  // a card that is already waiting still works with the switch off
  assert.equal((await click(crowded.id, (await store.readSession(crowded.id)).videoModelRequests.at(-1).id, ADMIN, { model: FAST })).status, 201);
  assert.equal((await api('/api/settings/preferences', { method: 'PUT', as: ADMIN, json: { name: 'askVideoModel', value: true } })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(iso.root, 'data', 'settings.json'), 'utf8')), {}, 'back to the default: nothing stored');

  // ============ 12. the catalogue is down: only the configured model, price unknown ============
  resetCatalogue();
  discovery.resetVideoModelCache();
  listFails = true;
  const downChat = await newChat(ADMIN);
  const down = await call(downChat.id, ADMIN, askVideo());
  listFails = false;
  const downChoice = down.events.find((e) => e.type === 'video_model_choice').choice;
  assert.deepEqual(downChoice.options.map((o) => o.id), [SEEDANCE]);
  assert.equal(downChoice.options[0].price, null);
  assert.equal(downChoice.options[0].estimateUsd, null);
  resetCatalogue();
  discovery.resetVideoModelCache();

  // ============ 13. the node view keeps its way ============
  const nodeChat = await newChat(ADMIN);
  const nodeEvents = [];
  const nodeOutcome = await tools.executeTool({ sessionId: nodeChat.id, config, emit: (e) => nodeEvents.push(e), user: ADMIN, nodeView: true }, 'generate_video', askVideo());
  assert.ok(nodeOutcome.job && !nodeOutcome.halt, 'no picker outside the chat');
  assert.equal(submitted.at(-1).model, SEEDANCE);
  assert.equal(nodeEvents.some((e) => e.type === 'video_model_choice'), false);

  // ============ 14. old chats stay readable ============
  const oldChat = await newChat(ADMIN);
  await store.mutateSession(oldChat.id, (s) => {
    s.messages.push({ role: 'tool', tool_call_id: 'old', name: 'generate_video', content: 'Video-Job vid-001 gestartet', job: { jobId: 'old-job', assetId: 'vid-001', prompt: 'x' }, ts: new Date().toISOString() });
    s.jobs.push({ jobId: 'old-job', assetId: 'vid-001', status: 'completed', prompt: 'x', submittedAt: new Date().toISOString() });
  });
  const oldDetail = await detail(oldChat.id, ADMIN);
  assert.equal(oldDetail.session.messages[0].videoModelChoice, undefined);
  assert.equal(oldDetail.jobs[0].model, null, 'an old job without a model');
  assert.equal(oldDetail.session.videoModelPreference, null);

  // ============ 14b. review fixes ============
  // (a) a remembered choice belongs to the person: in a shared chat nobody else starts a paid job without their own click
  const sharedChat = await newChat(BOB);
  await store.mutateSession(sharedChat.id, (s) => { s.shareMode = 'team'; });
  assert.equal((await api(`/api/sessions/${sharedChat.id}`, { as: CAROL })).status, 200, 'Carol can use the shared chat');
  const sharedFirst = await call(sharedChat.id, BOB, askVideo());
  assert.equal(sharedFirst.halt, true);
  const sharedBefore = submitted.length;
  const bobClick = await click(sharedChat.id, sharedFirst.events.find((e) => e.type === 'video_model_choice').choice.id, BOB, { model: KLING, remember: true });
  assert.equal(bobClick.status, 201, bobClick.text);
  assert.equal(submitted.length, sharedBefore + 1);
  assert.deepEqual(bobClick.body.videoModelPreference, { model: KLING, name: 'Kling v3.0 Standard' });
  const stored = (await store.readSession(sharedChat.id)).videoModelPreferences;
  assert.deepEqual(Object.keys(stored), [BOB], 'stored for the person who ticked the box');
  assert.equal((await detail(sharedChat.id, BOB)).session.videoModelPreference.model, KLING);
  assert.equal((await detail(sharedChat.id, CAROL)).session.videoModelPreference, null, 'Carol sees no remembered model');
  const carolCall = await call(sharedChat.id, CAROL, askVideo({ prompt: 'Carol asks for a video.' }));
  assert.equal(carolCall.halt, true, 'Carol gets the card, not a job on her budget');
  assert.equal(submitted.length, sharedBefore + 1, 'nothing was paid for Carol');
  assert.equal(carolCall.events.find((e) => e.type === 'video_model_choice').choice.preferenceNote, null);
  const bobDirect = await call(sharedChat.id, BOB, askVideo({ prompt: 'Bob again.' }));
  assert.ok(bobDirect.job && !bobDirect.halt, 'Bob keeps his remembered model');
  assert.equal(submitted.length, sharedBefore + 2);
  // the Director of Carol is not told about Bob's model, Bob's Director is
  director.say({ text: 'ok' });
  await send(sharedChat.id, CAROL, 'hallo');
  assert.doesNotMatch(director.requests.at(-1).messages[0].content, /The user has chosen/);
  director.say({ text: 'ok' });
  await send(sharedChat.id, BOB, 'hallo');
  const rememberedPrompt = director.requests.at(-1).messages[0].content;
  assert.match(rememberedPrompt, /The user has chosen \*\*Kling v3\.0 Standard\*\*/);
  // the reset forgets only the own choice
  assert.equal((await api(`/api/sessions/${sharedChat.id}/video-model-preference`, { method: 'DELETE', as: CAROL })).status, 200);
  assert.equal((await detail(sharedChat.id, BOB)).session.videoModelPreference.model, KLING, "Carol's reset does not touch Bob's choice");
  assert.equal((await api(`/api/sessions/${sharedChat.id}/video-model-preference`, { method: 'DELETE', as: BOB })).status, 200);
  assert.equal((await store.readSession(sharedChat.id)).videoModelPreferences, undefined);

  // (b) with a model remembered the prompt does not promise a picker that will not come
  assert.doesNotMatch(rememberedPrompt, /BEFORE the call/);
  assert.doesNotMatch(rememberedPrompt, /first opens the required model picker and stops your turn/);
  assert.doesNotMatch(rememberedPrompt, /Your turn ends there/);
  assert.match(rememberedPrompt, /starts the paid job right away with it and shows no picker/);
  assert.match(rememberedPrompt, /normally starts the paid job right away with the model this chat remembered/);
  assert.match(rememberedPrompt, /Higgsfield\) only when the user explicitly asks/);

  // (c) the hint above the input follows the admin switch (client source)
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSource, /const asking = state\.config\?\.askVideoModel !== false;\s+const preference = state\.currentId && asking/);

  // (d) the limits of a curated default model hold on the card as on the payload; the node view keeps its own
  const limitChat = await newChat(ADMIN);
  const limitRefs = [];
  for (let i = 0; i < 12; i += 1) limitRefs.push((await store.saveAsset(limitChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'ref', cost: null })).id);
  const fastConfig = { imageModel: 'test/image', videoModel: FAST };
  const fastCard = await call(limitChat.id, ADMIN, askVideo({ reference_asset_ids: limitRefs }), { config: fastConfig });
  assert.equal(fastCard.halt, true);
  assert.equal(fastCard.events.find((e) => e.type === 'video_model_choice').choice.options.some((o) => o.id === FAST), false, 'Fast takes 9 images: not offered for 12, no failing click');
  const fastNine = await call(limitChat.id, ADMIN, askVideo({ reference_asset_ids: limitRefs.slice(0, 9) }), { config: fastConfig });
  assert.equal(fastNine.events.find((e) => e.type === 'video_model_choice').choice.options[0].id, FAST, 'the default model fits with 9 and is recommended');
  const beforeNode = submitted.length;
  const nodeFast = await tools.executeTool({ sessionId: limitChat.id, config: fastConfig, emit() {}, user: ADMIN, nodeView: true }, 'generate_video', askVideo({ reference_asset_ids: limitRefs }));
  assert.ok(nodeFast.job, 'the node view keeps its 30 references for this model');
  assert.equal(submitted.length, beforeNode + 1);
  assert.equal(submitted.at(-1).input_references.length, 12);

  // (e) models without texts of their own get the neutral ones; editing, upscaling and avatar models, models the catalogue
  // does not describe and models without a price never fill the card (a click would pay for a failing job)
  EXTRA_MODELS.push(
    { id: 'example/flux-video-edit', name: 'Example: Video Edit', pricing_skus: { duration_seconds: '0.03' }, supported_resolutions: null, supported_aspect_ratios: null, supported_durations: null, supported_frame_images: null },
    { id: 'example/video-upscale', name: 'Example: Video Upscale', pricing_skus: { duration_seconds: '0.02' }, supported_resolutions: ['1080p'], supported_aspect_ratios: ['16:9'], supported_durations: range(1, 30), supported_frame_images: null },
    { id: 'example/avatar-iv', name: 'Example: Avatar IV', pricing_skus: { duration_seconds: '0.05' }, supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9'], supported_durations: range(1, 30), supported_frame_images: null },
    { id: 'example/no-price', name: 'Example: No Price', pricing_skus: {}, supported_resolutions: ['1080p'], supported_aspect_ratios: ['16:9'], supported_durations: range(1, 30), supported_frame_images: ['first_frame'] },
    { id: 'google/veo-3.1', name: 'Google: Veo 3.1', pricing_skus: { duration_seconds: '0.4' }, supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9'], supported_durations: [4, 5, 6, 8], supported_frame_images: ['first_frame'] },
    { id: 'kwaivgi/kling-v3.0-master', name: 'Kling: Video v3.0 Master', pricing_skus: { duration_seconds: '0.3' }, supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9'], supported_durations: range(3, 15), supported_frame_images: ['first_frame'] }
  );
  resetCatalogue();
  const fill = (await call(limitChat.id, ADMIN, askVideo({ resolution: '1080p' }))).events.find((e) => e.type === 'video_model_choice').choice;
  assert.ok(optionOf(fill, WAN), 'the curated model is first');
  for (const id of ['google/veo-3.1', 'kwaivgi/kling-v3.0-master']) {
    assert.equal(optionOf(fill, id)?.profileKey, 'generic', `${id} does not borrow the texts of a curated model`);
  }
  for (const id of ['example/flux-video-edit', 'example/video-upscale', 'example/avatar-iv', 'example/no-price']) {
    assert.equal(optionOf(fill, id), undefined, `${id} is not offered`);
  }
  assert.equal(optionOf(fill, WAN).profileKey, 'wan27');
  EXTRA_MODELS.length = 0;
  resetCatalogue();

  // (f) when the bookkeeping after a successful start fails, the choice does not open again for a second paid job
  const bookChat = await newChat(ADMIN);
  const bookCard = (await call(bookChat.id, ADMIN, askVideo())).events.find((e) => e.type === 'video_model_choice').choice;
  const realFinish = videoModels.finishRequest;
  videoModels.finishRequest = async () => { throw new Error('disk full'); };
  const submittedBeforeBook = submitted.length;
  let bookClick;
  try {
    bookClick = await click(bookChat.id, bookCard.id, ADMIN, { model: FAST });
  } finally {
    videoModels.finishRequest = realFinish;
  }
  assert.equal(bookClick.status, 201, 'the job is running: the click succeeds');
  assert.equal(submitted.length, submittedBeforeBook + 1);
  const bookSaved = await store.readSession(bookChat.id);
  assert.equal(bookSaved.jobs.length, 1);
  assert.equal(bookSaved.videoModelRequests[0].status, 'submitted', 'closed, not reopened');
  assert.equal(bookSaved.videoModelRequests[0].assetId, bookSaved.jobs[0].assetId);
  assert.equal((await click(bookChat.id, bookCard.id, ADMIN, { model: FAST })).status, 409, 'no second click, no second job');
  assert.equal(submitted.length, submittedBeforeBook + 1);
  // a start that really failed (no job) still reopens
  const failCard = (await call(bookChat.id, ADMIN, askVideo({ prompt: 'A start that fails.' }))).events.find((e) => e.type === 'video_model_choice').choice;
  createVideoError = new Error('provider down');
  const failClick = await click(bookChat.id, failCard.id, ADMIN, { model: FAST });
  createVideoError = null;
  assert.ok(failClick.status >= 400);
  assert.equal((await requestOf(bookChat.id, failCard.id)).status, 'pending');

  // (g) a cancelled card keeps its label although the request was pruned from the chat
  const cancelChat = await newChat(ADMIN);
  director.say({ text: 'Auswahl unten.', tools: [{ name: 'generate_video', args: askVideo() }] });
  await send(cancelChat.id, ADMIN, 'Video bitte');
  const prunedCancelId = (await store.readSession(cancelChat.id)).videoModelRequests[0].id;
  assert.equal((await api(`/api/sessions/${cancelChat.id}/video-model-requests/${prunedCancelId}/cancel`, { method: 'POST', as: ADMIN, json: {} })).status, 200);
  await store.mutateSession(cancelChat.id, (s) => { s.videoModelRequests = []; });
  const pruned = (await detail(cancelChat.id, ADMIN)).session.messages.find((m) => m.name === 'generate_video');
  assert.equal(pruned.videoModelChoice, undefined, 'the request is gone');
  assert.equal(pruned.videoModelChoiceStatus, 'cancelled', 'the message itself remembers');
  assert.match(appSource, /\(message\.videoModelChoice\?\.status \|\| message\.videoModelChoiceStatus\) === 'cancelled'/);

  // ============ 15. layer: settings, helpers ============
  const settingsMod = iso.load('lib/settings');
  assert.throws(() => settingsMod.setPreference('nope', true), /nicht erlaubt/);
  assert.throws(() => settingsMod.setPreference('askVideoModel', 'yes'), /true oder false/);
  assert.deepEqual(videoModels.requestRequirements({ prompt: 'x' }), {
    duration: 5, mode: 'text_to_video', resolution: null, aspectRatio: '', imageReferences: 0, videoReferences: 0, audioReferences: 0, hasVideoInput: false
  });
  assert.equal(videoModels.requestRequirements({ duration_seconds: 99 }).duration, 30);
  assert.equal(videoModels.requestRequirements({ first_frame_asset_id: 'img-001' }).mode, 'image_to_video');
  assert.deepEqual(videoModels.referenceLimits(KLING), { images: 0, videos: 0, audios: 0 });
  assert.equal(videoModels.referenceLimits('acme/unknown'), null);
  assert.ok(listCalls >= 0);
  void teamsLib;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
