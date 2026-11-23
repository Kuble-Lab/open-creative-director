'use strict';

// The guest adapter is tested at the paid boundary: no model, provider or server is contacted. The short audio and cut checks use real ffmpeg
// when installed; the legacy cache key and long audio commands remain exact, and short cuts keep the original clip's first frames at full speed.
const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');
const { toneWav, wavSamples } = require('./support/explainer-media');
const { makeSong } = require('./support/hud-plan-fixtures');

async function main() {
  const iso = await createIsolatedApp({ loadServer: false, env: { OPENROUTER_API_KEY: '', GTS_API_TOKEN: '' } });
  try {
    const load = iso.load;
    const registry = load('lib/nodes/registry');
    const engine = load('lib/nodes/engine');
    const hud = load('lib/nodes/nodes-music-video-hud');
    const planner = load('lib/music-video-hud/plan');
    const edit = load('lib/music-video-edit');
    const plan = load('lib/music-video-plan');
    const nodes = load('lib/nodes/nodes-music-video');
    const assets = load('lib/nodes/assets');
    const { textValue, listValue } = load('lib/nodes/types');
    const def = registry.get('music_video.hud_plan');
    const params = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
    Object.assign(params, { model: 'mock', listen: false });
    const old = { ...def, inputs: def.inputs.filter((p) => !['guest', 'guest_image'].includes(p.id)), params: def.params.filter((p) => p.id !== 'guest') };
    const oldParams = { ...params }; delete oldParams.guest;
    const resolve = (definition, values, edges = [], output = {}) => engine.resolveNodeInputs({ node: { id: 'p' }, ports: { inputs: definition.inputs.filter((p) => !p.required) }, params: values, edges, outputsOf: () => output, maxListItems: 100 }).inputs;
    const baseline = { analysis: textValue('{}'), timing: textValue('{}'), figure: textValue('Lead') };
    const current = { ...baseline, ...resolve(def, params) };
    const before = { ...baseline, ...resolve(old, oldParams) };
    assert.deepEqual(current, before, 'the new optional unwired ports add no input fingerprint');
    assert.equal(engine.computeCacheKey(def, params, current), engine.computeCacheKey(old, oldParams, before), 'no guest: byte-identical legacy key');
    const wire = [{ from: { node: 'i', port: 'figure' }, to: { node: 'p', port: 'guest' } }];
    assert.deepEqual(resolve(def, params, wire), resolve(def, params), 'unselected influencer leaves no guest input');
    assert.equal(resolve(def, { ...params, guest: 'Field guest' }, wire).guest.value, 'Field guest');
    assert.equal(resolve(def, params, wire, { figure: textValue('Selected guest') }).guest.value, 'Selected guest');
    assert.equal(def.params.find((p) => p.id === 'guest').cacheOmitDefault, true);
    assert.equal(hud.hudPrices('mock', 0, 0).lipsync(1.5), hud.hudPrices('mock').lipsync(5.05), 'the film estimate prices the padded audio duration');
    assert.equal(hud.hudPlanValidate({}, { guest_image: { count: 7 } })[0].port, 'guest_image');
    assert.deepEqual(hud.hudPlanValidate({}, { guest_image: { count: 6 } }), []);

    const captured = []; const logs = []; const slices = [];
    const originalPlanner = planner.runPlanner; const originalSlice = nodes.sliceSong;
    planner.runPlanner = async (request) => {
      captured.push(request);
      const shots = [{ start: 0, end: 6, duration: 6, kind: 'performance', prompt: 'Lead', character: 'Lead' }, ...(request.guestText ? [{ start: 6, end: 7.5, duration: 1.5, kind: 'performance', voice: 'guest', character: 'Guest', prompt: 'Guest' }] : [])];
      return { plan: { shots: { shots }, performance: shots, story: [], still: [], graphics: { graphics: [] } }, grid: { units: shots.map((_s, index) => ({ index })), lines: [], duration: 9, stats: { units: shots.length, sung: shots.length, story: 0, still: 0, cuts: shots.length, cutsPerMinute: 20, ...(request.guestText ? { guestSung: 1, guestLipsyncSeconds: 5.05 } : {}) } }, content: { units: shots.map(() => ({ withFigure: true })) }, fallbacks: { units: [], lines: [] }, tries: [], leftOut: [], notes: [], board: 'board', sheetPrompt: 'lead sheet', ...(request.guestText ? { guestSheetPrompt: 'guest sheet' } : {}), brief: 'brief', attempts: 0, cost: { total: null }, costs: [] };
    };
    nodes.sliceSong = async (_ctx, _song, scenes) => { slices.push(scenes); return scenes.map((_s, i) => ({ type: 'audio', assetId: `audio-${i}` })); };
    const ctx = { config: {}, sessionId: 'test', log: (s) => logs.push(s) };
    const inputs = { ...baseline, song: { type: 'audio' } };
    try {
      const solo = (await def.execute(ctx, inputs, params)).variants[0];
      assert.ok(!('guest_sheet_prompt' in solo) && !('guest_sheet_refs' in solo));
      assert.ok(!('guestText' in captured[0]) && !('guest' in captured[0].options) && !('guestSheet' in captured[0].prices));
      const duet = (await def.execute(ctx, { ...inputs, guest: textValue('  NAME: Guest\nFULL: an adult singer  ') }, params)).variants[0];
      assert.equal(captured[1].guestText, 'NAME: Guest\nFULL: an adult singer');
      assert.equal(captured[1].options.guest, true);
      assert.equal(captured[1].guestSheetReferences, null);
      assert.equal(captured[1].prices.guestSheet, captured[1].prices.image);
      assert.equal(duet.guest_sheet_prompt.value, 'guest sheet');
      assert.ok(!('guest_sheet_refs' in duet));
      assert.deepEqual(duet.performance_prompts.items.map((v) => v.value), ['Lead', 'Guest']);
      assert.equal(duet.performance_audio.items.length, 2);
      assert.equal(slices[1][1].voice, 'guest');
      assert.ok(logs.some((s) => s.includes('1 guest sung units')));
      const own = Array.from({ length: 6 }, (_, i) => ({ type: 'image', sessionId: 'test', assetId: `i${i}`, file: `i${i}.png` }));
      const originalValue = assets.valueFromAsset; const originalPath = assets.assetFilePath;
      const image = path.join(iso.root, 'test.png'); await fsp.writeFile(image, 'image');
      assets.valueFromAsset = async (_session, id) => own.find((v) => v.assetId === id);
      assets.assetFilePath = () => image;
      try {
        const result = (await def.execute(ctx, { ...inputs, guest: textValue('Guest'), guest_image: listValue('image', own) }, params)).variants[0];
        assert.deepEqual(result.guest_sheet_refs.items, own.slice(0, 3));
        assert.deepEqual(captured[2].guestSheetReferences, { kind: 'own', count: 3 });
        assert.equal(captured[2].prices.guestSheet, hud.hudPrices('mock', 3).sheet);
        await assert.rejects(def.execute(ctx, { ...inputs, guest: textValue('Guest'), guest_image: listValue('image', [{ ...own[0], sessionId: 'foreign' }]) }, params), /guest_image:.*another workflow/);
        assets.valueFromAsset = async () => ({ type: 'image', file: 'bad.svg' });
        await assert.rejects(def.execute(ctx, { ...inputs, guest: textValue('Guest'), guest_image: listValue('image', [own[0]]) }, params), /guest_image:.*PNG, JPEG or WebP/);
      } finally { assets.valueFromAsset = originalValue; assets.assetFilePath = originalPath; }
    } finally { planner.runPlanner = originalPlanner; nodes.sliceSong = originalSlice; }

    // Estimate and execution must use the same guest grid and prompt identity, even when the guest comes from an upstream influencer.
    const originals = Object.fromEntries(['planGrid', 'userPrompt', 'systemPrompt', 'briefUserPrompt', 'briefSystemPrompt'].map((k) => [k, planner[k]]));
    const estimates = [];
    for (const k of Object.keys(originals)) planner[k] = (...args) => { estimates.push([k, args[0], args[2]]); return originals[k](...args); };
    try {
      const song = makeSong({ seconds: 30 });
      const model = Object.keys(load('lib/explainer-plan').PRICES_PER_MILLION)[0];
      hud.hudPlanEstimate({ ...params, model, guest: 'NAME: Guest\nFULL: an adult singer', brief: 'An idea' }, { inputs: { analysis: textValue(JSON.stringify(song.analysis)), timing: textValue(JSON.stringify(song.timing)), figure: textValue('Lead') } });
      assert.equal(estimates.find(([k]) => k === 'planGrid')[2].guest, true);
      assert.equal(estimates.find(([k]) => k === 'userPrompt')[1].guest.name, 'Guest');
      assert.equal(estimates.find(([k]) => k === 'briefSystemPrompt')[1].guest.name, 'Guest');
    } finally { Object.assign(planner, originals); }

    for (const seconds of [1.2, 1.5, 4.9]) {
      const shots = plan.parseShots({ shots: [{ start: 0, end: seconds, kind: 'performance', clip: 0, voice: 'guest', character: 'Guest', extra: true }] });
      assert.equal(shots.shots[0].voice, 'guest');
      const cut = edit.buildEditPlan({ shots, order: [1], infos: [{ audio: {}, duration: seconds }, { video: {}, duration: 6 }], params: { transition: 'cut', fps: 24, resolution: '720p', fade_out: 0 } });
      assert.equal(cut.spec.summary[0].speed, 1);
      assert.equal(cut.spec.frames, Math.round(seconds * 24));
      assert.doesNotMatch(cut.spec.graph, /setpts=[0-9.]+\*PTS|xfade/);
      const graphicsLib = load('lib/music-video-hud/graphics');
      const raw = { hud: { title: 'DUET' }, duration: seconds, cuts: [{ start: 0, end: seconds, kind: 'performance', voice: 'guest', character: 'Guest', unit: 0, subject: 'center', framing: 'CU', crop: { scale: 1.1 } }], lines: [{ start: 0, end: seconds, text: 'Not yet!', words: [{ start: 0.1, end: seconds - 0.1, text: 'Not yet!' }] }] };
      assert.doesNotThrow(() => hud.readGraphics(JSON.stringify(raw)));
      const { graphics: g, warnings } = graphicsLib.prepareGraphics(raw);
      assert.deepEqual(warnings, []);
      assert.equal(g.cuts.length, 1);
      assert.equal(g.cuts[0].kind, 'performance');
      assert.equal(g.cuts[0].end, Math.round(seconds * 24) / 24);
      const faces = load('lib/music-video-hud/faces').cutSamplesOf(g);
      assert.equal(faces.length, 3); assert.ok(faces.every((f) => f >= 0 && f < seconds * 24));
      const fx = load('lib/music-video-hud/effects');
      assert.deepEqual(fx.lipOf(g), [[0, Math.round(seconds * 24)]]);
      assert.ok(fx.quietOf(g).length, 'guest words get sung-word protection');
      assert.ok(graphicsLib.faceZone(g.cuts[0]), 'short sung cut keeps its face zone and punch-in');
      const state = load('lib/music-video-hud/state');
      assert.equal(state.frameState(g, seconds / 2).camera.scale, 1.1, 'short performance keeps its planned punch-in');
      for (let frame = 0; frame < Math.round(seconds * 24); frame++) assert.doesNotThrow(() => state.frameState(g, frame / 24));
    }
    const templates = load('lib/nodes/templates');
    for (const lang of ['en', 'de', 'es']) {
      const doc = templates.resolveTemplate('music-video-hud-guest', { lang });
      templates.validateTemplate(templates.loadTemplates().find((t) => t.id === 'music-video-hud-guest'));
      for (const id of ['n9', 'n10', 'n11']) assert.deepEqual(doc.graph.edges.filter((e) => e.to.node === id && e.to.port === 'images').map((e) => e.from.node), ['n5', 'n35']);
      assert.ok(doc.app.outputs.some((o) => o.node === 'n36' && o.approve === true));
      // The duet sheet has a required prompt: a missing guest is documented, not silently replaced with the lead's identity.
      const sheetDef = registry.get('image.generate');
      const sheetParams = registry.normalizeParams(sheetDef, doc.graph.nodes.find((n) => n.id === 'n35').params);
      const sheetEdges = doc.graph.edges.filter((e) => e.to.node === 'n35');
      assert.throws(() => engine.resolveNodeInputs({ node: { id: 'n35' }, ports: sheetDef, params: sheetParams, edges: sheetEdges, outputsOf: () => ({}), maxListItems: 100 }), (err) => err.code === 'OUTPUT_EMPTY');
    }
    const binaries = load('lib/ffmpeg').binaries();
    const min = plan.PERFORMANCE_MIN_SEC;
    for (const duration of [5.05, 6, 10]) assert.deepEqual(edit.sliceAudioArgs('/in', 12.3456, duration, '/out', min), edit.sliceAudioArgs('/in', 12.3456, duration, '/out'), 'long scenes: identical ffmpeg args');
    assert.doesNotMatch(edit.sliceAudioArgs('/in', 1, 1.5, '/out').join(' '), /apad/, 'non-guest slices stay unchanged');
    if (binaries.available) {
      const input = path.join(iso.root, 'song.wav'); const source = toneWav(12, 440); await fsp.writeFile(input, source);
      const ffmpeg = load('lib/ffmpeg');
      for (const start of [2.123, 10]) {
        const out = path.join(iso.root, `slice-${start}.wav`);
        await ffmpeg.runProcess(binaries.ffmpeg, edit.sliceAudioArgs(input, start, 1.5, out, min));
        const samples = wavSamples(await fsp.readFile(out)); const original = wavSamples(source);
        assert.equal(samples.length, Math.round(min * 44100));
        const at = Math.round(start * 44100); const end = Math.min(original.length - at, samples.length);
        assert.deepEqual(samples.slice(0, end), original.slice(at, at + end), 'sample-exact start and unaltered song samples');
        if (start === 10) assert.ok(samples.slice(end).every((v) => v === 0), 'silence after the song ends');
      }
      // At the adapter, only a guest asks for padding; both lists still use the same slice implementation.
      const originalPath = assets.assetFilePath; const originalScratch = assets.createScratchDir; const originalRemove = assets.removeScratchDir;
      assets.assetFilePath = () => input; assets.createScratchDir = async () => iso.root; assets.removeScratchDir = async () => {};
      const saved = [];
      try {
        await originalSlice({ sessionId: 'test', withLocalSlot: (fn) => fn(), saveOutputFile: async (value) => { saved.push(value); return value; } }, {}, [{ start: 10, end: 11.5, duration: 1.5, voice: 'guest' }, { start: 2, end: 8, duration: 6 }]);
        assert.ok(Math.abs(saved[0].duration - min) < 1 / 44100);
        assert.equal(saved[1].duration, 6);
      } finally { assets.assetFilePath = originalPath; assets.createScratchDir = originalScratch; assets.removeScratchDir = originalRemove; }
      const rawFrames = async (frames) => {
        const out = path.join(iso.root, `frames-${frames}.raw`);
        const { chain } = edit.sceneChain({ kind: 'performance', seconds: 6, frames, fps: 24, width: 160, height: 90, fit: 'crop' });
        await ffmpeg.runProcess(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=6', '-vf', chain, '-f', 'rawvideo', out]);
        return fsp.readFile(out);
      };
      const short = await rawFrames(36); const long = await rawFrames(144);
      assert.equal(short.length, 36 * 160 * 90 * 1.5);
      assert.deepEqual(short, long.subarray(0, short.length), 'a 1.5 s performance uses the original clip start, without slowdown or held frames');
    } else console.log('skipped real audio/cut checks: ffmpeg is not installed');
  } finally { await iso.cleanup(); }
  console.log('test-music-video-hud-guest.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
