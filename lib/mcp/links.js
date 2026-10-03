'use strict';

// Links of the agent access.
//
// Result links  /mcp/files/<token>   24 hours, for exactly one file, without a login
//   The token is signed (HMAC-SHA256) and names the session, the file and the expiry. The server keeps nothing per link, so
//   links survive a restart and need no clean-up. A changed token (another file, a later expiry) does not verify. The
//   signing secret lives in data/mcp-link-secret (mode 0600) and is made on first use.
//
// Upload links  PUT /mcp/upload/<token>   15 minutes, one use, for a file the agent announced (name and type)
//   The token is random; the server keeps the link in memory (a restart ends open links) and burns it when the upload
//   starts. The link belongs to a key: it stops working when the key is revoked or its person may no longer use it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PATHS } = require('../config');
const store = require('../store');

const SECRET_FILE = path.join(PATHS.root, 'data', 'mcp-link-secret');
const FILE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_OPEN_UPLOAD_LINKS = 20; // per key
const MAC_BYTES = 16;

// Files a result link may hand out (media a run makes). Nothing else is served, SVG and HTML least of all.
const FILE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.glb': 'model/gltf-binary'
});
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

function loadSecret(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, 'hex');
  } catch (_) {
    /* made below */
  }
  const secret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${secret.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // links still work until the next restart
    console.warn('[mcp] Das Geheimnis für Ergebnis-Links konnte nicht gespeichert werden:', err.code || 'Fehler');
  }
  return secret;
}

function contentTypeOf(file) {
  return FILE_TYPES[path.extname(String(file || '')).toLowerCase()] || null;
}

// The address of a link: the public base URL (the app may run under a path) plus the path.
function linkUrl(base, pathname) {
  return `${String(base || '').replace(/\/+$/, '')}${pathname}`;
}

/* ---------- result links ---------- */

function createFileLinks({ secretFile = SECRET_FILE, ttlMs = FILE_LINK_TTL_MS, now = Date.now } = {}) {
  let secret = null;
  const key = () => {
    if (!secret) secret = loadSecret(secretFile);
    return secret;
  };
  const mac = (payload) => crypto.createHmac('sha256', key()).update(`ocd-mcp-file-v1.${payload}`).digest().subarray(0, MAC_BYTES);

  // { token, expiresAt } or null for a file that may not be handed out
  function sign({ sessionId, file }) {
    if (!store.isValidId(sessionId) || typeof file !== 'string' || !SAFE_FILE.test(file) || !contentTypeOf(file)) return null;
    const expires = now() + ttlMs;
    const payload = Buffer.from(JSON.stringify({ s: sessionId, f: file, e: expires }), 'utf8').toString('base64url');
    return { token: `${payload}.${mac(payload).toString('base64url')}`, expiresAt: new Date(expires).toISOString() };
  }

  // { ok: true, sessionId, file, contentType } | { ok: false, reason: 'invalid' | 'expired' }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'invalid' };
    const [payload, given] = token.split('.');
    const expected = mac(payload);
    const presented = Buffer.from(given, 'base64url');
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return { ok: false, reason: 'invalid' };
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (_) {
      return { ok: false, reason: 'invalid' };
    }
    const contentType = data && typeof data.f === 'string' ? contentTypeOf(data.f) : null;
    if (!data || !store.isValidId(data.s) || typeof data.f !== 'string' || !SAFE_FILE.test(data.f) || !contentType || !Number.isFinite(data.e)) {
      return { ok: false, reason: 'invalid' };
    }
    if (data.e <= now()) return { ok: false, reason: 'expired' };
    return { ok: true, sessionId: data.s, file: data.f, contentType };
  }

  return { sign, verify, ttlMs };
}

/* ---------- upload links ---------- */

function createUploadLinks({ ttlMs = UPLOAD_LINK_TTL_MS, maxOpenPerKey = MAX_OPEN_UPLOAD_LINKS, now = Date.now } = {}) {
  const links = new Map(); // sha256 of the token -> { keyId, filename, mimeType, expiresAt, used }
  const hashOf = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

  function purge() {
    const at = now();
    for (const [id, link] of links) if (link.expiresAt <= at) links.delete(id);
  }

  // { token, expiresAt } or { error: 'TOO_MANY_LINKS' }
  function issue({ keyId, filename, mimeType }) {
    purge();
    let open = 0;
    for (const link of links.values()) if (link.keyId === keyId && !link.used) open += 1;
    if (open >= maxOpenPerKey) return { error: 'TOO_MANY_LINKS' };
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + ttlMs;
    links.set(hashOf(token), { keyId, filename, mimeType, expiresAt, used: false });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  // { ok: true, link } | { ok: false, reason: 'invalid' | 'expired' | 'used' }; does not burn the link
  function look(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'invalid' };
    const link = links.get(hashOf(token));
    if (!link) return { ok: false, reason: 'invalid' };
    if (link.expiresAt <= now()) {
      links.delete(hashOf(token));
      return { ok: false, reason: 'expired' };
    }
    if (link.used) return { ok: false, reason: 'used' };
    return { ok: true, link: { ...link } };
  }

  // Burns the link: true for the first caller, false for everybody after.
  function consume(token) {
    const link = links.get(hashOf(token));
    if (!link || link.used || link.expiresAt <= now()) return false;
    link.used = true;
    return true;
  }

  return { issue, look, consume, ttlMs, get size() { purge(); return links.size; } };
}

module.exports = {
  SECRET_FILE,
  FILE_LINK_TTL_MS,
  UPLOAD_LINK_TTL_MS,
  MAX_OPEN_UPLOAD_LINKS,
  FILE_TYPES,
  contentTypeOf,
  linkUrl,
  createFileLinks,
  createUploadLinks
};
