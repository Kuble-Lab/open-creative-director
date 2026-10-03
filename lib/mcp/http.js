'use strict';

// The HTTP side of the agent access: POST /mcp (Streamable HTTP, answers as application/json), the key check, the rate
// limit, the size limit and the Origin check. Mounted by lib/mcp/index.js BEFORE the login middleware and the body
// parsers of server.js: the key is the only login of this path, and the body is read here with its own limit.
//
// Order of the checks (cheap and safe first):
//   1  method        anything but POST: 405 (there is no event stream to open with GET)
//   2  Origin        a browser page of another origin: 403 (protects against DNS rebinding)
//   3  key           Authorization: Bearer ocd_k1_...  (never from the URL): 401 / 403 / 503
//   4  rate limit    per key, 429 with Retry-After
//   5  at once       per key at most 4 requests in progress, and at most 2 large bodies (above 1 MB) in progress in the
//                    whole app: 429. The rate limit counts requests per minute; this keeps a slow burst of 20 MB bodies
//                    from being held in memory all at the same time.
//   6  size, type    413 / 415 before a byte is parsed
//   7  JSON          400 with -32700 (the parser's message is never echoed: it can quote the body)
//   8  protocol      lib/mcp/protocol.js
// The secret of a key is only read in step 3, held in a local variable and never written anywhere.

const { rpcError, ERROR } = require('./protocol');
const { endpointUrl } = require('./key-routes');

const MAX_BODY_BYTES = 22 * 1024 * 1024; // room for a 15 MB file as base64 in a tool call
const RATE_LIMIT = Object.freeze({ requests: 60, windowMs: 60 * 1000 });
// Requests in progress at the same moment. A body above largeBodyBytes is held in memory (as text, as parsed JSON and as
// decoded bytes) until its answer is sent: only a few of those may run at once, for the whole app.
const CONCURRENCY = Object.freeze({ perKey: 4, largeBodyBytes: 1024 * 1024, largeSlots: 2 });
const DRAIN_TIMEOUT_MS = 30 * 1000;
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]', '::1']);

// Sliding window per key.
function createRateLimiter({ requests = RATE_LIMIT.requests, windowMs = RATE_LIMIT.windowMs, now = Date.now } = {}) {
  const hits = new Map(); // key id -> timestamps
  return {
    // { allowed: true } or { allowed: false, retryAfterSeconds }
    take(id) {
      const current = now();
      const recent = (hits.get(id) || []).filter((time) => current - time < windowMs);
      if (recent.length >= requests) {
        hits.set(id, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - current) / 1000)) };
      }
      recent.push(current);
      hits.set(id, recent);
      if (hits.size > 5000) {
        for (const [key, times] of hits) if (!times.some((time) => current - time < windowMs)) hits.delete(key);
      }
      return { allowed: true };
    },
    reset() {
      hits.clear();
    }
  };
}

// Counts the requests in progress. enter() and large() return a function that gives the place back (it can be called twice)
// or null when there is no place left.
function createConcurrencyGate({ perKey = CONCURRENCY.perKey, largeSlots = CONCURRENCY.largeSlots } = {}) {
  const running = new Map(); // key id -> number
  let large = 0;
  const once = (fn) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  };
  return {
    enter(id) {
      const count = running.get(id) || 0;
      if (count >= perKey) return null;
      running.set(id, count + 1);
      return once(() => {
        const left = (running.get(id) || 1) - 1;
        if (left > 0) running.set(id, left);
        else running.delete(id);
      });
    },
    large() {
      if (large >= largeSlots) return null;
      large += 1;
      return once(() => {
        large -= 1;
      });
    },
    get largeInUse() {
      return large;
    },
    inUse(id) {
      return running.get(id) || 0;
    }
  };
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1] : null;
}

// Origins a browser page may come from (scheme, host and port have to match, not only the host): the public address of the
// app, what MCP_ALLOWED_ORIGINS adds (comma-separated origins; a bare host means https://host), and the app's own loopback
// address on a local installation. The Host header of the request is not trusted for this.
function allowedOrigins(env = process.env) {
  const origins = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin.toLowerCase());
    } catch (_) {
      /* an unusable entry allows nothing */
    }
  };
  add(env.PUBLIC_BASE_URL);
  for (const entry of String(env.MCP_ALLOWED_ORIGINS || '').split(',')) add(entry);
  return origins;
}

const portOf = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

// Loopback pages (a tool on the same machine) are accepted only when the app is not reached under a public address: no
// PUBLIC_BASE_URL, or one that is a loopback address itself. Then only the port the request came in on counts (read from
// the socket, not from a header).
function loopbackAllowed(origin, req, env) {
  let url;
  try {
    url = new URL(origin);
  } catch (_) {
    return false;
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname.toLowerCase())) return false;
  const configured = String(env.PUBLIC_BASE_URL || '').trim();
  if (configured) {
    try {
      if (!LOOPBACK_HOSTS.includes(new URL(configured).hostname.toLowerCase())) return false;
    } catch (_) {
      return false;
    }
  }
  const localPort = req.socket && req.socket.localPort;
  return Number.isInteger(localPort) && portOf(url) === localPort;
}

function originAllowed(req, env = process.env) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // no browser: agents, command line tools
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (allowedOrigins(env).has(url.origin.toLowerCase())) return true;
    return loopbackAllowed(origin, req, env);
  } catch (_) {
    return false; // "null" and anything that is not an origin
  }
}

function send(res, { status, json }, extraHeaders = {}) {
  res.set(extraHeaders);
  if (json === undefined) return res.status(status).end();
  res.status(status).type('application/json').send(JSON.stringify(json));
  return res;
}

// Reads at most `max` bytes. Resolves { body }, { tooLarge: true }, { busy: true } (onLarge(), asked once when the body is or
// gets larger than largeBytes, said no) or { aborted: true }.
function readBody(req, max, { largeBytes = Infinity, onLarge = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return resolve({ tooLarge: true });
    const chunks = [];
    let size = 0;
    let done = false;
    let asked = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      resolve(value);
    };
    // true when the body may go on
    const large = () => {
      if (asked) return true;
      asked = true;
      return onLarge() !== false;
    };
    if (Number.isFinite(declared) && declared > largeBytes && !large()) {
      done = true;
      return resolve({ busy: true });
    }
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) return finish({ tooLarge: true });
      if (size > largeBytes && !large()) return finish({ busy: true });
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks) });
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    req.on('close', () => finish({ aborted: true })); // after 'end' this does nothing: the body is already settled
  });
}

// An answer is sent before the body was read: what the sender still sends is thrown away (not kept), so the sender can read
// the answer instead of failing to write; after 30 seconds the connection is cut.
function discardRest(req) {
  req.resume();
  const timer = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
  timer.unref?.();
  req.once('close', () => clearTimeout(timer));
}

function lowerCaseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) out[name.toLowerCase()] = value;
  return out;
}

function createMcpHandler({
  keys,
  protocol,
  limiter = createRateLimiter(),
  gate = createConcurrencyGate(),
  env = process.env,
  maxBodyBytes = MAX_BODY_BYTES,
  largeBodyBytes = CONCURRENCY.largeBodyBytes,
  log = (...args) => console.warn(...args)
} = {}) {
  return async function mcpHandler(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let releaseSlot = null;
    let releaseLarge = null;
    try {
      // 1 method
      if (req.method !== 'POST') {
        return send(res, rpcError(405, null, ERROR.INVALID_REQUEST, 'This endpoint takes POST requests only; there is no event stream'), { Allow: 'POST' });
      }
      // 2 origin
      if (!originAllowed(req, env)) {
        return send(res, rpcError(403, null, ERROR.INVALID_REQUEST, 'This origin is not allowed'));
      }
      // 3 key
      const token = bearerToken(req);
      const auth = token ? keys.authenticate(token) : { ok: false, reason: 'missing' };
      if (!auth.ok) {
        if (auth.reason === 'unavailable') return send(res, rpcError(503, null, ERROR.INTERNAL, 'The key store is not available'));
        const messages = {
          revoked: 'This key has been revoked.',
          expired: 'This key has expired.',
          owner_invalid: 'The person this key belongs to may no longer use it.'
        };
        const status = auth.reason === 'owner_invalid' ? 403 : 401;
        return send(
          res,
          rpcError(status, null, status, messages[auth.reason] || 'A valid key is required: send the header "Authorization: Bearer <key>".', { reason: messages[auth.reason] ? auth.reason : 'invalid_key' }),
          status === 401 ? { 'WWW-Authenticate': 'Bearer realm="mcp"' } : {}
        );
      }
      // 4 rate limit
      const taken = limiter.take(auth.key.id);
      if (!taken.allowed) {
        discardRest(req);
        return send(res, rpcError(429, null, 429, 'Too many requests for this key. Try again later.', { retryAfterSeconds: taken.retryAfterSeconds }), { 'Retry-After': String(taken.retryAfterSeconds) });
      }
      // 5 requests at the same moment
      releaseSlot = gate.enter(auth.key.id);
      if (!releaseSlot) {
        discardRest(req);
        return send(res, rpcError(429, null, 429, `Too many requests at once for this key (at most ${CONCURRENCY.perKey}). Wait for the answers and try again.`, { retryAfterSeconds: 1 }), { 'Retry-After': '1' });
      }
      // 6 type and size
      if (!req.is('application/json')) {
        return send(res, rpcError(415, null, ERROR.INVALID_REQUEST, 'The content type must be application/json'));
      }
      const read = await readBody(req, maxBodyBytes, {
        largeBytes: largeBodyBytes,
        onLarge: () => {
          releaseLarge = gate.large();
          return Boolean(releaseLarge);
        }
      });
      if (read.aborted) return undefined;
      if (read.tooLarge || read.busy) {
        if (read.busy) discardRest(req);
        else res.set('Connection', 'close');
        send(
          res,
          read.busy
            ? rpcError(429, null, 429, 'The server is busy with other large requests. Try again in a few seconds, or send large files through an upload link (upload_asset without data_base64).', { retryAfterSeconds: 2 })
            : rpcError(413, null, ERROR.INVALID_REQUEST, `The request is larger than ${Math.floor(maxBodyBytes / (1024 * 1024))} MB`),
          read.busy ? { 'Retry-After': '2' } : {}
        );
        if (!read.busy) res.once('finish', () => req.destroy());
        return undefined;
      }
      // 7 JSON
      let message;
      try {
        message = JSON.parse(read.body.toString('utf8'));
      } catch (_) {
        return send(res, rpcError(400, null, ERROR.PARSE, 'The body is not valid JSON'));
      }
      // a batch counts as many requests as it has messages
      if (Array.isArray(message)) {
        for (let index = 1; index < Math.min(message.length, protocol.maxBatch || message.length); index += 1) {
          const extra = limiter.take(auth.key.id);
          if (!extra.allowed) {
            return send(res, rpcError(429, null, 429, 'Too many requests for this key. Try again later.', { retryAfterSeconds: extra.retryAfterSeconds }), { 'Retry-After': String(extra.retryAfterSeconds) });
          }
        }
      }
      // 8 protocol
      const controller = new AbortController();
      res.once('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      const answer = await protocol.handle({
        message,
        headers: lowerCaseHeaders(req.headers),
        // publicBase: the address links in tool results start with (PUBLIC_BASE_URL, else the address of the request)
        context: { key: auth.key, viewer: auth.viewer, signal: controller.signal, publicBase: endpointUrl(req, env).replace(/\/mcp$/, '') }
      });
      return send(res, answer);
    } catch (err) {
      log(`[mcp] Anfrage fehlgeschlagen: ${String((err && (err.code || err.name)) || 'Fehler')}`);
      if (res.headersSent) return undefined;
      return send(res, rpcError(500, null, ERROR.INTERNAL, 'Internal error'));
    } finally {
      if (releaseLarge) releaseLarge();
      if (releaseSlot) releaseSlot();
    }
  };
}

module.exports = {
  MAX_BODY_BYTES,
  RATE_LIMIT,
  CONCURRENCY,
  createRateLimiter,
  createConcurrencyGate,
  createMcpHandler,
  originAllowed,
  allowedOrigins,
  bearerToken
};
