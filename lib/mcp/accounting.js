'use strict';

// What an agent key has used: the costs booked on it in the calendar month, the reservations of its running runs, the
// runs that are active now, and a queue per key so that the checks of a start and the start itself cannot be overtaken
// by a second start of the same key. Everything is in memory except the booked costs, which come from the cost journal
// (they carry keyId and keyName, see lib/costs.js withVia); a restart ends the runs of the engine as well.
//
//   monthSpentUsd(keyId)         booked in the calendar month (Europe/Zurich, like the cost evaluation)
//   monthUsage(keyId)            { spentUsd, reservedUsd }
//   begin(keyId, runId, usd)     a run of the key started: it counts as active and reserves its estimate
//   end(runId, status)           the run finished: the reservation ends (a run that did not complete keeps it for a short
//                                time, provider jobs it left behind are booked only when they finish)
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

function createAccounting({ budget = budgetLib, now = Date.now } = {}) {
  const reservations = new Map(); // runId -> { keyId, usd, expiresAt }
  const active = new Map(); // keyId -> Set(runId)
  const starters = new Map(); // runId -> keyId
  const queues = new Map(); // keyId -> promise
  const created = new Map(); // keyId -> timestamps of workflows made from templates

  function purge() {
    const at = now();
    for (const [runId, entry] of reservations) if (entry.expiresAt <= at) reservations.delete(runId);
  }

  async function monthSpentUsd(keyId) {
    return budget.spentByKey(keyId, monthStartMs(now()));
  }

  function reservedUsd(keyId) {
    purge();
    let sum = 0;
    for (const entry of reservations.values()) if (entry.keyId === keyId) sum += entry.usd;
    return Math.round(sum * 1e6) / 1e6;
  }

  async function monthUsage(keyId) {
    return { spentUsd: await monthSpentUsd(keyId), reservedUsd: reservedUsd(keyId) };
  }

  function begin(keyId, runId, usd) {
    if (!active.has(keyId)) active.set(keyId, new Set());
    active.get(keyId).add(runId);
    starters.set(runId, keyId);
    if (starters.size > REMEMBERED_RUNS) starters.delete(starters.keys().next().value);
    if (usd > 0) reservations.set(runId, { keyId, usd, expiresAt: now() + RESERVATION_TTL_MS });
  }

  function end(runId, status = 'completed') {
    const keyId = starters.get(runId);
    if (keyId && active.has(keyId)) {
      active.get(keyId).delete(runId);
      if (!active.get(keyId).size) active.delete(keyId);
    }
    const entry = reservations.get(runId);
    if (!entry) return;
    if (status === 'completed') reservations.delete(runId);
    else entry.expiresAt = now() + UNFINISHED_GRACE_MS;
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
