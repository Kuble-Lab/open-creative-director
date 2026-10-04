'use strict';

// Trial listening to the voices on the server side (WP38f, lib/voice-preview.js, lib/elevenlabs.js fetchPreview, the routes below
// /api/elevenlabs/voices and the voice options of GET /api/nodes/options/elevenlabs-voices):
//   - fetchPreview: only an https address of a public host, no key sent, no redirect, size and time limit, audio only
//   - the free sample: a voice of the list yields audio, an unknown voice 404, a cloned voice is refused for a restricted account, no
//     address of a client is ever fetched (only the preview_url of the list), the file is kept (one upstream call) and renewed when its
//     address changes or it is too old
//   - a voice without a free sample: NO_PREVIEW; the made sample is paid once (reservation, booking of the cost, the stored file), per
//     voice, model and language; two clicks at once make one; without a key or without budget nothing is made
//   - the options of the list carry description and preview, never the address
// A private copy of the app runs in a temp directory; the upstream is a fake. Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const GUEST = 'guest1@gmail.example';

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeResponse({ status = 200, type = 'audio/mpeg', length, chunks = [Buffer.from('ID3-sample')] } = {}) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => ({ 'content-type': type, 'content-length': length === undefined ? null : String(length) })[String(name).toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
        cancel: async () => {
          index = chunks.length;
        }
      })
    }
  };
}

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return realFetch(input, init);
  };
  const iso = await createIsolatedApp({
    env: { ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com', OPENROUTER_API_KEY: '', GTS_API_TOKEN: '', PUBLIC_BASE_URL: '' }
  });
  await iso.listen();
  try {
    await run(iso);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-voice-preview.js: ok');
}

async function run(iso) {
  const elevenlabs = iso.load('lib/elevenlabs');
  const voicePreview = iso.load('lib/voice-preview');
  const costs = iso.load('lib/costs');
  const budget = iso.load('lib/budget');
  const tools = iso.load('lib/tools');

  /* ---------- fetchPreview ---------- */

  {
    const calls = [];
    const fake = (response) => async (url, init) => {
      calls.push({ url, init });
      return typeof response === 'function' ? response(url, init) : response;
    };
    const sample = await elevenlabs.fetchPreview('https://storage.example.com/voice.mp3', { fetchImpl: fake(fakeResponse({ chunks: [Buffer.from('ID3'), Buffer.from('-data')] })) });
    assert.equal(sample.buffer.toString(), 'ID3-data');
    assert.equal(sample.contentType, 'audio/mpeg');
    assert.equal(calls[0].url, 'https://storage.example.com/voice.mp3');
    assert.equal(calls[0].init.redirect, 'error', 'no redirect is followed');
    assert.ok(!Object.keys(calls[0].init.headers).some((name) => /xi-api-key|authorization/i.test(name)), 'the key is not sent to a public address');
    assert.equal(calls.length, 1);
    for (const bad of ['http://storage.example.com/a.mp3', 'ftp://storage.example.com/a.mp3', 'https://127.0.0.1/a.mp3', 'https://10.0.0.5/a.mp3', 'https://[::1]/a.mp3', 'https://localhost/a.mp3', 'https://intranet/a.mp3', 'https://printer.local/a.mp3', 'https://user:pw@storage.example.com/a.mp3', 'not a url', '', undefined]) {
      const err = await errorOf(elevenlabs.fetchPreview(bad, { fetchImpl: fake(fakeResponse()) }));
      assert.equal(err && err.code, 'PREVIEW_URL_REFUSED', `refused: ${bad}`);
    }
    assert.equal(calls.length, 1, 'a refused address is never fetched');
    assert.equal((await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: fake(fakeResponse({ status: 404 })) }))).code, 'PREVIEW_UPSTREAM');
    assert.equal((await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: fake(fakeResponse({ type: 'text/html' })) }))).code, 'PREVIEW_UPSTREAM', 'no audio');
    assert.equal((await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: fake(fakeResponse({ chunks: [] })) }))).code, 'PREVIEW_UPSTREAM', 'empty');
    assert.equal((await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: fake(fakeResponse({ length: elevenlabs.PREVIEW_MAX_BYTES + 1 })) }))).code, 'PREVIEW_TOO_LARGE', 'declared size');
    let cancelled = false;
    const endless = fakeResponse({ chunks: Array.from({ length: 50 }, () => Buffer.alloc(100 * 1024)) });
    const reader = endless.body.getReader();
    endless.body.getReader = () => ({ read: reader.read, cancel: async () => { cancelled = true; } });
    assert.equal((await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: fake(endless) }))).code, 'PREVIEW_TOO_LARGE', 'streamed size');
    assert.equal(cancelled, true, 'the download is stopped at the limit');
    const slow = await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', {
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }));
    assert.equal(slow.code, 'PREVIEW_UPSTREAM');
    assert.match(slow.message, /in time/, 'the time limit');
    const net = await errorOf(elevenlabs.fetchPreview('https://storage.example.com/a.mp3', { fetchImpl: async () => { throw new Error('connection reset by 10.1.2.3'); } }));
    assert.equal(net.code, 'PREVIEW_UPSTREAM');
    assert.ok(!/10\.1\.2\.3/.test(net.message), 'no detail of the network leaves');
  }

  /* ---------- listVoices keeps the sample address on the server ---------- */

  {
    const key = 'el-secret-key-0123456789';
    iso.setEnv('ELEVENLABS_API_KEY', key);
    patch(global, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ voices: [{ voice_id: 'v1', name: 'Anna', category: 'premade', labels: { accent: 'swiss' }, description: '  A warm   voice ', preview_url: 'https://storage.example.com/v1.mp3' }, { voice_id: 'v2', name: 'Ben' }] })
    }));
    const settings = iso.load('lib/settings');
    patch(elevenlabs, 'hasKey', () => true);
    void settings;
    const voices = await elevenlabs.listVoices();
    assert.deepEqual(voices[0], { voice_id: 'v1', name: 'Anna', category: 'premade', labels: { accent: 'swiss' }, description: 'A warm voice', preview_url: 'https://storage.example.com/v1.mp3' });
    assert.deepEqual(voices[1], { voice_id: 'v2', name: 'Ben' }, 'a voice without them stays as it was');
    restorers.pop()();
    restorers.pop()();
    iso.setEnv('ELEVENLABS_API_KEY', undefined);
  }

  /* ---------- the routes ---------- */

  const upstream = [];
  let voiceList = [
    { voice_id: 'lib1', name: 'Library', category: 'premade', labels: { gender: 'female', accent: 'american' }, description: 'Warm and calm.', preview_url: 'https://storage.example.com/lib1.mp3' },
    { voice_id: 'clone1', name: 'Clone', category: 'cloned', preview_url: 'https://storage.example.com/clone1.mp3' },
    { voice_id: 'clone2', name: 'Silent clone', category: 'cloned' },
    { voice_id: 'lib2', name: 'No sample', category: 'premade' }
  ];
  let key = true;
  patch(elevenlabs, 'hasKey', () => key);
  let listCalls = 0;
  patch(elevenlabs, 'listVoices', async () => {
    listCalls += 1;
    return voiceList;
  });
  patch(elevenlabs, 'fetchPreview', async (url) => {
    upstream.push(url);
    return { buffer: Buffer.from(`SAMPLE:${url}`), contentType: 'audio/mpeg' };
  });
  const ttsCalls = [];
  patch(elevenlabs, 'tts', async (args) => {
    ttsCalls.push(args);
    await sleep(20);
    return Buffer.from(`MADE:${args.voiceId}:${args.modelId}:${args.text.length}`);
  });
  voicePreview.clearCaches();
  const get = (url, as = ADMIN, extra = {}) => iso.request(url, { as, raw: true, ...extra });

  // the free sample
  {
    const first = await get('/api/elevenlabs/voices/lib1/preview');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'audio/mpeg');
    assert.match(first.headers.get('cache-control'), /max-age/);
    assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'SAMPLE:https://storage.example.com/lib1.mp3');
    const second = await get('/api/elevenlabs/voices/lib1/preview');
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    assert.deepEqual(upstream, ['https://storage.example.com/lib1.mp3'], 'the sample was fetched once and kept');
    // another person gets the kept file as well
    await (await get('/api/elevenlabs/voices/lib1/preview', STAFF)).arrayBuffer();
    assert.equal(upstream.length, 1);

    // no address of a client is ever fetched: only the preview_url of the list
    for (const url of [
      '/api/elevenlabs/voices/lib1/preview?url=https://evil.example.com/x.mp3&preview_url=https://evil.example.com/y.mp3',
      '/api/elevenlabs/voices/clone1/preview?url=https://evil.example.com/x.mp3'
    ]) await (await get(url)).arrayBuffer();
    assert.deepEqual(upstream, ['https://storage.example.com/lib1.mp3', 'https://storage.example.com/clone1.mp3'], 'only addresses of the list');
    // a voice id is never an address or a path
    for (const id of ['https%3A%2F%2Fevil.example.com%2Fx.mp3', '..%2F..%2Fetc', 'a%20b', 'x'.repeat(101), 'unknown-voice']) {
      const response = await get(`/api/elevenlabs/voices/${id}/preview`);
      assert.equal(response.status, 404, id);
      await response.arrayBuffer();
    }
    assert.equal(upstream.length, 2, 'unknown voices fetch nothing');

    // restricted accounts: the library only; a cloned voice answers like a voice that does not exist
    for (const as of [GUEST]) {
      assert.equal((await get('/api/elevenlabs/voices/lib1/preview', as)).status, 200);
      const refused = await get('/api/elevenlabs/voices/clone1/preview', as);
      assert.equal(refused.status, 404);
      assert.equal((await refused.json()).error, 'Voice not found');
    }
    assert.equal(upstream.length, 2, 'a refused voice fetches nothing');

    // "default" is the voice a node uses without a choice
    voiceList.push({ voice_id: tools.DEFAULT_ELEVENLABS_VOICE_ID, name: 'Rachel', category: 'premade', preview_url: 'https://storage.example.com/rachel.mp3' });
    const rachel = await get('/api/elevenlabs/voices/default/preview', GUEST);
    assert.equal(rachel.status, 200);
    assert.equal(Buffer.from(await rachel.arrayBuffer()).toString(), 'SAMPLE:https://storage.example.com/rachel.mp3');
    voiceList.pop();

    // a new address renews the kept file; an old one expires
    voicePreview.clearCaches();
    upstream.length = 0;
    const voice = voiceList[0];
    await voicePreview.freePreview('lib1', { active: false }, { now: 1000 });
    await voicePreview.freePreview('lib1', { active: false }, { now: 2000 });
    assert.equal(upstream.length, 1);
    voice.preview_url = 'https://storage.example.com/lib1-new.mp3';
    await voicePreview.freePreview('lib1', { active: false }, { now: 3000 });
    assert.equal(upstream.length, 2, 'another address: fetched again');
    await voicePreview.freePreview('lib1', { active: false }, { now: 3000 + voicePreview.CACHE_TTL_MS + 1 });
    assert.equal(upstream.length, 3, 'too old: fetched again');
    voice.preview_url = 'https://storage.example.com/lib1.mp3';
    voicePreview.clearCaches();
    // two requests at once fetch once
    upstream.length = 0;
    await Promise.all([voicePreview.freePreview('lib1', { active: false }), voicePreview.freePreview('lib1', { active: false })]);
    assert.equal(upstream.length, 1);

    // trouble upstream is a 502 without detail, a missing key a 503
    voicePreview.clearCaches();
    const realFetchPreview = elevenlabs.fetchPreview;
    elevenlabs.fetchPreview = async () => {
      const err = new Error('connection reset by 10.1.2.3');
      err.code = 'PREVIEW_UPSTREAM';
      throw err;
    };
    const broken = await get('/api/elevenlabs/voices/lib1/preview');
    assert.equal(broken.status, 502);
    assert.ok(!/10\.1\.2\.3/.test(JSON.stringify(await broken.json())));
    elevenlabs.fetchPreview = realFetchPreview;
    key = false;
    assert.equal((await get('/api/elevenlabs/voices/lib1/preview')).status, 503);
    key = true;

    // no free sample: 404 with a reason the page understands
    const none = await get('/api/elevenlabs/voices/lib2/preview');
    assert.equal(none.status, 404);
    const noneBody = await none.json();
    assert.equal(noneBody.code, 'NO_PREVIEW');
    assert.equal(noneBody.reason, 'NO_PREVIEW');
  }

  // the options of the list
  {
    const list = await iso.request('/api/nodes/options/elevenlabs-voices', { as: ADMIN });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.options[0], { value: 'lib1', label: 'Library', labels: { gender: 'female', accent: 'american' }, description: 'Warm and calm.', preview: true });
    assert.deepEqual(list.body.options[2], { value: 'clone2', label: 'Silent clone' }, 'no flag where there is no free sample');
    assert.ok(!JSON.stringify(list.body).includes('storage.example.com'), 'the address of a sample never leaves the server');
    const guest = await iso.request('/api/nodes/options/elevenlabs-voices', { as: GUEST });
    assert.deepEqual(guest.body.options.map((option) => option.value), ['lib1', 'lib2'], 'the library only');
  }

  // what a made sample costs
  const sampleOf = (voice, query = '', as = ADMIN) => iso.request(`/api/elevenlabs/voices/${voice}/sample${query}`, { as });
  {
    const info = await sampleOf('clone2', '?model_id=eleven_v4&lang=de');
    assert.equal(info.status, 200, info.text);
    assert.equal(info.body.hasPreview, false);
    assert.equal(info.body.cached, false);
    assert.equal(info.body.available, true);
    assert.equal(info.body.reason, null);
    assert.equal(info.body.model, 'eleven_v4');
    assert.equal(info.body.lang, 'de');
    assert.ok(!('text' in info.body), 'the sentence is the app\'s');
    assert.ok(info.body.chars >= 85 && info.body.chars <= 115, `about 100 characters: ${info.body.chars}`);
    assert.equal(info.body.usd, tools.speechEstimateUsd(voicePreview.SAMPLE_TEXTS.de, 'eleven_v4'));
    assert.ok(info.body.usd > 0.005 && info.body.usd < 0.02, `about a cent: ${info.body.usd}`);
    const turbo = await sampleOf('clone2', '?model_id=eleven_v4_turbo&lang=de');
    assert.equal(turbo.body.usd, info.body.usd / 2, 'a half-price model');
    for (const lang of ['de', 'en', 'es']) {
      const chars = [...voicePreview.SAMPLE_TEXTS[lang]].length;
      assert.ok(chars >= 85 && chars <= 115, `${lang}: ${chars} characters`);
      assert.ok(!voicePreview.SAMPLE_TEXTS[lang].includes('ß'));
    }
    assert.equal((await sampleOf('clone2', '?lang=xx&model_id=bad%20model')).body.lang, 'en', 'an unknown language and model fall back');
    assert.equal((await sampleOf('clone2', '?lang=xx&model_id=bad%20model')).body.model, tools.DEFAULT_ELEVENLABS_MODEL_ID);
    assert.equal((await sampleOf('lib1')).body.hasPreview, true);
    assert.equal((await sampleOf('clone1', '', GUEST)).status, 404, 'a cloned voice is not theirs');
    key = false;
    const noKey = await sampleOf('clone2');
    assert.equal(noKey.status, 503, 'findVoice: no key, no list');
    key = true;
  }

  // making it: paid once
  {
    const before = (await costs.readCosts()).length;
    const post = (voice, json = {}, as = ADMIN) => iso.request(`/api/elevenlabs/voices/${voice}/sample`, { method: 'POST', as, json, raw: true });
    // two clicks at once make one
    const [a, b] = await Promise.all([post('clone2', { model_id: 'eleven_v4', lang: 'de' }), post('clone2', { model_id: 'eleven_v4', lang: 'de' })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const [bodyA, bodyB] = [Buffer.from(await a.arrayBuffer()).toString(), Buffer.from(await b.arrayBuffer()).toString()];
    assert.equal(bodyA, bodyB);
    assert.match(bodyA, /^MADE:clone2:eleven_v4:/);
    assert.equal(ttsCalls.length, 1, 'one call to ElevenLabs');
    assert.equal(ttsCalls[0].text, voicePreview.SAMPLE_TEXTS.de, 'the fixed sentence in the language of the page');
    assert.deepEqual([a.headers.get('x-sample-cached'), b.headers.get('x-sample-cached')].sort(), ['0', '1'], 'only one of them paid');
    const rows = (await costs.readCosts()).slice(before);
    assert.equal(rows.length, 1, 'one booking');
    const expected = tools.speechEstimateUsd(voicePreview.SAMPLE_TEXTS.de, 'eleven_v4');
    assert.deepEqual([rows[0].type, rows[0].model, rows[0].cost, rows[0].billing, rows[0].user, rows[0].sessionId], ['speech', 'elevenlabs/eleven_v4', expected, 'Schaetzung (Zeichen)', ADMIN, voicePreview.COST_SESSION]);
    const paid = [a, b].find((response) => response.headers.get('x-sample-cached') === '0');
    assert.equal(Number(paid.headers.get('x-sample-cost-usd')), expected);
    // the file is stored: a third click costs nothing
    const stored = await fsp.readdir(voicePreview.SAMPLES_DIR);
    assert.equal(stored.filter((name) => name.endsWith('.mp3')).length, 1);
    assert.deepEqual(stored.filter((name) => name.endsWith('.tmp')), []);
    const third = await post('clone2', { model_id: 'eleven_v4', lang: 'de' }, STAFF);
    assert.equal(third.headers.get('x-sample-cached'), '1');
    assert.equal(third.headers.get('x-sample-cost-usd'), '0');
    await third.arrayBuffer();
    assert.equal(ttsCalls.length, 1);
    assert.equal((await costs.readCosts()).length, before + 1);
    const known = await sampleOf('clone2', '?model_id=eleven_v4&lang=de');
    assert.equal(known.body.cached, true, 'the price page says it is made already');
    // another model, another language, another voice: a sample of its own
    await (await post('clone2', { model_id: 'eleven_v4_turbo', lang: 'de' })).arrayBuffer();
    await (await post('clone2', { model_id: 'eleven_v4', lang: 'en' })).arrayBuffer();
    voiceList.push({ voice_id: 'clone3', name: 'Third', category: 'cloned' });
    await (await post('clone3', { model_id: 'eleven_v4', lang: 'de' })).arrayBuffer();
    assert.equal(ttsCalls.length, 4);
    assert.equal((await costs.readCosts()).length, before + 4);
    assert.deepEqual(ttsCalls.map((call) => [call.voiceId, call.modelId, call.text === voicePreview.SAMPLE_TEXTS.en]), [['clone2', 'eleven_v4', false], ['clone2', 'eleven_v4_turbo', false], ['clone2', 'eleven_v4', true], ['clone3', 'eleven_v4', false]]);
    voiceList.pop();

    // a voice with a free sample is not made; unknown and cloned-for-guests voices are refused; nothing was spent on them
    const spent = ttsCalls.length;
    const free = await post('lib1');
    assert.equal(free.status, 409);
    assert.equal((await free.json()).reason, 'PREVIEW_AVAILABLE');
    assert.equal((await post('nope')).status, 404);
    assert.equal((await post('clone2', {}, GUEST)).status, 404);
    // without a key nothing is made
    key = false;
    assert.equal((await post('clone2', { lang: 'es' })).status, 503);
    key = true;
    assert.equal(ttsCalls.length, spent);

    // an empty answer is no sample and costs nothing
    patch(elevenlabs, 'tts', async () => Buffer.alloc(0));
    const rowsBefore = (await costs.readCosts()).length;
    const empty = await post('clone2', { lang: 'es' });
    assert.equal(empty.status, 502);
    await empty.arrayBuffer();
    assert.equal((await costs.readCosts()).length, rowsBefore, 'no booking');
    restorers.pop()();
    // an error of ElevenLabs is a 502 with its message
    patch(elevenlabs, 'tts', async () => {
      throw new elevenlabs.ElevenLabsError('ELEVENLABS_QUOTA_EXCEEDED', 'The credits of the ElevenLabs plan are used up.', 'Aufgebraucht.');
    });
    const quota = await post('clone2', { lang: 'es' });
    assert.equal(quota.status, 502);
    assert.match((await quota.json()).error, /credits/);
    restorers.pop()();
  }

  // the budget of a restricted account: reserved before, settled after; without budget nothing is made
  {
    voiceList.push({ voice_id: 'lib3', name: 'Library without sample', category: 'premade' });
    const grants = [];
    const realBegin = budget.begin;
    patch(budget, 'begin', async (viewer, options) => {
      grants.push({ viewer: viewer.email, options, released: false, settled: null });
      const entry = grants[grants.length - 1];
      return { applies: true, key: 'hold:test', jobKey: 'hold:test', reservedUsd: options.estimateUsd, release: () => { entry.released = true; }, settle: (cost) => { entry.settled = cost; } };
    });
    const made = await iso.request('/api/elevenlabs/voices/lib3/sample', { method: 'POST', as: GUEST, json: { model_id: 'eleven_v4', lang: 'en' }, raw: true });
    assert.equal(made.status, 200);
    await made.arrayBuffer();
    assert.equal(grants.length, 1, 'the budget was asked');
    const expected = tools.speechEstimateUsd(voicePreview.SAMPLE_TEXTS.en, 'eleven_v4');
    assert.deepEqual([grants[0].viewer, grants[0].options.estimateUsd, grants[0].released, grants[0].settled], [GUEST, expected, true, expected], 'reserved, settled with the booking, released');
    assert.equal((await costs.readCosts()).filter((row) => row.user === GUEST).length, 1, 'booked on the person');
    // the stored sample is free for the next one, the budget is not asked again
    await (await iso.request('/api/elevenlabs/voices/lib3/sample', { method: 'POST', as: GUEST, json: { model_id: 'eleven_v4', lang: 'en' }, raw: true })).arrayBuffer();
    assert.equal(grants.length, 1);
    budget.begin = realBegin;
    restorers.pop();
    // the real budget of a guest is empty: 402, nothing made, nothing booked; the page is told before the click
    const spent = ttsCalls.length;
    const rowsBefore = (await costs.readCosts()).length;
    const refused = await iso.request('/api/elevenlabs/voices/lib3/sample', { method: 'POST', as: GUEST, json: { model_id: 'eleven_v4', lang: 'de' } });
    assert.equal(refused.status, 402, refused.text);
    assert.match(refused.body.code, /^BUDGET_/);
    assert.equal(ttsCalls.length, spent);
    assert.equal((await costs.readCosts()).length, rowsBefore);
    const info = await sampleOf('lib3', '?model_id=eleven_v4&lang=de', GUEST);
    assert.equal(info.body.available, false);
    assert.equal(info.body.reason, 'budget');
    const noKeyInfo = await (async () => {
      key = false;
      try {
        return await sampleOf('lib3', '?lang=de', GUEST);
      } finally {
        key = true;
      }
    })();
    assert.equal(noKeyInfo.status, 503);
    // and for the stored sample of the voice in English the price page still says "free"
    const stored = await sampleOf('lib3', '?model_id=eleven_v4&lang=en', GUEST);
    assert.equal(stored.body.cached, true);
    assert.equal(stored.body.available, true);
    voiceList.pop();
  }
  // review: the list of voices is asked for once for many clicks, again after a minute, and a failed request is not kept
  {
    voicePreview.clearCaches();
    listCalls = 0;
    for (let i = 0; i < 5; i += 1) await (await get('/api/elevenlabs/voices/lib1/preview')).arrayBuffer();
    await Promise.all([get('/api/elevenlabs/voices/lib1/preview', STAFF), get('/api/elevenlabs/voices/lib2/sample', GUEST), get('/api/elevenlabs/voices/lib1/preview', GUEST)].map(async (pending) => (await pending).arrayBuffer()));
    assert.equal(listCalls, 1, 'one request to ElevenLabs for all of them');
    // the permission is still checked on each call: a guest does not get a cloned voice from the kept list
    assert.equal((await get('/api/elevenlabs/voices/clone1/preview', GUEST)).status, 404);
    assert.equal(listCalls, 1);
    assert.ok((await voicePreview.findVoice('lib1', { active: false }, { now: Date.now() + voicePreview.VOICES_TTL_MS - 1000 })).voice_id === 'lib1');
    assert.equal(listCalls, 1, 'still kept just before the end');
    await voicePreview.findVoice('lib1', { active: false }, { now: Date.now() + voicePreview.VOICES_TTL_MS + 1000 });
    assert.equal(listCalls, 2, 'asked again after the minute');
    // a failure is not kept
    voicePreview.clearCaches();
    const realList = elevenlabs.listVoices;
    elevenlabs.listVoices = async () => {
      listCalls += 1;
      throw new Error('boom');
    };
    assert.equal((await get('/api/elevenlabs/voices/lib1/preview')).status, 502);
    elevenlabs.listVoices = realList;
    assert.equal((await get('/api/elevenlabs/voices/lib1/preview')).status, 200, 'the next click asks again');
  }

  // review: a sample that is paid for is booked even when the file cannot be stored, and still delivered
  {
    voicePreview.clearCaches();
    voiceList.push({ voice_id: 'clone4', name: 'Fourth', category: 'cloned' });
    const rowsBefore = (await costs.readCosts()).length;
    const ttsBefore = ttsCalls.length;
    const realMkdir = fsp.mkdir;
    fsp.mkdir = async (...args) => {
      if (String(args[0]).includes('voice-samples')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return realMkdir(...args);
    };
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let failedWrite;
    try {
      failedWrite = await iso.request('/api/elevenlabs/voices/clone4/sample', { method: 'POST', as: ADMIN, json: { model_id: 'eleven_v4', lang: 'es' }, raw: true });
    } finally {
      fsp.mkdir = realMkdir;
      console.warn = warn;
    }
    assert.equal(failedWrite.status, 200, 'the sample is delivered');
    assert.match(Buffer.from(await failedWrite.arrayBuffer()).toString(), /^MADE:clone4:/);
    assert.equal(ttsCalls.length, ttsBefore + 1);
    const rows = (await costs.readCosts()).slice(rowsBefore);
    assert.equal(rows.length, 1, 'the call ElevenLabs charged is booked');
    assert.equal(rows[0].type, 'speech');
    assert.ok(warnings.some((line) => /could not be stored/.test(line)), 'the failure is logged');
    assert.equal((await fsp.readdir(voicePreview.SAMPLES_DIR)).some((name) => name.includes('clone4')), false);
    voiceList.pop();
  }
  voicePreview.clearCaches();
  const leftovers = await fsp.readdir(path.join(iso.root, 'data', 'voice-samples'));
  assert.deepEqual(leftovers.filter((name) => !name.endsWith('.mp3')), [], 'only finished samples are left');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
