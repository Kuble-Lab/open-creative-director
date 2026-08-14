'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const rendernode = require('../lib/rendernode');
const costs = require('../lib/costs');
const { executeTool } = require('../lib/tools');

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const originalSubmit = rendernode.submit;
  const originalRecordCost = costs.recordCost;
  const originalFetch = global.fetch;
  const originalRenderNodeUrl = process.env.RENDER_NODE_URL;
  const originalRenderNodeToken = process.env.RENDER_NODE_TOKEN;
  const source = Buffer.from('render-asset-test');
  let submitted;
  let submitCalls = 0;

  rendernode.submit = async (html, quality, assets) => {
    submitCalls += 1;
    submitted = { html, quality, assets };
    return { jobId: 'render-job-test', nodeId: 'node-00000001' };
  };
  costs.recordCost = async (entry) => entry;

  try {
    const ready = await store.saveAsset(session.id, {
      kind: 'upload',
      buffer: source,
      ext: '.png',
      prompt: 'Testbild',
      cost: null
    });
    const pending = await store.reserveAsset(session.id, {
      kind: 'upload',
      ext: '.png',
      prompt: 'Pendentes Testbild'
    });

    const outcome = await executeTool(
      { sessionId: session.id, emit() {}, user: 'test' },
      'render_motion_graphics',
      {
        html: '<div id="main-composition" data-width="1920" data-height="1080"><img src="upload-001.png"></div>',
        quality: 'draft',
        label: 'Asset-Test',
        asset_ids: [ready.id]
      }
    );

    assert.equal(outcome.job.jobId, 'render-job-test');
    assert.equal(submitted.html, '<div id="main-composition" data-width="1920" data-height="1080"><img src="upload-001.png"></div>');
    assert.equal(submitted.quality, 'draft');
    assert.deepEqual(submitted.assets, { 'upload-001.png': source.toString('base64') });

    await assert.rejects(
      executeTool(
        { sessionId: session.id, emit() {}, user: 'test' },
        'render_motion_graphics',
        { html: '<div data-width="1920" data-height="1080"></div>', label: 'Unbekanntes Asset', asset_ids: ['upload-999'] }
      ),
      /Asset upload-999 existiert nicht in dieser Session\./
    );
    await assert.rejects(
      executeTool(
        { sessionId: session.id, emit() {}, user: 'test' },
        'render_motion_graphics',
        { html: '<div data-width="1920" data-height="1080"></div>', label: 'Pendentes Asset', asset_ids: [pending.id] }
      ),
      new RegExp(`Asset ${pending.id} ist noch nicht fertig\\.`)
    );
    assert.equal(submitCalls, 1, 'Fehlerhafte Asset-IDs duerfen keinen Render-Auftrag starten.');

    rendernode.submit = originalSubmit;
    process.env.RENDER_NODE_URL = 'http://render-node.test';
    process.env.RENDER_NODE_TOKEN = 'render-node-token';
    let renderRequest;
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, queue: 0, running: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      renderRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({ jobId: 'render-client-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    assert.deepEqual(
      await rendernode.submit('<div></div>', 'standard', submitted.assets),
      { jobId: 'render-client-test', nodeId: 'node-default' }
    );
    assert.deepEqual(renderRequest.assets, submitted.assets);

    console.log('Render-Assets: Dateiname, Base64 und POST-Body korrekt; unbekannte und pendente IDs liefern klare Fehler.');
  } finally {
    rendernode.submit = originalSubmit;
    costs.recordCost = originalRecordCost;
    global.fetch = originalFetch;
    if (originalRenderNodeUrl === undefined) delete process.env.RENDER_NODE_URL;
    else process.env.RENDER_NODE_URL = originalRenderNodeUrl;
    if (originalRenderNodeToken === undefined) delete process.env.RENDER_NODE_TOKEN;
    else process.env.RENDER_NODE_TOKEN = originalRenderNodeToken;
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
