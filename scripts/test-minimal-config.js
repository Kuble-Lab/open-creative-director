'use strict';

const assert = require('node:assert/strict');

const OPTIONAL_VARIABLES = [
  'ELEVENLABS_API_KEY',
  'RENDER_NODE_URL',
  'RENDER_NODE_TOKEN',
  'GTS_API_TOKEN',
  'GTS_BASE_URL',
  'AUTH_WHOAMI_URL',
  'ADMIN_EMAILS',
  'PUBLIC_BASE_URL'
];

function routeHandler(app, routePath, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(app, routePath, { method = 'get', query = {} } = {}) {
  const handler = routeHandler(app, routePath, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; resolve(result); }
    };
    Promise.resolve(handler({ query }, res)).catch(reject);
  });
}

async function main() {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originals = Object.fromEntries(OPTIONAL_VARIABLES.map((name) => [name, process.env[name]]));

  try {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-with-enough-length';
    for (const name of OPTIONAL_VARIABLES) delete process.env[name];

    const { app, isAdmin } = require('../server');
    const config = await invoke(app, '/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.hasKey, true);
    assert.deepEqual(config.body.gts, { enabled: false });
    assert.equal(isAdmin({ authUser: '', kubleUser: '' }), true, 'Lokaler Betrieb muss ohne Auth-Proxy offen sein.');

    const gtsSearch = await invoke(app, '/api/gts/search', { query: { q: 'test' } });
    assert.equal(gtsSearch.status, 503);
    assert.match(gtsSearch.body.error, /GTS ist nicht konfiguriert/);

    const renderStatus = await invoke(app, '/api/rendernode/status');
    assert.equal(renderStatus.status, 200);
    assert.equal(renderStatus.body.enabled, false);

    console.log('Minimalkonfiguration: Server-Modul laedt nur mit OPENROUTER_API_KEY; GTS und Render-Node bleiben sauber inaktiv.');
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    for (const name of OPTIONAL_VARIABLES) {
      if (originals[name] === undefined) delete process.env[name];
      else process.env[name] = originals[name];
    }
  }
  console.log('test-minimal-config.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
