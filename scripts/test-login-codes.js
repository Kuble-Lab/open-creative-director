'use strict';

// Login codes from the course lead (board #876, lib/login-codes.js): the file format and hash exactly as agreed with the
// login service (salt + ":" + email + ":" + code, sha256 hex, Unix seconds, 8 digits), replacing, revoking, expiry,
// permissions 600, admins only, members of active teams only, no plain code in the file, in the team view or in the
// logs, and the feature off without ACCESS_LOGIN_CODES_FILE. A private copy of the app runs in a temp directory (own
// data folders, ephemeral port, whoami stub); a fetch guard refuses everything except localhost.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const P3 = 'p3@gmail.example'; // only in an archived team
const GUEST = 'alumni@gmail.example';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const enc = encodeURIComponent;

function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return { attempts, restore: () => (global.fetch = original) };
}

// Everything the process writes to the console, to prove that no code ends up in a log.
function captureConsole() {
  const lines = [];
  const saved = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[name] = console[name];
    console[name] = (...args) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch (_) { return String(arg); } })())).join(' '));
      saved[name](...args);
    };
  }
  return { lines, restore: () => Object.assign(console, saved) };
}

const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const modeOf = (file) => fs.statSync(file).mode & 0o777;

function assertEntry(file, email, code, { hours, by = ADMIN }) {
  const document = readFile(file);
  assert.equal(document.version, 1);
  const entry = document.codes[email];
  assert.ok(entry, `entry for ${email}`);
  assert.deepEqual(Object.keys(entry).sort(), ['by', 'created', 'expires', 'hash', 'salt']);
  assert.match(entry.salt, /^[0-9a-f]{32}$/);
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.equal(entry.hash, sha(`${entry.salt}:${email}:${code}`), 'hash = sha256(salt:email:code)');
  assert.ok(Number.isInteger(entry.created) && Number.isInteger(entry.expires), 'Unix seconds as integers');
  assert.ok(Math.abs(entry.created - Date.now() / 1000) < 60, 'created is now (seconds, not milliseconds)');
  assert.equal(entry.expires - entry.created, hours * 3600);
  assert.equal(entry.by, by);
  assert.equal(modeOf(file), 0o600, 'permissions 600');
  return entry;
}

async function main() {
  const guard = guardFetch();
  const logs = captureConsole();
  const codes = [];
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-login-codes-'));
  const file = path.join(tmp, 'auth-service', 'login-codes.json'); // the folder does not exist yet
  let iso = null;
  try {
    await testModule(tmp, codes);
    iso = await createIsolatedApp({
      env: {
        ADMIN_EMAILS: ADMIN,
        INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
        OPENROUTER_API_KEY: '',
        ACCESS_ALLOWLIST_FILE: '',
        ACCESS_ALLOWLIST_ROUTE: '',
        ACCESS_LOGIN_CODES_FILE: file,
        ELEVENLABS_API_KEY: '',
        FAL_KEY: '',
        GTS_API_TOKEN: ''
      }
    });
    await iso.listen();
    await testRoutes(iso, file, codes);
  } finally {
    logs.restore();
    if (iso) await iso.cleanup();
    await fsp.rm(tmp, { recursive: true, force: true });
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  assert.ok(codes.length >= 5);
  for (const code of codes) {
    assert.ok(!logs.lines.some((line) => line.includes(code)), 'no plain code in the logs');
  }
  console.log('Login-Codes: Dateiformat und Hash nach Vertrag, 8 Ziffern, Ersetzen, Widerruf, Ablauf, Rechte 600, nur Admins, nur Mitglieder aktiver Teams, kein Klartext in Datei, Teamansicht und Log, aus ohne ACCESS_LOGIN_CODES_FILE.');
  console.log('test-login-codes.js: ok');
}

/* ---------- the module with its own clock ---------- */

async function testModule(tmp, codes) {
  const lib = require('../lib/login-codes');
  const file = path.join(tmp, 'module', 'codes.json');
  let clock = Date.UTC(2026, 9, 20, 8, 0, 0);
  const instance = lib.createLoginCodes({ env: { ACCESS_LOGIN_CODES_FILE: file }, now: () => clock });

  // off without the variable: nothing is written
  const off = lib.createLoginCodes({ env: {} });
  assert.equal(off.enabled(), false);
  assert.deepEqual(off.list(), {});
  await assert.rejects(() => off.create({ email: P1 }), (err) => err.code === 'LOGIN_CODES_DISABLED');

  // tolerant reading: missing file, broken file, broken entries
  assert.deepEqual(instance.list(), {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ nicht json');
  assert.deepEqual(instance.list(), {});
  assert.equal(instance.statusOf(P1), null);

  // 8 digits with leading zeros, hours 24 by default
  const zero = lib.createLoginCodes({ env: { ACCESS_LOGIN_CODES_FILE: file }, now: () => clock, randomInt: (min, max) => (assert.deepEqual([min, max], [0, 100000000]), 4211) });
  const padded = await zero.create({ email: ` ${P1.toUpperCase()} `, by: ADMIN });
  assert.equal(padded.code, '00004211');
  codes.push(padded.code);
  let document = readFile(file);
  assert.deepEqual(Object.keys(document.codes), [P1], 'key in lower case, trimmed; the broken file was replaced');
  assert.equal(document.codes[P1].hash, sha(`${document.codes[P1].salt}:${P1}:00004211`));
  assert.equal(document.codes[P1].expires - document.codes[P1].created, 24 * 3600);
  assert.equal(document.codes[P1].created, clock / 1000);
  assert.equal(padded.expiresAt, new Date(clock + 24 * 3600 * 1000).toISOString());
  assert.equal(modeOf(file), 0o600);

  // a broken entry next to a valid one is ignored and dropped on the next write
  document.codes['kaputt@example.com'] = { salt: 'x', hash: 'y' };
  fs.writeFileSync(file, JSON.stringify(document));
  assert.deepEqual(Object.keys(instance.list()), [P1]);

  // validation
  await assert.rejects(() => instance.create({ email: P2, hours: 48 }), (err) => err.code === 'INVALID_HOURS');
  await assert.rejects(() => instance.create({ email: '', hours: 24 }), (err) => err.code === 'INVALID_EMAIL');

  // 7 days, serialised writes: three at the same moment all land
  const results = await Promise.all([instance.create({ email: P2, hours: 168 }), instance.create({ email: P3, hours: '24' }), instance.create({ email: GUEST })]);
  for (const result of results) {
    assert.match(result.code, /^\d{8}$/);
    codes.push(result.code);
  }
  document = readFile(file);
  assert.deepEqual(Object.keys(document.codes).sort(), [GUEST, P1, P2, P3].sort(), 'the broken entry is gone, nothing overwritten');
  assert.equal(document.codes[P2].expires - document.codes[P2].created, 168 * 3600);
  assert.equal(instance.list()[P2].by, null);
  assert.deepEqual(Object.keys(instance.list()[P2]).sort(), ['by', 'created', 'expires'], 'list() without salt and hash');

  // expiry: after 24 h the 24-hour codes are gone from list(), and the next write removes them from the file
  clock += 24 * 3600 * 1000;
  assert.deepEqual(Object.keys(instance.list()), [P2]);
  assert.equal(instance.statusOf(P1), null);
  assert.equal(instance.statusOf(P2).expiresAt, new Date(document.codes[P2].expires * 1000).toISOString());
  assert.equal(Object.keys(readFile(file).codes).length, 4, 'reading never writes');
  assert.equal(await instance.revoke('niemand@example.com'), false);
  assert.equal(Object.keys(readFile(file).codes).length, 4, 'a revoke without a code writes nothing');
  assert.equal(await instance.revoke(P2), true);
  assert.deepEqual(readFile(file).codes, {}, 'revoked and the expired entries cleaned up');

  // retainOnly drops the codes of people without access
  await instance.create({ email: P1 }).then((result) => codes.push(result.code));
  await instance.create({ email: P2 }).then((result) => codes.push(result.code));
  assert.equal(await instance.retainOnly([P2.toUpperCase()]), 1);
  assert.deepEqual(Object.keys(readFile(file).codes), [P2]);
  assert.equal(await instance.retainOnly([P2]), 0);

  // a failed write rejects but the queue goes on
  const blocked = lib.createLoginCodes({ env: { ACCESS_LOGIN_CODES_FILE: path.join(file, 'nicht-moeglich.json') } });
  await assert.rejects(() => blocked.create({ email: P1 }));
  await assert.rejects(() => blocked.create({ email: P1 }));
  assert.equal(await blocked.revoke(P1), false);
}

/* ---------- the routes ---------- */

async function testRoutes(iso, file, codes) {
  const call = (as, method, url, json) => iso.request(url, { method, as, json });

  // two teams: Kurs A active with P1 and P2, Kurs B archived with P3
  const teamA = (await call(ADMIN, 'POST', '/api/teams', { name: 'Kurs A', budgetUsd: 10 })).body.team;
  const teamB = (await call(ADMIN, 'POST', '/api/teams', { name: 'Kurs B', budgetUsd: 10 })).body.team;
  assert.equal((await call(ADMIN, 'POST', `/api/teams/${teamA.id}/members`, { emails: [P1, P2] })).status, 201);
  assert.equal((await call(ADMIN, 'POST', `/api/teams/${teamB.id}/members`, { emails: [P3] })).status, 201);
  assert.equal((await call(ADMIN, 'PATCH', `/api/teams/${teamB.id}`, { archived: true })).status, 200);
  const url = `/api/teams/${teamA.id}/login-code`;

  // the team view says the feature is on; nobody has a code yet
  let detail = (await call(ADMIN, 'GET', `/api/teams/${teamA.id}`)).body.team;
  assert.equal(detail.loginCodesEnabled, true);
  assert.deepEqual(detail.members.map((member) => member.loginCode), [null, null]);
  assert.ok(!fs.existsSync(file), 'reading writes nothing');

  // admins only: internal people, participants and guests get 403, nothing is written
  for (const email of [STAFF, P1, GUEST]) {
    assert.equal((await call(email, 'POST', url, { email: P1, hours: 24 })).status, 403, `POST as ${email}`);
    assert.equal((await call(email, 'DELETE', url, { email: P1 })).status, 403, `DELETE as ${email}`);
  }
  assert.ok(!fs.existsSync(file));

  // create: 8 digits, no-store, expiry in the answer, file exactly as agreed
  const first = await call(ADMIN, 'POST', url, { email: ` ${P1.toUpperCase()} `, hours: 24 });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(first.body.code, /^\d{8}$/);
  assert.equal(first.body.email, P1);
  codes.push(first.body.code);
  let entry = assertEntry(file, P1, first.body.code, { hours: 24 });
  assert.equal(first.body.expiresAt, new Date(entry.expires * 1000).toISOString());
  assert.ok(!fs.readFileSync(file, 'utf8').includes(first.body.code), 'no plain code in the file');
  assert.ok(!fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), 'no temporary file left');

  // the team view shows the expiry, never the code
  const view = await call(ADMIN, 'GET', `/api/teams/${teamA.id}`);
  assert.ok(!view.text.includes(first.body.code), 'no plain code in the team view');
  assert.ok(!view.text.includes(entry.hash) && !view.text.includes(entry.salt), 'no hash or salt in the team view');
  detail = view.body.team;
  assert.deepEqual(detail.members.find((member) => member.email === P1).loginCode, { expiresAt: first.body.expiresAt });
  assert.equal(detail.members.find((member) => member.email === P2).loginCode, null);
  assert.ok(!first.text.includes(entry.hash) && !JSON.stringify(first.body.team).includes(first.body.code), 'the team in the answer has no code either');
  const list = await call(ADMIN, 'GET', '/api/teams');
  assert.ok(!list.text.includes(first.body.code));

  // replace: a new code (7 days) takes the place of the old one
  const second = await call(ADMIN, 'POST', url, { email: P1, hours: 168 });
  assert.equal(second.status, 200, second.text);
  codes.push(second.body.code);
  entry = assertEntry(file, P1, second.body.code, { hours: 168 });
  assert.notEqual(entry.hash, sha(`${entry.salt}:${P1}:${first.body.code}`), 'the old code no longer matches');
  assert.deepEqual(Object.keys(readFile(file).codes), [P1]);

  // only members of active teams, clear refusals, the file stays as it is
  const before = fs.readFileSync(file, 'utf8');
  for (const [target, json, status, code] of [
    [url, { email: GUEST, hours: 24 }, 404, 'MEMBER_NOT_FOUND'],
    [url, { email: P3, hours: 24 }, 404, 'MEMBER_NOT_FOUND'],
    [`/api/teams/${teamB.id}/login-code`, { email: P3, hours: 24 }, 400, 'TEAM_ARCHIVED'],
    ['/api/teams/gibt-es-nicht/login-code', { email: P1, hours: 24 }, 404, 'TEAM_NOT_FOUND'],
    [url, { email: 'keine-adresse', hours: 24 }, 400, 'INVALID_EMAIL'],
    [url, { email: P2, hours: 48 }, 400, 'INVALID_HOURS']
  ]) {
    const response = await call(ADMIN, 'POST', target, json);
    assert.equal(response.status, status, `${JSON.stringify(json)}: ${response.text}`);
    assert.equal(response.body.code, code);
    assert.ok(response.body.error, 'a clear message');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // two clicks at the same moment: both codes land
  const [a, b] = await Promise.all([call(ADMIN, 'POST', url, { email: P2 }), call(ADMIN, 'POST', url, { email: P1, hours: 24 })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  codes.push(a.body.code, b.body.code);
  assertEntry(file, P2, a.body.code, { hours: 24 });
  assertEntry(file, P1, b.body.code, { hours: 24 });

  // an expired entry (written by hand) disappears with the next write
  const document = readFile(file);
  document.codes['alt@example.com'] = { salt: '0'.repeat(32), hash: '0'.repeat(64), created: 1000, expires: 2000, by: ADMIN };
  fs.writeFileSync(file, JSON.stringify(document));

  // revoke
  const revoked = await call(ADMIN, 'DELETE', url, { email: P2 });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.headers.get('cache-control'), 'no-store');
  assert.equal(revoked.body.revoked, true);
  assert.equal(revoked.body.team.members.find((member) => member.email === P2).loginCode, null);
  assert.deepEqual(Object.keys(readFile(file).codes), [P1], 'revoked; the expired entry is gone');
  assert.equal(modeOf(file), 0o600);
  assert.equal((await call(ADMIN, 'DELETE', url, { email: P2 })).body.revoked, false, 'revoking twice is no error');
  assert.equal((await call(ADMIN, 'DELETE', url, { email: 'x' })).status, 400);
  assert.equal((await call(ADMIN, 'DELETE', '/api/teams/gibt-es-nicht/login-code', { email: P1 })).status, 404);

  // people who lose their access lose their code: removed from the team, team archived
  const third = await call(ADMIN, 'POST', url, { email: P2 });
  codes.push(third.body.code);
  assert.equal((await call(ADMIN, 'DELETE', `/api/teams/${teamA.id}/members/${enc(P2)}`)).status, 200);
  await iso.load('lib/login-codes').settled();
  assert.deepEqual(Object.keys(readFile(file).codes), [P1], 'the removed member has no code any more');
  assert.equal((await call(ADMIN, 'PATCH', `/api/teams/${teamA.id}`, { archived: true })).status, 200);
  await iso.load('lib/login-codes').settled();
  assert.deepEqual(readFile(file).codes, {}, 'archived team: no codes');
  assert.equal((await call(ADMIN, 'POST', url, { email: P1 })).body.code, 'TEAM_ARCHIVED');
  assert.equal((await call(ADMIN, 'PATCH', `/api/teams/${teamA.id}`, { archived: false })).status, 200);

  // a broken file counts as empty and is replaced by the next code
  fs.writeFileSync(file, 'kaputt');
  detail = (await call(ADMIN, 'GET', `/api/teams/${teamA.id}`)).body.team;
  assert.equal(detail.members.find((member) => member.email === P1).loginCode, null);
  const fourth = await call(ADMIN, 'POST', url, { email: P1 });
  assert.equal(fourth.status, 200);
  codes.push(fourth.body.code);
  assertEntry(file, P1, fourth.body.code, { hours: 24 });

  // off without the variable: no button data, the routes refuse, the file is not touched
  iso.setEnv('ACCESS_LOGIN_CODES_FILE', '');
  try {
    detail = (await call(ADMIN, 'GET', `/api/teams/${teamA.id}`)).body.team;
    assert.equal(detail.loginCodesEnabled, false);
    assert.ok(detail.members.every((member) => member.loginCode === null));
    const stamp = fs.readFileSync(file, 'utf8');
    const refused = await call(ADMIN, 'POST', url, { email: P1 });
    assert.equal(refused.status, 404);
    assert.equal(refused.body.code, 'LOGIN_CODES_DISABLED');
    assert.equal((await call(ADMIN, 'DELETE', url, { email: P1 })).body.code, 'LOGIN_CODES_DISABLED');
    assert.equal((await call(P1, 'POST', url, { email: P1 })).status, 403, 'still admins only');
    assert.equal(fs.readFileSync(file, 'utf8'), stamp);
  } finally {
    iso.setEnv('ACCESS_LOGIN_CODES_FILE', file);
  }
  await sleep(10);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
