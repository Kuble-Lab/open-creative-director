'use strict';

// One encrypted OAuth connection for the installation, bound to its configured resource.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('./config');
const { normalizeEmail } = require('./access');
const MAX_RESPONSE = 4 * 1024 * 1024;
const AAD = Buffer.from('open-creative-director:website-host');
const MESSAGES = {
  HOST_DISABLED: 'Der Website-Host ist nicht eingerichtet.',
  HOST_NOT_CONNECTED: 'Bitte den Website-Host zuerst verbinden.',
  HOST_AUTH: 'Die Anmeldung beim Website-Host ist nicht mehr gültig. Bitte erneut verbinden.',
  HOST_UNAVAILABLE: 'Der Website-Host ist gerade nicht erreichbar. Bitte später erneut versuchen.',
  HOST_REFUSED: 'Der Website-Host konnte diese Anfrage nicht ausführen.'
};
function fail(code, message) {
  const status = { HOST_DISABLED: 404, HOST_NOT_CONNECTED: 409, HOST_AUTH: 401, HOST_UNAVAILABLE: 502, HOST_REFUSED: 502 }[code];
  return Object.assign(new Error(message || MESSAGES[code]), { status, code });
}
function address(value) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    return url.href;
  } catch (_) { return null; }
}
function sameAddress(a, b) { return typeof a === 'string' && typeof b === 'string' && a.replace(/\/$/, '') === b.replace(/\/$/, ''); }
function validateArgs(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (['site_token', 'voucher', 'code'].includes(key)) throw new TypeError('Diese Zugangsdaten dürfen nicht an den Website-Host gesendet werden.');
    validateArgs(value[key], seen);
  }
}
function createRtkHost({ directory = path.join(PATHS.root, 'data', 'website-host'), fetchImpl = global.fetch, now = Date.now, env = process.env, config } = {}) {
  const pending = new Map();
  let metadata, client, lock = Promise.resolve();
  const connectionFile = path.join(directory, 'connection.json');
  function resource() {
    let settings = config;
    if (!String(env.WEBSITE_HOST_MCP_URL || '').trim() && settings === undefined) {
      try { settings = JSON.parse(fs.readFileSync(PATHS.configFile, 'utf8')); }
      catch (_) { settings = {}; }
    }
    return address(String(env.WEBSITE_HOST_MCP_URL || '').trim() || settings?.websiteHost?.mcpUrl);
  }
  function requiredResource() {
    const value = resource();
    if (!value) throw fail('HOST_DISABLED');
    return value;
  }
  function key() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'encryption.key');
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    const value = fs.readFileSync(file);
    if (value.length !== 32) throw fail('HOST_AUTH');
    return value;
  }
  function read(url) {
    try {
      const data = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(data.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.value, 'base64')), decipher.final()]).toString());
      return value.mcpUrl === url ? value : null;
    } catch (err) { if (err.code === 'ENOENT') return null; throw fail('HOST_AUTH'); }
  }
  function write(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temp = connectionFile + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') }), { mode: 0o600 });
      fs.renameSync(temp, connectionFile);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  async function serial(fn) {
    const task = lock.catch(() => {}).then(fn);
    lock = task;
    try { return await task; }
    catch (err) { if (MESSAGES[err.code]) throw err; throw fail('HOST_UNAVAILABLE'); }
    finally { if (lock === task) lock = Promise.resolve(); }
  }
  async function request(url, options = {}, timeout = 30000) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(response.status === 401 || response.status === 403 ? 'HOST_AUTH' : 'HOST_UNAVAILABLE');
      }
      return response;
    } catch (err) { if (err.code && MESSAGES[err.code]) throw err; throw fail('HOST_UNAVAILABLE'); }
  }
  // Bound both JSON and event streams, including streams that stay open after the result.
  async function responseData(response, id) {
    const reader = response.body?.getReader();
    if (!reader) throw fail('HOST_UNAVAILABLE');
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '', size = 0;
    function event(block) {
      const lines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!lines) return null;
      const data = JSON.parse(lines);
      return data.id === id ? data : null;
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) throw fail('HOST_UNAVAILABLE', 'Die Antwort des Website-Hosts ist zu gross.');
        buffer += decoder.decode(value, { stream: true });
        if (sse) {
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = event(block);
            if (data) return data;
          }
        }
      }
      buffer += decoder.decode();
      const data = sse ? event(buffer) : JSON.parse(buffer);
      if (!data) throw fail('HOST_UNAVAILABLE');
      return data;
    } catch (err) { if (err.code && MESSAGES[err.code]) throw err; throw fail('HOST_UNAVAILABLE'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  const jsonRequest = async (url, options) => responseData(await request(url, options));
  async function discovery(url) {
    if (metadata?.mcpUrl === url) return metadata;
    const target = new URL(url);
    const prefix = target.origin + '/.well-known/oauth-protected-resource';
    let protectedResource;
    try { protectedResource = await jsonRequest(prefix + target.pathname.replace(/\/$/, '')); }
    catch (_) { protectedResource = await jsonRequest(prefix); }
    const unsupported = () => fail('HOST_UNAVAILABLE', 'Der Website-Host unterstützt die automatische Anmeldung nicht.');
    const issuer = protectedResource.authorization_servers?.[0];
    if (!sameAddress(protectedResource.resource, url) || !address(issuer) || !Array.isArray(protectedResource.scopes_supported) || protectedResource.scopes_supported.some(scope => typeof scope !== 'string' || !scope || /\s/.test(scope))) throw unsupported();
    const value = await jsonRequest(issuer.replace(/\/$/, '') + '/.well-known/oauth-authorization-server');
    if (value.issuer !== issuer || !Array.isArray(value.code_challenge_methods_supported) || !value.code_challenge_methods_supported.includes('S256') || !Array.isArray(value.token_endpoint_auth_methods_supported) || !value.token_endpoint_auth_methods_supported.includes('none')) throw unsupported();
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
      if (field === 'revocation_endpoint' && !value[field]) continue;
      if (!address(value[field]) || new URL(value[field]).origin !== new URL(issuer).origin) throw unsupported();
    }
    const scopes = [...new Set([...protectedResource.scopes_supported, ...(Array.isArray(value.scopes_supported) && value.scopes_supported.includes('offline_access') ? ['offline_access'] : [])])];
    metadata = { ...value, mcpUrl: url, scopes: scopes.join(' ') };
    return metadata;
  }
  async function registration(url, redirectUri, meta) {
    if (client?.mcpUrl === url && client.redirectUri === redirectUri) return client;
    const file = path.join(directory, 'client.json');
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.mcpUrl === url && stored.redirectUri === redirectUri && stored.client_id) return (client = stored);
    } catch (err) { if (err.code !== 'ENOENT') throw fail('HOST_UNAVAILABLE'); }
    const value = await jsonRequest(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Open Creative Director', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    if (typeof value.client_id !== 'string' || !value.client_id || value.client_secret || (value.token_endpoint_auth_method && value.token_endpoint_auth_method !== 'none')) throw fail('HOST_UNAVAILABLE', 'Der Website-Host unterstützt die automatische Anmeldung nicht.');
    key();
    client = { client_id: value.client_id, redirectUri, mcpUrl: url };
    fs.writeFileSync(file, JSON.stringify(client), { mode: 0o600 });
    return client;
  }
  async function tokenRequest(url, params) {
    const meta = await discovery(url);
    const value = await jsonRequest(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, resource: url }).toString() });
    if (typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0 || (value.token_type && value.token_type.toLowerCase() !== 'bearer')) throw fail('HOST_AUTH');
    return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: now() + Number(value.expires_in) * 1000 };
  }
  function start(email, redirectUri) {
    return serial(async () => {
      const url = requiredResource();
      const owner = normalizeEmail(email);
      // Local mode has no account identity; connectedBy remains null there.
      if (email != null && !owner) throw fail('HOST_AUTH');
      if (!address(redirectUri)) throw fail('HOST_UNAVAILABLE', 'Die Rücksprungadresse für den Website-Host ist ungültig.');
      const meta = await discovery(url);
      const registered = await registration(url, redirectUri, meta);
      for (const [state, p] of pending) if (p.owner === owner || p.expires < now()) pending.delete(state);
      if (pending.size >= 1000) throw fail('HOST_UNAVAILABLE');
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      pending.set(state, { owner, verifier, redirectUri, clientId: registered.client_id, mcpUrl: url, issuer: meta.issuer, expires: now() + 600000 });
      const auth = new URL(meta.authorization_endpoint);
      Object.entries({ client_id: registered.client_id, redirect_uri: redirectUri, response_type: 'code', scope: meta.scopes, state, resource: url, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => auth.searchParams.set(k, v));
      return { authorizationUrl: auth.toString() };
    });
  }
  function complete(email, { state, code, error, iss } = {}) {
    return serial(async () => {
      const url = requiredResource();
      const owner = normalizeEmail(email);
      const p = pending.get(state);
      if (!p || p.owner !== owner || p.mcpUrl !== url || p.expires <= now() || (email != null && !owner)) throw fail('HOST_AUTH', 'Diese Anmeldung beim Website-Host ist ungültig oder abgelaufen. Bitte erneut verbinden.');
      pending.delete(state);
      if (error || typeof code !== 'string' || !code || (iss && iss !== p.issuer)) throw fail('HOST_AUTH');
      const tokens = await tokenRequest(url, { grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: p.clientId });
      write({ ...tokens, client_id: p.clientId, mcpUrl: url, connectedBy: owner, connectedAt: new Date(now()).toISOString() });
      return { connected: true };
    });
  }
  async function refresh(url, tokens) {
    if (!tokens.refresh_token) throw fail('HOST_AUTH');
    try {
      const fresh = await tokenRequest(url, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client_id });
      const updated = { ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token };
      write(updated);
      return updated;
    } catch (_) { throw fail('HOST_AUTH'); }
  }
  async function mcp(url, token, name, args) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    async function rpc(method, params, id) {
      const response = await request(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) }, method === 'tools/call' ? 120000 : 30000);
      const session = response.headers.get('mcp-session-id');
      if (session) headers['Mcp-Session-Id'] = session;
      if (!id) { await response.body?.cancel(); return; }
      const data = await responseData(response, id);
      if (data.id !== id || data.error || data.result?.isError || !Object.hasOwn(data, 'result')) {
        const said = data.error?.message || data.result?.content?.find(block => block?.type === 'text')?.text || '';
        throw Object.assign(fail('HOST_REFUSED'), { detail: String(said).replace(/\s+/g, ' ').trim().slice(0, 300) });
      }
      return data.result;
    }
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'open-creative-director', version: '1.0.0' } }, 1);
    if (!init?.protocolVersion) throw fail('HOST_UNAVAILABLE');
    headers['MCP-Protocol-Version'] = init.protocolVersion;
    await rpc('notifications/initialized', {}, null);
    const result = await rpc('tools/call', { name, arguments: args }, 2);
    if (result && Object.hasOwn(result, 'structuredContent')) return result.structuredContent;
    const text = result?.content?.find(block => block?.type === 'text')?.text || '';
    try { return JSON.parse(text); } catch (_) { return { text }; }
  }
  function call(name, args = {}) {
    validateArgs(args);
    // Snapshot before waiting for the lock so callers cannot add credential fields later.
    const argumentsCopy = JSON.parse(JSON.stringify(args));
    validateArgs(argumentsCopy);
    return serial(async () => {
      const url = requiredResource();
      let tokens = read(url);
      if (!tokens) throw fail('HOST_NOT_CONNECTED');
      let refreshed = false;
      if (tokens.expires_at <= now() + 60000) { tokens = await refresh(url, tokens); refreshed = true; }
      try { return await mcp(url, tokens.access_token, name, argumentsCopy); }
      catch (err) {
        if (err.code !== 'HOST_AUTH' || refreshed) throw err;
        tokens = await refresh(url, tokens);
        return mcp(url, tokens.access_token, name, argumentsCopy);
      }
    });
  }
  return {
    enabled: () => Boolean(resource()), start, complete, call,
    status() {
      const url = resource();
      let tokens = null;
      // An unreadable connection file counts as not connected, so an admin can simply connect again.
      try { tokens = url ? read(url) : null; } catch (_) { tokens = null; }
      return { enabled: Boolean(url), connected: Boolean(tokens), connectedAt: tokens?.connectedAt || null, connectedBy: tokens?.connectedBy || null };
    },
    disconnect() {
      return serial(async () => {
        const url = requiredResource();
        pending.clear();
        try {
          const tokens = read(url);
          if (tokens) {
            const meta = await discovery(url);
            if (meta.revocation_endpoint) await jsonOrEmptyRevoke(meta.revocation_endpoint, tokens);
          }
        } catch (_) { /* Revocation is best effort; local removal always wins. */ }
        fs.rmSync(connectionFile, { force: true });
        return { connected: false };
      });
    }
  };
  async function jsonOrEmptyRevoke(endpoint, tokens) {
    const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token || tokens.access_token, token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token', client_id: tokens.client_id }).toString() });
    await response.body?.cancel();
  }
}
let instance;
module.exports = { createRtkHost, get defaultHost() { return instance || (instance = createRtkHost()); } };
