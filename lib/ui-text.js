'use strict';

// The server uses the same interface dictionary as the browser, without DOM effects.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let dictionaries;
function uiText(lang, key) {
  if (!dictionaries) {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), { window });
    dictionaries = window.I18N;
  }
  return dictionaries[lang]?.[key] || dictionaries.de[key] || key;
}
module.exports = { uiText };
