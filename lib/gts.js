'use strict';

// Optionale Anbindung an ein Ground Truth System (GTS).
// Brains werden pro Session als Wissenskontext angehaengt und fliessen in den System-Prompt.

const DEFAULT_BASE_URL = 'https://gts.kuble.com/api/chatgpt';
const BRAIN_ID_PATTERN = /^[a-z0-9-]+(?:\.[^\s./]+){2,}$/;
const TIMEOUT_MS = 15000;
const ASSET_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_ASSET_BYTES = 30 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

// base URL + id -> { brain, expires }
const brainCache = new Map();
// asset origin + id -> { assets, expires }
const assetCache = new Map();

function hasToken() {
  return Boolean(String(process.env.GTS_API_TOKEN || '').trim());
}

function baseUrl() {
  const configured = String(process.env.GTS_BASE_URL || '').trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function assetOrigin() {
  try {
    const url = new URL(baseUrl());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.origin;
  } catch (_) {
    throw new Error('GTS_BASE_URL ist keine gueltige URL.');
  }
}

function requireToken() {
  const token = String(process.env.GTS_API_TOKEN || '').trim();
  if (!token) throw new Error('Kein GTS_API_TOKEN gesetzt. Unter ⚙️ Einstellungen hinterlegen.');
  return token;
}

// Entfernt den Token aus beliebigem Text, bevor er in einer Fehlermeldung landen kann.
function scrubToken(text) {
  const token = String(process.env.GTS_API_TOKEN || '').trim();
  const msg = String(text || '');
  return token ? msg.split(token).join('[GTS-TOKEN]') : msg;
}

// Sprechende Fehler statt roher HTTP-Codes; der Token darf nie in einer Meldung landen.
function describeError(status, body) {
  const code = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401 || status === 403 || code === 'UNAUTHORIZED') return 'GTS-Zugriff verweigert - Token ungueltig oder abgelaufen.';
  if (status === 404 || code === 'NOT_FOUND') return 'Brain wurde im GTS nicht gefunden.';
  if (status === 400 || code === 'INVALID_ID') return 'Ungueltige Brain-ID.';
  return `GTS antwortete mit HTTP ${status}${code ? ` (${code})` : ''}.`;
}

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${requireToken()}`, Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('GTS antwortet nicht (Timeout nach 15s).');
    throw new Error(`GTS nicht erreichbar: ${scrubToken(err.message)}`);
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* kein JSON - unten als HTTP-Fehler behandelt */
  }
  if (!res.ok) {
    const err = new Error(describeError(res.status, body));
    err.status = res.status;
    throw err;
  }
  if (!body) throw new Error('GTS lieferte keine gueltige JSON-Antwort.');
  return body;
}

async function search(q, limit = 20) {
  const query = String(q || '').trim();
  if (!query) return [];
  const body = await request(`/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`);
  const matches = Array.isArray(body.matches) ? body.matches : [];
  return matches.map((m) => ({
    id: m.id,
    title: m.title || m.id,
    category: m.category || '',
    tags: Array.isArray(m.tags) ? m.tags : []
  }));
}

function brainIdFromQuery(q) {
  const query = String(q || '').trim();
  if (BRAIN_ID_PATTERN.test(query)) return query;

  try {
    const url = new URL(query);
    if (url.origin !== assetOrigin()) return '';
    const match = /^\/brains\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return '';
    const id = decodeURIComponent(match[1]);
    return BRAIN_ID_PATTERN.test(id) ? id : '';
  } catch (_) {
    return '';
  }
}

function summaryFromBrain(brain, fallbackId) {
  const id = brain?.id || fallbackId;
  return {
    id,
    title: brain?.title || id,
    category: brain?.category || brain?.frontmatter?.category || String(id || '').split('.')[1] || ''
  };
}

async function smartSearch(q, limit = 20, client = { search, getBrain }) {
  const query = String(q || '').trim();
  if (!query) return [];

  const brainId = brainIdFromQuery(query);
  const variant = query.includes('-') ? query.replace(/-/g, ' ') : '';
  const directPromise = brainId
    ? client.getBrain(brainId).then((brain) => [summaryFromBrain(brain, brainId)]).catch(() => [])
    : Promise.resolve([]);
  const originalPromise = client.search(query, limit);
  const variantPromise = variant && variant !== query
    ? client.search(variant, limit).catch(() => [])
    : Promise.resolve([]);

  const [directMatches, originalMatches, variantMatches] = await Promise.all([
    directPromise,
    originalPromise,
    variantPromise
  ]);
  const merged = [];
  const seen = new Set();
  for (const match of [...directMatches, ...originalMatches, ...variantMatches]) {
    if (!match?.id || seen.has(match.id)) continue;
    seen.add(match.id);
    merged.push(match);
    if (merged.length >= limit) break;
  }
  return merged;
}

// Antwortform: { id, title, frontmatter, body }
async function getBrain(id) {
  const key = String(id || '');
  if (!key) throw new Error('Ungueltige Brain-ID.');

  const cacheKey = `${baseUrl()}\n${key}`;
  const cached = brainCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.brain;

  const body = await request(`/brains/${encodeURIComponent(key)}`);
  const brain = {
    id: body.id || key,
    title: body.title || body.id || key,
    category: body.category || body.frontmatter?.category || '',
    frontmatter: body.frontmatter && typeof body.frontmatter === 'object' ? body.frontmatter : {},
    body: typeof body.body === 'string' ? body.body : ''
  };
  brainCache.set(cacheKey, { brain, expires: Date.now() + CACHE_TTL_MS });
  return brain;
}

function assetListUrl(brainId) {
  return `${assetOrigin()}/api/brains/${encodeURIComponent(brainId)}/assets`;
}

function assetDownloadUrl(brainId, assetId) {
  return `${assetListUrl(brainId)}/${encodeURIComponent(assetId)}`;
}

// Die GTS-Webroute liefert aktuell DB-Feldnamen. Hier werden sie auf den
// stabilen Vertrag normalisiert, den Brain-Kontext und Director-Tool brauchen.
function normaliseAsset(raw, brainId) {
  if (!raw || typeof raw !== 'object' || typeof raw.filename !== 'string' || !raw.filename) return null;
  const size = Number(raw.size);
  if (!Number.isFinite(size) || size < 0) return null;
  const mimeType = typeof raw.mimeType === 'string'
    ? raw.mimeType
    : typeof raw.mime_type === 'string'
      ? raw.mime_type
      : null;
  const url = typeof raw.url === 'string' && raw.url
    ? raw.url
    : typeof raw.id === 'string' && raw.id
      ? assetDownloadUrl(brainId, raw.id)
      : '';
  if (!url.startsWith(`${assetOrigin()}/`)) return null;
  return { filename: raw.filename, size, mimeType, url };
}

async function listAssets(brainId) {
  const key = String(brainId || '').trim();
  if (!key) throw new Error('Ungueltige Brain-ID.');

  const cacheKey = `${assetOrigin()}\n${key}`;
  const cached = assetCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.assets;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(assetListUrl(key), {
      headers: { Authorization: `Bearer ${requireToken()}`, Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('GTS antwortet nicht (Timeout nach 15s).');
    throw new Error(`GTS nicht erreichbar: ${scrubToken(err.message)}`);
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* kein JSON - unten als HTTP-Fehler behandelt */
  }
  if (!res.ok) {
    const err = new Error(describeError(res.status, body));
    err.status = res.status;
    throw err;
  }
  if (!body || !Array.isArray(body.assets)) {
    throw new Error('GTS lieferte keine gueltige Asset-Liste.');
  }

  const assets = body.assets.map((asset) => normaliseAsset(asset, key)).filter(Boolean);
  assetCache.set(cacheKey, { assets, expires: Date.now() + CACHE_TTL_MS });
  return assets;
}

async function downloadAsset(url) {
  const target = String(url || '');
  if (!target.startsWith(`${assetOrigin()}/`)) {
    throw new Error('GTS-Asset-URL ist nicht erlaubt.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(target, {
      headers: { Authorization: `Bearer ${requireToken()}`, Accept: '*/*' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch (_) {
        /* kein JSON */
      }
      const err = new Error(describeError(res.status, body));
      err.status = res.status;
      throw err;
    }

    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_BYTES) {
      throw new Error('GTS-Asset ist groesser als 30 MB.');
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_ASSET_BYTES) throw new Error('GTS-Asset ist groesser als 30 MB.');
      return buffer;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('GTS-Asset ist groesser als 30 MB.');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('GTS-Asset-Download abgebrochen (Timeout nach 60s).');
    if (err.status || /^GTS-Asset /.test(err.message)) throw err;
    throw new Error(`GTS-Asset konnte nicht heruntergeladen werden: ${scrubToken(err.message)}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  BRAIN_ID_PATTERN,
  hasToken,
  baseUrl,
  assetOrigin,
  search,
  smartSearch,
  getBrain,
  listAssets,
  downloadAsset,
  brainIdFromQuery
};
