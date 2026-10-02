'use strict';

// The ElevenLabs module (lib/elevenlabs.js): music and song plan requests, the timeout that grows with the length, and the
// errors with a stable code (subscription, refused prompt with ElevenLabs' suggestion, rate limit, timeout, server, key,
// credits). No network: global fetch is replaced. The key is only ever read from the environment of this process.

const assert = require('assert/strict');

process.env.ELEVENLABS_API_KEY = 'xi-test-key-ABCDEF0123456789';
const KEY = process.env.ELEVENLABS_API_KEY;

const eleven = require('../lib/elevenlabs');
const musicPlan = require('../public/nodes/music-plan');

const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
let calls = [];

function reply(status, body, { json = true } = {}) {
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
      return Buffer.from(json ? text : body).buffer.slice(0);
    }
  };
}

function mockFetch(handler) {
  calls = [];
  global.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), options, body });
    return handler(String(url), options, body);
  };
}

const audioReply = () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('ID3-fake-music') });
const caught = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

async function testComposeWithPrompt() {
  mockFetch(audioReply);
  const buffer = await eleven.composeMusic({ prompt: '  calm piano  ', lengthMs: 45000, instrumental: true, modelId: 'music_v2' });
  assert.equal(buffer.toString(), 'ID3-fake-music');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', 'MP3 like the speech');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['xi-api-key'], KEY);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.options.headers.Accept, 'audio/mpeg');
  assert.deepEqual(call.body, { model_id: 'music_v2', prompt: 'calm piano', music_length_ms: 45000, force_instrumental: true });
  // defaults: the newest model, no instrumental flag unless asked for, the length is optional for the API
  await eleven.composeMusic({ prompt: 'x', lengthMs: 3000 });
  assert.deepEqual(calls[1].body, { model_id: 'music_v2_5', prompt: 'x', music_length_ms: 3000 });
  await eleven.composeMusic({ prompt: 'x', lengthMs: 600000, instrumental: false, modelId: 'music_v1' });
  assert.deepEqual(calls[2].body, { model_id: 'music_v1', prompt: 'x', music_length_ms: 600000 });
  await eleven.composeMusic({ prompt: 'x' });
  assert.deepEqual(calls[3].body, { model_id: 'music_v2_5', prompt: 'x' });
  assert.deepEqual(eleven.MUSIC_MODELS, ['music_v2_5', 'music_v2', 'music_v1']);
  assert.equal(eleven.DEFAULT_MUSIC_MODEL_ID, 'music_v2_5');
}

async function testComposeWithPlan() {
  mockFetch(audioReply);
  const compositionPlan = musicPlan.toApi(musicPlan.parse('+ pop\n[Verse | 20 s]\nla\n[Chorus | 15 s]\nlo').plan, 'music_v2_5');
  await eleven.composeMusic({ compositionPlan, modelId: 'music_v2_5' });
  assert.deepEqual(calls[0].body, { model_id: 'music_v2_5', composition_plan: compositionPlan }, 'no prompt, length or instrumental flag next to a plan');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
  const v1 = musicPlan.toApi(musicPlan.parse('+ pop\n[Verse | 20 s]\nla').plan, 'music_v1');
  await eleven.composeMusic({ compositionPlan: v1, modelId: 'music_v1' });
  assert.deepEqual(calls[1].body, { model_id: 'music_v1', composition_plan: v1 });
}

async function testComposeArguments() {
  mockFetch(audioReply);
  const plan = { chunks: [{ text: '[A]', duration_ms: 5000, positive_styles: ['x'] }] };
  const bad = [
    [{}, /entweder/],
    [{ prompt: '   ' }, /entweder/],
    [{ prompt: 'x', compositionPlan: plan }, /entweder/],
    [{ compositionPlan: plan, lengthMs: 5000 }, /nur für eine Beschreibung/],
    [{ compositionPlan: plan, instrumental: true }, /nur für eine Beschreibung/],
    [{ prompt: 'x', lengthMs: 2999 }, /zwischen 3000 und 600000/],
    [{ prompt: 'x', lengthMs: 600001 }, /zwischen 3000 und 600000/],
    [{ prompt: 'x', lengthMs: 3000.5 }, /zwischen 3000 und 600000/],
    [{ prompt: 'x', lengthMs: '5000' }, /zwischen 3000 und 600000/],
    [{ prompt: 'x', lengthMs: 5000, modelId: 'music_v9' }, /Unbekanntes Musikmodell/]
  ];
  for (const [args, pattern] of bad) {
    const error = await caught(eleven.composeMusic(args));
    assert.match(error.message, pattern, JSON.stringify(args));
    assert.equal(error.code, 'MUSIC_BAD_ARGUMENT');
  }
  assert.equal((await caught(eleven.planMusic({ prompt: '' }))).code, 'MUSIC_BAD_ARGUMENT');
  assert.equal((await caught(eleven.planMusic({ prompt: 'x', lengthMs: 100 }))).code, 'MUSIC_BAD_ARGUMENT');
  assert.equal(calls.length, 0, 'nothing that the API would refuse is sent');
}

async function testPlan() {
  const answer = { chunks: [{ text: '[Verse 1]\nla', duration_ms: 20000, positive_styles: ['pop'], negative_styles: [] }] };
  mockFetch(() => reply(200, answer));
  const result = await eleven.planMusic({ prompt: '  a summer song ', lengthMs: 60000, modelId: 'music_v2_5' });
  assert.deepEqual(result, answer);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/music/plan');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['xi-api-key'], KEY);
  assert.deepEqual(calls[0].body, { prompt: 'a summer song', model_id: 'music_v2_5', music_length_ms: 60000 });
  await eleven.planMusic({ prompt: 'x', modelId: 'music_v1' });
  assert.deepEqual(calls[1].body, { prompt: 'x', model_id: 'music_v1' }, 'the length is optional');
  await eleven.planMusic({ prompt: 'x' });
  assert.equal(calls[2].body.model_id, 'music_v2_5');
}

function testTimeoutLength() {
  assert.equal(eleven.TIMEOUT_MS, 60000, 'speech and plan: as before');
  assert.equal(eleven.musicTimeoutMs(undefined), 90000);
  assert.equal(eleven.musicTimeoutMs(0), 90000);
  assert.equal(eleven.musicTimeoutMs(3000), 93000);
  assert.equal(eleven.musicTimeoutMs(30000), 120000, '90 s plus the length of the song');
  assert.equal(eleven.musicTimeoutMs(150000), 240000);
  assert.equal(eleven.musicTimeoutMs(210000), 300000);
  // fetch of Node ends a request without an answer after 300 s itself: a longer value would never take effect
  assert.equal(eleven.musicTimeoutMs(300000), 300000, 'at most 300 s');
  assert.equal(eleven.musicTimeoutMs(600000), 300000, 'at most 300 s');
  assert.equal(eleven.MUSIC_TIMEOUT_MAX_MS, 300000);
}

// The timeout is real: the timer of the request fires and the request is aborted. The delay is captured and the timer
// is fired at once so the test does not wait.
async function withFastTimers(run) {
  const delays = [];
  global.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) {
      delays.push(ms);
      return originalSetTimeout(fn, 5, ...rest);
    }
    return originalSetTimeout(fn, ms, ...rest);
  };
  // the timer of a request is unref'd (a real request keeps the process alive itself, the mock does not)
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await run(delays);
  } finally {
    clearInterval(keepAlive);
    global.setTimeout = originalSetTimeout;
  }
}

function hangUntilAborted(url, options) {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

async function testTimeouts() {
  mockFetch(hangUntilAborted);
  await withFastTimers(async (delays) => {
    const error = await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 30000 }));
    assert.equal(error.code, 'ELEVENLABS_TIMEOUT');
    assert.equal(delays[0], 120000, 'the wait grows with the length');
    assert.equal(error.data.seconds, 120);
    assert.match(error.message, /did not answer in time \(timeout after 120 s\)/);
    assert.match(error.messageDe, /Timeout nach 120 Sekunden/);
    assert.equal(error instanceof eleven.ElevenLabsError, true);

    delays.length = 0;
    await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 600000 }));
    assert.equal(delays[0], 300000, 'no value above what fetch of Node allows');
    delays.length = 0;
    const planError = await caught(eleven.composeMusic({ compositionPlan: { chunks: [{ text: '[A]', duration_ms: 60000 }, { text: '[B]', duration_ms: 60000 }] } }));
    assert.equal(delays[0], 90000 + 120000, 'a plan: the length of its sections');
    assert.equal(planError.code, 'ELEVENLABS_TIMEOUT');
    delays.length = 0;
    assert.equal((await caught(eleven.planMusic({ prompt: 'x' }))).code, 'ELEVENLABS_TIMEOUT');
    assert.equal(delays[0], 60000);
    delays.length = 0;
    const speech = await caught(eleven.tts({ text: 'x', voiceId: 'v', modelId: 'm' }));
    assert.equal(speech.code, 'ELEVENLABS_TIMEOUT');
    assert.equal(delays[0], 60000);
    assert.equal(speech.data.seconds, 60);
  });
  // a body that stalls while it is read counts as a timeout, too
  global.fetch = async (url, options) => ({
    ok: true,
    status: 200,
    arrayBuffer: () => hangUntilAborted(url, options)
  });
  await withFastTimers(async () => {
    assert.equal((await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 5000 }))).code, 'ELEVENLABS_TIMEOUT');
  });
}

// fetch of Node ends a request by itself (undici: no headers after 300 s, no body in time, no connection): it throws
// TypeError('fetch failed') with the code in `cause`. That is a timeout, with a code and a text, not a plain network error.
async function testFetchOwnTimeouts() {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    global.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code }) });
    };
    const error = await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 600000 }));
    assert.equal(error.code, 'ELEVENLABS_TIMEOUT', code);
    assert.equal(error instanceof eleven.ElevenLabsError, true);
    assert.equal(typeof error.data.seconds, 'number');
    assert.match(error.message, /did not answer in time/);
    assert.match(error.messageDe, /Timeout nach \d+ Sekunden/);
    assert.equal((await caught(eleven.planMusic({ prompt: 'x' }))).code, 'ELEVENLABS_TIMEOUT');
    // the speech: German, as before
    const speech = await caught(eleven.tts({ text: 'x', voiceId: 'v', modelId: 'm' }));
    assert.equal(speech.code, 'ELEVENLABS_TIMEOUT');
    assert.match(speech.message, /^ElevenLabs antwortet nicht \(Timeout nach \d+ Sekunden\)\.$/);
  }
  // another failure of fetch stays a plain network error
  global.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  };
  const refused = await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 5000 }));
  assert.equal(refused.code, undefined);
  assert.match(refused.message, /fetch failed/);
}

// The speech and the voice list (the chat of the Director) keep German messages; the codes are the same as for the music.
async function testSpeechMessagesGerman() {
  const speech = () => eleven.tts({ text: 'x', voiceId: 'v', modelId: 'm' });
  const limited = await failWith(429, 'x', speech);
  assert.equal(limited.code, 'ELEVENLABS_RATE_LIMITED');
  assert.match(limited.message, /^ElevenLabs ist ausgelastet/);
  assert.equal(limited.message, limited.messageDe);
  assert.match((await failWith(500, 'x', speech)).message, /^ElevenLabs meldet einen Fehler auf seiner Seite \(HTTP 500\)/);
  assert.match((await failWith(401, { detail: { status: 'invalid_api_key' } }, speech)).message, /^ElevenLabs akzeptiert den API-Schlüssel nicht/);
  assert.match((await failWith(500, 'x', () => eleven.listVoices())).message, /^ElevenLabs meldet/);
  // the music nodes get English (the interface translates by code)
  assert.match((await failWith(429, 'x')).message, /^ElevenLabs is busy/);
}

// The German sentence of a rejected description or plan is grammatical for both.
async function testRejectedGerman() {
  const prompt = await failWith(400, { detail: { status: 'bad_prompt', message: 'x' } });
  assert.equal(prompt.messageDe, 'ElevenLabs nimmt diese Beschreibung nicht an: Sie nennt Künstler oder verwendet geschützte Texte.');
  const planError = await failWith(400, { detail: { status: 'bad_composition_plan', message: 'x' } });
  assert.equal(planError.messageDe, 'ElevenLabs nimmt diesen Plan nicht an: Er nennt Künstler oder verwendet geschützte Texte.');
}

async function failWith(status, body, call = () => eleven.composeMusic({ prompt: 'x', lengthMs: 5000 })) {
  mockFetch(() => reply(status, body));
  return caught(call());
}

async function testErrors() {
  // a paid plan is needed
  for (const [status, body] of [
    [402, { detail: { status: 'payment_required', message: 'A paid plan is required.' } }],
    [403, { detail: { status: 'only_for_creator', message: 'This feature needs a higher plan.' } }],
    [401, { detail: { status: 'detected_unusual_activity', message: 'Free Tier usage disabled.' } }],
    [400, { detail: { status: 'paid_plan_required', message: 'Upgrade your subscription.' } }]
  ]) {
    const error = await failWith(status, body);
    assert.equal(error.code, 'MUSIC_SUBSCRIPTION_REQUIRED', `${status} ${JSON.stringify(body)}`);
    assert.equal(error.status, status);
    assert.match(error.message, /needs a paid ElevenLabs plan/);
    assert.match(error.messageDe, /bezahltes ElevenLabs-Abo/);
  }
  // the same answers for the speech are no subscription problem
  const speech = await failWith(403, { detail: { status: 'only_for_creator', message: 'This feature needs a higher plan.' } }, () => eleven.tts({ text: 'x', voiceId: 'v', modelId: 'm' }));
  assert.equal(speech.code, undefined);
  assert.match(speech.message, /HTTP 403/);

  // a refused description: ElevenLabs' suggestion comes with it
  const bad = await failWith(400, { detail: { status: 'bad_prompt', message: 'Prompt mentions an artist.', data: { prompt_suggestion: 'A moody synthwave track with a driving bassline' } } });
  assert.equal(bad.code, 'MUSIC_PROMPT_REJECTED');
  assert.equal(bad.data.suggestion, 'A moody synthwave track with a driving bassline');
  assert.match(bad.message, /Suggestion: A moody synthwave track/);
  assert.match(bad.messageDe, /Vorschlag: A moody synthwave track/);
  assert.equal(bad.status, 400);
  // ... or none (harmful content): the code stays, the suggestion is empty
  const harmful = await failWith(400, { detail: { status: 'bad_prompt', message: 'No.' } });
  assert.deepEqual([harmful.code, harmful.data.suggestion], ['MUSIC_PROMPT_REJECTED', '']);
  assert.doesNotMatch(harmful.message, /Suggestion/);

  // a refused plan: the suggested plan (either shape) comes back as readable plan text
  const v2 = await failWith(400, { detail: { status: 'bad_composition_plan', message: 'Styles mention an artist.', data: { composition_plan_suggestion: { chunks: [{ text: '[Intro]\nla', duration_ms: 8000, positive_styles: ['synthwave'], negative_styles: [] }] } } } });
  assert.equal(v2.code, 'MUSIC_PLAN_REJECTED');
  assert.equal(v2.data.suggestion, '[Intro | 8 s]\n+ synthwave\nla');
  assert.deepEqual(musicPlan.parse(v2.data.suggestion).errors, []);
  const v1 = await failWith(400, { detail: { status: 'bad_composition_plan', data: { composition_plan_suggestion: { positive_global_styles: ['rock'], negative_global_styles: [], sections: [{ section_name: 'A', positive_local_styles: [], negative_local_styles: [], duration_ms: 5000, lines: ['x'] }] } } } });
  assert.equal(v1.data.suggestion, '+ rock\n\n[A | 5 s]\nx');
  const noPlan = await failWith(400, { detail: { status: 'bad_composition_plan', message: 'No.' } });
  assert.deepEqual([noPlan.code, noPlan.data.suggestion], ['MUSIC_PLAN_REJECTED', '']);

  // rate limit, server errors, key, credits
  for (const body of [{ detail: { status: 'too_many_concurrent_requests', message: 'Too many.' } }, { detail: 'slow down' }, '']) {
    const error = await failWith(429, body);
    assert.equal(error.code, 'ELEVENLABS_RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.match(error.messageDe, /ausgelastet/);
  }
  for (const status of [500, 502, 503, 504]) {
    const error = await failWith(status, 'upstream broke');
    assert.equal(error.code, 'ELEVENLABS_SERVER_ERROR', String(status));
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.match(error.messageDe, new RegExp(`HTTP ${status}`));
  }
  const key = await failWith(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
  assert.equal(key.code, 'ELEVENLABS_KEY_REJECTED');
  const quota = await failWith(401, { detail: { status: 'quota_exceeded', message: 'You have 0 credits left.' } });
  assert.equal(quota.code, 'ELEVENLABS_QUOTA_EXCEEDED');
  // the speech gets the same codes for what is the same everywhere
  assert.equal((await failWith(429, 'x', () => eleven.tts({ text: 'x', voiceId: 'v', modelId: 'm' }))).code, 'ELEVENLABS_RATE_LIMITED');
  assert.equal((await failWith(500, 'x', () => eleven.listVoices())).code, 'ELEVENLABS_SERVER_ERROR');

  // anything else keeps the old plain message with the status and the text of ElevenLabs
  const validation = await failWith(422, { detail: [{ loc: ['body', 'music_length_ms'], msg: 'too short', type: 'value_error' }] });
  assert.equal(validation.code, undefined);
  assert.equal(validation.status, 422);
  assert.match(validation.message, /^ElevenLabs antwortete mit HTTP 422: /);
  assert.match(validation.message, /too short/);
  const empty = await failWith(404, undefined);
  assert.equal(empty.message, 'ElevenLabs antwortete mit HTTP 404.');
}

async function testKeyNeverShown() {
  const echo = `Request with key ${KEY} refused`;
  const cases = [
    [400, { detail: { status: 'bad_prompt', message: echo, data: { prompt_suggestion: `use ${KEY} instead` } } }],
    [400, { detail: { status: 'bad_composition_plan', message: echo, data: { composition_plan_suggestion: `plan with ${KEY}` } } }],
    [402, { detail: { status: 'payment_required', message: echo } }],
    [429, { detail: { message: echo } }],
    [500, echo],
    [401, { detail: { status: 'invalid_api_key', message: echo } }],
    [422, { detail: [{ msg: echo }] }],
    [404, echo]
  ];
  for (const [status, body] of cases) {
    const error = await failWith(status, body);
    const everything = JSON.stringify([error.message, error.messageDe, error.data, error.stack?.split('\n')[0]]);
    assert.equal(everything.includes(KEY), false, `${status}: the key is in the error: ${everything}`);
  }
  assert.match((await failWith(404, echo)).message, /\[ELEVENLABS-KEY\]/);
  // a network failure that names the key
  global.fetch = async () => {
    throw new TypeError(`fetch failed for https://x/?key=${KEY}`);
  };
  const network = await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 5000 }));
  assert.equal(network.message.includes(KEY), false);
  assert.match(network.message, /fetch failed/);
  // and a successful call leaves nothing in the body either
  mockFetch(audioReply);
  await eleven.composeMusic({ prompt: 'x', lengthMs: 5000 });
  assert.equal(calls[0].options.body.includes(KEY), false, 'the key travels in the header only');
  assert.equal(calls[0].url.includes(KEY), false);
}

async function testNoKey() {
  delete process.env.ELEVENLABS_API_KEY;
  try {
    mockFetch(audioReply);
    assert.equal(eleven.hasKey(), false);
    assert.match((await caught(eleven.composeMusic({ prompt: 'x', lengthMs: 5000 }))).message, /ELEVENLABS_API_KEY/);
    assert.match((await caught(eleven.planMusic({ prompt: 'x' }))).message, /ELEVENLABS_API_KEY/);
    assert.equal(calls.length, 0);
  } finally {
    process.env.ELEVENLABS_API_KEY = KEY;
  }
}

async function testSpeechUnchanged() {
  mockFetch(() => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('mp3') }));
  const buffer = await eleven.tts({ text: 'Hallo', voiceId: 'v 1', modelId: 'eleven_multilingual_v2' });
  assert.equal(buffer.toString(), 'mp3');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/v%201?output_format=mp3_44100_128');
  assert.deepEqual(calls[0].body, { text: 'Hallo', model_id: 'eleven_multilingual_v2' });
  mockFetch(() => reply(200, { voices: [{ voice_id: 'a', name: 'Anna', category: 'premade' }, { voice_id: ' ' }] }));
  assert.deepEqual(await eleven.listVoices(), [{ voice_id: 'a', name: 'Anna', category: 'premade' }]);
}

(async () => {
  try {
    for (const test of [testComposeWithPrompt, testComposeWithPlan, testComposeArguments, testPlan, testTimeoutLength, testTimeouts, testFetchOwnTimeouts, testErrors, testSpeechMessagesGerman, testRejectedGerman, testKeyNeverShown, testNoKey, testSpeechUnchanged]) {
      await test();
      console.log(`ok ${test.name}`);
    }
    console.log('elevenlabs music ok');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
})();
