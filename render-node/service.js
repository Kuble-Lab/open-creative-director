#!/usr/bin/env node
'use strict';

/*
 * HyperFrames Render-Node (Windows version for the Acer laptop)
 * POST /uploads                                           -> {uploadId}
 * PUT  /uploads/:id/:filename                            -> streams file to disk
 * POST /render {html, quality?, resolution?, assets?}    -> {jobId}
 * POST /render {html, quality?, resolution?, uploadId}   -> {jobId}
 * GET  /jobs/:id                                         -> {status, error?, ...}
 * GET  /jobs/:id/file                                    -> MP4
 * GET  /health                                           -> {ok, queue, running, streamingUploads}
 * Auth: Authorization: Bearer <RENDER_TOKEN> (except /health)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_BASE = __dirname;

try {
  const envFile = fs.readFileSync(path.join(DEFAULT_BASE, 'service.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
} catch (_) {
  /* service.env is optional */
}

const MAX_HTML = 2 * 1024 * 1024;
const MAX_ASSETS = 10;
const MAX_LEGACY_ASSETS_BYTES = 24 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_RENDER_BODY_BYTES = MAX_HTML + Math.ceil(MAX_LEGACY_ASSETS_BYTES * 1.4) + 65536;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const ID_PATTERN = /^r-[a-z0-9]+-[a-f0-9]{8}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function newId() {
  return `r-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validFilename(name) {
  return FILE_PATTERN.test(name) && !name.includes('..');
}

function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function defaultRenderExecutor({ base, hyperframesBin, dir, out, quality, fps, resolution }) {
  return new Promise((resolve, reject) => {
    const args = [hyperframesBin, 'render', path.join(dir, 'project'), '-o', out, '-q', quality];
    if (fps) args.push('-f', String(fps));
    if (resolution) args.push('--resolution', resolution);
    const child = spawn(process.execPath, args, {
      cwd: base,
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let tail = '';
    const keepTail = (chunk) => { tail = (tail + chunk.toString()).slice(-4000); };
    child.stdout.on('data', keepTail);
    child.stderr.on('data', keepTail);
    const killer = setTimeout(() => child.kill('SIGKILL'), RENDER_TIMEOUT_MS);
    killer.unref?.();
    child.on('error', (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0 && fs.existsSync(out)) return resolve();
      const detail = tail.split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 800);
      reject(new Error(`Render-Exit ${code}: ${detail}`));
    });
  });
}

function createRenderService(options = {}) {
  const base = options.base || DEFAULT_BASE;
  const jobsDir = path.join(base, 'jobs');
  const uploadsDir = path.join(base, 'uploads');
  const templateDir = options.templateDir || path.join(base, 'template');
  const token = String(options.token ?? process.env.RENDER_TOKEN ?? '').trim();
  const hyperframesBin = options.hyperframesBin || path.join(base, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
  const renderExecutor = options.renderExecutor || defaultRenderExecutor;
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const jobs = new Map();
  const queue = [];
  const uploadLocks = new Map();
  const activeUploads = new Set();
  let running = false;

  function authorized(req) {
    return req.headers.authorization === `Bearer ${token}`;
  }

  function withUploadLock(id, task) {
    const previous = uploadLocks.get(id) || Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(() => undefined, () => undefined);
    uploadLocks.set(id, settled);
    return next.finally(() => {
      if (uploadLocks.get(id) === settled) uploadLocks.delete(id);
    });
  }

  async function pruneDirectory(root, ttlMs, onRemove) {
    let names = [];
    try {
      names = await fsp.readdir(root);
    } catch (_) {
      return;
    }
    const cutoff = Date.now() - ttlMs;
    for (const name of names) {
      if (root === uploadsDir && activeUploads.has(name)) continue;
      const directory = path.join(root, name);
      try {
        const stat = await fsp.stat(directory);
        if (stat.mtimeMs < cutoff) {
          await fsp.rm(directory, { recursive: true, force: true });
          onRemove?.(name);
        }
      } catch (_) {
        /* Ignore entries removed concurrently. */
      }
    }
  }

  function pruneJobs() {
    return pruneDirectory(jobsDir, JOB_TTL_MS, (name) => jobs.delete(name));
  }

  function pruneUploads() {
    return pruneDirectory(uploadsDir, UPLOAD_TTL_MS);
  }

  async function createUpload() {
    await pruneUploads();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newId();
      try {
        await fsp.mkdir(path.join(uploadsDir, id));
        return id;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Upload-ID konnte nicht erzeugt werden');
  }

  async function uploadStats(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    let totalBytes = 0;
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !validFilename(entry.name)) throw httpError(400, 'Upload-Staging enthaelt ungueltige Dateien');
      const stat = await fsp.stat(path.join(directory, entry.name));
      totalBytes += stat.size;
      count += 1;
    }
    return { totalBytes, count };
  }

  async function receiveUpload(req, res, uploadId, filename) {
    await pruneUploads();
    if (!ID_PATTERN.test(uploadId) || !validFilename(filename)) {
      throw httpError(400, 'Ungueltige Upload-ID oder ungueltiger Dateiname');
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
      throw httpError(415, 'Content-Type muss application/octet-stream sein');
    }

    return withUploadLock(uploadId, async () => {
      const directory = path.join(uploadsDir, uploadId);
      let stat;
      try {
        stat = await fsp.stat(directory);
      } catch (error) {
        if (error.code === 'ENOENT') throw httpError(404, 'Upload nicht gefunden oder abgelaufen');
        throw error;
      }
      if (!stat.isDirectory()) throw httpError(404, 'Upload nicht gefunden');

      const current = await uploadStats(directory);
      const destination = path.join(directory, filename);
      if (fs.existsSync(destination)) throw httpError(409, 'Datei wurde bereits hochgeladen');
      if (current.count + 1 > MAX_ASSETS) {
        await fsp.rm(directory, { recursive: true, force: true });
        throw httpError(413, `Zu viele Assets (max ${MAX_ASSETS})`);
      }
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength >= 0 && current.totalBytes + contentLength > MAX_UPLOAD_BYTES) {
        await fsp.rm(directory, { recursive: true, force: true });
        throw httpError(413, 'Assets zu gross (max 500 MB gesamt)');
      }

      let received = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (current.totalBytes + received > MAX_UPLOAD_BYTES) {
            return callback(httpError(413, 'Assets zu gross (max 500 MB gesamt)'));
          }
          callback(null, chunk);
        }
      });
      activeUploads.add(uploadId);
      try {
        await pipeline(req, limiter, fs.createWriteStream(destination, { flags: 'wx' }));
        const now = new Date();
        await fsp.utimes(directory, now, now);
        json(res, 201, { ok: true, filename, bytes: received });
      } catch (error) {
        await fsp.rm(destination, { force: true });
        if (error.status === 413) await fsp.rm(directory, { recursive: true, force: true });
        if (error.code === 'EEXIST') throw httpError(409, 'Datei wurde bereits hochgeladen');
        throw error;
      } finally {
        activeUploads.delete(uploadId);
      }
    });
  }

  async function moveUpload(uploadId, projectDir) {
    if (!ID_PATTERN.test(uploadId)) throw httpError(400, 'Ungueltige Upload-ID');
    const directory = path.join(uploadsDir, uploadId);
    let stats;
    try {
      stats = await uploadStats(directory);
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, 'Upload nicht gefunden oder abgelaufen');
      throw error;
    }
    if (stats.count > MAX_ASSETS || stats.totalBytes > MAX_UPLOAD_BYTES) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw httpError(413, 'Upload-Limit ueberschritten');
    }
    const names = await fsp.readdir(directory);
    const moved = [];
    try {
      for (const name of names) {
        if (!validFilename(name)) throw httpError(400, `Ungueltiger Asset-Name: ${name}`);
        await fsp.rename(path.join(directory, name), path.join(projectDir, name));
        moved.push(name);
      }
      await fsp.rmdir(directory);
    } catch (error) {
      for (const name of moved.reverse()) {
        try {
          await fsp.rename(path.join(projectDir, name), path.join(directory, name));
        } catch (_) {
          /* Best effort rollback. */
        }
      }
      throw error;
    }
  }

  async function writeLegacyAssets(assets, projectDir) {
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return;
    const names = Object.keys(assets);
    if (names.length > MAX_ASSETS) throw httpError(400, `Zu viele Assets (max ${MAX_ASSETS})`);
    let totalBytes = 0;
    for (const name of names) {
      if (!validFilename(name)) throw httpError(400, `Ungueltiger Asset-Name: ${name}`);
      const buffer = Buffer.from(String(assets[name]), 'base64');
      totalBytes += buffer.length;
      if (totalBytes > MAX_LEGACY_ASSETS_BYTES) throw httpError(413, 'Assets zu gross (max 24 MB gesamt)');
      await fsp.writeFile(path.join(projectDir, name), buffer);
    }
  }

  async function runNext() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    await pruneUploads();
    const job = jobs.get(next);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const dir = path.join(jobsDir, next);
    const out = path.join(dir, 'out.mp4');
    try {
      await renderExecutor({ base, hyperframesBin, dir, out, quality: job.quality, fps: job.fps, resolution: job.resolution });
      if (!fs.existsSync(out)) throw new Error('Render lieferte keine Ausgabedatei');
      job.status = 'completed';
      job.file = out;
    } catch (error) {
      job.status = 'failed';
      job.error = String(error.message || error).slice(0, 800);
    } finally {
      job.finishedAt = new Date().toISOString();
      await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
      running = false;
      runNext();
    }
  }

  async function createJob(body) {
    await pruneUploads();
    const html = String(body?.html || '');
    if (!html.trim()) throw httpError(400, 'html fehlt');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML) throw httpError(413, 'html zu gross (max 2 MB)');
    if (body.uploadId && body.assets) throw httpError(400, 'uploadId und assets duerfen nicht kombiniert werden');
    const quality = ['draft', 'standard', 'high'].includes(body.quality) ? body.quality : 'standard';
    const fps = Number.isFinite(Number(body.fps)) ? Math.min(60, Math.max(1, Math.round(Number(body.fps)))) : null;
    const resolution = typeof body.resolution === 'string' && /^[a-z0-9-]+$/.test(body.resolution) ? body.resolution : null;
    const id = newId();
    const dir = path.join(jobsDir, id);
    const projectDir = path.join(dir, 'project');
    try {
      await fsp.mkdir(path.join(projectDir, 'compositions'), { recursive: true });
      await fsp.copyFile(path.join(templateDir, 'hyperframes.json'), path.join(projectDir, 'hyperframes.json'));
      await fsp.writeFile(path.join(projectDir, 'index.html'), html, 'utf8');
      if (body.uploadId) await withUploadLock(String(body.uploadId), () => moveUpload(String(body.uploadId), projectDir));
      else await writeLegacyAssets(body.assets, projectDir);
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw error;
    }
    jobs.set(id, { status: 'pending', quality, fps, resolution, createdAt: new Date().toISOString() });
    queue.push(id);
    runNext();
    return id;
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          tooLarge = true;
          body = '';
        } else if (!tooLarge) {
          body += chunk;
        }
      });
      req.on('error', reject);
      req.on('end', () => {
        if (tooLarge) return reject(httpError(413, 'Request-Body zu gross'));
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (_) {
          reject(httpError(400, 'Ungueltiger JSON-Body'));
        }
      });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://render-node.local');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, queue: queue.length, running, streamingUploads: true });
    }
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });

    try {
      if (req.method === 'POST' && url.pathname === '/uploads') {
        const uploadId = await createUpload();
        return json(res, 201, { uploadId });
      }
      const uploadMatch = /^\/uploads\/(r-[a-z0-9]+-[a-f0-9]{8})\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'PUT' && uploadMatch) {
        return await receiveUpload(req, res, uploadMatch[1], decodeURIComponent(uploadMatch[2]));
      }
      if (req.method === 'POST' && url.pathname === '/render') {
        const id = await createJob(await readJson(req, MAX_RENDER_BODY_BYTES));
        return json(res, 202, { jobId: id, status: 'pending' });
      }
      const jobMatch = /^\/jobs\/([a-z0-9-]+)(\/file)?$/.exec(url.pathname);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { error: 'Job nicht gefunden' });
        if (!jobMatch[2]) {
          const { file, ...publicJob } = job;
          return json(res, 200, { jobId: jobMatch[1], ...publicJob });
        }
        if (job.status !== 'completed' || !job.file) return json(res, 409, { error: `Job ist ${job.status}` });
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        fs.createReadStream(job.file).pipe(res);
        return;
      }
      return json(res, 404, { error: 'Nicht gefunden' });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || String(error) });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  const pruneTimer = setInterval(() => {
    pruneJobs();
    pruneUploads();
  }, 60 * 60 * 1000);
  pruneTimer.unref?.();
  pruneJobs();
  pruneUploads();

  return {
    server,
    handle,
    jobsDir,
    uploadsDir,
    createJob,
    pruneUploads,
    close() {
      clearInterval(pruneTimer);
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function start() {
  const base = DEFAULT_BASE;
  const token = String(process.env.RENDER_TOKEN || '').trim();
  const hyperframesBin = path.join(base, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
  if (!token) {
    console.error('RENDER_TOKEN fehlt (service.env)');
    process.exit(1);
  }
  if (!fs.existsSync(hyperframesBin)) {
    console.error(`hyperframes nicht gefunden: ${hyperframesBin} - zuerst "npm install" im Ordner ausfuehren`);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 4801);
  const host = process.env.HOST || '127.0.0.1';
  const service = createRenderService({ base, token, hyperframesBin });
  service.server.listen(port, host, () => {
    console.log(`HyperFrames-Render-Node auf ${host}:${port}, Template: ${path.join(base, 'template')}`);
  });
}

if (require.main === module) start();

module.exports = {
  createRenderService,
  MAX_ASSETS,
  MAX_LEGACY_ASSETS_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_TTL_MS
};
