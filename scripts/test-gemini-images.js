'use strict';

// The Google image models straight at Google (lib/gemini-images.js), the router in lib/tools.js (createImage), the image nodes with
// only the Google key, and the texts of the setting (the store itself, name, mask and mirror into the environment, is checked in
// test-settings.js; the admin-only routes in test-user-management.js). No network and no real key: global fetch is a double that
// answers for Google and refuses every other address, OpenRouter is a double, the cost journal is replaced; all is restored at the end.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');

const { PATHS } = require('../lib/config');
const store = require('../lib/store');
const or = require('../lib/openrouter');
const costs = require('../lib/costs');
const tools = require('../lib/tools');
const gemini = require('../lib/gemini-images');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createRegistry } = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// clearly no real key: in no format of Google, so no secret scanner takes it for one
const KEY = 'test-only-gemini-key-not-real';
const NANO = 'google/gemini-nano-banana-2.1';
const PRO = 'google/gemini-3-pro-image';
const GPT = 'openai/gpt-image-2';
const endpoint = (code) => `https://generativelanguage.googleapis.com/v1beta/models/${code}:generateContent`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_B64 = PNG.toString('base64');
const OTHER_B64 = Buffer.from('another picture').toString('base64');
const REF_URL = `data:image/png;base64,${PNG_B64}`;

/* ---------- doubles ---------- */

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function setEnv(name, value) {
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
// a part of the test sets up its own doubles and gives them back at its end
async function scoped(fn) {
  const mark = restorers.length;
  try {
    return await fn();
  } finally {
    while (restorers.length > mark) restorers.pop()();
  }
}

// Google: every request is kept, google.answer(call) answers. OpenRouter: the payloads it got. The console: every line written.
const google = { calls: [], answer: null };
const openrouter = { calls: [], answer: null };
const OR_RESULT = { data: [{ b64_json: OTHER_B64, media_type: 'image/png' }], usage: { cost: 0.04 } };
const logged = [];

function installGoogle() {
  patch(global, 'fetch', async (url, init = {}) => {
    const address = String(url);
    if (!address.startsWith('https://generativelanguage.googleapis.com/')) throw new Error(`no network in this test: ${address}`);
    const call = { url: address, ...init };
    google.calls.push(call);
    return google.answer(call);
  });
}

function installOpenRouter({ hasKey = true } = {}) {
  patch(or, 'hasKey', () => hasKey);
  patch(or, 'createImage', async (payload) => {
    openrouter.calls.push(payload);
    return openrouter.answer ? openrouter.answer(payload) : OR_RESULT;
  });
  for (const name of ['warn', 'log', 'error']) patch(console, name, (...args) => logged.push(args.map(String).join(' ')));
}

// A new round: Google answers `answer` (a Response or a function of the call), the lists are empty.
function reset(answer = () => assert.fail('Google was not expected')) {
  google.calls.length = 0;
  google.answer = typeof answer === 'function' ? answer : () => answer;
  openrouter.calls.length = 0;
  openrouter.answer = null;
  logged.length = 0;
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const image = (extra = {}, parts = [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]) =>
  json(200, { candidates: [{ content: { parts }, finishReason: 'STOP' }], ...extra });
const apiError = (status, message, statusText, reason) =>
  json(status, { error: { code: status, message, status: statusText, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } });
const bodyOf = (call) => JSON.parse(call.body);
const hang = (call) =>
  new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))));

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail('the call should have failed');
}

// one call of the module, Google answering `answer`
async function ask(answer, payload = { model: NANO, prompt: 'x', n: 1 }, options) {
  reset(answer);
  return gemini.createImage(payload, options);
}

/* ---------- the table, the key, what goes to Google ---------- */

function testTableAndAccepts() {
  assert.deepEqual(Object.keys(gemini.MODELS), [NANO, PRO], 'one table with the two Google models');
  assert.equal(gemini.MODELS[NANO].code, 'gemini-nano-banana-2.1');
  assert.equal(gemini.MODELS[PRO].code, 'gemini-3-pro-image', 'the stable code, not the preview');
  assert.deepEqual(gemini.MODELS[NANO].usdPerMillionTokens, { input: 1.5, text: 7.5, image: 30 });
  assert.deepEqual(gemini.MODELS[PRO].usdPerMillionTokens, { input: 2, text: 12, image: 120 });

  const base = { model: NANO, prompt: 'x', n: 1 };
  setEnv('GEMINI_API_KEY', undefined);
  assert.equal(gemini.accepts(base), false, 'no key: OpenRouter');
  setEnv('GEMINI_API_KEY', '   ');
  assert.equal(gemini.hasKey(), false, 'blanks are no key');
  setEnv('GEMINI_API_KEY', KEY);
  assert.equal(gemini.hasKey(), true, 'a key of any form: no prefix is checked');
  assert.equal(gemini.accepts(base), true);
  assert.equal(gemini.accepts({ model: PRO, prompt: 'x' }), true, 'n may be left out');
  for (const ratio of tools.IMAGE_RATIOS) assert.equal(gemini.accepts({ ...base, aspect_ratio: ratio }), true, `every ratio of the app: ${ratio}`);
  const ref = (url, type = 'image_url') => ({ type, image_url: { url } });
  assert.equal(gemini.accepts({ ...base, input_references: [ref(REF_URL), ref(`data:image/webp;base64,${PNG_B64}`)] }), true);
  // what stays with OpenRouter, untouched
  for (const [why, payload] of [
    ['another provider', { ...base, model: GPT }],
    ['a Google model without an entry', { ...base, model: 'google/gemini-3.1-flash-image' }],
    ['an inherited property', { ...base, model: 'toString' }],
    ['no prompt', { ...base, prompt: ' ' }],
    ['two images', { ...base, n: 2 }],
    ['a ratio Google does not know', { ...base, aspect_ratio: '7:5' }],
    ['a field that is not translated', { ...base, quality: 'high' }],
    ['a GIF', { ...base, input_references: [ref(`data:image/gif;base64,${PNG_B64}`)] }],
    ['a web address', { ...base, input_references: [ref('https://example.com/a.png')] }],
    ['no base64', { ...base, input_references: [ref(`data:image/png,${PNG_B64}`)] }],
    ['no image', { ...base, input_references: [ref(REF_URL, 'video_url')] }],
    ['no list', { ...base, input_references: REF_URL }],
    ['no payload', null]
  ]) {
    assert.equal(gemini.accepts(payload), false, why);
  }
}

/* ---------- the request ---------- */

async function testRequest() {
  setEnv('GEMINI_API_KEY', KEY);
  // text to image: v1beta, the key in the header, the text, format and size in imageConfig; the answer in the shape of OpenRouter
  const result = await ask(image(), { model: NANO, prompt: 'A red kite', n: 1, aspect_ratio: '16:9' });
  assert.equal(google.calls.length, 1);
  const call = google.calls[0];
  assert.equal(call.url, endpoint('gemini-nano-banana-2.1'));
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.headers, { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' });
  assert.deepEqual(bodyOf(call), {
    contents: [{ parts: [{ text: 'A red kite' }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '1K' } }
  });
  assert.ok(!call.url.includes(KEY) && !call.body.includes(KEY), 'the key travels in the header only');
  assert.doesNotMatch(call.body, /responseFormat/, 'the field of the examples of the docs answers 400 (checked 2026-10-09)');
  assert.ok(call.signal instanceof AbortSignal, 'a timer guards the request');
  assert.deepEqual(result, { data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.034 } }, 'no usage: the list price');

  // Nano Banana Pro without a ratio: its code, the size only
  await ask(image(), { model: PRO, prompt: 'Portrait', n: 1 });
  assert.equal(google.calls[0].url, endpoint('gemini-3-pro-image'));
  assert.deepEqual(bodyOf(google.calls[0]).generationConfig.imageConfig, { imageSize: '1K' });

  // image to image: the text, then the reference images from the data URLs in their order; the payload is only read
  const payload = Object.freeze({
    model: NANO,
    prompt: 'Make it dusk',
    n: 1,
    input_references: Object.freeze([
      Object.freeze({ type: 'image_url', image_url: Object.freeze({ url: REF_URL }) }),
      Object.freeze({ type: 'image_url', image_url: Object.freeze({ url: `data:image/jpeg;base64,${OTHER_B64}` }) })
    ]),
    aspect_ratio: '9:16'
  });
  await ask(image(), payload);
  assert.deepEqual(bodyOf(google.calls[0]).contents[0].parts, [
    { text: 'Make it dusk' },
    { inline_data: { mime_type: 'image/png', data: PNG_B64 } },
    { inline_data: { mime_type: 'image/jpeg', data: OTHER_B64 } }
  ]);
  assert.equal(bodyOf(google.calls[0]).generationConfig.imageConfig.aspectRatio, '9:16');
}

/* ---------- the answer and the cost ---------- */

async function testAnswers() {
  setEnv('GEMINI_API_KEY', KEY);
  // camelCase, as REST answers: text and image; without the list by kind all tokens of the answer count as image tokens
  let result = await ask(
    image({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1160, thoughtsTokenCount: 300 } }, [
      { text: 'Here is your kite.' },
      { inlineData: { mimeType: 'image/jpeg', data: OTHER_B64 } }
    ])
  );
  assert.deepEqual(result.data, [{ b64_json: OTHER_B64, media_type: 'image/jpeg' }]);
  assert.equal(result.usage.cost, 0.0372, '(100 x 1.50 + 300 x 7.50 + 1160 x 30) / 1e6');

  // snake_case, with the list by kind
  result = await ask(
    json(200, {
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: OTHER_B64 } }] }, finish_reason: 'STOP' }],
      usage_metadata: { prompt_token_count: 10, candidates_token_count: 1120, candidates_tokens_details: [{ modality: 'IMAGE', token_count: 1120 }] }
    })
  );
  assert.deepEqual(result.data, [{ b64_json: OTHER_B64, media_type: 'image/webp' }]);
  assert.equal(result.usage.cost, 0.033615, '(10 x 1.50 + 1120 x 30) / 1e6');

  // interim images of the thinking (thought: true) are skipped; the last other image is the final one
  result = await ask(
    image({}, [
      { thought: true, inlineData: { mimeType: 'image/png', data: OTHER_B64 } },
      { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
      { thought: true, inlineData: { mimeType: 'image/png', data: OTHER_B64 } }
    ])
  );
  assert.equal(result.data[0].b64_json, PNG_B64);
  result = await ask(image({}, [{ thought: true, inlineData: { mimeType: 'image/png', data: OTHER_B64 } }]));
  assert.equal(result.data[0].b64_json, OTHER_B64, 'only interim images: the last one');

  // the cost: thinking and the TEXT share at the text price, the IMAGE share at the image price, Pro at its own prices
  const costOf = async (usageMetadata, model = NANO) => (await ask(image({ usageMetadata }), { model, prompt: 'x' })).usage.cost;
  assert.equal(
    await costOf({ promptTokenCount: 100, thoughtsTokenCount: 300, candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }, { modality: 'IMAGE', tokenCount: 1120 }] }),
    0.0363,
    '(100 x 1.50 + 340 x 7.50 + 1120 x 30) / 1e6'
  );
  assert.equal(await costOf({ candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] }), 0.0336, 'one image of 1K, as in the price list');
  assert.equal(await costOf({ promptTokenCount: 2800, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] }, PRO), 0.14, '(2800 x 2 + 1120 x 120) / 1e6');
  // no image tokens: the list price of lib/image-models.js, never 0
  assert.equal(await costOf(undefined), 0.034);
  assert.equal(await costOf(undefined, PRO), 0.134);
  assert.equal(await costOf({ promptTokenCount: 0, candidatesTokenCount: 0 }), 0.034);
  assert.equal(await costOf({ candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }] }), 0.034);
  assert.equal(await costOf({ candidatesTokenCount: 'many' }, PRO), 0.134);
}

/* ---------- blocks and errors ---------- */

async function testBlocksAndErrors() {
  setEnv('GEMINI_API_KEY', KEY);
  const final = async (answer, message, code = 'GEMINI_IMAGE_BLOCKED') => {
    const err = await failure(ask(answer));
    assert.ok(err instanceof gemini.GeminiImageError, err.message);
    assert.equal(err.code, code);
    assert.equal(err.fallback, false, `${message}: final`);
    assert.equal(err.message, message);
  };
  // a block: the sentence that OpenRouter handed on for Nano Banana 2.1 ("OpenRouter 400: Gemini could not generate an image (IMAGE_OTHER)")
  await final(json(200, { candidates: [{ finishReason: 'IMAGE_OTHER' }] }), 'Google: Gemini could not generate an image (IMAGE_OTHER)');
  await final(json(200, { candidates: [{ content: { parts: [{ text: 'Sorry' }] }, finishReason: 'IMAGE_SAFETY' }] }), 'Google: Gemini could not generate an image (IMAGE_SAFETY)');
  await final(json(200, { candidates: [{ finish_reason: 'IMAGE_PROHIBITED_CONTENT' }] }), 'Google: Gemini could not generate an image (IMAGE_PROHIBITED_CONTENT)');
  await final(json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), 'Google: Gemini could not generate an image (PROHIBITED_CONTENT)');
  await final(json(200, { prompt_feedback: { block_reason: 'SAFETY' } }), 'Google: Gemini could not generate an image (SAFETY)');
  // no image and no reason
  await final(image({}, [{ text: 'I cannot\ncreate  that.' }, { text: 'hidden', thought: true }]), 'Google: Gemini answered with text instead of an image: I cannot create that.', 'GEMINI_IMAGE_NO_IMAGE');
  await final(json(200, { candidates: [] }), 'Google: Gemini returned no image.', 'GEMINI_IMAGE_NO_IMAGE');

  // HTTP errors: the message of Google (like "OpenRouter 429: ..."), the summary for the log, whether the call may be repeated
  const rules = [[400, false], [401, true], [402, true], [403, true], [404, true], [408, false], [413, false], [422, false], [429, true], [500, true], [503, true], [504, true]];
  for (const [status, fallback] of rules) {
    const err = await failure(ask(apiError(status, 'Some detail.', 'SOME_STATUS')));
    assert.equal(err.code, 'GEMINI_IMAGE_HTTP');
    assert.equal(err.status, status);
    assert.equal(err.fallback, fallback, `HTTP ${status}`);
    assert.equal(err.summary, `HTTP ${status} SOME_STATUS`);
    assert.ok(err.message.startsWith(`Google ${status}: Some detail.`), err.message);
    assert.equal(/GEMINI_API_KEY pruefen/.test(err.message), status === 401 || status === 403, `HTTP ${status}: only a problem of the key points at it`);
  }
  // an invalid or expired key: 400 with the reason API_KEY_INVALID counts like the 401 of the docs
  let err = await failure(ask(apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')));
  assert.equal(err.fallback, true);
  assert.equal(err.message, 'Google 400: API key not valid. Please pass a valid API key. - GEMINI_API_KEY pruefen (Einstellungen)');
  // a page of a proxy by its title, an empty body, an answer that is no JSON
  err = await failure(ask(new Response('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>', { status: 502 })));
  assert.equal(err.message, 'Google 502: 502 Bad Gateway');
  err = await failure(ask(new Response('', { status: 500 })));
  assert.equal(err.message, 'Google 500: Google antwortete mit HTTP 500');
  err = await failure(ask(new Response('<<<', { status: 200 })));
  assert.equal(err.code, 'GEMINI_IMAGE_BAD_ANSWER');
  assert.equal(err.fallback, true);

  // the key is in no message and no summary, wherever Google or the model repeats it
  err = await failure(ask(apiError(403, `The key ${KEY} is blocked.`, KEY)));
  assert.ok(!err.message.includes(KEY) && !err.summary.includes(KEY), `${err.message} / ${err.summary}`);
  err = await failure(ask(image({}, [{ text: `leaked ${KEY}` }])));
  assert.ok(!err.message.includes(KEY), err.message);
}

async function testTransport() {
  setEnv('GEMINI_API_KEY', KEY);
  // no answer: the connection fails
  let err = await failure(
    ask(() => {
      throw Object.assign(new TypeError(`fetch failed for ${KEY}`), { cause: { code: 'ECONNRESET' } });
    })
  );
  assert.equal(err.code, 'GEMINI_IMAGE_NETWORK');
  assert.equal(err.fallback, true);
  assert.equal(err.summary, 'no answer (ECONNRESET)');
  assert.ok(!err.message.includes(KEY), err.message);
  // no answer in time: the own timer cancels the request, also while the body is on its way
  err = await failure(ask(hang, undefined, { timeoutMs: 20 }));
  assert.equal(err.code, 'GEMINI_IMAGE_TIMEOUT');
  assert.equal(err.fallback, true);
  assert.ok(google.calls[0].signal.aborted, 'the request is cancelled');
  err = await failure(ask((call) => ({ status: 200, text: () => hang(call) }), undefined, { timeoutMs: 20 }));
  assert.equal(err.code, 'GEMINI_IMAGE_TIMEOUT');
  assert.equal(gemini.TIMEOUT_MS, 120 * 1000);
  // a request above the inline limit of 20 MB is not sent
  const huge = { model: NANO, prompt: 'x', input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}` } }] };
  err = await failure(ask(image(), huge));
  assert.equal(err.code, 'GEMINI_IMAGE_TOO_LARGE');
  assert.equal(err.fallback, true);
  assert.equal(google.calls.length, 0);
}

/* ---------- the router (lib/tools.js createImage) ---------- */

async function testRouter() {
  const payload = { model: NANO, prompt: 'A red kite', n: 1, aspect_ratio: '16:9' };
  const warning = (summary) => [`[gemini] ${NANO}: kein Bild von Google (${summary}), ein Versuch ueber OpenRouter.`];

  await scoped(async () => {
    installOpenRouter();
    // without GEMINI_API_KEY nothing changes: OpenRouter gets the payload byte for byte, Google nothing
    setEnv('GEMINI_API_KEY', undefined);
    for (const model of [GPT, NANO, PRO]) {
      reset();
      assert.equal(await tools.createImage({ model, prompt: 'A red kite', n: 1 }), OR_RESULT);
      assert.equal(JSON.stringify(openrouter.calls[0]), `{"model":"${model}","prompt":"A red kite","n":1}`);
      assert.equal(google.calls.length, 0);
    }

    // with the key a Google model goes to Google; another model and a payload Google cannot take go to OpenRouter untouched
    setEnv('GEMINI_API_KEY', KEY);
    reset(image());
    assert.equal((await tools.createImage(payload)).data[0].b64_json, PNG_B64);
    assert.equal(openrouter.calls.length, 0);
    for (const other of [{ model: GPT, prompt: 'x', n: 1 }, { model: NANO, prompt: 'x', n: 1, quality: 'high' }]) {
      reset();
      assert.equal(await tools.createImage(other), OR_RESULT);
      assert.equal(openrouter.calls[0], other);
    }

    // every rule of the repeat: once through OpenRouter with the same payload, one warning with the code, never the key
    const repeats = [
      [apiError(429, 'Quota.', 'RESOURCE_EXHAUSTED'), 'HTTP 429 RESOURCE_EXHAUSTED'],
      [apiError(500, 'Oops.', 'INTERNAL'), 'HTTP 500 INTERNAL'],
      [apiError(503, 'Overloaded.', 'UNAVAILABLE'), 'HTTP 503 UNAVAILABLE'],
      [apiError(401, 'No key.', 'UNAUTHENTICATED'), 'HTTP 401 UNAUTHENTICATED'],
      [apiError(402, 'Credit.', 'payment_required'), 'HTTP 402 payment_required'],
      [apiError(403, 'Denied.', 'PERMISSION_DENIED'), 'HTTP 403 PERMISSION_DENIED'],
      [apiError(404, 'Not found.', 'NOT_FOUND'), 'HTTP 404 NOT_FOUND'],
      [apiError(400, 'API key expired.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'HTTP 400 INVALID_ARGUMENT'],
      [
        () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        },
        'no answer (ECONNREFUSED)'
      ],
      [new Response('<<<', { status: 200 }), 'answer is no JSON']
    ];
    for (const [answer, summary] of repeats) {
      reset(answer);
      assert.equal(await tools.createImage(payload), OR_RESULT, summary);
      assert.equal(google.calls.length, 1, `${summary}: Google once`);
      assert.deepEqual(openrouter.calls, [payload], `${summary}: OpenRouter once, the same payload`);
      assert.deepEqual(logged, warning(summary));
      assert.ok(!logged.join('\n').includes(KEY));
    }
    // the timeout (the real one of the module, shortened) and a request too large for Google take the same way
    await scoped(async () => {
      const original = gemini.createImage;
      patch(gemini, 'createImage', (body) => original(body, { timeoutMs: 20 }));
      reset(hang);
      assert.equal(await tools.createImage(payload), OR_RESULT);
      assert.deepEqual(logged, warning('timeout after 0 s'));
    });
    const big = { model: NANO, prompt: 'x', n: 1, input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}` } }] };
    reset(image());
    assert.equal(await tools.createImage(big), OR_RESULT);
    assert.equal(google.calls.length, 0);
    assert.deepEqual(logged, warning('request too large'));

    // no repeat: a block of the filter, a 400, a text instead of an image
    for (const [answer, message] of [
      [json(200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }), /\(IMAGE_SAFETY\)$/],
      [json(200, { candidates: [{ finishReason: 'IMAGE_OTHER' }] }), /\(IMAGE_OTHER\)$/],
      [json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), /\(PROHIBITED_CONTENT\)$/],
      [apiError(400, 'Invalid value.', 'INVALID_ARGUMENT'), /^Google 400: Invalid value\.$/],
      [image({}, [{ text: 'No.' }]), /answered with text/]
    ]) {
      reset(answer);
      const err = await failure(tools.createImage(payload));
      assert.match(err.message, message);
      assert.equal(openrouter.calls.length, 0, `${err.message}: OpenRouter is not asked`);
      assert.deepEqual(logged, []);
    }

    // both fail: the error of OpenRouter says what Google did before; OpenRouter is asked once
    reset(apiError(503, 'Overloaded.', 'UNAVAILABLE'));
    openrouter.answer = async () => {
      throw new or.OpenRouterError('OpenRouter 429: temporarily rate-limited upstream', 429, '{}');
    };
    const both = await failure(tools.createImage(payload));
    assert.ok(both instanceof or.OpenRouterError);
    assert.equal(both.message, 'OpenRouter 429: temporarily rate-limited upstream (Google zuvor: HTTP 503 UNAVAILABLE)');
    assert.equal(openrouter.calls.length, 1);

    // an error that is not one of Google (a bug of ours) is not repeated
    await scoped(async () => {
      patch(gemini, 'createImage', async () => {
        throw new TypeError('a bug of our own');
      });
      reset();
      assert.ok((await failure(tools.createImage(payload))) instanceof TypeError);
      assert.equal(openrouter.calls.length, 0);
    });
  });

  // OpenRouter without a key: the error of Google stays, nothing is repeated, and the Google models still run
  await scoped(async () => {
    installOpenRouter({ hasKey: false });
    setEnv('GEMINI_API_KEY', KEY);
    reset(apiError(429, 'Quota.', 'RESOURCE_EXHAUSTED'));
    assert.equal((await failure(tools.createImage(payload))).message, 'Google 429: Quota.');
    assert.equal(openrouter.calls.length, 0);
    assert.deepEqual(logged, []);
    reset(image());
    assert.equal((await tools.createImage(payload)).data[0].b64_json, PNG_B64);
  });
}

/* ---------- through the tools: asset, cost, journal ---------- */

async function testTools() {
  const sessionId = (await store.createSession({ title: 'Google images' })).id;
  const ctx = (imageModel) => ({ sessionId, config: { imageModel, videoModel: 'bytedance/seedance-2.5' }, emit: () => {}, user: 'tester' });
  const journal = [];
  try {
    const seed = await store.saveAsset(sessionId, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'seed', cost: null });
    await scoped(async () => {
      installOpenRouter();
      patch(costs, 'recordCost', async (entry) => {
        journal.push(entry);
        return entry;
      });
      // without the key the tools hand OpenRouter the payloads of before, byte for byte
      setEnv('GEMINI_API_KEY', undefined);
      reset();
      await tools.executeTool(ctx(NANO), 'generate_image', { prompt: 'A red kite', aspect_ratio: '16:9' });
      await tools.executeTool(ctx(PRO), 'edit_image', { prompt: 'Make it dusk', reference_asset_ids: [seed.id], aspect_ratio: '9:16' });
      assert.deepEqual(openrouter.calls.map((call) => JSON.stringify(call)), [
        `{"model":"${NANO}","prompt":"A red kite","n":1,"aspect_ratio":"16:9"}`,
        `{"model":"${PRO}","prompt":"Make it dusk","n":1,"input_references":[{"type":"image_url","image_url":{"url":"${REF_URL}"}}],"aspect_ratio":"9:16"}`
      ]);
      assert.equal(google.calls.length, 0);

      // with the key Google makes the image: the asset, its cost and the journal come from the answer
      setEnv('GEMINI_API_KEY', KEY);
      reset(image({ usageMetadata: { promptTokenCount: 20, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } }));
      journal.length = 0;
      let outcome = await tools.executeTool(ctx(NANO), 'generate_image', { prompt: 'A red kite', aspect_ratio: '3:2' });
      assert.equal(openrouter.calls.length, 0);
      assert.equal(outcome.asset.cost, 0.03363, '(20 x 1.50 + 1120 x 30) / 1e6');
      assert.deepEqual(await fsp.readFile(path.join(PATHS.assetsDir, sessionId, outcome.asset.file)), PNG);
      assert.deepEqual(journal.map((entry) => [entry.type, entry.model, entry.cost]), [['image', NANO, 0.03363]]);
      // the edit sends the image of the session inline
      reset(image());
      outcome = await tools.executeTool(ctx(PRO), 'edit_image', { prompt: 'Make it dusk', reference_asset_ids: [seed.id] });
      assert.deepEqual(bodyOf(google.calls[0]).contents[0].parts, [{ text: 'Make it dusk' }, { inline_data: { mime_type: 'image/png', data: PNG_B64 } }]);
      assert.equal(outcome.asset.cost, 0.134);
      // a block is the error of the tool: nothing stored, nothing booked, OpenRouter not asked
      const before = (await store.readLedger(sessionId)).length;
      reset(json(200, { candidates: [{ finishReason: 'IMAGE_OTHER' }] }));
      journal.length = 0;
      const err = await failure(tools.executeTool(ctx(NANO), 'generate_image', { prompt: 'a real, named person' }));
      assert.equal(err.message, 'Google: Gemini could not generate an image (IMAGE_OTHER)');
      assert.equal((await store.readLedger(sessionId)).length, before);
      assert.deepEqual(journal, []);
      assert.equal(openrouter.calls.length, 0);
    });

    // only the Google key, OpenRouter as it is without its key: a Google model runs, another one says what is missing
    await scoped(async () => {
      patch(costs, 'recordCost', async (entry) => entry);
      setEnv('OPENROUTER_API_KEY', undefined);
      setEnv('GEMINI_API_KEY', KEY);
      reset(image());
      assert.ok((await tools.executeTool(ctx(NANO), 'generate_image', { prompt: 'x' })).asset.id);
      assert.match((await failure(tools.executeTool(ctx(GPT), 'generate_image', { prompt: 'x' }))).message, /Kein OPENROUTER_API_KEY gesetzt/);
    });
  } finally {
    await store.deleteSession(sessionId).catch(() => {});
  }
}

/* ---------- the image nodes ---------- */

function testNodes() {
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const REASON = 'OPENROUTER_API_KEY is not set';
  // image.relight uses the configured model (GPT Image 2) and keeps asking for OpenRouter
  for (const [openRouterKey, googleKey, expected] of [
    [false, false, [REASON, REASON, REASON]],
    [true, false, [true, true, true]],
    [false, true, [true, true, REASON]],
    [true, true, [true, true, true]]
  ]) {
    patch(or, 'hasKey', () => openRouterKey);
    setEnv('GEMINI_API_KEY', googleKey ? KEY : undefined);
    const available = ['image.generate', 'image.edit', 'image.relight'].map((type) => registry.get(type).available());
    assert.deepEqual(available, expected, `OpenRouter ${openRouterKey}, Google ${googleKey}`);
  }
}

/* ---------- texts, the settings page, the documents ---------- */

function loadTexts(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  return window;
}

// A tiny DOM, just what renderSettings() of public/app.js touches.
class Node {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  set innerHTML(_value) {
    this.children = [];
  }
  find(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) child.find(predicate, found);
    return found;
  }
}

// renderSettings() and the helpers before it, cut out of public/app.js and run in a language; returns the rows.
function renderSettings(lang, keys) {
  const source = read('public', 'app.js');
  const cut = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start > 0 && end > start, `public/app.js has ${from}`);
    return source.slice(start, end);
  };
  const list = new Node('div');
  const context = {
    t: loadTexts(lang).t,
    el: { settingsList: list },
    state: { settings: keys },
    document: { createElement: (tagName) => new Node(tagName) },
    managerAction: (label) => Object.assign(new Node('button'), { textContent: label })
  };
  const code = `${cut('function settingsStatusText(key) {', 'function setSettingsBusy(')}\n${cut('function renderSettings() {', 'function resetAdminDelete()')}\nrenderSettings();`;
  vm.runInNewContext(code, context, { filename: 'public/app.js (settings)' });
  return list.children;
}

function testTexts() {
  const dictionaries = loadTexts('de').I18N;
  for (const lang of ['de', 'en', 'es']) {
    assert.equal(dictionaries[lang]['settings.label.GEMINI_API_KEY'], 'Google AI Studio (Gemini API)', lang);
    assert.match(dictionaries[lang]['settings.help.GEMINI_API_KEY'], /Nano Banana 2\.1 .*Nano Banana Pro .*Google.*OpenRouter.*OpenRouter/, lang);
  }
  assert.match(dictionaries.de['settings.help.GEMINI_API_KEY'], /^Ist der Schlüssel gesetzt, laufen Nano Banana 2\.1 und Nano Banana Pro direkt bei Google auf deinem eigenen Kontingent, sonst über OpenRouter\./);

  // the Google key: its readable name, the technical name next to the status, a masked field, the hint; the other keys as before
  const texts = (row, className) => row.find((node) => node.className.split(' ').includes(className)).map((node) => node.textContent);
  const [openrouterRow, geminiRow] = renderSettings('de', [
    { name: 'OPENROUTER_API_KEY', source: 'env', masked: 'sk…1234' },
    { name: 'GEMINI_API_KEY', source: null, masked: null }
  ]);
  assert.deepEqual(texts(openrouterRow, 'settings-key-name'), ['OPENROUTER_API_KEY']);
  assert.deepEqual(texts(openrouterRow, 'settings-key-status'), ['aus .env (sk…1234)']);
  assert.deepEqual(texts(openrouterRow, 'settings-key-help'), []);
  assert.deepEqual(texts(geminiRow, 'settings-key-name'), ['Google AI Studio (Gemini API)']);
  assert.deepEqual(texts(geminiRow, 'settings-key-status'), ['GEMINI_API_KEY · nicht gesetzt']);
  assert.deepEqual(texts(geminiRow, 'settings-key-help'), [dictionaries.de['settings.help.GEMINI_API_KEY']]);
  assert.equal(geminiRow.find((node) => node.tagName === 'input')[0].type, 'password', 'masked like the other keys');
  const [stored] = renderSettings('es', [{ name: 'GEMINI_API_KEY', source: 'settings', masked: 'test…real' }]);
  assert.deepEqual(texts(stored, 'settings-key-status'), [`GEMINI_API_KEY · ${dictionaries.es['settings.set'].replace('{masked}', 'test…real')}`]);
  assert.match(read('public', 'styles.css'), /\.settings-key-help \{\s*grid-column: 1 \/ -1;/, 'the hint spans the row');
}

function testDocuments() {
  for (const file of ['README.md', 'README.de.md']) assert.match(read(file), /\| `GEMINI_API_KEY` \| Optional \|/, file);
  const help = read('public', 'help.html');
  for (const word of ['Dienste:', 'Services:', 'Servicios:']) {
    assert.match(help.split('\n').find((line) => line.includes(`<strong>${word}</strong>`)) || '', /Google AI Studio/, word);
  }
  assert.match(read('docs', 'node-view', 'SPEC.md'), /v1beta\/models\/<code>:generateContent/);
  assert.match(read('docs', 'node-view', 'IMPLEMENTATION-NOTES.md'), /### Google image models straight at Google/);
  assert.match(read('.env.example'), /^GEMINI_API_KEY=$/m);
  // a key in the shell never reaches a test, which could otherwise call Google for real
  assert.match(read('scripts', 'run-tests.js'), /delete env\.GEMINI_API_KEY/);
}

async function main() {
  installGoogle();
  setEnv('OPENROUTER_API_KEY', undefined);
  setEnv('GEMINI_API_KEY', undefined);
  try {
    testTableAndAccepts();
    await testRequest();
    await testAnswers();
    await testBlocksAndErrors();
    await testTransport();
    await testRouter();
    await testTools();
    await scoped(async () => testNodes());
    testTexts();
    testDocuments();
  } finally {
    restoreAll();
  }
  console.log('Google-Bilder: Anfrage, Antwort, Kosten, Sperren, Fehler, Rueckfallregeln, Weg ohne Schluessel, Nodes und Texte sind korrekt.');
  console.log('test-gemini-images.js: ok');
}

main().catch((err) => {
  restoreAll();
  console.error(err);
  process.exitCode = 1;
});
