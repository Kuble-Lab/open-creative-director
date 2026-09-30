'use strict';

// Usage and cost monitoring for superadmins (SUPERADMIN_EMAILS). Data comes from the cost journal
// (data/costs.jsonl, field `user`), the retained workflow runs, the jobs of the sessions and a small
// journal of failed API requests. Routes:
//   GET /api/admin/monitoring          report as JSON
//   GET /api/admin/monitoring/export   all matching cost rows as CSV
// Both answer 404 to everybody but superadmins (the feature does not exist for them), and are only
// registered by server.js; nothing here changes the local mode.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { PATHS } = require('./config');

const ERROR_FILE = path.join(PATHS.root, 'data', 'admin-api-errors.json');
const MAX_ERRORS = 1000;
const RETENTION_MS = 30 * 86400000;
const DAY_OPTIONS = Object.freeze(['7', '30', '90', 'all']);
const ROW_LIMIT = 100;
const ZURICH_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value, max = 254) => String(value || '').slice(0, max);

class InvalidFilterError extends Error {
  constructor() {
    super('INVALID_FILTER');
    this.code = 'INVALID_FILTER';
  }
}

// The company behind a cost row: the model prefix (openai, anthropic ...), else the journal type
// (higgsfield, fal, motion graphics run on the render node).
function providerOf(row) {
  if (row.type === 'higgsfield' || row.type === 'fal') return row.type;
  if (row.type === 'motion') return 'rendernode';
  const prefix = String(row.model || '').split('/')[0].trim().toLowerCase();
  return prefix && prefix !== String(row.model || '').toLowerCase() ? prefix : (row.type || 'unknown');
}

function dayOf(ts) {
  return ZURICH_DAY.format(new Date(ts));
}

function tokens(usage) {
  const input = amount(usage?.input_tokens);
  const output = amount(usage?.output_tokens);
  return { input, output, total: amount(usage?.total_tokens) ?? (input !== null && output !== null ? input + output : null) };
}

function usageRows(costRows) {
  return costRows
    .map((row) => ({
      ts: row.ts,
      user: text(row.user),
      provider: providerOf(row),
      model: text(row.model),
      type: text(row.type, 30),
      sessionId: text(row.sessionId),
      assetId: text(row.assetId),
      billing: text(row.billing, 40),
      costUsd: amount(row.cost),
      tokens: tokens(row.usage)
    }))
    .filter((row) => Number.isFinite(Date.parse(row.ts)));
}

function filters(query = {}, now = Date.now()) {
  const days = String(query.days === undefined ? '30' : query.days);
  if (!DAY_OPTIONS.includes(days)) throw new InvalidFilterError();
  for (const key of ['user', 'provider']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') throw new InvalidFilterError();
  }
  return {
    days,
    since: days === 'all' ? 0 : now - Number(days) * 86400000,
    user: text(query.user).trim().toLowerCase(),
    provider: text(query.provider).trim().toLowerCase()
  };
}

function totalsOf(rows) {
  return rows.reduce(
    (out, row) => {
      out.count += 1;
      if (row.costUsd === null) out.unknownCost += 1;
      else out.costUsd += row.costUsd;
      if (row.billing === 'Abo') out.subscriptionCount += 1;
      for (const key of ['input', 'output', 'total']) {
        if (row.tokens[key] !== null) {
          out[`${key}Tokens`] += row.tokens[key];
          out[`${key}Reported`] += 1;
        }
      }
      return out;
    },
    { count: 0, costUsd: 0, unknownCost: 0, subscriptionCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputReported: 0, outputReported: 0, totalReported: 0 }
  );
}

function group(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = field === 'day' ? dayOf(row.ts) : row[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, items]) => ({ key, ...totalsOf(items) }));
}

const byCostThenName = (a, b) => b.costUsd - a.costUsd || b.count - a.count || String(a.key).localeCompare(String(b.key));

function countBy(items, field) {
  const map = new Map();
  for (const item of items) map.set(item[field], (map.get(item[field]) || 0) + 1);
  return [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

// runRows: { workflowId, id, user, status, startedAt, finishedAt, costUsd, error }
// jobRows: { sessionId, jobId, user, provider, kind, status, ts, error }
// errorRows: { ts, method, route, status, code, user, durationMs }
function summarise({ costRows = [], runRows = [], jobRows = [], errorRows = [] }, query = {}, now = Date.now()) {
  const filter = filters(query, now);
  const inPeriod = (ts) => {
    const time = Date.parse(ts);
    return Number.isFinite(time) && time >= filter.since && time <= now;
  };
  const allUsage = usageRows(costRows).filter((row) => inPeriod(row.ts));
  const rows = allUsage
    .filter((row) => (!filter.user || row.user.toLowerCase() === filter.user) && (!filter.provider || row.provider === filter.provider))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const runs = runRows.filter((run) => inPeriod(run.startedAt) && (!filter.user || String(run.user).toLowerCase() === filter.user));
  const failedRuns = runs.filter((run) => run.status === 'failed' || run.status === 'interrupted');
  const jobs = jobRows.filter(
    (job) =>
      inPeriod(job.ts) &&
      (!filter.user || String(job.user || '').toLowerCase() === filter.user) &&
      (!filter.provider || String(job.provider || '').toLowerCase() === filter.provider)
  );
  const failedJobs = jobs.filter((job) => job.status === 'failed');
  // Request errors carry no provider; the period and the person filter apply.
  const errors = errorRows
    .filter((row) => inPeriod(row.ts) && (!filter.user || String(row.user || '').toLowerCase() === filter.user))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const denied = errors.filter((row) => [401, 403].includes(row.status));
  const failures = errors.filter((row) => ![401, 403].includes(row.status));

  return {
    filters: { days: filter.days, user: filter.user, provider: filter.provider },
    options: {
      days: DAY_OPTIONS.slice(),
      users: [...new Set(allUsage.map((row) => row.user))].sort(),
      providers: [...new Set(allUsage.map((row) => row.provider))].sort()
    },
    totals: { ...totalsOf(rows), runs: runs.length, failedRuns: failedRuns.length, jobs: jobs.length, failedJobs: failedJobs.length, apiErrors: failures.length },
    byUser: group(rows, 'user').sort(byCostThenName),
    byProvider: group(rows, 'provider').sort(byCostThenName),
    byType: group(rows, 'type').sort(byCostThenName),
    byDay: group(rows, 'day').sort((a, b) => String(b.key).localeCompare(String(a.key))),
    rows,
    runs: {
      total: runs.length,
      failed: failedRuns.length,
      byUser: countBy(runs, 'user'),
      errors: failedRuns
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, ROW_LIMIT)
        .map((run) => ({ ts: run.startedAt, workflowId: text(run.workflowId), runId: text(run.id), user: text(run.user), status: run.status, error: text(run.error, 300) }))
    },
    jobs: {
      total: jobs.length,
      failed: failedJobs.length,
      byProvider: countBy(jobs, 'provider'),
      errors: failedJobs
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        .slice(0, ROW_LIMIT)
        .map((job) => ({ ts: job.ts, sessionId: text(job.sessionId), jobId: text(job.jobId), user: text(job.user), provider: text(job.provider), kind: text(job.kind, 30), error: text(job.error, 300) }))
    },
    errors: { total: failures.length, rows: failures.slice(0, ROW_LIMIT), denied: denied.length, deniedRows: denied.slice(0, ROW_LIMIT) }
  };
}

// Semicolon-separated with a BOM (opens correctly in Swiss Excel). Cells that start like a formula are
// prefixed with a quote so a value can never be executed by a spreadsheet.
function csv(rows) {
  const cell = (value) => {
    let out = value === null || value === undefined ? '' : String(value);
    if (/^[\s]*[=+@-]/u.test(out) || /^[\t\r\n]/u.test(out)) out = `'${out}`;
    return `"${out.replaceAll('"', '""')}"`;
  };
  const fields = ['timestamp_utc', 'day_zurich', 'user', 'provider', 'model', 'type', 'session_id', 'asset_id', 'billing', 'cost_usd', 'input_tokens', 'output_tokens', 'total_tokens'];
  const lines = rows.map((row) => [
    row.ts, dayOf(row.ts), row.user, row.provider, row.model, row.type, row.sessionId, row.assetId, row.billing,
    row.costUsd, row.tokens.input, row.tokens.output, row.tokens.total
  ]);
  return `\ufeff${[fields, ...lines].map((line) => line.map(cell).join(';')).join('\r\n')}\r\n`;
}

/* ---------- journal of failed API requests ---------- */

// Failed requests are buffered in memory and written in batches (at most one file write per FLUSH_MS), so a stream
// of failing calls, also from anonymous callers, costs neither unbounded memory nor a full read and rewrite of the
// journal per request. The buffer is bounded (MAX_PENDING, and MAX_PENDING_PER_USER per person and window);
// what does not fit is only counted (runtime().droppedErrors).
const FLUSH_MS = 2000;
const MAX_PENDING = 200;
const MAX_PENDING_PER_USER = 50;

function createMonitor({ file = ERROR_FILE, now = () => Date.now(), flushMs = FLUSH_MS } = {}) {
  const startedAt = new Date(now()).toISOString();
  let requests = 0;
  let failedRequests = 0;
  let droppedErrors = 0;
  let journalWritable = true;
  let queue = Promise.resolve();
  let pending = [];
  const pendingPerUser = new Map();
  let timer = null;

  async function readJournal() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('INVALID_JOURNAL');
      return parsed.filter((row) => Date.parse(row.ts) >= now() - RETENTION_MS);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // The journal plus what has not been written yet.
  async function readErrors() {
    const stored = await readJournal();
    return [...stored, ...pending.filter((row) => Date.parse(row.ts) >= now() - RETENTION_MS)].slice(-MAX_ERRORS);
  }

  function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return queue;
    const batch = pending;
    pending = [];
    pendingPerUser.clear();
    queue = queue
      .then(async () => {
        const retained = [...(await readJournal().catch(() => [])), ...batch].slice(-MAX_ERRORS);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(retained), { mode: 0o600 });
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        journalWritable = true;
      })
      .catch(() => {
        journalWritable = false;
        console.warn('[monitoring] API-Fehlerjournal konnte nicht gespeichert werden.');
      });
    return queue;
  }

  function recordError(row) {
    const user = String(row.user || '');
    const perUser = pendingPerUser.get(user) || 0;
    if (pending.length >= MAX_PENDING || perUser >= MAX_PENDING_PER_USER) {
      droppedErrors += 1;
      return queue;
    }
    pending.push(row);
    pendingPerUser.set(user, perUser + 1);
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushNow();
      }, flushMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return queue;
  }

  // Records only the route template, status and person: never URLs, query strings, bodies or messages.
  function middleware(req, res, next) {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/admin/monitoring')) return next();
    const start = now();
    let recorded = false;
    function complete(aborted) {
      if (recorded) return;
      recorded = true;
      requests += 1;
      if (res.statusCode < 400 && !aborted) return;
      failedRequests += 1;
      const route = typeof req.route?.path === 'string' && req.route.path.startsWith('/api/') ? req.route.path : '/api/(unmatched)';
      void recordError({
        ts: new Date(now()).toISOString(),
        method: req.method,
        route,
        status: aborted ? 499 : res.statusCode,
        code: aborted ? 'REQUEST_ABORTED' : `HTTP_${res.statusCode}`,
        user: text(req.kubleUser || 'lokal'),
        durationMs: Math.max(0, now() - start)
      });
    }
    res.once('finish', () => complete(false));
    res.once('close', () => {
      if (!res.writableFinished) complete(true);
    });
    next();
  }

  function runtime() {
    return {
      startedAt,
      uptimeSeconds: Math.max(0, Math.floor((now() - Date.parse(startedAt)) / 1000)),
      requests,
      failedRequests,
      droppedErrors,
      journalWritable,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576)
    };
  }

  return { middleware, runtime, readErrors, recordError, flush: flushNow };
}

/* ---------- session jobs ---------- */

// Reads the jobs of all sessions. Session files can be large, so a parsed file is remembered until it changes.
function createJobsReader({ projectsDir = PATHS.projectsDir } = {}) {
  const cache = new Map();
  return async function readJobs() {
    let files = [];
    try {
      files = (await fs.readdir(projectsDir)).filter((file) => file.endsWith('.json'));
    } catch (_) {
      return [];
    }
    const current = new Set(files);
    for (const key of cache.keys()) if (!current.has(key)) cache.delete(key);
    const out = [];
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(path.join(projectsDir, file));
      } catch (_) {
        continue;
      }
      let entry = cache.get(file);
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        try {
          const session = JSON.parse(await fs.readFile(path.join(projectsDir, file), 'utf8'));
          const owner = typeof session.owner === 'string' && session.owner ? session.owner : 'lokal';
          entry = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            jobs: (Array.isArray(session.jobs) ? session.jobs : []).map((job) => ({
              sessionId: text(session.id),
              jobId: text(job.jobId),
              user: owner,
              // Jobs without a provider were started through OpenRouter.
              provider: text(job.provider || 'openrouter', 40),
              kind: text(job.kind || 'video', 30),
              status: text(job.status, 30),
              ts: job.createdAt || job.submittedAt || null,
              error: job.error ? text(job.error, 300) : null
            }))
          };
        } catch (_) {
          entry = { mtimeMs: stat.mtimeMs, size: stat.size, jobs: [] };
        }
        cache.set(file, entry);
      }
      out.push(...entry.jobs);
    }
    return out;
  };
}

/* ---------- routes ---------- */

function registerRoutes(app, { isSuperAdmin, monitor, getRuntime = () => ({}), readData } = {}) {
  const load = readData;
  if (typeof isSuperAdmin !== 'function' || typeof load !== 'function') throw new Error('registerRoutes needs isSuperAdmin and readData');

  async function handle(req, res, download) {
    res.set('Cache-Control', 'no-store');
    if (!isSuperAdmin(req)) return res.sendStatus(404);
    try {
      filters(req.query);
      const report = summarise(await load(), req.query);
      if (download) return res.type('text/csv; charset=utf-8').attachment('usage-monitoring.csv').send(csv(report.rows));
      return res.json({
        ...report,
        rows: report.rows.slice(0, ROW_LIMIT),
        generatedAt: new Date().toISOString(),
        runtime: { ...(monitor ? monitor.runtime() : {}), ...getRuntime() }
      });
    } catch (error) {
      if (error.code === 'INVALID_FILTER') return res.status(400).json({ error: 'INVALID_FILTER' });
      console.warn('[monitoring]', error.message);
      return res.status(503).json({ error: 'MONITORING_UNAVAILABLE' });
    }
  }

  app.get('/api/admin/monitoring', (req, res) => handle(req, res, false));
  app.get('/api/admin/monitoring/export', (req, res) => handle(req, res, true));
}

module.exports = {
  ERROR_FILE,
  DAY_OPTIONS,
  ROW_LIMIT,
  providerOf,
  dayOf,
  filters,
  summarise,
  csv,
  createMonitor,
  createJobsReader,
  registerRoutes
};
