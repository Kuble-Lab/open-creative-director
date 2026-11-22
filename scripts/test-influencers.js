'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const { once } = require('events');
const influencers = require('../lib/influencers');
const access = require('../lib/access');
const { parseFigure } = require('../lib/music-video-hud/plan');
const template = require('../lib/nodes/templates/music-video-hud.json');
const { app } = require('../server');

const alice = { active: true, identified: true, admin: false, email: 'alice@example.test', kind: 'internal' };
const bob = { ...alice, email: 'bob@example.test' };
const admin = { ...alice, email: 'admin@example.test', admin: true, kind: 'admin' };
const guest = { ...alice, email: 'guest@example.test', kind: 'guest' };
const participant = { ...alice, email: 'participant@example.test', kind: 'participant' };
const anonymous = { active: true, identified: false, admin: false, email: null };
const unconfirmed = { ...anonymous };
const viewers = { alice, bob, admin, guest, participant, anonymous, unconfirmed };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = Buffer.from([255, 216, 255, 224]);
const webp = Buffer.from('RIFF0000WEBP');
const ids = new Set();
const data = { name: 'Ada', full: 'a woman with black hair' };
const code = (expected) => (err) => err.code === expected;
async function create(fields = {}, options = {}) {
  const item = await influencers.createInfluencer({ ...data, ...fields }, { viewer: alice, consent: true, ...options });
  ids.add(item.id);
  return item;
}
async function drop(id) {
  await influencers.deleteInfluencer(id);
  ids.delete(id);
}

async function moduleTests() {
  for (const consent of [undefined, false, 'true', 1]) {
    await assert.rejects(influencers.createInfluencer(data, { viewer: alice, consent }), code('INFLUENCER_CONSENT_REQUIRED'));
  }
  const item = await create({ name: ' Ada\n Lovelace ', tagline: ' first\n line ', credit: ' A\r\n B ', voice: { voiceId: ' abc_DEF-12 ', name: ' Clear\n Voice ', description: ' soft ' } });
  assert.match(item.id, /^inf-[a-f0-9]+$/);
  assert.equal(item.name, 'Ada Lovelace');
  assert.equal(item.tagline, 'first line');
  assert.equal(item.credit, 'A B');
  assert.equal(item.owner, alice.email);
  assert.equal(item.consent.by, alice.email);
  assert.equal(new Date(item.consent.confirmedAt).toISOString(), item.consent.confirmedAt);
  assert.deepEqual(item.voice, { voiceId: 'abc_DEF-12', name: 'Clear Voice', description: 'soft' });
  assert.equal(influencers.ownerForNew(guest), guest.email);
  assert.equal(influencers.ownerForNew(admin), admin.email);
  assert.equal(influencers.ownerForNew(null), null);
  assert.equal(influencers.ownerForNew({ active: false, email: alice.email }), null);
  assert.throws(() => influencers.ownerForNew({ active: true, admin: true }), code('INFLUENCER_FORBIDDEN'));
  assert.equal(item.open, false);
  assert.equal((await create({ open: true })).open, false, 'creation ignores open like other unknown fields');
  assert.equal(influencers.ownerOf({ owner: ' ALICE@EXAMPLE.TEST ' }), alice.email);
  assert.throws(() => influencers.ownerForNew({ active: true }), code('INFLUENCER_FORBIDDEN'));
  assert.equal((await influencers.readEditableInfluencer(item.id, alice)).id, item.id);
  assert.equal((await influencers.readEditableInfluencer(item.id, admin)).id, item.id);
  for (const operation of [influencers.readVisibleInfluencer, influencers.readEditableInfluencer]) {
    await assert.rejects(operation(item.id, bob), code('INFLUENCER_NOT_FOUND'));
  }
  assert.equal((await influencers.listInfluencers({ viewer: bob })).some((entry) => entry.id === item.id), false);
  assert.equal(await influencers.resolveInfluencerId(item.name.toUpperCase(), { viewer: alice }), item.id);
  await assert.rejects(influencers.resolveInfluencerId(item.id, { viewer: bob }), code('INFLUENCER_NOT_FOUND'));
  await assert.rejects(influencers.resolveInfluencerId('../outside', { viewer: alice }), code('INFLUENCER_NOT_FOUND'));
  const twin = await create({ name: item.name });
  await assert.rejects(influencers.resolveInfluencerId(item.name, { viewer: alice }), /Mehrere Influencer/);
  await drop(twin.id);
  const local = await create({ by: bob.email, owner: bob.email }, { viewer: { active: false, admin: true } });
  assert.equal(local.consent.by, '');
  assert.equal(local.owner, null);
  const explicit = await create({}, { viewer: undefined, owner: ' BY@EXAMPLE.TEST ', by: ' AUTHOR@EXAMPLE.TEST ' });
  assert.equal(explicit.owner, 'by@example.test');
  assert.equal(explicit.consent.by, 'author@example.test');
  const adminOwned = await create({}, { viewer: admin });
  assert.equal(adminOwned.owner, admin.email);
  const shared = await create({}, { viewer: undefined, owner: null, by: admin.email });
  assert.equal(shared.owner, null);
  assert.equal(shared.consent.by, admin.email);
  assert.equal(influencers.visibleTo(shared, alice), true);
  assert.equal(influencers.editableBy(shared, alice), false);
  await assert.rejects(influencers.readEditableInfluencer(shared.id, alice), code('INFLUENCER_FORBIDDEN'));
  for (const viewer of [guest, participant]) {
    assert.equal(influencers.visibleTo(shared, viewer), false);
    const own = await create({}, { viewer });
    assert.equal(own.owner, viewer.email);
    assert.equal(influencers.editableBy(own, viewer), true);
  }
  assert.equal(influencers.editableBy(item, null), true);
  const summary = (await influencers.listInfluencers({ viewer: admin })).find((entry) => entry.id === item.id);
  assert.equal(summary.owner, alice.email);
  assert.equal(summary.hasVoice, true);
  assert.equal(summary.editable, true);
  assert.equal('owner' in influencers.influencerSummary(item, { viewer: alice }), false);
  await sharingTests(item, shared);
  await claimTests();

  const limits = { name: 60, tagline: 300, full: 1500, short: 400, looks: 1000, face: 400, never: 400, credit: 200, style: 1000 };
  for (const [field, max] of Object.entries(limits)) {
    await influencers.updateInfluencer(item.id, { [field]: 'x'.repeat(max) });
    await assert.rejects(influencers.updateInfluencer(item.id, { [field]: 'x'.repeat(max + 1) }), /maximal/);
    await assert.rejects(influencers.updateInfluencer(item.id, { [field]: 123 }), /String/);
  }
  for (const field of ['name', 'full']) await assert.rejects(influencers.updateInfluencer(item.id, { [field]: ' \n ' }), /leer/);
  for (const field of ['owner', 'id', 'createdAt', 'updatedAt', 'consent', 'images', 'builtin', 'unknown']) {
    await assert.rejects(influencers.updateInfluencer(item.id, { [field]: true }), /Unbekanntes/);
  }
  for (const voiceId of [42, 'no spaces', 'a'.repeat(101), 'a/b']) {
    await assert.rejects(influencers.updateInfluencer(item.id, { voice: { voiceId } }), /Voice-ID/);
  }
  for (const voice of [{ name: 'x'.repeat(81) }, { description: 'x'.repeat(401) }, { extra: true }, { name: 7 }, { description: null }, 'voice']) {
    await assert.rejects(influencers.updateInfluencer(item.id, { voice }), code('INFLUENCER_INVALID'));
  }
  await influencers.updateInfluencer(item.id, { voice: { voiceId: ' ', name: 'No ID', description: 'calm' } });
  assert.equal((await influencers.readInfluencer(item.id)).voice.description, 'calm');
  await influencers.updateInfluencer(item.id, { voice: null });
  assert.equal(influencers.influencerSummary(await influencers.readInfluencer(item.id)).hasVoice, false);
  const updated = await influencers.updateInfluencer(item.id, { name: 'Ada', full: 'woman\nwith hair', short: 'a woman', looks: 'blue\ncoat', face: 'calm', never: 'clones', credit: 'A B' });
  assert.deepEqual(updated.consent, item.consent);
  const parsed = parseFigure(influencers.figureText(updated));
  assert.equal(parsed.name, 'Ada');
  assert.equal(parsed.full, 'woman with hair');
  assert.equal(parsed.short, 'a woman');
  assert.equal(parsed.credit, 'A B');
  assert.deepEqual(parsed.notes, ['LOOKS: blue coat', 'FACE: calm', 'NEVER: clones']);
  assert.equal(influencers.figureText(data), 'NAME: Ada\nFULL: a woman with black hair');

  for (const [filename, buffer] of [['bad.gif', png], ['bad.jpg', png], ['bad.png', jpeg], ['bad.webp', png], ['bad.png', Buffer.from('not an image')]]) {
    await assert.rejects(influencers.saveInfluencerImage(item.id, { filename, buffer }), code('INFLUENCER_IMAGE_INVALID'));
  }
  await assert.rejects(influencers.saveInfluencerImage(item.id, { filename: 'large.png', buffer: Buffer.alloc(influencers.MAX_IMAGE_BYTES + 1) }), code('INFLUENCER_IMAGE_TOO_LARGE'));
  let saved = await influencers.saveInfluencerImage(item.id, { filename: '../../Porträt Test.PNG', buffer: png });
  assert.deepEqual(saved.images, ['Portrat-Test.png']);
  saved = await influencers.saveInfluencerImage(item.id, { filename: 'Porträt Test.PNG', buffer: png });
  assert.deepEqual(saved.images, ['Portrat-Test.png', 'Portrat-Test-2.png']);
  assert.deepEqual(await influencers.readInfluencerAsset(item.id, saved.images[0]), png);
  await assert.rejects(influencers.readInfluencerAsset(item.id, '../influencer.json'), code('INFLUENCER_INVALID'));
  for (const filename of ['face.jpg', 'face.jpeg', 'face.webp', 'last.png']) {
    await influencers.saveInfluencerImage(item.id, { filename, buffer: filename.endsWith('webp') ? webp : filename.endsWith('png') ? png : jpeg });
  }
  await assert.rejects(influencers.saveInfluencerImage(item.id, { filename: 'extra.png', buffer: png }), /maximal 6/);
  const preview = influencers.influencerSummary(await influencers.readInfluencer(item.id));
  assert.equal(preview.portrait, 'Portrat-Test.png');
  assert.equal(preview.imageCount, 6);
  await influencers.removeInfluencerImage(item.id, 'last.png');
  await assert.rejects(influencers.readInfluencerAsset(item.id, 'last.png'), code('INFLUENCER_NOT_FOUND'));
  const rename = fsp.rename;
  // A failed metadata write must not leave an unlisted image behind.
  fsp.rename = async (from, to) => {
    if (to === path.join(influencers.INFLUENCERS_DIR, item.id, 'influencer.json')) throw new Error('simulated write failure');
    return rename(from, to);
  };
  try {
    await assert.rejects(influencers.saveInfluencerImage(item.id, { filename: 'rollback.png', buffer: png }), /simulated/);
  } finally { fsp.rename = rename; }
  assert.equal((await fsp.readdir(influencers.influencerAssetsDir(item.id))).includes('rollback.png'), false);
  assert.equal((await influencers.readInfluencer(item.id)).images.length, 5);

  const claudia = await influencers.readInfluencer('claudia');
  assert.equal(claudia.builtin, true);
  assert.equal(influencers.figureText(claudia), template.graph.nodes.find((node) => node.id === 'n4').params.figure);
  for (const viewer of [alice, bob, guest, participant, admin, null, { active: true }]) {
    assert.equal((await influencers.listInfluencers({ viewer }))[0].id, 'claudia');
    assert.equal(influencers.visibleTo(claudia, viewer), true);
    assert.equal(influencers.editableBy(claudia, viewer), false);
    await assert.rejects(influencers.readEditableInfluencer('claudia', viewer), code('INFLUENCER_READONLY'));
  }
  for (const operation of [() => influencers.updateInfluencer('claudia', {}), () => influencers.deleteInfluencer('claudia'), () => influencers.saveInfluencerImage('claudia', { filename: 'face.png', buffer: png }), () => influencers.removeInfluencerImage('claudia', claudia.images[0])]) {
    await assert.rejects(operation(), code('INFLUENCER_READONLY'));
  }
  assert.equal(await influencers.resolveInfluencerId('Claudia', { viewer: guest }), 'claudia');
  assert.equal(await influencers.resolveInfluencerId('claudia'), 'claudia');
  assert.equal(claudia.images.length, 3);
  for (const filename of claudia.images) assert.ok((await influencers.readInfluencerAsset('claudia', filename)).length > 1000);
  await assert.rejects(fsp.stat(path.join(influencers.INFLUENCERS_DIR, 'claudia')), { code: 'ENOENT' });
  await assert.rejects(influencers.duplicateInfluencer('claudia', { viewer: alice, consent: 'true' }), code('INFLUENCER_CONSENT_REQUIRED'));
  const copy = await influencers.duplicateInfluencer('claudia', { viewer: guest, consent: true });
  ids.add(copy.id);
  assert.equal(copy.owner, guest.email);
  assert.equal(copy.name, 'Claudia (Kopie)');
  assert.equal(copy.consent.by, guest.email);
  assert.equal(copy.images.length, 3);
  assert.equal(copy.full, claudia.full);
  for (let i = 0; i < copy.images.length; i++) assert.deepEqual(await influencers.readInfluencerAsset(copy.id, copy.images[i]), await influencers.readInfluencerAsset('claudia', claudia.images[i]));
  await influencers.updateInfluencer(item.id, { name: 'A'.repeat(60) });
  const ownCopy = await influencers.duplicateInfluencer(item.id, { viewer: alice, consent: true });
  ids.add(ownCopy.id);
  assert.equal(ownCopy.images.length, 5);
  assert.equal(ownCopy.name, `${'A'.repeat(52)} (Kopie)`);
  await assert.rejects(influencers.duplicateInfluencer(item.id, { viewer: bob, consent: true }), code('INFLUENCER_NOT_FOUND'));
  const adminCopy = await influencers.duplicateInfluencer(item.id, { viewer: admin, consent: true });
  ids.add(adminCopy.id);
  assert.equal(adminCopy.owner, admin.email);
  assert.equal(adminCopy.consent.by, admin.email);

  const limitViewer = { ...alice, email: 'limit@example.test' };
  assert.equal(await influencers.countOwnedBy(limitViewer.email), 0);
  for (let i = 0; i < 9; i++) await create({}, { viewer: limitViewer });
  const results = await Promise.allSettled([create({}, { viewer: limitViewer }), create({}, { viewer: limitViewer })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'INFLUENCER_LIMIT');
  assert.equal(await influencers.countOwnedBy(' LIMIT@EXAMPLE.TEST '), 10);
  await assert.rejects(influencers.duplicateInfluencer('claudia', { viewer: limitViewer, consent: true }), code('INFLUENCER_LIMIT'));
  while (await influencers.countOwnedBy(admin.email) < 10) await create({}, { viewer: admin });
  await assert.rejects(create({}, { viewer: admin }), code('INFLUENCER_LIMIT'));
  await assert.rejects(influencers.duplicateInfluencer('claudia', { viewer: admin, consent: true }), code('INFLUENCER_LIMIT'));
}

async function sharingTests(item, legacy) {
  const legacyRaw = { ...legacy };
  delete legacyRaw.owner;
  delete legacyRaw.open;
  await influencers.writeInfluencer(legacyRaw);
  assert.equal((await influencers.readInfluencer(legacy.id)).open, false);
  // Old and hand-edited records only opt into sharing with the literal boolean true.
  for (const open of [undefined, 'true', 1, null, {}, false, true]) {
    const raw = { ...item, open };
    if (open === undefined) delete raw.open;
    await influencers.writeInfluencer(raw);
    assert.equal((await influencers.readInfluencer(item.id)).open, open === true);
  }
  for (const value of ['true', 1, null, {}, [], undefined]) {
    await assert.rejects(influencers.updateInfluencer(item.id, { open: value }), code('INFLUENCER_INVALID'));
  }
  const isUnconfirmed = access.isUnconfirmed;
  // access.isUnconfirmed recognises an active caller without email while restrictions are enabled.
  const restrictionActive = { AUTH_WHOAMI_URL: 'http://127.0.0.1/unused', INTERNAL_EMAIL_DOMAINS: 'example.test' };
  assert.equal(isUnconfirmed(unconfirmed, restrictionActive), true);
  access.isUnconfirmed = (viewer) => isUnconfirmed(viewer, restrictionActive);
  try {
    for (const record of [item, legacy]) {
      for (const open of [false, true]) {
        await influencers.updateInfluencer(record.id, { open });
        for (const [role, viewer] of Object.entries(viewers)) {
          const visible = record === legacy
            ? !access.isRestricted(viewer) || (open && Boolean(viewer.email))
            : ['alice', 'admin'].includes(role) || (open && Boolean(viewer.email));
          if (visible) assert.equal((await influencers.readVisibleInfluencer(record.id, viewer)).id, record.id, `${role} open=${open}`);
          else await assert.rejects(influencers.readVisibleInfluencer(record.id, viewer), code('INFLUENCER_NOT_FOUND'));
          assert.equal((await influencers.listInfluencers({ viewer })).some((entry) => entry.id === record.id), visible);
          if (visible) assert.equal(await influencers.resolveInfluencerId(record.id, { viewer }), record.id);
          else await assert.rejects(influencers.resolveInfluencerId(record.id, { viewer }), code('INFLUENCER_NOT_FOUND'));
        }
      }
    }
    await assert.rejects(influencers.readEditableInfluencer(item.id, bob), /gehoert jemand anderem.*Lege eine Kopie an/);
    await assert.rejects(influencers.duplicateInfluencer(item.id, { viewer: bob }), code('INFLUENCER_CONSENT_REQUIRED'));
    const copy = await influencers.duplicateInfluencer(item.id, { viewer: bob, consent: true });
    ids.add(copy.id);
    assert.equal(copy.open, false);
    assert.equal(copy.owner, bob.email);
  } finally {
    access.isUnconfirmed = isUnconfirmed;
    await influencers.updateInfluencer(item.id, { open: false });
    await influencers.updateInfluencer(legacy.id, { open: false });
  }
}

async function claimTests() {
  const claimant = { ...admin, email: 'claimant@example.test' };
  const legacy = await create({}, { viewer: null });
  const summary = (viewer, record = legacy) => influencers.influencerSummary(record, { viewer });
  for (const viewer of [alice, guest, anonymous, { ...admin, active: false }, { ...admin, email: null }]) {
    assert.equal(summary(viewer).claimable, false);
    await assert.rejects(influencers.updateInfluencer(legacy.id, { claim: true }, { viewer }), code('INFLUENCER_FORBIDDEN'));
  }
  await assert.rejects(influencers.updateInfluencer(legacy.id, { claim: true }), code('INFLUENCER_FORBIDDEN'));
  for (const claim of [false, 'yes', 1, null, {}, undefined]) {
    await assert.rejects(influencers.updateInfluencer(legacy.id, { claim }, { viewer: claimant }), code('INFLUENCER_INVALID'));
  }
  assert.equal(summary(claimant).claimable, true);
  assert.equal(summary(claimant, await influencers.readInfluencer('claudia')).claimable, false);
  assert.equal(summary(claimant, { ...legacy, id: undefined }).claimable, false);
  const patched = await influencers.updateInfluencer(legacy.id, { open: true, name: 'Unclaimed' }, { viewer: claimant });
  assert.equal(patched.owner, null, 'normal admin edits never claim a legacy record');
  const claimed = await influencers.updateInfluencer(legacy.id, { claim: true, open: false, name: 'Claimed' }, { viewer: claimant });
  assert.equal(claimed.owner, claimant.email);
  assert.equal(claimed.name, 'Claimed');
  assert.equal(claimed.open, false);
  assert.equal('claim' in claimed, false);
  assert.equal(summary(claimant, claimed).claimable, false);
  await assert.rejects(influencers.updateInfluencer(legacy.id, { claim: true, name: 'Overwrite' }, { viewer: admin }), code('INFLUENCER_OWNED'));
  assert.equal((await influencers.readInfluencer(legacy.id)).name, 'Claimed');
  for (let i = 0; i < 8; i++) await create({}, { viewer: claimant });
  const candidates = await Promise.all([create({}, { viewer: null }), create({}, { viewer: null })]);
  // New records, copies and different claims all compete for the same final slot.
  const results = await Promise.allSettled([
    create({}, { viewer: claimant }),
    influencers.duplicateInfluencer('claudia', { viewer: claimant, consent: true }).then((copy) => { ids.add(copy.id); return copy; }),
    ...candidates.map((candidate) => influencers.updateInfluencer(candidate.id, { claim: true }, { viewer: claimant }))
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'INFLUENCER_LIMIT'));
  assert.equal(await influencers.countOwnedBy(claimant.email), 10);
  const unclaimed = await create({}, { viewer: null });
  await assert.rejects(influencers.updateInfluencer(unclaimed.id, { claim: true, open: true }, { viewer: claimant }), code('INFLUENCER_LIMIT'));
  assert.equal((await influencers.readInfluencer(unclaimed.id)).owner, null);
  assert.equal((await influencers.readInfluencer(unclaimed.id)).open, false);
  const contested = await create({}, { viewer: null });
  const contenders = [admin, claimant].map((viewer, index) => ({ ...viewer, email: `contender-${index}@example.test` }));
  const claims = await Promise.allSettled(contenders.map((viewer) => influencers.updateInfluencer(contested.id, { claim: true }, { viewer })));
  assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(claims.find((result) => result.status === 'rejected').reason.code, 'INFLUENCER_OWNED');
}

async function apiTests() {
  const originalViewerOf = access.viewerOf;
  const apiAdmin = { ...admin, email: 'api-admin@example.test' };
  // Exercise the real HTTP parsers and routes with fixed local test identities.
  access.viewerOf = (req) => ({ ...viewers, apiAdmin }[req.headers?.['x-test-viewer']] || alice);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/influencers`;
  async function request(suffix = '', { method = 'GET', body, viewer = 'alice', raw, filename, contentType } = {}) {
    const response = await fetch(base + suffix, {
      method,
      headers: { 'x-test-viewer': viewer, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': contentType || 'application/octet-stream' } : {}), ...(filename ? { 'x-file-name': encodeURIComponent(filename) } : {}) },
      body: raw || (body === undefined ? undefined : JSON.stringify(body))
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(buffer.toString()) : null;
    return { status: response.status, body: json, buffer, headers: response.headers };
  }
  try {
    for (const consent of [undefined, 'true', false]) {
      const result = await request('', { method: 'POST', body: { ...data, consent } });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'INFLUENCER_CONSENT_REQUIRED');
    }
    for (const viewer of ['alice', 'guest', 'participant']) {
      const result = await request('', { method: 'POST', viewer, body: { ...data, consent: true, owner: bob.email } });
      assert.equal(result.status, 201);
      ids.add(result.body.id);
      assert.equal(result.body.owner, { alice, guest, participant }[viewer].email);
    }
    const created = await request('', { method: 'POST', body: { ...data, consent: true } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    ids.add(id);
    const listed = await request();
    assert.equal(listed.status, 200);
    assert.equal(listed.body.maxOwned, 10);
    assert.equal(listed.body.owned, await influencers.countOwnedBy(alice.email));
    assert.equal(listed.body.influencers[0].id, 'claudia');
    assert.equal((await request(`/${id}`)).body.editable, true);
    assert.equal((await request(`/${id}`, { viewer: 'admin' })).status, 200);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      assert.equal((await request(`/${id}`, { method, viewer: 'bob', ...(method === 'PATCH' ? { body: { name: 'Other' } } : {}) })).status, 404);
    }
    assert.equal((await request(`/${id}`, { method: 'PATCH', body: { name: 'Changed' } })).body.name, 'Changed');
    assert.equal((await request(`/${id}`, { method: 'PATCH', body: { consent: true } })).status, 400);
    assert.equal((await request('/missing')).status, 404);
    assert.equal((await request('/bad%20id')).status, 400);
    for (const method of ['PATCH', 'DELETE']) {
      const result = await request('/claudia', { method, viewer: 'admin', ...(method === 'PATCH' ? { body: { name: 'Other' } } : {}) });
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'INFLUENCER_READONLY');
    }
    assert.equal((await request(`/${id}/duplicate`, { method: 'POST', body: { consent: false } })).status, 400);
    assert.equal((await request(`/${id}/duplicate`, { method: 'POST', body: { consent: true }, viewer: 'bob' })).status, 404);
    const duplicate = await request('/claudia/duplicate', { method: 'POST', body: { consent: true }, viewer: 'guest' });
    assert.equal(duplicate.status, 201);
    ids.add(duplicate.body.id);
    assert.equal(duplicate.body.owner, guest.email);
    let upload = await request(`/${id}/images`, { method: 'POST', raw: png, filename: 'Portrait.PNG' });
    assert.equal(upload.status, 201);
    assert.deepEqual(upload.body.images, ['Portrait.png']);
    const asset = await request(`/${id}/assets/Portrait.png`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(asset.buffer, png);
    assert.equal((await request(`/${id}/assets/Portrait.png`, { viewer: 'bob' })).status, 404);
    assert.equal((await request(`/${id}/images`, { method: 'POST', raw: png, filename: 'Portrait.png', viewer: 'bob' })).status, 404);
    assert.equal((await request(`/${id}/images/Portrait.png`, { method: 'DELETE', viewer: 'bob' })).status, 404);
    assert.equal((await request(`/${id}/images/Portrait.png`, { method: 'DELETE' })).status, 200);
    assert.equal((await request(`/${id}/assets/Portrait.png`)).status, 404);
    upload = await request(`/${id}/images?filename=Query.png`, { method: 'POST', raw: png, contentType: 'image/png' });
    assert.equal(upload.status, 201);
    assert.deepEqual(upload.body.images, ['Query.png']);
    await apiSharingTests(request, id, apiAdmin);
    assert.equal((await request(`/${id}/images`, { method: 'POST', raw: png, filename: 'bad.jpg' })).status, 400);
    assert.equal((await request(`/${id}/images`, { method: 'POST', raw: Buffer.alloc(influencers.MAX_IMAGE_BYTES + 1), filename: 'large.png' })).status, 413);
    assert.equal((await request('/claudia/images', { method: 'POST', raw: png, filename: 'face.png' })).status, 403);
    const claudia = await influencers.readInfluencer('claudia');
    const builtinAsset = await request(`/claudia/assets/${claudia.images[0]}`, { viewer: 'guest' });
    assert.equal(builtinAsset.status, 200);
    assert.equal(builtinAsset.headers.get('content-type'), 'image/jpeg');
    assert.ok(builtinAsset.buffer.length > 1000);
    assert.equal((await request(`/claudia/images/${claudia.images[0]}`, { method: 'DELETE' })).status, 403);
    const shared = await create({}, { viewer: null });
    assert.equal((await request(`/${shared.id}`, { method: 'PATCH', body: { name: 'Other' } })).status, 403);
    assert.equal((await request(`/${shared.id}`, { viewer: 'guest' })).status, 404);
    assert.equal((await request(`/${id}`, { method: 'DELETE' })).status, 200);
    ids.delete(id);
    assert.equal((await request(`/${id}`)).status, 404);
    // Reach the HTTP conflict response without relying on unrelated test records.
    while (await influencers.countOwnedBy(bob.email) < 10) await create({}, { viewer: bob });
    assert.equal((await request('', { method: 'POST', viewer: 'bob', body: { ...data, consent: true } })).status, 409);
  } finally {
    access.viewerOf = originalViewerOf;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function apiSharingTests(request, id, apiAdmin) {
  const legacy = await create({ name: 'Legacy HTTP' }, { viewer: null });
  await influencers.saveInfluencerImage(legacy.id, { filename: 'Query.png', buffer: png });
  const raw = await influencers.readInfluencer(legacy.id);
  delete raw.open;
  delete raw.owner;
  raw.site = { slug: 'legacy-http', visibility: 'protected', allowedEmails: ['reader@example.test'] };
  await influencers.writeInfluencer(raw);
  for (const recordId of [id, legacy.id]) {
    for (const open of [false, true]) {
      const changed = await request(`/${recordId}`, { method: 'PATCH', viewer: 'admin', body: { open } });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.open, open);
      for (const [role, viewer] of Object.entries(viewers)) {
        const visible = recordId === legacy.id
          ? !access.isRestricted(viewer) || (open && Boolean(viewer.email))
          : ['alice', 'admin'].includes(role) || (open && Boolean(viewer.email));
        const detail = await request(`/${recordId}`, { viewer: role });
        const asset = await request(`/${recordId}/assets/Query.png`, { viewer: role });
        const listed = (await request('', { viewer: role })).body.influencers.find((entry) => entry.id === recordId);
        assert.equal(detail.status, visible ? 200 : 404, `${role} open=${open} detail`);
        assert.equal(asset.status, visible ? 200 : 404, `${role} open=${open} asset`);
        assert.equal(Boolean(listed), visible, `${role} open=${open} list`);
        if (visible) {
          const editable = role === 'admin' || (recordId === id && role === 'alice');
          const claimable = role === 'admin' && recordId === legacy.id;
          assert.equal(detail.body.open, open);
          assert.equal(detail.body.editable, editable);
          assert.equal(detail.body.own, recordId === id && role === 'alice');
          assert.equal(detail.body.claimable, claimable);
          assert.equal(listed.open, open);
          assert.equal(listed.editable, editable);
          assert.equal(listed.claimable, claimable);
          if (!editable) {
            assert.equal(detail.body.owner, null);
            assert.equal('by' in detail.body.consent, false);
            assert.equal('site' in detail.body, false, 'page settings (allowed e-mails) stay with the editors');
            assert.equal('owner' in listed, false);
          }
        }
      }
      // These paths must stop at the access check, before parsing missing proposals or contacting the host.
      for (const role of ['bob', 'participant', 'guest']) {
        for (const [method, suffix, body] of [
          ['PATCH', '', { open: false }], ['DELETE', ''],
          ['POST', '/images'], ['DELETE', '/images/Query.png'],
          ['GET', '/sheet'], ['POST', '/sheet', {}], ['GET', '/sheet/proposals/x.png'],
          ['POST', '/sheet/proposals/x.png/accept', {}], ['DELETE', '/sheet/proposals/x.png'],
          ['GET', '/site'], ['PATCH', '/site', {}], ['GET', '/site/slug?slug=ada'],
          ['POST', '/site/items', {}], ['DELETE', '/site/items/missing'],
          ['GET', '/site/preview'], ['GET', '/site/preview/assets/styles.css'], ['POST', '/site/publish', {}]
        ]) {
          const result = await request(`/${recordId}${suffix}`, { method, viewer: role, body,
            ...(suffix === '/images' ? { raw: png, filename: 'new.png' } : {}) });
          const visible = recordId === legacy.id ? role === 'bob' || open : open;
          assert.equal(result.status, visible ? 403 : 404, `${method} ${suffix}, ${role}, open=${open}`);
          assert.equal(result.body.code, visible ? 'INFLUENCER_FORBIDDEN' : 'INFLUENCER_NOT_FOUND');
        }
      }
    }
  }
  for (const open of ['true', 1, null, {}]) {
    const result = await request(`/${id}`, { method: 'PATCH', body: { open } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INFLUENCER_INVALID');
  }
  const deniedCopy = await request(`/${id}/duplicate`, { method: 'POST', viewer: 'bob', body: {} });
  assert.equal(deniedCopy.body.code, 'INFLUENCER_CONSENT_REQUIRED');
  const copy = await request(`/${id}/duplicate`, { method: 'POST', viewer: 'bob', body: { consent: true } });
  assert.equal(copy.status, 201);
  ids.add(copy.body.id);
  assert.equal(copy.body.owner, bob.email);
  assert.equal(copy.body.open, false);
  const made = await request('', { method: 'POST', viewer: 'apiAdmin', body: { ...data, consent: true, open: true } });
  assert.equal(made.status, 201);
  ids.add(made.body.id);
  assert.equal(made.body.owner, apiAdmin.email);
  assert.equal(made.body.open, false);
  assert.equal(influencers.ownerOf(await influencers.readInfluencer(legacy.id)), null);
  for (const claim of [false, 'yes']) {
    const result = await request(`/${legacy.id}`, { method: 'PATCH', viewer: 'apiAdmin', body: { claim } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INFLUENCER_INVALID');
  }
  const deniedClaim = await request(`/${legacy.id}`, { method: 'PATCH', body: { claim: true } });
  assert.equal(deniedClaim.status, 403);
  assert.equal(deniedClaim.body.code, 'INFLUENCER_FORBIDDEN');
  const limited = await request(`/${legacy.id}`, { method: 'PATCH', viewer: 'admin', body: { claim: true } });
  assert.equal(limited.status, 409);
  assert.equal(limited.body.code, 'INFLUENCER_LIMIT');
  const claimed = await request(`/${legacy.id}`, { method: 'PATCH', viewer: 'apiAdmin', body: { claim: true, name: 'Taken', open: true } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.owner, apiAdmin.email);
  assert.equal(claimed.body.open, true);
  assert.equal((await request(`/${legacy.id}`, { viewer: 'apiAdmin' })).body.claimable, false);
  const owned = await request(`/${legacy.id}`, { method: 'PATCH', viewer: 'apiAdmin', body: { claim: true } });
  assert.equal(owned.status, 409);
  assert.equal(owned.body.code, 'INFLUENCER_OWNED');
  await influencers.updateInfluencer(id, { open: false });
}

async function main() {
  try {
    await moduleTests();
    await apiTests();
  } finally {
    for (const id of ids) await influencers.deleteInfluencer(id);
  }
  console.log('test-influencers.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
