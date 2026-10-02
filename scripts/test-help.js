'use strict';

// The help page (public/help.html) and the shared frame of the two views (public/shell.js, header in index.html).
// No browser, no network: the page is read as text.
//   - three complete language blocks (de, en, es) with the same sections in the same order
//   - the table of contents of every block points to existing sections
//   - Swiss spelling (no sharp s), no internal names or addresses
//   - the language choice is shared with the app (localStorage "vcd-lang")
//   - the menu links to the help; every text key the frame uses exists in all languages

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const LANGS = ['de', 'en', 'es'];

function blocks(page) {
  const found = {};
  const pattern = /<div class="lang" data-lang="(\w+)">([\s\S]*?)\n    <\/div>\n(?=\n    <!-- =|  <\/div>)/g;
  for (const match of page.matchAll(pattern)) found[match[1]] = match[2];
  return found;
}

function testHelpPage() {
  const page = read('public', 'help.html');
  const found = blocks(page);
  assert.deepEqual(Object.keys(found).sort(), [...LANGS].sort(), 'one block per language');
  const ids = {};
  for (const lang of LANGS) {
    const block = found[lang];
    ids[lang] = [...block.matchAll(/<section class="card" id="(\w+)-([\w-]+)" data-section="([\w-]+)"/g)].map((m) => {
      assert.equal(m[1], lang, `${lang}: section id prefix`);
      assert.equal(m[2], m[3], `${lang}: id and data-section agree (${m[2]})`);
      return m[3];
    });
    assert.ok(ids[lang].length >= 10, `${lang}: at least ten sections, found ${ids[lang].length}`);
    // every section has a heading and real content
    for (const match of block.matchAll(/<section class="card"[^>]*><h2>([^<]+)<\/h2>([\s\S]*?)<\/section>/g)) {
      assert.ok(match[1].trim().length > 2, `${lang}: heading`);
      assert.ok(match[2].replace(/<[^>]+>/g, '').trim().length > 80, `${lang}: section "${match[1]}" has content`);
    }
    // table of contents: one entry per section, each pointing at an existing id
    const toc = [...block.matchAll(/<li><a href="#([\w-]+)">/g)].map((m) => m[1]);
    assert.deepEqual(toc, ids[lang].map((id) => `${lang}-${id}`), `${lang}: table of contents matches the sections`);
    assert.match(block, /<h1>[^<]+<\/h1>/, `${lang}: title`);
    assert.doesNotMatch(block, /teams: sections for teams and budgets are added here/, `${lang}: the marker is replaced by the teams sections`);
  }
  assert.deepEqual(ids.en, ids.de, 'en has the same sections as de');
  assert.deepEqual(ids.es, ids.de, 'es has the same sections as de');
  // The parts of the interface the help must cover.
  for (const id of ['start', 'chat', 'projects', 'context', 'sharing', 'teams', 'budget', 'account', 'nodes', 'presets', 'languages', 'keys', 'settings', 'monitoring']) {
    assert.ok(ids.de.includes(id), `section ${id}`);
  }
  assert.doesNotMatch(page, /ß/, 'Swiss spelling: no sharp s');
  assert.doesNotMatch(page, /kuble\.com|\.internal\b|\b10\.\d+\.\d+\.\d+\b/i, 'no internal names or addresses');
  assert.doesNotMatch(page, /innerHTML|\b(?:alert|confirm|prompt)\(/, 'no HTML from strings, no native dialogs');
  assert.match(page, /localStorage\.getItem\('vcd-lang'\)/, 'reads the app language');
  assert.match(page, /localStorage\.setItem\('vcd-lang'/, 'writes the app language');
  assert.match(page, /href="\.\/"/, 'relative link back to the app');
  assert.doesNotMatch(page, /(?:href|src)="\//, 'relative URLs only (works under a sub-path)');
  // The language switch script runs against a small fake DOM.
  const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
  const store = new Map([['vcd-lang', 'es']]);
  const langNodes = LANGS.map((code) => {
    const node = { classes: new Set(), getAttribute: (name) => (name === 'data-lang' ? code : null) };
    node.classList = { toggle: (name, on) => (on ? node.classes.add(name) : node.classes.delete(name)) };
    return node;
  });
  const document = {
    documentElement: {},
    title: '',
    getElementById: (id) => (id === 'helpBack' ? { textContent: '' } : id === 'langSwitch' ? { addEventListener() {} } : null),
    querySelectorAll: (selector) => (selector === '.lang' ? langNodes : []),
  };
  vm.runInNewContext(script, {
    document,
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    navigator: { language: 'de-CH' },
    location: { hash: '' }
  });
  assert.equal(document.documentElement.lang, 'es', 'the stored app language is used');
  assert.equal(document.title, 'Ayuda – Open Creative Director');
  assert.deepEqual(langNodes.map((n) => n.classes.has('active')), [false, false, true], 'only the Spanish block is shown');
}

function dictionaries() {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public', 'nodes', 'i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  return window.I18N;
}

function testFrame() {
  const dict = dictionaries();
  const shell = read('public', 'shell.js');
  const app = read('public', 'app.js');
  const access = read('public', 'access-client.js');
  const nodes = read('public', 'nodes', 'main.js');
  const used = new Set();
  const pattern = /\b(?:tr|t|ui\.T|T|global\.t|setStatusI18n)\(\s*['`]((?:menu|mode|location|context\.owner|topbar|settings\.tab|settings\.sections|common\.networkError|sharing\.buttonSharedWithYou|account)[\w.]*)['`]/g;
  for (const source of [shell, app, access, nodes]) for (const m of source.matchAll(pattern)) used.add(m[1]);
  for (const key of ['lang.de', 'lang.en', 'lang.es', 'sessions.rename', 'sessions.titleEmpty']) used.add(key);
  // keys built from a table in the source
  for (const key of ['topbar.contextSourcesOne', 'topbar.contextSourcesMany', 'topbar.contextBrandingsOne', 'topbar.contextBrandingsMany', 'topbar.menuOpen', 'topbar.menuClose', 'menu.trigger']) used.add(key);
  assert.ok(used.size > 20, `expected many frame keys, found ${used.size}`);
  for (const lang of LANGS) for (const key of used) assert.ok(dict[lang][key], `${lang} lacks ${key}`);

  const index = read('public', 'index.html');
  assert.match(index, /<script src="access-client\.js"><\/script>\s*<script src="shell\.js"><\/script>\s*<script src="app\.js"><\/script>/, 'shell.js loads between access-client.js and app.js');
  for (const id of ['nodesBtn', 'chatModeBtn', 'mobileMenuBtn', 'sidebarBackdrop', 'currentProjectName', 'sessionTitle', 'sessionOwner', 'contextBtn', 'shareBtn', 'accountMenu']) {
    assert.ok(index.includes(`id="${id}"`), `header element ${id}`);
  }
  // Nothing but the frame moved: the sidebar no longer carries nodes, settings or language.
  const sidebar = index.slice(index.indexOf('<aside'), index.indexOf('</aside>'));
  for (const id of ['nodesBtn', 'settingsBtn', 'langSwitch']) assert.ok(!sidebar.includes(`id="${id}"`), `${id} left the sidebar`);
  // settings: three groups plus the slot for the teams
  for (const group of ['services', 'people', 'rendering']) assert.ok(index.includes(`data-settings-group="${group}"`), `settings group ${group}`);
  assert.ok(index.includes('id="settingsTeamsSlot"'), 'slot for the teams in the settings');
  assert.match(shell, /href: 'help\.html'/, 'the menu links to the help');
  assert.match(shell, /addSection/, 'the menu can be extended (teams)');
  // the node view uses the same frame
  assert.match(nodes, /OCShell\.accountMenu\(\{ variant: 'nodes' \}\)/, 'node view builds the shared menu');
  assert.match(nodes, /mode-switch/, 'node view has the view switch');
  // no HTML from strings, no native dialogs in the frame
  assert.doesNotMatch(shell, /innerHTML|insertAdjacentHTML|outerHTML/, 'shell.js: no HTML from strings');
  assert.doesNotMatch(shell, /\b(?:window\.)?(?:confirm|alert|prompt)\(/, 'shell.js: no native dialogs');
  assert.doesNotMatch(shell, /kuble\.com|10\.\d+\.\d+\.\d+/i, 'shell.js: no internal names');
  assert.doesNotMatch(read('docs', 'agent-rules.md'), /kuble\.com/i, 'docs/agent-rules.md: no internal names');
}

testHelpPage();
console.log('ok testHelpPage');
testFrame();
console.log('ok testFrame');
console.log('help ok');
