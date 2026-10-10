'use strict';

// Small grey frames, read one at a time in a worker. No raw clip is held in memory.
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { MAX_SCENES } = require('./contract');
// Byte luma is 0..255; 32 histogram bins each cover eight byte values.
const LUMA_MAX = 255;
// Thirty-two equal bins describe the 8-bit luma distribution.
const HISTOGRAM_BINS = 32;
// Discard three low bits to select the eight-value histogram bin.
const HISTOGRAM_BIN_SHIFT = 3;
// Heuristics on the 320 px grid, not thresholds calibrated against labelled footage.
// Sharpness is 0..1: variance 80 maps to 0.5; below 0.15 is blurry, below 0.35 loses one quality point.
const SHARPNESS_VARIANCE_SCALE = 80;
// Marks sharpness below this 0..1 value as blurry.
const BLUR_THRESHOLD = 0.15;
// Subtracts one quality point below this 0..1 sharpness value.
const SOFT_THRESHOLD = 0.35;
// Luma below 0.12 is dark; histogram distance above 0.45 starts a new scene (both 0..1).
const DARK_THRESHOLD = 0.12;
// Starts a scene above this 0..1 histogram distance.
const CUT_THRESHOLD = 0.45;
// Projection search reaches 16 px or a quarter of its axis; ties within this tolerance prefer less motion.
const PROJECTION_LIMIT_PX = 16;
// Limit the search to a quarter of the projection length.
const PROJECTION_AXIS_DIVISOR = 4;
// Squared-error tolerance for deterministic shift tie-breaking.
const PROJECTION_ERROR_EPSILON = 1e-6;
// Motion is px/sample: 12 normalises acceleration to shake 0..1 and marks fast translation.
const SHAKE_SCALE_PX = 12;
// Labels translation above this px/sample speed as fast.
const FAST_MOTION_PX = 12;
// Treats horizontal motion above this px/sample value as a pan.
const PAN_THRESHOLD_PX = 1.5;
// Marks shake above this 0..1 score as handheld and shaky.
const SHAKE_THRESHOLD = 0.35;
// Info v1 quality is 1..5; severe blur, darkness and shake each subtract two points.
const QUALITY_MIN = 1;
// Highest quality score allowed by info v1.
const QUALITY_MAX = 5;
// Points deducted for each severe blur, dark or shake reason.
const QUALITY_PENALTY = 2;
// findFaces reports px at this reference width, even for portrait frames.
const FACE_REFERENCE_WIDTH_PX = 1920;
// Trades face-search density for bounded work: minimum 24 px, 15% steps, 20% size growth.
const FACE_MIN_SIZE_PX = 24;
// Move the search window by this fraction of its face size.
const FACE_SEARCH_SHIFT = 0.15;
// Grow the face-search window by this factor between scales.
const FACE_SEARCH_SCALE = 1.2;
// Up to 12 chronological tiles in four columns; unused sheet pixels have dark luma 20.
const SHEET_MAX_TILES = 12;
// Maximum number of grey frames across the contact sheet.
const SHEET_MAX_COLUMNS = 4;
// Luma byte for unused contact-sheet cells.
const SHEET_BACKGROUND_LUMA = 20;
// Default sampling matches decodeArgs; source times and scores keep three decimal places.
const DEFAULT_SAMPLE_FPS = 5;
// Three decimal places for serialised times and normalised metrics.
const ROUND_PRECISION = 1000;

// Bound normalised scores and coordinates to 0..1 unless an explicit range is given.
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
// Round source seconds and normalised metrics consistently for info v1.
const round = (n) => Math.round(n * ROUND_PRECISION) / ROUND_PRECISION;
// Empty measurements have mean zero, so still photos need no motion special case.
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

// Measure luma and Laplacian sharpness (0..1), plus projections for cheap motion estimation.
function frameMetrics(pixels, width, height) {
  const histogram = Array(HISTOGRAM_BINS).fill(0);
  const x = Array(width).fill(0);
  const y = Array(height).fill(0);
  let sum = 0;
  let lap = 0;
  let lap2 = 0;
  let count = 0;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const value = pixels[i];
      sum += value;
      histogram[value >> HISTOGRAM_BIN_SHIFT] += 1;
      x[col] += value / height;
      y[row] += value / width;
      if (row > 0 && row < height - 1 && col > 0 && col < width - 1) {
        // Four-neighbour Laplacian: neighbour sum minus four times the centre luma.
      const v = pixels[i - 1] + pixels[i + 1] + pixels[i - width] + pixels[i + width] - 4 * value;
        lap += v;
        lap2 += v * v;
        count += 1;
      }
    }
  }
  const variance = Math.max(0, lap2 / Math.max(1, count) - (lap / Math.max(1, count)) ** 2);
  return {
    luma: sum / (pixels.length * LUMA_MAX),
    sharp: variance / (variance + SHARPNESS_VARIANCE_SCALE),
    histogram: histogram.map((n) => n / pixels.length),
    x,
    y
  };
}

// Half the histogram L1 distance is 0..1, making the scene-cut threshold independent of frame size.
function histogramDistance(a, b) {
  return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / 2;
}

// Shift of the image content; a camera pan to the right moves content to the left.
function projectionShift(a, b, limit = PROJECTION_LIMIT_PX) {
  limit = Math.min(limit, Math.floor(a.length / PROJECTION_AXIS_DIVISOR));
  let best = 0;
  let error = Infinity;
  for (let shift = -limit; shift <= limit; shift += 1) {
    let sum = 0;
    for (let i = limit; i < a.length - limit; i += 1) {
      sum += (a[i] - b[i + shift]) ** 2;
    }
    sum /= Math.max(1, a.length - 2 * limit);
    if (sum < error - PROJECTION_ERROR_EPSILON || (Math.abs(sum - error) <= PROJECTION_ERROR_EPSILON && Math.abs(shift) < Math.abs(best))) {
      error = sum;
      best = shift;
    }
  }
  return best;
}

// Summarise one scene with v1 quality, motion and face coordinates (0..1); start/end are source seconds.
function sceneMetrics(samples, { i, start, end, width, height }) {
  const luma = mean(samples.map((s) => s.luma));
  const sharp = mean(samples.map((s) => s.sharp));
  const moves = samples.slice(1).map((s) => s.move);
  const acceleration = moves.slice(1).map((m, n) => Math.hypot(m[0] - moves[n][0], m[1] - moves[n][1]));
  const shake = clamp(mean(acceleration) / SHAKE_SCALE_PX);
  const speed = mean(moves.map((m) => Math.hypot(...m)));
  const dx = mean(moves.map((m) => m[0]));
  let motion = 'static';
  if (shake > SHAKE_THRESHOLD) {
    motion = 'handheld';
  } else if (speed > FAST_MOTION_PX) {
    motion = 'fast';
  } else if (Math.abs(dx) > PAN_THRESHOLD_PX) {
    motion = dx < 0 ? 'pan_right' : 'pan_left';
  }
  const reasons = [];
  if (sharp < BLUR_THRESHOLD) reasons.push('blurry');
  if (luma < DARK_THRESHOLD) reasons.push('dark');
  if (shake > SHAKE_THRESHOLD) reasons.push('shaky');
  const found = samples.flatMap((s) => s.faces || []);
  // findFaces returns coordinates scaled to a width of 1920, including for portrait frames.
  const faces = found.length
    ? {
        count: Math.max(1, Math.round(mean(samples.map((s) => s.faces.length)))),
        x: round(clamp(mean(found.map((f) => f.x / FACE_REFERENCE_WIDTH_PX)))),
        y: round(clamp(mean(found.map((f) => f.y / ((height * FACE_REFERENCE_WIDTH_PX) / width))))),
        size: round(clamp(mean(found.map((f) => f.s / FACE_REFERENCE_WIDTH_PX))))
      }
    : { count: 0, x: null, y: null, size: null };
  return {
    i,
    in: round(start),
    out: round(end),
    quality: Math.round(
      clamp(
        QUALITY_MAX -
          (sharp < BLUR_THRESHOLD ? QUALITY_PENALTY : sharp < SOFT_THRESHOLD ? 1 : 0) -
          (luma < DARK_THRESHOLD ? QUALITY_PENALTY : 0) -
          (shake > SHAKE_THRESHOLD ? QUALITY_PENALTY : 0),
        QUALITY_MIN,
        QUALITY_MAX
      )
    ),
    reasons: reasons.length ? reasons : ['ok'],
    luma: round(luma),
    sharp: round(sharp),
    shake: round(shake),
    motion,
    faces
  };
}

// Split chronological samples at histogram cuts and assign source times in seconds before summarising.
function analyzeFrames(samples, { seconds, width, height, rate = DEFAULT_SAMPLE_FPS, photo = false }) {
  if (!samples.length) throw new Error('No decoded frames');
  const groups = [[]];
  samples.forEach((sample, index) => {
    const previous = samples[index - 1];
    const cut = previous && histogramDistance(previous.histogram, sample.histogram) > CUT_THRESHOLD;
    sample.time = photo ? 0 : Math.min(seconds, index / rate);
    sample.move = previous && !cut ? [projectionShift(previous.x, sample.x), projectionShift(previous.y, sample.y)] : [0, 0];
    if (cut && groups.length < MAX_SCENES && !photo) groups.push([]);
    groups[groups.length - 1].push(sample);
  });
  return groups.map((group, i) =>
    sceneMetrics(group, { i, start: group[0].time, end: photo ? 0 : (groups[i + 1]?.[0].time ?? seconds), width, height })
  );
}

// Stream grey frames through the shared face finder and write a bounded PGM contact sheet for vision.
function scanFile({ file, width, height, seconds, rate, photo, sheetFile }) {
  const size = width * height;
  const count = Math.floor(fs.statSync(file).size / size);
  if (!count) throw new Error('No decoded frames');
  const find = require('../music-video-hud/faces').findFaces;
  const samples = [];
  const tiles = [];
  const picks = new Set();
  for (let i = 0; i < Math.min(SHEET_MAX_TILES, count); i += 1) {
    picks.add(Math.round((i * (count - 1)) / Math.max(1, Math.min(SHEET_MAX_TILES, count) - 1)));
  }
  const fd = fs.openSync(file, 'r');
  try {
    const pixels = Buffer.alloc(size);
    for (let i = 0; i < count; i += 1) {
      if (fs.readSync(fd, pixels, 0, size, i * size) !== size) throw new Error('Truncated frame');
      samples.push({
        ...frameMetrics(pixels, width, height),
        faces: find(pixels, {
          width,
          height,
          search: { minsize: FACE_MIN_SIZE_PX, maxsize: Math.min(width, height), shift: FACE_SEARCH_SHIFT, scale: FACE_SEARCH_SCALE }
        })
      });
      if (picks.has(i)) tiles.push(Buffer.from(pixels));
    }
  } finally {
    fs.closeSync(fd);
  }
  const cols = Math.min(SHEET_MAX_COLUMNS, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const w = cols * width;
  const h = rows * height;
  const sheet = Buffer.alloc(w * h, SHEET_BACKGROUND_LUMA);
  tiles.forEach((tile, n) => {
    for (let y = 0; y < height; y += 1) {
      tile.copy(sheet, (Math.floor(n / cols) * height + y) * w + (n % cols) * width, y * width, (y + 1) * width);
    }
  });
  fs.writeFileSync(sheetFile, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), sheet]));
  return { scenes: analyzeFrames(samples, { seconds, width, height, rate, photo }), frames: count };
}

// Keep CPU-heavy frame scans off the main thread and propagate cancellation or a missing worker result.
function scanInWorker(options, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const worker = new Worker(__filename, { workerData: { ...options, eventFrames: true } });
    let settled = false;
    // Stop decoding immediately when the workflow is cancelled.
    const abort = () => {
      worker.terminate();
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Remove the signal listener on every worker completion path.
    const cleanup = () => signal?.removeEventListener('abort', abort);
    // A reported scan result settles the worker before its exit notification.
    worker.once('message', (value) => {
      settled = true;
      cleanup();
      if (value.error) reject(new Error(value.error));
      else resolve(value);
    });
    // Worker runtime failures reject the scan and release the abort listener.
    worker.once('error', (err) => {
      cleanup();
      reject(err);
    });
    // An exit without a message is a failure, even when the exit code is zero.
    worker.once('exit', (code) => {
      cleanup();
      if (!settled) reject(new Error(`Frame worker exited without a result (${code})`));
    });
  });
}

if (!isMainThread && workerData?.eventFrames) {
  try {
    parentPort.postMessage(scanFile(workerData));
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
}
module.exports = { frameMetrics, histogramDistance, projectionShift, sceneMetrics, analyzeFrames, scanInWorker };
