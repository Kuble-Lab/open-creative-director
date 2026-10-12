'use strict';

// The node-view entry point and its parts, in the same order as public/index.html.
const fs = require('node:fs');
const path = require('node:path');

const nodeMainFiles = [
  'main-state.js',
  'main-design-app.js',
  'main-workflow.js',
  'main-editing.js',
  'main-library.js',
  'main-chrome.js',
  'main.js'
];

function readNodeMainSource() {
  return nodeMainFiles.map((file) => fs.readFileSync(path.join(__dirname, '../../public/nodes', file), 'utf8')).join('\n');
}

module.exports = { nodeMainFiles, readNodeMainSource };
