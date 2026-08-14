'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const adminsModule = require('../lib/admins');
const {
  MAX_ADMINS,
  AdminValidationError,
  AdminNotFoundError,
  normalizeEmail,
  envAdminEmails,
  createAdminsStore
} = adminsModule;

function routeHandler(app, routePath, method) {
  const layer = app._router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRoute(app, routePath, method, { params = {}, body = {}, kubleUser = 'env@example.com' } = {}) {
  const handler = routeHandler(app, routePath, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) { result.status = code; return this; },
      json(value) { result.body = value; resolve(result); }
    };
    Promise.resolve(handler({ params, body, kubleUser }, res)).catch(reject);
  });
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-admins-'));
  const file = path.join(directory, 'admins.json');
  const originalEnv = {
    auth: process.env.AUTH_WHOAMI_URL,
    admins: process.env.ADMIN_EMAILS
  };
  const originals = {
    envAdminEmails: adminsModule.envAdminEmails,
    listStoredAdmins: adminsModule.listStoredAdmins,
    listAdmins: adminsModule.listAdmins,
    addAdmin: adminsModule.addAdmin,
    deleteAdmin: adminsModule.deleteAdmin
  };

  try {
    process.env.AUTH_WHOAMI_URL = 'https://whoami.test';
    process.env.ADMIN_EMAILS = ' ENV@Example.com,env@example.com, second@example.org ';
    assert.deepEqual(envAdminEmails({}), [], 'Ohne ADMIN_EMAILS darf es keinen eingebauten Admin geben.');
    assert.equal(normalizeEmail(' Admin@Example.COM '), 'admin@example.com');
    assert.deepEqual(envAdminEmails(), ['env@example.com', 'second@example.org']);
    assert.throws(() => normalizeEmail('ungueltig'), AdminValidationError);
    assert.throws(() => normalizeEmail('a@b'), AdminValidationError);
    assert.throws(() => normalizeEmail('a@b.'), AdminValidationError);

    const store = createAdminsStore({ file });
    assert.deepEqual(store.listStoredAdmins(), []);
    assert.equal(store.addAdmin(' Team@Example.com '), 'team@example.com');
    assert.deepEqual(store.listStoredAdmins(), ['team@example.com']);
    assert.throws(() => store.addAdmin('TEAM@example.com'), (err) => err instanceof AdminValidationError && /bereits/.test(err.message));
    assert.throws(() => store.addAdmin('env@example.com'), (err) => err instanceof AdminValidationError && /bereits/.test(err.message));
    assert.deepEqual(store.listAdmins().map((entry) => `${entry.email}:${entry.source}`), [
      'env@example.com:env',
      'second@example.org:env',
      'team@example.com:settings'
    ]);
    assert.throws(() => store.deleteAdmin('env@example.com'), (err) => err instanceof AdminValidationError && /nicht entfernbar/.test(err.message));
    assert.equal(store.deleteAdmin('TEAM@example.com'), 'team@example.com');
    assert.deepEqual(store.listStoredAdmins(), []);
    assert.throws(() => store.deleteAdmin('missing@example.com'), AdminNotFoundError);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'data/admins.json muss chmod 600 haben.');

    fs.writeFileSync(file, `${JSON.stringify(Array.from({ length: MAX_ADMINS }, (_, i) => `admin${i}@example.com`))}\n`);
    assert.throws(() => store.addAdmin('extra@example.com'), (err) => err instanceof AdminValidationError && /maximal 50/.test(err.message));

    const { app, isAdmin } = require('../server');
    adminsModule.envAdminEmails = () => ['env@example.com'];
    adminsModule.listStoredAdmins = () => ['settings@example.com'];
    assert.equal(isAdmin({ kubleUser: 'ENV@example.com' }), true, 'Env-Admin muss immer Admin bleiben.');
    assert.equal(isAdmin({ kubleUser: 'settings@example.com' }), true, 'Settings-Admin wurde nicht erkannt.');
    assert.equal(isAdmin({ kubleUser: 'visitor@example.com' }), false);
    assert.equal(isAdmin({ kubleUser: '' }), false, 'Whoami-Fehler muss fail-closed bleiben.');
    adminsModule.listStoredAdmins = () => { throw new Error('kaputt'); };
    assert.equal(isAdmin({ kubleUser: 'settings@example.com' }), false, 'Store-Fehler muss fail-closed sein.');
    assert.equal(isAdmin({ kubleUser: 'env@example.com' }), true, 'Env-Admin darf durch Store-Fehler nicht ausgesperrt werden.');
    delete process.env.AUTH_WHOAMI_URL;
    assert.equal(isAdmin({ kubleUser: '' }), true, 'Lokal ohne AUTH_WHOAMI_URL muss der Zugriff offen bleiben.');

    process.env.AUTH_WHOAMI_URL = 'https://whoami.test';
    const calls = [];
    adminsModule.listStoredAdmins = () => [];
    adminsModule.listAdmins = () => [{ email: 'env@example.com', source: 'env' }];
    adminsModule.addAdmin = (email) => calls.push(['add', email]);
    adminsModule.deleteAdmin = (email) => calls.push(['delete', email]);
    const forbidden = await invokeRoute(app, '/api/admins', 'get', { kubleUser: 'visitor@example.com' });
    assert.equal(forbidden.status, 403);
    assert.equal((await invokeRoute(app, '/api/admins', 'get')).status, 200);
    assert.equal((await invokeRoute(app, '/api/admins', 'post', { body: { email: 'new@example.com' } })).status, 201);
    assert.equal((await invokeRoute(app, '/api/admins/:email', 'delete', { params: { email: 'new@example.com' } })).status, 200);
    assert.deepEqual(calls, [['add', 'new@example.com'], ['delete', 'new@example.com']]);

    console.log('Admins: Validierung, Normalisierung, Dedupe, Env-Schutz, CRUD und fail-closed isAdmin sind korrekt.');
  } finally {
    adminsModule.envAdminEmails = originals.envAdminEmails;
    adminsModule.listStoredAdmins = originals.listStoredAdmins;
    adminsModule.listAdmins = originals.listAdmins;
    adminsModule.addAdmin = originals.addAdmin;
    adminsModule.deleteAdmin = originals.deleteAdmin;
    if (originalEnv.auth === undefined) delete process.env.AUTH_WHOAMI_URL;
    else process.env.AUTH_WHOAMI_URL = originalEnv.auth;
    if (originalEnv.admins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalEnv.admins;
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
