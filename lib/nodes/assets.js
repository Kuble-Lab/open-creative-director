'use strict';

// Value <-> ledger helpers for the node view (SPEC §6.1, §9.5). All assets live in the
// ledger of the workflow's backing session; values only reference them.

const fsp = require('fs/promises');
const path = require('path');

const store = require('../store');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
// 3D models are GLB only and only ever produced by a node (no upload makes one, see typeFromExtension).
const MODEL_EXTS = new Set(['.glb']);
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'model3d']);
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

// Media type of an UPLOADED file. A .glb is deliberately not known here: nobody can upload a 3D model.
function typeFromExtension(ext) {
  const clean = String(ext || '').toLowerCase();
  if (IMAGE_EXTS.has(clean)) return 'image';
  if (VIDEO_EXTS.has(clean)) return 'video';
  if (AUDIO_EXTS.has(clean)) return 'audio';
  return null;
}

function isSafeFilename(file) {
  return typeof file === 'string' && file !== '' && path.basename(file) === file && SAFE_FILE.test(file);
}

// Media type of a ledger entry: kind image/video/audio/model3d, or an upload classified by extension.
// Returns null for anything that is not usable as a port value (e.g. SVG uploads, text files).
function typeFromLedgerEntry(entry) {
  if (!entry) return null;
  if (MEDIA_KINDS.has(entry.kind)) return entry.kind;
  if (entry.kind === 'upload') return typeFromExtension(path.extname(String(entry.file || '')));
  return null;
}

// Builds a typed value from a ledger entry. Throws for pending or unsupported assets.
function valueFromLedgerEntry(sessionId, entry) {
  if (!entry) throw new Error('Asset not found');
  if (entry.pending) throw new Error(`Asset ${entry.id} is not finished yet`);
  const file = String(entry.file || '');
  if (!isSafeFilename(file)) throw new Error(`Asset ${entry.id} has an invalid file name`);
  const type = typeFromLedgerEntry(entry);
  if (type === 'model3d' && !MODEL_EXTS.has(path.extname(file).toLowerCase())) {
    throw new Error(`Asset ${entry.id} is not a GLB file`);
  }
  if (!type) {
    if (path.extname(file).toLowerCase() === '.svg') {
      throw new Error(`Asset ${entry.id} is an SVG; use the PNG variant of the image instead`);
    }
    throw new Error(`Asset ${entry.id} has an unsupported type`);
  }
  const value = { type, sessionId, assetId: entry.id, file, url: store.assetUrl(sessionId, file) };
  if (Number.isFinite(entry.duration) && entry.duration > 0) value.duration = entry.duration;
  return value;
}

async function valueFromAsset(sessionId, assetId) {
  const ledger = await store.readLedger(sessionId);
  const entry = ledger.find((item) => item.id === assetId);
  if (!entry) throw new Error(`Asset ${assetId} does not exist in this workflow`);
  return valueFromLedgerEntry(sessionId, entry);
}

// All finished, usable media assets of a session as values (asset picker "this workflow").
async function listSessionAssets(sessionId) {
  const ledger = await store.readLedger(sessionId);
  const values = [];
  for (const entry of ledger) {
    if (entry.pending) continue;
    try {
      values.push({ ...valueFromLedgerEntry(sessionId, entry), prompt: entry.prompt || '', createdAt: entry.createdAt });
    } catch (_) {
      /* skip assets that cannot be port values */
    }
  }
  return values;
}

// Absolute path of the file behind a media value; the file must stay inside the session asset dir.
function assetFilePath(value) {
  if (!value || typeof value.sessionId !== 'string' || !isSafeFilename(value.file)) {
    throw new Error('Value does not reference a stored asset file');
  }
  return path.join(store.sessionAssetDir(value.sessionId), value.file);
}

// Reads { sessionId?, assetId } out of an `asset` param (upload responses carry more fields).
// Returns null when unset or marked missing.
function assetRefFromParam(param, defaultSessionId) {
  if (!param || typeof param !== 'object' || Array.isArray(param)) return null;
  if (param.missing === true) return null;
  if (typeof param.assetId !== 'string' || !store.isValidId(param.assetId)) return null;
  const sessionId = typeof param.sessionId === 'string' && param.sessionId ? param.sessionId : defaultSessionId;
  if (!store.isValidId(sessionId)) return null;
  return { sessionId, assetId: param.assetId };
}

// Resolves an `asset` param of an input node to a value of the expected type inside the backing session.
async function resolveAssetParam(param, sessionId, expectedType) {
  if (param && typeof param === 'object' && param.missing === true) {
    throw new Error('Asset is missing (imported workflow); upload it again');
  }
  const ref = assetRefFromParam(param, sessionId);
  if (!ref) throw new Error('No asset selected');
  if (ref.sessionId !== sessionId) {
    throw new Error('Asset belongs to another workflow; upload or import it again');
  }
  const value = await valueFromAsset(sessionId, ref.assetId);
  if (expectedType && value.type !== expectedType) {
    throw new Error(`Asset ${ref.assetId} is ${value.type}, expected ${expectedType}`);
  }
  return value;
}

/* ---------- writing assets ---------- */

async function createScratchDir(sessionId, prefix = '.nodes-') {
  const dir = store.sessionAssetDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  return fsp.mkdtemp(path.join(dir, prefix));
}

async function removeScratchDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

async function ensureInsideAssetDir(sessionId, sourceFile) {
  const root = `${path.resolve(store.sessionAssetDir(sessionId))}${path.sep}`;
  if (!path.resolve(sourceFile).startsWith(root)) {
    throw new Error('Source file must be inside the session asset directory');
  }
}

// Registers a finished local file (already inside the session asset dir) as a ledger asset.
// Same reserve + completeAssetFile pattern as runConcatVideos in lib/tools.js.
async function saveOutputFile(sessionId, { kind, ext, sourceFile, prompt = '', cost = null, duration } = {}) {
  if (!MEDIA_KINDS.has(kind)) throw new Error(`Unsupported output kind ${kind}`);
  const cleanExt = String(ext || '').toLowerCase();
  if (!/^\.[a-z0-9]{2,5}$/.test(cleanExt)) throw new Error('Invalid output file extension');
  await ensureInsideAssetDir(sessionId, sourceFile);
  const reserved = await store.reserveAsset(sessionId, { kind, ext: cleanExt, prompt });
  try {
    const entry = await store.completeAssetFile(sessionId, reserved.id, sourceFile, {
      cost: typeof cost === 'number' ? cost : undefined,
      duration
    });
    return valueFromLedgerEntry(sessionId, entry);
  } catch (err) {
    await removeReserved(sessionId, reserved.id);
    throw err;
  }
}

// Stores an uploaded temp file (inside the session asset dir) as an `upload` ledger asset.
// SVG and other unsupported extensions are rejected; the caller maps that to HTTP 415.
async function saveUploadFile(sessionId, { sourceFile, ext, name = '' } = {}) {
  const cleanExt = String(ext || '').toLowerCase();
  if (!typeFromExtension(cleanExt)) {
    const err = new Error(cleanExt === '.svg' ? 'SVG uploads are not supported yet; upload a PNG instead' : `Unsupported file type ${cleanExt || '(none)'}`);
    err.code = 'UNSUPPORTED_MEDIA';
    throw err;
  }
  await ensureInsideAssetDir(sessionId, sourceFile);
  const reserved = await store.reserveAsset(sessionId, { kind: 'upload', ext: cleanExt, prompt: String(name || '').slice(0, 200) });
  try {
    const entry = await store.completeAssetFile(sessionId, reserved.id, sourceFile);
    return valueFromLedgerEntry(sessionId, entry);
  } catch (err) {
    await removeReserved(sessionId, reserved.id);
    throw err;
  }
}

// Copies a finished asset between sessions (chat -> workflow, workflow -> duplicate). Keeps the kind.
async function copyAsset(fromSessionId, assetId, toSessionId) {
  const ledger = await store.readLedger(fromSessionId);
  const entry = ledger.find((item) => item.id === assetId);
  if (!entry) throw new Error(`Asset ${assetId} does not exist in session ${fromSessionId}`);
  if (entry.pending) throw new Error(`Asset ${assetId} is not finished yet`);
  if (!isSafeFilename(entry.file)) throw new Error(`Asset ${assetId} has an invalid file name`);
  const type = typeFromLedgerEntry(entry);
  if (!type) throw new Error(`Asset ${assetId} cannot be used as media`);
  const source = path.join(store.sessionAssetDir(fromSessionId), entry.file);
  const scratch = await createScratchDir(toSessionId, '.import-');
  let reserved = null;
  try {
    const temp = path.join(scratch, entry.file);
    await fsp.copyFile(source, temp);
    reserved = await store.reserveAsset(toSessionId, {
      kind: entry.kind,
      ext: path.extname(entry.file).toLowerCase(),
      prompt: entry.prompt || ''
    });
    const copied = await store.completeAssetFile(toSessionId, reserved.id, temp, { duration: entry.duration });
    return valueFromLedgerEntry(toSessionId, copied);
  } catch (err) {
    if (reserved) await removeReserved(toSessionId, reserved.id);
    throw err;
  } finally {
    await removeScratchDir(scratch);
  }
}

async function removeReserved(sessionId, assetId) {
  try {
    await store.withLock(sessionId, async () => {
      const entries = await store.readLedger(sessionId);
      await store.writeLedger(sessionId, entries.filter((entry) => entry.id !== assetId));
    });
  } catch (_) {
    /* best effort cleanup */
  }
}

// Sum of the ledger costs of the given assets; null when none of them carries a cost.
async function ledgerCosts(sessionId, assetIds) {
  const ledger = await store.readLedger(sessionId);
  let total = null;
  for (const id of assetIds) {
    const entry = ledger.find((item) => item.id === id);
    if (entry && typeof entry.cost === 'number') total = (total || 0) + entry.cost;
  }
  return total;
}

module.exports = {
  MODEL_EXTS,
  typeFromExtension,
  typeFromLedgerEntry,
  valueFromLedgerEntry,
  valueFromAsset,
  listSessionAssets,
  assetFilePath,
  assetRefFromParam,
  resolveAssetParam,
  createScratchDir,
  removeScratchDir,
  saveOutputFile,
  saveUploadFile,
  copyAsset,
  ledgerCosts
};
