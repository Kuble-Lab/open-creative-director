'use strict';

// The guest template through the real engine, including an empty mapped paid reference node and the real edit adapter. Provider boundaries
// and local rendering are doubles; no sockets or credentials are needed. Both an empty list and a populated list run through the template's
// own edges, so Image 1 / Image 2 ordering and scalar audio mapping cannot drift into the multi-reference audios contract.
const assert = require('assert/strict');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');

async function main() {
  const iso = await createIsolatedApp({ loadServer: false });
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('Network access is forbidden in the duet template test'); };
  try {
    await iso.load('lib/store').ensureDirs();
    const { textValue, listValue } = iso.load('lib/nodes/types');
    const assets = iso.load('lib/nodes/assets');
    const editOps = iso.load('lib/nodes/nodes-edit');
    const edits = [];
    assets.assetFilePath = (value) => `/${value.assetId}.${value.type === 'audio' ? 'wav' : 'mp4'}`;
    editOps.runOp = async (_ctx, operation) => {
      const infos = operation.files.map((_file, index) => ({ duration: 6, audio: index === 0 ? {} : null, video: index ? {} : null }));
      const built = await operation.build(infos, { scratch: iso.root });
      edits.push({ files: operation.files, built });
      return [{ type: 'video', sessionId: 'test', assetId: 'finished' }];
    };
    const registryModule = iso.load('lib/nodes/registry');
    const { createEngine } = iso.load('lib/nodes/engine');
    const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
    const { createEventBus } = iso.load('lib/nodes/events');
    const template = require('../lib/nodes/templates/music-video-hud-guest.json');
    const calls = [];
    const registry = registryModule.createRegistry();
    let duetCount = 0;
    const valueOf = (type, ctx, port) => {
      if (type.endsWith('[]')) return listValue(type.slice(0, -2), []);
      if (type === 'number') return { type: 'number', value: 120 };
      if (type === 'text' || type === 'any') return textValue('fixture');
      return { type, sessionId: ctx.sessionId, assetId: `${ctx.nodeId}-${port}`, duration: 6 };
    };
    for (const type of new Set(template.graph.nodes.map((node) => node.type))) {
      const def = registryModule.get(type);
      registry.register({ ...def, available: () => true, prepare: undefined, validate: undefined,
        paid: type === 'fal.h3_reference', cost: type === 'fal.h3_reference' ? def.cost : { unit: 'local' },
        execute: type === 'music_video.edit' ? def.execute : async (ctx, inputs) => {
          calls.push({ node: ctx.nodeId, inputs });
          const output = Object.fromEntries(def.outputs.map((port) => [port.id, valueOf(port.type, ctx, port.id)]));
          if (type === 'music_video.hud_plan') {
            const shots = [{ start: 0, end: 6, kind: 'story', clip: 0 }];
            for (let index = 0; index < duetCount; index += 1) shots.push({ start: 6 + index * 6, end: 12 + index * 6, kind: 'performance', voice: 'duet', clip: index });
            output.shots = textValue(JSON.stringify({ shots }));
            output.story_prompts = listValue('text', [textValue('story')]);
            output.story_motion = listValue('text', [textValue('motion')]);
            output.duet_prompts = listValue('text', Array.from({ length: duetCount }, (_v, index) => textValue(`duet-${index}`)));
            output.duet_audio = listValue('audio', Array.from({ length: duetCount }, (_v, index) => ({ type: 'audio', sessionId: ctx.sessionId, assetId: `duet-${index}`, duration: 6 })));
          }
          return { variants: [output], ...(type === 'fal.h3_reference' ? { cost: { usd: 0.48 } } : {}) };
        }
      });
    }
    const events = createEventBus();
    const store = createWorkflowsStore({ dir: path.join(iso.root, 'workflows'), registry, events });
    const engine = createEngine({ store, registry, events, getConfig: () => ({}) });
    for (const count of [0, 2]) {
      duetCount = count;
      calls.length = 0;
      const { workflow } = await store.createWorkflow({ name: `Duet template ${count}`, graph: template.graph });
      const before = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(before.valid, true, JSON.stringify(before.issues));
      const id = await engine.start(workflow.id, { mode: 'all' });
      const run = await engine.whenFinished(workflow.id, id);
      assert.equal(run.status, 'completed', JSON.stringify(run.nodes));
      const reference = calls.filter((call) => call.node === 'n37');
      assert.equal(reference.length, count, 'an empty duet list executes no paid node; populated scalar lists zip into one run per duet');
      assert.equal(run.cost.usd || 0, count * 0.48);
      assert.equal(edits.at(-1).built.summary.length, 1 + count, 'the real edit finishes with zero or two duet clips');
      assert.equal(edits.at(-1).files.length, 2 + count);
      for (const [index, call] of reference.entries()) {
        assert.equal(call.inputs.prompt.value, `duet-${index}`);
        assert.equal(call.inputs.audio.assetId, `duet-${index}`);
        assert.deepEqual(call.inputs.images.items.map((image) => image.assetId), ['n5-image', 'n35-image']);
        assert.ok(!call.inputs.audios);
      }
      const after = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(after.valid, true);
      if (!count) assert.equal(after.nodes.n37.executions, 0, 'the resolved template plan prices zero duet executions');
    }
  } finally {
    global.fetch = originalFetch;
    await iso.cleanup();
  }
  console.log('test-music-video-hud-duet-template.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
