'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { extractVideoFrames } = require('../lib/poller');

const execFileAsync = promisify(execFile);

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-frames-'));
  const video = path.join(dir, 'test.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=25',
      '-t',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ]);
    const frames = await extractVideoFrames(video);
    assert.equal(frames.length, 3);
    for (const frame of frames) {
      assert.ok(Buffer.isBuffer(frame));
      assert.ok(frame.length > 0);
      assert.equal(frame[0], 0xff);
      assert.equal(frame[1], 0xd8);
    }
    console.log(`Video-Frames: 3 JPEG-Buffer extrahiert (${frames.map((frame) => frame.length).join(', ')} Bytes).`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
