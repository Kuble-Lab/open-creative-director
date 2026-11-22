'use strict';

// The AI influencers of the app: a figure with an identity text, reference images, a voice and a style that workflows take through the
// node input.influencer (lib/nodes/nodes-influencer.js). Stored as data/influencers/<id>/influencer.json plus assets/.
//
// Every signed-in creator owns their influencers, including admins, at most MAX_OWNED_INFLUENCERS. Legacy entries without an
// owner remain available to unrestricted viewers. An explicitly open influencer is usable by any confirmed person, but only
// its owner and admins may change it. Making one needs confirmation that it shows no real person without consent (`consent`).
//
// Claudia (lib/music-video-hud/figures.js) comes with the app as an example: id "claudia", not stored in data/, visible to everybody,
// read-only, not counted. Her text is read from the HUD template, so figureText(claudia) is that template's figure text, byte for byte.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { PATHS } = require('./config');
const store = require('./store');
const access = require('./access');
const brandings = require('./brandings');
const figuresLib = require('./music-video-hud/figures');

const INFLUENCERS_DIR = path.join(PATHS.root, 'data', 'influencers');
const MAX_OWNED_INFLUENCERS = 10;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 6;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TEXT_LIMITS = { name: 60, tagline: 300, full: 1500, short: 400, looks: 1000, face: 400, never: 400, credit: 200, style: 1000 };
const PATCH_FIELDS = new Set([...Object.keys(TEXT_LIMITS), 'voice', 'open', 'claim']);
const FIGURE_FIELDS = ['name', 'full', 'short', 'looks', 'face', 'never', 'credit'];
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function inputError(message, code = 'INFLUENCER_INVALID') {
  return Object.assign(new Error(message), { code });
}
const notFoundError = (id) => inputError(`Influencer nicht gefunden: ${id}`, 'INFLUENCER_NOT_FOUND');
function assertWritable(id) {
  if (id === 'claudia') throw inputError('Claudia ist eine eingebaute Figur und kann nicht geaendert werden. Lege eine Kopie an.', 'INFLUENCER_READONLY');
}
function influencerDir(id) {
  if (!store.isValidId(id)) throw inputError('Ungueltige Influencer-ID');
  return path.join(INFLUENCERS_DIR, id);
}
const influencerFile = (id) => path.join(influencerDir(id), 'influencer.json');
function influencerAssetsDir(id) {
  return id === 'claudia' ? path.dirname(figuresLib.referenceFiles(id)[0].path) : path.join(influencerDir(id), 'assets');
}
async function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, contents);
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
const writeInfluencer = (value) => {
  const { siteUrl, ...stored } = value;
  return writeAtomic(influencerFile(value.id), `${JSON.stringify(stored, null, 2)}\n`);
};
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function cleanText(value, field, max, singleLine = false) {
  if (typeof value !== 'string') throw inputError(`${field} muss ein String sein`);
  const clean = singleLine ? squash(value) : value.trim();
  if ((field === 'name' || field === 'full') && !clean) throw inputError(`${field} darf nicht leer sein`);
  if ([...clean].length > max) throw inputError(`${field} darf maximal ${max} Zeichen lang sein`);
  return clean;
}
function normaliseVoice(value) {
  if (value === null || value === undefined) return { voiceId: '', name: '', description: '' };
  if (!isObject(value)) throw inputError('voice muss ein Objekt sein');
  for (const field of Object.keys(value)) {
    if (!['voiceId', 'name', 'description'].includes(field)) throw inputError(`Unbekanntes Feld in voice: ${field}`);
  }
  let speaker;
  try {
    speaker = brandings.normaliseSpeaker({ voiceId: value.voiceId });
  } catch (err) {
    throw inputError(err.message.replace(/speaker/g, 'voice'));
  }
  return {
    voiceId: speaker?.voiceId || '',
    name: cleanText(value.name === undefined ? '' : value.name, 'voice.name', 80, true),
    description: cleanText(value.description === undefined ? '' : value.description, 'voice.description', 400)
  };
}
function cleanFields(data, partial = false) {
  if (!isObject(data)) throw inputError('Influencer muss ein Objekt sein');
  const result = {};
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (partial && !Object.prototype.hasOwnProperty.call(data, field)) continue;
    result[field] = cleanText(data[field] === undefined && !['name', 'full'].includes(field) ? '' : data[field], field, max, ['name', 'tagline', 'credit'].includes(field));
  }
  if (!partial || Object.prototype.hasOwnProperty.call(data, 'voice')) result.voice = normaliseVoice(data.voice);
  return result;
}

// Keep the example tied to the template so its identity cannot drift between entry points.
const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'nodes/templates/music-video-hud.json'), 'utf8'));
const templateFigure = template.graph.nodes.find((node) => node.id === 'n4').params.figure;
const templateFields = Object.fromEntries(templateFigure.split('\n').map((line) => {
  const colon = line.indexOf(':');
  return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
}));
function builtinClaudia() {
  const source = figuresLib.FIGURES.claudia;
  return {
    id: source.id, ...cleanFields({ ...templateFields, name: source.name, full: source.full, credit: source.credit }),
    images: figuresLib.referenceFiles('claudia').map((image) => image.file),
    consent: null, owner: null, open: false, createdAt: null, updatedAt: null, builtin: true, siteUrl: null
  };
}
function ownerOf(influencer) { return access.normalizeEmail(influencer && influencer.owner) || null; }
function visibleTo(influencer, viewer) {
  if (influencer.id === 'claudia' || !viewer || !viewer.active || viewer.admin) return true;
  const owner = ownerOf(influencer);
  if (!owner) return !access.isRestricted(viewer) || Boolean(influencer.open === true && viewer.email && !access.isUnconfirmed(viewer));
  return Boolean(viewer.email && (owner === viewer.email || (influencer.open === true && !access.isUnconfirmed(viewer))));
}
function editableBy(influencer, viewer) {
  if (influencer.id === 'claudia') return false;
  if (!viewer || !viewer.active || viewer.admin) return true;
  const owner = ownerOf(influencer);
  return Boolean(owner && viewer.email && owner === viewer.email);
}
function ownerForNew(viewer) {
  if (!viewer || !viewer.active) return null;
  const email = access.normalizeEmail(viewer.email);
  if (!email) throw inputError('Ohne Anmeldung kann kein Influencer angelegt werden.', 'INFLUENCER_FORBIDDEN');
  return email;
}
function claimableBy(influencer, viewer) {
  return Boolean(viewer?.active && viewer.admin && access.normalizeEmail(viewer.email)
    && store.isValidId(influencer.id) && influencer.id !== 'claudia' && !ownerOf(influencer));
}
async function readInfluencer(id) {
  if (id === 'claudia') return builtinClaudia();
  let raw;
  try { raw = await fsp.readFile(influencerFile(id), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw notFoundError(id);
    throw err;
  }
  const influencer = JSON.parse(raw);
  if (!isObject(influencer) || influencer.id !== id || typeof influencer.name !== 'string') throw inputError(`Influencer-Datei ist ungueltig: ${id}`);
  // a file edited by hand must not name files outside assets/ or break the list
  influencer.images = Array.isArray(influencer.images)
    ? influencer.images.filter((file) => typeof file === 'string' && path.basename(file) === file).slice(0, MAX_IMAGES)
    : [];
  return { ...influencer, open: influencer.open === true, siteUrl: influencer.site?.url || null };
}
async function readVisibleInfluencer(id, viewer) {
  const influencer = await readInfluencer(id);
  if (!visibleTo(influencer, viewer)) throw notFoundError(id);
  return influencer;
}
async function readEditableInfluencer(id, viewer) {
  const influencer = await readVisibleInfluencer(id, viewer);
  assertWritable(id);
  if (!editableBy(influencer, viewer)) throw inputError(ownerOf(influencer)
    ? `Der Influencer «${influencer.name}» gehoert jemand anderem und ist nur zum Verwenden freigegeben. Lege eine Kopie an.`
    : `Der Influencer «${influencer.name}» gilt fuer alle und kann nur von Admins geaendert werden. Lege einen eigenen Influencer an oder bitte einen Admin.`, 'INFLUENCER_FORBIDDEN');
  return influencer;
}
function influencerSummary(influencer, { viewer = null } = {}) {
  const owner = ownerOf(influencer);
  return {
    id: influencer.id, name: influencer.name, tagline: influencer.tagline, open: influencer.open === true,
    portrait: influencer.images[0] || null, imageCount: influencer.images.length, siteUrl: influencer.site?.url || null,
    hasVoice: Boolean(influencer.voice?.voiceId), updatedAt: influencer.updatedAt, builtin: influencer.id === 'claudia',
    ...(viewer ? { editable: editableBy(influencer, viewer), own: Boolean(owner && viewer.email && owner === viewer.email), claimable: claimableBy(influencer, viewer),
      ...(owner && (!viewer.active || viewer.admin) ? { owner } : {}) } : {})
  };
}
async function storedInfluencers() {
  let entries;
  try { entries = await fsp.readdir(INFLUENCERS_DIR, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'claudia' || !store.isValidId(entry.name)) continue;
    try { found.push(await readInfluencer(entry.name)); } catch (_) {
      // Incomplete directories must not hide the remaining collection.
    }
  }
  return found;
}
async function listInfluencers({ viewer = null } = {}) {
  const found = (await storedInfluencers()).filter((entry) => visibleTo(entry, viewer));
  found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return [builtinClaudia(), ...found].map((entry) => influencerSummary(entry, { viewer }));
}
async function countOwnedBy(email) {
  const clean = access.normalizeEmail(email);
  return clean ? (await storedInfluencers()).filter((entry) => ownerOf(entry) === clean).length : 0;
}
async function resolveInfluencerId(idOrName, { viewer = null } = {}) {
  const clean = String(idOrName || '').trim();
  if (!clean || /[\\/]|\.\./.test(clean)) throw notFoundError(idOrName);
  if (store.isValidId(clean)) {
    try { await readVisibleInfluencer(clean, viewer); return clean; } catch (err) {
      if (err.code !== 'INFLUENCER_NOT_FOUND') throw err;
    }
  }
  const matches = (await listInfluencers({ viewer })).filter((entry) => entry.name.toLowerCase() === clean.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw inputError(`Mehrere Influencer heissen «${clean}» - bitte die ID verwenden: ${matches.map((entry) => entry.id).join(', ')}`);
  throw notFoundError(clean);
}
async function createInfluencer(data = {}, options = {}) {
  if (!isObject(data)) throw inputError('Influencer muss ein Objekt sein');
  const consent = options.consent === undefined ? data.consent : options.consent;
  if (consent !== true) throw inputError('Bitte bestaetige, dass die Figur keine reale Person ohne deren Einwilligung zeigt.', 'INFLUENCER_CONSENT_REQUIRED');
  const fields = cleanFields(data);
  const viewer = options.viewer;
  const creator = viewer !== undefined ? viewer?.email : options.by ?? data.by ?? options.owner ?? data.owner;
  const requestedOwner = Object.prototype.hasOwnProperty.call(options, 'owner') ? options.owner : data.owner;
  const owner = viewer !== undefined ? ownerForNew(viewer) : access.normalizeEmail(requestedOwner) || null;
  if (viewer === undefined && requestedOwner && !owner) throw inputError('owner muss eine E-Mail-Adresse sein');
  return store.withLock(`influencer-owner-${owner || 'shared'}`, async () => {
    if (owner && await countOwnedBy(owner) >= MAX_OWNED_INFLUENCERS) throw inputError(`Du hast bereits ${MAX_OWNED_INFLUENCERS} eigene Influencer. Loesche zuerst einen, den du nicht mehr brauchst.`, 'INFLUENCER_LIMIT');
    const id = `inf-${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const influencer = { id, ...fields, open: false, images: [], consent: { confirmedAt: now, by: access.normalizeEmail(creator) || '' }, owner, createdAt: now, updatedAt: now };
    await fsp.mkdir(influencerAssetsDir(id), { recursive: true });
    try { await writeInfluencer(influencer); } catch (err) {
      await fsp.rm(influencerDir(id), { recursive: true, force: true });
      throw err;
    }
    return { ...influencer, siteUrl: null };
  });
}
async function updateInfluencer(id, patch, { viewer } = {}) {
  assertWritable(id);
  if (!isObject(patch)) throw inputError('patch muss ein Objekt sein');
  for (const field of Object.keys(patch)) if (!PATCH_FIELDS.has(field)) throw inputError(`Unbekanntes Influencer-Feld: ${field}`);
  const fields = cleanFields(patch, true);
  if (Object.prototype.hasOwnProperty.call(patch, 'open')) {
    if (typeof patch.open !== 'boolean') throw inputError('open muss true oder false sein');
    fields.open = patch.open;
  }
  const claim = Object.prototype.hasOwnProperty.call(patch, 'claim');
  if (claim && patch.claim !== true) throw inputError('claim muss true sein');
  if (claim && !(viewer?.active && viewer.admin && access.normalizeEmail(viewer.email))) {
    throw inputError('Nur angemeldete Admins koennen einen Influencer uebernehmen.', 'INFLUENCER_FORBIDDEN');
  }
  const update = () => store.withLock(`influencer-${id}`, async () => {
    const current = await readInfluencer(id);
    if (claim && ownerOf(current)) throw inputError('Dieser Influencer hat bereits einen Besitzer.', 'INFLUENCER_OWNED');
    if (claim && await countOwnedBy(viewer.email) >= MAX_OWNED_INFLUENCERS) throw inputError(`Du hast bereits ${MAX_OWNED_INFLUENCERS} eigene Influencer. Loesche zuerst einen, den du nicht mehr brauchst.`, 'INFLUENCER_LIMIT');
    const next = { ...current, ...fields, ...(claim ? { owner: ownerForNew(viewer) } : {}), updatedAt: new Date().toISOString() };
    await writeInfluencer(next);
    return next;
  });
  // Use the creator's lock before the record lock, so claims and new copies share the same ownership limit.
  return claim ? store.withLock(`influencer-owner-${ownerForNew(viewer)}`, update) : update();
}
async function deleteInfluencer(id) {
  assertWritable(id);
  return store.withLock(`influencer-${id}`, async () => {
    await readInfluencer(id);
    await fsp.rm(influencerDir(id), { recursive: true, force: true });
  });
}
function imageKind(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return '.jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
}
function safeFilename(filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename) || !IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) throw inputError('Ungueltiger Influencer-Dateiname');
  return filename;
}
async function saveInfluencerImage(id, { filename, buffer } = {}) {
  assertWritable(id);
  if (!Buffer.isBuffer(buffer)) throw inputError('Bilddaten muessen als Buffer vorliegen', 'INFLUENCER_IMAGE_INVALID');
  if (buffer.length > MAX_IMAGE_BYTES) throw inputError('Ein Bild darf maximal 15 MB gross sein', 'INFLUENCER_IMAGE_TOO_LARGE');
  const ext = path.extname(String(filename || '')).toLowerCase();
  const kind = imageKind(buffer);
  if (!IMAGE_EXTENSIONS.has(ext) || !kind || (ext === '.jpeg' ? '.jpg' : ext) !== kind) throw inputError('Das Bild muss PNG, JPEG oder WebP sein und zur Dateiendung passen.', 'INFLUENCER_IMAGE_INVALID');
  const stem = path.basename(String(filename), path.extname(String(filename))).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bild';
  return store.withLock(`influencer-${id}`, async () => {
    const current = await readInfluencer(id);
    if (current.images.length >= MAX_IMAGES) throw inputError(`Pro Influencer sind maximal ${MAX_IMAGES} Bilder erlaubt`);
    const dir = influencerAssetsDir(id);
    await fsp.mkdir(dir, { recursive: true });
    let stored = `${stem}${ext}`;
    let suffix = 2;
    while (current.images.includes(stored) || fs.existsSync(path.join(dir, stored))) stored = `${stem}-${suffix++}${ext}`;
    const target = path.join(dir, stored);
    await writeAtomic(target, buffer);
    const next = { ...current, images: [...current.images, stored], updatedAt: new Date().toISOString() };
    try { await writeInfluencer(next); } catch (err) {
      await fsp.rm(target, { force: true });
      throw err;
    }
    return next;
  });
}
async function removeInfluencerImage(id, filename) {
  assertWritable(id);
  const clean = safeFilename(filename);
  return store.withLock(`influencer-${id}`, async () => {
    const current = await readInfluencer(id);
    if (!current.images.includes(clean)) throw notFoundError(clean);
    const next = { ...current, images: current.images.filter((file) => file !== clean), updatedAt: new Date().toISOString() };
    await writeInfluencer(next);
    await fsp.rm(path.join(influencerAssetsDir(id), clean), { force: true });
    return next;
  });
}
async function readInfluencerAsset(id, filename) {
  const clean = safeFilename(filename);
  const influencer = await readInfluencer(id);
  if (!influencer.images.includes(clean)) throw notFoundError(clean);
  try { return await fsp.readFile(path.join(influencerAssetsDir(id), clean)); } catch (err) {
    if (err.code === 'ENOENT') throw notFoundError(clean);
    throw err;
  }
}
function figureText(influencer) {
  return FIGURE_FIELDS.filter((field) => squash(influencer[field])).map((field) => `${field.toUpperCase()}: ${squash(influencer[field])}`).join('\n');
}
async function duplicateInfluencer(id, options = {}) {
  const source = await readVisibleInfluencer(id, options.viewer);
  // Leave room for the suffix even when the original name reaches the limit.
  const name = `${[...source.name].slice(0, 52).join('')} (Kopie)`;
  let copy = await createInfluencer({ ...cleanFields(source), name }, { ...options, consent: options.consent, owner: options.owner ?? ownerForNew(options.viewer) });
  try {
    for (const filename of source.images) copy = await saveInfluencerImage(copy.id, { filename, buffer: await readInfluencerAsset(id, filename) });
    return copy;
  } catch (err) {
    await deleteInfluencer(copy.id);
    throw err;
  }
}

module.exports = {
  INFLUENCERS_DIR, MAX_OWNED_INFLUENCERS, MAX_IMAGE_BYTES, MAX_IMAGES, IMAGE_EXTENSIONS,
  ownerOf, visibleTo, editableBy, ownerForNew, readVisibleInfluencer, readEditableInfluencer,
  listInfluencers, resolveInfluencerId, countOwnedBy, readInfluencer, createInfluencer,
  updateInfluencer, deleteInfluencer, saveInfluencerImage, removeInfluencerImage,
  readInfluencerAsset, writeInfluencer, influencerDir, influencerAssetsDir, influencerSummary, figureText, duplicateInfluencer
};
