'use strict';

// Participant access policy. Read on every use so reductions and broken files take effect immediately.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS } = require('../config');

const POLICY_FILE = path.join(PATHS.root, 'data', 'mcp-policy.json');
const DEFAULT_PARTICIPANT = Object.freeze({
  enabled: true, defaultRunUsd: 1, defaultMonthUsd: 5, maxRunUsd: 5, maxMonthUsd: 25,
  defaultExpiresInDays: 30, maxExpiresInDays: 90, keysPerOwner: 3
});

class PolicyValidationError extends Error {
  constructor(message = 'Die Richtlinie für Teilnehmende ist ungültig oder konnte nicht gelesen werden.') {
    super(message);
    this.code = 'INVALID_POLICY';
  }
}

function validatePolicy(value, limits = require('./keys').LIMITS) {
  const p = value?.participant;
  const invalid = () => { throw new PolicyValidationError(); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !p || typeof p !== 'object' || Array.isArray(p)) invalid();
  if (Object.keys(value).some((key) => key !== 'participant') || Object.keys(p).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_PARTICIPANT, key))) invalid();
  if (typeof p.enabled !== 'boolean') invalid();
  for (const field of ['defaultRunUsd', 'defaultMonthUsd', 'maxRunUsd', 'maxMonthUsd']) {
    if (typeof p[field] !== 'number' || !Number.isFinite(p[field]) || p[field] < 0) invalid();
  }
  if (p.defaultRunUsd > p.maxRunUsd || p.defaultMonthUsd > p.maxMonthUsd || p.maxRunUsd > limits.maxRunUsd || p.maxMonthUsd > limits.maxMonthUsd) invalid();
  for (const field of ['defaultExpiresInDays', 'maxExpiresInDays']) {
    if (!Number.isInteger(p[field]) || p[field] < 1 || p[field] > Math.min(365, limits.maxExpiresInDays)) invalid();
  }
  if (p.defaultExpiresInDays > p.maxExpiresInDays || !Number.isInteger(p.keysPerOwner) || p.keysPerOwner < 1 || p.keysPerOwner > Math.min(25, limits.keysPerOwner)) invalid();
  return { participant: Object.fromEntries(Object.keys(DEFAULT_PARTICIPANT).map((key) => [key, p[key]])) };
}

function createPolicyStore({ file = POLICY_FILE, io = fs, limits } = {}) {
  function get() {
    let raw;
    try { raw = io.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return { participant: { ...DEFAULT_PARTICIPANT } };
      throw new PolicyValidationError();
    }
    try { return validatePolicy(JSON.parse(raw), limits); } catch (_) { throw new PolicyValidationError(); }
  }

  function set(value) {
    const policy = validatePolicy(value, limits);
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      io.chmodSync(temporary, 0o600);
      io.renameSync(temporary, file);
    } catch (_) {
      throw new PolicyValidationError('Die Richtlinie konnte nicht gespeichert werden.');
    } finally {
      try { io.unlinkSync(temporary); } catch (_) { /* renamed, or not created */ }
    }
    return policy;
  }
  return { get, set, file };
}

const defaultStore = createPolicyStore();
module.exports = { POLICY_FILE, DEFAULT_PARTICIPANT, PolicyValidationError, validatePolicy, createPolicyStore, defaultStore };
