'use strict';

const assert = require('assert/strict');
const { createRegistry, registry: standardRegistry } = require('../lib/nodes/registry');
const engine = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');
const { createTimelineService } = require('../lib/timeline/service');

const video = (assetId, duration = 2) => ({ type: 'video', sessionId: 'session', assetId, url: `/assets/session/${assetId}.mp4`, duration });
const list = (...items) => listValue(items[0]?.type || 'video', items);
const edge = (from, fromPort, to, toPort) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

async function main() {
  const registry = createRegistry();
  for (const type of ['music_video.edit', 'explainer.edit', 'video.concat', 'util.pick', 'util.router', 'input.media_list']) registry.register(standardRegistry.get(type));
  const neverExecute = async () => { throw new Error('Timeline must never execute a node'); };
  registry.register({ type: 't.words', category: 'input', outputs: [{ id: 'texts', type: 'text[]' }], execute: neverExecute });
  registry.register({ type: 't.make', category: 'video', inputs: [{ id: 'context', type: 'text' }, { id: 'prompt', type: 'text', required: true }], outputs: [{ id: 'video', type: 'video' }], execute: neverExecute });
  registry.register({ type: 't.notes', category: 'video', inputs: [{ id: 'brief', type: 'text', required: true }], outputs: [{ id: 'video', type: 'video' }],
    params: [{ id: 'notes', kind: 'notes', items: 'brief' }], execute: neverExecute });
  const nodes = [
    { id: 'words', type: 't.words' },
    { id: 'make', type: 't.make', itemEdits: { prompt: { 1: { was: 'second', text: 'changed second' } } } },
    { id: 'notes', type: 't.notes' }, { id: 'pick', type: 'util.pick', params: { index: -1 } },
    { id: 'router', type: 'util.router', params: { index: 1 } },
    { id: 'uploads', type: 'input.media_list', params: { kind: 'video' } },
    { id: 'cut', type: 'music_video.edit' }, { id: 'concat', type: 'video.concat' }
  ];
  const workflow = { id: 'wf', name: 'Timeline', sessionId: 'session', graph: { nodes, edges: [
    edge('words', 'texts', 'make', 'prompt'), edge('words', 'single', 'make', 'context'), edge('words', 'texts', 'notes', 'brief'),
    edge('words', 'shots', 'cut', 'shots'), edge('words', 'song', 'cut', 'song'),
    edge('make', 'video', 'cut', 'performance'), edge('notes', 'video', 'cut', 'story'),
    edge('make', 'video', 'pick', 'items'), edge('pick', 'item', 'concat', 'clips'), edge('notes', 'video', 'concat', 'clips'),
    edge('make', 'video', 'router', 'inputs')
  ] } };
  const results = { nodes: {} };
  function save(id, value, others = []) {
    results.nodes[id] = { selected: { entry: 'chosen', variant: 1 }, history: [
      { id: 'newer', variants: [{ video: video('wrong-newest') }] },
      { id: 'chosen', variants: [{ video: video('wrong-variant') }, value] }, ...others
    ] };
  }
  const plan = { shots: [
    { kind: 'performance', clip: 0, start: 0, end: 2 },
    { kind: 'performance', clip: 1, start: 2, end: 4 },
    { kind: 'story', clip: 0, start: 4, end: 6 },
    { kind: 'still', clip: 0, start: 6, end: 8 }
  ] };
  save('words', { texts: list(textValue('first'), textValue('second')), single: textValue('broadcast context'),
    shots: textValue(JSON.stringify(plan)), song: { ...video('song', 8), type: 'audio' } });
  save('make', { video: list(video('v0'), video('v1')) });
  save('notes', { video: list(video('scene')) });
  save('pick', { item: video('v1') });
  save('router', { out: video('v1') });
  save('uploads', { items: list(video('v1')) });
  let reviews = { nodes: { cut: { 'performance:1': { status: 'approved', assetId: 'v1', by: 'reviewer', at: 'today', feedback: [] },
    'still:0': { status: 'approved', assetId: 'gone', feedback: [] } } } };
  const snapshot = JSON.stringify({ workflow, results });
  const resolvedIds = [];
  const service = createTimelineService({ registry, engine,
    store: { getWorkflow: async (id) => { assert.equal(id, 'wf'); return { workflow, results }; } },
    reviewStore: { read: async () => reviews },
    resolveAsset: async (value) => {
      resolvedIds.push(value.assetId);
      return { ...value, url: `/real/${value.assetId}`, duration: value.assetId === 'v1' ? 3 : value.duration };
    }
  });
  let view = await service.getTimeline('wf', 'cut');
  assert.equal(view.duration, 8);
  assert.equal(view.audioAsset.id, 'song');
  assert.deepEqual(view.clips[1].asset, { id: 'v1', url: '/real/v1', duration: 3 });
  assert.equal(view.clips[1].over, 1);
  assert.equal(view.clips[0].over, 0);
  assert.deepEqual(view.clips[1].producer, { nodeId: 'make', item: 1 });
  assert.equal(view.clips[1].prompt, 'changed second');
  assert.equal(view.clips[1].promptPort, 'prompt', 'a broadcast context never hides the first mapped text');
  assert.equal(view.clips[1].feedbackCapability, 'prompt');
  assert.equal(view.clips[2].feedbackCapability, 'notes');
  assert.equal(view.clips[2].over, 0, 'non-lipsync clips have no overhang warning');
  assert.equal(view.clips[1].review.status, 'approved');
  assert.equal(view.clips[3].missing, true);
  assert.equal(view.clips[3].review.status, 'open');
  assert.equal(view.clips[3].producer, null);
  assert.equal(JSON.stringify({ workflow, results }), snapshot, 'reading never edits graph or results');
  assert.ok(!resolvedIds.includes('wrong-newest') && !resolvedIds.includes('wrong-variant'));
  assert.deepEqual((await service.listTimelineNodes('wf')).map((node) => node.nodeId), ['cut', 'concat']);
  let joined = await service.getTimeline('wf', 'concat');
  assert.deepEqual(joined.clips.map((clip) => clip.start), [0, 3], 'concat uses real metadata in edge order');
  assert.deepEqual(joined.clips[0].producer, { nodeId: 'make', item: 1 }, 'negative pick index keeps the original item');
  assert.equal(joined.clips[0].prompt, 'changed second');

  const concatEdge = workflow.graph.edges.find((entry) => entry.to.node === 'concat');
  concatEdge.from = { node: 'router', port: 'out' };
  assert.deepEqual((await service.getTimeline('wf', 'concat')).clips[0].producer, { nodeId: 'make', item: 1 });
  concatEdge.from = { node: 'uploads', port: 'items' };
  assert.deepEqual((await service.getTimeline('wf', 'concat')).clips[0].producer, { nodeId: 'make', item: 1 }, 'unique generated asset through a media list');
  save('notes', { video: list(video('v1')) });
  joined = await service.getTimeline('wf', 'concat');
  assert.equal(joined.clips[0].producer, null, 'ambiguous media-list origin stays unknown');
  save('notes', { video: list(video('scene')) });
  nodes.find((node) => node.id === 'pick').params.index = 0;
  concatEdge.from = { node: 'pick', port: 'item' };
  assert.equal((await service.getTimeline('wf', 'concat')).clips[0].producer, null, 'stale pick output is not attributed using changed params');

  save('make', { video: list(video('v0'), video('replacement', 2.3)) });
  view = await service.getTimeline('wf', 'cut');
  assert.equal(view.clips[1].review.status, 'open', 'approval belongs to the asset');
  assert.equal(view.clips[1].over, 0, 'exactly 0.3 seconds is below the warning threshold');
  const edited = nodes.find((node) => node.id === 'make');
  edited.itemEdits.prompt[1].was = 'stale';
  assert.equal((await service.getTimeline('wf', 'cut')).clips[1].prompt, 'second');

  const missing = createTimelineService({ registry, store: { getWorkflow: async () => ({ workflow, results }) },
    resolveAsset: async () => { throw new Error('File missing'); } });
  assert.ok((await missing.getTimeline('wf', 'cut')).clips.every((clip) => clip.missing));
  assert.ok((await missing.getTimeline('wf', 'concat')).clips.every((clip) => clip.missing), 'known stored lengths keep missing files in their slots');
  results.nodes.make.selected = null;
  assert.ok((await service.getTimeline('wf', 'cut')).clips.slice(0, 2).every((clip) => clip.missing));
  results.nodes.words.selected = null;
  assert.equal(await service.getTimeline('wf', 'cut'), null, 'no plan means no invented timeline');
  await assert.rejects(service.getTimeline('wf', 'unknown'), { code: 'NODE_NOT_FOUND' });
  assert.equal(await service.getTimeline('wf', 'words'), null);

  nodes.push({ id: 'explainer', type: 'explainer.edit', params: { transition: 'cut' } });
  workflow.graph.edges.push(edge('notes', 'video', 'explainer', 'scenes'), edge('words', 'audio', 'explainer', 'audio'),
    edge('words', 'timing', 'explainer', 'timing'), edge('words', 'explainerPlan', 'explainer', 'shots'));
  save('words', { texts: list(textValue('brief')), audio: list({ ...video('voice', 1.6), type: 'audio' }),
    timing: list(textValue(JSON.stringify({ duration: 1.6, words: [] }))),
    explainerPlan: textValue(JSON.stringify({ scenes: [{ id: 's1', narration: 'Speech' }] })) });
  const spoken = await service.getTimeline('wf', 'explainer');
  assert.equal(spoken.audio, null);
  assert.equal(spoken.audioAsset, null);
  assert.deepEqual(spoken.clips[0].sound, { port: 'audio', item: 0 });
  assert.equal(spoken.clips[0].soundAsset.id, 'voice');
  assert.equal(spoken.clips[0].feedbackCapability, 'notes');
  console.log('test-timeline-service.js: ok');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
