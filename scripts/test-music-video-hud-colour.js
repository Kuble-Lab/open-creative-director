#!/usr/bin/env node
'use strict';

// Exercise the production graph without encoding loss, services or fixtures. Keep every filter and its format negotiation; only shrink the canvas
// and neutralise the intentional displacement for testsrc2. A flat colour also runs with the real shifts (which cannot change a uniform image).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const post = require('../lib/music-video-hud/postpass');
const { binaries } = require('../lib/ffmpeg');

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 48;
const PLANE = WIDTH * HEIGHT;
const FRAME_BYTES = PLANE * 3 / 2;
const LIMIT = 1.5;
const graphics = {
  start: 0, endFrame: FRAMES, theme: 'hud', cuts: [],
  music: { hits: [0.25, 0.75, 1.25].map((t) => ({ t, strength: 1 })) }
};
// Captured from the pre-fix command: no-glitch output must stay byte-for-byte compatible, including the audio and encoder options.
const plain = [];
for (const color_space of ['bt709', 'smpte170m']) for (const color_range of ['tv', 'pc']) {
  for (const grain of [0, 0.35]) for (const effects of ['off', 'strong']) {
    plain.push(post.buildPostArgs({ listFile: 'unused', songFile: 'unused', outFile: 'unused', graphics,
      inputColor: { color_space, color_range }, params: { effects, glitch: 0, grain } }));
  }
}
assert.equal(createHash('sha256').update(JSON.stringify(plain)).digest('hex'),
  '3aa7588bcbd9c32492837aa8df9c279d526d3299ff97d23d2997e399861991fe', 'no-glitch commands are unchanged');
console.log('ok no-glitch command fingerprint (16 variants)');
const windows = post.glitchWindows(graphics, { glitch: 0.6 });
const ffmpeg = binaries().ffmpeg;
assert.ok(ffmpeg, 'ffmpeg is required for the colour regression');
const version = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr);
console.log(version.stdout.split('\n')[0]);

function graph(inputColor, glitch, neutral) {
  const built = post.buildPostArgs({ listFile: 'unused', songFile: 'unused', outFile: 'unused', graphics,
    inputColor, params: { effects: 'off', glitch, grain: 0 } });
  let filter = built.filter.split(';[1:a]')[0].replace('scale=1920:1080', `scale=${WIDTH}:${HEIGHT}`)
    .replace(/crop=iw:(\d+):0:(\d+)/g, (_all, height, y) => `crop=iw:${height / 6}:0:${y / 6}`)
    .replace(/overlay=x=(-?\d+):y=(\d+)/g, (_all, x, y) => `overlay=x=${neutral ? 0 : Math.round(x / 6)}:y=${y / 6}`);
  if (neutral) filter = filter.replace(/rgbashift=[^,;\[]+/g, (shift) => shift.replace(/(rh|rv|gh|gv|bh|bv)=(-?\d+)/g, '$1=0'));
  return filter;
}

function render(source, matrix, range, filter) {
  // Create valid limited/full-range samples, with matching tags, before entering the production graph.
  const input = `${source}${source.includes('=') ? ':' : '='}s=${WIDTH}x${HEIGHT}:r=24:d=2,scale=in_color_matrix=bt601:in_range=tv:out_color_matrix=${matrix}:out_range=${range},format=yuv420p,setparams=colorspace=${matrix}:range=${range}`;
  const result = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', input,
    '-filter_complex', filter, '-map', '[v]', '-frames:v', String(FRAMES), '-threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'],
  { timeout: 5000, maxBuffer: FRAME_BYTES * FRAMES + 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`);
  assert.equal(result.stdout.length, FRAMES * FRAME_BYTES, 'every frame, including the tail, is present');
  return result.stdout;
}

function compare(reference, actual, active) {
  const worst = [0, 0, 0];
  let count = 0;
  let identical = true;
  for (let frame = 0; frame < FRAMES; frame++) {
    const time = frame / 24;
    if (windows.some((w) => time >= w.start && time < w.end) !== active) continue;
    count++;
    let offset = frame * FRAME_BYTES;
    for (let channel = 0; channel < 3; channel++) {
      const size = channel === 0 ? PLANE : PLANE / 4;
      let delta = 0;
      for (let i = offset; i < offset + size; i++) {
        delta += actual[i] - reference[i];
        if (actual[i] !== reference[i]) identical = false;
      }
      worst[channel] = Math.max(worst[channel], Math.abs(delta / size));
      offset += size;
    }
  }
  assert.equal(count, active ? 15 : 33, 'both sides of every glitch boundary are measured');
  return { worst, identical, count };
}

let failures = 0;
for (const matrix of ['bt709', 'smpte170m']) {
  for (const range of ['tv', 'pc']) {
    for (const [name, source, neutral] of [['flat', 'color=c=0x6090b0', false], ['pattern', 'testsrc2', true]]) {
      const label = `${matrix} ${range} ${name}`;
      try {
        const tags = { color_space: matrix, color_range: range };
        const reference = render(source, matrix, range, graph(tags, 0, neutral));
        const actual = render(source, matrix, range, graph(tags, 0.6, neutral));
        for (const active of [false, true]) {
          const { worst, identical, count } = compare(reference, actual, active);
          const passed = worst.every((delta) => delta < LIMIT) && (active || identical);
          console.log(`${passed ? 'ok' : 'FAIL'} ${label} ${active ? 'active' : 'inactive'} (${count} frames): max mean delta Y/U/V ${worst.map((delta) => delta.toFixed(4)).join('/')} / limit < ${LIMIT}${active ? '' : `; byte-identical=${identical}`}`);
          if (!passed) failures++;
        }
      } catch (error) {
        failures++;
        console.error(`FAIL ${label}: ${error.message}`);
      }
    }
  }
}
if (failures) {
  console.error(`${failures} colour checks failed`);
  process.exitCode = 1;
} else console.log('test-music-video-hud-colour.js: ok');
