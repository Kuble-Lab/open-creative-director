'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const storage = new Map([['vcd-lang', 'de']]);
const document = {
  documentElement: { lang: '' },
  querySelectorAll() { return []; }
};
const window = {
  document,
  navigator: { language: 'de-CH' },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); }
  }
};

vm.runInNewContext(source, { window }, { filename: 'public/i18n.js' });

const languages = ['de', 'en', 'es'];
const baseKeys = Object.keys(window.I18N.de).sort();
for (const lang of languages) {
  assert.deepEqual(Object.keys(window.I18N[lang]).sort(), baseKeys, `${lang} hat eine abweichende Key-Menge`);
  for (const [key, value] of Object.entries(window.I18N[lang])) {
    assert.equal(typeof value, 'string', `${lang}.${key} ist kein String`);
    assert.equal(value.includes('\u00df'), false, `${lang}.${key} enthaelt ein scharfes s`);
  }
}

assert.equal(window.t('test.unknown.key'), 'test.unknown.key', 'Unbekannte Keys muessen auf den Key selbst zurueckfallen');
storage.delete('vcd-lang');
window.navigator.language = 'es-MX';
assert.equal(window.getLang(), 'es', 'Spanische Browser-Sprache wurde nicht erkannt');
window.navigator.language = 'fr-CH';
assert.equal(window.getLang(), 'de', 'Unbekannte Browser-Sprache muss auf Deutsch zurueckfallen');
assert.equal(window.setLang('en'), 'en');
assert.equal(storage.get('vcd-lang'), 'en', 'setLang muss die Sprache speichern');

const referencedKeys = new Set();
const attributePattern = /\bdata-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;
for (const match of html.matchAll(attributePattern)) referencedKeys.add(match[1]);
for (const key of referencedKeys) {
  assert.ok(Object.prototype.hasOwnProperty.call(window.I18N.de, key), `index.html referenziert fehlenden de-Key: ${key}`);
}

console.log(`i18n ok: ${baseKeys.length} identische Keys in DE/EN/ES, ${referencedKeys.size} HTML-Referenzen geprueft`);
