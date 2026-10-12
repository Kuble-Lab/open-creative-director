'use strict';

// The tool facade and its implementation modules, in dependency load order, for source contract tests.
const fs = require('fs');
const path = require('path');

const TOOL_SOURCE_FILES = [
  'lib/tools/shared.js',
  'lib/tools/images-assets.js',
  'lib/tools/video-fal.js',
  'lib/tools/audio.js',
  'lib/tools/render.js',
  'lib/tools/higgsfield.js',
  'lib/tools/definitions.js',
  'lib/tools.js'
];

function toolsSource() {
  return TOOL_SOURCE_FILES.map((file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8')).join('\n');
}

module.exports = { TOOL_SOURCE_FILES, toolsSource };
