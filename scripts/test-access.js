'use strict';

// Unit tests of the user-management building blocks: mode and identity (lib/access.js), the team list with
// automatic capture (lib/users.js) and the monitoring aggregation (lib/admin-monitoring.js). No server, no network;
// files live in a temp directory.

const assert = require('assert/strict');
const fs = require('fs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const access = require('../lib/access');
const admins = require('../lib/admins');
const monitoring = require('../lib/admin-monitoring');
const { createUsersStore, UserValidationError, UserNotFoundError } = require('../lib/users');

const ACTIVE_ENV = { AUTH_WHOAMI_URL: 'https://whoami.invalid/me', ADMIN_EMAILS: 'admin@example.com', SUPERADMIN_EMAILS: ' Boss@Example.ORG ,not-an-address,' };
const LOCAL_ENV = {};

function viewer(email, env = ACTIVE_ENV) {
  return access.viewerOf({ kubleUser: email }, env);
}

function testMode() {
  assert.equal(access.isActive(LOCAL_ENV), false);
  assert.equal(access.isActive({ AUTH_WHOAMI_URL: '   ' }), false);
  assert.equal(access.isActive(ACTIVE_ENV), true);

  const local = access.viewerOf({ kubleUser: 'lokal' }, LOCAL_ENV);
  assert.deepEqual({ ...local }, { active: false, email: null, identified: false, admin: true, superadmin: false });
  assert.equal(access.roleOf(local), 'local');
  // In the local mode everything is allowed, even for entries that would be private.
  const privateEntry = { owner: 'alice@example.com', shareMode: 'private', sharedWith: [] };
  assert.equal(access.canUse(privateEntry, local), true);
  assert.equal(access.canManage(privateEntry, local), true);
  assert.equal(access.canShare(privateEntry, local), false, 'there is nothing to share without user management');
  assert.equal(access.ownerForNew(local), null);
}

function testIdentity() {
  assert.equal(access.normalizeEmail(' Alice@Example.COM '), 'alice@example.com');
  for (const bad of ['lokal', '', '   ', 'a@b', 'a@b.', '@x.com', 'a b@x.com', 'a@@x.com', null, undefined, 42]) {
    assert.equal(access.normalizeEmail(bad), null, String(bad));
  }
  assert.deepEqual(access.superadminEmails(ACTIVE_ENV), ['boss@example.org'], 'any domain, invalid entries ignored');
  assert.deepEqual(access.superadminEmails(LOCAL_ENV), []);

  const anonymous = viewer('lokal');
  assert.deepEqual({ ...anonymous }, { active: true, email: null, identified: false, superadmin: false, admin: false });
  assert.equal(access.roleOf(anonymous), 'anonymous');
  assert.equal(access.roleOf(viewer('')), 'anonymous');
  const user = viewer('Alice@example.com');
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.admin, false);
  assert.equal(access.roleOf(user), 'user');
  const admin = viewer('ADMIN@example.com');
  assert.equal(admin.admin, true);
  assert.equal(admin.superadmin, false);
  assert.equal(access.roleOf(admin), 'admin');
  const boss = viewer('boss@example.org');
  assert.equal(boss.superadmin, true);
  assert.equal(boss.admin, true, 'a superadmin is an admin as well');
  assert.equal(access.roleOf(boss), 'superadmin');

  // A superadmin cannot be made by a client-supplied role or a header.
  assert.equal(access.viewerOf({ kubleUser: 'alice@example.com', headers: { 'x-role': 'superadmin' }, body: { superadmin: true } }, ACTIVE_ENV).superadmin, false);
}

function testRules() {
  const alice = viewer('alice@example.com');
  const bob = viewer('bob@example.com');
  const carol = viewer('carol@example.com');
  const admin = viewer('admin@example.com');
  const anonymous = viewer('lokal');
  const entry = (extra) => ({ owner: 'alice@example.com', shareMode: 'private', sharedWith: [], ...extra });

  // private: owner and admins
  assert.equal(access.canUse(entry(), alice), true);
  assert.equal(access.canUse(entry(), bob), false);
  assert.equal(access.canUse(entry(), anonymous), false);
  assert.equal(access.canUse(entry(), admin), true);
  // team: every identified person, but not the anonymous caller
  assert.equal(access.canUse(entry({ shareMode: 'team' }), bob), true);
  assert.equal(access.canUse(entry({ shareMode: 'team' }), anonymous), false);
  // specific: only the listed people; sharedWith is ignored for the other modes
  const specific = entry({ shareMode: 'specific', sharedWith: ['Bob@example.com'] });
  assert.equal(access.canUse(specific, bob), true);
  assert.equal(access.canUse(specific, carol), false);
  assert.equal(access.canUse(entry({ shareMode: 'private', sharedWith: ['bob@example.com'] }), bob), false);
  assert.equal(access.canUse(entry({ shareMode: 'team', sharedWith: ['bob@example.com'] }), carol), true);

  // Existing data without an owner: visible and usable for everybody, also the anonymous caller
  for (const shape of [{}, { owner: null }, { owner: 'lokal' }, { owner: '', shareMode: 'private' }]) {
    for (const who of [alice, bob, anonymous, admin]) assert.equal(access.canUse(shape, who), true, JSON.stringify(shape));
    for (const who of [alice, bob, anonymous, admin]) assert.equal(access.canManage(shape, who), true, 'delete / rename like before');
    assert.equal(access.canShare(shape, alice), false, 'only admins change the sharing of existing data');
    assert.equal(access.canShare(shape, anonymous), false);
    assert.equal(access.canShare(shape, admin), true);
  }

  // manage / share
  assert.equal(access.canManage(entry(), alice), true);
  assert.equal(access.canManage(entry({ shareMode: 'team' }), bob), false);
  assert.equal(access.canManage(entry(), admin), true);
  assert.equal(access.canShare(entry(), alice), true);
  assert.equal(access.canShare(entry({ shareMode: 'team' }), bob), false);
  assert.equal(access.canShare(entry({ shareMode: 'team' }), admin), true);
  assert.equal(access.ownerForNew(alice), 'alice@example.com');
  assert.equal(access.ownerForNew(anonymous), null, 'anonymous creations get no owner');

  // describe(): sharedWith only for those who may change the sharing
  const describedForOwner = access.describe(specific, alice);
  assert.deepEqual(describedForOwner.sharedWith, ['bob@example.com']);
  assert.equal(describedForOwner.mine, true);
  assert.equal(describedForOwner.canManage, true);
  const describedForBob = access.describe(specific, bob);
  assert.equal('sharedWith' in describedForBob, false);
  assert.equal(describedForBob.sharedCount, 1);
  assert.equal(describedForBob.mine, false);
  assert.equal(describedForBob.canManage, false);
  assert.equal(describedForBob.canShare, false);
  assert.equal(access.describe({}, bob).unowned, true);
  assert.equal(access.describe(entry({ owner: 'admin@example.com' }), admin, access.createAdminLookup(ACTIVE_ENV)).ownerIsAdmin, true);
  assert.equal(access.describe(entry(), admin, access.createAdminLookup(ACTIVE_ENV)).ownerIsAdmin, false);

  // normalisation of old and broken files
  assert.deepEqual(access.sharingOf({}), { owner: null, shareMode: 'private', sharedWith: [] });
  assert.deepEqual(access.sharingOf({ owner: 'A@B.CO', shareMode: 'bogus', sharedWith: ['x@y.zz', 'X@Y.ZZ', 'nope', 3] }), {
    owner: 'a@b.co',
    shareMode: 'private',
    sharedWith: ['x@y.zz']
  });
  const many = Array.from({ length: 150 }, (_, i) => `p${i}@example.com`);
  assert.equal(access.sharingOf({ owner: 'a@b.co', shareMode: 'specific', sharedWith: many }).sharedWith.length, 100);
}

function testBuildSharing() {
  const team = new Set(['bob@example.com', 'carol@example.com']);
  const known = (email) => team.has(email);
  assert.deepEqual(access.buildSharing({ shareMode: 'private', sharedWith: ['bob@example.com'] }, {}, known), { shareMode: 'private', sharedWith: [] });
  assert.deepEqual(access.buildSharing({ shareMode: 'team' }, {}, known), { shareMode: 'team', sharedWith: [] });
  assert.deepEqual(access.buildSharing({ shareMode: 'specific', sharedWith: ['BOB@example.com', 'bob@example.com'] }, {}, known), {
    shareMode: 'specific',
    sharedWith: ['bob@example.com']
  });
  assert.throws(() => access.buildSharing({ shareMode: 'public' }, {}, known), /shareMode/);
  assert.throws(() => access.buildSharing(null, {}, known), access.AccessValidationError);
  assert.throws(() => access.buildSharing({ shareMode: 'specific' }, {}, known), /list/);
  assert.throws(() => access.buildSharing({ shareMode: 'specific', sharedWith: [] }, {}, known), /at least one/);
  assert.throws(() => access.buildSharing({ shareMode: 'specific', sharedWith: ['nope'] }, {}, known), /invalid/);
  assert.throws(
    () => access.buildSharing({ shareMode: 'specific', sharedWith: ['dave@example.com'] }, {}, known),
    (error) => error.code === 'UNKNOWN_TEAM_MEMBERS' && /dave@example.com/.test(error.message)
  );
  // somebody who already has access keeps it even if they are no longer on the list
  assert.deepEqual(
    access.buildSharing({ shareMode: 'specific', sharedWith: ['dave@example.com'] }, { shareMode: 'specific', sharedWith: ['dave@example.com'] }, known).sharedWith,
    ['dave@example.com']
  );
  assert.throws(() => access.buildSharing({ shareMode: 'specific', sharedWith: many(101) }, {}, () => true), /At most 100/);
}

function many(n) {
  return Array.from({ length: n }, (_, i) => `p${i}@example.com`);
}

async function testUsersStore() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-users-'));
  const usersFile = path.join(directory, 'users.json');
  const seenFile = path.join(directory, 'team-seen.json');
  let clock = Date.parse('2026-09-30T08:00:00.000Z');
  const store = createUsersStore({ usersFile, seenFile, now: () => clock, env: ACTIVE_ENV });
  const originalStored = admins.listStoredAdmins;
  admins.listStoredAdmins = () => ['stored@example.com'];
  try {
    // admins come first and are the only ones with role admin
    assert.deepEqual(
      store.listMembers().map((member) => `${member.email}:${member.role}`),
      ['admin@example.com:admin', 'boss@example.org:admin', 'stored@example.com:admin']
    );

    // automatic capture: the first sight records first + last seen, later sights inside a minute do not write
    assert.equal(store.touch('Alice@Example.com'), true);
    assert.equal(store.touch('lokal'), false, 'the placeholder is never recorded');
    assert.equal(store.touch('not an address'), false);
    let seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    assert.deepEqual(Object.keys(seen), ['alice@example.com']);
    assert.equal(seen['alice@example.com'].firstSeen, '2026-09-30T08:00:00.000Z');
    assert.equal(seen['alice@example.com'].lastSeen, '2026-09-30T08:00:00.000Z');
    assert.equal(fs.statSync(seenFile).mode & 0o777, 0o600);
    const mtimeBefore = fs.statSync(seenFile).mtimeMs;
    clock += 30 * 1000;
    assert.equal(store.touch('alice@example.com'), false);
    assert.equal(fs.statSync(seenFile).mtimeMs, mtimeBefore, 'no write inside the interval');
    clock += 45 * 1000;
    assert.equal(store.touch('alice@example.com'), false, 'not new any more, but last seen moves');
    seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    assert.equal(seen['alice@example.com'].firstSeen, '2026-09-30T08:00:00.000Z');
    assert.equal(seen['alice@example.com'].lastSeen, '2026-09-30T08:01:15.000Z');

    // admins can be recorded as well, and keep the admin role
    store.touch('admin@example.com');
    const adminMember = store.listMembers().find((member) => member.email === 'admin@example.com');
    assert.equal(adminMember.role, 'admin');
    assert.deepEqual(adminMember.sources, ['admin', 'seen']);

    // manually maintained users
    assert.equal(store.addUser(' Carol@Example.com '), 'carol@example.com');
    assert.deepEqual(JSON.parse(fs.readFileSync(usersFile, 'utf8')), ['carol@example.com']);
    assert.equal(fs.statSync(usersFile).mode & 0o777, 0o600);
    assert.throws(() => store.addUser('carol@example.com'), UserValidationError);
    assert.throws(() => store.addUser('alice@example.com'), UserValidationError, 'already in the team through a login');
    assert.throws(() => store.addUser('admin@example.com'), /bereits Admin/);
    assert.throws(() => store.addUser('nope'), admins.AdminValidationError);
    assert.equal(store.isMember('carol@example.com'), true);
    assert.equal(store.isMember('dave@example.com'), false);
    assert.equal(store.isMember('lokal'), false);
    const carol = store.listMembers().find((member) => member.email === 'carol@example.com');
    assert.deepEqual(carol.sources, ['settings']);
    assert.equal(carol.lastSeen, null);

    // removal: a seen person is dropped and not recorded again automatically; adding them back clears it
    assert.equal(store.deleteUser('alice@example.com'), 'alice@example.com');
    assert.equal(store.isMember('alice@example.com'), false);
    clock += 10 * 60 * 1000;
    assert.equal(store.touch('alice@example.com'), false);
    assert.equal(store.isMember('alice@example.com'), false, 'a removed person stays removed until an admin adds them back');
    assert.throws(() => store.deleteUser('alice@example.com'), UserNotFoundError);
    assert.equal(store.addUser('alice@example.com'), 'alice@example.com');
    assert.equal(store.isMember('alice@example.com'), true);
    // a person on both lists (settings + seen) is removed from both
    store.touch('carol@example.com');
    assert.equal(store.deleteUser('carol@example.com'), 'carol@example.com');
    assert.deepEqual(JSON.parse(fs.readFileSync(usersFile, 'utf8')), ['alice@example.com']);
    assert.equal(store.isMember('carol@example.com'), false);
    // admins are removed in the admin management, not here
    assert.throws(() => store.deleteUser('admin@example.com'), /Admin-Verwaltung/);
    assert.throws(() => store.deleteUser('nobody@example.com'), UserNotFoundError);

    // a fresh store reads the files again (restart)
    const restarted = createUsersStore({ usersFile, seenFile, now: () => clock, env: ACTIVE_ENV });
    assert.equal(restarted.isMember('alice@example.com'), true);
    assert.equal(restarted.isMember('carol@example.com'), false);
    assert.equal(restarted.touch('carol@example.com'), false, 'removal survives a restart');

    // limits and broken files
    fs.writeFileSync(usersFile, JSON.stringify(Array.from({ length: 250 }, (_, i) => `u${i}@example.com`)));
    assert.throws(() => restarted.addUser('extra@example.com'), /maximal 250/);
    fs.writeFileSync(usersFile, '{ nope');
    assert.throws(() => restarted.listMembers(), /users\.json/);
    fs.writeFileSync(usersFile, '[]');
    fs.writeFileSync(seenFile, 'not json');
    const broken = createUsersStore({ usersFile, seenFile, now: () => clock, env: ACTIVE_ENV });
    assert.doesNotThrow(() => broken.listMembers(), 'an unreadable seen file must not break the team list');
    assert.equal(broken.touch('erin@example.com'), true);
  } finally {
    admins.listStoredAdmins = originalStored;
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

function testMonitoringAggregation() {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const cost = (ts, user, type, model, amount, extra = {}) => ({ ts, sessionId: 's1', type, model, cost: amount, user, ...extra });
  const costRows = [
    cost('2026-09-30T10:00:00.000Z', 'alice@example.com', 'brain', 'anthropic/claude-opus-4.6', 0.5, { usage: { input_tokens: 100, output_tokens: 20 } }),
    cost('2026-09-30T11:00:00.000Z', 'alice@example.com', 'image', 'openai/gpt-image-2', 0.25),
    cost('2026-09-29T23:30:00.000Z', 'bob@example.com', 'video', 'bytedance/seedance-2.5', 1),
    cost('2026-09-29T09:00:00.000Z', 'bob@example.com', 'higgsfield', 'kling', 0, { billing: 'Abo' }),
    cost('2026-08-01T09:00:00.000Z', 'bob@example.com', 'fal', 'fal-ai/x', 3),
    cost('2026-09-30T09:00:00.000Z', 'lokal', 'brain', 'chatgpt/gpt-5.6-luna', 0.1)
  ];
  const runRows = [
    { workflowId: 'w1', id: 'r1', user: 'alice@example.com', status: 'completed', startedAt: '2026-09-30T10:00:00.000Z' },
    { workflowId: 'w1', id: 'r2', user: 'bob@example.com', status: 'failed', startedAt: '2026-09-30T10:05:00.000Z', error: 'boom' },
    { workflowId: 'w1', id: 'r3', user: 'bob@example.com', status: 'failed', startedAt: '2026-06-30T10:05:00.000Z', error: 'old' }
  ];
  const jobRows = [
    { sessionId: 's1', jobId: 'j1', user: 'alice@example.com', provider: 'openrouter', kind: 'video', status: 'completed', ts: '2026-09-30T10:00:00.000Z' },
    { sessionId: 's1', jobId: 'j2', user: 'alice@example.com', provider: 'fal', kind: 'video', status: 'failed', ts: '2026-09-30T10:10:00.000Z', error: 'nope' }
  ];
  const errorRows = [
    { ts: '2026-09-30T10:00:00.000Z', method: 'GET', route: '/api/sessions/:id', status: 404, code: 'HTTP_404', user: 'bob@example.com' },
    { ts: '2026-09-30T10:00:00.000Z', method: 'GET', route: '/api/settings', status: 403, code: 'HTTP_403', user: 'bob@example.com' }
  ];

  const report = monitoring.summarise({ costRows, runRows, jobRows, errorRows }, {}, now);
  assert.equal(report.filters.days, '30');
  assert.equal(report.totals.count, 5, 'the August row is outside 30 days');
  assert.ok(Math.abs(report.totals.costUsd - 1.85) < 1e-9);
  assert.equal(report.totals.subscriptionCount, 1);
  assert.equal(report.totals.inputTokens, 100);
  assert.equal(report.totals.totalTokens, 120);
  assert.deepEqual(report.byUser.map((row) => row.key), ['bob@example.com', 'alice@example.com', 'lokal']);
  assert.deepEqual(report.byProvider.map((row) => row.key).sort(), ['anthropic', 'bytedance', 'chatgpt', 'higgsfield', 'openai']);
  // days follow Zurich time: 23:30 UTC on the 29th is already the 30th there
  assert.deepEqual(report.byDay.map((row) => `${row.key}:${row.count}`), ['2026-09-30:4', '2026-09-29:1']);
  assert.equal(report.totals.runs, 2);
  assert.equal(report.totals.failedRuns, 1);
  assert.equal(report.runs.errors[0].error, 'boom');
  assert.equal(report.totals.jobs, 2);
  assert.equal(report.totals.failedJobs, 1);
  assert.equal(report.errors.total, 1);
  assert.equal(report.errors.denied, 1);
  assert.deepEqual(report.options.users, ['alice@example.com', 'bob@example.com', 'lokal']);

  const alice = monitoring.summarise({ costRows, runRows, jobRows, errorRows }, { user: 'Alice@example.com' }, now);
  assert.equal(alice.totals.count, 2);
  assert.equal(alice.totals.runs, 1);
  const fal = monitoring.summarise({ costRows, runRows, jobRows, errorRows }, { provider: 'fal', days: 'all' }, now);
  assert.equal(fal.totals.count, 1);
  assert.equal(fal.totals.jobs, 1);
  assert.equal(monitoring.summarise({ costRows, runRows, jobRows, errorRows }, { days: '7' }, now).totals.count, 5);
  assert.equal(monitoring.summarise({ costRows, runRows, jobRows, errorRows }, { days: 'all' }, now).totals.count, 6);
  for (const query of [{ days: '5' }, { days: 'x' }, { user: ['a'] }, { provider: 3 }]) {
    assert.throws(() => monitoring.summarise({ costRows }, query, now), (error) => error.code === 'INVALID_FILTER', JSON.stringify(query));
  }

  // providers
  assert.equal(monitoring.providerOf({ type: 'brain', model: 'anthropic/claude' }), 'anthropic');
  assert.equal(monitoring.providerOf({ type: 'higgsfield', model: 'x/y' }), 'higgsfield');
  assert.equal(monitoring.providerOf({ type: 'motion', model: 'hyperframes' }), 'rendernode');
  assert.equal(monitoring.providerOf({ type: 'brain', model: 'plain' }), 'brain');

  // CSV: BOM, semicolons, quoting, formula guard
  const csv = monitoring.csv([
    { ts: '2026-09-30T10:00:00.000Z', user: '=cmd|"x"', provider: 'openai', model: 'a;b', type: 'image', sessionId: 's', assetId: '', billing: '', costUsd: 0.25, tokens: { input: null, output: null, total: null } }
  ]);
  assert.ok(csv.startsWith('\ufeff"timestamp_utc";"day_zurich";"user"'));
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes(`"'=cmd|""x"""`), line);
  assert.ok(line.includes('"a;b"'));
  assert.ok(line.startsWith('"2026-09-30T10:00:00.000Z";"2026-09-30"'));
}

async function testErrorJournal() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-monitor-'));
  const file = path.join(directory, 'errors.json');
  let clock = Date.parse('2026-09-30T12:00:00.000Z');
  try {
    const monitor = monitoring.createMonitor({ file, now: () => clock });
    const listeners = {};
    const res = { statusCode: 404, once: (event, fn) => { listeners[event] = fn; }, writableFinished: true };
    const req = { path: '/api/sessions/abc', method: 'GET', route: { path: '/api/sessions/:id' }, kubleUser: 'bob@example.com', url: '/api/sessions/abc?token=secret' };
    monitor.middleware(req, res, () => {});
    listeners.finish();
    await monitor.flush();
    const rows = await monitor.readErrors();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route, '/api/sessions/:id', 'route template, never the concrete URL');
    assert.equal(rows[0].user, 'bob@example.com');
    assert.ok(!JSON.stringify(rows).includes('secret'));
    // successes and monitoring requests are not recorded
    const ok = { statusCode: 200, once: (event, fn) => { listeners[event] = fn; }, writableFinished: true };
    monitor.middleware({ ...req, path: '/api/sessions' }, ok, () => {});
    listeners.finish();
    monitor.middleware({ ...req, path: '/api/admin/monitoring' }, res, () => {});
    await monitor.flush();
    assert.equal((await monitor.readErrors()).length, 1);
    // retention of 30 days
    clock += 31 * 86400000;
    assert.equal((await monitor.readErrors()).length, 0);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

// Failing requests (also from anonymous callers) must neither grow a queue without bound nor rewrite the journal per request.
async function testErrorJournalFlood() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-monitor-flood-'));
  const file = path.join(directory, 'errors.json');
  const clock = Date.parse('2026-09-30T12:00:00.000Z');
  try {
    const monitor = monitoring.createMonitor({ file, now: () => clock, flushMs: 40 });
    const fail = (user, i) => {
      const listeners = {};
      const res = { statusCode: 404, once: (event, fn) => { listeners[event] = fn; }, writableFinished: true };
      monitor.middleware({ path: `/api/sessions/${i}`, method: 'GET', route: { path: '/api/sessions/:id' }, kubleUser: user }, res, () => {});
      listeners.finish();
    };
    // a flood from one caller: buffered, bounded, the rest only counted
    for (let i = 0; i < 2000; i += 1) fail(undefined, i);
    assert.equal(fs.existsSync(file), false, 'nothing is written per request');
    assert.equal((await monitor.readErrors()).length, 50, 'the buffer keeps at most 50 entries per person and window');
    assert.equal(monitor.runtime().droppedErrors, 1950);
    assert.equal(monitor.runtime().failedRequests, 2000, 'all failures are still counted');
    // other people are not crowded out by the flood
    fail('bob@example.com', 1);
    await sleep(200); // the timer flushes on its own
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rows.length, 51);
    assert.equal(rows.filter((row) => row.user === 'bob@example.com').length, 1);
    // the journal stays capped over many windows
    for (let round = 0; round < 25; round += 1) {
      for (let i = 0; i < 50; i += 1) fail(`user${round % 5}@example.com`, i);
      await monitor.flush();
    }
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).length <= 1000);
    assert.equal(fs.readdirSync(directory).length, 1, 'no temporary files are left behind');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  testMode();
  testIdentity();
  testRules();
  testBuildSharing();
  await testUsersStore();
  testMonitoringAggregation();
  await testErrorJournal();
  await testErrorJournalFlood();
  console.log('Access: Modus, Identitaet, Rollen, Zugriffsregeln (Bestand, anonym, Admin, team/specific), Team-Liste mit Auto-Erfassung und Monitoring-Aggregation sind korrekt.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
