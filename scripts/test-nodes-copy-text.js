'use strict';

// Text selected outside the canvas is copied as text. A node stays selected on the canvas while the person marks a
// sentence in an answer of the assistant and presses Cmd+C: the browser has to copy that sentence, not the node as
// clipboard JSON. Cut and delete leave the node alone as well. A press on the canvas ends the text selection, and
// copy and delete work on the nodes again. Two parts:
//   1. the wiring in public/nodes/main.js, checked as text
//   2. in a real browser (puppeteer-core from render-node/node_modules, Chrome) with an assistant whose answer is mocked:
//      real clicks, a triple click on the answer, real key events
// The server is a small one of its own: a temporary data folder, a free port (never 3111), no model call and no paid call.
// The system clipboard is never touched: the page's clipboard function is replaced and no native copy command runs.
// Without Chrome or puppeteer-core the browser part is skipped with a note.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ANSWER = [
  'Here are three prompts for an autumn video.',
  'Cinematic wide shot of a lake in late autumn, golden leaves on a pale stony shore, soft natural light, no text.',
  'A couple walking slowly along the shore at sunset, seen from behind, warm muted tones, subtle film grain.'
].join('\n\n');

/* ---------- 1. wiring ---------- */

function testWiring() {
  const source = read('public/nodes/main.js');
  assert.match(source, /function textSelectedOutsideCanvas\(\)/, 'helper for a text selection outside the canvas');
  const keyDown = source.slice(source.indexOf('function onKeyDown('), source.indexOf('function onKeyUp('));
  assert.ok(keyDown.length > 100, 'onKeyDown found');
  assert.match(keyDown, /lower === 'c'\) \{\s*if \(textSelectedOutsideCanvas\(\)\) return;[^\n]*\n\s*if \(copySelection\(\)\)/, 'copy leaves selected text to the browser');
  assert.match(keyDown, /lower === 'x'\) \{\s*if \(textSelectedOutsideCanvas\(\)\) return;/, 'cut leaves the nodes alone');
  assert.match(keyDown, /key === 'Backspace'\) \{\s*if \(textSelectedOutsideCanvas\(\)\) return;\s*event\.preventDefault\(\);\s*deleteSelection\(\);/, 'delete leaves the nodes alone');
  assert.match(source, /dom\.canvasHost\.addEventListener\('pointerdown', \(\) => \{\s*if \(textSelectedOutsideCanvas\(\)\) global\.getSelection\(\)\.removeAllRanges\(\);\s*\}, true\);/, 'a press on the canvas ends the text selection');
}

/* ---------- 2. browser ---------- */

async function startServer(tmpDir) {
  const express = require('express');
  const registry = require('../lib/nodes/registry');
  const { createEngine } = require('../lib/nodes/engine');
  const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
  const { registerNodeRoutes } = require('../lib/nodes/routes');
  const store = createWorkflowsStore({ dir: path.join(tmpDir, 'workflows') });
  const engine = createEngine({ store, getConfig: () => ({ imageModel: 'test', videoModel: 'test' }) });
  const runtime = { brainModels: ['chatgpt/test'], defaultBrain: 'chatgpt/test' };
  const asked = [];
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/config', (_req, res) => res.json(runtime));
  registerNodeRoutes(app, {
    publicRuntimeConfig: () => runtime,
    engine,
    store,
    registry: registry.registry,
    importScratchDir: path.join(tmpDir, 'scratch'),
    isTurnActive: () => false,
    // the model of the assistant is mocked: no call leaves this process
    assistantComplete: async (options) => {
      asked.push(options.model);
      return { text: JSON.stringify({ answer: ANSWER, mentions: [] }), usd: 0, billing: 'Abo', usage: null, model: options.model };
    },
    assistantLog: () => {}
  });
  app.use(express.static(path.join(root, 'public')));
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  assert.notEqual(port, 3111);
  return { server, port, asked };
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

async function main() {
  testWiring();

  let puppeteer = null;
  try {
    puppeteer = require(path.join(root, 'render-node', 'node_modules', 'puppeteer-core'));
  } catch (_) {
    /* not installed */
  }
  if (!puppeteer || !fs.existsSync(CHROME)) {
    console.log('browser part skipped: puppeteer-core or Chrome not found');
    console.log('test-nodes-copy-text.js: ok');
    return;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-copy-text-'));
  const { server, port, asked } = await startServer(tmpDir);
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-copy-text-chrome-'));
  let browser = null;
  try {
    const document = {
      format: 'ocd.workflow',
      version: 1,
      name: 'Kopier-Test',
      description: '',
      graph: { nodes: [{ id: 'img', type: 'image.generate', typeVersion: 1, x: 120, y: 160, params: {} }], edges: [] },
      app: {}
    };
    const created = await post(port, '/api/workflows', { name: 'Kopier-Test', document });
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
    await page.waitForFunction(() => window.OCDNodes && window.OCDNodes.editor && window.OCDNodes.editor.getGraph() && window.OCDNodes.editor.getGraph().nodes.length === 1, { timeout: 20000 });
    await sleep(400);

    // What the node view does with a key: a listener on the window runs after the one of the node view on the document
    // and sees whether it took the key (defaultPrevented). Writes to the clipboard are recorded instead of done.
    await page.evaluate(() => {
      window.__keys = [];
      window.__writes = [];
      window.addEventListener('keydown', (event) => window.__keys.push({ key: event.key, prevented: event.defaultPrevented }));
      const fake = (text) => {
        window.__writes.push(String(text));
        return Promise.resolve();
      };
      if (navigator.clipboard) navigator.clipboard.writeText = fake;
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: fake }, configurable: true });
    });
    const lastKey = () => page.evaluate(() => window.__keys[window.__keys.length - 1]);
    const writes = () => page.evaluate(() => window.__writes.slice());
    const nodeCount = () => page.evaluate(() => window.OCDNodes.editor.getGraph().nodes.length);
    const selectedText = () => page.evaluate(() => String(window.getSelection()));
    const chord = async (key) => {
      await page.keyboard.down('Meta');
      await page.keyboard.press(key);
      await page.keyboard.up('Meta');
      await sleep(80);
    };
    const clickNode = async () => {
      const box = await (await page.$('.nv-node[data-id="img"] .nv-node-title')).boundingBox();
      await page.mouse.click(box.x + 4, box.y + box.height / 2);
      await page.waitForFunction(() => [...window.OCDNodes.editor.getSelection().nodes].join() === 'img', { timeout: 5000 });
      await sleep(150);
    };

    /* --- the node is selected and the canvas has the focus: Cmd+C copies the node --- */
    await clickNode();
    await chord('c');
    assert.equal((await lastKey()).prevented, true, 'with the canvas in use, Cmd+C is the copy of the node');
    let written = await writes();
    assert.equal(written.length, 1, 'the node went to the clipboard');
    assert.equal(JSON.parse(written[0]).format, 'ocd.clipboard', 'as clipboard JSON');

    /* --- the assistant answers; the node stays selected --- */
    await page.click('.nv-assistant-btn');
    await page.waitForSelector('.nv-asst-input', { visible: true, timeout: 5000 });
    await page.focus('.nv-asst-input');
    await page.keyboard.type('Gib mir drei Prompts fuer ein Herbstvideo');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.nv-asst-msg.is-bot p.nv-asst-text').length >= 3, { timeout: 10000 });
    assert.deepEqual(asked, ['chatgpt/test'], 'the mocked model answered once');
    assert.equal(await page.evaluate(() => [...window.OCDNodes.editor.getSelection().nodes].join()), 'img', 'the node is still selected');

    /* --- a sentence of the answer is marked with the mouse: Cmd+C leaves it to the browser --- */
    const paragraph = (await page.$$('.nv-asst-msg.is-bot p.nv-asst-text'))[1];
    const box = await paragraph.boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2, { count: 3 });
    await sleep(120);
    assert.match(await selectedText(), /Cinematic wide shot of a lake/, 'the sentence is selected');
    await chord('c');
    assert.equal((await lastKey()).prevented, false, 'Cmd+C on selected text is left to the browser (it copies the text)');
    assert.equal((await writes()).length, 1, 'no clipboard JSON of the node');
    assert.match(await selectedText(), /Cinematic wide shot of a lake/, 'the text stays selected');

    /* --- cut and delete keep the node while text is selected --- */
    await chord('x');
    assert.equal((await lastKey()).prevented, false, 'Cmd+X on selected text is left to the browser');
    assert.equal(await nodeCount(), 1, 'Cmd+X did not cut the node');
    await page.keyboard.press('Backspace');
    await sleep(80);
    assert.equal((await lastKey()).prevented, false, 'Backspace on selected text is left to the browser');
    assert.equal(await nodeCount(), 1, 'Backspace did not delete the node');
    assert.equal((await writes()).length, 1, 'still no clipboard JSON');

    /* --- a press on the canvas ends the text selection; the keys work on the node again --- */
    await clickNode();
    assert.equal((await selectedText()).trim(), '', 'the press on the canvas ended the text selection');
    await chord('c');
    assert.equal((await lastKey()).prevented, true, 'Cmd+C copies the node again');
    written = await writes();
    assert.equal(written.length, 2, 'a second copy of the node');
    assert.equal(JSON.parse(written[1]).nodes[0].type, 'image.generate', 'the copied node');
    await page.keyboard.press('Backspace');
    await sleep(120);
    assert.equal(await nodeCount(), 0, 'Backspace deletes the selected node again');

    assert.deepEqual(problems, [], `no page errors: ${problems.join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log('test-nodes-copy-text.js: ok');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
