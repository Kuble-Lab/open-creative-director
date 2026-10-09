'use strict';

// Test support (not a test): the requests lib/rendernode.js sends to the render nodes, recorded with a fake fetch for fixed
// cases (no assets, quality, format and frame rate, streamed and inline assets, base64 assets, choice of the node).
// render-requests-before-wp46.json holds what the code before WP46 sent for them; scripts/test-render-agent-dispatch.js
// checks that the code with the own computers sends exactly the same while no computer may render the job.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="main-composition" data-width="1920" data-height="1080">Golden</div></body></html>';

function nodesFor(statuses) {
  return statuses.map((status, index) => ({ id: `node-${index + 1}`, name: `Node ${index + 1}`, url: `http://node${index + 1}.test`, token: `token-${index + 1}`, enabled: true, status }));
}

function recordingFetch(log, nodes) {
  let renders = 0;
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const node = nodes.find((entry) => parsed.origin === new URL(entry.url).origin);
    let body = options.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      body = `stream:${Buffer.concat(chunks).toString('base64')}`;
    }
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]).sort());
    log.push({ url: String(url), method: options.method || 'GET', headers, body: body === undefined ? null : body, duplex: options.duplex || null });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (parsed.pathname === '/health') return json({ ok: true, ...node.status });
    if (parsed.pathname === '/uploads') return json({ uploadId: 'r-upload1-0000000a' }, 201);
    if (parsed.pathname.startsWith('/uploads/')) return json({ ok: true }, 201);
    if (parsed.pathname === '/render') {
      renders += 1;
      return json({ jobId: `r-render${renders}-0000000b` }, 202);
    }
    if (parsed.pathname.endsWith('/file')) return new Response(Buffer.from('golden-mp4'), { status: 200 });
    if (parsed.pathname.startsWith('/jobs/')) return json({ jobId: 'r-render1-0000000b', status: 'running' });
    return json({ error: 'unknown' }, 404);
  };
}

function assetFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const clip = path.join(dir, 'clip.mp4');
  const image = path.join(dir, 'still.png');
  fs.writeFileSync(clip, Buffer.from('golden clip bytes'));
  fs.writeFileSync(image, Buffer.from('golden image bytes'));
  return {
    files: [
      { filename: 'upload-001.mp4', path: clip, size: fs.statSync(clip).size },
      { filename: 'upload-002.png', path: image, size: fs.statSync(image).size }
    ],
    totalBytes: fs.statSync(clip).size + fs.statSync(image).size
  };
}

const IDLE = { queue: 0, running: false, streamingUploads: true };
const BUSY = { queue: 2, running: true, streamingUploads: true };
const LEGACY = { queue: 0, running: false, streamingUploads: false };

// [name, node statuses, submit arguments (assets 'files' means the files above)]
const CASES = [
  ['plain', [IDLE], [HTML]],
  ['quality format fps', [IDLE], [HTML, 'high', undefined, 'portrait', 30]],
  ['streaming assets', [IDLE], [HTML, 'standard', 'files', 'landscape', 24]],
  ['inline assets (older node)', [LEGACY], [HTML, 'draft', 'files', 'square']],
  ['base64 assets of a programmatic caller', [IDLE], [HTML, 'draft', { 'a.png': 'iVBORw0KGgo=' }]],
  ['idle node first', [BUSY, IDLE], [HTML, 'standard', undefined, 'landscape']],
  ['shortest queue', [BUSY, { queue: 1, running: true, streamingUploads: true }], [HTML]]
];

async function runCases(createRenderNodeClient, { extraOptions = null, extraClient = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-golden-'));
  const files = assetFiles(tmp);
  const out = [];
  for (const [name, statuses, args] of CASES) {
    const nodes = nodesFor(statuses);
    const log = [];
    const client = createRenderNodeClient({ store: { listNodes: () => nodes.map(({ status, ...node }) => node) }, env: {}, fetchImpl: recordingFetch(log, nodes), ...extraClient });
    const call = args.map((value) => (value === 'files' ? files : value));
    const result = extraOptions ? await client.submit(...call, ...Array(Math.max(0, 5 - call.length)).fill(undefined), extraOptions) : await client.submit(...call);
    const status = await client.jobStatus(result.jobId, result.nodeId);
    const file = (await client.download(result.jobId, result.nodeId)).toString('base64');
    out.push({ name, result, status, file, requests: log });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

module.exports = { CASES, runCases, HTML };
