'use strict';

// Storage overview: which files of the chats and workflows take how much room, and how much is left on the disk.
// Everybody sees the files of their own chats and workflows; admins (and the local mode) may ask for all of them, which also
// lists asset folders whose session file is gone. A file is deleted through the ledger of its session (store.removeAssets), so
// the entry goes with it; a file the ledger does not know (scratch folders, previews) is removed directly.
// The routes are in lib/storage-routes.js, the page is public/storage.html.

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

// Files of the app itself inside an asset folder: counted, never listed and never deleted here.
const PROTECTED_FILES = new Set(['ledger.json', 'asset-ids.json']);
const MAX_DEPTH = 6;
const MAX_FILES_PER_SESSION = 20000;
const MAX_DELETE_ITEMS = 200;
// A file without a ledger entry that was written a moment ago may be the scratch of a running render.
const FRESH_LOOSE_MS = 10 * 60 * 1000;
const PROMPT_LENGTH = 140;

const TYPE_BY_EXT = {
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ts'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.heif', '.svg'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'],
  document: ['.pdf', '.txt', '.md', '.srt', '.vtt', '.ass', '.json', '.html', '.zip', '.glb']
};
const EXT_TYPE = new Map(Object.entries(TYPE_BY_EXT).flatMap(([type, list]) => list.map((ext) => [ext, type])));
const TYPES = ['video', 'image', 'audio', 'document', 'other'];

class StorageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function typeOfFile(file) {
  return EXT_TYPE.get(path.extname(String(file || '')).toLowerCase()) || 'other';
}

// A path inside an asset folder as the client names it: plain segments joined with "/", nothing that leaves the folder.
function cleanRelativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || value.includes('\0')) return null;
  const segments = value.split('/');
  if (segments.length > MAX_DEPTH + 1) return null;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

// inline/ holds the pictures only the Director sees (store.saveInlineImage); the chat reads them again on every turn.
function isProtected(file) {
  const name = path.posix.basename(file);
  return PROTECTED_FILES.has(name) || name.endsWith('.tmp') || file.startsWith('inline/');
}

function fileUrl(sessionId, file) {
  return `/assets/${encodeURIComponent(sessionId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

// Every regular file below `dir` as { file, size, mtimeMs }. Symbolic links are neither followed nor listed.
async function walk(dir) {
  const out = [];
  async function visit(current, prefix, depth) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SESSION) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await visit(full, relative, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          out.push({ file: relative, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (_) {
          /* gone in the meantime */
        }
      }
    }
  }
  await visit(dir, '', 0);
  return out;
}

async function diskOf(dir, statfs) {
  try {
    const info = await statfs(dir);
    const block = Number(info.bsize);
    const total = Number(info.blocks) * block;
    const free = Number(info.bavail) * block;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
    return { total, free, used: Math.max(0, total - free) };
  } catch (_) {
    return null;
  }
}

function createStorageOverview({
  store,
  access,
  assetsDir,
  statfs = fsp.statfs ? (dir) => fsp.statfs(dir) : null,
  // (sessionId) => true while a run of the workflow behind the session is active
  isSessionBusy = async () => false,
  now = () => Date.now()
} = {}) {
  const local = (viewer) => !viewer || !viewer.active;
  const seesAll = (viewer) => local(viewer) || viewer.admin === true;

  function ownerOf(session) {
    return session ? access.sharingOf(session).owner || null : null;
  }

  // Whether the viewer may list and delete the files of a session. `session` is null for an asset folder without a session file.
  function allowed(session, viewer) {
    if (seesAll(viewer)) return true;
    if (!session || !viewer.email) return false;
    return ownerOf(session) === viewer.email;
  }

  async function sessionIndex() {
    const { sessions } = await store.listSessions({ includeHidden: true, includeSharing: true, limit: Infinity });
    return new Map(sessions.map((session) => [session.id, session]));
  }

  async function assetFolders() {
    try {
      const entries = await fsp.readdir(assetsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && store.isValidId(entry.name)).map((entry) => entry.name);
    } catch (_) {
      return [];
    }
  }

  // scope 'mine': the files of the viewer's own chats and workflows. scope 'all' (admins, local mode): everything.
  async function overview({ viewer, scope = 'mine' } = {}) {
    if (viewer && viewer.active && !viewer.email) throw new StorageError('LOGIN_REQUIRED', 'Bitte zuerst anmelden.', 403);
    const all = scope === 'all';
    if (all && !seesAll(viewer)) throw new StorageError('FORBIDDEN', 'Zugriff verweigert.', 403);
    const index = await sessionIndex();
    const folders = await assetFolders();
    const mineOnly = !all && !local(viewer);
    const files = [];
    const sessions = [];
    const byOwner = new Map();
    const byType = Object.fromEntries(TYPES.map((type) => [type, { bytes: 0, files: 0 }]));
    let totalBytes = 0;
    let otherBytes = 0;

    for (const sessionId of folders) {
      const session = index.get(sessionId) || null;
      const owner = ownerOf(session);
      if (mineOnly && !(session && owner === viewer.email)) continue;
      const found = await walk(path.join(assetsDir, sessionId));
      if (!found.length) continue;
      const ledger = new Map((await store.readLedger(sessionId)).map((entry) => [String(entry.file || ''), entry]));
      let sessionBytes = 0;
      let sessionFiles = 0;
      for (const item of found) {
        sessionBytes += item.size;
        if (isProtected(item.file)) {
          otherBytes += item.size;
          continue;
        }
        const entry = ledger.get(item.file) || null;
        const type = typeOfFile(item.file);
        byType[type].bytes += item.size;
        byType[type].files += 1;
        sessionFiles += 1;
        files.push({
          sessionId,
          file: item.file,
          name: path.posix.basename(item.file),
          type,
          size: item.size,
          modifiedAt: new Date(item.mtimeMs).toISOString(),
          url: fileUrl(sessionId, item.file),
          ...(entry ? { assetId: entry.id, kind: entry.kind || null } : {}),
          ...(entry && entry.prompt ? { prompt: String(entry.prompt).slice(0, PROMPT_LENGTH) } : {}),
          ...(entry && entry.pending ? { pending: true } : {})
        });
      }
      totalBytes += sessionBytes;
      sessions.push({
        id: sessionId,
        title: session ? session.title : null,
        kind: session ? session.kind || 'chat' : 'orphan',
        owner,
        bytes: sessionBytes,
        files: sessionFiles,
        updatedAt: session ? session.updatedAt || null : null
      });
      const key = owner || '';
      const sum = byOwner.get(key) || { owner, bytes: 0, files: 0 };
      sum.bytes += sessionBytes;
      sum.files += sessionFiles;
      byOwner.set(key, sum);
    }

    files.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
    sessions.sort((a, b) => b.bytes - a.bytes);
    return {
      scope: all ? 'all' : 'mine',
      canSeeAll: seesAll(viewer),
      // The local mode has no accounts: there is nothing to tell apart.
      accounts: !local(viewer),
      disk: statfs ? await diskOf(assetsDir, statfs) : null,
      totals: { bytes: totalBytes, files: files.length, otherBytes, byType },
      owners: all ? [...byOwner.values()].sort((a, b) => b.bytes - a.bytes) : [],
      sessions,
      files
    };
  }

  async function removeOne({ viewer, index, item }) {
    const sessionId = item && typeof item.sessionId === 'string' ? item.sessionId : '';
    const file = cleanRelativeFile(item && item.file);
    if (!store.isValidId(sessionId) || !file || isProtected(file)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    const session = index.get(sessionId) || null;
    // Somebody who may not see the session learns nothing about it: the same answer as for a file that does not exist.
    if (!allowed(session, viewer)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    const dir = path.resolve(assetsDir, sessionId);
    const target = path.resolve(dir, ...file.split('/'));
    if (!target.startsWith(dir + path.sep)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (_) {
      throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    }
    if (!stat.isFile()) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    // No link on the way may lead out of the asset folder.
    const [realDir, realTarget] = await Promise.all([fsp.realpath(dir), fsp.realpath(target)]);
    if (!realTarget.startsWith(realDir + path.sep)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);

    if (session) {
      let full = null;
      try {
        full = await store.readSession(sessionId);
      } catch (_) {
        /* unreadable session file: treated like a folder without a session */
      }
      if (full && Array.isArray(full.jobs) && full.jobs.some(store.jobNeedsAccounting)) {
        throw new StorageError('BUSY', 'Hier läuft noch ein Auftrag. Bitte warten, bis er fertig ist.', 409);
      }
      if (await isSessionBusy(sessionId)) throw new StorageError('BUSY', 'Hier läuft noch ein Workflow. Bitte warten, bis er fertig ist.', 409);
    }

    const entry = (await store.readLedger(sessionId)).find((candidate) => candidate.file === file);
    if (entry) {
      if (entry.pending) throw new StorageError('BUSY', 'Diese Datei wird gerade erzeugt.', 409);
      const removed = await store.removeAssets(sessionId, [entry.id]);
      if (!removed.includes(entry.id)) throw new StorageError('BUSY', 'Diese Datei wird gerade erzeugt.', 409);
    } else {
      if (now() - stat.mtimeMs < FRESH_LOOSE_MS) {
        throw new StorageError('BUSY', 'Diese Datei wurde eben erst geschrieben und ist vielleicht noch in Arbeit. Bitte später löschen.', 409);
      }
      await fsp.rm(target, { force: true });
    }
    return stat.size;
  }

  // Deletes the named files one after another. One file that cannot be deleted does not stop the others.
  // Returns { deleted: [{ sessionId, file, size }], failed: [{ sessionId, file, code, error }], freedBytes }.
  async function remove({ viewer, items } = {}) {
    if (viewer && viewer.active && !viewer.email) throw new StorageError('LOGIN_REQUIRED', 'Bitte zuerst anmelden.', 403);
    if (!Array.isArray(items) || !items.length) throw new StorageError('INVALID', 'Keine Datei gewählt.', 400);
    if (items.length > MAX_DELETE_ITEMS) throw new StorageError('INVALID', `Höchstens ${MAX_DELETE_ITEMS} Dateien auf einmal.`, 400);
    const index = await sessionIndex();
    const deleted = [];
    const failed = [];
    let freedBytes = 0;
    for (const item of items) {
      const ref = { sessionId: String(item?.sessionId || '').slice(0, 64), file: String(item?.file || '').slice(0, 512) };
      try {
        const size = await removeOne({ viewer, index, item });
        deleted.push({ ...ref, size });
        freedBytes += size;
      } catch (err) {
        if (!(err instanceof StorageError)) console.warn('[storage]', err.message);
        failed.push({ ...ref, code: err instanceof StorageError ? err.code : 'ERROR', error: err instanceof StorageError ? err.message : 'Löschen fehlgeschlagen.' });
      }
    }
    return { deleted, failed, freedBytes };
  }

  return { overview, remove };
}

module.exports = { createStorageOverview, StorageError, typeOfFile, cleanRelativeFile, MAX_DELETE_ITEMS, FRESH_LOOSE_MS };
