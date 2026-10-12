'use strict';

// Read the chat's classic scripts in the same order as public/index.html for source-level tests.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function appScriptFiles() {
  const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  return [...index.matchAll(/<script src="(app(?:-[a-z]+)?\.js)"><\/script>/g)]
    .map((match) => `public/${match[1]}`);
}

function readAppSource() {
  return appScriptFiles().map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
}

module.exports = { appScriptFiles, readAppSource };
