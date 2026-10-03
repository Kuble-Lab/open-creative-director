'use strict';

// Prepares a video for a provider that bills by the frames of what it receives (fal.video_segment, SAM 3): the first N
// seconds, at most 30 frames per second (a lower rate stays as it is, nothing is invented), at most 1920 pixels on the long
// side, H.264 in yuv420p without sound. The frames of the file that is really sent are counted exactly (ffprobe), so the
// price is known before anything is uploaded. A video that already fits is not touched.
// The decision and the ffmpeg arguments are pure; probing, encoding and counting run ffprobe / ffmpeg through
// ffmpeg.runProcess (abortable). The scratch folder belongs to the caller, which removes it.

const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const ops = require('./ffmpeg-ops');

const MAX_FPS = 30;
const MAX_EDGE = 1920;
// A rate that ffprobe reports a hair above 30 (30.0001) is still 30.
const FPS_EPSILON = 0.001;
// 60 s at 10 Mbit/s are 75 MB: a prepared video stays under the upload limit of lib/fal.js (90 MB) even where the image is busy.
const MAX_BITRATE = '10M';
const BUFFER_SIZE = '20M';
// A frame or two more than seconds x rate may come out of the cut (the first frame is counted); more than that is not a video at the rate.
const FRAME_SLACK = 2;
const PREPARED_FILE = 'prepared-video.mp4';
const PROBE_TIMEOUT_MS = 30 * 1000;
const COUNT_TIMEOUT_MS = 5 * 60 * 1000;

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A failed probe or encode as a short message for the node card (the tool output can be long); an abort stays an abort.
function failure(label, what, err, signal) {
  if (signal?.aborted) return err;
  return new Error(`${label}: ${what} (${String(err?.message || err).slice(0, 200)})`);
}

// What the preparation needs to know about a video file: stream facts of the first video stream, the container and whether
// there is sound. The size is the one of the picture as it is shown (a 90 degree rotation swaps width and height).
function describeProbe(data) {
  const probe = ops.normaliseMediaProbe(data); // throws when the file has no stream at all
  if (!probe.video) throw new Error('The file has no video stream');
  const stream = data.streams.find((item) => item && item.codec_type === 'video');
  return {
    codec: probe.video.codec,
    width: probe.video.width,
    height: probe.video.height,
    fps: probe.video.fps,
    duration: probe.duration,
    hasAudio: Boolean(probe.audio),
    pixFmt: String(stream.pix_fmt || ''),
    container: String(data.format?.format_name || ''),
    rotated: ops.streamRotation(stream) !== 0
  };
}

async function probeSource(file, { ffprobePath, signal } = {}) {
  const command = ffprobePath || ffmpeg.binaries().ffprobe;
  if (!command) throw new Error('ffprobe not found');
  const { stdout } = await ffmpeg.runProcess(command, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: PROBE_TIMEOUT_MS, signal });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`ffprobe output is invalid: ${err.message}`);
  }
  return describeProbe(data);
}

// The number of frames of the first video stream, counted by decoding (ffprobe -count_frames): exact, unlike the
// duration times the rate or the number the container claims.
async function countFrames(file, { ffprobePath, signal } = {}) {
  const command = ffprobePath || ffmpeg.binaries().ffprobe;
  if (!command) throw new Error('ffprobe not found');
  const args = ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file];
  const { stdout } = await ffmpeg.runProcess(command, args, { timeoutMs: COUNT_TIMEOUT_MS, signal });
  let frames = NaN;
  try {
    frames = Number(JSON.parse(stdout)?.streams?.[0]?.nb_read_frames);
  } catch (_) {
    /* reported below */
  }
  if (!Number.isInteger(frames) || frames < 1) throw new Error('The frames of the video could not be counted');
  return frames;
}

// What has to be done to a probed video: `reasons` names everything that does not fit yet (none = send the file as it is).
//   info        describeProbe() of the source
//   extension   the extension of the stored file
//   size        its size in bytes; maxBytes: what may be uploaded (a file above it is encoded again, with a bit rate limit)
// Returns { unchanged, reasons, scale, capFps }: scale is { width, height } or null (both sides even, the long side at most
// maxEdge, the aspect ratio kept), capFps says that the rate is above the limit and has to be brought down to it.
function decide(info, { maxSeconds, extension, size, maxBytes = Infinity, maxFps = MAX_FPS, maxEdge = MAX_EDGE } = {}) {
  const reasons = [];
  if (extension !== '.mp4' || !/\bmp4\b/.test(info.container) || info.codec !== 'h264') reasons.push('format');
  if (info.pixFmt !== 'yuv420p') reasons.push('pixel_format');
  if (info.hasAudio) reasons.push('audio');
  if (info.rotated) reasons.push('rotation');
  if (!(info.duration !== null && info.duration <= maxSeconds + 1e-6)) reasons.push('duration');
  // an unknown rate cannot be shown to be low enough: the cap is applied
  if (!(info.fps !== null && info.fps <= maxFps + FPS_EPSILON)) reasons.push('fps');
  let width = info.width;
  let height = info.height;
  if (!(width > 0 && height > 0)) throw new Error('The size of the video could not be read');
  const longSide = Math.max(width, height);
  if (longSide > maxEdge) {
    const factor = maxEdge / longSide;
    width = Math.round(width * factor);
    height = Math.round(height * factor);
  }
  // yuv420p needs even sides
  width = ops.even(width);
  height = ops.even(height);
  const scale = width !== info.width || height !== info.height ? { width, height } : null;
  if (scale) reasons.push('size');
  if (size > maxBytes) reasons.push('bytes');
  return { unchanged: reasons.length === 0, reasons, scale, capFps: reasons.includes('fps') };
}

// The most frames a video of `maxSeconds` seconds may have after the preparation.
function frameLimit(maxSeconds, maxFps = MAX_FPS) {
  return Math.ceil(maxSeconds * maxFps - 1e-9) + FRAME_SLACK;
}

// argv of the ffmpeg run that makes the prepared file: first maxSeconds seconds, the rate capped where it is above the
// limit, scaled where it is too big or odd, no sound, H.264 yuv420p with a bit rate ceiling.
function buildArgs(inputFile, outputFile, decision, { maxSeconds, maxFps = MAX_FPS } = {}) {
  const filters = [];
  if (decision.capFps) filters.push(`fps=${maxFps}`);
  if (decision.scale) filters.push(`scale=${decision.scale.width}:${decision.scale.height}:flags=lanczos`);
  filters.push('setsar=1', 'format=yuv420p');
  const spec = {
    graph: `[0:v]${filters.join(',')}[out]`,
    outputs: [{ kind: 'video', maps: ['[out]'], noAudio: true, args: ['-maxrate', MAX_BITRATE, '-bufsize', BUFFER_SIZE, '-t', ops.num(maxSeconds)] }]
  };
  return ops.assembleArgs(spec, [inputFile], [outputFile]);
}

// Probes the video, makes the prepared copy in `scratch` unless the video fits as it is, and counts the frames of the file that
// will be sent. Returns { file, unchanged, reasons, frames, bytes, source }: `file` is the source itself when it is sent unchanged.
// The count has the last word: a video whose rate varies can hold more frames than its average rate says (and than a file
// that "fits" should); it is then made again with the rate capped, so what is sent never has more than frameLimit() frames.
async function prepareVideo({ file, extension, size, scratch, maxSeconds, maxBytes, signal, binaries = ffmpeg.binaries(), label = 'video' }) {
  if (!binaries.available) {
    throw codedError('SEGMENT_FFMPEG_MISSING', 'ffmpeg and ffprobe are needed to prepare the video, but were not found. Nothing was uploaded or charged.');
  }
  let info;
  try {
    info = await probeSource(file, { ffprobePath: binaries.ffprobe, signal });
  } catch (err) {
    throw failure(label, 'the file could not be analysed', err, signal);
  }
  let decision = decide(info, { maxSeconds, extension, size, maxBytes });
  const limit = frameLimit(maxSeconds);
  for (;;) {
    let sendFile = file;
    let bytes = size;
    try {
      if (!decision.unchanged) {
        sendFile = path.join(scratch, PREPARED_FILE);
        await ffmpeg.runProcess(binaries.ffmpeg, buildArgs(file, sendFile, decision, { maxSeconds }), { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal });
        const stat = await fsp.stat(sendFile).catch(() => null);
        if (!stat || !stat.size) throw new Error('ffmpeg produced no output');
        bytes = stat.size;
      }
      const frames = await countFrames(sendFile, { ffprobePath: binaries.ffprobe, signal });
      if (frames <= limit) return { file: sendFile, unchanged: decision.unchanged, reasons: decision.reasons, frames, bytes, source: info };
      if (decision.capFps) {
        throw new Error(`${frames} frames, more than the ${limit} that ${maxSeconds} s at ${MAX_FPS} frames per second allow`);
      }
      decision = { ...decision, unchanged: false, capFps: true, reasons: [...decision.reasons, 'frames'] };
    } catch (err) {
      throw failure(label, 'the video could not be prepared', err, signal);
    }
  }
}

module.exports = {
  MAX_FPS,
  MAX_EDGE,
  PREPARED_FILE,
  frameLimit,
  describeProbe,
  probeSource,
  countFrames,
  decide,
  buildArgs,
  prepareVideo
};
