'use strict';

// fal.ai connection (lib/fal.js), the node-only tool fal_generate (lib/tools.js) and the fal branch of the poller
// (lib/poller.js). No network: lib/fal.js gets an injected fetch, the poller and the tool run against a patched
// module object. Sessions and temp files are removed at the end.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const costs = require('../lib/costs');
const fal = require('../lib/fal');
const or = require('../lib/openrouter');
const rendernode = require('../lib/rendernode');
const higgsfield = require('../lib/higgsfield');
const poller = require('../lib/poller');
const tools = require('../lib/tools');

const KEY = 'fal-test-key-0123456789:SECRETSECRET';
const MB = 1024 * 1024;

/* ---------- mock plumbing ---------- */

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

function jsonResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
    body: null
  };
}

// A download response whose body is a lazily produced stream; arrayBuffer/text must never be used (no buffering).
function streamResponse(chunks, { status = 200, headers = {}, onPull, onCancel, delayMs = 0 } = {}) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (delayMs && index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (onPull) onPull(index);
      if (index >= chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
    cancel() {
      if (onCancel) onCancel();
    }
  });
  const fail = async () => {
    throw new Error('the download must be streamed, not buffered');
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: fail,
    arrayBuffer: status >= 200 && status < 300 ? fail : async () => Buffer.alloc(0),
    body
  };
}

async function readBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function makeClient(fetchImpl, key = KEY) {
  return fal.createFalClient({ fetchImpl, getKey: () => key });
}

async function rejects(promise, pattern, check) {
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected a rejection');
  if (pattern) assert.match(error.message, pattern);
  if (check) check(error);
  return error;
}

/* ---------- lib/fal.js ---------- */

function testEndpointIds() {
  for (const id of ['minimax/h3-max/text-to-video', 'fal-ai/flux/dev', 'minimax/h3-max/lip-sync/image-to-video', 'minimax/h3-max/styles/16bit-pixel', 'fal-ai/foo.bar/v1.5']) {
    assert.equal(fal.isValidEndpointId(id), true, id);
  }
  for (const id of ['', 'flux', '/fal-ai/flux', 'fal-ai//flux', 'Fal-AI/Flux', 'fal-ai/flux dev', 'fal-ai/../etc', '../fal-ai/flux', 'fal-ai/flux?x=1', 'https://queue.fal.run/fal-ai/flux', 'a/b/c/d/e/f/g', null, 42]) {
    assert.equal(fal.isValidEndpointId(id), false, String(id));
  }
}

function testExtractMedia() {
  const video = { video: { url: 'https://v3b.fal.media/a.mp4', content_type: 'video/mp4' } };
  assert.deepEqual(fal.extractMedia(video, 'video'), { url: 'https://v3b.fal.media/a.mp4', contentType: 'video/mp4', kind: 'video' });
  assert.equal(fal.extractMedia({ videos: [{ url: 'https://v3b.fal.media/b.mp4' }] }, 'video').url, 'https://v3b.fal.media/b.mp4');
  assert.equal(fal.extractMedia({ images: [{ url: 'https://v3b.fal.media/i.png' }] }, 'image').url, 'https://v3b.fal.media/i.png');
  assert.equal(fal.extractMedia({ image: { url: 'https://v3b.fal.media/j.png' } }, 'image').url, 'https://v3b.fal.media/j.png');
  assert.equal(fal.extractMedia({ audio: { url: 'https://v3b.fal.media/a.mp3' } }, 'audio').url, 'https://v3b.fal.media/a.mp3');
  assert.equal(fal.extractMedia({ audio_file: { url: 'https://v3b.fal.media/f.mp3' } }, 'audio').url, 'https://v3b.fal.media/f.mp3');
  assert.equal(fal.extractMedia({ audio_url: 'https://v3b.fal.media/u.mp3' }, 'audio').url, 'https://v3b.fal.media/u.mp3');
  // wrong kind, empty, garbage
  assert.equal(fal.extractMedia(video, 'image'), null);
  assert.equal(fal.extractMedia({ video: {} }, 'video'), null);
  assert.equal(fal.extractMedia({ video: { url: '  ' } }, 'auto'), null);
  assert.equal(fal.extractMedia(null, 'auto'), null);
  assert.equal(fal.extractMedia('text', 'auto'), null);
  // auto: video, then image, then audio
  const all = { audio: { url: 'https://v3b.fal.media/a.mp3' }, images: [{ url: 'https://v3b.fal.media/i.png' }], video: { url: 'https://v3b.fal.media/v.mp4' } };
  assert.equal(fal.extractMedia(all, 'auto').kind, 'video');
  delete all.video;
  assert.equal(fal.extractMedia(all, 'auto').kind, 'image');
  delete all.images;
  assert.equal(fal.extractMedia(all, 'auto').kind, 'audio');
  assert.equal(fal.extractMedia({ video: { url: 'https://v3b.fal.media/v.mp4' } }).kind, 'video');
}

async function testMissingKey(tmpDir) {
  const calls = [];
  const client = makeClient(async (...args) => {
    calls.push(args);
    return jsonResponse(200, {});
  }, '');
  assert.equal(client.hasKey(), false);
  const file = path.join(tmpDir, 'a.png');
  await fsp.writeFile(file, 'x');
  await rejects(client.uploadFile(file, { contentType: 'image/png' }), /FAL_KEY/);
  await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /FAL_KEY/);
  await rejects(client.getStatus({ statusUrl: 'https://queue.fal.run/x/requests/1/status' }), /FAL_KEY/);
  await rejects(client.getResult({ responseUrl: 'https://queue.fal.run/x/requests/1' }), /FAL_KEY/);
  assert.equal(calls.length, 0, 'no request without a key');
  assert.equal(makeClient(async () => jsonResponse(200, {}), '  ').hasKey(), false);
  assert.equal(makeClient(async () => jsonResponse(200, {})).hasKey(), true);
}

async function testUpload(tmpDir) {
  const file = path.join(tmpDir, 'portrait.png');
  const bytes = Buffer.from('portrait-bytes-'.repeat(50));
  await fsp.writeFile(file, bytes);
  const calls = [];
  let putBody = null;
  const client = makeClient(async (url, init) => {
    const record = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(record);
    if (url.startsWith('https://rest.fal.ai/')) {
      return jsonResponse(200, { upload_url: 'https://storage.example.test/upload/abc?X-Sig=TOPSECRET', file_url: 'https://v3b.fal.media/files/b/portrait.png' });
    }
    putBody = await readBody(init.body);
    return jsonResponse(200, '');
  });

  const uploaded = await client.uploadFile(file, { contentType: 'image/png', fileName: '../we ird/name?.png' });
  assert.equal(uploaded.url, 'https://v3b.fal.media/files/b/portrait.png');
  assert.equal(uploaded.size, bytes.length);
  assert.equal(calls.length, 2);
  const [initiate, put] = calls;
  assert.equal(initiate.url, 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3');
  assert.equal(initiate.method, 'POST');
  assert.equal(initiate.headers.Authorization, `Key ${KEY}`);
  assert.equal(initiate.headers['Content-Type'], 'application/json');
  assert.equal(initiate.headers['X-Fal-Object-Lifecycle'], '{"expiration_duration_seconds":86400}');
  const initiateBody = JSON.parse(initiate.body);
  assert.equal(initiateBody.content_type, 'image/png');
  assert.equal(initiateBody.file_name, 'name_.png', 'the file name is sanitised and has no path');
  assert.equal(put.url, 'https://storage.example.test/upload/abc?X-Sig=TOPSECRET');
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['Content-Type'], 'image/png');
  assert.equal(put.headers['Content-Length'], String(bytes.length));
  assert.equal(put.headers.Authorization, undefined, 'the storage URL is signed: the key is not sent there');
  assert.deepEqual(putBody, bytes, 'the file is streamed as the PUT body');
  assert.equal(typeof put.body.pipe, 'function', 'a stream, not a buffer');

  // non-https upload or file URLs are refused
  for (const answer of [
    { upload_url: 'http://storage.example.test/up', file_url: 'https://v3b.fal.media/x.png' },
    { upload_url: 'https://storage.example.test/up', file_url: 'http://v3b.fal.media/x.png' },
    { upload_url: 'https://storage.example.test/up' },
    {}
  ]) {
    const seen = [];
    const bad = makeClient(async (url, init) => {
      seen.push(init.method);
      return jsonResponse(200, answer);
    });
    await rejects(bad.uploadFile(file, { contentType: 'image/png' }), /Upload-Adresse/);
    assert.deepEqual(seen, ['POST'], 'no PUT after a bad initiate answer');
  }

  // errors never contain the signed URL, the key or the storage answer
  const echo = makeClient(async (url, init) => {
    if (url.startsWith('https://rest.fal.ai/')) return jsonResponse(200, { upload_url: 'https://storage.example.test/upload/abc?X-Sig=TOPSECRET', file_url: 'https://v3b.fal.media/x.png' });
    return jsonResponse(403, `<Error><Code>SignatureDoesNotMatch</Code><Message>${url} ${KEY}</Message></Error>`);
  });
  const putError = await rejects(echo.uploadFile(file, { contentType: 'image/png' }), /HTTP 403/);
  for (const secret of ['TOPSECRET', 'storage.example.test', KEY, 'SECRETSECRET']) assert.ok(!putError.message.includes(secret), `no ${secret} in the message`);
  assert.equal(putError.retryable, false);

  const initiateEcho = makeClient(async (url) =>
    jsonResponse(500, JSON.stringify({ detail: `boom at ${url} with ${KEY} and https://v3b.fal.media/files/signed?token=ABC` }))
  );
  const initiateError = await rejects(initiateEcho.uploadFile(file, { contentType: 'image/png' }), /HTTP 500/);
  for (const secret of [KEY, 'SECRETSECRET', 'token=ABC', 'rest.fal.ai']) assert.ok(!initiateError.message.includes(secret), `no ${secret} in the message`);
  assert.equal(initiateError.retryable, true, '5xx may go away');
  assert.ok(initiateError.message.length <= 400);

  // rejected key
  const unauthorised = makeClient(async () => jsonResponse(401, { detail: 'Invalid key' }));
  const authError = await rejects(unauthorised.uploadFile(file, { contentType: 'image/png' }), /FAL_KEY/);
  assert.equal(authError.status, 401);
  assert.equal(authError.retryable, false);

  // 90 MB cap: nothing is requested for a bigger file (sparse file), empty and missing files fail before any request
  const huge = path.join(tmpDir, 'huge.mp4');
  const handle = await fsp.open(huge, 'w');
  await handle.truncate(90 * MB + 1);
  await handle.close();
  let requests = 0;
  const strict = makeClient(async () => {
    requests += 1;
    return jsonResponse(200, {});
  });
  await rejects(strict.uploadFile(huge, { contentType: 'video/mp4' }), /groesser als 90 MB/);
  const exact = path.join(tmpDir, 'exact.mp4');
  const exactHandle = await fsp.open(exact, 'w');
  await exactHandle.truncate(90 * MB);
  await exactHandle.close();
  assert.equal(fal.MAX_UPLOAD_BYTES, 90 * MB);
  const empty = path.join(tmpDir, 'empty.png');
  await fsp.writeFile(empty, '');
  await rejects(strict.uploadFile(empty, { contentType: 'image/png' }), /leer/);
  await rejects(strict.uploadFile(path.join(tmpDir, 'missing.png'), { contentType: 'image/png' }), /fehlt/);
  assert.equal(requests, 0);

  // timeouts and network errors are retryable and clean
  const offline = makeClient(async () => {
    throw new Error(`connect ECONNREFUSED https://rest.fal.ai/x ${KEY}`);
  });
  const networkError = await rejects(offline.uploadFile(file, { contentType: 'image/png' }), /fehlgeschlagen/);
  assert.equal(networkError.retryable, true);
  assert.ok(!networkError.message.includes(KEY));

  // a caller abort stays an AbortError
  const controller = new AbortController();
  controller.abort();
  const aborting = makeClient(async (url, init) => {
    if (init.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return jsonResponse(200, {});
  });
  await rejects(aborting.uploadFile(file, { contentType: 'image/png', signal: controller.signal }), null, (err) => assert.equal(err.name, 'AbortError'));
}

async function testSubmitAndStatus() {
  const calls = [];
  const queued = {
    request_id: 'req-123',
    status_url: 'https://queue.fal.run/minimax/h3-max/requests/req-123/status',
    response_url: 'https://queue.fal.run/minimax/h3-max/requests/req-123',
    cancel_url: 'https://queue.fal.run/minimax/h3-max/requests/req-123/cancel'
  };
  let answer = () => jsonResponse(200, queued);
  const client = makeClient(async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  });

  const job = await client.submit('minimax/h3-max/text-to-video', { prompt: 'a cat', duration: 5 });
  assert.deepEqual(job, { requestId: 'req-123', statusUrl: queued.status_url, responseUrl: queued.response_url });
  assert.equal(calls[0].url, 'https://queue.fal.run/minimax/h3-max/text-to-video');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Key ${KEY}`);
  assert.equal(calls[0].init.headers['X-Fal-Object-Lifecycle-Preference'], '{"expiration_duration_seconds":604800}');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'a cat', duration: 5 });

  // input and endpoint are checked before any request
  const before = calls.length;
  await rejects(client.submit('not a valid id', { prompt: 'x' }), /Endpoint-ID/);
  await rejects(client.submit('minimax/h3-max/text-to-video', null), /Objekt/);
  await rejects(client.submit('minimax/h3-max/text-to-video', ['x']), /Objekt/);
  assert.equal(calls.length, before);

  // the answer must carry a request id and queue URLs on https://queue.fal.run/
  for (const bad of [
    { ...queued, request_id: '' },
    { ...queued, status_url: 'https://evil.example.com/status' },
    { ...queued, response_url: 'http://queue.fal.run/x' },
    { ...queued, status_url: undefined },
    {}
  ]) {
    answer = () => jsonResponse(200, bad);
    await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /request_id|Queue-URLs/);
  }

  // validation errors (422 with a detail list) name the fields; never retried
  answer = () =>
    jsonResponse(422, {
      detail: [
        { loc: ['body', 'duration'], msg: 'Input should be less than or equal to 15', type: 'less_than_equal' },
        { loc: ['body', 'prompt'], msg: 'Field required', type: 'missing' }
      ]
    });
  const validation = await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /HTTP 422/);
  assert.match(validation.message, /duration: Input should be less than or equal to 15/);
  assert.match(validation.message, /prompt: Field required/);
  assert.equal(validation.retryable, false);
  answer = () => jsonResponse(400, { detail: 'plain string detail' });
  assert.match((await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /HTTP 400/)).message, /plain string detail/);
  answer = () => jsonResponse(503, '<html>Bad gateway</html>');
  const unavailable = await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /HTTP 503/);
  assert.equal(unavailable.retryable, true);
  assert.ok(!unavailable.message.includes('<html>'));
  answer = () => jsonResponse(429, { detail: 'slow down' });
  assert.equal((await rejects(client.submit('minimax/h3-max/text-to-video', { prompt: 'x' }), /HTTP 429/)).retryable, true);

  // status mapping
  const ref = { statusUrl: queued.status_url, responseUrl: queued.response_url };
  answer = () => jsonResponse(200, { status: 'IN_QUEUE', queue_position: 3 });
  assert.deepEqual(await client.getStatus(ref), { status: 'IN_QUEUE', queuePosition: 3, error: null, errorType: null });
  assert.equal(calls[calls.length - 1].url, queued.status_url);
  assert.equal(calls[calls.length - 1].init.method, 'GET');
  assert.equal(calls[calls.length - 1].init.headers.Authorization, `Key ${KEY}`);
  answer = () => jsonResponse(200, { status: 'in_progress' });
  assert.equal((await client.getStatus(ref)).status, 'IN_PROGRESS');
  answer = () => jsonResponse(200, { status: 'COMPLETED' });
  assert.deepEqual(await client.getStatus(ref), { status: 'COMPLETED', queuePosition: null, error: null, errorType: null });
  answer = () => jsonResponse(200, { status: 'COMPLETED', error: 'Content policy violation https://v3b.fal.media/x?token=SIGNED', error_type: 'content_policy' });
  const failed = await client.getStatus(ref);
  assert.equal(failed.status, 'COMPLETED');
  assert.match(failed.error, /Content policy violation/);
  assert.ok(!failed.error.includes('SIGNED'), 'signed URLs are removed from the error');
  assert.equal(failed.errorType, 'content_policy');
  answer = () => jsonResponse(200, { status: 'COMPLETED', error: { message: 'Model crashed', code: 1 } });
  assert.equal((await client.getStatus(ref)).error, 'Model crashed');
  await rejects(client.getStatus({ statusUrl: 'https://evil.example.com/status' }), /Status-URL/, (err) => assert.equal(err.retryable, false));
  await rejects(client.getStatus({}), /Status-URL/);
  answer = () => jsonResponse(404, { detail: 'Request not found' });
  const missing = await rejects(client.getStatus(ref), /HTTP 404/);
  assert.equal(missing.status, 404);
  assert.equal(missing.retryable, false);
  answer = () => jsonResponse(200, 'not json');
  assert.equal((await rejects(client.getStatus(ref), /JSON/)).retryable, true);

  // result
  answer = () => jsonResponse(200, { video: { url: 'https://v3b.fal.media/f.mp4' }, seed: 7 });
  assert.deepEqual(await client.getResult(ref), { video: { url: 'https://v3b.fal.media/f.mp4' }, seed: 7 });
  assert.equal(calls[calls.length - 1].url, queued.response_url);
  answer = () => jsonResponse(422, { detail: [{ loc: ['body', 'image_url'], msg: 'Image could not be loaded', type: 'x' }] });
  const resultError = await rejects(client.getResult(ref), /HTTP 422/);
  assert.match(resultError.message, /image_url: Image could not be loaded/);
  answer = () => jsonResponse(200, '[1,2]');
  await rejects(client.getResult(ref), /Ergebnis/);
  await rejects(client.getResult({ responseUrl: 'ftp://queue.fal.run/x' }), /Ergebnis-URL/);
}

async function testDownload(tmpDir) {
  const dest = path.join(tmpDir, 'out', 'result.mp4');
  const seen = [];
  let response = () => streamResponse([Buffer.from('abc'), Buffer.from('def')], { headers: { 'content-type': 'video/mp4' } });
  const client = makeClient(async (url, init) => {
    seen.push({ url, init });
    return response(url);
  });

  // host allowlist: https and fal hosts only, nothing is requested otherwise
  for (const bad of [
    'http://v3b.fal.media/a.mp4',
    'https://evil.example.com/a.mp4',
    'https://fal.media.evil.com/a.mp4',
    'https://notfal.media/a.mp4',
    'https://v3b.fal.media.attacker.test/a.mp4',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    ''
  ]) {
    await rejects(client.downloadToFile(bad, dest), /fal\.ai-Ergebnis-URL/);
  }
  assert.equal(seen.length, 0);
  assert.equal(fs.existsSync(dest), false);
  for (const host of ['fal.media', 'v3b.fal.media', 'storage.fal.run', 'cdn.fal.ai']) assert.equal(fal.isAllowedDownloadHost(host), true, host);
  for (const host of ['evil.com', 'fal.media.evil.com', 'xfal.media', 'fal.run', 'fal.ai', '']) assert.equal(fal.isAllowedDownloadHost(host), false, host);

  // streamed to disk, key not sent to the CDN
  const done = await client.downloadToFile('https://v3b.fal.media/files/a.mp4', dest);
  assert.equal(done.bytes, 6);
  assert.equal(done.contentType, 'video/mp4');
  assert.equal(await fsp.readFile(dest, 'utf8'), 'abcdef');
  assert.equal(seen[0].init.headers, undefined, 'no Authorization header to the CDN');
  assert.equal(seen[0].init.redirect, 'manual');

  // truly streamed: the second chunk is only requested after the first one was written
  let onDiskAtEnd = null;
  const slowDest = path.join(tmpDir, 'out', 'slow.mp4');
  response = () =>
    streamResponse([Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)], {
      delayMs: 80,
      onPull: (index) => {
        if (index === 2) onDiskAtEnd = fs.existsSync(slowDest) ? fs.statSync(slowDest).size : -1;
      }
    });
  await client.downloadToFile('https://v3b.fal.media/files/slow.mp4', slowDest);
  assert.ok(onDiskAtEnd >= 1024, 'the first chunk is on disk while the body is still being read');
  assert.equal(fs.statSync(slowDest).size, 2048);

  // size limit: counted while streaming, partial file removed
  const bigDest = path.join(tmpDir, 'out', 'big.mp4');
  response = () => streamResponse([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
  await rejects(client.downloadToFile('https://v3b.fal.media/files/big.mp4', bigDest, { maxBytes: 10 }), /groesser als/);
  assert.equal(fs.existsSync(bigDest), false, 'the partial file is removed');
  // declared length over the limit: refused without reading the body
  let cancelled = false;
  response = () => streamResponse([Buffer.alloc(6)], { headers: { 'content-length': '999999999999' }, onCancel: () => { cancelled = true; } });
  await rejects(client.downloadToFile('https://v3b.fal.media/files/big.mp4', bigDest, { maxBytes: 10 }), /groesser als/);
  assert.equal(cancelled, true, 'the body is cancelled, not read');
  await rejects(client.downloadToFile('https://v3b.fal.media/files/big.mp4', bigDest, { maxBytes: 10 }), /fal\.ai \(Dashboard\).*https:\/\/v3b\.fal\.media\/files\/big\.mp4/);
  assert.equal(fs.existsSync(bigDest), false);
  assert.equal(fal.MAX_DOWNLOAD_BYTES, 4096 * MB);

  // HTTP errors and empty bodies
  response = () => streamResponse([], { status: 404 });
  const notFound = await rejects(client.downloadToFile('https://v3b.fal.media/files/none.mp4', bigDest), /HTTP 404/);
  assert.equal(notFound.retryable, false);
  response = () => streamResponse([], { status: 502 });
  assert.equal((await rejects(client.downloadToFile('https://v3b.fal.media/files/none.mp4', bigDest), /HTTP 502/)).retryable, true);
  response = () => streamResponse([]);
  await rejects(client.downloadToFile('https://v3b.fal.media/files/empty.mp4', bigDest), /leere/);
  assert.equal(fs.existsSync(bigDest), false);

  // redirects are followed only within the allowlist
  let step = 0;
  response = (url) => {
    step += 1;
    if (url === 'https://v3b.fal.media/files/r.mp4') return jsonResponse(302, '', { location: 'https://cdn.fal.ai/files/r2.mp4' });
    return streamResponse([Buffer.from('redirected')]);
  };
  const redirected = await client.downloadToFile('https://v3b.fal.media/files/r.mp4', bigDest);
  assert.equal(redirected.bytes, 10);
  assert.equal(step, 2);
  response = () => jsonResponse(302, '', { location: 'https://evil.example.com/steal' });
  await rejects(client.downloadToFile('https://v3b.fal.media/files/r.mp4', bigDest), /fal\.ai-Ergebnis-URL/);
  assert.equal(fs.existsSync(bigDest), false);
}

/* ---------- tool fal_generate ---------- */

function toolContext(sessionId, events = []) {
  return { nodeView: true, sessionId, user: 'tester', config: {}, emit: (event) => events.push(event) };
}

async function saveAsset(sessionId, kind, ext, bytes = 'data') {
  return store.saveAsset(sessionId, { kind, buffer: Buffer.from(bytes), ext, prompt: `test ${kind}` });
}

async function testTool(sessionId, otherSessionId) {
  const events = [];
  const ctx = toolContext(sessionId, events);
  const calls = { upload: [], submit: [] };
  let submitCounter = 0;
  patch(fal, 'hasKey', () => true);
  patch(fal, 'uploadFile', async (file, options) => {
    calls.upload.push({ file: path.basename(file), ...options });
    return { url: `https://v3b.fal.media/files/${path.basename(file)}`, size: 4, contentType: options.contentType, fileName: options.fileName };
  });
  patch(fal, 'submit', async (endpoint, input) => {
    calls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)) });
    submitCounter += 1;
    return {
      requestId: `req-${submitCounter}`,
      statusUrl: `https://queue.fal.run/${endpoint}/requests/req-${submitCounter}/status`,
      responseUrl: `https://queue.fal.run/${endpoint}/requests/req-${submitCounter}`
    };
  });
  const untouched = () => assert.deepEqual([calls.upload.length, calls.submit.length], [0, 0], 'no upload and no submit');
  const reset = () => {
    calls.upload.length = 0;
    calls.submit.length = 0;
  };

  const image = await saveAsset(sessionId, 'image', '.png');
  const image2 = await saveAsset(sessionId, 'image', '.jpg');
  const video = await saveAsset(sessionId, 'video', '.mp4');
  const audio = await saveAsset(sessionId, 'audio', '.mp3');
  // an id that exists only in the other session
  await saveAsset(otherSessionId, 'image', '.png');
  await saveAsset(otherSessionId, 'image', '.png');
  const foreign = await saveAsset(otherSessionId, 'image', '.png');
  assert.ok(!(await store.readLedger(sessionId)).some((entry) => entry.id === foreign.id));
  const base = { endpoint: 'minimax/h3-max/text-to-video', input: { prompt: 'a cat' }, kind: 'video' };

  // node-only
  await rejects(tools.executeTool({ sessionId, emit() {} }, 'fal_generate', base), /Node-Ansicht/);
  await rejects(tools.executeTool({ sessionId, nodeView: false, emit() {} }, 'fal_generate', base), /Node-Ansicht/);
  assert.ok(!tools.toolDefinitions().some((definition) => definition.function.name === 'fal_generate'), 'never offered in the chat');
  untouched();

  // every check runs before an upload or a submit
  patch(fal, 'hasKey', () => false);
  await rejects(tools.executeTool(ctx, 'fal_generate', base), /FAL_KEY/);
  untouched();
  patch(fal, 'hasKey', () => true);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, endpoint: 'https://queue.fal.run/x' }), /Endpoint-ID/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, endpoint: '' }), /Endpoint-ID/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, input: 'x' }), /input muss ein Objekt/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, kind: 'gif' }), /kind muss/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, estimateUsd: -1 }), /estimateUsd/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, pricing: { perSecond: 0 } }), /pricing/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, pricing: { perSecond: 0.1, overSeconds: 15, overMultiplier: 0.5 } }), /pricing/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: 'x' }), /media muss ein Array/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'Image-URL', assetIds: [image.id] }] }), /media-Feldname/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'prompt', assetIds: [image.id] }] }), /doppelt/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'a', assetIds: [image.id] }, { field: 'a', assetIds: [image.id] }] }), /doppelt/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'a', placeholder: '@@x@@', assetIds: [image.id] }] }), /genau eines/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ assetIds: [image.id] }] }), /genau eines/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ placeholder: 'bad', assetIds: [image.id] }] }), /Platzhalter/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ placeholder: '@@fal:image_1@@', assetIds: [image.id] }] }), /nicht vor/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'a', assetIds: [] }] }), /assetIds/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'a', assetIds: [image.id, image2.id] }] }), /nur eine Datei/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'a', assetIds: Array.from({ length: 31 }, () => image.id), multiple: true }] }), /Hoechstens 30/);
  // an asset of another session, a missing one, a pending one and a wrong type
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: [foreign.id] }] }), /existiert nicht in dieser Session/);
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: ['image-99'] }] }), /existiert nicht/);
  const pending = await store.reserveAsset(sessionId, { kind: 'video', ext: '.mp4', prompt: 'pending' });
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'video_url', assetIds: [pending.id] }] }), /noch nicht fertig/);
  const svg = await saveAsset(sessionId, 'upload', '.svg', '<svg/>');
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: [svg.id] }] }), /nicht zu fal\.ai hochgeladen/);
  untouched();
  // over 90 MB: refused although the first asset is fine (sparse file)
  const bigAsset = await saveAsset(sessionId, 'video', '.mp4');
  const bigPath = path.join(store.sessionAssetDir(sessionId), bigAsset.file);
  const handle = await fsp.open(bigPath, 'w');
  await handle.truncate(90 * MB + 1);
  await handle.close();
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: [image.id] }, { field: 'video_url', assetIds: [bigAsset.id] }] }), /groesser als 90 MB/);
  untouched();
  assert.equal((await store.readSession(sessionId)).jobs.length, 0, 'no job registered');
  const ledgerBefore = (await store.readLedger(sessionId)).length;

  // a cancelled run never reaches fal.ai: already aborted -> nothing happens; aborted during the uploads -> no submit
  const early = new AbortController();
  early.abort();
  await rejects(tools.executeTool({ ...ctx, signal: early.signal }, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: [image.id] }] }), null, (err) => assert.equal(err.name, 'AbortError'));
  untouched();
  const midway = new AbortController();
  const realUpload = fal.uploadFile;
  patch(fal, 'uploadFile', async (file, options) => {
    const result = await realUpload(file, options);
    midway.abort(); // the user cancels while the first file is being uploaded
    return result;
  });
  await rejects(
    tools.executeTool({ ...ctx, signal: midway.signal }, 'fal_generate', { ...base, media: [{ field: 'reference_image_urls', assetIds: [image.id, image2.id], multiple: true }] }),
    null,
    (err) => assert.equal(err.name, 'AbortError')
  );
  assert.equal(calls.upload.length, 1, 'the second upload is not started');
  assert.equal(calls.submit.length, 0, 'nothing is submitted (and billed) after the cancel');
  assert.equal((await store.readLedger(sessionId)).length, ledgerBefore, 'no asset reserved');
  patch(fal, 'uploadFile', realUpload);
  reset();

  // happy path: sequential uploads, fields filled, job registered with everything the poller needs
  const outcome = await tools.executeTool(ctx, 'fal_generate', {
    endpoint: 'minimax/h3-max/reference-to-video',
    input: { prompt: 'Image 1 walks', duration: 5 },
    media: [
      { field: 'reference_image_urls', assetIds: [image.id, image2.id], multiple: true },
      { field: 'target_audio_url', assetIds: [audio.id], multiple: false }
    ],
    kind: 'video',
    estimateUsd: 0.4,
    pricing: { perSecond: 0.08 }
  });
  assert.deepEqual(calls.upload.map((entry) => entry.file), [image.file, image2.file, audio.file], 'uploaded one after the other, in order');
  assert.deepEqual(calls.upload.map((entry) => entry.contentType), ['image/png', 'image/jpeg', 'audio/mpeg']);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].endpoint, 'minimax/h3-max/reference-to-video');
  assert.deepEqual(calls.submit[0].input, {
    prompt: 'Image 1 walks',
    duration: 5,
    reference_image_urls: [`https://v3b.fal.media/files/${image.file}`, `https://v3b.fal.media/files/${image2.file}`],
    target_audio_url: `https://v3b.fal.media/files/${audio.file}`
  });
  const job = outcome.job;
  assert.equal(job.source, 'fal');
  assert.equal(job.provider, 'fal');
  assert.equal(job.jobId, 'req-1');
  assert.equal(job.endpoint, 'minimax/h3-max/reference-to-video');
  assert.match(job.statusUrl, /^https:\/\/queue\.fal\.run\//);
  assert.match(job.responseUrl, /^https:\/\/queue\.fal\.run\//);
  assert.equal(job.kind, 'video');
  assert.equal(job.status, 'pending');
  assert.equal(job.costEstimateUsd, 0.4);
  assert.deepEqual(job.pricing, { perSecond: 0.08, durationField: 'duration' });
  assert.ok(job.timeoutAt > Date.now() + 80 * 60 * 1000 && job.timeoutAt < Date.now() + 100 * 60 * 1000, 'about 90 minutes');
  assert.match(job.file, /\.mp4$/);
  const saved = await store.readSession(sessionId);
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].jobId, 'req-1');
  assert.ok(events.some((event) => event.type === 'generation_job' && event.source === 'fal'));
  const reserved = (await store.readLedger(sessionId)).find((entry) => entry.id === job.assetId);
  assert.equal(reserved.pending, true);
  assert.equal(reserved.kind, 'video');

  // reserved extension follows the kind; auto reserves a video
  for (const [kind, ext, ledgerKind] of [['image', '.png', 'image'], ['audio', '.mp3', 'audio'], ['auto', '.mp4', 'video']]) {
    const result = await tools.executeTool(ctx, 'fal_generate', { endpoint: 'fal-ai/flux/dev', input: { prompt: 'x' }, kind });
    assert.match(result.job.file, new RegExp(`\\${ext}$`), kind);
    assert.equal((await store.readLedger(sessionId)).find((entry) => entry.id === result.job.assetId).kind, ledgerKind);
    assert.equal(result.job.resultKind, kind);
  }

  // placeholders replace exact strings at any depth (free-form node)
  reset();
  await tools.executeTool(ctx, 'fal_generate', {
    endpoint: 'fal-ai/some/model',
    input: { prompt: 'x', params: { source: '@@fal:image_1@@', list: ['@@fal:images@@', '@@fal:image_1@@'], text: 'keep @@fal:image_1@@ inside' } },
    media: [
      { placeholder: '@@fal:image_1@@', assetIds: [image.id], multiple: false },
      { placeholder: '@@fal:images@@', assetIds: [image.id, image2.id], multiple: true }
    ],
    kind: 'auto',
    keepResult: true
  });
  assert.deepEqual(calls.submit[0].input.params, {
    source: `https://v3b.fal.media/files/${image.file}`,
    list: [[`https://v3b.fal.media/files/${image.file}`, `https://v3b.fal.media/files/${image2.file}`], `https://v3b.fal.media/files/${image.file}`],
    text: 'keep @@fal:image_1@@ inside'
  });
  assert.equal((await store.readSession(sessionId)).jobs.slice(-1)[0].keepResult, true);

  // a request id that is already used never creates a duplicate job; the reserved asset is removed again
  const ledgerAfter = (await store.readLedger(sessionId)).length;
  patch(fal, 'submit', async (endpoint) => ({
    requestId: 'req-1',
    statusUrl: `https://queue.fal.run/${endpoint}/requests/req-1/status`,
    responseUrl: `https://queue.fal.run/${endpoint}/requests/req-1`
  }));
  await rejects(tools.executeTool(ctx, 'fal_generate', base), /bereits/);
  assert.equal((await store.readLedger(sessionId)).length, ledgerAfter, 'the reserved asset was removed');
  const jobsAfter = (await store.readSession(sessionId)).jobs;
  assert.equal(jobsAfter.filter((entry) => entry.jobId === 'req-1').length, 1);

  // a failing submit removes the reserved asset (uploads already happened and are harmless)
  patch(fal, 'submit', async () => {
    throw new fal.FalError('fal.ai-Job senden fehlgeschlagen (HTTP 422): prompt: Field required', 422);
  });
  await rejects(tools.executeTool(ctx, 'fal_generate', base), /422/);
  assert.equal((await store.readLedger(sessionId)).length, ledgerAfter);
  assert.ok(ledgerBefore > 0);

  // a failing upload stops before submit and before reserving anything
  reset();
  patch(fal, 'uploadFile', async () => {
    throw new fal.FalError('Upload zu fal.ai fehlgeschlagen (HTTP 500).', 500);
  });
  const jobsBefore = (await store.readSession(sessionId)).jobs.length;
  await rejects(tools.executeTool(ctx, 'fal_generate', { ...base, media: [{ field: 'image_url', assetIds: [image.id] }] }), /Upload/);
  assert.equal(calls.submit.length, 0);
  assert.equal((await store.readLedger(sessionId)).length, ledgerAfter);
  assert.equal((await store.readSession(sessionId)).jobs.length, jobsBefore);
  void video;
}

/* ---------- poller ---------- */

async function addFalJob(sessionId, overrides = {}) {
  const asset = await store.reserveAsset(sessionId, { kind: overrides.kind || 'video', ext: '.mp4', prompt: 'fal test' });
  const ts = new Date().toISOString();
  const job = {
    jobId: `req-${asset.id}`,
    provider: 'fal',
    source: 'fal',
    kind: 'video',
    resultKind: 'video',
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt: 'fal test',
    mode: 'fal_generate',
    model: 'minimax/h3-max/text-to-video',
    endpoint: 'minimax/h3-max/text-to-video',
    statusUrl: 'https://queue.fal.run/minimax/h3-max/requests/x/status',
    responseUrl: 'https://queue.fal.run/minimax/h3-max/requests/x',
    user: 'tester',
    submittedAt: ts,
    createdAt: ts,
    startedAt: null,
    timeoutAt: Date.now() + 60 * 60 * 1000,
    costEstimateUsd: 0.4,
    pricing: { perSecond: 0.08, durationField: 'duration' },
    cost: null,
    error: null,
    ...overrides
  };
  await store.mutateSession(sessionId, (session) => session.jobs.push(job));
  return job;
}

async function jobOf(sessionId, assetId) {
  return (await store.readSession(sessionId)).jobs.find((entry) => entry.assetId === assetId);
}

async function testPoller(sessionId) {
  const journal = [];
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });
  // only fal jobs may be polled: no other provider is configured (and none is ever contacted)
  patch(or, 'hasKey', () => false);
  patch(higgsfield, 'status', () => ({ connected: false }));
  patch(rendernode, 'listConfiguredNodes', () => []);
  patch(fal, 'hasKey', () => true);

  let status = { status: 'IN_QUEUE', queuePosition: 2, error: null, errorType: null };
  let statusError = null;
  let result = null;
  let resultError = null;
  let downloadError = null;
  const calls = { status: 0, result: 0, download: [] };
  patch(fal, 'getStatus', async (job) => {
    calls.status += 1;
    assert.match(job.statusUrl, /^https:\/\/queue\.fal\.run\//);
    if (statusError) throw statusError;
    return status;
  });
  patch(fal, 'getResult', async () => {
    calls.result += 1;
    if (resultError) throw resultError;
    return result;
  });
  patch(fal, 'downloadToFile', async (url, dest) => {
    calls.download.push({ url, dest });
    if (downloadError) throw downloadError;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, 'fake-media-bytes');
    return { bytes: 16, contentType: 'application/octet-stream' };
  });

  // waiting: the state follows the queue, nothing else happens
  const waiting = await addFalJob(sessionId);
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, waiting.assetId)).status, 'queued');
  status = { status: 'IN_PROGRESS', queuePosition: null, error: null, errorType: null };
  await poller.pollOnce();
  const running = await jobOf(sessionId, waiting.assetId);
  assert.equal(running.status, 'in_progress');
  assert.ok(running.startedAt);
  assert.equal(calls.result, 0);

  // fal reports an error at COMPLETED: failed once, with a short message
  status = { status: 'COMPLETED', queuePosition: null, error: 'Content policy violation', errorType: 'content_policy' };
  await poller.pollOnce();
  const rejected = await jobOf(sessionId, waiting.assetId);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /fal\.ai meldet einen Fehler: Content policy violation/);
  await poller.pollOnce();
  const session1 = await store.readSession(sessionId);
  assert.equal(session1.messages.filter((message) => message.type === 'job_update' && message.content.includes(waiting.assetId)).length, 1, 'reported once');
  assert.equal(calls.result, 0);
  assert.equal(calls.download.length, 0);

  // completed: the video is streamed into the reserved asset, cost from the reported duration
  const finished = await addFalJob(sessionId);
  status = { status: 'COMPLETED', queuePosition: null, error: null, errorType: null };
  result = {
    video: { url: 'https://v3b.fal.media/files/b/x.mp4', content_type: 'video/mp4', file_name: 'x.mp4', file_size: 16 },
    seed: 42,
    expanded_prompt: 'e'.repeat(3000),
    duration: 7
  };
  await poller.pollOnce();
  const done = await jobOf(sessionId, finished.assetId);
  assert.equal(done.status, 'completed');
  assert.equal(done.cost, 0.56, '7 s x 0.08');
  assert.equal(done.costEstimated, true);
  assert.equal(done.seed, 42);
  assert.equal(done.expanded_prompt.length, 2000);
  assert.equal(done.duration, 7);
  assert.deepEqual(done.resultAssetIds, [finished.assetId]);
  assert.equal(done.statusUrl, undefined, 'the queue URLs are dropped after completion');
  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].url, 'https://v3b.fal.media/files/b/x.mp4');
  assert.ok(calls.download[0].dest.startsWith(store.sessionAssetDir(sessionId)), 'downloaded inside the session asset dir');
  assert.equal(fs.existsSync(calls.download[0].dest), false, 'the temp file is gone');
  const entry = (await store.readLedger(sessionId)).find((item) => item.id === finished.assetId);
  assert.equal(entry.pending, undefined);
  assert.equal(entry.file, `${finished.assetId}.mp4`);
  assert.equal(entry.cost, 0.56);
  assert.equal(entry.duration, 7);
  assert.equal(await fsp.readFile(path.join(store.sessionAssetDir(sessionId), entry.file), 'utf8'), 'fake-media-bytes');
  const cost = journal.find((line) => line.assetId === finished.assetId);
  assert.equal(cost.type, 'fal');
  assert.equal(cost.model, 'minimax/h3-max/text-to-video');
  assert.equal(cost.cost, 0.56);
  assert.match(cost.billing, /Schaetzung/);
  assert.ok(costs.VALID_TYPES.has('fal'));
  const session2 = await store.readSession(sessionId);
  const update = session2.messages.find((message) => message.type === 'job_update' && message.content.includes(finished.assetId));
  assert.match(update.content, /ist fertig gerendert \(.*~\$0\.56\)/);
  assert.ok(session2.messages.some((message) => message.hidden && message.content.includes(`fal-Video-Job ${finished.assetId} ist fertig`)));

  // no reported duration: the estimate of the submit is booked
  const estimated = await addFalJob(sessionId, { costEstimateUsd: 0.32 });
  result = { video: { url: 'https://v3b.fal.media/files/b/y.mp4' } };
  await poller.pollOnce();
  const estimatedDone = await jobOf(sessionId, estimated.assetId);
  assert.equal(estimatedDone.status, 'completed');
  assert.equal(estimatedDone.cost, 0.32);
  assert.equal(estimatedDone.seed, undefined);

  // unknown cost: nothing is journaled
  const journalBefore = journal.length;
  const free = await addFalJob(sessionId, { costEstimateUsd: null, pricing: null });
  await poller.pollOnce();
  const freeDone = await jobOf(sessionId, free.assetId);
  assert.equal(freeDone.status, 'completed');
  assert.equal(freeDone.cost, null);
  assert.equal(journal.length, journalBefore);

  // lip sync pricing: x1.2 over 15 seconds
  const lipsync = await addFalJob(sessionId, {
    endpoint: 'minimax/h3-max/lip-sync/image-to-video',
    pricing: { perSecond: 0.08, durationField: 'duration', overSeconds: 15, overMultiplier: 1.2 }
  });
  result = { video: { url: 'https://v3b.fal.media/files/b/l.mp4' }, duration: 30, seed: 1 };
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, lipsync.assetId)).cost, 2.88, '30 s at 768p costs $2.88 (docs example)');
  assert.equal(poller.falJobCost({ pricing: { perSecond: 0.08, overSeconds: 15, overMultiplier: 1.2 } }, { duration: 5 }), 0.4);
  // the extend node ignores the reported duration (it may include the source clip)
  assert.equal(poller.falJobCost({ costEstimateUsd: 0.4, pricing: { perSecond: 0.08, durationField: null } }, { duration: 40 }), 0.4);
  assert.equal(poller.falJobCost({ pricing: { perSecond: 0.06, durationField: 'injected_duration' } }, { injected_duration: 5, duration: 20 }), 0.3);

  // kind auto: the real kind and extension come from the result
  const auto = await addFalJob(sessionId, { resultKind: 'auto', costEstimateUsd: null, pricing: null });
  result = { images: [{ url: 'https://v3b.fal.media/files/b/i.png', content_type: 'image/png' }] };
  await poller.pollOnce();
  const autoEntry = (await store.readLedger(sessionId)).find((item) => item.id === auto.assetId);
  assert.equal(autoEntry.file, `${auto.assetId}.png`);
  assert.equal(autoEntry.kind, 'image');
  assert.equal(autoEntry.duration, undefined);

  // keepResult stores the result JSON, capped
  const kept = await addFalJob(sessionId, { keepResult: true, costEstimateUsd: null, pricing: null });
  result = { video: { url: 'https://v3b.fal.media/files/b/k.mp4' }, note: 'n'.repeat(80 * 1024) };
  await poller.pollOnce();
  const keptDone = await jobOf(sessionId, kept.assetId);
  assert.ok(keptDone.resultJson.startsWith('{'));
  assert.equal(keptDone.resultJson.length, 50 * 1024);
  const unkept = await jobOf(sessionId, done.assetId);
  assert.equal(unkept.resultJson, undefined);

  // no medium in the result: failed
  const empty = await addFalJob(sessionId);
  result = { seed: 1 };
  await poller.pollOnce();
  const emptyDone = await jobOf(sessionId, empty.assetId);
  assert.equal(emptyDone.status, 'failed');
  assert.match(emptyDone.error, /kein Medium/);

  // temporary problems keep the job open; the next round asks again
  const flaky = await addFalJob(sessionId);
  result = { video: { url: 'https://v3b.fal.media/files/b/f.mp4' } };
  statusError = new fal.FalError('fal.ai-Status: Zeitlimit von 30 Sekunden erreicht.', 0, { retryable: true });
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, flaky.assetId)).status, 'pending');
  statusError = new fal.FalError('fal.ai-Status fehlgeschlagen (HTTP 502).', 502, { retryable: true });
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, flaky.assetId)).status, 'pending');
  statusError = null;
  resultError = new fal.FalError('fal.ai-Ergebnis fehlgeschlagen (HTTP 500).', 500, { retryable: true });
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, flaky.assetId)).status, 'pending');
  resultError = null;
  downloadError = new fal.FalError('fal.ai-Download fehlgeschlagen: Netzwerk.', 0, { retryable: true });
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, flaky.assetId)).status, 'pending', 'a failed download is retried');
  assert.equal(fs.existsSync(path.join(store.sessionAssetDir(sessionId), `.fal-${flaky.assetId}.part`)), false);
  downloadError = null;
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, flaky.assetId)).status, 'completed', 'recovered');

  // rejected key / unknown job: failed with a clear message
  const denied = await addFalJob(sessionId);
  statusError = new fal.FalError('fal.ai lehnt den Zugriff ab (HTTP 401) - FAL_KEY pruefen', 401, { retryable: false });
  await poller.pollOnce();
  const deniedDone = await jobOf(sessionId, denied.assetId);
  assert.equal(deniedDone.status, 'failed');
  assert.match(deniedDone.error, /FAL_KEY/);
  const gone = await addFalJob(sessionId);
  statusError = new fal.FalError('fal.ai-Status fehlgeschlagen (HTTP 404).', 404, { retryable: false });
  await poller.pollOnce();
  const goneDone = await jobOf(sessionId, gone.assetId);
  assert.equal(goneDone.status, 'failed');
  assert.match(goneDone.error, /nicht gefunden/);
  statusError = null;
  const denyResult = await addFalJob(sessionId);
  resultError = new fal.FalError('fal.ai-Ergebnis fehlgeschlagen (HTTP 422): prompt: Field required', 422, { retryable: false });
  await poller.pollOnce();
  const denyResultDone = await jobOf(sessionId, denyResult.assetId);
  assert.equal(denyResultDone.status, 'failed');
  assert.match(denyResultDone.error, /Field required/);
  resultError = null;

  // timeout: 90 minutes, also for a job without timeoutAt
  const before = { status: calls.status };
  const overdue = await addFalJob(sessionId, { timeoutAt: Date.now() - 1000 });
  const old = await addFalJob(sessionId, { timeoutAt: null, createdAt: new Date(Date.now() - 100 * 60 * 1000).toISOString(), submittedAt: new Date(Date.now() - 100 * 60 * 1000).toISOString() });
  const fresh = await addFalJob(sessionId, { timeoutAt: null, createdAt: new Date(Date.now() - 80 * 60 * 1000).toISOString() });
  status = { status: 'IN_QUEUE', queuePosition: 1, error: null, errorType: null };
  await poller.pollOnce();
  const overdueDone = await jobOf(sessionId, overdue.assetId);
  assert.equal(overdueDone.status, 'failed');
  assert.match(overdueDone.error, /fal\.ai-Job hat nach 90 Minuten das Zeitlimit erreicht/);
  assert.equal((await jobOf(sessionId, old.assetId)).status, 'failed');
  assert.equal((await jobOf(sessionId, fresh.assetId)).status, 'queued', 'inside the 90 minutes');
  assert.equal(calls.status - before.status, 1, 'overdue jobs are not asked again');

  // without a key fal jobs are skipped, not failed
  patch(fal, 'hasKey', () => false);
  const skipped = await addFalJob(sessionId);
  const statusCalls = calls.status;
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, skipped.assetId)).status, 'pending');
  assert.equal(calls.status, statusCalls);
  patch(fal, 'hasKey', () => true);
  await poller.pollOnce();
  assert.equal((await jobOf(sessionId, skipped.assetId)).status, 'queued');
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-fal-'));
  const sessions = [];
  try {
    testEndpointIds();
    testExtractMedia();
    await testMissingKey(tmpDir);
    await testUpload(tmpDir);
    await testSubmitAndStatus();
    await testDownload(tmpDir);

    const session = await store.createSession();
    const other = await store.createSession();
    sessions.push(session.id, other.id);
    await testTool(session.id, other.id);
    restoreAll();

    const pollerSession = await store.createSession();
    sessions.push(pollerSession.id);
    await testPoller(pollerSession.id);
    console.log('test-fal: ok');
  } finally {
    restoreAll();
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
