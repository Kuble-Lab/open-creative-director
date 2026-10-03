'use strict';

// Route-level tests of the agent access (WP27, parts 1 and 2) in a private copy of the app (temp data folders, ephemeral
// port, whoami stub): the key management API with its roles, a key at /mcp without any login, what happens when the
// person behind a key is deleted or turns into a participant, that the secret is shown once and then never appears in a
// file, an answer or a log line, that the old routes are untouched, and the local mode. Nothing is paid, nothing leaves the
// machine.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const STAFF2 = 'staff2@staff.example.com';
const P1 = 'p1@gmail.example';
const GUEST = 'alumni@gmail.example';

const logged = [];
function captureLogs() {
  const originals = {};
  for (const level of ['log', 'warn', 'error', 'info']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) || String(arg))).join(' '));
  }
  return () => Object.assign(console, originals);
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const bearer = (secret) => ({ Authorization: `Bearer ${secret}` });
const hello = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } };

async function main() {
  const restoreLogs = captureLogs();
  const seenSecrets = [];
  const responses = [];
  try {
    await testActiveMode(seenSecrets, responses);
    await testLocalMode(seenSecrets, responses);
  } finally {
    restoreLogs();
  }
  const output = `${logged.join('\n')}\n${responses.join('\n')}`;
  assert.ok(seenSecrets.length >= 4);
  for (const secret of seenSecrets) {
    assert.ok(!output.includes(secret), 'a secret shows up in a log line or in an answer that must not carry it');
    assert.ok(!output.includes(secret.slice(7)), 'nor its random part');
  }
  console.log('MCP-API: Verwaltung der Schlüssel nach Rolle, Zugang ohne Anmeldung, Person gelöscht oder Teilnehmende, Secret nur einmal, unveränderte Routen und lokaler Modus sind korrekt.');
  console.log('test-mcp-api.js: ok');
}

async function testActiveMode(seenSecrets, responses) {
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      PUBLIC_BASE_URL: 'https://creator.example.com',
      OPENROUTER_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  const mcp = async (secret, message, options = {}) => {
    const response = await api('/mcp', { method: 'POST', headers: { ...(secret ? bearer(secret) : {}), ...(options.headers || {}) }, json: message, as: options.as });
    responses.push(response.text);
    return response;
  };
  try {
    // people: a participant (in a team) and a guest
    const team = await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 5 } });
    assert.equal(team.status, 201, team.text);
    assert.equal((await api(`/api/teams/${team.body.team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);
    await api('/api/me', { as: STAFF }); // the first sight records a person on the team list
    await api('/api/me', { as: STAFF2 });

    /* ----- who may manage keys ----- */

    const anonymous = await api('/api/mcp/keys');
    assert.equal(anonymous.status, 401, 'an unconfirmed login is refused like everywhere');
    assert.equal(anonymous.body.code, 'LOGIN_UNCONFIRMED');
    for (const email of [P1, GUEST]) {
      for (const [method, url, json] of [['GET', '/api/mcp/keys'], ['POST', '/api/mcp/keys', { name: 'X', right: 'read' }], ['PATCH', '/api/mcp/keys/kaaaaaaaaaaaaaaaa', { name: 'X' }], ['DELETE', '/api/mcp/keys/kaaaaaaaaaaaaaaaa']]) {
        const response = await api(url, { method, as: email, json });
        assert.equal(response.status, 403, `${method} ${url} as ${email}`);
        assert.equal(response.body.code, 'FORBIDDEN_FOR_ROLE');
        assert.equal(response.body.feature, 'mcp');
      }
    }
    assert.deepEqual((await api('/api/mcp/keys', { as: STAFF })).body.keys, []);

    /* ----- create: the secret is in the answer once ----- */

    const created = await api('/api/mcp/keys', { method: 'POST', as: STAFF, json: { name: 'Claude Code', right: 'read' } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const secret = created.body.secret;
    seenSecrets.push(secret);
    assert.match(secret, /^ocd_k1_[A-Za-z0-9_-]{43}$/);
    const key = created.body.key;
    assert.equal(key.owner, STAFF);
    assert.equal(key.right, 'read');
    assert.equal(key.maxRunUsd, 2);
    assert.equal(key.maxMonthUsd, 20);
    assert.equal(key.status, 'active');
    assert.equal(key.prefix, secret.slice(0, 11));
    assert.equal(Math.round((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86400000), 90);
    assert.ok(!created.text.replace(secret, '').includes(secret.slice(7)), 'the secret is in the answer once');

    const starter = await api('/api/mcp/keys', { method: 'POST', as: STAFF, json: { name: 'Bot', right: 'start', maxRunUsd: 0.5, maxMonthUsd: 3, expiresInDays: 30 } });
    assert.equal(starter.status, 201);
    seenSecrets.push(starter.body.secret);
    assert.equal(starter.body.key.maxRunUsd, 0.5);
    const adminKey = await api('/api/mcp/keys', { method: 'POST', as: ADMIN, json: { name: 'Admin-Agent', right: 'start' } });
    assert.equal(adminKey.status, 201);
    seenSecrets.push(adminKey.body.secret);
    assert.equal(adminKey.body.key.owner, ADMIN);

    for (const [json, code] of [
      [{ right: 'read' }, 'INVALID_NAME'],
      [{ name: 'X' }, 'INVALID_RIGHT'],
      [{ name: 'X', right: 'owner' }, 'INVALID_RIGHT'],
      [{ name: 'X', right: 'read', maxRunUsd: -2 }, 'INVALID_LIMIT'],
      [{ name: 'X', right: 'read', maxMonthUsd: 'viel' }, 'INVALID_LIMIT'],
      [{ name: 'X', right: 'read', expiresInDays: 1000 }, 'INVALID_EXPIRY'],
      [{ name: 'X', right: 'read', owner: STAFF2 }, null]
    ]) {
      const response = await api('/api/mcp/keys', { method: 'POST', as: STAFF, json });
      if (code) {
        assert.equal(response.status, 400, JSON.stringify(json));
        assert.equal(response.body.code, code, JSON.stringify(json));
      } else {
        assert.equal(response.status, 201, 'an owner in the request is ignored');
        assert.equal(response.body.key.owner, STAFF, 'a key is always for the person who creates it');
        seenSecrets.push(response.body.secret);
        await api(`/api/mcp/keys/${response.body.key.id}`, { method: 'DELETE', as: STAFF });
      }
    }

    /* ----- the list ----- */

    const own = await api('/api/mcp/keys', { as: STAFF });
    assert.equal(own.status, 200);
    assert.equal(own.body.scope, 'own');
    assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.equal(own.body.endpoint, 'https://creator.example.com/mcp');
    assert.deepEqual(own.body.defaults, { maxRunUsd: 2, maxMonthUsd: 20, expiresInDays: 90 });
    assert.deepEqual(own.body.rights, ['read', 'start']);
    assert.equal(own.body.keys.filter((entry) => entry.status === 'active').length, 2);
    assert.ok(own.body.keys.every((entry) => entry.owner === STAFF));
    for (const secretValue of seenSecrets) assert.ok(!own.text.includes(secretValue.slice(7)), 'a list never shows a secret');
    assert.ok(!own.text.includes('"hash"'));
    assert.deepEqual((await api('/api/mcp/keys', { as: STAFF2 })).body.keys, [], 'somebody else sees nothing of it');
    const all = await api('/api/mcp/keys', { as: ADMIN });
    assert.equal(all.body.scope, 'all');
    assert.deepEqual(new Set(all.body.keys.map((entry) => entry.owner)), new Set([STAFF, ADMIN]), 'admins see every key');

    /* ----- the file holds the hash only ----- */

    const onDisk = fs.readFileSync(path.join(iso.root, 'data', 'mcp-keys.json'), 'utf8');
    for (const secretValue of seenSecrets) assert.ok(!onDisk.includes(secretValue.slice(7, 30)), 'no secret in the file');
    assert.equal(fs.statSync(path.join(iso.root, 'data', 'mcp-keys.json')).mode & 0o777, 0o600);
    assert.match(JSON.parse(onDisk).keys[0].hash, /^[0-9a-f]{64}$/);

    /* ----- change and revoke: owner or admin, nobody else ----- */

    assert.equal((await api(`/api/mcp/keys/${key.id}`, { method: 'PATCH', as: STAFF2, json: { name: 'Meins' } })).status, 404);
    assert.equal((await api(`/api/mcp/keys/${key.id}`, { method: 'DELETE', as: STAFF2 })).status, 404, "somebody else's key does not exist");
    const patched = await api(`/api/mcp/keys/${key.id}`, { method: 'PATCH', as: STAFF, json: { name: 'Claude Code (Büro)', maxRunUsd: 1.5, maxMonthUsd: 10 } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.key.name, 'Claude Code (Büro)');
    assert.equal(patched.body.key.maxRunUsd, 1.5);
    assert.equal(patched.body.key.right, 'read');
    assert.equal((await api(`/api/mcp/keys/${key.id}`, { method: 'PATCH', as: STAFF, json: { maxRunUsd: -1 } })).body.code, 'INVALID_LIMIT');
    assert.equal((await api('/api/mcp/keys/nonsense', { method: 'DELETE', as: STAFF })).status, 404);
    assert.equal((await api(`/api/mcp/keys/${adminKey.body.key.id}`, { method: 'DELETE', as: STAFF })).status, 404, 'a staff member cannot touch the key of an admin');

    /* ----- a key is the login of /mcp ----- */

    assert.equal((await mcp(null, rpc(1, 'initialize', hello))).status, 401);
    assert.equal((await mcp(null, rpc(1, 'initialize', hello), { as: ADMIN })).status, 401, 'a login cookie is not a key');
    const init = await mcp(secret, rpc(1, 'initialize', hello));
    assert.equal(init.status, 200, init.text);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'open-creative-director');
    const initWithOtherCookie = await mcp(secret, rpc(2, 'tools/list'), { as: GUEST });
    assert.equal(initWithOtherCookie.status, 200, 'the cookie of somebody else changes nothing');
    assert.deepEqual(initWithOtherCookie.body.result.tools.map((tool) => tool.name), ['estimate_run', 'get_run', 'get_workflow', 'list_templates', 'list_workflows'], 'a read key lists the reading tools');
    assert.equal((await mcp(secret, rpc(3, 'ping'))).status, 200);
    assert.equal((await api('/mcp', { method: 'GET', headers: bearer(secret) })).status, 405);
    assert.equal((await api('/mcp', { method: 'GET', as: ADMIN })).status, 405);
    assert.equal((await api('/mcp/x', { method: 'GET', as: ADMIN })).status, 404);
    // "last used" is recorded
    const afterUse = (await api('/api/mcp/keys', { as: STAFF })).body.keys.find((entry) => entry.id === key.id);
    assert.ok(afterUse.lastUsedAt, 'last used is set');
    assert.ok(Date.now() - Date.parse(afterUse.lastUsedAt) < 60000);

    // the key of an admin works the same way
    assert.equal((await mcp(adminKey.body.secret, rpc(1, 'ping'))).status, 200);

    // revoke: from now on it fails
    const revoked = await api(`/api/mcp/keys/${starter.body.key.id}`, { method: 'DELETE', as: STAFF });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.key.status, 'revoked');
    assert.equal((await api(`/api/mcp/keys/${starter.body.key.id}`, { method: 'DELETE', as: STAFF })).body.key.revokedAt, revoked.body.key.revokedAt, 'revoking twice changes nothing');
    const refused = await mcp(starter.body.secret, rpc(1, 'ping'));
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error.data.reason, 'revoked');
    assert.equal((await api(`/api/mcp/keys/${starter.body.key.id}`, { method: 'PATCH', as: STAFF, json: { name: 'x' } })).body.code, 'KEY_REVOKED');
    // an admin revokes the key of somebody else
    const forAdminRevoke = await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'Fremd', right: 'read' } });
    seenSecrets.push(forAdminRevoke.body.secret);
    assert.equal((await mcp(forAdminRevoke.body.secret, rpc(1, 'ping'))).status, 200);
    assert.equal((await api(`/api/mcp/keys/${forAdminRevoke.body.key.id}`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await mcp(forAdminRevoke.body.secret, rpc(1, 'ping'))).status, 401);

    /* ----- the person behind a key ----- */

    // deleted from the team list: the key stops working at once, and works again when the person is added back
    assert.equal((await api(`/api/users/${encodeURIComponent(STAFF)}`, { method: 'DELETE', as: ADMIN })).status, 200);
    const deleted = await mcp(secret, rpc(1, 'ping'));
    assert.equal(deleted.status, 403);
    assert.equal(deleted.body.error.data.reason, 'owner_invalid');
    assert.equal((await api('/api/mcp/keys', { as: ADMIN })).body.keys.find((entry) => entry.id === key.id).ownerValid, false, 'the settings page can show it');
    // and nobody removed from the team list makes a new key (it would be refused at once); looking at the list is still allowed
    const afterDelete = await api('/api/mcp/keys', { method: 'POST', as: STAFF, json: { name: 'Nach dem Löschen', right: 'read' } });
    assert.equal(afterDelete.status, 403, afterDelete.text);
    assert.equal(afterDelete.body.code, 'FORBIDDEN_FOR_ROLE');
    assert.equal(afterDelete.body.feature, 'mcp');
    assert.ok(!afterDelete.text.includes('ocd_k1_'), 'no secret in the refusal');
    assert.equal((await api('/api/mcp/keys', { as: STAFF })).status, 200);
    assert.equal((await api('/api/users', { method: 'POST', as: ADMIN, json: { email: STAFF } })).status, 201);
    assert.equal((await api('/api/mcp/keys', { method: 'POST', as: STAFF, json: { name: 'Wieder da', right: 'read' } })).status, 201, 'back on the list: a key again');
    assert.equal((await mcp(secret, rpc(1, 'ping'))).status, 200);

    // becomes a participant (a team member): no key for participants
    const second = await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'Zweiter', right: 'start' } });
    seenSecrets.push(second.body.secret);
    assert.equal((await mcp(second.body.secret, rpc(1, 'ping'))).status, 200);
    assert.equal((await api(`/api/teams/${team.body.team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [STAFF2] } })).status, 201);
    const participant = await mcp(second.body.secret, rpc(1, 'ping'));
    assert.equal(participant.status, 403);
    assert.equal(participant.body.error.data.reason, 'owner_invalid');
    assert.equal((await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'Neu', right: 'read' } })).status, 403, 'and no new key');
    assert.equal((await api(`/api/teams/${team.body.team.id}/members/${encodeURIComponent(STAFF2)}`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await mcp(second.body.secret, rpc(1, 'ping'))).status, 200, 'valid again when the person is internal again');

    // the admin role is lost: the key goes on as the key of an internal person (a staff address that is on the team list)
    assert.equal((await api('/api/admins', { method: 'POST', as: ADMIN, json: { email: STAFF2 } })).status, 201);
    const promoted = await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'Als Admin', right: 'read' } });
    seenSecrets.push(promoted.body.secret);
    assert.equal((await mcp(promoted.body.secret, rpc(1, 'ping'))).status, 200);
    assert.equal((await api(`/api/admins/${encodeURIComponent(STAFF2)}`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await mcp(promoted.body.secret, rpc(1, 'ping'))).status, 200);
    // an address outside the internal domains that is no admin cannot hold a valid key: the admin of such an address is removed
    assert.equal((await api('/api/admins', { method: 'POST', as: ADMIN, json: { email: GUEST } })).status, 201);
    const outsider = await api('/api/mcp/keys', { method: 'POST', as: GUEST, json: { name: 'Extern', right: 'read' } });
    assert.equal(outsider.status, 201, 'an admin from any domain may');
    seenSecrets.push(outsider.body.secret);
    assert.equal((await mcp(outsider.body.secret, rpc(1, 'ping'))).status, 200);
    assert.equal((await api(`/api/admins/${encodeURIComponent(GUEST)}`, { method: 'DELETE', as: ADMIN })).status, 200);
    const noLonger = await mcp(outsider.body.secret, rpc(1, 'ping'));
    assert.equal(noLonger.status, 403, 'no admin, not internal: the key is no longer valid');
    assert.equal(noLonger.body.error.data.reason, 'owner_invalid');

    /* ----- the rest of the app is as it was ----- */

    assert.equal((await api('/api/me', { as: STAFF })).body.role, 'user');
    assert.equal((await api('/api/me', { as: ADMIN })).body.isAdmin, true);
    const shell = await api('/some/page', { as: STAFF });
    assert.equal(shell.status, 200);
    assert.match(shell.text, /<html/i, 'the catch-all of the app shell still answers');
    assert.equal((await api('/api/sessions', { as: STAFF })).status, 200);
    assert.equal((await api('/api/costs/summary', { as: ADMIN })).status, 200);
    assert.equal(fs.existsSync(path.join(iso.root, 'data', 'costs.jsonl')), false, 'nothing was paid and no key went into the cost journal');
  } finally {
    await iso.cleanup();
  }
}

async function testLocalMode(seenSecrets, responses) {
  const iso = await createIsolatedApp({ active: false, env: { OPENROUTER_API_KEY: '', ELEVENLABS_API_KEY: '', FAL_KEY: '', GTS_API_TOKEN: '' } });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const api = iso.request;
  try {
    // no user management: one local person, who may create keys; the key acts as that person
    const created = await api('/api/mcp/keys', { method: 'POST', json: { name: 'Lokal', right: 'start' } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.key.owner, 'lokal');
    seenSecrets.push(created.body.secret);
    const listed = await api('/api/mcp/keys');
    assert.equal(listed.body.scope, 'all');
    assert.equal(listed.body.keys.length, 1);
    assert.match(listed.body.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const init = await api('/mcp', { method: 'POST', headers: bearer(created.body.secret), json: rpc(1, 'initialize', hello) });
    responses.push(init.text);
    assert.equal(init.status, 200);
    assert.equal((await api('/mcp', { method: 'POST', json: rpc(1, 'ping') })).status, 401, 'also here: no key, no access');
    assert.equal((await api('/mcp', { method: 'POST', headers: bearer(`ocd_k1_${'x'.repeat(43)}`), json: rpc(1, 'ping') })).status, 401);
    assert.equal((await api('/mcp')).status, 405);
    assert.equal((await api(`/api/mcp/keys/${created.body.key.id}`, { method: 'DELETE' })).body.key.status, 'revoked');
    assert.equal((await api('/mcp', { method: 'POST', headers: bearer(created.body.secret), json: rpc(1, 'ping') })).status, 401);
  } finally {
    await iso.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
