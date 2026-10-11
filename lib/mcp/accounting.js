'use strict';

// What an agent key has used: the costs booked on it in the calendar month, the reservations of its running runs, the
// runs that are active now, and a queue per key so that the checks of a start and the start itself cannot be overtaken
// by a second start of the same key. Booked costs come from the cost journal; provider obligations are recovered
// from session jobs, including after an engine run ends or the server restarts.
//
//   monthSpentUsd(keyId)         booked in the calendar month (Europe/Zurich, like the cost evaluation)
//   monthUsage(keyId)            { spentUsd, reservedUsd }
//   begin(keyId, runId, usd)     a run of the key started: it counts as active and reserves its estimate
//   end(runId, status)           the run finished: outstanding provider jobs keep their reservation until booked
//   activeCount(keyId)           runs of the key that have not finished
//   startedBy(runId)             the key that started a run (null for an unknown run)
//   serialize(keyId, fn)         runs fn after the earlier calls of the same key
//   mayCreateWorkflow / noteWorkflowCreated   at most 30 workflows made from templates per key and hour

const budgetLib = require('../budget');
const costsLib = require('../costs');

const RESERVATION_TTL_MS = 8 * 60 * 60 * 1000; // as long as the longest run the budget knows
const UNFINISHED_GRACE_MS = 10 * 60 * 1000;
const REMEMBERED_RUNS = 500;
const HOUR_MS = 60 * 60 * 1000;

// First instant of the calendar month `at` is in, in Europe/Zurich (UTC+1 or +2): at most 3 hours before the first of the
// month in UTC.
function monthStartMs(at = Date.now()) {
  const key = costsLib.monthKey(at);
  const [year, month] = key.split('-').map(Number);
  const base = Date.UTC(year, month - 1, 1);
  for (let t = base - 3 * HOUR_MS; t <= base; t += HOUR_MS / 2) {
    if (costsLib.monthKey(t) === key) return t;
  }
  return base;
}

function createAccounting({ budget = budgetLib, now = Date.now, loadJobs = () => require('../store').listOpenJobs() } = {}) {
  const reservations = new Map(); // runId -> { keyId, usd, expiresAt }
  let obligations = new Map();
  const active = new Map(); // keyId -> Set(runId)
  const starters = new Map(); // runId -> keyId
  const queues = new Map(); // keyId -> promise
  const created = new Map(); // keyId -> timestamps of workflows made from templates

  function purge() {
    const at = now();
    for (const [runId, entry] of reservations) if (entry.expiresAt <= at && !obligations.has(entry.reservationId)) reservations.delete(runId);
  }

  async function monthSpentUsd(keyId) {
    return budget.spentByKey(keyId, monthStartMs(now()));
  }

  async function refreshJobs() {
    const next = new Map();
    for (const job of await loadJobs()) {
      if (!job.keyId) continue;
      const id = job.mcpReservationId || `legacy:${JSON.stringify([job.sessionId, job.budgetKey, job.jobId, job.assetId])}`;
      const estimate = [job.reservedUsd, job.estimateUsd, job.costEstimateUsd, job.accountingEntry?.cost]
        .find((value) => Number.isFinite(value) && value > 0);
      const knownZero = [job.estimateUsd, job.costEstimateUsd, job.accountingEntry?.cost].some((value) => value === 0);
      const usd = Number.isFinite(job.mcpReservedUsd) && job.mcpReservedUsd >= 0
        ? job.mcpReservedUsd : estimate ?? (knownZero ? 0 : Number.MAX_SAFE_INTEGER);
      const entry = next.get(id);
      next.set(id, { keyId: job.keyId, usd: Math.max(entry?.usd || 0, usd) });
    }
    obligations = next;
    for (const [runId, entry] of reservations) {
      if (obligations.has(entry.reservationId)) entry.linked = true;
      else if (entry.ended && (entry.linked || entry.status === 'completed')) reservations.delete(runId);
    }
  }

  function reservedUsd(keyId) {
    purge();
    const amounts = new Map();
    for (const [id, entry] of obligations) if (entry.keyId === keyId) amounts.set(id, entry.usd);
    for (const entry of reservations.values()) {
      if (entry.keyId === keyId) amounts.set(entry.reservationId, Math.max(amounts.get(entry.reservationId) || 0, entry.usd));
    }
    let sum = 0;
    for (const amount of amounts.values()) sum += amount;
    return Math.round(sum * 1e6) / 1e6;
  }

  async function monthUsage(keyId) {
    await refreshJobs();
    return { spentUsd: await monthSpentUsd(keyId), reservedUsd: reservedUsd(keyId) };
  }

  function begin(keyId, runId, usd, reservationId = runId) {
    if (!active.has(keyId)) active.set(keyId, new Set());
    active.get(keyId).add(runId);
    starters.set(runId, keyId);
    if (starters.size > REMEMBERED_RUNS) starters.delete(starters.keys().next().value);
    if (usd > 0) reservations.set(runId, { keyId, usd, reservationId, expiresAt: now() + RESERVATION_TTL_MS });
  }

  async function end(runId, status = 'completed') {
    const keyId = starters.get(runId);
    if (keyId && active.has(keyId)) {
      active.get(keyId).delete(runId);
      if (!active.get(keyId).size) active.delete(keyId);
    }
    const entry = reservations.get(runId);
    if (!entry) return;
    entry.ended = true;
    entry.status = status;
    entry.expiresAt = now() + UNFINISHED_GRACE_MS;
    // A failed read keeps the hold; the next start must retry the read and cannot pass on stale data.
    try { await refreshJobs(); } catch (_) {}
  }

  const activeCount = (keyId) => (active.has(keyId) ? active.get(keyId).size : 0);
  const startedBy = (runId) => starters.get(runId) || null;

  // One call after the other per key; a failed call does not stop the next one.
  function serialize(keyId, fn) {
    const previous = queues.get(keyId) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(keyId, tail);
    tail.then(() => {
      if (queues.get(keyId) === tail) queues.delete(keyId);
    });
    return run;
  }

  // At most `max` workflows per key and hour: a loop in an agent must not fill the person's list.
  function recentCreations(keyId) {
    const at = now();
    const recent = (created.get(keyId) || []).filter((time) => at - time < HOUR_MS);
    created.set(keyId, recent);
    return recent;
  }
  const mayCreateWorkflow = (keyId, max = 30) => recentCreations(keyId).length < max;
  const noteWorkflowCreated = (keyId) => recentCreations(keyId).push(now());

  return { monthSpentUsd, monthUsage, reservedUsd, begin, end, activeCount, startedBy, serialize, mayCreateWorkflow, noteWorkflowCreated };
}

module.exports = { createAccounting, monthStartMs, UNFINISHED_GRACE_MS, RESERVATION_TTL_MS };
