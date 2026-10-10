'use strict';

// The cut of the event video (WP53, node event_video.cut, spec §3, §7): the plan `shots` (v1, independent of the format, lib/event-video/contract.js)
// becomes one film of the format without sound (H.264, 24 fps, the size of the format) and the stem of the sound of the clips. Pure builders of ffmpeg
// arguments in the style of lib/music-video-edit.js, whose cut (frame-exact scenes, batches of three clips, one encoder, the crossfade) does the work:
// every shot is a scene with the optional fields of a scene of that module (pre, speed, frame, eq) and an input of its own (a seek with -ss).
//
//   kind video, soundbite   the clip from `from` (a soundbite from `from` to `to`), at `speed` (slow motion 0.5 or 0.75), reframed (reframe.js)
//   kind photo              the still of the photo (stillArgs: turned by its EXIF orientation, made small once), zoomed or panned (zoompan)
//   kind photo_ai, photo_parallax   the clip of the AI animation or of the parallax (image.to_video), reframed like a video
//   transition              cut and match are hard cuts; dissolve is the crossfade of the cut (the next shot fades in over its first quarter second)
//   look                    the server takes only YUV filters (eq): contrast 0.9 + 0.4 c, saturation 0.7 + 0.7 s, gamma 1.05 - 0.1 c, brightness = the
//                           exposure of the shot (spec §5c); HDR footage (hdr: true) is tone-mapped with zscale where ffmpeg has it, else the fallback look
//   colour                  every scene ends in BT.709, limited range, and says so (setparams)
//   nat                     natArgs: the sound of every video shot at its time in the film (slow motion and photos are silent), one WAV; a film without a
//                           clip with sound has no stem (spec: a photo-only event mixes only music and voice)
//
//   cutArgs(shots, format, files, options)   -> { plan, files, fits, notes }: plan is a renderPlan spec of lib/music-video-render.js, files its inputs
//   stillArgs({ inputFile, outFile, orientation, format, fit, width, height })   a photo made small once (before zoompan)
//   natArgs(shots, files, { outFile })       -> { args, count } or null without a clip with sound
//   jpegInfo(buffer)                         width, height and EXIF orientation of a JPEG (no dependency; null for anything else)

const contract = require('./contract');
const reframe = require('./reframe');
const editLib = require('../music-video-edit');
const ops = require('../nodes/ffmpeg-ops');

const num = ops.num;
const FPS = contract.FPS;
const SAMPLE_RATE = 48000;
// a decoder of 4K footage gets two threads, smaller footage one (spec §7: -threads 2 above 1080p)
const BIG_PIXELS = 1920 * 1088;
// the fade at the ends of a piece of clip sound, against clicks
const NAT_FADE_SEC = 0.04;
const QUALITY_CRF = Object.freeze({ standard: 19, high: 16 });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round3 = (value) => Math.round(value * 1000) / 1000;

function cutError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

/* ---------- the look (spec §5c) ---------- */

// The eq of a shot: the look of the plan and the exposure of the shot; `hdrFallback` adds the fallback look of HDR footage that is not tone-mapped.
function lookFilter(look, exposure = 0, { hdrFallback = false } = {}) {
  const c = clamp(Number(look && look.contrast) || 0, 0, 1);
  const s = clamp(Number(look && look.saturation) || 0, 0, 1);
  const contrast = 0.9 + 0.4 * c + (hdrFallback ? 0.1 : 0);
  const saturation = 0.7 + 0.7 * s + (hdrFallback ? 0.15 : 0);
  const gamma = 1.05 - 0.1 * c;
  const brightness = clamp(Number(exposure) || 0, -contract.MAX_EXPOSURE, contract.MAX_EXPOSURE);
  return `eq=contrast=${num(contrast)}:saturation=${num(saturation)}:gamma=${num(gamma)}:brightness=${num(brightness)}`;
}

// The tags of every frame (the encoder takes the colour from the frames)
const TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
// HDR (HLG or PQ) to SDR BT.709 (spec §5c)
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/* ---------- the sources ---------- */

// Which list a shot takes its source from, and its index there (D1)
function sourceOf(shot) {
  if (shot.kind === 'video' || shot.kind === 'soundbite') return { list: 'videos', index: shot.source };
  if (shot.kind === 'photo') return { list: 'photos', index: shot.source };
  if (shot.kind === 'photo_ai') return { list: 'ai_clips', index: shot.clip };
  if (shot.kind === 'photo_parallax') return { list: 'parallax_clips', index: shot.clip };
  return null;
}

// The source of every shot, or EVENTCUT_SOURCE_MISSING for the first shot whose list has no such element. `lists`: { videos, photos, ai_clips,
// parallax_clips }, arrays of anything (paths, values).
function resolveSources(shots, lists) {
  return shots.shots.map((shot) => {
    const where = sourceOf(shot);
    const list = (where && lists[where.list]) || [];
    if (!where || !Number.isInteger(where.index) || where.index < 0 || where.index >= list.length || !list[where.index]) {
      throw cutError(contract.ERRORS.EVENTCUT_SOURCE_MISSING, `${shot.id}: ${where ? `${where.list}[${where.index}]` : shot.kind} is not connected (${list.length} arrived)`, {
        shot: shot.id,
        list: where ? where.list : shot.kind,
        index: where ? where.index : null,
        count: list.length
      });
    }
    return { ...where, item: list[where.index] };
  });
}

// The frames of a shot in the film and its length in seconds
function shotSeconds(shot) {
  return Math.max(1, Math.round(shot.end * FPS) - Math.round(shot.start * FPS)) / FPS;
}

/* ---------- photos ---------- */

// Width, height and EXIF orientation (1..8) of a JPEG from the start of its file; null when it is not a JPEG or has no frame header there.
function jpegInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let orientation = 1;
  let size = null;
  try {
    for (let p = 2; p + 4 <= buffer.length; ) {
      if (buffer[p] !== 0xff) break;
      const marker = buffer[p + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = buffer.readUInt16BE(p + 2);
      if (marker === 0xe1 && buffer.toString('ascii', p + 4, p + 10) === 'Exif\0\0') {
        const tiff = buffer.subarray(p + 10, p + 2 + length);
        const little = tiff.toString('ascii', 0, 2) === 'II';
        const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
        const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
        const ifd = u32(4);
        const count = u16(ifd);
        for (let i = 0; i < count && ifd + 2 + i * 12 + 12 <= tiff.length; i += 1) {
          const at = ifd + 2 + i * 12;
          if (u16(at) === 0x112) orientation = clamp(u16(at + 8), 1, 8);
        }
      }
      // the frame header (SOF0..SOF15 without DHT, JPG and DAC) holds the size
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        size = { height: buffer.readUInt16BE(p + 5), width: buffer.readUInt16BE(p + 7) };
        break;
      }
      p += 2 + length;
    }
  } catch (_) {
    // a header cut short: what was read so far
  }
  if (!size) return null;
  const turned = orientation >= 5;
  return { width: turned ? size.height : size.width, height: turned ? size.width : size.height, stored: size, orientation };
}

// The filters that turn a photo by its EXIF orientation (ffmpeg is told not to: -noautorotate, so 6.1 and 8 do the same)
function orientationFilters(orientation) {
  return { 2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'], 5: ['transpose=clock', 'hflip'], 6: ['transpose=clock'], 7: ['transpose=clock', 'vflip'], 8: ['transpose=cclock'] }[orientation] || [];
}

// A photo made small once (spec: a 24 MP photo is scaled down before zoompan): turned upright, scaled to at most twice the size it is shown at
// (reframe.stillSize), written as a PNG (no second JPEG generation). `width` and `height` are its size as shown (after the orientation).
function stillArgs({ inputFile, outFile, orientation = 1, format, fit, width, height }) {
  const size = reframe.stillSize(width, height, format, fit);
  const filters = [...orientationFilters(orientation), `scale=${size.width}:${size.height}:flags=lanczos`, 'format=rgb24'];
  return { args: ['-nostdin', '-v', 'error', '-y', '-noautorotate', '-i', inputFile, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', outFile], size };
}

/* ---------- the cut ---------- */

// The scene of a shot for lib/music-video-edit.js and the options of its input. `source`: { path, width, height, fps, seconds, audio } of what it is
// cut from (for a photo: the still). Returns { scene, inputOpts, fit, note }.
function sceneOf(shot, index, source, { format, look, hdr }) {
  const base = { start: shot.start, end: shot.end, kind: 'event', hardCut: shot.transition !== 'dissolve' };
  const exposure = Number.isFinite(shot.exposure) ? shot.exposure : 0;
  const tagged = (filters) => `${filters},${TAGS}`;
  if (shot.kind === 'photo') {
    const { fit } = reframe.chooseFit(shot, source.width, source.height, format);
    const filters = reframe.photoFilters({ shot, still: source, format, fit, tag: index });
    return {
      scene: { ...base, pre: filters.pre, frame: filters.frame, eq: tagged(lookFilter(look, exposure)) },
      inputOpts: ['-threads', '1', '-framerate', String(FPS)],
      fit
    };
  }
  const { fit } = reframe.chooseFit(shot, source.width, source.height, format);
  const anchor = reframe.anchorOf(shot);
  const moving = shot.kind === 'video' || shot.kind === 'soundbite';
  const speed = shot.kind === 'video' && contract.SPEEDS.includes(shot.speed) ? shot.speed : 1;
  const from = moving && Number.isFinite(shot.from) ? Math.max(0, shot.from) : 0;
  const isHdr = moving && shot.hdr === true;
  const pre = isHdr && hdr === 'zscale' ? TONEMAP : undefined;
  // the start zoom of a detail (D18) narrows the crop; a clip over its blurred copy is shown whole
  const zoom = reframe.zoomOf(shot);
  const frame = fit === 'blur' ? reframe.blurFrame({ format, tag: index }) : ({ frames, fps }) => reframe.cropFrame({ format, anchor, frames, fps, zoom });
  const threads = (source.width || 0) * (source.height || 0) > BIG_PIXELS ? '2' : '1';
  const inputOpts = from > 0 ? ['-threads', threads, '-ss', num(from)] : ['-threads', threads];
  const note = isHdr && hdr !== 'zscale' ? `${shot.id}: HDR footage without zscale: the fallback look` : null;
  return {
    scene: { ...base, ...(pre ? { pre } : {}), ...(speed !== 1 ? { speed } : {}), frame, eq: tagged(lookFilter(look, exposure, { hdrFallback: isHdr && hdr !== 'zscale' })) },
    inputOpts,
    fit,
    note
  };
}

// The plan of the cut. `shots`: the plan (checked by contract.checkShots); `format`: 16:9, 9:16 or 1:1; `files`: per shot the source it is cut from
// ({ path, width, height, fps, seconds, audio }, the size as shown; for a photo the still of stillArgs); options: { quality: standard | high,
// hdr: 'zscale' | 'fallback', batchScenes }. Returns { plan, files, fits, notes, summary }: run it with lib/music-video-render.js renderPlan(plan,
// { files, outputFile }).
function cutArgs(shots, format, files, { quality = 'standard', hdr = 'zscale', batchScenes } = {}) {
  const size = contract.FORMAT_SIZES[format];
  if (!size) throw cutError(contract.ERRORS.EVENTCUT_FAILED, `format: ${format} is not one of ${contract.FORMATS.join(', ')}`);
  const list = shots.shots;
  if (!Array.isArray(files) || files.length !== list.length) throw cutError(contract.ERRORS.EVENTCUT_FAILED, 'every shot needs its source');
  const scenes = [];
  const inputOpts = [];
  const fits = [];
  const notes = [];
  list.forEach((shot, index) => {
    const built = sceneOf(shot, index, files[index], { format, look: shots.look, hdr });
    scenes.push(built.scene);
    inputOpts.push(built.inputOpts);
    fits.push(built.fit);
    if (built.note) notes.push(built.note);
  });
  // the probe results the cut reads: the video of every input (a still is a picture too)
  const infos = files.map((file) => ({ video: { width: file.width, height: file.height }, duration: file.seconds || null }));
  const dissolve = list.some((shot, index) => index > 0 && shot.transition === 'dissolve');
  const plan = editLib.buildEditPlan({
    shots: { aspect_ratio: format, shots: scenes },
    order: list.map((_shot, index) => index),
    infos,
    params: { fps: FPS, resolution: '1080p', transition: dissolve ? 'crossfade' : 'cut', fade_out: 0 },
    inputOpts,
    noSong: true,
    // the filters of the scenes are built here, from the checked shots (never text of a person)
    sceneFilters: true,
    crf: QUALITY_CRF[quality] || QUALITY_CRF.standard,
    ...(batchScenes ? { batchScenes } : {})
  });
  if (plan.width !== size.width || plan.height !== size.height) throw cutError(contract.ERRORS.EVENTCUT_FAILED, `the cut is ${plan.width}x${plan.height}, the format needs ${size.width}x${size.height}`);
  return { plan, files: files.map((file) => file.path), fits, notes, summary: plan.summary };
}

/* ---------- the sound of the clips ---------- */

// The stem of the sound of the clips: every video and soundbite shot at normal speed whose clip has sound, at its time in the film, faded in and out
// over 40 ms, all of them mixed without a change of level, as long as the film (WAV, 48 kHz, stereo). `files` as for cutArgs. null when no shot has
// sound (a photo-only event: no stem).
function natArgs(shots, files, { outFile }) {
  const inputs = [];
  const lines = [];
  shots.shots.forEach((shot, index) => {
    const file = files[index];
    if (!(shot.kind === 'video' || shot.kind === 'soundbite') || !file || !file.audio) return;
    if (shot.kind === 'video' && Number.isFinite(shot.speed) && shot.speed !== 1) return;
    const seconds = shotSeconds(shot);
    const from = Number.isFinite(shot.from) ? Math.max(0, shot.from) : 0;
    const k = inputs.length;
    inputs.push(['-ss', num(from), '-t', num(seconds + 0.1), '-i', file.path]);
    const delay = Math.round(Math.round(shot.start * FPS) / FPS * 1000);
    lines.push(
      `[${k}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${num(seconds)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=${NAT_FADE_SEC},afade=t=out:st=${num(Math.max(0, seconds - NAT_FADE_SEC))}:d=${NAT_FADE_SEC},adelay=delays=${delay}:all=1[n${k}]`
    );
  });
  if (!inputs.length) return null;
  const labels = inputs.map((_input, k) => `[n${k}]`).join('');
  const mixed = inputs.length === 1 ? `${labels}anull` : `${labels}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0`;
  lines.push(`${mixed},apad=whole_dur=${num(shots.duration)},atrim=0:${num(shots.duration)}[nat]`);
  const args = ['-nostdin', '-v', 'error', '-y'];
  for (const input of inputs) args.push(...input);
  args.push('-filter_complex', lines.join(';'), '-map', '[nat]', '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2', outFile);
  return { args, count: inputs.length };
}

module.exports = {
  QUALITY_CRF,
  TONEMAP,
  TAGS,
  lookFilter,
  sourceOf,
  resolveSources,
  shotSeconds,
  jpegInfo,
  orientationFilters,
  stillArgs,
  sceneOf,
  cutArgs,
  natArgs,
  round3
};
