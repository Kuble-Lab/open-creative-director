'use strict';

// Files an agent key uploads. They land in a hidden session of the person (kind "agent", one per key) with the same ledger
// as a chat: that is where the run service takes media inputs from (sourceSessionId), and with the same rules as the
// upload of the node view (lib/nodes/routes.js: type by MIME or extension, SVG becomes a PNG, saveUploadFile).
//
//   BASE64_MAX_BYTES    a file in the arguments of a tool call
//   LINK_MAX_BYTES      a file sent to a one-time upload link
//   sessionFor(key, viewer)   the upload session of a key (made on first use; data/mcp-uploads.json remembers it)
//   peek(keyId)               the session id or null, nothing is made
//   save({ key, viewer, filename, mimeType, limitBytes, expectedBytes?, write })   write(file) puts the bytes into a scratch
//                             file and returns their number; resolves { assetId, type, bytes, rasterized }
//   checkQuota(key, bytes)    throws UploadError when `bytes` more would break a limit of the key (see LIMITS)
//   sweep()                   removes the uploads older than the retention time from every upload session
//   startSweeper()            sweep() now and then (once an hour; the timer does not keep the process alive)
//
// Limits per key (an agent key is the only login of the path, so a leaked key must not be able to fill the disk):
//   storageBytes   2 GB in all, hourlyBytes   1 GB per hour, maxFiles   1000 files; over a limit: isError / 413 / 429
//   retentionMs    7 days; after that an upload is removed (a workflow keeps its own copy of a file it was given)
// The content of a file has to look like its type (the first bytes), a name or a MIME type alone does not decide.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const access = require('../access');
const assetsLib = require('../nodes/assets');
const { PATHS } = require('../config');
const store = require('../store');

const UPLOADS_FILE = path.join(PATHS.root, 'data', 'mcp-uploads.json');
const BASE64_MAX_BYTES = 15 * 1024 * 1024;
const LINK_MAX_BYTES = 500 * 1024 * 1024;
const FILENAME_CHARS = 120;
const HOUR_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = HOUR_MS;
const LIMITS = Object.freeze({
  storageBytes: 2 * 1024 * 1024 * 1024,
  hourlyBytes: 1024 * 1024 * 1024,
  maxFiles: 1000,
  retentionMs: 7 * 24 * HOUR_MS
});
const MP4_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);

class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

// The name as the ledger keeps it: no path, no control characters.
function cleanFilename(value) {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '/')).trim();
  return [...base].slice(0, FILENAME_CHARS).join('');
}

// Does the beginning of a file look like the type its extension names? (SVG is not asked: it is rasterised, which fails for
// anything that is not an image.) Only what is certain is refused: a file whose first bytes belong to no known form of
// the type.
function looksLike(ext, head) {
  const at = (offset, text) => head.length >= offset + text.length && head.toString('latin1', offset, offset + text.length) === text;
  const bytes = (...values) => head.length >= values.length && values.every((value, index) => head[index] === value);
  switch (ext) {
    case '.png': return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case '.jpg': case '.jpeg': return bytes(0xff, 0xd8, 0xff);
    case '.gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case '.webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case '.wav': return at(0, 'RIFF') && at(8, 'WAVE');
    case '.webm': return bytes(0x1a, 0x45, 0xdf, 0xa3);
    case '.mp4': case '.m4a': return head.length >= 8 && MP4_BOXES.has(head.toString('latin1', 4, 8));
    case '.mp3': return at(0, 'ID3') || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case '.aac': return at(0, 'ID3') || at(0, 'ADIF') || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) || (head.length >= 8 && MP4_BOXES.has(head.toString('latin1', 4, 8)));
    default: return true;
  }
}

async function readHead(file, length = 16) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function createUploads({ file = UPLOADS_FILE, sessions = store, assets = assetsLib, limits = {}, now = Date.now } = {}) {
  const queues = new Map();
  const quotaQueues = new Map();
  const reserved = new Map(); // key id -> { bytes, files } of uploads in progress
  const max = { ...LIMITS, ...limits };
  let cache = null;
  let sweeper = null;

  function read() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? { ...parsed.sessions } : {};
    } catch (_) {
      cache = {};
    }
    return cache;
  }

  function write(map) {
    cache = map;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: map }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  }

  const peek = (keyId) => {
    const id = read()[keyId];
    return typeof id === 'string' && sessions.isValidId(id) ? id : null;
  };

  async function exists(sessionId) {
    try {
      await sessions.readSessionAccess(sessionId);
      return true;
    } catch (_) {
      return false;
    }
  }

  function sessionFor(key, viewer) {
    const previous = queues.get(key.id) || Promise.resolve();
    const run = previous.then(async () => {
      const known = peek(key.id);
      if (known && (await exists(known))) return known;
      const created = await sessions.createSession({ kind: 'agent', title: 'Agent-Zugang', owner: access.ownerForNew(viewer) });
      write({ ...read(), [key.id]: created.id });
      return created.id;
    });
    const tail = run.catch(() => {});
    queues.set(key.id, tail);
    tail.then(() => {
      if (queues.get(key.id) === tail) queues.delete(key.id);
    });
    return run;
  }

  /* ----- limits and clean-up ----- */

  const assetPath = (sessionId, entry) => path.join(sessions.sessionAssetDir(sessionId), entry.file);

  // What a key has stored: bytes, bytes of the last hour and files (finished or on their way).
  async function usageOf(sessionId) {
    const usage = { bytes: 0, hourBytes: 0, files: 0 };
    if (!sessionId) return usage;
    const since = now() - HOUR_MS;
    for (const entry of await sessions.readLedger(sessionId)) {
      usage.files += 1;
      if (entry.pending || typeof entry.file !== 'string') continue;
      let size = 0;
      try {
        size = (await fsp.stat(assetPath(sessionId, entry))).size;
      } catch (_) {
        continue; // the file is gone
      }
      usage.bytes += size;
      if (Date.parse(entry.createdAt) > since) usage.hourBytes += size;
    }
    return usage;
  }

  const mb = (bytes) => Math.round(bytes / (1024 * 1024));

  function overLimit(usage, pending, bytes) {
    if (usage.files + pending.files + 1 > max.maxFiles) {
      return new UploadError('QUOTA_FILES', `This key has stored ${max.maxFiles} files already. Uploads are removed after ${Math.round(max.retentionMs / (24 * HOUR_MS))} days; use the files you have, or ask for a new key.`);
    }
    if (usage.bytes + pending.bytes + bytes > max.storageBytes) {
      return new UploadError('QUOTA_STORAGE', `This key may keep ${mb(max.storageBytes)} MB of uploads and has used ${mb(usage.bytes + pending.bytes)} MB. Uploads are removed after ${Math.round(max.retentionMs / (24 * HOUR_MS))} days.`);
    }
    if (usage.hourBytes + pending.bytes + bytes > max.hourlyBytes) {
      return new UploadError('QUOTA_HOURLY', `This key may upload ${mb(max.hourlyBytes)} MB per hour and has used ${mb(usage.hourBytes + pending.bytes)} MB in the last hour. Try again later.`);
    }
    return null;
  }

  const pendingOf = (keyId) => reserved.get(keyId) || { bytes: 0, files: 0 };

  // Runs fn after the earlier quota calls of the same key (the check and the reservation of two uploads cannot overlap).
  function serial(keyId, fn) {
    const run = (quotaQueues.get(keyId) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    quotaQueues.set(keyId, tail);
    tail.then(() => {
      if (quotaQueues.get(keyId) === tail) quotaQueues.delete(keyId);
    });
    return run;
  }

  async function checkQuota(key, bytes = 0) {
    return serial(key.id, async () => {
      const problem = overLimit(await usageOf(peek(key.id)), pendingOf(key.id), Math.max(0, Number(bytes) || 0));
      if (problem) throw problem;
    });
  }

  // Checks and reserves in one step; resolves a function that gives the reservation back.
  function reserve(key, bytes) {
    return serial(key.id, async () => {
      const problem = overLimit(await usageOf(peek(key.id)), pendingOf(key.id), bytes);
      if (problem) throw problem;
      const current = pendingOf(key.id);
      reserved.set(key.id, { bytes: current.bytes + bytes, files: current.files + 1 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = pendingOf(key.id);
        const next = { bytes: Math.max(0, left.bytes - bytes), files: Math.max(0, left.files - 1) };
        if (next.files === 0 && next.bytes === 0) reserved.delete(key.id);
        else reserved.set(key.id, next);
      };
    });
  }

  // Removes the uploads of one session that are older than the retention time. Resolves their number.
  async function sweepSession(sessionId) {
    const cutoff = now() - max.retentionMs;
    const isOld = (entry) => entry.kind === 'upload' && Date.parse(entry.createdAt) < cutoff;
    if (!(await sessions.readLedger(sessionId)).some(isOld)) return 0;
    let removed = 0;
    await sessions.withLock(sessionId, async () => {
      const entries = await sessions.readLedger(sessionId);
      const kept = [];
      for (const entry of entries) {
        if (!isOld(entry)) {
          kept.push(entry);
          continue;
        }
        removed += 1;
        if (typeof entry.file === 'string' && path.basename(entry.file) === entry.file) await fsp.rm(assetPath(sessionId, entry), { force: true }).catch(() => {});
      }
      if (removed) await sessions.writeLedger(sessionId, kept);
    });
    return removed;
  }

  async function sweep() {
    let removed = 0;
    for (const id of new Set(Object.values(read()))) {
      if (typeof id !== 'string' || !sessions.isValidId(id)) continue;
      try {
        removed += await sweepSession(id);
      } catch (err) {
        console.warn(`[mcp] Aufräumen der Uploads fehlgeschlagen: ${String((err && (err.code || err.name)) || 'Fehler')}`);
      }
    }
    return removed;
  }

  function startSweeper({ intervalMs = SWEEP_INTERVAL_MS, first = true } = {}) {
    if (sweeper) return sweeper.stop;
    const timer = setInterval(() => {
      sweep().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    const start = first ? setTimeout(() => sweep().catch(() => {}), 30 * 1000) : null;
    start?.unref?.();
    sweeper = {
      stop() {
        clearInterval(timer);
        if (start) clearTimeout(start);
        sweeper = null;
      }
    };
    return sweeper.stop;
  }

  // The type of a file by its MIME type or name: { ext, svg? } or throws UploadError('UNSUPPORTED_MEDIA')
  function resolveType(filename, mimeType) {
    const { uploadExtension } = require('../nodes/routes');
    const resolved = uploadExtension(mimeType, filename);
    if (resolved.error) throw new UploadError('UNSUPPORTED_MEDIA', `${resolved.error}. Allowed: png, jpg, webp, gif, svg (made a PNG), mp4, webm, mp3, wav, m4a, aac.`);
    return resolved;
  }

  async function save({ key, viewer, filename, mimeType, limitBytes, expectedBytes, write: writeBytes }) {
    const routes = require('../nodes/routes');
    const name = cleanFilename(filename);
    if (!name) throw new UploadError('INVALID_FILENAME', 'The file needs a name.');
    const resolved = resolveType(name, mimeType);
    const limit = resolved.svg ? Math.min(limitBytes, routes.MAX_SVG_BYTES) : limitBytes;
    // room for it first: the size when it is known, else the most it may be
    const release = await reserve(key, Math.min(Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : limit, limit));
    try {
      const sessionId = await sessionFor(key, viewer);
      const scratch = await assets.createScratchDir(sessionId);
      try {
        const sourceFile = path.join(scratch, `upload${resolved.ext}`);
        const bytes = await writeBytes(sourceFile, limit);
        if (!bytes) throw new UploadError('EMPTY', 'The file is empty.');
        if (!resolved.svg && !looksLike(resolved.ext, await readHead(sourceFile))) {
          throw new UploadError('CONTENT_MISMATCH', `The content of "${name}" is not a ${resolved.ext.slice(1)} file: the first bytes do not match the type. Send the file itself, with the right name or media type.`);
        }
        let value;
        if (resolved.svg) value = await routes.rasterizeSvgUpload(sessionId, sourceFile, name);
        else value = await assets.saveUploadFile(sessionId, { sourceFile, ext: resolved.ext, name });
        return { assetId: value.assetId, type: value.type, bytes, rasterized: Boolean(resolved.svg) };
      } finally {
        await assets.removeScratchDir(scratch).catch(() => {});
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      release();
    }
  }

  return { sessionFor, peek, resolveType, save, checkQuota, usageOf, sweep, startSweeper, limits: max, file };
}

module.exports = {
  UPLOADS_FILE,
  BASE64_MAX_BYTES,
  LINK_MAX_BYTES,
  LIMITS,
  UploadError,
  cleanFilename,
  looksLike,
  createUploads
};
