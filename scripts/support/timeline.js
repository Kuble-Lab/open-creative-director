'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const sessions = require('../../lib/store');
const { createRegistry } = require('../../lib/nodes/registry');
const { createWorkflowsStore } = require('../../lib/nodes/workflows-store');
const { createEngine } = require('../../lib/nodes/engine');
const { createTimelineService } = require('../../lib/timeline/service');
const { textValue, listValue } = require('../../lib/nodes/types');

async function fixture({ notes = false, complete } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'timeline-stage-c-'));
  const registry = createRegistry(), calls = { make: 0, cut: 0, down: 0 };
  const video = (id) => ({ type: 'video', sessionId: 'session', assetId: id, url: `/assets/session/${id}.mp4`, duration: 2 });
  registry.register({ type: 't.source', category: 'input', outputs: [{ id: 'texts', type: 'text[]' }],
    params: [{ id: 'token', kind: 'text', default: 'a' }], execute: async (_ctx, _inputs, params) => ({ variants: [{ texts: listValue('text', [textValue(`${params.token} first`), textValue(`${params.token} second`)]) }] }) });
  for (const type of ['t.make', 't.notes']) registry.register({ type, category: 'video', inputs: [{ id: 'prompt', type: 'text', required: true }],
    outputs: [{ id: 'video', type: 'video' }], params: type === 't.notes' ? [{ id: 'feedback', kind: 'notes', items: 'prompt', default: {} }] : [],
    execute: async (ctx, inputs) => { calls.make++; return { variants: [{ video: video(`${ctx.nodeId}_${inputs.prompt.value.replace(/ /g, '_')}`) }] }; } });
  registry.register({ type: 't.cut', category: 'video', paid: true, cost: { unit: 'usd', estimate: () => 0.25 },
    inputs: [{ id: 'clips', type: 'video', multiple: true, required: true }], outputs: [{ id: 'video', type: 'video' }],
    timeline: ({ inputs }) => inputs.clips ? { duration: inputs.clips.items.length * 2, audio: null, clips: inputs.clips.items.map((_item, index) => ({
      key: `clip:${index}`, start: index * 2, duration: 2, kind: 'clip', label: '', text: `Line ${index}`, port: 'clips', item: index, lipsync: false })) } : null,
    execute: async () => { calls.cut++; return { variants: [{ video: video('film') }], cost: { usd: 0.25 } }; } });
  registry.register({ type: 't.down', category: 'video', paid: true, cost: { unit: 'usd', estimate: () => 0.5 },
    inputs: [{ id: 'video', type: 'video', required: true }], outputs: [{ id: 'video', type: 'video' }],
    execute: async (_ctx, inputs) => { calls.down++; return { variants: [inputs], cost: { usd: 0.5 } }; } });
  let seq = 0;
  const store = createWorkflowsStore({ dir, registry, sessions: {
    isValidId: sessions.isValidId, withLock: sessions.withLock, createSession: async () => ({ id: `session_${++seq}` }), deleteSession: async () => {}
  } });
  let engine;
  const service = createTimelineService({ store, registry, resolveAsset: async (value) => value, complete,
    runEngine: { isBusy: (id) => engine.isBusy(id), activeRun: (id) => engine.activeRun(id) } });
  engine = createEngine({ store, registry, checkTimelineReview: service.checkReview });
  const nodes = ['source', 'make', ...(notes ? ['notes'] : []), 'cut', 'down'].map((id) => ({ id, type: `t.${id}`, params: {}, x: 0, y: 0 }));
  const edge = (from, out, to, input) => ({ id: `e${++seq}`, from: { node: from, port: out }, to: { node: to, port: input } });
  const edges = [edge('source', 'texts', 'make', 'prompt'), edge('make', 'video', 'cut', 'clips'), edge('cut', 'video', 'down', 'video')];
  if (notes) edges.push(edge('source', 'texts', 'notes', 'prompt'), edge('notes', 'video', 'cut', 'clips'));
  const { workflow } = await store.createWorkflow({ name: 'Timeline test', owner: 'owner@example.com', graph: { nodes, edges } });
  const id = workflow.id;
  async function edit(fn) {
    const current = await store.readWorkflow(id);
    fn(current.graph);
    return store.saveGraph(id, { baseRev: current.rev, graph: current.graph });
  }
  async function run(request = {}) {
    const runId = await engine.start(id, request);
    let timer;
    try { return await Promise.race([engine.whenFinished(id, runId), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timeline run timed out (possible lock deadlock)')), 3000); })]); }
    finally { clearTimeout(timer); }
  }
  return { dir, id, store, registry, service, engine, calls, edit, run,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

module.exports = { fixture };
