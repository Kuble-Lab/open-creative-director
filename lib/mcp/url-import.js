'use strict';

// Files an agent brings in by address: the server downloads them itself (upload_asset with "url"). An agent whose own
// machine cannot reach the app (a cloud sandbox behind an allowlist, a chat connector that can only pass text) can still
// hand over a song, a video or a picture that lies somewhere on the internet: a Suno or CDN address, a Dropbox or Google
// Drive share link, a presigned storage link. Nothing goes through the model as base64.
//
//   createUrlImporter({ uploads, lookup?, transport?, limits?, now? })
//     start({ key, viewer, url, filename?, mimeType? })  checks the address and begins the download; resolves
//                                                        { id, done } (done: a promise of the result, see below)
//     status(keyId, id)                                  { state: 'running' | 'done' | 'failed', ...} or null
//     checkUrl(text)                                     the URL to fetch (share links made direct) or throws ImportError
//
// The result of a download is the result of uploads.save: { assetId, type, bytes, rasterized } plus the file name used.
//
// Protection (the server fetches what a key names, so it must not become a door into its own network):
//   - https only, port 443, no user:password in the address, at most 2048 characters
//   - every host name is resolved first and every address must be public (lib/mcp/oauth-clients.js publicAddress);
//     the connection goes to exactly the checked address (no second lookup that could be answered differently)
//   - redirects are followed by hand, at most 5, and every hop is checked the same way
//   - a web page (text/html) is refused: the address shows a page, not the file
//   - limits: the size limits of uploads (LINK_MAX_BYTES, smaller for documents and SVG), 20 s to the first byte,
//     30 s without data, 15 minutes in all; two downloads per key and six in all at the same time
//   - the storage limits of the key (lib/mcp/uploads.js) apply as for every upload

const crypto = require('crypto');
const dns = require('dns/promises');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');

const { publicAddress } = require('./oauth-clients');
const { LINK_MAX_BYTES, UploadError } = require('./uploads');

const LIMITS = Object.freeze({
  urlChars: 2048,
  redirects: 5,
  headersMs: 20 * 1000,
  idleMs: 30 * 1000,
  totalMs: 15 * 60 * 1000,
  perKey: 2,
  global: 6,
  keepMs: 60 * 60 * 1000, // how long the state of a finished download stays readable
  remembered: 500
});

// What a server says about a file it sends, when the address has no usable extension.
const MIME_EXT = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md'
});
const KNOWN_EXT = new Set(Object.values(MIME_EXT).concat(['.jpeg']));

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ImportError(code, message); };

// The address to fetch. Share links of Dropbox and Google Drive point to a page; they are made into their download address.
function checkUrl(text) {
  if (typeof text !== 'string' || !text.trim()) fail('INVALID_URL', 'url must be an https address.');
  const value = text.trim();
  if (value.length > LIMITS.urlChars) fail('INVALID_URL', `url is longer than ${LIMITS.urlChars} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(value)) fail('INVALID_URL', 'url contains spaces or control characters.');
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    fail('INVALID_URL', 'url is not a valid address.');
  }
  if (url.protocol !== 'https:') fail('INVALID_URL', 'Only https addresses can be fetched.');
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(value)) fail('INVALID_URL', 'An address with a user name or password cannot be fetched.');
  if (url.port && url.port !== '443') fail('INVALID_URL', 'Only the standard https port (443) can be fetched.');
  url.hash = '';
  const host = url.hostname.toLowerCase();
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    // ?dl=0 shows the preview page; dl=1 sends the file
    if (/^\/(s|scl|sh)\//.test(url.pathname)) {
      url.searchParams.delete('raw');
      url.searchParams.set('dl', '1');
    }
  } else if (host === 'drive.google.com') {
    const match = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,})/) || (url.pathname === '/open' || url.pathname === '/uc' ? [null, url.searchParams.get('id')] : null);
    if (match && match[1] && /^[A-Za-z0-9_-]{10,}$/.test(match[1])) {
      return new URL(`https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`);
    }
  }
  return url;
}

// The file name out of Content-Disposition (filename*=UTF-8''… first), or null.
function dispositionName(header) {
  const text = String(header || '');
  const star = text.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch (_) {
      /* fall through */
    }
  }
  const plain = text.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  return plain ? (plain[2] !== undefined ? plain[2] : plain[1]).trim() : null;
}

function lastSegment(url) {
  try {
    return decodeURIComponent(path.posix.basename(url.pathname || ''));
  } catch (_) {
    return path.posix.basename(url.pathname || '');
  }
}

const baseMime = (value) => String(value || '').split(';')[0].trim().toLowerCase();

// The name and media type the file is saved with: what the agent gave wins; then the name the server gives, then the
// last part of the address; a name without a known extension gets the one of the media type the server sent.
function nameAndType({ filename, mimeType, url, headers }) {
  const served = baseMime(headers['content-type']);
  let name = (typeof filename === 'string' && filename.trim()) || dispositionName(headers['content-disposition']) || lastSegment(url) || 'download';
  let ext = path.extname(name).toLowerCase();
  if (!KNOWN_EXT.has(ext) && MIME_EXT[served]) {
    name = `${name.replace(/\.+$/, '') || 'download'}${MIME_EXT[served]}`;
    ext = MIME_EXT[served];
  }
  // The type the agent named counts; else the extension decides (a CDN that sends audio as text/plain or as
  // application/octet-stream must not turn a song into a text file).
  const type = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim() : KNOWN_EXT.has(ext) ? '' : served;
  return { name, type };
}

// One GET to exactly the given addresses (TLS still checks the host name). Resolves the response stream.
function pinnedGet(url, { addresses, signal, headers }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal,
      headers,
      agent: false,
      lookup(_host, options, callback) {
        const records = addresses.map((item) => ({ address: item.address, family: net.isIP(item.address) }));
        if (options && options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }
    }, resolve);
    request.on('error', reject);
  });
}

function createUrlImporter({ uploads, lookup = dns.lookup, transport = pinnedGet, limits = {}, now = Date.now, random = crypto.randomBytes } = {}) {
  const max = { ...LIMITS, ...limits };
  const jobs = new Map(); // id -> { keyId, state, result?, error?, startedAt, endedAt? }
  const running = new Map(); // key id -> number of downloads
  let total = 0;

  function prune() {
    const cutoff = now() - max.keepMs;
    for (const [id, job] of jobs) {
      if (job.state !== 'running' && job.endedAt < cutoff) jobs.delete(id);
    }
    while (jobs.size > max.remembered) {
      const oldest = [...jobs].find(([, job]) => job.state !== 'running');
      if (!oldest) break;
      jobs.delete(oldest[0]);
    }
  }

  async function checkedAddresses(url) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (net.isIP(host)) addresses = [{ address: host }];
    else {
      try {
        addresses = await lookup(host, { all: true, verbatim: true });
      } catch (_) {
        fail('UNREACHABLE', `The host ${host} could not be found.`);
      }
    }
    if (!Array.isArray(addresses) || !addresses.length) fail('UNREACHABLE', `The host ${host} could not be found.`);
    if (!addresses.every((item) => publicAddress(item.address))) {
      fail('FORBIDDEN_ADDRESS', 'This address points into a private or local network and cannot be fetched. Use a public https link.');
    }
    return addresses;
  }

  // Follows redirects by hand; every hop is checked. Resolves { response, url } with a 200 response.
  async function open(first, signal) {
    let url = first;
    for (let hop = 0; ; hop += 1) {
      const addresses = await checkedAddresses(url);
      let response;
      try {
        response = await transport(url, { addresses, signal, headers: { 'User-Agent': 'OpenCreativeDirector-Import/1', Accept: '*/*' } });
      } catch (err) {
        if (signal.aborted) throw signal.reason || err;
        fail('UNREACHABLE', `The address could not be fetched (${String(err && (err.code || err.message) || 'error').slice(0, 80)}).`);
      }
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume?.();
        response.destroy?.();
        if (hop >= max.redirects) fail('TOO_MANY_REDIRECTS', `The address redirects more than ${max.redirects} times.`);
        const location = response.headers.location;
        if (!location) fail('UNREACHABLE', 'The address redirects without a target.');
        let next;
        try {
          next = new URL(location, url);
        } catch (_) {
          fail('UNREACHABLE', 'The address redirects to an invalid target.');
        }
        if (next.protocol !== 'https:') fail('INVALID_URL', 'The address redirects to a non-https address.');
        url = checkUrl(next.toString());
        continue;
      }
      if (status !== 200) {
        response.resume?.();
        response.destroy?.();
        const hint = status === 401 || status === 403 ? ' The file is not public: use a share link anybody can open, or a presigned link.' : '';
        fail('HTTP_STATUS', `The address answered with HTTP ${status}.${hint}`);
      }
      return { response, url };
    }
  }

  // Streams the body into `file`; resolves the number of bytes. Stops at maxBytes and after idleMs without data.
  function writeBody(response, file, maxBytes, signal) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, { flags: 'wx' });
      let bytes = 0;
      let settled = false;
      let idle = null;
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        signal.removeEventListener('abort', onAbort);
        if (err) {
          response.destroy();
          out.destroy();
          reject(err);
        } else resolve(value);
      };
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => settle(new ImportError('TIMEOUT', `The download stalled (no data for ${Math.round(max.idleMs / 1000)} s).`)), max.idleMs);
      };
      const onAbort = () => settle(signal.reason instanceof Error ? signal.reason : new ImportError('TIMEOUT', 'The download took too long.'));
      signal.addEventListener('abort', onAbort, { once: true });
      touch();
      out.on('error', (err) => settle(err));
      response.on('data', (chunk) => {
        if (settled) return;
        touch();
        bytes += chunk.length;
        if (bytes > maxBytes) {
          settle(new UploadError('TOO_LARGE', `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the limit for this type.`));
          return;
        }
        if (!out.write(chunk)) {
          response.pause();
          out.once('drain', () => response.resume());
        }
      });
      response.on('end', () => {
        if (settled) return;
        out.end(() => settle(null, bytes));
      });
      response.on('error', () => settle(new ImportError('UNREACHABLE', 'The download was interrupted.')));
      response.on('aborted', () => settle(new ImportError('UNREACHABLE', 'The download was interrupted.')));
    });
  }

  async function download({ key, viewer, url, filename, mimeType, signal }) {
    const headersTimer = setTimeout(() => controllerAbort(signal, new ImportError('TIMEOUT', `The address did not answer within ${Math.round(max.headersMs / 1000)} s.`)), max.headersMs);
    let opened;
    try {
      opened = await open(url, signal);
    } finally {
      clearTimeout(headersTimer);
    }
    const { response } = opened;
    try {
      const served = baseMime(response.headers['content-type']);
      if (served === 'text/html' || served === 'application/xhtml+xml') {
        fail('NOT_A_FILE', 'The address shows a web page, not a file. Use the direct download link of the file (for example the link of the file itself, not of the page that plays it).');
      }
      const { name, type } = nameAndType({ filename, mimeType, url: opened.url, headers: response.headers });
      const resolved = uploads.resolveType(name, type);
      const limit = uploads.limitFor(resolved, LINK_MAX_BYTES);
      const declared = Number.parseInt(response.headers['content-length'], 10);
      if (Number.isFinite(declared) && declared > limit) {
        fail('TOO_LARGE', `The file is ${Math.round(declared / (1024 * 1024))} MB, more than the ${Math.round(limit / (1024 * 1024))} MB allowed for this type.`);
      }
      const saved = await uploads.save({
        key,
        viewer,
        filename: name,
        mimeType: type,
        limitBytes: LINK_MAX_BYTES,
        expectedBytes: Number.isFinite(declared) ? declared : undefined,
        write: (file, maxBytes) => writeBody(response, file, maxBytes, signal)
      });
      return { ...saved, filename: path.basename(name) };
    } finally {
      response.destroy?.();
    }
  }

  // The headers timer aborts through the controller that owns the signal.
  const controllers = new WeakMap();
  function controllerAbort(signal, reason) {
    const controller = controllers.get(signal);
    if (controller && !signal.aborted) controller.abort(reason);
  }

  async function start({ key, viewer, url, filename, mimeType }) {
    const target = checkUrl(url);
    prune();
    if ((running.get(key.id) || 0) >= max.perKey) fail('BUSY', `This key is already fetching ${max.perKey} files. Wait until one is done (upload_asset with its import_id).`);
    if (total >= max.global) fail('BUSY', 'The app is fetching many files at the moment. Try again in a minute.');
    // a key with no room left is refused before anything is fetched
    await uploads.checkQuota(key, 0);
    const id = `imp_${random(12).toString('hex')}`;
    const controller = new AbortController();
    controllers.set(controller.signal, controller);
    const overall = setTimeout(() => controller.abort(new ImportError('TIMEOUT', `The download took longer than ${Math.round(max.totalMs / 60000)} minutes.`)), max.totalMs);
    overall.unref?.();
    const job = { keyId: key.id, state: 'running', startedAt: now(), url: `${target.protocol}//${target.host}${target.pathname}`.slice(0, 300) };
    jobs.set(id, job);
    running.set(key.id, (running.get(key.id) || 0) + 1);
    total += 1;
    const done = download({ key, viewer, url: target, filename, mimeType, signal: controller.signal })
      .then((result) => {
        job.state = 'done';
        job.result = result;
        return result;
      }, (err) => {
        job.state = 'failed';
        job.error = err;
        throw err;
      })
      .finally(() => {
        clearTimeout(overall);
        job.endedAt = now();
        const left = (running.get(key.id) || 1) - 1;
        if (left > 0) running.set(key.id, left);
        else running.delete(key.id);
        total -= 1;
      });
    job.promise = done.catch(() => {}); // the caller may stop waiting; the state keeps the error
    return { id, done };
  }

  function status(keyId, id) {
    const job = jobs.get(id);
    if (!job || job.keyId !== keyId) return null;
    return job;
  }

  return { start, status, checkUrl, limits: max };
}

module.exports = { createUrlImporter, checkUrl, dispositionName, nameAndType, ImportError, LIMITS };
