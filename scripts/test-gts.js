'use strict';

const assert = require('node:assert/strict');

const gts = require('../lib/gts');

async function main() {
  const originalBaseUrl = process.env.GTS_BASE_URL;
  const originalToken = process.env.GTS_API_TOKEN;
  const originalFetch = global.fetch;
  const requests = [];

  try {
    delete process.env.GTS_API_TOKEN;
    assert.equal(gts.hasToken(), false, 'GTS muss ohne Token deaktiviert sein.');
    process.env.GTS_API_TOKEN = '   ';
    assert.equal(gts.hasToken(), false, 'Ein leerer Token darf GTS nicht aktivieren.');

    process.env.GTS_API_TOKEN = 'test-token';
    process.env.GTS_BASE_URL = 'https://knowledge.example.test/custom/chat/';
    assert.equal(gts.hasToken(), true);
    assert.equal(gts.baseUrl(), 'https://knowledge.example.test/custom/chat');
    assert.equal(gts.assetOrigin(), 'https://knowledge.example.test');

    assert.equal(gts.brainIdFromQuery('acme.project.launch'), 'acme.project.launch');
    assert.equal(gts.brainIdFromQuery('brand-1.project.launch'), 'brand-1.project.launch');
    assert.equal(gts.brainIdFromQuery('Acme.project.launch'), '');
    assert.equal(gts.brainIdFromQuery('acme.project'), '');
    assert.equal(
      gts.brainIdFromQuery('https://knowledge.example.test/brains/acme.project.launch'),
      'acme.project.launch'
    );
    assert.equal(gts.brainIdFromQuery('https://other.example.test/brains/acme.project.launch'), '');

    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/search?q=launch&limit=3')) {
        return new Response(JSON.stringify({
          matches: [{ id: 'acme.project.launch', title: 'Launch', category: 'project', tags: ['work'] }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/brains/acme.project.assets/assets')) {
        return new Response(JSON.stringify({
          assets: [
            { id: 'asset-1', filename: 'guide.pdf', size: 42, mime_type: 'application/pdf' },
            { filename: 'external.pdf', size: 9, url: 'https://other.example.test/external.pdf' }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/brains/acme.project.assets/assets/asset-1')) {
        return new Response('asset-body', { status: 200, headers: { 'content-length': '10' } });
      }
      throw new Error(`Unerwartete Test-URL: ${url}`);
    };

    assert.deepEqual(await gts.search('launch', 3), [
      { id: 'acme.project.launch', title: 'Launch', category: 'project', tags: ['work'] }
    ]);
    assert.equal(requests[0].url, 'https://knowledge.example.test/custom/chat/search?q=launch&limit=3');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');

    const assets = await gts.listAssets('acme.project.assets');
    assert.deepEqual(assets, [{
      filename: 'guide.pdf',
      size: 42,
      mimeType: 'application/pdf',
      url: 'https://knowledge.example.test/api/brains/acme.project.assets/assets/asset-1'
    }]);
    assert.equal(requests[1].url, 'https://knowledge.example.test/api/brains/acme.project.assets/assets');
    assert.equal(
      (await gts.downloadAsset(assets[0].url)).toString('utf8'),
      'asset-body'
    );
    await assert.rejects(
      () => gts.downloadAsset('https://other.example.test/api/brains/acme.project.assets/assets/asset-1'),
      /nicht erlaubt/
    );

    process.env.GTS_BASE_URL = 'http://localhost:4000/api/chatgpt';
    assert.equal(gts.baseUrl(), 'http://localhost:4000/api/chatgpt');
    assert.equal(gts.assetOrigin(), 'http://localhost:4000');
    assert.equal(
      gts.brainIdFromQuery('http://localhost:4000/brains/local.project.brain'),
      'local.project.brain'
    );

    delete process.env.GTS_BASE_URL;
    assert.equal(gts.baseUrl(), gts.DEFAULT_BASE_URL);
    assert.equal(gts.assetOrigin(), 'https://gts.kuble.com');

    console.log('GTS: optionale Aktivierung, generische Brain-IDs sowie lazy Base-URL- und Asset-Origin-Ableitung sind korrekt.');
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.GTS_BASE_URL;
    else process.env.GTS_BASE_URL = originalBaseUrl;
    if (originalToken === undefined) delete process.env.GTS_API_TOKEN;
    else process.env.GTS_API_TOKEN = originalToken;
  }
  console.log('test-gts.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
