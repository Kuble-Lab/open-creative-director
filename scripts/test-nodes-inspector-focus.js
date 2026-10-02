'use strict';

// Typing in the inspector of the node view never loses the focus. Two parts:
//   1. the logic without a browser: which fields depend on the value of another param (graph.js) and that the form of the
//      inspector is not rebuilt for them (inspector.js, checked as text)
//   2. in a real browser (puppeteer-core from render-node/node_modules, Chrome): characters are typed one by one into
//      "Song text and structure" of the music node, into its description, into the HTML of a motion graphics node, and a mode
//      is chosen in the crop node. The field keeps the focus, the whole text arrives, dependent displays follow in place.
// The server is a small one of its own: a temporary data folder, a free port (never 3111), no paid calls. Without Chrome or
// puppeteer-core the browser part is skipped with a note.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const graphLib = require('../public/nodes/graph');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ---------- 1. logic ---------- */

function testGraphHelpers() {
  const onPlan = { all: [{ ports: ['plan', 'match'], connected: false }, { param: 'plan', empty: true }] };
  assert.equal(graphLib.dependsOnParam(onPlan), true);
  assert.equal(graphLib.dependsOnParam({ param: 'mode', equals: 'pixels' }), true);
  assert.equal(graphLib.dependsOnParam({ port: 'plan', connected: false }), false);
  assert.equal(graphLib.dependsOnParam({ ports: ['a', 'b'], connected: true }), false);
  assert.equal(graphLib.dependsOnParam(undefined), false);

  const def = { params: [{ id: 'plan', kind: 'textarea', default: '' }] };
  const typed = { id: 'n', params: { plan: 'x' } };
  const empty = { id: 'n', params: { plan: '' } };
  // the value of the song text decides ...
  assert.equal(graphLib.isVisible(onPlan, typed, def, new Set()), false);
  assert.equal(graphLib.isVisible(onPlan, empty, def, new Set()), true);
  // ... unless only the connections are asked: then it is the same before and after the first character
  assert.equal(graphLib.isVisible(onPlan, typed, def, new Set(), { ignoreParams: true }), true);
  assert.equal(graphLib.isVisible(onPlan, empty, def, new Set(), { ignoreParams: true }), true);
  assert.equal(graphLib.isVisible(onPlan, empty, def, new Set(['plan']), { ignoreParams: true }), false);
  assert.equal(graphLib.isVisible(onPlan, empty, def, new Set(['match']), { ignoreParams: true }), false);
}

function testInspectorWiring() {
  const source = read('public/nodes/inspector.js');
  // the signature of the form (what rebuilds it) leaves the value conditions out
  assert.match(source, /isVisible\(p\.showIf, node, def, new Set\([^\n]*\{ ignoreParams: true \}\)/, 'signature ignores conditions on param values');
  // fields that depend on a value are built and shown or hidden in place
  assert.match(source, /function applyGates\(/);
  assert.match(source, /dependsOnParam\(param\.showIf\)/);
  // a rebuild keeps the field with the focus, its cursor and the scroll position
  assert.match(source, /function captureFocus\(/);
  assert.match(source, /function restoreFocus\(/);
  assert.match(source, /restoreFocus\(saved\)/);
  assert.ok(!/innerHTML/.test(source.replace(/\/\/[^\n]*/g, '')), 'no innerHTML in the inspector');
  assert.match(read('public/nodes/nodes.css'), /\.nv-field\[hidden\]/);
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

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: route, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SONG = '[Intro | 10 s]\n+ soft piano\n\n[Strophe | 0:30]\nWir gehen durch die Nacht und singen leise.';
const DESCRIPTION = 'Ruhiger Lo-Fi Beat fuer den Abend';
const MOTION_HTML = '<div id="stage">Titel</div>';

async function main() {
  testGraphHelpers();
  testInspectorWiring();

  let puppeteer = null;
  try {
    puppeteer = require(path.join(root, 'render-node', 'node_modules', 'puppeteer-core'));
  } catch (_) {
    /* not installed */
  }
  if (!puppeteer || !fs.existsSync(CHROME)) {
    console.log('browser part skipped: puppeteer-core or Chrome not found');
    console.log('test-nodes-inspector-focus.js: ok');
    return;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-inspector-focus-'));
  const { server, port } = await startServer(tmpDir);
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-inspector-chrome-'));
  let browser = null;
  try {
    const document = {
      format: 'ocd.workflow',
      version: 1,
      name: 'Fokus-Test',
      description: '',
      graph: {
        nodes: [
          node('music', 'audio.music', {}, 100, 100),
          node('motion', 'video.motion_graphics', {}, 600, 100),
          node('crop', 'image.crop', { mode: 'aspect' }, 1100, 100)
        ],
        edges: []
      },
      app: {}
    };
    const created = await post(port, '/api/workflows', { name: 'Fokus-Test', document });
    assert.equal(created.status, 201, 'workflow created');
    const workflowId = created.json.workflow.id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: userDir, args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('vcd-lang', 'de');
      } catch (_) {
        /* no storage */
      }
    });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    await page.goto(`http://127.0.0.1:${port}/#w=${workflowId}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.OCDNodes && window.OCDNodes.editor && window.OCDNodes.editor.getGraph() && window.OCDNodes.editor.getGraph().nodes.length === 3, { timeout: 20000 });
    await sleep(500);

    const select = async (nodeId) => {
      // a real click on the head of the card selects it the way a person does; the card is scrolled into view first
      await page.evaluate((id) => document.querySelector(`.nv-node[data-id="${id}"]`).scrollIntoView({ block: 'center', inline: 'center' }), nodeId);
      const box = await (await page.$(`.nv-node[data-id="${nodeId}"] .nv-node-title`)).boundingBox();
      await page.mouse.click(box.x + 4, box.y + box.height / 2);
      await page.waitForFunction((id) => [...window.OCDNodes.editor.getSelection().nodes].join() === id, { timeout: 5000 }, nodeId).catch(async () => {
        throw new Error(`card ${nodeId} not selected; box ${JSON.stringify(box)}, selection ${JSON.stringify(await page.evaluate(() => [...window.OCDNodes.editor.getSelection().nodes]))}`);
      });
      await sleep(250);
    };
    const inspectorField = (label) => `.nv-inspector [aria-label="${label}"]`;
    const state = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return { tag: a && a.tagName, label: a && a.getAttribute('aria-label'), inInspector: Boolean(a && a.closest('.nv-inspector')), value: a && 'value' in a ? a.value : null };
      });

    // Types one character at a time (real key events); the focus is checked after every character.
    async function typeSlowly(label, text, field) {
      await page.focus(field);
      for (const ch of text) {
        if (ch === '\n') await page.keyboard.press('Enter');
        else await page.keyboard.type(ch);
        const now = await state();
        assert.equal(now.inInspector && now.label, label, `focus stays in "${label}" after typing "${ch === '\n' ? '\\n' : ch}" (is in ${JSON.stringify(now)})`);
      }
    }

    /* --- music node: song text --- */
    await select('music');
    const labels = await page.$$eval('.nv-inspector .nv-insp-fields textarea, .nv-inspector .nv-insp-fields input, .nv-inspector .nv-insp-fields select', (items) => items.map((item) => item.getAttribute('aria-label')));
    assert.ok(labels.length >= 2, `fields of the music node: ${labels}`);
    const [promptLabel, planFieldLabel] = labels;
    const songDe = await page.evaluate(() => window.OCDNodes.ui.paramLabel('plan'));
    assert.equal(planFieldLabel, songDe, 'second field is the song text');

    // the length field is there while the song text is empty
    const lengthVisible = () =>
      page.evaluate(() => {
        const fields = [...document.querySelectorAll('.nv-inspector .nv-insp-fields > .nv-field')].filter((f) => !f.hidden);
        const text = fields.map((f) => (f.querySelector('.nv-field-label') || {}).textContent);
        return { text, hasLengthInput: fields.some((f) => f.querySelector('input[type="number"]')), hasNote: fields.some((f) => f.querySelector('.nv-length-note') && !f.querySelector('.nv-length-note').hidden) };
      });
    assert.equal((await lengthVisible()).hasLengthInput, true, 'length field visible while the song text is empty');

    const planField = inspectorField(planFieldLabel);
    // the structure of the form is the same before and after the first character: the very same textarea element stays
    await page.evaluate((sel) => { window.__planEl = document.querySelector(sel); }, planField);
    await typeSlowly(planFieldLabel, SONG, planField);
    assert.equal((await state()).value, SONG, 'the whole song text arrived');
    assert.equal(await page.evaluate((sel) => document.querySelector(sel) === window.__planEl, planField), true, 'the song text field was not rebuilt');
    const afterPlan = await lengthVisible();
    assert.equal(await page.$eval('.nv-inspector .nv-plan-check', (item) => item.classList.contains('is-ok')), true, 'the check under the song text follows the typing (2 sections, 40 s)');
    assert.equal(afterPlan.hasLengthInput, false, 'length field hidden once there is a song text');
    assert.equal(afterPlan.hasNote, true, 'the line about where the length comes from is shown instead');
    assert.equal(await page.evaluate(() => window.OCDNodes.editor.getGraph().nodes.find((n) => n.id === 'music').params.plan), SONG, 'the song text is in the graph');

    // emptying the field shows the length field again, still without losing the focus
    await page.evaluate((sel) => document.querySelector(sel).select(), planField);
    await page.keyboard.press('Backspace');
    assert.equal((await state()).value, '', 'the song text is empty');
    assert.equal((await state()).label, planFieldLabel, 'focus stays after emptying the song text');
    assert.equal((await lengthVisible()).hasLengthInput, true, 'length field is back when the song text is empty');

    /* --- music node: description (validation and estimate follow) --- */
    await typeSlowly(promptLabel, DESCRIPTION, inspectorField(promptLabel));
    assert.equal((await state()).value, DESCRIPTION, 'the whole description arrived');

    /* --- motion graphics node: HTML (the button next to the label follows the text) --- */
    await select('motion');
    const htmlLabel = await page.evaluate(() => window.OCDNodes.ui.paramLabel('html'));
    await typeSlowly(htmlLabel, MOTION_HTML, inspectorField(htmlLabel));
    assert.equal((await state()).value, MOTION_HTML, 'the whole HTML arrived');
    assert.equal(await page.evaluate(() => window.OCDNodes.editor.getGraph().nodes.find((n) => n.id === 'motion').params.html), MOTION_HTML, 'the HTML is in the graph');

    /* --- crop node: a mode shows other fields in place --- */
    await select('crop');
    const fieldLabels = () =>
      page.evaluate(() => [...document.querySelectorAll('.nv-inspector .nv-insp-fields > .nv-field')].filter((f) => !f.hidden).map((f) => (f.querySelector('.nv-field-label') || {}).textContent));
    const before = await fieldLabels();
    const xLabel = await page.evaluate(() => window.OCDNodes.ui.paramLabel('x'));
    assert.ok(!before.includes(xLabel), `no "${xLabel}" field in aspect mode (${before})`);
    const modeLabel = await page.evaluate(() => window.OCDNodes.ui.paramLabel('mode'));
    await page.evaluate((sel) => { window.__modeEl = document.querySelector(sel); }, inspectorField(modeLabel));
    await page.select(inspectorField(modeLabel), 'pixels');
    await sleep(200);
    const afterMode = await fieldLabels();
    assert.ok(afterMode.includes(xLabel), `"${xLabel}" shows in pixel mode (${afterMode})`);
    assert.equal(await page.evaluate((sel) => document.querySelector(sel) === window.__modeEl, inspectorField(modeLabel)), true, 'the mode field was not rebuilt');
    // a number typed into a field that appeared keeps its focus
    await page.focus(inspectorField(xLabel));
    await page.evaluate((sel) => document.querySelector(sel).select(), inspectorField(xLabel));
    for (const ch of '120') {
      await page.keyboard.type(ch);
      assert.equal((await state()).label, xLabel, `focus stays in the number field after "${ch}"`);
    }
    assert.equal((await state()).value, '120', 'the number arrived');
    assert.equal((await state()).label, xLabel, 'focus stays in the number field');

    /* --- a rebuild (here forced) keeps field, cursor and scroll position --- */
    await select('music');
    await page.focus(inspectorField(planFieldLabel));
    await page.keyboard.type(SONG);
    await page.evaluate((sel) => {
      const area = document.querySelector(sel);
      area.setSelectionRange(5, 9);
    }, inspectorField(planFieldLabel));
    await page.evaluate(() => {
      // forced rebuild: what a changed signature does (a connection, the description of the model arriving)
      const editor = window.OCDNodes.editor;
      editor.getInspector().render({ graph: editor.getGraph(), selection: { nodes: new Set(['music']), notes: new Set(), groups: new Set(), edge: null }, workflow: editor.getWorkflow() }, { force: true });
    });
    const rebuilt = await page.evaluate((sel) => {
      const area = document.querySelector(sel);
      return { focused: document.activeElement === area, start: area.selectionStart, end: area.selectionEnd, value: area.value };
    }, inspectorField(planFieldLabel));
    assert.equal(rebuilt.focused, true, 'a rebuilt form gives the focus back to the same field');
    assert.deepEqual([rebuilt.start, rebuilt.end], [5, 9], 'and the selection');
    assert.equal(rebuilt.value, SONG, 'and keeps the text');

    assert.deepEqual(problems, [], `no page errors: ${problems.join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log('test-nodes-inspector-focus.js: ok');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
