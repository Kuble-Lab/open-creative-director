'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTest, testEnvironment } = require('./run-tests');

async function main() {
  const names = ['OPENROUTER_API_KEY', 'EXAMPLE_TOKEN', 'EXAMPLE_SECRET', 'EXAMPLE_PASSWORD', 'NODE_OPTIONS', 'REMOTE_URL'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-sentinel';
    const env = testEnvironment();
    for (const name of names) assert.equal(env[name], undefined, name);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-isolation-'));
  let pid;
  let watchdog;
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'test-tree.js'), `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', \`
        process.on('SIGTERM', () => {});
        setInterval(() => require('node:fs').appendFileSync('heartbeat', 'x'), 20);
      \`], { stdio: 'inherit' });
      fs.writeFileSync('pid', String(child.pid));
      setInterval(() => {}, 1000);
    `);
    // Bound the regression test even if a broken runner leaves inherited pipes open.
    watchdog = setTimeout(() => {
      try { process.kill(Number(fs.readFileSync(path.join(root, 'pid'), 'utf8')), 'SIGKILL'); } catch (_) {}
    }, 5000);
    const result = await runTest('test-tree.js', 1, root);
    clearTimeout(watchdog);
    assert(result.seconds < 4, 'timeout must not wait for a surviving grandchild');
    pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /timeout/);
    const heartbeat = fs.readFileSync(path.join(root, 'heartbeat'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.readFileSync(path.join(root, 'heartbeat'), 'utf8'), heartbeat, 'grandchild stops before cleanup');
    const parallel = path.join(root, 'parallel');
    fs.mkdirSync(path.join(parallel, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'run-tests.js'), path.join(parallel, 'scripts', 'run-tests.js'));
    for (const name of ['a', 'b']) {
      fs.writeFileSync(path.join(parallel, 'scripts', `test-${name}.js`), `
        require('node:fs').writeFileSync('projects/shared.json', '${name}', { flag: 'wx' });
        setTimeout(() => console.log('test-${name}.js: ok'), 200);
      `);
    }
    const output = require('node:child_process').execFileSync(process.execPath,
      [path.join(parallel, 'scripts', 'run-tests.js'), '--jobs=3'], { encoding: 'utf8', timeout: 10000 });
    assert.match(output, /2\/2 passed/, 'parallel tests own separate mutable data folders');
    fs.writeFileSync(path.join(root, 'scripts', 'test-pass.js'), "console.log('test-pass.js: ok');");
    assert.equal((await runTest('test-pass.js', 5, root)).ok, true);
  } finally {
    clearTimeout(watchdog);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('test-runner-isolation.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
