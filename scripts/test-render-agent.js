'use strict';

// The render agent (render-node/agent.js, WP46) against a fake app over HTTP: pairing (token in agent.json with mode 600,
// https or loopback only, the version check), one job end to end (assets, the page with its Content-Security-Policy, the
// render function of service.js with the same arguments, progress, the result as a stream, the job folder deleted), the
// short output, the stop on 401 and on a version that is too old, reconnecting with backoff, a lease that is lost, a stop
// in the middle of a render (the job is handed back), a failed render, keeping the Mac awake, one agent per folder, the
// update with the token, and never the token in the output. No network beyond 127.0.0.1, no HyperFrames.

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const agentLib = require('../render-node/agent');
const { createRenderService } = require('../render-node/service');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = `ocra_${'k'.repeat(43)}`;
const VERSIONS = { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0', ffmpeg: '6.1.1', ffmpegSource: 'bundled' };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(500, 5)]);
const JOB_ID = 'rq-mv1abcde-0123abcd';
const LEASE = 'a'.repeat(32);
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><img src="clip.png"></body></html>';

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-agent-'));
  fs.mkdirSync(path.join(base, 'template'));
  fs.copyFileSync(path.join(ROOT, 'render-node', 'template', 'hyperframes.json'), path.join(base, 'template', 'hyperframes.json'));
  return base;
}

// A fake app: `script` decides the answer of every poll in turn; everything the agent sends is recorded.
async function fakeApp({ polls = [], progress = () => 200, pair = null } = {}) {
  const seen = { polls: [], progress: [], results: [], fails: [], assets: [], auth: new Set(), packages: 0 };
  let pollIndex = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    seen.auth.add(String(req.headers.authorization || ''));
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/render-agent/pair') {
      const data = JSON.parse(body.toString() || '{}');
      seen.pairBody = data;
      if (pair) return send(...pair(data));
      return send(201, { token: TOKEN, agent: { id: 'ra-0123456789ab', name: data.name, owner: 'anna@example.com' } });
    }
    if (url.pathname === '/api/render-agent/package') {
      seen.packages += 1;
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end('// setup.js of the test\n');
    }
    if (url.pathname === '/api/render-agent/poll') {
      seen.polls.push(JSON.parse(body.toString() || '{}'));
      const step = polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      const [status, value] = typeof step === 'function' ? step(seen) : step;
      return send(status, value);
    }
    const match = /^\/api\/render-agent\/jobs\/([^/]+)\/(assets\/(.+)|progress|result|fail)$/.exec(url.pathname);
    if (!match) return send(404, { error: 'unknown' });
    if (match[3]) {
      seen.assets.push({ job: match[1], file: decodeURIComponent(match[3]), lease: req.headers['x-render-lease'] });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(Buffer.from('PNGDATA'));
    }
    if (match[2] === 'progress') {
      const data = JSON.parse(body.toString() || '{}');
      seen.progress.push(data);
      const status = progress(data, seen);
      return send(status, status === 200 ? { ok: true } : { error: 'Der Auftrag gehört nicht mehr diesem Rechner.', code: 'LEASE_LOST' });
    }
    if (match[2] === 'result') {
      seen.results.push({ job: match[1], lease: req.headers['x-render-lease'], type: req.headers['content-type'], length: req.headers['content-length'], body });
      return send(200, { ok: true, bytes: body.length });
    }
    seen.fails.push(JSON.parse(body.toString() || '{}'));
    return send(200, { ok: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const JOB = (extra = {}) => ({ jobId: JOB_ID, lease: LEASE, html: PAGE, quality: 'draft', resolution: 'landscape', fps: 24, assets: [{ filename: 'clip.png', size: 7 }], label: 'Annas Film', own: true, backup: false, heartbeatMs: 2000, ...extra });

function agentFor(app, base, extra = {}) {
  const lines = [];
  const calls = [];
  const agent = agentLib.createAgent({
    base,
    lang: 'de',
    credentials: { server: app.url, token: TOKEN, name: 'Annas Mac' },
    versions: VERSIONS,
    noLock: true,
    log: (line) => lines.push(line),
    executor: async (args) => {
      calls.push({ ...args, page: fs.readFileSync(path.join(args.dir, 'project', 'index.html'), 'utf8'), files: fs.readdirSync(path.join(args.dir, 'project')).sort() });
      args.onOutput(Buffer.from('  ██████░░  26%  Capturing frame 1/60\n'));
      args.onOutput(Buffer.from('  ██████████  63%  Capturing frame 38/60\n'));
      if (extra.render) return extra.render(args);
      fs.writeFileSync(args.out, MP4);
      return undefined;
    },
    ...extra.options
  });
  return { agent, lines, calls };
}

async function testHelpers() {
  const csp = agentLib.CONTENT_SECURITY_POLICY;
  assert.match(csp, /connect-src 'self' data: blob:/, 'no fetch, XHR or WebSocket anywhere else');
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/connect-src[^;]*https?:/.test(csp));
  const withCharset = agentLib.withContentSecurityPolicy(PAGE);
  assert.ok(withCharset.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'), 'first in the head, right after the charset');
  assert.ok(agentLib.withContentSecurityPolicy('<html><head><script>x</script></head></html>').startsWith('<html><head><meta http-equiv="Content-Security-Policy"'));
  assert.ok(agentLib.withContentSecurityPolicy('<html><body>x</body></html>').startsWith('<html><head><meta http-equiv="Content-Security-Policy"'));
  assert.ok(agentLib.withContentSecurityPolicy('<div>x</div>').startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.equal(agentLib.progressFrom('  ███░  26%  Capturing frame 1/60  ███ 41% '), 0.41);
  assert.equal(agentLib.progressFrom('no number'), null);
  assert.deepEqual(agentLib.normaliseServer('https://app.example.com/sub/', {}), { server: 'https://app.example.com/sub' });
  assert.deepEqual(agentLib.normaliseServer('http://127.0.0.1:3111', {}), { server: 'http://127.0.0.1:3111' });
  assert.deepEqual(agentLib.normaliseServer('http://app.example.com', {}), { error: 'httpRefused' });
  assert.deepEqual(agentLib.normaliseServer('http://app.example.com', { RENDER_AGENT_ALLOW_HTTP: '1' }), { server: 'http://app.example.com' });
  assert.deepEqual(agentLib.normaliseServer('https://user:pw@app.example.com', {}), { error: 'serverInvalid' });
  assert.deepEqual(agentLib.normaliseServer('ftp://app.example.com', {}), { error: 'serverInvalid' });
  for (const lang of ['de', 'en', 'es']) {
    assert.deepEqual(Object.keys(agentLib.TEXTS[lang]).sort(), Object.keys(agentLib.TEXTS.de).sort(), `texts ${lang}`);
    assert.ok(!Object.values(agentLib.TEXTS[lang]).join(' ').includes('\u00df'));
  }
  assert.equal(agentLib.language({ LANG: 'de_CH.UTF-8' }), 'de');
  assert.equal(agentLib.language({ LANG: 'es_ES.UTF-8' }), 'es');
  assert.equal(agentLib.language({ LANG: 'fr_FR.UTF-8' }), 'en');
}

async function testPair() {
  const app = await fakeApp();
  const base = makeBase();
  const lines = [];
  try {
    assert.equal(await agentLib.pair({ server: 'http://app.example.com', code: 'ABCD-EFGH', base, versions: VERSIONS, lang: 'de', log: (line) => lines.push(line) }), 2, 'no plain http to another computer');
    assert.match(lines.pop(), /HTTPS/);
    assert.equal(await agentLib.pair({ server: `${app.url}/`, code: 'ABCD-EFGH', name: 'Annas Mac', base, versions: VERSIONS, lang: 'de', log: (line) => lines.push(line) }), 0);
    assert.equal(app.seen.pairBody.code, 'ABCD-EFGH');
    assert.equal(app.seen.pairBody.name, 'Annas Mac');
    assert.deepEqual(app.seen.pairBody.versions, VERSIONS);
    const file = path.join(base, 'agent.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.token, TOKEN);
    assert.equal(saved.server, app.url);
    assert.equal(agentLib.readCredentials(base).agentId, 'ra-0123456789ab');
    assert.match(lines.pop(), /Gekoppelt als «Annas Mac»/);
    assert.ok(!lines.join('\n').includes(TOKEN.slice(5)), 'the token is never printed');
  } finally {
    await app.close();
  }
  // the app wants another version: a clear message, exit code 3
  const old = await fakeApp({ pair: () => [426, { error: 'alt', code: 'AGENT_OUTDATED', required: { protocol: 1, hyperframes: '0.8.139' } }] });
  try {
    const out = [];
    assert.equal(await agentLib.pair({ server: old.url, code: 'ABCD-EFGH', base: makeBase(), versions: { ...VERSIONS, hyperframes: '0.8.1' }, lang: 'de', log: (line) => out.push(line) }), 3);
    assert.match(out.join('\n'), /HyperFrames 0\.8\.139.*node agent\.js update/);
  } finally {
    await old.close();
  }
}

async function testOneJob() {
  const base = makeBase();
  const app = await fakeApp({ polls: [[200, { job: null, agent: { name: 'Annas Mac' } }], [200, { job: JOB() }], [401, { error: 'weg', code: 'UNAUTHORIZED' }]] });
  const spawned = [];
  const fakeSpawn = (command, args) => {
    const child = { killed: false, on() {}, kill() { child.killed = true; } };
    spawned.push({ command, args, child });
    return child;
  };
  const { agent, lines, calls } = agentFor(app, base, { options: { spawnImpl: fakeSpawn } });
  try {
    const code = await agent.run();
    assert.equal(code, 2, '401: the computer was removed, the agent stops');
    // the job: assets, the page, the same render call as service.js
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.base, base);
    assert.equal(call.hyperframesBin, path.join(base, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'));
    assert.equal(call.dir, path.join(base, 'agent-jobs', JOB_ID));
    assert.equal(call.out, path.join(base, 'agent-jobs', JOB_ID, 'out.mp4'));
    assert.deepEqual([call.quality, call.fps, call.resolution], ['draft', 24, 'landscape']);
    assert.deepEqual(call.files, ['clip.png', 'compositions', 'hyperframes.json', 'index.html']);
    assert.equal(call.page, agentLib.withContentSecurityPolicy(PAGE));
    assert.deepEqual(app.seen.assets, [{ job: JOB_ID, file: 'clip.png', lease: LEASE }]);
    // the render node service calls the same function with the same arguments for the same job
    const serviceBase = makeBase();
    const serviceCalls = [];
    const service = createRenderService({ base: serviceBase, token: 't', renderExecutor: async (args) => { serviceCalls.push(args); fs.writeFileSync(args.out, MP4); } });
    const request = (method, url, payload) => new Promise((resolve, reject) => {
      const { Readable } = require('stream');
      const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
      Object.assign(req, { method, url, headers: { authorization: 'Bearer t', 'content-type': 'application/json' } });
      const res = { writeHead() {}, setHeader() {}, end: (value) => resolve(JSON.parse(String(value || '{}'))) };
      Promise.resolve(service.handle(req, res)).catch(reject);
    });
    await request('POST', '/render', { html: PAGE, quality: 'draft', resolution: 'landscape', fps: 24 });
    for (let i = 0; i < 50 && !serviceCalls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const viaService = serviceCalls[0];
    assert.deepEqual([viaService.quality, viaService.fps, viaService.resolution], [call.quality, call.fps, call.resolution]);
    assert.equal(path.relative(viaService.base, viaService.hyperframesBin), path.relative(call.base, call.hyperframesBin));
    assert.equal(path.basename(viaService.out), path.basename(call.out));
    // progress, the result as a stream, the folder is gone
    assert.ok(app.seen.progress.length >= 1);
    assert.ok(app.seen.progress.every((entry) => entry.lease === LEASE));
    assert.equal(app.seen.results.length, 1);
    assert.equal(app.seen.results[0].lease, LEASE);
    assert.equal(app.seen.results[0].type, 'application/octet-stream');
    assert.equal(Number(app.seen.results[0].length), MP4.length);
    assert.deepEqual(app.seen.results[0].body, MP4);
    assert.ok(!fs.existsSync(path.join(base, 'agent-jobs', JOB_ID)), 'the job folder is deleted');
    assert.deepEqual(app.seen.polls[0].running, []);
    assert.deepEqual(app.seen.polls[0].versions, VERSIONS);
    // the short output
    assert.match(lines.join('\n'), /Verbunden mit http:\/\/127\.0\.0\.1:\d+ als «Annas Mac»\.\nRendert «Annas Film» …\nFertig: «Annas Film» in \d+ s\.\nDieser Rechner wurde in der App entfernt\./);
    assert.ok(!lines.join('\n').includes(TOKEN.slice(5)));
    assert.deepEqual([...app.seen.auth].filter(Boolean), [`Bearer ${TOKEN}`], 'every request carries the token, and only it');
    // keeping a Mac awake while it renders
    if (process.platform === 'darwin') {
      assert.equal(spawned.length, 1);
      assert.deepEqual([spawned[0].command, spawned[0].args], ['caffeinate', ['-i']]);
      assert.equal(spawned[0].child.killed, true, 'caffeinate ends with the render');
    } else {
      assert.equal(spawned.length, 0);
    }
  } finally {
    await app.close();
  }
}

async function testStopsAndFailures() {
  // too old: a clear message and exit code 3
  const old = await fakeApp({ polls: [[426, { error: 'alt', code: 'AGENT_OUTDATED', required: { protocol: 1, hyperframes: '0.8.139' } }]] });
  try {
    const { agent, lines } = agentFor(old, makeBase());
    assert.equal(await agent.run(), 3);
    assert.match(lines.join('\n'), /node agent\.js update/);
  } finally {
    await old.close();
  }
  // a lost lease: the render is stopped, nothing is uploaded, nothing is reported as failed
  const lost = await fakeApp({ polls: [[200, { job: JOB() }], [401, {}]], progress: (data, seen) => (seen.progress.length > 1 ? 409 : 200) });
  try {
    let aborted = false;
    const { agent, lines } = agentFor(lost, makeBase(), {
      render: (args) => new Promise((resolve, reject) => {
        args.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })
    });
    assert.equal(await agent.run(), 2);
    assert.equal(aborted, true);
    assert.equal(lost.seen.results.length, 0);
    assert.equal(lost.seen.fails.length, 0);
    assert.match(lines.join('\n'), /nicht mehr bei diesem Rechner/);
  } finally {
    await lost.close();
  }
  // a failed render is reported with its message, and the agent goes on
  const failing = await fakeApp({ polls: [[200, { job: JOB({ assets: [] }) }], [401, {}]] });
  try {
    const { agent, lines } = agentFor(failing, makeBase(), { render: () => Promise.reject(new Error('Chrome ist abgestürzt')) });
    assert.equal(await agent.run(), 2);
    assert.equal(failing.seen.fails.length, 1);
    assert.equal(failing.seen.fails[0].lease, LEASE);
    assert.match(failing.seen.fails[0].error, /Chrome ist abgestürzt/);
    assert.equal(failing.seen.fails[0].released, undefined);
    assert.match(lines.join('\n'), /Fehlgeschlagen: Chrome ist abgestürzt/);
  } finally {
    await failing.close();
  }
  // Ctrl+C in the middle of a render: the job is handed back
  const stopping = await fakeApp({ polls: [[200, { job: JOB({ assets: [] }) }], [200, { job: null }]] });
  try {
    let started;
    const running = new Promise((resolve) => {
      started = resolve;
    });
    const { agent, lines } = agentFor(stopping, makeBase(), {
      render: (args) => new Promise((resolve, reject) => {
        started();
        args.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })
    });
    const done = agent.run();
    await running;
    agent.stop();
    assert.equal(await done, 0);
    assert.deepEqual(stopping.seen.fails, [{ lease: LEASE, released: true }]);
    assert.match(lines.join('\n'), /Wird beendet …\nLaufender Auftrag zurückgegeben\./);
  } finally {
    await stopping.close();
  }
}

async function testReconnect() {
  // nothing listens at first: the agent says so once, waits (backoff) and connects when the app is there
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = makeBase();
  const lines = [];
  const agent = agentLib.createAgent({ base, lang: 'de', credentials: { server: `http://127.0.0.1:${port}`, token: TOKEN }, versions: VERSIONS, noLock: true, log: (line) => lines.push(line), executor: async () => {} });
  const done = agent.run();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(lines.join('\n'), /Getrennt \(ECONNREFUSED\)\. Neuer Versuch in 1 s\./);
  let polls = 0;
  const app = http.createServer((req, res) => {
    req.resume();
    polls += 1;
    res.writeHead(polls === 1 ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(polls === 1 ? { job: null, agent: { name: 'Annas Mac' } } : { error: 'weg' }));
  });
  await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));
  try {
    assert.equal(await done, 2);
    assert.match(lines.join('\n'), /Verbunden mit http:\/\/127\.0\.0\.1:\d+ als «Annas Mac»/);
    assert.equal(lines.filter((line) => line.startsWith('Getrennt')).length, 1, 'the same problem is said once, not at every try');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

async function testLockAndUpdate() {
  const base = makeBase();
  // another agent runs in this folder (a living process): the second one refuses
  fs.writeFileSync(path.join(base, 'agent.lock'), String(process.ppid));
  const lines = [];
  const second = agentLib.createAgent({ base, lang: 'de', credentials: { server: 'http://127.0.0.1:9', token: TOKEN }, versions: VERSIONS, log: (line) => lines.push(line) });
  assert.equal(await second.run(), 1);
  assert.match(lines.join('\n'), /läuft in diesem Ordner schon/);
  assert.equal(agentLib.lockHolder(base), process.ppid);
  // the update with the token: not while an agent runs, then the package is fetched and setup.js runs in update mode
  const app = await fakeApp();
  try {
    agentLib.writeCredentials(base, { server: app.url, token: TOKEN, name: 'Annas Mac' });
    const out = [];
    const spawned = [];
    const spawnImpl = (command, args) => {
      spawned.push({ command, args });
      return { on: (event, handler) => event === 'close' && setImmediate(() => handler(0)) };
    };
    assert.equal(await agentLib.update({ base, lang: 'de', log: (line) => out.push(line), spawnImpl }), 1, 'not under a running agent');
    assert.equal(app.seen.packages, 0);
    fs.writeFileSync(path.join(base, 'agent.lock'), '999999999');
    assert.equal(agentLib.lockHolder(base), null, 'a lock of a process that is gone does not count');
    assert.equal(await agentLib.update({ base, lang: 'de', log: (line) => out.push(line), spawnImpl }), 0);
    assert.equal(app.seen.packages, 1);
    assert.ok(app.seen.auth.has(`Bearer ${TOKEN}`), 'the update needs no new code');
    assert.equal(fs.readFileSync(path.join(base, 'setup.js'), 'utf8'), '// setup.js of the test\n');
    assert.deepEqual(spawned[0].args, [path.join(base, 'setup.js'), '--update', '--dir', base]);
    assert.ok(!out.join('\n').includes(TOKEN.slice(5)));
  } finally {
    await app.close();
  }
}

async function main() {
  await testHelpers();
  await testPair();
  await testOneJob();
  await testStopsAndFailures();
  await testReconnect();
  await testLockAndUpdate();
  console.log('Render-Agent: Koppeln, ein Auftrag von Anfang bis Ende mit derselben Render-Funktion, Ausgabe, 401, alte Version, Wiederverbinden, verlorener Auftrag, Rückgabe, Fehler, Wachhalten, Sperre und Update sind korrekt.');
  console.log('test-render-agent.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
