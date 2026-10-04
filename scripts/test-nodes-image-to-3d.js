'use strict';

// The node "Image to 3D" (fal.image_to_3d, lib/nodes/nodes-fal.js, WP32) and everything a 3D result needs: the port type
// model3d, the GLB (glTF binary) as a stored result with a preview image (the render of the provider, else one the app draws
// from the GLB: lib/glb-preview.js), the four models (Tripo H3.1, Hunyuan 3D Pro 3.1, Meshy 7.1, SAM 3D Objects), their requests and
// estimates, the checks BEFORE anything is uploaded or queued, the failures of a result (no GLB, SAM 3D with a splat only), the
// limits per model with connections that stay, the ZIP of the outputs (the GLB belongs in), send-to-chat (a 3D model is refused,
// its preview is not) and the budget of participants.
//
// A private copy of the app runs in a temp directory (own data folders, ephemeral port): nothing touches the real data.
// lib/fal.js is replaced by mocks and a fetch guard refuses everything except localhost, so nothing is paid and nothing
// leaves the machine. The GLB the "provider" delivers is made here (scripts/support/glb.js).

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const yauzl = require('yauzl');

const { createIsolatedApp } = require('./support/isolated-app');
const { cubeGlb, readGlb } = require('./support/glb');
const typesLib = require('../lib/nodes/types');
const falPure = require('../lib/fal');
const glbPreview = require('../lib/glb-preview');
const graphLib = require('../public/nodes/graph');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const P1 = 'p1@gmail.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GLB = cubeGlb({ color: [0.85, 0.35, 0.25] });
const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plainJson = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} ${actual} !== ${expected}`.trim());

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

// Nothing but localhost may be reached, whatever a code path tries.
function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return {
    attempts,
    restore() {
      global.fetch = original;
    }
  };
}

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });
const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

/* ---------- pure parts: port type, values, assets, results, visibility, texts ---------- */

function testPortType() {
  const { portTypes, compat } = typesLib.describe();
  assert.deepEqual(portTypes.model3d, { label: '3D model', color: '--nv-port-model3d', media: true });
  assert.ok(typesLib.BASE_TYPES.includes('model3d') && typesLib.MEDIA_TYPES.includes('model3d'));
  // compatible with itself and with `any`, with nothing else, in both directions and as a list
  for (const other of typesLib.BASE_TYPES) {
    const expected = other === 'model3d' || other === 'any';
    assert.equal(typesLib.canConnect('model3d', other), expected, `model3d -> ${other}`);
    assert.equal(typesLib.canConnect(other, 'model3d'), expected, `${other} -> model3d`);
    assert.equal(compat.model3d[other], expected);
    assert.equal(compat[other].model3d, expected);
  }
  assert.equal(typesLib.canConnect('model3d[]', 'model3d'), true);
  assert.equal(typesLib.canConnect('model3d', 'image[]'), false);
  // values
  const value = { type: 'model3d', sessionId: 's1', assetId: 'mod-001', file: 'mod-001.glb', url: '/assets/s1/mod-001.glb' };
  assert.equal(typesLib.isValue(value), true);
  assert.equal(typesLib.isValue({ type: 'model3d' }), false);
  assert.equal(typesLib.fingerprint(value), 's1/mod-001');
  assert.equal(typesLib.valueType(typesLib.listValue('model3d', [value])), 'model3d[]');
  assert.deepEqual(typesLib.adaptValue(value, 'any'), { value, map: false });
  assert.ok(typesLib.adaptValue(value, 'image').error, 'a 3D model is no image');
  assert.ok(typesLib.adaptValue({ type: 'image', sessionId: 's1', assetId: 'img-001' }, 'model3d').error);
  // the colour has a rule in the stylesheet
  const css = fs.readFileSync(path.join(root, 'public', 'nodes', 'nodes.css'), 'utf8');
  assert.match(css, /--nv-port-model3d:\s*#[0-9a-f]{6}/i);
  assert.match(css, /\.nv-port\.nv-port-model3d\s*\{[^}]*--nv-port-model3d/);
}

function testResultExtraction() {
  const file = (url, extra = {}) => ({ url, content_type: 'model/gltf-binary', ...extra });
  const pick = (result) => falPure.extractMedia(result, 'model3d');
  // Tripo: model_mesh and the preview in rendered_image
  let found = pick({ model_mesh: file('https://v3b.fal.media/a/tripo.glb'), rendered_image: { url: 'https://v3b.fal.media/a/render.png', content_type: 'image/png' }, model_urls: { glb: file('https://v3b.fal.media/a/other.glb') } });
  assert.deepEqual(found, {
    url: 'https://v3b.fal.media/a/tripo.glb',
    contentType: 'model/gltf-binary',
    kind: 'model3d',
    preview: { url: 'https://v3b.fal.media/a/render.png', contentType: 'image/png' },
    fallbacks: [{ url: 'https://v3b.fal.media/a/other.glb', contentType: 'model/gltf-binary' }]
  });
  // Hunyuan / Meshy: model_glb and thumbnail
  found = pick({ model_glb: file('https://v3b.fal.media/a/h.glb'), thumbnail: { url: 'https://v3b.fal.media/a/t.png' }, model_urls: {} });
  assert.equal(found.url, 'https://v3b.fal.media/a/h.glb');
  assert.deepEqual(found.preview, { url: 'https://v3b.fal.media/a/t.png', contentType: '' });
  // the order: model_glb, model_mesh, model_urls.glb
  assert.equal(pick({ model_urls: { glb: file('https://x.fal.media/c.glb') }, model_mesh: file('https://x.fal.media/b.glb'), model_glb: file('https://x.fal.media/a.glb') }).url, 'https://x.fal.media/a.glb');
  assert.equal(pick({ model_urls: { glb: file('https://x.fal.media/c.glb') }, model_mesh: file('https://x.fal.media/b.glb') }).url, 'https://x.fal.media/b.glb');
  // Tripo may deliver an FBX as model_mesh: the GLB of model_urls is taken instead, a FBX alone is no result
  assert.equal(pick({ model_mesh: file('https://x.fal.media/b.fbx', { content_type: 'application/octet-stream' }), model_urls: { glb: file('https://x.fal.media/c.glb') } }).url, 'https://x.fal.media/c.glb');
  assert.equal(pick({ model_mesh: file('https://x.fal.media/b.fbx', { content_type: 'application/octet-stream' }) }), null);
  assert.equal(falPure.modelProblem({ model_mesh: file('https://x.fal.media/b.fbx') }), 'other_format');
  assert.equal(pick({ model_mesh: { url: 'https://x.fal.media/b', content_type: 'text/html' } }), null, 'by the content type');
  assert.equal(pick({ model_mesh: { url: 'https://x.fal.media/model', content_type: 'application/octet-stream' } }).url, 'https://x.fal.media/model', 'a file that says nothing is checked by its first bytes later');
  // the other files that may be the GLB come along in order, without the same address twice and without a file of another format
  found = pick({ model_mesh: { url: 'https://x.fal.media/model', content_type: 'application/octet-stream' }, model_urls: { glb: file('https://x.fal.media/c.glb') }, model_glb: file('https://x.fal.media/model') });
  assert.equal(found.url, 'https://x.fal.media/model');
  assert.deepEqual(found.fallbacks, [{ url: 'https://x.fal.media/c.glb', contentType: 'model/gltf-binary' }]);
  assert.equal('fallbacks' in pick({ model_glb: file('https://x.fal.media/a.glb') }), false, 'nothing to fall back to: no field');
  assert.equal('fallbacks' in pick({ model_glb: file('https://x.fal.media/a.glb'), model_urls: { glb: file('https://x.fal.media/a.glb') } }), false, 'the same address twice is one file');
  assert.equal('fallbacks' in pick({ model_mesh: file('https://x.fal.media/b.glb'), model_urls: { glb: file('https://x.fal.media/c.fbx', { content_type: 'application/octet-stream' }) } }), false, 'a file of another format is no fallback');
  // SAM 3D: the splat is no model
  assert.equal(pick({ gaussian_splat: { url: 'https://x.fal.media/s.ply' }, metadata: [] }), null);
  assert.equal(falPure.modelProblem({ gaussian_splat: { url: 'https://x.fal.media/s.ply' }, metadata: [] }), 'splat_only');
  assert.equal(falPure.modelProblem({ metadata: [] }), 'none');
  assert.equal(falPure.modelProblem({ model_glb: file('https://x.fal.media/a.glb') }), null);
  // nothing is invented: an empty url is no file
  assert.equal(pick({ model_glb: { url: '   ' } }), null);
  assert.equal(pick(null), null);
  // the other kinds are as they were (auto does not look for a model)
  assert.equal(falPure.extractMedia({ model_glb: file('https://x.fal.media/a.glb') }, 'auto'), null);
  assert.equal(falPure.extractMedia({ image: { url: 'https://x.fal.media/i.png', content_type: 'image/png' } }, 'auto').kind, 'image');
}

function testVisibility() {
  const def = { params: [{ id: 'model', default: 'a' }, { id: 'texture', default: true }] };
  const node = (params) => ({ params });
  assert.equal(graphLib.isVisible({ param: 'model', in: ['a', 'b'] }, node({}), def, new Set()), true);
  assert.equal(graphLib.isVisible({ param: 'model', in: ['b', 'c'] }, node({}), def, new Set()), false);
  assert.equal(graphLib.isVisible({ param: 'model', in: ['b', 'c'] }, node({ model: 'c' }), def, new Set()), true);
  assert.equal(graphLib.isVisible({ all: [{ param: 'model', in: ['a'] }, { param: 'texture', equals: true }] }, node({ texture: false }), def, new Set()), false);
  assert.equal(graphLib.isVisible({ all: [{ param: 'model', in: ['a'] }, { param: 'texture', equals: true }] }, node({}), def, new Set()), true);
  assert.equal(graphLib.dependsOnParam({ param: 'model', in: ['a'] }), true);
  // `equals` and `empty` work as before
  assert.equal(graphLib.isVisible({ param: 'model', equals: 'a' }, node({}), def, new Set()), true);
}

function testTexts() {
  const vm = require('vm');
  const dictionaries = {};
  for (const lang of ['de', 'en', 'es']) {
    const storage = new Map([['vcd-lang', lang]]);
    const window = {
      document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
      navigator: { language: lang },
      localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window });
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
    dictionaries[lang] = window.I18N[lang];
  }
  // every code the server can report has a text in all three languages, without a sharp s
  const sources = ['lib/nodes/nodes-fal.js', 'lib/poller.js', 'lib/nodes/engine.js'].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const codes = new Set([...sources.matchAll(/'(MESH_[A-Z_]+)'/g)].map((match) => match[1]));
  codes.add('OUTPUT_EMPTY');
  assert.ok(codes.size >= 10, `the codes of the node: ${[...codes].join(', ')}`);
  for (const code of codes) {
    for (const lang of ['de', 'en', 'es']) {
      const text = dictionaries[lang][`nodes.issue.${code}`];
      assert.ok(text && text.trim(), `${lang}: nodes.issue.${code}`);
      assert.equal(text.includes('ß'), false, `${lang}: ${code}`);
    }
  }
  // the type, its ports, its options and the model strengths
  const keys = [
    'nodes.ptype.model3d',
    'nodes.type.fal.image_to_3d.label',
    'nodes.type.fal.image_to_3d.keywords',
    'nodes.type.fal.image_to_3d.help',
    'nodes.type.fal.image_to_3d.example',
    'nodes.type.fal.image_to_3d.tip.1',
    'nodes.port.left',
    'nodes.port.back',
    'nodes.port.right',
    'nodes.port.model',
    'nodes.port.preview',
    'nodes.param.texture',
    'nodes.param.pbr',
    'nodes.param.detail',
    'nodes.param.object',
    'nodes.param.face_count',
    'nodes.option.detailed',
    ...['allround', 'detail', 'clean', 'scene'].map((strength) => `nodes.model3d.strength.${strength}`),
    ...['image.in', 'left.in', 'back.in', 'right.in', 'model.out', 'preview.out'].map((port) => `nodes.portdesc.fal.image_to_3d.${port}`)
  ];
  for (const key of keys) {
    for (const lang of ['de', 'en', 'es']) assert.ok(dictionaries[lang][key] && dictionaries[lang][key].trim(), `${lang}: ${key}`);
  }
  assert.equal(dictionaries.de['nodes.type.fal.image_to_3d.label'], 'Bild zu 3D');
  // the preview exists for every model: the texts say who draws it, and the empty output is no longer SAM 3D's
  for (const lang of ['de', 'en', 'es']) {
    const previewOut = dictionaries[lang]['nodes.portdesc.fal.image_to_3d.preview.out'];
    for (const word of ['Tripo', 'Hunyuan', 'Meshy', 'SAM 3D', 'PNG']) assert.ok(previewOut.includes(word), `${lang}: preview.out names ${word}`);
    assert.equal(/SAM 3D (liefert|delivers|no entrega)/.test(previewOut), false, `${lang}: SAM 3D delivers no longer "no preview"`);
    assert.equal(dictionaries[lang]['nodes.issue.OUTPUT_EMPTY'].includes('SAM'), false, `${lang}: the empty output is not SAM 3D's example any more`);
    assert.ok(/3D/.test(dictionaries[lang]['nodes.issue.OUTPUT_EMPTY']), `${lang}: the example is the preview of a 3D model`);
    assert.ok(/Vorschau|preview|vista previa/i.test(dictionaries[lang]['nodes.type.fal.image_to_3d.help']), `${lang}: the help names the preview`);
  }
  // the search words of the order
  const words = dictionaries.de['nodes.type.fal.image_to_3d.keywords'].split(',').map((item) => item.trim());
  for (const word of ['3D', 'GLB', 'Mesh', 'Modell', 'Objekt', 'Figur', 'Produkt', 'Tripo', 'Hunyuan', 'Meshy', 'SAM']) assert.ok(words.includes(word), `keyword ${word}`);
  assert.ok(dictionaries.en['nodes.type.fal.image_to_3d.keywords'].includes('image to 3d'));
}

/* ---------- main ---------- */

async function main() {
  const guard = guardFetch();
  try {
    testPortType();
    testResultExtraction();
    testVisibility();
    testTexts();
    await testWithApp();
  } finally {
    restoreAll();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('test-nodes-image-to-3d.js: ok');
}

async function testWithApp() {
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    restoreAll();
    await iso.cleanup();
  }
}

async function run(iso) {
  const store = iso.load('lib/store');
  const fal = iso.load('lib/fal');
  const ffmpeg = iso.load('lib/ffmpeg');
  const ops = iso.load('lib/nodes/ffmpeg-ops');
  const poller = iso.load('lib/poller');
  const jobs = iso.load('lib/nodes/jobs');
  const assets = iso.load('lib/nodes/assets');
  const costs = iso.load('lib/costs');
  const nodesFal = iso.load('lib/nodes/nodes-fal');
  const registryModule = iso.load('lib/nodes/registry');
  const routesModule = iso.load('lib/nodes/routes');
  const budgetLib = iso.load('lib/budget');
  const registry = registryModule.registry;
  const api = (url, options = {}) => iso.request(url, options);

  /* ---------- the provider, replaced ---------- */

  let hasKey = true;
  const calls = { upload: [], submit: [], download: [], status: 0 };
  const requests = new Map(); // request id -> { endpoint, input }
  let counter = 0;
  // what each endpoint answers (a test overrides it for one case); every URL is a fal.media URL
  let scenario = null;
  const URLS = {
    glb: 'https://v3b.fal.media/files/out/model.glb',
    png: 'https://v3b.fal.media/files/out/preview.png',
    ply: 'https://v3b.fal.media/files/out/splat.ply',
    fbx: 'https://v3b.fal.media/files/out/model.fbx'
  };
  const glbFile = (url = URLS.glb) => ({ url, content_type: 'model/gltf-binary', file_name: path.basename(url), file_size: GLB.length });
  const pngFile = (url = URLS.png) => ({ url, content_type: 'image/png', file_name: path.basename(url) });
  const defaultResult = (endpoint) => {
    if (endpoint.startsWith('tripo3d/')) return { model_mesh: glbFile(), model_urls: { glb: glbFile() }, rendered_image: pngFile(), task_id: 'task-1' };
    if (endpoint.startsWith('fal-ai/hunyuan-3d/')) return { model_glb: glbFile(), model_urls: { glb: glbFile() }, thumbnail: pngFile(), seed: 42 };
    if (endpoint.startsWith('meshy/')) return { model_glb: glbFile(), model_urls: { glb: glbFile() }, thumbnail: pngFile(), seed: 7, texture_urls: [] };
    // SAM 3D: the mesh and the splat, no preview image
    return { model_glb: glbFile(), gaussian_splat: { url: URLS.ply, content_type: 'application/octet-stream' }, metadata: [{ scale: [1, 1, 1] }] };
  };
  let downloads = null; // url -> { bytes, contentType, error }
  patch(fal, 'hasKey', () => hasKey);
  patch(fal, 'uploadFile', async (file, options) => {
    calls.upload.push({ file: path.basename(file), contentType: options.contentType });
    return { url: `https://v3b.fal.media/files/${path.basename(file)}`, size: 4, contentType: options.contentType, fileName: options.fileName };
  });
  patch(fal, 'submit', async (endpoint, input) => {
    counter += 1;
    const requestId = `req-${counter}`;
    calls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)), requestId });
    requests.set(requestId, { endpoint, input });
    return { requestId, statusUrl: `https://queue.fal.run/${endpoint}/requests/${requestId}/status`, responseUrl: `https://queue.fal.run/${endpoint}/requests/${requestId}` };
  });
  patch(fal, 'getStatus', async () => {
    calls.status += 1;
    return { status: 'COMPLETED', queuePosition: null, error: null, errorType: null };
  });
  patch(fal, 'getResult', async (job) => {
    const request = requests.get(job.jobId);
    assert.ok(request, `a result for a job that was queued: ${job.jobId}`);
    return (scenario && scenario(request.endpoint, request.input)) || defaultResult(request.endpoint);
  });
  patch(fal, 'downloadToFile', async (url, dest, options = {}) => {
    calls.download.push({ url, maxBytes: options.maxBytes });
    const rule = downloads && downloads[url];
    if (rule && rule.error) throw rule.error;
    let bytes = rule && rule.bytes;
    if (!bytes) bytes = url.endsWith('.glb') ? GLB : url.endsWith('.png') ? PNG : Buffer.from(`file ${url}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, bytes);
    return { bytes: bytes.length, contentType: (rule && rule.contentType) || 'application/octet-stream' };
  });
  const journal = [];
  const recordCost = costs.recordCost;
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return recordCost.call(costs, entry); // the journal of the private copy: the budget of a participant is read from it
  });
  const resetCalls = () => {
    calls.upload.length = 0;
    calls.submit.length = 0;
    calls.download.length = 0;
    journal.length = 0;
    scenario = null;
    downloads = null;
  };
  const nothingSent = (message) => assert.deepEqual([calls.upload.length, calls.submit.length], [0, 0], message || 'nothing uploaded, nothing queued');

  // ffprobe: the size of each picture comes from this table (by file name)
  const probes = new Map();
  patch(ffmpeg, 'binaries', () => ({ available: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }));
  patch(ops, 'probeMedia', async (file) => {
    const probe = probes.get(path.basename(file));
    if (!probe) throw new Error('unreadable file');
    return probe;
  });

  const session = await store.createSession();
  const sessionId = session.id;
  let assetCounter = 0;
  async function picture(ext = '.png', { width = 1024, height = 1024, size, bytes, owner = sessionId } = {}) {
    assetCounter += 1;
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes || (ext === '.png' ? PNG : Buffer.from(`pixels${assetCounter}${ext}`)), ext, prompt: 'seed' });
    if (size) {
      const handle = await fsp.open(path.join(store.sessionAssetDir(owner), saved.file), 'w');
      await handle.truncate(size);
      await handle.close();
    }
    probes.set(saved.file, { video: { codec: 'png', width, height, fps: 1 }, audio: null, duration: null });
    return assets.valueFromAsset(owner, saved.id);
  }

  const def = () => {
    const found = registry.get('fal.image_to_3d');
    assert.ok(found, 'fal.image_to_3d is registered');
    return found;
  };
  const params = (raw = {}) => registry.normalizeParams(def(), raw);
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
      // like the engine: the poller finishes the job, then the ids of the results come from the session
      waitForJob: async (job) => {
        const started = Date.now();
        for (;;) {
          await poller.pollOnce();
          const current = await store.readSession(sessionId);
          const record = current.jobs.find((entry) => entry.assetId === job.assetId);
          if (record && ['completed', 'failed'].includes(record.status)) break;
          if (Date.now() - started > 8000) throw new Error('the job did not finish');
        }
        return jobs.waitForSessionJob(sessionId, job.jobId, { assetId: job.assetId, signal: controller.signal, intervalMs: 20, timeoutMs: 8000 });
      }
    };
  };
  const plan = (inputs, raw) => nodesFal.planImageTo3d(ctx(), inputs, params(raw));
  const execute = (inputs, raw) => def().execute(ctx(), inputs, params(raw));
  const list = (value) => (value ? typesLib.listValue('image', [value]) : undefined);
  // the inputs of the node as the engine hands them over: the optional views are lists
  const inputsOf = (image, views = {}) => {
    const inputs = { image };
    for (const [id, value] of Object.entries(views)) if (value) inputs[id] = list(value);
    return inputs;
  };
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  };
  const refused = async (inputs, raw, code, pattern) => {
    resetCalls();
    const err = await errorOf(execute(inputs, raw));
    assert.ok(err, `refused with ${code}`);
    assert.equal(err.code, code, `${code}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    nothingSent(code);
    return err;
  };

  const front = await picture('.png');
  const left = await picture('.png');
  const back = await picture('.jpg');
  const right = await picture('.jpeg');

  /* ---------- registry ---------- */
  {
    const node = def();
    assert.equal(node.category, 'fal');
    assert.equal(node.paid, true);
    assert.equal(node.async, true);
    assert.ok(!node.experimental, 'all four models ran live on 2026-10-03: no badge (the other fal nodes keep it; SAM 3D is marked in the model list)');
    assert.equal(node.emptyOutputs, undefined, 'the preview of every model exists, no output is announced as empty');
    assert.equal(node.label, 'Image to 3D');
    assert.deepEqual(node.inputs.map((port) => `${port.id}:${port.type}${port.required ? '!' : ''}${port.multiple ? `[max ${port.max}]` : ''}`), ['image:image!', 'left:image[max 1]', 'back:image[max 1]', 'right:image[max 1]']);
    assert.deepEqual(node.inputs.filter((port) => port.limitBy).map((port) => [port.id, port.limitBy]), [['left', { param: 'model', capability: 'left' }], ['back', { param: 'model', capability: 'back' }], ['right', { param: 'model', capability: 'right' }]]);
    assert.deepEqual(node.outputs.map((port) => `${port.id}:${port.type}`), ['model:model3d', 'preview:image']);
    assert.deepEqual(node.params.map((param) => param.id), ['model', 'object', 'texture', 'pbr', 'detail', 'face_count', 'seed']);
    const param = (id) => node.params.find((item) => item.id === id);
    assert.equal(param('model').optionsSource, 'image-to-3d-models');
    assert.equal(param('model').default, 'tripo_h31', 'Tripo first');
    assert.deepEqual(param('object').showIf, { param: 'model', equals: 'sam3d_objects' });
    assert.equal(param('texture').default, true);
    assert.equal(param('pbr').default, false);
    assert.deepEqual(param('pbr').showIf, { all: [{ param: 'model', in: ['tripo_h31', 'hunyuan_pro31', 'meshy_71'] }, { param: 'texture', equals: true }] });
    assert.deepEqual(param('detail').options, ['standard', 'detailed']);
    assert.deepEqual(param('detail').showIf, { param: 'model', equals: 'tripo_h31' });
    assert.deepEqual(param('face_count').showIf, { param: 'model', in: ['tripo_h31', 'hunyuan_pro31', 'meshy_71'] });
    assert.equal(param('face_count').default, null, 'empty: the model decides (and nothing is charged extra)');
    assert.deepEqual(param('seed').showIf, { param: 'model', in: ['tripo_h31', 'sam3d_objects'] }, 'Hunyuan and Meshy take no seed');
    // no option that leads to another format than GLB, no rigging, no animation
    assert.equal(node.params.some((item) => /quad|topology|rig|anim|format/i.test(item.id)), false);
    assert.equal(node.cost.unit, 'usd');
    assert.equal(node.cost.history, false, 'the price follows the options: never guessed from the last result');
    const descriptor = JSON.parse(JSON.stringify(registry.publicDescriptor(node)));
    assert.equal(descriptor.provider, 'fal');
    assert.equal(descriptor.cost.hasEstimate, true);
    // before the free node, which stays last
    assert.deepEqual(nodesFal.definitions.map((item) => item.type).slice(-5), ['fal.image_to_3d', 'fal.remove_background', 'fal.video_segment', 'fal.video_edit', 'fal.model']);
    // open to participants like the background removal: no Higgsfield node, no credits
    assert.equal(registryModule.isRestricted(descriptor), false);
    hasKey = false;
    assert.match(String(registry.availability(node)), /FAL_KEY/);
    hasKey = true;
    assert.equal(registry.availability(node), true);
    // ports follow the model (limits for the views)
    const portsOf = (model) => registry.portsFor(node, params({ model })).inputs;
    for (const model of ['tripo_h31', 'hunyuan_pro31', 'meshy_71']) {
      for (const id of ['left', 'back', 'right']) assert.deepEqual(portsOf(model).find((port) => port.id === id).limit, { known: true, max: 1, roles: [], required: false, subject: nodesFal.IMAGE3D_MODELS[model].name }, `${model} ${id}`);
    }
    for (const id of ['left', 'back', 'right']) {
      const port = portsOf('sam3d_objects').find((item) => item.id === id);
      assert.equal(port.max, 0, `SAM 3D takes no ${id} view`);
      assert.equal(port.limit.max, 0);
    }
    assert.deepEqual(portsOf('image').find((port) => port.id === 'left').limit, { known: false }, 'an unknown model: the fixed maximum is the only limit');
  }

  /* ---------- prices ---------- */
  {
    const price = nodesFal.PRICES.image3d;
    assert.equal(price.fetched, '2026-10-02');
    assert.ok(Object.isFrozen(price) && Object.isFrozen(price.tripo) && Object.isFrozen(price.hunyuan) && Object.isFrozen(price.meshy) && Object.isFrozen(price.sam3d));
    assert.deepEqual({ ...price.tripo }, { endpoint: 'tripo3d/h3.1/image-to-3d', multiviewEndpoint: 'tripo3d/h3.1/multiview-to-3d', noTexture: 0.2, texture: 0.3, hdTexture: 0.4, detailedGeometry: 0.2, quad: 0.05 });
    assert.deepEqual({ ...price.hunyuan }, { endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', base: 0.375, pbr: 0.15, extraViews: 0.15, ownFaceCount: 0.15 });
    assert.deepEqual({ ...price.meshy }, { endpoint: 'meshy/v7.1/multi-image-to-3d', noTexture: 0.8, texture: 1.2, rigging: 0.2, animation: 0.12 });
    assert.deepEqual({ ...price.sam3d }, { endpoint: 'fal-ai/sam-3/3d-objects', perUnit: 0.02 });
    // the source and the date are in the code next to the numbers
    const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'nodes-fal.js'), 'utf8');
    assert.match(source, /llms\.txt[\s\S]{0,300}2026-10-02|2026-10-02[\s\S]{0,400}llms\.txt/);
    assert.match(source, /billed 1\.00 unit = 0\.02 USD/, 'the unit of the SAM 3D price is confirmed by a billed run');

    const estimate = (raw, views = []) => def().cost.estimate(params(raw), { connected: new Set(views) });
    // Tripo: 0.20 / 0.30 / 0.40, geometry detailed +0.20, PBR and face limit cost nothing extra
    near(estimate({}), 0.3);
    near(estimate({ texture: false }), 0.2);
    near(estimate({ pbr: true }), 0.3);
    near(estimate({ detail: 'detailed' }), 0.6, 'HD texture 0.40 + detailed geometry 0.20');
    near(estimate({ detail: 'detailed', texture: false }), 0.4, 'no texture 0.20 + detailed geometry 0.20');
    near(estimate({ face_count: 20000 }), 0.3);
    near(estimate({}, ['left', 'back']), 0.3, 'views cost nothing extra');
    // Hunyuan: 0.375, PBR +0.15, views +0.15 (once), an own face count +0.15
    near(estimate({ model: 'hunyuan_pro31' }, []), 0.375);
    near(estimate({ model: 'hunyuan_pro31', pbr: true }, []), 0.525);
    near(estimate({ model: 'hunyuan_pro31', pbr: true, texture: false }, []), 0.375, 'PBR needs the texture');
    near(estimate({ model: 'hunyuan_pro31' }, ['left']), 0.525);
    near(estimate({ model: 'hunyuan_pro31' }, ['left', 'back', 'right']), 0.525, 'one surcharge however many views');
    near(estimate({ model: 'hunyuan_pro31', face_count: 100000 }, []), 0.525);
    near(estimate({ model: 'hunyuan_pro31', pbr: true, face_count: 100000 }, ['back']), 0.825);
    assert.equal(def().cost.estimate(params({ model: 'hunyuan_pro31' })), null, 'Hunyuan without knowing the views: unknown, never a smaller price');
    assert.equal(def().cost.estimate(params({ model: 'hunyuan_pro31' }), {}), null);
    // Meshy: 0.80 without, 1.20 with a texture; PBR, polygon count and views are free
    near(estimate({ model: 'meshy_71' }), 1.2);
    near(estimate({ model: 'meshy_71', texture: false }), 0.8);
    near(estimate({ model: 'meshy_71', pbr: true, face_count: 20000 }, ['left']), 1.2);
    // SAM 3D: 0.02 per unit, one object assumed
    near(estimate({ model: 'sam3d_objects', object: 'chair' }), 0.02);
    near(estimate({ model: 'sam3d_objects', texture: false }), 0.02);
    // unknown is null, never 0
    assert.equal(estimate({ model: 'nope' }), null);
    // the plan's number without a context for the models that do not need one
    near(def().cost.estimate(params({})), 0.3);
  }

  /* ---------- the model list of the page ---------- */
  {
    const response = await api('/api/nodes/options/image-to-3d-models', { as: ADMIN });
    assert.equal(response.status, 200, response.text);
    const options = response.body.options;
    assert.deepEqual(options.map((item) => item.value), ['tripo_h31', 'hunyuan_pro31', 'meshy_71', 'sam3d_objects']);
    assert.deepEqual(options.map((item) => item.label), ['Tripo H3.1', 'Hunyuan 3D Pro 3.1', 'Meshy 7.1', 'SAM 3D Objects']);
    assert.deepEqual(options.map((item) => item.fromUsd), [0.3, 0.375, 1.2, 0.02], 'the price with the default options');
    assert.deepEqual(options.map((item) => item.minUsd), [0.2, 0.375, 0.8, 0.02]);
    assert.deepEqual(options.map((item) => item.strength), ['allround', 'detail', 'clean', 'scene']);
    assert.deepEqual(options.map((item) => item.views), [3, 3, 3, 0]);
    for (const option of options) {
      for (const view of ['left', 'back', 'right']) assert.deepEqual(option[view], { max: option.value === 'sam3d_objects' ? 0 : 1 }, `${option.value} ${view}`);
    }
    assert.deepEqual(options.map((item) => item.experimental === true), [false, false, false, true], 'only SAM 3D is experimental');
    for (const option of options) assert.ok(option.fromUsd > 0, 'a price is never 0');
    // the same list for a participant
    await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 1 } });
  }

  /* ---------- the request per model ---------- */
  {
    resetCalls();
    // Tripo, one image
    let made = await plan(inputsOf(front));
    assert.equal(made.endpoint, 'tripo3d/h3.1/image-to-3d');
    assert.deepEqual(made.input, { texture: true, pbr: false, texture_quality: 'standard', geometry_quality: 'standard', quad: false });
    assert.deepEqual(made.media, [{ field: 'image_url', assetIds: [front.assetId], multiple: false }]);
    assert.equal(made.kind, 'model3d');
    near(made.estimateUsd, 0.3);
    assert.equal(made.pricing, null, 'a flat price per generation');
    nothingSent('planning sends nothing');
    // everything that costs is sent explicitly: also texture and pbr when they are off (the endpoint defaults are ON)
    made = await plan(inputsOf(front), { texture: false, pbr: true });
    assert.deepEqual(made.input, { texture: false, pbr: false, texture_quality: 'standard', geometry_quality: 'standard', quad: false }, 'no texture means no PBR');
    near(made.estimateUsd, 0.2);
    made = await plan(inputsOf(front), { pbr: true });
    assert.equal(made.input.pbr, true);
    made = await plan(inputsOf(front), { detail: 'detailed' });
    assert.deepEqual(made.input, { texture: true, pbr: false, texture_quality: 'detailed', geometry_quality: 'detailed', quad: false });
    near(made.estimateUsd, 0.6);
    made = await plan(inputsOf(front), { detail: 'detailed', texture: false });
    assert.equal(made.input.texture_quality, 'standard', 'no HD texture without a texture');
    assert.equal(made.input.geometry_quality, 'detailed');
    near(made.estimateUsd, 0.4);
    made = await plan(inputsOf(front), { face_count: 50000, seed: 11 });
    assert.equal(made.input.face_limit, 50000);
    assert.equal(made.input.model_seed, 11);
    assert.equal(made.input.texture_seed, 11);
    assert.equal(made.input.quad, false, 'quad never: it can return an FBX');
    made = await plan(inputsOf(front));
    assert.equal('face_limit' in made.input || 'model_seed' in made.input, false, 'nothing the person did not choose');
    // Tripo with views: the multiview endpoint, [front, left, back, right] without a gap
    made = await plan(inputsOf(front, { left }));
    assert.equal(made.endpoint, 'tripo3d/h3.1/multiview-to-3d');
    assert.deepEqual(made.media, [{ field: 'image_urls', assetIds: [front.assetId, left.assetId], multiple: true }]);
    assert.equal('image_url' in made.input, false);
    made = await plan(inputsOf(front, { left, back, right }));
    assert.deepEqual(made.media, [{ field: 'image_urls', assetIds: [front.assetId, left.assetId, back.assetId, right.assetId], multiple: true }]);
    near(made.estimateUsd, 0.3);
    // Hunyuan: Normal / Geometry, PBR, face_count only when the person set one, the views by name
    made = await plan(inputsOf(front), { model: 'hunyuan_pro31' });
    assert.equal(made.endpoint, 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d');
    assert.deepEqual(made.input, { generate_type: 'Normal', enable_pbr: false });
    assert.deepEqual(made.media, [{ field: 'input_image_url', assetIds: [front.assetId], multiple: false }]);
    near(made.estimateUsd, 0.375);
    made = await plan(inputsOf(front), { model: 'hunyuan_pro31', texture: false, pbr: true });
    assert.deepEqual(made.input, { generate_type: 'Geometry', enable_pbr: false });
    made = await plan(inputsOf(front, { left, back }), { model: 'hunyuan_pro31', pbr: true, face_count: 100000, seed: 5 });
    assert.deepEqual(made.input, { generate_type: 'Normal', enable_pbr: true, face_count: 100000 }, 'Hunyuan takes no seed');
    assert.deepEqual(made.media, [
      { field: 'input_image_url', assetIds: [front.assetId], multiple: false },
      { field: 'left_image_url', assetIds: [left.assetId], multiple: false },
      { field: 'back_image_url', assetIds: [back.assetId], multiple: false }
    ]);
    near(made.estimateUsd, 0.375 + 0.15 + 0.15 + 0.15);
    made = await plan(inputsOf(front, { right }), { model: 'hunyuan_pro31' });
    assert.deepEqual(made.media.map((entry) => entry.field), ['input_image_url', 'right_image_url'], 'no gap rule for Hunyuan');
    near(made.estimateUsd, 0.525);
    // Meshy: 1 to 4 images in one list, texture, PBR, rigging and animation switched off, polycount only when chosen
    made = await plan(inputsOf(front), { model: 'meshy_71' });
    assert.equal(made.endpoint, 'meshy/v7.1/multi-image-to-3d');
    assert.deepEqual(made.input, { should_texture: true, enable_pbr: false, enable_rigging: false, enable_animation: false });
    assert.deepEqual(made.media, [{ field: 'image_urls', assetIds: [front.assetId], multiple: true }]);
    near(made.estimateUsd, 1.2);
    made = await plan(inputsOf(front, { back, right }), { model: 'meshy_71', pbr: true, face_count: 20000, seed: 3 });
    assert.deepEqual(made.input, { should_texture: true, enable_pbr: true, enable_rigging: false, enable_animation: false, target_polycount: 20000 });
    assert.deepEqual(made.media, [{ field: 'image_urls', assetIds: [front.assetId, back.assetId, right.assetId], multiple: true }], 'no gap rule for Meshy');
    made = await plan(inputsOf(front), { model: 'meshy_71', texture: false, pbr: true });
    assert.deepEqual(made.input, { should_texture: false, enable_pbr: false, enable_rigging: false, enable_animation: false });
    near(made.estimateUsd, 0.8);
    // SAM 3D: the object is always sent (the endpoint's own default is "car")
    made = await plan(inputsOf(front), { model: 'sam3d_objects', object: '  chair ' });
    assert.equal(made.endpoint, 'fal-ai/sam-3/3d-objects');
    assert.deepEqual(made.input, { prompt: 'chair', export_textured_glb: true });
    assert.deepEqual(made.media, [{ field: 'image_url', assetIds: [front.assetId], multiple: false }]);
    near(made.estimateUsd, 0.02);
    made = await plan(inputsOf(front), { model: 'sam3d_objects', object: 'lamp', texture: false, seed: 9, face_count: 5000 });
    assert.deepEqual(made.input, { prompt: 'lamp', export_textured_glb: false, seed: 9 });
    nothingSent('planning sends nothing');
  }

  /* ---------- checks before anything is sent ---------- */
  {
    resetCalls();
    await assert.rejects(execute({}, {}), /image: connect the front view/);
    nothingSent();
    // SAM 3D: the object is needed, and no additional view
    await refused(inputsOf(front), { model: 'sam3d_objects' }, 'MESH_OBJECT_REQUIRED', /object/);
    await refused(inputsOf(front), { model: 'sam3d_objects', object: '   ' }, 'MESH_OBJECT_REQUIRED');
    const viewError = await refused(inputsOf(front, { left }), { model: 'sam3d_objects', object: 'chair' }, 'MESH_VIEW_UNSUPPORTED');
    assert.deepEqual(viewError.data, { model: 'SAM 3D Objects' });
    await refused(inputsOf(front, { right }), { model: 'sam3d_objects', object: 'chair' }, 'MESH_VIEW_UNSUPPORTED');
    // Tripo: the views in the order left, back, right without a gap
    const gap = await refused(inputsOf(front, { back }), {}, 'MESH_VIEW_GAP', /connect left first/);
    assert.deepEqual(gap.data, { model: 'Tripo H3.1' });
    await refused(inputsOf(front, { right }), {}, 'MESH_VIEW_GAP', /connect left first/);
    await refused(inputsOf(front, { left, right }), {}, 'MESH_VIEW_GAP', /connect back first/);
    // ... while Hunyuan and Meshy take any views
    resetCalls();
    await plan(inputsOf(front, { right }), { model: 'hunyuan_pro31' });
    await plan(inputsOf(front, { right }), { model: 'meshy_71' });
    // the range of the face count differs per model
    const faces = await refused(inputsOf(front), { model: 'hunyuan_pro31', face_count: 1000 }, 'MESH_FACES_RANGE');
    assert.deepEqual(faces.data, { model: 'Hunyuan 3D Pro 3.1', min: 40000, max: 1500000 });
    await refused(inputsOf(front), { model: 'hunyuan_pro31', face_count: 2000000 }, 'MESH_FACES_RANGE');
    await refused(inputsOf(front), { model: 'meshy_71', face_count: 400000 }, 'MESH_FACES_RANGE');
    await refused(inputsOf(front), { face_count: 500 }, 'MESH_FACES_RANGE');
    resetCalls();
    await plan(inputsOf(front), { model: 'meshy_71', face_count: 100 });
    await plan(inputsOf(front), { face_count: 2000000 });
    // an unknown model
    resetCalls();
    await assert.rejects(execute(inputsOf(front), { model: 'nope' }), /model: "nope" is not a valid option/);
    nothingSent();
    // the images: format, size, pixels
    const gif = await picture('.gif');
    const webp = await picture('.webp');
    for (const model of ['tripo_h31', 'hunyuan_pro31', 'meshy_71', 'sam3d_objects']) {
      await refused(inputsOf(gif), { model, object: 'chair' }, 'MESH_IMAGE_FORMAT', /image: .* takes .* images \(got \.gif\)/);
    }
    const meshyWebp = await refused(inputsOf(webp), { model: 'meshy_71' }, 'MESH_IMAGE_FORMAT', /PNG, JPEG images/);
    assert.deepEqual(meshyWebp.data, { model: 'Meshy 7.1', formats: 'PNG, JPEG' });
    resetCalls();
    await plan(inputsOf(webp), {});
    await plan(inputsOf(webp), { model: 'hunyuan_pro31' });
    const big = await picture('.png', { size: 9 * MB });
    const bigError = await refused(inputsOf(big), { model: 'hunyuan_pro31' }, 'MESH_IMAGE_SIZE');
    assert.deepEqual(bigError.data, { model: 'Hunyuan 3D Pro 3.1', max: 8 });
    resetCalls();
    await plan(inputsOf(big), { model: 'meshy_71' });
    await plan(inputsOf(big), {});
    const huge = await picture('.png', { size: 21 * MB });
    await refused(inputsOf(huge), { model: 'meshy_71' }, 'MESH_IMAGE_SIZE');
    const tiny = await picture('.png', { width: 100, height: 400 });
    const pixels = await refused(inputsOf(tiny), { model: 'hunyuan_pro31' }, 'MESH_IMAGE_PIXELS');
    assert.deepEqual(pixels.data, { model: 'Hunyuan 3D Pro 3.1', min: 128, max: 5000, width: 100, height: 400 });
    const wide = await picture('.png', { width: 6000, height: 1000 });
    await refused(inputsOf(wide), { model: 'hunyuan_pro31' }, 'MESH_IMAGE_PIXELS');
    resetCalls();
    await plan(inputsOf(tiny), {});
    // a view is checked like the front image
    const badView = await refused(inputsOf(front, { left: gif }), { model: 'hunyuan_pro31' }, 'MESH_IMAGE_FORMAT', /left: /);
    assert.ok(badView.data);
    // another session, a file that is gone, no key
    resetCalls();
    const other = await store.createSession();
    const foreign = await picture('.png', { owner: other.id });
    await assert.rejects(execute(inputsOf(foreign)), /another session/);
    nothingSent();
    const gone = await picture('.png');
    await fsp.rm(path.join(store.sessionAssetDir(sessionId), gone.file));
    await assert.rejects(execute(inputsOf(gone)), /image: the file is missing/);
    nothingSent();
    hasKey = false;
    await assert.rejects(execute(inputsOf(front)), /FAL_KEY/);
    nothingSent();
    hasKey = true;
    const aborted = ctx();
    aborted.controller.abort();
    await assert.rejects(def().execute(aborted, inputsOf(front), params({})), { name: 'AbortError' });
    nothingSent('an aborted run does not start a paid job');
    await store.deleteSession(other.id).catch(() => {});
    // two images at one view are no view
    await assert.rejects(execute({ image: front, left: typesLib.listValue('image', [left, back]) }), /left: at most 1 are allowed/);
    nothingSent();
    // the validation before a run reports the same, with the port named
    const validate = (raw, counts) => def().validate(params(raw), Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, { connected: count > 0, count }])));
    assert.deepEqual(validate({}, { left: 1 }), []);
    assert.deepEqual(validate({}, { back: 1 }).map((issue) => [issue.code, issue.port]), [['MESH_VIEW_GAP', 'left']]);
    assert.deepEqual(validate({}, { right: 1, left: 1 }).map((issue) => [issue.code, issue.port]), [['MESH_VIEW_GAP', 'back']]);
    assert.deepEqual(validate({ model: 'sam3d_objects', object: 'x' }, { left: 1, back: 1 }).map((issue) => [issue.code, issue.port]), [['MESH_VIEW_UNSUPPORTED', 'left'], ['MESH_VIEW_UNSUPPORTED', 'back']]);
    assert.deepEqual(validate({ model: 'sam3d_objects' }, {}).map((issue) => issue.code), ['MESH_OBJECT_REQUIRED']);
    assert.deepEqual(validate({ model: 'meshy_71', face_count: 400000 }, {}).map((issue) => issue.code), ['MESH_FACES_RANGE']);
    assert.deepEqual(validate({ model: 'hunyuan_pro31' }, { left: 1, right: 1 }), []);
  }

  /* ---------- a run per model: the GLB and its preview are stored ---------- */
  // the preview the app draws from the GLB (lib/glb-preview.js): a PNG of 1024 x 1024, transparent around the orange cube, not
  // the image of a provider
  async function assertDrawnPreview(bytes) {
    assert.ok(!bytes.equals(PNG), 'drawn by the app, not the image of a provider');
    const drawn = glbPreview.decodePng(bytes);
    assert.ok(drawn, 'a PNG');
    assert.deepEqual([drawn.width, drawn.height], [1024, 1024]);
    assert.equal(drawn.data[3], 0, 'transparent in the corner');
    const middle = (512 * 1024 + 512) * 4;
    assert.equal(drawn.data[middle + 3], 255, 'the cube in the middle');
    assert.ok(drawn.data[middle] > drawn.data[middle + 1] + 30 && drawn.data[middle + 1] > drawn.data[middle + 2] + 10, `the orange of the cube: ${[...drawn.data.subarray(middle, middle + 3)]}`);
  }
  async function checkStored(outcome, { preview, estimate, endpoint }) {
    const modelValue = outcome.variants[0].model;
    assert.equal(modelValue.type, 'model3d');
    assert.equal(modelValue.sessionId, sessionId);
    assert.match(modelValue.url, new RegExp(`^/assets/${sessionId}/mod-\\d{3}\\.glb$`));
    const stored = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), modelValue.file));
    assert.ok(stored.equals(GLB), 'the GLB is stored unchanged');
    const glb = readGlb(stored);
    assert.equal(glb.version, 2);
    assert.equal(glb.json.meshes.length, 1, 'a real model');
    const entry = (await store.readLedger(sessionId)).find((item) => item.id === modelValue.assetId);
    assert.equal(entry.kind, 'model3d');
    near(entry.cost, estimate, 'the cost of the model');
    assert.equal(entry.costEstimated, true, 'the card says "about"');
    const job = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === modelValue.assetId);
    assert.equal(job.resultKind, 'model3d');
    assert.equal(job.kind, 'model3d');
    assert.equal(job.endpoint, endpoint);
    assert.equal(job.status, 'completed');
    near(job.costEstimateUsd, estimate);
    assert.deepEqual(outcome.cost, { usd: estimate }, 'the cost is the model alone (the preview adds none)');
    assert.equal(journal.length, 1);
    near(journal[0].cost, estimate);
    assert.equal(journal[0].model, endpoint);
    if (preview) {
      const image = outcome.variants[0].preview;
      assert.equal(image.type, 'image');
      assert.match(image.url, new RegExp(`^/assets/${sessionId}/img-\\d{3}\\.png$`));
      const stored = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), image.file));
      if (preview === 'rendered') await assertDrawnPreview(stored);
      else assert.ok(stored.equals(PNG), 'the preview of the provider is stored unchanged');
      assert.deepEqual(job.resultAssetIds, [modelValue.assetId, image.assetId]);
      const imageEntry = (await store.readLedger(sessionId)).find((item) => item.id === image.assetId);
      assert.equal(imageEntry.kind, 'image');
      assert.ok(imageEntry.cost === null || imageEntry.cost === undefined, 'no cost twice');
      assert.equal(imageEntry.prompt, job.prompt, 'the image belongs to the same request as the model');
    } else {
      assert.equal('preview' in outcome.variants[0], false, 'no preview: no value');
      assert.deepEqual(job.resultAssetIds, [modelValue.assetId]);
    }
    return modelValue;
  }

  let tripoModel = null;
  {
    resetCalls();
    const outcome = await execute(inputsOf(front));
    assert.equal(calls.upload.length, 1);
    assert.deepEqual(calls.upload[0], { file: front.file, contentType: 'image/png' });
    assert.equal(calls.submit.length, 1);
    assert.equal(calls.submit[0].endpoint, 'tripo3d/h3.1/image-to-3d');
    assert.deepEqual(calls.submit[0].input, { texture: true, pbr: false, texture_quality: 'standard', geometry_quality: 'standard', quad: false, image_url: `https://v3b.fal.media/files/${front.file}` });
    // the GLB with the limit of its own, then the preview with a small one
    assert.deepEqual(calls.download, [{ url: URLS.glb, maxBytes: 256 * MB }, { url: URLS.png, maxBytes: 20 * MB }]);
    tripoModel = await checkStored(outcome, { preview: true, estimate: 0.3, endpoint: 'tripo3d/h3.1/image-to-3d' });

    // the views go up in the order front, left, back, right
    resetCalls();
    const multi = await execute(inputsOf(front, { left, back, right }), { pbr: true, detail: 'detailed' });
    assert.equal(calls.upload.length, 4);
    assert.equal(calls.submit[0].endpoint, 'tripo3d/h3.1/multiview-to-3d');
    assert.deepEqual(calls.submit[0].input.image_urls, [front, left, back, right].map((value) => `https://v3b.fal.media/files/${value.file}`));
    assert.equal(calls.submit[0].input.pbr, true);
    assert.equal(calls.submit[0].input.geometry_quality, 'detailed');
    await checkStored(multi, { preview: true, estimate: 0.6, endpoint: 'tripo3d/h3.1/multiview-to-3d' });

    // Hunyuan: model_glb and thumbnail
    resetCalls();
    const hunyuan = await execute(inputsOf(front, { left }), { model: 'hunyuan_pro31', pbr: true });
    assert.equal(calls.submit[0].endpoint, 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d');
    assert.deepEqual(calls.submit[0].input, {
      generate_type: 'Normal',
      enable_pbr: true,
      input_image_url: `https://v3b.fal.media/files/${front.file}`,
      left_image_url: `https://v3b.fal.media/files/${left.file}`
    });
    await checkStored(hunyuan, { preview: true, estimate: 0.675, endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d' });
    const hunyuanJob = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === hunyuan.variants[0].model.assetId);
    assert.equal(hunyuanJob.seed, 42, 'the seed of the result is remembered');

    // Meshy
    resetCalls();
    const meshy = await execute(inputsOf(front, { back }), { model: 'meshy_71' });
    assert.equal(calls.submit[0].endpoint, 'meshy/v7.1/multi-image-to-3d');
    assert.deepEqual(calls.submit[0].input.image_urls, [front, back].map((value) => `https://v3b.fal.media/files/${value.file}`));
    assert.deepEqual([calls.submit[0].input.enable_rigging, calls.submit[0].input.enable_animation], [false, false]);
    await checkStored(meshy, { preview: true, estimate: 1.2, endpoint: 'meshy/v7.1/multi-image-to-3d' });

    // SAM 3D: the mesh and no preview of the provider: the app draws it from the GLB (poller, child process); the splat is not even downloaded
    resetCalls();
    const sam = await execute(inputsOf(front), { model: 'sam3d_objects', object: 'chair' });
    assert.equal(calls.submit[0].endpoint, 'fal-ai/sam-3/3d-objects');
    assert.deepEqual(calls.submit[0].input, { prompt: 'chair', export_textured_glb: true, image_url: `https://v3b.fal.media/files/${front.file}` });
    assert.deepEqual(calls.download, [{ url: URLS.glb, maxBytes: 256 * MB }], 'only the GLB');
    await checkStored(sam, { preview: 'rendered', estimate: 0.02, endpoint: 'fal-ai/sam-3/3d-objects' });
    const files = await fsp.readdir(store.sessionAssetDir(sessionId));
    assert.equal(files.some((name) => /\.(ply|splat|fbx|part)$/.test(name)), false, 'no splat and no leftover');

    // the GLB comes with model_urls.glb only
    resetCalls();
    scenario = () => ({ model_mesh: glbFile('https://v3b.fal.media/files/out/model.fbx'), model_urls: { glb: glbFile() } });
    const viaUrls = await execute(inputsOf(front));
    assert.equal(calls.download[0].url, URLS.glb, 'the FBX of model_mesh is not taken');
    assert.equal(calls.download.length, 1, 'no image of the provider in the result, nothing more to download');
    await assertDrawnPreview(await fsp.readFile(path.join(store.sessionAssetDir(sessionId), viaUrls.variants[0].preview.file)));

    // the preview of the provider cannot be fetched or is no image: the model is the result that was paid for, and the preview
    // that the app draws from it steps in
    resetCalls();
    downloads = { [URLS.png]: { error: new Error('preview gone') } };
    const noPreview = await execute(inputsOf(front));
    assert.equal(noPreview.variants[0].model.type, 'model3d');
    assert.deepEqual(calls.download.map((call) => call.url), [URLS.glb, URLS.png], 'the image of the provider was asked for first');
    await assertDrawnPreview(await fsp.readFile(path.join(store.sessionAssetDir(sessionId), noPreview.variants[0].preview.file)));
    const noPreviewJob = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === noPreview.variants[0].model.assetId);
    assert.deepEqual(noPreviewJob.resultAssetIds, [noPreview.variants[0].model.assetId, noPreview.variants[0].preview.assetId]);
    assert.equal(noPreviewJob.status, 'completed');
    resetCalls();
    downloads = { [URLS.png]: { bytes: Buffer.from('<html>not an image</html>') } };
    const htmlPreview = await execute(inputsOf(front));
    await assertDrawnPreview(await fsp.readFile(path.join(store.sessionAssetDir(sessionId), htmlPreview.variants[0].preview.file)));
    assert.equal((await fsp.readdir(store.sessionAssetDir(sessionId))).some((name) => name.endsWith('.part')), false);

    // the app cannot draw the model either (it requires a decoder): the model alone is the result, and the job is done. Nothing
    // fails: the model is what was paid for. The reason is in the log.
    resetCalls();
    const needsDecoder = cubeGlb({ edit: (json) => { json.extensionsRequired = ['KHR_draco_mesh_compression']; } });
    downloads = { [URLS.png]: { error: new Error('preview gone') }, [URLS.glb]: { bytes: needsDecoder } };
    const warned = [];
    const imagesBefore = (await store.readLedger(sessionId)).filter((entry) => entry.kind === 'image').length;
    const originalWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    let modelOnly;
    try {
      modelOnly = await execute(inputsOf(front));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(modelOnly.variants[0].model.type, 'model3d');
    assert.equal('preview' in modelOnly.variants[0], false, 'no preview: no value');
    assert.deepEqual(modelOnly.cost, { usd: 0.3 }, 'the model is paid as always');
    const modelOnlyJob = (await store.readSession(sessionId)).jobs.find((item) => item.assetId === modelOnly.variants[0].model.assetId);
    assert.equal(modelOnlyJob.status, 'completed', 'a render that fails never fails the job');
    assert.deepEqual(modelOnlyJob.resultAssetIds, [modelOnly.variants[0].model.assetId]);
    assert.ok(warned.some((line) => /\[glb-preview\] Vorschau von mod-\d+\.glb nicht erstellt: .*KHR_draco_mesh_compression/.test(line)), `the reason is logged: ${warned.join(' | ')}`);
    assert.equal(journal.length, 1, 'booked once');
    assert.equal((await store.readLedger(sessionId)).filter((entry) => entry.kind === 'image').length, imagesBefore, 'no image was saved for it');
    assert.equal((await fsp.readdir(store.sessionAssetDir(sessionId))).some((name) => name.endsWith('.part')), false);
  }

  /* ---------- results that are no GLB ---------- */
  {
    const failedRun = async (inputs, raw) => {
      resetCalls();
      return errorOf(execute(inputs, raw));
    };
    const ledgerBefore = (await store.readLedger(sessionId)).filter((entry) => !entry.pending).length;
    // a file that is no GLB (content type or bytes)
    downloads = { [URLS.glb]: { bytes: Buffer.from('<!doctype html><title>error</title>'), contentType: 'text/html' } };
    let err = await errorOf((async () => { resetCalls(); downloads = { [URLS.glb]: { bytes: Buffer.from('<!doctype html><title>error</title>'), contentType: 'text/html' } }; return execute(inputsOf(front)); })());
    assert.equal(err.code, 'MESH_FILE_NOT_GLB');
    assert.match(err.message, /keine GLB-Datei/);
    // the same with a content type that looks right: the first bytes decide
    resetCalls();
    downloads = { [URLS.glb]: { bytes: Buffer.from('this is not a glTF at all, just text'), contentType: 'model/gltf-binary' } };
    err = await errorOf(execute(inputsOf(front)));
    assert.equal(err.code, 'MESH_FILE_NOT_GLB');
    // an FBX named .glb with other magic, and the glTF magic with another version
    resetCalls();
    downloads = { [URLS.glb]: { bytes: Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(40)]) } };
    assert.equal((await errorOf(execute(inputsOf(front)))).code, 'MESH_FILE_NOT_GLB');
    resetCalls();
    const oldVersion = Buffer.from(GLB);
    oldVersion.writeUInt32LE(1, 4);
    downloads = { [URLS.glb]: { bytes: oldVersion } };
    assert.equal((await errorOf(execute(inputsOf(front)))).code, 'MESH_FILE_NOT_GLB');
    // nothing was stored: no model asset, no part file, no preview of a refused model
    const after = await store.readLedger(sessionId);
    assert.equal(after.filter((entry) => !entry.pending).length, ledgerBefore, 'a refused result stores nothing');
    assert.equal(after.some((entry) => entry.kind === 'model3d' && entry.pending), true, 'the reserved asset stays pending (the job failed)');
    assert.equal((await fsp.readdir(store.sessionAssetDir(sessionId))).some((name) => name.endsWith('.part')), false);
    const failedJob = (await store.readSession(sessionId)).jobs.filter((job) => job.status === 'failed').at(-1);
    assert.equal(failedJob.errorCode, 'MESH_FILE_NOT_GLB');

    // SAM 3D without model_glb: a clear message, the splat is not saved
    err = await failedRun(inputsOf(front), { model: 'sam3d_objects', object: 'chair' });
    assert.equal(err, null, 'sanity: the default answer has a model');
    resetCalls();
    scenario = () => ({ gaussian_splat: { url: URLS.ply, content_type: 'application/octet-stream' }, metadata: [] });
    err = await errorOf(execute(inputsOf(front), { model: 'sam3d_objects', object: 'chair' }));
    assert.equal(err.code, 'MESH_SPLAT_ONLY');
    assert.match(err.message, /Gaussian-Splat/);
    assert.deepEqual(calls.download, [], 'the splat is not even downloaded');
    assert.equal((await fsp.readdir(store.sessionAssetDir(sessionId))).some((name) => name.endsWith('.ply')), false);
    // fal finished the job and bills it: the price is in the journal, under the operator and not under the person
    assert.equal(journal.length, 1);
    assert.deepEqual([journal[0].user, journal[0].type, journal[0].model, journal[0].billing], ['betreiber', 'fal', 'fal-ai/sam-3/3d-objects', 'Kein Ergebnis (Listenpreis)']);
    near(journal[0].cost, 0.02);
    assert.notEqual(journal[0].user, 'tester');
    // nothing usable at all, and only another format
    resetCalls();
    scenario = () => ({ metadata: [] });
    assert.equal((await errorOf(execute(inputsOf(front), { model: 'sam3d_objects', object: 'chair' }))).code, 'MESH_NO_GLB');
    resetCalls();
    scenario = () => ({ model_mesh: glbFile(URLS.fbx), model_urls: {} });
    err = await errorOf(execute(inputsOf(front)));
    assert.equal(err.code, 'MESH_NO_GLB');
    assert.deepEqual(calls.download, []);
    assert.equal(journal.length, 1, 'a result with only another format was billed as well');
    assert.deepEqual([journal[0].user, journal[0].billing], ['betreiber', 'Kein Ergebnis (Listenpreis)']);
    near(journal[0].cost, 0.3);

    // a download that is cut off is asked for again, a result that is too large is refused with the URL kept for the person
    resetCalls();
    const cut = GLB.subarray(0, GLB.length - 40);
    let attempts = 0;
    patch(fal, 'downloadToFile', async (url, dest, options = {}) => {
      calls.download.push({ url, maxBytes: options.maxBytes });
      attempts += 1;
      const bytes = url === URLS.glb && attempts === 1 ? cut : url.endsWith('.glb') ? GLB : PNG;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, bytes);
      return { bytes: bytes.length, contentType: 'application/octet-stream' };
    });
    const retried = await execute(inputsOf(front));
    assert.equal(retried.variants[0].model.type, 'model3d');
    assert.equal(calls.download.filter((item) => item.url === URLS.glb).length, 2, 'the cut-off file was fetched again');
    restorers.pop()(); // back to the mock of this test
    resetCalls();
    downloads = { [URLS.glb]: { error: new fal.FalError('Das fal.ai-Ergebnis ist groesser als 256 MB und wurde nicht gespeichert.') } };
    err = await errorOf(execute(inputsOf(front)));
    assert.match(err.message, /groesser als 256 MB/);
    assert.equal(err.code, undefined);

    // a result file that is no GLB was billed as well: one journal entry under the operator, the person is not charged
    resetCalls();
    downloads = { [URLS.glb]: { bytes: Buffer.from('<!doctype html>'), contentType: 'text/html' } };
    err = await errorOf(execute(inputsOf(front)));
    assert.equal(err.code, 'MESH_FILE_NOT_GLB');
    assert.equal(journal.length, 1);
    assert.deepEqual([journal[0].user, journal[0].type, journal[0].model, journal[0].billing, journal[0].assetId !== undefined], ['betreiber', 'fal', 'tripo3d/h3.1/image-to-3d', 'Kein Ergebnis (Listenpreis)', true]);
    near(journal[0].cost, 0.3);

    // the JSON chunk is read: a GLB without one, or with a broken one, is no model
    const chunked = (type, payload) => {
      const head = Buffer.alloc(12);
      head.writeUInt32LE(0x46546c67, 0);
      head.writeUInt32LE(2, 4);
      head.writeUInt32LE(12 + 8 + payload.length, 8);
      const chunk = Buffer.alloc(8);
      chunk.writeUInt32LE(payload.length, 0);
      chunk.writeUInt32LE(type, 4);
      return Buffer.concat([head, chunk, payload]);
    };
    const headerOnly = Buffer.from(GLB.subarray(0, 12));
    headerOnly.writeUInt32LE(12, 8);
    for (const [name, bytes] of [
      ['header only', headerOnly],
      ['binary chunk first', chunked(0x004e4942, Buffer.alloc(16))],
      ['broken JSON', chunked(0x4e4f534a, Buffer.from('{"asset": '.padEnd(16, ' ')))],
      ['JSON that is a list', chunked(0x4e4f534a, Buffer.from('[1, 2, 3]   '))]
    ]) {
      resetCalls();
      downloads = { [URLS.glb]: { bytes } };
      err = await errorOf(execute(inputsOf(front)));
      assert.equal(err && err.code, 'MESH_FILE_NOT_GLB', name);
    }

    // a GLB that points outside its own file is refused before it is stored: the viewer of whoever opens the model would
    // load the address (an image, a buffer), and the page sets no content security policy
    const edited = (edit) => cubeGlb({ edit });
    const outside = [
      ['image over https', (json) => { json.images = [{ uri: 'https://tracker.example.com/pixel.png' }]; }],
      ['image over http', (json) => { json.images = [{ uri: 'http://tracker.example.com/pixel.png' }]; }],
      ['image with a relative path', (json) => { json.images = [{ uri: 'textures/base.png' }]; }],
      ['image without a scheme', (json) => { json.images = [{ uri: '//tracker.example.com/pixel.png' }]; }],
      ['buffer over https', (json) => { json.buffers.push({ byteLength: 8, uri: 'https://tracker.example.com/data.bin' }); }],
      ['uri deeper in an extension', (json) => { json.extensions = { VENDOR_thing: { items: [{ source: { uri: 'https://tracker.example.com/x' } }] } }; }]
    ];
    for (const [name, edit] of outside) {
      resetCalls();
      downloads = { [URLS.glb]: { bytes: edited(edit) } };
      const before = (await store.readLedger(sessionId)).filter((entry) => !entry.pending).length;
      err = await errorOf(execute(inputsOf(front)));
      assert.equal(err && err.code, 'MESH_FILE_EXTERNAL', name);
      assert.match(err.message, /ausserhalb/);
      assert.equal((await store.readLedger(sessionId)).filter((entry) => !entry.pending).length, before, `${name}: nothing stored`);
      assert.equal(journal.length, 1, `${name}: billed by fal, so booked`);
      assert.equal(journal[0].user, 'betreiber');
    }
    // data: URIs stay inside the file: allowed (images and buffers of a GLB may be embedded that way)
    resetCalls();
    const embedded = edited((json) => {
      json.images = [{ uri: `data:image/png;base64,${PNG.toString('base64')}` }];
      json.buffers.push({ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' });
    });
    downloads = { [URLS.glb]: { bytes: embedded } };
    const embeddedOutcome = await execute(inputsOf(front));
    assert.equal(embeddedOutcome.variants[0].model.type, 'model3d');
    assert.equal(journal[0].user, 'tester', 'a model that was stored is booked under the person');
    // compressed models are stored, and named in the log (the viewer loads the decoder of Google for them, see the README)
    resetCalls();
    downloads = { [URLS.glb]: { bytes: edited((json) => { json.extensionsRequired = ['KHR_draco_mesh_compression']; json.extensionsUsed = ['KHR_draco_mesh_compression']; }) } };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let draco;
    try {
      draco = await execute(inputsOf(front));
    } finally {
      console.warn = warn;
    }
    assert.equal(draco.variants[0].model.type, 'model3d');
    assert.ok(warnings.some((line) => /KHR_draco_mesh_compression/.test(line)), warnings.join('\n'));
    // the check itself, without a file
    const found = poller.inspectGlbJson({ images: [{ uri: 'a.png' }, { uri: 'DATA:image/png;base64,AA==' }, { bufferView: 1 }], buffers: [{ uri: 'https://x.test/b.bin' }], extensionsRequired: ['KHR_texture_basisu', 'KHR_materials_unlit'] });
    assert.deepEqual(plainJson(found), { external: plainJson(found.external), compressed: ['KHR_texture_basisu'] });
    assert.deepEqual([...found.external].sort(), ['a.png', 'https://x.test/b.bin']);
    assert.deepEqual(plainJson(poller.inspectGlbJson({})), { external: [], compressed: [] });
    assert.deepEqual(plainJson(poller.inspectGlbJson(null)), { external: [], compressed: [] });

    // the first file is no GLB (a model_mesh without an extension that is an FBX): the next candidate is tried
    resetCalls();
    const NOEXT = 'https://v3b.fal.media/files/out/model';
    scenario = () => ({ model_mesh: { url: NOEXT, content_type: 'application/octet-stream' }, model_urls: { glb: glbFile() }, rendered_image: pngFile(), task_id: 'task-2' });
    downloads = { [NOEXT]: { bytes: Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(40)]) } };
    const rescued = await execute(inputsOf(front));
    assert.deepEqual(calls.download.map((item) => item.url), [NOEXT, URLS.glb, URLS.png], 'the GLB of model_urls after the file that was none');
    const rescuedFile = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), rescued.variants[0].model.file));
    assert.ok(rescuedFile.equals(GLB));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].user, 'tester');
    // every candidate fails: the job fails with the code of the first
    resetCalls();
    scenario = () => ({ model_mesh: { url: NOEXT, content_type: 'application/octet-stream' }, model_urls: { glb: glbFile() } });
    downloads = { [NOEXT]: { bytes: Buffer.alloc(64) }, [URLS.glb]: { bytes: Buffer.from('<html>no</html>') } };
    err = await errorOf(execute(inputsOf(front)));
    assert.equal(err.code, 'MESH_FILE_NOT_GLB');
    assert.deepEqual(calls.download.map((item) => item.url), [NOEXT, URLS.glb]);
    assert.equal(journal.length, 1, 'one booking for the job, not one per file');
    // a network problem is no reason to switch to the next file: it is asked for again
    resetCalls();
    scenario = () => ({ model_mesh: { url: NOEXT, content_type: 'application/octet-stream' }, model_urls: { glb: glbFile() } });
    let flaky = 0;
    patch(fal, 'downloadToFile', async (url, dest, options = {}) => {
      calls.download.push({ url, maxBytes: options.maxBytes });
      flaky += 1;
      if (flaky === 1) throw new fal.FalError('network', 0, { retryable: true });
      const bytes = GLB;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, bytes);
      return { bytes: bytes.length, contentType: 'application/octet-stream' };
    });
    const resumed = await execute(inputsOf(front));
    assert.equal(resumed.variants[0].model.type, 'model3d');
    assert.deepEqual(calls.download.slice(0, 2).map((item) => item.url), [NOEXT, NOEXT], 'the same file again, not the next one');
    restorers.pop()();
    resetCalls();
  }

  /* ---------- in a workflow, over the API: results, ZIP, chat, a model change, an empty preview ---------- */
  {
    const owner = STAFF;
    const stop = { value: false };
    // the poller runs in the background, like on the server
    const pump = (async () => {
      while (!stop.value) {
        await poller.pollOnce().catch(() => {});
        await sleep(100);
      }
    })();
    try {
      const call = (method, url, json, extra = {}) => api(url, { method, as: owner, json, ...extra });
      const created = (await call('POST', '/api/workflows', { name: 'Foto zu 3D' })).body.workflow;
      const source = await picture('.png', { owner: created.sessionId });
      const sourceB = await picture('.png', { owner: created.sessionId });
      let rev = 1;
      const inputNode = (id, value, y) => node(id, 'input.image', { asset: { assetId: value.assetId, sessionId: created.sessionId } }, 0, y);
      const save = async (graph) => {
        const response = await call('PUT', `/api/workflows/${created.id}`, { baseRev: rev, graph: { ...graph, groups: [], notes: [] } });
        assert.equal(response.status, 200, response.text);
        rev = response.body.rev;
        return response.body;
      };
      const finish = async (runId) => {
        const started = Date.now();
        for (;;) {
          const record = (await call('GET', `/api/workflows/${created.id}/runs/${runId}`)).body;
          if (record && record.status !== 'running') return record;
          assert.ok(Date.now() - started < 30000, 'the run finishes');
          await sleep(100);
        }
      };
      const start = async (body = { mode: 'all' }) => {
        // the engine lets go of the finished run a moment after its record says so
        for (let i = 0; i < 100 && (await call('GET', `/api/workflows/${created.id}`)).body.activeRun; i += 1) await sleep(50);
        const response = await call('POST', `/api/workflows/${created.id}/runs`, body);
        assert.equal(response.status, 202, response.text);
        return finish(response.body.runId);
      };
      const g = (model, extra = {}, y = 100) => node('g', 'fal.image_to_3d', { model, ...extra }, 300, y);

      // plan: the price follows the options and the connected views
      await save({
        nodes: [inputNode('a', source, 0), inputNode('b', sourceB, 160), g('hunyuan_pro31'), node('out', 'output.result', { label: 'Modell' }, 600, 100)],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e2', 'b', 'image', 'g', 'left'), edge('e3', 'g', 'model', 'out', 'inputs'), edge('e4', 'g', 'preview', 'out', 'inputs')]
      });
      let planned = (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(planned.valid, true, JSON.stringify(planned.issues));
      near(planned.nodes.g.estimate.usd, 0.525, 'Hunyuan with a view');
      assert.equal(planned.totals.unknownNodes, 0);
      near(planned.totals.usd, 0.525);

      // the model changes, the connection stays: SAM 3D takes no view, the plan says so and nothing runs
      await save({
        nodes: [inputNode('a', source, 0), inputNode('b', sourceB, 160), g('sam3d_objects', { object: 'chair' }), node('out', 'output.result', { label: 'Modell' }, 600, 100)],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e2', 'b', 'image', 'g', 'left'), edge('e3', 'g', 'model', 'out', 'inputs')]
      });
      planned = (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(planned.valid, false);
      const issue = planned.issues.find((item) => item.nodeId === 'g');
      assert.deepEqual([issue.code, issue.port, issue.data], ['MESH_VIEW_UNSUPPORTED', 'left', { model: 'SAM 3D Objects' }]);
      assert.equal(planned.nodes.g.status, 'invalid');
      assert.equal(planned.nodes.g.reasonCode, 'MESH_VIEW_UNSUPPORTED');
      const workflow = (await call('GET', `/api/workflows/${created.id}`)).body.workflow;
      assert.equal(workflow.graph.edges.length, 3, 'the connections are still there');
      const refusedRun = await call('POST', `/api/workflows/${created.id}/runs`, { mode: 'all' });
      assert.ok(refusedRun.status >= 400, 'the run is refused before anything is paid');
      nothingSentSince(calls, 0);

      // Tripo with the three views and the preview connected: the full run
      await save({
        nodes: [inputNode('a', source, 0), inputNode('b', sourceB, 160), g('tripo_h31'), node('out', 'output.result', { label: 'Modell' }, 600, 100)],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e2', 'b', 'image', 'g', 'left'), edge('e3', 'g', 'model', 'out', 'inputs'), edge('e4', 'g', 'preview', 'out', 'inputs')]
      });
      resetCalls();
      const done = await start();
      assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 500));
      assert.equal(calls.submit.length, 1);
      assert.equal(calls.submit[0].endpoint, 'tripo3d/h3.1/multiview-to-3d');
      const results = (await call('GET', `/api/workflows/${created.id}`)).body.results;
      const variant = results.nodes.g.history[0].variants[0];
      assert.equal(variant.model.type, 'model3d');
      assert.equal(variant.preview.type, 'image');
      near(results.nodes.g.history[0].cost.usd, 0.3);

      // the file is served as a GLB, not sniffed
      const served = await api(variant.model.url, { as: owner, raw: true });
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'model/gltf-binary');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(Buffer.from(await served.arrayBuffer()).equals(GLB), 'the file the page loads is the GLB');
      const servedPreview = await api(variant.preview.url, { as: owner, raw: true });
      assert.equal(servedPreview.headers.get('content-type'), 'image/png');
      await servedPreview.arrayBuffer();

      // the asset list of the workflow offers the model and the preview
      const listed = (await call('GET', `/api/workflows/${created.id}/assets`)).body.assets;
      assert.ok(listed.some((item) => item.type === 'model3d' && item.assetId === variant.model.assetId));
      // ... and nobody can upload one
      const upload = await api(`/api/workflows/${created.id}/uploads`, { method: 'POST', as: owner, headers: { 'Content-Type': 'model/gltf-binary', 'X-Filename': 'model.glb' }, body: GLB });
      assert.equal(upload.status, 415, upload.text);

      // the ZIP of the outputs holds the GLB (and the preview)
      const zipResponse = await call('GET', `/api/workflows/${created.id}/outputs.zip`, undefined, { raw: true });
      assert.equal(zipResponse.status, 200);
      const zipped = await unzip(Buffer.from(await zipResponse.arrayBuffer()));
      const names = Object.keys(zipped);
      const glbName = names.find((name) => name.endsWith('.glb'));
      assert.ok(glbName, `the GLB is in the ZIP: ${names.join(', ')}`);
      assert.match(glbName, /^01-Modell-01\.glb$/);
      assert.ok(zipped[glbName].equals(GLB));
      assert.ok(names.some((name) => name.endsWith('.png')), 'the preview as well');
      readGlb(zipped[glbName]);

      // send to the chat: a 3D model is refused, its preview is not
      const chat = (await call('POST', '/api/sessions', {})).body.session;
      const planChat = (await call('GET', `/api/workflows/${created.id}/send-to-chat/plan?nodeId=g`)).body;
      assert.deepEqual(planChat.ports.map((port) => port.id), ['preview'], 'only the preview can be sent');
      assert.deepEqual(planChat.unsupported, [{ id: 'model', kind: 'model3d' }]);
      assert.equal(planChat.ports[0].selected, true);
      const sendModel = await call('POST', `/api/workflows/${created.id}/send-to-chat`, { sessionId: chat.id, nodeId: 'g', ports: ['model'] });
      assert.equal(sendModel.status, 415, sendModel.text);
      assert.equal(sendModel.body.code, 'UNSUPPORTED_MEDIA');
      assert.equal(sendModel.body.reason, 'model3d');
      assert.match(sendModel.body.error, /3D models cannot be sent to the chat/);
      const sendBoth = await call('POST', `/api/workflows/${created.id}/send-to-chat`, { sessionId: chat.id, nodeId: 'g', ports: ['model', 'preview'] });
      assert.equal(sendBoth.status, 415, 'asking for the model is refused as a whole');
      assert.equal((await store.readSession(chat.id)).messages.length, 0, 'nothing reached the chat');
      const sendPreview = await call('POST', `/api/workflows/${created.id}/send-to-chat`, { sessionId: chat.id, nodeId: 'g', ports: ['preview'] });
      assert.equal(sendPreview.status, 200, sendPreview.text);
      assert.equal(sendPreview.body.assetIds.length, 1);
      const sendDefault = await call('POST', `/api/workflows/${created.id}/send-to-chat`, { sessionId: chat.id, nodeId: 'g' });
      assert.equal(sendDefault.status, 200, 'without a choice the preview goes');
      assert.deepEqual(sendDefault.body.ports, ['preview']);
      const chatAssets = await store.readLedger(chat.id);
      assert.equal(chatAssets.every((entry) => entry.kind === 'image'), true, 'no model in the chat');

      // SAM 3D delivers no preview: the app draws one from the model, so the output is there like with the other models
      await save({
        nodes: [
          inputNode('a', source, 0),
          g('sam3d_objects', { object: 'chair' }),
          node('out', 'output.result', { label: 'Modell' }, 600, 100)
        ],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e3', 'g', 'model', 'out', 'inputs'), edge('e4', 'g', 'preview', 'out', 'inputs')]
      });
      resetCalls();
      const samDone = await start();
      assert.equal(samDone.status, 'completed', JSON.stringify(samDone).slice(0, 500));
      assert.equal(calls.submit[0].endpoint, 'fal-ai/sam-3/3d-objects');
      const samVariant = (await call('GET', `/api/workflows/${created.id}`)).body.results.nodes.g.history[0].variants[0];
      assert.deepEqual(Object.keys(samVariant).sort(), ['model', 'preview']);
      assert.equal(samVariant.model.type, 'model3d');
      assert.equal(samVariant.preview.type, 'image');
      const samServed = await api(samVariant.preview.url, { as: owner, raw: true });
      assert.equal(samServed.headers.get('content-type'), 'image/png');
      await assertDrawnPreview(Buffer.from(await samServed.arrayBuffer()));
      // the chat takes the preview image, not the model
      const samSend = await call('POST', `/api/workflows/${created.id}/send-to-chat`, { sessionId: chat.id, nodeId: 'g' });
      assert.equal(samSend.status, 200, samSend.text);
      assert.deepEqual(samSend.body.ports, ['preview']);
      // a node behind the preview of SAM 3D is valid now: the plan counts it with the model, nothing is refused
      const behindPreview = (object) => ({
        nodes: [
          inputNode('a', source, 0),
          g('sam3d_objects', { object }),
          node('out', 'output.result', { label: 'Modell' }, 600, 100),
          node('rb', 'fal.remove_background', {}, 600, 260)
        ],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e3', 'g', 'model', 'out', 'inputs'), edge('e5', 'g', 'preview', 'rb', 'image')]
      });
      await save(behindPreview('table'));
      planned = (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(planned.valid, true, JSON.stringify(planned.issues));
      assert.equal(planned.issues.some((item) => item.code === 'OUTPUT_EMPTY'), false, 'the preview of SAM 3D is no empty output any more');
      assert.notEqual(planned.nodes.rb.status, 'invalid');
      near(planned.totals.usd, 0.02 + nodesFal.PRICES.removeBackground.usd, 'SAM 3D and the node behind it');
      assert.equal(planned.totals.paidNodes, 2);
      // running only the model works, and the same graph with the model made already does not make it again
      resetCalls();
      const onlyModel = await start({ mode: 'node', nodeIds: ['g'] });
      assert.equal(onlyModel.status, 'completed', JSON.stringify(onlyModel).slice(0, 400));
      assert.equal(calls.submit.length, 1);
      await save(behindPreview('chair'));
      planned = (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(planned.valid, true, JSON.stringify(planned.issues));
      assert.equal(planned.nodes.g.status, 'cached', 'the model is not made again');
      near(planned.totals.usd, nodesFal.PRICES.removeBackground.usd, 'only the node behind is left to pay');
      // a model that does render a preview takes the connection too (Tripo: valid and the full estimate)
      await save({
        nodes: [inputNode('a', source, 0), g('tripo_h31', { texture: false, seed: 11 }), node('rb', 'fal.remove_background', {}, 600, 260)],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e5', 'g', 'preview', 'rb', 'image')]
      });
      planned = (await call('POST', `/api/workflows/${created.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(planned.valid, true, JSON.stringify(planned.issues));
      near(planned.totals.usd, 0.2 + nodesFal.PRICES.removeBackground.usd);
      // and when the preview is missing after all (the provider delivers none and the app cannot draw the model, here one that
      // requires a decoder), the run says what the engine says for every output that stays empty: the node behind stops with the
      // code, the model stays
      resetCalls();
      const needsDecoder = cubeGlb({ edit: (json) => { json.extensionsRequired = ['KHR_draco_mesh_compression']; } });
      downloads = { [URLS.png]: { error: new Error('preview not reachable') }, [URLS.glb]: { bytes: needsDecoder } };
      const originalWarn = console.warn;
      console.warn = () => {};
      let runtimeStop;
      try {
        runtimeStop = await start();
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(runtimeStop.status, 'failed');
      assert.equal(runtimeStop.nodes.g.status, 'done');
      assert.equal(runtimeStop.nodes.rb.status, 'error');
      assert.equal(runtimeStop.nodes.rb.code, 'OUTPUT_EMPTY');
      assert.match(runtimeStop.nodes.rb.message, /produced no preview/);
      assert.equal(calls.submit.length, 1, 'the node behind did not start anything');

      // a result that is no GLB fails the node with a code the page can translate, and costs the person nothing booked
      await save({
        nodes: [inputNode('a', source, 0), g('tripo_h31', { texture: false }), node('out', 'output.result', { label: 'Modell' }, 600, 100)],
        edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e3', 'g', 'model', 'out', 'inputs')]
      });
      resetCalls();
      downloads = { [URLS.glb]: { bytes: Buffer.from('<html>no</html>'), contentType: 'text/html' } };
      const bad = await start({ mode: 'all', force: true });
      assert.equal(bad.status, 'failed');
      assert.equal(bad.nodes.g.status, 'error');
      assert.equal(bad.nodes.g.code, 'MESH_FILE_NOT_GLB');
      assert.equal(journal.length, 1, 'fal bills the job: one booking');
      assert.equal(journal[0].user, 'betreiber', 'under the operator, not under the person');
      assert.equal(journal[0].billing, 'Kein Ergebnis (Listenpreis)');
      near(journal[0].cost, 0.2, 'Tripo without texture');
      resetCalls();
    } finally {
      stop.value = true;
      await pump;
    }
  }

  /* ---------- participants: the budget counts ---------- */
  {
    const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs 3D', budgetUsd: 1 } })).body.team;
    assert.ok(team, 'a team with a budget of 1 USD');
    await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } });
    const call = (method, url, json, extra = {}) => api(url, { method, as: P1, json, ...extra });
    const stop = { value: false };
    const pump = (async () => {
      while (!stop.value) {
        await poller.pollOnce().catch(() => {});
        await sleep(100);
      }
    })();
    try {
      const options = await call('GET', '/api/nodes/options/image-to-3d-models');
      assert.equal(options.status, 200, 'the model list is open to participants');
      assert.equal(options.body.options.length, 4);
      const registryPayload = (await call('GET', '/api/nodes/registry')).body;
      const entry = registryPayload.nodeTypes.find((type) => type.type === 'fal.image_to_3d');
      assert.ok(entry && !entry.restricted, 'the node is open to participants');
      assert.equal(entry.available, true);

      const flow = (await call('POST', '/api/workflows', { name: 'Teilnehmende' })).body.workflow;
      const image = await picture('.png', { owner: flow.sessionId });
      let rev = 1;
      const save = async (model, extra = {}) => {
        const response = await call('PUT', `/api/workflows/${flow.id}`, {
          baseRev: rev,
          graph: {
            nodes: [node('a', 'input.image', { asset: { assetId: image.assetId, sessionId: flow.sessionId } }), node('g', 'fal.image_to_3d', { model, ...extra }, 300, 0), node('out', 'output.result', { label: 'Modell' }, 600, 0)],
            edges: [edge('e1', 'a', 'image', 'g', 'image'), edge('e2', 'g', 'model', 'out', 'inputs')],
            groups: [],
            notes: []
          }
        });
        assert.equal(response.status, 200, response.text);
        rev = response.body.rev;
      };
      const finish = async (runId) => {
        const started = Date.now();
        for (;;) {
          const record = (await call('GET', `/api/workflows/${flow.id}/runs/${runId}`)).body;
          if (record && record.status !== 'running') return record;
          assert.ok(Date.now() - started < 30000, 'the run finishes');
          await sleep(100);
        }
      };

      // Meshy (1.20) does not fit a budget of 1.00: the plan says so and the run is refused before anything is uploaded
      await save('meshy_71');
      resetCalls();
      const tightPlan = (await call('POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' })).body;
      near(tightPlan.totals.usd, 1.2);
      assert.equal(tightPlan.budget.enough, false);
      assert.equal(tightPlan.budget.code, 'BUDGET_INSUFFICIENT');
      const tooDear = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(tooDear.status, 402);
      assert.equal(tooDear.body.code, 'BUDGET_INSUFFICIENT');
      near(tooDear.body.estimateUsd, 1.2);
      nothingSent();

      // SAM 3D without a name is invalid before the budget is asked
      await save('sam3d_objects');
      const invalidPlan = (await call('POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(invalidPlan.nodes.g.reasonCode, 'MESH_OBJECT_REQUIRED');

      // Tripo (0.30) fits: the run is paid from the budget, the estimate is what is booked
      await save('tripo_h31');
      const fitsPlan = (await call('POST', `/api/workflows/${flow.id}/runs/plan`, { mode: 'all' })).body;
      assert.equal(fitsPlan.budget.enough, true);
      near(fitsPlan.budget.estimateUsd, 0.3);
      const started = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(started.status, 202, started.text);
      const done = await finish(started.body.runId);
      assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 400));
      assert.equal(calls.submit.length, 1);
      const me = (await api('/api/me', { as: P1 })).body.budget;
      near(me.spentUsd, 0.3, 'the estimate counts against the budget');
      assert.equal(me.reservedUsd, 0, 'nothing stays reserved');
      assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
      assert.equal(journal.length, 1);
      assert.equal(journal[0].user, P1);
      near(journal[0].cost, 0.3);

      // SAM 3D delivers a splat and no mesh: fal bills the job, the operator carries it, the budget of the person stays as it was
      await save('sam3d_objects', { object: 'chair' });
      resetCalls();
      scenario = () => ({ gaussian_splat: { url: URLS.ply, content_type: 'application/octet-stream' }, metadata: [] });
      const failedStart = await call('POST', `/api/workflows/${flow.id}/runs`, { mode: 'all' });
      assert.equal(failedStart.status, 202, failedStart.text);
      const failedRun = await finish(failedStart.body.runId);
      assert.equal(failedRun.status, 'failed');
      assert.equal(failedRun.nodes.g.code, 'MESH_SPLAT_ONLY');
      assert.equal(journal.length, 1);
      assert.deepEqual([journal[0].user, journal[0].billing], ['betreiber', 'Kein Ergebnis (Listenpreis)']);
      near(journal[0].cost, 0.02);
      const meAfter = (await api('/api/me', { as: P1 })).body.budget;
      near(meAfter.spentUsd, 0.3, 'the person pays for nothing that gave no result');
      assert.equal(meAfter.reservedUsd, 0, 'and nothing stays reserved');
      assert.equal(budgetLib.defaultBudget.reservationCount(), 0);
    } finally {
      stop.value = true;
      await pump;
    }
  }

  assert.ok(routesModule, 'the routes module of the copy is loaded');
  resetCalls();
  await store.deleteSession(sessionId).catch(() => {});
}

function nothingSentSince(calls, count) {
  assert.equal(calls.submit.length, count, 'nothing was queued');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
