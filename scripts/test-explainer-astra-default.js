'use strict';

// No network or render: default routing and the fixed Opus calibration must agree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config').DEFAULT_CONFIG;
const explainer = require('../lib/nodes/nodes-explainer');
const scene = require('../lib/nodes/nodes-explainer-video');
const plan = require('../lib/explainer-plan');
const assistant = require('../lib/nodes/assistant');
const or = require('../lib/openrouter');
const event = require('../lib/nodes/nodes-event-video');
const ASTRA = 'openai/gpt-6-astra';
const OPUS = 'anthropic/claude-opus-5.5';

assert.equal(explainer.DEFAULT_MODEL, ASTRA);
for (const settings of [config, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))]) {
  assert.equal(settings.defaultBrain, ASTRA);
  assert.deepEqual(settings.brainModels.slice(0, 2), [ASTRA, OPUS]);
}
assert.deepEqual(plan.PRICES_PER_MILLION[ASTRA], [10, 50]);
assert.deepEqual(plan.PRICES_PER_MILLION[OPUS], [4, 20]);
for (const [params, context, usd] of [
  [{}, {}, 0.25],
  [{ vision_check: false }, {}, 0.175],
  [{}, { inputs: { shots: { type: 'text', value: '{"visual_mode":"typography"}' } } }, 0.7],
  [{ vision_check: false }, { inputs: { shots: { type: 'text', value: '{"visual_mode":"typography"}' } } }, 0.625],
  [{ model: OPUS }, {}, 0.1],
  [{ model: OPUS, vision_check: false }, {}, 0.07],
  [{ model: 'anthropic/claude-sonnet-5.5' }, {}, 0.05]
]) assert.deepEqual(scene.sceneEstimate(params, context), { usd });
assert.equal(scene.sceneEstimate({}, { config: { restrictedBrainModels: [OPUS] } }), null);
assert.deepEqual(scene.sceneEstimate({}, { config: { restrictedBrainModels: [ASTRA] } }), { usd: 0.25 });
assert.equal(plan.estimateUsd({ model: ASTRA, pdfPages: 20, textChars: 30000, verify: true }), 1.53);
assert.equal(assistant.questionEstimateUsd({ model: ASTRA, prompt: 'x'.repeat(30000) }), 0.275);
assert.equal(assistant.questionEstimateUsd({ model: 'vendor/unpriced', prompt: 'x'.repeat(30000), choosable: [] }), 0.275);

const savedKey = or.hasKey;
try {
  or.hasKey = () => true;
  assert.equal(explainer.chooseModel({ config }, {}), ASTRA);
  assert.equal(explainer.chooseModel({ config }, { model: OPUS }), OPUS);
  const context = (entry) => ({ nodeId: 'plan', inputs: {}, results: { nodes: { plan: { history: [entry] } } } });
  const baseline = event.planEstimate({}, { inputs: {} });
  assert.ok(baseline.usd > 0.27 && baseline.usd < 0.29);
  assert.deepEqual(event.planEstimate({}, context({ params: { model: '' }, cost: { usd: 0.01 } })), baseline, 'an unidentified historical default is not an Astra measurement');
  assert.deepEqual(event.planEstimate({}, context({ params: { model: '' }, cost: { usd: 0.01, model: OPUS } })), baseline, 'a recorded Opus cost is not an Astra measurement');
  assert.deepEqual(event.planEstimate({}, context({ params: { model: '' }, cost: { usd: 0.3, model: ASTRA } })), { usd: 0.3 });
  const variants = [{ ai_switches: { type: 'text', value: JSON.stringify({ answer: { model: OPUS } }) } }];
  assert.deepEqual(event.planEstimate({}, context({ params: { model: '' }, cost: { usd: 0.01 }, variants })), baseline);
  assert.deepEqual(event.planEstimate({ model: OPUS }, context({ params: { model: OPUS }, cost: { usd: 0.1 } })), { usd: 0.1 }, 'an explicitly chosen historical Opus cost remains usable');
  or.hasKey = () => false;
  assert.equal(explainer.chooseModel({ config: { defaultBrain: 'chatgpt/example' } }, {}), 'chatgpt/example');
} finally {
  or.hasKey = savedKey;
}
for (const name of ['suno-song-pack', 'music-video-hud-suno']) {
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib/nodes/templates', `${name}.json`), 'utf8'));
  assert.equal(template.graph.nodes.find((node) => node.type === 'llm.chat').params.model, ASTRA);
}
// The HUD prices of the templates are checked in test-music-video-hud-template.js.
console.log('test-explainer-astra-default.js: ok');
