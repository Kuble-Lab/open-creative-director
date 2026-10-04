'use strict';

// The node "Depth map (fal)" (fal.depth_map, lib/nodes/nodes-fal.js, WP35): registry entry, the price (an estimate, marked as
// such), the checks BEFORE anything is uploaded or queued, the request to the Depth Anything V2 endpoint of fal.ai and the result:
// a grayscale PNG made locally here and handed over by the mocked fal client. The real tool fal_generate and the real result handler
// of the poller run on top of the mocks. Nothing leaves this machine: lib/fal.js is replaced, and the backing session and the temp
// files are removed at the end. The depth map as the input of the parallax motions is tested in test-nodes-zoom.js.

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
const nodesEdit = require('../lib/nodes/nodes-edit');
const defaultRegistry = require('../lib/nodes/registry');
const { createRegistry } = defaultRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine, estimateGraph } = require('../lib/nodes/engine');

const ENDPOINT = 'fal-ai/image-preprocessors/depth-anything/v2';

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

/* ---------- a grayscale PNG, made here: the left half bright (near), the right half dark (far) ---------- */

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
function grayPng(width = 8, height = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type 0: grayscale
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width);
    for (let x = 0; x < width; x += 1) row[1 + x] = x < width / 2 ? 235 : 20;
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
// colour type and the first row of a grayscale PNG
function readGray(buffer) {
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
  return { colourType, width, row: [...raw.subarray(1, 1 + width)] };
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-depth-'));
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  nodesFal.registerAll(registry);
  nodesEdit.registerAll(registry);
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
    const delivered = grayPng();
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
          // the shape of the answer of the endpoint: { image: Image }
          const result = { image: { url: 'https://v3b.fal.media/files/out/depth.png', content_type: 'image/png', file_name: 'depth.png', width: 8, height: 4 } };
          await poller.handleFalCompleted(sessionId, record, result, fal.extractMedia(result, record.resultKind));
          return jobs.waitForSessionJob(sessionId, record.jobId, { assetId: record.assetId, signal: controller.signal, intervalMs: 20, timeoutMs: 8000 });
        }
      };
    };
    const def = () => {
      const found = registry.get('fal.depth_map');
      assert.ok(found, 'fal.depth_map is registered');
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
      const types = nodesFal.definitions.map((item) => item.type);
      assert.ok(types.includes('fal.depth_map'));
      assert.deepEqual(types.slice(-3), ['fal.remove_background', 'fal.video_segment', 'fal.model'], 'the free node stays last');
      const node = def();
      assert.equal(node.category, 'fal');
      assert.equal(node.paid, true);
      assert.equal(node.async, true);
      assert.equal(node.label, 'Depth map (fal)');
      assert.deepEqual(node.inputs.map((port) => `${port.id}:${port.type}${port.required ? '!' : ''}`), ['image:image!']);
      assert.deepEqual(node.outputs.map((port) => `${port.id}:${port.type}`), ['depth:image']);
      assert.deepEqual(node.params.map((param) => [param.id, param.kind, param.default]), [['enabled', 'boolean', true]]);
      assert.equal(node.cost.unit, 'usd');
      const descriptor = JSON.parse(JSON.stringify(registry.publicDescriptor(node)));
      assert.equal(descriptor.provider, 'fal');
      assert.equal(descriptor.cost.hasEstimate, true);
      assert.ok(defaultRegistry.get('fal.depth_map'), 'the default registry of the server carries it');
      assert.equal(defaultRegistry.isRestricted(descriptor), false, 'open to participants: no Higgsfield node, no credits');
      hasKey = false;
      assert.match(String(registry.availability(node)), /FAL_KEY/);
      hasKey = true;
      assert.equal(registry.availability(node), true);
      // its output connects to the depth input of the zoom node, and nothing else of the zoom node changes
      assert.ok(registry.get('image.to_video').inputs.some((port) => port.id === 'depth' && port.type === 'image'));
    }

    /* ---------- price: an estimate, marked as one ---------- */
    {
      const price = nodesFal.PRICES.depthMap;
      assert.equal(price.endpoint, ENDPOINT);
      assert.equal(price.usd, 0.01);
      assert.equal(price.estimate, true, 'the price page gives no usable figure: an estimate, not a list price');
      assert.equal(price.fetched, '2026-10-04');
      assert.ok(Object.isFrozen(price));
      assert.equal(def().cost.estimate({}), 0.01);
    }

    /* ---------- the request ---------- */
    {
      resetCalls();
      const image = await upload('.png', grayPng());
      const plan = await nodesFal.planDepthMap(ctx(), { image });
      assert.equal(plan.endpoint, ENDPOINT);
      assert.deepEqual(plan.input, {});
      assert.deepEqual(plan.media, [{ field: 'image_url', assetIds: [image.assetId], multiple: false }]);
      assert.equal(plan.kind, 'image');
      assert.equal(plan.estimateUsd, 0.01);
      assert.equal(plan.pricing, null);
      nothingSent('planning sends nothing');
      // the plan of fal.remove_background is unchanged by the shared helper
      const cutout = await nodesFal.planRemoveBackground(ctx(), { image });
      assert.equal(cutout.endpoint, 'fal-ai/bria/background/remove');
      assert.equal(cutout.estimateUsd, 0.018);
    }

    /* ---------- checks before anything is sent ---------- */
    {
      await failing({}, /image: connect an image/);
      await failing({ image: await upload('.png', grayPng(), { owner: otherSession.id }) }, /another session/);
      await failing({ image: await upload('.gif', Buffer.from('GIF89a')) }, /only PNG, JPEG or WebP images can be sent to fal\.ai \(got \.gif\)/);
      await failing({ image: await upload('.png', null, { size: fal.MAX_UPLOAD_BYTES + 1 }) }, /image: at most 90 MB are allowed/);
      const gone = await upload('.png', grayPng());
      await fsp.rm(path.join(store.sessionAssetDir(sessionId), gone.file));
      await failing({ image: gone }, /image: the file is missing/);
      hasKey = false;
      resetCalls();
      await assert.rejects(run({ image: await upload('.png', grayPng()) }), /FAL_KEY/);
      nothingSent();
      hasKey = true;
      resetCalls();
      const aborted = ctx();
      aborted.controller.abort();
      await assert.rejects(def().execute(aborted, { image: await upload('.png', grayPng()) }, registry.normalizeParams(def(), {})), { name: 'AbortError' });
      nothingSent();
    }

    /* ---------- a run: upload, queue, a grayscale image comes back ---------- */
    {
      for (const [ext, contentType] of [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp']]) {
        resetCalls();
        const source = await upload(ext, ext === '.png' ? grayPng() : Buffer.from(`pixels${ext}`));
        const result = await run({ image: source });
        assert.deepEqual(falCalls.upload, [{ file: source.file, contentType }], ext);
        assert.equal(falCalls.submit.length, 1);
        assert.equal(falCalls.submit[0].endpoint, ENDPOINT);
        assert.deepEqual(falCalls.submit[0].input, { image_url: `https://v3b.fal.media/files/${source.file}` });
        assert.deepEqual(falCalls.download, ['https://v3b.fal.media/files/out/depth.png']);
        assert.equal(result.variants.length, 1);
        assert.deepEqual(Object.keys(result.variants[0]), ['depth']);
        const output = result.variants[0].depth;
        assert.equal(output.type, 'image');
        assert.equal(output.sessionId, sessionId);
        assert.match(output.url, new RegExp(`^/assets/${sessionId}/img-\\d{3}\\.png$`));
        assert.notEqual(output.assetId, source.assetId);
        const bytes = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), output.file));
        assert.ok(bytes.equals(delivered), 'stored unchanged');
        const gray = readGray(bytes);
        assert.equal(gray.colourType, 0, 'grayscale');
        assert.ok(gray.row[0] > gray.row[gray.width - 1], 'bright = near');
        // the cost: an estimate, booked and marked as one
        assert.deepEqual(result.cost, { usd: 0.01 });
        assert.equal(journal.length, 1);
        assert.equal(journal[0].type, 'fal');
        assert.equal(journal[0].model, ENDPOINT);
        assert.equal(journal[0].cost, 0.01);
        assert.match(journal[0].billing, /Schaetzung/);
        const entry = (await store.readLedger(sessionId)).find((item) => item.id === output.assetId);
        assert.equal(entry.cost, 0.01);
        assert.equal(entry.costEstimated, true);
        assert.equal(entry.kind, 'image');
        const job = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === output.assetId);
        assert.equal(job.resultKind, 'image');
        assert.equal(job.endpoint, ENDPOINT);
      }
    }

    /* ---------- switched off: nothing is sent, nothing is paid, the optional depth input works without it ---------- */
    {
      resetCalls();
      const off = await run({ image: await upload('.png', grayPng()) }, { enabled: false });
      assert.deepEqual(off.variants, [{}], 'no output');
      assert.deepEqual(off.cost, { usd: 0 });
      nothingSent('switched off');
      assert.equal(journal.length, 0);
      assert.equal(def().cost.estimate({ enabled: false }), 0);
      assert.equal(def().cost.estimate({ enabled: true }), 0.01);
      assert.deepEqual(def().emptyOutputs({ enabled: false }), ['depth']);
      assert.deepEqual(def().emptyOutputs({ enabled: true }), []);
    }

    /* ---------- in a workflow: the plan names the price, the depth output feeds the zoom node ---------- */
    {
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
      const { workflow } = await wfStore.createWorkflow({ name: 'Depth', graph: { nodes: [], edges: [] } });
      created.push(workflow.id);
      sessions.push(workflow.sessionId);
      const source = await upload('.png', grayPng(), { owner: workflow.sessionId });
      const current = await wfStore.readWorkflow(workflow.id);
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      await wfStore.saveGraph(workflow.id, {
        baseRev: current.rev,
        graph: {
          nodes: [
            node('i', 'input.image', { asset: { assetId: source.assetId, sessionId: workflow.sessionId } }),
            node('d', 'fal.depth_map', {}, 300),
            node('z', 'image.to_video', { zoom: 'parallax_right' }, 600),
            node('o', 'output.result', { label: 'Video' }, 900)
          ],
          edges: [
            { id: 'e1', from: { node: 'i', port: 'image' }, to: { node: 'd', port: 'image' } },
            { id: 'e2', from: { node: 'i', port: 'image' }, to: { node: 'z', port: 'image' } },
            { id: 'e3', from: { node: 'd', port: 'depth' }, to: { node: 'z', port: 'depth' } },
            { id: 'e4', from: { node: 'z', port: 'video' }, to: { node: 'o', port: 'inputs' } }
          ]
        }
      });
      const plan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.deepEqual(plan.nodes.d.estimate, { usd: 0.01 });
      assert.equal(plan.totals.unknownNodes, 0);
      assert.ok(Math.abs(plan.totals.usd - 0.01) < 1e-9);
      assert.equal(plan.issues.filter((issue) => issue.level === 'warning').length, 0, 'the depth map is connected: no warning');
      // switched off: free in the plan, the zoom node (optional depth input) runs without a map and falls back, a run costs nothing
      const savedGraph = await wfStore.readWorkflow(workflow.id);
      await wfStore.saveGraph(workflow.id, {
        baseRev: savedGraph.rev,
        graph: { ...savedGraph.graph, nodes: savedGraph.graph.nodes.map((item) => (item.id === 'd' ? { ...item, params: { enabled: false } } : item)) }
      });
      const offPlan = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(offPlan.valid, true, JSON.stringify(offPlan.issues));
      assert.deepEqual(offPlan.nodes.d.estimate, { usd: 0 });
      assert.ok(offPlan.totals.usd < 1e-9);
      resetCalls();
      const offRun = await engine.whenFinished(workflow.id, await engine.start(workflow.id, { mode: 'all' }));
      assert.equal(offRun.status, 'completed', JSON.stringify(offRun.nodes));
      assert.equal(offRun.nodes.z.status, 'done', 'the zoom node runs without the map');
      nothingSent('a switched off depth node sends nothing');
      assert.equal(offRun.cost.usd, 0);
      const estimate = estimateGraph({ nodes: [node('i', 'input.image'), node('d', 'fal.depth_map')], edges: [{ id: 'e1', from: { node: 'i', port: 'image' }, to: { node: 'd', port: 'image' } }] }, { registry });
      assert.ok(Math.abs(estimate.usd - 0.01) < 1e-9);
      assert.equal(estimate.unknownNodes, 0);
    }
  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    for (const id of [...new Set(sessions)]) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-depth-map.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
