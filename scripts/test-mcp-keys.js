'use strict';

// Tests of the keys of the agent access (WP27, part 2): format and entropy, only the hash is stored, constant-time
// comparison, expiry (90 days by default), revoking, limits and validation, "last used", a damaged file. The check of the
// person behind a key (admin / internal / deleted) is tested at route level in scripts/test-mcp-api.js. Everything lives
// in a temp directory; nothing of the real data folder is read.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const keysLib = require('../lib/mcp/keys');

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const DAY = 24 * 3600 * 1000;

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-mcp-keys-'));
  const file = path.join(dir, 'mcp-keys.json');
  const clock = { t: Date.parse('2026-10-03T08:00:00Z') };
  const valid = new Set([ALICE, BOB]);
  const viewerFor = (owner) => (valid.has(owner) ? { active: true, email: owner, identified: true, admin: false, kind: 'internal' } : null);
  const store = keysLib.createKeyStore({ file, now: () => clock.t, viewerFor });
  try {
    /* ----- format and entropy ----- */

    assert.equal(keysLib.KEY_PREFIX, 'ocd_k1_');
    const created = store.create({ name: '  Claude   Code  ', owner: ALICE, right: 'read' });
    const secret = created.secret;
    assert.match(secret, /^ocd_k1_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret.slice(7), 'base64url').length, 32, '32 random bytes = 256 bit');
    const other = store.create({ name: 'Zweiter', owner: ALICE, right: 'start' });
    assert.notEqual(other.secret, secret);
    assert.notEqual(other.secret.slice(7, 20), secret.slice(7, 20));
    assert.match(created.key.id, /^k[0-9a-f]{16}$/);
    assert.equal(created.key.name, 'Claude Code', 'blanks are tidied');

    /* ----- only the hash is stored ----- */

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(secret), 'the secret is not in the file');
    assert.ok(!raw.includes(secret.slice(7, 30)), 'nor a long part of it');
    assert.ok(!raw.includes(other.secret));
    const stored = JSON.parse(raw);
    assert.equal(stored.version, 1);
    const record = stored.keys.find((entry) => entry.id === created.key.id);
    assert.equal(record.hash, crypto.createHash('sha256').update(secret).digest('hex'));
    assert.equal(record.prefix, secret.slice(0, 11), 'a short prefix for the display');
    assert.equal(record.prefix.length, 11);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file is for the app only');
    for (const view of [created.key, ...store.list(), store.get(created.key.id)]) {
      assert.ok(!('hash' in view) && !('secret' in view) && !('token' in view), 'a view has neither hash nor secret');
      assert.ok(!JSON.stringify(view).includes(secret.slice(7)), 'nor any part of the secret');
    }
    assert.equal(store.get('nope'), null);
    assert.equal(store.get('k0000000000000000'), null);

    /* ----- defaults, expiry, limits ----- */

    assert.equal(created.key.right, 'read');
    assert.equal(created.key.owner, ALICE);
    assert.equal(created.key.maxRunUsd, 2);
    assert.equal(created.key.maxMonthUsd, 20);
    assert.equal(created.key.createdAt, '2026-10-03T08:00:00.000Z');
    assert.equal(Date.parse(created.key.expiresAt) - Date.parse(created.key.createdAt), 90 * DAY, '90 days by default');
    assert.equal(created.key.lastUsedAt, null);
    assert.equal(created.key.revokedAt, null);
    assert.equal(created.key.status, 'active');
    const custom = store.create({ name: 'Eigene Grenzen', owner: BOB, right: 'start', maxRunUsd: 0.5, maxMonthUsd: '7.25', expiresInDays: 30 });
    assert.equal(custom.key.maxRunUsd, 0.5);
    assert.equal(custom.key.maxMonthUsd, 7.25);
    assert.equal(Date.parse(custom.key.expiresAt) - Date.parse(custom.key.createdAt), 30 * DAY);

    const invalid = (input, code) => assert.throws(() => store.create({ name: 'X', owner: ALICE, right: 'read', ...input }), (error) => error instanceof keysLib.KeyValidationError && error.code === code, JSON.stringify(input));
    invalid({ name: '' }, 'INVALID_NAME');
    invalid({ name: '   ' }, 'INVALID_NAME');
    invalid({ name: 5 }, 'INVALID_NAME');
    invalid({ name: 'x'.repeat(81) }, 'INVALID_NAME');
    invalid({ name: 'a\u0007b' }, 'INVALID_NAME');
    invalid({ right: 'admin' }, 'INVALID_RIGHT');
    invalid({ right: undefined }, 'INVALID_RIGHT');
    invalid({ maxRunUsd: -1 }, 'INVALID_LIMIT');
    invalid({ maxRunUsd: 'viel' }, 'INVALID_LIMIT');
    invalid({ maxRunUsd: 1001 }, 'INVALID_LIMIT');
    invalid({ maxMonthUsd: NaN }, 'INVALID_LIMIT');
    invalid({ maxMonthUsd: 10001 }, 'INVALID_LIMIT');
    invalid({ expiresInDays: 0 }, 'INVALID_EXPIRY');
    invalid({ expiresInDays: 366 }, 'INVALID_EXPIRY');
    invalid({ expiresInDays: 1.5 }, 'INVALID_EXPIRY');
    invalid({ expiresInDays: '30' }, 'INVALID_EXPIRY');
    invalid({ owner: 'kein-mensch' }, 'INVALID_OWNER');
    invalid({ owner: undefined }, 'INVALID_OWNER');
    assert.equal(store.create({ name: 'Null', owner: ALICE, right: 'read', maxRunUsd: 0, maxMonthUsd: 0 }).key.maxRunUsd, 0, '0 is a limit (nothing paid)');
    assert.equal(store.list().length, 4, 'a refused key leaves nothing behind');

    /* ----- the check of a presented secret ----- */

    const ok = store.authenticate(secret);
    assert.equal(ok.ok, true);
    assert.equal(ok.key.id, created.key.id);
    assert.equal(ok.viewer.email, ALICE);
    assert.ok(!JSON.stringify(ok.key).includes(secret.slice(7)));
    for (const bad of [undefined, null, 42, '', 'ocd_k1_', secret.slice(0, -1), `${secret}a`, secret.replace(/^ocd_k1_/, 'ocd_k2_'), ` ${secret}`, `${secret}\n`, 'ocd_k1_' + 'A'.repeat(43)]) {
      const result = store.authenticate(bad);
      assert.equal(result.ok, false, String(bad));
      assert.ok(['malformed', 'unknown'].includes(result.reason), String(bad));
    }
    assert.equal(store.authenticate('ocd_k1_' + 'A'.repeat(43)).reason, 'unknown');
    assert.equal(store.authenticate('ocd_k1_short').reason, 'malformed');

    // constant time: every stored hash is compared, whether or not an earlier one matched
    const original = crypto.timingSafeEqual;
    let comparisons = 0;
    crypto.timingSafeEqual = (a, b) => {
      comparisons += 1;
      return original(a, b);
    };
    try {
      store.authenticate(secret);
      assert.equal(comparisons, store.list().length, 'a match does not stop the loop');
      comparisons = 0;
      store.authenticate('ocd_k1_' + 'C'.repeat(43));
      assert.equal(comparisons, store.list().length, 'a miss compares just as many');
      comparisons = 0;
      store.authenticate('not a key at all');
      assert.equal(comparisons, 0, 'a malformed value is refused before any comparison');
    } finally {
      crypto.timingSafeEqual = original;
    }

    /* ----- last used: written at most once a minute ----- */

    assert.equal(store.get(created.key.id).lastUsedAt, '2026-10-03T08:00:00.000Z', 'the first use is written');
    const writtenAt = fs.statSync(file).mtimeMs;
    clock.t += 10 * 1000;
    store.authenticate(secret);
    assert.equal(store.get(created.key.id).lastUsedAt, '2026-10-03T08:00:00.000Z', 'not again within a minute');
    assert.equal(fs.statSync(file).mtimeMs, writtenAt);
    clock.t += 61 * 1000;
    store.authenticate(secret);
    assert.equal(store.get(created.key.id).lastUsedAt, new Date(clock.t).toISOString());

    /* ----- the person behind a key ----- */

    valid.delete(BOB);
    const orphan = store.authenticate(custom.secret);
    assert.deepEqual({ ok: orphan.ok, reason: orphan.reason }, { ok: false, reason: 'owner_invalid' });
    assert.equal(store.get(custom.key.id).ownerValid, false);
    assert.equal(store.get(created.key.id).ownerValid, true);
    valid.add(BOB);
    assert.equal(store.authenticate(custom.secret).ok, true, 'and valid again when the person is');

    /* ----- change and revoke ----- */

    const updated = store.update(created.key.id, { name: 'Neu benannt', maxRunUsd: 1, maxMonthUsd: 5 });
    assert.equal(updated.name, 'Neu benannt');
    assert.equal(updated.maxRunUsd, 1);
    assert.equal(updated.maxMonthUsd, 5);
    assert.equal(updated.right, 'read', 'the right does not change');
    assert.equal(store.update(created.key.id, { right: 'start', owner: BOB, expiresAt: '2099-01-01' }).right, 'read');
    assert.equal(store.update(created.key.id, { owner: BOB }).owner, ALICE);
    assert.throws(() => store.update(created.key.id, { maxRunUsd: -5 }), (error) => error.code === 'INVALID_LIMIT');
    assert.equal(store.get(created.key.id).maxRunUsd, 1, 'a refused change changes nothing');
    assert.throws(() => store.update('k0000000000000000', { name: 'x' }), keysLib.KeyNotFoundError);

    const revoked = store.revoke(created.key.id, BOB);
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revokedAt, new Date(clock.t).toISOString());
    assert.equal(revoked.revokedBy, BOB);
    const result = store.authenticate(secret);
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'revoked' });
    clock.t += 5000;
    assert.equal(store.revoke(created.key.id, ALICE).revokedBy, BOB, 'revoking twice changes nothing');
    assert.throws(() => store.update(created.key.id, { name: 'x' }), (error) => error.code === 'KEY_REVOKED');
    assert.throws(() => store.revoke('k0000000000000000', ALICE), keysLib.KeyNotFoundError);
    assert.equal(store.list().length, 4, 'a revoked key stays in the list');

    /* ----- expiry ----- */

    const week = store.create({ name: 'Woche', owner: ALICE, right: 'read', expiresInDays: 7 });
    clock.t += 7 * DAY - 1000;
    assert.equal(store.authenticate(week.secret).ok, true);
    clock.t += 2000;
    const late = store.authenticate(week.secret);
    assert.deepEqual({ ok: late.ok, reason: late.reason }, { ok: false, reason: 'expired' });
    assert.equal(store.get(week.key.id).status, 'expired');
    clock.t += 90 * DAY;
    assert.equal(store.authenticate(other.secret).reason, 'expired', 'the 90 days are over');

    /* ----- the list, the limit per person ----- */

    assert.deepEqual(store.list({ owner: BOB }).map((entry) => entry.name), ['Eigene Grenzen']);
    assert.deepEqual(new Set(store.list().map((entry) => entry.owner)), new Set([ALICE, BOB]));
    assert.equal(store.list({ owner: 'nobody@example.com' }).length, 0);
    clock.t = Date.parse('2026-11-01T08:00:00Z');
    const crowded = keysLib.createKeyStore({ file: path.join(dir, 'crowded.json'), now: () => clock.t, viewerFor });
    for (let i = 0; i < keysLib.LIMITS.keysPerOwner; i += 1) crowded.create({ name: `Key ${i}`, owner: ALICE, right: 'read' });
    assert.throws(() => crowded.create({ name: 'Zu viel', owner: ALICE, right: 'read' }), (error) => error.code === 'TOO_MANY_KEYS');
    const first = crowded.list()[crowded.list().length - 1];
    crowded.revoke(first.id, ALICE);
    assert.doesNotThrow(() => crowded.create({ name: 'Wieder Platz', owner: ALICE, right: 'read' }), 'a revoked key makes room');
    assert.doesNotThrow(() => crowded.create({ name: 'Andere Person', owner: BOB, right: 'read' }));

    /* ----- another process / a restart reads the same file ----- */

    const second = keysLib.createKeyStore({ file, now: () => clock.t, viewerFor });
    assert.equal(second.authenticate(custom.secret).ok, true, 'a new store reads the same file');
    assert.equal(second.list().length, store.list().length);
    clock.t = Date.parse('2026-12-05T08:00:00Z');
    assert.equal(second.authenticate(custom.secret).reason, 'expired', 'the 30 days are over');

    /* ----- a damaged file ----- */

    await fsp.writeFile(file, '{ this is not json');
    assert.equal(store.authenticate(custom.secret).reason, 'unavailable', 'fails closed');
    assert.throws(() => store.create({ name: 'X', owner: ALICE, right: 'read' }), keysLib.KeyStoreError);
    assert.throws(() => store.list(), keysLib.KeyStoreError);
    assert.equal(await fsp.readFile(file, 'utf8'), '{ this is not json', 'a damaged file is not overwritten');
    await fsp.writeFile(file, JSON.stringify({ keys: [{ id: 'k0000000000000001', hash: 'zz' }, null, 5, { id: 'bad' }] }));
    assert.deepEqual(store.list(), [], 'records that are not usable are ignored');
    assert.equal(store.authenticate(custom.secret).reason, 'unknown');
    await fsp.writeFile(file, '[]');
    assert.throws(() => store.list(), keysLib.KeyStoreError);
    await fsp.rm(file);
    assert.deepEqual(store.list(), [], 'no file, no keys');

    /* ----- without user management ----- */

    const localStore = keysLib.createKeyStore({ file: path.join(dir, 'local.json'), now: () => clock.t, env: {} });
    const localKey = localStore.create({ name: 'Lokal', owner: keysLib.LOCAL_OWNER, right: 'start' });
    assert.equal(localKey.key.owner, 'lokal');
    const localAuth = localStore.authenticate(localKey.secret);
    assert.equal(localAuth.ok, true);
    assert.equal(localAuth.viewer.active, false);
    assert.equal(localAuth.viewer.admin, true, 'the local person is who the app lets do everything');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('MCP-Schlüssel: Format, 256 Bit, nur Hash gespeichert, konstante Zeit, Ablauf, Widerruf, Limits, Validierung und beschädigte Datei sind korrekt.');
  console.log('test-mcp-keys.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
