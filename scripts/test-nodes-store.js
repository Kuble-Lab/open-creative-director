'use strict';

// Backing-session support in lib/store.js + poller, the workflow store (CRUD, rev conflicts,
// import/export validation, results, runs) and the asset helpers. No provider calls.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const or = require('../lib/openrouter');
const poller = require('../lib/poller');
const assets = require('../lib/nodes/assets');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore, topoSort, ancestorsOf, descendantsOf, FORMAT } = require('../lib/nodes/workflows-store');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

function edge(id, from, fromPort, to, toPort) {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

async function testSessionSupport() {
  const chat = await store.createSession();
  const hidden = await store.createSession({ kind: 'workflow', title: 'Workflow: Hidden Nodes Test' });
  try {
    assert.equal(chat.title, 'Neuer Chat');
    assert.equal('kind' in chat, false, 'chats keep no kind field');
    assert.equal(hidden.kind, 'workflow');
    assert.equal(hidden.title, 'Workflow: Hidden Nodes Test');
    await assert.rejects(store.createSession({ kind: 'Bad Kind' }), /Session-Art/);

    const visible = await store.listSessions({ limit: Infinity });
    assert.ok(visible.sessions.some((entry) => entry.id === chat.id));
    assert.ok(!visible.sessions.some((entry) => entry.id === hidden.id), 'workflow sessions are hidden by default');
    const search = await store.listSessions({ q: 'Hidden Nodes Test', limit: 100 });
    assert.equal(search.sessions.length, 0);

    const all = await store.listSessions({ limit: Infinity, includeHidden: true });
    const meta = all.sessions.find((entry) => entry.id === hidden.id);
    assert.equal(meta.kind, 'workflow');
    assert.equal(all.total, visible.total + all.sessions.filter((entry) => entry.kind === 'workflow').length);
    assert.equal('kind' in all.sessions.find((entry) => entry.id === chat.id), false);
    const searchAll = await store.listSessions({ q: 'Hidden Nodes Test', limit: 100, includeHidden: true });
    assert.equal(searchAll.sessions.length, 1);

    // the poller still discovers jobs of hidden sessions
    await store.mutateSession(hidden.id, (session) => {
      session.jobs.push({ jobId: 'poll-test-job', assetId: 'vid-001', status: 'pending', kind: 'video', source: null });
    });
    const originals = { hasKey: or.hasKey, getVideoJob: or.getVideoJob };
    const polled = [];
    try {
      or.hasKey = () => true;
      or.getVideoJob = async (jobId) => {
        polled.push(jobId);
        return { status: 'running' };
      };
      await poller.pollOnce();
    } finally {
      or.hasKey = originals.hasKey;
      or.getVideoJob = originals.getVideoJob;
    }
    assert.ok(polled.includes('poll-test-job'), 'poller must poll jobs of workflow sessions');
    const polledSession = await store.readSession(hidden.id);
    assert.equal(polledSession.jobs[0].status, 'running');
  } finally {
    await store.deleteSession(chat.id);
    await store.deleteSession(hidden.id);
  }
}

function testGraphHelpers() {
  const nodes = [node('a', 't', {}, 0, 0), node('b', 't', {}, 10, 0), node('c', 't', {}, 5, 50), node('d', 't', {}, 0, 100)];
  const edges = [edge('e1', 'a', 'o', 'b', 'i'), edge('e2', 'b', 'o', 'd', 'i'), edge('e3', 'c', 'o', 'd', 'i2')];
  const sorted = topoSort(nodes, edges);
  assert.equal(sorted.cyclic, false);
  assert.deepEqual(sorted.order, ['a', 'b', 'c', 'd'], 'ties are ordered by y then x');
  assert.equal(topoSort(nodes, [...edges, edge('e4', 'd', 'o', 'a', 'i')]).cyclic, true);
  assert.deepEqual([...ancestorsOf(edges, ['d'])].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...ancestorsOf(edges, ['b'])].sort(), ['a', 'b']);
  assert.deepEqual([...descendantsOf(edges, ['b'])].sort(), ['b', 'd']);
}

async function testAssets() {
  const chat = await store.createSession();
  const target = await store.createSession({ kind: 'workflow' });
  try {
    const image = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'p' });
    const upload = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('x'), ext: '.mp4' });
    const svg = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('<svg/>'), ext: '.svg' });
    // a text file is a document now (WP37a); a zip file is still no media
    const text = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('x'), ext: '.zip' });
    const note = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('x'), ext: '.txt', prompt: 'note.txt' });
    const pending = await store.reserveAsset(chat.id, { kind: 'video', ext: '.mp4' });
    const ledger = await store.readLedger(chat.id);
    const entry = (id) => ledger.find((item) => item.id === id);

    const value = assets.valueFromLedgerEntry(chat.id, entry(image.id));
    // the fixture is one half transparent pixel (RGBA): since WP33c the store marks it (with ffmpeg by its pixel, without ffmpeg by its header)
    assert.deepEqual(value, { type: 'image', sessionId: chat.id, assetId: image.id, file: image.file, url: image.url, alpha: true });
    assert.equal(assets.valueFromLedgerEntry(chat.id, entry(upload.id)).type, 'video');
    assert.throws(() => assets.valueFromLedgerEntry(chat.id, entry(svg.id)), /SVG/);
    assert.throws(() => assets.valueFromLedgerEntry(chat.id, entry(text.id)), /unsupported/);
    assert.equal(assets.valueFromLedgerEntry(chat.id, entry(note.id)).type, 'document');
    assert.equal(assets.valueFromLedgerEntry(chat.id, entry(note.id)).name, 'note.txt');
    assert.throws(() => assets.valueFromLedgerEntry(chat.id, entry(pending.id)), /not finished/);
    assert.equal(assets.typeFromExtension('.M4A'), 'audio');
    assert.equal(assets.typeFromExtension('.svg'), null);

    const listed = await assets.listSessionAssets(chat.id);
    assert.deepEqual(listed.map((item) => item.assetId).sort(), [image.id, upload.id, note.id].sort());

    // copy between sessions keeps the kind and creates a fresh ledger entry
    const copied = await assets.copyAsset(chat.id, image.id, target.id);
    assert.equal(copied.sessionId, target.id);
    assert.equal(copied.type, 'image');
    const targetLedger = await store.readLedger(target.id);
    assert.equal(targetLedger.length, 1);
    assert.equal(targetLedger[0].kind, 'image');
    assert.equal((await fsp.readFile(path.join(store.sessionAssetDir(target.id), copied.file))).equals(PNG), true);
    await assert.rejects(assets.copyAsset(chat.id, pending.id, target.id), /not finished/);
    await assert.rejects(assets.copyAsset(chat.id, 'img-099', target.id), /does not exist/);
    assert.equal((await fsp.readdir(store.sessionAssetDir(target.id))).some((name) => name.startsWith('.import-')), false);

    // uploads
    const scratch = await assets.createScratchDir(target.id);
    const uploadFile = path.join(scratch, 'in.png');
    await fsp.writeFile(uploadFile, PNG);
    const uploaded = await assets.saveUploadFile(target.id, { sourceFile: uploadFile, ext: '.png', name: 'photo.png' });
    assert.equal(uploaded.type, 'image');
    assert.match(uploaded.assetId, /^upload-\d{3}$/);
    const svgFile = path.join(scratch, 'in.svg');
    await fsp.writeFile(svgFile, '<svg/>');
    await assert.rejects(assets.saveUploadFile(target.id, { sourceFile: svgFile, ext: '.svg' }), (err) => err.code === 'UNSUPPORTED_MEDIA');
    await assert.rejects(assets.saveUploadFile(target.id, { sourceFile: path.join(os.tmpdir(), 'x.png'), ext: '.png' }), /inside the session asset/);
    await assets.removeScratchDir(scratch);

    // output files
    const outScratch = await assets.createScratchDir(target.id);
    const outFile = path.join(outScratch, 'out.mp4');
    await fsp.writeFile(outFile, 'video-bytes');
    const output = await assets.saveOutputFile(target.id, { kind: 'video', ext: '.mp4', sourceFile: outFile, prompt: 'cut', cost: 0, duration: 2.5 });
    assert.equal(output.type, 'video');
    assert.equal(output.duration, 2.5);
    assert.equal(assets.assetFilePath(output), path.join(store.sessionAssetDir(target.id), output.file));
    assert.throws(() => assets.assetFilePath({ sessionId: 'x', file: '../etc/passwd' }), /stored asset/);
    await assert.rejects(assets.saveOutputFile(target.id, { kind: 'text', ext: '.mp4', sourceFile: outFile }), /Unsupported output kind/);
    await assets.removeScratchDir(outScratch);
    assert.equal(await assets.ledgerCosts(target.id, [output.assetId]), 0);
    assert.equal(await assets.ledgerCosts(target.id, ['nope']), null);

    // asset params of input nodes
    const resolved = await assets.resolveAssetParam({ sessionId: target.id, assetId: uploaded.assetId }, target.id, 'image');
    assert.equal(resolved.assetId, uploaded.assetId);
    await assert.rejects(assets.resolveAssetParam({ assetId: uploaded.assetId }, target.id, 'video'), /expected video/);
    await assert.rejects(assets.resolveAssetParam({ sessionId: chat.id, assetId: image.id }, target.id, 'image'), /another workflow/);
    await assert.rejects(assets.resolveAssetParam({ assetId: 'upload-999' }, target.id, 'image'), /does not exist/);
    await assert.rejects(assets.resolveAssetParam(null, target.id, 'image'), /No asset selected/);
    assert.equal(assets.assetRefFromParam({ assetId: 'a1', missing: true }, 's'), null);
    assert.deepEqual(assets.assetRefFromParam({ assetId: 'a1' }, 's'), { sessionId: 's', assetId: 'a1' });
  } finally {
    await store.deleteSession(chat.id);
    await store.deleteSession(target.id);
  }
}

async function main() {
  await testSessionSupport();
  testGraphHelpers();
  await testAssets();

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-store-'));
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir, events: bus });
  const created = [];
  const chat = await store.createSession();
  const folder = `Nodes-Test-${Date.now()}`;

  const make = async (options = {}) => {
    const result = await wfStore.createWorkflow(options);
    created.push(result.workflow.id);
    return result;
  };

  try {
    /* ----- create / read / list ----- */
    const { workflow, results } = await make({
      name: '  Coffee ad  ',
      user: 'anna',
      graph: {
        nodes: [node('n1', 'input.text', { text: 'hi' }, 0, 0), node('n2', 'output.result', {}, 300, 0)],
        edges: [edge('e1', 'n1', 'text', 'n2', 'inputs')]
      }
    });
    assert.match(workflow.id, /^wf-[a-z0-9]+-[0-9a-f]{6}$/);
    assert.equal(workflow.name, 'Coffee ad');
    assert.equal(workflow.rev, 1);
    assert.equal(workflow.createdBy, 'anna');
    assert.equal(workflow.updatedBy, 'anna');
    assert.equal(workflow.format, FORMAT);
    assert.deepEqual(results, { version: 1, nodes: {} });
    assert.deepEqual(workflow.graph.viewport, { x: 0, y: 0, zoom: 1 });
    const session = await store.readSession(workflow.sessionId);
    assert.equal(session.kind, 'workflow');
    assert.equal(session.title, 'Workflow: Coffee ad');
    assert.ok(!(await store.listSessions({ limit: Infinity })).sessions.some((entry) => entry.id === workflow.sessionId));

    const loaded = await wfStore.getWorkflow(workflow.id);
    assert.deepEqual(loaded.workflow, workflow);
    await assert.rejects(wfStore.getWorkflow('wf-unknown'), { code: 'WORKFLOW_NOT_FOUND' });
    await assert.rejects(wfStore.getWorkflow('../etc'), { code: 'INVALID_ID' });

    const other = await make({ name: 'Second one', folder });
    assert.equal(other.workflow.folder, folder);
    assert.equal((await store.readSession(other.workflow.sessionId)).folder, folder);
    const list = await wfStore.listWorkflows();
    assert.deepEqual(list.map((item) => item.id).sort(), [workflow.id, other.workflow.id].sort());
    const listed = list.find((item) => item.id === workflow.id);
    assert.equal(listed.nodeCount, 2);
    assert.deepEqual(listed.app, { enabled: false });
    assert.equal(listed.thumbnail, undefined);
    assert.deepEqual((await wfStore.listWorkflows({ q: 'coffee' })).map((item) => item.id), [workflow.id]);
    assert.deepEqual((await wfStore.listWorkflows({ q: folder.toLowerCase() })).map((item) => item.id), [other.workflow.id]);

    /* ----- saveGraph: rev, conflicts, viewport, rename, events ----- */
    const events = [];
    bus.subscribe(workflow.id, (event) => events.push(event));
    const graph2 = { ...workflow.graph, nodes: [...workflow.graph.nodes, node('n3', 'input.text', { text: 'more' }, 0, 100)] };
    const saved = await wfStore.saveGraph(workflow.id, { baseRev: 1, graph: graph2, user: 'ben', name: 'Coffee ad v2' });
    assert.equal(saved.rev, 2);
    assert.ok(saved.updatedAt);
    assert.deepEqual(events, [{ type: 'workflow_saved', rev: 2, updatedBy: 'ben' }]);
    const afterSave = await wfStore.readWorkflow(workflow.id);
    assert.equal(afterSave.updatedBy, 'ben');
    assert.equal(afterSave.createdBy, 'anna');
    assert.equal((await store.readSession(workflow.sessionId)).title, 'Workflow: Coffee ad v2');

    await assert.rejects(wfStore.saveGraph(workflow.id, { baseRev: 1, graph: graph2 }), (err) => err.code === 'REV_CONFLICT' && err.rev === 2);
    await assert.rejects(wfStore.saveGraph(workflow.id, { graph: graph2 }), { code: 'INVALID_WORKFLOW' });

    const panned = await wfStore.saveGraph(workflow.id, { baseRev: 2, graph: { ...graph2, viewport: { x: 50, y: 20, zoom: 0.5 } } });
    assert.equal(panned.rev, 2, 'viewport-only changes do not bump the rev');
    assert.equal(events.length, 1, 'and do not notify other tabs');
    assert.deepEqual((await wfStore.readWorkflow(workflow.id)).graph.viewport, { x: 50, y: 20, zoom: 0.5 });

    // structural validation on save
    const bad = async (graph, pattern) =>
      assert.rejects(wfStore.saveGraph(workflow.id, { baseRev: 2, graph }), (err) => err.code === 'INVALID_WORKFLOW' && pattern.test(err.message));
    await bad({ nodes: [node('n1', 't.a'), node('n1', 't.a')], edges: [] }, /duplicate node id/);
    await bad({ nodes: [node('n1', 't.a')], edges: [edge('e1', 'n1', 'o', 'n9', 'i')] }, /dangling/);
    await bad({ nodes: [node('n1', 't.a')], edges: [edge('e1', 'n1', 'o', 'n1', 'i')] }, /itself/);
    await bad(
      { nodes: [node('n1', 't.a'), node('n2', 't.a')], edges: [edge('e1', 'n1', 'o', 'n2', 'i'), edge('e2', 'n2', 'o', 'n1', 'i')] },
      /cycle/
    );
    await bad({ nodes: [node('bad id!', 't.a')], edges: [] }, /invalid id/);
    await bad({ nodes: [{ id: 'n1', type: 'bad type' }], edges: [] }, /invalid type/);
    await bad({ nodes: 'nope' }, /nodes must be an array/);
    await bad(null, /graph must be an object/);
    await bad({ nodes: Array.from({ length: 501 }, (_v, i) => node(`n${i}`, 't.a')), edges: [] }, /more than 500/);
    assert.equal((await wfStore.readWorkflow(workflow.id)).rev, 2, 'failed saves leave the workflow untouched');

    // unknown node types are kept; groups and notes are normalised
    const keep = await make({
      name: 'keep unknown',
      graph: {
        nodes: [node('u1', 'future.node', { a: 1 })],
        edges: [],
        groups: [{ id: 'g1', title: 'G', x: 1, y: 2, w: 3, h: 4, color: 'amber' }],
        notes: [{ id: 't1', x: 0, y: 0, w: 100, h: 50, text: 'note' }]
      }
    });
    assert.equal(keep.workflow.graph.nodes[0].type, 'future.node');
    assert.equal(keep.workflow.graph.groups[0].title, 'G');
    assert.equal(keep.workflow.graph.notes[0].text, 'note');

    /* ----- app section ----- */
    const appGraph = { nodes: [node('a', 'input.text'), node('o', 'output.result')], edges: [] };
    const withApp = await make({
      name: 'App',
      graph: appGraph,
      app: { enabled: true, title: 'T', inputs: [{ node: 'a', param: 'text', label: 'Scene' }, { node: 'gone', param: 'text' }], outputs: [{ node: 'o', label: 'Clip' }] }
    });
    assert.deepEqual(withApp.workflow.app.inputs, [{ node: 'a', param: 'text', label: 'Scene' }], 'dangling refs are dropped');
    assert.equal(withApp.workflow.app.enabled, true);
    await assert.rejects(make({ name: 'x', graph: appGraph, app: { inputs: [{ node: 'a', param: 'nope' }] } }), /does not exist/);
    await assert.rejects(make({ name: 'x', graph: appGraph, app: { outputs: [{ node: 'a', label: 'x' }] } }), /output.result/);
    // saving without an app section keeps the app and prunes deleted nodes
    const keptApp = await wfStore.saveGraph(withApp.workflow.id, { baseRev: 1, graph: { nodes: [node('a', 'input.text')], edges: [] } });
    assert.equal(keptApp.rev, 2);
    const prunedApp = (await wfStore.readWorkflow(withApp.workflow.id)).app;
    assert.deepEqual(prunedApp.outputs, []);
    assert.equal(prunedApp.enabled, true);
    assert.equal((await wfStore.listWorkflows()).find((item) => item.id === withApp.workflow.id).app.enabled, true);

    /* ----- patch (rename / move) ----- */
    const patched = await wfStore.patchMeta(other.workflow.id, { name: 'Renamed', folder: null, user: 'cara' });
    assert.equal(patched.name, 'Renamed');
    assert.equal(patched.folder, null);
    assert.equal(patched.rev, 1, 'PATCH does not change the rev');
    const patchedSession = await store.readSession(other.workflow.sessionId);
    assert.equal(patchedSession.title, 'Workflow: Renamed');
    assert.equal(patchedSession.folder, null);
    assert.equal((await wfStore.readWorkflow(other.workflow.id)).updatedBy, 'cara');
    await wfStore.patchMeta(other.workflow.id, { folder });
    assert.equal((await store.readSession(other.workflow.sessionId)).folder, folder);

    /* ----- export / import ----- */
    const exported = await wfStore.exportWorkflow(workflow.id);
    assert.equal(exported.format, FORMAT);
    assert.equal(exported.version, 1);
    for (const key of ['id', 'sessionId', 'rev', 'results']) assert.equal(key in exported, false, key);
    assert.equal(exported.graph.nodes.length, 3);

    const imported = await make({ document: JSON.parse(JSON.stringify(exported)), user: 'dora' });
    assert.notEqual(imported.workflow.id, workflow.id);
    assert.notEqual(imported.workflow.sessionId, workflow.sessionId);
    assert.equal(imported.workflow.rev, 1);
    assert.equal(imported.workflow.createdBy, 'dora');
    assert.equal(imported.workflow.name, exported.name);
    assert.deepEqual(imported.workflow.graph.nodes.map((n) => n.id), exported.graph.nodes.map((n) => n.id));
    assert.deepEqual(imported.results, { version: 1, nodes: {} });

    const importBad = async (mutate, pattern) => {
      const doc = JSON.parse(JSON.stringify(exported));
      mutate(doc);
      await assert.rejects(wfStore.createWorkflow({ document: doc }), (err) => err.code === 'INVALID_WORKFLOW' && pattern.test(err.message));
    };
    await importBad((doc) => { doc.format = 'other'; }, /unsupported format/);
    await importBad((doc) => { delete doc.version; }, /version is missing/);
    await importBad((doc) => { doc.version = 2; }, /newer than this server/);
    await importBad((doc) => { doc.graph.edges.push(edge('e9', 'n2', 'result', 'n1', 'text')); }, /cycle|dangling|hidden/);
    await importBad((doc) => { doc.graph.edges.push(edge('e9', 'n1', 'text', 'n9', 'inputs')); }, /dangling/);
    await importBad((doc) => { doc.graph.edges.push(edge('e9', 'n1', 'nope', 'n2', 'inputs')); }, /port nope does not exist/);
    await importBad((doc) => { doc.graph.edges.push(edge('e9', 'n1', 'text', 'n2', 'wrong')); }, /port wrong does not exist/);
    await importBad((doc) => { doc.graph.nodes.push(node('big', 'input.text', { text: 'x'.repeat(2.1 * 1024 * 1024) })); }, /larger than 2 MB/);
    await assert.rejects(wfStore.createWorkflow({ document: 'nope' }), { code: 'INVALID_WORKFLOW' });
    assert.equal((await wfStore.listWorkflows()).length, created.length, 'rejected imports leave no workflow behind');

    // cycles are rejected on import, unknown types are kept
    const cyc = JSON.parse(JSON.stringify(exported));
    cyc.graph.nodes = [node('a', 'future.a'), node('b', 'future.b')];
    cyc.graph.edges = [edge('e1', 'a', 'o', 'b', 'i'), edge('e2', 'b', 'o', 'a', 'i')];
    await assert.rejects(wfStore.createWorkflow({ document: cyc }), /cycle/);
    cyc.graph.edges = [edge('e1', 'a', 'o', 'b', 'i')];
    const future = await make({ document: cyc });
    assert.deepEqual(future.workflow.graph.nodes.map((n) => n.type), ['future.a', 'future.b']);

    /* ----- media input assets: missing after import, copied on duplicate ----- */
    const media = await make({ name: 'Media', graph: { nodes: [node('img', 'input.image', {}), node('lst', 'input.media_list', { kind: 'image', assets: [] })], edges: [] } });
    const scratch = await assets.createScratchDir(media.workflow.sessionId);
    const file = path.join(scratch, 'x.png');
    await fsp.writeFile(file, PNG);
    const value = await assets.saveUploadFile(media.workflow.sessionId, { sourceFile: file, ext: '.png', name: 'x.png' });
    await assets.removeScratchDir(scratch);
    const assetParam = { sessionId: value.sessionId, assetId: value.assetId, file: value.file, url: value.url, name: 'x.png' };
    const mediaLoaded = await wfStore.readWorkflow(media.workflow.id);
    await wfStore.saveGraph(media.workflow.id, {
      baseRev: mediaLoaded.rev,
      graph: {
        ...mediaLoaded.graph,
        nodes: [node('img', 'input.image', { asset: assetParam }), node('lst', 'input.media_list', { kind: 'image', assets: [assetParam] })]
      }
    });

    const mediaExport = await wfStore.exportWorkflow(media.workflow.id);
    assert.equal(mediaExport.graph.nodes[0].params.asset.assetId, value.assetId, 'export keeps the asset reference');
    const mediaImport = await make({ document: mediaExport });
    assert.equal(mediaImport.workflow.graph.nodes[0].params.asset.missing, true);
    assert.equal(mediaImport.workflow.graph.nodes[1].params.assets[0].missing, true);

    const copy = await wfStore.duplicateWorkflow(media.workflow.id, { user: 'eve' });
    created.push(copy.workflow.id);
    assert.equal(copy.workflow.name, 'Media (copy)');
    assert.equal(copy.workflow.createdBy, 'eve');
    assert.notEqual(copy.workflow.sessionId, media.workflow.sessionId);
    assert.deepEqual(copy.results, { version: 1, nodes: {} });
    const copiedParam = copy.workflow.graph.nodes[0].params.asset;
    assert.equal(copiedParam.sessionId, copy.workflow.sessionId);
    assert.equal(copiedParam.missing, undefined);
    assert.equal(copiedParam.name, 'x.png');
    assert.equal((await assets.valueFromAsset(copy.workflow.sessionId, copiedParam.assetId)).type, 'image');
    assert.equal(copy.workflow.graph.nodes[1].params.assets[0].sessionId, copy.workflow.sessionId);
    assert.equal((await wfStore.readWorkflow(copy.workflow.id)).graph.nodes[0].params.asset.sessionId, copy.workflow.sessionId);

    /* ----- results: history cap, selection, thumbnail ----- */
    const wfId = media.workflow.id;
    for (let i = 0; i < 32; i += 1) {
      await wfStore.appendHistory(wfId, 'img', {
        runId: 'r-test',
        createdAt: new Date(Date.now() + i).toISOString(),
        cacheKey: `sha256:${i}`,
        params: {},
        variants: [{ image: value }, { image: { ...value, assetId: 'upload-002', url: value.url.replace(value.assetId, 'upload-002') } }],
        cost: { usd: null, credits: null }
      });
    }
    const nodeResults = (await wfStore.readResults(wfId)).nodes.img;
    assert.equal(nodeResults.history.length, 30);
    assert.equal(nodeResults.history[0].cacheKey, 'sha256:31', 'newest first');
    assert.equal(nodeResults.selected.entry, nodeResults.history[0].id);
    assert.match(nodeResults.history[0].id, /^h-[a-z0-9]+-[0-9a-f]{6}$/);
    const selectedNode = await wfStore.selectVariant(wfId, 'img', { entry: nodeResults.history[3].id, variant: 1 });
    assert.deepEqual(selectedNode.selected, { entry: nodeResults.history[3].id, variant: 1 });
    await assert.rejects(wfStore.selectVariant(wfId, 'img', { entry: nodeResults.history[3].id, variant: 2 }), { code: 'ENTRY_NOT_FOUND' });
    await assert.rejects(wfStore.selectVariant(wfId, 'nope', { entry: 'x', variant: 0 }), { code: 'ENTRY_NOT_FOUND' });
    const thumb = (await wfStore.listWorkflows()).find((item) => item.id === wfId).thumbnail;
    assert.equal(thumb, value.url.replace(value.assetId, 'upload-002'), 'thumbnail follows the selected variant');

    // concurrent history appends do not lose entries
    await Promise.all(Array.from({ length: 5 }, (_v, i) => wfStore.appendHistory(wfId, 'lst', { cacheKey: `k${i}`, variants: [{}] })));
    assert.equal((await wfStore.readResults(wfId)).nodes.lst.history.length, 5);

    /* ----- runs: write / read / prune / interrupted ----- */
    for (let i = 0; i < 53; i += 1) {
      const runId = wfStore.newRunId();
      await wfStore.writeRun(wfId, { id: runId, workflowId: wfId, status: 'completed', startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), nodes: {} });
    }
    assert.equal((await wfStore.listRuns(wfId)).length, 53);
    assert.equal(await wfStore.pruneRuns(wfId, 50), 3);
    const kept = await wfStore.listRuns(wfId);
    assert.equal(kept.length, 50);
    assert.equal(kept[0].startedAt, new Date(2026, 0, 1, 0, 0, 52).toISOString(), 'newest runs are kept');
    await wfStore.writeRun(wfId, { id: 'r-stale', workflowId: wfId, status: 'running', startedAt: new Date().toISOString(), nodes: {} });
    assert.equal(await wfStore.markInterruptedRuns(), 1);
    const stale = await wfStore.readRun(wfId, 'r-stale');
    assert.equal(stale.status, 'interrupted');
    assert.ok(stale.finishedAt);
    await assert.rejects(wfStore.readRun(wfId, 'r-nope'), { code: 'RUN_NOT_FOUND' });
    assert.equal(await wfStore.markInterruptedRuns(), 0);

    /* ----- delete removes folder and backing session ----- */
    const doomed = await make({ name: 'Doomed' });
    await wfStore.deleteWorkflow(doomed.workflow.id);
    await assert.rejects(wfStore.getWorkflow(doomed.workflow.id), { code: 'WORKFLOW_NOT_FOUND' });
    await assert.rejects(store.readSession(doomed.workflow.sessionId), { code: 'ENOENT' });
    await assert.rejects(fsp.access(path.join(store.sessionAssetDir(doomed.workflow.sessionId))), { code: 'ENOENT' });
    await assert.rejects(fsp.access(path.join(dir, doomed.workflow.id)), { code: 'ENOENT' });
    await assert.rejects(wfStore.deleteWorkflow(doomed.workflow.id), { code: 'WORKFLOW_NOT_FOUND' });
    created.splice(created.indexOf(doomed.workflow.id), 1);

  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await store.deleteSession(chat.id).catch(() => {});
    await store.deleteFolder(folder).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-store.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
