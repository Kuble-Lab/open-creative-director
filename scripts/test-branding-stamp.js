'use strict';

// A changed branding is noticed (WP38g). input.branding puts a hash of everything it gives out into its cache key (profile text, the bytes of
// the logo, the speaker voice), keeps the logo asset when the bytes are the same, and what reads state of the app besides parameters and inputs
// has a stamp of the same kind:
//   - a changed tone: the branding and the planner run again, the plan shows them with the price; scenes and speaker stay cached
//   - only the logo (the profile text is the same): scenes and the cut run again, the planner stays cached
//   - only the speaker voice: the speaker and the cut run again, the planner and the scenes stay cached
//   - an unchanged branding: nothing after the node runs again, also with an old entry (no stamp, no hash) and after a forced run of the node
//   - the logo of the same bytes keeps its asset (sessionId and assetId), also when it is back after a change
//   - no branding, a guest, a missing branding: no stamp / a stamp of its own
//   - the font files of a scene and the default models of the settings have stamps (and no stamp where the parameter names the model)
// A private copy of the app runs in a temp directory; fake nodes stand for the paid nodes. Nothing is paid.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const { createIsolatedApp } = require('./support/isolated-app');

const STAFF = 'staff1@staff.example.com';
const GUEST = 'guest1@gmail.example';

function pngOf(red, green, blue) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from([red, green, blue, red, green, blue])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}

const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
const edge = (id, from, to) => {
  const [fromNode, fromPort] = from.split('.');
  const [toNode, toPort] = to.split('.');
  return { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
};

async function main() {
  const iso = await createIsolatedApp({
    env: { ADMIN_EMAILS: '', SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com', OPENROUTER_API_KEY: '', GTS_API_TOKEN: '', PUBLIC_BASE_URL: '' }
  });
  try {
    await run(iso);
  } finally {
    await iso.cleanup();
  }
  console.log('test-branding-stamp.js: ok');
}

async function run(iso) {
  const brandings = iso.load('lib/brandings');
  const store = iso.load('lib/store');
  const { createRegistry } = iso.load('lib/nodes/registry');
  const realRegistry = iso.load('lib/nodes/registry').registry;
  const explainerNodes = iso.load('lib/nodes/nodes-explainer');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine, computeCacheKey, resolveStamp } = iso.load('lib/nodes/engine');
  const { textValue, sha256Hex } = iso.load('lib/nodes/types');
  const assets = iso.load('lib/nodes/assets');

  /* ---------- the branding of the test ---------- */

  const logoRed = pngOf(200, 20, 20);
  const logoBlue = pngOf(20, 20, 200);
  const branding = await brandings.createBranding({ name: 'Acme', description: 'A brand' });
  const saved = await brandings.saveBrandingAsset(branding.id, { buffer: logoRed, filename: 'logo.png' });
  await brandings.updateBranding(branding.id, {
    colors: [{ role: 'primary', name: 'Ocean', hex: '#0055AA', usage: 'headlines' }],
    logos: [{ variant: 'main', file: saved.file, usage: 'screen' }],
    voice: { tone: 'warm', language: 'de', dos: 'short', donts: 'jargon' },
    speaker: { voiceId: 'voice-1', name: 'Anna' },
    guidelines: 'Rule.'
  });
  const logoPath = path.join(iso.root, 'data', 'brandings', branding.id, 'assets', saved.filename);
  const exists = await fsp.access(logoPath).then(() => true, () => false);
  assert.ok(exists, `the logo file is where the test expects it: ${logoPath}`);

  /* ---------- the nodes after it: fakes that count their runs ---------- */

  const counts = {};
  const counted = (ctx) => {
    counts[ctx.nodeId] = (counts[ctx.nodeId] || 0) + 1;
  };
  const registry = createRegistry();
  registry.register(explainerNodes.definitions.find((definition) => definition.type === 'input.branding'));
  const paid = (type, inputs, usd, body) =>
    registry.register({
      type,
      category: 'text',
      inputs,
      outputs: [{ id: 'out', type: 'text' }],
      paid: true,
      cost: { unit: 'usd', estimate: () => ({ usd }) },
      execute: async (ctx, got) => {
        counted(ctx);
        return { variants: [{ out: textValue(body(got)) }], cost: { usd } };
      }
    });
  // planner: reads the profile text; scene: the logo; speaker: the voice; cut: scene and speaker
  paid('t.planner', [{ id: 'brand', type: 'text', required: true }], 0.5, (got) => `plan(${sha256Hex(got.brand.value).slice(0, 8)})`);
  paid('t.scene', [{ id: 'logo', type: 'image', required: true }], 0.3, (got) => `scene(${got.logo.assetId})`);
  paid('t.speaker', [{ id: 'voice', type: 'text' }], 0.1, (got) => `voice(${got.voice ? got.voice.value : 'own'})`);
  paid('t.cut', [{ id: 'scene', type: 'text', required: true }, { id: 'speaker', type: 'text', required: true }], 0.2, (got) => `cut(${got.scene.value},${got.speaker.value})`);

  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-stamp'), registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20 } });
  const created = [];
  const makeWorkflow = async (nodes, edges, name) => {
    const result = await wfStore.createWorkflow({ name, graph: { nodes, edges } });
    created.push(result.workflow.id);
    return result.workflow;
  };
  const start = async (workflowId, request = {}) => engine.whenFinished(workflowId, await engine.start(workflowId, { mode: 'all', user: STAFF, ...request }));
  const planOf = (workflowId, request = {}) => engine.plan(workflowId, { mode: 'all', user: STAFF, ...request });
  const statuses = (record) => Object.fromEntries(Object.entries(record.nodes).map(([id, entry]) => [id, entry.status]));
  const planStatuses = (plan) => Object.fromEntries(Object.entries(plan.nodes).map(([id, entry]) => [id, entry.status]));
  const history = async (workflowId, nodeId) => (await wfStore.readResults(workflowId)).nodes[nodeId].history;
  const reset = () => Object.keys(counts).forEach((key) => delete counts[key]);

  const graph = [
    [node('b', 'input.branding', { branding: branding.id }), node('plan', 't.planner'), node('scene', 't.scene'), node('speaker', 't.speaker'), node('cut', 't.cut')],
    [edge('e1', 'b.brand', 'plan.brand'), edge('e2', 'b.logo', 'scene.logo'), edge('e3', 'b.voice', 'speaker.voice'), edge('e4', 'scene.out', 'cut.scene'), edge('e5', 'speaker.out', 'cut.speaker')]
  ];
  const wf = await makeWorkflow(graph[0], graph[1], 'branding');
  const ALL_CACHED = { b: 'cached', plan: 'cached', scene: 'cached', speaker: 'cached', cut: 'cached' };

  /* ---------- the first run and an unchanged branding ---------- */

  let first = await start(wf.id);
  assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
  assert.deepEqual(counts, { plan: 1, scene: 1, speaker: 1, cut: 1 });
  const entry1 = (await history(wf.id, 'b'))[0];
  assert.match(entry1.stamp, /^st:/, 'the entry of the branding node holds its stamp');
  const logo1 = entry1.variants[0].logo;
  assert.ok(logo1 && logo1.sessionId && logo1.assetId, 'the logo is an asset');
  assert.equal(entry1.variants[0].voice.value, 'voice-1');

  reset();
  assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED, 'unchanged: everything from the cache');
  assert.deepEqual(counts, {});
  assert.deepEqual(planStatuses(await planOf(wf.id)), ALL_CACHED);
  assert.equal((await planOf(wf.id)).nodes.b.stamped, true);

  /* ---------- the node runs again with an unchanged branding: the same logo asset, nothing after it runs ---------- */

  reset();
  const forcedBranding = await start(wf.id, { mode: 'node', nodeIds: ['b'], force: true });
  assert.equal(forcedBranding.nodes.b.status, 'done');
  const entry2 = (await history(wf.id, 'b'))[0];
  assert.notEqual(entry2.id, entry1.id, 'a forced run is a new entry');
  assert.deepEqual(entry2.variants[0].logo, logo1, 'the same logo bytes: the same asset value (sessionId and assetId)');
  assert.equal(entry2.variants[0].logo.assetId, logo1.assetId);
  assert.equal((await store.readLedger(wf.sessionId)).filter((item) => item.kind === 'image').length, 1, 'no second image in the ledger');
  assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED);
  assert.deepEqual(counts, {}, 'nothing after the node runs again');
  assert.deepEqual(planStatuses(await planOf(wf.id)), ALL_CACHED);

  /* ---------- an old entry: no stamp, no hash (made before this change) ---------- */

  {
    const def = registry.get('input.branding');
    const params = registry.normalizeParams(def, { branding: branding.id });
    const legacyKey = computeCacheKey(def, params, {});
    const downgrade = async () => wfStore.updateResults(wf.id, (results) => {
      const current = results.nodes.b;
      current.history = [current.history[current.history.length - 1]];
      delete current.history[0].stamp;
      current.history[0].cacheKey = legacyKey;
      current.selected = { entry: current.history[0].id, variant: 0 };
      return JSON.parse(JSON.stringify(current));
    });
    await downgrade();
    assert.equal('stamp' in (await history(wf.id, 'b'))[0], false);
    const plan = await planOf(wf.id);
    assert.deepEqual(planStatuses(plan), ALL_CACHED, 'the plan takes the old entry: the branding says the same');
    assert.equal(plan.totals.paidNodes, 0);
    reset();
    assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED);
    assert.deepEqual(counts, {}, 'a deploy does not make anything run for a branding nobody changed');
    assert.match((await history(wf.id, 'b'))[0].stamp, /^st:/, 'the old entry has its stamp now');

    // the node run again from an old entry (forced, so nothing is adopted): the hash comes from the file that is there
    await downgrade();
    reset();
    const again = await start(wf.id, { mode: 'node', nodeIds: ['b'], force: true });
    assert.equal(again.nodes.b.status, 'done');
    assert.deepEqual((await history(wf.id, 'b'))[0].variants[0].logo, logo1, 'the old asset is found by the bytes of its file');
    assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED);
    assert.deepEqual(counts, {});

    // an old entry of a branding that changed since: not taken, the node runs
    await downgrade();
    await brandings.updateBranding(branding.id, { voice: { tone: 'playful', language: 'de', dos: 'short', donts: 'jargon' } });
    assert.equal((await planOf(wf.id)).nodes.b.status, 'stale');
    await brandings.updateBranding(branding.id, { voice: { tone: 'warm', language: 'de', dos: 'short', donts: 'jargon' } });
    assert.equal((await planOf(wf.id)).nodes.b.status, 'cached', 'and taken again when the branding is as the entry says');
    await start(wf.id);
  }

  /* ---------- a changed tone ---------- */

  await brandings.updateBranding(branding.id, { voice: { tone: 'playful', language: 'de', dos: 'short', donts: 'jargon' } });
  {
    const plan = await planOf(wf.id);
    assert.equal(plan.nodes.b.status, 'stale', 'the branding node is out of date');
    assert.equal(plan.nodes.b.stamped, true);
    assert.equal(plan.nodes.plan.status, 'stale', 'and the planner');
    assert.equal(plan.nodes.plan.estimate.usd, 0.5, 'with its price');
    assert.ok(plan.totals.paidNodes >= 1 && plan.totals.usd >= 0.5);
    reset();
    const record = await start(wf.id);
    assert.deepEqual(statuses(record), { b: 'done', plan: 'done', scene: 'cached', speaker: 'cached', cut: 'cached' });
    assert.deepEqual(counts, { plan: 1 }, 'only the planner after the branding');
    const next = (await history(wf.id, 'b'))[0];
    assert.equal(next.variants[0].logo.assetId, logo1.assetId, 'the logo kept its asset');
  }

  /* ---------- only the logo (same name, other bytes: the profile text is the same) ---------- */

  const planBefore = await history(wf.id, 'plan');
  await fsp.writeFile(logoPath, logoBlue);
  {
    const plan = await planOf(wf.id);
    assert.equal(plan.nodes.b.status, 'stale', 'a changed logo file is noticed');
    reset();
    const record = await start(wf.id);
    assert.deepEqual(statuses(record), { b: 'done', plan: 'cached', scene: 'done', speaker: 'cached', cut: 'done' });
    assert.deepEqual(counts, { scene: 1, cut: 1 }, 'the scenes and the cut, not the planner (same profile text)');
    assert.equal((await history(wf.id, 'plan')).length, planBefore.length);
    const blueEntry = (await history(wf.id, 'b'))[0];
    assert.notEqual(blueEntry.variants[0].logo.assetId, logo1.assetId, 'another logo, another asset');
    // back to the first logo: its asset again, and the results of the scenes of that time are found
    await fsp.writeFile(logoPath, logoRed);
    reset();
    const back = await start(wf.id);
    // the entry of that time has the same key (the same branding): found again, nothing runs at all
    assert.deepEqual(statuses(back), ALL_CACHED);
    assert.deepEqual(counts, {}, 'nothing is paid for a logo that was there before');
    const selected = (await wfStore.readResults(wf.id)).nodes.b;
    assert.equal(selected.history.find((item) => item.id === selected.selected.entry).variants[0].logo.assetId, logo1.assetId);
    // the node run again by hand with that logo: the earlier asset is found by its bytes, among entries made with other logos
    await start(wf.id, { mode: 'node', nodeIds: ['b'], force: true });
    assert.equal((await history(wf.id, 'b'))[0].variants[0].logo.assetId, logo1.assetId, 'a logo that is back keeps its first asset');
    assert.equal((await store.readLedger(wf.sessionId)).filter((item) => item.kind === 'image').length, 2, 'two logos, two images: no third one');
    reset();
    assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED);
    assert.deepEqual(counts, {});
  }

  /* ---------- only the speaker voice ---------- */

  await brandings.updateBranding(branding.id, { speaker: { voiceId: 'voice-2', name: 'Ben' } });
  {
    const plan = await planOf(wf.id);
    assert.equal(plan.nodes.b.status, 'stale');
    reset();
    const record = await start(wf.id);
    assert.deepEqual(statuses(record), { b: 'done', plan: 'cached', scene: 'cached', speaker: 'done', cut: 'done' });
    assert.deepEqual(counts, { speaker: 1, cut: 1 }, 'the speaker and the cut, not the planner and the scenes');
    // no speaker voice any more: the output is empty and the speaker runs without it
    await brandings.updateBranding(branding.id, { speaker: null });
    reset();
    const without = await start(wf.id);
    assert.equal(without.status, 'completed', JSON.stringify(without.nodes));
    assert.deepEqual(counts, { speaker: 1, cut: 1 });
  }

  /* ---------- run all again: every node, with the price ---------- */

  {
    reset();
    const forced = await planOf(wf.id, { force: true });
    assert.deepEqual(planStatuses(forced), { b: 'forced', plan: 'forced', scene: 'forced', speaker: 'forced', cut: 'forced' });
    assert.equal(forced.totals.paidNodes, 4);
    assert.ok(Math.abs(forced.totals.usd - 1.1) < 1e-9, `the price of the whole run: ${forced.totals.usd}`);
    const record = await start(wf.id, { force: true });
    assert.deepEqual(statuses(record), { b: 'done', plan: 'done', scene: 'done', speaker: 'done', cut: 'done' });
    assert.deepEqual(counts, { plan: 1, scene: 1, speaker: 1, cut: 1 });
    assert.equal((await history(wf.id, 'b'))[0].variants[0].logo.assetId, logo1.assetId, 'a run of everything again keeps the logo asset too');
    reset();
    assert.deepEqual(statuses(await start(wf.id)), ALL_CACHED);
  }

  /* ---------- no branding, a guest, a missing branding ---------- */

  {
    const def = registry.get('input.branding');
    const neutral = await makeWorkflow([node('b', 'input.branding', { branding: '' }), node('plan', 't.planner')], [edge('e1', 'b.brand', 'plan.brand')], 'neutral');
    assert.deepEqual(await resolveStamp(def, { branding: '' }, {}, null, { user: STAFF }), { stamp: undefined, adopt: null }, 'the neutral profile never changes: no stamp');
    await start(neutral.id);
    const neutralEntry = (await history(neutral.id, 'b'))[0];
    assert.equal('stamp' in neutralEntry, false);
    assert.equal(neutralEntry.cacheKey, computeCacheKey(def, registry.normalizeParams(def, { branding: '' }), {}), 'the key of before');
    reset();
    assert.deepEqual(statuses(await start(neutral.id)), { b: 'cached', plan: 'cached' });

    assert.equal((await resolveStamp(def, { branding: branding.id }, {}, null, { user: GUEST })).stamp, undefined, 'a guest has no brandings: nothing is read');
    const missing = await resolveStamp(def, { branding: 'gone-1' }, {}, null, { user: STAFF });
    assert.match(missing.stamp, /^st:/);
    assert.notEqual(missing.stamp, (await resolveStamp(def, { branding: branding.id }, {}, null, { user: STAFF })).stamp);
    const lost = await makeWorkflow([node('b', 'input.branding', { branding: 'gone-1' }), node('plan', 't.planner')], [edge('e1', 'b.brand', 'plan.brand')], 'missing');
    const plan = await planOf(lost.id);
    assert.equal(plan.nodes.b.status, 'stale', 'the plan does not stop at a branding that is gone');
    const record = await start(lost.id);
    assert.equal(record.nodes.b.status, 'error');
    assert.equal(record.nodes.b.code, 'BRANDING_NOT_FOUND');
  }

  /* ---------- the stamp is the hash of the outputs ---------- */

  {
    const def = registry.get('input.branding');
    const stampNow = async () => (await resolveStamp(def, { branding: branding.id }, {}, null, { user: STAFF })).stamp;
    const base = await stampNow();
    assert.equal(await stampNow(), base, 'the same branding, the same stamp');
    await brandings.updateBranding(branding.id, { guidelines: 'Another rule.' });
    assert.notEqual(await stampNow(), base, 'guidelines');
    await brandings.updateBranding(branding.id, { guidelines: 'Rule.' });
    assert.equal(await stampNow(), base, 'and back');
    await brandings.updateBranding(branding.id, { colors: [{ role: 'primary', name: 'Ocean', hex: '#0055AB', usage: 'headlines' }] });
    assert.notEqual(await stampNow(), base, 'a colour');
    await brandings.updateBranding(branding.id, { colors: [{ role: 'primary', name: 'Ocean', hex: '#0055AA', usage: 'headlines' }] });
    await brandings.updateBranding(branding.id, { speaker: { voiceId: 'voice-3', name: 'C' } });
    const voiceStamp = await stampNow();
    assert.notEqual(voiceStamp, base, 'the voice');
    await brandings.updateBranding(branding.id, { speaker: { voiceId: 'voice-3', name: 'Another name' } });
    assert.equal(await stampNow(), voiceStamp, 'the name of the voice is not an output');
  }

  /* ---------- the font files of a scene ---------- */

  {
    const def = realRegistry.get('explainer.scene');
    const fonted = await brandings.createBranding({ name: 'Fonts' });
    const font = await brandings.saveBrandingAsset(fonted.id, { buffer: Buffer.from('font-one'), filename: 'brand.woff2' });
    const brandText = JSON.stringify({ fonts: [{ role: 'headline', family: 'Brand', weights: '700', source: 'upload', usage: '', asset: { branding: fonted.id, file: 'brand.woff2' } }] });
    const ask = (user, text) => resolveStamp(def, {}, text === undefined ? {} : { brand: textValue(text) }, null, { user });
    const one = (await ask(STAFF, brandText)).stamp;
    assert.match(one, /^st:/);
    assert.equal((await ask(STAFF, brandText)).stamp, one);
    await fsp.writeFile(path.join(iso.root, 'data', 'brandings', fonted.id, 'assets', font.filename), Buffer.from('font-two'));
    assert.notEqual((await ask(STAFF, brandText)).stamp, one, 'a font file replaced under its name renews the scenes');
    assert.equal((await ask(STAFF, undefined)).stamp, undefined, 'no brand: nothing to add');
    assert.equal((await ask(STAFF, JSON.stringify({ fonts: [{ family: 'System', asset: null }] }))).stamp, undefined, 'a system font: nothing to add');
    assert.equal((await ask(STAFF, 'not json')).stamp, undefined);
    assert.equal((await ask(GUEST, brandText)).stamp, undefined, 'a guest gets the system font');
    const lostFont = JSON.stringify({ fonts: [{ family: 'Brand', asset: { branding: fonted.id, file: 'missing.woff2' } }] });
    assert.match((await ask(STAFF, lostFont)).stamp, /^st:/, 'a font file that is gone is a stamp of its own');
    assert.equal(def.cacheStampAdopts, true, 'an old entry is taken once: a deploy does not paint the scenes again');
  }

  /* ---------- the default models of the settings ---------- */

  {
    const config = { defaultBrain: 'vendor/brain-a', imageModel: 'vendor/image-a', videoModel: 'vendor/video-a' };
    const stampOf = async (type, params = {}, settings = config) => {
      const def = realRegistry.get(type);
      return (await resolveStamp(def, realRegistry.normalizeParams(def, params), {}, null, { user: STAFF, config: settings })).stamp;
    };
    const stamped = ['llm.chat', 'llm.prompt_enhancer', 'llm.image_describer', 'llm.video_describer', 'llm.motion_html', 'music_video.plan', 'image.generate', 'image.edit', 'image.relight', 'video.generate', 'video.seedance'];
    for (const type of stamped) {
      const def = realRegistry.get(type);
      assert.equal(typeof def.cacheStamp, 'function', `${type} has a stamp`);
      assert.equal(def.cacheStampAdopts, true, `${type}: an old entry is taken once`);
      assert.match(await stampOf(type), /^st:/, `${type}: the setting is in the stamp`);
    }
    const changed = { ...config, defaultBrain: 'vendor/brain-b', imageModel: 'vendor/image-b', videoModel: 'vendor/video-b' };
    for (const type of stamped) assert.notEqual(await stampOf(type, {}, changed), await stampOf(type), `${type}: another setting, another stamp`);
    // llm: only the brain counts; image: only the image model; video: only the video model
    assert.equal(await stampOf('llm.chat', {}, { ...config, imageModel: 'x', videoModel: 'y' }), await stampOf('llm.chat'));
    assert.equal(await stampOf('image.generate', {}, { ...config, defaultBrain: 'x', videoModel: 'y' }), await stampOf('image.generate'));
    assert.equal(await stampOf('video.generate', {}, { ...config, defaultBrain: 'x', imageModel: 'y' }), await stampOf('video.generate'));
    // a node that names its model has nothing to add (the model is a parameter), image.relight and video.seedance have no such parameter
    for (const [type, params] of [['llm.chat', { model: 'vendor/own' }], ['llm.motion_html', { model: 'vendor/own' }], ['music_video.plan', { model: 'vendor/own' }], ['image.generate', { model: 'vendor/own-image' }], ['image.edit', { model: 'vendor/own-image' }], ['video.generate', { model: 'vendor/own-video' }]]) {
      assert.equal(await stampOf(type, params), undefined, `${type}: a named model is part of the parameters`);
    }
    // nothing set: nothing to add
    assert.equal(await stampOf('llm.chat', {}, {}), undefined);
    // a node that does not read these settings has no stamp
    for (const type of ['input.text', 'text.template', 'audio.tts', 'image.crop', 'video.concat', 'fal.depth_map', 'explainer.plan', 'explainer.voice', 'llm.research']) {
      assert.equal(realRegistry.get(type).cacheStamp, undefined, `${type}: no stamp`);
    }
  }

  for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
  assert.ok(assets, 'assets module loaded');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
