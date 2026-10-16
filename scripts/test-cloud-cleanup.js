'use strict';
const assert = require('assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const harness = String.raw`
import importlib.util, sys, hashlib
spec = importlib.util.spec_from_file_location('cleanup', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
origin = hashlib.sha256(b'https://app.example').hexdigest()[:32]
def server(id, kind='cloud', expiry='100', own=origin):
    return {'id': id, 'labels': {'ocd-render': kind, 'ocd-expires': expiry, 'ocd-origin': own}}
items = [server(1), server(2, 'build'), server(3, expiry='201'), server(4, expiry='bad'),
         server(5, 'image'), server(6, own='other'), server(7, expiry='0'), server(8, expiry='-1')]
calls = []
def api(method, url, body=None):
    calls.append((method, url))
    if method == 'GET' and url.startswith('/servers?'):
        kind = 'build' if 'build' in url else 'cloud'
        batch = [s for s in items if s['labels']['ocd-render'] == kind]
        second = 'page=2' in url
        return {'servers': batch[1:] if second else batch[:1], 'meta': {'pagination': {'next_page': None if second else 2}}}
    if method == 'GET':
        return {'server': next(s for s in items if str(s['id']) == url.split('/')[-1])}
    return {}
out = []
assert m.cleanup(api, now=200, out=out.append) == 0
assert len(out) == 3 and all(c[0] == 'GET' for c in calls)
calls.clear()
assert m.cleanup(api, delete=True, server='https://app.example/', now=200, out=out.append) == 0
assert [url for method, url in calls if method == 'DELETE'] == ['/servers/1', '/servers/2']
assert max(i for i,c in enumerate(calls) if '?' in c[1]) < min(i for i,c in enumerate(calls) if c[0] == 'DELETE')
# Labels changed between listing and deleting: leave it alone.
def changed(method, url, body=None):
    if method == 'GET' and '?' not in url:
        return {'server': server(int(url.split('/')[-1]), expiry='999')}
    return api(method, url, body)
calls.clear()
assert m.cleanup(changed, delete=True, now=200, out=out.append) == 0
assert not any(method == 'DELETE' for method, _ in calls)
# A failed delete must not prevent the independent cleanup of the remaining servers.
def failure(method, url, body=None):
    if method == 'DELETE' and url == '/servers/1':
        raise m._snapshot.BuildError('simulated failure')
    return api(method, url, body)
calls.clear()
assert m.cleanup(failure, delete=True, now=200, out=out.append) == 1
assert ('DELETE', '/servers/2') in calls
# A malformed or cyclic listing fails closed before any mutation.
def broken(method, url, body=None):
    assert method == 'GET'
    return {'servers': [server(1)], 'meta': {'pagination': {'next_page': 1}}}
try:
    m.cleanup(broken, delete=True, now=200)
    raise AssertionError('expected pagination rejection')
except m._snapshot.BuildError:
    pass
# The token can come from the app's cloud settings instead of a token file.
import json, os, tempfile
folder = tempfile.mkdtemp()
def settings(content):
    target = os.path.join(folder, 'settings.json')
    with open(target, 'w') as handle:
        handle.write(content)
    return target
assert m.read_settings_token(settings(json.dumps({'enabled': True, 'token': ' ' + 'a' * 64 + '\n'}))) == 'a' * 64
for bad in ('{"token": "short"}', '{"token": 5}', '[]', 'not json', '{}'):
    try:
        m.read_settings_token(settings(bad))
        raise AssertionError('expected rejection of ' + bad)
    except m._snapshot.BuildError as err:
        assert 'a' * 20 not in str(err)
try:
    m.read_settings_token(os.path.join(folder, 'missing.json'))
    raise AssertionError('expected missing file')
except m._snapshot.BuildError:
    pass
print('cleanup fake API: ok')
`;
const result = spawnSync('python3', ['-B', '-c', harness, path.resolve(__dirname, '../render-node/cloud-cleanup.py')], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.match(result.stdout, /cleanup fake API: ok/);
console.log('test-cloud-cleanup.js: ok');
