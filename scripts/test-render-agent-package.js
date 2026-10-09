'use strict';

// The package of the render agent (WP46): the fixed list of files that leaves the server (never service.env, jobs, uploads,
// node_modules or a token), the checksums, the pinned versions (HyperFrames of the package = the version the app demands =
// the lockfile; ffmpeg and ffprobe exact; every package from the npm registry with its integrity), the push nodes keep their
// render-node/package.json, setup.js refuses odd paths and damaged files, and both installers. The bash installer runs for
// real against a fake app on 127.0.0.1, with a fake npm on the PATH (no download): package with the code, files, npm ci,
// the browser check, ffmpeg, pairing (agent.json with mode 600), then "node agent.js update" with the token and no code.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const routesLib = require('../lib/render-agent-routes');
const agentLib = require('../render-node/agent');
const setupLib = require('../render-node/setup');

const ROOT = path.resolve(__dirname, '..');
const RENDER_NODE = path.join(ROOT, 'render-node');
const CODE = 'TEST-CODE';
const TOKEN = `ocra_${'T'.repeat(43)}`;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function manifestOf(text) {
  const start = text.indexOf('const PACKAGE = ') + 'const PACKAGE = '.length;
  return JSON.parse(text.slice(start, text.indexOf(';\n', start)));
}

function testFilesAndVersions() {
  const files = routesLib.PACKAGE_FILES.map(([name]) => name);
  assert.deepEqual(files, ['agent.js', 'service.js', 'template/hyperframes.json', 'package.json', 'package-lock.json', 'README.md']);
  for (const [name, from] of routesLib.PACKAGE_FILES) {
    for (const value of [name, from]) assert.ok(!/(^|\/)(\.env|service\.env|jobs|uploads|node_modules|agent\.json|agent\.lock|agent-jobs)(\/|$)/.test(value), value);
  }
  const routes = routesLib.createRenderAgentRoutes({ store: {}, queue: null, packageDir: RENDER_NODE, log: { warn() {}, error() {}, log() {} } });
  const text = routes.buildPackage();
  assert.equal(routes.buildPackage(), text, 'built once, then from the cache');
  assert.ok(text.startsWith('#!/usr/bin/env node'));
  assert.ok(!text.includes(routesLib.PACKAGE_PLACEHOLDER));
  const manifest = manifestOf(text);
  assert.equal(manifest.format, 1);
  assert.equal(manifest.protocol, routesLib.PROTOCOL_VERSION);
  assert.equal(manifest.protocol, agentLib.PROTOCOL_VERSION, 'the agent speaks the protocol of the app');
  assert.deepEqual(manifest.files.map((file) => file.path), files);
  for (const [index, [, from]] of routesLib.PACKAGE_FILES.entries()) {
    const data = fs.readFileSync(path.join(RENDER_NODE, from));
    assert.equal(manifest.files[index].sha256, sha256(data), from);
    assert.equal(Buffer.from(manifest.files[index].base64, 'base64').compare(data), 0, from);
  }
  assert.ok(Buffer.byteLength(text) < 400 * 1024, `the package stays small (${Buffer.byteLength(text)} bytes)`);
  // the versions: package = app = lockfile, all exact
  const agentPackage = JSON.parse(fs.readFileSync(path.join(RENDER_NODE, 'agent', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(RENDER_NODE, 'agent', 'package-lock.json'), 'utf8'));
  assert.equal(agentPackage.dependencies.hyperframes, routesLib.HYPERFRAMES_VERSION);
  assert.equal(manifest.hyperframes, routesLib.HYPERFRAMES_VERSION);
  assert.deepEqual(routes.required(), { protocol: 1, hyperframes: routesLib.HYPERFRAMES_VERSION });
  assert.deepEqual(Object.keys(agentPackage.dependencies), ['hyperframes'], 'nothing else: the agent uses Node alone');
  assert.deepEqual(agentPackage.optionalDependencies, { '@derhuerst/ffprobe-static': '5.3.0', 'ffmpeg-static': '5.3.0' });
  for (const version of [...Object.values(agentPackage.dependencies), ...Object.values(agentPackage.optionalDependencies)]) assert.match(version, /^\d+\.\d+\.\d+$/, 'pinned exactly');
  assert.equal(agentPackage.engines.node, '>=22');
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, agentPackage.dependencies);
  assert.deepEqual(lock.packages[''].optionalDependencies, agentPackage.optionalDependencies);
  assert.equal(lock.packages['node_modules/hyperframes'].version, routesLib.HYPERFRAMES_VERSION);
  assert.equal(lock.packages['node_modules/ffmpeg-static'].version, '5.3.0');
  assert.equal(lock.packages['node_modules/@derhuerst/ffprobe-static'].version, '5.3.0');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.ok(String(entry.resolved).startsWith('https://registry.npmjs.org/'), `${name} comes from the npm registry`);
    assert.match(String(entry.integrity), /^sha512-/, `${name} has its integrity`);
  }
  // the push nodes keep their own package.json
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(RENDER_NODE, 'package.json'), 'utf8')), {
    name: 'render-node',
    version: '1.0.0',
    description: 'HyperFrames motion-graphics render node for Open Creative Director',
    main: 'service.js',
    type: 'commonjs',
    dependencies: { hyperframes: '^0.8.139' }
  });
  // the files of a computer stay out of git
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['render-node/agent.json', 'render-node/agent-jobs/', 'render-node/agent.lock']) assert.ok(ignore.split('\n').includes(entry), entry);
  return text;
}

function testSetupChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-setup-'));
  const data = Buffer.from('{"ok":true}\n');
  const good = { path: 'template/hyperframes.json', sha256: sha256(data), base64: data.toString('base64') };
  setupLib.writeFile(dir, good);
  assert.equal(fs.readFileSync(path.join(dir, 'template', 'hyperframes.json'), 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'template')), ['hyperframes.json'], 'no temporary file stays');
  for (const bad of ['../outside.js', '/etc/passwd', 'a/../../b.js', 'C:\\x.js', '.env', 'template/.hidden', 'a//b', '', 'x/', 'C:/x.js']) {
    assert.throws(() => setupLib.writeFile(dir, { ...good, path: bad }), /beschädigt|damaged|dañado/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => setupLib.writeFile(dir, { ...good, sha256: '0'.repeat(64) }), /beschädigt|damaged|dañado/, 'a damaged file is refused');
  assert.ok(!fs.existsSync(path.join(dir, 'outside.js')) && !fs.existsSync(path.join(path.dirname(dir), 'outside.js')));
  assert.deepEqual(setupLib.parseArgs(['--server', 'https://a.example', '--code=AB12-CD34', '--dir', '/x y', '--name', 'Mac', '--no-start']), { update: false, start: false, server: 'https://a.example', code: 'AB12-CD34', dir: '/x y', name: 'Mac' });
  assert.deepEqual(setupLib.parseArgs(['--update', '--dir', '/x']), { update: true, start: true, dir: '/x' });
  for (const lang of ['de', 'en', 'es']) {
    assert.deepEqual(Object.keys(setupLib.TEXTS[lang]).sort(), Object.keys(setupLib.TEXTS.de).sort(), `setup texts ${lang}`);
  }
  // the raw file (no package inside) says so
  const raw = spawnSync(process.execPath, [path.join(RENDER_NODE, 'setup.js')], { encoding: 'utf8', env: { ...process.env, LANG: 'de_CH.UTF-8', LC_ALL: '', LC_MESSAGES: '' } });
  assert.equal(raw.status, 1);
  assert.match(raw.stderr, /kein Paket/);
}

function testInstallerTexts() {
  const sh = fs.readFileSync(path.join(RENDER_NODE, 'install.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(RENDER_NODE, 'install.ps1'), 'utf8');
  for (const text of [sh, ps]) {
    assert.ok(!text.includes('\u00df'));
    assert.ok(text.includes('X-Render-Agent-Code'), 'the code goes in a header, not in the address');
    assert.ok(text.includes('/api/render-agent/package'));
  }
  assert.ok(sh.startsWith('#!/usr/bin/env bash\n'));
  assert.match(sh, /set -euo pipefail/);
  assert.match(sh, /trap 'rm -rf "\$\{OCD_SETUP_DIR:-\}"' EXIT/);
  assert.match(sh, /node "\$\{tmp\}\/setup\.js" "\$\{args\[@\]\}" <\/dev\/null/, 'setup does not read the piped script');
  const code = ps.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.ok(!/\bexit\b/i.test(code), 'the PowerShell installer never ends the session it runs in');
  assert.match(ps, /param\(\s*\[string\]\$Server/);
  assert.match(ps, /finally \{\s*Remove-Item -LiteralPath \$setup/);
  assert.ok(!/Invoke-Expression|iex /i.test(code));
  const commands = routesLib.installCommands('https://creator.example.com', 'ABCD-EFGH');
  assert.equal(commands.bash, 'curl -fsSL https://creator.example.com/api/render-agent/install.sh | bash -s -- --server https://creator.example.com --code ABCD-EFGH');
  // TLS 1.2 first: Windows PowerShell 5.1 may still start with older protocols
  assert.equal(commands.powershell, "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm 'https://creator.example.com/api/render-agent/install.ps1'))) -Server 'https://creator.example.com' -Code 'ABCD-EFGH'");
  const check = spawnSync('bash', ['-n', path.join(RENDER_NODE, 'install.sh')], { encoding: 'utf8' });
  if (check.error) console.log('bash fehlt: Syntaxprüfung von install.sh übersprungen');
  else assert.equal(check.status, 0, check.stderr);
}

// A fake npm: "npm ci" writes what the package would install (HyperFrames with a CLI that answers "browser ensure", ffmpeg
// and ffprobe that tell their version) and records the call.
function fakeTools(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const files = [
    ['hyperframes/package.json', JSON.stringify({ name: 'hyperframes', version: routesLib.HYPERFRAMES_VERSION }), 0o644],
    ['hyperframes/bin/hyperframes.mjs', `import fs from 'fs';\nfs.appendFileSync(${JSON.stringify(path.join(dir, 'hyperframes-calls.txt'))}, process.argv.slice(2).join(' ') + '\\n');\n`, 0o644]
  ];
  for (const [pkg, tool] of [['ffmpeg-static', 'ffmpeg'], ['@derhuerst/ffprobe-static', 'ffprobe']]) {
    files.push([`${pkg}/package.json`, JSON.stringify({ name: pkg, main: 'index.js' }), 0o644]);
    files.push([`${pkg}/index.js`, `module.exports = require('path').join(__dirname, ${JSON.stringify(tool)});\n`, 0o644]);
    files.push([`${pkg}/${tool}`, `#!/bin/sh\necho "${tool} version 6.0 Copyright (c) the FFmpeg developers"\n`, 0o755]);
  }
  const plan = path.join(dir, 'fake-npm.json');
  fs.writeFileSync(plan, JSON.stringify({ calls: path.join(dir, 'npm-calls.txt'), files }));
  const script = path.join(dir, 'fake-npm.js');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    "const path = require('path');",
    `const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, 'utf8'));`,
    "fs.appendFileSync(plan.calls, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');",
    'for (const [name, text, mode] of plan.files) {',
    "  const file = path.join(process.cwd(), 'node_modules', ...name.split('/'));",
    '  fs.mkdirSync(path.dirname(file), { recursive: true });',
    '  fs.writeFileSync(file, text, { mode });',
    '}',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return bin;
}

async function fakeApp(packageText) {
  const seen = { pair: [], packages: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/render-agent/package') {
        const byCode = req.headers['x-render-agent-code'] === CODE;
        const byToken = req.headers.authorization === `Bearer ${TOKEN}`;
        seen.packages.push(byCode ? 'code' : byToken ? 'token' : 'refused');
        if (!byCode && !byToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end('{"error":"Code ungueltig","code":"INVALID_CODE"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(packageText);
      }
      if (req.method === 'POST' && url.pathname === '/api/render-agent/pair') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        seen.pair.push(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ token: TOKEN, agent: { id: 'ra-0123456789ab', name: body.name, owner: 'anna@example.com' } }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unknown"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });
}

async function testBashInstaller(packageText) {
  const tools = ['bash', 'curl'].filter((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0);
  if (tools.length || process.platform === 'win32') {
    console.log(`Installationslauf übersprungen (fehlt: ${tools.join(', ') || 'Windows'})`);
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-install-'));
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp);
  const bin = fakeTools(home);
  const target = path.join(home, 'mein agent');
  const app = await fakeApp(packageText);
  const env = {
    PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    HOME: home,
    TMPDIR: tmp,
    LANG: 'de_CH.UTF-8'
  };
  try {
    // a wrong code: a clear message, nothing installed
    const wrong = await run('bash', [path.join(RENDER_NODE, 'install.sh'), '--server', app.url, '--code', 'FALS-CHER', '--dir', target], { env });
    assert.equal(wrong.status, 1, wrong.output);
    assert.match(wrong.output, /Das Paket konnte nicht geladen werden/);
    assert.ok(!fs.existsSync(target));
    // the real thing (piped like the command of the app: curl … | bash -s -- …)
    const script = fs.readFileSync(path.join(RENDER_NODE, 'install.sh'));
    const result = await new Promise((resolve) => {
      const child = spawn('bash', ['-s', '--', '--server', `${app.url}/`, '--code', CODE, '--dir', target, '--name', 'Test Mac', '--no-start'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      child.on('close', (status) => resolve({ status, output }));
      child.stdin.end(script);
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Installiere den Render-Agent in .*mein agent/);
    assert.match(result.output, /ffmpeg 6\.0 \(mitgeliefert\)\./);
    assert.match(result.output, /Gekoppelt als «Test Mac»\./);
    assert.ok(result.output.includes(`Starten: node "${path.join(target, 'agent.js')}"`), 'a folder with a space is quoted');
    assert.ok(!result.output.includes(TOKEN.slice(5)), 'the token is never printed');
    assert.deepEqual(app.seen.packages, ['refused', 'code'], 'the wrong code was refused, the right one fetched the package');
    // the files, npm ci, the browser check, the pairing
    for (const [name, from] of routesLib.PACKAGE_FILES) assert.equal(sha256(fs.readFileSync(path.join(target, name))), sha256(fs.readFileSync(path.join(RENDER_NODE, from))), name);
    const npmCalls = fs.readFileSync(path.join(home, 'npm-calls.txt'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(npmCalls.map((call) => call.args), [['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']]);
    assert.equal(fs.realpathSync(npmCalls[0].cwd), fs.realpathSync(target));
    assert.equal(fs.readFileSync(path.join(home, 'hyperframes-calls.txt'), 'utf8'), 'browser ensure\n');
    assert.equal(app.seen.pair.length, 1);
    assert.equal(app.seen.pair[0].code, CODE);
    assert.equal(app.seen.pair[0].name, 'Test Mac');
    assert.deepEqual(app.seen.pair[0].versions, { protocol: 1, agent: agentLib.AGENT_VERSION, hyperframes: routesLib.HYPERFRAMES_VERSION, node: process.versions.node, ffmpeg: '6.0', ffmpegSource: 'bundled' });
    const credentials = path.join(target, 'agent.json');
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).token, TOKEN);
    assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).server, app.url, 'the address without the slash');
    assert.deepEqual(fs.readdirSync(tmp), [], 'the downloaded setup.js is deleted');
    // the update: with the token, no code
    const update = await run(process.execPath, [path.join(target, 'agent.js'), 'update'], { env, cwd: home });
    assert.equal(update.status, 0, update.output);
    assert.match(update.output, /Lade das aktuelle Paket/);
    assert.match(update.output, /Aktualisiert/);
    assert.deepEqual(app.seen.packages, ['refused', 'code', 'token']);
    assert.equal(fs.readFileSync(path.join(home, 'npm-calls.txt'), 'utf8').trim().split('\n').length, 2);
    assert.equal(app.seen.pair.length, 1, 'no new pairing');
    assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).token, TOKEN, 'the token stays');
    assert.ok(!update.output.includes(TOKEN.slice(5)));
    const status = await run(process.execPath, [path.join(target, 'agent.js'), 'status'], { env, cwd: home });
    assert.match(status.output, /Gekoppelt mit http:\/\/127\.0\.0\.1:\d+ als «Test Mac» \(ra-0123456789ab\)\./);
    assert.ok(!status.output.includes(TOKEN.slice(5)));
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const packageText = testFilesAndVersions();
  testSetupChecks();
  testInstallerTexts();
  await testBashInstaller(packageText);
  console.log('Paket des Render-Agents: feste Dateiliste, Prüfsummen, gepinnte Versionen, unveränderte Push-Nodes, Prüfungen von setup.js und beide Installer (bash echt gegen eine Test-App) sind korrekt.');
  console.log('test-render-agent-package.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
