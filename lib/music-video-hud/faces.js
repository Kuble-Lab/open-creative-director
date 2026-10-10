'use strict';

// Where the face of the figure is in the footage (WP51), so that a tag of the HUD points at the place it names (the mouth, the eyes, the hair) and
// follows it while the face moves. Measured on the machine that builds the pages, before the render: ffmpeg cuts the frames under the tags out of the
// base cut (small, grey, every STEP frames), and a face finder in plain JavaScript looks at them. Nothing to install, nothing to pay, the same on every
// machine (no random numbers, no floating point that depends on the processor beyond IEEE doubles); the render nodes only draw what is measured.
//
// The finder is pico (pixel intensity comparisons in a cascade of decision trees, Nenad Markus, MIT licence; pico.js and lploc.js of
// github.com/nenadmarkus/picojs rewritten here) with two of its trained files in cascades/: `facefinder.bin` (upright faces, from
// github.com/nenadmarkus/pico) and `puploc.bin` (the pupils, from the author's demo of lploc.js). It finds an upright face and its two pupils; the mouth,
// the hair and the clothes follow from the pupils (targets.js). A face turned far to the side or seen from behind is not found: a tag over it then
// stands without its line.
//
//   samplesOf(graphics)                   the frames (of the song) to look at: every STEP frames under every tag, in cuts with the figure
//   framesArgs({ inputFile, outFile, frames, origin })   the ffmpeg arguments that write those frames, 640 x 360 grey, one after the other
//   findFaces(pixels)                     the faces of one frame: [{ x, y, d, a, s, q }] in px of 1920 x 1080 (x, y the middle between the
//                                         pupils, d the distance of the pupils, a the angle of the line through them in degrees, s the size of the face)
//   trackFaces(graphics, buffer, frames)  the track the pages read: { step, points: [[frame, x, y, d, a], ...] } (one face per frame, the same face
//                                         through a cut); trackFile(graphics, file, frames, { signal }) the same for the frames in a file, in a thread
//                                         of its own (faces-worker.js)

const fs = require('fs');
const path = require('path');

const FPS = 24;
// the size the frames are looked at (a third of 1920 x 1080) and the step between two frames that are looked at (6 a second)
const GRID = Object.freeze({ w: 640, h: 360, k: 3 });
const STEP = 4;
// the frames before the entrance and after the exit of a tag that are looked at as well (the fade of the tag)
const MARGIN_FRAMES = 8;
// the search: the smallest and largest face (px of the grid), how far the window moves (of its size) and how much it grows from one size to the next
const SEARCH = Object.freeze({ minsize: 40, maxsize: 360, shift: 0.1, scale: 1.1 });
// the score a face needs (the sum of the trees of the cascade above its last threshold) and the overlap at which two finds are one face
const MIN_SCORE = 5;
const OVERLAP = 0.2;
// the pupils: the windows round the expected place of each eye (of the size of the face) and the number of slightly moved windows whose median counts
const EYE = Object.freeze({ up: 0.075, side: 0.175, size: 0.35, tries: 15 });
// the chains of finds through a cut (trackOf): how far a find may be from the last one of its chain (of the size of the face), how much the size may
// change (log), how many frames may lie between two finds, and what a chain needs to count (finds, sum of scores)
const CHAIN = Object.freeze({ link: 0.35, grow: 0.35, gap: 12, points: 3, score: 50 });

let cascades = null;
function loadCascades() {
  if (!cascades) {
    const dir = path.join(__dirname, 'cascades');
    cascades = { face: unpackCascade(fs.readFileSync(path.join(dir, 'facefinder.bin'))), pupil: unpackLocalizer(fs.readFileSync(path.join(dir, 'puploc.bin'))) };
  }
  return cascades;
}

/* ---------- pico: the face ---------- */

// The trees of a cascade from its file: 8 bytes that are not used, the depth of the trees, their number, then for every tree its tests (4 signed
// bytes each, the first test of a tree is the root at index 1), the outputs of its leaves (float32) and its threshold (float32).
function unpackCascade(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  const depth = data.getInt32(p, true);
  const count = data.getInt32(p + 4, true);
  p += 8;
  const leaves = 2 ** depth;
  const codes = new Int8Array(count * 4 * leaves);
  const preds = new Float32Array(count * leaves);
  const thresholds = new Float32Array(count);
  for (let t = 0; t < count; t += 1) {
    codes.set(signed.subarray(p, p + 4 * leaves - 4), t * 4 * leaves + 4);
    p += 4 * leaves - 4;
    for (let i = 0; i < leaves; i += 1) {
      preds[t * leaves + i] = data.getFloat32(p, true);
      p += 4;
    }
    thresholds[t] = data.getFloat32(p, true);
    p += 4;
  }
  return { depth, count, leaves, codes, preds, thresholds };
}

// The score of the square window of size s round (r, c) (rows and columns of the grid), or -1 when a tree of the cascade says it is no face.
function classify(cascade, r, c, s, pixels, width) {
  const { depth, count, leaves, codes, preds, thresholds } = cascade;
  const r8 = r * 256;
  const c8 = c * 256;
  let root = 0;
  let out = 0;
  for (let t = 0; t < count; t += 1) {
    let idx = 1;
    for (let j = 0; j < depth; j += 1) {
      const at = root + 4 * idx;
      const a = pixels[((r8 + codes[at] * s) >> 8) * width + ((c8 + codes[at + 1] * s) >> 8)];
      const b = pixels[((r8 + codes[at + 2] * s) >> 8) * width + ((c8 + codes[at + 3] * s) >> 8)];
      idx = 2 * idx + (a <= b ? 1 : 0);
    }
    out += preds[leaves * t + idx - leaves];
    if (out <= thresholds[t]) return -1;
    root += 4 * leaves;
  }
  return out - thresholds[count - 1];
}

// Every window of every size that the cascade takes for a face: [row, column, size, score].
function runCascade(cascade, pixels, width, height, search = SEARCH) {
  const found = [];
  for (let size = search.minsize; size <= search.maxsize; size *= search.scale) {
    const step = Math.max(search.shift * size, 1) >> 0;
    const offset = (size / 2 + 1) >> 0;
    for (let r = offset; r <= height - offset; r += step) {
      for (let c = offset; c <= width - offset; c += step) {
        const score = classify(cascade, r, c, size, pixels, width);
        if (score > 0) found.push([r, c, size, score]);
      }
    }
  }
  return found;
}

// The windows that overlap (intersection over union above `overlap`) are one face: the mean of their places and sizes, the sum of their scores.
function clusterFinds(list, overlap = OVERLAP) {
  const sorted = list.slice().sort((a, b) => b[3] - a[3] || a[0] - b[0] || a[1] - b[1]);
  const iou = (a, b) => {
    const rows = Math.max(0, Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2));
    const cols = Math.max(0, Math.min(a[1] + a[2] / 2, b[1] + b[2] / 2) - Math.max(a[1] - a[2] / 2, b[1] - b[2] / 2));
    return (rows * cols) / (a[2] * a[2] + b[2] * b[2] - rows * cols);
  };
  const taken = new Array(sorted.length).fill(false);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (taken[i]) continue;
    let r = 0;
    let c = 0;
    let s = 0;
    let q = 0;
    let n = 0;
    for (let j = i; j < sorted.length; j += 1) {
      if (taken[j] || iou(sorted[i], sorted[j]) <= overlap) continue;
      taken[j] = true;
      r += sorted[j][0];
      c += sorted[j][1];
      s += sorted[j][2];
      q += sorted[j][3];
      n += 1;
    }
    out.push([r / n, c / n, s / n, q]);
  }
  return out;
}

/* ---------- lploc: the pupils ---------- */

// The trees of a localiser: the number of stages, the factor of the window after each stage (float32), the trees per stage and their depth, then for
// every tree its tests (4 signed bytes each, the root at index 0) and the moves of its leaves (two float32 each: rows, columns).
function unpackLocalizer(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stages = data.getInt32(0, true);
  const scale = data.getFloat32(4, true);
  const trees = data.getInt32(8, true);
  const depth = data.getInt32(12, true);
  let p = 16;
  const leaves = 2 ** depth;
  const codes = new Int8Array(stages * trees * (4 * leaves - 4));
  const preds = new Float32Array(stages * trees * leaves * 2);
  let at = 0;
  let pred = 0;
  for (let i = 0; i < stages * trees; i += 1) {
    codes.set(signed.subarray(p, p + 4 * leaves - 4), at);
    at += 4 * leaves - 4;
    p += 4 * leaves - 4;
    for (let k = 0; k < leaves * 2; k += 1) {
      preds[pred] = data.getFloat32(p, true);
      pred += 1;
      p += 4;
    }
  }
  return { stages, scale, trees, depth, leaves, codes, preds };
}

// The place of the pupil in the window (r, c, s): every stage moves the window by the sum of the moves of its trees and makes it smaller.
function localize(loc, r, c, s, pixels, width, height) {
  const { stages, scale, trees, depth, leaves, codes, preds } = loc;
  let root = 0;
  for (let i = 0; i < stages; i += 1) {
    let dr = 0;
    let dc = 0;
    for (let j = 0; j < trees; j += 1) {
      let idx = 0;
      for (let k = 0; k < depth; k += 1) {
        const at = root + 4 * idx;
        const r1 = Math.min(height - 1, Math.max(0, (256 * r + codes[at] * s) >> 8));
        const c1 = Math.min(width - 1, Math.max(0, (256 * c + codes[at + 1] * s) >> 8));
        const r2 = Math.min(height - 1, Math.max(0, (256 * r + codes[at + 2] * s) >> 8));
        const c2 = Math.min(width - 1, Math.max(0, (256 * c + codes[at + 3] * s) >> 8));
        idx = 2 * idx + 1 + (pixels[r1 * width + c1] > pixels[r2 * width + c2] ? 1 : 0);
      }
      const lut = 2 * (trees * leaves * i + leaves * j + idx - (leaves - 1));
      dr += preds[lut];
      dc += preds[lut + 1];
      root += 4 * leaves - 4;
    }
    r += dr * s;
    c += dc * s;
    s *= scale;
  }
  return [r, c];
}

// The moved windows of the pupil search: a fixed sequence (the fractional parts of multiples of irrational numbers), not random numbers, so that the
// same frame gives the same pupils on every machine.
const TRIES = Object.freeze(
  Array.from({ length: EYE.tries }, (_, i) => {
    const u = (n) => (n - Math.floor(n));
    return Object.freeze([u(0.5 + i * 0.7548776662), u(0.5 + i * 0.5698402910), u(0.5 + i * 0.6180339887)]);
  })
);
const median = (list) => {
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

function pupil(loc, r, c, s, pixels, width, height) {
  const rows = [];
  const cols = [];
  for (const [a, b, z] of TRIES) {
    const [pr, pc] = localize(loc, r + s * 0.15 * (0.5 - a), c + s * 0.15 * (0.5 - b), s * (0.925 + 0.15 * z), pixels, width, height);
    rows.push(pr);
    cols.push(pc);
  }
  return [median(rows), median(cols)];
}

/* ---------- one frame ---------- */

const round1 = (value) => Math.round(value * 10) / 10;

// The faces of one frame of the grid (640 x 360 bytes of grey), the best first: { x, y, d, a, s, q } in px of 1920 x 1080. The pupils are believed
// when they are about as far apart as eyes in a face of that size and nearly level; else they are taken from the window of the face (where the eyes
// of an upright face are in it).
function findFaces(pixels, { width = GRID.w, height = GRID.h, minScore = MIN_SCORE, search = SEARCH } = {}) {
  const { face, pupil: loc } = loadCascades();
  const k = 1920 / width;
  const found = clusterFinds(runCascade(face, pixels, width, height, search)).filter((item) => item[3] >= minScore);
  return found
    .sort((a, b) => b[3] - a[3])
    .map(([r, c, s, q]) => {
      const left = pupil(loc, r - EYE.up * s, c - EYE.side * s, EYE.size * s, pixels, width, height);
      const right = pupil(loc, r - EYE.up * s, c + EYE.side * s, EYE.size * s, pixels, width, height);
      let dx = right[1] - left[1];
      let dy = right[0] - left[0];
      let d = Math.hypot(dx, dy);
      let mid = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
      if (!(d > 0.22 * s && d < 0.55 * s && Math.abs(dy) < 0.5 * Math.abs(dx))) {
        dx = 0.36 * s;
        dy = 0;
        d = 0.36 * s;
        mid = [r - 0.08 * s, c];
      }
      return { x: round1(mid[1] * k), y: round1(mid[0] * k), d: round1(d * k), a: round1((Math.atan2(dy, dx) * 180) / Math.PI), s: round1(s * k), q: round1(q) };
    });
}

/* ---------- the frames under the tags ---------- */

// The frames (of the song, frame numbers at 24 fps) to look at: every STEP frames (on the grid of the film, counted from frame 0) from MARGIN_FRAMES
// before a tag enters until MARGIN_FRAMES after it has left, in the cuts that show the figure. Sorted, each once.
function samplesOf(g) {
  const set = new Set();
  const firstFrame = Math.round((g.start || 0) * FPS);
  const cuts = (g.cuts || []).filter((cut) => cut.subject !== 'none');
  for (const d of g.devices || []) {
    if (d.type !== 'tag') continue;
    const from = Math.max(firstFrame, Math.floor((d.appear ?? d.start) * FPS) - MARGIN_FRAMES);
    const to = Math.min(g.endFrame ?? Infinity, Math.ceil((d.end + 0.5) * FPS) + MARGIN_FRAMES);
    for (let f = Math.ceil(from / STEP) * STEP; f <= to; f += STEP) {
      const t = f / FPS;
      if (cuts.some((cut) => cut.start <= t + 1e-6 && t < cut.end - 1e-6)) set.add(f);
    }
  }
  return [...set].sort((a, b) => a - b);
}

// The ffmpeg arguments that write the frames to look at as raw grey bytes, 640 x 360 each, in the order of `frames`: the base cut brought to the
// picture of the pages first (1920 x 1080 filled, 24 fps, as postpass.cutClipArgs does), then the frames picked by their number. `origin` is the song
// time of the first frame of the base cut. Padding before trimming also covers samples starting after the footage ends.
function framesArgs({ inputFile, outFile, frames, origin = 0 }) {
  if (!frames.length) throw new Error('no frames to look at');
  const base = Math.round(origin * FPS);
  const first = frames[0] - base;
  // runs of frames STEP apart: between(n, a, b) * not(mod(n - a, STEP)); n counts from the frame the reading starts at
  const runs = [];
  for (const frame of frames) {
    const n = frame - base - first;
    const run = runs[runs.length - 1];
    if (run && n === run[1] + STEP) run[1] = n;
    else runs.push([n, n]);
  }
  const pick = runs.map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})*not(mod(n-${a}\\,${STEP}))`)).join('+');
  const filter = `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=5,trim=start_frame=${first},select='${pick}',scale=${GRID.w}:${GRID.h}:flags=area,format=gray`;
  return [
    '-nostdin', '-v', 'error', '-y',
    '-i', inputFile,
    '-an', '-vf', filter, '-frames:v', String(frames.length), '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'gray', outFile
  ];
}

/* ---------- the track ---------- */

// The faces of every frame (findFaces) of the grey frames one after the other in `buffer` (framesArgs): [{ frame, faces }].
function facesOfFrames(buffer, frames, { find = findFaces } = {}) {
  const size = GRID.w * GRID.h;
  return frames.map((frame, index) => ({ frame, faces: (index + 1) * size > buffer.length ? [] : find(buffer.subarray(index * size, (index + 1) * size)) }));
}

// The chains of finds through the frames of one cut: a find continues the chain whose last find is at most CHAIN.gap frames before it, at most
// CHAIN.link times the size of the face away and of about the same size (the nearest such chain; the best finds of a frame choose first), else it
// starts a chain of its own.
function chainsOf(items, rule = CHAIN) {
  const chains = [];
  for (const item of items) {
    const used = new Set();
    for (const face of item.faces) {
      let best = null;
      let distance = Infinity;
      for (const candidate of chains) {
        if (used.has(candidate)) continue;
        const last = candidate.points[candidate.points.length - 1];
        if (item.frame - last.frame > rule.gap) continue;
        const away = Math.hypot(face.x - last.face.x, face.y - last.face.y);
        if (away <= rule.link * Math.max(face.s, last.face.s) && Math.abs(Math.log(face.s / last.face.s)) <= rule.grow && away < distance) {
          best = candidate;
          distance = away;
        }
      }
      if (!best) {
        best = { points: [], score: 0 };
        chains.push(best);
      }
      best.points.push({ frame: item.frame, face });
      best.score += face.q;
      used.add(best);
    }
  }
  return chains;
}

// The points of a chain a little smoothed (each with half of itself and a quarter of each neighbour that is one step away), so that the brackets do
// not tremble with the few pixels the pupils move from one find to the next.
function smoothed(points) {
  return points.map((point, i) => {
    const before = points[i - 1];
    const after = points[i + 1];
    const near = (other) => other && Math.abs(other.frame - point.frame) <= STEP;
    if (!near(before) || !near(after)) return [point.frame, point.face.x, point.face.y, point.face.d, point.face.a];
    const mix = (key) => round1(0.5 * point.face[key] + 0.25 * before.face[key] + 0.25 * after.face[key]);
    return [point.frame, mix('x'), mix('y'), mix('d'), mix('a')];
  });
}

// The track of the face through the frames, cut by cut: the chains of finds (chainsOf) are the candidates; a chain counts when it has at least
// CHAIN.points finds (fewer in a cut that has fewer frames to look at) and their scores add up to CHAIN.score, so that a single find on a pattern of the
// set, a lamp or the frame of a mirror draws no line. The best chains are taken, the best first, as long as they do not overlap in time: one face
// per frame, the same one through a cut (a copy of the figure or a face in a mirror does not take over the line). `perFrame` is [{ frame, faces }]
// (facesOfFrames). Returns { step, points: [[frame, x, y, d, a], ...] }.
function trackOf(g, perFrame, { chain: rule = CHAIN } = {}) {
  const points = [];
  for (const cut of g.cuts || []) {
    if (cut.subject === 'none') continue;
    const inCut = perFrame.filter((item) => item.frame / FPS >= cut.start - 1e-6 && item.frame / FPS < cut.end - 1e-6);
    if (!inCut.length) continue;
    const need = Math.min(rule.points, inCut.length);
    const chains = chainsOf(inCut, rule)
      .filter((chain) => chain.points.length >= need && chain.score >= rule.score)
      .sort((a, b) => b.score - a.score || a.points[0].frame - b.points[0].frame);
    const taken = [];
    for (const chain of chains) {
      const from = chain.points[0].frame;
      const to = chain.points[chain.points.length - 1].frame;
      if (taken.some(([a, b]) => from <= b + STEP && to >= a - STEP)) continue;
      taken.push([from, to]);
      points.push(...smoothed(chain.points));
    }
  }
  points.sort((a, b) => a[0] - b[0]);
  return { step: STEP, points };
}

// Both steps: the faces of the frames, then the track.
function trackFaces(g, buffer, frames, options = {}) {
  return trackOf(g, facesOfFrames(buffer, frames, options));
}

// Both steps for the frames in a file (framesArgs), the faces in a thread of their own (faces-worker.js). `signal` ends the thread.
function trackFile(g, file, frames, { signal } = {}) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'faces-worker.js'), { workerData: { file, frames } });
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      worker.terminate();
      const err = new Error('The run was stopped');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
    }
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', stop);
      fn(value);
    };
    worker.once('message', (perFrame) => finish(resolve, trackOf(g, perFrame)));
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`the face finder ended with code ${code}`)));
  });
}

module.exports = { FPS, GRID, STEP, MARGIN_FRAMES, SEARCH, MIN_SCORE, CHAIN, findFaces, samplesOf, framesArgs, facesOfFrames, chainsOf, trackOf, trackFaces, trackFile, unpackCascade, unpackLocalizer, runCascade, clusterFinds, classify, localize, loadCascades };
