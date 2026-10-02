'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('../lib/config');
const store = require('../lib/store');
const publicrefs = require('../lib/publicrefs');
const { app } = require('../server');

async function main() {
  store.ensureDirs();
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://example.test/supercomputer/';
  const session = await store.createSession();
  let published;
  let fresh;
  try {
    const asset = await store.saveAsset(session.id, {
      kind: 'video',
      buffer: Buffer.from('video-reference'),
      ext: '.mp4',
      prompt: 'Public-Ref-Test',
      cost: null
    });
    published = await publicrefs.publishAsset(session.id, asset.id);
    assert.match(published.file, publicrefs.PUBLIC_REF_PATTERN);
    assert.equal(published.url, `https://example.test/supercomputer/refs/${published.file}`);
    assert.equal(await fsp.readFile(path.join(PATHS.publicRefsDir, published.file), 'utf8'), 'video-reference');
    const route = app._router.stack.find((layer) => layer.route?.path === '/refs/:file' && layer.route.methods.get);
    assert.ok(route, 'GET /refs/:file muss registriert sein');
    const handler = route.route.stack[0].handle;
    const response = { headers: {}, headersSent: false };
    response.set = (key, value) => { response.headers[key.toLowerCase()] = value; };
    response.type = (value) => { response.contentType = value; };
    response.sendFile = (file, options, callback) => {
      response.sentFile = file;
      response.sendOptions = options;
      callback(null);
    };
    response.sendStatus = (status) => { response.statusCode = status; };
    handler({ params: { file: published.file } }, response);
    assert.equal(response.contentType, 'video/mp4');
    assert.equal(response.headers['cache-control'], 'private, max-age=0');
    assert.equal(response.sentFile, published.file);
    assert.equal(response.sendOptions.root, PATHS.publicRefsDir);
    const invalidResponse = { sendStatus: (status) => { invalidResponse.statusCode = status; } };
    handler({ params: { file: 'not-valid.mp4' } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 404);
    const configRoute = app._router.stack.find((layer) => layer.route?.path === '/api/config' && layer.route.methods.get);
    const configResponse = { json: (value) => { configResponse.body = value; } };
    configRoute.route.stack[0].handle({}, configResponse);
    assert.ok(!Object.prototype.hasOwnProperty.call(configResponse.body, 'publicBaseUrl'));
    assert.ok(!Object.prototype.hasOwnProperty.call(configResponse.body, 'PUBLIC_BASE_URL'));

    const oldTime = new Date(Date.now() - 60_000);
    await fsp.utimes(path.join(PATHS.publicRefsDir, published.file), oldTime, oldTime);
    fresh = await publicrefs.publishAsset(session.id, asset.id);
    const removed = await publicrefs.cleanupRefs(30_000);
    assert.ok(removed >= 1);
    await assert.rejects(fsp.access(path.join(PATHS.publicRefsDir, published.file)), /ENOENT/);
    await fsp.access(path.join(PATHS.publicRefsDir, fresh.file));
    assert.equal(await publicrefs.removeRef(fresh.file), true);
    assert.equal(await publicrefs.removeRef(fresh.file), false);
    assert.equal(await publicrefs.removeRef('../ungueltig.mp4'), false);
    console.log('Public-Refs: HTTPS-URL, Dateiname, Kopie, TTL-Cleanup und gezieltes Aufraeumen sind korrekt.');
  } finally {
    if (published) await publicrefs.removeRef(published.file).catch(() => {});
    if (fresh) await publicrefs.removeRef(fresh.file).catch(() => {});
    await store.deleteSession(session.id);
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }
  console.log('test-publicrefs.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
