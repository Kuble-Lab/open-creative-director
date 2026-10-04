'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS, publicBaseUrl } = require('./config');
const store = require('./store');

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PUBLIC_REF_PATTERN = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

function safeRefFilename(file) {
  const name = path.basename(String(file || ''));
  return PUBLIC_REF_PATTERN.test(name) ? name : null;
}

async function cleanupRefs(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const age = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs)) : DEFAULT_MAX_AGE_MS;
  let entries;
  try {
    entries = await fsp.readdir(PATHS.publicRefsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  const cutoff = Date.now() - age;
  let removed = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !safeRefFilename(entry.name)) return;
    const file = path.join(PATHS.publicRefsDir, entry.name);
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs <= cutoff) {
        await fsp.rm(file, { force: true });
        removed += 1;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }));
  return removed;
}

async function publishAsset(sessionId, assetId) {
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
  }
  if (!store.isValidId(sessionId)) {
    throw new Error('Ungueltige Session- oder Asset-ID');
  }
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) {
    throw new Error('Ungueltige Session- oder Asset-ID');
  }

  await cleanupRefs();
  const ledger = await store.readLedger(sessionId);
  const asset = ledger.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`Asset ${assetId} existiert nicht in dieser Session.`);
  if (asset.pending) throw new Error(`Asset ${assetId} ist noch nicht fertig.`);
  const ext = path.extname(asset.file).toLowerCase();
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) {
    throw new Error(`Asset ${assetId} hat keine veroeffentlichbare Dateiendung.`);
  }

  const file = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  await fsp.mkdir(PATHS.publicRefsDir, { recursive: true });
  await fsp.copyFile(path.join(store.sessionAssetDir(sessionId), asset.file), path.join(PATHS.publicRefsDir, file));
  return { url: `${baseUrl}/refs/${file}`, file };
}

// Publishes a file that a node made itself in a scratch folder of the session (a cut of a video): the same copy into the public
// folder as publishAsset, for a file that is no ledger asset. The file must lie inside the asset folder of THIS session.
async function publishFile(sessionId, sourceFile) {
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
  }
  if (!store.isValidId(sessionId)) throw new Error('Ungueltige Session-ID');
  const root = `${path.resolve(store.sessionAssetDir(sessionId))}${path.sep}`;
  const resolved = path.resolve(String(sourceFile || ''));
  if (!resolved.startsWith(root)) throw new Error('Die Datei liegt nicht im Asset-Ordner dieser Session.');
  const stat = await fsp.lstat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Die Datei fehlt.');
  const ext = path.extname(resolved).toLowerCase();
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) throw new Error('Die Datei hat keine veroeffentlichbare Dateiendung.');
  await cleanupRefs();
  const file = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  await fsp.mkdir(PATHS.publicRefsDir, { recursive: true });
  await fsp.copyFile(resolved, path.join(PATHS.publicRefsDir, file));
  return { url: `${baseUrl}/refs/${file}`, file };
}

async function removeRef(file) {
  const name = safeRefFilename(file);
  if (!name) return false;
  try {
    await fsp.rm(path.join(PATHS.publicRefsDir, name));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  PUBLIC_REF_PATTERN,
  publishAsset,
  publishFile,
  cleanupRefs,
  removeRef,
  safeRefFilename
};
