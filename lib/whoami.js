'use strict';

const crypto = require('crypto');

const CACHE_TTL_MS = 10000;
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
    if (cached && currentTime - cached.ts < CACHE_TTL_MS) {
      req.kubleUser = cached.user;
      return next();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let user = 'lokal';
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
      }
    } catch (_) {
      user = 'lokal';
    } finally {
      clearTimeout(timer);
    }

    cache.set(key, { user, ts: currentTime });
    req.kubleUser = user;
    return next();
  };
}

module.exports = { createWhoamiMiddleware, cookieHash, CACHE_TTL_MS, REQUEST_TIMEOUT_MS };
