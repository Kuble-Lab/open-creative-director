'use strict';

const path = require('path');
const yauzl = require('yauzl');

const brandings = require('./brandings');

const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_COLORS = 24;
const MAX_LOGOS = 12;
const MAX_IMAGERY = 12;
const MAX_GUIDELINES_LENGTH = 8000;
const RELEVANT_EXTENSIONS = new Set([
  '.css', '.json', '.md', '.markdown', '.html', '.htm',
  '.woff', '.woff2', '.ttf', '.otf',
  '.svg', '.png', '.jpg', '.jpeg', '.webp'
]);
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const GENERIC_FONT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset'
]);

class BrandingImportError extends Error {
  constructor(message, { status = 400, code = 'BRANDING_IMPORT_INVALID' } = {}) {
    super(message);
    this.name = 'BrandingImportError';
    this.status = status;
    this.code = code;
  }
}

function assertZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BrandingImportError('Die ZIP-Datei ist leer.');
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new BrandingImportError('Das ZIP darf maximal 80 MB gross sein.', {
      status: 413,
      code: 'BRANDING_IMPORT_ZIP_TOO_LARGE'
    });
  }
  const signature = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  if (![0x04034b50, 0x06054b50, 0x08074b50].includes(signature)) {
    throw new BrandingImportError('Die Datei ist kein gueltiges ZIP-Archiv.');
  }
}

function safeEntryPath(rawName) {
  const raw = String(rawName || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null;
  if (raw.split('/').includes('..')) return null;
  const normalised = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalised || normalised === '.' || normalised.startsWith('../')) return null;
  return normalised;
}

function isSymlink(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: false,
      validateEntrySizes: true
    }, (err, zipFile) => {
      if (err) reject(new BrandingImportError(`Das ZIP konnte nicht gelesen werden: ${err.message}`));
      else resolve(zipFile);
    });
  });
}

function readEntryBuffer(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= entry.uncompressedSize) chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error('Die entpackte Dateigroesse stimmt nicht mit den ZIP-Metadaten ueberein'));
        } else {
          resolve(Buffer.concat(chunks, bytes));
        }
      });
    });
  });
}

async function readRelevantEntries(buffer) {
  assertZipBuffer(buffer);
  const zipFile = await openZip(buffer);
  if (zipFile.entryCount > MAX_ENTRIES) {
    zipFile.close();
    throw new BrandingImportError(`Das ZIP enthaelt mehr als ${MAX_ENTRIES} Eintraege.`, {
      status: 413,
      code: 'BRANDING_IMPORT_TOO_MANY_ENTRIES'
    });
  }

  return new Promise((resolve, reject) => {
    const files = [];
    const relevant = [];
    let rejected = 0;
    let uncompressedBytes = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { zipFile.close(); } catch (_) { /* bereits geschlossen */ }
      if (err instanceof BrandingImportError) reject(err);
      else reject(new BrandingImportError(`Das ZIP konnte nicht vollstaendig gelesen werden: ${err.message}`));
    };

    zipFile.on('error', fail);
    zipFile.on('entry', async (entry) => {
      if (settled) return;
      const decodedName = Buffer.isBuffer(entry.fileName)
        ? entry.fileName.toString('utf8')
        : String(entry.fileName || '');
      const cleanPath = safeEntryPath(decodedName);
      const directory = decodedName.endsWith('/');
      if (!directory) {
        uncompressedBytes += Number(entry.uncompressedSize) || 0;
        if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
          fail(new BrandingImportError('Das ZIP waere entpackt groesser als 200 MB.', {
            status: 413,
            code: 'BRANDING_IMPORT_UNCOMPRESSED_TOO_LARGE'
          }));
          return;
        }
      }
      if (directory) {
        zipFile.readEntry();
        return;
      }
      if (!cleanPath || isSymlink(entry)) {
        rejected += 1;
        zipFile.readEntry();
        return;
      }

      const ext = path.extname(cleanPath).toLowerCase();
      files.push(cleanPath);
      if (!RELEVANT_EXTENSIONS.has(ext)) {
        zipFile.readEntry();
        return;
      }
      try {
        const data = await readEntryBuffer(zipFile, entry);
        relevant.push({ path: cleanPath, ext, buffer: data });
      } catch (_) {
        rejected += 1;
      }
      zipFile.readEntry();
    });
    zipFile.on('end', () => {
      if (settled) return;
      settled = true;
      if (!files.length && !rejected) {
        reject(new BrandingImportError('Das ZIP enthaelt keine Dateien.'));
      } else {
        resolve({ files, relevant, rejected });
      }
    });
    zipFile.readEntry();
  });
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => clampByte(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function normaliseColor(value) {
  const clean = String(value || '').trim();
  const hex = clean.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3 || raw.length === 4) {
      return `#${raw.slice(0, 3).split('').map((part) => part + part).join('').toUpperCase()}`;
    }
    if (raw.length === 6 || raw.length === 8) return `#${raw.slice(0, 6).toUpperCase()}`;
  }

  const rgb = clean.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) {
      const channels = parts.map((part) => part.endsWith('%')
        ? Number.parseFloat(part) * 2.55
        : Number.parseFloat(part));
      if (channels.every(Number.isFinite)) return rgbToHex(...channels);
    }
  }

  const hsl = clean.match(/^hsla?\(([^)]+)\)$/i);
  if (hsl) {
    const parts = hsl[1].split(/[\s,\/]+/).filter(Boolean);
    const hue = Number.parseFloat(parts[0]);
    const saturation = Number.parseFloat(parts[1]) / 100;
    const lightness = Number.parseFloat(parts[2]) / 100;
    if (Number.isFinite(hue) && Number.isFinite(saturation) && Number.isFinite(lightness)) {
      const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
      const sector = ((hue % 360) + 360) % 360 / 60;
      const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
      let rgbPrime = [0, 0, 0];
      if (sector < 1) rgbPrime = [chroma, intermediate, 0];
      else if (sector < 2) rgbPrime = [intermediate, chroma, 0];
      else if (sector < 3) rgbPrime = [0, chroma, intermediate];
      else if (sector < 4) rgbPrime = [0, intermediate, chroma];
      else if (sector < 5) rgbPrime = [intermediate, 0, chroma];
      else rgbPrime = [chroma, 0, intermediate];
      const match = lightness - chroma / 2;
      return rgbToHex(...rgbPrime.map((channel) => (channel + match) * 255));
    }
  }
  return null;
}

function colorRole(rawName) {
  const name = String(rawName || '').toLowerCase().replace(/^--/, '');
  if (/primary|brand-main|main-color/.test(name)) return 'primary';
  if (/secondary/.test(name)) return 'secondary';
  if (/accent|highlight/.test(name)) return 'accent';
  if (/background|\bbg\b|canvas/.test(name)) return 'background';
  if (/surface|panel|card/.test(name)) return 'surface';
  if (/foreground|text|ink/.test(name)) return 'text';
  if (/success|positive/.test(name)) return 'success';
  if (/warning|caution/.test(name)) return 'warning';
  if (/danger|error|negative/.test(name)) return 'error';
  return name.replace(/^color[-_.]?/, '').replace(/[_.]+/g, '-').replace(/^-+|-+$/g, '') || 'additional';
}

function colorPriority(role) {
  const priorities = {
    primary: 0,
    secondary: 1,
    accent: 2,
    background: 3,
    surface: 4,
    text: 5,
    success: 6,
    warning: 7,
    error: 8
  };
  return Object.prototype.hasOwnProperty.call(priorities, role) ? priorities[role] : 20;
}

function addColor(found, { rawName, value, source }) {
  const hex = normaliseColor(value);
  if (!hex) return false;
  const role = colorRole(rawName);
  const candidate = {
    role,
    name: String(rawName || '').replace(/^--/, '').replace(/[_.-]+/g, ' ').trim() || role,
    hex,
    usage: `Importiert aus ${source}`,
    priority: colorPriority(role)
  };
  const existing = found.get(hex);
  if (!existing || candidate.priority < existing.priority) found.set(hex, candidate);
  return true;
}

function scanCss(entry, colors, families) {
  const css = entry.buffer.toString('utf8');
  let contributed = false;
  const colorPattern = /(--[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^;})]+\)|hsla?\([^;})]+\))/gi;
  for (const match of css.matchAll(colorPattern)) {
    contributed = addColor(colors, { rawName: match[1], value: match[2], source: entry.path }) || contributed;
  }

  const familyPattern = /font-family\s*:\s*([^;}]+)/gi;
  for (const match of css.matchAll(familyPattern)) {
    const candidates = match[1].split(',');
    for (const candidate of candidates) {
      const family = candidate.trim().replace(/^['"]|['"]$/g, '');
      const lower = family.toLowerCase();
      if (!family || lower.startsWith('var(') || GENERIC_FONT_FAMILIES.has(lower)) continue;
      if (!families.some((item) => item.family.toLowerCase() === lower) && families.length < 2) {
        families.push({ family, sourcePath: entry.path });
        contributed = true;
      }
      break;
    }
  }
  return contributed;
}

function scanTokenJson(entry, colors) {
  let parsed;
  try {
    parsed = JSON.parse(entry.buffer.toString('utf8'));
  } catch (_) {
    return false;
  }
  let contributed = false;
  const walk = (value, keyPath, colorContext) => {
    if (typeof value === 'string') {
      if (colorContext && /^#[0-9a-f]{3,8}$/i.test(value.trim())) {
        contributed = addColor(colors, {
          rawName: keyPath.filter((key) => !key.startsWith('$')).join('-'),
          value,
          source: entry.path
        }) || contributed;
      }
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const typedColor = String(value.$type || value.type || '').toLowerCase() === 'color';
    for (const [key, child] of Object.entries(value)) {
      if (key === '$type' || key === 'type') continue;
      walk(child, [...keyPath, key], colorContext || typedColor || /colou?r/i.test(key));
    }
  };
  walk(parsed, [], false);
  return contributed;
}

function markdownTitle(entry) {
  const match = entry.buffer.toString('utf8').match(/^\s*#\s+(.+?)\s*$/m);
  return match ? match[1].replace(/[*_`]/g, '').trim() : '';
}

function manifestName(entries) {
  const candidates = entries.filter((entry) => /(^|\/)(?:_ds_)?manifest\.json$/i.test(entry.path));
  for (const entry of candidates) {
    try {
      const parsed = JSON.parse(entry.buffer.toString('utf8'));
      const value = parsed.name || parsed.title || parsed.designSystem?.name || parsed.design_system?.name;
      if (typeof value === 'string' && value.trim()) return { name: value.trim(), path: entry.path };
    } catch (_) {
      /* Ungueltige optionale Manifeste werden uebersprungen. */
    }
  }
  return null;
}

function imageDimensions(entry) {
  const buffer = entry.buffer;
  if (entry.ext === '.png' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ((entry.ext === '.jpg' || entry.ext === '.jpeg') && buffer.length > 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  if (entry.ext === '.svg') {
    const svg = buffer.toString('utf8', 0, Math.min(buffer.length, 20000));
    const viewBox = svg.match(/viewBox\s*=\s*["']\s*[-+0-9.e]+[\s,]+[-+0-9.e]+[\s,]+([-+0-9.e]+)[\s,]+([-+0-9.e]+)\s*["']/i);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    const width = svg.match(/\bwidth\s*=\s*["']([0-9.]+)/i);
    const height = svg.match(/\bheight\s*=\s*["']([0-9.]+)/i);
    if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  }
  return null;
}

function isLogoPath(filePath) {
  return /(logo|brand|wordmark|logomark|mark|icon)/i.test(filePath);
}

function isImageryCandidate(entry) {
  if (/(^|\/)(assets?|images?|imagery)(\/|$)/i.test(entry.path)) return true;
  const dimensions = imageDimensions(entry);
  return Boolean(dimensions && (dimensions.width >= 200 || dimensions.height >= 200));
}

function fontDetails(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const weightMatch = stem.match(/(?:^|[-_])(thin|extralight|light|regular|medium|semibold|bold|extrabold|black|[1-9]00)(?:$|[-_])/i);
  const family = stem
    .replace(/[-_](thin|extralight|light|regular|medium|semibold|bold|extrabold|black|italic|[1-9]00).*$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || stem;
  return { family, weights: weightMatch ? weightMatch[1] : '' };
}

function comparableFontName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function logoVariant(filePath, index) {
  const lower = filePath.toLowerCase();
  for (const variant of ['wordmark', 'logomark', 'dark', 'light', 'mono', 'icon']) {
    if (lower.includes(variant)) return variant;
  }
  return index === 0 ? 'primary' : 'alternate';
}

function archiveDefaultName(filename) {
  const base = path.basename(String(filename || 'Design-System'), path.extname(String(filename || '')));
  return base.replace(/[_-]+/g, ' ').trim() || 'Importiertes Design-System';
}

async function uniqueImportName(requestedName) {
  const base = [...String(requestedName || '').trim()].slice(0, 120).join('') || 'Importiertes Design-System';
  const existing = new Set((await brandings.listBrandings()).map((item) => item.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  const imported = `${base} (Import)`;
  if (!existing.has(imported.toLowerCase())) return imported;
  let number = 2;
  while (existing.has(`${base} (Import ${number})`.toLowerCase())) number += 1;
  return `${base} (Import ${number})`;
}

async function rasteriseSvg(buffer) {
  const { Resvg } = require('@resvg/resvg-js');
  return new Resvg(buffer.toString('utf8'), {
    fitTo: { mode: 'width', value: 1024 }
  }).render().asPng();
}

async function importBrandingZip({ buffer, filename = '', name = '' } = {}) {
  const archive = await readRelevantEntries(buffer);
  const usedPaths = new Set();
  const colorsByHex = new Map();
  const cssFamilies = [];

  for (const entry of archive.relevant) {
    if (entry.ext === '.css' && scanCss(entry, colorsByHex, cssFamilies)) usedPaths.add(entry.path);
    if (entry.ext === '.json' && scanTokenJson(entry, colorsByHex)) usedPaths.add(entry.path);
  }

  const colors = [...colorsByHex.values()]
    .sort((left, right) => left.priority - right.priority)
    .slice(0, MAX_COLORS)
    .map(({ priority, ...color }) => color);
  const fontEntries = archive.relevant.filter((entry) => FONT_EXTENSIONS.has(entry.ext));
  const images = archive.relevant.filter((entry) => IMAGE_EXTENSIONS.has(entry.ext));
  const logoEntries = images.filter((entry) => isLogoPath(entry.path)).slice(0, MAX_LOGOS);
  const logoPaths = new Set(logoEntries.map((entry) => entry.path));
  const imageryEntries = images
    .filter((entry) => !logoPaths.has(entry.path) && isImageryCandidate(entry))
    .slice(0, MAX_IMAGERY);
  const markdownEntries = archive.relevant
    .filter((entry) => entry.ext === '.md' || entry.ext === '.markdown')
    .sort((left, right) => {
      const score = (entry) => (/readme/i.test(path.basename(entry.path)) ? 1000000 : /guideline/i.test(entry.path) ? 500000 : 0) + entry.buffer.length;
      return score(right) - score(left);
    });
  const guidelineEntry = markdownEntries[0] || null;
  const fullGuidelines = guidelineEntry ? guidelineEntry.buffer.toString('utf8').trim() : '';
  const guidelines = [...fullGuidelines].slice(0, MAX_GUIDELINES_LENGTH).join('');

  const recognisedCount = colors.length + cssFamilies.length + fontEntries.length +
    logoEntries.length + imageryEntries.length + (guidelines ? 1 : 0);
  if (!recognisedCount) {
    throw new BrandingImportError(
      'Im ZIP wurden keine Farben, Schriften, Logos, Bildwelt-Referenzen oder Guidelines erkannt.'
    );
  }

  const manifest = manifestName(archive.relevant);
  const readmeTitleEntry = markdownEntries.find((entry) => markdownTitle(entry));
  const readmeName = readmeTitleEntry ? markdownTitle(readmeTitleEntry) : '';
  const selectedName = name.trim() || manifest?.name || readmeName || archiveDefaultName(filename);
  if (!name.trim() && manifest?.name) usedPaths.add(manifest.path);
  if (!name.trim() && !manifest?.name && readmeName) usedPaths.add(readmeTitleEntry.path);
  if (guidelineEntry && guidelines) usedPaths.add(guidelineEntry.path);
  const brandingName = await uniqueImportName(selectedName);
  let branding = null;
  let svgRasterFailures = 0;

  try {
    branding = await brandings.createBranding({
      name: brandingName,
      description: filename ? `Importiert aus ${path.basename(filename)}.` : 'Importiert aus einem Design-System-ZIP.'
    });

    const typography = cssFamilies.map((candidate, index) => ({
      role: index === 0 ? 'heading' : 'body',
      family: candidate.family,
      weights: '',
      source: 'system',
      file: null,
      usage: `Aus ${candidate.sourcePath} erkannt`
    }));
    for (const family of cssFamilies) usedPaths.add(family.sourcePath);

    for (const entry of fontEntries) {
      const saved = await brandings.saveBrandingAsset(branding.id, {
        buffer: entry.buffer,
        filename: path.basename(entry.path)
      });
      usedPaths.add(entry.path);
      const details = fontDetails(entry.path);
      const comparable = comparableFontName(details.family);
      const match = typography.find((item) => !item.file && (
        comparableFontName(item.family).includes(comparable) || comparable.includes(comparableFontName(item.family))
      ));
      if (match) {
        match.file = saved.file;
        match.source = 'upload';
        match.weights = details.weights;
      } else {
        typography.push({
          role: typography.length === 0 ? 'heading' : typography.length === 1 ? 'body' : 'brand',
          family: details.family,
          weights: details.weights,
          source: 'upload',
          file: saved.file,
          usage: `Importiert aus ${entry.path}`
        });
      }
    }

    const logos = [];
    for (const [index, entry] of logoEntries.entries()) {
      const saved = await brandings.saveBrandingAsset(branding.id, {
        buffer: entry.buffer,
        filename: path.basename(entry.path)
      });
      usedPaths.add(entry.path);
      let usage = `Importiert aus ${entry.path}`;
      if (entry.ext === '.svg') {
        try {
          const png = await rasteriseSvg(entry.buffer);
          const preview = await brandings.saveBrandingAsset(branding.id, {
            buffer: png,
            filename: `${path.basename(entry.path, entry.ext)}-preview.png`
          });
          usage += `; PNG-Vorschau: ${preview.file}`;
        } catch (_) {
          svgRasterFailures += 1;
        }
      }
      logos.push({ variant: logoVariant(entry.path, index), file: saved.file, usage });
    }

    const imageryReferences = [];
    for (const entry of imageryEntries) {
      const saved = await brandings.saveBrandingAsset(branding.id, {
        buffer: entry.buffer,
        filename: path.basename(entry.path)
      });
      usedPaths.add(entry.path);
      imageryReferences.push(saved.file);
    }

    branding = await brandings.updateBranding(branding.id, {
      colors,
      typography,
      logos,
      imagery: { style: '', references: imageryReferences },
      guidelines
    });

    const skipped = archive.rejected + archive.files.filter((filePath) => !usedPaths.has(filePath)).length;
    return {
      brandingId: branding.id,
      name: branding.name,
      report: {
        colors: colors.length,
        fonts: typography.length,
        logos: logoEntries.length,
        imagery: imageryReferences.length,
        guidelines: Boolean(guidelines),
        guidelinesTruncated: [...fullGuidelines].length > MAX_GUIDELINES_LENGTH,
        skipped,
        svgRasterFailures
      }
    };
  } catch (err) {
    if (branding?.id) await brandings.deleteBranding(branding.id).catch(() => {});
    throw err;
  }
}

module.exports = {
  MAX_ZIP_BYTES,
  MAX_ENTRIES,
  MAX_UNCOMPRESSED_BYTES,
  BrandingImportError,
  importBrandingZip,
  normaliseColor,
  safeEntryPath
};
