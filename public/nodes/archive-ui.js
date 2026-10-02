'use strict';

// Export and import with files in the node view (WP29): what the browser needs around the ZIP routes.
// Recognising the chosen file (JSON or ZIP by extension and first bytes), the size note before a ZIP download, the
// progress card while a ZIP uploads, the "x of y files imported" note after every import and the readable error
// texts for the codes of the server (TOO_LARGE, TOO_MANY_FILES, INVALID_ARCHIVE, INVALID_WORKFLOW, UNSUPPORTED_MEDIA,
// IMPORT_FAILED). The logic without a DOM (kindOfHead, formatBytes, errorMessage, filesFeedback, exportNote) is plain
// functions; the progress card is the only part that builds elements.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const { el, T } = ui;

  const MB = 1024 * 1024;
  const MAX_ZIP_BYTES = 500 * MB;
  const MAX_JSON_BYTES = 2 * MB;
  const IMPORT_ACCEPT = '.json,.zip,application/json,application/zip,application/x-zip-compressed';

  // One key per reason of INVALID_ARCHIVE; every other reason falls back to the general text.
  const ARCHIVE_REASONS = {
    NOT_A_ZIP: 'nodes.import.archive.notZip',
    NO_WORKFLOW_JSON: 'nodes.import.archive.noWorkflow',
    BAD_DIRECTORY: 'nodes.import.archive.badDirectory',
    UNSAFE_PATH: 'nodes.import.archive.unsafePath',
    LINK_ENTRY: 'nodes.import.archive.link',
    DUPLICATE_ENTRY: 'nodes.import.archive.duplicate',
    UNLISTED_ENTRY: 'nodes.import.archive.unlisted',
    MISSING_ENTRY: 'nodes.import.archive.missingEntry',
    SIZE_MISMATCH: 'nodes.import.archive.sizeMismatch',
    CORRUPT_ENTRY: 'nodes.import.archive.corrupt',
    UNSUPPORTED_COMPRESSION: 'nodes.import.archive.compression',
    EMPTY_FILE: 'nodes.import.archive.empty',
    RATIO: 'nodes.import.archive.ratio'
  };
  const TOO_LARGE_REASONS = {
    archive: 'nodes.import.tooLarge.archive',
    file: 'nodes.import.tooLarge.file',
    unpacked: 'nodes.import.tooLarge.unpacked',
    workflow: 'nodes.import.tooLarge.workflow',
    svg: 'nodes.import.tooLarge.svg'
  };

  function language() {
    return typeof global.getLang === 'function' ? global.getLang() : undefined;
  }

  // "12.4 MB" in the notation of the language; the limits of the server count in MiB, so 1024 steps.
  function formatBytes(bytes, lang = language()) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : size < 10 ? 1 : 0;
    let text;
    try {
      text = new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(size);
    } catch (_) {
      text = String(Math.round(size * 10) / 10);
    }
    return `${text} ${units[unit]}`;
  }

  /* ---------- which file is it ---------- */

  // 'zip' or 'json' from the name and the first bytes: PK is a ZIP whatever the name says, an opening brace or bracket
  // is JSON whatever the name says, anything else follows the extension (a wrong .zip then ends in a clear server error).
  function kindOfHead(name, bytes) {
    const head = Array.from(bytes || []);
    if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    let index = 0;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) index = 3;
    while (index < head.length && [0x20, 0x09, 0x0a, 0x0d].includes(head[index])) index += 1;
    if (head[index] === 0x7b || head[index] === 0x5b) return 'json';
    return /\.zip$/i.test(String(name || '')) ? 'zip' : 'json';
  }

  async function detectKind(file) {
    let bytes = [];
    try {
      bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    } catch (_) {
      /* unreadable: the extension decides */
    }
    return kindOfHead(file && file.name, bytes);
  }

  /* ---------- texts ---------- */

  function limitMbOf(params, fallback) {
    if (params && Number.isFinite(Number(params.limitMb))) return Number(params.limitMb);
    if (params && Number.isFinite(Number(params.limitBytes))) return Math.round(Number(params.limitBytes) / MB);
    return fallback;
  }

  function withPath(text, params) {
    const path = params && typeof params.path === 'string' ? params.path : '';
    return path ? `${text.replace(/\.$/, '')} (${path}).` : text;
  }

  // The sentence for an error of the import (ZIP and JSON). Unknown codes keep the message of the server.
  function errorMessage(error) {
    if (!error) return '';
    if (error.aborted) return T('nodes.import.aborted');
    if (error.status === 0) return T('nodes.import.network');
    const params = error.params || (error.body && error.body.params) || {};
    const reason = error.reason || (error.body && error.body.reason) || '';
    switch (error.code) {
      case 'TOO_LARGE':
        return T(TOO_LARGE_REASONS[reason] || 'nodes.import.tooLarge.archive', { limitMb: limitMbOf(params, reason === 'workflow' ? 2 : reason === 'svg' ? 10 : 500) });
      case 'TOO_MANY_FILES':
        return T('nodes.import.tooMany', { maxFiles: Number.isFinite(Number(params.maxFiles)) ? Number(params.maxFiles) : 200 });
      case 'INVALID_ARCHIVE':
        return withPath(T(ARCHIVE_REASONS[reason] || 'nodes.import.archive.general'), params);
      case 'INVALID_WORKFLOW':
        return T('nodes.import.invalidWorkflow');
      case 'UNSUPPORTED_MEDIA':
        return withPath(T(reason === 'UNREADABLE' ? 'nodes.import.unreadable' : reason === 'MISMATCH' ? 'nodes.import.typeMismatch' : 'nodes.import.unsupportedType'), params);
      case 'IMPORT_FAILED':
        return T('nodes.import.failedClean');
      default:
        return error.message || '';
    }
  }

  // The note after an import: { text, kind } from `files` of the answer, or null when the workflow has no files.
  function filesFeedback(files) {
    if (!files || files.code === 'IMPORT_FILES_NONE' || !(Number(files.total) > 0)) return null;
    const total = Number(files.total);
    const imported = Math.max(0, Number(files.imported) || 0);
    const missing = Math.max(0, Number(files.missing) || 0);
    if (!Number.isFinite(total) || imported > total || missing > total) {
      return files.message ? { text: String(files.message), kind: missing > 0 ? 'warn' : '' } : null;
    }
    const head = total === 1 ? T('nodes.import.filesOne', { imported, total }) : T('nodes.import.filesMany', { imported, total });
    let tail = '';
    if (missing > 0) tail = missing === 1 ? T('nodes.import.missingOne', { missing }) : T('nodes.import.missingMany', { missing });
    return { text: tail ? `${head}, ${tail}.` : `${head}.`, kind: missing > 0 ? 'warn' : '' };
  }

  // The size line before a ZIP download and the hints when the ZIP is too big for an import with the default limits.
  function exportNote(info, lang = language()) {
    const size = formatBytes(info && (info.estimatedZipBytes ?? info.totalBytes) || 0, lang);
    const count = Number(info && info.fileCount) || 0;
    let line = count === 0 ? T('nodes.export.sizeNone', { size }) : count === 1 ? T('nodes.export.sizeOne', { size }) : T('nodes.export.sizeMany', { count, size });
    const missing = Number(info && info.missingCount) || 0;
    if (missing > 0) line = `${line} · ${T('nodes.export.missing', { count: missing })}`;
    const limits = (info && info.limits) || {};
    const warnings = [];
    if (info && info.exceedsImportSize) warnings.push(T('nodes.export.bigSize', { size, limit: limitMbOf({ limitBytes: limits.maxZipBytes }, 500) }));
    if (info && info.exceedsImportFiles) warnings.push(T('nodes.export.bigFiles', { count, limit: Number(limits.maxFiles) || 200 }));
    return { line, warnings };
  }

  /* ---------- progress card ---------- */

  // A small card at the bottom left while a ZIP uploads: name, bar, "x of y", Cancel. At 100% the file is on the
  // server and only unpacking and checking remain, so the bar goes indeterminate and Cancel disappears.
  function createProgress({ host, name, total, onCancel }) {
    const title = el('div', { class: 'nv-transfer-title', text: T('nodes.import.uploading', { name, percent: 0 }) });
    const fill = el('i');
    const bar = el('div', { class: 'nv-transfer-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
    const detail = el('div', { class: 'nv-transfer-detail', text: T('nodes.run.progress', { done: formatBytes(0), total: formatBytes(total) }) });
    const cancel = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-transfer-cancel', text: T('nodes.common.cancel') });
    cancel.addEventListener('click', () => onCancel && onCancel());
    const card = el('div', { class: 'nv-transfer', role: 'status', 'aria-live': 'polite' }, title, bar, el('div', { class: 'nv-transfer-foot' }, detail, cancel));
    host.append(card);
    return {
      element: card,
      update(ratio) {
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        fill.style.width = `${percent}%`;
        bar.setAttribute('aria-valuenow', String(percent));
        title.textContent = T('nodes.import.uploading', { name, percent });
        detail.textContent = T('nodes.run.progress', { done: formatBytes(ratio * total), total: formatBytes(total) });
      },
      processing() {
        card.classList.add('is-processing');
        fill.style.width = '100%';
        bar.removeAttribute('aria-valuenow');
        title.textContent = T('nodes.import.unpacking', { name });
        detail.textContent = formatBytes(total);
        cancel.remove();
      },
      close() {
        card.remove();
      }
    };
  }

  OCD.archiveUi = {
    MAX_ZIP_BYTES,
    MAX_JSON_BYTES,
    IMPORT_ACCEPT,
    formatBytes,
    kindOfHead,
    detectKind,
    errorMessage,
    filesFeedback,
    exportNote,
    createProgress
  };
})(window);
