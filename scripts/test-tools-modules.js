'use strict';

// Public tool contract after extracting implementations: names, types, identity and acyclic eager imports.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { TOOL_SOURCE_FILES } = require('./support/tools-source');
const tools = require('../lib/tools');

const EXPECTED_INTERFACE = [
  ['toolDefinitions', 'function'],
  ['executeTool', 'function'],
  ['createImage', 'function'],
  ['shorten', 'function'],
  ['buildVideoPayload', 'function'],
  ['renderAssetsFromIds', 'function'],
  ['validateConcatArgs', 'function'],
  ['concatStrategy', 'function'],
  ['MAX_RENDER_ASSET_BYTES', 'number'],
  ['storeImportedSessionAsset', 'function'],
  ['parseJsonLoose', 'function'],
  ['RENDER_MOTION_GRAPHICS_DEFINITION', 'object'],
  ['libraryVoices', 'function'],
  ['musicEstimateUsd', 'function'],
  ['speechEstimateUsd', 'function'],
  ['lyricsTimingUsd', 'function'],
  ['timingDetectsVoices', 'function'],
  ['TIMING_METHODS', 'object'],
  ['TIMING_VOICES', 'object'],
  ['TIMING_MAX_SECONDS', 'number'],
  ['toolEstimateUsd', 'function'],
  ['IMAGE_RATIOS', 'object'],
  ['VIDEO_RATIOS', 'object'],
  ['VIDEO_RESOLUTIONS', 'object'],
  ['MAX_RENDER_ASSETS', 'number'],
  ['MAX_CONCAT_ASSETS', 'number'],
  ['RENDER_FORMATS', 'object'],
  ['DEFAULT_ELEVENLABS_VOICE_ID', 'string'],
  ['DEFAULT_ELEVENLABS_MODEL_ID', 'string'],
  ['HIGGSFIELD_DEFAULT_AUDIO_MODEL', 'string'],
  ['HIGGSFIELD_SPEECH_MODELS', 'object'],
  ['HIGGSFIELD_SPEECH_FORMATS', 'object'],
  ['HIGGSFIELD_SPEECH_VARIANTS', 'object'],
  ['HIGGSFIELD_MAX_SPEECH_REFS', 'number'],
  ['HIGGSFIELD_MAX_AUDIO_REFS', 'number'],
  ['HIGGSFIELD_AUDIO_REFERENCE_ROLE', 'string'],
  ['HIGGSFIELD_DUBBING_LANGUAGES', 'object'],
  ['HIGGSFIELD_VOICE_TYPES', 'object'],
  ['HIGGSFIELD_MOTION_RESOLUTIONS', 'object'],
  ['HIGGSFIELD_GENJUTSU_RESOLUTIONS', 'object'],
  ['HIGGSFIELD_GENJUTSU_MAX_IMAGES', 'number'],
  ['HIGGSFIELD_GENJUTSU_MIN_SECONDS', 'number'],
  ['HIGGSFIELD_GENJUTSU_MAX_SECONDS', 'number'],
  ['HIGGSFIELD_SCENE_CONTROLS', 'object'],
  ['FAL_MAX_MEDIA_FILES', 'number'],
  ['FAL_UPLOAD_MIME', 'object'],
  ['audioRoleFromModel', 'function'],
  ['audioSlotFromModel', 'function'],
  ['parseHiggsfieldUpload', 'function']
];
assert.deepEqual(Object.entries(tools).map(([name, value]) => [name, typeof value]), EXPECTED_INTERFACE);

const root = path.resolve(__dirname, '..');
const files = new Set(TOOL_SOURCE_FILES.map((file) => path.join(root, file)));
const visited = new Set();
const active = new Set();
function checkImports(file) {
  assert.ok(!active.has(file), `Eager circular tool import: ${file}`);
  if (visited.has(file)) return;
  active.add(file);
  const mod = require.cache[file];
  assert.ok(mod && mod.loaded, `Tool module is fully loaded: ${file}`);
  for (const child of mod.children) if (files.has(child.filename)) checkImports(child.filename);
  active.delete(file);
  visited.add(file);
}
checkImports(require.resolve('../lib/tools'));
assert.equal(visited.size, TOOL_SOURCE_FILES.length, 'The source helper includes every loaded tool module');
assert.deepEqual(
  fs.readdirSync(path.join(root, 'lib/tools')).filter((file) => file.endsWith('.js')).sort(),
  TOOL_SOURCE_FILES.filter((file) => file.startsWith('lib/tools/')).map((file) => path.basename(file)).sort()
);

// The facade exposes the implementation objects themselves, including mutable arrays and schema objects.
for (const file of files) {
  if (file === require.resolve('../lib/tools')) continue;
  for (const [name, value] of Object.entries(require(file))) {
    assert.notEqual(value, undefined, `${file}: ${name} is initialized`);
    if (Object.hasOwn(tools, name)) assert.strictEqual(tools[name], value, `Facade identity: ${name}`);
  }
}
assert.strictEqual(tools.concatStrategy, require('../lib/ffmpeg').concatStrategy);
assert.strictEqual(tools.RENDER_FORMATS, require('../public/nodes/motion-html').FORMATS);

console.log('test-tools-modules.js: ok');
