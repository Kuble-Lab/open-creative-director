'use strict';

// The cut of the event video (WP53, package C): lib/event-video/reframe.js, lib/event-video/cut.js, the optional fields of a scene in
// lib/music-video-edit.js and the node event_video.cut (lib/nodes/nodes-event-video-render.js runCut). No network, nothing paid, no footage of
// anybody: the clips are testsrc2 with a sine, the photos are drawn by ffmpeg.
//   reframe    the fit (D17: blur below 45 % of the area kept without a face, the fit of the plan wins), the crop expressions of the three formats with
//              the drift, the size of a still (at most twice the frame), the zoom and the pan of a photo
//   cut        the plan of shots-60.json: one scene and one input per shot, the look of spec §5c, the seek, the slow motion, the threads of 4K, HDR with
//              zscale or the fallback look, photos decoded once and repeated, a dissolve as the crossfade, the stem of the clip sound
//   edit       a scene without the optional fields is cut as before (the chain of the HUD), a film without a song has no sound
//   jpeg       the size and the EXIF orientation of a JPEG from its header
//   real       ffmpeg on this machine: the three formats, exact frames and size, a photo-only event (silent stem), an upright photo over its blurred copy

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const contract = require('../lib/event-video/contract');
const reframe = require('../lib/event-video/reframe');
const cutLib = require('../lib/event-video/cut');
const editLib = require('../lib/music-video-edit');
const renderLib = require('../lib/music-video-render');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const nodes = require('../lib/nodes/nodes-event-video-render');

const SUPPORT = path.join(__dirname, 'support', 'event-video');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SUPPORT, name), 'utf8'));
const shots60 = load('shots-60.json');

/* ---------- reframe ---------- */

function testReframe() {
  // the share a crop keeps
  assert.ok(Math.abs(reframe.cropShare(3024, 4032, '16:9') - 0.421875) < 1e-9, 'an upright 3:4 photo in 16:9 keeps 42 %');
  assert.equal(reframe.cropShare(1920, 1080, '16:9'), 1);
  assert.ok(Math.abs(reframe.cropShare(1920, 1080, '9:16') - 0.31640625) < 1e-9);
  assert.equal(reframe.cropShare(4032, 3024, '1:1'), 0.75);
  // D17: blur below 45 % without a face, else crop; the fit of the plan wins
  const plain = { kind: 'photo', anchor: { x: 0.5, y: 0.4 } };
  assert.equal(reframe.chooseFit(plain, 3024, 4032, '16:9').fit, 'blur');
  assert.equal(reframe.chooseFit(plain, 3024, 4032, '16:9').chosen, true);
  assert.equal(reframe.chooseFit(plain, 4032, 3024, '9:16').fit, 'blur', 'a wide photo in 9:16 keeps 42 %');
  assert.equal(reframe.chooseFit(plain, 4032, 3024, '1:1').fit, 'crop');
  assert.equal(reframe.chooseFit(plain, 5712, 4284, '16:9').fit, 'crop');
  assert.equal(reframe.chooseFit({ ...plain, anchor: { x: 0.5, y: 0.4, face: true } }, 1920, 1080, '9:16').fit, 'crop', 'a face holds the anchor');
  assert.equal(reframe.chooseFit({ ...plain, faces: 2 }, 1920, 1080, '9:16').fit, 'blur', 'only anchor.face (D18) says that there is a face');
  assert.equal(reframe.chooseFit({ kind: 'soundbite', anchor: { x: 0.4, y: 0.4 } }, 1920, 1080, '9:16').fit, 'crop', 'a soundbite has its speaker');
  assert.equal(reframe.chooseFit({ kind: 'soundbite', anchor: { x: 0.4, y: 0.4, face: false } }, 1920, 1080, '9:16').fit, 'blur');
  assert.equal(reframe.chooseFit({ ...plain, fit: 'crop' }, 3024, 4032, '16:9').fit, 'crop', 'the plan wins');
  assert.equal(reframe.chooseFit({ ...plain, fit: 'crop' }, 3024, 4032, '16:9').chosen, false);
  assert.equal(reframe.chooseFit({ ...plain, fit: 'blur' }, 1920, 1080, '16:9').fit, 'blur');

  // the crop expressions of the three formats: the window of the format, its middle on the anchor, held inside the picture
  const anchor = reframe.anchorOf({ anchor: { x: 0.42, y: 0.38 } });
  assert.equal(
    reframe.cropFilter({ format: '16:9', anchor, frames: 48 }),
    "crop=w='trunc(min(iw,ih*1.7778)/2)*2':h='trunc(min(ih,iw/1.7778)/2)*2':x='clip(0.42*iw-ow/2,0,iw-ow)':y='clip(0.38*ih-oh/2,0,ih-oh)'"
  );
  assert.equal(
    reframe.cropFilter({ format: '9:16', anchor, frames: 48 }),
    "crop=w='trunc(min(iw,ih*0.5625)/2)*2':h='trunc(min(ih,iw/0.5625)/2)*2':x='clip(0.42*iw-ow/2,0,iw-ow)':y='clip(0.38*ih-oh/2,0,ih-oh)'"
  );
  assert.equal(reframe.cropFilter({ format: '1:1', anchor, frames: 48 }), "crop=w='trunc(min(iw,ih*1)/2)*2':h='trunc(min(ih,iw/1)/2)*2':x='clip(0.42*iw-ow/2,0,iw-ow)':y='clip(0.38*ih-oh/2,0,ih-oh)'");
  // the drift: linear over the shot (49 frames: 2 s from the first to the last frame), at most 5 %
  const drifting = reframe.anchorOf({ anchor: { x: 0.5, y: 0.48, drift: [-0.02, 0.09] } });
  assert.deepEqual([drifting.dx, drifting.dy], [-0.02, 0.05], 'the drift is held at 5 %');
  assert.equal(
    reframe.cropFilter({ format: '9:16', anchor: drifting, frames: 49 }),
    "crop=w='trunc(min(iw,ih*0.5625)/2)*2':h='trunc(min(ih,iw/0.5625)/2)*2':x='clip((0.5+-0.02*min(1,t/2))*iw-ow/2,0,iw-ow)':y='clip((0.48+0.05*min(1,t/2))*ih-oh/2,0,ih-oh)'"
  );
  assert.equal(reframe.anchorOf({}).x, 0.5, 'photo_parallax may have no anchor: the centre');
  assert.match(reframe.cropFrame({ format: '9:16', anchor, frames: 48 }), /,scale=1080:1920:flags=lanczos$/);
  // D18: the start zoom of a detail makes the window smaller (clips and photos only, held to 1..2)
  assert.equal(
    reframe.cropFilter({ format: '16:9', anchor, frames: 48, zoom: 1.5 }),
    "crop=w='trunc(min(iw,ih*1.7778)/1.5/2)*2':h='trunc(min(ih,iw/1.7778)/1.5/2)*2':x='clip(0.42*iw-ow/2,0,iw-ow)':y='clip(0.38*ih-oh/2,0,ih-oh)'"
  );
  assert.deepEqual([{ kind: 'photo', zoom: 1.5 }, { kind: 'video', zoom: 3 }, { kind: 'soundbite', zoom: 1.5 }, { kind: 'photo' }].map(reframe.zoomOf), [1.5, 2, 1, 1]);
  const still = { width: 3840, height: 2160 };
  const detail = reframe.photoFilters({ shot: { kind: 'photo', zoom: 1.5, motion: { type: 'zoom_out', rate: 0.08 }, anchor: { x: 0.3, y: 0.4 } }, still, format: '16:9', fit: 'crop', tag: 3 });
  assert.match(detail.frame({ frames: 48 }), /^zoompan=z='1\.5\*\(1\.16-0\.16\*on\/47\)'/, 'the move of a detail starts from its zoom');
  const whole = reframe.photoFilters({ shot: { kind: 'photo', motion: { type: 'zoom_out', rate: 0.08 }, anchor: { x: 0.3, y: 0.4 } }, still, format: '16:9', fit: 'crop', tag: 3 });
  assert.match(whole.frame({ frames: 48 }), /^zoompan=z='1\.16-0\.16\*on\/47'/, 'without a zoom the expression of before');

  // the blurred copy: YUV filters only (no RGB filter that ffmpeg 6.1 shifts behind a split), a quarter of the size, the picture over it
  const blur = reframe.blurFrame({ format: '16:9', tag: 7 });
  assert.match(blur, /^split=2\[e7a\]\[e7b\];\[e7a\]scale=480:270:force_original_aspect_ratio=increase/);
  assert.match(blur, /gblur=sigma=10,eq=brightness=-0.09:contrast=0.92:saturation=0.8,scale=1920:1080:flags=bicubic\[e7bg\]/);
  assert.match(blur, /\[e7b\]scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos\[e7fg\];\[e7bg\]\[e7fg\]overlay=x=\(W-w\)\/2:y=\(H-h\)\/2:eval=init$/);
  assert.doesNotMatch(blur, /colorchannelmixer|lutrgb|colortemperature|gbrp|rgb24/);

  // a still is made small: at most twice the frame (a 24 MP photo in 16:9: the window of the format 3840 x 2160)
  assert.deepEqual(reframe.stillSize(5712, 4284, '16:9', 'crop'), { width: 3840, height: 2880 });
  assert.deepEqual(reframe.stillSize(4284, 5712, '16:9', 'blur'), { width: 1620, height: 2160 }, 'upright in 16:9: twice the place it is shown at (810 x 1080)');
  assert.deepEqual(reframe.stillSize(960, 1280, '16:9', 'blur'), { width: 960, height: 1280 }, 'never larger than it is');
  assert.deepEqual(reframe.stillSize(5712, 4284, '9:16', 'crop'), { width: 5120, height: 3840 });
  assert.deepEqual(reframe.shownSize(3024, 4032, '16:9', 'blur'), { width: 810, height: 1080 });

  // the motion of a photo: zoom towards the anchor, at most +25 %; a pan travels at a constant zoom
  const zoom = reframe.motionFilter({ motion: { type: 'zoom_in', rate: 0.084 }, frames: 49, size: { width: 1920, height: 1080 }, anchor: { x: 0.5, y: 0.45 } });
  assert.equal(zoom, "zoompan=z='1+0.1715*on/48':x='clip(0.5*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip(0.45*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s=1920x1080:fps=24");
  const long = reframe.motionFilter({ motion: { type: 'zoom_out', rate: 0.2 }, frames: 240, size: { width: 1080, height: 1080 }, anchor: { x: 0.5, y: 0.5 } });
  assert.match(long, /^zoompan=z='1.25-0.25\*on\/239'/, 'the whole move is capped at +25 %');
  assert.match(reframe.motionFilter({ motion: { type: 'pan_right', rate: 0.01 }, frames: 49, size: { width: 1920, height: 1080 }, anchor: { x: 0.5, y: 0.5 } }), /z='1.06':x='\(iw-iw\/zoom\)\*on\/48'/);
  assert.match(reframe.motionFilter({ motion: { type: 'pan_left', rate: 0.084 }, frames: 49, size: { width: 1920, height: 1080 }, anchor: { x: 0.5, y: 0.5 } }), /x='\(iw-iw\/zoom\)\*\(1-on\/48\)'/);

  // a photo: converted to BT.709 and cropped (or scaled) once, repeated in memory with exact times, the move for every frame; blur moves the picture
  const crop = reframe.photoFilters({ shot: { kind: 'photo', motion: { type: 'zoom_in', rate: 0.084 }, anchor: { x: 0.62, y: 0.6 } }, still: { width: 3840, height: 2880 }, format: '16:9', fit: 'crop', tag: 3 });
  assert.equal(crop.pre, 'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos,format=yuv420p,crop=3840:2160:0:648,scale=3840:2160:flags=lanczos,loop=loop=-1:size=1:start=0,settb=1/24,setpts=N,fps=24');
  // the anchor inside the window: x as it is (the window is the whole width), y in the middle of the window that was moved to it
  assert.match(crop.frame({ frames: 49 }), /^zoompan=z='1\+0.1715\*on\/48':x='clip\(0.62\*iw-iw\/zoom\/2,0,iw-iw\/zoom\)':y='clip\(0.5\*ih/);
  const blurred = reframe.photoFilters({ shot: { kind: 'photo', motion: { type: 'pan_right', rate: 0.084 }, anchor: { x: 0.5, y: 0.45 } }, still: { width: 1620, height: 2160 }, format: '16:9', fit: 'blur', tag: 5 });
  assert.match(blurred.pre, /split=2\[e5a\]\[e5b\];\[e5a\]scale=480:270.*,loop=loop=-1:size=1:start=0,settb=1\/24,setpts=N,fps=24\[e5bg\];\[e5b\]scale=1620:2160:flags=lanczos,loop=/);
  assert.match(blurred.frame({ frames: 49 }), /^zoompan=.*:s=810x1080:fps=24\[e5fg\];\[e5bg\]\[e5fg\]overlay=x=\(W-w\)\/2:y=\(H-h\)\/2:eval=init:shortest=1$/, 'the picture in front moves');
}

/* ---------- the plan of the cut ---------- */

const fakeFiles = (shots, sizes = {}) =>
  shots.shots.map((shot) => {
    if (shot.kind === 'photo') return { path: `/s/still-${shot.source}.png`, width: 3840, height: 2880, audio: false };
    if (shot.kind === 'photo_ai') return { path: `/s/ai-${shot.clip}.mp4`, width: 1366, height: 768, fps: 24, seconds: 5, audio: false };
    if (shot.kind === 'photo_parallax') return { path: `/s/par-${shot.clip}.mp4`, width: 1920, height: 1080, fps: 24, seconds: 5, audio: false };
    const size = sizes[shot.source] || [1920, 1080];
    return { path: `/s/v${shot.source}.mp4`, width: size[0], height: size[1], fps: 30, seconds: 120, audio: true };
  });

function testCutPlan() {
  // the look of spec §5c: contrast 0.9 + 0.4 c, saturation 0.7 + 0.7 s, gamma 1.05 - 0.1 c, brightness = exposure (held at 0.08)
  assert.equal(cutLib.lookFilter({ contrast: 0.55, saturation: 0.6 }, 0.04), 'eq=contrast=1.12:saturation=1.12:gamma=0.995:brightness=0.04');
  assert.equal(cutLib.lookFilter({ contrast: 1, saturation: 1 }, -0.3), 'eq=contrast=1.3:saturation=1.4:gamma=0.95:brightness=-0.08');
  assert.equal(cutLib.lookFilter({ contrast: 0.55, saturation: 0.6 }, 0, { hdrFallback: true }), 'eq=contrast=1.22:saturation=1.27:gamma=0.995:brightness=0', 'HDR without zscale: contrast +0.1, saturation +0.15');

  const files = fakeFiles(shots60, { 2: [1080, 1920], 6: [3840, 2160] });
  const cut = cutLib.cutArgs(shots60, '16:9', files, { hdr: 'zscale' });
  assert.equal(cut.plan.mode, 'batched');
  assert.equal(cut.plan.width, 1920);
  assert.equal(cut.plan.height, 1080);
  assert.equal(cut.plan.fps, 24);
  assert.equal(cut.plan.frames, 1440, '60 s at 24 fps');
  assert.equal(cut.files.length, shots60.shots.length, 'one input per shot');
  assert.deepEqual(cut.plan.outputs[0].maps, ['[v]'], 'no sound in the cut');
  assert.equal(cut.plan.outputs[0].noAudio, true);
  assert.deepEqual(cut.plan.final.inputOpts.length, 1, 'the encoder takes the frames only');
  assert.doesNotMatch(cut.plan.final.graph, /\[a\]/);
  // the fits: the plan's blur (s6), blur for the upright clip in 16:9, crop for the rest
  assert.equal(cut.fits[5], 'blur');
  assert.equal(cut.fits[4], 'blur', 'an upright clip (1080 x 1920) without a face in 16:9');
  assert.equal(cut.fits[0], 'crop');
  const graphs = cut.plan.batches.map((batch) => batch.graph).join(';');
  const opts = cut.plan.batches.flatMap((batch) => batch.inputOpts);
  // the seek of a clip, two decoder threads for 4K, the photo at 24 fps
  assert.deepEqual(cut.plan.batches[0].inputOpts[0], ['-threads', '1', '-ss', '4.82']);
  assert.ok(opts.some((opt) => opt.join(' ') === '-threads 2 -ss 6.88'), '4K footage gets two threads');
  assert.ok(opts.some((opt) => opt.join(' ') === '-threads 1 -framerate 24'), 'a still at the frame rate of the film');
  // slow motion (s14, 0.5), the look and the tags of every scene, HDR tone-mapped
  assert.match(graphs, /setpts=PTS-STARTPTS,setpts=2\*PTS,fps=24:round=near/);
  assert.equal((graphs.match(/setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv/g) || []).length, 25);
  assert.equal((graphs.match(/zscale=t=linear:npl=100/g) || []).length, 3, 'three HDR shots');
  assert.match(graphs, /eq=contrast=1.12:saturation=1.12:gamma=0.995:brightness=0.055,setparams/);
  // a still is decoded once and repeated, the move runs per frame
  assert.match(graphs, /loop=loop=-1:size=1:start=0,settb=1\/24,setpts=N,fps=24/);
  assert.match(graphs, /zoompan=z='1\+0.1715\*on\/48'/);
  // without zscale: the fallback look and a note
  const fallback = cutLib.cutArgs(shots60, '16:9', files, { hdr: 'fallback' });
  assert.equal(fallback.notes.length, 3);
  assert.doesNotMatch(fallback.plan.batches.map((batch) => batch.graph).join(';'), /zscale/);
  // quality high: CRF 16
  assert.equal(cutLib.cutArgs(shots60, '16:9', files, { quality: 'high' }).plan.final.outputs[0].args[3], '16');
  // the format: 9:16 crops the wide clips to upright windows
  const upright = cutLib.cutArgs(shots60, '9:16', files);
  assert.equal(upright.plan.width, 1080);
  assert.equal(upright.plan.height, 1920);
  // a wide clip without a face goes over its blurred copy, a soundbite (its speaker holds the anchor) is cropped to an upright window
  assert.equal(upright.fits[0], 'blur');
  assert.equal(upright.fits[8], 'crop');
  assert.match(upright.plan.batches.map((batch) => batch.graph).join(';'), /crop=w='trunc\(min\(iw,ih\*0.5625\)\/2\)\*2'/);
  const faced = structuredClone(shots60);
  faced.shots[0].anchor.face = true;
  assert.equal(cutLib.cutArgs(faced, '9:16', files).fits[0], 'crop', 'anchor.face of the planner');
  assert.equal(cutLib.cutArgs(shots60, '1:1', files).plan.height, 1080);
  assert.throws(() => cutLib.cutArgs(shots60, '4:3', files), (err) => err.code === 'EVENTCUT_FAILED');
  // a dissolve is the crossfade of the cut, the other shots come in hard
  const dissolve = structuredClone(shots60);
  dissolve.shots[3].transition = 'dissolve';
  const crossed = cutLib.cutArgs(dissolve, '16:9', files);
  assert.match(crossed.plan.batches.map((batch) => batch.graph).join(';'), /xfade=transition=fade:duration=0.25/);
  assert.match(crossed.plan.batches.map((batch) => batch.graph).join(';'), /xfade=transition=fade:duration=0.0417/);

  // the sources: a list that lacks one is EVENTCUT_SOURCE_MISSING
  const lists = { videos: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'], photos: ['p0', 'p1', 'p2', 'p3', 'p4'], ai_clips: ['a0', 'a1'], parallax_clips: ['x0', 'x1'] };
  assert.equal(cutLib.resolveSources(shots60, lists).length, 25);
  assert.equal(cutLib.resolveSources(shots60, lists)[1].item, 'a0');
  assert.throws(
    () => cutLib.resolveSources(shots60, { ...lists, parallax_clips: ['x0'] }),
    (err) => err.code === 'EVENTCUT_SOURCE_MISSING' && err.data.list === 'parallax_clips' && err.data.index === 1 && err.data.shot === 's24'
  );

  // the stem of the clips: video and soundbite shots at normal speed with sound, at their time
  const nat = cutLib.natArgs(shots60, files, { outFile: '/s/nat.wav' });
  assert.equal(nat.count, 18, '19 clip shots, the slow one is silent');
  const natGraph = nat.args[nat.args.indexOf('-filter_complex') + 1];
  assert.match(natGraph, /atrim=0:6.5417,.*adelay=delays=16375:all=1/, 'the soundbite s9 at its first frame (393: 16.375 s), its frames long');
  assert.match(natGraph, /amix=inputs=18:normalize=0:dropout_transition=0,apad=whole_dur=60,atrim=0:60\[nat\]$/);
  assert.equal(nat.args[nat.args.indexOf('-i') - 4], '-ss');
  // a photo-only event has no stem
  const photos = structuredClone(shots60);
  photos.shots = photos.shots.map((shot, index) => ({ id: shot.id, act: shot.act, start: shot.start, end: shot.end, kind: 'photo', source: index % 5, motion: { type: 'zoom_in', rate: 0.07 }, anchor: { x: 0.5, y: 0.5 }, transition: 'cut' }));
  assert.equal(contract.checkShots(photos).ok, true);
  assert.equal(cutLib.natArgs(photos, fakeFiles(photos), { outFile: '/s/nat.wav' }), null);
  const photoCut = cutLib.cutArgs(photos, '9:16', fakeFiles(photos));
  assert.equal(photoCut.plan.frames, 1440);
}

/* ---------- music-video-edit: the optional fields ---------- */

function testEdit() {
  // a scene without them is the chain of before (the HUD and the music video)
  const before = 'setpts=PTS-STARTPTS,fps=24:round=near,tpad=stop=48:stop_mode=clone,trim=end_frame=48,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,setsar=1,format=yuv420p';
  assert.equal(editLib.sceneChain({ kind: 'story', seconds: 5, frames: 48, fps: 24, width: 1920, height: 1080, fit: 'crop' }).chain, before);
  assert.equal(editLib.sceneChain({ kind: 'story', seconds: 5, frames: 48, fps: 24, width: 1920, height: 1080, fit: 'crop', speed: 0.5 }).chain.includes('setpts=2*PTS'), false, 'the speed of a scene is not for a story clip that is long enough');
  const own = editLib.sceneChain({ kind: 'event', seconds: 5, frames: 48, fps: 24, width: 1080, height: 1920, fit: 'crop', pre: 'PRE', speed: 0.75, frame: ({ frames }) => `FRAME${frames}`, eq: 'EQ' });
  assert.equal(own.chain, 'PRE,setpts=PTS-STARTPTS,setpts=1.3333*PTS,fps=24:round=near,tpad=stop=48:stop_mode=clone,trim=end_frame=48,setpts=PTS-STARTPTS,FRAME48,setsar=1,format=yuv420p,EQ');
  assert.equal(own.speed, 0.75);
  // the song of a music video is still there; inputOpts default to one thread
  const shots = { aspect_ratio: '16:9', shots: [{ kind: 'story', start: 0, end: 2 }, { kind: 'story', start: 2, end: 4 }] };
  const infos = [{ audio: {}, duration: 10 }, { video: { width: 640, height: 360 }, duration: 5 }, { video: { width: 640, height: 360 }, duration: 5 }];
  const plan = editLib.buildEditPlan({ shots, order: [1, 2], infos, params: { fps: 24, resolution: '720p' } });
  assert.deepEqual(plan.spec.inputOpts, [['-threads', '1'], ['-threads', '1'], ['-threads', '1']]);
  assert.deepEqual(plan.spec.outputs[0].maps, ['[v]', '[a]']);
  assert.equal(plan.spec.outputs[0].args[3], '19');
  const silent = editLib.buildEditPlan({ shots, order: [0, 1], infos: infos.slice(1), params: { fps: 24, resolution: '720p' }, noSong: true, inputOpts: [['-ss', '3'], null], crf: 16 });
  assert.deepEqual(silent.spec.inputOpts, [['-ss', '3'], ['-threads', '1']]);
  assert.deepEqual(silent.spec.outputs[0].maps, ['[v]']);
  assert.equal(silent.spec.outputs[0].noAudio, true);
  assert.equal(silent.spec.outputs[0].args[3], '16');
  assert.doesNotMatch(silent.spec.graph, /atrim|\[a\]/);
}

/* ---------- the header of a JPEG ---------- */

function jpegWith(orientation, width, height) {
  // SOI, APP1 with a little-endian TIFF block holding the orientation, SOF0 with the size
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), Buffer.from('Exif\0\0', 'ascii'), tiff]);
  app1.writeUInt16BE(app1.length - 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]);
}

function testJpeg() {
  assert.deepEqual(cutLib.jpegInfo(jpegWith(6, 5712, 4284)), { width: 4284, height: 5712, stored: { width: 5712, height: 4284 }, orientation: 6 });
  assert.deepEqual(cutLib.jpegInfo(jpegWith(1, 4032, 3024)).width, 4032);
  assert.equal(cutLib.jpegInfo(Buffer.from('not a jpeg')), null);
  assert.equal(cutLib.jpegInfo(jpegWith(3, 100, 50).subarray(0, 30)), null, 'a header cut short');
  assert.deepEqual(cutLib.orientationFilters(6), ['transpose=clock']);
  assert.deepEqual(cutLib.orientationFilters(8), ['transpose=cclock']);
  assert.deepEqual(cutLib.orientationFilters(1), []);
  const still = cutLib.stillArgs({ inputFile: 'in.jpg', outFile: 'out.png', orientation: 6, format: '16:9', fit: 'blur', width: 4284, height: 5712 });
  assert.deepEqual(still.size, { width: 1620, height: 2160 });
  assert.deepEqual(still.args.slice(4, 9), ['-noautorotate', '-i', 'in.jpg', '-vf', 'transpose=clock,scale=1620:2160:flags=lanczos,format=rgb24']);
}

/* ---------- with ffmpeg ---------- */

async function testReal() {
  const binaries = ffmpeg.binaries();
  assert.ok(binaries.available, 'ffmpeg is needed');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'event-cut-'));
  const ff = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
  const probe = (file) => ops.probeMedia(file, { ffprobePath: binaries.ffprobe });
  try {
    const clip = async (name, size, rate, freq) => {
      const file = path.join(work, name);
      await ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${rate}:d=12`, '-f', 'lavfi', '-i', `sine=f=${freq}:d=12`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
      return file;
    };
    const wide = await clip('wide.mp4', '640x360', 30, 440);
    const tall = await clip('tall.mp4', '360x640', 25, 660);
    const photo = path.join(work, 'photo.jpg');
    await ff(['-f', 'lavfi', '-i', 'testsrc=s=600x800', '-frames:v', '1', '-q:v', '3', photo]);
    // 20 s: a wide clip, a soundbite, the upright clip, the upright photo (blur in 16:9), slow motion
    const plan = {
      version: 1,
      fps: 24,
      duration: 20,
      look: { contrast: 0.55, saturation: 0.6 },
      shots: [
        { id: 's1', act: 'hook', start: 0, end: 3, kind: 'video', source: 0, from: 1, speed: 1, anchor: { x: 0.5, y: 0.5, drift: [0.03, 0] }, transition: 'cut' },
        { id: 's2', act: 'arrival', start: 3, end: 6.5, kind: 'photo', source: 0, motion: { type: 'zoom_in', rate: 0.08 }, anchor: { x: 0.5, y: 0.4 }, transition: 'cut' },
        { id: 's3', act: 'programme', start: 6.5, end: 9.5, kind: 'soundbite', source: 0, from: 4, to: 7, anchor: { x: 0.4, y: 0.4 }, transition: 'cut' },
        { id: 's4', act: 'people', start: 9.5, end: 14, kind: 'video', source: 1, from: 2, speed: 0.75, anchor: { x: 0.5, y: 0.4 }, transition: 'dissolve' },
        { id: 's5', act: 'peak', start: 14, end: 17.5, kind: 'video', source: 1, from: 5, speed: 1, anchor: { x: 0.5, y: 0.4 }, transition: 'cut', exposure: 0.05 },
        { id: 's6', act: 'close', start: 17.5, end: 20, kind: 'photo', source: 0, motion: { type: 'pan_left', rate: 0.08 }, anchor: { x: 0.5, y: 0.5 }, transition: 'cut', fit: 'crop' }
      ]
    };
    assert.equal(contract.checkShots(plan).ok, true, contract.checkShots(plan).problems.join(' | '));
    const lists = { videos: [wide, tall], photos: [photo], ai_clips: [], parallax_clips: [] };
    const sources = cutLib.resolveSources(plan, lists).map((source) => ({ ...source, path: source.item }));
    const run = (args) => ff(args.slice(4));
    const renderPlan = (built, { files, outputFile }) => renderLib.renderPlan(built, { files, outputFile, ffmpegPath: binaries.ffmpeg });
    for (const format of contract.FORMATS) {
      const scratch = await fsp.mkdtemp(path.join(work, 'f-'));
      const started = Date.now();
      const result = await nodes.runCut({ shots: plan, format, sources, scratch, hdr: 'fallback', run, probe, renderPlan });
      const info = await probe(result.video);
      const size = contract.FORMAT_SIZES[format];
      assert.equal(info.video.width, size.width, format);
      assert.equal(info.video.height, size.height, format);
      assert.equal(info.audio, null, `${format}: the cut has no sound`);
      assert.ok(Math.abs(info.duration - 20) < 0.01, `${format}: ${info.duration} s`);
      const nat = await probe(result.nat);
      assert.ok(Math.abs(nat.duration - 20) < 0.02, `${format}: the stem is as long as the film`);
      assert.equal(result.natCount, 3, 'two clips and the soundbite have sound, the slow one is silent');
      if (format === '16:9') assert.deepEqual(result.fits, ['crop', 'blur', 'crop', 'blur', 'blur', 'crop']);
      if (format === '9:16') assert.deepEqual(result.fits, ['blur', 'crop', 'crop', 'crop', 'crop', 'crop']);
      console.log(`  cut ${format}: ${((Date.now() - started) / 1000).toFixed(1)} s for 20 s of film`);
    }
    // the frames: exactly the film's
    const scratch = await fsp.mkdtemp(path.join(work, 'n-'));
    const counted = await nodes.runCut({ shots: plan, format: '16:9', sources, scratch, hdr: 'fallback', run, probe, renderPlan });
    const frames = await new Promise((resolve, reject) =>
      execFile(binaries.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', counted.video], (err, out) => (err ? reject(err) : resolve(Number(out))))
    );
    assert.equal(frames, 480);
    // the upright photo over its blurred copy: the sides are not black (s2 at 4 s, the left eighth)
    const raw = path.join(work, 'side.gray');
    await ff(['-ss', '4', '-i', counted.video, '-frames:v', '1', '-vf', 'crop=240:1080:0:0,scale=1:1:flags=area,format=gray', '-f', 'rawvideo', raw]);
    assert.ok((await fsp.readFile(raw))[0] > 20, 'the blurred copy fills the side');

    // a photo-only event: the stem is silent
    const photoOnly = structuredClone(plan);
    photoOnly.shots = photoOnly.shots.map(({ id, act, start, end, transition }, index) => ({ id, act, start, end, transition: index === 0 ? 'cut' : transition, kind: 'photo', source: 0, motion: { type: index % 2 ? 'zoom_out' : 'pan_right', rate: 0.06 }, anchor: { x: 0.5, y: 0.5 } }));
    const only = await nodes.runCut({ shots: photoOnly, format: '9:16', sources: cutLib.resolveSources(photoOnly, lists).map((source) => ({ ...source, path: source.item })), scratch: await fsp.mkdtemp(path.join(work, 'p-')), hdr: 'fallback', run, probe, renderPlan });
    assert.equal(only.natCount, 0);
    assert.equal(only.stills, 1, 'one photo, one fit: made small once');
    const silence = await new Promise((resolve) => execFile(binaries.ffmpeg, ['-nostdin', '-i', only.nat, '-af', 'volumedetect', '-f', 'null', '-'], (_err, _out, stderr) => resolve(stderr)));
    assert.match(silence, /max_volume: -9[01](\.\d)? dB/, 'silence');
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  testReframe();
  testCutPlan();
  testEdit();
  testJpeg();
  await testReal();
  console.log('test-event-video-cut.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
