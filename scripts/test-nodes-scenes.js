'use strict';

// The scene table of the inspector (WP35). Two parts:
//   1. without a browser: the rows (public/nodes/scene-table.js: number, preview kind, main text, length, which result may be made again
//      by single items), the costs, the request of the run mode 'items' (run.js buildRunRequest), the words in German, English and
//      Spanish, the wiring in index.html and the phone rules of the style sheet
//   2. in a real browser (puppeteer-core from render-node/node_modules, Chrome): a workflow with a list runs on a server of its own
//      (temporary data folder, free port, never 3111, no paid calls); the table appears for the node with the list and for no other,
//      its rows have preview and text, "Make again" sends the run mode 'items' with the right numbers (one row, ticked rows), the
//      other items stay as they were, and the table works at desktop and phone width. Without Chrome or puppeteer-core the browser
//      part is skipped with a note.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const sceneTable = require('../public/nodes/scene-table');
const run = require('../public/nodes/run');
const { rows: nodeRows } = require('../public/nodes/i18n-nodes');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LANGS = ['de', 'en', 'es'];

const text = (value) => ({ type: 'text', value });
const list = (type, items) => ({ type: 'list', itemType: type, items });
const image = (id) => ({ type: 'image', assetId: id, url: `/assets/${id}.png` });
const video = (id, duration) => ({ type: 'video', assetId: id, url: `/assets/${id}.mp4`, ...(duration ? { duration } : {}) });

/* ---------- 1. without a browser ---------- */

function table(overrides = {}) {
  return sceneTable.sceneTable({
    nodeId: 'n2',
    category: 'video',
    entry: { id: 'e1', itemKeys: ['k1', 'k2', 'k3'], params: {} },
    variant: { videos: list('video', [video('a', 4), video('b', 6.4), video('c')]) },
    order: ['videos'],
    hidden: new Set(),
    inputPorts: [{ id: 'prompt', type: 'text' }, { id: 'image', type: 'image' }],
    edges: [{ id: 'e1', from: { node: 'n1', port: 'prompts' }, to: { node: 'n2', port: 'prompt' } }],
    upstreamVariant: (id) => (id === 'n1' ? { prompts: list('text', [text('first scene'), text('  second scene  '), text('third scene')]) } : null),
    ...overrides
  });
}

function testRows() {
  const t = table();
  assert.equal(t.port, 'videos');
  assert.equal(t.count, 3);
  assert.equal(t.aligned, true, 'the entry knows the key of every item');
  assert.deepEqual(t.rows.map((row) => [row.index, row.number, row.kind, row.text, row.duration]), [
    [0, 1, 'video', 'first scene', 4],
    [1, 2, 'video', 'second scene', 6.4],
    [2, 3, 'video', 'third scene', null]
  ], 'a row per item with number, kind, the text of its own item and the length where it is known');
  assert.equal(t.rows[1].value.assetId, 'b', 'the value of the item is there for the preview');

  // the kinds of preview
  const kinds = (items) => table({ variant: { out: list('x', items) }, order: ['out'] }).rows.map((row) => row.kind);
  assert.deepEqual(kinds([image('a'), video('b'), { type: 'audio', url: '/a.mp3' }, text('t'), { type: 'number', value: 3 }, { type: 'model3d', url: '/m.glb' }, { type: 'document', url: '/d.pdf' }, { type: 'odd' }]),
    ['image', 'video', 'audio', 'text', 'number', 'model3d', 'document', 'other']);
  assert.equal(sceneTable.kindOf(null), 'none');

  // a single text is the same for every item; a list gives its own
  const single = table({ edges: [{ from: { node: 'n0', port: 'out' }, to: { node: 'n2', port: 'prompt' } }], upstreamVariant: () => ({ out: text('one for all') }) });
  assert.deepEqual(single.rows.map((row) => row.text), ['one for all', 'one for all', 'one for all']);
  // the brief of an explainer scene starts with a technical line: the row shows the title, else the narration, else the first bullet
  const header = 'Scene s1 · role hook · kind motion · about 6 s · landscape · language de';
  const briefRows = (briefs) =>
    table({
      inputPorts: [{ id: 'brief', type: 'text' }],
      edges: [{ from: { node: 'n0', port: 'briefs' }, to: { node: 'n2', port: 'brief' } }],
      upstreamVariant: () => ({ briefs: list('text', briefs.map(text)) })
    }).rows.map((row) => row.text);
  assert.deepEqual(
    briefRows([
      `${header}\nTitle: Der Hook\nBullets:\n- erste\nNarration (for timing and context, do NOT write it on screen): Ein Satz.`,
      `${header}\nBullets:\n- erste\n- zweite\nNarration (for timing and context, do NOT write it on screen): Ein Satz.`,
      `${header}\nBullets:\n- nur ein Punkt`
    ]),
    ['Der Hook', 'Ein Satz.', 'nur ein Punkt'],
    'no technical header in the table'
  );
  assert.deepEqual(briefRows(['Ein gewöhnlicher Prompt\nüber zwei Zeilen', 'Scene without the header form', 'x']), ['Ein gewöhnlicher Prompt\nüber zwei Zeilen', 'Scene without the header form', 'x'], 'other texts are shown as they are');
  // the first text input with a text wins, in the order of the ports; ports of other kinds and `multiple` ports are not looked at
  const two = table({
    inputPorts: [{ id: 'image', type: 'image' }, { id: 'refs', type: 'text', multiple: true }, { id: 'brief', type: 'text' }, { id: 'prompt', type: 'text[]' }],
    edges: [
      { from: { node: 'n1', port: 'prompts' }, to: { node: 'n2', port: 'prompt' } },
      { from: { node: 'n3', port: 'brief' }, to: { node: 'n2', port: 'brief' } },
      { from: { node: 'n3', port: 'brief' }, to: { node: 'n2', port: 'refs' } }
    ],
    upstreamVariant: (id) => (id === 'n1' ? { prompts: list('text', [text('p1'), text('p2'), text('p3')]) } : { brief: text('the brief') })
  });
  assert.deepEqual(two.rows.map((row) => row.text), ['the brief', 'the brief', 'the brief'], 'brief comes before prompt in the order of the ports');
  // nothing connected or no result upstream: the settings of the entry, else empty
  const none = table({ edges: [], entry: { id: 'e1', itemKeys: ['a', 'b', 'c'], params: { prompt: '  from the settings ' } } });
  assert.deepEqual(none.rows.map((row) => row.text), ['from the settings', 'from the settings', 'from the settings']);
  assert.deepEqual(table({ edges: [], entry: { id: 'e1', itemKeys: ['a', 'b', 'c'], params: {} } }).rows.map((row) => row.text), ['', '', '']);
  assert.deepEqual(table({ upstreamVariant: () => null }).rows.map((row) => row.text), ['', '', ''], 'the upstream node has no result yet');
  // a shorter list upstream: the rows after its end have no text of their own
  const short = table({ upstreamVariant: () => ({ prompts: list('text', [text('only one')]) }) });
  assert.deepEqual(short.rows.map((row) => row.text), ['only one', '', '']);
  // a text that is only white space is none
  assert.equal(table({ upstreamVariant: () => ({ prompts: list('text', [text('   '), text('b'), text('c')]) }) }).rows[0].text, '');
}

function testWhereThereIsATable() {
  const base = { nodeId: 'n2', entry: { id: 'e1', itemKeys: ['a'] }, order: ['videos'], inputPorts: [], edges: [] };
  const withList = { videos: list('video', [video('a')]) };
  assert.ok(sceneTable.sceneTable({ ...base, category: 'video', variant: withList }), 'a list result');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'input', variant: withList }), null, 'an input node holds its list as a setting');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'output', variant: withList }), null);
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: null }), null, 'no result');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: { videos: video('a') } }), null, 'one value is no list');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: { videos: list('video', []) } }), null, 'an empty list');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList, hidden: ['videos'] }), null, 'a hidden output is not shown');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList, hidden: new Set(['videos']) }), null);
  // the first visible port with a list, in the order of the ports
  const second = sceneTable.sceneTable({ ...base, category: 'video', order: ['text', 'videos'], variant: { text: text('x'), videos: list('video', [video('a')]) } });
  assert.equal(second.port, 'videos');
  const two = sceneTable.sceneTable({ ...base, category: 'video', order: ['b', 'a'], variant: { a: list('text', [text('a')]), b: list('text', [text('b1'), text('b2')]) } });
  assert.equal(two.port, 'b');
  assert.equal(two.count, 2);

  // `aligned`: single items can only be made again where the entry has the key of every one
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList }).aligned, true);
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList, entry: { id: 'e1' } }).aligned, false, 'an older result has no keys');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList, entry: { id: 'e1', itemKeys: ['a', 'b'] } }).aligned, false, 'the keys do not fit the list');
  assert.equal(sceneTable.sceneTable({ ...base, category: 'video', variant: withList, entry: null }).aligned, false);

  // a very long list is cut at MAX_ROWS (the count stays true)
  const many = sceneTable.sceneTable({ ...base, category: 'video', variant: { videos: list('text', Array.from({ length: sceneTable.MAX_ROWS + 20 }, (_v, i) => text(String(i)))) }, entry: { id: 'e1' } });
  assert.equal(many.rows.length, sceneTable.MAX_ROWS);
  assert.equal(many.count, sceneTable.MAX_ROWS + 20);
}

function testRequestAndCost() {
  assert.deepEqual(sceneTable.itemsRequest('n2', [2, 0, 2, 1]), { mode: 'items', nodeId: 'n2', items: [0, 1, 2] }, 'once each, in order');
  assert.deepEqual(sceneTable.itemsRequest('n2', [-1, 1.5, 'x', 3]), { mode: 'items', nodeId: 'n2', items: [3] }, 'whole numbers from 0 only');
  assert.deepEqual(sceneTable.itemsRequest('n2', []).items, []);
  // what run.js sends to the plan and to the start: the same body
  assert.deepEqual(run.buildRunRequest({ mode: 'items', nodeId: 'n2', items: [1, 4], force: false, rev: 7 }), { mode: 'items', force: false, nodeId: 'n2', items: [1, 4], rev: 7 });
  assert.deepEqual(run.buildRunRequest({ mode: 'items', nodeId: 'n2' }), { mode: 'items', force: false, nodeId: 'n2', items: [] });
  assert.equal('nodeIds' in run.buildRunRequest({ mode: 'items', nodeId: 'n2', items: [0] }), false, 'no node list in this mode');
  assert.deepEqual(run.buildRunRequest({ mode: 'node', nodeIds: ['a'], force: true }), { mode: 'node', force: true, nodeIds: ['a'] }, 'the other modes are as before');

  const paid = sceneTable.itemCost({ paid: true, estimate: { usd: 0.1 } }, null);
  assert.deepEqual(paid, { paid: true, usd: 0.1, credits: null, unknown: false });
  assert.deepEqual(sceneTable.selectionCost(paid, 3), { paid: true, usd: 0.30000000000000004, credits: null, unknown: false });
  // a finished node ('cached' in the plan) has no estimate but the price of one execution
  assert.deepEqual(sceneTable.itemCost({ paid: true, status: 'cached', estimate: null, itemEstimate: { usd: 0.1 } }, null), { paid: true, usd: 0.1, credits: null, unknown: false });
  assert.deepEqual(sceneTable.itemCost({ paid: true, status: 'stale', estimate: { usd: 0.2 } }, null), { paid: true, usd: 0.2, credits: null, unknown: false });
  assert.deepEqual(sceneTable.itemCost({ paid: true }, null), { paid: true, usd: null, credits: null, unknown: true }, 'paid without an estimate: unknown');
  assert.deepEqual(sceneTable.itemCost(null, { paid: true }), { paid: true, usd: null, credits: null, unknown: true }, 'no plan yet, the type says paid');
  assert.deepEqual(sceneTable.itemCost({ paid: false }, { paid: false }), { paid: false, usd: null, credits: null, unknown: false });
  assert.deepEqual(sceneTable.itemCost(null, null), { paid: false, usd: null, credits: null, unknown: false });
  assert.deepEqual(sceneTable.itemCost({ paid: true, estimate: { credits: 40 } }, null), { paid: true, usd: null, credits: 40, unknown: false });
  assert.deepEqual(sceneTable.selectionCost(sceneTable.itemCost({ paid: true, estimate: { credits: 40 } }, null), 2), { paid: true, usd: null, credits: 80, unknown: false });
  assert.deepEqual(sceneTable.selectionCost(sceneTable.itemCost(null, null), 5), { paid: false, usd: null, credits: null, unknown: false }, 'free stays free');
  assert.equal(sceneTable.clock(7), '0:07');
  assert.equal(sceneTable.clock(65.4), '1:05');
  assert.equal(sceneTable.clock(600), '10:00');
}

function testWords() {
  const dictionary = Object.fromEntries(nodeRows.map(([key, ...values]) => [key, Object.fromEntries(LANGS.map((lang, index) => [lang, values[index]]))]));
  const used = new Set();
  for (const file of ['public/nodes/inspector.js', 'public/nodes/run.js', 'public/nodes/scene-table.js']) {
    for (const match of read(file).matchAll(/'(nodes\.scenes\.[A-Za-z.]+)'/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 12, `the table uses its words: ${[...used]}`);
  for (const key of used) {
    assert.ok(dictionary[key], `${key} is written`);
    for (const lang of LANGS) {
      const value = dictionary[key][lang];
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang}: ${key}`);
      assert.ok(!value.includes('ß'), `${lang}: ${key} has no sharp s`);
    }
    const placeholders = (lang) => [...dictionary[key][lang].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
    assert.equal(placeholders('en'), placeholders('de'), `${key}: the same placeholders in German and English`);
    assert.equal(placeholders('es'), placeholders('de'), `${key}: the same placeholders in German and Spanish`);
  }
  for (const key of Object.keys(dictionary).filter((item) => item.startsWith('nodes.scenes.'))) assert.ok(used.has(key), `${key} is used`);
  assert.equal(dictionary['nodes.scenes.regenerate'].de, 'Neu erzeugen');
  assert.equal(dictionary['nodes.scenes.regenerateSelected'].de, 'Ausgewählte neu erzeugen');
}

function testWiring() {
  const html = read('public/index.html');
  const at = html.indexOf('<script src="nodes/scene-table.js"></script>');
  assert.ok(at > 0, 'index.html loads the table');
  assert.ok(at < html.indexOf('<script src="nodes/inspector.js"></script>'), 'before the inspector');
  const css = read('public/nodes/nodes.css');
  assert.match(css, /\.nv-scene-row\s*\{/);
  assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.nv-scene-row\s*\{/, 'a phone gets its own layout of a row');
  const inspector = read('public/nodes/inspector.js');
  assert.match(inspector, /renderScenes\(runRefs\.scenesEl, runRefs\.nodeId\)/, 'refreshRun draws the table with the run section');
  assert.match(inspector, /cb\.run\.runItems\(nodeId, \[row\.index\]\)/, 'a row makes its item again');
  assert.match(inspector, /cb\.run\.runItems\(nodeId, \[\.\.\.ticked\]\)/, 'the button makes the ticked rows again');
  const controller = read('public/nodes/run.js');
  assert.match(controller, /runItems,\s*\n\s*scenes: scenesOf/, 'the controller hands the table and the run to the inspector');
  // every run, also this one, goes through startRun: plan, confirmation of the cost, budget
  assert.match(controller, /return startRun\(\{ mode: 'items', nodeId, items: request\.items, force: false \}\)/);
}

/* ---------- 2. browser ---------- */

function node(id, type, params = {}, x = 0, y = 0) {
  return { id, type, typeVersion: 1, x, y, params };
}

async function startServer(tmpDir) {
  const express = require('express');
  const registry = require('../lib/nodes/registry');
  const { createEngine } = require('../lib/nodes/engine');
  const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
  const { registerNodeRoutes } = require('../lib/nodes/routes');
  const store = createWorkflowsStore({ dir: path.join(tmpDir, 'workflows') });
  // a paid node that runs here without any provider (a made-up type, 0.10 USD per item): once it has run, the plan calls it 'cached'
  // and the table has to name its price all the same
  registry.registry.register({
    type: 'test.paid_items',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    paid: true,
    cost: { unit: 'usd', estimate: () => 0.1, history: false },
    execute: async (_ctx, inputs) => ({ variants: [{ out: { type: 'text', value: `bezahlt: ${inputs.in.value}` } }], cost: { usd: 0.1 } })
  });
  const engine = createEngine({ store, getConfig: () => ({ imageModel: 'test', videoModel: 'test' }) });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/config', (_req, res) => res.json({ brainModels: [] }));
  registerNodeRoutes(app, {
    publicRuntimeConfig: () => ({ brainModels: [] }),
    engine,
    store,
    registry: registry.registry,
    importScratchDir: path.join(tmpDir, 'scratch'),
    isTurnActive: () => false
  });
  app.use(express.static(path.join(root, 'public')));
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  assert.notEqual(port, 3111);
  return { server, port };
}

function call(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}

async function browserPart() {
  let puppeteer = null;
  try {
    puppeteer = require(path.join(root, 'render-node', 'node_modules', 'puppeteer-core'));
  } catch (_) {
    /* not installed */
  }
  if (!puppeteer || !fs.existsSync(CHROME)) {
    console.log('browser part skipped: puppeteer-core or Chrome not found');
    return;
  }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-scenes-'));
  const { server, port } = await startServer(tmpDir);
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-scenes-chrome-'));
  let browser = null;
  try {
    // a list of three scenes -> a text template (free, runs once per item) -> a single text
    const document = {
      format: 'ocd.workflow',
      version: 1,
      name: 'Szenen-Test',
      description: '',
      graph: {
        nodes: [
          node('list', 'input.text_list', { text: 'Erste Szene\nZweite Szene\nDritte Szene' }, 100, 100),
          node('tpl', 'text.template', { template: 'Szene: {{a}}' }, 500, 100),
          node('one', 'input.text', { text: 'allein' }, 100, 400),
          // a paid node (it cannot run here: its result is put into the results file below, to see what the table says about the price)
          node('rb', 'fal.remove_background', {}, 500, 400),
          node('pd', 'test.paid_items', {}, 900, 100)
        ],
        edges: [
          { id: 'e1', from: { node: 'list', port: 'items' }, to: { node: 'tpl', port: 'a' } },
          { id: 'e2', from: { node: 'list', port: 'items' }, to: { node: 'pd', port: 'in' } }
        ]
      },
      app: {}
    };
    const created = await call(port, 'POST', '/api/workflows', { name: 'Szenen-Test', document });
    assert.equal(created.status, 201, 'workflow created');
    const workflowId = created.json.workflow.id;
    const started = await call(port, 'POST', `/api/workflows/${workflowId}/runs`, { mode: 'selection', nodeIds: ['list', 'tpl', 'one', 'pd'], force: false });
    assert.equal(started.status, 202, `run started: ${JSON.stringify(started.json)}`);
    await waitFor(async () => {
      const loaded = await call(port, 'GET', `/api/workflows/${workflowId}`);
      const nodes = loaded.json && loaded.json.results && loaded.json.results.nodes;
      return nodes && nodes.tpl && nodes.tpl.history.length >= 1 && nodes.one && nodes.pd;
    }, 'the first run');
    const resultsOf = async () => (await call(port, 'GET', `/api/workflows/${workflowId}`)).json.results.nodes;
    const first = (await resultsOf()).tpl.history[0];
    assert.ok(Array.isArray(first.itemKeys) && first.itemKeys.length === 3, 'the engine stored a key per item');

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: userDir, args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'] });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('vcd-lang', 'de');
      } catch (_) {
        /* no storage */
      }
    });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    const posted = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/runs(\/plan)?$/.test(request.url())) posted.push({ url: request.url().replace(/^.*\/api\//, ''), body: JSON.parse(request.postData() || '{}') });
    });

    const open = async (viewport) => {
      await page.setViewport(viewport);
      await page.goto(`http://127.0.0.1:${port}/#w=${workflowId}`, { waitUntil: 'load' });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.OCDNodes && window.OCDNodes.editor && window.OCDNodes.editor.getGraph() && window.OCDNodes.editor.getGraph().nodes.length === 5, { timeout: 20000 });
      await sleep(600);
    };
    const select = async (nodeId) => {
      await page.evaluate((id) => window.OCDNodes.editor.getCanvas().setSelection({ nodes: [id], notes: [], groups: [], edge: null }), nodeId);
      await waitFor(() => page.evaluate((id) => [...window.OCDNodes.editor.getSelection().nodes].join() === id, nodeId), `selection ${nodeId}`);
      await sleep(400);
    };
    const tableState = () =>
      page.evaluate(() => {
        const wrap = document.querySelector('.nv-inspector .nv-scenes');
        if (!wrap) return null;
        const rows = [...wrap.querySelectorAll('.nv-scene-row')].map((row) => ({
          index: row.dataset.index,
          kind: row.dataset.kind,
          number: row.querySelector('.nv-scene-number').textContent,
          text: row.querySelector('.nv-scene-text').textContent,
          hasPreview: Boolean(row.querySelector('.nv-scene-preview .nv-thumb, .nv-scene-preview audio')),
          previewText: (row.querySelector('.nv-scene-preview .nv-thumb') || {}).textContent || '',
          cost: row.querySelector('.nv-scene-cost').textContent,
          buttonDisabled: row.querySelector('.nv-scene-regen').disabled,
          buttonLabel: row.querySelector('.nv-scene-regen').textContent.trim(),
          checked: row.querySelector('.nv-scene-check').checked
        }));
        return {
          heading: wrap.querySelector('.nv-insp-heading').textContent,
          aligned: wrap.dataset.aligned,
          rows,
          selectedButton: { disabled: wrap.querySelector('.nv-scenes-regen-selected').disabled, label: wrap.querySelector('.nv-scenes-regen-selected').textContent.trim() },
          note: Boolean(wrap.querySelector('.nv-scenes-note'))
        };
      });

    /* --- desktop --- */
    await open({ width: 1440, height: 900 });
    await select('tpl');
    const state = await tableState();
    assert.ok(state, 'the table is there for the node that holds a list');
    assert.equal(state.heading, 'Szenen · 3');
    assert.equal(state.aligned, 'true');
    assert.equal(state.note, false, 'no note: the result was made item by item');
    assert.deepEqual(state.rows.map((row) => [row.number, row.kind, row.text, row.buttonLabel, row.buttonDisabled]), [
      ['1', 'text', 'Erste Szene', 'Neu erzeugen', false],
      ['2', 'text', 'Zweite Szene', 'Neu erzeugen', false],
      ['3', 'text', 'Dritte Szene', 'Neu erzeugen', false]
    ], 'a row per item: number, the text of its item, the button');
    assert.deepEqual(state.rows.map((row) => row.previewText), ['Szene: Erste Szene', 'Szene: Zweite Szene', 'Szene: Dritte Szene'], 'the preview is the result of the item');
    assert.ok(state.rows.every((row) => row.hasPreview && row.cost === 'gratis'), 'a preview in every row; a free node says so');
    assert.deepEqual(state.selectedButton, { disabled: true, label: 'Ausgewählte neu erzeugen' }, 'nothing ticked: the button waits');

    const wide = await page.evaluate(() => {
      const row = document.querySelector('.nv-inspector .nv-scene-row');
      return { text: row.querySelector('.nv-scene-text').getBoundingClientRect().width, row: row.getBoundingClientRect().width, inspector: document.querySelector('.nv-inspector').getBoundingClientRect().width };
    });
    assert.ok(wide.text >= 120, `the text of a row has room in the inspector of a desktop (${JSON.stringify(wide)})`);
    // for a look at it: SCENES_SHOTS=<folder> keeps a picture of the page
    if (process.env.SCENES_SHOTS) await page.screenshot({ path: path.join(process.env.SCENES_SHOTS, 'scenes-desktop.png') });

    // no table for a node without a list, nor for the node that holds the list as its setting
    await select('one');
    assert.equal(await tableState(), null, 'no table for a single text');
    await select('list');
    assert.equal(await tableState(), null, 'no table for the input node with the list');
    await select('tpl');

    // one row: the run mode 'items' with this number, plan first
    posted.length = 0;
    await page.click('.nv-scene-row[data-index="1"] .nv-scene-regen');
    await waitFor(async () => (await resultsOf()).tpl.history.length === 2, 'the run of item 2');
    // (the page also plans the whole workflow in the background: those requests are not the ones asked about)
    const itemRequests = () => posted.filter((item) => item.body.mode === 'items');
    assert.deepEqual(itemRequests().map((item) => item.url.replace(/^workflows\/[^/]+\//, '')), ['runs/plan', 'runs'], 'plan, then the run');
    for (const item of itemRequests()) {
      assert.equal(item.body.mode, 'items');
      assert.equal(item.body.nodeId, 'tpl');
      assert.deepEqual(item.body.items, [1], 'the number of the row, counted from 0');
      assert.equal('nodeIds' in item.body, false);
    }
    const afterOne = await resultsOf();
    const second = afterOne.tpl.history[0];
    assert.equal(second.variants[0].text.items.length, 3, 'the new entry holds the whole list');
    assert.deepEqual(second.variants[0].text.items.map((item) => item.value), ['Szene: Erste Szene', 'Szene: Zweite Szene', 'Szene: Dritte Szene']);
    assert.equal(afterOne.tpl.selected.entry, second.id, 'the new entry is the selected one');
    assert.deepEqual(second.itemKeys, first.itemKeys, 'the keys are the same: nothing but the asked item was made again');
    await waitFor(async () => (await tableState()) && !(await tableState()).rows[0].buttonDisabled, 'the buttons are back');

    // ticked rows and the button for them
    await page.click('.nv-scene-row[data-index="0"] .nv-scene-check');
    await page.click('.nv-scene-row[data-index="2"] .nv-scene-check');
    const ticked = await tableState();
    assert.deepEqual(ticked.rows.map((row) => row.checked), [true, false, true]);
    assert.deepEqual(ticked.selectedButton, { disabled: false, label: 'Ausgewählte neu erzeugen (2)' });
    posted.length = 0;
    await page.click('.nv-scenes-regen-selected');
    await waitFor(async () => (await resultsOf()).tpl.history.length === 3, 'the run of the ticked items');
    assert.deepEqual(itemRequests().map((item) => item.body.items), [[0, 2], [0, 2]], 'both ticked rows in one request (plan and run)');
    assert.ok(itemRequests().every((item) => item.body.nodeId === 'tpl'));
    // "select all" ticks and unticks all rows
    await waitFor(async () => {
      const now = await tableState();
      return now && !now.rows[0].buttonDisabled;
    }, 'the buttons are back');
    await page.click('.nv-scenes-all');
    assert.deepEqual((await tableState()).rows.map((row) => row.checked), [true, true, true]);
    assert.equal((await tableState()).selectedButton.label, 'Ausgewählte neu erzeugen (3)');
    await page.click('.nv-scenes-all');
    assert.deepEqual((await tableState()).rows.map((row) => row.checked), [false, false, false]);

    // a result of an older kind (no keys): the rows are there, the buttons are not
    const resultsFile = await findResultsFile(tmpDir, workflowId);
    if (resultsFile) {
      const data = JSON.parse(await fsp.readFile(resultsFile, 'utf8'));
      for (const entry of data.nodes.tpl.history) delete entry.itemKeys;
      const picture = (id) => ({ type: 'image', assetId: id, url: `/api/assets/${id}.png`, mime: 'image/png' });
      data.nodes.rb = {
        history: [{ id: 'seed1', createdAt: Date.now(), variants: [{ image: { type: 'list', itemType: 'image', items: ['a', 'b'].map(picture) } }], itemKeys: ['ka', 'kb'], params: {}, cost: null }],
        selected: { entry: 'seed1', variant: 0 }
      };
      await fsp.writeFile(resultsFile, JSON.stringify(data));
      await open({ width: 1440, height: 900 });
      await select('tpl');
      const old = await tableState();
      assert.equal(old.rows.length, 3, 'the rows are there');
      assert.equal(old.aligned, 'false');
      assert.equal(old.note, true, 'a note says why the buttons wait');
      assert.ok(old.rows.every((row) => row.buttonDisabled), 'no button in a result without keys');
      assert.equal(old.selectedButton.disabled, true);

      // a paid node: the row says what one item costs (or that the price is unknown), never "gratis"; here no key is set, so no button starts
      await select('rb');
      const paid = await tableState();
      assert.ok(paid, 'the table of the paid node');
      assert.equal(paid.rows.length, 2);
      assert.ok(paid.rows.every((row) => /^(kostet ≈ .+|Preis unbekannt)$/.test(row.cost)), `a paid node names a price: ${paid.rows.map((row) => row.cost)}`);
      assert.equal(paid.aligned, 'true');
      await page.click('.nv-scene-row[data-index="0"] .nv-scene-check');
      await page.click('.nv-scene-row[data-index="1"] .nv-scene-check');
      const costs = await page.$eval('.nv-scenes-selected-cost', (item) => item.textContent);
      assert.ok(/^(kostet ≈ .+|Preis unbekannt)$/.test(costs), `the button for the ticked rows names the price of both: ${costs}`);

      // a paid node that has run (the plan calls it 'cached', so it has no estimate of its own): the rows name the real price
      await select('pd');
      const priced = await tableState();
      assert.ok(priced, 'the table of the paid node that has run');
      assert.equal(priced.rows.length, 3);
      assert.equal(priced.aligned, 'true');
      assert.ok(priced.rows.every((row) => /^kostet ≈ .*0[.,]10/.test(row.cost)), `each row names the price of one item: ${priced.rows.map((row) => row.cost)}`);
      await page.click('.nv-scene-row[data-index="0"] .nv-scene-check');
      await page.click('.nv-scene-row[data-index="2"] .nv-scene-check');
      const pricedBoth = await page.$eval('.nv-scenes-selected-cost', (item) => item.textContent);
      assert.ok(/^kostet ≈ .*0[.,]20/.test(pricedBoth), `the button for the ticked rows names the price of two items: ${pricedBoth}`);
    } else {
      console.log('SKIP older result: the results file was not found');
    }

    /* --- phone --- */
    await open({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await select('tpl');
    const phone = await page.evaluate(() => {
      const wrap = document.querySelector('.nv-inspector .nv-scenes');
      if (!wrap) return null;
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const row = wrap.querySelector('.nv-scene-row');
      return {
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        wrap: box(wrap),
        row: box(row),
        button: box(row.querySelector('.nv-scene-regen')),
        text: box(row.querySelector('.nv-scene-text')),
        preview: box(row.querySelector('.nv-scene-preview'))
      };
    });
    if (process.env.SCENES_SHOTS) await page.screenshot({ path: path.join(process.env.SCENES_SHOTS, 'scenes-phone.png') });
    assert.ok(phone, 'the table is there on a phone');
    assert.ok(phone.scrollWidth <= phone.viewport, `no sideways scrolling on a phone (${phone.scrollWidth} > ${phone.viewport})`);
    assert.ok(phone.row.right <= phone.viewport + 0.5 && phone.row.left >= -0.5, `the row fits the screen: ${JSON.stringify(phone.row)}`);
    assert.ok(phone.button.top >= phone.text.bottom - 1, 'the button stands on a line of its own under the text');
    assert.ok(phone.button.height >= 32, `the button is big enough to touch (${phone.button.height})`);
    assert.ok(phone.button.width >= phone.row.width * 0.6, 'and wide');
    assert.ok(phone.preview.width >= 48 && phone.preview.height >= 36, 'the preview is still there');

    assert.deepEqual(problems, [], `no page errors: ${problems.join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}

// the file in which the engine keeps the results of a workflow of the test server (its folder is the workflows folder of the store)
async function findResultsFile(dir, workflowId) {
  const found = [];
  const walk = async (current, depth) => {
    if (depth > 4) return;
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/results\.json$/.test(entry.name) && full.includes(workflowId)) found.push(full);
    }
  };
  await walk(dir, 0);
  return found[0] || null;
}

async function main() {
  testRows();
  testWhereThereIsATable();
  testRequestAndCost();
  testWords();
  testWiring();
  await browserPart();
  console.log('test-nodes-scenes.js: ok');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
