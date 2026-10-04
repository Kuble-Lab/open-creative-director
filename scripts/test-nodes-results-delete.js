'use strict';

// Deleting the results of a node (WP38e): one history entry or all results, in the store, over the routes, in the cache and in the
// node view. Parts:
//   1. store: one entry, all entries, the selection falls back to the newest entry left, files go only when nothing else needs them
//      (a Result node that passes the file on, a parameter of an input node, a note, an open provider job with published references, a
//      chat), a file of another session is never touched, the items a failed run kept, the event, the check that nothing is running
//   2. routes (private app, fake slow node): answers and status codes, 409 while a run is active
//   3. permissions (private copy of the app with user management): an outsider gets 404 and changes nothing, a teammate may delete
//   4. cache: after deleting, the next run makes the node again, for the whole node and per item (fake nodes with a counter)
//   5. node view without a browser (scripts/support/fake-dom.js): buttons, the question, cancelling changes nothing, confirming shows the new state
//   6. wording and wiring: texts in German, English and Spanish, the routes in the documentation
// Backing sessions, chats and temp folders are removed at the end. No provider is contacted, nothing is paid.

const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const assets = require('../lib/nodes/assets');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes } = require('../lib/nodes/routes');
const { textValue, listValue } = require('../lib/nodes/types');
const jobs = require('../lib/nodes/jobs');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createIsolatedApp } = require('./support/isolated-app');
const { loadPage, FakeNode } = require('./support/fake-dom');
const run = require('../public/nodes/run');
const { rows: nodeRows } = require('../public/nodes/i18n-nodes');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

const exists = (sessionId, file) =>
  fsp.access(path.join(store.sessionAssetDir(sessionId), file)).then(
    () => true,
    () => false
  );

/* ---------- 1. store ---------- */

async function testStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-results-delete-'));
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir, events: bus });
  const sessionIds = [];
  const workflowIds = [];
  const chats = [];
  try {
    async function makeWorkflow(nodes = [node('img', 'x.image'), node('res', 'output.result')]) {
      const { workflow } = await wfStore.createWorkflow({ name: 'Delete test', graph: { nodes, edges: [] } });
      workflowIds.push(workflow.id);
      sessionIds.push(workflow.sessionId);
      return workflow;
    }
    async function makeAsset(sessionId, prompt = 'p') {
      const saved = await store.saveAsset(sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt });
      return { ...(await assets.valueFromAsset(sessionId, saved.id)), file: saved.file };
    }
    const entryOf = (...values) => ({
      runId: 'r-test',
      createdAt: new Date().toISOString(),
      cacheKey: `sha256:${Math.random()}`,
      params: {},
      variants: values.map((value) => ({ image: value })),
      cost: { usd: null, credits: null }
    });
    const append = async (workflow, nodeId, ...values) => (await wfStore.appendHistory(workflow.id, nodeId, entryOf(...values))).entry.id;
    const ledgerIds = async (sessionId) => (await store.readLedger(sessionId)).map((item) => item.id);
    const results = async (workflow, nodeId) => (await wfStore.readResults(workflow.id)).nodes[nodeId];

    /* ----- one entry at a time, the selection falls back ----- */
    {
      const wf = await makeWorkflow();
      const [a, b, c] = [await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId)];
      const hA = await append(wf, 'img', a);
      const hB = await append(wf, 'img', b);
      const hC = await append(wf, 'img', c);
      assert.deepEqual((await results(wf, 'img')).history.map((item) => item.id), [hC, hB, hA]);

      // the selected entry (the oldest) goes: the newest one left is selected, variant 0
      await wfStore.selectVariant(wf.id, 'img', { entry: hA, variant: 0 });
      const first = await wfStore.deleteResults(wf.id, 'img', { entry: hA });
      assert.deepEqual(first.removed, [hA]);
      assert.deepEqual(first.node.selected, { entry: hC, variant: 0 });
      assert.deepEqual(first.node.history.map((item) => item.id), [hC, hB]);
      assert.deepEqual(first.files, { deleted: [a.assetId], kept: [] });
      assert.equal(await exists(wf.sessionId, a.file), false, 'the file of the deleted entry is gone');
      assert.equal((await ledgerIds(wf.sessionId)).includes(a.assetId), false, 'and its ledger line');
      assert.equal(await exists(wf.sessionId, b.file), true, 'the others stay');
      assert.deepEqual((await results(wf, 'img')).selected, { entry: hC, variant: 0 }, 'stored too');

      // an entry that is not selected goes: the selection stays
      await wfStore.selectVariant(wf.id, 'img', { entry: hB, variant: 0 });
      const second = await wfStore.deleteResults(wf.id, 'img', { entry: hC });
      assert.deepEqual(second.node.selected, { entry: hB, variant: 0 });
      assert.equal(await exists(wf.sessionId, c.file), false);

      // the last entry goes: no result any more
      const third = await wfStore.deleteResults(wf.id, 'img', { entry: hB });
      assert.deepEqual(third.node, { selected: null, history: [] });
      assert.deepEqual(await results(wf, 'img'), { selected: null, history: [] });
      assert.equal(await exists(wf.sessionId, b.file), false);

      // unknown entry, unknown node, nothing to delete
      await assert.rejects(wfStore.deleteResults(wf.id, 'img', { entry: 'h-nope' }), { code: 'ENTRY_NOT_FOUND' });
      await assert.rejects(wfStore.deleteResults(wf.id, 'img', { entry: hB }), { code: 'ENTRY_NOT_FOUND' }, 'deleted twice');
      await assert.rejects(wfStore.deleteResults(wf.id, 'zz', { entry: 'x' }), { code: 'ENTRY_NOT_FOUND' });
      await assert.rejects(wfStore.deleteResults(wf.id, 'img'), { code: 'ENTRY_NOT_FOUND' }, 'all of a node without results');
      await assert.rejects(wfStore.deleteResults(wf.id, 'zz'), { code: 'ENTRY_NOT_FOUND' });
      await assert.rejects(wfStore.deleteResults('not a valid id', 'img'), { code: 'INVALID_ID' });
    }

    /* ----- all results of a node: every variant, the key leaves results.json, the other node is not touched ----- */
    {
      const wf = await makeWorkflow([node('img', 'x.image'), node('other', 'x.image')]);
      const [a, b, c, other] = [await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId)];
      await append(wf, 'img', a, b);
      await append(wf, 'img', c);
      await append(wf, 'other', other);
      const gone = await wfStore.deleteResults(wf.id, 'img');
      assert.equal(gone.removed.length, 2);
      assert.deepEqual(gone.node, { selected: null, history: [] });
      assert.deepEqual([...gone.files.deleted].sort(), [a.assetId, b.assetId, c.assetId].sort());
      for (const value of [a, b, c]) assert.equal(await exists(wf.sessionId, value.file), false);
      assert.equal('img' in (await wfStore.readResults(wf.id)).nodes, false);
      assert.equal((await results(wf, 'other')).history.length, 1);
      assert.equal(await exists(wf.sessionId, other.file), true);
    }

    /* ----- a file something else needs stays ----- */
    {
      const wf = await makeWorkflow([node('img', 'x.image'), node('res', 'output.result'), node('in', 'input.image'), node('note', 'x.other')]);
      const [passed, param, noted, own] = [await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId)];

      // a Result node passes the same file on: the other entry holds it
      const hImg = await append(wf, 'img', passed);
      const hRes = await append(wf, 'res', passed);
      const kept = await wfStore.deleteResults(wf.id, 'img', { entry: hImg });
      assert.deepEqual(kept.files, { deleted: [], kept: [passed.assetId] });
      assert.equal(await exists(wf.sessionId, passed.file), true);
      assert.equal((await ledgerIds(wf.sessionId)).includes(passed.assetId), true, 'the ledger keeps it');
      assert.equal((await results(wf, 'res')).history[0].variants[0].image.assetId, passed.assetId);
      const last = await wfStore.deleteResults(wf.id, 'res', { entry: hRes });
      assert.deepEqual(last.files, { deleted: [passed.assetId], kept: [] }, 'nothing else holds it now');
      assert.equal(await exists(wf.sessionId, passed.file), false);

      // a parameter of an input node (asset picker "this workflow") and a text that carries the address
      const current = await wfStore.readWorkflow(wf.id);
      const nodes = current.graph.nodes.map((item) => (item.id === 'in' ? { ...item, params: { asset: { sessionId: wf.sessionId, assetId: param.assetId, file: param.file } } } : item));
      await wfStore.saveGraph(wf.id, {
        baseRev: current.rev,
        graph: { ...current.graph, nodes, notes: [{ id: 'n1', x: 0, y: 0, w: 100, h: 50, text: `see ${noted.url}` }] }
      });
      const hParam = await append(wf, 'img', param);
      const hNoted = await append(wf, 'img', noted);
      const hOwn = await append(wf, 'img', own);
      const outcome = await wfStore.deleteResults(wf.id, 'img');
      assert.deepEqual(outcome.removed.sort(), [hParam, hNoted, hOwn].sort());
      assert.deepEqual(outcome.files.deleted, [own.assetId]);
      assert.deepEqual(outcome.files.kept.sort(), [param.assetId, noted.assetId].sort());
      assert.equal(await exists(wf.sessionId, param.file), true, 'an input parameter keeps the file');
      assert.equal(await exists(wf.sessionId, noted.file), true, 'an address in the document keeps the file');
      assert.equal(await exists(wf.sessionId, own.file), false);
    }

    /* ----- outside holders: an open job with published references, the chats ----- */
    {
      const wf = await makeWorkflow();
      const [jobFile, chatUrl, chatPair, free] = [await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId), await makeAsset(wf.sessionId)];

      // an open job of the session that still has public reference copies: everything stays
      await store.mutateSession(wf.sessionId, (session) => {
        session.jobs.push({ jobId: 'j1', assetId: 'vid-777', status: 'running', publicRefFiles: ['0123456789abcdef0123456789abcdef.mp4'] });
      });
      await append(wf, 'img', jobFile);
      const heldByJob = await wfStore.deleteResults(wf.id, 'img');
      assert.deepEqual(heldByJob.files, { deleted: [], kept: [jobFile.assetId] });
      assert.equal(await exists(wf.sessionId, jobFile.file), true);
      // the same job once it is over: its references are not a reason any more, and the file can go
      await store.mutateSession(wf.sessionId, (session) => {
        session.jobs[0].status = 'completed';
      });
      await append(wf, 'img', jobFile);
      const afterJob = await wfStore.deleteResults(wf.id, 'img');
      assert.deepEqual(afterJob.files, { deleted: [jobFile.assetId], kept: [] });

      // a chat that shows the file by its address, a chat that names session and asset id, a chat that mentions neither
      const chatA = await store.createSession();
      const chatB = await store.createSession();
      const chatC = await store.createSession();
      chats.push(chatA.id, chatB.id, chatC.id);
      await store.mutateSession(chatA.id, (session) => {
        session.messages.push({ role: 'assistant', content: `Hier: ${chatUrl.url}` });
      });
      await store.mutateSession(chatB.id, (session) => {
        session.messages.push({ role: 'assistant', content: 'Referenz', refs: [{ sessionId: wf.sessionId, assetId: chatPair.assetId }] });
      });
      await store.mutateSession(chatC.id, (session) => {
        session.messages.push({ role: 'user', content: `${free.assetId} ohne Session` });
      });
      await append(wf, 'img', chatUrl);
      await append(wf, 'img', chatPair);
      await append(wf, 'img', free);
      const heldByChat = await wfStore.deleteResults(wf.id, 'img');
      assert.deepEqual(heldByChat.files.deleted, [free.assetId], 'only the file no chat points at goes');
      assert.deepEqual(heldByChat.files.kept.sort(), [chatUrl.assetId, chatPair.assetId].sort());
      assert.equal(await exists(wf.sessionId, chatUrl.file), true);
      assert.equal(await exists(wf.sessionId, chatPair.file), true);
      assert.equal(await exists(wf.sessionId, free.file), false);

      // a failing check of the holders keeps everything (better a file too many)
      const keepAll = await makeAsset(wf.sessionId);
      await append(wf, 'img', keepAll);
      const failing = await wfStore.deleteResults(wf.id, 'img', {
        holds: async () => {
          throw new Error('unreadable');
        }
      });
      assert.deepEqual(failing.files, { deleted: [], kept: [keepAll.assetId] });
    }

    /* ----- a file of another session is not ours to delete; a pending asset is never removed ----- */
    {
      const wf = await makeWorkflow();
      const chat = await store.createSession();
      chats.push(chat.id);
      const foreign = await makeAsset(chat.id);
      await append(wf, 'img', foreign);
      const outcome = await wfStore.deleteResults(wf.id, 'img');
      assert.deepEqual(outcome.files, { deleted: [], kept: [] }, 'not considered at all');
      assert.equal(await exists(chat.id, foreign.file), true);
      assert.equal((await ledgerIds(chat.id)).includes(foreign.assetId), true);

      const reserved = await store.reserveAsset(wf.sessionId, { kind: 'video', ext: '.mp4' });
      assert.deepEqual(await store.removeAssets(wf.sessionId, [reserved.id]), [], 'a pending asset stays');
      assert.equal((await ledgerIds(wf.sessionId)).includes(reserved.id), true);
      assert.deepEqual(await store.removeAssets(wf.sessionId, []), []);
    }

    /* ----- the items a failed run kept are a cache too ----- */
    {
      const wf = await makeWorkflow([node('lst', 'x.list')]);
      const fresh = await makeAsset(wf.sessionId);
      const t = (value) => textValue(value);
      const list = (...items) => ({ out: listValue('text', items.map(t)) });
      await wfStore.updateResults(wf.id, (data) => {
        data.nodes.lst = {
          selected: { entry: 'h-1', variant: 0 },
          history: [{ id: 'h-1', cacheKey: 'sha256:whole', itemKeys: ['k1', 'k2', 'k3'], variants: [list('one', 'two', 'three')], cost: { usd: 1 } }],
          partial: {
            cacheKey: 'sha256:other',
            itemKeys: ['k1', 'k2', 'k4', 'k5'],
            forcedItems: [0, 2],
            items: { 0: { variant: { out: t('one') } }, 1: { variant: { out: t('two') } }, 2: { variant: { out: t('four') } }, 3: { variant: { image: fresh } } }
          }
        };
      });
      // the copies the failed run took from the deleted entry go, the items it made itself stay (paid work is not thrown away)
      const single = await wfStore.deleteResults(wf.id, 'lst', { entry: 'h-1' });
      assert.deepEqual(Object.keys(single.node.partial.items).sort(), ['2', '3']);
      assert.deepEqual(single.node.partial.forcedItems, [2]);
      assert.deepEqual(single.node.history, []);
      assert.equal(await exists(wf.sessionId, fresh.file), true, 'a file the partial still holds stays');
      // all results: the partial goes as well, with the files nothing else holds
      await wfStore.updateResults(wf.id, (data) => {
        data.nodes.lst.history = [{ id: 'h-2', cacheKey: 'sha256:w2', variants: [list('x')], cost: {} }];
      });
      const all = await wfStore.deleteResults(wf.id, 'lst');
      assert.deepEqual(all.node, { selected: null, history: [] });
      assert.deepEqual(all.files.deleted, [fresh.assetId]);
      assert.equal(await exists(wf.sessionId, fresh.file), false);
      assert.equal('lst' in (await wfStore.readResults(wf.id)).nodes, false);

      // a partial that cannot be told apart item by item goes as a whole
      await wfStore.updateResults(wf.id, (data) => {
        data.nodes.lst = {
          selected: { entry: 'h-3', variant: 0 },
          history: [{ id: 'h-3', cacheKey: 'sha256:w3', variants: [list('a')], cost: {} }, { id: 'h-4', cacheKey: 'sha256:w4', variants: [list('b')], cost: {} }],
          partial: { cacheKey: 'sha256:other', items: { 0: { variant: { out: t('a') } } } }
        };
      });
      const unkeyed = await wfStore.deleteResults(wf.id, 'lst', { entry: 'h-4' });
      assert.equal('partial' in unkeyed.node, false);
      assert.deepEqual(unkeyed.node.selected, { entry: 'h-3', variant: 0 });
    }

    /* ----- the event, the check that nothing runs ----- */
    {
      const wf = await makeWorkflow();
      const a = await makeAsset(wf.sessionId);
      const h = await append(wf, 'img', a);
      let calls = 0;
      await assert.rejects(
        wfStore.deleteResults(wf.id, 'img', {
          entry: h,
          assertIdle: () => {
            calls += 1;
            throw Object.assign(new Error('busy'), { code: 'RUN_ACTIVE' });
          }
        }),
        { code: 'RUN_ACTIVE' }
      );
      assert.equal(calls, 1);
      assert.equal((await results(wf, 'img')).history.length, 1, 'nothing changed');
      assert.equal(await exists(wf.sessionId, a.file), true);

      const seen = [];
      const stop = bus.subscribe(wf.id, (event) => seen.push(event));
      await wfStore.deleteResults(wf.id, 'img', { entry: h, user: 'dora' });
      stop();
      assert.deepEqual(seen, [{ type: 'results_changed', nodeId: 'img', updatedBy: 'dora' }]);
      const rev = (await wfStore.readWorkflow(wf.id)).rev;
      assert.equal(rev, 1, 'the revision of the graph is not touched (results are the engine\'s file)');
    }
  } finally {
    for (const id of workflowIds) await wfStore.deleteWorkflow(id).catch(() => {});
    for (const id of sessionIds) await store.deleteSession(id).catch(() => {});
    for (const id of chats) await store.deleteSession(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- 2. routes ---------- */

async function startApp() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-results-routes-'));
  const bus = createEventBus();
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  registry.register({
    type: 't.slow',
    category: 'text',
    inputs: [],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx) => {
      await jobs.sleep(60000, ctx.signal);
      return { variants: [{ out: textValue('slow') }] };
    }
  });
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { maxActiveRuns: 2 } });
  const app = express();
  app.use(express.json());
  registerNodeRoutes(app, { publicRuntimeConfig: () => ({}), engine, store: wfStore, registry, events: bus, importScratchDir: path.join(tmpDir, 'scratch'), isTurnActive: () => false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = server.address().port;
  assert.notEqual(port, 3111);
  const call = async (method, url, json) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: json ? { 'Content-Type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { tmpDir, wfStore, engine, server, call };
}

async function testRoutes() {
  const env = await startApp();
  const created = [];
  const chats = [];
  try {
    const { wfStore, call, engine } = env;
    const { workflow } = await wfStore.createWorkflow({ name: 'Route test', graph: { nodes: [node('slow', 't.slow')], edges: [] } });
    created.push(workflow);
    const seed = async (count) => {
      const ids = [];
      for (let i = 0; i < count; i += 1) {
        const saved = await store.saveAsset(workflow.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'p' });
        const value = await assets.valueFromAsset(workflow.sessionId, saved.id);
        const entry = await wfStore.appendHistory(workflow.id, 'img', { cacheKey: `sha256:${i}`, params: {}, variants: [{ image: value }], cost: {} });
        ids.push({ entry: entry.entry.id, value });
      }
      return ids;
    };
    const base = `/api/workflows/${workflow.id}/results/img`;

    const entries = await seed(3);
    // one entry: the answer carries the node as it is now and the files that went / stay
    const one = await call('DELETE', `${base}/entries/${entries[2].entry}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.ok, true);
    assert.equal(one.body.nodeId, 'img');
    assert.deepEqual(one.body.removed, [entries[2].entry]);
    assert.deepEqual(one.body.node.selected, { entry: entries[1].entry, variant: 0 });
    assert.deepEqual(one.body.node.history.map((item) => item.id), [entries[1].entry, entries[0].entry]);
    assert.deepEqual(one.body.files, { deleted: 1, kept: 0 });
    assert.equal(await exists(workflow.sessionId, entries[2].value.file), false);
    // GET shows the same state
    const got = await call('GET', `/api/workflows/${workflow.id}`);
    assert.deepEqual(got.body.results.nodes.img.history.map((item) => item.id), [entries[1].entry, entries[0].entry]);

    // unknown entry / node, bad ids
    assert.equal((await call('DELETE', `${base}/entries/h-nope`)).status, 404);
    assert.equal((await call('DELETE', `${base}/entries/h-nope`)).body.code, 'ENTRY_NOT_FOUND');
    assert.equal((await call('DELETE', `${base}/entries/${entries[2].entry}`)).status, 404, 'deleted twice');
    assert.equal((await call('DELETE', `/api/workflows/${workflow.id}/results/zz/entries/h-1`)).status, 404);
    assert.equal((await call('DELETE', `/api/workflows/${workflow.id}/results/zz`)).status, 404);
    assert.equal((await call('DELETE', `/api/workflows/${workflow.id}/results/bad%20id/entries/h`)).status, 400);
    assert.equal((await call('DELETE', `${base}/entries/bad%20id`)).status, 400);
    assert.equal((await call('DELETE', '/api/workflows/wf-unknown-1/results/img')).status, 404);
    assert.equal((await call('DELETE', '/api/workflows/wf-unknown-1/results/img')).body.code, 'WORKFLOW_NOT_FOUND');

    // 409 while a run of the workflow is active: nothing changes
    const runId = await engine.start(workflow.id, { mode: 'node', nodeIds: ['slow'], force: true });
    const busy = await call('DELETE', `${base}/entries/${entries[0].entry}`);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'RUN_ACTIVE');
    assert.equal(busy.body.runId, runId);
    const busyAll = await call('DELETE', base);
    assert.equal(busyAll.status, 409);
    assert.equal(busyAll.body.code, 'RUN_ACTIVE');
    assert.equal((await wfStore.readResults(workflow.id)).nodes.img.history.length, 2);
    assert.equal(await exists(workflow.sessionId, entries[0].value.file), true);
    engine.cancel(workflow.id, runId);
    await engine.whenFinished(workflow.id, runId).catch(() => {});

    // all results of the node
    const all = await call('DELETE', base);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.node, { selected: null, history: [] });
    assert.equal(all.body.removed.length, 2);
    assert.deepEqual(all.body.files, { deleted: 2, kept: 0 });
    assert.equal((await call('DELETE', base)).status, 404, 'nothing left to delete');
    for (const item of entries) assert.equal(await exists(workflow.sessionId, item.value.file), false);
    // the routes are not shadowed by the select route
    assert.equal((await call('PATCH', base, { entry: 'h-x' })).status, 404);
  } finally {
    await new Promise((resolve) => {
      env.server.closeAllConnections?.();
      env.server.close(resolve);
    });
    for (const workflow of created) {
      await env.engine.whenFinished(workflow.id).catch(() => {});
      await env.wfStore.deleteWorkflow(workflow.id).catch(() => {});
      await store.deleteSession(workflow.sessionId).catch(() => {});
    }
    for (const id of chats) await store.deleteSession(id).catch(() => {});
    await fsp.rm(env.tmpDir, { recursive: true, force: true });
  }
}

/* ---------- 3. permissions ---------- */

async function testPermissions() {
  const ALICE = 'alice@example.com';
  const BOB = 'bob@example.com';
  const ADMIN = 'admin@example.com';
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: ADMIN, OPENROUTER_API_KEY: '' } });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  const isoStore = iso.load('lib/store');
  const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
  try {
    const created = await api('/api/workflows', { method: 'POST', as: ALICE, json: { name: 'Alice Flow' } });
    assert.equal(created.status, 201);
    const flow = created.body.workflow;
    const seed = async () => {
      const saved = await isoStore.saveAsset(flow.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'p' });
      const value = { type: 'image', sessionId: flow.sessionId, assetId: saved.id, file: saved.file, url: saved.url };
      const appended = await wfStore.appendHistory(flow.id, 'img', { cacheKey: `sha256:${saved.id}`, params: {}, variants: [{ image: value }], cost: {} });
      return { entry: appended.entry.id, file: saved.file };
    };
    const entryUrl = (id) => `/api/workflows/${flow.id}/results/img/entries/${id}`;

    // an outsider: 404 like for every other route of a private workflow, nothing changes
    const one = await seed();
    const two = await seed();
    for (const [url, as] of [[entryUrl(one.entry), BOB], [`/api/workflows/${flow.id}/results/img`, BOB], [entryUrl(one.entry), null]]) {
      const denied = await api(url, { method: 'DELETE', as });
      assert.equal(denied.status, 404, `${url} as ${as}`);
      assert.equal(denied.body.code, 'WORKFLOW_NOT_FOUND');
    }
    assert.equal((await wfStore.readResults(flow.id)).nodes.img.history.length, 2);
    assert.equal(fs.existsSync(path.join(isoStore.sessionAssetDir(flow.sessionId), one.file)), true);

    // the owner may; a teammate may after the workflow is shared with the team (the same right as choosing a variant)
    const byOwner = await api(entryUrl(two.entry), { method: 'DELETE', as: ALICE });
    assert.equal(byOwner.status, 200);
    assert.equal(byOwner.body.files.deleted, 1);
    const shared = await api(`/api/workflows/${flow.id}/share`, { method: 'PATCH', as: ALICE, json: { shareMode: 'team' } });
    assert.equal(shared.status, 200);
    const byTeammate = await api(entryUrl(one.entry), { method: 'DELETE', as: BOB });
    assert.equal(byTeammate.status, 200, JSON.stringify(byTeammate.body));
    assert.deepEqual(byTeammate.body.node, { selected: null, history: [] });
    assert.equal(fs.existsSync(path.join(isoStore.sessionAssetDir(flow.sessionId), one.file)), false);

    // an admin may, too; the teammate no longer after the workflow is private again
    const three = await seed();
    const four = await seed();
    assert.equal((await api(`/api/workflows/${flow.id}/share`, { method: 'PATCH', as: ALICE, json: { shareMode: 'private' } })).status, 200);
    assert.equal((await api(entryUrl(three.entry), { method: 'DELETE', as: BOB })).status, 404);
    assert.equal((await api(entryUrl(three.entry), { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await api(`/api/workflows/${flow.id}/results/img`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal(fs.existsSync(path.join(isoStore.sessionAssetDir(flow.sessionId), four.file)), false);
  } finally {
    await iso.cleanup();
  }
}

/* ---------- 4. cache ---------- */

function buildEnvironment() {
  const calls = [];
  const failOn = { value: null };
  let counter = 0;
  const registry = createRegistry();
  registry.register({
    type: 't.words',
    category: 'input',
    outputs: [{ id: 'items', type: 'text[]' }],
    params: [{ id: 'items', kind: 'text', default: 'a,b,c,d' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ items: listValue('text', params.items.split(',').filter(Boolean).map((word) => textValue(word))) }] })
  });
  registry.register({
    type: 't.single',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'text', kind: 'text', default: 'x' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ out: textValue(params.text) }] })
  });
  // the paid node with a counter: runs once per item of a list; its output carries the number of the execution
  registry.register({
    type: 't.scene',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'style', kind: 'text', default: 'plain' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => 0.5, history: false },
    execute: async (ctx, inputs, params) => {
      await sleep(5);
      const word = inputs.in.value;
      if (failOn.value === word) throw new Error(`rejected ${word}`);
      counter += 1;
      calls.push({ node: ctx.nodeId, input: word });
      return { variants: [{ out: textValue(`${word}-${params.style}#${counter}`) }], cost: { usd: 0.5 } };
    }
  });
  return { registry, calls, failOn };
}

async function testCache() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-results-cache-'));
  const bus = createEventBus();
  const env = buildEnvironment();
  const wfStore = createWorkflowsStore({ dir, registry: env.registry, events: bus });
  const engine = createEngine({ store: wfStore, registry: env.registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, parallel: 1 } });
  const created = [];
  try {
    const makeWorkflow = async (nodes, edges) => {
      const { workflow } = await wfStore.createWorkflow({ name: 'Cache test', graph: { nodes, edges } });
      created.push(workflow);
      return workflow;
    };
    const runAll = async (id, request = { mode: 'all' }) => engine.whenFinished(id, await engine.start(id, request));
    const setParams = async (id, nodeId, params) => {
      const current = await wfStore.readWorkflow(id);
      const nodes = current.graph.nodes.map((item) => (item.id === nodeId ? { ...item, params: { ...item.params, ...params } } : item));
      await wfStore.saveGraph(id, { baseRev: current.rev, graph: { ...current.graph, nodes } });
    };
    const ran = (nodeId) => env.calls.filter((call) => call.node === nodeId).map((call) => call.input);
    const reset = () => {
      env.calls.length = 0;
      env.failOn.value = null;
    };
    const stored = async (id, nodeId) => (await wfStore.readResults(id)).nodes[nodeId];
    const edgeTo = (from, to, fromPort, toPort) => ({ id: `${from}-${to}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

    /* ----- the whole node ----- */
    {
      reset();
      const wf = await makeWorkflow([node('s', 't.single', { text: 'solo' }), node('m', 't.scene')], [edgeTo('s', 'm', 'out', 'in')]);
      const first = await runAll(wf.id);
      assert.equal(first.status, 'completed');
      assert.deepEqual(ran('m'), ['solo']);
      reset();
      assert.equal((await runAll(wf.id)).nodes.m.status, 'cached', 'untouched: the cache answers');
      assert.deepEqual(ran('m'), []);
      // a second entry with the same key (forced), then the entries go one by one: while one is left, it serves
      await runAll(wf.id, { mode: 'node', nodeIds: ['m'], force: true });
      const history = (await stored(wf.id, 'm')).history;
      assert.equal(history.length, 2);
      reset();
      await wfStore.deleteResults(wf.id, 'm', { entry: history[0].id });
      assert.equal((await runAll(wf.id)).nodes.m.status, 'cached', 'the older entry with the same key still serves');
      await wfStore.deleteResults(wf.id, 'm', { entry: history[1].id });
      assert.equal((await stored(wf.id, 'm')).history.length, 0);
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.status, 'stale', 'the plan says the node is made again');
      reset();
      const again = await runAll(wf.id);
      assert.equal(again.status, 'completed');
      assert.equal(again.nodes.m.status, 'done', 'no cache hit once the last entry is gone');
      assert.deepEqual(ran('m'), ['solo'], 'the node is made again');
      assert.equal(Math.round(again.cost.usd * 100) / 100, 0.5, 'and booked again');
    }

    /* ----- per item: a deleted entry gives no items ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c,d' }), node('m', 't.scene')], [edgeTo('l', 'm', 'items', 'in')]);
      await runAll(wf.id);
      assert.deepEqual(ran('m').sort(), ['a', 'b', 'c', 'd']);
      // b becomes b2: the second entry holds a, b2, c, d (a, c, d reused from the first)
      await setParams(wf.id, 'l', { items: 'a,b2,c,d' });
      reset();
      await runAll(wf.id);
      assert.deepEqual(ran('m'), ['b2']);
      const [newest, oldest] = (await stored(wf.id, 'm')).history;
      // the newest entry goes: b2 only lived there, so it is made again; the rest comes from the older entry
      await wfStore.deleteResults(wf.id, 'm', { entry: newest.id });
      reset();
      const rerun = await runAll(wf.id);
      assert.equal(rerun.status, 'completed');
      assert.deepEqual(ran('m'), ['b2'], 'only the item that was in the deleted entry only');
      // all entries go: not one item is found any more
      await wfStore.deleteResults(wf.id, 'm');
      reset();
      const everything = await runAll(wf.id);
      assert.equal(everything.status, 'completed');
      assert.deepEqual(ran('m').sort(), ['a', 'b2', 'c', 'd'], 'every item is made again after "delete all"');
      assert.equal(Math.round(everything.cost.usd * 100) / 100, 2);
      assert.equal(oldest.itemKeys.length, 4);
    }

    /* ----- items a failed run took from the deleted entry are not served either ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], [edgeTo('l', 'm', 'items', 'in')]);
      await runAll(wf.id);
      // the list changes to a,e,b,x; "x" fails: a, b come from the entry, e is new and kept as a partial result
      await setParams(wf.id, 'l', { items: 'a,e,b,x' });
      reset();
      env.failOn.value = 'x';
      const failed = await runAll(wf.id);
      assert.equal(failed.status, 'failed');
      const kept = await stored(wf.id, 'm');
      assert.ok(kept.partial, 'the failed run kept its items');
      const entryId = kept.history[0].id;
      await wfStore.deleteResults(wf.id, 'm', { entry: entryId });
      const after = await stored(wf.id, 'm');
      for (const item of Object.values(after.partial ? after.partial.items : {})) {
        assert.doesNotMatch(item.variant.out.value, /^(a|b)-plain#/, 'a copy of an item of the deleted entry is not kept');
      }
      reset();
      const retry = await runAll(wf.id);
      assert.equal(retry.status, 'completed');
      assert.deepEqual(ran('m').sort(), ['a', 'b', 'x'], 'a, b and x are made again; only e, made by the failed run itself, is reused');
    }
  } finally {
    for (const workflow of created) {
      await engine.whenFinished(workflow.id).catch(() => {});
      await wfStore.deleteWorkflow(workflow.id).catch(() => {});
      await store.deleteSession(workflow.sessionId).catch(() => {});
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- 5. node view without a browser ---------- */

const image = (id) => ({ type: 'image', sessionId: 's1', assetId: id, file: `${id}.png`, url: `/assets/s1/${id}.png` });

function historyResults() {
  return {
    version: 1,
    nodes: {
      n1: {
        selected: { entry: 'h2', variant: 0 },
        history: [
          { id: 'h2', createdAt: '2026-10-01T10:00:00Z', params: { prompt: 'zweites' }, variants: [{ out: image('b') }], cost: { usd: 0.04 } },
          { id: 'h1', createdAt: '2026-10-01T09:00:00Z', params: {}, variants: [{ out: image('a') }], cost: {} }
        ]
      }
    }
  };
}

function buttonsOf(container) {
  return container.find((item) => item.tagName === 'BUTTON');
}

function testInspectorButtons() {
  for (const lang of ['de', 'en', 'es']) {
    const page = loadPage(lang, { scripts: ['node-ui', 'preview', 'inspector'] });
    const OCD = page.OCD;
    const asked = [];
    let busy = false;
    const info = () => ({
      def: {},
      busy,
      selected: { entry: 'h2', variant: 0 },
      outputOrder: ['out'],
      hiddenPorts: new Set(),
      isOutput: false,
      results: historyResults().nodes.n1
    });
    const cb = {
      run: {
        info,
        selectVariant() {},
        openResult() {},
        downloadResult() {},
        formatDuration: () => '1s',
        costText: () => '',
        deleteResult: (nodeId, entryId) => asked.push([nodeId, entryId])
      }
    };
    const inspector = OCD.inspector.createInspector({ host: page.root, getReg: () => null, callbacks: cb });
    const container = page.document.createElement('div');
    inspector.renderHistory(container, 'n1');
    const T = OCD.ui.T;

    // one button per entry, in the order of the entries, with a name that says what it does; one for all results
    const perEntry = buttonsOf(container).filter((button) => button.dataset.action === 'delete-entry');
    assert.deepEqual(perEntry.map((button) => button.dataset.entry), ['h2', 'h1']);
    for (const button of perEntry) {
      assert.equal(button.getAttribute('aria-label'), T('nodes.history.deleteEntry'));
      assert.equal(button.textContent, T('nodes.history.delete'));
      assert.equal(button.hasAttribute('disabled'), false);
    }
    const all = buttonsOf(container).filter((button) => button.dataset.action === 'delete-all');
    assert.equal(all.length, 1);
    assert.equal(all[0].textContent, T('nodes.history.deleteAll'));
    assert.notEqual(T('nodes.history.deleteAll'), 'nodes.history.deleteAll', `${lang}: the text exists`);

    // a click asks the run controller (it asks the person); the entry and the node are named
    perEntry[1].fire('click');
    all[0].fire('click');
    assert.deepEqual(asked, [['n1', 'h1'], ['n1', undefined]]);

    // while a run is active the buttons are there but off
    busy = true;
    const busyContainer = page.document.createElement('div');
    inspector.renderHistory(busyContainer, 'n1');
    assert.ok(buttonsOf(busyContainer).filter((button) => button.dataset.action).every((button) => button.hasAttribute('disabled')));

    // without any result there is nothing to delete
    cb.run.info = () => ({ ...info(), results: { selected: null, history: [] }, selected: null });
    const empty = page.document.createElement('div');
    inspector.renderHistory(empty, 'n1');
    assert.equal(buttonsOf(empty).filter((button) => button.dataset.action).length, 0);
  }
}

async function testController() {
  const page = loadPage('de', { scripts: ['node-ui', 'preview'] });
  const OCD = page.OCD;
  const ui = OCD.ui;
  const T = ui.T;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  try {
    const state = {
      workflow: { id: 'wf1' },
      rev: 1,
      graph: { nodes: [{ id: 'n1', type: 'x.image', title: 'Bildnode', params: {} }], edges: [], groups: [], notes: [] },
      reg: { types: new Map() },
      results: historyResults(),
      selection: { nodes: new Set() }
    };
    const apiCalls = [];
    let nextAnswer = null;
    let failure = null;
    OCD.api = {
      plan: async () => {
        apiCalls.push(['plan']);
        return { nodes: {}, totals: {} };
      },
      listRuns: async () => ({ runs: [] }),
      getWorkflow: async () => {
        apiCalls.push(['getWorkflow']);
        return { workflow: state.workflow, results: state.results };
      },
      deleteResultEntry: async (...args) => {
        apiCalls.push(['deleteResultEntry', ...args]);
        if (failure) throw failure;
        return nextAnswer;
      },
      deleteResults: async (...args) => {
        apiCalls.push(['deleteResults', ...args]);
        if (failure) throw failure;
        return nextAnswer;
      }
    };
    const dialogs = [];
    let confirmWith = false;
    const toasts = [];
    ui.confirmDialog = async (options) => {
      dialogs.push(options);
      return confirmWith;
    };
    ui.toast = (message, options = {}) => toasts.push({ message, kind: options.kind || null });
    OCD.bus = { on() {}, emit() {} };
    OCD.editor = { getState: () => state, getCanvas: () => null, getInspector: () => null, dom: () => ({}) };
    OCD.extensions = { nodeMenu: [], workflowMenu: [] };
    const controller = run.createController({ OCD });
    const inspectorApi = controller.inspectorApi;
    assert.equal(typeof inspectorApi.deleteResult, 'function');
    const history = () => state.results.nodes.n1.history.map((entry) => entry.id);

    // cancelling changes nothing: the question is asked, the server is not called, the results stay
    confirmWith = false;
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), false);
    assert.equal(dialogs.length, 1);
    assert.equal(apiCalls.filter((call) => call[0].startsWith('delete')).length, 0);
    assert.deepEqual(history(), ['h2', 'h1']);

    // the question says the three things and names the node; it is a danger dialog that starts on "keep"
    const asked = dialogs[0];
    assert.equal(asked.danger, true);
    assert.equal(asked.focus, 'cancel');
    assert.equal(asked.title, T('nodes.history.deleteEntry.title'));
    assert.equal(asked.confirmLabel, T('nodes.history.deleteEntry.confirm'));
    assert.equal(asked.cancelLabel, T('nodes.history.deleteKeep'));
    assert.match(asked.message, /Bildnode/);
    assert.match(asked.message, /nicht rückgängig/);
    assert.match(asked.message, /Datei wird gelöscht, wenn nichts anderes sie braucht/);
    assert.match(asked.message, /rechnet diesen Node neu und kostet/);

    // confirming: the server is called, the view takes the answer, the plan is asked again
    confirmWith = true;
    nextAnswer = { ok: true, nodeId: 'n1', removed: ['h1'], node: { selected: { entry: 'h2', variant: 0 }, history: [state.results.nodes.n1.history[0]] }, files: { deleted: 1, kept: 0 } };
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), true);
    assert.deepEqual(apiCalls.find((call) => call[0] === 'deleteResultEntry'), ['deleteResultEntry', 'wf1', 'n1', 'h1']);
    assert.deepEqual(history(), ['h2']);
    assert.equal(toasts.at(-1).message, T('nodes.history.deleted'));
    await sleep(20);
    assert.ok(apiCalls.some((call) => call[0] === 'plan'), 'the plan is refreshed: nodes below are out of date');

    // files that stay are said
    nextAnswer = { ok: true, nodeId: 'n1', removed: ['h2'], node: { selected: null, history: [] }, files: { deleted: 0, kept: 2 } };
    assert.equal(await inspectorApi.deleteResult('n1', 'h2'), true);
    assert.match(toasts.at(-1).message, /2 Datei\(en\) bleiben erhalten/);
    assert.deepEqual(history(), []);

    // all results: asked with the number, then replaced by the empty state
    state.results = historyResults();
    dialogs.length = 0;
    nextAnswer = { ok: true, nodeId: 'n1', removed: ['h2', 'h1'], node: { selected: null, history: [] }, files: { deleted: 2, kept: 0 } };
    confirmWith = false;
    assert.equal(await inspectorApi.deleteResult('n1'), false);
    assert.equal(dialogs[0].title, T('nodes.history.deleteAll.title'));
    assert.match(dialogs[0].message, /\(2\)/);
    assert.deepEqual(history(), ['h2', 'h1'], 'cancelled: unchanged');
    confirmWith = true;
    assert.equal(await inspectorApi.deleteResult('n1'), true);
    assert.deepEqual(apiCalls.filter((call) => call[0] === 'deleteResults').at(-1), ['deleteResults', 'wf1', 'n1']);
    assert.deepEqual(state.results.nodes.n1, { selected: null, history: [] });
    assert.equal(toasts.at(-1).message, T('nodes.history.deletedAll'));
    assert.equal(run.selectedVariant(state.results, 'n1'), null, 'card and preview have nothing to show');
    assert.equal(run.variantInfo(state.results, 'n1'), null);

    // nothing to delete: no question
    dialogs.length = 0;
    assert.equal(await inspectorApi.deleteResult('n1'), false);
    assert.equal(await inspectorApi.deleteResult('n1', 'h-nope'), false);
    assert.equal(dialogs.length, 0);

    // refused while a run is active: said, no question, no call
    state.results = historyResults();
    controller.getRunState().active = true;
    apiCalls.length = 0;
    toasts.length = 0;
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), false);
    assert.equal(dialogs.length, 0);
    assert.equal(apiCalls.length, 0);
    assert.equal(toasts[0].message, T('nodes.history.deleteBusy'));
    controller.getRunState().active = false;

    // the server says 409 (a run started in the meantime): the same words; nothing changed
    failure = Object.assign(new Error('A run is active'), { status: 409, code: 'RUN_ACTIVE' });
    toasts.length = 0;
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), false);
    assert.equal(toasts[0].message, T('nodes.history.deleteBusy'));
    assert.equal(toasts[0].kind, 'error');
    assert.deepEqual(history(), ['h2', 'h1']);

    // another error: shown with its text; 404 (deleted in another tab): said, and the results are read again
    failure = Object.assign(new Error('boom'), { status: 500 });
    toasts.length = 0;
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), false);
    assert.match(toasts[0].message, /Löschen fehlgeschlagen: boom/);
    failure = Object.assign(new Error('History entry not found'), { status: 404, code: 'ENTRY_NOT_FOUND' });
    toasts.length = 0;
    apiCalls.length = 0;
    assert.equal(await inspectorApi.deleteResult('n1', 'h1'), false);
    assert.equal(toasts[0].message, T('nodes.history.deleteGone'));
    assert.ok(apiCalls.some((call) => call[0] === 'getWorkflow'));

    // the menu of the node has "Delete all results" (danger): only while there are results, off while a run is active, one click asks
    state.results = historyResults();
    OCD.editor.dom = () => ({ runSlot: page.document.createElement('div') });
    // the top bar looks for its label by class name: the stand-in gets that one lookup for this test
    FakeNode.prototype.querySelector = function querySelector(selector) {
      return this.find((item) => item.classes.has(String(selector).replace(/^\./, '')))[0] || null;
    };
    controller.attach();
    const menuOf = () => OCD.extensions.nodeMenu[0]({ nodeId: 'n1' });
    const entry = (items) => items.find((item) => item.label === T('nodes.run.menu.deleteResults'));
    assert.ok(entry(menuOf()), 'the entry is there');
    assert.equal(entry(menuOf()).danger, true);
    assert.equal(entry(menuOf()).disabled, false);
    controller.getRunState().active = true;
    assert.equal(entry(menuOf()).disabled, true);
    controller.getRunState().active = false;
    dialogs.length = 0;
    confirmWith = false;
    failure = null;
    entry(menuOf()).onClick();
    await sleep(5);
    assert.equal(dialogs[0].title, T('nodes.history.deleteAll.title'));
    state.results = { version: 1, nodes: {} };
    assert.equal(entry(menuOf()), undefined, 'no results: no entry');
  } finally {
    delete FakeNode.prototype.querySelector;
    delete global.requestAnimationFrame;
  }
}

/* ---------- 6. wording and wiring ---------- */

function testWording() {
  const keys = nodeRows.filter((row) => row[0].startsWith('nodes.history.delete') || ['nodes.history.deleted', 'nodes.history.deletedAll', 'nodes.history.filesKept', 'nodes.run.menu.deleteResults'].includes(row[0]));
  const names = keys.map((row) => row[0]);
  for (const key of [
    'nodes.history.delete', 'nodes.history.deleteEntry', 'nodes.history.deleteAll', 'nodes.history.deleteEntry.title', 'nodes.history.deleteEntry.message',
    'nodes.history.deleteEntry.confirm', 'nodes.history.deleteAll.title', 'nodes.history.deleteAll.message', 'nodes.history.deleteAll.confirm',
    'nodes.history.deleteKeep', 'nodes.history.deleted', 'nodes.history.deletedAll', 'nodes.history.filesKept', 'nodes.history.deleteFailed',
    'nodes.history.deleteBusy', 'nodes.history.deleteGone', 'nodes.run.menu.deleteResults'
  ]) {
    assert.ok(names.includes(key), `${key} is translated`);
  }
  for (const row of keys) {
    assert.equal(row.length, 4, `${row[0]}: de, en and es`);
    for (const text of row.slice(1)) assert.ok(text.trim().length > 0, `${row[0]} has text in every language`);
    assert.equal(row[1].includes('ß'), false, `${row[0]}: no ß in the German text`);
    const placeholders = (text) => (text.match(/\{[a-z]+\}/gi) || []).sort().join(',');
    assert.equal(placeholders(row[2]), placeholders(row[1]), `${row[0]}: same placeholders in English`);
    assert.equal(placeholders(row[3]), placeholders(row[1]), `${row[0]}: same placeholders in Spanish`);
  }
  // the question says what happens, in every language: not undone, the file goes unless needed, the next run calculates again
  const message = (key, index) => keys.find((row) => row[0] === key)[index];
  for (const key of ['nodes.history.deleteEntry.message', 'nodes.history.deleteAll.message']) {
    assert.match(message(key, 1), /nicht rückgängig/);
    assert.match(message(key, 1), /gelöscht, wenn nichts anderes/);
    assert.match(message(key, 1), /rechnet diesen Node neu/);
    assert.match(message(key, 2), /cannot be undone/);
    assert.match(message(key, 2), /unless something else needs/);
    assert.match(message(key, 2), /calculates this node again/);
    assert.match(message(key, 3), /no se puede deshacer/);
    assert.match(message(key, 3), /nada más/);
    assert.match(message(key, 3), /vuelve a calcular/);
  }

  // the routes are in the documentation and the node menu is wired
  const spec = read('docs/node-view/SPEC.md');
  assert.match(spec, /DELETE\s*\|\s*`\/api\/workflows\/:id\/results\/:nodeId\/entries\/:entryId`/);
  assert.match(spec, /DELETE\s*\|\s*`\/api\/workflows\/:id\/results\/:nodeId`/);
  assert.match(read('public/nodes/run.js'), /nodes\.run\.menu\.deleteResults/);
  assert.match(read('public/nodes/inspector.js'), /delete-entry/);
  assert.match(read('public/nodes/nodes.css'), /\.nv-history-delete-all/);
  const html = read('public/help.html');
  assert.match(html, /Ergebnisse (eines Nodes )?löschen|Ergebnis löschen/);
}

async function main() {
  await testStore();
  await testRoutes();
  await testPermissions();
  await testCache();
  testInspectorButtons();
  await testController();
  testWording();
  console.log('test-nodes-results-delete.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
