'use strict';

// The build of the snapshot of the render servers in the cloud (WP54, render-node/cloud-snapshot.py) against a fake Hetzner
// API and a fake server inside Python (no call to Hetzner, no ssh, nothing paid): the order of the steps (a fresh Ubuntu
// server, SSH, cloud-image.sh uploaded and run, the versions read, «sync; systemctl poweroff» inside the server and never the
// API action poweroff, the snapshot with its labels, the server deleted, the id printed), the server deleted on every error,
// --dry-run without a token, and the token in no error text.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'render-node', 'cloud-snapshot.py');
const TOKEN = 'HzSnapshotTokenAbcdefghijklmnopqrstuvwxyz0123456789';

// Runs in Python: imports the script as a module, replaces the API and ssh, prints the outcome of each case as JSON.
const HARNESS = String.raw`
import importlib.util, io, json, sys, types, urllib.error, urllib.request
spec = importlib.util.spec_from_file_location('cloud_snapshot', sys.argv[1])
snap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snap)
TOKEN = sys.argv[2]

def options(**extra):
    base = dict(type='cpx42', location='nbg1', ssh_key='12345', identity=None, server='https://app.example.com', code='ABCD-EFGH',
                script=sys.argv[3], ssh_timeout=60, script_timeout=60, off_timeout=60, image_timeout=60)
    base.update(extra)
    return types.SimpleNamespace(**base)

class Fake:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail or {}
        self.polls = 0
        self.ssh_calls = []
        self.off = False
    def api(self, method, path, body=None):
        self.calls.append([method, path, body])
        if (method, path) in self.fail:
            raise snap.BuildError(self.fail[(method, path)])
        if method == 'POST' and path == '/servers':
            return {'server': {'id': 77, 'public_net': {'ipv4': {'ip': '192.0.2.10'}}}, 'action': {'id': 1}}
        if method == 'GET' and path.startswith('/actions/'):
            return {'action': {'status': 'success'}}
        if method == 'GET' and path == '/servers/77':
            self.polls += 1
            return {'server': {'status': 'off' if self.off and self.polls > 1 else 'running'}}
        if method == 'POST' and path == '/servers/77/actions/create_image':
            return {'image': {'id': 555}, 'action': {'id': 2}}
        if method == 'GET' and path == '/images/555':
            return {'image': {'status': 'available'}}
        if method == 'DELETE':
            return {}
        raise snap.BuildError('unexpected ' + method + ' ' + path)
    def ssh(self, ip, command, stdin=None, timeout=600):
        self.ssh_calls.append([ip, command, len(stdin) if stdin else 0])
        if command == 'true':
            return (255, b'') if len(self.ssh_calls) < 2 else (0, b'')
        if command.startswith('bash /root/cloud-image.sh'):
            return (self.fail.get('script', 0), b'')
        if command.startswith('cat /usr/local/lib/ocd-render/image.json'):
            return (0, b'{"hyperframes":"0.8.139","node":"22.17.0","builtAt":"2026-10-11T10:00:00Z"}')
        if command == 'sync; systemctl poweroff':
            self.off = True
            return (255, b'')
        return (0, b'')

def run(fake, **extra):
    lines = []
    builder = snap.Builder(options(**extra), fake.api, fake.ssh, sleep=lambda s: None, clock=iter(range(0, 10**6, 1)).__next__, out=lines.append)
    try:
        image = builder.run()
        error = None
    except snap.BuildError as err:
        image = None
        error = str(err)
    return {'image': image, 'error': error, 'calls': fake.calls, 'ssh': fake.ssh_calls, 'lines': lines}

result = {}
result['ok'] = run(Fake())
result['scriptFails'] = run(Fake({'script': 1}))
result['snapshotFails'] = run(Fake({('POST', '/servers/77/actions/create_image'): 'Hetzner: limit'}))
result['createFails'] = run(Fake({('POST', '/servers'): 'Hetzner: no'}))
result['byName'] = run(Fake(), ssh_key='ops key')['calls'][0]

# the token in an answer of Hetzner never reaches the error text
def refuse(request, timeout=0):
    raise urllib.error.HTTPError(request.full_url, 401, 'Unauthorized', {}, io.BytesIO(json.dumps({'error': {'code': 'unauthorized', 'message': 'bad ' + request.headers['Authorization']}}).encode()))
urllib.request.urlopen = refuse
try:
    snap.make_api(TOKEN)('GET', '/servers')
    result['redacted'] = None
except snap.BuildError as err:
    result['redacted'] = str(err)
print(json.dumps(result))
`;

function main() {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (python.status !== 0) {
    console.log('python3 fehlt: Test übersprungen.');
    console.log('test-cloud-snapshot.js: ok');
    return;
  }
  const compiled = spawnSync('python3', ['-I', '-B', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', SCRIPT], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);

  const run = spawnSync('python3', ['-I', '-B', '-c', HARNESS, SCRIPT, TOKEN, path.resolve(__dirname, '..', 'render-node', 'cloud-image.sh')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);

  // the steps in order
  const ok = result.ok;
  assert.equal(ok.error, null);
  assert.equal(ok.image, 555);
  const [create] = ok.calls;
  assert.deepEqual(create.slice(0, 2), ['POST', '/servers']);
  assert.equal(create[2].image, 'ubuntu-24.04');
  assert.equal(create[2].server_type, 'cpx42');
  assert.equal(create[2].location, 'nbg1');
  assert.deepEqual(create[2].ssh_keys, [12345], 'an id is sent as a number');
  assert.deepEqual(create[2].labels, { 'ocd-render': 'build' });
  assert.deepEqual(result.byName[2].ssh_keys, ['ops key'], 'a name as text');
  const commands = ok.ssh.map(([, command]) => command);
  assert.equal(commands.filter((command) => command === 'true').length, 2, 'waits until SSH answers');
  const upload = ok.ssh.find(([, command]) => command.startsWith('cat > /root/cloud-image.sh'));
  assert.equal(upload[2], fs.statSync(path.resolve(__dirname, '..', 'render-node', 'cloud-image.sh')).size, 'cloud-image.sh uploaded');
  assert.ok(commands.some((command) => command.startsWith("bash /root/cloud-image.sh --server 'https://app.example.com' --code 'ABCD-EFGH'")));
  const order = (text) => commands.findIndex((command) => command.startsWith(text));
  assert.ok(order('cat > /root/cloud-image.sh') < order('bash /root/cloud-image.sh'));
  assert.ok(order('bash /root/cloud-image.sh') < order('cat /usr/local/lib/ocd-render/image.json'));
  assert.ok(order('cat /usr/local/lib/ocd-render/image.json') < order('sync; systemctl poweroff'), 'a clean shutdown inside the server');
  assert.ok(!ok.calls.some(([, url]) => /actions\/(poweroff|shutdown)/.test(url)), 'never the API action poweroff');
  const paths = ok.calls.map(([method, url]) => `${method} ${url}`);
  const image = ok.calls.find(([, url]) => url === '/servers/77/actions/create_image');
  assert.equal(image[2].type, 'snapshot');
  assert.deepEqual(image[2].labels, { 'ocd-render': 'image', 'ocd-hyperframes': '0.8.139', 'ocd-node': '22.17.0' });
  assert.match(image[2].description, /HyperFrames 0\.8\.139, Node\.js 22\.17\.0/);
  assert.ok(paths.lastIndexOf('GET /servers/77') < paths.indexOf('POST /servers/77/actions/create_image'), 'the snapshot only once the server is off');
  assert.ok(paths.indexOf('GET /images/555') < paths.indexOf('DELETE /servers/77'), 'deleted once the snapshot is available');
  assert.equal(paths.filter((entry) => entry === 'DELETE /servers/77').length, 1);

  // every error deletes the server
  for (const name of ['scriptFails', 'snapshotFails']) {
    assert.ok(result[name].error, name);
    assert.ok(result[name].calls.some(([method, url]) => method === 'DELETE' && url === '/servers/77'), `${name}: the server is deleted`);
  }
  assert.ok(!result.scriptFails.calls.some(([, url]) => url.includes('create_image')));
  assert.ok(result.createFails.error);
  assert.ok(!result.createFails.calls.some(([method]) => method === 'DELETE'), 'nothing to delete without a server');

  // the token never in an error
  assert.ok(result.redacted && result.redacted.includes('[token]'), result.redacted);
  assert.ok(!result.redacted.includes(TOKEN));

  // --dry-run: the steps, no token read (the file does not exist), nothing called
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-snapshot-'));
  const dry = spawnSync('python3', ['-I', '-B', SCRIPT, '--dry-run', '--ssh-key', 'ops', '--server', 'https://app.example.com'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HETZNER_TOKEN_FILE: path.join(dir, 'missing-token') }
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /ubuntu-24\.04, type cpx42, location nbg1/);
  assert.match(dry.stdout, /sync; systemctl poweroff/);
  assert.match(dry.stdout, /missing-token/);
  // without --dry-run a missing token file is an error that names no token
  const missing = spawnSync('python3', ['-I', '-B', SCRIPT, '--ssh-key', 'ops', '--server', 'https://app.example.com', '--code', 'ABCD-EFGH'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HETZNER_TOKEN_FILE: path.join(dir, 'missing-token') }
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /token file cannot be read/);
  // the token is read from a file, never from the arguments
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/add_argument\('--token'/.test(source), 'no option for the token itself');

  console.log('Snapshot der Render-Server: Schritte in der richtigen Reihenfolge, sauberes Ausschalten im Server, Server bei jedem Fehler gelöscht, Probelauf ohne Token, Token in keinem Fehler: korrekt.');
  console.log('test-cloud-snapshot.js: ok');
}

main();
