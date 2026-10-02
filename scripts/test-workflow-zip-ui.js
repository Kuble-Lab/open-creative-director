'use strict';

// Export and import with files in the browser (public/nodes/archive-ui.js, main.js, workflow-list.js, api.js), WP29.
// No browser and no server: the logic without a DOM runs in a vm in three languages, the workflow list menu runs with a
// small fake DOM, and the wiring is checked as text.
//   - JSON or ZIP is recognised by extension and first bytes
//   - the menus offer both exports, the file pickers take .json and .zip
//   - the size note before a ZIP download and its hints (over 500 MB, over 200 files)
//   - the note after an import ("3 of 4 files imported, 1 missing") and the error texts for every code, in de, en, es
//   - progress card, no innerHTML, CSS classes defined, script order, keys present in all languages

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const LANGS = ['de', 'en', 'es'];
const MB = 1024 * 1024;
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ---------- the module in a vm ---------- */

class FakeElement {
  constructor(tag, attrs) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.textContent = '';
    const classes = new Set();
    this.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) };
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') this.textContent = String(value);
      else if (key === 'class') {
        this.attrs.class = value;
        for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
      } else this.attrs[key] = value;
    }
  }
  get className() {
    return this.attrs.class || '';
  }
  append(...nodes) {
    for (const node of nodes.flat()) if (node !== null && node !== undefined && node !== false) this.children.push(node);
  }
  remove() {
    this.removed = true;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ stopPropagation() {}, preventDefault() {} });
  }
  querySelector(selector) {
    const wanted = selector.replace(/^\./, '');
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child && child.classList && (child.classList.contains(wanted) || child.tag === wanted)) return child;
        const found = child && child.children ? walk(child) : null;
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  all(test, out = []) {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        if (test(child)) out.push(child);
        child.all(test, out);
      }
    }
    return out;
  }
}

function loadModule(lang, extra = {}) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    getLang: () => lang,
    ...extra
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  const el = (tag, attrs, ...children) => {
    const node = new FakeElement(tag, attrs);
    node.append(...children.map((child) => (typeof child === 'string' ? String(child) : child)));
    return node;
  };
  const ui = { el, icon: () => new FakeElement('svg'), T: (key, vars) => window.t(key, vars), menu: () => {}, ...(extra.ui || {}) };
  window.OCDNodes = { ui, api: { rel: (url) => url } };
  vm.runInNewContext(read('public/nodes/archive-ui.js'), { window, Intl, Uint8Array, Array, Math, Number, String }, { filename: 'public/nodes/archive-ui.js' });
  return { archive: window.OCDNodes.archiveUi, window, ui };
}

const modules = Object.fromEntries(LANGS.map((lang) => [lang, loadModule(lang)]));

/* ---------- which file is it ---------- */

function testKinds() {
  const { archive } = modules.en;
  const bytes = (...list) => new Uint8Array(list);
  const text = (value) => new Uint8Array(Buffer.from(value));
  assert.equal(archive.kindOfHead('a.zip', bytes(0x50, 0x4b, 3, 4)), 'zip');
  assert.equal(archive.kindOfHead('a.json', bytes(0x50, 0x4b, 3, 4)), 'zip', 'content wins over the extension');
  assert.equal(archive.kindOfHead('Flow.ocd-workflow.ZIP', bytes(0x50, 0x4b, 5, 6)), 'zip', 'an empty ZIP is still a ZIP');
  assert.equal(archive.kindOfHead('a.zip', text('{"nodes":[]}')), 'json', 'a JSON named .zip is JSON');
  assert.equal(archive.kindOfHead('a.txt', text('  \n [1]')), 'json');
  assert.equal(archive.kindOfHead('a.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), 'json', 'a BOM is skipped');
  assert.equal(archive.kindOfHead('broken.zip', text('not a zip at all')), 'zip', 'unknown content follows the extension, the server explains');
  assert.equal(archive.kindOfHead('broken.json', text('not json')), 'json');
  assert.equal(archive.kindOfHead('noextension', new Uint8Array(0)), 'json');
  assert.equal(archive.kindOfHead(undefined, undefined), 'json');
  assert.equal(archive.IMPORT_ACCEPT.split(',').includes('.json') && archive.IMPORT_ACCEPT.split(',').includes('.zip'), true, 'the picker takes .json and .zip');
  assert.equal(archive.MAX_ZIP_BYTES, 500 * MB);
  assert.equal(archive.MAX_JSON_BYTES, 2 * MB);
}

async function testDetectKind() {
  const { archive } = modules.en;
  const file = (name, content) => ({ name, slice: () => ({ arrayBuffer: async () => new Uint8Array(Buffer.from(content, 'latin1')).buffer }) });
  assert.equal(await archive.detectKind(file('x.json', 'PK\u0003\u0004rest')), 'zip');
  assert.equal(await archive.detectKind(file('x.zip', '{"a":1}')), 'json');
  assert.equal(await archive.detectKind({ name: 'x.zip', slice: () => ({ arrayBuffer: async () => { throw new Error('unreadable'); } }) }), 'zip', 'unreadable head: the extension decides');
}

/* ---------- sizes ---------- */

function testFormatBytes() {
  assert.equal(modules.en.archive.formatBytes(0), '0 B');
  assert.equal(modules.en.archive.formatBytes(1536 * 1024), '1.5 MB');
  assert.equal(modules.de.archive.formatBytes(1536 * 1024), '1,5 MB');
  assert.equal(modules.en.archive.formatBytes(500 * MB), '500 MB');
  assert.equal(modules.en.archive.formatBytes(2.5 * 1024 * MB), '2.5 GB');
  assert.equal(modules.en.archive.formatBytes(-1), '');
  assert.equal(modules.en.archive.formatBytes('x'), '');
}

/* ---------- the note before a ZIP download ---------- */

function testExportNote() {
  const info = { fileCount: 3, referenceCount: 4, missingCount: 1, totalBytes: 12 * MB, estimatedZipBytes: 12 * MB + 2048, limits: { maxZipBytes: 500 * MB, maxFiles: 200 }, exceedsImportSize: false, exceedsImportFiles: false };
  const expected = {
    de: '3 Dateien, 12 MB · Fehlende Dateien: 1',
    en: '3 files, 12 MB · Missing files: 1',
    es: '3 archivos, 12 MB · Archivos que faltan: 1'
  };
  for (const lang of LANGS) {
    const note = modules[lang].archive.exportNote(info);
    assert.equal(note.line, expected[lang], `${lang}: size line`);
    assert.deepEqual(plain(note.warnings), [], `${lang}: no warning below the limits`);
  }
  const noFiles = modules.de.archive.exportNote({ fileCount: 0, missingCount: 0, estimatedZipBytes: 900 });
  assert.equal(noFiles.line, 'Keine Dateien, 900 B');
  assert.equal(modules.en.archive.exportNote({ fileCount: 1, missingCount: 0, estimatedZipBytes: 2 * MB }).line, '1 file, 2 MB');
  assert.equal(modules.es.archive.exportNote({ fileCount: 1, missingCount: 0, estimatedZipBytes: 2 * MB }).line, '1 archivo, 2 MB');

  const big = { fileCount: 230, missingCount: 0, estimatedZipBytes: 700 * MB, limits: { maxZipBytes: 500 * MB, maxFiles: 200 }, exceedsImportSize: true, exceedsImportFiles: true };
  const warnings = {
    de: ['Das ZIP ist etwa 700 MB gross. Ein Import auf einem Server mit der Standardgrenze von 500 MB scheitert.', 'Das ZIP enthält 230 Dateien. Ein Import auf einem Server mit der Standardgrenze von 200 Dateien scheitert.'],
    en: ['The ZIP is about 700 MB. An import on a server with the default limit of 500 MB fails.', 'The ZIP holds 230 files. An import on a server with the default limit of 200 files fails.'],
    es: ['El ZIP pesa unos 700 MB. Una importación en un servidor con el límite estándar de 500 MB falla.', 'El ZIP contiene 230 archivos. Una importación en un servidor con el límite estándar de 200 archivos falla.']
  };
  for (const lang of LANGS) assert.deepEqual(plain(modules[lang].archive.exportNote(big).warnings), warnings[lang], `${lang}: hints over the limits`);
  const sizeOnly = modules.en.archive.exportNote({ ...big, fileCount: 5, exceedsImportFiles: false });
  assert.equal(sizeOnly.warnings.length, 1);
  assert.match(sizeOnly.warnings[0], /500 MB/);
  // without limits in the answer the default limits count
  assert.match(modules.en.archive.exportNote({ fileCount: 1, estimatedZipBytes: 600 * MB, exceedsImportSize: true }).warnings[0], /500 MB/);
}

// ---------- the note after an import ----------

function testFilesFeedback() {
  const files = (total, imported, missing) => ({ code: imported === total ? 'IMPORT_FILES_ALL' : imported === 0 ? 'IMPORT_FILES_MISSING' : 'IMPORT_FILES_PARTIAL', total, imported, missing, message: 'server text' });
  const cases = [
    [files(4, 3, 1), { de: '3 von 4 Dateien übernommen, 1 fehlt.', en: '3 of 4 files imported, 1 missing.', es: '3 de 4 archivos importados, falta 1.' }, 'warn'],
    [files(1, 0, 1), { de: '0 von 1 Datei übernommen, 1 fehlt.', en: '0 of 1 file imported, 1 missing.', es: '0 de 1 archivo importado, falta 1.' }, 'warn'],
    [files(5, 1, 4), { de: '1 von 5 Dateien übernommen, 4 fehlen.', en: '1 of 5 files imported, 4 missing.', es: '1 de 5 archivos importados, faltan 4.' }, 'warn'],
    [files(2, 2, 0), { de: '2 von 2 Dateien übernommen.', en: '2 of 2 files imported.', es: '2 de 2 archivos importados.' }, ''],
    [files(1, 1, 0), { de: '1 von 1 Datei übernommen.', en: '1 of 1 file imported.', es: '1 de 1 archivo importado.' }, '']
  ];
  for (const [input, texts, kind] of cases) {
    for (const lang of LANGS) {
      const feedback = modules[lang].archive.filesFeedback(input);
      assert.equal(feedback.text, texts[lang], `${lang}: ${JSON.stringify(input)}`);
      assert.equal(feedback.kind, kind);
    }
  }
  for (const lang of LANGS) {
    const { archive } = modules[lang];
    assert.equal(archive.filesFeedback({ code: 'IMPORT_FILES_NONE', total: 0, imported: 0, missing: 0, message: null }), null, 'no files, no note');
    assert.equal(archive.filesFeedback(undefined), null, 'an older server sends no `files`');
    assert.equal(archive.filesFeedback(null), null);
    // numbers that do not add up: the text of the server stands in
    assert.deepEqual(JSON.parse(JSON.stringify(archive.filesFeedback({ code: 'IMPORT_FILES_PARTIAL', total: 2, imported: 5, missing: 1, message: 'server text' }))), { text: 'server text', kind: 'warn' });
  }
}

/* ---------- error texts ---------- */

function errorOf(code, reason, params, status = 400) {
  return Object.assign(new Error('deutscher Satz des Servers'), { status, code, reason, params });
}

function testErrorTexts() {
  const archiveReasons = ['NOT_A_ZIP', 'NO_WORKFLOW_JSON', 'BAD_DIRECTORY', 'UNSAFE_PATH', 'LINK_ENTRY', 'DUPLICATE_ENTRY', 'UNLISTED_ENTRY', 'MISSING_ENTRY', 'SIZE_MISMATCH', 'CORRUPT_ENTRY', 'UNSUPPORTED_COMPRESSION', 'EMPTY_FILE', 'RATIO'];
  for (const lang of LANGS) {
    const { archive } = modules[lang];
    const seen = new Set();
    const check = (error, pattern, label) => {
      const text = archive.errorMessage(error);
      assert.ok(text && text.trim(), `${lang}: ${label} has a text`);
      assert.ok(!/nodes\.|\{[a-zA-Z]+\}|deutscher Satz/.test(text), `${lang}: ${label} is translated and filled in: ${text}`);
      if (pattern) assert.match(text, pattern, `${lang}: ${label}`);
      return text;
    };

    // too large: one text per reason, with the limit
    check(errorOf('TOO_LARGE', 'archive', { limitBytes: 500 * MB, limitMb: 500 }, 413), /500/, 'archive too large');
    check(errorOf('TOO_LARGE', 'file', { limitMb: 500 }, 413), /500/, 'file too large');
    check(errorOf('TOO_LARGE', 'unpacked', { limitMb: 1000 }, 413), /1000/, 'unpacked too large');
    check(errorOf('TOO_LARGE', 'workflow', { limitMb: 2 }, 413), /workflow\.json/, 'workflow.json too large');
    check(errorOf('TOO_LARGE', 'svg', { limitMb: 10 }, 413), /SVG/, 'svg too large');
    check(errorOf('TOO_LARGE', undefined, undefined, 413), /500/, 'too large without details');
    check(errorOf('TOO_LARGE', 'archive', { limitBytes: 100 * MB }, 413), /100/, 'limit from the bytes');
    assert.notEqual(archive.errorMessage(errorOf('TOO_LARGE', 'archive', { limitMb: 500 }, 413)), archive.errorMessage(errorOf('TOO_LARGE', 'file', { limitMb: 500 }, 413)));

    check(errorOf('TOO_MANY_FILES', undefined, { maxFiles: 200 }, 413), /200/, 'too many files');

    // invalid archive: one text per reason, the path when the server names one
    for (const reason of archiveReasons) {
      const text = check(errorOf('INVALID_ARCHIVE', reason), null, `invalid archive ${reason}`);
      assert.ok(!seen.has(text), `${lang}: ${reason} has its own text`);
      seen.add(text);
    }
    const general = check(errorOf('INVALID_ARCHIVE', 'SOMETHING_NEW'), null, 'unknown reason');
    assert.ok(!seen.has(general), `${lang}: unknown reasons get the general text`);
    assert.match(check(errorOf('INVALID_ARCHIVE', 'UNSAFE_PATH', { path: '../evil.png' }), null, 'with path'), /\(\.\.\/evil\.png\)\.$/, `${lang}: the path follows the sentence`);

    check(errorOf('INVALID_WORKFLOW', 'INVALID_DOCUMENT', { detail: 'English detail' }), null, 'invalid workflow');
    check(errorOf('UNSUPPORTED_MEDIA', 'TYPE', { path: 'files/001-a.exe' }, 415), /001-a\.exe/, 'unsupported type');
    const unreadable = check(errorOf('UNSUPPORTED_MEDIA', 'UNREADABLE', { path: 'files/002-b.svg' }, 415), /002-b\.svg/, 'unreadable');
    assert.notEqual(unreadable, archive.errorMessage(errorOf('UNSUPPORTED_MEDIA', 'TYPE', { path: 'files/002-b.svg' }, 415)));
    const mismatch = check(errorOf('UNSUPPORTED_MEDIA', 'MISMATCH', { path: 'files/001-a.mp4', node: 'n1', expected: 'image', found: 'video' }, 415), /001-a\.mp4/, 'file does not fit the node');
    assert.notEqual(mismatch, unreadable, `${lang}: the mismatch has its own text`);
    assert.notEqual(mismatch, archive.errorMessage(errorOf('UNSUPPORTED_MEDIA', 'TYPE', { path: 'files/001-a.mp4' }, 415)), `${lang}: and differs from the unsupported type`);
    check(errorOf('IMPORT_FAILED', undefined, undefined, 500), null, 'unexpected error');
    check(Object.assign(new Error('Aborted'), { status: 0, aborted: true }), null, 'cancelled');
    check(Object.assign(new Error('Network error'), { status: 0 }), null, 'network');

    // everything else keeps the message of the server
    assert.equal(archive.errorMessage(errorOf('NOT_FOUND', undefined, undefined, 404)), 'deutscher Satz des Servers');
    assert.equal(archive.errorMessage(new Error('plain')), 'plain');
    assert.equal(archive.errorMessage(null), '');
  }
  // texts differ between the languages
  const texts = LANGS.map((lang) => modules[lang].archive.errorMessage(errorOf('INVALID_ARCHIVE', 'NOT_A_ZIP')));
  assert.equal(new Set(texts).size, 3, 'three languages, three texts');
  assert.match(texts[0], /ZIP/);
}

/* ---------- progress card ---------- */

function testProgress() {
  const { archive } = modules.de;
  const host = new FakeElement('div');
  let cancelled = 0;
  const card = archive.createProgress({ host, name: 'Film.zip', total: 400 * MB, onCancel: () => cancelled++ });
  assert.equal(host.children.length, 1, 'the card sits in the overlay');
  const find = (name) => card.element.all((node) => node.classList.contains(name))[0];
  assert.match(find('nv-transfer-title').textContent, /Film\.zip.*0%/);
  card.update(0.25);
  assert.match(find('nv-transfer-title').textContent, /25%/);
  assert.equal(find('nv-transfer-bar').attrs['aria-valuenow'], '25');
  assert.equal(find('nv-transfer-bar').children[0].style.width, '25%');
  assert.equal(find('nv-transfer-detail').textContent, '100 MB von 400 MB');
  card.update(7);
  assert.equal(find('nv-transfer-bar').children[0].style.width, '100%', 'the bar never runs over');
  const cancel = find('nv-transfer-cancel');
  cancel.click();
  assert.equal(cancelled, 1, 'Cancel calls back');
  card.processing();
  assert.ok(card.element.classList.contains('is-processing'));
  assert.match(find('nv-transfer-title').textContent, /entpackt/);
  assert.equal(cancel.removed, true, 'no Cancel once the file is on the server');
  assert.equal(find('nv-transfer-bar').attrs['aria-valuenow'], undefined);
  card.close();
  assert.equal(card.element.removed, true);
}

/* ---------- the menu of the workflow list ---------- */

function testWorkflowListMenu() {
  const items = [];
  const calls = [];
  const { window, ui } = loadModule('de', { ui: { menu: (x, y, list) => items.push(...list) } });
  window.OCDNodes.ui = ui;
  const FakeDocument = { createElement: (tag) => new FakeElement(tag) };
  const sandbox = { window, document: FakeDocument };
  vm.runInNewContext(read('public/nodes/workflow-list.js'), sandbox, { filename: 'public/nodes/workflow-list.js' });
  const host = new FakeElement('div');
  const list = window.OCDNodes.workflowList.createWorkflowList({
    host,
    callbacks: { onExport: (workflow) => calls.push(['json', workflow.id]), onExportZip: (workflow) => calls.push(['zip', workflow.id]), onImport: (file) => calls.push(['import', file.name]) }
  });
  list.setData({ loading: false, error: null, workflows: [{ id: 'w1', name: 'Flow', nodeCount: 2, canManage: true }] });
  const named = (className) => host.all((node) => node.classList.contains(className));
  const row = named('nv-wf-item')[0];
  assert.ok(row, 'the list shows the workflow');
  row.listeners.contextmenu[0]({ preventDefault() {}, clientX: 10, clientY: 10 });
  const labels = items.filter((item) => item && item.label).map((item) => item.label);
  assert.ok(labels.includes('Exportieren (JSON)'), `the JSON export stays: ${labels.join(', ')}`);
  assert.ok(labels.includes('Exportieren mit Dateien (ZIP)'), 'the ZIP export is offered');
  assert.equal(labels.indexOf('Exportieren mit Dateien (ZIP)'), labels.indexOf('Exportieren (JSON)') + 1, 'the entries sit next to each other');
  items.find((item) => item && item.label === 'Exportieren (JSON)').onClick();
  items.find((item) => item && item.label === 'Exportieren mit Dateien (ZIP)').onClick();
  assert.deepEqual(calls, [['json', 'w1'], ['zip', 'w1']]);
  const picker = host.all((node) => node.tag === 'input')[1] || host.all((node) => node.tag === 'input')[0];
  assert.match(picker.attrs.accept, /\.json/);
  assert.match(picker.attrs.accept, /\.zip/);
  // the same row works for somebody who may not manage it
  items.length = 0;
  list.setData({ workflows: [{ id: 'w2', name: 'Shared', nodeCount: 1, canManage: false }] });
  named('nv-wf-item').find((node) => node.attrs.role === 'listitem' && node !== row).listeners.contextmenu[0]({ preventDefault() {}, clientX: 1, clientY: 1 });
  assert.ok(items.some((item) => item && item.label === 'Exportieren mit Dateien (ZIP)'), 'also for workflows shared with somebody');
}

/* ---------- wiring as text ---------- */

function definedClasses() {
  const css = read('public/nodes/nodes.css');
  return new Set([...css.matchAll(/\.(nv-[a-z0-9-]+)/g)].map((match) => match[1]));
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function testWiring() {
  const archiveSource = read('public/nodes/archive-ui.js');
  const main = read('public/nodes/main.js');
  const list = read('public/nodes/workflow-list.js');
  const apiSource = read('public/nodes/api.js');

  // no innerHTML, no native dialogs
  for (const [file, source] of [['archive-ui.js', archiveSource], ['main.js', main], ['workflow-list.js', list], ['api.js', apiSource]]) {
    const code = stripComments(source);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code), `${file}: no innerHTML`);
    assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(code.replace(/confirmDialog\(/g, '')), `${file}: no native dialogs`);
  }

  // CSS classes of the new card and dialog text exist
  const css = definedClasses();
  for (const name of ['nv-transfer', 'nv-transfer-title', 'nv-transfer-bar', 'nv-transfer-detail', 'nv-transfer-foot', 'nv-transfer-cancel', 'nv-dialog-warnings']) assert.ok(css.has(name), `CSS class ${name}`);
  for (const match of archiveSource.matchAll(/class:\s*'([^']*)'/g)) {
    for (const name of match[1].split(/\s+/)) if (/^nv-/.test(name)) assert.ok(css.has(name), `archive-ui.js: CSS class ${name}`);
  }
  for (const name of ['is-warn', 'is-processing']) assert.ok(read('public/nodes/nodes.css').includes(`.${name}`), `CSS state ${name}`);

  // script order: the module needs ui and api, the list needs the module
  const html = read('public/index.html');
  const order = ['nodes/api.js', 'nodes/node-ui.js', 'nodes/archive-ui.js', 'nodes/workflow-list.js', 'nodes/main.js'].map((name) => html.indexOf(`<script src="${name}"></script>`));
  assert.ok(order.every((index) => index > 0), 'all scripts are included');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'archive-ui.js comes after node-ui.js and before workflow-list.js');

  // the menu of the workflow in the header offers both exports, in front of the import
  const menu = main.slice(main.indexOf('function workflowMenu()'));
  const iJson = menu.indexOf("ui.T('nodes.list.export')");
  const iZip = menu.indexOf("ui.T('nodes.list.exportZip')");
  const iImport = menu.indexOf("ui.T('nodes.list.import')");
  assert.ok(iJson > 0 && iZip > iJson && iImport > iZip, 'workflow menu: JSON, ZIP, import');
  assert.match(menu.slice(iZip, iZip + 160), /exportWorkflowZip\(workflow\)/);
  // the list gets the callback
  assert.match(main, /onExportZip:\s*exportWorkflowZip/);
  assert.match(list, /cb\.onExportZip\(workflow\)/);

  // the pickers take .json and .zip from one place
  assert.match(main, /accept:\s*archiveUi\.IMPORT_ACCEPT/);
  assert.match(list, /accept:\s*OCD\.archiveUi\.IMPORT_ACCEPT/);
  assert.doesNotMatch(main, /accept:\s*'\.json,application\/json'/);

  // the ZIP goes through the raw route with progress; the download link and the size route exist
  assert.match(apiSource, /\/api\/workflows\/import-zip/);
  assert.match(apiSource, /application\/zip/);
  assert.match(apiSource, /export\.zip/);
  assert.match(apiSource, /export-info/);
  assert.match(apiSource, /error\.reason = payload\.reason/, 'request() hands reason and params on');
  assert.match(apiSource, /error\.params = payload\.params/);

  // import: one at a time, kind by content, size check before the upload, cancel, note, clean-up of the card
  const importPart = main.slice(main.indexOf('async function importZipFile'), main.indexOf('/* ---------- templates, projects, chat bridge'));
  assert.match(importPart, /archiveUi\.detectKind\(file\)/);
  assert.match(importPart, /MAX_ZIP_BYTES/);
  assert.match(importPart, /new AbortController\(\)/);
  assert.match(importPart, /onProgress:[\s\S]*progress\.update/);
  assert.match(importPart, /onUploaded:[\s\S]*progress\.processing/);
  assert.equal((importPart.match(/progress\.close\(\)/g) || []).length, 2, 'the card closes after success and after an error');
  assert.match(importPart, /if \(importing\)/);
  assert.match(importPart, /reportImport\(payload\)/);
  assert.equal((importPart.match(/reportImport\(payload\)/g) || []).length, 2, 'the note comes after the ZIP and after the JSON import');
  assert.match(main, /archiveUi\.filesFeedback\(payload\.files\)/);
  // the export asks the size first and flushes unsaved changes
  const exportPart = main.slice(main.indexOf('async function exportWorkflowZip'), main.indexOf('let importing'));
  assert.ok(exportPart.indexOf('flushSave') < exportPart.indexOf('api.exportInfo'), 'unsaved changes are saved before the size is asked');
  assert.ok(exportPart.indexOf('api.exportInfo') < exportPart.indexOf('api.exportZipUrl'), 'the size comes before the download');
  assert.match(exportPart, /note\.warnings\.length/);
  assert.match(exportPart, /ui\.confirmDialog/);
}

function testKeys() {
  const source = read('public/nodes/archive-ui.js') + read('public/nodes/main.js') + read('public/nodes/workflow-list.js');
  const keys = new Set([...source.matchAll(/(?:\bT|ui\.T)\('(nodes\.(?:import|export|list\.exportZip|toast\.(?:exportFailed|import)[A-Za-z]*)[A-Za-z.]*)'/g)].map((match) => match[1]));
  for (const match of read('public/nodes/archive-ui.js').matchAll(/'(nodes\.import\.[A-Za-z.]+)'/g)) keys.add(match[1]);
  assert.ok(keys.size >= 40, `keys found: ${keys.size}`);
  const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const key of keys) {
    const de = modules.de.window.I18N.de[key];
    assert.ok(de, `de: ${key}`);
    for (const lang of LANGS) {
      const text = modules[lang].window.I18N[lang][key];
      assert.ok(text && text.trim(), `${lang}: ${key}`);
      assert.equal(text.includes('ß'), false, `${lang}: ${key} has no sharp s`);
      assert.equal(placeholders(text), placeholders(de), `${lang}: ${key} keeps the placeholders`);
    }
  }
  // the three names of the export entries
  const names = LANGS.map((lang) => modules[lang].window.I18N[lang]['nodes.list.exportZip']);
  assert.deepEqual(names, ['Exportieren mit Dateien (ZIP)', 'Export with files (ZIP)', 'Exportar con archivos (ZIP)']);
  // the names of the file types of the old texts stay as they were
  assert.equal(modules.de.window.I18N.de['nodes.list.export'], 'Exportieren (JSON)');
}

// the help page and the README mention the export and the import with files
function testDocs() {
  const help = read('public/help.html');
  for (const needle of ['Exportieren mit Dateien (ZIP)', 'Export with files (ZIP)', 'Exportar con archivos (ZIP)']) assert.ok(help.includes(needle), `help.html: ${needle}`);
  assert.match(read('README.md'), /Export with files \(ZIP\)/);
  assert.match(read('README.de.md'), /Exportieren mit Dateien \(ZIP\)/);
  for (const file of ['public/help.html', 'README.md', 'README.de.md', 'public/nodes/archive-ui.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /ß/, `${file}: no sharp s`);
  }
}

async function main() {
  testKinds();
  await testDetectKind();
  testFormatBytes();
  testExportNote();
  testFilesFeedback();
  testErrorTexts();
  testProgress();
  testWorkflowListMenu();
  testWiring();
  testKeys();
  testDocs();
  console.log('test-workflow-zip-ui ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
