'use strict';

// The word-time calls of lib/elevenlabs.js (WP34): forcedAlignment() and speechToText(). No network: global fetch is replaced.
// What is covered: the multipart upload (file, text, model, flags; no content type set by hand, the key in the header), the
// answers as plain words, the timeout that grows with the length of the audio, the errors with a stable code, and that the
// API key never appears in a message, however the error came about (error body, thrown network error, validation).

const assert = require('assert/strict');

process.env.ELEVENLABS_API_KEY = 'xi-test-key-ABCDEF0123456789';
const KEY = process.env.ELEVENLABS_API_KEY;

const eleven = require('../lib/elevenlabs');

const originalFetch = global.fetch;
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
    }
  };
}

function mockFetch(handler) {
  calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
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

const AUDIO = Buffer.from('ID3-fake-song-bytes');

// Everything an error carries, as text: the key must not be in any of it.
function everythingOf(err) {
  return JSON.stringify([err.message, err.messageDe, err.code, err.data, err.status, String(err), err.stack]);
}

async function testForcedAlignment() {
  mockFetch(() =>
    reply(200, {
      characters: [{ text: 'H', start: 0.1, end: 0.2 }],
      words: [
        { text: 'Hello', start: 0.1, end: 0.5, loss: 0.9 },
        { text: ' ', start: 0.5, end: 0.55, loss: 0.1 },
        { text: 'world', start: 0.55, end: 1.1, loss: 1.2 },
        { text: 'broken', start: 'x', end: 2 },
        null,
        { start: 1, end: 2 }
      ],
      loss: 1.05
    })
  );
  const answer = await eleven.forcedAlignment({ audio: AUDIO, filename: 'song.mp3', mime: 'audio/mpeg', text: '  Hello world\n  ', durationSec: 12 });
  const call = calls[0];
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/forced-alignment');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['xi-api-key'], KEY);
  assert.equal(call.options.headers.Accept, 'application/json');
  assert.equal(Object.keys(call.options.headers).some((name) => name.toLowerCase() === 'content-type'), false, 'fetch sets the multipart type with its boundary itself');
  // the body is a multipart form with the audio as a file and the text, trimmed
  assert.ok(call.options.body instanceof FormData);
  const file = call.options.body.get('file');
  assert.equal(file.name, 'song.mp3');
  assert.equal(file.type, 'audio/mpeg');
  assert.equal(file.size, AUDIO.length);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), AUDIO.toString());
  assert.equal(call.options.body.get('text'), 'Hello world');
  assert.deepEqual([...call.options.body.keys()].sort(), ['file', 'text']);
  // words as plain data, whitespace entries are kept for the cleaning in lib/lyrics-timing.js, broken entries are dropped
  assert.deepEqual(answer.words, [
    { text: 'Hello', start: 0.1, end: 0.5, loss: 0.9 },
    { text: ' ', start: 0.5, end: 0.55, loss: 0.1 },
    { text: 'world', start: 0.55, end: 1.1, loss: 1.2 }
  ]);
  assert.equal(answer.loss, 1.05);
  // the characters of the answer travel on: they find the real start of the first word
  assert.deepEqual(answer.characters, [{ text: 'H', start: 0.1, end: 0.2 }]);

  // default file name and type, an answer without words
  mockFetch(() => reply(200, { words: 'nothing', loss: 'x' }));
  const empty = await eleven.forcedAlignment({ audio: AUDIO, text: 'a' });
  assert.deepEqual(empty, { words: [], characters: [], loss: null });
  const defaultFile = calls[0].options.body.get('file');
  assert.equal(defaultFile.name, 'audio.mp3');
  assert.equal(defaultFile.type, 'application/octet-stream');
}

async function testSpeechToText() {
  mockFetch(() =>
    reply(200, {
      language_code: 'eng',
      language_probability: 0.99,
      text: 'Hello world',
      audio_duration_secs: 12.5,
      words: [
        { text: 'Hello', start: 0.1, end: 0.5, type: 'word', logprob: -0.1 },
        { text: ' ', start: 0.5, end: 0.55, type: 'spacing', logprob: 0 },
        { text: 'world', start: 0.55, end: 1.1, type: 'word', logprob: -0.2 }
      ]
    })
  );
  const answer = await eleven.speechToText({ audio: AUDIO, filename: 'song.wav', mime: 'audio/wav', durationSec: 12.5 });
  const call = calls[0];
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['xi-api-key'], KEY);
  assert.ok(call.options.body instanceof FormData);
  const form = call.options.body;
  assert.equal(form.get('model_id'), eleven.STT_MODEL_ID);
  assert.equal(eleven.STT_MODEL_ID, 'scribe_v1', 'the model that was tried against a real song');
  assert.equal(form.get('timestamps_granularity'), 'word');
  assert.equal(form.get('tag_audio_events'), 'false', 'a held note must not turn into (music)');
  assert.equal(form.get('diarize'), 'false');
  assert.equal(form.get('language_code'), null, 'the language is recognised by the API unless one is given');
  assert.equal(form.get('file').name, 'song.wav');
  assert.equal(form.get('file').type, 'audio/wav');
  assert.deepEqual([...form.keys()].sort(), ['diarize', 'file', 'model_id', 'tag_audio_events', 'timestamps_granularity']);
  assert.deepEqual(answer.words, [
    { text: 'Hello', start: 0.1, end: 0.5, type: 'word' },
    { text: ' ', start: 0.5, end: 0.55, type: 'spacing' },
    { text: 'world', start: 0.55, end: 1.1, type: 'word' }
  ]);
  assert.equal(answer.text, 'Hello world');
  assert.equal(answer.language, 'eng');
  assert.equal(answer.duration, 12.5, 'the length ElevenLabs measured');

  // a language and another model by hand
  await eleven.speechToText({ audio: AUDIO, languageCode: 'de', modelId: 'scribe_v2' });
  assert.equal(calls[1].options.body.get('language_code'), 'de');
  assert.equal(calls[1].options.body.get('model_id'), 'scribe_v2');
  // the model can be swapped by the environment without a code change
  process.env.ELEVENLABS_STT_MODEL = 'scribe_v9';
  try {
    await eleven.speechToText({ audio: AUDIO });
    assert.equal(calls[2].options.body.get('model_id'), 'scribe_v9');
    await eleven.speechToText({ audio: AUDIO, modelId: 'scribe_v2' });
    assert.equal(calls[3].options.body.get('model_id'), 'scribe_v2', 'an explicit model wins');
  } finally {
    delete process.env.ELEVENLABS_STT_MODEL;
  }
  // an answer without the expected fields
  mockFetch(() => reply(200, {}));
  assert.deepEqual(await eleven.speechToText({ audio: AUDIO }), { words: [], text: '', language: '', duration: null });
}

async function testArguments() {
  mockFetch(() => reply(200, { words: [], loss: 0 }));
  for (const bad of [{ audio: AUDIO }, { audio: AUDIO, text: '   ' }, { audio: Buffer.alloc(0), text: 'a' }, { text: 'a' }, { audio: 'text', text: 'a' }]) {
    const err = await caught(eleven.forcedAlignment(bad));
    assert.equal(err.code, 'TIMING_BAD_ARGUMENT', JSON.stringify(Object.keys(bad)));
  }
  for (const bad of [{}, { audio: Buffer.alloc(0) }, { audio: null }]) {
    const err = await caught(eleven.speechToText(bad));
    assert.equal(err.code, 'TIMING_BAD_ARGUMENT');
  }
  assert.equal(calls.length, 0, 'nothing is sent for a call that cannot work');
}

async function testErrors() {
  const expectations = [
    [429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many' } }, 'ELEVENLABS_RATE_LIMITED'],
    [401, { detail: { status: 'invalid_api_key', message: `Invalid API key ${KEY}` } }, 'ELEVENLABS_KEY_REJECTED'],
    [401, { detail: { status: 'quota_exceeded', message: 'You have 0 credits left' } }, 'ELEVENLABS_QUOTA_EXCEEDED'],
    [500, 'internal error', 'ELEVENLABS_SERVER_ERROR'],
    [503, { detail: 'unavailable' }, 'ELEVENLABS_SERVER_ERROR']
  ];
  for (const [status, body, code] of expectations) {
    for (const call of [() => eleven.forcedAlignment({ audio: AUDIO, text: 'a' }), () => eleven.speechToText({ audio: AUDIO })]) {
      mockFetch(() => reply(status, body));
      const err = await caught(call());
      assert.equal(err.code, code, `${status} -> ${code}`);
      assert.ok(err instanceof eleven.ElevenLabsError);
      // English for the log, German for the fallback; the interface translates by the code
      assert.match(err.message, /[A-Za-z]/);
      assert.ok(err.messageDe);
      assert.doesNotMatch(err.message, /Schlüssel|Credits des|Warte/, 'the message is English');
      assert.equal(everythingOf(err).includes(KEY), false, `the key is not in the error (${status})`);
    }
  }
  // another refusal (a text that cannot be aligned): the message of the API, the key scrubbed from it
  mockFetch(() => reply(422, { detail: [{ loc: ['body', 'text'], msg: `bad text for key ${KEY}`, type: 'value_error' }] }));
  const refused = await caught(eleven.forcedAlignment({ audio: AUDIO, text: 'a' }));
  assert.equal(refused.status, 422);
  assert.match(refused.message, /422/);
  assert.equal(everythingOf(refused).includes(KEY), false);
  assert.match(refused.message, /\[ELEVENLABS-KEY\]/, 'the key is replaced, the rest of the message stays');
  // a network error that carries the key (an address with it in a proxy message)
  mockFetch(() => {
    throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
  });
  const network = await caught(eleven.speechToText({ audio: AUDIO }));
  assert.equal(everythingOf(network).includes(KEY), false);
  assert.match(network.message, /ECONNREFUSED/);
  // a timeout of fetch itself
  mockFetch(() => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    throw err;
  });
  const slow = await caught(eleven.forcedAlignment({ audio: AUDIO, text: 'a' }));
  assert.equal(slow.code, 'ELEVENLABS_TIMEOUT');
  assert.equal(everythingOf(slow).includes(KEY), false);
}

async function testTimeout() {
  assert.equal(eleven.timingTimeoutMs(0), 60000);
  assert.equal(eleven.timingTimeoutMs(undefined), 60000);
  assert.equal(eleven.timingTimeoutMs(-5), 60000);
  assert.equal(eleven.timingTimeoutMs(NaN), 60000);
  assert.equal(eleven.timingTimeoutMs(120), 180000, 'a minute of margin plus one second per second of audio');
  assert.equal(eleven.timingTimeoutMs(600), eleven.MUSIC_TIMEOUT_MAX_MS, 'never longer than fetch itself waits (300 s)');
  assert.equal(eleven.timingTimeoutMs(3600), 300000);
  // the timer of a call really is that value: a call that never answers ends with ELEVENLABS_TIMEOUT
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  // the timer of a call is unref'd (it must not keep the process alive), so something else keeps this test running
  const keepAlive = setInterval(() => {}, 1000);
  global.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return originalSetTimeout(fn, ms === 180000 ? 5 : ms, ...rest);
  };
  try {
    mockFetch((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const err = await caught(eleven.forcedAlignment({ audio: AUDIO, text: 'a', durationSec: 120 }));
    assert.equal(err.code, 'ELEVENLABS_TIMEOUT');
    assert.ok(delays.includes(180000), 'the wait grew with the length (120 s of audio)');
    assert.equal(err.data.seconds, 180);
    assert.equal(everythingOf(err).includes(KEY), false);
  } finally {
    global.setTimeout = originalSetTimeout;
    clearInterval(keepAlive);
  }
}

async function testNoKey() {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    mockFetch(() => reply(200, { words: [] }));
    const err = await caught(eleven.speechToText({ audio: AUDIO }));
    assert.match(err.message, /ELEVENLABS_API_KEY/);
    assert.equal(calls.length, 0, 'nothing is sent without a key');
  } finally {
    process.env.ELEVENLABS_API_KEY = saved;
  }
}

(async () => {
  try {
    await testForcedAlignment();
    await testSpeechToText();
    await testArguments();
    await testErrors();
    await testTimeout();
    await testNoKey();
  } finally {
    global.fetch = originalFetch;
  }
  console.log('test-elevenlabs-timing.js: ok');
})().catch((err) => {
  global.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
