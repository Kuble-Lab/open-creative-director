'use strict';

// Waits for asynchronous provider jobs of a backing session (SPEC §9.5).
// It never talks to a provider: the existing poller (lib/poller.js) completes the jobs and
// writes the result into session.jobs / the ledger; this module only watches the session file.

const store = require('../store');

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function abortError(message = 'Aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// Sleeps for ms; rejects with an AbortError as soon as the signal fires.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Resolves with the ids of the result assets (job.resultAssetIds, else [job.assetId]) once the
// job is `completed`; rejects with job.error when `failed`, with an AbortError when aborted and
// with a timeout error after timeoutMs. onStatus(status) is called whenever the status changes.
// Pass assetId when known: it is unique per session, a jobId is not (Higgsfield can reuse one), so the
// job is looked up by assetId first and by jobId only as a fallback, like findJob in lib/poller.js.
async function waitForSessionJob(sessionId, jobId, { assetId, signal, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, onStatus } = {}) {
  if (typeof jobId !== 'string' || !jobId) throw new Error('jobId is required');
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let missing = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let job = null;
    try {
      const session = await store.readSession(sessionId);
      const list = Array.isArray(session.jobs) ? session.jobs : [];
      job = (assetId && list.find((entry) => entry.assetId === assetId)) || list.find((entry) => entry.jobId === jobId) || null;
      missing = job ? 0 : missing + 1;
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('Backing session no longer exists');
      /* transient read error (poller rewriting the file): try again */
    }
    if (job) {
      const status = String(job.status || 'pending');
      if (status !== lastStatus) {
        lastStatus = status;
        if (typeof onStatus === 'function') onStatus(status);
      }
      if (status === 'completed') {
        return Array.isArray(job.resultAssetIds) && job.resultAssetIds.length ? job.resultAssetIds.slice() : [job.assetId];
      }
      if (status === 'failed' || status === 'cancelled') {
        const failure = new Error(String(job.error || `Job ${jobId} ${status}`).slice(0, 500));
        // a stable code of the poller (VIDEO_REAL_PERSON_JOB) lets the interface say it in its own language
        if (typeof job.errorCode === 'string' && job.errorCode) failure.code = job.errorCode;
        throw failure;
      }
    } else if (missing >= 3) {
      throw new Error(`Job ${jobId} not found in session`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for job ${jobId}`);
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
  }
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function findJobIn(list, ref) {
  return (ref.assetId && list.find((entry) => entry.assetId === ref.assetId)) || list.find((entry) => entry.jobId === ref.jobId) || null;
}

// Which of the jobs ({ jobId, assetId }) are still open in the session (not completed, failed or cancelled).
async function openJobs(sessionId, refs) {
  let session;
  try {
    session = await store.readSession(sessionId);
  } catch (_) {
    return [];
  }
  const list = Array.isArray(session.jobs) ? session.jobs : [];
  return refs.filter((ref) => {
    const job = findJobIn(list, ref);
    return job && !TERMINAL_STATES.has(String(job.status || 'pending'));
  });
}

// Gives open jobs their own budget reservation (lib/budget.js detachRun). assignments: [{ ref, budgetKey, reservedUsd }].
// Returns the assignments that could not be applied because the job ended in the meantime.
async function reassignBudget(sessionId, assignments) {
  const skipped = [];
  await store.mutateSession(sessionId, (session) => {
    const list = Array.isArray(session.jobs) ? session.jobs : [];
    for (const item of assignments) {
      const job = findJobIn(list, item.ref);
      if (!job || TERMINAL_STATES.has(String(job.status || 'pending'))) {
        skipped.push(item);
        continue;
      }
      job.budgetKey = item.budgetKey;
      if (item.reservedUsd > 0) job.reservedUsd = item.reservedUsd;
      else delete job.reservedUsd;
    }
  });
  return skipped;
}

module.exports = {
  openJobs,
  reassignBudget,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  abortError,
  isAbortError,
  sleep,
  waitForSessionJob
};
