'use strict';

// Downloads from an address for upload_asset (lib/mcp/url-import.js), without network: DNS and the HTTPS transport are doubles.
//
//   A  addresses: https only, port 443, no user:password; Dropbox and Google Drive share links become download links
//   B  every host and every redirect hop must resolve to public addresses only; at most 5 redirects; the connection gets
//      exactly the checked addresses
//   C  the file: name from Content-Disposition, the address or the media type; a web page is refused; Content-Length over
//      the limit is refused before the body; a body over the limit stops; a stalled body times out
//   D  limits: two downloads per key at the same time; the state of a download (running, done, failed) only for its key

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { createUrlImporter, checkUrl, dispositionName, nameAndType } = require('../lib/mcp/url-import');
const { UploadError } = require('../lib/mcp/uploads');

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61)]);

function response(status, headers = {}, body = null, { stall = false } = {}) {
  const stream = new PassThrough();
  stream.statusCode = status;
  stream.headers = headers;
  if (body !== null && !stall) setImmediate(() => stream.end(body));
  else if (stall && body) setImmediate(() => stream.write(body));
  return stream;
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-url-import-'));
  const saved = [];
  // uploads double: the type rules of the real module are not under test here
  const uploads = {
    resolveType(name, type) {
      const ext = path.extname(name).toLowerCase();
      if (type === 'text/plain' || ext === '.txt') return { ext: '.txt' };
      if (!['.mp3', '.png', '.mp4', '.pdf'].includes(ext)) throw new UploadError('UNSUPPORTED_MEDIA', `Unsupported file type (${ext || type})`);
      return { ext };
    },
    limitFor: (resolved) => (resolved.ext === '.pdf' ? 100 : 1000),
    quotaFull: false,
    async checkQuota() {
      if (this.quotaFull) throw new UploadError('QUOTA_STORAGE', 'This key may keep 2048 MB of uploads');
    },
    async save({ filename, mimeType, write }) {
      const file = path.join(dir, `f${saved.length}-${path.basename(filename)}`);
      const bytes = await write(file, 1000);
      saved.push({ filename, mimeType, bytes, content: await fsp.readFile(file) });
      return { assetId: `upload-${String(saved.length).padStart(3, '0')}`, type: 'audio', bytes, rasterized: false };
    }
  };
  const dnsTable = {
    'cdn.example.com': [{ address: '93.184.216.34', family: 4 }],
    'redirect.example.com': [{ address: '93.184.216.35', family: 4 }],
    'inside.example.com': [{ address: '10.0.0.5', family: 4 }],
    'mixed.example.com': [{ address: '93.184.216.36', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'v6.example.com': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
    'metadata.example.com': [{ address: '169.254.169.254', family: 4 }],
    'www.dropbox.com': [{ address: '162.125.1.18', family: 4 }],
    'drive.usercontent.google.com': [{ address: '142.250.1.1', family: 4 }]
  };
  const lookups = [];
  const lookup = async (host) => {
    lookups.push(host);
    if (!dnsTable[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return dnsTable[host];
  };
  const routes = new Map();
  const requests = [];
  const transport = async (url, { addresses, headers }) => {
    requests.push({ url: url.toString(), addresses: addresses.map((item) => item.address), headers });
    const route = routes.get(url.toString());
    if (!route) return response(404, {}, '');
    return typeof route === 'function' ? route() : route;
  };
  const importer = createUrlImporter({ uploads, lookup, transport, limits: { idleMs: 200, headersMs: 500 } });
  const key = { id: 'k1' };
  const other = { id: 'k2' };
  const fetchFile = async (url, extra = {}) => {
    const started = await importer.start({ key, viewer: {}, url, ...extra });
    return started.done;
  };
  const refusedStart = async (url, pattern, extra = {}) => {
    await assert.rejects(() => fetchFile(url, extra), (err) => {
      assert.match(err.message, pattern);
      return true;
    });
  };

  /* A: addresses */
  assert.throws(() => checkUrl('http://cdn.example.com/a.mp3'), /Only https/);
  assert.throws(() => checkUrl('ftp://cdn.example.com/a.mp3'), /Only https/);
  assert.throws(() => checkUrl('https://u:p@cdn.example.com/a.mp3'), /user name or password/);
  assert.throws(() => checkUrl('https://cdn.example.com:444/a.mp3'), /port \(443\)/);
  assert.throws(() => checkUrl('https://cdn.example.com/a b.mp3'), /spaces or control/);
  assert.throws(() => checkUrl(`https://cdn.example.com/${'a'.repeat(2100)}`), /longer than 2048/);
  assert.throws(() => checkUrl('not a url'), /spaces|not a valid/);
  assert.equal(checkUrl('https://cdn.example.com:443/a.mp3#x').toString(), 'https://cdn.example.com/a.mp3');
  assert.equal(checkUrl('https://www.dropbox.com/scl/fi/abc/song.mp3?rlkey=xyz&dl=0').toString(), 'https://www.dropbox.com/scl/fi/abc/song.mp3?rlkey=xyz&dl=1');
  assert.equal(checkUrl('https://www.dropbox.com/s/abc/song.mp3').toString(), 'https://www.dropbox.com/s/abc/song.mp3?dl=1');
  assert.equal(checkUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing').toString(), 'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn&export=download&confirm=t');
  assert.equal(checkUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlMn').toString(), 'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn&export=download&confirm=t');

  /* B: hosts and redirects */
  await refusedStart('https://inside.example.com/a.mp3', /private or local network/);
  await refusedStart('https://mixed.example.com/a.mp3', /private or local network/);
  await refusedStart('https://metadata.example.com/latest/meta-data', /private or local network/);
  await refusedStart('https://10.1.2.3/a.mp3', /private or local network/);
  await refusedStart('https://[::ffff:127.0.0.1]/a.mp3', /private or local network/);
  await refusedStart('https://nowhere.example.com/a.mp3', /could not be found/);
  assert.equal(requests.length, 0, 'nothing is requested from a refused address');

  routes.set('https://cdn.example.com/song.mp3', () => response(200, { 'content-type': 'audio/mpeg', 'content-length': String(MP3.length) }, MP3));
  const song = await fetchFile('https://cdn.example.com/song.mp3');
  assert.equal(song.assetId, 'upload-001');
  assert.equal(song.filename, 'song.mp3');
  assert.equal(saved[0].bytes, MP3.length);
  assert.deepEqual(saved[0].content, MP3);
  assert.deepEqual(requests.at(-1).addresses, ['93.184.216.34'], 'the connection goes to the checked address');
  assert.match(requests.at(-1).headers['User-Agent'], /OpenCreativeDirector-Import/);

  // a redirect to a public host is followed; a redirect into the private network is refused at that hop
  routes.set('https://redirect.example.com/go', () => response(302, { location: 'https://cdn.example.com/song.mp3' }));
  await fetchFile('https://redirect.example.com/go', { filename: 'mine.mp3' });
  assert.equal(saved.at(-1).filename, 'mine.mp3', 'the name the agent gave wins');
  routes.set('https://redirect.example.com/inside', () => response(301, { location: 'https://inside.example.com/secret.mp3' }));
  const before = requests.length;
  await refusedStart('https://redirect.example.com/inside', /private or local network/);
  assert.equal(requests.length, before + 1, 'the private target is never contacted');
  routes.set('https://redirect.example.com/plain', () => response(302, { location: 'http://cdn.example.com/song.mp3' }));
  await refusedStart('https://redirect.example.com/plain', /non-https/);
  routes.set('https://redirect.example.com/loop', () => response(302, { location: '/loop' }));
  await refusedStart('https://redirect.example.com/loop', /more than 5 times/);
  routes.set('https://cdn.example.com/private.mp3', () => response(403, {}, ''));
  await refusedStart('https://cdn.example.com/private.mp3', /HTTP 403.*not public/);
  routes.set('https://v6.example.com/a.mp3', () => response(200, { 'content-type': 'audio/mpeg' }, MP3));
  assert.equal((await fetchFile('https://v6.example.com/a.mp3')).filename, 'a.mp3', 'a public IPv6 address is fine');

  /* C: the file */
  assert.equal(dispositionName('attachment; filename="Where Are We From.mp3"'), 'Where Are We From.mp3');
  assert.equal(dispositionName("attachment; filename=x.mp3; filename*=UTF-8''Gr%C3%BCezi.mp3"), 'Grüezi.mp3');
  assert.equal(dispositionName(''), null);
  assert.deepEqual(nameAndType({ url: new URL('https://cdn.example.com/abc'), headers: { 'content-type': 'audio/mpeg' } }), { name: 'abc.mp3', type: '' });
  assert.deepEqual(nameAndType({ url: new URL('https://cdn.example.com/a.mp3'), headers: { 'content-type': 'text/plain' } }), { name: 'a.mp3', type: '' }, 'a known extension wins over a wrong media type');
  assert.deepEqual(nameAndType({ filename: 'x.png', mimeType: 'image/png', url: new URL('https://cdn.example.com/a'), headers: {} }), { name: 'x.png', type: 'image/png' });

  routes.set('https://cdn.example.com/dl?id=7', () => response(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Where Are We From.mp3"' }, MP3));
  assert.equal((await fetchFile('https://cdn.example.com/dl?id=7')).filename, 'Where Are We From.mp3');
  routes.set('https://cdn.example.com/page', () => response(200, { 'content-type': 'text/html; charset=utf-8' }, '<html></html>'));
  await refusedStart('https://cdn.example.com/page', /web page, not a file/);
  routes.set('https://cdn.example.com/big.mp3', () => response(200, { 'content-type': 'audio/mpeg', 'content-length': '5000' }, Buffer.alloc(5000)));
  await refusedStart('https://cdn.example.com/big.mp3', /more than the 0 MB|more than/);
  routes.set('https://cdn.example.com/huge.mp3', () => response(200, { 'content-type': 'audio/mpeg' }, Buffer.concat([MP3, Buffer.alloc(2000)])));
  await refusedStart('https://cdn.example.com/huge.mp3', /larger than/);
  routes.set('https://cdn.example.com/slow.mp3', () => response(200, { 'content-type': 'audio/mpeg' }, MP3.subarray(0, 10), { stall: true }));
  await refusedStart('https://cdn.example.com/slow.mp3', /stalled/);
  routes.set('https://cdn.example.com/file.exe', () => response(200, { 'content-type': 'application/octet-stream' }, Buffer.from('MZ')));
  await refusedStart('https://cdn.example.com/file.exe', /Unsupported file type/);
  routes.set('https://www.dropbox.com/scl/fi/abc/song.mp3?rlkey=xyz&dl=1', () => response(200, { 'content-type': 'audio/mpeg' }, MP3));
  assert.equal((await fetchFile('https://www.dropbox.com/scl/fi/abc/song.mp3?rlkey=xyz&dl=0')).filename, 'song.mp3');

  /* D: limits and state */
  uploads.quotaFull = true;
  await refusedStart('https://cdn.example.com/song.mp3', /2048 MB/);
  uploads.quotaFull = false;
  const release = [];
  routes.set('https://cdn.example.com/wait.mp3', () => {
    const stream = response(200, { 'content-type': 'audio/mpeg' }, null);
    release.push(() => stream.end(MP3));
    return stream;
  });
  const slowImporter = createUrlImporter({ uploads, lookup, transport, limits: { idleMs: 5000 } });
  const first = await slowImporter.start({ key, viewer: {}, url: 'https://cdn.example.com/wait.mp3' });
  const second = await slowImporter.start({ key, viewer: {}, url: 'https://cdn.example.com/wait.mp3' });
  await assert.rejects(() => slowImporter.start({ key, viewer: {}, url: 'https://cdn.example.com/wait.mp3' }), /already fetching 2 files/);
  const third = await slowImporter.start({ key: other, viewer: {}, url: 'https://cdn.example.com/wait.mp3' });
  assert.equal(slowImporter.status('k1', first.id).state, 'running');
  assert.equal(slowImporter.status('k2', first.id), null, 'another key does not see the download');
  assert.equal(slowImporter.status('k1', 'imp_unknown'), null);
  while (release.length < 3) await new Promise((resolve) => setImmediate(resolve));
  release.forEach((fn) => fn());
  await Promise.all([first.done, second.done, third.done]);
  assert.equal(slowImporter.status('k1', first.id).state, 'done');
  assert.equal(slowImporter.status('k1', first.id).result.filename, 'wait.mp3');
  const fourth = await slowImporter.start({ key, viewer: {}, url: 'https://cdn.example.com/private.mp3' });
  await assert.rejects(() => fourth.done);
  assert.equal(slowImporter.status('k1', fourth.id).state, 'failed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('URL-Import: Adressen, öffentliche Ziele, Weiterleitungen, Dateiname, Grenzen und Zustand sind korrekt.');
  console.log('test-mcp-url-import.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
