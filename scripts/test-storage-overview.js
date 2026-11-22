'use strict';

// Storage overview (lib/storage-overview.js) and its page helpers (public/storage.js).
//   - everybody sees the files of their own chats and workflows, admins and the local mode may ask for everything
//   - sizes, totals per type and per person, the room left on the disk
//   - deleting: own files only (admins: all), through the ledger, never the files of the app, never while a job runs
//   - no path leaves the asset folder of a session

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;
const { PATHS } = require('../lib/config');
const store = require('../lib/store');
const access = require('../lib/access');
const { createStorageOverview, StorageError, typeOfFile, cleanRelativeFile, MAX_DELETE_ITEMS } = require('../lib/storage-overview');
const page = require('../public/storage.js');

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const viewer = (email, admin = false) => ({ active: true, email, identified: Boolean(email), admin, superadmin: false, kind: admin ? 'admin' : 'internal', teamIds: [] });
const LOCAL = { active: false, email: null, identified: false, admin: true, superadmin: false };

async function rejects(promise, code, status) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof StorageError, `StorageError expected, got ${err.message}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return true;
  });
}

async function main() {
  store.ensureDirs();
  let busySession = null;
  let clock = Date.now();
  const storage = createStorageOverview({
    store,
    access,
    assetsDir: PATHS.assetsDir,
    statfs: async () => ({ bsize: 4096, blocks: 1000000, bavail: 250000 }),
    isSessionBusy: async (id) => id === busySession,
    now: () => clock
  });

  const aliceChat = await store.createSession({ title: 'Alice Film', owner: ALICE });
  const aliceFlow = await store.createSession({ title: 'Workflow: Spot', kind: 'workflow', owner: ALICE });
  const bobChat = await store.createSession({ title: 'Bob Film', owner: BOB });
  const big = await store.saveAsset(aliceChat.id, { kind: 'video', buffer: Buffer.alloc(5000, 1), ext: '.mp4', prompt: 'Sonnenaufgang' });
  const small = await store.saveAsset(aliceChat.id, { kind: 'image', buffer: Buffer.alloc(300, 1), ext: '.jpg', prompt: 'Titelbild' });
  const flowVideo = await store.saveAsset(aliceFlow.id, { kind: 'video', buffer: Buffer.alloc(2000, 1), ext: '.mp4', prompt: '' });
  const bobVideo = await store.saveAsset(bobChat.id, { kind: 'video', buffer: Buffer.alloc(9000, 1), ext: '.mp4', prompt: '' });
  // a file the ledger does not know, in a sub-folder, and the pictures only the Director sees
  const scratch = path.join(PATHS.assetsDir, aliceChat.id, 'scratch-1');
  await fsp.mkdir(scratch, { recursive: true });
  await fsp.writeFile(path.join(scratch, 'part.wav'), Buffer.alloc(700, 1));
  await store.saveInlineImage(aliceChat.id, Buffer.alloc(400, 2));
  // an asset folder whose session file is gone
  const orphanDir = path.join(PATHS.assetsDir, 'orphan-1');
  await fsp.mkdir(orphanDir, { recursive: true });
  await fsp.writeFile(path.join(orphanDir, 'old.mp4'), Buffer.alloc(1200, 1));

  /* ---------- helpers ---------- */
  assert.equal(typeOfFile('a/b/clip.MP4'), 'video');
  assert.equal(typeOfFile('x.heic'), 'image');
  assert.equal(typeOfFile('x.bin'), 'other');
  assert.equal(cleanRelativeFile('a/b.mp4'), 'a/b.mp4');
  for (const bad of ['', '../x', 'a/../x', '/abs', 'a//b', 'a\\b', 'a/./b', 'x\0y', null, 5]) assert.equal(cleanRelativeFile(bad), null, String(bad));

  /* ---------- own files ---------- */
  const mine = await storage.overview({ viewer: viewer(ALICE) });
  assert.equal(mine.scope, 'mine');
  assert.equal(mine.canSeeAll, false);
  assert.equal(mine.accounts, true);
  assert.deepEqual(mine.files.map((file) => file.size), [5000, 2000, 700, 300], 'largest first');
  assert.deepEqual(mine.files.map((file) => file.sessionId === bobChat.id), [false, false, false, false], 'nothing of another person');
  assert.equal(mine.files[0].assetId, big.id);
  assert.equal(mine.files[0].prompt, 'Sonnenaufgang');
  assert.equal(mine.files[0].url, `/assets/${aliceChat.id}/${big.file}`);
  assert.equal(mine.files[2].file, 'scratch-1/part.wav');
  assert.equal(mine.files[2].url, `/assets/${aliceChat.id}/scratch-1/part.wav`);
  assert.equal(mine.files[2].assetId, undefined, 'a file without a ledger entry has no asset id');
  assert.ok(!mine.files.some((file) => /ledger\.json|asset-ids\.json|^inline\//.test(file.file)), 'files of the app are not listed');
  assert.equal(mine.totals.files, 4);
  assert.equal(mine.totals.byType.video.bytes, 7000);
  assert.equal(mine.totals.byType.video.files, 2);
  assert.equal(mine.totals.byType.image.bytes, 300);
  assert.equal(mine.totals.byType.audio.bytes, 700);
  assert.ok(mine.totals.otherBytes >= 400, 'the files of the app count into the total');
  assert.equal(mine.totals.bytes, 8000 + mine.totals.otherBytes);
  assert.deepEqual(mine.owners, [], 'the list per person is for the view of everything');
  assert.deepEqual(mine.disk, { total: 4096 * 1000000, free: 4096 * 250000, used: 4096 * 750000 });
  const flow = mine.sessions.find((session) => session.id === aliceFlow.id);
  assert.equal(flow.kind, 'workflow');
  assert.equal(flow.title, 'Workflow: Spot');
  assert.equal(flow.owner, ALICE);
  assert.equal(mine.sessions.find((session) => session.id === aliceChat.id).kind, 'chat');

  /* ---------- everything: admins and the local mode only ---------- */
  await rejects(storage.overview({ viewer: viewer(ALICE), scope: 'all' }), 'FORBIDDEN', 403);
  await rejects(storage.overview({ viewer: viewer(null) }), 'LOGIN_REQUIRED', 403);
  const all = await storage.overview({ viewer: viewer('admin@example.com', true), scope: 'all' });
  assert.equal(all.scope, 'all');
  assert.equal(all.canSeeAll, true);
  assert.equal(all.files[0].size, 9000);
  assert.equal(all.files.length, 6);
  const owners = Object.fromEntries(all.owners.map((entry) => [entry.owner || '-', entry]));
  assert.equal(owners[BOB].files, 1);
  assert.equal(owners[ALICE].files, 4);
  assert.equal(owners['-'].files, 1, 'the folder without a session has no owner');
  assert.ok(owners[BOB].bytes >= 9000);
  assert.equal(all.sessions.find((session) => session.id === 'orphan-1').kind, 'orphan');
  // an admin who asks for their own files gets only their own
  assert.equal((await storage.overview({ viewer: viewer('admin@example.com', true) })).files.length, 0);
  // local mode: no accounts, everything is the single user's
  const local = await storage.overview({ viewer: LOCAL });
  assert.equal(local.accounts, false);
  assert.equal(local.files.length, 6);

  /* ---------- delete ---------- */
  await rejects(storage.remove({ viewer: viewer(ALICE), items: [] }), 'INVALID', 400);
  await rejects(storage.remove({ viewer: viewer(ALICE), items: new Array(MAX_DELETE_ITEMS + 1).fill({ sessionId: aliceChat.id, file: big.file }) }), 'INVALID', 400);
  await rejects(storage.remove({ viewer: viewer(null), items: [{ sessionId: aliceChat.id, file: big.file }] }), 'LOGIN_REQUIRED', 403);

  // another person's file, the files of the app and paths that leave the folder: all the same "not found", nothing is touched
  const refused = await storage.remove({
    viewer: viewer(ALICE),
    items: [
      { sessionId: bobChat.id, file: bobVideo.file },
      { sessionId: 'orphan-1', file: 'old.mp4' },
      { sessionId: aliceChat.id, file: 'ledger.json' },
      { sessionId: aliceChat.id, file: 'asset-ids.json' },
      { sessionId: aliceChat.id, file: `../${bobChat.id}/${bobVideo.file}` },
      { sessionId: aliceChat.id, file: 'scratch-1' },
      { sessionId: aliceChat.id, file: 'missing.mp4' },
      { sessionId: '../x', file: 'a.mp4' },
      null
    ]
  });
  assert.equal(refused.deleted.length, 0);
  assert.equal(refused.freedBytes, 0);
  assert.deepEqual([...new Set(refused.failed.map((item) => item.code))], ['NOT_FOUND']);
  assert.ok(fs.existsSync(path.join(PATHS.assetsDir, bobChat.id, bobVideo.file)));
  assert.ok(fs.existsSync(path.join(PATHS.assetsDir, aliceChat.id, 'ledger.json')));

  // a link inside the folder that points outside is never followed
  const outside = path.join(PATHS.assetsDir, bobChat.id, bobVideo.file);
  await fsp.symlink(outside, path.join(PATHS.assetsDir, aliceChat.id, 'link.mp4'));
  const linked = await storage.remove({ viewer: viewer(ALICE), items: [{ sessionId: aliceChat.id, file: 'link.mp4' }] });
  assert.equal(linked.failed[0].code, 'NOT_FOUND');
  assert.ok(fs.existsSync(outside));
  assert.ok(!(await storage.overview({ viewer: viewer(ALICE) })).files.some((file) => file.file === 'link.mp4'), 'links are not listed');
  await fsp.rm(path.join(PATHS.assetsDir, aliceChat.id, 'link.mp4'));

  // a fresh file without a ledger entry may be the scratch of a running render
  const fresh = await storage.remove({ viewer: viewer(ALICE), items: [{ sessionId: aliceChat.id, file: 'scratch-1/part.wav' }] });
  assert.equal(fresh.failed[0].code, 'BUSY');
  clock += 11 * 60 * 1000;

  // an open job of the chat or an active run of the workflow blocks the delete
  await store.mutateSession(aliceChat.id, (session) => {
    session.jobs.push({ id: 'job-1', status: 'running' });
  });
  const open = await storage.remove({ viewer: viewer(ALICE), items: [{ sessionId: aliceChat.id, file: big.file }] });
  assert.equal(open.failed[0].code, 'BUSY');
  await store.mutateSession(aliceChat.id, (session) => {
    session.jobs = [];
  });
  busySession = aliceFlow.id;
  const running = await storage.remove({ viewer: viewer(ALICE), items: [{ sessionId: aliceFlow.id, file: flowVideo.file }] });
  assert.equal(running.failed[0].code, 'BUSY');
  busySession = null;

  // a reserved file nobody has finished stays
  const reserved = await store.reserveAsset(aliceChat.id, { kind: 'video', ext: '.mp4', prompt: '' });
  await fsp.writeFile(path.join(PATHS.assetsDir, aliceChat.id, reserved.file), Buffer.alloc(10, 1));
  assert.equal((await storage.overview({ viewer: viewer(ALICE) })).files.find((file) => file.file === reserved.file).pending, true);
  const pending = await storage.remove({ viewer: viewer(ALICE), items: [{ sessionId: aliceChat.id, file: reserved.file }] });
  assert.equal(pending.failed[0].code, 'BUSY');

  // the owner deletes: the file and its ledger entry go, the rest stays; one refused file does not stop the others
  const done = await storage.remove({
    viewer: viewer(ALICE),
    items: [
      { sessionId: aliceChat.id, file: big.file },
      { sessionId: bobChat.id, file: bobVideo.file },
      { sessionId: aliceChat.id, file: 'scratch-1/part.wav' }
    ]
  });
  assert.deepEqual(done.deleted, [
    { sessionId: aliceChat.id, file: big.file, size: 5000 },
    { sessionId: aliceChat.id, file: 'scratch-1/part.wav', size: 700 }
  ]);
  assert.equal(done.freedBytes, 5700);
  assert.equal(done.failed.length, 1);
  assert.ok(!fs.existsSync(path.join(PATHS.assetsDir, aliceChat.id, big.file)));
  const ledger = await store.readLedger(aliceChat.id);
  assert.ok(!ledger.some((entry) => entry.id === big.id), 'the ledger entry is gone');
  assert.ok(ledger.some((entry) => entry.id === small.id), 'the other entries stay');

  // admins delete everything, also in a folder without a session
  const byAdmin = await storage.remove({
    viewer: viewer('admin@example.com', true),
    items: [{ sessionId: bobChat.id, file: bobVideo.file }, { sessionId: 'orphan-1', file: 'old.mp4' }]
  });
  assert.equal(byAdmin.deleted.length, 2);
  assert.equal(byAdmin.freedBytes, 10200);
  assert.ok(!fs.existsSync(outside));

  /* ---------- the page ---------- */
  assert.equal(page.formatBytes(0, 'de'), '0 B');
  assert.equal(page.formatBytes(1023, 'en'), '1,023 B');
  assert.equal(page.formatBytes(1536, 'en'), '1.5 KB');
  assert.equal(page.formatBytes(250 * 1024 * 1024, 'en'), '250 MB');
  assert.equal(page.formatBytes(3.25 * 1024 ** 3, 'en'), '3.3 GB');
  assert.equal(page.formatBytes(-5, 'en'), '0 B');
  const sessions = new Map([
    ['s1', { id: 's1', title: 'Alice Film', owner: ALICE }],
    ['s2', { id: 's2', title: 'Bob Film', owner: BOB }],
    ['s3', { id: 's3', title: null, owner: null }]
  ]);
  const files = [
    { sessionId: 's1', file: 'vid-001.mp4', name: 'vid-001.mp4', type: 'video', size: 10, modifiedAt: '2026-01-02T00:00:00.000Z', prompt: 'Meer' },
    { sessionId: 's2', file: 'vid-001.mp4', name: 'vid-001.mp4', type: 'video', size: 30, modifiedAt: '2026-01-01T00:00:00.000Z' },
    { sessionId: 's1', file: 'img-001.png', name: 'img-001.png', type: 'image', size: 20, modifiedAt: '2026-01-03T00:00:00.000Z' },
    { sessionId: 's3', file: 'old.mp4', name: 'old.mp4', type: 'video', size: 5, modifiedAt: '2025-01-03T00:00:00.000Z' }
  ];
  const sizes = (options) => page.visibleFiles(files, sessions, options).map((file) => file.size);
  assert.deepEqual(sizes({}), [30, 20, 10, 5]);
  assert.deepEqual(sizes({ type: 'video' }), [30, 10, 5]);
  assert.deepEqual(sizes({ owner: ALICE }), [20, 10]);
  assert.deepEqual(sizes({ owner: '' }), [5], 'files without an owner');
  assert.deepEqual(sizes({ sort: 'new' }), [20, 10, 30, 5]);
  assert.deepEqual(sizes({ sort: 'old' }), [5, 30, 10, 20]);
  assert.deepEqual(sizes({ sort: 'name' }), [20, 5, 10, 30]);
  assert.deepEqual(sizes({ search: 'bob' }), [30], 'search finds the chat title and the person');
  assert.deepEqual(sizes({ search: 'MEER' }), [10], 'search finds the prompt');
  assert.equal(files[0].size, 10, 'the list of the server is not reordered');
  assert.equal(page.keyOf(files[0]), 's1/vid-001.mp4');

  // the page, its texts and the menu entry
  const read = (...parts) => fs.readFileSync(path.join(PATHS.root, ...parts), 'utf8');
  const html = read('public', 'storage.html');
  const script = read('public', 'storage.js');
  const i18n = read('public', 'i18n.js');
  const keys = new Set([...html.matchAll(/data-i18n(?:-aria-label)?="([\w.]+)"/g)].map((match) => match[1]));
  for (const match of script.matchAll(/\bT\('([\w.]+)'/g)) keys.add(`storage.${match[1]}`);
  for (const type of ['video', 'image', 'audio', 'document', 'other']) keys.add(`storage.badge.${type}`);
  keys.add('menu.storage');
  for (const key of keys) {
    const count = i18n.split(`'${key}':`).length - 1;
    assert.equal(count, 3, `${key} exists in de, en and es`);
  }
  assert.doesNotMatch(i18n.split('\n').filter((line) => line.includes("'storage.")).join('\n'), /ß/, 'Swiss spelling');
  assert.doesNotMatch(script, /innerHTML/, 'values of the server are written as text');
  assert.match(html, /<dialog id="confirm"/, 'deleting asks first');
  assert.match(read('public', 'shell.js'), /id: 'storage'.*href: 'storage\.html'/);

  console.log('test-storage-overview.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
