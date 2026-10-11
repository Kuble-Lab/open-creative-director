'use strict';

// Regression (live 2026-10-11): a session had finished render jobs of vid-007, vid-009 and vid-011 whose parts were removed from
// the ledger afterwards. The next fal clips got vid-007 to vid-010 again (nextId counted the ledger only), and then
//   - waitForSessionJob found the old, finished render job of vid-007 by its assetId and the node failed at once
//     ("Asset vid-007 is not finished yet"), although all four paid clips finished shortly after;
//   - the poller wrote the result of the new fal job into the old render job, and the new one stayed open.
// Asset ids of a session are now never given out twice, and jobs are found by jobId and assetId together.
// Runs in its own temporary data folder; no provider calls.

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PATHS } = require('../lib/config');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function job(fields) {
  return {
    status: 'pending',
    kind: 'video',
    createdAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    cost: null,
    error: null,
    ...fields
  };
}

async function reserveVideos(store, sessionId, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push((await store.reserveAsset(sessionId, { kind: 'video', ext: '.mp4', prompt: `clip ${i}` })).id);
  return ids;
}

async function dropFromLedger(store, sessionId, ids) {
  await store.withLock(sessionId, async () => {
    const entries = await store.readLedger(sessionId);
    await store.writeLedger(sessionId, entries.filter((entry) => !ids.includes(entry.id)));
  });
}

async function testRemovedAssetsKeepTheirNumbers(store) {
  const session = await store.createSession({ kind: 'workflow', title: 'Workflow: ids' });
  // eleven parts of a render; three of them have render jobs and are removed after the render (file and ledger entry gone)
  const parts = await reserveVideos(store, session.id, 11);
  assert.deepEqual(parts.slice(0, 3), ['vid-001', 'vid-002', 'vid-003']);
  assert.equal(parts[10], 'vid-011');
  await store.mutateSession(session.id, (saved) => {
    for (const id of ['vid-007', 'vid-009', 'vid-011']) {
      saved.jobs.push(job({ jobId: `render-${id}`, assetId: id, source: 'rendernode', status: 'completed', resultAssetIds: [id] }));
    }
  });
  for (const id of ['vid-007', 'vid-009', 'vid-011']) await store.completeAsset(session.id, id, Buffer.from('part'));
  assert.deepEqual((await store.removeAssets(session.id, ['vid-007', 'vid-009', 'vid-011'])).sort(), ['vid-007', 'vid-009', 'vid-011']);

  // four fal clips, then more: never a number the session had before
  const clips = await reserveVideos(store, session.id, 4);
  assert.deepEqual(clips, ['vid-012', 'vid-013', 'vid-014', 'vid-015']);
  const more = await reserveVideos(store, session.id, 3);
  assert.deepEqual(more, ['vid-016', 'vid-017', 'vid-018']);

  // a reservation given back (removeReserved) and a temporary asset without a job (removeAssets) keep their numbers too:
  // they are in neither the ledger nor the jobs any more, only in the high-water file
  await dropFromLedger(store, session.id, ['vid-018']);
  const saved = await store.saveAsset(session.id, { kind: 'video', buffer: Buffer.from('temp'), ext: '.mp4', prompt: 'temp' });
  assert.equal(saved.id, 'vid-019', 'saveAsset must not take the number of a given-back reservation');
  assert.deepEqual(await store.removeAssets(session.id, [saved.id]), ['vid-019']);
  assert.deepEqual(await reserveVideos(store, session.id, 1), ['vid-020']);

  // other kinds count on their own and keep the format
  const image = await store.saveAsset(session.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'img' });
  assert.equal(image.id, 'img-001');
  assert.deepEqual(await store.removeAssets(session.id, [image.id]), ['img-001']);
  const upload = await store.reserveAsset(session.id, { kind: 'upload', ext: '.png', prompt: 'upload' });
  assert.equal(upload.id, 'upload-001');
  const image2 = await store.saveAsset(session.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'img 2' });
  assert.equal(image2.id, 'img-002');

  // reservations at the same time stay unique (all of them run under the session lock)
  const parallel = await Promise.all(
    Array.from({ length: 6 }, (_, i) => store.reserveAsset(session.id, { kind: 'video', ext: '.mp4', prompt: `parallel ${i}` }))
  );
  const parallelIds = parallel.map((entry) => entry.id).sort();
  assert.deepEqual(parallelIds, ['vid-021', 'vid-022', 'vid-023', 'vid-024', 'vid-025', 'vid-026']);

  const marks = JSON.parse(await fsp.readFile(path.join(store.sessionAssetDir(session.id), 'asset-ids.json'), 'utf8'));
  assert.deepEqual(marks, { vid: 26, img: 2, upload: 1 });
}

async function testSessionsFromBeforeTheFile(store) {
  // an old session: no high-water file; the ledger has vid-001 and vid-003, the jobs name vid-009 and a result vid-010
  const session = await store.createSession();
  const dir = store.sessionAssetDir(session.id);
  await fsp.mkdir(dir, { recursive: true });
  await store.writeLedger(session.id, [
    { id: 'vid-001', file: 'vid-001.mp4', kind: 'video', prompt: '', createdAt: new Date().toISOString(), cost: null },
    { id: 'vid-003', file: 'vid-003.mp4', kind: 'video', prompt: '', createdAt: new Date().toISOString(), cost: null },
    { id: 'img-004', file: 'img-004.png', kind: 'image', prompt: '', createdAt: new Date().toISOString(), cost: null }
  ]);
  await store.mutateSession(session.id, (saved) => {
    saved.jobs.push(job({ jobId: 'render-a', assetId: 'vid-009', source: 'rendernode', status: 'completed', resultAssetIds: ['vid-009', 'vid-010'] }));
  });
  const [next] = await reserveVideos(store, session.id, 1);
  assert.equal(next, 'vid-011', 'an old session starts above every number of its ledger and jobs');
  const image = await store.reserveAsset(session.id, { kind: 'image', ext: '.png' });
  assert.equal(image.id, 'img-005');

  // vid-011 leaves the ledger and every job goes: only the high-water file still knows the numbers up to vid-011 (the old way
  // counted the two videos of the ledger and gave vid-004)
  await dropFromLedger(store, session.id, ['vid-011']);
  await store.mutateSession(session.id, (saved) => {
    saved.jobs = [];
  });
  const [after] = await reserveVideos(store, session.id, 1);
  assert.equal(after, 'vid-012', 'an asset gone from ledger and jobs keeps its number through the high-water file');

  // a broken high-water file does not stop new assets; the ledger still decides
  await fsp.writeFile(path.join(dir, 'asset-ids.json'), '{ broken', 'utf8');
  const [repaired] = await reserveVideos(store, session.id, 1);
  assert.equal(repaired, 'vid-013');
}

function testFindSessionJob(store, poller) {
  const oldRender = job({ jobId: 'render-7', assetId: 'vid-007', source: 'rendernode', status: 'completed' });
  const newFal = job({ jobId: 'fal-req-7', assetId: 'vid-007', source: 'fal' });
  const list = [oldRender, newFal];

  assert.equal(store.findSessionJob(list, { jobId: 'fal-req-7', assetId: 'vid-007' }), newFal, 'jobId and assetId together');
  assert.equal(store.findSessionJob(list, { jobId: 'render-7', assetId: 'vid-007' }), oldRender);
  assert.equal(store.findSessionJob(list, { jobId: 'fal-req-7' }), newFal, 'jobId alone');
  assert.equal(store.findSessionJob(list, { assetId: 'vid-007' }), newFal, 'assetId alone: the newest entry');
  assert.equal(store.findSessionJob(list, { jobId: 'gone', assetId: 'vid-007' }), newFal, 'assetId only as the fallback');
  assert.equal(store.findSessionJob(list, { jobId: 'gone', assetId: 'vid-999' }), null);
  assert.equal(store.findSessionJob(undefined, { jobId: 'x' }), null);

  // Higgsfield gave one job id to two orders: the assetId tells them apart (scripts/test-duplicate-job-ids.js)
  const first = job({ jobId: 'hf-dup', assetId: 'vid-001', source: 'higgsfield' });
  const second = job({ jobId: 'hf-dup', assetId: 'vid-002', source: 'higgsfield' });
  assert.equal(store.findSessionJob([first, second], { jobId: 'hf-dup', assetId: 'vid-001' }), first);
  assert.equal(store.findSessionJob([first, second], { jobId: 'hf-dup', assetId: 'vid-002' }), second);

  // the poller looks up through the same function and keys its in-flight set by both values
  assert.equal(poller.findJob({ jobs: list }, newFal), newFal);
  assert.equal(poller.findJob({ jobs: list }, oldRender), oldRender);
  assert.equal(poller.findJob({ jobs: [] }, newFal), undefined);
  assert.notEqual(poller.jobKey('s', oldRender), poller.jobKey('s', newFal));
  assert.notEqual(poller.jobKey('s', first), poller.jobKey('s', second));
}

async function testPollerWritesTheRightJob(store, poller) {
  // an old session with the reused number: the failure of the new fal job must land in the new entry, not the finished render job
  const session = await store.createSession();
  const asset = await store.reserveAsset(session.id, { kind: 'video', ext: '.mp4', prompt: 'fal clip' });
  const oldRender = job({ jobId: 'render-old', assetId: asset.id, source: 'rendernode', status: 'completed', cost: 0.2, resultAssetIds: [asset.id] });
  const newFal = job({ jobId: 'fal-new', assetId: asset.id, file: asset.file, source: 'fal', provider: 'fal', endpoint: 'fal-ai/test' });
  await store.mutateSession(session.id, (saved) => {
    saved.jobs.push(oldRender, newFal);
  });
  await poller.handleFailed(session.id, newFal, { error: 'test failure' });
  const after = await store.readSession(session.id);
  assert.equal(after.jobs[0].status, 'completed', 'the old render job stays as it was');
  assert.equal(after.jobs[0].error, null);
  assert.equal(after.jobs[1].status, 'failed', 'the new fal job gets the result');
}

async function testWaitForSessionJob(store, jobsLib) {
  const session = await store.createSession({ kind: 'workflow', title: 'Workflow: wait' });
  await store.mutateSession(session.id, (saved) => {
    saved.jobs.push(job({ jobId: 'render-7', assetId: 'vid-007', source: 'rendernode', status: 'completed', resultAssetIds: ['vid-007'] }));
    saved.jobs.push(job({ jobId: 'fal-req-7', assetId: 'vid-007', source: 'fal' }));
  });
  let settled = false;
  const statuses = [];
  const waiting = jobsLib
    .waitForSessionJob(session.id, 'fal-req-7', { assetId: 'vid-007', intervalMs: 20, timeoutMs: 10000, onStatus: (status) => statuses.push(status) })
    .then((ids) => {
      settled = true;
      return ids;
    });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, false, 'the finished old job of the same number must not end the wait');
  assert.deepEqual(statuses, ['pending']);

  // still open for the end-of-run budget hand-over (engine: openJobs / reassignBudget)
  assert.equal((await jobsLib.openJobs(session.id, [{ jobId: 'fal-req-7', assetId: 'vid-007' }])).length, 1);
  assert.deepEqual(await jobsLib.reassignBudget(session.id, [{ ref: { jobId: 'fal-req-7', assetId: 'vid-007' }, budgetKey: 'k', reservedUsd: 1 }]), []);
  const reassigned = await store.readSession(session.id);
  assert.equal(reassigned.jobs[1].budgetKey, 'k');
  assert.equal(reassigned.jobs[0].budgetKey, undefined, 'the old job gets no budget key');

  await store.mutateSession(session.id, (saved) => {
    saved.jobs[1].status = 'completed';
    saved.jobs[1].resultAssetIds = ['vid-007'];
  });
  assert.deepEqual(await waiting, ['vid-007']);
  assert.deepEqual(statuses, ['pending', 'completed']);
  assert.equal((await jobsLib.openJobs(session.id, [{ jobId: 'fal-req-7', assetId: 'vid-007' }])).length, 0);
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-asset-id-reuse-'));
  PATHS.projectsDir = path.join(root, 'projects');
  PATHS.assetsDir = path.join(root, 'assets');
  await fsp.mkdir(PATHS.projectsDir, { recursive: true });
  await fsp.mkdir(PATHS.assetsDir, { recursive: true });
  const store = require('../lib/store');
  const poller = require('../lib/poller');
  const jobsLib = require('../lib/nodes/jobs');
  try {
    await testRemovedAssetsKeepTheirNumbers(store);
    await testSessionsFromBeforeTheFile(store);
    testFindSessionJob(store, poller);
    await testPollerWritesTheRightJob(store, poller);
    await testWaitForSessionJob(store, jobsLib);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
  console.log('test-asset-id-reuse.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
