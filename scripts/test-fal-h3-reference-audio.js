'use strict';

// The single audio port uses the real engine's list resolution and per-item input path. Probes, conversion and paid
// tools are recorders; workflow assets live in an isolated app. No provider, network connection or real key is used.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');

async function main() {
  const app = await createIsolatedApp({ loadServer: false });
  try {
    const nodes = app.load('lib/nodes/nodes-fal');
    const store = app.load('lib/store');
    const assets = app.load('lib/nodes/assets');
    const ffmpeg = app.load('lib/ffmpeg');
    const ops = app.load('lib/nodes/ffmpeg-ops');
    const fal = app.load('lib/fal');
    const tools = app.load('lib/tools');
    const engine = app.load('lib/nodes/engine');
    const { createRegistry } = app.load('lib/nodes/registry');
    const { textValue, listValue } = app.load('lib/nodes/types');
    const registry = createRegistry(); nodes.registerAll(registry);
    const def = registry.get('fal.h3_reference');
    const params = (raw = {}) => registry.normalizeParams(def, raw);
    const list = listValue;
    await store.ensureDirs();
    const { id: sessionId } = await store.createSession();
    const logs = [], probes = new Map(), conversions = [], submissions = [], savedWavs = [];
    const binaries = { available: true, ffmpeg: 'mock-ffmpeg', ffprobe: 'mock-ffprobe' };
    ffmpeg.binaries = () => binaries;
    fal.hasKey = () => true;
    fal.uploadFile = fal.submit = async () => { throw new Error('Network forbidden'); };
    ops.probeMedia = async (file) => {
      assert.ok(probes.has(path.basename(file)), 'Only fixture files are probed');
      return probes.get(path.basename(file));
    };
    ffmpeg.runProcess = async (binary, args, options) => {
      conversions.push({ binary, args, options });
      await fs.writeFile(args.at(-1), Buffer.from('RIFF-mock-pcm16-WAVE'));
    };
    const result = await store.saveAsset(sessionId, { kind: 'video', ext: '.mp4', buffer: Buffer.from('result') });
    const ctx = {
      sessionId, toolCtx: { nodeView: true, sessionId }, signal: new AbortController().signal,
      withLocalSlot: (fn) => fn(), log: (line) => logs.push(line), waitForJob: async () => [result.id],
      saveOutputFile: async (options) => {
        const value = await assets.saveOutputFile(sessionId, options);
        savedWavs.push(value);
        return value;
      }
    };
    tools.executeTool = async (_ctx, name, args) => {
      assert.equal(name, 'fal_generate'); submissions.push(args);
      return { job: { jobId: 'mock-reference', assetId: result.id } };
    };
    async function media(type, { duration = 5, ext = type === 'image' ? '.png' : type === 'video' ? '.mp4' : '.mp3', codec = 'mp3' } = {}) {
      const saved = await store.saveAsset(sessionId, { kind: type, ext, buffer: Buffer.from(`fixture-${probes.size}`), duration });
      const value = { ...await assets.valueFromAsset(sessionId, saved.id), duration };
      probes.set(saved.file, { duration, audio: { codec }, video: type === 'audio' ? null : { width: 1024, height: 1024 } });
      return value;
    }
    const prompt = textValue('Image 1 sings with Image 2 to Audio 1');
    const audio = await media('audio', { duration: 7.004 });
    const secondAudio = await media('audio', { duration: 5 });
    const images = [await media('image'), await media('image')];
    const video = await media('video', { duration: 3 });
    const plan = (inputs, raw) => nodes.planH3Reference(ctx, { prompt, ...inputs }, params(raw));
    const execute = (inputs, raw) => def.execute(ctx, { prompt, ...inputs }, params(raw));
    const estimate = (inputs, raw = {}, connected = new Set()) => def.cost.estimate(params(raw), { inputs, connected });

    // Exact legacy request, media, pricing, output and cache keys: the added default and unwired port disappear from
    // the key. Checking both whole-node and item keys protects previously generated reference workflows from reruns.
    const legacyInputs = { prompt, images: list('image', images), videos: list('video', [video]), audios: list('audio', [audio]) };
    const legacyParams = { prompt: '', resolution: '768P', aspect_ratio: 'adaptive', duration: 6, prompt_expansion: 'balanced', seed: null, safety: true };
    const legacyDef = { ...def, params: def.params.filter((p) => p.id !== 'duration_from_audio'), inputs: def.inputs.filter((p) => p.id !== 'audio') };
    const legacyPlan = {
      endpoint: 'minimax/h3-max/reference-to-video',
      input: { prompt: prompt.value, prompt_expansion_mode: 'balanced', resolution: '768P', aspect_ratio: 'adaptive', duration: 6, enable_safety_checker: true },
      media: [
        { field: 'reference_image_urls', assetIds: images.map((v) => v.assetId), multiple: true },
        { field: 'reference_video_urls', assetIds: [video.assetId], multiple: true },
        { field: 'reference_audio_urls', assetIds: [audio.assetId], multiple: true }
      ],
      estimateUsd: 0.48, pricing: { perSecond: 0.08, durationField: 'duration' }, prompt: prompt.value
    };
    assert.equal(JSON.stringify(await plan(legacyInputs, { duration: 6 })), JSON.stringify(legacyPlan));
    assert.equal(JSON.stringify(await plan(legacyInputs, { duration: 6, duration_from_audio: false })), JSON.stringify(legacyPlan));
    assert.equal(estimate(legacyInputs, { duration: 6 }), 0.48);
    assert.equal(def.cost.history, legacyDef.cost.history);
    const resolvedLegacy = { inputs: legacyInputs, mapped: [], mapLength: null };
    for (const raw of [{ duration: 6 }, { duration: 6, duration_from_audio: false }]) {
      assert.equal(engine.computeCacheKey(def, params(raw), legacyInputs), engine.computeCacheKey(legacyDef, legacyParams, legacyInputs));
      assert.deepEqual(engine.computeItemKeys(def, params(raw), resolvedLegacy), engine.computeItemKeys(legacyDef, legacyParams, resolvedLegacy));
    }
    assert.notEqual(engine.computeCacheKey(def, params({ duration: 6, duration_from_audio: true }), legacyInputs), engine.computeCacheKey(legacyDef, legacyParams, legacyInputs));
    assert.equal(conversions.length, 0);
    assert.equal(logs.length, 0);
    const output = await execute(legacyInputs, { duration: 6 });
    assert.equal(output.variants[0].video.assetId, result.id);
    assert.equal(output.variants[0].expanded_prompt.value, prompt.value);
    assert.deepEqual(submissions.at(-1).media, legacyPlan.media);
    assert.deepEqual(submissions.at(-1).input, legacyPlan.input);
    assert.equal(submissions.at(-1).estimateUsd, legacyPlan.estimateUsd);

    assert.deepEqual(def.inputs.map((port) => port.id), ['prompt', 'audio', 'images', 'videos', 'audios']);
    assert.notEqual(def.inputs[1].required, true);
    assert.notEqual(def.inputs[1].multiple, true);
    const durationParam = def.params[def.params.findIndex((p) => p.id === 'duration') + 1];
    assert.deepEqual([durationParam.id, durationParam.default, durationParam.cacheOmitDefault], ['duration_from_audio', false, true]);

    // Connection order owns image numbering. The lists of prompts/audio map together while multiple images stay
    // whole in each execution; computeItemKeys calls the same itemInputsOf path the executor uses.
    const sources = {
      prompts: { out: list('text', [textValue('first duet'), textValue('second duet')]) },
      tones: { out: list('audio', [audio, secondAudio]) }, lead: { out: images[0] }, guest: { out: images[1] }
    };
    const edges = [['prompts', 'prompt'], ['tones', 'audio'], ['guest', 'images'], ['lead', 'images']].map(([source, port], i) => ({ id: `e${i}`, from: { node: source, port: 'out' }, to: { node: 'ref', port } }));
    const resolved = engine.resolveNodeInputs({ node: { id: 'ref' }, ports: def, params: params(), edges, outputsOf: (id) => sources[id], maxListItems: 120 });
    assert.deepEqual(resolved.mapped, ['prompt', 'audio']);
    assert.equal(resolved.mapLength, 2);
    const itemInputs = [];
    engine.computeItemKeys({ ...def, itemKeyInputs: (_index, inputs) => { itemInputs.push(inputs); return inputs; } }, params(), resolved);
    const beforeMapped = submissions.length;
    for (const [index, inputs] of itemInputs.entries()) {
      assert.equal(inputs.prompt.value, ['first duet', 'second duet'][index]);
      assert.equal(inputs.audio.assetId, [audio, secondAudio][index].assetId);
      assert.deepEqual(inputs.images.items, [images[1], images[0]]);
      await execute(inputs, { duration_from_audio: true });
    }
    assert.equal(submissions.length - beforeMapped, 2);
    assert.deepEqual(submissions.slice(-2).map((s) => s.media.find((m) => m.field === 'reference_audio_urls').assetIds), [[audio.assetId], [secondAudio.assetId]]);
    assert.ok(submissions.slice(-2).every((s) => JSON.stringify(s.media[0].assetIds) === JSON.stringify([images[1].assetId, images[0].assetId])));

    // Audio 1 is the single input when present, else the first shared audio. Durations use measured media, with
    // the same tolerance/clamping in the paid request and estimate, independently of the manually chosen duration.
    const automatic = { duration_from_audio: true, duration: 12 };
    for (const [seconds, expected] of [[2, 5], [5, 5], [7, 7], [7.004, 7], [7.02, 7], [7.021, 8], [14.99, 15], [15, 15]]) {
      const tone = await media('audio', { duration: seconds });
      const built = await plan({ audio: { ...tone, duration: 3 } }, automatic);
      assert.equal(built.input.duration, expected, 'Probe duration overrides stale metadata');
      assert.equal(built.estimateUsd, estimate({ audio: { ...tone, duration: seconds } }, automatic));
      assert.equal(built.estimateUsd, Math.round(expected * 0.08 * 1e6) / 1e6);
    }
    assert.ok(logs.includes('H3 reference duration from Audio 1: 7 s'));
    assert.equal((await plan({ audio, audios: list('audio', [secondAudio]) }, automatic)).input.duration, 7);
    assert.deepEqual((await plan({ audio, audios: list('audio', [secondAudio]) })).media[0].assetIds, [audio.assetId, secondAudio.assetId]);
    assert.equal((await plan({ audios: list('audio', [secondAudio, audio]) }, automatic)).input.duration, 5);
    assert.equal(estimate({ audios: list('audio', [secondAudio, audio]) }, automatic), 0.4);
    assert.equal(estimate({ audio: list('audio', [audio, secondAudio]) }, automatic), (0.56 + 0.4) / 2);
    assert.equal(estimate({ audio: list('audio', [audio, { ...secondAudio, duration: undefined }]) }, automatic), null);
    for (const duration of [null, undefined, 0, -1, NaN, Infinity]) {
      assert.equal(estimate({ audio: { ...audio, duration } }, automatic), null);
    }
    assert.equal(estimate({}, automatic, new Set(['audio'])), null);
    assert.equal(estimate({ audios: list('audio', [secondAudio]) }, automatic, new Set(['audio', 'audios'])), null, 'Unknown single audio takes priority over the known shared references');
    assert.equal(def.cost.estimate(undefined), null, 'The legacy estimator still tolerates unresolved parameters');
    assert.equal(estimate({}, automatic, new Set(['audios'])), null);
    assert.equal(estimate({}, automatic), 0.96);
    assert.equal((await plan({}, automatic)).input.duration, 12);
    assert.equal((await plan({}, automatic)).estimateUsd, 0.96);
    assert.equal((await plan({ audio }, { duration: 12 })).input.duration, 12);

    // The shared limits include both ports, and invalid inputs never reach the paid tool or a conversion.
    const refuses = async (inputs, raw, pattern, context = ctx) => {
      const paidBefore = submissions.length, convertedBefore = conversions.length;
      await assert.rejects(def.execute(context, { prompt, ...inputs }, params(raw)), pattern);
      assert.equal(submissions.length, paidBefore);
      assert.equal(conversions.length, convertedBefore);
    };
    const short = await media('audio', { duration: 1.9 });
    const long = await media('audio', { duration: 15.1 });
    await refuses({ audio: short }, {}, /audio: must be at least 2 s/);
    await refuses({ audio: long }, {}, /audio: must be at most 15 s/);
    await refuses({ audio, audios: list('audio', [audio, audio, audio]) }, {}, /audios: at most 3/);
    await refuses({ audio, audios: list('audio', [audio, secondAudio]) }, {}, /audios: together at most 15 s/);
    await refuses({ audio: secondAudio, images: list('image', Array(9).fill(images[0])), videos: list('video', Array(3).fill(video)) }, {}, /at most 12 files/);
    assert.deepEqual(def.validate(params(), { audio: { count: 1 }, audios: { count: 3 } }), ['audios: at most 3 are allowed']);
    assert.equal(def.validate(params(), { audio: { count: 1 }, images: { count: 9 }, videos: { count: 3 } }).length, 1);
    assert.deepEqual(def.validate(params(), { audio: { count: 1 }, audios: { count: 2 } }), []);

    // WAV and MP3 retain their exact asset/file bytes. Every other container is converted before the shared tool
    // sees any media, and only the new workflow WAV asset goes into reference_audio_urls.
    for (const ext of ['.wav', '.mp3', '.MP3']) {
      const tone = await media('audio', { ext, codec: ext === '.wav' ? 'pcm_s16le' : 'mp3' });
      const bytes = await fs.readFile(assets.assetFilePath(tone));
      const before = conversions.length;
      assert.deepEqual((await plan({ audio: tone })).media[0].assetIds, [tone.assetId]);
      assert.equal(conversions.length, before);
      assert.deepEqual(await fs.readFile(assets.assetFilePath(tone)), bytes);
    }
    for (const ext of ['.m4a', '.aac', '.mp4', '.mov', '.flac', '.mp3']) {
      const tone = await media('audio', { ext, codec: 'aac' });
      const bytes = await fs.readFile(assets.assetFilePath(tone));
      await execute({ audio: tone, audios: list('audio', [secondAudio]) }, automatic);
      const converted = savedWavs.at(-1), call = conversions.at(-1);
      assert.equal(call.binary, binaries.ffmpeg);
      assert.deepEqual(call.args.slice(0, -1), ['-y', '-i', assets.assetFilePath(tone), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le']);
      assert.equal(call.options.signal, ctx.signal);
      assert.equal(converted.sessionId, sessionId);
      assert.equal(converted.type, 'audio');
      assert.equal(converted.duration, 5);
      assert.match(converted.file, /\.wav$/);
      assert.notEqual(converted.assetId, tone.assetId);
      assert.deepEqual(submissions.at(-1).media[0].assetIds, [converted.assetId, secondAudio.assetId]);
      assert.deepEqual(await fs.readFile(assets.assetFilePath(tone)), bytes);
      assert.equal((await fs.readFile(assets.assetFilePath(converted))).toString(), 'RIFF-mock-pcm16-WAVE');
      await assert.rejects(fs.stat(path.dirname(call.args.at(-1))), { code: 'ENOENT' });
    }
    const m4a = await media('audio', { ext: '.m4a', codec: 'aac' });
    await execute({ audios: list('audio', [m4a]) });
    assert.deepEqual(submissions.at(-1).media[0].assetIds, [savedWavs.at(-1).assetId]);
    ffmpeg.binaries = () => ({ available: false });
    await refuses({ audio: m4a }, {}, /audio: m4a\/aac is not accepted.*install ffmpeg/);
    await refuses({ audio: { ...m4a, duration: undefined } }, automatic, /audio: m4a\/aac is not accepted.*install ffmpeg/);
    await refuses({ audios: list('audio', [m4a]) }, {}, /audios\[1\]: m4a\/aac is not accepted.*install ffmpeg/);
    await refuses({ audio, audios: list('audio', [m4a]) }, {}, /audios\[1\]: m4a\/aac is not accepted/);
    const unknown = { ...audio }; delete unknown.duration;
    await refuses({ audio: unknown }, automatic, /audio: duration could not be read/);
    assert.equal((await plan({ audio }, automatic)).input.duration, 7, 'Known metadata works without ffprobe');
    assert.equal((await plan({ audio })).input.duration, 5, 'Accepted formats still work without ffmpeg');
    ffmpeg.binaries = () => binaries;
    ffmpeg.runProcess = async () => { throw new Error('Conversion failed'); };
    const paidBeforeFailure = submissions.length;
    await assert.rejects(execute({ audio: m4a }), /Conversion failed/);
    assert.equal(submissions.length, paidBeforeFailure);
    const remaining = (await fs.readdir(store.sessionAssetDir(sessionId))).filter((file) => file.startsWith('.nodes-'));
    assert.deepEqual(remaining, [], 'Scratch directories are removed on success and failure');
  } finally {
    await app.cleanup();
  }
  console.log('test-fal-h3-reference-audio.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
