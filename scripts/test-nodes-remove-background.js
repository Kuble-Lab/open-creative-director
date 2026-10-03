'use strict';

// The node "Remove background (fal)" (fal.remove_background, lib/nodes/nodes-fal.js, WP28): registry entry, the price per
// image, the checks BEFORE anything is uploaded or queued, the request to the Bria endpoint of fal.ai and the result: a PNG
// with an alpha channel, made locally here and handed over by the mocked fal client. The real tool fal_generate and the real
// result handler of the poller run on top of the mocks. Nothing leaves this machine: lib/fal.js is replaced, and the
// backing session and the temp files are removed at the end.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const store = require('../lib/store');
const fal = require('../lib/fal');
const costs = require('../lib/costs');
const poller = require('../lib/poller');
const assets = require('../lib/nodes/assets');
const jobs = require('../lib/nodes/jobs');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const defaultRegistry = require('../lib/nodes/registry');
const { createRegistry } = defaultRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const ENDPOINT = 'fal-ai/bria/background/remove';

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

/* ---------- a PNG with an alpha channel, made here ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, tail]);
}
// width x height RGBA, 8 bit: the left half is fully transparent, the right half an opaque red.
function pngWithAlpha(width = 8, height = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type 6: RGBA
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4); // filter byte 0
    for (let x = 0; x < width; x += 1) {
      const at = 1 + x * 4;
      if (x >= width / 2) row.set([220, 30, 30, 255], at);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
// colour type and the alpha values of the first row
function readAlpha(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  const width = buffer.readUInt32BE(16);
  const colourType = buffer[25];
  let offset = 8;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const alphas = [];
  for (let x = 0; x < width; x += 1) alphas.push(raw[1 + x * 4 + 3]);
  return { colourType, width, alphas };
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-remove-bg-'));
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  nodesFal.registerAll(registry);
  const sessions = [];
  const created = [];
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(tmpDir, 'workflows'), registry, events: bus });

  try {
    const session = await store.createSession();
    sessions.push(session.id);
    const sessionId = session.id;
    const otherSession = await store.createSession();
    sessions.push(otherSession.id);

    /* ---------- recorders ---------- */
    let hasKey = true;
    const falCalls = { upload: [], submit: [], download: [] };
    const journal = [];
    patch(costs, 'recordCost', async (entry) => {
      journal.push(entry);
      return entry;
    });
    patch(fal, 'hasKey', () => hasKey);
    patch(fal, 'uploadFile', async (file, options) => {
      falCalls.upload.push({ file: path.basename(file), contentType: options.contentType });
      return { url: `https://v3b.fal.media/files/${path.basename(file)}`, size: 4, contentType: options.contentType, fileName: options.fileName };
    });
    let requestCounter = 0;
    patch(fal, 'submit', async (endpoint, input) => {
      falCalls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)) });
      requestCounter += 1;
      return {
        requestId: `req-${requestCounter}`,
        statusUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}/status`,
        responseUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}`
      };
    });
    // what fal.ai delivers: a PNG with transparency (made above), written where the poller asks for it
    const delivered = pngWithAlpha();
    patch(fal, 'downloadToFile', async (url, dest) => {
      falCalls.download.push(url);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, delivered);
      return { bytes: delivered.length, contentType: 'image/png' };
    });
    const resetCalls = () => {
      falCalls.upload.length = 0;
      falCalls.submit.length = 0;
      falCalls.download.length = 0;
      journal.length = 0;
    };
    const nothingSent = (message) => assert.deepEqual([falCalls.upload.length, falCalls.submit.length], [0, 0], message || 'nothing uploaded, nothing queued');

    let assetCounter = 0;
    async function upload(ext, bytes, { size, owner = sessionId } = {}) {
      assetCounter += 1;
      const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes || Buffer.from(`data${assetCounter}`), ext, prompt: 'seed' });
      if (size) {
        const handle = await fsp.open(path.join(store.sessionAssetDir(owner), saved.file), 'w');
        await handle.truncate(size);
        await handle.close();
      }
      return assets.valueFromAsset(owner, saved.id);
    }

    // completes the queued job like the poller does, with the real result handler
    const ctx = () => {
      const controller = new AbortController();
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: {},
        signal: controller.signal,
        controller,
        toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', emit() {}, signal: controller.signal },
        log() {},
        withLocalSlot: (fn) => fn(),
        waitForJob: async (job) => {
          const current = await store.readSession(sessionId);
          const record = current.jobs.find((entry) => entry.assetId === job.assetId);
          const result = { image: { url: 'https://v3b.fal.media/files/out/result.png', content_type: 'image/png', file_name: 'result.png', width: 8, height: 4 } };
          await poller.handleFalCompleted(sessionId, record, result, fal.extractMedia(result, record.resultKind));
          return jobs.waitForSessionJob(sessionId, record.jobId, { assetId: record.assetId, signal: controller.signal, intervalMs: 20, timeoutMs: 8000 });
        }
      };
    };
    const def = () => {
      const found = registry.get('fal.remove_background');
      assert.ok(found, 'fal.remove_background is registered');
      return found;
    };
    const run = (inputs, rawParams = {}) => def().execute(ctx(), inputs, registry.normalizeParams(def(), rawParams));
    const failing = async (inputs, pattern) => {
      resetCalls();
      await assert.rejects(run(inputs), pattern);
      nothingSent(String(pattern));
    };

    /* ---------- registry ---------- */
    {
      assert.deepEqual(nodesFal.definitions.map((item) => item.type).slice(-3), ['fal.remove_background', 'fal.video_segment', 'fal.model'], 'before the free node, which stays last');
      const node = def();
      assert.equal(node.category, 'fal');
      assert.equal(node.paid, true);
      assert.equal(node.async, true);
      assert.equal(node.experimental, true, 'not verified against the live API, like every fal node');
      assert.equal(node.label, 'Remove background (fal)');
      assert.deepEqual(node.inputs.map((port) => `${port.id}:${port.type}${port.required ? '!' : ''}`), ['image:image!']);
      assert.deepEqual(node.outputs.map((port) => `${port.id}:${port.type}`), ['image:image']);
      assert.deepEqual(node.params, []);
      assert.equal(node.cost.unit, 'usd');
      const descriptor = JSON.parse(JSON.stringify(registry.publicDescriptor(node)));
      assert.equal(descriptor.provider, 'fal');
      assert.equal(descriptor.cost.hasEstimate, true);
      // the default registry of the server carries it
      assert.ok(defaultRegistry.get('fal.remove_background'));
      // participants and guests may use it: it is no Higgsfield node and bills no credits
      assert.equal(defaultRegistry.isRestricted(descriptor), false);
      assert.equal(defaultRegistry.isRestricted(defaultRegistry.publicDescriptor(defaultRegistry.get('fal.remove_background'))), false);
      assert.equal(defaultRegistry.isRestricted(defaultRegistry.publicDescriptor(defaultRegistry.get('hf.remove_background'))), true, 'the Higgsfield node stays closed for them');
      // availability follows the key
      hasKey = false;
      assert.match(String(registry.availability(node)), /FAL_KEY/);
      hasKey = true;
      assert.equal(registry.availability(node), true);
    }

    /* ---------- price ---------- */
    {
      assert.equal(nodesFal.PRICES.removeBackground.endpoint, ENDPOINT);
      assert.equal(nodesFal.PRICES.removeBackground.usd, 0.018, 'list price per image (fal.ai, 2026-10-02)');
      assert.equal(nodesFal.PRICES.removeBackground.fetched, '2026-10-02');
      assert.equal(def().cost.estimate({}), 0.018);
      assert.ok(Object.isFrozen(nodesFal.PRICES.removeBackground));
    }

    /* ---------- the request ---------- */
    {
      resetCalls();
      const image = await upload('.png', pngWithAlpha(), {});
      const plan = await nodesFal.planRemoveBackground(ctx(), { image });
      assert.equal(plan.endpoint, ENDPOINT);
      assert.deepEqual(plan.input, {});
      assert.deepEqual(plan.media, [{ field: 'image_url', assetIds: [image.assetId], multiple: false }]);
      assert.equal(plan.kind, 'image');
      assert.equal(plan.estimateUsd, 0.018);
      assert.equal(plan.pricing, null, 'a flat price per image: no price per second');
      nothingSent('planning sends nothing');
    }

    /* ---------- checks before anything is sent ---------- */
    {
      await failing({}, /image: connect an image/);
      await failing({ image: await upload('.png', pngWithAlpha(), { owner: otherSession.id }) }, /another session/);
      await failing({ image: await upload('.gif', Buffer.from('GIF89a')) }, /only PNG, JPEG or WebP images can be sent to fal\.ai \(got \.gif\)/);
      await failing({ image: await upload('.png', null, { size: fal.MAX_UPLOAD_BYTES + 1 }) }, /image: at most 90 MB are allowed/);
      const gone = await upload('.png', pngWithAlpha());
      await fsp.rm(path.join(store.sessionAssetDir(sessionId), gone.file));
      await failing({ image: gone }, /image: the file is missing/);
      // no key: nothing is sent
      hasKey = false;
      resetCalls();
      await assert.rejects(run({ image: await upload('.png', pngWithAlpha()) }), /FAL_KEY/);
      nothingSent();
      hasKey = true;
      // an aborted run does not start a paid job
      resetCalls();
      const aborted = ctx();
      aborted.controller.abort();
      await assert.rejects(def().execute(aborted, { image: await upload('.png', pngWithAlpha()) }, registry.normalizeParams(def(), {})), { name: 'AbortError' });
      nothingSent();
    }

    /* ---------- a run: upload, queue, result with transparency ---------- */
    {
      for (const [ext, contentType] of [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]) {
        resetCalls();
        const source = await upload(ext, ext === '.png' ? pngWithAlpha() : Buffer.from(`pixels${ext}`));
        const result = await run({ image: source });
        assert.equal(falCalls.upload.length, 1, ext);
        assert.deepEqual(falCalls.upload[0], { file: source.file, contentType });
        assert.equal(falCalls.submit.length, 1);
        assert.equal(falCalls.submit[0].endpoint, ENDPOINT);
        assert.deepEqual(falCalls.submit[0].input, { image_url: `https://v3b.fal.media/files/${source.file}` }, 'the input of the endpoint: the image URL only, no sync_mode');
        assert.deepEqual(falCalls.download, ['https://v3b.fal.media/files/out/result.png']);
        assert.equal(result.variants.length, 1);
        const output = result.variants[0].image;
        assert.equal(output.type, 'image');
        assert.equal(output.sessionId, sessionId);
        assert.match(output.url, new RegExp(`^/assets/${sessionId}/img-\\d{3}\\.png$`), 'the result is a PNG whatever the source was');
        assert.notEqual(output.assetId, source.assetId);
        // the file: the PNG of fal, with its alpha channel
        const bytes = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), output.file));
        assert.ok(bytes.equals(delivered), 'stored unchanged');
        const alpha = readAlpha(bytes);
        assert.equal(alpha.colourType, 6, 'RGBA');
        assert.deepEqual(alpha.alphas, [0, 0, 0, 0, 255, 255, 255, 255], 'transparent where the background was');
        // the price: a list price, flat per image, journaled as an estimate
        assert.deepEqual(result.cost, { usd: 0.018 });
        assert.equal(journal.length, 1);
        assert.equal(journal[0].type, 'fal');
        assert.equal(journal[0].model, ENDPOINT);
        assert.equal(journal[0].cost, 0.018);
        assert.match(journal[0].billing, /Schaetzung/);
        const entry = (await store.readLedger(sessionId)).find((item) => item.id === output.assetId);
        assert.equal(entry.cost, 0.018);
        assert.equal(entry.costEstimated, true, 'the card says "about"');
        assert.equal(entry.kind, 'image');
        // the job remembers what was sent
        const job = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === output.assetId);
        assert.equal(job.resultKind, 'image');
        assert.equal(job.endpoint, ENDPOINT);
        assert.equal(job.costEstimateUsd, 0.018);
      }
    }

    /* ---------- in a workflow: the plan names the price ---------- */
    {
      resetCalls();
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
      const { workflow } = await wfStore.createWorkflow({ name: 'Cutout', graph: { nodes: [], edges: [] } });
      created.push(workflow.id);
      const source = await upload('.png', pngWithAlpha(), { owner: workflow.sessionId });
      sessions.push(workflow.sessionId);
      const current = await wfStore.readWorkflow(workflow.id);
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      await wfStore.saveGraph(workflow.id, {
        baseRev: current.rev,
        graph: {
          nodes: [node('i', 'input.image', { asset: { assetId: source.assetId, sessionId: workflow.sessionId } }), node('r', 'fal.remove_background', {}, 300), node('o', 'output.result', { label: 'Cutout' }, 600)],
          edges: [
            { id: 'e1', from: { node: 'i', port: 'image' }, to: { node: 'r', port: 'image' } },
            { id: 'e2', from: { node: 'r', port: 'image' }, to: { node: 'o', port: 'inputs' } }
          ]
        }
      });
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.deepEqual(plan.nodes.r.estimate, { usd: 0.018 });
      assert.equal(plan.nodes.r.paid, true);
      assert.equal(plan.totals.unknownNodes, 0);
      assert.ok(Math.abs(plan.totals.usd - 0.018) < 1e-9);
      // the template estimate sees it as well
      const graphEstimate = require('../lib/nodes/engine').estimateGraph(
        { nodes: [node('i', 'input.image'), node('r', 'fal.remove_background')], edges: [{ id: 'e1', from: { node: 'i', port: 'image' }, to: { node: 'r', port: 'image' } }] },
        { registry }
      );
      assert.ok(Math.abs(graphEstimate.usd - 0.018) < 1e-9);
      assert.equal(graphEstimate.unknownNodes, 0);
    }

  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    for (const id of [...new Set(sessions)]) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-remove-background.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
