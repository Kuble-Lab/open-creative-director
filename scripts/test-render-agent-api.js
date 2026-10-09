'use strict';

// Route-level tests of the own computers (WP46) in a private copy of the app with user management (whoami stub, temp data,
// ephemeral port): the paths of the computers work without a login cookie and the login middleware neither blocks nor
// changes them (it is not even asked), nothing else is reachable through their prefix, pairing over HTTP (code, package,
// version check, once, limits per IP address), a computer only ever sees, fetches and returns its own jobs, the people's
// routes by role, removal stops a token at once, the token appears in no answer but the pairing answer, in no log and in
// no file, and a missing render-node/ folder gives a clear answer. No paid call, nothing leaves the machine.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIsolatedApp, REPO } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const ANNA = 'anna@example.com';
const BEN = 'ben@example.com';
const VERSIONS = { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0', ffmpeg: '6.1.1', ffmpegSource: 'bundled' };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(300, 9)]);
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="main-composition" data-width="1920" data-height="1080">x</div></body></html>';

const logged = [];
function captureLogs() {
  const originals = {};
  for (const level of ['log', 'warn', 'error', 'info']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) || String(arg))).join(' '));
  }
  return () => Object.assign(console, originals);
}

function embeddedPackage(text) {
  const start = text.indexOf('const PACKAGE = ') + 'const PACKAGE = '.length;
  const end = text.indexOf(';\n', start);
  return JSON.parse(text.slice(start, end));
}

async function main() {
  const restoreLogs = captureLogs();
  const responses = [];
  const tokens = [];
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      INTERNAL_EMAIL_DOMAINS: 'example.com',
      PUBLIC_BASE_URL: 'https://creator.example.com',
      RENDER_AGENT_PACKAGE_DIR: path.join(REPO, 'render-node'),
      OPENROUTER_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const keepAlive = setInterval(() => {}, 1000);
  let whoamiCalls = 0;
  iso.whoami.server.on('request', () => {
    whoamiCalls += 1;
  });
  const api = async (url, options = {}) => {
    const response = await iso.request(url, options);
    responses.push({ url, text: response.text });
    return response;
  };
  const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const rendernode = iso.load('lib/rendernode.js');
  const queue = rendernode.queue();
  queue.config.pollWaitMs = 150;
  try {
    /* ---------- the login exceptions ---------- */
    const before = whoamiCalls;
    const installSh = await api('/api/render-agent/install.sh', { headers: { Cookie: 'uid=admin@example.com' } });
    assert.equal(installSh.status, 200);
    assert.match(installSh.text, /^#!\/usr\/bin\/env bash/);
    assert.match(installSh.headers.get('content-type'), /shellscript/);
    assert.equal(installSh.headers.get('cache-control'), 'no-store');
    const installPs = await api('/api/render-agent/install.ps1');
    assert.equal(installPs.status, 200);
    assert.ok(!/\bexit\b/i.test(installPs.text.replace(/^#.*$/gm, '')), 'the PowerShell installer never ends the session it runs in');
    const noToken = await api('/api/render-agent/poll', { method: 'POST', json: { versions: VERSIONS } });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.code, 'UNAUTHORIZED', 'the answer of the agent route, not of the login');
    assert.equal((await api('/api/render-agent/package')).status, 401);
    assert.equal((await api('/api/render-agent/poll')).status, 404, 'only the named methods');
    assert.equal((await api('/api/render-agent/anything', { headers: { Cookie: `uid=${ADMIN}` } })).body.code, 'NOT_FOUND');
    assert.equal(await iso.rawStatus('/api/render-agent/../render-agents', { as: ADMIN }), 404, 'no way out of the prefix');
    assert.equal(await iso.rawStatus('/api/render-agent/%2e%2e/render-agents', { as: ADMIN }), 404);
    assert.equal(whoamiCalls, before, 'the login is not asked for the paths of the computers');
    // the people's routes need a login
    for (const [method, url] of [['GET', '/api/render-agents'], ['POST', '/api/render-agents/pairing-code'], ['DELETE', '/api/render-agents/ra-000000000000']]) {
      const anonymous = await api(url, { method });
      assert.ok([401, 403].includes(anonymous.status), `${method} ${url}: ${anonymous.status}`);
    }

    /* ---------- pairing ---------- */
    const pairing = await api('/api/render-agents/pairing-code', { method: 'POST', as: ANNA });
    assert.equal(pairing.status, 201, pairing.text);
    const { code } = pairing.body;
    assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    assert.equal(pairing.body.ttlSeconds, 600);
    assert.equal(pairing.body.commands.bash, `curl -fsSL https://creator.example.com/api/render-agent/install.sh | bash -s -- --server https://creator.example.com --code ${code}`);
    assert.ok(pairing.body.commands.powershell.includes(`irm 'https://creator.example.com/api/render-agent/install.ps1'`));
    assert.ok(pairing.body.commands.powershell.endsWith(`-Server 'https://creator.example.com' -Code '${code}'`));
    // the package: with the code (checked, not used up), a fixed list of files, each with its checksum
    assert.equal((await api('/api/render-agent/package', { headers: { 'X-Render-Agent-Code': 'ZZZZ-ZZZZ' } })).body.code, 'INVALID_CODE');
    const pkg = await api('/api/render-agent/package', { headers: { 'X-Render-Agent-Code': code } });
    assert.equal(pkg.status, 200);
    assert.match(pkg.headers.get('content-type'), /javascript/);
    const manifest = embeddedPackage(pkg.text);
    assert.deepEqual(manifest.files.map((file) => file.path), ['agent.js', 'service.js', 'template/hyperframes.json', 'package.json', 'package-lock.json', 'README.md']);
    for (const file of manifest.files) {
      assert.equal(crypto.createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'), file.sha256);
      assert.ok(!/service\.env|^jobs\/|uploads\/|node_modules|agent\.json/.test(file.path));
    }
    assert.equal(manifest.hyperframes, '0.8.139');
    assert.equal(JSON.parse(Buffer.from(manifest.files.find((file) => file.path === 'package.json').base64, 'base64')).dependencies.hyperframes, '0.8.139');
    // the version check refuses an old agent before the code is used up
    const outdated = await api('/api/render-agent/pair', { method: 'POST', json: { code, name: 'Annas Mac', platform: 'darwin-arm64', versions: { ...VERSIONS, hyperframes: '0.8.130' } } });
    assert.equal(outdated.status, 426);
    assert.deepEqual(outdated.body.required, { protocol: 1, hyperframes: '0.8.139' });
    const paired = await iso.request('/api/render-agent/pair', { method: 'POST', headers: { Cookie: `uid=${BEN}` }, json: { code, name: 'Annas Mac', platform: 'darwin-arm64', versions: VERSIONS } });
    assert.equal(paired.status, 201, paired.text);
    const annaToken = paired.body.token;
    tokens.push(annaToken);
    assert.match(annaToken, /^ocra_[A-Za-z0-9_-]{43}$/);
    assert.equal(paired.body.agent.owner, ANNA, 'the code decides the owner, not a cookie');
    assert.equal((await api('/api/render-agent/pair', { method: 'POST', json: { code, name: 'Noch einmal', versions: VERSIONS } })).body.code, 'INVALID_CODE', 'once');
    // limits per IP address (behind the proxy: X-Real-IP)
    const benCode = (await api('/api/render-agents/pairing-code', { method: 'POST', as: BEN })).body.code;
    for (let i = 0; i < 10; i += 1) {
      const wrong = await api('/api/render-agent/pair', { method: 'POST', headers: { 'X-Real-IP': '203.0.113.9' }, json: { code: 'AAAA-AAAA', versions: VERSIONS } });
      assert.equal(wrong.status, 401);
    }
    const blocked = await api('/api/render-agent/pair', { method: 'POST', headers: { 'X-Real-IP': '203.0.113.9' }, json: { code: benCode, versions: VERSIONS } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // (the answer of a pairing is the one place of a token: not recorded with the others)
    const benPaired = await iso.request('/api/render-agent/pair', { method: 'POST', headers: { 'X-Real-IP': '203.0.113.10' }, json: { code: benCode, name: 'Bens PC', platform: 'win32-x64', versions: VERSIONS } });
    assert.equal(benPaired.status, 201);
    const benToken = benPaired.body.token;
    tokens.push(benToken);

    /* ---------- the work of a computer ---------- */
    const outdatedPoll = await api('/api/render-agent/poll', { method: 'POST', headers: bearer(annaToken), json: { versions: { ...VERSIONS, protocol: 0 } } });
    assert.equal(outdatedPoll.status, 426);
    assert.equal(outdatedPoll.body.code, 'AGENT_OUTDATED');
    const idle = await api('/api/render-agent/poll', { method: 'POST', headers: bearer(annaToken, { Cookie: `uid=${ADMIN}` }), json: { versions: VERSIONS, platform: 'darwin-arm64', running: [] } });
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body, { job: null, agent: { id: paired.body.agent.id, name: 'Annas Mac' } });
    await api('/api/render-agent/poll', { method: 'POST', headers: bearer(benToken), json: { versions: VERSIONS } });
    const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-agent-api-'));
    fs.writeFileSync(path.join(assetDir, 'clip.mp4'), Buffer.from('footage bytes'));
    const submitted = await rendernode.submit(HTML, 'draft', { files: [{ filename: 'upload-001.mp4', path: path.join(assetDir, 'clip.mp4'), size: 13 }], totalBytes: 13 }, 'landscape', 24, { owner: ANNA, label: 'Annas Film' });
    assert.equal(submitted.nodeId, 'render-queue');
    const benPoll = await api('/api/render-agent/poll', { method: 'POST', headers: bearer(benToken), json: { versions: VERSIONS } });
    assert.equal(benPoll.body.job, null, 'a foreign computer never gets the job');
    const annaPoll = await api('/api/render-agent/poll', { method: 'POST', headers: bearer(annaToken), json: { versions: VERSIONS } });
    const job = annaPoll.body.job;
    assert.equal(job.jobId, submitted.jobId);
    assert.equal(job.label, 'Annas Film');
    assert.deepEqual(job.assets, [{ filename: 'upload-001.mp4', size: 13 }]);
    const lease = { 'X-Render-Lease': job.lease };
    const asset = await iso.request(`/api/render-agent/jobs/${job.jobId}/assets/upload-001.mp4`, { headers: bearer(annaToken, lease), raw: true });
    assert.equal(asset.status, 200);
    assert.equal(Buffer.from(await asset.arrayBuffer()).toString(), 'footage bytes');
    assert.equal((await api(`/api/render-agent/jobs/${job.jobId}/assets/upload-001.mp4`, { headers: bearer(benToken, lease) })).status, 404, 'not with the lease of another computer');
    assert.equal((await api(`/api/render-agent/jobs/${job.jobId}/assets/upload-001.mp4`, { headers: bearer(annaToken, { 'X-Render-Lease': '0'.repeat(32) }) })).status, 409, 'its own job with an old lease: stop');
    assert.equal((await api(`/api/render-agent/jobs/${job.jobId}/assets/..%2Fjob.json`, { headers: bearer(annaToken, lease) })).status, 404);
    assert.equal((await api(`/api/render-agent/jobs/${job.jobId}/progress`, { method: 'POST', headers: bearer(annaToken, lease), json: { progress: 0.5 } })).status, 200);
    assert.equal((await api(`/api/render-agent/jobs/${job.jobId}/progress`, { method: 'POST', headers: bearer(benToken, lease), json: { progress: 0.5 } })).status, 404);
    const status = await api('/api/rendernode/status', { as: ANNA });
    assert.equal(status.body.ownComputer, true);
    assert.equal(status.body.online, true);
    const statusOther = await api('/api/rendernode/status', { as: 'carla@example.com' });
    assert.equal(statusOther.body.ownComputer, undefined, 'nobody renders for carla');
    // the result: type, content, then the real one
    const put = (token, body, type = 'application/octet-stream') => iso.request(`/api/render-agent/jobs/${job.jobId}/result`, { method: 'PUT', headers: bearer(token, { ...lease, 'Content-Type': type }), body });
    assert.equal((await put(annaToken, MP4, 'application/json')).status, 415);
    assert.equal((await put(annaToken, Buffer.from('<html>no video</html>'))).status, 422);
    assert.equal((await put(benToken, MP4)).status, 404);
    const done = await put(annaToken, MP4);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(await rendernode.download(submitted.jobId, submitted.nodeId), MP4);
    assert.equal((await rendernode.jobStatus(submitted.jobId, submitted.nodeId)).nodeName, 'Annas Mac');

    /* ---------- the people's routes ---------- */
    const mine = await api('/api/render-agents', { as: ANNA });
    assert.deepEqual(mine.body.agents.map((agent) => agent.name), ['Annas Mac']);
    assert.equal(mine.body.agents[0].completed, 1);
    assert.equal(mine.body.canShareAll, false);
    assert.equal(mine.body.canShareTeams, true);
    assert.equal(mine.body.server, 'https://creator.example.com');
    assert.equal(mine.body.packageAvailable, true);
    const annaId = paired.body.agent.id;
    const benId = benPaired.body.agent.id;
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ANNA, json: { name: 'Studio' } })).body.agent.name, 'Studio');
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ANNA, json: { shareTeams: true } })).body.agent.shareTeams, true);
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ANNA, json: { shareAll: true } })).status, 403, 'for everybody: admins only');
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: BEN, json: { name: 'Meins' } })).status, 404, 'somebody else\'s computer does not exist');
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'DELETE', as: BEN })).status, 404);
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ADMIN, json: { shareAll: true } })).status, 403, 'an admin shares only a computer of their own');
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ADMIN, json: { shareTeams: false } })).status, 403, 'what a computer renders is its owner\'s decision');
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'PATCH', as: ADMIN, json: { name: 'Admin' } })).status, 403);
    // the admin view: every computer with its owner, never a token
    const adminView = await api('/api/rendernodes', { as: ADMIN });
    assert.deepEqual(adminView.body.agents.map((agent) => [agent.name, agent.owner]).sort(), [['Bens PC', BEN], ['Studio', ANNA]]);
    for (const agent of adminView.body.agents) assert.ok(!('token' in agent) && !('tokenHash' in agent));
    // removal: the token stops working at once
    assert.equal((await api(`/api/render-agents/${annaId}`, { method: 'DELETE', as: ADMIN })).status, 200);
    assert.equal((await api('/api/render-agent/poll', { method: 'POST', headers: bearer(annaToken), json: { versions: VERSIONS } })).status, 401);
    assert.equal((await api(`/api/render-agents/${benId}`, { method: 'DELETE', as: BEN })).status, 200);
    assert.equal((await api('/api/render-agent/package', { headers: bearer(benToken) })).status, 401);

    /* ---------- render-node/ missing ---------- */
    iso.setEnv('RENDER_AGENT_PACKAGE_DIR', path.join(os.tmpdir(), 'ocd-no-such-folder'));
    const missing = await api('/api/render-agents/pairing-code', { method: 'POST', as: ANNA });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.code, 'PACKAGE_MISSING');
    assert.match(missing.body.error, /render-node\/|RENDER_AGENT_PACKAGE_DIR/);
    assert.equal((await api('/api/render-agent/install.sh')).status, 503);
    assert.equal((await api('/api/render-agents', { as: ANNA })).body.packageAvailable, false);
    iso.setEnv('RENDER_AGENT_PACKAGE_DIR', path.join(REPO, 'render-node'));

    /* ---------- the token nowhere else ---------- */
    const data = fs.readFileSync(path.join(iso.root, 'data', 'render-agents.json'), 'utf8');
    const queueFiles = fs.readdirSync(path.join(iso.root, 'data', 'render-queue')).map((id) => fs.readFileSync(path.join(iso.root, 'data', 'render-queue', id, 'job.json'), 'utf8')).join('\n');
    const output = `${logged.join('\n')}\n${responses.map((entry) => entry.text).join('\n')}\n${data}\n${queueFiles}`;
    for (const token of tokens) {
      assert.ok(!output.includes(token), 'a token shows up in a log line, an answer or a file');
      assert.ok(!output.includes(token.slice(5)), 'nor its random part');
    }
    assert.equal(fs.statSync(path.join(iso.root, 'data', 'render-agents.json')).mode & 0o777, 0o600);
  } finally {
    clearInterval(keepAlive);
    queue.stop();
    restoreLogs();
    await iso.cleanup();
  }
  console.log('Eigene Rechner (HTTP): Pfade ohne Anmeldung, Koppeln, Versionen, Limits, nur eigene Aufträge, Rollen, Entfernen und kein Token in Antworten, Logs oder Dateien sind korrekt.');
  console.log('test-render-agent-api.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
