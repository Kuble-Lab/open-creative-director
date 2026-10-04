'use strict';

// The ffmpeg arguments of video.overlay_video as the builder writes them for backgrounds with EVEN sides. The result of compute() was written
// to scripts/support/video-overlay-args-before-wp33c.json by the code of the day before WP33c (which pads a background with an odd side);
// test-nodes-video-overlay.js computes it again with the code of the branch and compares: byte for byte the same arguments.

function compute(ops) {
  const probe = (width, height, { audio = { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' }, duration = 2, alpha = false } = {}) => ({
    video: { codec: alpha ? 'vp9' : 'h264', width, height, fps: 10, alpha },
    audio,
    duration
  });
  const base = { x: 50, y: 50, unit: 'percent', anchor: 'center', scale: 100, opacity: 1, start: 0, end: 0, loop_layer: false, length: 'background', audio: 'background', key: 'none', key_color: '#00ff00', key_similarity: 0.3, key_blend: 0.1 };
  const run = (params, infos, files = ['/bg.mp4', '/layer.webm']) => ops.assembleArgs(ops.buildOverlayVideo({ ...base, ...params }, infos), files, ['/out.mp4']);
  const layer = probe(64, 64, { alpha: true, duration: 1 });
  const cases = {
    plain: () => run({}, [probe(128, 128), layer]),
    scaledAt: () => run({ x: 10, y: 20, unit: 'pixel', anchor: 'top-left', scale: 40, opacity: 0.6, start: 0.5, end: 1.5 }, [probe(1920, 1080, { duration: 4 }), layer]),
    looped: () => run({ loop_layer: true, length: 'layer', end: 3 }, [probe(1280, 720, { duration: 5 }), probe(64, 64, { alpha: true, duration: 0 })]),
    held: () => run({ length: 'layer', start: 1 }, [probe(640, 360, { duration: 1 }), probe(64, 64, { alpha: true, duration: 3 })]),
    mixKeyed: () => run({ audio: 'mix', key: 'chroma', key_similarity: 0.4, scale: 25, start: 0.5 }, [probe(854, 480, { duration: 3 }), probe(64, 64, { audio: { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' }, duration: 1 })]),
    noSound: () => run({ audio: 'none' }, [probe(128, 128, { audio: null }), layer])
  };
  const result = {};
  for (const [name, build] of Object.entries(cases)) result[name] = build();
  return result;
}

module.exports = { compute };
