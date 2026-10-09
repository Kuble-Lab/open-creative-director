'use strict';

// The central queue of render jobs for own computers (WP46).
//
// As soon as a paired computer that may render for the owner of a job is online, lib/rendernode.js puts the job here
// instead of sending it to a render node itself. Then:
//   - an idle computer (an agent waiting in its long poll) takes the next job it may render; among computers that are idle
//     at the same moment the owner's own computer comes first, then a computer of a team, then a shared one;
//   - an idle shared render node (push node, render-node/service.js) gets the next job when no computer takes it: the app
//     sends it there exactly as it sends any job;
//   - work stealing: when nothing waits in the queue, an idle computer or render node also takes a second copy of a job that
//     a computer has been rendering for a while (at least backupAfterMs and, after its progress, still backupMinRemainingMs
//     to go); the first result wins, the other copy is cancelled. So a slow laptop never holds up the last chunk of a film.
// A job belongs to a computer only while it reports (a lease): without a sign of life for leaseTimeoutMs, or after
// renderDeadlineMs, the job goes back into the queue and is handed out again, also to a render node. The job id the caller
// got stays the same throughout; the poller (status, download) and the nodes waiting for it see nothing but the time.
//
// On disk: data/render-queue/<job id>/ with job.json (mode 600, replaced atomically), index.html, assets/ and result.mp4.
// After a restart of the app a running job keeps its lease for leaseTimeoutMs: a computer that reports in time goes on,
// otherwise the job is handed out again. Jobs on a render node are watched on. Finished jobs are removed after a day.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const QUEUE_NODE_ID = 'render-queue';
const JOB_ID_PATTERN = /^rq-[a-z0-9]{6,12}-[0-9a-f]{8}$/;
const LEASE_PATTERN = /^[0-9a-f]{32}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const QUALITIES = new Set(['draft', 'standard', 'high']);
const RESOLUTIONS = new Set(['landscape', 'portrait', 'square']);

const DEFAULTS = Object.freeze({
  pollWaitMs: 25000,
  agentOnlineMs: 45000,
  heartbeatMs: 10000,
  leaseTimeoutMs: 60000,
  renderDeadlineMs: 20 * 60 * 1000,
  uploadGraceMs: 15 * 60 * 1000,
  backupAfterMs: 60000,
  backupMinRemainingMs: 30000,
  orphanMs: 10 * 60 * 1000,
  maxAttempts: 5,
  maxFailures: 2,
  pushPollMs: 5000,
  pushLostMs: 3 * 60 * 1000,
  pushCooldownMs: 30000,
  sweepMs: 5000,
  finishedTtlMs: 24 * 60 * 60 * 1000,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxAssets: 10,
  maxAssetBytes: 500 * 1024 * 1024,
  maxResultBytes: 1024 * 1024 * 1024,
  historyEntries: 12
});

class RenderQueueError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'RenderQueueError';
    this.code = code;
    this.status = status;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = (ms) => new Date(ms).toISOString();
const ms = (text) => {
  const value = Date.parse(text || '');
  return Number.isFinite(value) ? value : 0;
};

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

// The first box of an MP4 file is "ftyp" (bytes 4 to 8).
async function looksLikeMp4(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return bytesRead >= 8 && buffer.toString('latin1', 4, 8) === 'ftyp';
  } finally {
    await handle.close();
  }
}

// agents      lib/render-agents.js store (authenticate is done by the routes; here: getAgent, touch, record*, lastSeenMs)
// mayServe    (agent, owner) -> 0 own | 1 team | 2 everybody | -1 not allowed
// push        the push side of lib/rendernode.js: { listNodes, nodeStatus, sendJob, jobStatus, download, resetStatusCache }
function createRenderQueue({ dir, agents, mayServe, push = null, now = Date.now, limits = {}, log = console } = {}) {
  if (!dir) throw new Error('render queue: dir is required');
  const config = { ...DEFAULTS, ...limits };
  const jobs = new Map(); // id -> job record (as in job.json)
  const waiters = new Set(); // { agent, since, resolve, timer }
  const seen = new Map(); // agent id -> last request (ms)
  const pushCooldown = new Map(); // node id -> until (ms)
  let loaded = false;
  let stopped = false;
  let timers = [];
  let dispatching = false;
  let dispatchAgain = false;
  let monitoring = false;

  const jobDir = (id) => path.join(dir, id);
  const jobFile = (id) => path.join(jobDir(id), 'job.json');
  const resultFile = (id) => path.join(jobDir(id), 'result.mp4');

  /* ---------- persistence ---------- */

  function persist(job) {
    job.updatedAt = iso(now());
    try {
      fs.mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 });
      writeJsonAtomic(jobFile(job.id), job);
    } catch (err) {
      log.warn?.(`[render-queue] ${job.id} konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn?.(`[render-queue] ${dir} konnte nicht gelesen werden: ${err.message}`);
    }
    const at = now();
    for (const name of names) {
      if (!JOB_ID_PATTERN.test(name)) continue;
      let job;
      try {
        job = JSON.parse(fs.readFileSync(jobFile(name), 'utf8'));
      } catch (_) {
        continue;
      }
      if (!isPlainObject(job) || job.id !== name) continue;
      job.attempts = Array.isArray(job.attempts) ? job.attempts : [];
      job.history = Array.isArray(job.history) ? job.history : [];
      if (job.status === 'running') {
        // A computer gets leaseTimeoutMs to report again; a job a render node took over is watched on. A job that was being
        // sent to a render node when the app stopped never got there.
        job.attempts = job.attempts.filter((attempt) => attempt.kind === 'agent' || (attempt.kind === 'push' && attempt.remoteJobId));
        for (const attempt of job.attempts) attempt.lastSeenAt = at;
        if (!job.attempts.length) {
          job.status = 'queued';
          job.queuedAt = at;
        }
      }
      if (job.status === 'queued') job.lastWorkerAt = at;
      jobs.set(name, job);
    }
  }

  /* ---------- who is online, who may render what ---------- */

  function rankFor(agent, owner) {
    try {
      const rank = mayServe(agent, owner);
      return Number.isInteger(rank) && rank >= 0 ? rank : -1;
    } catch (_) {
      return -1;
    }
  }

  function agentOnline(agentId, at = now()) {
    const last = seen.get(agentId) || 0;
    if (at - last < config.agentOnlineMs) return true;
    // a computer that is rendering reports through its lease
    for (const job of jobs.values()) {
      if (job.status !== 'running') continue;
      if (job.attempts.some((attempt) => attempt.kind === 'agent' && attempt.agentId === agentId && at - attempt.lastSeenAt < config.leaseTimeoutMs)) return true;
    }
    return false;
  }

  // Is a computer online that may render for this owner? Then its jobs come into the queue (lib/rendernode.js submit).
  function acceptsOwner(owner) {
    if (!owner || !agents) return false;
    let list;
    try {
      list = agents.listAgents();
    } catch (_) {
      return false;
    }
    const at = now();
    return list.some((agent) => agentOnline(agent.id, at) && rankFor(agent, owner) >= 0);
  }

  /* ---------- jobs in ---------- */

  function newJobId() {
    return `rq-${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  // assetFiles: { files: [{ filename, path, size }] } (lib/rendernode.js normaliseAssetFiles) or a base64 map { name: data }.
  async function enqueue({ html, quality = 'standard', assetFiles = null, legacyAssets = null, resolution, fps, owner, label } = {}) {
    ensureLoaded();
    const document = String(html || '');
    if (!document.trim()) throw new RenderQueueError('HTML-Composition fehlt.', 'INVALID_JOB');
    if (Buffer.byteLength(document, 'utf8') > config.maxHtmlBytes) throw new RenderQueueError('html zu gross (max 2 MB)', 'TOO_LARGE', 413);
    if (!QUALITIES.has(quality)) throw new RenderQueueError(`Ungültige Render-Qualität: ${quality}.`, 'INVALID_JOB');
    if (resolution !== undefined && resolution !== null && !RESOLUTIONS.has(resolution)) throw new RenderQueueError(`Ungültige Render-Auflösung: ${resolution}.`, 'INVALID_JOB');
    const files = Array.isArray(assetFiles?.files) ? assetFiles.files : [];
    const legacy = isPlainObject(legacyAssets) ? Object.entries(legacyAssets) : [];
    if (files.length + legacy.length > config.maxAssets) throw new RenderQueueError(`Zu viele Assets (max ${config.maxAssets})`, 'TOO_LARGE', 413);
    for (const name of [...files.map((file) => file.filename), ...legacy.map(([name]) => name)]) {
      if (!FILE_PATTERN.test(name) || name.includes('..')) throw new RenderQueueError(`Ungültiger Render-Asset-Dateiname: ${name || '-'}`, 'INVALID_JOB');
    }
    const id = newJobId();
    const folder = jobDir(id);
    const assetsFolder = path.join(folder, 'assets');
    const assets = [];
    try {
      await fsp.mkdir(assetsFolder, { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(folder, 'index.html'), document, { encoding: 'utf8', mode: 0o600 });
      let total = 0;
      for (const file of files) {
        const target = path.join(assetsFolder, file.filename);
        if (assets.some((asset) => asset.filename === file.filename)) throw new RenderQueueError(`Doppelter Asset-Name: ${file.filename}`, 'INVALID_JOB');
        // a hard link costs no space; across file systems the file is copied
        try {
          await fsp.link(file.path, target);
        } catch (_) {
          await fsp.copyFile(file.path, target);
        }
        const { size } = await fsp.stat(target);
        total += size;
        if (total > config.maxAssetBytes) throw new RenderQueueError('Assets zu gross (max 500 MB gesamt)', 'TOO_LARGE', 413);
        assets.push({ filename: file.filename, size });
      }
      for (const [name, data] of legacy) {
        const buffer = Buffer.from(String(data), 'base64');
        total += buffer.length;
        if (total > config.maxAssetBytes) throw new RenderQueueError('Assets zu gross (max 500 MB gesamt)', 'TOO_LARGE', 413);
        await fsp.writeFile(path.join(assetsFolder, name), buffer, { mode: 0o600 });
        assets.push({ filename: name, size: buffer.length });
      }
    } catch (err) {
      await fsp.rm(folder, { recursive: true, force: true });
      throw err;
    }
    const at = now();
    const job = {
      id,
      owner: String(owner || 'lokal'),
      label: typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '',
      quality,
      resolution: resolution === undefined ? null : resolution,
      fps: fps === undefined ? null : fps,
      assets,
      htmlBytes: Buffer.byteLength(document, 'utf8'),
      status: 'queued',
      createdAt: iso(at),
      updatedAt: iso(at),
      queuedAt: at,
      lastWorkerAt: at,
      attempts: [],
      tries: 0,
      failures: 0,
      history: [],
      error: null,
      completedAt: null,
      completedBy: null,
      resultBytes: null
    };
    jobs.set(id, job);
    persist(job);
    scheduleDispatch();
    return { jobId: id, nodeId: QUEUE_NODE_ID };
  }

  /* ---------- leases ---------- */

  function newLease() {
    return crypto.randomBytes(16).toString('hex');
  }

  function remember(job, attempt, outcome, error) {
    job.history.push({
      kind: attempt.kind,
      ...(attempt.kind === 'agent' ? { agentId: attempt.agentId } : { nodeId: attempt.nodeId }),
      name: attempt.name,
      startedAt: iso(attempt.startedAt),
      endedAt: iso(now()),
      outcome,
      ...(attempt.backup ? { backup: true } : {}),
      ...(error ? { error: String(error).slice(0, 300) } : {})
    });
    if (job.history.length > config.historyEntries) job.history.splice(0, job.history.length - config.historyEntries);
  }

  function startAttempt(job, fields) {
    const at = now();
    const attempt = {
      lease: newLease(),
      startedAt: at,
      lastSeenAt: at,
      deadlineAt: at + config.renderDeadlineMs,
      progress: 0,
      backup: job.attempts.length > 0,
      uploading: false,
      ...fields
    };
    job.attempts.push(attempt);
    job.tries += 1;
    job.status = 'running';
    if (!job.startedAt) job.startedAt = iso(at);
    persist(job);
    return attempt;
  }

  // Ends one attempt. outcome: completed (the job is done), failed (the render failed: counts), released (the computer
  // stopped), lost (no sign of life / deadline), revoked (the computer was removed), cancelled (another copy finished).
  // A render node that finished or lost a job is free again: its cached status must not say "running" for another 15 s.
  function freePush(attempt) {
    if (attempt.kind !== 'push' || !push || typeof push.resetStatusCache !== 'function') return;
    try {
      push.resetStatusCache(attempt.nodeId);
    } catch (_) {
      /* only a cache */
    }
  }

  function endAttempt(job, attempt, outcome, error) {
    const index = job.attempts.indexOf(attempt);
    if (index < 0) return;
    job.attempts.splice(index, 1);
    remember(job, attempt, outcome, error);
    freePush(attempt);
    if (outcome === 'failed') {
      job.failures += 1;
      job.lastError = String(error || 'Render fehlgeschlagen').slice(0, 800);
      if (attempt.kind === 'agent') agents?.recordFailed?.(attempt.agentId);
    }
    if (job.status !== 'running') {
      persist(job);
      return;
    }
    if (job.attempts.length) {
      persist(job);
      return;
    }
    if (job.failures >= config.maxFailures || job.tries >= config.maxAttempts) {
      failJob(job, job.lastError || `Render-Job konnte nach ${job.tries} Versuchen nicht fertig werden (${outcome}).`);
      return;
    }
    job.status = 'queued';
    job.queuedAt = now();
    job.lastWorkerAt = now();
    persist(job);
    scheduleDispatch();
  }

  function failJob(job, message) {
    for (const attempt of [...job.attempts]) {
      job.attempts.splice(job.attempts.indexOf(attempt), 1);
      remember(job, attempt, 'cancelled');
      freePush(attempt);
    }
    job.status = 'failed';
    job.error = String(message || 'Render fehlgeschlagen').slice(0, 800);
    job.completedAt = iso(now());
    persist(job);
  }

  function completeJob(job, attempt, bytes) {
    job.attempts.splice(job.attempts.indexOf(attempt), 1);
    remember(job, attempt, 'completed');
    freePush(attempt);
    for (const other of [...job.attempts]) {
      job.attempts.splice(job.attempts.indexOf(other), 1);
      remember(job, other, 'cancelled');
      freePush(other);
    }
    job.status = 'completed';
    job.completedAt = iso(now());
    job.completedBy = { kind: attempt.kind, name: attempt.name };
    job.resultBytes = bytes;
    job.error = null;
    persist(job);
    if (attempt.kind === 'agent') agents?.recordCompleted?.(attempt.agentId);
    scheduleDispatch();
  }

  /* ---------- handing out ---------- */

  function queuedJobs() {
    return [...jobs.values()].filter((job) => job.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }

  function payloadFor(job, attempt, agent) {
    const html = fs.readFileSync(path.join(jobDir(job.id), 'index.html'), 'utf8');
    const own = agent.owner === job.owner;
    return {
      jobId: job.id,
      lease: attempt.lease,
      html,
      quality: job.quality,
      ...(job.resolution ? { resolution: job.resolution } : {}),
      ...(job.fps ? { fps: job.fps } : {}),
      assets: job.assets.map((asset) => ({ filename: asset.filename, size: asset.size })),
      // what the computer may show: the label of its owner's own jobs, nothing about other people
      label: own ? job.label || '' : '',
      own,
      backup: attempt.backup,
      heartbeatMs: config.heartbeatMs,
      deadlineAt: iso(attempt.deadlineAt),
      maxResultBytes: config.maxResultBytes
    };
  }

  function leaseToAgent(job, agent) {
    return startAttempt(job, { kind: 'agent', agentId: agent.id, name: agent.name });
  }

  // The best job for a computer that asks: its owner's jobs first, then the team's, then everybody's; oldest first.
  function takeQueued(agent) {
    let best = null;
    for (const job of queuedJobs()) {
      const rank = rankFor(agent, job.owner);
      if (rank < 0) continue;
      if (!best || rank < best.rank) best = { job, rank };
      if (rank === 0) break;
    }
    return best ? best.job : null;
  }

  function estimatedRemaining(attempt, at) {
    const elapsed = at - attempt.startedAt;
    if (attempt.progress >= 0.05) return (elapsed * (1 - attempt.progress)) / attempt.progress;
    return Infinity;
  }

  // Work stealing: a job a computer has been rendering for a while, that the asking worker may render as well.
  function stealable(canTake, at = now()) {
    const candidates = [];
    for (const job of jobs.values()) {
      if (job.status !== 'running' || job.attempts.length !== 1 || job.tries >= config.maxAttempts) continue;
      const attempt = job.attempts[0];
      if (attempt.kind !== 'agent' || attempt.uploading) continue;
      if (at - attempt.startedAt < config.backupAfterMs) continue;
      if (estimatedRemaining(attempt, at) < config.backupMinRemainingMs) continue;
      if (!canTake(job, attempt)) continue;
      candidates.push({ job, startedAt: attempt.startedAt });
    }
    candidates.sort((a, b) => a.startedAt - b.startedAt);
    return candidates.length ? candidates[0].job : null;
  }

  function markSeen(agent, report = {}) {
    seen.set(agent.id, now());
    try {
      agents?.touch?.(agent.id, report);
    } catch (_) {
      /* the sign of life is best effort */
    }
  }

  // The long poll of a computer: a job (payload) or null after waitMs. `running`: the leases the computer still works on
  // (anything else it held is released: it asks for work, so it does not render it any more).
  function poll(agent, { waitMs = config.pollWaitMs, signal, running = [], report = {} } = {}) {
    ensureLoaded();
    markSeen(agent, report);
    const keep = new Set(Array.isArray(running) ? running.filter((lease) => typeof lease === 'string') : []);
    for (const job of [...jobs.values()]) {
      for (const attempt of [...job.attempts]) {
        if (attempt.kind === 'agent' && attempt.agentId === agent.id && !keep.has(attempt.lease)) endAttempt(job, attempt, 'released', 'Der Rechner hat den Auftrag nicht mehr.');
      }
    }
    const direct = offerTo(agent);
    if (direct) return Promise.resolve(direct);
    return new Promise((resolve) => {
      const waiter = { agent, since: now(), resolve: null, timer: null };
      const finish = (value) => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      waiter.resolve = finish;
      waiter.timer = setTimeout(() => finish(null), Math.max(0, waitMs));
      waiter.timer.unref?.();
      waiters.add(waiter);
      if (signal) {
        if (signal.aborted) return finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // A queued job, or a copy of a slow one, for this computer right now (or null).
  function offerTo(agent) {
    const job = takeQueued(agent);
    if (job) {
      const attempt = leaseToAgent(job, agent);
      return payloadFor(job, attempt, agent);
    }
    const slow = stealableForAgent(agent);
    if (slow) {
      const attempt = leaseToAgent(slow, agent);
      return payloadFor(slow, attempt, agent);
    }
    return null;
  }

  // The waiting computer of exactly this rank for the job (0 own, 1 team, 2 everybody) that has waited longest.
  function waiterOfRank(job, rank) {
    let best = null;
    for (const waiter of waiters) {
      if (rankFor(waiter.agent, job.owner) !== rank) continue;
      if (!best || waiter.since < best.since) best = waiter;
    }
    return best;
  }

  function pushBusy(nodeId) {
    for (const job of jobs.values()) {
      if (job.status === 'running' && job.attempts.some((attempt) => attempt.kind === 'push' && attempt.nodeId === nodeId)) return true;
    }
    return false;
  }

  async function freePushNodes() {
    if (!push) return [];
    let nodes = [];
    try {
      nodes = push.listNodes();
    } catch (_) {
      return [];
    }
    const at = now();
    const free = [];
    for (const node of nodes) {
      if ((pushCooldown.get(node.id) || 0) > at || pushBusy(node.id)) continue;
      let status;
      try {
        status = await push.nodeStatus(node);
      } catch (_) {
        continue;
      }
      if (status.online && !status.running && Number(status.queue) === 0) free.push({ node, status });
    }
    return free;
  }

  // Sends a job to a render node exactly like a direct job (lib/rendernode.js sendJob); the attempt exists at once, the
  // transfer runs in the background.
  function leaseToPush(job, { node, status }) {
    const attempt = startAttempt(job, { kind: 'push', nodeId: node.id, name: node.name, remoteJobId: null, sending: true });
    (async () => {
      const folder = jobDir(job.id);
      const html = await fsp.readFile(path.join(folder, 'index.html'), 'utf8');
      const assetFiles = job.assets.length
        ? {
            files: job.assets.map((asset) => ({ filename: asset.filename, path: path.join(folder, 'assets', asset.filename), size: asset.size })),
            totalBytes: job.assets.reduce((sum, asset) => sum + asset.size, 0)
          }
        : null;
      const remoteJobId = await push.sendJob(node, status, {
        html,
        quality: job.quality,
        assetFiles,
        ...(job.resolution ? { resolution: job.resolution } : {}),
        ...(job.fps ? { fps: job.fps } : {})
      });
      if (!job.attempts.includes(attempt)) return; // the job finished elsewhere while it was being sent
      attempt.remoteJobId = String(remoteJobId);
      attempt.sending = false;
      attempt.lastSeenAt = now();
      persist(job);
    })().catch((err) => {
      pushCooldown.set(node.id, now() + config.pushCooldownMs);
      if (!job.attempts.includes(attempt)) return;
      job.tries = Math.max(0, job.tries - 1); // a job that never reached the node does not count as a try
      endAttempt(job, attempt, 'lost', `Render-Node ${node.name}: ${err.message}`);
    });
    return attempt;
  }

  function scheduleDispatch() {
    if (stopped) return;
    setImmediate(() => {
      dispatch().catch((err) => log.warn?.(`[render-queue] Verteilung fehlgeschlagen: ${err.message}`));
    });
  }

  const stealableForAgent = (agent) => stealable((candidate, attempt) => attempt.agentId !== agent.id && rankFor(agent, candidate.owner) >= 0);

  async function dispatch() {
    ensureLoaded();
    if (stopped) return;
    if (dispatching) {
      dispatchAgain = true;
      return;
    }
    dispatching = true;
    try {
      do {
        dispatchAgain = false;
        // 1. waiting computers take queued jobs: every job to its owner's own computer first, then to a team's, then to a shared one
        for (const rank of [0, 1, 2]) {
          for (const job of queuedJobs()) {
            const waiter = waiterOfRank(job, rank);
            if (!waiter) continue;
            const attempt = leaseToAgent(job, waiter.agent);
            waiter.resolve(payloadFor(job, attempt, waiter.agent));
          }
        }
        // 2. free render nodes take what is left, in the order of the queue
        const needPush = queuedJobs().length > 0 || Boolean(stealable(() => true));
        const free = needPush ? await freePushNodes() : [];
        for (const job of queuedJobs()) {
          const slot = free.shift();
          if (!slot) break;
          leaseToPush(job, slot);
        }
        // 3. work stealing: idle computers and render nodes take a copy of a slow job
        if (!queuedJobs().length) {
          for (const waiter of [...waiters]) {
            const slow = stealableForAgent(waiter.agent);
            if (!slow) continue;
            const attempt = leaseToAgent(slow, waiter.agent);
            waiter.resolve(payloadFor(slow, attempt, waiter.agent));
          }
          for (const slot of free) {
            const slow = stealable(() => true);
            if (!slow) break;
            leaseToPush(slow, slot);
          }
        }
      } while (dispatchAgain);
    } finally {
      dispatching = false;
    }
  }

  /* ---------- what a computer reports ---------- */

  function requireLease(agent, jobId, lease) {
    ensureLoaded();
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new RenderQueueError('Job nicht gefunden', 'JOB_NOT_FOUND', 404);
    const job = jobs.get(jobId);
    // a job that is not the computer's is "not found": it does not learn whether it exists
    if (!job || typeof lease !== 'string' || !LEASE_PATTERN.test(lease)) throw new RenderQueueError('Job nicht gefunden', 'JOB_NOT_FOUND', 404);
    const attempt = job.attempts.find((entry) => entry.kind === 'agent' && entry.lease === lease);
    if (!attempt || attempt.agentId !== agent.id) {
      // a computer that had this job once learns that it is no longer its job (and stops); anybody else gets "not found"
      const held = job.history.some((entry) => entry.kind === 'agent' && entry.agentId === agent.id) || job.attempts.some((entry) => entry.agentId === agent.id);
      if (held) throw new RenderQueueError('Der Auftrag gehört nicht mehr diesem Rechner.', 'LEASE_LOST', 409);
      throw new RenderQueueError('Job nicht gefunden', 'JOB_NOT_FOUND', 404);
    }
    return { job, attempt };
  }

  function progress(agent, jobId, lease, { progress: value } = {}) {
    const { attempt } = requireLease(agent, jobId, lease);
    const at = now();
    attempt.lastSeenAt = at;
    seen.set(agent.id, at);
    if (typeof value === 'number' && Number.isFinite(value)) attempt.progress = Math.min(1, Math.max(0, value));
    return { ok: true, heartbeatMs: config.heartbeatMs };
  }

  function openAsset(agent, jobId, lease, filename) {
    const { job, attempt } = requireLease(agent, jobId, lease);
    const asset = job.assets.find((entry) => entry.filename === filename);
    if (typeof filename !== 'string' || !FILE_PATTERN.test(filename) || !asset) throw new RenderQueueError('Asset nicht gefunden', 'ASSET_NOT_FOUND', 404);
    attempt.lastSeenAt = now();
    return { path: path.join(jobDir(job.id), 'assets', asset.filename), size: asset.size };
  }

  // The rendered file, streamed to disk with a size limit. Every chunk counts as a sign of life.
  async function acceptResult(agent, jobId, lease, stream, { contentLength } = {}) {
    const { job, attempt } = requireLease(agent, jobId, lease);
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > config.maxResultBytes) {
      throw new RenderQueueError(`Ergebnis zu gross (max ${Math.round(config.maxResultBytes / 1024 / 1024)} MB)`, 'TOO_LARGE', 413);
    }
    attempt.uploading = true;
    attempt.deadlineAt = Math.max(attempt.deadlineAt, now() + config.uploadGraceMs);
    const temporary = path.join(jobDir(job.id), `result.${lease}.${crypto.randomBytes(4).toString('hex')}.part`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        attempt.lastSeenAt = now();
        if (received > config.maxResultBytes) {
          return callback(new RenderQueueError(`Ergebnis zu gross (max ${Math.round(config.maxResultBytes / 1024 / 1024)} MB)`, 'TOO_LARGE', 413));
        }
        return callback(null, chunk);
      }
    });
    try {
      await pipeline(stream, limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (!received) throw new RenderQueueError('Das Ergebnis ist leer.', 'INVALID_RESULT', 422);
      if (!(await looksLikeMp4(temporary))) throw new RenderQueueError('Das Ergebnis ist kein MP4-Video.', 'INVALID_RESULT', 422);
      // the lease may have ended during the upload (another copy finished, the computer was removed)
      if (!job.attempts.includes(attempt) || job.status !== 'running') throw new RenderQueueError('Der Auftrag gehört nicht mehr diesem Rechner.', 'LEASE_LOST', 409);
      await fsp.rename(temporary, resultFile(job.id));
    } catch (err) {
      await fsp.rm(temporary, { force: true });
      if (job.attempts.includes(attempt)) attempt.uploading = false;
      throw err;
    }
    completeJob(job, attempt, received);
    return { ok: true, bytes: received };
  }

  function fail(agent, jobId, lease, { error, released = false } = {}) {
    const { job, attempt } = requireLease(agent, jobId, lease);
    endAttempt(job, attempt, released ? 'released' : 'failed', released ? 'Der Rechner hat den Auftrag zurückgegeben.' : `${agent.name}: ${String(error || 'Render fehlgeschlagen').slice(0, 600)}`);
    return { ok: true };
  }

  // The computer was removed: its token no longer works and its jobs go back into the queue.
  function revokeAgent(agentId) {
    ensureLoaded();
    for (const waiter of [...waiters]) if (waiter.agent.id === agentId) waiter.resolve(null);
    seen.delete(agentId);
    for (const job of [...jobs.values()]) {
      for (const attempt of [...job.attempts]) {
        if (attempt.kind === 'agent' && attempt.agentId === agentId) endAttempt(job, attempt, 'revoked', 'Der Rechner wurde entfernt.');
      }
    }
  }

  /* ---------- watching: leases, render nodes, old jobs ---------- */

  function workerAvailableFor(job, at, pushOnline) {
    if (pushOnline) return true;
    let list = [];
    try {
      list = agents ? agents.listAgents() : [];
    } catch (_) {
      list = [];
    }
    return list.some((agent) => agentOnline(agent.id, at) && rankFor(agent, job.owner) >= 0);
  }

  // Is any shared render node online (its status is cached by lib/rendernode.js)?
  async function anyPushOnline() {
    if (!push) return false;
    let nodes = [];
    try {
      nodes = push.listNodes();
    } catch (_) {
      return false;
    }
    for (const node of nodes) {
      try {
        if ((await push.nodeStatus(node)).online) return true;
      } catch (_) {
        /* offline */
      }
    }
    return false;
  }

  async function sweep() {
    ensureLoaded();
    const at = now();
    const pushOnline = [...jobs.values()].some((job) => job.status === 'queued') ? await anyPushOnline() : false;
    for (const job of [...jobs.values()]) {
      if (job.status === 'running') {
        for (const attempt of [...job.attempts]) {
          if (attempt.kind !== 'agent') continue;
          if (at - attempt.lastSeenAt > config.leaseTimeoutMs) endAttempt(job, attempt, 'lost', `${attempt.name} meldet sich nicht mehr.`);
          else if (at > attempt.deadlineAt) endAttempt(job, attempt, 'lost', `${attempt.name} hat die Frist überschritten.`);
        }
      } else if (job.status === 'queued') {
        if (workerAvailableFor(job, at, pushOnline)) job.lastWorkerAt = at;
        else if (at - (job.lastWorkerAt || job.queuedAt) > config.orphanMs) {
          failJob(job, 'Kein Rechner und kein Render-Node für diesen Auftrag online.');
        }
      } else if (at - ms(job.completedAt || job.updatedAt) > config.finishedTtlMs) {
        jobs.delete(job.id);
        await fsp.rm(jobDir(job.id), { recursive: true, force: true }).catch(() => {});
      }
    }
    if (queuedJobs().length || waiters.size) await dispatch();
  }

  async function watchPush() {
    if (monitoring || !push) return;
    monitoring = true;
    try {
      for (const job of [...jobs.values()]) {
        if (job.status !== 'running') continue;
        for (const attempt of [...job.attempts]) {
          if (attempt.kind !== 'push' || !attempt.remoteJobId) continue;
          let info;
          try {
            info = await push.jobStatus(attempt.remoteJobId, attempt.nodeId);
          } catch (err) {
            if (now() - attempt.lastSeenAt > config.pushLostMs || err.status === 404) endAttempt(job, attempt, 'lost', `Render-Node ${attempt.name}: ${err.message}`);
            continue;
          }
          if (!job.attempts.includes(attempt)) continue;
          attempt.lastSeenAt = now();
          const state = String(info?.status || 'pending');
          if (state === 'completed') {
            try {
              const buffer = await push.download(attempt.remoteJobId, attempt.nodeId);
              if (!job.attempts.includes(attempt) || job.status !== 'running') continue;
              const temporary = path.join(jobDir(job.id), `result.${attempt.lease}.part`);
              await fsp.writeFile(temporary, buffer, { mode: 0o600 });
              await fsp.rename(temporary, resultFile(job.id));
              completeJob(job, attempt, buffer.length);
            } catch (err) {
              if (job.attempts.includes(attempt)) endAttempt(job, attempt, 'lost', `Render-Node ${attempt.name}: ${err.message}`);
            }
          } else if (state === 'failed' || state === 'cancelled') {
            endAttempt(job, attempt, 'failed', `Render-Node ${attempt.name}: ${String(info?.error || state).slice(0, 600)}`);
          }
        }
      }
    } finally {
      monitoring = false;
    }
  }

  function start() {
    ensureLoaded();
    stopped = false;
    if (timers.length) return;
    const every = (fn, interval) => {
      const timer = setInterval(() => {
        Promise.resolve()
          .then(fn)
          .catch((err) => log.warn?.(`[render-queue] ${err.message}`));
      }, interval);
      timer.unref?.();
      timers.push(timer);
    };
    every(sweep, config.sweepMs);
    every(watchPush, config.pushPollMs);
    scheduleDispatch();
  }

  // Ends the loops and the long polls; a stopped queue hands out nothing more (a new instance takes over the folder).
  function stop() {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    for (const waiter of [...waiters]) waiter.resolve(null);
  }

  /* ---------- for the poller and the interface ---------- */

  function requireJob(jobId) {
    ensureLoaded();
    const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
    if (!job) throw new RenderQueueError(`Render-Job ${jobId} nicht gefunden`, 'JOB_NOT_FOUND', 404);
    return job;
  }

  // Where the job is rendered right now (the first copy), or where it was rendered.
  function whereOf(job) {
    if (job.status === 'completed' && job.completedBy) return job.completedBy.name;
    const current = job.attempts[0];
    return current ? current.name : null;
  }

  // The status in the form of a render node (GET /jobs/:id): pending, running, completed or failed.
  function status(jobId) {
    const job = requireJob(jobId);
    const map = { queued: 'pending', running: 'running', completed: 'completed', failed: 'failed' };
    const attempt = job.attempts[0];
    return {
      jobId: job.id,
      status: map[job.status] || 'pending',
      ...(job.status === 'failed' ? { error: job.error } : {}),
      nodeName: whereOf(job),
      ...(attempt ? { progress: Math.round(attempt.progress * 100) / 100 } : {}),
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt ? { finishedAt: job.completedAt } : {})
    };
  }

  async function readResult(jobId) {
    const job = requireJob(jobId);
    if (job.status !== 'completed') throw new RenderQueueError(`Job ist ${job.status}`, 'NOT_READY', 409);
    return fsp.readFile(resultFile(job.id));
  }

  // For "My computers": online, last seen and what it renders right now (the label only for its owner's own jobs).
  function agentActivity(agent) {
    ensureLoaded();
    const at = now();
    const current = [];
    for (const job of jobs.values()) {
      if (job.status !== 'running') continue;
      for (const attempt of job.attempts) {
        if (attempt.kind !== 'agent' || attempt.agentId !== agent.id) continue;
        const own = job.owner === agent.owner;
        current.push({
          jobId: job.id,
          own,
          label: own ? job.label || '' : '',
          progress: Math.round(attempt.progress * 100) / 100,
          startedAt: iso(attempt.startedAt),
          backup: attempt.backup
        });
      }
    }
    return { online: agentOnline(agent.id, at), rendering: current };
  }

  function snapshot() {
    ensureLoaded();
    return [...jobs.values()].map((job) => JSON.parse(JSON.stringify(job)));
  }

  return {
    QUEUE_NODE_ID,
    config,
    start,
    stop,
    acceptsOwner,
    enqueue,
    poll,
    progress,
    openAsset,
    acceptResult,
    fail,
    revokeAgent,
    status,
    readResult,
    whereOf: (jobId) => {
      try {
        return whereOf(requireJob(jobId));
      } catch (_) {
        return null;
      }
    },
    agentActivity,
    agentOnline: (agentId) => {
      ensureLoaded();
      return agentOnline(agentId);
    },
    hasOpenJobs: () => {
      ensureLoaded();
      return [...jobs.values()].some((job) => job.status === 'queued' || job.status === 'running');
    },
    snapshot,
    // for tests: run one round of each loop now
    dispatch,
    sweep,
    watchPush,
    waiting: () => waiters.size
  };
}

module.exports = {
  QUEUE_NODE_ID,
  JOB_ID_PATTERN,
  LEASE_PATTERN,
  DEFAULTS,
  RenderQueueError,
  createRenderQueue,
  looksLikeMp4
};
