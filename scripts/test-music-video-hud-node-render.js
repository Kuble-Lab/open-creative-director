'use strict';

const { testNode } = require('./test-music-video-hud');

async function main() {
  const binaries = require('../lib/ffmpeg').binaries();
  if (binaries.available) await testNode(binaries, 'render');
  else console.log('skipped testNode render: ffmpeg is not installed');
  console.log('test-music-video-hud-node-render.js: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
