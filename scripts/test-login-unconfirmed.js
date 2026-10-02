'use strict';

// Unconfirmed login (fail closed). While a restriction is active (the teams file knows an address, the teams file is
// unreadable, or INTERNAL_EMAIL_DOMAINS is set) an anonymous caller may be a participant whose login could not be
// confirmed (whoami timeout, network error, 5xx). Then every /api route except the public ones answers 401
// LOGIN_UNCONFIRMED. Without a restriction, and in the local mode, nothing changes.
//
// Parts: the rule itself (lib/access.js), the budget refusal, the whoami cache (lib/whoami.js) and the whole app
// (every route of scripts/support/route-rules.js) in a private copy of the server. No network beyond 127.0.0.1.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const access = require('../lib/access');
const budgetLib = require('../lib/budget');
const { createTeamsStore } = require('../lib/teams');
const { createWhoamiMiddleware, CACHE_TTL_MS, FAILURE_CACHE_TTL_MS } = require('../lib/whoami');
const { createIsolatedApp } = require('./support/isolated-app');
const { ROUTE_RULES, PARTICIPANT_RULES } = require('./support/route-rules');

const ADMIN = 'admin@example.com';
const STAFF = 'staff@staff.example.com';
const CAROL = 'carol@example.org';
const DOMAINS = 'staff.example.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await testRule();
  await testBudgetRefusal();
  await testWhoamiCache();
  await testApp();
  await testLocalMode();
  console.log('Unbestätigte Anmeldung: Einschränkung aktiv (Teams, unlesbare Datei, Domains), 401 LOGIN_UNCONFIRMED auf jeder nicht-öffentlichen Route, Ausnahmen, Budget-Ablehnung, Whoami-Cache 2 s / 10 s und das unveränderte Verhalten ohne Einschränkung und lokal sind korrekt.');
  console.log('test-login-unconfirmed.js: ok');
}

/* ---------- the rule ---------- */

async function testRule() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-unconfirmed-'));
  const saved = { url: process.env.AUTH_WHOAMI_URL, domains: process.env.INTERNAL_EMAIL_DOMAINS };
  const restore = () => {
    access.useTeamsStore(null);
    for (const [key, value] of [['AUTH_WHOAMI_URL', saved.url], ['INTERNAL_EMAIL_DOMAINS', saved.domains]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const active = { AUTH_WHOAMI_URL: 'https://whoami.invalid/me' };
    const store = createTeamsStore({ file: path.join(dir, 'teams.json') });
    access.useTeamsStore(store);

    // nothing known, no domains: no restriction
    assert.equal(access.restrictionActive(active), false);
    assert.equal(access.restrictionActive({ ...active, INTERNAL_EMAIL_DOMAINS: '' }), false);
    // the local mode never has one
    assert.equal(access.restrictionActive({ INTERNAL_EMAIL_DOMAINS: DOMAINS }), false);
    // a domain list is enough
    assert.equal(access.restrictionActive({ ...active, INTERNAL_EMAIL_DOMAINS: DOMAINS }), true);
    // a known address is enough, also after the person was removed (the list only grows)
    const team = store.createTeam({ name: 'Kurs', budgetUsd: 5 });
    assert.equal(access.restrictionActive(active), false, 'a team without members knows nobody');
    store.addMembers(team.id, [CAROL]);
    assert.equal(access.restrictionActive(active), true);
    store.removeMember(team.id, CAROL);
    assert.equal(access.restrictionActive(active), true, 'a former participant is still known');

    // an unreadable file restricts as well
    const broken = path.join(dir, 'broken.json');
    await fsp.writeFile(broken, '{ this is not json');
    access.useTeamsStore(createTeamsStore({ file: broken }));
    assert.equal(access.restrictionActive(active), true, 'unreadable teams file');
    // a store that throws restricts (fail closed)
    access.useTeamsStore({ unreadable() { throw new Error('boom'); }, hasKnown() { throw new Error('boom'); } });
    assert.equal(access.restrictionActive(active), true);

    // isUnconfirmed: anonymous viewer + restriction
    access.useTeamsStore(store);
    const env = { ...active, INTERNAL_EMAIL_DOMAINS: DOMAINS };
    const anonymous = access.viewerOf({ kubleUser: 'lokal' }, env);
    const alice = access.viewerOf({ kubleUser: 'alice@staff.example.com' }, env);
    assert.equal(access.isUnconfirmed(anonymous, env), true);
    assert.equal(access.isUnconfirmed(alice, env), false);
    access.useTeamsStore(createTeamsStore({ file: path.join(dir, 'empty.json') }));
    assert.equal(access.isUnconfirmed(anonymous, active), false, 'no restriction: anonymous stays anonymous');
    access.useTeamsStore(store);
    assert.equal(access.isUnconfirmed(access.LOCAL_VIEWER, env), false, 'local mode');
    assert.equal(access.isUnconfirmed(null, env), false);
    assert.deepEqual({ ...anonymous }, { active: true, email: null, identified: false, superadmin: false, admin: false }, 'the viewer keeps its shape');

    // the exceptions: exactly the public routes below /api plus /api/config
    const publicRoutes = new Set(
      [...Object.entries(ROUTE_RULES), ...Object.entries(PARTICIPANT_RULES)]
        .filter(([, rule]) => rule === 'public')
        .map(([route]) => route)
        .filter((route) => route.startsWith('GET /api/'))
        .map((route) => route.slice(4))
    );
    publicRoutes.add('/api/config');
    assert.deepEqual([...publicRoutes].sort(), [...access.UNCONFIRMED_EXEMPT_PATHS].sort(), 'route-rules.js and the exception list agree');
    for (const exempt of access.UNCONFIRMED_EXEMPT_PATHS) {
      assert.equal(access.unconfirmedExempt('GET', exempt), true, exempt);
      assert.equal(access.unconfirmedExempt('get', `${exempt}/`), true, `${exempt}/`);
      assert.equal(access.unconfirmedExempt('GET', exempt.toUpperCase()), true, 'case-insensitive like the router');
      assert.equal(access.unconfirmedExempt('POST', exempt), false, `POST ${exempt}`);
      assert.equal(access.unconfirmedExempt('DELETE', exempt), false);
    }
    for (const other of ['/api/sessions', '/api/me/x', '/api/config/x', '/api/nodes/options/x', '/api/roles', '/api']) {
      assert.equal(access.unconfirmedExempt('GET', other), false, other);
    }

    // the guard as middleware
    process.env.AUTH_WHOAMI_URL = 'https://whoami.invalid/me';
    process.env.INTERNAL_EMAIL_DOMAINS = DOMAINS;
    const guard = access.createUnconfirmedGuard();
    const run = (request) => {
      const out = { next: false, status: null, body: null, headers: {} };
      const res = {
        set(key, value) {
          out.headers[key.toLowerCase()] = value;
          return res;
        },
        status(code) {
          out.status = code;
          return res;
        },
        json(body) {
          out.body = body;
          return res;
        }
      };
      guard({ method: 'GET', headers: {}, kubleUser: 'lokal', ...request }, res, () => {
        out.next = true;
      });
      return out;
    };
    const blocked = run({ path: '/api/sessions' });
    assert.equal(blocked.next, false);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.code, 'LOGIN_UNCONFIRMED');
    assert.equal(blocked.headers['cache-control'], 'no-store');
    for (const lang of ['de', 'en', 'es']) assert.ok(blocked.body.messages[lang] && blocked.body.messages[lang].length > 20, lang);
    assert.match(blocked.body.messages.de, /Anmeldung konnte gerade nicht bestätigt werden/);
    assert.equal(blocked.body.error, blocked.body.messages.de);
    assert.equal(run({ path: '/API/sessions' }).status, 401, 'the router is case-insensitive');
    assert.equal(run({ path: '/api' }).status, 401);
    assert.equal(run({ path: '/api/me' }).next, true);
    assert.equal(run({ path: '/api/me', method: 'POST' }).status, 401);
    assert.equal(run({ path: '/index.html' }).next, true, 'static files stay reachable');
    assert.equal(run({ path: '/' }).next, true);
    assert.equal(run({ path: '/refs/abc' }).next, true);
    assert.equal(run({ path: '/assets/some-session/image.png' }).status, 401, 'the files of chats are guarded like the API');
    assert.equal(run({ path: '/assets/some-session/image.png', kubleUser: 'alice@staff.example.com' }).next, true);
    assert.equal(run({ path: '/assetsfoo' }).next, true, 'only the /assets folder itself');
    assert.equal(run({ path: '/api/sessions', kubleUser: 'alice@staff.example.com' }).next, true, 'a confirmed login passes');
    delete process.env.INTERNAL_EMAIL_DOMAINS;
    access.useTeamsStore(createTeamsStore({ file: path.join(dir, 'none.json') }));
    assert.equal(run({ path: '/api/sessions' }).next, true, 'without a restriction the guard does nothing');
    delete process.env.AUTH_WHOAMI_URL;
    process.env.INTERNAL_EMAIL_DOMAINS = DOMAINS;
    assert.equal(run({ path: '/api/sessions' }).next, true, 'local mode');
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- budget: no free pass ---------- */

async function testBudgetRefusal() {
  const saved = { url: process.env.AUTH_WHOAMI_URL, domains: process.env.INTERNAL_EMAIL_DOMAINS };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-unconfirmed-budget-'));
  try {
    access.useTeamsStore(createTeamsStore({ file: path.join(dir, 'teams.json') }));
    const budget = budgetLib.createBudget({ index: { refresh: async () => {}, spent: () => 0 } });
    const viewerFor = (email) => access.viewerOf({ kubleUser: email }, { AUTH_WHOAMI_URL: 'https://whoami.invalid/me', INTERNAL_EMAIL_DOMAINS: DOMAINS });

    // no restriction: the anonymous caller gets the no-op grant like before
    delete process.env.INTERNAL_EMAIL_DOMAINS;
    process.env.AUTH_WHOAMI_URL = 'https://whoami.invalid/me';
    const anonymous = access.viewerOf({ kubleUser: 'lokal' }, process.env);
    assert.equal(await budget.begin(anonymous, { estimateUsd: 1 }), budgetLib.NOOP_GRANT);
    assert.equal(await budget.beginRun(anonymous, { runId: 'r1', estimateUsd: 1 }), budgetLib.NOOP_GRANT);
    assert.deepEqual(await budget.detachRun(anonymous, 'run:r1', 2), []);

    // restriction: refused
    process.env.INTERNAL_EMAIL_DOMAINS = DOMAINS;
    const refused = async (call) => {
      await assert.rejects(call, (err) => {
        assert.ok(err instanceof access.LoginUnconfirmedError);
        assert.equal(err.code, 'LOGIN_UNCONFIRMED');
        assert.equal(err.status, 401);
        assert.ok(err.messageDe && err.messages.es);
        return true;
      });
    };
    const unconfirmed = viewerFor('lokal');
    await refused(() => budget.begin(unconfirmed, { estimateUsd: 0.5 }));
    await refused(() => budget.begin(unconfirmed, { asyncJob: true }));
    await refused(() => budget.beginRun(unconfirmed, { runId: 'r2', estimateUsd: 0.5 }));
    await refused(() => budget.beginRun(unconfirmed, { runId: 'r3', estimateUsd: 0, paid: false }));
    await refused(() => budget.detachRun(unconfirmed, 'run:r2', 1));
    assert.equal(budget.reservationCount(), 0, 'nothing was reserved');
    // identified people are not affected: internal people still get the no-op grant
    assert.equal(await budget.begin(viewerFor(STAFF), { estimateUsd: 1 }), budgetLib.NOOP_GRANT);
  } finally {
    access.useTeamsStore(null);
    for (const [key, value] of [['AUTH_WHOAMI_URL', saved.url], ['INTERNAL_EMAIL_DOMAINS', saved.domains]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- whoami cache: failure 2 s, answer 10 s ---------- */

async function testWhoamiCache() {
  assert.equal(FAILURE_CACHE_TTL_MS, 2000);
  assert.equal(CACHE_TTL_MS, 10000);
  let current = 1000000;
  const now = () => current;
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const scenarios = [
    ['network error', async () => { throw new Error('offline'); }, FAILURE_CACHE_TTL_MS],
    ['HTTP 500', async () => json(500, { error: 'x' }), FAILURE_CACHE_TTL_MS],
    ['HTTP 503', async () => json(503), FAILURE_CACHE_TTL_MS],
    ['broken body', async () => new Response('<html>', { status: 200 }), FAILURE_CACHE_TTL_MS],
    ['200 logged in', async () => json(200, { logged_in: true, email: 'A@Example.com' }), CACHE_TTL_MS],
    ['200 not logged in', async () => json(200, { logged_in: false }), CACHE_TTL_MS],
    ['401', async () => json(401, { logged_in: false }), CACHE_TTL_MS],
    ['403', async () => json(403, { logged_in: false }), CACHE_TTL_MS]
  ];
  for (const [label, answer, ttl] of scenarios) {
    let requests = 0;
    const middleware = createWhoamiMiddleware({
      getUrl: () => 'http://127.0.0.1:1/whoami',
      fetchImpl: async () => {
        requests += 1;
        return answer();
      },
      now
    });
    const ask = () => new Promise((resolve, reject) => {
      const req = { headers: { cookie: `session=${label}` } };
      Promise.resolve(middleware(req, {}, () => resolve(req.kubleUser))).catch(reject);
    });
    const start = current;
    const first = await ask();
    assert.equal(requests, 1, label);
    current = start + ttl - 1;
    assert.equal(await ask(), first, `${label}: same answer inside the window`);
    assert.equal(requests, 1, `${label}: cached for ${ttl} ms`);
    current = start + ttl;
    await ask();
    assert.equal(requests, 2, `${label}: asked again after ${ttl} ms`);
  }
  // a login answer is lower-cased as before
  const middleware = createWhoamiMiddleware({ getUrl: () => 'http://127.0.0.1:1/whoami', fetchImpl: async () => json(200, { logged_in: true, email: 'A@Example.com' }), now });
  const req = { headers: {} };
  await middleware(req, {}, () => {});
  assert.equal(req.kubleUser, 'a@example.com');
}

/* ---------- the whole app ---------- */

// Fills the parameters of a route pattern with harmless values.
function concretePath(pattern) {
  return pattern.replace(':email', 'a%40example.com').replace(/:[A-Za-z]+/g, 'x');
}

async function startWhoami(status) {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'down' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/whoami` };
}

async function testApp() {
  const iso = await createIsolatedApp({
    env: { ADMIN_EMAILS: ADMIN, INTERNAL_EMAIL_DOMAINS: '', OPENROUTER_API_KEY: '', ELEVENLABS_API_KEY: '', FAL_KEY: '', GTS_API_TOKEN: '', ACCESS_ALLOWLIST_FILE: '', ACCESS_ALLOWLIST_ROUTE: '' }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  const failing = await startWhoami(500);
  try {
    // A) no teams ever, no domain list: exactly the behaviour of before
    const isoAccess = iso.load('lib/access');
    assert.equal(isoAccess.restrictionActive(), false);
    const before = await api('/api/me');
    assert.equal(before.status, 200);
    assert.equal(before.body.role, 'anonymous');
    assert.equal('loginUnconfirmed' in before.body, false);
    assert.equal((await api('/api/sessions')).status, 200, 'anonymous callers keep the existing data');
    assert.equal((await api('/api/workflows')).status, 200);
    assert.equal((await api('/api/brandings')).status, 200);

    // B) INTERNAL_EMAIL_DOMAINS set: every route of the rule table answers 401 for an anonymous caller
    iso.setEnv('INTERNAL_EMAIL_DOMAINS', DOMAINS);
    const exempt = new Set(access.UNCONFIRMED_EXEMPT_PATHS.map((entry) => `GET ${entry}`));
    let checked = 0;
    for (const route of Object.keys(ROUTE_RULES)) {
      if (route === 'GET *') continue;
      const [method, pattern] = route.split(' ');
      if (!pattern.startsWith('/api/')) continue;
      const response = await api(concretePath(pattern), { method, json: method === 'GET' || method === 'DELETE' ? undefined : {} });
      if (exempt.has(route)) {
        assert.notEqual(response.status, 401, `${route} stays reachable`);
        assert.ok(response.status < 500, `${route} -> ${response.status}`);
      } else {
        assert.equal(response.status, 401, `${route} -> ${response.status}`);
        assert.equal(response.body.code, 'LOGIN_UNCONFIRMED', route);
        assert.match(response.body.messages.en, /could not be confirmed/, route);
        assert.match(response.body.messages.es, /confirmar/, route);
        checked += 1;
      }
    }
    assert.ok(checked > 80, `${checked} routes checked`);
    // the SSE streams and the uploads are covered too (nothing is read, nothing is parsed)
    const stream = await api('/api/workflows/x/events', { raw: true, headers: { Accept: 'text/event-stream' } });
    assert.equal(stream.status, 401);
    assert.match(stream.headers.get('content-type'), /json/);
    await stream.arrayBuffer();
    const message = await api('/api/sessions/x/message', { method: 'POST', json: { text: 'hi' } });
    assert.equal(message.status, 401);
    // HEAD of a protected route
    assert.equal((await api('/api/sessions', { method: 'HEAD', raw: true })).status, 401);
    // static files and the app shell stay reachable
    for (const url of ['/', '/index.html', '/styles.css', '/help.html']) {
      const page = await api(url, { raw: true });
      assert.equal(page.status, 200, url);
      await page.arrayBuffer();
    }

    // the exceptions answer: /api/me tells it, /api/config is filtered like for guests, the registry marks Higgsfield
    const me = await api('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.loginUnconfirmed, true);
    assert.equal(me.body.role, 'anonymous');
    assert.equal(me.body.identified, false);
    const config = await api('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.gts.enabled, false);
    assert.ok(config.body.brainModels.every((model) => !String(model.id || model.value || model).startsWith('chatgpt/')));
    const registry = await api('/api/nodes/registry');
    assert.equal(registry.status, 200);
    assert.ok(registry.body.nodeTypes.filter((type) => type.category === 'higgsfield').every((type) => type.restricted === true), 'Higgsfield marked as not available');
    const templates = await api('/api/workflow-templates');
    assert.equal(templates.status, 200);
    assert.ok(templates.body.templates.length > 0 && !templates.body.templates.some((template) => template.id === 'dub-clip'), 'no Higgsfield template while the login is unconfirmed');
    assert.equal((await api('/api/workflow-templates/photo-slideshow')).status, 401, 'a single template is not one of the exceptions');
    assert.equal((await api('/api/roles/default')).status, 200);
    assert.equal((await api('/refs/nothing', { raw: true })).status, 404, 'the public reference route is not blocked (just unknown)');

    // identified people are not affected
    assert.equal((await api('/api/sessions', { as: STAFF })).status, 200);
    assert.equal((await api('/api/me', { as: STAFF })).body.loginUnconfirmed, undefined);
    assert.equal((await api('/api/teams', { as: ADMIN })).status, 200);

    // C) a participant while whoami is down: unconfirmed, then confirmed again after the short cache
    const created = await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 10 } });
    assert.equal(created.status, 201, created.text);
    assert.equal((await api(`/api/teams/${created.body.team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [CAROL] } })).status, 201);
    assert.equal((await api('/api/me', { as: CAROL })).body.role, 'participant');
    const workingUrl = process.env.AUTH_WHOAMI_URL;
    iso.setEnv('AUTH_WHOAMI_URL', failing.url);
    const dave = 'dave@example.org'; // another cookie: not cached yet
    const down = await api('/api/sessions', { as: dave });
    assert.equal(down.status, 401);
    assert.equal(down.body.code, 'LOGIN_UNCONFIRMED');
    assert.equal((await api('/api/me', { as: dave })).body.loginUnconfirmed, true);
    iso.setEnv('AUTH_WHOAMI_URL', workingUrl);
    assert.equal((await api('/api/sessions', { as: dave })).status, 401, 'the failure is still cached (2 s)');
    await sleep(FAILURE_CACHE_TTL_MS + 150);
    assert.equal((await api('/api/sessions', { as: dave })).status, 200, 'confirmed again after the short cache');
    assert.equal((await api('/api/me', { as: CAROL })).body.role, 'participant');

    // D) no domain list, but the teams file knows addresses: still restricted
    iso.setEnv('INTERNAL_EMAIL_DOMAINS', '');
    assert.equal(isoAccess.restrictionActive(), true, 'the teams file of the private copy knows addresses');
    assert.equal((await api('/api/sessions')).status, 401, 'teams exist: anonymous is unconfirmed');
    assert.equal((await api('/api/me')).body.loginUnconfirmed, true);
    // ... also after every team was deleted (the address stays known)
    assert.equal((await api(`/api/teams/${created.body.team.id}`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await api('/api/sessions')).status, 401, 'known addresses outlive the teams');
  } finally {
    await new Promise((resolve) => failing.server.close(resolve));
    await iso.cleanup();
  }
}

/* ---------- local mode ---------- */

async function testLocalMode() {
  const iso = await createIsolatedApp({ active: false, env: { ADMIN_EMAILS: ADMIN, INTERNAL_EMAIL_DOMAINS: DOMAINS, OPENROUTER_API_KEY: '', ACCESS_ALLOWLIST_FILE: '', ACCESS_ALLOWLIST_ROUTE: '' } });
  await iso.listen();
  try {
    assert.equal((await iso.request('/api/sessions')).status, 200);
    assert.equal((await iso.request('/api/workflows')).status, 200);
    const me = await iso.request('/api/me');
    assert.equal(me.body.role, 'local');
    assert.equal('loginUnconfirmed' in me.body, false);
  } finally {
    await iso.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
