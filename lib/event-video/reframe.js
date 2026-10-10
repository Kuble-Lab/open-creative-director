'use strict';

// The picture of one shot of the event video brought to the format of the film (WP53, spec §7 "Reframe", D6, D17): pure builders of ffmpeg filters,
// nothing here touches the disk. lib/event-video/cut.js puts them into the optional fields `pre` and `frame` of a scene of lib/music-video-edit.js.
//
//   fit crop   the largest window of the format inside the picture, its middle on the anchor, moved linearly by the drift over the shot (at most
//              5 % of the width and of the height), held inside the picture; the crop comes before the scale (spec §7)
//   fit blur   the whole picture, scaled to the height (or the width) of the frame, over a copy of itself that fills the frame, blurred and darkened
//              (D17). Only filters that work on YUV (scale, gblur, eq, overlay): on the server ffmpeg 6.1 shifts the colours of RGB filters behind a
//              split or a trim (spec, decisions), so nothing here goes through RGB. The blur is made on a quarter of the size and scaled up (cheap
//              on 2 cores)
//   photos     a still (the photo made small once, lib/event-video/cut.js stillArgs) is converted to BT.709 once, cropped (crop) or scaled (blur) once
//              and repeated in memory (loop): only the zoom or the pan (zoompan) runs for every frame, on at most twice the size of the frame
//
// chooseFit(): without a fit in the plan the cut chooses blur where a crop would keep less than BLUR_BELOW of the area of the picture and no face
// holds the anchor (D17), else crop.

const contract = require('./contract');
const ops = require('../nodes/ffmpeg-ops');

const num = ops.num;
const BLUR_BELOW = 0.45;
// the blurred copy: made on a quarter of the size, blurred, darkened and a little paler (eq works on YUV)
const BLUR = Object.freeze({ divisor: 4, sigma: 10, brightness: -0.09, contrast: 0.92, saturation: 0.8 });
// photos are scaled to at most this many times the size they are shown at, before zoompan (spec: memory and time on 2 cores with 3 GB)
const STILL_SCALE = 2;
// the whole move of a photo (zoom or pan) is capped at +25 % (spec §5c); a pan needs some room to travel
const MAX_MOVE = contract.MAX_PHOTO_RATE;
const MIN_PAN = 0.06;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const sizeOf = (format) => {
  const size = contract.FORMAT_SIZES[format];
  if (!size) throw new Error(`Unknown format ${format}`);
  return size;
};

// The share of the area of a picture of `width` x `height` that a crop to `format` keeps (1 when the shapes are the same).
function cropShare(width, height, format) {
  const { width: w, height: h } = sizeOf(format);
  const source = width / height;
  const target = w / h;
  return Math.min(source / target, target / source);
}

// Does a face hold the anchor of the shot? The contract has no field for it (D17 asks it): the planner may add anchor.face (true or false) or faces
// (a count) to a shot, which the checks of the contract let through. Without them a soundbite has its speaker, any other shot no face.
function hasFace(shot) {
  if (!shot) return false;
  if (shot.anchor && typeof shot.anchor.face === 'boolean') return shot.anchor.face;
  if (Number.isFinite(shot.faces)) return shot.faces > 0;
  return shot.kind === 'soundbite';
}

// The fit of a shot: the one of the plan, else blur where a crop keeps less than BLUR_BELOW and no face holds the anchor (D17). Returns
// { fit, chosen, share }: `chosen` when the cut chose it.
function chooseFit(shot, width, height, format) {
  const share = width > 0 && height > 0 ? cropShare(width, height, format) : 1;
  if (contract.SHOT_FITS.includes(shot.fit)) return { fit: shot.fit, chosen: false, share };
  return { fit: share < BLUR_BELOW - 1e-9 && !hasFace(shot) ? 'blur' : 'crop', chosen: true, share };
}

// The anchor of a shot (D6): x, y of the picture as shown, 0..1, the centre by default; drift [dx, dy] at most MAX_DRIFT each way.
function anchorOf(shot) {
  const anchor = (shot && shot.anchor) || {};
  const x = Number.isFinite(anchor.x) ? clamp(anchor.x, 0, 1) : 0.5;
  const y = Number.isFinite(anchor.y) ? clamp(anchor.y, 0, 1) : 0.5;
  const drift = Array.isArray(anchor.drift) ? anchor.drift : [0, 0];
  const d = (value) => (Number.isFinite(value) ? clamp(value, -contract.MAX_DRIFT, contract.MAX_DRIFT) : 0);
  return { x, y, dx: d(drift[0]), dy: d(drift[1]) };
}

// The crop of a moving picture (video, AI clip, parallax clip) to `format` around the anchor, with the drift over `frames` frames: the size of the
// window from the picture (iw, ih: it works whatever size the decoder gives), its place by the time of the frame (t, the scene starts at 0).
function cropFilter({ format, anchor, frames, fps = contract.FPS }) {
  const { width, height } = sizeOf(format);
  const aspect = width / height;
  const span = Math.max(1, frames - 1) / fps;
  const at = (base, drift, size, out) =>
    drift ? `clip((${num(base)}+${num(drift)}*min(1,t/${num(span)}))*${size}-${out}/2,0,${size}-${out})` : `clip(${num(base)}*${size}-${out}/2,0,${size}-${out})`;
  const w = `trunc(min(iw,ih*${num(aspect)})/2)*2`;
  const h = `trunc(min(ih,iw/${num(aspect)})/2)*2`;
  return `crop=w='${w}':h='${h}':x='${at(anchor.x, anchor.dx, 'iw', 'ow')}':y='${at(anchor.y, anchor.dy, 'ih', 'oh')}'`;
}

// The crop of a moving picture, scaled to the frame: the whole `frame` of a scene with fit crop.
function cropFrame({ format, anchor, frames, fps }) {
  const { width, height } = sizeOf(format);
  return `${cropFilter({ format, anchor, frames, fps })},scale=${width}:${height}:flags=lanczos`;
}

// The blurred copy that fills the frame, from the stream `input` to the label `output` (a text of the graph).
function blurBackground(input, output, format) {
  const { width, height } = sizeOf(format);
  const small = { w: even(width / BLUR.divisor), h: even(height / BLUR.divisor) };
  return (
    `[${input}]scale=${small.w}:${small.h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${small.w}:${small.h},` +
    `gblur=sigma=${BLUR.sigma},eq=brightness=${BLUR.brightness}:contrast=${BLUR.contrast}:saturation=${BLUR.saturation},` +
    `scale=${width}:${height}:flags=bicubic[${output}]`
  );
}

// The whole moving picture over its blurred copy (fit blur): the `frame` of a scene. `tag` makes the labels unique in the film (the index of the scene).
function blurFrame({ format, tag }) {
  const { width, height } = sizeOf(format);
  const l = (name) => `e${tag}${name}`;
  return [
    `split=2[${l('a')}][${l('b')}]`,
    blurBackground(l('a'), l('bg'), format),
    `[${l('b')}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[${l('fg')}]`,
    `[${l('bg')}][${l('fg')}]overlay=x=(W-w)/2:y=(H-h)/2:eval=init`
  ].join(';');
}

/* ---------- photos ---------- */

// The size a photo is shown at: the window of the format inside it (crop) or the whole photo inside the frame (blur), in pixels of the frame.
function shownSize(width, height, format, fit) {
  const { width: w, height: h } = sizeOf(format);
  if (fit === 'blur') {
    const scale = Math.min(w / width, h / height);
    return { width: even(width * scale), height: even(height * scale) };
  }
  return { width: w, height: h };
}

// The scale of a still (cut.js stillArgs): the photo of `width` x `height` (as shown) to at most STILL_SCALE times the size it is shown at, never larger
// than it is. Returns { width, height } (even).
function stillSize(width, height, format, fit) {
  const { width: w, height: h } = sizeOf(format);
  // crop: the window of the format must be STILL_SCALE times the frame; blur: the whole photo STILL_SCALE times its place in the frame
  const factor = fit === 'blur' ? Math.min((STILL_SCALE * w) / width, (STILL_SCALE * h) / height) : Math.max((STILL_SCALE * w) / width, (STILL_SCALE * h) / height);
  const scale = Math.min(1, factor);
  return { width: even(width * scale), height: even(height * scale) };
}

// The window of the format around the anchor inside a still of `width` x `height`: { x, y, w, h } in pixels.
function cropWindow(width, height, format, anchor) {
  const { width: fw, height: fh } = sizeOf(format);
  const aspect = fw / fh;
  const w = even(Math.min(width, height * aspect));
  const h = even(Math.min(height, width / aspect));
  const x = Math.round(clamp(anchor.x * width - w / 2, 0, width - w));
  const y = Math.round(clamp(anchor.y * height - h / 2, 0, height - h));
  return { x, y, w: Math.min(w, width), h: Math.min(h, height) };
}

// The zoom or the pan of a photo: zoompan from a picture of STILL_SCALE times the output size to `size`, over `frames` frames. `rate` is per second;
// the whole move is capped at MAX_MOVE. `anchor` (0..1 of the picture that zoompan sees) is where a zoom points.
function motionFilter({ motion, frames, fps = contract.FPS, size, anchor }) {
  const last = Math.max(1, frames - 1);
  const rate = Number.isFinite(motion && motion.rate) ? motion.rate : 0.07;
  const move = clamp((rate * frames) / fps, 0, MAX_MOVE);
  const type = contract.PHOTO_MOTIONS.includes(motion && motion.type) ? motion.type : 'zoom_in';
  const progress = `on/${last}`;
  let z;
  let x;
  const y = `clip(${num(anchor.y)}*ih-ih/zoom/2,0,ih-ih/zoom)`;
  if (type === 'zoom_in' || type === 'zoom_out') {
    z = type === 'zoom_in' ? `1+${num(move)}*${progress}` : `${num(1 + move)}-${num(move)}*${progress}`;
    x = `clip(${num(anchor.x)}*iw-iw/zoom/2,0,iw-iw/zoom)`;
  } else {
    z = num(1 + Math.max(move, MIN_PAN));
    x = type === 'pan_right' ? `(iw-iw/zoom)*${progress}` : `(iw-iw/zoom)*(1-${progress})`;
  }
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${size.width}x${size.height}:fps=${fps}`;
}

// The filters of a photo shot (kind photo): `pre` (the still converted to BT.709, cropped or scaled once, repeated in memory) and `frame` (a function
// of the frames of the scene: the zoompan, and for blur the overlay on the blurred copy). `still` is the size of the still (stillArgs), `tag` the
// index of the scene (unique labels).
function photoFilters({ shot, still, format, fit, tag, fps = contract.FPS }) {
  const { width, height } = sizeOf(format);
  const anchor = anchorOf(shot);
  const toYuv = 'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos,format=yuv420p';
  // a time base of one frame and the frame rate of the film: the repeated still has exact times (a still comes with the 25 fps of the image
  // demuxer, and the overlay of a blurred photo takes the frame rate of its first input: the raw frames of a batch are counted at that rate)
  const repeat = `loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,fps=${fps}`;
  const l = (name) => `e${tag}${name}`;
  if (fit === 'blur') {
    const shown = shownSize(still.width, still.height, format, 'blur');
    const work = { width: even(Math.min(still.width, shown.width * STILL_SCALE)), height: even(Math.min(still.height, shown.height * STILL_SCALE)) };
    const pre = [
      `${toYuv},split=2[${l('a')}][${l('b')}]`,
      `${blurBackground(l('a'), l('c'), format).replace(`[${l('c')}]`, `,${repeat}[${l('bg')}]`)}`,
      `[${l('b')}]scale=${work.width}:${work.height}:flags=lanczos,${repeat}`
    ].join(';');
    const frame = ({ frames }) =>
      `${motionFilter({ motion: shot.motion, frames, fps, size: shown, anchor })}[${l('fg')}];[${l('bg')}][${l('fg')}]overlay=x=(W-w)/2:y=(H-h)/2:eval=init:shortest=1`;
    return { pre, frame, shown };
  }
  const window = cropWindow(still.width, still.height, format, anchor);
  const work = { width: even(Math.min(STILL_SCALE * width, Math.max(width, window.w))), height: even(Math.min(STILL_SCALE * height, Math.max(height, window.h))) };
  // where the anchor lies in the window (the window is held inside the photo, so the anchor is not always its middle)
  const inner = { x: clamp((anchor.x * still.width - window.x) / window.w, 0, 1), y: clamp((anchor.y * still.height - window.y) / window.h, 0, 1) };
  const pre = `${toYuv},crop=${window.w}:${window.h}:${window.x}:${window.y},scale=${work.width}:${work.height}:flags=lanczos,${repeat}`;
  const frame = ({ frames }) => motionFilter({ motion: shot.motion, frames, fps, size: { width, height }, anchor: inner });
  return { pre, frame, shown: { width, height }, window };
}

module.exports = {
  BLUR_BELOW,
  BLUR,
  STILL_SCALE,
  MAX_MOVE,
  cropShare,
  hasFace,
  chooseFit,
  anchorOf,
  cropFilter,
  cropFrame,
  blurBackground,
  blurFrame,
  shownSize,
  stillSize,
  cropWindow,
  motionFilter,
  photoFilters
};
