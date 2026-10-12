'use strict';

const assert = require('assert/strict');
const song = require('../lib/song-listen');
const voices = require('../lib/voice-detect');
const hud = require('../lib/music-video-hud/plan');
const { fullBrief, FIGURE_TEXT, makeSong, goodAnswer } = require('./support/hud-plan-fixtures');

const SOUND = { genre: 'reggae', subgenre: 'roots', mood: ['warm', 'relaxed'], tempoFeel: 'laid-back', instruments: ['bass', 'guitar'], vocals: 'solo lead', energyArc: 'gentle rise into the chorus', cutsPerMinute: 16, summary: 'Warm reggae with a relaxed pulse.' };
const usage = { promptTokenCount: 2200, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1920 }], candidatesTokenCount: 100, thoughtsTokenCount: 200 };
const response = (value, status = 200) => ({ status, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const answer = (text = JSON.stringify(SOUND)) => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage });

async function main() {
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_SONG_MODEL;
  process.env.GEMINI_API_KEY = 'fake-song-listen-key';
  try {
    const calls = [];
    const booked = [];
    const request = { audio: Buffer.from('test'), seconds: 60, onCost: (cost) => booked.push(cost), fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(answer());
    } };
    const found = await song.listenSong(request);
    assert.deepEqual(found.sound, SOUND);
    assert.equal(found.attempts, 1);
    assert.equal(found.usd, 0.00296);
    assert.equal(booked.length, 1);
    assert.equal(found.usd, voices.costOf(usage, 0, 60).usd);
    assert.equal(song.estimateUsd(60), 0.011095);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.contents[0].parts[0].inline_data.data, request.audio.toString('base64'));
    assert.match(body.contents[0].parts[1].text, /English/);
    assert.ok(!calls[0].url.includes(process.env.GEMINI_API_KEY));
    const echoed = await song.listenSong({ ...request, fetchImpl: async () => response(answer(JSON.stringify({ ...SOUND, summary: process.env.GEMINI_API_KEY }))) });
    assert.ok(!JSON.stringify(echoed).includes(process.env.GEMINI_API_KEY), 'provider text cannot leak the key into the board');
    process.env.GEMINI_SONG_MODEL = 'custom-audio-model';
    assert.equal(song.model(), 'custom-audio-model');
    process.env.GEMINI_SONG_MODEL = '../invalid?key';
    assert.equal(song.model(), voices.DEFAULT_MODEL);
    for (const bad of ['not JSON', JSON.stringify({ ...SOUND, mood: 'happy' }), JSON.stringify({ ...SOUND, genre: '' }), JSON.stringify({ ...SOUND, cutsPerMinute: '20' })]) {
      assert.ok(song.readSound(bad).problem);
    }
    for (const [value, expected] of [[0, 14], [80, 40], [23.8, 24]]) assert.equal(song.readSound(JSON.stringify({ ...SOUND, cutsPerMinute: value })).sound.cutsPerMinute, expected);
    for (const first of [response(answer('not JSON')), response('not JSON'), response('busy', 429), response('busy', 500), response('busy', 501), response('busy', 503)]) {
      let attempts = 0;
      const costs = [];
      const result = await song.listenSong({ ...request, onCost: (cost) => costs.push(cost), fetchImpl: async () => ++attempts === 1 ? first : response(answer()) });
      assert.equal(attempts, 2);
      assert.equal(result.attempts, 2);
      assert.equal(costs.length, first.status === 200 ? 2 : 1);
      assert.equal(result.usd, Math.round(costs.reduce((sum, c) => sum + c.usd, 0) * 1e6) / 1e6);
    }
    for (const status of [400, 401, 403]) {
      let count = 0;
      await assert.rejects(song.listenSong({ ...request, fetchImpl: async () => { count++; return response({ error: { message: process.env.GEMINI_API_KEY } }, status); } }), (err) => !err.message.includes(process.env.GEMINI_API_KEY) && err.status === status);
      assert.equal(count, 1);
    }
    let attempts = 0;
    await assert.rejects(song.listenSong({ ...request, fetchImpl: async () => { attempts++; throw new Error(process.env.GEMINI_API_KEY); } }), (err) => !err.message.includes(process.env.GEMINI_API_KEY));
    assert.equal(attempts, 2);
    await assert.rejects(song.listenSong({ ...request, fetchImpl: async () => response(answer('invalid')) }), (err) => err.usd === 0.00592);
    await assert.rejects(song.listenSong({ ...request, audio: Buffer.alloc(16 * 1024 * 1024), fetchImpl: () => assert.fail('oversized request sent') }), { code: 'VOICES_TOO_LARGE' });
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(song.listenSong({ ...request, fetchImpl: () => assert.fail('no key sent') }), { code: 'VOICES_NO_KEY' });
    process.env.GEMINI_API_KEY = 'fake-song-listen-key';
    const controller = new AbortController();
    let count = 0;
    const pending = song.listenSong({ ...request, signal: controller.signal, fetchImpl: async (_url, { signal }) => {
      count++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    } });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(count, 1);

    const timed = await song.listenSong({ ...request, timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) }).catch((err) => err);
    assert.equal(timed.code, 'VOICES_TIMEOUT');
    const between = new AbortController();
    let betweenCalls = 0;
    await assert.rejects(song.listenSong({ ...request, signal: between.signal,
      onCost: () => between.abort(), fetchImpl: async () => { betweenCalls++; return response(answer('invalid')); }
    }), (err) => err.name === 'AbortError' && err.usd === 0.00296);
    assert.equal(betweenCalls, 1, 'cancellation after an invalid billed answer prevents the retry');

    const made = makeSong();
    const figure = hud.parseFigure(FIGURE_TEXT);
    const brief = fullBrief('Reggae, beach, evening light.');
    async function plan(extra = {}) {
      const requests = [];
      const expected = hud.planGrid(made.analysis, made.timing, { cutsPerMinute: extra.listen === false || extra.cutsFromSong === false || extra.failure ? 24 : 16 });
      let listens = 0;
      const result = await hud.runPlanner({ ...made, figureText: FIGURE_TEXT, brief: 'Reggae, beach, evening light.',
        listenSong: async () => { listens++; if (extra.failure) throw Object.assign(new Error('bad answer'), { summary: 'invalid answer', usd: 0.01 }); return { sound: SOUND, usd: 0.00296 }; },
        ask: async (req) => { requests.push(req); return { text: req.json ? JSON.stringify(goodAnswer(expected, figure)) : brief, usd: 0.1 }; }, ...extra });
      return { result, requests, listens };
    }
    const short = await plan();
    assert.equal(short.listens, 1);
    assert.equal(short.result.brief, brief);
    assert.equal(short.result.grid.settings.cutsPerMinute, 16);
    assert.equal(short.requests.length, 2);
    for (const req of short.requests) { assert.match(req.prompt, /IDEA \(binding;.*Reggae, beach, evening light/); assert.match(req.prompt, /SOUND:.*reggae/); }
    assert.match(short.result.board, /from the song and the binding idea/);
    assert.match(short.result.board, /^SOUND {6}Gemini heard: /m);
    assert.match(short.result.board, /^CUTS {7}16 per minute, from the song$/m);
    assert.equal(short.result.costs[0], 0.00296);
    assert.equal(short.result.cost.parts.listening, 0.00296);
    assert.match(short.result.board, /Gemini heard:/);
    assert.match(short.requests[0].system, /IDEA is binding/);
    const empty = await plan({ brief: '' });
    assert.equal(empty.requests.length, 2);
    assert.equal(empty.result.briefSource, 'song');
    assert.doesNotMatch(empty.requests[0].prompt, /IDEA \(binding/);
    const long = await plan({ brief });
    assert.equal(long.result.brief, brief);
    assert.equal(long.requests.length, 1);
    assert.equal(long.result.briefSource, 'person');
    assert.match(long.requests[0].prompt, /SOUND:/);
    const boundary = Array(80).fill('light').join(' ');
    assert.equal((await plan({ brief: boundary })).requests.length, 1);
    assert.equal((await plan({ brief: Array(79).fill('light').join(' ') })).requests.length, 2);
    const off = await plan({ listen: false });
    assert.equal(off.listens, 0);
    assert.equal(off.result.grid.settings.cutsPerMinute, 24);
    const failed = await plan({ failure: true });
    assert.match(failed.result.board, /Song listening unavailable: invalid answer/);
    assert.equal(failed.result.grid.settings.cutsPerMinute, 24);
    assert.equal(failed.result.costs[0], 0.01);
    assert.equal((await plan({ cutsFromSong: false })).result.grid.settings.cutsPerMinute, 24);
    await assert.rejects(plan({ listenSong: async () => { throw Object.assign(new Error('stop'), { name: 'AbortError' }); } }), { name: 'AbortError' });
    await assert.rejects(plan({ fatal: (err) => err.name === 'BudgetError', listenSong: async () => { throw Object.assign(new Error('exhausted'), { name: 'BudgetError' }); }, ask: () => assert.fail('budget refusal must stop before the model') }), { name: 'BudgetError' });
    console.log('test-song-listen.js: ok');
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.GEMINI_SONG_MODEL; else process.env.GEMINI_SONG_MODEL = oldModel;
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
