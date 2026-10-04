'use strict';

// The node "Overlay video on video" (video.overlay_video, WP33b): the filter graph (pure) and runs on clips made with lavfi.
// What is covered:
//   - the definition: ports, parameters and their defaults, the checks before a run, the output (MP4)
//   - the graph: position, scale, opacity, start and end, loop, length, sound, the key
//   - runs: a half transparent red over blue gives the mixed colour at the right place and leaves the rest as it was, for x, y, unit,
//     anchor, scale, opacity, start, end, loop_layer, every length and every audio value, and the chroma key; the length of the result
//     and its sound (checked with volumedetect in windows of time) are the ones asked for
//
// Clips are small (a 128x128 background, a 64x64 layer, 5 to 10 frames per second) because VP9 with alpha is slow to encode. The part
// that needs libvpx-vp9 prints SKIP when the ffmpeg has none. Local and free: no network, no provider.

const assert = require('assert/strict');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const { createRegistry } = require('../lib/nodes/registry');
const { createEditHarness, execFileAsync } = require('./support/edit-harness');

const probeOf = (width, height, { audio = { codec: 'aac' }, duration = 2, alpha = false } = {}) => ({
  video: { codec: alpha ? 'vp9' : 'h264', width, height, fps: 10, alpha },
  audio,
  duration
});

const DEFAULTS = { x: 50, y: 50, unit: 'percent', anchor: 'center', scale: 100, opacity: 1, start: 0, end: 0, loop_layer: false, length: 'background', audio: 'background', key: 'none', key_color: '#00ff00', key_similarity: 0.3, key_blend: 0.1 };

/* ---------- the definition and the graph ---------- */

function testGraph() {
  const registry = createRegistry();
  edit.registerAll(registry);
  const node = registry.get('video.overlay_video');
  assert.ok(node, 'the node is registered');
  assert.equal(node.category, 'edit-video');
  assert.equal(node.paid, false);
  assert.equal(node.cost.unit, 'local');
  assert.deepEqual(node.inputs.map((port) => [port.id, port.type, Boolean(port.required)]), [['background', 'video', true], ['layer', 'video', true]]);
  assert.deepEqual(node.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
  assert.deepEqual(registry.paramDefaults(node), DEFAULTS);
  assert.deepEqual(registry.checkParams(node, DEFAULTS), []);
  assert.ok(node.keywords.length >= 5, 'search words');
  assert.deepEqual(ops.OVERLAY_LENGTHS, ['background', 'layer', 'shortest']);
  assert.deepEqual(ops.OVERLAY_AUDIO, ['background', 'layer', 'mix', 'none']);
  assert.deepEqual(ops.OVERLAY_KEYS, ['none', 'chroma']);
  for (const [param, value] of [['length', 'longest'], ['audio', 'first'], ['key', 'luma'], ['unit', 'em']]) {
    assert.ok(registry.checkParams(node, { ...DEFAULTS, [param]: value }).length > 0, `${param}=${value} is refused`);
  }
  // numbers outside their range are brought into it
  const clamped = registry.normalizeParams(node, { scale: 0, opacity: 2, key_similarity: 5 });
  assert.deepEqual([clamped.scale, clamped.opacity, clamped.key_similarity], [1, 1, 1]);
  // the key parameters are only shown for the chroma key
  const shown = (id) => node.params.find((param) => param.id === id).showIf;
  for (const id of ['key_color', 'key_similarity', 'key_blend']) assert.deepEqual(shown(id), { param: 'key', equals: 'chroma' });

  // checks before a run
  const issues = (raw) => node.validate(registry.normalizeParams(node, raw), {}) || [];
  assert.deepEqual(issues({}), []);
  assert.match(issues({ start: 3, end: 2 })[0], /end must be greater than start/);
  assert.match(issues({ start: 2, end: 2 })[0], /end must be greater than start/);
  assert.deepEqual(issues({ start: 1, end: 0 }), []);
  assert.match(issues({ key: 'chroma', key_color: 'green' })[0], /hex colour/);
  assert.deepEqual(issues({ key: 'none', key_color: 'green' }), [], 'the key colour is only checked when it is used');

  const bg = probeOf(128, 128);
  const layer = probeOf(64, 64, { alpha: true, audio: { codec: 'opus' }, duration: 1 });
  const build = (raw, infos = [bg, layer]) => ops.buildOverlayVideo({ ...DEFAULTS, ...raw }, infos);

  // the default: centred, the sound of the background, the length of the background
  const base = build({ scale: 50 });
  assert.equal(base.graph, "[1:v]format=yuva420p,setpts=PTS-STARTPTS+0/TB[ov];[0:v][ov]overlay=x=W*0.5-w/2:y=H*0.5-h/2:eof_action=repeat:enable='lt(t,1)':format=auto[out];[0:a]apad[ab]");
  assert.deepEqual(base.outputs, [{ kind: 'video', maps: ['[out]', '[ab]'], args: ['-t', '2'] }]);
  assert.deepEqual(base.inputOpts, [[], []]);
  assert.deepEqual(base.notes, []);
  assert.equal(base.outputs[0].alpha, undefined, 'the result is a film on a background: MP4');

  // position: px or %, top left or centre
  assert.match(build({ x: 10, y: 20, unit: 'px', anchor: 'top-left' }).graph, /overlay=x=10:y=20:/);
  assert.match(build({ x: 25, y: 75, unit: 'percent', anchor: 'top-left' }).graph, /overlay=x=W\*0\.25:y=H\*0\.75:/);
  assert.match(build({ x: 10, y: 20, unit: 'px', anchor: 'center' }).graph, /overlay=x=10-w\/2:y=20-h\/2:/);
  // scale: a share of the width of the background, the layer keeps its ratio, even sizes
  assert.match(build({ scale: 25 }).graph, /\[1:v\]scale=32:32:flags=lanczos,format=yuva420p,/);
  assert.match(build({ scale: 100 }).graph, /\[1:v\]scale=128:128:flags=lanczos,format=yuva420p,/);
  assert.match(build({ scale: 50 }, [bg, probeOf(100, 50, { alpha: true, duration: 1 })]).graph, /\[1:v\]scale=64:32:flags=lanczos,/, 'a wide layer');
  assert.match(build({ scale: 33 }, [bg, probeOf(100, 50, { alpha: true, duration: 1 })]).graph, /scale=42:22:/, 'even sizes');
  assert.ok(!build({ scale: 50 }).graph.includes('scale='), 'the layer has that size already: no scaling');
  assert.match(build({ scale: 50 }, [probeOf(1920, 1080), probeOf(400, 400, { alpha: true, duration: 1 })]).graph, /scale=960:960:/, 'in % of the width of the background, whatever the layer measures');
  // opacity
  assert.match(build({ scale: 50, opacity: 0.5 }).graph, /format=yuva420p,colorchannelmixer=aa=0\.5,setpts=/);
  assert.ok(!base.graph.includes('colorchannelmixer'));
  // start: the layer is shifted; end: it is hidden from there on
  assert.match(build({ start: 1.5 }).graph, /setpts=PTS-STARTPTS\+1\.5\/TB\[ov\]/);
  assert.match(build({ start: 1.5 }).graph, /eof_action=repeat:format=auto\[out\]/, 'no end, and the layer outlasts the background: nothing takes it away');
  assert.match(build({ start: 0.5 }).graph, /:enable='lt\(t,1\.5\)':/, 'no end: the layer is taken away where its own run is over');
  assert.match(build({}, [bg, probeOf(64, 64, { alpha: true, duration: 3 })]).graph, /eof_action=repeat:format=auto\[out\]/, 'a longer layer needs no enable');
  assert.match(build({ start: 0.5, end: 0.9 }).graph, /overlay=[^;]*:enable='between\(t,0\.5,0\.9\)':format=auto/);
  assert.match(build({ start: 0.5, end: 5 }).graph, /:enable='lt\(t,1\.5\)':format=auto/, 'an `end` beyond the end of the layer: the layer ends first');
  assert.throws(() => build({ start: 2, end: 1 }), /end must be greater than start/);
  assert.throws(() => build({ start: 1, end: 1 }), /end must be greater than start/);
  // loop: the input is looped, the layer never ends by itself, so the end of the background ends the result
  const looped = build({ loop_layer: true });
  assert.deepEqual(looped.inputOpts, [[], ['-stream_loop', '-1']]);
  assert.match(looped.graph, /eof_action=repeat:shortest=1:format=auto/);
  assert.ok(!looped.graph.includes('enable='), 'a looped layer is not taken away');
  assert.ok(!base.graph.includes('shortest'));
  // the key: colour, similarity and blend before anything else is done to the layer
  const keyed = build({ key: 'chroma', key_color: '#00FF00', key_similarity: 0.4, key_blend: 0.2, scale: 25 }, [bg, probeOf(64, 64, { audio: null, duration: 1 })]);
  assert.match(keyed.graph, /\[1:v\]format=rgba,colorkey=0x00ff00:0\.4:0\.2,scale=32:32:flags=lanczos,format=yuva420p,/);
  assert.match(build({ key: 'chroma', key_similarity: 5, key_blend: -1 }).graph, /colorkey=0x00ff00:1:0,/, 'clamped');
  assert.ok(!build({ key: 'none', key_color: '#ff0000' }).graph.includes('colorkey'), 'no key: no colorkey');
  assert.throws(() => build({ key: 'chroma', key_color: 'green' }), /Invalid colour/);

  // length: the arguments -t and the held last frame of the background
  const time = (raw, infos) => build(raw, infos).outputs[0].args[1];
  assert.equal(time({}), '2', 'background');
  assert.equal(time({ length: 'background' }, [bg, probeOf(64, 64, { alpha: true, duration: 3 })]), '2', 'a longer layer is cut where the background ends');
  assert.equal(time({ length: 'layer' }), '1', 'layer: start + its length');
  assert.equal(time({ length: 'layer', start: 1.5 }), '2.5');
  assert.equal(time({ length: 'layer', start: 0.2, end: 1.2 }), '1.2', 'or where `end` hides it, when that comes first');
  assert.equal(time({ length: 'layer', start: 0.2, end: 5 }), '1.2', 'an `end` beyond its own end does not extend it');
  assert.equal(time({ length: 'layer', loop_layer: true }), '2', 'a looped layer has no end of its own: the length of the background');
  assert.equal(time({ length: 'layer', loop_layer: true, start: 0.5, end: 1.5 }), '1.5', 'unless `end` ends it');
  assert.equal(time({ length: 'shortest' }), '1');
  assert.equal(time({ length: 'shortest', start: 0.5 }), '1.5');
  assert.equal(time({ length: 'shortest', start: 1.5 }), '2', 'the background is the shorter one');
  assert.equal(time({ length: 'shortest', loop_layer: true }), '2');
  assert.match(build({ length: 'layer', start: 1.5 }).graph, /\[0:v\]tpad=stop_mode=clone:stop_duration=0\.5\[bgh\];\[bgh\]\[ov\]overlay=/, 'a shorter background holds its last frame');
  assert.ok(!build({ length: 'layer' }).graph.includes('tpad'), 'a longer background is cut, not held');
  assert.ok(!build({}).graph.includes('tpad'));
  assert.ok(build({ length: 'layer', start: 1.5 }).graph.includes('[0:a]apad[ab]'), 'its sound is padded with silence');
  assert.throws(() => build({}, [probeOf(128, 128, { duration: 0 }), layer]), /length of the background/);
  assert.throws(() => build({}, [bg, probeOf(64, 64, { duration: 0 })]), /length of the layer/);
  assert.doesNotThrow(() => build({ loop_layer: true }, [bg, probeOf(64, 64, { duration: 0 })]), 'a looped layer needs no length');
  assert.throws(() => build({ length: 'longest' }), /Unknown length/);
  assert.throws(() => build({ audio: 'first' }), /Unknown audio mode/);
  assert.throws(() => build({ key: 'luma' }), /Unknown key/);
  assert.throws(() => build({ scale: 0 }), /scale must be greater/);
  assert.throws(() => build({}, [{ video: null, audio: null, duration: 2 }, layer]), /background has no image/);
  assert.throws(() => build({}, [bg, { video: null, audio: null, duration: 1 }]), /layer has no image/);

  // sound
  const audio = (raw, infos) => build(raw, infos);
  assert.deepEqual(audio({ audio: 'background' }).outputs[0].maps, ['[out]', '[ab]']);
  const fromLayer = audio({ audio: 'layer', start: 0.5 });
  assert.match(fromLayer.graph, /\[1:a\]adelay=500:all=1,apad\[al\]/, 'delayed by the start');
  assert.deepEqual(fromLayer.outputs[0].maps, ['[out]', '[al]']);
  assert.ok(!fromLayer.graph.includes('[0:a]'), 'the background sound is not used');
  assert.match(audio({ audio: 'layer' }).graph, /\[1:a\]apad\[al\]/, 'no delay without a start');
  assert.match(audio({ audio: 'layer', start: 0.5, end: 1.2 }).graph, /\[1:a\]atrim=duration=0\.7,asetpts=PTS-STARTPTS,adelay=500:all=1,apad\[al\]/, 'the layer sound ends with the layer');
  const mixed = audio({ audio: 'mix', start: 0.5 });
  assert.match(mixed.graph, /\[0:a\]apad\[ab\];\[1:a\]adelay=500:all=1,apad\[al\];\[ab\]\[al\]amix=inputs=2:duration=longest:dropout_transition=0\[aout\]/);
  assert.deepEqual(mixed.outputs[0].maps, ['[out]', '[aout]']);
  const none = audio({ audio: 'none' });
  assert.deepEqual(none.outputs[0].maps, ['[out]']);
  assert.equal(none.outputs[0].noAudio, true);
  assert.ok(!none.graph.includes('apad'));
  // a track that is not there is left out, with a note
  const mute = probeOf(128, 128, { audio: null });
  const mutedLayer = probeOf(64, 64, { alpha: true, audio: null, duration: 1 });
  assert.deepEqual(build({ audio: 'background' }, [mute, layer]).outputs[0].maps, ['[out]']);
  assert.deepEqual(build({ audio: 'background' }, [mute, layer]).notes, ['The background video has no sound']);
  assert.deepEqual(build({ audio: 'layer' }, [bg, mutedLayer]).outputs[0].maps, ['[out]']);
  assert.deepEqual(build({ audio: 'layer' }, [bg, mutedLayer]).notes, ['The layer has no sound']);
  const mixOnlyBackground = build({ audio: 'mix' }, [bg, mutedLayer]);
  assert.deepEqual(mixOnlyBackground.outputs[0].maps, ['[out]', '[ab]'], 'a mix of one track is that track');
  assert.deepEqual(mixOnlyBackground.notes, ['The layer has no sound']);
  assert.deepEqual(build({ audio: 'mix' }, [mute, layer]).outputs[0].maps, ['[out]', '[al]']);
  assert.deepEqual(build({ audio: 'none' }, [mute, mutedLayer]).notes, [], 'asking for no sound is not a problem');

  // the whole argument list: the layer is looped before its own -i, the cut by -t before the file
  const args = ops.assembleArgs(looped, ['/bg.mp4', '/layer.webm'], ['/out.mp4']);
  assert.deepEqual(args.slice(0, 10), ['-nostdin', '-v', 'error', '-y', '-i', '/bg.mp4', '-stream_loop', '-1', '-i', '/layer.webm']);
  assert.equal(args[args.length - 3], '-t');
  assert.equal(args[args.length - 2], '2');
  assert.equal(args[args.length - 1], '/out.mp4');
  assert.ok(args.includes('libx264') && args.includes('aac'), 'MP4');
}

/* ---------- runs ---------- */

const isMixed = (r, g, b) => Math.abs(r - 128) <= 18 && g <= 18 && Math.abs(b - 127) <= 18;
const isBlue = (r, g, b) => r <= 18 && g <= 18 && b >= 232;
const isGreen = (r, g, b) => r <= 40 && g >= 210 && b <= 40;
const isRed = (r, g, b) => r >= 210 && g <= 40 && b <= 40;

async function testRuns() {
  const h = await createEditHarness({ prefix: 'ocd-overlay-' });
  try {
    const VP9 = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4'];
    const BG = 128;
    // background: blue, 2 s, 10 fps, 440 Hz all the time (AAC)
    await h.ff(['-f', 'lavfi', '-i', `color=c=0x0000ff:s=${BG}x${BG}:r=10:d=2`, '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', h.src('bg.mp4')]);
    await h.ff(['-f', 'lavfi', '-i', `color=c=0x0000ff:s=${BG}x${BG}:r=10:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.src('bg-mute.mp4')]);
    // layers: half transparent red; 1 s with 880 Hz in Opus (silent where it is not), 1 s without sound, 3 s without sound
    await h.ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=5:d=1,format=yuva420p', '-f', 'lavfi', '-i', 'sine=f=880:d=1', ...VP9, '-c:a', 'libopus', h.src('layer-sound.webm')]);
    await h.ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=5:d=1,format=yuva420p', ...VP9, h.src('layer.webm')]);
    await h.ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=5:d=3,format=yuva420p', ...VP9, h.src('layer-long.webm')]);
    // a layer on a green background, no alpha: a red square in the middle
    await h.ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=64x64:r=5:d=1,drawbox=x=16:y=16:w=32:h=32:color=0xff0000:t=fill,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.src('green.mp4')]);
    const bg = await h.upload('bg.mp4', '.mp4');
    const bgMute = await h.upload('bg-mute.mp4', '.mp4');
    const layerSound = await h.upload('layer-sound.webm', '.webm');
    const layer = await h.upload('layer.webm', '.webm');
    const layerLong = await h.upload('layer-long.webm', '.webm');
    const green = await h.upload('green.mp4', '.mp4');

    const ranWith = async (inputs, raw = {}) => {
      const logs = [];
      const ctx = { ...h.makeCtx(), log: (line) => logs.push(line) };
      const definition = h.def('video.overlay_video');
      const result = await definition.execute(ctx, inputs, h.registry.normalizeParams(definition, raw));
      const value = result.variants[0].video;
      const file = await h.fileOf(value);
      return { value, file, logs, probe: await h.probe(file) };
    };
    const pixel = (frame, x, y) => {
      const at = (y * BG + x) * 3;
      return [frame[at], frame[at + 1], frame[at + 2]];
    };
    // `checks`: [x, y, test, what] at time t
    const look = async (file, t, checks) => {
      const frame = await h.frame(file, t, BG, BG);
      for (const [x, y, test, what] of checks) {
        const rgb = pixel(frame, x, y);
        assert.ok(test(...rgb), `t=${t} (${x}, ${y}): ${what}, got rgb(${rgb.join(', ')})`);
      }
    };
    // the loudest sample (dB) of a window of time; -Infinity where there is nothing
    const loudness = async (file, from, to) => {
      const { stderr } = await execFileAsync(ffmpeg.binaries().ffmpeg, ['-nostdin', '-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
      const match = /max_volume:\s*(-?[0-9.]+|-inf)\s*dB/.exec(stderr);
      return match && match[1] !== '-inf' ? Number(match[1]) : -Infinity;
    };
    // the lavfi tone is at -18 dB; a mix of two tracks halves each (-24 dB), silence is far below -50
    const loud = (db) => db > -35;
    const quiet = (db) => db < -50;
    const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not near ${expected}`);

    /* --- position, scale, opacity --- */
    {
      // centred, half of the width: the layer covers x 32..95, y 32..95
      const run = await ranWith({ background: bg, layer }, { scale: 50 });
      assert.equal(run.value.type, 'video');
      assert.match(run.file, /\.mp4$/, 'MP4');
      assert.equal(run.value.alpha, undefined);
      assert.deepEqual(run.logs, []);
      await look(run.file, 0.5, [
        [64, 64, isMixed, 'the mixed colour in the middle'],
        [40, 40, isMixed, 'inside, near the corner'],
        [88, 88, isMixed, 'inside, near the other corner'],
        [20, 20, isBlue, 'outside, top left'],
        [110, 64, isBlue, 'outside, right'],
        [64, 20, isBlue, 'outside, above'],
        [64, 110, isBlue, 'outside, below'],
        [28, 64, isBlue, 'just outside on the left'],
        [100, 100, isBlue, 'outside, bottom right']
      ]);
      assert.deepEqual([run.probe.width, run.probe.height], [BG, BG], 'the size of the background');
    }
    {
      // pixels, from the top left corner: the layer covers x 10..73, y 20..83
      const run = await ranWith({ background: bg, layer }, { x: 10, y: 20, unit: 'px', anchor: 'top-left', scale: 50 });
      await look(run.file, 0.5, [
        [40, 50, isMixed, 'inside'], [12, 22, isMixed, 'inside, near the corner'], [70, 80, isMixed, 'inside, near the other corner'],
        [5, 5, isBlue, 'outside, top left'], [78, 50, isBlue, 'outside, right'], [40, 90, isBlue, 'outside, below'], [100, 100, isBlue, 'far outside'], [6, 50, isBlue, 'left of it']
      ]);
    }
    {
      // pixels, centre on the point (100, 40): x 68..131, y 8..71
      const run = await ranWith({ background: bg, layer }, { x: 100, y: 40, unit: 'px', anchor: 'center', scale: 50 });
      await look(run.file, 0.5, [[100, 40, isMixed, 'on the point'], [70, 10, isMixed, 'inside'], [30, 40, isBlue, 'outside, left'], [100, 100, isBlue, 'outside, below']]);
    }
    {
      // percent from the top left: 25 % of 128 = 32: x 32..95
      const run = await ranWith({ background: bg, layer }, { x: 25, y: 25, unit: 'percent', anchor: 'top-left', scale: 50 });
      await look(run.file, 0.5, [[48, 48, isMixed, 'inside'], [92, 92, isMixed, 'inside, near the corner'], [20, 20, isBlue, 'outside'], [100, 100, isBlue, 'outside']]);
    }
    {
      // percent, centre on (75 %, 25 %) = (96, 32): x 64..127, y 0..63
      const run = await ranWith({ background: bg, layer }, { x: 75, y: 25, unit: 'percent', anchor: 'center', scale: 50 });
      await look(run.file, 0.5, [[100, 30, isMixed, 'inside'], [66, 2, isMixed, 'inside, near the corner'], [30, 100, isBlue, 'outside'], [30, 30, isBlue, 'outside']]);
    }
    {
      // scale 25 % of the width: 32 px, centred: x 48..79
      const run = await ranWith({ background: bg, layer }, { scale: 25 });
      await look(run.file, 0.5, [[64, 64, isMixed, 'inside'], [52, 52, isMixed, 'inside, near the corner'], [40, 64, isBlue, 'outside, left'], [88, 64, isBlue, 'outside, right'], [64, 40, isBlue, 'above']]);
    }
    {
      // scale 100 % (the default): the layer is as wide as the background and covers everything
      const run = await ranWith({ background: bg, layer }, {});
      await look(run.file, 0.5, [[3, 3, isMixed, 'the corner'], [64, 64, isMixed, 'the middle'], [124, 124, isMixed, 'the other corner']]);
      const big = await ranWith({ background: bg, layer }, { scale: 200 });
      await look(big.file, 0.5, [[3, 3, isMixed, 'larger than the picture: still everywhere'], [124, 124, isMixed, 'everywhere']]);
    }
    {
      // opacity 0.5: red at 0.25 over blue
      const run = await ranWith({ background: bg, layer }, { scale: 50, opacity: 0.5 });
      await look(run.file, 0.5, [
        [64, 64, (r, g, b) => Math.abs(r - 64) <= 18 && g <= 18 && Math.abs(b - 191) <= 18, 'a quarter of red'],
        [20, 20, isBlue, 'outside']
      ]);
      const none = await ranWith({ background: bg, layer }, { scale: 50, opacity: 0 });
      await look(none.file, 0.5, [[64, 64, isBlue, 'opacity 0: nothing to see']]);
    }

    /* --- start, end, the end of the layer, loop --- */
    {
      // the layer is shown from 0.5 s on and hidden from 0.9 s on
      const run = await ranWith({ background: bg, layer }, { scale: 50, start: 0.5, end: 0.9 });
      await look(run.file, 0.3, [[64, 64, isBlue, 'not yet']]);
      await look(run.file, 0.7, [[64, 64, isMixed, 'between start and end'], [20, 20, isBlue, 'outside the layer']]);
      await look(run.file, 1.2, [[64, 64, isBlue, 'after the end']]);
      near(run.probe.duration, 2, 0.2, 'the background decides');
    }
    {
      // only a start: the layer appears at 1.0 s and plays its second, which ends with the background
      const run = await ranWith({ background: bg, layer }, { scale: 50, start: 1 });
      await look(run.file, 0.5, [[64, 64, isBlue, 'before the start']]);
      await look(run.file, 1.5, [[64, 64, isMixed, 'playing']]);
      await look(run.file, 1.9, [[64, 64, isMixed, 'still playing at the end']]);
    }
    {
      // the layer is a second long: it is gone afterwards, the background goes on
      const run = await ranWith({ background: bg, layer }, { scale: 50 });
      await look(run.file, 0.5, [[64, 64, isMixed, 'playing']]);
      await look(run.file, 1.5, [[64, 64, isBlue, 'over after its second']]);
      near(run.probe.duration, 2, 0.2, 'but the film goes on');
    }
    {
      const run = await ranWith({ background: bg, layer }, { scale: 50, loop_layer: true });
      await look(run.file, 0.5, [[64, 64, isMixed, 'first round']]);
      await look(run.file, 1.5, [[64, 64, isMixed, 'second round']]);
      await look(run.file, 1.9, [[64, 64, isMixed, 'second round, at the end']]);
      near(run.probe.duration, 2, 0.2, 'a looped layer does not make the result endless');
      // loop with a start and an end
      const timed = await ranWith({ background: bg, layer }, { scale: 50, loop_layer: true, start: 0.4, end: 1.7 });
      await look(timed.file, 0.2, [[64, 64, isBlue, 'before the start']]);
      await look(timed.file, 1.2, [[64, 64, isMixed, 'in the second round']]);
      await look(timed.file, 1.85, [[64, 64, isBlue, 'after the end']]);
    }

    /* --- length --- */
    {
      const long = await ranWith({ background: bg, layer: layerLong }, { scale: 50, length: 'background' });
      near(long.probe.duration, 2, 0.2, 'a longer layer is cut where the background ends');
      await look(long.file, 1.9, [[64, 64, isMixed, 'the layer is still there']]);
      const short = await ranWith({ background: bg, layer }, { scale: 50, length: 'background' });
      near(short.probe.duration, 2, 0.2, 'a shorter layer: the length of the background');
    }
    {
      // layer: the film ends with the layer
      const run = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer' });
      near(run.probe.duration, 1, 0.25, 'the background is cut at the end of the layer');
      await look(run.file, 0.5, [[64, 64, isMixed, 'the layer']]);
      // ... a layer that lasts longer than the background: the background holds its last frame
      const late = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer', start: 1.5 });
      near(late.probe.duration, 2.5, 0.25, 'start 1.5 s + the layer of 1 s');
      near(late.probe.videoDuration, 2.5, 0.25, 'the picture is that long too');
      await look(late.file, 1.0, [[64, 64, isBlue, 'before the layer']]);
      await look(late.file, 2.3, [[64, 64, isMixed, 'the layer, after the end of the background'], [20, 20, isBlue, 'the held frame of the background around it']]);
      // `end` hides the layer sooner, and the result ends with it
      const early = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer', start: 0.2, end: 0.9 });
      near(early.probe.duration, 0.9, 0.25, 'until the layer is hidden');
      // a looped layer has no end of its own: the length of the background
      const looped = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer', loop_layer: true });
      near(looped.probe.duration, 2, 0.2, 'a looped layer: the background decides');
      const loopedEnd = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer', loop_layer: true, end: 1.4 });
      near(loopedEnd.probe.duration, 1.4, 0.25, 'a looped layer that `end` stops');
    }
    {
      const short = await ranWith({ background: bg, layer }, { scale: 50, length: 'shortest' });
      near(short.probe.duration, 1, 0.25, 'the layer is shorter');
      const long = await ranWith({ background: bg, layer: layerLong }, { scale: 50, length: 'shortest' });
      near(long.probe.duration, 2, 0.2, 'the background is shorter');
      const late = await ranWith({ background: bg, layer }, { scale: 50, length: 'shortest', start: 0.5 });
      near(late.probe.duration, 1.5, 0.25, 'start + the layer');
      const loopedShortest = await ranWith({ background: bg, layer }, { scale: 50, length: 'shortest', loop_layer: true });
      near(loopedShortest.probe.duration, 2, 0.2, 'a looped layer is never the shorter one');
    }

    /* --- sound: the background has 440 Hz for 2 s, the layer 880 Hz for 1 s --- */
    {
      // background (the default): the sound of the background, the whole length
      const run = await ranWith({ background: bg, layer: layerSound }, { scale: 50 });
      assert.equal(run.probe.audioCodec, 'aac');
      near(run.probe.audioDuration, 2, 0.2, 'as long as the film');
      assert.ok(loud(await loudness(run.file, 0.05, 0.4)), 'loud from the start');
      assert.ok(loud(await loudness(run.file, 1.4, 1.9)), 'loud at the end: the sound of the background, not the layer');
      assert.deepEqual(run.logs, []);
    }
    {
      // layer: only the layer, delayed by the start; silence before and after
      const run = await ranWith({ background: bg, layer: layerSound }, { scale: 50, audio: 'layer', start: 0.5 });
      assert.equal(run.probe.audioCodec, 'aac');
      near(run.probe.audioDuration, 2, 0.2, 'as long as the film (silence padded)');
      assert.ok(quiet(await loudness(run.file, 0.05, 0.4)), 'silent before the layer');
      assert.ok(loud(await loudness(run.file, 0.7, 1.3)), 'the layer sound while it plays');
      assert.ok(quiet(await loudness(run.file, 1.7, 1.95)), 'silent after it');
      // `end` cuts the sound of the layer too
      const cut = await ranWith({ background: bg, layer: layerSound }, { scale: 50, audio: 'layer', start: 0, end: 0.4 });
      assert.ok(loud(await loudness(cut.file, 0.05, 0.3)), 'the sound while the layer is shown');
      assert.ok(quiet(await loudness(cut.file, 0.55, 0.95)), 'cut where the layer is hidden');
    }
    {
      // mix: both
      const run = await ranWith({ background: bg, layer: layerSound }, { scale: 50, audio: 'mix', start: 0.5 });
      assert.equal(run.probe.audioCodec, 'aac');
      near(run.probe.audioDuration, 2, 0.2, 'as long as the film');
      assert.ok(loud(await loudness(run.file, 0.05, 0.4)), 'the background alone');
      assert.ok(loud(await loudness(run.file, 0.7, 1.3)), 'both');
      assert.ok(loud(await loudness(run.file, 1.7, 1.95)), 'the background alone again');
      // the mix is louder than the background alone where both play: a tone of another pitch is added
      const alone = await loudness((await ranWith({ background: bg, layer: layerSound }, { scale: 50, audio: 'background' })).file, 0.7, 1.3);
      const both = await loudness(run.file, 0.7, 1.3);
      assert.ok(Math.abs(both - alone) < 8, `the mix keeps a level in the range of the sources (${both} dB against ${alone} dB)`);
    }
    {
      // none: no audio stream
      const run = await ranWith({ background: bg, layer: layerSound }, { scale: 50, audio: 'none' });
      assert.equal(run.probe.hasAudio, false);
      assert.deepEqual(run.logs, []);
      near(run.probe.duration, 2, 0.2, 'the picture');
    }
    {
      // the sound of the background goes on in silence after its end when the layer makes the film longer
      const run = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer', start: 1.5 });
      near(run.probe.audioDuration, 2.5, 0.25, 'the sound is padded to the length of the film');
      assert.ok(loud(await loudness(run.file, 1.0, 1.9)), 'the background sound');
      assert.ok(quiet(await loudness(run.file, 2.2, 2.45)), 'silence after it');
      // and cut where the film ends when the layer ends first
      const short = await ranWith({ background: bg, layer }, { scale: 50, length: 'layer' });
      near(short.probe.audioDuration, 1, 0.25, 'cut with the film');
    }
    {
      // tracks that are not there: no stream, and a line in the log
      const noLayerSound = await ranWith({ background: bg, layer }, { scale: 50, audio: 'layer' });
      assert.equal(noLayerSound.probe.hasAudio, false);
      assert.deepEqual(noLayerSound.logs, ['The layer has no sound']);
      const noBgSound = await ranWith({ background: bgMute, layer: layerSound }, { scale: 50, audio: 'background' });
      assert.equal(noBgSound.probe.hasAudio, false);
      assert.deepEqual(noBgSound.logs, ['The background video has no sound']);
      const mixOne = await ranWith({ background: bg, layer }, { scale: 50, audio: 'mix' });
      assert.equal(mixOne.probe.hasAudio, true, 'a mix of the one track that exists');
      assert.ok(loud(await loudness(mixOne.file, 0.05, 0.9)));
      assert.deepEqual(mixOne.logs, ['The layer has no sound']);
      const mixLayerOnly = await ranWith({ background: bgMute, layer: layerSound }, { scale: 50, audio: 'mix', start: 0.2 });
      assert.equal(mixLayerOnly.probe.hasAudio, true);
      assert.ok(loud(await loudness(mixLayerOnly.file, 0.4, 1.0)));
      const nothing = await ranWith({ background: bgMute, layer }, { scale: 50, audio: 'none' });
      assert.equal(nothing.probe.hasAudio, false);
      assert.deepEqual(nothing.logs, []);
    }

    /* --- the key: a layer with a colour background and no alpha --- */
    {
      // scale 50: the layer sits on x 32..95; its green border is 16 px wide, the red square is in x 48..79
      const plain = await ranWith({ background: bg, layer: green }, { scale: 50 });
      await look(plain.file, 0.5, [[40, 40, isGreen, 'without a key the green stays'], [64, 64, isRed, 'the red square'], [20, 20, isBlue, 'outside']]);
      const keyed = await ranWith({ background: bg, layer: green }, { scale: 50, key: 'chroma' });
      await look(keyed.file, 0.5, [[40, 40, isBlue, 'the green is gone: the background shows'], [90, 90, isBlue, 'in the other corner too'], [64, 64, isRed, 'the red square stays'], [20, 20, isBlue, 'outside']]);
      // another key colour: the red goes, the green stays
      const red = await ranWith({ background: bg, layer: green }, { scale: 50, key: 'chroma', key_color: '#ff0000' });
      await look(red.file, 0.5, [[40, 40, isGreen, 'the green stays'], [64, 64, isBlue, 'the red is keyed out']]);
      // opacity works on the keyed layer
      const half = await ranWith({ background: bg, layer: green }, { scale: 50, key: 'chroma', opacity: 0.5 });
      await look(half.file, 0.5, [[40, 40, isBlue, 'still gone'], [64, 64, (r, g, b) => Math.abs(r - 128) <= 22 && g <= 22 && Math.abs(b - 127) <= 22, 'the red square at half']]);
      // key with the colour in # or without, in capitals
      const capitals = await ranWith({ background: bg, layer: green }, { scale: 50, key: 'chroma', key_color: '#00FF00', key_similarity: 0.2, key_blend: 0 });
      await look(capitals.file, 0.5, [[40, 40, isBlue, 'capitals']]);
    }

    /* --- a layer with alpha that is keyed too, and a layer that is another size and ratio --- */
    {
      // a wide layer: 128x64 scaled to 50 % of the width (64) is 64x32
      await h.ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=128x64:r=5:d=1,format=yuva420p', ...VP9, h.src('wide.webm')]);
      const wide = await h.upload('wide.webm', '.webm');
      const run = await ranWith({ background: bg, layer: wide }, { scale: 50 });
      // centred: x 32..95, y 48..79
      await look(run.file, 0.5, [[64, 64, isMixed, 'inside'], [40, 52, isMixed, 'inside, near the corner'], [64, 40, isBlue, 'above'], [64, 90, isBlue, 'below'], [20, 64, isBlue, 'left']]);
    }

    /* --- the same layer twice over (a layer is read once per run, nothing is left behind) --- */
    {
      const first = await ranWith({ background: bg, layer }, { scale: 50 });
      const second = await ranWith({ background: bg, layer }, { scale: 50 });
      assert.notEqual(first.value.assetId, second.value.assetId);
      assert.equal(first.probe.width, second.probe.width);
    }

    /* --- errors --- */
    await assert.rejects(ranWith({ background: bg, layer }, { start: 2, end: 1 }), /end must be greater than start/);
    // a layer that is not a video at all
    await assert.rejects(ranWith({ background: bg, layer: await (async () => { await h.ff(['-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:a', 'pcm_s16le', h.src('tone.wav')]); return h.upload('tone.wav', '.wav'); })() }, {}), /layer has no image|no video or audio|has no image/);
  } finally {
    await h.cleanup();
  }
}

async function main() {
  testGraph();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the filter graph was tested)');
  } else if (!(ffmpeg.hasEncoder('libvpx-vp9') && ffmpeg.hasDecoder('libvpx-vp9') && ffmpeg.hasEncoder('libopus'))) {
    console.log('SKIP the ffmpeg has no libvpx-vp9 (encoder and decoder) or libopus: the runs with a layer with alpha were not tested');
  } else {
    await testRuns();
  }
  console.log('test-nodes-video-overlay.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
