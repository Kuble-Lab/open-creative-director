'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const access = require('./access');
const { PATHS } = require('./config');
const { costUsdOf, dayOf } = require('./admin-monitoring');
const { defaultStore, atomicJson, positiveInteger } = require('./strikes');
const DAY = 86400000;
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const safely = (read, fallback = null) => { try { return read(); } catch (_) { return fallback; } };
const emailOf = (value) => typeof value === 'string' ? value.trim().toLowerCase() : 'lokal';

// Capacity signals are independent; retain every reason and choose the highest severity.
function capacityVerdict({ online, loadPerCpu15, memAvailablePct, diskFreePct, eventLoopLagMs, testedUsers = 14 } = {}) {
  const reasons = [];
  const add = (code, level, value, limit) => reasons.push({ code, level, value, limit });
  if (number(online) !== null && online > testedUsers) add('USERS_ABOVE_TESTED', 'watch', online, testedUsers);
  if (number(loadPerCpu15) !== null && loadPerCpu15 >= 0.8) add('LOAD_HIGH', loadPerCpu15 >= 1 ? 'upgrade' : 'watch', loadPerCpu15, loadPerCpu15 >= 1 ? 1 : 0.8);
  for (const [code, value] of [['MEMORY_LOW', memAvailablePct], ['DISK_LOW', diskFreePct]]) {
    if (number(value) !== null && value < 15) add(code, value < 8 ? 'upgrade' : 'watch', value, value < 8 ? 8 : 15);
  }
  if (number(eventLoopLagMs) !== null && eventLoopLagMs > 200) add('EVENT_LOOP_LAG', eventLoopLagMs > 500 ? 'upgrade' : 'watch', eventLoopLagMs, eventLoopLagMs > 500 ? 500 : 200);
  return { verdict: reasons.some((reason) => reason.level === 'upgrade') ? 'upgrade' : reasons.length ? 'watch' : 'ok', reasons };
}

function createActivity({ now = Date.now, env = process.env, dataDir = path.join(PATHS.root, 'data'),
  isActive = () => access.isActive(env), readRuns = async () => [], readJobs = async () => [], readCosts = async () => [],
  readTeams = () => [], readQueue = () => null, readCreditRates = () => ({}),
  // A record on disk keeps 'running' or 'awaiting_approval' after a restart; only the engine knows which runs are alive.
  isLiveRun = () => true, processUptime = () => process.uptime(),
  strikes = defaultStore, monitor = { activity: () => [] }, osImpl = os,
  statfs = (dir) => fsp.statfs(dir), readMeminfo = () => fsp.readFile('/proc/meminfo', 'utf8'),
  memoryUsage = () => process.memoryUsage(), lag = monitorEventLoopDelay({ resolution: 20 }),
  setTimer = setInterval, clearTimer = clearInterval, warn = (...args) => console.warn(...args) } = {}) {
  const file = path.join(dataDir, 'admin-load-history.json');
  let history = [];
  let writable = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('INVALID_HISTORY');
    history = parsed.filter((row) => row && Number.isFinite(Date.parse(row.ts)) && Date.parse(row.ts) >= now() - 7 * DAY && Date.parse(row.ts) <= now()).slice(-10081);
  } catch (error) {
    if (error.code !== 'ENOENT') { writable = false; warn('[activity] Load history could not be read.'); }
  }
  let lastWrite = -Infinity;
  let timer = null;
  let inFlight = null;
  let eventLoopLagMs = null;
  let dirty = false;
  const testedUsers = () => positiveInteger(env.CAPACITY_TESTED_USERS, 14);

  async function system() {
    const loads = safely(() => osImpl.loadavg(), []);
    const cpus = safely(() => osImpl.cpus()?.length) || null;
    const total = number(safely(() => osImpl.totalmem()));
    let available = number(safely(() => osImpl.freemem()));
    if (safely(() => osImpl.platform()) === 'linux') {
      try {
        const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(await readMeminfo());
        if (match) available = Number(match[1]) * 1024;
      } catch (_) { /* fallback to freemem when procfs is unavailable */ }
    }
    let diskFreePct = null, diskFreeGb = null, diskTotalGb = null;
    try {
      const stat = await statfs(dataDir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      const bytes = Number(stat.blocks) * Number(stat.bsize);
      if (Number.isFinite(free) && Number.isFinite(bytes) && bytes > 0) {
        diskFreePct = 100 * free / bytes; diskFreeGb = free / 1073741824; diskTotalGb = bytes / 1073741824;
      }
    } catch (_) { /* missing filesystem metrics remain null */ }
    const memAvailablePct = total > 0 && available !== null ? 100 * available / total : null;
    const rss = number(safely(() => memoryUsage().rss));
    return { load1: number(loads[0]), load5: number(loads[1]), load15: number(loads[2]), cpus,
      loadPerCpu15: cpus && number(loads[2]) !== null ? loads[2] / cpus : null,
      memTotalMb: total > 0 ? total / 1048576 : null, memAvailableMb: number(available) === null ? null : available / 1048576,
      memAvailablePct, memUsedPct: memAvailablePct === null ? null : 100 - memAvailablePct,
      rssMb: rss === null ? null : rss / 1048576,
      eventLoopLagMs, diskFreePct, diskFreeGb, diskTotalGb, uptimeSeconds: number(safely(() => Math.floor(processUptime()))) };
  }
  async function queueCounts() {
    try {
      const queue = await readQueue();
      const rows = Array.isArray(queue) ? queue : typeof queue?.snapshot === 'function' ? await queue.snapshot() : null;
      if (rows) return { waiting: rows.filter((row) => row.status === 'queued').length, running: rows.filter((row) => row.status === 'running').length };
      return { waiting: number(queue?.waiting), running: number(queue?.running) };
    } catch (_) { return { waiting: null, running: null }; }
  }
  function activeRuns(rows) {
    return rows.filter((row) => ['running', 'awaiting_approval', 'waiting_approval'].includes(row.status) && isLiveRun(row.workflowId, row.id || row.runId)).map((row) => ({
      workflowId: row.workflowId, title: typeof row.title === 'string' ? row.title : null, runId: row.id || row.runId,
      user: emailOf(row.user), startedAt: row.startedAt || null, status: row.status === 'running' ? 'running' : 'waiting_approval'
    }));
  }
  function openJobs(rows) {
    return rows.filter((row) => !['completed', 'failed', 'error', 'cancelled', 'canceled', 'aborted', 'nsfw', 'ip_detected'].includes(row.status) && Date.parse(row.ts) >= now() - DAY && Date.parse(row.ts) <= now())
      .map((row) => Object.fromEntries(['sessionId', 'jobId', 'provider', 'kind', 'user', 'ts', 'status'].map((key) => [key, key === 'user' ? emailOf(row.user) : row[key] ?? null])));
  }
  const activePeople = () => monitor.activity().filter((row) => Date.parse(row.lastSeen) > now() - 300000 && Date.parse(row.lastSeen) <= now());
  function syncStrikes(runRows, jobRows) {
    try { strikes.sync({ runRows, jobRows }); } catch (_) { warn('[activity] Strikes could not be synchronised.'); }
  }
  // The verdict uses the median of the last three minutes: one slow minute (a restart, a large file) is not a capacity problem.
  function steadyLag() {
    const values = history.slice(-3).map((row) => number(row.eventLoopLagMs)).filter((value) => value !== null).sort((a, b) => a - b);
    return values.length < 3 ? null : values[1];
  }
  function persist() {
    if (!dirty || !writable) return;
    atomicJson(file, history);
    lastWrite = now(); dirty = false;
  }
  function sample() {
    if (!isActive() || inFlight) return Promise.resolve(null);
    inFlight = (async () => {
      const [runRows, jobRows, renderQueue] = await Promise.all([readRuns(), readJobs(), queueCounts()]);
      syncStrikes(runRows, jobRows);
      eventLoopLagMs = lag.count === 0 ? null : number(lag.percentile(99) / 1e6);
      lag.reset();
      const metrics = await system();
      const row = { ts: new Date(now()).toISOString(), online: activePeople().length, runsRunning: activeRuns(runRows).length,
        jobsOpen: openJobs(jobRows).length, renderQueue, load1: metrics.load1, cpus: metrics.cpus,
        loadPerCpu: metrics.cpus && metrics.load1 !== null ? metrics.load1 / metrics.cpus : null,
        memUsedPct: metrics.memUsedPct, rssMb: metrics.rssMb, eventLoopLagMs, diskFreePct: metrics.diskFreePct };
      history = history.filter((item) => Date.parse(item.ts) >= now() - 7 * DAY);
      // One point per minute, even if an operator samples manually between ticks.
      if (!history.length || now() - Date.parse(history.at(-1).ts) >= 60000) { history.push(row); dirty = true; }
      history = history.slice(-10081);
      if (now() - lastWrite >= 300000) persist();
      return row;
    })().catch(() => { warn('[activity] Sample could not be collected or saved.'); return null; }).finally(() => { inFlight = null; });
    return inFlight;
  }
  async function snapshot() {
    const [runRows, jobRows, costs, teams, creditRates, renderQueue, metrics] = await Promise.all([
      readRuns(), readJobs(), readCosts(), readTeams(), readCreditRates(), queueCounts(), system()
    ]);
    syncStrikes(runRows, jobRows);
    const runs = activeRuns(runRows);
    const online = activePeople().map((person) => ({ email: emailOf(person.user),
      teams: teams.filter((team) => !team.archived && team.members?.some((member) => emailOf(typeof member === 'string' ? member : member.email) === emailOf(person.user))).map((team) => team.name),
      lastSeen: person.lastSeen, requests5m: person.requests5m, runsRunning: runs.filter((run) => run.user === emailOf(person.user)).length }));
    const today = dayOf(new Date(now()).toISOString());
    let todayUsd = 0, last24hUsd = 0, lastHourUsd = 0, unknownToday = 0;
    const byUser = new Map();
    for (const row of costs) {
      const at = Date.parse(row.ts);
      if (!Number.isFinite(at) || at > now()) continue;
      const { costUsd } = costUsdOf(row, creditRates);
      if (at >= now() - DAY) last24hUsd += costUsd || 0;
      if (at >= now() - 3600000) lastHourUsd += costUsd || 0;
      if (dayOf(row.ts) !== today) continue;
      if (costUsd === null) unknownToday += 1;
      else todayUsd += costUsd;
      const user = emailOf(row.user);
      const group = byUser.get(user) || { user, costUsd: 0, count: 0 };
      group.costUsd += costUsd || 0; group.count += 1; byUser.set(user, group);
    }
    const peak = (since) => history.filter((row) => Date.parse(row.ts) >= since && Date.parse(row.ts) <= now()).reduce((out, row) => {
      for (const key of ['online', 'runsRunning', 'loadPerCpu']) if (number(row[key]) !== null) out[key] = out[key] === null ? row[key] : Math.max(out[key], row[key]);
      return out;
    }, { online: null, runsRunning: null, loadPerCpu: null });
    const points = history.filter((row) => Date.parse(row.ts) >= now() - DAY && Date.parse(row.ts) <= now());
    const step = Math.max(1, Math.ceil(points.length / 300));
    return { generatedAt: new Date(now()).toISOString(), capacity: { ...capacityVerdict({ online: online.length, ...metrics, eventLoopLagMs: steadyLag(), testedUsers: testedUsers() }), testedUsers: testedUsers() },
      online, runs, jobs: openJobs(jobRows), renderQueue, system: metrics,
      costs: { todayUsd, last24hUsd, lastHourUsd, unknownToday, topToday: [...byUser.values()].sort((a, b) => b.costUsd - a.costUsd || a.user.localeCompare(b.user)).slice(0, 20) },
      peaks: { h24: peak(now() - DAY), d7: peak(now() - 7 * DAY) },
      history: points.filter((_, index) => index % step === 0).map((row) => Object.fromEntries(['ts', 'online', 'runsRunning', 'jobsOpen', 'loadPerCpu', 'memUsedPct'].map((key) => [key, row[key] ?? null]))),
      strikes: strikes.evaluate() };
  }
  function start() {
    if (timer !== null || !isActive()) return;
    lag.enable();
    void sample();
    timer = setTimer(() => { void sample(); }, 60000);
    timer?.unref?.();
  }
  async function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null; lag.disable();
    if (inFlight) await inFlight;
    try { persist(); } catch (_) { warn('[activity] Load history could not be saved.'); }
  }
  return { start, stop, sample, snapshot };
}

function registerRoutes(app, { isSuperAdmin, activity, strikes = defaultStore } = {}) {
  function route(action) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!isSuperAdmin(req)) return res.sendStatus(404);
      try {
        if (!action) return res.json(await activity.snapshot());
        const user = action === 'block' ? strikes.block(req.body?.email, { by: req.kubleUser, reason: 'manual' }) : strikes.unblock(req.body?.email);
        return res.json({ ok: true, user });
      } catch (error) {
        if (error.code === 'INVALID_EMAIL') return res.status(400).json({ code: error.code });
        if (error.code === 'CANNOT_BLOCK_ADMIN') return res.status(409).json({ code: error.code });
        return res.status(503).json({ code: 'ACTIVITY_UNAVAILABLE' });
      }
    };
  }
  app.get('/api/admin/activity', route());
  app.post('/api/admin/activity/block', route('block'));
  app.post('/api/admin/activity/unblock', route('unblock'));
}
module.exports = { createActivity, capacityVerdict, registerRoutes };
