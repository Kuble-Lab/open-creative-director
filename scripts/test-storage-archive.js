'use strict';

// Dropbox as an archive of the storage overview (lib/dropbox-archive.js, lib/storage-overview.js). No network: a small
// Dropbox in memory answers the calls.
//   - connecting with a code (PKCE, no secret), the token never reaches the page
//   - a file goes to the Dropbox, is checked there and only then leaves the server; the ledger entry stays, marked
//   - fetching back restores the same bytes and removes the copy; a damaged copy stays in the archive
//   - admins only; a failed upload leaves the file on the server

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsp = fs.promises;
const { PATHS } = require('../lib/config');
const store = require('../lib/store');
const access = require('../lib/access');
const { createStorageOverview, StorageError } = require('../lib/storage-overview');
const { createDropboxArchive, createContentHasher, ArchiveError, HASH_BLOCK, UPLOAD_CHUNK } = require('../lib/dropbox-archive');
const page = require('../public/storage.js');

const ADMIN = { active: true, email: 'admin@example.com', identified: true, admin: true, superadmin: false, kind: 'admin', teamIds: [] };
const ALICE = { active: true, email: `carol-${crypto.randomBytes(4).toString('hex')}@example.com`, identified: true, admin: false, superadmin: false, kind: 'internal', teamIds: [] };

function hashOf(buffer) {
  const hasher = createContentHasher();
  hasher.update(buffer);
  return hasher.digest();
}

// The Dropbox of the test: files in a Map, the calls the archive makes.
function fakeDropbox() {
  const files = new Map();
  const sessions = new Map();
  const calls = [];
  const state = { challenge: null, token: 'at-1', refreshes: 0, failUploads: false, corruptDownloads: false, expireOnce: false };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const meta = (name, data) => ({ path_display: name, size: data.length, content_hash: hashOf(data) });
  async function fetchImpl(url, options = {}) {
    const address = new URL(url);
    calls.push(address.pathname);
    if (address.pathname === '/oauth2/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_id'), 'appkey1234567890');
      assert.equal(form.get('client_secret'), null, 'no secret is ever sent');
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url');
        if (form.get('code') !== 'good-code' || challenge !== state.challenge) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: state.token, refresh_token: 'refresh-secret', expires_in: 14400 });
      }
      if (form.get('refresh_token') !== 'refresh-secret') return json({ error: 'invalid_grant' }, 400);
      state.refreshes += 1;
      state.token = `at-${state.refreshes + 1}`;
      return json({ access_token: state.token, expires_in: 14400 });
    }
    if (state.expireOnce) {
      state.expireOnce = false;
      state.token = 'rotated';
      return json({ error_summary: 'expired_access_token/' }, 401);
    }
    if (options.headers.Authorization !== `Bearer ${state.token}`) return json({ error_summary: 'invalid_access_token/' }, 401);
    const arg = options.headers['Dropbox-API-Arg'] ? JSON.parse(options.headers['Dropbox-API-Arg']) : JSON.parse(options.body || 'null');
    assert.ok(!options.headers['Dropbox-API-Arg'] || /^[\x20-\x7e]*$/.test(options.headers['Dropbox-API-Arg']), 'the header is plain ASCII');
    const body = Buffer.isBuffer(options.body) ? options.body : Buffer.alloc(0);
    switch (address.pathname) {
      case '/2/users/get_current_account':
        return json({ email: 'gu@example.com' });
      case '/2/users/get_space_usage':
        return json({ used: 100, allocation: { allocated: 1000 } });
      case '/2/files/upload':
        if (state.failUploads) return json({ error_summary: 'path/insufficient_space/..' }, 409);
        files.set(arg.path, Buffer.from(body));
        return json(meta(arg.path, body));
      case '/2/files/upload_session/start':
        sessions.set('s1', []);
        return json({ session_id: 's1' });
      case '/2/files/upload_session/append_v2':
        assert.equal(arg.cursor.offset, Buffer.concat(sessions.get(arg.cursor.session_id)).length);
        sessions.get(arg.cursor.session_id).push(Buffer.from(body));
        return json(null);
      case '/2/files/upload_session/finish': {
        const data = Buffer.concat([...sessions.get(arg.cursor.session_id), body]);
        assert.equal(arg.cursor.offset, data.length - body.length);
        files.set(arg.commit.path, data);
        return json(meta(arg.commit.path, data));
      }
      case '/2/files/download': {
        if (!files.has(arg.path)) return json({ error_summary: 'path/not_found/..' }, 409);
        const data = Buffer.from(files.get(arg.path));
        if (state.corruptDownloads) data[0] ^= 0xff;
        return new Response(data, { status: 200 });
      }
      case '/2/files/delete_v2':
        if (!files.delete(arg.path)) return json({ error_summary: 'path_lookup/not_found/..' }, 409);
        return json({});
      default:
        return json({ error_summary: 'unknown' }, 400);
    }
  }
  return { fetchImpl, files, calls, state };
}

async function main() {
  store.ensureDirs();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-archive-'));
  const tokenFile = path.join(tmp, 'dropbox-archive.json');
  const dropbox = fakeDropbox();
  const archive = createDropboxArchive({ file: tokenFile, fetchImpl: dropbox.fetchImpl });

  /* ---------- content hash ---------- */
  const sample = crypto.randomBytes(HASH_BLOCK + 1234);
  const expected = crypto
    .createHash('sha256')
    .update(Buffer.concat([crypto.createHash('sha256').update(sample.subarray(0, HASH_BLOCK)).digest(), crypto.createHash('sha256').update(sample.subarray(HASH_BLOCK)).digest()]))
    .digest('hex');
  assert.equal(hashOf(sample), expected);
  const pieces = createContentHasher();
  for (let offset = 0; offset < sample.length; offset += 70001) pieces.update(sample.subarray(offset, offset + 70001));
  assert.equal(pieces.digest(), expected, 'the hash does not depend on how the bytes arrive');
  assert.equal(hashOf(Buffer.alloc(0)), crypto.createHash('sha256').update('').digest('hex'));

  /* ---------- connecting ---------- */
  assert.deepEqual(archive.status(), { connected: false, account: null, connectedAt: null });
  assert.throws(() => archive.startConnect('no key!'), (err) => err instanceof ArchiveError && err.code === 'INVALID_APP_KEY' && err.status === 400);
  await assert.rejects(archive.finishConnect('good-code'), (err) => err.code === 'NO_PENDING');
  await assert.rejects(archive.upload(__filename, '/x'), (err) => err.code === 'NOT_CONNECTED');
  const { url } = archive.startConnect('appkey1234567890');
  const authorize = new URL(url);
  assert.equal(authorize.origin + authorize.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'appkey1234567890');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('token_access_type'), 'offline');
  assert.equal(authorize.searchParams.get('redirect_uri'), null, 'Dropbox shows the code itself');
  dropbox.state.challenge = authorize.searchParams.get('code_challenge');
  await assert.rejects(archive.finishConnect('wrong'), (err) => err.code === 'DROPBOX_GRANT' && err.status === 400);
  const status = await archive.finishConnect('good-code');
  assert.equal(status.connected, true);
  assert.equal(status.account, 'gu@example.com');
  assert.ok(!JSON.stringify(status).includes('refresh-secret'), 'the token never reaches the page');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'the token file is private');
  assert.deepEqual(await archive.space(), { used: 100, total: 1000, free: 900 });
  // a second instance reads the stored connection and gets its own access token
  const again = createDropboxArchive({ file: tokenFile, fetchImpl: dropbox.fetchImpl });
  assert.equal(again.status().connected, true);
  assert.deepEqual(await again.space(), { used: 100, total: 1000, free: 900 });
  assert.equal(dropbox.state.refreshes, 1);

  /* ---------- storage: archive and back ---------- */
  const storage = createStorageOverview({ store, access, assetsDir: PATHS.assetsDir, archive: again, statfs: async () => ({ bsize: 4096, blocks: 10000000, bavail: 5000000 }) });
  const chat = await store.createSession({ title: 'Alice Film', owner: ALICE.email });
  const bigBytes = crypto.randomBytes(UPLOAD_CHUNK + HASH_BLOCK + 99);
  const big = await store.saveAsset(chat.id, { kind: 'video', buffer: bigBytes, ext: '.mp4', prompt: 'gross' });
  const smallBytes = crypto.randomBytes(5000);
  const small = await store.saveAsset(chat.id, { kind: 'video', buffer: smallBytes, ext: '.mp4', prompt: 'klein' });
  const fileOf = (asset) => path.join(PATHS.assetsDir, chat.id, asset.file);
  await fsp.mkdir(path.join(PATHS.assetsDir, chat.id, 'scratch'), { recursive: true });
  await fsp.writeFile(path.join(PATHS.assetsDir, chat.id, 'scratch', 'loose.wav'), Buffer.alloc(10));

  const info = (await storage.overview({ viewer: ADMIN, scope: 'all' })).archive;
  assert.deepEqual({ available: info.available, canUse: info.canUse, connected: info.connected, account: info.account }, { available: true, canUse: true, connected: true, account: 'gu@example.com' });
  assert.deepEqual(info.space, { used: 100, total: 1000, free: 900 });
  assert.deepEqual((await storage.overview({ viewer: ALICE })).archive, { available: true, canUse: false, connected: true }, 'others do not learn whose Dropbox it is');

  // admins only
  await assert.rejects(storage.archive({ viewer: ALICE, items: [{ sessionId: chat.id, file: big.file }] }), (err) => err instanceof StorageError && err.status === 403);
  await assert.rejects(storage.restore({ viewer: ALICE, items: [{ sessionId: chat.id, file: big.file }] }), (err) => err.status === 403);

  const started = await storage.archive({
    viewer: ADMIN,
    items: [
      { sessionId: chat.id, file: big.file },
      { sessionId: chat.id, file: small.file },
      { sessionId: chat.id, file: 'scratch/loose.wav' },
      { sessionId: chat.id, file: 'ledger.json' },
      { sessionId: chat.id, file: '../x.mp4' }
    ]
  });
  assert.deepEqual(started.queued, [{ sessionId: chat.id, file: big.file }, { sessionId: chat.id, file: small.file }]);
  assert.deepEqual(started.failed.map((item) => item.code), ['NOT_ARCHIVABLE', 'NOT_FOUND', 'NOT_FOUND']);
  // while it works: the state is in the overview, a second start and a delete are refused
  const during = await storage.overview({ viewer: ADMIN, scope: 'all' });
  assert.ok(['queued', 'archiving'].includes(during.files.find((file) => file.sessionId === chat.id && file.file === big.file).job));
  assert.equal((await storage.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: big.file }] })).failed[0].code, 'BUSY');
  assert.equal((await storage.remove({ viewer: ADMIN, items: [{ sessionId: chat.id, file: small.file }] })).failed[0].code, 'BUSY');
  await storage.whenIdle();

  const remoteBig = `/${ALICE.email}/${chat.id}/${big.file}`;
  assert.ok(dropbox.files.get(remoteBig).equals(bigBytes), 'the large file arrived complete (upload session)');
  assert.ok(dropbox.calls.includes('/2/files/upload_session/append_v2'));
  assert.ok(dropbox.files.get(`/${ALICE.email}/${chat.id}/${small.file}`).equals(smallBytes));
  assert.ok(!fs.existsSync(fileOf(big)) && !fs.existsSync(fileOf(small)), 'the files left the server');
  let ledger = await store.readLedger(chat.id);
  const mark = ledger.find((entry) => entry.id === big.id).archived;
  assert.deepEqual({ provider: mark.provider, path: mark.path, size: mark.size, contentHash: mark.contentHash }, { provider: 'dropbox', path: remoteBig, size: bigBytes.length, contentHash: hashOf(bigBytes) });

  const after = await storage.overview({ viewer: ALICE });
  const row = after.files.find((file) => file.sessionId === chat.id && file.file === big.file);
  assert.equal(row.archived, true);
  assert.equal(row.size, bigBytes.length);
  assert.equal(row.url, undefined, 'nothing to download from the server');
  assert.equal(row.job, undefined);
  assert.equal(after.totals.archivedFiles, 2);
  assert.equal(after.totals.archivedBytes, bigBytes.length + 5000);
  assert.equal(after.totals.byType.video.bytes, 0, 'archived files take no room on the server');
  assert.equal(after.totals.files, 1);
  assert.deepEqual(page.visibleFiles(after.files, new Map(), { place: 'archive' }).map((file) => file.file).sort(), [big.file, small.file].sort());
  assert.deepEqual(page.visibleFiles(after.files, new Map(), { place: 'server' }).map((file) => file.file), ['scratch/loose.wav']);

  // the owner cannot delete what is in the archive, and archiving twice is refused
  assert.equal((await storage.remove({ viewer: ALICE, items: [{ sessionId: chat.id, file: small.file }] })).failed[0].code, 'FORBIDDEN');
  assert.equal((await storage.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: big.file }] })).failed[0].code, 'NOT_FOUND');
  assert.equal((await storage.restore({ viewer: ADMIN, items: [{ sessionId: chat.id, file: 'scratch/loose.wav' }] })).failed[0].code, 'NOT_ARCHIVABLE');

  // a damaged copy is not taken back: it stays in the archive and the row shows why
  dropbox.state.corruptDownloads = true;
  await storage.restore({ viewer: ADMIN, items: [{ sessionId: chat.id, file: big.file }] });
  await storage.whenIdle();
  const damaged = (await storage.overview({ viewer: ADMIN, scope: 'all' })).files.find((file) => file.sessionId === chat.id && file.file === big.file);
  assert.equal(damaged.job, 'error');
  assert.match(damaged.jobError, /bleibt im Archiv/);
  assert.ok(!fs.existsSync(fileOf(big)));
  assert.ok(dropbox.files.has(remoteBig));
  assert.deepEqual((await fsp.readdir(path.join(PATHS.assetsDir, chat.id))).filter((name) => name.endsWith('.tmp')), [], 'no half file is left behind');
  dropbox.state.corruptDownloads = false;

  // back to the server, also when the access token ran out in between
  dropbox.state.expireOnce = true;
  const back = await storage.restore({ viewer: ADMIN, items: [{ sessionId: chat.id, file: big.file }] });
  assert.equal(back.queued.length, 1);
  await storage.whenIdle();
  assert.ok((await fsp.readFile(fileOf(big))).equals(bigBytes), 'the same bytes are back');
  assert.ok(!dropbox.files.has(remoteBig), 'the copy in the Dropbox is gone');
  ledger = await store.readLedger(chat.id);
  assert.equal(ledger.find((entry) => entry.id === big.id).archived, undefined);
  assert.equal((await storage.restore({ viewer: ADMIN, items: [{ sessionId: chat.id, file: big.file }] })).failed[0].code, 'NOT_ARCHIVED');

  // an upload Dropbox refuses leaves the file on the server
  dropbox.state.failUploads = true;
  const third = await store.saveAsset(chat.id, { kind: 'video', buffer: Buffer.alloc(3000, 3), ext: '.mp4', prompt: '' });
  await storage.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: third.file }] });
  await storage.whenIdle();
  const full = (await storage.overview({ viewer: ADMIN, scope: 'all' })).files.find((file) => file.sessionId === chat.id && file.file === third.file);
  assert.equal(full.job, 'error');
  assert.match(full.jobError, /nicht genug Platz/);
  assert.ok(fs.existsSync(fileOf(third)));
  assert.equal((await store.readLedger(chat.id)).find((entry) => entry.id === third.id).archived, undefined);
  dropbox.state.failUploads = false;

  // an open job of the chat keeps its files on the server
  await store.mutateSession(chat.id, (session) => {
    session.jobs.push({ id: 'job-1', status: 'running' });
  });
  await storage.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: third.file }] });
  await storage.whenIdle();
  assert.ok(fs.existsSync(fileOf(third)));
  await store.mutateSession(chat.id, (session) => {
    session.jobs = [];
  });

  // deleting an archived file removes the copy and the ledger entry
  const gone = await storage.remove({ viewer: ADMIN, items: [{ sessionId: chat.id, file: small.file }] });
  assert.equal(gone.deleted.length, 1);
  assert.equal(dropbox.files.size, 0);
  assert.ok(!(await store.readLedger(chat.id)).some((entry) => entry.id === small.id));

  // without a connection nothing is queued, and an installation without an archive says so
  again.disconnect();
  assert.equal(again.status().connected, false);
  assert.ok(!fs.readFileSync(tokenFile, 'utf8').includes('refresh-secret'));
  await assert.rejects(storage.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: third.file }] }), (err) => err.code === 'NOT_CONNECTED' && err.status === 409);
  const plain = createStorageOverview({ store, access, assetsDir: PATHS.assetsDir });
  assert.deepEqual((await plain.overview({ viewer: ADMIN })).archive, { available: false, canUse: false, connected: false });
  await assert.rejects(plain.archive({ viewer: ADMIN, items: [{ sessionId: chat.id, file: third.file }] }), (err) => err.code === 'NO_ARCHIVE');

  await store.deleteSession(chat.id);
  await fsp.rm(tmp, { recursive: true, force: true });
  console.log('test-storage-archive.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
