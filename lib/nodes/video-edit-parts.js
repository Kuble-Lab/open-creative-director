'use strict';

// "Edit longer videos in parts" (WP41): the pure and file-level helpers behind the switch of the node fal.video_edit. A video that
// is longer than the model takes is cut into parts of nearly equal length (on frame boundaries), every part is edited on its own
// and the edited parts are joined again, with the sound of the ORIGINAL video over the whole film. The node (nodes-fal.js) decides
// and pays; this file only holds
//
//   splitFrames()     the cut: how many parts, which frames
//   partKey()         the key of one part: the same part (same video, range, model, prompt, images, options) gets the same key
//   findPartJob()     a finished (or still running) job of an earlier run with that key: it is used again and costs nothing
//   retimePlan()      the frames each edited part gets so that the whole film is as long as the original
//   the argument lists of the three ffmpeg runs: cut, retime, join
//
// Why the parts are retimed: a model returns every part in ITS OWN length at ITS OWN frame rate (a part of 13.28 s came back as
// 13.375 s at 24 frames per second, 321 frames). Joined as they are, the pictures drift against the sound of the original, by 0.08 s
// over four parts. Every edited part is therefore brought to exactly the length of its input part (stretched or squeezed by
// duplicating or dropping a frame now and then, under 1 %), and the parts are counted in frames of the output rate, so the sum is
// the length of the original to within half a frame.
//
// Why the cache lives on the jobs: the paid result of a part is a session asset that its job points to. A job carries the key of its
// part (job.partKey, set by the tools fal_generate and edit_video_openrouter from toolCtx.partKey). The next run looks for the key
// before it cuts, uploads or pays anything: a finished job with a result that is still there is taken as it is, a job that is still
// running is waited for, a failed one is made again. That works whatever happened to the first run (an error in one part, a stopped
// run, a time-out of the node): the jobs go on at the provider and the poller stores their results.

const crypto = require('crypto');
const fsp = require('fs/promises');

const store = require('../store');
const assets = require('./assets');

const KEY_VERSION = 1;
// A job that is still open after this time is not waited for again (the poller gives a fal job 90 minutes, an OpenRouter job 60).
const ADOPT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const OPEN_STATES = new Set(['pending', 'running', 'in_progress', 'queued', 'processing']);
// Encoding of the files that are cut, retimed and joined: near lossless (the parts are encoded twice before the join copies them).
const PART_CRF = '14';
const SAFETY_FRAMES = 3;

function codedError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

/* ---------- the cut ---------- */

// totalFrames at fps, parts of at most maxSeconds. The fewest parts that fit, as equal as frames allow (the first ones get the
// spare frames). Returns [{ index, startFrame, frames, start, seconds }]. A part shorter than minSeconds is an error (it cannot
// happen while a model takes at least twice its shortest length as its longest, but the check stays).
function splitFrames({ totalFrames, fps, maxSeconds, minSeconds = 0 }) {
  if (!Number.isInteger(totalFrames) || totalFrames < 1) throw new Error('splitFrames: the number of frames is not known');
  if (!(fps > 0) || !(maxSeconds > 0)) throw new Error('splitFrames: rate and longest part are needed');
  const maxFrames = Math.max(1, Math.floor(maxSeconds * fps + 1e-6));
  const count = Math.max(1, Math.ceil(totalFrames / maxFrames));
  const base = Math.floor(totalFrames / count);
  const spare = totalFrames % count;
  const parts = [];
  let startFrame = 0;
  for (let index = 0; index < count; index += 1) {
    const frames = base + (index < spare ? 1 : 0);
    parts.push({ index, startFrame, frames, start: startFrame / fps, seconds: frames / fps });
    startFrame += frames;
  }
  const shortest = Math.min(...parts.map((part) => part.seconds));
  if (minSeconds > 0 && shortest < minSeconds - 1e-6) {
    throw codedError('VIDEO_EDIT_PART_TOO_SHORT', `a part would be ${shortest.toFixed(2)} s long, below the ${minSeconds} s the model needs`, { min: minSeconds, found: Math.round(shortest * 100) / 100 });
  }
  return parts;
}

// How many parts a video of `seconds` seconds is cut into and what they cost, when only the length is known (the plan). The same
// rule as splitFrames, on seconds: parts of equal length. price(partSeconds) is the price of one part.
function planParts(seconds, maxSeconds, price) {
  if (!Number.isFinite(seconds) || seconds <= 0 || !(maxSeconds > 0)) return null;
  const count = Math.max(1, Math.ceil(seconds / maxSeconds - 1e-9));
  const each = price(seconds / count);
  return each === null ? null : { count, usd: Math.round(each * count * 1e6) / 1e6 };
}

/* ---------- the key ---------- */

// fields: everything that decides what a part looks like (see nodes-fal.js partFields). The order is fixed, the values are plain.
function partKey(fields) {
  const text = JSON.stringify({ v: KEY_VERSION, ...fields });
  return `ep${KEY_VERSION}-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}

function jobTime(job) {
  const time = Date.parse(job.submittedAt || job.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

// An earlier job with this key: { state: 'done', job, ids } (finished, result still there), { state: 'open', job } (still running and
// recent) or null. The newest first: a part that was made again replaces the older one.
async function findPartJob(sessionId, key, { now = Date.now() } = {}) {
  let session;
  try {
    session = await store.readSession(sessionId);
  } catch (_) {
    return null;
  }
  const jobs = (Array.isArray(session.jobs) ? session.jobs : []).filter((job) => job && job.partKey === key).sort((a, b) => jobTime(b) - jobTime(a));
  for (const job of jobs) {
    const status = String(job.status || 'pending');
    if (status === 'completed') {
      const ids = Array.isArray(job.resultAssetIds) && job.resultAssetIds.length ? job.resultAssetIds.slice() : [job.assetId];
      try {
        const value = await assets.valueFromAsset(sessionId, ids[0]);
        await fsp.stat(assets.assetFilePath(value));
        return { state: 'done', job, ids };
      } catch (_) {
        continue; // the result was deleted: not usable, an older job may still be
      }
    }
    if (OPEN_STATES.has(status) && now - jobTime(job) < ADOPT_MAX_AGE_MS) return { state: 'open', job };
  }
  return null;
}

/* ---------- the frames of the joined film ---------- */

// partFrames: the frames of the INPUT parts at the rate of the source (sourceFps). outFps: the rate of the edited parts. Every
// edited part gets the frames its input part takes at the output rate; the boundaries are rounded on the running sum, so the
// total is round(total seconds x outFps) however many parts there are. Returns [{ frames, seconds }].
function retimePlan(partFrames, sourceFps, outFps) {
  let before = 0;
  let boundary = 0;
  return partFrames.map((frames) => {
    before += frames;
    const end = Math.round((before / sourceFps) * outFps);
    const out = Math.max(1, end - boundary);
    boundary = end;
    return { frames: out, seconds: out / outFps };
  });
}

/* ---------- ffmpeg ---------- */

// "24", "30000/1001": the rate as ffmpeg reads it.
function rateText(fps) {
  if (!(fps > 0)) throw new Error('rateText: no frame rate');
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) < 1e-3) return String(whole);
  for (const base of [1001, 1000]) {
    const numerator = Math.round(fps * base);
    if (Math.abs(numerator / base - fps) < 1e-3) return `${numerator}/${base}`;
  }
  return fps.toFixed(3);
}

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function num(value) {
  return String(Math.round(value * 1e6) / 1e6);
}

const BASE = ['-nostdin', '-v', 'error', '-y'];
const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', PART_CRF, '-pix_fmt', 'yuv420p'];

// One part of the source: `frames` frames from frame `startFrame`, no sound (the models get the picture only; the sound of the
// original is laid over the finished film). The seek goes half a frame early, so the frame at the start time is the first one.
// maxBitrate (bits per second): a ceiling so that the file stays within the size a model takes (the near lossless setting of a busy
// picture can reach tens of megabits).
function cutArgs({ source, output, startFrame, frames, fps, width, height, maxBitrate = 0 }) {
  const filters = ['setsar=1'];
  if (width % 2 || height % 2) filters.unshift(`scale=${even(width)}:${even(height)}:flags=lanczos`);
  const limit = maxBitrate > 0 ? ['-maxrate', String(Math.floor(maxBitrate)), '-bufsize', String(Math.floor(maxBitrate * 2))] : [];
  return [...BASE, '-ss', num(Math.max(0, startFrame - 0.5) / fps), '-i', source, '-map', '0:v:0', '-frames:v', String(frames), '-an', '-vf', filters.join(','), ...X264, ...limit, '-movflags', '+faststart', output];
}

// The ceiling for a part of `seconds` seconds that has to stay within `maxBytes` (a margin of 20 % for the container).
function bitrateFor(maxBytes, seconds) {
  return Number.isFinite(maxBytes) && maxBytes > 0 && seconds > 0 ? Math.floor((maxBytes * 8 * 0.8) / seconds) : 0;
}

// An edited part brought to exactly `frames` frames at `rate`: stretched or squeezed in time by `factor` (wanted length / own
// length), cut or padded by the last frame where the rate leaves one frame over or short. `scale` ({ width, height }) only where a part
// differs in size from the first one.
function retimeArgs({ source, output, frames, rate, factor, scale = null }) {
  const filters = [`setpts=(PTS-STARTPTS)*${num(factor)}`, `fps=${rate}`];
  if (scale) filters.push(`scale=${scale.width}:${scale.height}:flags=lanczos`);
  filters.push('setsar=1', `tpad=stop_mode=clone:stop=${SAFETY_FRAMES}`, `trim=end_frame=${frames}`, 'setpts=PTS-STARTPTS');
  return [...BASE, '-i', source, '-map', '0:v:0', '-an', '-vf', filters.join(','), '-r', rate, ...X264, '-movflags', '+faststart', output];
}

// The list file of the concat demuxer.
function listFileText(files) {
  return `${files.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`).join('\n')}\n`;
}

// The parts joined without encoding the picture again, the original sound over all of it (cut or padded to the length of the
// film). audioSource: the original video, or null for a silent film.
function joinArgs({ list, audioSource, output, seconds }) {
  const length = num(seconds);
  const args = [...BASE, '-f', 'concat', '-safe', '0', '-i', list];
  if (audioSource) args.push('-i', audioSource);
  args.push('-map', '0:v:0');
  if (audioSource) args.push('-map', '1:a:0');
  args.push('-c:v', 'copy');
  if (audioSource) args.push('-c:a', 'aac', '-b:a', '192k', '-af', `atrim=end=${length},asetpts=PTS-STARTPTS,apad=whole_dur=${length}`);
  args.push('-t', length, '-movflags', '+faststart', output);
  return args;
}

// The part numbers of the "redo" field: "2", "2, 4", "2 4", "2;4" -> [2, 4] (1-based, sorted, once). null = not numbers only.
function parseRedoParts(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  if (!/^[\d\s,;]+$/.test(raw)) return null;
  const numbers = raw.split(/[^\d]+/).filter(Boolean).map(Number);
  if (!numbers.length || numbers.some((value) => !Number.isInteger(value) || value < 1)) return null;
  return [...new Set(numbers)].sort((a, b) => a - b);
}

module.exports = {
  KEY_VERSION,
  ADOPT_MAX_AGE_MS,
  splitFrames,
  planParts,
  partKey,
  findPartJob,
  retimePlan,
  rateText,
  cutArgs,
  bitrateFor,
  retimeArgs,
  listFileText,
  joinArgs,
  parseRedoParts,
  codedError
};
