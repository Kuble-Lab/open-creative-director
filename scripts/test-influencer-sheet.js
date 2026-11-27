'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');

const moduleOnly = process.argv.includes('--module-only');
const ADMIN = 'admin@example.com';
const STAFF = 'ada@staff.example.com';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const model = 'google/gemini-nano-banana-2.1';
const config = { imageModel: model };
const code = (expected) => (err) => err.code === expected;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = () => ({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.05 } });

async function main() {
  const realFetch = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = String(input?.url || input);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error('External network forbidden in this test'));
    }
    return realFetch(input, init);
  };
  const iso = await createIsolatedApp({ env: {
    ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
    OPENROUTER_API_KEY: 'dummy-sheet-test-key-000000', GEMINI_API_KEY: '', GTS_API_TOKEN: '', PUBLIC_BASE_URL: ''
  }, config, loadServer: !moduleOnly });
  const sheet = iso.load('lib/influencer-sheet');
  const discovery = iso.load('lib/discovery');
  const oldList = discovery.listImageModels;
  discovery.listImageModels = async () => ({ data: [] });
  if (!moduleOnly) await iso.listen();
  try {
    await run(iso);
    assert.deepEqual(attempts, [], 'no external provider or discovery calls');
  } finally {
    sheet.setImageCallForTests(null);
    discovery.listImageModels = oldList;
    await iso.cleanup();
    global.fetch = realFetch;
  }
  console.log('test-influencer-sheet.js: ok');
}

async function run(iso) {
  const inf = iso.load('lib/influencers');
  const sheet = iso.load('lib/influencer-sheet');
  const costs = iso.load('lib/costs');
  const budget = iso.load('lib/budget');
  const teams = iso.load('lib/teams');
  const access = iso.load('lib/access');
  const viewer = { active: true, identified: true, admin: false, email: STAFF, kind: 'internal' };
  const calls = [];
  const fake = async (payload) => { calls.push(payload); return result(); };
  sheet.setImageCallForTests(fake);
  const create = (as = viewer) => inf.createInfluencer({ name: 'Ada', full: 'An adult woman with black hair', looks: 'Blue eyes', face: 'Oval face', style: 'Plain clothes', never: 'red hats' }, { viewer: as, consent: true });
  const rows = async () => (await costs.readCosts()).filter((row) => row.sessionId === sheet.COST_SESSION);
  const begin = async (id, options = {}) => {
    const as = options.viewer || viewer;
    const cfg = options.config || config;
    const info = await sheet.status(id, { viewer: as, config: cfg });
    return sheet.start(id, { viewer: as, user: as.email, config: cfg, confirmed: true, confirmedUsd: info.estimate.usd, ...options });
  };
  let item = await create();
  assert.ok(Object.isFrozen(sheet.SHOTS));
  assert.ok(sheet.SHOTS.every(Object.isFrozen));
  const base = (await sheet.status(item.id, { viewer, config })).estimate;
  assert.deepEqual([base.count, base.model, base.usd, base.references, base.available, base.reason], [4, model, 0.14104, 0, true, null]);
  assert.ok(base.modelLabel);
  assert.equal((await sheet.estimate(item, { viewer, config: { imageModel: 'example/image-without-price' } })).usd, null);
  assert.equal((await sheet.estimate(item, { viewer, config: { imageModel: '' } })).reason, 'no_model');
  await assert.rejects(begin(item.id, { config: { imageModel: '' } }), (err) => err.code === 'INFLUENCER_SHEET_UNAVAILABLE' && err.reason === 'no_model');
  iso.setEnv('OPENROUTER_API_KEY', '');
  assert.equal((await sheet.estimate(item, { viewer, config })).reason, 'no_key');
  await assert.rejects(begin(item.id), (err) => err.code === 'INFLUENCER_SHEET_UNAVAILABLE' && err.reason === 'no_key');
  iso.setEnv('OPENROUTER_API_KEY', 'dummy-sheet-test-key-000000');
  for (const confirmed of [undefined, false, 'true']) {
    await assert.rejects(sheet.start(item.id, { viewer, config, confirmed }), code('INFLUENCER_SHEET_CONFIRM_REQUIRED'));
  }
  await assert.rejects(begin(item.id, { confirmedUsd: 1 }), (err) => err.code === 'INFLUENCER_SHEET_ESTIMATE_CHANGED' && err.estimate.usd === base.usd);
  await assert.rejects(begin(item.id, { confirmedUsd: String(base.usd) }), code('INFLUENCER_SHEET_ESTIMATE_CHANGED'));
  assert.equal(calls.length, 0);

  // Sequential views and accounting; proposals do not change the saved references.
  const first = await begin(item.id, { confirmedUsd: base.usd + 0.004 });
  assert.equal(first.job.state, 'running');
  const done = await first.finished;
  assert.deepEqual([done.state, done.done, done.total, done.costUsd, done.error], ['done', 4, 4, 0.2, null]);
  assert.ok(done.finishedAt);
  assert.deepEqual(calls.map((p) => p.aspect_ratio), ['3:4', '3:4', '3:4', '9:16']);
  assert.deepEqual(calls.map((p) => p.input_references?.length || 0), [0, 1, 2, 3]);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.model, model);
    assert.equal(call.n, 1);
    for (const text of [item.full, item.looks, item.face, item.style, `Never show: ${item.never}`, 'light-grey seamless studio background', sheet.SHOTS[i].description]) assert.ok(call.prompt.includes(text), text);
  }
  let proposals = await sheet.listProposals(item.id);
  assert.deepEqual(proposals.map((p) => p.shot), ['front', 'threequarter', 'profile', 'fullbody']);
  assert.equal((await inf.readInfluencer(item.id)).images.length, 0);
  assert.equal((await rows()).length, 4);
  for (const row of await rows()) assert.deepEqual([row.type, row.model, row.user, row.cost], ['image', model, STAFF, 0.05]);
  await assert.rejects(inf.readInfluencerAsset(item.id, proposals[0].file), code('INFLUENCER_NOT_FOUND'));

  // Acceptance applies the normal six-image limit; failures preserve the proposal.
  const accepted = await sheet.acceptProposal(item.id, proposals[0].file);
  assert.equal(accepted.influencer.images.length, 1);
  assert.equal(accepted.proposals.length, 3);
  await assert.rejects(sheet.readProposal(item.id, proposals[0].file), code('INFLUENCER_NOT_FOUND'));
  for (let i = 1; i < 6; i++) await inf.saveInfluencerImage(item.id, { filename: `ref-${i}.png`, buffer: Buffer.concat([png, Buffer.from([i])]) });
  await assert.rejects(sheet.acceptProposal(item.id, proposals[1].file), (err) => err.code === 'INFLUENCER_INVALID' && err.message === 'Pro Influencer sind maximal 6 Bilder erlaubt');
  assert.ok(await sheet.readProposal(item.id, proposals[1].file));
  assert.equal((await sheet.discardProposal(item.id, proposals[1].file)).proposals.length, 2);
  for (const file of ['../influencer.json', 'x.png', 'sheet-front-00000000.png']) {
    for (const fn of [sheet.readProposal, sheet.acceptProposal, sheet.discardProposal]) await assert.rejects(fn(item.id, file), code('INFLUENCER_NOT_FOUND'));
  }
  item = await inf.readInfluencer(item.id);
  const estimate = await sheet.estimate(item, { viewer, config });
  assert.equal(estimate.references, 6);
  assert.equal(estimate.usd, 0.1612);
  calls.length = 0;
  await (await begin(item.id)).finished;
  assert.deepEqual(calls.map((p) => p.input_references.length), [6, 7, 8, 9]);
  const firstUrl = `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(calls[0].input_references[0].image_url.url, firstUrl);
  for (const call of calls.slice(1)) assert.deepEqual(call.input_references.slice(0, 6), calls[0].input_references);
  assert.equal(calls[1].input_references[6].image_url.url, firstUrl);
  const copy = await inf.duplicateInfluencer(item.id, { viewer, consent: true });
  assert.equal(copy.images.length, 6);
  assert.deepEqual(await sheet.listProposals(copy.id), []);
  calls.length = 0;
  await (await begin(copy.id, { config: { imageModel: 'unknown/model' } })).finished;
  assert.equal(calls.length, 4);
  assert.ok(calls.every((p) => !('input_references' in p)));

  // Existing ownership and shared-object rules are checked before any generation.
  await assert.rejects(begin(item.id, { viewer: { ...viewer, email: 'other@staff.example.com' } }), code('INFLUENCER_NOT_FOUND'));
  await assert.rejects(begin('claudia'), code('INFLUENCER_READONLY'));
  const shared = await create(null);
  await assert.rejects(begin(shared.id), code('INFLUENCER_FORBIDDEN'));
  const team = teams.createTeam({ name: 'Sheet testers', budgetUsd: 0.01 });
  const participant = { ...viewer, email: 'participant@example.com', kind: 'participant' };
  const guest = { ...viewer, email: 'guest@example.com', kind: 'guest' };
  teams.addMembers(team.id, [participant.email]);
  const poor = await create(participant);
  const guestItem = await create(guest);
  const beforeBudget = (await rows()).length;
  const beforeCalls = calls.length;
  assert.equal((await sheet.estimate(poor, { viewer: participant, config })).reason, 'budget');
  await assert.rejects(begin(poor.id, { viewer: participant }), (err) => err instanceof budget.BudgetError && err.code === 'BUDGET_INSUFFICIENT');
  await assert.rejects(begin(guestItem.id, { viewer: guest }), (err) => err instanceof budget.BudgetError && err.code === 'BUDGET_EXHAUSTED');
  assert.equal(calls.length, beforeCalls);
  assert.equal((await rows()).length, beforeBudget);
  teams.updateTeam(team.id, { budgetUsd: 1 });
  await (await begin(poor.id, { viewer: participant })).finished;
  assert.equal((await budget.status(participant)).spentUsd, 0.2);
  assert.equal((await budget.status(participant)).reservedUsd, 0);
  assert.equal(access.isRestricted(participant), true);

  // The first failure stops work; a refused bill is accounted exactly once.
  const partial = await create();
  let count = 0;
  sheet.setImageCallForTests(async () => { if (++count === 3) throw new Error('Testfehler'); return result(); });
  const beforePartial = (await rows()).length;
  const partialDone = await (await begin(partial.id)).finished;
  assert.match(partialDone.error, /3\. Bild.*Testfehler/);
  assert.equal(partialDone.done, 2);
  assert.equal((await sheet.listProposals(partial.id)).length, 2);
  assert.equal((await rows()).length - beforePartial, 2);
  sheet.setImageCallForTests(async () => { throw Object.assign(new Error('IMAGE_SAFETY'), { status: 400, body: JSON.stringify({ usage: { cost: 0.07 } }) }); });
  const safety = await (await begin(partial.id)).finished;
  assert.equal(safety.costUsd, 0.07);
  assert.equal(safety.done, 0);
  assert.equal((await rows()).length - beforePartial, 3);

  sheet.setImageCallForTests(async () => ({ data: [], usage: { cost: 0.03 } }));
  const empty = await (await begin(partial.id)).finished;
  assert.match(empty.error, /keine Bilddaten/);
  assert.equal(empty.done, 0);
  assert.equal(empty.costUsd, 0.03);
  assert.equal((await rows()).length - beforePartial, 4, 'a paid response without bytes is still booked once');

  // Reservation is synchronous even when two starts arrive together.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  sheet.setImageCallForTests(async (payload) => { await gate; return fake(payload); });
  const options = { viewer, user: STAFF, config, confirmed: true, confirmedUsd: base.usd };
  const [a, b] = await Promise.allSettled([sheet.start(partial.id, options), sheet.start(partial.id, options)]);
  const winner = [a, b].filter((entry) => entry.status === 'fulfilled');
  const loser = [a, b].filter((entry) => entry.status === 'rejected');
  assert.equal(winner.length, 1);
  assert.equal(loser.length, 1);
  assert.equal(loser[0].reason.code, 'INFLUENCER_SHEET_BUSY');
  for (const fn of [sheet.acceptProposal, sheet.discardProposal]) await assert.rejects(fn(partial.id, 'x.png'), code('INFLUENCER_SHEET_BUSY'));
  assert.equal((await sheet.status(partial.id, { viewer, config })).job.state, 'running');
  release();
  await winner[0].value.finished;
  const old = await sheet.listProposals(partial.id);
  sheet.setImageCallForTests(fake);
  await (await begin(partial.id)).finished;
  const renewed = await sheet.listProposals(partial.id);
  assert.equal(renewed.length, 4);
  assert.ok(old.every((p) => !renewed.some((next) => next.file === p.file)));

  const expiredPath = path.join(inf.influencerAssetsDir(partial.id), 'proposals', renewed[0].file);
  const oldDate = new Date(Date.now() - sheet.PROPOSAL_TTL_MS - 1000);
  await fsp.utimes(expiredPath, oldDate, oldDate);
  assert.equal((await sheet.listProposals(partial.id)).length, 3);
  await assert.rejects(fsp.stat(expiredPath), { code: 'ENOENT' });

  // A deleted influencer is never recreated by an in-flight provider response.
  const doomed = await create();
  let answer;
  sheet.setImageCallForTests(() => new Promise((resolve) => { answer = resolve; }));
  const pending = await begin(doomed.id);
  while (!answer) await sleep(2);
  await inf.deleteInfluencer(doomed.id);
  answer(result());
  assert.equal((await pending.finished).error, null);
  await assert.rejects(fsp.stat(inf.influencerDir(doomed.id)), { code: 'ENOENT' });
  sheet.setImageCallForTests(fake);

  if (moduleOnly) return;

  // The actual Express app: response shapes, bytes and rights on every sheet route.
  const httpItem = await create();
  const url = `/api/influencers/${httpItem.id}/sheet`;
  const request = (suffix = '', options = {}) => iso.request(url + suffix, { as: STAFF, ...options });
  assert.equal((await request()).body.job, null);
  assert.equal((await request('', { method: 'POST', json: {} })).body.code, 'INFLUENCER_SHEET_CONFIRM_REQUIRED');
  assert.equal((await request('', { method: 'POST', json: {} })).status, 400);
  const changed = await request('', { method: 'POST', json: { confirmed: true, confirmedUsd: 9 } });
  assert.equal(changed.status, 409);
  assert.ok(changed.body.estimate);
  const posted = await request('', { method: 'POST', json: { confirmed: true, confirmedUsd: base.usd } });
  assert.equal(posted.status, 202);
  assert.equal(posted.body.job.state, 'running');
  let status;
  for (let i = 0; i < 200; i++) {
    status = (await request()).body;
    if (status.job.state === 'done') break;
    await sleep(2);
  }
  assert.equal(status.job.done, 4);
  assert.equal(status.imageCount, 0);
  assert.equal(status.maxImages, 6);
  const bytes = await request(`/proposals/${status.proposals[0].file}`, { raw: true });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
  assert.match(bytes.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
  const accept = await request(`/proposals/${status.proposals[0].file}/accept`, { method: 'POST', json: {} });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.influencer.editable, true);
  assert.equal(accept.body.influencer.images.length, 1);
  const discard = await request(`/proposals/${status.proposals[1].file}`, { method: 'DELETE' });
  assert.equal(discard.status, 200);
  assert.equal(discard.body.proposals.length, 2);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['GET', '/proposals/x.png'], ['POST', '/proposals/x.png/accept'], ['DELETE', '/proposals/x.png']]) {
    for (const [id, as, expected] of [['claudia', STAFF, 403], [httpItem.id, 'other@staff.example.com', 404], [shared.id, STAFF, 403]]) {
      const response = await iso.request(`/api/influencers/${id}/sheet${suffix}`, { method, as, ...(method === 'POST' ? { json: {} } : {}) });
      assert.equal(response.status, expected, `${method} ${suffix} ${id}`);
    }
  }
  await inf.updateInfluencer(httpItem.id, { open: true });
  for (const as of ['other@staff.example.com', guest.email]) {
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['GET', '/proposals/x.png'], ['POST', '/proposals/x.png/accept'], ['DELETE', '/proposals/x.png']]) {
      const response = await iso.request(url + suffix, { method, as, ...(method === 'POST' ? { json: {} } : {}) });
      assert.equal(response.status, 403);
      assert.equal(response.body.code, 'INFLUENCER_FORBIDDEN');
    }
  }
  const refused = await iso.request(`/api/influencers/${guestItem.id}/sheet`, { method: 'POST', as: guest.email, json: { confirmed: true, confirmedUsd: base.usd } });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'BUDGET_EXHAUSTED');
  iso.setEnv('OPENROUTER_API_KEY', '');
  const unavailable = await request('', { method: 'POST', json: { confirmed: true, confirmedUsd: base.usd } });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.reason, 'no_key');
  await inf.deleteInfluencer(partial.id);
  assert.deepEqual(await sheet.listProposals(partial.id), []);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
