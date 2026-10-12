'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const preview = require('../lib/event-video/card-preview');
const composition = require('../lib/event-video/composition');
const view = require('../lib/event-video/view');
const { textFields } = require('../lib/event-video/text-overrides');
const graphics = JSON.parse(fs.readFileSync(path.join(__dirname, 'support/event-video/graphics-60.json'), 'utf8'));
const patch = (values) => JSON.stringify({ base: JSON.stringify(textFields(graphics).map(({ path, value }) => [path, value])), values });

// The documents as the client shows them: fonts and logo put into their slots (public/nodes/app-mode.js)
function built(...args) {
  const answer = preview.buildPreviews(...args);
  const fill = (doc) => doc && doc.replace(answer.slots.fonts, () => answer.fonts).replace(answer.slots.logo, () => answer.logo || '');
  return answer.previews.map((item) => ({ ...item, title: fill(item.title), endcard: fill(item.endcard) }));
}

function testDocuments() {
  const corrected = preview.correctedGraphics(graphics, patch({ 'title.text': 'A corrected title', 'endcard.line': 'Thanks for joining us today' }));
  const before = JSON.stringify(corrected);
  const previews = built(corrected);
  const answer = preview.buildPreviews(corrected);
  assert.equal(answer.fonts, composition.fontFaces(composition.fontFamilies(corrected)));
  for (const item of answer.previews) {
    for (const html of [item.title, item.endcard]) assert.ok(html.includes(answer.slots.fonts) && !html.includes('data:font'), 'the fonts go once with the answer, not in every document');
  }
  assert.deepEqual(previews.map((item) => item.format), ['16:9', '1:1', '9:16']);
  for (const item of previews) {
    const data = composition.pageData({ graphics: corrected, format: item.format, chunk: { start: 0, duration: corrected.duration } });
    const title = view.render(data, data.title.end - view.OUT_SECONDS).title;
    const end = view.render(data, data.endcard.start + 1.1).end;
    assert.ok(item.title.includes(title), 'same title lines, sizes, placement and styling as the render');
    assert.ok(item.endcard.includes(end), 'same end-card lines and sizes as the render');
    for (const html of [item.title, item.endcard]) {
      assert.ok(html.includes(composition.fontFaces(composition.fontFamilies(corrected))), 'same embedded font bytes');
      assert.ok(html.includes(composition.STYLE), 'same layout styles');
      assert.doesNotMatch(html, /<script\b|<video\b|\b(?:src|href)=["'](?:https?:|\/\/)|url\(["']?(?:https?:|\/\/)/i);
      assert.match(html, /default-src 'none'/);
      assert.match(html, new RegExp(`viewBox="0 0 ${data.width} ${data.height}"`));
    }
  }
  for (const anim of Object.keys(require('../lib/event-video/contract').TITLE_ANIMS)) {
    const short = structuredClone(graphics);
    short.title = { ...short.title, anim, end: short.title.start + 0.1 };
    for (const item of built(short)) {
      assert.match(item.title, /class="title"/);
      assert.doesNotMatch(item.title, /opacity:0(?:[;"}])/, `${anim}: held title is fully visible even with a short span`);
    }
  }
  for (const family of Object.keys(composition.FONT_FILES)) {
    const styled = structuredClone(graphics);
    styled.look.type.title = `${family}:400`;
    const checked = require('../lib/event-video/contract').checkGraphics(styled);
    if (!checked.ok) continue; // some stand-in files are not selectable families
    const item = built(styled)[0];
    assert.ok(item.title.includes(composition.fontFaces(composition.fontFamilies(styled))));
  }
  assert.equal(JSON.stringify(corrected), before, 'preview does not mutate a plan');
  assert.notEqual(graphics.title.text, corrected.title.text);
  for (const payload of ['<script>alert(1)</script>', '"><img onerror=alert(1)>', '</style><img src=x>']) {
    const value = preview.correctedGraphics(graphics, patch({ 'title.text': payload, 'endcard.line': payload, 'endcard.url': payload }));
    for (const item of built(value)) {
      for (const html of [item.title, item.endcard]) {
        assert.doesNotMatch(html, /<script|<img|<\/style><img/i);
        assert.ok(html.includes('&lt;'), 'text is escaped');
        assert.equal((html.match(/<\/style>/g) || []).length, 1, 'user text cannot leave style');
      }
    }
  }
  for (const missing of ['title', 'endcard']) {
    const noSection = structuredClone(graphics);
    noSection[missing] = null;
    for (const item of built(noSection)) assert.equal(item[missing], undefined);
    const raw = JSON.stringify({ base: JSON.stringify(textFields(noSection).map(({ path, value }) => [path, value])), values: {} });
    assert.deepEqual(preview.correctedGraphics(noSection, raw), noSection);
  }
  const empty = { ...graphics, title: null, endcard: null };
  assert.ok(built(empty).every((item) => !item.title && !item.endcard));
  assert.throws(() => built(graphics, 'https://example.invalid/logo.png'));
  for (const raw of [null, 12, {}, 'null', '{', patch({ 'title.text': '' }), patch({ 'title.text': 'x'.repeat(29) }), patch({ 'look.accent': '</style>' })]) {
    assert.throws(() => preview.correctedGraphics(graphics, raw), (err) => err.code === 'EVENTRENDER_TEXT_INVALID');
  }
  assert.throws(() => preview.correctedGraphics(graphics, JSON.stringify({ base: '[]', values: {} })), (err) => err.code === 'CARD_PREVIEW_UNAVAILABLE');
}

async function testRoute() {
  const access = require('../lib/access');
  const originalViewer = access.viewerOf;
  access.viewerOf = (req) => ({ active: true, email: req.email, role: 'internal', admin: false });
  const { registerNodeRoutes } = require('../lib/nodes/routes');
  const workflow = { id: 'flow', sessionId: 'session', owner: 'owner@example.test', shareMode: 'private', graph: {
    nodes: [{ id: 'planner', type: 'event_video.plan' }, { id: 'render', type: 'event_video.render' }, { id: 'other', type: 'input.text' }],
    edges: [{ from: { node: 'planner', port: 'graphics' }, to: { node: 'render', port: 'graphics' } }]
  } };
  const results = { nodes: { planner: { selected: { entry: 'entry', variant: 1 }, history: [{ id: 'entry', variants: [{}, { graphics: { type: 'text', value: JSON.stringify(graphics) } }] }] } } };
  const before = JSON.stringify({ workflow, results });
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (url, fn) => handlers.set(`${method} ${url}`, fn)]));
  let reads = 0;
  registerNodeRoutes(app, { store: { readWorkflow: async () => workflow, getWorkflow: async () => { reads++; return { workflow, results }; } }, engine: {} });
  const handler = handlers.get('post /api/workflows/:id/nodes/:nodeId/card-preview');
  const request = async (body = {}, nodeId = 'render', email = workflow.owner) => {
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await handler({ params: { id: 'flow', nodeId }, body, email }, res);
    return res;
  };
  try {
    assert.equal((await request({}, 'render', 'outsider@example.test')).statusCode, 404);
    assert.equal(reads, 0, 'access is checked before reading results');
    assert.equal((await request({}, 'missing')).statusCode, 404);
    assert.equal((await request({}, 'other')).statusCode, 409);
    const invalid = await request({ text_overrides: patch({ 'title.text': '' }) });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, 'EVENTRENDER_TEXT_INVALID');
    assert.equal((await request({ text_overrides: 'x'.repeat(65536) })).statusCode, 413);
    const stale = JSON.stringify({ ...JSON.parse(patch({ 'title.text': 'Old title' })), plan: 'old-entry' });
    assert.equal((await request({ text_overrides: stale })).statusCode, 409, 'new plan discards old corrections even with identical texts');
    const ok = await request({ text_overrides: patch({ 'title.text': 'Route title' }) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal(ok.body.previews.length, 3);
    assert.match(ok.body.previews[0].title, />Route<\/span> <span[^>]*>title<\/span>/);
    assert.equal(JSON.stringify({ workflow, results }), before, 'no workflow, results or run changes');
    results.nodes.planner.selected.entry = 'absent';
    assert.equal((await request()).statusCode, 409);
  } finally { access.viewerOf = originalViewer; }
}

async function testLogo() {
  const os = require('os');
  const fsp = require('fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'card-logo-'));
  try {
    const file = path.join(dir, 'logo.png');
    await fsp.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const workflow = { sessionId: 'session', graph: { nodes: [{ id: 'logo', type: 'input.image', params: { asset: { assetId: 'logo' } } }], edges: [{ from: { node: 'logo', port: 'image' }, to: { node: 'render', port: 'logo' } }] } };
    const graphic = { ...graphics, endcard: { ...graphics.endcard, logo: true } };
    const sessions = { readLedger: async () => [{ id: 'logo' }] };
    const assets = { assetRefFromParam: () => ({ sessionId: 'session', assetId: 'logo' }), valueFromLedgerEntry: () => ({ sessionId: 'session', type: 'image', assetId: 'logo' }), assetFilePath: () => file };
    const logo = await preview.logoDataUrl(workflow, {}, { id: 'render' }, graphic, assets, sessions);
    assert.match(logo, /^data:image\/png;base64,/);
    assert.ok(built(graphic, logo).every((item) => item.endcard.includes(`src="${logo}"`)));
    const selectedLogo = { sessionId: 'session', type: 'image', assetId: 'run-logo' };
    const results = { nodes: { logo: { selected: { entry: 'run', variant: 1 }, history: [{ id: 'run', variants: [{ image: { ...selectedLogo, assetId: 'other-variant' } }, { image: selectedLogo }] }] } } };
    const originalPath = assets.assetFilePath;
    assets.assetFilePath = (value) => { assert.equal(value, selectedLogo, 'selected run override wins over the saved asset'); return file; };
    const originalLedger = sessions.readLedger;
    sessions.readLedger = async () => { throw new Error('selected input must not fall back to the saved asset'); };
    assert.equal(await preview.logoDataUrl(workflow, results, { id: 'render' }, graphic, assets, sessions), logo);
    selectedLogo.sessionId = 'foreign';
    assert.equal(await preview.logoDataUrl(workflow, results, { id: 'render' }, graphic, assets, sessions), null, 'foreign selected assets are never read or replaced with a saved logo');
    sessions.readLedger = originalLedger;
    assets.assetFilePath = originalPath;
    await fsp.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await assert.rejects(() => preview.logoDataUrl(workflow, {}, { id: 'render' }, graphic, assets, sessions), (err) => err.code === 'CARD_PREVIEW_UNAVAILABLE');
    assets.assetRefFromParam = () => ({ sessionId: 'foreign', assetId: 'logo' });
    assets.assetFilePath = () => { throw new Error('foreign file must never be read'); };
    await assert.rejects(() => preview.logoDataUrl(workflow, {}, { id: 'render' }, graphic, assets, sessions), (err) => err.code === 'CARD_PREVIEW_UNAVAILABLE');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

(async () => { testDocuments(); await testLogo(); await testRoute(); console.log('test-event-video-card-preview.js: ok'); })().catch((err) => { console.error(err); process.exitCode = 1; });
