'use strict';

// Model choice of the image nodes (WP28): config.imageModels, the model lists of lib/image-models.js, image.generate and
// image.edit with a model of their own (hand-over to the tool, the list of the configuration as the only way in, limits
// of reference images per model, price per model, unknown is never 0), workflows without the param, the option lists
// of the server routes and the model list in the page (node-ui.js, run without a DOM). No provider is contacted: the
// image tool, the model list of OpenRouter and the cost journal are replaced and restored in `finally`.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const costs = require('../lib/costs');
const discovery = require('../lib/discovery');
const tools = require('../lib/tools');
const budget = require('../lib/budget');
const access = require('../lib/access');
const imageModels = require('../lib/image-models');
const { loadConfig, normaliseImageModels, DEFAULT_CONFIG } = require('../lib/config');
const assets = require('../lib/nodes/assets');
const generate = require('../lib/nodes/nodes-generate');
const nodesBasic = require('../lib/nodes/nodes-basic');
const graphLib = require('../public/nodes/graph');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const root = path.resolve(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_B64 = PNG.toString('base64');

const GPT = 'openai/gpt-image-2';
const NANO = 'google/gemini-3-pro-image';
const NANO_21 = 'google/gemini-nano-banana-2.1';
const ONE_REF = 'vendor/one-ref';
const TEXT_ONLY = 'vendor/text-only';
const NEEDS_REF = 'vendor/needs-ref';
const UNKNOWN_REFS = 'vendor/unknown-refs';
const NOT_LISTED = 'vendor/not-listed';

// The shape of GET https://openrouter.ai/api/v1/images/models (checked 2026-10-02), reduced to what matters here.
const entry = (id, name, { inputs = ['text', 'image'], references } = {}) => ({
  id,
  name,
  architecture: { input_modalities: inputs, output_modalities: ['image'] },
  supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] }, ...(references ? { input_references: { type: 'range', ...references } } : {}) }
});
const CATALOG = {
  data: [
    entry(GPT, 'OpenAI: GPT Image 2', { references: { min: 0, max: 16 } }),
    entry(NANO, 'Google: Nano Banana Pro (Gemini 3 Pro Image)', { references: { min: 0, max: 14 } }),
    entry(ONE_REF, 'Vendor: One Ref', { references: { min: 0, max: 1 } }),
    entry(TEXT_ONLY, 'Vendor: Text Only', { inputs: ['text'] }),
    entry(NEEDS_REF, 'Vendor: Needs Ref', { references: { min: 1, max: 1 } }),
    entry(UNKNOWN_REFS, 'Vendor: Unknown Refs')
  ]
};
const IMAGE_LIST = [GPT, NANO, ONE_REF, TEXT_ONLY, NEEDS_REF, UNKNOWN_REFS];
const CONFIG = { imageModel: GPT, imageModels: IMAGE_LIST, videoModel: 'bytedance/seedance-2.5', defaultBrain: 'vendor/default-brain' };

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

const text = (value) => ({ type: 'text', value });
const list = (of, items) => ({ type: 'list', of, items });
const imageResponse = (cost = 0.04) => ({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost } });

/* ---------- config ---------- */

function testConfig() {
  assert.deepEqual(DEFAULT_CONFIG.imageModels, [GPT, NANO, NANO_21]);
  // the model of imageModel always comes first, whatever the list says; duplicates and unusable entries are dropped
  assert.deepEqual(normaliseImageModels([NANO, GPT, NANO], GPT), [GPT, NANO]);
  assert.deepEqual(normaliseImageModels([NANO], 'vendor/other'), ['vendor/other', NANO]);
  assert.deepEqual(normaliseImageModels(['', 7, null, 'no-slash', 'has space/x', `vendor/${'x'.repeat(250)}`, ' vendor/ok '], GPT), [GPT, 'vendor/ok']);
  // missing or not a list: the default list (the operator did not choose)
  assert.deepEqual(normaliseImageModels(undefined, GPT), [GPT, NANO, NANO_21]);
  assert.deepEqual(normaliseImageModels('x/y', GPT), [GPT, NANO, NANO_21]);
  // an empty list is a choice: only the model of the configuration
  assert.deepEqual(normaliseImageModels([], GPT), [GPT]);
  const loaded = loadConfig();
  assert.ok(Array.isArray(loaded.imageModels) && loaded.imageModels[0] === loaded.imageModel, 'loadConfig puts imageModel first');
  assert.ok(new Set(loaded.imageModels).size === loaded.imageModels.length);
}

/* ---------- lib/image-models.js ---------- */

async function testModelLibrary() {
  imageModels.reset();
  // nothing read yet (or not readable): the profiles of the two models the app knows, everything else is unknown
  assert.deepEqual(imageModels.referenceLimits(GPT), { min: 0, max: 16 });
  assert.deepEqual(imageModels.referenceLimits(NANO), { min: 0, max: 14 });
  assert.equal(imageModels.referenceLimits(ONE_REF), null, 'unknown is not 0');
  assert.equal(imageModels.referenceLimits(''), null);
  assert.equal(imageModels.referenceLimits(undefined), null);

  let calls = 0;
  patch(discovery, 'listImageModels', async () => {
    calls += 1;
    return CATALOG;
  });
  await imageModels.load();
  assert.equal(calls, 1);
  // the list wins over the profile; a model the list does not name falls back to the profile, then to unknown
  assert.deepEqual(imageModels.referenceLimits(ONE_REF), { min: 0, max: 1 });
  assert.deepEqual(imageModels.referenceLimits(NEEDS_REF), { min: 1, max: 1 });
  assert.deepEqual(imageModels.referenceLimits(TEXT_ONLY), { min: 0, max: 0 }, 'no reference range and no image among the inputs: takes none');
  assert.equal(imageModels.referenceLimits(UNKNOWN_REFS), null, 'no range, images accepted: the list does not say');
  assert.equal(imageModels.referenceLimits(NOT_LISTED), null);
  assert.deepEqual(imageModels.referenceLimits(GPT), { min: 0, max: 16 });
  // a second read of the same payload changes nothing
  await imageModels.load();
  assert.equal(calls, 2);
  assert.deepEqual(imageModels.referenceLimits(ONE_REF), { min: 0, max: 1 });

  // names: the curated table of lib/result-meta.js, else the name of the list without the provider
  assert.equal(imageModels.displayName(GPT), 'GPT Image 2');
  assert.equal(imageModels.displayName(NANO), 'Nano Banana Pro');
  assert.equal(imageModels.displayName(ONE_REF), 'One Ref');
  assert.equal(imageModels.displayName(NOT_LISTED), 'not-listed');

  // prices: only where they are known, never 0
  assert.equal(imageModels.estimateUsd(NANO), 0.134);
  // Nano Banana 2.1 (2026-10-06): 14 references from the profile, 1120 tokens of a 1K image at 0.00003 USD = 0.0336, rounded up
  assert.deepEqual(imageModels.referenceLimits(NANO_21), { min: 0, max: 14 });
  assert.equal(imageModels.estimateUsd(NANO_21), 0.034);
  assert.equal(imageModels.displayName(NANO_21), 'Nano Banana 2.1');
  assert.equal(imageModels.isAllowed({ imageModel: GPT, imageModels: DEFAULT_CONFIG.imageModels }, NANO_21), true, 'on the default list');
  assert.equal(imageModels.estimateUsd(GPT), null, 'the price of GPT Image 2 depends on the quality the provider picks');
  assert.equal(imageModels.estimateUsd(ONE_REF), null);
  assert.equal(imageModels.estimateUsd(''), null);
  assert.equal(imageModels.estimateUsd(undefined), null);

  // the list of a node: imageModel first, then imageModels
  assert.deepEqual(imageModels.allowedModels({ imageModel: GPT, imageModels: [NANO, GPT] }), [GPT, NANO]);
  assert.deepEqual(imageModels.allowedModels({ imageModel: GPT }), [GPT]);
  assert.deepEqual(imageModels.allowedModels({}), []);
  assert.equal(imageModels.isAllowed(CONFIG, NANO), true);
  assert.equal(imageModels.isAllowed(CONFIG, NOT_LISTED), false);
  assert.equal(imageModels.isAllowed({ imageModel: NOT_LISTED, imageModels: [] }, NOT_LISTED), true, 'the model of the configuration is always allowed');
  assert.equal(imageModels.isAllowed(CONFIG, ''), false);

  // option lists: generate
  const generateList = await imageModels.options({ config: CONFIG });
  assert.deepEqual(generateList[0], { value: '', label: 'GPT Image 2', default: true }, 'the model of the configuration first, as the choice "no choice"');
  assert.deepEqual(generateList.map((item) => item.value), ['', GPT, NANO, ONE_REF, TEXT_ONLY, UNKNOWN_REFS], 'a model that needs a reference image is left out');
  assert.deepEqual(generateList.find((item) => item.value === NANO), { value: NANO, label: 'Nano Banana Pro', estimateUsd: 0.134 });
  assert.ok(generateList.every((item) => !('references' in item)), 'the generate list does not talk about references');
  assert.ok(generateList.filter((item) => item.value !== NANO && !item.default).every((item) => !('estimateUsd' in item)), 'no price, no field');

  // option lists: edit (a model that takes no reference is left out, the limit stops at the ceiling of the input)
  const editList = await imageModels.options({ config: CONFIG, edit: true, ceiling: 8 });
  assert.deepEqual(editList.map((item) => item.value), ['', GPT, NANO, ONE_REF, NEEDS_REF, UNKNOWN_REFS]);
  const refsOf = (value) => editList.find((item) => item.value === value).references;
  assert.deepEqual(refsOf(GPT), { max: 8, roles: [], required: false }, '16 at the provider, 8 at the input');
  assert.deepEqual(refsOf(NANO), { max: 8, roles: [], required: false });
  assert.deepEqual(refsOf(ONE_REF), { max: 1, roles: [], required: false });
  assert.equal(refsOf(UNKNOWN_REFS), undefined, 'unknown: no claim');
  assert.deepEqual(editList[0].references, { max: 8, roles: [], required: false }, 'the default entry says what the default model takes');

  // a configuration whose model is not in the list: the entry "no choice" names it
  const other = await imageModels.options({ config: { imageModel: 'vendor/not-listed', imageModels: [GPT] } });
  assert.deepEqual(other.map((item) => item.value), ['', 'vendor/not-listed', GPT]);
  assert.equal(other[0].label, 'not-listed');

  // an unreadable list: the profiles, and no new attempt for a minute
  imageModels.reset();
  calls = 0;
  patch(discovery, 'listImageModels', async () => {
    calls += 1;
    throw new Error('no network');
  });
  await imageModels.load();
  await imageModels.load();
  assert.equal(calls, 1, 'a failed read is not repeated at once');
  assert.deepEqual(imageModels.referenceLimits(NANO), { min: 0, max: 14 });
  const fallback = await imageModels.options({ config: CONFIG, edit: true, ceiling: 8 });
  assert.ok(fallback.some((item) => item.value === NANO), 'the list still works');
  assert.equal(calls, 1);

  // a slow list does not hold anything back; a late answer is ignored by this call
  imageModels.reset();
  patch(discovery, 'listImageModels', () => new Promise(() => {}));
  const started = Date.now();
  await imageModels.load({ timeoutMs: 40 });
  assert.ok(Date.now() - started < 2000, 'load() gives up');
  assert.deepEqual(imageModels.referenceLimits(GPT), { min: 0, max: 16 });
  imageModels.reset();
}

/* ---------- the nodes ---------- */

async function main() {
  testConfig();
  await testModelLibrary();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-image-models-'));
  const bus = createEventBus();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  generate.registerAll(registry);
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const created = [];
  const journal = [];
  try {
    const { workflow: base } = await wfStore.createWorkflow({ name: 'Image models', graph: { nodes: [], edges: [] } });
    created.push(base.id);
    const sessionId = base.sessionId;
    const upload = async () => assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'seed', cost: null })).id);
    const image1 = await upload();
    const image2 = await upload();
    const image3 = await upload();

    const payloads = [];
    function baseMocks() {
      patch(or, 'hasKey', () => true);
      patch(costs, 'recordCost', async (record) => {
        journal.push(record);
        return record;
      });
      patch(discovery, 'listImageModels', async () => CATALOG);
      patch(or, 'createImage', async (payload) => {
        payloads.push(payload);
        return imageResponse(0.04);
      });
      imageModels.reset();
      payloads.length = 0;
      journal.length = 0;
    }
    const makeCtx = (config = CONFIG) => {
      const controller = new AbortController();
      const runtime = { ...config };
      const toolEvents = [];
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: runtime,
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: runtime, user: 'tester', emit: (event) => toolEvents.push(event) },
        log() {},
        withLocalSlot: (fn) => fn(),
        toolEvents,
        controller
      };
    };
    const def = (type) => {
      const found = registry.get(type);
      assert.ok(found, `${type} is registered`);
      return found;
    };
    const run = (type, ctx, inputs, rawParams = {}) => def(type).execute(ctx, inputs, registry.normalizeParams(def(type), rawParams));
    const issuesOf = (type, rawParams, ports = {}) => {
      const node = def(type);
      return (node.validate(registry.normalizeParams(node, rawParams), ports) || []).map((issue) => (typeof issue === 'string' ? { message: issue } : issue));
    };

    /* ----- descriptors: ids stay, the model is a param, edit has a limit that follows it ----- */
    {
      baseMocks();
      for (const type of ['image.generate', 'image.edit']) {
        const node = def(type);
        assert.equal(node.category, 'image');
        assert.equal(node.paid, true);
        const model = node.params.find((param) => param.id === 'model');
        assert.equal(model.kind, 'select');
        assert.equal(model.default, '', 'no choice by default: the model of the configuration');
        assert.deepEqual(node.params.map((param) => param.id), ['model', 'prompt', 'aspect_ratio', 'count']);
        assert.equal(node.cost.history, false, 'the price is read per model, not from the last node of the type');
        assert.equal(typeof node.cost.estimate, 'function');
        assert.equal(typeof node.prepare, 'function');
        assert.doesNotMatch(node.label, /GPT/, 'neutral title');
      }
      assert.equal(def('image.generate').label, 'Generate image');
      assert.equal(def('image.edit').label, 'Edit image');
      assert.equal(def('image.generate').params[0].optionsSource, 'image-models');
      assert.equal(def('image.edit').params[0].optionsSource, 'image-edit-models');
      const images = def('image.edit').inputs.find((port) => port.id === 'images');
      assert.deepEqual(images.limitBy, { param: 'model', capability: 'references' });
      assert.equal(images.max, 8, 'the fixed maximum stays the ceiling');
      assert.equal(images.required, true);
      // WP50: image.generate takes optional reference images (the sheet of the HUD music video), limited by the model like image.edit
      const generateImages = def('image.generate').inputs.find((port) => port.id === 'images');
      assert.deepEqual([generateImages.limitBy, generateImages.max, Boolean(generateImages.required), generateImages.multiple], [{ param: 'model', capability: 'references' }, 4, false, true]);
      const descriptor = JSON.parse(JSON.stringify(registry.publicDescriptor(def('image.edit'))));
      assert.equal(descriptor.cost.hasEstimate, true);
      assert.deepEqual(descriptor.inputs.find((port) => port.id === 'images').limitBy, { param: 'model', capability: 'references' });
    }

    /* ----- image.generate: default, chosen model, hand-over to the tool ----- */
    {
      baseMocks();
      // an old workflow has no model param: the model of the configuration, the payload as it always was
      const ctx = makeCtx();
      const oldParams = registry.normalizeParams(def('image.generate'), { prompt: 'x', aspect_ratio: '9:16', count: 2 });
      assert.equal(oldParams.model, '');
      const old = await def('image.generate').execute(ctx, { prompt: text('A coffee cup') }, oldParams);
      assert.equal(payloads.length, 2);
      assert.deepEqual(payloads[0], { model: GPT, prompt: 'A coffee cup', n: 1, aspect_ratio: '9:16' });
      assert.equal(old.variants.length, 2);
      assert.deepEqual(journal.map((record) => record.model), [GPT, GPT]);

      // a chosen model reaches the provider and the journal; the configuration itself is not touched
      payloads.length = 0;
      journal.length = 0;
      const chosenCtx = makeCtx();
      const chosen = await run('image.generate', chosenCtx, { prompt: text('A coffee cup') }, { model: NANO, aspect_ratio: '16:9' });
      assert.deepEqual(payloads, [{ model: NANO, prompt: 'A coffee cup', n: 1, aspect_ratio: '16:9' }]);
      assert.equal(journal.length, 1);
      assert.equal(journal[0].model, NANO, 'the cost line names the model that made the image');
      assert.equal(chosenCtx.config.imageModel, GPT, 'config.imageModel is not changed by a node');
      assert.equal(chosenCtx.toolCtx.config.imageModel, GPT);
      const ledger = await store.readLedger(sessionId);
      assert.equal(ledger.find((item) => item.id === chosen.variants[0].image.assetId).model, NANO, 'the asset remembers its model');
      assert.ok(Math.abs(chosen.cost.usd - 0.04) < 1e-9);

      // the model of the configuration written out is the same as no choice
      payloads.length = 0;
      await run('image.generate', makeCtx(), { prompt: text('x') }, { model: GPT });
      assert.equal(payloads[0].model, GPT);

      // another configured model is what "no choice" means
      payloads.length = 0;
      await run('image.generate', makeCtx({ ...CONFIG, imageModel: NANO }), { prompt: text('x') });
      assert.equal(payloads[0].model, NANO);

      // only the list of the configuration: a workflow from somebody else cannot name any model of the provider
      payloads.length = 0;
      journal.length = 0;
      const outsider = await run('image.generate', makeCtx(), { prompt: text('x') }, { model: NOT_LISTED }).catch((err) => err);
      assert.ok(outsider instanceof Error);
      assert.equal(outsider.code, 'IMAGE_MODEL_NOT_ALLOWED');
      assert.deepEqual(outsider.data, { model: NOT_LISTED });
      assert.match(outsider.message, /not on the list of this server/);
      assert.equal(payloads.length, 0, 'the provider was not called');
      assert.equal(journal.length, 0, 'nothing was booked');
      // the model of the configuration is allowed without being listed
      await run('image.generate', makeCtx({ imageModel: NOT_LISTED, imageModels: [] }), { prompt: text('x') }, { model: NOT_LISTED });
      assert.equal(payloads[0].model, NOT_LISTED);
      // an aborted run does not start work
      const aborted = makeCtx();
      aborted.controller.abort();
      payloads.length = 0;
      await assert.rejects(run('image.generate', aborted, { prompt: text('x') }, { model: NANO }), { name: 'AbortError' });
      assert.equal(payloads.length, 0);
    }

    /* ----- what the tool gets to know about the price (the budget of a participant reserves it) ----- */
    {
      baseMocks();
      const seen = [];
      const realExecute = tools.executeTool;
      patch(tools, 'executeTool', (ctx, name, args) => {
        seen.push({ name, imageEstimateUsd: ctx.imageEstimateUsd, model: ctx.config.imageModel });
        return realExecute(ctx, name, args);
      });
      await run('image.generate', makeCtx(), { prompt: text('x') }, { model: NANO });
      await run('image.generate', makeCtx(), { prompt: text('x') }, { model: GPT });
      await run('image.generate', makeCtx(), { prompt: text('x') });
      await run('image.edit', makeCtx(), { prompt: text('x'), images: list('image', [image1]) }, { model: NANO });
      assert.deepEqual(seen, [
        { name: 'generate_image', imageEstimateUsd: 0.134, model: NANO },
        { name: 'generate_image', imageEstimateUsd: undefined, model: GPT },
        { name: 'generate_image', imageEstimateUsd: undefined, model: GPT },
        { name: 'edit_image', imageEstimateUsd: 0.134, model: NANO }
      ], 'a known price goes along, an unknown one is not passed (never 0)');
      // the configured model counts too: Nano Banana Pro as the standard reserves its price
      seen.length = 0;
      await run('image.generate', makeCtx({ ...CONFIG, imageModel: NANO }), { prompt: text('x') });
      assert.equal(seen[0].imageEstimateUsd, 0.134);

      // A balance that covers the base price must refuse a call with three references.
      const originalBegin = budget.begin;
      const originalRestricted = access.isRestricted;
      try {
        access.isRestricted = () => true;
        budget.begin = async (_viewer, { estimateUsd }) => {
          assert.ok(Number.isFinite(estimateUsd), `budget estimate: ${estimateUsd}`);
          if (estimateUsd > 0.135) throw new Error('BUDGET_INSUFFICIENT');
          return budget.NOOP_GRANT;
        };
        payloads.length = 0;
        await assert.rejects(run('image.generate', makeCtx(), { prompt: text('x'), images: list('image', [image1, image2, image3]) }, { model: NANO }), /BUDGET_INSUFFICIENT/);
        assert.equal(payloads.length, 0, 'the budget refuses before the provider is called');
        assert.equal(seen.at(-1).imageEstimateUsd, 0.13736);
        await run('image.generate', makeCtx(), { prompt: text('x') }, { model: NANO });
        assert.equal(payloads.length, 1, 'without references the same balance covers the unchanged base price');
        assert.equal(seen.at(-1).imageEstimateUsd, 0.134);
      } finally {
        budget.begin = originalBegin;
        access.isRestricted = originalRestricted;
      }
      // the tool reserves what it is told, and nothing else
      assert.equal(tools.toolEstimateUsd('generate_image', { prompt: 'x' }, { imageEstimateUsd: 0.134 }), 0.134);
      assert.equal(tools.toolEstimateUsd('edit_image', {}, { imageEstimateUsd: 0.134 }), 0.134);
      assert.equal(tools.toolEstimateUsd('generate_image', { prompt: 'x' }, {}), null, 'the chat knows no price: anything left is enough');
      assert.equal(tools.toolEstimateUsd('generate_image', { prompt: 'x' }, null), null);
      assert.equal(tools.toolEstimateUsd('generate_image', { prompt: 'x' }, { imageEstimateUsd: Number.NaN }), null);
      assert.equal(tools.toolEstimateUsd('generate_image', { prompt: 'x' }, { imageEstimateUsd: -1 }), null);
    }

    /* ----- image.edit: the model sets the limit of reference images ----- */
    {
      baseMocks();
      await imageModels.load();
      const portOf = (params) => registry.portsFor(def('image.edit'), params).inputs.find((port) => port.id === 'images');
      assert.deepEqual(portOf({ model: ONE_REF }).limit, { known: true, max: 1, roles: [], required: false, subject: 'One Ref' });
      assert.equal(portOf({ model: ONE_REF }).max, 1);
      assert.equal(portOf({ model: NANO }).max, 8, 'never above the fixed maximum');
      assert.equal(portOf({ model: NANO }).limit.known, true);
      assert.deepEqual(portOf({ model: UNKNOWN_REFS }).limit, { known: false });
      assert.equal(portOf({ model: UNKNOWN_REFS }).max, 8, 'unknown: the fixed maximum');
      assert.deepEqual(portOf({ model: NOT_LISTED }).limit, { known: false });
      assert.deepEqual(portOf({}).limit, { known: false }, 'no choice: the server cannot tell, the run checks the configured model');
      assert.equal(portOf({}).max, 8);
      assert.equal(portOf({ model: TEXT_ONLY }).max, 0);

      // validation before the run
      assert.deepEqual(issuesOf('image.edit', { model: ONE_REF }, { images: { connected: true, count: 1 } }), []);
      const over = issuesOf('image.edit', { model: ONE_REF }, { images: { connected: true, count: 2 } });
      assert.equal(over.length, 1);
      assert.deepEqual([over[0].code, over[0].port, over[0].data], ['too_many_refs', 'images', { model: 'One Ref', max: 1, count: 2 }]);
      assert.match(over[0].message, /model One Ref accepts at most 1 reference images \(got 2\)/);
      assert.deepEqual(issuesOf('image.edit', { model: UNKNOWN_REFS }, { images: { connected: true, count: 8 } }), [], 'unknown limit: no issue');
      assert.deepEqual(issuesOf('image.edit', {}, { images: { connected: true, count: 8 } }), [], 'no choice: no issue before the run');
      assert.deepEqual(issuesOf('image.edit', { model: NANO }, { images: { connected: true, count: 8 } }), []);
      // more than the fixed maximum keeps the old message and is not reported twice
      const tooMany = issuesOf('image.edit', { model: ONE_REF }, { images: { connected: true, count: 9 } });
      assert.equal(tooMany.length, 1);
      assert.match(tooMany[0].message, /at most 8 images/);
      assert.equal(issuesOf('image.edit', {}, { images: { connected: true, count: 9 } }).length, 1);
      assert.deepEqual(issuesOf('image.edit', {}, {}), []);

      // at run time: the model really used decides
      const edit = (config, rawParams, items) => run('image.edit', makeCtx(config), { prompt: text('Make it blue'), images: list('image', items) }, rawParams);
      payloads.length = 0;
      await edit(CONFIG, { model: ONE_REF }, [image1]);
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].model, ONE_REF);
      assert.equal(payloads[0].input_references.length, 1);
      payloads.length = 0;
      const refused = await edit(CONFIG, { model: ONE_REF }, [image1, image2]).catch((err) => err);
      assert.equal(refused.code, 'TOO_MANY_REFERENCES');
      assert.deepEqual(refused.data, { model: 'One Ref', max: 1, count: 2 });
      assert.match(refused.message, /Model One Ref accepts at most 1 reference images \(got 2\)/);
      assert.equal(payloads.length, 0, 'refused before the provider is called');
      // without a choice the configured model is checked
      const configured = await edit({ ...CONFIG, imageModel: ONE_REF }, {}, [image1, image2]).catch((err) => err);
      assert.equal(configured.code, 'TOO_MANY_REFERENCES');
      assert.equal(payloads.length, 0);
      // a model that takes none
      const none = await edit({ ...CONFIG, imageModel: TEXT_ONLY }, {}, [image1]).catch((err) => err);
      assert.equal(none.code, 'TOO_MANY_REFERENCES');
      assert.match(none.message, /takes no reference images \(got 1\)/);
      // unknown limit: the fixed maximum is the only limit
      payloads.length = 0;
      await edit(CONFIG, { model: UNKNOWN_REFS }, [image1, image2, image3]);
      assert.equal(payloads[0].input_references.length, 3);
      await assert.rejects(edit(CONFIG, { model: UNKNOWN_REFS }, Array(9).fill(image1)), /at most 8/);
      // the listed models of the configuration only
      payloads.length = 0;
      const outsider = await edit(CONFIG, { model: NOT_LISTED }, [image1]).catch((err) => err);
      assert.equal(outsider.code, 'IMAGE_MODEL_NOT_ALLOWED');
      assert.equal(payloads.length, 0);
      // GPT Image 2 as before: 8 images, no aspect ratio on "auto"
      payloads.length = 0;
      await edit(CONFIG, {}, [image1, image2, image3]);
      assert.deepEqual(Object.keys(payloads[0]).sort(), ['input_references', 'model', 'n', 'prompt']);
      assert.equal(payloads[0].model, GPT);
      // relight still uses the model of the configuration
      payloads.length = 0;
      await run('image.relight', makeCtx({ ...CONFIG, imageModel: NANO }), { image: image1 }, { light: 'candle' });
      assert.equal(payloads[0].model, NANO);
    }

    /* ----- image.generate with reference images (WP50): the call of image.edit with the aspect ratio of the node; without them the call of before ----- */
    {
      baseMocks();
      await imageModels.load();
      const generateWith = (config, rawParams, items) => run('image.generate', makeCtx(config), { prompt: text('A portrait'), ...(items ? { images: list('image', items) } : {}) }, rawParams);
      payloads.length = 0;
      await generateWith(CONFIG, { model: NANO, aspect_ratio: '3:4' }, [image1, image2, image3]);
      assert.equal(payloads.length, 1);
      assert.deepEqual(Object.keys(payloads[0]).sort(), ['aspect_ratio', 'input_references', 'model', 'n', 'prompt']);
      assert.deepEqual([payloads[0].model, payloads[0].prompt, payloads[0].aspect_ratio, payloads[0].input_references.length], [NANO, 'A portrait', '3:4', 3]);
      assert.ok(payloads[0].input_references.every((item) => item.type === 'image_url' && /^data:image\/png;base64,/.test(item.image_url.url)));
      // no images: the payload of before, without references
      payloads.length = 0;
      await generateWith(CONFIG, { model: NANO, aspect_ratio: '3:4' }, null);
      assert.deepEqual(payloads[0], { model: NANO, prompt: 'A portrait', n: 1, aspect_ratio: '3:4' });
      // the limits: of the input and of the model
      await assert.rejects(generateWith(CONFIG, { model: UNKNOWN_REFS }, Array(5).fill(image1)), /at most 4/);
      payloads.length = 0;
      const refusedGenerate = await generateWith(CONFIG, { model: ONE_REF }, [image1, image2]).catch((err) => err);
      assert.equal(refusedGenerate.code, 'TOO_MANY_REFERENCES');
      assert.equal(payloads.length, 0);
      assert.deepEqual(issuesOf('image.generate', { model: ONE_REF }, { images: { connected: true, count: 2 } }).map((issue) => issue.code), ['too_many_refs']);
      assert.deepEqual(issuesOf('image.generate', { model: NANO }, { images: { connected: true, count: 3 } }), []);
      assert.deepEqual(issuesOf('image.generate', {}, {}), []);
      assert.match(issuesOf('image.generate', {}, { images: { connected: true, count: 5 } })[0].message, /at most 4 images/);
      // the estimate: each reference image adds its input tokens; the count is known once the node before has run, the most the input takes until then
      const estimateGenerate = (rawParams, context) => def('image.generate').cost.estimate(registry.normalizeParams(def('image.generate'), rawParams), context);
      assert.equal(imageModels.referenceUsd(NANO), 0.00112);
      assert.equal(imageModels.referenceUsd(NANO_21), 0.00084);
      assert.equal(imageModels.referenceUsd(GPT), null);
      assert.deepEqual(estimateGenerate({ model: NANO }, { config: CONFIG, connected: new Set(['prompt']), inputs: {} }), { usd: 0.134 }, 'nothing connected: the price of before');
      assert.deepEqual(estimateGenerate({ model: NANO }, { config: CONFIG, connected: new Set(['images']), inputs: { images: list('image', [image1, image2, image3]) } }), { usd: 0.13736 });
      assert.deepEqual(estimateGenerate({ model: NANO }, { config: CONFIG, connected: new Set(['images']), inputs: {} }), { usd: 0.13848 }, 'not known yet: four');
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, { config: { ...CONFIG, imageModels: [...CONFIG.imageModels, NANO_21] }, connected: new Set(['images']), inputs: { images: list('image', [image1, image2, image3]) } }), { usd: 0.03652 }, 'the sheet of the HUD: 0.034 USD and three references');
      assert.equal(estimateGenerate({ model: GPT }, { config: CONFIG, connected: new Set(['images']), inputs: {} }), null);
      const historical = {
        config: CONFIG,
        workflow: { graph: { nodes: [{ id: 'earlier', type: 'image.generate' }] } },
        results: { nodes: { earlier: { history: [{ createdAt: '2026-10-10', params: { count: 1 }, cost: { usd: 0.034, model: NANO_21 } }] } } },
        connected: new Set(['images']),
        inputs: { images: list('image', [image1, image2, image3]) }
      };
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, historical), { usd: 0.03652 }, 'a historical base price still gets the references');
      assert.deepEqual(estimateGenerate({ model: NANO_21, count: 2 }, historical), { usd: 0.07304 }, 'the surcharge follows the variant count');
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, { ...historical, inputs: {} }), { usd: 0.03736 }, 'unknown references still use four with history');
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, { ...historical, connected: new Set() }), { usd: 0.034 }, 'unconnected history stays unchanged');
      const withReferences = await generateWith(CONFIG, { model: NANO }, [image1, image2, image3]);
      assert.equal(withReferences.cost.referenceCount, 3, 'the history records its reference count');
      historical.results.nodes.earlier.history[0].cost = { usd: 0.03652, model: NANO_21, referenceCount: 3 };
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, historical), { usd: 0.03652 }, 'recorded references are not charged twice in the estimate');
      assert.deepEqual(estimateGenerate({ model: NANO_21 }, { ...historical, inputs: { images: list('image', [image1]) } }), { usd: 0.03484 }, 'the next reference count replaces the historical one');

    }

    /* ----- estimates per model ----- */
    {
      baseMocks();
      const estimate = (type, rawParams, context) => {
        const node = def(type);
        return node.cost.estimate(registry.normalizeParams(node, rawParams), context);
      };
      const history = (type, nodeId, entries) => ({
        workflow: { graph: { nodes: [{ id: nodeId, type }] } },
        results: { nodes: { [nodeId]: { history: entries } } }
      });
      const done = (params, usd, createdAt) => ({ createdAt, params, cost: { usd } });
      // list price of a model that has one
      assert.deepEqual(estimate('image.generate', { model: NANO }, { config: CONFIG }), { usd: 0.134 });
      assert.deepEqual(estimate('image.generate', { model: NANO, count: 3 }, { config: CONFIG }), { usd: 0.402 });
      assert.deepEqual(estimate('image.edit', { model: NANO, count: 2 }, { config: CONFIG }), { usd: 0.268 });
      // no choice: the price of the configured model
      assert.deepEqual(estimate('image.generate', {}, { config: { ...CONFIG, imageModel: NANO } }), { usd: 0.134 });
      // unknown stays unknown (null, never 0)
      assert.equal(estimate('image.generate', {}, { config: CONFIG }), null, 'GPT Image 2: no price known before a run');
      assert.equal(estimate('image.generate', { model: GPT }, { config: CONFIG }), null);
      assert.equal(estimate('image.generate', { model: ONE_REF }, { config: CONFIG }), null);
      assert.equal(estimate('image.generate', {}, undefined), null);
      assert.equal(estimate('image.edit', { model: NOT_LISTED }, {}), null);

      // the last cost of the same model in the workflow wins, scaled to the number of variants
      const entries = [
        done({ model: GPT, count: 2 }, 0.2, '2026-10-01T10:00:00Z'),
        done({ model: GPT, count: 2 }, 0.3, '2026-10-02T10:00:00Z'),
        done({ model: NANO, count: 1 }, 0.14, '2026-10-02T11:00:00Z'),
        done({ count: 4 }, 0.16, '2026-10-02T09:00:00Z'),
        done({ model: GPT, count: 1 }, 0, '2026-10-02T12:00:00Z'),
        { createdAt: '2026-10-02T13:00:00Z', params: { model: GPT, count: 1 }, cost: {} }
      ];
      const context = { ...history('image.generate', 'n1', entries), config: CONFIG };
      assert.ok(Math.abs(estimate('image.generate', { model: GPT, count: 1 }, context).usd - 0.15) < 1e-9, 'newest cost of this model, per variant');
      assert.ok(Math.abs(estimate('image.generate', { model: GPT, count: 4 }, context).usd - 0.6) < 1e-9);
      assert.ok(Math.abs(estimate('image.generate', { model: NANO, count: 1 }, context).usd - 0.14) < 1e-9, 'an actual cost is better than the list price');
      assert.ok(Math.abs(estimate('image.generate', {}, context).usd - 0.15) < 1e-9, 'no choice = the configured model (GPT Image 2): the same history as the explicit choice');
      assert.ok(Math.abs(estimate('image.generate', {}, { ...context, config: { ...CONFIG, imageModel: NANO } }).usd - 0.14) < 1e-9, 'saved workflows without a model param count as the configured model');
      assert.equal(estimate('image.generate', { model: ONE_REF }, context), null, 'the cost of another model says nothing about this one');
      assert.deepEqual(estimate('image.generate', { model: ONE_REF }, { ...context, config: CONFIG }), null);
      // an explicit choice of the configured model shares the history of the default entry (an empty param counts as the configured model)
      const shared = { ...history('image.generate', 'n1', [done({ count: 2 }, 0.1, '2026-10-02T10:00:00Z')]), config: CONFIG };
      assert.ok(Math.abs(estimate('image.generate', { model: GPT, count: 1 }, shared).usd - 0.05) < 1e-9, 'explicit GPT Image 2 = configured model');
      assert.ok(Math.abs(estimate('image.generate', {}, shared).usd - 0.05) < 1e-9);
      assert.equal(estimate('image.generate', { model: NANO }, shared).usd, 0.134, 'another model: its list price');
      // the entry knows the model it really ran with: after a change of the configuration the default entry follows the new model
      const ranGpt = history('image.generate', 'n1', [{ createdAt: '2026-10-02T10:00:00Z', params: { model: '', count: 1 }, cost: { usd: 0.04, model: GPT } }]);
      assert.deepEqual(estimate('image.generate', {}, { ...ranGpt, config: { ...CONFIG, imageModel: NANO } }), { usd: 0.134 }, 'priced for the new configured model');
      assert.ok(Math.abs(estimate('image.generate', { model: GPT }, { ...ranGpt, config: { ...CONFIG, imageModel: NANO } }).usd - 0.04) < 1e-9, 'an explicit choice of the old model finds the run');
      assert.ok(Math.abs(estimate('image.generate', {}, { ...ranGpt, config: CONFIG }).usd - 0.04) < 1e-9);
      // another node type does not count
      assert.equal(estimate('image.edit', { model: GPT }, { ...history('image.generate', 'n1', entries), config: CONFIG }), null);
      // a node of the same type elsewhere in the workflow does
      const second = { workflow: { graph: { nodes: [{ id: 'a', type: 'image.edit' }, { id: 'b', type: 'image.edit' }] } }, results: { nodes: { b: { history: [done({ model: NANO, count: 2 }, 0.3, '2026-10-02T10:00:00Z')] } } }, config: CONFIG };
      assert.ok(Math.abs(estimate('image.edit', { model: NANO }, second).usd - 0.15) < 1e-9);
    }

    /* ----- reference counts survive the engine and workflow history ----- */
    {
      baseMocks();
      registry.register({
        type: 'test.figure_refs', category: 'image', label: 'Test references', inputs: [], outputs: [{ id: 'images', type: 'image[]' }], params: [],
        execute: async (ctx) => {
          const images = [];
          for (let i = 0; i < 3; i++) images.push(await assets.valueFromAsset(ctx.sessionId, (await store.saveAsset(ctx.sessionId, { kind: 'image', buffer: PNG, ext: '.png' })).id));
          return { variants: [{ images: list('image', images) }] };
        }
      });
      const { workflow } = await wfStore.createWorkflow({ name: 'Reference history', graph: {
        nodes: [
          { id: 'refs', type: 'test.figure_refs', typeVersion: 1, x: 0, y: 0, params: {} },
          { id: 'sheet', type: 'image.generate', typeVersion: 1, x: 300, y: 0, params: { model: NANO, prompt: 'Portrait', count: 2 } }
        ],
        edges: [{ id: 'refs-sheet', from: { node: 'refs', port: 'images' }, to: { node: 'sheet', port: 'images' } }]
      } });
      created.push(workflow.id);
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => CONFIG });
      const record = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'tester' }));
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      const results = await wfStore.readResults(workflow.id);
      assert.equal(results.nodes.sheet.history[0].cost.referenceCount, 3);
      const cached = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(cached.nodes.sheet.itemEstimate.usd, 0.08, 'the recorded two-variant cost already includes its references');
      const next = await engine.plan(workflow.id, { mode: 'all', force: true });
      assert.equal(next.nodes.sheet.estimate.usd, 0.08224, 'forcing the upstream node reserves four unknown references instead of the recorded three');
    }

    /* ----- engine: plan, run, cache and the hand-over of the configuration ----- */
    {
      baseMocks();
      let listReads = 0;
      patch(discovery, 'listImageModels', async () => {
        listReads += 1;
        return CATALOG;
      });
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => CONFIG, limits: { jobPollMs: 20 } });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow } = await wfStore.createWorkflow({
        name: 'Two models',
        graph: {
          nodes: [
            node('p', 'input.text', { text: 'a cup of coffee' }),
            node('g1', 'image.generate', { model: NANO, count: 2 }, 300),
            node('g2', 'image.generate', {}, 300),
            node('o', 'output.result', { label: 'Stills' }, 600)
          ],
          edges: [edge('e1', 'p', 'text', 'g1', 'prompt'), edge('e2', 'p', 'text', 'g2', 'prompt'), edge('e3', 'g1', 'image', 'o', 'inputs'), edge('e4', 'g2', 'image', 'o', 'inputs')]
        }
      });
      created.push(workflow.id);
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.deepEqual(plan.nodes.g1.estimate, { usd: 0.268 }, 'Nano Banana Pro: list price per image, two variants');
      assert.equal(plan.nodes.g2.estimate, null, 'GPT Image 2: unknown, not 0');
      assert.equal(plan.totals.unknownNodes, 1);
      assert.ok(Math.abs(plan.totals.usd - 0.268) < 1e-9);
      assert.ok(listReads >= 1, 'the plan reads the model list first (prepare)');

      const record = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'tester' }));
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.deepEqual(payloads.map((payload) => payload.model).sort(), [NANO, NANO, GPT]);
      assert.deepEqual(journal.map((item) => item.model).sort(), [NANO, NANO, GPT]);

      // after the run the actual costs speak, per model
      const after = await engine.plan(workflow.id, { mode: 'all', force: true });
      assert.ok(Math.abs(after.nodes.g1.estimate.usd - 0.08) < 1e-9, 'the last cost of the node (2 x 0.04)');
      assert.ok(Math.abs(after.nodes.g2.estimate.usd - 0.04) < 1e-9);

      // the history keeps the model each run really used (an empty model param does not say which one it was)
      const stored = await wfStore.readResults(workflow.id);
      assert.equal(stored.nodes.g1.history[0].cost.model, NANO);
      assert.equal(stored.nodes.g2.history[0].cost.model, GPT, 'the default entry ran with the configured model');
      assert.equal(stored.nodes.g2.history[0].params.model, '');
      // the operator changes the configured model: the default entry is priced for the new model, not by the old run
      const { workflow: plain } = await wfStore.createWorkflow({ name: 'Default only', graph: { nodes: [node('d1', 'image.generate', { prompt: 'a lamp' })], edges: [] } });
      created.push(plain.id);
      assert.equal((await engine.whenFinished(plain.id, await engine.start(plain.id, { mode: 'all', user: 'tester' }))).status, 'completed');
      assert.equal((await wfStore.readResults(plain.id)).nodes.d1.history[0].cost.model, GPT);
      assert.ok(Math.abs((await engine.plan(plain.id, { mode: 'all', force: true })).nodes.d1.estimate.usd - 0.04) < 1e-9, 'still the configured model: its last cost');
      const switched = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({ ...CONFIG, imageModel: NANO }), limits: { jobPollMs: 20 } });
      const switchedPlan = await switched.plan(plain.id, { mode: 'all', force: true });
      assert.deepEqual(switchedPlan.nodes.d1.estimate, { usd: 0.134 }, 'list price of Nano Banana Pro, not the 0.04 of the earlier GPT run');

      // a changed model is a new result (the cache key follows the params)
      const current = await wfStore.readWorkflow(workflow.id);
      await wfStore.saveGraph(workflow.id, { baseRev: current.rev, graph: { ...current.graph, nodes: current.graph.nodes.map((item) => (item.id === 'g2' ? { ...item, params: { model: NANO } } : item)) } });
      payloads.length = 0;
      const second = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all', user: 'tester' }));
      assert.equal(second.status, 'completed');
      assert.deepEqual(payloads.map((payload) => payload.model), [NANO], 'only the changed node runs again');

      // a model from outside the list fails the node with the code, nothing is paid
      payloads.length = 0;
      const { workflow: bad } = await wfStore.createWorkflow({
        name: 'Outside',
        graph: { nodes: [node('b1', 'image.generate', { prompt: 'x', model: NOT_LISTED })], edges: [] }
      });
      created.push(bad.id);
      const badRun = await engine.whenFinished(bad.id, await engine.start(bad.id, { mode: 'all', user: 'tester' }));
      assert.equal(badRun.status, 'failed');
      assert.equal(badRun.nodes.b1.status, 'error');
      assert.equal(badRun.nodes.b1.code, 'IMAGE_MODEL_NOT_ALLOWED');
      assert.deepEqual(badRun.nodes.b1.data, { model: NOT_LISTED });
      assert.equal(payloads.length, 0);
    }

    /* ----- engine: a limit that follows the model refuses the run before anything is paid ----- */
    {
      baseMocks();
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => CONFIG, limits: { jobPollMs: 20 } });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow } = await wfStore.createWorkflow({
        name: 'Two references',
        graph: {
          nodes: [
            node('t', 'input.text', { text: 'merge them' }),
            node('i1', 'input.image', {}, 0),
            node('i2', 'input.image', {}, 0),
            node('e', 'image.edit', { model: ONE_REF }, 300)
          ],
          edges: [edge('e1', 't', 'text', 'e', 'prompt'), edge('e2', 'i1', 'image', 'e', 'images'), edge('e3', 'i2', 'image', 'e', 'images')]
        }
      });
      created.push(workflow.id);
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      const limited = plan.issues.find((issue) => issue.code === 'too_many_refs');
      assert.ok(limited, JSON.stringify(plan.issues));
      assert.deepEqual([limited.nodeId, limited.port, limited.data], ['e', 'images', { model: 'One Ref', max: 1, count: 2 }]);
      assert.equal(plan.valid, false);
      await assert.rejects(engine.start(workflow.id, { mode: 'all', user: 'tester' }), (err) => err.code === 'INVALID_GRAPH' && err.issues.some((issue) => issue.code === 'too_many_refs'));
      assert.equal(payloads.length, 0);
      // the same graph with a model that takes two is fine
      const current = await wfStore.readWorkflow(workflow.id);
      await wfStore.saveGraph(workflow.id, { baseRev: current.rev, graph: { ...current.graph, nodes: current.graph.nodes.map((item) => (item.id === 'e' ? { ...item, params: { model: NANO } } : item)) } });
      assert.equal((await engine.plan(workflow.id, { mode: 'all' })).issues.some((issue) => issue.code === 'too_many_refs'), false);
    }

    /* ----- option lists of the server routes ----- */
    {
      baseMocks();
      const { app } = require('../server');
      const layers = app._router.stack.filter((item) => item.route);
      const handler = layers.find((item) => item.route.path === '/api/nodes/options/:source' && item.route.methods.get).route.stack.slice(-1)[0].handle;
      const call = (source) =>
        new Promise((resolve, reject) => {
          const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
          Promise.resolve(handler({ params: { source }, query: {}, headers: {} }, res)).catch(reject);
        });
      const configured = loadConfig();
      const generateOptions = await call('image-models');
      assert.equal(generateOptions.status, 200);
      assert.equal(generateOptions.body.options[0].value, '');
      assert.equal(generateOptions.body.options[0].default, true);
      assert.deepEqual(generateOptions.body.options.slice(1).map((item) => item.value), configured.imageModels.filter((id) => {
        const limits = imageModels.referenceLimits(id);
        return !limits || limits.min === 0;
      }));
      const nano = generateOptions.body.options.find((item) => item.value === NANO);
      if (nano) assert.equal(nano.estimateUsd, 0.134);
      const editOptions = await call('image-edit-models');
      assert.equal(editOptions.status, 200);
      assert.ok(editOptions.body.options.every((item) => !item.references || item.references.max <= 8), 'the ceiling of the input');
      assert.ok(editOptions.body.options[0].default === true);
      // the registry serves the nodes with the new params
      const registryHandler = layers.find((item) => item.route.path === '/api/nodes/registry' && item.route.methods.get).route.stack.slice(-1)[0].handle;
      const served = await new Promise((resolve, reject) => {
        const res = { json: resolve, status() { return this; } };
        Promise.resolve(registryHandler({ params: {}, query: {}, headers: {} }, res)).catch(reject);
      });
      assert.deepEqual(served.nodeTypes.find((item) => item.type === 'image.edit').params.map((param) => param.id), ['model', 'prompt', 'aspect_ratio', 'count']);
    }

    /* ----- the page: the lists, the default entry, prices, limits of the chosen model ----- */
    {
      const storage = new Map([['vcd-lang', 'de']]);
      const load = (lang, api) => {
        storage.set('vcd-lang', lang);
        const window = {
          document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
          navigator: { language: 'de-CH' },
          localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
          OCDNodes: { graph: graphLib, api }
        };
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
        vm.runInNewContext(fs.readFileSync(path.join(root, 'public/nodes/node-ui.js'), 'utf8'), { window, document: window.document, setTimeout, clearTimeout }, { filename: 'public/nodes/node-ui.js' });
        return window.OCDNodes.ui;
      };
      const serverList = {
        options: [
          { value: '', label: 'GPT Image 2', default: true, references: { max: 8, roles: [], required: false } },
          { value: GPT, label: 'GPT Image 2', references: { max: 8, roles: [], required: false } },
          { value: NANO, label: 'Nano Banana Pro', estimateUsd: 0.134, references: { max: 8, roles: [], required: false } },
          { value: ONE_REF, label: 'One Ref', references: { max: 1, roles: [], required: false } },
          { value: UNKNOWN_REFS, label: 'Unknown Refs' }
        ]
      };
      const requested = [];
      const detailRequests = [];
      const api = {
        options: async (source) => {
          requested.push(source);
          return serverList;
        },
        higgsfieldModel: async (id) => {
          detailRequests.push(id);
          throw new Error('not a Higgsfield model');
        }
      };
      for (const lang of ['de', 'en', 'es']) {
        const ui = load(lang, api);
        const plain = (value) => JSON.parse(JSON.stringify(value)); // objects of the vm have another prototype
        const normal = plain(ui.normalizeOptions(serverList));
        assert.deepEqual(normal[0], { value: '', label: 'GPT Image 2', references: { max: 8, roles: [], required: false }, default: true });
        assert.equal(normal[2].estimateUsd, 0.134);
        assert.equal(normal[4].references, undefined);
        assert.deepEqual(plain(ui.normalizeOptions({ options: [{ value: 'a', label: 'A', estimateUsd: 0 }, { value: 'b', estimateUsd: -1 }, { value: 'c', estimateUsd: 'x' }] })).map((item) => 'estimateUsd' in item), [false, false, false], 'a price of 0 or less is no price');

        // labels: name, what it takes, what it costs; the price reads "about" and never shows 0
        const price = ui.modelOptionLabel(normal[2], null).text;
        assert.match(price, /^Nano Banana Pro · /);
        assert.match(price, /\$0\.13/);
        assert.match(price, lang === 'de' ? /ca\. \$0\.13 pro Bild/ : lang === 'en' ? /about \$0\.13 per image/ : /aprox\. \$0\.13 por imagen/);
        assert.doesNotMatch(ui.modelOptionLabel(normal[1], null).text, /\$/, 'no price known: none is shown');
        assert.doesNotMatch(ui.modelOptionLabel(normal[4], null).text, /·/, 'unknown: only the name');
        assert.match(ui.modelOptionLabel(normal[3], { references: 2 }).text, /⚠/, 'does not fit the connections: marked');
        assert.equal(ui.modelOptionLabel(normal[3], { references: 2 }).misfit, true);

        // the default entry has its own words in the interface language
        const text = ui.T('nodes.option.defaultNamed', { name: 'GPT Image 2' });
        assert.match(text, /GPT Image 2/);
        assert.doesNotMatch(text, /\{name\}/);

        // the default entry and the same model chosen explicitly do not look the same (the second one stays when the server changes its default)
        const entries = plain(ui.selectEntries({ optionsSource: 'image-models' }, { state: 'ready', options: normal }, ''));
        assert.deepEqual(entries.map((item) => item.value), ['', GPT, NANO, ONE_REF, UNKNOWN_REFS]);
        assert.equal(entries[0].label, text);
        assert.equal(entries[1].label, ui.T('nodes.option.pinnedNamed', { name: 'GPT Image 2' }));
        assert.notEqual(entries[0].label, entries[1].label);
        assert.doesNotMatch(entries[1].label, /\{name\}/);
        assert.ok(/fest|fixed|fijo/.test(entries[1].label), lang);
        assert.deepEqual(entries.slice(2).map((item) => item.label), ['Nano Banana Pro', 'One Ref', 'Unknown Refs'], 'other models keep their names');
        // a value the list does not know is kept; a list that is not there yet shows the placeholder
        assert.equal(plain(ui.selectEntries({ optionsSource: 'image-models' }, { state: 'ready', options: normal }, 'vendor/old')).pop().value, 'vendor/old');
        assert.equal(plain(ui.selectEntries({ optionsSource: 'image-models' }, { state: 'loading', options: [] }, ''))[0].value, '');
        assert.deepEqual(plain(ui.selectEntries({ options: ['a'] }, { options: [{ value: 'a', label: 'A' }] }, 'a')), [{ value: 'a', label: 'A' }], 'a plain select is not touched');
      }

      // limits of the chosen model come from the list, with no description to read from Higgsfield
      const ui = load('de', api);
      const edit = JSON.parse(JSON.stringify(registry.publicDescriptor(def('image.edit'))));
      const state = ui.optionsFor({ optionsSource: 'image-edit-models' });
      assert.equal(state.state, 'loading');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ui.optionsFor({ optionsSource: 'image-edit-models' }).state, 'ready');
      assert.deepEqual(requested, ['image-edit-models'], 'the list is fetched once');
      const limits = (model) => JSON.parse(JSON.stringify(ui.limitsFor({ id: 'n', type: 'image.edit', params: model === undefined ? {} : { model } }, edit)));
      assert.deepEqual(limits(ONE_REF), { images: { max: 1, roles: [], required: false, subject: 'One Ref' } });
      assert.equal(limits(NANO).images.max, 8);
      assert.deepEqual(limits(UNKNOWN_REFS), {}, 'unknown: the fixed maximum of the input');
      assert.deepEqual(limits(NOT_LISTED), {});
      assert.equal(limits('').images.max, 8, 'no choice: what the list says about the default entry');
      assert.deepEqual(detailRequests, [], 'no description is asked for from Higgsfield');
      // a list that is not there yet starts to load when a limit is asked for
      const later = load('de', api);
      assert.deepEqual(Object.keys(later.limitsFor({ id: 'n', type: 'image.edit', params: { model: ONE_REF } }, edit)), []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(later.limitsFor({ id: 'n', type: 'image.edit', params: { model: ONE_REF } }, edit).images.max, 1);
      assert.deepEqual(detailRequests, []);
    }

  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-image-models.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
