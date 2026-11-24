'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const sessions = require('../lib/store');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { reviewForAsset } = require('../lib/timeline/review-store');

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'timeline-review-'));
  let sequence = 0;
  let onDelete = null, deletionGate = null;
  const deleted = [];
  const store = createWorkflowsStore({ dir, sessions: {
    isValidId: sessions.isValidId, withLock: sessions.withLock,
    createSession: async () => ({ id: `session_${++sequence}` }),
    deleteSession: async (id) => {
      deleted.push(id);
      if (onDelete) { onDelete(); await deletionGate; }
    }
  } });
  try {
    const { workflow } = await store.createWorkflow({ name: 'Review test' });
    const id = workflow.id, reviews = store.timelineReviews;
    assert.deepEqual(await reviews.read(id), { nodes: {} });
    await reviews.setReview(id, 'cut', 'duet:0', { status: 'approved', assetId: 'asset_1', by: 'reviewer', at: '2026-11-24' });
    let record = (await reviews.read(id)).nodes.cut['duet:0'];
    assert.deepEqual(record, { status: 'approved', assetId: 'asset_1', by: 'reviewer', at: '2026-11-24', feedback: [] });
    assert.equal(reviewForAsset(record, 'asset_1').status, 'approved');
    assert.equal(reviewForAsset(record, 'asset_2').status, 'open');
    assert.equal(reviewForAsset(record, null).status, 'open');
    assert.equal(record.status, 'approved', 'merge is pure');

    await Promise.all(Array.from({ length: 16 }, (_, index) => reviews.appendFeedback(id, 'cut', 'duet:0', {
      text: `Feedback ${index}`, by: 'reviewer', at: String(index), was: `Original ${index}`, prompt: `New ${index}`
    })));
    record = (await reviews.read(id)).nodes.cut['duet:0'];
    assert.equal(record.status, 'open', 'feedback clears approval');
    assert.equal(record.feedback.length, 10);
    assert.deepEqual(record.feedback.map((entry) => entry.text), Array.from({ length: 10 }, (_, index) => `Feedback ${index + 6}`));
    assert.deepEqual(record.feedback.at(-1), { text: 'Feedback 15', by: 'reviewer', at: '15', was: 'Original 15', prompt: 'New 15' });
    await reviews.setReview(id, 'cut', 'duet:0', { status: 'approved', assetId: 'asset_2', by: 'reviewer' });
    record = (await reviews.read(id)).nodes.cut['duet:0'];
    assert.equal(reviewForAsset(record, 'asset_2').status, 'approved');
    assert.equal(reviewForAsset(record, 'asset_1').feedback.length, 10, 'history survives replacement');
    await reviews.setReview(id, 'cut', 'duet:0', { status: 'open' });
    assert.equal((await reviews.read(id)).nodes.cut['duet:0'].assetId, undefined);
    await reviews.setReview(id, 'other', 'duet:0', { status: 'approved', assetId: 'other_asset' });
    assert.equal((await reviews.read(id)).nodes.other['duet:0'].assetId, 'other_asset', 'cut nodes have independent keys');
    await assert.rejects(reviews.setReview(id, '__proto__', 'x', { status: 'open' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(reviews.setReview(id, 'cut', 'x', { status: 'approved' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(reviews.appendFeedback(id, 'cut', 'x', { text: 1 }), { code: 'INVALID_REQUEST' });
    await assert.rejects(reviews.read('../escape'), { code: 'INVALID_ID' });

    const file = path.join(dir, id, 'timeline-review.json');
    assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), await reviews.read(id));
    assert.deepEqual((await fsp.readdir(path.join(dir, id))).filter((name) => name.endsWith('.tmp')), []);
    const reloaded = createWorkflowsStore({ dir });
    assert.deepEqual(await reloaded.timelineReviews.read(id), await reviews.read(id));
    const copy = await store.duplicateWorkflow(id);
    assert.deepEqual(await reviews.read(copy.workflow.id), { nodes: {} }, 'duplicates start without approvals or feedback');
    await assert.rejects(fsp.access(path.join(dir, copy.workflow.id, 'timeline-review.json')), { code: 'ENOENT' });
    await store.deleteWorkflow(copy.workflow.id);
    // An update queued behind deletion must not recreate the folder.
    let resumeDeletion;
    const deletionStarted = new Promise((resolve) => { onDelete = resolve; });
    deletionGate = new Promise((resolve) => { resumeDeletion = resolve; });
    const removal = store.deleteWorkflow(id);
    await deletionStarted;
    const lateWrite = assert.rejects(reviews.setReview(id, 'cut', 'scene:0', { status: 'approved', assetId: 'late' }), { code: 'WORKFLOW_NOT_FOUND' });
    resumeDeletion();
    await removal;
    await lateWrite;
    await assert.rejects(fsp.access(file), { code: 'ENOENT' });
    await assert.rejects(fsp.access(path.join(dir, id)), { code: 'ENOENT' });
    assert.ok(deleted.includes(workflow.sessionId));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-timeline-review-store.js: ok');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
