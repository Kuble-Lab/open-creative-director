'use strict';

const assert = require('assert/strict');
const { PassThrough } = require('stream');

const { app } = require('../server');
const store = require('../lib/store');
const brandings = require('../lib/brandings');

function routeHandler(pathname, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === pathname && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${pathname}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(pathname, { method = 'get', params = {}, body = {}, query = {} } = {}) {
  const handler = routeHandler(pathname, method);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    const res = new PassThrough();
    res.statusCode = 200;
    res.responseBody = undefined;
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('error', reject);
    res.on('finish', () => {
      resolve({
        status: res.statusCode,
        body: res.responseBody,
        buffer: Buffer.concat(chunks),
        headers
      });
    });
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (value) => {
      res.responseBody = value;
      res.end();
      return res;
    };
    res.type = (value) => {
      headers['content-type'] = value;
      return res;
    };
    res.send = (value) => {
      res.end(value);
      return res;
    };
    res.attachment = (filename) => {
      headers['content-type'] = 'application/zip';
      headers['content-disposition'] = `attachment; filename="${filename}"`;
      return res;
    };
    Object.defineProperty(res, 'headersSent', {
      configurable: true,
      get: () => chunks.length > 0 || res.writableEnded
    });

    Promise.resolve(handler({ params, body, query }, res)).catch(reject);
  });
}

async function main() {
  const createdBrandings = [];
  const session = await store.createSession();
  const first = await brandings.createBranding({ name: 'API Testmarke', description: 'Exporttest' });
  const second = await brandings.createBranding({ name: 'API Zweitmarke' });
  const third = await brandings.createBranding({ name: 'API Drittmarke' });
  createdBrandings.push(first.id, second.id, third.id);
  await brandings.updateBranding(first.id, {
    colors: [{ role: 'primary', name: 'Petrol', hex: '#114455', usage: 'Flaechen' }],
    guidelines: 'API-Guidelines fuer den Export.'
  });
  const saved = await brandings.saveBrandingAsset(first.id, {
    buffer: Buffer.from('API-ASSET'),
    filename: 'logo-test.svg'
  });

  try {
    const listed = await invoke('/api/brandings');
    assert.equal(listed.status, 200);
    const preview = listed.body.brandings.find((entry) => entry.id === first.id);
    assert.deepEqual(preview.colors, ['#114455']);

    const detail = await invoke('/api/brandings/:id', { params: { id: first.id } });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.name, 'API Testmarke');

    const assetResponse = await invoke('/api/brandings/:id/assets/:filename', {
      params: { id: first.id, filename: saved.filename }
    });
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers['content-type'], 'image/svg+xml');
    assert.equal(assetResponse.buffer.toString(), 'API-ASSET');

    const exportResponse = await invoke('/api/brandings/:id/export', { params: { id: first.id } });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers['content-disposition'] || '', /API-Testmarke-branding\.zip/);
    const archive = exportResponse.buffer;
    assert.equal(archive.subarray(0, 2).toString(), 'PK');
    assert.ok(archive.length > 300);
    assert.ok(archive.includes(Buffer.from('branding.json')));
    assert.ok(archive.includes(Buffer.from('README.md')));
    assert.ok(archive.includes(Buffer.from(`assets/${saved.filename}`)));

    const patched = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { brandings: [first.id, second.id] }
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.session.brandings, [first.id, second.id]);

    const loadedSession = await invoke('/api/sessions/:id', { params: { id: session.id } });
    assert.deepEqual(loadedSession.body.session.brandings, [first.id, second.id]);

    const tooMany = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { brandings: [first.id, second.id, third.id] }
    });
    assert.equal(tooMany.status, 400);

    const missing = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { brandings: ['fehlendes-branding'] }
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Branding nicht gefunden/);

    const folder = `Branding-API-${Date.now()}`;
    const profile = await invoke('/api/folders/:name/profile', {
      method: 'put',
      params: { name: folder },
      body: { guidelines: 'Profil', contextBrains: [], brandings: [first.id] }
    });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.profile.brandings, [first.id]);
    await store.writeFolderProfile(folder, {});

    const deleted = await invoke('/api/brandings/:id', {
      method: 'delete',
      params: { id: third.id }
    });
    assert.equal(deleted.status, 200);
    createdBrandings.splice(createdBrandings.indexOf(third.id), 1);
    console.log('Branding-API: Liste, Detail, Asset, ZIP-Export, Session-Patch und Projekt-Profil sind korrekt.');
  } finally {
    await store.deleteSession(session.id);
    for (const id of createdBrandings) await brandings.deleteBranding(id).catch(() => {});
  }
  console.log('test-branding-api.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
