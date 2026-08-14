'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');
const store = require('./store');

const CAST_DIR = path.join(PATHS.root, 'data', 'cast');
const MAX_MEMBERS = 12;
const MAX_IMAGES = 6;
const MAX_NAME_LENGTH = 60;
const MAX_SOUL_LENGTH = 2000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VOICE_EXTENSIONS = new Set(['.mp4', '.mp3', '.wav']);

function memberDir(id) {
  if (!store.isValidId(id)) throw new Error('Ungueltige Cast-ID');
  return path.join(CAST_DIR, id);
}

function memberFile(id) {
  return path.join(memberDir(id), 'member.json');
}

function memberAssetsDir(id) {
  return path.join(memberDir(id), 'assets');
}

function cleanText(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} muss ein String sein`);
  const clean = value.trim();
  if (required && !clean) throw new Error(`${field} darf nicht leer sein`);
  if ([...clean].length > maxLength) throw new Error(`${field} darf maximal ${maxLength} Zeichen lang sein`);
  return clean;
}

function cleanAssetFilename(filename, fallback, ext) {
  const stem = path.basename(String(filename || ''), path.extname(String(filename || '')))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
  return `${stem}${ext}`;
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

async function readMember(id) {
  let raw;
  try {
    raw = await fsp.readFile(memberFile(id), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const missing = new Error(`Cast-Mitglied nicht gefunden: ${id}`);
      missing.code = 'CAST_NOT_FOUND';
      throw missing;
    }
    throw err;
  }
  const member = JSON.parse(raw);
  if (!member || member.id !== id || typeof member.name !== 'string' || typeof member.soul !== 'string') {
    throw new Error(`Cast-Datei ist ungueltig: ${id}`);
  }
  member.images = Array.isArray(member.images)
    ? member.images.filter((file) => typeof file === 'string' && path.basename(file) === file).slice(0, MAX_IMAGES)
    : [];
  member.voice = typeof member.voice === 'string' && path.basename(member.voice) === member.voice ? member.voice : null;
  return member;
}

async function createMember(folderName, { name, soul = '' }) {
  const cleanName = cleanText(name, 'Name', MAX_NAME_LENGTH, { required: true });
  const cleanSoul = cleanText(soul, 'Soul', MAX_SOUL_LENGTH);
  const profile = await store.readFolderProfile(folderName);
  const castIds = Array.isArray(profile?.cast) ? profile.cast : [];
  if (castIds.length >= MAX_MEMBERS) {
    throw new Error(`Pro Projekt sind maximal ${MAX_MEMBERS} Cast-Mitglieder erlaubt`);
  }

  const id = `cast-${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  const member = { id, name: cleanName, soul: cleanSoul, images: [], voice: null, createdAt: now, updatedAt: now };
  await fsp.mkdir(memberAssetsDir(id), { recursive: true });
  try {
    await writeJsonAtomic(memberFile(id), member);
    await store.writeFolderProfile(folderName, {
      guidelines: profile?.guidelines || '',
      contextBrains: profile?.contextBrains || [],
      brandings: profile?.brandings || [],
      cast: [...castIds, id]
    });
    return member;
  } catch (err) {
    await fsp.rm(memberDir(id), { recursive: true, force: true });
    throw err;
  }
}

async function updateMember(id, patch = {}) {
  const member = await readMember(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Patch muss ein Objekt sein');
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    member.name = cleanText(patch.name, 'Name', MAX_NAME_LENGTH, { required: true });
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'soul')) {
    member.soul = cleanText(patch.soul, 'Soul', MAX_SOUL_LENGTH);
  }
  member.updatedAt = new Date().toISOString();
  await writeJsonAtomic(memberFile(id), member);
  return member;
}

async function uniqueImageFilename(id, requested) {
  const member = await readMember(id);
  const ext = path.extname(requested).toLowerCase();
  const stem = path.basename(requested, ext);
  let candidate = requested;
  let suffix = 2;
  while (member.images.includes(candidate)) {
    candidate = `${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  return candidate;
}

async function addMemberAsset(id, { kind, sourcePath, filename }) {
  if (kind !== 'image' && kind !== 'voice') throw new Error('kind muss image oder voice sein');
  const member = await readMember(id);
  const ext = path.extname(String(filename || sourcePath || '')).toLowerCase();
  const allowed = kind === 'image' ? IMAGE_EXTENSIONS : VOICE_EXTENSIONS;
  if (!allowed.has(ext)) {
    throw new Error(kind === 'image'
      ? 'Cast-Bilder muessen PNG, JPEG oder WebP sein'
      : 'Cast-Stimmen muessen MP4, MP3 oder WAV sein');
  }
  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile()) throw new Error('Cast-Quelle ist keine Datei');
  if (kind === 'image' && member.images.length >= MAX_IMAGES) {
    throw new Error(`Pro Cast-Mitglied sind maximal ${MAX_IMAGES} Bilder erlaubt`);
  }

  await fsp.mkdir(memberAssetsDir(id), { recursive: true });
  if (kind === 'voice') {
    const stored = `voice-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await fsp.copyFile(sourcePath, path.join(memberAssetsDir(id), stored));
    const previous = member.voice;
    member.voice = stored;
    member.updatedAt = new Date().toISOString();
    try {
      await writeJsonAtomic(memberFile(id), member);
      if (previous && previous !== stored) await fsp.rm(path.join(memberAssetsDir(id), previous), { force: true });
    } catch (err) {
      await fsp.rm(path.join(memberAssetsDir(id), stored), { force: true });
      throw err;
    }
    return member;
  }

  const requested = cleanAssetFilename(filename, 'bild', ext);
  const stored = await uniqueImageFilename(id, requested);
  await fsp.copyFile(sourcePath, path.join(memberAssetsDir(id), stored));
  member.images.push(stored);
  member.updatedAt = new Date().toISOString();
  try {
    await writeJsonAtomic(memberFile(id), member);
  } catch (err) {
    await fsp.rm(path.join(memberAssetsDir(id), stored), { force: true });
    throw err;
  }
  return member;
}

async function listMembers(folderName) {
  const profile = await store.readFolderProfile(folderName);
  const members = [];
  for (const id of profile?.cast || []) {
    try {
      members.push(await readMember(id));
    } catch (err) {
      if (err.code !== 'CAST_NOT_FOUND') throw err;
    }
  }
  return members;
}

async function resolveMemberId(folderName, idOrName) {
  const clean = String(idOrName || '').trim();
  if (!clean || /[\\/]|\.\./.test(clean)) throw new Error('Cast-Mitglied fehlt oder ist ungueltig');
  const members = await listMembers(folderName);
  const direct = members.find((member) => member.id === clean);
  if (direct) return direct.id;
  const matches = members.filter((member) => member.name.toLowerCase() === clean.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Mehrere Cast-Mitglieder heissen «${clean}» - bitte die ID verwenden: ${matches.map((m) => m.id).join(', ')}`);
  }
  const hint = members.length
    ? ` Verfuegbar: ${members.map((member) => `${member.name} (ID ${member.id})`).join(', ')}`
    : ' Dieses Projekt hat noch keine Cast-Mitglieder.';
  const err = new Error(`Cast-Mitglied nicht gefunden: ${clean}.${hint}`);
  err.code = 'CAST_NOT_FOUND';
  throw err;
}

async function readMemberAsset(id, filename) {
  const member = await readMember(id);
  const clean = path.basename(String(filename || ''));
  if (!clean || clean !== filename || (!member.images.includes(clean) && member.voice !== clean)) {
    throw new Error(`Cast-Datei nicht gefunden: ${filename}`);
  }
  return fsp.readFile(path.join(memberAssetsDir(id), clean));
}

async function removeMember(id) {
  try {
    await readMember(id);
  } catch (err) {
    if (err.code === 'CAST_NOT_FOUND') return false;
    throw err;
  }
  const folders = await store.listFolders();
  for (const folder of folders) {
    const profile = await store.readFolderProfile(folder);
    if (!profile?.cast?.includes(id)) continue;
    await store.writeFolderProfile(folder, {
      guidelines: profile.guidelines,
      contextBrains: profile.contextBrains,
      brandings: profile.brandings,
      cast: profile.cast.filter((memberId) => memberId !== id)
    });
  }
  await fsp.rm(memberDir(id), { recursive: true, force: true });
  return true;
}

module.exports = {
  CAST_DIR,
  MAX_MEMBERS,
  MAX_IMAGES,
  IMAGE_EXTENSIONS,
  VOICE_EXTENSIONS,
  createMember,
  updateMember,
  addMemberAsset,
  removeMember,
  listMembers,
  readMember,
  resolveMemberId,
  readMemberAsset,
  memberAssetsDir
};
