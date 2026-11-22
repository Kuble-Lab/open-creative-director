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
const noteUi = require('../public/archived-media.js');

const ADMIN = { active: true, email: 'admin@example.com', identified: true, admin: true, superadmin: false, kind: 'admin', teamIds: [] };
const BOB = { active: true, email: `dave-${crypto.randomBytes(4).toString('hex')}@example.com`, identified: true, admin: false, superadmin: false, kind: 'internal', teamIds: [] };
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

  /* ---------- the note in the app (public/archived-media.js) and the rows of whole chats ---------- */
  assert.deepEqual(noteUi.assetRef('/sub/assets/abc-1/a/b%20c.mp4?r=1'), { sessionId: 'abc-1', file: 'a/b c.mp4' });
  assert.deepEqual(noteUi.assetRef('assets/abc/vid-1.mp4', 'https://example.com/app/'), { sessionId: 'abc', file: 'vid-1.mp4' });
  assert.equal(noteUi.assetRef('/api/storage'), null);
  assert.equal(noteUi.assetRef('/assets/abc/%E0%A4%A'), null, 'a path that cannot be decoded');
  assert.equal(noteUi.noteModel({ archived: false }), null);
  assert.deepEqual(noteUi.noteModel({ archived: true, canRestore: true, others: { files: 2, bytes: 5 } }), { text: 'archived.note', vars: {}, restore: true, all: true, working: false });
  assert.equal(noteUi.noteModel({ archived: true, canRestore: false }).restore, false);
  assert.deepEqual(noteUi.noteModel({ archived: true, job: 'restoring', jobProgress: 40, canRestore: true }), { text: 'archived.workingShare', vars: { share: 40 }, restore: false, all: false, working: true });
  assert.equal(noteUi.noteModel({ archived: true, job: 'error', jobError: 'x', canRestore: true }).restore, true);
  assert.deepEqual(
    page.sessionRows([{ id: 'a', bytes: 5, files: 1, archivedBytes: 0, archivedFiles: 0 }, { id: 'b', bytes: 1, files: 0, archivedBytes: 90, archivedFiles: 2 }, { id: 'c', bytes: 700, files: 0, archivedBytes: 0, archivedFiles: 0 }]).map((row) => row.id),
    ['b', 'a'],
    'largest first, nothing without files'
  );
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
  // the way back is open to the owner, but this file is not in the archive
  assert.equal((await storage.restore({ viewer: ALICE, items: [{ sessionId: chat.id, file: big.file }] })).failed[0].code, 'NOT_ARCHIVED');

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

  /* ---------- whole chats, the way back for everybody who may use the chat, the note in the app ---------- */
  const whole = await storage.archive({ viewer: ADMIN, sessions: [chat.id, 'no-such-chat'] });
  assert.deepEqual(whole.queued.map((item) => item.file).sort(), [big.file, third.file].sort(), 'every finished file of the chat, nothing loose');
  assert.deepEqual(whole.failed, []);
  await storage.whenIdle();
  assert.ok(!fs.existsSync(fileOf(big)) && !fs.existsSync(fileOf(third)));
  assert.ok(fs.existsSync(path.join(PATHS.assetsDir, chat.id, 'scratch', 'loose.wav')));
  const chatRow = (await storage.overview({ viewer: ADMIN, scope: 'all' })).sessions.find((session) => session.id === chat.id);
  assert.deepEqual({ archivable: chatRow.archivable, archivedFiles: chatRow.archivedFiles, archivedBytes: chatRow.archivedBytes }, { archivable: 0, archivedFiles: 2, archivedBytes: bigBytes.length + 3000 });
  await assert.rejects(storage.archive({ viewer: ADMIN, sessions: [chat.id] }), (err) => err.code === 'INVALID', 'nothing left to archive');

  const note = await storage.archivedState({ viewer: ALICE, sessionId: chat.id, file: big.file });
  assert.deepEqual(note, { archived: true, size: bigBytes.length, canRestore: true, others: { files: 1, bytes: 3000 } });
  assert.equal((await storage.archivedState({ viewer: ALICE, sessionId: chat.id, file: 'scratch/loose.wav' })).archived, false);
  await assert.rejects(storage.archivedState({ viewer: BOB, sessionId: chat.id, file: big.file }), (err) => err.status === 404, 'a stranger learns nothing');
  await assert.rejects(storage.archivedState({ viewer: ALICE, sessionId: chat.id, file: '../x' }), (err) => err.status === 404);

  // a stranger fetches nothing back; the owner does, one file or the whole chat
  await assert.rejects(storage.restore({ viewer: BOB, sessions: [chat.id] }), (err) => err.code === 'INVALID');
  assert.equal((await storage.restore({ viewer: BOB, items: [{ sessionId: chat.id, file: big.file }] })).failed[0].code, 'NOT_FOUND');
  await assert.rejects(storage.archive({ viewer: ALICE, sessions: [chat.id] }), (err) => err.status === 403, 'into the archive: admins only');
  const one = await storage.restore({ viewer: ALICE, items: [{ sessionId: chat.id, file: big.file }] });
  assert.equal(one.queued.length, 1);
  assert.deepEqual((await storage.restore({ viewer: ALICE, items: [{ sessionId: chat.id, file: big.file }] })).failed, [], 'asked twice: already on its way');
  assert.ok(['queued', 'restoring'].includes((await storage.archivedState({ viewer: ALICE, sessionId: chat.id, file: big.file })).job));
  await storage.whenIdle();
  assert.ok((await fsp.readFile(fileOf(big))).equals(bigBytes));
  assert.equal((await storage.archivedState({ viewer: ALICE, sessionId: chat.id, file: big.file })).archived, false);
  const rest = await storage.restore({ viewer: ALICE, sessions: [chat.id] });
  assert.deepEqual(rest.queued, [{ sessionId: chat.id, file: third.file }]);
  await storage.whenIdle();
  assert.ok(fs.existsSync(fileOf(third)));
  assert.equal(dropbox.files.size, 0);

  /* ---------- automatic: large old videos ---------- */
  const autoFile = path.join(tmp, 'auto.json');
  const auto = createStorageOverview({ store, access, assetsDir: PATHS.assetsDir, archive: again, autoFile });
  assert.deepEqual((await auto.overview({ viewer: ADMIN, scope: 'all' })).archive.auto, { enabled: false, minMb: 200, minDays: 30, lastRunAt: null, lastQueued: 0 });
  assert.deepEqual(await auto.runAuto({ sessions: [chat.id] }), { queued: 0, skipped: 'off' });
  await assert.rejects(auto.setAuto({ viewer: ALICE, settings: { enabled: true } }), (err) => err.status === 403);
  await assert.rejects(auto.setAuto({ viewer: ADMIN, settings: { minMb: 0 } }), (err) => err.code === 'INVALID');
  await assert.rejects(storage.setAuto({ viewer: ADMIN, settings: { enabled: true } }), (err) => err.code === 'NO_ARCHIVE');
  const set = await auto.setAuto({ viewer: ADMIN, settings: { enabled: true, minMb: 1 } });
  assert.deepEqual({ enabled: set.enabled, minMb: set.minMb, minDays: set.minDays }, { enabled: true, minMb: 1, minDays: 30 });
  const twoMb = Buffer.alloc(2 * 1024 * 1024, 7);
  const oldVideo = await store.saveAsset(chat.id, { kind: 'video', buffer: twoMb, ext: '.mp4', prompt: 'alt und gross' });
  const youngVideo = await store.saveAsset(chat.id, { kind: 'video', buffer: twoMb, ext: '.mp4', prompt: 'neu und gross' });
  const oldSmall = await store.saveAsset(chat.id, { kind: 'video', buffer: Buffer.alloc(4000, 1), ext: '.mp4', prompt: 'alt und klein' });
  const oldImage = await store.saveAsset(chat.id, { kind: 'image', buffer: twoMb, ext: '.png', prompt: 'altes Bild' });
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const asset of [oldVideo, oldSmall, oldImage]) await fsp.utimes(fileOf(asset), longAgo, longAgo);
  assert.deepEqual(await auto.runAuto({ sessions: [chat.id] }), { queued: 1 });
  await auto.whenIdle();
  assert.ok(!fs.existsSync(fileOf(oldVideo)), 'the large old video went into the archive');
  assert.ok(fs.existsSync(fileOf(youngVideo)) && fs.existsSync(fileOf(oldSmall)) && fs.existsSync(fileOf(oldImage)) && fs.existsSync(fileOf(big)));
  assert.equal(dropbox.files.size, 1);
  assert.deepEqual(await auto.runAuto({ sessions: [chat.id] }), { queued: 0 });
  assert.equal((await auto.overview({ viewer: ADMIN, scope: 'all' })).archive.auto.lastQueued, 0);
  // a chat with an open job waits
  await fsp.utimes(fileOf(youngVideo), longAgo, longAgo);
  await store.mutateSession(chat.id, (session) => {
    session.jobs.push({ id: 'job-2', status: 'running' });
  });
  assert.deepEqual(await auto.runAuto({ sessions: [chat.id] }), { queued: 0 });
  await store.mutateSession(chat.id, (session) => {
    session.jobs = [];
  });
  await auto.setAuto({ viewer: ADMIN, settings: { enabled: false } });
  assert.deepEqual(await auto.runAuto({ sessions: [chat.id] }), { queued: 0, skipped: 'off' });
  await auto.restore({ viewer: ALICE, sessions: [chat.id] });
  await auto.whenIdle();
  assert.ok(fs.existsSync(fileOf(oldVideo)));

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
