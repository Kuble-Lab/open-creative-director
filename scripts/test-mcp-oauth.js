'use strict';

// Real loopback HTTP requests, an injected clock and temp stores; no external login, DNS or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const access = require('../lib/access');
const { createMcp } = require('../lib/mcp');
const { createKeyStore } = require('../lib/mcp/keys');
const { createPolicyStore, DEFAULT_PARTICIPANT } = require('../lib/mcp/policy');
const { registerKeyRoutes } = require('../lib/mcp/key-routes');
const { createOAuth, clientIp } = require('../lib/mcp/oauth');
const { publicAddress, createClientStore } = require('../lib/mcp/oauth-clients');
const ADMIN = 'admin@example.com', PARTICIPANT = 'p@external.example', GUEST = 'g@external.example';
const ISSUER = 'https://creator.example/supercomputer', RESOURCE = `${ISSUER}/mcp`, REDIRECT = 'https://client.example/callback?keep=1';
const verifier = 'a'.repeat(43), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
let checks = 0;
function check(value, message) { checks++; assert.ok(value, message); }
function decode(text) { return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function form(html) { return Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [decode(m[1]), decode(m[2])])); }
async function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-oauth-'));
  let at = Date.parse('2026-11-14T12:00:00Z'), activeTeam = true;
  const env = { AUTH_WHOAMI_URL: 'https://login.example/whoami', PUBLIC_BASE_URL: ISSUER, ADMIN_EMAILS: ADMIN, INTERNAL_EMAIL_DOMAINS: 'staff.example', ...options.env };
  const now = () => at;
  access.useTeamsStore({ membershipsOf: (email) => activeTeam && email === PARTICIPANT ? [{ teamId: 't1' }] : [], isKnown: (email) => email === PARTICIPANT, unreadable: () => false });
  const policy = createPolicyStore({ file: path.join(dir, 'policy.json') });
  const keys = createKeyStore({ file: path.join(dir, 'keys.json'), env, now, policy, viewerFor: (email) => {
    const v = access.viewerOf({ kubleUser: email }, env);
    return v.admin || ['participant', 'internal'].includes(v.kind) ? v : null;
  } });
  const accounting = { serialize: (_id, fn) => fn(), monthSpentUsd: async () => 0, monthUsage: async () => ({ spentUsd: 0, reservedUsd: 0 }), activeCount: () => 0 };
  const service = { registry: { get: () => ({ category: 'higgsfield' }) }, estimate: async () => ({ workflowId: 'wf1', name: 'HF', rev: 1, steps: [{ id: 'h', label: 'HF', type: 'higgsfield-image', runs: true, paid: true, usd: 1 }], totals: { usd: 1, credits: 0, unknownNodes: 0 }, blockers: [] }) };
  const mcp = createMcp({ keys, env, accounting, service, sweepUploads: false, oauth: { dataDir: dir, now, ...options.oauth } });
  const app = express();
  mcp.mount(app);
  app.use((req, _res, next) => { req.kubleUser = req.headers['x-person'] || 'lokal'; next(); });
  app.use(access.createUnconfirmedGuard(env));
  mcp.oauth.mountLoggedIn(app);
  app.use(express.json({ limit: '64kb' }));
  registerKeyRoutes(app, { keys, env, oauth: mcp.oauth });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', data, person = ADMIN, headers = {}, ip } = {}) {
    const h = { ...(person ? { 'x-person': person } : {}), ...headers };
    if (ip) h['x-real-ip'] = ip;
    let body;
    if (data !== undefined) {
      const json = route === '/oauth/register' || route.startsWith('/api/') || route === '/mcp';
      h['Content-Type'] ||= json ? 'application/json' : 'application/x-www-form-urlencoded';
      body = json ? JSON.stringify(data) : new URLSearchParams(data).toString();
    }
    const response = await fetch(`${base}${route}`, { method, headers: h, body, redirect: 'manual' });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
    return { status: response.status, headers: response.headers, text, json };
  }
  async function register(input = {}, ip = crypto.randomBytes(4).join('.')) {
    const r = await request('/oauth/register', { method: 'POST', data: { redirect_uris: [REDIRECT], client_name: 'Claude test', ...input }, ip });
    assert.equal(r.status, 201, r.text); return r.json;
  }
  function params(client, extra = {}) { return { response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'opaque state', ...extra }; }
  const authorize = (p, opts = {}) => request(`/oauth/authorize?${new URLSearchParams(p)}`, opts);
  const consent = (data, opts = {}) => request('/oauth/authorize', { method: 'POST', data: { ...data, decision: 'connect', right: 'start' }, ...opts });
  async function code(client, opts = {}) {
    const r = await authorize(params(client, opts.params), { person: opts.person || ADMIN });
    assert.equal(r.status, 200, r.text);
    const result = await consent(form(r.text), { person: opts.person || ADMIN, ...(opts.consent || {}) });
    assert.equal(result.status, 302, result.text);
    return new URL(result.headers.get('location')).searchParams.get('code');
  }
  const exchange = (client, code, extra = {}) => request('/oauth/token', { method: 'POST', data: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier, code, ...extra } });
  const refresh = (client, token, extra = {}) => request('/oauth/token', { method: 'POST', data: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, ...extra } });
  const rpc = (token, method = 'tools/list', params) => request('/mcp', { method: 'POST', person: null, headers: token ? { Authorization: `Bearer ${token}` } : {}, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } });
  return { dir, env, keys, policy, mcp, request, register, params, authorize, consent, code, exchange, refresh, rpc, now, advance: (ms) => { at += ms; }, archive: () => { activeTeam = false; },
    close: async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); fs.rmSync(dir, { recursive: true, force: true }); access.useTeamsStore(null); } };
}
async function discovery(h) {
  let r = await h.rpc();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer realm="mcp", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
  r = await h.rpc('bad'); check(r.headers.get('www-authenticate').includes('error="invalid_token"'));
  for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    r = await h.request(route, { person: null }); assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('cache-control'), 'no-store');
    if (route.includes('protected-resource')) { assert.equal(r.json.resource, RESOURCE); assert.deepEqual(r.json.authorization_servers, [ISSUER]); }
    else { assert.equal(r.json.issuer, ISSUER); assert.equal(r.json.authorization_endpoint, `${ISSUER}/oauth/authorize`); assert.equal(r.json.token_endpoint, `${ISSUER}/oauth/token`); assert.equal(r.json.registration_endpoint, `${ISSUER}/oauth/register`); assert.equal(r.json.revocation_endpoint, `${ISSUER}/oauth/revoke`); assert.deepEqual(r.json.code_challenge_methods_supported, ['S256']); check(r.json.client_id_metadata_document_supported); }
    checks++;
  }
  for (const route of ['/oauth/register', '/oauth/token', '/oauth/revoke']) { r = await h.request(route, { method: 'OPTIONS', headers: { Origin: 'https://client.example' } }); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*'); checks++; }
}
async function registration(h) {
  const valid = await h.register({ client_name: '<img src=x onerror=alert(1)>', unknown: 'ignored' });
  check(/^oc_[a-f0-9]{32}$/.test(valid.client_id)); check(!valid.client_secret); assert.equal(valid.token_endpoint_auth_method, 'none');
  for (const uris of [['http://public.example/cb'], ['https://client.example/cb#fragment'], ['https://user:pass@client.example/cb'], ['https://@client.example/cb'], Array(6).fill(REDIRECT), ['javascript:alert(1)'], ['app://callback'], [], ['https://client.example/' + 'x'.repeat(512)], ['https://client.example/cb#']]) {
    const r = await h.request('/oauth/register', { method: 'POST', data: { redirect_uris: uris }, ip: crypto.randomBytes(4).join('.') }); assert.equal(r.status, 400); assert.equal(r.json.error, 'invalid_redirect_uri'); checks++;
  }
  for (const metadata of [{ client_name: 'x\nboom' }, { client_name: 'x'.repeat(81) }, { grant_types: ['password'] }, { response_types: ['token'] }, { token_endpoint_auth_method: 'client_secret_basic' }]) {
    const r = await h.request('/oauth/register', { method: 'POST', data: { redirect_uris: [REDIRECT], ...metadata }, ip: crypto.randomBytes(4).join('.') }); assert.equal(r.status, 400); assert.equal(r.json.error, 'invalid_client_metadata'); checks++;
  }
  for (const uri of ['http://127.0.0.1:1234/cb', 'http://[::1]:1234/cb', 'http://localhost:1234/cb']) {
    const c = await h.register({ redirect_uris: [uri] });
    const r = await h.authorize(h.params(c, { redirect_uri: uri.replace(':1234', ':4321') })); assert.equal(r.status, 200); checks++;
  }
  for (let i = 0; i < 11; i++) {
    const r = await h.request('/oauth/register', { method: 'POST', data: { redirect_uris: [REDIRECT] }, ip: '203.0.113.1' }); assert.equal(r.status, i === 10 ? 429 : 201); if (i === 10) check(Number(r.headers.get('retry-after')) > 0);
  }
  return valid;
}
async function authorization(h, client) {
  for (const uri of ['https://client.example/else?keep=1', REDIRECT + '&extra=1', 'https://evil.example/callback?keep=1', 'https://CLIENT.example/callback?keep=1', 'https://client.example/Callback?keep=1']) {
    const r = await h.authorize(h.params(client, { redirect_uri: uri })); assert.equal(r.status, 400); check(!r.headers.get('location'));
  }
  let r = await h.authorize(h.params(client, { client_id: 'unknown' })); assert.equal(r.status, 400); check(!r.headers.get('location'));
  for (const extra of [{ code_challenge: '' }, { code_challenge_method: 'plain' }, { response_type: 'token' }, { resource: 'https://wrong.example/mcp' }]) {
    r = await h.authorize(h.params(client, extra)); assert.equal(r.status, 302); const url = new URL(r.headers.get('location')); check(url.searchParams.has('error')); assert.equal(url.searchParams.get('iss'), ISSUER); assert.equal(url.searchParams.get('state'), 'opaque state');
  }
  r = await h.authorize(h.params(client), { person: null }); assert.equal(r.status, 401); check(!r.headers.get('location'));
  r = await h.authorize(h.params(client), { person: GUEST }); assert.equal(r.status, 403);
  assert.equal((await h.request('/api/mcp/policy', { method: 'PUT', data: { participant: { ...DEFAULT_PARTICIPANT, enabled: false } } })).status, 200);
  r = await h.authorize(h.params(client), { person: PARTICIPANT }); assert.equal(r.status, 403); checks++;
  assert.equal((await h.request('/api/mcp/policy', { method: 'PUT', data: { participant: { ...DEFAULT_PARTICIPANT } } })).status, 200);
  r = await h.authorize(h.params(client)); assert.equal(r.status, 200); check(r.text.includes('&lt;img')); check(!r.text.includes('<img')); check(r.text.includes('client.example')); check(!r.text.includes('<script'));
  for (const name of ['content-security-policy', 'x-frame-options', 'referrer-policy', 'cache-control']) check(r.headers.get(name));
  assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/client.example/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const f = form(r.text);
  for (const patch of [{ csrf: '' }, { csrf: f.csrf.slice(0, -1) + (f.csrf.endsWith('A') ? 'B' : 'A') }, { state: 'changed' }]) { const result = await h.consent({ ...f, ...patch }); assert.equal(result.status, 403); checks++; }
  r = await h.consent(f, { person: PARTICIPANT }); assert.equal(r.status, 403);
  r = await h.consent(f, { headers: { Origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  r = await h.consent(f, { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(r.status, 403);
  r = await h.consent(f, { data: { ...f, decision: 'cancel' } }); assert.equal(r.status, 302); assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'access_denied');
  h.advance(600001); r = await h.consent(f); assert.equal(r.status, 403); checks++;
  for (const lang of ['de', 'en', 'es']) { r = await h.authorize(h.params(client), { headers: { 'Accept-Language': lang } }); assert.equal(r.status, 200); check(r.text.includes(`lang="${lang}"`)); }
  r = await h.authorize(h.params(client, { scope: 'mcp:read unknown' })); check(!r.text.includes('value="start" selected')); check(r.text.includes('value="read"'));
}
async function tokens(h, client) {
  const c = await h.code(client);
  for (const patch of [{ code_verifier: 'b'.repeat(43) }, { client_id: 'wrong' }, { redirect_uri: REDIRECT + '&wrong=1' }, { resource: 'https://other.example' }]) { const r = await h.exchange(client, c, patch); assert.equal(r.status, 400); assert.equal(r.json.error, 'invalid_grant'); checks++; }
  let r = await h.exchange(client, c, { resource: ISSUER }); assert.equal(r.status, 200); const first = r.json;
  assert.equal(first.expires_in, 3600); assert.equal(first.scope, 'mcp:read mcp:start'); assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await h.rpc(first.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); assert.equal(r.status, 200); check(r.json.result.serverInfo);
  r = await h.rpc(first.access_token); assert.equal(r.status, 200); assert.equal(r.json.result.tools.length, 9); checks++;
  assert.equal(h.keys.authenticate(first.access_token).ok, false);
  const manual = h.keys.create({ owner: ADMIN, name: 'manual', right: 'read' });
  r = await h.rpc(manual.secret); assert.equal(r.status, 200); assert.equal(r.json.result.tools.length, 5);
  check(!h.mcp.oauth.tokens.authenticate(manual.secret, RESOURCE).ok);
  r = await h.refresh(client, first.refresh_token, { scope: 'mcp:read' }); assert.equal(r.status, 200); const second = r.json;
  assert.notEqual(second.refresh_token, first.refresh_token); r = await h.rpc(second.access_token); assert.equal(r.json.result.tools.length, 5);
  r = await h.rpc(second.access_token, 'tools/call', { name: 'run_workflow', arguments: { workflow_id: 'wf1', max_usd: 0 } });
  assert.equal(r.status, 403); check(r.headers.get('www-authenticate').includes('insufficient_scope'));
  r = await h.refresh(client, second.refresh_token, { scope: 'mcp:read mcp:start' }); assert.equal(r.status, 400);
  r = await h.refresh(client, second.refresh_token); assert.equal(r.status, 200); const third = r.json;
  r = await h.refresh(client, first.refresh_token); assert.equal(r.status, 400);
  r = await h.rpc(third.access_token); assert.equal(r.status, 401); check(r.headers.get('www-authenticate').includes('invalid_token'));
  r = await h.refresh(client, third.refresh_token); assert.equal(r.status, 400);
  const expiredCode = await h.code(client); h.advance(61000); r = await h.exchange(client, expiredCode); assert.equal(r.status, 400); checks++;
  const twice = await h.code(client); const original = (await h.exchange(client, twice)).json;
  r = await h.exchange(client, twice); assert.equal(r.status, 400); r = await h.rpc(original.access_token); assert.equal(r.status, 401); checks++;
  const issued = (await h.exchange(client, await h.code(client))).json;
  h.advance(3600001); r = await h.rpc(issued.access_token); assert.equal(r.status, 401); check(r.headers.get('www-authenticate').includes('invalid_token'));
  const renewed = (await h.refresh(client, issued.refresh_token)).json; check(renewed.access_token);
  r = await h.request('/oauth/revoke', { method: 'POST', data: { token: renewed.refresh_token, client_id: client.client_id } }); assert.equal(r.status, 200);
  r = await h.rpc(renewed.access_token); assert.equal(r.status, 401); r = await h.refresh(client, renewed.refresh_token); assert.equal(r.status, 400); checks++;
  for (const token of ['', 'unknown']) { r = await h.request('/oauth/revoke', { method: 'POST', data: { token } }); assert.equal(r.status, 200); checks++; }
  const last = (await h.exchange(client, await h.code(client))).json;
  const listing = (await h.request('/api/mcp/keys')).json;
  assert.deepEqual(listing.oauth, { enabled: true, issuer: ISSUER });
  const connection = listing.keys.find((k) => k.kind === 'oauth' && k.status === 'active'); check(connection.clientName); check(!Object.hasOwn(connection, 'hash'));
  r = await h.request(`/api/mcp/keys/${connection.id}`, { method: 'PATCH', data: { maxRunUsd: 0.5 } }); assert.equal(r.status, 200); assert.equal(r.json.key.maxRunUsd, 0.5);
  r = await h.request(`/api/mcp/keys/${connection.id}`, { method: 'DELETE' }); assert.equal(r.status, 200);
  assert.equal((await h.rpc(last.access_token)).status, 401); assert.equal((await h.refresh(client, last.refresh_token)).status, 400);
  const saved = (await h.exchange(client, await h.code(client))).json;
  const restarted = createOAuth({ keys: h.keys, env: h.env, dataDir: h.dir, now: h.now });
  check(restarted.tokens.authenticate(saved.access_token, RESOURCE).ok, 'tokens survive restart');
  check(!restarted.tokens.authenticate(saved.access_token, `${ISSUER}/other`).ok, 'audience bound');
  const oldCode = await h.code(client); check(!restarted.tokens.exchange({ code: oldCode, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }, RESOURCE));
}
async function roles(h, client) {
  let issued = (await h.exchange(client, await h.code(client, { person: PARTICIPANT }))).json;
  let connection = h.keys.list({ owner: PARTICIPANT }).find((k) => k.status === 'active');
  assert.equal(connection.maxRunUsd, 1); assert.equal(connection.maxMonthUsd, 5); assert.equal(Date.parse(connection.expiresAt) - Date.parse(connection.createdAt), 30 * 86400000); checks++;
  let r = await h.rpc(issued.access_token, 'tools/call', { name: 'estimate_run', arguments: { workflow_id: 'wf1' } });
  check(r.text.includes('Higgsfield is not available'), r.text);
  r = await h.rpc(issued.access_token, 'tools/call', { name: 'run_workflow', arguments: { workflow_id: 'wf1', max_usd: 1 } });
  assert.equal(r.json.result.isError, true); check(r.text.includes('Higgsfield is not available'));
  assert.equal((await h.request('/api/mcp/policy', { method: 'PUT', data: { participant: { ...DEFAULT_PARTICIPANT, defaultRunUsd: 0.25, maxRunUsd: 0.25, defaultMonthUsd: 1, maxMonthUsd: 1 } } })).status, 200);
  r = await h.rpc(issued.access_token, 'tools/call', { name: 'estimate_run', arguments: { workflow_id: 'wf1' } }); check(r.text.includes('per run set for this key'));
  const auth = h.mcp.oauth.tokens.authenticate(issued.access_token, RESOURCE); assert.equal(auth.key.maxRunUsd, 0.25); assert.equal(auth.key.maxMonthUsd, 1);
  const replaced = (await h.exchange(client, await h.code(client, { person: PARTICIPANT }))).json;
  assert.equal((await h.rpc(issued.access_token)).status, 401); assert.equal(h.keys.list({ owner: PARTICIPANT }).filter((k) => k.status === 'active').length, 1); checks++;
  h.keys.create({ name: 'one', owner: PARTICIPANT, right: 'read' }); h.keys.create({ name: 'two', owner: PARTICIPANT, right: 'read' });
  const c2 = await h.register();
  const page = await h.authorize(h.params(c2), { person: PARTICIPANT });
  r = await h.consent(form(page.text), { person: PARTICIPANT }); assert.equal(r.status, 400); check(!r.headers.get('location'));
  // Replacing the same client works at the combined key/connection limit.
  await h.code(client, { person: PARTICIPANT });
  assert.equal(h.keys.list({ owner: PARTICIPANT }).filter((k) => k.status === 'active').length, 3);
  issued = (await h.exchange(client, await h.code(client, { person: PARTICIPANT }))).json;
  h.archive(); assert.equal((await h.rpc(issued.access_token)).status, 403); checks++;
  check(!h.keys.authenticate(replaced.access_token).ok);
}
async function files(h) {
  for (const file of fs.readdirSync(h.dir)) {
    assert.equal(fs.statSync(path.join(h.dir, file)).mode & 0o777, 0o600);
    check(!/ocd_(?:at|rt|ac)_/.test(fs.readFileSync(path.join(h.dir, file), 'utf8')), 'no plaintext credentials on disk');
  }
}
async function consentReuse() {
  const h = await harness();
  try {
    const client = await h.register();
    const page = await h.authorize(h.params(client)), fields = form(page.text);
    const consent = async (right = 'start', ip) => h.consent(fields, { data: { ...fields, decision: 'connect', right }, ip });
    const codeOf = (r) => new URL(r.headers.get('location')).searchParams.get('code');
    const firstCode = codeOf(await consent());
    const first = (await h.exchange(client, firstCode)).json;
    const original = h.keys.list()[0];
    h.keys.update(original.id, { name: 'Edited', maxRunUsd: 0.1, maxMonthUsd: 0.5 });
    h.advance(1000);
    const pendingCode = codeOf(await consent());
    const newCode = codeOf(await consent('read'));
    assert.equal(h.keys.list().length, 1);
    const current = h.keys.list()[0];
    assert.equal(current.id, original.id);
    assert.equal(current.createdAt, original.createdAt);
    assert.equal(Date.parse(current.expiresAt), h.now() + 90 * 86400000);
    assert.equal(current.right, 'read'); assert.equal(current.name, client.client_name); assert.equal(current.clientName, client.client_name);
    assert.equal(current.maxRunUsd, 2); assert.equal(current.maxMonthUsd, 20);
    assert.equal((await h.rpc(first.access_token)).status, 401);
    assert.equal((await h.refresh(client, first.refresh_token)).json.error, 'invalid_grant');
    assert.equal((await h.exchange(client, pendingCode)).json.error, 'invalid_grant');
    assert.equal((await h.exchange(client, firstCode)).json.error, 'invalid_grant');
    const fresh = await h.exchange(client, newCode);
    assert.equal(fresh.status, 200); assert.equal(fresh.json.scope, 'mcp:read');
    assert.equal((await h.rpc(fresh.json.access_token)).status, 200); checks++;
    // Repeated submission of the same valid consent counts by person, independently of client IP.
    for (let i = 3; i < 10; i++) assert.equal((await consent('read', `198.51.100.${i}`)).status, 302);
    const limited = await consent('read', '198.51.100.200');
    assert.equal(limited.status, 429); assert.match(limited.headers.get('content-type'), /text\/html/);
    assert.equal(Number(limited.headers.get('retry-after')), 59);
    assert.equal(h.keys.list().length, 1); checks++;
    h.advance(60000); assert.equal((await consent()).status, 302);
    // Renewal must also work when the global record cap is already full.
    const savedKeys = JSON.parse(fs.readFileSync(h.keys.file));
    const full = { ...savedKeys, keys: [...savedKeys.keys] };
    for (let i = 1; i < 2000; i++) full.keys.push({ ...savedKeys.keys[0], id: `k${i.toString(16).padStart(16, '0')}`, revokedAt: new Date(h.now()).toISOString(), revokedBy: ADMIN });
    fs.writeFileSync(h.keys.file, JSON.stringify(full));
    assert.equal((await consent()).status, 302);
    assert.equal(h.keys.list().length, 2000);
    assert.equal(h.keys.list().filter((k) => k.status === 'active')[0].id, original.id);
    fs.writeFileSync(h.keys.file, JSON.stringify(savedKeys)); checks++;
    // A revoked/expired predecessor must not be changed or reused.
    h.keys.revoke(original.id, ADMIN);
    const revoked = h.keys.get(original.id);
    await h.code(client);
    assert.deepEqual(h.keys.get(original.id), revoked);
    const active = h.keys.list().find((k) => k.status === 'active');
    h.advance(91 * 86400000);
    const expired = h.keys.get(active.id);
    // Keep DCR retention separate from the expired-connection reuse check.
    h.mcp.oauth.clients.touch(client.client_id);
    await h.code(client);
    assert.deepEqual(h.keys.get(active.id), expired);
    assert.equal(h.keys.list().length, 3); checks++;
  } finally { await h.close(); }
}
async function rotationLimits() {
  const h = await harness();
  try {
    const client = await h.register();
    let current = (await h.exchange(client, await h.code(client))).json;
    const initial = current, consumed = [], accesses = [current.access_token];
    const records = () => JSON.parse(fs.readFileSync(h.mcp.oauth.tokens.file)).tokens;
    for (let i = 0; i < 25; i++) {
      consumed.push(current.refresh_token);
      const r = await h.refresh(client, current.refresh_token);
      assert.equal(r.status, 200); current = r.json; accesses.push(current.access_token);
      const saved = records();
      assert.equal(saved.filter((t) => t.type === 'refresh' && t.used).length, Math.min(i + 1, 20));
      assert.equal(saved.filter((t) => t.type === 'access').length, Math.min(i + 2, 5));
    }
    assert.equal((await h.rpc(initial.access_token)).status, 401);
    for (const token of accesses.slice(-5)) assert.equal((await h.rpc(token)).status, 200);
    assert.equal((await h.refresh(client, consumed[0])).json.error, 'invalid_grant');
    assert.equal((await h.rpc(current.access_token)).status, 200); checks++;
    // Replays of retained digests still revoke after restarting the token store.
    const restarted = createOAuth({ keys: h.keys, env: h.env, dataDir: h.dir, now: h.now });
    assert.equal(restarted.tokens.refresh({ client_id: client.client_id, refresh_token: consumed.at(-1) }, RESOURCE), null);
    assert.equal((await h.rpc(current.access_token)).status, 401);
    assert.equal(h.keys.list()[0].status, 'revoked');
    assert.equal(records().length, 0); checks++;
  } finally { await h.close(); }
}
async function refreshLimits() {
  const h = await harness();
  try {
    const client = await h.register();
    let current = (await h.exchange(client, await h.code(client))).json;
    for (let i = 0; i < 30; i++) {
      const r = await h.refresh(client, current.refresh_token);
      assert.equal(r.status, 200); current = r.json;
    }
    const before = fs.readFileSync(h.mcp.oauth.tokens.file, 'utf8');
    const r = await h.refresh(client, current.refresh_token);
    assert.equal(r.status, 429); assert.equal(r.json.error, 'temporarily_unavailable');
    assert.equal(Number(r.headers.get('retry-after')), 3600);
    assert.equal(fs.readFileSync(h.mcp.oauth.tokens.file, 'utf8'), before);
    assert.equal(h.keys.list()[0].status, 'active');
    const other = await h.register();
    const independent = await h.exchange(other, await h.code(other));
    assert.equal((await h.refresh(other, independent.json.refresh_token)).status, 200);
    h.advance(3600000);
    const retry = await h.refresh(client, current.refresh_token);
    assert.equal(retry.status, 200); check(retry.json.refresh_token !== current.refresh_token);
  } finally { await h.close(); }
}
async function tokenPruning() {
  const h = await harness();
  try {
    const clients = [], connections = [];
    for (let i = 0; i < 3; i++) {
      const client = await h.register(); clients.push(client);
      await h.exchange(client, await h.code(client));
      connections.push(h.keys.list().find((k) => k.clientId === client.client_id));
    }
    h.keys.revoke(connections[0].id, ADMIN);
    const file = JSON.parse(fs.readFileSync(h.keys.file));
    file.keys = file.keys.filter((k) => k.id !== connections[1].id);
    file.keys.find((k) => k.id === connections[2].id).expiresAt = new Date(h.now() - 1).toISOString();
    fs.writeFileSync(h.keys.file, JSON.stringify(file));
    const next = await h.register();
    assert.equal((await h.exchange(next, await h.code(next))).status, 200);
    const saved = JSON.parse(fs.readFileSync(h.mcp.oauth.tokens.file)).tokens;
    assert.equal(saved.length, 2);
    check(saved.every((t) => !connections.some((c) => c.id === t.keyId)));
  } finally { await h.close(); }
}
async function disabled() {
  for (const env of [{ MCP_OAUTH: 'off' }, { AUTH_WHOAMI_URL: '' }, { PUBLIC_BASE_URL: 'http://public.example/prefix' }]) {
    const h = await harness({ env });
    try {
      assert.equal((await h.request('/.well-known/oauth-protected-resource')).status, 404);
      assert.equal((await h.rpc()).headers.get('www-authenticate'), 'Bearer realm="mcp"');
      assert.equal((await h.request('/oauth/token', { method: 'POST', data: {} })).status, 404); checks++;
    } finally { await h.close(); }
  }
  const h = await harness({ env: { PUBLIC_BASE_URL: 'http://127.0.0.1:4567/prefix' } });
  try { assert.equal((await h.request('/.well-known/oauth-protected-resource')).status, 200); checks++; } finally { await h.close(); }
}
async function cimd() {
  let fetches = 0, address = '8.8.8.8', mode = 'valid';
  const h = await harness({ oauth: {
    lookup: async () => address === 'mixed' ? [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] : [{ address, family: address.includes(':') ? 6 : 4 }],
    fetchImpl: async (url, options) => {
      fetches++; assert.equal(options.redirect, 'error'); assert.equal(options.headers.Accept, 'application/json');
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } });
      const value = { client_id: mode === 'wrong' ? 'https://wrong.example/doc' : url, client_name: 'Metadata client', redirect_uris: [REDIRECT] };
      if (mode === 'nameless') delete value.client_name;
      return new Response(mode === 'big' ? ' '.repeat(65537) : JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    }
  } });
  try {
    const client = { client_id: 'https://metadata.example/client.json', redirect_uris: [REDIRECT] };
    let r = await h.authorize(h.params(client), { person: null }); assert.equal(r.status, 401); assert.equal(fetches, 0);
    r = await h.authorize(h.params(client)); assert.equal(r.status, 200); assert.equal(fetches, 1);
    r = await h.authorize(h.params(client)); assert.equal(r.status, 200); assert.equal(fetches, 1); checks++;
    let issued = (await h.exchange(client, await h.code(client))).json; assert.equal((await h.rpc(issued.access_token)).status, 200);
    for (const ip of ['mixed', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.2', '224.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
      address = ip; const count = fetches;
      r = await h.authorize(h.params({ ...client, client_id: `https://metadata.example/${checks++}.json` })); assert.equal(r.status, 400); assert.equal(fetches, count); check(!r.headers.get('location'));
    }
    address = '8.8.8.8';
    for (const value of ['wrong', 'redirect', 'big', 'nameless']) { mode = value; r = await h.authorize(h.params({ ...client, client_id: `https://metadata.example/${value}.json` })); assert.equal(r.status, 400); check(!r.headers.get('location')); }
    for (const url of ['https://metadata.example/', 'https://metadata.example:444/doc', 'http://metadata.example/doc', 'https://user@metadata.example/doc', 'https://@metadata.example/doc', 'https://metadata.example/doc#']) { const n = fetches; r = await h.authorize(h.params({ ...client, client_id: url })); assert.equal(r.status, 400); assert.equal(fetches, n); checks++; }
    check(publicAddress('2606:4700:4700::1111')); check(publicAddress('8.8.8.8')); check(!publicAddress('0.0.0.0'));
    await files(h);
  } finally { await h.close(); }
}
async function metadataTimeout() {
  const h = await harness({ oauth: { lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => new Promise(() => {}) } });
  try {
    const client = { client_id: 'https://slow.example/client.json', redirect_uris: [REDIRECT] };
    const start = Date.now();
    const r = await h.authorize(h.params(client));
    assert.equal(r.status, 400); check(Date.now() - start >= 4900 && Date.now() - start < 7000, 'metadata request bounded by five seconds');
  } finally { await h.close(); }
}
async function cimdConcurrency() {
  let fetches = 0, fail = false;
  let release, started;
  let gate = new Promise((resolve) => { release = resolve; });
  let began = new Promise((resolve) => { started = resolve; });
  const h = await harness({ oauth: {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url) => {
      fetches++; started(); await gate;
      return new Response(JSON.stringify({ client_id: url, client_name: 'CIMD', redirect_uris: [REDIRECT] }), { status: fail ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    }
  } });
  try {
    const store = h.mcp.oauth.clients;
    const same = 'https://metadata.example/shared.json';
    const batch = Array.from({ length: 32 }, () => store.resolve(same));
    await began; assert.equal(fetches, 1);
    release();
    const clients = await Promise.all(batch);
    check(clients.every((c) => c === clients[0])); assert.equal(fetches, 1);
    gate = new Promise((resolve) => { release = resolve; });
    const four = Array.from({ length: 4 }, (_, i) => store.resolve(`https://metadata.example/parallel-${i}.json`));
    // The fifth URL is rejected immediately, while all four preceding requests remain blocked.
    const fifth = { client_id: 'https://metadata.example/fifth.json', redirect_uris: [REDIRECT] };
    const rejected = await h.authorize(h.params(fifth));
    assert.equal(rejected.status, 400); assert.match(rejected.headers.get('content-type'), /text\/html/);
    assert.equal(fetches, 5); check(!rejected.headers.get('location'));
    release(); await Promise.all(four);
    assert.equal((await h.authorize(h.params(fifth))).status, 200); assert.equal(fetches, 6);
    fail = true;
    const bad = 'https://metadata.example/failed.json';
    await assert.rejects(store.resolve(bad)); assert.equal(fetches, 7);
    await assert.rejects(store.resolve(bad)); assert.equal(fetches, 7);
    h.advance(59999); await assert.rejects(store.resolve(bad)); assert.equal(fetches, 7);
    h.advance(1); fail = false; assert.equal((await store.resolve(bad)).id, bad); assert.equal(fetches, 8); checks++;
    // Negative cache eviction is bounded independently of the successful metadata cache.
    fail = true;
    for (let i = 0; i < 501; i++) await assert.rejects(store.resolve(`https://metadata.example/fail-${i}.json`));
    const count = fetches;
    await assert.rejects(store.resolve('https://metadata.example/fail-500.json')); assert.equal(fetches, count);
    await assert.rejects(store.resolve('https://metadata.example/fail-0.json')); assert.equal(fetches, count + 1);
    assert.equal((await store.resolve(same)).id, same); assert.equal(fetches, count + 1); checks++;
  } finally { release(); await h.close(); }
}
async function authorizeLimits() {
  const h = await harness();
  try {
    const client = await h.register();
    for (let i = 0; i < 31; i++) {
      const r = await h.authorize(h.params(client), { ip: `198.51.100.${i}` });
      assert.equal(r.status, i === 30 ? 429 : 200);
      if (i === 30) { assert.equal(Number(r.headers.get('retry-after')), 60); assert.match(r.headers.get('content-type'), /text\/html/); }
    }
    assert.equal((await h.authorize(h.params(client), { person: PARTICIPANT })).status, 200);
    h.advance(60000); assert.equal((await h.authorize(h.params(client))).status, 200); checks++;
  } finally { await h.close(); }
}
async function endpointLimits() {
  const h = await harness();
  try {
    for (const route of ['/oauth/token', '/oauth/revoke']) {
      for (let i = 0; i < 61; i++) {
        const r = await h.request(route, { method: 'POST', data: {}, ip: '203.0.113.90' });
        assert.equal(r.status, i === 60 ? 429 : route.endsWith('revoke') ? 200 : 400);
        if (i === 60) check(Number(r.headers.get('retry-after')) > 0);
      }
    }
    for (let i = 0; i < 201; i++) {
      const r = await h.request('/oauth/register', { method: 'POST', data: { redirect_uris: [REDIRECT] }, ip: `198.51.100.${i}` });
      assert.equal(r.status, i === 200 ? 429 : 201);
      if (i === 200) check(Number(r.headers.get('retry-after')) > 0);
    }
    h.advance(86400001);
    const c = await h.register();
    const r = await h.authorize(h.params(c, { scope: 'mcp:read' }));
    const issued = await h.consent(form(r.text), { data: { ...form(r.text), right: 'start', decision: 'connect' } });
    assert.equal(issued.status, 400); checks++;
    let result = await h.request('/oauth/token', { method: 'POST', data: { padding: 'x'.repeat(65537) } }); assert.equal(result.status, 400); checks++;
    result = await h.request('/oauth/register', { method: 'POST', data: { padding: 'x'.repeat(65537) }, ip: '192.0.2.230' }); assert.equal(result.status, 400); checks++;
    result = await h.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, data: {} }); assert.equal(result.status, 400); checks++;
    result = await h.request('/oauth/token', { method: 'POST', data: { client_id: c.client_id, grant_type: 'password' } }); assert.equal(result.json.error, 'unsupported_grant_type'); checks++;
    // A malformed or unknown revocation is indistinguishable from a successful revocation.
    result = await h.request('/oauth/revoke', { method: 'POST', data: {}, headers: { 'Content-Type': 'text/plain' } }); assert.equal(result.status, 200); checks++;
  } finally { await h.close(); }
}
async function storage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-clients-'));
  try {
    let time = Date.now(), connected = new Set();
    const store = createClientStore({ file: path.join(dir, 'clients.json'), now: () => time, hasConnection: (id) => connected.has(id) });
    let first;
    for (let i = 0; i < 500; i++) { const c = store.register({ redirect_uris: [REDIRECT] }); first ||= c; time++; }
    connected.add(first.id); store.register({ redirect_uris: [REDIRECT] });
    check(await store.resolve(first.id));
    assert.equal(JSON.parse(fs.readFileSync(store.file)).clients.length, 500);
    time += 31 * 86400000; store.register({ redirect_uris: [REDIRECT] });
    assert.equal(JSON.parse(fs.readFileSync(store.file)).clients.length, 2); checks++;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-real-ip': 'fake' } }), '203.0.113.5');
  assert.equal(clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': 'spoofed, actual' } }), 'actual'); checks++;
}
async function main() {
  const logs = [], originals = {};
  for (const level of ['log', 'warn', 'error', 'info']) { originals[level] = console[level]; console[level] = (...args) => logs.push(args.join(' ')); }
  try {
    const h = await harness();
    try { await discovery(h); const client = await registration(h); await authorization(h, client); await tokens(h, client); await roles(h, client); await files(h); }
    finally { await h.close(); }
    await consentReuse(); await rotationLimits(); await refreshLimits(); await tokenPruning();
    await disabled(); await cimd(); await metadataTimeout(); await cimdConcurrency(); await authorizeLimits(); await endpointLimits(); await storage();
    check(!/ocd_(?:at|rt|ac)_/.test(logs.join('\n')), 'no credential in logs');
  } finally { Object.assign(console, originals); }
  console.log(`OAuth offline HTTP/security: ${checks} checks passed`);
  console.log('test-mcp-oauth.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
