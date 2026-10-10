'use strict';

// Drawing a film in chunks on the render nodes (from the music video with the HUD, WP44; WP53 shares it with the event video). A node cuts its film
// into chunks (lib/music-video-hud/chunks.js), builds the HTML page of every chunk and hands this module a way to make each one ready; this module
// sends the chunks to the render nodes one after the other (so that every render node has work), waits for all of them at the same time, draws a
// chunk that failed once more, and stops on a render node that is gone or on a second failure.
//
//   submitChunk(ctx, { html, label, quality, clipId, assetIds, format, fps, codes })   one job: the tool of the chat, with the frame rate
//   finishChunk(ctx, state, { index, count, quality, temp, log, fps, codes })        the wait for one chunk (a second try with a new job)
//   renderChunks(ctx, { chunks, prepare, quality, temp, log, format, fps, codes })     all chunks: prepare(chunk) -> { html, clipId, assetIds, label }
//
// `format` is the format of the render node (landscape, portrait or square; landscape by default), `codes` the codes of the errors of the node that
// uses it (by default those of the HUD, whose node and tests read them). Everything a chunk leaves behind (its footage, the drawn chunk) goes into
// `temp` for the node to remove at its end.

const ffmpeg = require('./ffmpeg');
const rendernode = require('./rendernode');
const tools = require('./tools');
const assets = require('./nodes/assets');
const jobs = require('./nodes/jobs');
const ops = require('./nodes/ffmpeg-ops');

const FPS = 24;
// One chunk (at most 24 s of film) takes 0.8 to 1.7 s per second of film on a fast laptop and a few times that on a slow machine. The wait of a chunk is
// RENDER_WAIT_MS plus RENDER_PER_JOB_MS for every chunk that was sent before it (they stand in a line when there are more chunks than nodes).
const RENDER_WAIT_MS = 20 * 60 * 1000;
const RENDER_PER_JOB_MS = 2 * 60 * 1000;
// The whole node of the HUD may take 75 minutes; the wait of a chunk ends 10 minutes before
const RENDER_WAIT_MAX_MS = 65 * 60 * 1000;
const MAX_TRIES = 2;
// What ends the wait for good (no second try helps): a render node that is gone or stuck, like the scenes of the explainer video.
const RENDER_GONE = /^(Timed out waiting for job|Job .* not found in session|Backing session no longer exists)/;
const FORMATS = Object.freeze(['landscape', 'portrait', 'square']);
// the codes of the errors of the HUD (lib/nodes/nodes-music-video-hud.js); another node names its own
const HUD_CODES = Object.freeze({ noNode: 'HUD_NO_RENDER_NODE', noUploads: 'HUD_NODE_NO_UPLOADS', failed: 'HUD_RENDER_FAILED' });

function codedError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

const secondsText = (value) => `${Math.round(value * 10) / 10}`;
const isAbort = (err, ctx) => Boolean(ctx.signal?.aborted) || jobs.isAbortError(err);
// What ends the node instead of being tried again: the end of the run, an exhausted budget, a refusal of the account.
const isFatal = (err, ctx) => isAbort(err, ctx) || err?.name === 'BudgetError' || err?.name === 'RoleRestrictedError';

// Sends one chunk to the render node (the tool of the chat, with the frame rate). Returns the job. `assetIds` (optional) are the files beside the
// page; by default the footage of the chunk alone.
async function submitChunk(ctx, { html, label, quality, clipId, assetIds, format = 'landscape', fps = FPS, codes = HUD_CODES }) {
  // the end of the run stops the node here, before a job is sent to the render node
  if (ctx.signal?.aborted) throw jobs.abortError();
  if (!FORMATS.includes(format)) throw new Error(`Unknown format of the render node: ${format}`);
  let outcome;
  try {
    outcome = await tools.executeTool(ctx.toolCtx, 'render_motion_graphics', { html, label, quality, format, fps, asset_ids: assetIds || [clipId] });
  } catch (err) {
    if (err instanceof rendernode.RenderNodeError && /Kein Render-Node/.test(err.message)) throw codedError(codes.noNode, 'no render node is online');
    // a render node whose service cannot take a large file (the footage of a chunk is often more than the 24 MB that the old base64 transport takes) says so: the node has to be updated
    if (err instanceof rendernode.RenderNodeError && /keine grossen Uploads/.test(err.message)) throw codedError(codes.noUploads, 'the render node cannot take large files: its service has to be updated');
    throw err;
  }
  if (!outcome?.job) throw new Error('The render tool did not start a job');
  // a job that is not waited for (the node fails before it gets there) is remembered for the end of the run
  if (typeof ctx.watchJob === 'function') ctx.watchJob(outcome.job);
  return outcome.job;
}

// Waits for one chunk, once more with a new job when it failed. Returns { value, probe } of the rendered chunk.
async function finishChunk(ctx, state, { index, count, temp, log, fps = FPS, codes = HUD_CODES }) {
  const waitMs = Math.min(RENDER_WAIT_MS + index * RENDER_PER_JOB_MS, RENDER_WAIT_MAX_MS);
  // The length of a rendered chunk may differ from the plan by this much (the render node rounds to whole frames).
  const tolerance = 3 / fps;
  const name = `chunk ${index + 1} of ${count}`;
  let reason = '';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    try {
      const job = attempt === 1 ? state.job : await submitChunk(ctx, state.submit);
      const ids = await ctx.waitForJob(job, { timeoutMs: waitMs });
      const value = await assets.valueFromAsset(ctx.sessionId, ids[0]);
      temp.push(value.assetId);
      const probe = await ops.probeMedia(assets.assetFilePath(value), { ffprobePath: ffmpeg.binaries().ffprobe, signal: ctx.signal });
      if (!probe.video || !(probe.duration > 0)) throw new Error('the render produced no video');
      if (Math.abs(probe.duration - state.chunk.pageFrames / fps) > tolerance) {
        throw new Error(`the render is ${secondsText(probe.duration)} s long, the chunk needs ${secondsText(state.chunk.pageFrames / fps)} s`);
      }
      if (Math.abs(probe.video.fps - fps) > 0.01) log(`${name}: the render node drew ${secondsText(probe.video.fps)} fps, not ${fps}: the film is resampled`);
      return { value, probe };
    } catch (err) {
      if (isFatal(err, ctx)) throw err;
      reason = String(err?.message || err).slice(0, 300);
      if (err?.code === codes.noNode || err?.code === codes.noUploads) throw err;
      // a render node that is gone or stuck: a second try would wait as long again
      const gone = RENDER_GONE.test(reason);
      log(`${name}: ${reason}${gone || attempt >= MAX_TRIES ? '' : ' - drawing it once more'}`);
      if (gone) break;
    }
  }
  throw codedError(codes.failed, `${name} could not be drawn: ${reason}`, { chunk: index + 1, count });
}

// The run of all chunks: made ready (`prepare`: the footage cut and stored, the page built) and sent one after the other, then waited for all at the
// same time. Every chunk is waited for to its end (the others are drawn anyway), then the first failure ends the node. Returns [{ value, probe }].
async function renderChunks(ctx, { chunks, prepare, quality, temp, log, format = 'landscape', fps = FPS, codes = HUD_CODES }) {
  const states = [];
  for (const chunk of chunks) {
    const ready = await prepare(chunk);
    const submit = { html: ready.html, label: ready.label, quality, clipId: ready.clipId, format, fps, codes, ...(ready.assetIds ? { assetIds: ready.assetIds } : {}) };
    states.push({ chunk, submit, job: await submitChunk(ctx, submit) });
  }
  log(`${chunks.length} chunks sent to the render nodes`);
  const settled = await Promise.allSettled(states.map((state, index) => finishChunk(ctx, state, { index, count: chunks.length, temp, log, fps, codes })));
  const failed = settled.filter((entry) => entry.status === 'rejected');
  if (failed.length) {
    throw failed.find((entry) => isFatal(entry.reason, ctx))?.reason || failed[0].reason;
  }
  return settled.map((entry) => entry.value);
}

module.exports = { submitChunk, finishChunk, renderChunks, isFatal, FORMATS, HUD_CODES, MAX_TRIES, RENDER_WAIT_MS, RENDER_PER_JOB_MS, RENDER_WAIT_MAX_MS, RENDER_GONE, FPS };
