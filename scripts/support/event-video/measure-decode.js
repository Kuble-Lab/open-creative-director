#!/usr/bin/env node
'use strict';

// Synthetic clips only, two decoder threads, no network. Encoding is outside the measured interval.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpeg = require('../../../lib/ffmpeg');
const { decodeArgs } = require('../../../lib/event-video/analyze');

async function main() {
  const seconds = Number(process.argv[2] || 5);
  if (!(seconds > 0 && seconds <= 60)) throw new Error('Duration must be 1..60 seconds');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'event-decode-'));
  try {
    const binary = ffmpeg.binaries().ffmpeg;
    const results = [];
    for (const [name, width, height, codec] of [['1080p H.264', 1920, 1080, 'libx264'], ['4K HEVC', 3840, 2160, 'libx265']]) {
      const file = path.join(scratch, `${codec}.mp4`), rawFile = path.join(scratch, `${codec}.gray`);
      await ffmpeg.runProcess(binary, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24`,
        '-t', String(seconds), '-c:v', codec, '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        ...(codec === 'libx265' ? ['-x265-params', 'pools=2:frame-threads=1:log-level=error'] : []), file]);
      const built = decodeArgs({ file, rawFile, seconds, width, height, photo: false });
      const start = performance.now();
      await ffmpeg.runProcess('nice', ['-n', '10', binary, ...built.args]);
      const decodeSeconds = (performance.now() - start) / 1000;
      results.push({ name, seconds, decoderThreads: 2, sampleFps: built.rate, frames: (await fs.stat(rawFile)).size / (built.width * built.height),
        decodeSeconds: +decodeSeconds.toFixed(3), realtimeFactor: +(seconds / decodeSeconds).toFixed(2) });
    }
    console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { main };
