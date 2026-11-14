'use strict';

// Public clients and HTTPS client metadata. Outbound DNS is checked and pinned to prevent rebinding.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const https = require('node:https');
const { PATHS } = require('../config');
const { writeJsonSync } = require('./oauth-tokens');
const MAX_BYTES = 64 * 1024;
const DAY = 86400000;
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];
const invalid = (code = 'invalid_client_metadata') => Object.assign(new Error('Invalid client metadata'), { oauthError: code });

function redirectUri(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value) || value.includes('#')) throw invalid('invalid_redirect_uri');
  let url;
  try { url = new URL(value); } catch (_) { throw invalid('invalid_redirect_uri'); }
  if (/^[a-z]+:\/\/[^/?#]*@/i.test(value) || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname)))) throw invalid('invalid_redirect_uri');
  return value;
}
function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  if (!Array.isArray(value.redirect_uris) || value.redirect_uris.length < 1 || value.redirect_uris.length > 5) throw invalid('invalid_redirect_uri');
  const redirectUris = value.redirect_uris.map(redirectUri);
  const name = value.client_name === undefined ? 'MCP client' : value.client_name;
  if (typeof name !== 'string' || !name.trim() || [...name].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw invalid();
  if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none') throw invalid();
  for (const [field, allowed] of [['grant_types', ['authorization_code', 'refresh_token']], ['response_types', ['code']]]) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || !value[field].length || value[field].some((item) => !allowed.includes(item)))) throw invalid();
  }
  return { name: name.trim(), redirectUris, grantTypes: value.grant_types || ['authorization_code', 'refresh_token'], responseTypes: value.response_types || ['code'] };
}
function redirectMatches(registered, given) {
  if (registered === given) return true;
  try {
    redirectUri(given);
    const a = new URL(registered), b = new URL(given);
    // RFC 8252 permits only a port difference for HTTP loopback callbacks. Preserve all other bytes.
    if (a.protocol !== 'http:' || !LOOPBACK.includes(a.hostname) || a.hostname !== b.hostname || b.protocol !== 'http:') return false;
    const withoutPort = (s) => s.replace(/^(http:\/\/(?:\[[^\]]+\]|[^/:]+))(?::[0-9]+)?(?=\/|\?|$)/, '$1');
    return withoutPort(registered) === withoutPort(given);
  } catch (_) { return false; }
}

const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only native global unicast IPv6; mapped, translated, local, multicast and transition ranges fail closed.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

// The default transport uses exactly the validated addresses, while retaining TLS hostname verification and SNI.
function pinnedFetch(url, { signal, addresses, headers }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal, headers, agent: false,
      lookup(_host, options, callback) {
        const records = addresses.map((item) => ({ address: item.address, family: net.isIP(item.address) }));
        if (options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }
    }, (response) => resolve({ status: response.statusCode, headers: { get: (name) => response.headers[name.toLowerCase()] }, body: response }));
    request.on('error', reject);
  });
}

function createClientStore({ file = path.join(PATHS.root, 'data/mcp-oauth-clients.json'), now = Date.now, random = crypto.randomBytes,
  fetchImpl = pinnedFetch, lookup = dns.lookup, hasConnection = () => false } = {}) {
  const cache = new Map();
  const failures = new Map(), inFlight = new Map();
  function remember(map, id, value) {
    map.delete(id);
    if (map.size >= 500) map.delete(map.keys().next().value);
    map.set(id, value);
  }
  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(value.clients)) throw invalid();
      return value.clients;
    } catch (err) { if (err.code === 'ENOENT') return []; throw invalid(); }
  }
  function register(input) {
    const clean = metadata(input);
    let clients = load().filter((c) => hasConnection(c.id) || now() - Date.parse(c.lastUsedAt || c.createdAt) < 30 * DAY);
    if (clients.length >= 500) {
      const unused = clients.filter((c) => !hasConnection(c.id)).sort((a, b) => Date.parse(a.lastUsedAt || a.createdAt) - Date.parse(b.lastUsedAt || b.createdAt));
      if (!unused.length) throw invalid();
      clients = clients.filter((c) => c.id !== unused[0].id);
    }
    const client = { id: `oc_${random(16).toString('hex')}`, ...clean, createdAt: new Date(now()).toISOString(), lastUsedAt: null, source: 'dcr' };
    clients.push(client);
    writeJsonSync(file, { version: 1, clients });
    return client;
  }
  function touch(id) {
    const clients = load();
    const client = clients.find((c) => c.id === id);
    if (!client || now() - Date.parse(client.lastUsedAt || 0) < 60000) return;
    client.lastUsedAt = new Date(now()).toISOString();
    writeJsonSync(file, { version: 1, clients });
  }
  async function resolve(id) {
    if (typeof id !== 'string' || id.length > 2048) throw invalid();
    if (/^oc_[0-9a-f]{32}$/.test(id)) {
      const client = load().find((c) => c.id === id);
      if (!client || (!hasConnection(id) && now() - Date.parse(client.lastUsedAt || client.createdAt) >= 30 * DAY)) throw invalid();
      return client;
    }
    let url;
    try { url = new URL(id); } catch (_) { throw invalid(); }
    if (id.includes('#') || /^[a-z]+:\/\/[^/?#]*@/i.test(id) || url.protocol !== 'https:' || url.pathname === '/' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw invalid();
    if (cache.get(id)?.until > now()) return cache.get(id).client;
    if (failures.get(id) > now()) throw invalid();
    if (inFlight.has(id)) return inFlight.get(id);
    // Reserve a global slot before DNS or transport work; duplicate URLs share that slot.
    if (inFlight.size >= 4) throw invalid();
    const pending = fetchMetadata(id, url);
    inFlight.set(id, pending);
    return pending;
  }
  async function fetchMetadata(id, url) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(invalid()); }, 5000); timer.unref?.(); });
    try {
      const client = await Promise.race([timeout, (async () => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
        if (controller.signal.aborted || !Array.isArray(addresses) || !addresses.length || !addresses.every((item) => publicAddress(item.address))) throw invalid();
        const response = await fetchImpl(id, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal, addresses });
        if (response.redirected || response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_BYTES) { response.body?.destroy?.(); throw invalid(); }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_BYTES) { controller.abort(); response.body?.destroy?.(); throw invalid(); }
          chunks.push(Buffer.from(chunk));
        }
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (doc.client_id !== id || typeof doc.client_name !== 'string') throw invalid();
        return { id, ...metadata(doc), source: 'cimd' };
      })()]);
      remember(cache, id, { until: now() + 3600000, client });
      failures.delete(id);
      return client;
    } catch (_) {
      remember(failures, id, now() + 60000);
      throw invalid();
    } finally { clearTimeout(timer); inFlight.delete(id); }
  }
  return { register, resolve, touch, file };
}
module.exports = { createClientStore, metadata, redirectUri, redirectMatches, publicAddress, pinnedFetch };
