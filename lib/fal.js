'use strict';

// fal.ai client: file upload to the fal storage, queue jobs (submit, status, result) and streamed result
// download. Used by the node view only (tools.fal_generate, the poller, lib/nodes/nodes-fal.js).
// Facts verified against the fal documentation and @fal-ai/client 1.10.1 (2026-09-29); NOT verified live.
// Everything talks to https endpoints of fal, the key travels only in the Authorization header, and no error
// message ever carries the key or a (signed) URL.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { getSetting } = require('./settings');

const QUEUE_BASE = 'https://queue.fal.run/';
const REST_BASE = 'https://rest.fal.ai';
const UPLOAD_INITIATE_PATH = '/storage/upload/initiate?storage_type=fal-cdn-v3';
// Input files live 24 h in the fal storage; results are kept for 7 days.
const UPLOAD_LIFECYCLE = JSON.stringify({ expiration_duration_seconds: 24 * 60 * 60 });
const RESULT_LIFECYCLE_PREFERENCE = JSON.stringify({ expiration_duration_seconds: 7 * 24 * 60 * 60 });
// The official client switches to multipart at 90 MB; this app does not, so bigger files are refused.
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
// Long 2K lip-sync results can pass 1 GB, so the limit is generous.
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 300;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = Object.freeze({
  initiate: 60 * 1000,
  submit: 60 * 1000,
  status: 30 * 1000,
  result: 60 * 1000,
  put: 10 * 60 * 1000,
  download: 30 * 60 * 1000
});
const ENDPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*){1,5}$/;
const MISSING_KEY_MESSAGE = 'Kein FAL_KEY hinterlegt - unter Einstellungen setzen.';
const URL_PATTERN = /https?:\/\/[^\s"'<>\\)\]]+/gi;
const KIND_ORDER = Object.freeze(['video', 'image', 'audio']);

class FalError extends Error {
  // `retryable` is true for problems that may go away (network, timeouts, 5xx, 429, 408): the poller then asks again.
  constructor(message, status = 0, { retryable = false } = {}) {
    super(message);
    this.name = 'FalError';
    this.status = status;
    this.retryable = retryable;
  }
}

function isValidEndpointId(id) {
  return typeof id === 'string' && id.length <= 200 && ENDPOINT_ID_PATTERN.test(id);
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isQueueUrl(value) {
  return typeof value === 'string' && value.startsWith(QUEUE_BASE) && isHttpsUrl(value);
}

// Result files live on fal.media (v3b.fal.media and similar); fal.run and fal.ai hosts are accepted as well.
function isAllowedDownloadHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'fal.media' || host.endsWith('.fal.media') || host.endsWith('.fal.run') || host.endsWith('.fal.ai');
}

function isFatalStatus(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// Text of an error body: fal answers { detail } with a string or, for validation errors (422), a list of
// { loc, msg, type } entries.
function detailText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    return body
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const where = Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '';
        const what = typeof item.msg === 'string' ? item.msg : typeof item.message === 'string' ? item.message : '';
        return [where, what].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join('; ');
  }
  if (typeof body === 'object') {
    const inner = body.detail ?? body.error ?? body.message;
    if (inner === undefined || inner === null) return '';
    if (typeof inner === 'object' && !Array.isArray(inner)) {
      try {
        return JSON.stringify(inner);
      } catch (_) {
        return '';
      }
    }
    return detailText(inner);
  }
  return String(body);
}

function createFalClient({ fetchImpl, getKey } = {}) {
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));
  const readKey = getKey || (() => String(getSetting('FAL_KEY') || '').trim());

  function apiKey() {
    return String(readKey() || '').trim();
  }

  function hasKey() {
    return Boolean(apiKey());
  }

  function requireKey() {
    const key = apiKey();
    if (!key) throw new FalError(MISSING_KEY_MESSAGE);
    return key;
  }

  // Shortens a message and removes the key and every URL (signed upload or result URLs are credentials).
  function clean(text) {
    let value = String(text ?? '');
    const key = apiKey();
    if (key.length >= 4) value = value.split(key).join('[entfernt]');
    value = value.replace(URL_PATTERN, '[URL]').replace(/\s+/g, ' ').trim();
    return value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : value;
  }

  function httpError(what, status, bodyText) {
    let detail = '';
    try {
      detail = detailText(JSON.parse(bodyText));
    } catch (_) {
      detail = /^\s*</.test(String(bodyText || '')) ? '' : String(bodyText || '');
    }
    const suffix = clean(detail);
    const head = status === 401 || status === 403
      ? `fal.ai lehnt den Zugriff ab (HTTP ${status}) - FAL_KEY pruefen`
      : `${what} fehlgeschlagen (HTTP ${status})`;
    return new FalError(suffix ? `${head}: ${suffix}` : `${head}.`, status, { retryable: !isFatalStatus(status) });
  }

  // Combines the caller's signal with a timeout.
  function guard(external, ms) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    timer.unref?.();
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      done() {
        clearTimeout(timer);
        external?.removeEventListener?.('abort', onAbort);
      }
    };
  }

  function transportError(what, err, g, signal, ms) {
    if (err instanceof FalError) return err;
    if (signal?.aborted) return abortError();
    if (g.timedOut()) return new FalError(`${what}: Zeitlimit von ${Math.round(ms / 1000)} Sekunden erreicht.`, 0, { retryable: true });
    return new FalError(`${what} fehlgeschlagen: ${clean(err?.message || err)}`, 0, { retryable: true });
  }

  async function requestJson(what, url, init, { timeoutMs, signal } = {}) {
    const g = guard(signal, timeoutMs);
    try {
      const response = await fetchRequest(url, { ...init, signal: g.signal });
      const text = await response.text();
      if (!response.ok) throw httpError(what, response.status, text);
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new FalError(`${what}: fal.ai lieferte keine gueltige JSON-Antwort.`, response.status, { retryable: true });
      }
    } catch (err) {
      throw transportError(what, err, g, signal, timeoutMs);
    } finally {
      g.done();
    }
  }

  function authHeaders(key, extra = {}) {
    return { Authorization: `Key ${key}`, ...extra };
  }

  function safeFileName(value, fallback) {
    const base = path.basename(String(value || fallback || 'upload.bin')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return base && base !== '.' && base !== '..' ? base : 'upload.bin';
  }

  // Uploads one file to the fal storage and returns its public URL for use as a model input.
  async function uploadFile(filePath, { contentType, fileName, signal } = {}) {
    const key = requireKey();
    const type = String(contentType || '').trim() || 'application/octet-stream';
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      throw new FalError(err.code === 'ENOENT' ? 'Die Datei fuer den fal.ai-Upload fehlt.' : `Die Datei fuer den fal.ai-Upload konnte nicht gelesen werden: ${clean(err.message)}`);
    }
    if (!stat.isFile() || stat.size === 0) throw new FalError('Die Datei fuer den fal.ai-Upload ist leer oder keine Datei.');
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new FalError(`Die Datei ist groesser als ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB und kann nicht zu fal.ai hochgeladen werden.`);
    }
    const name = safeFileName(fileName, path.basename(String(filePath)));

    const initiated = await requestJson(
      'fal.ai-Upload (Start)',
      `${REST_BASE}${UPLOAD_INITIATE_PATH}`,
      {
        method: 'POST',
        headers: authHeaders(key, { 'Content-Type': 'application/json', 'X-Fal-Object-Lifecycle': UPLOAD_LIFECYCLE }),
        body: JSON.stringify({ content_type: type, file_name: name })
      },
      { timeoutMs: TIMEOUT_MS.initiate, signal }
    );
    const uploadUrl = initiated && initiated.upload_url;
    const fileUrl = initiated && initiated.file_url;
    if (!isHttpsUrl(uploadUrl) || !isHttpsUrl(fileUrl)) {
      throw new FalError('fal.ai lieferte keine gueltige Upload-Adresse (https erwartet).');
    }

    const g = guard(signal, TIMEOUT_MS.put);
    const body = fs.createReadStream(filePath);
    try {
      const response = await fetchRequest(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': type, 'Content-Length': String(stat.size) },
        body,
        duplex: 'half',
        signal: g.signal
      });
      if (!response.ok) {
        // The body of a storage error may echo parts of the signed request: only the status is reported.
        await response.arrayBuffer?.().catch(() => {});
        throw new FalError(`Upload zu fal.ai fehlgeschlagen (HTTP ${response.status}).`, response.status, { retryable: !isFatalStatus(response.status) });
      }
      await response.arrayBuffer?.().catch(() => {});
    } catch (err) {
      throw transportError('Upload zu fal.ai', err, g, signal, TIMEOUT_MS.put);
    } finally {
      g.done();
      body.destroy();
    }
    return { url: fileUrl, size: stat.size, contentType: type, fileName: name };
  }

  // Queues a job. The returned status and result URLs are authoritative (nested endpoint ids change the path).
  async function submit(endpointId, input, { signal } = {}) {
    const key = requireKey();
    if (!isValidEndpointId(endpointId)) throw new FalError('Ungueltige fal.ai-Endpoint-ID.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FalError('Die fal.ai-Eingabe muss ein Objekt sein.');
    const data = await requestJson(
      'fal.ai-Job senden',
      `${QUEUE_BASE}${endpointId}`,
      {
        method: 'POST',
        headers: authHeaders(key, { 'Content-Type': 'application/json', 'X-Fal-Object-Lifecycle-Preference': RESULT_LIFECYCLE_PREFERENCE }),
        body: JSON.stringify(input)
      },
      { timeoutMs: TIMEOUT_MS.submit, signal }
    );
    const requestId = data && typeof data.request_id === 'string' ? data.request_id.trim() : '';
    if (!requestId) throw new FalError('fal.ai lieferte keine request_id.');
    if (!isQueueUrl(data.status_url) || !isQueueUrl(data.response_url)) {
      throw new FalError('fal.ai lieferte keine gueltigen Queue-URLs (https://queue.fal.run/ erwartet).');
    }
    return { requestId, statusUrl: data.status_url, responseUrl: data.response_url };
  }

  async function getStatus(job, { signal } = {}) {
    const key = requireKey();
    if (!isQueueUrl(job?.statusUrl)) throw new FalError('Die fal.ai-Status-URL ist ungueltig.', 0, { retryable: false });
    const data = await requestJson('fal.ai-Status', job.statusUrl, { method: 'GET', headers: authHeaders(key) }, { timeoutMs: TIMEOUT_MS.status, signal });
    const status = String(data?.status || '').toUpperCase();
    const errorText = data && data.error !== undefined && data.error !== null && data.error !== '' ? clean(detailText(data.error) || 'unbekannter Fehler') : null;
    return {
      status,
      queuePosition: Number.isFinite(data?.queue_position) ? data.queue_position : null,
      error: errorText,
      errorType: typeof data?.error_type === 'string' ? data.error_type : null
    };
  }

  async function getResult(job, { signal } = {}) {
    const key = requireKey();
    if (!isQueueUrl(job?.responseUrl)) throw new FalError('Die fal.ai-Ergebnis-URL ist ungueltig.', 0, { retryable: false });
    const data = await requestJson('fal.ai-Ergebnis', job.responseUrl, { method: 'GET', headers: authHeaders(key) }, { timeoutMs: TIMEOUT_MS.result, signal });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new FalError('fal.ai lieferte kein gueltiges Ergebnis.', 0, { retryable: true });
    }
    return data;
  }

  // Streams a result file to destPath (never buffers it). Only fal hosts over https; the partial file is removed
  // when the size limit is exceeded or the transfer fails.
  async function downloadToFile(url, destPath, { maxBytes = MAX_DOWNLOAD_BYTES, signal, timeoutMs = TIMEOUT_MS.download } = {}) {
    let target = String(url || '').trim();
    const check = (value) => {
      let parsed;
      try {
        parsed = new URL(value);
      } catch (_) {
        throw new FalError('Die fal.ai-Ergebnis-URL ist ungueltig.');
      }
      if (parsed.protocol !== 'https:') throw new FalError('Die fal.ai-Ergebnis-URL muss https verwenden.');
      if (!isAllowedDownloadHost(parsed.hostname)) throw new FalError('Die fal.ai-Ergebnis-URL zeigt auf einen nicht erlaubten Host.');
      return parsed.toString();
    };
    target = check(target);

    const g = guard(signal, timeoutMs);
    let written = 0;
    // The job is already paid for: the message keeps the URL so the file can still be fetched by hand (kept 7 days).
    const tooLarge = () =>
      new FalError(
        `Das fal.ai-Ergebnis ist groesser als ${Math.round(maxBytes / (1024 * 1024))} MB und wurde nicht gespeichert. ` +
          `Es liegt bis zu 7 Tage bei fal.ai (Dashboard) und ist unter ${target} abrufbar.`
      );
    try {
      let response;
      for (let hop = 0; ; hop += 1) {
        response = await fetchRequest(target, { method: 'GET', redirect: 'manual', signal: g.signal });
        if (response.status >= 300 && response.status < 400 && response.headers?.get?.('location')) {
          if (hop >= MAX_REDIRECTS) throw new FalError('fal.ai-Download: zu viele Weiterleitungen.');
          target = check(new URL(response.headers.get('location'), target).toString());
          await response.arrayBuffer?.().catch(() => {});
          continue;
        }
        break;
      }
      if (!response.ok) {
        await response.arrayBuffer?.().catch(() => {});
        throw new FalError(`fal.ai-Download fehlgeschlagen (HTTP ${response.status}).`, response.status, { retryable: !isFatalStatus(response.status) });
      }
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw tooLarge();
      }
      if (!response.body) throw new FalError('Das fal.ai-Ergebnis enthielt keine Daten.', 0, { retryable: true });
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length;
          if (written > maxBytes) callback(tooLarge());
          else callback(null, chunk);
        }
      });
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await pipeline(Readable.from(response.body), counter, fs.createWriteStream(destPath), { signal: g.signal });
      if (written === 0) throw new FalError('fal.ai lieferte eine leere Ergebnisdatei.', 0, { retryable: true });
      return { bytes: written, contentType: response.headers?.get?.('content-type') || '' };
    } catch (err) {
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw transportError('fal.ai-Download', err, g, signal, timeoutMs);
    } finally {
      g.done();
    }
  }

  return { hasKey, uploadFile, submit, getStatus, getResult, downloadToFile };
}

function urlOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Media of a result, or null. `kind` is video, image, audio or auto (first hit in that order).
function extractMedia(result, kind = 'auto') {
  if (!result || typeof result !== 'object') return null;
  const pick = {
    video: () => {
      const file = result.video?.url !== undefined && result.video?.url !== null ? result.video : result.videos?.[0];
      return { url: urlOf(file?.url), contentType: file?.content_type };
    },
    image: () => {
      const file = result.images?.[0]?.url !== undefined && result.images?.[0]?.url !== null ? result.images[0] : result.image;
      return { url: urlOf(file?.url), contentType: file?.content_type };
    },
    audio: () => {
      const file = [result.audio, result.audio_file].find((item) => urlOf(item?.url));
      if (file) return { url: urlOf(file.url), contentType: file.content_type };
      return { url: urlOf(result.audio_url), contentType: undefined };
    }
  };
  const kinds = kind === 'auto' ? KIND_ORDER : [kind];
  for (const candidate of kinds) {
    if (!pick[candidate]) continue;
    const found = pick[candidate]();
    if (found.url) return { url: found.url, contentType: typeof found.contentType === 'string' ? found.contentType : '', kind: candidate };
  }
  return null;
}

const client = createFalClient();

module.exports = {
  FalError,
  abortError,
  createFalClient,
  isValidEndpointId,
  isAllowedDownloadHost,
  extractMedia,
  detailText,
  QUEUE_BASE,
  REST_BASE,
  MAX_UPLOAD_BYTES,
  MAX_DOWNLOAD_BYTES,
  TIMEOUT_MS,
  MISSING_KEY_MESSAGE,
  RESULT_LIFECYCLE_PREFERENCE,
  UPLOAD_LIFECYCLE,
  hasKey: client.hasKey,
  uploadFile: client.uploadFile,
  submit: client.submit,
  getStatus: client.getStatus,
  getResult: client.getResult,
  downloadToFile: client.downloadToFile
};
