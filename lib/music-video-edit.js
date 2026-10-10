'use strict';

// Cutting a music video (WP34, node "Cut to the beat"): the ffmpeg arguments that turn the clips of the scenes and the song into one
// video. Pure builders in the style of lib/nodes/ffmpeg-ops.js: an op spec for assembleArgs(), nothing here touches the disk. The node
// (lib/nodes/nodes-music-video.js) probes the files and runs the plan with lib/music-video-render.js through runOp() of nodes-edit.js.
//
// How the scenes are cut:
//   - every scene gets exactly its number of frames: the boundaries are rounded to frames once (round(time * fps)), a scene is the
//     difference of two boundaries, so the rounding never adds up to a drift against the song
//   - a story clip longer than its scene is cut off at the scene's length; one that is a little shorter is slowed down (to 0.8 at
//     most), and what is still missing is filled with its last frame
//   - the clip of the singer is never slowed down (it would lose the lips): longer it is cut off, shorter it holds its last frame;
//     it starts with its scene, exactly where the song slice it was made from starts
//   - the clip of a still (WP44: a scene of the kind "still", a picture that the zoom or the parallax of image.to_video moves) is treated like a
//     story clip: a little too short it is slowed down to 0.8 at most, then the last frame is held
//   - the song is laid underneath from the start of the first scene to the end of the last one, with a fade-out at the end
//   - transitions: cut; crossfade (the next scene fades in over the first quarter second of its time, the previous clip runs on
//     under it, so the scene boundary stays on the beat); flash (the next scene comes in from white)
//   - captions (optional): the script of lib/captions-ass.js is burnt into the film at the end of the graph, before the fade-out, in
//     the one process that makes the film or in the one encoder behind the batches - once, whichever way the film is cut. Its times
//     are the times of the film (the first scene starts `start` seconds into the song); see captionScript()
//
// How much memory it takes: every scene is a chain of filters with a decoder of its own and frames in flight, so one ffmpeg process
// needs memory in proportion to the number of scenes it holds (50 test clips of 5 s at 1080p: 1.8 GB in one process, with the
// encoder on three threads as on a machine with two CPUs). buildEditPlan() therefore cuts a film of more than BATCH_SCENES scenes in
// batches: a process per batch hands its finished frames (raw, no timestamps, so nothing can drift) to ONE encoder process, which also
// fades out and lays the song underneath. The film is encoded once, as it would be in a single process; no process opens more than
// BATCH_SCENES clips (the same 50 clips: 0.6 to 0.75 GB for all processes together, see BATCH_SCENES).
//
// Optional fields of a scene, for cuts that are not made from the clips of a music video (WP53, the event video, lib/event-video/cut.js); a scene
// without them is cut exactly as before, byte for byte:
//   pre     filters right after the decoder, before anything else (a still that is decoded once and repeated, the tone mapping of HDR footage)
//   speed   the speed of the material (0.5 plays it at half its speed); the scene still gets exactly its frames
//   frame   the filters that bring the material to the size of the film, in place of the scale and the crop or pad of `fit` (a crop window that
//           follows an anchor, a picture over a blurred copy of itself); a text, or a function ({ frames, fps, width, height }) -> text. It may hold
//           labels of its own (a split and an overlay): they must be unique in the film
//   eq      filters after the picture is yuv420p at the size of the film (the look of a scene)
// These four fields are filter text that goes into the ffmpeg graph as it is, so they are read only when the caller passes sceneFilters: true
// (the event video builds them in code). The shot list of a music video is a text input a person can edit: there they are ignored.
// Options of buildEditPlan(): inputOpts (the options of every input, in place of one decoder thread; a seek with -ss), noSong (no song: input 0 is
// a clip like the others and the film has no sound), crf (the quality of the encoder, 19 by default) and sceneFilters (see above).

const ops = require('./nodes/ffmpeg-ops');
const captionsLib = require('./captions-ass');

const TRANSITIONS = Object.freeze(['cut', 'crossfade', 'flash']);
const RESOLUTIONS = Object.freeze(['720p', '1080p']);
const FPS_VALUES = Object.freeze([24, 25, 30]);
const FIT_MODES = Object.freeze(['crop', 'pad']);
// a clip is slowed down to this speed at the lowest (it is then 1.25 times as long)
const MIN_SPEED = 0.8;
const CROSSFADE_SEC = 0.25;
const FLASH_SEC = 0.15;
const MAX_FADE_OUT_SEC = 10;
// The most clips one process opens at a time: the scenes of a batch, and under a crossfade the clip before the batch as well (the
// batch holds one scene less then). Measured with test clips of 5 s at 1080p, the encoder on three threads (as on a machine with two
// CPUs): the peaks of the encoder (0.33 GB) and of the largest batch process added up, for 50 clips
//   cut, three scenes per batch                        0.61 GB   (24 clips: two scenes 0.53 GB, four 0.68 GB)
//   flash, three scenes per batch                      0.73 GB   (24 clips: two scenes 0.64 GB, four 0.78 GB)
//   crossfade, two scenes and the clip before          0.72 GB   (24 clips: three scenes and the clip 0.78 GB, four 0.88 GB)
// so no transition needs more than about 0.75 GB. The run time hardly depends on it (24 scenes at 1080p: a cut takes 19.4 to 19.9 s
// with one to four scenes per batch, a crossfade 26.2 s with one, 24.6 with two, 23.9 with three and 23.4 s with four).
const BATCH_SCENES = 3;

const num = ops.num;

// [width, height] of the video: the short side is 720 or 1080 pixels.
function outputSize(aspectRatio, resolution) {
  const side = resolution === '1080p' ? 1080 : 720;
  if (aspectRatio === '9:16') return [side, (side * 16) / 9];
  if (aspectRatio === '1:1') return [side, side];
  return [(side * 16) / 9, side];
}

// The frame boundaries of the scenes: boundary[i] is the frame at which scene i starts, boundary[n] the end of the last scene.
function frameBounds(shots, fps) {
  const bounds = [Math.round(shots[0].start * fps)];
  for (const shot of shots) bounds.push(Math.max(bounds[bounds.length - 1] + 1, Math.round(shot.end * fps)));
  return bounds;
}

// The chain of one scene: material -> exactly `frames` frames at `fps`, `width` x `height`.
//   seconds   the length of the clip as probed (null if unknown)
//   frames    the frames the scene has to fill (with the part under the next scene for a crossfade)
function sceneChain({ kind, seconds, frames, fps, width, height, fit, flash, pre, speed: ownSpeed, frame, eq }) {
  const target = frames / fps;
  const parts = pre ? [pre, 'setpts=PTS-STARTPTS'] : ['setpts=PTS-STARTPTS'];
  let speed = 1;
  if ((kind === 'story' || kind === 'still') && seconds && seconds > 0 && seconds < target - 0.5 / fps) {
    speed = Math.max(MIN_SPEED, seconds / target);
    if (speed < 0.999) parts.push(`setpts=${num(1 / speed)}*PTS`);
    else speed = 1;
  } else if (kind !== 'story' && kind !== 'still' && Number.isFinite(ownSpeed) && ownSpeed > 0 && Math.abs(ownSpeed - 1) > 0.001) {
    // the speed the scene names (the slow motion of an event video; the clips of a music video have their own rule above)
    speed = ownSpeed;
    parts.push(`setpts=${num(1 / speed)}*PTS`);
  }
  parts.push(`fps=${fps}:round=near`);
  // the last frame fills what is still missing (always added: the exact count is set by the trim after it)
  parts.push(`tpad=stop=${frames}:stop_mode=clone`);
  parts.push(`trim=end_frame=${frames}`);
  parts.push('setpts=PTS-STARTPTS');
  if (frame) {
    parts.push(typeof frame === 'function' ? frame({ frames, fps, width, height }) : frame);
  } else if (fit === 'pad') {
    parts.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    parts.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else {
    parts.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`);
    parts.push(`crop=${width}:${height}`);
  }
  parts.push('setsar=1', 'format=yuv420p');
  if (eq) parts.push(eq);
  if (flash) parts.push(`fade=t=in:st=0:d=${num(FLASH_SEC)}:color=white`);
  return { chain: parts.join(','), speed };
}

// The settings of the cut that decide the size and the length of the film: the frame rate, the transition, the fit, the size, the
// frame boundaries of the scenes and the length in frames.
function settings(shots, params) {
  const list = shots.shots;
  if (!list.length) throw new Error('There are no scenes to cut');
  const fps = FPS_VALUES.includes(Number(params.fps)) ? Number(params.fps) : 25;
  const transition = TRANSITIONS.includes(params.transition) ? params.transition : 'cut';
  const fit = FIT_MODES.includes(params.fit) ? params.fit : 'crop';
  const [width, height] = outputSize(shots.aspect_ratio, params.resolution);
  const bounds = frameBounds(list, fps);
  const totalFrames = bounds[bounds.length - 1] - bounds[0];
  return { list, fps, transition, fit, width, height, bounds, totalFrames, total: totalFrames / fps };
}

// Size, frame rate and length of the film, and where it starts in the song: { width, height, fps, start, total } (seconds). The same
// numbers the cut itself uses, so that things made for the film beforehand (the caption script) fit it exactly.
function geometry({ shots, params }) {
  const { width, height, fps, bounds, total } = settings(shots, params);
  return { width, height, fps, start: bounds[0] / fps, total };
}

// What both ways of cutting share: the settings, the frame boundaries and the chain of every scene.
//   shots   the parsed shots (lib/music-video-plan.js parseShots) in order
//   order   one entry per scene: the index of its clip file among the inputs (the song is input 0)
//   infos   probe results of the inputs in the same order (song first)
//   params  { transition, resolution, fps, fit, fade_out }
//   captionsFile  the caption script to burn in (path), or none
function prepare({ shots, order, infos, params, captionsFile = null, inputOpts = null, noSong = false, crf = null, sceneFilters = false }) {
  const { list, fps, transition, fit, width, height, bounds, totalFrames, total } = settings(shots, params);
  if (order.length !== list.length) throw new Error('Every scene needs a clip');
  const overlap = transition === 'crossfade' ? Math.max(1, Math.round(CROSSFADE_SEC * fps)) : 0;
  const own = (index) => bounds[index + 1] - bounds[index];
  // the frames over which scene `index` fades in from the one before (a scene never fades longer than it lasts)
  // (a scene with `hardCut` comes in over one frame only: the explainer video cuts hard to and from the person on camera, whose last
  // words must not be faded away)
  const fadeInto = (index) => (overlap && index >= 1 && index < list.length ? Math.min(list[index].hardCut ? 1 : overlap, own(index) - 1) : 0);
  // The chain of scene `index`. Under a crossfade the previous scene runs on while the next one fades in: a scene needs its own
  // frames and the fade over the next one.
  const scene = (index) => {
    const info = infos[order[index]];
    if (!info || !info.video) throw new Error(`The clip of scene ${index + 1} has no video`);
    const { chain, speed } = sceneChain({
      kind: list[index].kind,
      seconds: info.duration || null,
      frames: own(index) + fadeInto(index + 1),
      fps,
      width,
      height,
      // a scene can name its own fit (the person on camera of an explainer video is padded, the scenes are cropped)
      fit: FIT_MODES.includes(list[index].fit) ? list[index].fit : fit,
      flash: transition === 'flash' && index > 0,
      // the optional fields of a scene, only for a caller that builds them itself (see the head of this file)
      ...(sceneFilters ? { pre: list[index].pre, speed: list[index].speed, frame: list[index].frame, eq: list[index].eq } : {})
    });
    return { chain, speed, info };
  };
  const fadeOut = Math.min(MAX_FADE_OUT_SEC, Math.max(0, Number(params.fade_out) || 0), total / 2);
  // the options of input `index`: one decoder thread, unless the cut names its own (a seek, more threads for 4K footage)
  const optsOf = (index) => (inputOpts && inputOpts[index] ? inputOpts[index] : ['-threads', '1']);
  return { list, order, infos, fps, transition, width, height, bounds, totalFrames, total, own, fadeInto, scene, fadeOut, captionsFile, optsOf, noSong, crf };
}

// The end of every graph: the captions (if there are any), the fade-out over the whole film (`joined` is the film so far) and the song
// underneath, which is input `songInput`. Returns the lines of the graph. The captions come before the fade-out, so they fade with
// the picture.
function endOfGraph(edit, joined, songInput) {
  const { bounds, fps, total, fadeOut, infos, captionsFile } = edit;
  const picture = [];
  if (captionsFile) picture.push(captionsLib.assFilter(captionsFile));
  if (fadeOut > 0.05) picture.push(`fade=t=out:st=${num(total - fadeOut)}:d=${num(fadeOut)}`);
  const lines = [`[${joined}]${picture.length ? picture.join(',') : 'null'}[v]`];
  // a film without a song (noSong) has no sound at all
  if (edit.noSong) return lines;
  const song = infos[0];
  if (!song || !song.audio) throw new Error('The song has no audio');
  const start = bounds[0] / fps;
  const audioParts = [`atrim=start=${num(start)}:end=${num(start + total)}`, 'asetpts=PTS-STARTPTS', `apad=whole_dur=${num(total)}`];
  if (fadeOut > 0.05) audioParts.push(`afade=t=out:st=${num(total - fadeOut)}:d=${num(fadeOut)}`);
  lines.push(`[${songInput}:a]${audioParts.join(',')}[a]`);
  return lines;
}

// The encoder of the film: the same in one process and in batches.
function encoderOutput(edit) {
  const args = ['-preset', 'veryfast', '-crf', edit.crf ? String(edit.crf) : '19', '-r', String(edit.fps), '-t', num(edit.total)];
  if (edit.noSong) return { kind: 'video', maps: ['[v]'], noAudio: true, args };
  return { kind: 'video', maps: ['[v]', '[a]'], args };
}

// What was done per scene (for the log and the tests).
function summaryOf(edit) {
  return edit.list.map((shot, index) => {
    const { speed, info } = edit.scene(index);
    return { index, kind: shot.kind, frames: edit.own(index), speed, fromClip: info.duration || null };
  });
}

// One process for the whole film. Returns { graph, inputOpts, outputs, summary, fps, width, height, seconds, frames }, an op spec
// for assembleArgs(); `summary` tells what was done per scene.
function buildEditSpec(args) {
  const edit = prepare(args);
  const { list, bounds, fps, transition } = edit;

  const lines = [];
  const labels = [];
  list.forEach((_shot, index) => {
    lines.push(`[${edit.order[index]}:v]${edit.scene(index).chain}[v${index}]`);
    labels.push(`v${index}`);
  });

  // joined
  let joined;
  if (list.length === 1) {
    joined = labels[0];
  } else if (transition === 'crossfade') {
    // xfade: every scene starts fading in at the boundary of its scene
    let previous = labels[0];
    for (let index = 1; index < list.length; index += 1) {
      const into = index === list.length - 1 ? 'vx' : `x${index}`;
      const fade = edit.fadeInto(index);
      lines.push(`[${previous}][${labels[index]}]xfade=transition=fade:duration=${num(fade / fps)}:offset=${num((bounds[index] - bounds[0]) / fps)}[${into}]`);
      previous = into;
    }
    joined = previous;
  } else {
    lines.push(`${labels.map((label) => `[${label}]`).join('')}concat=n=${list.length}:v=1:a=0[vx]`);
    joined = 'vx';
  }
  lines.push(...endOfGraph(edit, joined, 0));

  return {
    graph: lines.join(';'),
    // one decoder thread per input: up to 51 files are open at once, and only one clip is decoded at a time (a third less memory)
    inputOpts: edit.infos.map((_info, index) => edit.optsOf(index)),
    outputs: [encoderOutput(edit)],
    summary: summaryOf(edit),
    fps,
    width: edit.width,
    height: edit.height,
    seconds: edit.total,
    frames: edit.totalFrames
  };
}

// The scenes [from, to) as one process that writes their frames, raw, to its standard output. Returns
//   { from, to, frames, inputs, inputOpts, graph, map }
// `inputs` are the clip files it opens (indexes among the inputs of the node), `graph` ends in `map`. It has exactly `frames` frames.
function buildBatch(edit, from, to) {
  const { bounds, fps, transition, order } = edit;
  const frames = bounds[to] - bounds[from];
  const inputs = [];
  const lines = [];
  const labels = [];
  // Under a crossfade the scene before the batch runs on while the first scene of the batch fades in: its last frames come from a
  // second decoder of the same clip, through the same chain as in the batch before (so with the same slowing down), and the film is
  // the one that a single process would make.
  const fade = edit.fadeInto(from);
  let tail = null;
  if (transition === 'crossfade' && from > 0 && fade > 0) {
    inputs.push(order[from - 1]);
    lines.push(`[0:v]${edit.scene(from - 1).chain},trim=start_frame=${edit.own(from - 1)},setpts=PTS-STARTPTS[tail]`);
    tail = 'tail';
  }
  for (let index = from; index < to; index += 1) {
    inputs.push(order[index]);
    lines.push(`[${inputs.length - 1}:v]${edit.scene(index).chain}[v${index}]`);
    labels.push(`v${index}`);
  }

  let joined;
  if (transition === 'crossfade' && (tail || labels.length > 1)) {
    let previous = tail || labels[0];
    for (let index = tail ? from : from + 1; index < to; index += 1) {
      const into = `x${index}`;
      // the fade-in of the first scene starts with the batch; the others where their scene starts
      const offset = tail && index === from ? 0 : (bounds[index] - bounds[from]) / fps;
      lines.push(`[${previous}][v${index}]xfade=transition=fade:duration=${num(edit.fadeInto(index) / fps)}:offset=${num(offset)}[${into}]`);
      previous = into;
    }
    joined = previous;
  } else if (labels.length === 1) {
    joined = labels[0];
  } else {
    lines.push(`${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=1:a=0[vj]`);
    joined = 'vj';
  }
  // what runs on under the fade-in of the next batch is not part of this batch
  lines.push(`[${joined}]trim=end_frame=${frames},setpts=PTS-STARTPTS[vb]`);
  return { from, to, frames, inputs, inputOpts: inputs.map((fileIndex) => edit.optsOf(fileIndex)), graph: lines.join(';'), map: '[vb]' };
}

// The arguments of ffmpeg for a batch (without the binary): the clips named by `batch.inputs` are taken from `files`, the frames go to
// the standard output as raw yuv420p.
function batchArgs(batch, files) {
  const args = ['-nostdin', '-v', 'error', '-y'];
  batch.inputs.forEach((fileIndex, position) => args.push(...(batch.inputOpts[position] || []), '-i', files[fileIndex]));
  args.push('-filter_complex', batch.graph, '-map', batch.map, '-an', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1');
  return args;
}

// The plan of the cut. Up to `batchScenes` scenes (BATCH_SCENES) one process makes the film:
//   { mode: 'single', spec, outputs, summary, fps, width, height, seconds, frames }   spec: see buildEditSpec
// more scenes are cut in batches, the frames of which one encoder process takes from its standard input:
//   { mode: 'batched', batches: [batch...], final, outputs, frameBytes, summary, fps, width, height, seconds, frames }
//   final   the op spec of the encoder for assembleArgs(final, ['pipe:0', song], [output]): the raw frames, the fade-out, the song
// `outputs` is what runOp() needs to name the output file. lib/music-video-render.js runs either of them.
function buildEditPlan({ batchScenes = BATCH_SCENES, ...args }) {
  const clips = Number.isInteger(batchScenes) && batchScenes >= 1 ? batchScenes : BATCH_SCENES;
  if (args.shots.shots.length <= clips) {
    const spec = buildEditSpec(args);
    return { mode: 'single', spec, outputs: spec.outputs, summary: spec.summary, fps: spec.fps, width: spec.width, height: spec.height, seconds: spec.seconds, frames: spec.frames, captions: Boolean(args.captionsFile) };
  }
  const edit = prepare(args);
  // under a crossfade a batch opens the clip before its first scene, too, so it holds one scene less (but one at least)
  const size = edit.transition === 'crossfade' ? Math.max(1, clips - 1) : clips;
  const batches = [];
  for (let from = 0; from < edit.list.length; from += size) batches.push(buildBatch(edit, from, Math.min(edit.list.length, from + size)));
  const final = {
    graph: endOfGraph(edit, '0:v', 1).join(';'),
    // the raw frames, and the song (a film without a song has the frames only: lib/music-video-render.js opens the inputs these name)
    inputOpts: [['-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', `${edit.width}x${edit.height}`, '-framerate', String(edit.fps)], ...(edit.noSong ? [] : [[]])],
    outputs: [encoderOutput(edit)]
  };
  return {
    mode: 'batched',
    batches,
    final,
    outputs: final.outputs,
    frameBytes: (edit.width * edit.height * 3) / 2,
    summary: summaryOf(edit),
    fps: edit.fps,
    width: edit.width,
    height: edit.height,
    seconds: edit.total,
    frames: edit.totalFrames,
    captions: Boolean(edit.captionsFile)
  };
}

// The caption script for the film that buildEditPlan() describes: as large as the film, its times counted from the start of the film
// (the first scene begins `start` seconds into the song, and the times of the lyrics are times of the song), nothing beyond its end.
//   timing  the lyric times (lib/lyrics-timing.js, JSON text or object)   style  karaoke | words | lines   position  bottom | middle | top
// Returns what captionsLib.buildAss() returns; `events` is 0 where there is nothing to show (a song without words).
function captionScript({ shots, params, timing, style = 'karaoke', position = 'bottom' }) {
  const film = geometry({ shots, params });
  return captionsLib.buildAss({ timing, width: film.width, height: film.height, style, position, offset: -film.start, duration: film.total });
}

// ffmpeg arguments for a slice of the song, exact to the sample: the singer's scenes are made from it. The output is a WAV (no
// encoder delay that would move the lips against the voice).
function sliceAudioArgs(inputFile, start, duration, outputFile) {
  return ['-nostdin', '-v', 'error', '-y', '-i', inputFile, '-vn', '-af', `atrim=start=${num(start)}:duration=${num(duration)},asetpts=PTS-STARTPTS`, '-c:a', 'pcm_s16le', outputFile];
}

module.exports = {
  TRANSITIONS,
  RESOLUTIONS,
  FPS_VALUES,
  FIT_MODES,
  MIN_SPEED,
  CROSSFADE_SEC,
  FLASH_SEC,
  BATCH_SCENES,
  outputSize,
  frameBounds,
  geometry,
  captionScript,
  sceneChain,
  buildEditSpec,
  buildEditPlan,
  batchArgs,
  sliceAudioArgs
};
