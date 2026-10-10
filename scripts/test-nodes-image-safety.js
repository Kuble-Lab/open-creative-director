'use strict';

// WP52b: safety retries, model-specific billing and partial list recovery without provider calls.
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const or = require('../lib/openrouter');
const gemini = require('../lib/gemini-images');
const costs = require('../lib/costs');
const budget = require('../lib/budget');
const access = require('../lib/access');
const discovery = require('../lib/discovery');
const generate = require('../lib/nodes/nodes-generate');
const assets = require('../lib/nodes/assets');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { fingerprint } = require('../lib/nodes/types');
const { createEngine, computeCacheKey } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');
const MODEL = 'google/gemini-nano-banana-2.1';
const FALLBACK = 'openai/gpt-image-2.5-flare';
const config = { imageModel: MODEL, imageModels: [MODEL] };
const png = Buffer.from('fake offline image');
const response = { data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 } };
const prompt = 'Claudia from the character sheet, in a scene that illustrates the sung line: "Claudia, Claudia, clone me again." Keep her face and blue jacket, soft light.';
const blocked = () => Object.assign(new Error('Google: Gemini could not generate an image (IMAGE_SAFETY)'), { code: 'GEMINI_IMAGE_BLOCKED', safetyBlocked: true, usage: { cost: 0.001 } });
const restores = [];
function patch(object, key, value) {
  const before = object[key];
  restores.push(() => { object[key] = before; });
  object[key] = value;
}
async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-image-safety-'));
  const registry = createRegistry();
  generate.registerAll(registry);
  // Literal keys from origin/main 38e7a8e protect saved workflows from new defaults or versions.
  const keys = {
    'image.generate': 'sha256:445c6c6611bdb5e94059401cd1688167a49725e66302c6a2e58c29dda08a3ddb',
    'image.edit': 'sha256:0d31dc3cbded461ad3c0c7843f1025e5049d30ab48aebfed4339745b34d097d8'
  };
  for (const [type, key] of Object.entries(keys)) {
    const def = registry.get(type);
    const inputs = { prompt: textValue('unchanged prompt'), images: listValue('image', [{ type: 'image', sessionId: 'session', assetId: 'reference' }]) };
    assert.equal(computeCacheKey(def, registry.normalizeParams(def, {}), inputs), key);
    assert.deepEqual(await def.cacheStamp({}, { config: { ...config, imageSafetyFallbackModel: '' } }), { imageModel: MODEL });
  }
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmp, registry, events: bus });
  const created = [];
  const journal = [];
  const calls = [];
  let answer;
  try {
    patch(global, 'fetch', async () => { throw new Error('Unexpected network'); });
    patch(gemini, 'accepts', () => false);
    patch(or, 'hasKey', () => true);
    patch(discovery, 'listImageModels', async () => ({ data: [] }));
    patch(costs, 'recordCost', async (entry) => { journal.push(entry); });
    patch(or, 'createImage', async (payload) => { calls.push(payload); return answer(payload); });
    const { workflow: base } = await wfStore.createWorkflow({ name: 'Safety', graph: { nodes: [], edges: [] } });
    created.push(base.id);
    const sessionId = base.sessionId;
    const ref = await assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'image', buffer: png, ext: '.png', prompt: 'reference' })).id);
    const logs = [];
    function ctx(options = {}) {
      const runtime = { ...config, ...options };
      return { sessionId, config: runtime, log: (line) => logs.push(line),
        toolCtx: { sessionId, config: runtime, user: 'test', emit() {} } };
    }
    async function run(type = 'image.edit', options = {}) {
      const def = registry.get(type);
      return def.execute(ctx(options), { prompt: textValue(prompt), images: listValue('image', [ref]) }, registry.normalizeParams(def, {}));
    }
    for (const provider of ['google', 'openrouter']) {
      patch(gemini, 'accepts', () => provider === 'google');
      patch(gemini, 'createImage', async (payload) => { calls.push(payload); return answer(payload); });
      for (const blocks of [1, 2, 3]) {
        calls.length = journal.length = logs.length = 0;
        answer = async () => { if (calls.length <= blocks) throw blocked(); return response; };
        const result = await run(blocks === 2 ? 'image.generate' : 'image.edit');
        assert.equal(calls.length, blocks + 1);
        assert.equal(calls[0].prompt, calls[1].prompt);
        if (blocks >= 2) {
          assert.doesNotMatch(calls[2].prompt, /clone|sung line/i);
          assert.match(calls[2].prompt, /Claudia from the character sheet/);
          assert.match(calls[2].prompt, /Keep her face and blue jacket, soft light/);
          assert.match(calls[2].prompt, /\. An adult, fully clothed, calm, non-violent\.$/);
        }
        const expectedModel = blocks === 3 ? FALLBACK : MODEL;
        assert.equal(calls.at(-1).model, expectedModel);
        assert.equal(result.cost.model, expectedModel);
        if (blocks === 3) {
          const value = result.variants[0].image;
          assert.equal(value.model, FALLBACK);
          assert.equal(value.imageSafetyFallback, true);
          const { model, imageSafetyFallback, ...plain } = value;
          assert.equal(fingerprint(value), fingerprint(plain), 'fallback metadata never changes downstream cache keys');
        }
        assert.equal(journal.at(-1).model, expectedModel);
        assert.equal(journal.length, blocks + 1, 'each reported attempt cost is booked');
        assert.ok(Math.abs(result.cost.usd - (0.04 + blocks * 0.001)) < 1e-9);
        assert.equal((await store.readLedger(sessionId)).at(-1).model, expectedModel);
        assert.ok(logs.some((line) => line.includes('recovered')));
        for (const call of calls) {
          assert.deepEqual(call.input_references, calls[0].input_references);
          assert.equal(call.aspect_ratio, calls[0].aspect_ratio);
        }
        if (blocks === 3) assert.equal(calls[3].prompt, calls[2].prompt);
      }
    }
    patch(gemini, 'accepts', () => false);
    assert.doesNotMatch(generate.softenImagePrompt('clone needle vein blood kill shoot drug naked klonen Nadel Vene Blut töten schiessen Drogen nackt clonar aguja vena sangre matar disparar droga desnuda'), /\b(clone|needle|vein|blood|kill|shoot|drug|naked|klonen|Nadel|Vene|Blut|töten|schiessen|Drogen|nackt|clonar|aguja|vena|sangre|matar|disparar|droga|desnuda)\b/i);
    // a picture without a person (the B-roll of the HUD) gets no person from the softening
    assert.match(generate.softenImagePrompt('WS, rows of empty mannequins, glass bursting on the beat. no text.'), /\. No people, calm, non-violent\.$/);
    assert.doesNotMatch(generate.softenImagePrompt('WS, rows of empty mannequins, glass bursting on the beat. no text.'), /adult|woman/i);
    assert.doesNotMatch(generate.softenImagePrompt("Claudia in a scene that illustrates the sung line: 'Claudia, clóname again.' Keep her jacket."), /clóname|sung line/i);
    calls.length = 0;
    answer = async () => { throw blocked(); };
    await assert.rejects(run('image.edit', { imageSafetyFallbackModel: '' }), (err) => err.code === 'IMAGE_SAFETY_EXHAUSTED' && /line:/.test(err.message) && err.data.attempts.length === 3);
    assert.equal(calls.length, 3);
    for (const err of [new Error('network'), new or.OpenRouterError('payment', 402), new or.OpenRouterError('bad request', 400), Object.assign(new Error('IMAGE_OTHER'), { code: 'GEMINI_IMAGE_BLOCKED', safetyBlocked: false })]) {
      calls.length = 0;
      answer = async () => { throw err; };
      await assert.rejects(run(), (caught) => caught === err);
      assert.equal(calls.length, 1);
    }

    calls.length = journal.length = 0;
    answer = async () => {
      if (calls.length === 1) throw new or.OpenRouterError('Refused', 400, JSON.stringify({
        promptFeedback: { blockReason: 'SAFETY' }, usage: { cost: 0.002 }
      }));
      return response;
    };
    await run();
    assert.equal(calls.length, 2, 'structured OpenRouter safety reason is recognized');
    assert.equal(journal[0].cost, 0.002, 'reported refusal cost in the error body is booked');

    // The fallback must reserve its own price, never the cheaper original estimate.
    const checks = [];
    patch(access, 'isRestricted', () => true);
    patch(budget, 'begin', async (_viewer, options) => {
      checks.push(options);
      return { applies: false, release() {} };
    });
    calls.length = 0;
    answer = async () => { if (calls.length <= 3) throw blocked(); return response; };
    await run('image.edit', { imageSafetyFallbackModel: 'google/gemini-3-pro-image' });
    assert.equal(checks.length, 4);
    assert.equal(checks.at(-1).estimateUsd, 0.134 + 0.00112);
    patch(budget, 'begin', async (_viewer, options) => {
      if (options.estimateUsd > 0.1) throw Object.assign(new Error('budget'), { status: 402 });
      return { applies: false, release() {} };
    });
    calls.length = 0;
    await assert.rejects(run('image.edit', { imageSafetyFallbackModel: 'google/gemini-3-pro-image' }), /budget/);
    assert.equal(calls.length, 3, 'no fallback call before budget approval');
    patch(access, 'isRestricted', () => false);

    // A single-slot engine proves that items waiting behind a safety failure still finish.
    registry.register({ type: 't.prompts', category: 'input', outputs: [{ id: 'text', type: 'text[]' }], params: [],
      execute: async () => ({ variants: [{ text: listValue('text', ['blocked', 'second', 'third'].map(textValue)) }] }) });
    const node = (id, type) => ({ id, type, typeVersion: 1, x: 0, y: 0, params: {} });
    const { workflow } = await wfStore.createWorkflow({ name: 'Partial safety', graph: {
      nodes: [node('p', 't.prompts'), node('g', 'image.generate')],
      edges: [{ id: 'e', from: { node: 'p', port: 'text' }, to: { node: 'g', port: 'prompt' } }]
    } });
    created.push(workflow.id);
    const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => config, limits: { parallel: 1 } });
    calls.length = 0;
    let deny = true;
    answer = async (payload) => { if (deny && payload.prompt.startsWith('blocked')) throw blocked(); return response; };
    const first = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'test' }));
    assert.equal(first.status, 'failed');
    assert.equal(first.nodes.g.code, 'IMAGE_SAFETY_EXHAUSTED');
    assert.match(first.nodes.g.message, /Item 1 of 3/);
    const partial = (await wfStore.readResults(workflow.id)).nodes.g.partial;
    assert.deepEqual(Object.keys(partial.items), ['1', '2']);
    const ids = Object.values(partial.items).map((item) => item.variant.image.assetId);
    const events = [];
    const unsubscribe = bus.subscribe(workflow.id, (event) => events.push(event));
    deny = false;
    calls.length = 0;
    const second = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'test' }));
    unsubscribe();
    assert.equal(second.status, 'completed');
    assert.ok(events.some((event) => event.label === 'Reused 2 of 3 unchanged items'));
    assert.equal(calls.length, 1, 'only the missing image runs again');
    const history = (await wfStore.readResults(workflow.id)).nodes.g.history[0];
    assert.deepEqual(history.variants[0].image.items.slice(1).map((item) => item.assetId), ids);
  } finally {
    while (restores.length) restores.pop()();
    for (const id of created) await wfStore.deleteWorkflow(id);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  console.log('test-nodes-image-safety.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
