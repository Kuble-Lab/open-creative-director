'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { createRenderService } = require('../render-node/service');
const {
  createRenderNodeClient,
  chooseAssetTransport,
  MAX_LEGACY_ASSET_BYTES
} = require('../lib/rendernode');

function invoke(service, { method, url, token, contentType, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {};
    if (token) req.headers.authorization = `Bearer ${token}`;
    if (contentType) req.headers['content-type'] = contentType;
    const result = { status: 200, body: null };
    const res = {
      writableEnded: false,
      writeHead(status) {
        result.status = status;
      },
      end(value) {
        this.writableEnded = true;
        result.body = JSON.parse(String(value || '{}'));
        resolve(result);
      }
    };
    Promise.resolve(service.handle(req, res)).catch(reject);
  });
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-render-streaming-'));
  const token = 'streaming-test-token';
  await fsp.mkdir(path.join(base, 'template'), { recursive: true });
  await fsp.writeFile(path.join(base, 'template', 'hyperframes.json'), '{}\n', 'utf8');
  const service = createRenderService({
    base,
    token,
    renderExecutor: async ({ out }) => { await fsp.writeFile(out, Buffer.from('rendered')); }
  });
  try {
    const health = await invoke(service, { method: 'GET', url: '/health' });
    assert.equal(health.body.streamingUploads, true);

    const uploadResponse = await invoke(service, {
      method: 'POST',
      url: '/uploads',
      token
    });
    assert.equal(uploadResponse.status, 201);
    const { uploadId } = uploadResponse.body;
    assert.match(uploadId, /^r-[a-z0-9]+-[a-f0-9]{8}$/);

    const put = await invoke(service, {
      method: 'PUT',
      url: `/uploads/${uploadId}/upload-001.mp4`,
      token,
      contentType: 'application/octet-stream',
      chunks: [Buffer.from('streamed-'), Buffer.from('video')]
    });
    assert.equal(put.status, 201);
    assert.equal(put.body.bytes, 14);
    assert.equal(
      await fsp.readFile(path.join(service.uploadsDir, uploadId, 'upload-001.mp4'), 'utf8'),
      'streamed-video'
    );

    const renderResponse = await invoke(service, {
      method: 'POST',
      url: '/render',
      token,
      contentType: 'application/json',
      chunks: [Buffer.from(JSON.stringify({ html: '<main></main>', quality: 'draft', uploadId }))]
    });
    assert.equal(renderResponse.status, 202);
    const render = renderResponse.body;
    const moved = path.join(service.jobsDir, render.jobId, 'project', 'upload-001.mp4');
    assert.equal(await fsp.readFile(moved, 'utf8'), 'streamed-video');
    assert.equal(fs.existsSync(path.join(service.uploadsDir, uploadId)), false);

    const clientSource = path.join(base, 'client-source.mp4');
    await fsp.writeFile(clientSource, Buffer.from('client-stream'));
    let uploadedByClient = '';
    let renderPayload;
    const client = createRenderNodeClient({
      store: {
        listNodes: () => [{
          id: 'node-stream',
          name: 'Streaming-Test',
          url: 'http://streaming.test',
          token,
          enabled: true
        }]
      },
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/health') {
          return new Response(JSON.stringify({ ok: true, queue: 0, running: false, streamingUploads: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (pathname === '/uploads') {
          return new Response(JSON.stringify({ uploadId: 'r-client1-deadbeef' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (pathname.startsWith('/uploads/')) {
          for await (const chunk of options.body) uploadedByClient += chunk.toString();
          assert.equal(options.duplex, 'half');
          return new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (pathname === '/render') {
          renderPayload = JSON.parse(options.body);
          return new Response(JSON.stringify({ jobId: 'job-streaming-client' }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        throw new Error(`Unerwarteter Client-Pfad: ${pathname}`);
      }
    });
    assert.deepEqual(
      await client.submit('<main></main>', 'standard', {
        files: [{ filename: 'vid-001.mp4', path: clientSource, size: 13 }],
        totalBytes: 13
      }),
      { jobId: 'job-streaming-client', nodeId: 'node-stream' }
    );
    assert.equal(uploadedByClient, 'client-stream');
    assert.equal(renderPayload.uploadId, 'r-client1-deadbeef');
    assert.equal(renderPayload.assets, undefined);

    assert.equal(chooseAssetTransport({ streamingUploads: true, totalBytes: 100 * 1024 * 1024 }), 'streaming');
    assert.equal(chooseAssetTransport({ streamingUploads: false, totalBytes: MAX_LEGACY_ASSET_BYTES }), 'base64');
    assert.throws(
      () => chooseAssetTransport({
        streamingUploads: false,
        totalBytes: MAX_LEGACY_ASSET_BYTES + 1,
        nodeName: 'Alt'
      }),
      /Render-Node Alt unterstuetzt noch keine grossen Uploads - Node-Service aktualisieren\./
    );

    console.log('Render-Streaming: Upload-Staging, Stream-to-Disk, Render-Move und Client-Fallback sind korrekt.');
  } finally {
    await service.close();
    await fsp.rm(base, { recursive: true, force: true });
  }
  console.log('test-render-streaming.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
