'use strict';

// The interface side of 3D results (WP32): the bundled <model-viewer> (files, licence, integrity note, loaded only on demand,
// no entry in package.json), the 3D view in the node card, the large view and the history tile (public/nodes/preview.js, run
// against a small stand-in for the DOM), the model list of the node "Image to 3D" in the page (labels, prices, views,
// limits, marks for models that do not fit), the send dialog and the picker for the new kind, and where the estimate of
// Hunyuan is a number (the plan, the card and the gallery know the connections).
//
// No browser, no provider: the pieces of the page run in vm contexts without a DOM; lib/fal.js is never called.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');
const engine = require('../lib/nodes/engine');
const nodesFal = require('../lib/nodes/nodes-fal');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects of a vm have another prototype
const VENDOR = 'public/vendor/model-viewer';

/* ---------- a stand-in for the DOM: just what node-ui.js and preview.js touch ---------- */

class FakeNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.textValue = '';
    this.classes = new Set();
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((name) => self.classes.add(name)),
      remove: (...names) => names.forEach((name) => self.classes.delete(name)),
      contains: (name) => self.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !self.classes.has(name) : Boolean(force);
        if (on) self.classes.add(name);
        else self.classes.delete(name);
        return on;
      }
    };
  }
  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set textContent(value) {
    this.children = [];
    this.textValue = String(value);
  }
  get textContent() {
    return this.textValue + this.children.map((child) => child.textContent).join('');
  }
  get isConnected() {
    return true;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
  }
  focus() {}
  contains() {
    return false;
  }
  closest() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  // sends an event to the listeners of this node; returns what they did with it
  fire(type, init = {}) {
    const event = { type, target: this, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  find(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) if (child.find) child.find(predicate, found);
    return found;
  }
}

function makeDocument() {
  const defined = new Set();
  const waiting = new Map();
  const document = {
    documentElement: { lang: '' },
    head: new FakeNode('head'),
    body: new FakeNode('body'),
    activeElement: null,
    baseURI: 'http://localhost:3000/app/',
    listeners: {},
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (document.listeners[type] = document.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      document.listeners[type] = (document.listeners[type] || []).filter((item) => item !== fn);
    }
  };
  const customElements = {
    get: (name) => (defined.has(name) ? function Defined() {} : undefined),
    whenDefined: (name) => (defined.has(name) ? Promise.resolve() : new Promise((resolve) => waiting.set(name, resolve))),
    define(name) {
      defined.add(name);
      if (waiting.has(name)) waiting.get(name)();
    }
  };
  return { document, customElements };
}

// A page with the node-view scripts the test needs, in the language `lang`.
function loadPage(lang, { scripts = ['node-ui', 'preview'], api = {} } = {}) {
  const storage = new Map([['vcd-lang', lang]]);
  const { document, customElements } = makeDocument();
  const window = {
    document,
    customElements,
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: { graph: graphLib, api: { rel: (url) => String(url).replace(/^\/+/, ''), options: async () => ({ options: [] }), ...api } }
  };
  const timers = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer.unref) timer.unref();
    return timer;
  };
  const context = { window, document, setTimeout: timers, clearTimeout, URL, Blob };
  vm.runInNewContext(read('public/i18n.js'), context, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), context, { filename: 'public/nodes/i18n-nodes.js' });
  for (const name of scripts) vm.runInNewContext(read(`public/nodes/${name}.js`), context, { filename: `public/nodes/${name}.js` });
  const root = new FakeNode('div');
  if (window.OCDNodes.ui && window.OCDNodes.ui.setRoot) window.OCDNodes.ui.setRoot(root);
  return { window, document, customElements, OCD: window.OCDNodes, root };
}

const glb = (id, extra = {}) => ({ type: 'model3d', assetId: id, sessionId: 'sess-1', file: `${id}.glb`, url: `/assets/sess-1/${id}.glb`, ...extra });
const png = (id) => ({ type: 'image', assetId: id, sessionId: 'sess-1', file: `${id}.png`, url: `/assets/sess-1/${id}.png` });

/* ---------- the shipped viewer ---------- */

function testVendor() {
  const dir = path.join(root, VENDOR);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['LICENSE', 'SOURCE.txt', 'model-viewer.min.js'], 'the minified file, the licence and the note, nothing else');
  const note = read(`${VENDOR}/SOURCE.txt`);
  assert.match(note, /@google\/model-viewer/);
  assert.match(note, /Version:\s+4\.3\.1/);
  assert.match(note, /Apache-2\.0/);
  assert.match(note, /https:\/\/registry\.npmjs\.org\/@google\/model-viewer\/-\/model-viewer-4\.3\.1\.tgz/);
  const integrity = /Integrity:\s+(sha512-\S+)/.exec(note);
  assert.ok(integrity, 'the integrity value of the registry is noted');
  assert.equal(Buffer.from(integrity[1].slice('sha512-'.length), 'base64').length, 64, 'a sha512 value');
  // the two files are the ones the note names
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
  const noted = [...note.matchAll(/sha256\s+([0-9a-f]{64})/g)].map((match) => match[1]);
  assert.deepEqual(noted, [sha('model-viewer.min.js'), sha('LICENSE')]);
  assert.match(read(`${VENDOR}/LICENSE`), /Apache License\s+Version 2\.0/);
  const bundle = read(`${VENDOR}/model-viewer.min.js`);
  assert.ok(bundle.includes('customElements') && bundle.includes('model-viewer'));
  // the decoders are not shipped: the only addresses in the bundle that a model can make it load are those of Google
  const hosts = new Set([...bundle.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]));
  for (const host of ['www.gstatic.com']) assert.ok(hosts.has(host), `the bundle names ${host} for the decoders`);
  // ... and one more: the default for Lottie textures. The note and the README name it (the first report said only Google), and
  // the page moves that setting to the app itself before the viewer starts
  assert.ok(hosts.has('cdn.jsdelivr.net'), 'the bundle names the default for Lottie textures');
  assert.deepEqual([...hosts].filter((host) => !['www.gstatic.com', 'cdn.jsdelivr.net'].includes(host) && !/^(www\.w3\.org|schema\.org|www\.apache\.org|github\.com|jcgt\.org|101arrowz\.github\.io|h5bp\.github\.io)$/.test(host)), [], 'no other address in the bundle that a model could make it call');
  assert.match(note, /cdn\.jsdelivr\.net\/npm\/three@0\.149\.0\/examples\/jsm\/loaders\/LottieLoader\.js/);
  assert.match(note, /lottieLoaderLocation/);
  assert.match(note, /only for Lottie textures/);

  // not a dependency, not loaded with the page
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@resvg/resvg-js', 'archiver', 'compression', 'express', 'yauzl'], 'no new dependency');
  assert.ok(!/model-viewer/.test(JSON.stringify(pkg)));
  assert.ok(!/model-viewer/.test(read('public/index.html')), 'index.html does not load the viewer');
  for (const file of fs.readdirSync(path.join(root, 'public/nodes')).filter((name) => name.endsWith('.js'))) {
    const source = read(`public/nodes/${file}`);
    if (file !== 'preview.js') assert.ok(!/model-viewer\.min\.js/.test(source), `${file} does not load the viewer`);
  }
  // relative, so the app works under a sub-path; the element has no "ar" attribute
  const preview = read('public/nodes/preview.js');
  assert.match(preview, /'vendor\/model-viewer\/model-viewer\.min\.js'/);
  assert.ok(!/['"`]\/vendor\//.test(preview));
  assert.ok(!/\bar:|'ar'|"ar"|ar-modes|ar-scale/.test(preview), 'no augmented reality');
  // a finger on the model never traps the page: where the page scrolls (app view) or the model is large, a vertical swipe stays with the page
  assert.match(read('public/nodes/app-mode.js'), /mediaNode\(leaf, \{ scrolling: true \}\)/);
  const css = read('public/nodes/nodes.css');
  assert.match(css, /\.nv-model\.is-large,\s*\.nv-appleaf-frame \.nv-model\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.nv-model\s*\{[^}]*touch-action:\s*none/, 'the card on the canvas keeps none');
  // the title of a card never disappears behind the badges: it keeps a minimum width, the long badge gives way with an ellipsis
  assert.match(css, /\.nv-node-title\s*\{[^}]*min-width:\s*5em/);
  assert.match(css, /\.nv-node-badges \.nv-badge\.is-experimental\s*\{[^}]*min-width:[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(preview), 'no innerHTML with data');
  // the specification follows the code: no "later, three.js from a CDN" any more
  const spec = read('docs/node-view/SPEC.md');
  assert.ok(!/three\.js from CDN/.test(spec));
  for (const word of ['model3d', 'fal.image_to_3d', 'model-viewer', 'OUTPUT_EMPTY', 'emptyOutputs', 'MESH_FILE_EXTERNAL']) assert.ok(spec.includes(word), `SPEC: ${word}`);
  // the node view and the help know nothing of other addresses
  assert.ok(!/gstatic|jsdelivr|unpkg|cdnjs/.test(preview));
  // the repository names the viewer and its licence, and the decoders
  for (const file of ['README.md', 'README.de.md']) {
    const text = read(file);
    assert.match(text, /model-viewer/);
    assert.match(text, /Apache-2\.0/);
    assert.match(text, /gstatic/);
    assert.match(text, /jsdelivr/, `${file} names the second address of the bundle`);
    assert.match(text, /public\/vendor\/model-viewer\/SOURCE\.txt/);
  }
}

/* ---------- the 3D view ---------- */

async function testPreview() {
  for (const lang of ['de', 'en', 'es']) {
    const page = loadPage(lang);
    const { OCD, document, customElements } = page;
    const preview = OCD.preview;
    const ui = OCD.ui;
    const scripts = () => document.head.children.filter((node) => node.tagName === 'SCRIPT');

    // a 3D model is a media value; nothing is loaded before one is shown
    assert.equal(preview.isMedia(glb('mod-1')), true);
    assert.equal(preview.isViewable(glb('mod-1')), true);
    assert.equal(preview.isMedia({ type: 'model3d', assetId: 'x' }), false, 'without a url it is nothing to show');
    assert.equal(scripts().length, 0, 'the viewer is not loaded with the page');

    // the card: one view, the script is added once, relative to the page
    const poster = png('img-1');
    const card = new FakeNode('div');
    preview.renderCardPreview(card, [{ port: 'model', value: glb('mod-1') }, { port: 'preview', value: poster }], { portLabel: (id) => id });
    assert.equal(scripts().length, 1);
    assert.equal(scripts()[0].getAttribute('type'), 'module');
    assert.equal(scripts()[0].getAttribute('src'), 'vendor/model-viewer/model-viewer.min.js', 'relative: the app also runs under a sub-path');
    const views = card.find((node) => node.tagName === 'MODEL-VIEWER');
    assert.equal(views.length, 1, 'the model once; its preview image is its poster and takes no second place');
    const view = views[0];
    assert.equal(view.getAttribute('src'), 'assets/sess-1/mod-1.glb', 'relative like every media url');
    assert.equal(view.getAttribute('poster'), 'assets/sess-1/img-1.png');
    assert.ok(view.hasAttribute('camera-controls'));
    assert.equal(view.getAttribute('touch-action'), 'none', 'on the canvas a finger drag turns the model');
    // the viewer starts with the Lottie setting moved to the app (read by the bundle from self.ModelViewerElement)
    assert.equal(page.window.ModelViewerElement.lottieLoaderLocation, 'http://localhost:3000/app/vendor/model-viewer/lottie-loader-not-shipped.js');
    assert.ok(!/jsdelivr|gstatic/.test(JSON.stringify(page.window.ModelViewerElement)));
    // the scrolling app view keeps the vertical swipe for the page
    const appView = preview.mediaNode(glb('mod-1'), { scrolling: true }).find((node) => node.tagName === 'MODEL-VIEWER')[0];
    assert.equal(appView.getAttribute('touch-action'), 'pan-y');
    assert.equal(preview.mediaNode(glb('mod-1'), { large: true }).find((node) => node.tagName === 'MODEL-VIEWER')[0].getAttribute('touch-action'), 'pan-y');
    assert.equal(preview.mediaNode(glb('mod-1'), {}).find((node) => node.tagName === 'MODEL-VIEWER')[0].getAttribute('touch-action'), 'none');
    assert.equal(view.getAttribute('loading'), 'lazy');
    assert.ok(!view.hasAttribute('ar') && !view.hasAttribute('ar-modes') && !view.hasAttribute('auto-rotate'));
    assert.ok(view.getAttribute('alt'));
    assert.equal(card.find((node) => node.tagName === 'IMG').length, 0, 'no second preview image on the card');
    assert.equal(card.find((node) => node.tagName === 'AUDIO').length, 0, 'never an audio player');
    const frame = card.find((node) => node.classes.has('nv-pv-frame'))[0];
    assert.ok(frame.classes.has('is-model3d'));
    const wrap = card.find((node) => node.classes.has('nv-model'))[0];
    assert.ok(wrap.classes.has('nv-nodrag'), 'a drag in the view does not move the node');
    // tools: the large view and the download of the GLB
    const download = card.find((node) => node.tagName === 'A' && node.hasAttribute('download'))[0];
    assert.equal(download.getAttribute('download'), 'mod-1.glb');
    assert.equal(download.getAttribute('href'), 'assets/sess-1/mod-1.glb');

    // a turn or a zoom does not reach the canvas: wheel, double click and the arrow keys stay in the view
    const wheel = wrap.fire('wheel', { deltaY: 120 });
    assert.ok(wheel.stopped && wheel.prevented);
    assert.ok(wrap.fire('dblclick').stopped);
    assert.ok(wrap.fire('keydown', { key: 'ArrowLeft' }).stopped);
    assert.ok(wrap.fire('keydown', { key: 'PageUp' }).stopped);
    assert.equal(wrap.fire('keydown', { key: 'Tab' }).stopped, false, 'other keys are not held back');
    assert.equal(frame.listeners.dblclick, undefined, 'a double click does not open the large view');

    // the second model does not add a second script; once defined, nothing is added at all
    preview.renderCardPreview(new FakeNode('div'), [{ port: 'model', value: glb('mod-2') }], {});
    assert.equal(scripts().length, 1);
    scripts()[0].fire('load');
    customElements.define('model-viewer');
    assert.equal(await preview.loadModelViewer(), true);
    preview.renderCardPreview(new FakeNode('div'), [{ port: 'model', value: glb('mod-3') }], {});
    assert.equal(scripts().length, 1);

    // a model without a preview image: no poster attribute
    const alone = new FakeNode('div');
    preview.renderCardPreview(alone, [{ port: 'model', value: glb('mod-1') }], {});
    assert.ok(!alone.find((node) => node.tagName === 'MODEL-VIEWER')[0].hasAttribute('poster'));
    // an output node hands over a list with one entry: it reads as that entry
    const listed = new FakeNode('div');
    preview.renderCardPreview(listed, [{ port: 'result', value: { type: 'list', items: [glb('mod-1')] } }], {});
    assert.equal(listed.find((node) => node.tagName === 'MODEL-VIEWER').length, 1);

    // a file the viewer cannot read: a message and the poster instead of an empty frame
    const broken = new FakeNode('div');
    preview.renderCardPreview(broken, [{ port: 'model', value: glb('mod-9') }, { port: 'preview', value: poster }], {});
    const brokenView = broken.find((node) => node.tagName === 'MODEL-VIEWER')[0];
    brokenView.fire('error');
    const brokenWrap = broken.find((node) => node.classes.has('nv-model'))[0];
    assert.ok(brokenWrap.classes.has('is-failed'));
    assert.equal(broken.find((node) => node.tagName === 'MODEL-VIEWER').length, 0);
    assert.equal(broken.find((node) => node.classes.has('nv-model-fallback'))[0].textContent, ui.T('nodes.model.unavailable'));
    assert.equal(broken.find((node) => node.tagName === 'IMG')[0].getAttribute('src'), 'assets/sess-1/img-1.png');

    // the history strip: the preview image or the 3D tile, never an audio glyph
    const withPoster = preview.thumb(glb('mod-1'), { poster });
    assert.equal(withPoster.find((node) => node.tagName === 'IMG')[0].getAttribute('src'), 'assets/sess-1/img-1.png');
    assert.equal(withPoster.find((node) => node.classes.has('nv-thumb-badge')).length, 1);
    const tile = preview.thumb(glb('mod-1'));
    assert.ok(tile.classes.has('is-glyph') && tile.classes.has('is-model'));
    assert.equal(tile.find((node) => node.tagName === 'IMG').length, 0);
    assert.equal(plain(preview.posterOf([glb('mod-1'), png('img-2')])).assetId, 'img-2');
    assert.equal(preview.posterOf([glb('mod-1'), null, { type: 'text', value: 'x' }]), null);
    // a list of models gets the tile of the first
    assert.ok(preview.thumb({ type: 'list', items: [glb('mod-1')] }).classes.has('is-model'));

    // the large view: eager, with the poster, the download of the GLB; Escape closes it and the arrows stay with a focused model
    const viewer = preview.openViewer([{ value: glb('mod-1'), label: 'Model', poster }, { value: poster, label: 'Preview' }], 0, { title: 'Image to 3D' });
    assert.ok(viewer);
    const overlay = page.root.children[0];
    assert.ok(overlay.classes.has('nv-viewer'));
    const large = overlay.find((node) => node.classes.has('nv-model'))[0];
    assert.ok(large.classes.has('is-large'));
    assert.equal(large.find((node) => node.tagName === 'MODEL-VIEWER')[0].getAttribute('loading'), 'eager');
    assert.equal(large.find((node) => node.tagName === 'MODEL-VIEWER')[0].getAttribute('touch-action'), 'pan-y', 'the large view: a vertical swipe stays with the page');
    assert.equal(large.find((node) => node.tagName === 'MODEL-VIEWER')[0].getAttribute('poster'), 'assets/sess-1/img-1.png');
    const stage = overlay.find((node) => node.classes.has('nv-viewer-stage'))[0];
    assert.ok(stage.classes.has('has-model'));
    const next = overlay.find((node) => node.classes.has('nv-viewer-nav') && node.classes.has('is-next'))[0];
    next.fire('click');
    assert.ok(!stage.classes.has('has-model'), 'the next item is the preview image');
    assert.equal(stage.find((node) => node.tagName === 'IMG').length, 1);
    // arrow keys on a focused 3D view are for the view, not for the next item
    preview.closeViewer();
    preview.openViewer([{ value: glb('mod-1') }, { value: glb('mod-2') }], 0, {});
    const again = page.root.children[page.root.children.length - 1];
    const counter = again.find((node) => node.classes.has('nv-viewer-counter'))[0];
    assert.equal(counter.textContent, '1 / 2');
    document.listeners.keydown[0]({ key: 'ArrowRight', target: { tagName: 'MODEL-VIEWER' }, preventDefault() {}, stopPropagation() {} });
    assert.equal(counter.textContent, '1 / 2', 'the arrow turns the model');
    document.listeners.keydown[0]({ key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {} });
    assert.equal(counter.textContent, '2 / 2');
    preview.closeViewer();
  }

  // the viewer cannot be loaded (blocked, missing): the fallback appears and the next try loads again
  {
    const page = loadPage('en');
    const card = new FakeNode('div');
    page.OCD.preview.renderCardPreview(card, [{ port: 'model', value: glb('mod-1') }], {});
    page.document.head.children[0].fire('error');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(card.find((node) => node.classes.has('nv-model'))[0].classes.has('is-failed'));
    assert.equal(card.find((node) => node.classes.has('nv-model-fallback'))[0].textContent, page.OCD.ui.T('nodes.model.unavailable'));
    page.OCD.preview.renderCardPreview(new FakeNode('div'), [{ port: 'model', value: glb('mod-2') }], {});
    assert.equal(page.document.head.children.filter((node) => node.tagName === 'SCRIPT').length, 2, 'a failed load is tried again');
  }
}

/* ---------- the model list, limits and marks ---------- */

async function testModelList() {
  const payload = plain(registryModule.publicRegistry());
  const reg = graphLib.indexRegistry(payload);
  const def = payload.nodeTypes.find((item) => item.type === 'fal.image_to_3d');
  assert.equal(def.params.find((param) => param.id === 'model').noDefaultEntry, true);
  const served = plain({ options: nodesFal.image3dOptions() });

  for (const lang of ['de', 'en', 'es']) {
    const page = loadPage(lang, { api: { options: async () => served } });
    const ui = page.OCD.ui;
    const normal = plain(ui.normalizeOptions(served));
    assert.deepEqual(normal.map((item) => item.value), ['tripo_h31', 'hunyuan_pro31', 'meshy_71', 'sam3d_objects']);
    assert.deepEqual(normal[0].left, { max: 1 });
    assert.equal(normal[0].views, 3);
    assert.equal(normal[3].views, 0);
    assert.deepEqual(normal[3].left, { max: 0 });
    assert.equal(normal[0].fromUsd, 0.3);
    assert.equal(normal[0].strength, 'allround');
    assert.equal('minUsd' in normal[0], false, 'only what the page shows is kept');

    // the list has no "default" entry: the four models, Tripo first
    const entries = plain(ui.selectEntries(def.params.find((param) => param.id === 'model'), { state: 'ready', options: normal }, 'tripo_h31'));
    assert.deepEqual(entries.map((item) => item.value), ['tripo_h31', 'hunyuan_pro31', 'meshy_71', 'sam3d_objects']);
    // a model list without the flag keeps its default entry
    assert.equal(plain(ui.selectEntries({ optionsSource: 'image-models' }, { state: 'ready', options: normal }, ''))[0].value, '');

    // label: name, strength, views, price from
    const label = (index, usage) => ui.modelOptionLabel(normal[index], usage || null);
    const tripo = label(0).text;
    assert.match(tripo, /^Tripo H3\.1 · /);
    assert.match(tripo, /\$0\.30/);
    assert.match(tripo, lang === 'de' ? /ab \$0\.30/ : lang === 'en' ? /from \$0\.30/ : /desde \$0\.30/);
    assert.match(tripo, lang === 'de' ? /bis 3 weitere Ansichten/ : lang === 'en' ? /up to 3 more views/ : /hasta 3 vistas más/);
    assert.match(tripo, lang === 'de' ? /Solider Allrounder/ : lang === 'en' ? /Solid all-rounder/ : /Todoterreno sólido/);
    assert.match(label(1).text, /\$0\.375/);
    assert.match(label(2).text, /\$1\.20/);
    const sam = label(3).text;
    assert.match(sam, /\$0\.02/);
    assert.match(sam, lang === 'de' ? /experimentell/ : lang === 'en' ? /experimental/ : /experimental/, 'SAM 3D is marked experimental');
    assert.match(sam, lang === 'de' ? /keine weiteren Ansichten/ : lang === 'en' ? /no more views/ : /sin más vistas/);
    assert.equal(label(0).misfit, false);
    // a view at a model that takes none: marked, short in the list, a sentence in the inspector
    assert.match(label(3, { left: 1 }).text, /⚠/);
    assert.equal(label(3, { left: 1 }).misfit, true);
    assert.equal(label(0, { left: 1, back: 1, right: 1 }).misfit, false);
    assert.match(ui.misfitText(normal[3], { left: 1, back: 1 }), /2/);
    assert.equal(ui.misfitText(normal[3], {}), '');
    assert.equal(ui.viewsText({ views: 0 }) !== ui.viewsText({ views: 3 }), true);
    assert.equal(ui.strengthText({ strength: 'nothing_like_it' }), '', 'a key without text is left out');

    // limits of the chosen model for the three views, from the list (no description to read)
    const state = ui.optionsFor({ optionsSource: 'image-to-3d-models' });
    assert.equal(state.state, 'loading');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ui.optionsFor({ optionsSource: 'image-to-3d-models' }).state, 'ready');
    const limits = (model) => plain(ui.limitsFor({ id: 'n', type: 'fal.image_to_3d', params: model === undefined ? {} : { model } }, def));
    assert.deepEqual(limits('tripo_h31'), { left: { max: 1, roles: [], required: false, subject: 'Tripo H3.1' }, back: { max: 1, roles: [], required: false, subject: 'Tripo H3.1' }, right: { max: 1, roles: [], required: false, subject: 'Tripo H3.1' } });
    assert.equal(limits('sam3d_objects').left.max, 0);
    assert.equal(limits('sam3d_objects').right.subject, 'SAM 3D Objects');
    // the node without a choice stored: its default model (the param default is applied by the page before it asks)
    assert.equal(limits('meshy_71').back.max, 1);
  }

  // what the page counts as "connections per capability": the three views
  const node = { id: 'n1', type: 'fal.image_to_3d', params: { model: 'sam3d_objects' } };
  const graph = {
    nodes: [node, { id: 'a', type: 'input.image', params: {} }, { id: 'b', type: 'input.image', params: {} }],
    edges: [
      { id: 'e1', from: { node: 'a', port: 'image' }, to: { node: 'n1', port: 'image' } },
      { id: 'e2', from: { node: 'b', port: 'image' }, to: { node: 'n1', port: 'left' } }
    ]
  };
  assert.deepEqual(plain(graphLib.capabilityUsage(reg, graph, 'n1')), { left: 1, back: 0, right: 0 });
}

/* ---------- send dialog and picker for the new kind ---------- */

function testChatBridge() {
  const page = loadPage('de', { scripts: ['node-ui', 'preview', 'asset-picker'] });
  const picker = page.OCD.assetPicker;
  assert.equal(picker.ledgerKind({ kind: 'model3d', file: 'mod-1.glb' }), 'model3d');
  assert.equal(picker.ledgerKind({ kind: 'upload', file: 'x.glb' }), 'model3d');
  assert.equal(picker.ledgerKind({ kind: 'upload', file: 'x.png' }), 'image');
  assert.equal(picker.ledgerKind({ kind: 'upload', file: 'x.fbx' }), null);
  const source = read('public/nodes/asset-picker.js');
  assert.match(source, /nv-send-note/);
  assert.match(source, /plan\.unsupported/);
  // "Download" of a 3D result gives the GLB file, not the preview image next to it
  const run = read('public/nodes/run.js');
  assert.match(run, /const models = media\.filter\(\(item\) => item\.value\.type === 'model3d'\)/);
  assert.match(run, /const items = models\.length \? models : media;/);
  // the server tells the dialog what it leaves out
  assert.match(read('lib/nodes/routes.js'), /unsupported: unsendablePorts\(variant\)/);
}

/* ---------- where the estimate of Hunyuan is a number ---------- */

function testHunyuanEstimate() {
  // The estimate needs to know whether views are connected (they add a surcharge). Everything that prices a graph goes through
  // computePlan, which hands the connected ports over: the card and the plan before the start (the plan of a workflow), the
  // gallery of the templates (estimateGraph) and the reservation of the budget. Without that knowledge the estimate is null, not 0.
  const graphOf = (views, params = {}) => ({
    nodes: [
      { id: 'a', type: 'input.image', typeVersion: 1, x: 0, y: 0, params: { asset: null } },
      { id: 'b', type: 'input.image', typeVersion: 1, x: 0, y: 0, params: { asset: null } },
      { id: 'h', type: 'fal.image_to_3d', typeVersion: 1, x: 0, y: 0, params: { model: 'hunyuan_pro31', ...params } }
    ],
    edges: [{ id: 'e1', from: { node: 'a', port: 'image' }, to: { node: 'h', port: 'image' } }, ...(views ? [{ id: 'e2', from: { node: 'b', port: 'image' }, to: { node: 'h', port: 'left' } }] : [])],
    groups: [],
    notes: []
  });
  const price = (graph) => engine.estimateGraph(graph);
  assert.deepEqual(price(graphOf(false)), { paidNodes: 1, unknownNodes: 0, usd: 0.375, credits: 0 });
  assert.deepEqual(price(graphOf(true)), { paidNodes: 1, unknownNodes: 0, usd: 0.525, credits: 0 }, 'a connected view adds its surcharge');
  assert.deepEqual(price(graphOf(true, { pbr: true, face_count: 100000 })), { paidNodes: 1, unknownNodes: 0, usd: 0.825, credits: 0 });
  // the plan of a workflow (card and confirmation before the start)
  const workflow = { graph: graphOf(true) };
  const ready = { ...registryModule.registry, availability: () => true };
  const request = engine.normaliseRequest ? engine.normaliseRequest({ mode: 'all' }, workflow, ready) : null;
  if (request && engine.computePlan) {
    const plan = engine.computePlan({ workflow, results: { nodes: {} }, request, registry: ready, limits: engine.resolveLimits ? engine.resolveLimits() : undefined });
    assert.equal(plan.nodes.h.estimate.usd, 0.525);
    assert.equal(plan.totals.unknownNodes, 0);
  }
  // the one place without the connections is the bare call: unknown, never a smaller price
  const hunyuan = registryModule.registry.get('fal.image_to_3d');
  const params = registryModule.registry.normalizeParams(hunyuan, { model: 'hunyuan_pro31' });
  assert.equal(hunyuan.cost.estimate(params), null);
  assert.equal(hunyuan.cost.estimate(params, { connected: new Set() }), 0.375);
}

/* ---------- the dictionaries for the new interface texts ---------- */

function testTexts() {
  const page = loadPage('de');
  const dictionaries = page.window.I18N;
  const keys = [
    'nodes.model.badge',
    'nodes.model.hint',
    'nodes.model.alt',
    'nodes.model.loading',
    'nodes.model.unavailable',
    'nodes.cap.views.upTo',
    'nodes.cap.views.none',
    'nodes.cap.price3d',
    'nodes.cap.misfit.noViews',
    'nodes.cap.misfitShort.noViews',
    'nodes.send.noModel3d'
  ];
  for (const key of keys) {
    for (const lang of ['de', 'en', 'es']) {
      assert.ok(dictionaries[lang][key] && dictionaries[lang][key].trim(), `${lang}: ${key}`);
      assert.ok(!/ß/.test(dictionaries[lang][key]), `${lang}: ${key} has no ß`);
    }
  }
  assert.match(dictionaries.de['nodes.send.noModel3d'], /GLB/);
  assert.match(dictionaries.en['nodes.model.unavailable'], /download/i);
}

async function main() {
  testVendor();
  await testPreview();
  await testModelList();
  testChatBridge();
  testHunyuanEstimate();
  testTexts();
  console.log('test-nodes-model-viewer.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
