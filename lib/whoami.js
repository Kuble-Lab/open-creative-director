'use strict';

const crypto = require('crypto');

// A clear answer (200 with or without a login, 401, 403) is remembered for 10 s. A technical failure (timeout, network
// error, HTTP 5xx or any other unexpected answer) only for 2 s, so a short outage does not keep people anonymous.
const CACHE_TTL_MS = 10000;
const FAILURE_CACHE_TTL_MS = 2000;
const REQUEST_TIMEOUT_MS = 3000;

function cookieHash(cookie) {
  return crypto.createHash('sha256').update(String(cookie || '')).digest('hex');
}

function createWhoamiMiddleware({ getUrl = () => process.env.AUTH_WHOAMI_URL, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();

  return async function kubleUser(req, _res, next) {
    req.kubleUser = 'lokal';
    const url = String(getUrl() || '').trim();
    if (!url) return next();

    const cookie = String(req.headers?.cookie || '');
    const key = cookieHash(cookie);
    const cached = cache.get(key);
    const currentTime = now();
    if (cached && currentTime - cached.ts < cached.ttl) {
      req.kubleUser = cached.user;
      return next();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let user = 'lokal';
    let ttl = FAILURE_CACHE_TTL_MS;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: cookie ? { Cookie: cookie } : {},
        signal: controller.signal
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.logged_in && typeof body.email === 'string' && body.email.trim()) {
          // Lower case, so the address matches owners, admins and cost rows regardless of how the login spells it.
          user = body.email.trim().toLowerCase();
        }
        ttl = CACHE_TTL_MS;
      } else if (response.status === 401 || response.status === 403) {
        ttl = CACHE_TTL_MS; // a clear "not logged in"
      }
    } catch (_) {
      user = 'lokal';
      ttl = FAILURE_CACHE_TTL_MS;
    } finally {
      clearTimeout(timer);
    }

    cache.set(key, { user, ts: currentTime, ttl });
    req.kubleUser = user;
    return next();
  };
}

module.exports = { createWhoamiMiddleware, cookieHash, CACHE_TTL_MS, FAILURE_CACHE_TTL_MS, REQUEST_TIMEOUT_MS };
