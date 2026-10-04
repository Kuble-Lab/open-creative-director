'use strict';

// Building blocks of the teams (WP15): the teams file (lib/teams.js), the roles participant / internal / guest and their
// access rules (lib/access.js), the USD budget with its incremental cost index and reservations (lib/budget.js) and the
// optional allowlist sync (lib/access-sync.js). No server and no network; every file lives in a temp directory.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const access = require('../lib/access');
const budgetLib = require('../lib/budget');
const { createTeamsStore, TeamValidationError, TeamNotFoundError, MemberNotFoundError, LIMITS } = require('../lib/teams');
const { createAccessSync } = require('../lib/access-sync');

const ACTIVE_ENV = { AUTH_WHOAMI_URL: 'https://whoami.invalid/me', ADMIN_EMAILS: 'admin@example.com', INTERNAL_EMAIL_DOMAINS: 'staff.example.com' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `ocd-${prefix}-`));
}

// A clock the tests move by hand.
function clock(start = Date.parse('2026-10-01T09:00:00Z')) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
    return current;
  };
  return now;
}

/* ---------- the teams file ---------- */

async function testTeamsStore() {
  const dir = await tempDir('teams');
  const file = path.join(dir, 'data', 'teams.json');
  const now = clock();
  const store = createTeamsStore({ file, now });
  try {
    assert.deepEqual(store.listTeams(), [], 'no file, no teams');
    assert.equal(fs.existsSync(file), false, 'reading creates nothing');
    assert.deepEqual(store.membershipsOf('a@example.com'), []);

    // create: validation
    for (const bad of [{}, { name: '' }, { name: '   ' }, { name: 3 }, { name: 'x'.repeat(LIMITS.maxNameLength + 1) }]) {
      assert.throws(() => store.createTeam({ ...bad, budgetUsd: 5 }), TeamValidationError, JSON.stringify(bad).slice(0, 40));
    }
    for (const bad of [-1, NaN, Infinity, LIMITS.maxBudgetUsd + 1, 'viel', {}, [], true]) {
      assert.throws(() => store.createTeam({ name: 'X', budgetUsd: bad }), (error) => error.code === 'INVALID_BUDGET', String(bad));
    }
    assert.throws(() => store.createTeam({ name: 'X', budgetUsd: 5, description: 'x'.repeat(LIMITS.maxDescriptionLength + 1) }), TeamValidationError);
    assert.equal(fs.existsSync(file), false, 'nothing was written for invalid input');

    const team = store.createTeam({ name: '  Kurs   Herbst  ', description: 'Zwei Tage', budgetUsd: '12.345', createdBy: 'Admin@Example.com' });
    assert.match(team.id, /^tm-[0-9a-f]{12}$/);
    assert.equal(team.name, 'Kurs Herbst', 'whitespace is tidied');
    assert.equal(team.budgetUsd, 12.35, 'USD are kept to whole cents');
    assert.equal(team.createdBy, 'admin@example.com');
    assert.equal(team.archived, false);
    assert.deepEqual(team.members, []);
    assert.equal(store.createTeam({ name: 'Gratis', budgetUsd: 0 }).budgetUsd, 0, '0 is a valid amount');
    assert.throws(() => store.createTeam({ name: 'kurs herbst', budgetUsd: 1 }), (error) => error.code === 'TEAM_NAME_TAKEN');

    // the file: chmod 600, JSON, atomic (no temporary files left)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.teams.length, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name !== 'teams.json'), []);

    // members: a paste in one go
    const paste = 'Anna <ANNA@example.com>\nben@example.org; cleo@example.net\nanna@example.com\nkaputt@\nbem@example.org (Bem)';
    const result = store.addMembers(team.id, [paste]);
    assert.deepEqual(result.added, ['anna@example.com', 'ben@example.org', 'cleo@example.net', 'bem@example.org']);
    assert.deepEqual(result.already, []);
    assert.deepEqual(result.invalid, ['kaputt@']);
    assert.equal(result.duplicates, 1);
    const again = store.addMembers(team.id, ['anna@example.com', 'dan@example.com']);
    assert.deepEqual(again.added, ['dan@example.com']);
    assert.deepEqual(again.already, ['anna@example.com']);
    const member = store.getTeam(team.id).members.find((entry) => entry.email === 'anna@example.com');
    assert.equal(member.addedAt, '2026-10-01T09:00:00.000Z');
    assert.equal(member.budgetStart, member.addedAt, 'the budget counts from the day somebody joins');
    assert.equal(member.budgetOverrideUsd, null);
    // nothing new: the file is not touched
    const mtime = fs.statSync(file).mtimeMs;
    now.advance(5000);
    assert.deepEqual(store.addMembers(team.id, ['anna@example.com']).added, []);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    // errors
    assert.throws(() => store.addMembers(team.id, []), (error) => error.code === 'NO_EMAILS');
    assert.throws(() => store.addMembers(team.id, ['   ']), (error) => error.code === 'NO_EMAILS');
    assert.throws(() => store.addMembers(team.id, [3]), (error) => error.code === 'INVALID_EMAILS');
    assert.throws(() => store.addMembers(team.id, null), (error) => error.code === 'INVALID_EMAILS');
    assert.throws(() => store.addMembers('tm-unbekannt', ['x@example.com']), TeamNotFoundError);
    const many = Array.from({ length: LIMITS.maxBulk + 1 }, (_, i) => `p${i}@example.com`);
    assert.throws(() => store.addMembers(team.id, many), (error) => error.code === 'TOO_MANY_EMAILS');
    assert.equal(store.addMembers(team.id, many.slice(0, LIMITS.maxBulk)).added.length, LIMITS.maxBulk, '500 in one request');
    assert.equal(store.getTeam(team.id).members.length, 5 + LIMITS.maxBulk);

    // memberships of active teams; the same person in two teams
    const second = store.createTeam({ name: 'Zweiter Kurs', budgetUsd: 30 });
    store.addMembers(second.id, ['anna@example.com']);
    const memberships = store.membershipsOf('  ANNA@example.com ');
    assert.deepEqual(memberships.map((entry) => entry.teamId).sort(), [team.id, second.id].sort());
    assert.deepEqual(store.activeTeamIdsOf('bem@example.org'), [team.id]);
    assert.deepEqual(store.membershipsOf('nobody@example.com'), []);
    assert.deepEqual(store.membershipsOf('lokal'), []);
    assert.ok(store.teammatesOf('anna@example.com').includes('ben@example.org') && store.teammatesOf('anna@example.com').length === 5 + LIMITS.maxBulk);
    assert.deepEqual(store.teammatesOf('nobody@example.com'), []);

    // override and reset
    const start = store.getTeam(team.id).members.find((entry) => entry.email === 'ben@example.org').budgetStart;
    now.advance(3600 * 1000);
    let changed = store.updateMember(team.id, 'BEN@example.org', { budgetOverrideUsd: 25 });
    assert.equal(changed.budgetOverrideUsd, 25);
    assert.equal(changed.budgetStart, start, 'an override does not restart the count');
    changed = store.updateMember(team.id, 'ben@example.org', { resetBudget: true });
    assert.equal(changed.budgetStart, '2026-10-01T10:00:05.000Z', 'reset = the count starts now');
    assert.equal(changed.budgetOverrideUsd, 25, 'reset keeps the override');
    assert.equal(store.updateMember(team.id, 'ben@example.org', { budgetOverrideUsd: null }).budgetOverrideUsd, null);
    for (const bad of [{}, { budgetOverrideUsd: -3 }, { budgetOverrideUsd: 'x' }, { resetBudget: false }, { budgetOverrideUsd: LIMITS.maxBudgetUsd + 1 }]) {
      assert.throws(() => store.updateMember(team.id, 'ben@example.org', bad), TeamValidationError, JSON.stringify(bad));
    }
    assert.throws(() => store.updateMember(team.id, 'fremd@example.com', { resetBudget: true }), MemberNotFoundError);
    assert.throws(() => store.updateMember(team.id, 'lokal', { resetBudget: true }), MemberNotFoundError);
    assert.throws(() => store.updateMember('tm-unbekannt', 'ben@example.org', { resetBudget: true }), TeamNotFoundError);

    // remove
    assert.equal(store.removeMember(team.id, 'BEM@example.org'), 'bem@example.org');
    assert.deepEqual(store.membershipsOf('bem@example.org'), [], 'removed from the only team: no participant any more, at once');
    assert.throws(() => store.removeMember(team.id, 'bem@example.org'), MemberNotFoundError);

    // update team
    assert.equal(store.updateTeam(team.id, { budgetUsd: 20 }).budgetUsd, 20);
    assert.equal(store.updateTeam(team.id, { name: 'Kurs Herbst 2026', description: '' }).name, 'Kurs Herbst 2026');
    assert.throws(() => store.updateTeam(team.id, {}), TeamValidationError);
    assert.throws(() => store.updateTeam(team.id, { archived: 'ja' }), TeamValidationError);
    assert.throws(() => store.updateTeam(team.id, { name: 'Zweiter Kurs' }), (error) => error.code === 'TEAM_NAME_TAKEN');
    assert.throws(() => store.updateTeam('tm-unbekannt', { name: 'x' }), TeamNotFoundError);
    assert.equal(store.membershipsOf('ben@example.org')[0].budgetUsd, 20, 'a new team amount applies to everybody');

    // archive: no participants any more, members stay listed; unarchive brings them back
    store.updateTeam(team.id, { archived: true });
    assert.deepEqual(store.activeTeamIdsOf('ben@example.org'), []);
    assert.deepEqual(store.activeTeamIdsOf('anna@example.com'), [second.id]);
    assert.equal(store.listTeams().find((entry) => entry.id === team.id).members.length, 4 + LIMITS.maxBulk);
    assert.equal(store.listTeams({ includeArchived: false }).length, 2);
    assert.equal(store.isActiveTeam(team.id), false);
    assert.equal(store.isActiveTeam(second.id), true);
    assert.deepEqual(store.activeTeams().map((entry) => entry.name), ['Gratis', 'Zweiter Kurs']);
    assert.ok(!store.activeMemberEmails().includes('ben@example.org'));
    store.updateTeam(team.id, { archived: false });
    assert.deepEqual(store.activeTeamIdsOf('ben@example.org'), [team.id]);

    // delete
    assert.equal(store.deleteTeam(second.id), second.id);
    assert.throws(() => store.deleteTeam(second.id), TeamNotFoundError);
    assert.throws(() => store.getTeam(second.id), TeamNotFoundError);
    assert.deepEqual(store.activeTeamIdsOf('anna@example.com'), [team.id]);
    assert.equal(store.teamName(team.id), 'Kurs Herbst 2026');
    assert.equal(store.teamName('tm-weg'), null);

    // listeners
    let calls = 0;
    const off = store.onChange(() => { calls += 1; });
    store.updateTeam(team.id, { description: 'neu' });
    assert.equal(calls, 1);
    off();
    store.updateTeam(team.id, { description: 'nochmal' });
    assert.equal(calls, 1);

    // returned data is a copy
    store.getTeam(team.id).members.length = 0;
    assert.ok(store.getTeam(team.id).members.length > 0);

    // a second store on the same file sees the change once its cache is due (a file edited by hand)
    const other = createTeamsStore({ file, now, checkIntervalMs: 0 });
    assert.equal(other.getTeam(team.id).description, 'nochmal');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.teams.find((entry) => entry.id === team.id).members.push({ email: 'Hand@Example.com', addedAt: '2026-09-01T00:00:00Z' });
    fs.writeFileSync(file, JSON.stringify(edited));
    assert.deepEqual(other.activeTeamIdsOf('hand@example.com'), [team.id]);
    assert.equal(other.getTeam(team.id).members.find((entry) => entry.email === 'hand@example.com').budgetStart, '2026-09-01T00:00:00.000Z');
    now.advance(3000);
    assert.deepEqual(store.activeTeamIdsOf('hand@example.com'), [team.id], 'the first store notices after its check interval');

    // hand-edited junk is tolerated
    fs.writeFileSync(file, JSON.stringify({ teams: [{ id: 'tm-x', name: 3, budgetUsd: 'viel', members: ['Dora@Example.com', 7, { email: 'nope' }, { email: 'dora@example.com' }] }, { nope: true }, 'text'] }));
    now.advance(3000);
    const tolerant = store.getTeam('tm-x');
    assert.equal(tolerant.name, 'tm-x');
    assert.equal(tolerant.budgetUsd, 0);
    assert.deepEqual(tolerant.members.map((entry) => entry.email), ['dora@example.com']);

    // a corrupt file: reading keeps the last good state, writing refuses and leaves the file alone
    fs.writeFileSync(file, '{ kaputt');
    now.advance(3000);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(store.activeTeamIdsOf('dora@example.com'), ['tm-x'], 'the last good state is kept');
      assert.ok(store.problem());
      assert.throws(() => store.createTeam({ name: 'Neu', budgetUsd: 1 }), /nicht überschrieben/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{ kaputt', 'the broken file is not overwritten');
      const fresh = createTeamsStore({ file, now });
      assert.deepEqual(fresh.listTeams(), [], 'without a good state there are no teams');
    } finally {
      console.warn = warn;
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- roles and access rules ---------- */

async function testRoles() {
  const dir = await tempDir('roles');
  const store = createTeamsStore({ file: path.join(dir, 'teams.json') });
  access.useTeamsStore(store);
  try {
    const t1 = store.createTeam({ name: 'Kurs A', budgetUsd: 10 });
    const t2 = store.createTeam({ name: 'Kurs B', budgetUsd: 20 });
    store.addMembers(t1.id, ['p1@gmail.example', 'p2@gmail.example', 'trainer-test@staff.example.com']);
    store.addMembers(t2.id, ['p3@gmail.example', 'p1@gmail.example']);
    const view = (email, env = ACTIVE_ENV) => access.viewerOf({ kubleUser: email }, env);

    // roles
    const p1 = view('P1@gmail.example');
    assert.equal(p1.kind, 'participant');
    assert.deepEqual([...p1.teamIds].sort(), [t1.id, t2.id].sort());
    assert.equal(access.roleOf(p1), 'participant');
    assert.equal(access.isParticipant(p1), true);
    assert.equal(access.isRestricted(p1), true);
    assert.equal(view('staff@staff.example.com').kind, 'internal');
    assert.equal(access.roleOf(view('staff@staff.example.com')), 'user', 'internal people keep the role they always had');
    assert.equal(view('alumni@gmail.example').kind, 'guest');
    assert.equal(access.roleOf(view('alumni@gmail.example')), 'guest');
    assert.equal(access.isGuest(view('alumni@gmail.example')), true);
    assert.equal(view('trainer-test@staff.example.com').kind, 'participant', 'team membership wins over the domain: an internal address in a team is a participant');
    assert.equal(view('admin@example.com').kind, 'admin');
    assert.equal(access.isRestricted(view('admin@example.com')), false);
    assert.equal(access.isRestricted(view('lokal')), false, 'anonymous is neither');
    assert.equal(view('lokal').kind, undefined);
    assert.deepEqual({ ...view('lokal') }, { active: true, email: null, identified: false, superadmin: false, admin: false }, 'the anonymous viewer keeps its shape');
    assert.equal(access.isRestricted(access.viewerOf({ kubleUser: 'p1@gmail.example' }, {})), false, 'the local mode has no roles');
    // an admin in a team stays an admin (no budget, sees everything)
    store.addMembers(t1.id, ['admin@example.com']);
    assert.equal(view('admin@example.com').kind, 'admin');
    // without INTERNAL_EMAIL_DOMAINS everybody identified without a team is internal (the behaviour before teams)
    const open = { AUTH_WHOAMI_URL: ACTIVE_ENV.AUTH_WHOAMI_URL };
    assert.equal(view('alumni@gmail.example', open).kind, 'internal');
    assert.equal(view('p1@gmail.example', open).kind, 'participant');
 // back in a team: participant again
    assert.equal(view('p2@gmail.example', open).kind, 'participant');
    store.removeMember(t1.id, 'p2@gmail.example');
    // a teams file that never was readable: nobody can be told from a former participant (fail closed)
    const broken = path.join(dir, 'broken-teams.json');
    await fsp.writeFile(broken, '{ kaputt');
    const brokenStore = createTeamsStore({ file: broken });
    const warn = console.warn;
    console.warn = () => {};
    try {
      access.useTeamsStore(brokenStore);
      assert.equal(brokenStore.unreadable(), true);
      assert.equal(view('alumni@gmail.example', open).kind, 'guest');
      assert.equal(view('staff@staff.example.com').kind, 'internal', 'with a domain list the domain still decides');
      assert.equal(view('admin@example.com', { ...open, ADMIN_EMAILS: 'admin@example.com' }).kind, 'admin', 'admins are not affected');
    } finally {
      console.warn = warn;
      access.useTeamsStore(store);
    }
    store.addMembers(t1.id, ['p2@gmail.example']);
    assert.deepEqual(access.internalDomains({ INTERNAL_EMAIL_DOMAINS: ' @Staff.Example.com ,, example.org,staff.example.com, bad domain ' }), ['staff.example.com', 'example.org']);
    assert.equal(access.isInternalEmail('x@staff.example.com', ACTIVE_ENV), true);
    assert.equal(access.isInternalEmail('x@sub.staff.example.com', ACTIVE_ENV), false, 'the domain must match exactly');
    assert.equal(access.isInternalEmail('x@gmail.example', ACTIVE_ENV), false);
    assert.equal(access.isInternalEmail('lokal', ACTIVE_ENV), false);

    // a person removed from all teams loses the participant role with the next request
    store.removeMember(t2.id, 'p3@gmail.example');
    assert.equal(view('p3@gmail.example').kind, 'guest');
    store.removeMember(t1.id, 'p1@gmail.example');
    assert.equal(view('p1@gmail.example').kind, 'participant', 'still in Kurs B');
    store.updateTeam(t2.id, { archived: true });
    assert.equal(view('p1@gmail.example').kind, 'guest', 'an archived team does not count');
    store.updateTeam(t2.id, { archived: false });
    store.addMembers(t1.id, ['p1@gmail.example']);

    // the rules
    const p2 = view('p2@gmail.example'); // Kurs A
    const p3 = view('p3@gmail.example'); // no team (removed above)
    store.addMembers(t2.id, ['p3@gmail.example']);
    const p3b = view('p3@gmail.example'); // Kurs B
    const internal = view('staff@staff.example.com');
    const guest = view('alumni@gmail.example');
    const admin = view('admin@example.com');
    const anonymous = view('lokal');
    const entry = (extra) => ({ owner: 'boss@staff.example.com', shareMode: 'private', sharedWith: [], ...extra });
    const cases = [
      // [label, entry, participant of Kurs A, participant of Kurs B, internal, guest, anonymous]
      ['existing data (no owner)', {}, false, false, true, false, true],
      ['existing data with owner null', { owner: null, shareMode: 'team' }, false, false, true, false, true],
      ['private of somebody else', entry(), false, false, false, false, false],
      ['team = all internal', entry({ shareMode: 'team' }), false, false, true, false, false],
      ['teams with Kurs A', entry({ shareMode: 'teams', sharedTeams: [t1.id] }), true, false, false, false, false],
      ['teams with Kurs A and B', entry({ shareMode: 'teams', sharedTeams: [t1.id, t2.id] }), true, true, false, false, false],
      ['teams with an unknown team', entry({ shareMode: 'teams', sharedTeams: ['tm-unbekannt'] }), false, false, false, false, false],
      ['teams with no team', entry({ shareMode: 'teams', sharedTeams: [] }), false, false, false, false, false],
      ['specific p2', entry({ shareMode: 'specific', sharedWith: ['p2@gmail.example'] }), true, false, false, false, false],
      ['specific alumni', entry({ shareMode: 'specific', sharedWith: ['alumni@gmail.example'] }), false, false, false, true, false],
      ['specific staff', entry({ shareMode: 'specific', sharedWith: ['staff@staff.example.com'] }), false, false, true, false, false],
      ['own private', entry({ owner: 'p2@gmail.example' }), true, false, false, false, false],
      ['own teams entry stays own after leaving the team', entry({ owner: 'alumni@gmail.example', shareMode: 'teams', sharedTeams: [t1.id] }), true, false, false, true, false]
    ];
    for (const [label, data, forA, forB, forInternal, forGuest, forAnonymous] of cases) {
      assert.equal(access.canUse(data, p2), forA, `${label}: participant Kurs A`);
      assert.equal(access.canUse(data, p3b), forB, `${label}: participant Kurs B`);
      assert.equal(access.canUse(data, internal), forInternal, `${label}: internal`);
      assert.equal(access.canUse(data, guest), forGuest, `${label}: guest`);
      assert.equal(access.canUse(data, anonymous), forAnonymous, `${label}: anonymous`);
      assert.equal(access.canUse(data, admin), true, `${label}: admin`);
    }
    // ... and the owner of a teams entry is the owner even after leaving all teams (p3 is a guest again)
    store.removeMember(t2.id, 'p3@gmail.example');
    assert.equal(access.canUse(entry({ owner: 'p3@gmail.example' }), view('p3@gmail.example')), true);
    assert.equal(access.canUse(entry({ shareMode: 'teams', sharedTeams: [t2.id] }), view('p3@gmail.example')), false, 'no longer in the team: no access through it');
    store.addMembers(t2.id, ['p3@gmail.example']);
    void p3;

    // manage / share
    assert.equal(access.canManage({}, p2), false, 'participants cannot touch existing data');
    assert.equal(access.canManage({}, guest), false);
    assert.equal(access.canManage({}, internal), true, 'internal people manage existing data as before');
    assert.equal(access.canManage(entry({ owner: 'p2@gmail.example' }), p2), true);
    assert.equal(access.canManage(entry({ shareMode: 'teams', sharedTeams: [t1.id] }), p2), false, 'shared with the team is not ownership');
    assert.equal(access.canShare(entry({ owner: 'p2@gmail.example' }), p2), true);
    assert.equal(access.canShare(entry({ shareMode: 'teams', sharedTeams: [t1.id] }), p2), false);
    assert.equal(access.canShare({}, p2), false);

    // sharing fields: the new field exists only for the new mode
    assert.deepEqual(access.sharingOf({ owner: 'a@b.co', shareMode: 'teams', sharedTeams: ['tm-1', 'tm-1', 'bad id', 3, 'tm_2'] }), { owner: 'a@b.co', shareMode: 'teams', sharedWith: [], sharedTeams: ['tm-1', 'tm_2'] });
    assert.deepEqual(access.sharingOf({ owner: 'a@b.co', shareMode: 'private', sharedTeams: ['tm-1'] }), { owner: 'a@b.co', shareMode: 'private', sharedWith: [] });
    const normalised = access.normaliseSharing({ owner: 'a@b.co', shareMode: 'team', sharedTeams: ['tm-1'] });
    assert.equal('sharedTeams' in normalised, false, 'leaving the teams mode drops the list');
    assert.equal(access.sharingOf({ owner: 'a@b.co', shareMode: 'teams', sharedTeams: many(30, 'tm-') }).sharedTeams.length, access.MAX_SHARED_TEAMS);

    // what a caller may pick when sharing
    const internalPolicy = access.sharingPolicy(internal, { isKnownMember: (email) => email === 'anna@staff.example.com' });
    assert.deepEqual(internalPolicy.allowedModes, ['private', 'team', 'teams', 'specific']);
    assert.equal(internalPolicy.isKnownMember('anna@staff.example.com'), true);
    assert.equal(internalPolicy.isKnownTeam(t1.id), true);
    assert.equal(internalPolicy.isKnownTeam('tm-unbekannt'), false);
    const participantPolicy = access.sharingPolicy(p2, { isKnownMember: () => true });
    assert.deepEqual(participantPolicy.allowedModes, ['private', 'teams', 'specific']);
    assert.equal(participantPolicy.isKnownMember('p1@gmail.example'), true, 'a teammate');
    assert.equal(participantPolicy.isKnownMember('p3@gmail.example'), false, 'somebody from another team');
    assert.equal(participantPolicy.isKnownMember('staff@staff.example.com'), false, 'an internal person');
    assert.equal(participantPolicy.isKnownTeam(t1.id), true);
    assert.equal(participantPolicy.isKnownTeam(t2.id), false);
    assert.deepEqual(access.sharingPolicy(guest).allowedModes, ['private']);

    const build = (body, policy, current = {}) => access.buildSharing(body, current, policy.isKnownMember, policy);
    assert.deepEqual(build({ shareMode: 'teams', sharedTeams: [t1.id, t1.id] }, participantPolicy), { shareMode: 'teams', sharedWith: [], sharedTeams: [t1.id] });
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: [t2.id] }, participantPolicy), (error) => error.code === 'UNKNOWN_TEAMS');
    assert.deepEqual(build({ shareMode: 'teams', sharedTeams: [t2.id] }, participantPolicy, { sharedTeams: [t2.id] }).sharedTeams, [t2.id], 'a team that is already shared with stays valid');
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: [] }, participantPolicy), /at least one team/);
    assert.throws(() => build({ shareMode: 'teams' }, participantPolicy), /list of team ids/);
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: ['bad id'] }, participantPolicy), /invalid team ids/);
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: many(21, 'tm-') }, internalPolicy), /At most 20/);
    assert.throws(() => build({ shareMode: 'team' }, participantPolicy), (error) => error.code === 'SHARE_MODE_FORBIDDEN', 'participants cannot share with all internal people');
    assert.throws(() => build({ shareMode: 'team' }, access.sharingPolicy(guest)), (error) => error.code === 'SHARE_MODE_FORBIDDEN');
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: [t1.id] }, access.sharingPolicy(guest)), (error) => error.code === 'SHARE_MODE_FORBIDDEN');
    assert.deepEqual(build({ shareMode: 'private' }, access.sharingPolicy(guest)), { shareMode: 'private', sharedWith: [] });
    assert.deepEqual(build({ shareMode: 'specific', sharedWith: ['p1@gmail.example'] }, participantPolicy).sharedWith, ['p1@gmail.example']);
    assert.throws(() => build({ shareMode: 'specific', sharedWith: ['staff@staff.example.com'] }, participantPolicy), (error) => error.code === 'UNKNOWN_TEAM_MEMBERS');
    assert.deepEqual(build({ shareMode: 'team' }, internalPolicy), { shareMode: 'team', sharedWith: [] });
    assert.deepEqual(build({ shareMode: 'teams', sharedTeams: [t2.id] }, internalPolicy).sharedTeams, [t2.id]);
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: ['tm-unbekannt'] }, internalPolicy), (error) => error.code === 'UNKNOWN_TEAMS');
    // archived teams cannot be picked any more
    store.updateTeam(t2.id, { archived: true });
    assert.throws(() => build({ shareMode: 'teams', sharedTeams: [t2.id] }, access.sharingPolicy(internal)), (error) => error.code === 'UNKNOWN_TEAMS');
    store.updateTeam(t2.id, { archived: false });
    // the old shape of the result is unchanged
    assert.deepEqual(access.buildSharing({ shareMode: 'team' }, {}, () => true), { shareMode: 'team', sharedWith: [] });
    assert.throws(() => access.buildSharing({ shareMode: 'public' }, {}, () => true), /shareMode/);

    // describe: team names for those who may see them
    const shared = entry({ owner: 'p2@gmail.example', shareMode: 'teams', sharedTeams: [t1.id, t2.id] });
    const forOwner = access.describe(shared, p2);
    assert.deepEqual(forOwner.sharedTeams.map((team) => team.name).sort(), ['Kurs A', 'Kurs B']);
    assert.equal(forOwner.sharedTeamCount, 2);
    assert.deepEqual(access.describe(shared, p3b).sharedTeams.map((team) => team.name), ['Kurs B'], 'a teammate only sees their own team');
    assert.equal(access.describe(shared, p3b).sharedTeamCount, 2);
    assert.equal(access.describe(shared, admin).sharedTeams.length, 2);
    assert.equal('sharedTeams' in access.describe(entry({ shareMode: 'team' }), internal), false);

    // modelAllowed
    assert.equal(access.modelAllowed(p2, 'chatgpt/gpt-5.6-sol'), false);
    assert.equal(access.modelAllowed(guest, 'chatgpt/gpt-5.6-luna'), false);
    assert.equal(access.modelAllowed(p2, 'anthropic/claude-opus-4.6'), true);
    assert.equal(access.modelAllowed(internal, 'chatgpt/gpt-5.6-sol'), true);
    assert.equal(access.modelAllowed(admin, 'chatgpt/gpt-5.6-sol'), true);
  } finally {
    access.useTeamsStore(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function testFailClosed() {
  const dir = await tempDir('failclosed');
  const store = createTeamsStore({ file: path.join(dir, 'teams.json') });
  access.useTeamsStore(store);
  try {
    const t1 = store.createTeam({ name: 'Kurs A', budgetUsd: 10 });
    const t2 = store.createTeam({ name: 'Kurs B', budgetUsd: 20 });
    store.addMembers(t1.id, ['p1@gmail.example', 'p2@gmail.example']);
    store.addMembers(t2.id, ['p3@gmail.example']);
    const view = (email, env = ACTIVE_ENV) => access.viewerOf({ kubleUser: email }, env);
    const open = { AUTH_WHOAMI_URL: ACTIVE_ENV.AUTH_WHOAMI_URL };
    assert.equal(view('alumni@gmail.example', open).kind, 'internal', 'unknown to the teams: internal as before');
    assert.equal(view('p1@gmail.example', open).kind, 'participant');
    // ... except people the teams know: without a domain list a former participant cannot be told from a colleague
    store.updateTeam(t2.id, { archived: true });
    assert.equal(view('p3@gmail.example', open).kind, 'guest', 'only in an archived team: not a participant, and not internal either');
    assert.equal(view('p3@gmail.example').kind, 'guest');
    store.removeMember(t1.id, 'p2@gmail.example');
    assert.equal(view('p2@gmail.example', open).kind, 'guest', 'removed from the team: a guest, not an internal person');
    store.deleteTeam(t2.id);
    assert.equal(view('p3@gmail.example', open).kind, 'guest', 'the deleted team is not forgotten');
    assert.equal(store.isKnown('P3@gmail.example'), true);
    assert.equal(store.isKnown('alumni@gmail.example'), false);
    assert.equal(access.isInternalPerson('alumni@gmail.example', open), true);
    assert.equal(access.isInternalPerson('p2@gmail.example', open), false);
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).known.includes('p3@gmail.example'), true, 'remembered in the file');
    // a fresh store (restart) still knows them
    access.useTeamsStore(createTeamsStore({ file: store.file }));
    assert.equal(view('p2@gmail.example', open).kind, 'guest');
    access.useTeamsStore(store);
    // with a domain list the domain decides
    assert.equal(view('p2@gmail.example').kind, 'guest');
    assert.equal(view('p2@staff.example.com').kind, 'internal');
    store.addMembers(t1.id, ['p2@gmail.example']); // back in a team: participant again
    assert.equal(view('p2@gmail.example', open).kind, 'participant');

    // a teams file that never was readable: nobody can be told from a former participant (fail closed)
    const broken = path.join(dir, 'broken-teams.json');
    await fsp.writeFile(broken, '{ kaputt');
    const brokenStore = createTeamsStore({ file: broken });
    const warn = console.warn;
    console.warn = () => {};
    try {
      access.useTeamsStore(brokenStore);
      assert.equal(brokenStore.unreadable(), true);
      assert.equal(view('alumni@gmail.example', open).kind, 'guest');
      assert.equal(view('staff@staff.example.com').kind, 'internal', 'with a domain list the domain still decides');
      assert.equal(view('admin@example.com', { ...open, ADMIN_EMAILS: 'admin@example.com' }).kind, 'admin', 'admins are not affected');
      // a store that fails altogether closes as well
      access.useTeamsStore({ membershipsOf() { throw new Error('boom'); }, isKnown() { throw new Error('boom'); }, unreadable() { throw new Error('boom'); } });
      assert.equal(view('alumni@gmail.example', open).kind, 'guest');
    } finally {
      console.warn = warn;
      access.useTeamsStore(null);
    }
  } finally {
    access.useTeamsStore(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function many(n, prefix) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/* ---------- cost index ---------- */

const costLine = (user, cost, ts, extra = {}) => `${JSON.stringify({ ts, sessionId: 's', type: 'brain', model: 'm', cost, user, ...extra })}\n`;

async function testCostIndex() {
  const dir = await tempDir('index');
  const file = path.join(dir, 'costs.jsonl');
  try {
    const index = budgetLib.createCostIndex({ file });
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 0, 'no file, no costs');

    await fsp.writeFile(file, costLine('A@Example.com', 1.5, '2026-10-01T10:00:00Z') + costLine('b@example.com', 2, '2026-10-01T10:00:00Z') + 'kaputte zeile\n' + costLine('a@example.com', 0.25, '2026-10-02T10:00:00Z'));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 1.75, 'addresses are compared in lower case; broken lines are skipped');
    assert.equal(index.spent(' A@EXAMPLE.com '), 1.75);
    assert.equal(index.spent('b@example.com'), 2);
    assert.equal(index.spent('a@example.com', Date.parse('2026-10-02T00:00:00Z')), 0.25, 'only from the given moment on');
    assert.equal(index.spent('a@example.com', Date.parse('2026-10-02T10:00:00Z')), 0.25, 'the start itself counts');
    assert.equal(index.spent('nobody@example.com'), 0);
    const firstOffset = index.offset;
    assert.equal(firstOffset, fs.statSync(file).size);

    // only the appended bytes are read
    await fsp.appendFile(file, costLine('a@example.com', 1, '2026-10-03T10:00:00Z'));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 2.75);
    assert.equal(index.offset, fs.statSync(file).size);
    assert.equal(index.rows, 4);

    // an unfinished line waits for its newline
    const partial = costLine('a@example.com', 4, '2026-10-04T10:00:00Z');
    await fsp.appendFile(file, partial.slice(0, 30));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 2.75);
    await fsp.appendFile(file, partial.slice(30));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 6.75);

    // rows without user / cost / date are ignored, a negative or non-numeric cost is not counted
    await fsp.appendFile(file, [{ cost: 1 }, { user: 'a@example.com', ts: 'x', cost: 1 }, { user: 'a@example.com', ts: '2026-10-05T10:00:00Z', cost: -1 }, { user: 'a@example.com', ts: '2026-10-05T10:00:00Z', cost: 'viel' }].map((row) => `${JSON.stringify(row)}\n`).join(''));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 6.75);

    // a rewritten file (backfill) or a shorter one is read from the start
    await fsp.writeFile(file, costLine('c@example.com', 9, '2026-10-06T10:00:00Z'));
    await index.refresh();
    assert.equal(index.spent('a@example.com'), 0);
    assert.equal(index.spent('c@example.com'), 9);
    await fsp.writeFile(file, costLine('d@example.com', 3, '2026-10-06T10:00:00Z') + costLine('d@example.com', 3, '2026-10-06T11:00:00Z') + costLine('d@example.com', 3, '2026-10-06T12:00:00Z'));
    await index.refresh();
    assert.equal(index.spent('c@example.com'), 0, 'the beginning differs: read again');
    assert.equal(index.spent('d@example.com'), 9);
    await fsp.rm(file);
    await index.refresh();
    assert.equal(index.spent('d@example.com'), 0, 'a deleted file counts nothing');

    // concurrent refreshes never count a row twice
    await fsp.writeFile(file, costLine('e@example.com', 1, '2026-10-07T10:00:00Z'));
    await Promise.all([index.refresh(), index.refresh(), index.refresh()]);
    assert.equal(index.spent('e@example.com'), 1);

    // a big journal is read once, then only its end
    const big = Array.from({ length: 30000 }, (_, i) => costLine(`p${i % 50}@example.com`, 0.01, '2026-10-08T10:00:00Z')).join('');
    await fsp.writeFile(file, big);
    const started = Date.now();
    await index.refresh();
    assert.equal(index.rows, 30000);
    assert.ok(Math.abs(index.spent('p0@example.com') - 6) < 1e-9);
    await fsp.appendFile(file, costLine('p0@example.com', 1, '2026-10-08T11:00:00Z'));
    const before = Date.now();
    await index.refresh();
    assert.ok(Date.now() - before < 100, 'the second look reads only what was appended');
    assert.ok(Math.abs(index.spent('p0@example.com') - 7) < 1e-9);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the budget ---------- */

async function testBudget() {
  const dir = await tempDir('budget');
  const now = clock();
  const teamsStore = createTeamsStore({ file: path.join(dir, 'teams.json'), now });
  const file = path.join(dir, 'costs.jsonl');
  const index = budgetLib.createCostIndex({ file });
  const budget = budgetLib.createBudget({ index, teams: () => teamsStore, now });
  access.useTeamsStore(teamsStore);
  const view = (email) => access.viewerOf({ kubleUser: email }, ACTIVE_ENV);
  const add = async (user, cost, ts = new Date(now()).toISOString()) => fsp.appendFile(file, costLine(user, cost, ts));
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return null;
  };
  try {
    // team creation is "now"; the cost rows of the past do not count
    const kurs = teamsStore.createTeam({ name: 'Kurs', budgetUsd: 10 });
    await add('anna@example.com', 7, '2026-09-01T00:00:00Z'); // before the training
    teamsStore.addMembers(kurs.id, ['anna@example.com', 'ben@example.com']);
    let status = await budget.status(view('anna@example.com'));
    assert.deepEqual(status, { limitUsd: 10, spentUsd: 0, reservedUsd: 0, remainingUsd: 10, since: '2026-10-01T09:00:00.000Z' });
    assert.equal(await budget.status(view('staff@staff.example.com')), null, 'internal people have no budget');
    assert.equal(await budget.status(view('admin@example.com')), null, 'admins have no budget');
    assert.equal(await budget.status(view('lokal')), null);
    assert.equal(await budget.status(access.viewerOf({ kubleUser: 'anna@example.com' }, {})), null, 'the local mode has none');
    assert.deepEqual(await budget.status(view('gast@gmail.example')), { limitUsd: 0, spentUsd: 0, reservedUsd: 0, remainingUsd: 0, since: null }, 'guests: 0');

    // spending counts; other people's spending does not
    now.advance(60000);
    await add('anna@example.com', 4.25);
    await add('ben@example.com', 1);
    await add('ANNA@example.com', 0.75);
    status = await budget.status(view('anna@example.com'));
    assert.equal(status.spentUsd, 5);
    assert.equal(status.remainingUsd, 5);
    assert.equal((await budget.status(view('ben@example.com'))).spentUsd, 1);

    // checks: free, fits, does not fit, exhausted
    assert.equal((await budget.begin(view('anna@example.com'))).applies, true, 'no estimate: anything left is enough');
    (await budget.begin(view('anna@example.com'), { estimateUsd: 5 })).release(); // exactly what is left fits
    let error = await errorOf(budget.begin(view('anna@example.com'), { estimateUsd: 5.01, label: 'generate_video' }));
    assert.ok(error instanceof budgetLib.BudgetError);
    assert.equal(error.code, 'BUDGET_INSUFFICIENT');
    assert.equal(error.status, 402);
    assert.equal(error.remainingUsd, 5);
    assert.equal(error.estimateUsd, 5.01);
    assert.equal(error.budget.spentUsd, 5);
    assert.match(error.message, /\$5\.01.*\$5\.00/);
    assert.match(error.messageDe, /5\.01.*5\.00/);
    await add('anna@example.com', 5);
    error = await errorOf(budget.begin(view('anna@example.com')));
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    assert.equal(error.remainingUsd, 0);
    error = await errorOf(budget.begin(view('anna@example.com'), { estimateUsd: 0.5 }));
    assert.equal(error.code, 'BUDGET_EXHAUSTED', 'nothing left is exhausted, whatever the estimate');
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 0, 'never negative');
    // overspending by a job that was more expensive than estimated is not hidden
    await add('anna@example.com', 3);
    assert.equal((await budget.status(view('anna@example.com'))).spentUsd, 13);
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 0);
    // guests can never pay
    error = await errorOf(budget.begin(view('gast@gmail.example'), { estimateUsd: 0.01 }));
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    // everybody else passes without any bookkeeping
    for (const email of ['staff@staff.example.com', 'admin@example.com', 'lokal']) {
      const grant = await budget.begin(view(email), { estimateUsd: 1e9 });
      assert.equal(grant.applies, false);
      assert.equal(grant.jobKey, null);
    }
    assert.equal(budget.reservationCount(), 0);

    // reset: the count starts again; an override changes the amount
    now.advance(1000);
    teamsStore.updateMember(kurs.id, 'anna@example.com', { resetBudget: true });
    status = await budget.status(view('anna@example.com'));
    assert.equal(status.spentUsd, 0);
    assert.equal(status.remainingUsd, 10);
    await add('anna@example.com', 2);
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 8);
    teamsStore.updateMember(kurs.id, 'anna@example.com', { budgetOverrideUsd: 3 });
    assert.equal((await budget.status(view('anna@example.com'))).limitUsd, 3, 'an override can also lower the amount');
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 1);
    teamsStore.updateMember(kurs.id, 'anna@example.com', { budgetOverrideUsd: 50 });
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 48);
    teamsStore.updateMember(kurs.id, 'anna@example.com', { budgetOverrideUsd: null });
    teamsStore.updateTeam(kurs.id, { budgetUsd: 20 });
    assert.equal((await budget.status(view('anna@example.com'))).remainingUsd, 18, 'a new team amount applies at once');
    teamsStore.updateTeam(kurs.id, { budgetUsd: 10 });

    // several teams: the highest limit, the latest start
    now.advance(3600 * 1000);
    const second = teamsStore.createTeam({ name: 'Aufbau', budgetUsd: 25 });
    teamsStore.addMembers(second.id, ['anna@example.com']); // starts now: the earlier 2 USD do not count any more
    status = await budget.status(view('anna@example.com'));
    assert.equal(status.limitUsd, 25);
    assert.equal(status.spentUsd, 0, 'a new training brings a fresh budget');
    assert.equal(status.since, '2026-10-01T10:01:01.000Z');
    await add('anna@example.com', 1);
    teamsStore.updateMember(kurs.id, 'anna@example.com', { budgetOverrideUsd: 40 });
    assert.equal((await budget.status(view('anna@example.com'))).limitUsd, 40, 'the highest of (override ?? team amount)');
    teamsStore.updateTeam(second.id, { archived: true });
    status = await budget.status(view('anna@example.com'));
    assert.equal(status.limitUsd, 40, 'an archived team does not count');
    assert.equal(status.spentUsd, 3, 'the start of the remaining team applies (nothing before it counts: 2 + 1)');
    teamsStore.updateMember(kurs.id, 'anna@example.com', { budgetOverrideUsd: null });

    // removed from all teams: no budget at once (a participant object from before the removal is not trusted)
    const staleViewer = view('ben@example.com');
    assert.equal(staleViewer.kind, 'participant');
    teamsStore.removeMember(kurs.id, 'ben@example.com');
    assert.equal((await budget.status(staleViewer)).limitUsd, 0);
    assert.equal((await errorOf(budget.begin(staleViewer))).code, 'BUDGET_EXHAUSTED');
    teamsStore.addMembers(kurs.id, ['ben@example.com']);

    /* ----- reservations ----- */
    const ben = view('ben@example.com');
    assert.equal((await budget.status(ben)).remainingUsd, 10, 'the new membership starts a fresh count');
    const first = await budget.begin(ben, { estimateUsd: 6 });
    assert.equal(first.reservedUsd, 6);
    assert.match(first.jobKey, /^hold:/);
    status = await budget.status(ben);
    assert.equal(status.reservedUsd, 6);
    assert.equal(status.remainingUsd, 4);
    error = await errorOf(budget.begin(ben, { estimateUsd: 5 }));
    assert.equal(error.code, 'BUDGET_INSUFFICIENT', 'the reserved part is not available for a second action');
    assert.equal(error.remainingUsd, 4);
    const secondHold = await budget.begin(ben, { estimateUsd: 4 });
    assert.equal((await budget.status(ben)).remainingUsd, 0);
    assert.equal((await errorOf(budget.begin(ben))).code, 'BUDGET_EXHAUSTED', 'everything reserved: nothing left even without an estimate');
    first.release();
    assert.equal((await budget.status(ben)).remainingUsd, 6);
    secondHold.release();
    assert.equal(budget.reservationCount(), 0);
    first.release(); // releasing twice is harmless
    // a call with no estimate reserves nothing
    const free = await budget.begin(ben);
    assert.equal(free.jobKey, null);
    assert.equal(budget.reservationCount(), 0);

    // parallel: three actions of 4 USD at once against 10 USD: two get through, one is refused
    const results = await Promise.allSettled([budget.begin(ben, { estimateUsd: 4 }), budget.begin(ben, { estimateUsd: 4 }), budget.begin(ben, { estimateUsd: 4 })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const refused = results.find((result) => result.status === 'rejected');
    assert.equal(refused.reason.code, 'BUDGET_INSUFFICIENT');
    assert.equal((await budget.status(ben)).reservedUsd, 8);
    for (const result of results) if (result.status === 'fulfilled') result.value.release();
    // ... and a burst of 20 small ones
    const burst = await Promise.allSettled(Array.from({ length: 20 }, () => budget.begin(ben, { estimateUsd: 1 })));
    assert.equal(burst.filter((result) => result.status === 'fulfilled').length, 10);
    for (const result of burst) if (result.status === 'fulfilled') result.value.release();

    // a reservation that is never released ends by itself
    await budget.begin(ben, { estimateUsd: 9 });
    assert.equal((await budget.status(ben)).remainingUsd, 1);
    now.advance(budgetLib.HOLD_TTL_MS + 1000);
    assert.equal((await budget.status(ben)).remainingUsd, 10);

    /* ----- a node run ----- */
    const run = await budget.beginRun(ben, { runId: 'r1', estimateUsd: 7 });
    assert.equal(run.key, 'run:r1');
    assert.equal((await budget.status(ben)).remainingUsd, 3);
    error = await errorOf(budget.beginRun(ben, { runId: 'r2', estimateUsd: 4 }));
    assert.equal(error.code, 'BUDGET_INSUFFICIENT', 'a second run cannot spend what the first one has planned');
    // the paid calls of the run itself are checked against what is left without its own reservation
    const inRun = await budget.begin(ben, { estimateUsd: 5, runKey: run.key });
    assert.equal(inRun.jobKey, run.key, 'a call inside a run needs no reservation of its own');
    assert.equal((await budget.status(ben)).reservedUsd, 7);
    error = await errorOf(budget.begin(ben, { estimateUsd: 10.5, runKey: run.key }));
    assert.equal(error.code, 'BUDGET_INSUFFICIENT');
    // costs booked for the run shrink its reservation, so nothing is counted twice
    await add('ben@example.com', 3);
    budget.settle(run.key, 3);
    status = await budget.status(ben);
    assert.equal(status.spentUsd, 3);
    assert.equal(status.reservedUsd, 4);
    assert.equal(status.remainingUsd, 3);
    budget.settle(run.key, 100);
    assert.equal((await budget.status(ben)).reservedUsd, 0, 'never below zero');
    run.release();
    // unknown estimates: the run only needs something left; nodes without a price reserve nothing
    const unknown = await budget.beginRun(ben, { runId: 'r3', estimateUsd: 0 });
    assert.equal(unknown.reservedUsd, 0);
    unknown.release();
    // a run without paid nodes is never refused (results and local work stay usable)
    await add('ben@example.com', 20);
    assert.equal((await budget.beginRun(ben, { runId: 'r4', estimateUsd: 0, paid: false })).applies, false);
    error = await errorOf(budget.beginRun(ben, { runId: 'r5', estimateUsd: 0, paid: true }));
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    error = await errorOf(budget.beginRun(ben, { runId: 'r6', estimateUsd: 2 }));
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    assert.equal((await budget.beginRun(view('staff@staff.example.com'), { runId: 'r7', estimateUsd: 1e6 })).applies, false);

    /* ----- async jobs ----- */
    now.advance(1000);
    teamsStore.updateMember(kurs.id, 'ben@example.com', { resetBudget: true });
    const held = await budget.begin(ben, { estimateUsd: 2.5 });
    const job = { budgetKey: held.jobKey, reservedUsd: 2.5, user: 'ben@example.com' };
    assert.equal((await budget.status(ben)).reservedUsd, 2.5);
    // after a restart the reservation is gone; the poller puts it back for the job that is still open
    const restarted = budgetLib.createBudget({ index, teams: () => teamsStore, now });
    assert.equal((await restarted.status(ben)).reservedUsd, 0);
    restarted.ensureJob(job);
    assert.equal((await restarted.status(ben)).reservedUsd, 2.5);
    restarted.ensureJob(job);
    assert.equal((await restarted.status(ben)).reservedUsd, 2.5, 'not twice');
    restarted.ensureJob({ budgetKey: 'run:x', reservedUsd: 5, user: 'ben@example.com' });
    restarted.ensureJob({ budgetKey: 'hold:y', user: 'ben@example.com' });
    restarted.ensureJob({ budgetKey: 'hold:z', reservedUsd: 5, user: 'lokal' });
    restarted.ensureJob({});
    assert.equal((await restarted.status(ben)).reservedUsd, 2.5, 'only hold reservations of a person are restored');
    // the cost arrives: a hold ends, whatever the amount (unknown = 0)
    budget.settleJob(job, 1.9);
    assert.equal((await budget.status(ben)).reservedUsd, 0);
    const held2 = await budget.begin(ben, { estimateUsd: 2 });
    budget.settleJob({ budgetKey: held2.jobKey }, 0);
    assert.equal(budget.reservationCount(), 0);
    const held3 = await budget.begin(ben, { estimateUsd: 2 });
    budget.releaseJob({ budgetKey: held3.jobKey }); // the job failed
    assert.equal(budget.reservationCount(), 0);
    // a job of a run settles the run's reservation and leaves it in place
    const run2 = await budget.beginRun(ben, { runId: 'r8', estimateUsd: 6 });
    budget.settleJob({ budgetKey: run2.key }, 2);
    assert.equal((await budget.status(ben)).reservedUsd, 4);
    budget.releaseJob({ budgetKey: run2.key });
    assert.equal((await budget.status(ben)).reservedUsd, 4, 'the run releases its own reservation');
    run2.release();
    assert.equal(budget.reservationCount(), 0);
    budget.settleJob(null, 1);
    budget.settleJob({}, 1);
    budget.releaseJob(undefined);
  } finally {
    access.useTeamsStore(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- asynchronous jobs without a price, cancelled runs, bulk status ---------- */

async function testBudgetAsyncJobs() {
  const dir = await tempDir('budget-async');
  const now = clock();
  const teamsStore = createTeamsStore({ file: path.join(dir, 'teams.json'), now });
  const file = path.join(dir, 'costs.jsonl');
  const index = budgetLib.createCostIndex({ file });
  const budget = budgetLib.createBudget({ index, teams: () => teamsStore, now });
  access.useTeamsStore(teamsStore);
  const view = (email) => access.viewerOf({ kubleUser: email }, ACTIVE_ENV);
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return null;
  };
  const savedEnv = { hold: process.env.BUDGET_ASYNC_HOLD_USD, jobs: process.env.BUDGET_MAX_OPEN_JOBS };
  delete process.env.BUDGET_ASYNC_HOLD_USD;
  delete process.env.BUDGET_MAX_OPEN_JOBS;
  try {
    const kurs = teamsStore.createTeam({ name: 'Kurs', budgetUsd: 10 });
    teamsStore.addMembers(kurs.id, ['anna@example.com', 'ben@example.com', 'cleo@example.com']);
    teamsStore.updateMember(kurs.id, 'cleo@example.com', { budgetOverrideUsd: 0.05 });
    const anna = view('anna@example.com');
    const ben = view('ben@example.com');
    const cleo = view('cleo@example.com');

    // a small rest: the flat reservation is capped by what is left, so the second video is refused at once
    const first = await budget.begin(cleo, { asyncJob: true, label: 'generate_video' });
    assert.equal(first.reservedUsd, 0.05, 'at most what is left');
    assert.match(first.jobKey, /^hold:/, 'the job carries a key, so the reservation stays until it is booked');
    let error = await errorOf(budget.begin(cleo, { asyncJob: true, label: 'generate_video' }));
    assert.equal(error.code, 'BUDGET_EXHAUSTED', '"make 10 variants as video" with 0.05 left starts one video, not ten');
    assert.equal((await budget.status(cleo)).remainingUsd, 0);

    // enough left: the flat amount of 2 USD is reserved per job, at most 2 jobs are open
    const one = await budget.begin(anna, { asyncJob: true });
    assert.equal(one.reservedUsd, 2);
    const two = await budget.begin(anna, { asyncJob: true });
    assert.equal((await budget.status(anna)).reservedUsd, 4);
    error = await errorOf(budget.begin(anna, { asyncJob: true, label: 'generate_video' }));
    assert.equal(error.code, 'BUDGET_JOBS_OPEN');
    assert.equal(error.status, 429);
    assert.match(error.messageDe, /2 Aufträge/);
    assert.equal(error.toJSON().code, 'BUDGET_JOBS_OPEN');
    // other people and paid actions that are not jobs are not affected
    assert.equal((await budget.begin(ben, { asyncJob: true })).reservedUsd, 2);
    assert.equal((await budget.begin(anna, { estimateUsd: 1 })).reservedUsd, 1);
    // the cost arrives: the slot is free again and the reservation is gone
    budget.settleJob({ budgetKey: one.jobKey }, 3);
    assert.equal((await budget.status(anna)).reservedUsd, 3, 'two.jobKey (2) and the sync hold (1) remain');
    const three = await budget.begin(anna, { asyncJob: true });
    assert.equal(three.reservedUsd, 2);
    // a failed job frees its slot too
    budget.releaseJob({ budgetKey: two.jobKey });
    budget.releaseJob({ budgetKey: three.jobKey });
    assert.equal((await budget.begin(anna, { asyncJob: true })).applies, true);
    // a known estimate is reserved as it is (and also counts as an open job)
    const priced = await budget.begin(ben, { asyncJob: true, estimateUsd: 3.5 });
    assert.equal(priced.reservedUsd, 3.5);
    error = await errorOf(budget.begin(ben, { asyncJob: true }));
    assert.equal(error.code, 'BUDGET_JOBS_OPEN');
    // the limits can be set through the environment
    process.env.BUDGET_MAX_OPEN_JOBS = '1';
    process.env.BUDGET_ASYNC_HOLD_USD = '0.5';
    const teamB = teamsStore.createTeam({ name: 'Kurs B', budgetUsd: 10 });
    teamsStore.addMembers(teamB.id, ['dora@example.com']);
    const dora = view('dora@example.com');
    assert.equal((await budget.begin(dora, { asyncJob: true })).reservedUsd, 0.5);
    assert.equal((await errorOf(budget.begin(dora, { asyncJob: true }))).code, 'BUDGET_JOBS_OPEN');
    delete process.env.BUDGET_MAX_OPEN_JOBS;
    delete process.env.BUDGET_ASYNC_HOLD_USD;
    // a node run does not use the flat amount: its own plan reservation covers the calls
    const run = await budget.beginRun(dora, { runId: 'r1', estimateUsd: 3 });
    const inRun = await budget.begin(dora, { asyncJob: true, runKey: run.key });
    assert.equal(inRun.jobKey, run.key);
    assert.equal(inRun.reservedUsd, 0);
    run.release();

    // the reservation survives a restart of the app for the open job (the poller puts it back)
    const restarted = budgetLib.createBudget({ index, teams: () => teamsStore, now });
    restarted.ensureJob({ budgetKey: first.jobKey, reservedUsd: first.reservedUsd, user: 'cleo@example.com' });
    assert.equal((await restarted.begin(cleo, { estimateUsd: null }).catch((e) => e)).code, 'BUDGET_EXHAUSTED');

    // a cancelled node run: the provider job goes on and is billed later, its share of the run stays reserved
    const eva = await (async () => {
      teamsStore.addMembers(kurs.id, ['eva@example.com']);
      return view('eva@example.com');
    })();
    const evaRun = await budget.beginRun(eva, { runId: 'r2', estimateUsd: 8 });
    budget.settleJob({ budgetKey: evaRun.key }, 1); // one node of the run was booked
    // a node that learns its price while it runs adds the rest to the reservation of its run (before: 8 - 1 = 7 left in the run)
    assert.equal(budget.extendRun(eva, evaRun.key, 2), true);
    assert.equal((await budget.status(eva)).reservedUsd, 9, 'the run holds 7 + 2');
    assert.equal(budget.extendRun(eva, evaRun.key, 0), false);
    assert.equal(budget.extendRun(view('admin@example.com'), evaRun.key, 2), false, 'admins and internal people have no budget');
    const lateRun = await budget.beginRun(eva, { runId: 'r2b', estimateUsd: 0 });
    assert.equal((await budget.status(eva)).reservedUsd, 9);
    assert.equal(budget.extendRun(eva, lateRun.key, 1.5), true, 'a run that reserved nothing gets a reservation');
    assert.equal((await budget.status(eva)).reservedUsd, 10.5);
    lateRun.release();
    assert.equal((await budget.status(eva)).reservedUsd, 9);
    budget.settleJob({ budgetKey: evaRun.key }, 2); // the 2 USD are booked again: back to 7 for the hand-over below
    const holds = await budget.detachRun(eva, evaRun.key, 2);
    assert.equal(holds.length, 2);
    assert.deepEqual(holds.map((item) => item.usd), [3.5, 3.5], '7 USD that are left are split over the two open jobs');
    evaRun.release(); // the run ends
    assert.equal((await budget.status(eva)).reservedUsd, 7, 'the budget does not come back while the jobs run');
    assert.equal((await budget.status(eva)).remainingUsd, 3);
    assert.equal((await errorOf(budget.beginRun(eva, { runId: 'r3', estimateUsd: 8 }))).code, 'BUDGET_INSUFFICIENT', 'a second run cannot spend it again');
    const jobA = { budgetKey: holds[0].key, reservedUsd: holds[0].usd, user: 'eva@example.com' };
    budget.settleJob(jobA, 4);
    assert.equal((await budget.status(eva)).reservedUsd, 3.5, 'the first job is booked: its hold ends');
    budget.releaseJob({ budgetKey: holds[1].key });
    assert.equal((await budget.status(eva)).reservedUsd, 0);
    // nothing left to split (unknown costs): a flat amount is held, at most what is left
    const flatRun = await budget.beginRun(eva, { runId: 'r4', estimateUsd: 0 });
    const flat = await budget.detachRun(eva, flatRun.key, 1);
    assert.equal(flat[0].usd, 2);
    flatRun.release();
    budget.releaseJob({ budgetKey: flat[0].key });
    assert.deepEqual(await budget.detachRun(view('admin@example.com'), 'run:x', 2), [], 'admins and internal people have no budget');
    assert.deepEqual(await budget.detachRun(eva, 'run:x', 0), []);

    // one look at the cost journal for many addresses
    let refreshes = 0;
    const counting = { ...index, refresh: () => { refreshes += 1; return index.refresh(); }, spent: (...args) => index.spent(...args) };
    const countingBudget = budgetLib.createBudget({ index: counting, teams: () => teamsStore, now });
    await fsp.appendFile(file, costLine('anna@example.com', 2, new Date(now() + 1000).toISOString()));
    const list = ['ANNA@example.com', 'ben@example.com', 'anna@example.com', 'nobody@example.com'];
    const statuses = await countingBudget.statusOfEmails(list);
    assert.equal(refreshes, 1, 'the journal is looked at once for the whole list');
    assert.deepEqual([...statuses.keys()], ['anna@example.com', 'ben@example.com', 'nobody@example.com']);
    for (const email of statuses.keys()) assert.deepEqual(statuses.get(email), await countingBudget.statusOfEmail(email));
    assert.equal(statuses.get('anna@example.com').spentUsd, 2);
  } finally {
    if (savedEnv.hold === undefined) delete process.env.BUDGET_ASYNC_HOLD_USD;
    else process.env.BUDGET_ASYNC_HOLD_USD = savedEnv.hold;
    if (savedEnv.jobs === undefined) delete process.env.BUDGET_MAX_OPEN_JOBS;
    else process.env.BUDGET_MAX_OPEN_JOBS = savedEnv.jobs;
    access.useTeamsStore(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- allowlist sync ---------- */

async function testAccessSync() {
  const dir = await tempDir('sync');
  const list = path.join(dir, 'allowlist.json');
  const stateFile = path.join(dir, 'state', 'access-sync.json');
  const now = clock();
  const teamsStore = createTeamsStore({ file: path.join(dir, 'teams.json'), now });
  const env = { ACCESS_ALLOWLIST_FILE: list, ACCESS_ALLOWLIST_ROUTE: '/training', INTERNAL_EMAIL_DOMAINS: 'staff.example.com' };
  const sync = createAccessSync({ teams: () => teamsStore, env, stateFile, now });
  const read = () => JSON.parse(fs.readFileSync(list, 'utf8'));
  const original = {
    default: { domain: 'staff.example.com', public: false },
    routes: [
      { path: '/supercomputer', public: false, extra_emails: ['other@example.org'] },
      { path: '/training', public: false, extra_emails: ['Manual@Example.org', '*@partner.example', 'x@example.org'], label: 'Kurs' },
      { path: '/other', public: true, extra_emails: [] }
    ]
  };
  try {
    // disabled without the two variables: nothing happens, nothing is read
    for (const partial of [{}, { ACCESS_ALLOWLIST_FILE: list }, { ACCESS_ALLOWLIST_ROUTE: '/training' }]) {
      const off = createAccessSync({ teams: () => teamsStore, env: partial, stateFile, now });
      assert.equal(off.enabled(), false);
      assert.deepEqual(await off.sync(), { ok: true, enabled: false, changed: false });
      assert.deepEqual(off.status(), { enabled: false });
    }
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(sync.enabled(), true);

    await fsp.writeFile(list, `${JSON.stringify(original)}\n`, { mode: 0o640 });
    fs.chmodSync(list, 0o640);
    const kurs = teamsStore.createTeam({ name: 'Kurs', budgetUsd: 5 });
    teamsStore.addMembers(kurs.id, ['p1@gmail.example', 'P2@gmail.example', 'staff@staff.example.com', 'manual@example.org']);

    // first run: manual entries stay untouched (also things that are no address), members are added, the domain is not
    let result = await sync.sync();
    assert.deepEqual(result, { ok: true, enabled: true, changed: true, count: 2 });
    let document = read();
    assert.deepEqual(document.routes[1].extra_emails, ['Manual@Example.org', '*@partner.example', 'x@example.org', 'p1@gmail.example', 'p2@gmail.example']);
    assert.equal(document.routes[1].label, 'Kurs', 'other fields of the route stay');
    assert.deepEqual(document.routes[0], original.routes[0], 'other routes stay');
    assert.deepEqual(document.routes[2], original.routes[2]);
    assert.deepEqual(document.default, original.default);
    assert.equal(fs.statSync(list).mode & 0o777, 0o640, 'the permissions of the file are kept');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'atomic: no temporary file is left');
    assert.ok(fs.existsSync(path.join(dir, '.allowlist.json.access-sync.json')), 'the record is also kept next to the list');
    // a backup was made once, before the first change
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('allowlist.json.bak-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')), original);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state.synced, ['p1@gmail.example', 'p2@gmail.example'], 'a manual entry that is also a member is not ours');
    assert.equal(state.route, '/training');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

    // nothing changed: the file is not written again
    const mtime = fs.statSync(list).mtimeMs;
    now.advance(1000);
    result = await sync.sync();
    assert.equal(result.changed, false);
    assert.equal(fs.statSync(list).mtimeMs, mtime);

    // a member is removed: gone from the list, manual entries stay (also the one that is a member)
    teamsStore.removeMember(kurs.id, 'p1@gmail.example');
    teamsStore.removeMember(kurs.id, 'manual@example.org');
    await sync.sync();
    assert.deepEqual(read().routes[1].extra_emails, ['Manual@Example.org', '*@partner.example', 'x@example.org', 'p2@gmail.example']);

    // an entry an admin added by hand after the sync stays, an entry of ours that an admin removed by hand does not come back if the person left
    const edited = read();
    edited.routes[1].extra_emails.push('handmade@example.org');
    await fsp.writeFile(list, JSON.stringify(edited));
    teamsStore.addMembers(kurs.id, ['p3@gmail.example', 'handmade@example.org']);
    await sync.sync();
    assert.deepEqual(read().routes[1].extra_emails, ['Manual@Example.org', '*@partner.example', 'x@example.org', 'p2@gmail.example', 'handmade@example.org', 'p3@gmail.example']);
    teamsStore.removeMember(kurs.id, 'handmade@example.org');
    await sync.sync();
    assert.ok(read().routes[1].extra_emails.includes('handmade@example.org'), 'a manually added address is never removed');

    // archive / unarchive / delete
    teamsStore.updateTeam(kurs.id, { archived: true });
    await sync.sync();
    assert.deepEqual(read().routes[1].extra_emails, ['Manual@Example.org', '*@partner.example', 'x@example.org', 'handmade@example.org']);
    teamsStore.updateTeam(kurs.id, { archived: false });
    await sync.sync();
    assert.ok(read().routes[1].extra_emails.includes('p2@gmail.example'));
    teamsStore.deleteTeam(kurs.id);
    await sync.sync();
    assert.deepEqual(read().routes[1].extra_emails, ['Manual@Example.org', '*@partner.example', 'x@example.org', 'handmade@example.org']);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('allowlist.json.bak-')).length, 1, 'one backup only');

    // two teams with the same person: the person stays while one team has them
    const a = teamsStore.createTeam({ name: 'A', budgetUsd: 1 });
    const b = teamsStore.createTeam({ name: 'B', budgetUsd: 1 });
    teamsStore.addMembers(a.id, ['dup@gmail.example']);
    teamsStore.addMembers(b.id, ['dup@gmail.example']);
    await sync.sync();
    assert.equal(read().routes[1].extra_emails.filter((email) => email === 'dup@gmail.example').length, 1);
    teamsStore.deleteTeam(a.id);
    await sync.sync();
    assert.ok(read().routes[1].extra_emails.includes('dup@gmail.example'));
    teamsStore.deleteTeam(b.id);
    await sync.sync();
    assert.ok(!read().routes[1].extra_emails.includes('dup@gmail.example'));

    // the route is created if it does not exist; everything else stays
    const target = path.join(dir, 'other-list.json');
    await fsp.writeFile(target, JSON.stringify({ default: { domain: 'staff.example.com' }, routes: [{ path: '/x', extra_emails: ['keep@example.org'] }] }));
    const created = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: '/neu' }, stateFile: path.join(dir, 'state-2.json'), now });
    teamsStore.createTeam({ name: 'C', budgetUsd: 1 });
    teamsStore.addMembers(teamsStore.listTeams().find((team) => team.name === 'C').id, ['new@gmail.example']);
    result = await created.sync();
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).routes, [
      { path: '/x', extra_emails: ['keep@example.org'] },
      { path: '/neu', public: false, extra_emails: ['new@gmail.example'] }
    ]);
    // a file without the routes list gets one
    await fsp.writeFile(target, JSON.stringify({ default: {} }));
    const fresh = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: '/neu' }, stateFile: path.join(dir, 'state-3.json'), now });
    assert.equal((await fresh.sync()).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).routes, [{ path: '/neu', public: false, extra_emails: ['new@gmail.example'] }]);

    // an empty INTERNAL_EMAIL_DOMAINS enters everybody (nobody is known to be covered by the login's domain)
    const noDomain = createAccessSync({ teams: () => teamsStore, env: { ...env, INTERNAL_EMAIL_DOMAINS: '', ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: '/all' }, stateFile: path.join(dir, 'state-4.json'), now });
    teamsStore.addMembers(teamsStore.listTeams().find((team) => team.name === 'C').id, ['staff@staff.example.com']);
    await noDomain.sync();
    assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).routes.find((route) => route.path === '/all').extra_emails.includes('staff@staff.example.com'));

    // changing the route takes our entries out of the old one
    const moved = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: '/neu' }, stateFile: path.join(dir, 'state-4.json'), now });
    await moved.sync();
    const routes = JSON.parse(fs.readFileSync(target, 'utf8')).routes;
    assert.deepEqual(routes.find((route) => route.path === '/all').extra_emails, [], 'the old route is cleaned');
    assert.ok(routes.find((route) => route.path === '/neu').extra_emails.includes('new@gmail.example'));
    assert.ok(!routes.find((route) => route.path === '/neu').extra_emails.includes('staff@staff.example.com'), 'internal domain excluded again');

    // failures: reported as a warning, the file stays, the app keeps going
    const warn = console.warn;
    console.warn = () => {};
    try {
      const missing = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: path.join(dir, 'gibt-es-nicht.json') }, stateFile: path.join(dir, 'state-5.json'), now });
      result = await missing.sync();
      assert.equal(result.ok, false);
      assert.match(result.error, /gibt-es-nicht/);
      assert.equal(missing.status().ok, false);
      assert.match(missing.status().warning, /gibt-es-nicht/);
      assert.equal(fs.existsSync(path.join(dir, 'gibt-es-nicht.json')), false, 'a missing file is not created');
      await fsp.writeFile(target, '{ kaputt');
      const broken = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target }, stateFile: path.join(dir, 'state-6.json'), now });
      assert.match((await broken.sync()).error, /kein gültiges JSON/);
      assert.equal(fs.readFileSync(target, 'utf8'), '{ kaputt');
      await fsp.writeFile(target, JSON.stringify({ routes: 'nein' }));
      assert.match((await broken.sync()).error, /keine Liste/);
      await fsp.writeFile(target, JSON.stringify([1, 2]));
      assert.match((await broken.sync()).error, /erwartete Form/);
      const badRoute = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: 'ohne-slash' }, stateFile: path.join(dir, 'state-7.json'), now });
      assert.match((await badRoute.sync()).error, /mit \//);
      // ... and the state after a good run is ok again
      await fsp.writeFile(target, JSON.stringify({ routes: [] }));
      assert.equal((await broken.sync()).ok, true);
      assert.equal(broken.status().ok, true);
      assert.equal(broken.status().warning, null);
    } finally {
      console.warn = warn;
    }

    // several runs in a row are queued (no torn file)
    const queued = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: target, ACCESS_ALLOWLIST_ROUTE: '/queue' }, stateFile: path.join(dir, 'state-8.json'), now });
    await Promise.all(Array.from({ length: 10 }, () => queued.sync()));
    await queued.settled();
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).routes.filter((route) => route.path === '/queue').length, 1);
    void sleep;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- allowlist sync: record, symlink, bind mount ---------- */

async function testAccessSyncRecord() {
  const dir = await tempDir('sync-record');
  const now = clock();
  const teamsStore = createTeamsStore({ file: path.join(dir, 'teams.json'), now });
  const list = path.join(dir, 'allowlist.json');
  const stateFile = path.join(dir, 'state', 'access-sync.json');
  const env = { ACCESS_ALLOWLIST_FILE: list, ACCESS_ALLOWLIST_ROUTE: '/training', INTERNAL_EMAIL_DOMAINS: 'staff.example.com' };
  const make = () => createAccessSync({ teams: () => teamsStore, env, stateFile, now });
  const read = (file = list) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fsp.writeFile(list, JSON.stringify({ routes: [{ path: '/training', extra_emails: ['manual@example.org'] }] }));
    const kurs = teamsStore.createTeam({ name: 'Kurs', budgetUsd: 5 });
    teamsStore.addMembers(kurs.id, ['p1@gmail.example', 'p2@gmail.example']);
    let sync = make();
    assert.equal((await sync.sync()).ok, true);
    assert.deepEqual(read().routes[0].extra_emails, ['manual@example.org', 'p1@gmail.example', 'p2@gmail.example']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.allowlist.json.access-sync.json'), 'utf8')).synced, ['p1@gmail.example', 'p2@gmail.example']);

    // a broken record is not an empty record: the sync stops with a warning and changes nothing (the record is left alone)
    teamsStore.removeMember(kurs.id, 'p1@gmail.example');
    const before = fs.readFileSync(list, 'utf8');
    await fsp.writeFile(stateFile, '{ kaputt');
    await fsp.rm(path.join(dir, '.allowlist.json.access-sync.json'));
    sync = make();
    let result = await sync.sync();
    assert.equal(result.ok, false);
    assert.match(result.error, /Sync-Status.*unlesbar/);
    assert.equal(fs.readFileSync(list, 'utf8'), before, 'the list stays as it is');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ kaputt', 'the broken record is not overwritten');
    assert.equal(sync.status().ok, false);
    assert.match(sync.status().warning, /unlesbar/);

    // the copy next to the list saves a lost or broken record: p1 is still recognised as ours and removed
    await fsp.rm(stateFile);
    await fsp.writeFile(path.join(dir, '.allowlist.json.access-sync.json'), JSON.stringify({ version: 1, route: '/training', synced: ['p1@gmail.example', 'p2@gmail.example'], lastRunAt: '2026-10-01T09:00:00.000Z' }));
    result = await make().sync();
    assert.equal(result.ok, true);
    assert.deepEqual(read().routes[0].extra_emails, ['manual@example.org', 'p2@gmail.example'], 'a lost record does not turn synchronised addresses into manual ones');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).synced, ['p2@gmail.example'], 'the record is rebuilt');
    // a broken record with a readable copy uses the copy
    await fsp.writeFile(stateFile, 'nope');
    teamsStore.removeMember(kurs.id, 'p2@gmail.example');
    assert.equal((await make().sync()).ok, true);
    assert.deepEqual(read().routes[0].extra_emails, ['manual@example.org']);

    // the record is written BEFORE the list: when the list cannot be written, what was entered stays known as ours
    teamsStore.addMembers(kurs.id, ['p3@gmail.example', 'p4@gmail.example']);
    assert.equal((await make().sync()).ok, true);
    teamsStore.removeMember(kurs.id, 'p3@gmail.example');
    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === fs.realpathSync(list)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return realRename(from, to);
    };
    try {
      result = await make().sync();
    } finally {
      fs.renameSync = realRename;
      fs.writeFileSync = realWrite;
    }
    assert.equal(result.ok, false);
    assert.match(result.error, /disk full/);
    assert.ok(read().routes[0].extra_emails.includes('p3@gmail.example'), 'the list is unchanged after the failed write');
    const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(recorded.synced.includes('p3@gmail.example'), 'p3 is still known as ours although the list was not rewritten');
    assert.equal((await make().sync()).ok, true);
    assert.deepEqual(read().routes[0].extra_emails, ['manual@example.org', 'p4@gmail.example'], 'the next run removes p3 (it was not turned into a manual entry)');
    // a state file that cannot be written stops the sync before the list is touched
    teamsStore.addMembers(kurs.id, ['p5@gmail.example']);
    const listBefore = fs.readFileSync(list, 'utf8');
    await fsp.rm(stateFile);
    await fsp.mkdir(stateFile); // a directory where the record should go
    result = await make().sync();
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(list, 'utf8'), listBefore, 'the list is not changed when the record cannot be saved first');
    await fsp.rm(stateFile, { recursive: true });
    assert.equal((await make().sync()).ok, true);
    teamsStore.removeMember(kurs.id, 'p5@gmail.example');
    await make().sync();

    // a symlinked list keeps its link; the target is replaced and keeps its mode
    const real = path.join(dir, 'real-list.json');
    const link = path.join(dir, 'link-list.json');
    await fsp.writeFile(real, JSON.stringify({ routes: [{ path: '/training', extra_emails: [] }] }), { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, link);
    const linked = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: link }, stateFile: path.join(dir, 'state-link.json'), now });
    assert.equal((await linked.sync()).ok, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink stays a symlink');
    assert.deepEqual(read(real).routes[0].extra_emails, ['p4@gmail.example'], 'the real list was written');
    assert.equal(fs.statSync(real).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

    // a file that cannot be replaced (a single file mounted into a container: EBUSY) is written in place
    const mounted = path.join(dir, 'mounted-list.json');
    await fsp.writeFile(mounted, JSON.stringify({ routes: [{ path: '/training', extra_emails: ['keep@example.org'] }] }));
    const inode = fs.statSync(mounted).ino;
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === fs.realpathSync(mounted)) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return realRename(from, to);
    };
    try {
      const busy = createAccessSync({ teams: () => teamsStore, env: { ...env, ACCESS_ALLOWLIST_FILE: mounted }, stateFile: path.join(dir, 'state-busy.json'), now });
      assert.equal((await busy.sync()).ok, true);
    } finally {
      fs.renameSync = realRename;
    }
    assert.deepEqual(read(mounted).routes[0].extra_emails, ['keep@example.org', 'p4@gmail.example']);
    assert.equal(fs.statSync(mounted).ino, inode, 'the same file was written');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
  } finally {
    console.warn = warn;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testTeamsStore();
  await testRoles();
  await testFailClosed();
  await testCostIndex();
  await testBudget();
  await testBudgetAsyncJobs();
  await testAccessSync();
  await testAccessSyncRecord();
  console.log('Teams: Team-Datei, Rollen (Teilnehmer, Intern, Gast), Zugriffsregeln, Freigabe mit Teams, Kosten-Index, Budget mit Reservierungen und der Freigabelisten-Sync sind korrekt.');
  console.log('test-teams.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
