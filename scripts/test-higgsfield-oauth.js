'use strict';

// Higgsfield OAuth login (authorization code + PKCE): discovery, dynamic registration, authorize URL, callback checks,
// token exchange and storage, refresh with rotation, legacy device tokens and the two server routes.
// No network: every HTTP call goes through a mocked fetch.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const higgsfield = require('../lib/higgsfield');
const { createFileTokenStore, createHiggsfieldClient, DISCONNECTED_MESSAGE, OAUTH_FALLBACK, OAUTH_PENDING_TTL_MS } = higgsfield;
const { app } = require('../server');

const ISSUER = 'https://clerk.higgsfield.ai';
const REDIRECT = 'https://creator.example/supercomputer/api/higgsfield/oauth/callback';
const REDIRECT_LOCAL = 'http://localhost:3111/api/higgsfield/oauth/callback';
const SECRET_CODE = 'auth-code-SECRET-1234';
const SECRET_ACCESS = 'access-token-SECRET-5678';
const SECRET_REFRESH = 'refresh-token-SECRET-9012';
const SECRET_ID_TOKEN = 'id-token-SECRET-3456';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RESOURCE_METADATA = {
  resource: 'https://mcp.higgsfield.ai/mcp',
  authorization_servers: [ISSUER, 'https://fnf-device-auth.higgsfield.ai'],
  scopes_supported: ['openid', 'email', 'offline_access'],
  higgsfield_auth_hints: {
    options: [
      { method: 'device_code', authorization_server: 'https://fnf-device-auth.higgsfield.ai' },
      { method: 'authorization_code_pkce', authorization_server: ISSUER }
    ]
  }
};
const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true
};

// Mock of Higgsfield and Clerk. `handlers` may override single endpoints (return undefined to fall through).
function createMockFetch(overrides = {}) {
  const calls = [];
  let registrations = 0;
  async function fetchImpl(url, options = {}) {
    const method = options.method || 'GET';
    const rawBody = options.body;
    const record = { url: String(url), method, headers: options.headers || {}, rawBody };
    if (rawBody && (options.headers || {})['Content-Type'] === 'application/json') record.json = JSON.parse(rawBody);
    if (rawBody && (options.headers || {})['Content-Type'] === 'application/x-www-form-urlencoded') {
      record.form = Object.fromEntries(new URLSearchParams(rawBody));
    }
    calls.push(record);
    const custom = overrides[record.url] ?? overrides[`${method} ${record.url}`];
    if (custom) {
      const result = await custom(record);
      if (result !== undefined) return result;
    }
    if (record.url === 'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp') return jsonResponse(RESOURCE_METADATA);
    if (record.url === `${ISSUER}/.well-known/oauth-authorization-server`) return jsonResponse(AS_METADATA);
    if (record.url === AS_METADATA.registration_endpoint) {
      registrations += 1;
      return jsonResponse({ client_id: `client-${registrations}`, redirect_uris: record.json.redirect_uris, grant_types: ['authorization_code'] }, 201);
    }
    if (record.url === AS_METADATA.token_endpoint) {
      if (record.form.grant_type === 'authorization_code') {
        return jsonResponse({
          access_token: SECRET_ACCESS,
          expires_in: 86400,
          refresh_token: SECRET_REFRESH,
          id_token: SECRET_ID_TOKEN,
          scope: 'openid email offline_access',
          token_type: 'Bearer'
        });
      }
      return jsonResponse({ access_token: 'access-refreshed', expires_in: 86400, refresh_token: 'refresh-rotated', token_type: 'Bearer' });
    }
    throw new Error(`unexpected request ${method} ${record.url}`);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function parseAuthorizeUrl(uri) {
  const url = new URL(uri);
  return { base: `${url.origin}${url.pathname}`, params: Object.fromEntries(url.searchParams), raw: uri };
}

function newClient(directory, name, { fetchImpl, time = { now: 1_000_000 } } = {}) {
  const file = path.join(directory, `${name}.json`);
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => time.now,
    fetchImpl: fetchImpl || createMockFetch()
  });
  return { client, file, time };
}

async function testDiscoveryRegistrationAndAuthorizeUrl(directory) {
  const fetchImpl = createMockFetch();
  const { client, time } = newClient(directory, 'authorize', { fetchImpl });

  const result = await client.startConnect({ redirectUri: REDIRECT });
  assert.equal(result.expiresIn, 600);
  const { base, params, raw } = parseAuthorizeUrl(result.verificationUri);
  assert.equal(base, `${ISSUER}/oauth/authorize`);
  assert.equal(params.response_type, 'code');
  assert.equal(params.client_id, 'client-1');
  assert.equal(params.redirect_uri, REDIRECT);
  assert.equal(params.scope, 'openid email offline_access');
  assert.equal(params.code_challenge_method, 'S256');
  assert.equal(params.resource, 'https://mcp.higgsfield.ai/mcp');
  assert.match(params.code_challenge, /^[A-Za-z0-9_-]{43}$/, 'S256 challenge is a 43 character base64url string');
  assert.match(params.state, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(!/scope=openid\+/.test(raw), 'scope is percent-encoded, not form-encoded');
  assert.deepEqual(client.status(), { connected: false, refreshExpiresAt: null, pending: true });

  // discovery went resource metadata -> AS metadata, and the registration is the documented JSON body
  const urls = fetchImpl.calls.map((call) => call.url);
  assert.deepEqual(urls, [
    'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp',
    `${ISSUER}/.well-known/oauth-authorization-server`,
    `${ISSUER}/oauth/register`
  ]);
  assert.deepEqual(fetchImpl.calls[2].json, {
    client_name: 'Open Creative Director',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'openid email offline_access'
  });

  // the challenge belongs to the verifier that is sent on the token exchange
  await client.completeConnect({ code: SECRET_CODE, state: params.state, iss: ISSUER });
  const exchange = fetchImpl.calls.find((call) => call.form?.grant_type === 'authorization_code');
  assert.equal(
    crypto.createHash('sha256').update(exchange.form.code_verifier).digest('base64url'),
    params.code_challenge,
    'code_challenge must be the S256 hash of the code_verifier'
  );
  assert.ok(exchange.form.code_verifier.length >= 43, 'verifier is at least 43 characters');

  // second login for the same redirect URI: no new discovery, no new registration
  const before = fetchImpl.calls.length;
  const again = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
  assert.equal(fetchImpl.calls.length, before, 'discovery is cached and the registration is reused');
  assert.equal(again.params.client_id, 'client-1');
  assert.notEqual(again.params.state, params.state, 'every login gets a fresh state');

  // another redirect URI registers a new client (discovery still cached)
  const other = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT_LOCAL })).verificationUri);
  assert.equal(other.params.client_id, 'client-2');
  assert.equal(other.params.redirect_uri, REDIRECT_LOCAL);
  assert.equal(fetchImpl.calls.length, before + 1);
  assert.deepEqual(fetchImpl.calls.at(-1).json.redirect_uris, [REDIRECT_LOCAL]);

  // a new login replaces the pending one: the earlier state is dead
  await assert.rejects(client.completeConnect({ code: 'x', state: again.params.state }), /passt nicht/);

  // discovery is refreshed after 24 hours
  time.now += 24 * 60 * 60 * 1000 + 1;
  const calls = fetchImpl.calls.length;
  await client.startConnect({ redirectUri: REDIRECT });
  assert.ok(fetchImpl.calls.length > calls, 'discovery expires after 24 hours');

  // invalid redirect URIs never reach the network
  const idle = fetchImpl.calls.length;
  await assert.rejects(client.startConnect({}), /Rueckkehr-Adresse/);
  await assert.rejects(client.startConnect({ redirectUri: 'javascript:alert(1)' }), /Rueckkehr-Adresse/);
  await assert.rejects(client.startConnect({ redirectUri: 'not a url' }), /Rueckkehr-Adresse/);
  assert.equal(fetchImpl.calls.length, idle);
}

async function testDiscoveryFallback(directory) {
  // discovery unavailable -> the known Clerk endpoints are used
  const failing = createMockFetch({
    'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp': () => jsonResponse({ error: 'down' }, 503)
  });
  const first = newClient(directory, 'fallback-1', { fetchImpl: failing });
  const uri = parseAuthorizeUrl((await first.client.startConnect({ redirectUri: REDIRECT })).verificationUri);
  assert.equal(uri.base, OAUTH_FALLBACK.authorizationEndpoint);
  assert.ok(failing.calls.some((call) => call.url === OAUTH_FALLBACK.registrationEndpoint), 'registers at the fallback endpoint');

  // AS metadata that claims another issuer or lacks S256 is not trusted either
  const wrongIssuer = createMockFetch({
    [`${ISSUER}/.well-known/oauth-authorization-server`]: () => jsonResponse({ ...AS_METADATA, issuer: 'https://evil.example', authorization_endpoint: 'https://evil.example/authorize' })
  });
  const second = newClient(directory, 'fallback-2', { fetchImpl: wrongIssuer });
  assert.equal(parseAuthorizeUrl((await second.client.startConnect({ redirectUri: REDIRECT })).verificationUri).base, OAUTH_FALLBACK.authorizationEndpoint);

  const noPkce = createMockFetch({
    [`${ISSUER}/.well-known/oauth-authorization-server`]: () => jsonResponse({ ...AS_METADATA, code_challenge_methods_supported: ['plain'] })
  });
  const third = newClient(directory, 'fallback-3', { fetchImpl: noPkce });
  assert.equal(parseAuthorizeUrl((await third.client.startConnect({ redirectUri: REDIRECT })).verificationUri).base, OAUTH_FALLBACK.authorizationEndpoint);

  // the fallback is cached only briefly: the next attempt after 5 minutes asks again
  let available = false;
  const flaky = createMockFetch({
    'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp': () => (available ? undefined : jsonResponse({}, 500))
  });
  const fourth = newClient(directory, 'fallback-4', { fetchImpl: flaky });
  await fourth.client.startConnect({ redirectUri: REDIRECT });
  const count = flaky.calls.length;
  available = true;
  fourth.time.now += 5 * 60 * 1000 + 1;
  await fourth.client.startConnect({ redirectUri: REDIRECT });
  assert.ok(flaky.calls.length > count);
}

async function testCallbackValidation(directory) {
  // valid callback: token exchange, storage format, status
  {
    const fetchImpl = createMockFetch();
    const { client, file } = newClient(directory, 'callback-ok', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    assert.deepEqual(await client.pollConnect(), { connected: false, pending: true });
    const httpBefore = fetchImpl.calls.length;

    assert.deepEqual(await client.completeConnect({ code: SECRET_CODE, state: params.state, iss: `${ISSUER}/` }), { connected: true });
    const exchange = fetchImpl.calls.at(-1);
    assert.equal(exchange.url, `${ISSUER}/oauth/token`);
    assert.equal(exchange.method, 'POST');
    assert.equal(exchange.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(exchange.form, {
      grant_type: 'authorization_code',
      code: SECRET_CODE,
      redirect_uri: REDIRECT,
      client_id: 'client-1',
      code_verifier: exchange.form.code_verifier,
      resource: 'https://mcp.higgsfield.ai/mcp'
    });
    assert.equal(fetchImpl.calls.length, httpBefore + 1);

    const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.deepEqual(saved, {
      auth: 'oauth',
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/oauth/token`,
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      access_token: SECRET_ACCESS,
      access_expires_at: 1_000_000 + 86_400_000,
      refresh_token: SECRET_REFRESH,
      refresh_expires_at: null
    });
    assert.equal(JSON.stringify(saved).includes(SECRET_ID_TOKEN), false, 'the id_token is not stored');
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(client.status(), { connected: true, refreshExpiresAt: null, pending: false });
    assert.deepEqual(await client.pollConnect(), { connected: true });
    assert.equal(fetchImpl.calls.length, httpBefore + 1, 'pollConnect never touches the network');
    // the pending login is gone: a replay of the same callback fails and sends nothing
    await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state }), /Keine Higgsfield-Anmeldung offen/);
    assert.equal(fetchImpl.calls.length, httpBefore + 1);
    assert.equal(await client.ensureAccessToken(), SECRET_ACCESS);
  }

  // wrong state: rejected, nothing sent, the pending login survives
  {
    const fetchImpl = createMockFetch();
    const { client, file } = newClient(directory, 'callback-state', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    const before = fetchImpl.calls.length;
    for (const state of ['', 'wrong', `${params.state}x`, params.state.slice(0, -1)]) {
      await assert.rejects(client.completeConnect({ code: SECRET_CODE, state }), (err) => /state/.test(err.message) && !err.message.includes(SECRET_CODE));
    }
    await assert.rejects(client.completeConnect({ error: 'access_denied', state: 'wrong' }), /state/);
    assert.equal(fetchImpl.calls.length, before);
    assert.equal(client.status().pending, true, 'a stray request does not cancel the login');
    await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
    assert.deepEqual(await client.completeConnect({ code: SECRET_CODE, state: params.state, iss: ISSUER }), { connected: true });
  }

  // missing iss although the server announces authorization_response_iss_parameter_supported: rejected (RFC 9207)
  {
    const fetchImpl = createMockFetch();
    const { client } = newClient(directory, 'callback-no-iss', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    const before = fetchImpl.calls.length;
    await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state }), /iss/);
    assert.equal(fetchImpl.calls.length, before, 'no token request without iss');
    assert.equal(client.status().pending, false);
    assert.equal(client.status().connected, false);
  }

  // a server that does not announce the parameter may omit it
  {
    const fetchImpl = createMockFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () => {
        const { authorization_response_iss_parameter_supported, ...rest } = AS_METADATA;
        return jsonResponse(rest);
      }
    });
    const { client } = newClient(directory, 'callback-iss-optional', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    assert.deepEqual(await client.completeConnect({ code: SECRET_CODE, state: params.state }), { connected: true });
  }

  // wrong iss: rejected, code never exchanged, login cancelled
  {
    const fetchImpl = createMockFetch();
    const { client } = newClient(directory, 'callback-iss', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    const before = fetchImpl.calls.length;
    await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state, iss: 'https://evil.example' }), /iss/);
    assert.equal(fetchImpl.calls.length, before, 'no token request after an issuer mismatch');
    assert.equal(client.status().pending, false);
    assert.equal(client.status().connected, false);
  }

  // error=access_denied (state matches): pending removed, clear message, description not echoed
  {
    const fetchImpl = createMockFetch();
    const { client } = newClient(directory, 'callback-denied', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    const before = fetchImpl.calls.length;
    await assert.rejects(
      client.completeConnect({ state: params.state, error: 'access_denied', errorDescription: '<script>alert(1)</script>' }),
      (err) => /nicht erlaubt/.test(err.message) && !err.message.includes('script')
    );
    assert.equal(fetchImpl.calls.length, before);
    assert.equal(client.status().pending, false);
    await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state }), /Keine Higgsfield-Anmeldung offen/);
  }

  // missing code
  {
    const { client } = newClient(directory, 'callback-nocode');
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    await assert.rejects(client.completeConnect({ state: params.state, iss: ISSUER }), /keinen Anmeldecode/);
    assert.equal(client.status().pending, false);
  }

  // expired after 10 minutes
  {
    const fetchImpl = createMockFetch();
    const { client, time } = newClient(directory, 'callback-expired', { fetchImpl });
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    assert.equal(OAUTH_PENDING_TTL_MS, 600_000);
    time.now += 600_000 - 1;
    assert.equal(client.status().pending, true);
    time.now += 2;
    assert.equal(client.status().pending, false);
    assert.deepEqual(await client.pollConnect(), { connected: false, pending: false });
    const before = fetchImpl.calls.length;
    await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state }), /abgelaufen/);
    assert.equal(fetchImpl.calls.length, before);
  }

  // completeConnect without any login started
  {
    const { client } = newClient(directory, 'callback-none');
    await assert.rejects(client.completeConnect({ code: 'x', state: 'y' }), /Keine Higgsfield-Anmeldung offen/);
  }
}

async function testTokenExchangeFailuresLeakNothing(directory) {
  const fetchImpl = createMockFetch({
    [AS_METADATA.token_endpoint]: (call) =>
      jsonResponse(
        { error: 'invalid_request', error_description: `bad code ${call.form.code} verifier ${call.form.code_verifier}` },
        400
      )
  });
  const { client, file } = newClient(directory, 'exchange-error', { fetchImpl });
  const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
  let message = '';
  await assert.rejects(client.completeConnect({ code: SECRET_CODE, state: params.state, iss: ISSUER }), (err) => {
    message = err.message;
    return true;
  });
  const verifier = fetchImpl.calls.at(-1).form.code_verifier;
  assert.ok(message.includes('bad code'), 'the server reason stays readable');
  assert.equal(message.includes(SECRET_CODE), false, 'no authorization code in the message');
  assert.equal(message.includes(verifier), false, 'no PKCE verifier in the message');
  await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  assert.equal(client.status().connected, false);

  // a token response without refresh token is not stored
  const noRefresh = createMockFetch({
    [AS_METADATA.token_endpoint]: () => jsonResponse({ access_token: SECRET_ACCESS, expires_in: 3600 })
  });
  const second = newClient(directory, 'exchange-no-refresh', { fetchImpl: noRefresh });
  const started = parseAuthorizeUrl((await second.client.startConnect({ redirectUri: REDIRECT })).verificationUri);
  await assert.rejects(second.client.completeConnect({ code: SECRET_CODE, state: started.params.state, iss: ISSUER }), /unvollstaendig/);
  await assert.rejects(fsp.stat(second.file), { code: 'ENOENT' });
}

async function connectedClient(directory, name, { fetchImpl, time } = {}) {
  const mock = fetchImpl || createMockFetch();
  const context = newClient(directory, name, { fetchImpl: mock, time });
  const { params } = parseAuthorizeUrl((await context.client.startConnect({ redirectUri: REDIRECT })).verificationUri);
  await context.client.completeConnect({ code: SECRET_CODE, state: params.state, iss: ISSUER });
  return { ...context, fetchImpl: mock };
}

async function testRefresh(directory) {
  // rotation: the new refresh token replaces the old one, the client id and resource are sent
  {
    const time = { now: 1_000_000 };
    const { client, file, fetchImpl } = await connectedClient(directory, 'refresh-rotate', { time });
    time.now += 86_400_000 - 60_000; // inside the 5 minute margin
    const [first, second] = await Promise.all([client.ensureAccessToken(), client.ensureAccessToken()]);
    assert.equal(first, 'access-refreshed');
    assert.equal(second, 'access-refreshed');
    const refreshes = fetchImpl.calls.filter((call) => call.form?.grant_type === 'refresh_token');
    assert.equal(refreshes.length, 1, 'parallel refreshes are deduplicated');
    assert.deepEqual(refreshes[0].form, {
      grant_type: 'refresh_token',
      refresh_token: SECRET_REFRESH,
      client_id: 'client-1',
      resource: 'https://mcp.higgsfield.ai/mcp'
    });
    assert.equal(refreshes[0].url, AS_METADATA.token_endpoint, 'the stored token endpoint is used');
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(saved.refresh_token, 'refresh-rotated');
    assert.equal(saved.access_token, 'access-refreshed');
    assert.equal(saved.auth, 'oauth');
    assert.equal(saved.client_id, 'client-1');
    assert.equal(saved.refresh_expires_at, null);
    assert.equal(saved.id_token, undefined);
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    // a new client instance (server restart) continues with the stored login
    const restarted = createHiggsfieldClient({ store: createFileTokenStore(file), now: () => time.now, fetchImpl: createMockFetch() });
    assert.equal(restarted.status().connected, true);
    assert.equal(restarted.status().refreshExpiresAt, null);
  }

  // a refresh response without a new refresh token keeps the old one
  {
    const time = { now: 1_000_000 };
    const fetchImpl = createMockFetch({
      [AS_METADATA.token_endpoint]: (call) =>
        call.form.grant_type === 'refresh_token' ? jsonResponse({ access_token: 'access-2', expires_in: 3600 }) : undefined
    });
    const { client, file } = await connectedClient(directory, 'refresh-keep', { fetchImpl, time });
    time.now += 86_400_000;
    assert.equal(await client.ensureAccessToken(), 'access-2');
    assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).refresh_token, SECRET_REFRESH);
  }

  // invalid_grant disconnects and removes the file
  {
    const time = { now: 1_000_000 };
    const fetchImpl = createMockFetch({
      [AS_METADATA.token_endpoint]: (call) =>
        call.form.grant_type === 'refresh_token' ? jsonResponse({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400) : undefined
    });
    const { client, file } = await connectedClient(directory, 'refresh-invalid-grant', { fetchImpl, time });
    time.now += 86_400_000;
    await assert.rejects(client.ensureAccessToken(), (err) => err.message === DISCONNECTED_MESSAGE);
    await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
    assert.equal(client.status().connected, false);
  }

  // disconnect while a refresh is in flight stays disconnected (the late answer is dropped)
  {
    const time = { now: 1_000_000 };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = createMockFetch({
      [AS_METADATA.token_endpoint]: async (call) => {
        if (call.form.grant_type !== 'refresh_token') return undefined;
        await gate;
        return undefined;
      }
    });
    const { client, file } = await connectedClient(directory, 'refresh-disconnect-race', { fetchImpl, time });
    time.now += 86_400_000 - 60_000;
    const pendingRefresh = client.ensureAccessToken();
    pendingRefresh.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await client.disconnect();
    release();
    await assert.rejects(pendingRefresh, (err) => err.message === DISCONNECTED_MESSAGE);
    assert.equal(client.status().connected, false, 'a late refresh does not reconnect');
    await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  }

  // a late invalid_grant of an old refresh does not delete a newer login
  {
    const time = { now: 1_000_000 };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = createMockFetch({
      [AS_METADATA.token_endpoint]: async (call) => {
        if (call.form.grant_type !== 'refresh_token') return undefined;
        await gate;
        return jsonResponse({ error: 'invalid_grant' }, 400);
      }
    });
    const { client, file } = await connectedClient(directory, 'refresh-invalid-race', { fetchImpl, time });
    time.now += 86_400_000 - 60_000;
    const pendingRefresh = client.ensureAccessToken();
    pendingRefresh.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await client.disconnect();
    const { params } = parseAuthorizeUrl((await client.startConnect({ redirectUri: REDIRECT })).verificationUri);
    await client.completeConnect({ code: SECRET_CODE, state: params.state, iss: ISSUER });
    release();
    await assert.rejects(pendingRefresh).catch(() => {});
    assert.equal(client.status().connected, true, 'the newer login survives');
    assert.ok(JSON.parse(await fsp.readFile(file, 'utf8')).refresh_token, 'the newer tokens stay on disk');
  }

  // network errors, timeouts and server errors do not disconnect, and leak no token
  for (const [name, behaviour] of [
    ['network', () => { throw new Error(`socket hang up ${SECRET_REFRESH}`); }],
    ['server-error', () => jsonResponse({ error: 'server_error', error_description: `oops ${SECRET_REFRESH}` }, 500)],
    ['invalid-client', () => jsonResponse({ error: 'invalid_client' }, 401)],
    ['html', () => new Response('<html>bad gateway</html>', { status: 502 })]
  ]) {
    const time = { now: 1_000_000 };
    const fetchImpl = createMockFetch({
      [AS_METADATA.token_endpoint]: (call) => (call.form.grant_type === 'refresh_token' ? behaviour() : undefined)
    });
    const { client, file } = await connectedClient(directory, `refresh-${name}`, { fetchImpl, time });
    time.now += 86_400_000;
    await assert.rejects(client.ensureAccessToken(), (err) => {
      assert.notEqual(err.message, DISCONNECTED_MESSAGE, `${name}: a transient error is no disconnect`);
      assert.equal(err.message.includes(SECRET_REFRESH), false, `${name}: no refresh token in the message`);
      assert.equal(err.message.includes(SECRET_ACCESS), false, `${name}: no access token in the message`);
      return true;
    });
    assert.equal(client.status().connected, true, `${name}: still connected`);
    assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).refresh_token, SECRET_REFRESH, `${name}: tokens kept`);
  }
}

async function testMcpUsesBearerAndRefreshesOn401(directory) {
  const time = { now: 1_000_000 };
  let mcpCalls = 0;
  const fetchImpl = createMockFetch({
    'https://mcp.higgsfield.ai/mcp': (call) => {
      mcpCalls += 1;
      if (call.headers.Authorization === `Bearer ${SECRET_ACCESS}`) return jsonResponse({ error: 'expired' }, 401);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Credits: 5 | Plan: ultra' }] } });
    }
  });
  const { client, fetchImpl: mock } = await connectedClient(directory, 'mcp-401', { fetchImpl, time });
  assert.equal(await client.mcpCall('balance', {}), 'Credits: 5 | Plan: ultra');
  assert.equal(mcpCalls, 2);
  assert.equal(mock.calls.at(-1).headers.Authorization, 'Bearer access-refreshed');
}

async function testLegacyDeviceTokens(directory) {
  const file = path.join(directory, 'legacy.json');
  await fsp.writeFile(
    file,
    `${JSON.stringify({ access_token: 'legacy-access', access_expires_at: 1_100_000, refresh_token: 'legacy-refresh', refresh_expires_at: 10_000_000 })}\n`,
    { mode: 0o600 }
  );
  const requests = [];
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ access_token: 'legacy-new', expires_in: 3600, refresh_token: 'legacy-refresh-2', refresh_expires_in: 604800 });
    }
  });
  assert.deepEqual(client.status(), { connected: true, refreshExpiresAt: 10_000_000, pending: false });
  assert.equal(await client.ensureAccessToken(), 'legacy-new');
  assert.deepEqual(requests, [{ url: 'https://fnf-device-auth.higgsfield.ai/refresh', body: { refresh_token: 'legacy-refresh' } }]);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.auth, undefined, 'legacy tokens stay legacy');
  assert.equal(saved.refresh_token, 'legacy-refresh-2');

  // expired legacy tokens disconnect
  const expiredFile = path.join(directory, 'legacy-expired.json');
  await fsp.writeFile(
    expiredFile,
    `${JSON.stringify({ access_token: 'a', access_expires_at: 1, refresh_token: 'r', refresh_expires_at: 500_000 })}\n`,
    { mode: 0o600 }
  );
  const expired = createHiggsfieldClient({ store: createFileTokenStore(expiredFile), now: () => 1_000_000, fetchImpl: async () => assert.fail('no request') });
  assert.equal(expired.status().connected, false);
  await assert.rejects(fsp.stat(expiredFile), { code: 'ENOENT' });
}

async function testStatusWithoutRefreshExpiry(directory) {
  const file = path.join(directory, 'never-expires.json');
  await fsp.writeFile(
    file,
    `${JSON.stringify({
      auth: 'oauth',
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/oauth/token`,
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      access_token: 'a',
      access_expires_at: 9_000_000_000_000,
      refresh_token: 'r',
      refresh_expires_at: null
    })}\n`,
    { mode: 0o600 }
  );
  const time = { now: 1_000_000 };
  const client = createHiggsfieldClient({ store: createFileTokenStore(file), now: () => time.now, fetchImpl: async () => assert.fail('no request') });
  assert.deepEqual(client.status(), { connected: true, refreshExpiresAt: null, pending: false });
  time.now += 10 * 365 * 24 * 60 * 60 * 1000;
  assert.equal(client.status().connected, true, 'null means the refresh token does not expire');
  assert.equal(await client.ensureAccessToken(), 'a');

  // an OAuth record without token endpoint or client id is ignored, not trusted
  const broken = path.join(directory, 'broken-oauth.json');
  await fsp.writeFile(broken, `${JSON.stringify({ auth: 'oauth', access_token: 'a', access_expires_at: 1, refresh_token: 'r', refresh_expires_at: null })}\n`);
  assert.equal(createHiggsfieldClient({ store: createFileTokenStore(broken), fetchImpl: async () => assert.fail('no request') }).status().connected, false);
  // legacy tokens without a refresh expiry stay invalid
  const legacyNull = path.join(directory, 'legacy-null.json');
  await fsp.writeFile(legacyNull, `${JSON.stringify({ access_token: 'a', access_expires_at: 1, refresh_token: 'r', refresh_expires_at: null })}\n`);
  assert.equal(createHiggsfieldClient({ store: createFileTokenStore(legacyNull), fetchImpl: async () => assert.fail('no request') }).status().connected, false);
}

async function testDisconnectClearsPending(directory) {
  const { client, file } = await connectedClient(directory, 'disconnect');
  await client.startConnect({ redirectUri: REDIRECT });
  assert.equal(client.status().pending, true);
  assert.deepEqual(await client.disconnect(), { connected: false });
  assert.deepEqual(client.status(), { connected: false, refreshExpiresAt: null, pending: false });
  await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
}

/* ---------- routes ---------- */

function routeHandler(routePath, method) {
  const layer = app._router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(method, routePath, req) {
  const handler = routeHandler(routePath, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, headers: {}, body: null };
    const res = {
      status(code) { result.status = code; return this; },
      set(headers) { Object.assign(result.headers, headers); return this; },
      json(body) { result.body = body; resolve(result); },
      send(body) { result.body = body; resolve(result); }
    };
    Promise.resolve(handler({ headers: {}, query: {}, ...req }, res)).catch(reject);
  });
}

async function testRoutes() {
  const originalStart = higgsfield.startConnect;
  const originalComplete = higgsfield.completeConnect;
  const originalStatus = higgsfield.status;
  const originalWhoami = process.env.AUTH_WHOAMI_URL;
  const originalBase = process.env.PUBLIC_BASE_URL;
  process.env.AUTH_WHOAMI_URL = '';
  try {
    // the callback is registered before the catch-all
    const stack = app._router.stack;
    const callbackIndex = stack.findIndex((item) => item.route?.path === '/api/higgsfield/oauth/callback');
    const catchAllIndex = stack.findIndex((item) => item.route?.path === '*');
    assert.ok(callbackIndex >= 0 && callbackIndex < catchAllIndex, 'callback route must precede the catch-all');

    // connect: redirect URI from PUBLIC_BASE_URL, from the request, from X-Forwarded-Proto
    const seen = [];
    higgsfield.startConnect = async (options) => {
      seen.push(options);
      return { verificationUri: 'https://clerk.higgsfield.ai/oauth/authorize?x=1', expiresIn: 600 };
    };
    process.env.PUBLIC_BASE_URL = 'https://creator.example/supercomputer///';
    let response = await invoke('post', '/api/higgsfield/connect', { headers: { host: 'internal:3111' } });
    assert.deepEqual(response.body, { verificationUri: 'https://clerk.higgsfield.ai/oauth/authorize?x=1', expiresIn: 600 });
    assert.deepEqual(seen.at(-1), { redirectUri: 'https://creator.example/supercomputer/api/higgsfield/oauth/callback' });

    delete process.env.PUBLIC_BASE_URL;
    await invoke('post', '/api/higgsfield/connect', { headers: { host: 'localhost:3111' } });
    assert.equal(seen.at(-1).redirectUri, 'http://localhost:3111/api/higgsfield/oauth/callback');
    await invoke('post', '/api/higgsfield/connect', { headers: { host: 'creator.example', 'x-forwarded-proto': 'https, http' } });
    assert.equal(seen.at(-1).redirectUri, 'https://creator.example/api/higgsfield/oauth/callback');
    await invoke('post', '/api/higgsfield/connect', { protocol: 'https', headers: { host: 'creator.example', 'x-forwarded-proto': 'ftp' } });
    assert.equal(seen.at(-1).redirectUri, 'https://creator.example/api/higgsfield/oauth/callback', 'unknown forwarded protocols are ignored');

    // X-Forwarded-Host is ignored unless TRUST_PROXY_HOST is set
    const originalTrust = process.env.TRUST_PROXY_HOST;
    try {
      delete process.env.TRUST_PROXY_HOST;
      await invoke('post', '/api/higgsfield/connect', { headers: { host: 'creator.example', 'x-forwarded-host': 'evil.example' } });
      assert.equal(seen.at(-1).redirectUri, 'http://creator.example/api/higgsfield/oauth/callback', 'X-Forwarded-Host is ignored by default');
      process.env.TRUST_PROXY_HOST = '1';
      await invoke('post', '/api/higgsfield/connect', { headers: { host: 'internal:3111', 'x-forwarded-host': 'creator.example' } });
      assert.equal(seen.at(-1).redirectUri, 'http://creator.example/api/higgsfield/oauth/callback', 'opt-in honours X-Forwarded-Host');
    } finally {
      if (originalTrust === undefined) delete process.env.TRUST_PROXY_HOST;
      else process.env.TRUST_PROXY_HOST = originalTrust;
    }

    // connect failure -> 502 with the message
    higgsfield.startConnect = async () => { throw new Error('Higgsfield-Auth fehlgeschlagen'); };
    response = await invoke('post', '/api/higgsfield/connect', { headers: { host: 'localhost' } });
    assert.equal(response.status, 502);

    // callback success
    const completeCalls = [];
    const catalog = require('../lib/nodes/higgsfield-catalog');
    const originalClear = catalog.clearCache;
    let clearCalls = 0;
    catalog.clearCache = () => { clearCalls += 1; };
    higgsfield.completeConnect = async (args) => {
      completeCalls.push(args);
      return { connected: true };
    };
    response = await invoke('get', '/api/higgsfield/oauth/callback', {
      query: { code: SECRET_CODE, state: 'st', iss: ISSUER }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(completeCalls[0], { code: SECRET_CODE, state: 'st', iss: ISSUER, error: '', errorDescription: '' });
    assert.match(response.headers['Cache-Control'], /no-store/);
    assert.match(response.headers['Content-Type'], /text\/html/);
    assert.match(response.body, /Higgsfield ist verbunden/);
    assert.match(response.body, /schliessen/);
    assert.equal(clearCalls, 1, 'a successful login clears the model and voice caches');
    assert.equal(response.body.includes(SECRET_CODE), false, 'the code is never echoed');

    // disconnect clears the caches, too
    const originalDisconnect = higgsfield.disconnect;
    higgsfield.disconnect = async () => ({ connected: false });
    clearCalls = 0;
    response = await invoke('delete', '/api/higgsfield/auth', {});
    higgsfield.disconnect = originalDisconnect;
    assert.equal(response.status, 200);
    assert.equal(clearCalls, 1, 'disconnect clears the model and voice caches');
    catalog.clearCache = originalClear;

    // non-string query values (arrays, objects) are ignored
    await invoke('get', '/api/higgsfield/oauth/callback', { query: { code: ['a', 'b'], state: { x: 1 } } });
    assert.deepEqual(completeCalls.at(-1), { code: '', state: '', iss: '', error: '', errorDescription: '' });

    // callback failure: error page, escaped message, query values not mirrored
    higgsfield.completeConnect = async () => { throw new Error('Kaputt <b>&"\''); };
    response = await invoke('get', '/api/higgsfield/oauth/callback', {
      query: { error: 'access_denied', error_description: '<img src=x onerror=alert(1)>', state: 'st' }
    });
    assert.equal(response.status, 400);
    assert.match(response.body, /fehlgeschlagen/);
    assert.ok(response.body.includes('Kaputt &lt;b&gt;&amp;&quot;&#39;'), 'error text is HTML-escaped');
    assert.equal(response.body.includes('onerror'), false, 'query values are never mirrored');
    assert.match(response.headers['Cache-Control'], /no-store/);

    // admin check: with an auth proxy configured, an unknown user gets 403 and nothing happens
    process.env.AUTH_WHOAMI_URL = 'https://auth.example/whoami';
    let called = false;
    higgsfield.completeConnect = async () => { called = true; return { connected: true }; };
    response = await invoke('get', '/api/higgsfield/oauth/callback', { query: { code: 'c', state: 's' } });
    assert.equal(response.status, 403);
    assert.equal(called, false);
    response = await invoke('post', '/api/higgsfield/connect', {});
    assert.equal(response.status, 403);
  } finally {
    higgsfield.startConnect = originalStart;
    higgsfield.completeConnect = originalComplete;
    higgsfield.status = originalStatus;
    if (originalWhoami === undefined) delete process.env.AUTH_WHOAMI_URL;
    else process.env.AUTH_WHOAMI_URL = originalWhoami;
    if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalBase;
  }
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-higgsfield-oauth-'));
  try {
    await testDiscoveryRegistrationAndAuthorizeUrl(directory);
    await testDiscoveryFallback(directory);
    await testCallbackValidation(directory);
    await testTokenExchangeFailuresLeakNothing(directory);
    await testRefresh(directory);
    await testMcpUsesBearerAndRefreshesOn401(directory);
    await testLegacyDeviceTokens(directory);
    await testStatusWithoutRefreshExpiry(directory);
    await testDisconnectClearsPending(directory);
    await testRoutes();
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('higgsfield oauth ok: Discovery, Registrierung, PKCE, Callback-Pruefungen, Token-Tausch, Refresh, Legacy, Routen');
  console.log('test-higgsfield-oauth.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
