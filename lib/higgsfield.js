'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('./config');

const DEVICE_AUTH_BASE = 'https://fnf-device-auth.higgsfield.ai';
const MCP_URL = 'https://mcp.higgsfield.ai/mcp';
const RESOURCE_METADATA_URL = 'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp';
// Fallback when discovery fails (verified live 2026-09-29): Clerk is the OAuth authorisation server of the MCP.
const OAUTH_FALLBACK = Object.freeze({
  issuer: 'https://clerk.higgsfield.ai',
  authorizationEndpoint: 'https://clerk.higgsfield.ai/oauth/authorize',
  tokenEndpoint: 'https://clerk.higgsfield.ai/oauth/token',
  registrationEndpoint: 'https://clerk.higgsfield.ai/oauth/register',
  issParameterSupported: true
});
const OAUTH_SCOPE = 'openid email offline_access';
const OAUTH_CLIENT_NAME = 'Open Creative Director';
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_FALLBACK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_LIFETIME_S = 3600;
const AUTH_FILE = path.join(PATHS.root, 'data', 'higgsfield-auth.json');
const ACCESS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_MCP_TIMEOUT_MS = 90 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_PATTERN = /https:\/\/[^\s<>"'\])}]+/gi;
const DISCONNECTED_MESSAGE = 'Higgsfield nicht verbunden — unter Einstellungen verbinden.';

class HiggsfieldError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HiggsfieldError';
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
        throw new HiggsfieldError('Higgsfield-Anmeldedaten sind ungueltig oder konnten nicht gelesen werden.');
      }
    },
    async write(value) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temporaryFile = `${file}.tmp`;
      await fsp.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsp.chmod(temporaryFile, 0o600);
      await fsp.rename(temporaryFile, file);
      await fsp.chmod(file, 0o600);
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
  // Legacy device-flow tokens (no `auth` field): both expiries are mandatory.
  const refreshExpiresAt = Number(value.refresh_expires_at);
  if (value.refresh_expires_at === null || value.refresh_expires_at === undefined || !Number.isFinite(refreshExpiresAt)) return null;
  return {
    access_token: accessToken,
    access_expires_at: accessExpiresAt,
    refresh_token: refreshToken,
    refresh_expires_at: refreshExpiresAt
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
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

function redactSecrets(text, secrets) {
  let result = String(text ?? '');
  for (const secret of secrets || []) {
    const value = String(secret || '');
    if (value.length >= 4) result = result.split(value).join('[entfernt]');
  }
  return result;
}

function extractJobIds(text) {
  return [...new Set(String(text || '').match(UUID_PATTERN) || [])];
}

function extractUrls(text) {
  return [...new Set((String(text || '').match(URL_PATTERN) || []).map((url) => url.replace(/[.,;:!?]+$/, '')))];
}

function parseJobStatus(text) {
  const value = String(text || '');
  const statusMatch = value.match(/\b(completed|failed|ip_detected|nsfw|in_progress|pending|queued|processing|running)\b/i);
  return {
    status: statusMatch ? statusMatch[1].toLowerCase() : 'pending',
    urls: extractUrls(value),
    text: value
  };
}

function parseMcpPayload(text, contentType = '') {
  const raw = String(text || '');
  if (String(contentType).toLowerCase().includes('text/event-stream')) {
    const dataLines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    if (!dataLines.length) throw new HiggsfieldError('Higgsfield lieferte einen leeren MCP-Stream.');
    try {
      return JSON.parse(dataLines[dataLines.length - 1]);
    } catch (_) {
      throw new HiggsfieldError('Higgsfield lieferte einen ungueltigen MCP-Stream.');
    }
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new HiggsfieldError('Higgsfield lieferte keine gueltige MCP-Antwort.');
  }
}

function createHiggsfieldClient({ env = process.env, fetchImpl, store, now = () => Date.now() } = {}) {
  const tokenStore = store || createFileTokenStore(env.HIGGSFIELD_AUTH_FILE || AUTH_FILE);
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));
  let tokens = normaliseTokens(tokenStore.read?.());
  let pendingOauth = null;
  let discoveryCache = null;
  const registrations = new Map();
  let refreshInFlight = null;
  let rpcId = 0;

  async function clearTokens() {
    tokens = null;
    try {
      await tokenStore.remove?.();
    } catch (_) {
      /* Der Verbindungsstatus bleibt auch bei einem Dateisystemfehler getrennt. */
    }
  }

  // A refresh answer only counts while the token set it was requested for is still the current one. If the admin
  // disconnected (or signed in again) in the meantime, the stale answer is dropped instead of undoing that.
  function staleRefreshResult(current) {
    if (tokens === current) return null;
    if (tokens?.access_token) return tokens.access_token;
    throw new HiggsfieldError(DISCONNECTED_MESSAGE);
  }

  async function persistTokenPair(body, current) {
    const accessToken = String(body?.access_token || '').trim();
    const refreshToken = String(body?.refresh_token || '').trim();
    const accessLifetime = Number(body?.expires_in);
    const refreshLifetime = Number(body?.refresh_expires_in);
    if (!accessToken || !refreshToken || !Number.isFinite(accessLifetime) || !Number.isFinite(refreshLifetime)) {
      throw new HiggsfieldError('Higgsfield lieferte unvollstaendige Anmeldedaten.');
    }
    const saved = {
      access_token: accessToken,
      access_expires_at: now() + Math.max(0, accessLifetime) * 1000,
      refresh_token: refreshToken,
      refresh_expires_at: now() + Math.max(0, refreshLifetime) * 1000
    };
    if (current !== undefined && tokens !== current) return null;
    await tokenStore.write(saved);
    tokens = saved;
    return saved;
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
        signal: controller.signal
      });
      let parsed = {};
      try {
        parsed = JSON.parse(await response.text());
      } catch (_) {
        if (!allowError || response.ok) throw new HiggsfieldError(`Higgsfield-Auth lieferte HTTP ${response.status} ohne gueltiges JSON.`, response.status);
      }
      if (!response.ok && !allowError) {
        const detail = parsed?.error_description || parsed?.error?.message || parsed?.error || parsed?.message || response.statusText;
        const error = new HiggsfieldError(
          `Higgsfield-Auth fehlgeschlagen (HTTP ${response.status}): ${redactSecrets(String(detail), redact).slice(0, 500)}`,
          response.status
        );
        if (typeof parsed?.error === 'string') error.oauthError = parsed.error;
        throw error;
      }
      return { response, body: parsed };
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      if (controller.signal.aborted) throw new HiggsfieldError('Higgsfield-Auth hat das Zeitlimit erreicht.');
      throw new HiggsfieldError(`Higgsfield-Auth fehlgeschlagen: ${redactSecrets(err.message, redact)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function fetchJson(url, body, options = {}) {
    return authFetch(url, { ...options, json: body });
  }

  function sameIssuer(a, b) {
    return String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
  }

  function pickAuthorizationServer(resource) {
    const servers = (Array.isArray(resource?.authorization_servers) ? resource.authorization_servers : [])
      .map((entry) => String(entry || '').trim().replace(/\/+$/, ''))
      .filter(isHttpsUrl);
    const options = Array.isArray(resource?.higgsfield_auth_hints?.options) ? resource.higgsfield_auth_hints.options : [];
    for (const option of options) {
      if (!option || typeof option !== 'object') continue;
      const values = Object.values(option);
      if (!values.some((value) => value === 'authorization_code_pkce')) continue;
      const match = values
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().replace(/\/+$/, ''))
        .find((value) => servers.includes(value));
      if (match) return match;
    }
    return servers.find((server) => !/fnf-device-auth/i.test(server)) || null;
  }

  async function discoverFromNetwork() {
    const { body: resource } = await authFetch(RESOURCE_METADATA_URL, { method: 'GET', timeoutMs: 10000 });
    const issuer = pickAuthorizationServer(resource);
    if (!issuer) throw new HiggsfieldError('Higgsfield nennt keinen OAuth-Server.');
    const { body: meta } = await authFetch(`${issuer}/.well-known/oauth-authorization-server`, { method: 'GET', timeoutMs: 10000 });
    if (meta?.issuer && !sameIssuer(meta.issuer, issuer)) throw new HiggsfieldError('Higgsfield-OAuth-Metadaten passen nicht zum Server.');
    const methods = meta?.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw new HiggsfieldError('Higgsfield-OAuth unterstuetzt kein PKCE S256.');
    const authorizationEndpoint = String(meta?.authorization_endpoint || '').trim();
    const tokenEndpoint = String(meta?.token_endpoint || '').trim();
    const registrationEndpoint = String(meta?.registration_endpoint || '').trim();
    if (![authorizationEndpoint, tokenEndpoint, registrationEndpoint].every(isHttpsUrl)) {
      throw new HiggsfieldError('Higgsfield-OAuth-Metadaten sind unvollstaendig.');
    }
    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      issParameterSupported: meta?.authorization_response_iss_parameter_supported === true
    };
  }

  // Resource metadata -> authorisation-server metadata, cached for 24 hours. Any failure falls back to the known
  // Clerk endpoints (cached only briefly so that a recovered network is picked up soon).
  async function discoverOauth() {
    if (discoveryCache && discoveryCache.expiresAt > now()) return discoveryCache.value;
    try {
      const value = await discoverFromNetwork();
      discoveryCache = { value, expiresAt: now() + DISCOVERY_TTL_MS };
    } catch (_) {
      discoveryCache = { value: { ...OAUTH_FALLBACK }, expiresAt: now() + DISCOVERY_FALLBACK_TTL_MS };
    }
    return discoveryCache.value;
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
    if (!clientId) throw new HiggsfieldError('Higgsfield lieferte keine Client-ID fuer die Anmeldung.');
    if (Array.isArray(body.redirect_uris) && !body.redirect_uris.includes(redirectUri)) {
      throw new HiggsfieldError('Higgsfield hat die Rueckkehr-Adresse der Anmeldung nicht uebernommen.');
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
  // user signs in there and Higgsfield redirects the browser to `redirectUri` (see completeConnect).
  async function startConnect({ redirectUri } = {}) {
    const target = String(redirectUri || '').trim();
    let parsedTarget = null;
    try {
      parsedTarget = new URL(target);
    } catch (_) {
      /* handled below */
    }
    if (!parsedTarget || !/^https?:$/.test(parsedTarget.protocol) || parsedTarget.hash) {
      throw new HiggsfieldError('Higgsfield-Anmeldung: Die Rueckkehr-Adresse ist ungueltig.');
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
      throw new HiggsfieldError('Higgsfield lieferte unvollstaendige Anmeldedaten.');
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
      // Higgsfield sends no refresh expiry: null means "does not expire" (an earlier known value is kept).
      refresh_expires_at: Number.isFinite(refreshLifetime) ? now() + Math.max(0, refreshLifetime) * 1000 : (base.refresh_expires_at ?? null)
    };
  }

  // Finishes the OAuth login with the parameters of the browser callback. Every failure message is a fixed text;
  // nothing from the query string (code, state, description) is echoed.
  async function completeConnect({ code, state, iss, error } = {}) {
    if (!pendingIsLive()) {
      throw new HiggsfieldError('Keine Higgsfield-Anmeldung offen oder sie ist abgelaufen. Bitte in den Einstellungen erneut verbinden.');
    }
    if (!state || !secretEqual(state, pendingOauth.state)) {
      throw new HiggsfieldError('Die Higgsfield-Anmeldung passt nicht zur offenen Anfrage (state).');
    }
    const pending = pendingOauth;
    // The login is single use: the pending entry is gone before any further step.
    pendingOauth = null;
    if (error) {
      throw new HiggsfieldError(
        String(error) === 'access_denied'
          ? 'Der Zugriff wurde bei Higgsfield nicht erlaubt.'
          : 'Higgsfield hat die Anmeldung abgelehnt.'
      );
    }
    // RFC 9207: a server that announces the iss parameter must send it; a callback without it is not accepted.
    if ((pending.issRequired && !iss) || (iss && !sameIssuer(iss, pending.issuer))) {
      throw new HiggsfieldError('Die Higgsfield-Anmeldung stammt nicht vom erwarteten Server (iss).');
    }
    const authorizationCode = String(code || '').trim();
    if (!authorizationCode) throw new HiggsfieldError('Higgsfield hat keinen Anmeldecode geliefert.');
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
    await tokenStore.write(saved);
    tokens = saved;
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
        if (newer) throw new HiggsfieldError(DISCONNECTED_MESSAGE);
        await clearTokens();
        throw new HiggsfieldError(DISCONNECTED_MESSAGE);
      }
      // Network errors, timeouts and server errors do not end the connection.
      throw new HiggsfieldError(`Higgsfield-Token konnte nicht erneuert werden. ${err.message}`, err.status || 0);
    }
    const saved = buildOauthTokens(body, current, { requireRefresh: false });
    const newer = staleRefreshResult(current);
    if (newer) return newer;
    await tokenStore.write(saved);
    tokens = saved;
    return saved.access_token;
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!tokens?.refresh_token || refreshIsExpired(tokens)) {
        await clearTokens();
        throw new HiggsfieldError(DISCONNECTED_MESSAGE);
      }
      if (tokens.auth === 'oauth') return refreshOauthTokens();
      // Legacy device-flow tokens keep refreshing through the old endpoint until they expire or fail.
      const current = tokens;
      let refreshed;
      try {
        const { body } = await fetchJson(`${DEVICE_AUTH_BASE}/refresh`, { refresh_token: current.refresh_token });
        refreshed = await persistTokenPair(body, current);
      } catch (_) {
        if (tokens === current) await clearTokens();
        throw new HiggsfieldError(DISCONNECTED_MESSAGE);
      }
      return refreshed ? refreshed.access_token : staleRefreshResult(current);
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
      throw new HiggsfieldError(DISCONNECTED_MESSAGE);
    }
    if (forceRefresh || tokens.access_expires_at - now() < ACCESS_REFRESH_MARGIN_MS) {
      return refreshAccessToken();
    }
    return tokens.access_token;
  }

  async function disconnect() {
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
        /* Ein abgelaufener Store gilt unabhaengig vom Dateisystem als getrennt. */
      }
    }
    return {
      connected,
      refreshExpiresAt: connected ? tokens.refresh_expires_at : null,
      pending: pendingIsLive()
    };
  }

  async function mcpRequest(name, args, timeoutMs, allowRetry, withStructured = false) {
    const accessToken = await ensureAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchRequest(MCP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'tools/call',
          params: { name, arguments: args || {} }
        }),
        signal: controller.signal
      });
      if (response.status === 401 && allowRetry) {
        clearTimeout(timer);
        await ensureAccessToken({ forceRefresh: true });
        return mcpRequest(name, args, timeoutMs, false, withStructured);
      }
      const responseText = await response.text();
      if (!response.ok) {
        throw new HiggsfieldError(`Higgsfield MCP fehlgeschlagen (HTTP ${response.status}): ${responseText.slice(0, 600)}`, response.status);
      }
      const payload = parseMcpPayload(responseText, response.headers?.get?.('content-type') || '');
      if (payload?.error) {
        const detail = payload.error.message || JSON.stringify(payload.error);
        throw new HiggsfieldError(`Higgsfield MCP: ${String(detail).slice(0, 1000)}`);
      }
      const text = payload?.result?.content?.find?.((part) => part?.type === 'text' || typeof part?.text === 'string')?.text;
      if (typeof text !== 'string') throw new HiggsfieldError('Higgsfield MCP lieferte kein Text-Ergebnis.');
      if (/^MCP error\s+-?\d+:/i.test(text.trim())) throw new HiggsfieldError(text.trim());
      if (!withStructured) return text;
      const structured = payload.result.structuredContent;
      return { text, structured: structured && typeof structured === 'object' ? structured : null };
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      if (controller.signal.aborted) {
        throw new HiggsfieldError(`Higgsfield MCP hat nach ${Math.round(timeoutMs / 1000)} Sekunden das Zeitlimit erreicht.`);
      }
      throw new HiggsfieldError(`Higgsfield MCP fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves with the first text part. With { withStructured: true } it resolves with { text, structured } instead,
  // `structured` being the structuredContent of the answer (or null): some tools keep paging cursors only there.
  function mcpCall(name, args, { timeoutMs = DEFAULT_MCP_TIMEOUT_MS, withStructured = false } = {}) {
    const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : DEFAULT_MCP_TIMEOUT_MS;
    return mcpRequest(String(name || '').trim(), args, timeout, true, withStructured === true);
  }

  async function downloadResult(url, { timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
    const target = String(url || '').trim();
    if (!/^https:\/\//i.test(target)) throw new HiggsfieldError('Higgsfield-Ergebnis-URL ist ungueltig.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchRequest(target, { method: 'GET', signal: controller.signal });
      if (!response.ok) throw new HiggsfieldError(`Higgsfield-Download fehlgeschlagen (HTTP ${response.status}).`, response.status);
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new HiggsfieldError('Higgsfield-Ergebnis ist groesser als 30 MB.');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new HiggsfieldError('Higgsfield lieferte eine leere Ergebnisdatei.');
      if (buffer.length > maxBytes) throw new HiggsfieldError('Higgsfield-Ergebnis ist groesser als 30 MB.');
      return { buffer, contentType: response.headers?.get?.('content-type') || '', url: target };
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      if (controller.signal.aborted) throw new HiggsfieldError('Higgsfield-Download hat nach 60 Sekunden das Zeitlimit erreicht.');
      throw new HiggsfieldError(`Higgsfield-Download fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
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

const client = createHiggsfieldClient();

module.exports = {
  HiggsfieldError,
  createFileTokenStore,
  createHiggsfieldClient,
  extractJobIds,
  extractUrls,
  parseJobStatus,
  parseMcpPayload,
  startConnect: client.startConnect,
  completeConnect: client.completeConnect,
  pollConnect: client.pollConnect,
  ensureAccessToken: client.ensureAccessToken,
  disconnect: client.disconnect,
  status: client.status,
  mcpCall: client.mcpCall,
  downloadResult: client.downloadResult,
  AUTH_FILE,
  OAUTH_FALLBACK,
  OAUTH_PENDING_TTL_MS,
  DISCONNECTED_MESSAGE,
  ACCESS_REFRESH_MARGIN_MS,
  DEFAULT_MCP_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES
};
