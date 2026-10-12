'use strict';

const { testNode } = require('./test-music-video-hud');

async function main() {
  const binaries = require('../lib/ffmpeg').binaries();
  if (binaries.available) await testNode(binaries, 'options');
  else console.log('skipped testNode options: ffmpeg is not installed');
  console.log('test-music-video-hud-node-options.js: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
