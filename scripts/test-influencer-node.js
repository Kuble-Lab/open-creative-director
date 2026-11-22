'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createIsolatedApp } = require('./support/isolated-app');

const BASELINES = {
  'music-video-hud': 'fe423ef932ff17878aac10f0468bc2b6e4f49b03fb1e2fa712653c20e091fe6f',
  'music-video-hud-elevenlabs': '08caae34f700b3ff84892c759b953245845408c6eb366b7cd988ee183208810f',
  'music-video-hud-suno': 'f6f1da17ca824c5d8bb9d319db0be9e79ff6b22a4cf6c5d511461312261a4db4',
  'music-video-hud-suno-direct': '9f81681d9210a6345325751e85b3706bf4ba7659aeffe2695e267accd3937252'
};
const STAFF = 'one@staff.example.com';
const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
const edge = (id, from, to) => ({ id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });

async function main() {
  const iso = await createIsolatedApp({ env: { INTERNAL_EMAIL_DOMAINS: 'staff.example.com', OPENROUTER_API_KEY: '', GTS_API_TOKEN: '' } });
  try { await run(iso); } finally { await iso.cleanup(); }
  console.log('test-influencer-node.js: ok');
}

async function run(iso) {
  const influencers = iso.load('lib/influencers');
  const access = iso.load('lib/access');
  const registry = iso.load('lib/nodes/registry').registry;
  const engineLib = iso.load('lib/nodes/engine');
  const { textValue, numberValue, listValue } = iso.load('lib/nodes/types');
  const assets = iso.load('lib/nodes/assets');
  const store = iso.load('lib/store');
  await store.ensureDirs();
  const hud = iso.load('lib/nodes/nodes-music-video-hud');
  const templates = iso.load('lib/nodes/templates');
  const def = registry.get('input.influencer');
  const viewer = access.viewerOf({ kubleUser: STAFF });
  const wfStore = iso.load('lib/nodes/workflows-store').createWorkflowsStore({ dir: path.join(iso.root, 'data', 'flows'), registry });
  const engine = engineLib.createEngine({ store: wfStore, registry, events: iso.load('lib/nodes/events').createEventBus(), getConfig: () => ({}), limits: { jobPollMs: 10 } });
  const create = async (params) => (await wfStore.createWorkflow({ name: 'Influencer test', graph: { nodes: [node('i', def.type, params)], edges: [] } })).workflow;
  const start = async (wf, force = false) => {
    const result = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all', user: STAFF, force }));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result;
  };
  const entry = async (wf) => (await wfStore.readResults(wf.id)).nodes.i.history[0];
  const logs = [];
  assert.deepEqual(await def.execute({ log: (s) => logs.push(s) }, {}, { influencer: '' }), { variants: [{}] });
  assert.deepEqual(logs, ['No influencer chosen']);
  assert.deepEqual(def.emptyOutputs({ influencer: '' }), ['figure', 'images', 'voice', 'voice_description', 'style']);
  assert.deepEqual(def.emptyOutputs({ influencer: 'claudia' }), []);
  assert.equal(await def.cacheStamp({ influencer: '' }, {}), undefined);
  const none = await create({ influencer: '' });
  await start(none);
  assert.deepEqual((await entry(none)).variants, [{}], 'the engine accepts a wholly empty variant');

  const claudia = await create({ influencer: 'claudia' });
  await start(claudia);
  const cv = (await entry(claudia)).variants[0];
  assert.equal(cv.figure.value, templates.resolveTemplate('music-video-hud', { lang: 'en' }).graph.nodes.find((n) => n.id === 'n4').params.figure);
  assert.equal(cv.images.items.length, 3);
  assert.equal(cv.voice, undefined);
  assert.deepEqual(engineLib.resolveNodeInputs({ node: { id: 'voice' }, ports: { inputs: [{ id: 'voice', type: 'text' }] }, params: {}, edges: [edge('voice', ['i', 'voice'], ['voice', 'voice'])], outputsOf: () => cv, maxListItems: 10 }).inputs, {}, 'a selected influencer without a voice leaves optional speech inputs empty');
  await start(claudia, true);
  assert.deepEqual((await entry(claudia)).variants[0].images, cv.images);

  let own = await influencers.createInfluencer({ name: 'Ada', full: 'An adult singer', style: 'Ink', voice: { voiceId: 'voice-ada', description: 'Low and warm' } }, { viewer, consent: true });
  const png = (last) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, last]);
  own = await influencers.saveInfluencerImage(own.id, { filename: 'first.png', buffer: png(1) });
  own = await influencers.saveInfluencerImage(own.id, { filename: 'second.png', buffer: png(2) });
  const wf = await create({ influencer: own.id });
  await start(wf);
  await iso.listen();
  const ownOptions = await iso.request('/api/nodes/options/influencers', { as: STAFF });
  assert.equal(ownOptions.status, 200);
  assert.ok(ownOptions.body.options.some((option) => option.value === own.id && option.label === 'Ada'));
  const otherOptions = await iso.request('/api/nodes/options/influencers', { as: 'other@staff.example.com' });
  assert.ok(otherOptions.body.options.some((option) => option.value === 'claudia'));
  assert.ok(!otherOptions.body.options.some((option) => option.value === own.id));
  const first = await entry(wf);
  const value = first.variants[0];
  assert.equal(await def.cacheStampAdopts(first, { stamp: await def.cacheStamp({ influencer: own.id }, { user: STAFF }) }), true);
  assert.deepEqual(Object.keys(value).sort(), ['figure', 'images', 'style', 'voice', 'voice_description']);
  assert.equal(value.voice.value, 'voice-ada');
  assert.equal(value.voice_description.value, 'Low and warm');
  assert.equal(value.style.value, 'Ink');
  assert.ok(value.images.items.every((image) => image.sessionId === wf.sessionId));
  const ownInputs = engineLib.resolveNodeInputs({ node: node('plan', 'music_video.hud_plan'), params: { figure: 'fallback' }, ports: { inputs: registry.get('music_video.hud_plan').inputs.filter((port) => ['figure', 'figure_image'].includes(port.id)) }, edges: [edge('f', ['i', 'figure'], ['plan', 'figure']), edge('p', ['i', 'images'], ['plan', 'figure_image'])], outputsOf: () => value, maxListItems: 100 }).inputs;
  assert.equal(ownInputs.figure.value, influencers.figureText(own));
  assert.equal(hud.sheetReferencesOf(ownInputs, {}, ownInputs.figure.value).kind, 'own');
  assert.equal(ownInputs.figure_image.items.length, 2);
  await start(wf);
  assert.equal((await entry(wf)).id, first.id, 'unchanged selection uses the cache');
  await start(wf, true);
  assert.deepEqual((await entry(wf)).variants[0].images, value.images);
  await influencers.updateInfluencer(own.id, { full: 'An adult singer in red' });
  assert.equal((await engine.plan(wf.id, { mode: 'all', user: STAFF })).nodes.i.status, 'stale');
  await start(wf);
  const changedText = await entry(wf);
  assert.notEqual(changedText.stamp, first.stamp);
  assert.deepEqual(changedText.variants[0].images, value.images);
  await fsp.writeFile(path.join(influencers.influencerAssetsDir(own.id), own.images[1]), png(3));
  await start(wf);
  const changedImage = await entry(wf);
  assert.notEqual(changedImage.stamp, changedText.stamp);
  assert.equal(changedImage.variants[0].images.items[0].assetId, value.images.items[0].assetId);
  assert.notEqual(changedImage.variants[0].images.items[1].assetId, value.images.items[1].assetId);
  assert.equal((await store.readLedger(wf.sessionId)).filter((item) => assets.typeFromLedgerEntry(item) === 'image').length, 3);
  const denied = { user: 'other@staff.example.com' };
  await assert.rejects(def.execute(denied, {}, { influencer: own.id }), (error) => error.code === 'INFLUENCER_NOT_FOUND' && /does not exist for your account/.test(error.message));
  await influencers.deleteInfluencer(own.id);
  await assert.rejects(def.execute({ user: STAFF }, {}, { influencer: own.id }), (error) => error.code === 'INFLUENCER_NOT_FOUND');

  for (const [id, digest] of Object.entries(BASELINES)) {
    const doc = JSON.parse(await fsp.readFile(path.join(iso.root, 'lib', 'nodes', 'templates', `${id}.json`), 'utf8'));
    const prior = doc.graph.nodes.filter((n) => n.type !== def.type);
    const keys = prior.map((n) => n.id + ':' + engineLib.computeCacheKey(registry.get(n.type), registry.normalizeParams(registry.get(n.type), n.params), {}));
    assert.equal(crypto.createHash('sha256').update(keys.join('\n')).digest('hex'), digest, `${id}: every existing node retains its parameter key`);
    for (const lang of ['de', 'en', 'es']) {
      const resolved = templates.resolveTemplate(id, { lang });
      const plan = resolved.graph.nodes.find((n) => n.type === 'music_video.hud_plan');
      const inf = resolved.graph.nodes.find((n) => n.type === def.type);
      const params = registry.normalizeParams(registry.get(plan.type), plan.params);
      const ports = registry.portsFor(registry.get(plan.type), params);
      const resolve = (edges) => engineLib.resolveNodeInputs({ node: plan, ports: { inputs: ports.inputs.filter((p) => ['figure', 'figure_image'].includes(p.id)) }, params, edges, outputsOf: () => ({}), maxListItems: 100 }).inputs;
      const fallback = resolve(resolved.graph.edges);
      const unwired = resolve(resolved.graph.edges.filter((e) => e.from.node !== inf.id));
      assert.deepEqual(fallback, unwired);
      assert.equal(fallback.figure.value, params.figure);
      assert.equal(fallback.figure_image, undefined);
      assert.equal(engineLib.computeCacheKey(registry.get(plan.type), params, fallback), engineLib.computeCacheKey(registry.get(plan.type), params, unwired));
      const focused = engineLib.validateGraph({ graph: resolved.graph }, registry, new Set([plan.id, inf.id]));
      assert.deepEqual(focused, [], `${id}: the influencer and planner validate without errors or warnings`);
      const preview = engineLib.computePlan({ workflow: { graph: resolved.graph, sessionId: 'test' }, results: { nodes: {} }, request: { mode: 'all', targets: resolved.graph.nodes.map((n) => n.id) }, registry, limits: engineLib.DEFAULT_LIMITS || { maxListItems: 100 } });
      assert.equal(preview.issues.filter((issue) => ['OUTPUT_EMPTY', 'OUTPUT_EMPTY_OPTIONAL'].includes(issue.code)).length, 0, id);
    }
  }

  // A new empty input node must not invalidate an already computed downstream result.
  const consumer = {
    type: 't.figure_consumer', category: 'text',
    inputs: [{ id: 'figure', type: 'text', required: true, param: 'figure', emptyFallback: true }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'figure', kind: 'text', default: 'Default figure' }],
    cost: { unit: 'local' },
    execute: async (_ctx, inputs) => ({ variants: [{ out: inputs.figure }] })
  };
  registry.register(consumer);
  const pair = (await wfStore.createWorkflow({ name: 'Fallback cache', graph: { nodes: [node('c', consumer.type)], edges: [] } })).workflow;
  await start(pair);
  const before = (await wfStore.readResults(pair.id)).nodes.c.history[0];
  const pairGraph = { nodes: [...pair.graph.nodes, node('i', def.type)], edges: [edge('fallback', ['i', 'figure'], ['c', 'figure'])] };
  await wfStore.saveGraph(pair.id, { baseRev: pair.rev, graph: pairGraph });
  assert.equal((await engine.plan(pair.id, { mode: 'all', user: STAFF })).nodes.c.status, 'cached', 'the plan knows a switched-off output before it runs');
  await start(pair);
  assert.equal((await wfStore.readResults(pair.id)).nodes.c.history[0].cacheKey, before.cacheKey);
  const A = iso.load('lib/nodes/assistant');
  const proposal = A.validateProposal({ nodes: [], edges: [{ from: { node: 'i', port: 'figure' }, to: { node: 'c', port: 'figure' } }] }, { registry, canvas: A.sanitizeCanvas({ nodes: pairGraph.nodes, edges: [] }), restricted: false, viewer, usable: new Set([consumer.type, def.type]), optionLists: new Map() });
  assert.ok(proposal.insert, JSON.stringify(proposal));
  const blankGraph = { nodes: [node('i', def.type), node('c', consumer.type, { figure: '' })], edges: pairGraph.edges };
  assert.ok(engineLib.validateGraph({ graph: blankGraph }, registry).some((issue) => issue.code === 'OUTPUT_EMPTY'), 'a blank fallback still fails validation');
  const refused = A.validateProposal({ nodes: [], edges: [{ from: { node: 'i', port: 'figure' }, to: { node: 'c', port: 'figure' } }] }, { registry, canvas: A.sanitizeCanvas({ ...blankGraph, edges: [] }), restricted: false, viewer, usable: new Set([consumer.type, def.type]), optionLists: new Map() });
  assert.equal(Boolean(refused.insert), false, 'the assistant still refuses an empty required input without a fallback');
  const editFlow = (await wfStore.createWorkflow({ name: 'Fallback edit', graph: { nodes: pairGraph.nodes, edges: [] } })).workflow;
  const edit = iso.load('lib/nodes/edit-service').createEditService({ store: wfStore, registry });
  await edit.edit(viewer, editFlow, { rev: editFlow.rev, user: STAFF, operations: [{ op: 'connect', from: { node: 'i', port: 'figure' }, to: { node: 'c', port: 'figure' } }] });
  registry.unregister(consumer.type);
  registry.register({ type: 't.empty_list', category: 'input', inputs: [], outputs: [{ id: 'items', type: 'text[]' }], params: [], cost: { unit: 'local' }, emptyOutputs: () => ['items'], emptyOutputsSwitched: true, execute: async () => ({ variants: [{}] }) });
  registry.register({ ...consumer, type: 't.fallback_count', paid: true, params: [...consumer.params, { id: 'count', kind: 'integer', default: 4 }], cost: { unit: 'usd', estimate: (params) => ({ usd: params.count }) } });
  const counted = (await wfStore.createWorkflow({ name: 'Empty list fallback', graph: { nodes: [node('list', 't.empty_list'), node('c', 't.fallback_count')], edges: [edge('list', ['list', 'items'], ['c', 'figure'])] } })).workflow;
  const countedPlan = await engine.plan(counted.id, { mode: 'all', user: STAFF });
  assert.equal(countedPlan.nodes.c.estimate.usd, 4, 'an absent list does not turn the scalar fallback into a one-item estimate');
  assert.equal(countedPlan.nodes.c.executions, 1);
  registry.register({ type: 't.runtime_empty_list', category: 'input', inputs: [], outputs: [{ id: 'items', type: 'text[]' }], params: [], cost: { unit: 'local' }, execute: async () => ({ variants: [{}] }) });
  const runtimeEmpty = (await wfStore.createWorkflow({ name: 'Runtime empty list fallback', graph: { nodes: [node('list', 't.runtime_empty_list'), node('c', 't.fallback_count')], edges: [edge('list', ['list', 'items'], ['c', 'figure'])] } })).workflow;
  await engine.whenFinished(runtimeEmpty.id, await engine.start(runtimeEmpty.id, { mode: 'node', nodeIds: ['list'], user: STAFF }));
  assert.equal((await engine.plan(runtimeEmpty.id, { mode: 'all', user: STAFF })).nodes.c.estimate.usd, 4, 'a runtime-empty list also uses the scalar estimate');
  registry.unregister('t.runtime_empty_list');
  registry.unregister('t.empty_list');
  registry.unregister('t.fallback_count');

  // A known-empty wire has exactly the no-wire value, including number zero; a real list still maps.
  for (const type of ['text', 'number']) {
    const port = { id: 'input', type, required: true, param: 'field', emptyFallback: true };
    const wired = [edge('e', ['i', 'out'], ['target', 'input'])];
    const resolve = (field, edges, output, inputPort = port) => engineLib.resolveNodeInputs({ node: { id: 'target' }, ports: { inputs: [inputPort] }, params: { field }, edges, outputsOf: () => ({ out: output }), maxListItems: 10 });
    const field = type === 'number' ? 0 : '  preserve whitespace  ';
    assert.deepEqual(resolve(field, wired), resolve(field, []));
    assert.throws(() => resolve('', wired), (error) => error.code === 'OUTPUT_EMPTY');
    // a port that does not ask for the fallback behaves as before: required fails, optional stays without a value
    assert.throws(() => resolve(field, wired, undefined, { ...port, emptyFallback: undefined }), (error) => error.code === 'OUTPUT_EMPTY');
    assert.deepEqual(resolve(field, wired, undefined, { ...port, emptyFallback: undefined, required: false }).inputs, {});
    const list = listValue(type, [type === 'number' ? numberValue(2) : textValue('connected')]);
    assert.deepEqual(resolve(field, wired, list).mapped, ['input']);
    assert.equal(resolve(field, wired, list).inputs.input.type, 'list');
  }
  const six = listValue('image', Array.from({ length: 6 }, (_, i) => ({ ...cv.images.items[i % 3], assetId: `image-${i}` })));
  assert.equal(registry.get('music_video.hud_plan').inputs.find((p) => p.id === 'figure_image').max, 6);
  assert.deepEqual(hud.hudPlanValidate({}, { figure_image: { count: 6 } }), []);
  assert.equal(hud.hudPlanValidate({}, { figure_image: { count: 7 } })[0].level, 'error');
  assert.equal(hud.sheetReferencesOf({ figure_image: six }, {}, 'Ada').own.length, 3);
  assert.deepEqual(hud.sheetReferencesOf({ figure_image: six }, {}, 'Ada').own, six.items.slice(0, 3));
  const sixLogs = [];
  const originalPlanner = iso.load('lib/music-video-hud/plan').runPlanner;
  // Stop at the paid boundary: reaching the sentinel proves that six real references passed preflight.
  iso.load('lib/music-video-hud/plan').runPlanner = async () => { throw new Error('mock planner reached'); };
  try {
    const realSix = listValue('image', [...cv.images.items, ...cv.images.items]);
    await assert.rejects(registry.get('music_video.hud_plan').execute({ sessionId: claudia.sessionId, config: {}, log: (line) => sixLogs.push(line) }, { figure: cv.figure, figure_image: realSix }, { model: 'mock', listen: false }), /mock planner reached/);
    assert.ok(sixLogs.includes('figure_image: 6 images connected, the first 3 are used as references'));
  } finally { iso.load('lib/music-video-hud/plan').runPlanner = originalPlanner; }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
