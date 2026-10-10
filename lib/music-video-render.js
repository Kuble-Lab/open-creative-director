'use strict';

// Running the plan of the cut of a music video (WP34, buildEditPlan in lib/music-video-edit.js) with ffmpeg.
//   single   one process, the arguments assembleArgs() builds from the spec
//   batched  a process per batch of scenes writes its frames, raw, to its standard output, and this module hands them to ONE encoder
//            process (its standard input), which fades out, lays the song underneath and writes the file. The batches run one after
//            the other, so the chains of only one batch exist at a time, and the film is encoded once. Raw frames carry no
//            timestamps, so a wrong number of them would shift everything after them: a batch that delivers other than the bytes of
//            its frames stops the whole job.
// An abort, a time-out or the end of any process of the job ends all of them at once. Nothing is written but the output file.

const { spawn } = require('child_process');

const ffmpegLib = require('./ffmpeg');
const ops = require('./nodes/ffmpeg-ops');
const editLib = require('./music-video-edit');

const TAIL_LENGTH = 8000;

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// The message of a process that failed, like lib/ffmpeg.js runProcess: how it ended and the last lines it said.
function failure(prefix, code, closeSignal, tail) {
  const detail = tail.split(/\r?\n/).filter(Boolean).slice(-8).join(' | ');
  return new Error(`${prefix}ffmpeg ist fehlgeschlagen (Exit ${(code ?? closeSignal) || 'unbekannt'}): ${detail}`);
}

// The batches and the encoder. `onSpawn(child, args)` is told about every process (the tests count them and look for leftovers).
function renderBatched(plan, { files, outputFile, ffmpegPath, signal, timeoutMs, onSpawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const running = new Set();
    const expectedBytes = plan.frames * plan.frameBytes;
    let done = false;
    let received = 0; // the bytes of frames the batches have delivered so far
    let batchesDone = false; // every batch delivered exactly its frames
    let encoderExit = null; // how the encoder ended, once it has
    let timer = null;

    function onAbort() {
      finish(abortError());
    }
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const child of running) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error(`ffmpeg hat nach ${Math.round(timeoutMs / 60000)} Minuten das Zeitlimit erreicht.`)), timeoutMs);
    timer.unref?.();

    // Starts ffmpeg. `closed` settles with how it ended, `tail` is the end of what it said.
    function launch(args, stdio) {
      const child = spawn(ffmpegPath, args, { stdio });
      running.add(child);
      onSpawn?.(child, args);
      const run = { child, tail: '' };
      child.stderr.on('data', (chunk) => {
        run.tail = (run.tail + chunk.toString()).slice(-TAIL_LENGTH);
      });
      run.closed = new Promise((settle) => {
        child.on('error', (err) => {
          finish(err);
          settle({ error: err });
        });
        child.on('close', (code, closeSignal) => {
          running.delete(child);
          settle({ code, closeSignal });
        });
      });
      return run;
    }

    // The job is done when the encoder has ended well and every batch has delivered its frames. The encoder stops at the length of the
    // film, so it can end a moment before the last batch process does (that one is still closing its clips): then the batch is waited
    // for. An encoder that ended well without having received all the frames is an error, and so is one that failed.
    function settle() {
      if (done || !encoderExit) return;
      const { code, closeSignal } = encoderExit;
      if (code !== 0) finish(failure('', code, closeSignal, encoder.tail));
      else if (batchesDone) finish();
      else if (received < expectedBytes) finish(new Error('The encoder ended before it had all the frames'));
    }

    let encoder;
    try {
      // the frames and the song; a film without a song (buildEditPlan noSong) has an encoder of the frames only
      encoder = launch(ops.assembleArgs(plan.final, plan.final.inputOpts.length === 1 ? ['pipe:0'] : ['pipe:0', files[0]], [outputFile]), ['pipe', 'ignore', 'pipe']);
    } catch (err) {
      finish(err);
      return;
    }
    // an encoder that ends early (a wrong argument, a full disk) makes the writing fail: its own end says why
    encoder.child.stdin.on('error', () => {});
    encoder.closed.then((exit) => {
      if (exit.error) return;
      encoderExit = exit;
      settle();
    });

    (async () => {
      for (const batch of plan.batches) {
        const run = launch(editLib.batchArgs(batch, files), ['ignore', 'pipe', 'pipe']);
        let bytes = 0;
        run.child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          received += chunk.length;
        });
        run.child.stdout.pipe(encoder.child.stdin, { end: false });
        // all of its output has been read when the process is closed
        const { code, closeSignal, error } = await run.closed;
        if (done) return;
        if (error) throw error;
        const range = `${batch.from + 1} to ${batch.to}`;
        if (code !== 0) throw failure(`Scenes ${range}: `, code, closeSignal, run.tail);
        if (bytes !== batch.frames * plan.frameBytes) {
          throw new Error(`The cut of scenes ${range} delivered ${Math.round((bytes / plan.frameBytes) * 100) / 100} frames instead of ${batch.frames}`);
        }
      }
      batchesDone = true;
      if (!encoderExit) encoder.child.stdin.end();
      settle();
    })().catch(finish);
  });
}

// Renders `plan` (buildEditPlan) into `outputFile`. `files` are the input files in the order the plan counts them (the song first).
async function renderPlan(plan, { files, outputFile, ffmpegPath, signal, timeoutMs = ffmpegLib.PROCESS_TIMEOUT_MS, onSpawn } = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg wurde nicht gefunden');
  if (plan.mode === 'single') {
    await ffmpegLib.runProcess(ffmpegPath, ops.assembleArgs(plan.spec, files, [outputFile]), { timeoutMs, signal });
    return;
  }
  if (plan.mode !== 'batched') throw new Error(`Unknown plan mode ${plan.mode}`);
  await renderBatched(plan, { files, outputFile, ffmpegPath, signal, timeoutMs, onSpawn });
}

module.exports = { renderPlan };
