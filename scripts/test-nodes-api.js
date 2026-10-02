'use strict';

// API tests for the node view routes (lib/nodes/routes.js): status codes and shapes of every route,
// streamed uploads with size cap, asset import, run control and the SSE stream. Runs against a private
// express app with a temp workflow dir and fake executors; no provider is contacted. Backing sessions,
// chat sessions and temp files are removed at the end. The real server app is only checked for wiring.

const assert = require('assert/strict');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const elevenlabs = require('../lib/elevenlabs');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes, describeError, uploadExtension } = require('../lib/nodes/routes');
const yauzl = require('yauzl');
const jobs = require('../lib/nodes/jobs');
const { textValue } = require('../lib/nodes/types');
const nodesBasic = require('../lib/nodes/nodes-basic');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

function edge(id, from, fromPort, to, toPort) {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

// Reads a ZIP buffer into { name: Buffer }.
function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function binaryRequest(url) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: serverPort, path: url }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}
let serverPort = 0;

async function waitFor(predicate, label, timeoutMs = 4000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(10);
  }
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-api-'));
  const bus = createEventBus();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const gate = { started: 0, release: null };
  registry.register({
    type: 't.slow',
    category: 'text',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx, inputs) => {
      gate.started += 1;
      await jobs.sleep(60000, ctx.signal);
      return { variants: [{ out: textValue(inputs.in ? inputs.in.value : 'slow') }] };
    }
  });
  registry.register({
    type: 't.upper',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => ({ variants: [{ out: textValue(String(inputs.in.value).toUpperCase()) }] })
  });

  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({ imageModel: 'test' }), limits: { maxActiveRuns: 2 } });

  let currentUser = 'tester';
  const app = express();
  app.use((req, _res, next) => {
    req.kubleUser = currentUser;
    next();
  });
  app.use(express.json({ limit: '60mb' }));
  const templateCalls = [];
  const templateDoc = {
    format: 'ocd.workflow',
    version: 1,
    name: 'Template flow',
    description: 'from template',
    graph: { nodes: [node('n1', 'input.text', { text: 'hi' })], edges: [] },
    app: {}
  };
  const busyChats = new Set();
  registerNodeRoutes(app, {
    publicRuntimeConfig: () => ({ brainModels: ['vendor/model-a', 'vendor/model-b'] }),
    isTurnActive: (sessionId) => busyChats.has(sessionId),
    engine,
    store: wfStore,
    registry,
    events: bus,
    maxUploadBytes: 2048,
    pingMs: 40,
    resolveTemplate: (id, options) => {
      templateCalls.push({ id, options });
      return id === 'tpl-ok' ? templateDoc : null;
    },
    listTemplates: (options) => {
      templateCalls.push({ list: true, options });
      return [{ id: 'tpl-ok', name: options.lang === 'de' ? 'Vorlage' : 'Template flow', description: '', requires: ['ffmpeg'], available: true, missing: [] }];
    }
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  serverPort = port;

  function request(method, url, { body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
      const finalHeaders = { ...headers };
      if (body !== undefined && raw === undefined) finalHeaders['Content-Type'] = 'application/json';
      if (payload !== null && !finalHeaders['Transfer-Encoding'] && !finalHeaders['Content-Length']) {
        finalHeaders['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: finalHeaders }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* not JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }
  const api = (method, url, body, headers) => request(method, url, { body, headers });

  const created = [];
  const chatSessions = [];
  const originals = { hasKey: elevenlabs.hasKey, listVoices: elevenlabs.listVoices };
  const sseClients = [];
  const chatFolder = `API-Nodes-${Date.now().toString(36)}`;

  async function makeWorkflow(body = {}) {
    const res = await api('POST', '/api/workflows', { name: 'API test', ...body });
    assert.equal(res.status, 201, res.text);
    created.push(res.json.workflow.id);
    return res.json;
  }

  try {
    /* ----- error mapping (pure) ----- */
    assert.deepEqual(describeError(Object.assign(new Error('x'), { code: 'REV_CONFLICT', rev: 4 })), {
      status: 409,
      body: { error: 'x', code: 'REV_CONFLICT', rev: 4 }
    });
    assert.equal(describeError(Object.assign(new Error('x'), { code: 'RUN_LIMIT' })).status, 429);
    assert.equal(describeError(new Error('boom')).status, 500);
    assert.deepEqual(uploadExtension('image/png', 'a.bin'), { ext: '.png' });
    assert.deepEqual(uploadExtension('application/octet-stream', 'clip.MP4'), { ext: '.mp4' });
    assert.deepEqual(uploadExtension('application/octet-stream', 'pic.jpeg'), { ext: '.jpg' });
    assert.deepEqual(uploadExtension('image/svg+xml', 'a.svg'), { ext: '.svg', svg: true });
    assert.deepEqual(uploadExtension('application/octet-stream', 'b.SVG'), { ext: '.svg', svg: true });
    assert.match(uploadExtension('text/plain', 'a.txt').error, /Unsupported/);

    /* ----- registry and options ----- */
    {
      const res = await api('GET', '/api/nodes/registry');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.nodeTypes));
      const inputText = res.json.nodeTypes.find((type) => type.type === 'input.text');
      assert.ok(inputText);
      assert.equal(inputText.available, true, 'available is true or a reason string');
      assert.ok(res.json.portTypes && res.json.compat && res.json.categories);
      assert.ok(res.json.nodeTypes.some((type) => type.type === 't.slow'));

      const brain = await api('GET', '/api/nodes/options/brain-models');
      assert.equal(brain.status, 200);
      assert.deepEqual(brain.json.options, [
        { value: 'vendor/model-a', label: 'vendor/model-a' },
        { value: 'vendor/model-b', label: 'vendor/model-b' }
      ]);
      assert.equal((await api('GET', '/api/nodes/options/nope')).status, 404);
      assert.equal((await api('GET', '/api/nodes/options/toString')).status, 404);

      elevenlabs.hasKey = () => false;
      assert.equal((await api('GET', '/api/nodes/options/elevenlabs-voices')).status, 503);
      elevenlabs.hasKey = () => true;
      elevenlabs.listVoices = async () => [{ voice_id: 'v1', name: 'Anna', labels: { accent: 'de' } }, { voice_id: 'v2', name: 'Ben' }];
      const voices = await api('GET', '/api/nodes/options/elevenlabs-voices');
      assert.equal(voices.status, 200);
      assert.deepEqual(voices.json.options, [{ value: 'v1', label: 'Anna', labels: { accent: 'de' } }, { value: 'v2', label: 'Ben' }]);
      elevenlabs.listVoices = async () => {
        throw new Error('boom');
      };
      assert.equal((await api('GET', '/api/nodes/options/elevenlabs-voices')).status, 502);

      // without an injected Higgsfield catalogue (this private app has none) the routes answer 503
      assert.equal((await api('GET', '/api/nodes/options/higgsfield-image-models')).status, 503);
      assert.equal((await api('GET', '/api/nodes/options/higgsfield-audio-models')).status, 404, 'no audio model list: hf.speech offers a fixed pair');
      assert.equal((await api('GET', '/api/nodes/options/higgsfield-voices')).status, 503);
      assert.equal((await api('GET', '/api/nodes/higgsfield-models/some-model')).status, 503);
    }

    /* ----- workflow CRUD ----- */
    const first = await makeWorkflow({ name: 'Coffee ad', folder: chatFolder });
    const id = first.workflow.id;
    assert.equal(first.workflow.rev, 1);
    assert.equal(first.workflow.createdBy, 'tester');
    assert.equal(first.workflow.folder, chatFolder);
    assert.deepEqual(first.results, { version: 1, nodes: {} });
    const backing = await store.readSession(first.workflow.sessionId);
    assert.equal(backing.kind, 'workflow');
    assert.equal(backing.title, 'Workflow: Coffee ad');

    {
      assert.equal((await api('POST', '/api/workflows', { name: 5 })).status, 400);
      assert.equal((await api('POST', '/api/workflows', { folder: 5 })).status, 400);
      assert.equal((await api('POST', '/api/workflows', { folder: 'x'.repeat(61) })).status, 400);
      assert.equal((await api('POST', '/api/workflows', { templateId: 'missing' })).status, 404);
      const fromTemplate = await api('POST', '/api/workflows', { templateId: 'tpl-ok' });
      assert.equal(fromTemplate.status, 201);
      created.push(fromTemplate.json.workflow.id);
      assert.equal(fromTemplate.json.workflow.name, 'Template flow');
      assert.equal(fromTemplate.json.workflow.graph.nodes.length, 1);
      assert.deepEqual(templateCalls.filter((call) => !call.list).pop().options, { lang: 'en' }, 'default template language is en');
      const german = await api('POST', '/api/workflows', { templateId: 'tpl-ok', lang: 'de' });
      created.push(german.json.workflow.id);
      assert.deepEqual(templateCalls.filter((call) => !call.list).pop().options, { lang: 'de' });
      assert.equal((await api('POST', '/api/workflows', { templateId: 5 })).status, 400);

      const templates = await api('GET', '/api/workflow-templates?lang=de');
      assert.equal(templates.status, 200);
      assert.equal(templates.json.templates[0].name, 'Vorlage');
      assert.equal((await api('GET', '/api/workflow-templates')).json.templates[0].name, 'Template flow');
      assert.equal((await api('GET', '/api/workflow-templates?lang=xx')).json.templates[0].name, 'Template flow', 'unknown languages fall back to en');

      const listed = await api('GET', '/api/workflows');
      assert.equal(listed.status, 200);
      const item = listed.json.workflows.find((entry) => entry.id === id);
      assert.deepEqual(Object.keys(item).sort(), ['app', 'folder', 'id', 'name', 'nodeCount', 'updatedAt', 'updatedBy']);
      assert.equal(item.nodeCount, 0);
      assert.equal(item.updatedBy, 'tester');
      const filtered = await api('GET', '/api/workflows?q=coffee');
      assert.deepEqual(filtered.json.workflows.map((entry) => entry.id), [id]);
      assert.equal((await api('GET', '/api/workflows?q=zzz-none')).json.workflows.length, 0);

      const got = await api('GET', `/api/workflows/${id}`);
      assert.equal(got.status, 200);
      assert.equal(got.json.workflow.id, id);
      assert.equal(got.json.activeRun, null);
      assert.equal((await api('GET', '/api/workflows/bad%20id')).status, 400);
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist')).status, 404);
    }

    // PUT: autosave with optimistic concurrency
    const graph = {
      nodes: [node('n1', 'input.text', { text: 'hello' }, 0, 0), node('n2', 't.slow', {}, 200, 0), node('n3', 'output.result', { label: 'Out' }, 400, 0)],
      edges: [edge('e1', 'n1', 'text', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')],
      groups: [],
      notes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    };
    {
      const saved = await api('PUT', `/api/workflows/${id}`, { baseRev: 1, graph, name: 'Stale tab name' });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.rev, 2);
      assert.ok(saved.json.updatedAt);
      // F5: the autosave never renames; a stale tab sending an old name cannot undo a rename made elsewhere
      assert.equal((await store.readSession(first.workflow.sessionId)).title, 'Workflow: Coffee ad', 'PUT ignores the name');
      assert.equal((await api('GET', `/api/workflows/${id}`)).json.workflow.name, 'Coffee ad');
      const seen = [];
      const stop = bus.subscribe ? bus.subscribe(id, (event) => seen.push(event)) : null;
      assert.equal((await api('PATCH', `/api/workflows/${id}`, { name: 'Coffee ad v2' })).status, 200);
      await api('PUT', `/api/workflows/${id}`, { baseRev: 2, graph: { ...graph, viewport: { x: 1, y: 1, zoom: 1 } }, name: 'Coffee ad' });
      assert.equal((await api('GET', `/api/workflows/${id}`)).json.workflow.name, 'Coffee ad v2', 'a later autosave keeps the renamed workflow');
      if (typeof stop === 'function') stop();
      if (bus.subscribe) assert.ok(seen.some((event) => event.type === 'workflow_renamed' && event.name === 'Coffee ad v2'), 'PATCH announces the rename');
      const stale = await api('PUT', `/api/workflows/${id}`, { baseRev: 1, graph });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.rev, 2);
      assert.equal(stale.json.code, 'REV_CONFLICT');
      assert.equal((await api('PUT', `/api/workflows/${id}`, { graph })).status, 400, 'baseRev is required');
      assert.equal((await api('PUT', `/api/workflows/${id}`, { baseRev: 2 })).status, 400, 'graph is required');
      const cyclic = { ...graph, edges: [...graph.edges, edge('e3', 'n3', 'inputs', 'n1', 'text')] };
      assert.equal((await api('PUT', `/api/workflows/${id}`, { baseRev: 2, graph: cyclic })).status, 400);
      const viewportOnly = await api('PUT', `/api/workflows/${id}`, { baseRev: 2, graph: { ...graph, viewport: { x: 5, y: 5, zoom: 0.5 } } });
      assert.equal(viewportOnly.json.rev, 2, 'panning does not bump the rev');
      assert.equal((await api('PUT', '/api/workflows/wf-does-not-exist', { baseRev: 1, graph })).status, 404);
    }

    // PATCH: rename and move
    {
      const patched = await api('PATCH', `/api/workflows/${id}`, { name: 'Coffee ad v3' });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.name, 'Coffee ad v3');
      assert.equal(patched.json.rev, 2, 'PATCH never bumps the rev');
      assert.equal((await store.readSession(first.workflow.sessionId)).title, 'Workflow: Coffee ad v3');
      const moved = await api('PATCH', `/api/workflows/${id}`, { folder: null });
      assert.equal(moved.json.folder, null);
      assert.equal((await store.readSession(first.workflow.sessionId)).folder, null);
      assert.equal((await api('PATCH', `/api/workflows/${id}`, {})).status, 400);
      assert.equal((await api('PATCH', `/api/workflows/${id}`, { folder: 7 })).status, 400);
      assert.equal((await api('PATCH', '/api/workflows/wf-does-not-exist', { name: 'x' })).status, 404);
    }

    // F6: renaming / deleting a project in the chat view carries workflows (hidden sessions) along
    {
      const projectA = `${chatFolder}-A`;
      const projectB = `${chatFolder}-B`;
      await store.createFolder(projectA);
      const inProject = await makeWorkflow({ name: 'In project', folder: projectA });
      const wfId = inProject.workflow.id;
      assert.equal(inProject.workflow.folder, projectA);
      await store.renameFolder(projectA, projectB);
      assert.equal((await api('GET', `/api/workflows/${wfId}`)).json.workflow.folder, projectB, 'workflow.json follows the rename');
      assert.equal((await store.readSession(inProject.workflow.sessionId)).folder, projectB, 'the backing session follows the rename');
      assert.equal((await api('GET', '/api/workflows')).json.workflows.find((item) => item.id === wfId).folder, projectB);
      await store.deleteFolder(projectB);
      assert.equal((await api('GET', `/api/workflows/${wfId}`)).json.workflow.folder, null, 'a deleted project is detached from its workflows');
      assert.equal((await store.readSession(inProject.workflow.sessionId)).folder, null);
    }

    // duplicate, export, import
    {
      const dup = await api('POST', `/api/workflows/${id}/duplicate`, {});
      assert.equal(dup.status, 201);
      created.push(dup.json.workflow.id);
      assert.notEqual(dup.json.workflow.sessionId, first.workflow.sessionId);
      assert.equal(dup.json.workflow.name, 'Coffee ad v3 (copy)');
      assert.equal(dup.json.workflow.graph.nodes.length, 3);
      assert.deepEqual(dup.json.results.nodes, {});
      const named = await api('POST', `/api/workflows/${id}/duplicate`, { name: 'Named copy' });
      created.push(named.json.workflow.id);
      assert.equal(named.json.workflow.name, 'Named copy');
      assert.equal((await api('POST', '/api/workflows/wf-does-not-exist/duplicate', {})).status, 404);

      const exported = await api('GET', `/api/workflows/${id}/export`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers['content-type'], /application\/json/);
      assert.match(exported.headers['content-disposition'], /^attachment; filename="Coffee-ad-v3\.ocd-workflow\.json"/);
      assert.ok(exported.headers['content-disposition'].includes("filename*=UTF-8''Coffee%20ad%20v3.ocd-workflow.json"));
      assert.equal(exported.json.format, 'ocd.workflow');
      assert.equal(exported.json.id, undefined);
      assert.equal(exported.json.sessionId, undefined);
      assert.equal(exported.json.graph.nodes.length, 3);
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/export')).status, 404);

      const imported = await api('POST', '/api/workflows/import', { document: exported.json });
      assert.equal(imported.status, 201);
      created.push(imported.json.workflow.id);
      assert.equal(imported.json.workflow.rev, 1);
      assert.equal(imported.json.workflow.createdBy, 'tester');
      assert.notEqual(imported.json.workflow.sessionId, first.workflow.sessionId);
      const renamedImport = await api('POST', '/api/workflows/import', { document: exported.json, name: 'Imported as' });
      created.push(renamedImport.json.workflow.id);
      assert.equal(renamedImport.json.workflow.name, 'Imported as');

      assert.equal((await api('POST', '/api/workflows/import', {})).status, 400);
      assert.equal((await api('POST', '/api/workflows/import', { document: { ...exported.json, format: 'other' } })).status, 400);
      const cyc = { ...exported.json, graph: { ...exported.json.graph, edges: [...exported.json.graph.edges, edge('e9', 'n3', 'inputs', 'n1', 'text')] } };
      assert.equal((await api('POST', '/api/workflows/import', { document: cyc })).status, 400);
      const dangling = { ...exported.json, graph: { ...exported.json.graph, edges: [edge('e9', 'n1', 'text', 'zz', 'in')] } };
      assert.equal((await api('POST', '/api/workflows/import', { document: dangling })).status, 400);
      const huge = { ...exported.json, description: 'x'.repeat(2 * 1024 * 1024 + 10) };
      assert.equal((await api('POST', '/api/workflows/import', { document: huge })).status, 413);
      const unknownType = {
        ...exported.json,
        graph: { nodes: [node('u1', 'future.node', { a: 1 })], edges: [] },
        app: {}
      };
      const keepUnknown = await api('POST', '/api/workflows/import', { document: unknownType });
      assert.equal(keepUnknown.status, 201);
      created.push(keepUnknown.json.workflow.id);
      assert.equal(keepUnknown.json.workflow.graph.nodes[0].type, 'future.node');
    }

    /* ----- uploads ----- */
    const sessionId = first.workflow.sessionId;
    {
      const ok = await request('POST', `/api/workflows/${id}/uploads`, {
        raw: PNG,
        headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Kaffee Tasse ä.png') }
      });
      assert.equal(ok.status, 200, ok.text);
      const value = ok.json.value;
      assert.equal(value.type, 'image');
      assert.equal(value.sessionId, sessionId);
      assert.match(value.assetId, /^upload-\d{3}$/);
      assert.equal(value.url, `/assets/${sessionId}/${value.file}`);
      const stored = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), value.file));
      assert.ok(stored.equals(PNG));
      const ledger = await store.readLedger(sessionId);
      const entry = ledger.find((item) => item.id === value.assetId);
      assert.equal(entry.kind, 'upload');
      assert.equal(entry.prompt, 'Kaffee Tasse ä.png');
      const leftovers = (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-'));
      assert.deepEqual(leftovers, [], 'scratch directory is removed');

      // extension from the file name when the MIME type is generic
      const generic = await request('POST', `/api/workflows/${id}/uploads`, {
        raw: Buffer.from('fake-mp4'),
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'clip.mp4' }
      });
      assert.equal(generic.status, 200);
      assert.equal(generic.json.value.type, 'video');

      // ?accept= guards the expected media type
      const wrongKind = await request('POST', `/api/workflows/${id}/uploads?accept=audio`, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(wrongKind.status, 415);
      const rightKind = await request('POST', `/api/workflows/${id}/uploads?accept=image`, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(rightKind.status, 200);

      // SVG uploads are rasterised to a PNG (the value is the PNG); an unusable SVG is rejected and not kept
      const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#d8a25f"/></svg>';
      const ledgerBefore = (await store.readLedger(sessionId)).length;
      const svg = await request('POST', `/api/workflows/${id}/uploads?accept=image`, { raw: Buffer.from(svgSource), headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': 'logo.svg' } });
      assert.equal(svg.status, 200, svg.text);
      assert.equal(svg.json.rasterized, true);
      assert.equal(svg.json.value.type, 'image');
      assert.match(svg.json.value.file, /\.png$/);
      const svgLedger = await store.readLedger(sessionId);
      assert.equal(svgLedger.length, ledgerBefore + 2, 'the SVG source and its PNG are stored');
      const png = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), svg.json.value.file));
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      const svgByName = await request('POST', `/api/workflows/${id}/uploads`, { raw: Buffer.from(svgSource), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'b.SVG' } });
      assert.equal(svgByName.status, 200);
      assert.equal(svgByName.json.value.type, 'image');
      const svgWrongKind = await request('POST', `/api/workflows/${id}/uploads?accept=video`, { raw: Buffer.from(svgSource), headers: { 'Content-Type': 'image/svg+xml' } });
      assert.equal(svgWrongKind.status, 415);
      const ledgerBeforeBad = (await store.readLedger(sessionId)).length;
      const badSvg = await request('POST', `/api/workflows/${id}/uploads`, { raw: Buffer.from('<svg/>'), headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': 'bad.svg' } });
      assert.equal(badSvg.status, 415);
      assert.match(badSvg.json.error, /SVG/);
      assert.equal((await store.readLedger(sessionId)).length, ledgerBeforeBad, 'an unusable SVG is not kept');
      // F3: an SVG that points at a file on the server is never rasterised (resvg would load it)
      for (const evil of [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><image width="8" height="8" xlink:href="/etc/hosts"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image width="8" height="8" href=\'file:///tmp/x.png\'/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" style="fill:url(/tmp/x.png)"/></svg>'
      ]) {
        const evilUpload = await request('POST', `/api/workflows/${id}/uploads`, { raw: Buffer.from(evil), headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': 'evil.svg' } });
        assert.equal(evilUpload.status, 415, evilUpload.text);
      }
      assert.equal((await store.readLedger(sessionId)).length, ledgerBeforeBad, 'a refused SVG leaves nothing behind');
      const text = await request('POST', `/api/workflows/${id}/uploads`, { raw: Buffer.from('hi'), headers: { 'Content-Type': 'text/plain', 'X-Filename': 'a.txt' } });
      assert.equal(text.status, 415);

      // empty body, unknown workflow, bad id
      const empty = await request('POST', `/api/workflows/${id}/uploads`, { raw: '', headers: { 'Content-Type': 'image/png' } });
      assert.equal(empty.status, 400);
      const missing = await request('POST', '/api/workflows/wf-does-not-exist/uploads', { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(missing.status, 404);
      const badId = await request('POST', '/api/workflows/bad%20id/uploads', { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(badId.status, 400);

      // size cap (2 KB in this test app): declared length and chunked body without length
      const big = Buffer.alloc(4096, 1);
      const tooBig = await request('POST', `/api/workflows/${id}/uploads`, { raw: big, headers: { 'Content-Type': 'image/png' } });
      assert.equal(tooBig.status, 413);
      const chunked = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method: 'POST', path: `/api/workflows/${id}/uploads`, headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' } },
          (res) => {
            const parts = [];
            res.on('data', (chunk) => parts.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
          }
        );
        req.on('error', reject);
        req.write(big.subarray(0, 1500));
        req.write(big.subarray(1500, 3000));
        req.end(big.subarray(3000));
      });
      assert.equal(chunked.status, 413);
      assert.equal(chunked.json.code, 'TOO_LARGE');
      const after = await store.readLedger(sessionId);
      // 3 accepted uploads + 2 SVG uploads (source and PNG each); the rejected ones leave nothing behind
      assert.equal(after.filter((item) => item.kind === 'upload').length, 7, 'rejected uploads leave no ledger entries');
      assert.deepEqual((await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-')), []);

      // asset list of the backing session
      const listed = await api('GET', `/api/workflows/${id}/assets`);
      assert.equal(listed.status, 200);
      assert.equal(listed.json.assets.length, 5, '3 uploads + 2 SVG rasters (the SVG sources are no port values)');
      assert.ok(listed.json.assets.every((item) => item.sessionId === sessionId && item.url));
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/assets')).status, 404);
    }

    /* ----- import-asset from chat sessions ----- */
    {
      const chat = await store.createSession({ folder: chatFolder });
      chatSessions.push(chat.id);
      const image = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'chat image' });
      const pending = await store.reserveAsset(chat.id, { kind: 'video', ext: '.mp4', prompt: 'pending' });
      const textUpload = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('x'), ext: '.txt' });
      const svgUpload = await store.saveAsset(chat.id, { kind: 'upload', buffer: Buffer.from('<svg/>'), ext: '.svg' });

      const imported = await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id, assetId: image.id });
      assert.equal(imported.status, 200, imported.text);
      const value = imported.json.value;
      assert.equal(value.type, 'image');
      assert.equal(value.sessionId, sessionId, 'the copy lives in the backing session');
      assert.notEqual(value.assetId, undefined);
      const copy = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), value.file));
      assert.ok(copy.equals(PNG));
      const sourceLedger = await store.readLedger(chat.id);
      assert.equal(sourceLedger.length, 4, 'the chat keeps its assets');

      const same = await api('POST', `/api/workflows/${id}/import-asset`, { sessionId, assetId: value.assetId });
      assert.equal(same.status, 200);
      assert.equal(same.json.value.assetId, value.assetId, 'importing from the backing session returns the value without copying');

      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id, assetId: pending.id })).status, 409);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id, assetId: textUpload.id })).status, 415);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id, assetId: svgUpload.id })).status, 415);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id, assetId: 'img-099' })).status, 404);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: 'no-such-session', assetId: image.id })).status, 404);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: 'bad id', assetId: image.id })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${id}/import-asset`, { sessionId: chat.id })).status, 400);
      assert.equal((await api('POST', '/api/workflows/wf-does-not-exist/import-asset', { sessionId: chat.id, assetId: image.id })).status, 404);
      assert.deepEqual((await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.import-')), []);
    }

    /* ----- runs: plan, start, active run, cancel, results ----- */
    const runsWf = await makeWorkflow({ name: 'Runs' });
    const runsId = runsWf.workflow.id;
    const runGraph = {
      nodes: [node('a', 'input.text', { text: 'quiet' }, 0, 0), node('b', 't.upper', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
      edges: [edge('e1', 'a', 'text', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')],
      groups: [],
      notes: []
    };
    assert.equal((await api('PUT', `/api/workflows/${runsId}`, { baseRev: 1, graph: runGraph })).json.rev, 2);
    {
      const plan = await api('POST', `/api/workflows/${runsId}/runs/plan`, { mode: 'all' });
      assert.equal(plan.status, 200, plan.text);
      assert.equal(plan.json.nodes.b.status, 'stale');
      assert.equal(plan.json.valid, true);
      assert.ok(plan.json.totals);
      assert.equal((await api('POST', `/api/workflows/${runsId}/runs/plan`, { mode: 'bogus' })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${runsId}/runs/plan`, { mode: 'node' })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${runsId}/runs/plan`, { mode: 'node', nodeIds: ['zz'] })).status, 400);
      assert.equal((await api('POST', '/api/workflows/wf-does-not-exist/runs/plan', {})).status, 404);

      // rev mismatch and non-integer rev
      const wrongRev = await api('POST', `/api/workflows/${runsId}/runs`, { mode: 'all', rev: 1 });
      assert.equal(wrongRev.status, 409);
      assert.equal(wrongRev.json.rev, 2);
      assert.equal((await api('POST', `/api/workflows/${runsId}/runs`, { mode: 'all', rev: '2' })).status, 400);

      // the user always comes from the request, not the body
      const started = await api('POST', `/api/workflows/${runsId}/runs`, { mode: 'all', rev: 2, user: 'evil' });
      assert.equal(started.status, 202, started.text);
      const runId = started.json.runId;
      const finished = await engine.whenFinished(runsId, runId);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.user, 'tester');

      const record = await api('GET', `/api/workflows/${runsId}/runs/${runId}`);
      assert.equal(record.status, 200);
      assert.equal(record.json.id, runId);
      assert.equal(record.json.nodes.b.status, 'done');
      assert.equal((await api('GET', `/api/workflows/${runsId}/runs/r-unknown`)).status, 404);
      assert.equal((await api('GET', `/api/workflows/${runsId}/runs/bad%20id`)).status, 400);
      const cancelDone = await api('POST', `/api/workflows/${runsId}/runs/${runId}/cancel`, {});
      assert.deepEqual(cancelDone.json, { ok: false });

      // results: second run with force creates a second history entry; select the older one
      const second = await api('POST', `/api/workflows/${runsId}/runs`, { mode: 'node', nodeIds: ['b'], force: true });
      assert.equal(second.status, 202);
      await engine.whenFinished(runsId, second.json.runId);
      const got = await api('GET', `/api/workflows/${runsId}`);
      const history = got.json.results.nodes.b.history;
      assert.equal(history.length, 2);
      assert.equal(got.json.results.nodes.b.selected.entry, history[0].id);
      const selected = await api('PATCH', `/api/workflows/${runsId}/results/b`, { entry: history[1].id, variant: 0 });
      assert.equal(selected.status, 200);
      assert.equal(selected.json.selected.entry, history[1].id);
      assert.equal(selected.json.history.length, 2);
      assert.equal((await api('GET', `/api/workflows/${runsId}`)).json.results.nodes.b.selected.entry, history[1].id);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/b`, { entry: 'h-nope' })).status, 404);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/b`, { entry: history[0].id, variant: 9 })).status, 404);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/b`, { entry: history[0].id, variant: 'x' })).status, 400);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/b`, {})).status, 400);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/zz`, { entry: history[0].id })).status, 404);
      assert.equal((await api('PATCH', `/api/workflows/${runsId}/results/bad%20id`, { entry: history[0].id })).status, 400);
    }

    // a run over an uploaded image: the upload value works as an input-node asset param
    {
      const upload = await request('POST', `/api/workflows/${runsId}/uploads`, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(upload.status, 200);
      const imgGraph = {
        nodes: [node('img', 'input.image', { asset: upload.json.value }, 0, 0), node('res', 'output.result', {}, 200, 0)],
        edges: [edge('e1', 'img', 'image', 'res', 'inputs')],
        groups: [],
        notes: []
      };
      const wf = (await api('GET', `/api/workflows/${runsId}`)).json.workflow;
      const saved = await api('PUT', `/api/workflows/${runsId}`, { baseRev: wf.rev, graph: imgGraph });
      assert.equal(saved.status, 200);
      const started = await api('POST', `/api/workflows/${runsId}/runs`, { mode: 'all', rev: saved.json.rev });
      assert.equal(started.status, 202);
      const record = await engine.whenFinished(runsId, started.json.runId);
      assert.equal(record.status, 'completed', JSON.stringify(record));
      assert.equal(record.nodes.img.status, 'done');
      const results = (await api('GET', `/api/workflows/${runsId}`)).json.results;
      assert.equal(results.nodes.img.history[0].variants[0].image.assetId, upload.json.value.assetId);
    }


    /* ----- outputs.zip and the run list ----- */
    {
      const zipWf = await makeWorkflow({ name: 'Zip Flow ä' });
      const zipId = zipWf.workflow.id;
      const empty = await api('GET', `/api/workflows/${zipId}/outputs.zip`);
      assert.equal(empty.status, 404, 'no results yet');
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/outputs.zip')).status, 404);
      assert.equal((await api('GET', '/api/workflows/bad%20id/outputs.zip')).status, 400);

      const up = await request('POST', `/api/workflows/${zipId}/uploads`, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(up.status, 200);
      const zipGraph = {
        nodes: [
          node('img', 'input.image', { asset: up.json.value }, 0, 0),
          node('txt', 'input.text', { text: 'hello zip' }, 0, 200),
          node('outB', 'output.result', { label: 'Notes / text' }, 300, 200),
          node('outA', 'output.result', { label: 'Hero image' }, 300, 0)
        ],
        edges: [edge('e1', 'img', 'image', 'outA', 'inputs'), edge('e2', 'txt', 'text', 'outB', 'inputs')],
        groups: [],
        notes: []
      };
      const zipSaved = await api('PUT', `/api/workflows/${zipId}`, { baseRev: 1, graph: zipGraph });
      assert.equal(zipSaved.status, 200);
      const zipRun = await api('POST', `/api/workflows/${zipId}/runs`, { mode: 'all', rev: zipSaved.json.rev });
      assert.equal(zipRun.status, 202);
      const zipRecord = await engine.whenFinished(zipId, zipRun.json.runId);
      assert.equal(zipRecord.status, 'completed');

      const zip = await binaryRequest(`/api/workflows/${zipId}/outputs.zip`);
      assert.equal(zip.status, 200);
      assert.equal(zip.headers['content-type'], 'application/zip');
      assert.match(zip.headers['content-disposition'], /^attachment; filename="Zip-Flow-outputs\.zip"/);
      assert.ok(zip.headers['content-disposition'].includes("filename*=UTF-8''Zip%20Flow%20%C3%A4-outputs.zip"));
      const files = await unzip(zip.body);
      assert.deepEqual(Object.keys(files).sort(), ['01-Hero-image.png', '02-Notes-text.txt'], 'canvas order (top to bottom), safe names');
      assert.ok(files['01-Hero-image.png'].equals(PNG), 'the ZIP holds the stored file');
      assert.equal(files['02-Notes-text.txt'].toString('utf8'), 'hello zip');

      // ?runId= uses the entries of that run
      const byRun = await unzip((await binaryRequest(`/api/workflows/${zipId}/outputs.zip?runId=${zipRun.json.runId}`)).body);
      assert.deepEqual(Object.keys(byRun).sort(), ['01-Hero-image.png', '02-Notes-text.txt']);
      assert.equal((await api('GET', `/api/workflows/${zipId}/outputs.zip?runId=r-unknown`)).status, 404);
      assert.equal((await api('GET', `/api/workflows/${zipId}/outputs.zip?runId=bad%20id`)).status, 400);

      // run list: newest first, limit, cost summary fields
      const runsList = await api('GET', `/api/workflows/${zipId}/runs`);
      assert.equal(runsList.status, 200);
      assert.equal(runsList.json.runs.length, 1);
      assert.equal(runsList.json.runs[0].id, zipRun.json.runId);
      assert.equal(runsList.json.runs[0].status, 'completed');
      assert.equal(runsList.json.runs[0].user, 'tester');
      assert.ok(runsList.json.runs[0].cost && runsList.json.runs[0].startedAt);
      assert.equal(runsList.json.runs[0].nodes, undefined, 'list entries carry no per-node detail');
      const second = await api('POST', `/api/workflows/${zipId}/runs`, { mode: 'all', force: true, rev: zipSaved.json.rev });
      await engine.whenFinished(zipId, second.json.runId);
      const two = await api('GET', `/api/workflows/${zipId}/runs?limit=1`);
      assert.equal(two.json.runs.length, 1);
      assert.equal(two.json.runs[0].id, second.json.runId);
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/runs')).status, 404);

      /* ----- send-to-chat: media is copied, text is quoted, a visible upload message is appended ----- */
      const chat = await store.createSession({ folder: chatFolder });
      chatSessions.push(chat.id);
      const beforeMessages = (await store.readSession(chat.id)).messages.length;
      const sent = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: chat.id });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(sent.json.assetIds.length, 1);
      const chatSession = await store.readSession(chat.id);
      assert.equal(chatSession.messages.length, beforeMessages + 1);
      const message = chatSession.messages[chatSession.messages.length - 1];
      assert.equal(message.role, 'user');
      assert.deepEqual(message.uploadIds, sent.json.assetIds);
      // the note for the Director: real umlauts, workflow, node and asset id; no ASCII transliteration
      assert.equal(message.content, `Aus dem Workflow «Zip Flow ä» übernommen: Ergebnis von «Hero image», gespeichert als Asset ${sent.json.assetIds[0]}.`);
      assert.deepEqual(message.origin, {
        kind: 'workflow',
        workflowId: zipId,
        workflowName: 'Zip Flow ä',
        nodeId: 'outA',
        nodeLabel: 'Hero image',
        nodeType: 'output.result',
        ports: [{ id: 'result', type: 'image' }],
        texts: []
      });
      assert.ok(message.ts);
      const chatLedger = await store.readLedger(chat.id);
      const copiedEntry = chatLedger.find((entry) => entry.id === sent.json.assetIds[0]);
      assert.ok(copiedEntry && !copiedEntry.pending);
      assert.ok((await fsp.readFile(path.join(store.sessionAssetDir(chat.id), copiedEntry.file))).equals(PNG));
      assert.deepEqual((await fsp.readdir(store.sessionAssetDir(chat.id))).filter((name) => name.startsWith('.import-')), []);

      const sentText = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outB', sessionId: chat.id });
      assert.equal(sentText.status, 200, sentText.text);
      assert.deepEqual(sentText.json.assetIds, []);
      const textMessage = (await store.readSession(chat.id)).messages.slice(-1)[0];
      assert.ok(textMessage.content.includes('hello zip'));
      assert.ok(textMessage.content.includes('Text (Ausgang «result»):'));
      assert.equal(textMessage.uploadIds, undefined, 'a text result carries no uploads');
      assert.deepEqual(textMessage.origin.ports, [{ id: 'result', type: 'text' }]);
      assert.deepEqual(textMessage.origin.texts, [{ port: 'result', text: 'hello zip' }]);

      // a result with a video and side texts (like the expanded prompt of the fal nodes): only the media by default
      {
        const videoLeaf = { ...up.json.value, type: 'video' };
        const appended = await wfStore.appendHistory(zipId, 'img', {
          cacheKey: 'wp17',
          createdAt: new Date().toISOString(),
          variants: [{ video: videoLeaf, expanded_prompt: textValue('A very long expanded prompt '.repeat(10)), json: textValue('{"seed":1}') }]
        });
        const plan = await api('GET', `/api/workflows/${zipId}/send-to-chat/plan?nodeId=img`);
        assert.equal(plan.status, 200, plan.text);
        assert.equal(plan.json.workflow.name, 'Zip Flow ä');
        assert.equal(plan.json.node.type, 'input.image');
        assert.equal(plan.json.maxFiles, 24);
        const byId = Object.fromEntries(plan.json.ports.map((port) => [port.id, port]));
        assert.deepEqual(Object.keys(byId).sort(), ['expanded_prompt', 'json', 'video']);
        assert.equal(byId.video.kind, 'video');
        assert.equal(byId.video.selected, true);
        assert.equal(byId.video.media.length, 1);
        assert.equal(byId.video.media[0].assetId, up.json.value.assetId);
        assert.equal(byId.expanded_prompt.selected, false, 'side texts of a media result start unchecked');
        assert.equal(byId.json.selected, false);
        assert.equal(byId.expanded_prompt.texts[0].preview.length, 120, 'the dialog gets the first 120 characters only');
        assert.ok(byId.expanded_prompt.texts[0].length > 120);

        const before = (await store.readSession(chat.id)).messages.length;
        const media = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id });
        assert.equal(media.status, 200, media.text);
        assert.equal(media.json.assetIds.length, 1);
        assert.deepEqual(media.json.ports, ['video']);
        assert.equal(media.json.texts, 0);
        let sentMessage = (await store.readSession(chat.id)).messages.slice(-1)[0];
        assert.equal((await store.readSession(chat.id)).messages.length, before + 1);
        assert.ok(!sentMessage.content.includes('expanded'), 'the side text stays out of the message');
        assert.deepEqual(sentMessage.origin.ports, [{ id: 'video', type: 'video' }]);
        assert.deepEqual(sentMessage.origin.texts, []);
        assert.equal(sentMessage.origin.nodeType, 'input.image');

        // explicit ports: media plus one side text; the text is kept for the card and for the Director
        const both = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, entry: appended.entry.id, variant: 0, ports: ['video', 'expanded_prompt'] });
        assert.equal(both.status, 200, both.text);
        assert.equal(both.json.texts, 1);
        sentMessage = (await store.readSession(chat.id)).messages.slice(-1)[0];
        assert.ok(sentMessage.content.includes('Text (Ausgang «expanded_prompt»):\nA very long expanded prompt'));
        assert.ok(!sentMessage.content.includes('"seed"'));
        assert.deepEqual(sentMessage.origin.ports.map((port) => port.id), ['video', 'expanded_prompt']);
        assert.equal(sentMessage.origin.texts[0].port, 'expanded_prompt');

        // only a text port: no files; the older single `port` keeps working
        const onlyText = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, port: 'json' });
        assert.equal(onlyText.status, 200, onlyText.text);
        assert.deepEqual(onlyText.json.assetIds, []);
        sentMessage = (await store.readSession(chat.id)).messages.slice(-1)[0];
        assert.equal(sentMessage.uploadIds, undefined);
        assert.equal(sentMessage.content, `Aus dem Workflow «Zip Flow ä» übernommen: Ergebnis von «${sentMessage.origin.nodeLabel}».\nText (Ausgang «json»):\n{"seed":1}`);

        // a port that does not exist sends nothing
        assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, ports: ['nope'] })).status, 404);
        assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, ports: 'video' })).status, 400);
        assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, ports: ['bad id'] })).status, 400);
        assert.equal((await api('GET', `/api/workflows/${zipId}/send-to-chat/plan`)).status, 400);
        assert.equal((await api('GET', `/api/workflows/${zipId}/send-to-chat/plan?nodeId=nope`)).status, 404);
        assert.equal((await api('GET', `/api/workflows/${zipId}/send-to-chat/plan?nodeId=img&entry=h-unknown`)).status, 404);
        assert.equal((await api('GET', `/api/workflows/${zipId}/send-to-chat/plan?nodeId=img&variant=x`)).status, 400);

        // only a missing chat is reported as CHAT_NOT_FOUND; the client shows "chat gone" for that code alone
        const noPort = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, ports: ['nope'] });
        assert.equal(noPort.json.code, 'NOT_FOUND', 'a port that is gone is not a chat problem');
        const noEntry = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: chat.id, entry: 'h-unknown' });
        assert.equal(noEntry.status, 404);
        assert.equal(noEntry.json.code, 'ENTRY_NOT_FOUND');
        const noChat = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'img', sessionId: 'a'.repeat(32) });
        assert.equal(noChat.status, 404);
        assert.equal(noChat.json.code, 'CHAT_NOT_FOUND');
        assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/send-to-chat/plan?nodeId=img')).status, 404);
      }

      const zipResults = (await api('GET', `/api/workflows/${zipId}`)).json.results;
      const entryId = zipResults.nodes.outA.selected.entry;
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: chat.id, entry: entryId, variant: 0, port: 'result' })).status, 200);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: chat.id, entry: entryId, variant: 9 })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: chat.id, entry: 'h-unknown' })).status, 404);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'nope', sessionId: chat.id })).status, 404);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: 'no-such-chat' })).status, 404);
      // F1: nothing is appended while the Director is working in the chat (running turn or open tool round)
      {
        const before = (await store.readSession(chat.id)).messages.length;
        busyChats.add(chat.id);
        const busy = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outB', sessionId: chat.id });
        assert.equal(busy.status, 409);
        assert.equal(busy.json.code, 'CHAT_BUSY');
        busyChats.delete(chat.id);
        assert.equal((await store.readSession(chat.id)).messages.length, before, 'a busy chat is left untouched');
        await store.mutateSession(chat.id, (session) => {
          session.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'x', arguments: '{}' } }, { id: 'call-b', type: 'function', function: { name: 'x', arguments: '{}' } }], ts: new Date().toISOString() });
          session.messages.push({ role: 'tool', tool_call_id: 'call-a', name: 'x', content: 'ok', ts: new Date().toISOString() });
        });
        const open = await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outB', sessionId: chat.id });
        assert.equal(open.status, 409, 'an unanswered tool call blocks the send');
        assert.equal((await store.readSession(chat.id)).messages.length, before + 2);
        await store.mutateSession(chat.id, (session) => {
          session.messages.push({ role: 'tool', tool_call_id: 'call-b', name: 'x', content: 'ok', ts: new Date().toISOString() });
        });
        assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outB', sessionId: chat.id })).status, 200, 'a finished tool round allows the send');
      }
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: 'bad id' })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'bad id', sessionId: chat.id })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { sessionId: chat.id })).status, 400);
      assert.equal((await api('POST', `/api/workflows/${zipId}/send-to-chat`, { nodeId: 'outA', sessionId: zipWf.workflow.sessionId })).status, 400, 'a workflow session is no chat');
      assert.equal((await api('POST', '/api/workflows/wf-does-not-exist/send-to-chat', { nodeId: 'outA', sessionId: chat.id })).status, 404);
      const emptyWf = await makeWorkflow({ name: 'No results' });
      assert.equal((await api('POST', `/api/workflows/${emptyWf.workflow.id}/send-to-chat`, { nodeId: 'a', sessionId: chat.id })).status, 404);
    }

    // invalid graph: required input not connected
    {
      const brokenWf = await makeWorkflow({ name: 'Broken' });
      const broken = { nodes: [node('u', 't.upper', {}, 0, 0)], edges: [], groups: [], notes: [] };
      assert.equal((await api('PUT', `/api/workflows/${brokenWf.workflow.id}`, { baseRev: 1, graph: broken })).status, 200);
      const res = await api('POST', `/api/workflows/${brokenWf.workflow.id}/runs`, { mode: 'all', rev: 2 });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'INVALID_GRAPH');
      assert.ok(Array.isArray(res.json.issues) && res.json.issues.length > 0);
      assert.equal(res.json.issues[0].nodeId, 'u');
    }

    // active run: 409 on second start, delete refused, cancel works, 429 at the limit
    {
      const slowWf = await makeWorkflow({ name: 'Slow' });
      const slowId = slowWf.workflow.id;
      const slowGraph = { nodes: [node('a', 'input.text', { text: 'x' }), node('s', 't.slow', {}, 200, 0)], edges: [edge('e1', 'a', 'text', 's', 'in')], groups: [], notes: [] };
      assert.equal((await api('PUT', `/api/workflows/${slowId}`, { baseRev: 1, graph: slowGraph })).status, 200);
      const started = await api('POST', `/api/workflows/${slowId}/runs`, { mode: 'all', rev: 2 });
      assert.equal(started.status, 202);
      const runId = started.json.runId;
      await waitFor(() => gate.started >= 1, 'slow node start');

      const again = await api('POST', `/api/workflows/${slowId}/runs`, { mode: 'all', rev: 2 });
      assert.equal(again.status, 409);
      assert.equal(again.json.runId, runId);
      assert.equal(again.json.code, 'RUN_ACTIVE');
      assert.equal((await api('GET', `/api/workflows/${slowId}`)).json.activeRun, runId);
      const del = await api('DELETE', `/api/workflows/${slowId}`);
      assert.equal(del.status, 409);
      assert.equal(del.json.runId, runId);
      assert.equal((await api('GET', `/api/workflows/${slowId}`)).status, 200, 'refused delete keeps the workflow');

      // limit: maxActiveRuns is 2 -> a second workflow fits, a third gets 429
      const slow2 = await makeWorkflow({ name: 'Slow 2' });
      assert.equal((await api('PUT', `/api/workflows/${slow2.workflow.id}`, { baseRev: 1, graph: slowGraph })).status, 200);
      const run2 = await api('POST', `/api/workflows/${slow2.workflow.id}/runs`, { mode: 'all', rev: 2 });
      assert.equal(run2.status, 202);
      const slow3 = await makeWorkflow({ name: 'Slow 3' });
      assert.equal((await api('PUT', `/api/workflows/${slow3.workflow.id}`, { baseRev: 1, graph: slowGraph })).status, 200);
      const limited = await api('POST', `/api/workflows/${slow3.workflow.id}/runs`, { mode: 'all', rev: 2 });
      assert.equal(limited.status, 429);

      // SSE while the run is active: snapshot first, then live events, ping, cleanup on disconnect
      const sse = await new Promise((resolve, reject) => {
        const frames = [];
        const req = http.get({ host: '127.0.0.1', port, path: `/api/workflows/${slowId}/events` }, (res) => {
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              frames.push(buffer.slice(0, index));
              buffer = buffer.slice(index + 2);
            }
          });
          resolve({ req, res, frames });
        });
        req.on('error', reject);
        sseClients.push(req);
      });
      assert.equal(sse.res.statusCode, 200);
      assert.match(sse.res.headers['content-type'], /^text\/event-stream/);
      assert.equal(sse.res.headers['cache-control'], 'no-cache, no-transform');
      assert.equal(sse.res.headers['x-accel-buffering'], 'no');
      await waitFor(() => sse.frames.length >= 1, 'snapshot frame');
      const snapshot = JSON.parse(sse.frames[0].replace(/^data: /, ''));
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.activeRun.runId, runId);
      assert.equal(snapshot.activeRun.nodes.s, 'running');
      await waitFor(() => bus.listenerCount(slowId) === 1, 'subscription');
      await waitFor(() => sse.frames.some((frame) => frame.startsWith(': ping')), 'ping frame');

      const cancelled = await api('POST', `/api/workflows/${slowId}/runs/${runId}/cancel`, {});
      assert.deepEqual(cancelled.json, { ok: true });
      await waitFor(() => sse.frames.some((frame) => frame.includes('"type":"run_finished"')), 'run_finished frame');
      const parsed = sse.frames.filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)));
      const finishedEvent = parsed.find((event) => event.type === 'run_finished');
      assert.equal(finishedEvent.runId, runId);
      assert.equal(finishedEvent.status, 'cancelled');
      assert.ok(parsed.some((event) => event.type === 'node_status' && event.nodeId === 's' && event.status === 'cancelled'));

      // saving from another tab emits workflow_saved on the same stream
      const rev = (await api('GET', `/api/workflows/${slowId}`)).json.workflow.rev;
      await api('PUT', `/api/workflows/${slowId}`, { baseRev: rev, graph: { ...slowGraph, notes: [{ id: 't1', x: 0, y: 0, w: 10, h: 10, text: 'n' }] } });
      await waitFor(() => sse.frames.some((frame) => frame.includes('"type":"workflow_saved"')), 'workflow_saved frame');

      sse.req.destroy();
      await waitFor(() => bus.listenerCount(slowId) === 0, 'subscription cleanup');

      // unknown / invalid workflow for the stream
      assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/events')).status, 404);
      assert.equal((await api('GET', '/api/workflows/bad%20id/events')).status, 400);

      // cancel the remaining run, then deleting works
      const record2 = await api('GET', `/api/workflows/${slow2.workflow.id}`);
      engine.cancel(slow2.workflow.id, record2.json.activeRun);
      await engine.whenFinished(slow2.workflow.id, run2.json.runId);
      await engine.whenFinished(slowId, runId);
    }

    // handler-level SSE (fake response): headers, snapshot, forwarding, ping, cleanup on close
    {
      const sseApp = express();
      registerNodeRoutes(sseApp, { engine, store: wfStore, registry, events: bus, pingMs: 20 });
      const layer = sseApp._router.stack.find((item) => item.route?.path === '/api/workflows/:id/events');
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const writes = [];
      const listeners = {};
      const fakeRes = {
        headersSent: false,
        destroyed: false,
        head: null,
        writeHead(status, headers) {
          this.head = { status, headers };
          this.headersSent = true;
        },
        write(chunk) {
          writes.push(chunk);
        },
        on(name, fn) {
          listeners[name] = fn;
        },
        end() {}
      };
      await handler({ params: { id }, headers: {} }, fakeRes);
      assert.equal(fakeRes.head.status, 200);
      assert.equal(fakeRes.head.headers['Content-Type'], 'text/event-stream; charset=utf-8');
      assert.equal(fakeRes.head.headers['Cache-Control'], 'no-cache, no-transform');
      assert.deepEqual(JSON.parse(writes[0].replace(/^data: /, '')), { type: 'snapshot', activeRun: null });
      assert.equal(bus.listenerCount(id), 1);
      bus.emit(id, { type: 'node_log', runId: 'r', nodeId: 'n1', label: 'hello' });
      assert.ok(writes.some((chunk) => chunk === `data: ${JSON.stringify({ type: 'node_log', runId: 'r', nodeId: 'n1', label: 'hello' })}\n\n`));
      await waitFor(() => writes.includes(': ping\n\n'), 'ping write');
      listeners.close();
      assert.equal(bus.listenerCount(id), 0);
      const count = writes.length;
      bus.emit(id, { type: 'node_log', label: 'late' });
      await sleep(60);
      assert.equal(writes.length, count, 'nothing is written after close');
      assert.equal(await handler({ params: { id: 'bad id' }, headers: {} }, { status: () => ({ json: () => {} }), headersSent: false }), undefined);
    }

    /* ----- delete ----- */
    {
      const doomed = await makeWorkflow({ name: 'Doomed' });
      const doomedId = doomed.workflow.id;
      const upload = await request('POST', `/api/workflows/${doomedId}/uploads`, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
      assert.equal(upload.status, 200);
      const assetDir = store.sessionAssetDir(doomed.workflow.sessionId);
      assert.ok((await fsp.readdir(assetDir)).length > 0);
      const del = await api('DELETE', `/api/workflows/${doomedId}`);
      assert.equal(del.status, 200);
      assert.deepEqual(del.json, { ok: true, id: doomedId });
      assert.equal((await api('GET', `/api/workflows/${doomedId}`)).status, 404);
      await assert.rejects(fsp.access(assetDir), 'backing session assets are removed');
      await assert.rejects(store.readSession(doomed.workflow.sessionId));
      assert.equal((await api('DELETE', `/api/workflows/${doomedId}`)).status, 404);
      assert.equal((await api('DELETE', '/api/workflows/bad%20id')).status, 400);
    }

    /* ----- the user comes from the request ----- */
    currentUser = 'other@example.com';
    {
      const other = await makeWorkflow({ name: 'Other user' });
      assert.equal(other.workflow.createdBy, 'other@example.com');
      const saved = await api('PUT', `/api/workflows/${other.workflow.id}`, { baseRev: 1, graph: { nodes: [node('n1', 'input.text')], edges: [] } });
      assert.equal(saved.status, 200);
      assert.equal((await api('GET', `/api/workflows/${other.workflow.id}`)).json.workflow.updatedBy, 'other@example.com');
      assert.ok((await api('GET', '/api/workflows')).json.workflows.length > 3, 'workflows are team-visible, not filtered by user');
    }
    currentUser = 'tester';

    /* ----- wiring of the real server app ----- */
    {
      const { app: realApp } = require('../server');
      const layers = realApp._router.stack.filter((item) => item.route);
      const indexOf = (routePath, method) => layers.findIndex((item) => item.route.path === routePath && item.route.methods[method]);
      const catchAll = indexOf('*', 'get');
      assert.ok(catchAll > 0);
      for (const [routePath, method] of [
        ['/api/nodes/registry', 'get'],
        ['/api/nodes/options/:source', 'get'],
        ['/api/nodes/higgsfield-models/:modelId', 'get'],
        ['/api/workflow-templates', 'get'],
        ['/api/workflow-templates/:id', 'get'],
        ['/api/workflows/:id/send-to-chat/plan', 'get'],
        ['/api/workflows/:id/send-to-chat', 'post'],
        ['/api/workflows', 'get'],
        ['/api/workflows', 'post'],
        ['/api/workflows/import', 'post'],
        ['/api/workflows/import-zip', 'post'],
        ['/api/workflows/:id', 'get'],
        ['/api/workflows/:id', 'put'],
        ['/api/workflows/:id', 'patch'],
        ['/api/workflows/:id', 'delete'],
        ['/api/workflows/:id/duplicate', 'post'],
        ['/api/workflows/:id/export', 'get'],
        ['/api/workflows/:id/export-info', 'get'],
        ['/api/workflows/:id/export.zip', 'get'],
        ['/api/workflows/:id/uploads', 'post'],
        ['/api/workflows/:id/import-asset', 'post'],
        ['/api/workflows/:id/assets', 'get'],
        ['/api/workflows/:id/runs/plan', 'post'],
        ['/api/workflows/:id/runs', 'post'],
        ['/api/workflows/:id/runs', 'get'],
        ['/api/workflows/:id/outputs.zip', 'get'],
        ['/api/workflows/:id/runs/:runId', 'get'],
        ['/api/workflows/:id/runs/:runId/cancel', 'post'],
        ['/api/workflows/:id/results/:nodeId', 'patch'],
        ['/api/workflows/:id/events', 'get']
      ]) {
        const position = indexOf(routePath, method);
        assert.ok(position >= 0, `route missing: ${method.toUpperCase()} ${routePath}`);
        assert.ok(position < catchAll, `route registered after the catch-all: ${method.toUpperCase()} ${routePath}`);
      }
      // the real registry route lists the WP1 node types with availability
      const handler = layers[indexOf('/api/nodes/registry', 'get')].route.stack.slice(-1)[0].handle;
      const result = await new Promise((resolve, reject) => {
        const res = { status: () => res, json: resolve };
        Promise.resolve(handler({ params: {}, query: {}, headers: {} }, res)).catch(reject);
      });
      const types = result.nodeTypes.map((type) => type.type);
      for (const expected of ['input.text', 'input.image', 'text.template', 'output.result']) assert.ok(types.includes(expected), expected);
      assert.ok(result.nodeTypes.every((type) => type.available === true || typeof type.available === 'string'));
    }
  } finally {
    elevenlabs.hasKey = originals.hasKey;
    elevenlabs.listVoices = originals.listVoices;
    for (const client of sseClients) client.destroy();
    for (const wfId of created) {
      try {
        engine.cancel(wfId);
        await engine.whenFinished(wfId).catch(() => {});
        await wfStore.deleteWorkflow(wfId);
      } catch (_) {
        /* already deleted */
      }
    }
    for (const chatId of chatSessions) await store.deleteSession(chatId).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmpDir, { recursive: true, force: true });
    try {
      await store.deleteFolder?.(chatFolder);
    } catch (_) {
      /* folder registry entry is best-effort */
    }
  }
  console.log('test-nodes-api ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
