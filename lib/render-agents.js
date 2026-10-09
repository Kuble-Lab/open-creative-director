'use strict';

// Own computers as render nodes (WP46): the paired computers ("render agents") and their pairing codes.
//
// A person opens "My computers" in the app and gets a pairing code (lib/render-agent-routes.js). The command shown with it
// installs the agent (render-node/agent.js) on the computer and pairs it: the code is exchanged once for a long random
// token. The computer then fetches render jobs itself over HTTPS (lib/render-queue.js); it opens no port.
//
// data/render-agents.json (mode 600, replaced atomically):
//   { version: 1, agents: [{ id, owner, name, platform, versions, tokenHash, shareTeams, shareAll, createdAt, lastSeenAt,
//                            completed, failed }] }
//   owner       the address of the person who paired it ('lokal' without user management)
//   tokenHash   SHA-256 of the token (hex). The token itself exists only in the one answer of the pairing and in a file of
//               the computer (mode 600); it never appears in a list, a log or an error.
//   shareTeams  the computer also renders for the members of the active teams of its owner
//   shareAll    the computer is a shared node for everybody (only admins may set it; it counts only while the owner is an admin)
//
// Pairing codes are kept in memory only: 8 characters of an alphabet without look-alikes (shown as XXXX-XXXX), 10 minutes,
// once, bound to the person who asked for it, one open code per person. A restart of the app ends open codes.
// Wrong codes are limited per IP address, the uses of a code are limited per code.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PATHS } = require('./config');

const AGENTS_FILE = path.join(PATHS.root, 'data', 'render-agents.json');
const TOKEN_PREFIX = 'ocra_';
const TOKEN_PATTERN = /^ocra_[A-Za-z0-9_-]{43}$/;
const AGENT_ID_PATTERN = /^ra-[0-9a-f]{12}$/;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const PLATFORM_PATTERN = /^[a-z0-9]{2,16}-[a-z0-9_]{2,16}$/;
const VERSION_TEXT = /^[0-9A-Za-z.+_ -]{1,40}$/;

const LIMITS = Object.freeze({
  nameChars: 40,
  agentsPerPerson: 10,
  agents: 500,
  codeTtlMs: 10 * 60 * 1000,
  // uses of one valid code (package downloads and pairing attempts) before it stops working
  codeUses: 12,
  // wrong or expired codes per IP address and window
  failuresPerIp: 10,
  failureWindowMs: 10 * 60 * 1000,
  // new codes per person and window
  codesPerPerson: 10,
  codeWindowMs: 10 * 60 * 1000,
  // "last seen" is written to the file at most this often per computer
  seenWriteMs: 60 * 1000
});

class RenderAgentError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message);
    this.name = 'RenderAgentError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest();

// Upper case, without spaces and dashes; null for anything that cannot be a code.
function normaliseCode(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.toUpperCase().replace(/[\s-]+/g, '');
  if (clean.length !== CODE_LENGTH) return null;
  for (const char of clean) if (!CODE_ALPHABET.includes(char)) return null;
  return clean;
}

function formatCode(clean) {
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function cleanName(raw, fallback = '') {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const chars = [...(text || fallback)];
  return chars.slice(0, LIMITS.nameChars).join('');
}

function requireName(raw) {
  if (typeof raw !== 'string') throw new RenderAgentError('Der Name muss ein Text sein.', 'INVALID_NAME');
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new RenderAgentError('Der Name darf nicht leer sein.', 'INVALID_NAME');
  if ([...text].length > LIMITS.nameChars) {
    throw new RenderAgentError(`Der Name darf höchstens ${LIMITS.nameChars} Zeichen lang sein.`, 'INVALID_NAME');
  }
  return text;
}

// What a computer reports about itself (platform, versions): short plain values only.
function cleanPlatform(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return PLATFORM_PATTERN.test(text) ? text : 'unknown';
}

function cleanVersions(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const key of ['protocol', 'agent', 'hyperframes', 'node', 'ffmpeg', 'ffmpegSource']) {
    const item = value[key];
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < 1e6) result[key] = item;
    else if (typeof item === 'string' && VERSION_TEXT.test(item.trim())) result[key] = item.trim();
  }
  return result;
}

function normaliseOwner(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return text || 'lokal';
}

function createRenderAgentsStore({ file = AGENTS_FILE, now = Date.now, random = crypto.randomBytes } = {}) {
  let agents = null;
  const codes = new Map(); // code -> { owner, createdAt, expiresAt, uses }
  const ipFailures = new Map(); // ip -> [times]
  const codeRequests = new Map(); // owner -> [times]
  const seen = new Map(); // agent id -> { at, writtenAt }
  const listeners = new Set();

  function sanitise(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || !AGENT_ID_PATTERN.test(raw.id)) return null;
    if (typeof raw.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.tokenHash)) return null;
    const time = (value) => (Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);
    return {
      id: raw.id,
      owner: normaliseOwner(raw.owner),
      name: cleanName(raw.name, raw.id),
      platform: cleanPlatform(raw.platform),
      versions: cleanVersions(raw.versions),
      tokenHash: raw.tokenHash,
      shareTeams: raw.shareTeams === true,
      shareAll: raw.shareAll === true,
      createdAt: time(raw.createdAt) || new Date(now()).toISOString(),
      lastSeenAt: time(raw.lastSeenAt),
      completed: Number.isInteger(raw.completed) && raw.completed >= 0 ? raw.completed : 0,
      failed: Number.isInteger(raw.failed) && raw.failed >= 0 ? raw.failed : 0
    };
  }

  function load() {
    if (agents) return agents;
    let parsed = { agents: [] };
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('data/render-agents.json ist ungültig oder konnte nicht gelesen werden.');
    }
    const list = Array.isArray(parsed?.agents) ? parsed.agents : [];
    const unique = new Map();
    for (const raw of list) {
      const agent = sanitise(raw);
      if (agent && !unique.has(agent.id)) unique.set(agent.id, agent);
    }
    agents = [...unique.values()];
    return agents;
  }

  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${random(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, agents: next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    agents = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (_) {
        /* a listener never breaks a change */
      }
    }
  }

  // The view of a computer for lists and answers: everything but the hash of the token.
  function view(agent) {
    const { tokenHash, ...rest } = agent;
    const memory = seen.get(agent.id);
    const lastSeenAt = memory && (!rest.lastSeenAt || memory.at > Date.parse(rest.lastSeenAt)) ? new Date(memory.at).toISOString() : rest.lastSeenAt;
    return { ...rest, versions: { ...rest.versions }, lastSeenAt };
  }

  function listAgents() {
    return load().map(view);
  }

  function listForOwner(owner) {
    const clean = normaliseOwner(owner);
    return load().filter((agent) => agent.owner === clean).map(view);
  }

  function count() {
    try {
      return load().length;
    } catch (_) {
      return 0;
    }
  }

  function getAgent(id) {
    const agent = typeof id === 'string' ? load().find((entry) => entry.id === id) : null;
    return agent ? view(agent) : null;
  }

  /* ----- pairing codes ----- */

  function pruneCodes(at = now()) {
    for (const [code, entry] of codes) if (entry.expiresAt <= at) codes.delete(code);
  }

  function recent(map, key, windowMs, at) {
    const list = (map.get(key) || []).filter((time) => at - time < windowMs);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }

  // A new code for the person; an open code of the same person stops working.
  function createPairingCode(owner) {
    const clean = normaliseOwner(owner);
    const at = now();
    pruneCodes(at);
    const requests = recent(codeRequests, clean, LIMITS.codeWindowMs, at);
    if (requests.length >= LIMITS.codesPerPerson) {
      throw new RenderAgentError('Zu viele Kopplungscodes in kurzer Zeit. Bitte in ein paar Minuten noch einmal.', 'TOO_MANY_CODES', 429, {
        retryAfterSeconds: Math.max(1, Math.ceil((requests[0] + LIMITS.codeWindowMs - at) / 1000))
      });
    }
    if (load().filter((agent) => agent.owner === clean).length >= LIMITS.agentsPerPerson) {
      throw new RenderAgentError(`Du kannst höchstens ${LIMITS.agentsPerPerson} Rechner verbinden. Entferne zuerst einen.`, 'TOO_MANY_AGENTS', 409);
    }
    requests.push(at);
    codeRequests.set(clean, requests);
    for (const [code, entry] of codes) if (entry.owner === clean) codes.delete(code);
    let code = '';
    do {
      const bytes = random(CODE_LENGTH);
      code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
    } while (codes.has(code));
    const entry = { owner: clean, createdAt: at, expiresAt: at + LIMITS.codeTtlMs, uses: 0 };
    codes.set(code, entry);
    return { code: formatCode(code), expiresAt: new Date(entry.expiresAt).toISOString(), ttlSeconds: Math.round(LIMITS.codeTtlMs / 1000) };
  }

  function ipBlocked(ip, at) {
    const failures = recent(ipFailures, String(ip || '-'), LIMITS.failureWindowMs, at);
    if (failures.length < LIMITS.failuresPerIp) return null;
    return Math.max(1, Math.ceil((failures[0] + LIMITS.failureWindowMs - at) / 1000));
  }

  function noteFailure(ip, at) {
    const key = String(ip || '-');
    const failures = recent(ipFailures, key, LIMITS.failureWindowMs, at);
    failures.push(at);
    ipFailures.set(key, failures);
    if (ipFailures.size > 5000) {
      for (const [entry] of ipFailures) {
        recent(ipFailures, entry, LIMITS.failureWindowMs, at);
        if (ipFailures.size <= 4000) break;
      }
    }
  }

  // Checks a code without using it up (the package endpoint). { owner, code } or a RenderAgentError:
  // RATE_LIMITED (429), INVALID_CODE (401: unknown, expired or used too often).
  function checkCode(raw, ip) {
    const at = now();
    const blocked = ipBlocked(ip, at);
    if (blocked) {
      throw new RenderAgentError('Zu viele falsche Codes. Bitte später noch einmal.', 'RATE_LIMITED', 429, { retryAfterSeconds: blocked });
    }
    pruneCodes(at);
    const code = normaliseCode(raw);
    const entry = code ? codes.get(code) : null;
    if (!entry) {
      noteFailure(ip, at);
      throw new RenderAgentError('Der Kopplungscode ist ungültig oder abgelaufen. Bitte in der App einen neuen holen.', 'INVALID_CODE', 401);
    }
    if (entry.uses >= LIMITS.codeUses) {
      codes.delete(code);
      noteFailure(ip, at);
      throw new RenderAgentError('Der Kopplungscode wurde zu oft benutzt. Bitte in der App einen neuen holen.', 'INVALID_CODE', 401);
    }
    entry.uses += 1;
    return { owner: entry.owner, code };
  }

  /* ----- pairing and tokens ----- */

  // Uses the code up and creates the computer. Returns { agent, token }; the token is never stored or shown again.
  // `beforeCreate(owner)` may refuse (version check) before the code is used up.
  function pair({ code: raw, ip, name, platform, versions, beforeCreate } = {}) {
    const { owner, code } = checkCode(raw, ip);
    if (typeof beforeCreate === 'function') beforeCreate(owner);
    const list = load();
    if (list.length >= LIMITS.agents) throw new RenderAgentError('Es sind keine weiteren Rechner möglich.', 'TOO_MANY_AGENTS', 409);
    if (list.filter((agent) => agent.owner === owner).length >= LIMITS.agentsPerPerson) {
      throw new RenderAgentError(`Du kannst höchstens ${LIMITS.agentsPerPerson} Rechner verbinden. Entferne zuerst einen.`, 'TOO_MANY_AGENTS', 409);
    }
    codes.delete(code);
    const token = `${TOKEN_PREFIX}${random(32).toString('base64url')}`;
    let id;
    do {
      id = `ra-${random(6).toString('hex')}`;
    } while (list.some((agent) => agent.id === id));
    const at = new Date(now()).toISOString();
    const agent = {
      id,
      owner,
      name: cleanName(name, 'Rechner'),
      platform: cleanPlatform(platform),
      versions: cleanVersions(versions),
      tokenHash: sha256(token).toString('hex'),
      shareTeams: false,
      shareAll: false,
      createdAt: at,
      lastSeenAt: at,
      completed: 0,
      failed: 0
    };
    save([...list, agent]);
    seen.set(id, { at: Date.parse(at), writtenAt: Date.parse(at) });
    return { agent: view(agent), token };
  }

  // Checks a presented token. The hash is compared with every stored hash (no early exit), so the time does not tell
  // whether, or how closely, a token matched. { ok: true, agent } or { ok: false, reason: 'malformed' | 'unknown' | 'unavailable' }.
  function authenticate(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { ok: false, reason: 'malformed' };
    let list;
    try {
      list = load();
    } catch (_) {
      return { ok: false, reason: 'unavailable' };
    }
    const digest = sha256(token);
    let match = null;
    for (const agent of list) {
      if (crypto.timingSafeEqual(Buffer.from(agent.tokenHash, 'hex'), digest)) match = agent;
    }
    return match ? { ok: true, agent: view(match) } : { ok: false, reason: 'unknown' };
  }

  /* ----- changes ----- */

  function update(id, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RenderAgentError('Die Änderung muss ein Objekt sein.', 'INVALID_CHANGE');
    const list = load().map((agent) => ({ ...agent }));
    const agent = list.find((entry) => entry.id === id);
    if (!agent) throw new RenderAgentError('Diesen Rechner gibt es nicht mehr.', 'AGENT_NOT_FOUND', 404);
    let changed = false;
    if (patch.name !== undefined) {
      agent.name = requireName(patch.name);
      changed = true;
    }
    for (const key of ['shareTeams', 'shareAll']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'boolean') throw new RenderAgentError(`${key} muss true oder false sein.`, 'INVALID_CHANGE');
      agent[key] = patch[key];
      changed = true;
    }
    if (!changed) throw new RenderAgentError('Nichts zu ändern: name, shareTeams oder shareAll angeben.', 'INVALID_CHANGE');
    save(list);
    return view(agent);
  }

  // Removes the computer: its token stops working at once.
  function remove(id) {
    const list = load();
    const agent = list.find((entry) => entry.id === id);
    if (!agent) throw new RenderAgentError('Diesen Rechner gibt es nicht mehr.', 'AGENT_NOT_FOUND', 404);
    save(list.filter((entry) => entry.id !== id));
    seen.delete(id);
    return view(agent);
  }

  // A sign of life with what the computer reports. "Last seen" is kept in memory and written at most once a minute;
  // platform and versions are written when they change.
  function touch(id, { platform, versions } = {}) {
    const at = now();
    const memory = seen.get(id) || { at: 0, writtenAt: 0 };
    memory.at = at;
    seen.set(id, memory);
    const list = load();
    const agent = list.find((entry) => entry.id === id);
    if (!agent) return;
    const nextPlatform = platform === undefined ? agent.platform : cleanPlatform(platform);
    const nextVersions = versions === undefined ? agent.versions : cleanVersions(versions);
    const reported = nextPlatform !== agent.platform || JSON.stringify(nextVersions) !== JSON.stringify(agent.versions);
    if (!reported && at - memory.writtenAt < LIMITS.seenWriteMs) return;
    memory.writtenAt = at;
    try {
      save(list.map((entry) => (entry.id === id ? { ...entry, platform: nextPlatform, versions: nextVersions, lastSeenAt: new Date(at).toISOString() } : entry)));
    } catch (err) {
      console.warn('[render-agents] Lebenszeichen konnte nicht gespeichert werden:', err.message);
    }
  }

  function lastSeenMs(id) {
    const memory = seen.get(id);
    if (memory) return memory.at;
    const agent = load().find((entry) => entry.id === id);
    const time = agent ? Date.parse(agent.lastSeenAt || '') : NaN;
    return Number.isFinite(time) ? time : 0;
  }

  function record(id, field) {
    const list = load();
    if (!list.some((entry) => entry.id === id)) return;
    try {
      save(list.map((entry) => (entry.id === id ? { ...entry, [field]: entry[field] + 1 } : entry)));
    } catch (err) {
      console.warn('[render-agents] Zähler konnte nicht gespeichert werden:', err.message);
    }
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    file,
    listAgents,
    listForOwner,
    count,
    getAgent,
    createPairingCode,
    checkCode,
    pair,
    authenticate,
    update,
    remove,
    touch,
    lastSeenMs,
    recordCompleted: (id) => record(id, 'completed'),
    recordFailed: (id) => record(id, 'failed'),
    onChange,
    // test hook: forget what is cached (a new process reads the file again)
    reload() {
      agents = null;
      seen.clear();
    }
  };
}

const defaultStore = createRenderAgentsStore();

module.exports = {
  AGENTS_FILE,
  TOKEN_PREFIX,
  TOKEN_PATTERN,
  AGENT_ID_PATTERN,
  CODE_ALPHABET,
  LIMITS,
  RenderAgentError,
  normaliseCode,
  normaliseOwner,
  cleanVersions,
  cleanPlatform,
  createRenderAgentsStore,
  defaultStore
};
