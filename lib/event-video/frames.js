'use strict';

// Small grey frames, read one at a time in a worker. No raw clip is held in memory.
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { MAX_SCENES } = require('./contract');
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n * 1000) / 1000;
const mean = (list) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;

function frameMetrics(pixels, width, height) {
  const histogram = Array(32).fill(0), x = Array(width).fill(0), y = Array(height).fill(0);
  let sum = 0, lap = 0, lap2 = 0, count = 0;
  for (let row = 0; row < height; row += 1) for (let col = 0; col < width; col += 1) {
    const i = row * width + col, value = pixels[i];
    sum += value; histogram[value >> 3] += 1; x[col] += value / height; y[row] += value / width;
    if (row > 0 && row < height - 1 && col > 0 && col < width - 1) {
      const v = pixels[i - 1] + pixels[i + 1] + pixels[i - width] + pixels[i + width] - 4 * value;
      lap += v; lap2 += v * v; count += 1;
    }
  }
  const variance = Math.max(0, lap2 / Math.max(1, count) - (lap / Math.max(1, count)) ** 2);
  return { luma: sum / (pixels.length * 255), sharp: variance / (variance + 80),
    histogram: histogram.map((n) => n / pixels.length), x, y };
}

function histogramDistance(a, b) { return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / 2; }

// Shift of the image content; a camera pan to the right moves content to the left.
function projectionShift(a, b, limit = 16) {
  limit = Math.min(limit, Math.floor(a.length / 4));
  let best = 0, error = Infinity;
  for (let shift = -limit; shift <= limit; shift += 1) {
    let sum = 0;
    for (let i = limit; i < a.length - limit; i += 1) sum += (a[i] - b[i + shift]) ** 2;
    sum /= Math.max(1, a.length - 2 * limit);
    if (sum < error - 1e-6 || (Math.abs(sum - error) <= 1e-6 && Math.abs(shift) < Math.abs(best))) { error = sum; best = shift; }
  }
  return best;
}

function sceneMetrics(samples, { i, start, end, width, height }) {
  const luma = mean(samples.map((s) => s.luma)), sharp = mean(samples.map((s) => s.sharp));
  const moves = samples.slice(1).map((s) => s.move);
  const acceleration = moves.slice(1).map((m, n) => Math.hypot(m[0] - moves[n][0], m[1] - moves[n][1]));
  const shake = clamp(mean(acceleration) / 12);
  const speed = mean(moves.map((m) => Math.hypot(...m))), dx = mean(moves.map((m) => m[0]));
  const motion = shake > 0.35 ? 'handheld' : speed > 12 ? 'fast' : Math.abs(dx) > 1.5 ? (dx < 0 ? 'pan_right' : 'pan_left') : 'static';
  const reasons = [];
  if (sharp < 0.15) reasons.push('blurry');
  if (luma < 0.12) reasons.push('dark');
  if (shake > 0.35) reasons.push('shaky');
  const found = samples.flatMap((s) => s.faces || []);
  // findFaces returns coordinates scaled to a width of 1920, including for portrait frames.
  const faces = found.length ? { count: Math.max(1, Math.round(mean(samples.map((s) => s.faces.length)))),
    x: round(clamp(mean(found.map((f) => f.x / 1920)))),
    y: round(clamp(mean(found.map((f) => f.y / (height * 1920 / width))))),
    size: round(clamp(mean(found.map((f) => f.s / 1920)))) } : { count: 0, x: null, y: null, size: null };
  return { i, in: round(start), out: round(end), quality: Math.round(clamp(5 - (sharp < 0.15 ? 2 : sharp < 0.35 ? 1 : 0) -
    (luma < 0.12 ? 2 : 0) - (shake > 0.35 ? 2 : 0), 1, 5)), reasons: reasons.length ? reasons : ['ok'],
    luma: round(luma), sharp: round(sharp), shake: round(shake), motion, faces };
}

function analyzeFrames(samples, { seconds, width, height, rate = 5, photo = false }) {
  if (!samples.length) throw new Error('No decoded frames');
  const groups = [[]];
  samples.forEach((sample, index) => {
    const previous = samples[index - 1];
    const cut = previous && histogramDistance(previous.histogram, sample.histogram) > 0.45;
    sample.time = photo ? 0 : Math.min(seconds, index / rate);
    sample.move = previous && !cut ? [projectionShift(previous.x, sample.x), projectionShift(previous.y, sample.y)] : [0, 0];
    if (cut && groups.length < MAX_SCENES && !photo) groups.push([]);
    groups[groups.length - 1].push(sample);
  });
  return groups.map((group, i) => sceneMetrics(group, { i, start: group[0].time,
    end: photo ? 0 : groups[i + 1]?.[0].time ?? seconds, width, height }));
}

function scanFile({ file, width, height, seconds, rate, photo, sheetFile }) {
  const size = width * height, count = Math.floor(fs.statSync(file).size / size);
  if (!count) throw new Error('No decoded frames');
  const find = require('../music-video-hud/faces').findFaces;
  const samples = [], tiles = [], picks = new Set();
  for (let i = 0; i < Math.min(12, count); i += 1) picks.add(Math.round(i * (count - 1) / Math.max(1, Math.min(12, count) - 1)));
  const fd = fs.openSync(file, 'r');
  try {
    const pixels = Buffer.alloc(size);
    for (let i = 0; i < count; i += 1) {
      if (fs.readSync(fd, pixels, 0, size, i * size) !== size) throw new Error('Truncated frame');
      samples.push({ ...frameMetrics(pixels, width, height), faces: find(pixels, { width, height,
        search: { minsize: 24, maxsize: Math.min(width, height), shift: 0.15, scale: 1.2 } }) });
      if (picks.has(i)) tiles.push(Buffer.from(pixels));
    }
  } finally { fs.closeSync(fd); }
  const cols = Math.min(4, tiles.length), rows = Math.ceil(tiles.length / cols), w = cols * width, h = rows * height;
  const sheet = Buffer.alloc(w * h, 20);
  tiles.forEach((tile, n) => {
    for (let y = 0; y < height; y += 1) tile.copy(sheet, (Math.floor(n / cols) * height + y) * w + (n % cols) * width, y * width, (y + 1) * width);
  });
  fs.writeFileSync(sheetFile, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), sheet]));
  return { scenes: analyzeFrames(samples, { seconds, width, height, rate, photo }), frames: count };
}

function scanInWorker(options, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const worker = new Worker(__filename, { workerData: { ...options, eventFrames: true } });
    let settled = false;
    const abort = () => { worker.terminate(); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    worker.once('message', (value) => { settled = true; cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); });
    worker.once('error', (err) => { cleanup(); reject(err); });
    worker.once('exit', (code) => { cleanup(); if (!settled) reject(new Error(`Frame worker exited without a result (${code})`)); });
  });
}

if (!isMainThread && workerData?.eventFrames) {
  try { parentPort.postMessage(scanFile(workerData)); }
  catch (err) { parentPort.postMessage({ error: err.message }); }
}
module.exports = { frameMetrics, histogramDistance, projectionShift, sceneMetrics, analyzeFrames, scanInWorker };
