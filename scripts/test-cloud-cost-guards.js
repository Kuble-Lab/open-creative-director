'use strict';

// Cost guards with an in-process provider: no sockets, credentials or paid requests.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createCloudRender } = require('../lib/cloud-render');
const HOUR = 3600000;
const roots = [];
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-guards-'));
  roots.push(dir);
  const clock = { now: Date.parse('2026-10-11T10:00:00Z') };
  const fake = { price: '0.10', servers: [], posts: 0, failDelete: false, keepDeleted: false, lost: false, stall: false, calls: [] };
  const fetchImpl = async (url, options) => {
    const route = new URL(url);
    fake.calls.push([options.method, route.pathname]);
    const answer = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (route.pathname.endsWith('/server_types')) {
      if (fake.stall) return { status: 200, ok: true, text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) };
      return answer({ server_types: [{ name: 'cpx42', prices: [{ location: 'nbg1', price_hourly: { gross: fake.price } }] }] });
    }
    if (route.pathname.endsWith('/firewalls')) return answer({ firewalls: [{ id: 1 }] });
    if (options.method === 'POST') {
      fake.posts++;
      const body = JSON.parse(options.body);
      const server = { ...body, id: fake.posts, created: new Date(clock.now).toISOString() };
      fake.servers.push(server);
      if (fake.lost) throw new Error('lost response');
      return answer({ server });
    }
    if (options.method === 'DELETE') {
      if (fake.failDelete) return answer({ error: { code: 'unavailable' } }, 503);
      if (!fake.keepDeleted) fake.servers = fake.servers.filter((server) => server.id !== Number(route.pathname.split('/').pop()));
      return answer({});
    }
    const selector = route.searchParams.get('label_selector');
    return answer({ servers: fake.servers.filter((server) => selector === 'ocd-render=' + server.labels['ocd-render']) });
  };
  const make = () => createCloudRender({
    dir, now: () => clock.now, fetchImpl, apiBase: 'https://provider.example/v1', serverUrl: () => 'https://app.example',
    agents: { listAgents: () => [], createSystemPairingCode: () => ({ code: 'ABCD-EFGH' }), forgetSystemCode() {} },
    queue: { demand: async () => ({ queued: Array.from({ length: 10 }, () => ({ workerOnline: false })), idleAgents: [], busyAgents: [] }) },
    limits: { requestTimeoutMs: 20, backoffMs: [10] }, log: { warn() {}, info() {} }
  });
  const manager = make();
  manager.updateSettings({ enabled: true, token: 'a'.repeat(30), snapshotId: '123', monthlyCapEur: 30 });
  return { dir, fake, clock, manager, make };
}
async function main() {
  for (const price of [null, '', 'NaN', '0', '-1']) {
    const env = setup();
    env.fake.price = price;
    await env.manager.tick();
    assert.equal(env.fake.posts, 0, 'unknown price cannot create');
    assert.equal(env.manager.status().lastError.code, 'price_unknown');
    const calls = env.fake.calls.length;
    await env.manager.tick();
    assert.equal(env.fake.calls.length, calls, 'price lookup backs off');
    env.clock.now += 20;
    env.fake.price = '0.1';
    await env.manager.tick();
    assert.equal(env.fake.posts, 1, 'valid price recovers');
  }
  {
    const env = setup();
    env.manager.updateSettings({ monthlyCapEur: 0.29 });
    await env.manager.tick();
    assert.equal(env.fake.posts, 0, 'three-hour reservation must fit');
    env.manager.updateSettings({ monthlyCapEur: 0.61, maxServers: 10 });
    await env.manager.tick();
    await env.manager.tick();
    await env.manager.tick();
    assert.equal(env.fake.posts, 2, 'open servers reserve their full runtime');
  }
  for (const keepDeleted of [true, false]) {
    const env = setup();
    await env.manager.tick();
    env.fake.keepDeleted = keepDeleted;
    env.fake.failDelete = !keepDeleted;
    env.clock.now += 3 * HOUR;
    await env.manager.tick();
    assert.equal(env.manager.status().servers[0].status, 'deleting');
    assert.equal(env.fake.posts, 1, 'failed or unconfirmed deletion cannot be replaced');
    assert.equal(env.manager.status().month.spentEur, 0.3);
    env.clock.now += HOUR;
    await env.manager.tick();
    assert.equal(env.manager.status().month.spentEur, 0.4, 'deleting server keeps accruing');
    env.fake.keepDeleted = false;
    env.fake.failDelete = false;
    await env.manager.reconcile();
    env.clock.now += HOUR;
    await env.manager.tick();
    assert.ok(env.fake.posts <= 2);
  }
  {
    const env = setup();
    env.fake.lost = true;
    await env.manager.tick();
    assert.equal(env.manager.status().servers.length, 1);
    assert.equal(env.manager.status().month.spentEur, 0.1);
    env.clock.now += 20;
    await env.manager.tick();
    assert.equal(env.fake.posts, 1, 'lost create response blocks replacement');
    const restarted = env.make();
    env.fake.lost = false;
    await restarted.tick();
    assert.equal(env.fake.posts, 2, 'restart replaces only after reconciliation');
    assert.deepEqual(env.fake.servers.map((server) => server.id), [2], 'uncertain server found by key and deleted first');
    assert.equal(restarted.status().servers.length, 1);
    assert.equal(restarted.status().month.spentEur, 0.2, 'the uncertain creation is booked only once');
  }
  {
    const env = setup();
    await env.manager.tick();
    env.fake.lost = true;
    env.manager.updateSettings({ maxServers: 2 });
    const original = fs.writeFileSync;
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(path.join(env.dir, 'state.json')) && env.fake.posts === 1) throw new Error('disk full');
      return original(target, ...args);
    };
    try {
      await env.manager.tick();
      assert.equal(env.fake.posts, 1, 'no additional expense while state writes fail');
    } finally { fs.writeFileSync = original; }
  }
  {
    const env = setup();
    env.fake.lost = true;
    await env.manager.tick();
    env.fake.servers = [];
    await env.manager.reconcile();
    assert.equal(env.manager.status().month.spentEur, 0, 'confirmed absent creation releases its provisional cost');
    assert.equal(env.manager.status().servers.length, 0);
  }
  {
    const env = setup();
    env.fake.stall = true;
    let deadline;
    const timedOut = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('body timeout did not release management')), 1000);
    });
    try {
      await Promise.race([env.manager.tick(), timedOut]);
      assert.equal(env.manager.status().lastError.code, 'network', 'body timeout releases management queue');
      env.fake.stall = false;
      env.clock.now += 20;
      await env.manager.tick();
      assert.equal(env.fake.posts, 1);
    } finally { clearTimeout(deadline); }
  }
  for (const file of ['state.json', 'ledger.json']) {
    const env = setup();
    const write = fs.writeFileSync;
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(path.join(env.dir, file))) throw new Error('disk full');
      return write(target, ...args);
    };
    try {
      await env.manager.tick();
      assert.equal(env.fake.posts, 0);
      assert.equal(env.manager.status().lastError.code, 'persistence');
    } finally { fs.writeFileSync = write; }
    env.clock.now += 20;
    await env.manager.tick();
    assert.equal(env.fake.posts, 1, 'writes recover without restart');
  }
  for (const content of ['{broken', '{"entries":[{"key":"bad"}]}']) {
    const env = setup();
    const file = path.join(env.dir, 'ledger.json');
    fs.writeFileSync(file, content);
    const restarted = env.make();
    await restarted.reconcile();
    await restarted.tick();
    assert.equal(env.fake.posts, 0);
    assert.equal(restarted.status().lastError.code, 'budget_data');
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'invalid budget is never overwritten');
  }
  {
    // an installation that never started a server never had a ledger: it starts with an empty one
    const env = setup();
    const file = path.join(env.dir, 'ledger.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const restarted = env.make();
    await restarted.reconcile();
    await restarted.tick();
    assert.equal(env.fake.posts, 1);
    assert.ok(fs.existsSync(file));
  }
  {
    const env = setup();
    env.fake.servers.push({ id: 99, labels: { 'ocd-render': 'build' }, created: new Date(env.clock.now - 4 * HOUR).toISOString() });
    await env.manager.reconcile();
    assert.equal(env.fake.servers.length, 0);
    assert.equal(env.manager.status().lastError.code, 'build_expired');
  }
  // Execute the real setup main with fake installation and child processes.
  const source = fs.readFileSync(path.join(__dirname, '../render-node/setup.js'), 'utf8')
    .replace('/*@@PACKAGE@@*/ null', JSON.stringify({ files: [{ path: 'unused' }] }))
    + '\nwriteFile = () => {}; markInstalled = () => {};';
  for (const browser of [{ status: 0 }, { status: 1 }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    for (const strict of [true, false]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-setup-'));
      roots.push(dir);
      const module = { exports: {} };
      const context = {
        module, process, console: { log() {}, warn() {}, error() {} },
        require: (name) => name === 'child_process' ? { spawnSync: (cmd, args) => args.includes('ensure') ? browser : { status: 0 } }
          : name === path.join(dir, 'agent.js') ? { prepareFfmpeg: async () => ({ source: 'bundled', version: 'test' }) } : require(name)
      };
      vm.runInNewContext(source, context);
      assert.equal(await module.exports.main(['--update', '--dir', dir, ...(strict ? ['--snapshot-build'] : [])]), strict && browser.status !== 0 ? 1 : 0);
    }
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../render-node/cloud-image.sh'), 'utf8'), /--update --snapshot-build/);
  console.log('test-cloud-cost-guards.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});
