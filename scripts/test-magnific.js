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
    // Argument names and shapes follow the live Magnific MCP (tools/list, 2026-10-22; docs/magnific-mcp-tools.md).
    const obj = (properties, required = []) => ({ type: 'object', properties, required });
    const id = { type: 'string' };
    const schemas = Object.entries({
      account_balance: obj({}), images_upscale_modes_list: obj({}),
      simulate_cost: obj({ tool: { type: 'string', enum: ['images_upscale', 'images_remove_background', 'images_relight', 'video_upscale'] }, arguments: { type: 'object' } }, ['tool']),
      creations_request_upload: obj({ mimeType: { type: 'string', enum: ['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg'] }, count: { type: 'integer' } }, ['mimeType']),
      creations_finalize_upload: obj({ fileName: { type: 'string' }, path: { type: 'string' }, visible: { type: 'boolean' } }, ['fileName']),
      images_upscale: obj({ creationIdentifier: id, mode: { type: 'string', enum: ['creative', 'ultra-sublime', 'ultra-photo', 'ultra-denoiser', 'ultra'] }, scale: { type: 'string', enum: ['2x', '4x', '8x', '16x'] } }, ['creationIdentifier']),
      images_remove_background: obj({ creationIdentifier: id, folderReference: id }, ['creationIdentifier']),
      images_relight: obj({ creationIdentifier: id, resolution: { type: 'string', enum: ['1k', '2k'] }, lights: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object',
        properties: { azimuth: { type: 'integer', enum: [-135, -90, -45, 0, 45, 90, 135, 180] }, elevation: { type: 'integer', enum: [-90, -45, 0, 45, 90] },
          intensity: { type: 'integer', minimum: 1, maximum: 10 }, type: { type: 'string', enum: ['neutral', 'gel'] }, color: { type: 'string' } }, required: ['azimuth', 'elevation'], additionalProperties: false } } }, ['creationIdentifier', 'lights']),
      creations_wait: obj({ identifiers: { type: 'array', items: id }, timeoutSeconds: { type: 'integer', minimum: 0, maximum: 55 } }, ['identifiers']),
      creation_status: obj({ creationIdentifier: id }, ['creationIdentifier']), creations_get: obj({ creationIdentifier: id, identifiers: { type: 'array', items: id } }),
      video_generate: obj({ prompt: { type: 'string' }, slug: { type: 'string' }, duration: { type: 'number' }, resolution: { type: 'string' }, aspectRatio: { type: 'string' },
        withSoundEffects: { type: 'boolean' }, keyframes: { type: 'object' }, references: { type: 'array', items: { type: 'object' } } })
    }).map(([name, inputSchema]) => ({ name, description: `Fake ${name}`, inputSchema }));
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
        let listing = null;
        if (name === 'account_balance') result = { credits: 1000 };
        // The live server answers these two as an indented listing instead of JSON.
        if (name === 'images_upscale_modes_list') listing = 'modes[2]:\n  - id: creative\n    params:\n      scale:\n        enum[4]: 2x,4x,8x,16x\n  - id: ultra-photo';
        if (name === 'simulate_cost') { assert.ok(args.tool); result = { credits: 8, isUnlimited: false, certainty: 'exact' }; }
        if (name === 'creations_request_upload') { assert.ok(args.mimeType); result = { proxyUploadUrl: 'https://storage.test/private?signature=SECRET', path: 'temp-files/in.png', mimeType: args.mimeType }; }
        if (name === 'creations_finalize_upload') { assert.equal(args.path, 'temp-files/in.png'); assert.equal(args.visible, false); listing = 'identifier: input-1\ntool: upload\nstatus: completed\nurl: "https://storage.test/in.png"'; }
        if (['images_upscale', 'images_remove_background', 'images_relight', 'video_generate'].includes(name)) result = { creationIdentifier: 'output-1', status: 'queued', source: { creationIdentifier: args.creationIdentifier } };
        if (name === 'creations_wait') result = { results: args.identifiers.map((i) => ({ identifier: i, status: 'completed', results: { url: 'https://storage.test/result.png' } })), allTerminal: true };
        if (name === 'creation_status') result = { creationIdentifier: args.creationIdentifier, status: 'completed', results: { url: 'https://storage.test/result.png' } };
        if (name === 'refuse_me') {
          const payload = { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: `Too many concurrent video generations, see https://storage.test/x?sig=SECRET for ${'a'.repeat(40)}` }] } };
          return json(payload);
        }
        if (listing !== null) result = listing;
        assert.ok(result, name);
        result = { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
      for (const name of Object.keys(api.executors)) await assert.rejects(tools.executeTool({ user: viewer.email, nodeView: true }, name, {}), (e) => e.code === 'FORBIDDEN_FOR_ROLE');
      assert.equal(registry.blockedFor(registry.get('magnific.upscale_image'), viewer), true);
      assert.ok(!assistant.visibleDescriptors(registry.registry, false, viewer).descriptors.some((d) => d.type.startsWith('magnific.')));
    }
    assert.equal(tools.toolDefinitions(internal).filter((t) => t.function.name.startsWith('magnific_')).length, 5);
    const schemaValidator = iso.load('lib/magnific-schema');
    assert.throws(() => schemaValidator.validate({ creationIdentifier: 'x', mode: 'creative', scale: 3 }, schemas.find((t) => t.name === 'images_upscale').inputSchema));
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
      if (url === 'https://storage.test/private?signature=SECRET') { assert.equal(options.method, 'PUT'); assert.equal(options.headers['Content-Type'], 'image/png'); assert.equal(options.headers.Authorization, undefined); return new Response(null, { status: 200 }); }
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
    await assert.rejects(api.checkedCall('images_upscale', { creationIdentifier: 'input-1', mode: 'creative', scale: 3 }), /inputSchema/);
    // The live mode list is not JSON: the snapshot of the real modes stays in use, and precision modes stop at 2x.
    assert.deepEqual((await catalog.load()).map((m) => m.value), catalog.FALLBACK.map((m) => m.value));
    assert.throws(() => catalog.check('ultra-photo', 4));
    catalog.check('ultra-sublime', 16);
    assert.deepEqual(api.creationIds('identifier: abc123\nstatus: completed'), ['abc123']);
    // The other media nodes run through the node-only tool with the live argument names.
    await assert.rejects(tools.executeTool(ctx, 'magnific_media', { tool: 'images_remove_background', asset_id: image.id }), /node/i);
    const nodeCtx = { ...ctx, nodeView: true };
    const relight = await tools.executeTool(nodeCtx, 'magnific_media', { tool: 'images_relight', asset_id: image.id,
      arguments: registry.get('magnific.relight') && iso.load('lib/nodes/nodes-magnific').MEDIA_NODES.find((n) => n.type === 'magnific.relight').args({ azimuth: '-45', elevation: '45', intensity: 5, light_type: 'neutral', resolution: '2k' }) });
    assert.deepEqual(relight.job.creationIds, ['output-1'], 'the echoed input creation is not a result');
    assert.equal(relight.job.credits, 8);
    await assert.rejects(tools.executeTool(nodeCtx, 'magnific_media', { tool: 'images_relight', asset_id: image.id, arguments: { lights: [{ azimuth: 10, elevation: 0 }] } }), /inputSchema/);
    // Magnific Video: a first frame goes in as start keyframe, the settings of the node as they are.
    await assert.rejects(tools.executeTool(ctx, 'magnific_video', { prompt: 'x', duration: 5 }), /node/i);
    const videoFull = await api.videoArgs(nodeCtx, { slug: 'bytedance-seedance-pro-2.5', prompt: 'A dancer', duration: 5, resolution: '720p', withSoundEffects: false, first_frame: image.id });
    assert.deepEqual(videoFull.keyframes, { start: { type: 'image', url: 'input-1' } });
    assert.equal(videoFull.references, undefined);
    assert.equal(videoFull.slug, 'bytedance-seedance-pro-2.5');
    const video = await tools.executeTool(nodeCtx, 'magnific_video', { slug: 'bytedance-seedance-pro-2.5', prompt: 'A dancer', duration: 5, resolution: '720p' });
    assert.deepEqual(video.job.creationIds, ['output-1']);
    assert.equal(video.job.kind, 'video');
    const videoNodes = iso.load('lib/nodes/nodes-magnific');
    assert.equal(videoNodes.clipSeconds({ model: 'bytedance-seedance-pro-2.5', duration: 5 }, { duration: 7.2 }), 8, 'the audio decides, rounded up');
    assert.equal(videoNodes.clipSeconds({ model: 'bytedance-seedance-pro-2.5', duration: 5 }, { duration: 2 }), 4, 'at least 4 s');
    assert.equal(videoNodes.clipSeconds({ model: 'bytedance-seedance-pro-2.0', duration: 5 }, { duration: 40 }), 15, 'at most what the model makes');
    assert.deepEqual(registry.get('magnific.video').validate({ model: 'bytedance-seedance-fast-2.0', resolution: '1080p', duration: 5 }).map((i) => i.code), ['magnific_settings']);
    assert.equal(registry.blockedFor(registry.get('magnific.video'), participant), true);
    for (const def of iso.load('lib/nodes/nodes-magnific').MEDIA_NODES) {
      assert.equal(registry.blockedFor(registry.get(def.type), participant), true, def.type);
      assert.equal(registry.get(def.type).paid, true);
    }
    const badClient = magnific.createMagnificClient({ fetchImpl: async () => { throw new Error(`${secretAccess} ${secretRefresh} signed-url-SECRET`); },
      store: { read: () => JSON.parse(require('node:fs').readFileSync(tokenFile, 'utf8')) } });
    await assert.rejects(badClient.mcpCall('account_balance', {}), (err) => !err.message.includes('SECRET'));
    await assert.rejects(client.mcpCall('refuse_me', {}), (err) => /rejected the request: Too many concurrent video generations/.test(err.message)
      && !err.message.includes('SECRET') && !err.message.includes('a'.repeat(40)));
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
