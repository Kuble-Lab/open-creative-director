'use strict';

// Storage overview: which files of the chats and workflows take how much room, and how much is left on the disk.
// Everybody sees the files of their own chats and workflows; admins (and the local mode) may ask for all of them, which also
// lists asset folders whose session file is gone. A file is deleted through the ledger of its session (store.removeAssets), so
// the entry goes with it; a file the ledger does not know (scratch folders, previews) is removed directly.
// Archive (optional, lib/dropbox-archive.js): admins move a file of the ledger into the connected Dropbox. The ledger entry
// stays and gets `archived: { provider, path, size, contentHash, at }`, the file on the server goes once the copy is checked.
// Fetching it back downloads it, checks it and removes the mark. Both run one after another in the background (jobs below).
// A whole chat or workflow goes the same way (`sessions` instead of `files`): every finished file of its ledger.
// Fetching back is open to everybody who may use the chat or workflow (the app shows a note where an archived file is
// missing, public/archived-media.js); moving into the archive stays with the admins.
// Automatic (optional, switched on by an admin on the page): files of the chosen kind that are larger and older than the
// limits go into the archive by themselves (runAuto, started by server.js on a timer). The settings live in
// data/storage-auto-archive.json.
// The routes are in lib/storage-routes.js, the page is public/storage.html.

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

// Files of the app itself inside an asset folder: counted, never listed and never deleted here.
const PROTECTED_FILES = new Set(['ledger.json', 'asset-ids.json']);
const MAX_DEPTH = 6;
const MAX_FILES_PER_SESSION = 20000;
const MAX_DELETE_ITEMS = 200;
// Whole chats or workflows per call, and the files they may bring into the queue.
const MAX_SESSIONS = 50;
const MAX_QUEUE_ITEMS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const AUTO_DEFAULTS = { enabled: false, minMb: 200, minDays: 30 };
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
  // lib/dropbox-archive.js, or null for an installation without an archive
  archive = null,
  // where the settings of the automatic archive are kept; null: no automatic
  autoFile = null,
  now = () => Date.now()
} = {}) {
  // Background work of the archive: key "<sessionId>/<file>" -> { state: 'queued' | 'archiving' | 'restoring' | 'error', kind, progress, error }.
  const jobs = new Map();
  const queue = [];
  let working = false;
  let idle = Promise.resolve();
  const jobKey = (sessionId, file) => `${sessionId}/${file}`;

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

  // Whether the viewer may open the chat or workflow at all (own, shared with them, or admin): enough to fetch a file back.
  function mayUse(session, viewer) {
    if (seesAll(viewer)) return true;
    return Boolean(session) && access.canUse(session, viewer);
  }

  const isArchived = (entry) =>
    Boolean(entry && entry.archived && typeof entry.archived.path === 'string' && Number.isFinite(entry.archived.size));

  function jobFields(sessionId, file) {
    const job = jobs.get(jobKey(sessionId, file));
    if (!job) return {};
    return { job: job.state, ...(job.state === 'error' ? { jobError: job.error } : {}), ...(job.progress ? { jobProgress: job.progress } : {}) };
  }

  // What the page shows about the archive. Only people who may use it learn whose Dropbox it is.
  async function archiveInfo(viewer) {
    if (!archive) return { available: false, canUse: false, connected: false };
    const canUse = seesAll(viewer);
    const status = archive.status();
    if (!canUse) return { available: true, canUse: false, connected: status.connected };
    return {
      available: true,
      canUse: true,
      connected: status.connected,
      account: status.account,
      space: status.connected ? await archive.space() : null,
      active: queue.length + (working ? 1 : 0),
      auto: autoFile ? { ...(await readAuto()), ...autoState } : null
    };
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
    let archivedBytes = 0;
    let archivedFiles = 0;

    for (const sessionId of folders) {
      const session = index.get(sessionId) || null;
      const owner = ownerOf(session);
      if (mineOnly && !(session && owner === viewer.email)) continue;
      const found = await walk(path.join(assetsDir, sessionId));
      if (!found.length) continue;
      const ledger = new Map((await store.readLedger(sessionId)).map((entry) => [String(entry.file || ''), entry]));
      const onDisk = new Set();
      let sessionBytes = 0;
      let sessionFiles = 0;
      let sessionArchivedBytes = 0;
      let sessionArchivedFiles = 0;
      let sessionArchivable = 0;
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
        if (entry && !entry.pending) sessionArchivable += 1;
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
          ...(entry && entry.pending ? { pending: true } : {}),
          ...jobFields(sessionId, item.file)
        });
        onDisk.add(item.file);
      }
      // What was moved into the archive: still an entry of the ledger, no file on the server.
      for (const entry of ledger.values()) {
        if (!isArchived(entry) || onDisk.has(entry.file)) continue;
        const type = typeOfFile(entry.file);
        archivedBytes += entry.archived.size;
        archivedFiles += 1;
        sessionArchivedBytes += entry.archived.size;
        sessionArchivedFiles += 1;
        files.push({
          sessionId,
          file: entry.file,
          name: path.posix.basename(entry.file),
          type,
          size: entry.archived.size,
          modifiedAt: entry.archived.at,
          archived: true,
          assetId: entry.id,
          kind: entry.kind || null,
          ...(entry.prompt ? { prompt: String(entry.prompt).slice(0, PROMPT_LENGTH) } : {}),
          ...jobFields(sessionId, entry.file)
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
        archivable: sessionArchivable,
        archivedBytes: sessionArchivedBytes,
        archivedFiles: sessionArchivedFiles,
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
      totals: { bytes: totalBytes, files: files.length - archivedFiles, otherBytes, byType, archivedBytes, archivedFiles },
      archive: await archiveInfo(viewer),
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
    if (jobs.has(jobKey(sessionId, file)) && jobs.get(jobKey(sessionId, file)).state !== 'error') {
      throw new StorageError('BUSY', 'Diese Datei wird gerade archiviert oder zurückgeholt.', 409);
    }
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (_) {
      // Not on the server: it may be in the archive. Then the copy there and the ledger entry go.
      const archived = (await store.readLedger(sessionId)).find((candidate) => candidate.file === file && isArchived(candidate));
      if (!archived) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
      if (!archive || !seesAll(viewer)) throw new StorageError('FORBIDDEN', 'Dateien im Archiv löscht eine Admin-Person.', 403);
      try {
        await archive.remove(archived.archived.path);
      } catch (err) {
        throw new StorageError(err.code || 'ARCHIVE', err.message, err.status || 502);
      }
      await store.removeAssets(sessionId, [archived.id]);
      jobs.delete(jobKey(sessionId, file));
      return 0;
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

    jobs.delete(jobKey(sessionId, file));
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

  /* ---------- archive ---------- */

  function archivePath(session, sessionId, file) {
    const owner = (ownerOf(session) || '_').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120);
    return `/${owner}/${sessionId}/${file}`;
  }

  async function assertQuiet(sessionId, session) {
    if (!session) return;
    let full = null;
    try {
      full = await store.readSession(sessionId);
    } catch (_) {
      /* unreadable session file */
    }
    if (full && Array.isArray(full.jobs) && full.jobs.some(store.jobNeedsAccounting)) {
      throw new StorageError('BUSY', 'Hier läuft noch ein Auftrag. Bitte warten, bis er fertig ist.', 409);
    }
    if (await isSessionBusy(sessionId)) throw new StorageError('BUSY', 'Hier läuft noch ein Workflow. Bitte warten, bis er fertig ist.', 409);
  }

  // Changes one ledger entry under the lock of the session. `change` gets the entry and returns false to leave everything as it is.
  function updateLedgerEntry(sessionId, assetId, change) {
    return store.withLock(sessionId, async () => {
      const entries = await store.readLedger(sessionId);
      const entry = entries.find((candidate) => candidate.id === assetId);
      if (!entry || (await change(entry)) === false) return false;
      await store.writeLedger(sessionId, entries);
      return true;
    });
  }

  async function runArchive(task, job) {
    const { sessionId, file, session } = task;
    const target = path.join(assetsDir, sessionId, file);
    await assertQuiet(sessionId, session);
    const entry = (await store.readLedger(sessionId)).find((candidate) => candidate.file === file);
    if (!entry || entry.pending) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    const before = await fsp.stat(target);
    const stored = await archive.upload(target, archivePath(session, sessionId, file), {
      onProgress: (share) => {
        job.progress = Math.round(share * 100);
      }
    });
    // The file must be the one that was uploaded: same size, not written to in the meantime.
    const after = await fsp.stat(target);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new StorageError('BUSY', 'Die Datei hat sich während des Archivierens geändert.', 409);
    const marked = await updateLedgerEntry(sessionId, entry.id, async (current) => {
      if (current.pending || current.file !== file) return false;
      current.archived = { provider: 'dropbox', path: stored.path, size: stored.size, contentHash: stored.contentHash, at: new Date(now()).toISOString() };
      await fsp.rm(target, { force: true });
      return true;
    });
    if (!marked) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
  }

  async function runRestore(task) {
    const { sessionId, file } = task;
    const entry = (await store.readLedger(sessionId)).find((candidate) => candidate.file === file && isArchived(candidate));
    if (!entry) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    if (statfs) {
      const disk = await diskOf(assetsDir, statfs);
      // keep a reserve: fetching back must never fill the disk
      if (disk && disk.free < entry.archived.size + 2 * 1024 * 1024 * 1024) throw new StorageError('DISK_FULL', 'Auf dem Server ist nicht genug Platz, um die Datei zurückzuholen.', 507);
    }
    await archive.download(entry.archived.path, path.join(assetsDir, sessionId, file), { size: entry.archived.size, contentHash: entry.archived.contentHash });
    const remotePath = entry.archived.path;
    await updateLedgerEntry(sessionId, entry.id, (current) => {
      delete current.archived;
    });
    // The server has the file again; a copy that cannot be removed from the Dropbox is only wasted room there.
    await archive.remove(remotePath).catch((err) => console.warn('[storage] Kopie im Archiv nicht entfernt:', err.message));
  }

  async function work() {
    if (working) return;
    working = true;
    let release;
    idle = new Promise((resolve) => {
      release = resolve;
    });
    try {
      while (queue.length) {
        const task = queue.shift();
        const key = jobKey(task.sessionId, task.file);
        const job = jobs.get(key);
        if (!job) continue;
        job.state = task.kind === 'archive' ? 'archiving' : 'restoring';
        try {
          if (task.kind === 'archive') await runArchive(task, job);
          else await runRestore(task);
          jobs.delete(key);
        } catch (err) {
          const known = err instanceof StorageError || (err && typeof err.code === 'string' && typeof err.status === 'number');
          if (!known) console.error('[storage]', err);
          jobs.set(key, { state: 'error', kind: task.kind, error: known ? err.message : 'Fehlgeschlagen.' });
        }
      }
    } finally {
      working = false;
      release();
    }
  }

  async function onServer(sessionId, file) {
    try {
      return (await fsp.lstat(path.join(assetsDir, sessionId, file))).isFile();
    } catch (_) {
      return false;
    }
  }

  // The files of whole chats or workflows that can go the asked way: finished ledger entries that are on the server
  // ('archive') or in the archive ('restore').
  async function filesOfSessions(kind, ids) {
    if (!Array.isArray(ids)) return [];
    if (ids.length > MAX_SESSIONS) throw new StorageError('INVALID', `Höchstens ${MAX_SESSIONS} Chats oder Workflows auf einmal.`, 400);
    const items = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !store.isValidId(id)) continue;
      for (const entry of await store.readLedger(id)) {
        const file = cleanRelativeFile(entry && entry.file);
        if (!file || entry.pending || isProtected(file)) continue;
        if (kind === 'restore' ? isArchived(entry) && !(await onServer(id, file)) : await onServer(id, file)) items.push({ sessionId: id, file });
      }
    }
    return items;
  }

  // Puts files into the queue of the archive (kind 'archive') or of the way back (kind 'restore'): the named `items`
  // and every fitting file of the named `sessions`. Into the archive: admins and the local mode only. Back: everybody who
  // may use the chat or workflow. Returns at once: { queued: [{ sessionId, file }], failed: [{ sessionId, file, code,
  // error }] }; the overview shows how far each file is.
  async function enqueue(kind, { viewer, items, sessions } = {}) {
    if (viewer && viewer.active && !viewer.email) throw new StorageError('LOGIN_REQUIRED', 'Bitte zuerst anmelden.', 403);
    if (kind === 'archive' && !seesAll(viewer)) throw new StorageError('FORBIDDEN', 'Zugriff verweigert.', 403);
    if (!archive) throw new StorageError('NO_ARCHIVE', 'Es ist kein Archiv eingerichtet.', 404);
    if (!archive.isConnected()) throw new StorageError('NOT_CONNECTED', 'Dropbox ist nicht verbunden.', 409);
    const named = Array.isArray(items) ? items : [];
    if (named.length > MAX_DELETE_ITEMS) throw new StorageError('INVALID', `Höchstens ${MAX_DELETE_ITEMS} Dateien auf einmal.`, 400);
    const index = await sessionIndex();
    // Somebody who may not use a chat or workflow learns nothing about its files.
    const wholeIds = (Array.isArray(sessions) ? sessions : []).filter((id) => typeof id === 'string' && mayUse(index.get(id) || null, viewer));
    const all = [...named, ...(await filesOfSessions(kind, wholeIds))];
    if (!all.length) throw new StorageError('INVALID', kind === 'archive' ? 'Nichts zu archivieren.' : 'Hier liegt nichts im Archiv.', 400);
    if (all.length > MAX_QUEUE_ITEMS) throw new StorageError('INVALID', `Höchstens ${MAX_QUEUE_ITEMS} Dateien auf einmal.`, 400);
    const queued = [];
    const failed = [];
    for (const item of all) {
      const ref = { sessionId: String(item?.sessionId || '').slice(0, 64), file: String(item?.file || '').slice(0, 512) };
      try {
        const sessionId = item && typeof item.sessionId === 'string' ? item.sessionId : '';
        const file = cleanRelativeFile(item && item.file);
        if (!store.isValidId(sessionId) || !file || isProtected(file)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
        if (!mayUse(index.get(sessionId) || null, viewer)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
        const key = jobKey(sessionId, file);
        const running = jobs.get(key);
        if (running && running.state !== 'error') {
          // Asked for twice (two people look at the same workflow): the work is already on its way.
          if (kind === 'restore' && running.kind === kind) {
            queued.push(ref);
            continue;
          }
          throw new StorageError('BUSY', 'Diese Datei ist schon in Arbeit.', 409);
        }
        const entry = (await store.readLedger(sessionId)).find((candidate) => candidate.file === file);
        if (!entry || entry.pending) throw new StorageError('NOT_ARCHIVABLE', 'Nur fertige Ergebnisse und Uploads lassen sich archivieren.', 400);
        const present = await onServer(sessionId, file);
        if (kind === 'archive' && !present) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
        if (kind === 'restore' && (present || !isArchived(entry))) throw new StorageError('NOT_ARCHIVED', 'Diese Datei liegt nicht im Archiv.', 400);
        jobs.set(key, { state: 'queued', kind });
        queue.push({ kind, sessionId, file, session: index.get(sessionId) || null });
        queued.push(ref);
      } catch (err) {
        if (!(err instanceof StorageError)) console.warn('[storage]', err.message);
        failed.push({ ...ref, code: err instanceof StorageError ? err.code : 'ERROR', error: err instanceof StorageError ? err.message : 'Fehlgeschlagen.' });
      }
    }
    work();
    return { queued, failed };
  }

  // What the app needs to know where a picture or video does not load: is the file in the archive, is it on its way back,
  // and how much else of the chat or workflow is there. For everybody who may use the chat or workflow.
  // -> { archived, size?, job?, jobProgress?, jobError?, canRestore, others: { files, bytes } }
  async function archivedState({ viewer, sessionId, file } = {}) {
    if (viewer && viewer.active && !viewer.email) throw new StorageError('LOGIN_REQUIRED', 'Bitte zuerst anmelden.', 403);
    const clean = cleanRelativeFile(file);
    if (typeof sessionId !== 'string' || !store.isValidId(sessionId) || !clean) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    const index = await sessionIndex();
    if (!mayUse(index.get(sessionId) || null, viewer)) throw new StorageError('NOT_FOUND', 'Datei nicht gefunden.', 404);
    const ledger = await store.readLedger(sessionId);
    const entry = ledger.find((candidate) => candidate.file === clean);
    const present = await onServer(sessionId, clean);
    const archivedNow = Boolean(entry && isArchived(entry) && !present);
    const others = { files: 0, bytes: 0 };
    for (const other of ledger) {
      if (other === entry || !isArchived(other) || (await onServer(sessionId, String(other.file)))) continue;
      others.files += 1;
      others.bytes += other.archived.size;
    }
    return {
      archived: archivedNow,
      ...(archivedNow ? { size: entry.archived.size } : {}),
      ...jobFields(sessionId, clean),
      canRestore: Boolean(archive && archive.isConnected()),
      others
    };
  }

  /* ---------- automatic archive ---------- */

  // What the last run did; kept in memory only.
  const autoState = { lastRunAt: null, lastQueued: 0 };

  function cleanAuto(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const minMb = Number(value.minMb);
    const minDays = Number(value.minDays);
    return {
      enabled: value.enabled === true,
      minMb: Number.isFinite(minMb) && minMb >= 1 && minMb <= 1024 * 1024 ? Math.round(minMb) : AUTO_DEFAULTS.minMb,
      minDays: Number.isFinite(minDays) && minDays >= 1 && minDays <= 3650 ? Math.round(minDays) : AUTO_DEFAULTS.minDays
    };
  }

  async function readAuto() {
    if (!autoFile) return { ...AUTO_DEFAULTS };
    try {
      return cleanAuto(JSON.parse(await fsp.readFile(autoFile, 'utf8')));
    } catch (_) {
      return { ...AUTO_DEFAULTS };
    }
  }

  // Admins set { enabled, minMb, minDays }; what is left out stays as it is.
  async function setAuto({ viewer, settings } = {}) {
    if (!seesAll(viewer)) throw new StorageError('FORBIDDEN', 'Zugriff verweigert.', 403);
    if (!archive || !autoFile) throw new StorageError('NO_ARCHIVE', 'Es ist kein Archiv eingerichtet.', 404);
    const input = settings && typeof settings === 'object' ? settings : {};
    for (const key of ['minMb', 'minDays']) {
      if (input[key] !== undefined && !(Number.isFinite(Number(input[key])) && Number(input[key]) >= 1)) {
        throw new StorageError('INVALID', 'Grösse und Alter müssen mindestens 1 sein.', 400);
      }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new StorageError('INVALID', 'enabled muss true oder false sein.', 400);
    const next = cleanAuto({ ...(await readAuto()), ...input });
    await fsp.mkdir(path.dirname(autoFile), { recursive: true });
    const temp = `${autoFile}.${process.pid}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
    await fsp.rename(temp, autoFile);
    return { ...next, ...autoState };
  }

  // One pass of the automatic: every finished video on the server that is larger and older than the limits goes into the
  // queue of the archive. Chats and workflows with work in progress wait for the next pass. `sessions` limits the pass to
  // these chats or workflows. -> { queued, skipped? }
  async function runAuto({ sessions = null } = {}) {
    const settings = await readAuto();
    if (!settings.enabled) return { queued: 0, skipped: 'off' };
    if (!archive || !archive.isConnected()) return { queued: 0, skipped: 'not-connected' };
    const index = await sessionIndex();
    const minBytes = settings.minMb * MB;
    const before = now() - settings.minDays * DAY_MS;
    let count = 0;
    for (const sessionId of await assetFolders()) {
      if (sessions && !sessions.includes(sessionId)) continue;
      const session = index.get(sessionId) || null;
      const ledger = (await store.readLedger(sessionId)).filter((entry) => entry && !entry.pending && !isArchived(entry) && typeof entry.file === 'string');
      const wanted = [];
      for (const entry of ledger) {
        const file = cleanRelativeFile(entry.file);
        if (!file || isProtected(file) || typeOfFile(file) !== 'video') continue;
        const running = jobs.get(jobKey(sessionId, file));
        if (running && running.state !== 'error') continue;
        let stat;
        try {
          stat = await fsp.lstat(path.join(assetsDir, sessionId, file));
        } catch (_) {
          continue;
        }
        if (!stat.isFile() || stat.size < minBytes || stat.mtimeMs > before) continue;
        wanted.push(file);
      }
      if (!wanted.length) continue;
      try {
        await assertQuiet(sessionId, session);
      } catch (_) {
        continue;
      }
      for (const file of wanted) {
        jobs.set(jobKey(sessionId, file), { state: 'queued', kind: 'archive' });
        queue.push({ kind: 'archive', sessionId, file, session });
        count += 1;
      }
    }
    autoState.lastRunAt = new Date(now()).toISOString();
    autoState.lastQueued = count;
    if (count) {
      console.log(`[storage] Automatik: ${count} Videos ins Archiv`);
      work();
    }
    return { queued: count };
  }

  return {
    overview,
    remove,
    archive: (options) => enqueue('archive', options),
    restore: (options) => enqueue('restore', options),
    archivedState,
    setAuto,
    runAuto,
    // resolves when the queue of the archive is empty (tests)
    whenIdle: () => idle
  };
}

module.exports = { createStorageOverview, StorageError, typeOfFile, cleanRelativeFile, MAX_DELETE_ITEMS, FRESH_LOOSE_MS, AUTO_DEFAULTS };
