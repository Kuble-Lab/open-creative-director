'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('./config');

const DEVICE_AUTH_BASE = 'https://fnf-device-auth.higgsfield.ai';
const MCP_URL = 'https://mcp.higgsfield.ai/mcp';
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
  const refreshExpiresAt = Number(value.refresh_expires_at);
  if (!accessToken || !refreshToken || !Number.isFinite(accessExpiresAt) || !Number.isFinite(refreshExpiresAt)) return null;
  return {
    access_token: accessToken,
    access_expires_at: accessExpiresAt,
    refresh_token: refreshToken,
    refresh_expires_at: refreshExpiresAt
  };
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
  let pendingDevice = null;
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

  async function persistTokenPair(body) {
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
    await tokenStore.write(saved);
    tokens = saved;
    return saved;
  }

  async function fetchJson(url, body, { timeoutMs = 30000, allowError = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
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
        throw new HiggsfieldError(`Higgsfield-Auth fehlgeschlagen (HTTP ${response.status}): ${String(detail).slice(0, 500)}`, response.status);
      }
      return { response, body: parsed };
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      if (controller.signal.aborted) throw new HiggsfieldError('Higgsfield-Auth hat das Zeitlimit erreicht.');
      throw new HiggsfieldError(`Higgsfield-Auth fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function startConnect() {
    const { body } = await fetchJson(`${DEVICE_AUTH_BASE}/authorize`, {});
    const deviceCode = String(body?.device_code || '').trim();
    const verificationUri = String(body?.verification_uri || '').trim();
    const expiresIn = Number(body?.expires_in);
    if (!deviceCode || !verificationUri || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new HiggsfieldError('Higgsfield lieferte keinen gueltigen Verbindungslink.');
    }
    pendingDevice = { deviceCode, expiresAt: now() + expiresIn * 1000 };
    return { verificationUri, expiresIn };
  }

  async function pollConnect() {
    if (!pendingDevice || pendingDevice.expiresAt <= now()) {
      pendingDevice = null;
      return { connected: false, pending: false };
    }
    const { body } = await fetchJson(
      `${DEVICE_AUTH_BASE}/token`,
      { device_code: pendingDevice.deviceCode },
      { allowError: true }
    );
    if (!body?.access_token) return { connected: false, pending: true };
    await persistTokenPair(body);
    pendingDevice = null;
    return { connected: true };
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!tokens?.refresh_token || tokens.refresh_expires_at <= now()) {
        await clearTokens();
        throw new HiggsfieldError(DISCONNECTED_MESSAGE);
      }
      try {
        const { body } = await fetchJson(`${DEVICE_AUTH_BASE}/refresh`, { refresh_token: tokens.refresh_token });
        await persistTokenPair(body);
        return tokens.access_token;
      } catch (_) {
        await clearTokens();
        throw new HiggsfieldError(DISCONNECTED_MESSAGE);
      }
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function ensureAccessToken({ forceRefresh = false } = {}) {
    if (!tokens || tokens.refresh_expires_at <= now()) {
      await clearTokens();
      throw new HiggsfieldError(DISCONNECTED_MESSAGE);
    }
    if (forceRefresh || tokens.access_expires_at - now() < ACCESS_REFRESH_MARGIN_MS) {
      return refreshAccessToken();
    }
    return tokens.access_token;
  }

  async function disconnect() {
    pendingDevice = null;
    await clearTokens();
    return { connected: false };
  }

  function status() {
    const connected = Boolean(tokens?.refresh_token && tokens.refresh_expires_at > now());
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
      pending: Boolean(pendingDevice && pendingDevice.expiresAt > now())
    };
  }

  async function mcpRequest(name, args, timeoutMs, allowRetry) {
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
        return mcpRequest(name, args, timeoutMs, false);
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
      return text;
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

  function mcpCall(name, args, { timeoutMs = DEFAULT_MCP_TIMEOUT_MS } = {}) {
    const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : DEFAULT_MCP_TIMEOUT_MS;
    return mcpRequest(String(name || '').trim(), args, timeout, true);
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
  pollConnect: client.pollConnect,
  ensureAccessToken: client.ensureAccessToken,
  disconnect: client.disconnect,
  status: client.status,
  mcpCall: client.mcpCall,
  downloadResult: client.downloadResult,
  AUTH_FILE,
  DISCONNECTED_MESSAGE,
  ACCESS_REFRESH_MARGIN_MS,
  DEFAULT_MCP_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES
};
