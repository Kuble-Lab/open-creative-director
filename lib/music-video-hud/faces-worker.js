'use strict';

// The face finder of faces.js in a thread of its own (WP51): it looks at the grey frames of a file (framesArgs) one after the other and posts
// [{ frame, faces }] back, so that the server keeps answering while it works (a film of three minutes with many tags is some 750 frames at a few
// tens of milliseconds each). Reads one frame at a time: the file of a long film is a few hundred MB.

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const faces = require('./faces');

const { file, frames } = workerData;
const size = faces.GRID.w * faces.GRID.h;
const pixels = Buffer.alloc(size);
const fd = fs.openSync(file, 'r');
try {
  const out = frames.map((frame, index) => {
    const read = fs.readSync(fd, pixels, 0, size, index * size);
    return { frame, faces: read === size ? faces.findFaces(pixels) : [] };
  });
  parentPort.postMessage(out);
} finally {
  fs.closeSync(fd);
}
