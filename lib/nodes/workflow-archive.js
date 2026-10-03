'use strict';

// Workflow archives: a workflow together with its input files as one ZIP.
//
//   planExport(workflow)       which input files of a workflow go into the ZIP (and which stay missing)
//   describeExport(plan)       size figures for the dialog before the download
//   prepareImport(file, ...)   checks a received ZIP completely and unpacks the listed files into a staging
//                              folder; nothing of the workflow exists yet when this throws
//
// Layout of the ZIP:
//   workflow.json   the export document of the JSON export plus `files`, the directory of the input files:
//                   [{ node, param: 'asset' | 'assets', index?, path, type, name, size }]
//                   An input whose file is not part of the ZIP is listed with `missing: true` and no `path`.
//   files/NNN-name.ext   one file per distinct asset (never results, only the inputs of the nodes)
//
// Reading is defensive: only entries named in the directory are read, paths with `..`, absolute paths, links,
// encrypted and duplicate entries are refused, the unpacked size is counted while unpacking (the sizes in the
// ZIP are not trusted) and nothing is held in memory except workflow.json (2 MB at most).
//
// Errors carry a stable `code` (INVALID_ARCHIVE, INVALID_WORKFLOW, TOO_LARGE, TOO_MANY_FILES,
// UNSUPPORTED_MEDIA), a more precise `reason`, `params` for the message and a German sentence as `message`
// (the client translates by code and reason).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const yauzl = require('yauzl');
const zlib = require('zlib');

const sessionStore = require('../store');
const assetsLib = require('./assets');
const workflowsStore = require('./workflows-store');
const { isPlainObject } = require('./types');

const MB = 1024 * 1024;
const WORKFLOW_ENTRY = 'workflow.json';
const FILES_DIR = 'files';
const MAX_NAME_LENGTH = 200;
const MAX_DIRECTORY_ITEMS = 2000;
const MAX_PATH_LENGTH = 400;
const EXTRA_ENTRIES = 50; // folder entries and the like that sit beside the files
const ZIP_OVERHEAD_PER_FILE = 160; // local header, data descriptor and central directory entry, roughly

const MAX_FILE_BYTES = 500 * MB;

const DEFAULT_LIMITS = Object.freeze({
  maxZipBytes: 500 * MB,
  maxFileBytes: MAX_FILE_BYTES,
  maxSvgBytes: 10 * MB,
  maxUnpackedBytes: 2 * MAX_FILE_BYTES,
  maxFiles: 200,
  maxWorkflowBytes: workflowsStore.LIMITS.maxDocumentBytes,
  // A deflated file that grows by more than this factor is refused (media hardly compress, and the export stores
  // them as they are); files up to `ratioFloorBytes` unpacked are exempt, the sum limit covers those.
  maxRatio: 100,
  ratioFloorBytes: 1 * MB
});

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function archiveError(code, message, { reason, params } = {}) {
  const err = new Error(message);
  err.code = code;
  if (reason) err.reason = reason;
  if (params) err.params = params;
  return err;
}

const invalidArchive = (reason, message, params) => archiveError('INVALID_ARCHIVE', message, { reason, params });

const limitMb = (bytes) => Math.max(1, Math.round(bytes / MB));

function tooLarge(reason, bytes) {
  const mb = reason === 'workflow' ? limitMb(workflowsStore.LIMITS.maxDocumentBytes) : limitMb(bytes);
  const sentence = {
    archive: `Das ZIP ist grösser als ${mb} MB.`,
    file: `Eine Datei im ZIP ist grösser als ${mb} MB.`,
    unpacked: `Das ZIP wäre entpackt grösser als ${mb} MB.`,
    workflow: `Die Datei workflow.json ist grösser als ${mb} MB.`,
    svg: `Eine SVG-Datei im ZIP ist grösser als ${mb} MB.`
  }[reason];
  return archiveError('TOO_LARGE', sentence, { reason, params: { limitBytes: bytes, limitMb: mb } });
}

function tooManyFiles(maxFiles) {
  return archiveError('TOO_MANY_FILES', `Das ZIP enthält mehr als ${maxFiles} Dateien.`, { reason: 'files', params: { maxFiles } });
}

function sizeMismatch(name) {
  return invalidArchive('SIZE_MISMATCH', 'Eine Datei im ZIP hat entpackt nicht die angegebene Grösse.', { path: name });
}

/* ---------- names ---------- */

// Control characters removed, directory part cut off, shortened: a label for the asset list, never a path.
function cleanLabel(value, fallback = '') {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\\/g, '/');
  const base = text.split('/').pop().trim();
  return [...(base || fallback)].slice(0, MAX_NAME_LENGTH).join('');
}

// ASCII file name part for the ZIP: no path, no control characters, no leading dot.
function slugOf(name) {
  const stem = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const slug = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40);
  return slug || 'file';
}

function decodeEntryName(entry) {
  const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName : Buffer.from(String(entry.fileName || ''), 'utf8');
  try {
    return strictUtf8.decode(raw);
  } catch (_) {
    return null;
  }
}

// The normalised entry path, or null for anything that could leave the target folder or that is not plain text:
// empty or very long names, control characters, backslashes, absolute paths (also with a drive letter) and
// `.` / `..` / empty segments.
function safeArchivePath(name, { directory = false } = {}) {
  if (typeof name !== 'string' || !name || name.length > MAX_PATH_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const body = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (body.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return body;
}

// 0 for a plain file or an entry without Unix attributes, the file type bits otherwise.
function specialMode(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o100000 || mode === 0o040000 ? 0 : mode;
}

/* ---------- export ---------- */

const refKey = (nodeId, param, index) => `${nodeId}|${param}|${index === null || index === undefined ? '' : index}`;

// Which input files of a workflow go into a ZIP. A file is included when its param points into the workflow's
// own backing session, the ledger entry is finished and usable as image / video / audio, and the file is on disk.
// Everything else stays in the directory with `missing: true`. The same asset used twice is stored once.
async function planExport(workflow, { sessions = sessionStore, assets = assetsLib } = {}) {
  const refs = workflowsStore.assetParamRefs(workflow.graph);
  const ledger = refs.length ? await sessions.readLedger(workflow.sessionId) : [];
  const byAsset = new Map(ledger.map((entry) => [entry.id, entry]));
  const files = [];
  const bySource = new Map();
  const items = [];
  let missing = 0;

  for (const ref of refs) {
    const base = { node: ref.nodeId, param: ref.param, ...(ref.param === 'assets' ? { index: ref.index } : {}) };
    const point = assets.assetRefFromParam(ref.entry, workflow.sessionId);
    const ledgerEntry = point && point.sessionId === workflow.sessionId ? byAsset.get(point.assetId) : null;
    let planned = null;
    if (ledgerEntry && !ledgerEntry.pending) {
      planned = bySource.get(ledgerEntry.id) || null;
      if (!planned) {
        const type = assets.typeFromLedgerEntry(ledgerEntry);
        let file = null;
        let size = 0;
        if (type) {
          try {
            file = assets.assetFilePath({ sessionId: workflow.sessionId, file: ledgerEntry.file });
            const stat = await fsp.stat(file);
            if (stat.isFile()) size = stat.size;
            else file = null;
          } catch (_) {
            file = null;
          }
        }
        if (file) {
          const ext = path.extname(ledgerEntry.file).toLowerCase();
          const name = cleanLabel(ledgerEntry.kind === 'upload' ? ledgerEntry.prompt : '', ledgerEntry.file);
          planned = {
            file,
            size,
            type,
            name,
            zipPath: `${FILES_DIR}/${String(files.length + 1).padStart(3, '0')}-${slugOf(name)}${ext}`
          };
          files.push(planned);
          bySource.set(ledgerEntry.id, planned);
        }
      }
    }
    if (planned) {
      items.push({ ...base, path: planned.zipPath, type: planned.type, name: planned.name, size: planned.size });
    } else {
      missing += 1;
      items.push({ ...base, missing: true, ...(typeof ref.entry.type === 'string' ? { type: ref.entry.type.slice(0, 20) } : {}) });
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { items, files, references: refs.length, missing, totalBytes };
}

// The figures for the dialog before a download. `estimatedZipBytes` is what the ZIP will weigh (files are stored
// without compression); `limits` and the two flags tell whether a server with the standard limits would accept it.
function describeExport(plan, limits = DEFAULT_LIMITS) {
  const estimatedZipBytes = plan.totalBytes + plan.files.length * ZIP_OVERHEAD_PER_FILE + 4096 + plan.items.length * 200;
  return {
    fileCount: plan.files.length,
    referenceCount: plan.references,
    missingCount: plan.missing,
    totalBytes: plan.totalBytes,
    estimatedZipBytes,
    limits: { maxZipBytes: limits.maxZipBytes, maxFiles: limits.maxFiles },
    exceedsImportSize: estimatedZipBytes > limits.maxZipBytes,
    exceedsImportFiles: plan.files.length > limits.maxFiles
  };
}

// The workflow.json of the ZIP: the document of the JSON export plus the directory.
function archiveDocument(exportDocument, plan) {
  return { ...exportDocument, files: plan.items };
}

/* ---------- import: reading the ZIP ---------- */

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: false }, (err, zip) => {
      if (err) reject(invalidArchive('NOT_A_ZIP', 'Die Datei ist kein lesbares ZIP-Archiv.'));
      else resolve(zip);
    });
  });
}

// Walks the central directory (no data is read) and applies every rule that needs no content: names, kinds,
// duplicates, the number of files and the sizes announced in the ZIP. Resolves to Map(path -> entry).
function scanEntries(zip, limits) {
  return new Promise((resolve, reject) => {
    if (zip.entryCount > limits.maxFiles + EXTRA_ENTRIES + 1) return reject(tooManyFiles(limits.maxFiles));
    const files = new Map();
    let declared = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    zip.on('error', () => fail(invalidArchive('NOT_A_ZIP', 'Die Datei ist kein lesbares ZIP-Archiv.')));
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    zip.on('entry', (entry) => {
      if (settled) return;
      try {
        const name = decodeEntryName(entry);
        const directory = name !== null && name.endsWith('/');
        const clean = name === null ? null : safeArchivePath(name, { directory });
        if (!clean) throw invalidArchive('UNSAFE_PATH', 'Das ZIP enthält einen unzulässigen Dateipfad.');
        if (specialMode(entry)) throw invalidArchive('LINK_ENTRY', 'Das ZIP enthält Verknüpfungen, die nicht erlaubt sind.', { path: clean });
        if (!directory) {
          if (entry.isEncrypted() || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
            throw invalidArchive('UNSUPPORTED_COMPRESSION', 'Das ZIP enthält verschlüsselte oder nicht unterstützte Einträge.', { path: clean });
          }
          if (files.has(clean)) throw invalidArchive('DUPLICATE_ENTRY', 'Das ZIP enthält denselben Eintrag mehrfach.', { path: clean });
          if (files.size >= limits.maxFiles + 1) throw tooManyFiles(limits.maxFiles); // +1: workflow.json
          const isWorkflow = clean === WORKFLOW_ENTRY;
          if (entry.uncompressedSize > (isWorkflow ? limits.maxWorkflowBytes : limits.maxFileBytes)) {
            throw tooLarge(isWorkflow ? 'workflow' : 'file', isWorkflow ? limits.maxWorkflowBytes : limits.maxFileBytes);
          }
          if (
            !isWorkflow &&
            entry.compressionMethod === 8 &&
            entry.uncompressedSize > limits.ratioFloorBytes &&
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.maxRatio
          ) {
            throw invalidArchive('RATIO', 'Eine Datei im ZIP ist unplausibel stark komprimiert.', { path: clean });
          }
          declared += entry.uncompressedSize;
          if (declared > limits.maxUnpackedBytes) throw tooLarge('unpacked', limits.maxUnpackedBytes);
          files.set(clean, entry);
        }
        zip.readEntry();
      } catch (err) {
        fail(err);
      }
    });
    zip.readEntry();
  });
}

// Streams one entry. `onChunk(chunk, stream)` sees every piece (it may throw); `finish(bytes)` produces the
// result once the stream ended. The bytes are counted here: more or fewer than the ZIP announces is an error,
// and the stream is cut as soon as it is more (a ZIP that lies about its sizes is a zip bomb). `onStart(fail)`
// hands the caller a way to abort the entry from outside (a write error of the target file).
function streamEntry(zip, entry, name, { onChunk, finish, onStart = null }) {
  return new Promise((resolve, reject) => {
    // A deflated entry is inflated here and not by yauzl: its own inflate stream swallows zlib errors.
    zip.openReadStream(entry, entry.isCompressed() ? { decompress: false } : {}, (err, source) => {
      if (err) return reject(invalidArchive('CORRUPT_ENTRY', 'Eine Datei im ZIP ist beschädigt.', { path: name }));
      const inflate = entry.isCompressed() ? zlib.createInflateRaw() : null;
      const stream = inflate || source;
      let bytes = 0;
      let done = false;
      const corrupt = () => fail(invalidArchive('CORRUPT_ENTRY', 'Eine Datei im ZIP ist beschädigt.', { path: name }));
      const fail = (error) => {
        if (done) return;
        done = true;
        try {
          if (inflate) source.unpipe(inflate);
          source.destroy();
          if (inflate) inflate.destroy();
        } catch (_) {
          /* already closed */
        }
        reject(error);
      };
      if (inflate) {
        source.on('error', corrupt);
        source.pipe(inflate);
      }
      stream.on('data', (chunk) => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) return fail(sizeMismatch(name));
        try {
          onChunk(chunk, stream);
        } catch (error) {
          fail(error);
        }
      });
      stream.on('error', corrupt);
      stream.on('end', () => {
        if (done) return;
        if (bytes !== entry.uncompressedSize) return fail(sizeMismatch(name));
        done = true;
        Promise.resolve(finish(bytes)).then(resolve, reject);
      });
      if (onStart) onStart(fail);
    });
  });
}

function readEntryBuffer(zip, entry, name) {
  const chunks = [];
  return streamEntry(zip, entry, name, {
    onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    finish: () => Buffer.concat(chunks)
  });
}

// Writes one entry into `dest` without holding it in memory. `count(length)` is called per chunk and may throw
// (running total over all files).
function extractEntry(zip, entry, name, dest, count) {
  const out = fs.createWriteStream(dest, { flags: 'wx' });
  let outError = null;
  let abort = null;
  out.on('error', (err) => {
    outError = err;
    if (abort) abort(err);
  });
  return streamEntry(zip, entry, name, {
    onStart: (fail) => {
      abort = fail;
      if (outError) fail(outError);
    },
    onChunk: (chunk, stream) => {
      count(chunk.length);
      if (!out.write(chunk)) {
        stream.pause();
        out.once('drain', () => stream.resume());
      }
    },
    finish: (bytes) =>
      new Promise((resolve, reject) => {
        if (outError) return reject(outError);
        out.end(() => (outError ? reject(outError) : resolve(bytes)));
      })
  }).catch((err) => {
    out.destroy();
    throw err;
  });
}

// The media kind a node takes in a param ('image', 'video', 'audio' or 'document'), or null when the node type does not declare
// that param as a media param (then nothing is checked). Mirrors the picker of the node view: `accept: 'kind'` follows
// the node's own `kind` param.
function acceptedKind(node, param, registry) {
  const def = node && registry && typeof registry.get === 'function' ? registry.get(node.type) : null;
  const spec = def && Array.isArray(def.params) ? def.params.find((item) => item.id === param) : null;
  if (!spec || (spec.kind !== 'asset' && spec.kind !== 'assets')) return null;
  const accept = spec.accept === 'kind' ? node.params?.kind || 'image' : spec.accept || 'image';
  return accept === 'image' || accept === 'video' || accept === 'audio' || accept === 'document' ? accept : 'image';
}

function badDirectory(message, params) {
  return invalidArchive('BAD_DIRECTORY', message || 'Das Dateiverzeichnis in workflow.json ist ungültig.', params);
}

// Checks the directory of workflow.json against the graph and the entries of the ZIP. Returns
// { items: [{ key, path }], files: [{ path, entry, ext, svg, type, name }] } (distinct paths, in directory order).
function readDirectory(document, graph, entries, classify, limits, registry) {
  const raw = document.files;
  if (raw === undefined || raw === null) return { items: [], files: [] };
  if (!Array.isArray(raw) || raw.length > MAX_DIRECTORY_ITEMS) throw badDirectory();
  const refs = new Set(workflowsStore.assetParamRefs(graph).map((ref) => refKey(ref.nodeId, ref.param, ref.index)));
  const nodesById = new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).map((item) => [item.id, item]));
  const seen = new Set();
  const items = [];
  const files = new Map();
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.node !== 'string' || (item.param !== 'asset' && item.param !== 'assets')) throw badDirectory();
    let index = null;
    if (item.param === 'assets') {
      if (!Number.isInteger(item.index) || item.index < 0) throw badDirectory();
      index = item.index;
    } else if (item.index !== undefined && item.index !== null) {
      throw badDirectory();
    }
    const key = refKey(item.node, item.param, index);
    if (!refs.has(key) || seen.has(key)) throw badDirectory(undefined, { node: item.node });
    seen.add(key);
    if (item.missing === true || item.path === undefined || item.path === null) continue; // stays missing
    if (item.size !== undefined && (!Number.isInteger(item.size) || item.size < 0)) throw badDirectory();
    const clean = typeof item.path === 'string' ? safeArchivePath(item.path) : null;
    if (!clean) throw invalidArchive('UNSAFE_PATH', 'Das ZIP enthält einen unzulässigen Dateipfad.');
    if (!clean.startsWith(`${FILES_DIR}/`)) throw badDirectory(undefined, { path: clean });
    const entry = entries.get(clean);
    if (!entry) throw invalidArchive('MISSING_ENTRY', 'Eine Datei aus dem Verzeichnis fehlt im ZIP.', { path: clean });
    let file = files.get(clean);
    if (!file) {
      const kind = classify(clean);
      if (kind.error) throw archiveError('UNSUPPORTED_MEDIA', 'Das ZIP enthält einen nicht unterstützten Dateityp.', { reason: 'TYPE', params: { path: clean } });
      if (item.type !== undefined && item.type !== null && item.type !== kind.type) {
        throw archiveError('UNSUPPORTED_MEDIA', 'Das ZIP enthält einen nicht unterstützten Dateityp.', { reason: 'TYPE', params: { path: clean } });
      }
      if (entry.uncompressedSize === 0) throw invalidArchive('EMPTY_FILE', 'Das ZIP enthält eine leere Datei.', { path: clean });
      if (kind.svg && entry.uncompressedSize > limits.maxSvgBytes) throw tooLarge('svg', limits.maxSvgBytes);
      file = { path: clean, entry, ext: kind.ext, svg: Boolean(kind.svg), type: kind.type, name: cleanLabel(item.name, path.posix.basename(clean)) };
      files.set(clean, file);
    }
    // The file must be what the node takes: a video does not belong into an image node. Checked per input, since
    // one file may feed several nodes.
    const wanted = acceptedKind(nodesById.get(item.node), item.param, registry);
    if (wanted && file.type !== wanted) {
      throw archiveError('UNSUPPORTED_MEDIA', 'Eine Datei im ZIP passt nicht zum Node, in den sie gehört.', {
        reason: 'MISMATCH',
        params: { path: clean, node: item.node, expected: wanted, found: file.type }
      });
    }
    items.push({ key, path: clean });
  }
  for (const name of entries.keys()) {
    if (name !== WORKFLOW_ENTRY && !files.has(name)) {
      throw invalidArchive('UNLISTED_ENTRY', 'Das ZIP enthält Dateien, die nicht im Verzeichnis stehen.', { path: name });
    }
  }
  return { items, files: [...files.values()] };
}

// Checks a received ZIP completely and unpacks the listed files into `stagingDir` (f001.png, ...). Nothing outside
// the staging folder is touched. Resolves to
//   { document, items, files: [{ path, staged, ext, svg, type, name, size }] }
// `document` is workflow.json as parsed (the caller stores it with createWorkflow, which validates again),
// `items` maps each input of the graph to a ZIP path. `classify(path)` decides the type of a file by the same
// rules as an upload: { ext, svg?, type } or { error }.
async function prepareImport(zipFile, stagingDir, { classify, registry, limits: given = DEFAULT_LIMITS } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...given };
  const zip = await openZip(zipFile);
  try {
    const entries = await scanEntries(zip, limits);
    const workflowEntry = entries.get(WORKFLOW_ENTRY);
    if (!workflowEntry) throw invalidArchive('NO_WORKFLOW_JSON', 'Im ZIP fehlt die Datei workflow.json.');
    const text = (await readEntryBuffer(zip, workflowEntry, WORKFLOW_ENTRY)).toString('utf8').replace(/^﻿/, '');
    let document;
    try {
      document = JSON.parse(text);
    } catch (_) {
      throw archiveError('INVALID_WORKFLOW', 'Die Datei workflow.json enthält kein gültiges JSON.', { reason: 'NOT_JSON' });
    }
    let validated;
    try {
      validated = workflowsStore.validateDocument(document, { registry });
    } catch (err) {
      if (err && (err.code === 'INVALID_WORKFLOW' || err.code === 'INVALID_GRAPH')) {
        throw archiveError('INVALID_WORKFLOW', 'Die Datei workflow.json ist kein gültiger Workflow.', {
          reason: 'INVALID_DOCUMENT',
          params: { detail: String(err.message || '').slice(0, 300) }
        });
      }
      throw err;
    }
    const directory = readDirectory(document, validated.graph, entries, classify, limits, registry);

    let total = 0;
    const count = (length) => {
      total += length;
      if (total > limits.maxUnpackedBytes) throw tooLarge('unpacked', limits.maxUnpackedBytes);
    };
    const files = [];
    for (const [index, file] of directory.files.entries()) {
      const staged = path.join(stagingDir, `f${String(index + 1).padStart(3, '0')}${file.ext}`);
      const size = await extractEntry(zip, file.entry, file.path, staged, count);
      files.push({ path: file.path, staged, ext: file.ext, svg: file.svg, type: file.type, name: file.name, size });
    }
    return { document, items: directory.items, files };
  } finally {
    try {
      zip.close();
    } catch (_) {
      /* already closed */
    }
  }
}

module.exports = {
  WORKFLOW_ENTRY,
  FILES_DIR,
  DEFAULT_LIMITS,
  archiveError,
  tooLarge,
  cleanLabel,
  slugOf,
  safeArchivePath,
  refKey,
  planExport,
  acceptedKind,
  describeExport,
  archiveDocument,
  prepareImport
};
