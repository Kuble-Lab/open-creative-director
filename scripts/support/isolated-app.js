'use strict';

// Test support (not a test): a private copy of the app in a temp directory, so route tests never touch the real
// data/, projects/ or assets/ folders and never bind a fixed port. The copy shares node_modules and public/ by
// symlink; everything the app writes (chats, workflows, cost journal, team files) lands in the temp directory.
//
//   const isolated = await createIsolatedApp();      // { root, app, listen, request, whoami, cleanup, require }
//   createIsolatedApp({ env: {...}, config: {...} }) // environment variables / fields of the copy's config.json
//   const { port } = await isolated.listen();        // ephemeral port on 127.0.0.1
//   await isolated.request('/api/me', { as: 'alice@example.com' });
//   await isolated.cleanup();
//
// whoami: a tiny stub HTTP server. AUTH_WHOAMI_URL points at it; it answers with the address in the request's
// `uid` cookie (or logged_in:false without one), so a test picks the identity per request with `as:`.

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startWhoami() {
  const server = http.createServer((req, res) => {
    const match = /(?:^|;\s*)uid=([^;]*)/.exec(String(req.headers.cookie || ''));
    const email = match ? decodeURIComponent(match[1]) : '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(email ? { logged_in: true, email } : { logged_in: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/whoami` };
}

async function createIsolatedApp({ active = true, env = {}, config = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-isolated-'));
  await fsp.cp(path.join(REPO, 'lib'), path.join(root, 'lib'), { recursive: true });
  await fsp.cp(path.join(REPO, 'views'), path.join(root, 'views'), { recursive: true }).catch(() => {});
  for (const file of ['server.js', 'config.json', 'SystemPrompt-Video-Creativ-Director.md', 'package.json']) {
    await fsp.copyFile(path.join(REPO, file), path.join(root, file));
  }
  // `config`: fields merged into the copy's config.json (the repository's file stays as it is).
  if (config) {
    const file = path.join(root, 'config.json');
    await fsp.writeFile(file, `${JSON.stringify({ ...JSON.parse(await fsp.readFile(file, 'utf8')), ...config }, null, 2)}\n`);
  }
  await fsp.cp(path.join(REPO, 'config'), path.join(root, 'config'), { recursive: true }).catch(() => {});
  await fsp.symlink(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await fsp.symlink(path.join(REPO, 'public'), path.join(root, 'public'), 'dir');

  const whoami = await startWhoami();
  const saved = {};
  const set = (key, value) => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = value;
  };
  set('AUTH_WHOAMI_URL', active ? whoami.url : undefined);
  for (const key of ['ADMIN_EMAILS', 'SUPERADMIN_EMAILS', 'AUTH_LOGOUT_URL']) set(key, undefined);
  for (const [key, value] of Object.entries(env)) set(key, value);

  const mod = require(path.join(root, 'server.js'));
  let httpServer = null;
  let port = 0;

  async function listen() {
    httpServer = await new Promise((resolve) => {
      const instance = mod.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    port = httpServer.address().port;
    if (port === 3111) throw new Error('Refusing to run on port 3111');
    return { port };
  }

  // Fetch against the private server. as: e-mail address of the caller (cookie for the whoami stub), json: request body.
  async function request(url, { method = 'GET', as = null, json, headers = {}, body, raw = false } = {}) {
    const requestHeaders = { ...headers };
    if (as) requestHeaders.Cookie = `uid=${encodeURIComponent(as)}`;
    let payload = body;
    if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: requestHeaders, body: payload });
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return { status: response.status, body: data, text, headers: response.headers };
  }

  // GET with the path exactly as given (no URL normalisation), for path-trick tests. Resolves the status code.
  function rawStatus(rawPath, { as = null } = {}) {
    return new Promise((resolve, reject) => {
      const headers = as ? { Cookie: `uid=${encodeURIComponent(as)}` } : {};
      const req = http.request({ host: '127.0.0.1', port, path: rawPath, headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function cleanup() {
    if (httpServer) await new Promise((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(resolve); });
    await new Promise((resolve) => whoami.server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Background writers (team record, error journal) may still be finishing: retry instead of failing the test.
    await sleep(150);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    // The copy's modules stay in require.cache; a test process runs one isolated app.
  }

  return {
    root,
    app: mod.app,
    server: mod,
    listen,
    request,
    rawStatus,
    get port() {
      return port;
    },
    whoami,
    cleanup,
    load: (relative) => require(path.join(root, relative)),
    setEnv: set
  };
}

module.exports = { createIsolatedApp, REPO };
