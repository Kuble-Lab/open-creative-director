'use strict';

// The two paths of the agent access that carry files, both without a login (the token in the path is the permission):
//
//   GET  /mcp/files/<token>    a result file; the token names exactly this one file (lib/mcp/links.js)
//   PUT  /mcp/upload/<token>   the body is the file; one use, 15 minutes, up to 500 MB (a link from the tool upload_asset)
//
// The upload takes the same type rules and the same storage as the upload of the node view (lib/mcp/uploads.js).

const path = require('path');

const store = require('../store');
const { LINK_MAX_BYTES, UploadError } = require('./uploads');

const DRAIN_TIMEOUT_MS = 10 * 1000;

function sendJson(res, status, body, headers = {}) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.status(status).type('application/json').send(JSON.stringify(body));
}

// Answers before the body was read: the connection closes after the answer and the rest of the body is thrown away.
function answerAndDrain(req, res, status, body) {
  res.set('Connection', 'close');
  sendJson(res, status, body);
  req.resume();
  const timer = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
  timer.unref?.();
  req.once('close', () => clearTimeout(timer));
}

// A key over one of its limits: 429 (try again later) for the hour limit, 413 for what it stores in all.
function answerQuota(req, res, err) {
  if (err.code === 'QUOTA_HOURLY') {
    res.set('Retry-After', '600');
    return answerAndDrain(req, res, 429, { error: 'quota_hourly', message: err.message });
  }
  return answerAndDrain(req, res, 413, { error: err.code === 'QUOTA_FILES' ? 'quota_files' : 'quota_storage', message: err.message });
}

function createFileHandler({ fileLinks }) {
  return function fileHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'This path serves files with GET only.' }, { Allow: 'GET, HEAD' });
    }
    const checked = fileLinks.verify(req.params.token);
    if (!checked.ok) {
      return checked.reason === 'expired'
        ? sendJson(res, 410, { error: 'link_expired', message: 'This link has expired. Ask for the run again (get_run) to get a new one.' })
        : sendJson(res, 404, { error: 'not_found', message: 'There is no file for this link.' });
    }
    const root = store.sessionAssetDir(checked.sessionId);
    res.set({
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': checked.contentType,
      'Content-Disposition': `inline; filename="${checked.file}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    return res.sendFile(checked.file, { root, dotfiles: 'deny', acceptRanges: true, cacheControl: false, lastModified: true, etag: true }, (err) => {
      if (err && !res.headersSent) sendJson(res, 404, { error: 'not_found', message: 'There is no file for this link.' });
    });
  };
}

function createUploadHandler({ uploadLinks, uploads, keys }) {
  return async function uploadHandler(req, res) {
    try {
      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'This path takes a PUT with the file as the body.' }, { Allow: 'PUT' });
      const token = req.params.token;
      const found = uploadLinks.look(token);
      if (!found.ok) {
        const text = {
          expired: ['upload_link_expired', 'This upload link has expired. Ask upload_asset for a new one.', 410],
          used: ['upload_link_used', 'This upload link was used already. Ask upload_asset for a new one.', 410],
          invalid: ['not_found', 'There is no upload for this link.', 404]
        }[found.reason];
        return answerAndDrain(req, res, text[2], { error: text[0], message: text[1] });
      }
      const link = found.link;
      // the link stops working with its key: revoked, expired, or the person may no longer use it
      const key = keys.get(link.keyId);
      const viewer = key && key.status === 'active' ? keys.viewerOfOwner(key.owner) : null;
      if (!key || !viewer) return answerAndDrain(req, res, 403, { error: 'key_invalid', message: 'The key this link belongs to no longer works.' });
      if (key.right !== 'start') return answerAndDrain(req, res, 403, { error: 'key_read_only', message: 'The key this link belongs to may only read.' });

      const routes = require('../nodes/routes');
      let resolved;
      try {
        resolved = uploads.resolveType(link.filename, link.mimeType);
      } catch (err) {
        return answerAndDrain(req, res, 415, { error: 'unsupported_media', message: err.message });
      }
      const limit = resolved.svg ? Math.min(LINK_MAX_BYTES, routes.MAX_SVG_BYTES) : LINK_MAX_BYTES;
      const declared = Number.parseInt(req.headers['content-length'], 10);
      if (Number.isFinite(declared) && declared > limit) {
        return answerAndDrain(req, res, 413, { error: 'too_large', message: `The file is larger than ${Math.round(limit / (1024 * 1024))} MB.` });
      }
      // room first: a link that cannot be used is not burnt
      try {
        await uploads.checkQuota(key, Number.isFinite(declared) ? declared : 0);
      } catch (err) {
        if (err instanceof UploadError && /^QUOTA_/.test(err.code)) return answerQuota(req, res, err);
        throw err;
      }
      if (!uploadLinks.consume(token)) return answerAndDrain(req, res, 410, { error: 'upload_link_used', message: 'This upload link was used already. Ask upload_asset for a new one.' });

      let saved;
      try {
        saved = await uploads.save({
          key,
          viewer,
          filename: link.filename,
          mimeType: link.mimeType,
          limitBytes: LINK_MAX_BYTES,
          expectedBytes: Number.isFinite(declared) ? declared : undefined,
          write: (file, max) => routes.receiveBody(req, file, max)
        });
      } catch (err) {
        if (err && err.code === 'UPLOAD_ABORTED') return undefined; // nobody is listening any more
        if (err && err.code === 'TOO_LARGE') return answerAndDrain(req, res, 413, { error: 'too_large', message: 'The file is larger than the limit.' });
        if (err && (err.code === 'EMPTY' || err.code === 'INVALID_REQUEST')) return answerAndDrain(req, res, 400, { error: 'empty_upload', message: 'The body is empty. Send the file itself as the body of the PUT.' });
        if (err instanceof UploadError && /^QUOTA_/.test(err.code)) return answerQuota(req, res, err);
        if (err instanceof UploadError && err.code === 'CONTENT_MISMATCH') return answerAndDrain(req, res, 415, { error: 'content_mismatch', message: err.message });
        if (err && err.code === 'UNSUPPORTED_MEDIA') return answerAndDrain(req, res, 415, { error: 'unsupported_media', message: 'The file could not be used as image, video or audio.' });
        throw err;
      }
      return sendJson(res, 201, { asset_id: saved.assetId, type: saved.type, filename: path.basename(link.filename), bytes: saved.bytes, ...(saved.rasterized ? { note: 'The SVG was made a PNG; the asset is the PNG.' } : {}) });
    } catch (err) {
      console.warn(`[mcp] Upload fehlgeschlagen: ${String((err && (err.code || err.name)) || 'Fehler')}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'upload_failed', message: 'The upload failed. Try again with a new link.' });
      return undefined;
    }
  };
}

module.exports = { createFileHandler, createUploadHandler };
