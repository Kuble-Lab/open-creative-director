'use strict';

// Opaque credentials: only digests are persisted. Keep the latest 20 used refresh digests per connection for replay detection.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('../config');
const { createRateLimiter } = require('./http');
const HOUR = 3600000;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function writeJsonSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* already renamed */ } }
}
const failure = (reason = 'unknown') => ({ ok: false, reason });
function createTokenStore({ keys, file = path.join(PATHS.root, 'data/mcp-oauth-tokens.json'), now = Date.now, random = crypto.randomBytes } = {}) {
  const codes = new Map();
  const refreshLimit = createRateLimiter({ requests: 30, windowMs: HOUR, now });
  const credential = (prefix) => `${prefix}${random(32).toString('base64url')}`;
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data.tokens) || data.tokens.some((t) => !/^[a-f0-9]{64}$/.test(t.hash) || !['access', 'refresh'].includes(t.type) || !Number.isFinite(t.expiresAt))) throw new Error('Invalid token store');
      return data.tokens;
    } catch (err) { if (err.code === 'ENOENT') return []; throw new Error('Token store unavailable'); }
  }
  function save(tokens) {
    const connections = new Map(), counts = new Map();
    // Storage order is issuance/consumption order; walk backwards to retain the newest credentials.
    const retained = tokens.slice().reverse().filter((t) => {
      if (!connections.has(t.keyId)) connections.set(t.keyId, keys.get(t.keyId));
      const connection = connections.get(t.keyId);
      if (t.expiresAt <= now() || !connection || connection.kind !== 'oauth' || connection.status !== 'active') return false;
      const limit = t.type === 'access' ? 5 : t.used ? 20 : Infinity;
      const bucket = `${t.keyId}:${t.type}:${Boolean(t.used)}`;
      const count = (counts.get(bucket) || 0) + 1;
      counts.set(bucket, count);
      return count <= limit;
    }).reverse();
    writeJsonSync(file, { version: 1, tokens: retained });
  }
  function find(tokens, token, type) {
    const digest = hash(token);
    let match = null;
    for (const t of tokens) if (equal(Buffer.from(t.hash, 'hex'), digest) && (!type || t.type === type)) match = t;
    return match;
  }
  function valid(record, resource) {
    if (!record || record.resource !== resource || record.expiresAt <= now()) return failure('expired');
    return keys.authenticateConnection(record.keyId, resource);
  }
  function discardConnection(id) {
    save(load().filter((t) => t.keyId !== id));
    for (const [digest, c] of codes) if (c.keyId === id) codes.delete(digest);
  }
  function revokeConnection(id) {
    const key = keys.get(id);
    if (key && !key.revokedAt) keys.revoke(id, key.owner);
    discardConnection(id);
  }
  function issueCode(data) {
    for (const [digest, c] of codes) if (c.retainUntil <= now()) codes.delete(digest);
    if (codes.size >= 10000) throw new Error('Too many pending codes');
    const token = credential('ocd_ac_');
    codes.set(hash(token).toString('hex'), { ...data, expiresAt: now() + 60000, retainUntil: Date.parse(keys.get(data.keyId).expiresAt), used: false });
    return token;
  }
  function issue(tokens, data) {
    const connection = keys.get(data.keyId);
    const accessToken = credential('ocd_at_'), refreshToken = credential('ocd_rt_');
    const expiry = Date.parse(connection.expiresAt);
    for (const [token, type, expiresAt] of [[accessToken, 'access', Math.min(now() + HOUR, expiry)], [refreshToken, 'refresh', expiry]]) {
      tokens.push({ hash: hash(token).toString('hex'), type, keyId: data.keyId, clientId: data.clientId, resource: data.resource, scope: data.scope, expiresAt, used: false });
    }
    save(tokens);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((Math.min(now() + HOUR, expiry) - now()) / 1000)), refresh_token: refreshToken, scope: data.scope };
  }
  function exchange({ code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }, resource) {
    if (typeof code !== 'string' || !/^ocd_ac_[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const c = codes.get(hash(code).toString('hex'));
    if (!c || c.clientId !== clientId || c.redirectUri !== redirectUri || c.resource !== resource || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(Buffer.from(hash(verifier).toString('base64url')), Buffer.from(c.codeChallenge))) return null;
    if (c.used) { revokeConnection(c.keyId); return null; }
    if (!valid(c, resource).ok) return null;
    c.used = true;
    return issue(load(), c);
  }
  function refresh({ refresh_token: token, client_id: clientId, scope }, resource) {
    if (typeof token !== 'string' || !/^ocd_rt_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokens = load();
    const t = find(tokens, token, 'refresh');
    if (!t || t.clientId !== clientId || t.resource !== resource) return null;
    if (t.used) { revokeConnection(t.keyId); return null; }
    if (!valid(t, resource).ok) return null;
    const wanted = scope === undefined ? t.scope.split(' ') : scope.split(' ').filter(Boolean);
    if (!wanted.length || wanted.some((s) => !t.scope.split(' ').includes(s))) return null;
    const rate = refreshLimit.take(t.keyId);
    if (!rate.allowed) throw Object.assign(new Error('Refresh rate limit reached'), { oauthError: 'temporarily_unavailable', status: 429, retryAfterSeconds: rate.retryAfterSeconds });
    t.used = true;
    tokens.splice(tokens.indexOf(t), 1);
    tokens.push(t);
    return issue(tokens, { ...t, scope: [...new Set(wanted)].join(' ') });
  }
  function authenticate(token, resource) {
    if (typeof token !== 'string' || !/^ocd_at_[A-Za-z0-9_-]{43}$/.test(token)) return failure('malformed');
    try {
      const record = find(load(), token, 'access');
      const auth = valid(record, resource);
      if (auth.ok && !record.scope.split(' ').includes('mcp:start')) auth.key = { ...auth.key, right: 'read' };
      return auth;
    } catch (_) { return failure('unavailable'); }
  }
  function revoke(token, clientId) {
    if (typeof token !== 'string' || !/^ocd_(?:at|rt)_[A-Za-z0-9_-]{43}$/.test(token)) return;
    const t = find(load(), token);
    if (t && (!clientId || t.clientId === clientId)) revokeConnection(t.keyId);
  }
  return { issueCode, exchange, refresh, authenticate, revoke, revokeConnection, discardConnection, file };
}
module.exports = { createTokenStore, writeJsonSync };
