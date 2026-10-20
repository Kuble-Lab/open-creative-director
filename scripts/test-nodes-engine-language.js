'use strict';

// Interface fallback through planning, execution, cached lookups and approval. Real language stamps, fake executors: no providers.
const assert = require('assert/strict');
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { createIsolatedApp } = require('./support/isolated-app');

async function main() {
  const iso = await createIsolatedApp({ loadServer: false });
  const fetchBefore = global.fetch;
  global.fetch = () => { throw new Error('No network in this test'); };
  try {
    const sessions = iso.load('lib/store');
    await sessions.ensureDirs();
    const { createRegistry } = iso.load('lib/nodes/registry');
    const { definitions } = iso.load('lib/nodes/nodes-explainer');
    const { createEngine, resolveStamp, computeCacheKey } = iso.load('lib/nodes/engine');
    const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
    const { textValue, listValue, sha256Hex, canonicalJson } = iso.load('lib/nodes/types');
    const registry = createRegistry();
    const seen = [];
    for (const type of ['llm.research', 'explainer.plan']) {
      const def = definitions.find((item) => item.type === type);
      registry.register({ ...def, paid: false, available: () => true, execute: async (ctx) => {
        const cached = await ctx.cachedResult({ language: 'auto' });
        seen.push({ type, uiLang: ctx.uiLang, cached });
        // The engine must pass the same interface language to an executor's cache lookup as to its own lookup.
        assert.equal(await ctx.cachedResult({ language: 'es' }), null);
        return { variants: [{ [type === 'llm.research' ? 'notes' : 'script']: textValue(ctx.uiLang) }] };
      } });
    }
    const store = createWorkflowsStore({ dir: path.join(iso.root, 'test-workflows'), registry });
    const config = { defaultBrain: 'test/brain' };
    const engine = createEngine({ store, registry, getConfig: () => config });
    const make = async (type, params = {}) => (await store.createWorkflow({ graph: { nodes: [
      { id: 'n', type, typeVersion: 1, x: 0, y: 0, params: { model: 'test/model', topic: 'Git vs GitHub', language: 'auto', ...params } }
    ], edges: [] } })).workflow;
    const run = async (workflow, uiLang, extra = {}) => {
      const record = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { uiLang, ...extra }));
      assert.equal(record.status, 'completed', JSON.stringify(record.error));
      return record;
    };
    for (const type of ['llm.research', 'explainer.plan']) {
      const workflow = await make(type);
      for (const uiLang of ['de', 'es', 'en']) {
        assert.equal((await engine.plan(workflow.id, { uiLang })).nodes.n.status, 'stale');
        const before = seen.length;
        const record = await run(workflow, uiLang);
        assert.equal(record.uiLang, uiLang);
        assert.equal(seen.length, before + 1);
        assert.equal(seen.at(-1).uiLang, uiLang);
        assert.equal((await engine.plan(workflow.id, { uiLang })).nodes.n.status, 'cached');
      }
      const before = seen.length;
      await run(workflow, 'de');
      await run(workflow); // historical API fallback: English
      assert.equal(seen.length, before, 'each language reuses only its own fallback result');
      await run(workflow, 'de', { force: true });
      assert.equal(seen.at(-1).cached[type === 'llm.research' ? 'notes' : 'script'].value, 'de', 'executor cache lookup uses the same fallback');
      for (const bad of ['fr', '', null, {}, ['de']]) {
        await assert.rejects(engine.plan(workflow.id, { uiLang: bad }), { code: 'INVALID_REQUEST' });
        await assert.rejects(engine.start(workflow.id, { uiLang: bad }), { code: 'INVALID_REQUEST' });
      }
      for (const params of [
        { language: 'en' }, {}, { topic: 'Wie funktioniert Git' }, { topic: 'Wie funktioniert Git und GitHub' },
        { topic: 'Geschichte Programmiersprache Python' }
      ]) {
        // {} below means a saved node without the language param, not a new auto node.
        const fixed = Object.keys(params).length ? params : { language: undefined };
        const wf = await make(type, fixed);
        const def = registry.get(type);
        const normal = registry.normalizeParams(def, wf.graph.nodes[0].params);
        const inputs = { topic: textValue(normal.topic) };
        if (type === 'llm.research') inputs.focus = textValue('');
        else inputs.brief = textValue('');
        const oldRaw = type === 'explainer.plan' ? { images: { image: false, fal: false } } : undefined;
        // No keys churn for fixed, clear or weak input: compare with the exact pre-change stamp payload.
        const oldStamp = oldRaw ? `st:${sha256Hex(canonicalJson(oldRaw))}` : undefined;
        for (const uiLang of ['de', 'es', 'en']) {
          const found = await resolveStamp(def, normal, inputs, null, { uiLang, config });
          assert.equal(found.stamp, oldStamp, `${type}: historical stamp unchanged`);
          assert.equal(computeCacheKey(def, normal, inputs, found.stamp), computeCacheKey(def, normal, inputs, oldStamp));
        }
        await run(wf, 'de');
        const count = seen.length;
        assert.equal((await engine.plan(wf.id, { uiLang: 'es' })).nodes.n.status, 'cached');
        await run(wf, 'es');
        assert.equal(seen.length, count, 'fixed language and evidence share cached work between interfaces');
      }
    }
    // Every input that execution asks must also be considered by the stamp (including weak hints).
    for (const type of ['llm.research', 'explainer.plan']) {
      const def = registry.get(type);
      const params = registry.normalizeParams(def, { language: 'auto', model: 'test/model' });
      const ports = type === 'llm.research' ? ['topic', 'focus'] : ['topic', 'brief', 'text', 'own_text', 'notes', 'sources'];
      for (const port of ports) {
        for (const hint of ['Wie funktioniert Git', 'Geschichte Programmiersprache Python']) {
          const inputs = { [port]: textValue(hint) };
          const english = await def.cacheStamp(params, { inputs, config, uiLang: 'en' });
          assert.deepEqual(await def.cacheStamp(params, { inputs, config, uiLang: 'es' }), english, `${type}.${port}: evidence shares cache`);
        }
      }
    }
    for (const type of ['llm.research', 'explainer.plan']) {
      const def = registry.get(type);
      const params = registry.normalizeParams(def, { language: 'auto', model: 'test/model' });
      const hinted = { topic: listValue('text', [textValue('Wie funktioniert Git'), textValue('How does Git work')]) };
      const old = await def.cacheStamp(params, { inputs: hinted, config, uiLang: 'en' });
      assert.deepEqual(await def.cacheStamp(params, { inputs: hinted, config, uiLang: 'de' }), old, 'hinted mapped inputs keep historical keys');
      const mixed = { topic: listValue('text', [textValue('Wie funktioniert Git'), textValue('Git vs GitHub')]) };
      assert.equal((await def.cacheStamp(params, { inputs: mixed, config, uiLang: 'de' })).fallbackLanguage, 'de', 'one mapped fallback makes the whole result depend on the interface');
    }
    const titleDef = registry.get('explainer.plan');
    const titleParams = registry.normalizeParams(titleDef, { language: 'auto', model: 'test/model' });
    const docInputs = { documents: listValue('document', [{ type: 'document', name: 'Geschichte Programmiersprache.pdf' }]) };
    assert.deepEqual(await titleDef.cacheStamp(titleParams, { inputs: docInputs, config, uiLang: 'de' }),
      await titleDef.cacheStamp(titleParams, { inputs: docInputs, config, uiLang: 'en' }), 'document list is whole, its titles are hints');
    // A planner result from before capability stamps must never be adopted for a non-English fallback.
    const def = registry.get('explainer.plan');
    const params = registry.normalizeParams(def, { language: 'auto', model: 'test/model' });
    const inputs = { topic: textValue('Git vs GitHub') };
    const old = { id: 'old', cacheKey: computeCacheKey(def, params, inputs), variants: [{ script: textValue('old English') }] };
    assert.equal((await resolveStamp(def, params, inputs, { history: [old] }, { uiLang: 'de', config })).adopt, null);
    assert.equal((await resolveStamp(def, params, inputs, { history: [old] }, { uiLang: 'en', config })).adopt, old);
    // An edited script supplies its own language, so its key never follows the interface.
    const edited = { ...params, script: JSON.stringify({ language: 'es', scenes: [] }) };
    const stampEn = await def.cacheStamp(edited, { inputs, config, uiLang: 'en' });
    assert.deepEqual(await def.cacheStamp(edited, { inputs, config, uiLang: 'de' }), stampEn);

    // Approval keeps the initiating language. The node's key has already been computed when it waits.
    let approve;
    const waiting = new Promise((resolve) => { approve = resolve; });
    const { createEventBus } = iso.load('lib/nodes/events');
    const events = createEventBus();
    registry.register({ type: 't.approval', category: 'text', paid: true, outputs: [{ id: 'out', type: 'text' }],
      cost: { unit: 'usd', estimate: () => 1 }, execute: async (ctx) => ({ variants: [{ out: textValue(ctx.uiLang) }], cost: { usd: 0 } }) });
    const approvalEngine = createEngine({ store, registry, events, getConfig: () => config });
    const wf = await make('t.approval');
    const off = events.subscribe(wf.id, (event) => { if (event.type === 'run_approval' && event.approval) approve(); });
    const id = await approvalEngine.start(wf.id, { uiLang: 'de', maxUsd: 0 });
    await waiting;
    await assert.rejects(approvalEngine.resume(wf.id, id, { uiLang: 'fr', maxUsd: 1 }), { code: 'INVALID_REQUEST' });
    await approvalEngine.resume(wf.id, id, { uiLang: 'es', maxUsd: 1 });
    const done = await approvalEngine.whenFinished(wf.id, id);
    off();
    assert.equal(done.status, 'completed');
    assert.equal(done.uiLang, 'de');
    assert.equal((await store.readResults(wf.id)).nodes.n.history[0].variants[0].out.value, 'de');

    // Browser API wrappers are shared by canvas and app mode; they read getLang at request time, including after a switch.
    const sent = [];
    let lang = 'de';
    const window = { getLang: () => lang };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/nodes/api.js'), 'utf8'), { window,
      fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({}) }; } });
    await window.OCDNodes.api.plan('wf', {});
    await window.OCDNodes.api.startRun('wf', {});
    lang = 'es';
    await window.OCDNodes.api.resumeRun('wf', 'r', { maxUsd: 1 });
    lang = 'fr';
    await window.OCDNodes.api.startRun('wf', {});
    assert.deepEqual(sent.map((body) => body.uiLang), ['de', 'de', 'es', 'en']);
    console.log('test-nodes-engine-language.js: ok');
  } finally {
    global.fetch = fetchBefore;
    await iso.cleanup();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
