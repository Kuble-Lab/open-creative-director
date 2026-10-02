'use strict';

// Send to chat, client side (WP17): the chat shows results from the node view as one card (new `origin` messages and
// the older plain-text notes), videos of user messages as a player, and the send dialog of the node view lists what is
// sent. No browser and no network: the chat functions are cut out of public/app.js and run against a tiny fake DOM;
// the dialogs themselves are checked in a real browser against an isolated app copy.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const appSource = read('public', 'app.js');

/* ---------- tiny DOM ---------- */

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    const element = this;
    this.classList = {
      add: (...names) => { element.className = [...new Set(`${element.className || ''} ${names.join(' ')}`.trim().split(/\s+/))].join(' '); },
      contains: (name) => (element.className || '').split(/\s+/).includes(name)
    };
    this.className = '';
  }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  insertBefore(child) { this.children.push(child); return child; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  find(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.children) child.find(predicate, out);
    return out;
  }
}

function load() {
  const start = appSource.indexOf('/* ---------- results sent from the node view ---------- */');
  const end = appSource.indexOf('function renderDetail()');
  assert.ok(start > 0 && end > start, 'the origin section is in public/app.js');
  const section = appSource.slice(start, end);
  const dictionaries = { de: { 'nodes.port.expanded_prompt': 'Erweiterter Prompt', 'nodes.portdesc.expanded_prompt': 'Der Prompt, den der Anbieter daraus gebaut hat.' } };
  const window = {};
  const context = {
    window,
    document: { createElement: (tag) => new FakeElement(tag) },
    encodeURIComponent,
    getLang: () => 'de',
    t: (key, vars = {}) => dictionaries.de[key] || `[${key}]${Object.values(vars).map((value) => ` ${value}`).join('')}`,
    textFromContent: (content) => (typeof content === 'string' ? content : ''),
    messageShell: () => {
      const wrap = new FakeElement('div');
      const bubble = new FakeElement('div');
      wrap.appendChild(bubble);
      return { wrap, bubble };
    },
    mediaCard: (asset) => {
      const card = new FakeElement('div');
      card.className = 'asset-card';
      card.asset = asset;
      return card;
    }
  };
  window.I18N = dictionaries;
  vm.runInNewContext(`${section}\nthis.api = { originOf, originCardNode, originPortLabel, originPortHelp };`, context, { filename: 'public/app.js (origin)' });
  return context.api;
}

function testOriginOf() {
  const { originOf } = load();
  const fresh = originOf({
    role: 'user',
    content: 'Aus dem Workflow …',
    origin: { kind: 'workflow', workflowId: 'wf-1', workflowName: 'Flow <b>', nodeLabel: 'Generate video (Seedance)', nodeType: 'fal.h3_video', ports: [{ id: 'video', type: 'video' }], texts: [{ port: 'expanded_prompt', text: 'long' }], canOpen: true }
  });
  assert.equal(fresh.workflowId, 'wf-1');
  assert.equal(fresh.workflowName, 'Flow <b>');
  assert.equal(fresh.canOpen, true);
  assert.equal(originOf({ role: 'user', content: 'x', origin: { kind: 'workflow', workflowId: 'wf-1' } }).canOpen, false, 'a link needs the explicit permission of the server');
  assert.equal(originOf({ role: 'user', content: 'Hallo' }), null, 'normal messages are no cards');
  assert.equal(originOf({ role: 'user', content: 'x', origin: { kind: 'other' } }), null);

  // the note written before WP17, with and without the asset line and the text block
  const legacy = originOf({
    role: 'user',
    content: '[Workflow «New workflow»] Ergebnis «Generate video (Seedance)» aus der Node-Ansicht uebernommen.\nGespeichert als Asset vid-001.\nText:\n{"summary":"a"}\n---\nsecond'
  });
  assert.equal(legacy.workflowName, 'New workflow');
  assert.equal(legacy.nodeLabel, 'Generate video (Seedance)');
  assert.equal(legacy.workflowId, '');
  assert.equal(legacy.canOpen, false, 'the old note has no workflow id, so no link');
  assert.equal(legacy.texts.length, 1);
  assert.equal(legacy.texts[0].text, '{"summary":"a"}\n---\nsecond');
  const bare = originOf({ role: 'user', content: '[Workflow «A»] Ergebnis «B» aus der Node-Ansicht uebernommen.' });
  assert.equal(bare.workflowName, 'A');
  assert.equal(bare.texts.length, 0);
  const textOnly = originOf({ role: 'user', content: '[Workflow «A»] Ergebnis «B» aus der Node-Ansicht uebernommen.\nText:\nhello' });
  assert.equal(textOnly.texts[0].text, 'hello');
}

function testCard() {
  const { originCardNode } = load();
  const assetMap = new Map([['vid-002', { id: 'vid-002', kind: 'video', url: '/assets/s/vid-002.mp4' }]]);
  const message = {
    role: 'user',
    content: 'x',
    uploadIds: ['vid-002'],
    origin: { kind: 'workflow', workflowId: 'wf 1', workflowName: '<img src=x onerror=alert(1)>', nodeLabel: 'Node "A"', nodeType: 'fal.h3_video', ports: [{ id: 'video', type: 'video' }, { id: 'expanded_prompt', type: 'text' }], texts: [{ port: 'expanded_prompt', text: '<script>1</script>' }], canOpen: true }
  };
  const wrap = originCardNode(message, assetMap);
  const bubble = wrap.children[0];
  assert.ok(bubble.classList.contains('origin-card'));
  const text = bubble.textContent;
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'workflow names are shown as text, never as markup');
  assert.ok(text.includes('<script>1</script>'));
  assert.ok(text.includes('[origin.noteAssets] vid-002'), 'the note names the asset');
  const media = bubble.find((node) => node.asset);
  assert.equal(media.length, 1);
  assert.equal(media[0].asset.id, 'vid-002');
  const link = bubble.find((node) => node.className === 'origin-open');
  assert.equal(link.length, 1);
  assert.equal(link[0].href, '#w=wf%201');
  const details = bubble.find((node) => node.tagName === 'details');
  assert.equal(details.length, 1, 'texts sit in a collapsible block');
  const summary = details[0].children[0];
  assert.ok(summary.textContent.startsWith('[origin.textSummary] Erweiterter Prompt'));
  assert.equal(summary.title, 'Der Prompt, den der Anbieter daraus gebaut hat.', 'hover help of the port');

  // without permission: name only, no link; a message that is no card gives null
  const noLink = originCardNode({ ...message, origin: { ...message.origin, canOpen: false } }, assetMap);
  assert.equal(noLink.children[0].find((node) => node.className === 'origin-open').length, 0);
  assert.equal(originCardNode({ role: 'user', content: 'Hi' }, assetMap), null);
  // an asset that is gone is skipped without an error
  assert.doesNotThrow(() => originCardNode(message, new Map()));
  // text-only results get the matching note
  const textOnly = originCardNode({ role: 'user', content: 'x', origin: { kind: 'workflow', workflowId: 'w', workflowName: 'W', nodeLabel: 'N', ports: [], texts: [] }, uploadIds: [] }, assetMap);
  assert.ok(textOnly.children[0].textContent.includes('[origin.noteText]'));
}

function testPortLabels() {
  const { originPortLabel } = load();
  assert.equal(originPortLabel('expanded_prompt'), 'Erweiterter Prompt');
  assert.equal(originPortLabel('first_frame_text'), 'First frame text', 'unknown ports are humanised');
}

function testSources() {
  const originSection = appSource.slice(appSource.indexOf('/* ---------- results sent from the node view ---------- */'), appSource.indexOf('function renderDetail()'));
  assert.ok(!/innerHTML/.test(originSection), 'the origin card never uses innerHTML');
  const preview = appSource.slice(appSource.indexOf('function attachmentPreviewNode'), appSource.indexOf('function renderDetail()'));
  assert.ok(/videoCard\(\{ id: assetId \|\| fileName, url \}\)/.test(preview), 'chat videos use the video card');
  assert.ok(/VIDEO_ATTACHMENT_EXTENSION/.test(appSource));
  assert.ok(/attachmentPreviewNode\(\{ name: originalName \|\| asset\.file, url: asset\.url, lightbox: true, assetId: asset\.id, kind: asset\.kind \}\)/.test(appSource), 'uploads of the chat pass the asset id');
  const picker = read('public', 'nodes', 'asset-picker.js');
  assert.ok(!/innerHTML/.test(picker), 'the send dialog never uses innerHTML');
  assert.ok(!/\b(alert|confirm|prompt)\(/.test(picker), 'no native dialogs');
  assert.ok(/error\.code === 'CHAT_NOT_FOUND'\) return T\('nodes\.send\.chatGone'\)/.test(picker), 'only a missing chat says "chat gone"');
  assert.ok(/showStatus\(\);\n/.test(picker) && /nodes\.send\.empty/.test(picker), 'the dialog explains a disabled Send button from the start');
  assert.ok(/send-to-chat\/plan/.test(picker) && /ports: plan\.ports/.test(picker), 'the dialog reads the plan and sends the chosen ports');
}

function testKeys() {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public', 'nodes', 'i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  const used = new Set();
  for (const match of appSource.matchAll(/\bt\('(origin\.[\w.]+)'/g)) used.add(match[1]);
  for (const match of read('public', 'nodes', 'asset-picker.js').matchAll(/\bT\('(nodes\.send\.[\w.]+)'/g)) used.add(match[1]);
  assert.ok(used.size >= 14, `found the keys of the feature (${used.size})`);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of used) assert.ok(window.I18N[lang][key], `${lang} has ${key}`);
    for (const key of Object.keys(window.I18N[lang]).filter((name) => /^origin\.|^nodes\.send\./.test(name))) {
      assert.ok(!window.I18N[lang][key].includes('ß'), `${lang}.${key} uses Swiss spelling`);
    }
  }
  assert.ok(window.I18N.de['origin.noteAssets'].includes('{ids}') && window.I18N.es['origin.noteAssets'].includes('{ids}'));
  assert.match(window.I18N.de['nodes.send.message'], /Es startet nichts automatisch/);
  assert.match(window.I18N.en['nodes.send.message'], /Nothing starts automatically/);
}

testOriginOf();
testCard();
testPortLabels();
testSources();
testKeys();
console.log('test-chat-origin.js: ok');
