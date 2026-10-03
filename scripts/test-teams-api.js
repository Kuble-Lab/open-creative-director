'use strict';

// Route-level tests of the teams with a USD budget (WP15): the team admin API, the roles participant / internal /
// guest on every kind of route, sharing with teams, the budget at every paid place, the bulk add of users, the
// allowlist sync and the monitoring filter; plus the local mode that must not change. A private copy of the app runs in
// a temp directory (own data folders, ephemeral port, whoami stub). Providers are replaced by mocks and a fetch guard
// refuses everything except localhost, so nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { ROUTE_RULES, PARTICIPANT_RULES, PARTICIPANT_RULE_NAMES } = require('./support/route-rules');

const ADMIN = 'admin@example.com';
const BOSS = 'boss@example.org';
const STAFF = 'staff1@staff.example.com';
const STAFF2 = 'staff2@staff.example.com';
const P1 = 'p1@gmail.example'; // Kurs A
const P2 = 'p2@gmail.example'; // Kurs A
const P3 = 'p3@gmail.example'; // Kurs B
const PAB = 'pab@gmail.example'; // Kurs A and Kurs B
const GUEST = 'alumni@gmail.example'; // no team, not internal
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_B64 = PNG.toString('base64');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

// The public video model list of OpenRouter (checked 2026-10-02), reduced to two of the curated models.
const VIDEO_SEEDANCE = 'bytedance/seedance-2.5';
const VIDEO_KLING = 'kwaivgi/kling-v3.0-std';
const VIDEO_CATALOG = [
  {
    id: VIDEO_SEEDANCE,
    name: 'ByteDance: Seedance 2.5',
    supported_resolutions: ['480p', '720p'],
    supported_aspect_ratios: ['16:9', '9:16', '1:1'],
    supported_durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    supported_frame_images: ['first_frame', 'last_frame'],
    generate_audio: true,
    pricing_skus: { video_tokens: '0.0000107', video_tokens_without_audio: '0.0000107', video_tokens_with_video_input: '0.0000064' }
  },
  {
    id: VIDEO_KLING,
    name: 'Kling: Video v3.0 Standard',
    supported_resolutions: ['720p'],
    supported_aspect_ratios: ['16:9', '9:16', '1:1'],
    supported_durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supported_frame_images: ['first_frame', 'last_frame'],
    generate_audio: true,
    pricing_skus: { duration_seconds: '0.084', duration_seconds_with_audio: '0.126' }
  }
];

async function waitFor(fn, { timeout = 8000, step = 50, message = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timeout waiting for ${message}`);
    await sleep(step);
  }
}

const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });

// Nothing but localhost may be reached, whatever a code path tries.
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
  return {
    attempts,
    restore() {
      global.fetch = original;
    }
  };
}

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

// "GET /api/x/:id/y" matches "GET /api/x/abc/y"
function matchesRoute(pattern, concrete) {
  const [method, routePath] = pattern.split(' ');
  const [cMethod, cPath] = concrete.split(' ');
  if (method !== cMethod) return false;
  const expression = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+');
  return new RegExp(`^${expression}$`).test(cPath);
}

function registeredRoutes(app) {
  const routes = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
  }
  return [...new Set(routes)].sort();
}

const imageResult = (cost) => ({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], ...(cost === null ? {} : { usage: { cost } }) });

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function main() {
  const guard = guardFetch();
  try {
    await testActiveMode();
    await testLocalMode();
  } finally {
    restoreAll();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Teams-API: Team-Verwaltung, Rollen, Freigabe mit Teams, Regeltabelle, Budget an jeder bezahlten Stelle, Sammel-Hinzufuegen, Freigabelisten-Sync, Monitoring-Filter und der unveraenderte lokale Modus sind korrekt.');
  console.log('test-teams-api.js: ok');
}

/* ---------- active mode ---------- */

async function testActiveMode() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-teams-api-'));
  const allowlist = path.join(tmp, 'routes.json');
  await fsp.writeFile(
    allowlist,
    JSON.stringify({ default: { domain: 'staff.example.com', public: false }, routes: [{ path: '/training', public: false, extra_emails: ['manual@example.org'] }, { path: '/other', public: true, extra_emails: [] }] }, null, 2)
  );
  fs.chmodSync(allowlist, 0o640);
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: BOSS,
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ACCESS_ALLOWLIST_FILE: allowlist,
      ACCESS_ALLOWLIST_ROUTE: '/training',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  // every call as a participant or guest is recorded for the inventory at the end
  const seen = new Set();
  const api = (url, options = {}) => {
    if ([P1, P2, P3, PAB, GUEST].includes(options.as)) seen.add(`${options.method || 'GET'} ${url.split('?')[0]}`);
    return iso.request(url, options);
  };
  const ctx = {
    iso,
    api,
    tmp,
    allowlist,
    store: iso.load('lib/store'),
    wfStore: iso.load('lib/nodes/workflows-store').defaultStore,
    costsLib: iso.load('lib/costs'),
    budget: iso.load('lib/budget'),
    tools: iso.load('lib/tools'),
    or: iso.load('lib/openrouter'),
    teamsLib: iso.load('lib/teams'),
    seen
  };
  // The model discovery would ask the provider for its catalogue; the test answers it locally (module of the private copy).
  const discovery = iso.load('lib/discovery');
  discovery.brainSupportsImages = async () => true;
  discovery.listImageModels = async () => ({ data: [] }); // the image nodes and their model lists read the public model list of OpenRouter
  // the video node (video.generate) and its model list read the public video model list of OpenRouter (lib/video-node-models.js)
  discovery.listVideoModels = async () => ({ data: VIDEO_CATALOG });
  discovery.videoCapabilities = async () => ({ resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1'], durations: { min: 4, max: 12 }, frameImages: ['first_frame', 'last_frame'] });
  ctx.call = async (email, method, url, json, extra = {}) => api(url, { method, as: email, json, ...extra });
  try {
    await testTeamAdminApi(ctx);
    await testIdentities(ctx);
    await testUsersBulk(ctx);
    await testSharing(ctx);
    await testRulesTable(ctx);
    await testBudgetChat(ctx);
    await testBudgetTools(ctx);
    await testBudgetNodes(ctx);
    await testCostsAndMonitoring(ctx);
    await testSync(ctx);
    testRouteInventory(ctx);
  } finally {
    restoreAll();
    await iso.cleanup();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/* ---------- the team admin API ---------- */

async function createTeam(api, name, budgetUsd, extra = {}) {
  const response = await api('/api/teams', { method: 'POST', as: ADMIN, json: { name, budgetUsd, ...extra } });
  assert.equal(response.status, 201, response.text);
  return response.body.team;
}

async function testTeamAdminApi(ctx) {
  const { api } = ctx;

  // only admins; unknown roles and participants get 403 (details in testRulesTable). An anonymous caller gets 401 here:
  // INTERNAL_EMAIL_DOMAINS is set, so a restriction is active (scripts/test-login-unconfirmed.js).
  assert.equal((await api('/api/teams', { as: null })).status, 401);
  assert.equal((await api('/api/teams', { method: 'POST', as: null, json: { name: 'X', budgetUsd: 1 } })).status, 401);
  for (const email of [STAFF, P1, GUEST]) {
    assert.equal((await api('/api/teams', { as: email })).status, 403, `list as ${email}`);
    assert.equal((await api('/api/teams', { method: 'POST', as: email, json: { name: 'X', budgetUsd: 1 } })).status, 403);
  }
  assert.deepEqual((await api('/api/teams', { as: ADMIN })).body.teams, []);
  assert.equal((await api('/api/teams', { as: ADMIN })).body.sync.enabled, true);
  assert.equal((await api('/api/teams', { as: ADMIN })).body.internalDomainsMissing, false, 'INTERNAL_EMAIL_DOMAINS is set in this run');

  // create: validation with codes, nothing stored on error
  for (const [json, code] of [
    [{ budgetUsd: 5 }, 'INVALID_TEAM'],
    [{ name: '   ', budgetUsd: 5 }, 'INVALID_TEAM'],
    [{ name: 'X', budgetUsd: -1 }, 'INVALID_BUDGET'],
    [{ name: 'X', budgetUsd: 'viel' }, 'INVALID_BUDGET'],
    [{ name: 'X', budgetUsd: 1e9 }, 'INVALID_BUDGET']
  ]) {
    const bad = await api('/api/teams', { method: 'POST', as: ADMIN, json });
    assert.equal(bad.status, 400, JSON.stringify(json));
    assert.equal(bad.body.code, code, JSON.stringify(json));
  }
  assert.deepEqual((await api('/api/teams', { as: ADMIN })).body.teams, []);

  const a = await createTeam(api, 'Kurs A', 10, { description: 'Herbstkurs' });
  assert.match(a.id, /^tm-[0-9a-f]{12}$/);
  assert.equal(a.budgetUsd, 10);
  assert.equal(a.memberCount, 0);
  assert.equal(a.createdBy, ADMIN);
  const b = await createTeam(api, 'Kurs B', 4);
  ctx.teamA = a;
  ctx.teamB = b;
  const duplicate = await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'kurs a', budgetUsd: 1 } });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.code, 'TEAM_NAME_TAKEN');
  assert.equal((await api('/api/teams', { as: BOSS })).body.teams.length, 2, 'superadmins are admins as well');

  // members: a pasted block, invalid pieces, duplicates, already in the team
  const paste = `Anna <${P1.toUpperCase()}>\n${P2}; ${P1}\nkaputt@\n${STAFF}`;
  const added = await api(`/api/teams/${a.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [paste] } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.added, [P1, P2, STAFF]);
  assert.deepEqual(added.body.invalid, ['kaputt@']);
  assert.equal(added.body.duplicates, 1);
  assert.equal(added.body.team.memberCount, 3);
  const asText = await api(`/api/teams/${a.id}/members`, { method: 'POST', as: ADMIN, json: { text: `${PAB}\n${P1}` } });
  assert.equal(asText.status, 201);
  assert.deepEqual(asText.body.added, [PAB]);
  assert.deepEqual(asText.body.already, [P1]);
  assert.equal((await api(`/api/teams/${a.id}/members`, { method: 'POST', as: ADMIN, json: { text: PAB } })).status, 200, 'nothing new: 200');
  for (const [json, code] of [[{}, 'INVALID_EMAILS'], [{ emails: [] }, 'NO_EMAILS'], [{ text: '   ' }, 'NO_EMAILS'], [{ emails: [3] }, 'INVALID_EMAILS']]) {
    const bad = await api(`/api/teams/${a.id}/members`, { method: 'POST', as: ADMIN, json });
    assert.equal(bad.status, 400, JSON.stringify(json));
    assert.equal(bad.body.code, code, JSON.stringify(json));
  }
  const tooMany = await api(`/api/teams/${a.id}/members`, { method: 'POST', as: ADMIN, json: { emails: Array.from({ length: 501 }, (_, i) => `x${i}@example.com`) } });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, 'TOO_MANY_EMAILS');
  await api(`/api/teams/${b.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P3, PAB] } });
  assert.equal((await api(`/api/teams/tm-000000000000/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).body.code, 'TEAM_NOT_FOUND');

  // the detail: budget of each person
  const detail = (await api(`/api/teams/${a.id}`, { as: ADMIN })).body.team;
  assert.equal(detail.members.length, 4);
  const member = detail.members.find((entry) => entry.email === P1);
  assert.equal(member.limitUsd, 10);
  assert.equal(member.spentUsd, 0);
  assert.equal(member.remainingUsd, 10);
  assert.equal(member.teamLimitUsd, 10);
  assert.equal(member.budgetOverrideUsd, null);
  assert.equal(detail.members.find((entry) => entry.email === PAB).limitUsd, 10, 'the highest amount of all teams');

  // override, reset, remove
  const override = await api(`/api/teams/${a.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: 25 } });
  assert.equal(override.status, 200);
  assert.equal(override.body.team.members.find((entry) => entry.email === P2).limitUsd, 25);
  assert.equal((await api(`/api/teams/${a.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: null } })).body.team.members.find((entry) => entry.email === P2).limitUsd, 10);
  assert.equal((await api(`/api/teams/${a.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { resetBudget: true } })).status, 200);
  for (const json of [{}, { budgetOverrideUsd: -2 }, { resetBudget: false }]) {
    assert.equal((await api(`/api/teams/${a.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json })).status, 400, JSON.stringify(json));
  }
  assert.equal((await api(`/api/teams/${a.id}/members/${enc('nobody@example.com')}`, { method: 'PATCH', as: ADMIN, json: { resetBudget: true } })).body.code, 'MEMBER_NOT_FOUND');
  assert.equal((await api(`/api/teams/${a.id}/members/${enc('nobody@example.com')}`, { method: 'DELETE', as: ADMIN })).status, 404);
  const removed = await api(`/api/teams/${a.id}/members/${enc(STAFF)}`, { method: 'DELETE', as: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.team.memberCount, 3);

  // patch the team
  assert.equal((await api(`/api/teams/${a.id}`, { method: 'PATCH', as: ADMIN, json: { description: 'Herbstkurs 2026' } })).body.team.description, 'Herbstkurs 2026');
  assert.equal((await api(`/api/teams/${a.id}`, { method: 'PATCH', as: ADMIN, json: {} })).status, 400);
  assert.equal((await api(`/api/teams/${a.id}`, { method: 'PATCH', as: ADMIN, json: { name: 'Kurs B' } })).body.code, 'TEAM_NAME_TAKEN');

  // the list
  const list = (await api('/api/teams', { as: ADMIN })).body;
  assert.deepEqual(list.teams.map((team) => team.name).sort(), ['Kurs A', 'Kurs B']);
  assert.ok(!('members' in list.teams[0]), 'the list holds no members');
  assert.equal(list.limits.maxBulk, 500);
  assert.equal(list.problem, null);
  assert.equal((await api('/api/teams/tm-000000000000', { as: ADMIN })).status, 404);

  // the team file: chmod 600
  const file = path.join(ctx.iso.root, 'data', 'teams.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // archive / restore and delete of a scratch team
  const scratch = await createTeam(api, 'Wegwerf', 1);
  await api(`/api/teams/${scratch.id}/members`, { method: 'POST', as: ADMIN, json: { emails: ['scratch@gmail.example'] } });
  assert.equal((await api('/api/me', { as: 'scratch@gmail.example' })).body.participant, true);
  await api(`/api/teams/${scratch.id}`, { method: 'PATCH', as: ADMIN, json: { archived: true } });
  assert.equal((await api('/api/me', { as: 'scratch@gmail.example' })).body.participant, false, 'an archived team ends the participation at once');
  await api(`/api/teams/${scratch.id}`, { method: 'PATCH', as: ADMIN, json: { archived: false } });
  assert.equal((await api('/api/me', { as: 'scratch@gmail.example' })).body.participant, true);
  const deleted = await api(`/api/teams/${scratch.id}`, { method: 'DELETE', as: ADMIN });
  assert.equal(deleted.status, 200);
  assert.equal((await api(`/api/teams/${scratch.id}`, { method: 'DELETE', as: ADMIN })).status, 404);
  assert.equal((await api('/api/me', { as: 'scratch@gmail.example' })).body.participant, false);
}

/* ---------- identities ---------- */

async function testIdentities({ api, teamA, teamB }) {
  const p1 = (await api('/api/me', { as: P1 })).body;
  assert.equal(p1.identified, true);
  assert.equal(p1.role, 'participant');
  assert.equal(p1.participant, true);
  assert.equal(p1.isAdmin, false);
  assert.deepEqual(p1.teams, [{ id: teamA.id, name: 'Kurs A' }]);
  assert.equal(p1.budget.limitUsd, 10);
  assert.equal(p1.budget.remainingUsd, 10);
  const pab = (await api('/api/me', { as: PAB })).body;
  assert.deepEqual(pab.teams.map((team) => team.id).sort(), [teamA.id, teamB.id].sort());
  assert.equal(pab.budget.limitUsd, 10, 'several teams: the highest amount');

  const guest = (await api('/api/me', { as: GUEST })).body;
  assert.equal(guest.role, 'guest');
  assert.equal(guest.participant, false);
  assert.deepEqual(guest.teams, []);
  assert.equal(guest.budget.limitUsd, 0);
  assert.equal(guest.budget.remainingUsd, 0);

  // internal people and admins: the answer of before (no new fields)
  const staff = (await api('/api/me', { as: STAFF })).body;
  assert.equal(staff.role, 'user');
  for (const key of ['participant', 'teams', 'budget']) assert.equal(key in staff, false, key);
  assert.equal((await api('/api/me', { as: ADMIN })).body.role, 'admin');
  assert.equal('budget' in (await api('/api/me', { as: ADMIN })).body, false);
  assert.equal((await api('/api/me', { as: BOSS })).body.role, 'superadmin');
  const anonymous = (await api('/api/me')).body;
  assert.equal(anonymous.role, 'anonymous');
  assert.equal(anonymous.loginUnconfirmed, true, 'a restriction is active: the anonymous caller is told the login is unconfirmed');
  assert.equal('budget' in anonymous, false);

  // the domain of a participant does not matter: an internal address in a team is a participant
  await api(`/api/teams/${teamB.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [STAFF2] } });
  assert.equal((await api('/api/me', { as: STAFF2 })).body.role, 'participant');
  await api(`/api/teams/${teamB.id}/members/${enc(STAFF2)}`, { method: 'DELETE', as: ADMIN });
  assert.equal((await api('/api/me', { as: STAFF2 })).body.role, 'user');
}

/* ---------- bulk add of users ---------- */

async function testUsersBulk({ api }) {
  const paste = 'Ben <ben@example.org>\ncleo@example.net; ben@example.org\nkaputt@\nadmin@example.com';
  const result = await api('/api/users', { method: 'POST', as: ADMIN, json: { emails: [paste] } });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.added, ['ben@example.org', 'cleo@example.net']);
  assert.deepEqual(result.body.invalid, ['kaputt@']);
  assert.equal(result.body.duplicates, 1);
  assert.deepEqual(result.body.already, ['admin@example.com'], 'an admin already belongs to the list');
  assert.ok(result.body.users.some((user) => user.email === 'cleo@example.net'));
  const again = await api('/api/users', { method: 'POST', as: ADMIN, json: { text: 'ben@example.org' } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.already, ['ben@example.org']);
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { emails: [] } })).status, 400);
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { emails: Array.from({ length: 501 }, (_, i) => `u${i}@example.com`) } })).status, 400);
  assert.equal((await api('/api/users', { as: ADMIN })).body.users.filter((user) => /^u\d+@/.test(user.email)).length, 0, 'nothing is written if the list does not fit');
  // one address, as before
  const one = await api('/api/users', { method: 'POST', as: ADMIN, json: { email: 'dora@example.net' } });
  assert.equal(one.status, 201);
  assert.equal(one.body.email, 'dora@example.net');
  assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: 'kaputt' } })).status, 400);
  assert.equal((await api('/api/users', { method: 'POST', as: P1, json: { emails: ['x@example.com'] } })).status, 403);
  assert.equal((await api('/api/users', { method: 'POST', as: null, json: { emails: ['x@example.com'] } })).status, 401, 'anonymous: unconfirmed login');
}

/* ---------- sharing with teams ---------- */

const share = (api, kind, id, email, json) => api(`/api/${kind}/${id}/share`, { method: 'PATCH', as: email, json });

async function testSharing(ctx) {
  const { api, call, store, wfStore, teamA, teamB } = ctx;
  const idsFor = async (email, kind = 'sessions') => {
    const body = (await api(`/api/${kind}?limit=100`, { as: email })).body;
    return (kind === 'sessions' ? body.sessions : body.workflows).map((entry) => entry.id).sort();
  };

  // existing data (no owner) is invisible for participants and guests, usable for internal people
  const legacy = await store.createSession();
  const legacyFlow = (await wfStore.createWorkflow({ name: 'Altbestand' })).workflow;
  ctx.legacy = legacy;
  ctx.legacyFlow = legacyFlow;
  assert.deepEqual(await idsFor(STAFF), [legacy.id]);
  for (const email of [P1, PAB, GUEST]) {
    assert.deepEqual(await idsFor(email), [], `chats of ${email}`);
    assert.deepEqual(await idsFor(email, 'workflows'), [], `workflows of ${email}`);
    assert.equal((await call(email, 'GET', `/api/sessions/${legacy.id}`)).status, 404);
    assert.equal((await call(email, 'GET', `/api/workflows/${legacyFlow.id}`)).status, 404);
    assert.equal((await call(email, 'POST', `/api/sessions/${legacy.id}/message`, { text: 'hi' })).status, 404);
  }

  // a participant's chat is private; shared with a team it reaches exactly that team
  const chat = (await call(P1, 'POST', '/api/sessions', {})).body.session;
  assert.equal(chat.owner, P1);
  assert.equal(chat.shareMode, 'private');
  ctx.chat = chat;
  assert.deepEqual(await idsFor(P2), []);

  const wrongMode = await share(api, 'sessions', chat.id, P1, { shareMode: 'team' });
  assert.equal(wrongMode.status, 400);
  assert.equal(wrongMode.body.code, 'SHARE_MODE_FORBIDDEN', 'participants cannot share with all internal people');
  const foreignTeam = await share(api, 'sessions', chat.id, P1, { shareMode: 'teams', sharedTeams: [teamB.id] });
  assert.equal(foreignTeam.status, 400);
  assert.equal(foreignTeam.body.code, 'UNKNOWN_TEAMS', 'a team they are not in');
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'teams', sharedTeams: [] })).status, 400);
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'teams' })).status, 400);
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'teams', sharedTeams: ['tm-unbekannt'] })).body.code, 'UNKNOWN_TEAMS');
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'specific', sharedWith: [STAFF] })).body.code, 'UNKNOWN_TEAM_MEMBERS', 'an internal person is not a teammate');
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'specific', sharedWith: [P3] })).body.code, 'UNKNOWN_TEAM_MEMBERS', 'somebody from another team is not a teammate');

  const shared = await share(api, 'sessions', chat.id, P1, { shareMode: 'teams', sharedTeams: [teamA.id, teamA.id] });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.session.shareMode, 'teams');
  assert.deepEqual(shared.body.session.sharedTeams.map((team) => team.id), [teamA.id]);
  assert.deepEqual(await idsFor(P2), [chat.id]);
  assert.deepEqual(await idsFor(PAB), [chat.id]);
  assert.deepEqual(await idsFor(P3), []);
  assert.deepEqual(await idsFor(GUEST), []);
  assert.deepEqual(await idsFor(STAFF), [legacy.id], 'internal people are not in the team: they do not see it');
  assert.deepEqual(await idsFor(ADMIN), [chat.id, legacy.id].sort());
  const view = (await api(`/api/sessions/${chat.id}`, { as: P2 })).body.session;
  assert.equal(view.canManage, false);
  assert.equal(view.canShare, false);
  assert.equal(view.mine, false);
  assert.equal('sharedWith' in view, false);
  assert.equal(view.sharedTeamCount, 1);
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'PATCH', as: P2, json: { title: 'Fremd' } })).status, 403);
  assert.equal((await api(`/api/sessions/${chat.id}`, { method: 'DELETE', as: P2 })).status, 403);
  assert.equal((await share(api, 'sessions', chat.id, P2, { shareMode: 'private' })).status, 403);
  assert.equal((await api(`/api/sessions/${chat.id}/context-files`, { method: 'POST', as: P2, json: { name: 'a.md', text: 'x' } })).status, 201, 'a team mate may use the chat');
  // a foreign private chat: 404 on every route, for a participant of another team and for guests
  await share(api, 'sessions', chat.id, P1, { shareMode: 'private' });
  const foreign = [
    ['GET', `/api/sessions/${chat.id}`],
    ['PATCH', `/api/sessions/${chat.id}`, { title: 'x' }],
    ['PATCH', `/api/sessions/${chat.id}/share`, { shareMode: 'private' }],
    ['DELETE', `/api/sessions/${chat.id}`],
    ['GET', `/api/sessions/${chat.id}/jobs`],
    ['GET', `/api/sessions/${chat.id}/context`],
    ['POST', `/api/sessions/${chat.id}/context`, { brainId: 'x' }],
    ['DELETE', `/api/sessions/${chat.id}/context/x`],
    ['POST', `/api/sessions/${chat.id}/context-files`, { name: 'a.md', text: 'x' }],
    ['DELETE', `/api/sessions/${chat.id}/context-files/x`],
    ['POST', `/api/sessions/${chat.id}/message`, { text: 'hi' }],
    ['POST', `/api/sessions/${chat.id}/video-model-requests/vmr-x`, { model: 'bytedance/seedance-2.5' }],
    ['POST', `/api/sessions/${chat.id}/video-model-requests/vmr-x/cancel`, {}],
    ['GET', `/api/sessions/${chat.id}/workflow-runs/wfr-x`],
    ['POST', `/api/sessions/${chat.id}/workflow-runs/wfr-x`, {}],
    ['POST', `/api/sessions/${chat.id}/workflow-runs/wfr-x/cancel`, {}],
    ['DELETE', `/api/sessions/${chat.id}/video-model-preference`]
  ];
  for (const email of [P2, P3, GUEST]) {
    for (const [method, url, json] of foreign) {
      const response = await call(email, method, url, json);
      assert.equal(response.status, 404, `${method} ${url} as ${email}`);
    }
  }

  // specific: a teammate; and the owner lists it
  assert.equal((await share(api, 'sessions', chat.id, P1, { shareMode: 'specific', sharedWith: [P2] })).status, 200);
  assert.deepEqual(await idsFor(P2), [chat.id]);
  assert.deepEqual(await idsFor(PAB), [], 'PAB is in Kurs A with P1 but was not picked');
  // guests: private only
  const guestChat = (await api('/api/sessions', { method: 'POST', as: GUEST, json: {} })).body.session;
  assert.equal(guestChat.owner, GUEST);
  for (const json of [{ shareMode: 'team' }, { shareMode: 'teams', sharedTeams: [teamA.id] }, { shareMode: 'specific', sharedWith: [P1] }]) {
    const refused = await share(api, 'sessions', guestChat.id, GUEST, json);
    assert.equal(refused.status, 400, JSON.stringify(json));
    assert.equal(refused.body.code, 'SHARE_MODE_FORBIDDEN');
  }
  assert.equal((await share(api, 'sessions', guestChat.id, GUEST, { shareMode: 'private' })).status, 200);

  // internal people may share with teams
  const staffChat = (await api('/api/sessions', { method: 'POST', as: STAFF, json: {} })).body.session;
  assert.equal((await share(api, 'sessions', staffChat.id, STAFF, { shareMode: 'teams', sharedTeams: [teamB.id] })).status, 200);
  assert.deepEqual(await idsFor(P3), [staffChat.id], 'Kurs B sees the chat of the trainer');
  assert.deepEqual(await idsFor(PAB), [staffChat.id]);
  assert.deepEqual(await idsFor(P1), [chat.id], 'Kurs A does not see the trainer chat (only its own)');
  assert.equal((await api('/api/sessions', { method: 'POST', as: STAFF, json: {} })).status, 201);
  assert.equal((await share(api, 'sessions', staffChat.id, STAFF, { shareMode: 'teams', sharedTeams: ['tm-unbekannt'] })).body.code, 'UNKNOWN_TEAMS');
  assert.equal((await share(api, 'sessions', staffChat.id, STAFF, { shareMode: 'team' })).status, 200);
  assert.deepEqual(await idsFor(P3), [], 'the mode team is for internal people only');
  await share(api, 'sessions', staffChat.id, STAFF, { shareMode: 'teams', sharedTeams: [teamB.id] });
  // removing P3 from Kurs B ends the access at once
  await api(`/api/teams/${teamB.id}/members/${enc(P3)}`, { method: 'DELETE', as: ADMIN });
  assert.deepEqual(await idsFor(P3), []);
  assert.equal((await api(`/api/sessions/${staffChat.id}`, { as: P3 })).status, 404);
  await api(`/api/teams/${teamB.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P3] } });
  assert.deepEqual(await idsFor(P3), [staffChat.id]);

  // assets follow the chat
  const asset = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'x', cost: null });
  ctx.chatAsset = asset;
  assert.equal((await api(asset.url, { as: P1, raw: true })).status, 200);
  assert.equal((await api(asset.url, { as: P2, raw: true })).status, 200, 'specific: P2');
  assert.equal((await api(asset.url, { as: P3, raw: true })).status, 404);
  assert.equal((await api(asset.url, { as: GUEST, raw: true })).status, 404);
  assert.equal((await api(asset.url, { as: STAFF, raw: true })).status, 404);

  // workflows: the same modes; the backing session follows
  const flow = (await call(P1, 'POST', '/api/workflows', { name: 'Kurs-Flow' })).body.workflow;
  ctx.flow = flow;
  assert.equal(flow.owner, P1);
  assert.equal((await store.readSession(flow.sessionId)).owner, P1);
  const exported = await call(P1, 'GET', `/api/workflows/${flow.id}/export`);
  assert.equal(exported.status, 200);
  const imported = await call(P1, 'POST', '/api/workflows/import', { document: exported.body });
  assert.equal(imported.status, 201, imported.text);
  assert.equal(imported.body.workflow.owner, P1, 'an import belongs to the person who imports it');
  assert.equal(imported.body.workflow.shareMode, 'private');
  // the ZIP with files: the same rules (export like the JSON export, import owned by the person who imports)
  const zipDownload = await call(P1, 'GET', `/api/workflows/${flow.id}/export.zip`, undefined, { raw: true });
  assert.equal(zipDownload.status, 200);
  const zipImported = await call(P1, 'POST', '/api/workflows/import-zip', undefined, { headers: { 'Content-Type': 'application/zip' }, body: Buffer.from(await zipDownload.arrayBuffer()) });
  assert.equal(zipImported.status, 201, zipImported.text);
  assert.equal(zipImported.body.workflow.owner, P1);
  assert.equal(zipImported.body.workflow.shareMode, 'private');
  assert.equal((await share(api, 'workflows', flow.id, P1, { shareMode: 'team' })).body.code, 'SHARE_MODE_FORBIDDEN');
  assert.equal((await share(api, 'workflows', flow.id, P1, { shareMode: 'teams', sharedTeams: [teamB.id] })).body.code, 'UNKNOWN_TEAMS');
  const sharedFlow = await share(api, 'workflows', flow.id, P1, { shareMode: 'teams', sharedTeams: [teamA.id] });
  assert.equal(sharedFlow.status, 200);
  assert.deepEqual(sharedFlow.body.workflow.sharedTeams.map((team) => team.id), [teamA.id]);
  assert.deepEqual(await idsFor(P2, 'workflows'), [flow.id]);
  assert.deepEqual(await idsFor(P3, 'workflows'), []);
  assert.deepEqual(await idsFor(STAFF, 'workflows'), [legacyFlow.id]);
  assert.equal((await store.readSession(flow.sessionId)).shareMode, 'teams', 'the backing session follows the workflow');
  assert.deepEqual((await store.readSession(flow.sessionId)).sharedTeams, [teamA.id]);
  const flowUpload = await call(P1, 'POST', `/api/workflows/${flow.id}/uploads?accept=image`, undefined, { headers: { 'Content-Type': 'image/png', 'x-filename': 'a.png' }, body: PNG });
  assert.equal(flowUpload.status, 200);
  assert.equal((await api(flowUpload.body.value.url, { as: P2, raw: true })).status, 200);
  assert.equal((await api(flowUpload.body.value.url, { as: P3, raw: true })).status, 404);
  assert.equal((await api(flowUpload.body.value.url, { as: GUEST, raw: true })).status, 404);
  // (no results yet: a teammate gets the plain "nothing to download", an outsider the "no such workflow")
  assert.equal((await api(`/api/workflows/${flow.id}/outputs.zip`, { as: P2 })).body.code, 'NOT_FOUND');
  assert.equal((await api(`/api/workflows/${flow.id}/outputs.zip`, { as: P3 })).body.code, 'WORKFLOW_NOT_FOUND');
  const stream = await api(`/api/workflows/${flow.id}/events`, { as: P2, raw: true });
  assert.equal(stream.status, 200);
  await stream.body.cancel();
  assert.equal((await api(`/api/workflows/${flow.id}/events`, { as: P3, raw: true })).status, 404);
  await share(api, 'workflows', flow.id, P1, { shareMode: 'private' });

  // foreign private workflow: every route 404 for participants of another team and guests
  const foreignFlow = (id) => [
    ['GET', `/api/workflows/${id}`],
    ['PUT', `/api/workflows/${id}`, { baseRev: 1, graph: { nodes: [], edges: [] } }],
    ['PATCH', `/api/workflows/${id}`, { name: 'x' }],
    ['PATCH', `/api/workflows/${id}/share`, { shareMode: 'private' }],
    ['DELETE', `/api/workflows/${id}`],
    ['POST', `/api/workflows/${id}/duplicate`, {}],
    ['GET', `/api/workflows/${id}/export`],
    ['GET', `/api/workflows/${id}/export-info`],
    ['GET', `/api/workflows/${id}/export.zip`],
    ['GET', `/api/workflows/${id}/assets`],
    ['POST', `/api/workflows/${id}/import-asset`, { sessionId: 'a', assetId: 'b' }],
    ['GET', `/api/workflows/${id}/send-to-chat/plan?nodeId=n`],
    ['POST', `/api/workflows/${id}/send-to-chat`, { sessionId: 'a', nodeId: 'n' }],
    ['POST', `/api/workflows/${id}/runs/plan`, { mode: 'all' }],
    ['POST', `/api/workflows/${id}/runs`, { mode: 'all' }],
    ['POST', `/api/workflows/${id}/assistant`, { question: 'Hallo', canvas: { nodes: [], edges: [] } }],
    ['GET', `/api/workflows/${id}/runs`],
    ['GET', `/api/workflows/${id}/runs/run-1`],
    ['POST', `/api/workflows/${id}/runs/run-1/cancel`, {}],
    ['GET', `/api/workflows/${id}/outputs.zip`],
    ['PATCH', `/api/workflows/${id}/results/n1`, { entry: 'e' }],
    ['GET', `/api/workflows/${id}/events`]
  ];
  for (const email of [P3, GUEST, PAB]) {
    const subject = email === PAB ? legacyFlow.id : flow.id; // PAB shares Kurs A but the flow is private again
    for (const [method, url, json] of foreignFlow(subject)) {
      const response = await call(email, method, url, json);
      assert.equal(response.status, 404, `${method} ${url} as ${email}`);
    }
  }
  assert.equal((await call(P3, 'POST', `/api/workflows/${flow.id}/uploads`, undefined, { headers: { 'Content-Type': 'image/png', 'x-filename': 'x.png' }, body: PNG })).status, 404);

  // a chat that was shared with a team keeps its list while the team is archived (no access, nothing lost)
  await share(api, 'sessions', chat.id, P1, { shareMode: 'teams', sharedTeams: [teamA.id] });
  await api(`/api/teams/${teamA.id}`, { method: 'PATCH', as: ADMIN, json: { archived: true } });
  assert.deepEqual(await idsFor(P2), [], 'an archived team ends the access');
  assert.equal((await api(`/api/sessions/${chat.id}`, { as: P1 })).status, 200, 'the owner keeps their chat (no team: a guest)');
  await api(`/api/teams/${teamA.id}`, { method: 'PATCH', as: ADMIN, json: { archived: false } });
  assert.deepEqual(await idsFor(P2), [chat.id]);
  await share(api, 'sessions', chat.id, P1, { shareMode: 'private' });
}

/* ---------- the decision per route ---------- */

const ADMIN_URLS = {
  ':id': 'abc',
  ':email': enc('x@example.com'),
  ':name': 'Leer',
  ':fileId': 'abc',
  ':filename': 'abc',
  ':brainId': 'x'
};

function concrete(route) {
  const [method, routePath] = route.split(' ');
  return [method, routePath.replace(/:[A-Za-z]+/g, (token) => ADMIN_URLS[token] || 'abc')];
}

async function testRulesTable(ctx) {
  const { api, call, iso, store, tools, teamA } = ctx;

  // the tables list the same routes and only known decisions
  assert.deepEqual(Object.keys(PARTICIPANT_RULES).sort(), Object.keys(ROUTE_RULES).sort());
  assert.deepEqual(Object.values(PARTICIPANT_RULES).filter((rule) => !PARTICIPANT_RULE_NAMES.includes(rule)), []);
  for (const [route, rule] of Object.entries(ROUTE_RULES)) {
    if (rule === 'admin') assert.equal(PARTICIPANT_RULES[route], 'admin', `${route}: admin routes stay admin routes`);
    if (rule === 'superadmin') assert.equal(PARTICIPANT_RULES[route], 'superadmin', route);
  }

  // admin: 403 for participants, guests and internal people; superadmin: 404
  for (const [route, rule] of Object.entries(PARTICIPANT_RULES)) {
    if (rule !== 'admin' && rule !== 'superadmin') continue;
    const [method, url] = concrete(route);
    for (const email of [P1, GUEST]) {
      const response = await call(email, method, url, method === 'GET' ? undefined : {});
      assert.equal(response.status, rule === 'admin' ? 403 : 404, `${route} as ${email}`);
    }
  }
  assert.equal((await call(P1, 'GET', '/monitoring.html', undefined, { raw: true })).status, 404);

  // forbidden: internal resources answer 403 with a code the client can explain
  const gts = await call(P1, 'GET', '/api/gts/search?q=test');
  assert.equal(gts.status, 403);
  assert.equal(gts.body.code, 'FORBIDDEN_FOR_ROLE');
  assert.equal(gts.body.feature, 'gts');
  assert.match(gts.body.error, /GTS/);
  assert.equal((await call(GUEST, 'GET', '/api/gts/search?q=test')).status, 403);
  assert.equal((await api('/api/gts/search?q=test', { as: STAFF })).status, 503, 'internal people: as before (no token here)');
  const contextPost = await call(P1, 'POST', `/api/sessions/${ctx.chat.id}/context`, { brainId: 'x' });
  assert.equal(contextPost.status, 403);
  assert.equal(contextPost.body.code, 'FORBIDDEN_FOR_ROLE');
  const contextList = await call(P1, 'GET', `/api/sessions/${ctx.chat.id}/context`);
  assert.equal(contextList.status, 200);
  assert.ok(!JSON.stringify(contextList.body).includes('title'), 'no GTS titles in the context list');
  for (const url of ['/api/nodes/higgsfield-models/some-model', '/api/nodes/options/higgsfield-image-models', '/api/nodes/options/higgsfield-video-models', '/api/nodes/options/higgsfield-voices']) {
    const response = await call(P1, 'GET', url);
    assert.equal(response.status, 403, url);
    assert.equal(response.body.code, 'FORBIDDEN_FOR_ROLE', url);
    assert.equal(response.body.feature, 'higgsfield', url);
    assert.notEqual((await api(url, { as: STAFF })).body?.code, 'FORBIDDEN_FOR_ROLE', `${url} for internal people`);
  }

  // filtered: config
  const chatgpt = iso.load('lib/chatgpt');
  const gtsLib = iso.load('lib/gts');
  patch(chatgpt, 'status', () => ({ connected: true }));
  patch(gtsLib, 'hasToken', () => true);
  const staffConfig = (await api('/api/config', { as: STAFF })).body;
  const p1Config = (await call(P1, 'GET', '/api/config')).body;
  assert.ok(staffConfig.brainModels.some((model) => chatgpt.BRAIN_MODELS.includes(model)), 'internal people see the ChatGPT models');
  assert.ok(!p1Config.brainModels.some((model) => chatgpt.BRAIN_MODELS.includes(model)), 'participants do not');
  assert.equal(staffConfig.gts.enabled, true);
  assert.equal(p1Config.gts.enabled, false);
  assert.ok(!(await call(GUEST, 'GET', '/api/config')).body.brainModels.some((model) => chatgpt.BRAIN_MODELS.includes(model)));
  assert.ok(p1Config.brainModels.length > 0);
  // a ChatGPT model in a chat message: refused before the stream (403), a normal model is not
  const chatgptModel = chatgpt.BRAIN_MODELS[0];
  const refusedModel = await call(P1, 'POST', `/api/sessions/${ctx.chat.id}/message`, { text: 'hi', brainModel: chatgptModel });
  assert.equal(refusedModel.status, 403);
  assert.equal(refusedModel.body.code, 'FORBIDDEN_FOR_ROLE');
  assert.equal(refusedModel.body.feature, 'chatgpt');
  restoreAll();

  // filtered: prompt templates, render node status, team list, registry, brandings, roles
  const custom = await api('/api/prompt-presets/custom', { method: 'POST', as: ADMIN, json: { title: 'Team-Vorlage', prompt: 'Nur intern', group: 'Team' } });
  assert.equal(custom.status, 201);
  const staffPresets = (await api('/api/prompt-presets', { as: STAFF })).body;
  const p1Presets = (await call(P1, 'GET', '/api/prompt-presets')).body;
  assert.ok(staffPresets.some((preset) => preset.custom));
  assert.ok(p1Presets.length > 0 && p1Presets.every((preset) => !preset.custom), 'no custom templates for participants');
  assert.ok((await call(GUEST, 'GET', '/api/prompt-presets')).body.every((preset) => !preset.custom));

  const status = await call(P1, 'GET', '/api/rendernode/status');
  assert.equal(status.status, 200);
  assert.equal('nodes' in status.body, false, 'no names of render nodes');
  assert.equal((await api('/api/rendernode/status', { as: STAFF })).status, 200);

  const team = (await call(P1, 'GET', '/api/team')).body;
  assert.deepEqual(team.members.map((member) => member.email).sort(), [P1, P2, PAB].sort(), 'the members of their own teams');
  assert.equal(team.members.find((member) => member.email === P1).me, true);
  assert.ok(!team.members.some((member) => [STAFF, P3, ADMIN].includes(member.email)));
  assert.deepEqual((await call(GUEST, 'GET', '/api/team')).body.members, []);
  assert.ok((await api('/api/team', { as: STAFF })).body.members.length > 0);
  assert.equal((await call(null, 'GET', '/api/team')).status, 401, 'anonymous: unconfirmed login (a restriction is active)');

  const mine = (email) => call(email, 'GET', '/api/teams/mine');
  assert.deepEqual((await mine(P1)).body.teams.map((entry) => entry.name), ['Kurs A']);
  assert.deepEqual((await mine(PAB)).body.teams.map((entry) => entry.name).sort(), ['Kurs A', 'Kurs B']);
  assert.deepEqual((await mine(GUEST)).body.teams, []);
  assert.deepEqual((await api('/api/teams/mine', { as: STAFF })).body.teams.map((entry) => entry.name).sort(), ['Kurs A', 'Kurs B'], 'internal people may share with every team');
  assert.equal((await api('/api/teams/mine')).status, 401, 'anonymous: unconfirmed login');
  assert.ok((await mine(P1)).body.teams[0].memberCount >= 3);

  const registry = (await call(P1, 'GET', '/api/nodes/registry')).body;
  const higgs = registry.nodeTypes.filter((type) => type.category === 'higgsfield');
  assert.ok(higgs.length > 0);
  assert.ok(higgs.every((type) => type.restricted === true && typeof type.available === 'string'), 'Higgsfield nodes are marked as not available');
  const staffRegistry = (await api('/api/nodes/registry', { as: STAFF })).body;
  assert.ok(staffRegistry.nodeTypes.filter((type) => type.category === 'higgsfield').every((type) => !type.restricted));
  assert.equal(registry.nodeTypes.length, staffRegistry.nodeTypes.length);
  const models = await call(P1, 'GET', '/api/nodes/options/brain-models');
  assert.equal(models.status, 200);
  assert.ok(!models.body.options?.some((option) => chatgpt.BRAIN_MODELS.includes(option.value)));

  // brandings and roles: none for participants
  const created = await tools.executeTool({ sessionId: ctx.chat.id, config: {}, emit: () => {}, user: ADMIN }, 'create_branding', { name: 'Hausbranding' });
  assert.match(created.toolResult, /Branding erstellt/);
  const brandingId = (await api('/api/brandings', { as: STAFF })).body.brandings[0].id;
  assert.equal((await api('/api/brandings', { as: STAFF })).body.brandings.length, 1);
  assert.deepEqual((await call(P1, 'GET', '/api/brandings')).body.brandings, []);
  assert.deepEqual((await call(GUEST, 'GET', '/api/brandings')).body.brandings, []);
  for (const url of [`/api/brandings/${brandingId}`, `/api/brandings/${brandingId}/export`, `/api/brandings/${brandingId}/assets/logo.png`]) {
    assert.equal((await call(P1, 'GET', url)).status, 404, url);
    if (!url.endsWith('logo.png')) assert.equal((await api(url, { as: STAFF })).status, 200, `${url} for internal people`);
  }
  assert.deepEqual((await call(P1, 'GET', '/api/roles')).body.roles, []);
  assert.equal((await call(P1, 'GET', '/api/roles/default')).status, 200);
  assert.equal((await call(P1, 'GET', '/api/workflow-templates')).status, 200);

  // starter templates: none that needs Higgsfield for participants and guests (list, single document and creation)
  const staffTemplates = (await api('/api/workflow-templates', { as: STAFF })).body.templates;
  assert.ok(staffTemplates.some((template) => template.id === 'dub-clip'), 'internal people see every template');
  assert.equal((await api('/api/workflow-templates/dub-clip', { as: STAFF })).status, 200);
  for (const email of [P1, GUEST]) {
    const listed = await call(email, 'GET', '/api/workflow-templates');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.templates.length, staffTemplates.length - 1, `${email}: only the Higgsfield template is missing`);
    assert.ok(!listed.body.templates.some((template) => template.id === 'dub-clip'));
    assert.ok(listed.body.templates.every((template) => !template.nodeTypes.some((type) => type.startsWith('hf.'))));
    const single = await call(email, 'GET', '/api/workflow-templates/dub-clip');
    assert.equal(single.status, 403, `${email}: single template with Higgsfield nodes`);
    assert.equal(single.body.code, 'FORBIDDEN_FOR_ROLE');
    assert.equal((await call(email, 'GET', '/api/workflow-templates/photo-slideshow?lang=de')).body.document.name, 'Fotoshow (lokal)');
    assert.equal((await call(email, 'GET', '/api/workflow-templates/nicht-da')).status, 404);
    const refused = await call(email, 'POST', '/api/workflows', { templateId: 'dub-clip' });
    assert.equal(refused.status, 403, `${email}: no workflow from a Higgsfield template`);
    assert.equal(refused.body.code, 'FORBIDDEN_FOR_ROLE');
    const made = await call(email, 'POST', '/api/workflows', { templateId: 'image-formats', lang: 'de' });
    assert.equal(made.status, 201, `${email}: a template without Higgsfield works`);
    assert.equal(made.body.workflow.graph.nodes.length, 5);
  }
  assert.equal((await api('/api/workflows', { method: 'POST', as: STAFF, json: { templateId: 'dub-clip' } })).status, 201, 'internal people may use it');
  assert.equal((await call(P1, 'GET', '/refs/nichts', undefined, { raw: true })).status, 404);

  // the chat of a participant knows neither the role nor a branding
  const attach = await call(P1, 'PATCH', `/api/sessions/${ctx.chat.id}`, { branding: brandingId });
  assert.ok([403, 404, 400].includes(attach.status), 'a participant cannot attach a branding');
  const chatView = (await call(P1, 'GET', `/api/sessions/${ctx.chat.id}`)).body.session;
  assert.ok(!chatView.brandingIds?.length, 'no branding on the chat');

  // projects: own only. A project holding only foreign entries does not exist for them.
  await store.createSession({ folder: 'Altbestand' });
  assert.equal((await api('/api/sessions', { method: 'POST', as: STAFF, json: { folder: 'Intern-Projekt' } })).status, 201);
  const created1 = await call(P1, 'POST', '/api/folders', { name: 'Mein Kursprojekt' });
  assert.equal(created1.status, 201);
  const folderNames = async (email) => (await api('/api/folders', { as: email })).body.folders.map((entry) => entry.name);
  assert.ok((await folderNames(P1)).includes('Mein Kursprojekt'));
  assert.ok(!(await folderNames(P1)).includes('Altbestand'), 'existing projects are invisible');
  assert.ok(!(await folderNames(P1)).includes('Intern-Projekt'));
  assert.ok(!(await folderNames(GUEST)).includes('Mein Kursprojekt'), 'an empty project of somebody else is not shown to a guest');
  assert.ok((await folderNames(STAFF)).includes('Altbestand'));
  assert.ok(!(await folderNames(P2)).includes('Mein Kursprojekt'), 'even an empty project stays with its creator');
  for (const [method, url, json] of [
    ['GET', '/api/folders/Altbestand/profile'],
    ['GET', '/api/folders/Altbestand/cast'],
    ['PATCH', '/api/folders/Altbestand', { name: 'Anders' }],
    ['DELETE', '/api/folders/Altbestand'],
    ['GET', '/api/folders/Intern-Projekt/profile']
  ]) {
    assert.equal((await call(P1, method, url, json)).status, 404, `${method} ${url}`);
  }
  assert.equal((await call(P1, 'POST', '/api/sessions', { folder: 'Altbestand' })).status, 404, 'no chat into a hidden project');
  const inMine = await call(P1, 'POST', '/api/sessions', { folder: 'Mein Kursprojekt' });
  assert.equal(inMine.status, 201);
  assert.equal((await call(P1, 'GET', '/api/folders/Mein%20Kursprojekt/profile')).status, 200);
  assert.equal((await call(P1, 'GET', '/api/folders/Mein%20Kursprojekt/cast')).status, 200);
  assert.equal((await call(P2, 'GET', '/api/folders/Mein%20Kursprojekt/profile')).status, 404);
  // the production profile (guidelines, context files, brandings) of a project is admin data: participants see none of it
  await api('/api/folders/Mein%20Kursprojekt/profile', { method: 'PUT', as: ADMIN, json: { guidelines: 'Geheime Hausregeln' } });
  const profile = (await call(P1, 'GET', '/api/folders/Mein%20Kursprojekt/profile')).body.profile;
  assert.ok(JSON.stringify(profile).includes('Geheime Hausregeln'), 'the creator of a project sees its profile');
  // a project with admin data (profile) is renamed and deleted by admins only, as for everybody else
  assert.equal((await call(P1, 'PATCH', '/api/folders/Mein%20Kursprojekt', { name: 'Umbenannt' })).status, 403);
  assert.equal((await call(P1, 'POST', '/api/folders', { name: 'Wegwerf-Projekt' })).status, 201);
  assert.equal((await call(P1, 'PATCH', '/api/folders/Wegwerf-Projekt', { name: 'Umbenannt' })).status, 200, 'own project: rename');
  assert.equal((await call(P1, 'DELETE', '/api/folders/Umbenannt')).status, 200);
  const cast = await call(P1, 'GET', '/api/folders/Mein%20Kursprojekt/cast');
  assert.ok([200, 404].includes(cast.status));
  // sessions of a project shared with a team make the project visible, with only what they may see
  const shareFolder = (await call(P1, 'POST', '/api/folders', { name: 'Teamprojekt' })).status;
  assert.equal(shareFolder, 201);
  const teamChat = (await call(P1, 'POST', '/api/sessions', { folder: 'Teamprojekt' })).body.session;
  await share(api, 'sessions', teamChat.id, P1, { shareMode: 'teams', sharedTeams: [teamA.id] });
  const p2Folders = (await api('/api/folders', { as: P2 })).body.folders.find((entry) => entry.name === 'Teamprojekt');
  assert.ok(p2Folders, 'a project holding a chat shared with them is visible');
  assert.equal(p2Folders.sessionCount, 1);
  assert.equal((await call(P2, 'GET', '/api/folders/Teamprojekt/cast')).body.members?.length ?? 0, 0, 'the cast of a foreign project is not shown');
  await api('/api/folders/Teamprojekt/profile', { method: 'PUT', as: ADMIN, json: { guidelines: 'Geheime Hausregeln' } });
  assert.ok(JSON.stringify((await call(P2, 'GET', '/api/folders/Teamprojekt/profile')).body.profile).includes('Geheime Hausregeln') === false, 'no house guidelines in a foreign project');
  assert.ok(JSON.stringify((await call(P1, 'GET', '/api/folders/Teamprojekt/profile')).body.profile).includes('Geheime Hausregeln'));
  assert.equal((await call(P2, 'DELETE', '/api/folders/Teamprojekt')).status, 403);

  // own: costs
  await ctx.costsLib.recordCost({ ts: new Date().toISOString(), sessionId: ctx.chat.id, type: 'image', model: 'm', cost: 0.5, user: P1 });
  await ctx.costsLib.recordCost({ ts: new Date().toISOString(), sessionId: ctx.chat.id, type: 'image', model: 'm', cost: 0.25, user: P2 });
  const p1Costs = (await call(P1, 'GET', '/api/costs/summary')).body;
  assert.equal(p1Costs.scope, 'own');
  assert.equal(p1Costs.total, 0.5, 'only their own costs');
  assert.deepEqual(p1Costs.byUser.map((entry) => entry.user.toLowerCase()), [P1]);
  assert.equal(p1Costs.mine.total, 0.5);
  assert.equal((await call(P2, 'GET', '/api/costs/summary')).body.total, 0.25);
  assert.equal((await call(GUEST, 'GET', '/api/costs/summary')).body.total, 0);
  assert.ok((await api('/api/costs/summary', { as: ADMIN })).body.total >= 0.75, 'admins see everything');
}

/* ---------- budget: chat ---------- */

const CHAT_STREAM = (cost, text = 'Hallo Kurs') =>
  new Response(sse([{ choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [], usage: { cost } }]).concat('data: [DONE]\n\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

async function statusOf(api, email) {
  return (await api('/api/me', { as: email })).body.budget;
}

async function testBudgetChat(ctx) {
  const { api, call, or, costsLib } = ctx;
  // a clean count for P2 (P1's test costs are on record already)
  const chat = (await call(P2, 'POST', '/api/sessions', {})).body.session;
  const start = await statusOf(api, P2);
  assert.equal(start.spentUsd, 0.25, 'the cost row of P2 from before counts');
  let calls = 0;
  patch(or, 'chatStream', async () => {
    calls += 1;
    return CHAT_STREAM(0.5);
  });
  const reply = await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'Hallo' });
  assert.equal(reply.status, 200);
  assert.match(reply.text, /Hallo Kurs/);
  assert.match(reply.text, /"type":"done"/);
  assert.equal(calls, 1);
  await waitFor(async () => (await statusOf(api, P2)).spentUsd === 0.75, { message: 'the chat cost of P2' });
  const rows = (await costsLib.readCosts()).filter((row) => row.user === P2);
  assert.ok(rows.length >= 2 && rows.every((row) => row.user === P2), 'every cost row carries the person');
  const chatRow = rows.find((row) => row.type === 'brain' || row.type === 'chat' || row.sessionId === chat.id);
  assert.ok(chatRow, 'the chat turn was journaled');

  // used up: the message is refused with 402 before the stream, chats and results stay available
  await ctx.costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: 10, user: P2 });
  const used = await statusOf(api, P2);
  assert.equal(used.remainingUsd, 0);
  const refused = await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'noch eins' });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'BUDGET_EXHAUSTED');
  assert.equal(refused.body.budget.limitUsd, 10);
  assert.match(refused.body.error, /Budget/);
  assert.equal(calls, 1, 'the model was not called');
  assert.equal((await call(P2, 'GET', `/api/sessions/${chat.id}`)).status, 200, 'the chat itself stays readable');
  assert.equal((await call(P2, 'POST', '/api/sessions', {})).status, 201, 'creating chats stays possible');

  // the team amount is raised, an override is set, the count is reset: paid work is possible again
  await api(`/api/teams/${ctx.teamA.id}`, { method: 'PATCH', as: ADMIN, json: { budgetUsd: 20 } });
  assert.equal((await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'ok' })).status, 200);
  await api(`/api/teams/${ctx.teamA.id}`, { method: 'PATCH', as: ADMIN, json: { budgetUsd: 10 } });
  assert.equal((await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'ok' })).status, 402);
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: 30 } });
  assert.equal((await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'ok' })).status, 200);
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: null } });
  assert.equal((await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'ok' })).status, 402);
  await sleep(1100); // the count restarts at a later second than the last cost row
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(P2)}`, { method: 'PATCH', as: ADMIN, json: { resetBudget: true } });
  const fresh = await statusOf(api, P2);
  assert.equal(fresh.spentUsd, 0);
  assert.equal(fresh.remainingUsd, 10);
  assert.equal((await call(P2, 'POST', `/api/sessions/${chat.id}/message`, { text: 'ok' })).status, 200);
  await waitFor(async () => (await statusOf(api, P2)).spentUsd > 0, { message: 'the fresh count' });

  // a second team: the highest amount counts, a person in two teams has the better budget
  const pab = await statusOf(api, PAB);
  assert.equal(pab.limitUsd, 10);
  await api(`/api/teams/${ctx.teamB.id}`, { method: 'PATCH', as: ADMIN, json: { budgetUsd: 50 } });
  assert.equal((await statusOf(api, PAB)).limitUsd, 50);
  await api(`/api/teams/${ctx.teamB.id}`, { method: 'PATCH', as: ADMIN, json: { budgetUsd: 4 } });

  // guests have no budget: paid actions and chat turns are refused, everything else works
  const guestChat = (await api('/api/sessions', { method: 'POST', as: GUEST, json: {} })).body.session;
  const guestMessage = await call(GUEST, 'POST', `/api/sessions/${guestChat.id}/message`, { text: 'hi' });
  assert.equal(guestMessage.status, 402);
  assert.equal(guestMessage.body.code, 'BUDGET_EXHAUSTED');
  assert.equal(guestMessage.body.budget.limitUsd, 0);

  // internal people and admins: no budget, whatever the journal says
  await ctx.costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: 9999, user: STAFF });
  const staffChat = (await api('/api/sessions', { method: 'POST', as: STAFF, json: {} })).body.session;
  assert.equal((await api(`/api/sessions/${staffChat.id}/message`, { method: 'POST', as: STAFF, json: { text: 'hi' } })).status, 200);
  const adminChat = (await api('/api/sessions', { method: 'POST', as: ADMIN, json: {} })).body.session;
  assert.equal((await api(`/api/sessions/${adminChat.id}/message`, { method: 'POST', as: ADMIN, json: { text: 'hi' } })).status, 200);
  restoreAll();
}

/* ---------- budget: Director tools ---------- */

async function testBudgetTools(ctx) {
  const { api, tools, or, costsLib, budget: budgetLib, teamsLib, store } = ctx;
  const chat = (await api('/api/sessions', { method: 'POST', as: PAB, json: {} })).body.session;
  const events = [];
  const run = (email, name, args, extra = {}) => tools.executeTool({ sessionId: chat.id, config: { imageModel: 'test/image', videoModel: 'test/video' }, emit: (event) => events.push(event), user: email, ...extra }, name, args);
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return null;
  };

  // tool list of a participant: no Higgsfield, no GTS, no branding/cast admin tools that touch internal data
  const definitions = (email) => tools.toolDefinitions(iso_viewer(ctx, email)).map((entry) => entry.function.name);
  const staffNames = definitions(STAFF);
  const p1Names = definitions(P1);
  assert.ok(p1Names.includes('generate_image') && p1Names.includes('generate_video'));
  for (const name of p1Names) assert.ok(!/higgsfield/.test(name), `${name} is not offered to participants`);
  assert.ok(p1Names.length < staffNames.length || !staffNames.some((name) => /higgsfield|gts/.test(name)), 'the participant list is a subset of the internal list');
  assert.ok(!p1Names.includes('import_gts_asset'));

  // Higgsfield tools are refused even if called directly
  for (const name of ['higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_models', 'higgsfield_check_balance', 'import_gts_asset']) {
    const error = await errorOf(run(PAB, name, { prompt: 'x' }));
    assert.equal(error?.code, 'FORBIDDEN_FOR_ROLE', name);
  }

  // an image: the cost is journaled for the person, the budget shrinks
  const before = (await budgetLib.statusOfEmail(PAB)).spentUsd;
  let providerCalls = 0;
  patch(or, 'createImage', async () => {
    providerCalls += 1;
    return imageResult(0.6);
  });
  const image = await run(PAB, 'generate_image', { prompt: 'Eine Tasse' });
  assert.match(image.toolResult, /Bild erzeugt/);
  assert.equal(providerCalls, 1);
  const rows = (await costsLib.readCosts()).filter((row) => row.user === PAB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.6);
  assert.ok(Math.abs((await budgetLib.statusOfEmail(PAB)).spentUsd - before - 0.6) < 1e-9);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'nothing stays reserved after a finished call');

  // a failing provider call leaves no reservation and no cost
  patch(or, 'createImage', async () => {
    throw new Error('provider hiccup');
  });
  assert.match((await errorOf(run(PAB, 'generate_image', { prompt: 'x' }))).message, /provider hiccup/);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);

  // used up: every paid tool is refused before the provider is called
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: 100, user: PAB });
  providerCalls = 0;
  patch(or, 'createImage', async () => {
    providerCalls += 1;
    return imageResult(0.1);
  });
  let videoCalls = 0;
  patch(or, 'createVideo', async () => {
    videoCalls += 1;
    return { id: 'job-1', polling_url: 'http://127.0.0.1:1/x', status: 'pending' };
  });
  const asset = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'ref', cost: null });
  const paid = [
    ['generate_image', { prompt: 'x' }],
    ['edit_image', { prompt: 'x', reference_asset_ids: [asset.id] }],
    ['generate_video', { prompt: 'x' }],
    ['generate_speech', { text: 'x' }],
    ['fal_generate', { endpoint: 'fal-ai/x', input: { prompt: 'x' } }]
  ];
  for (const [name, args] of paid) {
    const error = await errorOf(run(PAB, name, args, name === 'fal_generate' ? { nodeView: true } : {}));
    assert.ok(error instanceof budgetLib.BudgetError, `${name}: ${error && error.message}`);
    assert.equal(error.code, 'BUDGET_EXHAUSTED', name);
    assert.equal(error.status, 402);
  }
  assert.equal(providerCalls, 0, 'no image call was made');
  assert.equal(videoCalls, 0, 'no video call was made');

  // tools that cost nothing stay available when the budget is used up
  assert.ok(!((await errorOf(run(PAB, 'list_voices', {})))?.code || '').startsWith('BUDGET'), 'no budget error for a free tool');

  // reset: paid work is possible again; where a price is known it has to fit (fal_generate estimate)
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  const fresh = await budgetLib.statusOfEmail(PAB);
  assert.equal(fresh.spentUsd, 0);
  const tooExpensive = await errorOf(run(PAB, 'fal_generate', { endpoint: 'fal-ai/x', input: { prompt: 'x' }, estimateUsd: 10.5 }, { nodeView: true }));
  assert.equal(tooExpensive.code, 'BUDGET_INSUFFICIENT');
  assert.equal(tooExpensive.estimateUsd, 10.5);
  assert.equal(tooExpensive.remainingUsd, 10);
  // fits: the call goes on (and stops at the missing key), the reservation is released
  const fits = await errorOf(run(PAB, 'fal_generate', { endpoint: 'fal-ai/x', input: { prompt: 'x' }, estimateUsd: 2 }, { nodeView: true }));
  assert.ok(fits && !fits.code, 'not a budget error');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  // a video has no price up front: a flat amount stays reserved for the job until the poller books the cost
  const video = await errorOf(run(PAB, 'generate_video', { prompt: 'Ein Video' }));
  assert.equal(videoCalls, 1, video && video.message);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 1, 'the job keeps its reservation');
  assert.equal((await budgetLib.statusOfEmail(PAB)).reservedUsd, 2);
  const openJobs = async () => (await store.readSession(chat.id)).jobs.filter((job) => job.budgetKey);
  let jobs = await openJobs();
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].budgetKey, /^hold:/);
  assert.equal(jobs[0].reservedUsd, 2);
  // "make 10 variants as video": at most two provider jobs are open at once, the rest is refused before the provider is called
  await run(PAB, 'generate_video', { prompt: 'Ein zweites Video' });
  assert.equal(videoCalls, 2);
  const third = await errorOf(run(PAB, 'generate_video', { prompt: 'Ein drittes Video' }));
  assert.equal(third.code, 'BUDGET_JOBS_OPEN');
  assert.equal(third.status, 429);
  assert.equal(videoCalls, 2, 'the provider was not called for the third');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 2);
  // a call that fails at the provider leaves nothing behind
  jobs = await openJobs();
  for (const job of jobs) budgetLib.settleJob(job, 1); // the poller books the costs
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  patch(or, 'createVideo', async () => {
    throw new Error('provider hiccup');
  });
  assert.match((await errorOf(run(PAB, 'generate_video', { prompt: 'x' }))).message, /provider hiccup/);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'a failed start releases its reservation');
  // a small rest: the flat reservation is capped by it, so the next video is refused at once
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: (await budgetLib.statusOfEmail(PAB)).remainingUsd - 0.05, user: PAB });
  patch(or, 'createVideo', async () => {
    videoCalls += 1;
    return { id: 'job-9', polling_url: 'http://127.0.0.1:1/x', status: 'pending' };
  });
  await run(PAB, 'generate_video', { prompt: 'Das letzte Video' });
  assert.ok(Math.abs((await budgetLib.statusOfEmail(PAB)).reservedUsd - 0.05) < 1e-9);
  const noMore = await errorOf(run(PAB, 'generate_video', { prompt: 'Noch eins' }));
  assert.equal(noMore.code, 'BUDGET_EXHAUSTED');
  for (const job of await openJobs()) budgetLib.settleJob(job, 0.05);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });

  // speech is priced per character: reserved, booked as a cost of the person and visible in the journal
  const elevenlabs = ctx.iso.load('lib/elevenlabs');
  let speechCalls = 0;
  patch(elevenlabs, 'hasKey', () => true);
  patch(elevenlabs, 'tts', async () => {
    speechCalls += 1;
    return Buffer.from('mp3');
  });
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  const speech = await run(PAB, 'generate_speech', { text: 'x'.repeat(1000) });
  assert.match(speech.toolResult, /Sprache erzeugt/);
  assert.equal(speech.asset.cost, 0.3);
  const speechRows = (await costsLib.readCosts()).filter((row) => row.user === PAB && row.type === 'speech');
  assert.equal(speechRows.length, 1);
  assert.equal(speechRows[0].cost, 0.3);
  assert.match(speechRows[0].model, /^elevenlabs\//);
  assert.ok(Math.abs((await budgetLib.statusOfEmail(PAB)).spentUsd - 0.3) < 1e-9, 'it counts against the budget');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  // a small rest does not buy long speech
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: (await budgetLib.statusOfEmail(PAB)).remainingUsd - 0.01, user: PAB });
  const tooLong = await errorOf(run(PAB, 'generate_speech', { text: 'x'.repeat(2000) }));
  assert.equal(tooLong.code, 'BUDGET_INSUFFICIENT');
  assert.equal(speechCalls, 1, 'the provider was not called');
  // internal people have no budget, but the estimate is booked for them, too: the cost overview shows what ElevenLabs costs
  const staffSpeech = await run(STAFF, 'generate_speech', { text: 'Hallo' });
  assert.equal(staffSpeech.asset.cost, 0.0015);
  const staffRows = (await costsLib.readCosts()).filter((row) => row.user === STAFF && row.type === 'speech');
  assert.equal(staffRows.length, 1);
  assert.deepEqual([staffRows[0].cost, staffRows[0].billing], [0.0015, 'Schaetzung (Zeichen)']);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'and nothing is reserved for them');

  // music is priced by the minute (ELEVENLABS_MUSIC_USD_PER_MIN, default 0.20): the estimate is reserved before the call,
  // booked as music with the person, and the tool is for the node view only. The song plan is free and never booked.
  let musicCalls = 0;
  let planCalls = 0;
  patch(elevenlabs, 'composeMusic', async () => {
    musicCalls += 1;
    return Buffer.from('mp3');
  });
  patch(elevenlabs, 'planMusic', async () => {
    planCalls += 1;
    return { chunks: [{ text: '[Verse]\nla la', duration_ms: 10000, positive_styles: ['pop'] }] };
  });
  const musicArgs = { prompt: 'calm piano', length_seconds: 30 };
  const nodeView = { nodeView: true };
  // the Director does not get it, whoever asks
  for (const name of ['generate_music', 'plan_music']) {
    assert.match((await errorOf(run(PAB, name, musicArgs))).message, /nur in der Node-Ansicht/);
    assert.ok(!definitions(PAB).includes(name) && !definitions(STAFF).includes(name));
  }
  // a small rest does not buy music: refused with the estimate, before ElevenLabs is called, nothing reserved
  const tooSmall = await errorOf(run(PAB, 'generate_music', musicArgs, nodeView));
  assert.equal(tooSmall.code, 'BUDGET_INSUFFICIENT');
  assert.ok(Math.abs(tooSmall.estimateUsd - 0.1) < 1e-9, '30 s at 0.20 USD per minute');
  assert.equal(musicCalls, 0, 'ElevenLabs was not called');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  // the estimate is reserved while ElevenLabs works and booked afterwards
  let reservedDuring = null;
  patch(elevenlabs, 'composeMusic', async () => {
    musicCalls += 1;
    reservedDuring = (await budgetLib.statusOfEmail(PAB)).reservedUsd;
    return Buffer.from('mp3');
  });
  const song = await run(PAB, 'generate_music', musicArgs, nodeView);
  assert.match(song.toolResult, /Musik erzeugt/);
  assert.ok(Math.abs(reservedDuring - 0.1) < 1e-9, 'reserved during the call');
  assert.equal(song.asset.cost, 0.1);
  const musicRows = (await costsLib.readCosts()).filter((row) => row.user === PAB && row.type === 'music');
  assert.equal(musicRows.length, 1);
  assert.deepEqual([musicRows[0].cost, musicRows[0].billing, musicRows[0].model, musicRows[0].assetId], [0.1, 'Schaetzung (Dauer)', 'elevenlabs/music_v2_5', song.asset.id]);
  assert.ok(Math.abs((await budgetLib.statusOfEmail(PAB)).spentUsd - 0.1) < 1e-9, 'it counts against the budget');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  // a plan from the song text sets the price (35 s), a failing call leaves nothing behind
  const planArgs = { plan_text: '[Verse | 20 s]\nla\n\n[Chorus | 15 s]\nla la', model_id: 'music_v1' };
  assert.ok(Math.abs(tools.toolEstimateUsd('generate_music', planArgs) - 0.116667) < 1e-9);
  assert.equal(tools.toolEstimateUsd('generate_music', { prompt: 'x' }), null, 'no length: unknown');
  assert.equal(tools.toolEstimateUsd('plan_music', { prompt: 'x' }), null, 'the plan is not priced');
  patch(elevenlabs, 'composeMusic', async () => {
    throw new Error('provider hiccup');
  });
  assert.match((await errorOf(run(PAB, 'generate_music', planArgs, nodeView))).message, /provider hiccup/);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'a failed call releases its reservation');
  assert.equal((await costsLib.readCosts()).filter((row) => row.user === PAB && row.type === 'music').length, 1, 'and books nothing');
  // the song plan: allowed, not reserved, not booked
  const spentBeforePlan = (await budgetLib.statusOfEmail(PAB)).spentUsd;
  const outline = await run(PAB, 'plan_music', { prompt: 'a calm song', length_seconds: 20 }, nodeView);
  assert.equal(outline.planText, '[Verse | 10 s]\n+ pop\nla la');
  assert.equal(planCalls, 1);
  assert.equal((await budgetLib.statusOfEmail(PAB)).spentUsd, spentBeforePlan);
  assert.equal((await costsLib.readCosts()).filter((row) => row.user === PAB && row.type === 'music').length, 1);
  // internal people: booked without a budget, nothing reserved
  patch(elevenlabs, 'composeMusic', async () => {
    musicCalls += 1;
    return Buffer.from('mp3');
  });
  const staffSong = await run(STAFF, 'generate_music', { prompt: 'x', length_seconds: 60 }, nodeView);
  assert.equal(staffSong.asset.cost, 0.2);
  assert.deepEqual((await costsLib.readCosts()).filter((row) => row.user === STAFF && row.type === 'music').map((row) => row.cost), [0.2]);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  // guests have no budget: no music, but the free plan works
  assert.equal((await errorOf(run(GUEST, 'generate_music', musicArgs, nodeView))).code, 'BUDGET_EXHAUSTED');
  assert.equal((await run(GUEST, 'plan_music', { prompt: 'a calm song' }, nodeView)).planText.startsWith('[Verse'), true);

  // an image node with a model of its own passes the price of that model (imageEstimateUsd, WP28): reserved while the provider
  // works and booked afterwards; where the rest does not cover it the call is refused before the provider is called. The
  // chat knows no price (no estimate): anything left is enough, as before.
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  let imageReserved = null;
  let imageProviderCalls = 0;
  patch(or, 'createImage', async (payload) => {
    imageProviderCalls += 1;
    imageReserved = (await budgetLib.statusOfEmail(PAB)).reservedUsd;
    assert.equal(payload.model, 'google/gemini-3-pro-image', 'the model of the node reaches the provider');
    return imageResult(0.139);
  });
  const imageConfig = { config: { imageModel: 'test/image', videoModel: 'test/video' } };
  const priced = await run(PAB, 'generate_image', { prompt: 'Eine Tasse' }, { config: { ...imageConfig.config, imageModel: 'google/gemini-3-pro-image' }, imageEstimateUsd: 0.134 });
  assert.match(priced.toolResult, /Bild erzeugt/);
  assert.ok(Math.abs(imageReserved - 0.134) < 1e-9, 'the estimate of the model is reserved during the call');
  assert.equal(priced.asset.model, 'google/gemini-3-pro-image');
  const imageRows = (await costsLib.readCosts()).filter((row) => row.user === PAB && row.type === 'image' && row.model === 'google/gemini-3-pro-image');
  assert.deepEqual(imageRows.map((row) => row.cost), [0.139], 'the cost of the model that made the image');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: (await budgetLib.statusOfEmail(PAB)).remainingUsd - 0.1, user: PAB });
  imageProviderCalls = 0;
  const tooDear = await errorOf(run(PAB, 'generate_image', { prompt: 'Eine Tasse' }, { config: { ...imageConfig.config, imageModel: 'google/gemini-3-pro-image' }, imageEstimateUsd: 0.134 }));
  assert.equal(tooDear.code, 'BUDGET_INSUFFICIENT');
  assert.equal(tooDear.estimateUsd, 0.134);
  assert.equal(imageProviderCalls, 0, 'the provider was not called');
  const tooDearEdit = await errorOf(run(PAB, 'edit_image', { prompt: 'Mach es blau', reference_asset_ids: [asset.id] }, { config: { ...imageConfig.config, imageModel: 'google/gemini-3-pro-image' }, imageEstimateUsd: 0.134 }));
  assert.equal(tooDearEdit.code, 'BUDGET_INSUFFICIENT');
  assert.equal(imageProviderCalls, 0);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  const unpriced = await run(PAB, 'generate_image', { prompt: 'Eine Tasse' }, { config: { ...imageConfig.config, imageModel: 'google/gemini-3-pro-image' } });
  assert.match(unpriced.toolResult, /Bild erzeugt/, 'no price known: anything left is enough');
  assert.equal(imageProviderCalls, 1);
  // background removal with fal: its list price per image is the estimate; it fits a small rest, a smaller one is refused
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  const removeArgs = { endpoint: 'fal-ai/bria/background/remove', input: {}, media: [{ field: 'image_url', assetIds: [asset.id] }], kind: 'image', estimateUsd: 0.018 };
  const cutout = await errorOf(run(PAB, 'fal_generate', removeArgs, nodeView));
  assert.ok(cutout && !cutout.code, `not a budget error (stops at the missing key): ${cutout && cutout.message}`);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: (await budgetLib.statusOfEmail(PAB)).remainingUsd - 0.01, user: PAB });
  const noCutout = await errorOf(run(PAB, 'fal_generate', removeArgs, nodeView));
  assert.equal(noCutout.code, 'BUDGET_INSUFFICIENT');
  assert.equal(noCutout.estimateUsd, 0.018);
  // a video node with a model of its own passes the estimate of that model (videoEstimateUsd, WP28 part 2): it stays reserved for
  // the job until the poller books the cost, the job remembers it; where the rest does not cover it the call is refused before
  // the provider is called (the same rule as the click on a model card of the chat); a price that is not known needs anything left
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  const klingOption = { id: VIDEO_KLING, name: 'Kling v3.0 Standard', estimateUsd: 0.63, price: { minTotal: 0.42, maxTotal: 0.63 } };
  const videoNode = { nodeView: true, config: { imageModel: 'test/image', videoModel: VIDEO_KLING }, videoOption: klingOption, videoEstimateUsd: 0.63 };
  let nodeVideoCalls = 0;
  patch(or, 'createVideo', async (payload) => {
    nodeVideoCalls += 1;
    assert.equal(payload.model, VIDEO_KLING, 'the model of the node reaches the provider');
    return { id: `node-job-${nodeVideoCalls}`, polling_url: 'http://127.0.0.1:1/x', status: 'pending' };
  });
  await run(PAB, 'generate_video', { prompt: 'Ein Spaziergang', mode: 'text_to_video', duration_seconds: 5 }, videoNode);
  assert.equal(nodeVideoCalls, 1);
  assert.ok(Math.abs((await budgetLib.statusOfEmail(PAB)).reservedUsd - 0.63) < 1e-9, 'the estimate of the model stays reserved for the job');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 1);
  const nodeJob = (await store.readSession(chat.id)).jobs.find((job) => job.jobId === 'node-job-1');
  assert.deepEqual([nodeJob.model, nodeJob.modelName, nodeJob.estimateUsd, nodeJob.reservedUsd], [VIDEO_KLING, 'Kling v3.0 Standard', 0.63, 0.63]);
  assert.deepEqual(nodeJob.estimateMinUsd, 0.42);
  assert.match(nodeJob.budgetKey, /^hold:/);
  budgetLib.settleJob(nodeJob, 0.5);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'booked: nothing stays reserved');
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: chat.id, type: 'image', model: 'm', cost: (await budgetLib.statusOfEmail(PAB)).remainingUsd - 0.5, user: PAB });
  const tooDearVideo = await errorOf(run(PAB, 'generate_video', { prompt: 'Noch ein Spaziergang', mode: 'text_to_video', duration_seconds: 5 }, videoNode));
  assert.equal(tooDearVideo.code, 'BUDGET_INSUFFICIENT');
  assert.equal(tooDearVideo.estimateUsd, 0.63);
  assert.equal(tooDearVideo.status, 402);
  assert.equal(nodeVideoCalls, 1, 'the provider was not called');
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  const unpricedVideo = await run(PAB, 'generate_video', { prompt: 'Noch ein Spaziergang', mode: 'text_to_video', duration_seconds: 5 }, { ...videoNode, videoOption: { id: VIDEO_KLING, name: 'Kling v3.0 Standard' }, videoEstimateUsd: undefined });
  assert.equal(nodeVideoCalls, 2, 'no price known: anything left is enough');
  for (const job of (await store.readSession(chat.id)).jobs.filter((entry) => entry.budgetKey)) budgetLib.settleJob(job, 0.1);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  assert.ok(unpricedVideo.job);
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  // the same nodes for everybody: the registry and the model lists do not differ between participants and internal people
  const registryOf = async (email) => (await api('/api/nodes/registry', { as: email })).body;
  const staffRegistry = await registryOf(STAFF);
  const p1Registry = await registryOf(PAB);
  for (const type of ['image.generate', 'image.edit', 'fal.remove_background', 'video.generate']) {
    const forStaff = staffRegistry.nodeTypes.find((item) => item.type === type);
    const forParticipant = p1Registry.nodeTypes.find((item) => item.type === type);
    assert.ok(forStaff && forParticipant, type);
    assert.equal(forParticipant.restricted, undefined, `${type} is not closed for participants`);
    assert.equal(forParticipant.available === true, forStaff.available === true, `${type}: same availability`);
  }
  for (const source of ['image-models', 'image-edit-models', 'video-models']) {
    const forStaff = await api(`/api/nodes/options/${source}`, { as: STAFF });
    const forParticipant = await api(`/api/nodes/options/${source}`, { as: PAB });
    const forGuest = await api(`/api/nodes/options/${source}`, { as: GUEST });
    assert.equal(forStaff.status, 200, source);
    assert.equal(forParticipant.status, 200, source);
    assert.equal(forGuest.status, 200, source);
    assert.deepEqual(forParticipant.body.options, forStaff.body.options, `${source}: the same list for participants`);
    assert.deepEqual(forGuest.body.options, forStaff.body.options, `${source}: and for guests`);
    assert.equal(forStaff.body.options[0].value, '');
    if (source === 'video-models') {
      // the models of the chat (the configured one and the curated list the provider knows), with what each takes
      const kling = forParticipant.body.options.find((item) => item.value === VIDEO_KLING);
      assert.ok(kling && kling.last_frame.max === 1 && kling.references.max === 0, 'Kling takes an end frame and no references');
      assert.ok(forParticipant.body.options.some((item) => item.value === VIDEO_SEEDANCE));
      assert.ok(forParticipant.body.options.every((item) => item.value === '' || [VIDEO_SEEDANCE, VIDEO_KLING].includes(item.value)));
    }
  }
  await sleep(1100);
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });
  restoreAll();
  patch(or, 'createVideo', async () => ({ id: 'job-x', polling_url: 'http://127.0.0.1:1/x', status: 'pending' }));
  teamsLib.defaultStore.updateMember(ctx.teamA.id, PAB, { resetBudget: true });

  // the cast of a project belongs to its owner: participants in a shared chat of somebody else cannot change it
  await store.claimFolder('fremdes-projekt', STAFF);
  await store.claimFolder('eigenes-projekt', PAB);
  await store.mutateSession(chat.id, (session) => {
    session.folder = 'fremdes-projekt';
  });
  for (const [name, args] of [['create_cast_member', { name: 'Mara' }], ['update_cast_member', { member_id: 'cast-1' }], ['import_cast_asset', { member: 'Mara', asset: 'voice' }]]) {
    const error = await errorOf(run(PAB, name, args));
    assert.equal(error?.code, 'FORBIDDEN_FOR_ROLE', name);
    assert.equal(error.feature, 'cast');
  }
  assert.equal((await errorOf(run(GUEST, 'create_cast_member', { name: 'Mara' })))?.code, 'FORBIDDEN_FOR_ROLE');
  await store.mutateSession(chat.id, (session) => {
    session.folder = 'eigenes-projekt';
  });
  const ownCast = await errorOf(run(PAB, 'create_cast_member', { name: 'Mara' }));
  assert.notEqual(ownCast?.code, 'FORBIDDEN_FOR_ROLE', 'in the own project the cast tools work as before');
  assert.equal((await errorOf(run(STAFF, 'create_cast_member', { name: '' })))?.code === 'FORBIDDEN_FOR_ROLE', false, 'internal people are not restricted');
  await store.mutateSession(chat.id, (session) => {
    session.folder = '';
  });

  // guests
  const guestError = await errorOf(run(GUEST, 'generate_image', { prompt: 'x' }));
  assert.equal(guestError.code, 'BUDGET_EXHAUSTED');
  // internal people: no check at all
  patch(or, 'createImage', async () => imageResult(0.2));
  assert.match((await run(STAFF, 'generate_image', { prompt: 'x' })).toolResult, /Bild erzeugt/);
  assert.equal((await costsLib.readCosts()).filter((row) => row.user === STAFF).length >= 1, true);
  restoreAll();

  // an async job with a price up front keeps its reservation until the cost is booked
  const held = await budgetLib.begin(iso_viewer(ctx, PAB), { estimateUsd: 3, label: 'generate_video' });
  assert.equal((await budgetLib.statusOfEmail(PAB)).reservedUsd, 3);
  budgetLib.settleJob({ budgetKey: held.jobKey }, 1.25);
  assert.equal((await budgetLib.statusOfEmail(PAB)).reservedUsd, 0);
  assert.ok(events.some((event) => event.type === 'asset'), 'the image tool announced its asset');
}

function iso_viewer(ctx, email) {
  return ctx.iso.load('lib/access').viewerOf({ kubleUser: email }, process.env);
}

/* ---------- budget: node runs ---------- */

async function testBudgetNodes(ctx) {
  const { api, call, or, costsLib, teamsLib } = ctx;
  const graph = (type = 'image.generate') => ({
    nodes: [node('txt', 'input.text', { text: 'Eine Tasse' }, 0, 0), node('gen', type, type === 'image.higgsfield' ? { model: 'test-model' } : {}, 300, 0), node('out', 'output.result', { label: 'Ergebnis' }, 600, 0)],
    edges: [
      { id: 'e1', from: { node: 'txt', port: 'text' }, to: { node: 'gen', port: 'prompt' } },
      { id: 'e2', from: { node: 'gen', port: type.startsWith('video') ? 'video' : 'image' }, to: { node: 'out', port: 'inputs' } }
    ],
    groups: [],
    notes: []
  });
  const person = 'runner@gmail.example';
  await api(`/api/teams/${ctx.teamA.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [person] } });
  const flow = (await call(person, 'POST', '/api/workflows', { name: 'Lauf' })).body.workflow;
  assert.equal((await call(person, 'PUT', `/api/workflows/${flow.id}`, { baseRev: 1, graph: graph() })).status, 200);
  let generated = 0;
  patch(or, 'createImage', async () => {
    generated += 1;
    return imageResult(0.4);
  });

  // the plan of a participant carries the budget
  const plan = await call(person, 'POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.budget.limitUsd, 10);
  assert.equal(plan.body.budget.enough, true);
  assert.deepEqual(plan.body.blocked, []);
  assert.equal(plan.body.totals.paidNodes, 1);
  // ... and an internal person's plan does not
  const staffFlow = (await api('/api/workflows', { method: 'POST', as: STAFF, json: { name: 'Intern' } })).body.workflow;
  await api(`/api/workflows/${staffFlow.id}`, { method: 'PUT', as: STAFF, json: { baseRev: 1, graph: graph() } });
  const staffPlan = (await api(`/api/workflows/${staffFlow.id}/runs/plan`, { method: 'POST', as: STAFF, json: { mode: 'all' } })).body;
  assert.equal('budget' in staffPlan, false);
  assert.equal('blocked' in staffPlan, false);

  // first run: allowed while something is left; the paid call is journaled for the person
  const started = await call(person, 'POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
  assert.equal(started.status, 202, started.text);
  const finish = async (id, runId, email) =>
    waitFor(async () => {
      const run = (await api(`/api/workflows/${id}/runs/${runId}`, { as: email })).body;
      return run && run.status !== 'running' ? run : null;
    }, { message: 'the run' });
  const done = await finish(flow.id, started.body.runId, person);
  assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 400));
  assert.equal(done.user, person);
  assert.equal(generated, 1);
  const journal = (await costsLib.readCosts()).filter((row) => row.user === person);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].cost, 0.4);
  assert.equal(ctx.budget.defaultBudget.reservationCount(), 0, 'the reservation of the run is released');
  const afterRun = (await api('/api/me', { as: person })).body.budget;
  assert.ok(Math.abs(afterRun.spentUsd - 0.4) < 1e-9);
  assert.equal(afterRun.reservedUsd, 0);

  // the plan now knows the price of this node type; a second workflow gets its price by a run of its own
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(person)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: 1.5 } });
  const secondFlow = (await call(person, 'POST', '/api/workflows', { name: 'Lauf 2' })).body.workflow;
  await call(person, 'PUT', `/api/workflows/${secondFlow.id}`, { baseRev: 1, graph: graph() });
  const secondRun = await call(person, 'POST', `/api/workflows/${secondFlow.id}/runs`, { mode: 'all' });
  assert.equal(secondRun.status, 202, secondRun.text);
  assert.equal((await finish(secondFlow.id, secondRun.body.runId, person)).status, 'completed');
  const tight = await call(person, 'POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all', force: true });
  assert.equal(tight.body.totals.usd, 0.4);
  assert.equal(tight.body.budget.enough, true);
  assert.ok(Math.abs(tight.body.budget.remainingUsd - 0.7) < 1e-9);

  // two runs at once against 0.7 USD left: the running one has reserved its 0.4, the second (0.4) no longer fits
  patch(or, 'createImage', async () => {
    generated += 1;
    await sleep(600);
    return imageResult(0.4);
  });
  const first = await call(person, 'POST', `/api/workflows/${flow.id}/runs`, { mode: 'all', force: true });
  assert.equal(first.status, 202, first.text);
  const outstanding = (await api('/api/me', { as: person })).body.budget;
  assert.ok(Math.abs(outstanding.reservedUsd - 0.4) < 1e-9, 'the running run has reserved its estimate');
  assert.ok(Math.abs(outstanding.remainingUsd - 0.3) < 1e-9);
  const crowded = await call(person, 'POST', `/api/workflows/${secondFlow.id}/runs`, { mode: 'all', force: true });
  assert.equal(crowded.status, 402);
  assert.equal(crowded.body.code, 'BUDGET_INSUFFICIENT');
  assert.ok(Math.abs(crowded.body.estimateUsd - 0.4) < 1e-9);
  assert.ok(Math.abs(crowded.body.remainingUsd - 0.3) < 1e-9);
  const crowdedPlan = await call(person, 'POST', `/api/workflows/${secondFlow.id}/runs/plan`, { mode: 'all', force: true });
  assert.equal(crowdedPlan.body.budget.enough, false);
  assert.equal(crowdedPlan.body.budget.code, 'BUDGET_INSUFFICIENT');
  await finish(flow.id, first.body.runId, person);
  restoreAll();
  patch(or, 'createImage', async () => {
    generated += 1;
    return imageResult(0.4);
  });
  const spent = (await api('/api/me', { as: person })).body.budget;
  assert.ok(Math.abs(spent.spentUsd - 1.2) < 1e-9);
  assert.equal(spent.reservedUsd, 0, 'the reservation ends with the run');
  assert.ok(Math.abs(spent.remainingUsd - 0.3) < 1e-9);
  assert.equal((await call(person, 'POST', `/api/workflows/${flow.id}/runs`, { mode: 'all', force: true })).body.code, 'BUDGET_INSUFFICIENT');

  // used up: nothing paid starts any more
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: flow.sessionId, type: 'image', model: 'm', cost: 5, user: person });
  const exhaustedPlan = await call(person, 'POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all', force: true });
  assert.equal(exhaustedPlan.body.budget.enough, false);
  assert.equal(exhaustedPlan.body.budget.code, 'BUDGET_EXHAUSTED');
  const refused = await call(person, 'POST', `/api/workflows/${flow.id}/runs`, { mode: 'all', force: true });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'BUDGET_EXHAUSTED');
  assert.equal(refused.body.remainingUsd, 0);
  const runsBefore = (await call(person, 'GET', `/api/workflows/${flow.id}/runs`)).body.runs.length;
  assert.equal((await call(person, 'POST', `/api/workflows/${flow.id}/runs`, { mode: 'all', force: true })).status, 402);
  assert.equal((await call(person, 'GET', `/api/workflows/${flow.id}/runs`)).body.runs.length, runsBefore, 'a refused run leaves no record');
  assert.equal((await call(person, 'PATCH', `/api/workflows/${flow.id}/results/none`, {})).status >= 400, true, '(the route answers; the node does not exist)');
  // nodes that are free still run; a workflow without a paid node is never refused
  const free = (await call(person, 'POST', '/api/workflows', { name: 'Gratis' })).body.workflow;
  await call(person, 'PUT', `/api/workflows/${free.id}`, {
    baseRev: 1,
    graph: { nodes: [node('txt', 'input.text', { text: 'nur Text' }), node('out', 'output.result', { label: 'R' }, 300, 0)], edges: [{ id: 'e1', from: { node: 'txt', port: 'text' }, to: { node: 'out', port: 'inputs' } }], groups: [], notes: [] }
  });
  const freeRun = await call(person, 'POST', `/api/workflows/${free.id}/runs`, { mode: 'all' });
  assert.equal(freeRun.status, 202, freeRun.text);
  assert.equal((await finish(free.id, freeRun.body.runId, person)).status, 'completed');
  // results of earlier runs stay downloadable when the budget is used up
  assert.equal((await call(person, 'GET', `/api/workflows/${flow.id}/outputs.zip`, undefined, { raw: true })).status, 200);
  assert.equal((await call(person, 'GET', `/api/workflows/${flow.id}/export`)).status, 200);

  // Higgsfield nodes: the plan lists them as blocked, the run is refused with 403 (before the budget)
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(person)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: 50 } });
  const hf = (await call(person, 'POST', '/api/workflows', { name: 'Higgsfield' })).body.workflow;
  await call(person, 'PUT', `/api/workflows/${hf.id}`, { baseRev: 1, graph: graph('image.higgsfield') });
  const hfPlan = await call(person, 'POST', `/api/workflows/${hf.id}/runs/plan`, { mode: 'all' });
  assert.equal(hfPlan.status, 200);
  assert.deepEqual(hfPlan.body.blocked, [{ nodeId: 'gen', feature: 'higgsfield' }]);
  assert.equal(hfPlan.body.nodes.gen.status, 'unavailable');
  const hfRun = await call(person, 'POST', `/api/workflows/${hf.id}/runs`, { mode: 'all' });
  assert.equal(hfRun.status, 403);
  assert.equal(hfRun.body.code, 'FORBIDDEN_FOR_ROLE');
  assert.equal(hfRun.body.feature, 'higgsfield');
  assert.equal(ctx.budget.defaultBudget.reservationCount(), 0);
  restoreAll();

  // the video node with a model choice is open for participants; its plan carries the estimate of the model (the upper end of
  // the price of the chat), a run that does not fit the budget is refused before the provider is called
  let videoStarts = 0;
  patch(or, 'createVideo', async () => {
    videoStarts += 1;
    return { id: `plan-job-${videoStarts}`, polling_url: 'http://127.0.0.1:1/x', status: 'pending' };
  });
  const videoGraph = (params) => {
    const base = graph('video.generate');
    return { ...base, nodes: base.nodes.map((item) => (item.id === 'gen' ? node('gen', 'video.generate', params, 300, 0) : item)) };
  };
  const vidFlow = (await call(person, 'POST', '/api/workflows', { name: 'Video mit Modell' })).body.workflow;
  assert.equal((await call(person, 'PUT', `/api/workflows/${vidFlow.id}`, { baseRev: 1, graph: videoGraph({ model: VIDEO_KLING, duration: 5 }) })).status, 200);
  const vidPlan = await call(person, 'POST', `/api/workflows/${vidFlow.id}/runs/plan`, { mode: 'all' });
  assert.equal(vidPlan.status, 200, vidPlan.text);
  assert.equal(vidPlan.body.nodes.gen.status !== 'unavailable', true);
  assert.deepEqual(vidPlan.body.blocked, []);
  assert.ok(Math.abs(vidPlan.body.nodes.gen.estimate.usd - 0.63) < 1e-9, 'Kling, 5 s: up to 0.126 per second');
  assert.equal(vidPlan.body.budget.enough, true);
  assert.ok(Math.abs(vidPlan.body.budget.estimateUsd - 0.63) < 1e-9);
  // a rest of 0.5 USD does not cover 0.63: the plan says so and the run is refused with the estimate
  const spentNow = (await ctx.budget.statusOfEmail(person)).spentUsd;
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(person)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: spentNow + 0.5 } });
  const dearPlan = await call(person, 'POST', `/api/workflows/${vidFlow.id}/runs/plan`, { mode: 'all' });
  assert.equal(dearPlan.body.budget.enough, false);
  assert.equal(dearPlan.body.budget.code, 'BUDGET_INSUFFICIENT');
  const dearRun = await call(person, 'POST', `/api/workflows/${vidFlow.id}/runs`, { mode: 'all' });
  assert.equal(dearRun.status, 402);
  assert.equal(dearRun.body.code, 'BUDGET_INSUFFICIENT');
  assert.ok(Math.abs(dearRun.body.estimateUsd - 0.63) < 1e-9);
  assert.equal(videoStarts, 0, 'the provider was not called');
  assert.equal(ctx.budget.defaultBudget.reservationCount(), 0);
  // a shorter clip of the same model fits: the estimate follows the duration
  assert.equal((await call(person, 'PUT', `/api/workflows/${vidFlow.id}`, { baseRev: (await call(person, 'GET', `/api/workflows/${vidFlow.id}`)).body.workflow.rev, graph: videoGraph({ model: VIDEO_KLING, duration: 3 }) })).status, 200);
  const fitsPlan = await call(person, 'POST', `/api/workflows/${vidFlow.id}/runs/plan`, { mode: 'all' });
  assert.ok(Math.abs(fitsPlan.body.nodes.gen.estimate.usd - 0.378) < 1e-9, 'Kling, 3 s');
  assert.equal(fitsPlan.body.budget.enough, true);
  // guests have no budget: the plan says so, the run is refused
  const gvFlow = (await call(GUEST, 'POST', '/api/workflows', { name: 'Gast Video' })).body.workflow;
  await call(GUEST, 'PUT', `/api/workflows/${gvFlow.id}`, { baseRev: 1, graph: videoGraph({ model: VIDEO_KLING }) });
  assert.equal((await call(GUEST, 'POST', `/api/workflows/${gvFlow.id}/runs`, { mode: 'all' })).status, 402);
  assert.equal(videoStarts, 0);
  await api(`/api/teams/${ctx.teamA.id}/members/${enc(person)}`, { method: 'PATCH', as: ADMIN, json: { budgetOverrideUsd: 50 } });
  restoreAll();

  // speech and music in one run: the plan counts both, the run reserves ONCE (run key) and every booking is settled against it
  const elevenlabs = ctx.iso.load('lib/elevenlabs');
  patch(elevenlabs, 'hasKey', () => true);
  const reservedAt = [];
  let reservationsAt = [];
  patch(elevenlabs, 'composeMusic', async () => {
    reservationsAt.push(ctx.budget.defaultBudget.reservationCount());
    reservedAt.push((await ctx.budget.statusOfEmail(person)).reservedUsd);
    return Buffer.from('mp3');
  });
  patch(elevenlabs, 'tts', async () => {
    await sleep(400); // the music is booked by now
    reservationsAt.push(ctx.budget.defaultBudget.reservationCount());
    reservedAt.push((await ctx.budget.statusOfEmail(person)).reservedUsd);
    return Buffer.from('mp3');
  });
  const audioFlow = (await call(person, 'POST', '/api/workflows', { name: 'Ton' })).body.workflow;
  const audioGraph = {
    nodes: [
      node('txt', 'input.text', { text: 'Willkommen zu unserem Film' }, 0, 0),
      node('say', 'audio.tts', {}, 300, 0),
      node('song', 'audio.music', { prompt: 'ruhiges Klavier', length: 60 }, 300, 200),
      node('o1', 'output.result', { label: 'Sprache' }, 600, 0),
      node('o2', 'output.result', { label: 'Musik' }, 600, 200)
    ],
    edges: [
      { id: 'e1', from: { node: 'txt', port: 'text' }, to: { node: 'say', port: 'text' } },
      { id: 'e2', from: { node: 'say', port: 'audio' }, to: { node: 'o1', port: 'inputs' } },
      { id: 'e3', from: { node: 'song', port: 'audio' }, to: { node: 'o2', port: 'inputs' } }
    ],
    groups: [],
    notes: []
  };
  assert.equal((await call(person, 'PUT', `/api/workflows/${audioFlow.id}`, { baseRev: 1, graph: audioGraph })).status, 200);
  const audioPlan = (await call(person, 'POST', `/api/workflows/${audioFlow.id}/runs/plan`, { mode: 'all' })).body;
  assert.equal(audioPlan.totals.paidNodes, 2, 'speech and music are paid nodes now');
  assert.equal(audioPlan.nodes.say.paid, true);
  assert.equal(audioPlan.nodes.say.estimate, null, 'the text comes through a connection: unknown');
  assert.deepEqual(audioPlan.nodes.song.estimate, { usd: 0.2 });
  assert.equal(audioPlan.totals.unknownNodes, 1);
  assert.equal(audioPlan.totals.usd, 0.2);
  const spentBefore = (await ctx.budget.statusOfEmail(person)).spentUsd;
  const audioRun = await call(person, 'POST', `/api/workflows/${audioFlow.id}/runs`, { mode: 'all' });
  assert.equal(audioRun.status, 202, audioRun.text);
  const audioDone = await finish(audioFlow.id, audioRun.body.runId, person);
  assert.equal(audioDone.status, 'completed', JSON.stringify(audioDone).slice(0, 400));
  assert.deepEqual(reservationsAt, [1, 1], 'one reservation for the whole run, none per call');
  assert.ok(Math.abs(reservedAt[0] - 0.2) < 1e-9, 'the plan amount is reserved');
  assert.ok(reservedAt[1] < 1e-9, 'the booking of the music is settled against it');
  const audioRows = (await costsLib.readCosts()).filter((row) => row.user === person && ['speech', 'music'].includes(row.type));
  assert.deepEqual(audioRows.map((row) => row.type).sort(), ['music', 'speech']);
  assert.ok(audioRows.every((row) => row.sessionId === audioFlow.sessionId && row.assetId));
  assert.equal(ctx.budget.defaultBudget.reservationCount(), 0, 'the reservation ends with the run');
  const booked = audioRows.reduce((sum, row) => sum + row.cost, 0);
  assert.ok(Math.abs((await ctx.budget.statusOfEmail(person)).spentUsd - spentBefore - booked) < 1e-9);
  assert.ok(Math.abs(audioDone.cost.usd - booked) < 1e-9, 'the run reports what the nodes cost');
  restoreAll();

  // a cancelled run: the provider job goes on and is billed later, so its share stays reserved (no way to start the
  // same job again and again for free by cancelling)
  const store = ctx.store;
  const budgetLib = ctx.budget;
  let providerJobs = 0;
  patch(or, 'createVideo', async () => {
    providerJobs += 1;
    return { id: `vjob-${providerJobs}`, polling_url: 'http://127.0.0.1:1/x', status: 'pending' };
  });
  const vflow = (await call(person, 'POST', '/api/workflows', { name: 'Video' })).body.workflow;
  assert.equal((await call(person, 'PUT', `/api/workflows/${vflow.id}`, { baseRev: 1, graph: graph('video.seedance') })).status, 200);
  const before = await budgetLib.statusOfEmail(person);
  const vrun = await call(person, 'POST', `/api/workflows/${vflow.id}/runs`, { mode: 'all' });
  assert.equal(vrun.status, 202, vrun.text);
  await waitFor(async () => (await store.readSession(vflow.sessionId)).jobs.length === 1, { message: 'the provider job' });
  await sleep(300);
  assert.equal((await call(person, 'POST', `/api/workflows/${vflow.id}/runs/${vrun.body.runId}/cancel`, {})).body.ok, true);
  await finish(vflow.id, vrun.body.runId, person);
  const openJob = (await store.readSession(vflow.sessionId)).jobs[0];
  assert.equal(openJob.status, 'pending', 'nobody stops the provider job');
  assert.match(openJob.budgetKey, /^hold:/, 'the job carries its own reservation now (not the one of the finished run)');
  assert.equal(openJob.reservedUsd, 2);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 1);
  const during = await budgetLib.statusOfEmail(person);
  assert.equal(during.reservedUsd, 2, 'the budget does not come back while the job runs');
  assert.ok(Math.abs(during.remainingUsd - (before.remainingUsd - 2)) < 1e-9);
  // the restart of the app puts the reservation back, the poller books the cost when the job is done
  const restarted = budgetLib.createBudget({ index: budgetLib.createCostIndex({ file: costsLib.COSTS_FILE }), teams: () => teamsLib.defaultStore });
  restarted.ensureJob(openJob);
  assert.equal((await restarted.statusOfEmail(person)).reservedUsd, 2);
  budgetLib.settleJob(openJob, 1.4);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
  restoreAll();

  // guests: any paid run is refused, a free one works
  const gflow = (await call(GUEST, 'POST', '/api/workflows', { name: 'Gast' })).body.workflow;
  await call(GUEST, 'PUT', `/api/workflows/${gflow.id}`, { baseRev: 1, graph: graph() });
  const guestRun = await call(GUEST, 'POST', `/api/workflows/${gflow.id}/runs`, { mode: 'all' });
  assert.equal(guestRun.status, 402);
  assert.equal(guestRun.body.code, 'BUDGET_EXHAUSTED');
  assert.equal((await call(GUEST, 'POST', `/api/workflows/${gflow.id}/runs/plan`, { mode: 'all' })).body.budget.enough, false);

  // LLM nodes: the model list of a participant has no ChatGPT models, the call needs budget
  const llm = ctx.iso.load('lib/nodes/llm');
  assert.equal(typeof llm.completeText, 'function');
}

/* ---------- costs and monitoring ---------- */

async function testCostsAndMonitoring(ctx) {
  const { api, teamA, teamB, costsLib } = ctx;
  // every cost row written above carries a person (or 'lokal' for background work), never an empty value
  const rows = await costsLib.readCosts();
  assert.ok(rows.length > 5);
  assert.ok(rows.every((row) => typeof row.user === 'string' && row.user.length > 0));

  // team filter and team report (superadmin only)
  assert.equal((await api(`/api/admin/monitoring?team=${teamA.id}`, { as: ADMIN, raw: true })).status, 404);
  const report = await api(`/api/admin/monitoring?team=${teamA.id}&days=all`, { as: BOSS });
  assert.equal(report.status, 200);
  assert.equal(report.body.filters.team, teamA.id);
  assert.deepEqual(report.body.options.teams.map((team) => team.id).sort(), [teamA.id, teamB.id].sort());
  assert.equal(report.body.teams.length, 1);
  assert.equal(report.body.teams[0].id, teamA.id);
  const memberEmails = report.body.teams[0].members.map((member) => member.email);
  assert.ok(memberEmails.includes(P1) && memberEmails.includes(P2));
  assert.ok(report.body.rows.length > 0 && report.body.rows.every((row) => memberEmails.includes(row.user.toLowerCase())), 'only the members of the team');
  assert.ok(!report.body.rows.some((row) => row.user === STAFF), 'no internal costs in a team report');
  const p1Entry = report.body.teams[0].members.find((member) => member.email === P1);
  assert.equal(p1Entry.limitUsd, 10);
  assert.ok(p1Entry.spentUsd >= 0.5);
  assert.equal(p1Entry.periodCostUsd >= 0.5, true);
  assert.equal(typeof p1Entry.unknownCostJobs, 'number');
  const all = (await api('/api/admin/monitoring?days=all', { as: BOSS })).body;
  assert.equal(all.teams.length, 2);
  assert.equal(typeof all.totals.unknownCostJobs, 'number');
  assert.equal((await api('/api/admin/monitoring?team=tm-000000000000', { as: BOSS })).status, 400, 'an unknown team is an invalid filter');
  assert.equal((await api('/api/admin/monitoring?team[]=a', { as: BOSS })).status, 400);
  const csv = await api(`/api/admin/monitoring/export?team=${teamA.id}&days=all`, { as: BOSS, raw: true });
  assert.equal(csv.status, 200);
  assert.ok(!(await csv.text()).includes(STAFF));
}

/* ---------- allowlist sync end to end ---------- */

async function testSync(ctx) {
  const { api, allowlist, teamA, iso } = ctx;
  const read = () => JSON.parse(fs.readFileSync(allowlist, 'utf8'));
  const route = () => read().routes.find((entry) => entry.path === '/training');
  const extra = () => route().extra_emails;

  // the members of active teams are in the list; the internal domain and manual entries stay as they are
  assert.ok(extra().includes('manual@example.org'), 'the manual entry stays');
  assert.ok(extra().includes(P1) && extra().includes(P2) && extra().includes(PAB));
  assert.ok(!extra().includes(STAFF), 'internal addresses are not entered');
  assert.deepEqual(read().default, { domain: 'staff.example.com', public: false });
  assert.deepEqual(read().routes.find((entry) => entry.path === '/other'), { path: '/other', public: true, extra_emails: [] });
  assert.equal(fs.statSync(allowlist).mode & 0o777, 0o640, 'the permissions of the file are kept');
  const backups = fs.readdirSync(path.dirname(allowlist)).filter((name) => name.startsWith('routes.json.bak-'));
  assert.equal(backups.length, 1, 'one backup, made before the first change');

  const status = (await api('/api/teams', { as: ADMIN })).body.sync;
  assert.equal(status.enabled, true);
  assert.equal(status.route, '/training');
  assert.equal(status.ok, true);
  assert.equal(status.warning, null);

  // a new member reaches the list with the answer of the request
  const added = await api(`/api/teams/${teamA.id}/members`, { method: 'POST', as: ADMIN, json: { emails: ['neu@gmail.example'] } });
  assert.equal(added.body.sync.ok, true);
  assert.ok(extra().includes('neu@gmail.example'));
  // removed: gone again; a team archived: everybody gone
  await api(`/api/teams/${teamA.id}/members/${enc('neu@gmail.example')}`, { method: 'DELETE', as: ADMIN });
  assert.ok(!extra().includes('neu@gmail.example'));
  await api(`/api/teams/${teamA.id}`, { method: 'PATCH', as: ADMIN, json: { archived: true } });
  assert.ok(!extra().includes(P1) && extra().includes('manual@example.org'));
  await api(`/api/teams/${teamA.id}`, { method: 'PATCH', as: ADMIN, json: { archived: false } });
  assert.ok(extra().includes(P1));
  assert.equal(fs.readdirSync(path.dirname(allowlist)).filter((name) => name.startsWith('routes.json.bak-')).length, 1);

  // a failure is a warning, not an error: the request works, the file stays as it is
  const original = fs.readFileSync(allowlist, 'utf8');
  fs.writeFileSync(allowlist, '{ kaputt');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const during = await api(`/api/teams/${teamA.id}/members`, { method: 'POST', as: ADMIN, json: { emails: ['warn@gmail.example'] } });
    assert.equal(during.status, 201, 'the team change itself works');
    assert.equal(during.body.sync.ok, false);
    assert.match(during.body.sync.warning, /kein gültiges JSON/);
    assert.equal(fs.readFileSync(allowlist, 'utf8'), '{ kaputt');
    assert.equal((await api('/api/teams', { as: ADMIN })).body.sync.ok, false);
  } finally {
    console.warn = warn;
  }
  fs.writeFileSync(allowlist, original);
  await api(`/api/teams/${teamA.id}/members/${enc('warn@gmail.example')}`, { method: 'DELETE', as: ADMIN });
  assert.equal((await api('/api/teams', { as: ADMIN })).body.sync.ok, true, 'the warning ends with the next good run');

  // without the environment variables the sync does nothing
  iso.setEnv('ACCESS_ALLOWLIST_FILE', undefined);
  const before = fs.readFileSync(allowlist, 'utf8');
  const off = await api(`/api/teams/${teamA.id}/members`, { method: 'POST', as: ADMIN, json: { emails: ['off@gmail.example'] } });
  assert.equal(off.body.sync.enabled, false);
  assert.equal(fs.readFileSync(allowlist, 'utf8'), before);
  iso.setEnv('ACCESS_ALLOWLIST_FILE', allowlist);
  await api(`/api/teams/${teamA.id}/members/${enc('off@gmail.example')}`, { method: 'DELETE', as: ADMIN });
}

/* ---------- inventory ---------- */

function testRouteInventory({ iso, seen }) {
  assert.deepEqual(registeredRoutes(iso.app), Object.keys(PARTICIPANT_RULES).sort(), 'every route needs a decision for participants');
  const called = [...seen];
  const missing = Object.entries(PARTICIPANT_RULES)
    .filter(([, rule]) => rule !== 'public')
    .map(([route]) => route)
    .filter((route) => !called.some((entry) => matchesRoute(route, entry)));
  assert.deepEqual(missing, [], 'routes that were never called as a participant or guest');
}

/* ---------- local mode ---------- */

async function testLocalMode() {
  const iso = await createIsolatedApp({ active: false, env: { OPENROUTER_API_KEY: '', ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: BOSS, INTERNAL_EMAIL_DOMAINS: 'staff.example.com', ACCESS_ALLOWLIST_FILE: '', ACCESS_ALLOWLIST_ROUTE: '' } });
  await iso.listen();
  const api = iso.request;
  try {
    assert.deepEqual((await api('/api/me')).body, { active: false, identified: false, email: null, role: 'local', isAdmin: true, isSuperAdmin: false, logoutUrl: null });
    // teams need the user management
    const teams = await api('/api/teams');
    assert.equal(teams.status, 400);
    assert.equal(teams.body.code, 'USER_MANAGEMENT_INACTIVE');
    assert.equal((await api('/api/teams', { method: 'POST', json: { name: 'X', budgetUsd: 1 } })).status, 400);
    assert.deepEqual((await api('/api/teams/mine')).body, { active: false, teams: [] });
    // nothing is restricted, nothing has a budget
    const chat = (await api('/api/sessions', { method: 'POST', json: {} })).body.session;
    assert.equal('owner' in chat, false);
    assert.equal('sharedTeams' in chat, false);
    assert.equal((await api('/api/config')).body.gts.enabled, false);
    assert.equal((await api('/api/gts/search?q=x')).status, 503, 'not restricted (no token here)');
    assert.equal('nodes' in (await api('/api/rendernode/status')).body, true);
    const registry = (await api('/api/nodes/registry')).body;
    assert.ok(registry.nodeTypes.filter((type) => type.category === 'higgsfield').every((type) => !type.restricted));
    assert.equal((await api('/api/brandings')).status, 200);
    const users = await api('/api/users', { method: 'POST', json: { emails: ['a@example.com'] } });
    assert.equal(users.status, 201);
    assert.deepEqual(users.body.added, ['a@example.com']);
    assert.equal((await iso.load('lib/budget').status(iso.load('lib/access').viewerOf({}, {}))), null);
  } finally {
    await iso.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
