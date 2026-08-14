'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  createRenderNodesStore,
  RenderNodesValidationError,
  maskToken
} = require('../lib/rendernodes-store');
const renderNodesStoreModule = require('../lib/rendernodes-store');
const rendernode = require('../lib/rendernode');
const { createRenderNodeClient } = rendernode;

const TEST_NODES = [
  { id: 'node-0000000a', name: 'Alpha', url: 'https://alpha.test', token: 'alpha-secret-token', enabled: true },
  { id: 'node-0000000b', name: 'Beta', url: 'https://beta.test', token: 'beta-secret-token', enabled: true },
  { id: 'node-0000000c', name: 'Gamma', url: 'https://gamma.test', token: 'gamma-secret-token', enabled: true }
];

function staticStore(nodes = TEST_NODES) {
  return { listNodes: () => nodes.map((node) => ({ ...node })) };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function clientWithStatuses(statuses, requests = []) {
  return createRenderNodeClient({
    store: staticStore(),
    env: {},
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const key = parsed.hostname.split('.')[0];
      requests.push({ url, options });
      if (parsed.pathname === '/health') {
        const status = statuses[key] || { online: false, running: false, queue: 0 };
        return jsonResponse({
          ok: status.online,
          running: status.running,
          queue: status.queue,
          streamingUploads: status.streamingUploads === true
        });
      }
      if (parsed.pathname === '/render') return jsonResponse({ jobId: `job-${key}` });
      if (parsed.pathname.startsWith('/jobs/')) return jsonResponse({ status: 'running', node: key });
      throw new Error(`Unerwartete Stub-URL: ${url}`);
    }
  });
}

async function testStoreCrud(directory) {
  const file = path.join(directory, 'render-nodes.json');
  let sequence = 1;
  const store = createRenderNodesStore({
    file,
    idGenerator: () => `node-${String(sequence++).padStart(8, '0')}`
  });
  assert.deepEqual(store.loadNodes(), []);
  assert.throws(
    () => store.createNode({ name: 'Alpha', url: 'https://alpha.test', token: 'secret', extra: true }),
    RenderNodesValidationError
  );
  assert.throws(
    () => store.createNode({ name: 'Alpha', url: 'ftp://alpha.test', token: 'secret' }),
    /http:\/\//
  );
  assert.throws(
    () => store.createNode({ name: 'x'.repeat(41), url: 'https://alpha.test', token: 'secret' }),
    /maximal 40/
  );
  assert.throws(
    () => store.createNode({ name: 'Alpha', url: 'https://alpha.test', token: 'x'.repeat(501) }),
    /maximal 500/
  );

  const alpha = store.createNode({
    name: ' Alpha ',
    url: 'https://alpha.test/',
    token: 'alpha-super-secret'
  });
  assert.deepEqual(alpha, {
    id: 'node-00000001',
    name: 'Alpha',
    url: 'https://alpha.test',
    token: 'alpha-super-secret',
    enabled: true
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(maskToken(alpha.token), 'alph…cret');
  assert.equal(maskToken(alpha.token).includes(alpha.token), false);
  assert.throws(() => store.updateNode(alpha.id, { arbitrary: true }), RenderNodesValidationError);
  const disabled = store.updateNode(alpha.id, { name: 'Alpha 2', enabled: false });
  assert.equal(disabled.name, 'Alpha 2');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.token, alpha.token);
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), [disabled]);
  assert.deepEqual(store.deleteNode(alpha.id), disabled);
  assert.deepEqual(store.listNodes(), []);
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), []);
  assert.equal((await fsp.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
}

async function testFallback() {
  const client = createRenderNodeClient({
    store: staticStore([]),
    env: { RENDER_NODE_URL: 'https://default.test/', RENDER_NODE_TOKEN: 'default-secret' },
    fetchImpl: async () => jsonResponse({ ok: true, running: false, queue: 0 })
  });
  assert.deepEqual(client.listNodes(), [{
    id: 'node-default',
    name: 'Standard',
    url: 'https://default.test',
    token: 'default-secret',
    enabled: true,
    implicit: true
  }]);

  const storedWins = createRenderNodeClient({
    store: staticStore([TEST_NODES[0]]),
    env: { RENDER_NODE_URL: 'https://default.test', RENDER_NODE_TOKEN: 'default-secret' }
  });
  assert.deepEqual(storedWins.listNodes().map((node) => node.id), ['node-0000000a']);
}

async function testDispatch() {
  const idleRequests = [];
  const idleClient = clientWithStatuses({
    alpha: { online: true, running: true, queue: 0 },
    beta: { online: true, running: false, queue: 0 },
    gamma: { online: true, running: false, queue: 2 }
  }, idleRequests);
  assert.deepEqual(
    await idleClient.submit('<main></main>', 'draft', undefined, 'landscape'),
    { jobId: 'job-beta', nodeId: 'node-0000000b' }
  );
  const idleRender = idleRequests.find((request) => new URL(request.url).pathname === '/render');
  assert.equal(idleRender.url, 'https://beta.test/render');
  assert.equal(idleRender.options.headers.Authorization, 'Bearer beta-secret-token');

  const queueRequests = [];
  const queueClient = clientWithStatuses({
    alpha: { online: true, running: true, queue: 3 },
    beta: { online: true, running: true, queue: 1 },
    gamma: { online: false, running: false, queue: 0 }
  }, queueRequests);
  assert.deepEqual(
    await queueClient.submit('<main></main>', 'standard'),
    { jobId: 'job-beta', nodeId: 'node-0000000b' }
  );
  assert.equal(queueRequests.some((request) => request.url === 'https://gamma.test/render'), false);

  const offlineClient = clientWithStatuses({
    alpha: { online: false, running: false, queue: 0 },
    beta: { online: false, running: false, queue: 0 },
    gamma: { online: false, running: false, queue: 0 }
  });
  await assert.rejects(offlineClient.submit('<main></main>'), /Kein Render-Node online\./);
}

async function testJobRouting() {
  const requests = [];
  const client = clientWithStatuses({}, requests);
  const exact = await client.jobStatus('job-42', 'node-0000000c');
  assert.equal(exact.node, 'gamma');
  assert.equal(requests.at(-1).url, 'https://gamma.test/jobs/job-42');
  assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer gamma-secret-token');

  const oldJob = await client.jobStatus('legacy-job');
  assert.equal(oldJob.node, 'alpha');
  assert.equal(requests.at(-1).url, 'https://alpha.test/jobs/legacy-job');
}

async function testAggregate() {
  const client = clientWithStatuses({
    alpha: { online: true, running: true, queue: 2 },
    beta: { online: false, running: false, queue: 9 },
    gamma: { online: true, running: false, queue: 3 }
  });
  const expected = {
    enabled: true,
    nodes: [
      { id: 'node-0000000a', name: 'Alpha', online: true, running: true, queue: 2, streamingUploads: false },
      { id: 'node-0000000b', name: 'Beta', online: false, running: false, queue: 0, streamingUploads: false },
      { id: 'node-0000000c', name: 'Gamma', online: true, running: false, queue: 3, streamingUploads: false }
    ],
    online: true,
    running: true,
    queue: 5
  };
  assert.deepEqual(await client.aggregateStatus(), expected);

  const originalAggregateStatus = rendernode.aggregateStatus;
  rendernode.aggregateStatus = () => client.aggregateStatus();
  try {
    const { renderNodeStatus } = require('../server');
    assert.deepEqual(await renderNodeStatus(), expected);
  } finally {
    rendernode.aggregateStatus = originalAggregateStatus;
  }
}

function routeHandler(app, routePath, method) {
  const layer = app._router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

async function invokeRoute(app, routePath, method, { params = {}, body = {}, kubleUser = 'admin@example.com' } = {}) {
  const handler = routeHandler(app, routePath, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json(bodyValue) {
        result.body = bodyValue;
        resolve(result);
      }
    };
    Promise.resolve(handler({ params, body, kubleUser }, res)).catch(reject);
  });
}

async function testAdminApi() {
  const { app } = require('../server');
  const originals = {
    listConfiguredNodes: rendernode.listConfiguredNodes,
    nodeStatus: rendernode.nodeStatus,
    resetStatusCache: rendernode.resetStatusCache,
    createNode: renderNodesStoreModule.createNode,
    updateNode: renderNodesStoreModule.updateNode,
    deleteNode: renderNodesStoreModule.deleteNode,
    authWhoamiUrl: process.env.AUTH_WHOAMI_URL,
    adminEmails: process.env.ADMIN_EMAILS
  };
  const calls = [];
  const apiNode = { ...TEST_NODES[0], implicit: false };
  try {
    process.env.AUTH_WHOAMI_URL = 'https://whoami.test';
    process.env.ADMIN_EMAILS = 'admin@example.com';
    rendernode.listConfiguredNodes = () => [apiNode];
    rendernode.nodeStatus = async () => ({ online: true, running: false, queue: 0, streamingUploads: true });
    rendernode.resetStatusCache = () => calls.push(['reset']);
    renderNodesStoreModule.createNode = (body) => calls.push(['create', body]);
    renderNodesStoreModule.updateNode = (id, body) => calls.push(['update', id, body]);
    renderNodesStoreModule.deleteNode = (id) => calls.push(['delete', id]);

    const forbidden = await invokeRoute(app, '/api/rendernodes', 'get', { kubleUser: 'visitor@example.com' });
    assert.equal(forbidden.status, 403);

    const listed = await invokeRoute(app, '/api/rendernodes', 'get');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.nodes[0].token, 'alph…oken');
    assert.equal(JSON.stringify(listed.body).includes(apiNode.token), false, 'Die Admin-API darf Tokens nie voll ausgeben.');
    assert.deepEqual(
      Object.keys(listed.body.nodes[0]).sort(),
      ['enabled', 'id', 'implicit', 'name', 'online', 'queue', 'running', 'streamingUploads', 'token', 'url'].sort()
    );

    const created = await invokeRoute(app, '/api/rendernodes', 'post', {
      body: { name: 'Delta', url: 'https://delta.test', token: 'delta-secret' }
    });
    assert.equal(created.status, 201);
    await invokeRoute(app, '/api/rendernodes/:id', 'patch', {
      params: { id: apiNode.id },
      body: { enabled: false }
    });
    await invokeRoute(app, '/api/rendernodes/:id', 'delete', { params: { id: apiNode.id } });
    assert.deepEqual(calls.filter((call) => call[0] !== 'reset'), [
      ['create', { name: 'Delta', url: 'https://delta.test', token: 'delta-secret' }],
      ['update', apiNode.id, { enabled: false }],
      ['delete', apiNode.id]
    ]);
    assert.equal(calls.filter((call) => call[0] === 'reset').length, 3);
  } finally {
    rendernode.listConfiguredNodes = originals.listConfiguredNodes;
    rendernode.nodeStatus = originals.nodeStatus;
    rendernode.resetStatusCache = originals.resetStatusCache;
    renderNodesStoreModule.createNode = originals.createNode;
    renderNodesStoreModule.updateNode = originals.updateNode;
    renderNodesStoreModule.deleteNode = originals.deleteNode;
    if (originals.authWhoamiUrl === undefined) delete process.env.AUTH_WHOAMI_URL;
    else process.env.AUTH_WHOAMI_URL = originals.authWhoamiUrl;
    if (originals.adminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originals.adminEmails;
  }
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-render-nodes-'));
  try {
    await testStoreCrud(directory);
    await testFallback();
    await testDispatch();
    await testJobRouting();
    await testAggregate();
    await testAdminApi();
    console.log('Render-Nodes: CRUD, Admin-API, Validierung, Maskierung, Fallback, Dispatch, Job-Routing und Aggregat sind korrekt.');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
