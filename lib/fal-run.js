'use strict';

// Per-node FIFO gate held until a provider job ends, even while the engine gives back its execution slot.
const fal = require('./fal');
const store = require('./store');
const jobs = require('./nodes/jobs');
const MAX_ACTIVE_JOBS = 4;
const scopes = new WeakMap();

function scopeOf(ctx) {
  if (!ctx.signal || !ctx.nodeId) return null;
  const runSignal = ctx.runSignal || ctx.signal;
  let nodes = scopes.get(runSignal);
  if (!nodes) scopes.set(runSignal, nodes = new Map());
  let scope = nodes.get(ctx.nodeId);
  if (!scope) nodes.set(ctx.nodeId, scope = { active: 0, waiters: [], monitors: new Set(), tracked: new Map(), cancellations: new Map() });
  return scope;
}

function log(ctx, label) {
  ctx.emit?.({ type: 'tool_progress', label });
}

async function acquire(ctx, scope) {
  if (ctx.signal.aborted) throw fal.abortError();
  if (scope.active < MAX_ACTIVE_JOBS) { scope.active += 1; return; }
  log(ctx, `Waiting for a fal slot (limit ${MAX_ACTIVE_JOBS} active jobs per node)`);
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal: ctx.signal };
    waiter.abort = () => {
      const index = scope.waiters.indexOf(waiter);
      if (index >= 0) scope.waiters.splice(index, 1);
      reject(fal.abortError());
    };
    ctx.signal.addEventListener('abort', waiter.abort, { once: true });
    scope.waiters.push(waiter);
  });
}

function release(scope) {
  const next = scope.waiters.shift();
  if (next) {
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
  } else scope.active -= 1;
}

async function cancelJob(ctx, ref) {
  const scope = scopeOf(ctx);
  if (typeof ref === 'string') ref = { jobId: ref };
  const key = ref.assetId || ref.jobId;
  if (scope?.cancellations.has(key)) return scope.cancellations.get(key);
  const task = (async () => {
    try {
      const session = await store.readSession(ctx.sessionId);
      const job = store.findSessionJob(session.jobs, ref);
      if (!job || (job.source !== 'fal' && job.provider !== 'fal')) return false;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        log(ctx, `fal job ${job.assetId}: already ${job.status}, no queue cancellation needed`);
        return true;
      }
      const result = await fal.cancelJob(job);
      const reported = String(result?.status || '').toUpperCase();
      const status = ['CANCELLATION_REQUESTED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'IN_QUEUE'].includes(reported) ? reported : '';
      if (status === 'CANCELLATION_REQUESTED' || status === 'CANCELLED') {
        log(ctx, `fal job ${job.assetId}: cancellation accepted by the queue`);
        // the way of any failed job: the job is closed, its budget released and the public copies of its images removed
        await require('./poller').handleFailed(ctx.sessionId, job, { error: 'Der Lauf wurde abgebrochen, fal.ai hat den Auftrag gestoppt.' });
        return true;
      } else {
        log(ctx, `fal job ${job.assetId}: cancellation not confirmed (${status || 'unknown response'}); running or completed jobs may still be charged`);
      }
    } catch (err) {
      log(ctx, `fal job ${ref.assetId || 'unknown'}: cancellation failed (${err.message}); running or completed jobs may still be charged`);
    }
    return false;
  })();
  scope?.cancellations.set(key, task);
  return task;
}

async function run(ctx, submit) {
  if (ctx.runSignal) ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, ctx.runSignal]) };
  const scope = scopeOf(ctx);
  if (!scope) return submit();
  await acquire(ctx, scope);
  let handedOff = false;
  try {
    if (ctx.signal.aborted) throw fal.abortError();
    const outcome = await submit();
    const job = outcome.job;
    // Submit deliberately finishes without the run signal, so its request id survives an abort in flight.
    if (ctx.signal.aborted) {
      const stopped = await cancelJob(ctx, job);
      if (stopped) throw fal.abortError();
      // Keep the async tool grant attached to an unconfirmed job; the aborted node will watch and detach it.
    }
    handedOff = true;
    watch(ctx, scope, job);
    return outcome;
  } finally {
    if (!handedOff) release(scope);
  }
}

function watch(ctx, scope, job) {
  const key = job.assetId || job.jobId;
  const monitor = jobs.waitForSessionJob(ctx.sessionId, job.jobId, { assetId: job.assetId, signal: ctx.signal, timeoutMs: 90 * 60 * 1000 })
    .catch(async () => { if (ctx.signal.aborted) await cancelJob(ctx, job); })
    .finally(() => { release(scope); scope.monitors.delete(monitor); scope.tracked.delete(key); });
  scope.monitors.add(monitor);
  scope.tracked.set(key, monitor);
}

// An unfinished part resumed from an earlier run occupies a slot; a completed cached part does not.
async function adopt(ctx, ref) {
  if (ctx.runSignal) ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, ctx.runSignal]) };
  const scope = scopeOf(ctx);
  if (!scope) return;
  if (typeof ref === 'string') ref = { jobId: ref };
  const key = ref.assetId || ref.jobId;
  if (scope.tracked.has(key)) return;
  const job = store.findSessionJob((await store.readSession(ctx.sessionId)).jobs, ref);
  if (!job || (job.source !== 'fal' && job.provider !== 'fal') || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
  await acquire(ctx, scope);
  if (ctx.signal.aborted) {
    release(scope);
    await cancelJob(ctx, job);
    throw fal.abortError();
  }
  if (scope.tracked.has(key)) release(scope);
  else watch(ctx, scope, job);
}

async function drain(signal) {
  const nodes = scopes.get(signal);
  if (nodes) await Promise.all([...nodes.values()].flatMap((scope) => [...scope.monitors, ...scope.cancellations.values()]));
}

module.exports = { run, adopt, cancelJob, drain, MAX_ACTIVE_JOBS };
