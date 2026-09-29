'use strict';

// Starter templates of the node view (SPEC §15): all eight load and validate against the registry, texts
// exist in de/en/es (Swiss spelling), `requires` covers the node types, the localized documents create
// workflows through the real routes, and the batch template maps a text list through the engine (with
// fake executors derived from the real node definitions, so no provider is contacted).

const assert = require('assert/strict');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const higgsfieldLib = require('../lib/higgsfield');
const falLib = require('../lib/fal');
const templates = require('../lib/nodes/templates');
const nodeRegistry = require('../lib/nodes/registry');
const { createRegistry } = nodeRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore, validateDocument } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes } = require('../lib/nodes/routes');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { textValue, listValue } = require('../lib/nodes/types');

const EXPECTED = ['dub-clip', 'frame-chain', 'hero-variants', 'image-to-ad', 'masked-edit', 'motion-title', 'series-shots', 'talking-portrait'];

// requirement key that a node type needs (mirrors the availability predicates of the node modules)
function requirementOf(type) {
  if (type.startsWith('llm.')) return 'openrouter';
  if (['image.generate', 'image.edit', 'image.relight', 'video.seedance'].includes(type)) return 'openrouter';
  if (type === 'audio.tts') return 'elevenlabs';
  if (type.startsWith('fal.')) return 'fal';
  if (type === 'video.motion_graphics') return 'rendernode';
  if (type.startsWith('hf.') || ['image.higgsfield', 'video.higgsfield'].includes(type)) return 'higgsfield';
  const def = nodeRegistry.get(type);
  if (def && ['edit-image', 'edit-video', 'edit-audio'].includes(def.category)) return 'ffmpeg';
  if (['video.concat'].includes(type)) return 'ffmpeg';
  return null;
}

function get(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-templates-'));
  const createdSessions = [];
  const wfStore = createWorkflowsStore({ dir: tmpDir });
  const createdWorkflows = [];
  let server = null;

  try {
    /* ----- the eight templates exist, load and validate ----- */
    const all = templates.loadTemplates();
    assert.deepEqual(all.map((template) => template.id).sort(), EXPECTED);
    for (const template of all) {
      const result = templates.validateTemplate(template);
      assert.ok(result.graph.nodes.length >= 5, `${template.id} has a real graph`);
      assert.ok(result.app.enabled && result.app.inputs.length && result.app.outputs.length, `${template.id} ships a Design App`);
      assert.ok(result.graph.nodes.some((node) => node.type === 'output.result'), `${template.id} has an output node`);
      assert.ok(result.graph.notes.length >= 1, `${template.id} explains itself with a note`);
      assert.ok(template.description.length > 20);

      // every node type of the template is covered by `requires`
      const needed = new Set(result.graph.nodes.map((node) => requirementOf(node.type)).filter(Boolean));
      for (const key of needed) assert.ok(template.requires.includes(key), `${template.id}: requires must include ${key}`);
      for (const key of template.requires) assert.ok(needed.has(key), `${template.id}: requires lists ${key} but no node needs it`);

      // exposed media/text inputs must be inputs of the graph or generation params that exist
      for (const entry of result.app.inputs) {
        const node = result.graph.nodes.find((item) => item.id === entry.node);
        assert.ok(node, `${template.id}: app input node ${entry.node}`);
        const def = nodeRegistry.get(node.type);
        assert.ok(def.params.some((param) => param.id === entry.param), `${template.id}: ${node.type} has no param ${entry.param}`);
        assert.ok(entry.label.length > 2);
      }
      for (const entry of result.app.outputs) {
        assert.equal(result.graph.nodes.find((item) => item.id === entry.node).type, 'output.result');
      }
    }

    // specific graph shapes the spec promises
    const byId = Object.fromEntries(all.map((template) => [template.id, template]));
    const types = (id) => byId[id].graph.nodes.map((node) => node.type);
    assert.deepEqual(types('hero-variants'), ['input.text', 'llm.prompt_enhancer', 'image.generate', 'image.resize', 'output.result']);
    assert.equal(byId['hero-variants'].graph.nodes.find((node) => node.type === 'image.generate').params.count, 4);
    assert.ok(types('image-to-ad').includes('llm.image_describer') && types('image-to-ad').includes('audio.tts') && types('image-to-ad').includes('video.merge_audio'));
    assert.ok(types('series-shots').includes('input.text_list') && types('series-shots').includes('video.concat'));
    assert.ok(byId['series-shots'].graph.nodes.find((node) => node.type === 'input.text_list').params.text.split('\n').length === 3);
    assert.ok(types('frame-chain').filter((type) => type === 'video.seedance').length === 2 && types('frame-chain').includes('video.extract_frame'));
    assert.equal(byId['frame-chain'].graph.nodes.find((node) => node.type === 'video.extract_frame').params.position, 'last');
    assert.ok(types('motion-title').includes('llm.motion_html') && types('motion-title').includes('video.motion_graphics') && types('motion-title').includes('input.video'));
    assert.ok(types('masked-edit').includes('image.mask_apply') && types('masked-edit').includes('image.composite'));
    // dub-clip: one source video fans out to three dubbing nodes (deu, fra, ita) that all feed the result node
    assert.deepEqual(types('dub-clip'), ['input.video', 'hf.dubbing', 'hf.dubbing', 'hf.dubbing', 'output.result']);
    assert.deepEqual(byId['dub-clip'].graph.nodes.filter((node) => node.type === 'hf.dubbing').map((node) => node.params.target_language), ['deu', 'fra', 'ita']);
    assert.deepEqual(byId['dub-clip'].requires, ['higgsfield']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.from.node === 'n1').map((edge) => edge.to.node), ['n2', 'n3', 'n4']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.to.node === 'n5').map((edge) => edge.from.node), ['n2', 'n3', 'n4']);
    assert.equal(templates.resolveTemplate('dub-clip', { lang: 'de' }).name, 'Clip in drei Landessprachen');
    // talking-portrait: portrait + script -> ElevenLabs voice -> H3 Max lip sync on fal.ai -> result
    assert.deepEqual(types('talking-portrait'), ['input.image', 'input.text', 'audio.tts', 'fal.h3_lipsync', 'output.result']);
    assert.deepEqual(byId['talking-portrait'].requires, ['fal', 'elevenlabs']);
    assert.deepEqual(
      byId['talking-portrait'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n2.text>n3.text', 'n1.image>n4.image', 'n3.audio>n4.audio', 'n4.video>n5.inputs']
    );
    assert.equal(byId['talking-portrait'].app.enabled, true);
    assert.deepEqual(byId['talking-portrait'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.text', 'n4.resolution']);
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'de' }).name, 'Sprechendes Porträt (H3 Max Lip Sync)');
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'en' }).name, 'Talking portrait (H3 Max lip sync)');
    assert.ok(/Retrato parlante/.test(templates.resolveTemplate('talking-portrait', { lang: 'es' }).name));
    // frame-chain: the clip edges into concat are in playback order
    const concatEdges = byId['frame-chain'].graph.edges.filter((edge) => edge.to.port === 'clips');
    assert.deepEqual(concatEdges.map((edge) => edge.from.node), ['n2', 'n5']);

    /* ----- localization: de/en/es complete, Swiss spelling ----- */
    for (const template of all) {
      const i18n = template.i18n || {};
      const en = templates.localizeTemplate(template, 'en');
      assert.equal(en.name, template.name);
      assert.equal(en.i18n, undefined, 'the i18n block is not part of the workflow document');
      const expectedKeys = new Set(['name', 'description', 'app.title', 'app.description']);
      for (const node of template.graph.nodes) if (node.title) expectedKeys.add(`node.${node.id}`);
      for (const note of template.graph.notes) expectedKeys.add(`note.${note.id}`);
      for (const group of template.graph.groups) expectedKeys.add(`group.${group.id}`);
      for (const entry of template.app.inputs) expectedKeys.add(`app.input.${entry.node}.${entry.param}`);
      for (const entry of template.app.outputs) expectedKeys.add(`app.output.${entry.node}`);
      for (const lang of ['de', 'es']) {
        const strings = i18n[lang];
        assert.ok(strings, `${template.id} has ${lang} texts`);
        for (const key of expectedKeys) assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${template.id}.${lang} misses ${key}`);
        for (const key of Object.keys(strings)) {
          const valid = expectedKeys.has(key) || /^param\.[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/.test(key);
          assert.ok(valid, `${template.id}.${lang} has an unknown key ${key}`);
          if (key.startsWith('param.')) {
            const [, nodeId, paramId] = key.split('.');
            assert.equal(typeof template.graph.nodes.find((node) => node.id === nodeId).params[paramId], 'string', `${key} overrides a string param`);
          }
        }
        const localized = templates.localizeTemplate(template, lang);
        assert.notEqual(localized.name, template.name);
        validateDocument({ format: 'ocd.workflow', version: 1, name: localized.name, description: localized.description, graph: localized.graph, app: localized.app });
        for (const text of collectStrings(localized)) assert.equal(text.includes('ß'), false, `${template.id}.${lang}: no sharp s (${text.slice(0, 40)})`);
      }
      // unknown languages fall back to English
      assert.equal(templates.localizeTemplate(template, 'fr').name, template.name);
      assert.equal(templates.pickLang('DE-CH'), 'de');
    }

    /* ----- listing and availability ----- */
    {
      const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
      const listed = templates.listTemplates({ lang: 'de', checks: allOn });
      assert.deepEqual(listed.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.every((item) => item.available && item.missing.length === 0));
      const noAudio = templates.listTemplates({ lang: 'en', checks: { ...allOn, elevenlabs: () => 'ELEVENLABS_API_KEY is not set' } });
      const ad = noAudio.find((item) => item.id === 'image-to-ad');
      assert.equal(ad.available, false);
      assert.deepEqual(ad.missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.ok(noAudio.filter((item) => !['image-to-ad', 'talking-portrait'].includes(item.id)).every((item) => item.available));
      assert.deepEqual(noAudio.find((item) => item.id === 'talking-portrait').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      // Higgsfield is a requirement of its own: a template with hf.* nodes is available exactly when Higgsfield is connected
      const noHiggsfield = templates.listTemplates({ lang: 'en', checks: { ...allOn, higgsfield: () => 'Higgsfield is not connected' } });
      const dub = noHiggsfield.find((item) => item.id === 'dub-clip');
      assert.equal(dub.available, false);
      assert.deepEqual(dub.missing, [{ key: 'higgsfield', reason: 'Higgsfield is not connected' }]);
      assert.deepEqual(dub.requires, ['higgsfield']);
      assert.ok(noHiggsfield.filter((item) => item.id !== 'dub-clip').every((item) => item.available));
      // fal.ai is a requirement of its own: available exactly when FAL_KEY is set
      const noFal = templates.listTemplates({ lang: 'en', checks: { ...allOn, fal: () => 'FAL_KEY is not set' } });
      const portrait = noFal.find((item) => item.id === 'talking-portrait');
      assert.equal(portrait.available, false);
      assert.deepEqual(portrait.missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }]);
      assert.deepEqual(portrait.requires, ['fal', 'elevenlabs']);
      assert.ok(noFal.filter((item) => item.id !== 'talking-portrait').every((item) => item.available));
      const originalHasKey = falLib.hasKey;
      try {
        falLib.hasKey = () => true;
        assert.equal(templates.REQUIREMENT_CHECKS.fal(), true);
        falLib.hasKey = () => false;
        assert.match(templates.REQUIREMENT_CHECKS.fal(), /FAL_KEY/);
      } finally {
        falLib.hasKey = originalHasKey;
      }
      // the real check follows the connection state (mocked: no provider is contacted)
      const originalStatus = higgsfieldLib.status;
      try {
        higgsfieldLib.status = () => ({ connected: true });
        assert.equal(templates.REQUIREMENT_CHECKS.higgsfield(), true);
        higgsfieldLib.status = () => ({ connected: false });
        assert.match(templates.REQUIREMENT_CHECKS.higgsfield(), /Higgsfield/);
      } finally {
        higgsfieldLib.status = originalStatus;
      }
      assert.equal(noAudio.find((item) => item.id === 'series-shots').batch, true);
      assert.equal(noAudio.find((item) => item.id === 'hero-variants').batch, false);
      assert.equal(templates.listTemplates({ lang: 'de', checks: allOn }).find((item) => item.id === 'hero-variants').name, 'Produkt-Hero, 4 Varianten');
      assert.equal(templates.resolveTemplate('nope'), null);
      assert.equal(templates.resolveTemplate('hero-variants', { lang: 'es' }).graph.nodes[0].title, 'Escena de producto');
      // the real checks answer true or a reason string
      for (const item of templates.listTemplates()) assert.ok(typeof item.available === 'boolean');
    }

    /* ----- creation through the real routes: every template becomes a workflow ----- */
    {
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      const bus = createEventBus();
      const engine = createEngine({ store: wfStore, registry: nodeRegistry.registry, events: bus, getConfig: () => ({ imageModel: 'x' }) });
      registerNodeRoutes(app, { engine, store: wfStore, events: bus });
      server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = server.address().port;

      const listed = await get(port, 'GET', '/api/workflow-templates?lang=de');
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json.templates.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.json.templates.every((item) => item.name && item.description && Array.isArray(item.requires)));

      for (const id of EXPECTED) {
        const created = await get(port, 'POST', '/api/workflows', { templateId: id, lang: 'de' });
        assert.equal(created.status, 201, `${id}: ${JSON.stringify(created.json)}`);
        createdWorkflows.push(created.json.workflow.id);
        createdSessions.push(created.json.workflow.sessionId);
        const wf = created.json.workflow;
        assert.equal(wf.name, templates.resolveTemplate(id, { lang: 'de' }).name);
        assert.equal(wf.app.enabled, true);
        assert.equal(wf.graph.nodes.length, byId[id].graph.nodes.length);
        // media inputs come without an asset; the copy is a fresh workflow with its own backing session
        assert.equal(wf.rev, 1);
        assert.equal((await store.readSession(wf.sessionId)).kind, 'workflow');
        const plan = await get(port, 'POST', `/api/workflows/${wf.id}/runs/plan`, { mode: 'all' });
        assert.equal(plan.status, 200, `${id} plan: ${JSON.stringify(plan.json)}`);
        assert.equal(Object.keys(plan.json.nodes).length, wf.graph.nodes.length, 'the plan covers every node');
      }
      assert.equal((await get(port, 'POST', '/api/workflows', { templateId: 'nope' })).status, 404);
      const named = await get(port, 'POST', '/api/workflows', { templateId: 'hero-variants', name: 'My hero' });
      createdWorkflows.push(named.json.workflow.id);
      createdSessions.push(named.json.workflow.sessionId);
      assert.equal(named.json.workflow.name, 'My hero', 'an explicit name wins over the template name');
    }

    /* ----- batch: a text list is mapped through the series-shots graph ----- */
    {
      // fake executors on the real definitions (same ports and params, no provider)
      const registry = createRegistry();
      nodesBasic.registerAll(registry);
      const seen = { edit: [], video: [], concat: [] };
      const fakeImage = (name) => ({ type: 'image', sessionId: 'fake-session', assetId: `img-${name}`, file: `${name}.png`, url: `/assets/fake-session/${name}.png` });
      const fakeVideo = (name) => ({ type: 'video', sessionId: 'fake-session', assetId: `vid-${name}`, file: `${name}.mp4`, url: `/assets/fake-session/${name}.mp4` });
      const fake = (type, execute) => {
        const def = nodeRegistry.get(type);
        registry.register({ ...def, available: () => true, validate: undefined, cost: undefined, execute });
      };
      registry.unregister('input.image');
      fake('input.image', async () => ({ variants: [{ image: fakeImage('ref') }] }));
      fake('image.edit', async (ctx, inputs) => {
        seen.edit.push(inputs.prompt.value);
        return { variants: [{ image: fakeImage(`edit${ctx.itemIndex}`) }] };
      });
      fake('video.seedance', async (ctx, inputs) => {
        seen.video.push(inputs.first_frame.assetId);
        return { variants: [{ video: fakeVideo(`clip${ctx.itemIndex}`) }] };
      });
      fake('video.concat', async (_ctx, inputs) => {
        const clips = inputs.clips.type === 'list' ? inputs.clips.items : [inputs.clips];
        seen.concat.push(clips.map((clip) => clip.assetId));
        return { variants: [{ video: fakeVideo('series') }] };
      });

      const bus = createEventBus();
      const localStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
      const engine = createEngine({ store: localStore, registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20 } });
      const doc = templates.resolveTemplate('series-shots', { lang: 'en' });
      // the image input needs no upload for the fake executor, but validation wants a resolvable asset param
      const created = await localStore.createWorkflow({ document: doc });
      createdWorkflows.push(created.workflow.id);
      createdSessions.push(created.workflow.sessionId);
      const id = created.workflow.id;

      const runId = await engine.start(id, { mode: 'all', user: 'tester' });
      const record = await engine.whenFinished(id, runId);
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(seen.edit.length, 3, 'one image edit per scene line');
      assert.deepEqual(seen.edit, [
        'The character walks through a sunlit market',
        'The character sits at a cafe window while it rains',
        'The character looks over the city from a rooftop at dusk'
      ]);
      assert.equal(seen.video.length, 3, 'one clip per still');
      assert.equal(seen.concat.length, 1, 'the clips are joined once');
      assert.equal(seen.concat[0].length, 3, 'concat receives all three clips');

      // overrides of the Design App: two scenes instead of three
      seen.edit.length = 0;
      seen.video.length = 0;
      seen.concat.length = 0;
      const second = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'one\ntwo' } } });
      const secondRecord = await engine.whenFinished(id, second);
      assert.equal(secondRecord.status, 'completed');
      assert.deepEqual(seen.edit, ['one', 'two']);
      assert.equal(seen.concat[0].length, 2);
      const saved = await localStore.readWorkflow(id);
      assert.equal(saved.graph.nodes.find((node) => node.id === 'n2').params.text.split('\n').length, 3, 'overrides never change the saved graph');
      const results = await localStore.readResults(id);
      const outVariant = results.nodes.n6.history[0].variants[0];
      assert.equal(outVariant.result.type === 'video' || outVariant.result.type === 'list', true);

      // a listed input: app override of one item runs the map once
      seen.edit.length = 0;
      const third = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'solo' } } });
      await engine.whenFinished(id, third);
      assert.deepEqual(seen.edit, ['solo']);
      void textValue;
      void listValue;
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const workflowId of createdWorkflows) await wfStore.deleteWorkflow(workflowId).catch(() => {});
    for (const sessionId of createdSessions) await store.deleteSession(sessionId).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-templates ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
