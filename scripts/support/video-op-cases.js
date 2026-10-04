'use strict';

// The ffmpeg arguments of the ops that were not changed by WP33b, as the builders write them for inputs WITHOUT alpha. The result of
// compute() was written to scripts/support/video-op-args-before-wp33b.json (key `more`) by the code of main (the day before WP33b);
// test-nodes-video-alpha.js computes it again with the code of the branch and compares: byte for byte the same arguments.
// The infos come from normaliseMediaProbe on a raw ffprobe output, as a real probe does (on the branch that adds `alpha: false`).

function compute(ops, ffmpeg) {
  const raw = (video, audio, duration) => ({
    streams: [
      ...(video ? [{ codec_type: 'video', codec_name: video.codec, width: video.width, height: video.height, avg_frame_rate: `${video.fps}/1`, pix_fmt: 'yuv420p' }] : []),
      ...(audio ? [{ codec_type: 'audio', codec_name: audio, sample_rate: '44100', channels: 2, channel_layout: 'stereo' }] : [])
    ],
    format: { duration: String(duration) }
  });
  const probe = (video, audio, duration) => ops.normaliseMediaProbe(raw(video, audio, duration));
  const clip = probe({ codec: 'h264', width: 160, height: 90, fps: 25 }, 'aac', 3);
  const clipMute = probe({ codec: 'h264', width: 160, height: 90, fps: 25 }, null, 2);
  const clipSmall = probe({ codec: 'h264', width: 80, height: 80, fps: 30 }, 'aac', 4);
  const still = probe({ codec: 'mjpeg', width: 320, height: 180, fps: 25 }, null, 0);
  const sound = probe(null, 'aac', 5);
  const argv = (spec, files, out) => ops.assembleArgs(spec, files, out);
  const out = ['/out.mp4'];
  const grid = (params, infos, options) => argv(ops.buildVideoGrid(params, infos, options), infos.map((_info, index) => `/in${index}.mp4`), out);
  const cases = {
    imageToVideoNone: () => argv(ops.buildImageToVideo({ fps: 30, zoom: 'none' }, [still], { duration: 4 }), ['/in.png'], out),
    imageToVideoZoomIn: () => argv(ops.buildImageToVideo({ fps: 25, zoom: 'in' }, [still], { duration: 3 }), ['/in.png'], out),
    imageToVideoPan: () => argv(ops.buildImageToVideo({ fps: 30, zoom: 'pan_left' }, [still], { duration: 2 }), ['/in.png'], out),
    imageToVideoAudio: () => argv(ops.buildImageToVideo({ fps: 30, zoom: 'out', match_audio: true }, [still, sound], { duration: 2 }), ['/in.png', '/a.m4a'], out),
    captions: () => argv(ops.buildCaptions({}, [clip], { assFile: '/tmp/c.ass', events: 3 }), ['/in.mp4'], out),
    captionsNone: () => argv(ops.buildCaptions({}, [clip], { assFile: '/tmp/c.ass', events: 0 }), ['/in.mp4'], out),
    soundwaveLine: () => argv(ops.buildSoundwave({ mode: 'line', position: 'bottom', height: 20, color: '#ffffff', opacity: 1 }, [clip]), ['/in.mp4'], out),
    soundwaveBarsExtraAudio: () => argv(ops.buildSoundwave({ mode: 'bars', position: 'top', height: 30, color: '#00ff00', opacity: 0.7 }, [clipMute, sound]), ['/in.mp4', '/a.m4a'], out),
    gridSideBySide: () => grid({ layout: 'side_by_side', audio: 'none' }, [clip, clipSmall]),
    gridFour: () => grid({ layout: 'grid', audio: 'first_video' }, [clip, clipSmall, clipMute, clip]),
    copyConcat: () => ffmpeg.copyConcatArgs('/tmp/list.txt', '/out.mp4'),
    reencodeConcat: () => ffmpeg.reencodeConcatArgs(['/a.mp4', '/b.mp4', '/c.mp4'], [clip, clipMute, clipSmall], '/out.mp4')
  };
  const result = {};
  for (const [name, run] of Object.entries(cases)) result[name] = run();
  return result;
}

module.exports = { compute };
