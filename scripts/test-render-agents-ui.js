'use strict';

// Interface of the own computers (WP46, public/render-agents-ui.js): the pure helpers, the texts in German, English and
// Spanish, the wiring in index.html and app.js, the safety rules (no HTML from strings, no native dialogs, nothing in
// storage, never a token), and the dialog "My computers" and the admin list driven in a small stand-in DOM against a fake
// API: code and both commands, rename, "also for my teams", "for everybody" only when allowed, removal in two clicks,
// errors as text, the code gone after closing. No browser, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { FakeNode } = require('./support/fake-dom');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// FakeNode with what the dialog uses beyond it.
class Node extends FakeNode {
  get childNodes() {
    return this.children;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.textValue = '';
    this.append(...nodes);
  }
  select() {
    this.selected = true;
  }
  scrollIntoView() {}
  click() {
    return this.fire('click');
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function load(lang = 'de', { me = { active: true, identified: true }, api = async () => ({}), clipboard = null } = {}) {
  const storage = new Map([['vcd-lang', lang]]);
  const byId = new Map();
  for (const id of ['renderAgentsModal', 'renderAgentsBody', 'renderAgentsClose']) {
    const node = new Node(id === 'renderAgentsClose' ? 'button' : 'div');
    node.setAttribute('id', id);
    byId.set(id, node);
  }
  byId.get('renderAgentsModal').classList.add('hidden');
  const sections = [];
  const requests = [];
  const document = {
    documentElement: { lang: '' },
    activeElement: null,
    listeners: {},
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => byId.get(id) || [...byId.values()].flatMap((node) => node.find((child) => child.getAttribute && child.getAttribute('id') === id))[0] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (document.listeners[type] = document.listeners[type] || []).push(fn);
    },
    execCommand: () => false
  };
  const timers = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  };
  const window = {
    document,
    navigator: { language: lang, userAgent: 'Mozilla/5.0 (Macintosh)', clipboard },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCAccess: {
      me: () => me,
      request: async (method, url, body) => {
        requests.push({ method, url, body });
        return api(method, url, body);
      }
    },
    OCShell: { addSection: (section, fn) => sections.push({ section, fn }) }
  };
  window.window = window;
  const context = { window, document, setTimeout: timers, clearTimeout, Date, Intl };
  vm.runInNewContext(read('public', 'i18n.js'), context, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public', 'render-agents-ui.js'), context, { filename: 'public/render-agents-ui.js' });
  return { window, document, byId, sections, requests, ui: window.OCRenderAgents, t: window.t };
}

// values made in the page's realm compared as plain data
const plain = (value) => JSON.parse(JSON.stringify(value));
const texts = (node) => node.find((child) => child.textValue).map((child) => child.textValue);
const byText = (node, text) => node.find((child) => child.textValue === text)[0];
const byClass = (node, name) => node.find((child) => child.classes && child.classes.has(name));

function testHelpers() {
  const { ui, t } = load();
  const { helpers } = ui;
  const at = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(helpers.lastSeenText('2026-10-09T11:59:30Z', at), t('agents.seenNow'));
  assert.equal(helpers.lastSeenText('2026-10-09T11:55:00Z', at), 'vor 5 Min.');
  assert.equal(helpers.lastSeenText('2026-10-09T09:00:00Z', at), 'vor 3 Std.');
  assert.match(helpers.lastSeenText('2026-10-01T09:00:00Z', at), /^am 01\.10\.2026/);
  assert.equal(helpers.lastSeenText(null, at), 'noch nie');
  assert.equal(helpers.platformText('darwin-arm64'), 'macOS (arm64)');
  assert.equal(helpers.platformText('win32-x64'), 'Windows (x64)');
  assert.equal(helpers.platformText('linux-x64'), 'Linux (x64)');
  assert.equal(helpers.platformText('unknown'), 'unbekannt');
  assert.equal(helpers.versionsText({ hyperframes: '0.8.139', ffmpeg: '6.0', node: '22.17.0' }), 'HyperFrames 0.8.139 · ffmpeg 6.0 · Node 22.17.0');
  assert.equal(helpers.versionsText(null), '');
  assert.equal(helpers.renderingText({ own: true, label: 'Film', progress: 0.42 }), 'rendert «Film» (42 %)');
  assert.equal(helpers.renderingText({ own: false, progress: 2 }), 'rendert einen Auftrag aus dem Team (100 %)', 'a foreign job shows no title');
  assert.equal(helpers.allowed({ active: false }), true, 'local mode');
  assert.equal(helpers.allowed({ active: true, identified: true, role: 'participant' }), true, 'everybody who is logged in');
  assert.equal(helpers.allowed({ active: true, identified: false }), false, 'not an anonymous visitor');
  for (const lang of ['de', 'en', 'es']) {
    const loaded = load(lang);
    for (const code of ['TOO_MANY_AGENTS', 'TOO_MANY_CODES', 'PACKAGE_MISSING', 'AGENT_NOT_FOUND', 'INVALID_NAME', 'FORBIDDEN']) {
      const text = loaded.ui.helpers.errorText({ status: 400, code });
      assert.notEqual(text, `agents.err.${code}`, `${lang}: text for ${code}`);
      assert.doesNotMatch(text, /\{[a-zA-Z]+\}/);
    }
    assert.match(loaded.ui.helpers.errorText({ status: 500, message: 'boom' }), /boom/);
    assert.equal(loaded.ui.helpers.errorText({ message: 'x' }), loaded.t('common.networkError'));
  }
}

function testTexts() {
  const { window } = load();
  const source = read('public', 'render-agents-ui.js');
  const index = read('public', 'index.html');
  const used = new Set();
  for (const match of source.matchAll(/'(agents\.[A-Za-z0-9.]+)'/g)) used.add(match[1]);
  for (const match of index.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="(agents\.[A-Za-z0-9.]+)"/g)) used.add(match[1]);
  const known = /KNOWN_ERRORS = \[([^\]]+)\]/.exec(source)[1].match(/[A-Z_]+/g);
  for (const code of known) used.add(`agents.err.${code}`);
  used.add('jobs.nodeWaiting');
  assert.match(read('public', 'app.js'), /t\('jobs\.nodeWaiting'\)/);
  assert.ok(used.size > 50, `expected many texts, found ${used.size}`);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of used) assert.ok(Object.prototype.hasOwnProperty.call(window.I18N[lang], key), `${lang} lacks ${key}`);
    const unused = Object.keys(window.I18N[lang]).filter((key) => key.startsWith('agents.') && !used.has(key));
    assert.deepEqual(unused, [], `${lang}: every agents.* text is used`);
    for (const [key, value] of Object.entries(window.I18N[lang])) {
      if (!key.startsWith('agents.') && key !== 'jobs.nodeWaiting') continue;
      assert.equal(value.includes('\u00df'), false, `${lang}.${key}: no sharp s`);
      if (lang === 'de') assert.doesNotMatch(value, /fuer |ueber|Auftraege|koennen|naechst|Rueck|spaeter|noetig|gueltig/i, `de.${key}: umlauts written as umlauts`);
    }
  }
  assert.equal(window.I18N.de['agents.title'], 'Meine Rechner');
  assert.equal(window.I18N.en['agents.title'], 'My computers');
  assert.equal(window.I18N.es['agents.title'], 'Mis ordenadores');
}

function testWiring() {
  const index = read('public', 'index.html');
  const app = read('public', 'app.js');
  const source = read('public', 'render-agents-ui.js');
  const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const wanted = [...source.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  const built = new Set(['agentsCommandBash', 'agentsCommandPs']); // the two command fields the dialog makes itself
  assert.deepEqual(wanted.filter((id) => !ids.has(id) && !built.has(id)), [], 'render-agents-ui.js reads only ids that index.html has');
  for (const id of ['renderAgentsModal', 'renderAgentsBody', 'renderAgentsClose', 'renderAgentsTitle', 'renderAgentsAdminList', 'renderAgentsAdminTitle']) assert.ok(ids.has(id), `index.html has #${id}`);
  assert.match(index, /<script src="render-agents-ui\.js"><\/script>/);
  assert.ok(index.indexOf('render-agents-ui.js') < index.indexOf('<script src="app.js"'), 'render-agents-ui.js loads before app.js');
  assert.match(app, /OCRenderAgents\.attach\(\)/);
  assert.match(app, /OCRenderAgents\.rerender\(\)/);
  assert.match(app, /OCRenderAgents\.renderAdminList\(document\.getElementById\('renderAgentsAdminList'\)/);
  assert.match(app, /job\.renderNodeId === 'render-queue' && !job\.nodeName/, 'a job waiting for a computer says so');
  assert.match(source, /OCShell\.addSection\('account'/);
  assert.doesNotMatch(source, /settingsModal|openSettingsModal/, 'the dialog is independent of the admin settings');
}

function testSafety() {
  const source = read('public', 'render-agents-ui.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, 'no HTML from strings');
  assert.doesNotMatch(source, /\b(?:window\.)?(?:confirm|alert|prompt)\(/, 'no native dialogs');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|location\./);
  assert.doesNotMatch(source, /console\.(?:log|info|debug)/);
  assert.doesNotMatch(source, /fetch\(/, 'every call goes through OCAccess.request (relative addresses)');
  assert.doesNotMatch(source, /\btoken\b(?!\s+of a computer never)/i, 'the interface never handles a token');
  const css = read('public', 'styles.css');
  for (const name of ['.agents-code-value', '.agents-command', '.agents-card.is-offline', '.settings-render-agents']) assert.ok(css.includes(name), `styles.css styles ${name}`);
}

async function testDialog() {
  const now = Date.now();
  const data = {
    agents: [
      { id: 'ra-aaaaaaaaaaaa', name: 'Studio Mac', online: true, lastSeenAt: new Date(now).toISOString(), platform: 'darwin-arm64', versions: { hyperframes: '0.8.139', ffmpeg: '6.0', node: '22.17.0' }, completed: 3, shareTeams: false, shareAll: false, rendering: [{ own: true, label: 'Sommerfilm', progress: 0.4 }] },
      { id: 'ra-bbbbbbbbbbbb', name: '<img src=x onerror=alert(1)>', online: false, lastSeenAt: new Date(now - 7200 * 1000).toISOString(), platform: 'win32-x64', versions: {}, completed: 0, shareTeams: true, shareAll: false, rendering: [], outdated: true }
    ],
    canShareTeams: true,
    canShareAll: false,
    packageAvailable: true,
    limits: { nameChars: 40 }
  };
  const pairing = { code: 'ABCD-EFGH', expiresAt: new Date(now + 600000).toISOString(), ttlSeconds: 600, commands: { bash: 'curl -fsSL https://app.example/api/render-agent/install.sh | bash -s -- --server https://app.example --code ABCD-EFGH', powershell: "& ([scriptblock]::Create((irm 'https://app.example/api/render-agent/install.ps1'))) -Server 'https://app.example' -Code 'ABCD-EFGH'" } };
  let failNext = null;
  const copied = [];
  const page = load('de', {
    clipboard: { writeText: async (text) => copied.push(text) },
    api: async (method, url) => {
      if (failNext) {
        const error = Object.assign(new Error('nein'), failNext);
        failNext = null;
        throw error;
      }
      if (method === 'GET' && url === '/api/render-agents') return data;
      if (method === 'POST' && url === '/api/render-agents/pairing-code') return pairing;
      return { ok: true };
    }
  });
  const { ui, byId, sections, requests, t } = page;
  ui.attach();
  ui.attach();
  assert.equal(sections.length, 1, 'one menu entry');
  assert.equal(sections[0].section, 'account');
  assert.equal(sections[0].fn({ me: { active: true, identified: true } })[0].label, 'Meine Rechner');
  assert.equal(sections[0].fn({ me: { active: true, identified: false } }).length, 0, 'nothing for an anonymous visitor');
  ui.open();
  await settle();
  const modal = byId.get('renderAgentsModal');
  const body = byId.get('renderAgentsBody');
  assert.equal(modal.classes.has('hidden'), false);
  assert.deepEqual(requests.map((entry) => `${entry.method} ${entry.url}`), ['GET /api/render-agents']);
  let all = texts(body);
  assert.ok(all.includes('Studio Mac'));
  assert.ok(all.includes('rendert «Sommerfilm» (40 %)'));
  assert.ok(all.includes('<img src=x onerror=alert(1)>'), 'a name is text, never HTML');
  assert.ok(all.includes('vor 2 Std.'));
  assert.ok(all.includes(t('agents.outdated')));
  assert.ok(all.includes('macOS (arm64) · HyperFrames 0.8.139 · ffmpeg 6.0 · Node 22.17.0'));
  assert.ok(all.includes(t('agents.shareTeams')));
  assert.ok(!all.includes(t('agents.shareAll')), 'for everybody: not offered to a person who may not');
  // a code with the two commands
  byText(body, t('agents.connect.button')).click();
  await settle();
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/render-agents/pairing-code');
  all = texts(body);
  assert.ok(all.includes('ABCD-EFGH'));
  const areas = body.find((node) => node.tagName === 'TEXTAREA');
  assert.deepEqual(areas.map((area) => area.value), [pairing.commands.bash, pairing.commands.powershell]);
  assert.ok(areas.every((area) => area.hasAttribute('readonly')));
  byText(body, t('agents.connect.copy')).click();
  await settle();
  assert.deepEqual(copied, [pairing.commands.bash]);
  // rename and "also for my teams"
  const card = body.find((node) => node.dataset && node.dataset.agent === 'ra-aaaaaaaaaaaa')[0];
  const nameInput = card.find((node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'text')[0];
  nameInput.value = '  Neuer   Name ';
  byText(card, t('agents.save')).click();
  await settle();
  assert.deepEqual(plain(requests.find((entry) => entry.method === 'PATCH')), { method: 'PATCH', url: '/api/render-agents/ra-aaaaaaaaaaaa', body: { name: 'Neuer Name' } });
  const card2 = body.find((node) => node.dataset && node.dataset.agent === 'ra-aaaaaaaaaaaa')[0];
  const teams = card2.find((node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox')[0];
  teams.checked = true;
  teams.fire('change');
  await settle();
  assert.deepEqual(plain(requests.filter((entry) => entry.method === 'PATCH').at(-1).body), { shareTeams: true });
  // an error is shown as text
  failNext = { status: 409, code: 'TOO_MANY_AGENTS' };
  byText(body, t('agents.connect.again')).click();
  await settle();
  assert.ok(texts(body).includes(t('agents.err.TOO_MANY_AGENTS')));
  // removal: the first click only asks
  const card3 = body.find((node) => node.dataset && node.dataset.agent === 'ra-bbbbbbbbbbbb')[0];
  const remove = byText(card3, t('agents.remove'));
  const before = requests.length;
  remove.click();
  assert.equal(remove.textContent, t('agents.removeConfirm'));
  assert.equal(requests.length, before, 'nothing removed after one click');
  remove.click();
  await settle();
  assert.deepEqual(plain(requests[before]), { method: 'DELETE', url: '/api/render-agents/ra-bbbbbbbbbbbb' });
  // closing drops the code
  ui.close();
  assert.equal(modal.classes.has('hidden'), true);
  ui.open();
  assert.ok(!texts(body).includes('ABCD-EFGH'), 'the code is not shown a second time');
  ui.close();
  // the package is missing on the server: no code button, a clear message
  data.packageAvailable = false;
  ui.open();
  await settle();
  assert.ok(texts(body).includes(t('agents.err.PACKAGE_MISSING')));
  assert.equal(byText(body, t('agents.connect.button')), undefined);
  ui.close();
}

async function testAdminList() {
  const page = load('en');
  const { ui, requests, t } = page;
  const container = new Node('div');
  const changes = [];
  ui.renderAdminList(container, [], {});
  assert.deepEqual(texts(container), [t('agents.admin.empty')]);
  ui.renderAdminList(container, [
    { id: 'ra-cccccccccccc', name: 'Ben PC', owner: 'ben@example.com', online: true, platform: 'win32-x64', versions: { hyperframes: '0.8.139' }, completed: 7, shareTeams: true, shareAll: false, rendering: [{ own: false, progress: 0.1 }] }
  ], { onChanged: (message, options) => changes.push([message, options]) });
  const all = texts(container);
  assert.ok(all.includes('Ben PC'));
  assert.ok(all.includes('ben@example.com · Windows (x64)'));
  assert.ok(all.some((text) => text.includes(t('agents.admin.completed', { count: 7 })) && text.includes(t('agents.badgeTeams')) && text.includes('HyperFrames 0.8.139')));
  assert.equal(byClass(container, 'render-node-manager-dot')[0].classes.has('rendering'), true);
  const remove = byText(container, t('agents.remove'));
  remove.click();
  remove.click();
  await settle();
  assert.deepEqual(plain(requests.at(-1)), { method: 'DELETE', url: '/api/render-agents/ra-cccccccccccc' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0][0], t('agents.removed', { name: 'Ben PC' }));
}

async function main() {
  testHelpers();
  testTexts();
  testWiring();
  testSafety();
  await testDialog();
  await testAdminList();
  console.log('Oberfläche der eigenen Rechner: Helfer, Texte in drei Sprachen, Verdrahtung, Sicherheit, Dialog und Admin-Liste sind korrekt.');
  console.log('test-render-agents-ui.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
