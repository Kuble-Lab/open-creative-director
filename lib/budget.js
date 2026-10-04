'use strict';

// USD budget of participants (people in an active team, see lib/teams.js and lib/access.js).
//
//   limit     the highest of (budgetOverrideUsd ?? team.budgetUsd) over the person's memberships
//   since     the latest budgetStart of the memberships (a new training brings a fresh budget)
//   spent     known USD costs of the cost journal (data/costs.jsonl, field `user`) at or after `since`
//   reserved  what running work has claimed but not booked yet (async jobs, node runs, tool calls in flight)
//   remaining max(0, limit - spent - reserved)
//
// Admins and internal people have no budget (status() answers null); guests have a limit of 0.
// Every paid place asks this module first (see the list in the README): begin() for one paid action, beginRun() for
// a whole node run. Both throw a BudgetError with the code BUDGET_EXHAUSTED (nothing left) or BUDGET_INSUFFICIENT
// (the estimate is more than what is left). A cost without a known amount counts 0 but is journaled.
//
// The cost journal is never re-read as a whole: the index keeps the sums per person and reads only what was
// appended since the last look (a shrunk or rewritten file is read again from the start).

const crypto = require('crypto');
const fsp = require('fs/promises');

const access = require('./access');
const costs = require('./costs');

const REMAINING_EPSILON = 1e-6;
const HOLD_TTL_MS = 20 * 60 * 1000; // a paid call in flight
const JOB_TTL_MS = 3 * 60 * 60 * 1000; // an async provider job (the poller renews it while the job is open)
const RUN_TTL_MS = 8 * 60 * 60 * 1000; // a node run

// Asynchronous provider jobs (video, fal) are booked only when the provider is done. Where no price is known in advance
// begin() reserves a flat amount for such a job (BUDGET_ASYNC_HOLD_USD, at most what is left) and a person may have only
// a few of them open at once (BUDGET_MAX_OPEN_JOBS), so one small rest cannot start an unbounded number of jobs.
function envNumber(name, fallback, { min = 0, integer = false } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) return fallback;
  return value;
}
const ASYNC_HOLD_USD = () => envNumber('BUDGET_ASYNC_HOLD_USD', 2, { min: 0.01 });
const MAX_OPEN_JOBS = () => envNumber('BUDGET_MAX_OPEN_JOBS', 2, { min: 1, integer: true });
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 96;

const round6 = (value) => Math.round(value * 1e6) / 1e6;

class BudgetError extends Error {
  constructor(code, message, messageDe, { budget = null, estimateUsd = null } = {}) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
    this.status = 402;
    this.messageDe = messageDe;
    this.budget = budget;
    this.estimateUsd = estimateUsd;
    this.remainingUsd = budget ? budget.remainingUsd : 0;
  }

  toJSON() {
    return { code: this.code, message: this.message, budget: this.budget, estimateUsd: this.estimateUsd, remainingUsd: this.remainingUsd };
  }
}

const usd = (value) => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

function tooManyJobs(snapshot, max) {
  const error = new BudgetError(
    'BUDGET_JOBS_OPEN',
    `${max} jobs of yours are still running at the provider. Wait until one is finished before starting another.`,
    `Es laufen bereits ${max} Aufträge von dir beim Anbieter. Warte, bis einer fertig ist, bevor du einen weiteren startest.`,
    { budget: snapshot }
  );
  error.status = 429;
  return error;
}

/* ---------- incremental sums over the cost journal ---------- */

function createCostIndex({ file = costs.COSTS_FILE } = {}) {
  let offset = 0;
  let head = '';
  let users = new Map(); // address -> { ts: number[], cost: number[] }
  let keys = new Map(); // id of an agent key (lib/mcp) -> { ts: number[], cost: number[] }
  let chain = Promise.resolve();

  function reset() {
    offset = 0;
    head = '';
    users = new Map();
    keys = new Map();
  }

  function add(line) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      return; // broken journal lines are skipped, as everywhere else
    }
    const user = typeof row?.user === 'string' ? row.user.trim().toLowerCase() : '';
    const time = Date.parse(row?.ts);
    const cost = Number(row?.cost);
    if (!user || !Number.isFinite(time) || !Number.isFinite(cost) || cost < 0) return;
    let entry = users.get(user);
    if (!entry) {
      entry = { ts: [], cost: [] };
      users.set(user, entry);
    }
    entry.ts.push(time);
    entry.cost.push(cost);
    // what an agent key spent (its own limit per month), in addition to the person
    const keyId = typeof row?.keyId === 'string' ? row.keyId : '';
    if (keyId) {
      let byKey = keys.get(keyId);
      if (!byKey) {
        byKey = { ts: [], cost: [] };
        keys.set(keyId, byKey);
      }
      byKey.ts.push(time);
      byKey.cost.push(cost);
    }
  }

  async function readNew() {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') {
        reset();
        return;
      }
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (offset > 0) {
        // Rewritten or replaced (backfill, rotation)? Then the beginning differs or the file is shorter than what was read.
        const probe = Buffer.alloc(Math.min(head.length, size));
        if (probe.length) await handle.read(probe, 0, probe.length, 0);
        if (size < offset || probe.toString('latin1') !== head.slice(0, probe.length)) reset();
      }
      if (offset === 0 && size > 0) {
        const first = Buffer.alloc(Math.min(HEAD_BYTES, size));
        await handle.read(first, 0, first.length, 0);
        head = first.toString('latin1');
      }
      while (offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, offset);
        if (!bytesRead) break;
        const data = chunk.subarray(0, bytesRead);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          // No complete line in this chunk: an unfinished append (wait) or a line longer than the chunk (skip it).
          if (bytesRead >= READ_CHUNK_BYTES) offset += bytesRead;
          break;
        }
        let start = 0;
        while (start <= lastNewline) {
          const end = data.indexOf(0x0a, start);
          const line = data.toString('utf8', start, end).trim();
          if (line) add(line);
          start = end + 1;
        }
        offset += lastNewline + 1;
      }
    } finally {
      await handle.close();
    }
  }

  // Brings the sums up to date. Calls are queued, so two callers never read the same bytes twice.
  function refresh() {
    const run = () => readNew();
    chain = chain.then(run, run);
    return chain;
  }

  // Sum of the person's costs at or after `sinceMs` (all of them for null).
  function spent(email, sinceMs = null) {
    const entry = users.get(String(email || '').trim().toLowerCase());
    if (!entry) return 0;
    let sum = 0;
    for (let i = 0; i < entry.ts.length; i += 1) {
      if (sinceMs === null || entry.ts[i] >= sinceMs) sum += entry.cost[i];
    }
    return sum;
  }

  // Sum of the costs booked through an agent key at or after `sinceMs`.
  function spentByKey(keyId, sinceMs = null) {
    const entry = keys.get(String(keyId || ''));
    if (!entry) return 0;
    let sum = 0;
    for (let i = 0; i < entry.ts.length; i += 1) {
      if (sinceMs === null || entry.ts[i] >= sinceMs) sum += entry.cost[i];
    }
    return sum;
  }

  return { refresh, spent, spentByKey, reset, get offset() { return offset; }, get rows() { let n = 0; for (const e of users.values()) n += e.ts.length; return n; } };
}

/* ---------- the budget ---------- */

const NOOP_GRANT = Object.freeze({ applies: false, key: null, jobKey: null, reservedUsd: 0, release() {}, settle() {} });

function createBudget({ index = createCostIndex(), teams = () => null, now = Date.now } = {}) {
  const reservations = new Map(); // key -> { user, usd, expiresAt, job } (job: an async provider job that is still open)
  const teamsStore = () => teams() || access.teamsStore();

  function purge() {
    const current = now();
    for (const [key, entry] of reservations) if (entry.expiresAt <= current) reservations.delete(key);
  }

  function reservedFor(email, exclude = []) {
    purge();
    let sum = 0;
    for (const [key, entry] of reservations) if (entry.user === email && !exclude.includes(key)) sum += entry.usd;
    return sum;
  }

  // Limit and start of the person's budget from the memberships of active teams.
  function limits(email) {
    const memberships = teamsStore().membershipsOf(email);
    if (!memberships.length) return null;
    let limit = 0;
    let since = 0;
    for (const entry of memberships) {
      limit = Math.max(limit, entry.budgetOverrideUsd ?? entry.budgetUsd ?? 0);
      since = Math.max(since, Date.parse(entry.budgetStart) || 0);
    }
    return { limitUsd: limit, since };
  }

  // Synchronous part: needs a fresh index (await index.refresh() first).
  function compute(email, exclude = []) {
    const own = limits(email);
    const limitUsd = own ? own.limitUsd : 0;
    const spentUsd = own ? index.spent(email, own.since) : 0;
    const reservedUsd = reservedFor(email, exclude);
    return {
      limitUsd: round6(limitUsd),
      spentUsd: round6(spentUsd),
      reservedUsd: round6(reservedUsd),
      remainingUsd: round6(Math.max(0, limitUsd - spentUsd - reservedUsd)),
      since: own && own.since ? new Date(own.since).toISOString() : null
    };
  }

  // The status of a viewer with a budget (participants; guests have 0), null for everybody else.
  async function status(viewer, { exclude = [] } = {}) {
    if (!access.isRestricted(viewer) || !viewer.email) return null;
    await index.refresh();
    return compute(viewer.email, exclude);
  }

  // The status of any address (admin overviews, monitoring). Not restricted to participants.
  async function statusOfEmail(email, { exclude = [] } = {}) {
    await index.refresh();
    return compute(access.normalizeEmail(email) || String(email), exclude);
  }

  // The status of many addresses with ONE look at the cost journal (admin overviews). Returns a Map address -> status.
  async function statusOfEmails(emails, { exclude = [] } = {}) {
    await index.refresh();
    const result = new Map();
    for (const raw of emails) {
      const email = access.normalizeEmail(raw) || String(raw);
      if (!result.has(email)) result.set(email, compute(email, exclude));
    }
    return result;
  }

  function refuse(snapshot, estimateUsd, label) {
    if (snapshot.remainingUsd <= REMAINING_EPSILON) {
      return new BudgetError(
        'BUDGET_EXHAUSTED',
        `The budget is used up (${usd(snapshot.spentUsd)} of ${usd(snapshot.limitUsd)}${snapshot.reservedUsd > 0 ? `, ${usd(snapshot.reservedUsd)} reserved` : ''}). Paid actions are blocked; chats and results stay available.`,
        `Das Budget ist aufgebraucht (${usd(snapshot.spentUsd)} von ${usd(snapshot.limitUsd)}${snapshot.reservedUsd > 0 ? `, ${usd(snapshot.reservedUsd)} reserviert` : ''}). Bezahlte Aktionen sind gesperrt, Chats und Ergebnisse bleiben erhalten.`,
        { budget: snapshot, estimateUsd: estimateUsd ?? null }
      );
    }
    return new BudgetError(
      'BUDGET_INSUFFICIENT',
      `${label || 'This action'} is estimated at ${usd(estimateUsd)} but only ${usd(snapshot.remainingUsd)} of the budget is left.`,
      `${label || 'Diese Aktion'} kostet geschätzt ${usd(estimateUsd)}, aber vom Budget sind nur noch ${usd(snapshot.remainingUsd)} übrig.`,
      { budget: snapshot, estimateUsd }
    );
  }

  // While a restriction is active (lib/access.js restrictionActive) an anonymous caller may be a participant whose login
  // could not be confirmed: no paid action for them, instead of the free pass an anonymous caller has otherwise.
  function refuseUnconfirmed(viewer) {
    if (access.isUnconfirmed(viewer)) throw new access.LoginUnconfirmedError();
  }

  function hold(key, email, amount, ttlMs, job = false) {
    reservations.set(key, { user: email, usd: amount, expiresAt: now() + ttlMs, job });
  }

  // How many asynchronous jobs of the person are open (reservations that belong to a job).
  function openJobsOf(email) {
    purge();
    let count = 0;
    for (const entry of reservations.values()) if (entry.user === email && entry.job) count += 1;
    return count;
  }

  // One paid action. estimateUsd: null = unknown (then anything left is enough). runKey: the action belongs to a node
  // run that has reserved its plan already; the run's own reservation does not count against it.
  // asyncJob: the action starts a provider job that is booked later. Without a price the grant reserves a flat amount
  // (at most what is left) until the poller books the cost, and a person may have only MAX_OPEN_JOBS() of them open.
  // Returns a grant: { jobKey, release() }. Sync work calls release() when done (the cost is booked by then);
  // async jobs keep jobKey on the job, the poller settles it when the cost arrives.
  async function begin(viewer, { estimateUsd = null, runKey = null, label = null, ttlMs = HOLD_TTL_MS, asyncJob = false } = {}) {
    refuseUnconfirmed(viewer);
    if (!access.isRestricted(viewer) || !viewer.email) return NOOP_GRANT;
    const estimate = Number.isFinite(estimateUsd) && estimateUsd >= 0 ? estimateUsd : null;
    await index.refresh();
    const snapshot = compute(viewer.email, runKey ? [runKey] : []);
    if (snapshot.remainingUsd <= REMAINING_EPSILON || (estimate !== null && estimate > snapshot.remainingUsd + REMAINING_EPSILON)) {
      throw refuse(snapshot, estimate, label);
    }
    if (runKey) return { applies: true, key: null, jobKey: runKey, reservedUsd: 0, release() {}, settle() {} };
    let amount = estimate;
    if (asyncJob) {
      if (openJobsOf(viewer.email) >= MAX_OPEN_JOBS()) throw tooManyJobs(snapshot, MAX_OPEN_JOBS());
      if (!(amount > 0)) amount = Math.min(ASYNC_HOLD_USD(), snapshot.remainingUsd);
    }
    if (!(amount > 0)) return { applies: true, key: null, jobKey: null, reservedUsd: 0, release() {}, settle() {} };
    const key = `hold:${crypto.randomBytes(6).toString('hex')}`;
    hold(key, viewer.email, amount, asyncJob ? JOB_TTL_MS : ttlMs, asyncJob);
    return {
      applies: true,
      key,
      jobKey: key,
      reservedUsd: amount,
      release: () => reservations.delete(key),
      settle: (cost) => settleKey(key, cost)
    };
  }

  // A node run: refuses before anything is started when the plan does not fit, then reserves the planned USD.
  // plan.totals.usd is the estimate of everything that will run; unknown nodes only need something left.
  async function beginRun(viewer, { runId, estimateUsd = 0, paid = true, ttlMs = RUN_TTL_MS } = {}) {
    refuseUnconfirmed(viewer);
    if (!access.isRestricted(viewer) || !viewer.email || !paid) return NOOP_GRANT;
    await index.refresh();
    const snapshot = compute(viewer.email);
    const estimate = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
    if (snapshot.remainingUsd <= REMAINING_EPSILON || estimate > snapshot.remainingUsd + REMAINING_EPSILON) {
      throw refuse(snapshot, estimate, 'This run');
    }
    const key = `run:${runId}`;
    if (estimate > 0) hold(key, viewer.email, estimate, ttlMs);
    return {
      applies: true,
      key,
      jobKey: key,
      reservedUsd: estimate,
      release: () => reservations.delete(key),
      settle: (amount) => settleKey(key, amount)
    };
  }

  // A node that learns only while it runs what it will cost (a long video cut into parts: the length of an upload was not known when
  // the plan was made) raises the reservation of its run by the part the plan did not cover. A run that reserved nothing gets one.
  // Returns true where something is reserved now. Not for guests and others without a budget.
  function extendRun(viewer, runKey, amountUsd) {
    refuseUnconfirmed(viewer);
    const extra = Number(amountUsd);
    if (!runKey || !access.isRestricted(viewer) || !viewer.email || !(extra > 0)) return false;
    purge();
    const entry = reservations.get(runKey);
    if (entry) {
      entry.usd = round6(entry.usd + extra);
      entry.expiresAt = Math.max(entry.expiresAt, now() + RUN_TTL_MS);
    } else {
      hold(runKey, viewer.email, round6(extra), RUN_TTL_MS);
    }
    return true;
  }

  // A cost of `amount` USD was booked for a reservation: what it claimed shrinks accordingly.
  function settleKey(key, amount) {
    const entry = key ? reservations.get(key) : null;
    if (!entry) return;
    const cost = Number(amount);
    entry.usd = Number.isFinite(cost) && cost > 0 ? Math.max(0, entry.usd - cost) : entry.usd;
  }

  function release(key) {
    if (key) reservations.delete(key);
  }

  // Async jobs (poller). A "hold:" reservation belongs to the job alone and ends with it; a "run:" reservation
  // belongs to the node run, which releases it when the run ends.
  function settleJob(job, amount) {
    const key = job && job.budgetKey;
    if (!key) return;
    if (key.startsWith('hold:')) release(key);
    else settleKey(key, amount);
  }

  function releaseJob(job) {
    const key = job && job.budgetKey;
    if (key && key.startsWith('hold:')) release(key);
  }

  // After a restart the reservations are gone; the poller puts the ones of still open jobs back.
  function ensureJob(job) {
    const key = job && job.budgetKey;
    if (!key || !key.startsWith('hold:')) return;
    const amount = Number(job.reservedUsd);
    const email = access.normalizeEmail(job.user);
    if (!email || !(amount > 0)) return;
    const entry = reservations.get(key);
    if (entry) entry.expiresAt = now() + JOB_TTL_MS;
    else hold(key, email, amount, JOB_TTL_MS, true);
  }

  // A node run ends (or is cancelled) while `count` provider jobs of it are still open. The provider keeps working and
  // bills them, so the run's reservation must not just vanish: it is split into one "hold:" reservation per open job
  // (each job then carries its own key, see ensureJob/settleJob). Where the run has nothing left to split, a flat
  // amount (at most what is left) is held instead. Returns [{ key, usd }], one per job; the caller writes them to the
  // jobs and calls release(key) for a job that ended in the meantime.
  async function detachRun(viewer, runKey, count) {
    refuseUnconfirmed(viewer);
    if (!access.isRestricted(viewer) || !viewer.email || !(count > 0)) return [];
    await index.refresh();
    purge();
    const run = reservations.get(runKey);
    const snapshot = compute(viewer.email, [runKey]);
    const share = run && run.usd > 0 ? run.usd / count : Math.min(ASYNC_HOLD_USD(), snapshot.remainingUsd);
    const grants = [];
    for (let i = 0; i < count; i += 1) {
      const key = `hold:${crypto.randomBytes(6).toString('hex')}`;
      const amount = round6(Math.max(0, share));
      if (amount > 0) hold(key, viewer.email, amount, JOB_TTL_MS, true);
      grants.push({ key, usd: amount });
    }
    return grants;
  }

  function reservationCount() {
    purge();
    return reservations.size;
  }

  // What an agent key (lib/mcp) has had booked since `sinceMs`, from the cost journal.
  async function spentByKey(keyId, sinceMs = null) {
    await index.refresh();
    return round6(index.spentByKey(keyId, sinceMs));
  }

  return { index, spentByKey, status, statusOfEmail, statusOfEmails, begin, beginRun, extendRun, settle: settleKey, release, settleJob, releaseJob, ensureJob, detachRun, reservedFor, reservationCount, limits };
}

const defaultBudget = createBudget();

module.exports = {
  BudgetError,
  NOOP_GRANT,
  REMAINING_EPSILON,
  HOLD_TTL_MS,
  JOB_TTL_MS,
  RUN_TTL_MS,
  ASYNC_HOLD_USD,
  MAX_OPEN_JOBS,
  createCostIndex,
  createBudget,
  defaultBudget,
  status: defaultBudget.status,
  statusOfEmail: defaultBudget.statusOfEmail,
  statusOfEmails: defaultBudget.statusOfEmails,
  spentByKey: defaultBudget.spentByKey,
  begin: defaultBudget.begin,
  beginRun: defaultBudget.beginRun,
  extendRun: defaultBudget.extendRun,
  settle: defaultBudget.settle,
  release: defaultBudget.release,
  settleJob: defaultBudget.settleJob,
  releaseJob: defaultBudget.releaseJob,
  ensureJob: defaultBudget.ensureJob,
  detachRun: defaultBudget.detachRun
};
