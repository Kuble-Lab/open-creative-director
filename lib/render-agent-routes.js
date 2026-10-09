'use strict';

// HTTP side of the own computers as render nodes (WP46).
//
// Paths of the computers (the agent, render-node/agent.js). They work without the login cookie: the login of these paths is
// the token of the computer (Authorization: Bearer ocra_…) or, for the package, a pairing code. They are mounted before the
// login middleware (lib/whoami.js) and the guard of unconfirmed logins, so neither of them blocks or changes them, and they
// all live under one prefix for the exception of the login proxy:
//
//   GET  /api/render-agent/install.sh                    installer for macOS and Linux (public, static)
//   GET  /api/render-agent/install.ps1                   installer for Windows (public, static)
//   GET  /api/render-agent/package                       setup.js with the files of the package; header X-Render-Agent-Code
//                                                        (checked, not used up) or Authorization: Bearer <token> (update)
//   POST /api/render-agent/pair                          { code, name, platform, versions } -> 201 { token, agent }
//   POST /api/render-agent/poll                          { versions, platform, running: [lease] } -> 200 { job | null }
//                                                        after up to 25 s (long poll); 426 when the version does not fit
//   GET  /api/render-agent/jobs/:jobId/assets/:filename  one file of the job (header X-Render-Lease)
//   POST /api/render-agent/jobs/:jobId/progress          { lease, progress } (heartbeat; 409 LEASE_LOST: stop)
//   PUT  /api/render-agent/jobs/:jobId/result            the MP4 as the body (application/octet-stream, header X-Render-Lease)
//   POST /api/render-agent/jobs/:jobId/fail              { lease, error, released }
//
// Paths of the people (with login, after the login middleware):
//
//   GET    /api/render-agents                  the caller's computers, the address of the app, whether the package is there
//   POST   /api/render-agents/pairing-code     a new code and the two commands that install and pair a computer
//   PATCH  /api/render-agents/:id              { name?, shareTeams?, shareAll? } (the owner only; shareAll: an admin)
//   DELETE /api/render-agents/:id              removes the computer: its token stops working at once, its jobs go back
//
// The token of a computer appears in exactly one answer: the one of POST /api/render-agent/pair. Never in a list, a log, an
// error or the admin view.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const express = require('express');

const access = require('./access');
const { PATHS } = require('./config');
const renderAgents = require('./render-agents');

const PREFIX = '/api/render-agent';
const PROTOCOL_VERSION = 1;
// The HyperFrames version of the package (render-node/agent/package.json pins it exactly). Used when the package folder is
// not deployed; scripts/test-render-agent-package.js checks that both agree.
const HYPERFRAMES_VERSION = '0.8.139';
const PACKAGE_PLACEHOLDER = '/*@@PACKAGE@@*/ null';
// The fixed file list of the package: [path on the computer, path in render-node/]. Never service.env, jobs/, uploads/ or
// node_modules: only these files leave the server.
const PACKAGE_FILES = Object.freeze([
  ['agent.js', 'agent.js'],
  ['service.js', 'service.js'],
  ['template/hyperframes.json', 'template/hyperframes.json'],
  ['package.json', 'agent/package.json'],
  ['package-lock.json', 'agent/package-lock.json'],
  ['README.md', 'README.md']
]);
const INSTALLERS = Object.freeze({ 'install.sh': 'text/x-shellscript; charset=utf-8', 'install.ps1': 'text/plain; charset=utf-8' });
const LEASE_HEADER = 'x-render-lease';
const CODE_HEADER = 'x-render-agent-code';
const AUTH_FAILURES_PER_IP = 30;
const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;

class PackageMissingError extends Error {
  constructor(dir) {
    super(`Das Paket des Render-Agents fehlt auf dem Server (${path.basename(dir)}/ nicht gefunden). render-node/ mit ausliefern oder RENDER_AGENT_PACKAGE_DIR setzen.`);
    this.code = 'PACKAGE_MISSING';
    this.status = 503;
  }
}

/* ---------- helpers ---------- */

// The address of the caller. Behind the proxy of the app (the socket is this computer) X-Real-IP or the last entry of
// X-Forwarded-For (the one the proxy added); otherwise the socket, so nobody chooses their own address for the rate limits.
function clientIp(req) {
  const socket = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = socket === '127.0.0.1' || socket === '::1';
  if (loopback) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real.slice(0, 64);
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1].slice(0, 64);
  }
  return socket || '-';
}

// The address computers are given: PUBLIC_BASE_URL when it is set, else derived from the request (X-Forwarded-Host only
// with TRUST_PROXY_HOST=1), as for the MCP endpoint (lib/mcp/key-routes.js).
function serverUrl(req, env = process.env) {
  const configured = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const headers = req.headers || {};
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol === 'https' ? 'https' : 'http';
  const trustProxy = /^(1|true|yes)$/i.test(String(env.TRUST_PROXY_HOST || '').trim());
  const host = String((trustProxy && headers['x-forwarded-host']) || headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}`;
}

// The two commands the app shows with a code: they fetch the package, install it and pair the computer.
function installCommands(server, code) {
  const base = String(server || '').replace(/\/+$/, '');
  const quotedPs = (text) => `'${String(text).replace(/'/g, "''")}'`;
  return {
    bash: `curl -fsSL ${base}/api/render-agent/install.sh | bash -s -- --server ${base} --code ${code}`,
    powershell:
      '[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; ' +
      `& ([scriptblock]::Create((irm ${quotedPs(`${base}/api/render-agent/install.ps1`)}))) -Server ${quotedPs(base)} -Code ${quotedPs(code)}`
  };
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// Errors of the store and the queue carry status and code; everything else is an internal error whose text stays in the log.
function sendError(res, err, log) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) {
    log.warn?.(`[render-agent] ${err?.message || err}`);
    res.status(500).json({ error: 'Interner Fehler.', code: 'INTERNAL' });
    return;
  }
  if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
  res.status(status).json({ error: String(err.message || 'Fehler'), code: err.code || 'ERROR', ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) });
}

/* ---------- the routes ---------- */

// store   lib/render-agents.js store; queue: lib/render-queue.js (or a function that returns it); packageDir: the folder
// render-node/ (a function, read when used); env: process.env; log: console.
function createRenderAgentRoutes({ store = renderAgents.defaultStore, queue, packageDir = () => PATHS.renderNodeDir, env = process.env, log = console, now = Date.now } = {}) {
  const queueOf = () => (typeof queue === 'function' ? queue() : queue);
  const dirOf = () => (typeof packageDir === 'function' ? packageDir() : packageDir);
  const authFailures = new Map(); // ip -> [times]
  let packageCache = null; // { key, text }

  /* --- the package --- */

  function packageAvailable() {
    const dir = dirOf();
    return fs.existsSync(path.join(dir, 'setup.js')) && PACKAGE_FILES.every(([, from]) => fs.existsSync(path.join(dir, from)));
  }

  function requirePackageDir() {
    const dir = dirOf();
    if (!packageAvailable()) throw new PackageMissingError(dir);
    return dir;
  }

  // The HyperFrames version the package pins (and every computer must have).
  function requiredHyperframes() {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dirOf(), 'agent', 'package.json'), 'utf8'));
      const pinned = String(manifest.dependencies?.hyperframes || '').trim();
      if (/^\d+\.\d+\.\d+$/.test(pinned)) return pinned;
    } catch (_) {
      /* the package folder is not deployed */
    }
    return HYPERFRAMES_VERSION;
  }

  function required() {
    return { protocol: PROTOCOL_VERSION, hyperframes: requiredHyperframes() };
  }

  function versionProblem(versions) {
    const need = required();
    const have = versions && typeof versions === 'object' ? versions : {};
    if (Number(have.protocol) !== need.protocol || String(have.hyperframes || '') !== need.hyperframes) {
      const err = new Error(`Dieser Rechner braucht ein Update: Protokoll ${need.protocol} und HyperFrames ${need.hyperframes}. Auf dem Rechner: node agent.js update`);
      err.status = 426;
      err.code = 'AGENT_OUTDATED';
      err.required = need;
      return err;
    }
    return null;
  }

  // setup.js with the files embedded (base64 and SHA-256 each). Built again when a file changed.
  function buildPackage() {
    const dir = requirePackageDir();
    const sources = [['setup.js', 'setup.js'], ...PACKAGE_FILES].map(([, from]) => path.join(dir, from));
    const key = sources.map((file) => {
      const stat = fs.statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    }).join('|');
    if (packageCache && packageCache.key === key) return packageCache.text;
    const files = PACKAGE_FILES.map(([name, from]) => {
      const data = fs.readFileSync(path.join(dir, from));
      return { path: name, sha256: crypto.createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') };
    });
    const manifest = { format: 1, protocol: PROTOCOL_VERSION, hyperframes: requiredHyperframes(), files };
    const setup = fs.readFileSync(path.join(dir, 'setup.js'), 'utf8');
    if (!setup.includes(PACKAGE_PLACEHOLDER)) throw new Error('render-node/setup.js hat keinen Platzhalter für das Paket.');
    const text = setup.replace(PACKAGE_PLACEHOLDER, () => JSON.stringify(manifest));
    packageCache = { key, text };
    return text;
  }

  /* --- who is asking --- */

  function recentFailures(ip, at) {
    const list = (authFailures.get(ip) || []).filter((time) => at - time < AUTH_FAILURE_WINDOW_MS);
    if (list.length) authFailures.set(ip, list);
    else authFailures.delete(ip);
    return list;
  }

  // The computer of the token, or an answer (401, 429) and null. The reason of a refusal is never told.
  function agentOf(req, res) {
    const ip = clientIp(req);
    const at = now();
    const failures = recentFailures(ip, at);
    if (failures.length >= AUTH_FAILURES_PER_IP) {
      const retry = Math.max(1, Math.ceil((failures[0] + AUTH_FAILURE_WINDOW_MS - at) / 1000));
      res.set('Retry-After', String(retry)).status(429).json({ error: 'Zu viele Versuche. Bitte später noch einmal.', code: 'RATE_LIMITED', retryAfterSeconds: retry });
      return null;
    }
    const result = store.authenticate(bearerToken(req));
    if (result.ok) return result.agent;
    if (result.reason === 'unavailable') {
      res.status(503).json({ error: 'Die Rechnerliste ist gerade nicht lesbar.', code: 'UNAVAILABLE' });
      return null;
    }
    failures.push(at);
    authFailures.set(ip, failures);
    if (authFailures.size > 5000) authFailures.delete(authFailures.keys().next().value);
    res.status(401).json({ error: 'Dieser Rechner ist nicht (mehr) gekoppelt.', code: 'UNAUTHORIZED' });
    return null;
  }

  const leaseOf = (req) => String(req.headers[LEASE_HEADER] || bodyOf(req).lease || '').trim();

  /* --- the router of the computers --- */

  function agentRouter() {
    const router = express.Router();
    router.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      next();
    });
    const json = express.json({ limit: '64kb' });

    for (const [file, type] of Object.entries(INSTALLERS)) {
      router.get(`/${file}`, (req, res) => {
        try {
          const dir = requirePackageDir();
          res.type(type).send(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch (err) {
          sendError(res, err, log);
        }
      });
    }

    router.get('/package', (req, res) => {
      try {
        requirePackageDir();
        const code = String(req.headers[CODE_HEADER] || '').trim();
        if (code) {
          store.checkCode(code, clientIp(req));
        } else {
          const agent = agentOf(req, res);
          if (!agent) return;
        }
        res.type('application/javascript; charset=utf-8').send(buildPackage());
      } catch (err) {
        sendError(res, err, log);
      }
    });

    router.post('/pair', json, (req, res) => {
      try {
        requirePackageDir();
        const body = bodyOf(req);
        const result = store.pair({
          code: typeof body.code === 'string' ? body.code : '',
          ip: clientIp(req),
          name: typeof body.name === 'string' ? body.name : '',
          platform: body.platform,
          versions: body.versions,
          beforeCreate: () => {
            const problem = versionProblem(body.versions);
            if (problem) throw problem;
          }
        });
        const current = queueOf();
        res.status(201).json({
          token: result.token,
          agent: { id: result.agent.id, name: result.agent.name, owner: result.agent.owner },
          protocol: PROTOCOL_VERSION,
          pollWaitMs: current?.config?.pollWaitMs || 25000
        });
      } catch (err) {
        if (err.code === 'AGENT_OUTDATED') return res.status(426).json({ error: err.message, code: err.code, required: err.required });
        sendError(res, err, log);
      }
    });

    router.post('/poll', json, async (req, res) => {
      const agent = agentOf(req, res);
      if (!agent) return;
      const body = bodyOf(req);
      const problem = versionProblem(body.versions);
      if (problem) return res.status(426).json({ error: problem.message, code: problem.code, required: problem.required });
      const current = queueOf();
      if (!current) return res.status(503).json({ error: 'Die Warteschlange ist nicht verfügbar.', code: 'UNAVAILABLE' });
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const job = await current.poll(agent, {
          signal: controller.signal,
          running: Array.isArray(body.running) ? body.running.slice(0, 8) : [],
          report: { platform: body.platform, versions: body.versions }
        });
        if (controller.signal.aborted) return; // the computer is gone; the job comes back through its next poll or the lease
        res.json({ job: job || null, agent: { id: agent.id, name: agent.name } });
      } catch (err) {
        sendError(res, err, log);
      }
    });

    router.get('/jobs/:jobId/assets/:filename', async (req, res) => {
      const agent = agentOf(req, res);
      if (!agent) return;
      try {
        const file = queueOf().openAsset(agent, req.params.jobId, leaseOf(req), req.params.filename);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', String(file.size));
        await pipeline(fs.createReadStream(file.path), res);
      } catch (err) {
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        sendError(res, err, log);
      }
    });

    router.post('/jobs/:jobId/progress', json, (req, res) => {
      const agent = agentOf(req, res);
      if (!agent) return;
      try {
        res.json(queueOf().progress(agent, req.params.jobId, leaseOf(req), { progress: Number(bodyOf(req).progress) }));
      } catch (err) {
        sendError(res, err, log);
      }
    });

    router.put('/jobs/:jobId/result', async (req, res) => {
      const agent = agentOf(req, res);
      if (!agent) {
        req.resume();
        return;
      }
      try {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/octet-stream' && type !== 'video/mp4') {
          const err = new Error('Das Ergebnis muss als application/octet-stream kommen.');
          err.status = 415;
          err.code = 'INVALID_RESULT';
          throw err;
        }
        res.json(await queueOf().acceptResult(agent, req.params.jobId, leaseOf(req), req, { contentLength: req.headers['content-length'] }));
      } catch (err) {
        if (!req.complete) {
          // stop reading a body that will not be used; the answer still reaches the computer
          res.set('Connection', 'close');
          req.unpipe?.();
          req.resume();
        }
        sendError(res, err, log);
      }
    });

    router.post('/jobs/:jobId/fail', json, (req, res) => {
      const agent = agentOf(req, res);
      if (!agent) return;
      try {
        const body = bodyOf(req);
        res.json(queueOf().fail(agent, req.params.jobId, leaseOf(req), { error: typeof body.error === 'string' ? body.error : '', released: body.released === true }));
      } catch (err) {
        sendError(res, err, log);
      }
    });

    // anything else under the prefix: 404 here, so no other route of the app is reachable without a login through it
    router.use((req, res) => res.status(404).json({ error: 'Nicht gefunden.', code: 'NOT_FOUND' }));
    // a body that is not JSON or too large
    router.use((err, req, res, _next) => {
      const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : 400;
      res.status(status).json({ error: status === 413 ? 'Zu gross.' : 'Ungültige Anfrage.', code: status === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST' });
    });
    return router;
  }

  // Mounted before the login middleware (server.js).
  function mountAgentRoutes(app) {
    app.use(PREFIX, agentRouter());
  }

  /* --- the people's routes --- */

  function ownerOf(viewer) {
    return viewer.active ? viewer.email : 'lokal';
  }

  function viewForPerson(agent, { withOwner = false } = {}) {
    const current = queueOf();
    const activity = current ? current.agentActivity(agent) : { online: false, rendering: [] };
    return {
      id: agent.id,
      name: agent.name,
      ...(withOwner ? { owner: agent.owner } : {}),
      platform: agent.platform,
      versions: agent.versions,
      createdAt: agent.createdAt,
      lastSeenAt: agent.lastSeenAt,
      online: activity.online,
      rendering: activity.rendering.map((entry) => (withOwner ? { ...entry, label: '' } : entry)),
      completed: agent.completed,
      failed: agent.failed,
      shareTeams: agent.shareTeams,
      shareAll: agent.shareAll,
      outdated: Boolean(versionProblem(agent.versions))
    };
  }

  // All computers for the admin view of the render nodes (labels of jobs stay with their owners).
  function adminList() {
    return store.listAgents().map((agent) => viewForPerson(agent, { withOwner: true }));
  }

  // For /api/rendernode/status: is a computer online that renders for this person?
  function availableFor(req) {
    const viewer = access.viewerOf(req, env);
    if (viewer.active && !viewer.identified) return false;
    const current = queueOf();
    return Boolean(current && store.count() > 0 && current.acceptsOwner(ownerOf(viewer)));
  }

  function registerUserRoutes(app) {
    // The person, or null after answering 403 (an anonymous caller while user management is active).
    function personOf(req, res) {
      const viewer = access.viewerOf(req, env);
      if (viewer.active && !viewer.identified) {
        res.status(403).json({ error: 'Zugriff verweigert.', code: 'FORBIDDEN' });
        return null;
      }
      return viewer;
    }

    // The computer the person may change: their own, any for an admin. Somebody else's computer does not exist (404).
    function agentFor(viewer, id) {
      const agent = store.getAgent(id);
      if (!agent || (agent.owner !== ownerOf(viewer) && !viewer.admin)) {
        const err = new Error('Diesen Rechner gibt es nicht mehr.');
        err.status = 404;
        err.code = 'AGENT_NOT_FOUND';
        throw err;
      }
      return agent;
    }

    app.get('/api/render-agents', (req, res) => {
      const viewer = personOf(req, res);
      if (!viewer) return;
      try {
        res.set('Cache-Control', 'no-store');
        res.json({
          agents: store.listForOwner(ownerOf(viewer)).map((agent) => viewForPerson(agent)),
          canShareAll: Boolean(viewer.admin),
          canShareTeams: Boolean(viewer.active),
          server: serverUrl(req, env),
          packageAvailable: packageAvailable(),
          required: required(),
          limits: { nameChars: renderAgents.LIMITS.nameChars, agentsPerPerson: renderAgents.LIMITS.agentsPerPerson, codeTtlSeconds: Math.round(renderAgents.LIMITS.codeTtlMs / 1000) }
        });
      } catch (err) {
        sendError(res, err, log);
      }
    });

    app.post('/api/render-agents/pairing-code', (req, res) => {
      const viewer = personOf(req, res);
      if (!viewer) return;
      try {
        requirePackageDir();
        const pairing = store.createPairingCode(ownerOf(viewer));
        const server = serverUrl(req, env);
        res.set('Cache-Control', 'no-store');
        res.status(201).json({ ...pairing, server, commands: installCommands(server, pairing.code) });
      } catch (err) {
        sendError(res, err, log);
      }
    });

    app.patch('/api/render-agents/:id', (req, res) => {
      const viewer = personOf(req, res);
      if (!viewer) return;
      try {
        const agent = agentFor(viewer, req.params.id);
        // what a computer renders is its owner's decision: an admin sees and removes any computer, but changes only their own
        if (agent.owner !== ownerOf(viewer)) {
          return res.status(403).json({ error: 'Diesen Rechner kann nur die Person ändern, der er gehört.', code: 'FORBIDDEN' });
        }
        const body = bodyOf(req);
        const patch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.shareTeams !== undefined) patch.shareTeams = body.shareTeams;
        if (body.shareAll !== undefined) {
          // a shared node for everybody: only an admin (for a computer of their own, see above)
          if (!viewer.admin) {
            return res.status(403).json({ error: 'Nur Admins können einen eigenen Rechner für alle freigeben.', code: 'FORBIDDEN' });
          }
          patch.shareAll = body.shareAll;
        }
        const updated = store.update(agent.id, patch);
        res.json({ agent: viewForPerson(updated) });
      } catch (err) {
        sendError(res, err, log);
      }
    });

    app.delete('/api/render-agents/:id', (req, res) => {
      const viewer = personOf(req, res);
      if (!viewer) return;
      try {
        const agent = agentFor(viewer, req.params.id);
        store.remove(agent.id);
        queueOf()?.revokeAgent(agent.id);
        res.json({ ok: true, id: agent.id });
      } catch (err) {
        sendError(res, err, log);
      }
    });
  }

  return {
    PREFIX,
    mountAgentRoutes,
    registerUserRoutes,
    adminList,
    availableFor,
    packageAvailable,
    required,
    buildPackage
  };
}

module.exports = {
  PREFIX,
  PROTOCOL_VERSION,
  HYPERFRAMES_VERSION,
  PACKAGE_FILES,
  PACKAGE_PLACEHOLDER,
  createRenderAgentRoutes,
  installCommands,
  clientIp,
  serverUrl
};
