'use strict';

// The key of one item of an implicit map (SPEC §9.6, WP35c): a node may say which part of its inputs an item really reads
// (def.itemKeyInputs), so that a change of something else does not make every item run again.
//   - nodes without the hook keep their keys byte for byte
//   - explainer.scene (real definition, fake execution): one changed shot, still, page image or document only runs the scenes that read it;
//     the brand, the logo and the parameters run all; duplicate entries keep their own results; the plan prices what runs
//   - explainer.voice: the text around a scene counts only where the voice reads it
//   - an entry that an older version stored gets its new item keys when it is the cache hit of a run
// No provider calls, no render node; backing sessions are real and removed.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine, computeItemKeys } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');
const videoNodes = require('../lib/nodes/nodes-explainer-video');

const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
function edges(...specs) {
  return specs.map((spec, index) => {
    const [from, to] = spec.split('>');
    const [fromNode, fromPort] = from.split('.');
    const [toNode, toPort] = to.split('.');
    return { id: `e${index + 1}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
  });
}
const media = (type, id) => ({ type, sessionId: 'sess', assetId: id, file: `${id}.${type === 'video' ? 'mp4' : type === 'audio' ? 'wav' : 'png'}` });
const ids = (text) => String(text).split(',').filter(Boolean);

// the brief the planner writes for a scene (the first line is what parseBrief reads)
const briefOf = (id, kind = 'motion') => `Scene ${id} · role point · kind ${kind} · about 5 s · landscape · language de\nTitle: Titel ${id}`;

function buildRegistry(calls) {
  const registry = createRegistry();
  calls.failOn = null; // the id of a scene whose execution fails
  let counter = 0;
  // the planner: the briefs and timings as lists, the shot list and the info text of the documents as one text each
  registry.register({
    type: 't.plan',
    category: 'input',
    outputs: [
      { id: 'briefs', type: 'text[]' },
      { id: 'timings', type: 'text[]' },
      { id: 'shots', type: 'text' },
      { id: 'info', type: 'text' },
      { id: 'narration', type: 'text[]' },
      { id: 'context', type: 'text[]' }
    ],
    params: [
      { id: 'scenes', kind: 'textarea', default: '' }, // "s1:motion,s2:still"
      { id: 'shots', kind: 'textarea', default: '{}' },
      { id: 'info', kind: 'textarea', default: '{}' },
      { id: 'narration', kind: 'textarea', default: '' }, // lines
      { id: 'context', kind: 'textarea', default: '' } // lines of JSON
    ],
    execute: async (_ctx, _inputs, params) => {
      const scenes = ids(params.scenes).map((item) => item.split(':'));
      const lines = (text) => String(text).split('\n').filter((line) => line !== '');
      return {
        variants: [
          {
            briefs: listValue('text', scenes.map(([id, kind]) => textValue(briefOf(id, kind)))),
            timings: listValue('text', scenes.map(() => textValue(JSON.stringify({ duration: 5, words: [] })))),
            shots: textValue(params.shots),
            info: textValue(params.info),
            narration: listValue('text', lines(params.narration).map((line) => textValue(line === '-' ? '' : line))),
            context: listValue('text', lines(params.context).map((line) => textValue(line)))
          }
        ]
      };
    }
  });
  registry.register({
    type: 't.pictures',
    category: 'input',
    outputs: [{ id: 'images', type: 'image[]' }],
    params: [{ id: 'ids', kind: 'text', default: '' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ images: listValue('image', ids(params.ids).map((id) => media('image', id))) }] })
  });
  registry.register({
    type: 't.logo',
    category: 'input',
    outputs: [{ id: 'logo', type: 'image' }],
    params: [{ id: 'id', kind: 'text', default: 'logo1' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ logo: media('image', params.id) }] })
  });
  registry.register({
    type: 't.text',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'text', kind: 'text', default: 'x' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ out: textValue(params.text) }] })
  });

  // the real definitions of the explainer nodes (their hooks), with the execution replaced
  const sceneDef = videoNodes.definitions.find((definition) => definition.type === 'explainer.scene');
  const voiceDef = videoNodes.definitions.find((definition) => definition.type === 'explainer.voice');
  registry.register({
    ...sceneDef,
    available: () => true,
    execute: async (ctx, inputs) => {
      const selected = videoNodes.sceneSelection(inputs);
      if (calls.failOn && selected.brief.id === calls.failOn) throw new Error('boom');
      counter += 1;
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, id: selected.brief.id });
      return { variants: [{ video: media('video', `v${counter}`) }], cost: { usd: 0.1 } };
    }
  });
  registry.register({
    ...voiceDef,
    available: () => true,
    execute: async (ctx, inputs, params) => {
      const selected = videoNodes.voiceSelection(inputs, params);
      counter += 1;
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, text: selected.text });
      return { variants: [{ audio: media('audio', `w${counter}`), timing: textValue('{}'), duration: { type: 'number', value: 1 } }], cost: { usd: 0.01 } };
    }
  });
  return { registry, sceneDef, voiceDef };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-itemkeys-'));
  const bus = createEventBus();
  const calls = [];
  const { registry, sceneDef, voiceDef } = buildRegistry(calls);
  const wfStore = createWorkflowsStore({ dir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, parallel: 3 } });
  const created = [];

  /* ---------- nodes without the hook: the keys stay exactly as they were ---------- */
  {
    const def = { type: 't.golden', version: 3, params: [{ id: 'count' }, { id: 'style' }] };
    const resolved = {
      inputs: {
        in: listValue('text', [textValue('a'), textValue('b')]),
        refs: listValue('text', [textValue('r1'), textValue('r2')]),
        pic: media('image', 'a1'),
        n: { type: 'number', value: 2 }
      },
      mapped: ['in'],
      mapLength: 2
    };
    resolved.inputs.pic = { type: 'image', sessionId: 's1', assetId: 'a1', file: 'a1.png' };
    // computed with the engine before the hook existed
    assert.deepEqual(computeItemKeys(def, { count: 3, style: 'plain' }, resolved), [
      'sha256:9c5a7c7a2454c02f7419a0cc29dabe496cf5009ba0b08a1712860f6dfa5efa10',
      'sha256:0f7e48c652b6bce3e08f22d6cc530cc3e8adc9472f74d31ce4cc1d9ce4228a51'
    ]);
    // a hook that returns nothing usable or throws counts everything
    const same = computeItemKeys(def, { count: 3, style: 'plain' }, resolved);
    assert.deepEqual(computeItemKeys({ ...def, itemKeyInputs: () => null }, { count: 3, style: 'plain' }, resolved), same);
    assert.deepEqual(computeItemKeys({ ...def, itemKeyInputs: () => { throw new Error('x'); } }, { count: 3, style: 'plain' }, resolved), same);
    // a hook sees the item: the element of a mapped input, the whole of the others, the parameters of one run (count 1)
    const seen = [];
    computeItemKeys({ ...def, itemKeyInputs: (index, inputs, params) => { seen.push([index, inputs.in.value, inputs.refs.items.length, params.count]); return inputs; } }, { count: 3, style: 'plain' }, resolved);
    assert.deepEqual(seen, [[0, 'a', 2, 1], [1, 'b', 2, 1]]);
    // a hook that returns all inputs gives the same keys as no hook
    assert.deepEqual(computeItemKeys({ ...def, itemKeyInputs: (_i, inputs) => inputs }, { count: 3, style: 'plain' }, resolved), same);
  }

  /* ---------- explainer.scene ---------- */
  assert.equal(typeof sceneDef.itemKeyInputs, 'function');
  assert.equal(typeof voiceDef.itemKeyInputs, 'function');

  const shotScenes = (extra = {}) => ({
    s1: { id: 's1', kind: 'motion', image: null, figure: null, source_refs: ['D1 S. 1'] },
    s2: { id: 's2', kind: 'still', image: 0, figure: null, source_refs: ['D1 S. 2'] },
    s3: { id: 's3', kind: 'still', image: 1, figure: null, source_refs: ['D2 S. 1'] },
    s4: { id: 's4', kind: 'motion', image: null, figure: { document: 1, page: 2, bbox: [10, 30, 80, 20] }, source_refs: ['D2 S. 2'] },
    s5: { id: 's5', kind: 'clip', image: null, figure: null, source_refs: [] },
    ...extra
  });
  const shotsJson = (scenes, top = {}) => JSON.stringify({ format: 'landscape', language: 'de', ...top, scenes: Object.values(scenes) });
  const infoJson = (titles = ['Bericht', 'Anhang']) =>
    JSON.stringify({
      page_images: 'all',
      documents: [
        { type: 'pdf', title: titles[0], pages_read: 2, images: 2, image_offset: 0 },
        { type: 'pdf', title: titles[1], pages_read: 2, images: 2, image_offset: 2 }
      ]
    });
  const KINDS = 's1:motion,s2:still,s3:still,s4:motion,s5:clip';

  async function makeWorkflow(nodes, edgeList) {
    const result = await wfStore.createWorkflow({ name: 'Item keys', graph: { nodes, edges: edgeList } });
    created.push(result.workflow.id);
    return result.workflow;
  }
  async function run(workflowId, request) {
    const runId = await engine.start(workflowId, request);
    return engine.whenFinished(workflowId, runId);
  }
  async function setParams(workflowId, nodeId, params) {
    const current = await wfStore.readWorkflow(workflowId);
    const nodes = current.graph.nodes.map((item) => (item.id === nodeId ? { ...item, params: { ...item.params, ...params } } : item));
    await wfStore.saveGraph(workflowId, { baseRev: current.rev, graph: { ...current.graph, nodes } });
  }
  const results = async (id, nodeId) => (await wfStore.readResults(id)).nodes[nodeId];
  const ran = (nodeId, field = 'id') => calls.filter((call) => call.node === nodeId).map((call) => call[field]);

  const sceneEdges = edges('plan.briefs>sc.brief', 'plan.timings>sc.timing', 'plan.shots>sc.shots', 'plan.info>sc.pages_info', 'stills.images>sc.stills', 'pages.images>sc.pages', 'brand.out>sc.brand', 'logo.logo>sc.logo');
  const sceneNodes = (planParams = {}) => [
    node('plan', 't.plan', { scenes: KINDS, shots: shotsJson(shotScenes()), info: infoJson(), ...planParams }),
    node('stills', 't.pictures', { ids: 'still-a,still-b' }),
    node('pages', 't.pictures', { ids: 'page-0,page-1,page-2,page-3' }),
    node('brand', 't.text', { text: '{"name":"Marke"}' }),
    node('logo', 't.logo', { id: 'logo1' }),
    node('sc', 'explainer.scene')
  ];
  // changes a node before the scenes (the node runs for itself), asks the plan what the scenes cost, then runs everything and
  // returns the ids of the scenes that really ran
  async function change(workflow, nodeId, params, expected) {
    await setParams(workflow.id, nodeId, params);
    const record = await run(workflow.id, { mode: 'node', nodeIds: [nodeId], force: true });
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    calls.length = 0;
    const plan = await engine.plan(workflow.id, { mode: 'node', nodeIds: ['sc'] });
    const finished = await run(workflow.id, { mode: 'all' });
    assert.equal(finished.status, 'completed', JSON.stringify(finished.nodes));
    const names = ran('sc');
    assert.deepEqual(names, expected, `${nodeId} ${JSON.stringify(params).slice(0, 80)}: the scenes that ran`);
    assert.equal(plan.nodes.sc.executions, expected.length, 'the plan counts the scenes that run');
    assert.equal(plan.nodes.sc.reusedItems || 0, 5 - expected.length);
    if (expected.length) assert.equal(Math.round(plan.totals.usd * 1000) / 1000, Math.round(expected.length * 0.1 * 1000) / 1000, 'the plan prices only the scenes that run');
    else assert.equal(plan.totals.usd || 0, 0);
    return finished;
  }

  try {
    const wf = await makeWorkflow(sceneNodes(), sceneEdges);
    const first = await run(wf.id, { mode: 'all' });
    assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
    assert.deepEqual(ran('sc').sort(), ['s1', 's2', 's3', 's4', 's5']);
    const entry = (await results(wf.id, 'sc')).history[0];
    assert.equal(entry.itemKeys.length, 5);
    assert.equal(new Set(entry.itemKeys).size, 5);

    // a plan that changes the title of the second still scene only: that scene runs, the four others are taken
    await change(wf, 'plan', { shots: shotsJson(shotScenes({ s2: { id: 's2', kind: 'still', image: 0, figure: null, source_refs: ['D1 S. 2'], title: 'Ein See' } })) }, ['s2']);
    // a field of the shot list that holds for all scenes: all run
    await change(wf, 'plan', { shots: shotsJson(shotScenes({ s2: { id: 's2', kind: 'still', image: 0, figure: null, source_refs: ['D1 S. 2'], title: 'Ein See' } }), { hint: 'new' }) }, ['s1', 's2', 's3', 's4', 's5']);
    // the position of a scene in the list is not its identity: scenes are found by their id
    const reordered = shotScenes();
    await setParams(wf.id, 'plan', { shots: shotsJson({ s5: reordered.s5, s4: reordered.s4, s3: reordered.s3, s2: { ...reordered.s2, title: 'Ein See' }, s1: reordered.s1 }, { hint: 'new' }) });
    await run(wf.id, { mode: 'node', nodeIds: ['plan'], force: true });
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(ran('sc'), [], 'the same entries in another order change nothing');

    // a still: only the scene that uses it
    await change(wf, 'stills', { ids: 'still-a2,still-b' }, ['s2']);
    await change(wf, 'stills', { ids: 'still-a2,still-b2' }, ['s3']);
    // a page image: only the scene whose figure is on it (document 2, page 2 is the fourth image); a page that no scene uses: none
    await change(wf, 'pages', { ids: 'page-0,page-1,page-2,page-3b' }, ['s4']);
    await change(wf, 'pages', { ids: 'page-0b,page-1,page-2,page-3b' }, []);
    // the info text: the title of the second document is in the source line of the scenes that name it
    await change(wf, 'plan', { info: infoJson(['Bericht', 'Anhang neu']) }, ['s3', 's4']);
    await change(wf, 'plan', { info: infoJson(['Bericht neu', 'Anhang neu']) }, ['s1', 's2', 's3', 's4']);
    // the brand and the logo: all scenes
    await change(wf, 'brand', { text: '{"name":"Andere Marke"}' }, ['s1', 's2', 's3', 's4', 's5']);
    await change(wf, 'logo', { id: 'logo2' }, ['s1', 's2', 's3', 's4', 's5']);
    // a parameter of the node: all scenes
    await setParams(wf.id, 'sc', { quality: 'high' });
    calls.length = 0;
    assert.equal((await run(wf.id, { mode: 'all' })).status, 'completed');
    assert.deepEqual(ran('sc').sort(), ['s1', 's2', 's3', 's4', 's5']);
    // a brief that changes: its scene only
    await change(wf, 'plan', { scenes: 's1:motion,s2:still,s3:still,s4:motion,s5:motion' }, ['s5']);

    /* ----- the keys are those of the entries that exist: nothing but the shot list, the stills, the pages and the info text differs ----- */
    {
      const params = { ...videoNodes.definitions[1].params.reduce((all, param) => ({ ...all, [param.id]: param.default }), {}) };
      const inputs = {
        brief: textValue(briefOf('s2', 'still')),
        timing: textValue('{"duration":5}'),
        brand: textValue('b'),
        logo: media('image', 'l'),
        stills: listValue('image', [media('image', 'a'), media('image', 'b')]),
        pages: listValue('image', [media('image', 'p0')]),
        shots: textValue(shotsJson(shotScenes())),
        pages_info: textValue(infoJson())
      };
      const resolved = { inputs, mapped: ['brief', 'timing'], mapLength: 1 };
      resolved.inputs = { ...inputs, brief: listValue('text', [inputs.brief]), timing: listValue('text', [inputs.timing]) };
      const [reduced] = computeItemKeys(sceneDef, params, resolved);
      const [full] = computeItemKeys({ ...sceneDef, itemKeyInputs: undefined }, params, resolved);
      assert.notEqual(reduced, full, 'the scene reads less than all of its inputs');
      // what the scene reads, as the key sees it
      const keyInputs = sceneDef.itemKeyInputs(0, { ...inputs }, params);
      assert.deepEqual(Object.keys(keyInputs).sort(), ['brand', 'brief', 'logo', 'pages_info', 'shots', 'stills', 'timing']);
      assert.equal(keyInputs.stills.assetId, 'a', 'the still of the scene (image 0)');
      assert.equal(keyInputs.pages, undefined, 'no figure, no page image');
      const body = JSON.parse(keyInputs.shots.value);
      assert.deepEqual(Object.keys(body).sort(), ['entry', 'globals']);
      assert.deepEqual(body.globals, { format: 'landscape', language: 'de' });
      assert.equal(body.entry.id, 's2');
    }

    /* ----- duplicate entries keep their own results (as in WP35) ----- */
    {
      calls.length = 0;
      const twin = await makeWorkflow(sceneNodes({ scenes: 's1:motion,s1:motion,s2:still', shots: shotsJson({ s1: shotScenes().s1, s2: shotScenes().s2 }) }), sceneEdges);
      assert.equal((await run(twin.id, { mode: 'all' })).status, 'completed');
      assert.deepEqual(ran('sc').sort(), ['s1', 's1', 's2']);
      const videosOf = async () => {
        const nodeResults = await results(twin.id, 'sc');
        const selected = nodeResults.history.find((item) => item.id === nodeResults.selected.entry);
        return selected.variants[0].video.items.map((item) => item.assetId);
      };
      const before = await videosOf();
      assert.equal(new Set(before).size, 3, 'two entries with the same key have two results');
      await setParams(twin.id, 'plan', { shots: shotsJson({ s1: shotScenes().s1, s2: { ...shotScenes().s2, title: 'neu' } }) });
      await run(twin.id, { mode: 'node', nodeIds: ['plan'], force: true });
      calls.length = 0;
      assert.equal((await run(twin.id, { mode: 'all' })).status, 'completed');
      assert.deepEqual(ran('sc'), ['s2'], 'only the changed scene runs');
      const after = await videosOf();
      assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'each of the twins keeps its own result');
      assert.notEqual(after[2], before[2]);
    }

    /* ----- an entry of an older version: its keys are renewed when it is the hit of a run, and then one change runs one scene ----- */
    // the keys an older version wrote: over every input completely (no hook), from the inputs the run resolved
    const legacyKeysOf = async (workflowId) => {
      const wfResults = await wfStore.readResults(workflowId);
      const made = (id, port) => wfResults.nodes[id].history[0].variants[0][port];
      const resolved = {
        inputs: {
          brief: made('plan', 'briefs'),
          timing: made('plan', 'timings'),
          brand: made('brand', 'out'),
          logo: made('logo', 'logo'),
          stills: made('stills', 'images'),
          pages: made('pages', 'images'),
          shots: made('plan', 'shots'),
          pages_info: made('plan', 'info')
        },
        mapped: ['brief', 'timing'],
        mapLength: 5
      };
      const registered = registry.get('explainer.scene');
      const params = registry.normalizeParams(registered, {});
      const current = computeItemKeys(registered, params, resolved);
      const legacy = computeItemKeys({ ...registered, itemKeyInputs: undefined }, params, resolved);
      return { current, legacy };
    };
    {
      const old = await makeWorkflow(sceneNodes(), sceneEdges);
      assert.equal((await run(old.id, { mode: 'all' })).status, 'completed');
      const { current, legacy } = await legacyKeysOf(old.id);
      assert.deepEqual([...(await results(old.id, 'sc')).history[0].itemKeys], current, 'the keys of the run are those of the hook');
      assert.notDeepEqual(legacy, current);
      await wfStore.updateResults(old.id, (all) => {
        all.nodes.sc.history[0].itemKeys = legacy;
      });
      // the run finds the entry as a whole (nothing changed) and renews its keys
      calls.length = 0;
      const again = await run(old.id, { mode: 'all' });
      assert.equal(again.nodes.sc.status, 'cached');
      assert.deepEqual(ran('sc'), []);
      assert.deepEqual((await results(old.id, 'sc')).history[0].itemKeys, current, 'the keys of the entry are the current ones');
      // so one changed shot runs one scene
      await change(old, 'plan', { shots: shotsJson(shotScenes({ s3: { ...shotScenes().s3, title: 'Neu' } })) }, ['s3']);
    }

    /* ----- an entry of an older version, one scene asked for again (mode items): only that scene runs, the plan prices only it ----- */
    {
      const old = await makeWorkflow(sceneNodes(), sceneEdges);
      assert.equal((await run(old.id, { mode: 'all' })).status, 'completed');
      const { current, legacy } = await legacyKeysOf(old.id);
      await wfStore.updateResults(old.id, (all) => {
        all.nodes.sc.history[0].itemKeys = legacy;
      });
      calls.length = 0;
      const plan = await engine.plan(old.id, { mode: 'items', nodeId: 'sc', items: [2] });
      assert.equal(plan.nodes.sc.executions, 1, 'the plan counts the one scene');
      assert.equal(plan.nodes.sc.reusedItems, 4);
      assert.equal(Math.round(plan.totals.usd * 1000) / 1000, 0.1, 'the plan prices the one scene');
      const record = await run(old.id, { mode: 'items', nodeId: 'sc', items: [2] });
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.deepEqual(ran('sc'), ['s3'], 'only the asked scene runs');
      const nodeResults = await results(old.id, 'sc');
      assert.equal(nodeResults.history.length, 2);
      const selected = nodeResults.history.find((item) => item.id === nodeResults.selected.entry);
      assert.deepEqual([...selected.itemKeys], current, 'the new entry has the current keys');
    }

    /* ----- a failed run of an older version kept its scenes under the old keys: they are not paid twice ----- */
    {
      const old = await makeWorkflow(sceneNodes(), sceneEdges);
      calls.failOn = 's3';
      const failed = await run(old.id, { mode: 'all' });
      calls.failOn = null;
      assert.equal(failed.status, 'failed');
      const kept = (await results(old.id, 'sc')).partial;
      assert.ok(kept.items[0] && kept.items[1], 'the first two scenes are kept');
      const finished = Object.keys(kept.items).length;
      const { current, legacy } = await legacyKeysOf(old.id);
      assert.deepEqual([...kept.itemKeys], current);
      await wfStore.updateResults(old.id, (all) => {
        all.nodes.sc.partial.itemKeys = legacy;
      });
      calls.length = 0;
      const plan = await engine.plan(old.id, { mode: 'all' });
      assert.equal(plan.nodes.sc.executions, 5 - finished, 'the plan does not count the kept scenes');
      const again = await run(old.id, { mode: 'all' });
      assert.equal(again.status, 'completed', JSON.stringify(again.nodes));
      assert.equal(ran('sc').length, 5 - finished, 'the kept scenes do not run again');
      assert.ok(!ran('sc').includes('s1') && !ran('sc').includes('s2'));
    }

    /* ---------- explainer.voice ---------- */
    {
      const narration = ['Erster Satz.', 'Zweiter Satz.', 'Dritter Satz.', 'Vierter Satz.'];
      const contextOf = (texts) => texts.map((_text, at) => JSON.stringify({ previous_text: texts[at - 1] || '', next_text: texts[at + 1] || '' }));
      const planParams = (texts) => ({ scenes: 's1:motion,s2:motion,s3:motion,s4:motion', narration: texts.join('\n'), context: contextOf(texts).join('\n') });
      const voiceEdges = edges('plan.narration>v.narration', 'plan.context>v.context');
      const voiceRun = async (workflow, texts, expected, label) => {
        await setParams(workflow.id, 'plan', planParams(texts));
        assert.equal((await run(workflow.id, { mode: 'node', nodeIds: ['plan'], force: true })).status, 'completed');
        calls.length = 0;
        const plan = await engine.plan(workflow.id, { mode: 'node', nodeIds: ['v'] });
        assert.equal((await run(workflow.id, { mode: 'all' })).status, 'completed');
        assert.deepEqual(ran('v', 'text').sort(), [...expected].sort(), label);
        assert.equal(plan.nodes.v.executions, expected.length, `${label}: the plan`);
      };

      // with the text around (the default): the scene itself and its neighbours
      const spoken = await makeWorkflow([node('plan', 't.plan', planParams(narration)), node('v', 'explainer.voice')], voiceEdges);
      assert.equal((await run(spoken.id, { mode: 'all' })).status, 'completed');
      assert.deepEqual(ran('v', 'text').sort(), [...narration].sort());
      const changed = [...narration];
      changed[1] = 'Zweiter Satz neu.';
      await voiceRun(spoken, changed, ['Erster Satz.', 'Zweiter Satz neu.', 'Dritter Satz.'].sort(), 'a changed narration runs the scene and its neighbours');
      // the last scene is the neighbour of one scene only
      const lastChanged = [...changed];
      lastChanged[3] = 'Vierter Satz neu.';
      await voiceRun(spoken, lastChanged, ['Dritter Satz.', 'Vierter Satz neu.'].sort(), 'the end of the list');

      // without the text around: only the scene itself
      const alone = await makeWorkflow([node('plan', 't.plan', planParams(narration)), node('v', 'explainer.voice', { use_context: false })], voiceEdges);
      assert.equal((await run(alone.id, { mode: 'all' })).status, 'completed');
      await voiceRun(alone, changed, ['Zweiter Satz neu.'], 'use_context off: the neighbours are not read');

      // a scene without narration does not read the text around it either
      const silent = ['Erster Satz.', '-', 'Dritter Satz.', 'Vierter Satz.'];
      const quiet = await makeWorkflow([node('plan', 't.plan', planParams(silent)), node('v', 'explainer.voice')], voiceEdges);
      assert.equal((await run(quiet.id, { mode: 'all' })).status, 'completed');
      const silentNext = [...silent];
      silentNext[2] = 'Dritter Satz neu.';
      await voiceRun(quiet, silentNext, ['Dritter Satz neu.', 'Vierter Satz.'], 'the scene without narration reads no text around it: it does not run again, and its neighbours see the change only from the other side');

      // the keys of the voices that exist stay as they are (the text around goes into the key as before) ...
      const params = voiceDef.params.reduce((all, param) => ({ ...all, [param.id]: param.default }), {});
      const resolved = {
        inputs: { narration: listValue('text', narration.map(textValue)), context: listValue('text', contextOf(narration).map(textValue)) },
        mapped: ['narration', 'context'],
        mapLength: 4
      };
      assert.deepEqual(computeItemKeys(voiceDef, params, resolved), computeItemKeys({ ...voiceDef, itemKeyInputs: undefined }, params, resolved));
      // ... and they differ only where the text around is not read
      assert.notDeepEqual(computeItemKeys(voiceDef, { ...params, use_context: false }, resolved), computeItemKeys({ ...voiceDef, itemKeyInputs: undefined }, { ...params, use_context: false }, resolved));
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-item-keys.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
