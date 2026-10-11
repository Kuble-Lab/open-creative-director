'use strict';

// Render servers in the cloud (WP54, lib/cloud-render.js) against a fake Hetzner Cloud API on 127.0.0.1 (no call to Hetzner,
// nothing paid): a waiting job starts a server (the request: snapshot, type, place, labels, user_data with a fresh code and
// no token), the server pairs with the code of its user_data and renders the job, it is deleted when the paid hour is nearly
// over and nothing waits (not while it renders, except at the hard limit), its computer is removed with it (its token stops
// working); mode «reserve» waits 20 s while a computer is online, mode «first» does not; at most N servers; the monthly cap
// in the ledger; a server that does not pair; refusals of the API with a backoff and no loop (401, resource_unavailable);
// the reconcile (unknown servers and those of the hard limit deleted and booked, gone ones booked out, computers without a
// server removed); a restart (state, ledger and settings in files of mode 600; a server that had not paired is deleted);
// the token never in a log, a status or an error; with the cloud off everything is as before. A server is online from the
// first request of its computer, not from the pairing (one that paired and stays silent is deleted after the boot time, one
// that falls silent after offlineMs); the token stays while servers exist (except when Hetzner refuses it); the id of the
// installation survives a lost state.json, and servers of another id are shown, not deleted. A fake clock.

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

delete process.env.AUTH_WHOAMI_URL; // local mode: the jobs belong to 'lokal'

const { createRenderAgentsStore, SYSTEM_OWNER } = require('../lib/render-agents');
const { createRenderQueue } = require('../lib/render-queue');
const { defaultMayServe, createRenderNodeClient, QUEUE_NODE_ID } = require('../lib/rendernode');
const cloudLib = require('../lib/cloud-render');

const TOKEN = 'HzTestTokenAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLmnop';
const APP = 'https://creator.example.com';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="main" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="20"></div></body></html>';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
const VERSIONS = { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0' };
const MINUTE = 60 * 1000;

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

/* ---------- the fake Hetzner API ---------- */

async function fakeHetzner(clock) {
  const api = {
    servers: new Map(),
    requests: [],
    nextId: 1000,
    failCreate: null, // { status, code, message }
    failDelete: null, // { status, code, message }
    tokens: new Map([[TOKEN, 'p1']]), // token -> project (a server without one is in p1)
    available: true,
    echoToken: false,
    url: ''
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      api.requests.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization || '' });
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const project = api.tokens.get(bearer);
      const inProject = (item) => (item.project || 'p1') === project;
      if (!project) {
        // a careless API could repeat what it got: the manager must not pass it on
        return send(401, { error: { code: 'unauthorized', message: `unable to authenticate ${api.echoToken ? req.headers.authorization : ''}`.trim() } });
      }
      if (url.pathname === '/v1/datacenters') return send(410, { error: { code: 'gone', message: 'removed' } });
      if (req.method === 'GET' && url.pathname === '/v1/server_types') {
        return send(200, {
          server_types: [{
            id: 45,
            name: url.searchParams.get('name'),
            cores: 8,
            memory: 16,
            locations: [{ id: 2, name: 'nbg1', available: api.available }, { id: 1, name: 'fsn1', available: false }],
            prices: [{ location: 'nbg1', price_hourly: { net: '0.1300000000', gross: '0.1547000000' }, price_monthly: { net: '80', gross: '95.2' } }]
          }],
          meta: { pagination: { page: 1, next_page: null } }
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/servers') {
        if (api.failCreate) return send(api.failCreate.status, { error: { code: api.failCreate.code, message: api.failCreate.message } });
        const id = api.nextId++;
        const created = {
          id,
          name: body.name,
          status: 'initializing',
          created: new Date(clock.now).toISOString(),
          labels: body.labels,
          project,
          server_type: { name: body.server_type, prices: [{ location: body.location, price_hourly: { net: '0.1300000000', gross: '0.1547000000' } }] },
          datacenter: { name: `${body.location}-dc3`, location: { name: body.location } },
          user_data: body.user_data
        };
        api.servers.set(id, created);
        return send(201, { server: created, action: { id: 1, command: 'create_server', status: 'running' }, root_password: 'secret-root', next_actions: [] });
      }
      const match = /^\/v1\/servers\/(\d+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && match) {
        const id = Number(match[1]);
        if (api.failDelete) return send(api.failDelete.status, { error: { code: api.failDelete.code, message: api.failDelete.message } });
        if (!api.servers.has(id) || !inProject(api.servers.get(id))) return send(404, { error: { code: 'not_found', message: 'server not found' } });
        api.servers.delete(id);
        return send(200, { action: { id: 2, command: 'delete_server', status: 'running' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/servers') {
        const wanted = String(url.searchParams.get('label_selector') || '').split(',').filter(Boolean).map((pair) => pair.split('='));
        const list = [...api.servers.values()].filter((item) => inProject(item) && wanted.every(([key, value]) => item.labels?.[key] === value));
        return send(200, { servers: list, meta: { pagination: { page: 1, per_page: 50, next_page: null, total_entries: list.length } } });
      }
      return send(404, { error: { code: 'not_found', message: 'unknown path' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.url = `http://127.0.0.1:${server.address().port}/v1`;
  api.close = () => new Promise((resolve) => server.close(resolve));
  api.count = (method, prefix) => api.requests.filter((entry) => entry.method === method && entry.path.startsWith(prefix)).length;
  return api;
}

/* ---------- the parts of the app ---------- */

async function setup({ settings = {}, limits = {}, hetzner, clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-cloud-render-'));
  clock = clock || { now: Date.parse('2026-10-11T10:00:00Z') };
  const now = () => clock.now;
  const api = hetzner || (await fakeHetzner(clock));
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line), log: (line) => lines.push(line) };
  const agents = createRenderAgentsStore({ file: path.join(dir, 'render-agents.json'), now });
  let manager = null;
  const queue = createRenderQueue({ dir: path.join(dir, 'render-queue'), agents, mayServe: defaultMayServe, push: null, standby: () => manager.standby(), now, log: { warn() {} } });
  const make = () => cloudLib.createCloudRender({ dir: path.join(dir, 'cloud-render'), agents, queue, serverUrl: () => APP, apiBase: api.url, now, limits, log });
  manager = make();
  if (settings) manager.updateSettings({ enabled: true, token: TOKEN, snapshotId: '123456789', ...settings });
  return {
    dir,
    clock,
    api,
    agents,
    queue,
    lines,
    get manager() {
      return manager;
    },
    restart() {
      manager.stop();
      manager = make();
      return manager;
    }
  };
}

// The pairing code in the user_data of a created server, and the computer it pairs (as the first start of the server does).
function codeOf(created) {
  const match = /OCD_CODE='([A-Z0-9]{4}-[A-Z0-9]{4})'/.exec(created.user_data || '');
  assert.ok(match, created.user_data);
  return match[1];
}

function pairServer(env, created) {
  return env.agents.pair({ code: codeOf(created), ip: '203.0.113.9', name: /OCD_NAME='([^']+)'/.exec(created.user_data)[1], platform: 'linux-x64', versions: VERSIONS });
}

const poll = (queue, agent) => queue.poll(agent, { waitMs: 0 });
const enqueue = (queue, extra = {}) => queue.enqueue({ html: HTML, quality: 'draft', owner: 'lokal', label: 'Film', ...extra });

function lastServer(api) {
  return [...api.servers.values()].pop();
}

/* ---------- the tests ---------- */

async function testStartPairRenderDelete() {
  const env = await setup();
  const { api, queue, agents, clock } = env;
  try {
    assert.equal(env.manager.status().phase, 'ready');
    assert.equal(env.manager.routesAll(), true, 'switched on and complete: every job goes into the queue');
    // nothing waits: nothing starts
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 0);
    // a job and no worker at all: a server at once (also in mode «reserve»)
    const { jobId } = await enqueue(queue, { group: 'run-1:hud' });
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1);
    assert.equal(api.count('GET', '/v1/datacenters'), 0, 'GET /datacenters is gone at Hetzner');
    const post = api.requests.find((entry) => entry.method === 'POST');
    assert.equal(post.auth, `Bearer ${TOKEN}`);
    assert.equal(post.body.server_type, 'cpx42');
    assert.equal(post.body.location, 'nbg1');
    assert.equal(post.body.image, '123456789');
    assert.equal(post.body.start_after_create, true);
    assert.equal(post.body.labels['ocd-render'], 'cloud');
    assert.match(post.body.labels['ocd-instance'], /^[0-9a-f]{12}$/);
    assert.match(post.body.labels['ocd-server'], /^cr-[0-9a-f]{12}$/);
    assert.match(post.body.name, /^ocd-render-[0-9a-f]{12}$/);
    assert.ok(post.body.user_data.startsWith('#cloud-config\n'));
    assert.ok(post.body.user_data.includes(`OCD_SERVER='${APP}'`));
    assert.ok(!post.body.user_data.includes(TOKEN), 'the Hetzner token is not in user_data');
    assert.ok(!/ocra_/.test(post.body.user_data), 'no token of a computer in user_data, only a code');
    assert.equal(post.body.ssh_keys, undefined);
    // the server boots: the place in the queue says so
    const status = env.manager.status();
    assert.equal(status.phase, 'starting');
    assert.equal(status.servers.length, 1);
    assert.equal(status.servers[0].status, 'booting');
    assert.equal(status.month.spentEur, 0.15, 'the first hour is booked at once (0.1547 with VAT)');
    const standby = env.manager.standby();
    assert.deepEqual({ available: standby.available, starting: standby.starting }, { available: true, starting: 1 });
    assert.equal(standby.startingSeconds, 60);
    assert.deepEqual(queue.filmStatus({ group: 'run-1:hud' }), { phase: 'starting', position: 1, total: 1, etaSeconds: 60 });
    // a second tick does not start another one for the same job
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1);
    // the server pairs with the code of its user_data (50 s later): a computer of the system, for everybody, with its key
    clock.now += 50 * 1000;
    const created = lastServer(api);
    const { agent, token } = pairServer(env, created);
    assert.equal(agent.owner, SYSTEM_OWNER);
    assert.equal(agent.shareAll, true);
    assert.equal(agent.cloud, created.labels['ocd-server']);
    assert.throws(() => env.agents.pair({ code: codeOf(created), ip: '203.0.113.9', name: 'again', versions: VERSIONS }), /ungültig|abgelaufen/, 'the code works once');
    // paired is not online: the first start still installs (npm ci, the browser, ffmpeg) before its agent asks for work
    await env.manager.tick();
    assert.equal(env.manager.status().servers[0].status, 'booting');
    assert.equal(env.manager.status().phase, 'starting');
    assert.equal(env.manager.standby().starting, 1);
    assert.equal(env.manager.status().bootSeconds, 60);
    // its agent asks 30 s later: it takes the job (it renders for everybody), and the server is online from then on
    clock.now += 30 * 1000;
    const job = await poll(queue, agent);
    assert.equal(job.jobId, jobId);
    await env.manager.tick();
    assert.equal(env.manager.status().servers[0].status, 'online');
    assert.equal(env.manager.status().bootSeconds, 70, 'the start is measured to the first request (80 s), not to the pairing (50 s)');
    assert.equal(job.label, '', 'the server never sees the label of a person');
    queue.progress(agent, job.jobId, job.lease, { progress: 0.5 });
    assert.equal(queue.filmStatus({ group: 'run-1:hud' }).phase, 'rendering');
    // minute 55 while it renders: it stays
    clock.now = Date.parse(created.created) + 55 * MINUTE;
    queue.progress(agent, job.jobId, job.lease, { progress: 0.9 });
    await env.manager.tick();
    assert.equal(api.count('DELETE', '/v1/servers/'), 0, 'a server that renders is not deleted');
    await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
    assert.equal(queue.status(jobId).status, 'completed');
    // the next hour has begun (minute 61): idle, but only from minute 50 of the second hour
    clock.now = Date.parse(created.created) + 61 * MINUTE;
    await poll(queue, agent);
    await env.manager.tick();
    assert.equal(api.count('DELETE', '/v1/servers/'), 0, 'minute 1 of the second hour: kept');
    clock.now = Date.parse(created.created) + 111 * MINUTE;
    await poll(queue, agent);
    await env.manager.tick();
    assert.equal(api.count('DELETE', '/v1/servers/'), 1, 'minute 51 of the second hour, nothing to do: deleted');
    assert.equal(api.servers.size, 0);
    // the computer is gone with it: its token no longer works
    assert.equal(agents.getAgent(agent.id), null);
    assert.equal(agents.authenticate(token).ok, false);
    const after = env.manager.status();
    assert.equal(after.servers.length, 0);
    assert.equal(after.month.spentEur, 0.31, 'two hours begun, booked at the price of the API');
    const ledger = JSON.parse(fs.readFileSync(path.join(env.dir, 'cloud-render', 'ledger.json'), 'utf8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].priceHourlyEur, 0.1547);
    assert.ok(ledger.entries[0].endedAt);
    assert.ok(env.lines.some((line) => /gelöscht \(Stunde fast um, nichts zu tun\)/.test(line)), env.lines.join('\n'));
  } finally {
    await api.close();
  }
}

async function testIdleAtMinuteFifty() {
  const env = await setup();
  const { api, queue, clock } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    const created = lastServer(api);
    const { agent } = pairServer(env, created);
    const job = await poll(queue, agent);
    await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
    for (const minute of [5, 30, 49]) {
      clock.now = Date.parse(created.created) + minute * MINUTE;
      await poll(queue, agent);
      await env.manager.tick();
      assert.equal(api.servers.size, 1, `minute ${minute}: the hour is paid, it waits for work`);
    }
    // a job comes at minute 50: it is not deleted, it renders
    clock.now = Date.parse(created.created) + 50 * MINUTE;
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.servers.size, 1, 'something waits: kept');
    assert.equal(api.count('POST', '/v1/servers'), 1, 'and no second server: the idle one takes it');
    const second = await poll(queue, agent);
    await queue.acceptResult(agent, second.jobId, second.lease, Readable.from([MP4]));
    clock.now += 2 * MINUTE;
    await poll(queue, agent);
    await env.manager.tick();
    assert.equal(api.servers.size, 0, 'minute 52, idle: deleted');
  } finally {
    await api.close();
  }
}

async function testReserveAndFirst() {
  // «reserve»: an own computer is online and busy, a second job waits 20 s before a server starts
  const env = await setup();
  const { api, queue, agents, clock } = env;
  try {
    const { code } = agents.createPairingCode('lokal');
    const { agent: laptop } = agents.pair({ code, ip: '10.0.0.1', name: 'Laptop', versions: VERSIONS });
    await enqueue(queue);
    const busy = await poll(queue, laptop);
    assert.ok(busy, 'the laptop takes the first job');
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 0, 'a computer is online: wait');
    clock.now += 10 * 1000;
    queue.progress(laptop, busy.jobId, busy.lease, { progress: 0.3 });
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 0, '10 s: still waiting');
    clock.now += 11 * 1000;
    queue.progress(laptop, busy.jobId, busy.lease, { progress: 0.6 });
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1, '21 s: the reserve starts');
  } finally {
    await api.close();
  }
  // «first»: at once
  const first = await setup({ settings: { mode: 'first' } });
  try {
    const { code } = first.agents.createPairingCode('lokal');
    const { agent: laptop } = first.agents.pair({ code, ip: '10.0.0.1', name: 'Laptop', versions: VERSIONS });
    await enqueue(first.queue);
    await poll(first.queue, laptop);
    await enqueue(first.queue);
    await first.manager.tick();
    assert.equal(first.api.count('POST', '/v1/servers'), 1, 'mode «first»: at once');
  } finally {
    await first.api.close();
  }
}

async function testMaxServers() {
  const env = await setup({ settings: { maxServers: 2, mode: 'first' } });
  const { api, queue } = env;
  try {
    for (let i = 0; i < 4; i += 1) await enqueue(queue, { group: 'run-9:film' });
    await env.manager.tick();
    await env.manager.tick();
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 2, 'one per round, at most two');
    assert.equal(env.manager.status().servers.length, 2);
    // the film of four chunks is one place in the queue
    assert.equal(queue.filmStatus({ group: 'run-9:film' }).total, 1);
  } finally {
    await api.close();
  }
}

async function testMonthlyCap() {
  const env = await setup({ settings: { monthlyCapEur: 0.2 } });
  const { api, queue, clock } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1, '0 + 0.15 is within 0.20');
    // the server is deleted (did not pair in time does not matter here: removed by hand); that switches the cloud off,
    // else the waiting job would start a new server (and a new paid hour) in the next round
    await env.manager.deleteAll();
    assert.equal(api.servers.size, 0);
    assert.equal(env.manager.status().settings.enabled, false, '«Server jetzt löschen» switches the cloud off');
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1, 'off: nothing starts');
    env.manager.updateSettings({ enabled: true });
    clock.now += 5 * MINUTE;
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1, '0.15 + 0.15 would go over 0.20: nothing starts');
    const offers = api.count('GET', '/v1/server_types');
    await env.manager.tick();
    await env.manager.tick();
    assert.equal(api.count('GET', '/v1/server_types'), offers, 'with the cap reached no round asks Hetzner for the price again');
    const status = env.manager.status();
    assert.equal(status.phase, 'cap_reached');
    assert.equal(status.lastError.code, 'cap_reached');
    assert.match(status.lastError.message, /Monatsdeckel von 0.2 € erreicht/);
    assert.equal(env.lines.filter((line) => /Monatsdeckel/.test(line)).length, 1, 'the log says it once');
    // the queue knows: no worker comes, the job fails after the orphan time with the reason
    assert.equal(env.manager.standby().available, false);
    assert.match(env.manager.standby().reason, /Monatsdeckel/);
    clock.now += 11 * MINUTE;
    await queue.sweep();
    await queue.sweep();
    const failed = queue.snapshot().find((job) => job.status === 'failed');
    assert.ok(failed, 'orphaned');
    assert.match(failed.error, /Monatsdeckel erreicht/);
    // a new month: the cap starts again
    clock.now = Date.parse('2026-11-01T08:00:00Z');
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 2, 'November: a server again');
  } finally {
    await api.close();
  }
}

async function testHardLimit() {
  const env = await setup({ limits: { hardLimitMs: 3 * 60 * MINUTE } });
  const { api, queue, agents, clock } = env;
  try {
    const { jobId } = await enqueue(queue);
    await env.manager.tick();
    const created = lastServer(api);
    const { agent } = pairServer(env, created);
    const job = await poll(queue, agent);
    // it renders for ever (a stuck job that still reports): at 3 h it is deleted anyway, the job goes back into the queue
    for (const minutes of [59, 119, 179]) {
      clock.now = Date.parse(created.created) + minutes * MINUTE;
      queue.progress(agent, job.jobId, job.lease, { progress: 0.5 });
      await env.manager.tick();
    }
    assert.equal(api.servers.size, 1, 'rendering: kept until the hard limit');
    clock.now = Date.parse(created.created) + 180 * MINUTE;
    queue.progress(agent, job.jobId, job.lease, { progress: 0.5 });
    await env.manager.tick();
    assert.equal(api.servers.size, 0, 'the hard limit');
    assert.equal(agents.getAgent(agent.id), null);
    assert.equal(queue.status(jobId).status, 'pending', 'the job is back in the queue');
    assert.ok(env.lines.some((line) => /harte Grenze/.test(line)));
  } finally {
    await api.close();
  }
}

async function testBootTimeoutAndPause() {
  const env = await setup({ limits: { backoffMs: [1000] } });
  const { api, queue, clock } = env;
  try {
    await enqueue(queue);
    for (let round = 1; round <= 3; round += 1) {
      await env.manager.tick();
      assert.equal(api.count('POST', '/v1/servers'), round, `start ${round}`);
      // it never pairs (the queue looks every few seconds: a server that boots is a worker that comes)
      clock.now += 15 * MINUTE;
      await queue.sweep();
      await env.manager.tick();
      assert.equal(api.servers.size, 0, `deleted after 15 minutes without pairing (${round})`);
      assert.equal(env.manager.status().lastError.code, 'boot_timeout');
      clock.now += 2000;
      await queue.sweep();
    }
    // three in a row: paused, no fourth start, until the settings are saved again
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 3);
    assert.equal(env.manager.status().phase, 'paused');
    env.manager.updateSettings({ snapshotId: '987654321' });
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 4, 'saved again: it tries');
    assert.equal(api.requests.filter((entry) => entry.method === 'POST').pop().body.image, '987654321');
  } finally {
    await api.close();
  }
}

async function testRefusalsAndBackoff() {
  const env = await setup();
  const { api, queue, clock } = env;
  try {
    api.failCreate = { status: 412, code: 'resource_unavailable', message: 'error during placement' };
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 1);
    let status = env.manager.status();
    assert.equal(status.phase, 'backoff');
    assert.equal(status.lastError.code, 'resource_unavailable');
    assert.match(status.lastError.message, /error during placement/);
    assert.equal(status.servers.length, 0, 'nothing is kept of a refused start');
    // no loop: the rounds within the backoff send nothing
    for (let i = 0; i < 5; i += 1) {
      clock.now += 5000;
      await env.manager.tick();
    }
    assert.equal(api.count('POST', '/v1/servers'), 1, 'within the first minute no second try');
    clock.now += 40 * 1000;
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 2, 'after the minute: one more');
    // the backoff grows: 2 minutes now
    clock.now += 61 * 1000;
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 2);
    clock.now += 60 * 1000;
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 3);
    // the type is not available at the place: no POST at all
    api.failCreate = null;
    api.available = false;
    clock.now += 10 * MINUTE;
    const before = api.count('POST', '/v1/servers');
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), before);
    assert.equal(env.manager.status().lastError.code, 'resource_unavailable');
    assert.match(env.manager.status().lastError.message, /cpx42 in nbg1/);
    // 401: a clear status, the longest backoff, and the token nowhere (even when the API repeats it)
    api.available = true;
    api.echoToken = true;
    env.manager.updateSettings({ token: 'WrongTokenAbcdefghijklmnopqrstuvwxyz0123456789' });
    await env.manager.tick();
    status = env.manager.status();
    assert.equal(status.phase, 'unauthorized');
    assert.equal(status.lastError.code, 'unauthorized');
    assert.ok(!status.lastError.message.includes('WrongToken'), status.lastError.message);
    assert.ok(Date.parse(status.backoffUntil) - clock.now >= 29 * MINUTE, 'the longest wait');
    // a valid token again: at once
    env.manager.updateSettings({ token: TOKEN });
    assert.equal(env.manager.status().phase, 'ready');
    await env.manager.tick();
    assert.equal(lastServer(api).labels['ocd-render'], 'cloud');
    for (const text of [JSON.stringify(env.manager.status()), env.lines.join('\n')]) {
      assert.ok(!text.includes(TOKEN), 'the token is never in a status or a log');
      assert.ok(!text.includes('WrongToken'));
      assert.ok(!text.includes('secret-root'), 'nor the root password of the answer');
    }
  } finally {
    await api.close();
  }
}

async function testReconcile() {
  const env = await setup();
  const { api, queue, agents, clock } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    const ours = lastServer(api);
    const { agent } = pairServer(env, ours);
    await env.manager.tick();
    const instance = ours.labels['ocd-instance'];
    // a server with our labels that the manager does not know, and one of another installation
    clock.now += 10 * MINUTE;
    api.servers.set(5001, { id: 5001, name: 'ocd-render-stray', created: new Date(clock.now - 30 * MINUTE).toISOString(), labels: { 'ocd-render': 'cloud', 'ocd-instance': instance, 'ocd-server': 'cr-0000000000aa' }, server_type: { name: 'cpx42', prices: [{ location: 'nbg1', price_hourly: { gross: '0.1547' } }] }, datacenter: { location: { name: 'nbg1' } } });
    api.servers.set(5002, { id: 5002, name: 'other-app', created: new Date(clock.now).toISOString(), labels: { 'ocd-render': 'cloud', 'ocd-instance': 'ffffffffffff' }, server_type: { name: 'cpx42' } });
    // a computer of a server that does not exist
    const { code } = agents.createSystemPairingCode('cr-0000000000bb');
    const { agent: orphan } = agents.pair({ code, ip: '203.0.113.10', name: 'old', versions: VERSIONS });
    await env.manager.reconcile();
    assert.ok(!api.servers.has(5001), 'the unknown server of this installation is deleted');
    assert.ok(api.servers.has(5002), 'a server of another installation is not touched');
    assert.deepEqual(env.manager.status().foreign.map((item) => [item.name, item.serverId, item.instance]), [['other-app', 5002, 'ffffffffffff']], 'but shown');
    assert.ok(api.servers.has(ours.id), 'ours stays');
    assert.equal(agents.getAgent(orphan.id), null, 'a computer without a server is removed');
    assert.ok(agents.getAgent(agent.id));
    const ledger = JSON.parse(fs.readFileSync(path.join(env.dir, 'cloud-render', 'ledger.json'), 'utf8'));
    assert.ok(ledger.entries.some((entry) => entry.serverId === 5001 && entry.endedAt), 'the stray server is booked');
    assert.ok(api.requests.every((entry) => entry.method !== 'GET' || entry.path !== '/v1/servers' || entry.query.startsWith('?label_selector=ocd-render%3Dcloud&')), 'listed by the label of the render servers');
    // ours is deleted at Hetzner by somebody else: booked out, its computer removed
    api.servers.delete(ours.id);
    await env.manager.reconcile();
    assert.equal(env.manager.status().servers.length, 0);
    assert.equal(agents.getAgent(agent.id), null);
    // over the hard limit: the reconcile deletes it as well
    await enqueue(queue);
    await env.manager.tick();
    const late = lastServer(api);
    pairServer(env, late);
    clock.now += 3 * 60 * MINUTE;
    await env.manager.reconcile();
    assert.ok(!api.servers.has(late.id));
  } finally {
    await api.close();
  }
}

async function testRestart() {
  const env = await setup();
  const { api, queue, clock } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    const paired = lastServer(api);
    pairServer(env, paired);
    await env.manager.tick();
    await enqueue(queue);
    env.manager.updateSettings({ maxServers: 2, mode: 'first' });
    await env.manager.tick();
    assert.equal(api.servers.size, 2);
    const booting = lastServer(api);
    // files of mode 600; the settings hold the token, the state and the ledger do not
    for (const name of ['settings.json', 'state.json', 'ledger.json']) {
      const file = path.join(env.dir, 'cloud-render', name);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
      assert.equal(fs.readFileSync(file, 'utf8').includes(TOKEN), name === 'settings.json', name);
    }
    assert.equal(fs.statSync(path.join(env.dir, 'cloud-render')).mode & 0o777, 0o700);
    // a restart: the servers are known again; the one that had not paired lost its code with the restart and is deleted
    const manager = env.restart();
    assert.equal(manager.status().servers.length, 2);
    assert.equal(manager.status().settings.tokenSet, true);
    assert.equal(manager.status().settings.token, undefined);
    clock.now += 30 * 1000;
    await manager.tick();
    assert.ok(api.servers.has(paired.id), 'the paired one renders on');
    assert.ok(!api.servers.has(booting.id), 'the one without its code is deleted');
    assert.ok(env.lines.some((line) => /Kopplungscode nach Neustart verloren/.test(line)));
    // the same instance id after the restart (the labels of its servers)
    await manager.reconcile();
    assert.ok(api.servers.has(paired.id), 'still known after the restart');
  } finally {
    await api.close();
  }
}

async function testPairedButSilent() {
  // The first start pairs before it installs. A server whose computer paired but never asks for work (npm ci, the browser
  // or ffmpeg failed after the pairing) is not online: it counts as starting, no second server comes for the same film, and
  // it is deleted after the boot time like one that never paired; three in a row pause the starts.
  const env = await setup({ settings: { maxServers: 2, mode: 'first' }, limits: { backoffMs: [1000] } });
  const { api, queue, clock } = env;
  try {
    await enqueue(queue, { group: 'run-2:hud' });
    for (let round = 1; round <= 3; round += 1) {
      await env.manager.tick();
      assert.equal(api.count('POST', '/v1/servers'), round, `start ${round}`);
      const created = lastServer(api);
      const start = Date.parse(created.created);
      clock.now = start + 60 * 1000;
      pairServer(env, created);
      for (let minute = 1; minute < 15; minute += 1) {
        clock.now = start + minute * MINUTE;
        await queue.sweep();
        await env.manager.tick();
        assert.equal(api.count('POST', '/v1/servers'), round, `minute ${minute}: no second server for one film`);
        assert.equal(env.manager.status().servers[0].status, 'booting');
        assert.equal(env.manager.standby().starting, 1);
      }
      assert.equal(queue.filmStatus({ group: 'run-2:hud' }).phase, 'starting');
      clock.now = start + 15 * MINUTE;
      await queue.sweep();
      await env.manager.tick();
      assert.equal(api.servers.size, 0, `paired and silent: deleted after 15 minutes (${round})`);
      const status = env.manager.status();
      assert.equal(status.lastError.code, 'boot_timeout');
      assert.match(status.lastError.message, /gekoppelt, sein Agent fragt aber nicht ab/);
      assert.equal(status.bootSeconds, 60, 'a server that never asked teaches nothing about the start time');
      assert.equal(env.agents.listAgents().length, 0, 'its computer is removed with it');
      clock.now += 2000;
      await queue.sweep();
    }
    await env.manager.tick();
    assert.equal(api.count('POST', '/v1/servers'), 3, 'three in a row: paused');
    assert.equal(env.manager.status().phase, 'paused');
    assert.ok(env.lines.some((line) => /gekoppelt, fragt aber nicht ab/.test(line)), env.lines.join('\n'));
  } finally {
    await api.close();
  }
}

async function testSilentAfterOnline() {
  // Online once, then its agent stops asking (it stopped for another version, or crashed) while a film waits: it renders
  // nothing, so it is deleted after offlineMs and not kept until the hard limit; a new server starts for the film.
  const env = await setup();
  const { api, queue, clock } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    const created = lastServer(api);
    const { agent } = pairServer(env, created);
    const job = await poll(queue, agent);
    await env.manager.tick();
    assert.equal(env.manager.status().servers[0].status, 'online');
    await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
    await enqueue(queue);
    for (const minutes of [1, 5, 10]) {
      clock.now = Date.parse(created.created) + minutes * MINUTE - 1000;
      await env.manager.tick();
      assert.equal(api.count('DELETE', '/v1/servers/'), 0, `${minutes} min without a request: kept`);
    }
    clock.now = Date.parse(created.created) + 10 * MINUTE;
    await env.manager.tick();
    assert.equal(api.count('DELETE', '/v1/servers/'), 1, '10 minutes without a request: deleted');
    assert.ok(env.lines.some((line) => /Rechner meldet sich nicht mehr/.test(line)), env.lines.join('\n'));
    assert.equal(api.count('POST', '/v1/servers'), 2, 'and a new server for the waiting film');
    // a restart of the app forgets when a computer last asked: the first look counts, nothing is deleted at once
    const fresh = lastServer(api);
    const { agent: second } = pairServer(env, fresh);
    await poll(queue, second);
    await env.manager.tick();
    const manager = env.restart();
    clock.now += 20 * MINUTE;
    await manager.tick();
    assert.ok(api.servers.has(fresh.id), 'after a restart: a grace of offlineMs');
    clock.now += 10 * MINUTE;
    await manager.tick();
    assert.ok(!api.servers.has(fresh.id), 'still silent: deleted');
  } finally {
    await api.close();
  }
}

// The agent of a server starts only after a successful first start (the pairing comes before npm ci, so a failed first
// start leaves an agent.json behind).
function testCloudImageUnits() {
  const file = path.resolve(__dirname, '..', 'render-node', 'cloud-image.sh');
  const source = fs.readFileSync(file, 'utf8');
  const unit = (name) => {
    const match = new RegExp(`cat > /etc/systemd/system/${name.replace(/\./g, '\\.')} <<UNIT\n([\\s\\S]*?)\nUNIT\n`).exec(source);
    assert.ok(match, name);
    return match[1];
  };
  const agent = unit('ocd-render-agent.service');
  const pair = unit('ocd-render-pair.service');
  assert.match(agent, /^Requires=ocd-render-pair\.service$/m, 'no agent after a failed first start');
  assert.match(agent, /^After=.*\bocd-render-pair\.service\b/m);
  assert.match(pair, /^RemainAfterExit=yes$/m, 'the pairing stays active, so the agent is never stopped with it');
  assert.match(pair, /^ConditionPathExists=!/m);
  const check = require('child_process').spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
}

async function testTokenGuard() {
  const OTHER = 'OtherTokenAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  const THIRD = 'ThirdTokenAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  const env = await setup();
  const { api, queue, clock } = env;
  const settingsFile = path.join(env.dir, 'cloud-render', 'settings.json');
  const refused = (patch) => assert.throws(
    () => env.manager.updateSettings(patch),
    (err) => err instanceof cloudLib.CloudRenderError && err.status === 409 && err.code === 'SERVERS_RUNNING' && /Server jetzt löschen/.test(err.message) && !err.message.includes('Token' + 'Abc'),
    JSON.stringify(Object.keys(patch))
  );
  try {
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.servers.size, 1);
    // while a server exists the token can be neither removed nor changed: only it can delete the server
    refused({ token: '' });
    refused({ token: OTHER, monthlyCapEur: 50 });
    assert.ok(fs.readFileSync(settingsFile, 'utf8').includes(TOKEN), 'the stored token is unchanged');
    assert.equal(env.manager.status().settings.monthlyCapEur, 30, 'nothing of a refused change is saved');
    env.manager.updateSettings({ token: TOKEN, monthlyCapEur: 40 });
    assert.equal(env.manager.status().settings.monthlyCapEur, 40, 'the same token with other fields is fine');
    // switched off while its DELETE fails: «stopping», not «off», as long as it runs
    api.failDelete = { status: 503, code: 'unavailable', message: 'maintenance' };
    env.manager.updateSettings({ enabled: false });
    await env.manager.tick();
    assert.equal(api.servers.size, 1);
    assert.equal(env.manager.status().servers[0].status, 'deleting');
    assert.equal(env.manager.status().phase, 'stopping');
    refused({ token: '' });
    api.failDelete = null;
    clock.now += 31 * 1000;
    await env.manager.tick();
    assert.equal(api.servers.size, 0);
    assert.equal(env.manager.status().phase, 'off');
    // no server: it can be removed and set again
    env.manager.updateSettings({ token: '' });
    assert.equal(env.manager.status().settings.tokenSet, false);
    env.manager.updateSettings({ token: TOKEN, enabled: true });

    // Hetzner refuses the token (deleted in the console) while a server runs: a new one may replace it, the empty one not
    await env.manager.tick();
    const kept = lastServer(api);
    api.tokens = new Map([[OTHER, 'p1']]);
    refused({ token: THIRD });
    await env.manager.reconcile();
    assert.equal(env.manager.status().lastError.code, 'unauthorized');
    refused({ token: '' });
    env.manager.updateSettings({ token: OTHER });
    // a token of the same project sees the server: nothing to report, and it can delete it
    await env.manager.reconcile();
    assert.equal(env.manager.status().servers.length, 1);
    assert.notEqual(env.manager.status().lastError?.code, 'server_not_visible');
    await env.manager.deleteAll();
    assert.ok(!api.servers.has(kept.id), 'deleted with the new token');

    // a token of another project does not see it: the server is booked out with a clear notice, not dropped silently
    // (switched on again: «Server jetzt löschen» switched the cloud off)
    env.manager.updateSettings({ enabled: true });
    await env.manager.tick();
    const lost = lastServer(api);
    api.tokens = new Map([[THIRD, 'p2']]);
    await env.manager.reconcile();
    env.manager.updateSettings({ token: THIRD });
    await env.manager.reconcile();
    const status = env.manager.status();
    assert.equal(status.servers.length, 0);
    assert.equal(status.lastError.code, 'server_not_visible');
    assert.ok(status.lastError.message.includes(lost.name), status.lastError.message);
    assert.match(status.lastError.message, /anderen Hetzner-Projekt/);
    assert.ok(api.servers.has(lost.id), 'it still runs in the old project: that is what the notice is for');
    for (const text of [JSON.stringify(status), env.lines.join('\n'), fs.readFileSync(path.join(env.dir, 'cloud-render', 'state.json'), 'utf8')]) {
      for (const token of [TOKEN, OTHER, THIRD]) assert.ok(!text.includes(token));
    }
  } finally {
    await api.close();
  }
}

async function testInstanceId() {
  const env = await setup();
  const { api, queue } = env;
  const dir = path.join(env.dir, 'cloud-render');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  try {
    await enqueue(queue);
    await env.manager.tick();
    const first = lastServer(api);
    const id = first.labels['ocd-instance'];
    assert.equal(read('instance.json').instanceId, id);
    assert.equal(fs.statSync(path.join(dir, 'instance.json')).mode & 0o777, 0o600);
    assert.equal(read('ledger.json').entries[0].instanceId, id, 'every entry of the ledger carries the id');
    // state.json lost (a move, a reset): the id comes from instance.json, and the reconcile finds the server as one of this
    // installation that it does not know: deleted and booked, not left running
    fs.rmSync(path.join(dir, 'state.json'));
    let manager = env.restart();
    await manager.reconcile();
    assert.ok(!api.servers.has(first.id), 'the server of the lost state is deleted');
    assert.equal(read('state.json').instanceId, id);
    assert.ok(read('ledger.json').entries.find((entry) => entry.serverId === first.id).endedAt, 'and booked out');
    // state.json and instance.json lost: the open entry of the ledger knows the id
    await manager.tick();
    const second = lastServer(api);
    assert.equal(second.labels['ocd-instance'], id, 'the same id after the restart');
    fs.rmSync(path.join(dir, 'state.json'));
    fs.rmSync(path.join(dir, 'instance.json'));
    manager = env.restart();
    await manager.reconcile();
    assert.ok(!api.servers.has(second.id), 'found by the id of the ledger and deleted');
    assert.equal(read('instance.json').instanceId, id);
    assert.ok(env.lines.some((line) => /aus dem Kassenbuch/.test(line)), env.lines.join('\n'));
    // everything lost: a new id; the server of the old one is not deleted (it could belong to another installation) but shown
    await manager.tick();
    const third = lastServer(api);
    for (const name of ['state.json', 'instance.json', 'ledger.json']) fs.rmSync(path.join(dir, name));
    manager = env.restart();
    await manager.reconcile();
    assert.notEqual(read('instance.json').instanceId, id);
    assert.ok(api.servers.has(third.id), 'not deleted');
    const foreign = manager.status().foreign;
    assert.deepEqual(foreign.map((item) => [item.name, item.serverId, item.instance]), [[third.name, third.id, id]]);
    assert.ok(foreign[0].ageSeconds >= 0);
  } finally {
    await api.close();
  }
}

async function testSwitchedOff() {
  const env = await setup();
  const { api, queue, agents } = env;
  try {
    await enqueue(queue);
    await env.manager.tick();
    const created = lastServer(api);
    const { agent } = pairServer(env, created);
    const job = await poll(queue, agent);
    env.manager.updateSettings({ enabled: false });
    assert.equal(env.manager.routesAll(), false);
    assert.equal(env.manager.standby(), null);
    assert.equal(env.manager.status().phase, 'stopping');
    await env.manager.tick();
    assert.equal(api.servers.size, 1, 'switched off, but it renders: it finishes');
    await queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));
    await env.manager.tick();
    assert.equal(api.servers.size, 0, 'switched off and idle: deleted at once');
    assert.equal(agents.getAgent(agent.id), null);
    assert.equal(env.manager.status().phase, 'off');
    // off: no request to Hetzner at all
    const count = api.requests.length;
    await enqueue(queue);
    await env.manager.tick();
    assert.equal(api.requests.length, count);
  } finally {
    await api.close();
  }
}

async function testSettings() {
  const env = await setup({ settings: null });
  try {
    const manager = env.manager;
    assert.deepEqual(manager.status().settings, { enabled: false, serverType: 'cpx42', location: 'nbg1', snapshotId: '', sshKey: '', mode: 'reserve', maxServers: 1, monthlyCapEur: 30, tokenSet: false });
    assert.equal(manager.status().phase, 'off');
    manager.updateSettings({ enabled: true });
    assert.equal(manager.status().phase, 'not_configured');
    assert.deepEqual(manager.status().problems, ['token', 'snapshot']);
    assert.equal(manager.routesAll(), false, 'incomplete: the jobs go the way of before');
    for (const [patch, pattern] of [
      [{ token: 'short' }, /Form/],
      [{ token: 'has spaces in it and is long enough' }, /Form/],
      [{ snapshotId: 'ubuntu-24.04' }, /Zahl/],
      [{ serverType: 'CPX 42' }, /Servertyp/],
      [{ mode: 'always' }, /reserve oder first/],
      [{ maxServers: 0 }, /1 bis 10/],
      [{ maxServers: 1.5 }, /1 bis 10/],
      [{ monthlyCapEur: -1 }, /0 bis 10000/],
      [{ enabled: 'yes' }, /true oder false/],
      ['nope', /Objekt/]
    ]) {
      assert.throws(() => manager.updateSettings(patch), (err) => err instanceof cloudLib.CloudRenderError && err.status === 400 && pattern.test(err.message) && !err.message.includes('has spaces'), JSON.stringify(patch));
    }
    const status = manager.updateSettings({ token: ` ${TOKEN} `, snapshotId: 123456789, maxServers: '3', monthlyCapEur: '12.5', sshKey: 'ops key' });
    assert.equal(status.settings.tokenSet, true);
    assert.equal(status.settings.snapshotId, '123456789');
    assert.equal(status.settings.maxServers, 3);
    assert.equal(status.settings.monthlyCapEur, 12.5);
    assert.equal(status.phase, 'ready');
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    // an empty token removes it; leaving it out keeps it
    manager.updateSettings({ mode: 'first' });
    assert.equal(manager.status().settings.tokenSet, true);
    manager.updateSettings({ token: '' });
    assert.equal(manager.status().settings.tokenSet, false);
    // the SSH key goes into the request
    manager.updateSettings({ token: TOKEN });
    await enqueue(env.queue);
    await manager.tick();
    assert.deepEqual(env.api.requests.find((entry) => entry.method === 'POST').body.ssh_keys, ['ops key']);
    // without the public address of the app nothing can pair: not ready
    const other = cloudLib.createCloudRender({ dir: path.join(env.dir, 'cloud-render'), agents: env.agents, queue: env.queue, serverUrl: () => '', apiBase: env.api.url, now: () => env.clock.now, log: { warn() {}, info() {} } });
    assert.deepEqual(other.status().problems, ['publicUrl']);
    assert.equal(other.ready(), false);
    // user_data: only plain values
    assert.throws(() => cloudLib.cloudInit({ server: "https://x.example/'; rm -rf /", code: 'ABCD-EFGH', name: 'cloud-1' }), /user_data/);
    assert.throws(() => cloudLib.cloudInit({ server: 'https://x.example', code: 'ABCD-EFGH', name: 'a b' }), /user_data/);
  } finally {
    await env.api.close();
  }
}

// With the cloud off (or incomplete) lib/rendernode.js sends a job exactly as before; switched on, every job goes into the queue.
async function testRouting() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method });
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, running: false, queue: 0, streamingUploads: true }), { status: 200 });
    return new Response(JSON.stringify({ jobId: 'push-1' }), { status: 200 });
  };
  const store = { listNodes: () => [{ id: 'node-a', name: 'Mac mini', url: 'http://127.0.0.1:9', token: 't', enabled: true }] };
  const enqueued = [];
  const queue = { acceptsOwner: () => false, enqueue: async (job) => (enqueued.push(job), { jobId: 'rq-abc123-0000aaaa', nodeId: QUEUE_NODE_ID }) };
  let cloud = { routesAll: () => false, ready: () => false };
  const client = createRenderNodeClient({ store, env: {}, fetchImpl, queue, cloud: () => cloud });
  const before = await client.submit(HTML, 'draft', undefined, 'landscape', 24, { owner: 'lokal', label: 'Film', group: 'run-1:n1' });
  assert.deepEqual(before, { jobId: 'push-1', nodeId: 'node-a' }, 'off: straight to the render node');
  assert.equal(enqueued.length, 0);
  cloud = { routesAll: () => true, ready: () => true };
  const after = await client.submit(HTML, 'draft', undefined, 'landscape', 24, { owner: 'lokal', label: 'Film', group: 'run-1:n1' });
  assert.equal(after.nodeId, QUEUE_NODE_ID, 'on: into the queue, so the place is right for everybody');
  assert.equal(enqueued[0].group, 'run-1:n1');
  // the render tools are offered with the cloud alone
  const bare = createRenderNodeClient({ store: { listNodes: () => [] }, env: {}, fetchImpl, queue, cloud: () => cloud });
  assert.equal(bare.enabled(), true);
  cloud = { routesAll: () => false, ready: () => false };
  assert.equal(bare.enabled(), false);
  // a cloud that throws changes nothing
  const broken = createRenderNodeClient({ store, env: {}, fetchImpl, queue, cloud: () => ({ routesAll() { throw new Error('x'); }, ready() { throw new Error('x'); } }) });
  assert.deepEqual(await broken.submit(HTML, 'draft', undefined, 'landscape', 24, { owner: 'lokal' }), { jobId: 'push-1', nodeId: 'node-a' });
  // a computer of a server renders any job, after the people's computers
  assert.equal(defaultMayServe({ cloud: 'cr-0123456789ab', owner: SYSTEM_OWNER }, 'anna@example.com'), 2);
}

// System codes (lib/render-agents.js): bound to a server, not to a person; they and the codes of people never end each other.
function testSystemCodes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-cloud-codes-'));
  const agents = createRenderAgentsStore({ file: path.join(dir, 'render-agents.json'), now: () => Date.parse('2026-10-11T10:00:00Z') });
  const person = agents.createPairingCode('lokal');
  const one = agents.createSystemPairingCode('cr-00000000000a');
  const two = agents.createSystemPairingCode('cr-00000000000b');
  assert.equal(one.ttlSeconds, 900, 'a server has 15 minutes to boot');
  agents.createPairingCode('lokal');
  assert.equal(agents.checkCode(one.code, '10.0.0.1').cloud, 'cr-00000000000a', 'a new code of a person leaves the system codes alone');
  assert.throws(() => agents.checkCode(person.code, '10.0.0.1'), /ungültig/, 'the person still has one open code');
  const again = agents.createSystemPairingCode('cr-00000000000a');
  assert.throws(() => agents.checkCode(one.code, '10.0.0.1'), /ungültig/, 'a new code of the same server ends its old one');
  assert.equal(agents.checkCode(two.code, '10.0.0.1').cloud, 'cr-00000000000b');
  agents.forgetSystemCode('cr-00000000000b');
  assert.throws(() => agents.checkCode(two.code, '10.0.0.1'), /ungültig/);
  assert.throws(() => agents.createSystemPairingCode('cr-x'), /Schlüssel/);
  const { agent } = agents.pair({ code: again.code, ip: '10.0.0.2', name: 'cloud-000000', versions: VERSIONS });
  assert.deepEqual({ owner: agent.owner, shareAll: agent.shareAll, shareTeams: agent.shareTeams, cloud: agent.cloud }, { owner: SYSTEM_OWNER, shareAll: true, shareTeams: false, cloud: 'cr-00000000000a' });
  assert.deepEqual(agents.listForOwner('lokal'), [], 'nobody sees a server under «My computers»');
  // the key survives the file (a new process)
  agents.reload();
  assert.equal(agents.getAgent(agent.id).cloud, 'cr-00000000000a');
  // a person's computer never carries a key
  const { code } = agents.createPairingCode('lokal');
  assert.equal(agents.pair({ code, ip: '10.0.0.3', name: 'Mac', versions: VERSIONS }).agent.cloud, undefined);
}

// The section in the settings: the script loads before app.js into its slot, every text it uses exists in three languages,
// and the token is only ever sent, never shown.
function testInterface() {
  const root = path.resolve(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(index.includes('id="cloudRenderSlot"'));
  assert.ok(index.indexOf('cloud-render-ui.js') > 0 && index.indexOf('cloud-render-ui.js') < index.indexOf('<script src="app.js"'));
  const source = fs.readFileSync(path.join(root, 'public', 'cloud-render-ui.js'), 'utf8');
  const window = { document: { documentElement: { lang: '' }, querySelectorAll: () => [] }, navigator: { language: 'de-CH' }, localStorage: { getItem: () => null, setItem() {} } };
  const vm = require('vm');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
  const keys = new Set([...source.matchAll(/tr\('(cloud\.[a-zA-Z_.]+)'/g)].map((match) => match[1]));
  for (const phase of ['off', 'not_configured', 'ready', 'starting', 'running', 'cap_reached', 'backoff', 'unauthorized', 'paused', 'stopping']) keys.add(`cloud.phase.${phase}`);
  for (const problem of ['token', 'snapshot', 'publicUrl']) keys.add(`cloud.problem.${problem}`);
  for (const state of ['creating', 'booting', 'online', 'deleting']) keys.add(`cloud.server.${state}`);
  for (const key of keys) for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][key], `${lang}.${key}`);
  assert.ok(keys.size > 40, `${keys.size} texts`);
  const context = { window: { ...window, t: window.t, getLang: () => 'de' }, document: {}, setTimeout, clearTimeout };
  context.window.window = context.window;
  vm.runInNewContext(source.replace(/\}\)\(window\);\s*$/, '})(window);'), context, { filename: 'public/cloud-render-ui.js' });
  const helpers = context.window.OCCloudRender.helpers;
  assert.equal(helpers.euro(0.1547), '0.15 €');
  assert.equal(helpers.ageText(125 * 60), '2 h 05 min');
  assert.equal(helpers.ageText(12 * 60), '12 min');
  assert.equal(helpers.phaseText({ phase: 'not_configured', problems: ['token', 'publicUrl'] }), 'Eingeschaltet, aber es fehlt: Token, PUBLIC_BASE_URL der App.');
  assert.equal(helpers.serverLine({ status: 'online', ageSeconds: 3000, costEur: 0.1547, rendering: 1 }), 'bereit · 50 min · 0.15 € · rendert');
  // the token field is a password field that is emptied after saving, and only sent when typed
  assert.match(source, /type: 'password'/);
  assert.match(source, /if \(token\.value\.trim\(\)\) patch\.token = token\.value\.trim\(\);/);
  assert.ok(!/innerHTML/.test(source), 'text only, never HTML');
}

async function main() {
  testSystemCodes();
  testInterface();
  await testStartPairRenderDelete();
  await testIdleAtMinuteFifty();
  await testReserveAndFirst();
  await testMaxServers();
  await testMonthlyCap();
  await testHardLimit();
  await testBootTimeoutAndPause();
  await testRefusalsAndBackoff();
  await testReconcile();
  await testRestart();
  await testPairedButSilent();
  await testSilentAfterOnline();
  testCloudImageUnits();
  await testTokenGuard();
  await testInstanceId();
  await testSwitchedOff();
  await testSettings();
  await testRouting();
  await settle();
  console.log('Render-Server in der Cloud: Start bei wartenden Aufträgen (Reserve und zuerst), Kopplung mit eigenem Code, online erst mit der ersten Abfrage, Löschen vor der nächsten Stunde, harte Grenze, Monatsdeckel, Backoff ohne Schleife, Abgleich, Neustart, Token bleibt bei laufenden Servern, ID der Installation und der Token nirgends: korrekt.');
  console.log('test-cloud-render.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
