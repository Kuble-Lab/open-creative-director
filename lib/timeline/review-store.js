'use strict';

const { isPlainObject } = require('../nodes/types');

// Shared by the view and the future render gate. Feedback survives an asset change; approval does not.
function reviewForAsset(record, assetId) {
  const feedback = Array.isArray(record?.feedback) ? record.feedback.slice(-10) : [];
  if (assetId && record?.status === 'approved' && record.assetId === assetId) return { ...record, feedback };
  return { status: 'open', feedback };
}

// The workflow store supplies its path, locks and atomic JSON writer. Taking the workflow lock first
// prevents an update queued behind deletion from recreating an orphan review file.
function createReviewStore({ fileFor, withLock, readWorkflow, readJson, writeJson, removeFile }) {
  const empty = () => ({ nodes: {} });
  const locked = (id, fn) => withLock(`wf:${id}`, () => withLock(`wf-timeline-review:${id}`, async () => {
    await readWorkflow(id);
    return fn();
  }));
  async function readFile(id) {
    try {
      const value = await readJson(fileFor(id));
      return isPlainObject(value) && isPlainObject(value.nodes) ? value : empty();
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      throw err;
    }
  }
  const read = (id) => locked(id, () => readFile(id));
  const update = (id, fn) => locked(id, async () => {
    const data = await readFile(id);
    const result = await fn(data);
    await writeJson(fileFor(id), data);
    return result;
  });
  function clipOf(data, nodeId, key) {
    // IDs and clip keys are object keys, never paths. Reject prototype keys at the storage boundary.
    for (const value of [nodeId, key]) if (typeof value !== 'string' || !value || ['__proto__', 'constructor', 'prototype'].includes(value)) {
      throw Object.assign(new Error('Invalid timeline review key'), { code: 'INVALID_REQUEST' });
    }
    if (!Object.hasOwn(data.nodes, nodeId)) data.nodes[nodeId] = {};
    if (!Object.hasOwn(data.nodes[nodeId], key)) data.nodes[nodeId][key] = { status: 'open', feedback: [] };
    return data.nodes[nodeId][key];
  }
  async function setReview(id, nodeId, key, { status, assetId, by, at = new Date().toISOString() }) {
    if (!['approved', 'open'].includes(status) || (status === 'approved' && (typeof assetId !== 'string' || !assetId))) {
      throw Object.assign(new Error('Invalid timeline approval'), { code: 'INVALID_REQUEST' });
    }
    return update(id, (data) => {
      const record = clipOf(data, nodeId, key);
      const next = { status, feedback: record.feedback || [] };
      if (status === 'approved') Object.assign(next, { assetId, by, at });
      data.nodes[nodeId][key] = next;
      return next;
    });
  }
  async function appendFeedback(id, nodeId, key, { text, by, at = new Date().toISOString(), was, prompt }) {
    if (typeof text !== 'string' || typeof was !== 'string' || typeof prompt !== 'string') {
      throw Object.assign(new Error('Invalid timeline feedback'), { code: 'INVALID_REQUEST' });
    }
    return update(id, (data) => {
      const record = clipOf(data, nodeId, key);
      const next = { status: 'open', feedback: [...(record.feedback || []), { text, by, at, was, prompt }].slice(-10) };
      data.nodes[nodeId][key] = next;
      return next;
    });
  }
  // Called while deleteWorkflow holds the workflow lock.
  const remove = (id) => withLock(`wf-timeline-review:${id}`, () => removeFile(fileFor(id)));
  return { read, update, setReview, appendFeedback, remove };
}

module.exports = { createReviewStore, reviewForAsset };
