'use strict';

// Interface of the agent access (public/mcp-ui.js): the pure helpers, the texts in German, English and Spanish, the wiring
// in index.html and app.js and the safety rules (no HTML from strings, no native dialogs, no secret in storage).
// The dialog itself is checked in a real browser against an isolated app copy; this test needs no browser and no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function load(lang = 'de') {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  window.window = window;
  vm.runInNewContext(read('public', 'i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public', 'mcp-ui.js'), { window, document: window.document }, { filename: 'public/mcp-ui.js' });
  return window;
}

function testHelpers() {
  const { helpers } = load().OCMcp;
  assert.equal(helpers.parseAmount('2'), 2);
  assert.equal(helpers.parseAmount(' 2,5 '), 2.5);
  assert.equal(helpers.parseAmount('0'), 0);
  assert.equal(helpers.parseAmount(''), null, 'empty: the server default applies');
  assert.ok(Number.isNaN(helpers.parseAmount('abc')));
  assert.ok(Number.isNaN(helpers.parseAmount('-1')));
  assert.ok(Number.isNaN(helpers.parseAmount('1e3')));
  assert.equal(helpers.parseDays('90'), 90);
  assert.equal(helpers.parseDays(''), null);
  assert.ok(Number.isNaN(helpers.parseDays('1.5')));
  assert.equal(helpers.daysLeft('2026-01-11T00:00:00Z', Date.parse('2026-01-01T00:00:00Z')), 10);
  assert.equal(helpers.daysLeft('2025-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z')), 0);

  const command = helpers.claudeCommand('https://app.example.com/mcp', '<Schlüssel>');
  assert.equal(command, 'claude mcp add --transport http open-creator https://app.example.com/mcp --header "Authorization: Bearer <Schlüssel>"');

  // Who sees the menu entry: admins and internal people, the local mode; not participants and guests.
  assert.equal(helpers.allowed({ active: false }), true, 'local mode');
  assert.equal(helpers.allowed({ active: true, isAdmin: true, role: 'admin' }), true);
  assert.equal(helpers.allowed({ active: true, isAdmin: false, role: 'user' }), true, 'internal person');
  assert.equal(helpers.allowed({ active: true, isAdmin: false, role: 'participant' }), false);
  assert.equal(helpers.allowed({ active: true, isAdmin: false, role: 'guest' }), false);
  assert.equal(helpers.allowed({ active: true, isAdmin: false, role: 'anonymous' }), false);
}

function testErrors() {
  const keysSource = read('lib', 'mcp', 'keys.js') + read('lib', 'mcp', 'key-routes.js');
  const codes = new Set([...keysSource.matchAll(/'((?:INVALID_(?:NAME|RIGHT|LIMIT|EXPIRY)|TOO_MANY_KEYS|KEY_NOT_FOUND|KEY_REVOKED|KEY_STORE_UNAVAILABLE|FORBIDDEN_FOR_ROLE))'/g)].map((match) => match[1]));
  assert.ok(codes.size >= 8, `the key API names its error codes (${[...codes].join(', ')})`);
  for (const lang of ['de', 'en', 'es']) {
    const window = load(lang);
    for (const code of codes) {
      const text = window.OCMcp.helpers.errorText({ status: 400, code }, { nameChars: 80, maxRunUsd: 1000, maxMonthUsd: 10000, maxExpiresInDays: 365 });
      assert.notEqual(text, `mcp.err.${code}`, `${lang}: text for ${code}`);
      assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${lang}: ${code} has no open placeholder`);
    }
    assert.match(window.OCMcp.helpers.errorText({ status: 500, message: 'boom' }, null), /boom/, `${lang}: unknown error shows the message`);
    assert.equal(window.OCMcp.helpers.errorText({ message: 'x' }, null), window.t('common.networkError'), `${lang}: no status, no code: network`);
  }
}

function testTexts() {
  const window = load();
  const source = read('public', 'mcp-ui.js');
  const index = read('public', 'index.html');
  const used = new Set();
  for (const match of source.matchAll(/'(mcp\.[A-Za-z0-9.]+)'/g)) used.add(match[1]);
  for (const match of source.matchAll(/\btr\(`(mcp\.[A-Za-z0-9.]+)\$\{/g)) used.add(`${match[1]}`);
  for (const match of index.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="(mcp\.[A-Za-z0-9.]+)"/g)) used.add(match[1]);
  for (const key of ['mcp.right.read', 'mcp.right.start', 'mcp.status.active', 'mcp.status.revoked', 'mcp.status.expired', 'mcp.status.ownerInvalid']) used.add(key);
  assert.ok(used.size > 50, `expected many texts, found ${used.size}`);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of used) {
      if (key.endsWith('.')) continue; // prefix of a built key
      assert.ok(Object.prototype.hasOwnProperty.call(window.I18N[lang], key), `${lang} lacks ${key}`);
    }
  }
  // Nothing in the dictionaries that the file does not use (no stale texts), apart from the error codes built from a table.
  const unused = Object.keys(window.I18N.de).filter((key) => key.startsWith('mcp.') && !used.has(key) && !key.startsWith('mcp.err.'));
  assert.deepEqual(unused, [], 'every mcp.* text is used');
  // Real umlauts, no sharp s, in all three languages.
  for (const lang of ['de', 'en', 'es']) {
    for (const [key, value] of Object.entries(window.I18N[lang])) {
      if (!key.startsWith('mcp.')) continue;
      assert.equal(value.includes('ß'), false, `${lang}.${key}: no sharp s`);
      if (lang === 'de') assert.doesNotMatch(value, /Schluessel|waehl|Gueltig|fuer |ueber|koennen|Laeuft|Maerz/i, `de.${key}: umlauts written as umlauts`);
    }
  }
  assert.match(window.I18N.de['mcp.title'], /Agent-Zugang \(MCP\)/);
  assert.match(window.I18N.en['mcp.title'], /Agent access \(MCP\)/);
}

function testWiring() {
  const index = read('public', 'index.html');
  const app = read('public', 'app.js');
  const source = read('public', 'mcp-ui.js');
  const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const wanted = [...source.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(wanted.filter((id) => !ids.has(id)), [], 'mcp-ui.js reads only ids that index.html has');
  for (const id of ['mcpModal', 'mcpBody', 'mcpClose', 'mcpTitle']) assert.ok(ids.has(id), `index.html has #${id}`);
  assert.match(index, /<script src="mcp-ui\.js"><\/script>/, 'index.html loads mcp-ui.js');
  assert.ok(index.indexOf('mcp-ui.js') < index.indexOf('app.js'), 'mcp-ui.js loads before app.js');
  assert.match(app, /OCMcp\.attach\(\)/, 'app.js adds the menu entry');
  assert.match(app, /OCMcp\.rerender\(\)/, 'app.js redraws the dialog on a language change');
  assert.match(source, /OCShell\.addSection\('account'/, 'the entry is in the account section of the menu');
  // The settings dialog is for admins only; the key dialog must not depend on it.
  assert.doesNotMatch(source, /settingsModal|openSettingsModal/, 'the dialog is independent of the admin settings');
}

function testSafety() {
  const source = read('public', 'mcp-ui.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, 'no HTML from strings');
  assert.doesNotMatch(source, /\b(?:window\.)?(?:confirm|alert|prompt)\(/, 'no native dialogs');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(?:push|replace)State|location\./, 'the secret is never stored and never put in the address bar');
  assert.doesNotMatch(source, /console\.(?:log|info|debug)/, 'no logging of data');
  assert.doesNotMatch(source, /fetch\(`?\//, 'relative URLs only (works under a sub-path)');
  // The key is created only through the API call and shown from memory; closing the dialog drops it.
  assert.match(source, /state\.secret = null;[\s\S]{0,120}state\.revealed = false;[\s\S]{0,80}state\.isOpen = false/, 'closing the dialog drops the secret');
  const css = read('public', 'styles.css');
  assert.match(css, /\.mcp-panel\b/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.mcp-form/, 'a narrow layout for the form');
  for (const file of ['public/mcp-ui.js', 'public/index.html']) {
    assert.doesNotMatch(read(...file.split('/')), /\.internal\b|10\.\d+\.\d+\.\d+/i, `${file}: no internal names or addresses`);
  }
}

// The proxy rule in the READMEs names the paths exactly: a plain "location /mcp" would also release /mcp-ui.js.
function testDocs() {
  for (const file of ['README.md', 'README.de.md']) {
    const text = read(file);
    assert.match(text, /location = \/mcp`/, `${file}: names location = /mcp`);
    assert.match(text, /location \^~ \/mcp\/`/, `${file}: names location ^~ /mcp/`);
    assert.match(text, /location \/mcp`[^.]*\/mcp-ui\.js/, `${file}: warns against a plain location /mcp`);
    assert.doesNotMatch(text, /(?:whole prefix|ganze Präfix) `\/mcp`/, `${file}: no vague prefix rule`);
    assert.match(text, /test-mcp-limits\.js/, `${file}: names the limits test`);
  }
  // the help page: the upload limits in all three languages
  const help = read('public', 'help.html');
  for (const pattern of [/Hochgeladene Dateien bleiben sieben Tage/, /Uploaded files are kept for seven days/, /Los archivos subidos se conservan siete días/]) {
    assert.match(help, pattern);
  }
}

testHelpers();
testErrors();
testTexts();
testWiring();
testSafety();
testDocs();
console.log('test-mcp-ui.js: ok');
