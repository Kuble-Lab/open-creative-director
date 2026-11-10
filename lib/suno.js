'use strict';

// Personal Suno OAuth credentials. Never fall back to a shared service account.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('./config');
const { normalizeEmail } = require('./access');
const RESOURCE = 'https://api.suno.com/mcp';
const ISSUER = 'https://studio-api-prod.suno.com/api/v2/external/oauth';
const SCOPES = 'api:v0 offline_access profile:read library:read library:search credits:spend download';
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function identity(value) {
  const email = normalizeEmail(value);
  if (!email) throw fail('Bitte zuerst im Creative Director anmelden.', 401);
  return email;
}
function createSuno({ directory = path.join(PATHS.root, 'data', 'suno'), fetchImpl = global.fetch, now = Date.now } = {}) {
  const pending = new Map();
  const locks = new Map();
  let metadata;
  let client;
  function key() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'encryption.key');
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    const value = fs.readFileSync(file);
    if (value.length !== 32) throw fail('Suno-Schlüsselspeicher ist ungültig.', 503);
    return value;
  }
  function filename(owner) { return path.join(directory, crypto.createHash('sha256').update(identity(owner)).digest('hex') + '.json'); }
  function read(owner) {
    let data;
    try { data = JSON.parse(fs.readFileSync(filename(owner), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(data.iv, 'base64'));
    decipher.setAAD(Buffer.from(identity(owner)));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.value, 'base64')), decipher.final()]).toString());
  }
  function write(owner, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(identity(owner)));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const file = filename(owner);
    const temp = file + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  async function serial(owner, fn) {
    owner = identity(owner);
    const previous = locks.get(owner) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn);
    locks.set(owner, task);
    try { return await task; } finally { if (locks.get(owner) === task) locks.delete(owner); }
  }
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(url === RESOURCE ? 65000 : 30000) });
    if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 'Suno-Zugriff abgelehnt. Bitte erneut verbinden.' : 'Suno ist gerade nicht erreichbar. Bitte später erneut versuchen.', response.status === 401 ? 401 : 502);
    return response;
  }
  async function discovery() {
    if (metadata) return metadata;
    const value = await (await request('https://studio-api-prod.suno.com/.well-known/oauth-authorization-server/api/v2/external/oauth')).json();
    if (value.issuer !== ISSUER) throw fail('Unerwarteter Suno-OAuth-Anbieter.', 502);
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      if (!value[field] || !value[field].startsWith(ISSUER + '/')) throw fail('Ungültige Suno-OAuth-Metadaten.', 502);
    }
    metadata = value;
    return value;
  }
  async function registration(redirectUri) {
    if (client?.redirectUri === redirectUri) return client;
    const file = path.join(directory, 'client.json');
    try { const stored = JSON.parse(fs.readFileSync(file, 'utf8')); if (stored.redirectUri === redirectUri && stored.client_id) return (client = stored); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const meta = await discovery();
    const value = await (await request(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Open Creative Director', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
    if (!value.client_id || value.client_secret || (value.token_endpoint_auth_method && value.token_endpoint_auth_method !== 'none')) throw fail('Suno unterstützt diese Client-Anmeldung nicht.', 502);
    key();
    client = { client_id: value.client_id, redirectUri };
    fs.writeFileSync(file, JSON.stringify(client), { mode: 0o600 });
    return client;
  }
  async function tokenRequest(params) {
    const meta = await discovery();
    const value = await (await request(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })).json();
    if (!value.access_token || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) throw fail('Suno hat keine gültigen Zugangsdaten geliefert.', 502);
    return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: now() + Number(value.expires_in) * 1000, scope: value.scope };
  }
  async function start(owner, redirectUri) {
    owner = identity(owner);
    return serial(owner, async () => {
      const meta = await discovery();
      const registered = await registration(redirectUri);
      for (const [state, p] of pending) if (p.owner === owner || p.expires < now()) pending.delete(state);
      if (pending.size >= 1000) throw fail('Zu viele laufende Anmeldungen. Bitte später versuchen.', 429);
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      pending.set(state, { owner, verifier, redirectUri, clientId: registered.client_id, expires: now() + 600000 });
      const url = new URL(meta.authorization_endpoint);
      Object.entries({ client_id: registered.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, state, resource: RESOURCE, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => url.searchParams.set(k, v));
      return { authorizationUrl: url.toString() };
    });
  }
  async function complete(owner, { state, code, error, iss }) {
    owner = identity(owner);
    return serial(owner, async () => {
      const p = pending.get(state);
      if (!p || p.owner !== owner || p.expires < now()) throw fail('Diese Suno-Anmeldung ist ungültig oder abgelaufen. Bitte erneut verbinden.');
      pending.delete(state);
      if (error || !code || (iss && iss !== ISSUER)) throw fail('Suno-Anmeldung wurde nicht abgeschlossen.');
      const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: p.clientId, resource: RESOURCE });
      write(owner, { ...tokens, client_id: p.clientId });
      return { connected: true };
    });
  }
  async function accessToken(owner) {
    const tokens = read(owner);
    if (!tokens) throw fail('Bitte dein Suno-Konto verbinden.', 409);
    if (tokens.expires_at > now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) throw fail('Bitte dein Suno-Konto erneut verbinden.', 401);
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client_id, resource: RESOURCE });
    write(owner, { ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token });
    return fresh.access_token;
  }
  async function mcpCall(owner, name, args = {}) {
    return serial(owner, async () => {
      const token = await accessToken(owner);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      async function rpc(method, params, id) {
        const response = await request(RESOURCE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
        const session = response.headers.get('mcp-session-id');
        if (session) headers['Mcp-Session-Id'] = session;
        if (!id) { await response.body?.cancel(); return; }
        let data;
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '', size = 0;
          try {
            while (!data) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 2 * 1024 * 1024) throw fail('Suno-Antwort ist zu gross.', 502);
              buffer += decoder.decode(value, { stream: true });
              let match;
              while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                const lines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!lines) continue;
                const item = JSON.parse(lines);
                if (item.id === id) { data = item; break; }
              }
            }
          } finally { await reader.cancel(); }
        } else data = await response.json();
        if (!data || data.error || data.result?.isError) throw fail('Suno konnte diese Anfrage nicht ausführen.', 502);
        return data.result;
      }
      const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'open-creative-director', version: '1.0.0' } }, 1);
      headers['MCP-Protocol-Version'] = init.protocolVersion;
      await rpc('notifications/initialized', {}, null);
      return rpc('tools/call', { name, arguments: args }, 2);
    });
  }
  return {
    start, complete, mcpCall,
    status(owner) { return { connected: Boolean(read(identity(owner))) }; },
    disconnect(owner) { return serial(owner, async () => {
      for (const [state, p] of pending) if (p.owner === identity(owner)) pending.delete(state);
      fs.rmSync(filename(owner), { force: true });
      return { connected: false };
    }); }
  };
}
const defaultSuno = createSuno();
module.exports = { createSuno, defaultSuno, RESOURCE, ISSUER };
