'use strict';

// Chats and workflows grouped by team (WP22), admins only: where an entry belongs (stored team, team at the time of
// creation, archived and deleted teams, removed members, no owner), the group heads and the paged items of the API,
// the confidentiality for everybody who is not an admin, the team of new chats and workflows (set by the server only),
// the local mode that must not change, the browser helpers, and the review fixes (keyboard focus across rebuilds,
// out-of-date answers of a group, list roles of the grouped workflow list, fewer rebuilds, heading of the sidebar). A private copy of the app runs in a temp directory
// (own data folders, ephemeral port, whoami stub), so no real data and not port 3111 are touched. Nothing is paid.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');
const { createTeamsStore } = require('../lib/teams');
const teamGroups = require('../lib/team-groups');

const ADMIN = 'admin@example.com';
const ADMIN2 = 'admin2@example.com'; // an admin who is a member of Kurs B
const STAFF = 'staff1@staff.example.com'; // internal, no team
const GUEST = 'alumni@gmail.example'; // no team, not internal
const P1 = 'p1@gmail.example'; // Kurs A since 2026-01-10
const P3 = 'p3@gmail.example'; // Kurs B since 2026-03-01
const PAB = 'pab@gmail.example'; // Kurs A since 2026-02-01, Kurs B since 2026-04-01
const POLD = 'pold@gmail.example'; // Alt-Kurs (archived) since 2025-06-01
const PC = 'pc@gmail.example'; // Kurs C
const PLEFT = 'pleft@gmail.example'; // was in Kurs A, removed

const at = (day) => `${day}T10:00:00.000Z`;
const member = (email, addedAt) => ({ email, addedAt: at(addedAt), budgetStart: at(addedAt), budgetOverrideUsd: null });
const team = (id, name, members, extra = {}) => ({ id, name, description: '', budgetUsd: 5, createdAt: at('2025-01-01'), createdBy: ADMIN, archived: false, members, ...extra });

const TEAMS = [
  team('tm-kursa', 'Kurs A', [member(P1, '2026-01-10'), member(PAB, '2026-02-01')]),
  team('tm-kursb', 'Kurs B', [member(P3, '2026-03-01'), member(PAB, '2026-04-01'), member(ADMIN2, '2026-03-15')]),
  team('tm-kursc', 'Kurs C', [member(PC, '2026-05-01')]),
  team('tm-alt', 'Alt-Kurs', [member(POLD, '2025-06-01')], { archived: true })
];
const KNOWN = [P1, P3, PAB, POLD, PC, PLEFT, ADMIN2];

async function main() {
  testRules();
  await testApi();
  await testPerformance();
  await testLocalMode();
  testClientHelpers();
  testFocus();
  await testGroupPages();
  await testChatListClient();
  await testChatListManyGroups();
  testWorkflowListClient();
  testSources();
  console.log('Team-Gruppen: Zuordnungsregeln, Gruppenköpfe, Seiten, Vertraulichkeit, Team neuer Einträge, Workflows, lokaler Modus und Browser-Helfer sind korrekt.');
}

/* ---------- where an entry belongs ---------- */

function testRules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-team-groups-'));
  try {
    const file = path.join(dir, 'teams.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, teams: TEAMS, known: KNOWN }));
    const store = createTeamsStore({ file });
    const resolver = teamGroups.createResolver(store);
    const idOf = (entry) => resolver.teamIdOf(entry);

    // the team at the time of creation: the latest membership that is not later than the entry
    assert.equal(idOf({ owner: P1, createdAt: at('2026-01-20') }), 'tm-kursa');
    assert.equal(idOf({ owner: PAB, createdAt: at('2026-03-01') }), 'tm-kursa', 'two teams: the one joined before the entry');
    assert.equal(idOf({ owner: PAB, createdAt: at('2026-05-01') }), 'tm-kursb', 'two teams: the one joined last');
    assert.equal(idOf({ owner: PAB, createdAt: at('2026-04-01') }), 'tm-kursb', 'joined at the very moment counts');
    // no membership before the entry: the earliest later one
    assert.equal(idOf({ owner: P1, createdAt: at('2026-01-01') }), 'tm-kursa');
    assert.equal(idOf({ owner: PAB, createdAt: at('2025-01-01') }), 'tm-kursa');
    // an archived team counts
    assert.equal(idOf({ owner: POLD, createdAt: at('2025-07-01') }), 'tm-alt');
    assert.equal(idOf({ owner: POLD, createdAt: at('2027-01-01') }), 'tm-alt');
    // no owner, an owner without team, a guest, a person who was removed: internal
    assert.equal(idOf({ owner: null, createdAt: at('2026-01-20') }), null);
    assert.equal(idOf({ createdAt: at('2026-01-20') }), null);
    assert.equal(idOf({ owner: STAFF, createdAt: at('2026-01-20') }), null);
    assert.equal(idOf({ owner: PLEFT, createdAt: at('2026-01-20') }), null, 'a removed member loses the derived assignment');
    assert.equal(idOf({ owner: 'kein-mensch', createdAt: at('2026-01-20') }), null);
    assert.equal(idOf({ owner: P1, createdAt: 'gestern' }), null, 'no usable date: no guess');
    assert.equal(idOf({ owner: P1 }), null);
    // a stored team wins, even over the membership; a deleted team sends the entry to internal, it is not derived again
    assert.equal(idOf({ owner: P1, createdAt: at('2026-01-20'), teamId: 'tm-kursb' }), 'tm-kursb');
    assert.equal(idOf({ owner: STAFF, createdAt: at('2026-01-20'), teamId: 'tm-kursc' }), 'tm-kursc', 'also for an owner who is in no team (any more)');
    assert.equal(idOf({ owner: P1, createdAt: at('2026-01-20'), teamId: 'tm-geloescht' }), null);
    assert.equal(idOf({ owner: P1, createdAt: at('2026-01-20'), teamId: '../x' }), 'tm-kursa', 'a malformed id is not a stored team');
    assert.equal(idOf({ owner: null, teamId: 'tm-alt' }), 'tm-alt', 'an entry in an archived team stays there');

    // the team as an entry carries it
    assert.deepEqual(resolver.ref('tm-alt'), { id: 'tm-alt', name: 'Alt-Kurs', archived: true });
    assert.equal(resolver.ref(null), null);
    assert.equal(resolver.ref('tm-geloescht'), null);

    // the team of something new: the active team joined last
    const viewer = (email) => ({ active: true, email, admin: false });
    assert.equal(teamGroups.teamForNew(viewer(P1), store), 'tm-kursa');
    assert.equal(teamGroups.teamForNew(viewer(PAB), store), 'tm-kursb', 'several teams: the one joined last');
    assert.equal(teamGroups.teamForNew({ ...viewer(ADMIN2), admin: true }, store), 'tm-kursb', 'an admin in a team as well');
    assert.equal(teamGroups.teamForNew(viewer(POLD), store), null, 'an archived team is no active team');
    assert.equal(teamGroups.teamForNew(viewer(STAFF), store), null);
    assert.equal(teamGroups.teamForNew(viewer(PLEFT), store), null);
    assert.equal(teamGroups.teamForNew({ active: true, email: null, admin: false }, store), null);
    assert.equal(teamGroups.teamForNew({ active: false, email: P1, admin: true }, store), null, 'local mode');
    assert.equal(teamGroups.teamForNew(null, store), null);

    // only admins of the active user management
    assert.equal(teamGroups.isAllowed({ active: true, admin: true }), true);
    for (const other of [{ active: true, admin: false }, { active: false, admin: true }, null, undefined]) assert.equal(teamGroups.isAllowed(other), false);

    // the groups: active teams by their latest activity, then archived, internal last; empty teams are not listed
    const rows = [
      { teamId: 'tm-kursa', updatedAt: at('2026-06-01'), owner: P1 },
      { teamId: 'tm-kursa', updatedAt: at('2026-06-02'), owner: PAB },
      { teamId: 'tm-kursb', updatedAt: at('2026-07-01'), owner: P3 },
      { teamId: 'tm-alt', updatedAt: at('2026-09-01'), owner: POLD },
      { teamId: null, updatedAt: at('2026-10-01'), owner: STAFF },
      { teamId: null, updatedAt: at('2026-08-01'), owner: STAFF },
      { teamId: null, updatedAt: at('2026-08-02'), owner: null }
    ];
    const groups = teamGroups.buildGroups(rows, resolver);
    assert.deepEqual(groups.map((group) => group.id), ['tm-kursb', 'tm-kursa', 'tm-alt', 'none']);
    assert.deepEqual(groups[0], { id: 'tm-kursb', name: 'Kurs B', archived: false, internal: false, count: 1, people: 3, lastActivity: at('2026-07-01') });
    assert.equal(groups[1].count, 2);
    assert.equal(groups[1].people, 2, 'people = members of the team');
    assert.equal(groups[2].archived, true);
    assert.deepEqual(groups[3], { id: 'none', name: null, archived: false, internal: true, count: 3, people: 1, lastActivity: at('2026-10-01') });
    assert.deepEqual(teamGroups.buildGroups([], resolver), []);
    // a deleted team is "internal": the caller resolves first, so a row never names a missing team
    assert.equal(teamGroups.buildGroups([{ teamId: 'tm-geloescht', updatedAt: at('2026-01-01'), owner: null }], resolver)[0].name, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- API ---------- */

function writeSession(root, { id, owner = null, createdAt, updatedAt = createdAt, teamId, kind, title = id }) {
  const session = {
    id,
    title,
    folder: null,
    createdAt,
    updatedAt,
    messages: [],
    jobs: [],
    contextBrains: [],
    contextFiles: [],
    role: null,
    brandings: [],
    ...(kind ? { kind } : {}),
    ...(owner ? { owner, shareMode: 'private', sharedWith: [] } : {}),
    ...(teamId ? { teamId } : {})
  };
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', `${id}.json`), JSON.stringify(session));
}

function writeTeams(root, teams, known) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'teams.json'), JSON.stringify({ version: 1, teams, known }));
}

async function testApi() {
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: `${ADMIN},${ADMIN2}`,
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: ''
    }
  });
  writeTeams(iso.root, TEAMS, KNOWN);
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  const store = iso.load('lib/store');
  const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
  const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(iso.root, 'projects', `${id}.json`), 'utf8'));
  const workflowOnDisk = (id) => JSON.parse(fs.readFileSync(path.join(iso.root, 'data', 'workflows', id, 'workflow.json'), 'utf8'));
  try {
    /* data: old chats without a stored team, in every situation */
    const old = [
      { id: 'c-p1-nach-beitritt', owner: P1, createdAt: at('2026-01-20'), updatedAt: at('2026-02-01'), team: 'tm-kursa' },
      { id: 'c-p1-vor-beitritt', owner: P1, createdAt: at('2026-01-01'), updatedAt: at('2026-02-02'), team: 'tm-kursa' },
      { id: 'c-pab-maerz', owner: PAB, createdAt: at('2026-03-01'), updatedAt: at('2026-03-05'), team: 'tm-kursa' },
      { id: 'c-pab-mai', owner: PAB, createdAt: at('2026-05-01'), updatedAt: at('2026-05-05'), team: 'tm-kursb' },
      { id: 'c-p3', owner: P3, createdAt: at('2026-03-10'), updatedAt: at('2026-03-12'), team: 'tm-kursb' },
      { id: 'c-pold', owner: POLD, createdAt: at('2025-07-01'), updatedAt: at('2025-07-02'), team: 'tm-alt' },
      { id: 'c-staff', owner: STAFF, createdAt: at('2026-02-01'), updatedAt: at('2026-02-03'), team: null },
      { id: 'c-ohne-besitzer', createdAt: at('2025-01-01'), updatedAt: at('2025-01-02'), team: null },
      { id: 'c-gast', owner: GUEST, createdAt: at('2026-02-01'), updatedAt: at('2026-02-04'), team: null },
      { id: 'c-entfernt', owner: PLEFT, createdAt: at('2026-01-20'), updatedAt: at('2026-01-21'), team: null },
      { id: 'c-gespeichert', owner: P1, createdAt: at('2026-01-20'), updatedAt: at('2026-02-05'), teamId: 'tm-kursb', team: 'tm-kursb' },
      { id: 'c-geloescht', owner: P1, createdAt: at('2026-01-20'), updatedAt: at('2026-02-06'), teamId: 'tm-geloescht', team: null }
    ];
    for (const entry of old) writeSession(iso.root, entry);
    writeSession(iso.root, { id: 'wf-backing', owner: P1, createdAt: at('2026-01-20'), kind: 'workflow' }); // never a chat

    /* admin: heads */
    const heads = await api('/api/sessions/team-groups', { as: ADMIN });
    assert.equal(heads.status, 200, heads.text);
    assert.equal(heads.body.total, old.length, 'the backing session of a workflow is not a chat');
    assert.deepEqual(heads.body.groups.map((group) => group.id), ['tm-kursb', 'tm-kursa', 'tm-alt', 'none']);
    const byId = Object.fromEntries(heads.body.groups.map((group) => [group.id, group]));
    assert.equal(byId['tm-kursb'].count, 3, 'c-pab-mai, c-p3 and the stored one');
    assert.equal(byId['tm-kursa'].count, 3, 'c-p1-nach-beitritt, c-p1-vor-beitritt, c-pab-maerz');
    assert.equal(byId['tm-alt'].count, 1);
    assert.equal(byId.none.count, 5, 'staff, no owner, guest, removed member, deleted team');
    assert.equal(byId['tm-kursb'].name, 'Kurs B');
    assert.equal(byId['tm-kursb'].people, 3);
    assert.equal(byId['tm-alt'].archived, true);
    assert.equal(byId.none.internal, true);
    assert.equal(byId.none.name, null);
    assert.equal(byId['tm-kursb'].lastActivity, at('2026-05-05'));
    assert.equal(byId.none.lastActivity, at('2026-02-06'));
    assert.equal(heads.body.groups.some((group) => group.id === 'tm-kursc'), false, 'a team without chats is not listed');
    assert.equal(heads.headers.get('cache-control'), 'no-store');

    /* admin: the chats of a group, paged, with their team */
    const ids = async (query, as = ADMIN) => (await api(`/api/sessions?${query}`, { as })).body.sessions.map((entry) => entry.id).sort();
    assert.deepEqual(await ids('team=tm-kursa&limit=100'), ['c-p1-nach-beitritt', 'c-p1-vor-beitritt', 'c-pab-maerz']);
    assert.deepEqual(await ids('team=tm-kursb&limit=100'), ['c-gespeichert', 'c-p3', 'c-pab-mai']);
    assert.deepEqual(await ids('team=tm-alt&limit=100'), ['c-pold']);
    assert.deepEqual(await ids('team=none&limit=100'), ['c-entfernt', 'c-geloescht', 'c-gast', 'c-ohne-besitzer', 'c-staff'].sort());
    assert.deepEqual(await ids('team=tm-kursc&limit=100'), [], 'a team without chats');
    assert.deepEqual(await ids('team=tm-geloescht&limit=100'), [], 'a deleted team has no group');
    const page = (await api('/api/sessions?team=tm-kursa&limit=2&offset=0', { as: ADMIN })).body;
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.sessions[0].team, { id: 'tm-kursa', name: 'Kurs A', archived: false });
    assert.equal(page.sessions[0].owner !== undefined, true, 'owner and rights as in the normal list');
    assert.deepEqual((await api('/api/sessions?team=none&limit=100', { as: ADMIN })).body.sessions.map((entry) => entry.team), [null, null, null, null, null]);
    assert.equal((await api('/api/sessions?team=bad%2Fid', { as: ADMIN })).status, 400);
    assert.equal((await api('/api/sessions?team=bad%2Fid', { as: ADMIN })).body.code, 'INVALID_TEAM');

    /* without the options nothing changes for the admin either */
    const plain = (await api('/api/sessions?limit=100', { as: ADMIN })).body;
    assert.equal(plain.total, old.length);
    assert.equal(plain.sessions.some((entry) => 'team' in entry), false);

    /* search: a flat list, every hit with its team (admins only) */
    await store.mutateSession('c-p3', (session) => {
      session.messages.push({ role: 'user', content: 'zebrastreifenkampagne' });
    }, { touchUpdatedAt: false });
    await store.mutateSession('c-staff', (session) => {
      session.messages.push({ role: 'user', content: 'zebrastreifenkampagne intern' });
    }, { touchUpdatedAt: false });
    const found = (await api('/api/sessions?q=zebrastreifenkampagne&teams=1', { as: ADMIN })).body;
    assert.equal(found.total, 2);
    const teamOfHit = Object.fromEntries(found.sessions.map((entry) => [entry.id, entry.team && entry.team.name]));
    assert.deepEqual(teamOfHit, { 'c-p3': 'Kurs B', 'c-staff': null });
    assert.equal((await api('/api/sessions?q=zebrastreifenkampagne', { as: ADMIN })).body.sessions.some((entry) => 'team' in entry), false);

    /* everybody else: no team information, a refusal for the group routes */
    for (const email of [STAFF, P1, PAB, GUEST]) {
      const label = email;
      const heads403 = await api('/api/sessions/team-groups', { as: email });
      assert.equal(heads403.status, 403, `team-groups as ${label}`);
      assert.equal(JSON.stringify(heads403.body).includes('Kurs'), false);
      const team403 = await api('/api/sessions?team=tm-kursa', { as: email });
      assert.equal(team403.status, 403, `?team= as ${label}`);
      assert.equal(JSON.stringify(team403.body).includes('Kurs'), false);
      const flat = await api('/api/sessions?teams=1&limit=100', { as: email });
      assert.equal(flat.status, 200);
      assert.equal(flat.text.includes('tm-'), false, `no team id in the list for ${label}`);
      assert.equal(flat.text.includes('Kurs'), false);
      assert.equal(flat.body.sessions.some((entry) => 'team' in entry || 'teamId' in entry), false);
    }
    assert.equal((await api('/api/sessions/team-groups')).status, 401, 'anonymous while teams exist: login not confirmed');
    assert.equal((await api('/api/sessions?team=none')).status, 401);
    // P1's own chats carry no team information, neither in the list nor in the detail
    const own = (await api('/api/sessions?limit=100', { as: P1 })).body.sessions.map((entry) => entry.id).sort();
    assert.deepEqual(own, ['c-geloescht', 'c-gespeichert', 'c-p1-nach-beitritt', 'c-p1-vor-beitritt']);
    const detail = await api('/api/sessions/c-gespeichert', { as: P1 });
    assert.equal(detail.status, 200);
    assert.equal(detail.text.includes('tm-kursb'), false, 'the stored team does not reach the detail');
    assert.equal('teamId' in detail.body.session || 'team' in detail.body.session, false);
    assert.equal((await api('/api/sessions/c-gespeichert', { as: ADMIN })).text.includes('tm-kursb'), false, 'not even for admins');

    /* a group of 45 chats is reachable page by page */
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    for (let index = 0; index < 45; index += 1) {
      const stamp = new Date(base + index * 60000).toISOString();
      writeSession(iso.root, { id: `c-kursc-${String(index).padStart(2, '0')}`, owner: PC, createdAt: stamp, updatedAt: stamp });
    }
    const afterBulk = (await api('/api/sessions/team-groups', { as: ADMIN })).body.groups;
    assert.equal(afterBulk.find((group) => group.id === 'tm-kursc').count, 45);
    assert.equal(afterBulk[0].id, 'tm-kursc', 'the newest activity comes first');
    const seen = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const pageData = (await api(`/api/sessions?team=tm-kursc&limit=20&offset=${offset}`, { as: ADMIN })).body;
      assert.equal(pageData.total, 45);
      seen.push(...pageData.sessions.map((entry) => entry.id));
      pages += 1;
      assert.equal(pageData.hasMore, offset + pageData.sessions.length < 45);
      if (!pageData.hasMore) break;
      offset += pageData.sessions.length;
      assert.ok(pages < 5);
    }
    assert.equal(pages, 3, '20 + 20 + 5');
    assert.equal(new Set(seen).size, 45, 'no chat twice, none missing');
    assert.equal(seen[0], 'c-kursc-44', 'newest first');
    // 100 per page at most, as for every list
    assert.equal((await api('/api/sessions?team=tm-kursc&limit=500', { as: ADMIN })).body.sessions.length, 45);

    /* new chats: the server stores the creator's team, a client cannot */
    const create = async (email, json = {}) => {
      const response = await api('/api/sessions', { method: 'POST', as: email, json });
      assert.equal(response.status, 201, response.text);
      assert.equal('teamId' in response.body.session || 'team' in response.body.session, false, 'the answer carries no team');
      return response.body.session.id;
    };
    assert.equal(onDisk(await create(P1)).teamId, 'tm-kursa');
    assert.equal(onDisk(await create(PAB)).teamId, 'tm-kursb', 'several teams: the one joined last');
    assert.equal(onDisk(await create(ADMIN2)).teamId, 'tm-kursb', 'an admin who is a member of a team');
    for (const email of [ADMIN, STAFF, GUEST, POLD]) assert.equal('teamId' in onDisk(await create(email)), false, `${email}: no active team, no team`);
    const forged = await create(P1, { teamId: 'tm-kursb', team: 'tm-kursb', owner: STAFF });
    assert.equal(onDisk(forged).teamId, 'tm-kursa', 'POST cannot set the team');
    assert.equal(onDisk(forged).owner, P1);
    const patched = await api(`/api/sessions/${forged}`, { method: 'PATCH', as: P1, json: { title: 'Neu', teamId: 'tm-kursc' } });
    assert.equal(patched.status, 200);
    assert.equal(onDisk(forged).teamId, 'tm-kursa', 'PATCH cannot change the team');
    const onlyTeam = await api(`/api/sessions/${forged}`, { method: 'PATCH', as: P1, json: { teamId: 'tm-kursc' } });
    assert.equal(onlyTeam.status, 400, 'there is nothing else to change');
    assert.equal((await api(`/api/sessions/${forged}`, { method: 'PATCH', as: ADMIN, json: { title: 'Admin', teamId: 'tm-kursc' } })).status, 200);
    assert.equal(onDisk(forged).teamId, 'tm-kursa', 'not even an admin can');
    const shared = await api(`/api/sessions/${forged}/share`, { method: 'PATCH', as: P1, json: { shareMode: 'teams', sharedTeams: ['tm-kursa'], teamId: 'tm-kursc' } });
    assert.equal(shared.status, 200, shared.text);
    assert.equal(onDisk(forged).teamId, 'tm-kursa', 'sharing keeps the team');
    const moved = await api(`/api/sessions/${forged}`, { method: 'PATCH', as: P1, json: { folder: 'Projekt X' } });
    assert.equal(moved.status, 200);
    assert.equal(onDisk(forged).teamId, 'tm-kursa', 'moving to a project keeps the team');
    // the new chat shows up in its group at once
    assert.ok((await ids('team=tm-kursa&limit=100')).includes(forged));
    // once stored, the team stays with the chat when the person leaves the team
    iso.load('lib/teams').removeMember('tm-kursa', P1);
    assert.ok((await ids('team=tm-kursa&limit=100')).includes(forged), 'a stored team survives the removal');
    assert.equal((await ids('team=tm-kursa&limit=100')).includes('c-p1-nach-beitritt'), false, 'the derived assignment falls away');
    assert.ok((await ids('team=none&limit=100')).includes('c-p1-nach-beitritt'));
    iso.load('lib/teams').addMembers('tm-kursa', [P1]);

    /* deleting a team: its chats go to internal; archiving keeps the group, marked archived */
    iso.load('lib/teams').updateTeam('tm-kursb', { archived: true });
    const archivedHeads = (await api('/api/sessions/team-groups', { as: ADMIN })).body.groups;
    assert.equal(archivedHeads.find((group) => group.id === 'tm-kursb').archived, true);
    assert.ok(archivedHeads.findIndex((group) => group.id === 'tm-kursb') > archivedHeads.findIndex((group) => group.id === 'tm-kursa'), 'archived after the active ones');
    assert.equal(archivedHeads[archivedHeads.length - 1].id, 'none');
    iso.load('lib/teams').updateTeam('tm-kursb', { archived: false });

    /* deleting a team through the real route: stored and derived entries move to internal */
    const PW = 'pw@gmail.example';
    const gone = iso.load('lib/teams').createTeam({ name: 'Wegwerf', createdBy: ADMIN });
    iso.load('lib/teams').addMembers(gone.id, [PW]);
    writeSession(iso.root, { id: 'c-wegwerf-abgeleitet', owner: PW, createdAt: new Date(Date.now() + 60000).toISOString() });
    const storedId = await create(PW);
    assert.equal(onDisk(storedId).teamId, gone.id);
    const beforeDelete = (await api('/api/sessions/team-groups', { as: ADMIN })).body.groups;
    assert.equal(beforeDelete.find((group) => group.id === gone.id).count, 2);
    const noneBefore = beforeDelete.find((group) => group.id === 'none').count;
    const removed = await api(`/api/teams/${gone.id}`, { method: 'DELETE', as: ADMIN });
    assert.equal(removed.status, 200, removed.text);
    const afterDelete = (await api('/api/sessions/team-groups', { as: ADMIN })).body.groups;
    assert.equal(afterDelete.some((group) => group.id === gone.id), false, 'the group is gone with the team');
    assert.equal(afterDelete.find((group) => group.id === 'none').count, noneBefore + 2, 'stored and derived entry are internal now');
    assert.ok((await ids('team=none&limit=100')).includes(storedId));
    assert.ok((await ids('team=none&limit=100')).includes('c-wegwerf-abgeleitet'));
    assert.deepEqual(await ids(`team=${gone.id}&limit=100`), []);
    assert.equal(onDisk(storedId).teamId, gone.id, 'the file keeps the old id; only the reading changes');

    /* workflows */
    await testWorkflows({ iso, api, wfStore, workflowOnDisk });
  } finally {
    await iso.cleanup();
  }
}

async function testWorkflows({ iso, api, wfStore, workflowOnDisk }) {
  const exported = await (async () => {
    const probe = await api('/api/workflows', { method: 'POST', as: ADMIN, json: { name: 'Probe' } });
    assert.equal(probe.status, 201, probe.text);
    const doc = (await api(`/api/workflows/${probe.body.workflow.id}/export`, { as: ADMIN })).body;
    await api(`/api/workflows/${probe.body.workflow.id}`, { method: 'DELETE', as: ADMIN });
    return doc;
  })();

  // created with a team: the team of the creator, stored by the server
  const created = await api('/api/workflows', { method: 'POST', as: P1, json: { name: 'Flow P1', teamId: 'tm-kursb', team: 'tm-kursb' } });
  assert.equal(created.status, 201, created.text);
  const flowP1 = created.body.workflow.id;
  assert.equal(workflowOnDisk(flowP1).teamId, 'tm-kursa', 'POST cannot set the team');
  assert.equal('teamId' in created.body.workflow || 'team' in created.body.workflow, false, 'the answer carries no team');
  const flowPab = (await api('/api/workflows', { method: 'POST', as: PAB, json: { name: 'Flow PAB' } })).body.workflow.id;
  assert.equal(workflowOnDisk(flowPab).teamId, 'tm-kursb', 'several teams: the one joined last');
  const flowStaff = (await api('/api/workflows', { method: 'POST', as: STAFF, json: { name: 'Flow Staff' } })).body.workflow.id;
  assert.equal('teamId' in workflowOnDisk(flowStaff), false, 'no team, no teamId');

  // the autosave cannot set it
  const saved = await api(`/api/workflows/${flowP1}`, { method: 'PUT', as: P1, json: { baseRev: 1, graph: { nodes: [], edges: [] }, teamId: 'tm-kursc', team: 'tm-kursc' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(workflowOnDisk(flowP1).teamId, 'tm-kursa', 'PUT cannot change the team');
  assert.equal((await api(`/api/workflows/${flowP1}`, { method: 'PATCH', as: P1, json: { name: 'Umbenannt', teamId: 'tm-kursc' } })).status, 200);
  assert.equal(workflowOnDisk(flowP1).teamId, 'tm-kursa', 'PATCH cannot change the team');
  assert.equal((await api(`/api/workflows/${flowP1}/share`, { method: 'PATCH', as: P1, json: { shareMode: 'teams', sharedTeams: ['tm-kursa'], teamId: 'tm-kursc' } })).status, 200);
  assert.equal(workflowOnDisk(flowP1).teamId, 'tm-kursa', 'sharing keeps the team');

  // import: a team in the file is discarded, the importer's team counts (also body fields)
  const imported = await api('/api/workflows/import', { method: 'POST', as: STAFF, json: { document: { ...exported, teamId: 'tm-kursb', team: 'tm-kursb' }, teamId: 'tm-kursb' } });
  assert.equal(imported.status, 201, imported.text);
  assert.equal('teamId' in workflowOnDisk(imported.body.workflow.id), false, 'the file carries a team, the importer has none');
  const importedP3 = await api('/api/workflows/import', { method: 'POST', as: P3, json: { document: { ...exported, teamId: 'tm-kursa' } } });
  assert.equal(importedP3.status, 201, importedP3.text);
  assert.equal(workflowOnDisk(importedP3.body.workflow.id).teamId, 'tm-kursb', 'the importer\'s team, not the file\'s');
  const viaDocument = await api('/api/workflows', { method: 'POST', as: STAFF, json: { document: { ...exported, teamId: 'tm-kursb' } } });
  assert.equal(viaDocument.status, 201, viaDocument.text);
  assert.equal('teamId' in workflowOnDisk(viaDocument.body.workflow.id), false);

  // duplicate: the team of the person who duplicates
  const duplicate = await api(`/api/workflows/${flowP1}/duplicate`, { method: 'POST', as: ADMIN2, json: {} });
  assert.equal(duplicate.status, 201, duplicate.text);
  assert.equal(workflowOnDisk(duplicate.body.workflow.id).teamId, 'tm-kursb', 'ADMIN2 duplicates a workflow of Kurs A: Kurs B');
  assert.equal(workflowOnDisk(duplicate.body.workflow.id).owner, ADMIN2);
  const duplicateByAdmin = await api(`/api/workflows/${flowP1}/duplicate`, { method: 'POST', as: ADMIN, json: {} });
  assert.equal('teamId' in workflowOnDisk(duplicateByAdmin.body.workflow.id), false, 'an admin without team: no team');

  // old workflows without a team: derived from owner and creation date (workflow.json createdAt)
  const legacy = async (owner, createdAt, extra = {}) => {
    const workflow = (await wfStore.createWorkflow({ name: `Alt ${owner}`, owner })).workflow;
    const file = path.join(iso.root, 'data', 'workflows', workflow.id, 'workflow.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, createdAt, ...extra }));
    return workflow.id;
  };
  const oldPab = await legacy(PAB, at('2026-03-01'));
  const oldPold = await legacy(POLD, at('2025-07-01'));
  const oldGone = await legacy(P3, at('2026-03-10'), { teamId: 'tm-geloescht' });
  const oldNone = (await wfStore.createWorkflow({ name: 'Ohne Besitzer' })).workflow.id;

  const listed = await api('/api/workflows', { as: ADMIN });
  assert.equal(listed.status, 200);
  const teamOf = Object.fromEntries(listed.body.workflows.map((item) => [item.id, item.team]));
  assert.deepEqual(teamOf[flowP1], { id: 'tm-kursa', name: 'Kurs A', archived: false });
  assert.deepEqual(teamOf[flowPab], { id: 'tm-kursb', name: 'Kurs B', archived: false });
  assert.equal(teamOf[flowStaff], null);
  assert.equal(teamOf[oldPab].id, 'tm-kursa', 'derived: the team PAB was in at the time');
  assert.deepEqual(teamOf[oldPold], { id: 'tm-alt', name: 'Alt-Kurs', archived: true });
  assert.equal(teamOf[oldGone], null, 'a deleted stored team: internal');
  assert.equal(teamOf[oldNone], null);
  assert.ok(listed.body.workflows.every((item) => !('teamId' in item) && !('createdAt' in item)), 'no raw fields');
  const groups = listed.body.teamGroups;
  assert.ok(Array.isArray(groups));
  assert.equal(groups[groups.length - 1].id, 'none');
  assert.equal(groups.find((group) => group.id === 'tm-kursa').count, listed.body.workflows.filter((item) => item.team && item.team.id === 'tm-kursa').length);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), listed.body.workflows.length, 'every workflow is in exactly one group');
  assert.equal(groups.find((group) => group.id === 'tm-alt').archived, true);

  // everybody else: no team, no groups
  for (const email of [STAFF, P1, GUEST]) {
    const response = await api('/api/workflows', { as: email });
    assert.equal(response.status, 200);
    assert.equal('teamGroups' in response.body, false, email);
    assert.equal(response.text.includes('"teamId"'), false, `no stored team for ${email}`);
    // P1's own workflow is shared with Kurs A by choice (sharedTeams); nobody else's team shows up
    if (email !== P1) assert.equal(response.text.includes('tm-') || response.text.includes('Kurs'), false, `no team for ${email}`);
    assert.ok(response.body.workflows.every((item) => !('team' in item) && !('teamId' in item) && !('createdAt' in item)), email);
  }
  const detail = await api(`/api/workflows/${flowP1}`, { as: P1 });
  assert.equal(detail.status, 200);
  assert.equal('teamId' in detail.body.workflow || 'team' in detail.body.workflow, false);
  assert.equal((await api(`/api/workflows/${flowP1}`, { as: ADMIN })).text.includes('"teamId"'), false, 'not even in the admin detail');
}

/* ---------- 1000 chats, 20 teams ---------- */

async function testPerformance() {
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: ADMIN, OPENROUTER_API_KEY: '', ACCESS_ALLOWLIST_FILE: '', ACCESS_ALLOWLIST_ROUTE: '' } });
  const teams = [];
  const people = [];
  for (let index = 0; index < 20; index += 1) {
    const members = Array.from({ length: 5 }, (_, n) => member(`t${index}p${n}@gmail.example`, '2026-01-01'));
    people.push(...members.map((entry) => entry.email));
    teams.push(team(`tm-perf${String(index).padStart(2, '0')}`, `Team ${index}`, members));
  }
  writeTeams(iso.root, teams, people);
  await iso.listen();
  const api = iso.request;
  try {
    for (let index = 0; index < 1000; index += 1) {
      const owner = index % 25 === 0 ? null : people[index % people.length];
      const stamp = new Date(Date.parse('2026-02-01T00:00:00.000Z') + index * 1000).toISOString();
      writeSession(iso.root, { id: `p-${String(index).padStart(4, '0')}`, owner, createdAt: stamp });
    }
    const started = Date.now();
    const cold = await api('/api/sessions/team-groups', { as: ADMIN });
    const coldMs = Date.now() - started;
    assert.equal(cold.status, 200, cold.text);
    assert.equal(cold.body.total, 1000);
    assert.equal(cold.body.groups.reduce((sum, group) => sum + group.count, 0), 1000, 'every chat is in a group');
    assert.equal(cold.body.groups.filter((group) => !group.internal).length, 20);
    assert.equal(cold.body.groups.find((group) => group.internal).count, 40, 'every 25th chat has no owner');
    const warmStart = Date.now();
    const warm = await api('/api/sessions/team-groups', { as: ADMIN });
    const warmMs = Date.now() - warmStart;
    assert.deepEqual(warm.body, cold.body);
    const pageStart = Date.now();
    const page = await api('/api/sessions?team=tm-perf07&limit=20&offset=0', { as: ADMIN });
    const pageMs = Date.now() - pageStart;
    assert.equal(page.status, 200);
    assert.equal(page.body.sessions.length, 20);
    assert.ok(page.body.sessions.every((entry) => entry.team.id === 'tm-perf07'));
    // measured on a laptop: cold ~200 ms, warm ~7 ms, page ~5 ms; a tenfold step back would show here
    assert.ok(coldMs < 2000 && warmMs < 300 && pageMs < 300, `1000 chats / 20 teams: cold ${coldMs} ms, warm ${warmMs} ms, page ${pageMs} ms`);
    // what the browser does when all groups are open: one request per group at once
    const parallelStart = Date.now();
    const parallel = await Promise.all(
      [...teams.map((entry) => entry.id), 'none'].map((id) => api(`/api/sessions?team=${id}&limit=20&offset=0`, { as: ADMIN }))
    );
    const parallelMs = Date.now() - parallelStart;
    assert.equal(parallel.length, 21);
    assert.ok(parallel.every((response) => response.status === 200 && response.body.sessions.length === 20 && response.body.hasMore));
    assert.equal(parallel.reduce((sum, response) => sum + response.body.total, 0), 1000, 'the 21 groups add up to every chat');
    assert.ok(parallelMs < 2000, `21 parallel group requests: ${parallelMs} ms`);
  } finally {
    await iso.cleanup();
  }
}

/* ---------- local mode: nothing changes ---------- */

async function testLocalMode() {
  const iso = await createIsolatedApp({ active: false, env: { OPENROUTER_API_KEY: '', ADMIN_EMAILS: ADMIN, ACCESS_ALLOWLIST_FILE: '', ACCESS_ALLOWLIST_ROUTE: '' } });
  writeTeams(iso.root, TEAMS, KNOWN); // even a teams file does not switch anything on without the user management
  await iso.listen();
  const api = iso.request;
  try {
    assert.equal((await api('/api/me')).body.role, 'local');
    const heads = await api('/api/sessions/team-groups');
    assert.equal(heads.status, 400);
    assert.equal(heads.body.code, 'USER_MANAGEMENT_INACTIVE');
    assert.equal((await api('/api/sessions?team=none')).status, 400);
    const chat = await api('/api/sessions', { method: 'POST', json: {} });
    assert.equal(chat.status, 201);
    assert.deepEqual(Object.keys(chat.body.session).sort(), ['folder', 'id', 'role', 'title', 'updatedAt']);
    const file = JSON.parse(fs.readFileSync(path.join(iso.root, 'projects', `${chat.body.session.id}.json`), 'utf8'));
    assert.equal('teamId' in file || 'owner' in file, false, 'the chat file stays as it was');
    const list = (await api('/api/sessions?teams=1&limit=100')).body.sessions;
    assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'folder', 'id', 'title', 'updatedAt']);
    const flow = await api('/api/workflows', { method: 'POST', json: { name: 'Lokal' } });
    assert.equal(flow.status, 201);
    assert.equal('teamId' in JSON.parse(fs.readFileSync(path.join(iso.root, 'data', 'workflows', flow.body.workflow.id, 'workflow.json'), 'utf8')), false);
    const flows = (await api('/api/workflows')).body;
    assert.equal('teamGroups' in flows, false);
    assert.equal(flows.workflows.some((item) => 'team' in item || 'teamId' in item || 'createdAt' in item), false);
  } finally {
    await iso.cleanup();
  }
}

/* ---------- browser helpers ---------- */

/* A tiny DOM, enough for the lists: elements with attributes, dataset, children, listeners, focus and a few selectors. */
class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.value = '';
    this._text = '';
    const element = this;
    this.classList = {
      add: (...names) => { element.className = [...new Set(`${element.className} ${names.join(' ')}`.trim().split(/\s+/))].join(' '); },
      remove: (...names) => { element.className = element.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => { if (force === undefined ? !element.classList.contains(name) : force) element.classList.add(name); else element.classList.remove(name); },
      contains: (name) => element.className.split(/\s+/).includes(name)
    };
  }

  set textContent(value) { this.children.forEach((child) => { child.parent = null; }); this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this, stopPropagation() {}, preventDefault() {} }); }
  contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  all(predicate, out = []) { if (predicate(this)) out.push(this); for (const child of this.children) if (child.all) child.all(predicate, out); return out; }
  querySelectorAll(selector) {
    if (selector === '[data-focus-key]') return this.all((node) => node.dataset && node.dataset.focusKey !== undefined);
    throw new Error(`selector not supported: ${selector}`);
  }
  hasClass(name) { return this.classList.contains(name); }
}

function createFakeDocument() {
  const doc = {
    documentElement: { lang: '' },
    activeElement: null,
    sidebarTitle: null,
    createElement: (tag) => new FakeElement(tag, doc),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parent: null }),
    querySelectorAll: () => [],
    querySelector: (selector) => (selector === '.sidebar-head .brand-text' ? doc.sidebarTitle : null)
  };
  doc.body = doc.createElement('body');
  return doc;
}

function loadClient({ me, storage = new Map(), throwing = false }) {
  const document = createFakeDocument();
  const window = {
    document,
    setTimeout,
    navigator: { language: 'de-CH' },
    OCAccess: { isActive: () => me.active, me: () => me, badge: () => null, ownerName: () => null },
    localStorage: {
      getItem: (key) => {
        if (throwing) throw new Error('blocked');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem: (key, value) => {
        if (throwing) throw new Error('blocked');
        storage.set(key, String(value));
      }
    }
  };
  window.window = window;
  const root = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'team-groups.js'), 'utf8'), { window, document }, { filename: 'public/team-groups.js' });
  return { window, document, storage, groups: window.OCTeamGroups };
}

function testClientHelpers() {
  const admin = { active: true, isAdmin: true };
  const user = { active: true, isAdmin: false };
  const local = { active: false, isAdmin: true };

  // the switch exists for admins of the user management only
  assert.equal(loadClient({ me: admin }).groups.available(), true);
  assert.equal(loadClient({ me: user }).groups.available(), false);
  assert.equal(loadClient({ me: local }).groups.available(), false, 'local mode: no switch');
  // "Projekte" is the default; the choice is remembered per view; only for admins
  const first = loadClient({ me: admin });
  assert.equal(first.groups.mode('chats'), 'projects');
  first.groups.setMode('chats', 'teams');
  assert.equal(first.groups.mode('chats'), 'teams');
  assert.equal(first.groups.mode('workflows'), 'projects', 'each view has its own choice');
  assert.equal(loadClient({ me: admin, storage: first.storage }).groups.mode('chats'), 'teams', 'remembered by the browser');
  assert.equal(loadClient({ me: user, storage: first.storage }).groups.mode('chats'), 'projects', 'a remembered choice means nothing for others');
  assert.equal(loadClient({ me: local, storage: first.storage }).groups.mode('chats'), 'projects');
  first.groups.setMode('chats', 'bogus');
  assert.equal(first.groups.mode('chats'), 'teams', 'unknown modes are ignored');
  // without a usable storage everything still works
  const blocked = loadClient({ me: admin, throwing: true });
  assert.equal(blocked.groups.mode('chats'), 'projects');
  blocked.groups.setMode('chats', 'teams');
  assert.equal(blocked.groups.mode('chats'), 'teams', 'kept in memory for this visit');
  blocked.groups.setOpen('chats', 'tm-a', false);
  assert.equal(blocked.groups.isOpen('chats', { id: 'tm-a', archived: false }), false);

  // open and closed: active groups open by default, archived ones closed, the choice is remembered
  const groups = loadClient({ me: admin }).groups;
  assert.equal(groups.isOpen('chats', { id: 'tm-a', archived: false }), true);
  assert.equal(groups.isOpen('chats', { id: 'none', archived: false }), true);
  assert.equal(groups.isOpen('chats', { id: 'tm-old', archived: true }), false);
  groups.setOpen('chats', 'tm-a', false);
  groups.setOpen('chats', 'tm-old', true);
  assert.equal(groups.isOpen('chats', { id: 'tm-a', archived: false }), false);
  assert.equal(groups.isOpen('chats', { id: 'tm-old', archived: true }), true);
  assert.equal(groups.isOpen('workflows', { id: 'tm-a', archived: false }), true, 'per view');

  // names: the owner without a person list is the part before the @, long names are cut
  assert.equal(groups.ownerLabel('anna.muster@example.com').text, 'anna.muster');
  assert.equal(groups.ownerLabel('anna.muster@example.com').title, 'anna.muster@example.com');
  assert.equal(groups.ownerLabel(null), null);
  assert.equal(groups.ownerLabel('x'.repeat(60) + '@example.com').text.length, 24);
  assert.ok(groups.ownerLabel('x'.repeat(60) + '@example.com').text.endsWith('…'));
  // header texts in all languages, plural included
  const { window } = loadClient({ me: admin });
  for (const lang of ['de', 'en', 'es']) {
    window.setLang(lang);
    assert.ok(window.OCTeamGroups.label({ internal: true }).length > 0);
    assert.equal(window.OCTeamGroups.label({ internal: false, name: 'Kurs A' }), 'Kurs A');
    assert.match(window.OCTeamGroups.counts({ count: 1, people: 1 }, 'chats'), /1/);
    assert.match(window.OCTeamGroups.counts({ count: 12, people: 3 }, 'workflows'), /12/);
  }
  window.setLang('de');
  assert.notEqual(window.OCTeamGroups.counts({ count: 1, people: 1 }, 'chats'), window.OCTeamGroups.counts({ count: 2, people: 1 }, 'chats'));
}

/* ---------- keyboard focus across a rebuilt list (review: focus was lost after Enter and "load more") ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const ADMIN_VIEW = { active: true, isAdmin: true };

function testFocus() {
  const { groups, document } = loadClient({ me: ADMIN_VIEW });
  const root = document.createElement('div');
  const outside = document.createElement('input');
  document.body.append(root, outside);
  const build = (keys) => {
    root.textContent = '';
    for (const key of keys) {
      const node = document.createElement('div');
      node.dataset.focusKey = key;
      if (key.startsWith('more:')) node.dataset.focusFallback = `team:${key.slice(5)}`;
      root.appendChild(node);
    }
  };
  const nodeOf = (key) => root.querySelectorAll('[data-focus-key]').find((node) => node.dataset.focusKey === key);

  // a head keeps the focus when the list is built anew
  build(['team:a', 'team:b']);
  const before = nodeOf('team:b');
  before.focus();
  const returned = groups.preserveFocus(root, () => {
    build(['team:a', 'team:b']);
    return 'built';
  });
  assert.equal(returned, 'built');
  assert.notEqual(nodeOf('team:b'), before, 'a new element');
  assert.equal(document.activeElement, nodeOf('team:b'), 'the focus is back on the head with the same key');

  // "load more": the button is there again, or - when the last page came - the head of its group takes the focus
  build(['team:a', 'more:a']);
  nodeOf('more:a').focus();
  groups.preserveFocus(root, () => build(['team:a', 'more:a']));
  assert.equal(document.activeElement.dataset.focusKey, 'more:a');
  groups.preserveFocus(root, () => build(['team:a']));
  assert.equal(document.activeElement, nodeOf('team:a'), 'the button is gone: the head of the group');

  // focus outside the list (the search field) and no focus at all stay as they are
  outside.focus();
  groups.preserveFocus(root, () => build(['team:a']));
  assert.equal(document.activeElement, outside);
  document.activeElement = null;
  groups.preserveFocus(root, () => build(['team:a']));
  assert.equal(document.activeElement, null, 'a rebuild never takes the focus by itself');

  // the heading of the sidebar
  assert.equal(groups.sidebarTitleKey('chats'), 'sidebar.projects');
  groups.setMode('chats', 'teams');
  assert.equal(groups.sidebarTitleKey('chats'), 'teamGroups.sidebarTitle');
  assert.equal(groups.sidebarTitleKey('workflows'), 'sidebar.projects', 'per view');
}

/* ---------- the chats of a group: out-of-date answers, rebuilds ---------- */

async function testGroupPages() {
  const { groups } = loadClient({ me: ADMIN_VIEW });
  const calls = [];
  const fetchPage = (id, options) => {
    const request = { id, ...options, ...deferred() };
    calls.push(request);
    return request.promise;
  };
  let changes = 0;
  const pages = groups.createGroupPages({ fetchPage, pageSize: 20, onChange: () => { changes += 1; } });
  const chats = (...ids) => ids.map((id) => ({ id }));
  const idsOf = (id) => pages.entry(id).sessions.map((session) => session.id);

  // a normal read
  let reading = pages.load('g');
  assert.equal(pages.entry('g').loading, true);
  calls[0].resolve({ sessions: chats('a', 'gone'), total: 2 });
  await reading;
  assert.deepEqual(idsOf('g'), ['a', 'gone']);
  assert.equal(pages.entry('g').loaded, true);
  assert.equal(changes, 1);
  assert.equal(calls[0].limit, 20);

  // a read that is already running is not started twice
  pages.invalidate(['g']);
  reading = pages.load('g');
  const same = pages.load('g');
  assert.equal(calls.length, 2, 'one request');
  await same;

  // the heads are read again while the request runs (a chat was deleted): its answer is out of date and dropped
  pages.invalidate(['g']);
  calls[1].resolve({ sessions: chats('a', 'gone'), total: 2 });
  await reading;
  assert.equal(pages.entry('g').loaded, false, 'not marked as up to date');
  assert.equal(pages.entry('g').loading, false, 'free for the next read');
  assert.equal(changes >= 2, true, 'the list is told, so it reads the group again');
  reading = pages.load('g');
  calls[2].resolve({ sessions: chats('a'), total: 1 });
  await reading;
  assert.deepEqual(idsOf('g'), ['a'], 'the deleted chat is gone');
  assert.equal(pages.entry('g').loaded, true);

  // the same for "load more" and for an error that arrives late
  pages.invalidate(['g']);
  reading = pages.load('g', { more: true });
  assert.equal(calls[3].offset, 1);
  pages.invalidate(['g']);
  calls[3].resolve({ sessions: chats('zzz'), total: 2 });
  await reading;
  assert.deepEqual(idsOf('g'), ['a'], 'an old page is not added');
  reading = pages.load('g');
  pages.invalidate(['g']);
  calls[4].reject(new Error('late failure'));
  await reading;
  assert.equal(pages.entry('g').error, null, 'an error of an old request means nothing');
  assert.equal(pages.entry('g').loaded, false);

  // an error of the current request is shown and ends the loading
  reading = pages.load('g');
  calls[5].reject(new Error('Server down'));
  await reading;
  assert.equal(pages.entry('g').error, 'Server down');
  assert.equal(pages.entry('g').loaded, true);

  // pages: 20 + 20 + 5, nothing twice, groups that no longer exist are dropped
  reading = pages.load('h');
  calls[6].resolve({ sessions: chats(...Array.from({ length: 20 }, (_, i) => `h${i}`)), total: 45 });
  await reading;
  reading = pages.load('h', { more: true });
  assert.equal(calls[7].offset, 20);
  assert.equal(calls[7].limit, 20);
  calls[7].resolve({ sessions: chats(...Array.from({ length: 20 }, (_, i) => `h${i + 15}`)), total: 45 });
  await reading;
  assert.equal(pages.entry('h').sessions.length, 35, 'five were there already');
  pages.invalidate(['h']);
  assert.equal(pages.all().length, 1, 'g is not a group any more');

  // many groups answer at once: one rebuild instead of one per answer
  let runs = 0;
  const rebuild = groups.coalesce(() => { runs += 1; }, 20);
  for (let index = 0; index < 25; index += 1) rebuild();
  await sleep(80);
  assert.equal(runs, 1);
  rebuild();
  await sleep(80);
  assert.equal(runs, 2);
}

/* ---------- the chat list of public/app.js, cut out and run against the tiny DOM ---------- */

function createChatClient() {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const start = source.indexOf('/* ---------- team view (admins) ---------- */');
  const end = source.indexOf('async function createSession(');
  assert.ok(start > 0 && end > start, 'the team view section is in public/app.js');
  const { window, document, groups } = loadClient({ me: ADMIN_VIEW });
  groups.setMode('chats', 'teams');
  const sessionList = document.createElement('div');
  document.body.appendChild(sessionList);
  const title = document.createElement('span');
  title.dataset.i18n = 'sidebar.projects';
  title.textContent = 'Projekte';
  document.sidebarTitle = title;
  const inflight = [];
  const counters = { renders: 0 };
  const context = {
    window,
    document,
    OCTeamGroups: groups,
    SESSION_PAGE_SIZE: 20,
    t: window.t,
    state: { teamView: { groups: null, loading: false, error: null, pages: null }, sessions: [], sessionSwitch: null, sessionQuery: '' },
    el: { sessionList, sessionGrouping: document.createElement('div') },
    api: (url) => {
      const request = { url, ...deferred() };
      inflight.push(request);
      return request.promise;
    },
    setStatus: () => {},
    closeSessionMenus: () => {},
    loadSessions: async () => {},
    createSessionItem: (meta) => {
      const node = document.createElement('div');
      node.className = 'session-item';
      node.textContent = meta.id;
      return node;
    },
    renderSessions: () => {
      counters.renders += 1;
      groups.preserveFocus(sessionList, () => {
        sessionList.textContent = '';
        context.exports.renderTeamGroups();
      });
    }
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.exports = { renderTeamGroups, loadTeamGroups, syncSidebarTitle, teamPages, updateSessionCopies };`,
    context,
    { filename: 'public/app.js (team view)' }
  );
  const answer = (urlPart, body) => {
    const index = inflight.findIndex((request) => !request.done && request.url.includes(urlPart));
    assert.ok(index >= 0, `request ${urlPart} is pending`);
    inflight[index].done = true;
    inflight[index].resolve(body);
  };
  const pending = (urlPart) => inflight.filter((request) => !request.done && request.url.includes(urlPart)).length;
  const sections = () => sessionList.children.filter((node) => node.hasClass && node.hasClass('team-group'));
  const header = (id) => sessionList.all((node) => node.dataset && node.dataset.teamId === id)[0];
  const itemsOf = (id) => header(id).parent.all((node) => node.hasClass && node.hasClass('session-item')).map((node) => node.textContent);
  const moreOf = (id) => sessionList.all((node) => node.dataset && node.dataset.focusKey === `more:${id}`)[0];
  return { context, groups, document, title, inflight, counters, answer, pending, sections, header, itemsOf, moreOf, sessionList };
}

async function testChatListClient() {
  const chats = (prefix, count, from = 0) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${from + index}` }));
  const heads = (list) => ({ groups: list });
  const client = createChatClient();
  const { context, groups, document, title, answer, pending, header, itemsOf, moreOf } = client;

  // the heads
  let reading = context.exports.loadTeamGroups();
  answer('/api/sessions/team-groups', heads([
    { id: 'g1', name: 'Kurs A', count: 45, people: 3, archived: false, internal: false },
    { id: 'g2', name: 'Kurs B', count: 2, people: 1, archived: false, internal: false },
    { id: 'g3', name: 'Alt', count: 1, people: 1, archived: true, internal: false }
  ]));
  await reading;

  // the heading of the sidebar follows the view
  context.exports.syncSidebarTitle();
  assert.equal(title.dataset.i18n, 'teamGroups.sidebarTitle');
  assert.equal(title.textContent, 'Chats');
  groups.setMode('chats', 'projects');
  context.exports.syncSidebarTitle();
  assert.equal(title.dataset.i18n, 'sidebar.projects');
  assert.equal(title.textContent, 'Projekte');
  groups.setMode('chats', 'teams');

  // the groups: heads carry the id and the focus key; archived ones are closed; open ones start reading
  context.renderSessions();
  assert.equal(client.sections().length, 3);
  assert.equal(header('g1').getAttribute('aria-expanded'), 'true');
  assert.equal(header('g1').dataset.focusKey, 'team:g1');
  assert.equal(header('g3').getAttribute('aria-expanded'), 'false', 'archived: closed');
  assert.equal(pending('team=g1'), 1);
  assert.equal(pending('team=g2'), 1);
  assert.equal(pending('team=g3'), 0, 'a closed group reads nothing');

  // both answers arrive together: one rebuild
  const rendersBefore = client.counters.renders;
  answer('team=g1', { sessions: chats('a', 20), total: 45 });
  answer('team=g2', { sessions: chats('b', 2), total: 2 });
  await sleep(120);
  assert.equal(client.counters.renders - rendersBefore, 1, 'two answers, one rebuild');
  assert.equal(itemsOf('g1').length, 20);
  assert.equal(itemsOf('g2').length, 2);

  // "load more" by keyboard: the focus stays on the button, a second click does not ask twice
  let more = moreOf('g1');
  assert.ok(more, 'a button for the rest of the group');
  more.focus();
  more.click();
  assert.equal(more.getAttribute('aria-disabled'), 'true');
  assert.equal(more.getAttribute('disabled'), null, 'not disabled: a disabled button loses the focus');
  assert.equal(document.activeElement, more);
  more.click();
  assert.equal(pending('team=g1'), 1, 'one request only');
  answer('team=g1', { sessions: chats('a', 20, 20), total: 45 });
  await sleep(120);
  assert.equal(itemsOf('g1').length, 40);
  assert.notEqual(moreOf('g1'), more, 'the list was built anew');
  assert.equal(document.activeElement, moreOf('g1'), 'the focus is on the new button');
  moreOf('g1').click();
  answer('team=g1', { sessions: chats('a', 5, 40), total: 45 });
  await sleep(120);
  assert.equal(itemsOf('g1').length, 45);
  assert.equal(moreOf('g1'), undefined, 'everything is loaded');
  assert.equal(document.activeElement, header('g1'), 'the button is gone: the head of the group has the focus');

  // closing a group with Enter keeps the focus on its head
  const head = header('g1');
  head.focus();
  head.listeners.keydown[0]({ target: head, key: 'Enter', preventDefault() {} });
  assert.notEqual(header('g1'), head);
  assert.equal(header('g1').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, header('g1'));
  header('g1').listeners.keydown[0]({ target: header('g1'), key: ' ', preventDefault() {} });
  assert.equal(header('g1').getAttribute('aria-expanded'), 'true', 'space opens it again');
  assert.equal(document.activeElement, header('g1'));

  // a chat is deleted while a group is being read: the old answer must not bring it back
  reading = context.exports.loadTeamGroups(); // first reading (g2 asks again)
  answer('/api/sessions/team-groups', heads([
    { id: 'g1', name: 'Kurs A', count: 45, people: 3, archived: false, internal: false },
    { id: 'g2', name: 'Kurs B', count: 2, people: 1, archived: false, internal: false }
  ]));
  await reading;
  context.renderSessions();
  assert.equal(pending('team=g2'), 1, 'g2 is read again');
  reading = context.exports.loadTeamGroups(); // second reading: after the deletion
  answer('/api/sessions/team-groups', heads([
    { id: 'g1', name: 'Kurs A', count: 45, people: 3, archived: false, internal: false },
    { id: 'g2', name: 'Kurs B', count: 1, people: 1, archived: false, internal: false }
  ]));
  await reading;
  answer('team=g2', { sessions: chats('b', 2), total: 2 }); // the answer of the request that started before the deletion
  await sleep(120);
  assert.equal(pending('team=g2'), 1, 'the group is read anew instead of keeping the old answer');
  answer('team=g2', { sessions: chats('b', 1), total: 1 });
  await sleep(120);
  assert.deepEqual(itemsOf('g2'), ['b0'], 'the deleted chat is gone');

  // a rename shows in every copy
  const copy = context.exports.teamPages().entry('g2').sessions[0];
  context.exports.updateSessionCopies('b0', { title: 'Neu' });
  assert.equal(copy.title, 'Neu');
}

async function testChatListManyGroups() {
  const client = createChatClient();
  const { context, answer, pending, sections, itemsOf } = client;
  const list = Array.from({ length: 21 }, (_, index) => ({ id: `t${index}`, name: `Team ${index}`, count: 3, people: 2, archived: false, internal: false }));
  const reading = context.exports.loadTeamGroups();
  answer('/api/sessions/team-groups', { groups: list });
  await reading;
  context.renderSessions();
  const before = client.counters.renders;
  for (const group of list) assert.equal(pending(`team=${group.id}&`), 1, `${group.id} reads`);
  for (const group of list) answer(`team=${group.id}&`, { sessions: [{ id: `${group.id}-x` }, { id: `${group.id}-y` }, { id: `${group.id}-z` }], total: 3 });
  await sleep(150);
  assert.ok(client.counters.renders - before <= 2, `21 answers: ${client.counters.renders - before} rebuilds`);
  assert.equal(sections().length, 21);
  assert.deepEqual(itemsOf('t20'), ['t20-x', 't20-y', 't20-z']);
}

/* ---------- the workflow list of the node view ---------- */

function testWorkflowListClient() {
  const root = path.resolve(__dirname, '..');
  const { window, document, groups } = loadClient({ me: ADMIN_VIEW });
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child.nodeType ? child : document.createTextNode(String(child)));
    return node;
  };
  window.OCDNodes = { ui: { el, T: (key) => key, icon: () => document.createElement('svg'), menu: () => {} }, api: { rel: (url) => url }, archiveUi: { IMPORT_ACCEPT: '.json,.zip' } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'workflow-list.js'), 'utf8'), { window, document }, { filename: 'public/nodes/workflow-list.js' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const list = window.OCDNodes.workflowList.createWorkflowList({ host, callbacks: {} });
  const named = (className) => host.all((node) => node.className && node.className.split(/\s+/).includes(className));
  const items = named('nv-drawer-items')[0];
  const teamA = { id: 'tm-a', name: 'Kurs A', archived: false };
  const teamB = { id: 'tm-b', name: 'Kurs B', archived: false };
  const old = { id: 'tm-old', name: 'Alt-Kurs', archived: true };
  const workflow = (id, name, team, updatedAt) => ({ id, name, team, updatedAt, nodeCount: 2, owner: 'anna@example.com', canManage: true });
  list.setData({
    loading: false,
    error: null,
    teamGroups: [{ id: 'tm-a', people: 3 }, { id: 'tm-b', people: 1 }, { id: 'tm-old', people: 2 }],
    workflows: [
      workflow('w1', 'Flow A1', teamA, '2026-03-01T10:00:00.000Z'),
      workflow('w2', 'Flow A2', teamA, '2026-03-02T10:00:00.000Z'),
      workflow('w3', 'Flow B1', teamB, '2026-04-01T10:00:00.000Z'),
      workflow('w4', 'Flow Alt', old, '2026-05-01T10:00:00.000Z'),
      workflow('w5', 'Flow Intern', null, '2026-01-01T10:00:00.000Z')
    ]
  });

  // the project view is a flat list of rows
  assert.equal(items.getAttribute('role'), 'list');
  assert.equal(items.children.length, 5);
  assert.ok(items.children.every((row) => row.getAttribute('role') === 'listitem'));

  // the team view: sections instead of rows, so the container is no list (only the lists inside the groups are)
  groups.setMode('workflows', 'teams');
  list.setData({});
  assert.equal(items.getAttribute('role'), null, 'sections are no list items');
  const sections = items.children;
  assert.deepEqual(sections.map((section) => section.dataset.team), ['tm-b', 'tm-a', 'tm-old', 'none'], 'active by latest activity, archived, internal');
  const bodies = sections.map((section) => section.children.find((child) => child.className === 'nv-wf-group-items'));
  assert.equal(bodies[2], undefined, 'the archived group is closed');
  for (const index of [0, 1, 3]) assert.equal(bodies[index].getAttribute('role'), 'list', 'every group is a list of its own');
  assert.ok(bodies[1].children.every((row) => row.getAttribute('role') === 'listitem'));
  assert.match(named('nv-wf-group-meta')[1].textContent, /2 Workflows · 3 Personen/);

  // Enter or click on a head: the list is built anew and the focus stays on that head
  const head = named('nv-wf-group-head')[1];
  head.focus();
  head.click();
  const after = named('nv-wf-group-head')[1];
  assert.notEqual(after, head, 'built anew');
  assert.equal(after.dataset.teamId, 'tm-a');
  assert.equal(after.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, after);
  assert.ok(host.contains(after));
  after.click();
  assert.equal(document.activeElement.dataset.teamId, 'tm-a');

  // the search is a flat list again, every hit names its team
  const search = named('nv-drawer-search')[0];
  search.value = 'flow';
  search.listeners.input[0]();
  assert.equal(items.getAttribute('role'), 'list');
  assert.equal(items.children.length, 5);
  assert.equal(named('nv-wf-team').length, 5);
  search.value = '';
  search.listeners.input[0]();
  assert.equal(items.getAttribute('role'), null, 'grouped again');
}

/* ---------- sources: safety rules, texts, wiring ---------- */

function testSources() {
  const root = path.resolve(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  const helper = read('public', 'team-groups.js');
  assert.equal(/\.innerHTML\s*=/.test(helper), false, 'no innerHTML in the helper');
  assert.equal(/\b(alert|confirm|prompt)\(/.test(helper), false, 'no native dialogs');
  // the parts of the other client files that came with the grouping: no HTML built from data
  const appSource = read('public', 'app.js');
  const between = (from, to) => appSource.slice(appSource.indexOf(from), appSource.indexOf(to));
  const clientParts = {
    'app.js team view': between('/* ---------- team view (admins) ---------- */', 'async function createSession('),
    'app.js session item': between('function createSessionItem(', 'function appendFolderGroup('),
    'workflow-list.js': read('public', 'nodes', 'workflow-list.js')
  };
  for (const [name, text] of Object.entries(clientParts)) {
    assert.ok(text.length > 500, `${name} found`);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text), false, `no HTML built from data in ${name}`);
  }
  assert.match(read('public', 'index.html'), /<script src="team-groups\.js"><\/script>/);
  assert.ok(read('public', 'index.html').indexOf('team-groups.js') < read('public', 'index.html').indexOf('app.js'), 'loaded before the views');

  // the texts: German, English and Spanish, real umlauts, no sharp s
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  const keySource = [helper, ...Object.values(clientParts)].join('\n');
  const keys = [...new Set([...keySource.matchAll(/['"`](teamGroups\.[A-Za-z.]+)['"`]/g)].map((match) => match[1]))];
  assert.ok(keys.length >= 8, `${keys.length} teamGroups keys referenced`);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      assert.equal(typeof window.I18N[lang][key], 'string', `${lang}.${key}`);
      assert.ok(window.I18N[lang][key].length > 0, `${lang}.${key}`);
    }
    for (const [key, value] of Object.entries(window.I18N[lang])) {
      if (key.startsWith('teamGroups.')) assert.equal(value.includes('ß'), false, `${lang}.${key}`);
    }
  }
  assert.equal(window.I18N.de['teamGroups.projects'], 'Projekte');
  assert.equal(window.I18N.de['teamGroups.teams'], 'Teams');
  assert.match(window.I18N.de['teamGroups.noTeam'], /Intern/);
  assert.match(window.I18N.de['teamGroups.archived'], /archiviert/);
  assert.match(window.I18N.de['teamGroups.loading'], /Lädt/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
