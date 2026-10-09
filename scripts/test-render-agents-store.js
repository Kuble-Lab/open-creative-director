'use strict';

// The store of the own computers (WP46, lib/render-agents.js): pairing codes (format, 10 minutes, once, bound to the person,
// one open code per person, limits per IP address and per code), tokens (long and random, stored only as a hash, checked
// in constant time over all computers), the file (mode 600, written atomically, a restart keeps every pairing), changes,
// removal and the sign of life. No network.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agentsLib = require('../lib/render-agents');

const { createRenderAgentsStore, LIMITS, TOKEN_PATTERN, AGENT_ID_PATTERN, CODE_ALPHABET } = agentsLib;
const VERSIONS = { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0', ffmpeg: '6.1.1', ffmpegSource: 'bundled' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-render-agents-'));
  const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
  const file = path.join(dir, 'data', 'render-agents.json');
  const store = createRenderAgentsStore({ file, now: () => clock.now });
  return { dir, file, clock, store, again: () => createRenderAgentsStore({ file, now: () => clock.now }) };
}

function expectError(fn, code, status) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    if (status) assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected ${code}`);
}

function testCodes() {
  const { store, clock } = setup();
  const first = store.createPairingCode('Anna@Example.com');
  assert.match(first.code, new RegExp(`^[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`), 'short, readable, no look-alikes');
  assert.equal(first.ttlSeconds, 600);
  assert.equal(Date.parse(first.expiresAt) - clock.now, 10 * 60 * 1000);
  // the person is bound to the code (lower case), the code is checked without being used up
  assert.deepEqual(store.checkCode(first.code.toLowerCase(), '10.0.0.1').owner, 'anna@example.com');
  assert.equal(store.checkCode(first.code.replace('-', ' '), '10.0.0.1').owner, 'anna@example.com', 'spaces and dashes do not count');
  // one open code per person: a new one ends the old one
  const second = store.createPairingCode('anna@example.com');
  expectError(() => store.checkCode(first.code, '10.0.0.1'), 'INVALID_CODE', 401);
  assert.equal(store.checkCode(second.code, '10.0.0.1').owner, 'anna@example.com');
  // 10 minutes
  clock.now += 10 * 60 * 1000 - 1;
  assert.equal(store.checkCode(second.code, '10.0.0.2').owner, 'anna@example.com');
  clock.now += 1;
  expectError(() => store.checkCode(second.code, '10.0.0.2'), 'INVALID_CODE', 401);
  // once: pairing uses it up
  const third = store.createPairingCode('anna@example.com');
  const paired = store.pair({ code: third.code, ip: '10.0.0.3', name: 'Annas Mac', platform: 'darwin-arm64', versions: VERSIONS });
  assert.equal(paired.agent.owner, 'anna@example.com');
  expectError(() => store.pair({ code: third.code, ip: '10.0.0.3', name: 'Noch einmal' }), 'INVALID_CODE', 401);
  assert.equal(store.count(), 1);
}

function testLimits() {
  const { store, clock } = setup();
  // per IP: ten wrong codes, then even a right code is refused for a while
  const good = store.createPairingCode('ben@example.com');
  for (let i = 0; i < LIMITS.failuresPerIp; i += 1) expectError(() => store.checkCode('AAAA-AAAA', '192.0.2.7'), 'INVALID_CODE', 401);
  const limited = expectError(() => store.checkCode(good.code, '192.0.2.7'), 'RATE_LIMITED', 429);
  assert.ok(limited.retryAfterSeconds > 0 && limited.retryAfterSeconds <= 600);
  assert.equal(store.checkCode(good.code, '192.0.2.8').owner, 'ben@example.com', 'another address is not affected');
  clock.now += LIMITS.failureWindowMs;
  const fresh = store.createPairingCode('ben@example.com');
  assert.equal(store.checkCode(fresh.code, '192.0.2.7').owner, 'ben@example.com', 'the window passes');
  // per code: a valid code works a limited number of times (downloads and pairing attempts), then it is gone
  const counted = store.createPairingCode('carla@example.com');
  for (let i = 0; i < LIMITS.codeUses; i += 1) store.checkCode(counted.code, `198.51.100.${i}`);
  expectError(() => store.checkCode(counted.code, '198.51.100.99'), 'INVALID_CODE', 401);
  // codes per person
  for (let i = 1; i < LIMITS.codesPerPerson; i += 1) store.createPairingCode('dora@example.com');
  store.createPairingCode('dora@example.com');
  expectError(() => store.createPairingCode('dora@example.com'), 'TOO_MANY_CODES', 429);
  // computers per person
  const { store: other, clock: otherClock } = setup();
  for (let i = 0; i < LIMITS.agentsPerPerson; i += 1) {
    otherClock.now += LIMITS.codeWindowMs; // one code per window: the limit of the codes does not count here
    const { code } = other.createPairingCode('eva@example.com');
    other.pair({ code, ip: '203.0.113.1', name: `Rechner ${i}` });
  }
  otherClock.now += LIMITS.codeWindowMs;
  expectError(() => other.createPairingCode('eva@example.com'), 'TOO_MANY_AGENTS', 409);
}

function testTokens() {
  const { store, file, again } = setup();
  const { code } = store.createPairingCode('fritz@example.com');
  // a refusal before the pairing (the version check of the routes) keeps the code
  expectError(() => store.pair({ code, ip: '10.1.1.1', name: 'X', beforeCreate: () => { const err = new Error('alt'); err.code = 'AGENT_OUTDATED'; err.status = 426; throw err; } }), 'AGENT_OUTDATED', 426);
  const { agent, token } = store.pair({ code, ip: '10.1.1.1', name: '  Fritz   Laptop ', platform: 'win32-x64', versions: { ...VERSIONS, evil: 'x', ffmpeg: '<script>' } });
  assert.match(token, TOKEN_PATTERN);
  assert.ok(token.length >= 48, 'long and random (32 bytes)');
  assert.match(agent.id, AGENT_ID_PATTERN);
  assert.equal(agent.name, 'Fritz Laptop');
  assert.equal(agent.platform, 'win32-x64');
  assert.equal(agent.versions.evil, undefined);
  assert.equal(agent.versions.ffmpeg, undefined, 'odd version texts are dropped');
  assert.equal(agent.tokenHash, undefined, 'the view has no hash');
  // only the hash is stored, the file is mode 600, no temporary files stay
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token) && !raw.includes(token.slice(5)), 'the token is not in the file');
  assert.ok(raw.includes(crypto.createHash('sha256').update(token).digest('hex')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['render-agents.json']);
  // checking a token
  assert.equal(store.authenticate(token).agent.id, agent.id);
  assert.equal(store.authenticate(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`).reason, 'unknown');
  assert.equal(store.authenticate('ocra_short').reason, 'malformed');
  assert.equal(store.authenticate(undefined).reason, 'malformed');
  // constant time: every stored hash is compared, whether the token matches or not
  for (let i = 0; i < 3; i += 1) {
    const next = store.createPairingCode(`p${i}@example.com`);
    store.pair({ code: next.code, ip: '10.1.1.2', name: `P${i}` });
  }
  const original = crypto.timingSafeEqual;
  let comparisons = 0;
  crypto.timingSafeEqual = (a, b) => {
    comparisons += 1;
    return original(a, b);
  };
  try {
    store.authenticate(token);
    assert.equal(comparisons, 4, 'a match does not stop the loop');
    comparisons = 0;
    store.authenticate(`ocra_${'x'.repeat(43)}`);
    assert.equal(comparisons, 4);
  } finally {
    crypto.timingSafeEqual = original;
  }
  // a restart keeps the pairing (a new process reads the file)
  const later = again();
  assert.equal(later.authenticate(token).agent.name, 'Fritz Laptop');
  assert.equal(later.count(), 4);
}

function testChanges() {
  const { store, clock, file } = setup();
  const { code } = store.createPairingCode('gina@example.com');
  const { agent, token } = store.pair({ code, ip: '10.2.2.2', name: '', platform: 'nonsense', versions: VERSIONS });
  assert.equal(agent.name, 'Rechner', 'an empty name gets a default');
  assert.equal(agent.platform, 'unknown');
  assert.equal(store.update(agent.id, { name: '  Studio  Mac ' }).name, 'Studio Mac');
  expectError(() => store.update(agent.id, { name: '' }), 'INVALID_NAME');
  expectError(() => store.update(agent.id, { name: 'x'.repeat(LIMITS.nameChars + 1) }), 'INVALID_NAME');
  expectError(() => store.update(agent.id, { shareTeams: 'yes' }), 'INVALID_CHANGE');
  expectError(() => store.update(agent.id, {}), 'INVALID_CHANGE');
  expectError(() => store.update('ra-000000000000', { name: 'x' }), 'AGENT_NOT_FOUND', 404);
  const shared = store.update(agent.id, { shareTeams: true, shareAll: true });
  assert.equal(shared.shareTeams, true);
  assert.equal(shared.shareAll, true);
  assert.deepEqual(store.listForOwner('GINA@example.com').map((entry) => entry.id), [agent.id]);
  assert.deepEqual(store.listForOwner('other@example.com'), []);
  // the sign of life: in memory at once, in the file at most once a minute, at once when the versions change
  const written = fs.statSync(file).mtimeMs;
  clock.now += 5000;
  store.touch(agent.id, { platform: 'nonsense', versions: VERSIONS });
  assert.equal(store.getAgent(agent.id).lastSeenAt, new Date(clock.now).toISOString());
  assert.equal(fs.statSync(file).mtimeMs, written, 'not written for a poll');
  store.touch(agent.id, { platform: 'darwin-arm64', versions: { ...VERSIONS, hyperframes: '0.8.140' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents[0].versions.hyperframes, '0.8.140');
  store.recordCompleted(agent.id);
  store.recordCompleted(agent.id);
  store.recordFailed(agent.id);
  assert.equal(store.getAgent(agent.id).completed, 2);
  assert.equal(store.getAgent(agent.id).failed, 1);
  // removal: the token stops working at once
  store.remove(agent.id);
  assert.equal(store.authenticate(token).ok, false);
  expectError(() => store.remove(agent.id), 'AGENT_NOT_FOUND', 404);
  // a damaged record is dropped, not trusted
  fs.writeFileSync(file, JSON.stringify({ version: 1, agents: [{ id: 'ra-zz', tokenHash: 'x' }, { id: 'ra-0123456789ab', owner: 'H@Example.com', tokenHash: 'a'.repeat(64), name: 'ok' }] }));
  const reread = createRenderAgentsStore({ file, now: () => clock.now });
  assert.deepEqual(reread.listAgents().map((entry) => [entry.id, entry.owner]), [['ra-0123456789ab', 'h@example.com']]);
}

testCodes();
testLimits();
testTokens();
testChanges();
console.log('Eigene Rechner (Speicher): Codes, Limits, Token als Hash, Datei mit Modus 600, Neustart, Änderungen und Entfernen sind korrekt.');
console.log('test-render-agents-store.js: ok');
