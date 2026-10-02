'use strict';

// A video provider refuses an image that may show a real person (WP24, part A). Seedance (ByteDance, through OpenRouter)
// answers HTTP 400 at the start of the job. The chat and the node view must say so in plain words, not show raw JSON.
//
//   A1  one function recognises the refusal (the real message of a chat is the fixture), with a stable code
//   A2  the sentences in German, English and Spanish; nothing is claimed that the code does not guarantee
//   A3  the reopened card marks the models of the provider, the mark is stored, the server refuses a click on them
//   A4  the Director reads what happened and what to do next (tool result and waiting message)
//   A5  the node view: the node error has the code, the translated text and a tip in the help
//
// Review round: a refusal at a direct start is remembered for the images (the next call opens the card), the card says when
// the other models are over the budget, the sentences are only used for Seedance models, a job refused while it is polled
// gets its own code and sentence without a claim about the bill.
//
// A private copy of the app runs in a temp directory (own data folders, ephemeral port, whoami stub). OpenRouter is a local
// double and a fetch guard refuses everything except localhost, so nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');
const graphLib = require('../public/nodes/graph');
const runLib = require('../public/nodes/run');

const root = path.resolve(__dirname, '..');
const ADMIN = 'admin@example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const SEEDANCE = 'bytedance/seedance-2.5';
const FAST = 'bytedance/seedance-2.0-fast';
const KLING = 'kwaivgi/kling-v3.0-std';
const WAN = 'alibaba/wan-2.7';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODEL_LIST = {
  data: [
    { id: SEEDANCE, name: 'ByteDance: Seedance 2.5', pricing_skus: { video_tokens: '0.0000107' }, supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'], supported_durations: range(4, 30), supported_frame_images: ['first_frame'] },
    { id: FAST, name: 'ByteDance: Seedance 2.0 Fast', pricing_skus: { video_tokens: '0.0000056' }, supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'], supported_durations: range(4, 15), supported_frame_images: ['first_frame'] },
    { id: KLING, name: 'Kling: Video v3.0 Standard', pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126' }, supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'], supported_durations: range(3, 15), supported_frame_images: ['first_frame'] },
    { id: WAN, name: 'Alibaba: Wan 2.7', pricing_skus: { duration_seconds_720p: '0.1' }, supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'], supported_durations: range(2, 15), supported_frame_images: ['first_frame'] }
  ]
};

// The real answer of a chat (request id shortened), as OpenRouter wraps the provider answer.
const PROVIDER_ANSWER = {
  error: {
    code: 'InputImageSensitiveContentDetected.PrivacyInformation',
    message: "The request failed because the input image 'content[1]' may contain real person. Request id: 0217…",
    param: '',
    type: 'BadRequest'
  }
};
const OUTER_BODY = JSON.stringify({ error: { message: `HTTP 400: ${JSON.stringify(PROVIDER_ANSWER)}`, code: 400 } });
const REAL_MESSAGE = `OpenRouter 400: HTTP 400: ${JSON.stringify(PROVIDER_ANSWER)}`;

function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  let stub = null;
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (stub && /^https:\/\/openrouter\.ai\/api\/v1\/videos$/.test(url)) return stub(url, init);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return { attempts, setStub: (fn) => { stub = fn; }, restore() { global.fetch = original; } };
}

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
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()));
}

const RAW_PIECES = ['InputImageSensitiveContentDetected', 'content[1]', 'Request id', 'BadRequest', '{"error":{', '\\"error\\"', 'HTTP 400', 'OpenRouter 400'];
function assertNoRawProviderText(text, label) {
  for (const piece of RAW_PIECES) assert.equal(String(text).includes(piece), false, `${label}: shows raw provider text (${piece})`);
}

/* ---------- A1 / A2: recognition and sentences ---------- */

async function testRecognition(or, refusal) {
  // the real message of a chat, as the OpenRouter client builds it from the HTTP answer
  const real = new or.OpenRouterError(REAL_MESSAGE, 400, OUTER_BODY);
  assert.equal(refusal.isRealPersonRefusal(real), true, 'the real message is recognised');

  // other shapes of the same refusal: code only, message only, the escaped (nested) code, a plain object with the code
  assert.equal(refusal.isRealPersonRefusal(new or.OpenRouterError('OpenRouter 400: HTTP 400', 400, JSON.stringify({ error: { code: 'InputImageSensitiveContentDetected.Other', message: 'x' } }))), true, 'code only');
  assert.equal(refusal.isRealPersonRefusal(new Error("The input image 'content[0]' may contain real person.")), true, 'message only');
  assert.equal(refusal.isRealPersonRefusal(new Error('The request MAY CONTAIN REAL PERSON')), true, 'message, any case');
  assert.equal(refusal.isRealPersonRefusal(new Error('x \\"code\\":\\"InputImageSensitiveContentDetected.A\\" y')), true, 'escaped nested json');
  assert.equal(refusal.isRealPersonRefusal({ code: 'InputImageSensitiveContentDetected.PrivacyInformation' }), true, 'an error object with the provider code');
  assert.equal(refusal.isRealPersonRefusal('may contain real person'), true, 'a plain string');

  // other errors are not the refusal
  const others = [
    new or.OpenRouterError('OpenRouter 500: provider hiccup', 500, ''),
    new or.OpenRouterError('OpenRouter 400: The image data does not represent a valid image', 400, '{"error":{"message":"bad image"}}'),
    new or.OpenRouterError('OpenRouter 400: HTTP 400', 400, JSON.stringify({ error: { code: 'InputTextSensitiveContentDetected', message: 'text' } })),
    new or.OpenRouterError('OpenRouter 402: insufficient credits', 402, '{"error":{"code":402}}'),
    new Error('provider down'),
    Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    null,
    undefined,
    {},
    ''
  ];
  for (const error of others) assert.equal(refusal.isRealPersonRefusal(error), false, `not a refusal: ${error && error.message}`);

  // the stable code and the sentences
  const wrapped = refusal.refusalOf(real, { model: SEEDANCE });
  assert.ok(wrapped instanceof refusal.VideoRefusalError);
  assert.equal(wrapped.code, 'VIDEO_REAL_PERSON');
  assert.equal(refusal.CODE, 'VIDEO_REAL_PERSON');
  assert.equal(wrapped.provider, 'bytedance');
  assert.equal(wrapped.model, SEEDANCE);
  assert.equal(refusal.refusalOf(wrapped), wrapped, 'a refusal stays one');
  assert.equal(refusal.refusalOf(new Error('provider down'), { model: SEEDANCE }), null);
  for (const text of [wrapped.message, wrapped.messageDe, wrapped.directorText]) {
    assertNoRawProviderText(text, 'sentence');
    assert.equal(text.includes('ß'), false);
  }
  assert.match(wrapped.messageDe, /Seedance lehnt Bilder ab, auf denen eine echte Person zu sehen sein könnte/);
  assert.match(wrapped.messageDe, /nichts berechnet/);
  assert.match(wrapped.message, /Nothing was charged/);
  assert.match(wrapped.directorText, /^Fehler bei generate_video: /, 'the chat marks the tool message as failed');
  assert.match(wrapped.directorText, /nicht erneut/);
  assert.match(wrapped.directorText, /andere passende Videomodelle/);
  assert.match(wrapped.directorText, /ohne reale Person/);
  assert.equal(refusal.providerOf('Bytedance/Seedance-2.5'), 'bytedance');
  assert.equal(refusal.providerOf('nomodel'), '');

  // The sentences name Seedance: another provider with the same wording stays its own error, no wrong attribution.
  assert.equal(refusal.isRealPersonRefusal(real), true, 'the wording itself is still recognised');
  assert.equal(refusal.refusalOf(real, { model: KLING }), null, 'a Kling model is not blamed on Seedance');
  assert.equal(refusal.refusalOf(real, { model: WAN }), null);
  assert.ok(refusal.refusalOf(real, { model: 'Bytedance/Seedance-2.5' }), 'a Seedance model, any case');
  assert.ok(refusal.refusalOf(real, { model: FAST }));
  assert.ok(refusal.refusalOf(real), 'an unknown model: the sentences apply');
  assert.match(wrapped.directorText, /gesperrt/, 'the Director learns what a second call does');

  // A job refused while it is polled: own code and sentences, no claim about the bill
  const late = refusal.jobRefusalOf(real, { model: SEEDANCE });
  assert.equal(late.code, 'VIDEO_REAL_PERSON_JOB');
  assert.equal(refusal.JOB_CODE, 'VIDEO_REAL_PERSON_JOB');
  assert.notEqual(late.code, refusal.CODE);
  for (const text of [late.message, late.directorText]) {
    assertNoRawProviderText(text, 'job sentence');
    assert.equal(text.includes('ß'), false);
    assert.equal(/nichts berechnet|kein Job gestartet|Nothing was charged/.test(text), false, 'no claim about the bill');
    assert.match(text, /echte Person/);
    assert.match(text, /Bild ohne reale Person/);
  }
  assert.match(late.directorText, /nicht erneut vor/);
  assert.equal(refusal.jobRefusalOf(real, { model: KLING }), null);
  assert.equal(refusal.jobRefusalOf(new Error('provider down'), { model: SEEDANCE }), null);
  assert.equal(refusal.jobRefusalOf(null, { model: SEEDANCE }), null);
  // the nested answer of a polled job
  assert.ok(refusal.jobRefusalOf({ message: PROVIDER_ANSWER.error.message, code: PROVIDER_ANSWER.error.code }, { model: SEEDANCE }));
}

async function testThroughClient(guard, or, refusal) {
  // the real client code (readError) with the real answer: a 400 on POST /videos
  guard.setStub(async () => new Response(OUTER_BODY, { status: 400, headers: { 'Content-Type': 'application/json' } }));
  let thrown = null;
  try {
    await or.createVideo({ model: SEEDANCE, prompt: 'x' });
  } catch (error) {
    thrown = error;
  }
  guard.setStub(null);
  assert.ok(thrown instanceof or.OpenRouterError);
  assert.equal(thrown.status, 400);
  assert.equal(thrown.message, REAL_MESSAGE, 'the fixture is what the client builds');
  assert.equal(refusal.isRealPersonRefusal(thrown), true);
}

/* ---------- A5 client pieces ---------- */

function loadUi(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [], createElement: () => ({}) },
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() {}
  };
  const sandbox = { window, document: window.document, requestAnimationFrame() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), sandbox, { filename: 'public/i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/i18n-nodes.js'), 'utf8'), sandbox, { filename: 'public/nodes/i18n-nodes.js' });
  window.OCDNodes = { graph: graphLib };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/node-ui.js'), 'utf8'), sandbox, { filename: 'public/nodes/node-ui.js' });
  return { window, ui: window.OCDNodes.ui, dict: window.I18N[lang] };
}

function testNodeClient() {
  const reduced = runLib.reduce(runLib.createRunState(), { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'error', message: 'Seedance rejects images', code: 'VIDEO_REAL_PERSON' }, 1000);
  assert.equal(reduced.nodes.n1.code, 'VIDEO_REAL_PERSON', 'the reducer keeps the code of a failed node');
  const retried = runLib.reduce(reduced, { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'running' }, 2000);
  assert.equal(retried.nodes.n1.code, undefined, 'a new attempt drops the old code');
  const plain = runLib.reduce(runLib.createRunState(), { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'error', message: 'boom' }, 1000);
  assert.equal(plain.nodes.n1.code, undefined);
  const shown = runLib.displayStatus({ run: reduced.nodes.n1 });
  assert.deepEqual(shown, { status: 'error', message: 'Seedance rejects images', code: 'VIDEO_REAL_PERSON' });
  assert.deepEqual(runLib.displayStatus({ run: plain.nodes.n1 }), { status: 'error', message: 'boom' }, 'no code: the shape is as before');

  const seen = new Set();
  for (const lang of ['de', 'en', 'es']) {
    const { ui, dict } = loadUi(lang);
    assert.equal(ui.hasIssueText('VIDEO_REAL_PERSON'), true, `${lang}: translated text for the code`);
    const localized = runLib.localizeError(shown, ui);
    assert.equal(localized.message, dict['nodes.issue.VIDEO_REAL_PERSON']);
    assertNoRawProviderText(localized.message, lang);
    assert.equal(localized.message.includes('ß'), false);
    assert.notEqual(localized.message, shown.message);
    seen.add(localized.message);
    // an error without a text of its own keeps the engine's message
    assert.deepEqual(runLib.localizeError({ status: 'error', message: 'boom', code: 'NODE_TIMEOUT' }, ui), { status: 'error', message: 'boom', code: 'NODE_TIMEOUT' });
    assert.deepEqual(runLib.localizeError({ status: 'skipped', message: 'blocked by a' }, ui), { status: 'skipped', message: 'blocked by a' });
    // the new tip of the node help
    const tip = dict['nodes.type.video.seedance.tip.4'];
    assert.ok(tip && tip.length > 20 && tip.length <= 240, `${lang}: tip 4 of video.seedance`);
    assert.equal(tip.includes('ß'), false);
    seen.add(tip);
  }
  assert.equal(seen.size, 6, 'three languages, two texts, all different');
  const de = loadUi('de').dict;
  assert.match(de['nodes.issue.VIDEO_REAL_PERSON'], /Seedance lehnt Bilder ab, auf denen eine echte Person zu sehen sein könnte/);
  assert.match(de['nodes.type.video.seedance.tip.4'], /echte Person/);
  const es = loadUi('es').dict;
  assert.match(es['nodes.issue.VIDEO_REAL_PERSON'], /persona real/);
}

const source0 = () => fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

function testChatKeys() {
  const keys = ['videoModel.error.VIDEO_REAL_PERSON', 'videoModel.error.VIDEO_REAL_PERSON_JOB', 'videoModel.error.VIDEO_MODEL_REFUSED', 'videoModel.refusedOption', 'videoModel.refusedLead', 'videoModel.noAlternative', 'videoModel.noAffordable'];
  const texts = new Set();
  for (const lang of ['de', 'en', 'es']) {
    const { dict } = loadUi(lang);
    for (const key of keys) {
      assert.ok(dict[key] && dict[key].trim(), `${lang}: ${key}`);
      assert.equal(dict[key].includes('ß'), false, `${lang}.${key}`);
      assertNoRawProviderText(dict[key], `${lang}.${key}`);
      texts.add(dict[key]);
    }
  }
  assert.equal(texts.size, keys.length * 3, 'every sentence is written in each language');
  assert.match(loadUi('de').dict['videoModel.error.VIDEO_REAL_PERSON'], /nichts berechnet/);
  for (const lang of ['de', 'en', 'es']) {
    assert.equal(/nichts berechnet|nothing was charged|no se ha cobrado/i.test(loadUi(lang).dict['videoModel.error.VIDEO_REAL_PERSON_JOB']), false, `${lang}: the late refusal claims nothing about the bill`);
  }
  assert.match(source0(), /providerRuleMessage\(job\.errorCode\)/, 'the job card says the known cause in the interface language');
  assert.match(source0(), /choice\.noAffordable \? 'videoModel\.noAffordable'/, 'the card has its own sentence when the others are over the budget');
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(source, /function providerRuleMessage\(code\)/);
  assert.equal(/innerHTML\s*=\s*[^;]*(refus|lastError)/i.test(source), false, 'the card writes no data as HTML');
}

/* ---------- the app ---------- */

async function main() {
  const guard = guardFetch();
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
    await run(iso, guard);
  } finally {
    await iso.cleanup();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Echte-Person-Ablehnung: Erkennung mit der echten Meldung, Texte in drei Sprachen, Karte mit gesperrten Modellen (gespeichert, serverseitig durchgesetzt), Budget freigegeben, Director-Text, Node-Fehler und Hilfe-Tipp sind korrekt.');
}

async function run(iso, guard) {
  const api = iso.request;
  const store = iso.load('lib/store');
  const or = iso.load('lib/openrouter');
  const discovery = iso.load('lib/discovery');
  const tools = iso.load('lib/tools');
  const videoModels = iso.load('lib/video-models');
  const budgetLib = iso.load('lib/budget');
  const refusal = iso.load('lib/video-refusal');

  // ============ A1 / A2: recognition, sentences ============
  await testRecognition(or, refusal);
  await testThroughClient(guard, or, refusal);
  testChatKeys();
  testNodeClient();

  // ============ the app with a mocked provider ============
  discovery.brainSupportsImages = async () => true;
  or.listVideoModels = async () => JSON.parse(JSON.stringify(MODEL_LIST));
  const submitted = [];
  let refuseBytedance = true;
  or.createVideo = async (payload) => {
    if (refuseBytedance && String(payload.model).startsWith('bytedance/')) {
      submitted.push({ ...payload, refused: true });
      throw new or.OpenRouterError(REAL_MESSAGE, 400, OUTER_BODY);
    }
    submitted.push(payload);
    return { id: `job-${submitted.length}`, status: 'pending', polling_url: 'http://127.0.0.1:1/x' };
  };
  const accepted = () => submitted.filter((payload) => !payload.refused);
  const director = scriptedDirector(or);

  const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 1 } })).body.team;
  assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);
  const team2 = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs 2', budgetUsd: 1 } })).body.team;
  assert.equal((await api(`/api/teams/${team2.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P2] } })).status, 201);

  const newChat = async (email) => (await api('/api/sessions', { method: 'POST', as: email, json: {} })).body.session;
  const detail = async (id, email) => (await api(`/api/sessions/${id}`, { as: email })).body;
  const choiceOf = async (id, email) => (await detail(id, email)).session.messages.filter((m) => m.videoModelChoice).at(-1)?.videoModelChoice;
  const send = async (id, email, text) => {
    const response = await api(`/api/sessions/${id}/message`, { method: 'POST', as: email, json: { text, brainModel: 'brain-test' } });
    return { status: response.status, events: response.status === 200 ? parseEvents(response.text) : [], body: response.body };
  };
  const click = (id, requestId, email, json) => api(`/api/sessions/${id}/video-model-requests/${requestId}`, { method: 'POST', as: email, json });
  const optionOf = (choice, model) => choice.options.find((option) => option.id === model);
  const askVideo = (args = {}) => ({ prompt: 'A calm walk through a quiet street at sunrise.', mode: 'text_to_video', duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9', ...args });
  // The Director asks for a video: the card appears in the chat (the turn ends after the tool round).
  const askInChat = async (id, email, args = {}) => {
    director.say({ text: 'Die Modellauswahl erscheint gleich unten.', tools: [{ name: 'generate_video', args: askVideo(args) }] });
    const turn = await send(id, email, 'Mach ein Video');
    assert.equal(turn.status, 200);
    assert.ok(turn.events.some((event) => event.type === 'video_model_choice'), 'the card arrives in the live view');
    return turn;
  };
  const config = { imageModel: 'test/image', videoModel: SEEDANCE };
  const call = (sessionId, email, args, extra = {}) => {
    const events = [];
    return tools.executeTool({ sessionId, config, emit: (event) => events.push(event), user: email, pickVideoModel: true, ...extra }, 'generate_video', args)
      .then((outcome) => Object.assign(outcome, { events }));
  };

  // ============ A3: the card after the refusal (a participant with a budget) ============
  const chat = await newChat(P1);
  await askInChat(chat.id, P1);
  let choice = await choiceOf(chat.id, P1);
  const requestId = choice.id;
  assert.deepEqual(choice.options.map((o) => o.id), [SEEDANCE, FAST, KLING, WAN]);
  assert.ok(choice.options.every((o) => o.refused === null), 'nothing is marked before a refusal');
  assert.deepEqual(choice.refusedProviders, []);
  assert.equal(choice.noAlternative, false);
  assert.equal(optionOf(choice, SEEDANCE).blocked?.reason, 'budget', 'Seedance 2.5 is over the small budget of the participant');

  const reservedBefore = (await budgetLib.statusOfEmail(P1)).reservedUsd;
  const ledgerBefore = (await store.readLedger(chat.id)).length;
  const refused = await click(chat.id, requestId, P1, { model: FAST });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'VIDEO_REAL_PERSON');
  assert.equal(refused.body.error, refusal.MESSAGE_DE, 'the German sentence is the fallback of the answer');
  assertNoRawProviderText(refused.text, 'click answer');
  assert.equal(submitted.length, 1, 'the provider was called once');
  // nothing was charged: the reservation is released, no job and no asset stays behind
  assert.equal((await budgetLib.statusOfEmail(P1)).reservedUsd, reservedBefore, 'the budget reservation is released');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'no reservation left');
  assert.equal((await budgetLib.statusOfEmail(P1)).spentUsd, 0, 'nothing is spent');
  let saved = await store.readSession(chat.id);
  assert.equal(saved.jobs.length, 0, 'no job');
  assert.equal((await store.readLedger(chat.id)).length, ledgerBefore, 'no asset left behind');

  // the mark is stored in the request and survives a reload
  const stored = saved.videoModelRequests.find((r) => r.id === requestId);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.selectedModel, null);
  assert.deepEqual(stored.refusedProviders, ['bytedance']);
  assert.equal(stored.lastErrorCode, 'VIDEO_REAL_PERSON');
  assert.equal(stored.lastError, refusal.MESSAGE_DE);
  assertNoRawProviderText(JSON.stringify(stored), 'stored request');
  choice = await choiceOf(chat.id, P1);
  assert.equal(choice.status, 'pending');
  assert.deepEqual(choice.refusedProviders, ['bytedance']);
  assert.equal(choice.lastErrorCode, 'VIDEO_REAL_PERSON');
  assert.equal(optionOf(choice, SEEDANCE).refused.code, 'VIDEO_REAL_PERSON');
  assert.equal(optionOf(choice, FAST).refused.provider, 'bytedance');
  assert.equal(optionOf(choice, KLING).refused, null);
  assert.equal(optionOf(choice, WAN).refused, null);
  assert.ok(!optionOf(choice, SEEDANCE).recommended && !optionOf(choice, FAST).recommended, 'the recommendation moves away from the refusing provider');
  assert.equal(choice.options.filter((o) => o.recommended).length, 1);
  assert.ok([KLING, WAN].includes(choice.options.find((o) => o.recommended).id));
  assert.equal(choice.noAlternative, false, 'other models are left');
  // nowhere in the chat view does the raw provider text show up
  assertNoRawProviderText(JSON.stringify(await detail(chat.id, P1)), 'chat view');

  // the server refuses a click on a marked model, whoever sends it: nothing starts
  const callsBefore = submitted.length;
  const blockedClick = await click(chat.id, requestId, P1, { model: SEEDANCE });
  assert.equal(blockedClick.status, 409);
  assert.equal(blockedClick.body.code, 'VIDEO_MODEL_REFUSED');
  assert.match(blockedClick.body.error, /bereits abgelehnt/);
  assertNoRawProviderText(blockedClick.text, 'blocked click');
  const blockedFast = await click(chat.id, requestId, P1, { model: FAST });
  assert.equal(blockedFast.status, 409);
  assert.equal(submitted.length, callsBefore, 'a marked model never reaches the provider');
  assert.equal((await store.readSession(chat.id)).videoModelRequests.find((r) => r.id === requestId).status, 'pending', 'the card stays open');
  assert.equal((await store.readSession(chat.id)).jobs.length, 0);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);

  // the Director history says what happened (A4, card path): the waiting message of the tool and the hidden marker
  saved = await store.readSession(chat.id);
  const toolMessage = saved.messages.find((m) => m.role === 'tool' && m.videoModelChoiceId === requestId);
  const marker = saved.messages.find((m) => m.hidden && m.videoModelRequestId === requestId);
  for (const message of [toolMessage, marker]) {
    assert.match(message.content, /Seedance/);
    assert.match(message.content, /nicht erneut/);
    assert.match(message.content, /ohne reale Person/);
    assert.match(message.content, /nichts berechnet/);
    assertNoRawProviderText(message.content, 'director history');
  }
  assert.equal(marker.role, 'assistant');
  assert.ok(marker.content.startsWith('[System]'));
  director.say({ text: 'Ich schlage ein anderes Modell vor.' });
  await send(chat.id, P1, 'Und jetzt?');
  assert.match(JSON.stringify(director.requests.at(-1).messages), /Seedance[^"]*hat das Bild abgelehnt/);

  // the other models still work from the same card
  const ok = await click(chat.id, requestId, P1, { model: KLING });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(accepted().at(-1).model, KLING);
  assert.equal(ok.body.choice.status, 'submitted');
  const heldByJob = budgetLib.defaultBudget.reservationCount();
  assert.equal(heldByJob, 1, 'only the started job of the participant holds a reservation');

  // no other model fits: the card says so (twelve reference images: only Seedance 2.5 takes them)
  const adminChat = await newChat(ADMIN);
  const adminRefs = [];
  for (let i = 0; i < 12; i += 1) adminRefs.push((await store.saveAsset(adminChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'ref', cost: null })).id);
  await askInChat(adminChat.id, ADMIN, { reference_asset_ids: adminRefs });
  let adminChoice = await choiceOf(adminChat.id, ADMIN);
  assert.deepEqual(adminChoice.options.map((o) => o.id), [SEEDANCE], 'twelve references: only Seedance 2.5 fits');
  const alone = await click(adminChat.id, adminChoice.id, ADMIN, { model: SEEDANCE });
  assert.equal(alone.status, 422);
  assert.equal(alone.body.code, 'VIDEO_REAL_PERSON');
  adminChoice = await choiceOf(adminChat.id, ADMIN);
  assert.equal(adminChoice.noAlternative, true, 'the card knows that no other model is left');
  assert.equal(adminChoice.noAffordable, false);
  const adminSaved = await store.readSession(adminChat.id);
  assert.deepEqual(adminSaved.videoImageRefusals.map((entry) => [entry.key, entry.provider]), [[[...adminRefs].sort().join('|'), 'bytedance']], 'the card path remembers the refusal for these images, too');
  assert.equal(adminChoice.options.filter((o) => o.recommended).length, 0, 'nothing to recommend');
  assert.equal(adminChoice.status, 'pending');

  // ============ A4: the direct start (a remembered model) ============
  const directChat = await newChat(ADMIN);
  await store.mutateSession(directChat.id, (s) => { s.videoModelPreferences = { [ADMIN]: { model: SEEDANCE, name: 'Seedance 2.5', since: new Date().toISOString() } }; });
  const selfie = (await store.saveAsset(directChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'selfie', cost: null })).id;
  const otherPhoto = (await store.saveAsset(directChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'landscape', cost: null })).id;
  const beforeDirect = submitted.length;
  director.say({ text: 'Ich starte das Video.', tools: [{ name: 'generate_video', args: askVideo({ reference_asset_ids: [selfie] }) }] });
  director.say({ text: 'Seedance hat das Bild abgelehnt, ich probiere ein anderes Modell.' });
  const turn = await send(directChat.id, ADMIN, 'Mach ein Video aus meinem Selfie');
  assert.equal(turn.status, 200);
  assert.equal(submitted.length, beforeDirect + 1, 'one start, refused by the provider');
  const errorEvent = turn.events.find((event) => event.type === 'error');
  assert.ok(errorEvent, 'the chat gets an error event');
  assert.equal(errorEvent.code, 'VIDEO_REAL_PERSON', 'with the code, so the client says it in its language');
  assert.equal(errorEvent.fatal, false);
  assert.equal(errorEvent.message, refusal.MESSAGE_DE);
  assertNoRawProviderText(JSON.stringify(turn.events), 'live events');
  const directSaved = await store.readSession(directChat.id);
  const failedTool = directSaved.messages.find((m) => m.role === 'tool' && m.name === 'generate_video');
  assert.equal(failedTool.errorCode, 'VIDEO_REAL_PERSON');
  assert.match(failedTool.content, /^Fehler bei generate_video: Seedance \(bytedance\/seedance-2\.5\) hat dieses Bild abgelehnt/);
  assert.match(failedTool.content, /Schlage Seedance \(alle ByteDance-Modelle\) mit diesem Bild nicht erneut vor/);
  assert.match(failedTool.content, /andere passende Videomodelle/);
  assert.match(failedTool.content, /Bild ohne reale Person/);
  assertNoRawProviderText(failedTool.content, 'tool result');
  // the Director reads it in the same turn (the round after the tool call)
  assert.match(JSON.stringify(director.requests.at(-1).messages), /nicht erneut vor/);
  assert.equal(directSaved.jobs.length, 0);
  assertNoRawProviderText(JSON.stringify(await detail(directChat.id, ADMIN)), 'direct chat view');

  // Review: the remembered model must not start again. The refusal is kept for these images; the next call opens the card.
  assert.deepEqual(directSaved.videoImageRefusals.map((entry) => [entry.key, entry.provider]), [[selfie, 'bytedance']]);
  assert.ok(directSaved.videoModelPreferences[ADMIN], 'the remembered model stays remembered for other images');
  assert.match(failedTool.content, /gesperrt/, 'the Director is told what a second call does');
  const beforeAgain = submitted.length;
  director.say({ text: 'Ich zeige dir andere Modelle.', tools: [{ name: 'generate_video', args: askVideo({ reference_asset_ids: [selfie] }) }] });
  const again = await send(directChat.id, ADMIN, 'Versuch es mit einem anderen Modell');
  assert.equal(again.status, 200);
  assert.equal(submitted.length, beforeAgain, 'Seedance is not started a second time with the refused image');
  assert.ok(again.events.some((event) => event.type === 'video_model_choice'), 'the second call opens the card');
  const againChoice = await choiceOf(directChat.id, ADMIN);
  assert.deepEqual(againChoice.refusedProviders, ['bytedance'], 'the provider is marked from the start');
  assert.equal(optionOf(againChoice, SEEDANCE).refused.code, 'VIDEO_REAL_PERSON');
  assert.equal(optionOf(againChoice, FAST).refused.provider, 'bytedance');
  assert.equal(optionOf(againChoice, WAN).refused, null);
  assert.equal(againChoice.preferenceNote, null, 'the refusal says it, no extra note about the remembered model');
  assert.equal(againChoice.noAlternative, false);
  assert.equal(againChoice.status, 'pending');
  const againTool = (await store.readSession(directChat.id)).messages.filter((m) => m.role === 'tool' && m.videoModelChoiceId).at(-1);
  assert.match(againTool.content, /bytedance sind gesperrt/, 'the Director history names the closed provider');
  const closed = await click(directChat.id, againChoice.id, ADMIN, { model: SEEDANCE });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'VIDEO_MODEL_REFUSED');
  assert.equal(submitted.length, beforeAgain, 'the card does not start the refused model either');
  // another image is another case: the remembered model starts at once again
  const planSame = await videoModels.plan({ sessionId: directChat.id, args: askVideo({ reference_asset_ids: [selfie] }), defaultModel: SEEDANCE, viewer: { email: ADMIN } });
  assert.equal(planSame.kind, 'card');
  assert.deepEqual(planSame.refusedProviders, ['bytedance']);
  const planOther = await videoModels.plan({ sessionId: directChat.id, args: askVideo({ reference_asset_ids: [otherPhoto] }), defaultModel: SEEDANCE, viewer: { email: ADMIN } });
  assert.equal(planOther.kind, 'direct', 'another image goes to the remembered model');
  assert.equal(planOther.option.id, SEEDANCE);
  const planNone = await videoModels.plan({ sessionId: directChat.id, args: askVideo(), defaultModel: SEEDANCE, viewer: { email: ADMIN } });
  assert.equal(planNone.kind, 'direct', 'no image: nothing to match');
  assert.equal(videoModels.imageKeyOf({ first_frame_asset_id: 'b', reference_asset_ids: ['c', 'a', 'a'] }), 'a|b|c');
  assert.equal(videoModels.imageKeyOf({}), '');

  // a participant: the reservation of the direct start is released, too
  const pDirect = await newChat(P2);
  await store.mutateSession(pDirect.id, (s) => { s.videoModelPreferences = { [P2]: { model: FAST, name: 'Seedance 2.0 Fast', since: new Date().toISOString() } }; });
  await assert.rejects(call(pDirect.id, P2, askVideo()), (error) => error.code === 'VIDEO_REAL_PERSON' && error instanceof refusal.VideoRefusalError);
  assert.equal(budgetLib.defaultBudget.reservationCount(), heldByJob, 'the direct start released its reservation');
  assert.equal((await budgetLib.statusOfEmail(P2)).reservedUsd, 0);
  assert.equal((await budgetLib.statusOfEmail(P2)).spentUsd, 0);
  assert.equal((await store.readSession(pDirect.id)).jobs.length, 0);

  // another error of the same call is not turned into a refusal
  or.createVideo = async () => { throw new or.OpenRouterError('OpenRouter 500: provider hiccup', 500, ''); };
  await assert.rejects(call(directChat.id, ADMIN, askVideo()), (error) => !(error instanceof refusal.VideoRefusalError) && /provider hiccup/.test(error.message));

  // ============ review: the other models are over the budget ============
  {
    const option = (id, name, estimateUsd) => ({ id, name, estimateUsd, price: null, recommended: false });
    const request = {
      id: 'vmr-x',
      status: 'pending',
      prompt: 'p',
      refusedProviders: ['bytedance'],
      options: [option(SEEDANCE, 'Seedance 2.5', 1), option(KLING, 'Kling', 5), option(WAN, 'Wan', 8)]
    };
    const poor = { limitUsd: 1, remainingUsd: 0.5, reservedUsd: 0 };
    const view = videoModels.publicChoice(request, poor);
    assert.equal(view.noAlternative, false, 'models are left on the card');
    assert.equal(view.noAffordable, true, 'but none of them is within the budget');
    assert.deepEqual(view.options.map((o) => [o.id, Boolean(o.refused), Boolean(o.blocked)]), [[SEEDANCE, true, true], [KLING, false, true], [WAN, false, true]]);
    assert.equal(view.options.filter((o) => o.recommended).length, 0);
    const rich = videoModels.publicChoice(request, { limitUsd: 20, remainingUsd: 10, reservedUsd: 0 });
    assert.equal(rich.noAffordable, false);
    assert.equal(rich.noAlternative, false);
    assert.equal(videoModels.publicChoice(request, null).noAffordable, false, 'without a budget nothing is over it');
    const all = videoModels.publicChoice({ ...request, options: [option(SEEDANCE, 'Seedance 2.5', 1), option(FAST, 'Seedance Fast', 1)] }, poor);
    assert.equal(all.noAlternative, true);
    assert.equal(all.noAffordable, false, 'nothing left at all is the other sentence');
    const clean = videoModels.publicChoice({ ...request, refusedProviders: [] }, poor);
    assert.equal(clean.noAffordable, false, 'no refusal: no refusal sentence');
  }

  // ============ review: the same wording from another provider is not blamed on Seedance ============
  {
    const chatOther = await newChat(ADMIN);
    await askInChat(chatOther.id, ADMIN);
    const otherChoice = await choiceOf(chatOther.id, ADMIN);
    const spy = or.createVideo;
    or.createVideo = async (payload) => {
      submitted.push({ ...payload, refused: true });
      throw new or.OpenRouterError(REAL_MESSAGE, 400, OUTER_BODY);
    };
    const result = await click(chatOther.id, otherChoice.id, ADMIN, { model: KLING });
    or.createVideo = spy;
    assert.notEqual(result.body.code, 'VIDEO_REAL_PERSON', 'a Kling refusal gets no Seedance sentence');
    const after = await choiceOf(chatOther.id, ADMIN);
    assert.deepEqual(after.refusedProviders, [], 'no provider is marked by a foreign wording');
    assert.equal(after.lastErrorCode, null);
  }

  // ============ review: a job refused while it is polled ============
  {
    const poller = iso.load('lib/poller');
    const pollChat = await newChat(ADMIN);
    const reserved = await store.reserveAsset(pollChat.id, { kind: 'video', ext: '.mp4', prompt: 'selfie video' });
    const jobBase = { status: 'pending', source: null, provider: null, kind: 'video', model: SEEDANCE, createdAt: new Date().toISOString(), submittedAt: new Date().toISOString(), startedAt: null, cost: 0, error: null };
    await store.mutateSession(pollChat.id, (saved) => { saved.jobs.push({ ...jobBase, jobId: 'job-late', assetId: reserved.id, file: reserved.file, prompt: 'selfie video' }); });
    const job = (await store.readSession(pollChat.id)).jobs[0];
    await poller.handleFailed(pollChat.id, job, { error: { message: PROVIDER_ANSWER.error.message, code: PROVIDER_ANSWER.error.code } });
    const savedPoll = await store.readSession(pollChat.id);
    const failedJob = savedPoll.jobs[0];
    assert.equal(failedJob.status, 'failed');
    assert.equal(failedJob.errorCode, 'VIDEO_REAL_PERSON_JOB');
    assert.equal(failedJob.error, refusal.MESSAGE_JOB_DE);
    assertNoRawProviderText(JSON.stringify(savedPoll.messages), 'late refusal messages');
    assert.equal(savedPoll.messages.some((m) => /nichts berechnet/.test(m.content)), false, 'no claim about the bill');
    assert.ok(savedPoll.messages.some((m) => m.hidden && /nicht erneut vor/.test(m.content)), 'the Director learns what to do');
    const jobsView = (await detail(pollChat.id, ADMIN)).jobs.find((entry) => entry.assetId === reserved.id);
    assert.equal(jobsView.errorCode, 'VIDEO_REAL_PERSON_JOB', 'the card gets the code');
    assertNoRawProviderText(JSON.stringify(jobsView), 'job view');

    // another job error stays as it was, without a code
    const reserved2 = await store.reserveAsset(pollChat.id, { kind: 'video', ext: '.mp4', prompt: 'x' });
    await store.mutateSession(pollChat.id, (saved) => { saved.jobs.push({ ...jobBase, jobId: 'job-other', assetId: reserved2.id, file: reserved2.file, prompt: 'x' }); });
    const job2 = (await store.readSession(pollChat.id)).jobs.find((entry) => entry.assetId === reserved2.id);
    await poller.handleFailed(pollChat.id, job2, { error: { message: 'provider crashed' } });
    const failed2 = (await store.readSession(pollChat.id)).jobs.find((entry) => entry.assetId === reserved2.id);
    assert.equal(failed2.error, 'provider crashed');
    assert.equal(failed2.errorCode, undefined);
    // the same wording on a job of another provider is not turned into the Seedance sentence
    const reserved3 = await store.reserveAsset(pollChat.id, { kind: 'video', ext: '.mp4', prompt: 'y' });
    await store.mutateSession(pollChat.id, (saved) => { saved.jobs.push({ ...jobBase, model: KLING, jobId: 'job-kling', assetId: reserved3.id, file: reserved3.file, prompt: 'y' }); });
    const job3 = (await store.readSession(pollChat.id)).jobs.find((entry) => entry.assetId === reserved3.id);
    await poller.handleFailed(pollChat.id, job3, { error: { message: PROVIDER_ANSWER.error.message } });
    assert.equal((await store.readSession(pollChat.id)).jobs.find((entry) => entry.assetId === reserved3.id).errorCode, undefined);
  }

  // ============ A5: the node view ============
  or.createVideo = async (payload) => {
    submitted.push({ ...payload, refused: true });
    throw new or.OpenRouterError(REAL_MESSAGE, 400, OUTER_BODY);
  };
  const document = {
    format: 'ocd.workflow',
    version: 1,
    name: 'Selfie video',
    graph: { nodes: [{ id: 'n1', type: 'video.seedance', typeVersion: 1, x: 0, y: 0, params: { prompt: 'A walk through the city', duration: 5 } }], edges: [] }
  };
  const created = await api('/api/workflows', { method: 'POST', as: ADMIN, json: { name: 'Selfie video', document } });
  assert.equal(created.status, 201, created.text);
  const workflowId = created.body.workflow.id;
  const started = await api(`/api/workflows/${workflowId}/runs`, { method: 'POST', as: ADMIN, json: { mode: 'all' } });
  assert.equal(started.status, 202, started.text);
  let record = null;
  for (let i = 0; i < 100; i += 1) {
    record = (await api(`/api/workflows/${workflowId}/runs/${started.body.runId}`, { as: ADMIN })).body;
    if (record && record.status !== 'running') break;
    await sleep(50);
  }
  assert.equal(record.status, 'failed', JSON.stringify(record));
  assert.equal(record.nodes.n1.status, 'error');
  assert.equal(record.nodes.n1.code, 'VIDEO_REAL_PERSON', 'the node error carries the code');
  assert.match(record.nodes.n1.message, /Seedance rejects images that may show a real person/);
  assertNoRawProviderText(JSON.stringify(record), 'run record');
  assert.equal(budgetLib.defaultBudget.reservationCount(), heldByJob, 'no reservation is left by the failed node');
  assert.equal(accepted().length, 1, 'nothing was started by the node run');

  // a participant runs the same node: the run reservation is back once the run is over, nothing is spent
  or.createVideo = async (payload) => {
    submitted.push({ ...payload, refused: true });
    throw new or.OpenRouterError(REAL_MESSAGE, 400, OUTER_BODY);
  };
  const pWorkflow = await api('/api/workflows', { method: 'POST', as: P2, json: { name: 'Selfie video', document } });
  assert.equal(pWorkflow.status, 201, pWorkflow.text);
  const pRun = await api(`/api/workflows/${pWorkflow.body.workflow.id}/runs`, { method: 'POST', as: P2, json: { mode: 'all' } });
  assert.equal(pRun.status, 202, pRun.text);
  let pRecord = null;
  for (let i = 0; i < 100; i += 1) {
    pRecord = (await api(`/api/workflows/${pWorkflow.body.workflow.id}/runs/${pRun.body.runId}`, { as: P2 })).body;
    if (pRecord && pRecord.status !== 'running') break;
    await sleep(50);
  }
  assert.equal(pRecord.nodes.n1.code, 'VIDEO_REAL_PERSON');
  for (let i = 0; i < 40 && budgetLib.defaultBudget.reservationCount() !== heldByJob; i += 1) await sleep(25);
  assert.equal(budgetLib.defaultBudget.reservationCount(), heldByJob, 'the run reservation of the participant is released');
  assert.equal((await budgetLib.statusOfEmail(P2)).reservedUsd, 0);
  assert.equal((await budgetLib.statusOfEmail(P2)).spentUsd, 0);

  // a node error that is not a refusal keeps no code and its own message
  or.createVideo = async () => { throw new or.OpenRouterError('OpenRouter 500: provider hiccup', 500, ''); };
  const second = await api(`/api/workflows/${workflowId}/runs`, { method: 'POST', as: ADMIN, json: { mode: 'all', force: true } });
  assert.equal(second.status, 202, second.text);
  let record2 = null;
  for (let i = 0; i < 100; i += 1) {
    record2 = (await api(`/api/workflows/${workflowId}/runs/${second.body.runId}`, { as: ADMIN })).body;
    if (record2 && record2.status !== 'running') break;
    await sleep(50);
  }
  assert.equal(record2.nodes.n1.status, 'error');
  assert.equal(record2.nodes.n1.code, undefined);
  assert.match(record2.nodes.n1.message, /provider hiccup/);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
