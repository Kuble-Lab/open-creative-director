'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');
const store = require('./store');

const BRANDINGS_DIR = path.join(PATHS.root, 'data', 'brandings');
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_GUIDELINES_LENGTH = 8000;
const MAX_COUNTS = {
  colors: 40,
  typography: 40,
  logos: 40,
  sound: 40,
  formats: 40
};
const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.mp4', '.mov',
  '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.m4a', '.aac', '.pdf'
]);
const PATCH_FIELDS = new Set([
  'name', 'description', 'colors', 'typography', 'logos', 'imagery',
  'voice', 'speaker', 'motion', 'sound', 'formats', 'guidelines'
]);
// The speaker voice (WP38f): the ElevenLabs voice that speaks for the brand. Optional; a branding without the field stays valid
// (no migration). voiceId is what the speech nodes take as voice_id.
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SPEAKER_NAME = 200;
const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function brandingDir(id) {
  if (!store.isValidId(id)) throw new Error('Ungueltige Branding-ID');
  return path.join(BRANDINGS_DIR, id);
}

function brandingFile(id) {
  return path.join(brandingDir(id), 'branding.json');
}

function brandingAssetsDir(id) {
  return path.join(brandingDir(id), 'assets');
}

function notFoundError(id) {
  const err = new Error(`Branding nicht gefunden: ${id}`);
  err.code = 'BRANDING_NOT_FOUND';
  return err;
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

function characterLength(value) {
  return [...String(value)].length;
}

function validateObjectArray(branding, field) {
  const value = branding[field];
  if (!Array.isArray(value)) throw new TypeError(`${field} muss ein Array sein`);
  if (value.length > MAX_COUNTS[field]) {
    throw new Error(`${field} darf maximal ${MAX_COUNTS[field]} Eintraege enthalten`);
  }
  if (value.some((entry) => !isPlainObject(entry))) {
    throw new TypeError(`${field} darf nur Objekte enthalten`);
  }
}

// The speaker of a branding as it is stored: { voiceId, name } or null where there is none (null, undefined and an empty voiceId all
// mean "no voice"). Throws for anything else, so the file never holds a value the speech nodes could not use.
function normaliseSpeaker(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new TypeError('speaker muss ein Objekt { voiceId, name } oder null sein');
  for (const key of Object.keys(value)) {
    if (key !== 'voiceId' && key !== 'name') throw new Error(`Unbekanntes Feld in speaker: ${key}`);
  }
  if (value.voiceId === undefined || value.voiceId === null || (typeof value.voiceId === 'string' && !value.voiceId.trim())) return null;
  if (typeof value.voiceId !== 'string' || !VOICE_ID_PATTERN.test(value.voiceId.trim())) {
    throw new Error('speaker.voiceId muss eine ElevenLabs-Voice-ID sein (Buchstaben, Ziffern, - und _)');
  }
  if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') throw new TypeError('speaker.name muss ein String sein');
  const name = typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim() : '';
  if (characterLength(name) > MAX_SPEAKER_NAME) throw new Error(`speaker.name darf maximal ${MAX_SPEAKER_NAME} Zeichen lang sein`);
  return { voiceId: value.voiceId.trim(), name };
}

function validateBranding(branding) {
  if (!isPlainObject(branding)) throw new TypeError('Branding muss ein Objekt sein');
  if (typeof branding.name !== 'string' || !branding.name.trim()) {
    throw new Error('Branding-Name darf nicht leer sein');
  }
  if (typeof branding.description !== 'string') throw new TypeError('description muss ein String sein');

  for (const field of Object.keys(MAX_COUNTS)) validateObjectArray(branding, field);
  for (const color of branding.colors) {
    if (typeof color.hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color.hex)) {
      throw new Error(`Ungueltiger Farbwert: ${String(color.hex || '')}. Erwartet wird #RRGGBB`);
    }
  }

  if (!isPlainObject(branding.imagery)) throw new TypeError('imagery muss ein Objekt sein');
  if (!Array.isArray(branding.imagery.references)) {
    throw new TypeError('imagery.references muss ein Array sein');
  }
  if (!isPlainObject(branding.voice)) throw new TypeError('voice muss ein Objekt sein');
  normaliseSpeaker(branding.speaker);
  if (!isPlainObject(branding.motion)) throw new TypeError('motion muss ein Objekt sein');
  if (typeof branding.guidelines !== 'string') throw new TypeError('guidelines muss ein String sein');
  if (characterLength(branding.guidelines) > MAX_GUIDELINES_LENGTH) {
    throw new Error(`guidelines darf maximal ${MAX_GUIDELINES_LENGTH} Zeichen lang sein`);
  }
  return branding;
}

function makeEmptyBranding(id, name, description, now) {
  return {
    id,
    name: name.trim(),
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
    colors: [],
    typography: [],
    logos: [],
    imagery: { style: '', references: [] },
    voice: { tone: '', language: '', dos: '', donts: '' },
    motion: { outro: null, notes: '' },
    sound: [],
    formats: [],
    guidelines: ''
  };
}

async function listBrandings() {
  let entries;
  try {
    entries = await fsp.readdir(BRANDINGS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !store.isValidId(entry.name)) continue;
    try {
      const branding = await readBranding(entry.name);
      found.push({
        id: branding.id,
        name: branding.name,
        description: branding.description,
        updatedAt: branding.updatedAt,
        colors: branding.colors.map((color) => color.hex),
        ...(branding.speaker && branding.speaker.voiceId ? { speaker: { voiceId: branding.speaker.voiceId, name: branding.speaker.name || '' } } : {})
      });
    } catch (_) {
      // Defekte oder unvollstaendige Verzeichnisse erscheinen nicht in der Liste.
    }
  }
  return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// Loest eine Branding-Angabe tolerant auf: exakte ID zuerst, sonst eindeutiger Name
// (case-insensitiv). Der Director uebergibt erfahrungsgemaess gern den Namen statt der ID.
async function resolveBrandingId(idOrName) {
  const clean = String(idOrName || '').trim();
  if (!clean || /[\\/]|\.\./.test(clean)) throw notFoundError(idOrName);
  try {
    await fsp.access(brandingFile(clean));
    return clean;
  } catch (_) {
    /* kein direkter ID-Treffer - unten per Name suchen */
  }
  const all = await listBrandings();
  const matches = all.filter((b) => String(b.name).toLowerCase() === clean.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Mehrere Brandings heissen «${clean}» - bitte die ID verwenden: ${matches.map((m) => m.id).join(', ')}`);
  }
  const hint = all.length
    ? ` Verfuegbare Brandings: ${all.map((b) => `${b.name} (ID ${b.id})`).join(', ')}`
    : ' Es existiert noch kein Branding - zuerst create_branding aufrufen.';
  const err = new Error(`Branding nicht gefunden: ${clean}.${hint}`);
  err.code = 'BRANDING_NOT_FOUND';
  throw err;
}

async function readBranding(id) {
  let raw;
  try {
    raw = await fsp.readFile(brandingFile(id), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw notFoundError(id);
    throw err;
  }
  const branding = JSON.parse(raw);
  if (!isPlainObject(branding) || branding.id !== id) {
    throw new Error(`Branding-Datei ist ungueltig: ${id}`);
  }
  return branding;
}

async function createBranding({ name, description = '' } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Branding-Name darf nicht leer sein');
  if (typeof description !== 'string') throw new TypeError('description muss ein String sein');
  await fsp.mkdir(BRANDINGS_DIR, { recursive: true });

  let id;
  let dir;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    dir = brandingDir(id);
    if (!fs.existsSync(dir)) break;
  }
  const now = new Date().toISOString();
  const branding = makeEmptyBranding(id, name, description, now);
  validateBranding(branding);

  await store.withLock(`branding-${id}`, async () => {
    await fsp.mkdir(brandingAssetsDir(id), { recursive: true });
    await writeJsonAtomic(brandingFile(id), branding);
  });
  return branding;
}

async function updateBranding(id, patch) {
  if (!isPlainObject(patch)) throw new TypeError('patch muss ein Objekt sein');
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(field)) throw new Error(`Unbekanntes Branding-Feld: ${field}`);
  }

  return store.withLock(`branding-${id}`, async () => {
    const current = await readBranding(id);
    const next = { ...current };
    for (const field of Object.keys(patch)) next[field] = patch[field];
    // the speaker is kept in its clean form; "no voice" removes the field again (a branding without it is the plain old shape)
    if (Object.prototype.hasOwnProperty.call(patch, 'speaker')) {
      const speaker = normaliseSpeaker(patch.speaker);
      if (speaker) next.speaker = speaker;
      else delete next.speaker;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'name') && typeof patch.name === 'string') {
      next.name = patch.name.trim();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'description') && typeof patch.description === 'string') {
      next.description = patch.description.trim();
    }
    next.updatedAt = new Date().toISOString();
    validateBranding(next);
    await writeJsonAtomic(brandingFile(id), next);
    return next;
  });
}

async function deleteBranding(id) {
  return store.withLock(`branding-${id}`, async () => {
    await readBranding(id);
    await fsp.rm(brandingDir(id), { recursive: true, force: true });
  });
}

function sanitiseAssetFilename(filename) {
  const original = path.basename(String(filename || '').trim());
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) {
    throw new Error(`Dateityp nicht erlaubt: ${ext || 'ohne Endung'}`);
  }
  const rawStem = path.basename(original, path.extname(original));
  const stem = rawStem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 170) || 'asset';
  return `${stem}${ext}`;
}

function requireSafeAssetFilename(filename) {
  const clean = String(filename || '');
  if (!clean || path.basename(clean) !== clean || !SAFE_ASSET_FILENAME.test(clean)) {
    throw new Error('Ungueltiger Branding-Dateiname');
  }
  const ext = path.extname(clean).toLowerCase();
  if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) throw new Error(`Dateityp nicht erlaubt: ${ext || 'ohne Endung'}`);
  return clean;
}

async function saveBrandingAsset(id, { buffer, filename } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Asset-Daten muessen als Buffer vorliegen');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('Branding-Asset darf maximal 50 MB gross sein');
  const baseFilename = sanitiseAssetFilename(filename);

  return store.withLock(`branding-${id}`, async () => {
    await readBranding(id);
    const dir = brandingAssetsDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(baseFilename);
    const stem = path.basename(baseFilename, ext);
    let uniqueFilename = baseFilename;
    let number = 2;
    while (fs.existsSync(path.join(dir, uniqueFilename))) {
      uniqueFilename = `${stem}-${number}${ext}`;
      number += 1;
    }
    const target = path.join(dir, uniqueFilename);
    const tmp = `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, target);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return { filename: uniqueFilename, file: `assets/${uniqueFilename}`, size: buffer.length };
  });
}

async function removeBrandingAsset(id, filename) {
  const clean = requireSafeAssetFilename(filename);
  return store.withLock(`branding-${id}`, async () => {
    await readBranding(id);
    const target = path.join(brandingAssetsDir(id), clean);
    try {
      await fsp.unlink(target);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Branding-Asset nicht gefunden: ${clean}`);
      throw err;
    }
  });
}

async function readBrandingAsset(id, filename) {
  const clean = requireSafeAssetFilename(filename);
  await readBranding(id);
  try {
    return await fsp.readFile(path.join(brandingAssetsDir(id), clean));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Branding-Asset nicht gefunden: ${clean}`);
    throw err;
  }
}

function valueOrDash(value) {
  const clean = typeof value === 'string' ? value.trim() : '';
  return clean || '-';
}

function fileNameFromReference(reference) {
  return path.basename(String(reference || ''));
}

async function brandingSummary(id) {
  const branding = await readBranding(id);
  const lines = [`# Brand system: ${branding.name}`];
  lines.push('', `Branding-ID: \`${branding.id}\` — diese ID als \`branding_id\` in allen Branding-Tools verwenden (update_branding, add_branding_asset, import_branding_asset).`);
  if (branding.description) lines.push('', branding.description);

  if (branding.colors.length) {
    lines.push('', '## Farben');
    for (const color of branding.colors) {
      const label = [color.role, color.name].filter(Boolean).join(' / ') || 'Farbe';
      lines.push(`- ${label}: ${color.hex}${color.usage ? ` — ${color.usage}` : ''}`);
    }
  }
  if (branding.typography.length) {
    lines.push('', '## Typografie');
    for (const font of branding.typography) {
      const inventory = font.file ? `; Datei ${fileNameFromReference(font.file)}` : '';
      lines.push(`- ${valueOrDash(font.role)}: ${valueOrDash(font.family)} (${valueOrDash(font.weights)}, ${valueOrDash(font.source)}${inventory})${font.usage ? ` — ${font.usage}` : ''}`);
    }
  }
  if (branding.logos.length) {
    lines.push('', '## Logo-Inventar');
    for (const logo of branding.logos) {
      lines.push(`- ${valueOrDash(logo.variant)}: ${fileNameFromReference(logo.file)}${logo.usage ? ` — ${logo.usage}` : ''}`);
    }
  }
  if (branding.imagery.style || branding.imagery.references.length) {
    lines.push('', '## Bildwelt');
    if (branding.imagery.style) lines.push(branding.imagery.style);
    if (branding.imagery.references.length) {
      lines.push(`Referenzen: ${branding.imagery.references.map(fileNameFromReference).join(', ')}`);
    }
  }
  if (Object.values(branding.voice).some((value) => typeof value === 'string' && value.trim())) {
    lines.push('', '## Voice und Tonalitaet');
    lines.push(`- Ton: ${valueOrDash(branding.voice.tone)}`);
    lines.push(`- Sprache: ${valueOrDash(branding.voice.language)}`);
    lines.push(`- Dos: ${valueOrDash(branding.voice.dos)}`);
    lines.push(`- Don'ts: ${valueOrDash(branding.voice.donts)}`);
  }
  if (branding.speaker && branding.speaker.voiceId) {
    lines.push('', '## Sprecherstimme');
    lines.push(`- Stimme: ${branding.speaker.name ? `${branding.speaker.name} ` : ''}(ElevenLabs-Voice-ID \`${branding.speaker.voiceId}\`)`);
  }
  if (branding.motion.outro || branding.motion.notes) {
    lines.push('', '## Motion');
    lines.push(`- Outro: ${branding.motion.outro ? fileNameFromReference(branding.motion.outro) : '-'}`);
    if (branding.motion.notes) lines.push(`- Hinweise: ${branding.motion.notes}`);
  }
  if (branding.sound.length) {
    lines.push('', '## Sound-Inventar');
    for (const sound of branding.sound) {
      lines.push(`- ${valueOrDash(sound.title)}: ${fileNameFromReference(sound.file)} (${valueOrDash(sound.usage)})`);
    }
  }
  if (branding.formats.length) {
    lines.push('', '## Formate');
    for (const format of branding.formats) {
      lines.push(`- ${valueOrDash(format.name)}: ${valueOrDash(format.aspect_ratio)}${format.notes ? ` — ${format.notes}` : ''}`);
    }
  }
  if (branding.guidelines) {
    const shortened = characterLength(branding.guidelines) > 3000
      ? `${[...branding.guidelines].slice(0, 3000).join('')}\n\n[Guidelines gekuerzt]`
      : branding.guidelines;
    lines.push('', '## Guidelines', '', shortened);
  }
  return lines.join('\n');
}

module.exports = {
  BRANDINGS_DIR,
  MAX_ASSET_BYTES,
  ALLOWED_ASSET_EXTENSIONS,
  brandingAssetsDir,
  listBrandings,
  resolveBrandingId,
  readBranding,
  normaliseSpeaker,
  createBranding,
  updateBranding,
  deleteBranding,
  saveBrandingAsset,
  removeBrandingAsset,
  readBrandingAsset,
  sanitiseAssetFilename,
  brandingSummary
};
