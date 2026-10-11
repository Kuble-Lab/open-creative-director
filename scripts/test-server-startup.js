'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the real startup block without loading credentials, stores or remote services.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .split('/* ---------- startup ---------- */')[1].split('if (require.main === module)')[0];

function setup(env = {}, sweep = () => Promise.resolve(0)) {
  const listeners = [], exits = [], logs = [], timers = [];
  const process = new EventEmitter();
  process.env = env;
  process.exit = (code) => exits.push(code);
  const context = {
    process, BASE_PORT: 3111, runtime: {}, fileConfig: {},
    console: Object.fromEntries(['log', 'warn', 'error'].map((name) => [name, (...args) => logs.push(args.join(' '))])),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    app: { listen(port, host, ready) {
      const server = new EventEmitter();
      server.close = (done) => { server.closed = true; server.done = done; };
      listeners.push({ port, host, server });
      ready();
      return server;
    } },
    or: { hasKey: () => false },
    nodeWorkflows: { defaultStore: { markInterruptedRuns: sweep } },
    discovery: { resolveModels: () => Promise.resolve({}) },
    poller: { start() {} },
    rendernode: { queue: () => ({ start() {} }), cloud: () => ({ start() {} }) },
    access: { isActive: () => false }, accessSync: { enabled: () => false }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, listeners, exits, logs, timers, process };
}

async function main() {
  let finishSweep;
  const local = setup({}, () => new Promise((resolve) => { finishSweep = resolve; }));
  const starting = local.context.startServer();
  assert.equal(local.listeners.length, 0, 'no requests before recovery completes');
  finishSweep(2);
  await starting;
  assert.equal(local.listeners[0].host, '127.0.0.1');
  assert(local.logs.some((line) => line.includes('HOST')));
  local.listeners[0].server.emit('error', { code: 'EADDRINUSE' });
  assert.equal(local.listeners[1].port, 3112, 'development keeps port fallback');

  for (const env of [{ PORT: '3111' }, { NODE_ENV: 'production' }]) {
    const fixed = setup(env);
    await fixed.context.startServer();
    fixed.listeners[0].server.emit('error', { code: 'EADDRINUSE' });
    assert.deepEqual(fixed.exits, [1]);
    assert.equal(fixed.listeners.length, 1);
    assert(fixed.logs.some((line) => line.includes('Port 3111 belegt')));
  }

  const remote = setup({ HOST: '0.0.0.0' });
  await remote.context.startServer();
  assert.equal(remote.listeners[0].host, '0.0.0.0');
  assert(remote.logs.some((line) => line.includes('http://0.0.0.0:3111')));
  remote.process.emit('unhandledRejection', new Error('rejection'));
  assert.equal(remote.exits.length, 0);
  assert.equal(remote.listeners[0].server.closed, undefined);
  remote.process.emit('uncaughtException', new Error('fatal'));
  assert.equal(remote.listeners[0].server.closed, true);
  assert.equal(remote.timers.length, 1);
  assert(remote.timers[0].ms <= 1000);
  remote.timers[0].fn();
  assert.deepEqual(remote.exits, [1], 'even open connections cannot prevent fatal exit');
  assert(remote.logs.some((line) => line.includes('fatal')));

  const broken = setup({}, () => Promise.reject(new Error('recovery failed')));
  await broken.context.startServer();
  // a failed cleanup is logged; the app still starts (a broken run file must not keep it down)
  assert.equal(broken.listeners.length, 1);
  assert.deepEqual(broken.exits, []);
  console.log('test-server-startup.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
