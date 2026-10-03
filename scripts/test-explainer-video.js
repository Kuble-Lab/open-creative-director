'use strict';

// The voice and the scene of an explainer video (WP37b): the nodes "Explainer voice" (explainer.voice) and "Draw explainer scene"
// (explainer.scene), with ElevenLabs (with-timestamps), the language model and the render node replaced; ffmpeg is the real one.
//   voice: word times from the character times, the text around the scene goes along and a refusal of it is answered by one more call
//     without it, a scene without narration makes no call and costs nothing, no times from the API = estimated words, the price by
//     the characters (estimate per scene and booking)
//   scene: the model is asked in the right words (contract, cue list, attached pictures), the code is checked before it is rendered, the
//     render gets the policy and the exact length, a failed attempt is answered in the same conversation (code problem, render error,
//     blockers of the look at two frames), after the last try the fixed scene stands in (or the node stops), the look can be switched
//     off, stills and figures are found by the number of the scene, a clip scene is a plain stand-in, the fonts of the brand are embedded,
//     the video is silent and exactly as long as the voice plus 0.4 s (frame exact), the price and its booking, the errors
// A private copy of the app runs in a temp directory; nothing is paid, nothing leaves the machine (fetch guard). The parts with
// ffmpeg are skipped when it is missing.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { toneWav, createMedia } = require('./support/explainer-media');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const P1 = 'p1@gmail.example';
const KEY = 'el-secret-key-0123456789';
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

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

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  const eleven = { calls: [], refuseContext: false, noAlignment: false, secondsPerChar: 0.06, fail: null, silent: false };
  let makeVoiceBytes = () => Buffer.alloc(0);
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/with-timestamps/.test(url)) {
      const body = JSON.parse(init.body);
      eleven.calls.push({ url, body, key: init.headers['xi-api-key'] });
      if (eleven.fail) return respond(eleven.fail.status, eleven.fail.body);
      if (eleven.refuseContext && ('previous_text' in body || 'next_text' in body)) {
        return respond(422, { detail: { status: 'invalid_request', message: 'The fields previous_text and next_text are not supported for this model' } });
      }
      const characters = [...body.text];
      const duration = characters.length * eleven.secondsPerChar + 0.1;
      const alignment = {
        characters,
        character_start_times_seconds: characters.map((_c, index) => Math.round(index * eleven.secondsPerChar * 1000) / 1000),
        character_end_times_seconds: characters.map((_c, index) => Math.round((index + 1) * eleven.secondsPerChar * 1000) / 1000)
      };
      return respond(200, {
        audio_base64: makeVoiceBytes(duration).toString('base64'),
        alignment: eleven.noAlignment ? null : alignment,
        normalized_alignment: eleven.noAlignment ? null : { ...alignment, characters: alignment.characters.map((char) => char.toUpperCase()) }
      });
    }
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return realFetch(input, init);
  };
  function respond(status, body) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: new Map(), async text() { return text; }, async json() { return JSON.parse(text); } };
  }
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: KEY,
      PUBLIC_BASE_URL: '',
      GTS_API_TOKEN: ''
    }
  });
  try {
    await run(iso, { eleven, setVoiceBytes: (fn) => { makeVoiceBytes = fn; } });
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-video.js: ok');
}

async function run(iso, { eleven, setVoiceBytes }) {
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const tools = iso.load('lib/tools');
  const costs = iso.load('lib/costs');
  const rendernode = iso.load('lib/rendernode');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const brandings = iso.load('lib/brandings');
  const registryModule = iso.load('lib/nodes/registry');
  const planLib = iso.load('lib/explainer-plan');
  const cuesLib = iso.load('lib/explainer-cues');
  const sceneLib = iso.load('lib/explainer-scene');
  const videoNodes = iso.load('lib/nodes/nodes-explainer-video');
  const { textValue, listValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;

  const journal = [];
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });

  const bins = ffmpegLib.binaries();
  const haveFfmpeg = bins.available;
  const workDir = await fsp.mkdtemp(path.join(iso.root, 'explainer-video-'));
  const media = haveFfmpeg ? createMedia({ ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, dir: workDir }) : null;
  setVoiceBytes((seconds) => toneWav(seconds, 600));

  const session = await store.createSession();
  const sessionId = session.id;
  const sessionDir = store.sessionAssetDir(sessionId);
  const scratchLeft = async () => (await fsp.readdir(sessionDir)).filter((name) => name.startsWith('.nodes-'));

  /* ---------- the render node and the model, replaced ---------- */

  const renders = []; // what the render node got
  const renderPlan = []; // what it should do next: undefined = succeed, { fail: text } = the job fails, { gone: true } = the node is lost, { audio: true } = with sound
  patch(rendernode, 'enabled', () => true);
  patch(rendernode, 'listConfiguredNodes', () => [{ id: 'rn1', name: 'Render 1', enabled: true }]);
  patch(rendernode, 'submit', async (html, quality, files, format) => {
    renders.push({ html, quality, files, format, jobId: `job-${renders.length + 1}` });
    return { jobId: `job-${renders.length}`, nodeId: 'rn1' };
  });

  const calls = [];
  const queue = { writer: [], check: [] };
  const USD = { writer: 0.06, check: 0.03 };
  const realComplete = llm.completeText;
  const durationOf = (text) => Number(/data-duration="([\d.]+)"/.exec(text)[1]);
  const sizeOf = (text) => ({ width: Number(/data-width="(\d+)"/.exec(text)[1]), height: Number(/data-height="(\d+)"/.exec(text)[1]) });
  // a scene as a model should write it: the root element as the system prompt demands it, every attached picture used
  const goodHtml = (options) => {
    const duration = durationOf(options.system);
    const { width, height } = sizeOf(options.system);
    const attached = [...String(options.prompt).matchAll(/\{\{asset:(\d+)\}\} = image/g)].map((match) => `<img src="{{asset:${match[1]}}}" style="width:100px">`).join('');
    return `<!doctype html>
<html><head><meta charset="utf-8"><script src="${GSAP}"></script><style>body,html{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head>
<body><div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><h1 id="t">Titel</h1>${attached}
<script>const tl = gsap.timeline({paused:true}); tl.from('#t',{opacity:0,duration:0.5},0.3); tl.to({}, {duration:0.01}, ${duration - 0.01}); window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl;</script></div></body></html>`;
  };
  const fakeComplete = async (options) => {
    const kind = /^You write ONE scene/.test(options.system || '') ? 'writer' : /^You check frames/.test(options.system || '') ? 'check' : 'other';
    calls.push({ kind, options: JSON.parse(JSON.stringify({ ...options, onReplaced: undefined })) });
    const next = queue[kind] && queue[kind].length ? queue[kind].shift() : null;
    let value = next === null ? (kind === 'writer' ? goodHtml(options) : '{"ok": true, "blockers": [], "minor": []}') : next;
    if (typeof value === 'function') value = value(options);
    if (value instanceof Error) throw value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), usd: USD[kind] ?? 0, citations: [], citationSpans: [] };
  };
  llm.completeText = fakeComplete;
  restorers.push(() => {
    llm.completeText = realComplete;
  });
  const writerCalls = () => calls.filter((call) => call.kind === 'writer');
  const checkCalls = () => calls.filter((call) => call.kind === 'check');
  const reset = () => {
    calls.length = 0;
    renders.length = 0;
    renderPlan.length = 0;
    queue.writer.length = 0;
    queue.check.length = 0;
    eleven.calls.length = 0;
    eleven.refuseContext = false;
    eleven.noAlignment = false;
    eleven.fail = null;
    journal.length = 0;
  };

  let videoCounter = 0;
  // the render node's result: a video of the length and size the HTML says, with a colour per job
  async function renderedVideo(entry, step) {
    // the render node rounds the length up to whole frames
    const duration = durationOf(entry.html);
    const { width, height } = sizeOf(entry.html);
    videoCounter += 1;
    const file = path.join(sessionDir, `fake-render-${videoCounter}.mp4`);
    const args = ['-f', 'lavfi', '-i', `color=c=0x336699:s=${Math.round(width / 10)}x${Math.round(height / 10)}:r=30`];
    if (step && step.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
    args.push('-frames:v', String(Math.ceil(duration * 30 - 1e-9)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
    if (step && step.audio) args.push('-c:a', 'aac', '-shortest');
    args.push(file);
    await media.ff(args);
    return { file, duration };
  }

  function makeCtx({ user = STAFF, config = {}, itemIndex = 0 } = {}) {
    const controller = new AbortController();
    const logs = [];
    const full = { defaultBrain: 'vendor/default-brain', brainModels: ['anthropic/claude-opus-5.5', 'vendor/default-brain'], ...config };
    const waits = [];
    const emitted = [];
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      itemIndex,
      user,
      config: full,
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId, config: full, user, emit: (event) => emitted.push(event), signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn(),
      waitForJob: async (job, options) => {
        waits.push(options);
        const entry = renders.find((item) => item.jobId === job.jobId);
        assert.ok(entry, `a render was submitted for job ${job.jobId}`);
        const step = renderPlan.shift();
        if (step && step.fail) throw new Error(step.fail);
        if (step && step.gone) throw new Error(`Timed out waiting for job ${job.jobId}`);
        const made = await renderedVideo(entry, step);
        await store.completeAssetFile(sessionId, job.assetId, made.file, { cost: 0, duration: made.duration, ext: '.mp4', kind: 'video' });
        return [job.assetId];
      },
      logs,
      waits,
      emitted
    };
  }
  const exec = (type, ctx, inputs, raw = {}) => {
    const def = real.get(type);
    return def.execute(ctx, inputs, real.normalizeParams(def, raw));
  };
  const assetOf = async (bytes, ext, name = 'seed') => {
    const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: bytes, ext, prompt: name });
    return assets.valueFromAsset(sessionId, saved.id);
  };
  const fileOf = (value) => assets.assetFilePath(value);

  /* ---------- definitions ---------- */

  const voiceDef = real.get('explainer.voice');
  assert.equal(voiceDef.category, 'audio');
  assert.equal(voiceDef.paid, true);
  assert.equal(registryModule.providerOf(voiceDef), 'elevenlabs');
  assert.equal(voiceDef.cost.unit, 'usd');
  assert.equal(voiceDef.cost.history, false, 'the price is not guessed from an earlier run');
  const portsOf = (list) => list.map((port) => [port.id, port.type, Boolean(port.required), Boolean(port.multiple)]);
  assert.deepEqual(portsOf(voiceDef.inputs), [['narration', 'text', true, false], ['context', 'text', false, false]]);
  assert.deepEqual(portsOf(voiceDef.outputs), [['audio', 'audio', false, false], ['timing', 'text', false, false], ['duration', 'number', false, false]]);
  const voiceDefaults = real.normalizeParams(voiceDef, {});
  assert.deepEqual(voiceDefaults, { voice_id: tools.DEFAULT_ELEVENLABS_VOICE_ID, model_id: 'eleven_v4', use_context: true });
  assert.equal(voiceDef.params.find((param) => param.id === 'voice_id').optionsSource, 'elevenlabs-voices');
  assert.equal(voiceDef.params.find((param) => param.id === 'model_id').optionsSource, 'elevenlabs-tts-models');
  assert.equal(real.availability(voiceDef), haveFfmpeg ? true : real.availability(voiceDef));

  const sceneDef = real.get('explainer.scene');
  assert.equal(sceneDef.category, 'video');
  assert.equal(sceneDef.paid, true);
  assert.equal(registryModule.providerOf(sceneDef), 'llm');
  assert.equal(sceneDef.cost.history, false);
  assert.ok(sceneDef.timeoutMs >= 30 * 60 * 1000, 'a scene with retries may take its time');
  assert.deepEqual(portsOf(sceneDef.inputs), [
    ['brief', 'text', true, false], ['timing', 'text', true, false], ['brand', 'text', false, false], ['logo', 'image', false, false],
    ['stills', 'image', false, true], ['pages', 'image', false, true], ['shots', 'text', false, false], ['pages_info', 'text', false, false]
  ]);
  assert.deepEqual(portsOf(sceneDef.outputs), [['video', 'video', false, false]]);
  assert.deepEqual(real.normalizeParams(sceneDef, {}), { model: '', format: 'landscape', quality: 'standard', vision_check: true, max_retries: 2, fallback: true });
  assert.deepEqual(sceneDef.params.find((param) => param.id === 'format').options, ['landscape', 'portrait']);
  assert.deepEqual(sceneDef.params.find((param) => param.id === 'quality').options, ['draft', 'standard', 'high']);
  assert.equal(real.normalizeParams(sceneDef, { max_retries: 99 }).max_retries, 4);
  assert.equal(real.normalizeParams(sceneDef, { max_retries: -3 }).max_retries, 0);
  assert.equal(sceneDef.params.find((param) => param.id === 'model').optionsSource, 'brain-models');
  assert.equal(real.availability(sceneDef), haveFfmpeg ? true : real.availability(sceneDef), 'the render node is there (replaced)');
  {
    const original = rendernode.enabled;
    rendernode.enabled = () => false;
    assert.match(String(real.availability(sceneDef)), /No render node configured/);
    rendernode.enabled = original;
  }

  /* ---------- the price ---------- */

  {
    const estimate = (params, context = {}) => sceneDef.cost.estimate(real.normalizeParams(sceneDef, params), { config: {}, ...context });
    assert.deepEqual(estimate({}), { usd: 0.1 }, 'a scene costs 0.10 USD (Opus 5.5)');
    assert.deepEqual(estimate({ vision_check: false }), { usd: 0.07 }, 'without the look: writing and render only');
    assert.deepEqual(estimate({ model: 'anthropic/claude-sonnet-5.5' }), { usd: 0.05 }, 'Sonnet costs half');
    assert.equal(estimate({ model: 'vendor/unknown-model' }), null, 'the price of an unknown model is not known');
    assert.equal(estimate({}, { config: { restrictedBrainModels: ['vendor/default-brain'] } }), null, 'the model of a restricted account is not known');
    assert.deepEqual(estimate({}, { config: { restrictedBrainModels: ['anthropic/claude-opus-5.5'] } }), { usd: 0.1 });

    // the voice: all characters of all scenes, per scene (the engine multiplies the estimate by the number of scenes)
    const texts = ['Eins zwei drei.', 'Ein deutlich längerer Satz mit mehr Zeichen darin.', ''];
    const total = texts.reduce((sum, text) => sum + (tools.speechEstimateUsd(text, 'eleven_v4') || 0), 0);
    assert.ok(total > 0);
    const voiceEstimate = (params, context) => voiceDef.cost.estimate(real.normalizeParams(voiceDef, params), context);
    const listed = voiceEstimate({}, { connected: new Set(['narration']), inputs: { narration: listValue('text', texts.map((text) => textValue(text))) } });
    near(listed.usd * 3, total, 1e-9, 'the total over all scenes divided by their number');
    assert.equal(voiceEstimate({}, { connected: new Set(['narration']), inputs: {} }), null, 'not known before the plan has run');
    near(voiceEstimate({ model_id: 'eleven_flash_v2_5' }, { connected: new Set(['narration']), inputs: { narration: textValue(texts[0]) } }).usd, tools.speechEstimateUsd(texts[0], 'eleven_flash_v2_5'), 1e-9, 'the price of the model');
    assert.deepEqual(voiceEstimate({}, { connected: new Set(['narration']), inputs: { narration: listValue('text', []) } }), { usd: 0 });
  }

  /* ---------- the voice ---------- */

  {
    reset();
    const text = 'Seit 2020 ist der Lindensee gesunken.';
    const around = { previous_text: 'Der Anfang.', next_text: 'Das Ende.' };
    const ctx = makeCtx();
    const result = await exec('explainer.voice', ctx, { narration: textValue(text), context: textValue(JSON.stringify(around)) }, {});
    assert.equal(eleven.calls.length, 1);
    const call = eleven.calls[0];
    assert.match(call.url, /\/v1\/text-to-speech\/[^/]+\/with-timestamps\?output_format=mp3_44100_128$/, 'the endpoint with the times');
    assert.equal(call.key, KEY);
    assert.deepEqual(call.body, { text, model_id: 'eleven_v4', previous_text: 'Der Anfang.', next_text: 'Das Ende.' }, 'the text around goes along');
    const variant = result.variants[0];
    assert.equal(variant.audio.type, 'audio');
    // the word times come from the times of the characters of the text as it was spoken
    const timing = JSON.parse(variant.timing.value);
    assert.equal(timing.version, 1);
    assert.deepEqual(timing.words.map((word) => word.text), ['Seit', '2020', 'ist', 'der', 'Lindensee', 'gesunken.']);
    near(timing.words[0].start, 0, 0.001);
    near(timing.words[0].end, 4 * 0.06, 0.001);
    near(timing.words[4].start, [...'Seit 2020 ist der '].length * 0.06, 0.001, 'the first character of the word');
    near(timing.words[5].end, [...text].length * 0.06, 0.001, 'the last character of the word');
    assert.equal(timing.lines.length, 1);
    assert.ok(timing.words.every((word) => word.line === 0));
    // the length is the one of the audio (measured), the number output says the same
    if (haveFfmpeg) {
      const measured = (await media.probe(fileOf(variant.audio))).duration;
      near(timing.duration, measured, 0.005);
      near(variant.duration.value, measured, 0.005);
      assert.equal(variant.duration.type, 'number');
      near(timing.duration, [...text].length * 0.06 + 0.1, 0.01);
    }
    // the price: characters x list price, booked as a speech
    const price = tools.speechEstimateUsd(text, 'eleven_v4');
    assert.ok(price > 0);
    near(result.cost.usd, price, 1e-9);
    const booked = journal.filter((entry) => entry.type === 'speech');
    assert.equal(booked.length, 1);
    near(booked[0].cost, price, 1e-9);
    assert.equal(booked[0].model, 'elevenlabs/eleven_v4');
    assert.ok(ctx.logs.some((line) => /Voice: 6 words, [\d.]+ s \(with the text around it\)/.test(line)), ctx.logs.join(' | '));
    assert.ok(!ctx.logs.some((line) => /does not take/.test(line)));

    // the switch: without the text around it (nothing is sent)
    reset();
    await exec('explainer.voice', makeCtx(), { narration: textValue(text), context: textValue(JSON.stringify(around)) }, { use_context: false });
    assert.deepEqual(eleven.calls[0].body, { text, model_id: 'eleven_v4' });
    // no context connected, or one that is not JSON: no fields
    reset();
    await exec('explainer.voice', makeCtx(), { narration: textValue(text) }, {});
    await exec('explainer.voice', makeCtx(), { narration: textValue(text), context: textValue('not json') }, {});
    assert.deepEqual(eleven.calls.map((entry) => entry.body), [{ text, model_id: 'eleven_v4' }, { text, model_id: 'eleven_v4' }]);
    // an empty side is left out
    reset();
    await exec('explainer.voice', makeCtx(), { narration: textValue(text), context: textValue(JSON.stringify({ previous_text: '', next_text: 'Danach.' })) }, {});
    assert.deepEqual(eleven.calls[0].body, { text, model_id: 'eleven_v4', next_text: 'Danach.' });
    // a voice and a model of the node are used
    reset();
    await exec('explainer.voice', makeCtx(), { narration: textValue(text) }, { voice_id: 'voice-abc', model_id: 'eleven_flash_v2_5' });
    assert.match(eleven.calls[0].url, /text-to-speech\/voice-abc\/with-timestamps/);
    assert.equal(eleven.calls[0].body.model_id, 'eleven_flash_v2_5');
  }

  // the API refuses the text around the scene: once more without it, and the log says so
  {
    reset();
    eleven.refuseContext = true;
    const ctx = makeCtx();
    const result = await exec('explainer.voice', ctx, { narration: textValue('Ein Satz.'), context: textValue(JSON.stringify({ previous_text: 'Davor.', next_text: 'Danach.' })) }, {});
    assert.equal(eleven.calls.length, 2, 'one call with the context, one without');
    assert.ok('previous_text' in eleven.calls[0].body);
    assert.deepEqual(eleven.calls[1].body, { text: 'Ein Satz.', model_id: 'eleven_v4' });
    assert.ok(ctx.logs.some((line) => /does not take the text around the scene for this model: spoken again without it/.test(line)), ctx.logs.join(' | '));
    assert.equal(journal.filter((entry) => entry.type === 'speech').length, 1, 'the call that was refused costs nothing and is not booked');
    near(result.cost.usd, tools.speechEstimateUsd('Ein Satz.', 'eleven_v4'), 1e-9, 'paid once');
    assert.equal(JSON.parse(result.variants[0].timing.value).words.length, 2);
    // an error that is not about the context is not answered with a second call
    reset();
    eleven.fail = { status: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } };
    const failed = await errorOf(exec('explainer.voice', makeCtx(), { narration: textValue('Ein Satz.'), context: textValue(JSON.stringify({ previous_text: 'Davor.' })) }, {}));
    assert.ok(failed);
    assert.equal(eleven.calls.length, 1);
    assert.ok(!String(failed.message).includes(KEY), 'the key never appears in a message');
    assert.equal(journal.filter((entry) => entry.type === 'speech').length, 0, 'nothing is booked for a failed call');
    eleven.fail = { status: 422, body: { detail: { message: 'The text is too short' } } };
    reset();
    eleven.fail = { status: 422, body: { detail: { message: 'The text is too short' } } };
    const other = await errorOf(exec('explainer.voice', makeCtx(), { narration: textValue('Ein Satz.'), context: textValue(JSON.stringify({ previous_text: 'Davor.' })) }, {}));
    assert.ok(other);
    assert.equal(eleven.calls.length, 1, 'a 422 that does not name the context is not tried again');
  }

  // no narration (the sources card): no call, four seconds of silence, no words, no cost
  if (haveFfmpeg) {
    reset();
    const ctx = makeCtx();
    const result = await exec('explainer.voice', ctx, { narration: textValue('   ') }, {});
    assert.equal(eleven.calls.length, 0, 'no call to ElevenLabs');
    const variant = result.variants[0];
    assert.equal(variant.duration.value, 4);
    const timing = JSON.parse(variant.timing.value);
    assert.deepEqual([timing.words, timing.lines, timing.duration, timing.source], [[], [], 4, 'silence']);
    const probe = await media.probe(fileOf(variant.audio));
    near(probe.audioDuration || probe.duration, 4, 0.05);
    assert.equal(result.cost.usd, 0);
    assert.equal(journal.filter((entry) => entry.type === 'speech').length, 0);
    assert.ok(ctx.logs.some((line) => /Scene without narration: 4 s of silence, no voice made/.test(line)));
    assert.deepEqual(await scratchLeft(), []);
    // the same for an empty list entry, and the scene around it is 4.4 s long
    assert.equal(cuesLib.sceneDuration(timing.duration), 4.4);
  }

  // no times from the API: the words are estimated from the text and the log says so
  {
    reset();
    eleven.noAlignment = true;
    const ctx = makeCtx();
    const result = await exec('explainer.voice', ctx, { narration: textValue('Eins zwei drei vier.') }, {});
    const timing = JSON.parse(result.variants[0].timing.value);
    assert.deepEqual(timing.words.map((word) => word.text), ['Eins', 'zwei', 'drei', 'vier.']);
    assert.ok(timing.words.every((word, index) => index === 0 || word.start > timing.words[index - 1].start), 'in order');
    assert.ok(timing.words[3].end <= timing.duration + 1e-9);
    assert.ok(ctx.logs.some((line) => /no times for the characters: the word times are estimated/.test(line)));
    const even = videoNodes.evenWords('aa bbbbbb cc', 10);
    assert.deepEqual(even.map((word) => word.text), ['aa', 'bbbbbb', 'cc']);
    near(even[0].start, 0, 1e-9);
    assert.ok(even[1].start > even[0].end - 1e-9 && even[1].end - even[1].start > even[0].end - even[0].start, 'a longer word takes more time');
    assert.ok(even[2].end <= 10);
  }

  // a text that is too long for ElevenLabs is refused before a call
  {
    reset();
    const tooLong = await errorOf(exec('explainer.voice', makeCtx(), { narration: textValue('x'.repeat(2501)) }, {}));
    assert.match(tooLong.message, /2500/);
    assert.equal(eleven.calls.length, 0);
  }

  if (!haveFfmpeg) {
    console.log('ffmpeg not found: the parts of the scene node are skipped');
    return;
  }

  /* ---------- the scene ---------- */

  // a script of five scenes made by the planner itself: hook, a still, a scene with a figure from the second document, a clip, the
  // sources card (added by the planner); the briefs and the shot list are what the planner passes on
  const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
  const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';
  const sceneOf = (k, fields = {}) => {
    const narration = narrationOf(k, 22);
    const words = narration.replace(/\./g, '').split(' ');
    return {
      id: `s${k}`,
      kind: 'motion',
      role: k === 1 ? 'hook' : 'point',
      narration,
      on_screen: { title: `Titel ${k}`, bullets: [`Stichwort ${k}`], numbers: [], quote: null },
      elements: [{ id: 'e1', type: 'title', content: `Titel ${k}`, anchor: words[0] }, { id: 'e2', type: 'bullet', content: `Stichwort ${k}`, anchor: words[5] }],
      figure: null,
      image_prompt: null,
      clip_prompt: null,
      source_refs: [`D${k % 2 === 0 ? 2 : 1} S. ${(k % 2) + 1}`],
      ...fields
    };
  };
  const script = planLib.buildScript(
    {
      title: 'Wärmepumpen',
      summary: 'Wie sie funktionieren',
      scenes: [
        sceneOf(1),
        sceneOf(2, { kind: 'still', image_prompt: 'ein See im Winter' }),
        sceneOf(3, { figure: { document: 1, page: 2, bbox: [10, 36, 80, 22] }, elements: [{ id: 'e1', type: 'title', content: 'Titel 3', anchor: 'Pumpe3' }, { id: 'e2', type: 'figure', content: 'Diagramm', anchor: 'Technik3' }], source_refs: ['D2 S. 2'] }),
        sceneOf(4, { kind: 'clip', clip_prompt: 'Wasser fliesst' }),
        sceneOf(5, { kind: 'still', image_prompt: 'ein Haus' })
      ],
      presenter: null
    },
    { language: 'de', lengthSeconds: 60, visualMode: 'mix', maxStillShare: 0.5, documents: [{ name: 'bericht.pdf', title: 'Pegelbericht 2026', pageCount: 3 }, { name: 'anhang.pdf', title: 'Anhang', pageCount: 2 }], capabilities: { image: true, fal: true } }
  );
  assert.ok(script.script, `the planner accepted the script: ${JSON.stringify(script.issues)}`);
  const out = planLib.outputsOf(script.script);
  const sceneIndex = (id) => out.shots.scenes.findIndex((entry) => entry.id === id);
  assert.deepEqual(out.shots.scenes.map((entry) => [entry.id, entry.kind, entry.image, entry.clip]), [['s1', 'motion', null, null], ['s2', 'still', 0, null], ['s3', 'motion', null, null], ['s4', 'clip', null, 0], ['s5', 'still', 1, null], ['s6', 'motion', null, null]]);
  const spokenSeconds = 5.44;
  const timingOf = (narrationText, seconds = null) => {
    const characters = [...narrationText];
    const step = (seconds || characters.length * 0.06) / characters.length;
    const words = cuesLib.wordsFromAlignment({ characters, starts: characters.map((_c, index) => index * step), ends: characters.map((_c, index) => (index + 1) * step) });
    return cuesLib.timingOf(words, seconds || characters.length * step);
  };
  const timingText = (index, seconds = null) => textValue(JSON.stringify(out.narration[index] ? timingOf(out.narration[index], seconds) : cuesLib.silentTiming(4)));

  // pictures: three stills with different colours, five page images (a blue figure on a page of its own colour), a logo
  const png = async (colour, size, name, extra = []) => {
    const file = path.join(workDir, name);
    await media.ff(['-f', 'lavfi', '-i', `color=c=0x${colour}:s=${size}`, ...extra, '-frames:v', '1', file]);
    return fsp.readFile(file);
  };
  const stills = [await assetOf(await png('aa0000', '320x180', 'still-0.png'), '.png'), await assetOf(await png('00aa00', '320x180', 'still-1.png'), '.png'), await assetOf(await png('0000aa', '320x180', 'still-2.png'), '.png')];
  const PAGE_COLOURS = ['ffff00', 'ff00ff', '00ffff', 'ff8000', '808080'];
  const pageValues = [];
  for (let index = 0; index < 5; index += 1) {
    // the page of the figure (the fifth image: document 2, page 2) has a blue box where the figure is: x 10..90 %, y 36..58 %
    const extra = index === 4 ? ['-vf', 'drawbox=x=iw*0.10:y=ih*0.36:w=iw*0.80:h=ih*0.22:color=0x0000ff:t=fill'] : [];
    pageValues.push(await assetOf(await png(PAGE_COLOURS[index], '200x300', `page-${index}.png`, extra), '.png'));
  }
  const logo = await assetOf(await png('ffffff', '64x32', 'logo.png'), '.png');
  const pagesInfo = textValue(JSON.stringify({
    page_images: 'all',
    documents: [
      { type: 'pdf', title: 'Pegelbericht 2026', pages_read: 3, images: 3, image_offset: 0 },
      { type: 'pdf', title: 'Anhang', pages_read: 2, images: 2, image_offset: 3 }
    ]
  }));
  const shotsText = textValue(JSON.stringify(out.shots));
  const baseInputs = (index, extra = {}) => ({ brief: textValue(out.briefs[index]), timing: timingText(index, spokenSeconds), shots: shotsText, ...extra });
  const NEUTRAL = textValue(JSON.stringify(iso.load('lib/nodes/nodes-explainer').NEUTRAL_BRAND));
  const frames = async (value) => (await media.probe(fileOf(value))).frames;

  /* ---------- a clean scene: asked once, looked at once, rendered once ---------- */

  const sceneDuration = cuesLib.sceneDuration(spokenSeconds);
  assert.equal(sceneDuration, 5.867);
  {
    reset();
    renderPlan.push({ audio: true }); // the render node's video has a sound: the scene must be silent
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0, { brand: NEUTRAL }), {});
    assert.equal(writerCalls().length, 1);
    assert.equal(checkCalls().length, 1);
    assert.equal(renders.length, 1);
    // the model: Opus 5.5, with room for a long document
    const writer = writerCalls()[0].options;
    assert.equal(writer.model, 'anthropic/claude-opus-5.5');
    assert.equal(writer.maxTokens, 9000);
    assert.match(writer.system, new RegExp(`data-duration="5.866"`));
    assert.match(writer.system, /NORMAL FLOW/);
    assert.match(writer.system, /1920x1080 \(landscape\)/);
    assert.match(writer.prompt, /Scene duration: 5.87 s: write data-duration="5.866" exactly/);
    assert.match(writer.prompt, /Scene brief \(data\):\n<brief>\nScene s1 · role hook/);
    assert.match(writer.prompt, /Cue list \(absolute seconds on tl/);
    assert.match(writer.prompt, /e1 \(title, "Wärme1"\) at \d/);
    assert.match(writer.prompt, /No attached files\./);
    assert.match(writer.prompt, /Source line to show: "Pegelbericht 2026, S\. 2"|Source line to show: "[^"]*"|No source line\./, 'the source line is computed from the references');
    assert.deepEqual(writer.history, [], 'the first call has no history');
    // the cue list is the one the code computed from the word times
    const cue = /e1 \(title, "Wärme1"\) at ([\d.]+)/.exec(writer.prompt);
    const first = timingOf(out.narration[0], spokenSeconds).words.find((word) => word.text.startsWith('Wärme1'));
    near(Number(cue[1]), Math.max(0.2, first.start - 0.15), 0.011, 'the start of the anchor word less 0.15 s');
    // what the render node got: the policy first in <head>, the exact length, the right format and quality, no placeholders left
    const html = renders[0].html;
    assert.ok(/<head>\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\/dist\/;[^"]*form-action 'none'; base-uri 'none'"/.test(html), 'the policy is inserted');
    assert.match(html, /data-duration="5.866"/);
    assert.equal(renders[0].format, 'landscape');
    assert.equal(renders[0].quality, 'standard');
    // the check: two frames, the schedule of the cues, the rules of the judge
    const check = checkCalls()[0].options;
    assert.equal(check.images.length, 2);
    assert.ok(check.images.every((image) => /^data:image\/png;base64,/.test(image)), 'two PNG frames');
    assert.match(check.system, /layout defects/);
    assert.match(check.prompt, /Frame times: [\d.]+ s and 5\.72 s/, 'the second frame is 0.15 s before the end');
    assert.match(check.prompt, /e1 \(title\) appears at/);
    // the result: a silent video of exactly the length (5.867 s = 176 frames)
    const video = result.variants[0].video;
    assert.equal(video.type, 'video');
    const probe = await media.probe(fileOf(video));
    assert.equal(probe.frames, 176, 'frame exact: ceil(5.84 s x 30) frames');
    assert.equal(probe.hasAudio, false, 'a scene is silent');
    // the price: writing and looking, as the model reported it
    near(result.cost.usd, USD.writer + USD.check, 1e-9);
    // the log of the scene: what happened, with its number
    assert.ok(ctx.logs.some((line) => /^s1: attempt 1 of 3: rendered in \d+ s, check: ok; no fixed scene$/.test(line)), ctx.logs.join(' | '));
    assert.deepEqual(ctx.waits.map((options) => options.timeoutMs), [8 * 60 * 1000], 'a stuck job does not hold the node for half an hour');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- a model answer in a code fence, and a root element with another length ---------- */

  {
    reset();
    queue.writer.push((options) => `Here is the scene:\n\`\`\`html\n${goodHtml(options).replace(/data-duration="[\d.]+"/, 'data-duration="3"')}\n\`\`\``);
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0), {});
    assert.equal(writerCalls().length, 1, 'the fence is taken off, the length is put right: no second try');
    assert.match(renders[0].html, /data-duration="5.866"/, 'the exact length is forced');
    assert.ok(ctx.logs.some((line) => /data-duration was set to 5.867 s/.test(line)));
    assert.equal(await frames(result.variants[0].video), 176);
  }

  /* ---------- the code is checked before the render, a problem is answered in the same conversation ---------- */

  {
    reset();
    const bad = (options) => goodHtml(options).replace('<h1 id="t">', '<h1 id="t" onclick="fetch(\'https://evil.example/x\')">');
    queue.writer.push(bad);
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0), {});
    assert.equal(writerCalls().length, 2);
    assert.equal(renders.length, 1, 'the rejected code was never rendered');
    const second = writerCalls()[1].options;
    assert.equal(second.history.length, 2, 'the conversation goes on: the answer so far and what is wrong with it');
    assert.equal(second.history[0].role, 'assistant');
    assert.ok(second.history[0].content.includes("fetch('https://evil.example/x')"), 'the model is shown its own answer');
    assert.equal(second.history[1].role, 'user');
    assert.match(second.history[1].content, /The HTML was rejected before it could be rendered/);
    assert.match(second.history[1].content, /Forbidden: fetch\(/);
    assert.match(second.history[1].content, /Forbidden: the address https:\/\/evil\.example\/x/);
    assert.match(second.history[1].content, /complete corrected HTML document only\. Keep the cue times and the contract\./);
    assert.equal(second.prompt, writerCalls()[0].options.prompt, 'the first message stays the same');
    assert.ok(ctx.logs.some((line) => /attempt 1 of 3: the code was rejected before the render \(Forbidden: fetch\(/.test(line)));
    assert.ok(ctx.logs.some((line) => /attempt 2 of 3: rendered in/.test(line)));
    near(result.cost.usd, 2 * USD.writer + USD.check, 1e-9, 'both writings and one look are paid');
  }

  /* ---------- a render that fails: the error text goes back to the model ---------- */

  {
    reset();
    renderPlan.push({ fail: 'Render failed: ReferenceError: gsap is not defined' });
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0), {});
    assert.equal(writerCalls().length, 2);
    assert.equal(renders.length, 2);
    const history = writerCalls()[1].options.history;
    assert.match(history[1].content, /The render failed with this error:\n- Render failed: ReferenceError: gsap is not defined/);
    assert.ok(ctx.logs.some((line) => /attempt 1 of 3: the render failed \(Render failed: ReferenceError/.test(line)));
    assert.equal(checkCalls().length, 1, 'the frames of the failed render were never looked at');
    assert.equal(await frames(result.variants[0].video), 176);

    // a render node that is gone ends the node: no retry and no fixed scene help
    reset();
    renderPlan.push({ gone: true });
    const gone = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), {}));
    assert.match(gone.message, /Timed out waiting for job/);
    assert.equal(writerCalls().length, 1);
    assert.equal(renders.length, 1);
    // a render node that does not take the job (an outage) ends the node too
    reset();
    const original = rendernode.submit;
    rendernode.submit = async () => {
      throw new Error('Render node not reachable');
    };
    const outage = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), {}));
    rendernode.submit = original;
    assert.match(outage.message, /not reachable/);
    assert.equal(writerCalls().length, 1);
  }

  /* ---------- the look: blockers lead to a correction, minor notes do not ---------- */

  {
    reset();
    queue.check.push({ ok: false, blockers: ['the title is cut off at the right edge', 'two texts overlap'], minor: ['a little tight'] });
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0), {});
    assert.equal(writerCalls().length, 2);
    assert.equal(renders.length, 2);
    assert.equal(checkCalls().length, 2);
    const history = writerCalls()[1].options.history;
    assert.match(history[1].content, /The rendered scene has these problems:\n- the title is cut off at the right edge\n- two texts overlap\nFix them/);
    assert.ok(!history[1].content.includes('a little tight'), 'minor notes are not sent back');
    assert.ok(ctx.logs.some((line) => /attempt 1 of 3: rendered in \d+ s, check: 2 defects \(the title is cut off/.test(line)));
    assert.ok(ctx.logs.some((line) => /attempt 2 of 3: .*check: ok; no fixed scene/.test(line)));
    near(result.cost.usd, 2 * USD.writer + 2 * USD.check, 1e-9);
    // minor only: taken as it is
    reset();
    queue.check.push({ ok: true, blockers: [], minor: ['colours could be calmer'] });
    const minorCtx = makeCtx();
    await exec('explainer.scene', minorCtx, baseInputs(0), {});
    assert.equal(writerCalls().length, 1);
    assert.ok(minorCtx.logs.some((line) => /check: ok, 1 minor notes; no fixed scene/.test(line)));
    // a verdict that cannot be read, or a check that fails: the scene is taken as it is
    reset();
    queue.check.push('I think it looks fine!');
    const unreadable = makeCtx();
    await exec('explainer.scene', unreadable, baseInputs(0), {});
    assert.equal(writerCalls().length, 1);
    assert.ok(unreadable.logs.some((line) => /the answer of the check could not be read: the scene is taken as it is/.test(line)));
    reset();
    queue.check.push(new Error('the model is overloaded'));
    const failingCheck = makeCtx();
    await exec('explainer.scene', failingCheck, baseInputs(0), {});
    assert.equal(writerCalls().length, 1);
    assert.ok(failingCheck.logs.some((line) => /the check could not be made \(the model is overloaded\)/.test(line)));
    // the two frames: halfway or at the last cue (the earlier), and 0.15 s before the end
    const frameTimes = /Frame times: ([\d.]+) s and ([\d.]+) s/.exec(checkCalls()[0].options.prompt);
    assert.ok(Number(frameTimes[1]) <= sceneDuration / 2 + 1e-9 && Number(frameTimes[2]) === 5.72);
  }

  // the look switched off: not looked at, not paid
  {
    reset();
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0), { vision_check: false });
    assert.equal(checkCalls().length, 0, 'no call of the look');
    assert.ok(ctx.logs.some((line) => /rendered in \d+ s, not looked at \(the check is off\)/.test(line)));
    near(result.cost.usd, USD.writer, 1e-9);
    assert.equal(await frames(result.variants[0].video), 176);
  }

  /* ---------- after the last try: the fixed scene, or the end ---------- */

  {
    reset();
    for (let index = 0; index < 3; index += 1) queue.writer.push('I am sorry, I cannot do that.');
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(0, { brand: NEUTRAL }), {});
    assert.equal(writerCalls().length, 3, 'the first try and two more');
    assert.equal(renders.length, 1, 'only the fixed scene is rendered');
    assert.match(renders[0].html, /Titel 1/, 'the fixed scene shows the title of the brief');
    assert.match(renders[0].html, /Stichwort 1/);
    assert.match(renders[0].html, /data-duration="5.866"/);
    assert.match(renders[0].html, /Content-Security-Policy/, 'the fixed scene gets the policy as well');
    assert.equal(sceneLib.checkCode(renders[0].html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), { format: 'landscape', assets: 0 }).length, 0, 'the fixed scene passes the check of the code');
    assert.ok(ctx.logs.some((line) => /the fixed scene stands in after 3 tries \(last problem: The answer is not an HTML document|the fixed scene stands in after 3 tries/.test(line)), ctx.logs.join(' | '));
    // the third conversation holds both failed answers
    const third = writerCalls()[2].options.history;
    assert.equal(third.length, 4);
    assert.deepEqual(third.map((turn) => turn.role), ['assistant', 'user', 'assistant', 'user']);
    assert.equal(await frames(result.variants[0].video), 176);
    near(result.cost.usd, 3 * USD.writer, 1e-9);
    assert.equal(checkCalls().length, 0, 'what was never rendered was never looked at');

    // max_retries 0: one try, then the fixed scene
    reset();
    queue.writer.push('no');
    await exec('explainer.scene', makeCtx(), baseInputs(0), { max_retries: 0 });
    assert.equal(writerCalls().length, 1);
    assert.equal(renders.length, 1);

    // the same after blockers in every try: the last rendered scene of the model is NOT used, the fixed one is
    reset();
    queue.check.push({ ok: false, blockers: ['overlap'] }, { ok: false, blockers: ['overlap'] }, { ok: false, blockers: ['overlap again'] });
    const blocked = makeCtx();
    await exec('explainer.scene', blocked, baseInputs(0), {});
    assert.equal(writerCalls().length, 3);
    assert.equal(renders.length, 4, 'three renders of the model and the fixed scene');
    assert.ok(/Titel 1/.test(renders[3].html) && !/id="t">Titel</.test(renders[3].html));
    assert.ok(blocked.logs.some((line) => /last problem: overlap again/.test(line)));

    // the fixed scene is switched off: the node stops with the code and the scene
    reset();
    queue.writer.push('no', 'no', 'no');
    const stopped = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), { fallback: false }));
    assert.equal(stopped.code, 'EXPLAINER_SCENE_FAILED');
    assert.deepEqual(stopped.data, { scene: 's1' });
    assert.match(stopped.message, /3 tries gave no usable scene/);
    assert.equal(renders.length, 0);
    assert.deepEqual(await scratchLeft(), []);

    // the fixed scene cannot be rendered either: the end, with its own code
    reset();
    queue.writer.push('no', 'no', 'no');
    renderPlan.push({ fail: 'Chrome crashed' });
    const hopeless = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), {}));
    assert.equal(hopeless.code, 'EXPLAINER_SCENE_RENDER_FAILED');
    assert.match(hopeless.message, /Chrome crashed/);

    // a model that fails (not the code): that try is lost, the next one goes on
    reset();
    queue.writer.push(new Error('the model is overloaded'));
    const flaky = makeCtx();
    await exec('explainer.scene', flaky, baseInputs(0), {});
    assert.equal(writerCalls().length, 2);
    assert.ok(flaky.logs.some((line) => /attempt 1 of 3: the model failed \(the model is overloaded\)/.test(line)));
  }

  /* ---------- a stop of the run, the budget, the rights of the account: no retry, no fixed scene ---------- */

  {
    reset();
    const BudgetError = iso.load('lib/budget').BudgetError;
    queue.writer.push(new BudgetError('BUDGET_EXHAUSTED', 'budget used up', 'Budget aufgebraucht'));
    const exhausted = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), {}));
    assert.equal(exhausted.code, 'BUDGET_EXHAUSTED');
    assert.equal(writerCalls().length, 1);
    assert.equal(renders.length, 0);
    reset();
    const access = iso.load('lib/access');
    queue.writer.push(new access.RoleRestrictedError('models', 'This model is not available for your account'));
    const restricted = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), {}));
    assert.equal(restricted.code, 'FORBIDDEN_FOR_ROLE');
    assert.equal(writerCalls().length, 1);
    reset();
    const controller = new AbortController();
    const abortCtx = makeCtx();
    abortCtx.signal = controller.signal;
    queue.writer.push(() => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const aborted = await errorOf(exec('explainer.scene', abortCtx, baseInputs(0), {}));
    assert.ok(aborted);
    assert.equal(writerCalls().length, 1, 'an abort is not tried again');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- a stop of the run while the model writes: its answer is not rendered ---------- */

  {
    // the model does not know about the signal: it answers as usual although the run was stopped meanwhile
    reset();
    const controller = new AbortController();
    const stopped = makeCtx();
    stopped.signal = controller.signal;
    queue.writer.push((options) => {
      controller.abort();
      return goodHtml(options);
    });
    const err = await errorOf(exec('explainer.scene', stopped, baseInputs(0), {}));
    assert.ok(err && err.name === 'AbortError', 'the scene ends with an abort');
    assert.equal(writerCalls().length, 1);
    assert.equal(renders.length, 0, 'no job is sent to the render node after the stop');
    assert.equal(checkCalls().length, 0, 'and no look at frames is paid');
    assert.deepEqual(await scratchLeft(), []);
    // the same during the look: the render was done, the scene is not looked at after the stop (no second try either)
    reset();
    const midway = new AbortController();
    const second = makeCtx();
    second.signal = midway.signal;
    const waitForJob = second.waitForJob;
    second.waitForJob = async (job, options) => {
      const ids = await waitForJob(job, options);
      midway.abort();
      return ids;
    };
    const late = await errorOf(exec('explainer.scene', second, baseInputs(0), {}));
    assert.ok(late && late.name === 'AbortError');
    assert.equal(renders.length, 1);
    assert.equal(checkCalls().length, 0, 'no look after the stop');
    // the voice does not call ElevenLabs after a stop
    reset();
    const quiet = new AbortController();
    const voiceCtx = makeCtx();
    voiceCtx.signal = quiet.signal;
    quiet.abort();
    const voiceStopped = await errorOf(exec('explainer.voice', voiceCtx, { narration: textValue('Ein Satz.') }, {}));
    assert.ok(voiceStopped && voiceStopped.name === 'AbortError');
    assert.equal(eleven.calls.length, 0, 'no call to ElevenLabs after a stop');
  }

  /* ---------- the render waits for the scenes before it ---------- */

  {
    // three scenes send their render soon after each other and stand in the line of the render node: each waits for the ones before it
    reset();
    const contexts = [makeCtx(), makeCtx(), makeCtx()];
    let waiting = 0;
    let open;
    const allWaiting = new Promise((resolve) => {
      open = resolve;
    });
    for (const ctx of contexts) {
      const original = ctx.waitForJob;
      ctx.waitForJob = async (job, options) => {
        ctx.waits.push(options);
        waiting += 1;
        if (waiting === contexts.length) open();
        await allWaiting;
        const before = ctx.waits.length;
        const ids = await original(job, options);
        ctx.waits.splice(before, 1); // the original noted the options a second time
        return ids;
      };
    }
    await Promise.all(contexts.map((ctx, index) => exec('explainer.scene', ctx, baseInputs(index % 2), { vision_check: false })));
    const timeouts = contexts.map((ctx) => ctx.waits[0].timeoutMs).sort((a, b) => a - b);
    assert.deepEqual(timeouts, [8 * 60 * 1000, 9 * 60 * 1000, 10 * 60 * 1000], 'a minute more for every job that was sent before and is not done');
    // alone again: back to the base wait (the counter went down)
    reset();
    const alone = makeCtx();
    await exec('explainer.scene', alone, baseInputs(0), { vision_check: false });
    assert.deepEqual(alone.waits.map((options) => options.timeoutMs), [8 * 60 * 1000]);
    // and the wait never goes beyond the time the node itself may run
    assert.ok(videoNodes.RENDER_WAIT_MAX_MS < sceneDef.timeoutMs && videoNodes.RENDER_WAIT_MAX_MS > videoNodes.RENDER_WAIT_MS);
    assert.ok(sceneDef.timeoutMs >= 45 * 60 * 1000, 'time for a long film at one render in about 30 s');
  }

  /* ---------- the model of an account: Opus, or the model of the list ---------- */

  {
    reset();
    const ctx = makeCtx({ user: P1, config: { restrictedBrainModels: ['vendor/default-brain'], defaultBrain: 'vendor/default-brain' } });
    await exec('explainer.scene', ctx, baseInputs(0), {});
    assert.equal(writerCalls()[0].options.model, 'vendor/default-brain', 'a participant whose list has no Opus gets the model of the list');
    assert.ok(ctx.logs.some((line) => /anthropic\/claude-opus-5\.5 is not available for your account: vendor\/default-brain is used instead/.test(line)));
    reset();
    await exec('explainer.scene', makeCtx(), baseInputs(0), { model: 'anthropic/claude-sonnet-5.5' });
    assert.equal(writerCalls()[0].options.model, 'anthropic/claude-sonnet-5.5', 'a model chosen by hand');
  }

  /* ---------- the exact length, whatever the voice ---------- */

  {
    for (const voice of [1.234, 3.6, 4.0, 9.99]) {
      reset();
      const index = 0;
      const result = await exec('explainer.scene', makeCtx(), baseInputs(index, { timing: timingText(index, voice) }), { vision_check: false });
      const expected = Math.ceil((voice + 0.4) * 30 - 1e-6);
      assert.equal(await frames(result.variants[0].video), expected, `voice ${voice} s: ${expected} frames`);
      assert.match(renders[0].html, new RegExp(`data-duration="${sceneLib.durationAttr(cuesLib.sceneDuration(voice)).replace('.', '\\.')}"`));
    }
  }

  /* ---------- a scene is found by its number, not by its place ---------- */

  {
    reset();
    // the brief of s5 (a still, picture number 1) with the item index 0: the picture is the one the shot list names
    const ctx = makeCtx({ itemIndex: 0 });
    await exec('explainer.scene', ctx, baseInputs(sceneIndex('s5'), { stills: listValue('image', stills) }), { vision_check: false });
    const sent = writerCalls()[0].options;
    assert.equal(sent.images.length, 1, 'one attached picture: the still of this scene');
    assert.match(renders[0].html, new RegExp(`<img src="${stills[1].assetId}\\.png"`), 'the placeholder is the file of the second still');
    assert.ok(!renders[0].html.includes(stills[0].assetId) && !renders[0].html.includes(stills[2].assetId));
    assert.match(sent.prompt, /\{\{asset:1\}\} = image \(png\): a still picture for the BACKGROUND/);
    // the data URL that the model sees is that of the second still (green)
    assert.equal(sent.images[0], await store.assetDataUrl(sessionId, stills[1].assetId));
    // s2 is picture number 0
    reset();
    await exec('explainer.scene', makeCtx({ itemIndex: 4 }), baseInputs(sceneIndex('s2'), { stills: listValue('image', stills) }), { vision_check: false });
    assert.match(renders[0].html, new RegExp(`<img src="${stills[0].assetId}\\.png"`), 'by the number of the scene, not by the item index');
    // a still scene that gets no still: drawn without a background, and the log says so
    reset();
    const noStill = makeCtx();
    await exec('explainer.scene', noStill, baseInputs(sceneIndex('s2')), { vision_check: false });
    assert.ok(noStill.logs.some((line) => /s2: a still scene without a still picture \(none arrived for it\): drawn without a background/.test(line)));
    assert.match(writerCalls()[0].options.prompt, /No attached files\./);
    // a motion scene does not take a still that happens to be connected
    reset();
    await exec('explainer.scene', makeCtx(), baseInputs(0, { stills: listValue('image', stills) }), { vision_check: false });
    assert.equal(writerCalls()[0].options.images.length, 0);
    // an id that is not in the shot list: no still, no figure, a note
    reset();
    const unknown = makeCtx();
    const otherShots = { ...out.shots, scenes: out.shots.scenes.filter((entry) => entry.id !== 's2') };
    await exec('explainer.scene', unknown, baseInputs(sceneIndex('s2'), { shots: textValue(JSON.stringify(otherShots)), stills: listValue('image', stills) }), { vision_check: false });
    assert.ok(unknown.logs.some((line) => /the shot list has no entry with this id: no still, no figure/.test(line)));
    // the fixed scene of a still has the picture as its background
    reset();
    queue.writer.push('no', 'no', 'no');
    await exec('explainer.scene', makeCtx(), baseInputs(sceneIndex('s2'), { stills: listValue('image', stills) }), {});
    assert.match(renders[0].html, new RegExp(`<img id="bg" src="${stills[0].assetId}\\.png"`));
    assert.match(renders[0].html, /Ken|scale/, 'with a slow zoom');
  }

  /* ---------- a figure of a PDF page: cut out with a margin, found by document and page ---------- */

  {
    reset();
    const ctx = makeCtx();
    await exec('explainer.scene', ctx, baseInputs(sceneIndex('s3'), { pages: listValue('image', pageValues), pages_info: pagesInfo }), { vision_check: false });
    const sent = writerCalls()[0].options;
    assert.equal(sent.images.length, 1, 'the cut-out figure is sent to the model as an image');
    assert.match(sent.prompt, /\{\{asset:1\}\} = image \(png, 168x78 px\): a figure cut out of a page of the document/);
    assert.match(sent.prompt, /page 2 of the document, cut to the figure/);
    assert.match(sent.prompt, /Source line to show: "Anhang, S\. 2"/, 'the title of the document from the info text');
    // the asset that was cut: 84 % x 26 % of the page image number 5 (document 2, page 2), the margin of 2 % around the figure
    const figureId = /(\w+-\d+|[a-z]+_?\d+)\.png/.exec(renders[0].html)[0];
    const figureAsset = (await store.readLedger(sessionId)).find((entry) => entry.file === figureId);
    assert.ok(figureAsset, `the figure is an asset of the session: ${figureId}`);
    const figureFile = path.join(sessionDir, figureAsset.file);
    const probe = await media.probe(figureFile);
    assert.deepEqual([probe.width, probe.height], [168, 78]);
    const centre = await media.rgbAt(figureFile, 0);
    assert.ok(centre[2] > 200 && centre[0] < 60 && centre[1] < 60, `the middle of the cut is the blue box of the figure: ${centre}`);
    // the margin is the page colour of page five (808080), not of any other page
    const asVideoColour = await media.colourAt(figureFile, 0);
    assert.equal(asVideoColour, '0000ff');
    const corner = await (async () => {
      const file = path.join(workDir, 'corner.png');
      await media.ff(['-i', figureFile, '-vf', 'crop=4:4:0:0,scale=1:1', '-frames:v', '1', file]);
      return media.rgbAt(file, 0);
    })();
    assert.deepEqual(corner.map((value) => Math.abs(value - 128) < 12), [true, true, true], `the corner of the cut is the grey of page five: ${corner}`);
    assert.ok(ctx.logs.every((line) => !/figure is left out/.test(line)));
    // the render gets the figure as a file too
    assert.match(renders[0].html, new RegExp(`${figureAsset.id}\\.png`));

    // without page images, or without their info text: drawn without the figure, with a log
    reset();
    const noPages = makeCtx();
    await exec('explainer.scene', noPages, baseInputs(sceneIndex('s3')), { vision_check: false });
    assert.ok(noPages.logs.some((line) => /a figure is planned, but the page images or their info text are not connected: drawn without the figure/.test(line)));
    assert.equal(writerCalls()[0].options.images.length, 0);
    // a page that has no image
    reset();
    const noImage = makeCtx();
    const shortInfo = textValue(JSON.stringify({ documents: [{ type: 'pdf', title: 'A', pages_read: 3, images: 3, image_offset: 0 }, { type: 'pdf', title: 'Anhang', pages_read: 1, images: 1, image_offset: 3 }] }));
    await exec('explainer.scene', noImage, baseInputs(sceneIndex('s3'), { pages: listValue('image', pageValues), pages_info: shortInfo }), { vision_check: false });
    assert.ok(noImage.logs.some((line) => /the figure is left out: page 2 has no image \(1 page images were made\)/.test(line)));
    // the images of the PDFs were not made at all
    reset();
    const noImages = makeCtx();
    const withoutImages = textValue(JSON.stringify({ documents: [{ type: 'pdf', title: 'A', pages_read: 3, images: 0, image_offset: null }, { type: 'pdf', title: 'Anhang', pages_read: 2, images: 0, image_offset: null }] }));
    await exec('explainer.scene', noImages, baseInputs(sceneIndex('s3'), { pages: listValue('image', pageValues), pages_info: withoutImages }), { vision_check: false });
    assert.ok(noImages.logs.some((line) => /the figure is left out: the document has no page images \(set "Page images" of Read documents to all\)/.test(line)));
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the logo, the brand, the fonts ---------- */

  {
    reset();
    // the logo goes into the hook only
    await exec('explainer.scene', makeCtx(), baseInputs(0, { logo, brand: NEUTRAL }), { vision_check: false });
    assert.equal(writerCalls()[0].options.images.length, 1);
    assert.match(writerCalls()[0].options.prompt, /\{\{asset:1\}\} = image \(png\): the logo of the brand/);
    reset();
    await exec('explainer.scene', makeCtx(), baseInputs(sceneIndex('s3'), { logo }), { vision_check: false });
    assert.equal(writerCalls()[0].options.images.length, 0, 'a scene in the middle has no logo');
    reset();
    await exec('explainer.scene', makeCtx(), baseInputs(sceneIndex('s6'), { logo, brand: NEUTRAL }), { vision_check: false });
    assert.equal(writerCalls()[0].options.images.length, 1, 'the sources card has it');

    // the brand: its colours and fonts are in the words of the model
    reset();
    const created = await brandings.createBranding({ name: 'Acme Test' });
    const woff = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(2000, 7)]);
    const saved = await brandings.saveBrandingAsset(created.id, { buffer: woff, filename: 'brand-sans.woff2' });
    await brandings.saveBrandingAsset(created.id, { buffer: Buffer.alloc(500 * 1024, 1), filename: 'big.woff2' });
    await brandings.updateBranding(created.id, {
      colors: [{ role: 'background', name: 'Paper', hex: '#fafafa' }, { role: 'text', name: 'Ink', hex: '#1a1a2e' }, { role: 'accent', name: 'Orange', hex: '#e8590c' }],
      typography: [
        { role: 'headline', family: 'Brand Sans', weights: '700', source: 'upload', file: `assets/${saved.filename || 'brand-sans.woff2'}` },
        { role: 'body', family: 'Big Serif', weights: '400', source: 'upload', file: 'assets/big.woff2' }
      ],
      motion: { notes: 'Calm, no bounce.' }
    });
    const brandText = textValue(JSON.stringify(iso.load('lib/nodes/nodes-explainer').brandProfile(await brandings.readBranding(created.id))));
    const ctx = makeCtx();
    await exec('explainer.scene', ctx, baseInputs(0, { brand: brandText }), { vision_check: false });
    const system = writerCalls()[0].options.system;
    assert.match(system, /background #fafafa/);
    assert.match(system, /accent #e8590c/);
    assert.match(system, /'Brand Sans', system-ui/);
    assert.match(system, /\(embedded, use it as it is\)/, 'the embedded font is named as such');
    assert.match(system, /Calm, no bounce\./);
    // embedded as base64, behind the policy; the font of more than 400 KB is left out with a log
    const html = renders[0].html;
    assert.match(html, /@font-face\{font-family:'Brand Sans';src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{100,}\) format\('woff2'\)/);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('@font-face'));
    assert.ok(!html.includes("font-family:'Big Serif'"), 'a font file of 500 KB is not embedded');
    assert.ok(ctx.logs.some((line) => /font: Big Serif: 500 KB is above 400 KB: the system font is used/.test(line)), ctx.logs.join(' | '));
    assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
    // a participant has no brandings: the system font, with a log
    reset();
    const guest = makeCtx({ user: P1, config: { restrictedBrainModels: ['anthropic/claude-opus-5.5'] } });
    await exec('explainer.scene', guest, baseInputs(0, { brand: brandText }), { vision_check: false });
    assert.ok(guest.logs.some((line) => /Brandings are not available for your account: the system font is used/.test(line)));
    assert.ok(!renders[0].html.includes('@font-face'));
    // a brand text that is not JSON: the neutral look
    reset();
    await exec('explainer.scene', makeCtx(), baseInputs(0, { brand: textValue('garbage') }), { vision_check: false });
    assert.match(writerCalls()[0].options.system, /background #0f1115/);
  }

  /* ---------- a clip scene is a plain stand-in: no model, no render ---------- */

  {
    reset();
    const ctx = makeCtx();
    const result = await exec('explainer.scene', ctx, baseInputs(sceneIndex('s4'), { brand: NEUTRAL }), {});
    assert.equal(calls.length, 0, 'no model call for a clip scene');
    assert.equal(renders.length, 0, 'no render');
    const probe = await media.probe(fileOf(result.variants[0].video));
    assert.equal(probe.frames, 176);
    assert.equal(probe.hasAudio, false);
    assert.equal(result.cost.usd, 0);
    assert.ok(ctx.logs.some((line) => /s4: a clip scene: a plain stand-in of the right length is made, the clip replaces it in the cut/.test(line)));
    assert.equal(await media.colourAt(fileOf(result.variants[0].video), 1), '000000', 'the colour of the background (the neutral night is almost black)');
  }

  /* ---------- the sources card: no voice, the elements come one after the other ---------- */

  {
    reset();
    const index = sceneIndex('s6');
    const result = await exec('explainer.scene', makeCtx(), baseInputs(index, { timing: timingText(index) }), { vision_check: false });
    assert.match(writerCalls()[0].options.prompt, /Scene duration: 4.4 s/);
    assert.equal(await frames(result.variants[0].video), 132, 'four seconds of silence and 0.4 s');
    const cueList = /Cue list[^:]*: ([^\n]*)\./.exec(writerCalls()[0].options.prompt)[1];
    assert.match(cueList, /e1 \(title\) at 0.3; e2 \(bullet\) at 0.65;/, 'staggered from 0.3 s in steps of 0.35 s');
  }

  /* ---------- errors ---------- */

  {
    reset();
    const noTiming = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0, { timing: textValue('{"nope":1}') }), {}));
    assert.equal(noTiming.code, 'EXPLAINER_TIMING_INVALID');
    assert.equal(calls.length, 0);
    const mismatch = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(0), { format: 'portrait' }));
    assert.equal(mismatch.code, 'EXPLAINER_FORMAT_MISMATCH');
    assert.deepEqual(mismatch.data, { planned: 'landscape', set: 'portrait' });
    assert.equal(calls.length, 0, 'nothing is asked before the format is right');
    // portrait: the plan says portrait, the node says portrait
    const portraitShots = textValue(JSON.stringify({ ...out.shots, format: 'portrait' }));
    reset();
    const portraitBrief = out.briefs[0].replace('landscape', 'portrait');
    const portrait = await exec('explainer.scene', makeCtx(), { brief: textValue(portraitBrief), timing: timingText(0, spokenSeconds), shots: portraitShots }, { format: 'portrait', vision_check: false });
    assert.match(writerCalls()[0].options.system, /1080x1920 \(portrait\)/);
    assert.equal(renders[0].format, 'portrait');
    assert.match(renders[0].html, /data-width="1080" data-height="1920"/);
    assert.equal(await frames(portrait.variants[0].video), 176);
    // an asset of another session is refused
    reset();
    const other = await store.createSession();
    const foreign = await store.saveAsset(other.id, { kind: 'upload', buffer: await png('00ff00', '16x16', 'f.png'), ext: '.png', prompt: 'x' });
    const foreignValue = await assets.valueFromAsset(other.id, foreign.id);
    const refused = await errorOf(exec('explainer.scene', makeCtx(), baseInputs(sceneIndex('s2'), { stills: listValue('image', [foreignValue, foreignValue]) }), {}));
    assert.match(refused.message, /belongs to another session/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the matching by lists: each scene depends on its own inputs only ---------- */

  {
    reset();
    await exec('explainer.scene', makeCtx({ itemIndex: 0 }), baseInputs(0), { vision_check: false });
    const html0 = renders[0].html;
    reset();
    await exec('explainer.scene', makeCtx({ itemIndex: 7 }), baseInputs(0), { vision_check: false });
    assert.equal(renders[0].html, html0, 'the same inputs give the same request, whatever the place in the list');
    assert.equal(writerCalls().length, 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
