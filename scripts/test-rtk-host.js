'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createRtkHost } = require('../lib/rtk-host');
const { registerRtkHostRoutes } = require('../lib/rtk-host-routes');
const RESOURCE = 'https://host.example/mcp';
const ISSUER = 'https://host.example/oauth';
const CALLBACK = 'https://director.example/api/website-host/oauth/callback';
const OWNER = 'admin@example.com';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const hasCode = (code, status) => err => err.code === code && err.status === status;

function provider() {
  const state = { calls: [], refreshes: 0, registrations: 0, revocations: 0, refusal: 0, access: crypto.randomUUID(), refresh: crypto.randomUUID(), failRefresh: false, sse: false, failure: null, resourcePatch: {}, metadataPatch: {}, fallback: false };
  state.fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    // Only synthetic provider URLs can ever enter this fake transport.
    assert.equal(u.hostname, 'host.example');
    state.calls.push({ url, method: options.method || 'GET', signal: options.signal });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (state.fallback && u.pathname.endsWith('/mcp')) return json({}, 404);
      return json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['sites:read', 'sites:write'], ...state.resourcePatch });
    }
    if (u.pathname.includes('.well-known/oauth-authorization-server')) return json({ issuer: ISSUER, authorization_endpoint: ISSUER + '/authorize', token_endpoint: ISSUER + '/token', registration_endpoint: ISSUER + '/register', revocation_endpoint: ISSUER + '/revoke', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['offline_access'], ...state.metadataPatch });
    if (u.pathname.endsWith('/register')) {
      state.registrations++;
      assert.equal(JSON.parse(options.body).token_endpoint_auth_method, 'none');
      return json({ client_id: 'public-client', token_endpoint_auth_method: 'none' });
    }
    if (u.pathname.endsWith('/token')) {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('resource'), RESOURCE);
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        if (state.failRefresh) return json({}, 400);
      } else {
        assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), state.challenge);
      }
      return json({ access_token: state.access, refresh_token: state.refresh, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/revoke')) { state.revocations++; return new Response(null, { status: 200 }); }
    assert.equal(url, RESOURCE);
    if (state.failure) throw new Error(state.failure);
    if (state.refusal) { state.refusal--; return json({}, 401); }
    assert.equal(options.headers.Authorization, 'Bearer ' + state.access);
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, 200, { 'mcp-session-id': 'session' });
    assert.equal(options.headers['Mcp-Session-Id'], 'session');
    assert.equal(options.headers['MCP-Protocol-Version'], '2025-03-26');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(request.method, 'tools/call');
    assert.deepEqual(request.params.arguments, {});
    let result = { structuredContent: { ok: true } };
    if (request.params.name === 'json') result = { content: [{ type: 'text', text: '{"answer":42}' }] };
    if (request.params.name === 'plain') result = { content: [{ type: 'image' }, { type: 'text', text: 'Bereit' }] };
    if (request.params.name === 'error') result = { isError: true, content: [{ type: 'text', text: '  Anfrage\n  abgelehnt\t' + 'x'.repeat(350) }] };
    if (request.params.name === 'large') result = { content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }] };
    const reply = { jsonrpc: '2.0', id: 2, result };
    if (!state.sse) return json(reply);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"notification"}\n\ndata: ' + JSON.stringify(reply) + '\r\n\r\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return state;
}

// Exercise the real Express stack in process: no listening socket or external transport.
async function request(app, url, { method = 'GET', email = OWNER, origin = 'https://director.example', host = 'localhost:3111' } = {}) {
  const req = { method, url, originalUrl: url, headers: { origin, host }, kubleUser: email };
  const headers = {};
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      getHeader(name) { return headers[name.toLowerCase()]; },
      removeHeader(name) { delete headers[name.toLowerCase()]; },
      end(body) {
        const result = { status: this.statusCode, headers, text: String(body || '') };
        if (String(headers['content-type']).includes('application/json')) result.body = JSON.parse(result.text);
        resolve(result);
      }
    };
    app.handle(req, res, reject);
  });
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-host-test-'));
  let n = 0, time = 1000000;
  const make = (fake = provider(), extra = {}) => ({ fake, host: createRtkHost({ directory: path.join(root, String(n++)), fetchImpl: fake.fetchImpl, now: () => time, env: { WEBSITE_HOST_MCP_URL: RESOURCE }, ...extra }) });
  async function login(host, fake, email = OWNER, redirect = CALLBACK) {
    const url = new URL((await host.start(email, redirect)).authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), RESOURCE);
    assert.equal(url.searchParams.get('scope'), 'sites:read sites:write offline_access');
    assert.ok(url.searchParams.get('state').length >= 32);
    fake.challenge = url.searchParams.get('code_challenge');
    return { state: url.searchParams.get('state'), code: crypto.randomUUID(), iss: ISSUER };
  }
  try {
    for (const value of ['', 'http://host.example/mcp', 'ftp://host.example', 'https://user:password@host.example/mcp', 'https://host.example/mcp?setting=x']) {
      const { host } = make(undefined, { env: { WEBSITE_HOST_MCP_URL: value }, config: {} });
      assert.deepEqual(host.status(), { enabled: false, connected: false, connectedAt: null, connectedBy: null });
      await assert.rejects(host.start(OWNER, CALLBACK), hasCode('HOST_DISABLED', 404));
      await assert.rejects(host.call('connected_site'), hasCode('HOST_DISABLED', 404));
      await assert.rejects(host.disconnect(), hasCode('HOST_DISABLED', 404));
    }
    assert.equal(make(undefined, { env: {}, config: { websiteHost: { mcpUrl: RESOURCE } } }).host.enabled(), true);
    for (const value of ['http://localhost:3111/mcp', 'http://127.0.0.1:3111/mcp']) assert.equal(make(undefined, { env: { WEBSITE_HOST_MCP_URL: value } }).host.enabled(), true);
    for (const metadataPatch of [{ token_endpoint: 'https://foreign.example/token' }, { registration_endpoint: null }, { code_challenge_methods_supported: ['plain'] }, { token_endpoint_auth_methods_supported: ['client_secret_basic'] }, { issuer: 'https://foreign.example' }, { code_challenge_methods_supported: 'S256' }, { token_endpoint_auth_methods_supported: 'none' }]) {
      const fake = provider(); fake.metadataPatch = metadataPatch;
      const { host } = make(fake);
      await assert.rejects(host.start(OWNER, CALLBACK), hasCode('HOST_UNAVAILABLE', 502));
      assert.equal(fake.registrations, 0);
    }
    const mismatched = provider(); mismatched.resourcePatch = { resource: 'https://host.example/other' };
    await assert.rejects(make(mismatched).host.start(OWNER, CALLBACK), hasCode('HOST_UNAVAILABLE', 502));
    const fallback = provider(); fallback.fallback = true;
    await login(make(fallback).host, fallback);
    assert.ok(fallback.calls.some(call => call.url === 'https://host.example/.well-known/oauth-protected-resource'));

    const directory = path.join(root, 'connection');
    const env = { WEBSITE_HOST_MCP_URL: RESOURCE };
    const { host, fake } = make(undefined, { directory, env });
    await assert.rejects(host.call('connected_site'), hasCode('HOST_NOT_CONNECTED', 409));
    const pending = await login(host, fake);
    await assert.rejects(host.complete('other@example.com', pending), hasCode('HOST_AUTH', 401));
    await assert.rejects(host.complete(OWNER, { ...pending, state: 'wrong' }), hasCode('HOST_AUTH', 401));
    await host.complete(OWNER, pending);
    await assert.rejects(host.complete(OWNER, pending), hasCode('HOST_AUTH', 401));
    assert.deepEqual(host.status(), { enabled: true, connected: true, connectedAt: new Date(time).toISOString(), connectedBy: OWNER });
    for (const file of fs.readdirSync(directory)) {
      const content = fs.readFileSync(path.join(directory, file), 'utf8');
      assert.ok(!content.includes(fake.access)); assert.ok(!content.includes(fake.refresh));
      assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    }
    const reloaded = make(fake, { directory, env }).host;
    assert.equal(reloaded.status().connectedBy, OWNER);
    assert.deepEqual(await reloaded.call('connected_site'), { ok: true });
    assert.deepEqual(await host.call('json'), { answer: 42 });
    assert.deepEqual(await host.call('plain'), { text: 'Bereit' });
    fake.sse = true;
    assert.deepEqual(await host.call('connected_site'), { ok: true });
    fake.sse = false;
    await assert.rejects(host.call('error'), err => hasCode('HOST_REFUSED', 502)(err) && err.message === 'Der Website-Host konnte diese Anfrage nicht ausführen.' && err.detail.startsWith('Anfrage abgelehnt ') && err.detail.length === 300 && !/\s{2}/.test(err.detail));
    await assert.rejects(host.call('large'), hasCode('HOST_UNAVAILABLE', 502));
    for (const key of ['site_token', 'voucher', 'code']) {
      const before = fake.calls.length;
      assert.throws(() => host.call('connected_site', { nested: { [key]: 'forbidden' } }), TypeError);
      assert.equal(fake.calls.length, before);
    }
    assert.throws(() => host.call('connected_site', { toJSON: () => ({ site_token: 'forbidden' }) }), TypeError);
    time += 3600000;
    await Promise.all([host.call('connected_site'), host.call('connected_site')]);
    assert.equal(fake.refreshes, 1);
    fake.refusal = 1;
    await host.call('connected_site');
    assert.equal(fake.refreshes, 2);
    fake.refusal = 2;
    await assert.rejects(host.call('connected_site'), hasCode('HOST_AUTH', 401));
    assert.equal(fake.refreshes, 3);
    fake.failRefresh = true; fake.refusal = 1;
    await assert.rejects(host.call('connected_site'), hasCode('HOST_AUTH', 401));
    fake.failRefresh = false; fake.refusal = 0;
    fake.failure = fake.access;
    await assert.rejects(host.call('connected_site'), err => hasCode('HOST_UNAVAILABLE', 502)(err) && !err.message.includes(fake.access));
    fake.failure = null;
    env.WEBSITE_HOST_MCP_URL = 'https://host.example/changed';
    assert.equal(host.status().connected, false);
    await assert.rejects(host.call('connected_site'), hasCode('HOST_NOT_CONNECTED', 409));
    env.WEBSITE_HOST_MCP_URL = RESOURCE;
    const expired = await login(host, fake); time += 600001;
    await assert.rejects(host.complete(OWNER, expired), hasCode('HOST_AUTH', 401));
    const wrongIssuer = await login(host, fake);
    await assert.rejects(host.complete(OWNER, { ...wrongIssuer, iss: 'https://foreign.example' }), hasCode('HOST_AUTH', 401));
    const cancelled = await login(host, fake);
    await host.disconnect();
    assert.equal(fake.revocations, 1);
    assert.equal(fs.existsSync(path.join(directory, 'connection.json')), false);
    await assert.rejects(host.complete(OWNER, cancelled), hasCode('HOST_AUTH', 401));
    assert.equal(host.status().connected, false);
    await host.complete(OWNER, await login(host, fake));

    const app = express();
    registerRtkHostRoutes(app, { host, env: { AUTH_WHOAMI_URL: 'https://login.example/me', ADMIN_EMAILS: OWNER, PUBLIC_BASE_URL: 'https://director.example' } });
    assert.equal((await request(app, '/api/website-host/status', { email: null })).status, 401);
    const normal = await request(app, '/api/website-host/status', { email: 'person@example.com' });
    assert.deepEqual(normal.body, { enabled: true, connected: true, canManage: false });
    assert.equal(normal.headers['cache-control'], 'no-store');
    assert.equal((await request(app, '/api/website-host/status')).body.connectedBy, OWNER);
    for (const [method, endpoint] of [['POST', 'connect'], ['GET', 'oauth/callback'], ['DELETE', 'auth']]) assert.equal((await request(app, '/api/website-host/' + endpoint, { method, email: 'person@example.com' })).status, 403);
    assert.equal((await request(app, '/api/website-host/connect', { method: 'POST', origin: 'https://foreign.example' })).status, 403);
    const routeStart = await request(app, '/api/website-host/connect', { method: 'POST' });
    const auth = new URL(routeStart.body.authorizationUrl); fake.challenge = auth.searchParams.get('code_challenge');
    const callback = await request(app, '/api/website-host/oauth/callback?state=' + auth.searchParams.get('state') + '&code=synthetic');
    assert.equal(callback.status, 303); assert.equal(callback.headers.location, 'https://director.example/?websiteHost=connected');
    const failed = await request(app, '/api/website-host/oauth/callback?error=provider-private-text');
    assert.equal(failed.status, 303); assert.equal(failed.headers.location, 'https://director.example/?websiteHost=failed');
    assert.equal((await request(app, '/api/website-host/auth', { method: 'DELETE' })).body.connected, false);

    const disabled = express(); registerRtkHostRoutes(disabled, { host: make(undefined, { env: {}, config: {} }).host, env: {} });
    assert.deepEqual((await request(disabled, '/api/website-host/status')).body, { enabled: false, connected: false, canManage: true });
    for (const [method, endpoint] of [['POST', 'connect'], ['GET', 'oauth/callback'], ['DELETE', 'auth']]) {
      const response = await request(disabled, '/api/website-host/' + endpoint, { method });
      assert.equal(response.status, 404); assert.equal(response.body.code, 'HOST_DISABLED');
    }
    const local = express(); registerRtkHostRoutes(local, { host, env: {} });
    assert.equal((await request(local, '/api/website-host/connect', { method: 'POST', email: null, host: 'foreign.example' })).status, 503);
    for (const name of ['localhost:3111', '127.0.0.1:3111']) {
      const response = await request(local, '/api/website-host/connect', { method: 'POST', email: null, host: name });
      assert.equal(response.status, 200);
      assert.equal(new URL(response.body.authorizationUrl).searchParams.get('redirect_uri'), 'http://' + name + '/api/website-host/oauth/callback');
    }
    // Registration is bound to both the resource and the callback address.
    assert.ok(fake.registrations >= 3);

    // Register the complete app without starting its server or the whoami stub.
    const { createIsolatedApp } = require('./support/isolated-app');
    const { ROUTE_RULES, PARTICIPANT_RULES } = require('./support/route-rules');
    const isolated = await createIsolatedApp({ loadServer: false, env: { WEBSITE_HOST_MCP_URL: '' }, config: { websiteHost: {} } });
    try {
      const fullApp = isolated.load('server.js').app;
      const routes = fullApp._router.stack.filter(layer => layer.route).flatMap(layer => Object.keys(layer.route.methods).map(method => method.toUpperCase() + ' ' + layer.route.path)).sort();
      assert.deepEqual(routes, Object.keys(ROUTE_RULES).sort());
      assert.deepEqual(routes, Object.keys(PARTICIPANT_RULES).sort());
    } finally { await isolated.cleanup(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('test-rtk-host.js: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
