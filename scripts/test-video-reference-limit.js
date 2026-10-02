'use strict';

const assert = require('assert/strict');

const { toolDefinitions, executeTool } = require('../lib/tools');

async function main() {
  const definition = toolDefinitions().find((item) => item.function?.name === 'generate_video');
  const refs = definition.function.parameters.properties.reference_asset_ids;
  assert.equal(refs.maxItems, 30);
  assert.match(refs.description, /up to 30 reference images/);

  await assert.rejects(
    executeTool(
      { sessionId: 'nicht-verwendet', config: {}, emit() {} },
      'generate_video',
      { prompt: 'Test', reference_asset_ids: Array.from({ length: 31 }, (_, index) => `img-${index}`) }
    ),
    /maximal 30 reference_asset_ids/
  );
  console.log('Video-Referenzen: Schema und Executor begrenzen auf 30 Assets.');
  console.log('test-video-reference-limit.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
