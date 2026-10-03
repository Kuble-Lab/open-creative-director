'use strict';

// Documents in the node view (WP37a): PDF, TXT and MD files that people upload and that the node "Read documents" turns into
// text with page marks. Nothing here talks to a network. The PDF work is done by poppler (pdfinfo, pdftotext, pdftoppm), started
// with execFile (never through a shell) and a time limit for every call. TXT and MD are read as UTF-8.
//
//   checkDocumentFile()   what an upload must be: at most 50 MB, a PDF starts with "%PDF-", a text file is UTF-8 text
//   binaries()/available()  where poppler is (PATH, then the usual folders; POPPLER_BIN_DIR names the only folder to look in)
//   readDocument()        { title, type, pageCount, pages: [{ n, text }], truncated, ... } of one file
//   renderPages()         PNG files of some pages (pdftoppm)
//   textWithMarks()       the pages of several documents as one text with a head per document and a mark per page

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const DOCUMENT_EXTS = Object.freeze(['.pdf', '.txt', '.md']);
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 150;
const MAX_PAGES_CEILING = 300;
// a document below this many characters per page on average is taken for a scan (no text layer)
const SCANNED_CHARS_PER_PAGE = 200;
// TXT and MD have no pages: they are cut into sections of about this many characters (at paragraph borders), so that a
// reference such as "p. 3" still means something
const TEXT_SECTION_CHARS = 6000;
const HEAD_BYTES = 64 * 1024;
const PDF_MAGIC = '%PDF-';
const INFO_TIMEOUT_MS = 30 * 1000;
const TEXT_TIMEOUT_MS = 2 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const FALLBACK_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
const TOOLS = Object.freeze(['pdfinfo', 'pdftotext', 'pdftoppm']);
const MISSING_POPPLER = 'pdftotext/pdftoppm not found (poppler)';

function documentError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

/* ---------- kinds ---------- */

// 'pdf' | 'text' for an extension we read, else null.
function typeOfExtension(ext) {
  const clean = String(ext || '').toLowerCase();
  if (clean === '.pdf') return 'pdf';
  if (clean === '.txt' || clean === '.md') return 'text';
  return null;
}

/* ---------- checking an upload ---------- */

// The first bytes of a file against its extension. Returns null when fine, else { code, message }.
//   UNSUPPORTED_MEDIA   a ".pdf" that does not start with %PDF-, a text file with binary content or that is not UTF-8
function checkHead(head, ext) {
  const type = typeOfExtension(ext);
  if (type === 'pdf') {
    return head.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC ? null : { code: 'UNSUPPORTED_MEDIA', message: 'The file is not a PDF (it does not start with %PDF-)' };
  }
  if (type === 'text') {
    if (head.includes(0)) return { code: 'UNSUPPORTED_MEDIA', message: 'The file is not a text file (it contains binary data)' };
    // a cut can end inside a multi-byte character: only a broken character before the last three bytes counts
    const text = head.subarray(0, Math.max(0, head.length - 3)).toString('utf8');
    if (text.includes('�')) return { code: 'UNSUPPORTED_MEDIA', message: 'The text file is not UTF-8' };
    return null;
  }
  return { code: 'UNSUPPORTED_MEDIA', message: `Unsupported document type ${ext || '(none)'}` };
}

// Checks a stored file. Throws an error with a code: TOO_LARGE (above 50 MB), UNSUPPORTED_MEDIA (wrong content), INVALID_REQUEST (empty).
async function checkDocumentFile(file, ext) {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_DOCUMENT_BYTES) throw documentError('TOO_LARGE', `Upload is larger than ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`);
  if (stat.size === 0) throw documentError('INVALID_REQUEST', 'Upload is empty');
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    await handle.read(head, 0, head.length, 0);
    const problem = checkHead(head, ext);
    if (problem) throw documentError(problem.code, problem.message);
  } finally {
    await handle.close();
  }
  return { bytes: stat.size };
}

/* ---------- poppler ---------- */

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function searchDirs(env) {
  const override = String(env.POPPLER_BIN_DIR || '').trim();
  if (override) return [override];
  return [...String(env.PATH || '').split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
}

// { pdfinfo, pdftotext, pdftoppm, available, missing }: absolute paths or null.
function binaries({ env = process.env } = {}) {
  const dirs = searchDirs(env);
  const found = {};
  for (const tool of TOOLS) {
    found[tool] = null;
    for (const dir of dirs) {
      const candidate = path.join(dir, tool);
      if (isExecutable(candidate)) {
        found[tool] = candidate;
        break;
      }
    }
  }
  // pdfinfo only adds the title and the page count of an upload: the node works without it
  const missing = ['pdftotext', 'pdftoppm'].filter((tool) => !found[tool]);
  return { ...found, available: missing.length === 0, missing };
}

// true, or the reason the document nodes cannot read PDF files (the same wording as ffmpeg's: the interface translates it).
function available(options) {
  return binaries(options).available ? true : MISSING_POPPLER;
}

function run(command, args, { timeoutMs, signal, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding, signal, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return reject(err);
        // the tools name the file in their messages: the person gets the file name, not the path on the server
        let detail = String(stderr || '').trim().split('\n').slice(-3).join(' ');
        for (const arg of args) if (typeof arg === 'string' && path.isAbsolute(arg)) detail = detail.split(arg).join(path.basename(arg));
        detail = detail.slice(0, 300);
        const failure = documentError(err.killed || err.signal === 'SIGTERM' ? 'DOCUMENT_TIMEOUT' : 'DOCUMENT_UNREADABLE', `${path.basename(command)} failed${detail ? `: ${detail}` : ''}`);
        failure.detail = detail;
        return reject(failure);
      }
      resolve(stdout);
    });
  });
}

function requireTool(tool) {
  const found = binaries()[tool];
  if (!found) throw documentError('POPPLER_MISSING', MISSING_POPPLER);
  return found;
}

/* ---------- reading ---------- */

// Title and page count of a PDF (pdfinfo). { pages, title, encrypted }; pages is null where pdfinfo is missing or cannot say.
async function pdfInfo(file, { signal } = {}) {
  const command = binaries().pdfinfo;
  if (!command) return { pages: null, title: '', encrypted: false };
  let out;
  try {
    out = await run(command, ['-enc', 'UTF-8', file], { timeoutMs: INFO_TIMEOUT_MS, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { pages: null, title: '', encrypted: false };
  }
  const field = (name) => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(out);
    return match ? match[1].trim() : '';
  };
  const pages = Number.parseInt(field('Pages'), 10);
  return { pages: Number.isInteger(pages) && pages > 0 ? pages : null, title: field('Title'), encrypted: /^yes/i.test(field('Encrypted')) };
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// The text of a TXT/MD file as sections of about TEXT_SECTION_CHARS characters, cut at blank lines where possible.
function splitTextSections(text, size = TEXT_SECTION_CHARS) {
  const clean = cleanText(text);
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const sections = [];
  let current = '';
  const flush = () => {
    if (current.trim()) sections.push(current.trim());
    current = '';
  };
  for (const paragraph of clean.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > size) flush();
    if (paragraph.length > size) {
      // one very long paragraph: cut it at line ends, then at spaces
      for (let rest = paragraph; rest.length; ) {
        if (rest.length <= size) {
          current = current ? `${current}\n\n${rest}` : rest;
          rest = '';
          break;
        }
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        current = current ? `${current}\n\n${rest.slice(0, cut)}` : rest.slice(0, cut);
        flush();
        rest = rest.slice(cut).trimStart();
      }
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  flush();
  return sections;
}

// Reads one stored document. options: { ext, name, maxPages, signal }.
// Returns { type: 'pdf'|'text', title, pageCount, pages: [{ n, text }], truncated, sectionsAsPages, chars }:
//   pageCount   the pages of the document; pages holds at most maxPages of them (truncated is then true)
async function readDocument(file, { ext, name = '', maxPages = DEFAULT_MAX_PAGES, signal } = {}) {
  const type = typeOfExtension(ext || path.extname(file));
  if (!type) throw documentError('UNSUPPORTED_MEDIA', `Unsupported document type ${ext || path.extname(file) || '(none)'}`);
  const limit = Math.max(1, Math.min(MAX_PAGES_CEILING, Math.round(maxPages) || DEFAULT_MAX_PAGES));
  const fallbackTitle = String(name || path.basename(file)).replace(/\.[A-Za-z0-9]{1,5}$/, '');
  if (type === 'text') {
    const sections = splitTextSections(await fsp.readFile(file, 'utf8'));
    const kept = sections.slice(0, limit);
    const pages = kept.map((text, index) => ({ n: index + 1, text }));
    return { type, title: fallbackTitle, pageCount: sections.length, pages, truncated: sections.length > kept.length, sectionsAsPages: true, chars: pages.reduce((sum, page) => sum + page.text.length, 0) };
  }
  const command = requireTool('pdftotext');
  const info = await pdfInfo(file, { signal });
  if (info.encrypted) throw documentError('DOCUMENT_ENCRYPTED', `${name || path.basename(file)} is password protected`);
  const stdout = await run(command, ['-enc', 'UTF-8', '-f', '1', '-l', String(limit), file, '-'], { timeoutMs: TEXT_TIMEOUT_MS, signal });
  // pdftotext ends every page with a form feed
  const chunks = String(stdout).split('\f');
  if (chunks.length && !chunks[chunks.length - 1].trim()) chunks.pop();
  const pages = chunks.map((chunk, index) => ({ n: index + 1, text: cleanText(chunk) }));
  const pageCount = info.pages || pages.length;
  return { type, title: info.title || fallbackTitle, pageCount, pages, truncated: pageCount > pages.length, sectionsAsPages: false, chars: pages.reduce((sum, page) => sum + page.text.length, 0) };
}

// How scanned a document looks: true when the pages hold fewer than SCANNED_CHARS_PER_PAGE characters on average.
function looksScanned(pages) {
  if (!pages.length) return true;
  const chars = pages.reduce((sum, page) => sum + page.text.replace(/\s+/g, ' ').trim().length, 0);
  return chars / pages.length < SCANNED_CHARS_PER_PAGE;
}

/* ---------- page images ---------- */

// PNG files of the pages `first`..`last` of a PDF in `outDir` (150 dpi by default): [{ n, file }] in page order.
async function renderPages(file, outDir, { first = 1, last = first, dpi = 150, signal } = {}) {
  const command = requireTool('pdftoppm');
  await fsp.mkdir(outDir, { recursive: true });
  await run(command, ['-png', '-r', String(dpi), '-f', String(first), '-l', String(last), file, path.join(outDir, 'page')], { timeoutMs: IMAGE_TIMEOUT_MS, signal });
  const names = (await fsp.readdir(outDir)).filter((entry) => /^page-\d+\.png$/.test(entry));
  return names
    .map((entry) => ({ n: Number.parseInt(/(\d+)\.png$/.exec(entry)[1], 10), file: path.join(outDir, entry) }))
    .sort((a, b) => a.n - b.n);
}

/* ---------- text with marks ---------- */

const MARKS = Object.freeze({ de: 'Seite', en: 'Page', es: 'Página' });

// '[p. 3]' without a language, '[Seite 3]' / '[Page 3]' / '[Página 3]' with one.
function pageMark(language, n) {
  const word = MARKS[language];
  return word ? `[${word} ${n}]` : `[p. ${n}]`;
}

// The marks of any language in a text, to find the pages again: matches '[p. 3]', '[Seite 3]', '[Page 3]', '[Página 3]'.
const MARK_PATTERN = /\[(?:p\.|Seite|Page|Página)\s*(\d+)\]/g;

// One text for all documents: "=== D1: name (12 pages) ===" and a mark before the text of every page.
//   documents: [{ name, title, pageCount, pages: [{ n, text }], truncated }]
function textWithMarks(documents, { language = '' } = {}) {
  const parts = [];
  documents.forEach((doc, index) => {
    const count = doc.pageCount || doc.pages.length;
    const note = doc.truncated ? `, only the first ${doc.pages.length} read` : '';
    parts.push(`=== D${index + 1}: ${doc.name || doc.title} (${count} ${count === 1 ? 'page' : 'pages'}${note}) ===`);
    for (const page of doc.pages) {
      parts.push(pageMark(language, page.n));
      parts.push(page.text || '(no text on this page)');
    }
    parts.push('');
  });
  return parts.join('\n').trim();
}

module.exports = {
  DOCUMENT_EXTS,
  MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_PAGES,
  MAX_PAGES_CEILING,
  SCANNED_CHARS_PER_PAGE,
  TEXT_SECTION_CHARS,
  MISSING_POPPLER,
  MARK_PATTERN,
  documentError,
  typeOfExtension,
  checkHead,
  checkDocumentFile,
  binaries,
  available,
  pdfInfo,
  splitTextSections,
  readDocument,
  looksScanned,
  renderPages,
  pageMark,
  textWithMarks
};
