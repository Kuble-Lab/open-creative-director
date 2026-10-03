'use strict';

// Limits of the uploads of the agent access (lib/mcp/uploads.js, lib/mcp/files.js) in an isolated copy of the app (temp data
// folders, ephemeral port; nothing is paid, nothing leaves the machine):
//
//   C  the content has to look like the type: HTML bytes named .png, random bytes named .mp4, through the tool and the link
//   Q  the limits per key: bytes in all, bytes per hour, number of files; for base64 and for the one-time link (a link that
//      is refused is not burnt); a key has limits of its own
//   R  two uploads at once cannot both use the last room (the room is reserved while a file arrives)
//   S  uploads older than the retention time are removed (files and ledger), newer ones and other entries stay; the timer
//
// The size and rate limits of POST /mcp (requests at the same moment, large bodies) are in test-mcp-protocol.js.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const express = require('express');

const { createIsolatedApp } = require('./support/isolated-app');

const STAFF = 'one@staff.example.com';
const KB = 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const png = (size) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, size - PNG.length))]);
const mp4 = (size) => Buffer.concat([Buffer.from('....ftypmp42'), Buffer.alloc(Math.max(0, size - 12), 1)]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: '',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      PUBLIC_BASE_URL: 'https://creator.example.com',
      OPENROUTER_API_KEY: '',
      FAL_KEY: '',
      ELEVENLABS_API_KEY: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const holder = { server: null };
  try {
    await run(iso, holder);
  } finally {
    if (holder.server) await new Promise((resolve) => { holder.server.closeAllConnections?.(); holder.server.close(resolve); });
    await iso.cleanup();
  }
  console.log('MCP-Upload-Grenzen: Inhalt muss zum Typ passen, Speicher-, Stunden- und Dateigrenze pro Schlüssel, Reservierung bei gleichzeitigen Uploads und Aufräumen alter Uploads sind korrekt.');
  console.log('test-mcp-limits.js: ok');
}

async function run(iso, holder) {
  const api = iso.request;
  const access = iso.load('lib/access');
  const sessionsLib = iso.load('lib/store');
  const keysLib = iso.load('lib/mcp/keys');
  const uploadsLib = iso.load('lib/mcp/uploads');
  const { createMcp } = iso.load('lib/mcp');
  const keys = keysLib.defaultStore;
  await api('/api/me', { as: STAFF }); // the first sight records a person on the team list

  /* ---------- the endpoint with small limits and a clock that can be moved ---------- */

  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const limits = { storageBytes: 250 * KB, hourlyBytes: 150 * KB, maxFiles: 6, retentionMs: 7 * DAY };
  const uploads = uploadsLib.createUploads({ limits, now });
  const mcp = createMcp({
    keys,
    service: () => ({}),
    uploads,
    sweepUploads: false,
    env: { PUBLIC_BASE_URL: 'https://creator.example.com' },
    limiter: { take: () => ({ allowed: true }), reset() {} }
  });
  const app = express();
  mcp.mount(app);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  holder.server = server;
  const port = server.address().port;
  assert.notEqual(port, 3111);
  const base = `http://127.0.0.1:${port}`;

  let rpcId = 0;
  async function tool(secret, name, args) {
    rpcId += 1;
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } })
    });
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    return { isError: result.isError === true, text: result.content[0].text, data: result.structuredContent };
  }
  const upload = (secret, filename, bytes, extra = {}) => tool(secret, 'upload_asset', { filename, data_base64: bytes.toString('base64'), ...extra });
  const ok = async (result) => {
    assert.equal(result.isError, false, result.text);
    return result.data;
  };
  const refused = (result, pattern) => {
    assert.equal(result.isError, true, `should have been refused: ${result.text}`);
    assert.match(result.text, pattern);
  };
  const makeKey = (name) => {
    const created = keys.create({ owner: STAFF, createdBy: STAFF, name, right: 'start' });
    return { ...created.key, secret: created.secret };
  };
  const pathOf = (url) => new URL(url).pathname;
  const put = (url, body) => fetch(`${base}${pathOf(url)}`, { method: 'PUT', body });
  const linkFor = async (key, filename, args = {}) => (await ok(await tool(key.secret, 'upload_asset', { filename, ...args }))).upload_url;
  const ledgerOf = (key) => sessionsLib.readLedger(uploads.peek(key.id));

  /* ============ C: the content has to look like the type ============ */

  const looks = uploadsLib.looksLike;
  const samples = {
    '.png': png(80),
    '.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]),
    '.gif': Buffer.from('GIF89a......'),
    '.webp': Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '),
    '.wav': Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
    '.webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42]),
    '.mp4': mp4(40),
    '.m4a': Buffer.from('\u0000\u0000\u0000 ftypM4A '),
    '.mp3': Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'),
    '.aac': Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc])
  };
  for (const [ext, head] of Object.entries(samples)) {
    assert.equal(looks(ext, head), true, `${ext} with its own beginning`);
    for (const [other, otherHead] of Object.entries(samples)) {
      if (other === ext || (ext === '.mp4' && other === '.m4a') || (ext === '.m4a' && other === '.mp4')) continue;
      if (ext === '.aac' && other === '.mp4') continue; // an AAC stream may sit in an MP4 container
      if (ext === '.aac' && (other === '.m4a' || other === '.mp3')) continue; // both may carry an ID3 tag in front of the stream
      if (ext === '.mp3' && other === '.aac') continue; // an ADTS frame has the same sync bits as an MP3 frame
      assert.equal(looks(ext, otherHead), false, `${ext} is not ${other}`);
    }
    assert.equal(looks(ext, Buffer.from('<html><body>hello</body></html>')), false, `${ext} is not HTML`);
    assert.equal(looks(ext, Buffer.alloc(0)), false, `${ext} is not an empty file`);
  }
  assert.equal(looks('.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00])), true, 'an MP3 frame without a tag');
  assert.equal(looks('.mp4', Buffer.from('\u0000\u0000\u0000 moov')), true, 'an MP4 that starts with another box');

  const checker = makeKey('Inhalt');
  const html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
  refused(await upload(checker.secret, 'page.html', html, { mime_type: 'image/png' }), /not a png file/);
  refused(await upload(checker.secret, 'x.png', html), /not a png file/);
  refused(await upload(checker.secret, 'x.mp4', Buffer.concat([Buffer.from([7, 7, 7, 7, 7, 7, 7, 7]), Buffer.alloc(100)])), /not a mp4 file/);
  refused(await upload(checker.secret, 'x.mp3', png(100)), /not a mp3 file/);
  refused(await upload(checker.secret, 'x.png', mp4(100)), /not a png file/);
  assert.equal((await ledgerOf(checker)).length, 0, 'nothing of it was stored');
  assert.equal((await ok(await upload(checker.secret, 'ok.png', png(100)))).type, 'image');
  assert.equal((await ok(await upload(checker.secret, 'ok.mp4', mp4(100)))).type, 'video');
  assert.equal((await ok(await upload(checker.secret, 'ok.mp3', samples['.mp3']))).type, 'audio');
  // an SVG is rasterised: it needs no beginning of its own
  assert.equal((await ok(await upload(checker.secret, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')))).type, 'image');
  // the same through the one-time link
  const wrongLink = await linkFor(checker, 'fake.png');
  const wrongPut = await put(wrongLink, html);
  assert.equal(wrongPut.status, 415);
  assert.equal((await wrongPut.json()).error, 'content_mismatch');
  assert.equal((await put(wrongLink, png(100))).status, 410, 'the link was used by the attempt');
  const goodLink = await linkFor(checker, 'real.png');
  assert.equal((await put(goodLink, png(100))).status, 201);

  /* ============ Q: bytes per hour, bytes in all, number of files ============ */

  // per hour
  const hourly = makeKey('Stunde');
  await ok(await upload(hourly.secret, 'one.png', png(100 * KB)));
  refused(await upload(hourly.secret, 'two.png', png(100 * KB)), /per hour/);
  refused(await tool(hourly.secret, 'upload_asset', { filename: 'big.mp4', size_bytes: 100 * KB }), /per hour/);
  const pending = await linkFor(hourly, 'clip.mp4'); // no size announced: a link is given
  const early = await put(pending, mp4(100 * KB));
  assert.equal(early.status, 429);
  assert.equal(early.headers.get('retry-after'), '600');
  assert.equal((await early.json()).error, 'quota_hourly');
  clock.offset = 2 * HOUR;
  const later = await put(pending, mp4(100 * KB));
  assert.equal(later.status, 201, 'the link was not burnt by the refusal, and an hour later there is room');
  assert.equal((await ledgerOf(hourly)).length, 2);
  clock.offset = 0;

  // in all
  const storage = makeKey('Speicher');
  await ok(await upload(storage.secret, 'a.png', png(100 * KB)));
  clock.offset = 2 * HOUR;
  await ok(await upload(storage.secret, 'b.png', png(100 * KB)));
  refused(await upload(storage.secret, 'c.png', png(100 * KB)), /may keep/);
  refused(await tool(storage.secret, 'upload_asset', { filename: 'c.mp4', size_bytes: 100 * KB }), /may keep/);
  const full = await linkFor(storage, 'c.mp4');
  const fullPut = await put(full, mp4(100 * KB));
  assert.equal(fullPut.status, 413);
  assert.equal((await fullPut.json()).error, 'quota_storage');
  assert.equal((await put(full, mp4(40 * KB))).status, 201, 'the link was not burnt: a smaller file fits');
  assert.equal((await ledgerOf(storage)).length, 3);
  refused(await upload(storage.secret, 'd.png', png(100 * KB)), /may keep/);
  clock.offset = 0;

  // number of files
  const many = makeKey('Dateien');
  for (let index = 0; index < 6; index += 1) await ok(await upload(many.secret, `f${index}.png`, png(70)));
  refused(await upload(many.secret, 'one-more.png', png(70)), /stored 6 files/);
  refused(await tool(many.secret, 'upload_asset', { filename: 'more.png' }), /stored 6 files/);
  const filesLink = await linkFor(makeKey('Anderer'), 'other.png');
  assert.equal((await put(filesLink, png(70))).status, 201, 'another key has limits of its own');

  /* ============ R: room is reserved while a file arrives ============ */

  const viewer = access.viewerOf({ kubleUser: STAFF });
  const reserving = uploadsLib.createUploads({ limits: { storageBytes: 150 * KB, hourlyBytes: 1024 * 1024 * 1024, maxFiles: 100, retentionMs: 7 * DAY }, now, file: path.join(iso.root, 'data', 'mcp-uploads-reserving.json') });
  const writer = (bytes, pause = 0) => async (file) => {
    if (pause) await sleep(pause);
    await fsp.writeFile(file, bytes);
    return bytes.length;
  };
  const save = (key, bytes, extra = {}) =>
    reserving.save({ key, viewer, filename: 'r.png', mimeType: 'image/png', limitBytes: 500 * KB, expectedBytes: bytes.length, write: writer(bytes, extra.pause), ...extra.options });
  const raceKey = makeKey('Rennen');
  const outcomes = await Promise.allSettled([save(raceKey, png(100 * KB), { pause: 50 }), save(raceKey, png(100 * KB), { pause: 50 })]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected'], 'only one of two uploads at once fits');
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'QUOTA_STORAGE');
  assert.equal((await reserving.usageOf(reserving.peek(raceKey.id))).bytes, 100 * KB);
  await save(raceKey, png(40 * KB)); // the reservation of the refused upload is gone, and so is the one of the finished upload
  // a file that fails gives its room back
  await assert.rejects(() => reserving.save({ key: raceKey, viewer, filename: 'r.png', mimeType: 'image/png', limitBytes: 500 * KB, expectedBytes: 5 * KB, write: async () => { throw new Error('disk gone'); } }), /disk gone/);
  await save(raceKey, png(5 * KB));
  // an unknown size reserves the most it may be
  const unknown = makeKey('Unbekannt');
  const sizes = await Promise.allSettled([
    reserving.save({ key: unknown, viewer, filename: 'u.png', mimeType: 'image/png', limitBytes: 100 * KB, write: writer(png(1 * KB), 50) }),
    reserving.save({ key: unknown, viewer, filename: 'u.png', mimeType: 'image/png', limitBytes: 100 * KB, write: writer(png(1 * KB), 50) })
  ]);
  assert.deepEqual(sizes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected'], 'without a size announced, the largest possible size counts');

  /* ============ S: old uploads are removed ============ */

  const sweepKey = makeKey('Aufräumen');
  for (let index = 0; index < 3; index += 1) await ok(await upload(sweepKey.secret, `s${index}.png`, png(300)));
  const sessionId = uploads.peek(sweepKey.id);
  const dir = sessionsLib.sessionAssetDir(sessionId);
  let ledger = await sessionsLib.readLedger(sessionId);
  assert.equal(ledger.length, 3);
  ledger[0].createdAt = new Date(Date.now() - 8 * DAY).toISOString(); // too old
  ledger[1].createdAt = new Date(Date.now() - 6 * DAY).toISOString(); // not yet
  ledger.push({ id: 'image-001', file: 'image-001.png', kind: 'image', createdAt: new Date(Date.now() - 30 * DAY).toISOString() }); // not an upload
  await fsp.writeFile(path.join(dir, 'image-001.png'), png(100));
  await sessionsLib.writeLedger(sessionId, ledger);
  const oldFile = ledger[0].file;
  await fsp.access(path.join(dir, oldFile));
  assert.equal(await uploads.sweep(), 1, 'one upload was older than 7 days');
  ledger = await sessionsLib.readLedger(sessionId);
  assert.deepEqual(ledger.map((entry) => entry.id), ['upload-002', 'upload-003', 'image-001']);
  assert.equal(ledger.some((entry) => entry.file === oldFile), false, 'the old upload is out of the ledger');
  await assert.rejects(() => fsp.access(path.join(dir, oldFile)), { code: 'ENOENT' }, 'and its file is gone');
  assert.equal(ledger.length, 3, 'the young upload and the entry that is no upload stay');
  await fsp.access(path.join(dir, ledger.find((entry) => entry.id === 'image-001').file));
  assert.equal(await uploads.sweep(), 0, 'nothing more to do');
  // after the retention time the second one goes as well
  const later7 = uploadsLib.createUploads({ limits, now: () => Date.now() + 2 * DAY });
  assert.equal(await later7.sweep(), 1);
  ledger = await sessionsLib.readLedger(sessionId);
  assert.equal(ledger.some((entry) => entry.kind === 'upload' && entry.id === 'upload-002'), false);
  assert.equal(ledger.filter((entry) => entry.kind === 'upload').length, 1, 'the upload of today stays');
  // the timer
  const timed = makeKey('Zeitgeber');
  await ok(await upload(timed.secret, 't.png', png(300)));
  const timedSession = uploads.peek(timed.id);
  const timedLedger = await sessionsLib.readLedger(timedSession);
  timedLedger[0].createdAt = new Date(Date.now() - 9 * DAY).toISOString();
  await sessionsLib.writeLedger(timedSession, timedLedger);
  const stop = uploads.startSweeper({ intervalMs: 40, first: false });
  const started = Date.now();
  while ((await sessionsLib.readLedger(timedSession)).length && Date.now() - started < 5000) await sleep(20);
  stop();
  assert.equal((await sessionsLib.readLedger(timedSession)).length, 0, 'the timer swept it');
  assert.equal(typeof uploads.startSweeper({ intervalMs: 60 * 1000, first: false }), 'function');
  uploads.startSweeper()(); // starting twice gives the same stop; stopping ends it
  assert.equal(mcp.uploads, uploads);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
