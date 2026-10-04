'use strict';

// Route-level tests of the user management (AUTH_WHOAMI_URL set): every protected route with several simulated
// identities, the rules for existing data, sharing, assets, downloads, event streams, folders, admin-only routes,
// the team list, costs and the monitoring API; plus the local mode (no AUTH_WHOAMI_URL) that must stay as it was.
// A private copy of the app runs in a temp directory (own data, projects and assets folders, ephemeral port,
// whoami stub that reads the identity from a test cookie), so the real data folders and port 3111 are never
// touched. No provider is called and nothing is paid.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const ADMIN = 'admin@example.com';
const BOSS = 'boss@example.org'; // a superadmin on another domain: the role is not tied to a company domain
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

async function waitFor(fn, { timeout = 8000, step = 50, message = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timeout waiting for ${message}`);
    await sleep(step);
  }
}

const share = (api, kind, id, email, json) => api(`/api/${kind}/${id}/share`, { method: 'PATCH', as: email, json });

async function main() {
  await testActiveMode();
  await testLocalMode();
  console.log('User management: Identitaet, Sessions, Assets, Workflows (Lauf, SSE, ZIP), Ordner, Admin-Routen, Team-Liste, Kosten, Monitoring, anonyme Zugriffe und der unveraenderte lokale Modus sind korrekt.');
  console.log('test-user-management.js: ok');
}

/* ---------- active mode ---------- */

async function testActiveMode() {
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: BOSS,
      AUTH_LOGOUT_URL: 'https://login.example.com/logout',
      OPENROUTER_API_KEY: '' // a chat message never leaves the process
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const ctx = {
    iso,
    api: iso.request,
    store: iso.load('lib/store'),
    wfStore: iso.load('lib/nodes/workflows-store').defaultStore,
    costsLib: iso.load('lib/costs')
  };
  try {
    await testIdentity(ctx);
    await testSessions(ctx);
    await testSessionAssets(ctx);
    await testWorkflows(ctx);
    await testFolders(ctx);
    await testFolderAdminData(ctx);
    await testFolderNameOracle(ctx);
    await testMemoryIsolation(ctx);
    await testChatToolsAdminOnly(ctx);
    await testAdminOnly(ctx);
    await testTeam(ctx);
    await testCosts(ctx);
    await testMonitoring(ctx);
    await testAnonymous(ctx);
    testRouteInventory(ctx);
  } finally {
    await iso.cleanup();
  }
}

async function testIdentity({ api }) {
  let me = (await api('/api/me', { as: ALICE })).body;
  assert.deepEqual(me, { active: true, identified: true, email: ALICE, role: 'user', isAdmin: false, isSuperAdmin: false, logoutUrl: 'https://login.example.com/logout' });
  me = (await api('/api/me', { as: ADMIN.toUpperCase() })).body;
  assert.equal(me.role, 'admin');
  assert.equal(me.email, ADMIN, 'addresses are normalised to lower case');
  me = (await api('/api/me', { as: BOSS })).body;
  assert.equal(me.role, 'superadmin');
  assert.equal(me.isAdmin, true);
  assert.equal(me.isSuperAdmin, true);
  me = (await api('/api/me')).body;
  assert.deepEqual(me, { active: true, identified: false, email: null, role: 'anonymous', isAdmin: false, isSuperAdmin: false, logoutUrl: 'https://login.example.com/logout' });
}

/* ---------- chats ---------- */

async function testSessions(ctx) {
  const { api, store } = ctx;
  // A new chat is private
  const created = await api('/api/sessions', { method: 'POST', as: ALICE, json: {} });
  assert.equal(created.status, 201);
  const chat = created.body.session;
  assert.equal(chat.owner, ALICE);
  assert.equal(chat.shareMode, 'private');
  assert.equal(chat.mine, true);
  assert.equal(chat.canManage, true);
  assert.equal(chat.canShare, true);
  assert.equal((await store.readSession(chat.id)).owner, ALICE);

  // Existing data (no owner) is open to everybody
  const legacy = await store.createSession();
  assert.equal((await store.readSession(legacy.id)).owner ?? null, null);
  Object.assign(ctx, { chat, legacy });

  // Lists: Bob sees the legacy chat but not Alice's, Alice sees both, an admin sees everything
  const idsFor = async (email) => (await api('/api/sessions?limit=100', { as: email })).body.sessions.map((entry) => entry.id).sort();
  assert.deepEqual(await idsFor(BOB), [legacy.id]);
  assert.deepEqual(await idsFor(ALICE), [chat.id, legacy.id].sort());
  assert.deepEqual(await idsFor(ADMIN), [chat.id, legacy.id].sort());
  const legacyRow = (await api('/api/sessions?limit=100', { as: BOB })).body.sessions[0];
  assert.equal(legacyRow.unowned, true);
  assert.equal(legacyRow.owner, null);
  assert.equal(legacyRow.canManage, true);
  assert.equal(legacyRow.canShare, false);
  // search only reaches what the caller may see
  await store.mutateSession(chat.id, (session) => {
    session.messages.push({ role: 'user', content: 'zebrastreifenkampagne geheim' });
  });
  assert.equal((await api('/api/sessions?q=zebrastreifenkampagne', { as: BOB })).body.total, 0);
  assert.equal((await api('/api/sessions?q=zebrastreifenkampagne', { as: ALICE })).body.total, 1);

  // Every route on a foreign private chat answers 404 (never 403: the id must not confirm anything)
  const foreign = [
    ['GET', `/api/sessions/${chat.id}`],
    ['PATCH', `/api/sessions/${chat.id}`, { title: 'x' }],
    ['PATCH', `/api/sessions/${chat.id}`, { role: null }],
    ['PATCH', `/api/sessions/${chat.id}/share`, { shareMode: 'team' }],
    ['DELETE', `/api/sessions/${chat.id}`],
    ['GET', `/api/sessions/${chat.id}/jobs`],
    ['GET', `/api/sessions/${chat.id}/context`],
    ['POST', `/api/sessions/${chat.id}/context`, { brainId: 'x' }],
    ['DELETE', `/api/sessions/${chat.id}/context/x`],
    ['POST', `/api/sessions/${chat.id}/context-files`, { name: 'a.md', text: 'x' }],
    ['DELETE', `/api/sessions/${chat.id}/context-files/x`],
    ['POST', `/api/sessions/${chat.id}/message`, { text: 'hi' }],
    ['POST', `/api/sessions/${chat.id}/video-model-requests/vmr-x`, { model: 'bytedance/seedance-2.5' }],
    ['POST', `/api/sessions/${chat.id}/video-model-requests/vmr-x/cancel`, {}],
    ['GET', `/api/sessions/${chat.id}/workflow-runs/wfr-x`],
    ['POST', `/api/sessions/${chat.id}/workflow-runs/wfr-x`, {}],
    ['POST', `/api/sessions/${chat.id}/workflow-runs/wfr-x/cancel`, {}],
    ['DELETE', `/api/sessions/${chat.id}/video-model-preference`]
  ];
  for (const [method, url, json] of foreign) {
    const response = await api(url, { method, as: BOB, json });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.ok(!response.text.includes('zebrastreifen'));
  }
  ctx.exercised = foreign.map(([method, url]) => `${method} ${url.replace(chat.id, ':id')}`);
  assert.equal((await store.readSession(chat.id)).title, 'Neuer Chat', 'nothing was changed');
  assert.equal((await api('/api/sessions/nope-nope', { as: BOB })).status, 404, 'an unknown id answers the same way');

  // Sharing: validation; the team list is where people come from
  assert.equal((await share(api, 'sessions', chat.id, ALICE, { shareMode: 'bogus' })).status, 400);
  await api('/api/me', { as: BOB });
  await api('/api/me', { as: CAROL }); // seen once: now on the team list
  const unknown = await share(api, 'sessions', chat.id, ALICE, { shareMode: 'specific', sharedWith: ['stranger@example.com'] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_TEAM_MEMBERS');
  assert.equal((await share(api, 'sessions', chat.id, ALICE, { shareMode: 'specific', sharedWith: [] })).status, 400);
  const specific = await share(api, 'sessions', chat.id, ALICE, { shareMode: 'specific', sharedWith: [BOB.toUpperCase()] });
  assert.equal(specific.status, 200);
  assert.deepEqual(specific.body.session.sharedWith, [BOB]);
  assert.equal(specific.body.session.shareMode, 'specific');
  assert.deepEqual(await idsFor(BOB), [chat.id, legacy.id].sort());
  assert.deepEqual(await idsFor(CAROL), [legacy.id], 'sharing with Bob does not include Carol');

  // What Bob may do with a chat that is shared with him: open and use it, but not rename, move, delete or share it
  const detail = (await api(`/api/sessions/${chat.id}`, { as: BOB })).body.session;
  assert.equal(detail.owner, ALICE);
  assert.equal(detail.mine, false);
  assert.equal(detail.canManage, false);
  assert.equal(detail.canShare, false);
  assert.equal('sharedWith' in detail, false, 'the list of people is only shown to those who can change it');
  assert.equal(detail.sharedCount, 1);
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: ALICE })).body.session.sharedWith[0], BOB);
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'PATCH', as: BOB, json: { title: 'Bobs Titel' } })).status, 403);
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'PATCH', as: BOB, json: { folder: 'Nebenan' } })).status, 403);
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'PATCH', as: BOB, json: { role: null } })).status, 200, 'chat settings are for everybody who may use the chat');
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'DELETE', as: BOB })).status, 403);
  assert.equal((await share(api, 'sessions', chat.id, BOB, { shareMode: 'team' })).status, 403);
  assert.equal((await api(`/api/sessions/${chat.id}/context-files`, { method: 'POST', as: BOB, json: { name: 'note.md', text: 'hello' } })).status, 201);
  // chatting works up to the missing key (an error event in a 200 stream); nothing is sent anywhere
  const message = await api(`/api/sessions/${chat.id}/message`, { method: 'POST', as: BOB, json: { text: 'hi' } });
  assert.equal(message.status, 200);
  assert.match(message.text, /OPENROUTER_API_KEY/);
  assert.equal((await api(`/api/sessions/${chat.id}/message`, { method: 'POST', as: CAROL, json: { text: 'hi' } })).status, 404, 'Carol is not on the list');

  // Team: every identified person; anonymous callers are not part of the team
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'team' });
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: CAROL })).status, 200);
  assert.equal((await api(`/api/sessions/${chat.id}`)).status, 404, 'no identity, no team chat');
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'private' });
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: CAROL })).status, 404);
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: BOB })).status, 404);

  // Admins see and manage everything; an admin who shares somebody else's chat does not become its owner
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: ADMIN })).status, 200);
  assert.equal((await share(api, 'sessions', chat.id, ADMIN, { shareMode: 'team' })).status, 200);
  assert.equal((await store.readSession(chat.id)).owner, ALICE);
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'private' });

  // Existing data: usable and manageable by everybody like before; the sharing is changed by admins only
  assert.equal((await api(`/api/sessions/${legacy.id}`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/sessions/${legacy.id}`, { method: 'PATCH', as: BOB, json: { title: 'Umbenannt' } })).status, 200);
  const legacyShare = await share(api, 'sessions', legacy.id, BOB, { shareMode: 'team' });
  assert.equal(legacyShare.status, 403);
  assert.equal(legacyShare.body.code, 'FORBIDDEN');
  assert.equal((await share(api, 'sessions', legacy.id, null, { shareMode: 'team' })).status, 403);
  const claimed = await share(api, 'sessions', legacy.id, ADMIN, { shareMode: 'private' });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.session.owner, ADMIN, 'the acting admin becomes the owner');
  assert.equal((await store.readSession(legacy.id)).owner, ADMIN);
  assert.equal((await api(`/api/sessions/${legacy.id}`, { as: BOB })).status, 404, 'now private');
  await share(api, 'sessions', legacy.id, ADMIN, { shareMode: 'team' });
  assert.equal((await api(`/api/sessions/${legacy.id}`, { as: BOB })).status, 200);

  // Deleting: Bob cannot delete Alice's chat, everybody can delete a chat without owner
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'team' });
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'DELETE', as: BOB })).status, 403);
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'private' });
  const open = await store.createSession();
  assert.equal((await api(`/api/sessions/${open.id}`, { method: 'DELETE', as: CAROL })).status, 200);

  // A workflow's backing session is changed through the workflow only
  const backing = await store.createSession({ kind: 'workflow', owner: ALICE });
  assert.equal((await share(api, 'sessions', backing.id, ALICE, { shareMode: 'team' })).status, 400);
  await store.deleteSession(backing.id);
}

/* ---------- assets ---------- */

async function testSessionAssets(ctx) {
  const { api, iso, store, chat } = ctx;
  const legacy = await store.createSession(); // a chat without owner (the earlier one was claimed by an admin)
  ctx.openChat = legacy;
  const mine = await store.saveAsset(chat.id, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'privat', cost: null });
  const open = await store.saveAsset(legacy.id, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'offen', cost: null });
  Object.assign(ctx, { mineAsset: mine, openAsset: open });

  const served = await api(mine.url, { as: ALICE, raw: true });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.match(served.headers.get('cache-control'), /^private/);
  assert.equal((await api(mine.url, { as: BOB, raw: true })).status, 404, 'private asset of somebody else');
  assert.equal((await api(mine.url, { raw: true })).status, 404, 'anonymous');
  assert.equal((await api(mine.url, { as: ADMIN, raw: true })).status, 200);
  assert.equal((await api(open.url, { as: BOB, raw: true })).status, 200, 'existing data stays open');
  assert.equal((await api(open.url, { raw: true })).status, 200);
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'team' });
  assert.equal((await api(mine.url, { as: BOB, raw: true })).status, 200, 'after sharing');
  await share(api, 'sessions', chat.id, ALICE, { shareMode: 'private' });
  assert.equal((await api(mine.url, { as: BOB, raw: true })).status, 404, 'and after taking it back');
  assert.equal((await api('/assets/no-such-session/x.png', { as: ALICE, raw: true })).status, 404);
  // path tricks never reach another session's files
  const sessionFileName = `${chat.id}.json`;
  for (const rawPath of [
    `/assets/..%2Fprojects%2F${sessionFileName}`,
    `/assets/%2e%2e/projects/${sessionFileName}`,
    `/assets/${legacy.id}/..%2F${chat.id}%2F${path.basename(mine.url)}`,
    `/assets//${chat.id}/${path.basename(mine.url)}`,
    `/assets/%00`
  ]) {
    const status = await iso.rawStatus(rawPath, { as: BOB });
    assert.ok([400, 403, 404].includes(status), `${rawPath} -> ${status}`);
    assert.notEqual(status, 200, rawPath);
  }
}

/* ---------- workflows ---------- */

const FOREIGN_WORKFLOW_ROUTES = (id) => [
  ['GET', `/api/workflows/${id}`],
  ['PUT', `/api/workflows/${id}`, { baseRev: 1, graph: { nodes: [], edges: [] } }],
  ['PATCH', `/api/workflows/${id}`, { name: 'x' }],
  ['PATCH', `/api/workflows/${id}/share`, { shareMode: 'team' }],
  ['DELETE', `/api/workflows/${id}`],
  ['POST', `/api/workflows/${id}/duplicate`, {}],
  ['GET', `/api/workflows/${id}/export`],
  ['GET', `/api/workflows/${id}/export-info`],
  ['GET', `/api/workflows/${id}/export.zip`],
  ['GET', `/api/workflows/${id}/assets`],
  ['POST', `/api/workflows/${id}/import-asset`, { sessionId: 'a', assetId: 'b' }],
  ['GET', `/api/workflows/${id}/send-to-chat/plan?nodeId=n`],
  ['POST', `/api/workflows/${id}/send-to-chat`, { sessionId: 'a', nodeId: 'n' }],
  ['POST', `/api/workflows/${id}/runs/plan`, { mode: 'all' }],
  ['POST', `/api/workflows/${id}/runs`, { mode: 'all' }],
  ['POST', `/api/workflows/${id}/assistant`, { question: 'Hallo', canvas: { nodes: [], edges: [] } }],
  ['GET', `/api/workflows/${id}/runs`],
  ['GET', `/api/workflows/${id}/runs/run-1`],
  ['POST', `/api/workflows/${id}/runs/run-1/cancel`, {}],
  ['GET', `/api/workflows/${id}/outputs.zip`],
  ['PATCH', `/api/workflows/${id}/results/n1`, { entry: 'e' }],
  ['DELETE', `/api/workflows/${id}/results/n1`],
  ['DELETE', `/api/workflows/${id}/results/n1/entries/e`],
  ['GET', `/api/workflows/${id}/events`]
];

async function testWorkflows(ctx) {
  const { api, store, wfStore, chat, openChat: legacy, mineAsset, openAsset } = ctx;

  // Alice creates a workflow: private, owned by her
  const created = await api('/api/workflows', { method: 'POST', as: ALICE, json: { name: 'Alice Flow' } });
  assert.equal(created.status, 201);
  const flow = created.body.workflow;
  assert.equal(flow.owner, ALICE);
  assert.equal(flow.shareMode, 'private');
  assert.equal(flow.canManage, true);
  assert.equal(flow.canShare, true);
  assert.equal((await store.readSession(flow.sessionId)).owner, ALICE, 'the backing session belongs to her as well');
  const legacyFlow = (await wfStore.createWorkflow({ name: 'Altbestand' })).workflow;
  assert.equal(legacyFlow.owner === undefined || legacyFlow.owner === null, true);

  // Lists
  const flowIds = async (email) => (await api('/api/workflows', { as: email })).body.workflows.map((item) => item.id).sort();
  assert.deepEqual(await flowIds(BOB), [legacyFlow.id]);
  assert.deepEqual(await flowIds(ALICE), [flow.id, legacyFlow.id].sort());
  assert.deepEqual(await flowIds(ADMIN), [flow.id, legacyFlow.id].sort());
  assert.deepEqual(await flowIds(null), [legacyFlow.id], 'anonymous: only what has no owner');
  const legacyItem = (await api('/api/workflows', { as: BOB })).body.workflows[0];
  assert.equal(legacyItem.unowned, true);
  assert.equal(legacyItem.canShare, false);
  assert.equal(legacyItem.canManage, true);
  assert.equal((await api('/api/workflows?q=Alice', { as: BOB })).body.workflows.length, 0);

  // Every route on a foreign private workflow: 404, nothing changes, no stream
  for (const [method, url, json] of FOREIGN_WORKFLOW_ROUTES(flow.id)) {
    const response = await api(url, { method, as: BOB, json });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal(response.body?.code, 'WORKFLOW_NOT_FOUND', `${method} ${url}`);
  }
  const upload = await api(`/api/workflows/${flow.id}/uploads`, { method: 'POST', as: BOB, headers: { 'Content-Type': 'image/png', 'x-filename': 'x.png' }, body: PNG });
  assert.equal(upload.status, 404);
  ctx.exercised.push(...FOREIGN_WORKFLOW_ROUTES(flow.id).map(([method, url]) => `${method} ${url.replace(flow.id, ':id').split('?')[0]}`), 'POST /api/workflows/:id/uploads');
  assert.equal((await wfStore.readWorkflow(flow.id)).name, 'Alice Flow');
  assert.equal((await api(`/api/workflows/${flow.id}/events`, { as: null })).status, 404, 'anonymous cannot listen either');

  // An upload lands in the backing session; its file is protected like the workflow itself
  const uploaded = await api(`/api/workflows/${flow.id}/uploads?accept=image`, { method: 'POST', as: ALICE, headers: { 'Content-Type': 'image/png', 'x-filename': 'a.png' }, body: PNG });
  assert.equal(uploaded.status, 200);
  const assetUrl = uploaded.body.value.url;
  assert.equal((await api(assetUrl, { as: ALICE, raw: true })).status, 200);
  assert.equal((await api(assetUrl, { as: BOB, raw: true })).status, 404);

  // The graph: a text input into an output node
  const graph = {
    nodes: [node('txt', 'input.text', { text: 'hello team' }, 0, 0), node('out', 'output.result', { label: 'Result' }, 300, 0)],
    edges: [{ id: 'e1', from: { node: 'txt', port: 'text' }, to: { node: 'out', port: 'inputs' } }],
    groups: [],
    notes: []
  };
  const saved = await api(`/api/workflows/${flow.id}`, { method: 'PUT', as: ALICE, json: { baseRev: 1, graph } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rev, 2);

  // Sharing rules of the endpoint
  assert.equal((await share(api, 'workflows', flow.id, ALICE, { shareMode: 'nope' })).status, 400);
  const unknown = await share(api, 'workflows', flow.id, ALICE, { shareMode: 'specific', sharedWith: ['stranger@example.com'] });
  assert.equal(unknown.body.code, 'UNKNOWN_TEAM_MEMBERS');

  // Open event streams: Alice and Bob (after sharing) listen
  assert.equal((await share(api, 'workflows', flow.id, ALICE, { shareMode: 'team' })).status, 200);
  const aliceStream = await api(`/api/workflows/${flow.id}/events`, { as: ALICE, raw: true });
  const bobStream = await api(`/api/workflows/${flow.id}/events`, { as: BOB, raw: true });
  assert.equal(aliceStream.status, 200);
  assert.equal(bobStream.status, 200);
  assert.match(bobStream.headers.get('content-type'), /text\/event-stream/);
  const aliceReader = aliceStream.body.getReader();
  const bobReader = bobStream.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await bobReader.read()).value), /snapshot/);
  await aliceReader.read();

  // Team: Bob can use it, including its files, but not manage it
  assert.equal((await api(assetUrl, { as: BOB, raw: true })).status, 200, 'the backing session follows the workflow');
  const bobView = (await api(`/api/workflows/${flow.id}`, { as: BOB })).body;
  assert.equal(bobView.workflow.owner, ALICE);
  assert.equal(bobView.workflow.mine, false);
  assert.equal(bobView.workflow.canManage, false);
  assert.equal(bobView.workflow.canShare, false);
  assert.equal('sharedWith' in bobView.workflow, false);
  assert.equal((await api(`/api/workflows/${flow.id}`, { method: 'PATCH', as: BOB, json: { name: 'Bobs' } })).status, 403);
  assert.equal((await api(`/api/workflows/${flow.id}`, { method: 'PATCH', as: BOB, json: { folder: 'x' } })).status, 403);
  assert.equal((await api(`/api/workflows/${flow.id}`, { method: 'DELETE', as: BOB })).status, 403);
  assert.equal((await share(api, 'workflows', flow.id, BOB, { shareMode: 'private' })).status, 403);
  const bobSave = await api(`/api/workflows/${flow.id}`, { method: 'PUT', as: BOB, json: { baseRev: 2, graph: { ...graph, nodes: [node('txt', 'input.text', { text: 'hello from bob' }), graph.nodes[1]] } } });
  assert.equal(bobSave.status, 200, 'editing is allowed for everybody who may use it');
  const plan = await api(`/api/workflows/${flow.id}/runs/plan`, { method: 'POST', as: BOB, json: { mode: 'all' } });
  assert.equal(plan.status, 200);
  const started = await api(`/api/workflows/${flow.id}/runs`, { method: 'POST', as: BOB, json: { mode: 'all', rev: bobSave.body.rev } });
  assert.equal(started.status, 202);
  const runId = started.body.runId;
  const finished = await waitFor(async () => {
    const run = (await api(`/api/workflows/${flow.id}/runs/${runId}`, { as: BOB })).body;
    return run.status !== 'running' ? run : null;
  }, { message: 'the run of Bob' });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.user, BOB, 'the run belongs to the person who started it');
  const runs = (await api(`/api/workflows/${flow.id}/runs`, { as: ALICE })).body.runs;
  assert.equal(runs[0].user, BOB);
  const zip = await api(`/api/workflows/${flow.id}/outputs.zip`, { as: BOB, raw: true });
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-type'), /zip/);
  assert.equal((await api(`/api/workflows/${flow.id}/export`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/workflows/${flow.id}/assets`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/workflows/${flow.id}/outputs.zip`, { as: CAROL, raw: true })).status, 200, 'team = every identified person');
  assert.equal((await api(`/api/workflows/${flow.id}/outputs.zip`, { raw: true })).status, 404, 'but not the anonymous caller');

  // Duplicating gives Bob a private copy of his own
  const duplicate = await api(`/api/workflows/${flow.id}/duplicate`, { method: 'POST', as: BOB, json: {} });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.workflow.owner, BOB);
  assert.equal(duplicate.body.workflow.shareMode, 'private');
  assert.equal((await api(`/api/workflows/${duplicate.body.workflow.id}`, { as: ALICE })).status, 404);
  assert.equal((await store.readSession(duplicate.body.workflow.sessionId)).owner, BOB);

  // References across chats are checked as well: Bob may not pull assets out of Alice's private chat or push into it
  const own = duplicate.body.workflow.id;
  const pull = await api(`/api/workflows/${own}/import-asset`, { method: 'POST', as: BOB, json: { sessionId: chat.id, assetId: mineAsset.id } });
  assert.equal(pull.status, 404, 'import from a private chat of somebody else');
  const pullOpen = await api(`/api/workflows/${own}/import-asset`, { method: 'POST', as: BOB, json: { sessionId: legacy.id, assetId: openAsset.id } });
  assert.equal(pullOpen.status, 200, 'import from a chat without owner');
  const push = await api(`/api/workflows/${flow.id}/send-to-chat`, { method: 'POST', as: BOB, json: { sessionId: chat.id, nodeId: 'out' } });
  assert.equal(push.status, 404, 'send to a private chat of somebody else');
  const pushOpen = await api(`/api/workflows/${flow.id}/send-to-chat`, { method: 'POST', as: BOB, json: { sessionId: legacy.id, nodeId: 'out' } });
  assert.equal(pushOpen.status, 200);
  assert.match(JSON.stringify((await store.readSession(legacy.id)).messages), /hello from bob/);
  const originOf = async (as) => {
    const detail = await api(`/api/sessions/${legacy.id}`, { as });
    assert.equal(detail.status, 200);
    return detail.body.session.messages.find((message) => message.origin).origin;
  };
  assert.equal((await originOf(BOB)).canOpen, true, 'the workflow is shared: the card links to it');
  assert.equal((await originOf(BOB)).workflowId, flow.id);
  assert.equal((await store.readSession(legacy.id)).messages.some((message) => message.origin && 'canOpen' in message.origin), false, 'canOpen is computed, never stored');

  // Taking the sharing back ends the stream of Bob; Alice is told
  assert.equal((await share(api, 'workflows', flow.id, ALICE, { shareMode: 'private' })).status, 200);
  assert.equal((await originOf(BOB)).canOpen, false, 'no link to a workflow the person may no longer open');
  assert.equal((await originOf(BOB)).workflowName, 'Alice Flow', 'the name stays');
  const hidden = await originOf(BOB);
  assert.equal('workflowId' in hidden, false, 'the workflow id is not delivered to a person without access');
  assert.equal('nodeId' in hidden, false, 'nor the node id');
  assert.equal(hidden.nodeLabel.length > 0, true, 'the names stay for the card');
  assert.equal((await originOf(ALICE)).canOpen, true);
  const bobEnded = await Promise.race([
    (async () => {
      for (;;) {
        const { done } = await bobReader.read();
        if (done) return 'ended';
      }
    })(),
    sleep(4000).then(() => 'still open')
  ]);
  assert.equal(bobEnded, 'ended', 'the stream of somebody who lost access ends');
  let aliceText = '';
  await Promise.race([
    (async () => {
      while (!aliceText.includes('access_changed')) {
        const { value, done } = await aliceReader.read();
        if (done) return;
        aliceText += decoder.decode(value);
      }
    })(),
    sleep(4000)
  ]);
  assert.match(aliceText, /access_changed/, 'the owner is told that the sharing changed');
  await aliceReader.cancel();
  assert.equal((await api(`/api/workflows/${flow.id}`, { as: BOB })).status, 404);
  assert.equal((await api(assetUrl, { as: BOB, raw: true })).status, 404, 'the files close again');

  // A specific person
  assert.equal((await share(api, 'workflows', flow.id, ALICE, { shareMode: 'specific', sharedWith: [CAROL] })).status, 200);
  assert.equal((await api(`/api/workflows/${flow.id}`, { as: CAROL })).status, 200);
  assert.equal((await api(`/api/workflows/${flow.id}`, { as: BOB })).status, 404);
  assert.equal((await api(assetUrl, { as: CAROL, raw: true })).status, 200);

  // Admins: everything; sharing an owned workflow keeps the owner
  assert.equal((await api(`/api/workflows/${flow.id}`, { as: ADMIN })).status, 200);
  assert.equal((await share(api, 'workflows', flow.id, ADMIN, { shareMode: 'team' })).status, 200);
  assert.equal((await wfStore.readWorkflow(flow.id)).owner, ALICE);
  await share(api, 'workflows', flow.id, ALICE, { shareMode: 'private' });

  // Existing workflow without owner: open, manageable by all, sharing by admins only (who become the owner)
  assert.equal((await api(`/api/workflows/${legacyFlow.id}`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/workflows/${legacyFlow.id}`, { as: null })).status, 200);
  assert.equal((await api(`/api/workflows/${legacyFlow.id}`, { method: 'PATCH', as: BOB, json: { name: 'Altbestand neu' } })).status, 200);
  assert.equal((await share(api, 'workflows', legacyFlow.id, BOB, { shareMode: 'team' })).status, 403);
  const claim = await share(api, 'workflows', legacyFlow.id, ADMIN, { shareMode: 'private' });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.workflow.owner, ADMIN);
  assert.equal((await wfStore.readWorkflow(legacyFlow.id)).owner, ADMIN);
  assert.equal((await store.readSession(legacyFlow.sessionId)).owner, ADMIN, 'workflow and backing session stay in step');
  assert.equal((await api(`/api/workflows/${legacyFlow.id}`, { as: BOB })).status, 404);
  await share(api, 'workflows', legacyFlow.id, ADMIN, { shareMode: 'team' });
  assert.equal((await api(`/api/workflows/${legacyFlow.id}`, { as: BOB })).status, 200);

  // Import creates an owned, private workflow; the owner deletes it, including the backing session
  const exported = (await api(`/api/workflows/${legacyFlow.id}/export`, { as: BOB })).body;
  const imported = await api('/api/workflows/import', { method: 'POST', as: CAROL, json: { document: exported } });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.workflow.owner, CAROL);
  assert.equal((await api(`/api/workflows/${imported.body.workflow.id}`, { as: BOB })).status, 404);
  assert.equal((await api(`/api/workflows/${imported.body.workflow.id}`, { method: 'DELETE', as: CAROL })).status, 200);
  await assert.rejects(store.readSession(imported.body.workflow.sessionId), { code: 'ENOENT' });

  Object.assign(ctx, { flow, legacyFlow, ownFlow: duplicate.body.workflow });
}

/* ---------- folders ---------- */

async function testFolders(ctx) {
  const { api, store, wfStore } = ctx;
  const folder = 'Kampagne';
  const folderNames = async (email) => (await api('/api/folders', { as: email })).body.folders.map((entry) => entry.name);

  // Alice starts a project with a private chat and a private workflow in it
  const inFolder = await api('/api/sessions', { method: 'POST', as: ALICE, json: { folder } });
  assert.equal(inFolder.status, 201);
  const secondChat = (await api('/api/sessions', { method: 'POST', as: ALICE, json: { folder } })).body.session;
  const inFolderFlow = await api('/api/workflows', { method: 'POST', as: ALICE, json: { name: 'Im Projekt', folder } });
  assert.equal(inFolderFlow.status, 201);
  assert.ok((await folderNames(ALICE)).includes(folder));
  assert.ok((await folderNames(ADMIN)).includes(folder));
  assert.ok(!(await folderNames(BOB)).includes(folder), 'a folder with only foreign private entries does not exist for Bob');
  assert.ok(!(await folderNames(null)).includes(folder));

  const enc = encodeURIComponent(folder);
  for (const [method, url, json] of [
    ['GET', `/api/folders/${enc}/profile`],
    ['GET', `/api/folders/${enc}/cast`],
    ['PATCH', `/api/folders/${enc}`, { name: 'Anders' }],
    ['DELETE', `/api/folders/${enc}`]
  ]) {
    assert.equal((await api(url, { method, as: BOB, json })).status, 404, `${method} ${url}`);
  }
  assert.equal((await api('/api/sessions', { method: 'POST', as: BOB, json: { folder } })).status, 404, 'no chat into a hidden project');
  assert.equal((await api('/api/workflows', { method: 'POST', as: BOB, json: { name: 'x', folder } })).status, 404, 'no workflow either');
  const bobChat = (await api('/api/sessions', { method: 'POST', as: BOB, json: {} })).body.session;
  assert.equal((await api(`/api/sessions/${bobChat.id}`, { method: 'PATCH', as: BOB, json: { folder } })).status, 404);
  const bobFlow = (await api('/api/workflows', { method: 'POST', as: BOB, json: { name: 'Bobs' } })).body.workflow;
  assert.equal((await api(`/api/workflows/${bobFlow.id}`, { method: 'PATCH', as: BOB, json: { folder } })).status, 404);

  // An empty project is nobody's secret
  assert.equal((await api('/api/folders', { method: 'POST', as: BOB, json: { name: 'Leer' } })).status, 201);
  assert.ok((await folderNames(ALICE)).includes('Leer'));
  assert.equal((await api('/api/folders/Leer', { method: 'DELETE', as: ALICE })).status, 200);

  // Sharing one chat makes the project visible; it shows and counts only what Bob may see
  await share(api, 'sessions', secondChat.id, ALICE, { shareMode: 'team' });
  const bobFolders = (await api('/api/folders', { as: BOB })).body.folders.find((entry) => entry.name === folder);
  assert.equal(bobFolders.sessionCount, 1);
  const aliceFolders = (await api('/api/folders', { as: ALICE })).body.folders.find((entry) => entry.name === folder);
  assert.equal(aliceFolders.sessionCount, 2);
  const folderChats = (await api('/api/sessions?limit=100', { as: BOB })).body.sessions.filter((entry) => entry.folder === folder);
  assert.deepEqual(folderChats.map((entry) => entry.id), [secondChat.id]);
  assert.equal((await api(`/api/folders/${enc}/profile`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/folders/${enc}/cast`, { as: BOB })).status, 200);
  assert.equal((await api(`/api/sessions/${bobChat.id}`, { method: 'PATCH', as: BOB, json: { folder } })).status, 200, 'Bob may now file his chat there');
  // The project is shared by name: renaming or deleting it moves other people's entries, so it needs admin rights
  // or that every entry in it is the caller's
  assert.equal((await api(`/api/folders/${enc}`, { method: 'PATCH', as: BOB, json: { name: 'Bobs Projekt' } })).status, 403);
  assert.equal((await api(`/api/folders/${enc}`, { method: 'DELETE', as: BOB })).status, 403);
  assert.equal((await api(`/api/folders/${enc}`, { method: 'PATCH', as: ALICE, json: { name: 'Bobs Projekt' } })).status, 403, 'Alice neither: Bob has an entry in it now');
  assert.equal((await api(`/api/sessions/${bobChat.id}`, { method: 'PATCH', as: BOB, json: { folder: null } })).status, 200);
  const renamed = await api(`/api/folders/${enc}`, { method: 'PATCH', as: ALICE, json: { name: 'Kampagne 2' } });
  assert.equal(renamed.status, 200);
  assert.equal((await store.readSession(secondChat.id)).folder, 'Kampagne 2');
  assert.equal((await wfStore.readWorkflow(inFolderFlow.body.workflow.id)).folder, 'Kampagne 2', 'workflows follow the project');
  assert.equal((await api('/api/folders/Kampagne%202', { method: 'PATCH', as: ADMIN, json: { name: 'Kampagne' } })).status, 200, 'an admin may always');

  // The project profile is admin territory
  assert.equal((await api(`/api/folders/${enc}/profile`, { method: 'PUT', as: BOB, json: { guidelines: 'x' } })).status, 403);
  assert.equal((await api(`/api/folders/${enc}/profile`, { method: 'PUT', as: ALICE, json: { guidelines: 'x' } })).status, 403);
  assert.equal((await api(`/api/folders/${enc}/profile`, { method: 'PUT', as: ADMIN, json: { guidelines: 'Nur fuer Tests' } })).status, 200);
  assert.equal((await api(`/api/folders/${enc}/profile`, { as: BOB })).body.profile.guidelines, 'Nur fuer Tests');

  // Existing chats without owner: their project stays visible and manageable
  const legacyInFolder = await store.createSession({ folder: 'Altbestand-Projekt' });
  assert.ok((await folderNames(CAROL)).includes('Altbestand-Projekt'));
  assert.equal((await api('/api/folders/Altbestand-Projekt', { method: 'PATCH', as: CAROL, json: { name: 'Altbestand umbenannt' } })).status, 200);
  assert.equal((await store.readSession(legacyInFolder.id)).folder, 'Altbestand umbenannt');
}

/* ---------- review findings: admin data of a project, folder names, memory, chat tools ---------- */

// A project's profile (guidelines, context files, memory) and cast are maintained by admins only; deleting or renaming
// the project would remove or move exactly that data, so it is admin-only as well.
async function testFolderAdminData({ api, iso }) {
  const castLib = iso.load('lib/cast');
  const storeLib = iso.load('lib/store');
  const folder = 'Kunde';
  const enc = encodeURIComponent(folder);
  assert.equal((await api('/api/folders', { method: 'POST', as: ADMIN, json: { name: folder } })).status, 201);
  assert.equal((await api(`/api/folders/${enc}/profile`, { method: 'PUT', as: ADMIN, json: { guidelines: 'Richtlinien des Kunden' } })).status, 200);
  assert.equal((await api(`/api/folders/${enc}/profile/context-files`, { method: 'POST', as: ADMIN, json: { name: 'brief.md', text: 'Brief' } })).status, 201);

  // the project is empty, so everybody can see it, but its profile keeps it out of reach
  for (const email of [BOB, ALICE, null]) {
    const who = email || 'anonymous';
    assert.equal((await api(`/api/folders/${enc}`, { method: 'DELETE', as: email })).status, 403, `delete as ${who}`);
    assert.equal((await api(`/api/folders/${enc}`, { method: 'PATCH', as: email, json: { name: 'Kunde neu' } })).status, 403, `rename as ${who}`);
  }
  const profile = await storeLib.readFolderProfile(folder);
  assert.equal(profile.guidelines, 'Richtlinien des Kunden', 'the profile survived');
  assert.equal(profile.contextFiles.length, 1, 'and so did the context file');
  assert.ok((await api('/api/folders', { as: BOB })).body.folders.some((entry) => entry.name === folder), 'the project is still there');

  // a project with cast members but no other profile content is protected as well
  assert.equal((await api('/api/folders', { method: 'POST', as: ADMIN, json: { name: 'Nur Cast' } })).status, 201);
  const member = await castLib.createMember('Nur Cast', { name: 'Anna', soul: 'x' });
  assert.equal((await api('/api/folders/Nur%20Cast', { method: 'DELETE', as: BOB })).status, 403);
  assert.equal((await api('/api/folders/Nur%20Cast', { method: 'PATCH', as: BOB, json: { name: 'Anders' } })).status, 403);
  assert.equal((await castLib.listMembers('Nur Cast')).length, 1, 'the cast survived');
  assert.equal((await castLib.readMember(member.id)).name, 'Anna');

  // admins may (and the cast goes with the project); a project without admin data stays as open as before
  assert.equal((await api('/api/folders/Nur%20Cast', { method: 'DELETE', as: ADMIN })).status, 200);
  assert.equal((await api(`/api/folders/${enc}`, { method: 'PATCH', as: ADMIN, json: { name: 'Kunde neu' } })).status, 200);
  assert.equal((await storeLib.readFolderProfile('Kunde neu')).guidelines, 'Richtlinien des Kunden');
  assert.equal((await api('/api/folders', { method: 'POST', as: BOB, json: { name: 'Ohne Profil' } })).status, 201);
  assert.equal((await api('/api/folders/Ohne%20Profil', { method: 'PATCH', as: ALICE, json: { name: 'Ohne Profil 2' } })).status, 200);
  assert.equal((await api('/api/folders/Ohne%20Profil%202', { method: 'DELETE', as: null })).status, 200);
}

// A project name that belongs to a project the caller cannot see must not be guessable through 409.
async function testFolderNameOracle({ api }) {
  const secret = 'Alice Geheimprojekt';
  const chat = await api('/api/sessions', { method: 'POST', as: ALICE, json: { folder: secret } });
  assert.equal(chat.status, 201);
  const enc = encodeURIComponent(secret);
  assert.ok(!(await api('/api/folders', { as: BOB })).body.folders.some((entry) => entry.name === secret));

  for (const name of [secret, secret.toLowerCase(), `  ${secret}  `]) {
    const taken = await api('/api/folders', { method: 'POST', as: BOB, json: { name } });
    assert.equal(taken.status, 400, `POST ${name}`);
    assert.match(taken.body.error, /nicht verfuegbar/);
    assert.equal((await api('/api/folders', { method: 'POST', as: null, json: { name } })).status, 400, 'anonymous as well');
  }
  assert.equal((await api('/api/folders', { method: 'POST', as: BOB, json: { name: 'Voellig anders' } })).status, 201);
  // renaming onto the hidden name answers the same way
  const own = await api('/api/folders', { method: 'POST', as: BOB, json: { name: 'Bobs Eigenes' } });
  assert.equal(own.status, 201);
  const rename = await api('/api/folders/Bobs%20Eigenes', { method: 'PATCH', as: BOB, json: { name: secret } });
  assert.equal(rename.status, 400);
  assert.match(rename.body.error, /nicht verfuegbar/);
  // people who can see the project (its owner, admins) and a visible project keep the honest answer
  assert.equal((await api('/api/folders', { method: 'POST', as: ALICE, json: { name: secret } })).status, 409);
  assert.equal((await api('/api/folders', { method: 'POST', as: ADMIN, json: { name: secret } })).status, 409);
  assert.equal((await api('/api/folders', { method: 'POST', as: ALICE, json: { name: 'Bobs Eigenes' } })).status, 409, 'an empty project is nobody\'s secret');
  assert.equal((await api('/api/folders/Bobs%20Eigenes', { method: 'PATCH', as: BOB, json: { name: 'Voellig anders' } })).status, 409);
  assert.equal((await api(`/api/folders/${enc}`, { as: BOB, method: 'DELETE' })).status, 404, 'still 404 for the hidden project itself');
}

// The Director's notes must not carry the content of one person's private chat into somebody else's chats.
async function testMemoryIsolation({ api, iso, store }) {
  const tools = iso.load('lib/tools');
  const accessLib = iso.load('lib/access');
  const viewerOf = (email) => accessLib.viewerOf({ kubleUser: email });
  const run = (email, sessionId, name, args) => tools.executeTool({ sessionId, config: {}, emit: () => {}, user: email }, name, args);
  const notesFor = async (email) => (await store.readBrainMemory({ viewer: viewerOf(email) })).map((entry) => entry.note);

  // global memory: per person
  await store.appendBrainMemory('Altbestand fuer alle'); // note from before the user management
  const aliceChat = (await api('/api/sessions', { method: 'POST', as: ALICE, json: {} })).body.session;
  assert.equal((await run(ALICE, aliceChat.id, 'save_memory', { note: 'Alices vertrauliche Erkenntnis' })).toolResult, 'Gemerkt.');
  assert.deepEqual((await notesFor(ALICE)).sort(), ['Alices vertrauliche Erkenntnis', 'Altbestand fuer alle']);
  assert.deepEqual(await notesFor(BOB), ['Altbestand fuer alle']);
  assert.deepEqual(await notesFor(null), ['Altbestand fuer alle'], 'anonymous callers only see what nobody owns');
  assert.deepEqual(await notesFor(ADMIN), ['Altbestand fuer alle'], 'the memory is personal, also for admins');
  assert.equal((await store.readBrainMemory()).length, 2, 'the raw file is untouched by the filter');
  await run(BOB, (await api('/api/sessions', { method: 'POST', as: BOB, json: {} })).body.session.id, 'save_memory', { note: 'Bobs Notiz' });
  assert.ok(!(await notesFor(ALICE)).includes('Bobs Notiz'));
  assert.ok((await notesFor(BOB)).includes('Bobs Notiz'));

  // project memory: bound to the chat it came from
  const folder = 'Gedaechtnis';
  await store.createSession({ folder }); // an existing chat without owner keeps the project visible to everybody
  const privateChat = (await api('/api/sessions', { method: 'POST', as: ALICE, json: { folder } })).body.session;
  await store.addFolderMemory(folder, 'Altbestand im Projekt');
  const saved = await run(ALICE, privateChat.id, 'save_project_memory', { note: 'Alices private Projektnotiz' });
  assert.match(saved.toolResult, /Alices private Projektnotiz/);
  const memoryOf = async (email) => (await api(`/api/folders/${encodeURIComponent(folder)}/profile`, { as: email })).body.profile.memory;
  assert.deepEqual((await memoryOf(ALICE)).map((entry) => entry.note).sort(), ['Alices private Projektnotiz', 'Altbestand im Projekt']);
  assert.deepEqual((await memoryOf(ADMIN)).map((entry) => entry.note).sort(), ['Alices private Projektnotiz', 'Altbestand im Projekt']);
  assert.deepEqual((await memoryOf(BOB)).map((entry) => entry.note), ['Altbestand im Projekt']);
  assert.deepEqual((await memoryOf(null)).map((entry) => entry.note), ['Altbestand im Projekt']);
  // sharing the chat shares the note; provenance fields never reach other people
  await share(api, 'sessions', privateChat.id, ALICE, { shareMode: 'team' });
  const bobView = await memoryOf(BOB);
  assert.deepEqual(bobView.map((entry) => entry.note).sort(), ['Alices private Projektnotiz', 'Altbestand im Projekt']);
  for (const entry of bobView) assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'note']);
  assert.equal((await memoryOf(null)).length, 1, 'a team share needs an identified person');
  await share(api, 'sessions', privateChat.id, ALICE, { shareMode: 'private' });
  assert.equal((await memoryOf(BOB)).length, 1);
  // a note whose chat is gone stays with its author and the admins
  assert.equal((await api(`/api/sessions/${privateChat.id}`, { method: 'DELETE', as: ALICE })).status, 200);
  assert.equal((await memoryOf(BOB)).length, 1);
  assert.equal((await memoryOf(ALICE)).length, 2);
  // the prompt reads through the same filter
  const brain = iso.load('lib/brain');
  const prompt = (email) => brain.buildSystemPrompt('none', { videoModel: 'x', brainSeesImages: false }, [], [], null, null, [], null, viewerOf(email));
  const bobPrompt = await prompt(BOB).catch((err) => err);
  if (typeof bobPrompt === 'string') {
    assert.ok(!bobPrompt.includes('Alices vertrauliche Erkenntnis'));
    assert.ok(bobPrompt.includes('Bobs Notiz'));
    assert.ok((await prompt(ALICE)).includes('Alices vertrauliche Erkenntnis'));
    assert.ok(!(await prompt(null)).includes('Bobs Notiz'));
  }
}

// The chat tools must not do what the admin-only routes forbid: brandings are global and admin-maintained.
async function testChatToolsAdminOnly({ api, iso }) {
  const tools = iso.load('lib/tools');
  const chat = (await api('/api/sessions', { method: 'POST', as: BOB, json: {} })).body.session;
  const run = (email, name, args) => tools.executeTool({ sessionId: chat.id, config: {}, emit: () => {}, user: email }, name, args);
  const calls = [
    ['create_branding', { name: 'Fremdes Branding' }],
    ['update_branding', { branding_id: 'abc', patch: { name: 'x' } }],
    ['add_branding_asset', { branding_id: 'abc', session_asset_id: 'abc', target: 'logo' }]
  ];
  for (const email of [BOB, ALICE, null, 'lokal']) {
    for (const [name, args] of calls) {
      await assert.rejects(() => run(email, name, args), /nur fuer Admins/, `${name} as ${email || 'anonymous'}`);
    }
  }
  assert.equal((await api('/api/brandings', { as: BOB })).body.brandings.length, 0, 'nothing was created');
  const created = await run(ADMIN, 'create_branding', { name: 'Admin Branding' });
  assert.match(created.toolResult, /Branding erstellt/);
  assert.equal((await api('/api/brandings', { as: BOB })).body.brandings.length, 1);
  const id = (await api('/api/brandings', { as: BOB })).body.brandings[0].id;
  assert.match((await run(BOSS, 'update_branding', { branding_id: id, patch: { description: 'neu' } })).toolResult, /aktualisiert/);
  // reading stays open: importing a branding file into the chat is not a change
  await assert.rejects(() => run(BOB, 'import_branding_asset', { branding_id: id, filename: 'fehlt.png' }), (err) => !/nur fuer Admins/.test(err.message));
}

/* ---------- admin-only routes ---------- */

const ADMIN_ONLY_ROUTES = [
  ['GET', '/api/settings'],
  ['PUT', '/api/settings', { name: 'FAL_KEY', value: 'x' }],
  ['PUT', '/api/settings/preferences', { name: 'askVideoModel', value: false }],
  ['GET', '/api/admins'],
  ['POST', '/api/admins', { email: 'x@example.com' }],
  ['DELETE', '/api/admins/x%40example.com'],
  ['GET', '/api/users'],
  ['POST', '/api/users', { email: 'x@example.com' }],
  ['DELETE', '/api/users/x%40example.com'],
  ['GET', '/api/sessions/team-groups'],
  ['GET', '/api/teams'],
  ['POST', '/api/teams', { name: 'x', budgetUsd: 1 }],
  ['GET', '/api/teams/abc'],
  ['PATCH', '/api/teams/abc', { name: 'y' }],
  ['DELETE', '/api/teams/abc'],
  ['POST', '/api/teams/abc/members', { emails: ['x@example.com'] }],
  ['PATCH', '/api/teams/abc/members/x%40example.com', { resetBudget: true }],
  ['DELETE', '/api/teams/abc/members/x%40example.com'],
  ['GET', '/api/rendernodes'],
  ['POST', '/api/rendernodes', { name: 'x', url: 'https://example.com', token: 'x' }],
  ['PATCH', '/api/rendernodes/abc', { name: 'x' }],
  ['DELETE', '/api/rendernodes/abc'],
  ['GET', '/api/higgsfield/status'],
  ['POST', '/api/higgsfield/connect', {}],
  ['DELETE', '/api/higgsfield/auth'],
  ['GET', '/api/higgsfield/oauth/callback?code=x&state=y'],
  ['GET', '/api/chatgpt/status'],
  ['POST', '/api/chatgpt/import', {}],
  ['POST', '/api/chatgpt/disconnect', {}],
  ['POST', '/api/prompt-presets/custom', { title: 'x', prompt: 'y' }],
  ['PUT', '/api/prompt-presets/custom/abc', { title: 'x', prompt: 'y' }],
  ['DELETE', '/api/prompt-presets/custom/abc'],
  ['POST', '/api/roles', { name: 'x', prompt: 'y' }],
  ['PUT', '/api/roles/abc', { name: 'x', prompt: 'y' }],
  ['DELETE', '/api/roles/abc'],
  ['POST', '/api/roles/generate', { name: 'x', brief: 'y' }],
  ['POST', '/api/brandings/import', {}],
  ['DELETE', '/api/brandings/abc'],
  ['PUT', '/api/folders/Leer/profile', { guidelines: 'x' }],
  ['POST', '/api/folders/Leer/profile/context-files', { name: 'a.md', text: 'x' }],
  ['DELETE', '/api/folders/Leer/profile/context-files/abc'],
  ['DELETE', '/api/folders/Leer/profile/memory/abc'],
  ['DELETE', '/api/cast/abc']
];

async function testAdminOnly({ api }) {
  for (const [method, url, json] of ADMIN_ONLY_ROUTES) {
    for (const email of [ALICE, null]) {
      const response = await api(url, { method, as: email, json });
      assert.equal(response.status, 403, `${method} ${url} as ${email || 'anonymous'} -> ${response.status}`);
    }
  }
  // Admins (and superadmins) pass the gate; the read-only ones can be called safely
  for (const url of ['/api/settings', '/api/admins', '/api/users', '/api/rendernodes']) {
    for (const email of [ADMIN, BOSS]) assert.equal((await api(url, { as: email })).status, 200, `${url} as ${email}`);
  }
  // Admin management itself works, and takes effect on the next request
  const added = await api('/api/admins', { method: 'POST', as: ADMIN, json: { email: 'newadmin@example.com' } });
  assert.equal(added.status, 201);
  assert.equal((await api('/api/me', { as: 'newadmin@example.com' })).body.role, 'admin');
  assert.equal((await api('/api/settings', { as: 'newadmin@example.com' })).status, 200);
  assert.equal((await api('/api/admins/newadmin%40example.com', { method: 'DELETE', as: ADMIN })).status, 200);
  assert.equal((await api('/api/me', { as: 'newadmin@example.com' })).body.role, 'user');
  assert.equal((await api('/api/settings', { as: 'newadmin@example.com' })).status, 403);

  // Not admin-only (the team works with them): reading roles, presets, brandings, config, node registry, folders
  for (const url of ['/api/roles', '/api/prompt-presets', '/api/brandings', '/api/config', '/api/nodes/registry', '/api/workflow-templates', '/api/workflow-templates/dub-clip', '/api/rendernode/status']) {
    assert.equal((await api(url, { as: ALICE })).status, 200, url);
  }
  assert.ok((await api('/api/workflow-templates', { as: ALICE })).body.templates.some((template) => template.id === 'dub-clip'), 'internal people see every starter template');
}

/* ---------- team list ---------- */

async function testTeam({ api, iso }) {
  const members = (await api('/api/team', { as: BOB })).body;
  assert.equal(members.active, true);
  const byEmail = Object.fromEntries(members.members.map((member) => [member.email, member]));
  assert.equal(byEmail[ADMIN].role, 'admin');
  assert.equal(byEmail[BOSS].role, 'admin', 'the team list does not name superadmins');
  assert.equal(byEmail[ALICE].role, 'user');
  assert.equal(byEmail[BOB].me, true);
  assert.equal(byEmail[ALICE].me, false);
  assert.ok(byEmail[CAROL], 'people who logged in once are on the list without anybody typing them in');
  assert.equal((await api('/api/team')).status, 403, 'anonymous callers get no team list');

  // The record: first / last seen, only visible to admins
  const list = (await api('/api/users', { as: ADMIN })).body.users;
  const alice = list.find((member) => member.email === ALICE);
  assert.deepEqual(alice.sources, ['seen']);
  assert.match(alice.firstSeen, /^\d{4}-\d\d-\d\dT/);
  assert.match(alice.lastSeen, /^\d{4}-\d\d-\d\dT/);
  assert.equal(alice.removable, true);
  assert.equal(list.find((member) => member.email === ADMIN).removable, false);
  assert.ok(!('firstSeen' in (await api('/api/team', { as: BOB })).body.members[0]));
  const seenFile = path.join(iso.root, 'data', 'team-seen.json');
  assert.ok(fs.existsSync(seenFile));
  assert.equal(fs.statSync(seenFile).mode & 0o777, 0o600);

  // Adding by hand: for people who have not logged in yet
  const dave = 'dave@example.com';
  const added = await api('/api/users', { method: 'POST', as: ADMIN, json: { email: ` ${dave.toUpperCase()} ` } });
  assert.equal(added.status, 201);
  assert.equal(added.body.email, dave);
  const daveMember = (await api('/api/team', { as: BOB })).body.members.find((member) => member.email === dave);
  assert.equal(daveMember.role, 'user');
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: dave } })).status, 400);
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: ADMIN } })).status, 400, 'admins are managed in the admin list');
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: 'kein-email' } })).status, 400);
  assert.equal((await api('/api/users', { method: 'POST', as: ALICE, json: { email: 'e@example.com' } })).status, 403);
  // ... and can be shared with right away
  const chat = (await api('/api/sessions', { method: 'POST', as: ALICE, json: {} })).body.session;
  assert.equal((await share(api, 'sessions', chat.id, ALICE, { shareMode: 'specific', sharedWith: [dave] })).status, 200);
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: dave })).status, 200);
  await api(`/api/sessions/${chat.id}`, { method: 'DELETE', as: ALICE });

  // Removing: the person is gone from the picker and does not come back by merely using the app
  const removed = await api(`/api/users/${encodeURIComponent(CAROL)}`, { method: 'DELETE', as: ADMIN });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.users.some((member) => member.email === CAROL));
  await api('/api/me', { as: CAROL });
  assert.ok(!(await api('/api/team', { as: BOB })).body.members.some((member) => member.email === CAROL));
  assert.equal((await api('/api/me', { as: CAROL })).status, 200, 'the team list is not an access list: Carol still uses the app');
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: CAROL } })).status, 201);
  assert.ok((await api('/api/team', { as: BOB })).body.members.some((member) => member.email === CAROL));
  assert.equal((await api(`/api/users/${ADMIN}`, { method: 'DELETE', as: ADMIN })).status, 400);
  assert.equal((await api('/api/users/nobody%40example.com', { method: 'DELETE', as: ADMIN })).status, 404);
  assert.equal((await api(`/api/users/${dave}`, { method: 'DELETE', as: ALICE })).status, 403);
  assert.equal((await api(`/api/users/${dave}`, { method: 'DELETE', as: ADMIN })).status, 200);
}

/* ---------- costs ---------- */

async function testCosts({ api, costsLib, chat }) {
  const now = new Date().toISOString();
  await costsLib.recordCost({ ts: now, sessionId: chat.id, type: 'brain', model: 'anthropic/claude-opus-4.6', cost: 0.5, user: ALICE });
  await costsLib.recordCost({ ts: now, sessionId: 'bobs-session', type: 'image', model: 'openai/gpt-image-2', cost: 0.25, user: BOB });
  await costsLib.recordCost({ ts: now, sessionId: chat.id, type: 'brain', model: 'openai/gpt-5.2', cost: 0.125, user: BOB });

  const alice = (await api('/api/costs/summary', { as: ALICE })).body;
  assert.equal(alice.scope, 'own');
  assert.equal(alice.total, 0.5);
  assert.deepEqual(alice.byUser.map((row) => row.user), [ALICE]);
  assert.equal(alice.mine.total, 0.5);
  assert.equal(alice.bySession[0].title, 'Neuer Chat');
  const bob = (await api('/api/costs/summary', { as: BOB })).body;
  assert.equal(bob.total, 0.375);
  assert.deepEqual(bob.byUser.map((row) => row.user), [BOB]);
  assert.ok(!bob.bySession.some((row) => row.title), 'no title of a private chat of somebody else');
  const admin = (await api('/api/costs/summary', { as: ADMIN })).body;
  assert.equal(admin.scope, 'all');
  assert.equal(admin.total, 0.875);
  assert.deepEqual(admin.byUser.map((row) => row.user).sort(), [ALICE, BOB]);
  assert.equal(admin.mine.total, 0);
  const anonymous = (await api('/api/costs/summary')).body;
  assert.equal(anonymous.total, 0);
  assert.equal(anonymous.scope, 'own');
}

/* ---------- monitoring ---------- */

async function testMonitoring({ api, costsLib, store, chat }) {
  const day = 86400000;
  const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
  await costsLib.recordCost({ ts: at(2), sessionId: 's-old', type: 'fal', model: 'fal-ai/some-model', cost: 2, user: BOB });
  await costsLib.recordCost({ ts: at(20), sessionId: 's-old', type: 'higgsfield', model: 'kling', cost: 0, user: ALICE, billing: 'Abo' });
  await costsLib.recordCost({ ts: at(100), sessionId: 's-old', type: 'video', model: 'bytedance/seedance-2.5', cost: 9, user: ALICE });
  await store.mutateSession(chat.id, (session) => {
    session.jobs.push({ jobId: 'job-failed', status: 'failed', provider: 'fal', kind: 'video', error: 'kaputt', createdAt: at(1) });
  });

  // Only superadmins: a plain admin, a user and anonymous callers get a 404 as if the feature did not exist
  for (const email of [ADMIN, ALICE, null]) {
    for (const url of ['/api/admin/monitoring', '/api/admin/monitoring/export', '/monitoring.html']) {
      assert.equal((await api(url, { as: email, raw: true })).status, 404, `${url} as ${email || 'anonymous'}`);
    }
  }
  const report = await api('/api/admin/monitoring', { as: BOSS });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  const data = report.body;
  assert.equal(data.filters.days, '30');
  assert.deepEqual(data.options.users.includes(ALICE) && data.options.users.includes(BOB), true);
  assert.ok(data.options.providers.includes('fal') && data.options.providers.includes('higgsfield') && data.options.providers.includes('anthropic'));
  assert.equal(data.rows.find((row) => row.model === 'bytedance/seedance-2.5'), undefined, '100 days ago is outside the period');
  assert.ok(data.byUser.find((row) => row.key === BOB).costUsd >= 2.25);
  assert.ok(data.byProvider.find((row) => row.key === 'fal').costUsd >= 2);
  assert.ok(data.byDay.length >= 2);
  assert.match(data.byDay[0].key, /^\d{4}-\d\d-\d\d$/);
  assert.ok(data.totals.runs >= 1, 'the run of Bob is counted');
  assert.ok(data.runs.byUser.some((row) => row.key === BOB));
  assert.ok(data.totals.failedJobs >= 1);
  assert.ok(data.jobs.errors.some((row) => row.jobId === 'job-failed' && row.provider === 'fal' && row.user === ALICE));
  assert.equal(typeof data.runtime.uptimeSeconds, 'number');
  assert.equal(data.totals.subscriptionCount >= 1, true);
  // filters
  const week = (await api('/api/admin/monitoring?days=7', { as: BOSS })).body;
  assert.ok(!week.rows.some((row) => row.billing === 'Abo'), '20 days ago is outside 7 days');
  assert.equal((await api('/api/admin/monitoring?days=all', { as: BOSS })).body.rows.some((row) => row.model === 'bytedance/seedance-2.5'), true);
  const onlyBob = (await api(`/api/admin/monitoring?user=${encodeURIComponent(BOB.toUpperCase())}`, { as: BOSS })).body;
  assert.ok(onlyBob.rows.length > 0 && onlyBob.rows.every((row) => row.user === BOB));
  const onlyFal = (await api('/api/admin/monitoring?provider=fal', { as: BOSS })).body;
  assert.ok(onlyFal.rows.length > 0 && onlyFal.rows.every((row) => row.provider === 'fal'));
  for (const query of ['days=5', 'days=abc', 'user[]=a']) {
    assert.equal((await api(`/api/admin/monitoring?${query}`, { as: BOSS })).status, 400, query);
  }
  // Refusals and failed requests are journaled (route template, status, person; no URLs)
  const journal = await waitFor(async () => {
    const body = (await api('/api/admin/monitoring', { as: BOSS })).body;
    return body.errors.denied > 0 && body.errors.total > 0 ? body : null;
  }, { message: 'the API error journal' });
  assert.ok(journal.errors.deniedRows.every((row) => [401, 403].includes(row.status)));
  const serialised = JSON.stringify(journal.errors);
  assert.ok(!serialised.includes(chat.id), 'no concrete URLs in the journal');
  assert.ok(serialised.includes('/api/sessions/:id'));

  // CSV
  const csv = await api('/api/admin/monitoring/export?days=30', { as: BOSS, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte order mark for Excel');
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  assert.ok(text.startsWith('"timestamp_utc";"day_zurich";"user";"provider";"model"'));
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length - 1, (await api('/api/admin/monitoring?days=30', { as: BOSS })).body.totals.count, 'the CSV holds every matching row, not only the first 100');
  assert.ok(lines.some((line) => line.includes(`"${BOB}"`) && line.includes('"fal"')));
  assert.equal((await api('/api/admin/monitoring/export?days=zzz', { as: BOSS })).status, 400);

  // The page
  const page = await api('/monitoring.html', { as: BOSS, raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /monitoring-root/);
  for (const variant of ['/Monitoring.HTML', '/monitoring.html?x=1', '/%6donitoring.html', '//monitoring.html']) {
    const asAdmin = await api(variant, { as: ADMIN, raw: true });
    assert.notEqual(asAdmin.status, 200, `${variant} as admin`);
    assert.ok(!(await asAdmin.text()).includes('monitoring-root'), variant);
  }
}

/* ---------- anonymous callers ---------- */

async function testAnonymous({ api, store, wfStore }) {
  // whoami answers "not logged in": the caller can work with what has no owner, but everything new is ownerless too
  const chat = await api('/api/sessions', { method: 'POST', json: {} });
  assert.equal(chat.status, 201);
  assert.equal(chat.body.session.owner, null);
  assert.equal(chat.body.session.unowned, true);
  assert.equal((await store.readSession(chat.body.session.id)).owner ?? null, null);
  assert.equal((await api(`/api/sessions/${chat.body.session.id}`, { as: BOB })).status, 200, 'and is visible to everybody');
  const flow = await api('/api/workflows', { method: 'POST', json: { name: 'Anonym' } });
  assert.equal(flow.status, 201);
  assert.equal(flow.body.workflow.owner, null);
  assert.equal((await wfStore.readWorkflow(flow.body.workflow.id)).owner ?? null, null);
  assert.equal((await api(`/api/workflows/${flow.body.workflow.id}`, { as: BOB })).status, 200);
  assert.equal((await api('/api/team')).status, 403);
  assert.equal((await api(`/api/sessions/${chat.body.session.id}/share`, { method: 'PATCH', json: { shareMode: 'team' } })).status, 403);
  // an address that is not one (whoami answered something odd) is anonymous as well
  assert.equal((await api('/api/me', { as: 'lokal' })).body.identified, false);
  assert.equal((await api('/api/me', { as: 'kein-mensch' })).body.role, 'anonymous');
}

/* ---------- route inventory ---------- */

const { ROUTE_RULES } = require('./support/route-rules');

function registeredRoutes(app) {
  const routes = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
  }
  return routes.sort();
}

function testRouteInventory({ iso, exercised }) {
  const registered = registeredRoutes(iso.app);
  assert.deepEqual(registered, Object.keys(ROUTE_RULES).sort(), 'every route needs an entry in ROUTE_RULES (and every entry a route)');
  assert.deepEqual(Object.values(ROUTE_RULES).filter((rule) => !['public', 'open', 'admin', 'superadmin', 'identified', 'internal', 'session', 'workflow', 'folder'].includes(rule)), []);

  // Routes on one chat or workflow: each was called by an outsider and answered 404 (see testSessions / testWorkflows)
  const covered = new Set(exercised);
  const idRoutes = Object.entries(ROUTE_RULES).filter(([route, rule]) => (rule === 'session' || rule === 'workflow') && route.includes('/:id'));
  const missing = idRoutes
    .map(([route]) => route)
    .filter((route) => ![...covered].some((entry) => matchesRoute(route, entry)));
  assert.deepEqual(missing, [], 'routes on a chat / workflow that no test called as an outsider');

  // Admin routes were called as user and anonymous (testAdminOnly)
  const adminRoutes = Object.entries(ROUTE_RULES).filter(([, rule]) => rule === 'admin').map(([route]) => route);
  const testedAdmin = ADMIN_ONLY_ROUTES.map(([method, url]) => `${method} ${url.split('?')[0]}`);
  const untested = adminRoutes.filter((route) => !testedAdmin.some((entry) => matchesRoute(route, entry)));
  assert.deepEqual(untested, [], 'admin routes that no test called as a non-admin');
}

// "GET /api/x/:id/y" matches "GET /api/x/abc/y"
function matchesRoute(pattern, concrete) {
  const [method, routePath] = pattern.split(' ');
  const [cMethod, cPath] = concrete.split(' ');
  if (method !== cMethod) return false;
  const expression = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+');
  return new RegExp(`^${expression}$`).test(cPath);
}

/* ---------- local mode ---------- */

async function testLocalMode() {
  const iso = await createIsolatedApp({ active: false, env: { OPENROUTER_API_KEY: '', ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: BOSS } });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  const store = iso.load('lib/store');
  const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
  const costsLib = iso.load('lib/costs');
  try {
    assert.deepEqual((await api('/api/me')).body, { active: false, identified: false, email: null, role: 'local', isAdmin: true, isSuperAdmin: false, logoutUrl: null });
    // identities are meaningless without AUTH_WHOAMI_URL: a cookie changes nothing
    assert.equal((await api('/api/me', { as: BOB })).body.role, 'local');

    // chats: the same shapes as before (no owner or sharing fields anywhere), nothing is filtered
    const created = await api('/api/sessions', { method: 'POST', json: {} });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body.session).sort(), ['folder', 'id', 'role', 'title', 'updatedAt']);
    const id = created.body.session.id;
    assert.equal((await store.readSession(id)).owner ?? null, null);
    await api(`/api/sessions/${id}`, { method: 'PATCH', json: { title: 'Lokal' } });
    const onDisk = JSON.parse(fs.readFileSync(path.join(iso.root, 'projects', `${id}.json`), 'utf8'));
    for (const key of ['owner', 'shareMode', 'sharedWith']) assert.equal(key in onDisk, false, `the session file gets no ${key} in the local mode`);
    const foreign = await store.createSession({ owner: ALICE }); // left over from a run with user management
    const listed = (await api('/api/sessions?limit=100')).body.sessions;
    assert.deepEqual(listed.map((entry) => entry.id).sort(), [foreign.id, id].sort());
    for (const entry of listed) assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'folder', 'id', 'title', 'updatedAt']);
    const detail = await api(`/api/sessions/${foreign.id}`, { as: BOB });
    assert.equal(detail.status, 200);
    for (const key of ['owner', 'shareMode', 'sharedWith', 'canManage', 'mine', 'unowned']) assert.equal(key in detail.body.session, false, key);
    assert.equal((await api(`/api/sessions/${foreign.id}`, { method: 'PATCH', json: { title: 'Lokal frei' } })).status, 200);
    assert.equal((await api(`/api/sessions/${foreign.id}/share`, { method: 'PATCH', json: { shareMode: 'team' } })).body.code, 'USER_MANAGEMENT_INACTIVE');
    assert.equal((await api(`/api/sessions/${foreign.id}/message`, { method: 'POST', json: { text: 'hi' } })).status, 200);

    // assets are served as before (public cache header, no lookup)
    const asset = await store.saveAsset(foreign.id, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'x', cost: null });
    const served = await api(asset.url, { raw: true });
    assert.equal(served.status, 200);
    assert.match(served.headers.get('cache-control'), /^public/);

    // workflows
    const flow = await api('/api/workflows', { method: 'POST', json: { name: 'Lokal' } });
    assert.equal(flow.status, 201);
    for (const key of ['owner', 'shareMode', 'sharedWith', 'canManage', 'mine']) assert.equal(key in flow.body.workflow, false, key);
    const flowId = flow.body.workflow.id;
    assert.equal('owner' in (await wfStore.readWorkflow(flowId)) && (await wfStore.readWorkflow(flowId)).owner !== null, false);
    const item = (await api('/api/workflows')).body.workflows[0];
    assert.equal('owner' in item || 'shareMode' in item || 'canManage' in item, false);
    assert.equal(('owner' in (await api(`/api/workflows/${flowId}`)).body.workflow), false);
    assert.equal((await api(`/api/workflows/${flowId}/share`, { method: 'PATCH', json: { shareMode: 'team' } })).body.code, 'USER_MANAGEMENT_INACTIVE');
    assert.equal((await api(`/api/workflows/${flowId}`, { method: 'DELETE' })).status, 200);

    // everything is open: settings, admins, users, the project profile
    for (const url of ['/api/settings', '/api/admins', '/api/users', '/api/rendernodes']) assert.equal((await api(url)).status, 200, url);
    assert.equal((await api('/api/folders', { method: 'POST', json: { name: 'Lokal' } })).status, 201);
    assert.equal((await api('/api/folders/Lokal/profile', { method: 'PUT', json: { guidelines: 'x' } })).status, 200);
    assert.deepEqual((await api('/api/team')).body, { active: false, members: [] });
    // the chat tools stay as open as the rest, and the global memory keeps its old shape (no owner)
    const tools = iso.load('lib/tools');
    assert.match((await tools.executeTool({ sessionId: id, config: {}, emit: () => {}, user: 'lokal' }, 'create_branding', { name: 'Lokal' })).toolResult, /Branding erstellt/);
    await tools.executeTool({ sessionId: id, config: {}, emit: () => {}, user: 'lokal' }, 'save_memory', { note: 'lokal gemerkt' });
    assert.deepEqual(Object.keys((await store.readBrainMemory({ viewer: iso.load('lib/access').viewerOf({ kubleUser: BOB }) }))[0]).sort(), ['note', 'ts']);

    // monitoring does not exist: nobody is a superadmin without a login
    for (const url of ['/api/admin/monitoring', '/api/admin/monitoring/export', '/monitoring.html']) {
      assert.equal((await api(url, { as: BOSS, raw: true })).status, 404, url);
    }

    // costs: the old shape
    await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: id, type: 'brain', model: 'anthropic/claude-opus-4.6', cost: 0.5, user: 'lokal' });
    const summary = (await api('/api/costs/summary')).body;
    assert.equal(summary.total, 0.5);
    assert.equal('scope' in summary || 'mine' in summary, false);

    // nothing of the user management is written: no team record, no error journal
    await api('/api/sessions/does-not-exist-1');
    await sleep(200);
    assert.equal(fs.existsSync(path.join(iso.root, 'data', 'team-seen.json')), false);
    assert.equal(fs.existsSync(path.join(iso.root, 'data', 'admin-api-errors.json')), false);
    assert.equal(fs.existsSync(path.join(iso.root, 'data', 'users.json')), false);
  } finally {
    await iso.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
