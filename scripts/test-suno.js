'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSuno, ISSUER } = require('../lib/suno');
const { registerSunoRoutes } = require('../lib/suno-routes');
const express = require('express');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-test-'));
  let time = 1000000;
  let refreshes = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('.well-known')) return json({ issuer: ISSUER, authorization_endpoint: ISSUER + '/authorize/', token_endpoint: ISSUER + '/token/', registration_endpoint: ISSUER + '/register/' });
    if (url.endsWith('/register/')) return json({ client_id: 'public-client', token_endpoint_auth_method: 'none' });
    if (url.endsWith('/token/')) {
      const params = new URLSearchParams(options.body);
      if (params.get('grant_type') === 'refresh_token') refreshes++;
      return json({ access_token: params.get('code') || params.get('refresh_token'), refresh_token: params.get('code') || params.get('refresh_token'), expires_in: 3600 });
    }
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') return json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26' } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { authorization: options.headers.Authorization } } });
  };
  const suno = createSuno({ directory, fetchImpl, now: () => time });
  const a = 'alice@example.com', b = 'bob@example.com';
  async function connect(owner, code) {
    const start = await suno.start(owner, 'https://director.example/api/suno/oauth/callback');
    const url = new URL(start.authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    return { state: url.searchParams.get('state'), code };
  }
  try {
    assert.throws(() => suno.status(null), /anmelden/);
    const login = await connect(a, 'alice-secret');
    await assert.rejects(suno.complete(b, login), /ungültig/);
    await suno.complete(a, login);
    await assert.rejects(suno.complete(a, login), /ungültig/);
    assert.equal(suno.status(a).connected, true);
    assert.equal(suno.status(b).connected, false);
    await suno.complete(b, await connect(b, 'bob-secret'));
    const results = await Promise.all([suno.mcpCall(a, 'account-me'), suno.mcpCall(b, 'account-me')]);
    assert.equal(results[0].structuredContent.authorization, 'Bearer alice-secret');
    assert.equal(results[1].structuredContent.authorization, 'Bearer bob-secret');
    for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.json'))) assert.ok(!fs.readFileSync(path.join(directory, file), 'utf8').includes('alice-secret'));
    time += 3600000;
    await Promise.all([suno.mcpCall(a, 'account-me'), suno.mcpCall(a, 'account-me')]);
    assert.equal(refreshes, 1);
    const pending = await connect(a, 'replacement');
    await suno.disconnect(a);
    await assert.rejects(suno.complete(a, pending), /ungültig/);
    await assert.rejects(suno.mcpCall(a, 'account-me'), /verbinden/);
    assert.equal(suno.status(b).connected, true);
    const expired = await connect(a, 'expired'); time += 600001;
    await assert.rejects(suno.complete(a, expired), /abgelaufen/);
    const wrongIssuer = await connect(a, 'bad');
    await assert.rejects(suno.complete(a, { ...wrongIssuer, iss: 'https://evil.example' }), /nicht abgeschlossen/);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.kubleUser = req.get('test-user'); next(); });
    registerSunoRoutes(app, { suno, env: { AUTH_WHOAMI_URL: 'https://login.example/me', PUBLIC_BASE_URL: 'https://director.example' } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal((await fetch(base + '/api/suno/status')).status, 401);
      const status = await fetch(base + '/api/suno/status?owner=alice@example.com', { headers: { 'test-user': b } });
      assert.equal((await status.json()).connected, true);
      assert.equal(status.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(base + '/api/suno/auth', { method: 'DELETE', headers: { 'test-user': b, origin: 'https://evil.example' } })).status, 403);
      assert.equal(suno.status(b).connected, true);
      assert.equal((await fetch(base + '/api/suno/auth', { method: 'DELETE', headers: { 'test-user': b, origin: 'https://director.example' } })).status, 200);
      assert.equal(suno.status(b).connected, false);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('test-suno.js: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
