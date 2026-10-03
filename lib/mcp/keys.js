'use strict';

// Keys for the agent access (MCP, see lib/mcp/index.js).
//
// A key is a bearer secret of the form  ocd_k1_<43 characters>  (32 random bytes = 256 bit, base64url). Only the SHA-256 hash
// of it is stored (data/mcp-keys.json, mode 0600), compared in constant time against every stored hash. The secret is
// handed out exactly once, when the key is created; it never appears in a list, a log, an error or the cost journal.
//
// A key acts as its owner (a person): it sees the same workflows, templates and teams, never more. It stops working when
// the person is no longer an admin or internal person, or was deleted from the team list. Participants and guests get
// no keys.
//
// record  { id, prefix, hash, name, owner, right, maxRunUsd, maxMonthUsd, createdAt, createdBy, expiresAt,
//           lastUsedAt, revokedAt, revokedBy }
//   right  'read' (look only) | 'start' (read and start runs)
//   owner  normalised e-mail address of the person, or 'lokal' without user management

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const access = require('../access');
const users = require('../users');
const { PATHS } = require('../config');

const KEYS_FILE = path.join(PATHS.root, 'data', 'mcp-keys.json');
const KEY_PREFIX = 'ocd_k1_';
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^ocd_k1_[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^k[0-9a-f]{16}$/;
const LOCAL_OWNER = 'lokal';
const RIGHTS = Object.freeze(['read', 'start']);
const DEFAULTS = Object.freeze({ maxRunUsd: 2, maxMonthUsd: 20, expiresInDays: 90 });
const LIMITS = Object.freeze({
  nameChars: 80,
  maxRunUsd: 1000,
  maxMonthUsd: 10000,
  maxExpiresInDays: 365,
  keysPerOwner: 25, // keys of one person that are neither revoked nor expired
  records: 2000,
  touchIntervalMs: 60 * 1000
});
const DAY_MS = 24 * 60 * 60 * 1000;

class KeyValidationError extends Error {
  constructor(message, code = 'INVALID_KEY_REQUEST') {
    super(message);
    this.name = 'KeyValidationError';
    this.code = code;
  }
}

class KeyNotFoundError extends Error {
  constructor() {
    super('Dieser Schlüssel wurde nicht gefunden.');
    this.name = 'KeyNotFoundError';
    this.code = 'KEY_NOT_FOUND';
  }
}

class KeyStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyStoreError';
    this.code = 'KEY_STORE_UNAVAILABLE';
  }
}

function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const amount = (value, max) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10000) / 10000 : null);

// A record as it is stored; null for anything that is not a usable record (it is dropped when the file is read).
function normaliseRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const owner = raw.owner === LOCAL_OWNER ? LOCAL_OWNER : access.normalizeEmail(raw.owner);
  const record = {
    id: raw.id,
    prefix: typeof raw.prefix === 'string' ? raw.prefix.slice(0, 16) : '',
    hash: raw.hash,
    name: typeof raw.name === 'string' ? raw.name.slice(0, LIMITS.nameChars) : '',
    owner,
    right: RIGHTS.includes(raw.right) ? raw.right : 'read',
    maxRunUsd: amount(raw.maxRunUsd, LIMITS.maxRunUsd) ?? DEFAULTS.maxRunUsd,
    maxMonthUsd: amount(raw.maxMonthUsd, LIMITS.maxMonthUsd) ?? DEFAULTS.maxMonthUsd,
    createdAt: isoOrNull(raw.createdAt),
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : owner,
    expiresAt: isoOrNull(raw.expiresAt),
    lastUsedAt: isoOrNull(raw.lastUsedAt),
    revokedAt: isoOrNull(raw.revokedAt),
    revokedBy: typeof raw.revokedBy === 'string' ? raw.revokedBy : null
  };
  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) return null;
  if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) return null;
  if (!record.owner || !record.createdAt || !record.expiresAt) return null;
  return record;
}

// The person a key acts as, or null when the key must not work (any more). Without user management ('local mode') every
// key acts as the local person. Otherwise the owner has to be an admin or an internal person who is still on the team list.
function defaultViewerFor(owner, env = process.env, isMember = users.isMember) {
  if (!access.isActive(env)) return access.LOCAL_VIEWER;
  const email = access.normalizeEmail(owner);
  if (!email) return null;
  const viewer = access.viewerOf({ kubleUser: email }, env);
  if (!viewer.identified) return null;
  if (viewer.admin) return viewer;
  if (viewer.kind !== 'internal') return null;
  try {
    return isMember(email) ? viewer : null;
  } catch (_) {
    return null; // fail closed
  }
}

function createKeyStore({ file = KEYS_FILE, now = Date.now, env = process.env, viewerFor = null, random = crypto.randomBytes } = {}) {
  let cache = null; // { sig, keys }
  const lastTouch = new Map();
  const viewerOfOwner = (owner) => (viewerFor ? viewerFor(owner) : defaultViewerFor(owner, env));

  /* ----- the file ----- */

  function signature() {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (err) {
      if (err.code === 'ENOENT') return 'none';
      throw new KeyStoreError('data/mcp-keys.json konnte nicht gelesen werden.');
    }
  }

  function load() {
    const sig = signature();
    if (cache && cache.sig === sig) return cache.keys;
    let keys = [];
    if (sig !== 'none') {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        throw new KeyStoreError('data/mcp-keys.json ist ungültig oder konnte nicht gelesen werden.');
      }
      if (!parsed || !Array.isArray(parsed.keys)) throw new KeyStoreError('data/mcp-keys.json hat ein unbekanntes Format.');
      keys = parsed.keys.map(normaliseRecord).filter(Boolean);
    }
    cache = { sig, keys };
    return keys;
  }

  function save(keys) {
    writeJsonSync(file, { version: 1, keys });
    cache = { sig: signature(), keys };
  }

  /* ----- views ----- */

  function statusOf(record, at = now()) {
    if (record.revokedAt) return 'revoked';
    if (Date.parse(record.expiresAt) <= at) return 'expired';
    return 'active';
  }

  // What the API shows: never the hash, never the secret.
  function view(record) {
    const at = now();
    const status = statusOf(record, at);
    return {
      id: record.id,
      prefix: record.prefix,
      name: record.name,
      owner: record.owner,
      right: record.right,
      maxRunUsd: record.maxRunUsd,
      maxMonthUsd: record.maxMonthUsd,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      revokedAt: record.revokedAt,
      revokedBy: record.revokedBy,
      status,
      // an active key whose person may no longer use it
      ownerValid: status === 'active' ? Boolean(viewerOfOwner(record.owner)) : null
    };
  }

  function find(id) {
    return typeof id === 'string' && ID_PATTERN.test(id) ? load().find((record) => record.id === id) || null : null;
  }

  /* ----- validation ----- */

  function cleanName(value) {
    if (typeof value !== 'string') throw new KeyValidationError('Der Name muss ein Text sein.', 'INVALID_NAME');
    const name = value.replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-control-regex
    if (!name || [...name].length > LIMITS.nameChars || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new KeyValidationError(`Der Name braucht 1 bis ${LIMITS.nameChars} Zeichen ohne Steuerzeichen.`, 'INVALID_NAME');
    }
    return name;
  }

  function cleanLimit(value, max, field, fallback) {
    if (value === undefined || value === null) return fallback;
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    const clean = amount(number, max);
    if (clean === null) throw new KeyValidationError(`${field === 'maxRunUsd' ? 'Das Limit pro Lauf' : 'Das Monatslimit'} muss eine Zahl von 0 bis ${max} (USD) sein.`, 'INVALID_LIMIT');
    return clean;
  }

  function cleanExpiry(value) {
    if (value === undefined || value === null) return DEFAULTS.expiresInDays;
    if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxExpiresInDays) {
      throw new KeyValidationError(`Die Gültigkeit muss eine ganze Zahl von 1 bis ${LIMITS.maxExpiresInDays} Tagen sein.`, 'INVALID_EXPIRY');
    }
    return value;
  }

  /* ----- management ----- */

  // owner: the address of the person (or 'lokal'); right: 'read' | 'start'
  function create({ name, owner, right, maxRunUsd, maxMonthUsd, expiresInDays, createdBy } = {}) {
    const ownerAddress = owner === LOCAL_OWNER ? LOCAL_OWNER : access.normalizeEmail(owner);
    if (!ownerAddress) throw new KeyValidationError('Der Schlüssel braucht eine Person als Besitzer.', 'INVALID_OWNER');
    if (!RIGHTS.includes(right)) throw new KeyValidationError('Das Recht muss „Nur lesen“ (read) oder „Lesen und starten“ (start) sein.', 'INVALID_RIGHT');
    const clean = {
      name: cleanName(name),
      maxRunUsd: cleanLimit(maxRunUsd, LIMITS.maxRunUsd, 'maxRunUsd', DEFAULTS.maxRunUsd),
      maxMonthUsd: cleanLimit(maxMonthUsd, LIMITS.maxMonthUsd, 'maxMonthUsd', DEFAULTS.maxMonthUsd),
      days: cleanExpiry(expiresInDays)
    };
    const at = now();
    let keys = load().slice();
    const usable = (record) => statusOf(record, at) === 'active';
    if (keys.filter((record) => record.owner === ownerAddress && usable(record)).length >= LIMITS.keysPerOwner) {
      throw new KeyValidationError(`Eine Person kann höchstens ${LIMITS.keysPerOwner} gültige Schlüssel haben. Widerrufe zuerst einen.`, 'TOO_MANY_KEYS');
    }
    if (keys.length >= LIMITS.records) {
      keys = keys.filter((record) => usable(record) || at - Date.parse(record.revokedAt || record.expiresAt) < 30 * DAY_MS);
      if (keys.length >= LIMITS.records) throw new KeyValidationError('Es gibt zu viele Schlüssel.', 'TOO_MANY_KEYS');
    }
    const secret = random(SECRET_BYTES).toString('base64url');
    const token = `${KEY_PREFIX}${secret}`;
    const record = {
      id: `k${random(8).toString('hex')}`,
      prefix: `${KEY_PREFIX}${secret.slice(0, 4)}`,
      hash: sha256(token).toString('hex'),
      name: clean.name,
      owner: ownerAddress,
      right,
      maxRunUsd: clean.maxRunUsd,
      maxMonthUsd: clean.maxMonthUsd,
      createdAt: new Date(at).toISOString(),
      createdBy: access.normalizeEmail(createdBy) || ownerAddress,
      expiresAt: new Date(at + clean.days * DAY_MS).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null
    };
    keys.push(record);
    save(keys);
    return { key: view(record), secret: token };
  }

  // The keys of one person (owner given) or all of them. Newest first.
  function list({ owner = null } = {}) {
    const wanted = owner === null ? null : owner === LOCAL_OWNER ? LOCAL_OWNER : access.normalizeEmail(owner);
    return load()
      .filter((record) => wanted === null || record.owner === wanted)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map(view);
  }

  function get(id) {
    const record = find(id);
    return record ? view(record) : null;
  }

  function revoke(id, by) {
    const keys = load().slice();
    const record = keys.find((item) => item.id === id);
    if (!record) throw new KeyNotFoundError();
    if (!record.revokedAt) {
      record.revokedAt = new Date(now()).toISOString();
      record.revokedBy = access.normalizeEmail(by) || (by === LOCAL_OWNER ? LOCAL_OWNER : null);
      save(keys);
    }
    return view(record);
  }

  // name and limits can be changed; the right, the owner and the expiry stay as they were issued.
  function update(id, patch = {}) {
    const keys = load().slice();
    const record = keys.find((item) => item.id === id);
    if (!record) throw new KeyNotFoundError();
    if (record.revokedAt) throw new KeyValidationError('Ein widerrufener Schlüssel kann nicht mehr geändert werden.', 'KEY_REVOKED');
    if (patch.name !== undefined) record.name = cleanName(patch.name);
    if (patch.maxRunUsd !== undefined) record.maxRunUsd = cleanLimit(patch.maxRunUsd, LIMITS.maxRunUsd, 'maxRunUsd', record.maxRunUsd);
    if (patch.maxMonthUsd !== undefined) record.maxMonthUsd = cleanLimit(patch.maxMonthUsd, LIMITS.maxMonthUsd, 'maxMonthUsd', record.maxMonthUsd);
    save(keys);
    return view(record);
  }

  /* ----- use ----- */

  // Checks a presented secret. { ok: true, key, viewer } or { ok: false, reason }: malformed | unknown | revoked | expired |
  // owner_invalid | unavailable. The hash is compared with every stored hash (no early exit), so the time does not tell
  // whether, or how closely, a secret matched. A reason other than malformed / unknown / unavailable is only given after
  // the full secret matched.
  function authenticate(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { ok: false, reason: 'malformed' };
    let keys;
    try {
      keys = load();
    } catch (_) {
      return { ok: false, reason: 'unavailable' };
    }
    const digest = sha256(token);
    let match = null;
    for (const record of keys) {
      if (crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), digest)) match = record;
    }
    if (!match) return { ok: false, reason: 'unknown' };
    const at = now();
    if (match.revokedAt) return { ok: false, reason: 'revoked', key: view(match) };
    if (Date.parse(match.expiresAt) <= at) return { ok: false, reason: 'expired', key: view(match) };
    let viewer;
    try {
      viewer = viewerOfOwner(match.owner);
    } catch (_) {
      viewer = null;
    }
    if (!viewer) return { ok: false, reason: 'owner_invalid', key: view(match) };
    touch(match, at);
    return { ok: true, key: view(match), viewer };
  }

  // "Last used", written at most once per interval.
  function touch(record, at) {
    if (at - (lastTouch.get(record.id) || 0) < LIMITS.touchIntervalMs) return;
    lastTouch.set(record.id, at);
    try {
      const keys = load().slice();
      const target = keys.find((item) => item.id === record.id);
      if (!target) return;
      target.lastUsedAt = new Date(at).toISOString();
      save(keys);
    } catch (err) {
      console.warn('[mcp] Zeitpunkt der letzten Nutzung konnte nicht gespeichert werden:', err.code || 'Fehler');
    }
  }

  return { create, list, get, revoke, update, authenticate, statusOf, viewerOfOwner, file };
}

const defaultStore = createKeyStore();

module.exports = {
  KEYS_FILE,
  KEY_PREFIX,
  TOKEN_PATTERN,
  ID_PATTERN,
  LOCAL_OWNER,
  RIGHTS,
  DEFAULTS,
  LIMITS,
  KeyValidationError,
  KeyNotFoundError,
  KeyStoreError,
  createKeyStore,
  defaultViewerFor,
  defaultStore
};
