'use strict';

// Exercise the deterministic duet planner and the mapped reference-video boundary without contacting a model or provider. Explicit empty
// lists skip paid generation; disabling duet scenes keeps the pre-duet outputs and parameter-only cache keys.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');
const { makeSong, goodAnswer, fullBrief } = require('./support/hud-plan-fixtures');
const { toneWav, wavSamples } = require('./support/explainer-media');

function exchange({ count = 12, gap = 0.3, only = null, overlap = false } = {}) {
  const song = makeSong({ seconds: 60 });
  song.analysis.energy.fill(0.7);
  song.analysis.sections = [{ name: 'Chorus', start: 0, end: 60, energy: 0.7 }];
  song.timing = { version: 1, lines: [], words: [] };
  let start = 2;
  for (let index = 0; index < count; index += 1) {
    const guest = only === 'guest' || (!only && index % 2 === 0);
    const words = ['We', 'keep', 'the', 'light'].map((text, at) => ({ text, start: start + at * 0.5, end: start + at * 0.5 + 0.4 }));
    const end = words[words.length - 1].end;
    song.timing.words.push(...words);
    song.timing.lines.push({ text: guest ? '(We keep the light)' : 'We keep the light', start, end, ...(guest ? { voice: 'choir' } : {}) });
    start = end + (overlap ? -0.2 : gap);
  }
  return song;
}

async function main() {
  const iso = await createIsolatedApp({ loadServer: false, env: { OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', GTS_API_TOKEN: '' } });
  try {
    const p = iso.load('lib/music-video-hud/plan');
    const hud = iso.load('lib/nodes/nodes-music-video-hud');
    const nodes = iso.load('lib/nodes/nodes-music-video');
    const registry = iso.load('lib/nodes/registry');
    const engine = iso.load('lib/nodes/engine');
    const { textValue, listValue } = iso.load('lib/nodes/types');
    const figure = p.parseFigure('NAME: Lead\nFULL: an adult man in a blue coat\nSHORT: a man in blue');
    const guest = p.parseFigure('NAME: Guest\nFULL: an adult woman in a red coat\nSHORT: a woman in red');
    const options = { guest: true, duetScenes: 'auto', lipsyncSecondsPerMinute: 60, motionShare: 0, maxUnits: 50 };
    const gridOf = (song, extra = {}) => p.planGrid(song.analysis, song.timing, { ...options, ...extra });
    const duetsOf = (grid) => grid.units.filter((unit) => unit.voice === 'duet');
    const song = exchange();
    for (const [start, voice] of [[35, null], [45, 'choir']]) {
      const words = Array.from({ length: 12 }, (_v, index) => ({ text: 'light', start: start + index * 0.5, end: start + index * 0.5 + 0.4 }));
      song.timing.words.push(...words);
      song.timing.lines.push({ text: words.map((word) => word.text).join(' '), start, end: words[words.length - 1].end, ...(voice ? { voice } : {}) });
    }
    const grid = gridOf(song);
    const duets = duetsOf(grid);
    assert.ok(duets.length >= 2, 'a long exchange splits at lyric boundaries');
    assert.equal(grid.stats.duetSung, duets.length);
    for (const unit of duets) {
      assert.ok(unit.duration >= 5 && unit.duration <= 15);
      assert.equal(new Set(unit.lines.map((at) => grid.lines[at].voice === 'choir' ? 'guest' : 'lead')).size, 2);
      for (const cut of unit.cuts) {
        assert.ok(cut.zoom <= 1.15);
        for (const edge of [cut.start, cut.end]) assert.ok(song.timing.words.every((word) => edge <= word.start + 0.001 || edge >= word.end - 0.001), 'no duet cut inside any timing word');
      }
      for (const solo of grid.units.filter((item) => item.kind === 'performance' && item.voice !== 'duet')) assert.ok(solo.end <= unit.start || solo.start >= unit.end);
    }
    assert.ok(grid.units.filter((unit) => unit.kind !== 'performance').every((unit) => unit.kind === 'still'), 'guest lines covered by duets do not force story clips');
    assert.equal(duetsOf(gridOf(exchange({ only: 'lead' }))).length, 0);
    assert.equal(duetsOf(gridOf(exchange({ only: 'guest' }))).length, 0);
    assert.equal(duetsOf(gridOf(exchange({ gap: 1.01 }))).length, 0, 'a gap over one second breaks the chain');
    assert.ok(duetsOf(gridOf(exchange({ overlap: true, count: 4 }))).length, 'overlapping singer entrances remain one exchange');
    for (const budget of [0, 4, 10, 22]) {
      const limited = gridOf(song, { lipsyncSecondsPerMinute: budget });
      assert.ok(limited.stats.lipsyncSeconds <= budget + 0.01, 'duets and solo windows share the seconds budget');
      if (budget < 5) assert.equal(duetsOf(limited).length, 0);
    }
    assert.ok(gridOf(song, { lipsyncSecondsPerMinute: 0 }).warnings.includes('NO_DUET_WINDOWS'));
    assert.ok(p.GRID_WARNING_LOGS.NO_DUET_WINDOWS);
    const capped = exchange({ count: 6 });
    capped.analysis.duration = 30;
    capped.analysis.sections[0].end = 30;
    const cappedGrid = gridOf(capped, { maxUnits: 6 });
    assert.ok(cappedGrid.units.length <= 6);
    assert.ok(duetsOf(cappedGrid).length <= 2, 'the shared window cap includes duet units');
    const unaligned = exchange();
    unaligned.timing.words.push({ text: 'unassigned', start: 1.3, end: 1.7 });
    for (const unit of duetsOf(gridOf(unaligned))) for (const edge of [unit.start, unit.end]) assert.ok(edge <= 1.3 || edge >= 1.7, 'timing-only words block window edges');
    const sameVoice = exchange({ count: 6 });
    sameVoice.timing.lines[1].voice = 'choir';
    assert.ok(duetsOf(gridOf(sameVoice)).some((unit) => unit.lines.includes(0) && unit.lines.includes(1)), 'consecutive lines of one singer can belong to an exchange');

    const user = p.userPrompt({ grid, figure, guest, brief: 'A stage' });
    assert.match(user, /performance \(duet\)/);
    assert.match(user, /side by side.*both faces and mouths/);
    assert.equal(p.systemPrompt({ guest, duetScenes: 'off' }), p.systemPrompt({ guest }));
    assert.equal(p.systemPrompt({ duetScenes: 'auto' }), p.systemPrompt());
    assert.match(p.systemPrompt({ guest, duetScenes: 'auto' }), /exception is a duet performance unit/);
    const answer = goodAnswer(grid, figure);
    const read = p.readData(answer, { grid, figure, guest });
    for (const unit of duets) {
      const entry = read.content.units[unit.index];
      assert.equal(entry.withFigure, true); assert.equal(entry.withLead, true); assert.equal(entry.withGuest, true);
      assert.ok(['MS', 'MCU'].includes(entry.framing));
      assert.ok(entry.plate.includes(guest.full) && entry.plate.includes(figure.full));
    }
    const { content } = p.completeContent(null, { grid, figure, guest, brief: 'A stage' });
    const looped = p.layoutLoop({ grid, content, figure, theme: 'hud', hudLanguage: 'en' });
    const plan = p.buildPlan({ grid, content, figure, guest, brief: 'A stage', looped });
    assert.equal(plan.duet.length, duets.length);
    assert.deepEqual(plan.shots.shots.filter((shot) => shot.voice === 'duet').map((shot) => shot.clip), duets.map((_u, index) => index));
    assert.deepEqual(plan.performance.map((shot) => shot.clip), plan.performance.map((_u, index) => index));
    assert.ok(plan.performance.length >= 2, 'solo clips keep their own contiguous row alongside duets');
    assert.ok(plan.performance.every((shot) => shot.voice !== 'duet'));
    assert.equal(plan.shots.performance, plan.performance.length);
    assert.equal(plan.shots.duet, plan.duet.length);
    assert.deepEqual(iso.load('lib/music-video-plan').parseShots(plan.shots).duet, plan.duet.length);
    const prices = hud.hudPrices('mock', 0, 0, true);
    const cost = p.estimateCost({ grid, settings: grid.settings, prices });
    assert.equal(cost.parts.plates, Math.round(prices.image * (grid.units.length - duets.length) * 10000) / 10000, 'duets use the sheets directly, with no scene-image charge');
    const rate = iso.load('lib/nodes/nodes-fal').PRICES.max['768P'];
    assert.equal(cost.parts.duet, Math.round(duets.reduce((sum, unit) => sum + rate * Math.ceil(unit.duration), 0) * 10000) / 10000);
    const board = p.boardText({ grid, content, figure, guest, plan, cost, settings: grid.settings, fallbacks: { units: [], lines: [], chapters: [] } });
    assert.ok(board.includes(`${grid.units.length - duets.length} plates`));
    assert.match(board, /SUNG \(DUET\)/); assert.match(board, /duet clips/); assert.match(board, /duet units \([\d.]+ s\)/);

    const lines = [
      { index: 0, text: '([Choir] Answer me.)', voice: 'choir', words: [{ start: 10, end: 12, text: 'Answer me.' }] },
      { index: 1, text: 'I am here.', words: [{ start: 12.85, end: 14, text: 'I am here.' }] },
      { index: 2, text: 'Keep the light.', words: [{ start: 14.2, end: 15, text: 'Keep the light.' }] }
    ];
    const request = { unit: { start: 10, end: 16, lines: [0, 1, 2] }, lines, figure, guest, scene: 'MS, [FIGURE] and [GUEST], blue stage, soft light', language: 'English' };
    const prompt = p.duetPrompt(request);
    assert.match(prompt, /<Subject 1> is an adult man in a blue coat in Image 1/);
    assert.match(prompt, /male voice \(S2\) and female voice \(S1\)/);
    assert.match(prompt, /<Subject 1> sings only \(S2\)/);
    assert.match(prompt, /At 00:00.000, <Subject 2> \(S1\)/);
    assert.match(prompt, /At 00:02.850, <Subject 2> closes her lips.*<Subject 1> \(S2\)/);
    assert.match(prompt, /At 00:04.200, <Subject 1> \(S2\)/);
    assert.match(prompt, /<d>\[English\] Answer me\.<\/d>/);
    assert.doesNotMatch(prompt, /\[Choir\]|\(Answer|\[FIGURE\]|\[GUEST\]/);
    assert.match(prompt, /\[Shot 1\] MS, <Subject 1> and <Subject 2>/);
    const leadFirst = p.duetPrompt({ ...request, lines: [{ ...lines[0], voice: undefined }, { ...lines[1], voice: 'choir' }], language: 'German' });
    assert.match(leadFirst, /male voice \(S1\) and female voice \(S2\)/); assert.match(leadFirst, /<d>\[German\]/);
    const neutral = { full: 'an adult singer', short: 'a singer', notes: [] };
    const neutralPrompt = p.duetPrompt({ ...request, figure: neutral, guest: neutral });
    assert.doesNotMatch(neutralPrompt, /\b(male|female|he|she|her|his)\b/);
    assert.match(neutralPrompt, /second voice \(S2\) and first voice \(S1\)/); assert.match(neutralPrompt, /closes their lips/);
    const conflict = p.duetPrompt({ ...request, guest: { ...neutral, full: 'a woman who uses he pronouns' } });
    assert.match(conflict, /the first voice in Audio 1/);
    // a short name such as "Gu" is not found inside the placeholders, and the set description ends in a full stop before the fixed sentences
    const short = p.duetPrompt({ ...request, figure: { ...figure, short: 'Gu' }, scene: 'MS, [FIGURE] and [GUEST] in a hall, Gu waits, no text.' });
    assert.ok(short.includes('[Shot 1] MS, <Subject 1> and <Subject 2> in a hall, <Subject 1> waits, no text. Both subjects stand side by side'), short);
    assert.ok(!/\[FI|EST\]/.test(short));
    const huge = p.duetPrompt({ ...request, figure: { ...figure, full: 'identity '.repeat(1000) }, guest: { ...guest, full: 'guest identity '.repeat(1000) }, scene: 'scene '.repeat(2000) });
    assert.ok(huge.length < 7000); assert.match(huge, /At 00:02.850/); assert.match(huge, /Answer me\./);
    assert.ok(p.duetPrompt({ ...request, scene: 'scene '.repeat(2000) }).length < 7000);
    assert.ok(p.duetPrompt({ ...request, figure: { ...figure, full: 'identity '.repeat(1000), short: '' } }).length < 7000);

    // Off and a missing guest leave every grid, model message, plan, board and price component exactly as before the option.
    const snapshot = (g, hasGuest) => {
      const args = { grid: g, figure, ...(hasGuest ? { guest } : {}), brief: 'A stage' };
      const c = p.completeContent(null, args).content;
      const l = p.layoutLoop({ ...args, content: c, theme: 'hud', hudLanguage: 'en' });
      const pl = p.buildPlan({ ...args, content: c, looped: l });
      const price = p.estimateCost({ grid: g, settings: g.settings, prices: hud.hudPrices('mock', 0, hasGuest ? 0 : null) });
      return JSON.stringify({ grid: g, user: p.userPrompt(args), system: p.systemPrompt(hasGuest ? { guest } : {}), plan: pl, cost: price,
        board: p.boardText({ ...args, content: c, plan: pl, cost: price, settings: g.settings, fallbacks: { units: [], lines: [], chapters: [] } }) });
    };
    assert.equal(snapshot(gridOf(song, { duetScenes: 'off' }), true), snapshot(gridOf(song, { duetScenes: undefined }), true));
    assert.equal(snapshot(gridOf(song, { guest: false }), false), snapshot(gridOf(song, { guest: false, duetScenes: undefined }), false));
    const def = registry.get('music_video.hud_plan');
    const params = registry.normalizeParams(def, { model: 'mock', listen: false });
    const legacy = { ...def, params: def.params.filter((param) => param.id !== 'duet_scenes') };
    const oldParams = { ...params }; delete oldParams.duet_scenes;
    const inputs = { song: { type: 'audio' }, figure: textValue(figure.full), analysis: textValue('{}'), timing: textValue('{}') };
    assert.equal(engine.computeCacheKey(def, params, inputs), engine.computeCacheKey(legacy, oldParams, inputs));
    const withGuest = { ...inputs, guest: textValue(guest.full) };
    assert.equal(engine.computeCacheKey(def, params, withGuest), engine.computeCacheKey(legacy, oldParams, withGuest));
    for (const id of ['music-video-hud', 'music-video-hud-elevenlabs', 'music-video-hud-suno', 'music-video-hud-suno-direct']) {
      const doc = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lib', 'nodes', 'templates', `${id}.json`), 'utf8'));
      const node = doc.graph.nodes.find((entry) => entry.type === def.type);
      assert.equal(engine.computeCacheKey(def, registry.normalizeParams(def, node.params), inputs),
        engine.computeCacheKey(legacy, registry.normalizeParams(legacy, node.params), inputs), `${id}: the default duet option preserves the saved planner key`);
    }
    assert.equal(def.params.find((param) => param.id === 'duet_scenes').cacheOmitDefault, true);
    assert.notEqual(engine.computeCacheKey(def, { ...params, duet_scenes: 'auto' }, inputs), engine.computeCacheKey(legacy, oldParams, inputs), 'engine limitation: non-default params cannot be omitted based on a missing guest input');

    const modelRequests = [];
    const actual = await p.runPlanner({ ...song, options, figureText: figure.raw, guestText: guest.raw, brief: fullBrief('Two singers share a stage'), prices,
      allowPlain: true, ask: async (request) => { modelRequests.push(request); return { text: JSON.stringify(answer), usd: 0 }; } });
    assert.match(modelRequests[0].system, /exception is a duet performance unit/);
    assert.match(modelRequests[0].prompt, /performance \(duet\)/);
    assert.equal(actual.plan.duet.length, duets.length);
    assert.equal(actual.plan.performance.length, plan.performance.length);

    const originalRun = p.runPlanner; const originalSlice = nodes.sliceSong;
    const slices = []; const requests = []; const logs = [];
    p.runPlanner = async (req) => {
      requests.push(req);
      const active = req.options.duetScenes === 'auto';
      const use = active ? (req.options.lipsyncSecondsPerMinute === 0 ? { ...plan, duet: [] } : plan) : { ...plan, duet: undefined };
      return { plan: use, grid: active ? grid : { ...grid, duetScenes: undefined }, content, fallbacks: { units: [], lines: [] }, leftOut: [], notes: [], tries: [], attempts: 0, cost, costs: [], board, brief: 'A stage', sheetPrompt: 'sheet', guestSheetPrompt: 'guest sheet' };
    };
    nodes.sliceSong = async (_ctx, _song, scenes) => { slices.push(scenes); return scenes.map((_scene, index) => ({ type: 'audio', assetId: `audio-${index}` })); };
    try {
      const ctx = { config: {}, sessionId: 'test', log: (text) => logs.push(text) };
      const result = (await def.execute(ctx, { ...inputs, guest: textValue(guest.full) }, { ...params, duet_scenes: 'auto' })).variants[0];
      assert.equal(requests[0].options.duetScenes, 'auto');
      assert.equal(result.duet_prompts.items.length, plan.duet.length); assert.equal(result.duet_audio.items.length, plan.duet.length);
      assert.equal(slices[1], plan.duet); assert.ok(logs.some((text) => /duet sung units/.test(text)));
      const empty = (await def.execute(ctx, inputs, { ...params, duet_scenes: 'auto' })).variants[0];
      assert.ok(!('duetScenes' in requests[1].options));
      assert.deepEqual(empty.duet_prompts.items, []); assert.deepEqual(empty.duet_audio.items, []);
      const noChain = (await def.execute(ctx, { ...inputs, guest: textValue(guest.full) }, { ...params, duet_scenes: 'auto', lipsync_seconds_per_minute: 0 })).variants[0];
      assert.deepEqual(noChain.duet_prompts.items, []); assert.deepEqual(noChain.duet_audio.items, []);
      const off = (await def.execute(ctx, inputs, { ...params, duet_scenes: 'off' })).variants[0];
      assert.ok(!('duet_prompts' in off) && !('duet_audio' in off), 'off preserves the previous output shape');
      assert.equal(engine.computeCacheKey(def, { ...params, duet_scenes: 'off' }, inputs), engine.computeCacheKey(def, params, inputs));
      const fal = registry.get('fal.h3_reference');
      const wires = [{ from: { node: 'planner', port: 'duet_prompts' }, to: { node: 'fal', port: 'prompt' } }];
      assert.equal(engine.resolveNodeInputs({ node: { id: 'fal' }, ports: fal, params: {}, edges: wires, outputsOf: () => empty, maxListItems: 100 }).mapLength, 0, 'auto without a guest skips paid generation');
      const mapped = engine.resolveNodeInputs({ node: { id: 'fal' }, ports: fal, params: {}, edges: wires, outputsOf: () => ({ duet_prompts: listValue('text', []) }), maxListItems: 100 });
      assert.equal(mapped.mapLength, 0, 'an explicit empty list would safely skip paid generation');
      const edit = registry.get('music_video.edit');
      const resolved = engine.resolveNodeInputs({ node: { id: 'edit' }, ports: { inputs: edit.inputs.filter((port) => port.id === 'duet') }, params: {}, edges: [{ from: { node: 'planner', port: 'duet_audio' }, to: { node: 'edit', port: 'duet' } }], outputsOf: () => ({}), maxListItems: 100 });
      assert.deepEqual(resolved.inputs, {}, 'the optional edit port tolerates absence');
    } finally { p.runPlanner = originalRun; nodes.sliceSong = originalSlice; }

    const ffmpeg = iso.load('lib/ffmpeg');
    const binaries = ffmpeg.binaries();
    if (binaries.available) {
      const assets = iso.load('lib/nodes/assets');
      const input = path.join(iso.root, 'song.wav'); const source = toneWav(30, 440); await fs.writeFile(input, source);
      const saved = [];
      const originals = [assets.assetFilePath, assets.createScratchDir, assets.removeScratchDir];
      assets.assetFilePath = () => input; assets.createScratchDir = async () => iso.root; assets.removeScratchDir = async () => {};
      try {
        await originalSlice({ sessionId: 'test', withLocalSlot: (fn) => fn(), saveOutputFile: async (value) => { saved.push({ ...value, bytes: await fs.readFile(value.sourceFile) }); return value; } }, {}, [{ start: 2, end: 8, duration: 6, voice: 'duet' }]);
        assert.equal(saved[0].duration, 6);
        assert.deepEqual(wavSamples(saved[0].bytes), wavSamples(source).slice(2 * 44100, 8 * 44100), 'duet WAV contains only the exact song interval, without padding');
      } finally { [assets.assetFilePath, assets.createScratchDir, assets.removeScratchDir] = originals; }
    }
  } finally { await iso.cleanup(); }
  console.log('test-music-video-hud-duet.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
