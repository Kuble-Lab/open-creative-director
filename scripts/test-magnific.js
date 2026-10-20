'use strict';

// Completely offline OAuth/MCP fake. The injected transport exercises the HTTP protocol without opening ports.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createIsolatedApp } = require('./support/isolated-app');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function main() {
  const iso = await createIsolatedApp({ loadServer: false, env: { AUTH_WHOAMI_URL: 'https://identity.invalid', INTERNAL_EMAIL_DOMAINS: 'staff.test', ADMIN_EMAILS: 'admin@staff.test' } });
  const realFetch = global.fetch;
  const logs = [];
  const realWarn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  global.fetch = async () => { throw new Error('Network forbidden'); };
  let fakeServer;
  try {
    const magnific = iso.load('lib/magnific');
    const store = iso.load('lib/store');
    const tools = iso.load('lib/tools');
    const api = iso.load('lib/tools/magnific');
    const registry = iso.load('lib/nodes/registry');
    const catalog = iso.load('lib/nodes/magnific-catalog');
    const access = iso.load('lib/access');
    const teams = iso.load('lib/teams');
    const settings = iso.load('lib/settings');
    const hf = iso.load('lib/higgsfield');
    const costs = iso.load('lib/costs');
    const assistant = iso.load('lib/nodes/assistant');
    store.ensureDirs();
    const schemas = [
      ['account_balance', {}], ['images_upscale_modes_list', {}],
      ['simulate_cost', { tool_name: { type: 'string' }, arguments: { type: 'object' } }],
      ['creations_request_upload', { filename: { type: 'string' }, content_type: { type: 'string' }, size: { type: 'number' } }],
      ['creations_finalize_upload', { upload_id: { type: 'string' } }],
      ['images_upscale', { creation_id: { type: 'string' }, mode: { type: 'string', enum: ['creative', 'precision'] }, scale: { type: 'integer', enum: [2, 4, 8, 16] } }],
      ['creations_wait', { creation_ids: { type: 'array', items: { type: 'string' } } }],
      ['creation_status', { creation_id: { type: 'string' } }], ['creations_get', { creation_ids: { type: 'array', items: { type: 'string' } } }],
      ['video_generate', { prompt: { type: 'string' } }]
    ].map(([name, properties]) => ({ name, description: `Fake ${name}`, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }));
    const calls = [];
    let state;
    let clientId;
    let refreshes = 0;
    let rejectNext = false;
    let sse = false;
    let fakeNow = Date.now();
    const ISSUER = 'https://auth.magnific.test/realms/mcp';
    const redirect = 'https://app.test/prefix/api/magnific/oauth/callback';
    const secretAccess = 'access-SECRET', secretRefresh = 'refresh-SECRET', secretCode = 'code-SECRET';
    const fake = async (url, options = {}) => {
      calls.push([url, options]);
      if (url.endsWith('/.well-known/oauth-protected-resource')) return json({ authorization_servers: [ISSUER] });
      if (url.includes('/.well-known/oauth-authorization-server')) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`, code_challenge_methods_supported: ['S256'] });
      if (url.endsWith('/register')) {
        const body = JSON.parse(options.body);
        assert.equal(body.token_endpoint_auth_method, 'none');
        assert.deepEqual(body.redirect_uris, [redirect]);
        clientId = 'public-client';
        return json({ client_id: clientId, redirect_uris: [redirect] });
      }
      if (url.endsWith('/token')) {
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('client_id'), clientId);
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), secretCode);
          assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), state.searchParams.get('code_challenge'));
          assert.equal(form.get('redirect_uri'), redirect);
        } else { refreshes += 1; assert.equal(form.get('refresh_token'), secretRefresh); }
        return json({ access_token: secretAccess, refresh_token: secretRefresh, expires_in: 3600 });
      }
      assert.equal(url, 'https://mcp.magnific.com');
      assert.equal(options.headers.Authorization, `Bearer ${secretAccess}`);
      if (rejectNext) { rejectNext = false; return json({}, 401); }
      const body = JSON.parse(options.body);
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      else if (body.method === 'tools/list') result = { tools: schemas };
      else {
        const { name, arguments: args } = body.params;
        if (name === 'account_balance') result = { credits: 1000 };
        if (name === 'images_upscale_modes_list') result = { modes: [{ id: 'creative', scales: [2, 4, 8, 16] }, { id: 'precision', scales: [2, 4] }] };
        if (name === 'simulate_cost') { assert.ok(args.tool_name); result = { credits: 8 }; }
        if (name === 'creations_request_upload') result = { upload_url: 'https://storage.test/private?signature=SECRET', upload_id: 'upload-1' };
        if (name === 'creations_finalize_upload') result = { creation_id: 'input-1' };
        if (name === 'images_upscale' || name === 'video_generate') result = { creation_id: 'output-1', status: 'pending' };
        if (name === 'creations_wait' || name === 'creation_status') result = { creation_id: 'output-1', status: 'completed' };
        if (name === 'creations_get') result = { creations: [{ id: 'output-1', download_url: 'https://storage.test/result.png' }] };
        assert.ok(result, name);
        result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      const payload = { jsonrpc: '2.0', id: body.id, result };
      if (sse) return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return json(payload);
    };
    const tokenFile = path.join(iso.root, 'data/magnific-auth.json');
    // Use a real ephemeral local fake server where the sandbox permits listening. The URL mapping leaves all
    // logical OAuth endpoints HTTPS, and no request ever leaves localhost. In port-restricted sandboxes the exact
    // same fake HTTP handler runs in memory so the protocol tests still exercise every request.
    let transport = fake;
    fakeServer = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const answer = await fake(req.headers['x-fake-target'], { method: req.method,
          headers: { ...req.headers, Authorization: req.headers.authorization }, ...(body ? { body } : {}) });
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch (err) { res.writeHead(500); res.end('Fake server assertion failed'); }
    });
    try {
      await new Promise((resolve, reject) => { fakeServer.once('error', reject); fakeServer.listen(0, '127.0.0.1', resolve); });
      const local = `http://127.0.0.1:${fakeServer.address().port}`;
      transport = (url, options = {}) => realFetch(local, { ...options, headers: { ...options.headers, 'x-fake-target': url } });
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      console.log('Local fake server: listen blocked by sandbox; testing the injected HTTP handler without sockets.');
    }
    const client = magnific.createMagnificClient({ fetchImpl: transport, store: magnific.createFileTokenStore(tokenFile), now: () => fakeNow });
    assert.equal(client.status().connected, false);
    assert.ok(!tools.toolDefinitions().some((t) => t.function.name.startsWith('magnific_')));
    const started = await client.startConnect({ redirectUri: redirect });
    state = new URL(started.verificationUri);
    assert.equal(state.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(state.searchParams.get('scope'), 'openid profile email mcp:custom-audience');
    await assert.rejects(client.completeConnect({ code: secretCode, state: 'bad' }), /state/);
    assert.equal(client.status().pending, true);
    await client.completeConnect({ code: secretCode, state: state.searchParams.get('state') });
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal(client.status().connected, true);
    await client.listTools();
    await client.listTools();
    assert.equal(calls.filter(([, o]) => o.body && JSON.parse(o.body.startsWith('{') ? o.body : '{}').method === 'tools/list').length, 1);
    rejectNext = true;
    await client.mcpCall('account_balance', {});
    assert.equal(refreshes, 1);
    fakeNow += 3600 * 1000;
    await client.listTools();
    assert.equal(refreshes, 2);
    sse = true;
    assert.deepEqual(JSON.parse(await client.mcpCall('account_balance', {})), { credits: 1000 });
    sse = false;
    Object.assign(magnific, client);
    const team = teams.createTeam({ name: 'Magnific restricted', budgetUsd: 10 });
    teams.addMembers(team.id, ['p@example.test']);
    hf.status = () => ({ connected: true });
    settings.setPreference('higgsfieldUsdPerCredit', 0.01);
    const participant = access.viewerOf({ kubleUser: 'p@example.test' });
    const guest = access.viewerOf({ kubleUser: 'g@example.test' });
    const internal = access.viewerOf({ kubleUser: 'i@staff.test' });
    assert.equal(access.higgsfieldAllowed(participant), true);
    for (const viewer of [participant, guest]) {
      assert.ok(!tools.toolDefinitions(viewer).some((t) => t.function.name.startsWith('magnific_')));
      for (const name of Object.keys(api.executors)) await assert.rejects(tools.executeTool({ user: viewer.email }, name, {}), (e) => e.code === 'FORBIDDEN_FOR_ROLE');
      assert.equal(registry.blockedFor(registry.get('magnific.upscale_image'), viewer), true);
      assert.ok(!assistant.visibleDescriptors(registry.registry, false, viewer).descriptors.some((d) => d.type.startsWith('magnific.')));
    }
    assert.equal(tools.toolDefinitions(internal).filter((t) => t.function.name.startsWith('magnific_')).length, 5);
    const schemaValidator = iso.load('lib/magnific-schema');
    assert.throws(() => schemaValidator.validate({ creation_id: 'x', mode: 'creative', scale: 3 }, schemas.find((t) => t.name === 'images_upscale').inputSchema));
    assert.throws(() => schemaValidator.validate({ bad: true }, { type: 'object', additionalProperties: false }));
    const { workflow } = await iso.load('lib/nodes/workflows-store').createWorkflowsStore().createWorkflow({ name: 'Magnific', owner: 'p@example.test', graph: {
      nodes: [{ id: 'up', type: 'magnific.upscale_image', params: {}, x: 0, y: 0 }], edges: []
    } });
    const engine = iso.load('lib/nodes/engine').createEngine();
    assert.equal((await engine.plan(workflow.id, { user: participant.email })).nodes.up.status, 'invalid', 'a missing image is invalid before any spend');
    const isolatedRegistry = registry.createRegistry();
    isolatedRegistry.register({ type: 'test.magnific', category: 'magnific', provider: 'magnific', paid: true,
      cost: { unit: 'credits', estimate: () => ({ credits: 8 }) }, outputs: [{ id: 'text', type: 'text' }],
      execute: async () => { throw new Error('Restricted executor must not run'); } });
    const wfStore = iso.load('lib/nodes/workflows-store').createWorkflowsStore({ registry: isolatedRegistry });
    const restrictedWorkflow = await wfStore.createWorkflow({ name: 'Restricted Magnific', owner: participant.email,
      graph: { nodes: [{ id: 'm', type: 'test.magnific', params: {}, x: 0, y: 0 }], edges: [] } });
    const restrictedEngine = iso.load('lib/nodes/engine').createEngine({ registry: isolatedRegistry, store: wfStore });
    const blocked = await restrictedEngine.plan(restrictedWorkflow.workflow.id, { user: participant.email });
    assert.deepEqual(blocked.blocked, [{ nodeId: 'm', feature: 'magnific' }]);
    assert.equal(blocked.totals.usd, 0, 'Magnific credits are not converted with the Higgsfield rate');
    await assert.rejects(restrictedEngine.start(restrictedWorkflow.workflow.id, { user: participant.email }), { code: 'FORBIDDEN_FOR_ROLE' });
    // Capture registry/options handlers and the admin connection routes without listening to an app port.
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
    iso.load('lib/nodes/routes').registerNodeRoutes(app, { engine, store: iso.load('lib/nodes/workflows-store').defaultStore, registry: registry.registry });
    const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, set() { return this; } });
    const registryResponse = response();
    await handlers.get('get /api/nodes/registry')({ kubleUser: participant.email, query: {}, params: {} }, registryResponse);
    assert.equal(registryResponse.body.nodeTypes.find((n) => n.type === 'magnific.upscale_image').restricted, true);
    const optionsResponse = response();
    await handlers.get('get /api/nodes/options/:source')({ kubleUser: participant.email, query: {}, params: { source: 'magnific-upscale-modes' } }, optionsResponse);
    assert.equal(optionsResponse.statusCode, 403);
    const server = iso.load('server.js');
    for (const [routePath, method] of [['/api/magnific/status', 'get'], ['/api/magnific/oauth/start', 'post'], ['/api/magnific/oauth/callback', 'get'], ['/api/magnific/disconnect', 'post']]) {
      const handler = server.app._router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;
      const res = response(); res.send = (body) => { res.body = body; return res; };
      await handler({ kubleUser: participant.email, query: {}, headers: {} }, res);
      assert.equal(res.statusCode, 403, routePath);
    }
    // Provider-aware graph and template checks also block a participant with Higgsfield enabled.
    assert.equal(iso.load('lib/nodes/templates').usesRestrictedNodes(workflow.graph, { viewer: participant }), true);
    assert.equal(registry.isRestricted(registry.get('magnific.upscale_image')), true);
    const session = await store.createSession();
    const image = await store.saveAsset(session.id, { kind: 'image', buffer: Buffer.from('fake input'), ext: '.png', prompt: 'input', cost: 0, model: 'test' });
    const output = Buffer.from('fake output');
    global.fetch = async (url, options) => {
      if (url === 'https://storage.test/private?signature=SECRET') { assert.equal(options.method, 'PUT'); assert.equal(options.headers.Authorization, undefined); return new Response(null, { status: 200 }); }
      throw new Error(`Network forbidden ${secretAccess} ${secretRefresh}`);
    };
    magnific.downloadResult = async (url) => { assert.equal(url, 'https://storage.test/result.png'); return { buffer: output, contentType: 'image/png', url }; };
    const ctx = { user: internal.email, sessionId: session.id, emit: () => {} };
    const result = await tools.executeTool(ctx, 'magnific_upscale_image', { asset_id: image.id, mode: 'creative', scale: 2 });
    assert.equal(result.job.credits, 8);
    await api.pollJob(session.id, result.job);
    const completed = (await store.readSession(session.id)).jobs[0];
    assert.equal(completed.status, 'completed');
    assert.equal(completed.resultAssetIds.length, 1);
    assert.deepEqual(await fs.readFile(path.join(store.sessionAssetDir(session.id), completed.file)), output);
    const rows = await costs.readCosts();
    assert.ok(rows.some((r) => r.billing === 'magnific' && r.credits === 8 && r.model === 'images_upscale' && r.cost === 0));
    await catalog.prepare({ mode: 'creative', scale: '2' });
    const input = await iso.load('lib/nodes/assets').valueFromAsset(session.id, image.id);
    await catalog.prepareEstimate({ mode: 'creative', scale: '2' }, { ...ctx, inputs: { image: input } });
    assert.deepEqual(catalog.estimate({ mode: 'creative', scale: '2' }, { inputs: { image: input } }), { credits: 8 });
    const planRegistry = registry.createRegistry();
    let planImage;
    planRegistry.register({ type: 'test.image_source', category: 'input', outputs: [{ id: 'image', type: 'image' }],
      cacheStamp: () => planImage?.assetId, cacheStampOutputs: () => ({ outputs: { image: planImage } }),
      execute: async () => ({ variants: [{ image: planImage }] }) });
    planRegistry.register(registry.get('magnific.upscale_image'));
    const planStore = iso.load('lib/nodes/workflows-store').createWorkflowsStore({ registry: planRegistry });
    const planWorkflow = (await planStore.createWorkflow({ name: 'Magnific price plan', owner: internal.email, graph: {
      nodes: [{ id: 'src', type: 'test.image_source', params: {}, x: 0, y: 0 },
        { id: 'up', type: 'magnific.upscale_image', params: { mode: 'creative', scale_factor: '2' }, x: 200, y: 0 }],
      edges: [{ id: 'e', from: { node: 'src', port: 'image' }, to: { node: 'up', port: 'image' } }] } })).workflow;
    const planAsset = await store.saveAsset(planWorkflow.sessionId, { kind: 'image', buffer: Buffer.from('plan image'), ext: '.png', prompt: 'input', cost: 0, model: 'test' });
    planImage = await iso.load('lib/nodes/assets').valueFromAsset(planWorkflow.sessionId, planAsset.id);
    const priceEngine = iso.load('lib/nodes/engine').createEngine({ registry: planRegistry, store: planStore });
    const pricedPlan = await priceEngine.plan(planWorkflow.id, { user: internal.email });
    assert.equal(pricedPlan.totals.credits, 8, 'the real Upscale node plan reports simulated credits');
    assert.deepEqual(pricedPlan.nodes.up.estimate, { credits: 8 });
    const deniedPlan = await priceEngine.plan(planWorkflow.id, { user: participant.email });
    assert.equal(deniedPlan.nodes.up.status, 'unavailable');
    assert.deepEqual(deniedPlan.blocked, [{ nodeId: 'up', feature: 'magnific' }]);
    assert.throws(() => catalog.check('precision', 16));
    assert.deepEqual(api.creationIds({ id: 'space-1', type: 'space', status: 'ready' }), []);
    assert.equal(api.creditsOf({ balance: { credits: 999 } }), null);
    await assert.rejects(api.checkedCall('images_upscale', { creation_id: 'input-1', mode: 'creative', scale: 3 }), /inputSchema/);
    const badClient = magnific.createMagnificClient({ fetchImpl: async () => { throw new Error(`${secretAccess} ${secretRefresh} signed-url-SECRET`); },
      store: { read: () => JSON.parse(require('node:fs').readFileSync(tokenFile, 'utf8')) } });
    await assert.rejects(badClient.mcpCall('account_balance', {}), (err) => !err.message.includes('SECRET'));
    const unsafeDiscovery = magnific.createMagnificClient({ fetchImpl: async () => json({ authorization_servers: ['http://unsafe.test'] }), store: { read: () => null } });
    await assert.rejects(unsafeDiscovery.startConnect({ redirectUri: redirect }));
    await client.disconnect();
    assert.equal(client.status().connected, false);
    await assert.rejects(fs.stat(tokenFile), { code: 'ENOENT' });
    await assert.rejects(client.listTools());
    assert.ok(!logs.join('\n').includes(secretAccess));
    assert.ok(!logs.join('\n').includes(secretRefresh));
    console.log('test-magnific.js: ok');
  } finally {
    if (fakeServer?.listening) await new Promise((resolve) => { fakeServer.closeAllConnections?.(); fakeServer.close(resolve); });
    global.fetch = realFetch; console.warn = realWarn; await iso.cleanup();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
