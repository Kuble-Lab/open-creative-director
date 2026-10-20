'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('./config');

const MCP_URL = 'https://mcp.magnific.com';
const RESOURCE_METADATA_URL = `${MCP_URL}/.well-known/oauth-protected-resource`;
const OAUTH_SCOPE = 'openid profile email mcp:custom-audience';
const OAUTH_CLIENT_NAME = 'Open Creative Director';
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCESS_LIFETIME_S = 3600;
const AUTH_FILE = path.join(PATHS.root, 'data', 'magnific-auth.json');
const ACCESS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_MCP_TIMEOUT_MS = 90 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const DISCONNECTED_MESSAGE = 'Magnific nicht verbunden — unter Einstellungen verbinden.';

class MagnificError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'MagnificError';
    this.status = status;
  }
}

function createFileTokenStore(file = AUTH_FILE) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new MagnificError('Magnific-Anmeldedaten sind ungueltig oder konnten nicht gelesen werden.');
      }
    },
    async write(value) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temporaryFile = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fsp.chmod(temporaryFile, 0o600);
        await fsp.rename(temporaryFile, file);
        await fsp.chmod(file, 0o600);
      } finally {
        await fsp.rm(temporaryFile, { force: true });
      }
    },
    async remove() {
      await fsp.rm(file, { force: true });
    },
    removeSync() {
      fs.rmSync(file, { force: true });
    }
  };
}

function normaliseTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const accessToken = String(value.access_token || '').trim();
  const refreshToken = String(value.refresh_token || '').trim();
  const accessExpiresAt = Number(value.access_expires_at);
  if (!accessToken || !refreshToken || !Number.isFinite(accessExpiresAt)) return null;
  if (value.auth === 'oauth') {
    // OAuth logins: an unknown refresh expiry is stored as null and means "does not expire".
    const tokenEndpoint = String(value.token_endpoint || '').trim();
    const clientId = String(value.client_id || '').trim();
    const rawRefreshExpiry = value.refresh_expires_at;
    const refreshExpiresAt = rawRefreshExpiry === null || rawRefreshExpiry === undefined ? null : Number(rawRefreshExpiry);
    if (!isHttpsUrl(tokenEndpoint) || !clientId) return null;
    if (refreshExpiresAt !== null && !Number.isFinite(refreshExpiresAt)) return null;
    return {
      auth: 'oauth',
      issuer: String(value.issuer || '').trim(),
      token_endpoint: tokenEndpoint,
      client_id: clientId,
      redirect_uri: String(value.redirect_uri || '').trim(),
      access_token: accessToken,
      access_expires_at: accessExpiresAt,
      refresh_token: refreshToken,
      refresh_expires_at: refreshExpiresAt
    };
  }
  return null;
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch (_) {
    return false;
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function secretEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseMcpPayload(text, contentType = '') {
  const raw = String(text || '');
  if (String(contentType).toLowerCase().includes('text/event-stream')) {
    const events = raw.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'));
    for (const event of events.reverse()) {
      try {
        const payload = JSON.parse(event);
        if (payload && ('result' in payload || 'error' in payload)) return payload;
      } catch (_) { /* An event may be a keepalive or a notification. */ }
    }
    throw new MagnificError('Magnific returned an invalid MCP stream.');
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new MagnificError('Magnific lieferte keine gueltige MCP-Antwort.');
  }
}

function createMagnificClient({ env = process.env, fetchImpl, store, now = () => Date.now() } = {}) {
  const tokenStore = store || createFileTokenStore(env.MAGNIFIC_AUTH_FILE || AUTH_FILE);
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));
  let tokens = normaliseTokens(tokenStore.read?.());
  let pendingOauth = null;
  let discoveryCache = null;
  const registrations = new Map();
  let refreshInFlight = null;
  let rpcId = 0;
  let mcpSession = null;
  let protocolVersion = '2025-03-26';
  let initialized = null;
  let toolsCache = null;
  let epoch = 0;
  let tokenWrites = Promise.resolve();
  function writeTokens(action) {
    const result = tokenWrites.then(action);
    tokenWrites = result.catch(() => {});
    return result;
  }

  async function clearTokens() {
    tokens = null;
    try {
      await writeTokens(() => tokenStore.remove?.());
    } catch (_) {
      /* Keep disconnected even if the token file cannot be removed. */
    }
  }

  // A refresh answer only counts while the token set it was requested for is still the current one. If the admin
  // disconnected (or signed in again) in the meantime, the stale answer is dropped instead of undoing that.
  function staleRefreshResult(current) {
    if (tokens === current) return null;
    if (tokens?.access_token) return tokens.access_token;
    throw new MagnificError(DISCONNECTED_MESSAGE);
  }

  // One HTTP call against an auth server. `json` sends a JSON body, `form` a form-urlencoded one, neither a bare
  // request (GET discovery). `redact` lists secrets that must never appear in an error message.
  async function authFetch(url, { method, json, form, timeoutMs = 30000, allowError = false, redact = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const headers = { Accept: 'application/json' };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    try {
      const response = await fetchRequest(url, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal
      });
      let parsed = {};
      try {
        parsed = JSON.parse(await response.text());
      } catch (_) {
        if (!allowError || response.ok) throw new MagnificError(`Magnific-Auth lieferte HTTP ${response.status} ohne gueltiges JSON.`, response.status);
      }
      if (!response.ok && !allowError) {
        const detail = parsed?.error_description || parsed?.error?.message || parsed?.error || parsed?.message || response.statusText;
        const error = new MagnificError(
          `Magnific OAuth HTTP ${response.status}.`,
          response.status
        );
        if (typeof parsed?.error === 'string') error.oauthError = ['invalid_grant', 'invalid_client', 'access_denied'].includes(parsed.error) ? parsed.error : 'oauth_error';
        throw error;
      }
      return { response, body: parsed };
    } catch (err) {
      if (err instanceof MagnificError) throw err;
      if (controller.signal.aborted) throw new MagnificError('Magnific-Auth hat das Zeitlimit erreicht.');
      throw new MagnificError('Magnific OAuth request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  function sameIssuer(a, b) {
    return String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
  }

  function pickAuthorizationServer(resource) {
    return (resource?.authorization_servers || []).find(isHttpsUrl);
  }

  async function discoverFromNetwork() {
    const { body: resource } = await authFetch(RESOURCE_METADATA_URL, { method: 'GET', timeoutMs: 10000 });
    const issuer = pickAuthorizationServer(resource);
    if (!issuer) throw new MagnificError('Magnific nennt keinen OAuth-Server.');
    const issuerUrl = new URL(issuer);
    const discoveryUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, '')}`;
    let meta;
    const candidates = [...new Set([discoveryUrl, `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
      `${MCP_URL}/.well-known/oauth-authorization-server`])];
    for (const url of candidates) {
      try { ({ body: meta } = await authFetch(url, { timeoutMs: 10000 })); break; }
      catch (_) { /* Some MCP services proxy the authorization metadata on the resource origin. */ }
    }
    if (!meta) throw new MagnificError('Magnific OAuth discovery failed.');
    if (meta?.issuer && !sameIssuer(meta.issuer, issuer)) throw new MagnificError('Magnific-OAuth-Metadaten passen nicht zum Server.');
    const methods = meta?.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw new MagnificError('Magnific-OAuth unterstuetzt kein PKCE S256.');
    const authorizationEndpoint = String(meta?.authorization_endpoint || '').trim();
    const tokenEndpoint = String(meta?.token_endpoint || '').trim();
    const registrationEndpoint = String(meta?.registration_endpoint || '').trim();
    if (![authorizationEndpoint, tokenEndpoint, registrationEndpoint].every(isHttpsUrl)) {
      throw new MagnificError('Magnific-OAuth-Metadaten sind unvollstaendig.');
    }
    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      issParameterSupported: meta?.authorization_response_iss_parameter_supported === true
    };
  }

  async function discoverOauth() {
    if (discoveryCache && discoveryCache.expiresAt > now()) return discoveryCache.value;
    const value = await discoverFromNetwork();
    discoveryCache = { value, expiresAt: now() + DISCOVERY_TTL_MS };
    return value;
  }

  // Dynamic client registration; one registration per issuer and redirect URI is reused.
  async function ensureRegistration(oauth, redirectUri) {
    const key = `${oauth.issuer}\n${redirectUri}`;
    const cached = registrations.get(key);
    if (cached && cached.expiresAt > now()) return cached.clientId;
    const { body } = await authFetch(oauth.registrationEndpoint, {
      json: {
        client_name: OAUTH_CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: OAUTH_SCOPE
      }
    });
    const clientId = String(body?.client_id || '').trim();
    if (!clientId) throw new MagnificError('Magnific lieferte keine Client-ID fuer die Anmeldung.');
    if (Array.isArray(body.redirect_uris) && !body.redirect_uris.includes(redirectUri)) {
      throw new MagnificError('Magnific hat die Rueckkehr-Adresse der Anmeldung nicht uebernommen.');
    }
    registrations.set(key, { clientId, expiresAt: now() + DISCOVERY_TTL_MS });
    return clientId;
  }

  function pendingIsLive() {
    if (pendingOauth && pendingOauth.expiresAt <= now()) pendingOauth = null;
    return Boolean(pendingOauth);
  }

  function refreshIsExpired(value) {
    return value.refresh_expires_at !== null && value.refresh_expires_at <= now();
  }

  // Starts the OAuth login (authorization code + PKCE). The returned `verificationUri` is the authorize URL; the
  // user signs in there and Magnific redirects the browser to `redirectUri` (see completeConnect).
  async function startConnect({ redirectUri } = {}) {
    const target = String(redirectUri || '').trim();
    let parsedTarget = null;
    try {
      parsedTarget = new URL(target);
    } catch (_) {
      /* handled below */
    }
    if (!parsedTarget || !/^https?:$/.test(parsedTarget.protocol) || parsedTarget.hash) {
      throw new MagnificError('Magnific-Anmeldung: Die Rueckkehr-Adresse ist ungueltig.');
    }
    const oauth = await discoverOauth();
    const clientId = await ensureRegistration(oauth, target);
    const verifier = base64Url(crypto.randomBytes(48));
    const state = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const query = Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: target,
      scope: OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: MCP_URL
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    const separator = oauth.authorizationEndpoint.includes('?') ? '&' : '?';
    // A new login replaces any earlier pending one.
    pendingOauth = {
      state,
      verifier,
      redirectUri: target,
      clientId,
      issuer: oauth.issuer,
      issRequired: oauth.issParameterSupported === true,
      tokenEndpoint: oauth.tokenEndpoint,
      registrationKey: `${oauth.issuer}\n${target}`,
      expiresAt: now() + OAUTH_PENDING_TTL_MS
    };
    return {
      verificationUri: `${oauth.authorizationEndpoint}${separator}${query}`,
      expiresIn: Math.round(OAUTH_PENDING_TTL_MS / 1000)
    };
  }

  function buildOauthTokens(body, base, { requireRefresh }) {
    const accessToken = String(body?.access_token || '').trim();
    const refreshToken = String(body?.refresh_token || '').trim() || (requireRefresh ? '' : base.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new MagnificError('Magnific lieferte unvollstaendige Anmeldedaten.');
    }
    const accessLifetime = Number(body?.expires_in);
    const refreshLifetime = body?.refresh_expires_in === undefined || body?.refresh_expires_in === null ? NaN : Number(body.refresh_expires_in);
    return {
      auth: 'oauth',
      issuer: base.issuer,
      token_endpoint: base.token_endpoint,
      client_id: base.client_id,
      redirect_uri: base.redirect_uri,
      access_token: accessToken,
      access_expires_at: now() + (Number.isFinite(accessLifetime) && accessLifetime > 0 ? accessLifetime : DEFAULT_ACCESS_LIFETIME_S) * 1000,
      refresh_token: refreshToken,
      // Magnific sends no refresh expiry: null means "does not expire" (an earlier known value is kept).
      refresh_expires_at: Number.isFinite(refreshLifetime) ? now() + Math.max(0, refreshLifetime) * 1000 : (base.refresh_expires_at ?? null)
    };
  }

  // Finishes the OAuth login with the parameters of the browser callback. Every failure message is a fixed text;
  // nothing from the query string (code, state, description) is echoed.
  async function completeConnect({ code, state, iss, error } = {}) {
    if (!pendingIsLive()) {
      throw new MagnificError('Keine Magnific-Anmeldung offen oder sie ist abgelaufen. Bitte in den Einstellungen erneut verbinden.');
    }
    if (!state || !secretEqual(state, pendingOauth.state)) {
      throw new MagnificError('Die Magnific-Anmeldung passt nicht zur offenen Anfrage (state).');
    }
    const pending = pendingOauth;
    const connectEpoch = epoch;
    // The login is single use: the pending entry is gone before any further step.
    pendingOauth = null;
    if (error) {
      throw new MagnificError(
        String(error) === 'access_denied'
          ? 'Der Zugriff wurde bei Magnific nicht erlaubt.'
          : 'Magnific hat die Anmeldung abgelehnt.'
      );
    }
    // RFC 9207: a server that announces the iss parameter must send it; a callback without it is not accepted.
    if ((pending.issRequired && !iss) || (iss && !sameIssuer(iss, pending.issuer))) {
      throw new MagnificError('Die Magnific-Anmeldung stammt nicht vom erwarteten Server (iss).');
    }
    const authorizationCode = String(code || '').trim();
    if (!authorizationCode) throw new MagnificError('Magnific hat keinen Anmeldecode geliefert.');
    let body;
    try {
      ({ body } = await authFetch(pending.tokenEndpoint, {
        form: {
          grant_type: 'authorization_code',
          code: authorizationCode,
          redirect_uri: pending.redirectUri,
          client_id: pending.clientId,
          code_verifier: pending.verifier,
          resource: MCP_URL
        },
        redact: [authorizationCode, pending.verifier, pending.state]
      }));
    } catch (err) {
      if (err.oauthError === 'invalid_client') registrations.delete(pending.registrationKey);
      throw err;
    }
    const saved = buildOauthTokens(
      body,
      { issuer: pending.issuer, token_endpoint: pending.tokenEndpoint, client_id: pending.clientId, redirect_uri: pending.redirectUri, refresh_expires_at: null },
      { requireRefresh: true }
    );
    await writeTokens(async () => {
      if (connectEpoch !== epoch) throw new MagnificError(DISCONNECTED_MESSAGE);
      await tokenStore.write(saved);
      if (connectEpoch !== epoch) throw new MagnificError(DISCONNECTED_MESSAGE);
      tokens = saved;
      resetMcp();
    });
    return { connected: true };
  }

  // OAuth needs no polling: the browser callback completes the login. This only reports the current state.
  async function pollConnect() {
    if (tokens?.refresh_token && !refreshIsExpired(tokens)) return { connected: true };
    return { connected: false, pending: pendingIsLive() };
  }

  async function refreshOauthTokens() {
    const current = tokens;
    let body;
    try {
      ({ body } = await authFetch(current.token_endpoint, {
        form: {
          grant_type: 'refresh_token',
          refresh_token: current.refresh_token,
          client_id: current.client_id,
          resource: MCP_URL
        },
        redact: [current.refresh_token, current.access_token]
      }));
    } catch (err) {
      if (err.oauthError === 'invalid_grant') {
        // Only end the connection this refresh belonged to, never a newer login.
        const newer = staleRefreshResult(current);
        if (newer) throw new MagnificError(DISCONNECTED_MESSAGE);
        await clearTokens();
        throw new MagnificError(DISCONNECTED_MESSAGE);
      }
      // Network errors, timeouts and server errors do not end the connection.
      throw new MagnificError(`Magnific-Token konnte nicht erneuert werden. ${err.message}`, err.status || 0);
    }
    const saved = buildOauthTokens(body, current, { requireRefresh: false });
    const newer = staleRefreshResult(current);
    if (newer) return newer;
    await writeTokens(async () => {
      if (tokens !== current) throw new MagnificError(DISCONNECTED_MESSAGE);
      await tokenStore.write(saved);
      if (tokens !== current) throw new MagnificError(DISCONNECTED_MESSAGE);
      tokens = saved;
    });
    return saved.access_token;
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!tokens?.refresh_token || refreshIsExpired(tokens)) {
        await clearTokens();
        throw new MagnificError(DISCONNECTED_MESSAGE);
      }
      return refreshOauthTokens();
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function ensureAccessToken({ forceRefresh = false } = {}) {
    if (!tokens || refreshIsExpired(tokens)) {
      await clearTokens();
      throw new MagnificError(DISCONNECTED_MESSAGE);
    }
    if (forceRefresh || tokens.access_expires_at - now() < ACCESS_REFRESH_MARGIN_MS) {
      return refreshAccessToken();
    }
    return tokens.access_token;
  }

  async function disconnect() {
    resetMcp();
    pendingOauth = null;
    await clearTokens();
    return { connected: false };
  }

  function status() {
    const connected = Boolean(tokens?.refresh_token && !refreshIsExpired(tokens));
    if (!connected && tokens) {
      tokens = null;
      try {
        if (tokenStore.removeSync) tokenStore.removeSync();
        else Promise.resolve(tokenStore.remove?.()).catch(() => {});
      } catch (_) {
        /* Expired credentials are disconnected even if removal fails. */
      }
    }
    return {
      connected,
      refreshExpiresAt: connected ? tokens.refresh_expires_at : null,
      pending: pendingIsLive()
    };
  }

  function resetMcp() {
    epoch += 1;
    toolsCache = null;
    initialized = null;
    mcpSession = null;
  }

  // Fixed error messages deliberately exclude remote bodies, signed URLs and token values.
  async function rpc(method, params, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, retry = true, notification = false) {
    const accessToken = await ensureAccessToken();
    const response = await fetchRequest(MCP_URL, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion,
        ...(mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++rpcId }), method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => { throw new MagnificError('Magnific MCP request failed or timed out.'); });
    if (response.status === 401 && retry) {
      await ensureAccessToken({ forceRefresh: true });
      return rpc(method, params, timeoutMs, false, notification);
    }
    if (!response.ok) throw new MagnificError(`Magnific MCP HTTP ${response.status}.`, response.status);
    const session = response.headers?.get?.('mcp-session-id');
    if (session) mcpSession = session;
    if (notification) return null;
    const payload = parseMcpPayload(await response.text(), response.headers?.get?.('content-type'));
    if (payload.error || payload.result?.isError) throw new MagnificError('Magnific MCP rejected the request.');
    return payload.result;
  }

  async function initialize() {
    if (!initialized) {
      const currentEpoch = epoch;
      initialized = (async () => {
        const info = await rpc('initialize', { protocolVersion, capabilities: {},
          clientInfo: { name: 'Open Creative Director', version: '1.5.0' } });
        if (currentEpoch !== epoch) throw new MagnificError(DISCONNECTED_MESSAGE);
        if (typeof info?.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(info.protocolVersion)) protocolVersion = info.protocolVersion;
        await rpc('notifications/initialized', {}, DEFAULT_MCP_TIMEOUT_MS, true, true);
      })().catch((err) => { if (currentEpoch === epoch) initialized = null; throw err; });
    }
    return initialized;
  }

  async function listTools() {
    if (!status().connected) throw new MagnificError(DISCONNECTED_MESSAGE);
    if (toolsCache?.expiresAt > now()) return toolsCache.value;
    await initialize();
    const currentEpoch = epoch;
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new MagnificError('Magnific repeated a catalogue cursor.');
      cursors.add(cursor);
    } while (cursor);
    if (currentEpoch !== epoch) throw new MagnificError(DISCONNECTED_MESSAGE);
    toolsCache = { value: tools, expiresAt: now() + 60 * 60 * 1000 };
    return tools;
  }

  async function mcpCall(name, args, { timeoutMs = DEFAULT_MCP_TIMEOUT_MS, withStructured = false } = {}) {
    await initialize();
    const currentEpoch = epoch;
    const result = await rpc('tools/call', { name, arguments: args || {} }, timeoutMs);
    if (currentEpoch !== epoch) throw new MagnificError(DISCONNECTED_MESSAGE);
    const text = (result?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const structured = result?.structuredContent || null;
    if (withStructured) return { text, structured };
    return structured ? JSON.stringify(structured) : text;
  }

  async function downloadResult(url, { timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
    const target = String(url || '').trim();
    if (!/^https:\/\//i.test(target)) throw new MagnificError('Magnific-Ergebnis-URL ist ungueltig.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchRequest(target, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new MagnificError(`Magnific-Download fehlgeschlagen (HTTP ${response.status}).`, response.status);
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new MagnificError('Magnific result exceeds the download size limit.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new MagnificError('Magnific result exceeds the download size limit.');
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new MagnificError('Magnific lieferte eine leere Ergebnisdatei.');
      if (buffer.length > maxBytes) throw new MagnificError('Magnific result exceeds the download size limit.');
      return { buffer, contentType: response.headers?.get?.('content-type') || '', url: target };
    } catch (err) {
      if (err instanceof MagnificError) throw err;
      if (controller.signal.aborted) throw new MagnificError('Magnific-Download hat nach 60 Sekunden das Zeitlimit erreicht.');
      throw new MagnificError('Magnific download failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listTools,
    initialize,
    startConnect,
    completeConnect,
    pollConnect,
    ensureAccessToken,
    disconnect,
    status,
    mcpCall,
    downloadResult
  };
}

const client = createMagnificClient();

module.exports = {
  MagnificError,
  createFileTokenStore,
  createMagnificClient,
  parseMcpPayload,
  listTools: client.listTools,
  initialize: client.initialize,
  startConnect: client.startConnect,
  completeConnect: client.completeConnect,
  pollConnect: client.pollConnect,
  ensureAccessToken: client.ensureAccessToken,
  disconnect: client.disconnect,
  status: client.status,
  mcpCall: client.mcpCall,
  downloadResult: client.downloadResult,
  AUTH_FILE,
  OAUTH_PENDING_TTL_MS,
  DISCONNECTED_MESSAGE,
  ACCESS_REFRESH_MARGIN_MS,
  DEFAULT_MCP_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES
};
