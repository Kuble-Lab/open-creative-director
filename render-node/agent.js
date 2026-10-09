#!/usr/bin/env node
'use strict';

/*
 * Render agent (WP46): this computer renders motion graphics for Open Creative Director. It connects to the app itself
 * over HTTPS and fetches its jobs (long poll); it opens no port and needs no tunnel.
 *
 *   node agent.js                 connect and render, in the foreground (Ctrl+C stops it)
 *   node agent.js pair --server <address> --code <code> [--name <name>]
 *   node agent.js update          fetch the current package from the app with the token and install it
 *   node agent.js status          what this computer is paired with (never the token)
 *   node agent.js forget          delete the token on this computer (remove the computer in the app as well)
 *
 * One job at a time, one agent per folder (agent.lock).
 * It renders with the same function and the same settings as service.js (defaultRenderExecutor, renderEnv), with the ffmpeg
 * and ffprobe of the package when they could be installed (ffmpeg-static, @derhuerst/ffprobe-static), else those on the PATH.
 * Before a page is rendered it gets a Content-Security-Policy: it may load its own files, data and blob URLs, scripts from
 * jsDelivr, unpkg and cdnjs, images, fonts, styles and media over HTTPS, but it may not connect anywhere else (no fetch,
 * XHR or WebSocket to this computer, its network or the internet) and sends no forms.
 * The token lies in agent.json (mode 600) next to this file and is never printed.
 * Protocol: docs/node-view/SPEC.md, "Own computers as render nodes (WP46)"; the app side: lib/render-agent-routes.js.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PROTOCOL_VERSION = 1;
const AGENT_VERSION = '1.0.0';
const BASE = __dirname;
const CREDENTIALS_FILE = 'agent.json';
const LOCK_FILE = 'agent.lock';
const JOB_ID_PATTERN = /^rq-[a-z0-9]{6,12}-[0-9a-f]{8}$/;
const LEASE_PATTERN = /^[0-9a-f]{32}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const TOKEN_PATTERN = /^ocra_[A-Za-z0-9_-]{43}$/;
const POLL_TIMEOUT_MS = 45000;
const REQUEST_TIMEOUT_MS = 30000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const UPLOAD_TRIES = 3;

// What the page may load while it is rendered (see the top of this file).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' data: blob: https:",
  "font-src 'self' data: blob: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'"
].join('; ');

/* ---------- texts ---------- */

const TEXTS = {
  de: {
    header: 'OCD Render-Agent {agent} · HyperFrames {hyperframes} · ffmpeg {ffmpeg}',
    ffmpegBundled: 'mitgeliefert',
    ffmpegSystem: 'vom System, nicht gepinnt',
    ffmpegConfigured: 'aus HYPERFRAMES_FFMPEG_PATH',
    ffmpegMissing: 'ffmpeg und ffprobe fehlen. Das Paket konnte sie nicht installieren und auf dem PATH gibt es sie nicht. Bitte ffmpeg installieren: https://ffmpeg.org/download.html',
    hyperframesMissing: 'HyperFrames ist nicht installiert. Bitte das Paket neu installieren: node agent.js update',
    notPaired: 'Dieser Rechner ist noch nicht gekoppelt. Den Befehl dazu zeigt die App unter «Meine Rechner».',
    connected: 'Verbunden mit {server} als «{name}».',
    disconnected: 'Getrennt ({reason}). Neuer Versuch in {seconds} s.',
    renderingOwn: 'Rendert «{label}» …',
    renderingOther: 'Rendert einen Auftrag {whom} …',
    whomTeam: 'aus dem Team',
    whomBackup: '(zweite Kopie eines langsamen Auftrags)',
    done: 'Fertig: «{label}» in {seconds} s.',
    doneOther: 'Fertig in {seconds} s.',
    failed: 'Fehlgeschlagen: {error}',
    leaseLost: 'Der Auftrag ist nicht mehr bei diesem Rechner (anderswo fertig oder neu vergeben). Abgebrochen.',
    removed: 'Dieser Rechner wurde in der App entfernt. Der Agent hört auf. Neu koppeln geht mit einem neuen Code aus der App.',
    outdated: 'Die App verlangt eine andere Version (Protokoll {protocol}, HyperFrames {hyperframes}). Aktualisieren: node agent.js update',
    stopping: 'Wird beendet …',
    stopped: 'Beendet.',
    released: 'Laufender Auftrag zurückgegeben.',
    paired: 'Gekoppelt als «{name}».',
    pairedStart: 'Gekoppelt als «{name}». Starten: node agent.js',
    pairFailed: 'Koppeln fehlgeschlagen: {error}',
    serverInvalid: 'Die Adresse der App ist ungültig: {server} (erwartet: https://…).',
    httpRefused: 'Die App muss über HTTPS erreichbar sein ({server}). Nur für Adressen dieses Rechners geht http://. Wer es trotzdem will: RENDER_AGENT_ALLOW_HTTP=1.',
    status: 'Gekoppelt mit {server} als «{name}» ({id}).',
    forgotten: 'Der Token wurde auf diesem Rechner gelöscht. Entferne den Rechner auch in der App.',
    updating: 'Lade das aktuelle Paket von {server} …',
    updated: 'Aktualisiert. Starten: node agent.js',
    updateFailed: 'Aktualisieren fehlgeschlagen: {error}',
    usage: 'Aufruf: node agent.js [run|pair|update|status|forget]',
    alreadyRunning: 'Der Agent läuft in diesem Ordner schon (PID {pid}). Pro Ordner nur ein Agent.',
    stopFirst: 'Der Agent läuft noch (PID {pid}). Zuerst mit Ctrl+C beenden, dann aktualisieren.'
  },
  en: {
    header: 'OCD render agent {agent} · HyperFrames {hyperframes} · ffmpeg {ffmpeg}',
    ffmpegBundled: 'bundled',
    ffmpegSystem: 'from the system, not pinned',
    ffmpegConfigured: 'from HYPERFRAMES_FFMPEG_PATH',
    ffmpegMissing: 'ffmpeg and ffprobe are missing. The package could not install them and they are not on the PATH. Please install ffmpeg: https://ffmpeg.org/download.html',
    hyperframesMissing: 'HyperFrames is not installed. Please reinstall the package: node agent.js update',
    notPaired: 'This computer is not paired yet. The app shows the command under “My computers”.',
    connected: 'Connected to {server} as “{name}”.',
    disconnected: 'Disconnected ({reason}). Retrying in {seconds} s.',
    renderingOwn: 'Rendering “{label}” …',
    renderingOther: 'Rendering a job {whom} …',
    whomTeam: 'of the team',
    whomBackup: '(second copy of a slow job)',
    done: 'Done: “{label}” in {seconds} s.',
    doneOther: 'Done in {seconds} s.',
    failed: 'Failed: {error}',
    leaseLost: 'The job is no longer with this computer (finished elsewhere or handed out again). Stopped.',
    removed: 'This computer was removed in the app. The agent stops. Pair it again with a new code from the app.',
    outdated: 'The app needs another version (protocol {protocol}, HyperFrames {hyperframes}). Update: node agent.js update',
    stopping: 'Stopping …',
    stopped: 'Stopped.',
    released: 'The running job was handed back.',
    paired: 'Paired as “{name}”.',
    pairedStart: 'Paired as “{name}”. Start: node agent.js',
    pairFailed: 'Pairing failed: {error}',
    serverInvalid: 'The address of the app is invalid: {server} (expected: https://…).',
    httpRefused: 'The app has to be reached over HTTPS ({server}). http:// only works for addresses of this computer. To allow it anyway: RENDER_AGENT_ALLOW_HTTP=1.',
    status: 'Paired with {server} as “{name}” ({id}).',
    forgotten: 'The token was deleted on this computer. Remove the computer in the app as well.',
    updating: 'Fetching the current package from {server} …',
    updated: 'Updated. Start: node agent.js',
    updateFailed: 'Update failed: {error}',
    usage: 'Usage: node agent.js [run|pair|update|status|forget]',
    alreadyRunning: 'The agent is already running in this folder (PID {pid}). One agent per folder.',
    stopFirst: 'The agent is still running (PID {pid}). Stop it with Ctrl+C first, then update.'
  },
  es: {
    header: 'Agente de render OCD {agent} · HyperFrames {hyperframes} · ffmpeg {ffmpeg}',
    ffmpegBundled: 'incluido',
    ffmpegSystem: 'del sistema, sin versión fija',
    ffmpegConfigured: 'de HYPERFRAMES_FFMPEG_PATH',
    ffmpegMissing: 'Faltan ffmpeg y ffprobe. El paquete no pudo instalarlos y no están en el PATH. Instala ffmpeg: https://ffmpeg.org/download.html',
    hyperframesMissing: 'HyperFrames no está instalado. Vuelve a instalar el paquete: node agent.js update',
    notPaired: 'Este ordenador aún no está vinculado. La app muestra el comando en «Mis ordenadores».',
    connected: 'Conectado a {server} como «{name}».',
    disconnected: 'Desconectado ({reason}). Nuevo intento en {seconds} s.',
    renderingOwn: 'Renderizando «{label}» …',
    renderingOther: 'Renderizando un trabajo {whom} …',
    whomTeam: 'del equipo',
    whomBackup: '(segunda copia de un trabajo lento)',
    done: 'Listo: «{label}» en {seconds} s.',
    doneOther: 'Listo en {seconds} s.',
    failed: 'Error: {error}',
    leaseLost: 'El trabajo ya no es de este ordenador (terminado en otro sitio o reasignado). Detenido.',
    removed: 'Este ordenador se eliminó en la app. El agente se detiene. Vuelve a vincularlo con un código nuevo de la app.',
    outdated: 'La app requiere otra versión (protocolo {protocol}, HyperFrames {hyperframes}). Actualizar: node agent.js update',
    stopping: 'Deteniendo …',
    stopped: 'Detenido.',
    released: 'El trabajo en curso se devolvió.',
    paired: 'Vinculado como «{name}».',
    pairedStart: 'Vinculado como «{name}». Iniciar: node agent.js',
    pairFailed: 'No se pudo vincular: {error}',
    serverInvalid: 'La dirección de la app no es válida: {server} (se espera https://…).',
    httpRefused: 'La app debe estar accesible por HTTPS ({server}). http:// solo funciona con direcciones de este ordenador. Para permitirlo igualmente: RENDER_AGENT_ALLOW_HTTP=1.',
    status: 'Vinculado con {server} como «{name}» ({id}).',
    forgotten: 'El token se eliminó en este ordenador. Elimina el ordenador también en la app.',
    updating: 'Descargando el paquete actual de {server} …',
    updated: 'Actualizado. Iniciar: node agent.js',
    updateFailed: 'No se pudo actualizar: {error}',
    usage: 'Uso: node agent.js [run|pair|update|status|forget]',
    alreadyRunning: 'El agente ya se está ejecutando en esta carpeta (PID {pid}). Un solo agente por carpeta.',
    stopFirst: 'El agente sigue en marcha (PID {pid}). Detenlo primero con Ctrl+C y luego actualiza.'
  }
};

function language(env = process.env) {
  const raw = String(env.RENDER_AGENT_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase()
    || (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
      } catch (_) {
        return '';
      }
    })();
  if (raw.startsWith('de')) return 'de';
  if (raw.startsWith('es')) return 'es';
  return 'en';
}

function translator(lang) {
  const table = TEXTS[lang] || TEXTS.en;
  return (key, vars = {}) => String(table[key] || TEXTS.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name])));
}

/* ---------- small helpers ---------- */

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', done);
    resolve();
  }
  signal?.addEventListener?.('abort', done, { once: true });
});

class AgentHttpError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.name = 'AgentHttpError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// The address of the app: https, or http for an address of this computer (or with RENDER_AGENT_ALLOW_HTTP=1).
function normaliseServer(raw, env = process.env) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    return { error: 'serverInvalid' };
  }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) return { error: 'serverInvalid' };
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || /^127\./.test(url.hostname);
  if (url.protocol === 'http:' && !loopback && !/^(1|true|yes)$/i.test(String(env.RENDER_AGENT_ALLOW_HTTP || ''))) return { error: 'httpRefused' };
  return { server: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

// Puts the Content-Security-Policy first into the head of the page (before anything it could load).
function withContentSecurityPolicy(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
  const text = String(html);
  const charset = /^[\s\S]{0,2000}?<meta\s+charset=["']?[\w-]+["']?\s*\/?>/i.exec(text);
  if (charset) return `${text.slice(0, charset.index + charset[0].length)}${meta}${text.slice(charset.index + charset[0].length)}`;
  const head = /<head(\s[^>]*)?>/i.exec(text);
  if (head) return `${text.slice(0, head.index + head[0].length)}${meta}${text.slice(head.index + head[0].length)}`;
  const htmlTag = /<html(\s[^>]*)?>/i.exec(text);
  if (htmlTag) return `${text.slice(0, htmlTag.index + htmlTag[0].length)}<head>${meta}</head>${text.slice(htmlTag.index + htmlTag[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  if (doctype) return `${doctype[0]}${meta}${text.slice(doctype[0].length)}`;
  return `${meta}${text}`;
}

// The last percentage in the output of the CLI ("  ██████  26%  Capturing frame 1/60").
function progressFrom(text) {
  const matches = [...String(text).matchAll(/(\d{1,3})%/g)];
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1][1]);
  return value >= 0 && value <= 100 ? value / 100 : null;
}

function readCredentials(base = BASE) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(base, CREDENTIALS_FILE), 'utf8'));
    if (value && typeof value.server === 'string' && TOKEN_PATTERN.test(String(value.token || ''))) return value;
  } catch (_) {
    /* not paired */
  }
  return null;
}

function writeCredentials(base, value) {
  const file = path.join(base, CREDENTIALS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function packagePath(name, base = BASE) {
  try {
    const value = require(require.resolve(name, { paths: [base] }));
    return typeof value === 'string' && fs.existsSync(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function toolVersion(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['-version'], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = /(?:ffmpeg|ffprobe) version (\S+)/i.exec(String(stdout));
      resolve(match ? match[1].replace(/-static$/, '').slice(0, 40) : 'unknown');
    });
  });
}

// ffmpeg and ffprobe: those of the package (pinned), else the ones on the PATH. Sets HYPERFRAMES_FFMPEG_PATH and
// HYPERFRAMES_FFPROBE_PATH for the render (HyperFrames reads them), unless they are set already.
async function prepareFfmpeg({ base = BASE, env = process.env } = {}) {
  if (env.HYPERFRAMES_FFMPEG_PATH && env.HYPERFRAMES_FFPROBE_PATH) {
    return { version: await toolVersion(env.HYPERFRAMES_FFMPEG_PATH), source: 'configured' };
  }
  const ffmpeg = packagePath('ffmpeg-static', base);
  const ffprobe = packagePath('@derhuerst/ffprobe-static', base);
  if (ffmpeg && ffprobe) {
    const version = await toolVersion(ffmpeg);
    if (version && (await toolVersion(ffprobe))) {
      env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
      env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
      return { version, source: 'bundled' };
    }
  }
  const version = await toolVersion('ffmpeg');
  if (version && (await toolVersion('ffprobe'))) return { version, source: 'system' };
  return null;
}

function hyperframesVersion(base = BASE) {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'node_modules', 'hyperframes', 'package.json'), 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

// The process id of an agent that runs in this folder right now (agent.lock), or null.
function lockHolder(base = BASE) {
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(base, LOCK_FILE), 'utf8'), 10);
  } catch (_) {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err.code === 'EPERM' ? pid : null;
  }
}

/* ---------- the agent ---------- */

// options: base, credentials, fetchImpl, executor (defaultRenderExecutor of service.js), spawnImpl (caffeinate), log, env,
// platform, versions (skips the detection, for tests), noLock (tests)
function createAgent(options = {}) {
  const base = options.base || BASE;
  const env = options.env || process.env;
  const t = translator(options.lang || language(env));
  const log = options.log || ((line) => console.log(line));
  const fetchImpl = options.fetchImpl || ((...args) => global.fetch(...args));
  const platform = options.platform || `${process.platform}-${process.arch}`;
  const spawnImpl = options.spawnImpl || spawn;
  const credentials = options.credentials || readCredentials(base);
  const stopController = new AbortController();
  const running = new Map(); // lease -> { job, controller }
  let executor = options.executor || null;
  let versions = options.versions || null;
  let connected = false;
  let lastDisconnect = '';
  let exitCode = 0;
  let caffeinate = null;

  function url(pathname) {
    return `${credentials.server}${pathname}`;
  }

  async function call(method, pathname, { body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, raw = false, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onStop = () => controller.abort();
    signal?.addEventListener?.('abort', onStop, { once: true });
    try {
      const init = { method, headers: { Authorization: `Bearer ${credentials.token}`, ...headers }, signal: controller.signal };
      if (body !== undefined) {
        if (body instanceof Readable) {
          init.body = body;
          init.duplex = 'half';
        } else {
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
      }
      const res = await fetchImpl(url(pathname), init);
      if (raw) return res;
      const text = res.status === 204 ? '' : await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }
      if (!res.ok) throw new AgentHttpError(String(data?.error || `HTTP ${res.status}`).slice(0, 300), res.status, data?.code, data);
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onStop);
    }
  }

  function stopWith(code, line) {
    if (line) log(line);
    exitCode = code;
    stopController.abort();
  }

  function onAuthProblem(err) {
    if (err instanceof AgentHttpError && err.status === 401) {
      stopWith(2, t('removed'));
      return true;
    }
    if (err instanceof AgentHttpError && err.status === 426) {
      const required = err.body?.required || {};
      stopWith(3, t('outdated', { protocol: required.protocol ?? '?', hyperframes: required.hyperframes ?? '?' }));
      return true;
    }
    return false;
  }

  /* --- keep awake (macOS) --- */

  function holdAwake() {
    if (process.platform !== 'darwin' || caffeinate || options.noCaffeinate) return;
    try {
      caffeinate = spawnImpl('caffeinate', ['-i'], { stdio: 'ignore' });
      caffeinate.on?.('error', () => {
        caffeinate = null;
      });
    } catch (_) {
      caffeinate = null;
    }
  }

  function releaseAwake() {
    if (running.size || !caffeinate) return;
    try {
      caffeinate.kill();
    } catch (_) {
      /* gone already */
    }
    caffeinate = null;
  }

  /* --- one job --- */

  async function download(job, asset, project, signal) {
    if (!FILE_PATTERN.test(asset.filename) || asset.filename.includes('..')) throw new Error(`invalid asset name ${asset.filename}`);
    const res = await call('GET', `/api/render-agent/jobs/${job.jobId}/assets/${encodeURIComponent(asset.filename)}`, {
      headers: { 'X-Render-Lease': job.lease },
      raw: true,
      timeoutMs: 15 * 60 * 1000,
      signal
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new AgentHttpError(String(data?.error || `HTTP ${res.status}`), res.status, data?.code, data);
    }
    let received = 0;
    const limit = Math.min(MAX_ASSET_BYTES, Number(asset.size) >= 0 ? Number(asset.size) : MAX_ASSET_BYTES);
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > limit) return callback(new Error(`asset ${asset.filename} is larger than announced`));
        return callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(path.join(project, asset.filename), { flags: 'wx' }));
  }

  async function upload(job, out, signal) {
    const { size } = await fsp.stat(out);
    let lastError = null;
    for (let tryNumber = 1; tryNumber <= UPLOAD_TRIES; tryNumber += 1) {
      try {
        await call('PUT', `/api/render-agent/jobs/${job.jobId}/result`, {
          headers: { 'X-Render-Lease': job.lease, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
          body: fs.createReadStream(out),
          timeoutMs: 30 * 60 * 1000,
          signal
        });
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof AgentHttpError && err.status < 500 && err.status !== 429) throw err;
        if (signal?.aborted) throw err;
        await sleep(BACKOFF_MS[Math.min(tryNumber, BACKOFF_MS.length - 1)], signal);
      }
    }
    throw lastError;
  }

  async function handleJob(job) {
    if (!job || !JOB_ID_PATTERN.test(String(job.jobId)) || !LEASE_PATTERN.test(String(job.lease))) throw new Error('invalid job');
    const controller = new AbortController();
    const entry = { job, controller, progress: 0, leaseLost: false };
    running.set(job.lease, entry);
    const started = Date.now();
    const label = String(job.label || '').slice(0, 120);
    log(job.own && label ? t('renderingOwn', { label }) : t('renderingOther', { whom: job.backup ? t('whomBackup') : job.own ? '' : t('whomTeam') }).replace(/\s+…/, ' …'));
    holdAwake();
    const dir = path.join(base, 'agent-jobs', job.jobId);
    const project = path.join(dir, 'project');
    const out = path.join(dir, 'out.mp4');

    const report = async () => {
      try {
        await call('POST', `/api/render-agent/jobs/${job.jobId}/progress`, { body: { lease: job.lease, progress: entry.progress }, signal: stopController.signal });
      } catch (err) {
        if (onAuthProblem(err)) return;
        if (err instanceof AgentHttpError && (err.status === 409 || err.status === 404)) {
          entry.leaseLost = true;
          controller.abort();
        }
        // a network problem: the next report tries again; the app waits a minute for a sign of life
      }
    };
    const heartbeat = setInterval(report, Math.max(2000, Number(job.heartbeatMs) || 10000));
    heartbeat.unref?.();
    const onStop = () => controller.abort();
    stopController.signal.addEventListener('abort', onStop, { once: true });
    try {
      await report();
      if (controller.signal.aborted) throw new Error('aborted');
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(path.join(project, 'compositions'), { recursive: true });
      await fsp.copyFile(path.join(base, 'template', 'hyperframes.json'), path.join(project, 'hyperframes.json'));
      await fsp.writeFile(path.join(project, 'index.html'), withContentSecurityPolicy(job.html), 'utf8');
      for (const asset of Array.isArray(job.assets) ? job.assets : []) await download(job, asset, project, controller.signal);
      if (!executor) executor = require(path.join(base, 'service.js')).defaultRenderExecutor;
      await executor({
        base,
        hyperframesBin: path.join(base, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'),
        dir,
        out,
        quality: ['draft', 'standard', 'high'].includes(job.quality) ? job.quality : 'standard',
        fps: Number.isInteger(job.fps) ? job.fps : null,
        resolution: typeof job.resolution === 'string' && /^[a-z0-9-]+$/.test(job.resolution) ? job.resolution : null,
        signal: controller.signal,
        onOutput: (chunk) => {
          const value = progressFrom(chunk);
          if (value !== null) entry.progress = Math.min(0.99, value);
        }
      });
      if (controller.signal.aborted) throw new Error('aborted');
      entry.progress = 1;
      await upload(job, out, controller.signal);
      const seconds = Math.round((Date.now() - started) / 1000);
      log(job.own && label ? t('done', { label, seconds }) : t('doneOther', { seconds }));
    } catch (err) {
      if (entry.leaseLost) {
        log(t('leaseLost'));
      } else if (onAuthProblem(err)) {
        /* said already */
      } else if (stopController.signal.aborted) {
        try {
          await call('POST', `/api/render-agent/jobs/${job.jobId}/fail`, { body: { lease: job.lease, released: true }, timeoutMs: 5000 });
          log(t('released'));
        } catch (_) {
          /* the app hands it out again after a minute without a sign of life */
        }
      } else if (err instanceof AgentHttpError && (err.status === 409 || err.status === 404)) {
        log(t('leaseLost'));
      } else {
        const message = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 500);
        log(t('failed', { error: message }));
        try {
          await call('POST', `/api/render-agent/jobs/${job.jobId}/fail`, { body: { lease: job.lease, error: message } });
        } catch (failErr) {
          onAuthProblem(failErr);
        }
      }
    } finally {
      clearInterval(heartbeat);
      stopController.signal.removeEventListener('abort', onStop);
      running.delete(job.lease);
      releaseAwake();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* --- the loop --- */

  async function detect() {
    if (versions) return true;
    const hyperframes = hyperframesVersion(base);
    if (!hyperframes) {
      log(t('hyperframesMissing'));
      exitCode = 1;
      return false;
    }
    const ffmpeg = await prepareFfmpeg({ base, env });
    if (!ffmpeg) {
      log(t('ffmpegMissing'));
      exitCode = 1;
      return false;
    }
    versions = {
      protocol: PROTOCOL_VERSION,
      agent: AGENT_VERSION,
      hyperframes,
      node: process.versions.node,
      ffmpeg: ffmpeg.version,
      ffmpegSource: ffmpeg.source
    };
    const source = { bundled: 'ffmpegBundled', configured: 'ffmpegConfigured' }[ffmpeg.source] || 'ffmpegSystem';
    log(t('header', { agent: AGENT_VERSION, hyperframes, ffmpeg: `${ffmpeg.version} (${t(source)})` }));
    return true;
  }

  async function worker() {
    let failures = 0;
    while (!stopController.signal.aborted) {
      let job = null;
      try {
        const answer = await call('POST', '/api/render-agent/poll', {
          body: { versions, platform, running: [...running.keys()] },
          timeoutMs: POLL_TIMEOUT_MS,
          signal: stopController.signal
        });
        failures = 0;
        if (!connected) {
          connected = true;
          lastDisconnect = '';
          log(t('connected', { server: credentials.server, name: answer.data?.agent?.name || credentials.name || '-' }));
        }
        job = answer.status === 200 ? answer.data?.job || null : null;
      } catch (err) {
        if (stopController.signal.aborted) break;
        if (onAuthProblem(err)) break;
        failures += 1;
        const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
        const jittered = Math.round(wait * (0.8 + Math.random() * 0.4));
        const reason = err instanceof AgentHttpError ? `HTTP ${err.status}` : String(err?.cause?.code || err?.code || err?.name || 'network');
        if (connected || lastDisconnect !== reason) log(t('disconnected', { reason, seconds: Math.round(jittered / 1000) }));
        connected = false;
        lastDisconnect = reason;
        await sleep(jittered, stopController.signal);
        continue;
      }
      if (job) await handleJob(job).catch((err) => log(t('failed', { error: err.message })));
    }
  }

  async function run() {
    if (!credentials) {
      log(t('notPaired'));
      return 1;
    }
    if (!options.noLock && !takeLock()) return 1;
    try {
      if (!(await detect())) return exitCode || 1;
      await worker();
      return exitCode;
    } finally {
      if (!options.noLock) releaseLock();
    }
  }

  // One agent per folder: a second one with the same token would hand back the jobs of the first at every poll.
  function takeLock() {
    const file = path.join(base, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') return true; // a folder without write access: no lock, the run decides
        const pid = lockHolder(base);
        if (pid) {
          log(t('alreadyRunning', { pid }));
          return false;
        }
        fs.rmSync(file, { force: true });
      }
    }
    return true;
  }

  function releaseLock() {
    const file = path.join(base, LOCK_FILE);
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch (_) {
      /* gone already */
    }
  }

  function stop() {
    if (stopController.signal.aborted) return;
    log(t('stopping'));
    stopController.abort();
  }

  return { run, stop, handleJob, running, get versions() { return versions; } };
}

/* ---------- pairing, update, status ---------- */

// `startHint`: say how to start the agent (the subcommand; the installer starts it itself and says so).
async function pair({ server: rawServer, code, name, base = BASE, fetchImpl, env = process.env, log = console.log, versions: givenVersions, lang, startHint = true } = {}) {
  const t = translator(lang || language(env));
  const target = normaliseServer(rawServer, env);
  if (target.error) {
    log(t(target.error, { server: rawServer }));
    return 2;
  }
  let versions = givenVersions;
  if (!versions) {
    const hyperframes = hyperframesVersion(base);
    if (!hyperframes) {
      log(t('hyperframesMissing'));
      return 1;
    }
    // a copy: pairing only reports the versions, the paths are set by the run itself
    const ffmpeg = await prepareFfmpeg({ base, env: { ...env } });
    versions = { protocol: PROTOCOL_VERSION, agent: AGENT_VERSION, hyperframes, node: process.versions.node, ...(ffmpeg ? { ffmpeg: ffmpeg.version, ffmpegSource: ffmpeg.source } : {}) };
  }
  const request = fetchImpl || ((...args) => global.fetch(...args));
  let res;
  try {
    res = await request(`${target.server}/api/render-agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: String(name || os.hostname().replace(/\.local$/i, '') || '').slice(0, 40), platform: `${process.platform}-${process.arch}`, versions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    log(t('pairFailed', { error: String(err?.cause?.code || err.message) }));
    return 1;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !TOKEN_PATTERN.test(String(data.token || ''))) {
    if (res.status === 426) {
      const required = data?.required || {};
      log(t('outdated', { protocol: required.protocol ?? '?', hyperframes: required.hyperframes ?? '?' }));
      return 3;
    }
    log(t('pairFailed', { error: String(data?.error || `HTTP ${res.status}`).slice(0, 300) }));
    return 1;
  }
  writeCredentials(base, { server: target.server, agentId: data.agent?.id || null, name: data.agent?.name || null, pairedAt: new Date().toISOString(), token: data.token });
  log(t(startHint ? 'pairedStart' : 'paired', { name: data.agent?.name || '-' }));
  return 0;
}

// Fetches the package (setup.js with the files) with the token and runs it in update mode in this folder.
async function update({ base = BASE, fetchImpl, env = process.env, log = console.log, spawnImpl = spawn, lang } = {}) {
  const t = translator(lang || language(env));
  const credentials = readCredentials(base);
  if (!credentials) {
    log(t('notPaired'));
    return 1;
  }
  // npm ci replaces node_modules: not under a running agent
  const running = lockHolder(base);
  if (running) {
    log(t('stopFirst', { pid: running }));
    return 1;
  }
  log(t('updating', { server: credentials.server }));
  const request = fetchImpl || ((...args) => global.fetch(...args));
  let text;
  try {
    const res = await request(`${credentials.server}/api/render-agent/package`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    text = await res.text();
    if (res.status === 401) {
      log(t('removed'));
      return 2;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = JSON.parse(text).error || message;
      } catch (_) {
        /* plain text */
      }
      throw new Error(message);
    }
  } catch (err) {
    log(t('updateFailed', { error: String(err?.cause?.code || err.message).slice(0, 300) }));
    return 1;
  }
  const setup = path.join(base, 'setup.js');
  await fsp.writeFile(setup, text, 'utf8');
  const code = await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [setup, '--update', '--dir', base], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (status) => resolve(status === null ? 1 : status));
  });
  log(code === 0 ? t('updated') : t('updateFailed', { error: `setup ${code}` }));
  return code;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

async function main(argv = process.argv.slice(2)) {
  const t = translator(language());
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  if (command === 'pair') {
    return pair({ server: argValue(argv, '--server'), code: argValue(argv, '--code'), name: argValue(argv, '--name') });
  }
  if (command === 'update') return update();
  if (command === 'status') {
    const credentials = readCredentials();
    console.log(credentials ? t('status', { server: credentials.server, name: credentials.name || '-', id: credentials.agentId || '-' }) : t('notPaired'));
    return credentials ? 0 : 1;
  }
  if (command === 'forget') {
    await fsp.rm(path.join(BASE, CREDENTIALS_FILE), { force: true });
    console.log(t('forgotten'));
    return 0;
  }
  if (command !== 'run') {
    console.log(t('usage'));
    return 2;
  }
  const agent = createAgent();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    agent.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const code = await agent.run();
  console.log(t('stopped'));
  return code;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0), (err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  AGENT_VERSION,
  CONTENT_SECURITY_POLICY,
  createAgent,
  pair,
  update,
  main,
  normaliseServer,
  withContentSecurityPolicy,
  progressFrom,
  readCredentials,
  writeCredentials,
  lockHolder,
  prepareFfmpeg,
  hyperframesVersion,
  language,
  translator,
  TEXTS
};
