'use strict';

// Dropbox as an archive for the storage overview (lib/storage-overview.js): a file is uploaded, checked against the content
// hash Dropbox computes, and only then removed from the server; it can be fetched back the same way.
//
// One Dropbox account for the whole installation, connected by an admin on the storage page. The connection uses the
// code flow with PKCE and no redirect: the admin enters the key of their own Dropbox app, opens the Dropbox page, allows the
// access and pastes the code Dropbox shows. No app secret is needed and nothing has to be put into .env. The refresh token is
// kept in data/dropbox-archive.json (mode 600) and never leaves the server.
// An app of the kind "App folder" keeps everything inside Apps/<name of the app>/ of that Dropbox.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { PATHS } = require('./config');

const fsp = fs.promises;

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
// Dropbox hashes a file in blocks of 4 MB (content_hash): SHA-256 of every block, then SHA-256 of the joined digests.
const HASH_BLOCK = 4 * 1024 * 1024;
// One request per chunk of an upload session; a multiple of the hash block.
const UPLOAD_CHUNK = 4 * HASH_BLOCK;
const PENDING_TTL_MS = 15 * 60 * 1000;
const APP_KEY = /^[a-z0-9]{8,32}$/i;

class ArchiveError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The JSON of the Dropbox-API-Arg header must be plain ASCII.
function headerJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Computes the Dropbox content hash of the bytes written to it, in whatever pieces they arrive.
function createContentHasher() {
  const digests = [];
  let block = crypto.createHash('sha256');
  let filled = 0;
  return {
    update(buffer) {
      let offset = 0;
      while (offset < buffer.length) {
        const take = Math.min(HASH_BLOCK - filled, buffer.length - offset);
        block.update(buffer.subarray(offset, offset + take));
        filled += take;
        offset += take;
        if (filled === HASH_BLOCK) {
          digests.push(block.digest());
          block = crypto.createHash('sha256');
          filled = 0;
        }
      }
    },
    digest() {
      if (filled > 0) digests.push(block.digest());
      return crypto.createHash('sha256').update(Buffer.concat(digests)).digest('hex');
    }
  };
}

function createDropboxArchive({ file = path.join(PATHS.root, 'data', 'dropbox-archive.json'), fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let state = null;
  let access = null; // { token, expiresAt }
  let pending = null; // { appKey, verifier, at }
  let spaceCache = null;

  function read() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      state = {};
    }
    return state;
  }

  function write(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    state = next;
  }

  const connected = () => Boolean(read().refreshToken && read().appKey);

  // What the page may know: never a token.
  function status() {
    const current = read();
    return { connected: connected(), account: connected() ? current.account || null : null, connectedAt: connected() ? current.connectedAt || null : null };
  }

  async function tokenRequest(params) {
    let response;
    try {
      response = await fetchImpl(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString()
      });
    } catch (err) {
      throw new ArchiveError('DROPBOX_UNREACHABLE', 'Dropbox ist nicht erreichbar.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const invalid = body.error === 'invalid_grant';
      throw new ArchiveError(invalid ? 'DROPBOX_GRANT' : 'DROPBOX_AUTH', invalid ? 'Dropbox hat den Code oder die Verbindung abgelehnt. Bitte neu verbinden.' : 'Die Anmeldung bei Dropbox ist fehlgeschlagen.', invalid ? 400 : 502);
    }
    return body;
  }

  // Step 1: the address of the Dropbox page that shows the code.
  function startConnect(appKey) {
    const key = String(appKey || '').trim();
    if (!APP_KEY.test(key)) throw new ArchiveError('INVALID_APP_KEY', 'Das ist kein gültiger App-Key.', 400);
    const verifier = base64url(crypto.randomBytes(48));
    pending = { appKey: key, verifier, at: now() };
    const query = new URLSearchParams({
      client_id: key,
      response_type: 'code',
      code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      token_access_type: 'offline'
    });
    return { url: `${AUTHORIZE_URL}?${query}` };
  }

  // Step 2: the code Dropbox showed becomes the stored connection.
  async function finishConnect(code) {
    const value = String(code || '').trim();
    if (!pending || now() - pending.at > PENDING_TTL_MS) throw new ArchiveError('NO_PENDING', 'Bitte die Verbindung neu starten.', 400);
    if (!value || value.length > 512) throw new ArchiveError('INVALID_CODE', 'Bitte den Code von Dropbox einfügen.', 400);
    const { appKey, verifier } = pending;
    const body = await tokenRequest({ code: value, grant_type: 'authorization_code', code_verifier: verifier, client_id: appKey });
    if (!body.refresh_token) throw new ArchiveError('DROPBOX_AUTH', 'Dropbox hat keine dauerhafte Verbindung ausgestellt.');
    pending = null;
    access = { token: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 };
    write({ appKey, refreshToken: body.refresh_token, account: null, connectedAt: new Date(now()).toISOString() });
    spaceCache = null;
    try {
      const account = await rpc('/2/users/get_current_account', null);
      write({ ...read(), account: account.email || account.name?.display_name || null });
    } catch (_) {
      /* the name is only for display */
    }
    return status();
  }

  // Forgets the connection. What is in the Dropbox stays there.
  function disconnect() {
    access = null;
    pending = null;
    spaceCache = null;
    write({});
    return status();
  }

  async function accessToken(force = false) {
    if (!connected()) throw new ArchiveError('NOT_CONNECTED', 'Dropbox ist nicht verbunden.', 409);
    if (!force && access && access.expiresAt - now() > 60000) return access.token;
    const current = read();
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.appKey });
    access = { token: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 };
    return access.token;
  }

  // One call with the current token; a 401 gets one more try with a fresh token.
  async function call(url, build) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await accessToken(attempt > 0);
      const options = build();
      let response;
      try {
        response = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      } catch (err) {
        throw new ArchiveError('DROPBOX_UNREACHABLE', 'Dropbox ist nicht erreichbar.');
      }
      if (response.status === 401 && attempt === 0) continue;
      return response;
    }
    throw new ArchiveError('DROPBOX_AUTH', 'Die Anmeldung bei Dropbox ist fehlgeschlagen.');
  }

  async function failure(response) {
    const text = await response.text().catch(() => '');
    let summary = '';
    try {
      summary = String(JSON.parse(text).error_summary || '');
    } catch (_) {
      summary = text.slice(0, 200);
    }
    if (/insufficient_space/.test(summary)) return new ArchiveError('DROPBOX_FULL', 'In der Dropbox ist nicht genug Platz.', 507);
    if (/not_found/.test(summary)) return new ArchiveError('DROPBOX_NOT_FOUND', 'Die Datei liegt nicht mehr in der Dropbox.', 404);
    if (/missing_scope|not_permitted|no_write_permission/.test(summary)) return new ArchiveError('DROPBOX_SCOPE', 'Der Dropbox-App fehlt die Berechtigung zum Lesen und Schreiben von Dateien.', 403);
    return new ArchiveError('DROPBOX_ERROR', `Dropbox meldet einen Fehler (${response.status}${summary ? `: ${summary.slice(0, 120)}` : ''}).`);
  }

  async function rpc(endpoint, arg) {
    const response = await call(`${API}${endpoint}`, () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arg) }));
    if (!response.ok) throw await failure(response);
    return response.json();
  }

  async function content(endpoint, arg, body) {
    const response = await call(`${CONTENT}${endpoint}`, () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson(arg) },
      body
    }));
    if (!response.ok) throw await failure(response);
    return response;
  }

  // Uploads a local file to `remotePath` (replacing what is there) and returns what Dropbox stored. Throws unless the
  // content hash of Dropbox equals the one of the bytes that were read here.
  async function upload(localFile, remotePath, { onProgress = () => {} } = {}) {
    const handle = await fsp.open(localFile, 'r');
    const hasher = createContentHasher();
    const commit = { path: remotePath, mode: 'overwrite', mute: true };
    try {
      const { size } = await handle.stat();
      let offset = 0;
      let sessionId = null;
      let metadata = null;
      const readChunk = async () => {
        const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_CHUNK, size - offset));
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, offset + filled);
          if (!bytesRead) throw new ArchiveError('FILE_CHANGED', 'Die Datei hat sich während des Hochladens geändert.', 409);
          filled += bytesRead;
        }
        hasher.update(buffer);
        return buffer;
      };
      if (size <= UPLOAD_CHUNK) {
        const buffer = await readChunk();
        metadata = await (await content('/2/files/upload', commit, buffer)).json();
        offset = size;
      } else {
        sessionId = (await (await content('/2/files/upload_session/start', { close: false }, Buffer.alloc(0))).json()).session_id;
        while (size - offset > UPLOAD_CHUNK) {
          const buffer = await readChunk();
          await content('/2/files/upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, buffer);
          offset += buffer.length;
          onProgress(offset / size);
        }
        const last = await readChunk();
        metadata = await (await content('/2/files/upload_session/finish', { cursor: { session_id: sessionId, offset }, commit }, last)).json();
        offset += last.length;
      }
      const contentHash = hasher.digest();
      if (Number(metadata.size) !== size || metadata.content_hash !== contentHash) {
        throw new ArchiveError('VERIFY_FAILED', 'Die Kopie in der Dropbox stimmt nicht mit der Datei überein. Die Datei bleibt auf dem Server.');
      }
      onProgress(1);
      spaceCache = null;
      return { path: metadata.path_display || remotePath, size, contentHash };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // Downloads `remotePath` into `targetFile` (written next to it first, moved into place only when size and hash are right).
  async function download(remotePath, targetFile, { size = null, contentHash = null } = {}) {
    const response = await call(`${CONTENT}/2/files/download`, () => ({ method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path: remotePath }) } }));
    if (!response.ok) throw await failure(response);
    const temporary = `${targetFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const hasher = createContentHasher();
    let bytes = 0;
    try {
      await fsp.mkdir(path.dirname(targetFile), { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            hasher.update(chunk);
            done(null, chunk);
          }
        }),
        fs.createWriteStream(temporary)
      );
      if ((size !== null && bytes !== size) || (contentHash && hasher.digest() !== contentHash)) {
        throw new ArchiveError('VERIFY_FAILED', 'Die Datei aus der Dropbox ist unvollständig oder verändert. Sie bleibt im Archiv.');
      }
      await fsp.rename(temporary, targetFile);
      return { size: bytes };
    } catch (err) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError('DOWNLOAD_FAILED', 'Das Herunterladen aus der Dropbox ist fehlgeschlagen.');
    }
  }

  // Removes a file from the Dropbox. A file that is already gone counts as removed.
  async function remove(remotePath) {
    try {
      await rpc('/2/files/delete_v2', { path: remotePath });
    } catch (err) {
      if (!(err instanceof ArchiveError) || err.code !== 'DROPBOX_NOT_FOUND') throw err;
    }
    spaceCache = null;
  }

  // { used, total } of the Dropbox in bytes, or null when it cannot be read (not connected, no permission, no network).
  async function space() {
    if (!connected()) return null;
    if (spaceCache && now() - spaceCache.at < 60000) return spaceCache.value;
    let value = null;
    try {
      const usage = await rpc('/2/users/get_space_usage', null);
      const total = Number(usage.allocation?.allocated);
      const used = Number(usage.allocation?.used ?? usage.used);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) value = { used, total, free: Math.max(0, total - used) };
    } catch (_) {
      value = null;
    }
    spaceCache = { at: now(), value };
    return value;
  }

  return { status, startConnect, finishConnect, disconnect, upload, download, remove, space, isConnected: connected };
}

module.exports = { createDropboxArchive, createContentHasher, ArchiveError, HASH_BLOCK, UPLOAD_CHUNK };
