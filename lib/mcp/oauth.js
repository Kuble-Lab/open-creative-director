'use strict';

// OAuth public endpoints are mounted before whoami; authorization is mounted after whoami and its guard.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const access = require('../access');
const { PATHS } = require('../config');
const { publicBase } = require('./urls');
const { createClientStore, redirectMatches } = require('./oauth-clients');
const { createTokenStore } = require('./oauth-tokens');
const { consentPage, errorPage, language, securityHeaders } = require('./oauth-consent');
const { createRateLimiter, readBody, discardRest } = require('./http');
const SCOPES = ['mcp:read', 'mcp:start'];
const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource', 'lang'];
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const bad = (error = 'invalid_request') => Object.assign(new Error('OAuth request rejected'), { oauthError: error });
function clientIp(req) {
  // A loopback reverse proxy must overwrite both IP headers; the public endpoint limits trust them.
  const socket = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (socket === '127.0.0.1' || socket === '::1') {
    const real = String(req.headers['x-real-ip'] || '').trim();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
    return (real || forwarded.at(-1) || socket).slice(0, 64);
  }
  return socket || '-';
}
function safeBase(base) {
  try {
    const u = new URL(base);
    return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname)));
  } catch (_) { return false; }
}
function normalResource(text) {
  try {
    const url = new URL(text);
    if (text.includes('#') || url.username || url.password || url.hash || url.search) return null;
    return url.href.replace(/\/+$/, '');
  } catch (_) { return null; }
}
function createOAuth({ keys = require('./keys').defaultStore, policy = keys.policy, env = process.env, enabled,
  now = Date.now, random = crypto.randomBytes, fetchImpl, lookup, dataDir = path.join(PATHS.root, 'data'),
  clientsFile = path.join(dataDir, 'mcp-oauth-clients.json'), tokensFile = path.join(dataDir, 'mcp-oauth-tokens.json'),
  secretFile = path.join(dataDir, 'mcp-oauth-secret'), viewerOf = (req) => access.viewerOf(req, env), clients: givenClients, tokens: givenTokens } = {}) {
  const info = (req) => {
    const issuer = publicBase(req, env);
    return { enabled: env.MCP_OAUTH !== 'off' && (enabled === undefined ? access.isActive(env) && safeBase(issuer) : Boolean(enabled) && safeBase(issuer)), issuer };
  };
  const clients = givenClients || createClientStore({ file: clientsFile, now, random, fetchImpl, lookup,
    hasConnection: (id) => keys.list().some((key) => key.kind === 'oauth' && key.clientId === id && key.status === 'active') });
  const tokens = givenTokens || createTokenStore({ keys, file: tokensFile, now, random });
  const registrationLimit = createRateLimiter({ requests: 10, windowMs: 3600000, now });
  const registrationGlobal = createRateLimiter({ requests: 200, windowMs: 86400000, now });
  const tokenLimit = createRateLimiter({ requests: 60, windowMs: 60000, now });
  const revokeLimit = createRateLimiter({ requests: 60, windowMs: 60000, now });
  const authorizeLimit = createRateLimiter({ requests: 30, windowMs: 60000, now });
  const consentLimit = createRateLimiter({ requests: 10, windowMs: 60000, now });
  let signingKey;
  function secret() {
    if (signingKey) return signingKey;
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    try { fs.writeFileSync(secretFile, random(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (err) { if (err.code !== 'EEXIST') throw bad(); }
    fs.chmodSync(secretFile, 0o600);
    const value = fs.readFileSync(secretFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw bad();
    signingKey = Buffer.from(value, 'hex');
    return signingKey;
  }
  const mac = (value) => crypto.createHmac('sha256', secret()).update(`mcp-consent-v1.${value}`).digest();
  function csrfSign(email, params) {
    const payload = Buffer.from(JSON.stringify({ email, params, expires: now() + 600000 })).toString('base64url');
    return `${payload}.${mac(payload).toString('base64url')}`;
  }
  function csrfValid(token, email, params) {
    if (typeof token !== 'string' || token.length > 14000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const [payload, signature] = token.split('.');
    const given = Buffer.from(signature, 'base64url'), expected = mac(payload);
    if (given.toString('base64url') !== signature || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url'));
      return data.email === email && Number.isFinite(data.expires) && data.expires > now() && JSON.stringify(data.params) === JSON.stringify(params);
    } catch (_) { return false; }
  }
  function authorizeParams(value) {
    const result = {};
    for (const name of PARAMS) {
      if (value[name] !== undefined) {
        if (typeof value[name] !== 'string' || value[name].length > (name === 'state' ? 2048 : 4096)) throw bad();
        result[name] = value[name];
      }
    }
    return result;
  }
  const allowedResource = (given, issuer) => given === undefined || [normalResource(issuer), normalResource(`${issuer}/mcp`)].includes(normalResource(given));
  function jsonError(res, error, status = 400) { return res.status(status).json({ error }); }
  function publicHeaders(res) {
    res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
  }
  function rate(req, res, limiter, id = clientIp(req)) {
    const result = limiter.take(id);
    if (result.allowed) return true;
    discardRest(req);
    res.set('Retry-After', String(result.retryAfterSeconds));
    jsonError(res, 'temporarily_unavailable', 429);
    return false;
  }
  async function body(req, type) {
    if (!req.is(type)) { discardRest(req); throw bad(); }
    const read = await readBody(req, 65536);
    if (!read.body) { discardRest(req); throw bad(); }
    if (type === 'application/json') {
      try { return JSON.parse(read.body.toString('utf8')); } catch (_) { throw bad(); }
    }
    const values = new URLSearchParams(read.body.toString('utf8')), out = {};
    for (const [name, value] of values) {
      if (Object.hasOwn(out, name)) throw bad();
      Object.defineProperty(out, name, { value, enumerable: true, configurable: true });
    }
    return out;
  }
  function returnTo(res, params, issuer, values) {
    securityHeaders(res, params.redirect_uri);
    const url = new URL(params.redirect_uri);
    for (const [key, value] of Object.entries({ ...values, ...(params.state !== undefined ? { state: params.state } : {}), iss: issuer })) url.searchParams.set(key, value);
    return res.redirect(302, url.href);
  }
  async function validate(params, req, res, issuer) {
    let client;
    try { client = await clients.resolve(params.client_id); } catch (_) { errorPage(req, res, 400); return null; }
    if (!client.redirectUris.some((uri) => redirectMatches(uri, params.redirect_uri))) { errorPage(req, res, 400); return null; }
    let error;
    if (params.response_type !== 'code') error = 'unsupported_response_type';
    else if (params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || '')) error = 'invalid_request';
    else if (!allowedResource(params.resource, issuer)) error = 'invalid_target';
    const scopes = params.scope === undefined ? SCOPES : [...new Set(params.scope.split(' ').filter((s) => SCOPES.includes(s)))];
    if (!error && !scopes.length) error = 'invalid_scope';
    if (error) { returnTo(res, params, issuer, { error, error_description: 'Authorization request rejected' }); return null; }
    return { client, scopes };
  }
  function person(req, res) {
    const viewer = viewerOf(req);
    if (!viewer?.identified || !access.normalizeEmail(viewer.email)) { errorPage(req, res, 401, 'oauth.loginRequired'); return null; }
    if (!keys.viewerOfOwner(viewer.email)) { errorPage(req, res, 403, 'oauth.forbidden'); return null; }
    return viewer;
  }
  async function authorize(req, res) {
    if (!info(req).enabled) return res.sendStatus(404);
    const viewer = person(req, res);
    if (!viewer) return;
    const limit = (req.method === 'POST' ? consentLimit : authorizeLimit).take(access.normalizeEmail(viewer.email));
    if (!limit.allowed) {
      discardRest(req);
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return errorPage(req, res, 429, 'oauth.rateLimited');
    }
    const issuer = info(req).issuer;
    let input, params;
    try {
      input = req.method === 'POST' ? await body(req, 'application/x-www-form-urlencoded') : req.query;
      params = authorizeParams(input);
    } catch (_) { return errorPage(req, res, req.method === 'POST' ? 403 : 400); }
    if (req.method === 'POST') {
      const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== new URL(issuer).origin) || (site !== undefined && site !== 'same-origin') || !csrfValid(input.csrf, viewer.email, params)) return errorPage(req, res, 403, 'oauth.consentExpired');
    }
    const checked = await validate(params, req, res, issuer);
    if (!checked) return;
    if (req.method === 'GET') {
      // Sign exactly the fields that will be submitted; normalized scopes are only for choosing the right.
      params.lang = language(req);
      return consentPage({ req, res, client: checked.client, params, scopes: checked.scopes.join(' '), csrf: csrfSign(viewer.email, params), email: viewer.email, settings: keys.settingsFor(viewer), action: `${issuer}/oauth/authorize` });
    }
    if (input.decision === 'cancel') return returnTo(res, params, issuer, { error: 'access_denied' });
    if (input.decision !== 'connect' || !['read', 'start'].includes(input.right) || !checked.scopes.includes(`mcp:${input.right}`)) return errorPage(req, res, 400);
    const { key } = keys.create({ name: checked.client.name, owner: viewer.email, createdBy: viewer.email, right: input.right,
      oauth: { clientId: checked.client.id, clientName: checked.client.name, resource: `${issuer}/mcp` } });
    tokens.discardConnection(key.id);
    clients.touch(checked.client.id);
    const scope = input.right === 'start' ? checked.scopes.join(' ') : 'mcp:read';
    const code = tokens.issueCode({ keyId: key.id, clientId: checked.client.id, redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, resource: `${issuer}/mcp`, scope });
    return returnTo(res, params, issuer, { code });
  }
  function mountPublic(app) {
    const prm = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
    const asm = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];
    for (const route of [...prm, ...asm]) app.get(route, (req, res) => {
      publicHeaders(res);
      const { enabled: on, issuer } = info(req);
      if (!on) return res.sendStatus(404);
      return res.json(prm.includes(route) ? { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: SCOPES, resource_name: 'Open Creative Director MCP' } : {
        issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES,
        client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true
      });
    });
    for (const route of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
      app.options(route, (req, res) => {
        publicHeaders(res);
        if (!info(req).enabled) return res.sendStatus(404);
        res.set({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        return res.status(204).end();
      });
      app.post(route, async (req, res) => {
        publicHeaders(res);
        if (!info(req).enabled) return res.sendStatus(404);
        const limiter = route.endsWith('register') ? registrationLimit : route.endsWith('token') ? tokenLimit : revokeLimit;
        if (!rate(req, res, limiter) || (route.endsWith('register') && !rate(req, res, registrationGlobal, 'global'))) return;
        try {
          const input = await body(req, route.endsWith('register') ? 'application/json' : 'application/x-www-form-urlencoded');
          if (route.endsWith('register')) {
            const c = clients.register(input);
            return res.status(201).json({ client_id: c.id, client_id_issued_at: Math.floor(Date.parse(c.createdAt) / 1000), client_name: c.name, redirect_uris: c.redirectUris, grant_types: c.grantTypes, response_types: c.responseTypes, token_endpoint_auth_method: 'none' });
          }
          if (route.endsWith('revoke')) { tokens.revoke(input.token, input.client_id); return res.status(200).end(); }
          if (!input.client_id) return jsonError(res, 'invalid_client');
          const issuer = info(req).issuer;
          if (!allowedResource(input.resource, issuer)) return jsonError(res, 'invalid_grant');
          if (!['authorization_code', 'refresh_token'].includes(input.grant_type)) return jsonError(res, input.grant_type ? 'unsupported_grant_type' : 'invalid_request');
          const required = input.grant_type === 'authorization_code' ? ['code', 'redirect_uri', 'code_verifier'] : ['refresh_token'];
          if (required.some((name) => !input[name])) return jsonError(res, 'invalid_request');
          const result = input.grant_type === 'authorization_code' ? tokens.exchange(input, `${issuer}/mcp`) : tokens.refresh(input, `${issuer}/mcp`);
          if (!result) return jsonError(res, 'invalid_grant');
          clients.touch(input.client_id);
          return res.json(result);
        } catch (err) {
          if (route.endsWith('revoke')) return res.status(200).end();
          if (err.status === 429) res.set('Retry-After', String(err.retryAfterSeconds));
          return jsonError(res, err.oauthError || 'invalid_request', err.status === 429 ? 429 : 400);
        }
      });
    }
  }
  // Initialize the signing key at startup when the public issuer is configured; otherwise on first consent.
  if (env.PUBLIC_BASE_URL && info({ headers: {} }).enabled) secret();
  return { info, clients, tokens, policy, mountPublic,
    authenticate: (token, req) => info(req).enabled ? tokens.authenticate(token, `${info(req).issuer}/mcp`) : { ok: false, reason: 'unknown' },
    mountLoggedIn(app) { for (const method of ['get', 'post']) app[method]('/oauth/authorize', (req, res) => authorize(req, res).catch(() => { if (!res.headersSent) errorPage(req, res, 400); })); }
  };
}
module.exports = { createOAuth, clientIp, normalResource };
