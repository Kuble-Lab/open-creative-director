'use strict';

// The speech models of ElevenLabs (lib/elevenlabs.js): the list for the choice in the node (what the account offers, kept for an hour,
// the built-in list where the call cannot be made), the error for a model that ElevenLabs refuses, and the entries of the choice in
// the node (public/nodes/node-ui.js). The option source and the node itself are tested in test-nodes-api.js and
// test-nodes-generate.js. No network: global fetch is replaced, and anything that is not mocked fails. The key is a made-up value,
// only ever read from the environment of this process.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.ELEVENLABS_API_KEY = 'xi-test-key-ABCDEF0123456789';
const KEY = process.env.ELEVENLABS_API_KEY;

const eleven = require('../lib/elevenlabs');
const tools = require('../lib/tools');
const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const LANGS = ['de', 'en', 'es'];
const originalFetch = global.fetch;
const originalNow = Date.now;
let calls = [];

function reply(status, body) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
    async arrayBuffer() {
      const bytes = Buffer.from(text);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function mockFetch(handler) {
  calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    return handler(String(url), options);
  };
}

const caught = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

// Everything an error carries, as text: the key must not be in any of it.
const everythingOf = (err) => JSON.stringify([err.message, err.messageDe, err.code, err.data, err.status, String(err), err.stack]);

// What GET /v1/models answers, in an order of its own: speech models, models for speech to speech, a model this code does not know
// (newer), a duplicate, one without a name, and entries that are no models at all.
const API_LIST = [
  { model_id: 'eleven_multilingual_sts_v2', name: 'Eleven Multilingual v2 (STS)', can_do_text_to_speech: false, can_do_voice_conversion: true },
  { model_id: 'eleven_flash_v2', name: 'Eleven Flash v2', can_do_text_to_speech: true },
  { model_id: 'eleven_turbo_v2', name: 'Eleven Turbo v2', can_do_text_to_speech: true },
  { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 10000 },
  { model_id: 'eleven_v5_preview', name: 'Eleven v5 Preview', can_do_text_to_speech: true },
  { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, maximum_text_length_per_request: 10000 },
  { model_id: 'eleven_v4', name: 'Duplicate of v4', can_do_text_to_speech: true },
  { model_id: 'eleven_v3', can_do_text_to_speech: true },
  { model_id: '  ', name: 'blank id', can_do_text_to_speech: true },
  { name: 'no id', can_do_text_to_speech: true },
  { model_id: 'eleven_english_sts_v2', name: 'Eleven English v2 (STS)', can_do_text_to_speech: false },
  { model_id: 'eleven_no_flag', name: 'No flag' },
  null,
  'junk'
];
const API_VALUES = ['eleven_v4', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2', 'eleven_turbo_v2', 'eleven_v5_preview'];

const FALLBACK = eleven.TTS_MODELS_FALLBACK.map((model) => ({ ...model }));

async function testLiveList() {
  mockFetch(() => reply(200, API_LIST));
  const models = await eleven.listModels({ refresh: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/models');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['xi-api-key'], KEY);
  assert.equal(calls[0].options.body, undefined, 'a plain read');
  // speech models only, the usual ones in the order of the built-in list, a newer one behind them, a name falls back to the id
  assert.deepEqual(models.map((model) => model.model_id), API_VALUES);
  assert.deepEqual(models[0], { model_id: 'eleven_v4', name: 'Eleven v4' }, 'the first of two entries with the same id');
  assert.deepEqual(models[1], { model_id: 'eleven_v3', name: 'eleven_v3' });
  assert.deepEqual(Object.keys(models[2]).sort(), ['model_id', 'name'], 'only what the choice needs');
}

async function testCache() {
  mockFetch(() => reply(200, API_LIST));
  await eleven.listModels({ refresh: true });
  const first = await eleven.listModels();
  const second = await eleven.listModels();
  assert.equal(calls.length, 1, 'kept: one call for the three lists');
  assert.deepEqual(second, first);
  // what the caller gets is its own copy
  first[0].name = 'changed';
  first.pop();
  assert.equal((await eleven.listModels())[0].name, 'Eleven v4');
  assert.equal((await eleven.listModels()).length, API_VALUES.length);
  assert.equal(calls.length, 1);
  // refresh reads again
  await eleven.listModels({ refresh: true });
  assert.equal(calls.length, 2);
  // an hour later it is read again, 59 minutes later it is not
  const base = originalNow();
  try {
    Date.now = () => base + 59 * 60 * 1000;
    await eleven.listModels();
    assert.equal(calls.length, 2, 'after 59 minutes');
    Date.now = () => base + 61 * 60 * 1000;
    await eleven.listModels();
    assert.equal(calls.length, 3, 'after 61 minutes');
  } finally {
    Date.now = originalNow;
  }
}

async function testFallback() {
  assert.deepEqual(FALLBACK.map((model) => model.model_id), [
    'eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational', 'eleven_multilingual_v2',
    'eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5', 'eleven_turbo_v2'
  ]);
  assert.ok(Object.isFrozen(eleven.TTS_MODELS_FALLBACK) && eleven.TTS_MODELS_FALLBACK.every((model) => Object.isFrozen(model)));
  assert.equal(new Set(FALLBACK.map((model) => model.name)).size, FALLBACK.length, 'every model has a name of its own');
  assert.equal(FALLBACK[0].model_id, tools.DEFAULT_ELEVENLABS_MODEL_ID, 'the default model leads the list');
  assert.equal(FALLBACK[0].name, 'Eleven v4');

  // whatever goes wrong, the list comes back and nothing is thrown
  const failures = [
    ['no right to read models (401)', () => reply(401, { detail: { status: 'missing_permissions', message: `The API key ${KEY} is missing the permission models_read.` } })],
    ['forbidden (403)', () => reply(403, { detail: { status: 'insufficient_permissions', message: 'no' } })],
    ['not found (404)', () => reply(404, '')],
    ['rate limit (429)', () => reply(429, { detail: 'slow down' })],
    ['server error (500)', () => reply(500, 'upstream broke')],
    ['unreadable answer', () => ({ ok: true, status: 200, json: async () => JSON.parse('{not json') })],
    ['not a list', () => reply(200, { models: API_LIST })],
    ['an empty list', () => reply(200, [])],
    ['no speech model in it', () => reply(200, [{ model_id: 'eleven_multilingual_sts_v2', can_do_text_to_speech: false }])],
    ['network error that names the key', () => {
      throw new TypeError(`fetch failed for https://x/?key=${KEY}`);
    }],
    ['timeout of fetch itself', () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
      throw err;
    }]
  ];
  for (const [label, handler] of failures) {
    mockFetch(handler);
    const models = await eleven.listModels({ refresh: true });
    assert.deepEqual(models, FALLBACK, label);
    assert.equal(calls.length, 1, label);
  }

  // a copy: changing it changes neither the built-in list nor the next answer
  mockFetch(() => reply(500, 'x'));
  const mine = await eleven.listModels({ refresh: true });
  mine[0].name = 'changed';
  assert.equal(eleven.TTS_MODELS_FALLBACK[0].name, 'Eleven v4');
  assert.equal((await eleven.listModels())[0].name, 'Eleven v4');
}

async function testRetryAfterFailure() {
  // a failed call is not repeated with every request (a key without the right would ask ElevenLabs on every page load) ...
  let healthy = false;
  mockFetch(() => (healthy ? reply(200, API_LIST) : reply(401, { detail: { status: 'missing_permissions', message: 'no' } })));
  await eleven.listModels({ refresh: true });
  assert.deepEqual(await eleven.listModels(), FALLBACK);
  assert.deepEqual(await eleven.listModels(), FALLBACK);
  assert.equal(calls.length, 1, 'the failure is kept for a while');
  healthy = true;
  const base = originalNow();
  try {
    // ... but not for an hour: a few minutes later it is tried again, and a good answer replaces the built-in list
    Date.now = () => base + 4 * 60 * 1000;
    assert.deepEqual(await eleven.listModels(), FALLBACK);
    assert.equal(calls.length, 1, 'after 4 minutes');
    Date.now = () => base + 6 * 60 * 1000;
    assert.deepEqual((await eleven.listModels()).map((model) => model.model_id), API_VALUES, 'after 6 minutes');
    assert.equal(calls.length, 2);
    assert.deepEqual((await eleven.listModels()).map((model) => model.model_id), API_VALUES);
    assert.equal(calls.length, 2, 'and it is kept again');
  } finally {
    Date.now = originalNow;
  }
}

async function testNoKey() {
  const saved = process.env.ELEVENLABS_API_KEY;
  const base = originalNow();
  try {
    // three hours on: every earlier answer is out of date
    Date.now = () => base + 3 * 60 * 60 * 1000;
    delete process.env.ELEVENLABS_API_KEY;
    mockFetch(() => reply(200, API_LIST));
    assert.equal(eleven.hasKey(), false);
    assert.deepEqual(await eleven.listModels(), FALLBACK);
    assert.deepEqual(await eleven.listModels({ refresh: true }), FALLBACK);
    assert.equal(calls.length, 0, 'nothing is sent without a key');
    // the missing key is not remembered: with the key the next call asks, with no refresh needed
    process.env.ELEVENLABS_API_KEY = saved;
    assert.deepEqual((await eleven.listModels()).map((model) => model.model_id), API_VALUES);
    assert.equal(calls.length, 1);
  } finally {
    Date.now = originalNow;
    process.env.ELEVENLABS_API_KEY = saved;
  }
}

async function testSpeechRequest() {
  mockFetch(() => reply(200, 'ID3-fake-speech'));
  const buffer = await eleven.tts({ text: 'Hallo', voiceId: 'voice-1', modelId: 'eleven_v4' });
  assert.equal(buffer.toString(), 'ID3-fake-speech');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=mp3_44100_128');
  assert.deepEqual(calls[0].body, { text: 'Hallo', model_id: 'eleven_v4' });
}

async function testModelRefused() {
  const say = (modelId, status, body) => {
    mockFetch(() => reply(status, body));
    return caught(eleven.tts({ text: 'Hallo', voiceId: 'v', modelId }));
  };
  // the three answers of the error list of ElevenLabs (https://elevenlabs.io/docs/eleven-api/resources/errors), in its new shape
  // (type, code, status, request_id) and in the older one (status and message only)
  const documented = [
    [404, 'model_not_found', 'The specified model does not exist.'],
    [400, 'unsupported_model', 'The specified model is not supported for this operation.'],
    [403, 'model_access_denied', 'You do not have access to this model.']
  ];
  for (const [status, code, message] of documented) {
    const shapes = [
      { detail: { type: 'x', code, message, status: code, request_id: 'r1' } },
      { detail: { code, message, request_id: 'r2' } },
      { detail: { status: code, message } }
    ];
    for (const body of shapes) {
      const error = await say('eleven_nope', status, body);
      assert.ok(error instanceof eleven.ElevenLabsError, `${status} ${code}`);
      assert.equal(error.code, 'ELEVENLABS_MODEL_REJECTED', `${status} ${code}`);
      assert.equal(error.status, status);
      assert.deepEqual(error.data, { model: 'eleven_nope' });
      // the speech keeps its German message (the Director and the log); it names the model and what to do
      assert.match(error.message, /Sprachmodell «eleven_nope»/);
      assert.equal(error.message, error.messageDe);
      assert.match(error.message, /Wähle ein anderes Modell/);
      assert.equal(everythingOf(error).includes(KEY), false);
    }
  }
  // a validation error that points at the model
  const validation = await say('eleven_nope', 422, { detail: [{ loc: ['body', 'model_id'], msg: 'unknown model', type: 'value_error' }] });
  assert.equal(validation.code, 'ELEVENLABS_MODEL_REJECTED');
  assert.equal(validation.status, 422);

  // the name is cut and cleaned, and the key is scrubbed from it
  const long = await say(`${'m'.repeat(200)}`, 404, { detail: { status: 'model_not_found', message: 'x' } });
  assert.equal(long.data.model.length, 80);
  const tricky = await say(`a\n${KEY}\tb`, 404, { detail: { status: 'model_not_found', message: `no model, key ${KEY}` } });
  assert.equal(tricky.code, 'ELEVENLABS_MODEL_REJECTED');
  assert.equal(everythingOf(tricky).includes(KEY), false, 'the key is in no part of the error');
  assert.equal(tricky.data.model, 'a [ELEVENLABS-KEY] b');

  // everything else about speech is as it was: the old plain message, and the codes that were there before
  for (const [status, body] of [
    [400, { detail: { status: 'text_too_long', message: 'The provided text exceeds the maximum allowed length.' } }],
    [400, { detail: { status: 'invalid_voice_id', message: 'The voice ID format is invalid.' } }],
    [404, { detail: { status: 'voice_not_found', message: 'A voice with the id v does not exist.' } }],
    [403, { detail: { status: 'insufficient_permissions', message: 'You do not have the required permissions.' } }],
    [422, { detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'value_error.missing' }] }],
    [404, '']
  ]) {
    const error = await say('eleven_v4', status, body);
    assert.equal(error.code, undefined, `${status} ${JSON.stringify(body).slice(0, 40)}`);
    assert.equal(error.status, status);
    assert.match(error.message, new RegExp(`^ElevenLabs antwortete mit HTTP ${status}`));
  }
  assert.equal((await say('eleven_v4', 429, 'x')).code, 'ELEVENLABS_RATE_LIMITED');
  assert.equal((await say('eleven_v4', 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })).code, 'ELEVENLABS_KEY_REJECTED');
  assert.equal((await say('eleven_v4', 401, { detail: { status: 'quota_exceeded', message: 'You have 0 credits left.' } })).code, 'ELEVENLABS_QUOTA_EXCEEDED');
  assert.equal((await say('eleven_v4', 500, 'broke')).code, 'ELEVENLABS_SERVER_ERROR');
  // only a call that names a model asks the question: the voice list with the same answer keeps its plain message
  mockFetch(() => reply(404, { detail: { status: 'model_not_found', message: 'no' } }));
  const voices = await caught(eleven.listVoices());
  assert.equal(voices.code, undefined);
  assert.match(voices.message, /^ElevenLabs antwortete mit HTTP 404/);
  // and a speech call without a model name (the tool always passes one) gets the plain message, too
  const nameless = await caught(eleven.tts({ text: 'Hallo', voiceId: 'v', modelId: '' }));
  assert.equal(nameless.code, undefined);
}

/* ---------- the choice in the node ---------- */

function loadUi(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: { graph: graphLib, api: {} }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  vm.runInNewContext(read('public/nodes/node-ui.js'), { window, document: window.document, setTimeout, clearTimeout }, { filename: 'public/nodes/node-ui.js' });
  return window.OCDNodes.ui;
}

function testChoiceInTheNode() {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const param = plain(registryModule.publicRegistry()).nodeTypes.find((type) => type.type === 'audio.tts').params.find((item) => item.id === 'model_id');
  assert.equal(param.kind, 'select');
  const served = { options: FALLBACK.map((model) => ({ value: model.model_id, label: model.name })) };
  for (const lang of LANGS) {
    const ui = loadUi(lang);
    const options = plain(ui.normalizeOptions(served));
    assert.deepEqual(options.map((option) => option.value), FALLBACK.map((model) => model.model_id));
    // only the models: no entry for "default" (the node names Eleven v4 itself), the model of the node is selected
    const entries = plain(ui.selectEntries(param, { state: 'ready', options }, 'eleven_v4'));
    assert.deepEqual(entries.map((entry) => entry.value), FALLBACK.map((model) => model.model_id));
    assert.equal(entries[0].label, 'Eleven v4');
    // a model of an older workflow that the list does not offer stays in the choice, named by its id, after the others
    const old = plain(ui.selectEntries(param, { state: 'ready', options }, 'eleven_monolingual_v1'));
    assert.deepEqual(old.map((entry) => entry.value), [...FALLBACK.map((model) => model.model_id), 'eleven_monolingual_v1']);
    assert.equal(old.at(-1).label, 'eleven_monolingual_v1');
    // until the list has arrived (or when it cannot be read) the model of the node is still there to see
    for (const state of ['loading', 'error']) {
      assert.deepEqual(plain(ui.selectEntries(param, { state, options: [] }, 'eleven_v4')).map((entry) => entry.value), ['eleven_v4'], state);
    }

    // the error text for a refused model, in the language of the page, with the model in it
    const text = ui.issueText({ code: 'ELEVENLABS_MODEL_REJECTED', data: { model: 'eleven_nope' }, message: 'raw' });
    assert.notEqual(text, 'raw', `${lang}: translated`);
    assert.ok(text.includes('eleven_nope'), `${lang}: names the model`);
    assert.doesNotMatch(text, /\{\w+\}/, `${lang}: every value is filled in`);
    assert.equal(text.includes('ß'), false);
  }
}

(async () => {
  try {
    mockFetch(() => {
      throw new Error('unexpected network call');
    });
    for (const test of [testLiveList, testCache, testFallback, testRetryAfterFailure, testNoKey, testSpeechRequest, testModelRefused, testChoiceInTheNode]) {
      await test();
      console.log(`ok ${test.name}`);
    }
    console.log('test-elevenlabs-models.js: ok');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
})();
