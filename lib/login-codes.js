'use strict';

// Login codes from the course lead (board #876): an admin creates an 8-digit code for a member of an active team and
// hands it over by voice or chat; the person signs in at the login service with address + code instead of the mail link
// that firewalls or quarantine swallowed. The app writes the file, the login service (maniak-auth) only reads it.
//
//   ACCESS_LOGIN_CODES_FILE  path of the shared file (on the server /root/auth-service/login-codes.json). Without it the
//                            feature is off (no routes do anything, the UI shows no button).
//
// File (UTF-8 JSON, permissions 600, written atomically: temporary file next to it, then rename):
//   { "version": 1, "codes": { "<email>": { salt, hash, created, expires, by } } }
//   key      the address in lower case, trimmed
//   salt     32 hex characters (16 random bytes), new for every code
//   hash     hex(sha256(utf8(salt + ":" + email + ":" + code)))
//   created  / expires: Unix seconds (integers)
// One code per address: a new one replaces the old one, revoking deletes the entry, expired entries are dropped whenever
// the file is written. The plain code exists only in the return value of create(); it is never stored or logged.
// Reading is tolerant: a missing or broken file counts as "no codes", broken entries are ignored (and dropped on the
// next write). Writes are queued, so two clicks at the same moment never overwrite each other.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeAtomic } = require('./access-sync');

const HOURS = [24, 168];
const DEFAULT_HOURS = 24;
const CODE_DIGITS = 8;

class LoginCodeError extends Error {
  constructor(message, code = 'INVALID_LOGIN_CODE_REQUEST') {
    super(message);
    this.name = 'LoginCodeError';
    this.code = code;
  }
}

const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

function hashOf(salt, email, code) {
  return crypto.createHash('sha256').update(`${salt}:${email}:${code}`, 'utf8').digest('hex');
}

function validEntry(entry) {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(entry.salt) &&
    typeof entry.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.hash) &&
    Number.isInteger(entry.created) &&
    Number.isInteger(entry.expires)
  );
}

function createLoginCodes({ env = process.env, now = Date.now, randomInt = crypto.randomInt } = {}) {
  let chain = Promise.resolve();

  const file = () => String(env.ACCESS_LOGIN_CODES_FILE || '').trim();
  const nowSeconds = () => Math.floor(now() / 1000);

  function enabled() {
    return Boolean(file());
  }

  // The valid entries of the file ({} for a missing or broken file). Never throws.
  function readCodes() {
    const target = file();
    if (!target) return {};
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[login-codes] the file cannot be read, it counts as empty:', err.code || err.name);
      return {};
    }
    const codes = parsed && typeof parsed === 'object' && parsed.codes && typeof parsed.codes === 'object' && !Array.isArray(parsed.codes) ? parsed.codes : {};
    const result = {};
    for (const [key, entry] of Object.entries(codes)) {
      const email = normalize(key);
      if (email && validEntry(entry)) result[email] = entry;
    }
    return result;
  }

  // The current (not expired) entries.
  function activeCodes() {
    const limit = nowSeconds();
    return Object.fromEntries(Object.entries(readCodes()).filter(([, entry]) => entry.expires > limit));
  }

  function writeCodes(codes) {
    const target = file();
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(codes).sort().map((email) => [email, codes[email]]));
    writeAtomic(target, `${JSON.stringify({ version: 1, codes: sorted }, null, 2)}\n`, 0o600);
    try {
      // writeAtomic writes in place where rename() is impossible; the permissions must be 600 in any case.
      fs.chmodSync(target, 0o600);
    } catch (_) {
      /* not allowed for this process */
    }
  }

  // Runs one change after the previous one. `change(codes)` edits the active entries and returns the result.
  function queue(change) {
    const run = () => {
      if (!enabled()) throw new LoginCodeError('Login-Codes sind nicht eingerichtet (ACCESS_LOGIN_CODES_FILE).', 'LOGIN_CODES_DISABLED');
      const codes = activeCodes();
      const before = JSON.stringify(codes);
      const result = change(codes);
      if (JSON.stringify(codes) !== before || result?.forceWrite) writeCodes(codes);
      return result?.value;
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  // { code: '12345678', expiresAt: ISO } — the only place the plain code exists.
  function create({ email, hours = DEFAULT_HOURS, by = null } = {}) {
    const key = normalize(email);
    if (!key) return Promise.reject(new LoginCodeError('Die E-Mail-Adresse fehlt.', 'INVALID_EMAIL'));
    const duration = hours === undefined || hours === null || hours === '' ? DEFAULT_HOURS : Number(hours);
    if (!HOURS.includes(duration)) return Promise.reject(new LoginCodeError('Die Gültigkeit muss 24 Stunden oder 7 Tage sein.', 'INVALID_HOURS'));
    return queue((codes) => {
      const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
      const salt = crypto.randomBytes(16).toString('hex');
      const created = nowSeconds();
      const expires = created + duration * 3600;
      codes[key] = { salt, hash: hashOf(salt, key, code), created, expires, by: by ? String(by) : null };
      return { value: { code, expiresAt: new Date(expires * 1000).toISOString() }, forceWrite: true };
    });
  }

  // true when there was a code for the address.
  function revoke(email) {
    const key = normalize(email);
    return queue((codes) => {
      const existed = Boolean(key && codes[key]);
      if (existed) delete codes[key];
      return { value: existed };
    });
  }

  // Drops the codes of addresses that lost their access (removed from a team, team archived or deleted).
  function retainOnly(emails) {
    if (!enabled()) return Promise.resolve(0);
    const keep = new Set([...(emails || [])].map(normalize));
    return queue((codes) => {
      let removed = 0;
      for (const email of Object.keys(codes)) {
        if (!keep.has(email)) {
          delete codes[email];
          removed += 1;
        }
      }
      return { value: removed };
    });
  }

  // { email: { created, expires, by } } of the current codes, without salt and hash.
  function list() {
    if (!enabled()) return {};
    return Object.fromEntries(Object.entries(activeCodes()).map(([email, entry]) => [email, { created: entry.created, expires: entry.expires, by: typeof entry.by === 'string' ? entry.by : null }]));
  }

  // For the team view: { expiresAt: ISO } of the current code of one address, or null.
  function statusOf(email, codes = null) {
    const entry = (codes || list())[normalize(email)];
    return entry ? { expiresAt: new Date(entry.expires * 1000).toISOString() } : null;
  }

  function settled() {
    return chain;
  }

  return { enabled, create, revoke, retainOnly, list, statusOf, settled, file };
}

const defaultCodes = createLoginCodes();

module.exports = {
  HOURS,
  DEFAULT_HOURS,
  LoginCodeError,
  hashOf,
  createLoginCodes,
  defaultCodes,
  enabled: defaultCodes.enabled,
  create: defaultCodes.create,
  revoke: defaultCodes.revoke,
  retainOnly: defaultCodes.retainOnly,
  list: defaultCodes.list,
  statusOf: defaultCodes.statusOf,
  settled: defaultCodes.settled
};
