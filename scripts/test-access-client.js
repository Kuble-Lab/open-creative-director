'use strict';

// Browser side of the user management (public/access-client.js, monitoring page, wiring in index.html):
// the pure helpers, the sharing requests, the text coverage and the safety rules (no innerHTML, no native dialogs).
// The dialogs themselves are checked in a real browser against an isolated app copy (see the README of WP14 notes);
// this test needs no browser and no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/* ---------- helpers under a stubbed browser ---------- */

function load({ me, requests = [] }) {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  const fetchStub = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (url === 'api/me') return { ok: true, status: 200, json: async () => me };
    if (/\/share$/.test(url)) {
      const status = load.shareStatus || 200;
      return status === 200
        ? { ok: true, status, json: async () => ({ session: { id: 'S1', shareMode: 'team' }, workflow: { id: 'W1', shareMode: 'team' } }) }
        : { ok: false, status, json: async () => ({ error: 'nope', code: load.shareCode }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unknown' }) };
  };
  const context = { window, fetch: fetchStub, document: window.document };
  window.window = window;
  vm.runInNewContext(read('public', 'access-client.js'), context, { filename: 'public/access-client.js' });
  return window;
}

async function testLocalMode() {
  const window = load({ me: { active: false, isAdmin: true } });
  await window.OCAccess.ready;
  const access = window.OCAccess;
  assert.equal(access.isActive(), false);
  assert.equal(access.canAdminister(), true, 'local mode: everything is open');
  assert.equal(access.badge({ owner: 'a@x.ch', shareMode: 'team' }), null, 'local mode: no badges');
  assert.equal(access.ownerName({ owner: 'a@x.ch', mine: false }), null, 'local mode: no owner names');
  assert.equal(access.ownerChip({ owner: 'a@x.ch', mine: false }), null, 'local mode: no owner chip');
}

async function testFailedMe() {
  const window = load({ me: null });
  const me = await window.OCAccess.ready;
  assert.equal(me.active, false, 'a failing /api/me leaves the local mode');
}

async function testActiveHelpers() {
  const window = load({ me: { active: true, identified: true, email: 'anna.muster@example.com', role: 'user', isAdmin: false, isSuperAdmin: false, logoutUrl: 'https://login.example.com/out' } });
  await window.OCAccess.ready;
  const access = window.OCAccess;
  assert.equal(access.isActive(), true);
  assert.equal(access.canAdminister(), false, 'a normal person is not an admin');
  assert.equal(access.me().logoutUrl, 'https://login.example.com/out');
  assert.equal(access.usernameOf('anna.muster@example.com'), 'anna.muster');
  assert.equal(access.initialsOf('anna.muster@example.com'), 'AM');
  assert.equal(access.initialsOf('bob@example.com'), 'B');
  assert.equal(access.initialsOf('x_y-z@example.com'), 'XY');

  // The owner chip only says something in somebody else's entry (in your own the account avatar already is you).
  assert.equal(access.ownerChip({ owner: 'anna.muster@example.com', mine: true, unowned: false }), null, 'own entry: no owner chip');
  assert.equal(access.ownerChip({ unowned: true, owner: null, mine: false }), null, 'entry without owner: no owner chip');

  // Existing data (no owner) never shows a badge or an owner.
  assert.equal(access.badge({ unowned: true, owner: null, shareMode: 'private' }), null);
  assert.equal(access.ownerName({ unowned: true, owner: null, mine: false }), null);
  // Private: nothing. Team and specific: a badge.
  assert.equal(access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'private' }), null);
  const team = access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'team' });
  assert.match(team.label, /Intern/, 'the mode for all internal people is called "internal", not "team"');
  assert.equal(team.title, 'Mit allen intern geteilt', 'own entry: no "shared by" suffix');
  const foreign = access.badge({ owner: 'a@x.ch', unowned: false, mine: false, shareMode: 'team' });
  assert.match(foreign.title, /Geteilt von a@x\.ch/);
  const specific = access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'specific', sharedCount: 3 });
  assert.match(specific.label, /3/);
  assert.equal(access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'specific', sharedCount: 0 }), null);
  // Owner names only for somebody else's entries.
  const owner = access.ownerName({ owner: 'a.b@x.ch', unowned: false, mine: false });
  assert.equal(owner.text, 'a.b');
  assert.match(owner.title, /a\.b@x\.ch/);
  assert.equal(access.ownerName({ owner: 'a.b@x.ch', unowned: false, mine: true }), null);
  // Share button tooltip.
  assert.match(access.stateText({ unowned: true }), /ohne Besitz|No owner|Sin propietario/i);
  assert.equal(access.stateText({ owner: 'a@x.ch', shareMode: 'private' }), 'Privat');
  assert.match(access.stateText({ owner: 'a@x.ch', shareMode: 'specific', sharedCount: 2 }), /2 Personen/);
  // Shared with teams: the names of the teams (or their number when the viewer may not see them).
  const teams = access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'teams', sharedTeams: [{ id: 't1', name: 'Schulung A' }, { id: 't2', name: 'Schulung B' }], sharedTeamCount: 2 });
  assert.equal(teams.label, '👥 Schulung A +1');
  assert.match(teams.title, /Schulung A, Schulung B/);
  assert.equal(access.badge({ owner: 'a@x.ch', unowned: false, mine: true, shareMode: 'teams', sharedTeams: [], sharedTeamCount: 0 }), null);
  assert.match(access.stateText({ owner: 'a@x.ch', shareMode: 'teams', sharedTeams: [{ id: 't1', name: 'Schulung A' }], sharedTeamCount: 1 }), /Schulung A/);
  assert.match(access.stateText({ owner: 'a@x.ch', shareMode: 'teams', sharedTeams: [], sharedTeamCount: 3 }), /3 Teams/);
}

// Participants and guests: role, teams and budget of /api/me, the modes they may choose, readable budget messages.
async function testParticipant() {
  const requests = [];
  const me = { active: true, identified: true, email: 'anna@example.org', role: 'participant', isAdmin: false, isSuperAdmin: false, participant: true, teams: [{ id: 'team-a', name: 'Schulung A' }], budget: { limitUsd: 20, spentUsd: 5, reservedUsd: 1, remainingUsd: 14, since: '2026-10-01T08:00:00.000Z' } };
  const window = load({ me, requests });
  await window.OCAccess.ready;
  const access = window.OCAccess;
  assert.equal(access.me().restricted, true);
  assert.equal(access.me().participant, true);
  assert.deepEqual([...access.me().teams.map((team) => team.name)], ['Schulung A']);
  assert.equal(access.budget().remainingUsd, 14);
  assert.equal(access.canAdminister(), false);
  assert.deepEqual([...access.allowedModes()], ['private', 'teams', 'specific'], 'participants never share with "everybody internal"');
  const lines = access.budgetLines(access.budget());
  assert.equal(lines.exhausted, false);
  assert.equal(lines.low, false);
  assert.equal(access.formatUsd(14), '$14.00');
  assert.equal(access.budgetLines({ limitUsd: 20, spentUsd: 19, reservedUsd: 0, remainingUsd: 1 }).low, true, 'under 15 % left is "low"');
  assert.equal(access.budgetLines({ limitUsd: 20, spentUsd: 20, reservedUsd: 0, remainingUsd: 0 }).exhausted, true);
  assert.equal(access.budgetLines(null), null);

  // The budget is read again after paid actions and the listeners hear about it.
  const seen = [];
  access.onChange((next) => seen.push(next.budget.remainingUsd));
  me.budget = { ...me.budget, spentUsd: 20, reservedUsd: 0, remainingUsd: 0 };
  await access.refreshMe();
  assert.deepEqual(seen, [0]);
  assert.equal(access.budget().remainingUsd, 0);

  // Friendly texts for the refused paid action (402) and the missing feature (403).
  assert.match(access.accountRuleMessage({ code: 'BUDGET_EXHAUSTED' }), /Budget ist aufgebraucht/);
  assert.match(access.accountRuleMessage({ code: 'BUDGET_JOBS_OPEN' }), /Auftr.*Anbieter/);
  const insufficient = access.accountRuleMessage({ code: 'BUDGET_INSUFFICIENT', body: { code: 'BUDGET_INSUFFICIENT', estimateUsd: 3.5, remainingUsd: 2 } });
  assert.match(insufficient, /\$3\.50/);
  assert.match(insufficient, /\$2\.00/);
  assert.match(access.accountRuleMessage({ code: 'BUDGET_INSUFFICIENT' }), /Restbudget/, 'an event of the chat stream carries no numbers');
  assert.match(access.accountRuleMessage({ code: 'FORBIDDEN_FOR_ROLE', body: { feature: 'higgsfield' } }), /Higgsfield/);
  assert.match(access.accountRuleMessage({ code: 'FORBIDDEN_FOR_ROLE', body: { feature: 'unheard-of' } }), /nicht/);
  assert.equal(access.accountRuleMessage({ code: 'SOMETHING_ELSE' }), null);
  assert.equal(access.accountRuleMessage(null), null);

  // Guests: private only.
  const guest = load({ me: { active: true, identified: true, email: 'gast@example.net', role: 'guest', teams: [], budget: { limitUsd: 0, spentUsd: 0, reservedUsd: 0, remainingUsd: 0 } } });
  await guest.OCAccess.ready;
  assert.deepEqual([...guest.OCAccess.allowedModes()], ['private']);
  assert.equal(guest.OCAccess.me().participant, false);
  assert.equal(guest.OCAccess.budgetLines(guest.OCAccess.budget()).exhausted, true);

  // Internal people and admins: all four modes; nothing of the budget.
  const internal = load({ me: { active: true, identified: true, email: 'chef@example.com', role: 'admin', isAdmin: true } });
  await internal.OCAccess.ready;
  assert.deepEqual([...internal.OCAccess.allowedModes()], ['private', 'team', 'teams', 'specific']);
  assert.equal(internal.OCAccess.budget(), null);
  assert.equal(internal.OCAccess.me().restricted, false);
}

async function testSharingRequests() {
  const requests = [];
  const window = load({ me: { active: true, identified: true, email: 'a@x.ch', role: 'user' }, requests });
  await window.OCAccess.ready;
  const access = window.OCAccess;

  const session = await access.saveSharing('session', 'S/1', { shareMode: 'team', sharedWith: [] });
  assert.equal(session.id, 'S1');
  const sent = requests.find((entry) => /\/share$/.test(entry.url));
  assert.equal(sent.url, 'api/sessions/S%2F1/share', 'ids are URL-encoded');
  assert.equal(sent.method, 'PATCH');
  assert.deepEqual(sent.body, { shareMode: 'team', sharedWith: [] });

  const workflow = await access.saveSharing('workflow', 'W1', { shareMode: 'specific', sharedWith: ['b@x.ch'] });
  assert.equal(workflow.id, 'W1');
  assert.ok(requests.some((entry) => entry.url === 'api/workflows/W1/share'));

  // No request at all for an empty selection.
  const before = requests.length;
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'specific', sharedWith: [] }), (error) => /mindestens eine Person/i.test(error.userMessage));
  assert.equal(requests.length, before, 'an empty selection is refused before the request');

  // Sharing with teams sends the team ids; no request for an empty selection.
  await access.saveSharing('session', 'S1', { shareMode: 'teams', sharedWith: [], sharedTeams: ['team-a'] });
  const teamsSent = requests.filter((entry) => /\/share$/.test(entry.url)).pop();
  assert.deepEqual(teamsSent.body, { shareMode: 'teams', sharedWith: [], sharedTeams: ['team-a'] });
  const beforeTeams = requests.length;
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'teams', sharedWith: [], sharedTeams: [] }), (error) => /mindestens ein Team/i.test(error.userMessage));
  assert.equal(requests.length, beforeTeams, 'an empty team selection is refused before the request');

  // Error mapping.
  load.shareStatus = 404;
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'team', sharedWith: [] }), (error) => error.gone === true && /nicht mehr/.test(error.userMessage));
  load.shareStatus = 403;
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'team', sharedWith: [] }), (error) => error.gone === false && /Besitzerperson/.test(error.userMessage));
  load.shareStatus = 400;
  load.shareCode = 'UNKNOWN_TEAM_MEMBERS';
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'specific', sharedWith: ['z@x.ch'] }), (error) => error.reloadTeam === true && /Team-Liste/.test(error.userMessage));
  load.shareStatus = 400;
  load.shareCode = 'UNKNOWN_TEAMS';
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'teams', sharedWith: [], sharedTeams: ['x'] }), (error) => error.reloadTeams === true && /Team/.test(error.userMessage));
  load.shareCode = 'SHARE_MODE_FORBIDDEN';
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'team', sharedWith: [] }), (error) => /nicht möglich/.test(error.userMessage));
  load.shareStatus = 500;
  load.shareCode = undefined;
  await assert.rejects(() => access.saveSharing('session', 'S1', { shareMode: 'team', sharedWith: [] }), (error) => /nope/.test(error.userMessage));
  load.shareStatus = 200;
}

/* ---------- texts, wiring, safety ---------- */

function dictionaries() {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public', 'nodes', 'i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  return window.I18N;
}

function testTexts() {
  const dict = dictionaries();
  const used = new Set();
  const collect = (source, pattern, prefix = '') => {
    for (const match of source.matchAll(pattern)) used.add(`${prefix}${match[1]}`);
  };
  const app = read('public', 'app.js') + read('public', 'shell.js');
  const access = read('public', 'access-client.js');
  const nodes = ['main.js', 'app-mode.js', 'workflow-list.js'].map((file) => read('public', 'nodes', file)).join('\n');
  const monitoring = read('public', 'monitoring.js');
  const teamsUi = read('public', 'teams-ui.js');
  for (const source of [app, access, nodes, teamsUi]) {
    collect(source, /\b(?:t|tr|global\.t|setStatusI18n)\('((?:sharing|account|users|teams|paste|budget|role|costs\.scope|sessions\.lostAccess|profile\.readOnly|context\.owner)[A-Za-z._]*)'/g);
  }
  collect(nodes, /\bT\('(nodes\.(?:share|access|app\.linkCopiedPrivate)[A-Za-z.]*)'/g);
  collect(nodes, /\bui\.T\('(nodes\.(?:share|access|app\.linkCopiedPrivate)[A-Za-z.]*)'/g);
  collect(monitoring, /\bT\('([A-Za-z]+)'/g, 'monitor.');
  // access-client builds a few keys from tables
  for (const key of ['sharing.private', 'sharing.privateHint', 'sharing.team', 'sharing.teamHint', 'sharing.teams', 'sharing.teamsHint', 'sharing.specific', 'sharing.specificHint']) used.add(key);
  // keys built from tables and codes: one text per error code of the teams API and per feature name
  for (const code of ['INVALID_TEAM', 'INVALID_BUDGET', 'TEAM_NAME_TAKEN', 'NO_EMAILS', 'INVALID_EMAILS', 'TOO_MANY_EMAILS', 'TEAM_FULL', 'TOO_MANY_TEAMS', 'TEAM_NOT_FOUND', 'MEMBER_NOT_FOUND', 'USER_MANAGEMENT_INACTIVE']) used.add(`teams.err.${code}`);
  for (const feature of ['gts', 'higgsfield', 'chatgpt', 'roles', 'context']) used.add(`role.feature.${feature}`);
  for (const key of ['account.roleParticipant', 'account.roleGuest', 'budget.menuLabel', 'budget.banner', 'budget.bannerLow', 'budget.bannerGuest']) used.add(key);
  assert.ok(used.size > 40, `expected many user management keys, found ${used.size}`);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of used) {
      assert.ok(Object.prototype.hasOwnProperty.call(dict[lang], key), `${lang} lacks ${key}`);
    }
  }
  // The role labels and the monitoring column keys used through tables.
  for (const key of ['monitor.days7', 'monitor.days30', 'monitor.days90', 'monitor.daysall', 'account.roleAdmin', 'account.roleSuperadmin', 'account.roleUser', 'account.roleAnonymous']) {
    assert.ok(dict.de[key], key);
  }
}

function testHtmlWiring() {
  const index = read('public', 'index.html');
  const app = read('public', 'app.js');
  const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const wanted = [...app.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  const missing = wanted.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js reads ids that index.html does not have: ${missing.join(', ')}`);
  assert.match(index, /<script src="access-client\.js"><\/script>\s*<script src="shell\.js"><\/script>\s*<script src="app\.js"><\/script>/, 'access-client.js and shell.js load before app.js');
  assert.match(index, /<script src="email-list\.js"><\/script>\s*<script src="teams-ui\.js"><\/script>\s*<script src="access-client\.js">/, 'the paste parser and the teams interface load before the access client and app.js');
  for (const id of ['budgetBanner', 'usersPasteSlot', 'settingsTeamsSlot']) assert.ok(ids.has(id), `index.html has #${id}`);
  const teamsUi = read('public', 'teams-ui.js');
  const teamIds = [...teamsUi.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(teamIds.filter((id) => !ids.has(id) && !teamsUi.includes(`id: '${id}'`)), [], 'teams-ui.js reads only ids that exist');

  const page = read('views', 'monitoring.html');
  const pageIds = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const monitoring = read('public', 'monitoring.js');
  const used = [...monitoring.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(used.filter((id) => !pageIds.has(id)), [], 'monitoring.js reads ids that views/monitoring.html does not have');
  assert.doesNotMatch(page, /href="\/|src="\//, 'monitoring.html uses relative URLs (works under a sub-path)');
  assert.doesNotMatch(monitoring, /fetch\(`\/|fetch\('\//, 'monitoring.js uses relative URLs');
}

function testSafety() {
  for (const file of ['public/access-client.js', 'public/monitoring.js', 'public/teams-ui.js', 'public/email-list.js']) {
    const source = read(...file.split('/'));
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, `${file}: no HTML from strings`);
    assert.doesNotMatch(source, /\b(?:window\.)?(?:confirm|alert|prompt)\(/, `${file}: no native dialogs`);
  }
  const usersBlock = read('public', 'app.js');
  const start = usersBlock.indexOf('user management (only with AUTH_WHOAMI_URL');
  const end = usersBlock.indexOf('/* ---------- sessions ---------- */');
  assert.ok(start > 0 && end > start);
  const block = usersBlock.slice(start, end);
  assert.doesNotMatch(block, /innerHTML|\bconfirm\(|\balert\(/, 'user management block of app.js: no innerHTML and no native dialogs');
  // No internal hosts in the open files.
  for (const file of ['public/access-client.js', 'public/monitoring.js', 'public/monitoring.css', 'views/monitoring.html', 'public/i18n.js', 'public/teams-ui.js', 'public/help.html']) {
    assert.doesNotMatch(read(...file.split('/')), /maniak|kuble\.internal|10\.\d+\.\d+\.\d+/i, `${file}: no internal names or addresses`);
  }
}

(async () => {
  await testLocalMode();
  await testFailedMe();
  await testActiveHelpers();
  await testParticipant();
  await testSharingRequests();
  testTexts();
  testHtmlWiring();
  testSafety();
  console.log('access client ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
