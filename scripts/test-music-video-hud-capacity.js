'use strict';

const assert = require('assert/strict');
const hud = require('../lib/music-video-hud/plan');
const plan = require('../lib/music-video-plan');
const { FIGURE_TEXT, makeSong, goodAnswer, scriptedModel } = require('./support/hud-plan-fixtures');

function cut(answer, index) {
  const text = JSON.stringify(answer, null, 2);
  const at = text.indexOf(`"index": ${index},`, text.indexOf('"units": ['));
  assert.ok(at > 0);
  return { reply: { text: text.slice(0, at + 30), finishReason: 'length' } };
}

async function main() {
  for (const seconds of [286, 300, 390]) {
    const song = makeSong({ seconds, seed: 3 });
    let failure;
    try { hud.planGrid(song.analysis, song.timing, { maxUnits: 50 }); } catch (err) { failure = err; }
    assert.equal(failure?.code, 'HUDPLAN_TOO_LONG');
    assert.ok(failure.data.needed > 50 && failure.data.needed <= 120);
    const retried = hud.planGrid(song.analysis, song.timing, { maxUnits: failure.data.needed });
    assert.ok(retried.units.length > 50 && retried.units.length <= failure.data.needed);
    assert.match(failure.message, new RegExp(`Set maximum units to at least ${failure.data.needed}`));
  }
  const huge = makeSong({ seconds: 1500, seed: 3 });
  assert.throws(() => hud.planGrid(huge.analysis, huge.timing, { maxUnits: 120 }), (err) => {
    assert.equal(err.code, 'HUDPLAN_TOO_LONG');
    assert.ok(err.data.needed > 120);
    assert.doesNotMatch(err.message, /Set maximum units|raise the units/);
    return true;
  });
  assert.equal(hud.RANGES.maxUnits[1], 120);
  const shots = { shots: Array.from({ length: 120 }, (_, i) => ({ start: i, end: i + 1, kind: 'story', clip: i })) };
  assert.equal(plan.parseShots(shots).story, 120);
  shots.shots.push({ start: 120, end: 121, kind: 'story', clip: 120 });
  assert.throws(() => plan.parseShots(shots), /At most 120/);
  assert.equal(plan.MAX_SCENES, 50);
  const registry = require('../lib/nodes/registry');
  const engine = require('../lib/nodes/engine');
  const definition = registry.get('music_video.hud_plan');
  const before = { ...definition, params: definition.params.map((param) => param.id === 'max_units' ? { ...param, max: 50 } : param) };
  for (const max_units of [6, 24, 50]) {
    const oldParams = registry.normalizeParams(before, { max_units });
    const newParams = registry.normalizeParams(definition, { max_units });
    assert.deepEqual(newParams, oldParams);
    assert.equal(engine.computeCacheKey(definition, newParams, {}), engine.computeCacheKey(before, oldParams, {}));
  }
  for (const id of ['story', 'performance', 'still_clips']) assert.equal(registry.get('music_video.edit').inputs.find((port) => port.id === id).max, 120);
  assert.equal(registry.normalizeParams(definition, { max_units: 121 }).max_units, 120);
  assert.equal(registry.normalizeParams(definition, {}).max_units, 50);

  const budget = (units, lines) => hud.planTokenBudget({ units: Array(units), lines: Array(lines) });
  assert.equal(budget(50, 35), 64000);
  assert.ok(budget(120, 35) > budget(50, 35));
  assert.ok(budget(80, 80) > budget(80, 35));
  assert.equal(budget(120, 400), 128000);

  const song = makeSong({ seconds: 286, seed: 3 });
  const options = { maxUnits: 120, cutsPerMinute: 40 };
  const grid = hud.planGrid(song.analysis, song.timing, options);
  assert.equal(grid.units.length, 120);
  assert.ok(grid.stats.story > 50);
  const figure = hud.parseFigure(FIGURE_TEXT);
  const full = goodAnswer(grid, figure, { brollShare: 0 });
  const model = scriptedModel([
    cut(full, 20),
    cut({ units: full.units.slice(20) }, 40),
    cut({ units: full.units.slice(40) }, 60),
    { units: full.units.slice(60), lines: full.lines, endcard: full.endcard }
  ]);
  const input = { ...song, figureText: FIGURE_TEXT, brief: 'A city of light and glass', brollShare: 0, options };
  const result = await hud.runPlanner({ ...input, ask: model.ask });
  assert.equal(model.calls.length, 4);
  assert.equal(result.fallbacks.units.length, 0);
  assert.equal(result.fallbacks.lines.length, 0);
  assert.equal(result.plan.shots.shots.length, grid.units.length);
  assert.ok(model.calls.every((call) => call.maxTokens === hud.planTokenBudget(grid)));
  assert.deepEqual(model.calls.map((call) => call.reasoningEffort), ['medium', 'low', 'low', 'low']);
  const stuck = scriptedModel([cut(full, 10)]);
  await assert.rejects(hud.runPlanner({ ...input, ask: stuck.ask }), { code: 'HUDPLAN_MODEL_FAILED' });
  assert.equal(stuck.calls.length, 2, 'no extra continuation without progress');
  const incremental = scriptedModel(Array.from({ length: hud.MAX_CONTINUATIONS + 2 }, (_, index) => cut({ ...full, units: full.units.slice(index) }, index + 1)));
  await assert.rejects(hud.runPlanner({ ...input, ask: incremental.ask }), { code: 'HUDPLAN_MODEL_FAILED' });
  assert.equal(incremental.calls.length, hud.MAX_CONTINUATIONS + 1, 'productive but tiny answers have a fixed ceiling');
  const parsed = plan.parseShots(result.plan.shots);
  const edit = require('../lib/music-video-edit').buildEditPlan({
    shots: parsed,
    order: parsed.shots.map((_, i) => i + 1),
    infos: [{ duration: 286, audio: {} }, ...parsed.shots.map((shot) => ({ video: { width: 1280, height: 720 }, duration: shot.duration }))],
    params: { fps: 24, resolution: '720p' }
  });
  assert.equal(edit.batches.length, 40);
  const graphics = require('../lib/music-video-hud/graphics').prepareGraphics(result.plan.graphics).graphics;
  assert.equal(graphics.cuts.length, grid.cuts.length);
  const chunks = require('../lib/music-video-hud/chunks').planChunks(graphics);
  assert.ok(chunks.every((chunk) => chunk.seconds <= 24));
  assert.equal(chunks[chunks.length - 1].endFrame, 286 * 24);
  console.log('test-music-video-hud-capacity.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
