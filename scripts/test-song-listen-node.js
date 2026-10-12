'use strict';

const assert = require('assert/strict');
const song = require('../lib/song-listen');
const nodes = require('../lib/nodes/nodes-music-video-hud');
const budget = require('../lib/budget');
const costs = require('../lib/costs');
const { registry, createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const engine = require('../lib/nodes/engine');
const { textValue } = require('../lib/nodes/types');
const { fullBrief, FIGURE_TEXT, makeSong } = require('./support/hud-plan-fixtures');

// Exercise the engine's run cap with the real HUD estimate, before any listening can start.
async function checkRunCap(params, inputs, withoutListening, withListening) {
  const local = createRegistry();
  let calls = 0;
  local.register({ type: 'test.song_plan', category: 'text', paid: true, inputs: [],
    params: [], outputs: [{ id: 'text', type: 'text' }],
    cost: { unit: 'usd', history: false, estimate: () => nodes.hudPlanEstimate(params, { inputs, connected: new Set(['analysis', 'timing']) }) },
    execute: async () => { calls++; return { variants: [{ text: textValue('planned') }], cost: { usd: withListening } }; }
  });
  const workflow = { id: 'w', rev: 1, sessionId: 's', graph: { nodes: [{ id: 'plan', type: 'test.song_plan', params: {} }], edges: [] } };
  const results = { nodes: {} };
  let record;
  const store = {
    getWorkflow: async () => ({ workflow, results }), readWorkflow: async () => workflow, readResults: async () => results,
    newRunId: () => 'r', writeRun: async (_id, run) => { record = JSON.parse(JSON.stringify(run)); },
    readRun: async () => record, pruneRuns: async () => {},
    appendHistory: async (_id, node, entry) => { entry = { ...entry, id: 'result' }; results.nodes[node] = { history: [entry], selected: { entry: 'result', variant: 0 } }; return { entry, node: results.nodes[node] }; }
  };
  const events = createEventBus();
  const runner = engine.createEngine({ registry: local, store, events });
  const approval = new Promise((resolve) => {
    const off = events.subscribe('w', (event) => { if (event.type === 'run_approval') { off(); resolve(event.approval); } });
  });
  const watchdog = setTimeout(() => { throw new Error('Song listening cost-cap test stalled'); }, 5000);
  try {
    await runner.start('w', { maxUsd: withoutListening });
    const blocked = await approval;
    assert.equal(calls, 0, 'the hearing surcharge blocks before paid execution');
    assert.equal(blocked.estimatedUsd, withListening);
    const finished = new Promise((resolve) => {
      const off = events.subscribe('w', (event) => { if (event.type === 'run_finished') { off(); resolve(); } });
    });
    await runner.resume('w', 'r', { maxUsd: withListening });
    await finished;
    assert.equal(calls, 1);
  } finally { clearTimeout(watchdog); }
}

async function main() {
  const def = registry.get('music_video.hud_plan');
  const params = registry.normalizeParams(def, { model: 'anthropic/claude-opus-5.5', brief: fullBrief('A lamp by the sea'), figure: FIGURE_TEXT });
  for (const id of ['listen', 'cuts_from_song']) {
    const param = def.params.find((p) => p.id === id);
    assert.deepEqual([param.kind, param.default, param.cacheOmitDefault], ['boolean', true, true]);
  }
  assert.deepEqual(def.params.find((p) => p.id === 'cuts_per_minute').showIf, { param: 'cuts_from_song', equals: false });
  const made = makeSong();
  const inputs = { analysis: textValue(JSON.stringify(made.analysis)), timing: textValue(JSON.stringify(made.timing)), song: { type: 'audio', sessionId: 'test-song', file: 'song.wav', assetId: 'test-audio' } };
  const { listen: _listen, cuts_from_song: _cuts, ...old } = params;
  assert.equal(engine.computeCacheKey(def, old, inputs), engine.computeCacheKey(def, params, inputs));
  for (const key of ['listen', 'cuts_from_song']) assert.notEqual(engine.computeCacheKey(def, params, inputs), engine.computeCacheKey(def, { ...params, [key]: false }, inputs));

  const saved = { hasKey: song.hasKey, compressAudio: song.compressAudio, listenSong: song.listenSong, begin: budget.begin, settle: budget.settle, recordCost: costs.recordCost };
  const events = [];
  try {
    song.hasKey = () => true;
    const context = { inputs, connected: new Set(['analysis', 'timing']) };
    const on = nodes.hudPlanEstimate({ ...params, cuts_from_song: false }, context);
    const off = nodes.hudPlanEstimate({ ...params, listen: false, cuts_from_song: false }, context);
    assert.ok(on && off);
    await checkRunCap({ ...params, cuts_from_song: false }, inputs, off.usd, on.usd);
    assert.ok(Math.abs(on.usd - off.usd - 2 * song.estimateUsd(made.analysis.duration)) < 0.00011);
    assert.ok(nodes.hudPlanEstimate(params, context).usd >= on.usd);
    assert.ok(nodes.hudPlanEstimate({ ...params, brief: 'A lamp' }, context).usd > nodes.hudPlanEstimate(params, context).usd);
    song.hasKey = () => false;
    assert.deepEqual(nodes.hudPlanEstimate({ ...params, cuts_from_song: false }, context), off);
    await assert.rejects(nodes.listenForPlan({}, inputs), (err) => err.summary === 'no GEMINI_API_KEY');
    song.hasKey = () => true;
    budget.begin = async (_viewer, options) => { events.push(['reserve', options]); return { key: 'hold-test', release: () => events.push(['release']) }; };
    budget.settle = (key, usd) => events.push(['settle', key, usd]);
    costs.recordCost = async (entry) => events.push(['book', entry]);
    song.compressAudio = async () => { events.push(['compress']); return { audio: Buffer.from('fake'), mime: 'audio/aac' }; };
    song.listenSong = async (options) => { events.push(['listen']); await options.onCost({ usd: 0.003, usage: null, model: 'fake-model' }); return { sound: {}, usd: 0.003 }; };
    const ctx = { sessionId: 'test-song', toolCtx: { budgetKey: 'run-test' }, signal: new AbortController().signal };
    const result = await nodes.listenForPlan(ctx, inputs);
    assert.equal(result.usd, 0.003);
    assert.deepEqual(events.map((e) => e[0]), ['reserve', 'compress', 'listen', 'book', 'settle', 'release']);
    assert.equal(events[0][1].estimateUsd, 2 * song.estimateUsd(made.analysis.duration));
    assert.equal(events[0][1].runKey, 'run-test');
    assert.equal(events[3][1].model, 'google/fake-model');
    assert.deepEqual(events[4], ['settle', 'run-test', 0.003]);
    events.length = 0;
    song.listenSong = async (options) => { await options.onCost({ usd: 0.003, model: 'fake-model' }); throw Object.assign(new Error('unusable'), { usd: 0.003 }); };
    await assert.rejects(nodes.listenForPlan(ctx, inputs), { message: 'unusable', usd: 0.003 });
    assert.equal(events.filter((e) => e[0] === 'book').length, 1);
    assert.equal(events.at(-1)[0], 'release');
    events.length = 0;
    budget.begin = async () => { throw Object.assign(new Error('budget exhausted'), { name: 'BudgetError' }); };
    await assert.rejects(nodes.listenForPlan(ctx, inputs), { name: 'BudgetError' });
    assert.deepEqual(events, [], 'no compression or paid call after budget refusal');
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(nodes.listenForPlan({ ...ctx, signal: stopped.signal }, inputs), { name: 'AbortError' });
    assert.deepEqual(events, []);
  } finally {
    for (const key of ['hasKey', 'compressAudio', 'listenSong']) song[key] = saved[key];
    budget.begin = saved.begin; budget.settle = saved.settle; costs.recordCost = saved.recordCost;
  }
  console.log('test-song-listen-node.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
