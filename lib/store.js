'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');
const ffmpeg = require('./ffmpeg');
const access = require('./access');

const KIND_PREFIX = { image: 'img', video: 'vid', audio: 'aud', upload: 'upload' };
const DATA_DIR = path.join(PATHS.root, 'data');
const BRAIN_MEMORY_FILE = path.join(DATA_DIR, 'brain-memory.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const FOLDER_PROFILES_FILE = path.join(DATA_DIR, 'folder-profiles.json');
const CONTEXT_FILES_DIR = path.join(DATA_DIR, 'context-files');
const FOLDER_CONTEXT_FILES_DIR = path.join(DATA_DIR, 'folder-context-files');
const MAX_BRAIN_MEMORY_ENTRIES = 200;
const MAX_BRAIN_MEMORY_NOTE_LENGTH = 500;
const MAX_FOLDER_NAME_LENGTH = 60;
const MAX_FOLDER_GUIDELINES_LENGTH = 30000;
const MAX_FOLDER_MEMORY_ENTRIES = 50;
const MAX_FOLDER_MEMORY_NOTE_LENGTH = 500;
const MAX_FOLDER_CONTEXT_BRAINS = 5;
const MAX_ATTACHED_BRANDINGS = 2;
const MAX_CAST_MEMBERS = 12;
const MAX_CONTEXT_FILES = 5;
const MAX_CONTEXT_FILE_CHARS = 60000;
const MAX_SESSION_SEARCH_TEXT_CHARS = 200000;
const CONTEXT_FILE_EXTENSIONS = new Set(['.md', '.txt', '.markdown']);
const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
};

function ensureDirs() {
  fs.mkdirSync(PATHS.assetsDir, { recursive: true });
  fs.mkdirSync(PATHS.projectsDir, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CONTEXT_FILES_DIR, { recursive: true });
  fs.mkdirSync(FOLDER_CONTEXT_FILES_DIR, { recursive: true });
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function sessionFile(id) {
  if (!isValidId(id)) throw new Error('Ungueltige Session-ID');
  return path.join(PATHS.projectsDir, `${id}.json`);
}

function sessionAssetDir(id) {
  if (!isValidId(id)) throw new Error('Ungueltige Session-ID');
  return path.join(PATHS.assetsDir, id);
}

function sessionContextDir(id) {
  if (!isValidId(id)) throw new Error('Ungueltige Session-ID');
  return path.join(CONTEXT_FILES_DIR, id);
}

/* ---------- per-session mutex ---------- */

const locks = new Map();

function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous.then(fn, fn);
  // keep the chain alive even if fn rejects
  locks.set(
    id,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

/* ---------- sessions (unlocked primitives) ---------- */

// Bilder, die nur der Brain sieht (Auto-Vorschauen, Konsistenz-Frames), liegen als
// Datei im Session-Asset-Ordner statt als base64 in der Session-Datei. Sonst waechst
// die Session-JSON mit jeder Vorschau um Megabytes und wird bei jedem Chat-Zug
// komplett gelesen und geschrieben.
const INLINE_SUBDIR = 'inline';

function sessionBlobPath(sessionId, file) {
  const dir = path.resolve(sessionAssetDir(sessionId));
  const target = path.resolve(dir, String(file || ''));
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Ungueltiger Dateipfad');
  return target;
}

async function saveInlineImage(sessionId, buffer, ext = '.png') {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 32);
  const file = `${INLINE_SUBDIR}/${hash}${ext}`;
  const target = sessionBlobPath(sessionId, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.access(target);
  } catch (_) {
    await fsp.writeFile(target, data);
  }
  return { file };
}

async function readInlineImage(sessionId, file) {
  return fsp.readFile(sessionBlobPath(sessionId, file));
}

// Nur Groesse und mtime einer Session-Datei - damit der Poller unveraenderte
// Sessions ueberspringen kann, statt sie alle 6 Sekunden komplett zu parsen.
async function sessionStat(id) {
  try {
    const stat = await fsp.stat(sessionFile(id));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (_) {
    return null;
  }
}

async function readSession(id) {
  const raw = await fsp.readFile(sessionFile(id), 'utf8');
  const session = JSON.parse(raw);
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.jobs)) session.jobs = [];
  if (!Array.isArray(session.contextBrains)) session.contextBrains = [];
  if (!Array.isArray(session.contextFiles)) session.contextFiles = [];
  session.role = typeof session.role === 'string' && isValidId(session.role) ? session.role : null;
  session.brandings = Array.isArray(session.brandings)
    ? [...new Set(session.brandings.filter((id) => isValidId(id)))].slice(0, MAX_ATTACHED_BRANDINGS)
    : [];
  // owner / shareMode / sharedWith are read through access.sharingOf: old files without them stay valid and unchanged.
  return session;
}

// Owner and sharing of a session for the access checks (chats, assets, downloads). Reads the whole file only when
// it changed, so checking every asset request stays cheap.
const sessionAccessCache = new Map();

async function readSessionAccess(id) {
  const file = sessionFile(id);
  const stat = await fsp.stat(file);
  const cached = sessionAccessCache.get(id);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  const value = { kind: typeof raw.kind === 'string' ? raw.kind : null, ...access.sharingOf(raw) };
  sessionAccessCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  if (sessionAccessCache.size > 5000) sessionAccessCache.delete(sessionAccessCache.keys().next().value);
  return value;
}

async function writeSession(session, { touchUpdatedAt = true } = {}) {
  if (touchUpdatedAt) session.updatedAt = new Date().toISOString();
  const file = sessionFile(session.id);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  sessionListCache.delete(`${session.id}.json`);
  sessionAccessCache.delete(session.id);
  return session;
}

// kind marks non-chat sessions (e.g. 'workflow' for the node view backing session);
// chats keep no kind field. title is optional and defaults to 'Neuer Chat'.
// owner: normalised address of the creator (user management), null for anonymous or local use. A session with an
// owner starts private.
async function createSession({ folder = null, role = null, kind = null, title = null, owner = null } = {}) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const cleanFolder = folder === null ? null : validateFolderName(folder);
  const cleanKind = kind === null ? null : validateSessionKind(kind);
  const cleanTitle = typeof title === 'string' && title.trim() ? truncateText(title.trim(), 120) : 'Neuer Chat';
  const session = {
    id,
    title: cleanTitle,
    folder: cleanFolder,
    createdAt: now,
    updatedAt: now,
    messages: [],
    jobs: [],
    contextBrains: [],
    contextFiles: [],
    role: role === null ? null : validateRoleId(role),
    brandings: []
  };
  if (cleanKind) session.kind = cleanKind;
  const cleanOwner = access.normalizeEmail(owner);
  if (cleanOwner) Object.assign(session, { owner: cleanOwner, shareMode: 'private', sharedWith: [] });
  await fsp.mkdir(sessionAssetDir(id), { recursive: true });
  await writeSession(session);
  if (cleanFolder) await registerFolder(cleanFolder);
  return session;
}

function validateSessionKind(kind) {
  if (typeof kind !== 'string' || !/^[a-z][a-z-]{0,23}$/.test(kind)) throw new Error('Ungueltige Session-Art');
  return kind;
}

// Sessions of these kinds back other features (node view workflows) and stay out of chat listings.
const HIDDEN_SESSION_KINDS = new Set(['workflow']);

const SNIPPET_LEN = 90;
const sessionListCache = new Map();

// Reiner Text einer Nachricht: content ist String oder Array von Parts.
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }
  return '';
}

// ca. SNIPPET_LEN Zeichen rund um die Fundstelle, mit … wo abgeschnitten wurde.
function makeSnippet(flat, index, queryLength) {
  const pad = Math.max(0, Math.floor((SNIPPET_LEN - queryLength) / 2));
  let start = Math.max(0, index - pad);
  let end = Math.min(flat.length, start + SNIPPET_LEN);
  if (end - start < SNIPPET_LEN) start = Math.max(0, end - SNIPPET_LEN);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

// Baut einen begrenzten Suchindex ohne Bilddaten aus Titel und sichtbaren Nachrichten.
function buildSessionSearchText(session, title) {
  const parts = [title];
  let length = title.length;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const message of messages) {
    if (!message || message.hidden) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (length >= MAX_SESSION_SEARCH_TEXT_CHARS) break;
    const remaining = MAX_SESSION_SEARCH_TEXT_CHARS - length - 1;
    if (remaining <= 0) break;
    const text = messageText(message.content).slice(0, remaining).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return parts.join('\n').slice(0, MAX_SESSION_SEARCH_TEXT_CHARS);
}

// Sucht zuerst im Nachrichtentext und danach im Titel; liefert null wenn nichts passt.
function matchSession(meta, searchText, needle) {
  const title = meta.title || 'Neuer Chat';
  const messageTextStart = Math.min(searchText.length, title.length + 1);
  const messages = searchText.slice(messageTextStart);
  const index = messages.toLowerCase().indexOf(needle);
  if (index >= 0) return { snippet: makeSnippet(messages, index, needle.length) };
  return title.toLowerCase().includes(needle) ? { snippet: null } : null;
}

// includeHidden: true also returns backing sessions of non-chat features (kind 'workflow').
// viewer (user management, see lib/access.js): only sessions the viewer may see are returned, each with owner,
// sharing and the viewer's rights. includeSharing: true returns the sharing fields without filtering (server-internal).
// Without either option the result is unchanged.
async function listSessions({ q, limit = 20, offset = 0, includeHidden = false, viewer = null, includeSharing = false, folder = '' } = {}) {
  let files = [];
  try {
    files = await fsp.readdir(PATHS.projectsDir);
  } catch (_) {
    return { sessions: [], total: 0 };
  }
  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  const fileStats = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        return { file, stat: await fsp.stat(path.join(PATHS.projectsDir, file)) };
      } catch (_) {
        return null;
      }
    })
  );
  const currentFiles = new Set(fileStats.filter(Boolean).map(({ file }) => file));
  for (const file of sessionListCache.keys()) {
    if (!currentFiles.has(file)) sessionListCache.delete(file);
  }

  for (const entry of fileStats) {
    if (!entry) continue;
    const { file, stat } = entry;
    const cached = sessionListCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    try {
      const session = JSON.parse(await fsp.readFile(path.join(PATHS.projectsDir, file), 'utf8'));
      const meta = {
        id: session.id,
        title: session.title || 'Neuer Chat',
        folder: typeof session.folder === 'string' && session.folder.trim() ? session.folder.trim() : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt || session.createdAt
      };
      const hidden = HIDDEN_SESSION_KINDS.has(session.kind);
      if (hidden) meta.kind = session.kind;
      sessionListCache.set(file, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        meta,
        sharing: access.sharingOf(session),
        hidden,
        searchText: buildSessionSearchText(session, meta.title)
      });
    } catch (_) {
      sessionListCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null, searchText: '' });
    }
  }

  const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
  const onlyFolder = typeof folder === 'string' ? folder.trim() : '';
  const activeViewer = viewer && viewer.active ? viewer : null;
  const adminLookup = activeViewer ? access.createAdminLookup() : null;
  const out = [];
  for (const file of currentFiles) {
    const cached = sessionListCache.get(file);
    if (!cached?.meta) continue;
    if (cached.hidden && !includeHidden) continue;
    if (activeViewer && !access.canUse(cached.sharing, activeViewer)) continue;
    // An open project in the side menu asks for its own chats only.
    if (onlyFolder && !(cached.meta.folder && sameFolderName(onlyFolder, cached.meta.folder))) continue;
    const meta = { ...cached.meta };
    if (activeViewer) Object.assign(meta, access.describe(cached.sharing, activeViewer, adminLookup));
    else if (includeSharing) Object.assign(meta, cached.sharing);
    if (needle) {
      const hit = matchSession(meta, cached.searchText, needle);
      if (!hit) continue;
      if (hit.snippet) meta.snippet = hit.snippet;
    }
    out.push(meta);
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const total = out.length;
  const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
  return { sessions: out.slice(from, from + size), total };
}

async function deleteSession(id) {
  await fsp.rm(sessionFile(id), { force: true });
  await fsp.rm(sessionAssetDir(id), { recursive: true, force: true });
  await fsp.rm(sessionContextDir(id), { recursive: true, force: true });
  sessionListCache.delete(`${id}.json`);
  sessionAccessCache.delete(id);
}

// Atomic read-modify-write of a session file. Never call inside another lock.
async function mutateSession(id, fn, { touchUpdatedAt = true } = {}) {
  return withLock(id, async () => {
    const session = await readSession(id);
    const result = await fn(session);
    await writeSession(session, { touchUpdatedAt });
    return result;
  });
}

function truncateText(value, maxLength) {
  return [...value].slice(0, maxLength).join('');
}

async function updateSessionMeta(id, changes = {}) {
  const hasTitle = Object.prototype.hasOwnProperty.call(changes, 'title');
  const hasFolder = Object.prototype.hasOwnProperty.call(changes, 'folder');
  const hasBrandings = Object.prototype.hasOwnProperty.call(changes, 'brandings');
  const hasRole = Object.prototype.hasOwnProperty.call(changes, 'role');
  const cleanBrandings = hasBrandings ? validateBrandingIds(changes.brandings, 'Session') : null;
  const cleanRole = hasRole && changes.role !== null ? validateRoleId(changes.role) : null;

  const result = await mutateSession(
    id,
    (session) => {
      if (hasTitle) {
        if (typeof changes.title !== 'string') throw new TypeError('Titel muss ein String sein');
        const title = changes.title.trim();
        if (!title) throw new Error('Titel darf nicht leer sein');
        session.title = truncateText(title, 120);
      }

      if (hasFolder) {
        if (changes.folder === null) {
          session.folder = null;
        } else {
          session.folder = validateFolderName(changes.folder);
        }
      }

      if (hasBrandings) session.brandings = cleanBrandings.slice();
      if (hasRole) session.role = cleanRole;

      const meta = {
        id: session.id,
        title: session.title || 'Neuer Chat',
        folder: typeof session.folder === 'string' && session.folder.trim() ? session.folder : null,
        brandings: Array.isArray(session.brandings) ? session.brandings.slice() : []
      };
      if (hasRole) meta.role = session.role || null;
      return meta;
    },
    { touchUpdatedAt: false }
  );
  if (result.folder) await registerFolder(result.folder);
  return result;
}

// Sets who a session is shared with. `owner` is set only when given (an admin taking over a session without an owner).
async function updateSessionSharing(id, { shareMode, sharedWith, sharedTeams, owner } = {}) {
  const sharing = access.buildSharing({ shareMode, sharedWith, sharedTeams }, {}, () => true);
  const cleanOwner = owner === undefined ? undefined : access.normalizeEmail(owner);
  return mutateSession(
    id,
    (session) => {
      if (cleanOwner) session.owner = cleanOwner;
      session.shareMode = sharing.shareMode;
      session.sharedWith = sharing.sharedWith;
      session.sharedTeams = sharing.sharedTeams || [];
      access.normaliseSharing(session);
      return {
        id: session.id,
        owner: session.owner,
        shareMode: session.shareMode,
        sharedWith: session.sharedWith.slice(),
        ...(session.sharedTeams ? { sharedTeams: session.sharedTeams.slice() } : {})
      };
    },
    { touchUpdatedAt: false }
  );
}

function validateRoleId(role) {
  if (typeof role !== 'string' || !isValidId(role.trim())) throw new Error('Ungueltige Rollen-ID');
  return role.trim();
}

function validateContextFilename(name) {
  if (typeof name !== 'string') throw new TypeError('Dateiname muss ein String sein');
  const clean = path.basename(name.trim());
  if (!clean) throw new Error('Dateiname darf nicht leer sein');
  if ([...clean].length > 200) throw new Error('Dateiname darf maximal 200 Zeichen lang sein');
  if (!CONTEXT_FILE_EXTENSIONS.has(path.extname(clean).toLowerCase())) {
    throw new Error('Nur .md-, .txt- und .markdown-Dateien sind erlaubt');
  }
  return clean;
}

function truncateContextFileText(text) {
  const characters = [...text];
  const truncationNote = '\n\n[gekuerzt]';
  return characters.length > MAX_CONTEXT_FILE_CHARS
    ? `${characters.slice(0, MAX_CONTEXT_FILE_CHARS - [...truncationNote].length).join('')}${truncationNote}`
    : text;
}

function cleanContextFileMetadata(files) {
  if (!Array.isArray(files)) return [];
  const clean = [];
  for (const file of files) {
    if (!file || !isValidId(file.id) || typeof file.name !== 'string') continue;
    clean.push({
      id: file.id,
      name: file.name,
      chars: Number.isFinite(file.chars) ? Math.max(0, Math.floor(file.chars)) : 0,
      addedAt: typeof file.addedAt === 'string' ? file.addedAt : null
    });
    if (clean.length === MAX_CONTEXT_FILES) break;
  }
  return clean;
}

async function addContextFile(sessionId, name, text) {
  const cleanName = validateContextFilename(name);
  if (typeof text !== 'string') throw new TypeError('Dateiinhalt muss ein String sein');
  const storedText = truncateContextFileText(text);
  await readSession(sessionId);
  return withLock(sessionId, async () => {
    const session = await readSession(sessionId);
    if (session.contextFiles.length >= MAX_CONTEXT_FILES) {
      throw new Error(`Pro Chat koennen maximal ${MAX_CONTEXT_FILES} Kontextdateien angehaengt werden`);
    }
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const meta = { id, name: cleanName, chars: [...storedText].length, addedAt: new Date().toISOString() };
    const dir = sessionContextDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.md`), storedText, 'utf8');
    session.contextFiles.push(meta);
    await writeSession(session);
    return { ...meta };
  });
}

async function removeContextFile(sessionId, fileId) {
  if (!isValidId(fileId)) throw new Error('Ungueltige Kontextdatei-ID');
  return withLock(sessionId, async () => {
    const session = await readSession(sessionId);
    const exists = session.contextFiles.some((file) => file?.id === fileId);
    if (!exists) return false;
    session.contextFiles = session.contextFiles.filter((file) => file?.id !== fileId);
    await writeSession(session);
    await fsp.rm(path.join(sessionContextDir(sessionId), `${fileId}.md`), { force: true });
    return true;
  });
}

async function readContextFiles(sessionId) {
  const session = await readSession(sessionId);
  const files = [];
  for (const meta of session.contextFiles) {
    if (!meta || !isValidId(meta.id)) continue;
    try {
      const text = await fsp.readFile(path.join(sessionContextDir(sessionId), `${meta.id}.md`), 'utf8');
      files.push({ id: meta.id, name: meta.name || `${meta.id}.md`, text });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return files;
}

async function setSessionBrandings(id, ids) {
  return updateSessionMeta(id, { brandings: ids });
}

/* ---------- folders and production profiles ---------- */

function validateFolderName(folder) {
  if (typeof folder !== 'string') throw new TypeError('Projektname muss ein String sein');
  const clean = folder.trim();
  if (!clean) throw new Error('Projektname darf nicht leer sein');
  if ([...clean].length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(`Projektname darf maximal ${MAX_FOLDER_NAME_LENGTH} Zeichen lang sein`);
  }
  return clean;
}

function cleanStoredFolderName(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && [...clean].length <= MAX_FOLDER_NAME_LENGTH ? clean : null;
}

function sameFolderName(left, right) {
  return left.localeCompare(right, 'de-CH', { sensitivity: 'accent' }) === 0;
}

async function readFolderRegistry() {
  try {
    const parsed = JSON.parse(await fsp.readFile(FOLDERS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(cleanStoredFolderName).filter(Boolean))];
  } catch (_) {
    return [];
  }
}

function sortFolderNames(names) {
  return names.sort((a, b) => a.localeCompare(b, 'de-CH'));
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function writeFolderRegistry(folders) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const cleanFolders = sortFolderNames([...new Set(folders.map(cleanStoredFolderName).filter(Boolean))]);
  await writeJsonAtomic(FOLDERS_FILE, cleanFolders);
}

async function sessionFolderNames() {
  const { sessions } = await listSessions({ limit: Number.MAX_SAFE_INTEGER });
  return sessions.map((session) => cleanStoredFolderName(session.folder)).filter(Boolean);
}

async function listFolders() {
  const [registered, implicit, profiles] = await Promise.all([
    readFolderRegistry(),
    sessionFolderNames(),
    readFolderProfiles()
  ]);
  return sortFolderNames([
    ...new Set([...registered, ...implicit, ...Object.keys(profiles).map(cleanStoredFolderName).filter(Boolean)])
  ]);
}

/* ----- who created a project (participants only see the projects they created or that hold something shared with them) ----- */

const FOLDER_OWNERS_FILE = path.join(DATA_DIR, 'folder-owners.json');

async function readFolderOwners() {
  try {
    const parsed = JSON.parse(await fsp.readFile(FOLDER_OWNERS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function folderOwner(folder) {
  const clean = cleanStoredFolderName(folder);
  if (!clean) return null;
  const owners = await readFolderOwners();
  return Object.prototype.hasOwnProperty.call(owners, clean) ? access.normalizeEmail(owners[clean]) : null;
}

// Records the creator of a project that has none yet. Returns true if it was recorded.
async function claimFolder(folder, owner) {
  const clean = validateFolderName(folder);
  const email = access.normalizeEmail(owner);
  if (!email) return false;
  return withLock('global-folder-owners', async () => {
    const owners = await readFolderOwners();
    if (Object.prototype.hasOwnProperty.call(owners, clean)) return false;
    Object.defineProperty(owners, clean, { value: email, enumerable: true, configurable: true, writable: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await writeJsonAtomic(FOLDER_OWNERS_FILE, owners);
    return true;
  });
}

// A project was renamed (newName) or deleted (newName = null): its record follows.
async function moveFolderOwner(oldName, newName) {
  await withLock('global-folder-owners', async () => {
    const owners = await readFolderOwners();
    if (!Object.prototype.hasOwnProperty.call(owners, oldName)) return;
    const email = owners[oldName];
    delete owners[oldName];
    if (newName) Object.defineProperty(owners, newName, { value: email, enumerable: true, configurable: true, writable: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await writeJsonAtomic(FOLDER_OWNERS_FILE, owners);
  });
}

async function registerFolder(folder) {
  const cleanFolder = validateFolderName(folder);
  return withLock('global-folders', async () => {
    const registered = await readFolderRegistry();
    if (!registered.includes(cleanFolder)) {
      registered.push(cleanFolder);
      await writeFolderRegistry(registered);
    }
    return cleanFolder;
  });
}

async function createFolder(folder) {
  const cleanFolder = validateFolderName(folder);
  return withLock('global-folders', async () => {
    const folders = await listFolders();
    if (folders.some((name) => sameFolderName(name, cleanFolder))) {
      const err = new Error(`Projekt «${cleanFolder}» existiert bereits`);
      err.code = 'FOLDER_EXISTS';
      throw err;
    }
    const registered = await readFolderRegistry();
    registered.push(cleanFolder);
    await writeFolderRegistry(registered);
    return cleanFolder;
  });
}

async function renameFolder(oldName, newName) {
  const cleanOldName = validateFolderName(oldName);
  const cleanNewName = validateFolderName(newName);
  return withLock('global-folders', async () => {
    const folders = await listFolders();
    if (!folders.includes(cleanOldName)) {
      const err = new Error(`Projekt «${cleanOldName}» wurde nicht gefunden`);
      err.code = 'FOLDER_NOT_FOUND';
      throw err;
    }
    if (cleanOldName === cleanNewName) return cleanNewName;
    if (folders.some((name) => name !== cleanOldName && sameFolderName(name, cleanNewName))) {
      const err = new Error(`Projekt «${cleanNewName}» existiert bereits`);
      err.code = 'FOLDER_EXISTS';
      throw err;
    }

    const registered = await readFolderRegistry();
    const nextRegistered = registered.filter((name) => name !== cleanOldName);
    if (!nextRegistered.includes(cleanNewName)) nextRegistered.push(cleanNewName);
    await writeFolderRegistry(nextRegistered);

    await withLock('global-folder-profiles', async () => {
      const profiles = await readFolderProfiles();
      if (!Object.prototype.hasOwnProperty.call(profiles, cleanOldName)) return;
      const profile = profiles[cleanOldName];
      delete profiles[cleanOldName];
      Object.defineProperty(profiles, cleanNewName, {
        value: profile,
        enumerable: true,
        configurable: true,
        writable: true
      });
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    });

    // Hidden backing sessions (node view workflows) move with the project as well.
    const { sessions } = await listSessions({ limit: Number.MAX_SAFE_INTEGER, includeHidden: true });
    const affected = sessions.filter((session) => session.folder === cleanOldName);
    await Promise.all(
      affected.map((session) =>
        mutateSession(
          session.id,
          (stored) => {
            if (stored.folder === cleanOldName) stored.folder = cleanNewName;
          },
          { touchUpdatedAt: false }
        )
      )
    );
    await moveFolderOwner(cleanOldName, cleanNewName);
    await notifyFolderChange(cleanOldName, cleanNewName);
    return cleanNewName;
  });
}

// Features that keep their own copy of a session's folder (the node view's workflow.json) follow renames/deletes.
const folderChangeListeners = [];

function onFolderChange(listener) {
  folderChangeListeners.push(listener);
}

async function notifyFolderChange(oldName, newName) {
  for (const listener of folderChangeListeners) {
    try {
      await listener(oldName, newName);
    } catch (err) {
      console.warn('[folders] Folgeaenderung fehlgeschlagen:', err.message);
    }
  }
}

async function deleteFolder(folder) {
  const cleanFolder = validateFolderName(folder);
  return withLock('global-folders', async () => {
    const { sessions } = await listSessions({ limit: Number.MAX_SAFE_INTEGER });
    const sessionCount = sessions.filter((session) => session.folder === cleanFolder).length;
    if (sessionCount > 0) {
      const err = new Error('Zuerst Chats verschieben oder loeschen');
      err.code = 'FOLDER_NOT_EMPTY';
      err.sessionCount = sessionCount;
      throw err;
    }

    const registered = await readFolderRegistry();
    await writeFolderRegistry(registered.filter((name) => name !== cleanFolder));
    await withLock('global-folder-profiles', async () => {
      const profiles = await readFolderProfiles();
      const contextFiles = cleanContextFileMetadata(profiles[cleanFolder]?.contextFiles);
      delete profiles[cleanFolder];
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
      await Promise.all(
        contextFiles.map((file) => fsp.rm(path.join(FOLDER_CONTEXT_FILES_DIR, `${file.id}.md`), { force: true }))
      );
    });
    // Workflows (hidden sessions) do not count as chats, but they must not keep pointing at a deleted project.
    const { sessions: hidden } = await listSessions({ limit: Number.MAX_SAFE_INTEGER, includeHidden: true });
    await Promise.all(
      hidden
        .filter((session) => session.folder === cleanFolder)
        .map((session) =>
          mutateSession(
            session.id,
            (stored) => {
              if (stored.folder === cleanFolder) stored.folder = null;
            },
            { touchUpdatedAt: false }
          )
        )
    );
    await moveFolderOwner(cleanFolder, null);
    await notifyFolderChange(cleanFolder, null);
    return cleanFolder;
  });
}

async function readFolderProfiles() {
  try {
    const parsed = JSON.parse(await fsp.readFile(FOLDER_PROFILES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function readFolderProfile(folder) {
  const cleanFolder = validateFolderName(folder);
  const profiles = await readFolderProfiles();
  if (!Object.prototype.hasOwnProperty.call(profiles, cleanFolder)) return null;
  const profile = profiles[cleanFolder];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  return {
    guidelines: typeof profile.guidelines === 'string' ? profile.guidelines : '',
    contextBrains: Array.isArray(profile.contextBrains)
      ? profile.contextBrains.filter((id) => typeof id === 'string' && id.trim()).slice(0, MAX_FOLDER_CONTEXT_BRAINS)
      : [],
    brandings: Array.isArray(profile.brandings)
      ? profile.brandings.filter((id) => isValidId(id)).slice(0, MAX_ATTACHED_BRANDINGS)
      : [],
    cast: cleanCastIds(profile.cast),
    contextFiles: cleanContextFileMetadata(profile.contextFiles),
    memory: cleanFolderMemory(profile.memory),
    updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : null
  };
}

function cleanFolderMemory(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) =>
      entry &&
      typeof entry.id === 'string' && /^mem-[0-9a-f]{8}$/.test(entry.id) &&
      typeof entry.note === 'string' && entry.note.trim() &&
      [...entry.note.trim()].length <= MAX_FOLDER_MEMORY_NOTE_LENGTH &&
      typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt))
    )
    .slice(0, MAX_FOLDER_MEMORY_ENTRIES)
    .map((entry) => {
      const clean = { id: entry.id, note: entry.note.trim(), createdAt: entry.createdAt };
      // Provenance of a note saved by the Director in a chat of the user management (see visibleFolderMemory).
      const owner = access.normalizeEmail(entry.owner);
      if (owner) clean.owner = owner;
      if (owner && isValidId(entry.sessionId)) clean.sessionId = entry.sessionId;
      return clean;
    });
}

function cleanCastIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => isValidId(id)))].slice(0, MAX_CAST_MEMBERS);
}

function validateBrandingIds(ids, owner = 'Eintrag') {
  if (!Array.isArray(ids)) throw new TypeError('brandings muss ein Array sein');
  if (ids.length > MAX_ATTACHED_BRANDINGS) {
    throw new Error(`${owner} darf maximal ${MAX_ATTACHED_BRANDINGS} Brandings enthalten`);
  }
  const clean = [];
  for (const value of ids) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError('Branding-IDs muessen nicht-leere Strings sein');
    }
    const id = value.trim();
    if (!isValidId(id)) throw new Error(`Ungueltige Branding-ID: ${id}`);
    if (!clean.includes(id)) clean.push(id);
  }
  return clean;
}

async function writeFolderProfile(folder, options = {}) {
  const { guidelines = '', contextBrains = [], brandings = [] } = options;
  const cleanFolder = validateFolderName(folder);
  if (typeof guidelines !== 'string') throw new TypeError('Richtlinien muessen ein String sein');
  if (!Array.isArray(contextBrains)) throw new TypeError('contextBrains muss ein Array sein');
  const cleanBrandings = validateBrandingIds(brandings, 'Ein Produktions-Profil');
  if (Object.prototype.hasOwnProperty.call(options, 'cast') && !Array.isArray(options.cast)) {
    throw new TypeError('cast muss ein Array sein');
  }
  if (Array.isArray(options.cast) && options.cast.length > MAX_CAST_MEMBERS) {
    throw new Error(`Ein Projekt darf maximal ${MAX_CAST_MEMBERS} Cast-Mitglieder enthalten`);
  }
  const requestedCast = Object.prototype.hasOwnProperty.call(options, 'cast') ? cleanCastIds(options.cast) : null;

  const cleanGuidelines = guidelines.trim();
  if ([...cleanGuidelines].length > MAX_FOLDER_GUIDELINES_LENGTH) {
    throw new Error(`Richtlinien duerfen maximal ${MAX_FOLDER_GUIDELINES_LENGTH} Zeichen lang sein`);
  }
  if (contextBrains.length > MAX_FOLDER_CONTEXT_BRAINS) {
    throw new Error(`Ein Produktions-Profil darf maximal ${MAX_FOLDER_CONTEXT_BRAINS} GTS-Brains enthalten`);
  }
  const cleanContextBrains = [];
  for (const value of contextBrains) {
    if (typeof value !== 'string') throw new TypeError('GTS-Brain-IDs muessen Strings sein');
    const id = value.trim();
    if (!id) throw new Error('GTS-Brain-ID darf nicht leer sein');
    if (!cleanContextBrains.includes(id)) cleanContextBrains.push(id);
  }

  return withLock('global-folder-profiles', async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const profiles = await readFolderProfiles();
    const previous = profiles[cleanFolder];
    const contextFiles = cleanContextFileMetadata(previous?.contextFiles);
    const castIds = requestedCast === null ? cleanCastIds(previous?.cast) : requestedCast;
    const memory = cleanFolderMemory(previous?.memory);
    if (!cleanGuidelines && cleanContextBrains.length === 0 && cleanBrandings.length === 0 && contextFiles.length === 0 && castIds.length === 0 && memory.length === 0) {
      delete profiles[cleanFolder];
      await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
      return null;
    }

    const profile = {
      guidelines: cleanGuidelines,
      contextBrains: cleanContextBrains,
      brandings: cleanBrandings,
      cast: castIds,
      contextFiles,
      memory,
      updatedAt: new Date().toISOString()
    };
    Object.defineProperty(profiles, cleanFolder, {
      value: profile,
      enumerable: true,
      configurable: true,
      writable: true
    });
    await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    return {
      ...profile,
      contextBrains: profile.contextBrains.slice(),
      brandings: profile.brandings.slice(),
      cast: profile.cast.slice(),
      contextFiles: profile.contextFiles.map((file) => ({ ...file })),
      memory: profile.memory.map((entry) => ({ ...entry }))
    };
  });
}

async function addFolderContextFile(folder, name, text) {
  const cleanFolder = validateFolderName(folder);
  const cleanName = validateContextFilename(name);
  if (typeof text !== 'string') throw new TypeError('Dateiinhalt muss ein String sein');
  const storedText = truncateContextFileText(text);

  return withLock('global-folder-profiles', async () => {
    await fsp.mkdir(FOLDER_CONTEXT_FILES_DIR, { recursive: true });
    const profiles = await readFolderProfiles();
    const previous = profiles[cleanFolder];
    const contextFiles = cleanContextFileMetadata(previous?.contextFiles);
    if (contextFiles.length >= MAX_CONTEXT_FILES) {
      throw new Error(`Pro Projekt koennen maximal ${MAX_CONTEXT_FILES} Kontextdateien angehaengt werden`);
    }

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const meta = { id, name: cleanName, chars: [...storedText].length, addedAt: new Date().toISOString() };
    const file = path.join(FOLDER_CONTEXT_FILES_DIR, `${id}.md`);
    await fsp.writeFile(file, storedText, 'utf8');
    try {
      Object.defineProperty(profiles, cleanFolder, {
        value: {
          guidelines: typeof previous?.guidelines === 'string' ? previous.guidelines : '',
          contextBrains: Array.isArray(previous?.contextBrains) ? previous.contextBrains : [],
          brandings: Array.isArray(previous?.brandings) ? previous.brandings : [],
          cast: cleanCastIds(previous?.cast),
          contextFiles: [...contextFiles, meta],
          memory: cleanFolderMemory(previous?.memory),
          updatedAt: new Date().toISOString()
        },
        enumerable: true,
        configurable: true,
        writable: true
      });
      await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw err;
    }
    return { ...meta };
  });
}

async function removeFolderContextFile(folder, fileId) {
  const cleanFolder = validateFolderName(folder);
  if (!isValidId(fileId)) throw new Error('Ungueltige Kontextdatei-ID');
  return withLock('global-folder-profiles', async () => {
    const profiles = await readFolderProfiles();
    const previous = profiles[cleanFolder];
    const contextFiles = cleanContextFileMetadata(previous?.contextFiles);
    if (!contextFiles.some((file) => file.id === fileId)) return false;

    const remaining = contextFiles.filter((file) => file.id !== fileId);
    const guidelines = typeof previous?.guidelines === 'string' ? previous.guidelines : '';
    const contextBrains = Array.isArray(previous?.contextBrains) ? previous.contextBrains : [];
    const brandingIds = Array.isArray(previous?.brandings) ? previous.brandings : [];
    const castIds = cleanCastIds(previous?.cast);
    const memory = cleanFolderMemory(previous?.memory);
    if (!guidelines && contextBrains.length === 0 && brandingIds.length === 0 && remaining.length === 0 && castIds.length === 0 && memory.length === 0) {
      delete profiles[cleanFolder];
    } else {
      Object.defineProperty(profiles, cleanFolder, {
        value: {
          guidelines,
          contextBrains,
          brandings: brandingIds,
          cast: castIds,
          contextFiles: remaining,
          memory,
          updatedAt: new Date().toISOString()
        },
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    await fsp.rm(path.join(FOLDER_CONTEXT_FILES_DIR, `${fileId}.md`), { force: true });
    return true;
  });
}

async function withExistingFolderProfileLock(folder, fn) {
  const cleanFolder = validateFolderName(folder);
  return withLock('global-folders', async () => {
    if (!(await listFolders()).includes(cleanFolder)) {
      const err = new Error(`Projekt «${cleanFolder}» wurde nicht gefunden`);
      err.code = 'FOLDER_NOT_FOUND';
      throw err;
    }
    return withLock('global-folder-profiles', () => fn(cleanFolder));
  });
}

async function addFolderMemory(folder, note, source = {}) {
  if (typeof note !== 'string') throw new TypeError('Projekt-Memory-Notiz muss ein String sein');
  const cleanNote = note.trim();
  if (!cleanNote) throw new Error('Projekt-Memory-Notiz darf nicht leer sein');
  if ([...cleanNote].length > MAX_FOLDER_MEMORY_NOTE_LENGTH) {
    throw new Error(`Projekt-Memory-Notiz darf maximal ${MAX_FOLDER_MEMORY_NOTE_LENGTH} Zeichen lang sein`);
  }

  return withExistingFolderProfileLock(folder, async (cleanFolder) => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const profiles = await readFolderProfiles();
    const previous = profiles[cleanFolder];
    const memory = cleanFolderMemory(previous?.memory);
    if (memory.length >= MAX_FOLDER_MEMORY_ENTRIES) {
      throw new Error('Projekt-Memory ist voll (50 Eintraege). Bitte alte Eintraege im Produktions-Profil loeschen.');
    }
    let id;
    do {
      id = `mem-${crypto.randomBytes(4).toString('hex')}`;
    } while (memory.some((entry) => entry.id === id));
    const entry = { id, note: cleanNote, createdAt: new Date().toISOString() };
    // User management: remember who saved it and from which chat, so people who may not use that chat never see the note.
    const owner = access.normalizeEmail(source?.owner);
    if (owner) {
      entry.owner = owner;
      if (isValidId(source.sessionId)) entry.sessionId = source.sessionId;
    }
    Object.defineProperty(profiles, cleanFolder, {
      value: {
        guidelines: typeof previous?.guidelines === 'string' ? previous.guidelines : '',
        contextBrains: Array.isArray(previous?.contextBrains) ? previous.contextBrains : [],
        brandings: Array.isArray(previous?.brandings) ? previous.brandings : [],
        cast: cleanCastIds(previous?.cast),
        contextFiles: cleanContextFileMetadata(previous?.contextFiles),
        memory: [...memory, entry],
        updatedAt: new Date().toISOString()
      },
      enumerable: true,
      configurable: true,
      writable: true
    });
    await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    return { ...entry };
  });
}

async function removeFolderMemory(folder, id) {
  return withExistingFolderProfileLock(folder, async (cleanFolder) => {
    if (typeof id !== 'string' || !/^mem-[0-9a-f]{8}$/.test(id)) return false;
    const profiles = await readFolderProfiles();
    const previous = profiles[cleanFolder];
    const memory = cleanFolderMemory(previous?.memory);
    if (!memory.some((entry) => entry.id === id)) return false;

    const remaining = memory.filter((entry) => entry.id !== id);
    const guidelines = typeof previous?.guidelines === 'string' ? previous.guidelines : '';
    const contextBrains = Array.isArray(previous?.contextBrains) ? previous.contextBrains : [];
    const brandingIds = Array.isArray(previous?.brandings) ? previous.brandings : [];
    const castIds = cleanCastIds(previous?.cast);
    const contextFiles = cleanContextFileMetadata(previous?.contextFiles);
    if (!guidelines && contextBrains.length === 0 && brandingIds.length === 0 && castIds.length === 0 && contextFiles.length === 0 && remaining.length === 0) {
      delete profiles[cleanFolder];
    } else {
      Object.defineProperty(profiles, cleanFolder, {
        value: {
          guidelines,
          contextBrains,
          brandings: brandingIds,
          cast: castIds,
          contextFiles,
          memory: remaining,
          updatedAt: new Date().toISOString()
        },
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    await writeJsonAtomic(FOLDER_PROFILES_FILE, profiles);
    return true;
  });
}

async function readFolderContextFiles(folder) {
  const profile = await readFolderProfile(folder);
  const files = [];
  for (const meta of profile?.contextFiles || []) {
    try {
      const text = await fsp.readFile(path.join(FOLDER_CONTEXT_FILES_DIR, `${meta.id}.md`), 'utf8');
      files.push({ id: meta.id, name: meta.name || `${meta.id}.md`, text });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return files;
}

/* ---------- global brain memory ---------- */

// Notes carry an optional `owner` (the person whose chat produced them) once the user management is active.
// Without a viewer (or in the local mode) every note is returned. With an active viewer only notes without owner
// (existing data, anonymous chats) and the viewer's own notes are, so one person's private chat never reaches
// the prompt of somebody else's chat.
async function readBrainMemory({ viewer } = {}) {
  let entries;
  try {
    const parsed = JSON.parse(await fsp.readFile(BRAIN_MEMORY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    entries = parsed.filter(
      (entry) => entry && typeof entry.ts === 'string' && typeof entry.note === 'string'
    );
  } catch (_) {
    return [];
  }
  if (!viewer || !viewer.active) return entries;
  const restricted = access.isRestricted(viewer);
  return entries.filter((entry) => {
    const owner = access.normalizeEmail(entry.owner);
    // Participants and guests get their own notes only, never the ones nobody owns (existing data).
    return owner ? owner === viewer.email : !restricted;
  });
}

async function appendBrainMemory(note, { owner = null } = {}) {
  const clean = [...String(note || '').trim()].slice(0, MAX_BRAIN_MEMORY_NOTE_LENGTH).join('');
  if (!clean) throw new Error('note fehlt');
  const cleanOwner = access.normalizeEmail(owner);

  return withLock('global-brain-memory', async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const entries = await readBrainMemory();
    const entry = { ts: new Date().toISOString(), note: clean };
    if (cleanOwner) entry.owner = cleanOwner;
    entries.push(entry);
    // The cap counts per owner: one person cannot push everybody else's notes out.
    const counts = new Map();
    const kept = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const key = access.normalizeEmail(entries[i].owner) || '';
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count <= MAX_BRAIN_MEMORY_ENTRIES) kept.push(entries[i]);
    }
    kept.reverse();
    await fsp.writeFile(`${BRAIN_MEMORY_FILE}.tmp`, JSON.stringify(kept, null, 2), 'utf8');
    await fsp.rename(`${BRAIN_MEMORY_FILE}.tmp`, BRAIN_MEMORY_FILE);
    return entry;
  });
}

// The project profile as a viewer may see it. In the local mode and for admins it is returned as stored. Otherwise
// the project memory only keeps notes without provenance (existing data, anonymous chats), the viewer's own notes
// and notes from chats the viewer may use (checked live, so sharing a chat later also shares its notes); the
// provenance fields themselves are removed.
//
// Participants and guests (lib/access.js) only see the profile of a project they created themselves (`ownsFolder`):
// guidelines, context brains, context files and brandings are maintained by admins and stay internal. Their memory
// holds their own notes only.
async function visibleFolderProfile(profile, viewer, { ownsFolder = false } = {}) {
  if (!profile || !viewer || !viewer.active || viewer.admin) return profile;
  if (access.isRestricted(viewer)) {
    const own = (Array.isArray(profile.memory) ? profile.memory : [])
      .filter((entry) => viewer.email && entry.owner === viewer.email)
      .map((entry) => ({ id: entry.id, note: entry.note, createdAt: entry.createdAt }));
    return ownsFolder
      ? { ...profile, memory: own }
      : { ...profile, guidelines: '', contextBrains: [], brandings: [], contextFiles: [], memory: own };
  }
  const memory = [];
  for (const entry of Array.isArray(profile.memory) ? profile.memory : []) {
    let visible = !entry.owner;
    if (!visible && viewer.email && entry.owner === viewer.email) visible = true;
    if (!visible && entry.sessionId) {
      try {
        visible = access.canUse(await readSessionAccess(entry.sessionId), viewer);
      } catch (_) {
        visible = false;
      }
    }
    if (visible) memory.push({ id: entry.id, note: entry.note, createdAt: entry.createdAt });
  }
  return { ...profile, memory };
}

/* ---------- ledger / assets ---------- */

function ledgerFile(sessionId) {
  return path.join(sessionAssetDir(sessionId), 'ledger.json');
}

async function readLedger(sessionId) {
  try {
    const raw = await fsp.readFile(ledgerFile(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function writeLedger(sessionId, entries) {
  const dir = sessionAssetDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const file = ledgerFile(sessionId);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(entries, null, 2), 'utf8');
  await fsp.rename(`${file}.tmp`, file);
}

function nextId(entries, kind) {
  const prefix = KIND_PREFIX[kind] || 'asset';
  const used = entries.filter((e) => e.kind === kind).length;
  let n = used + 1;
  const taken = new Set(entries.map((e) => e.id));
  while (taken.has(`${prefix}-${String(n).padStart(3, '0')}`)) n += 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

function assetUrl(sessionId, file) {
  return `/assets/${encodeURIComponent(sessionId)}/${encodeURIComponent(file)}`;
}

// Writes bytes to disk and registers the asset in the ledger.
async function saveAsset(sessionId, { kind, buffer, ext, prompt, cost }) {
  return withLock(sessionId, async () => {
    const entries = await readLedger(sessionId);
    const id = nextId(entries, kind);
    const file = `${id}${ext}`;
    const dir = sessionAssetDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, file), buffer);
    const entry = {
      id,
      file,
      kind,
      prompt: prompt || '',
      createdAt: new Date().toISOString(),
      cost: typeof cost === 'number' ? cost : null
    };
    entries.push(entry);
    await writeLedger(sessionId, entries);
    return { ...entry, url: assetUrl(sessionId, file) };
  });
}

// Reserves an asset id for an async job; the file arrives later.
async function reserveAsset(sessionId, { kind, ext, prompt }) {
  return withLock(sessionId, async () => {
    const entries = await readLedger(sessionId);
    const id = nextId(entries, kind);
    const file = `${id}${ext}`;
    const entry = {
      id,
      file,
      kind,
      prompt: prompt || '',
      createdAt: new Date().toISOString(),
      cost: null,
      pending: true
    };
    entries.push(entry);
    await writeLedger(sessionId, entries);
    return { ...entry, url: assetUrl(sessionId, file) };
  });
}

// Stores the bytes of a previously reserved asset.
async function completeAsset(sessionId, assetId, buffer, cost, ext) {
  return withLock(sessionId, async () => {
    const entries = await readLedger(sessionId);
    const entry = entries.find((e) => e.id === assetId);
    if (!entry) throw new Error(`Asset ${assetId} nicht im Ledger`);
    if (ext !== undefined) {
      const cleanExt = String(ext || '').toLowerCase();
      if (!/^\.[a-z0-9]{2,5}$/.test(cleanExt)) throw new Error('Ungueltige Asset-Dateiendung');
      entry.file = `${entry.id}${cleanExt}`;
    }
    const dir = sessionAssetDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, entry.file), buffer);
    delete entry.pending;
    if (typeof cost === 'number') entry.cost = cost;
    await writeLedger(sessionId, entries);
    return { ...entry, url: assetUrl(sessionId, entry.file) };
  });
}

// Moves a file produced inside the session asset directory into a reserved asset
// without loading large video bytes into memory. `ext` and `kind` are optional: they replace the reserved
// extension / kind when the real result differs (a fal.ai result whose type was not known when the asset was reserved).
async function completeAssetFile(sessionId, assetId, sourceFile, { cost, duration, ext, kind } = {}) {
  return withLock(sessionId, async () => {
    const entries = await readLedger(sessionId);
    const entry = entries.find((item) => item.id === assetId);
    if (!entry) throw new Error(`Asset ${assetId} nicht im Ledger`);
    if (ext !== undefined) {
      const cleanExt = String(ext || '').toLowerCase();
      if (!/^\.[a-z0-9]{2,5}$/.test(cleanExt)) throw new Error('Ungueltige Asset-Dateiendung');
      entry.file = `${entry.id}${cleanExt}`;
    }
    if (kind !== undefined) {
      if (!['image', 'video', 'audio'].includes(kind)) throw new Error('Ungueltige Asset-Art');
      entry.kind = kind;
    }
    const dir = sessionAssetDir(sessionId);
    const resolvedSource = path.resolve(sourceFile);
    const resolvedDir = `${path.resolve(dir)}${path.sep}`;
    if (!resolvedSource.startsWith(resolvedDir)) {
      throw new Error('Asset-Quelldatei muss im Session-Asset-Ordner liegen');
    }
    await fsp.rename(resolvedSource, path.join(dir, entry.file));
    delete entry.pending;
    if (typeof cost === 'number') entry.cost = cost;
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
      entry.duration = Math.round(Number(duration) * 1000) / 1000;
    }
    await writeLedger(sessionId, entries);
    return { ...entry, url: assetUrl(sessionId, entry.file) };
  });
}

async function assetDataUrl(sessionId, assetId) {
  const entries = await readLedger(sessionId);
  const entry = entries.find((e) => e.id === assetId);
  if (!entry) throw new Error(`Asset ${assetId} existiert nicht in dieser Session.`);
  if (entry.pending) throw new Error(`Asset ${assetId} ist noch nicht fertig.`);
  const ext = path.extname(entry.file).toLowerCase();
  const mime = EXT_MIME[ext] || 'application/octet-stream';
  let buf = await fsp.readFile(path.join(sessionAssetDir(sessionId), entry.file));
  const isoBrand = buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp'
    ? buf.subarray(8, Math.min(buf.length, 32)).toString('ascii')
    : '';
  const disguisedAvif = mime === 'image/png' && /avif|avis/.test(isoBrand);
  if (disguisedAvif || ['image/avif', 'image/heic', 'image/heif'].includes(mime)) {
    buf = await ffmpeg.convertImageBufferToPng(buf, { inputExtension: disguisedAvif ? '.avif' : ext });
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

module.exports = {
  ensureDirs,
  sameFolderName,
  isValidId,
  withLock,
  readSession,
  readSessionAccess,
  sessionStat,
  saveInlineImage,
  readInlineImage,
  writeSession,
  createSession,
  mutateSession,
  updateSessionMeta,
  updateSessionSharing,
  setSessionBrandings,
  addContextFile,
  removeContextFile,
  readContextFiles,
  addFolderContextFile,
  removeFolderContextFile,
  readFolderContextFiles,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  onFolderChange,
  readFolderProfile,
  writeFolderProfile,
  addFolderMemory,
  removeFolderMemory,
  listSessions,
  deleteSession,
  readBrainMemory,
  visibleFolderProfile,
  folderOwner,
  readFolderOwners,
  claimFolder,
  appendBrainMemory,
  readLedger,
  writeLedger,
  saveAsset,
  reserveAsset,
  completeAsset,
  completeAssetFile,
  assetDataUrl,
  assetUrl,
  sessionAssetDir
};
